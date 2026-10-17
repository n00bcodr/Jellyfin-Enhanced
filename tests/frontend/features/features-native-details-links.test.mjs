import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, jsonResponse } from '../helpers/harness.mjs';

// Where the names on a native page of a title that isn't in the library lead: a person's own page
// (JE's person discovery row is its filmography) and the discovery pages of genres, studios and
// networks the viewer's library doesn't offer (the genre/network discovery rows are their content).

const SERVER = '0202511b0eac4284ab045b3ba556d72e';
const PERSON = '4a45ad1500000ee200000000f845f0a8'; // Javier Bardem (TMDB 3810), the server's vector
const LIBRARY_ID = '0123456789abcdef0123456789abcdef';

/**
 * One discovery module with JE's codec loaded and the discovery base replaced by a recorder, so the
 * module's spec (its resolution of the page) is tested on its own.
 * @param {object} t Test context.
 * @param {string} file Module file under jellyseerr/discovery.
 * @param {object} options Fixtures.
 * @returns {object} Harness, spec and the requests made.
 */
function moduleSpec(t, file, { responses = {}, item, genres = { movie: [], tv: [] }, config = {} } = {}) {
  const requests = [];
  const genreReads = [];
  const items = [];
  let spec = null;
  const h = createHarness({
    JE: {
      pluginConfig: { NativeAbsentDetails: { Enabled: true, ContractVersion: 1 }, ...config },
      t: (key, params) => (params ? `${key}:${JSON.stringify(params)}` : key),
      jellyseerrAPI: { checkUserStatus: async () => ({ active: true }) },
      helpers: { getItemCached: async id => { items.push(id); return item; } },
      discoveryFilter: {
        createSessionCache: () => { const map = new Map(); return { scope: () => map }; },
        fetchWithManagedRequest: async path => { requests.push(path); const answer = responses[path.replace(/\?.*$/, '')]; return typeof answer === 'function' ? answer(path) : answer ?? null; },
        fetchTmdbGenreList: async (type, options = {}) => { genreReads.push(`${type}${options.native ? ':native' : ''}`); return genres[type]; },
        useNativeFeeds: status => !!status?.active && status.userFound === false,
      },
      discoveryBase: {
        createDiscovery: s => { spec = s; return { start: () => {} }; },
        idFromDetailUrl: () => null,
        idFromListParam: () => () => null,
      },
    },
    apiClient: { serverId: () => SERVER, getItem: async (user, id) => { items.push(id); return item; } },
  });
  t.after(() => h.close());
  h.load('jellyseerr/nativedetails/native-details.js');
  h.load(`jellyseerr/discovery/${file}`);
  const signal = new h.window.AbortController().signal;
  return { ...h, spec, requests, genreReads, items, signal };
}

const FILMOGRAPHY = '/JellyfinEnhanced/native-details/person/3810/filmography';

test('a person page of someone the library lacks: the row is their filmography from the server, whatever the switch says, best known first', async t => {
  // The server's filmography: filtered for the viewer there (library copies they can open carry their id).
  const results = [
    { id: 1, mediaType: 'tv', name: 'A Talk Show', genreIds: [10767], voteCount: 9000, character: 'Self' },
    { id: 2, mediaType: 'movie', title: 'Small Film', voteCount: 10, character: 'Lead' },
    { id: 3, mediaType: 'movie', title: 'No Country for Old Men', voteCount: 5000, character: 'Anton', mediaInfo: { status: 5, jellyfinMediaId: LIBRARY_ID } },
    { id: 4, mediaType: 'movie', title: 'Premiere Guest', voteCount: 8000, character: 'Himself' },
    { id: 5, mediaType: 'movie', title: 'Produced', voteCount: 700, job: 'Producer' },
  ];
  const h = moduleSpec(t, 'person-discovery.js', {
    item: { Id: PERSON, Type: 'Person', Name: 'Javier Bardem' },
    responses: { [FILMOGRAPHY]: { results } },
    config: { JellyseerrShowPersonDiscovery: false },
  });
  // Rendered on that page even with person discovery off, library titles kept; a library person's page follows the switches.
  assert.equal(h.spec.enabledFor(PERSON), true);
  assert.equal(h.spec.keepLibraryItems(PERSON), true);
  assert.equal(h.spec.enabledFor(LIBRARY_ID), false);
  assert.equal(h.spec.keepLibraryItems(LIBRARY_ID), false);
  assert.equal(h.spec.keepListOrder(PERSON), true);
  assert.equal(h.spec.keepListOrder(LIBRARY_ID), false);
  assert.equal(h.spec.enabledFor(h.JE.titleDetails.syntheticId('movie', 3810)), false);
  const result = await h.spec.resolveItems({ id: PERSON, signal: h.signal });
  assert.equal(result.title, 'native_details_filmography');
  assert.deepEqual(Array.from(result.items, i => i.id), [3, 5, 2, 1, 4]);
  // Name from the page's own item, TMDB id from the page id: neither JE's library person route nor the
  // per-user Seerr proxy (which needs a linked Seerr account) is asked.
  assert.deepEqual(h.requests, [FILMOGRAPHY]);
});

test('a filmography needs no Seerr account, and one the server refuses is no section rather than a retry', async t => {
  // Jellyfin Enhanced request mode, a viewer without a Seerr account: Seerr is reachable, the user isn't found.
  const unlinked = moduleSpec(t, 'person-discovery.js', {
    item: { Id: PERSON, Type: 'Person', Name: 'Javier Bardem' },
    responses: {
      [FILMOGRAPHY]: { results: [{ id: 3, mediaType: 'movie', title: 'No Country for Old Men', voteCount: 5000 }] },
      '/JellyfinEnhanced/jellyseerr/person/3810/combined_credits': () => { throw Object.assign(new Error('HTTP 404'), { status: 404 }); },
    },
  });
  unlinked.JE.jellyseerrAPI.checkUserStatus = async () => ({ active: true, userFound: false });
  const shown = await unlinked.spec.resolveItems({ id: PERSON, signal: unlinked.signal });
  assert.deepEqual(Array.from(shown.items, i => i.id), [3]);
  assert.deepEqual(unlinked.requests, [FILMOGRAPHY]);

  const refused = moduleSpec(t, 'person-discovery.js', {
    item: { Id: PERSON, Type: 'Person', Name: 'Javier Bardem' },
    responses: { [FILMOGRAPHY]: () => { throw Object.assign(new Error('HTTP 404'), { status: 404 }); } },
  });
  assert.equal(await refused.spec.resolveItems({ id: PERSON, signal: refused.signal }), null);
  // An outage is still a failure the discovery base offers a retry for.
  const down = moduleSpec(t, 'person-discovery.js', {
    item: { Id: PERSON, Type: 'Person', Name: 'Javier Bardem' },
    responses: { [FILMOGRAPHY]: () => { throw Object.assign(new Error('HTTP 503'), { status: 503 }); } },
  });
  await assert.rejects(down.spec.resolveItems({ id: PERSON, signal: down.signal }), /HTTP 503/);
});

/**
 * The real discovery base and card filter on a synthetic person page, with the server answering
 * `results` for the filmography and every card showing its title id.
 * @param {object} t Test context.
 * @param {Array<object>} results The server's filmography.
 * @returns {object} Harness, the person page's controller, the card filter, the requests made and
 *   `cleanUp(fn)` (run before the window closes).
 */
function realPersonPage(t, results) {
  const requests = [];
  const cleanups = [];
  const h = createHarness({
    html: '<main id="detail"></main>',
    url: `http://jellyfin.test/web/index.html#/details?id=${PERSON}`,
    JE: {
      pluginConfig: { NativeAbsentDetails: { Enabled: true, ContractVersion: 1 }, JellyseerrExcludeLibraryItems: true, JellyseerrExcludeBlocklistedItems: true },
      t: key => key,
      jellyseerrAPI: { checkUserStatus: async () => ({ active: true, userFound: false }) },
      helpers: { getItemCached: async id => ({ Id: id, Type: 'Person', Name: 'Javier Bardem' }) },
    },
    apiClient: { serverId: () => SERVER },
  });
  t.after(() => { cleanups.reverse().forEach(fn => fn()); h.close(); });
  h.JE.jellyseerrUI = { createJellyseerrCard: item => Object.assign(h.document.createElement('div'), { className: 'card', textContent: String(item.id) }) };
  h.load('jellyseerr/seerr-status.js');
  h.load('jellyseerr/nativedetails/native-details.js');
  h.load('jellyseerr/discovery/discovery-filter-utils.js');
  const filter = h.JE.discoveryFilter;
  filter.waitForPageReady = async () => h.document.querySelector('#detail');
  filter.setupInfiniteScroll = () => {};
  filter.cleanupScrollObserver = () => {};
  filter.fetchWithManagedRequest = async path => { requests.push(path); return path === FILMOGRAPHY ? { results } : null; };
  h.load('jellyseerr/discovery/discovery-base.js');
  const create = h.JE.discoveryBase.createDiscovery;
  let controller = null;
  h.JE.discoveryBase.createDiscovery = spec => { controller = create(spec); return { ...controller, start: () => {} }; };
  h.load('jellyseerr/discovery/person-discovery.js');
  cleanups.push(() => controller.cleanup());
  const cards = selector => Array.from(h.document.querySelectorAll(`${selector} .card`), c => c.textContent);
  return { ...h, controller, filter, requests, create, cards, cleanUp: fn => cleanups.push(fn) };
}

test('with library titles excluded (the default), a filmography of someone the library lacks still shows its library titles, through the real discovery base and card filter', async t => {
  // 45 library titles (best known) ahead of one absent title: one page of 40 would be all library cards.
  const results = Array.from({ length: 45 }, (_, i) => ({
    id: i + 1, mediaType: 'movie', title: `In the library ${i + 1}`, voteCount: 1000 - i,
    mediaInfo: { status: 5, jellyfinMediaId: String(i + 1).padStart(32, '0') },
  }));
  results.push({ id: 999, mediaType: 'movie', title: 'Not in the library', voteCount: 1 });
  const h = realPersonPage(t, results);
  await h.controller.render();
  const cards = h.cards('.jellyseerr-person-discovery-section');
  assert.equal(cards.length, 40, 'the first page is all there, library cards included');
  assert.deepEqual(cards.slice(0, 3), ['1', '2', '3']);
  assert.deepEqual(h.requests, [FILMOGRAPHY]);
  // Every other discovery row keeps the setting: library titles out, the absent one in.
  assert.equal(h.filter.createCardsFragment(results, { cardClass: 'portraitCard' }).childNodes.length, 1);
  assert.equal(h.filter.createCardsFragment(results, { cardClass: 'portraitCard', keepLibraryItems: true }).childNodes.length, 46);
});

test('a person row (no side padding of its own) keeps its header, and the Sort select, inside the page\'s right padding', async t => {
  const h = realPersonPage(t, [{ id: 1, mediaType: 'movie', title: 'One', voteCount: 10 }]);
  await h.controller.render();
  const header = h.document.querySelector('.jellyseerr-person-discovery-section .jellyseerr-discovery-header');
  assert.ok(header.classList.contains('padded-right'), 'the same right edge as its cards');
  assert.equal(header.style.boxSizing, 'border-box', 'width 100% includes the padding, so the header does not run past the screen');
});

test('a filmography of movies and series keeps its order (roles first, best known first) under "All", through the real discovery base; Movies and Series still filter, and other rows still alternate', async t => {
  const results = [
    { id: 1, mediaType: 'tv', name: 'A Talk Show', genreIds: [10767], voteCount: 5, character: 'Self' },
    { id: 2, mediaType: 'movie', title: 'Famous Film', voteCount: 5000, character: 'Lead' },
    { id: 3, mediaType: 'movie', title: 'Another Role', voteCount: 1000, character: 'Villain' },
    { id: 4, mediaType: 'tv', name: 'A Drama', voteCount: 300, character: 'Detective' },
  ];
  const h = realPersonPage(t, results);
  await h.controller.render();
  const section = '.jellyseerr-person-discovery-section';
  assert.deepEqual(h.cards(section), ['2', '3', '4', '1']);
  const click = mode => h.document.querySelector(`${section} .jellyseerr-filter-btn[data-mode="${mode}"]`).click();
  click(h.filter.MODES.MOVIES);
  assert.deepEqual(h.cards(section), ['2', '3']);
  click(h.filter.MODES.TV);
  assert.deepEqual(h.cards(section), ['4', '1']);
  click(h.filter.MODES.MIXED);
  assert.deepEqual(h.cards(section), ['2', '3', '4', '1']);

  // A client-paged row without the option (a library person's "More with") still alternates, series first.
  const other = h.create({
    key: 'collection', mode: 'client-paged', logLabel: 'Other', configKey: 'Unused',
    getIdFromUrl: () => 'other', resolveItems: async () => ({ items: results, title: 'Other' }),
  });
  h.cleanUp(() => other.cleanup());
  await other.render();
  assert.deepEqual(h.cards('.jellyseerr-collection-discovery-section'), ['1', '2', '4', '3']);
});

test('a library person keeps JE\'s person lookup and its "More with" row', async t => {
  const h = moduleSpec(t, 'person-discovery.js', {
    item: { Id: LIBRARY_ID, Type: 'Person', Name: 'Timothée Chalamet' },
    responses: {
      [`/JellyfinEnhanced/person/${LIBRARY_ID}`]: { name: 'Timothée Chalamet', tmdbId: '1190668' },
      '/JellyfinEnhanced/jellyseerr/person/1190668/combined_credits': { cast: [{ id: 9, mediaType: 'movie', voteCount: 1 }, { id: 8, mediaType: 'movie', voteCount: 99 }], crew: [] },
    },
  });
  const result = await h.spec.resolveItems({ id: LIBRARY_ID, signal: h.signal });
  assert.equal(result.title, 'discovery_more_from_person:{"person":"Timothée Chalamet"}');
  assert.deepEqual(Array.from(result.items, i => i.id), [9, 8], 'the API order, as before');
  assert.deepEqual(h.requests, [`/JellyfinEnhanced/person/${LIBRARY_ID}`, '/JellyfinEnhanced/jellyseerr/person/1190668/combined_credits']);
});

test('a genre the library lacks: its page id names the TMDB genre; the name fills the other media type', async t => {
  const genres = {
    movie: [{ id: 878, name: 'Science Fiction' }, { id: 14, name: 'Fantasy' }],
    tv: [{ id: 10765, name: 'Sci-Fi & Fantasy' }, { id: 18, name: 'Drama' }],
  };
  const h = moduleSpec(t, 'genre-discovery.js', { item: { Name: 'Sci-Fi & Fantasy' }, genres });
  const id = h.JE.titleDetails.syntheticId('genre', 10765);
  const feeds = await h.spec.resolveFeeds({ id, signal: h.signal });
  assert.deepEqual({ tvId: feeds.tvId, movieId: feeds.movieId }, { tvId: 10765, movieId: 14 });
  // Its feeds are the server's, filtered there for the viewer (not the per-user Seerr proxy).
  assert.equal(h.spec.buildDiscoverPath('tv', feeds.tvId, feeds), '/JellyfinEnhanced/native-details/discover/tv/genre/10765');
  assert.equal(h.spec.buildDiscoverPath('movie', feeds.movieId, feeds), '/JellyfinEnhanced/native-details/discover/movie/genre/14');
  assert.equal(feeds.title, 'discovery_more_with_genre:{"genre":"Sci-Fi & Fantasy"}');
  // The name comes from the page's item; JE's library genre route isn't asked.
  assert.deepEqual(h.requests, []);
  assert.deepEqual(h.items, [id]);
  // Its row is the page's only list: library titles stay, whatever "exclude library items" says.
  assert.equal(h.spec.keepLibraryItems(id), true);
  assert.equal(h.spec.keepLibraryItems(LIBRARY_ID), false);
  // A movie-only genre id: the movie feed is that id.
  const h2 = moduleSpec(t, 'genre-discovery.js', { item: { Name: 'Science Fiction' }, genres });
  const sciFi = await h2.spec.resolveFeeds({ id: h2.JE.titleDetails.syntheticId('genre', 878), signal: h2.signal });
  assert.equal(sciFi.movieId, 878);
  // TMDB's genre lists can't be read: both feeds by that id (the server answers an empty feed for the other type).
  const h3 = moduleSpec(t, 'genre-discovery.js', { item: { Name: 'Science Fiction' }, genres: { movie: null, tv: null } });
  const unknown = await h3.spec.resolveFeeds({ id: h3.JE.titleDetails.syntheticId('genre', 878), signal: h3.signal });
  assert.deepEqual({ tvId: unknown.tvId, movieId: unknown.movieId, native: unknown.native }, { tvId: 878, movieId: 878, native: true });
});

test('a library genre keeps JE\'s genre lookup', async t => {
  const h = moduleSpec(t, 'genre-discovery.js', {
    responses: { [`/JellyfinEnhanced/genre/${LIBRARY_ID}`]: { name: 'Drama' } },
    genres: { movie: [{ id: 18, name: 'Drama' }], tv: [{ id: 18, name: 'Drama' }] },
  });
  const feeds = await h.spec.resolveFeeds({ id: LIBRARY_ID, signal: h.signal });
  assert.deepEqual({ tvId: feeds.tvId, movieId: feeds.movieId }, { tvId: 18, movieId: 18 });
  assert.equal(h.spec.buildDiscoverPath('tv', 18, feeds), '/JellyfinEnhanced/jellyseerr/discover/tv/genre/18');
  assert.equal(h.spec.buildDiscoverPath('movie', 18, feeds), '/JellyfinEnhanced/jellyseerr/discover/movies/genre/18');
  assert.deepEqual(h.requests, [`/JellyfinEnhanced/genre/${LIBRARY_ID}`]);
  assert.deepEqual(h.items, []);
});

test('a network or studio the library lacks: its page id names the TMDB network or company', async t => {
  const network = moduleSpec(t, 'network-discovery.js', {
    item: { Name: 'Disney+' },
    responses: { '/JellyfinEnhanced/tmdb/search/company': { results: [{ id: 3166, name: 'Disney' }] } },
  });
  const disney = await network.spec.resolveFeeds({ id: network.JE.titleDetails.syntheticId('network', 2739), signal: network.signal });
  // The network feed is the id itself; no movie company for a "+" brand without an exact match.
  assert.deepEqual({ tvId: disney.tvId, movieId: disney.movieId, tvSource: disney.tvSource }, { tvId: 2739, movieId: null, tvSource: 'network' });
  assert.equal(network.requests.some(p => p.startsWith('/JellyfinEnhanced/studio/')), false);
  assert.equal(network.spec.buildDiscoverPath('tv', 2739, disney), '/JellyfinEnhanced/native-details/discover/tv/network/2739');

  const studio = moduleSpec(t, 'network-discovery.js', { item: { Name: 'Tiny Co' }, config: { TmdbEnabled: true } });
  const tiny = await studio.spec.resolveFeeds({ id: studio.JE.titleDetails.syntheticId('studio', 99), signal: studio.signal });
  // A company: its movies, and (with JE's TMDB key) its series by company.
  assert.deepEqual({ tvId: tiny.tvId, movieId: tiny.movieId, tvSource: tiny.tvSource }, { tvId: 99, movieId: 99, tvSource: 'company' });
  assert.equal(tiny.title, 'discovery_more_from_studio:{"studio":"Tiny Co"}');
  assert.deepEqual(studio.requests, [], 'no company search: the id is known');
  assert.equal(studio.spec.buildDiscoverPath('movie', 99, tiny), '/JellyfinEnhanced/native-details/discover/movie/studio/99');
  assert.equal(studio.spec.buildDiscoverPath('tv', 99, tiny), '/JellyfinEnhanced/native-details/discover/tv/company/99');
  // A synthetic studio's or network's row is its page's only list: library titles stay.
  assert.equal(studio.spec.keepLibraryItems(studio.JE.titleDetails.syntheticId('studio', 99)), true);
  assert.equal(network.spec.keepLibraryItems(network.JE.titleDetails.syntheticId('network', 2739)), true);
  assert.equal(studio.spec.keepLibraryItems(LIBRARY_ID), false);
  // A library studio keeps the per-user Seerr feeds, as before.
  const library = { tvId: 99, movieId: 99, tvSource: 'company' };
  assert.equal(studio.spec.buildDiscoverPath('movie', 99, library), '/JellyfinEnhanced/jellyseerr/discover/movies/studio/99');
  assert.equal(studio.spec.buildDiscoverPath('tv', 99, library), '/JellyfinEnhanced/jellyseerr/discover/tv/studio/99');
});

test('the discovery base renders on a page its spec enables even with the switch off; other pages follow the switch', async t => {
  const h = createHarness({ html: '<main id="detail"></main>', JE: { pluginConfig: { JellyseerrShowPersonDiscovery: false } } });
  t.after(() => h.close());
  h.JE.jellyseerrUI = { createJellyseerrCard: item => Object.assign(h.document.createElement('div'), { className: 'card', textContent: String(item.id) }) };
  h.load('jellyseerr/seerr-status.js');
  h.load('jellyseerr/discovery/discovery-filter-utils.js');
  h.JE.discoveryFilter.waitForPageReady = async () => h.document.querySelector('#detail');
  h.JE.discoveryFilter.setupInfiniteScroll = () => {};
  h.JE.discoveryFilter.cleanupScrollObserver = () => {};
  h.load('jellyseerr/discovery/discovery-base.js');
  let page = 'own-page';
  const asked = [];
  const controller = h.JE.discoveryBase.createDiscovery({
    key: 'person', mode: 'client-paged', logLabel: 'Person Discovery', configKey: 'JellyseerrShowPersonDiscovery',
    getIdFromUrl: () => page,
    enabledFor: id => id === 'own-page',
    resolveItems: async ({ id }) => { asked.push(id); return { title: 'Filmography', items: [{ id: 1, mediaType: 'movie' }] }; },
  });
  try {
    await controller.render();
    assert.deepEqual(asked, ['own-page']);
    assert.equal(h.document.querySelectorAll('.card').length, 1);
    controller.cleanup();
    page = 'library-person';
    await controller.render();
    assert.deepEqual(asked, ['own-page'], 'the switch still governs every other page');
  } finally {
    controller.cleanup();
  }
});

// Library pages' discovery rows for a viewer without a Seerr account (Jellyfin Enhanced request mode):
// the server's native feeds, filtered there for the viewer, instead of Seerr as the viewer (which
// refuses them). Viewers with an account keep Seerr's own answers.
const LIB_PERSON = '29c5c1c5e8aec2ff7ab3f8d9d8c69c26';
const UNLINKED = { active: true, userFound: false, reason: 'unlinked' };
const LINKED = { active: true, userFound: true };

test('a library person row for a viewer without a Seerr account is their server-filtered filmography', async t => {
  const film = '/JellyfinEnhanced/native-details/person/52139/filmography';
  const proxy = '/JellyfinEnhanced/jellyseerr/person/52139/combined_credits';
  const fixtures = {
    item: { Id: LIB_PERSON, Type: 'Person', Name: 'Seth MacFarlane' },
    responses: {
      [`/JellyfinEnhanced/person/${LIB_PERSON}`]: { name: 'Seth MacFarlane', tmdbId: '52139' },
      [film]: { results: [{ id: 1, mediaType: 'movie', title: 'Ted' }, { id: 2, mediaType: 'tv', name: 'The Orville' }] },
      [proxy]: { cast: [{ id: 9, mediaType: 'movie', title: 'From Seerr' }], crew: [] },
    },
  };
  const unlinked = moduleSpec(t, 'person-discovery.js', fixtures);
  unlinked.JE.jellyseerrAPI.checkUserStatus = async () => UNLINKED;
  const row = await unlinked.spec.resolveItems({ id: LIB_PERSON, signal: unlinked.signal });
  assert.deepEqual(Array.from(row.items, i => i.id), [1, 2]);
  assert.equal(row.title, 'discovery_more_from_person:{"person":"Seth MacFarlane"}');
  assert.ok(unlinked.requests.includes(film));
  assert.ok(!unlinked.requests.includes(proxy));
  // The library row keeps the exclude-library-items setting (only a synthetic person's page keeps them).
  assert.equal(unlinked.spec.keepLibraryItems(LIB_PERSON), false);

  const linked = moduleSpec(t, 'person-discovery.js', fixtures);
  linked.JE.jellyseerrAPI.checkUserStatus = async () => LINKED;
  assert.deepEqual(Array.from((await linked.spec.resolveItems({ id: LIB_PERSON, signal: linked.signal })).items, i => i.id), [9]);
  assert.ok(!linked.requests.includes(film));

  // Without native details pages there is nothing to read for them: no row, and Seerr isn't asked.
  const off = moduleSpec(t, 'person-discovery.js', { ...fixtures, config: { NativeAbsentDetails: { Enabled: false, ContractVersion: 1 } } });
  off.JE.jellyseerrAPI.checkUserStatus = async () => UNLINKED;
  off.JE.discoveryFilter.useNativeFeeds = status => !!status?.active && status.userFound === false && !!off.JE.titleDetails?.available?.();
  assert.equal(await off.spec.resolveItems({ id: LIB_PERSON, signal: off.signal }), null);
  assert.ok(!off.requests.includes(proxy) && !off.requests.includes(film));
});

test('library genre, studio and tag rows read the native feeds for a viewer without a Seerr account', async t => {
  const GENRE = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const STUDIO = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const genres = { movie: [{ id: 16, name: 'Animation' }], tv: [{ id: 16, name: 'Animation' }] };
  const genreFixtures = { genres, responses: { [`/JellyfinEnhanced/genre/${GENRE}`]: { name: 'Animation' } } };
  for (const [status, native] of [[UNLINKED, true], [LINKED, false]]) {
    const g = moduleSpec(t, 'genre-discovery.js', genreFixtures);
    g.JE.jellyseerrAPI.checkUserStatus = async () => status;
    const feeds = await g.spec.resolveFeeds({ id: GENRE, signal: g.signal });
    assert.equal(feeds.native, native);
    assert.ok(g.genreReads.includes(native ? 'tv:native' : 'tv'));
    assert.equal(g.spec.buildDiscoverPath('tv', 16, feeds), native ? '/JellyfinEnhanced/native-details/discover/tv/genre/16' : '/JellyfinEnhanced/jellyseerr/discover/tv/genre/16');
    assert.equal(g.spec.buildDiscoverPath('movie', 16, feeds), native ? '/JellyfinEnhanced/native-details/discover/movie/genre/16' : '/JellyfinEnhanced/jellyseerr/discover/movies/genre/16');

    const n = moduleSpec(t, 'network-discovery.js', { responses: { [`/JellyfinEnhanced/studio/${STUDIO}`]: { name: '20th Century Fox', tmdbId: '25' } } });
    n.JE.jellyseerrAPI.checkUserStatus = async () => status;
    const studio = await n.spec.resolveFeeds({ id: STUDIO, signal: n.signal });
    assert.equal(studio.native, native);
    assert.equal(n.spec.buildDiscoverPath('tv', studio.tvId, studio), native ? '/JellyfinEnhanced/native-details/discover/tv/network/19' : '/JellyfinEnhanced/jellyseerr/discover/tv/network/19');
    assert.equal(n.spec.buildDiscoverPath('movie', 25, studio), native ? '/JellyfinEnhanced/native-details/discover/movie/studio/25' : '/JellyfinEnhanced/jellyseerr/discover/movies/studio/25');

    const keywords = native ? '/JellyfinEnhanced/native-details/keywords' : '/JellyfinEnhanced/tmdb/search/keyword';
    const tag = moduleSpec(t, 'tag-discovery.js', { responses: { [keywords]: { results: [{ id: 161919, name: 'adult animation' }] } } });
    tag.JE.jellyseerrAPI.checkUserStatus = async () => status;
    const tagFeeds = await tag.spec.resolveFeeds({ id: 'adult animation', signal: tag.signal });
    assert.equal(tagFeeds.movieId, 161919);
    assert.deepEqual(tag.requests, [`${keywords}?query=adult%20animation`]);
    assert.equal(tag.spec.buildDiscoverPath('tv', 161919, tagFeeds), native ? '/JellyfinEnhanced/native-details/discover/tv/keyword/161919' : '/JellyfinEnhanced/jellyseerr/discover/tv/keyword/161919');
  }
});

test('the native-feeds choice: no Seerr account, Seerr reachable, Jellyfin Enhanced request mode, native details on', t => {
  let jeMode = true;
  const h = createHarness({
    JE: { pluginConfig: { NativeAbsentDetails: { Enabled: true, ContractVersion: 1 } }, t: key => key, internals: { arrAskSeerr: { jeMode: () => jeMode } } },
    apiClient: { serverId: () => SERVER },
  });
  t.after(() => h.close());
  h.load('jellyseerr/seerr-status.js');
  h.load('jellyseerr/nativedetails/native-details.js');
  h.load('jellyseerr/discovery/discovery-filter-utils.js');
  const use = h.JE.discoveryFilter.useNativeFeeds;
  assert.equal(use(UNLINKED), true);
  assert.equal(use(LINKED), false);
  assert.equal(use({ active: false, userFound: false }), false);   // Seerr unreachable: not a reason to switch
  // Seerr handles requests: the server refuses its feeds to a viewer without a Seerr account (no rows, no 404s).
  jeMode = false;
  assert.equal(use(UNLINKED), false);
  jeMode = true;
  h.JE.pluginConfig.NativeAbsentDetails.Enabled = false;
  assert.equal(use(UNLINKED), false);
});

test('the native feeds are read again each time (filtered for the viewer\'s policy now); Seerr\'s rows keep the tab cache', async t => {
  const calls = [];
  const h = createHarness({
    JE: { pluginConfig: { NativeAbsentDetails: { Enabled: true, ContractVersion: 1 } }, t: key => key },
    apiClient: { serverId: () => SERVER },
    fetch: async url => { calls.push(String(url)); return jsonResponse({ results: [{ id: calls.length }] }); },
  });
  t.after(() => h.close());
  for (const name of ['navigation', 'session', 'api-client']) h.load(`core/${name}.js`);
  h.JE.requestManager = h.JE.core.api.manager;
  h.load('jellyseerr/discovery/discovery-filter-utils.js');
  const get = path => h.JE.discoveryFilter.fetchWithManagedRequest(path, 'genre');
  const native = '/JellyfinEnhanced/native-details/discover/tv/genre/16?page=1';
  const proxy = '/JellyfinEnhanced/jellyseerr/discover/tv/genre/16?page=1';
  await get(native); await get(native);
  await get(proxy); await get(proxy);
  assert.equal(calls.filter(u => u.includes('native-details')).length, 2);
  assert.equal(calls.filter(u => u.includes('/jellyseerr/')).length, 1);
});

test('library rows count a title held only in 4K as in the library: left out when library titles are excluded, else its card opens the 4K copy', async t => {
  const fourK = { id: 1, mediaType: 'movie', title: 'Arrival', mediaInfo: { status: 1, status4k: 5, jellyfinMediaId4k: 'uhd-1' } };
  const coming = { id: 2, mediaType: 'movie', title: 'Coming', mediaInfo: { status: 1, status4k: 3, jellyfinMediaId4k: 'uhd-2' } };
  const plain = { id: 3, mediaType: 'movie', title: 'Plain' };
  for (const exclude of [true, false]) {
    const h = createHarness({ html: '<main></main>', JE: { pluginConfig: { JellyseerrExcludeLibraryItems: exclude } } });
    t.after(() => h.close());
    h.JE.jellyseerrUI = { createJellyseerrCard: item => {
      const card = h.document.createElement('div');
      card.className = 'card';
      card.dataset.id = String(item.id);
      card.innerHTML = '<div class="cardText-first"><a href="#">x</a></div>';
      return card;
    } };
    h.load('jellyseerr/seerr-status.js');
    h.load('jellyseerr/discovery/discovery-filter-utils.js');
    const cards = [...h.JE.discoveryFilter.createCardsFragment([fourK, coming, plain]).children];
    if (exclude) {
      assert.deepEqual(cards.map(c => c.dataset.id), ['2', '3']);
      continue;
    }
    assert.deepEqual(cards.map(c => c.dataset.id), ['1', '2', '3']);
    assert.equal(cards[0].getAttribute('data-jellyfin-media-id'), 'uhd-1');
    assert.equal(cards[0].querySelector('.cardText-first a').getAttribute('href'), '#!/details?id=uhd-1');
    assert.equal(cards[1].getAttribute('data-library-item'), null);
  }
});

test('a synthetic studio page keeps its library titles through the real dual-feed discovery base; a library studio still leaves them out', async t => {
  const pages = {
    1: [{ id: 329865, mediaType: 'movie', title: 'Arrival', mediaInfo: { status: 5, jellyfinMediaId: 'a'.repeat(32) } }, { id: 2, mediaType: 'movie', title: 'Not here' }],
    2: [{ id: 3, mediaType: 'movie', title: 'Also here', mediaInfo: { status: 5, jellyfinMediaId: 'b'.repeat(32) } }, { id: 4, mediaType: 'movie', title: 'Not here either' }],
  };
  for (const synthetic of [true, false]) {
    const requests = [];
    const h = createHarness({
      html: '<main id="detail"></main>',
      JE: {
        pluginConfig: { NativeAbsentDetails: { Enabled: true, ContractVersion: 1 }, JellyseerrShowNetworkDiscovery: true, JellyseerrExcludeLibraryItems: true },
        t: key => key,
        jellyseerrAPI: { checkUserStatus: async () => ({ active: true, userFound: true }) },
      },
      apiClient: { serverId: () => SERVER, getCurrentUserId: () => 'viewer', getItem: async () => ({ Name: 'Lava Bear Films' }) },
    });
    let controller = null;
    t.after(() => { controller?.cleanup(); h.close(); });
    h.JE.jellyseerrUI = { createJellyseerrCard: item => Object.assign(h.document.createElement('div'), { className: 'card', textContent: item.title }) };
    h.load('jellyseerr/seerr-status.js');
    h.load('jellyseerr/nativedetails/native-details.js');
    h.load('jellyseerr/discovery/discovery-filter-utils.js');
    const filter = h.JE.discoveryFilter;
    filter.waitForPageReady = async () => h.document.querySelector('#detail');
    let loadMore = null;
    filter.setupInfiniteScroll = (state, selector, more) => { loadMore = more; };
    filter.cleanupScrollObserver = () => {};
    filter.fetchWithManagedRequest = async path => {
      requests.push(path);
      if (path.startsWith('/JellyfinEnhanced/studio/')) return { name: 'Lava Bear Films', tmdbId: '32300' };
      const page = Number(new URL(path, 'http://x').searchParams.get('page') || 1);
      return /\/movies?\//.test(path) ? { page, totalPages: 2, results: pages[page] } : { page, totalPages: 1, results: [] };
    };
    h.load('jellyseerr/discovery/discovery-base.js');
    const create = h.JE.discoveryBase.createDiscovery;
    h.JE.discoveryBase.createDiscovery = spec => { controller = create(spec); return { ...controller, start: () => {} }; };
    h.load('jellyseerr/discovery/network-discovery.js');
    const id = synthetic ? h.JE.titleDetails.syntheticId('studio', 32300) : LIBRARY_ID;
    h.window.location.hash = `#/list?studioId=${id}&serverId=${SERVER}`;
    await controller.render();
    const titles = () => Array.from(h.document.querySelectorAll('.card'), c => c.textContent);
    assert.deepEqual(titles(), synthetic ? ['Arrival', 'Not here'] : ['Not here'], synthetic ? 'synthetic' : 'library');
    // The next page (infinite scroll) keeps the same rule.
    await loadMore();
    assert.deepEqual(titles(), synthetic ? ['Arrival', 'Not here', 'Also here', 'Not here either'] : ['Not here', 'Not here either'], synthetic ? 'synthetic, page 2' : 'library, page 2');
    assert.ok(requests.some(p => p.startsWith(synthetic ? '/JellyfinEnhanced/native-details/discover/movie/studio/32300' : '/JellyfinEnhanced/jellyseerr/discover/movies/studio/32300')), requests.join(' '));
  }
});
