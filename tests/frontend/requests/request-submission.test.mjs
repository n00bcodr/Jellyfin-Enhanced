import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, deferred, plain } from '../helpers/harness.mjs';

function setup(t, { get = async () => ({}), post = async () => ({ id: 7 }), config = {} } = {}) {
  const calls = [], invalidated = [], usage = [], events = [], toasts = [];
  let epoch = 0, onChange;
  const h = createHarness({ JE: {
    pluginConfig: config, t: (key, args) => key + (args ? JSON.stringify(args) : ''),
    escapeHtml: value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),
    toast: (...args) => toasts.push(args), helpers: { trackUsage: key => usage.push(key) },
    session: { getEpoch: () => epoch, isCurrent: value => value === epoch, onUserChange: (_, fn) => { onChange = fn; } },
    requestManager: { clearCacheMatching: key => invalidated.push(key) },
    core: { api: { fetch: (url, options) => get(url, options), plugin: (url, options) => { calls.push([url, plain(options)]); return post(url, options); } } }
  }});
  t.after(() => h.close());
  h.load('jellyseerr/api.js');
  for (const event of ['jellyseerr-media-requested', 'jellyseerr-tv-requested']) h.document.addEventListener(event, e => events.push([event, plain(e.detail)]));
  return { ...h, api: h.JE.jellyseerrAPI, calls, invalidated, usage, events, toasts, switchUser() { epoch++; onChange(); } };
}

for (const type of ['movie', 'tv']) test(`${type} request sends explicit settings without retry and broadcasts success`, async t => {
  const h = setup(t);
  const result = await h.api.requestMedia('42', type, { serverId: 2, profileId: 5 }, true, null, 88);
  assert.equal(result.id, 7);
  assert.deepEqual(h.calls, [['/jellyseerr/request', { method: 'POST', skipRetry: true, body: {
    mediaType: type, mediaId: 42, serverId: 2, profileId: 5, ...(type === 'tv' ? { seasons: 'all', tvdbId: 88 } : {}), is4k: true
  }}]]);
  assert.ok(h.invalidated.includes(`jellyseerr:/${type}/42`));
  assert.ok(h.invalidated.includes('jellyseerr:/quota'));
  assert.equal(h.events.length, type === 'tv' ? 2 : 1);
  assert.deepEqual(h.events[0][1], { tmdbId: '42', mediaType: type, is4k: true });
  assert.deepEqual(h.usage, ['seerr.request_submitted']);
});

test('selected seasons and manual TVDB match survive override-rule evaluation', async t => {
  const h = setup(t, { get: async () => [{ sonarrServiceId: 9, language: 'ja', profileId: 3, rootFolder: '/anime' }] });
  await h.api.requestTvSeasons('42', [0, 2], {}, { originalLanguage: 'ja' }, false, 777);
  assert.deepEqual(h.calls[0][1].body, { mediaType: 'tv', mediaId: 42, seasons: [0, 2], serverId: 9, profileId: 3, rootFolder: '/anime', tvdbId: 777 });
});

for (const status of [403, 404, 429, 503]) test(`request ${status} fails without success side effects or retry`, async t => {
  const failure = Object.assign(new Error('rejected'), { status });
  const h = setup(t, { post: async () => { throw failure; } });
  await assert.rejects(h.api.requestTvSeasons(42, [1]), error => error === failure);
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.events, []); assert.deepEqual(h.invalidated, []); assert.deepEqual(h.usage, []);
});

test('watchlist failure does not turn an accepted request into a retryable failure', async t => {
  const h = setup(t); h.api.addToWatchlist = async () => { throw new Error('unavailable'); };
  assert.equal((await h.api.requestMedia(42, 'movie')).id, 7);
  assert.equal(h.calls.length, 1); assert.equal(h.events.length, 1);
});

test('advanced options require both administrator setting and current user permission', async t => {
  let status = { active: true, userFound: true, canRequestAdvanced: true };
  const h = setup(t, { config: { JellyseerrShowAdvanced: true }, get: async () => status });
  assert.equal(h.api.shouldShowAdvanced(), false);
  await h.api.checkUserStatus(); assert.equal(h.api.shouldShowAdvanced(), true);
  h.JE.pluginConfig.JellyseerrShowAdvanced = false; assert.equal(h.api.shouldShowAdvanced(), false);
  h.JE.pluginConfig.JellyseerrShowAdvanced = true;
  status = { active: true, userFound: true, canRequestAdvanced: false }; h.switchUser();
  assert.equal(h.api.shouldShowAdvanced(), false);
  await h.api.checkUserStatus(); assert.equal(h.api.shouldShowAdvanced(), false);
});

test('late status response from previous user cannot grant advanced options to next user', async t => {
  const pending = deferred(); let reads = 0;
  const h = setup(t, { config: { JellyseerrShowAdvanced: true }, get: () => ++reads === 1 ? pending.promise : Promise.resolve({ active: true, userFound: true, canRequestAdvanced: false }) });
  const first = h.api.checkUserStatus(); h.switchUser();
  pending.resolve({ active: true, userFound: true, canRequestAdvanced: true }); await first;
  assert.equal(h.api.shouldShowAdvanced(), false);
  await h.api.checkUserStatus(); assert.equal(reads, 2); assert.equal(h.api.shouldShowAdvanced(), false);
});

test('late status failure from previous user is neither cached nor shown to next user', async t => {
  const pending = deferred(); let reads = 0;
  const h = setup(t, { get: () => ++reads === 1 ? pending.promise : Promise.resolve({ active: true, userFound: true }) });
  const first = h.api.checkUserStatus(); h.switchUser();
  pending.reject({ responseJSON: { code: 'blocked' } });
  assert.equal((await first).reason, 'blocked');
  assert.equal(h.toasts.length, 0);
  assert.equal((await h.api.checkUserStatus()).active, true); assert.equal(reads, 2);
});

test('status banners escape upstream HTML and reset on user switch', t => {
  const h = setup(t); const status = { reason: 'blocked', message: '<img src=x onerror=evil()>' };
  h.api.surfaceUserStatusBanner(status); h.api.surfaceUserStatusBanner(status);
  assert.equal(h.toasts.length, 1); assert.ok(h.toasts[0][0].includes('&lt;img')); assert.ok(!h.toasts[0][0].includes('<img'));
  h.switchUser(); h.api.surfaceUserStatusBanner(status); assert.equal(h.toasts.length, 2);
});

function uiSetup(t, options) {
  const h = setup(t, options);
  for (const file of ['seerr-status.js', 'ui/ui-icons.js', 'ui/ui-quota.js', 'ui/ui-buttons.js']) h.load(`jellyseerr/${file}`);
  h.button = h.document.createElement('button'); h.document.body.append(h.button);
  h.item = { id: 42, mediaType: 'movie', title: 'Film' };
  h.configure = (active = true, user = true) => h.JE.jellyseerrUI.configureRequestButton(h.button, h.item, active, user);
  return h;
}
const flush = () => new Promise(resolve => setImmediate(resolve));
for (const [active, linked] of [[false, true], [true, false]]) test(`request button blocks offline/unlinked state ${active}/${linked}`, async t => {
  const h = uiSetup(t); h.configure(active, linked); h.button.click(); await flush();
  assert.equal(h.button.disabled, true); assert.equal(h.calls.length, 0);
});

// split: the 4K-enabled split button's main half has its own copy of the request handler.
const mainButton = (h, split) => split ? h.document.querySelector('.jellyseerr-split-main') : h.button;
for (const split of [false, true]) test(`rapid repeated clicks submit one movie request and update status on success (split=${split})`, async t => {
  const pending = deferred(); const h = uiSetup(t, { config: { JellyseerrEnable4KRequests: split }, post: () => pending.promise }); h.configure();
  const button = mainButton(h, split);
  button.click(); button.click(); assert.equal(button.disabled, true); await flush(); assert.equal(h.calls.length, 1);
  // The standard half requests this movie in standard quality: no is4k flag.
  assert.deepEqual(h.calls[0][1].body, { mediaType: 'movie', mediaId: 42 });
  pending.resolve({ id: 7 }); await flush();
  assert.equal(h.item.mediaInfo.status, 3); assert.equal(button.disabled, true);
  assert.ok(button.classList.contains('jellyseerr-button-pending')); assert.ok(button.textContent.includes('jellyseerr_btn_requested'));
});

for (const split of [false, true]) test(`request failure escapes message and permits explicit retry (split=${split})`, async t => {
  let tries = 0;
  const h = uiSetup(t, { config: { JellyseerrEnable4KRequests: split }, post: async () => { if (++tries === 1) throw { status: 500, responseJSON: { message: '<img src=x onerror=evil()>' } }; return { id: 7 }; } });
  h.configure(); const button = split ? h.document.querySelector('.jellyseerr-split-main') : h.button;
  button.click(); await flush(); assert.equal(button.disabled, false); assert.equal(button.querySelector('img'), null); assert.ok(button.textContent.includes('<img'));
  button.click(); await flush(); assert.equal(h.calls.length, 2); assert.equal(button.disabled, true);
});

for (const split of [false, true]) test(`quota rejection shows escaped dialog and restores request button (split=${split})`, async t => {
  const h = uiSetup(t, { config: { JellyseerrEnable4KRequests: split }, post: async () => { throw { status: 403, responseJSON: { message: 'Movie Quota exceeded. <img src=x>' } }; }, get: async () => ({ movie: { limit: 2, used: 2, restricted: true } }) });
  const dialogs = []; h.window.Dashboard = { alert: data => dialogs.push(data) }; h.configure();
  const button = mainButton(h, split); button.click(); await flush();
  assert.equal(dialogs.length, 1); assert.ok(dialogs[0].message.includes('&lt;img')); assert.equal(button.disabled, false); assert.equal(h.events.length, 0);
  // Back to the idle label exactly (not the in-flight "requesting" one) with no spinner.
  assert.equal(button.textContent.trim(), 'jellyseerr_btn_request'); assert.equal(button.querySelector('.jellyseerr-button-spinner'), null);
  assert.equal(button.classList.contains('jellyseerr-button-error'), false);
});

test('quota detection distinguishes permission errors and honors feature toggle', t => {
  const h = uiSetup(t); const ui = h.JE.jellyseerrUI;
  assert.equal(ui.isQuotaError({ status: 403, responseJSON: { message: 'TV Quota exceeded.' } }), true);
  assert.equal(ui.isQuotaError({ status: 403, responseJSON: { message: 'Forbidden' } }), false);
  assert.equal(ui.isQuotaError({ status: 500, responseJSON: { message: 'Quota exceeded' } }), false);
  h.JE.pluginConfig.JellyseerrShowQuotaInfo = false;
  assert.equal(ui.isQuotaError({ status: 403, responseJSON: { message: 'Quota exceeded' } }), false);
});

test('reconfiguring a request button does not duplicate submission handlers', async t => {
  const h = uiSetup(t); h.configure(); h.configure(); h.button.click(); await flush();
  assert.equal(h.calls.length, 1);
});

test('reconfigured button submits the new media rather than stale item data', async t => {
  const h = uiSetup(t); h.configure(); h.item = { id: 99, title: 'New film', mediaType: 'movie' }; h.configure();
  h.button.click(); await flush(); assert.equal(h.calls.length, 1); assert.equal(h.calls[0][1].body.mediaId, 99);
});

test('a results refresh updates only its own section and matches the media type as well as the exact id', async t => {
  const h = uiSetup(t, { config: { JellyseerrEnable4KRequests: true } });
  h.JE.core.ui = { addTouchTapListener() {} }; h.load('jellyseerr/ui/ui-results.js');
  // A retained overview elsewhere on the page keeps its own 4K split button for movie 42.
  h.button.dataset.tmdbId = '42'; h.button.dataset.mediaType = 'movie'; h.configure();
  const overviewMain = h.document.querySelector('.jellyseerr-split-main');
  // The refreshed section holds a show and a movie that share TMDB id 42, and a
  // second movie whose id 420 starts with the same digits.
  const section = h.document.createElement('div'); h.document.body.append(section);
  const sectionButton = item => {
    const button = h.document.createElement('button'); button.className = 'jellyseerr-request-button';
    Object.assign(button.dataset, { tmdbId: String(item.id), mediaType: item.mediaType, searchResultItem: JSON.stringify(item) });
    section.append(button); return button;
  };
  const show = { id: 42, mediaType: 'tv', name: 'Show', mediaInfo: { status: 1 } };
  const showButton = sectionButton(show);
  sectionButton({ id: 42, mediaType: 'movie', title: 'Film', mediaInfo: { status: 1 } });
  sectionButton({ id: 420, mediaType: 'movie', title: 'Other film', mediaInfo: { status: 2 } });
  // Movie 42 became available and movie 420 requestable again. Movie 42 comes first, so an
  // id-only match would hand it to the show, and a type-only or prefix match to movie 420.
  h.JE.jellyseerrUI.updateJellyseerrResults([{ id: 42, mediaType: 'movie', title: 'Film', mediaInfo: { status: 5 } }, show,
    { id: 420, mediaType: 'movie', title: 'Other film', mediaInfo: { status: 1 } }], true, true, section);
  assert.ok(showButton.isConnected); assert.equal(JSON.parse(showButton.dataset.searchResultItem).mediaType, 'tv');
  const sectionMain = section.querySelector('.jellyseerr-split-main[data-tmdb-id="42"]');
  assert.equal(sectionMain.disabled, true); assert.equal(JSON.parse(sectionMain.dataset.searchResultItem).mediaInfo.status, 5);
  const otherMain = section.querySelector('.jellyseerr-split-main[data-tmdb-id="420"]');
  assert.equal(otherMain.disabled, false); assert.equal(JSON.parse(otherMain.dataset.searchResultItem).mediaInfo.status, 1);
  // The overview outside the section keeps its split styling and its own request handler.
  assert.ok(overviewMain.classList.contains('jellyseerr-split-main'));
  overviewMain.click(); await flush(); otherMain.click(); await flush();
  assert.deepEqual(h.calls.map(call => call[1].body), [{ mediaType: 'movie', mediaId: 42 }, { mediaType: 'movie', mediaId: 420 }]);
});

for (const split of [false, true]) test(`advanced-permission UI opens options without prematurely submitting (split=${split})`, async t => {
  const h = uiSetup(t, { config: { JellyseerrShowAdvanced: true, JellyseerrEnable4KRequests: split }, get: async () => ({ active: true, userFound: true, canRequestAdvanced: true }) });
  await h.api.checkUserStatus(); const opened = []; h.JE.jellyseerrUI.showMovieRequestModal = (...args) => opened.push(args);
  h.configure(); mainButton(h, split).click(); await flush(); assert.equal(h.calls.length, 0); assert.equal(opened.length, 1); assert.equal(opened[0][0], 42);
  // The standard half opens the standard-quality options, never the 4K ones.
  assert.equal(opened[0][3], false);
});

for (const split of [false, true]) for (const code of ['no_request_permission', 'request_4k_forbidden']) test(`typed permission denial ${code} is shown without success state (split=${split})`, async t => {
  const h = uiSetup(t, { config: { JellyseerrEnable4KRequests: split }, post: async () => { throw { status: 403, responseJSON: { code } }; } });
  h.configure(); const button = mainButton(h, split); button.click(); await flush();
  assert.ok(button.textContent.includes(`jellyseerr_err_${code}`)); assert.equal(h.events.length, 0); assert.equal(h.item.mediaInfo, undefined);
});

test('quota chips hide unlimited quotas and distinguish warning from restriction', t => {
  const h = uiSetup(t); const ui = h.JE.jellyseerrUI;
  assert.equal(ui.buildQuotaChip({ movie: { limit: 0, used: 500 } }, 'movie'), null);
  const warning = ui.buildQuotaChip({ movie: { limit: 4, remaining: 1, used: 3 } }, 'movie');
  assert.ok(warning.classList.contains('jellyseerr-quota-chip-warning'));
  const blocked = ui.buildQuotaChip({ tv: { limit: 2, remaining: 0, used: 2, restricted: true } }, 'tv');
  assert.ok(blocked.classList.contains('jellyseerr-quota-chip-restricted')); assert.ok(blocked.textContent.includes('restricted_hint'));
});

test('disabled quota feature makes no network request', async t => {
  let gets = 0;
  const h = setup(t, { config: { JellyseerrShowQuotaInfo: false }, get: async () => { gets++; return { movie: { limit: 1 } }; } });
  assert.equal(await h.api.fetchUserQuota(), null);
  assert.equal(gets, 0);
  // Control: the same setup fetches once the feature is on.
  h.JE.pluginConfig.JellyseerrShowQuotaInfo = true;
  assert.deepEqual(plain(await h.api.fetchUserQuota()), { movie: { limit: 1 } });
  assert.equal(gets, 1);
});

for (const split of [false, true]) for (const succeeds of [true, false]) test(`late request ${succeeds ? 'success' : 'failure'} cannot overwrite a refreshed offline button (split=${split})`, async t => {
  const pending = deferred(); const h = uiSetup(t, { config: { JellyseerrEnable4KRequests: split }, post: () => pending.promise }); h.configure();
  if (split) h.button = h.document.querySelector('.jellyseerr-split-main');
  h.button.click(); await flush(); h.configure(false, true);
  const offlineLabel = h.button.textContent;
  if (succeeds) pending.resolve({ id: 7 }); else pending.reject({ status: 500, responseJSON: { message: 'old failure' } });
  await flush(); assert.equal(h.button.disabled, true); assert.equal(h.button.textContent, offlineLabel);
});

// Already requested, partial, available and blocked media show a disabled button that cannot submit;
// a deleted one (status 7) can be requested again.
for (const split of [false, true]) for (const [label, status, disabled] of [['pending', 2, true], ['requested', 3, true], ['partial', 4, true], ['available', 5, true], ['blocked', 6, true], ['deleted', 7, false]]) {
  test(`movie ${label} status ${disabled ? 'renders a disabled button that cannot submit' : 'stays requestable'} (split=${split})`, async t => {
    const h = uiSetup(t, { config: { JellyseerrEnable4KRequests: split } }); h.item.mediaInfo = { status }; h.configure();
    const button = mainButton(h, split); button.click(); await flush();
    assert.equal(button.disabled, true); assert.equal(h.calls.length, disabled ? 0 : 1);
    if (disabled) assert.equal(button.classList.contains('jellyseerr-button-request'), false);
  });
}
for (const [label, status] of [['available', 5], ['blocked', 6]]) test(`tv ${label} status renders a disabled button`, t => {
  const h = uiSetup(t); h.item = { id: 42, mediaType: 'tv', name: 'Show', mediaInfo: { status } }; h.configure();
  assert.equal(h.button.disabled, true);
});

/**
 * Opens the real season-selection modal over a stubbed modal shell. `save` clicks Request.
 * @returns {Promise<object>} The harness plus the modal element, its request button and `save`.
 */
async function seasonModal(t, { tvDetails, partial = true, specials = true, post } = {}) {
  const h = setup(t, { post });
  for (const file of ['seerr-status.js', 'ui/ui-icons.js', 'ui/ui-quota.js', 'ui/ui-season-modal.js']) h.load(`jellyseerr/${file}`);
  h.JE.internals.jellyseerrUi.markCardRequested = () => {};
  Object.assign(h.api, { fetchRequestSettings: async () => ({ partialRequestsEnabled: partial, enableSpecialEpisodes: specials }),
    fetchTvShowDetails: async () => tvDetails, fetchSonarrLookup: async () => [], fetchUserQuota: async () => null, fetchTvSeasonDetails: async () => ({}) });
  let modal;
  h.JE.jellyseerrModal = { createAdvancedOptionsHTML: () => '', populateAdvancedOptions() {}, create(o) {
    const el = h.document.createElement('div'); el.innerHTML = `<div class="jellyseerr-modal-body">${o.bodyHtml}</div>`;
    h.document.body.append(el); modal = { el, o }; return { modalElement: el, show() {} }; } };
  await h.JE.jellyseerrUI.showSeasonSelectionModal(42, 'tv', 'Show', null, false);
  const requestBtn = h.document.createElement('button');
  return { ...h, el: modal.el, requestBtn, save: () => modal.o.onSave(modal.el, requestBtn, () => {}) };
}
const seasonCheckbox = (h, number) => h.el.querySelector(`.jellyseerr-season-checkbox[data-season-number="${number}"]`);
const tvSeasons = [{ seasonNumber: 0, name: 'Specials', episodeCount: 2, airDate: '2020-01-01' }, { seasonNumber: 1, name: '<img src=x onerror=evil()>', episodeCount: 3, airDate: '2020-01-01' }, { seasonNumber: 2, episodeCount: 3, airDate: '2021-01-01' }];

test('season modal sends a stored TVDB id with the selected seasons', async t => {
  const h = await seasonModal(t, { tvDetails: { seasons: tvSeasons, externalIds: {}, mediaInfo: { tvdbId: 555, seasons: [] } } });
  assert.equal(h.el.querySelector('#jellyseerr-tvdb-id'), null);
  seasonCheckbox(h, 1).checked = true; await h.save();
  assert.deepEqual(h.calls[0][1].body.seasons, [1]); assert.equal(h.calls[0][1].body.tvdbId, 555);
});

// #653: without a TVDB id Seerr accepts the request, then Sonarr drops it.
for (const partial of [true, false]) test(`season modal requires a TVDB match when TMDB has none and sends it (partial=${partial})`, async t => {
  const h = await seasonModal(t, { partial, tvDetails: { seasons: tvSeasons, externalIds: {}, mediaInfo: { seasons: [] } } });
  if (partial) seasonCheckbox(h, 1).checked = true;
  await h.save();
  assert.equal(h.calls.length, 0); assert.equal(h.toasts.at(-1)[0], 'jellyseerr_modal_toast_tvdb_required'); assert.equal(h.requestBtn.disabled, false);
  // Seerr stores the id in a 32-bit column: a larger one is rejected like a missing one.
  h.el.querySelector('#jellyseerr-tvdb-id').value = '2147483648'; await h.save(); assert.equal(h.calls.length, 0);
  h.el.querySelector('#jellyseerr-tvdb-id').value = '777'; await h.save();
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0][1].body.tvdbId, 777);
  assert.deepEqual(h.calls[0][1].body.seasons, partial ? [1] : [1, 2]);
});

test('season modal escapes season names and leaves Specials out of a whole-show request', async t => {
  const h = await seasonModal(t, { partial: false, tvDetails: { seasons: tvSeasons, externalIds: { tvdbId: 1 } } });
  assert.equal(h.el.querySelector('.jellyseerr-season-name img'), null);
  assert.equal(h.el.querySelectorAll('.jellyseerr-season-name')[1].textContent, '<img src=x onerror=evil()>');
  assert.ok(seasonCheckbox(h, 0), 'Specials are listed when Seerr enables them');
  await h.save(); assert.deepEqual(h.calls[0][1].body.seasons, [1, 2]);
});

test('season modal disables requested seasons but re-offers one Seerr still calls available after its deletion', async t => {
  // Season 2 is "available" in Seerr, but nothing in Jellyfin backs it any more (no media id).
  const h = await seasonModal(t, { tvDetails: { seasons: tvSeasons, externalIds: { tvdbId: 1 }, mediaInfo: { seasons: [{ seasonNumber: 1, status: 3 }, { seasonNumber: 2, status: 5 }] } } });
  assert.equal(seasonCheckbox(h, 1).disabled, true); assert.equal(seasonCheckbox(h, 2).disabled, false);
  seasonCheckbox(h, 2).checked = true; await h.save(); assert.deepEqual(h.calls[0][1].body.seasons, [2]);
});

test('season modal failure toast escapes the upstream message and re-enables the request button', async t => {
  const h = await seasonModal(t, { tvDetails: { seasons: tvSeasons, externalIds: { tvdbId: 1 } }, post: async () => { throw { status: 500, responseJSON: { message: '<img src=x>' } }; } });
  seasonCheckbox(h, 1).checked = true; await h.save();
  assert.equal(h.toasts.at(-1)[0], '&lt;img src=x&gt;'); assert.equal(h.requestBtn.disabled, false);
  assert.equal(h.requestBtn.textContent, 'jellyseerr_modal_request_selected');
});

/**
 * Loads the real movie/collection request modals over a stubbed modal shell with
 * server/quality/folder selects. `save` clicks Request on the last modal opened.
 */
function requestModals(t, options) {
  const h = setup(t, options);
  for (const file of ['seerr-status.js', 'ui/ui-icons.js', 'ui/ui-quota.js', 'ui/ui-request-modals.js']) h.load(`jellyseerr/${file}`);
  h.JE.cdn = { url: () => 'https://cdn.test/poster.png' };
  // Distinct values, so a server/quality mix-up reaches the request body.
  const values = { 'movie-server': 2, 'movie-quality': 5, 'movie-folder': '/movies' };
  const select = id => `<select id="${id}"><option value=""></option><option value="${values[id]}">x</option></select>`;
  let current;
  h.JE.jellyseerrModal = { createAdvancedOptionsHTML: () => ['movie-server', 'movie-quality', 'movie-folder'].map(select).join(''), populateAdvancedOptions() {},
    create(o) { const el = h.document.createElement('div'); el.innerHTML = `<div class="jellyseerr-modal-body">${o.bodyHtml}</div>`; h.document.body.append(el); current = { el, o }; return { modalElement: el, show() {} }; } };
  h.requestBtn = h.document.createElement('button');
  h.modal = () => current.el;
  h.save = () => current.o.onSave(current.el, h.requestBtn, () => {});
  return h;
}

test('movie request modal needs every advanced option before it submits them', async t => {
  const h = requestModals(t); h.api.fetchAdvancedRequestData = async () => ({});
  await h.JE.jellyseerrUI.showMovieRequestModal(42, 'Film', null);
  const ids = ['movie-server', 'movie-quality', 'movie-folder'];
  await h.save(); assert.equal(h.calls.length, 0); assert.equal(h.toasts.at(-1)[0], 'jellyseerr_modal_toast_options_missing');
  // Any one option left empty blocks the request on its own.
  for (const empty of ids) {
    for (const id of ids) h.modal().querySelector(`#${id}`).selectedIndex = id === empty ? 0 : 1;
    const toasts = h.toasts.length;
    await h.save();
    assert.equal(h.calls.length, 0, `${empty} empty`);
    assert.equal(h.toasts.length, toasts + 1); assert.equal(h.toasts.at(-1)[0], 'jellyseerr_modal_toast_options_missing');
  }
  for (const id of ids) h.modal().querySelector(`#${id}`).selectedIndex = 1;
  await h.save(); assert.equal(h.calls.length, 1);
  assert.deepEqual([h.calls[0][1].body.serverId, h.calls[0][1].body.profileId, h.calls[0][1].body.rootFolder], [2, 5, '/movies']);
});

test('collection request modal escapes titles, skips owned movies and stops at the quota', async t => {
  let posts = 0;
  const h = requestModals(t, { post: async () => { if (++posts === 1) throw { status: 403, responseJSON: { message: 'Movie Quota exceeded.' } }; return { id: 7 }; } });
  const dialogs = []; h.window.Dashboard = { alert: data => dialogs.push(data) };
  // The quote would end the poster's alt attribute and start an onerror one if it were not escaped.
  const hostile = '<img src=x onerror=evil()>" onerror="evil()';
  h.api.fetchCollectionDetails = async () => ({ parts: [{ id: 1, title: hostile, mediaInfo: { status: 5 } }, { id: 2, title: 'Two' }, { id: 3, title: 'Three' }] });
  await h.JE.jellyseerrUI.showCollectionRequestModal(9, 'Saga');
  assert.equal(h.modal().querySelector('.jellyseerr-collection-movie-details .title img'), null);
  assert.equal(h.modal().querySelector('.jellyseerr-collection-movie-poster').getAttribute('alt'), hostile);
  assert.equal(h.modal().querySelector('[onerror]'), null);
  assert.equal(h.modal().querySelector('#movie-1').disabled, true);
  await h.save();
  // The quota rejection on the first selected movie ends the batch: nothing is sent for the rest.
  assert.deepEqual(h.calls.map(call => call[1].body.mediaId), [2]);
  assert.equal(dialogs.length, 1);
});
