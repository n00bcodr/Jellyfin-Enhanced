// Requests & downloads, phase 1: the status surfaces (details pill, poster badges) wired to the
// change feed. The real arr-live.js and status modules run together: a feed answer re-renders the
// surface in place, and a status read never misses a change made after it (the feed position is
// taken before the read and handed to the subscription).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHarness, deferred, jsRoot, jsonResponse } from '../helpers/harness.mjs';

const en = JSON.parse(readFileSync(resolve(jsRoot, 'locales/en.json'), 'utf8'));
const MODULES = ['arr/live/arr-live.js', 'arr/status/status-core.js', 'arr/status/status-episodes.js', 'arr/status/status-details.js', 'arr/status/status-cards.js', 'arr/status/status-styles.js'];
const detailsHtml = '<div id="itemDetailPage" class="page libraryPage"><div class="detailPagePrimaryContent"><div class="detailSection"><form class="trackSelections"></form></div></div></div>';

function translate(key, params) {
  const text = en[key];
  if (text === undefined) throw new Error(`missing en.json key ${key}`);
  return Object.entries(params || {}).reduce((s, [k, v]) => s.split(`{${k}}`).join(String(v)), text);
}

function setup(t, { html = '', hash = '#/home', responses = () => null } = {}) {
  const timers = [];
  const feed = [];       // POST acquire/changes calls
  const statusCalls = []; // GET acquire/status calls
  const observers = [];
  const fetch = (url, init) => {
    const call = { url, body: JSON.parse(init.body || '{}'), reply: deferred(), aborted: false };
    feed.push(call);
    init.signal?.addEventListener('abort', () => {
      call.aborted = true;
      call.reply.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    });
    return call.reply.promise;
  };
  const h = createHarness({
    html,
    url: `http://jellyfin.test/web/index.html${hash}`,
    fetch,
    globals: {
      setTimeout: (fn, delay) => { const timer = { fn, delay, cleared: false }; timers.push(timer); return timer; },
      clearTimeout: timer => { if (timer) timer.cleared = true; },
      IntersectionObserver: class {
        constructor(fn) { this.fn = fn; this.observed = new Set(); observers.push(this); }
        observe(el) { this.observed.add(el); }
        unobserve(el) { this.observed.delete(el); }
        disconnect() { this.observed.clear(); }
      }
    },
    JE: {
      pluginConfig: { ArrStatusEnabled: true, ArrStatusPosterBadges: true },
      t: translate,
      helpers: {
        debounce: fn => fn,
        addCSS: () => {},
        onBodyMutation: () => ({ unsubscribe() {} })
      },
      core: {
        api: {
          authHeaders: () => ({ Authorization: 'MediaBrowser Token="test-token"' }),
          plugin: async path => { statusCalls.push(path); return responses(path, statusCalls.length); }
        },
        navigation: { onNavigate: () => () => {}, onViewPage: () => () => {} },
        lifecycle: { register: () => ({ track: x => x }) }
      },
      session: { getEpoch: () => 0, isCurrent: () => true, onUserChange: () => {} }
    }
  });
  Object.defineProperty(h.document, 'visibilityState', { configurable: true, get: () => 'visible' });
  h.window.Math.random = () => 0.5;
  for (const m of MODULES) h.load(m);
  t.after(() => h.close());
  const settle = async () => { for (let i = 0; i < 6; i++) await new Promise(done => setImmediate(done)); };
  return {
    ...h, feed, statusCalls, observers, settle,
    /** Runs the pending timers that are due within `max` ms (long ones such as request timeouts stay). */
    async tick(max = 1000) {
      const due = timers.filter(x => !x.cleared && x.delay <= max);
      for (const x of due) { timers.splice(timers.indexOf(x), 1); x.fn(); }
      await settle();
      return due.length;
    },
    async answer(call, data) { call.reply.resolve(jsonResponse(data)); await settle(); },
    /** The newest feed call that is still open. */
    open: () => [...feed].reverse().find(c => !c.aborted && !c.done)
  };
}

test('the details pill follows the change feed in place, and its first read waits for a feed position', async t => {
  let percent = 42;
  const h = setup(t, {
    html: detailsHtml, hash: '#/details?id=movie1',
    responses: path => path.startsWith('/acquire/status/item/movie1')
      ? { contact: 'Dad', items: [{ key: 'movie:tmdb:1', kind: 'movie', stage: 'downloading', reason: { code: 'downloading' }, progress: { percent } }] }
      : null
  });
  const updating = h.JE.internals.arrStatusDetails.update(false);
  await h.settle();
  // No position yet: one bootstrap call before the status read.
  assert.equal(h.feed.length, 1);
  assert.deepEqual({ ...h.feed[0].body }, {});
  assert.equal(h.statusCalls.length, 0, 'the status read waits for the feed position');
  await h.answer(h.feed[0], { epoch: 'e1', cursor: 5, keys: [], reset: false });
  h.feed[0].done = true;
  await updating;
  const section = h.document.querySelector('.detailSection');
  assert.match(section.textContent, /Downloading · 42%/);
  assert.equal(h.statusCalls.length, 1);

  // The subscription long-polls from the position taken before the read.
  await h.tick();
  const poll = h.open();
  assert.deepEqual({ ...poll.body, keys: [...poll.body.keys] }, { epoch: 'e1', cursor: 5, keys: ['movie:tmdb:1'], wait: 25 });

  // Sonarr/Radarr moved the download on: the feed answers, the pill re-renders in place.
  percent = 90;
  await h.answer(poll, { epoch: 'e1', cursor: 9, keys: ['movie:tmdb:1'], reset: false });
  poll.done = true;
  await h.settle();
  assert.equal(h.statusCalls.length, 2, 'one re-read for the change');
  assert.equal(h.document.querySelectorAll('.je-arr-status').length, 1, 'replaced, not added');
  assert.match(section.textContent, /Downloading · 90%/);
  assert.equal(h.feed.filter(c => Object.keys(c.body).length === 0).length, 1, 'no second bootstrap');

  // ... and keeps following from the new position.
  await h.tick();
  const next = h.open();
  assert.equal(next.body.cursor, 9);
  assert.deepEqual([...next.body.keys], ['movie:tmdb:1']);
});

test('a status read never misses a change made after it, even while another poll moves the position on', async t => {
  const h = setup(t, {
    html: detailsHtml, hash: '#/details?id=movie1',
    responses: path => path.startsWith('/acquire/status/item/movie1')
      ? { items: [{ key: 'movie:tmdb:1', kind: 'movie', stage: 'looking', reason: { code: 'looking' } }] }
      : null
  });
  // Another surface already follows a title: the feed has a position and a poll open.
  h.JE.arr.live.seed('e1', 5);
  h.JE.arr.onStatusChange(['movie:tmdb:2'], () => {});
  await h.tick();
  const other = h.open();
  assert.equal(other.body.cursor, 5);

  // The details read starts at position 5 ...
  let release;
  const gate = new Promise(done => { release = done; });
  h.JE.core.api.plugin = async path => { h.statusCalls.push(path); await gate; return { items: [{ key: 'movie:tmdb:1', kind: 'movie', stage: 'looking', reason: { code: 'looking' } }] }; };
  const updating = h.JE.internals.arrStatusDetails.update(false);
  await h.settle();
  // ... while the other poll answers past a change of movie:tmdb:1 it did not ask about.
  await h.answer(other, { epoch: 'e1', cursor: 12, keys: [], reset: false });
  other.done = true;
  release();
  await updating;
  await h.tick();
  // The details subscription moved the position back to before its read.
  const poll = h.open();
  assert.equal(poll.body.cursor, 5);
  assert.deepEqual([...poll.body.keys].sort(), ['movie:tmdb:1', 'movie:tmdb:2']);
});

test('a first feed answer never moves past a position set meanwhile', async t => {
  const h = setup(t);
  h.JE.arr.onStatusChange(['movie:tmdb:1'], () => {});
  await h.tick();
  const bootstrap = h.open();
  assert.deepEqual({ ...bootstrap.body }, {});
  // A status surface primes the feed meanwhile (its read starts from that position).
  const priming = h.JE.arr.live.prime();
  await h.settle();
  const prime = h.feed[h.feed.length - 1];
  assert.notEqual(prime, bootstrap);
  await h.answer(prime, { epoch: 'e1', cursor: 3, keys: [], reset: false });
  prime.done = true;
  assert.equal((await priming).cursor, 3);
  // The bootstrap answer comes later, from further on: the earlier position stands.
  await h.answer(bootstrap, { epoch: 'e1', cursor: 8, keys: [], reset: false });
  bootstrap.done = true;
  assert.equal(h.JE.arr.live.position().cursor, 3);
  const calls = h.feed.length;
  assert.equal((await h.JE.arr.live.prime()).cursor, 3);
  assert.equal(h.feed.length, calls, 'prime does not ask again when a position is known');
});

test('poster badges re-fetch the cards of a title the feed reports, from the position before their read', async t => {
  const id = '0'.repeat(32);
  let stage = 'downloading';
  const h = setup(t, {
    html: `<div class="card" data-id="${id}" data-type="Series"><div class="cardBox"><div class="cardScalable"><div class="cardImageContainer"></div></div></div></div>`,
    responses: () => ({ items: [{ itemId: id, key: 'tv:tvdb:7', kind: 'series', stage, reason: { code: stage === 'downloading' ? 'downloading' : 'importing' }, progress: stage === 'downloading' ? { percent: 10 } : null }] })
  });
  // Something else on the page follows another title: a poll is open at position 20.
  h.JE.arr.live.seed('e1', 20);
  h.JE.arr.onStatusChange(['movie:tmdb:2'], () => {});
  await h.tick();
  const other = h.open();
  assert.equal(other.body.cursor, 20);
  h.JE.initializeArrStatus();
  h.JE.internals.arrStatusCards.scan();
  const io = h.observers[0];
  io.fn([...io.observed].map(target => ({ isIntersecting: true, target })));
  // The cards' read starts at 20; the other poll answers past 20 before the cards subscribe.
  const plugin = h.JE.core.api.plugin;
  let release;
  const gate = new Promise(done => { release = done; });
  h.JE.core.api.plugin = async path => { await gate; return plugin(path); };
  const flushing = h.JE.internals.arrStatusCards.flush();
  await h.settle();
  await h.answer(other, { epoch: 'e1', cursor: 31, keys: [], reset: false });
  other.done = true;
  release();
  await flushing;
  h.JE.core.api.plugin = plugin;
  await h.tick();
  const card = h.document.querySelector('.card');
  assert.equal(card.querySelector('.je-arr-ring-text').textContent, '10');
  const poll = h.open();
  assert.equal(poll.body.cursor, 20, 'the cards follow from before their read');
  assert.deepEqual([...poll.body.keys].sort(), ['movie:tmdb:2', 'tv:tvdb:7']);

  // An episode of the series was imported: the feed reports the series key.
  stage = 'almostReady';
  await h.answer(poll, { epoch: 'e1', cursor: 33, keys: ['tv:tvdb:7'], reset: false });
  poll.done = true;
  await h.tick(400);   // the cards' coalescing delay
  await h.JE.internals.arrStatusCards.flush();
  assert.equal(h.statusCalls.length, 2);
  assert.equal(card.querySelector('.je-arr-badge .material-icons').textContent, 'hourglass_bottom');
});

test('a season page re-renders when Jellyfin announces a new episode under its series', async t => {
  let ready = 1;
  const h = setup(t, {
    html: detailsHtml, hash: '#/details?id=season1',
    responses: path => path.startsWith('/acquire/status/item/season1')
      // Still on its way after the announcement (D95: a season that is all ready shows nothing at all).
      ? { items: [{ key: 'tv:tvdb:7:s1', kind: 'season', stage: 'almostReady', reason: { code: 'library_pending' }, summary: { aired: 3, ready, almostReady: 3 - ready, missing: 0 } }] }
      : null
  });
  // The season's ready count shows the re-render (D92: an opt-in setting).
  h.JE.pluginConfig.ArrStatusSeasonSummaryEnabled = true;
  h.JE.arr.live.seed('e1', 40);
  await h.JE.internals.arrStatusDetails.update(false);
  await h.tick();
  const poll = h.open();
  assert.deepEqual([...poll.body.keys].sort(), ['tv:tvdb:7', 'tv:tvdb:7:s1']);
  const section = h.document.querySelector('.detailSection');
  const before = section.textContent;
  ready = 2;
  await h.answer(poll, { epoch: 'e1', cursor: 41, keys: ['tv:tvdb:7'], reset: false });
  poll.done = true;
  await h.settle();
  assert.equal(h.statusCalls.length, 2, 'the series-only announcement re-reads the season');
  assert.notEqual(section.textContent, before);
  assert.equal(h.document.querySelectorAll('.je-arr-status').length, 1);
});

// ---------------------------------------------------------------- review round (combined 1a+1b)

const moviePill = (percent, extra = {}) => ({ items: [{ key: 'movie:tmdb:1', kind: 'movie', stage: 'downloading', reason: { code: 'downloading' }, progress: { percent }, ...extra }] });

test('a read that went ahead without a feed position (bootstrap failed) re-reads once the tab has one', async t => {
  let percent = 10;
  const h = setup(t, { html: detailsHtml, hash: '#/details?id=movie1', responses: path => path.startsWith('/acquire/status/item/movie1') ? moviePill(percent) : null });
  const updating = h.JE.internals.arrStatusDetails.update(false);
  await h.settle();
  // The bootstrap fails (a proxy 502): the read goes ahead without a position.
  h.feed[0].reply.resolve(new Response('{}', { status: 502 }));
  h.feed[0].done = true;
  await updating;
  const section = h.document.querySelector('.detailSection');
  assert.match(section.textContent, /Downloading · 10%/);
  assert.equal(h.statusCalls.length, 1);
  // The subscription's first poll bootstraps; a change happened in between (a grab moved it on).
  await h.tick();
  const boot = h.open();
  assert.deepEqual({ ...boot.body }, {});
  percent = 20;
  await h.answer(boot, { epoch: 'e1', cursor: 7, keys: [], reset: false });
  boot.done = true;
  await h.settle();
  assert.equal(h.statusCalls.length, 2, 'one re-read from the first position');
  assert.match(section.textContent, /Downloading · 20%/);
  await h.tick();
  const poll = h.open();
  assert.equal(poll.body.cursor, 7);
  assert.deepEqual([...poll.body.keys], ['movie:tmdb:1']);
});

test('a read that lost the race with a slow bootstrap re-reads once the bootstrap answers', async t => {
  let percent = 10;
  const h = setup(t, { html: detailsHtml, hash: '#/details?id=movie1', responses: path => path.startsWith('/acquire/status/item/movie1') ? moviePill(percent) : null });
  const updating = h.JE.internals.arrStatusDetails.update(false);
  await h.settle();
  const prime = h.feed[0];
  await h.tick(1500);   // the 1.5 s wait for the bootstrap runs out: the read goes ahead
  await updating;
  assert.equal(h.statusCalls.length, 1);
  // The bootstrap answers later, from a position after a change the read did not see.
  percent = 30;
  await h.answer(prime, { epoch: 'e1', cursor: 12, keys: [], reset: false });
  prime.done = true;
  await h.settle();
  assert.equal(h.statusCalls.length, 2);
  assert.match(h.document.querySelector('.detailSection').textContent, /Downloading · 30%/);
});

test('a failed live re-read keeps the page following its title (and asks again), an empty answer clears it', async t => {
  let percent = 42;
  let mode = 'ok';
  const h = setup(t, {
    html: detailsHtml, hash: '#/details?id=movie1',
    responses: path => !path.startsWith('/acquire/status/item/movie1') ? null : mode === 'fail' ? null : mode === 'empty' ? { items: [] } : moviePill(percent)
  });
  h.JE.arr.live.seed('e1', 5);
  await h.JE.internals.arrStatusDetails.update(false);
  await h.tick();
  const section = h.document.querySelector('.detailSection');
  let poll = h.open();
  // A change is reported and its re-read fails (502, dropped connection): what is shown stays, and so does the subscription.
  mode = 'fail';
  await h.answer(poll, { epoch: 'e1', cursor: 9, keys: ['movie:tmdb:1'], reset: false });
  poll.done = true;
  await h.settle();
  assert.equal(h.statusCalls.length, 2);
  assert.match(section.textContent, /Downloading · 42%/);
  await h.tick();
  poll = h.open();
  assert.equal(poll.body.cursor, 9);
  assert.deepEqual([...poll.body.keys], ['movie:tmdb:1']);
  // It asks again after a pause ...
  mode = 'ok';
  percent = 60;
  await h.tick(5000);
  assert.equal(h.statusCalls.length, 3);
  assert.match(section.textContent, /Downloading · 60%/);
  // ... and keeps following: the next change re-renders in place.
  percent = 90;
  poll = h.open();
  await h.answer(poll, { epoch: 'e1', cursor: 12, keys: ['movie:tmdb:1'], reset: false });
  poll.done = true;
  await h.settle();
  assert.match(section.textContent, /Downloading · 90%/);
  assert.equal(h.document.querySelectorAll('.je-arr-status').length, 1);
  // A successful answer with nothing to show (the title left the arr): the old pill goes.
  mode = 'empty';
  await h.tick();
  poll = h.open();
  await h.answer(poll, { epoch: 'e1', cursor: 14, keys: ['movie:tmdb:1'], reset: false });
  poll.done = true;
  await h.settle();
  assert.equal(h.document.querySelectorAll('.je-arr-status').length, 0);
});

test('a failed first read asks again after growing pauses instead of leaving the page quiet; view events add no requests', async t => {
  let mode = 'fail';
  const h = setup(t, {
    html: detailsHtml, hash: '#/details?id=movie1',
    responses: path => !path.startsWith('/acquire/status/item/movie1') ? null : mode === 'fail' ? null : moviePill(42)
  });
  h.JE.arr.live.seed('e1', 5);
  // The first read fails (a dropped connection, a 5xx): nothing drawn, and view events meanwhile don't ask again.
  await h.JE.internals.arrStatusDetails.update(false);
  await h.JE.internals.arrStatusDetails.update(false);
  assert.equal(h.statusCalls.length, 1);
  assert.equal(h.document.querySelectorAll('.je-arr-status').length, 0);
  // It asks again after 5 s; failing again, the next pause is longer (15 s).
  await h.tick(5000);
  assert.equal(h.statusCalls.length, 2);
  await h.tick(5000);
  assert.equal(h.statusCalls.length, 2);
  mode = 'ok';
  await h.tick(15000);
  assert.equal(h.statusCalls.length, 3);
  const section = h.document.querySelector('.detailSection');
  assert.match(section.textContent, /Downloading · 42%/);
  // From then on the page follows its title like any other.
  await h.tick();
  const poll = h.open();
  assert.deepEqual([...poll.body.keys], ['movie:tmdb:1']);
});

test('a title Jellyfin knows by another id follows the key the feed announces it under', async t => {
  let percent = 10;
  const h = setup(t, { html: detailsHtml, hash: '#/details?id=movie1', responses: path => path.startsWith('/acquire/status/item/movie1') ? { items: [{ ...moviePill(percent).items[0], key: 'movie:imdb:tt1', liveKey: 'movie:tmdb:1' }] } : null });
  h.JE.arr.live.seed('e1', 5);
  await h.JE.internals.arrStatusDetails.update(false);
  await h.tick();
  const poll = h.open();
  assert.deepEqual([...poll.body.keys], ['movie:tmdb:1']);
  percent = 50;
  await h.answer(poll, { epoch: 'e1', cursor: 6, keys: ['movie:tmdb:1'], reset: false });
  poll.done = true;
  await h.settle();
  assert.match(h.document.querySelector('.detailSection').textContent, /Downloading · 50%/);
});

test('poster badges follow the feed key of a title known by another id, and a failed re-fetch is asked again', async t => {
  const id = '0'.repeat(32);
  let stage = 'downloading';
  let fail = false;
  const h = setup(t, {
    html: `<div class="card" data-id="${id}" data-type="Series"><div class="cardBox"><div class="cardScalable"><div class="cardImageContainer"></div></div></div></div>`,
    responses: () => fail ? null : ({ items: [{ itemId: id, key: 'tv:tmdb:70', liveKey: 'tv:tvdb:7', kind: 'series', stage, reason: { code: stage === 'downloading' ? 'downloading' : 'importing' }, progress: stage === 'downloading' ? { percent: 10 } : null }] })
  });
  h.JE.arr.live.seed('e1', 20);
  h.JE.initializeArrStatus();
  h.JE.internals.arrStatusCards.scan();
  const io = h.observers[0];
  io.fn([...io.observed].map(target => ({ isIntersecting: true, target })));
  await h.JE.internals.arrStatusCards.flush();
  await h.tick();
  const card = h.document.querySelector('.card');
  assert.equal(card.querySelector('.je-arr-ring-text').textContent, '10');
  let poll = h.open();
  assert.ok(poll.body.keys.includes('tv:tvdb:7'));
  // The feed reports the change; the re-fetch fails ...
  fail = true;
  stage = 'almostReady';
  await h.answer(poll, { epoch: 'e1', cursor: 21, keys: ['tv:tvdb:7'], reset: false });
  poll.done = true;
  await h.tick(400);
  await h.JE.internals.arrStatusCards.flush();
  assert.equal(h.statusCalls.length, 2);
  assert.equal(card.querySelector('.je-arr-ring-text').textContent, '10');
  // ... and is asked again after a pause.
  fail = false;
  await h.tick(5000);
  await h.tick(400);
  await h.JE.internals.arrStatusCards.flush();
  assert.equal(h.statusCalls.length, 3);
  assert.equal(card.querySelector('.je-arr-badge .material-icons').textContent, 'hourglass_bottom');
});

test('a read that lost the race with a bootstrap that answers during the read re-reads at once', async t => {
  let percent = 10;
  const h = setup(t, { html: detailsHtml, hash: '#/details?id=movie1', responses: path => path.startsWith('/acquire/status/item/movie1') ? moviePill(percent) : null });
  let release;
  const gate = new Promise(done => { release = done; });
  const plugin = h.JE.core.api.plugin;
  h.JE.core.api.plugin = async path => { const out = plugin(path); await gate; return out; };
  const updating = h.JE.internals.arrStatusDetails.update(false);
  await h.settle();
  const prime = h.feed[0];
  await h.tick(1500);   // the read goes ahead without a position ...
  await h.answer(prime, { epoch: 'e1', cursor: 12, keys: [], reset: false });   // ... and the tab gets one while it runs
  prime.done = true;
  h.JE.core.api.plugin = plugin;
  percent = 30;
  release();
  await updating;
  await h.settle();
  assert.equal(h.statusCalls.length, 2, 'the answer read without a position is read again from the tab position');
  assert.match(h.document.querySelector('.detailSection').textContent, /Downloading · 30%/);
});

test('poster badges read without a feed position are asked again once the tab has one', async t => {
  const id = '0'.repeat(32);
  let percent = 10;
  const h = setup(t, {
    html: `<div class="card" data-id="${id}" data-type="Movie"><div class="cardBox"><div class="cardScalable"><div class="cardImageContainer"></div></div></div></div>`,
    responses: () => ({ items: [{ itemId: id, key: 'movie:tmdb:1', kind: 'movie', stage: 'downloading', reason: { code: 'downloading' }, progress: { percent } }] })
  });
  h.JE.initializeArrStatus();
  h.JE.internals.arrStatusCards.scan();
  const io = h.observers[0];
  io.fn([...io.observed].map(target => ({ isIntersecting: true, target })));
  const flushing = h.JE.internals.arrStatusCards.flush();
  await h.settle();
  h.feed[0].reply.resolve(new Response('{}', { status: 502 }));   // the bootstrap fails
  h.feed[0].done = true;
  await flushing;
  const card = h.document.querySelector('.card');
  assert.equal(card.querySelector('.je-arr-ring-text').textContent, '10');
  await h.tick();
  const boot = h.open();
  assert.deepEqual({ ...boot.body }, {});
  percent = 55;
  await h.answer(boot, { epoch: 'e1', cursor: 4, keys: [], reset: false });
  boot.done = true;
  await h.tick(400);
  await h.JE.internals.arrStatusCards.flush();
  assert.equal(h.statusCalls.length, 2);
  assert.equal(card.querySelector('.je-arr-ring-text').textContent, '55');
});

test('poster badges read while a slow bootstrap answered are asked again from the tab position', async t => {
  const id = '0'.repeat(32);
  let percent = 10;
  const h = setup(t, {
    html: `<div class="card" data-id="${id}" data-type="Movie"><div class="cardBox"><div class="cardScalable"><div class="cardImageContainer"></div></div></div></div>`,
    responses: () => ({ items: [{ itemId: id, key: 'movie:tmdb:1', kind: 'movie', stage: 'downloading', reason: { code: 'downloading' }, progress: { percent } }] })
  });
  h.JE.initializeArrStatus();
  h.JE.internals.arrStatusCards.scan();
  const io = h.observers[0];
  io.fn([...io.observed].map(target => ({ isIntersecting: true, target })));
  let release;
  const gate = new Promise(done => { release = done; });
  const plugin = h.JE.core.api.plugin;
  h.JE.core.api.plugin = async path => { const out = plugin(path); await gate; return out; };
  const flushing = h.JE.internals.arrStatusCards.flush();
  await h.settle();
  const prime = h.feed[0];
  await h.tick(1500);   // the cards' read goes ahead without a position ...
  await h.answer(prime, { epoch: 'e1', cursor: 4, keys: [], reset: false });   // ... and the tab gets one meanwhile
  prime.done = true;
  h.JE.core.api.plugin = plugin;
  percent = 55;
  release();
  await flushing;
  await h.settle();
  await h.tick(400);
  await h.JE.internals.arrStatusCards.flush();
  assert.equal(h.statusCalls.length, 2);
  assert.equal(h.document.querySelector('.card .je-arr-ring-text').textContent, '55');
});

// D46 r16: the details page's re-read retry belongs to the session whose read failed.
test('a details-page status retry is never sent after another account signs in', async t => {
  let mode = 'ok';
  const h = setup(t, {
    html: detailsHtml, hash: '#/details?id=movie1',
    responses: path => !path.startsWith('/acquire/status/item/movie1') ? null : mode === 'fail' ? null : moviePill(42)
  });
  h.JE.arr.live.seed('e1', 5);
  await h.JE.internals.arrStatusDetails.update(false);
  await h.tick();
  const poll = h.open();
  mode = 'fail';
  await h.answer(poll, { epoch: 'e1', cursor: 9, keys: ['movie:tmdb:1'], reset: false });
  poll.done = true;
  await h.settle();
  assert.equal(h.statusCalls.length, 2);
  h.window.ApiClient.getCurrentUserId = () => 'fedcba9876543210fedcba9876543210';
  mode = 'ok';
  await h.tick(5000);
  assert.equal(h.statusCalls.length, 2, 'the retry is not sent for the new account');
});
