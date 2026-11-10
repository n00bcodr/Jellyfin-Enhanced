// Discovery sections through their shipped scripts, on the real core runtime (navigation, session,
// lifecycle, DOM observer, API client) and shared helpers. Only Seerr's card renderer and user-status
// call are fixtures. The scroll engine is driven explicitly: real rendering and pagination run
// normally, with no geometry dependency.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, deferred, englishT, jsonResponse, plain } from '../helpers/harness.mjs';

const RUNTIME = ['core/navigation.js', 'core/session.js', 'core/lifecycle.js', 'core/dom-observer.js', 'core/ui-kit.js',
  'core/api-client.js', 'enhanced/helpers.js', 'jellyseerr/seerr-status.js', 'jellyseerr/request-manager.js',
  'jellyseerr/seamless-scroll.js', 'jellyseerr/discovery/discovery-filter-utils.js', 'jellyseerr/discovery/discovery-base.js'];
const ORIGIN = 'http://jellyfin.test';
const API = '/JellyfinEnhanced';
const LIST_PAGE = '<div class="page libraryPage" id="list"><div class="verticalSection"><div class="itemsContainer"><div class="card" data-id="host"></div></div></div></div>';
const DETAIL_PAGE = '<div class="page itemDetailPage" id="detail"><div class="detailPageContent"></div></div>';
const COMEDY = [`${API}/tmdb/genres/tv`, [{ id: 35, name: 'Comedy' }]];
const COMEDY_MOVIES = [`${API}/tmdb/genres/movie`, [{ id: 36, name: 'Comedy' }]];

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
async function until(condition, label = 'condition') {
  const deadline = performance.now() + 3000;
  while (!condition() && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(condition(), `${label} was not reached`);
}
const feed = (ids, mediaType, totalPages = 3) => ({ results: ids.map(id => ({ id, mediaType })), totalPages });
const ids = root => [...root.querySelectorAll('.card')].map(card => card.dataset.id).filter(id => id !== 'host').map(Number);

function setup(t, { hash, html = LIST_PAGE, routes = [], config = {}, items = {}, status = { active: true }, expectedConsoleErrors, user = 'user-a' } = {}) {
  const who = { user, server: 'server-a' };
  const calls = [];
  const table = new Map(routes);
  const h = createHarness({
    html, url: `${ORIGIN}/web/index.html${hash}`, expectedConsoleErrors,
    JE: { internals: {}, pluginConfig: config, t: englishT },
    apiClient: {
      getCurrentUserId: () => who.user, serverId: () => who.server, accessToken: () => `token-${who.user}`,
      getItem: async (_user, id) => items[id] ?? { Id: id, Type: 'Other' }
    },
    fetch: async (url, options) => {
      const path = url.replace(ORIGIN, '');
      calls.push({ path, user: who.user, headers: options.headers, signal: options.signal });
      const answer = table.has(path) ? table.get(path) : table.get(path.split('?')[0]);
      if (answer === undefined) return jsonResponse({ message: `no fixture for ${path}` }, 404);
      const value = typeof answer === 'function' ? await answer(who) : await answer;
      if (value instanceof Error) throw value;
      return jsonResponse(value);
    }
  });
  t.after(() => h.close());
  for (const file of RUNTIME) h.load(file);
  h.JE.jellyseerrAPI = { checkUserStatus: async () => status };
  h.JE.jellyseerrUI = {
    released: 0,
    createJellyseerrCard(item) {
      const card = h.document.createElement('div');
      card.className = 'card portraitCard';
      card.dataset.id = String(item.id);
      card.innerHTML = '<div class="cardText-first"><a href="http://seerr.test/x" target="_blank" rel="noopener">Seerr</a></div>';
      return card;
    },
    releasePosters() { this.released++; }
  };
  const armed = { count: 0, load: null };
  h.JE.discoveryFilter.setupInfiniteScroll = (_state, _selector, load) => { armed.count++; armed.load = load; };
  h.JE.discoveryFilter.cleanupScrollObserver = () => { armed.load = null; };
  const switchUser = (user, server = who.server) => {
    who.user = user;
    who.server = server;
    h.JE.session.checkNow('test');
  };
  return { ...h, who, calls, table, armed, switchUser, section: name => h.document.querySelector(`.jellyseerr-${name}-discovery-section`) };
}
function loadGenre(t, options = {}) {
  const h = setup(t, { hash: '#/list?genreId=g1', ...options, routes: [
    [`${API}/genre/g1`, { id: 'g1', name: 'Comedy', type: 'Genre' }], COMEDY, COMEDY_MOVIES,
    [`${API}/jellyseerr/discover/tv/genre/35?page=1`, feed([1, 2], 'tv')],
    [`${API}/jellyseerr/discover/movies/genre/36?page=1`, feed([11, 12], 'movie')],
    ...(options.routes ?? [])
  ] });
  return h;
}
const cardsOf = h => ids(h.section('genre') ?? h.document.createElement('div'));

test('genre discovery interleaves both feeds, names the section and offers the filter once both answered', async t => {
  const h = loadGenre(t);
  h.load('jellyseerr/discovery/genre-discovery.js');
  await until(() => cardsOf(h).length === 4, 'first page');
  const section = h.section('genre');
  assert.deepEqual(cardsOf(h), [1, 11, 2, 12]);
  assert.equal(section.querySelector('.sectionTitle').textContent, 'More from the genre - "Comedy"');
  assert.equal(section.parentElement.id, 'list', 'section sits beside the list section');
  assert.equal(section.querySelectorAll('.jellyseerr-filter-btn').length, 3);
  assert.equal(section.querySelector('.jellyseerr-sort-select').value, '');
  assert.equal(h.armed.count, 1);
});

test('dual feed pages on demand, deduplicates repeats and warms the cache only for what it needs', async t => {
  const h = loadGenre(t, { routes: [
    [`${API}/jellyseerr/discover/tv/genre/35?page=2`, feed([3, 1], 'tv')],
    [`${API}/jellyseerr/discover/movies/genre/36?page=2`, feed([13], 'movie')],
    [`${API}/jellyseerr/discover/tv/genre/35?page=3`, feed([4], 'tv')],
    [`${API}/jellyseerr/discover/movies/genre/36?page=3`, feed([14], 'movie')]
  ] });
  h.load('jellyseerr/discovery/genre-discovery.js');
  await until(() => h.armed.load, 'engine');
  const result = await h.armed.load({ deficitPx: 10, pageBudget: 2 });
  assert.deepEqual(plain(result), { pages: 2, rendered: 2 });
  assert.deepEqual(cardsOf(h), [1, 11, 2, 12, 3, 13], 'page 2 repeat of 1 is dropped');
  await until(() => h.calls.some(call => call.path.endsWith('tv/genre/35?page=3')), 'prefetch of the next page');
  assert.equal(h.calls.filter(call => call.path.includes('page=4')).length, 0, 'never past the feed page count');
});

test('a batch keeps the pages before a failure and the next load resumes at the failed page', async t => {
  let failing = true;
  const flaky = () => failing ? new Error('upstream hiccup') : feed([4], 'tv');
  const h = loadGenre(t, { routes: [
    [`${API}/jellyseerr/discover/tv/genre/35?page=2`, feed([3], 'tv')],
    [`${API}/jellyseerr/discover/tv/genre/35?page=3`, flaky],
    [`${API}/jellyseerr/discover/movies/genre/36?page=2`, feed([], 'movie')],
    [`${API}/jellyseerr/discover/movies/genre/36?page=3`, feed([], 'movie')]
  ] });
  h.JE.requestManager.CONFIG.retry.maxAttempts = 1;
  h.load('jellyseerr/discovery/genre-discovery.js');
  await until(() => h.armed.load, 'engine');
  h.JE.seamlessScroll.cardsNeeded = () => 40; // Two pages per feed.
  await h.armed.load({ deficitPx: 10, pageBudget: 4 });
  assert.ok(cardsOf(h).includes(3));
  assert.equal(cardsOf(h).includes(4), false);
  await new Promise(resolve => setTimeout(resolve, 20)); // The failed page's prefetch settles first.
  failing = false;
  await h.armed.load({ deficitPx: 10, pageBudget: 4 });
  assert.ok(cardsOf(h).includes(4), 'the failed page was re-fetched rather than skipped');
});

test('DISCOVERY-RECOMMENDATIONS-016: a malformed page is a failed page: nothing renders from it and the feed stays open for a retry', async t => {
  let malformed = true;
  const tv = () => malformed ? { results: 'not rows' } : feed([1], 'tv', 1);
  const h = loadGenre(t, { routes: [
    [`${API}/jellyseerr/discover/tv/genre/35?page=1`, tv],
    [`${API}/jellyseerr/discover/movies/genre/36?page=1`, feed([11], 'movie', 1)]
  ] });
  h.load('jellyseerr/discovery/genre-discovery.js');
  await until(() => cardsOf(h).length === 1, 'the healthy feed');
  assert.deepEqual(cardsOf(h), [11]);
  assert.ok(h.armed.load, 'failed feed keeps the engine armed');
  malformed = false;
  h.JE.requestManager.clearCache();
  await h.armed.load({ deficitPx: 10, pageBudget: 4 });
  assert.deepEqual(cardsOf(h), [11, 1]);
});

test('DISCOVERY-RECOMMENDATIONS-016: non-object rows are ignored and a response with no body is an empty last page', async t => {
  const h = loadGenre(t, { routes: [
    [`${API}/jellyseerr/discover/tv/genre/35?page=1`, { results: [null, 7, 'x', { id: 1, mediaType: 'tv' }], totalPages: '1' }],
    [`${API}/jellyseerr/discover/movies/genre/36?page=1`, null]
  ] });
  h.load('jellyseerr/discovery/genre-discovery.js');
  await until(() => cardsOf(h).length === 1, 'the valid row');
  assert.deepEqual(cardsOf(h), [1]);
  assert.equal(h.armed.count, 0, 'both feeds report no further pages');
  assert.equal(h.section('genre').querySelector('.jellyseerr-discovery-filter'), null, 'one media type offers no filter');
});

test('sort change abandons the older load, re-reads page 1 and sorts series on first_air_date', async t => {
  const late = deferred();
  const h = loadGenre(t, { routes: [
    [`${API}/jellyseerr/discover/tv/genre/35?page=2`, late.promise],
    [`${API}/jellyseerr/discover/movies/genre/36?page=2`, late.promise],
    [`${API}/jellyseerr/discover/tv/genre/35?page=1&sortBy=first_air_date.desc`, feed([21], 'tv', 1)],
    [`${API}/jellyseerr/discover/movies/genre/36?page=1&sortBy=release_date.desc`, feed([31], 'movie', 1)]
  ] });
  h.load('jellyseerr/discovery/genre-discovery.js');
  await until(() => h.armed.load, 'engine');
  const old = h.armed.load({ deficitPx: 10, pageBudget: 2 });
  await until(() => h.calls.some(call => call.path.endsWith('tv/genre/35?page=2')), 'the older load');
  const { signal } = h.calls.find(call => call.path.endsWith('tv/genre/35?page=2'));
  const select = h.section('genre').querySelector('.jellyseerr-sort-select');
  select.value = 'release_date.desc';
  select.dispatchEvent(new h.window.Event('change'));
  assert.equal(signal.aborted, true, 'its request ends with it');
  await until(() => cardsOf(h).length === 2, 'sorted first page');
  late.resolve(feed([91], 'tv', 9));
  await old;
  await tick();
  assert.deepEqual(cardsOf(h), [21, 31], 'the abandoned load adds nothing');
});

test('DISCOVERY-RECOMMENDATIONS-021: sorting under a filter keeps the other type for when All comes back', async t => {
  const h = loadGenre(t, { routes: [
    [`${API}/jellyseerr/discover/tv/genre/35?page=1&sortBy=first_air_date.desc`, feed([21], 'tv', 1)],
    [`${API}/jellyseerr/discover/movies/genre/36?page=1&sortBy=release_date.desc`, feed([31], 'movie', 1)]
  ] });
  h.load('jellyseerr/discovery/genre-discovery.js');
  await until(() => h.armed.load, 'engine');
  const section = h.section('genre');
  section.querySelector('[data-mode="movies"]').click();
  const select = section.querySelector('.jellyseerr-sort-select');
  select.value = 'release_date.desc';
  select.dispatchEvent(new h.window.Event('change'));
  await until(() => cardsOf(h).includes(31), 'sorted first page');
  assert.ok(section.querySelector('.itemsContainer').classList.contains('filter-movies'), 'the filter still hides the series');
  section.querySelector('[data-mode="mixed"]').click();
  assert.deepEqual(cardsOf(h), [21, 31]);
});

test('DISCOVERY-RECOMMENDATIONS-022: a card that fails to build costs a retry, not the batch', async t => {
  const h = loadGenre(t, { expectedConsoleErrors: ['Error loading more items: Error: controlled card failure'], routes: [
    [`${API}/jellyseerr/discover/tv/genre/35?page=1`, feed([1, 2], 'tv', 2)],
    [`${API}/jellyseerr/discover/movies/genre/36?page=1`, feed([11, 12], 'movie', 2)],
    [`${API}/jellyseerr/discover/tv/genre/35?page=2`, feed([3], 'tv', 2)],
    [`${API}/jellyseerr/discover/movies/genre/36?page=2`, feed([13], 'movie', 2)]
  ] });
  h.load('jellyseerr/discovery/genre-discovery.js');
  await until(() => h.armed.load, 'engine');
  const build = h.JE.jellyseerrUI.createJellyseerrCard;
  let failNext = true;
  h.JE.jellyseerrUI.createJellyseerrCard = item => {
    if (failNext && item.id === 13) { failNext = false; throw new Error('controlled card failure'); }
    return build(item);
  };
  await assert.rejects(h.armed.load({ deficitPx: 10, pageBudget: 2 }), /controlled card failure/);
  assert.deepEqual(cardsOf(h), [1, 11, 2, 12], 'the failed batch is taken out');
  assert.deepEqual(plain(await h.armed.load({ deficitPx: 10, pageBudget: 2 })), { pages: 2, rendered: 2 });
  assert.deepEqual(cardsOf(h), [1, 11, 2, 12, 3, 13], 'even though these were the last pages');
});

test('filter switches by class without a rebuild, re-arms the engine and reads only the selected feed', async t => {
  const h = loadGenre(t, { routes: [[`${API}/jellyseerr/discover/movies/genre/36?page=2`, feed([13], 'movie')]] });
  h.load('jellyseerr/discovery/genre-discovery.js');
  await until(() => h.armed.load, 'engine');
  h.section('genre').querySelector('[data-mode="movies"]').click();
  const items = h.section('genre').querySelector('.itemsContainer');
  assert.ok(items.classList.contains('filter-movies'));
  assert.deepEqual(ids(items), [1, 11, 2, 12]);
  assert.equal(h.armed.count, 2);
  await h.armed.load({ deficitPx: 10, pageBudget: 1 });
  assert.equal(h.calls.some(call => call.path.includes('discover/tv/genre/35?page=2')), false);
  assert.deepEqual(ids(items), [1, 11, 2, 12, 13]);
});

test('a page that lands after the identity changed renders nothing and is not cached for the next user', async t => {
  const pending = deferred();
  const h = loadGenre(t, { routes: [[`${API}/jellyseerr/discover/tv/genre/35?page=1`, pending.promise]] });
  h.load('jellyseerr/discovery/genre-discovery.js');
  await until(() => h.section('genre'), 'section header');
  assert.equal(h.calls.find(call => call.path.includes('tv/genre/35')).headers['X-Jellyfin-User-Id'], 'user-a');
  h.switchUser('user-b');
  assert.equal(h.section('genre'), null, 'identity change removes the section');
  pending.resolve(feed([666], 'tv'));
  await tick();
  await tick();
  assert.equal(h.document.querySelector('[data-id="666"]'), null);
  assert.equal(h.JE.requestManager.getCached(`genre:${API}/jellyseerr/discover/tv/genre/35?page=1`), null);
});

test('returning to the same account does not revive work started before leaving it', async t => {
  const pending = deferred();
  const h = loadGenre(t, { routes: [[`${API}/jellyseerr/discover/tv/genre/35?page=1`, pending.promise]] });
  h.load('jellyseerr/discovery/genre-discovery.js');
  await until(() => h.section('genre'), 'section header');
  h.switchUser('user-b');
  h.switchUser('user-a');
  pending.resolve(feed([666], 'tv'));
  await tick();
  await tick();
  assert.equal(h.document.querySelector('[data-id="666"]'), null);
});

test('a section started before the first sign-in settled ends with that sign-in, leaving nothing behind', async t => {
  // Silent adoption runs no reset handlers: only the session epoch says the render is obsolete.
  const lookup = deferred();
  const h = setup(t, { hash: '#/details?id=x', html: DETAIL_PAGE, user: null });
  const signals = [];
  const controller = h.JE.discoveryBase.createDiscovery({
    key: 'demo', mode: 'one-shot', logLabel: 'Demo', configKey: 'JellyseerrShowTagDiscovery',
    getIdFromUrl: () => 'x',
    async renderOneShot({ signal, waitForPageReady }) {
      signals.push(signal);
      const page = await waitForPageReady(signal);
      const section = h.document.createElement('div');
      section.className = 'jellyseerr-demo-discovery-section';
      page.appendChild(section);
      await lookup.promise;
      return !signal.aborted;
    }
  });
  const rendering = controller.render();
  await until(() => h.section('demo'), 'section in progress');
  h.who.user = 'user-a';
  h.JE.session.checkNow('test');
  assert.equal(signals[0].aborted, true);
  lookup.resolve();
  await rendering;
  assert.equal(h.section('demo'), null);
});

test('DISCOVERY-RECOMMENDATIONS-005: a failed genre list is retried rather than remembered as no genres', async t => {
  let failing = true;
  const list = value => () => failing ? new Error('tmdb down') : value;
  const h = setup(t, { hash: '#/list?genreId=g1', routes: [
    [`${API}/genre/g1`, { name: 'Comedy' }],
    [`${API}/tmdb/genres/tv`, list(COMEDY[1])], [`${API}/tmdb/genres/movie`, list(COMEDY_MOVIES[1])],
    [`${API}/jellyseerr/discover/tv/genre/35?page=1`, feed([1], 'tv', 1)],
    [`${API}/jellyseerr/discover/movies/genre/36?page=1`, feed([], 'movie', 1)]
  ] });
  h.JE.requestManager.CONFIG.retry.maxAttempts = 1;
  h.load('jellyseerr/discovery/genre-discovery.js');
  await until(() => h.calls.filter(call => call.path.includes('tmdb/genres/')).length >= 2, 'the failed lists');
  await tick();
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(h.section('genre'), null);
  failing = false;
  h.window.location.hash = '#/list?genreId=g1&page=2';
  await until(() => cardsOf(h).length === 1, 'section after the outage');
});

test('DISCOVERY-RECOMMENDATIONS-006: a filmography whose first chunk is entirely hidden still appears', async t => {
  const credits = Array.from({ length: 45 }, (_, index) => ({ id: index + 1, mediaType: 'movie' }));
  const h = setup(t, { hash: '#/details?id=p1', html: DETAIL_PAGE, items: { p1: { Id: 'p1', Type: 'Person' } }, routes: [
    [`${API}/person/p1`, { name: 'Ann', tmdbId: '7' }],
    [`${API}/jellyseerr/person/7/combined_credits`, { cast: credits, crew: [] }]
  ] });
  h.JE.hiddenContent = { filterJellyseerrResults: results => results.filter(item => item.id > 40) };
  h.load('jellyseerr/discovery/person-discovery.js');
  await until(() => h.section('person'), 'person section');
  assert.deepEqual(ids(h.section('person')), [41, 42, 43, 44, 45]);
  assert.equal(h.section('person').querySelector('.sectionTitle').textContent, 'More with Ann');
});

test('person credits merge cast and crew once, sort client-side and rebuild for a filter', async t => {
  const h = setup(t, { hash: '#/details?id=p1', html: DETAIL_PAGE, items: { p1: { Id: 'p1', Type: 'Person' } }, routes: [
    [`${API}/person/p1`, { name: 'Ann', tmdbId: null }],
    [`${API}/tmdb/search/person`, { results: [
      { id: 9, name: 'Ann', mediaType: 'person' }, { id: 8, name: 'Ann', mediaType: 'person', profilePath: '/x.jpg', knownFor: [1] },
      { id: 7, name: 'Annie', mediaType: 'person', profilePath: '/y.jpg', knownFor: [1, 2, 3, 4] }, { id: 6, name: 'Ann', mediaType: 'movie' }
    ] }],
    [`${API}/jellyseerr/person/8/combined_credits`, {
      cast: [{ id: 1, mediaType: 'movie', voteAverage: 5, releaseDate: '2001-01-01' }, { id: 2, mediaType: 'tv', voteAverage: 9, firstAirDate: '2005-01-01' }],
      crew: [{ id: 1, mediaType: 'movie' }, { mediaType: 'tv' }, { id: 3, mediaType: 'movie', voteAverage: 7, releaseDate: '1999-01-01' }]
    }]
  ] });
  h.load('jellyseerr/discovery/person-discovery.js');
  await until(() => h.section('person'), 'person section');
  const section = h.section('person');
  assert.deepEqual(ids(section), [2, 1, 3], 'mixed interleaves series and movies');
  const select = section.querySelector('.jellyseerr-sort-select');
  const sortBy = value => {
    select.value = value;
    select.dispatchEvent(new h.window.Event('change'));
  };
  sortBy('release_date.desc');
  assert.deepEqual(ids(section), [2, 1, 3], 'series use their first air date');
  sortBy('vote_average.desc');
  assert.deepEqual(ids(section), [2, 3, 1]);
  section.querySelector('[data-mode="movies"]').click();
  assert.deepEqual(ids(section), [3, 1], 'sort survives the filter rebuild');
  sortBy('release_date.asc');
  assert.deepEqual(ids(section), [3, 1]);
  sortBy('release_date.desc');
  assert.deepEqual(ids(section), [1, 3]);
});

test('a failed filmography offers a retry that repeats the lookup', async t => {
  let failing = true;
  const h = setup(t, { hash: '#/details?id=p1', html: DETAIL_PAGE, items: { p1: { Id: 'p1', Type: 'Person' } }, routes: [
    [`${API}/person/p1`, { name: 'Ann', tmdbId: '7' }],
    [`${API}/jellyseerr/person/7/combined_credits`, () => failing ? new Error('parental_pending') : { cast: [{ id: 5, mediaType: 'movie' }] }]
  ], expectedConsoleErrors: ['Error fetching credits', 'Error rendering person discovery'] });
  h.JE.requestManager.CONFIG.retry.maxAttempts = 1;
  h.load('jellyseerr/discovery/person-discovery.js');
  await until(() => h.document.querySelector('.je-retry-row button'), 'retry button');
  failing = false;
  h.document.querySelector('.je-retry-row button').click();
  await until(() => ids(h.document.body).includes(5), 'retried section');
  assert.equal(h.document.querySelector('.je-retry-row'), null);
});

test('DISCOVERY-RECOMMENDATIONS-007: a tag holding a literal percent sign keeps its section', async t => {
  const h = setup(t, { hash: `#/list?type=tag&tag=${encodeURIComponent('100% Wolf')}`, routes: [
    [`${API}/tmdb/search/keyword`, { results: [{ id: 5, name: 'other' }, { id: 6, name: '100% wolf' }] }],
    [`${API}/jellyseerr/discover/tv/keyword/6?page=1`, feed([1], 'tv', 1)],
    [`${API}/jellyseerr/discover/movies/keyword/6?page=1`, feed([2], 'movie', 1)]
  ] });
  h.load('jellyseerr/discovery/tag-discovery.js');
  await until(() => h.section('tag') && ids(h.section('tag')).length === 2, 'tag section');
  assert.equal(h.section('tag').querySelector('.sectionTitle').textContent, 'More with the tag - "100% Wolf"');
});

test('DISCOVERY-RECOMMENDATIONS-010: a tag keyword resolved for one account is not reused for the next', async t => {
  const h = setup(t, { hash: '#/list?type=tag&tag=heist', routes: [
    [`${API}/tmdb/search/keyword`, { results: [{ id: 6, name: 'heist' }] }],
    [`${API}/jellyseerr/discover/tv/keyword/6?page=1`, feed([1], 'tv', 1)],
    [`${API}/jellyseerr/discover/movies/keyword/6?page=1`, feed([2], 'movie', 1)]
  ] });
  h.load('jellyseerr/discovery/tag-discovery.js');
  await until(() => h.section('tag') && ids(h.section('tag')).length === 2, 'first account');
  h.switchUser('user-b');
  h.window.location.hash = '#/list?type=tag&tag=heist&again=1';
  await until(() => h.section('tag') && ids(h.section('tag')).length === 2, 'second account');
  const searches = h.calls.filter(call => call.path.includes('search/keyword')).map(call => call.user);
  assert.deepEqual(searches, ['user-a', 'user-b']);
});

test('DISCOVERY-RECOMMENDATIONS-008: studio names match networks by whole words, never by fragments', async t => {
  const h = setup(t, { hash: '#/list?studioId=s1', config: { JellyseerrShowNetworkDiscovery: true, TmdbEnabled: true }, routes: [
    [`${API}/studio/s1`, { name: 'Skydance Media', tmdbId: '82819' }],
    [`${API}/jellyseerr/discover/tv/studio/82819?page=1`, feed([1], 'tv', 1)],
    [`${API}/jellyseerr/discover/movies/studio/82819?page=1`, feed([2], 'movie', 1)]
  ] });
  h.load('jellyseerr/discovery/network-discovery.js');
  await until(() => h.section('network') && ids(h.section('network')).length === 2, 'studio section');
  assert.equal(h.calls.some(call => call.path.includes('discover/tv/network/')), false, 'Skydance is not the Sky network');
  assert.equal(h.section('network').querySelector('.sectionTitle').textContent, 'More from Skydance Media');
});

test('DISCOVERY-RECOMMENDATIONS-008: a blank studio name matches no network at all', async t => {
  const h = setup(t, { hash: '#/list?studioId=s1', config: { JellyseerrShowNetworkDiscovery: true }, routes: [
    [`${API}/studio/s1`, { name: '   ', tmdbId: null }], [`${API}/tmdb/search/company`, { results: [] }]
  ] });
  h.load('jellyseerr/discovery/network-discovery.js');
  await until(() => h.calls.some(call => call.path.includes('search/company')), 'company search');
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(h.section('network'), null);
  assert.equal(h.calls.some(call => call.path.includes('discover/')), false);
});

test('a known network reads its series by network and its movies by the company of that name', async t => {
  const h = setup(t, { hash: '#/list?studioId=s1', config: { JellyseerrShowNetworkDiscovery: true }, routes: [
    [`${API}/studio/s1`, { name: 'HBO', tmdbId: null }],
    [`${API}/tmdb/search/company`, { results: [{ id: 3268, name: 'HBO', origin_country: 'US', logo_path: '/x.png' }, { id: 1, name: 'HBO', origin_country: 'BR' }] }],
    [`${API}/jellyseerr/discover/tv/network/49?page=1`, feed([1], 'tv', 1)],
    [`${API}/jellyseerr/discover/movies/studio/3268?page=1`, feed([2], 'movie', 1)]
  ] });
  h.load('jellyseerr/discovery/network-discovery.js');
  await until(() => h.section('network') && ids(h.section('network')).length === 2, 'network section');
  assert.equal(h.section('network').querySelectorAll('.jellyseerr-filter-btn').length, 3);
});

test('a streaming brand never falls back to a different company of a similar name', async t => {
  const h = setup(t, { hash: '#/list?studioId=s1', config: { JellyseerrShowNetworkDiscovery: true }, routes: [
    [`${API}/studio/s1`, { name: 'Peacock+', tmdbId: null }],
    [`${API}/tmdb/search/company`, { results: [{ id: 99, name: 'Peacock Pictures' }] }],
    [`${API}/jellyseerr/discover/tv/network/3353?page=1`, feed([1], 'tv', 1)]
  ] });
  h.load('jellyseerr/discovery/network-discovery.js');
  await until(() => h.section('network') && ids(h.section('network')).length === 1, 'network section');
  assert.equal(h.calls.some(call => call.path.includes('movies/studio/')), false);
});

test('network discovery is opt-in and the other sections honour an explicit false', async t => {
  const h = setup(t, { hash: '#/list?studioId=s1', routes: [[`${API}/studio/s1`, { name: 'HBO' }]] });
  h.load('jellyseerr/discovery/network-discovery.js');
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(h.calls.length, 0);
  const g = setup(t, { hash: '#/list?genreId=g1', config: { JellyseerrShowGenreDiscovery: false } });
  g.load('jellyseerr/discovery/genre-discovery.js');
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(g.calls.filter(call => call.path.includes('/genre/')).length, 0);
});

test('an inactive Seerr user gets no section and no feed requests', async t => {
  const h = loadGenre(t, { status: { active: false } });
  h.load('jellyseerr/discovery/genre-discovery.js');
  await until(() => h.calls.some(call => call.path.includes(`${API}/genre/g1`)), 'genre lookup');
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(h.section('genre'), null);
  assert.equal(h.calls.some(call => call.path.includes('discover/')), false);
});

test('collection discovery lists the missing movies oldest first with its count, through the shared cards', async t => {
  const h = setup(t, { hash: '#/details?id=b1', html: DETAIL_PAGE, items: { b1: { Id: 'b1', Type: 'BoxSet' } }, routes: [
    [`${API}/boxset/b1`, { name: 'Trilogy', tmdbId: '10' }]
  ] });
  h.JE.jellyseerrAPI.fetchCollectionDetails = async id => {
    assert.equal(id, 10);
    return { parts: [
      { id: 1, releaseDate: '2010-01-01', mediaInfo: { status: 5 } },
      { id: 2, releaseDate: '2012-01-01', mediaInfo: { status: 2 } },
      { id: 3, releaseDate: '2008-01-01' }
    ] };
  };
  h.load('jellyseerr/discovery/collection-discovery.js');
  await until(() => h.section('collection'), 'collection section');
  const section = h.section('collection');
  assert.equal(section.parentElement.className, 'detailPageContent');
  assert.equal(section.querySelector('.sectionTitle').textContent, 'Missing from Trilogy (1/3)');
  assert.deepEqual(ids(section), [3, 2]);
  assert.equal(section.querySelector('.card').getAttribute('data-media-type'), 'movie');
});

test('DISCOVERY-RECOMMENDATIONS-009: leaving collection discovery early stops the page wait', async t => {
  const h = setup(t, { hash: '#/details?id=b1', html: '<div class="page hide" id="loading"></div>', items: { b1: { Id: 'b1', Type: 'BoxSet' } },
    status: { active: false }, routes: [[`${API}/boxset/b1`, { name: 'Trilogy', tmdbId: '10' }]] });
  const live = new Set();
  let started = 0;
  const { setInterval: realSet, clearInterval: realClear } = h.window;
  h.window.setInterval = (fn, ms, ...rest) => {
    const id = realSet.call(h.window, fn, ms, ...rest);
    if (ms === 100) { started++; live.add(id); }
    return id;
  };
  h.window.clearInterval = id => { live.delete(id); realClear.call(h.window, id); };
  t.after(() => [...live].forEach(id => realClear.call(h.window, id)));
  h.load('jellyseerr/discovery/collection-discovery.js');
  await until(() => h.calls.some(call => call.path.includes('/boxset/b1')), 'boxset lookup');
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(started, 1, 'the page wait ran');
  assert.equal(live.size, 0, 'and stopped with the early exit');
});

test('DISCOVERY-RECOMMENDATIONS-011: a detail section waits for the new page instead of joining the outgoing one', async t => {
  const h = setup(t, { hash: '#/details?id=other', items: { p2: { Id: 'p2', Type: 'Person' } },
    html: '<div class="page itemDetailPage" id="old"><div class="detailPageContent"></div></div>', routes: [
      [`${API}/person/p2`, { name: 'Bea', tmdbId: '2' }],
      [`${API}/jellyseerr/person/2/combined_credits`, { cast: [{ id: 1, mediaType: 'movie' }] }]
    ] });
  h.load('jellyseerr/discovery/person-discovery.js');
  h.window.location.hash = '#/details?id=p2';
  await until(() => h.calls.some(call => call.path.includes('combined_credits')), 'credits');
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(h.document.querySelector('#old .jellyseerr-person-discovery-section'), null, 'the outgoing page stays clean');
  h.document.querySelector('#old').classList.add('hide');
  h.document.body.insertAdjacentHTML('beforeend', '<div class="page itemDetailPage" id="new"><div class="detailPageContent"></div></div>');
  await until(() => h.document.querySelector('#new .jellyseerr-person-discovery-section'), 'section on the new page');
  assert.equal(h.document.querySelectorAll('.jellyseerr-person-discovery-section').length, 1);
});

test('navigation removes the section, releases its work and a return renders exactly one', async t => {
  const h = loadGenre(t);
  h.load('jellyseerr/discovery/genre-discovery.js');
  await until(() => cardsOf(h).length === 4, 'first visit');
  h.window.location.hash = '#/home';
  await until(() => !h.section('genre'), 'section removed');
  assert.equal(h.armed.load, null, 'engine cleaned up');
  h.window.location.hash = '#/list?genreId=g1';
  await until(() => cardsOf(h).length === 4, 'second visit');
  assert.equal(h.document.querySelectorAll('.jellyseerr-genre-discovery-section').length, 1);
});

test('DISCOVERY-RECOMMENDATIONS-018: a controller starts once and dispose removes every listener it installed', async t => {
  const h = loadGenre(t);
  const counts = {};
  const original = h.window.addEventListener.bind(h.window);
  const remove = h.window.removeEventListener.bind(h.window);
  h.window.addEventListener = (type, fn, options) => { counts[type] = (counts[type] ?? 0) + 1; original(type, fn, options); };
  h.window.removeEventListener = (type, fn, options) => { counts[type] = (counts[type] ?? 0) - 1; remove(type, fn, options); };
  let resolved = 0;
  const controller = h.JE.discoveryBase.createDiscovery({
    key: 'demo', mode: 'one-shot', logLabel: 'Demo', configKey: 'JellyseerrShowTagDiscovery',
    getIdFromUrl: () => null, renderOneShot: async () => { resolved++; return true; }
  });
  controller.start();
  controller.start();
  assert.deepEqual(plain(counts), { 'je:navigate': 1, hashchange: 1, popstate: 1 });
  controller.dispose();
  controller.dispose();
  assert.deepEqual(plain(counts), { 'je:navigate': 0, hashchange: 0, popstate: 0 });
  controller.handlePageNavigation();
  assert.equal(resolved, 0);
});

test('hidden, duplicate, in-library and blocklisted results follow the admin settings', t => {
  const h = setup(t, { hash: '#/home', config: { JellyseerrExcludeLibraryItems: true, JellyseerrExcludeBlocklistedItems: true } });
  const surfaces = [];
  h.JE.hiddenContent = { filterJellyseerrResults(results, surface) { surfaces.push(surface); return results.filter(item => item.id !== 2); } };
  const fragment = h.JE.discoveryFilter.createCardsFragment([
    { id: 1, mediaType: 'movie' }, { id: 1, mediaType: 'movie' }, { id: 1, mediaType: 'tv' }, { id: 2, mediaType: 'movie' },
    { id: 3, mediaType: 'movie', mediaInfo: { jellyfinMediaId: 'abc' } }, { id: 4, mediaType: 'movie', mediaInfo: { status: 6 } }
  ], { cardClass: 'overflowPortraitCard' });
  assert.deepEqual([...fragment.children].map(card => `${card.dataset.id}:${card.dataset.mediaType}`), ['1:movie', '1:tv']);
  assert.deepEqual(surfaces, ['discovery']);
  assert.ok(fragment.firstElementChild.classList.contains('overflowPortraitCard'));
  assert.equal(fragment.firstElementChild.classList.contains('portraitCard'), false);
});

test('an in-library card links to the Jellyfin item in the same tab', t => {
  const h = setup(t, { hash: '#/home' });
  const fragment = h.JE.discoveryFilter.createCardsFragment([{ id: 1, mediaType: 'movie', title: 'Owned', mediaInfo: { jellyfinMediaId: 'abc' } }]);
  const card = fragment.firstElementChild;
  const link = card.querySelector('.cardText-first a');
  assert.equal(card.dataset.jellyfinMediaId, 'abc');
  assert.equal(card.dataset.libraryItem, 'true');
  assert.ok(card.classList.contains('jellyseerr-card-in-library'));
  assert.equal(link.textContent, 'Owned');
  assert.equal(link.getAttribute('href'), '#!/details?id=abc');
  assert.equal(link.hasAttribute('target'), false);
  assert.equal(link.hasAttribute('rel'), false);
});

test('a batch dropped mid-build keeps what is in and releases the rest; a failure takes the batch out', async t => {
  const h = setup(t, { hash: '#/home', html: '<div id="row"></div>', expectedConsoleErrors: [] });
  const row = h.document.querySelector('#row');
  const make = id => Object.assign(h.document.createElement('div'), { className: 'card', id: `c${id}` });
  const realNow = h.window.performance.now.bind(h.window.performance);
  let clock = 0;
  h.window.performance.now = () => (clock += 100);
  let current = true;
  const dropped = h.JE.discoveryFilter.appendInSlices(row, [1, 2, 3, 4], id => { if (id === 3) current = false; return make(id); },
    { syncCount: 1, isCurrent: () => current });
  assert.equal(await dropped, 1);
  assert.deepEqual([...row.children].map(card => card.id), ['c1']);
  row.replaceChildren();
  await assert.rejects(h.JE.discoveryFilter.appendInSlices(row, [1, 2, 3], id => { if (id === 2) throw new Error('bad card'); return make(id); }, { syncCount: 1 }), /bad card/);
  assert.equal(row.children.length, 0, 'cards already in are taken out again');
  h.window.performance.now = realNow;
});

test('a list wait prefers the shown view, skips the outgoing page and gives up only when aborted', async t => {
  const h = setup(t, { hash: '#/home' });
  const stale = h.document.querySelector('#list');
  const wait = h.JE.discoveryFilter;
  const controller = new h.window.AbortController();
  const pending = wait.waitForPageReady(controller.signal, { isStalePage: page => page === stale });
  await tick();
  controller.abort();
  assert.equal(await pending, null);
  const view = h.document.createElement('div');
  view.innerHTML = '<div class="itemsContainer"></div>';
  h.document.body.appendChild(view);
  assert.equal(await wait.waitForPageReady(undefined, { getView: () => view, isStalePage: () => true }), view.firstElementChild);
  assert.equal(await wait.waitForPageReady(undefined, {}), stale.querySelector('.itemsContainer'));
});

test('session caches are per server and per user, expire, and reject what they did not write', t => {
  const h = setup(t, { hash: '#/home' });
  const isNumber = value => typeof value === 'number';
  const cache = h.JE.discoveryFilter.createSessionCache('demo', isNumber);
  h.window.sessionStorage.setItem('je-discovery-resolution:server-a:demo', '{}');
  cache.scope().set('k', 1);
  assert.equal(cache.scope().get('k'), 1);
  assert.equal(h.window.sessionStorage.getItem('je-discovery-resolution:server-a:demo'), null, 'server-only entries are purged');
  h.switchUser('user-b');
  assert.equal(cache.scope().has('k'), false);
  h.switchUser('user-a', 'server-b');
  assert.equal(cache.scope().has('k'), false);
  h.switchUser('user-a', 'server-a');
  const later = h.JE.discoveryFilter.createSessionCache('demo', isNumber);
  assert.equal(later.scope().get('k'), 1, 'a reload in the tab reuses the stored entry');
  const key = 'je-discovery-resolution-v2:server-a:user-a:demo';
  const stored = JSON.parse(h.window.sessionStorage.getItem(key));
  stored.entries.bad = { value: 'text', storedAt: Date.now() };
  stored.entries.old = { value: 2, storedAt: Date.now() - 31 * 60 * 1000 };
  h.window.sessionStorage.setItem(key, JSON.stringify(stored));
  const reread = h.JE.discoveryFilter.createSessionCache('demo', isNumber);
  assert.equal(reread.scope().has('bad'), false);
  assert.equal(reread.scope().has('old'), false);
  h.window.sessionStorage.setItem(key, 'not json');
  assert.equal(h.JE.discoveryFilter.createSessionCache('demo', isNumber).scope().has('k'), false);
});

test('a scope taken before a user switch stores the late result for the user it was fetched for', t => {
  const h = setup(t, { hash: '#/home' });
  const cache = h.JE.discoveryFilter.createSessionCache('demo', value => typeof value === 'number');
  const scopeA = cache.scope();
  h.switchUser('user-b');
  scopeA.set('k', 1);
  assert.equal(cache.scope().has('k'), false);
  h.switchUser('user-a');
  assert.equal(cache.scope().get('k'), 1);
  h.who.server = null;
  h.JE.session.checkNow('test');
  const memoryOnly = cache.scope();
  memoryOnly.set('m', 2);
  assert.equal(memoryOnly.get('m'), 2);
  assert.equal([...Array(h.window.sessionStorage.length).keys()].some(i => h.window.sessionStorage.key(i).includes('v2::')), false);
});

test('a genre list is stored only for the identity that fetched it and bad stored copies are ignored', async t => {
  const pending = deferred();
  const h = setup(t, { hash: '#/home', routes: [[`${API}/tmdb/genres/tv`, pending.promise], [`${API}/tmdb/genres/movie`, COMEDY_MOVIES[1]]] });
  const late = h.JE.discoveryFilter.fetchTmdbGenreList('tv', {});
  const settled = late.catch(error => error);
  await tick();
  h.switchUser('user-b');
  pending.resolve(COMEDY[1]);
  assert.equal((await settled).name, 'AbortError');
  assert.equal(h.window.sessionStorage.getItem('je-tmdb-genres:server-a:user-a:tv'), null);
  assert.deepEqual(plain(await h.JE.discoveryFilter.fetchTmdbGenreList('movie', {})), COMEDY_MOVIES[1]);
  const stored = h.window.sessionStorage.getItem('je-tmdb-genres:server-a:user-b:movie');
  assert.ok(stored);
  h.window.sessionStorage.setItem('je-tmdb-genres:server-a:user-b:tv', JSON.stringify({ storedAt: Date.now(), genres: [{ id: 'x' }] }));
  h.table.set(`${API}/tmdb/genres/tv`, COMEDY[1]);
  assert.deepEqual(plain(await h.JE.discoveryFilter.fetchTmdbGenreList('tv', {})), COMEDY[1]);
  assert.equal(h.calls.filter(call => call.path.endsWith('genres/tv')).length, 2);
});

test('the Jellyfin 12 token travels in the Authorization header of the identity that sent it', async t => {
  const h = setup(t, { hash: '#/home', routes: [['/x', { ok: 1 }]] });
  assert.deepEqual(plain(await h.JE.discoveryFilter.fetchWithManagedRequest('/x', 'demo', {})), { ok: 1 });
  const { headers } = h.calls[0];
  assert.equal(headers.Authorization, 'MediaBrowser Token="token-user-a"');
  assert.equal(headers['X-Jellyfin-User-Id'], 'user-a');
  await h.JE.discoveryFilter.fetchWithManagedRequest('/x', 'demo', {});
  assert.equal(h.calls.length, 1, 'a repeat is served from the managed cache');
});

test('filter and sort primitives keep their published contract', t => {
  const h = setup(t, { hash: '#/home' });
  const f = h.JE.discoveryFilter;
  assert.deepEqual(plain(f.interleaveArrays([1, 2, 3], ['a'])), [1, 'a', 2, 3]);
  assert.deepEqual(plain(f.interleaveArrays([1], ['a', 'b', 'c'])), [1, 'a', 'b', 'c']);
  assert.deepEqual(plain(f.interleaveArrays([], [])), []);
  assert.equal(f.getFilterMode('demo'), 'mixed');
  f.setFilterMode('demo', 'nonsense');
  assert.equal(f.getFilterMode('demo'), 'mixed');
  f.setFilterMode('demo', 'tv');
  assert.equal(f.getFilterMode('demo'), 'tv');
  f.resetFilterMode('demo');
  assert.equal(f.getFilterMode('demo'), 'mixed');
  f.setSortMode('demo', 'release_date.asc');
  assert.equal(f.getTvSortMode('demo'), 'first_air_date.asc');
  f.resetSortMode('demo');
  assert.equal(f.getSortMode('demo'), '');
  assert.equal(f.hasBothTypes([1], []), false);
  assert.equal(f.hasBothTypes([1], [2]), true);
  assert.equal(f.resultHasBothTypes([{ mediaType: 'tv' }, { mediaType: 'movie' }]), true);
  assert.equal(f.resultHasBothTypes([{ mediaType: 'tv' }]), false);
  assert.deepEqual(plain(f.filterByMediaType([{ mediaType: 'tv' }, { mediaType: 'movie' }], 'movies')), [{ mediaType: 'movie' }]);
  assert.equal(h.document.querySelectorAll('#jellyseerr-filter-styles').length, 1);
  const header = f.createSectionHeader('T', 'demo', true, () => {}, () => {});
  assert.equal(header.querySelector('.sectionTitle').textContent, 'T');
  assert.deepEqual([...header.querySelectorAll('button')].map(button => button.textContent), ['All', 'Movie', 'Series']);
  assert.deepEqual([...header.querySelectorAll('option')].map(option => option.textContent), ['Popular', 'Top Rated', 'Newest', 'Oldest']);
});
