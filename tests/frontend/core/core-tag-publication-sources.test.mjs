// Every source the tag pipeline publishes from carries the same authority as a network download: a stored entry read
// across a live account switch is never rendered for the incoming account, and a Hidden Content change revokes a tag-cache
// download that started before it, exactly as a Spoiler Guard change does.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as settle } from 'node:timers/promises';
import { createHarness, deferred } from '../helpers/harness.mjs';

const card = '<div class="card" data-id="aabb" data-type="Episode"><div class="cardScalable"><div class="cardImageContainer"></div><div class="cardOverlayContainer"></div></div></div>';

async function drainIdle(idle) {
    for (let i = 0; i < 10 && idle.length; i++) {
        const work = idle.splice(0);
        for (const fn of work) fn({ timeRemaining: () => 50 });
        await settle();
    }
}

test('a stored entry awaited across a live account switch is never rendered for the incoming account', async (t) => {
    const pending = deferred(), rendered = [], idle = [];
    let reads = 0;
    const meta = { version: 1, timestamp: 100, filterRevision: 'a', servedAt: 100, count: 1 };
    const h = createHarness({
        html: card,
        globals: { requestIdleCallback: (fn) => idle.push(fn) },
        apiClient: { ajax: async () => ({ count: 0, items: {}, version: 1, timestamp: 100, servedAt: 101, filterRevision: 'a' }) },
        JE: {
            pluginConfig: { TagCacheServerMode: true }, currentSettings: { qualityTagsEnabled: true },
            helpers: { onBodyMutation() {}, onNavigate() {}, addCSS() {} },
            core: { navigation: { onNavigate() {} }, tagRenderer: { applyCornerStacking() {}, scheduleCornerStacking() {} } },
            tagCacheStore: {
                available: () => true, getMeta: async () => meta,
                clearOtherScopes: async () => {}, getMany: () => { reads++; return pending.promise; }, applyDelta: async () => {},
            },
        },
    });
    t.after(() => h.close());
    h.load('core/session.js');
    h.load('tags/tag-pipeline.js');
    h.JE.tagPipeline.registerRenderer('probe', {
        isEnabled: () => true,
        renderFromServerCache: (_, entry) => rendered.push(entry), render() {},
    });
    h.JE.tagPipeline.initialize();
    for (let i = 0; i < 15 && !reads; i++) {
        await settle();
        for (const fn of idle.splice(0)) fn({ timeRemaining: () => 50 });
    }
    assert.equal(reads, 1, 'stored lookup was reached');
    const epoch = h.JE.session.getEpoch();
    // Another account is live before session polling notices (no epoch change yet).
    h.window.ApiClient = { ...h.window.ApiClient, getCurrentUserId: () => 'user-b' };
    assert.equal(h.JE.session.getEpoch(), epoch);
    pending.resolve({ entries: new Map([['aabb', { Type: 'Episode', StreamData: { ItemName: 'first-account-private' } }]]), meta });
    await settle();
    await settle();
    assert.equal(rendered.some((x) => JSON.stringify(x).includes('first-account-private')), false);
});

test('Hidden Content policy changes revoke an in-flight tag cache publication', async (t) => {
    const old = deferred(), rendered = [], idle = [], calls = [];
    const h = createHarness({
        html: card,
        globals: { requestIdleCallback: (fn) => idle.push(fn) },
        apiClient: { ajax: (o) => { calls.push(o); return old.promise; } },
        JE: {
            pluginConfig: { TagCacheServerMode: true }, currentSettings: { qualityTagsEnabled: true },
            helpers: { onBodyMutation() {}, onNavigate() {}, addCSS() {} },
            core: { tagRenderer: { applyCornerStacking() {}, scheduleCornerStacking() {} } },
            session: { getUserId: () => 'user-a', getServerId: () => 'server-a', getEpoch: () => 0, isCurrent: () => true, onUserChange() {} },
        },
    });
    t.after(() => h.close());
    h.load('tags/tag-pipeline.js');
    h.JE.tagPipeline.registerRenderer('probe', {
        isEnabled: () => true,
        renderFromServerCache: (host, item) => rendered.push(item), render: (host, item) => rendered.push(item), onServerCacheRefresh() {},
    });
    h.JE.tagPipeline.initialize();
    await settle();
    assert.equal(calls.length, 1);
    // The real Hidden Content save notification; the account and session stay the same.
    h.window.dispatchEvent(new h.window.CustomEvent('je-hidden-content-changed'));
    old.resolve({ count: 1, items: { aabb: { Type: 'Episode', StreamData: { ItemName: 'R25 item hidden while downloading' } } }, version: 1, timestamp: 100, filterRevision: 'before-hide' });
    await settle();
    await drainIdle(idle);
    assert.equal(rendered.some((i) => JSON.stringify(i).includes('R25 item hidden while downloading')), false, 'pre-hide tags were accepted and rendered after the Hidden Content save');
});

/** A pipeline over two cards with a probe renderer; `ajax` answers the host's requests. */
function pipeline(t, { ajax, html = card, session = true, store } = {}) {
    const rendered = [], idle = [];
    const h = createHarness({
        html,
        globals: { requestIdleCallback: (fn) => idle.push(fn) },
        apiClient: { ajax },
        JE: {
            pluginConfig: { TagCacheServerMode: true }, currentSettings: { qualityTagsEnabled: true },
            helpers: { onBodyMutation() {}, onNavigate() {}, addCSS() {} },
            core: { navigation: { onNavigate() {} }, tagRenderer: { applyCornerStacking() {}, scheduleCornerStacking() {} } },
            ...(store ? { tagCacheStore: store } : {}),
        },
    });
    t.after(() => h.close());
    if (session) h.load('core/session.js');
    h.load('tags/tag-pipeline.js');
    h.JE.tagPipeline.registerRenderer('probe', {
        isEnabled: () => true,
        renderFromServerCache: (_, entry) => rendered.push(entry), render: (_, item) => rendered.push(item), onServerCacheRefresh() {},
    });
    return { h, rendered, idle, switchAccount: () => { h.window.ApiClient = { ...h.window.ApiClient, getCurrentUserId: () => 'user-b' }; } };
}

const secondCard = '<div class="card" data-id="ccdd" data-type="Episode"><div class="cardScalable"><div class="cardImageContainer"></div><div class="cardOverlayContainer"></div></div></div>';

test('an entry already in memory is never painted for an account signed in before the session notices', async (t) => {
    const { h, rendered, idle, switchAccount } = pipeline(t, {
        ajax: async (o) => o.type === 'GET'
            ? { count: 2, items: { aabb: { Type: 'Episode' }, ccdd: { Type: 'Episode', StreamData: { ItemName: 'first-account memory only' } } }, version: 1, timestamp: 100, servedAt: 100, filterRevision: 'a' }
            : { Items: [] },
    });
    h.JE.tagPipeline.initialize();
    await settle();
    await drainIdle(idle);
    // Another account is live; a card of the first account's cache appears before the session's poll.
    switchAccount();
    h.document.body.insertAdjacentHTML('beforeend', secondCard);
    h.JE.tagPipeline.scheduleScan();
    await drainIdle(idle);
    assert.equal(rendered.some((x) => JSON.stringify(x).includes('first-account memory only')), false);
});

test('a tag-data batch requested for one account is never rendered for the next', async (t) => {
    const batch = deferred();
    const { h, rendered, idle, switchAccount } = pipeline(t, {
        ajax: (o) => o.type === 'GET' ? Promise.resolve({ count: 0, items: {}, version: 1, timestamp: 100, filterRevision: 'a' }) : batch.promise,
    });
    h.JE.tagPipeline.initialize();
    await settle();
    await drainIdle(idle);
    await new Promise((resolve) => setTimeout(resolve, 200)); // the batch debounce
    switchAccount();
    batch.resolve({ Items: [{ Id: 'aabb', Type: 'Episode', Name: 'first-account batch only' }] });
    await settle();
    await drainIdle(idle);
    assert.equal(rendered.some((x) => JSON.stringify(x).includes('first-account batch only')), false);
});

test('review averages published for one account are not read by the next', async (t) => {
    const { h, idle, switchAccount } = pipeline(t, {
        ajax: async () => ({ count: 1, items: { aabb: { Type: 'Episode' } }, version: 1, timestamp: 100, servedAt: 100, filterRevision: 'a', reviewRatings: { 'tv:tmdb:1': { average: 8, count: 1 } } }),
    });
    h.JE.tagPipeline.initialize();
    await settle();
    await drainIdle(idle);
    assert.equal(h.JE.tagPipeline.peekReviewRatings()?.get('tv:tmdb:1'), 8);
    switchAccount();
    assert.equal(h.JE.tagPipeline.peekReviewRatings(), null);
});

test('a Hidden Content save revokes a tag-data batch requested before it, and the card gets the answer asked after it', async (t) => {
    const batch = deferred();
    let posts = 0;
    const { h, rendered, idle } = pipeline(t, {
        session: false,
        ajax: (o) => o.type === 'GET' ? Promise.resolve({ count: 0, items: {}, version: 1, timestamp: 100, filterRevision: 'a' })
            : ++posts === 1 ? batch.promise : Promise.resolve({ Items: [{ Id: 'aabb', Type: 'Episode', Name: 'asked after the save' }] }),
    });
    h.JE.session = { getUserId: () => 'user-a', getServerId: () => 'server-a', getEpoch: () => 0, isCurrent: () => true, onUserChange() {} };
    h.JE.tagPipeline.initialize();
    await settle();
    await drainIdle(idle);
    await new Promise((resolve) => setTimeout(resolve, 200)); // the batch debounce
    h.window.dispatchEvent(new h.window.CustomEvent('je-hidden-content-changed'));
    batch.resolve({ Items: [{ Id: 'aabb', Type: 'Episode', Name: 'hidden before its batch returned' }] });
    await settle();
    await drainIdle(idle);
    assert.equal(rendered.some((x) => JSON.stringify(x).includes('hidden before its batch returned')), false);
    // The card is scanned again and asks under the new rules.
    for (let i = 0; i < 5 && !rendered.length; i++) { await drainIdle(idle); await new Promise((resolve) => setTimeout(resolve, 200)); await settle(); }
    assert.equal(rendered.some((x) => JSON.stringify(x).includes('asked after the save')), true, 'the card never got its tags after the save');
});

test("the stored-copy cleanup queued for one account never runs once another account is live", async (t) => {
    const meta = deferred(), cleared = [];
    let live = 'user-a';
    const { h, idle } = pipeline(t, {
        ajax: async () => ({ count: 0, items: {}, version: 1, timestamp: 100, filterRevision: 'a' }),
        store: {
            available: () => true, getMeta: () => meta.promise, getMany: async () => ({ entries: new Map(), meta: null }),
            clearOtherScopes: async (scope) => { cleared.push({ scope, live }); }, clearScope: async () => {}, applyDelta: async () => {},
            beginFullWrite: async () => false, putManyIfOwner: async () => false, commitFullWrite: async () => false,
        },
    });
    h.JE.tagPipeline.initialize();
    await settle();
    // The first account's copy is read; the second account signs in before anything queued after the read runs.
    meta.resolve({ version: 1, timestamp: 100, filterRevision: 'a', servedAt: 100, count: 1 });
    live = 'user-b';
    h.window.ApiClient = { ...h.window.ApiClient, getCurrentUserId: () => 'user-b' };
    await settle();
    await drainIdle(idle);
    await settle();
    assert.deepEqual(cleared.filter((c) => c.live === 'user-b'), [], 'the outgoing account cleaned up the incoming account\'s stored copy');
});

test("a stored-copy cleanup queued behind a write never runs for the account that left", async (t) => {
    const cleared = [], second = deferred();
    let live = 'user-a', reads = 0;
    const { h, idle } = pipeline(t, {
        ajax: async () => ({ count: 1, items: { aabb: { Type: 'Episode' } }, version: 1, timestamp: 100, servedAt: 100, filterRevision: 'a' }),
        store: {
            available: () => true, getMeta: () => (reads++ === 0 ? Promise.resolve(null) : second.promise),
            getMany: async () => ({ entries: new Map(), meta: null }),
            clearOtherScopes: async (scope) => { cleared.push({ scope, live }); }, clearScope: async () => {}, applyDelta: async () => {},
            beginFullWrite: async () => false, putManyIfOwner: async () => false, commitFullWrite: async () => false,
        },
    });
    h.JE.tagPipeline.initialize();
    await settle();
    await drainIdle(idle);
    // The first load had no stored copy: its full download queued a stored-copy write, which waits before it starts.
    const reload = h.JE.tagPipeline.invalidateServerCache({ reuseStored: true });
    await settle();
    assert.equal(reads, 2, 'the reload reads the stored copy');
    // The reload restores the copy and queues its cleanup of other scopes behind that write.
    second.resolve({ version: 1, timestamp: 100, filterRevision: 'a', servedAt: 100, count: 1 });
    await settle();
    await settle();
    // Another account signs in before the queued work runs.
    live = 'user-b';
    h.window.ApiClient = { ...h.window.ApiClient, getCurrentUserId: () => 'user-b' };
    await new Promise((resolve) => setTimeout(resolve, 1700)); // the write's start delay
    await settle();
    await reload.catch(() => {});
    assert.deepEqual(cleared.filter((c) => c.live === 'user-b'), [], 'the outgoing account cleaned up while the incoming account was live');
});

test("a full download's stored-copy write never starts once another account is live", async (t) => {
    const writes = [];
    let live = 'user-a';
    const { h, idle } = pipeline(t, {
        ajax: async () => ({ count: 1, items: { aabb: { Type: 'Episode' } }, version: 1, timestamp: 100, servedAt: 100, filterRevision: 'a' }),
        store: {
            available: () => true, getMeta: async () => null, getMany: async () => ({ entries: new Map(), meta: null }),
            clearOtherScopes: async () => {}, clearScope: async () => {}, applyDelta: async () => {},
            beginFullWrite: async (scope) => { writes.push({ scope, live }); return false; }, putManyIfOwner: async () => false, commitFullWrite: async () => false,
        },
    });
    h.JE.tagPipeline.initialize();
    await settle();
    await drainIdle(idle);
    // The download is in memory; its stored-copy write waits for the page's first scans. Another account signs in.
    live = 'user-b';
    h.window.ApiClient = { ...h.window.ApiClient, getCurrentUserId: () => 'user-b' };
    await new Promise((resolve) => setTimeout(resolve, 1700)); // the write's start delay
    await settle();
    assert.deepEqual(writes.filter((w) => w.live === 'user-b'), [], "the outgoing account's download was written while the incoming account was live");
});

test('a stored read that fails after an account switch paints none of the memory hits it gathered', async (t) => {
    const read = deferred(), rendered = [];
    const meta = { version: 1, timestamp: 100, filterRevision: 'a', servedAt: 100, count: 2 };
    const two = '<div class="card" data-id="aabb" data-type="Episode"><div class="cardScalable"><div class="cardImageContainer"></div><div class="cardOverlayContainer"></div></div></div>'
        + '<div class="card" data-id="ccdd" data-type="Episode"><div class="cardScalable"><div class="cardImageContainer"></div><div class="cardOverlayContainer"></div></div></div>';
    let reads = 0;
    const { h, idle } = pipeline(t, {
        html: two,
        // The confirming delta brings one entry into memory; the other is in the stored copy.
        ajax: async () => ({ count: 1, items: { aabb: { Type: 'Episode', StreamData: { ItemName: 'first-account delta entry' } } }, version: 1, timestamp: 101, servedAt: 101, filterRevision: 'a' }),
        store: {
            available: () => true, getMeta: async () => meta, getMany: () => { reads++; return read.promise; },
            clearOtherScopes: async () => {}, clearScope: async () => {}, applyDelta: async () => {},
            beginFullWrite: async () => false, putManyIfOwner: async () => false, commitFullWrite: async () => false,
        },
    });
    h.JE.tagPipeline.registerRenderer('paint', { isEnabled: () => true, renderFromServerCache: (_, entry) => rendered.push(entry), render() {} });
    h.JE.tagPipeline.initialize();
    for (let i = 0; i < 15 && !reads; i++) { await settle(); for (const fn of idle.splice(0)) fn({ timeRemaining: () => 50 }); }
    assert.equal(reads, 1, 'the stored copy was read for the card memory lacks');
    h.window.ApiClient = { ...h.window.ApiClient, getCurrentUserId: () => 'user-b' };
    read.reject(new Error('transaction aborted'));
    await settle();
    await settle();
    assert.equal(rendered.some((x) => JSON.stringify(x).includes('first-account delta entry')), false);
});

test('once a Hidden Content save is acknowledged, a card asked about before it is asked again', async (t) => {
    let posts = 0;
    const { h, rendered, idle } = pipeline(t, {
        session: false,
        // The first answer was given before the server had the unhide (the item still left out); the next one after it.
        ajax: (o) => o.type === 'GET' ? Promise.resolve({ count: 0, items: {}, version: 1, timestamp: 100, filterRevision: 'a' })
            : Promise.resolve(++posts === 1 ? { Items: [] } : { Items: [{ Id: 'aabb', Type: 'Episode', Name: 'shown again after the save' }] }),
    });
    h.JE.session = { getUserId: () => 'user-a', getServerId: () => 'server-a', getEpoch: () => 0, isCurrent: () => true, onUserChange() {} };
    h.JE.tagPipeline.initialize();
    await settle();
    await drainIdle(idle);
    await new Promise((resolve) => setTimeout(resolve, 200)); // the batch debounce
    await settle();
    assert.equal(posts, 1);
    h.window.dispatchEvent(new h.window.CustomEvent('je-hidden-content-saved'));
    for (let i = 0; i < 5 && !rendered.length; i++) { await drainIdle(idle); await new Promise((resolve) => setTimeout(resolve, 200)); await settle(); }
    assert.equal(rendered.some((x) => JSON.stringify(x).includes('shown again after the save')), true, 'the card kept the answer given before the save');
});
