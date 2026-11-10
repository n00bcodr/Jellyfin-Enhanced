// Recommendations through their shipped scripts in component order, on the real core runtime and
// shared helpers. Only Seerr's card renderer, status and slider calls are fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHarness, deferred, englishT, jsonResponse, jsRoot, plain } from '../helpers/harness.mjs';

const ORDER = JSON.parse(readFileSync(resolve(jsRoot, 'component-scripts.json'), 'utf8'));
const FEATURE = ORDER.filter(path => path.startsWith('jellyseerr/recommendations/'));
const RUNTIME = ['core/navigation.js', 'core/session.js', 'core/lifecycle.js', 'core/dom-observer.js', 'core/ui-kit.js',
  'core/api-client.js', 'enhanced/helpers.js', 'jellyseerr/seerr-status.js', 'jellyseerr/request-manager.js',
  'jellyseerr/seamless-scroll.js', 'jellyseerr/discovery/discovery-filter-utils.js'];
const ORIGIN = 'http://jellyfin.test';
const DISCOVER = '/JellyfinEnhanced/jellyseerr/discover';
const HOME = '<div class="mainAnimatedPages"><div class="page mainAnimatedPage" id="indexPage"><div class="tabContent is-active" id="tab"></div><div class="tabContent" id="other"></div></div></div><div class="jellyfinEnhancedSection"></div>';
const ROW_PATHS = ['trending', 'movies', 'tv', 'movies/upcoming', 'tv/upcoming'].map(path => `${DISCOVER}/${path}?page=1`);

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
async function until(condition, label = 'condition') {
  const deadline = performance.now() + 3000;
  while (!condition() && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(condition(), `${label} was not reached`);
}
const feed = (ids, mediaType, totalPages = 3) => ({ results: ids.map(id => ({ id, mediaType })), totalPages });

function setup(t, { hash = '#/home', config = {}, routes = [], genres = async () => [{ id: 7, name: 'Comedy', backdrops: ['/b.jpg'] }], html = HOME, expectedConsoleErrors } = {}) {
  const who = { user: 'user-a', server: 'server-a' };
  const calls = [];
  const observers = [];
  const table = new Map([...ROW_PATHS.map(path => [path, feed([1], 'movie')]), ...routes]);
  class ResizeObserverFixture {
    constructor() { this.connected = false; observers.push(this); }
    observe() { this.connected = true; }
    disconnect() { this.connected = false; }
  }
  const h = createHarness({
    html, url: `${ORIGIN}/web/index.html${hash}`, expectedConsoleErrors,
    JE: { internals: {}, pluginConfig: { RecommendationsPageEnabled: true, ...config }, t: englishT, cdn: { selfhst: file => `/cdn/${file}` } },
    globals: { ResizeObserver: ResizeObserverFixture },
    apiClient: { getCurrentUserId: () => who.user, serverId: () => who.server, accessToken: () => `token-${who.user}` },
    fetch: async (url, options) => {
      const path = url.replace(ORIGIN, '');
      calls.push({ path, user: who.user, signal: options.signal });
      const answer = table.get(path);
      if (answer === undefined) return jsonResponse({ message: `no fixture for ${path}` }, 404);
      const value = typeof answer === 'function' ? await answer(who) : await answer;
      if (value instanceof Error) throw value;
      return jsonResponse(value);
    }
  });
  t.after(() => h.close());
  // Component order puts native tabs and helpers first; the fixture stands in for the tab strip.
  const tabs = [];
  h.JE.nativeTabs = { register: (...args) => tabs.push(args) };
  for (const file of RUNTIME) h.load(file);
  h.JE.requestManager.CONFIG.retry.maxAttempts = 1;
  const sliders = [];
  h.JE.jellyseerrAPI = { fetchGenreSlider: async type => { sliders.push({ type, user: who.user }); return genres(type); } };
  h.JE.jellyseerrUI = {
    createJellyseerrCard(item) {
      const card = h.document.createElement('div');
      card.className = 'card';
      card.dataset.id = String(item.id);
      return card;
    },
    releasePosters() {}
  };
  const armed = { count: 0, load: null, state: null };
  h.JE.discoveryFilter.setupInfiniteScroll = (state, selector, load) => { armed.count++; armed.load = load; armed.state = state; armed.selector = selector; };
  h.JE.discoveryFilter.cleanupScrollObserver = () => { armed.load = null; };
  const load = (files = FEATURE) => { for (const file of files) h.load(file); return h.JE.internals.recommendationsPage; };
  const switchUser = (user, server = who.server) => { who.user = user; who.server = server; h.JE.session.checkNow('test'); };
  return { ...h, who, calls, table, tabs, sliders, armed, observers, load, switchUser,
    page: () => h.document.querySelector('#je-recommendations-page'),
    category: () => h.document.querySelector('#je-recommendations-category-page'),
    categoryCards: () => [...h.document.querySelectorAll('#je-recommendations-category-container .card')].map(card => Number(card.dataset.id)) };
}
const sections = root => [...root.querySelectorAll('.je-recommendations-section h2')].map(heading => heading.textContent);

test('the standalone page renders every row, genre row and tile row in order, and skips empty rows', async t => {
  const h = setup(t, { hash: '#/recommendations', routes: [[ROW_PATHS[4], feed([], 'tv')]] });
  h.load();
  await until(() => h.page()?.querySelector('.je-recommendations-section'), 'rows');
  const root = h.document.querySelector('#je-recommendations-container');
  assert.deepEqual(sections(root), ['Trending', 'Popular Movies', 'Popular TV Shows', 'Upcoming Movies', 'Movie Genres', 'TV Show Genres', 'Studios', 'Networks']);
  assert.equal(root.querySelector('h1 span').textContent, 'Seerr Recommendations');
  assert.equal(root.querySelector('[role="status"]'), null, 'the skeleton is gone');
  assert.equal(h.document.querySelector('.je-nav-recommendations-item .navMenuOptionText').textContent, 'Seerr Recommendations');
  assert.equal(h.document.querySelector('#indexPage').classList.contains('hide'), true);
});

test('DISCOVERY-RECOMMENDATIONS-001: an identity change empties every surface and forgets the account', async t => {
  const h = setup(t, { hash: '#/recommendations' });
  const P = h.load();
  await until(() => h.page()?.querySelector('.je-recommendations-section'), 'rows');
  const tab = h.document.createElement('div');
  h.document.querySelector('#tab').appendChild(tab);
  P.renderForCustomTab(tab);
  await until(() => tab.querySelector('.card[data-id="1"]'), 'second host');
  assert.equal(P.MOVIE_GENRES.length, 1);
  h.switchUser('user-b');
  assert.equal(P.state.pageVisible, false);
  assert.equal(h.document.querySelector('#je-recommendations-container').children.length, 0);
  assert.equal(tab.children.length, 0, 'no previous-account card stays in a retained container');
  assert.deepEqual(plain(P.MOVIE_GENRES), []);
  await P.fetchGenreSlider('movie');
  assert.deepEqual(h.sliders.map(call => call.user), ['user-a', 'user-a', 'user-b'], 'the slider is fetched again for the new account');
});

test('rows landing after the identity changed render nothing, even when the account returns', async t => {
  const pending = deferred();
  const h = setup(t, { hash: '#/recommendations', routes: [[ROW_PATHS[0], pending.promise]] });
  const P = h.load();
  await until(() => h.calls.length >= 5, 'rows requested');
  h.switchUser('user-b');
  h.switchUser('user-a');
  pending.resolve(feed([666], 'movie'));
  await tick();
  await tick();
  assert.equal(h.document.querySelector('[data-id="666"]'), null);
  assert.equal(P.state.renders.size, 0);
});

test('an identity change closes the category page, ends its requests and resets its filter and sort', async t => {
  const pending = deferred();
  const h = setup(t, { routes: [[`${DISCOVER}/trending?page=1`, pending.promise]] });
  const P = h.load();
  h.JE.discoveryFilter.setFilterMode('recommendationsTrending', 'tv');
  h.JE.discoveryFilter.setSortMode('recommendationsCategory', 'release_date.asc');
  P.showCategoryPage('trending');
  await until(() => h.calls.some(call => call.path.endsWith('trending?page=1')), 'page 1');
  const { signal } = h.calls.find(call => call.path.endsWith('trending?page=1'));
  h.switchUser('user-b');
  assert.equal(signal.aborted, true);
  assert.equal(P.state.categoryPageVisible, false);
  assert.equal(h.category().classList.contains('hide'), true);
  assert.equal(h.JE.discoveryFilter.getFilterMode('recommendationsTrending'), 'mixed');
  assert.equal(h.JE.discoveryFilter.getSortMode('recommendationsCategory'), '');
  pending.resolve(feed([666], 'movie'));
  await tick();
  assert.equal(h.document.querySelector('[data-id="666"]'), null);
});

test('DISCOVERY-RECOMMENDATIONS-002: opening the page does not cancel the tab rendering beside it', async t => {
  const rows = deferred();
  const h = setup(t, { routes: [[ROW_PATHS[0], rows.promise]] });
  const P = h.load();
  const tab = h.document.createElement('div');
  h.document.querySelector('#tab').appendChild(tab);
  P.renderForCustomTab(tab);
  await until(() => h.calls.length >= 5, 'tab rows requested');
  P.showPage();
  await tick();
  P.hidePage();
  rows.resolve(feed([5], 'movie'));
  await until(() => tab.querySelector('.card[data-id="5"]'), 'the tab finishes its own render');
  assert.equal(tab.querySelector('[role="status"]'), null, 'no skeleton is left behind');
});

test('DISCOVERY-RECOMMENDATIONS-003: hiding the page ends its render, observers and sticky tracking', async t => {
  const h = setup(t, { hash: '#/recommendations' });
  const P = h.load();
  await until(() => h.page()?.querySelector('.je-recommendations-section'), 'rows');
  const connected = () => h.observers.filter(observer => observer.connected).length;
  assert.ok(connected() > 0);
  P.hidePage();
  assert.equal(connected(), 0);
  assert.equal(P.state.renders.size, 0);
  assert.equal(h.document.querySelector('#je-recommendations-container').children.length, 0);
});

test('a render bound to a removed container ends instead of filling it, and the next render clears it', async t => {
  const rows = deferred();
  const h = setup(t, { routes: [[ROW_PATHS[0], rows.promise]] });
  const P = h.load();
  const gone = h.document.createElement('div');
  h.document.body.appendChild(gone);
  P.renderInto(gone);
  await until(() => h.calls.length >= 5, 'rows requested');
  gone.remove();
  rows.resolve(feed([5], 'movie'));
  await tick();
  await tick();
  assert.equal(gone.querySelector('.card'), null);
  assert.equal(P.state.renders.size, 0);
  assert.doesNotThrow(() => P.renderForCustomTab(null));
});

test('DISCOVERY-RECOMMENDATIONS-017: navigation ends a render whose host dropped its container, and two hosts keep their own results', async t => {
  const h = setup(t);
  const P = h.load();
  const plugin = h.document.createElement('div');
  plugin.id = 'je-recommendations-container';
  h.document.body.prepend(plugin);
  P.renderInto(plugin);
  await until(() => plugin.querySelector('.je-recommendations-section'), 'plugin host');
  P.showPage();
  await until(() => h.page().querySelector('.je-recommendations-section'), 'standalone page');
  assert.ok(plugin.querySelector('.je-recommendations-section'), 'the page renders into its own container, not the first with that id');
  assert.equal(P.state.renders.size, 2);
  plugin.remove();
  h.window.location.hash = '#/home';
  await until(() => P.state.renders.size === 0, 'both renders ended');
});

function customTab(t, config, options = {}) {
  const h = setup(t, { config: { RecommendationsUseCustomTabs: true, ...config }, ...options });
  h.document.querySelector('#tab').innerHTML = '<div class="jellyfinenhanced recommendations hide"></div>';
  h.load();
  return h;
}
const marker = h => h.document.querySelector('#tab .jellyfinenhanced.recommendations');

test('custom tab mounts into the active container and keeps the sidebar link out of the way', async t => {
  const h = customTab(t);
  await until(() => marker(h).querySelector('.je-recommendations-section'), 'rows');
  assert.equal(marker(h).classList.contains('hide'), false);
  assert.equal(marker(h).firstElementChild.id, 'je-recommendations-container-tab');
  assert.equal(h.document.querySelector('.je-nav-recommendations-item'), null);
});

test('DISCOVERY-RECOMMENDATIONS-003: an inactive tab holds no work and remounts when active again', async t => {
  const h = customTab(t);
  await until(() => marker(h).querySelector('.je-recommendations-section'), 'first mount');
  const P = h.JE.internals.recommendationsPage;
  const tab = h.document.querySelector('#tab');
  tab.classList.remove('is-active');
  await until(() => marker(h).children.length === 0, 'inactive tab disposed');
  assert.equal(P.state.renders.size, 0);
  assert.equal(h.observers.filter(observer => observer.connected).length, 0);
  tab.classList.add('is-active');
  await until(() => marker(h).querySelector('.je-recommendations-section'), 'remount');
  assert.equal(h.document.querySelectorAll('#je-recommendations-container-tab').length, 1);
});

test('DISCOVERY-RECOMMENDATIONS-003: leaving home ends a tab render still in flight', async t => {
  const rows = deferred();
  const h = customTab(t, {}, { routes: [[ROW_PATHS[0], rows.promise]] });
  await until(() => h.calls.length >= 5, 'rows requested');
  const { signal } = h.calls.find(call => call.path === ROW_PATHS[0]);
  h.window.location.hash = '#/list';
  await until(() => signal.aborted, 'request ended');
  rows.resolve(feed([5], 'movie'));
  await tick();
  assert.equal(h.document.querySelector('[data-id="5"]'), null);
});

test('a category opened from a tab hides the tab, and Back mounts it again', async t => {
  const h = customTab(t, {}, { routes: [[`${DISCOVER}/trending?page=1`, feed([1], 'movie', 1)]] });
  await until(() => marker(h).querySelector('.je-recommendations-section'), 'first mount');
  const P = h.JE.internals.recommendationsPage;
  await P.showCategoryPage('trending');
  await until(() => marker(h).children.length === 0, 'tab disposed behind the category');
  h.document.querySelector('#je-recommendations-category-back').click();
  await until(() => marker(h).querySelector('.je-recommendations-section'), 'tab mounted after Back');
  assert.equal(h.document.querySelector('#indexPage').classList.contains('hide'), false);
});

test('a tab mounted for one account remounts for the next', async t => {
  const h = customTab(t);
  await until(() => marker(h).querySelector('.je-recommendations-section'), 'first mount');
  const before = h.calls.length;
  h.switchUser('user-b');
  assert.equal(marker(h).children.length, 0);
  h.document.body.appendChild(h.document.createElement('div')); // The router's next change.
  await until(() => marker(h).querySelector('.je-recommendations-section'), 'second mount');
  assert.ok(h.calls.slice(before).every(call => call.user === 'user-b'));
});

test('a native tab registers its own panel with the page title and icon', async t => {
  const h = setup(t, { config: { RecommendationsUseNativeTab: true } });
  h.load();
  assert.equal(h.tabs.length, 1);
  const [id, title, mount, icon] = h.tabs[0];
  assert.deepEqual([id, title, icon], ['recommendations', 'Seerr Recommendations', 'auto_awesome']);
  const panel = h.document.createElement('div');
  mount(panel);
  assert.equal(panel.firstElementChild.className, 'jellyfinenhanced recommendations');
  h.document.querySelector('#tab').appendChild(panel);
  await until(() => panel.querySelector('.je-recommendations-section'), 'native tab rows');
  assert.equal(h.document.querySelector('.je-nav-recommendations-item'), null);
});

test('the custom tab entry stays inert unless the page and one host are enabled', t => {
  const h = setup(t, {});
  h.load();
  assert.equal(h.tabs.length, 0);
  assert.equal([...h.document.head.querySelectorAll('style')].some(style => style.textContent.includes('.jellyfinenhanced.recommendations')), false);
});

test('Plugin Pages keep the page link hidden from the sidebar and render through the public facade', async t => {
  const html = `${HOME}<div class="mainDrawer-scrollContainer"><a is="emby-linkbutton" data-itemid="Jellyfin.Plugin.JellyfinEnhanced.RecommendationsPage"></a></div><div id="host"></div>`;
  const h = setup(t, { html, config: { RecommendationsUsePluginPages: true } });
  const P = h.load();
  assert.equal(P.pluginPagesExists, true);
  assert.equal(h.document.querySelector('.je-nav-recommendations-item'), null);
  P.showPage();
  assert.equal(h.page(), null, 'the Plugin Page owns this route');
  const host = h.document.querySelector('#host');
  h.JE.recommendationsPage.renderForCustomTab(host);
  await until(() => host.querySelector('.je-recommendations-section'), 'plugin page rows');
});

test('the sidebar link hides the Plugin Pages link and opens the standalone page', async t => {
  const html = `${HOME}<div class="mainDrawer-scrollContainer"><a is="emby-linkbutton" data-itemid="Jellyfin.Plugin.JellyfinEnhanced.RecommendationsPage"></a></div>`;
  const h = setup(t, { html });
  h.load();
  const pluginLink = h.document.querySelector('[data-itemid]');
  assert.equal(pluginLink.style.getPropertyValue('display'), 'none');
  h.document.querySelector('.je-nav-recommendations-item').click();
  assert.equal(h.window.location.hash, '#/recommendations');
  await until(() => h.page()?.querySelector('.je-recommendations-section'), 'rows');
});

test('DISCOVERY-RECOMMENDATIONS-019: closing the page announces one viewhide and one viewshow', async t => {
  const h = setup(t, { hash: '#/recommendations' });
  const P = h.load();
  await until(() => h.page()?.querySelector('.je-recommendations-section'), 'rows');
  const events = [];
  h.page().addEventListener('viewhide', () => events.push('page hide'));
  h.document.querySelector('#indexPage').addEventListener('viewshow', () => events.push('home show'));
  P.hidePage();
  assert.deepEqual(events, ['page hide', 'home show']);
});

test('DISCOVERY-RECOMMENDATIONS-013: when every row failed the page offers a retry, not an empty catalogue', async t => {
  let failing = true;
  const answer = () => failing ? new Error('seerr down') : feed([9], 'movie');
  const h = setup(t, { hash: '#/recommendations', routes: ROW_PATHS.map(path => [path, answer]) });
  h.load();
  await until(() => h.page()?.querySelector('.je-recommendations-empty'), 'failure state');
  assert.equal(h.page().querySelector('.je-recommendations-empty').textContent, 'No recommendations available right now.');
  failing = false;
  h.page().querySelector('.je-retry-row button').click();
  await until(() => h.page().querySelector('.card[data-id="9"]'), 'retried rows');
  assert.equal(h.page().querySelector('.je-recommendations-empty'), null);
});

test('an honestly empty catalogue has no retry and one failing row leaves the others', async t => {
  const empty = setup(t, { hash: '#/recommendations', routes: ROW_PATHS.map(path => [path, feed([], 'movie')]) });
  empty.load();
  await until(() => empty.page()?.querySelector('.je-recommendations-empty'), 'empty state');
  assert.equal(empty.page().querySelector('.je-retry-row'), null);
  const partial = setup(t, { hash: '#/recommendations', routes: [[ROW_PATHS[1], new Error('one row down')]] });
  partial.load();
  await until(() => partial.page()?.querySelector('.je-recommendations-section'), 'other rows');
  assert.equal(sections(partial.page()).includes('Popular Movies'), false);
  assert.ok(sections(partial.page()).includes('Trending'));
});

test('DISCOVERY-RECOMMENDATIONS-014: a failed slider is retried after a minute, a good one is kept', async t => {
  let answer = async () => { throw new Error('offline'); };
  const h = setup(t, { genres: type => answer(type) });
  const P = h.load();
  assert.deepEqual(plain(await P.fetchGenreSlider('movie')), []);
  assert.deepEqual(plain(await P.fetchGenreSlider('movie')), []);
  assert.equal(h.sliders.length, 1);
  answer = async () => [{ id: 1, name: 'Comedy', backdrops: ['/a.jpg', 7] }, { id: 'x', name: 'Bad' }, null];
  const realNow = h.window.Date.now;
  h.window.Date.now = () => realNow() + 61 * 1000;
  assert.deepEqual(plain(await P.fetchGenreSlider('movie')), [{ id: 1, name: 'Comedy', backdrops: ['/a.jpg'] }]);
  h.window.Date.now = () => realNow() + 1000 * 1000;
  await P.fetchGenreSlider('movie');
  assert.equal(h.sliders.length, 2);
  h.window.Date.now = realNow;
});

test('DISCOVERY-RECOMMENDATIONS-015: slider data cannot inject markup into a genre tile', async t => {
  const h = setup(t);
  const P = h.load();
  const row = P.createGenreTileRow('Genres', [
    { id: 1, name: '<b>x</b>', backdrops: ['/x.jpg" onerror="window.pwned=1'] },
    { id: 2, name: 'constructor', backdrops: [] }
  ], 'movie');
  const [hostile, plainTile] = row.querySelectorAll('.je-genre-tile-image');
  const image = hostile.querySelector('img');
  assert.equal(image.hasAttribute('onerror'), false);
  assert.equal(image.getAttribute('alt'), '');
  assert.equal(hostile.querySelector('b'), null);
  assert.equal(hostile.querySelector('.je-genre-tile-title').textContent, '<b>x</b>');
  assert.equal(plainTile.style.backgroundColor, 'rgb(67, 56, 202)', 'an inherited property name is not a colour');
  assert.equal(plainTile.querySelector('img'), null);
  image.dispatchEvent(new h.window.Event('error'));
  assert.equal(hostile.querySelector('img'), null);
});

test('a genre row avoids repeating a backdrop and a tile opens its category', async t => {
  const h = setup(t);
  const P = h.load();
  P.MOVIE_GENRES = [{ id: 1, name: 'A', backdrops: ['/same.jpg'] }, { id: 2, name: 'B', backdrops: ['/same.jpg', '/other.jpg'] }];
  h.table.set(`${DISCOVER}/movies/genre/2?page=1`, feed([4], 'movie', 1));
  const row = P.createGenreTileRow('Genres', P.MOVIE_GENRES, 'movie');
  h.document.querySelector('#tab').appendChild(row);
  assert.deepEqual([...row.querySelectorAll('img')].map(img => img.getAttribute('src')),
    ['https://image.tmdb.org/t/p/w500/same.jpg', 'https://image.tmdb.org/t/p/w500/other.jpg']);
  row.querySelectorAll('.je-genre-tile-image')[1].click();
  await until(() => h.categoryCards().length === 1, 'genre category');
  assert.equal(h.document.querySelector('#je-recommendations-category-title').textContent, 'B');
});

test('every category key resolves to its feeds, with series only where a TMDB key provides them', t => {
  const h = setup(t);
  const P = h.load();
  assert.deepEqual(plain(P.resolveCategory('trending')), { title: 'Trending', feeds: [{ path: `${DISCOVER}/trending` }] });
  assert.deepEqual(plain(P.resolveCategory('studio-420')), { title: 'Marvel Studios', feeds: [{ path: `${DISCOVER}/movies/studio/420`, mediaType: 'movie' }] });
  h.JE.pluginConfig.TmdbEnabled = true;
  assert.deepEqual(plain(P.resolveCategory('studio-420').feeds.map(feedSource => feedSource.mediaType)), ['movie', 'tv']);
  assert.deepEqual(plain(P.resolveCategory('network-213').feeds), [
    { path: `${DISCOVER}/tv/network/213`, mediaType: 'tv' }, { path: `${DISCOVER}/movies/studio/178464`, mediaType: 'movie' }]);
  assert.deepEqual(plain(P.resolveCategory('network-2739').feeds), [{ path: `${DISCOVER}/tv/network/2739`, mediaType: 'tv' }]);
  P.TV_GENRES = [{ id: 9, name: 'Soap', backdrops: [] }];
  assert.deepEqual(plain(P.resolveCategory('genre-tv-9')), { title: 'Soap', feeds: [{ path: `${DISCOVER}/tv/genre/9` }] });
  for (const key of ['genre-movie-9', 'studio-999', 'network-999', 'nonsense', 'studio-420x', 'genre-tv-']) assert.equal(P.resolveCategory(key), null);
  assert.equal(P.ROWS.length, 5);
  assert.equal(P.STUDIOS.length, 16);
  assert.equal(P.NETWORKS.length, 16);
});

test('a two-feed category reads both, interleaves them and offers the filter once both answered', async t => {
  const h = setup(t, { config: { TmdbEnabled: true }, routes: [
    [`${DISCOVER}/movies/studio/420?page=1`, feed([1, 2], 'movie')],
    [`${DISCOVER}/tv/studio/420?page=1`, feed([11], 'tv')],
    [`${DISCOVER}/movies/studio/420?page=2`, feed([3], 'movie')]
  ] });
  const P = h.load();
  await P.showCategoryPage('studio-420');
  assert.deepEqual(h.categoryCards(), [1, 11, 2]);
  assert.equal(h.document.querySelector('#je-recommendations-category-title').textContent, 'Marvel Studios');
  assert.equal(h.document.querySelectorAll('#je-recommendations-category-filter button').length, 3);
  assert.equal(h.armed.selector, '#je-recommendations-category-page .content-primary');
  h.document.querySelector('#je-recommendations-category-filter [data-mode="movies"]').click();
  assert.ok(h.document.querySelector('#je-recommendations-category-container').classList.contains('filter-movies'));
  const result = await h.armed.load({ deficitPx: 10, pageBudget: 1 });
  assert.deepEqual(plain(result), { pages: 1, rendered: 1 });
  assert.deepEqual(h.categoryCards(), [1, 11, 2, 3]);
  assert.equal(h.calls.some(call => call.path.includes('tv/studio/420?page=2')), false, 'the filtered-out feed is not read');
  h.document.querySelector('#je-recommendations-category-filter [data-mode="mixed"]').click();
});

test('a category feed that failed page 1 is retried from page 1 and does not hold the other back', async t => {
  let failing = true;
  const h = setup(t, { config: { TmdbEnabled: true }, expectedConsoleErrors: ['Failed to load category page 1'], routes: [
    [`${DISCOVER}/movies/studio/420?page=1`, feed([1], 'movie')],
    [`${DISCOVER}/movies/studio/420?page=2`, feed([2], 'movie')],
    [`${DISCOVER}/tv/studio/420?page=1`, () => failing ? new Error('tmdb down') : feed([11], 'tv')]
  ] });
  const P = h.load();
  await P.showCategoryPage('studio-420');
  assert.deepEqual(h.categoryCards(), [1]);
  assert.equal(h.document.querySelector('#je-recommendations-category-filter').children.length, 0);
  failing = false;
  h.JE.seamlessScroll.cardsNeeded = () => 20;
  await h.armed.load({ deficitPx: 10, pageBudget: 4 });
  assert.ok(h.categoryCards().includes(11));
  assert.equal(h.document.querySelectorAll('#je-recommendations-category-filter button').length, 3, 'filter appears once both answered');
});

test('a load that finds nothing arriving rolls back so the retry fetches the same page', async t => {
  let failing = true;
  const h = setup(t, { routes: [
    [`${DISCOVER}/trending?page=1`, feed([1], 'movie')],
    [`${DISCOVER}/trending?page=2`, () => failing ? new Error('hiccup') : feed([2], 'movie')]
  ] });
  const P = h.load();
  await P.showCategoryPage('trending');
  await assert.rejects(h.armed.load({ deficitPx: 10, pageBudget: 1 }), /hiccup/);
  await tick();
  failing = false;
  await h.armed.load({ deficitPx: 10, pageBudget: 1 });
  assert.deepEqual(h.categoryCards(), [1, 2]);
});

test('DISCOVERY-RECOMMENDATIONS-022: a card that fails to build in a category batch comes back on retry', async t => {
  const h = setup(t, { routes: [
    [`${DISCOVER}/trending?page=1`, feed([1], 'movie', 2)],
    [`${DISCOVER}/trending?page=2`, feed([2], 'movie', 2)]
  ] });
  const P = h.load();
  await P.showCategoryPage('trending');
  const build = h.JE.jellyseerrUI.createJellyseerrCard;
  let failNext = true;
  h.JE.jellyseerrUI.createJellyseerrCard = item => {
    if (failNext && item.id === 2) { failNext = false; throw new Error('controlled card failure'); }
    return build(item);
  };
  await assert.rejects(h.armed.load({ deficitPx: 10, pageBudget: 1 }), /controlled card failure/);
  const [cursor] = P.state.categoryState.feeds;
  assert.deepEqual([cursor.page, cursor.hasMore], [1, true], 'the last page is owed again');
  assert.deepEqual(plain(await h.armed.load({ deficitPx: 10, pageBudget: 1 })), { pages: 1, rendered: 1 });
  assert.deepEqual(h.categoryCards(), [1, 2]);
});

test('an empty category page is not the end of the feed and repeats are dropped', async t => {
  const h = setup(t, { routes: [
    [`${DISCOVER}/trending?page=1`, feed([1], 'movie', 4)],
    [`${DISCOVER}/trending?page=2`, feed([], 'movie', 4)],
    [`${DISCOVER}/trending?page=3`, feed([1, 2], 'movie', 4)]
  ] });
  const P = h.load();
  await P.showCategoryPage('trending');
  assert.deepEqual(plain(await h.armed.load({ deficitPx: 10, pageBudget: 1 })), { pages: 1, rendered: 0 });
  assert.deepEqual(plain(await h.armed.load({ deficitPx: 10, pageBudget: 1 })), { pages: 1, rendered: 1 });
  assert.deepEqual(h.categoryCards(), [1, 2]);
  assert.equal(P.state.categoryState.feeds[0].hasMore, true);
});

test('a category never asks past TMDB page 500, whatever the feed reports', async t => {
  const h = setup(t, { routes: [
    [`${DISCOVER}/trending?page=1`, feed([1], 'movie', 90000)],
    [`${DISCOVER}/trending?page=500`, feed([2], 'movie', 90000)]
  ] });
  const P = h.load();
  await P.showCategoryPage('trending');
  const [cursor] = P.state.categoryState.feeds;
  assert.equal(cursor.totalPages, 500);
  cursor.page = 499;
  h.JE.seamlessScroll.cardsNeeded = () => 80;
  assert.deepEqual(plain(await h.armed.load({ deficitPx: 10 })), { pages: 1, rendered: 1 });
  await tick();
  assert.equal(cursor.hasMore, false);
  assert.equal(h.calls.some(call => call.path.endsWith('page=501')), false);
});

test('DISCOVERY-RECOMMENDATIONS-004: a sort reload ends the previous sort\'s requests; late pages land nowhere', async t => {
  const pageTwo = deferred();
  const h = setup(t, { routes: [
    [`${DISCOVER}/trending?page=1`, feed([1, 2], 'movie')],
    [`${DISCOVER}/trending?page=2`, pageTwo.promise]
  ] });
  const P = h.load();
  await P.showCategoryPage('trending');
  const load = h.armed.load({ deficitPx: 10, pageBudget: 1 });
  await until(() => h.calls.some(call => call.path.endsWith('trending?page=2')), 'page 2');
  const { signal } = h.calls.find(call => call.path.endsWith('trending?page=2'));
  const select = h.document.querySelector('#je-recommendations-category-sort select');
  select.value = 'vote_average.desc';
  select.dispatchEvent(new h.window.Event('change'));
  assert.equal(signal.aborted, true);
  pageTwo.resolve(feed([99], 'movie'));
  assert.deepEqual(plain(await load), { pages: 0, rendered: 0 });
  await until(() => h.armed.load, 'engine for the new sort');
  assert.equal(h.categoryCards().includes(99), false);
});

test('page 1 of a superseded category neither lands nor arms an engine', async t => {
  const first = deferred();
  const h = setup(t, { routes: [
    [`${DISCOVER}/movies?page=1`, first.promise],
    [`${DISCOVER}/tv?page=1`, feed([2], 'tv', 1)]
  ] });
  const P = h.load();
  const opening = P.showCategoryPage('movies');
  await until(() => h.calls.some(call => call.path.endsWith('/movies?page=1')), 'first category');
  const { signal } = h.calls.find(call => call.path.endsWith('/movies?page=1'));
  await P.showCategoryPage('tv');
  assert.equal(signal.aborted, true);
  first.resolve(feed([1], 'movie'));
  await opening;
  assert.deepEqual(h.categoryCards(), [2]);
});

test('DISCOVERY-RECOMMENDATIONS-012: Back from a category returns to the page it was opened from', async t => {
  const h = setup(t, { hash: '#/recommendations', routes: [[`${DISCOVER}/trending?page=1`, feed([1], 'movie', 1)]] });
  const P = h.load();
  await until(() => h.page()?.querySelector('.je-recommendations-section'), 'rows');
  await P.showCategoryPage('trending');
  assert.equal(h.page().classList.contains('hide'), true);
  h.document.querySelector('#je-recommendations-category-back').click();
  assert.equal(P.state.categoryPageVisible, false);
  assert.equal(P.state.pageVisible, true);
  assert.equal(h.page().classList.contains('hide'), false);
  assert.equal(h.document.querySelector('#indexPage').classList.contains('hide'), true);
  assert.equal(h.window.location.hash, '#/recommendations');
  await until(() => h.page().querySelector('.je-recommendations-section'), 'rows again');
});

test('Back from a category opened on home returns home, and closing it leaves no cards behind', async t => {
  const h = setup(t, { routes: [[`${DISCOVER}/trending?page=1`, feed([1], 'movie', 1)]] });
  const P = h.load();
  await P.showCategoryPage('trending');
  assert.equal(h.document.querySelector('#indexPage').classList.contains('hide'), true);
  assert.deepEqual(h.categoryCards(), [1]);
  h.document.querySelector('#je-recommendations-category-back').click();
  assert.equal(h.document.querySelector('#indexPage').classList.contains('hide'), false);
  assert.equal(h.category().classList.contains('hide'), true);
  assert.deepEqual(h.categoryCards(), []);
  assert.equal(P.state.pageVisible, false);
  assert.equal(h.window.location.hash, '#/home');
});

test('navigating and another view showing close both pages', async t => {
  const h = setup(t, { hash: '#/recommendations', routes: [[`${DISCOVER}/trending?page=1`, feed([1], 'movie', 1)]] });
  const P = h.load();
  await until(() => h.page()?.querySelector('.je-recommendations-section'), 'rows');
  h.window.location.hash = '#/home';
  await until(() => !P.state.pageVisible, 'page closed');
  await P.showCategoryPage('trending');
  assert.equal(P.state.categoryPageVisible, true);
  h.document.querySelector('#indexPage').dispatchEvent(new h.window.CustomEvent('viewshow', { bubbles: true }));
  assert.equal(P.state.categoryPageVisible, false);
});

test('the disabled feature publishes its facade but touches nothing', async t => {
  const h = setup(t, { hash: '#/recommendations', config: { RecommendationsPageEnabled: false } });
  const P = h.load();
  await tick();
  assert.equal(h.page(), null);
  assert.equal(h.document.querySelector('.je-nav-recommendations-item'), null);
  await P.showCategoryPage('trending');
  assert.equal(h.category(), null);
  assert.equal(h.calls.length, 0);
  assert.deepEqual(Object.keys(h.JE.recommendationsPage).sort(), ['hidePage', 'renderForCustomTab', 'showPage']);
});

test('the sticky title reads the host header and stops with its page', async t => {
  const h = setup(t, { hash: '#/recommendations' });
  const P = h.load();
  await until(() => h.page()?.querySelector('.je-recommendations-section'), 'rows');
  const bar = h.document.createElement('div');
  h.document.body.appendChild(bar);
  h.JE.helpers.getHeaderBottom = () => 64;
  const stop = P.trackStickyBar(bar);
  assert.equal(bar.style.getPropertyValue('--je-sticky-top'), '64px');
  h.JE.helpers.getHeaderBottom = () => 80;
  stop();
  h.window.dispatchEvent(new h.window.Event('resize'));
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(bar.style.getPropertyValue('--je-sticky-top'), '64px');
});
