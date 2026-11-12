// Discovery sections through their shipped scripts, on the real core runtime (navigation, session,
// lifecycle, DOM observer, API client) and shared helpers: where a section joins its page, its header,
// the sort button and its menu, the held places while the first page loads, the busy list during a
// re-sort, and the line that says Seerr did not answer. Only Seerr's card renderer and user-status
// call are fixtures. The scroll engine is driven explicitly: real rendering and pagination run
// normally, with no geometry dependency.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { createHarness, deferred, englishT, jsonResponse, plain } from '../helpers/harness.mjs';

// The discovery modules in the manifest's order (component-scripts.json).
const DISCOVERY = ['jellyseerr/discovery/discovery-styles.js', 'jellyseerr/discovery/discovery-busy.js',
  'jellyseerr/discovery/discovery-menu.js', 'jellyseerr/discovery/discovery-roles.js', 'jellyseerr/discovery/discovery-section.js',
  'jellyseerr/discovery/discovery-filters.js', 'jellyseerr/discovery/discovery-filter-panel.js',
  'jellyseerr/discovery/discovery-filter-utils.js', 'jellyseerr/discovery/discovery-base.js'];
const RUNTIME = ['core/navigation.js', 'core/session.js', 'core/lifecycle.js', 'core/dom-observer.js', 'core/ui-kit.js',
  'core/api-client.js', 'enhanced/helpers.js', 'jellyseerr/seerr-status.js', 'jellyseerr/request-manager.js',
  'jellyseerr/seamless-scroll.js', ...DISCOVERY];
const ORIGIN = 'http://jellyfin.test';
const API = '/JellyfinEnhanced';
const LIST_PAGE = '<div class="page libraryPage" id="list"><div class="verticalSection"><div class="itemsContainer"><div class="card" data-id="host"></div></div></div></div>';
const NATIVE_LIST = '<div class="page libraryPage" id="list"><div class="padded-left padded-right padded-right-withalphapicker" id="wrap">'
  + '<div class="vertical-wrap itemsContainer"><div class="card" data-id="host"></div></div><div class="listPaging">1-1 of 1</div></div></div>';
const NATIVE_PERSON = '<div class="page itemDetailPage" id="detail"><div class="detailPagePrimaryContent"><div class="detailSection" id="primary">'
  + '<div class="verticalSection" id="filmography"></div></div></div><div class="detailPageSecondaryContainer" id="secondary"></div></div>';
const COMEDY = [`${API}/tmdb/genres/tv`, [{ id: 35, name: 'Comedy' }]];
const COMEDY_MOVIES = [`${API}/tmdb/genres/movie`, [{ id: 36, name: 'Comedy' }]];

async function until(condition, label = 'condition') {
  const deadline = performance.now() + 3000;
  while (!condition() && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(condition(), `${label} was not reached`);
}
const feed = (ids, mediaType, totalPages = 3) => ({ results: ids.map(id => ({ id, mediaType })), totalPages });
const ids = root => [...root.querySelectorAll('.card:not(.jellyseerr-card-placeholder)')].map(card => card.dataset.id).filter(id => id !== 'host').map(Number);
const menuOf = h => h.document.querySelector('.jellyseerr-sort-menu');
const key = (h, name) => h.document.activeElement.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));
/** Chooses a sort order the way a viewer does: the sort button, then the item in its menu. */
function chooseSort(h, section, value) {
  section.querySelector('.jellyseerr-sort-btn').click();
  h.document.querySelector(`.jellyseerr-sort-menu .actionSheetMenuItem[data-id="${value}"]`).click();
}

function setup(t, { hash, html = LIST_PAGE, routes = [], config = {}, items = {}, status = { active: true }, expectedConsoleErrors } = {}) {
  const calls = [];
  const table = new Map(routes);
  const h = createHarness({
    html, url: `${ORIGIN}/web/index.html${hash}`, expectedConsoleErrors,
    JE: { internals: {}, pluginConfig: config, t: englishT },
    apiClient: {
      getCurrentUserId: () => 'user-a', serverId: () => 'server-a', accessToken: () => 'token-a',
      getItem: async (_user, id) => items[id] ?? { Id: id, Type: 'Other' }
    },
    fetch: async (url, options) => {
      const path = url.replace(ORIGIN, '');
      calls.push({ path, signal: options.signal });
      const answer = table.has(path) ? table.get(path) : table.get(path.split('?')[0]);
      if (answer === undefined) return jsonResponse({ message: `no fixture for ${path}` }, 404);
      const value = typeof answer === 'function' ? await answer() : await answer;
      if (value instanceof Error) throw value;
      return jsonResponse(value);
    }
  });
  t.after(() => h.close());
  for (const file of RUNTIME) h.load(file);
  h.JE.jellyseerrAPI = { checkUserStatus: async () => status };
  h.JE.jellyseerrUI = {
    createJellyseerrCard(item) {
      const card = h.document.createElement('div');
      card.className = 'card portraitCard';
      card.dataset.id = String(item.id);
      card.innerHTML = '<div class="cardText-first"><a href="http://seerr.test/x" target="_blank" rel="noopener">Seerr</a></div>';
      return card;
    },
    releasePosters() {}
  };
  const armed = { count: 0, load: null };
  h.JE.discoveryFilter.setupInfiniteScroll = (_state, _selector, load) => { armed.count++; armed.load = load; };
  h.JE.discoveryFilter.cleanupScrollObserver = () => { armed.load = null; };
  return { ...h, calls, table, armed, section: name => h.document.querySelector(`.jellyseerr-${name}-discovery-section`) };
}
function loadGenre(t, options = {}) {
  return setup(t, { hash: '#/list?genreId=g1', ...options, routes: [
    [`${API}/genre/g1`, { id: 'g1', name: 'Comedy', type: 'Genre' }], COMEDY, COMEDY_MOVIES,
    [`${API}/jellyseerr/discover/tv/genre/35?page=1`, feed([1, 2], 'tv')],
    [`${API}/jellyseerr/discover/movies/genre/36?page=1`, feed([11, 12], 'movie')],
    ...(options.routes ?? [])
  ] });
}
const cardsOf = h => ids(h.section('genre') ?? h.document.createElement('div'));
const PERSON = { hash: '#/details?id=p1', html: NATIVE_PERSON, items: { p1: { Id: 'p1', Type: 'Person' } }, routes: [
  [`${API}/person/p1`, { name: 'Ann', tmdbId: '7' }],
  [`${API}/jellyseerr/person/7/combined_credits`, { cast: [{ id: 5, mediaType: 'movie' }, { id: 6, mediaType: 'tv' }, { id: 7, mediaType: 'movie' }] }]
] };

test('genre discovery interleaves both feeds, names the section and offers the filter once both answered', async t => {
  const h = loadGenre(t);
  h.load('jellyseerr/discovery/genre-discovery.js');
  await until(() => cardsOf(h).length === 4, 'first page');
  const section = h.section('genre');
  assert.deepEqual(cardsOf(h), [1, 11, 2, 12]);
  assert.equal(section.querySelector('.sectionTitle').textContent, 'More in Comedy');
  // The name the title is about stays whole when the title wraps.
  assert.equal(section.querySelector('.sectionTitle .jellyseerr-discovery-name').textContent, 'Comedy');
  assert.equal(section.parentElement.id, 'list', 'section sits beside the list section');
  assert.equal(section.querySelectorAll('.jellyseerr-filter-btn').length, 3);
  assert.equal(section.querySelector('.jellyseerr-sort-btn').textContent, 'Popular');
  assert.equal(h.armed.count, 1);
});

test('a sort change keeps the list on screen, busy, until its page 1 lands, and abandons the older load', async t => {
  const tvSorted = deferred();
  const late = deferred();
  const h = loadGenre(t, { routes: [
    [`${API}/jellyseerr/discover/tv/genre/35?page=2`, () => late.promise],
    [`${API}/jellyseerr/discover/movies/genre/36?page=2`, feed([], 'movie')],
    [`${API}/jellyseerr/discover/tv/genre/35?page=1&sortBy=vote_count.desc`, () => tvSorted.promise],
    [`${API}/jellyseerr/discover/movies/genre/36?page=1&sortBy=vote_count.desc`, feed([22], 'movie', 1)]
  ] });
  h.load('jellyseerr/discovery/genre-discovery.js');
  await until(() => cardsOf(h).length === 4 && h.armed.load, 'first page');
  const old = h.armed.load({ deficitPx: 10, pageBudget: 2 });
  await until(() => h.calls.some(call => call.path.endsWith('tv/genre/35?page=2')), 'the older load');
  const { signal } = h.calls.find(call => call.path.endsWith('tv/genre/35?page=2'));
  const section = h.section('genre');
  chooseSort(h, section, 'vote_count.desc');
  assert.equal(signal.aborted, true, 'its request ends with it');
  assert.equal(section.querySelector('.jellyseerr-sort-btn').textContent, 'Most votes');
  // Until Seerr answers, what was on screen stays there, marked as being replaced and taking no presses.
  const list = section.querySelector('.itemsContainer');
  assert.deepEqual(cardsOf(h), [1, 11, 2, 12]);
  assert.equal(list.getAttribute('aria-busy'), 'true');
  assert.equal(list.inert, true);
  tvSorted.resolve(feed([21], 'tv', 1));
  await until(() => String(cardsOf(h)) === '21,22', 'sorted first page');
  assert.equal(list.hasAttribute('aria-busy'), false);
  assert.equal(list.inert, false);
  late.resolve(feed([91], 'tv', 9));
  await old;
  assert.deepEqual(cardsOf(h), [21, 22], 'the older load lands nothing');
});

test('a list page\'s section begins inside the list\'s own wrapper, after its paging line, as a plain Jellyfin section', async t => {
  const h = loadGenre(t, { html: NATIVE_LIST });
  h.load('jellyseerr/discovery/genre-discovery.js');
  await until(() => cardsOf(h).length === 4, 'first page');
  const section = h.section('genre');
  // Inside the wrapper: the list's gutters and the room kept for the alphabet picker apply, so the grids line up.
  assert.equal(section.parentElement.id, 'wrap');
  assert.equal(section.previousElementSibling.className, 'listPaging');
  assert.ok(section.matches('.verticalSection.jellyseerr-discovery-section'));
  assert.ok(section.querySelector('.itemsContainer').matches('.vertical-wrap:not(.centered)'));
  // No inline styling of its own: the join is styled with the theme's variables in one place.
  assert.equal(section.getAttribute('style')?.replace(/--jellyseerr-sticky-top:[^;]*;?\s*/, '') || null, null);
  assert.equal(section.querySelector('.jellyseerr-discovery-header').getAttribute('style'), null);
  // The line that goes to the section waits, hidden, until the section starts below the first screen.
  const jump = h.document.querySelector('#wrap > .jellyseerr-join-jump');
  assert.equal(jump.hidden, true);
  assert.equal(jump.textContent, 'Go to More in Comedy');
  assert.ok(h.document.getElementById('jellyseerr-discovery-styles'));
});

test('a person\'s section begins in the page\'s primary column, after the page\'s own lists', async t => {
  const h = setup(t, PERSON);
  h.load('jellyseerr/discovery/person-discovery.js');
  await until(() => h.section('person'), 'person section');
  const section = h.section('person');
  assert.equal(section.parentElement.id, 'primary');
  assert.equal(section.previousElementSibling.id, 'filmography');
  assert.ok(section.matches('.detailVerticalSection'));
  assert.equal(h.document.querySelector('#secondary').childElementCount, 0);
  // Leaving the page (the section removed) takes the join with it.
  section.remove();
  await until(() => !h.document.querySelector('.jellyseerr-join-jump'), 'the line goes');
});

test('the header is the title, then one row: what the titles are, in words, and filter and sort together', async t => {
  const totals = (list, mediaType, totalResults, totalPages = 3) => ({ ...feed(list, mediaType, totalPages), totalResults });
  const h = loadGenre(t, { html: NATIVE_LIST, config: { JellyseerrExcludeLibraryItems: true }, routes: [
    [`${API}/jellyseerr/discover/tv/genre/35?page=1`, totals([1, 2], 'tv', 20001, 1001)],
    [`${API}/jellyseerr/discover/movies/genre/36?page=1`, totals([11, 12], 'movie', 57)]
  ] });
  h.load('jellyseerr/discovery/genre-discovery.js');
  await until(() => cardsOf(h).length === 4, 'first page');
  const header = h.section('genre').querySelector('.jellyseerr-discovery-header');
  assert.deepEqual([...header.children].map(child => child.className), ['sectionTitle sectionTitle-cards', 'jellyseerr-discovery-meta']);
  assert.deepEqual([...header.querySelector('.jellyseerr-discovery-meta').children].map(child => child.className), ['jellyseerr-discovery-summary', 'jellyseerr-discovery-bar']);
  assert.equal(header.querySelector('.jellyseerr-discovery-summary').textContent, 'Not in the library');
  assert.equal(header.getAttribute('data-jump-label'), 'Go to More in Comedy');
  assert.equal(header.getAttribute('data-jump-note'), ', not in the library');
  // No count anywhere in the header, whatever totals Seerr reports and whichever filter is chosen.
  const bar = header.querySelector('.jellyseerr-discovery-bar');
  assert.deepEqual([...bar.children].map(child => child.className.split(' ')[0]), ['jellyseerr-discovery-filter', 'jellyseerr-filters-btn', 'jellyseerr-sort-btn']);
  for (const mode of ['tv', 'movies', 'mixed']) {
    bar.querySelector(`[data-mode="${mode}"]`).click();
    assert.equal(/\d/.test(header.textContent), false, mode);
    assert.deepEqual([...bar.querySelectorAll('.jellyseerr-filter-btn')].map(tab => tab.getAttribute('aria-pressed')),
      ['mixed', 'movies', 'tv'].map(each => String(each === mode)), mode);
  }
  // The tabs are Jellyfin's own tab buttons, in a named group; the chosen one carries Jellyfin's active class.
  const tabs = bar.querySelector('.jellyseerr-discovery-filter');
  assert.ok(tabs.matches('[role="group"][aria-label="Filter"][data-type-group]'));
  assert.ok(tabs.querySelector('[data-mode="mixed"]').matches('button.emby-tab-button.emby-button.emby-tab-button-active'));
  // Held on a phone, the tabs' place shows the title (for the eye only).
  assert.equal(tabs.querySelector('.jellyseerr-filter-held-title[aria-hidden="true"]').textContent, 'More in Comedy');
  // The Filters menu reads the type choice from here.
  const picker = h.JE.discoveryFilter.typePickerOf(tabs);
  assert.deepEqual(plain(picker.groupOf().choices).map(choice => [choice.id, choice.name, choice.selected]),
    [['mixed', 'All', true], ['movies', 'Movies', false], ['tv', 'Series', false]]);
  picker.choose('tv');
  assert.ok(h.section('genre').querySelector('.itemsContainer').classList.contains('filter-tv'));
  assert.equal(picker.tabsShowing(), true);
  // With a filter the bar may take the row under the summary for itself on a phone.
  assert.ok(bar.hasAttribute('data-has-filter'));
  assert.ok(header.hasAttribute('data-has-filter'));
});

test('a section of one type has a lone sort, which shares the summary\'s row; the summary is said only when it is true', async t => {
  const oneType = { hash: '#/list?genreId=g1', html: NATIVE_LIST, routes: [
    [`${API}/genre/g1`, { id: 'g1', name: 'Comedy', type: 'Genre' }], COMEDY, [`${API}/tmdb/genres/movie`, []],
    [`${API}/jellyseerr/discover/tv/genre/35?page=1`, { results: [{ id: 1, mediaType: 'tv' }], totalPages: 1, totalResults: 1 }]
  ] };
  const h = setup(t, { ...oneType, config: { JellyseerrExcludeLibraryItems: true } });
  h.load('jellyseerr/discovery/genre-discovery.js');
  await until(() => cardsOf(h).length === 1, 'first page');
  const bar = h.section('genre').querySelector('.jellyseerr-discovery-bar');
  assert.equal(bar.querySelector('.jellyseerr-discovery-filter'), null);
  assert.equal(bar.hasAttribute('data-has-filter'), false);
  assert.equal(bar.previousElementSibling.textContent, 'Not in the library');
  // The admin shows library titles in these sections: the line would be false, so it is not there.
  const all = setup(t, { ...oneType, config: { JellyseerrExcludeLibraryItems: false } });
  all.load('jellyseerr/discovery/genre-discovery.js');
  await until(() => cardsOf(all).length === 1, 'first page');
  assert.equal(all.section('genre').querySelector('.jellyseerr-discovery-summary'), null);
  assert.ok(all.section('genre').querySelector('.jellyseerr-discovery-meta > .jellyseerr-discovery-bar > .jellyseerr-sort-btn'));
});

test('the sort is a quiet button that names the current order, not a form field', async t => {
  const h = setup(t, PERSON);
  h.load('jellyseerr/discovery/person-discovery.js');
  await until(() => h.section('person'), 'person section');
  const header = h.section('person').querySelector('.jellyseerr-discovery-header');
  assert.equal(header.querySelector('select, input, .selectContainer, [is="emby-select"]'), null);
  const button = header.querySelector('.jellyseerr-sort-btn');
  // The filter tabs' own classes, so it is their type and weight; the order is its visible word.
  assert.ok(button.matches('button.emby-tab-button.emby-button[aria-haspopup="menu"][aria-expanded="false"]'));
  assert.equal(button.textContent, 'Popular');
  assert.equal(button.getAttribute('aria-label'), 'Sort: Popular');
  assert.equal(button.querySelector('.material-icons').getAttribute('aria-hidden'), 'true');
  // Before it, the Filters button; before that, All / Movies / Series.
  assert.equal(button.previousElementSibling.className, 'jellyseerr-filters-btn emby-tab-button emby-button');
  assert.equal(button.previousElementSibling.previousElementSibling.className, 'jellyseerr-discovery-filter');
  assert.equal(menuOf(h), null);
});

test('the sort button opens Jellyfin\'s action sheet with the current order ticked, and a choice re-sorts and is named on the button', async t => {
  const h = setup(t, PERSON);
  h.load('jellyseerr/discovery/person-discovery.js');
  await until(() => h.section('person'), 'person section');
  const section = h.section('person');
  const button = section.querySelector('.jellyseerr-sort-btn');
  assert.deepEqual(ids(section), [6, 5, 7]);
  button.click();
  assert.equal(button.getAttribute('aria-expanded'), 'true');
  const menu = menuOf(h);
  // Jellyfin's own action-sheet markup and classes, so its stylesheet and the theme draw the menu.
  assert.ok(menu.matches('.dialogContainer > .focuscontainer.dialog.actionSheet.opened[role="menu"]'));
  assert.equal(menu.getAttribute('aria-label'), 'Sort');
  // The small menu has no title row (its name is its label).
  assert.equal(menu.querySelector('.actionSheetTitle'), null);
  assert.ok(h.document.querySelector('.dialogBackdrop.dialogBackdropOpened'));
  const items = [...menu.querySelectorAll('.actionSheetScroller > button.listItem.listItem-button.actionSheetMenuItem')];
  assert.deepEqual(items.map(item => [item.dataset.id, item.querySelector('.actionSheetItemText').textContent, item.getAttribute('aria-checked'), item.getAttribute('role')]),
    [['', 'Popular', 'true', 'menuitemradio'], ['vote_average.desc', 'Top rated', 'false', 'menuitemradio'], ['vote_count.desc', 'Most votes', 'false', 'menuitemradio'],
      ['release_date.desc', 'Newest', 'false', 'menuitemradio'], ['release_date.asc', 'Oldest', 'false', 'menuitemradio']]);
  // The tick is an icon in every item's icon slot, shown on the current one only.
  assert.deepEqual(items.map(item => item.querySelector('.actionsheetMenuItemIcon.material-icons.check').style.visibility), ['', 'hidden', 'hidden', 'hidden', 'hidden']);
  assert.equal(h.document.activeElement, items[0], 'focus starts on the current order');
  // Keyboard and remote: down moves, Enter (a button's own click) chooses.
  key(h, 'ArrowDown'); key(h, 'ArrowDown');
  assert.equal(h.document.activeElement, items[2]);
  key(h, 'ArrowUp');
  assert.equal(h.document.activeElement, items[1]);
  key(h, 'End');
  assert.equal(h.document.activeElement, items[4]);
  key(h, 'ArrowDown');
  assert.equal(h.document.activeElement, items[0], 'the keys go round');
  key(h, 'ArrowDown');
  h.document.activeElement.click();
  assert.equal(menuOf(h), null);
  assert.equal(h.document.querySelector('.dialogBackdrop'), null);
  assert.equal(button.getAttribute('aria-expanded'), 'false');
  assert.equal(button.textContent, 'Top rated');
  assert.equal(button.getAttribute('aria-label'), 'Sort: Top rated');
  assert.equal(h.document.activeElement, button, 'focus returns to the button');
  assert.equal(h.JE.discoveryFilter.getSortMode('person'), 'vote_average.desc');
  // Opened again, the tick has moved.
  button.click();
  assert.deepEqual([...menuOf(h).querySelectorAll('.actionSheetMenuItem')].map(item => item.getAttribute('aria-checked')), ['false', 'true', 'false', 'false', 'false']);
});

test('the sort menu closes without a change on Escape, on a press outside it, on a remote\'s Back, on leaving, and when the current order is chosen', async t => {
  const h = setup(t, PERSON);
  h.load('jellyseerr/discovery/person-discovery.js');
  await until(() => h.section('person'), 'person section');
  const button = h.section('person').querySelector('.jellyseerr-sort-btn');
  const closedUnchanged = how => {
    assert.equal(menuOf(h), null, how);
    assert.equal(button.textContent, 'Popular', how);
    assert.equal(h.JE.discoveryFilter.getSortMode('person'), '', how);
  };
  button.click(); key(h, 'Escape'); closedUnchanged('Escape');
  assert.equal(h.document.activeElement, button);
  button.click(); h.document.querySelector('.dialogBackdrop').click(); closedUnchanged('backdrop');
  button.click(); menuOf(h).parentElement.click(); closedUnchanged('the dialog container');
  button.click(); menuOf(h).querySelector('[data-id=""]').click(); closedUnchanged('the current order');
  // A TV remote's Back closes the menu and goes no further, so the page stays.
  for (const back of [{ key: 'GoBack' }, { key: 'BrowserBack' }, { key: 'Unidentified', keyCode: 461 }, { key: 'Unidentified', keyCode: 10009 }]) {
    button.click();
    let passedOn = 0;
    const count = () => { passedOn++; };
    h.document.addEventListener('keydown', count);
    const event = new h.window.KeyboardEvent('keydown', { ...back, bubbles: true, cancelable: true });
    h.document.activeElement.dispatchEvent(event);
    h.document.removeEventListener('keydown', count);
    closedUnchanged(JSON.stringify(back));
    assert.deepEqual([event.defaultPrevented, passedOn], [true, 0], JSON.stringify(back));
  }
  // Leaving the page takes the menu with it, and the menu adds no history entry of its own.
  const entries = h.window.history.length;
  button.click();
  assert.equal(h.window.history.length, entries);
  h.window.dispatchEvent(new h.window.Event('popstate'));
  closedUnchanged('navigation');
  // Only one menu at a time.
  button.click(); button.click();
  assert.equal(h.document.querySelectorAll('.jellyseerr-sort-menu').length, 1);
});

test('on a TV the sort menu is Jellyfin\'s action sheet with its title row', async t => {
  const h = setup(t, PERSON);
  h.document.documentElement.classList.add('layout-tv');
  h.load('jellyseerr/discovery/person-discovery.js');
  await until(() => h.section('person'), 'person section');
  h.section('person').querySelector('.jellyseerr-sort-btn').click();
  assert.equal(menuOf(h).querySelector('.actionSheetContent > h1.actionSheetTitle').textContent, 'Sort');
  // Jellyfin's own rules place it: no position of the menu's own.
  assert.equal(menuOf(h).style.position, '');
  key(h, 'Escape');
  assert.equal(menuOf(h), null);
});

test('"Most votes" sorts a person\'s titles by their votes, a protected title by its hidden count', async t => {
  const h = setup(t, { ...PERSON, routes: [
    [`${API}/person/p1`, { name: 'Ann', tmdbId: '7' }],
    [`${API}/jellyseerr/person/7/combined_credits`, { cast: [
      { id: 5, mediaType: 'movie', voteCount: 10 }, { id: 6, mediaType: 'movie', jeSortVotes: 700 },
      { id: 7, mediaType: 'movie', voteCount: 300 }, { id: 8, mediaType: 'movie' }
    ] }]
  ] });
  h.load('jellyseerr/discovery/person-discovery.js');
  await until(() => h.section('person'), 'person section');
  chooseSort(h, h.section('person'), 'vote_count.desc');
  assert.deepEqual(ids(h.section('person')), [6, 7, 5, 8]);
});

test('the section\'s place is held with empty cards of the page\'s own shape until the first page lands', async t => {
  const tv = deferred();
  const h = loadGenre(t, { html: NATIVE_LIST, routes: [[`${API}/jellyseerr/discover/tv/genre/35?page=1`, () => tv.promise]] });
  h.load('jellyseerr/discovery/genre-discovery.js');
  await until(() => h.section('genre'), 'section');
  const held = [...h.section('genre').querySelectorAll('.jellyseerr-card-placeholder')];
  assert.equal(held.length, 10);
  assert.ok(held.every(card => card.matches('.card.portraitCard[aria-hidden="true"]') && !card.querySelector('[tabindex], a, button')));
  assert.ok(held.every(card => card.querySelector('.cardPadder-portrait')));
  assert.deepEqual(cardsOf(h), []);
  tv.resolve(feed([1, 2], 'tv'));
  await until(() => cardsOf(h).length === 4, 'first page');
  assert.equal(h.section('genre').querySelectorAll('.jellyseerr-card-placeholder').length, 0);
});

test('the header keeps to the top of the screen just under Jellyfin\'s own header', async t => {
  const h = loadGenre(t, { html: NATIVE_LIST });
  h.JE.helpers.getHeaderBottom = () => 56.4;
  h.load('jellyseerr/discovery/genre-discovery.js');
  await until(() => cardsOf(h).length === 4, 'first page');
  assert.equal(h.section('genre').style.getPropertyValue('--jellyseerr-sticky-top'), '56px');
});

test('a collection\'s missing titles are a section of the page\'s primary column, with a translated title', async t => {
  const h = setup(t, { hash: '#/details?id=b1', html: NATIVE_PERSON, items: { b1: { Id: 'b1', Type: 'BoxSet' } }, routes: [
    [`${API}/boxset/b1`, { id: 'b1', name: 'Alien', tmdbId: '8091', type: 'BoxSet' }]
  ] });
  h.JE.jellyseerrAPI.fetchCollectionDetails = async () => ({ parts: [
    { id: 2, releaseDate: '1986-07-18' }, { id: 1, releaseDate: '1979-05-25', mediaInfo: { status: 5 } }, { id: 3, releaseDate: '1992-05-22' }
  ] });
  h.load('jellyseerr/discovery/collection-discovery.js');
  await until(() => h.section('collection'), 'collection section');
  const section = h.section('collection');
  assert.equal(section.parentElement.id, 'primary');
  assert.ok(section.matches('.verticalSection.detailVerticalSection.jellyseerr-discovery-section'));
  assert.equal(section.querySelector('.jellyseerr-discovery-header > .sectionTitle').textContent, 'Missing from Alien (1/3)');
  assert.equal(section.querySelector('.jellyseerr-discovery-header').getAttribute('data-jump-label'), 'Go to Missing from Alien (1/3)');
  assert.deepEqual(ids(section), [2, 3]);
});

test('a person\'s lookup that fails says Seerr did not answer, with Jellyfin\'s button to try again', async t => {
  const h = setup(t, { hash: '#/details?id=p1', html: NATIVE_PERSON, expectedConsoleErrors: ['Error rendering person discovery'] });
  let fail = true;
  const controller = h.JE.discoveryBase.createDiscovery({
    key: 'person', mode: 'client-paged', logLabel: 'Person Discovery', configKey: 'JellyseerrShowPersonDiscovery',
    getIdFromUrl: () => 'p1',
    resolveItems: async () => {
      if (fail) throw new Error('Seerr is down');
      return { title: 'More with Ann', name: 'Ann', items: [{ id: 1, mediaType: 'movie' }] };
    }
  });
  await controller.render();
  const retry = h.section('person');
  assert.ok(retry.matches('.jellyseerr-discovery-section.je-retry-row'));
  assert.equal(retry.parentElement.id, 'primary');
  const row = retry.querySelector('.jellyseerr-section-message[role="status"]');
  assert.equal(row.querySelector('span').textContent, "Seerr didn't answer.");
  const button = row.querySelector('button');
  assert.equal(button.textContent, 'Try again');
  assert.ok(button.matches('.raised.emby-button.jellyseerr-section-message-action'));
  fail = false;
  button.click();
  await until(() => h.section('person') && !h.section('person').classList.contains('je-retry-row'), 'the section');
  assert.deepEqual(ids(h.section('person')), [1]);
  assert.equal(h.document.querySelectorAll('.je-retry-row').length, 0);
  controller.cleanup();
});

test('filter and sort primitives keep their published contract', t => {
  const h = createHarness({ JE: { t: englishT } });
  t.after(() => h.close());
  for (const file of DISCOVERY.slice(0, -1)) h.load(file);
  const f = h.JE.discoveryFilter;
  assert.deepEqual(plain(f.SORT_OPTIONS).map(option => [option.value, option.labelKey]), [
    ['', 'discovery_sort_popular'], ['vote_average.desc', 'discovery_sort_top_rated'], ['vote_count.desc', 'discovery_sort_most_votes'],
    ['release_date.desc', 'discovery_sort_newest'], ['release_date.asc', 'discovery_sort_oldest']]);
  const header = f.createSectionHeader('T', 'demo', true, () => {}, () => {});
  assert.equal(header.querySelector('.sectionTitle').textContent, 'T');
  // The filter names sets of titles (plural), in sentence case like the rest of Jellyfin's controls.
  assert.deepEqual([...header.querySelectorAll('.jellyseerr-filter-btn')].map(button => button.textContent), ['All', 'Movies', 'Series']);
  // The sort's choices are in its menu.
  h.document.body.appendChild(header);
  header.querySelector('.jellyseerr-sort-btn').click();
  assert.deepEqual([...h.document.querySelectorAll('.jellyseerr-sort-menu .actionSheetItemText')].map(option => option.textContent), ['Popular', 'Top rated', 'Most votes', 'Newest', 'Oldest']);
  h.document.querySelector('.dialogBackdrop').click();
  // What a feed asks for: the order (series by their first air date), then the further filters.
  f.setSortMode('demo', 'release_date.desc');
  assert.equal(f.feedQuery('demo', 'tv'), '&sortBy=first_air_date.desc');
  assert.equal(f.feedQuery('demo', 'movie'), '&sortBy=release_date.desc');
  assert.equal(f.hasMoreFilters('demo'), false);
  assert.deepEqual(f.keepByFilters('demo', [{ id: 1 }]), [{ id: 1 }]);
  // Without the menu module the sort button opens nothing, and nothing breaks.
  delete h.JE.discoveryMenu;
  header.querySelector('.jellyseerr-sort-btn').click();
  assert.equal(h.document.querySelector('.jellyseerr-sort-menu'), null);
});

test('a grouped menu says what is set in each group, opens one group at a time and clears them all', t => {
  const h = createHarness({ JE: { t: englishT } });
  t.after(() => h.close());
  h.load('jellyseerr/discovery/discovery-menu.js');
  const anchor = h.document.createElement('button');
  h.document.body.appendChild(anchor);
  const picks = [];
  let cleared = 0;
  let closed = 0;
  const built = [];
  h.JE.discoveryMenu.openMenu({
    anchor, title: 'Filters', clearLabel: 'Clear filters', doneLabel: 'Done',
    groups: [
      { id: 'type', name: 'Type', choices: [{ id: 'mixed', name: 'All', selected: true }, { id: 'tv', name: 'Series', selected: false }] },
      { id: 'year', name: 'Released', any: 'Any', build(host, handle) { built.push(host); host.textContent = 'fields'; handle.say('1990 to 1999', true); } }
    ],
    onPick: (id, group) => picks.push([id, group]), onClear: () => { cleared++; }, onClose: () => { closed++; }
  });
  const menu = menuOf(h);
  assert.ok(menu.matches('[role="dialog"][aria-label="Filters"].jellyseerr-menu-grouped'));
  const groups = () => [...menu.querySelectorAll('.jellyseerr-menu-group')];
  assert.deepEqual(groups().map(group => [group.dataset.toggle, group.textContent, group.getAttribute('aria-expanded'), group.hasAttribute('data-set')]),
    [['type', 'TypeAll', 'false', false], ['year', 'ReleasedAny', 'false', false]]);
  // With nothing set there is nothing to clear.
  const clear = menu.querySelector('.jellyseerr-menu-foot > .jellyseerr-menu-clear');
  assert.equal(clear.getAttribute('aria-disabled'), 'true');
  assert.ok(menu.querySelector('.jellyseerr-menu-foot > .jellyseerr-menu-done'));
  groups()[0].click();
  const typeBody = groups()[0].nextElementSibling;
  assert.ok(typeBody.matches('.jellyseerr-menu-choices[role="radiogroup"]:not([hidden])'));
  assert.equal(groups()[0].getAttribute('aria-controls'), typeBody.id);
  typeBody.querySelector('[data-id="tv"]').click();
  assert.deepEqual(picks, [['tv', 'type']]);
  assert.equal(groups()[0].textContent, 'TypeSeries');
  assert.ok(groups()[0].hasAttribute('data-set'));
  assert.equal(clear.hasAttribute('aria-disabled'), false);
  assert.ok(menuOf(h), 'a group\'s choice leaves the menu open');
  // One group open at a time; a body of the caller's own is built when first opened.
  groups()[1].click();
  assert.equal(typeBody.hidden, true);
  assert.equal(built.length, 1);
  assert.equal(groups()[1].textContent, 'Released1990 to 1999');
  // Back to the group's own row from inside its body.
  groups()[1].nextElementSibling.tabIndex = -1;
  groups()[1].nextElementSibling.focus();
  key(h, 'ArrowLeft');
  assert.equal(h.document.activeElement, groups()[1]);
  clear.click();
  assert.equal(cleared, 1);
  assert.deepEqual(groups().map(group => [group.textContent, group.hasAttribute('data-set'), group.getAttribute('aria-expanded')]),
    [['TypeAll', false, 'false'], ['ReleasedAny', false, 'false']]);
  assert.equal(clear.getAttribute('aria-disabled'), 'true');
  assert.equal(h.document.activeElement, groups()[0]);
  // Built anew when next opened.
  groups()[1].click();
  assert.equal(built.length, 2);
  menu.querySelector('.jellyseerr-menu-done').click();
  assert.equal(menuOf(h), null);
  assert.equal(closed, 1);
  assert.equal(h.JE.discoveryMenu.groupedMenuRoom(3) > 0, true);
});

test('the scroll engine\'s retry row says Seerr did not answer, with Jellyfin\'s button to try again', async t => {
  const h = createHarness({ html: '<section id="feed"><div class="itemsContainer"></div></section>', JE: { t: englishT },
    globals: { IntersectionObserver: class { observe() {} disconnect() {} } } });
  t.after(() => h.close());
  h.load('jellyseerr/seamless-scroll.js');
  const engine = h.JE.seamlessScroll;
  Object.assign(engine.CONFIG.retry, { baseDelayMs: 0, maxDelayMs: 0 });
  h.document.querySelector('section').getClientRects = () => [{}];
  const state = {};
  t.after(() => engine.cleanupInfiniteScroll(state));
  let failing = true;
  let loads = 0;
  engine.setupInfiniteScroll(state, '#feed', async () => { loads++; if (failing) throw new Error('down'); return { pages: 1, rendered: 0 }; }, () => true, () => false);
  await until(() => h.document.querySelector('.je-retry-row'), 'the retry row');
  assert.equal(loads, engine.CONFIG.retry.maxAttempts);
  const row = h.document.querySelector('.je-retry-row');
  assert.ok(row.matches('.jellyseerr-section-message[role="status"]:not(.jellyseerr-section-message-inline)'));
  assert.equal(row.querySelector('span').textContent, "Seerr didn't answer.");
  const button = row.querySelector('button');
  assert.equal(button.textContent, 'Try again');
  assert.ok(button.matches('.raised.emby-button.jellyseerr-section-message-action'));
  failing = false;
  button.click();
  await nextTurn();
  assert.ok(loads > engine.CONFIG.retry.maxAttempts);
  // Pages that render nothing pause the engine with the icon-only "Look for more".
  await until(() => h.document.querySelector('.je-retry-row button[aria-label="Look for more"]'), 'look for more');
  const further = h.document.querySelector('.je-retry-row button');
  assert.equal(further.title, 'Look for more');
  assert.equal(further.querySelector('.material-icons[aria-hidden="true"]').textContent, 'refresh');
  assert.equal(h.document.querySelector('.je-retry-row span:not(.material-icons)'), null);
});

test('the Recommendations category sorts through the same button and menu, "Most votes" included', async t => {
  const h = createHarness({ html: '<div class="page mainAnimatedPage" id="home"></div>', JE: {
    t: englishT, pluginConfig: { RecommendationsPageEnabled: true },
    internals: { recommendationsPage: {
      state: {}, hidePage() {}, trackStickyBar: () => () => {},
      resolveCategory: key => key === 'popular' ? { title: 'Popular', feeds: [{ path: '/feed' }] } : null,
      fetchWithManagedRequest: async () => ({ totalPages: 1, results: [
        { id: 1, mediaType: 'movie', voteCount: 5 }, { id: 2, mediaType: 'movie', voteCount: 50 }, { id: 3, mediaType: 'movie', jeSortVotes: 20 }
      ] })
    } }
  } });
  t.after(() => h.close());
  for (const file of ['jellyseerr/discovery/discovery-menu.js', 'jellyseerr/discovery/discovery-section.js', 'jellyseerr/discovery/discovery-filter-utils.js']) h.load(file);
  h.JE.jellyseerrUI = { createJellyseerrCard(item) { const card = h.document.createElement('div'); card.className = 'card'; card.dataset.id = String(item.id); return card; } };
  h.JE.discoveryFilter.setupInfiniteScroll = () => {};
  h.JE.discoveryFilter.cleanupScrollObserver = () => {};
  h.load('jellyseerr/recommendations/recommendations-category.js');
  const P = h.JE.internals.recommendationsPage;
  await P.showCategoryPage('popular');
  const shown = () => [...h.document.querySelectorAll('#je-recommendations-category-container .card')].map(card => Number(card.dataset.id));
  assert.deepEqual(shown(), [1, 2, 3]);
  const sort = h.document.querySelector('#je-recommendations-category-sort .jellyseerr-sort-btn');
  assert.equal(sort.textContent, 'Popular');
  sort.click();
  h.document.querySelector('.jellyseerr-sort-menu .actionSheetMenuItem[data-id="vote_count.desc"]').click();
  assert.equal(sort.textContent, 'Most votes');
  await until(() => String(shown()) === '2,3,1', 'sorted by votes');
  P.hideCategoryPage();
});
