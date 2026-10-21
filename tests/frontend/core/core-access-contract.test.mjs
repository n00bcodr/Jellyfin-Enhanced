// Review round 5 of the user-change caches (browser side): the person's access revision reaches the tab through a
// core channel of its own (every JE answer's X-JE-Revision header, the bootstrap, a probe on navigation), whatever
// features are on; state a closure holds is inventoried; the Hidden Content and Spoiler Guard mirrors follow their
// document revisions; a revision is handled in place (no badge comes off and back on) and a prefetched Discover page is
// used once, under the revision it was asked under. Through the real production modules.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { createHarness, deferred, jsonResponse, jsRoot } from '../helpers/harness.mjs';
import { cachesIn, registry } from '../helpers/browser-caches.mjs';

/** A JSON answer of JE's API carrying the person's revisions. */
const revised = (data, revision, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'Content-Type': 'application/json', 'X-JE-Revision': revision }
});

/** Loads the core layer the way the bundle orders it (the revision module only where the client has one). */
function loadCore(h, extra = []) {
  for (const m of ['core/navigation.js', 'core/session.js']) h.load(m);
  if (existsSync(resolve(jsRoot, 'core/access-revision.js'))) h.load('core/access-revision.js');
  for (const m of ['core/api-client.js', ...extra]) h.load(m);
}

const flush = async (n = 4) => { for (let i = 0; i < n; i++) await nextTurn(); };

test('what the person may ask for is kept a minute from when it was asked, not from when a slow answer came in', async t => {
  let now = 0;
  let allowed = true;
  let calls = 0;
  const held = deferred();
  const h = createHarness({
    JE: { pluginConfig: { ArrRequestsEnabled: true }, arrStatus: { enabled: () => true }, session: { getEpoch: () => 0, onUserChange() {} } },
    fetch: async () => { calls++; return calls === 1 ? held.promise : jsonResponse({ me: { canRequest: allowed } }); }
  });
  t.after(() => h.close());
  h.window.Date.now = () => now;
  h.load('arr/ask/ask-core.js');
  const pending = h.JE.arrAsk.me();
  // Read while the person could ask; the reply takes 59 s to arrive.
  allowed = false;
  now = 59000;
  held.resolve(jsonResponse({ me: { canRequest: true } }));
  assert.equal((await pending).canRequest, true);
  now = 61000;
  assert.equal((await h.JE.arrAsk.me()).canRequest, false, 'a decision asked a minute ago is asked again');
  assert.equal(calls, 2);
});

test('with poster tags off, a navigation tells the tab the access moved: capabilities and badges are read again', async t => {
  let access = 'a1';
  const reads = [];
  const h = createHarness({
    JE: { pluginConfig: { ArrRequestsEnabled: true, TagCacheServerMode: false }, arrStatus: { enabled: () => true } },
    fetch: async url => {
      const path = new URL(String(url)).pathname;
      reads.push(path);
      if (path.endsWith('/revision')) return revised({ revision: `a=${access};hc=h1;sg=s1` }, `a=${access};hc=h1;sg=s1`);
      return revised({ me: { canRequest: access === 'a1' } }, `a=${access};hc=h1;sg=s1`);
    }
  });
  t.after(() => h.close());
  loadCore(h, ['arr/ask/ask-core.js']);
  const announced = [];
  h.document.addEventListener('je-access-revision', e => announced.push(e.detail.revision));
  assert.equal((await h.JE.arrAsk.me()).canRequest, true);
  // A parental restriction on the server; nothing on this page asks JE (tags off, everything cached).
  access = 'a2';
  h.window.history.pushState({}, '', '#!/details?id=1');
  await flush(8);
  assert.deepEqual(announced, ['a2'], 'the navigation probe carries the moved revision');
  assert.equal((await h.JE.arrAsk.me()).canRequest, false, 'capabilities are asked again after the move');
  assert.equal(reads.filter(p => p.endsWith('/acquire/requests/me')).length, 2);
});

test('another tab guards a movie: this tab\'s Spoiler Guard state follows its document revision', async t => {
  const movie = 'a'.repeat(32);
  let guarded = false;
  let sg = 's1';
  let stateReads = 0;
  const h = createHarness({
    JE: { pluginConfig: { SpoilerBlurEnabled: true }, internals: { spoilerGuard: { normalizeId: id => id.replace(/-/g, '').toLowerCase() } } },
    fetch: async url => {
      const path = new URL(String(url)).pathname;
      const revision = `a=a1;hc=h1;sg=${sg}`;
      if (path.endsWith('/revision')) return revised({ revision }, revision);
      if (path.endsWith('/spoiler-blur/series')) { stateReads++; return revised({ Movies: guarded ? { [movie]: {} } : {} }, revision); }
      return revised({}, revision);
    }
  });
  t.after(() => h.close());
  loadCore(h, ['enhanced/spoilerguard/state.js']);
  const state = h.JE.internals.spoilerGuard;
  await state.loadState();
  assert.equal(state.isMovieEnabledFor(movie), false);
  // The other tab saves; this tab's next navigation sees the document's revision move.
  guarded = true;
  sg = 's2';
  h.window.history.pushState({}, '', '#!/details?id=2');
  await flush(8);
  await state.loadState();
  assert.equal(state.isMovieEnabledFor(movie), true, 'the guard saved elsewhere protects here');
  assert.equal(stateReads, 2);
  // Nothing moved: no further read.
  await state.loadState();
  assert.equal(stateReads, 2);
});

test('another tab hides a title: this tab\'s Hidden Content rules follow, in place, and a pending save here is never overwritten', async t => {
  const id = 'b'.repeat(32);
  let hc = 'h1';
  let reads = 0;
  let posted = 0;
  const h = createHarness({
    JE: { userConfig: { hiddenContent: { items: {}, settings: {} } } },
    apiClient: { ajax: async (req) => {
      if (req.type === 'POST') { posted++; return {}; }
      reads++;
      return { items: { [id]: { itemId: id, tmdbId: '603', hideScope: 'global' } }, settings: {} };
    } },
    fetch: async url => {
      const revision = `a=a1;hc=${hc};sg=s1`;
      return revised({ revision }, revision);
    }
  });
  t.after(() => h.close());
  loadCore(h, ['enhanced/hiddencontent/hidden-content-data.js', 'enhanced/hiddencontent/hidden-content-save.js']);
  const content = h.JE.internals.hiddenContent;
  let refreshed = 0;
  content.refreshNativeCardVisibility = () => { refreshed++; };
  content.restoreNativeCardsForIds = () => {};
  content.showUndoToast = () => {};
  await h.JE.core?.revision?.probe?.('start', true);
  content.resetFromUserConfig();
  assert.equal(content.isHidden(id), false);
  hc = 'h2';
  // The next navigation's probe (forced here: the start probe was under a second ago).
  await h.JE.core.revision.probe('navigation', true);
  await flush(8);
  assert.equal(content.isHidden(id), true, 'the title hidden in another tab is hidden here');
  assert.equal(reads, 1);
  assert.ok(refreshed > 0, 'the cards on the page are filtered again');
  // A hide of this tab waiting to be saved: a revision seen meanwhile doesn't read the rules over it.
  content.hideItem({ itemId: 'c'.repeat(32), name: 'Local', type: 'Movie', hideScope: 'global' });
  hc = 'h3';
  await h.JE.core.revision.probe('again', true);
  await flush(4);
  assert.equal(reads, 1, 'no read over a pending save');
  assert.equal(content.isHidden('c'.repeat(32)), true);
  await new Promise(r => setTimeout(r, 700));
  await flush(6);
  assert.equal(posted, 1);
  assert.equal(reads, 2, 'read again once the save is done');
});

test('the inventory includes state a factory\'s closure keeps (the client-paged Discover list)', () => {
  const file = 'jellyseerr/discovery/discovery-base.js';
  for (const name of ['cachedAllResults', 'currentPagedResults']) {
    assert.ok(cachesIn(file).some(c => c.name === name), `the inventory misses ${name} inside the discovery factory`);
    assert.ok(registry().some(c => c.file === file && c.name === name && c.class === 'revisioned'));
  }
  // A memo planted inside a factory, written from an awaited source the factory was handed.
  const planted = '(function (JE) { function make(spec) { let held = []; async function load() { held = await spec.resolveItems(); } return { load }; } JE.make = make; })(window.JellyfinEnhanced);';
  assert.ok(cachesIn('planted.js', planted).some(c => c.name === 'held'));
});

test('a filmography scrolled after a restriction draws no restricted title, and takes the restricted cards away in place', async t => {
  const h = createHarness({ html: '<main id="detail"></main>' });
  let loadMore;
  let restricted = false;
  let reads = 0;
  let controller;
  t.after(() => { controller?.cleanup(); h.close(); });
  h.JE.jellyseerrUI = { createJellyseerrCard(item) {
    const card = h.document.createElement('div'); card.className = 'card'; card.dataset.id = String(item.id); return card;
  } };
  let access = 'a1';
  h.JE.core = { revision: { access: () => access } };
  h.load('jellyseerr/seerr-status.js');
  h.load('jellyseerr/discovery/discovery-filter-utils.js');
  h.JE.discoveryFilter.waitForPageReady = async () => h.document.querySelector('#detail');
  h.JE.discoveryFilter.setupInfiniteScroll = (_state, _selector, callback) => { loadMore = callback; };
  h.JE.discoveryFilter.cleanupScrollObserver = () => {};
  h.load('jellyseerr/discovery/discovery-base.js');
  controller = h.JE.discoveryBase.createDiscovery({
    key: 'person', mode: 'client-paged', logLabel: 'Person', configKey: 'JellyseerrShowPersonDiscovery', pageSize: 2,
    getIdFromUrl: () => 'person-1',
    resolveItems: async () => { reads++; return { title: 'Person', items: (restricted ? [1, 4, 5] : [1, 2, 3, 4, 5]).map(id => ({ id, mediaType: 'movie' })) }; }
  });
  await controller.render();
  const drawn = () => [...h.document.querySelectorAll('.card')].map(c => c.dataset.id);
  assert.deepEqual(drawn(), ['1', '2']);
  const first = h.document.querySelector('.card[data-id="1"]');
  // The access revision now excludes 2 and 3.
  restricted = true;
  access = 'a2';
  h.document.dispatchEvent(new h.window.CustomEvent('je-access-revision', { detail: { before: 'a1', revision: 'a2' } }));
  await loadMore();
  assert.equal(reads, 2, 'the list is read again before more is drawn');
  assert.ok(!h.document.querySelector('.card[data-id="3"]'), 'no title of the old access is drawn');
  assert.ok(!h.document.querySelector('.card[data-id="2"]'), 'a drawn card the new access no longer has is taken away');
  assert.equal(h.document.querySelector('.card[data-id="1"]'), first, 'a card still allowed stays as it is');
  assert.deepEqual(drawn(), ['1', '4', '5']);
});

test('a prefetched Discover page is used, not asked for twice, and never after the access revision moved', async t => {
  const asked = [];
  const h = createHarness({
    fetch: async url => {
      const u = new URL(String(url));
      asked.push(u.pathname + u.search);
      return revised({ results: [{ id: asked.length, mediaType: 'movie' }], totalPages: 9 }, 'a=a1;hc=h1;sg=s1');
    }
  });
  t.after(() => h.close());
  loadCore(h, ['jellyseerr/request-manager.js', 'jellyseerr/discovery/discovery-filter-utils.js']);
  const page = p => h.JE.discoveryFilter.fetchWithManagedRequest(`/JellyfinEnhanced/jellyseerr/discover/movies/genre/28?page=${p}`, 'genre');
  // The engine prefetches pages 2 and 3 while page 1 renders, then loads them when the viewer scrolls.
  await page(1);
  await Promise.all([page(2), page(3)]);
  await page(2);
  await page(3);
  assert.equal(asked.length, 3, `each page is asked for once: ${asked.join(', ')}`);
  // The access moves: a kept page is never drawn for it.
  h.JE.core.revision?.noteRevision?.('a=a2;hc=h1;sg=s1');
  await page(2);
  assert.equal(asked.length, 4);
});

test('a moved access revision reads the status badges again in place: an unchanged badge is never taken off', async t => {
  const id = '0'.repeat(31) + '1';
  const observers = [];
  let reads = 0;
  const h = createHarness({
    html: `<div class="card" data-id="${id}" data-type="Movie"><div class="cardBox"><div class="cardScalable"></div></div></div>`,
    globals: { IntersectionObserver: class { constructor(fn) { this.fn = fn; this.observed = new Set(); observers.push(this); } observe(el) { this.observed.add(el); } unobserve(el) { this.observed.delete(el); } disconnect() { this.observed.clear(); } } },
    JE: {
      pluginConfig: { ArrStatusEnabled: true, ArrStatusPosterBadges: true }, currentSettings: {},
      t: key => key,
      helpers: { debounce: fn => fn, onBodyMutation: () => ({ unsubscribe() {} }) },
      core: { api: { plugin: async () => { reads++; return { items: [{ itemId: id, key: 'movie:tmdb:1', kind: 'movie', stage: 'downloading', progress: 40 }] }; } },
        navigation: { onNavigate: () => () => {} }, lifecycle: { register: () => ({ track: x => x }) } },
      session: { getEpoch: () => 0, isCurrent: () => true, onUserChange() {} }
    }
  });
  t.after(() => h.close());
  for (const m of ['arr/status/status-core.js', 'arr/status/status-cards.js', 'arr/status/status-styles.js']) h.load(m);
  const cards = h.JE.internals.arrStatusCards;
  h.JE.initializeArrStatus();
  cards.scan();
  observers[0].fn([...observers[0].observed].map(target => ({ isIntersecting: true, target })));
  await cards.flush();
  const badge = h.document.querySelector('.je-arr-badge');
  assert.ok(badge, 'the badge is drawn');
  const removed = [];
  new h.window.MutationObserver(records => records.forEach(r => r.removedNodes.forEach(n => removed.push(n)))).observe(h.document.body, { subtree: true, childList: true });
  h.document.dispatchEvent(new h.window.CustomEvent('je-access-revision', { detail: { revision: 'a2', before: 'a1' } }));
  await flush(2);
  assert.equal(h.document.querySelector('.je-arr-badge'), badge, 'the badge stays while its new answer is read');
  await new Promise(r => setTimeout(r, 350));
  await cards.flush();
  await flush(2);
  assert.ok(reads >= 2, 'the card is read again');
  assert.equal(h.document.querySelector('.je-arr-badge'), badge, 'an unchanged badge is the same element');
  assert.deepEqual(removed.filter(n => n.classList?.contains('je-arr-badge')), [], 'no badge came off and back on');
});
