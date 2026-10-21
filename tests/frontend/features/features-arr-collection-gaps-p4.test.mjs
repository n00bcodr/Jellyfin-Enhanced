// Requests & downloads, collection gaps (track 4d): storage not checked yet is said ("Checking storage…") and read
// again at 2 s and 6 s before Get is offered; every missing title opens its page; phase 4 (ArrCollectionGapsPhase4)
// says how many the collection's list already shows and keeps the older Seerr "Missing from" row away from a page the
// gaps block answers (removing one that raced in), with the switch off exactly as before.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { createHarness, jsRoot, jsonResponse, deferred } from '../helpers/harness.mjs';

const en = JSON.parse(readFileSync(resolve(jsRoot, 'locales/en.json'), 'utf8'));
const MODULES = [
  'arr/status/status-core.js', 'arr/status/status-episodes.js', 'arr/status/status-details.js',
  'core/mutation-queue.js', 'arr/ask/ask-core.js', 'arr/ask/ask-episodes.js', 'arr/ask/ask-sheet-styles.js', 'arr/ask/ask-sheet.js',
  'arr/ask/ask-actions.js', 'arr/ask/ask-collection.js', 'arr/ask/ask-styles.js'
];
const MEMBER = { role: 'member', canRequest: true, canApprove: false, asksFirst: false, can4kMovies: false, can4kSeries: false, backend: 'je', contact: 'Dad', freeEpisodes: 5 };
const BOX_PAGE = '<div id="itemDetailPage"><div class="detailPagePrimaryContent"><div class="detailSection"></div></div></div>';
const GAPS = {
  have: 4, total: 7,
  missing: [
    { key: 'movie:tmdb:11', title: 'Part Five', year: 2008, poster: null, released: true, request: null },
    { key: 'movie:tmdb:12', title: 'Part Six', year: 2011, poster: null, released: true, request: null },
    { key: 'movie:tmdb:13', title: 'Part Seven', year: 2012, poster: null, released: true, request: null },
    { key: 'movie:tmdb:14', title: 'Part Eight', year: 2031, poster: null, released: false, request: null }
  ]
};

/**
 * JE.t as the real one behaves: the English string with {name} parameters filled in.
 * @param {string} key Key.
 * @param {Object} [params] Parameters.
 * @returns {string} Text.
 */
function translate(key, params) {
  const text = en[key];
  if (text === undefined) throw new Error(`missing en.json key ${key}`);
  return Object.entries(params || {}).reduce((s, [k, v]) => s.split(`{${k}}`).join(String(v)), text);
}

/**
 * The request modules (and optionally collection-discovery) against a fake request API; `gaps(path, n)` answers the
 * n-th collection read. Timers of 1 s or more are held for the test to run.
 * @param {Object} t Test context.
 * @param {Object} options Fixtures.
 * @returns {Object} Harness.
 */
function setup(t, { gaps, config = {}, discovery = false, seerr = null, me = MEMBER } = {}) {
  const gets = [];
  const posts = [];
  const seerrCalls = [];
  const opened = [];
  let reads = 0;
  let spec = null;
  const h = createHarness({
    html: BOX_PAGE,
    url: 'http://jellyfin.test/web/index.html#/details?id=box1',
    fetch: async (url, init = {}) => {
      const u = new URL(url);
      const path = u.pathname.replace(/^\/JellyfinEnhanced/, '') + u.search;
      if ((init.method || 'GET') === 'POST') {
        posts.push(JSON.parse(init.body));
        return jsonResponse({ outcome: 'accepted', reason: 'looking', certainty: 'Succeeded', message: 'Asked!', requestId: 'a'.repeat(32) }, 201);
      }
      gets.push(path);
      if (path.startsWith('/acquire/requests/collection/')) {
        const body = await gaps(path, ++reads);
        return body ? jsonResponse({ outcome: 'accepted', reason: 'collection', collection: body }) : jsonResponse({ outcome: 'denied', reason: 'collection_unknown' }, 404);
      }
      if (path === '/acquire/requests/me') return jsonResponse({ outcome: 'accepted', reason: 'me', me });
      if (path.startsWith('/acquire/requests/quota')) return jsonResponse({ outcome: 'accepted', reason: 'quota', quota: { used: 0, limit: null, remaining: null, available: true } });
      return jsonResponse({ outcome: 'denied', reason: 'not_found' }, 404);
    },
    JE: {
      pluginConfig: { ArrStatusEnabled: true, ArrRequestsEnabled: true, JellyseerrShowCollectionDiscovery: true, ...config },
      t: translate,
      toast: () => {},
      escapeHtml: (s) => s,
      helpers: {
        debounce: fn => fn,
        addCSS: (id, css) => { const s = h.document.createElement('style'); s.id = id; s.textContent = css; h.document.head.appendChild(s); },
        getItemCached: async (id) => ({ Id: id, Type: 'BoxSet' })
      },
      core: {
        api: { plugin: async () => null },
        navigation: { onNavigate: () => () => {}, onViewPage: () => () => {} },
        lifecycle: { register: () => ({ track: x => x }) }
      },
      session: { epoch: 0, getEpoch() { return this.epoch; }, isCurrent: () => true, onUserChange: () => {} },
      titleDetails: { show: (tmdb, type) => { opened.push([tmdb, type]); return true; } },
      jellyseerrAPI: {
        checkUserStatus: async () => ({ active: true }),
        fetchCollectionDetails: async (id) => { seerrCalls.push(id); return seerr; }
      },
      discoveryFilter: {
        fetchWithManagedRequest: async (path) => { seerrCalls.push(path); return { id: 'box1', name: 'Saga', tmdbId: '10' }; },
        createCardsFragment: (results) => {
          const f = h.document.createDocumentFragment();
          for (const r of results) { const c = h.document.createElement('div'); c.className = 'card'; c.dataset.id = String(r.id); f.appendChild(c); }
          return f;
        }
      },
      discoveryBase: { createDiscovery: s => { spec = s; return { start: () => {} }; }, idFromDetailUrl: () => null }
    }
  });
  t.after(() => h.close());
  const held = new Map();
  let next = 1e6;
  const realSet = h.window.setTimeout.bind(h.window);
  const realClear = h.window.clearTimeout.bind(h.window);
  h.window.setTimeout = (fn, ms, ...args) => {
    if (!(ms >= 1000)) return realSet(fn, ms, ...args);
    const id = next++;
    held.set(id, { fn, ms });
    return id;
  };
  h.window.clearTimeout = id => { if (held.has(id)) held.delete(id); else realClear(id); };
  for (const m of MODULES) h.load(m);
  if (discovery) h.load('jellyseerr/discovery/collection-discovery.js');
  return {
    ...h, gets, posts, seerrCalls, opened,
    get reads() { return reads; },
    get spec() { return spec; },
    page: () => h.document.getElementById('itemDetailPage'),
    delays: () => [...held.values()].map(x => x.ms),
    runHeld() { const all = [...held.values()]; held.clear(); for (const x of all) x.fn(); return all.length; }
  };
}

async function settle(n = 20) {
  for (let i = 0; i < n; i++) await nextTurn();
}

const block = h => h.page().querySelector('.je-ask-coll');
const getButton = h => block(h)?.querySelector('.je-ask-coll-get');
const click = (h, node) => node.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true, cancelable: true }));

test('storage not checked yet: "Checking storage…" (nothing offered), read again at 2 s and 6 s, then "Check storage again", never an unchecked ask', async t => {
  let pending = true;
  const h = setup(t, { gaps: () => (pending ? { ...GAPS, pausesPending: true } : GAPS) });
  h.JE.internals.arrAskActions.attachDetails(h.page(), null);
  await settle();
  assert.equal(getButton(h).textContent, 'hourglass_emptyChecking storage…');
  assert.equal(getButton(h).disabled, true);
  assert.equal(block(h).querySelector('.je-ask-coll-unchecked'), null);
  click(h, getButton(h));
  await settle();
  assert.equal(h.posts.length, 0, 'nothing is asked for while storage is being checked');
  assert.deepEqual(h.delays(), [2000]);

  h.runHeld();
  await settle();
  assert.equal(h.reads, 2);
  assert.equal(getButton(h).disabled, true);
  assert.deepEqual(h.delays(), [4000], 'the second read again is 6 s after the first answer');

  h.runHeld();
  await settle();
  assert.equal(h.reads, 3);
  assert.deepEqual(h.delays(), [], 'bounded: no third read again on its own');
  assert.equal(getButton(h).disabled, false);
  assert.equal(getButton(h).textContent, 'refreshCheck storage again');
  assert.equal(block(h).querySelector('.je-ask-coll-unchecked').textContent, "Storage couldn't be checked yet, so nothing is asked for. Try again in a moment.");
  assert.equal(block(h).querySelector('.je-ask-coll-cost:not(.je-ask-coll-unchecked)'), null, 'no cost line for asks that cannot be made');
  // Pressing it reads again (from the start) and never asks.
  click(h, getButton(h));
  await settle();
  assert.equal(h.reads, 4);
  assert.equal(h.posts.length, 0);
  assert.equal(getButton(h).textContent, 'hourglass_emptyChecking storage…');
  assert.deepEqual(h.delays(), [2000]);
  // Storage checked now: Get is offered.
  pending = false;
  h.runHeld();
  await settle();
  assert.equal(h.reads, 5);
  assert.deepEqual(h.delays(), []);
  assert.equal(getButton(h).textContent, 'downloadGet the 3 missing');
  click(h, getButton(h));
  await settle(60);
  assert.deepEqual(h.posts.map(p => p.input.key), ['movie:tmdb:11', 'movie:tmdb:12', 'movie:tmdb:13']);
});

test('a person who may not ask (a Watcher) has nothing waiting on storage: no reads again', async t => {
  const h = setup(t, { gaps: () => ({ ...GAPS, pausesPending: true }), me: { ...MEMBER, role: 'watcher', canRequest: false } });
  h.JE.internals.arrAskActions.attachDetails(h.page(), null);
  await settle();
  assert.ok(block(h));
  assert.equal(getButton(h), null);
  assert.deepEqual(h.delays(), []);
});

test('storage checked on the read again: the paused movie is said and left out, no more reads', async t => {
  const h = setup(t, {
    gaps: (path, n) => n === 1 ? { ...GAPS, pausesPending: true } : { ...GAPS, missing: GAPS.missing.map(p => p.key === 'movie:tmdb:12' ? { ...p, blocked: { reason: 'low_disk' } } : p) }
  });
  h.JE.internals.arrAskActions.attachDetails(h.page(), null);
  await settle();
  assert.equal(getButton(h).disabled, true);
  h.runHeld();
  await settle();
  assert.equal(h.reads, 2);
  assert.deepEqual(h.delays(), []);
  assert.equal(getButton(h).disabled, false);
  assert.equal(getButton(h).textContent, 'downloadGet the 2 missing');
  assert.equal(block(h).querySelector('.je-ask-coll-unchecked'), null);
});

test('leaving the page (or another person) stops the reads again', async t => {
  const h = setup(t, { gaps: () => ({ ...GAPS, pausesPending: true }) });
  h.JE.internals.arrAskActions.attachDetails(h.page(), null);
  await settle();
  assert.deepEqual(h.delays(), [2000]);
  h.window.location.hash = '#/details?id=other';
  h.runHeld();
  await settle();
  assert.equal(h.reads, 1);
  // The same page for another person (epoch changed) reads nothing more either.
  h.window.location.hash = '#/details?id=box1';
  h.JE.internals.arrAskCollection.attach(h.page(), 'box1');
  await settle();
  assert.equal(h.reads, 2);
  h.JE.session.epoch = 1;
  h.runHeld();
  await settle();
  assert.equal(h.reads, 2);
});

test('a movie the person can\'t ask for at all (askable: false) is listed but never in the batch', async t => {
  const h = setup(t, { gaps: () => ({ ...GAPS, missing: GAPS.missing.map(p => p.key === 'movie:tmdb:12' ? { ...p, askable: false } : p) }) });
  h.JE.internals.arrAskActions.attachDetails(h.page(), null);
  await settle();
  assert.equal(getButton(h).textContent, 'downloadGet the 2 missing');
  assert.equal(block(h).querySelectorAll('.je-ask-coll-part').length, 4);
  click(h, getButton(h));
  await settle(60);
  assert.deepEqual(h.posts.map(p => p.input.key), ['movie:tmdb:11', 'movie:tmdb:13']);
});

test('every missing title opens its page (native page or the more-info window)', async t => {
  const h = setup(t, { gaps: () => GAPS });
  h.JE.internals.arrAskActions.attachDetails(h.page(), null);
  await settle();
  const links = [...block(h).querySelectorAll('.je-ask-coll-part a.je-ask-coll-link')];
  assert.deepEqual(links.map(a => a.textContent), ['Part Five (2008)', 'Part Six (2011)', 'Part Seven (2012)', 'Part Eight (2031)']);
  click(h, links[3]);
  click(h, links[0]);
  assert.deepEqual(h.opened, [[14, 'movie'], [11, 'movie']]);
  assert.equal(h.window.location.hash, '#/details?id=box1', 'the link itself goes nowhere');
  // Neither available: plain text, nothing to click.
  delete h.JE.titleDetails;
  h.JE.internals.arrAskCollection.attach(h.page(), 'box1');
  await settle();
  assert.equal(block(h).querySelectorAll('a.je-ask-coll-link').length, 0);
  assert.equal(block(h).querySelectorAll('bdi.je-ask-coll-title').length, 4);
});

test('phase 4: titles the list already shows are said as such; switch off, the note never shows', async t => {
  const answer = { ...GAPS, total: 9, covered: 2 };
  const on = setup(t, { gaps: () => answer, config: { ArrCollectionGapsPhase4: true } });
  on.JE.internals.arrAskActions.attachDetails(on.page(), null);
  await settle();
  assert.equal(block(on).querySelector('.je-ask-coll-covered').textContent, '2 more are already listed in this collection');
  assert.match(block(on).querySelector('.je-ask-coll-have').textContent, /You have 4 of 9\./);
  const off = setup(t, { gaps: () => answer });
  off.JE.internals.arrAskActions.attachDetails(off.page(), null);
  await settle();
  assert.equal(block(off).querySelector('.je-ask-coll-covered'), null);
  const one = setup(t, { gaps: () => ({ ...GAPS, covered: 1 }), config: { ArrCollectionGapsPhase4: true } });
  one.JE.internals.arrAskActions.attachDetails(one.page(), null);
  await settle();
  assert.equal(block(one).querySelector('.je-ask-coll-covered').textContent, '1 more is already listed in this collection');
});

const SEERR = { parts: [{ id: 11, title: 'Part Five', releaseDate: '2008-01-01' }, { id: 1, title: 'Part One', releaseDate: '1999-01-01', mediaInfo: { status: 5 } }] };

/**
 * Runs collection-discovery's one-shot body for box1.
 * @param {Object} h Harness.
 * @returns {Promise<boolean|undefined>} Its result.
 */
function renderDiscovery(h) {
  const signal = new h.window.AbortController().signal;
  return h.spec.renderOneShot({ id: 'box1', signal, waitForPageReady: async () => h.page().querySelector('.detailSection') });
}

test('phase 4: the gaps block answers the page, so the Seerr row stays away (and one that raced in is removed)', async t => {
  const h = setup(t, { gaps: () => GAPS, discovery: true, seerr: SEERR, config: { ArrCollectionGapsPhase4: true } });
  // The Seerr row raced in first.
  assert.equal(await renderDiscovery(h), true);
  assert.equal(h.page().querySelectorAll('.jellyseerr-collection-discovery-section').length, 1);
  h.JE.internals.arrAskActions.attachDetails(h.page(), null);
  await settle();
  assert.ok(block(h));
  assert.equal(h.page().querySelectorAll('.jellyseerr-collection-discovery-section').length, 0, 'removed once the block answered');
  // A later render of the row (navigation back, a retry) stays away without reading Seerr.
  const before = h.seerrCalls.length;
  assert.equal(await renderDiscovery(h), undefined);
  assert.equal(h.page().querySelectorAll('.jellyseerr-collection-discovery-section').length, 0);
  assert.equal(h.seerrCalls.length, before);
  assert.equal(h.JE.internals.arrAskCollection.covers('box1'), true);
  assert.equal(h.JE.internals.arrAskCollection.covers('box2'), false);
});

test('phase 4: a Seerr row rendering while the gaps read is out waits for it and stays away', async t => {
  const slow = deferred();
  const h = setup(t, { gaps: async () => { await slow.promise; return GAPS; }, discovery: true, seerr: SEERR, config: { ArrCollectionGapsPhase4: true } });
  h.JE.internals.arrAskActions.attachDetails(h.page(), null);
  await settle();
  const rendering = renderDiscovery(h);
  await settle();
  slow.resolve();
  assert.equal(await rendering, undefined);
  await settle();
  assert.equal(h.page().querySelectorAll('.jellyseerr-collection-discovery-section').length, 0);
  assert.ok(block(h));
});

test('phase 4: no gaps answer (collection unknown to the server) keeps the Seerr row', async t => {
  const h = setup(t, { gaps: () => null, discovery: true, seerr: SEERR, config: { ArrCollectionGapsPhase4: true } });
  h.JE.internals.arrAskActions.attachDetails(h.page(), null);
  await settle();
  assert.equal(await renderDiscovery(h), true);
  assert.equal(h.page().querySelectorAll('.jellyseerr-collection-discovery-section').length, 1);
});

test('a person with no Seerr account gets no Seerr row and no failed Seerr read (switch off too)', async t => {
  const h = setup(t, { gaps: () => null, discovery: true, seerr: SEERR });
  h.JE.jellyseerrAPI.checkUserStatus = async () => ({ active: true, userFound: false, reason: 'unlinked' });
  assert.equal(await renderDiscovery(h), undefined);
  assert.equal(h.page().querySelectorAll('.jellyseerr-collection-discovery-section').length, 0);
  assert.ok(!h.seerrCalls.includes(10), 'the per-user Seerr collection is not read');
});

test('phase 4 switch off: the Seerr row and the gaps block both show, exactly as before', async t => {
  const h = setup(t, { gaps: () => GAPS, discovery: true, seerr: SEERR });
  h.JE.internals.arrAskActions.attachDetails(h.page(), null);
  await settle();
  assert.equal(await renderDiscovery(h), true);
  await settle();
  assert.ok(block(h));
  const row = h.page().querySelector('.jellyseerr-collection-discovery-section');
  assert.equal(row.querySelector('h2').textContent, 'Missing from Saga (1/2)');
  assert.deepEqual([...row.querySelectorAll('.card')].map(c => c.dataset.id), ['11']);
  assert.equal(h.JE.internals.arrAskCollection.covers('box1'), false);
});
