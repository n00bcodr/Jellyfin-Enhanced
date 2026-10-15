import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from '../helpers/harness.mjs';

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
        fetchTmdbGenreList: async type => genres[type],
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
  return { ...h, spec, requests, items, signal };
}

test('a person page of someone the library lacks: the row is their filmography, whatever the switch says, best known first', async t => {
  const credits = {
    cast: [
      { id: 1, mediaType: 'tv', name: 'A Talk Show', genreIds: [10767], voteCount: 9000, character: 'Self' },
      { id: 2, mediaType: 'movie', title: 'Small Film', voteCount: 10, character: 'Lead' },
      { id: 3, mediaType: 'movie', title: 'No Country for Old Men', voteCount: 5000, character: 'Anton' },
      { id: 4, mediaType: 'movie', title: 'Premiere Guest', voteCount: 8000, character: 'Himself' },
      { id: 3, mediaType: 'movie', title: 'No Country for Old Men', voteCount: 5000, character: 'Anton (again)' },
    ],
    crew: [{ id: 5, mediaType: 'movie', title: 'Produced', voteCount: 700, job: 'Producer' }],
  };
  const h = moduleSpec(t, 'person-discovery.js', {
    item: { Id: PERSON, Type: 'Person', Name: 'Javier Bardem' },
    responses: { '/JellyfinEnhanced/jellyseerr/person/3810/combined_credits': credits },
    config: { JellyseerrShowPersonDiscovery: false },
  });
  // Rendered on that page even with person discovery off; a library person's page follows the switch.
  assert.equal(h.spec.enabledFor(PERSON), true);
  assert.equal(h.spec.enabledFor(LIBRARY_ID), false);
  assert.equal(h.spec.enabledFor(h.JE.titleDetails.syntheticId('movie', 3810)), false);
  const result = await h.spec.resolveItems({ id: PERSON, signal: h.signal });
  assert.equal(result.title, 'native_details_filmography');
  assert.deepEqual(Array.from(result.items, i => i.id), [3, 5, 2, 1, 4]);
  // Name from the page's own item, TMDB id from the page id: JE's library person route isn't asked.
  assert.deepEqual(h.requests, ['/JellyfinEnhanced/jellyseerr/person/3810/combined_credits']);
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
  assert.equal(feeds.title, 'discovery_more_with_genre:{"genre":"Sci-Fi & Fantasy"}');
  // The name comes from the page's item; JE's library genre route isn't asked.
  assert.deepEqual(h.requests, []);
  assert.deepEqual(h.items, [id]);
  // A movie-only genre id: the movie feed is that id.
  const h2 = moduleSpec(t, 'genre-discovery.js', { item: { Name: 'Science Fiction' }, genres });
  const sciFi = await h2.spec.resolveFeeds({ id: h2.JE.titleDetails.syntheticId('genre', 878), signal: h2.signal });
  assert.equal(sciFi.movieId, 878);
});

test('a library genre keeps JE\'s genre lookup', async t => {
  const h = moduleSpec(t, 'genre-discovery.js', {
    responses: { [`/JellyfinEnhanced/genre/${LIBRARY_ID}`]: { name: 'Drama' } },
    genres: { movie: [{ id: 18, name: 'Drama' }], tv: [{ id: 18, name: 'Drama' }] },
  });
  const feeds = await h.spec.resolveFeeds({ id: LIBRARY_ID, signal: h.signal });
  assert.deepEqual({ tvId: feeds.tvId, movieId: feeds.movieId }, { tvId: 18, movieId: 18 });
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

  const studio = moduleSpec(t, 'network-discovery.js', { item: { Name: 'Tiny Co' }, config: { TmdbEnabled: true } });
  const tiny = await studio.spec.resolveFeeds({ id: studio.JE.titleDetails.syntheticId('studio', 99), signal: studio.signal });
  // A company: its movies, and (with JE's TMDB key) its series by company.
  assert.deepEqual({ tvId: tiny.tvId, movieId: tiny.movieId, tvSource: tiny.tvSource }, { tvId: 99, movieId: 99, tvSource: 'company' });
  assert.equal(tiny.title, 'discovery_more_from_studio:{"studio":"Tiny Co"}');
  assert.deepEqual(studio.requests, [], 'no company search: the id is known');
});

test('the discovery base renders on a page its spec enables even with the switch off; other pages follow the switch', async t => {
  const h = createHarness({ html: '<main id="detail"></main>', JE: { pluginConfig: { JellyseerrShowPersonDiscovery: false } } });
  t.after(() => h.close());
  h.JE.jellyseerrUI = { createJellyseerrCard: item => Object.assign(h.document.createElement('div'), { className: 'card', textContent: String(item.id) }) };
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
