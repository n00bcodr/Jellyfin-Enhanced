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

test('rapid repeated clicks submit one movie request and update status on success', async t => {
  const pending = deferred(); const h = uiSetup(t, { post: () => pending.promise }); h.configure();
  h.button.click(); h.button.click(); assert.equal(h.button.disabled, true); await flush(); assert.equal(h.calls.length, 1);
  pending.resolve({ id: 7 }); await flush();
  assert.equal(h.item.mediaInfo.status, 3); assert.equal(h.button.disabled, true);
  assert.ok(h.button.classList.contains('jellyseerr-button-pending'));
});

for (const split of [false, true]) test(`request failure escapes message and permits explicit retry (split=${split})`, async t => {
  let tries = 0;
  const h = uiSetup(t, { config: { JellyseerrEnable4KRequests: split }, post: async () => { if (++tries === 1) throw { status: 500, responseJSON: { message: '<img src=x onerror=evil()>' } }; return { id: 7 }; } });
  h.configure(); const button = split ? h.document.querySelector('.jellyseerr-split-main') : h.button;
  button.click(); await flush(); assert.equal(button.disabled, false); assert.equal(button.querySelector('img'), null); assert.ok(button.textContent.includes('<img'));
  button.click(); await flush(); assert.equal(h.calls.length, 2); assert.equal(button.disabled, true);
});

test('quota rejection shows escaped dialog and restores request button', async t => {
  const h = uiSetup(t, { post: async () => { throw { status: 403, responseJSON: { message: 'Movie Quota exceeded. <img src=x>' } }; }, get: async () => ({ movie: { limit: 2, used: 2, restricted: true } }) });
  const dialogs = []; h.window.Dashboard = { alert: data => dialogs.push(data) }; h.configure(); h.button.click(); await flush();
  assert.equal(dialogs.length, 1); assert.ok(dialogs[0].message.includes('&lt;img')); assert.equal(h.button.disabled, false); assert.equal(h.events.length, 0);
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

test('advanced-permission UI opens options without prematurely submitting', async t => {
  const h = uiSetup(t, { config: { JellyseerrShowAdvanced: true }, get: async () => ({ active: true, userFound: true, canRequestAdvanced: true }) });
  await h.api.checkUserStatus(); const opened = []; h.JE.jellyseerrUI.showMovieRequestModal = (...args) => opened.push(args);
  h.configure(); h.button.click(); await flush(); assert.equal(h.calls.length, 0); assert.equal(opened.length, 1); assert.equal(opened[0][0], 42);
});

for (const code of ['no_request_permission', 'request_4k_forbidden']) test(`typed permission denial ${code} is shown without success state`, async t => {
  const h = uiSetup(t, { post: async () => { throw { status: 403, responseJSON: { code } }; } });
  h.configure(); h.button.click(); await flush();
  assert.ok(h.button.textContent.includes(`jellyseerr_err_${code}`)); assert.equal(h.events.length, 0); assert.equal(h.item.mediaInfo, undefined);
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
  const h = setup(t, { config: { JellyseerrShowQuotaInfo: false }, get: () => { throw new Error('must not fetch'); } });
  assert.equal(await h.api.fetchUserQuota(), null);
});

for (const split of [false, true]) for (const succeeds of [true, false]) test(`late request ${succeeds ? 'success' : 'failure'} cannot overwrite a refreshed offline button (split=${split})`, async t => {
  const pending = deferred(); const h = uiSetup(t, { config: { JellyseerrEnable4KRequests: split }, post: () => pending.promise }); h.configure();
  if (split) h.button = h.document.querySelector('.jellyseerr-split-main');
  h.button.click(); await flush(); h.configure(false, true);
  const offlineLabel = h.button.textContent;
  if (succeeds) pending.resolve({ id: 7 }); else pending.reject({ status: 500, responseJSON: { message: 'old failure' } });
  await flush(); assert.equal(h.button.disabled, true); assert.equal(h.button.textContent, offlineLabel);
});
