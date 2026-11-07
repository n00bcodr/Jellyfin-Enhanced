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
  h.window.CSS = { escape: value => value };
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

test('backfill fills what the server left in and nothing it took out', async t => {
  // Season 1 stayed visible and is missing upstream, so TMDB supplies it. Season 2 is
  // protected, so the same passthrough sends nothing for it.
  const lookup = async () => ({ seasons: [{ season_number: 1, overview: 'First plot' }, { season_number: 2 }] });
  const { internal, document } = moreInfo(t, { pluginConfig: { TmdbEnabled: true }, jellyseerrAPI: { fetchTmdbTvDetails: lookup, fetchTvSeasonDetails: async () => ({}) } });
  const modal = document.createElement('div');
  modal.dataset.tmdbId = '7';
  modal.innerHTML = [1, 2].map(n => `<div class="season-card" data-season-number="${n}"><div class="season-poster"></div><div class="season-info"></div><div class="season-meta"></div></div>`).join('');
  internal.state.currentModal = modal;
  await internal.backfillSeasonMetadata(7, { id: 7, jeSpoilerGuard: true, seasons: [{ seasonNumber: 1, episodeCount: 7 }, { seasonNumber: 2, episodeCount: 8 }] });
  assert.equal(modal.querySelector('[data-season-number="1"] .season-overview').textContent, 'First plot');
  assert.equal(modal.querySelector('[data-season-number="2"] .season-overview'), null);
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

function seerrToggle(t, { plugin = async () => ({ promoted: 'pending', removed: true }), data = { id: 42 }, translate = key => key } = {}) {
  const opened = [];
  const toasts = [];
  let epoch = 0;
  const session = { getEpoch: () => epoch, isCurrent: e => e === epoch, onUserChange: () => {} };
  const h = spoilerState(t, plugin, { t: translate, toast: text => toasts.push(text), session, jellyseerrMoreInfo: { open: async (...args) => opened.push(args) } });
  h.load('enhanced/spoilerguard/seerr-toggle.js');
  h.state.confirmDisableSpoiler = async () => true;
  const button = h.state.buildSeerrToggle(data, 'tv');
  const modal = h.document.createElement('div');
  modal.className = 'je-more-info-modal';
  modal.appendChild(button);
  h.document.body.appendChild(modal);
  return { ...h, opened, toasts, button, modal, switchUser: () => { epoch++; }, settle: () => new Promise(resolve => h.window.setTimeout(resolve, 0)) };
}

test('the Seerr toggle trusts the server over ids that do not match this library', async t => {
  const h = seerrToggle(t, { data: { id: 42, jeSpoilerGuard: true, mediaInfo: { jellyfinMediaId: 'other-server' } } });
  assert.equal(h.button.getAttribute('aria-pressed'), 'true');
});

test('the Seerr toggle only says pending for a title that has not arrived', async t => {
  const inLibrary = seerrToggle(t, { data: { id: 42, jeSpoilerGuard: true } });
  assert.match(inLibrary.button.textContent, /spoiler_blur_button_on/);
  const waiting = seerrToggle(t, { plugin: async path => (path === '/spoiler-blur/series' ? { PendingTmdb: { 'tv:42': {} } } : {}) });
  await waiting.state.loadState();
  await waiting.settle();
  assert.match(waiting.button.textContent, /spoiler_blur_pending_button_on/);
});

test('changing the guard from More Info reopens it with what the server now sends', async t => {
  const h = seerrToggle(t);
  assert.equal(h.button.getAttribute('aria-pressed'), 'false');
  h.button.click();
  await h.settle();
  assert.deepEqual(h.opened, [[42, 'tv']]);
});

test('the toast only promises a later arrival for a title that has not arrived', async t => {
  const waiting = seerrToggle(t);
  waiting.button.click();
  await waiting.settle();
  assert.deepEqual(waiting.toasts, ['spoiler_blur_pending_enabled_toast']);
  const inLibrary = seerrToggle(t, { plugin: async () => ({ promoted: 'series', jellyfinId: 'AA-BB' }) });
  inLibrary.button.click();
  await inLibrary.settle();
  assert.deepEqual(inLibrary.toasts, ['spoiler_blur_enabled_toast']);
});

test('a title guarded through a collection shows a status, not a switch that does nothing', async t => {
  const h = seerrToggle(t, { data: { id: 42, jeSpoilerGuard: true, jeSpoilerGuardInherited: true } });
  assert.equal(h.button.getAttribute('aria-pressed'), 'true');
  assert.equal(h.button.disabled, true);
  // This locale doesn't have the hint yet, so it must not show the raw key.
  assert.equal(h.button.title, 'spoiler_blur_button_on');
  h.button.click();
  await h.settle();
  assert.deepEqual(h.opened, []);
  assert.deepEqual(h.toasts, []);
});

test('a locale that has the collection hint shows it', async t => {
  const translate = key => (key === 'spoiler_blur_inherited_hint' ? 'Protected through a collection.' : key);
  const h = seerrToggle(t, { data: { id: 42, jeSpoilerGuard: true, jeSpoilerGuardInherited: true }, translate });
  assert.equal(h.button.title, 'Protected through a collection.');
});

test('a disable the server could not carry out is not reported as done', async t => {
  const h = seerrToggle(t, { data: { id: 42, jeSpoilerGuard: true }, plugin: async (_path, options) => (options?.method ? { success: true, removed: false } : {}) });
  h.button.click();
  await h.settle();
  assert.deepEqual(h.toasts, ['spoiler_blur_pending_error_toast']);
  assert.deepEqual(h.opened, []);
});

test('a guard change that lands after the modal is gone does not bring it back', async t => {
  for (const leave of [h => h.modal.remove(), h => { h.modal._isClosing = true; }, h => h.switchUser()]) {
    let finish;
    const h = seerrToggle(t, { plugin: () => new Promise(resolve => { finish = resolve; }) });
    h.button.click();
    leave(h);
    finish({ promoted: 'pending' });
    await h.settle();
    assert.deepEqual(h.opened, []);
  }
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

test('a release lookup from before a guard change neither draws nor caches its dates', async t => {
  let release;
  const h = releaseDates(t, []);
  h.window.fetch = async () => jsonResponse(await new Promise(resolve => { release = resolve; }));
  h.container.replaceChildren();
  h.api.displayReleaseDate('movie', h.container);
  await new Promise(resolve => setImmediate(resolve));
  h.window.dispatchEvent(new h.window.CustomEvent('je:spoiler-state-changed'));
  release(dated());
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.container.querySelectorAll('.mediaInfoItem-releaseDate').length, 0);
  // Nothing was cached, so the next visit asks again.
  let asked = 0;
  h.window.fetch = async () => { asked++; return jsonResponse({ results: [] }); };
  await show(h);
  assert.equal(asked, 1);
});

test('a guard change takes the chips already on the page with it', async t => {
  const h = releaseDates(t, [dated()]);
  await show(h);
  assert.equal(chips(h), 1);
  h.window.dispatchEvent(new h.window.CustomEvent('je:spoiler-state-changed'));
  assert.equal(chips(h), 0);
});

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

function responseCache(t) {
  const h = createHarness({ JE: { core: { navigation: { onNavigate: () => {} } } } });
  t.after(() => h.close());
  h.load('core/api-client.js');
  return h.JE.core.api.manager;
}

test('a response requested before a clear cannot write the old answer back', t => {
  const cache = responseCache(t);
  const requestedAt = cache.cacheStamp();
  cache.clearCacheMatching('jellyseerr');
  cache.setCache('jellyseerr:/movie/1', { overview: 'old' }, requestedAt);
  assert.equal(cache.getCached('jellyseerr:/movie/1'), null);
  // Another key, or a request from after the clear, stores as usual.
  cache.setCache('mdblist-ratings:/movie/1', { Found: true }, requestedAt);
  assert.ok(cache.getCached('mdblist-ratings:/movie/1'));
  cache.setCache('jellyseerr:/movie/2', { overview: 'new' }, cache.cacheStamp());
  assert.ok(cache.getCached('jellyseerr:/movie/2'));
  // So do callers that don't say when they asked.
  cache.setCache('jellyseerr:/movie/3', { overview: 'plain' });
  assert.ok(cache.getCached('jellyseerr:/movie/3'));
});

test('a clear that scrolled out of its history still stops an older response', t => {
  const cache = responseCache(t);
  const requestedAt = cache.cacheStamp();
  cache.clearCacheMatching('jellyseerr');
  // MDBList clears by key, so a burst of titles can push the clear above out of the record.
  for (let i = 0; i < 40; i++) cache.clearCacheMatching(`mdblist-ratings:/movie/${i}`);
  cache.setCache('jellyseerr:/movie/1', { overview: 'old' }, requestedAt);
  assert.equal(cache.getCached('jellyseerr:/movie/1'), null);
  cache.setCache('jellyseerr:/movie/2', { overview: 'new' }, cache.cacheStamp());
  assert.ok(cache.getCached('jellyseerr:/movie/2'));
});

function itemCache(t, getItem) {
  const h = createHarness({ JE: {
    pluginConfig: {}, session: { onUserChange: () => {} },
    core: { navigation: {}, dom: {}, ui: { escapeHtml: value => value } },
  }, apiClient: { getItem } });
  t.after(() => h.close());
  h.load('enhanced/helpers.js');
  return h;
}

test('an item fetched before a guard change cannot refill the cache afterwards', async t => {
  const pending = [];
  const h = itemCache(t, () => new Promise(resolve => pending.push(resolve)));
  const first = h.JE.helpers.getItemCached('one');
  h.window.dispatchEvent(new h.window.CustomEvent('je:spoiler-state-changed'));
  pending[0]({ Id: 'one', PremiereDate: '2019-01-01' });
  await first;
  const second = h.JE.helpers.getItemCached('one');
  assert.equal(pending.length, 2);
  pending[1]({ Id: 'one' });
  assert.equal((await second).PremiereDate, undefined);
});

test('Top Rated keeps a protected title where its hidden score puts it', async t => {
  const h = createHarness({ html: '<main id="detail"></main>' });
  t.after(() => h.close());
  h.JE.jellyseerrUI = { createJellyseerrCard(item) {
    const card = h.document.createElement('div');
    card.className = 'card';
    card.dataset.id = String(item.id);
    return card;
  } };
  h.load('jellyseerr/discovery/discovery-filter-utils.js');
  h.JE.discoveryFilter.waitForPageReady = async () => h.document.querySelector('#detail');
  h.JE.discoveryFilter.setupInfiniteScroll = () => {};
  h.JE.discoveryFilter.cleanupScrollObserver = () => {};
  h.JE.discoveryFilter.getSortMode = () => 'vote_average.desc';
  h.load('jellyseerr/discovery/discovery-base.js');
  const controller = h.JE.discoveryBase.createDiscovery({
    key: 'person', mode: 'client-paged', logLabel: 'Person Discovery',
    configKey: 'JellyseerrShowPersonDiscovery', pageSize: 3,
    getIdFromUrl: () => 'person-1',
    // 2 is protected: its score is gone, and a higher hidden one is what ranks it.
    resolveItems: async () => ({ title: 'Person', items: [
      { id: 1, mediaType: 'movie', voteAverage: 6 },
      { id: 2, mediaType: 'movie', jeSortRating: 9 },
      { id: 3, mediaType: 'movie', voteAverage: 7 },
    ] }),
  });
  await controller.render();
  assert.deepEqual([...h.document.querySelectorAll('.card')].map(card => Number(card.dataset.id)), [2, 3, 1]);
  controller.cleanup();
});

