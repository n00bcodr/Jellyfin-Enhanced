// A person's role line on discovery cards (discovery-roles.js, the credits merge in
// person-discovery.js) and the busy state of a list being replaced (discovery-busy.js), through
// the shipped scripts on the real core runtime. Only Seerr's card renderer and user-status call
// are fixtures; the scroll engine is driven explicitly.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, deferred, englishT, jsonResponse } from '../helpers/harness.mjs';

const RUNTIME = ['core/navigation.js', 'core/session.js', 'core/lifecycle.js', 'core/dom-observer.js', 'core/ui-kit.js',
  'core/api-client.js', 'enhanced/helpers.js', 'jellyseerr/seerr-status.js', 'jellyseerr/request-manager.js',
  'jellyseerr/seamless-scroll.js', 'jellyseerr/discovery/discovery-styles.js', 'jellyseerr/discovery/discovery-busy.js',
  'jellyseerr/discovery/discovery-menu.js', 'jellyseerr/discovery/discovery-roles.js', 'jellyseerr/discovery/discovery-section.js',
  'jellyseerr/discovery/discovery-filters.js', 'jellyseerr/discovery/discovery-filter-panel.js',
  'jellyseerr/discovery/discovery-filter-utils.js', 'jellyseerr/discovery/discovery-base.js'];
const ORIGIN = 'http://jellyfin.test';
const API = '/JellyfinEnhanced';
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

function setup(t, { hash, html = NATIVE_LIST, routes = [], config = {}, items = {} } = {}) {
  const who = { user: 'user-a', server: 'server-a' };
  const calls = [];
  const table = new Map(routes);
  const h = createHarness({
    html, url: `${ORIGIN}/web/index.html${hash}`,
    JE: { internals: {}, pluginConfig: config, t: englishT },
    apiClient: {
      getCurrentUserId: () => who.user, serverId: () => who.server, accessToken: () => `token-${who.user}`,
      getItem: async (_user, id) => items[id] ?? { Id: id, Type: 'Other' }
    },
    fetch: async (url, options) => {
      const path = url.replace(ORIGIN, '');
      calls.push({ path, signal: options.signal });
      const answer = table.has(path) ? table.get(path) : table.get(path.split('?')[0]);
      if (answer === undefined) return jsonResponse({ message: `no fixture for ${path}` }, 404);
      const value = typeof answer === 'function' ? await answer(who) : await answer;
      if (value instanceof Error) throw value;
      return jsonResponse(value);
    }
  });
  t.after(() => h.close());
  for (const file of RUNTIME) h.load(file);
  h.JE.jellyseerrAPI = { checkUserStatus: async () => ({ active: true }) };
  const rendered = [];
  h.JE.jellyseerrUI = {
    createJellyseerrCard(item) {
      rendered.push(item);
      const card = h.document.createElement('div');
      card.className = 'card portraitCard';
      card.dataset.id = String(item.id);
      card.innerHTML = '<div class="cardText-first"><a href="http://seerr.test/x" target="_blank" rel="noopener">Seerr</a></div>';
      return card;
    },
    releasePosters() {}
  };
  h.JE.discoveryFilter.setupInfiniteScroll = () => {};
  h.JE.discoveryFilter.cleanupScrollObserver = () => {};
  return { ...h, calls, table, rendered, section: name => h.document.querySelector(`.jellyseerr-${name}-discovery-section`) };
}

const PERSON = { hash: '#/details?id=p1', html: NATIVE_PERSON, items: { p1: { Id: 'p1', Type: 'Person' } } };

test('a person\'s titles say what the person did in each: the parts played, then the jobs held, once each', async t => {
  const h = setup(t, { ...PERSON, routes: [
    [`${API}/person/p1`, { name: 'Ann', tmdbId: '7' }],
    [`${API}/jellyseerr/person/7/combined_credits`, {
      cast: [{ id: 5, mediaType: 'movie', character: 'Ted Mosby' }, { id: 5, mediaType: 'movie', character: 'Ted Mosby (voice)' },
        { id: 6, mediaType: 'tv', character: ' ' }, { id: 5, mediaType: 'movie', character: 'Ted Mosby' }],
      crew: [{ id: 5, mediaType: 'movie', job: 'Director', department: 'Directing' }, { id: 7, mediaType: 'movie', job: 'Writer', department: 'Writing' },
        { id: 7, mediaType: 'movie', job: 'Director', department: 'Directing' }]
    }]
  ] });
  h.load('jellyseerr/discovery/person-discovery.js');
  await until(() => h.section('person')?.querySelectorAll('.card').length === 3, 'three titles');
  const roleOf = id => h.section('person').querySelector(`.card[data-id="${id}"] .jellyseerr-role`);
  // One card for the title the person has four credits in; it gathers them: the parts on one line, the jobs on the next.
  assert.deepEqual([...roleOf(5).children].map(line => [line.localName, line.textContent]), [['bdi', 'as Ted Mosby, Ted Mosby (voice)'], ['bdi', 'Director']]);
  assert.ok(roleOf(5).classList.contains('jellyseerr-role-both'));
  assert.equal(roleOf(5).title, 'as Ted Mosby, Ted Mosby (voice)\nDirector');
  assert.equal(roleOf(7).classList.contains('jellyseerr-role-both'), false);
  assert.equal(roleOf(7).textContent, 'Writer, Director');
  // No part named: the line is there, empty, so the grid's rows stay level.
  assert.equal(roleOf(6).textContent, ' ');
  assert.equal(roleOf(6).hasAttribute('title'), false);
  // The line comes right under the title.
  assert.ok(roleOf(5).previousElementSibling.matches('.cardText-first'));
  // What the merge hands on: everything the person did in each title, in the order Seerr gave it.
  const credit = id => JSON.parse(JSON.stringify(h.rendered.find(item => item.id === id).jeCredit));
  assert.deepEqual(credit(5), { acted: true, characters: ['Ted Mosby', 'Ted Mosby (voice)'], jobs: ['Director'], departments: ['Directing'], crew: [['Director', 'Directing']] });
  assert.deepEqual(credit(6), { acted: true, characters: [], jobs: [], departments: [], crew: [] });
  assert.deepEqual(credit(7), { acted: false, characters: [], jobs: ['Writer', 'Director'], departments: ['Writing', 'Directing'], crew: [['Writer', 'Writing'], ['Director', 'Directing']] });
});

test('a list page\'s cards have no such line', async t => {
  const h = setup(t, { hash: '#/list?genreId=g1', routes: [
    [`${API}/genre/g1`, { id: 'g1', name: 'Comedy', type: 'Genre' }], COMEDY, COMEDY_MOVIES,
    [`${API}/jellyseerr/discover/tv/genre/35?page=1`, feed([1, 2], 'tv')],
    [`${API}/jellyseerr/discover/movies/genre/36?page=1`, feed([11, 12], 'movie')]
  ] });
  h.load('jellyseerr/discovery/genre-discovery.js');
  await until(() => ids(h.section('genre') ?? h.document.createElement('div')).length === 4, 'first page');
  assert.equal(h.section('genre').querySelector('.jellyseerr-role'), null);
});

/** A bare harness with the role and busy modules alone, for what does not need a whole section. */
function bare(t, html = '') {
  const h = createHarness({ html, JE: { t: englishT } });
  t.after(() => h.close());
  h.load('jellyseerr/discovery/discovery-busy.js');
  h.load('jellyseerr/discovery/discovery-roles.js');
  return h;
}
/** A card as Seerr's card renderer draws it, with the role line put in. */
function card(h, item) {
  const element = h.document.createElement('div');
  element.className = 'card';
  element.innerHTML = '<div class="cardText cardText-first">Title</div><div class="cardText cardText-secondary">2001</div>';
  h.JE.discoveryRoles.decorateCard(element, item);
  return element;
}
const credit = (characters, crew) => ({ jeCredit: { acted: characters.length > 0, characters, jobs: crew.map(([job]) => job), departments: [...new Set(crew.map(([, d]) => d))], crew } });
/**
 * Lays a line out as a card of `room` letters would: jsdom has no layout, so a line's width is its length.
 * @returns {HTMLElement} The line
 */
function narrow(line, room) {
  Object.defineProperty(line, 'clientWidth', { configurable: true, get: () => room });
  Object.defineProperty(line, 'scrollWidth', { configurable: true, get: () => line.textContent.length });
  return line;
}

test('a card with no credit gets no line, and TMDB\'s "Creator" is said as the Role filter says it', t => {
  const h = bare(t);
  assert.equal(card(h, { id: 1 }).querySelector('.jellyseerr-role'), null);
  assert.equal(card(h, { id: 1, jeCredit: null }).querySelector('.jellyseerr-role'), null);
  const line = card(h, credit([], [['Creator', 'Writing'], ['Producer', 'Production']])).querySelector('.jellyseerr-role');
  assert.equal(line.textContent, 'Creator, Producer');
  assert.deepEqual(JSON.parse(line.firstElementChild.dataset.jobs), [['Creator', 'Writing'], ['Producer', 'Production']]);
  // The words are text, never markup.
  const unsafe = card(h, credit(['<img src=x onerror=alert(1)>'], [])).querySelector('.jellyseerr-role');
  assert.equal(unsafe.querySelector('img'), null);
  assert.equal(unsafe.textContent, 'as <img src=x onerror=alert(1)>');
});

test('several parts of one credit ("A / B") are each a part, said once', t => {
  const h = bare(t);
  const line = card(h, credit(['Joseph / Narrator', 'Narrator'], [])).querySelector('.jellyseerr-role > bdi');
  assert.equal(line.textContent, 'as Joseph / Narrator, Narrator');
  assert.deepEqual(JSON.parse(line.dataset.parts), ['Joseph', 'Narrator']);
  assert.equal(line.dataset.as, 'as {role}');
});

test('a line that fits stays whole; the jobs a Role filter asks for lead their line', t => {
  const h = bare(t, '<div class="jellyseerr-discovery-section"><div class="itemsContainer"></div></div>');
  const section = h.document.querySelector('.jellyseerr-discovery-section');
  const element = card(h, credit(['Joseph'], [['Director', 'Directing'], ['Writer', 'Writing']]));
  section.firstElementChild.appendChild(element);
  h.JE.discoveryRoles.fitRoleLines(section);
  const [parts, jobs] = element.querySelectorAll('.jellyseerr-role > bdi');
  assert.equal(parts.textContent, 'as Joseph');
  assert.equal(jobs.textContent, 'Director, Writer');
  section.setAttribute(h.JE.discoveryRoles.ROLE_ASKED, 'Writing');
  h.JE.discoveryRoles.fitRoleLines(section);
  assert.equal(jobs.textContent, 'Writer, Director');
  // Nothing asked any more: Seerr's order again.
  section.setAttribute(h.JE.discoveryRoles.ROLE_ASKED, '');
  h.JE.discoveryRoles.fitRoleLines(section);
  assert.equal(jobs.textContent, 'Director, Writer');
  // No section: nothing to do.
  h.JE.discoveryRoles.fitRoleLines(null);
});

test('a line that does not fit loses whole jobs from its end and says how many; one part too long loses its brackets, then whole words', t => {
  const h = bare(t, '<div class="jellyseerr-discovery-section"><div class="itemsContainer"></div></div>');
  const section = h.document.querySelector('.jellyseerr-discovery-section');
  const list = section.firstElementChild;
  const jobsCard = card(h, credit([], [['Director', 'Directing'], ['Writer', 'Writing'], ['Producer', 'Production']]));
  const partCard = card(h, credit(['Professor Marmalade Junior (voice)', 'Baker'], []));
  list.append(jobsCard, partCard);
  const jobs = narrow(jobsCard.querySelector('.jellyseerr-role > bdi'), 'Director, Writer +1'.length);
  const part = narrow(partCard.querySelector('.jellyseerr-role > bdi'), 'as Professor Marmalade… +1'.length);
  h.JE.discoveryRoles.fitRoleLines(section);
  assert.equal(jobs.textContent, 'Director, Writer +1');
  assert.equal(part.textContent, 'as Professor Marmalade… +1');
  // The card's tooltip keeps them all.
  assert.equal(jobsCard.querySelector('.jellyseerr-role').title, 'Director, Writer, Producer');
  // Wider again: whole.
  narrow(jobs, 80);
  h.JE.discoveryRoles.fitRoleLines(section);
  assert.equal(jobs.textContent, 'Director, Writer, Producer');
});

test('Jellyfin\'s own loading circle, in the markup its loading module draws', t => {
  const h = bare(t);
  const row = h.JE.discoveryBusy.circle('jellyseerr-menu-busy');
  assert.equal(row.className, 'jellyseerr-menu-busy');
  assert.equal(row.getAttribute('aria-hidden'), 'true');
  const spinner = row.firstElementChild;
  assert.equal(spinner.className, 'mdl-spinner mdlSpinnerActive');
  assert.equal(spinner.children.length, 4);
  assert.deepEqual([...spinner.children[2].children].map(clip => [clip.className, clip.firstElementChild.className]), [
    ['mdl-spinner__circle-clipper mdl-spinner__left', 'mdl-spinner__circle mdl-spinner__circleLeft'],
    ['mdl-spinner__circle-clipper mdl-spinner__right', 'mdl-spinner__circle mdl-spinner__circleRight']
  ]);
  assert.ok(h.document.getElementById('jellyseerr-discovery-busy-styles'), 'its stylesheet is in the page');
  assert.ok(h.document.getElementById('jellyseerr-discovery-roles-styles'), 'so is the role line\'s');
});

test('a list being rebuilt keeps its height and gets the circle once; released, it takes its own height; outside a section nothing happens', t => {
  const h = bare(t, '<div class="jellyseerr-discovery-section"><div class="jellyseerr-discovery-header"><button id="sort"></button></div>'
    + '<div class="itemsContainer"></div></div><div id="elsewhere"><button id="other"></button><div class="itemsContainer"></div></div>');
  const list = h.document.querySelector('.jellyseerr-discovery-section .itemsContainer');
  Object.defineProperty(list, 'offsetHeight', { configurable: true, get: () => 640 });
  h.JE.discoveryBusy.hold(h.document.querySelector('#sort'));
  assert.equal(list.style.minHeight, '640px');
  assert.equal(list.dataset.held, 'join');
  assert.ok(list.previousElementSibling.matches('.jellyseerr-busy'));
  h.JE.discoveryBusy.hold(h.document.querySelector('#sort'));
  assert.equal(h.document.querySelectorAll('.jellyseerr-busy').length, 1, 'one circle');
  h.JE.discoveryBusy.release(list);
  assert.equal(list.style.minHeight, '');
  assert.equal(list.dataset.held, undefined);
  // The Recommendations page shares the controls: there the hold does nothing.
  h.JE.discoveryBusy.hold(h.document.querySelector('#other'));
  assert.equal(h.document.querySelector('#elsewhere .itemsContainer').dataset.held, undefined);
  h.JE.discoveryBusy.release(null);
});

test('a list released under a held header starts again right under it', t => {
  const h = bare(t, '<div class="jellyseerr-discovery-section"><div class="jellyseerr-discovery-header" data-stuck><button id="sort"></button></div>'
    + '<div class="itemsContainer"></div></div>');
  const section = h.document.querySelector('.jellyseerr-discovery-section');
  const header = section.firstElementChild;
  const list = section.querySelector('.itemsContainer');
  section.style.setProperty('--jellyseerr-sticky-top', '56px');
  header.style.setProperty('--jellyseerr-header-tuck', '10px');
  section.getBoundingClientRect = () => ({ top: 300 });
  const scrolled = [];
  h.window.scrollTo = options => scrolled.push(options.top);
  assert.equal(h.JE.discoveryBusy.heldAt(section, header), 300 + h.window.scrollY - 56 + 10 + 2);
  h.JE.discoveryBusy.hold(h.document.querySelector('#sort'));
  assert.equal(list.dataset.held, 'stuck');
  h.JE.discoveryBusy.release(list);
  assert.deepEqual(scrolled, [256]);
});

test('a new order keeps the old cards, dimmed and out of reach, with the circle, until its first page lands', async t => {
  const page = deferred();
  const h = setup(t, { hash: '#/list?genreId=g1', routes: [
    [`${API}/genre/g1`, { id: 'g1', name: 'Comedy', type: 'Genre' }], COMEDY, COMEDY_MOVIES,
    [`${API}/jellyseerr/discover/tv/genre/35?page=1`, feed([1, 2], 'tv')],
    [`${API}/jellyseerr/discover/movies/genre/36?page=1`, feed([11, 12], 'movie')],
    [`${API}/jellyseerr/discover/tv/genre/35?page=1&sortBy=first_air_date.desc`, page.promise.then(() => feed([3, 4], 'tv'))],
    [`${API}/jellyseerr/discover/movies/genre/36?page=1&sortBy=release_date.desc`, page.promise.then(() => feed([13, 14], 'movie'))]
  ] });
  h.load('jellyseerr/discovery/genre-discovery.js');
  await until(() => ids(h.section('genre') ?? h.document.createElement('div')).length === 4, 'first page');
  const section = h.section('genre');
  const list = section.querySelector('.itemsContainer');
  const before = ids(section);
  section.querySelector('.jellyseerr-sort-btn').click();
  h.document.querySelector('.jellyseerr-sort-menu .actionSheetMenuItem[data-id="release_date.desc"]').click();
  await until(() => h.calls.some(call => call.path.includes('sortBy=release_date.desc')), 'the new order asked for');
  assert.equal(list.getAttribute('aria-busy'), 'true');
  assert.equal(list.inert, true);
  assert.deepEqual(ids(section), before, 'the old cards stay until the new ones are in');
  assert.ok(section.querySelector('.jellyseerr-busy'), 'the circle is there for the stylesheet to show');
  page.resolve();
  await until(() => list.getAttribute('aria-busy') === null, 'the new order landed');
  assert.equal(list.inert, false);
  assert.deepEqual(ids(section).sort((a, b) => a - b), [3, 4, 13, 14]);
});
