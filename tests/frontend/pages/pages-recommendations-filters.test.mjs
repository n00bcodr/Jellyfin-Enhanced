// The Recommendations page's filters (All | Movies | Series and the "More from" sections' Filters button), shared
// with its category pages, and its address on Home: the filters and the open category are in it, so a link, a
// reload, Back and Forward show what was set. Real shipped scripts on the real core runtime (navigation, session,
// lifecycle, helpers, request manager); only Seerr's answers, its card renderer and the genre lists are fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, englishT, jsonResponse, plain } from '../helpers/harness.mjs';

const RUNTIME = ['core/navigation.js', 'core/session.js', 'core/lifecycle.js', 'core/dom-observer.js', 'core/ui-kit.js',
  'core/api-client.js', 'enhanced/helpers.js', 'jellyseerr/seerr-status.js', 'jellyseerr/request-manager.js',
  'jellyseerr/seamless-scroll.js', 'jellyseerr/discovery/discovery-styles.js', 'jellyseerr/discovery/discovery-busy.js',
  'jellyseerr/discovery/discovery-menu.js', 'jellyseerr/discovery/discovery-roles.js', 'jellyseerr/discovery/discovery-section.js',
  'jellyseerr/discovery/discovery-filters.js', 'jellyseerr/discovery/discovery-filter-panel.js',
  'jellyseerr/discovery/discovery-filter-utils.js', 'jellyseerr/discovery/discovery-address.js'];
const RECOMMENDATIONS = ['styles', 'catalog', 'data', 'render', 'page', 'category', 'init']
  .map(name => `jellyseerr/recommendations/recommendations-${name}.js`);
const ORIGIN = 'http://jellyfin.test';
const DISCOVER = '/JellyfinEnhanced/jellyseerr/discover';
const TAB = '#/home?tab=2&jeTab=recommendations';
const HOME = '<div class="mainAnimatedPages"><div class="page mainAnimatedPage" id="indexPage"><div id="tab"></div></div></div>';

async function until(condition, label = 'condition') {
  const deadline = performance.now() + 3000;
  while (!condition() && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(condition(), `${label} was not reached`);
}
const scored = (rows, totalPages = 1) => ({ results: rows.map(([id, mediaType, voteAverage = 5]) => ({ id, mediaType, voteAverage })), totalPages });
const today = () => { const now = new Date(); return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`; };

function setup(t, { hash = TAB, routes = [], config = {} } = {}) {
  const calls = [];
  const table = new Map(routes);
  const h = createHarness({
    html: HOME, url: `${ORIGIN}/web/index.html${hash}`,
    JE: { internals: {}, t: englishT, pluginConfig: { RecommendationsPageEnabled: true, RecommendationsUseNativeTab: true, ...config } },
    fetch: async url => {
      const path = url.replace(ORIGIN, '');
      calls.push(path);
      // (A feed with no fixture has nothing: an empty page.)
      return jsonResponse(table.has(path) ? table.get(path) : { results: [], totalPages: 1 });
    }
  });
  t.after(() => h.close());
  for (const file of RUNTIME) h.load(file);
  h.JE.escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
  h.JE.cdn = { selfhst: path => `http://cdn.test/${path}` };
  h.JE.jellyseerrAPI = { checkUserStatus: async () => ({ active: true }), fetchGenreSlider: async () => [] };
  h.JE.jellyseerrUI = {
    createJellyseerrCard(item) {
      const card = h.document.createElement('div');
      card.className = 'card portraitCard';
      card.dataset.id = String(item.id);
      return card;
    },
    releasePosters() {}
  };
  h.JE.discoveryFilter.setupInfiniteScroll = () => {};
  h.JE.discoveryFilter.cleanupScrollObserver = () => {};
  let navigations = 0;
  h.window.addEventListener('je:navigate', () => { navigations++; });
  const P = () => h.JE.internals.recommendationsPage;
  return {
    ...h, calls, table, P, navigations: () => navigations,
    load: () => { for (const file of RECOMMENDATIONS) h.load(file); return P(); },
    tab: () => h.document.getElementById('tab'),
    category: () => h.document.getElementById('je-recommendations-category-page'),
    rows: () => [...h.document.querySelectorAll('#tab .je-recommendations-section h2')].map(e => e.textContent),
    cards: root => [...root.querySelectorAll('.card[data-id]')].map(card => Number(card.dataset.id)),
    categoryCards: () => [...h.document.querySelectorAll('#je-recommendations-category-container .card')].map(card => Number(card.dataset.id)),
    said: root => [...root.querySelectorAll('.jellyseerr-filters-token')].map(token => token.textContent),
    hash: () => h.window.location.hash
  };
}
const loaded = h => !h.tab().querySelector('.je-skeleton-rows, [aria-label="Loading recommendations…"]') && h.rows().length > 0;

test("a link's filters narrow every row: its kind's rows only, Trending by what its titles say, upcoming as discover from today", async t => {
  const h = setup(t, { hash: `${TAB}&jeType=movies&jeScore=7..`, routes: [
    [`${DISCOVER}/trending?page=1`, scored([[1, 'movie', 8], [2, 'tv', 9], [3, 'movie', 5]])],
    [`${DISCOVER}/movies?page=1&voteAverageGte=7`, scored([[11, 'movie', 7.5]])],
    [`${DISCOVER}/movies?page=1&primaryReleaseDateGte=${today()}&voteAverageGte=7`, scored([[12, 'movie', 7.1]])]
  ] });
  const P = h.load();
  P.renderInto(h.tab());
  await until(() => loaded(h), 'rows');
  assert.deepEqual(h.rows(), ['Trending', 'Popular Movies', 'Upcoming Movies', 'Studios']);
  assert.deepEqual(h.cards(h.tab()), [1, 11, 12], 'Trending keeps its movie scored 7 or more');
  assert.equal(h.calls.some(path => /\/discover\/tv(\/|\?)/.test(path)), false, 'no series feed is asked for');
  assert.equal(h.tab().querySelector('.je-reco-tools .emby-tab-button-active').dataset.mode, 'movies');
  assert.equal(h.tab().querySelector('.je-reco-tools .jellyseerr-filters-btn').hasAttribute('data-on'), true);
  assert.deepEqual(h.said(h.tab()), ['Score from 7']);
  assert.equal(h.hash(), `${TAB}&jeType=movies&jeScore=7..`, 'already said as the page writes it');
});

test("a choice on the tab replaces its address (no history entry, no navigation) and fills the rows again", async t => {
  const h = setup(t, { routes: [[`${DISCOVER}/tv?page=1`, scored([[21, 'tv']])], [`${DISCOVER}/movies?page=1`, scored([[31, 'movie']])]] });
  const P = h.load();
  P.renderInto(h.tab());
  await until(() => loaded(h), 'rows');
  const length = h.window.history.length;
  const before = h.navigations();
  h.tab().querySelector('.je-reco-tools [data-mode="tv"]').click();
  assert.equal(h.hash(), `${TAB}&jeType=series`);
  assert.equal(h.window.history.length, length, 'Back is not a step per filter');
  assert.equal(h.navigations(), before, 'not a navigation for the rest of the plugin');
  await until(() => loaded(h) && !h.rows().includes('Popular Movies'), 'series rows');
  assert.deepEqual(h.rows(), ['Popular TV Shows', 'Networks']);
  assert.deepEqual(h.cards(h.tab()), [21]);
  h.tab().querySelector('.je-reco-tools [data-mode="mixed"]').click();
  assert.equal(h.hash(), TAB, 'nothing set: nothing of the filters in the address');
});

test('a filter that leaves the tab nothing says so, and Clear filters brings everything back', async t => {
  const h = setup(t, { hash: `${TAB}&jeLanguage=xx`, routes: [[`${DISCOVER}/movies?page=1`, scored([[31, 'movie']])]] });
  const P = h.load();
  P.renderInto(h.tab());
  await until(() => h.tab().querySelector('.je-reco-filters-none'), 'the note');
  const note = h.tab().querySelector('.je-reco-filters-none');
  assert.match(note.textContent, /Nothing matches these filters\./);
  note.querySelector('button').click();
  await until(() => loaded(h) && h.rows().includes('Popular Movies'), 'everything again');
  assert.deepEqual(plain(h.JE.discoveryFilter.getFilters('recommendations')), {});
  assert.deepEqual(h.said(h.tab()), [], 'nothing said to be set');
  assert.equal(h.hash(), TAB);
});

test('on Home a category names itself in the address: Back and Forward move between the tab and its categories', async t => {
  const h = setup(t, { routes: [[`${DISCOVER}/trending?page=1`, scored([[1, 'movie']])], [`${DISCOVER}/movies?page=1`, scored([[2, 'movie']])]] });
  const P = h.load();
  const length = h.window.history.length;
  const title = () => h.document.getElementById('je-recommendations-category-title').textContent;
  await P.showCategoryPage('trending');
  assert.equal(h.window.history.length, length + 1, 'one entry');
  assert.equal(h.hash(), `${TAB}&jeCategory=trending`, "the tab's own pairs kept, the category after them");
  // A dialog over it (the More Info modal, at the same address) closing lands back on it: it stays.
  h.window.history.pushState({ dialog: 1 }, '', h.window.location.href);
  h.window.history.back();
  await until(() => h.window.history.state?.jeCategory === true, 'back on the page entry');
  assert.equal(P.state.categoryPageVisible, true, 'the page stays');
  await P.showCategoryPage('movies');
  assert.equal(h.hash(), `${TAB}&jeCategory=movies`);
  h.window.history.back();
  await until(() => title() === 'Trending' && h.categoryCards().join() === '1', 'Back to the first category');
  h.window.history.back();
  await until(() => !P.state.categoryPageVisible, 'Back to the tab');
  assert.equal(h.hash(), TAB);
  assert.equal(h.document.getElementById('indexPage').classList.contains('hide'), false);
  h.window.history.forward();
  await until(() => P.state.categoryPageVisible && h.categoryCards().join() === '1', 'Forward opens it again from its address');
  // Its arrow is Back, to the tab below it.
  h.document.getElementById('je-recommendations-category-back').click();
  await until(() => !P.state.categoryPageVisible, 'the arrow');
  assert.equal(h.hash(), TAB);
});

test("a category link opens filtered and in its order; its arrow keeps the filters for the tab, not the order", async t => {
  const h = setup(t, { hash: `${TAB}&jeCategory=movies&jeScore=7..&jeSort=vote_average.desc`, routes: [
    [`${DISCOVER}/movies?page=1&voteAverageGte=7`, scored([[5, 'movie', 7], [6, 'movie', 9]])]
  ] });
  const P = h.load();
  await until(() => P.state.categoryPageVisible && h.categoryCards().length === 2, 'opened from its address');
  assert.deepEqual(h.categoryCards(), [6, 5], 'in its order');
  assert.match(h.category().querySelector('.jellyseerr-sort-btn').textContent, /Top rated/);
  assert.deepEqual(h.said(h.category()), ['Score from 7']);
  assert.equal(h.document.getElementById('indexPage').classList.contains('hide'), true, 'over Home');
  const length = h.window.history.length;
  h.document.getElementById('je-recommendations-category-back').click();
  await until(() => !P.state.categoryPageVisible, 'the arrow');
  assert.equal(h.hash(), `${TAB}&jeScore=7..`, 'nothing of the tab below it in history: the address goes back to the tab');
  assert.equal(h.window.history.length, length, 'no entry added');
  // An address naming something that is no category is ignored.
  h.window.location.hash = `${TAB}&jeCategory=%3Cscript%3E`;
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(P.state.categoryPageVisible, false);
});

test("filters changed on a category are the tab's too; its entry says them, and Back shows the tab entry's own", async t => {
  const h = setup(t, { hash: `${TAB}&jeScore=9..`, routes: [
    [`${DISCOVER}/movies?page=1`, scored([[2, 'movie']])], [`${DISCOVER}/movies?page=1&voteAverageGte=9`, scored([[3, 'movie', 9.5]])]
  ] });
  const P = h.load();
  P.renderInto(h.tab());
  await until(() => loaded(h), 'rows');
  await P.showCategoryPage('movies');
  assert.equal(h.hash(), `${TAB}&jeCategory=movies&jeScore=9..`, 'opened with the filters');
  assert.deepEqual(h.categoryCards(), [3]);
  const length = h.window.history.length;
  // Taking the score away there replaces the category's entry.
  h.category().querySelector('.jellyseerr-filters-remove').click();
  assert.equal(h.hash(), `${TAB}&jeCategory=movies`);
  assert.equal(h.window.history.length, length);
  await until(() => h.categoryCards().join() === '2', 'reloaded without it');
  h.window.history.back();
  await until(() => !P.state.categoryPageVisible, 'Back to the tab');
  assert.equal(h.hash(), `${TAB}&jeScore=9..`);
  assert.deepEqual(plain(h.JE.discoveryFilter.getFilters('recommendations')).score, ['9', ''], "the tab's entry keeps its own filters");
  await until(() => h.said(h.tab()).join() === 'Score from 9', 'the tab shows them');
});

test('a category opens with the filters, asks Seerr with them, and says when they leave nothing', async t => {
  const h = setup(t, { hash: `${TAB}&jeScore=9..`, routes: [
    [`${DISCOVER}/movies?page=1&voteAverageGte=9`, { results: [], totalPages: 1 }], [`${DISCOVER}/movies?page=1`, scored([[2, 'movie']])]
  ] });
  const P = h.load();
  await P.showCategoryPage('movies');
  const page = h.category();
  assert.ok(page.querySelector('#je-recommendations-category-filters .jellyseerr-filters-btn[data-on]'), 'its Filters button is on');
  assert.deepEqual(h.said(page), ['Score from 9']);
  await until(() => page.querySelector('.je-reco-filters-none'), 'the note');
  assert.deepEqual(h.categoryCards(), []);
  page.querySelector('.je-reco-filters-none button').click();
  await until(() => h.categoryCards().length === 1, 'the titles without the filter');
  assert.equal(page.querySelector('.je-reco-filters-none'), null);
  assert.deepEqual(h.said(page), []);
  assert.equal(h.hash(), `${TAB}&jeCategory=movies`);
});

test('Trending (a feed that takes no filters) keeps its titles by what they say, and has nothing where a filter cannot be checked', async t => {
  const h = setup(t, { hash: `${TAB}&jeGenres=35/35:Comedy`, routes: [
    [`${DISCOVER}/trending?page=1`, { results: [{ id: 1, mediaType: 'movie', genreIds: [35] }, { id: 2, mediaType: 'tv', genreIds: [18] }], totalPages: 1 }]
  ] });
  const P = h.load();
  await P.showCategoryPage('trending');
  await until(() => h.categoryCards().length === 1, 'kept by genre');
  assert.deepEqual(h.categoryCards(), [1]);
  assert.equal(h.calls.some(path => path.startsWith(`${DISCOVER}/trending?page=1&`)), false, 'asked without filters');
  h.JE.discoveryFilter.setFilters('recommendations', { runtime: ['', '90'] });
  await P.showCategoryPage('trending');
  await until(() => h.category().querySelector('.je-reco-filters-none'), 'nothing it can be said to match');
  assert.deepEqual(h.categoryCards(), []);
});

test('off Home a category keeps the same-URL entry, and the page of its own keeps its filters in its address', async t => {
  const h = setup(t, { hash: '#/recommendations', config: { RecommendationsUseNativeTab: false }, routes: [[`${DISCOVER}/movies?page=1`, scored([[2, 'movie']])]] });
  const P = h.load();
  await until(() => P.state.pageVisible && h.document.querySelector('#je-recommendations-page .je-reco-tools'), 'the page');
  h.document.querySelector('#je-recommendations-page .je-reco-tools [data-mode="movies"]').click();
  assert.equal(h.hash(), '#/recommendations?jeType=movies');
  const url = h.window.location.href;
  await P.showCategoryPage('movies');
  assert.equal(h.window.location.href, url, 'the address does not name the category off Home');
  h.window.history.back();
  await until(() => !P.state.categoryPageVisible, "the browser's Back");
});

test("an address's filters that are not of their shape are left out", t => {
  const h = setup(t);
  const address = h.JE.discoveryAddress;
  const said = address.filtersOfHash(`${TAB}&jeType=films&jeScore=abc..11&jeVotes=500..&jeGenres=x:Bad,35/35:Comedy&jeLanguage=english,ko`
    + '&jeRating=movie:US:PG-13&jeServices=8:%3Cb%3ENetflix%3C/b%3E&jeRole=cast,%3Cscript%3E&jeSort=nope', 'en');
  assert.equal(said.mode, 'mixed');
  assert.equal(said.sort, '');
  assert.deepEqual(plain(said.selection), {
    votes: ['500', ''], role: [{ id: 'cast', name: 'Acting' }], genres: [{ id: '35/35', name: 'Comedy' }],
    language: [{ id: 'ko', name: 'Korean' }], rating: [{ id: 'movie:US:PG-13', name: 'PG-13' }],
    services: [{ id: '8', name: '<b>Netflix</b>' }]
  });
  // What is written reads back as the same, after the host's own pairs.
  const written = address.addressWith('#/details?id=1&serverId=s', null, { mode: 'tv', selection: said.selection, sort: 'vote_count.desc' }, true);
  assert.equal(written, '#/details?id=1&serverId=s&jeType=series&jeVotes=500..&jeRole=cast&jeGenres=35/35:Comedy&jeLanguage=ko'
    + '&jeRating=movie:US:PG-13&jeServices=8:%3Cb%3ENetflix%3C%2Fb%3E&jeSort=vote_count.desc');
  assert.deepEqual(plain(address.filtersOfHash(written, 'en').selection), plain(said.selection));
  assert.equal(address.withoutOwn(written), '#/details?id=1&serverId=s');
  assert.equal(address.categoryOfHash(`${TAB}&jeCategory=genre-movie-28`), 'genre-movie-28');
  assert.equal(address.categoryOfHash('#/details?id=1&jeCategory=trending'), null, 'only the Recommendations page has categories');
});

test("a category still resolving its genre is not opened once the viewer has gone elsewhere, nor twice", async t => {
  const h = setup(t);
  let release;
  const names = new Promise(resolve => { release = resolve; });
  h.JE.jellyseerrAPI.fetchGenreSlider = () => names;
  const P = h.load();
  const first = P.showCategoryPage('genre-movie-28');
  h.window.location.hash = '#/details?id=another';
  release([{ id: 28, name: 'Action', backdrops: [] }]);
  await first;
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(P.state.categoryPageVisible, false);
  assert.equal(h.hash(), '#/details?id=another');
  // Two opens at once (the address followed twice): the later one wins, once.
  h.window.location.hash = TAB;
  await new Promise(resolve => setTimeout(resolve, 20));
  const length = h.window.history.length;
  await Promise.all([P.showCategoryPage('genre-movie-28'), P.showCategoryPage('genre-movie-28')]);
  assert.equal(P.state.categoryPageVisible, true);
  assert.equal(h.window.history.length, length + 1, 'one entry');
});

test("a category address with keywords matched by any asks Seerr for either, and the address keeps saying it", async t => {
  const link = `${TAB}&jeCategory=movies&jeGenres=16/16:Animation&jeKeywords=10468:bear,12554:dragon&jeAny=keywords`;
  const h = setup(t, { hash: link, routes: [
    [`${DISCOVER}/movies?page=1&genre=16&keywords=10468%7C12554`, scored([[7, 'movie'], [8, 'movie']])]
  ] });
  const P = h.load();
  await until(() => P.state.categoryPageVisible && h.categoryCards().length === 2, 'opened from its address');
  assert.deepEqual(h.said(h.category()), ['Animation', 'With bear', 'or dragon']);
  assert.equal(h.hash(), link, 'already said as the page writes it');
  // Without jeAny the same keywords are all of them.
  const both = h.JE.discoveryAddress.filtersOfHash(`${TAB}&jeKeywords=10468:bear,12554:dragon`, 'en');
  assert.equal(both.selection.match, undefined);
  // jeAll for services, whose default is any; a match for a list with nothing ticked is not taken.
  const services = h.JE.discoveryAddress.filtersOfHash(`${TAB}&jeServices=8:Netflix,337:Disney&jeAll=services,genres&jeAny=keywords`, 'en');
  assert.deepEqual(plain(services.selection.match), { services: 'all' });
});

test("a category its address asked for, still resolving its genre, is not opened once Back has left its address", async t => {
  const h = setup(t);
  let release;
  const names = new Promise(resolve => { release = resolve; });
  h.JE.jellyseerrAPI.fetchGenreSlider = () => names;
  const P = h.load();
  // A link to the genre's category, followed on Home; Back to the tab before its genre's names come.
  h.window.location.hash = `${TAB}&jeCategory=genre-movie-28`;
  await new Promise(resolve => setTimeout(resolve, 30));
  h.window.history.back();
  await until(() => h.hash() === TAB, 'Back to the tab');
  release([{ id: 28, name: 'Action', backdrops: [] }]);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(P.state.categoryPageVisible, false);
  assert.equal(h.hash(), TAB);
});

test("a genre's category keeps its genre and takes the other genres ticked as any of them (Animation, and Family or Kids)", async t => {
  const link = `${TAB}&jeCategory=genre-tv-16&jeType=series&jeGenres=16/16:Animation,10751/10751:Family,/10762:Kids&jeAny=genres`;
  const h = setup(t, { hash: link, routes: [[`${DISCOVER}/tv/genre/16?page=1`, { totalPages: 1, results: [
    { id: 1, mediaType: 'tv', genreIds: [16, 10751] }, { id: 2, mediaType: 'tv', genreIds: [16] }, { id: 3, mediaType: 'tv', genreIds: [16, 10762] }
  ] }]] });
  h.JE.jellyseerrAPI.fetchGenreSlider = async kind => kind === 'tv' ? [{ id: 16, name: 'Animation', backdrops: [] }] : [];
  const P = h.load();
  await until(() => P.state.categoryPageVisible && h.categoryCards().length === 2, 'opened from its address');
  assert.deepEqual(h.categoryCards(), [1, 3]);
  assert.equal(h.calls.some(path => path.startsWith(`${DISCOVER}/tv/genre/16?page=1&`)), false, 'asked for its own genre only');
  h.category().querySelector('#je-recommendations-category-filters .jellyseerr-filters-btn').click();
  [...h.document.querySelectorAll('.jellyseerr-sort-menu .jellyseerr-menu-group')].find(group => group.textContent.startsWith('Genres')).click();
  await until(() => h.document.querySelector('.jellyseerr-sort-menu .jellyseerr-menu-match'), 'the choice');
  assert.equal(h.document.querySelector('.jellyseerr-sort-menu .jellyseerr-menu-match-lead').textContent, 'Titles in Animation and');
  assert.equal(h.document.querySelector('.jellyseerr-sort-menu .jellyseerr-menu-match [aria-checked="true"]').dataset.match, 'any');
  // Its own genre is always applied (its heading says it): the line and the row speak of the others.
  assert.deepEqual(h.said(h.category()), ['Family', 'or Kids']);
  const row = [...h.document.querySelectorAll('.jellyseerr-sort-menu .jellyseerr-menu-group')].find(group => group.textContent.startsWith('Genres'));
  assert.equal(row.querySelector('.jellyseerr-menu-group-value').textContent, 'Family or Kids');
});

test("a saved profile chosen on the tab sets its filters, its address and its rows at once", async t => {
  const h = setup(t, { routes: [[`${DISCOVER}/tv?page=1&genre=16`, scored([[41, 'tv']])], [`${DISCOVER}/tv?page=1`, scored([[42, 'tv']])]] });
  h.window.ApiClient.ajax = async ({ type }) => type === 'GET'
    ? { max: 30, profiles: [{ id: 'a1', name: 'Kids', filters: 'jeType=series&jeGenres=16/16:Animation' }] } : {};
  const P = h.load();
  P.renderInto(h.tab());
  await until(() => loaded(h), 'rows');
  h.tab().querySelector('.je-reco-tools .jellyseerr-filters-btn').click();
  const saved = [...h.document.querySelectorAll('.jellyseerr-sort-menu .jellyseerr-menu-group')][0];
  assert.match(saved.textContent, /^Saved filters/);
  saved.click();
  await until(() => h.document.querySelector('.jellyseerr-sort-menu .jellyseerr-menu-profile'), 'the profiles');
  h.document.querySelector('.jellyseerr-sort-menu .jellyseerr-menu-profile').click();
  assert.equal(h.document.querySelector('.jellyseerr-sort-menu'), null, 'the menu is done');
  assert.equal(h.hash(), `${TAB}&jeType=series&jeGenres=16/16:Animation`);
  await until(() => loaded(h) && h.cards(h.tab()).includes(41), 'its rows');
  assert.equal(h.tab().querySelector('.je-reco-tools .emby-tab-button-active').dataset.mode, 'tv');
  assert.deepEqual(h.said(h.tab()), ['Animation']);
});
