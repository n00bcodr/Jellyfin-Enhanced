// Seerr core group (TypeScript rewrite): runtime validation, request identity,
// uncertain outcomes, lifecycle and facade compatibility, exercised through the
// emitted production scripts. SEERR-CORE-* ids refer to docs/rewrite/seerr-core.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, deferred, plain } from '../helpers/harness.mjs';

const flush = () => new Promise(resolve => setImmediate(resolve));
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function setup(t, { get = async () => ({}), post = async () => ({ id: 7 }), config = {}, files = [], JE = {} } = {}) {
  const calls = [], gets = [], events = [], toasts = [];
  let epoch = 0;
  const resets = new Map();
  const h = createHarness({ JE: {
    pluginConfig: config, t: (key, args) => key + (args ? JSON.stringify(args) : ''), escapeHtml,
    toast: (...args) => toasts.push(args), helpers: { trackUsage() {} },
    session: { getEpoch: () => epoch, isCurrent: value => value === epoch, onUserChange: (name, fn) => { resets.set(name, fn); } },
    requestManager: { clearCacheMatching() {} },
    cdn: { url: () => 'https://cdn.test/none.png', selfhst: () => 'https://cdn.test/seerr.svg' },
    core: { api: { fetch: (url, options) => { gets.push(url); return get(url, options); },
      plugin: (url, options) => { calls.push([url, plain(options)]); return post(url, options); } },
      ui: { addTouchTapListener() {}, addDelegatedTouchTapListener() {}, isTvLayout: () => false } },
    ...JE
  } });
  t.after(() => h.close());
  for (const file of ['seerr-status.js', 'api.js', ...files]) h.load(`jellyseerr/${file}`);
  for (const event of ['jellyseerr-media-requested', 'jellyseerr-tv-requested']) h.document.addEventListener(event, e => events.push([event, plain(e.detail)]));
  return { ...h, api: h.JE.jellyseerrAPI, calls, gets, events, toasts,
    switchUser() { epoch++; for (const fn of resets.values()) fn(); } };
}
const UI = ['ui/ui-icons.js', 'ui/ui-popover.js', 'ui/ui-badges.js', 'ui/ui-cards.js', 'ui/ui-buttons.js', 'ui/ui-quota.js', 'ui/ui-results.js'];

test('the status facade keeps every status mapping of the baseline', t => {
  const h = setup(t); const s = h.JE.seerrStatus;
  assert.deepEqual(plain(s.MEDIA), { UNKNOWN: 1, PENDING: 2, PROCESSING: 3, PARTIALLY_AVAILABLE: 4, AVAILABLE: 5, BLOCKED: 6, DELETED: 7 });
  assert.deepEqual(plain(s.REQUEST), { PENDING: 1, APPROVED: 2, DECLINED: 3, FAILED: 4, COMPLETED: 5 });
  assert.deepEqual([undefined, 0, 1, 2, 3, 4, 5, 6, 7].map(s.isRequestable), [true, true, true, false, false, false, false, false, true]);
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7].map(v => s.resolveDisplayStatus(v, true)), ['none', 'pending', 'processing', 'partial', 'available-updating', 'blocked', 'deleted']);
  assert.equal(s.resolveDisplayStatus(3, false), 'requested');
  assert.equal(s.effectiveMediaStatus(5, null), 7);
  assert.equal(s.effectiveMediaStatus(5, 'x', { 1: true }, 2), 7);
  assert.equal(s.effectiveMediaStatus(5, 'x', { 2: true }, 2), 5);
  assert.deepEqual(plain(s.getButtonConfig('processing')), { labelKey: 'jellyseerr_btn_processing', cssClass: 'jellyseerr-button-processing', disabled: true, showSpinner: true, iconKey: '' });
  assert.equal(s.getBadgeConfig('none'), null);
  assert.equal(s.getChipConfig('deleted').cssClass, 'chip-deleted');
  assert.deepEqual(plain(s.getDisplayInfo(2, true)), { labelKey: 'jellyseerr_season_status_processing', cssClass: 'processing' });
});

test('a re-evaluated bundle keeps one API owner and one set of user-change handlers', t => {
  const h = setup(t); const first = h.api;
  h.load('jellyseerr/api.js'); h.load('jellyseerr/seerr-status.js');
  assert.equal(h.JE.jellyseerrAPI, first);
});

test('SEERR-CORE-08: malformed search results are dropped and a malformed page is a failure, not an empty answer', async t => {
  let answer = { page: 1, totalPages: 3, results: [
    { id: 1, mediaType: 'movie', title: 'Kept' }, { id: 2, mediaType: 'person', name: 'Person' },
    { id: 'x', mediaType: 'movie' }, { id: 3, mediaType: 'tv', voteAverage: 'NaN-as-text' }, null
  ] };
  const h = setup(t, { get: async () => answer });
  const page = await h.api.search('q');
  assert.deepEqual(plain(page.results.map(item => item.title)), ['Kept']);
  assert.equal(page.totalPages, 3); assert.equal(page.totalResults, 1);
  answer = { results: 'not a list' };
  h.expectConsoleError(/Search failed/);
  assert.deepEqual(plain(await h.api.search('q', 1, { skipCache: true })), { results: [], totalResults: 0 });
  await assert.rejects(h.api.search('q', 2, { skipCache: true, throwOnError: true }), { name: 'SeerrDecodeError' });
});

test('SEERR-CORE-08: a malformed status, quota or settings answer is not trusted', async t => {
  let status = { active: 'yes', userFound: true };
  const answers = { '/user-status': () => status, '/quota': () => ({ movie: 'unlimited' }), '/settings/partial-requests': () => 'html' };
  const h = setup(t, { get: async url => answers[url.slice(url.indexOf('/jellyseerr') + 11)]() });
  const fallback = await h.api.checkUserStatus();
  assert.equal(fallback.active, false); assert.equal(fallback.reason, 'unreachable');
  assert.equal(await h.api.fetchUserQuota(), null);
  assert.deepEqual(plain(await h.api.fetchRequestSettings()), { partialRequestsEnabled: false, enableSpecialEpisodes: false });
  status = { active: true, userFound: true, canRequestAdvanced: true }; h.switchUser();
  assert.equal((await h.api.checkUserStatus()).active, true);
});

test('only the documented request settings are forwarded, and is4k inside them still requests 4K', async t => {
  const h = setup(t);
  await h.api.requestMedia(42, 'movie', { serverId: 2, userId: 99, seasons: [1], is4k: true, rootFolder: '/m', tags: [1, 'x'] });
  assert.deepEqual(h.calls[0][1].body, { mediaType: 'movie', mediaId: 42, serverId: 2, is4k: true, rootFolder: '/m', tags: [1] });
});

test('an invalid request target or season list is never sent', async t => {
  const h = setup(t);
  await assert.rejects(h.api.requestMedia('abc', 'movie'), { name: 'SeerrRequestNotSent' });
  await assert.rejects(h.api.requestMedia(42, 'person'), { name: 'SeerrRequestNotSent' });
  await assert.rejects(h.api.requestTvSeasons(42, [1, Number.NaN]), { name: 'SeerrRequestNotSent' });
  await assert.rejects(h.api.requestTvSeasons(42, []), { name: 'SeerrRequestNotSent' });
  assert.equal(h.calls.length, 0);
  assert.deepEqual(plain(h.JE.internals.jellyseerrUi.outcomes.map(o => o.kind)), ['not-sent', 'not-sent', 'not-sent', 'not-sent']);
});

test('SEERR-CORE-02: an account change while override rules load cancels the request before it is sent', async t => {
  const rules = deferred();
  const h = setup(t, { get: url => url.endsWith('/overrideRule') ? rules.promise : Promise.resolve({}) });
  const pending = h.api.requestMedia(42, 'movie', {}, false, { originalLanguage: 'ja' });
  await flush(); h.switchUser();
  rules.resolve([{ radarrServiceId: 1, users: '7' }]);
  await assert.rejects(pending, { name: 'SeerrRequestNotSent' });
  assert.equal(h.calls.length, 0); assert.deepEqual(h.events, []);
  assert.deepEqual(plain(h.JE.internals.jellyseerrUi.outcomes.at(-1)), { mediaType: 'movie', tmdbId: 42, is4k: false, kind: 'not-sent', stale: true });
});

test('SEERR-CORE-03: an acknowledged answer for a previous account reaches its caller but not the next account\'s surfaces', async t => {
  const sent = deferred();
  const h = setup(t, { post: () => sent.promise });
  const pending = h.api.requestMedia(42, 'movie');
  await flush(); h.switchUser(); sent.resolve({ id: 9 });
  assert.equal((await pending).id, 9);
  assert.deepEqual(h.events, []);
  assert.equal(h.JE.internals.jellyseerrUi.outcomes.at(-1).stale, true);
  assert.equal(h.JE.internals.jellyseerrUi.outcomes.at(-1).kind, 'acknowledged');
});

test('SEERR-CORE-06: a request lost in transport is reported as unknown, re-enabled for an explicit retry, never retried', async t => {
  const lost = Object.assign(new Error('Mutation outcome is unknown'), { name: 'MutationUncertainError' });
  let fail = true;
  const h = setup(t, { post: async () => { if (fail) throw lost; return { id: 1 }; }, files: UI });
  const button = h.document.createElement('button'); h.document.body.append(button);
  h.JE.jellyseerrUI.configureRequestButton(button, { id: 42, mediaType: 'movie', title: 'Film' }, true, true);
  button.click(); await flush(); await flush();
  assert.equal(h.calls.length, 1); assert.equal(button.disabled, false);
  assert.match(button.textContent, /Request status unknown/);
  assert.equal(h.JE.internals.jellyseerrUi.outcomes.at(-1).kind, 'uncertain');
  fail = false; button.click(); await flush(); await flush();
  assert.equal(h.calls.length, 2); assert.match(button.textContent, /jellyseerr_btn_requested/);
});

test('SEERR-CORE-02: a card request answered after an account change leaves the button idle, not requested or failed', async t => {
  for (const succeed of [true, false]) {
    const sent = deferred();
    const h = setup(t, { post: () => sent.promise, files: UI });
    const button = h.document.createElement('button'); h.document.body.append(button);
    const item = { id: 42, mediaType: 'movie', title: 'Film' };
    h.JE.jellyseerrUI.configureRequestButton(button, item, true, true);
    button.click(); await flush(); h.switchUser();
    if (succeed) sent.resolve({ id: 1 }); else sent.reject({ status: 500, responseJSON: { message: 'old account failure' } });
    await flush(); await flush();
    assert.equal(button.disabled, false); assert.equal(button.textContent.trim(), 'jellyseerr_btn_request');
    assert.equal(item.mediaInfo, undefined, 'the cached result does not record a request for the next account');
  }
});

test('SEERR-CORE-04: a request shown elsewhere marks every matching button of that media type, and ignores malformed ids', async t => {
  const h = setup(t, { files: UI });
  h.document.body.innerHTML = `
    <div class="jellyseerr-card"><div class="jellyseerr-status-badge"></div><button class="jellyseerr-request-button" data-tmdb-id="42" data-media-type="movie">a</button></div>
    <div class="jellyseerr-card"><div class="jellyseerr-status-badge"></div><button class="jellyseerr-request-button" data-tmdb-id="42" data-media-type="tv">b</button></div>
    <div class="jellyseerr-card"><div class="jellyseerr-status-badge"></div><button class="jellyseerr-request-button" data-tmdb-id="42" data-media-type="tv">c</button></div>`;
  h.document.dispatchEvent(new h.window.CustomEvent('jellyseerr-media-requested', { detail: { tmdbId: '42', mediaType: 'tv', is4k: false } }));
  const [movie, tv1, tv2] = h.document.querySelectorAll('.jellyseerr-request-button');
  assert.equal(movie.disabled, false); assert.equal(tv1.disabled, true); assert.equal(tv2.disabled, true);
  assert.equal(h.document.querySelectorAll('.status-requested').length, 2);
  h.document.dispatchEvent(new h.window.CustomEvent('jellyseerr-media-requested', { detail: { tmdbId: '42"],x', mediaType: 'movie' } }));
  assert.equal(movie.disabled, false);
});

test('SEERR-CORE-05: a collection that cannot be loaded is not reported as an empty collection', async t => {
  const h = setup(t, { files: ['ui/ui-icons.js', 'ui/ui-quota.js', 'ui/ui-request-modals.js'] });
  h.JE.jellyseerrModal = { createAdvancedOptionsHTML: () => '', populateAdvancedOptions() {}, create: () => ({ modalElement: h.document.createElement('div'), show() {} }) };
  h.api.fetchCollectionDetails = async () => null;
  await h.JE.jellyseerrUI.showCollectionRequestModal(9, 'Saga');
  assert.equal(h.toasts.at(-1)[0], 'jellyseerr_toast_collection_fetch_failed');
  h.api.fetchCollectionDetails = async () => ({ parts: [] });
  await h.JE.jellyseerrUI.showCollectionRequestModal(9, 'Saga');
  assert.equal(h.toasts.at(-1)[0], 'jellyseerr_toast_no_movies_in_collection');
});

test('a collection batch sends each movie once, reports unknown outcomes apart from failures and stops on an account change', async t => {
  let posts = 0; let switchAfter = Infinity;
  const h = setup(t, { files: ['ui/ui-icons.js', 'ui/ui-quota.js', 'ui/ui-request-modals.js'],
    post: async () => { posts++; if (posts === switchAfter) h.switchUser(); if (posts === 1) throw { status: 409, responseJSON: { message: 'exists' } };
      if (posts === 2) throw Object.assign(new Error('lost'), { name: 'MutationUncertainError' }); return { id: posts }; } });
  h.expectConsoleError(/Failed to request movie/);
  let current;
  h.JE.jellyseerrModal = { createAdvancedOptionsHTML: () => '', populateAdvancedOptions() {}, create(o) {
    const el = h.document.createElement('div'); el.innerHTML = o.bodyHtml; h.document.body.append(el); current = { el, o }; return { modalElement: el, show() {} }; } };
  const parts = [{ id: 1, title: 'One' }, { id: 1, title: 'One again' }, { id: 2, title: 'Two' }, { id: 3, title: 'Three' }];
  h.api.fetchCollectionDetails = async () => ({ parts });
  await h.JE.jellyseerrUI.showCollectionRequestModal(9, 'Saga');
  const button = h.document.createElement('button');
  await current.o.onSave(current.el, button, () => {});
  assert.deepEqual(h.calls.map(call => call[1].body.mediaId), [1, 2, 3]);
  // Definite failures and unknown outcomes are counted apart (the second has an English fallback until translated).
  assert.equal(h.toasts.at(-1)[0], 'jellyseerr_toast_collection_requested 1 of 3 jellyseerr_toast_movies jellyseerr_toast_collection_failed_count{"count":1} jellyseerr_toast_collection_uncertain_count{"count":1}');
  // An account change after the first movie: nothing more is sent and nothing is reported to the next account.
  posts = 10; switchAfter = 11; const before = h.calls.length; const toasts = h.toasts.length;
  await h.JE.jellyseerrUI.showCollectionRequestModal(9, 'Saga');
  await current.o.onSave(current.el, button, () => {});
  assert.equal(h.calls.length, before + 1); assert.equal(h.toasts.length, toasts);
});

test('SEERR-CORE-07: the season modal stops polling and closes once the account changes', async t => {
  const polls = [];
  const h = setup(t, { files: ['ui/ui-icons.js', 'ui/ui-quota.js', 'ui/ui-season-modal.js'] });
  h.window.setInterval = callback => { polls.push(callback); return polls.length; };
  let fetches = 0, closed = 0;
  Object.assign(h.api, { fetchRequestSettings: async () => ({ partialRequestsEnabled: true, enableSpecialEpisodes: false }),
    fetchTvShowDetails: async () => { fetches++; return { seasons: [{ seasonNumber: 1, episodeCount: 2, airDate: '2020-01-01' }], externalIds: { tvdbId: 5 } }; },
    fetchUserQuota: async () => null });
  let current;
  h.JE.jellyseerrModal = { createAdvancedOptionsHTML: () => '', populateAdvancedOptions() {}, create(o) {
    const el = h.document.createElement('div'); el.innerHTML = `<div class="jellyseerr-modal-body">${o.bodyHtml}</div>`; h.document.body.append(el);
    current = { el, o }; return { modalElement: el, show() {}, close() { closed++; } }; } };
  await h.JE.jellyseerrUI.showSeasonSelectionModal(42, 'tv', 'Show');
  assert.equal(fetches, 1);
  h.switchUser(); await polls.at(-1)();
  assert.equal(fetches, 1, 'no refresh is fetched for the next account'); assert.equal(closed, 1);
  // A Request clicked in the stale modal sends nothing.
  current.el.querySelector('.jellyseerr-season-checkbox[data-season-number="1"]').checked = true;
  let closedBySave = 0; await current.o.onSave(current.el, h.document.createElement('button'), () => { closedBySave++; });
  assert.equal(h.calls.length, 0); assert.equal(closedBySave, 1);
});

test('the season modal reports an unknown outcome instead of a failure', async t => {
  const h = setup(t, { files: ['ui/ui-icons.js', 'ui/ui-quota.js', 'ui/ui-season-modal.js'],
    post: async () => { throw Object.assign(new Error('timeout'), { name: 'AbortError' }); } });
  h.window.setInterval = () => 1;
  h.JE.internals.jellyseerrUi.markCardRequested = () => {};
  Object.assign(h.api, { fetchRequestSettings: async () => ({ partialRequestsEnabled: true, enableSpecialEpisodes: false }),
    fetchTvShowDetails: async () => ({ seasons: [{ seasonNumber: 1, episodeCount: 2, airDate: '2020-01-01' }], externalIds: { tvdbId: 5 } }),
    fetchUserQuota: async () => null });
  let current;
  h.JE.jellyseerrModal = { createAdvancedOptionsHTML: () => '', populateAdvancedOptions() {}, create(o) {
    const el = h.document.createElement('div'); el.innerHTML = `<div class="jellyseerr-modal-body">${o.bodyHtml}</div>`; h.document.body.append(el);
    current = { el, o }; return { modalElement: el, show() {} }; } };
  await h.JE.jellyseerrUI.showSeasonSelectionModal(42, 'tv', 'Show');
  current.el.querySelector('.jellyseerr-season-checkbox[data-season-number="1"]').checked = true;
  const requestBtn = h.document.createElement('button');
  await current.o.onSave(current.el, requestBtn, () => {});
  assert.equal(h.calls.length, 1); assert.equal(requestBtn.disabled, false);
  assert.match(h.toasts.at(-1)[0], /Request status unknown/);
});

test('SEERR-CORE-08: a malformed result builds no card instead of a broken one', async t => {
  const h = setup(t, { files: ['ui/ui-icons.js', 'ui/ui-badges.js', 'ui/ui-cards.js', 'ui/ui-buttons.js'] });
  const ui = h.JE.jellyseerrUI;
  assert.equal(ui.createJellyseerrCard({ id: '1', mediaType: 'movie' }, true, true), null);
  assert.equal(ui.createJellyseerrCard({ id: 1, mediaType: 'movie', voteAverage: '7' }, true, true), null);
  assert.equal(typeof ui.cardInputsKey([{ id: 1, mediaType: 'movie' }, 'junk']), 'string');
  assert.equal(ui.isInLibrary({ nonsense: true }), false);
});

test('SEERR-CORE-14: an upstream media type cannot leave its attribute in the card overview', async t => {
  const h = setup(t, { files: ['ui/ui-icons.js', 'ui/ui-badges.js', 'ui/ui-cards.js', 'ui/ui-buttons.js'] });
  const card = h.JE.jellyseerrUI.createJellyseerrCard({ id: 5, mediaType: 'x" onclick="evil()', title: 'T' }, true, true);
  const container = h.document.createElement('div'); container.append(card); h.document.body.append(container);
  card.querySelector('.cardScalable').dispatchEvent(new h.window.MouseEvent('mouseover', { bubbles: true }));
  card.querySelector('.cardScalable').dispatchEvent(new h.window.MouseEvent('mouseenter'));
  assert.ok(card.querySelector('.jellyseerr-overview'));
  assert.equal(card.querySelector('[onclick]'), null);
});

test('a reconfigured button keeps one hover listener set, showing its current downloads', async t => {
  const h = setup(t, { files: UI, JE: { core: { api: { fetch: async () => ({}), plugin: async () => ({}) }, ui: { addTouchTapListener() {} } } } });
  const button = h.document.createElement('button'); h.document.body.append(button);
  const item = title => ({ id: 1, mediaType: 'movie', mediaInfo: { status: 3, downloadStatus: [{ title, size: 100, sizeLeft: 50, status: 'downloading' }] } });
  h.JE.jellyseerrUI.configureRequestButton(button, item('Old'), true, true);
  h.JE.jellyseerrUI.configureRequestButton(button, item('New'), true, true);
  let fills = 0; const fill = h.JE.internals.jellyseerrUi.fillHoverPopover;
  h.JE.internals.jellyseerrUi.fillHoverPopover = value => { fills++; return fill(value); };
  button.dispatchEvent(new h.window.MouseEvent('mouseenter'));
  const popover = h.document.querySelector('.jellyseerr-hover-popover');
  assert.match(popover.textContent, /New/); assert.doesNotMatch(popover.textContent, /Old/);
  // A warning without size data shows 0%, never "NaN%".
  h.JE.jellyseerrUI.configureRequestButton(button, { id: 1, mediaType: 'movie', mediaInfo: { status: 3, downloadStatus: [{ title: 'W', status: 'warning' }] } }, true, true);
  button.dispatchEvent(new h.window.MouseEvent('mouseenter'));
  assert.doesNotMatch(popover.innerHTML, /NaN/);
  // Reconfigured without downloads: the old item's downloads are no longer shown.
  h.JE.jellyseerrUI.configureRequestButton(button, { id: 1, mediaType: 'movie', mediaInfo: { status: 3 } }, true, true);
  popover.innerHTML = ''; button.dispatchEvent(new h.window.MouseEvent('mouseenter'));
  assert.equal(popover.innerHTML, '');
});

function searchPage(t, status) {
  const h = setup(t, { config: { JellyseerrEnabled: true }, files: [...UI, 'ui/ui-styles.js', 'jellyseerr.js'],
    get: async url => url.endsWith('/user-status') ? status() : {},
    JE: { helpers: { onBodyMutation() {}, onNavigate() {}, trackUsage() {} } } });
  h.document.body.innerHTML = '<div id="searchPage"><div class="searchFields"><div class="inputContainer"><input id="searchTextInput"></div></div><div class="searchResults"></div></div>';
  return h;
}
const settle = async h => { await new Promise(resolve => h.window.setTimeout(resolve, 5)); for (let i = 0; i < 5; i++) await flush(); };

test('SEERR-CORE-09: initializing the search integration twice adds no second set of listeners', async t => {
  const h = searchPage(t, () => ({ active: true, userFound: true }));
  let adds = 0; const add = h.document.addEventListener.bind(h.document);
  h.document.addEventListener = (...args) => { adds++; return add(...args); };
  h.JE.initializeJellyseerrScript(); const first = adds;
  h.JE.initializeJellyseerrScript();
  assert.equal(adds, first);
});

test('SEERR-CORE-01: the search integration checks Seerr again for the next account', async t => {
  let status = { active: true, userFound: false };
  const h = searchPage(t, () => status);
  h.JE.initializeJellyseerrScript(); await settle(h);
  const icon = h.document.getElementById('jellyseerr-search-icon');
  assert.ok(icon.classList.contains('is-no-user'));
  status = { active: true, userFound: true }; h.switchUser(); await settle(h);
  assert.ok(icon.classList.contains('is-active'), 'the next account\'s link is shown');
});

test('SEERR-CORE-15: the Seerr-only filter keeps the section\'s refresh button', async t => {
  const h = searchPage(t, () => ({ active: true, userFound: true }));
  h.JE.initializeJellyseerrScript(); await settle(h);
  h.JE.jellyseerrUI.renderJellyseerrResults([{ id: 1, mediaType: 'movie', title: 'Film' }], 'q', false, true, true);
  const icon = h.document.getElementById('jellyseerr-search-icon');
  icon.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  const title = h.document.querySelector('.jellyseerr-section .sectionTitle');
  assert.match(title.textContent, /jellyseerr_results_title/);
  assert.ok(title.querySelector('.jellyseerr-refresh-btn'));
});

test('SEERR-CORE-17: an authentication failure is reported as an account problem, not an unreachable Seerr', async t => {
  const h = setup(t, { get: async () => { throw { status: 401 }; } });
  assert.equal((await h.api.checkUserStatus()).reason, 'no_user');
});

test('SEERR-CORE-18: the last good request settings belong to the account (and server) that read them', async t => {
  let fail = false;
  const h = setup(t, { get: async () => { if (fail) throw { status: 503 }; return { partialRequestsEnabled: true, enableSpecialEpisodes: true }; } });
  assert.equal((await h.api.fetchRequestSettings()).partialRequestsEnabled, true);
  fail = true; assert.equal((await h.api.fetchRequestSettings()).partialRequestsEnabled, true, 'an outage keeps this account\'s answer');
  h.switchUser(); assert.equal((await h.api.fetchRequestSettings()).partialRequestsEnabled, false);
});

test('advanced options from any caller are validated before they reach the selects', async t => {
  const h = setup(t, { files: ['modal.js'], JE: { core: { api: { fetch: async () => ({}), plugin: async () => ({}) }, ui: { isTvLayout: () => false } } } });
  const modal = h.JE.jellyseerrModal;
  const created = modal.create({ title: 'T', subtitle: 'S', bodyHtml: modal.createAdvancedOptionsHTML('movie'), onSave() {} });
  modal.populateAdvancedOptions(created.modalElement, { servers: [{ id: 1, name: 'A', isDefault: true, qualityProfiles: 'bad', rootFolders: [{ path: '/m', freeSpace: 2048 }, { path: 7 }] }, { id: 'x' }] }, 'movie');
  await new Promise(resolve => h.window.setTimeout(resolve, 150));
  const options = id => [...created.modalElement.querySelectorAll(`#${id} option`)].map(o => o.textContent);
  assert.deepEqual(options('movie-server'), ['Select Server...', 'A']);
  assert.deepEqual(options('movie-quality'), ['Select Quality...']);
  assert.deepEqual(options('movie-folder'), ['Select Folder...', '/m (2 KB)']);
  modal.populateAdvancedOptions(created.modalElement, {}, 'movie"],x');
  modal.populateAdvancedOptions(created.modalElement, undefined, 'movie');
});
