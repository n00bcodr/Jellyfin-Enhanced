import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, deferred, jsonResponse, plain } from '../helpers/harness.mjs';

const flush = () => new Promise(resolve => setImmediate(resolve));
function setup(t, options = {}) {
    const h = createHarness(options); t.after(() => h.close());
    for (const file of ['navigation', 'session', 'api-client']) h.load(`core/${file}.js`);
    h.api = h.JE.core.api; h.manager = h.api.manager;
    Object.assign(h.manager.CONFIG.retry, { baseDelayMs: 0, jitterFactor: 0 });
    return h;
}
function transport() {
    const calls = [];
    return { calls, fetch(url, options) { const pending = deferred(); calls.push({ url, options, ...pending }); return pending.promise; } };
}
function finish(call, data = {}) { call.resolve(jsonResponse(data)); }

test('API and legacy alias share one manager, including repeated installation', t => {
    const h = setup(t), original = h.api;
    h.load('jellyseerr/request-manager.js'); h.load('core/api-client.js');
    assert.equal(h.JE.core.api, original); assert.equal(h.JE.requestManager, h.manager);
});

test('dedup subscribers cancel independently and an already-aborted joiner sends nothing', async t => {
    const wire = transport(), h = setup(t, wire), a = new h.window.AbortController(), b = new h.window.AbortController();
    const first = h.api.fetch('/shared', { signal: a.signal });
    const second = h.api.fetch('/shared', { signal: b.signal });
    assert.equal(wire.calls.length, 1);
    const rejected = assert.rejects(first, { name: 'AbortError' }); a.abort(); await rejected;
    assert.equal(wire.calls[0].options.signal.aborted, false);
    await assert.rejects(h.api.fetch('/shared', { signal: a.signal }), { name: 'AbortError' });
    finish(wire.calls[0], { ok: true }); assert.equal((await second).ok, true);
});

test('last subscriber departure aborts transport and synchronous replacement never joins it', async t => {
    const wire = transport(), h = setup(t, wire), ctl = new h.window.AbortController();
    const old = h.api.fetch('/shared', { signal: ctl.signal });
    const rejected = assert.rejects(old, { name: 'AbortError' }); ctl.abort();
    const fresh = h.api.fetch('/shared');
    assert.equal(wire.calls.length, 2); assert.equal(wire.calls[0].options.signal.aborted, true);
    finish(wire.calls[0], { old: true }); finish(wire.calls[1], { fresh: true });
    await rejected; assert.equal((await fresh).fresh, true);
});

test('one dedup timeout does not change another subscriber deadline', async t => {
    const wire = transport(), h = setup(t, wire);
    const short = h.api.fetch('/shared', { timeoutMs: 5 });
    const long = h.api.fetch('/shared');
    await assert.rejects(short, { name: 'AbortError' });
    assert.equal(wire.calls.length, 1); assert.equal(wire.calls[0].options.signal.aborted, false);
    finish(wire.calls[0], { ok: true }); assert.equal((await long).ok, true);
});

test('timeout includes time in the queue and leaves capacity available', async t => {
    const wire = transport(), h = setup(t, wire); h.manager.CONFIG.concurrency.maxConcurrent = 1;
    const first = h.api.fetch('/first');
    await assert.rejects(h.api.fetch('/expired', { timeoutMs: 5 }), { name: 'AbortError' });
    assert.equal(wire.calls.length, 1); finish(wire.calls[0]); await first;
    const next = h.api.fetch('/next'); assert.equal(wire.calls.length, 2); finish(wire.calls[1]); await next;
});

for (const clear of ['clearCache', 'clearCacheMatching']) test(`${clear} prevents pending writes and dedup joins across the clear`, async t => {
    const wire = transport(), h = setup(t, wire);
    const old = h.api.fetch('/old', { cacheKey: 'shared' });
    h.manager[clear]('shared');
    const fresh = h.api.fetch('/fresh', { cacheKey: 'shared' });
    assert.equal(wire.calls.length, 2);
    finish(wire.calls[1], { generation: 2 }); await fresh;
    finish(wire.calls[0], { generation: 1 }); await old;
    assert.equal(h.manager.getCached('shared').generation, 2);
});

test('a cache clear during queueing also blocks the queued old generation from writing', async t => {
    const wire = transport(), h = setup(t, wire); h.manager.CONFIG.concurrency.maxConcurrent = 1;
    const first = h.api.fetch('/block'); const queued = h.api.fetch('/queued', { cacheKey: 'queued' });
    h.manager.clearCache(); finish(wire.calls[0]); await first; await flush();
    finish(wire.calls[1], { old: true }); await queued; assert.equal(h.manager.getCached('queued'), null);
});

test('false and zero cached payloads are hits', async t => {
    let calls = 0; const h = setup(t, { fetch: async () => { calls++; return jsonResponse(false); } });
    h.manager.setCache('false', false); h.manager.setCache('zero', 0);
    assert.equal(await h.api.fetch('/x', { cacheKey: 'false' }), false);
    assert.equal(await h.api.fetch('/x', { cacheKey: 'zero' }), 0); assert.equal(calls, 0);
});

for (const transition of ['user', 'server', 'client', 'base', 'logout-return']) test(`${transition} transition rejects old responses and clears cached state`, async t => {
    let user = 'a', server = 'one', base = 'http://jellyfin.test/base';
    const wire = transport();
    const h = setup(t, { fetch: wire.fetch, apiClient: { getCurrentUserId: () => user, serverId: () => server, getUrl: path => base + path } });
    h.manager.setCache('private', { owner: 'a' });
    const old = h.api.jf('/old'); const rejected = assert.rejects(old, { name: 'AbortError' });
    if (transition === 'user') user = 'b';
    if (transition === 'server') server = 'two';
    if (transition === 'client') h.window.ApiClient = { ...h.window.ApiClient };
    if (transition === 'base') base = 'http://different.test/new-base';
    if (transition === 'logout-return') {
        h.window.ApiClient.setAuthenticationInfo = undefined;
        user = null; h.JE.session.checkNow('logout'); user = 'a';
    }
    const fresh = h.api.jf('/fresh');
    await rejected; assert.equal(h.manager.getCached('private'), null);
    finish(wire.calls[0], { secret: true }); finish(wire.calls[1], { fresh: true });
    assert.equal((await fresh).fresh, true);
    assert.equal(wire.calls[1].url, base + '/fresh');
});

test('identity changes during body parsing reject before delivering or caching payloads', async t => {
    let user = 'a'; const body = deferred();
    const h = setup(t, { apiClient: { getCurrentUserId: () => user }, fetch: async () => ({ ok: true, status: 200, text: () => body.promise }) });
    const pending = h.api.fetch('/private', { cacheKey: 'private' });
    const rejected = assert.rejects(pending, { name: 'AbortError' }); await flush();
    user = 'b'; body.resolve('{"secret":true}'); await rejected; assert.equal(h.manager.getCached('private'), null);
});

test('user switch cancels queued mutations and running requests', async t => {
    let user = 'a', token = 'a-token'; const wire = transport();
    const h = setup(t, { fetch: wire.fetch, apiClient: { getCurrentUserId: () => user, accessToken: () => token,
        setAuthenticationInfo(nextToken, nextUser) { token = nextToken; user = nextUser; } } });
    h.manager.CONFIG.concurrency.maxConcurrent = 1;
    const running = assert.rejects(h.api.fetch('/running'), { name: 'AbortError' });
    const queued = assert.rejects(h.api.fetch('/write', { method: 'POST' }), { name: 'AbortError' });
    h.window.ApiClient.setAuthenticationInfo('b-token', 'b');
    await Promise.all([running, queued]); assert.equal(wire.calls.length, 1);
    assert.equal(wire.calls[0].options.headers.Authorization, 'MediaBrowser Token="a-token"');
    finish(wire.calls[0]);
});

test('no retry may send old-user work after a silent identity change', async t => {
    let user = 'a', calls = 0;
    const h = setup(t, { apiClient: { getCurrentUserId: () => user }, fetch: async () => {
        calls++; user = 'b'; return jsonResponse({}, 503);
    } });
    await assert.rejects(h.api.fetch('/retry'), { name: 'AbortError' }); assert.equal(calls, 1);
});

test('retry backoff is abortable on a credential change', async t => {
    let user = 'a', calls = 0;
    const h = setup(t, { apiClient: { getCurrentUserId: () => user }, fetch: async () => { calls++; return jsonResponse({}, 503); } });
    h.manager.CONFIG.retry.baseDelayMs = 1000;
    const pending = h.api.fetch('/retry'), rejected = assert.rejects(pending, { name: 'AbortError' }); await flush();
    user = 'b'; h.JE.session.checkNow('switch'); await rejected; assert.equal(calls, 1);
});

test('mutation network uncertainty never triggers automatic replay', async t => {
    let calls = 0; const h = setup(t, { fetch: async () => { calls++; throw new Error('connection lost after send'); } });
    await assert.rejects(h.api.plugin('/request', { method: 'POST', body: { id: 1 } }), { name: 'MutationUncertainError' });
    assert.equal(calls, 1);
});

test('mutation HTTP failures preserve structured errors without replay', async t => {
    let calls = 0; const h = setup(t, { fetch: async () => { calls++; return jsonResponse({ message: 'quota' }, 503); } });
    await assert.rejects(h.api.fetch('/write', { method: 'POST' }), error => error.status === 503 && error.responseJSON.message === 'quota');
    assert.equal(calls, 1);
});

test('an explicitly replay-safe mutation can retry, while skipRetry always wins', async t => {
    let calls = 0; const h = setup(t, { fetch: async () => ++calls % 2 ? jsonResponse({}, 503) : jsonResponse({ ok: true }) });
    assert.equal((await h.api.fetch('/write', { method: 'POST', retrySafe: true })).ok, true); assert.equal(calls, 2);
    await assert.rejects(h.api.fetch('/write', { method: 'POST', retrySafe: true, skipRetry: true })); assert.equal(calls, 3);
});

test('retry limit and network-after-HTTP failures are bounded', async t => {
    let calls = 0; const h = setup(t, { fetch: async () => { calls++; if (calls === 1) return jsonResponse({}, 503); throw new Error('offline'); } });
    h.manager.CONFIG.retry.maxAttempts = 3;
    await assert.rejects(h.api.fetch('/retry'), /offline/); assert.equal(calls, 3);
});

test('retry budget aborts a transport that never settles', async t => {
    const wire = transport(), h = setup(t, wire); h.manager.CONFIG.retry.timeoutBudgetMs = 5;
    await assert.rejects(h.api.fetch('/hang'), { name: 'AbortError' });
    assert.equal(wire.calls.length, 1); assert.equal(wire.calls[0].options.signal.aborted, true); finish(wire.calls[0]);
});

test('decoder boundary validates network and cached payloads without hiding malformed JSON', async t => {
    let payload = { count: 'wrong' }, calls = 0;
    const h = setup(t, { fetch: async () => { calls++; return jsonResponse(payload); } });
    const decode = value => { if (typeof value?.count !== 'number') throw new Error('count must be numeric'); return value.count; };
    await assert.rejects(h.api.fetchDecoded('/data', decode, { cacheKey: 'data' }), { name: 'DecodeError' });
    await assert.rejects(h.api.fetchDecoded('/data', decode, { cacheKey: 'data' }), { name: 'DecodeError' }); assert.equal(calls, 1);
    payload = { count: 3 }; h.manager.clearCache();
    assert.equal(await h.api.pluginDecoded('/data', decode), 3);
    h.window.fetch = async () => new Response('{broken');
    await assert.rejects(h.api.jfDecoded('/bad', decode), { name: 'SyntaxError' });
});

test('base-path resolution and auth overrides survive the adapter boundary', async t => {
    const calls = []; const h = setup(t, { apiClient: { getUrl: path => `https://host.test/jellyfin${path}` },
        fetch: async (...args) => { calls.push(args); return jsonResponse({}); } });
    await h.api.plugin('/settings', { method: 'POST', headers: { 'content-type': 'application/custom' }, body: { nested: true } });
    assert.equal(calls[0][0], 'https://host.test/jellyfin/JellyfinEnhanced/settings');
    assert.equal(calls[0][1].headers.Authorization, 'MediaBrowser Token="test-token"');
    assert.equal(calls[0][1].headers['Content-Type'], undefined);
    await h.api.fetch('https://other.test', { auth: false }); assert.equal(calls[1][1].headers.Authorization, undefined);
});

test('decorative lane widens while idle but reserves a normal slot', async t => {
    const wire = transport(), h = setup(t, wire);
    const low = Array.from({ length: 4 }, (_, i) => h.api.fetch(`/low${i}`, { priority: 'low' }));
    assert.equal(wire.calls.length, 3);
    const normal = h.api.fetch('/normal'); assert.equal(wire.calls.length, 4); assert.equal(wire.calls[3].url, '/normal');
    finish(wire.calls[0]); await flush(); assert.equal(wire.calls.length, 4, 'low cap shrinks while normal work runs');
    finish(wire.calls[3]); await flush(); assert.equal(wire.calls.length, 5);
    for (const call of wire.calls) finish(call); await Promise.all([...low, normal]);
});

test('a normal dedup subscriber promotes a queued low request', async t => {
    const wire = transport(), h = setup(t, wire); h.manager.CONFIG.concurrency.maxConcurrent = 1;
    const blocker = h.api.fetch('/block');
    const low = h.api.fetch('/target', { priority: 'low' });
    const other = h.api.fetch('/other', { priority: 'low' });
    const normal = h.api.fetch('/target');
    finish(wire.calls[0]); await blocker; await flush();
    assert.equal(wire.calls[1].url, '/target'); assert.equal(wire.calls[1].options.priority, undefined);
    finish(wire.calls[1]); await Promise.all([low, normal]); await flush();
    finish(wire.calls[2]); await other; assert.equal(wire.calls.length, 3);
});

test('navigation demotes retained decorative requests behind new-page lookups', async t => {
    const wire = transport(), h = setup(t, wire); h.manager.CONFIG.concurrency.maxConcurrent = 1;
    const block = h.api.fetch('/block'), old = h.api.fetch('/old', { priority: 'low' });
    h.window.history.pushState({}, '', '#!/next');
    const fresh = h.api.fetch('/fresh', { priority: 'low' }); finish(wire.calls[0]); await block; await flush();
    assert.equal(wire.calls[1].url, '/fresh'); finish(wire.calls[1]); await fresh; await flush();
    assert.equal(wire.calls[2].url, '/old'); finish(wire.calls[2]); await old;
});

test('bounded queues evict oldest retained decorations but reject excess normal work', async t => {
    const wire = transport(), h = setup(t, wire);
    Object.assign(h.manager.CONFIG.concurrency, { maxConcurrent: 1, maxQueueSize: 1, maxLowQueueSize: 1 });
    const block = h.api.fetch('/block');
    const old = assert.rejects(h.api.fetch('/old', { priority: 'low' }), { name: 'AbortError' });
    h.window.history.pushState({}, '', '#!/next');
    const fresh = h.api.fetch('/fresh', { priority: 'low' }); await old;
    const normal = h.api.fetch('/normal'); await assert.rejects(h.api.fetch('/excess'), /queue full/);
    await assert.rejects(h.api.fetch('/low-excess', { priority: 'low' }), /queue full/);
    finish(wire.calls[0]); await block; await flush(); assert.equal(wire.calls[1].url, '/normal');
    finish(wire.calls[1]); await normal; await flush(); finish(wire.calls[2]); await fresh;
});

test('cancellation after slot reservation cannot run the cancelled function or leak a slot', async t => {
    const h = setup(t), m = h.manager, gate = deferred(), ctl = new h.window.AbortController();
    m.CONFIG.concurrency.maxConcurrent = 1;
    const first = m.withConcurrencyLimit(() => gate.promise);
    let ran = false;
    const second = m.withConcurrencyLimit(async () => { ran = true; }, { signal: ctl.signal });
    const rejected = assert.rejects(second, { name: 'AbortError' });
    gate.resolve(); ctl.abort(); await Promise.all([first, rejected]);
    assert.equal(ran, false); assert.equal(await m.withConcurrencyLimit(async () => 42), 42);
});

test('metrics retain section counts, transport attempts and queue wait lanes', async t => {
    const wire = transport(), h = setup(t, wire), m = h.manager;
    m.CONFIG.concurrency.maxConcurrent = 1; m.metrics.enabled = true; m.startMeasurement('details');
    m.recordRequest('details', 2048, true);
    const first = h.api.fetch('/first'), second = h.api.fetch('/second');
    finish(wire.calls[0]); await first; await flush(); finish(wire.calls[1]); await second;
    const result = m.endMeasurement('details'); assert.equal(result.requests, 1); assert.equal(result.bytes, 2048); assert.equal(result.cacheHits, 1);
    const metrics = m.getMetrics(); assert.equal(metrics.requests.length, 2); assert.equal(metrics.queueWaits[0].priority, 'normal');
    assert.ok(metrics.queueWaits[0].waitMs >= 0); m.resetMetrics(); assert.deepEqual(plain(m.getMetrics()), { sections: {}, requests: [], queueWaits: [] });
});

test('cached results cannot cross a synchronous identity transition before delivery', async t => {
    let user = 'a'; const h = setup(t, { apiClient: { getCurrentUserId: () => user } });
    h.manager.setCache('private', { owner: 'a' });
    const pending = h.api.fetch('/private', { cacheKey: 'private' });
    user = 'b'; h.JE.session.checkNow('switch');
    await assert.rejects(pending, { name: 'AbortError' });
});

test('legacy dedup promotion reaches the shared scheduler admission object', async t => {
    const h = setup(t), m = h.manager, gate = deferred(), lowGate = deferred(), order = [];
    m.CONFIG.concurrency.maxConcurrent = 1;
    const block = m.withConcurrencyLimit(() => gate.promise);
    const lowOptions = { priority: 'low' };
    const other = m.withConcurrencyLimit(async () => { order.push('other'); }, { priority: 'low' });
    const low = m.deduplicatedFetch('low', () => m.withConcurrencyLimit(async () => { order.push('promoted'); return lowGate.promise; }, lowOptions), undefined, lowOptions);
    const normal = m.deduplicatedFetch('low', async () => { throw new Error('must join'); });
    gate.resolve(); await block; await flush(); assert.deepEqual(order, ['promoted']);
    lowGate.resolve(); await Promise.all([low, normal, other]); assert.deepEqual(order, ['promoted', 'other']);
});

test('retry jitter and clamping use the configured bounded exponential schedule', async t => {
    let calls = 0; const h = setup(t, { fetch: async () => ++calls < 4 ? jsonResponse({}, 503) : jsonResponse({ ok: true }) });
    const timers = [], original = h.window.setTimeout.bind(h.window);
    h.window.setTimeout = (callback, ms) => { timers.push(ms); return original(callback, ms); };
    h.window.Math.random = () => 0;
    Object.assign(h.manager.CONFIG.retry, { maxAttempts: 4, baseDelayMs: 10, maxDelayMs: 20, jitterFactor: 0.3 });
    assert.equal((await h.api.fetch('/retry')).ok, true);
    assert.deepEqual(timers.filter(ms => ms < 1000), [7, 14, 14]); assert.equal(calls, 4);
});

test('legacy callback synchronous exceptions reject without occupying a dedup key', async t => {
    const h = setup(t);
    await assert.rejects(h.manager.deduplicatedFetch('key', () => { throw new Error('synchronous'); }), /synchronous/);
    assert.equal(await h.manager.deduplicatedFetch('key', async () => 7), 7);
});

for (const legacy of [false, true]) test(`cancellation after headers reaches the ${legacy ? 'legacy' : 'core'} fetch body`, async t => {
    const body = deferred(); let signal;
    const h = setup(t, { fetch: async (_url, init) => {
        signal = init.signal;
        return { ok: true, status: 200, text: () => body.promise };
    } });
    const controller = new h.window.AbortController();
    if (legacy) {
        const response = await h.manager.fetchWithRetry('/stream', { signal: controller.signal });
        controller.abort();
        assert.equal(signal.aborted, true);
        body.resolve('{}');
        await response.text();
    } else {
        const pending = h.api.fetch('/stream', { signal: controller.signal });
        const rejected = assert.rejects(pending, { name: 'AbortError' });
        await flush(); controller.abort(); await rejected;
        assert.equal(signal.aborted, true);
        body.resolve('{}');
    }
});
