// The discovery sections keep their filters in their own page's address (All / Movies / Series, the order and the
// further filters), so a link, a reload and Back show what was set. Real shipped scripts on the real core runtime;
// only Seerr's answers, its card renderer and its user-status call are fixtures, as in pages-discovery.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, englishT, jsonResponse, plain } from '../helpers/harness.mjs';

const DISCOVERY = ['jellyseerr/discovery/discovery-styles.js', 'jellyseerr/discovery/discovery-busy.js',
  'jellyseerr/discovery/discovery-menu.js', 'jellyseerr/discovery/discovery-roles.js', 'jellyseerr/discovery/discovery-section.js',
  'jellyseerr/discovery/discovery-filters.js', 'jellyseerr/discovery/discovery-filter-panel.js',
  'jellyseerr/discovery/discovery-filter-utils.js', 'jellyseerr/discovery/discovery-address.js', 'jellyseerr/discovery/discovery-base.js'];
const RUNTIME = ['core/navigation.js', 'core/session.js', 'core/lifecycle.js', 'core/dom-observer.js', 'core/ui-kit.js',
  'core/api-client.js', 'enhanced/helpers.js', 'jellyseerr/seerr-status.js', 'jellyseerr/request-manager.js',
  'jellyseerr/seamless-scroll.js', ...DISCOVERY];
const ORIGIN = 'http://jellyfin.test';
const API = '/JellyfinEnhanced';
const LIST_PAGE = '<div class="page libraryPage" id="list"><div class="verticalSection"><div class="itemsContainer"><div class="card" data-id="host"></div></div></div></div>';
const DETAIL = id => `<div class="page itemDetailPage" id="${id}"><div class="detailPagePrimaryContent"><div class="detailSection">`
  + '<div class="verticalSection"></div></div></div><div class="detailPageSecondaryContainer"></div></div>';

async function until(condition, label = 'condition') {
  const deadline = performance.now() + 3000;
  while (!condition() && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(condition(), `${label} was not reached`);
}
const feed = (ids, mediaType, totalPages = 1) => ({ results: ids.map(id => ({ id, mediaType })), totalPages });
const ids = root => [...(root?.querySelectorAll('.card:not(.jellyseerr-card-placeholder)') ?? [])]
  .map(card => card.dataset.id).filter(id => id !== 'host').map(Number);

function setup(t, { hash, html = LIST_PAGE, routes = [], items = {} } = {}) {
  const calls = [];
  const table = new Map(routes);
  const h = createHarness({
    html, url: `${ORIGIN}/web/index.html${hash}`,
    JE: { internals: {}, pluginConfig: {}, t: englishT },
    apiClient: { getItem: async (_user, id) => items[id] ?? { Id: id, Type: 'Other' } },
    fetch: async url => {
      const path = url.replace(ORIGIN, '');
      calls.push(path);
      const answer = table.has(path) ? table.get(path) : table.get(path.split('?')[0]);
      return answer === undefined ? jsonResponse({ message: `no fixture for ${path}` }, 404) : jsonResponse(answer);
    }
  });
  t.after(() => h.close());
  for (const file of RUNTIME) h.load(file);
  h.JE.jellyseerrAPI = { checkUserStatus: async () => ({ active: true }) };
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
  return {
    ...h, calls, navigations: () => navigations, hash: () => h.window.location.hash,
    section: name => h.document.querySelector(`.jellyseerr-${name}-discovery-section`),
    said: section => [...section.querySelectorAll('.jellyseerr-filters-token')].map(token => token.textContent)
  };
}
const GENRE = [[`${API}/genre/g1`, { id: 'g1', name: 'Comedy', type: 'Genre' }],
  [`${API}/tmdb/genres/tv`, [{ id: 35, name: 'Comedy' }]], [`${API}/tmdb/genres/movie`, [{ id: 36, name: 'Comedy' }]]];
const PERSON_ROUTES = [[`${API}/person/p1`, { name: 'Ann', tmdbId: '7' }],
  [`${API}/jellyseerr/person/7/combined_credits`, { cast: [
    { id: 5, mediaType: 'movie', voteAverage: 8 }, { id: 6, mediaType: 'tv', voteAverage: 9 }, { id: 7, mediaType: 'movie', voteAverage: 4 }
  ] }]];

test("a list page's link with the section's filters: page 1 is asked with them, and the controls say them", async t => {
  const h = setup(t, { hash: '#/list?genreId=g1&serverId=s#jeType=movies&jeScore=7..&jeSort=vote_count.desc', routes: [...GENRE,
    [`${API}/jellyseerr/discover/tv/genre/35?page=1&sortBy=vote_count.desc&voteAverageGte=7`, feed([1], 'tv')],
    [`${API}/jellyseerr/discover/movies/genre/36?page=1&sortBy=vote_count.desc&voteAverageGte=7`, feed([11], 'movie')]] });
  h.load('jellyseerr/discovery/genre-discovery.js');
  await until(() => ids(h.section('genre')).length > 0 && h.section('genre').querySelector('.jellyseerr-filters-set'), 'first page');
  const section = h.section('genre');
  // Page 1 of both kinds is in, the series hidden as choosing Movies hides them (All shows them again).
  assert.deepEqual(ids(section), [1, 11]);
  assert.equal(section.querySelector('.itemsContainer').classList.contains('filter-movies'), true, 'Movies only shown');
  assert.equal(section.querySelector('.jellyseerr-discovery-filter .emby-tab-button-active').dataset.mode, 'movies');
  assert.equal(section.querySelector('.jellyseerr-sort-btn').textContent, 'Most votes');
  assert.deepEqual(h.said(section), ['Score from 7']);
  assert.equal(h.calls.some(path => path.includes('genre/36?page=1&sortBy=vote_count.desc&voteAverageGte=7')), true);
});

test("a choice on a section replaces its page's address in its fragment: the router's part as it was, no history entry, no navigation, the same section", async t => {
  const h = setup(t, { hash: '#/list?genreId=g1&serverId=s', routes: [...GENRE,
    [`${API}/jellyseerr/discover/tv/genre/35?page=1`, feed([1], 'tv')], [`${API}/jellyseerr/discover/movies/genre/36?page=1`, feed([11], 'movie')],
    [`${API}/jellyseerr/discover/tv/genre/35?page=1&sortBy=vote_average.desc`, feed([2], 'tv')],
    [`${API}/jellyseerr/discover/movies/genre/36?page=1&sortBy=vote_average.desc`, feed([12], 'movie')]] });
  h.load('jellyseerr/discovery/genre-discovery.js');
  await until(() => ids(h.section('genre')).length === 2, 'first page');
  const section = h.section('genre');
  const length = h.window.history.length;
  const before = h.navigations();
  // (jellyfin-web's router keys its views on the route and query: a change there it did not make has it build
  // the page anew on the next Back, a dialog's included.)
  const routerPart = () => h.hash().split('#').slice(0, 2).join('#');
  section.querySelector('.jellyseerr-discovery-filter [data-mode="tv"]').click();
  assert.equal(h.hash(), '#/list?genreId=g1&serverId=s#jeType=series');
  assert.equal(routerPart(), '#/list?genreId=g1&serverId=s');
  section.querySelector('.jellyseerr-sort-btn').click();
  h.document.querySelector('.jellyseerr-sort-menu .actionSheetMenuItem[data-id="vote_average.desc"]').click();
  assert.equal(h.hash(), '#/list?genreId=g1&serverId=s#jeType=series&jeSort=vote_average.desc');
  assert.equal(routerPart(), '#/list?genreId=g1&serverId=s');
  await until(() => ids(section).includes(2) && !ids(section).includes(1), 'reordered');
  assert.equal(h.window.history.length, length, 'Back is not a step per choice');
  assert.equal(h.navigations(), before, 'not a navigation for the rest of the plugin');
  assert.equal(h.section('genre'), section, 'the section was not rebuilt');
  section.querySelector('.jellyseerr-discovery-filter [data-mode="mixed"]').click();
  assert.equal(h.hash(), '#/list?genreId=g1&serverId=s#jeSort=vote_average.desc');
});

test("a jellyfin-web dialog after a change (its entry at the router's address, without the fragment) and Back off it are no navigation: the section keeps its filters", async t => {
  const h = setup(t, { hash: '#/list?genreId=g1&serverId=s', routes: [...GENRE,
    [`${API}/jellyseerr/discover/tv/genre/35?page=1`, feed([1], 'tv')], [`${API}/jellyseerr/discover/movies/genre/36?page=1`, feed([11], 'movie')]] });
  h.load('jellyseerr/discovery/genre-discovery.js');
  await until(() => ids(h.section('genre')).length === 2, 'first page');
  const section = h.section('genre');
  section.querySelector('.jellyseerr-discovery-filter [data-mode="tv"]').click();
  assert.equal(h.hash(), '#/list?genreId=g1&serverId=s#jeType=series');
  let navigated = 0;
  h.JE.core.navigation.onNavigate(() => { navigated++; });
  // dialogHelper (an item's "…" menu): an entry at the address its router last saw, the open dialogs in the router's state.
  h.window.history.pushState({ usr: { dialogs: ['dlg1'] }, key: 'k1', idx: 1 }, '', `${ORIGIN}/web/index.html#/list?genreId=g1&serverId=s`);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(navigated, 0, 'the dialog opening is not a navigation');
  assert.equal(h.section('genre'), section);
  assert.equal(h.JE.discoveryFilter.getFilterMode('genre'), 'tv');
  h.window.history.back();
  await until(() => h.hash() === '#/list?genreId=g1&serverId=s#jeType=series', 'Back off the dialog');
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(navigated, 0, 'nor its closing');
  assert.equal(h.section('genre'), section, 'the same section');
  assert.equal(section.querySelector('.jellyseerr-discovery-filter .emby-tab-button-active').dataset.mode, 'tv');
  // Forward onto the dialog's entry left behind (no dialog open): the same page, its address put back.
  h.window.history.forward();
  await until(() => h.window.history.state?.usr?.dialogs, 'Forward onto the entry');
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(h.hash(), '#/list?genreId=g1&serverId=s#jeType=series');
  assert.equal(navigated, 0, 'not a navigation either');
  assert.equal(h.section('genre'), section);
  assert.equal(h.JE.discoveryFilter.getFilterMode('genre'), 'tv');
  // A real move still is one.
  h.window.history.pushState(null, '', `${ORIGIN}/web/index.html#/home`);
  assert.equal(navigated, 1);
});

test("a link leaving out genres and a language: Seerr is asked as without them, and what has them is kept off the page", async t => {
  const h = setup(t, { hash: '#/list?genreId=g1&serverId=s&jeWithoutGenres=27/27:Horror&jeWithoutLanguage=ja', routes: [...GENRE,
    [`${API}/jellyseerr/discover/tv/genre/35?page=1`, { results: [{ id: 1, mediaType: 'tv', genreIds: [35, 27] }, { id: 2, mediaType: 'tv', genreIds: [35], originalLanguage: 'ja' }, { id: 3, mediaType: 'tv', genreIds: [35] }], totalPages: 1 }],
    [`${API}/jellyseerr/discover/movies/genre/36?page=1`, { results: [{ id: 11, mediaType: 'movie', genreIds: [36] }, { id: 12, mediaType: 'movie', genreIds: [36, 27], originalLanguage: 'en' }], totalPages: 1 }]] });
  h.load('jellyseerr/discovery/genre-discovery.js');
  await until(() => ids(h.section('genre')).length > 0 && h.section('genre').querySelector('.jellyseerr-filters-set'), 'first page');
  const section = h.section('genre');
  assert.deepEqual(ids(section).sort((a, b) => a - b), [3, 11]);
  assert.deepEqual(h.said(section), ['Not Horror', 'Not originally in Japanese']);
  // (Asked of Seerr as the page alone: nothing it would not understand.)
  assert.equal(h.calls.some(path => /without|exclude/i.test(path)), false);
  // Taken away, the address says so and the list has them again.
  section.querySelector('.jellyseerr-filters-token .jellyseerr-filters-remove').click();
  // (The link's query is the router's and stays; the fragment says what is set now.)
  assert.equal(h.hash(), '#/list?genreId=g1&serverId=s&jeWithoutGenres=27/27:Horror&jeWithoutLanguage=ja#jeWithoutLanguage=ja');
  await until(() => ids(section).includes(1), 'Horror back');
});

test("a page opened straight from its link keeps its section when a dialog's own history entry is popped (More Info's Back)", async t => {
  const h = setup(t, { hash: '#/list?genreId=g1&serverId=s&jeScore=7..', routes: [...GENRE,
    [`${API}/jellyseerr/discover/tv/genre/35?page=1&voteAverageGte=7`, feed([1], 'tv')],
    [`${API}/jellyseerr/discover/movies/genre/36?page=1&voteAverageGte=7`, feed([11], 'movie')]] });
  h.load('jellyseerr/discovery/genre-discovery.js');
  await until(() => ids(h.section('genre')).length === 2, 'first page');
  const section = h.section('genre');
  let navigated = 0;
  h.JE.core.navigation.onNavigate(() => { navigated++; });
  // The More Info modal adds an entry at the same address when it opens, and goes Back to it when it closes.
  h.window.history.pushState(null, '', h.window.location.href);
  h.window.dispatchEvent(new h.window.PopStateEvent('popstate', { state: null }));
  h.window.dispatchEvent(new h.window.HashChangeEvent('hashchange'));
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(navigated, 0, 'the address the page opened at is not a navigation');
  assert.equal(h.section('genre'), section, 'the section was not taken down');
  assert.deepEqual(ids(section), [1, 11]);
  // A real move still is one.
  h.window.history.pushState(null, '', `${ORIGIN}/web/index.html#/home`);
  assert.equal(navigated, 1);
});

test("a person's link: the type and further filters from the address, and taking one away writes it back", async t => {
  const h = setup(t, { hash: '#/details?id=p1&jeType=movies&jeScore=7..', html: DETAIL('detail'),
    items: { p1: { Id: 'p1', Type: 'Person' } }, routes: PERSON_ROUTES });
  h.load('jellyseerr/discovery/person-discovery.js');
  await until(() => h.section('person')?.querySelector('.jellyseerr-filters-set'), 'the section');
  const section = h.section('person');
  assert.deepEqual(ids(section), [5], 'its movie scored 7 or more');
  assert.equal(section.querySelector('.jellyseerr-discovery-filter .emby-tab-button-active').dataset.mode, 'movies');
  assert.deepEqual(h.said(section), ['Score from 7']);
  section.querySelector('.jellyseerr-filters-remove').click();
  assert.equal(h.hash(), '#/details?id=p1&jeType=movies&jeScore=7..#jeType=movies');
  await until(() => String(ids(section)) === '5,7', 'every movie');
});

test("a section whose address's filters leave nothing stays, says so, and Clear filters brings everything back", async t => {
  const h = setup(t, { hash: '#/details?id=p1&jeLanguage=ko', html: DETAIL('detail'),
    items: { p1: { Id: 'p1', Type: 'Person' } }, routes: PERSON_ROUTES });
  h.load('jellyseerr/discovery/person-discovery.js');
  await until(() => h.section('person')?.querySelector('.jellyseerr-filters-none'), 'the note');
  const section = h.section('person');
  assert.deepEqual(ids(section), []);
  section.querySelector('.jellyseerr-filters-none button').click();
  await until(() => ids(section).length === 3, 'everything again');
  assert.equal(h.hash(), '#/details?id=p1&jeLanguage=ko#', 'an empty fragment: nothing set, whatever the query says');
});

test('a section goes on the page the router shows, not the one still showing while it builds the new page', async t => {
  const h = setup(t, { hash: '#/details?id=m1', html: DETAIL('old'),
    items: { p1: { Id: 'p1', Type: 'Person' }, m1: { Id: 'm1', Type: 'Movie' } }, routes: PERSON_ROUTES });
  h.load('jellyseerr/discovery/person-discovery.js');
  // A person's page the router builds anew (another title's page before it).
  h.window.location.hash = '#/details?id=p1#jeType=movies';
  await until(() => h.calls.some(path => path.endsWith('combined_credits')), 'the person looked up');
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(h.section('person'), null, 'not put on the old page meanwhile');
  const old = h.document.getElementById('old');
  old.insertAdjacentHTML('afterend', DETAIL('new'));
  old.classList.add('hide');
  h.document.getElementById('new').dispatchEvent(new h.window.CustomEvent('viewshow', { bubbles: true }));
  await until(() => h.section('person'), 'the section');
  assert.equal(h.section('person').closest('.page').id, 'new');
  assert.equal(h.section('person').querySelector('.jellyseerr-discovery-filter .emby-tab-button-active').dataset.mode, 'movies');
  assert.equal(plain(h.JE.discoveryFilter.getFilterMode('person')), 'movies');
});

test("a type its address asks for holds when its page 1 came back empty: the tabs say it, the other kind is hidden, its feed reads on", async t => {
  const h = setup(t, { hash: '#/list?genreId=g1&serverId=s&jeType=movies', routes: [...GENRE,
    [`${API}/jellyseerr/discover/tv/genre/35?page=1`, feed([1], 'tv', 3)],
    [`${API}/jellyseerr/discover/movies/genre/36?page=1`, feed([], 'movie', 2)]] });
  h.load('jellyseerr/discovery/genre-discovery.js');
  await until(() => h.section('genre')?.querySelector('.jellyseerr-discovery-filter'), 'the tabs');
  const section = h.section('genre');
  assert.equal(h.JE.discoveryFilter.getFilterMode('genre'), 'movies');
  assert.equal(section.querySelector('.jellyseerr-discovery-filter .emby-tab-button-active').dataset.mode, 'movies');
  assert.equal(section.querySelector('.itemsContainer').classList.contains('filter-movies'), true, 'the series card is hidden');
  assert.equal(h.hash(), '#/list?genreId=g1&serverId=s&jeType=movies');
});

test("a filter the admin turned off is not taken from an address", async t => {
  const h = setup(t, { hash: '#/details?id=p1&jeScore=7..&jeLanguage=ko', html: DETAIL('detail'),
    items: { p1: { Id: 'p1', Type: 'Person' } }, routes: PERSON_ROUTES });
  h.JE.pluginConfig.JellyseerrFilterScore = false;
  h.load('jellyseerr/discovery/person-discovery.js');
  await until(() => h.section('person')?.querySelector('.jellyseerr-filters-set, .jellyseerr-filters-none'), 'the section');
  assert.deepEqual(Object.keys(plain(h.JE.discoveryFilters.selectionOf('person'))), ['language']);
});

test("a genre's page keeps its genre and takes the others ticked as any of them: asked for its genre, kept by theirs", async t => {
  const h = setup(t, { hash: '#/list?genreId=g1&serverId=s&jeGenres=36/35:Comedy,10751/10751:Family,16/16:Animation&jeAny=genres', routes: [...GENRE,
    [`${API}/jellyseerr/discover/tv/genre/35?page=1`, { results: [{ id: 1, mediaType: 'tv', genreIds: [35, 10751] }, { id: 2, mediaType: 'tv', genreIds: [35] }], totalPages: 1 }],
    [`${API}/jellyseerr/discover/movies/genre/36?page=1`, { results: [{ id: 11, mediaType: 'movie', genreIds: [36, 16] }, { id: 12, mediaType: 'movie', genreIds: [36, 18] }], totalPages: 1 }]] });
  h.load('jellyseerr/discovery/genre-discovery.js');
  await until(() => ids(h.section('genre')).length > 0, 'first page');
  assert.deepEqual(ids(h.section('genre')).sort((a, b) => a - b), [1, 11], 'Comedy and (Family or Animation)');
  assert.equal(h.calls.some(path => path.includes('genre/35?page=1&') || path.includes('genre/36?page=1&')), false, 'asked for its own genre only');
  h.section('genre').querySelector('.jellyseerr-filters-btn').click();
  const genres = [...h.document.querySelectorAll('.jellyseerr-sort-menu .jellyseerr-menu-group')].find(group => group.textContent.startsWith('Genres'));
  genres.click();
  await until(() => h.document.querySelector('.jellyseerr-sort-menu .jellyseerr-menu-match'), 'the choice');
  assert.equal(h.document.querySelector('.jellyseerr-sort-menu .jellyseerr-menu-match-lead').textContent, 'Titles in Comedy and');
});

test("a saved profile chosen in a section sets its type, order and filters, its address, and asks Seerr again", async t => {
  const h = setup(t, { hash: '#/list?genreId=g1&serverId=s', routes: [...GENRE,
    [`${API}/jellyseerr/discover/tv/genre/35?page=1`, feed([1], 'tv')], [`${API}/jellyseerr/discover/movies/genre/36?page=1`, feed([11], 'movie')],
    [`${API}/jellyseerr/discover/tv/genre/35?page=1&sortBy=vote_count.desc&voteAverageGte=7`, feed([2], 'tv')],
    [`${API}/jellyseerr/discover/movies/genre/36?page=1&sortBy=vote_count.desc&voteAverageGte=7`, feed([12], 'movie')]] });
  h.window.ApiClient.ajax = async ({ type }) => type === 'GET'
    ? { max: 30, profiles: [{ id: 'a1', name: 'Best movies', filters: 'jeType=movies&jeScore=7..&jeSort=vote_count.desc' }] } : {};
  h.load('jellyseerr/discovery/genre-discovery.js');
  await until(() => ids(h.section('genre')).length === 2, 'first page');
  const section = h.section('genre');
  section.querySelector('.jellyseerr-filters-btn').click();
  [...h.document.querySelectorAll('.jellyseerr-sort-menu .jellyseerr-menu-group')][0].click();
  await until(() => h.document.querySelector('.jellyseerr-sort-menu .jellyseerr-menu-profile'), 'the profiles');
  h.document.querySelector('.jellyseerr-sort-menu .jellyseerr-menu-profile').click();
  assert.equal(h.document.querySelector('.jellyseerr-sort-menu'), null);
  assert.equal(h.hash(), '#/list?genreId=g1&serverId=s#jeType=movies&jeScore=7..&jeSort=vote_count.desc');
  await until(() => ids(section).includes(12), 'asked again');
  assert.equal(section.querySelector('.jellyseerr-sort-btn').textContent, 'Most votes');
  assert.equal(section.querySelector('.jellyseerr-discovery-filter .emby-tab-button-active').dataset.mode, 'movies');
  assert.equal(section.querySelector('.itemsContainer').classList.contains('filter-movies'), true);
  assert.deepEqual(h.said(section), ['Score from 7']);
});
