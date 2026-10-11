import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, deferred, jsonResponse, plain } from '../helpers/harness.mjs';

// JE.arr.onStatusChange: one long-poll per tab against JE's change feed, only while something is
// subscribed and the tab is visible; delivery per subscription; backoff; stop when switched off;
// resets; user switches; no request while loading.
function setup(t) {
  const timers = [];
  const calls = [];
  const navs = [];
  const userHandlers = [];
  let visibility = 'visible';
  const fetch = (url, init) => {
    const call = { url, init, body: JSON.parse(init.body), reply: deferred(), aborted: false };
    calls.push(call);
    init.signal.addEventListener('abort', () => {
      call.aborted = true;
      call.reply.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    });
    return call.reply.promise;
  };
  const h = createHarness({
    fetch,
    globals: {
      setTimeout: (fn, delay) => { const timer = { fn, delay, cleared: false }; timers.push(timer); return timer; },
      clearTimeout: timer => { if (timer) timer.cleared = true; }
    },
    JE: {
      core: {
        api: { authHeaders: () => ({ Authorization: 'MediaBrowser Token="test-token"' }) },
        navigation: { onNavigate: fn => navs.push(fn) }
      },
      session: { getEpoch: () => 1, onUserChange: (name, fn) => userHandlers.push(fn) }
    }
  });
  Object.defineProperty(h.document, 'visibilityState', { configurable: true, get: () => visibility });
  h.window.Math.random = () => 0.5;
  h.load('arr/live/arr-live.js');
  t.after(() => h.close());
  const settle = () => new Promise(done => setImmediate(done));
  return {
    ...h, timers, calls, navs, userHandlers, settle,
    /** Runs every pending (not cleared) timer that is due; returns their delays. */
    async tick() {
      const due = timers.splice(0).filter(x => !x.cleared && x.delay < 30000);
      due.forEach(x => x.fn());
      await settle();
      return due.map(x => x.delay);
    },
    pending: () => timers.filter(x => !x.cleared),
    async answer(index, data, status = 200, headers = {}) {
      const response = status === 200 ? jsonResponse(data) : new Response(JSON.stringify(data || {}), { status, headers });
      calls[index].reply.resolve(response);
      await settle(); await settle();
    },
    setVisibility(state) { visibility = state; h.document.dispatchEvent(new h.window.Event('visibilitychange')); }
  };
}

test('loading makes no request and builds strict title keys', async t => {
  const h = setup(t);
  await h.settle();
  assert.equal(h.calls.length, 0);
  assert.equal(h.timers.length, 0);
  const key = h.JE.arr.titleKey;
  assert.equal(key({ type: 'movie', tmdbId: 45745 }), 'movie:tmdb:45745');
  assert.equal(key({ type: 'tv', tvdbId: '78874', season: 1, episode: 2 }), 'tv:tvdb:78874:s1:e2');
  assert.equal(key({ type: 'series', tvdbId: 78874, season: 0 }), 'tv:tvdb:78874:s0');
  assert.equal(key({ type: 'movie' }), null);
  assert.equal(key({ type: 'movie', tmdbId: '12; drop' }), null);
  assert.equal(key({ type: 'tv', tmdbId: 1 }), null);
  // Invalid keys or no callback: nothing to do, nothing scheduled.
  h.JE.arr.onStatusChange(['nope'], () => {})();
  h.JE.arr.onStatusChange(['movie:tmdb:1'], null);
  assert.equal(h.timers.length, 0);
});

test('a subscription bootstraps the cursor, long-polls with its keys and gets its changes', async t => {
  const h = setup(t);
  const got = [];
  const events = [];
  h.document.addEventListener('je:arr-status-change', e => events.push(e.detail));
  h.JE.arr.onStatusChange(['movie:tmdb:1', 'tv:tvdb:7'], (keys, info) => got.push([keys, info.reset]));
  const other = [];
  h.JE.arr.onStatusChange('movie:tmdb:2', keys => other.push(keys));
  const delays = await h.tick();
  assert.ok(delays.every(d => d >= 100), 'first poll waits (at least the first 300 ms after load)');
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].url, 'http://jellyfin.test/JellyfinEnhanced/acquire/changes');
  assert.equal(h.calls[0].init.method, 'POST');
  assert.equal(h.calls[0].init.headers.Authorization, 'MediaBrowser Token="test-token"');
  assert.deepEqual(h.calls[0].body, {});
  await h.answer(0, { epoch: 'e1', cursor: 5, keys: [], reset: false });
  // Made before the tab had a feed position (no `since`): each re-reads once, from that position.
  assert.deepEqual(plain(got), [[['movie:tmdb:1', 'tv:tvdb:7'], true]]);
  assert.deepEqual(plain(other), [['movie:tmdb:2']]);
  got.length = 0;
  other.length = 0;
  await h.tick();
  assert.deepEqual(h.calls[1].body, { epoch: 'e1', cursor: 5, keys: ['movie:tmdb:1', 'tv:tvdb:7', 'movie:tmdb:2'], wait: 25 });
  await h.answer(1, { epoch: 'e1', cursor: 9, keys: ['tv:tvdb:7', 'movie:tmdb:3'], reset: false });
  assert.deepEqual(plain(got), [[['tv:tvdb:7'], false]]);
  assert.deepEqual(plain(other), []);
  assert.deepEqual(plain(events), [{ keys: ['tv:tvdb:7'], reset: false }]);   // only subscribed keys
  await h.tick();
  assert.equal(h.calls[2].body.cursor, 9);
  assert.deepEqual(plain(h.JE.arr.live.state()), { status: 'polling', epoch: 'e1', cursor: 9, subscriptions: 2, keys: 3, failures: 0 });
});

test('new keys restart the poll, unsubscribing the last stops it, detached elements drop out', async t => {
  const h = setup(t);
  const off = h.JE.arr.onStatusChange(['movie:tmdb:1'], () => {});
  await h.tick();
  await h.answer(0, { epoch: 'e1', cursor: 1, keys: [] });
  await h.tick();
  assert.equal(h.calls.length, 2);
  // Same key again: the running poll already carries it.
  const again = h.JE.arr.onStatusChange(['movie:tmdb:1'], () => {});
  assert.equal(h.calls[1].aborted, false);
  // A new key: the poll is replaced so the server knows it.
  const element = h.document.createElement('div');
  h.document.body.appendChild(element);
  const seen = [];
  h.JE.arr.onStatusChange(['movie:tmdb:2'], keys => seen.push(keys), { element });
  await h.settle();
  assert.equal(h.calls[1].aborted, true);
  await h.tick();
  assert.deepEqual(plain(h.calls[2].body.keys), ['movie:tmdb:1', 'movie:tmdb:2']);
  // The element leaves the page: its subscription goes with it.
  element.remove();
  await h.answer(2, { epoch: 'e1', cursor: 2, keys: ['movie:tmdb:2'] });
  assert.deepEqual(plain(seen), []);
  assert.equal(h.JE.arr.live.state().subscriptions, 2);
  off();
  again();
  await h.settle();
  assert.equal(h.JE.arr.live.state().status, 'idle');
  assert.equal(h.pending().length, 0);
  const before = h.calls.length;
  await h.tick();
  assert.equal(h.calls.length, before);
});

test('failures back off and recover; a switched-off feature stops until navigation', async t => {
  const h = setup(t);
  h.JE.arr.onStatusChange(['movie:tmdb:1'], () => {});
  await h.tick();
  await h.answer(0, { epoch: 'e1', cursor: 1, keys: [] });
  await h.tick();
  await h.answer(1, {}, 500);
  assert.deepEqual(h.pending().map(x => x.delay), [2000]);
  await h.tick();
  await h.answer(2, {}, 502);
  assert.deepEqual(h.pending().map(x => x.delay), [4000]);
  await h.tick();
  h.calls[3].reply.reject(new TypeError('Failed to fetch'));
  await h.settle(); await h.settle();
  assert.deepEqual(h.pending().map(x => x.delay), [8000]);
  assert.equal(h.JE.arr.live.state().failures, 3);
  await h.tick();
  await h.answer(4, { epoch: 'e1', cursor: 2, keys: [] });
  assert.equal(h.JE.arr.live.state().failures, 0);
  await h.tick();
  await h.answer(5, {}, 429, { 'Retry-After': '7' });
  assert.deepEqual(h.pending().map(x => x.delay), [7000]);
  await h.tick();
  await h.answer(6, { error: true, code: 'feature_disabled' }, 403);
  assert.equal(h.JE.arr.live.state().status, 'stopped');
  assert.deepEqual(h.pending().map(x => x.delay), [300000]);
  const count = h.calls.length;
  h.JE.arr.onStatusChange(['movie:tmdb:9'], () => {});
  await h.tick();
  assert.equal(h.calls.length, count, 'no retry storm while switched off');
  h.navs.forEach(fn => fn());
  await h.tick();
  assert.equal(h.calls.length, count + 1);
});

test('a stop survives hiding the tab: visible again waits out the rest, navigation still retries', async t => {
  const h = setup(t);
  h.JE.arr.onStatusChange(['movie:tmdb:1'], () => {});
  await h.tick();
  await h.answer(0, { epoch: 'e1', cursor: 1, keys: [] });
  await h.tick();
  await h.answer(1, { error: true, code: 'feature_disabled' }, 403);
  assert.equal(h.JE.arr.live.state().status, 'stopped');
  h.setVisibility('hidden');
  await h.settle();
  assert.equal(h.pending().length, 0);
  assert.equal(h.JE.arr.live.state().status, 'stopped');
  h.setVisibility('visible');
  await h.settle();
  const retry = h.pending();
  assert.equal(retry.length, 1, 'a retry is armed for the rest of the stop');
  assert.ok(retry[0].delay > 290000 && retry[0].delay <= 300000);
  assert.equal(h.calls.length, 2);
  // When the stop ends, polling resumes by itself.
  h.timers.splice(0).forEach(x => { if (!x.cleared) x.fn(); });
  await h.tick();
  assert.equal(h.calls.length, 3);
  assert.equal(h.calls[2].body.cursor, 1);
  // Stopped again, hidden and shown: navigating still retries at once.
  await h.answer(2, {}, 404);
  h.setVisibility('hidden');
  h.setVisibility('visible');
  await h.settle();
  h.navs.forEach(fn => fn());
  await h.tick();
  assert.equal(h.calls.length, 4);
});

test('a stop outlives everyone unsubscribing: a new subscription waits out the rest and then polls', async t => {
  const h = setup(t);
  const off = h.JE.arr.onStatusChange(['movie:tmdb:1'], () => {});
  await h.tick();
  await h.answer(0, { epoch: 'e1', cursor: 1, keys: [] });
  await h.tick();
  await h.answer(1, { error: true, code: 'feature_disabled' }, 403);
  assert.equal(h.JE.arr.live.state().status, 'stopped');
  off();
  assert.equal(h.pending().length, 0);
  assert.equal(h.JE.arr.live.state().status, 'idle');
  // A new page subscribes during the stop: no request now, a retry armed for the rest of it.
  h.JE.arr.onStatusChange(['movie:tmdb:2'], () => {});
  await h.settle();
  const retry = h.pending();
  assert.equal(retry.length, 1, 'a retry is armed for the rest of the stop');
  assert.ok(retry[0].delay > 290000 && retry[0].delay <= 300000);
  assert.equal(h.JE.arr.live.state().status, 'stopped');
  assert.equal(h.calls.length, 2);
  h.timers.splice(0).forEach(x => { if (!x.cleared) x.fn(); });
  await h.tick();
  assert.equal(h.calls.length, 3);
  assert.deepEqual(h.calls[2].body.keys, ['movie:tmdb:2']);
});

test('a subscription made while stopped and hidden waits for the tab to show', async t => {
  const h = setup(t);
  const off = h.JE.arr.onStatusChange(['movie:tmdb:1'], () => {});
  await h.tick();
  await h.answer(0, { epoch: 'e1', cursor: 1, keys: [] });
  await h.tick();
  await h.answer(1, { error: true, code: 'feature_disabled' }, 403);
  off();
  h.setVisibility('hidden');
  h.JE.arr.onStatusChange(['movie:tmdb:2'], () => {});
  await h.settle();
  assert.equal(h.pending().length, 0);
  assert.equal(h.JE.arr.live.state().status, 'stopped');
  h.setVisibility('visible');
  await h.settle();
  const retry = h.pending();
  assert.equal(retry.length, 1);
  assert.ok(retry[0].delay > 290000 && retry[0].delay <= 300000);
  assert.equal(h.calls.length, 2);
});

test('more keys than a request carries: asks for everything and keeps only its own', async t => {
  const h = setup(t);
  const got = [];
  const many = Array.from({ length: 501 }, (_, i) => 'movie:tmdb:' + (i + 1));
  h.JE.arr.onStatusChange(many, keys => got.push(keys));
  await h.tick();
  await h.answer(0, { epoch: 'e1', cursor: 1, keys: [] });
  assert.equal(got.length, 1);   // the one re-read of a subscription made before the first position
  got.length = 0;
  await h.tick();
  assert.deepEqual(plain(h.calls[1].body), { epoch: 'e1', cursor: 1, keys: [], wait: 25 });
  await h.answer(1, { epoch: 'e1', cursor: 4, keys: ['movie:tmdb:501', 'movie:tmdb:9999', 'tv:tvdb:5'] });
  assert.deepEqual(plain(got), [['movie:tmdb:501']]);
  assert.equal(h.JE.arr.live.state().keys, 501);
});

test('a reset or a new epoch asks every subscriber to re-read everything', async t => {
  const h = setup(t);
  const got = [];
  h.JE.arr.onStatusChange(['movie:tmdb:1', 'movie:tmdb:2'], (keys, info) => got.push([keys, info.reset]), { since: { epoch: 'e1', cursor: 1 } });
  await h.tick();
  await h.answer(0, { epoch: 'e1', cursor: 1, keys: [] });
  await h.tick();
  await h.answer(1, { epoch: 'e1', cursor: 50, keys: [], reset: true });
  await h.tick();
  await h.answer(2, { epoch: 'e2', cursor: 3, keys: ['movie:tmdb:1'] });
  assert.deepEqual(plain(got), [[['movie:tmdb:1', 'movie:tmdb:2'], true], [['movie:tmdb:1', 'movie:tmdb:2'], true]]);
  assert.equal(h.JE.arr.live.state().epoch, 'e2');
});

test('a hidden tab holds no poll; becoming visible resumes at once with the same cursor', async t => {
  const h = setup(t);
  h.JE.arr.onStatusChange(['movie:tmdb:1'], () => {});
  await h.tick();
  await h.answer(0, { epoch: 'e1', cursor: 4, keys: [] });
  await h.tick();
  h.setVisibility('hidden');
  await h.settle();
  assert.equal(h.calls[1].aborted, true);
  assert.equal(h.pending().length, 0);
  h.setVisibility('visible');
  await h.tick();
  assert.equal(h.calls.length, 3);
  assert.equal(h.calls[2].body.cursor, 4);
});

test('a user switch drops the feed position and the subscriptions; seed only moves the cursor back', async t => {
  const h = setup(t);
  h.JE.arr.onStatusChange(['movie:tmdb:1'], () => {});
  await h.tick();
  await h.answer(0, { epoch: 'e1', cursor: 10, keys: [] });
  h.JE.arr.live.seed('e1', 12);
  assert.equal(h.JE.arr.live.state().cursor, 10);
  h.JE.arr.live.seed('other', 2);
  assert.equal(h.JE.arr.live.state().cursor, 10);
  h.JE.arr.live.seed('e1', 6);
  assert.equal(h.JE.arr.live.state().cursor, 6);
  await h.tick();
  assert.equal(h.calls.at(-1).body.cursor, 6);
  h.userHandlers.forEach(fn => fn({}));
  assert.deepEqual(plain(h.JE.arr.live.state()), { status: 'idle', epoch: null, cursor: null, subscriptions: 0, keys: 0, failures: 0 });
  // An answer for the previous user arriving late changes nothing.
  await h.answer(h.calls.length - 1, { epoch: 'e1', cursor: 99, keys: ['movie:tmdb:1'] });
  assert.equal(h.JE.arr.live.state().cursor, null);
  // A subscription may carry the position its data was read at.
  h.JE.arr.onStatusChange(['movie:tmdb:1'], () => {}, { since: { epoch: 'e1', cursor: 3 } });
  assert.equal(h.JE.arr.live.state().cursor, 3);
});

test('a subscription made without a known position re-reads once when the tab has one, and only once', async t => {
  const h = setup(t);
  const got = [];
  // A surface whose read had no position (its caller says so with since: null) while the tab has none yet.
  h.JE.arr.onStatusChange(['movie:tmdb:1'], (keys, info) => got.push(['a', keys, info.reset]), { since: null });
  await h.settle();
  assert.deepEqual(got, [], 'nothing to anchor on yet');
  await h.tick();
  await h.answer(0, { epoch: 'e1', cursor: 5, keys: [] });
  assert.deepEqual(plain(got), [['a', ['movie:tmdb:1'], true]]);
  // Later answers deliver changes only.
  await h.tick();
  await h.answer(1, { epoch: 'e1', cursor: 6, keys: [] });
  assert.equal(got.length, 1);

  // since: null while the tab has a position (its read went ahead without one, e.g. a slow
  // bootstrap): called back at once, so it re-reads from the position the tab has now.
  h.JE.arr.onStatusChange(['movie:tmdb:2'], (keys, info) => got.push(['b', keys, info.reset]), { since: null });
  await h.settle();
  assert.deepEqual(plain(got.slice(1)), [['b', ['movie:tmdb:2'], true]]);
  // A subscription with a position, or without `since` once the tab has one, is not called back.
  h.JE.arr.onStatusChange(['movie:tmdb:3'], () => got.push(['c']), { since: { epoch: 'e1', cursor: 6 } });
  h.JE.arr.onStatusChange(['movie:tmdb:4'], () => got.push(['d']));
  await h.settle();
  assert.equal(got.length, 2);
});
