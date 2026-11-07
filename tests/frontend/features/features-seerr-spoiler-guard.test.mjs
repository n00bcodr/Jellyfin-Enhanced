import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, jsonResponse } from '../helpers/harness.mjs';

// What the server sends for a protected movie: see SpoilerSeerrRedactor.
const redactedMovie = () => ({
  id: 603, title: 'Film', overview: 'Spoiler Guard activated', runtime: 136, jeSpoilerGuard: true, jeYear: '1999',
  genres: [{ id: 1, name: 'Action' }], jeRuleKeywords: [{ id: 9, name: 'secret keyword' }],
  credits: { cast: [{ id: 1, name: 'Actor' }], crew: [] },
  mediaInfo: { status: 5 },
});
const fullMovie = () => ({
  id: 603, title: 'Film', overview: 'Secret plot', tagline: 'Secret tagline', runtime: 136, releaseDate: '1999-03-31',
  genres: [{ id: 1, name: 'Action' }], keywords: [{ id: 9, name: 'secret keyword' }],
  credits: { cast: [{ id: 1, name: 'Actor', character: 'Secret role' }], crew: [] },
  relatedVideos: [{ site: 'YouTube', key: 'abc', type: 'Trailer', name: 'Secret trailer', url: 'https://youtube.test/abc' }],
  mediaInfo: { status: 5 },
});

function moreInfo(t, JE = {}) {
  const h = createHarness({ JE: {
    pluginConfig: {}, escapeHtml: value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    t: key => key, cdn: { flagPng: code => `/flag/${code}.png`, selfhst: path => `/cdn/${path}` }, ...JE,
  } });
  t.after(() => h.close());
  h.load('jellyseerr/seerr-status.js');
  for (const part of ['data', 'badges', 'seasons', 'render']) h.load(`jellyseerr/moreinfo/more-info-modal-${part}.js`);
  const internal = h.JE.internals.moreInfoModal;
  const render = (data, mediaType = 'movie') => {
    const host = h.document.createElement('div');
    host.innerHTML = internal.buildModalContent(data, mediaType);
    return host;
  };
  return { ...h, internal, render };
}

test('More Info renders the redacted body without the fields the server removed', t => {
  const { render } = moreInfo(t);
  const modal = render(redactedMovie());
  assert.equal(modal.querySelector('.overview-section p').textContent, 'Spoiler Guard activated');
  assert.equal(modal.querySelector('.tagline'), null);
  assert.equal(modal.querySelector('.keywords-section'), null);
  assert.doesNotMatch(modal.textContent, /secret/i);
  assert.equal(modal.querySelector('.person-character').textContent, '');
  assert.equal(modal.querySelector('.year').textContent, '(1999)');
});

test('More Info still renders those fields, and the year from the date, on an unprotected title', t => {
  const { render } = moreInfo(t);
  const modal = render(fullMovie());
  assert.equal(modal.querySelector('.overview-section p').textContent, 'Secret plot');
  assert.equal(modal.querySelector('.tagline').textContent, 'Secret tagline');
  assert.ok(modal.querySelector('.keywords-section'));
  assert.equal(modal.querySelector('.person-character').textContent, 'Secret role');
  assert.equal(modal.querySelector('.year').textContent, '(1999)');
});

test('More Info never fills a protected title back in from TMDB', async t => {
  let lookups = 0;
  const lookup = async () => { lookups++; return { seasons: [{ season_number: 2, overview: 'Secret season plot' }] }; };
  const { internal } = moreInfo(t, { pluginConfig: { TmdbEnabled: true }, jellyseerrAPI: { fetchTmdbTvDetails: lookup, fetchTvSeasonDetails: lookup } });
  internal.state.currentModal = { dataset: { tmdbId: '7' }, querySelector: () => null };
  const seasons = () => [{ seasonNumber: 2, episodeCount: 8 }];
  await internal.backfillSeasonMetadata(7, { id: 7, jeSpoilerGuard: true, seasons: seasons() });
  assert.equal(lookups, 0);
  // Control: the same data without the marker does look it up.
  await internal.backfillSeasonMetadata(7, { id: 7, seasons: seasons() });
  assert.ok(lookups > 0);
});

test('More Info always asks the server, whose answer depends on the current guards', async t => {
  const calls = [];
  const { internal } = moreInfo(t, { jellyseerrAPI: {
    fetchMovieDetails: async (...args) => { calls.push(args); return { id: 1 }; },
    fetchTvShowDetails: async (...args) => { calls.push(args); return { id: 2 }; },
  } });
  await internal.fetchMediaDetails(1, 'movie');
  await internal.fetchMediaDetails(2, 'tv');
  assert.deepEqual(calls.map(args => args[1]?.skipCache), [true, true]);
});

function spoilerState(t, plugin = async () => ({}), JE = {}) {
  const cleared = [], events = [];
  const h = createHarness({ JE: {
    pluginConfig: { SpoilerBlurEnabled: true },
    core: { api: { plugin, manager: { clearCacheMatching: pattern => cleared.push(pattern) } } },
    ...JE,
  } });
  t.after(() => h.close());
  h.window.addEventListener('je:spoiler-state-changed', () => events.push(true));
  h.load('enhanced/spoilerguard/ids.js');
  h.load('enhanced/spoilerguard/state.js');
  return { ...h, cleared, events, state: h.JE.internals.spoilerGuard };
}

test('a guard change drops every response the server shapes per title', async t => {
  const expected = ['jellyseerr', 'tmdb', 'mdblist-ratings'];
  for (const [name, change] of [
    ['series on', s => s.enableForSeries('AA-BB')], ['series off', s => s.disableForSeries('AA-BB')],
    ['movie on', s => s.enableForMovie('AA-BB', 'Film')], ['movie off', s => s.disableForMovie('AA-BB')],
    ['collection on', s => s.enableForCollection('AA-BB', 'Saga')], ['collection off', s => s.disableForCollection('AA-BB')],
    ['pending on', s => s.enableForTmdb('tv', 42, 'Show')], ['pending off', s => s.disableForTmdb('tv', 42)],
    ['preferences', s => s.setUserPrefs({ HideRatings: false })],
  ]) {
    const h = spoilerState(t);
    await change(h.state);
    assert.deepEqual(h.cleared, expected, name);
    assert.equal(h.events.length, 1, name);
  }
});

test('reading guard state or a failed change leaves those responses alone', async t => {
  const h = spoilerState(t, async (_path, options) => {
    if (options?.method) throw new Error('offline');
    return {};
  });
  await h.state.loadState();
  await assert.rejects(h.state.enableForSeries('AA-BB'));
  assert.deepEqual(h.cleared, []);
  assert.equal(h.events.length, 0);
});

function seerrToggle(t, { plugin = async () => ({ promoted: 'pending' }), data = { id: 42 } } = {}) {
  const opened = [];
  const h = spoilerState(t, plugin, { t: key => key, toast: () => {}, jellyseerrMoreInfo: { open: async (...args) => opened.push(args) } });
  h.load('enhanced/spoilerguard/seerr-toggle.js');
  const button = h.state.buildSeerrToggle(data, 'tv');
  return { ...h, opened, button, settle: () => new Promise(resolve => h.window.setTimeout(resolve, 0)) };
}

test('the Seerr toggle trusts the server over ids that do not match this library', async t => {
  const h = seerrToggle(t, { data: { id: 42, jeSpoilerGuard: true, mediaInfo: { jellyfinMediaId: 'other-server' } } });
  assert.equal(h.button.getAttribute('aria-pressed'), 'true');
});

test('changing the guard from More Info reopens it with what the server now sends', async t => {
  const h = seerrToggle(t);
  assert.equal(h.button.getAttribute('aria-pressed'), 'false');
  h.button.click();
  await h.settle();
  assert.deepEqual(h.opened, [[42, 'tv']]);
});

test('a failed guard change keeps the open modal', async t => {
  const h = seerrToggle(t, { plugin: async (_path, options) => {
    if (options?.method) throw new Error('offline');
    return {};
  } });
  h.button.click();
  await h.settle();
  assert.deepEqual(h.opened, []);
  assert.equal(h.button.disabled, false);
});

function requestRules(t, rules) {
  const h = createHarness({ JE: {
    pluginConfig: { JellyseerrEnabled: true }, t: key => key, session: { getEpoch: () => 0, isCurrent: () => true, onUserChange: () => {} },
    core: { api: { fetch: async () => rules } },
  } });
  t.after(() => h.close());
  h.load('jellyseerr/api.js');
  return h.JE.jellyseerrAPI;
}

test('request override rules see a protected title\'s keywords under their new name', async t => {
  const rule = { id: 1, sonarrServiceId: 0, keywords: 'anime', profileId: 7, rootFolder: '/anime' };
  const api = requestRules(t, [rule]);
  const matched = await api.evaluateOverrideRules({ jeRuleKeywords: [{ name: 'Anime' }] }, 'tv');
  const other = await api.evaluateOverrideRules({ jeRuleKeywords: [{ name: 'Western' }] }, 'tv');
  const plain = await api.evaluateOverrideRules({ keywords: [{ name: 'Anime' }] }, 'tv');
  assert.equal(plain?.profileId, 7);
  assert.equal(matched?.profileId, 7);
  assert.equal(other, null);
});

function releaseDates(t, responses, JE = {}) {
  const listeners = new Map();
  const h = createHarness({
    html: '<div id="info"></div>',
    apiClient: { getItem: async () => ({ Type: 'Movie', ProviderIds: { Tmdb: '42' } }) },
    fetch: async () => jsonResponse(responses.shift()),
    globals: { requestAnimationFrame: fn => { fn(); return 1; } },
    JE: { pluginConfig: { DEFAULT_REGION: 'US' }, t: key => key, helpers: { addCSS: () => {} }, session: { getEpoch: () => 0, isCurrent: () => true, onUserChange: (key, fn) => listeners.set(key, fn) }, internals: {}, ...JE },
  });
  t.after(() => h.close());
  h.load('enhanced/itemdetails/features-release-dates.js');
  return { ...h, api: h.JE.internals.features, container: h.document.getElementById('info'), switchUser: () => { for (const fn of listeners.values()) fn(); } };
}

const dated = () => ({ results: [{ iso_3166_1: 'US', release_dates: [{ type: 3, release_date: '2025-01-05' }] }] });
const chips = h => h.container.querySelectorAll('.je-release-date-cinema').length;
const show = async h => {
  h.container.replaceChildren();
  h.api.displayReleaseDate('movie', h.container);
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
};

test('release chips do not outlive the guard they were fetched under', async t => {
  const h = releaseDates(t, [dated(), { results: [] }]);
  await show(h);
  assert.equal(chips(h), 1);
  h.window.dispatchEvent(new h.window.CustomEvent('je:spoiler-state-changed'));
  await show(h);
  assert.equal(chips(h), 0);
});

test('release chips do not carry over to another user, whose guards can differ', async t => {
  const h = releaseDates(t, [dated(), { results: [] }]);
  await show(h);
  assert.equal(chips(h), 1);
  h.switchUser();
  await show(h);
  assert.equal(chips(h), 0);
});

test('a movie on the list is in scope without asking the server', async t => {
  let calls = 0;
  const h = spoilerState(t, async path => {
    if (path.includes('in-scope')) calls++;
    return { Movies: { ccdd: {} }, Collections: { eeff: {} } };
  });
  await h.state.loadState();
  assert.equal(await h.state.isMovieInScope('CC-DD'), true);
  assert.equal(calls, 0);
});

test('with no guarded collections nothing can be in scope that way, so nothing is asked', async t => {
  let calls = 0;
  const h = spoilerState(t, async path => {
    if (path.includes('in-scope')) calls++;
    return {};
  });
  await h.state.loadState();
  assert.equal(await h.state.isMovieInScope('CC-DD'), false);
  assert.equal(calls, 0);
});

test('a movie only in a guarded collection is in scope on the server\'s word', async t => {
  const paths = [];
  const h = spoilerState(t, async path => {
    paths.push(path);
    return path.includes('in-scope') ? { inScope: true } : { Collections: { eeff: {} } };
  });
  await h.state.loadState();
  assert.equal(await h.state.isMovieInScope('CC-DD'), true);
  assert.equal(paths.at(-1), '/spoiler-blur/movies/ccdd/in-scope');
  // A read, so it must not look like a guard change.
  assert.deepEqual(h.cleared, []);
});

test('a failed collection lookup rejects, so Reviews falls to its fail-closed path', async t => {
  const h = spoilerState(t, async path => {
    if (path.includes('in-scope')) throw new Error('offline');
    return { Collections: { eeff: {} } };
  });
  await h.state.loadState();
  await assert.rejects(h.state.isMovieInScope('CC-DD'));
});
