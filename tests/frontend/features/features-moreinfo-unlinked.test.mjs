// Seerr's more-info window for a viewer Seerr won't answer through their own account (no linked Seerr account, or
// Seerr turned off for them): in Jellyfin Enhanced request mode the window shows the title's public details from
// Jellyfin Enhanced's own routes (no read the proxy would refuse, no console error); in Seerr mode it says why in
// one message instead of opening empty.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { createHarness, plain } from '../helpers/harness.mjs';

const UNLINKED = { active: true, userFound: false, reason: 'unlinked' };
const BLOCKED = { active: true, userFound: false, reason: 'blocked' };
const LINKED = { active: true, userFound: true, reason: 'linked', jellyseerrUserId: '7' };

/** The proxy's refusal of a viewer without a Seerr account. */
const unlinkedError = () => Object.assign(new Error('HTTP 404'), { status: 404, responseJSON: { error: true, code: 'unlinked' } });
const httpError = (status, body) => Object.assign(new Error(`HTTP ${status}`), { status, responseJSON: body });

/**
 * Seerr's API module and the window's modules over fake plugin routes. Every read is recorded by its plugin path
 * ('/jellyseerr/…' through the viewer's account, '/native-details/…' Jellyfin Enhanced's public routes).
 * @param {import('node:test').TestContext} t Test.
 * @param {{routes?: Object, jeMode?: boolean, window?: boolean, config?: Object}} [options] Answers by path (a
 *   value, an Error to throw, or a function), JE mode, load the window's open/close module too.
 */
function setup(t, { routes = {}, jeMode = true, window: withWindow = false, config = {} } = {}) {
  const reads = [];
  const toasts = [];
  const answer = (path) => {
    reads.push(path);
    const route = routes[path];
    if (route === undefined) throw httpError(404, { code: 'not_found' });
    const value = typeof route === 'function' ? route() : route;
    if (value instanceof Error) throw value;
    return structuredClone(value);
  };
  const internal = {
    state: { currentModal: null },
    buildModalContent: () => '<button class="modal-refresh"></button><div data-mount="ratings"></div>',
    renderActions: () => {},
    enrichSeasonCardsWithJellyfinLinks: () => {},
    backfillSeasonMetadata: () => {},
    buildRatingLogos: ratings => ratings ? JSON.stringify(ratings) : ''
  };
  const h = createHarness({ JE: {
    pluginConfig: { JellyseerrEnabled: true, ...config },
    t: key => key,
    escapeHtml: s => String(s),
    toast: text => toasts.push(text),
    helpers: { trackUsage: () => {} },
    session: { getEpoch: () => 0, isCurrent: () => true, onUserChange: () => {} },
    seerrStatus: { MEDIA: { UNKNOWN: 1, AVAILABLE: 5 } },
    internals: { moreInfoModal: internal, arrAskSeerr: { jeMode: () => jeMode } },
    core: { api: {
      fetch: async url => answer(url.replace('http://jellyfin.test/JellyfinEnhanced', '')),
      plugin: async path => answer(path)
    } }
  } });
  t.after(() => h.close());
  h.load('jellyseerr/api.js');
  h.load('jellyseerr/moreinfo/more-info-modal-data.js');
  if (withWindow) h.load('jellyseerr/moreinfo/more-info-modal-init.js');
  return { ...h, get NATIVE() { return h.NATIVE; }, api: h.JE.jellyseerrAPI, internal, reads, toasts };
}

for (const [label, status] of [['without a linked Seerr account', UNLINKED], ['Seerr is turned off for', BLOCKED]]) {
  test(`JE mode: a viewer ${label} gets the title's public details, never a read through their Seerr account`, async t => {
    const h = setup(t, { routes: {
      '/jellyseerr/user-status': status,
      '/native-details/title/movie/693134': { id: 693134, title: 'Dune: Part Two' },
      '/native-details/title/tv/83867': { id: 83867, name: 'Andor', seasons: [] }
    } });
    const movie = await h.internal.fetchMediaDetails(693134, 'movie');
    assert.deepEqual([movie.title, movie.jePublicDetails], ['Dune: Part Two', true]);
    const series = await h.internal.fetchMediaDetails(83867, 'tv');
    assert.deepEqual([series.name, series.jePublicDetails], ['Andor', true]);
    // JE mode never reads Seerr (A1/BEH-02): not even the user status.
    assert.deepEqual(h.reads, ['/native-details/title/movie/693134', '/native-details/title/tv/83867']);
  });
}

test('Seerr mode: a viewer Seerr won\'t answer for is told why instead of an empty window, and nothing is read through their account', async t => {
  for (const [status, key] of [[UNLINKED, 'jellyseerr_modal_seerr_unlinked'], [BLOCKED, 'jellyseerr_modal_seerr_blocked']]) {
    const h = setup(t, { jeMode: false, routes: { '/jellyseerr/user-status': status } });
    let failure = null;
    await assert.rejects(h.internal.fetchMediaDetails(693134, 'movie'), error => { failure = error; return error.seerrAccount === status.reason; });
    assert.deepEqual(h.reads, ['/jellyseerr/user-status']);
    assert.equal(h.internal.errorKey(failure, 'jellyseerr_modal_load_failed'), key);
    assert.equal(h.internal.isExplained(failure), true);
  }
});

test('a refusal the user status could not tell yet (the proxy\'s own "unlinked") is handled the same, without a console error', async t => {
  const status = () => httpError(502, { code: 'unreachable' });
  const h = setup(t, { routes: {
    '/jellyseerr/user-status': status,
    '/jellyseerr/movie/1': unlinkedError,
    '/native-details/title/movie/1': { id: 1, title: 'Public' }
  } });
  const data = await h.internal.fetchMediaDetails(1, 'movie');
  assert.deepEqual([data.title, data.jePublicDetails], ['Public', true]);
  assert.deepEqual(h.reads, ['/native-details/title/movie/1']);

  const seerr = setup(t, { jeMode: false, routes: { '/jellyseerr/user-status': status, '/jellyseerr/movie/1': unlinkedError } });
  await assert.rejects(seerr.internal.fetchMediaDetails(1, 'movie'), error => error.seerrAccount === 'unlinked');
  assert.deepEqual(seerr.reads, ['/jellyseerr/user-status', '/jellyseerr/movie/1']);
});

test('Seerr mode: a linked viewer still reads through their own account, with Seerr\'s per-account part, and other failures stay errors', async t => {
  const h = setup(t, { jeMode: false, routes: {
    '/jellyseerr/user-status': LINKED,
    '/jellyseerr/movie/1': { id: 1, title: 'Mine', mediaInfo: { status: 5, jellyfinMediaId: 'abc' } },
    '/jellyseerr/movie/2': () => httpError(500, { code: 'UpstreamError' })
  } });
  const data = await h.internal.fetchMediaDetails(1, 'movie');
  assert.deepEqual([data.mediaInfo.jellyfinMediaId, data.jePublicDetails], ['abc', false]);
  h.expectConsoleError(/Failed to fetch movie details for TMDB ID 2/);
  let failure = null;
  await assert.rejects(h.internal.fetchMediaDetails(2, 'movie'), error => { failure = error; return error.status === 500; });
  assert.equal(h.internal.isExplained(failure), false);
  assert.equal(h.internal.errorKey(failure, 'jellyseerr_modal_load_failed'), 'jellyseerr_modal_load_failed');
  assert.ok(!h.reads.some(path => path.startsWith('/native-details')));
});

test('a title the server won\'t show the viewer says so; an outage of the public route says try again', async t => {
  const h = setup(t, { routes: {
    '/jellyseerr/user-status': UNLINKED,
    '/native-details/title/movie/9': () => httpError(404, { code: 'not_found' }),
    '/native-details/title/movie/10': () => httpError(503, { code: 'unavailable' })
  } });
  for (const [id, key] of [[9, 'jellyseerr_modal_not_available'], [10, 'jellyseerr_modal_load_failed']]) {
    let failure = null;
    await assert.rejects(h.internal.fetchMediaDetails(id, 'movie'), error => { failure = error; return error.jePublic === true; });
    assert.equal(h.internal.errorKey(failure, 'jellyseerr_modal_load_failed'), key);
    assert.equal(h.internal.isExplained(failure), true);
  }
});

for (const suppressed of [false, true]) test(`guarded jf10 public TV ratings follow suppression=${suppressed} through the window`, async t => {
  const h = setup(t, { window: true, routes: {
    '/jellyseerr/user-status': UNLINKED,
    '/native-details/title/tv/83867': { id: 83867, name: 'Andor', jeSpoiler: { guarded: true, ratings: suppressed } },
    '/native-details/title/tv/83867/ratings': suppressed ? null : { criticsScore: 96 }
  } });
  await h.JE.jellyseerrMoreInfo.open(83867, 'tv', undefined, h.NATIVE);
  await nextTurn(); await nextTurn();
  const text = h.internal.state.currentModal.querySelector('[data-mount="ratings"]').textContent;
  assert.equal(text, suppressed ? '' : JSON.stringify({ rt: { criticsScore: 96 } }));
});

test('public details\' ratings come from the same public route (series ratings kept under rt)', async t => {
  const h = setup(t, { routes: {
    '/native-details/title/tv/83867/ratings': { criticsScore: 96 },
    '/native-details/title/movie/693134/ratings': { rt: { criticsScore: 92 } }
  } });
  assert.deepEqual(plain(await h.internal.fetchRatings(83867, 'tv', { publicDetails: true })), { rt: { criticsScore: 96 } });
  assert.deepEqual(plain(await h.internal.fetchRatings(693134, 'movie', { publicDetails: true })), { rt: { criticsScore: 92 } });
  assert.deepEqual(h.reads, ['/native-details/title/tv/83867/ratings', '/native-details/title/movie/693134/ratings']);
});

test('Seerr\'s quota is not asked for once the user status says the viewer has no Seerr account', async t => {
  const h = setup(t, { routes: { '/jellyseerr/user-status': UNLINKED } });
  assert.equal(h.api.knownAccountRefusal(), null);
  assert.equal(await h.api.accountRefusal(), 'unlinked');
  assert.equal(h.api.knownAccountRefusal(), 'unlinked');
  assert.equal(await h.api.fetchUserQuota(), null);
  assert.deepEqual(h.reads, ['/jellyseerr/user-status']);
  assert.equal(h.api.accountRefusalOf(unlinkedError()), 'unlinked');
  assert.equal(h.api.accountRefusalOf(httpError(404, { code: 'not_found' })), null);
});

test('JE mode: the window opens with the public details and their ratings for a viewer without a Seerr account', async t => {
  const h = setup(t, { window: true, routes: {
    '/jellyseerr/user-status': UNLINKED,
    '/native-details/title/movie/693134': { id: 693134, title: 'Dune: Part Two' },
    '/native-details/title/movie/693134/ratings': { rt: { criticsScore: 92 } }
  } });
  const opened = [];
  h.document.addEventListener('jellyseerr-more-info-opened', e => opened.push(e.detail.data.jePublicDetails));
  await h.JE.jellyseerrMoreInfo.open(693134, 'movie', undefined, h.NATIVE);
  for (let i = 0; i < 5; i++) await nextTurn();
  const modal = h.document.querySelector('.je-more-info-modal');
  assert.ok(modal, 'the window is open');
  assert.deepEqual(opened, [true]);
  assert.equal(modal.querySelector('[data-mount="ratings"]').textContent, JSON.stringify({ rt: { criticsScore: 92 } }));
  assert.ok(!h.reads.some(path => path.startsWith('/jellyseerr/') && path !== '/jellyseerr/user-status'));
  // Refresh stays on the public route.
  modal.querySelector('.modal-refresh').click();
  for (let i = 0; i < 5; i++) await nextTurn();
  assert.equal(h.reads.filter(path => path === '/native-details/title/movie/693134').length, 2);
  assert.ok(!h.toasts.some(text => String(text).startsWith('jellyseerr_modal_')));
});

test('Seerr mode: the window says in one message that the Seerr account isn\'t linked, and opens nothing', async t => {
  const h = setup(t, { window: true, jeMode: false, routes: { '/jellyseerr/user-status': UNLINKED } });
  await h.JE.jellyseerrMoreInfo.open(693134, 'movie', undefined, h.NATIVE);
  assert.equal(h.document.querySelector('.je-more-info-modal'), null);
  assert.deepEqual(h.toasts.filter(text => String(text).startsWith('jellyseerr_modal_')), ['jellyseerr_modal_seerr_unlinked']);
  assert.deepEqual(h.reads, ['/jellyseerr/user-status']);
});

test('public details: season backfill uses the guarded cross-version route without a Seerr account', async t => {
  const h = setup(t, { config: { TmdbEnabled: true }, routes: {
    '/tmdb/tv/83867': { seasons: [{ season_number: 1, poster_path: '/s1.jpg', overview: 'One' }] },
    '/jellyseerr/tv/83867/season/1': { episodes: [{ airDate: '2022-09-21' }] },
    '/native-details/title/tv/83867/season/1': { episodes: [{ airDate: '2022-09-21' }] }
  } });
  h.load('jellyseerr/moreinfo/more-info-modal-seasons.js');
  const modal = h.document.createElement('div');
  modal.dataset.tmdbId = '83867';
  modal.innerHTML = '<div class="season-card" data-season-number="1"><div class="season-poster"></div><div class="season-info"></div></div>';
  h.internal.state.currentModal = modal;
  const series = () => ({ id: 83867, seasons: [{ seasonNumber: 1, episodeCount: 3, name: 'Season 1' }] });
  await h.internal.backfillSeasonMetadata(83867, { ...series(), jePublicDetails: true });
  assert.deepEqual(h.reads, ['/tmdb/tv/83867','/native-details/title/tv/83867/season/1']);
  // Control: details read through the viewer's account still ask Seerr for the season.
  await h.internal.backfillSeasonMetadata(83867, { ...series(), jePublicDetails: false });
  assert.deepEqual(h.reads.slice(2).sort(), ['/jellyseerr/tv/83867/season/1', '/tmdb/tv/83867']);
});

test('JE mode: no "sign in to Seerr to enable requests" banner for a viewer without a Seerr account (requests and details don\'t need one)', async t => {
  for (const status of [UNLINKED, BLOCKED]) {
    const je = setup(t, { routes: { '/jellyseerr/user-status': status } });
    await je.api.checkUserStatus();
    assert.deepEqual(je.toasts, []);
    // Seerr mode: the banner says why, as before.
    const seerr = setup(t, { jeMode: false, routes: { '/jellyseerr/user-status': status } });
    await seerr.api.checkUserStatus();
    assert.equal(seerr.toasts.length, 1);
    assert.match(String(seerr.toasts[0]), /^Seerr: /);
  }
  // Other reasons (Seerr unreachable) still say so in JE mode.
  const down = setup(t, { routes: { '/jellyseerr/user-status': { active: false, userFound: false, reason: 'unreachable' } } });
  await down.api.checkUserStatus();
  assert.equal(down.toasts.length, 1);
});

test('public details of a series the viewer has: "request more" is judged by their library, never by Seerr\'s request list', async t => {
  let seasonsHere = [1];
  const h = setup(t, { routes: {
    'http://jellyfin.test/Users/user-a/Items': () => ({ Items: seasonsHere.map(n => ({ IndexNumber: n })) }),
    '/jellyseerr/request?take=500&skip=0&filter=all': { results: [] }
  } });
  h.load('jellyseerr/seerr-status.js');
  h.load('jellyseerr/moreinfo/more-info-modal-seasons.js');
  const series = jePublicDetails => ({ id: 83867, jePublicDetails, mediaInfo: { status: 5, jellyfinMediaId: 'abc' },
    seasons: [{ seasonNumber: 1, episodeCount: 3 }, { seasonNumber: 2, episodeCount: 12 }] });
  assert.equal(await h.internal.checkForUnrequestedSeasons(series(true)), true, 'season 2 isn\'t in the library');
  seasonsHere = [1, 2];
  assert.equal(await h.internal.checkForUnrequestedSeasons(series(true)), false, 'every season is here');
  assert.ok(!h.reads.includes('/jellyseerr/request?take=500&skip=0&filter=all'));
  // Control: details read through the viewer's account still ask Seerr's request list.
  await h.internal.checkForUnrequestedSeasons(series(false));
  assert.ok(h.reads.includes('/jellyseerr/request?take=500&skip=0&filter=all'));
});

test('a title page\'s similar and recommended rows: public and judged on the server in JE mode, not asked for in Seerr mode, Seerr\'s own for a linked viewer', async t => {
  const je = setup(t, { routes: {
    '/jellyseerr/user-status': UNLINKED,
    '/native-details/title/movie/693134/related/similar?page=1': { page: 1, totalPages: 1, results: [{ id: 438631, mediaType: 'movie', title: 'Dune' }] },
    '/native-details/title/tv/83867/related/recommendations?page=2': { page: 2, totalPages: 2, results: [] }
  } });
  await je.api.checkUserStatus();
  assert.deepEqual((await je.api.fetchSimilarMovies(693134)).results.map(r => r.title), ['Dune']);
  assert.equal((await je.api.fetchRecommendedTvShows(83867, { page: 2 })).page, 2);
  assert.deepEqual(je.reads, ['/jellyseerr/user-status', '/native-details/title/movie/693134/related/similar?page=1', '/native-details/title/tv/83867/related/recommendations?page=2']);

  const seerr = setup(t, { jeMode: false, routes: { '/jellyseerr/user-status': UNLINKED } });
  await seerr.api.checkUserStatus();
  assert.deepEqual(plain(await seerr.api.fetchSimilarMovies(693134)), { results: [], page: 1, totalPages: 0, totalResults: 0 });
  assert.deepEqual(seerr.reads, ['/jellyseerr/user-status']);

  const linked = setup(t, { routes: { '/jellyseerr/user-status': LINKED, '/jellyseerr/movie/693134/similar?page=1': { results: [{ id: 1 }] } } });
  await linked.api.checkUserStatus();
  assert.equal((await linked.api.fetchSimilarMovies(693134)).results.length, 1);
  assert.deepEqual(linked.reads, ['/jellyseerr/user-status', '/jellyseerr/movie/693134/similar?page=1']);
});


test('JE mode on a server without the public route (a bare 404): the window says it can\'t load, never a Seerr account message', async t => {
  const h = setup(t, { routes: {
    '/jellyseerr/user-status': UNLINKED,
    '/native-details/title/movie/1': () => Object.assign(new Error('HTTP 404'), { status: 404 })
  } });
  let failure = null;
  await assert.rejects(h.internal.fetchMediaDetails(1, 'movie'), error => { failure = error; return true; });
  assert.equal(h.internal.errorKey(failure, 'jellyseerr_modal_load_failed'), 'jellyseerr_modal_load_failed');
  assert.equal(h.internal.isExplained(failure), true);
  assert.deepEqual(h.reads, ['/native-details/title/movie/1']);
});

// A1/BEH-02: the JE backend's window reads the public (TMDB) details, whatever Seerr settings remain and whoever is linked.
test('JE mode with Seerr still configured and a linked viewer: the public details, never a Seerr read', async t => {
  const h = setup(t, { routes: {
    '/jellyseerr/user-status': LINKED,
    '/jellyseerr/movie/1': { id: 1, title: 'Seerr copy', mediaInfo: { status: 5 } },
    '/native-details/title/movie/1': { id: 1, title: 'Public' }
  } });
  const data = await h.internal.fetchMediaDetails(1, 'movie');
  assert.deepEqual([data.title, data.jePublicDetails], ['Public', true]);
  assert.deepEqual(h.reads, ['/native-details/title/movie/1']);
});

test('the JE backend without its request rollout (native source "tmdb") reads the public details too', async t => {
  const h = setup(t, { jeMode: false, config: { NativeAbsentDetails: { Enabled: true, ContractVersion: 1, Source: 'tmdb' } }, routes: {
    '/jellyseerr/user-status': LINKED,
    '/native-details/title/tv/83867': { id: 83867, name: 'Andor', seasons: [] }
  } });
  const data = await h.internal.fetchMediaDetails(83867, 'tv');
  assert.deepEqual([data.name, data.jePublicDetails], ['Andor', true]);
  assert.deepEqual(h.reads, ['/native-details/title/tv/83867']);
});

test('a server refusing Seerr\'s routes (409 backend_disabled) is not an account refusal: the window reads the public details, no console error', async t => {
  const disabled = () => httpError(409, { code: 'backend_disabled', error: true });
  const h = setup(t, { jeMode: false, routes: {
    '/jellyseerr/user-status': LINKED,
    '/jellyseerr/movie/1': disabled,
    '/native-details/title/movie/1': { id: 1, title: 'Public' }
  } });
  const data = await h.internal.fetchMediaDetails(1, 'movie');
  assert.deepEqual([data.title, data.jePublicDetails], ['Public', true]);
  assert.deepEqual(h.reads, ['/jellyseerr/user-status', '/jellyseerr/movie/1', '/native-details/title/movie/1']);
  // Its own failure is explained like any public read, not logged.
  const down = setup(t, { jeMode: false, routes: { '/jellyseerr/user-status': LINKED, '/jellyseerr/movie/2': disabled, '/native-details/title/movie/2': () => httpError(503, { code: 'unavailable' }) } });
  let failure = null;
  await assert.rejects(down.internal.fetchMediaDetails(2, 'movie'), error => { failure = error; return error.jePublic === true; });
  assert.equal(down.internal.isExplained(failure), true);
  // Any other 409 stays an error.
  const other = setup(t, { jeMode: false, routes: { '/jellyseerr/user-status': LINKED, '/jellyseerr/movie/3': () => httpError(409, { code: 'conflict' }) } });
  other.expectConsoleError(/Failed to fetch movie details for TMDB ID 3/);
  await assert.rejects(other.internal.fetchMediaDetails(3, 'movie'), error => error.status === 409 && !error.jePublic);
});

test('Jellyfin 10.11 (no public routes): a title page\'s rows are left out quietly for a viewer without a Seerr account', async t => {
  const h = setup(t, { routes: {
    '/jellyseerr/user-status': UNLINKED,
    '/native-details/title/tv/615/related/similar?page=1': () => Object.assign(new Error('HTTP 404'), { status: 404 })
  } });
  await h.api.checkUserStatus();
  assert.deepEqual(plain(await h.api.fetchSimilarTvShows(615)), { results: [], page: 1, totalPages: 0, totalResults: 0 });
});

// A1 fix round 1: the JE backend's rows (a library title page's Similar/Recommended) come from the public route before any
// Seerr account logic: a linked viewer with Seerr settings kept, or Seerr off, request switches on or off.
test('the JE backend reads a title page\'s similar and recommended rows from the public route, never through a Seerr account', async t => {
  const routes = {
    '/jellyseerr/user-status': LINKED,
    '/jellyseerr/movie/693134/similar?page=1': { results: [{ id: 1, title: 'Seerr copy' }] },
    '/native-details/title/movie/693134/related/similar?page=1': { page: 1, totalPages: 1, results: [{ id: 438631, mediaType: 'movie', title: 'Dune' }] }
  };
  for (const jeMode of [true, false]) {
    const h = setup(t, { jeMode, config: { NativeAbsentDetails: { Enabled: true, ContractVersion: 1, Source: 'tmdb' } }, routes });
    await h.api.checkUserStatus();
    assert.deepEqual((await h.api.fetchSimilarMovies(693134)).results.map(r => r.title), ['Dune']);
    assert.deepEqual(h.reads, ['/jellyseerr/user-status', '/native-details/title/movie/693134/related/similar?page=1'], `request switches ${jeMode ? 'on' : 'off'}`);
  }
  const off = setup(t, { jeMode: false, config: { JellyseerrEnabled: false, NativeAbsentDetails: { Enabled: true, ContractVersion: 1, Source: 'tmdb' } }, routes });
  assert.deepEqual((await off.api.fetchSimilarMovies(693134)).results.map(r => r.title), ['Dune']);
  assert.deepEqual(off.reads, ['/native-details/title/movie/693134/related/similar?page=1']);
});
