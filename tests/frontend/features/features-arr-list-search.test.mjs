// Phase 4c3b1: list authoring search and metadata. JE households search through the existing acquire/search route,
// Seerr households through the existing Seerr proxy; Import being off changes neither. A person JE search refuses
// (a Watcher) gets custom entries only, with the reason, and no new role. Typed facts only: complete, partial or
// unavailable season facts from the producer's contract, never a raw provider payload, and only complete facts may be
// cached. An arr result without a TMDB id can fill a custom entry, never an acquisition identity. The search presenter
// draws only the newest query's answer, through the paint gate.
import test from 'node:test';
import { setupAuthoring, json, deferred, assert } from './fixtures/arr-list-authoring.mjs';

const JE_CARD = (tmdbId, extra = {}) => ({ key: `movie:tmdb:${tmdbId}`, kind: 'movie', tmdbId, title: `Movie ${tmdbId}`, year: 2001, poster: '/m.jpg', inLibrary: false, ...extra });
const SEERR = (id, extra = {}) => ({ id, mediaType: 'tv', name: `Show ${id}`, firstAirDate: '2010-01-02', posterPath: '/s.jpg', ...extra });

test('search goes to the existing route of the household\'s backend; Import off changes nothing', t => {
  const { lp } = setupAuthoring(t, { config: { ArrListImportEnabled: false } });
  const m = lp().metadata;
  assert.equal(m.searchSource({ backend: 'je' }), 'je');
  assert.equal(m.searchSource({ backend: 'seerr' }), 'seerr');
  assert.equal(m.searchSource(null), 'none');
  assert.equal(m.searchSource({ backend: 'other' }), 'none');
  assert.equal(m.searchPath('je', 'cars 2', 'en'), '/acquire/search?q=cars%202&page=1&language=en');
  assert.equal(m.searchPath('seerr', 'cars 2', 'en'), '/jellyseerr/search?query=cars%202&page=1&language=en');
  assert.equal(m.searchPath('none', 'cars', 'en'), null);
  assert.equal(m.searchPath('je', '', 'en'), null, 'no empty query');
  assert.equal(m.searchPath('je', 'x'.repeat(101), 'en'), null, 'the route\'s 100-character limit');
});

test('JE and Seerr results become typed candidates; anything else is dropped', t => {
  const { lp } = setupAuthoring(t);
  const m = lp().metadata;
  assert.deepEqual(m.fromJe(JE_CARD(5)), { source: 'je', identity: { mediaType: 'movie', tmdbId: 5 }, title: 'Movie 5', year: 2001, releaseDate: null, posterPath: '/m.jpg', inLibrary: false, inert: false });
  assert.deepEqual(m.fromJe(JE_CARD(6, { kind: 'tv', poster: 'http://evil/x.jpg' })).posterPath, null, 'unsafe poster path');
  for (const bad of [JE_CARD(0), JE_CARD(-1), { ...JE_CARD(3), kind: 'person' }, null, {}]) assert.equal(m.fromJe(bad), null);
  assert.deepEqual(m.fromSeerr(SEERR(9)), { source: 'seerr', identity: { mediaType: 'tv', tmdbId: 9 }, title: 'Show 9', year: 2010, releaseDate: '2010-01-02', posterPath: '/s.jpg', inLibrary: false, inert: false });
  assert.equal(m.fromSeerr({ ...SEERR(9), mediaType: 'person' }), null);
  assert.equal(m.fromSeerr({ ...SEERR(9), id: 'x' }), null);
  assert.equal(m.fromSeerr({ ...SEERR(9), mediaInfo: { status: 5, jellyfinMediaId: 'abc' } }).inLibrary, true);
});

test('search answers: results, an empty answer, Watchers and hidden search get custom entries only, outages', t => {
  const { lp } = setupAuthoring(t);
  const m = lp().metadata;
  const ok = m.searchOutcome('je', { status: 200, body: { outcome: 'accepted', answer: { results: [JE_CARD(1), JE_CARD(0), JE_CARD(2)] } } });
  assert.deepEqual([ok.state, ok.items.map(c => c.identity.tmdbId)], ['results', [1, 2]]);
  assert.deepEqual(m.searchOutcome('je', { status: 200, body: { answer: { results: [] } } }), { state: 'results', items: [] });
  assert.deepEqual(m.searchOutcome('seerr', { status: 200, body: { results: [SEERR(4)] } }).items.length, 1);
  assert.deepEqual(m.searchOutcome('je', { status: 403, body: { outcome: 'denied', reason: 'requests_create_required' } }), { state: 'custom_only', reason: 'watcher' });
  assert.deepEqual(m.searchOutcome('je', { status: 403, body: { outcome: 'denied', reason: 'search_hidden' } }), { state: 'custom_only', reason: 'search_hidden' });
  assert.deepEqual(m.searchOutcome('je', { status: 503, body: null }), { state: 'unavailable', reason: 'outage' });
  assert.deepEqual(m.searchOutcome('je', { status: 200, body: { nope: 1 } }), { state: 'unavailable', reason: 'malformed' });
  assert.deepEqual(m.searchOutcome('je', null), { state: 'unavailable', reason: 'outage' });
  assert.deepEqual(m.searchOutcome('none', { status: 200, body: {} }), { state: 'custom_only', reason: 'no_search' });
});

test('an arr result without TMDB fills a custom entry only; the admin arr group stays a core handoff with Seerr off', t => {
  const { lp } = setupAuthoring(t);
  const m = lp().metadata;
  assert.deepEqual(m.fromArr({ tmdbId: 77, mediaType: 'movie', title: 'Arr Movie', year: 2020, posterPath: '/a.jpg' }), { source: 'arr', identity: { mediaType: 'movie', tmdbId: 77 }, title: 'Arr Movie', year: 2020, releaseDate: null, posterPath: '/a.jpg', inLibrary: false, inert: false });
  const inert = m.fromArr({ tvdbId: 12, imdbId: 'tt0000012', mediaType: 'tv', title: 'No TMDB Show', year: 1999 });
  assert.deepEqual(inert, { source: 'arr', identity: null, title: 'No TMDB Show', year: 1999, releaseDate: null, posterPath: null, inLibrary: false, inert: true, custom: { mediaType: 'tv', title: 'No TMDB Show', year: 1999 } });
  // Groups: the backend's search, then the admin's arr lookup when the core supplies one; nothing is dropped silently.
  assert.deepEqual(m.searchGroups({ source: 'je', isAdmin: true, arrLookup: true }), { groups: ['je', 'arr'], pending: [] });
  assert.deepEqual(m.searchGroups({ source: 'none', isAdmin: true, arrLookup: true }), { groups: ['arr'], pending: [] });
  assert.deepEqual(m.searchGroups({ source: 'je', isAdmin: true, arrLookup: false }), { groups: ['je'], pending: ['arr'] });
  assert.deepEqual(m.searchGroups({ source: 'seerr', isAdmin: false, arrLookup: true }), { groups: ['seerr'], pending: [] });
});

test('season facts are typed: complete, partial or unavailable; never a raw payload or an empty answer read as zero', t => {
  const { lp } = setupAuthoring(t);
  const m = lp().metadata;
  const complete = m.seasonFacts({ state: 'complete', count: 2, seasons: [{ seasonNumber: 0, episodeCount: 3 }, { seasonNumber: 1, episodeCount: 10, airDate: '2010-01-02' }] });
  assert.deepEqual(complete, { state: 'complete', seasons: [{ seasonNumber: 1, episodeCount: 10, airDate: '2010-01-02' }, { seasonNumber: 0, episodeCount: 3, airDate: null }] });
  assert.deepEqual(m.seasonFacts({ state: 'complete', count: 0, seasons: [] }), { state: 'complete', seasons: [] }, 'a proven zero');
  assert.deepEqual(m.seasonFacts({ state: 'complete', seasons: [] }), { state: 'unavailable', reason: 'unproven' }, 'no count: not a complete zero');
  assert.deepEqual(m.seasonFacts({ state: 'complete', count: 3, seasons: [{ seasonNumber: 1, episodeCount: 2 }] }), { state: 'unavailable', reason: 'unproven' });
  assert.equal(m.seasonFacts({ state: 'partial', seasons: [{ seasonNumber: 1, episodeCount: 2 }] }).state, 'partial');
  assert.deepEqual(m.seasonFacts({ state: 'partial', seasons: [] }), { state: 'unavailable', reason: 'unproven' });
  assert.deepEqual(m.seasonFacts({ state: 'unavailable', reason: 'tmdb' }), { state: 'unavailable', reason: 'tmdb' });
  // Raw provider shapes and invalid rows: never parsed here.
  for (const raw of [{ seasons: [{ season_number: 1, episode_count: 3 }] }, { id: 1, number_of_seasons: 2 }, null, [], { state: 'complete', count: 1, seasons: [{ seasonNumber: -1, episodeCount: 2 }] }, { state: 'complete', count: 1, seasons: [{ seasonNumber: 1, episodeCount: 'x' }] }]) {
    assert.equal(m.seasonFacts(raw).state, 'unavailable', JSON.stringify(raw));
  }
  const eps = m.episodeFacts({ state: 'complete', count: 2, seasonNumber: 2, episodes: [{ episodeNumber: 2, title: 'B', airDate: '2011-01-01' }, { episodeNumber: 1, title: 'A' }] });
  assert.deepEqual(eps, { state: 'complete', seasonNumber: 2, episodes: [{ e: 1, title: 'A', airDate: null }, { e: 2, title: 'B', airDate: '2011-01-01' }] });
  assert.equal(m.episodeFacts({ state: 'complete', seasonNumber: 2, episodes: [] }).state, 'unavailable');
});

test('only complete facts are cached, under the viewer, policy and source they were read for', t => {
  const { lp, signIn } = setupAuthoring(t);
  const m = lp().metadata;
  const cache = m.factCache(4);
  const scope = { source: 'je', policy: 'p1' };
  const complete = m.seasonFacts({ state: 'complete', count: 1, seasons: [{ seasonNumber: 1, episodeCount: 2 }] });
  const partial = m.seasonFacts({ state: 'partial', seasons: [{ seasonNumber: 1, episodeCount: 2 }] });
  assert.equal(cache.admit('tv:1', scope, partial), false);
  assert.equal(cache.get('tv:1', scope), null);
  assert.equal(cache.admit('tv:1', scope, complete), true);
  assert.deepEqual(cache.get('tv:1', scope), complete);
  assert.equal(cache.get('tv:1', { source: 'seerr', policy: 'p1' }), null, 'another source');
  assert.equal(cache.get('tv:1', { source: 'je', policy: 'p2' }), null, 'another policy');
  signIn('user-b');
  assert.equal(cache.get('tv:1', scope), null, 'another person');
  for (let i = 0; i < 10; i++) cache.admit(`tv:${i}`, scope, complete);
  assert.ok(cache.size() <= 4, 'bounded');
});

test('JE-only season enumeration is a pending producer read: without it seasons are unavailable, not empty', async t => {
  const { lp } = setupAuthoring(t);
  const m = lp().metadata;
  // The presenter reads through its checked step (lp.surface) and hands the settled read here: {ok, value} | {ok: false, error}.
  assert.deepEqual(m.seasonsFrom(null), { state: 'unavailable', reason: 'producer_missing' });
  assert.deepEqual(m.seasonsFrom({ ok: false, error: new Error('down') }), { state: 'unavailable', reason: 'outage' });
  assert.deepEqual(m.seasonsFrom({ ok: true, value: { status: 200, body: { state: 'complete', count: 1, seasons: [{ seasonNumber: 1, episodeCount: 4 }] } } }), { state: 'complete', seasons: [{ seasonNumber: 1, episodeCount: 4, airDate: null }] });
  assert.deepEqual(m.seasonsFrom({ ok: true, value: { status: 403, body: null } }), { state: 'unavailable', reason: 'denied' });
  assert.deepEqual(m.seasonsFrom({ ok: true, value: { status: 503, body: null } }), { state: 'unavailable', reason: 'outage' });
  assert.deepEqual(m.episodesFrom({ ok: true, value: { status: 200, body: { state: 'complete', count: 0, seasonNumber: 1, episodes: [] } } }), { state: 'unavailable', reason: 'unproven' });
});

/** A reader of the plugin's routes for the presenter (b2 wires the household's real reader). */
function reader(s) {
  return async (path, { signal } = {}) => {
    const response = await s.window.fetch(s.window.ApiClient.getUrl('/JellyfinEnhanced' + path), { signal });
    let body = null;
    try { body = await response.json(); } catch { body = null; }
    return { status: response.status, body };
  };
}

test('the search presenter draws only the newest query: a reversed answer and an aborted read are dropped', async t => {
  const answers = new Map();
  const signals = [];
  const s = setupAuthoring(t, {
    route: async (method, path) => {
      if (!path.startsWith('/acquire/search')) return null;
      const q = new URL('http://x' + path).searchParams.get('q');
      const gate = deferred();
      answers.set(q, gate);
      return gate.promise;
    }
  });
  const wrappedRead = (path, opts) => { signals.push(opts?.signal); return reader(s)(path, opts); };
  const L = s.lp();
  const ticket = L.gate.issue(null, () => true, L.gate.policy(() => false, false));
  const root = s.mount();
  const search = L.search.create({ ticket, root, source: 'je', read: wrappedRead, lang: 'en' });
  const first = search.query('car');
  await s.settle();
  const second = search.query('cars');
  await s.settle();
  assert.equal(signals[0].aborted, true, 'the older read is aborted');
  answers.get('cars').resolve(json({ answer: { results: [JE_CARD(2)] } }));
  await second;
  answers.get('car').resolve(json({ answer: { results: [JE_CARD(1)] } }));
  await first.catch(() => {});
  await s.settle();
  assert.deepEqual([...root.querySelectorAll('[data-je-candidate]')].map(n => n.textContent.includes('Movie 2')), [true]);
  assert.equal(root.textContent.includes('Movie 1'), false);
  // Choosing a result gives its typed candidate.
  root.querySelector('[data-je-candidate]').click();
  assert.deepEqual(search.selected().identity, { mediaType: 'movie', tmdbId: 2 });
  search.destroy();
});

test('a Watcher\'s search says why and offers custom entries; nothing else is drawn', async t => {
  const s = setupAuthoring(t, { route: async (m, path) => path.startsWith('/acquire/search') ? json({ outcome: 'denied', reason: 'requests_create_required' }, 403) : null });
  const L = s.lp();
  const ticket = L.gate.issue(null, () => true, L.gate.policy(() => false, false));
  const root = s.mount();
  const search = L.search.create({ ticket, root, source: 'je', read: reader(s), lang: 'en' });
  const out = await search.query('cars');
  assert.deepEqual(out, { state: 'custom_only', reason: 'watcher' });
  assert.match(root.textContent, /can still add a custom entry/);
  assert.equal(root.querySelectorAll('[data-je-candidate]').length, 0);
  assert.equal(search.customOnly(), true);
});

test('arr results without TMDB are labelled custom-only; a revoked ticket draws nothing', async t => {
  const s = setupAuthoring(t, { route: async (m, path) => path.startsWith('/acquire/search') ? json({ answer: { results: [JE_CARD(1)] } }) : null });
  const L = s.lp();
  let live = true;
  const ticket = L.gate.issue(null, () => live, L.gate.policy(() => false, false));
  const root = s.mount();
  const arr = async () => [{ tmdbId: 0, tvdbId: 5, mediaType: 'tv', title: 'Old Show', year: 1970 }, { tmdbId: 8, mediaType: 'movie', title: 'Arr 8', year: 2001 }];
  const search = L.search.create({ ticket, root, source: 'je', read: reader(s), lang: 'en', arrLookup: arr, isAdmin: true });
  await search.query('old');
  const rows = [...root.querySelectorAll('[data-je-candidate]')];
  assert.equal(rows.length, 3);
  const oldRow = rows.find(r => r.textContent.includes('Old Show'));
  assert.match(oldRow.textContent, /Custom entry only/);
  oldRow.click();
  assert.equal(search.selected().inert, true);
  assert.equal(search.selected().identity, null);
  live = false;
  const before = root.innerHTML;
  await search.query('other');
  assert.equal(root.innerHTML, before, 'nothing painted after the ticket ended');
});

test('4C3B1-R1-4: search years follow the ticket\'s date policy (no policy: no years; guarded with air dates hidden: no unreleased year)', async t => {
  const s = setupAuthoring(t, {
    route: async (m, path) => path.startsWith('/jellyseerr/search')
      ? json({ results: [SEERR(9, { firstAirDate: '2099-03-04' }), { id: 10, mediaType: 'movie', title: 'Old Movie', releaseDate: '1999-01-01' }] })
      : null
  });
  const L = s.lp();
  const rows = async policy => {
    const ticket = L.gate.issue(null, () => true, policy);
    const root = s.mount();
    const search = L.search.create({ ticket, root, source: 'seerr', read: reader(s), lang: 'en' });
    await search.query('show');
    const meta = [...root.querySelectorAll('[data-je-candidate]')].map(n => n.textContent);
    search.destroy();
    return meta;
  };
  const all = await rows(L.gate.GUARD_ALL);
  assert.equal(all.length, 2);
  assert.doesNotMatch(all.join(' '), /2099|1999/, 'a policy that could not be read hides every year');
  const guarded = await rows(L.gate.policy(() => true, true));
  assert.doesNotMatch(guarded[0], /2099/, 'a guarded title not out yet loses its year');
  assert.match(guarded[1], /1999/, 'a guarded title already out keeps its year');
  const open = await rows(L.gate.policy(() => false, false));
  assert.match(open[0], /2099/);
  assert.match(open[1], /1999/);
  const datesShown = await rows(L.gate.policy(() => true, false));
  assert.match(datesShown[0], /2099/, 'air dates not hidden: the year stays');
});
