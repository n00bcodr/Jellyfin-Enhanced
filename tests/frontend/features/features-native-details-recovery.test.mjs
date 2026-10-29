import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, deferred } from '../helpers/harness.mjs';

// Absent-title pages: artwork and season/episode lists the server couldn't give right now (503/429 + Retry-After) are
// asked for again, bounded, and drawn without navigating away (js/jellyseerr/nativedetails/native-recovery.js).

const SERVER = '0202511b0eac4284ab045b3ba556d72e';
const MOVIE = '4a45ad11000a938e00000000f9c67720';
const SEASON = '4a45ad13000001c8000100008fbea52d';
const SERIES = '4a45ad12000001c800000000528c1e65';
const art = (id, tag = 'na1.aa.bb', type = 'Primary') => `http://jellyfin.test/Items/${id}/Images/${type}?fillHeight=480&quality=96&tag=${tag}`;
/** Moves the page's hash and waits for its hashchange (jsdom delivers it as its own task). */
const hashTo = (h, hash) => new Promise(resolve => { h.window.addEventListener('hashchange', () => resolve(flush()), { once: true }); h.window.location.hash = hash; });
const flush = async () => { for (let i = 0; i < 30; i++) await new Promise(r => setImmediate(r)); };

/** A controllable clock for native-recovery's env (no jitter). */
function fakeClock() {
  let now = 1_000_000;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout: (fn, ms) => { const id = ++seq; timers.set(id, { at: now + ms, fn }); return id; },
    clearTimeout: id => { timers.delete(id); },
    random: () => 0,
    pending: () => timers.size,
    /** Runs every timer due within `ms`, in order, letting the work each one starts settle. */
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        const due = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
        await flush();
      }
      now = end;
      await flush();
    }
  };
}

/** An Image whose loads succeed unless `fails(url)` says so; every load is recorded. */
function fakeImages(fails = () => false) {
  const loads = [];
  class FakeImage {
    set src(value) {
      this._src = value;
      loads.push(value);
      queueMicrotask(() => { const f = fails(value); if (f === 'hang') return; (f ? this.onerror?.() : this.onload?.()); });
    }
    get src() { return this._src; }
  }
  return { FakeImage, loads };
}

const answer = (status, headers = {}) => new Response(status === 200 ? 'img' : null, { status, headers });

/**
 * The recovery module alone in a fresh realm, with a page of lazily loaded artwork.
 * @returns {object} Harness and probes.
 */
function setup(t, { urls = [art(MOVIE)], respond, fails, getItem } = {}) {
  const calls = [];
  const images = fakeImages(fails);
  const html = `<div id="page">${urls.map(u => `<div class="cardImageContainer lazy lazy-hidden" data-src="${u}"></div>`).join('')}<div class="cardImageContainer noArt"></div></div>`;
  const h = createHarness({
    html,
    fetch: (url, init) => { calls.push({ url: String(url), init }); return respond(String(url), init, calls.length); },
    globals: { Image: images.FakeImage }
  });
  t.after(() => h.close());
  h.load('jellyseerr/nativedetails/native-recovery.js');
  const R = h.JE.internals.nativeRecovery;
  const clock = fakeClock();
  Object.assign(R.env, clock);
  const page = h.document.getElementById('page');
  const shown = [];
  const state = { live: true };
  const recovery = R.images({ page: () => (state.live ? page : null), live: () => state.live, onShown: (node, url) => shown.push(url), getItem });
  return { ...h, R, clock, page, calls, images, shown, state, recovery, nodes: () => [...page.querySelectorAll('.lazy')] };
}

test('a temporary artwork refusal is asked again no sooner than its Retry-After and the image appears', async t => {
  const url = art(MOVIE);
  const h = setup(t, { respond: (u, i, n) => (n === 1 ? answer(503, { 'Retry-After': '3', 'X-JE-Art': 'viewer-busy' }) : answer(200)) });
  h.recovery.failed(url, 503);
  // The first failure named no wait (resource timing has no headers): the server's own two seconds.
  await h.clock.advance(1999);
  assert.equal(h.calls.length, 0, 'no ask before the server said');
  await h.clock.advance(1);
  assert.equal(h.calls.length, 1);
  assert.match(h.calls[0].url, /_jer=\d+/);
  assert.equal(h.calls[0].init.cache, 'no-store');
  // The ask's own answer said three seconds.
  await h.clock.advance(2999);
  assert.equal(h.calls.length, 1, 'Retry-After honoured');
  await h.clock.advance(1);
  assert.equal(h.calls.length, 2);
  const [node] = h.nodes();
  assert.equal(node.hasAttribute('data-src'), false);
  assert.equal(node.classList.contains('lazy-hidden'), false);
  assert.match(node.style.backgroundImage, /\/Items\/4a45ad11000a938e00000000f9c67720\/Images\/Primary\?.*_jer=\d+/);
  assert.equal(h.shown.length, 1);
  assert.equal(h.recovery.size(), 0);
  // The card with no artwork stays a placeholder: nothing asks for it.
  assert.equal(h.page.querySelector('.noArt').style.backgroundImage, '');
});

test('artwork that stays refused is asked a bounded number of times and stays a placeholder', async t => {
  const h = setup(t, { respond: () => answer(503, { 'Retry-After': '2' }) });
  h.recovery.failed(art(MOVIE), 503);
  await h.clock.advance(10 * 60_000);
  assert.ok(h.calls.length >= 2 && h.calls.length <= h.R.limits.MAX_ATTEMPTS, `asks: ${h.calls.length}`);
  assert.equal(h.recovery.size(), 0);
  assert.equal(h.clock.pending(), 0);
  const [node] = h.nodes();
  assert.ok(node.classList.contains('lazy-hidden') && node.hasAttribute('data-src'));
  assert.equal(h.images.loads.length, 0);
});

test('a refused or missing image (404) ends after one ask; no retry', async t => {
  const h = setup(t, { respond: () => answer(404) });
  h.recovery.failed(art(MOVIE), 404);
  await h.clock.advance(0);
  assert.equal(h.calls.length, 1);
  await h.clock.advance(120_000);
  assert.equal(h.calls.length, 1);
  assert.equal(h.recovery.size(), 0);
  assert.ok(h.nodes()[0].hasAttribute('data-src'));
  // A final status other than 404 isn't asked at all; nor is an image nothing on the page waits for.
  h.recovery.failed(art(MOVIE), 400);
  h.recovery.failed(art(SEASON), 503);
  await h.clock.advance(120_000);
  assert.equal(h.calls.length, 1);
});

test('a stale grant re-reads the item once for its current grant, then loads that', async t => {
  const url = art(MOVIE, 'na1.old.sig');
  const reads = [];
  const h = setup(t, {
    urls: [url],
    respond: u => (u.includes('na1.old.sig') ? answer(404, { 'X-JE-Art': 'stale-grant' }) : answer(200)),
    getItem: async id => { reads.push(id); return { ImageTags: { Primary: 'na1.new.sig' } }; }
  });
  h.recovery.failed(url, 404);
  await h.clock.advance(0);
  assert.deepEqual(reads, [MOVIE]);
  assert.equal(h.calls.length, 2);
  assert.match(h.calls[1].url, /tag=na1\.new\.sig/);
  const [node] = h.nodes();
  assert.equal(node.hasAttribute('data-src'), false);
  assert.match(node.style.backgroundImage, /na1\.new\.sig/);
});

test('a grant still stale after its one re-read is not repaired again', async t => {
  const url = art(MOVIE, 'na1.old.sig');
  const reads = [];
  const h = setup(t, {
    urls: [url],
    respond: () => answer(404, { 'X-JE-Art': 'stale-grant' }),
    getItem: async () => { reads.push(1); return { ImageTags: { Primary: 'na1.new.sig' } }; }
  });
  h.recovery.failed(url, 404);
  await h.clock.advance(0);
  await h.clock.advance(120_000);
  assert.equal(reads.length, 1);
  assert.equal(h.calls.length, 2);
  assert.ok(h.nodes()[0].hasAttribute('data-src'), 'still a placeholder');
});

test('recovery asks for at most three images at once (below the server\'s eight per viewer)', async t => {
  const urls = [1, 2, 3, 4, 5, 6].map(n => art(MOVIE, `na1.${n}.x`));
  const gates = [];
  let open = 0;
  let most = 0;
  const h = setup(t, {
    urls,
    respond: async () => { open++; most = Math.max(most, open); const d = deferred(); gates.push(d); await d.promise; open--; return answer(200); }
  });
  for (const u of urls) h.recovery.failed(u, 503);
  await h.clock.advance(2000);
  assert.equal(h.calls.length, 3);
  while (gates.length) { gates.shift().resolve(); await flush(); }
  await flush();
  assert.equal(h.calls.length, 6);
  assert.equal(most, 3);
  assert.equal(h.nodes().filter(n => n.hasAttribute('data-src')).length, 0);
});

test('ending the page aborts the ask in flight and draws nothing it answers', async t => {
  const gate = deferred();
  let signal;
  const h = setup(t, { respond: async (u, init) => { signal = init.signal; await gate.promise; return answer(200); } });
  h.recovery.failed(art(MOVIE), 503);
  h.recovery.failed(art(MOVIE, 'na1.other'), 503);
  await h.clock.advance(2000);
  assert.equal(h.calls.length, 1, 'the second image has no waiting element');
  h.recovery.dispose();
  assert.equal(signal.aborted, true);
  gate.resolve();
  await h.clock.advance(120_000);
  assert.equal(h.calls.length, 1);
  assert.equal(h.images.loads.length, 0);
  assert.ok(h.nodes()[0].hasAttribute('data-src'));
});

test('a policy change before the answer arrives: nothing is asked or drawn for the old page', async t => {
  const gate = deferred();
  const h = setup(t, { urls: [art(MOVIE), art(MOVIE, 'na1.b')], respond: async () => { await gate.promise; return answer(200); } });
  h.recovery.failed(art(MOVIE), 503);
  await h.clock.advance(2000);
  h.recovery.failed(art(MOVIE, 'na1.b'), 503);
  h.state.live = false;
  gate.resolve();
  await h.clock.advance(120_000);
  assert.equal(h.calls.length, 1, 'the second image is never asked for');
  assert.equal(h.images.loads.length, 0);
  assert.equal(h.nodes().filter(n => n.hasAttribute('data-src')).length, 2);
});

test('where statuses are not reported, an image still hidden after the watchdog is asked again', async t => {
  const h = setup(t, { respond: () => answer(200) });
  assert.equal(h.R.statusesReported(), false);
  const [node] = h.nodes();
  h.recovery.started(node, art(MOVIE));
  await h.clock.advance(h.R.limits.WATCHDOG_MS - 1);
  assert.equal(h.calls.length, 0);
  await h.clock.advance(1 + 2000);
  assert.equal(h.calls.length, 1);
  assert.equal(node.hasAttribute('data-src'), false);
});

/** The child-list reader over a fake API client and JE's transport. */
function childSetup(t, { first, transport, ends }) {
  const sent = [];
  const h = createHarness({
    JE: {
      core: { api: { fetch: async (url, options) => { sent.push({ url, options }); return transport(sent.length, url, options); }, session: () => ({ current: () => true }) } }
    },
    apiClient: {
      getEpisodes: function () { return first(...arguments); },
      getSeasons: function () { return first(...arguments); }
    }
  });
  t.after(() => h.close());
  h.load('jellyseerr/nativedetails/native-recovery.js');
  const R = h.JE.internals.nativeRecovery;
  const clock = fakeClock();
  Object.assign(R.env, clock);
  const page = { live: true };
  R.childReads({ isSynthetic: id => id.startsWith('4a45ad'), capture: () => page, live: p => p.live,
    ...(ends ? { watch: (p, end) => { ends.add(end); return () => ends.delete(end); } } : {}) });
  return { ...h, R, clock, sent, page };
}

const refusal = (status, retryAfter) => Object.assign(new Error(`HTTP ${status}`), { status, headers: new Headers(retryAfter ? { 'Retry-After': retryAfter } : {}) });

test('an episode list the server couldn\'t give right now is drawn when a later ask answers, never as an empty list', async t => {
  const episodes = { Items: [{ Id: 'e1', Name: 'Kassa', Overview: 'Cassian.', RunTimeTicks: 24000000000 }], TotalRecordCount: 1 };
  const h = childSetup(t, { first: () => Promise.reject(refusal(503, '2')), transport: n => (n === 1 ? { status: 503, body: null, retryAfterMs: 3000 } : { status: 200, body: episodes }) });
  let result;
  h.window.ApiClient.getEpisodes(SERIES, { seasonId: SEASON, userId: 'user-a' }).then(r => { result = r; });
  await flush();
  await h.clock.advance(1999);
  assert.equal(h.sent.length, 0, 'not before Retry-After');
  assert.equal(result, undefined, 'pending, not an empty list');
  await h.clock.advance(1);
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].options.responseMode, 'status');
  assert.equal(h.sent[0].options.skipCache, true);
  assert.ok(h.sent[0].options.bound?.session, 'session-bound');
  await h.clock.advance(2999);
  assert.equal(h.sent.length, 1);
  await h.clock.advance(1);
  assert.deepEqual(result, episodes);
});

test('season and episode reads of library items, and final answers, are left exactly as jellyfin-web gets them', async t => {
  const seasons = { Items: [], TotalRecordCount: 0 };
  const h = childSetup(t, {
    first: id => (id === 'real' ? Promise.resolve(seasons) : Promise.reject(refusal(404))),
    transport: () => { throw new Error('no ask expected'); }
  });
  assert.equal(await h.window.ApiClient.getSeasons('real', {}), seasons);
  await assert.rejects(h.window.ApiClient.getSeasons(SERIES, {}), /HTTP 404/);
  await h.clock.advance(120_000);
  assert.equal(h.sent.length, 0);
});

test('a list read whose page ended (navigation, viewer, policy) is never asked again or settled', async t => {
  const h = childSetup(t, { first: () => Promise.reject(refusal(503, '2')), transport: () => ({ status: 200, body: { Items: [{ Id: 'x' }] } }) });
  let settled = false;
  h.window.ApiClient.getEpisodes(SERIES, { seasonId: SEASON }).then(() => { settled = true; }, () => { settled = true; });
  await flush();
  h.page.live = false;
  await h.clock.advance(120_000);
  assert.equal(h.sent.length, 0);
  assert.equal(settled, false);
});

test('a list that stays unavailable is asked a bounded number of times and then fails as before', async t => {
  const h = childSetup(t, { first: () => Promise.reject(refusal(503, '2')), transport: () => ({ status: 503, body: null, retryAfterMs: 2000 }) });
  let error;
  h.window.ApiClient.getSeasons(SERIES, {}).catch(e => { error = e; });
  await flush();
  await h.clock.advance(10 * 60_000);
  assert.match(String(error), /HTTP 503/);
  assert.ok(h.sent.length >= 1 && h.sent.length < h.R.limits.MAX_ATTEMPTS, `asks: ${h.sent.length}`);
});

/**
 * Both modules as the bundle loads them, on a synthetic movie page, with resource timing that reports statuses.
 * @returns {object} Harness and probes.
 */
function pageSetup(t, { respond, episodes, navigation = false, statuses = true }) {
  const calls = [];
  const images = fakeImages();
  let observe = null;
  class FakeObserver { constructor(cb) { observe = cb; } observe() {} disconnect() { observe = null; } }
  class FakeTiming {}
  FakeTiming.prototype.responseStatus = 0;
  const item = { Id: MOVIE, Type: 'Movie', Name: 'Dune: Part Two', ProductionYear: 2024, ProviderIds: { Tmdb: '693134' }, ImageTags: { Primary: 'na1.cur.sig' } };
  const h = createHarness({
    html: `<div class="backgroundContainer"><div class="backdropContainer"><div id="backdropImage0" class="backdropImage"></div><div id="backdropImage1" class="backdropImage"></div></div></div>
      <div id="itemDetailPage" class="page libraryPage itemDetailPage"><div class="detailPageContent"><div class="detailPagePrimaryContainer">
      <div class="mainDetailButtons"><button class="btnPlay detailButton">Play</button></div></div>
      <div class="detailImageContainer"><div class="cardImageContainer lazy lazy-hidden" data-src="${art(MOVIE)}"></div></div></div></div>`,
    url: `http://jellyfin.test/web/index.html#/details?id=${MOVIE}&serverId=${SERVER}`,
    fetch: (url, init) => { calls.push(String(url)); return respond(String(url), init); },
    globals: { Image: images.FakeImage, ...(statuses ? { PerformanceObserver: FakeObserver, PerformanceResourceTiming: FakeTiming } : {}) },
    JE: {
      pluginConfig: { NativeAbsentDetails: { Enabled: true, ContractVersion: 1, Source: 'tmdb' }, JellyseerrEnabled: false },
      t: key => key,
      escapeHtml: text => String(text),
      core: { api: { plugin: async () => null } },
      session: { onUserChange: () => {} },
      arrStatus: { enabled: () => false, fetchKey: async () => ({ items: [] }), buildPill: () => null, subscribe: () => () => {} },
      arrAsk: { enabled: () => false },
    },
    apiClient: { serverId: () => SERVER, getItem: async () => item, ...(episodes ? { getEpisodes: () => episodes() } : {}) },
  });
  h.window.Emby = { Page: { show: () => {} } };
  t.after(() => h.close());
  if (navigation) h.load('core/navigation.js');
  h.load('core/ui-kit.js');
  h.load('jellyseerr/nativedetails/native-recovery.js');
  const clock = fakeClock();
  Object.assign(h.JE.internals.nativeRecovery.env, clock);
  h.load('jellyseerr/nativedetails/native-details.js');
  const emit = (name, status, initiatorType = 'img') => observe?.({ getEntries: () => [{ name, responseStatus: status, initiatorType }] });
  const node = () => h.document.querySelector('.detailImageContainer .lazy');
  return { ...h, clock, calls, images, emit, node };
}

test('on an absent title\'s page, a poster the server refused for now (503) appears without leaving the page', async t => {
  const h = pageSetup(t, { respond: () => answer(200) });
  await h.JE.internals.nativeDetails.onView();
  // Successful loads, other items and recovery's own asks are not failures.
  h.emit(art(MOVIE), 200);
  h.emit(art('0123456789abcdef0123456789abcdef'), 503);
  h.emit(art(MOVIE), 503, 'fetch');
  await h.clock.advance(5000);
  assert.equal(h.calls.length, 0);
  h.emit(art(MOVIE), 503);
  await h.clock.advance(2000);
  assert.equal(h.calls.length, 1);
  assert.equal(h.node().hasAttribute('data-src'), false);
  assert.equal(h.node().classList.contains('lazy-hidden'), false);
});

test('leaving the absent title\'s page ends its artwork recovery', async t => {
  const h = pageSetup(t, { respond: () => answer(200) });
  await h.JE.internals.nativeDetails.onView();
  h.emit(art(MOVIE), 503);
  h.JE.internals.nativeDetails.dispose();
  await h.clock.advance(120_000);
  assert.equal(h.calls.length, 0);
  assert.ok(h.node().hasAttribute('data-src'));
});

test('a policy change ends recovery under the old policy; a failure after it is recovered under the new one', async t => {
  const h = pageSetup(t, { respond: () => answer(200) });
  await h.JE.internals.nativeDetails.onView();
  h.emit(art(MOVIE), 503);
  h.document.dispatchEvent(new h.window.Event('je-access-revision'));
  await h.clock.advance(120_000);
  assert.equal(h.calls.length, 0, 'the old policy\'s ask is never sent');
  h.emit(art(MOVIE), 503);
  await h.clock.advance(2000);
  assert.equal(h.calls.length, 1);
});

test('review: a first list answer arriving after its page ended is never drawn', async t => {
  const first = deferred();
  const h = childSetup(t, { first: () => first.promise, transport: () => { throw new Error('no ask expected'); } });
  let settled = false;
  h.window.ApiClient.getEpisodes(SERIES, { seasonId: SEASON }).then(() => { settled = true; }, () => { settled = true; });
  h.page.live = false;
  first.resolve({ Items: [{ Id: 'e1' }] });
  await flush();
  assert.equal(settled, false);
});

test('review: no recovery ask starts or keeps running past the deadline, queued ones included', async t => {
  const urls = [1, 2, 3, 4].map(n => art(MOVIE, `na1.${n}.x`));
  const h = setup(t, {
    urls,
    // Stalls until aborted (the deadline's own abort).
    respond: (u, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))
  });
  for (const u of urls) h.recovery.failed(u, 503);
  await h.clock.advance(2000);
  assert.equal(h.calls.length, 3, 'three at once; the fourth waits for a place');
  await h.clock.advance(h.R.limits.DEADLINE_MS);
  assert.ok(h.calls.every(c => c.init.signal.aborted), 'asks in flight are abandoned at the deadline');
  assert.equal(h.calls.length, 3, 'the queued fourth never starts after the deadline');
  assert.equal(h.recovery.size(), 0);
  assert.equal(h.clock.pending(), 0);
});

test('review: only the page\'s own backdrop is recovered, and a policy change takes it away again', async t => {
  const h = pageSetup(t, { respond: () => answer(200) });
  await h.JE.internals.nativeDetails.onView();
  // Another title's backdrop (a late failure of a page left behind) is never drawn here.
  h.emit(art('4a45ad11000000010000000005f3a6f5', 'na1.o.x', 'Backdrop/0'), 503);
  await h.clock.advance(5000);
  assert.equal(h.calls.length, 0);
  const own = art(MOVIE, 'na1.b.x', 'Backdrop/0');
  h.emit(own, 503);
  await h.clock.advance(2000);
  assert.equal(h.calls.length, 1);
  const slot = h.document.querySelector('.backdropImage.displayingBackdropImage');
  assert.ok(slot, 'recovered backdrop shown');
  assert.match(slot.getAttribute('data-url'), /\/Items\/4a45ad11000a938e00000000f9c67720\/Images\/Backdrop\/0\?.*_jer=/);
  assert.ok(h.document.querySelector('.backgroundContainer').classList.contains('withBackdrop'));
  // The access policy moves: what recovery drew there goes.
  h.document.dispatchEvent(new h.window.Event('je-access-revision'));
  assert.equal(h.document.querySelector('.backdropImage.displayingBackdropImage'), null);
  assert.equal(slot.style.backgroundImage, 'none');
  assert.equal(h.document.querySelector('.backgroundContainer').classList.contains('withBackdrop'), false);
});

test('review: leaving the page takes away a backdrop recovery drew', async t => {
  const h = pageSetup(t, { respond: () => answer(200) });
  await h.JE.internals.nativeDetails.onView();
  h.emit(art(MOVIE, 'na1.b.x', 'Backdrop/0'), 503);
  await h.clock.advance(2000);
  assert.ok(h.document.querySelector('.backdropImage.displayingBackdropImage'));
  h.JE.internals.nativeDetails.dispose();
  assert.equal(h.document.querySelector('.backdropImage.displayingBackdropImage'), null);
});

test('review r2: an image load that never ends releases its place at the deadline, and a page end drops it', async t => {
  const urls = [1, 2, 3, 4].map(n => art(MOVIE, `na1.${n}.x`));
  const h = setup(t, { urls, respond: () => answer(200), fails: () => 'hang' });
  for (const u of urls) h.recovery.failed(u, 503);
  await h.clock.advance(2000);
  await h.clock.advance(0);
  assert.equal(h.calls.length, 3);
  assert.equal(h.images.loads.length, 3, 'three loads hang, holding their places');
  await h.clock.advance(h.R.limits.DEADLINE_MS);
  assert.equal(h.recovery.size(), 0, 'every place released at the deadline');
  assert.equal(h.clock.pending(), 0);
  assert.equal(h.calls.length, 3, 'the fourth (expired while waiting) never starts');
  assert.equal(h.nodes().filter(n => n.hasAttribute('data-src')).length, 4, 'nothing drawn');
});

test('review r2: a stale grant\'s item re-read that never answers is bounded too', async t => {
  const url = art(MOVIE, 'na1.old.sig');
  const h = setup(t, { urls: [url], respond: () => answer(404, { 'X-JE-Art': 'stale-grant' }), getItem: () => new Promise(() => {}) });
  h.recovery.failed(url, 404);
  await h.clock.advance(0);
  assert.equal(h.recovery.size(), 1);
  await h.clock.advance(h.R.limits.DEADLINE_MS);
  assert.equal(h.recovery.size(), 0);
  assert.equal(h.clock.pending(), 0);
});

test('review r2: a list re-read is aborted at the deadline and nothing it answers later is drawn', async t => {
  let signal;
  const late = deferred();
  const h = childSetup(t, { first: () => Promise.reject(refusal(503, '50')), transport: (n, url, options) => { signal = options.signal; return late.promise; } });
  let result, error;
  h.window.ApiClient.getEpisodes(SERIES, { seasonId: SEASON }).then(r => { result = r; }, e => { error = e; });
  await flush();
  await h.clock.advance(50_000);
  assert.equal(h.sent.length, 1);
  assert.equal(signal.aborted, false);
  await h.clock.advance(10_000);
  assert.equal(signal.aborted, true, 'the deadline aborts the ask in flight');
  late.resolve({ status: 200, body: { Items: [{ Id: 'late' }] } });
  await flush();
  assert.equal(result, undefined, 'never drawn after the deadline');
  assert.match(String(error), /HTTP 503/, 'fails as before while the page holds');
});

test('review r2: a list read from an earlier visit of the same page is never drawn after coming back', async t => {
  const first = deferred();
  const h = pageSetup(t, { respond: () => answer(200), episodes: () => first.promise });
  const series = h.JE.titleDetails.syntheticId('series', 83867);
  let settled = false;
  h.window.ApiClient.getEpisodes(series, { seasonId: h.JE.titleDetails.syntheticId('season', 83867, 1) }).then(() => { settled = true; }, () => { settled = true; });
  const here = h.window.location.hash;
  await hashTo(h, '#/home');
  await hashTo(h, here);
  first.resolve({ Items: [{ Id: 'old' }] });
  await flush();
  assert.equal(settled, false);
});

for (const navigation of [false, true]) {
  test(`review r3: navigating to another absent title ends the old page's artwork recovery (${navigation ? 'navigation hooks' : 'route generation only'})`, async t => {
    const gate = deferred();
    const h = pageSetup(t, { respond: async () => { await gate.promise; return answer(200); }, navigation });
    await h.JE.internals.nativeDetails.onView();
    h.emit(art(MOVIE, 'na1.b.x', 'Backdrop/0'), 503);
    await h.clock.advance(2000);
    assert.equal(h.calls.length, 1, 'the backdrop ask is in flight');
    // Another absent title (the old page state stays current until its own look).
    await hashTo(h, `#/details?id=${h.JE.titleDetails.syntheticId('movie', 438631)}&serverId=${SERVER}`);
    gate.resolve();
    await h.clock.advance(120_000);
    assert.equal(h.document.querySelector('.backdropImage.displayingBackdropImage'), null, 'nothing drawn after the visit ended');
    assert.equal(h.images.loads.length, 0);
  });
}

test('review r3: coming back to the page starts that visit\'s own recovery', async t => {
  const h = pageSetup(t, { respond: () => answer(200), navigation: true });
  await h.JE.internals.nativeDetails.onView();
  const here = h.window.location.hash;
  await hashTo(h, '#/home');
  await hashTo(h, here);
  await h.JE.internals.nativeDetails.onView();
  h.emit(art(MOVIE), 503);
  await h.clock.advance(2000);
  assert.equal(h.calls.length, 1);
  assert.equal(h.node().hasAttribute('data-src'), false, 'recovered on the visit shown now');
});

test('review r3: a page that ends aborts its list re-read in flight and clears its timers', async t => {
  let signal;
  const ends = new Set();
  const h = childSetup(t, { ends, first: () => Promise.reject(refusal(503, '2')), transport: (n, url, options) => { signal = options.signal; return new Promise(() => {}); } });
  let settled = false;
  h.window.ApiClient.getEpisodes(SERIES, { seasonId: SEASON }).then(() => { settled = true; }, () => { settled = true; });
  await flush();
  await h.clock.advance(2000);
  assert.equal(h.sent.length, 1);
  // Something moved but the page still holds: nothing ends.
  for (const end of [...ends]) end();
  assert.equal(signal.aborted, false);
  h.page.live = false;
  for (const end of [...ends]) end();
  assert.equal(signal.aborted, true, 'the running ask is aborted at once');
  assert.equal(h.clock.pending(), 0, 'its deadline and retry timers are gone');
  assert.equal(ends.size, 0);
  await h.clock.advance(120_000);
  assert.equal(settled, false);
});

test('review r3: where statuses are not reported, a backdrop jellyfin-web asked for and never showed is recovered', async t => {
  const url = art(MOVIE, 'na1.b.x', 'Backdrop/0');
  const shown = [];
  let waits = true;
  const h = createHarness({ html: '<div id="page"></div>', fetch: () => answer(200), globals: { Image: fakeImages().FakeImage } });
  t.after(() => h.close());
  h.load('jellyseerr/nativedetails/native-recovery.js');
  const R = h.JE.internals.nativeRecovery;
  const clock = fakeClock();
  Object.assign(R.env, clock);
  const page = h.document.getElementById('page');
  const recovery = R.images({ page: () => page, live: () => true, outside: { expected: () => url, waiting: () => waits, show: u => { shown.push(u); waits = false; } } });
  await clock.advance(R.limits.WATCHDOG_MS + 2000);
  assert.equal(shown.length, 1);
  assert.match(shown[0], /Backdrop\/0\?.*_jer=/);
  recovery.dispose();
  assert.equal(clock.pending(), 0);
});

test('review r4: where statuses are not reported, a backdrop request that ends late is still recovered (checked until the deadline)', async t => {
  const url = art(MOVIE, 'na1.b.x', 'Backdrop/0');
  const shown = [];
  let listed = null;
  const h = createHarness({ html: '<div id="page"></div>', fetch: () => answer(200), globals: { Image: fakeImages().FakeImage } });
  t.after(() => h.close());
  h.load('jellyseerr/nativedetails/native-recovery.js');
  const R = h.JE.internals.nativeRecovery;
  const clock = fakeClock();
  Object.assign(R.env, clock);
  const recovery = R.images({ page: () => h.document.getElementById('page'), live: () => true,
    outside: { expected: () => listed, waiting: () => shown.length === 0, show: u => shown.push(u) } });
  await clock.advance(R.limits.WATCHDOG_MS + 1);
  assert.equal(shown.length, 0, 'the request has not ended yet: nothing to recover');
  // The slow request ends (and failed) after the first check.
  listed = url;
  await clock.advance(R.limits.WATCHDOG_MS + 2000);
  assert.equal(shown.length, 1);
  await clock.advance(R.limits.DEADLINE_MS * 2);
  assert.equal(clock.pending(), 0, 'the watchdog ends by the deadline');
  recovery.dispose();
});

test('review r4: where statuses are not reported, a backdrop requested on an earlier visit is never restored', async t => {
  const h = pageSetup(t, { respond: () => answer(200), navigation: true, statuses: false });
  const entries = [];
  h.window.performance.getEntriesByType = () => entries;
  const own = art(MOVIE, 'na1.b.x', 'Backdrop/0');
  // The earlier visit asked for the backdrop.
  entries.push({ name: own, startTime: h.window.performance.now() });
  const here = h.window.location.hash;
  await hashTo(h, '#/home');
  await hashTo(h, here);
  await h.JE.internals.nativeDetails.onView();
  // (The page's poster, already loading, is adopted and recovered on its own: only backdrop asks count here.)
  const backdropAsks = () => h.calls.filter(u => /\/Images\/Backdrop/.test(u)).length;
  await h.clock.advance(h.JE.internals.nativeRecovery.limits.WATCHDOG_MS * 2);
  assert.equal(backdropAsks(), 0, 'this visit asked for no backdrop (backdrops off): nothing drawn');
  assert.equal(h.document.querySelector('.backdropImage.displayingBackdropImage'), null);
  // This visit asks for it and it never shows: recovered.
  entries.push({ name: own, startTime: h.window.performance.now() + 1 });
  await h.clock.advance(h.JE.internals.nativeRecovery.limits.WATCHDOG_MS + 2000);
  assert.equal(backdropAsks(), 1);
  assert.ok(h.document.querySelector('.backdropImage.displayingBackdropImage'));
});

test('D121 ACR-3: where statuses are not reported, artwork already loading when recovery begins is recovered too', async t => {
  const h = pageSetup(t, { respond: () => answer(200), statuses: false });
  // The poster was already lazy-hidden with its data-src (its load started before the page state): no class change
  // will ever announce it.
  await h.JE.internals.nativeDetails.onView();
  await h.clock.advance(h.JE.internals.nativeRecovery.limits.WATCHDOG_MS - 1);
  assert.equal(h.calls.length, 0, 'one check, after the watchdog time; nothing before');
  await h.clock.advance(1 + 2000);
  assert.equal(h.calls.length, 1, 'adopted: one recovery ask');
  assert.equal(h.node().hasAttribute('data-src'), false);
  assert.equal(h.node().classList.contains('lazy-hidden'), false);
  // Bounded: nothing keeps checking once it is shown.
  await h.clock.advance(120_000);
  assert.equal(h.calls.length, 1);
  assert.equal(h.clock.pending(), 0);
});

test('D121 ACR-3: an image element already loading its own source recovers on its error event, and the page end removes the listener', async t => {
  const url = art(MOVIE);
  const h = createHarness({ html: `<div id="page"><img class="lazy-hidden" data-src="${url}" src="${url}"></div>`, fetch: () => answer(200), globals: { Image: fakeImages().FakeImage } });
  t.after(() => h.close());
  h.load('jellyseerr/nativedetails/native-recovery.js');
  const R = h.JE.internals.nativeRecovery;
  const clock = fakeClock();
  Object.assign(R.env, clock);
  const page = h.document.getElementById('page');
  const img = page.querySelector('img');
  Object.defineProperty(img, 'complete', { value: false });
  const calls = [];
  h.window.fetch = (u) => { calls.push(u); return answer(200); };
  const recovery = R.images({ page: () => page, live: () => true });
  recovery.adopt(img, url);
  await clock.advance(R.limits.WATCHDOG_MS * 2);
  assert.equal(calls.length, 0, 'no timer for an element with its own events');
  img.dispatchEvent(new h.window.Event('error'));
  await clock.advance(2000);
  assert.equal(calls.length, 1);
  assert.equal(img.hasAttribute('data-src'), false);
  // A second element adopted, then the page ends: its error event asks nothing.
  const other = h.document.createElement('img');
  const otherUrl = art(MOVIE, 'na1.o.x');
  other.className = 'lazy-hidden'; other.setAttribute('data-src', otherUrl); other.setAttribute('src', otherUrl);
  Object.defineProperty(other, 'complete', { value: false });
  page.append(other);
  recovery.adopt(other, otherUrl);
  recovery.dispose();
  other.dispatchEvent(new h.window.Event('error'));
  await clock.advance(120_000);
  assert.equal(calls.length, 1);
});
