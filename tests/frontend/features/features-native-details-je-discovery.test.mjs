import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from '../helpers/harness.mjs';

// Requests & downloads, A1 fix round 1 (A1-SOUND-01): with Jellyfin Enhanced the request backend (public config
// NativeAbsentDetails.Source "tmdb") the discovery rows of the pages a native title links to (genre, studio, network,
// tag) and of library genre/studio/tag/person pages read the server's native feeds, chosen BEFORE any Seerr status,
// account or cache: Seerr off completely, or a viewer's Seerr account still linked, makes no difference. Seerr mode
// keeps its own choice. Each module runs over the real discovery utilities and native-details codec; the transport
// and Seerr's status are recorders.

const SERVER = '0202511b0eac4284ab045b3ba556d72e';
const LIBRARY_ID = '0123456789abcdef0123456789abcdef';
const SEERR_OFF = { active: false, userFound: false, reason: 'disabled' };
const LINKED = { active: true, userFound: true };
const UNLINKED = { active: true, userFound: false, reason: 'unlinked' };
const GENRES = {
  '/JellyfinEnhanced/native-details/genres/movie': [{ id: 14, name: 'Fantasy' }, { id: 16, name: 'Animation' }],
  '/JellyfinEnhanced/native-details/genres/tv': [{ id: 10765, name: 'Sci-Fi & Fantasy' }, { id: 16, name: 'Animation' }],
};

/**
 * One discovery module over the real discovery utilities, its spec captured from the discovery base.
 * @param {object} t Test context.
 * @param {string} file Module under jellyseerr/discovery.
 * @param {object} options Fixtures: metadata source, native pages on, Seerr status, transport answers, page item.
 * @returns {object} Harness, spec, the reads made and the Seerr status asks.
 */
function discoveryOver(t, file, { source = 'tmdb', native = true, status = SEERR_OFF, responses = {}, item = null, config = {} } = {}) {
  const reads = [];
  const seerr = { status: 0, collection: 0 };
  let spec = null;
  const h = createHarness({
    JE: {
      pluginConfig: {
        NativeAbsentDetails: { Enabled: native, ContractVersion: 1, Source: source },
        JellyseerrEnabled: source !== 'tmdb', JellyseerrShowGenreDiscovery: true, JellyseerrShowNetworkDiscovery: true,
        JellyseerrShowTagDiscovery: true, JellyseerrShowPersonDiscovery: true, JellyseerrShowCollectionDiscovery: true, TmdbEnabled: true,
        ...config,
      },
      t: (key, params) => (params ? `${key}:${JSON.stringify(params)}` : key),
      session: { getEpoch: () => 0, isCurrent: () => true, getServerId: () => SERVER, getUserId: () => 'user-a' },
      jellyseerrAPI: {
        checkUserStatus: async () => { seerr.status++; return status; },
        fetchCollectionDetails: async () => { seerr.collection++; return { parts: [] }; },
      },
      helpers: { getItemCached: async () => item },
      discoveryBase: {
        createDiscovery: s => { spec = s; return { start: () => {} }; },
        idFromDetailUrl: () => null,
        idFromListParam: () => () => null,
      },
    },
    apiClient: { serverId: () => SERVER, getItem: async () => item },
  });
  t.after(() => h.close());
  h.load('jellyseerr/seerr-status.js');
  h.load('jellyseerr/nativedetails/native-details.js');
  h.load('jellyseerr/discovery/discovery-filter-utils.js');
  // The transport (after the real utilities, which read through it): every read is recorded and answered from the fixtures.
  h.JE.core.api.fetch = async (url) => {
    const path = new URL(url).pathname + new URL(url).search;
    reads.push(path);
    const answer = { ...GENRES, ...responses }[path.replace(/\?.*$/, '')];
    return typeof answer === 'function' ? answer(path) : answer ?? null;
  };
  h.load(`jellyseerr/discovery/${file}`);
  const signal = new h.window.AbortController().signal;
  return { ...h, spec, reads, seerr, signal };
}

const seerrReads = reads => reads.filter(p => !p.startsWith('/JellyfinEnhanced/native-details/') && !/^\/JellyfinEnhanced\/(genre|studio|boxset|person)\//.test(p));

test('Seerr off: a genre page a native title links to has its feeds from the native route, with no Seerr status asked', async t => {
  const h = discoveryOver(t, 'genre-discovery.js', { item: { Name: 'Fantasy' } });
  const id = h.JE.titleDetails.syntheticId('genre', 14);
  const feeds = await h.spec.resolveFeeds({ id, signal: h.signal });
  assert.ok(feeds, 'a feed, not an empty page');
  assert.deepEqual([feeds.movieId, feeds.native], [14, true]);
  assert.equal(h.spec.buildDiscoverPath('movie', 14, feeds), '/JellyfinEnhanced/native-details/discover/movie/genre/14');
  assert.equal(h.seerr.status, 0, 'no Seerr status');
  assert.deepEqual(seerrReads(h.reads), [], 'no Seerr read');
});

test('Seerr off: a library genre, a library studio and a tag read the native feeds too', async t => {
  const g = discoveryOver(t, 'genre-discovery.js', { responses: { [`/JellyfinEnhanced/genre/${LIBRARY_ID}`]: { name: 'Animation' } } });
  const genre = await g.spec.resolveFeeds({ id: LIBRARY_ID, signal: g.signal });
  assert.deepEqual([genre?.movieId, genre?.tvId, genre?.native], [16, 16, true]);
  assert.equal(g.spec.buildDiscoverPath('tv', 16, genre), '/JellyfinEnhanced/native-details/discover/tv/genre/16');

  const n = discoveryOver(t, 'network-discovery.js', { responses: { [`/JellyfinEnhanced/studio/${LIBRARY_ID}`]: { name: '20th Century Fox', tmdbId: '25' } } });
  const studio = await n.spec.resolveFeeds({ id: LIBRARY_ID, signal: n.signal });
  assert.deepEqual([studio?.movieId, studio?.native], [25, true]);
  assert.equal(n.spec.buildDiscoverPath('movie', 25, studio), '/JellyfinEnhanced/native-details/discover/movie/studio/25');

  const tag = discoveryOver(t, 'tag-discovery.js', { responses: { '/JellyfinEnhanced/native-details/keywords': { results: [{ id: 161919, name: 'adult animation' }] } } });
  const tagFeeds = await tag.spec.resolveFeeds({ id: 'adult animation', signal: tag.signal });
  assert.deepEqual([tagFeeds?.movieId, tagFeeds?.native], [161919, true]);
  assert.equal(tag.spec.buildDiscoverPath('tv', 161919, tagFeeds), '/JellyfinEnhanced/native-details/discover/tv/keyword/161919');

  for (const x of [g, n, tag]) {
    assert.equal(x.seerr.status, 0);
    assert.deepEqual(seerrReads(x.reads), []);
  }
});

test('Seerr off: a network and a studio a native title links to have their feeds from the native route', async t => {
  const network = discoveryOver(t, 'network-discovery.js', { item: { Name: 'Disney+' } });
  const disney = await network.spec.resolveFeeds({ id: network.JE.titleDetails.syntheticId('network', 2739), signal: network.signal });
  assert.deepEqual([disney?.tvId, disney?.native], [2739, true]);
  assert.equal(network.spec.buildDiscoverPath('tv', 2739, disney), '/JellyfinEnhanced/native-details/discover/tv/network/2739');

  const studio = discoveryOver(t, 'network-discovery.js', { item: { Name: 'A24' } });
  const a24 = await studio.spec.resolveFeeds({ id: studio.JE.titleDetails.syntheticId('studio', 41077), signal: studio.signal });
  assert.deepEqual([a24?.movieId, a24?.native], [41077, true]);
  assert.equal(studio.spec.buildDiscoverPath('movie', 41077, a24), '/JellyfinEnhanced/native-details/discover/movie/studio/41077');
  for (const x of [network, studio]) assert.equal(x.seerr.status, 0);
});

test('Seerr off: a library person\'s row is their filmography from the native route', async t => {
  const FILMOGRAPHY = '/JellyfinEnhanced/native-details/person/3810/filmography';
  const h = discoveryOver(t, 'person-discovery.js', {
    item: { Type: 'Person', Name: 'Javier Bardem', ProviderIds: { Tmdb: '3810' } },
    responses: {
      [`/JellyfinEnhanced/person/${LIBRARY_ID}`]: { name: 'Javier Bardem', tmdbId: '3810' },
      [FILMOGRAPHY]: { results: [{ id: 6977, mediaType: 'movie', title: 'No Country for Old Men' }] },
    },
  });
  const row = await h.spec.resolveItems({ id: LIBRARY_ID, signal: h.signal });
  assert.deepEqual(row?.items?.map(i => i.id), [6977]);
  assert.ok(h.reads.includes(FILMOGRAPHY));
  assert.equal(h.seerr.status, 0);
  assert.deepEqual(seerrReads(h.reads), []);
});

test('a viewer whose Seerr account is still linked gets the JE genre lists and feeds, not Seerr\'s (retained Seerr settings)', async t => {
  const id = LIBRARY_ID;
  const g = discoveryOver(t, 'genre-discovery.js', { status: LINKED, responses: { [`/JellyfinEnhanced/genre/${id}`]: { name: 'Animation' } } });
  const feeds = await g.spec.resolveFeeds({ id, signal: g.signal });
  assert.equal(feeds?.native, true);
  assert.deepEqual(g.reads.filter(p => p.includes('genres/')).sort(), ['/JellyfinEnhanced/native-details/genres/movie', '/JellyfinEnhanced/native-details/genres/tv']);
  assert.equal(g.seerr.status, 0, 'the account is never asked about');
  assert.deepEqual(seerrReads(g.reads), [], 'never /JellyfinEnhanced/tmdb/genres (a Seerr proxy)');

  const synthetic = discoveryOver(t, 'genre-discovery.js', { status: LINKED, item: { Name: 'Fantasy' } });
  const fantasy = await synthetic.spec.resolveFeeds({ id: synthetic.JE.titleDetails.syntheticId('genre', 14), signal: synthetic.signal });
  assert.equal(fantasy?.native, true);
  assert.deepEqual(seerrReads(synthetic.reads), []);

  const tag = discoveryOver(t, 'tag-discovery.js', { status: LINKED, responses: { '/JellyfinEnhanced/native-details/keywords': { results: [{ id: 9715, name: 'superhero' }] } } });
  const tagFeeds = await tag.spec.resolveFeeds({ id: 'superhero', signal: tag.signal });
  assert.equal(tagFeeds?.native, true);
  assert.deepEqual(seerrReads(tag.reads), [], 'never /JellyfinEnhanced/tmdb/search/keyword (a Seerr proxy)');

  const n = discoveryOver(t, 'network-discovery.js', { status: LINKED, responses: { [`/JellyfinEnhanced/studio/${id}`]: { name: '20th Century Fox', tmdbId: '25' } } });
  assert.equal((await n.spec.resolveFeeds({ id, signal: n.signal }))?.native, true);
  for (const x of [synthetic, tag, n]) assert.equal(x.seerr.status, 0);
});

test('a genre list Seerr answered earlier in the tab (sessionStorage) is not the JE reader\'s', async t => {
  const g = discoveryOver(t, 'genre-discovery.js', { status: LINKED, responses: { [`/JellyfinEnhanced/genre/${LIBRARY_ID}`]: { name: 'Animation' } } });
  // Seerr's answer, kept under the legacy key: a different id for the same name.
  for (const type of ['movie', 'tv']) {
    g.window.sessionStorage.setItem(`je-tmdb-genres:${SERVER}:user-a:${type}`, JSON.stringify({ storedAt: Date.now(), genres: [{ id: 999, name: 'Animation' }] }));
  }
  const feeds = await g.spec.resolveFeeds({ id: LIBRARY_ID, signal: g.signal });
  assert.deepEqual([feeds?.movieId, feeds?.tvId], [16, 16], 'the native lists answer');
  assert.ok(g.reads.includes('/JellyfinEnhanced/native-details/genres/movie'));
  // Kept apart: the native lists under their own key, Seerr's untouched.
  assert.ok(g.window.sessionStorage.getItem(`je-tmdb-genres:${SERVER}:user-a:native:movie`));
  assert.match(g.window.sessionStorage.getItem(`je-tmdb-genres:${SERVER}:user-a:movie`), /999/);
});

test('JE the backend with native pages off: no row and no Seerr status, whoever the viewer is', async t => {
  for (const status of [SEERR_OFF, LINKED, UNLINKED]) {
    const g = discoveryOver(t, 'genre-discovery.js', { native: false, status, responses: { [`/JellyfinEnhanced/genre/${LIBRARY_ID}`]: { name: 'Animation' } } });
    assert.equal(await g.spec.resolveFeeds({ id: LIBRARY_ID, signal: g.signal }), null);
    const n = discoveryOver(t, 'network-discovery.js', { native: false, status, responses: { [`/JellyfinEnhanced/studio/${LIBRARY_ID}`]: { name: 'Fox', tmdbId: '25' } } });
    assert.equal(await n.spec.resolveFeeds({ id: LIBRARY_ID, signal: n.signal }), null);
    const tag = discoveryOver(t, 'tag-discovery.js', { native: false, status });
    assert.equal(await tag.spec.resolveFeeds({ id: 'superhero', signal: tag.signal }), null);
    for (const x of [g, n, tag]) {
      assert.equal(x.seerr.status, 0);
      assert.deepEqual(seerrReads(x.reads), []);
    }
  }
});

test('JE the backend: a library collection page\'s Seerr row reads neither Seerr\'s status nor its collection', async t => {
  const h = discoveryOver(t, 'collection-discovery.js', { status: LINKED, item: { Type: 'BoxSet', Name: 'The Matrix Collection' },
    responses: { [`/JellyfinEnhanced/boxset/${LIBRARY_ID}`]: { tmdbId: '2344' } } });
  await h.spec.renderOneShot({ id: LIBRARY_ID, signal: h.signal, waitForPageReady: async () => null });
  assert.deepEqual([h.seerr.status, h.seerr.collection], [0, 0]);
});

test('Seerr mode keeps its choice: a linked viewer reads Seerr\'s lists and feeds after its status', async t => {
  const g = discoveryOver(t, 'genre-discovery.js', { source: 'seerr', status: LINKED, responses: {
    [`/JellyfinEnhanced/genre/${LIBRARY_ID}`]: { name: 'Animation' },
    '/JellyfinEnhanced/tmdb/genres/movie': [{ id: 16, name: 'Animation' }], '/JellyfinEnhanced/tmdb/genres/tv': [{ id: 16, name: 'Animation' }],
  } });
  const feeds = await g.spec.resolveFeeds({ id: LIBRARY_ID, signal: g.signal });
  assert.equal(feeds?.native, false);
  assert.equal(g.seerr.status, 1);
  assert.ok(g.reads.includes('/JellyfinEnhanced/tmdb/genres/movie'));
  assert.equal(g.spec.buildDiscoverPath('movie', 16, feeds), '/JellyfinEnhanced/jellyseerr/discover/movies/genre/16');
  // Seerr unreachable or off in Seerr mode: no row, as before.
  const off = discoveryOver(t, 'genre-discovery.js', { source: 'seerr', status: SEERR_OFF, responses: { [`/JellyfinEnhanced/genre/${LIBRARY_ID}`]: { name: 'Animation' } } });
  assert.equal(await off.spec.resolveFeeds({ id: LIBRARY_ID, signal: off.signal }), null);
  assert.equal(off.JE.discoveryFilter.jeFeeds(), null);
});
