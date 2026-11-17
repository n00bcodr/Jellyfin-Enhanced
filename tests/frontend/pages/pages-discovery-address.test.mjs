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
  const h = setup(t, { hash: '#/list?genreId=g1&serverId=s&jeType=movies&jeScore=7..&jeSort=vote_count.desc', routes: [...GENRE,
    [`${API}/jellyseerr/discover/tv/genre/35?page=1&sortBy=vote_count.desc&voteAverageGte=7`, feed([1], 'tv')],
    [`${API}/jellyseerr/discover/movies/genre/36?page=1&sortBy=vote_count.desc&voteAverageGte=7`, feed([11], 'movie')]] });
  h.load('jellyseerr/discovery/genre-discovery.js');
  await until(() => ids(h.section('genre')).length > 0 && h.section('genre').querySelector('.jellyseerr-filters-set'), 'first page');
  const section = h.section('genre');
  assert.deepEqual(ids(section), [11], 'Movies only');
  assert.equal(section.querySelector('.jellyseerr-discovery-filter .emby-tab-button-active').dataset.mode, 'movies');
  assert.equal(section.querySelector('.jellyseerr-sort-btn').textContent, 'Most votes');
  assert.deepEqual(h.said(section), ['Score from 7']);
  assert.equal(h.calls.some(path => path.includes('genre/36?page=1&sortBy=vote_count.desc&voteAverageGte=7')), true);
});

test("a choice on a section replaces its page's address: no history entry, no navigation, the same section", async t => {
  const h = setup(t, { hash: '#/list?genreId=g1&serverId=s', routes: [...GENRE,
    [`${API}/jellyseerr/discover/tv/genre/35?page=1`, feed([1], 'tv')], [`${API}/jellyseerr/discover/movies/genre/36?page=1`, feed([11], 'movie')],
    [`${API}/jellyseerr/discover/tv/genre/35?page=1&sortBy=vote_average.desc`, feed([2], 'tv')],
    [`${API}/jellyseerr/discover/movies/genre/36?page=1&sortBy=vote_average.desc`, feed([12], 'movie')]] });
  h.load('jellyseerr/discovery/genre-discovery.js');
  await until(() => ids(h.section('genre')).length === 2, 'first page');
  const section = h.section('genre');
  const length = h.window.history.length;
  const before = h.navigations();
  section.querySelector('.jellyseerr-discovery-filter [data-mode="tv"]').click();
  assert.equal(h.hash(), '#/list?genreId=g1&serverId=s&jeType=series');
  section.querySelector('.jellyseerr-sort-btn').click();
  h.document.querySelector('.jellyseerr-sort-menu .actionSheetMenuItem[data-id="vote_average.desc"]').click();
  assert.equal(h.hash(), '#/list?genreId=g1&serverId=s&jeType=series&jeSort=vote_average.desc');
  await until(() => ids(section).includes(2) && !ids(section).includes(1), 'reordered');
  assert.equal(h.window.history.length, length, 'Back is not a step per choice');
  assert.equal(h.navigations(), before, 'not a navigation for the rest of the plugin');
  assert.equal(h.section('genre'), section, 'the section was not rebuilt');
  section.querySelector('.jellyseerr-discovery-filter [data-mode="mixed"]').click();
  assert.equal(h.hash(), '#/list?genreId=g1&serverId=s&jeSort=vote_average.desc');
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
  assert.equal(h.hash(), '#/details?id=p1&jeType=movies');
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
  assert.equal(h.hash(), '#/details?id=p1');
});

test('a section goes on the page the router shows, not the one still showing while it builds the new page', async t => {
  const h = setup(t, { hash: '#/details?id=m1', html: DETAIL('old'),
    items: { p1: { Id: 'p1', Type: 'Person' }, m1: { Id: 'm1', Type: 'Movie' } }, routes: PERSON_ROUTES });
  h.load('jellyseerr/discovery/person-discovery.js');
  // Back to a person's page whose address its cached page no longer matches: the router builds a new one.
  h.window.location.hash = '#/details?id=p1&jeType=movies';
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
