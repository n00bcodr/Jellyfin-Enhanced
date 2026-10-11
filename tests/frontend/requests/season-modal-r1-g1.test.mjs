// Season modal opened by a list placeholder (B5): Seerr's 202 "No seasons available to request" and 409 mean the
// seasons are already requested, so the modal announces them and closes without a success toast or an error.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, plain } from '../helpers/harness.mjs';

const tvSeasons = [{ seasonNumber: 1, episodeCount: 3, airDate: '2020-01-01' }, { seasonNumber: 2, episodeCount: 3, airDate: '2021-01-01' }];

/**
 * Real api.js + season modal over a stubbed modal shell; `post` answers POST /jellyseerr/request.
 * @returns {Promise<object>} Harness with the modal element, its request button, `save` and `closed()`.
 */
async function seasonModal(t, { post, options, partial = true } = {}) {
  const calls = [], events = [], toasts = [];
  const h = createHarness({ JE: {
    pluginConfig: {}, t: (key, args) => key + (args ? JSON.stringify(args) : ''),
    escapeHtml: value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    toast: (...args) => toasts.push(args), helpers: { trackUsage() {} },
    session: { getEpoch: () => 0, isCurrent: value => value === 0, onUserChange() {} },
    core: { api: { fetch: async () => ({}), plugin: (url, o) => { calls.push([url, plain(o)]); return post(url, o); } } }
  } });
  t.after(() => h.close());
  for (const file of ['api.js', 'seerr-status.js', 'ui/ui-icons.js', 'ui/ui-quota.js', 'ui/ui-season-modal.js']) h.load(`jellyseerr/${file}`);
  const api = h.JE.jellyseerrAPI;
  api.addToWatchlist = async () => {};
  h.JE.internals.jellyseerrUi.markCardRequested = () => {};
  Object.assign(api, { fetchRequestSettings: async () => ({ partialRequestsEnabled: partial, enableSpecialEpisodes: false }),
    fetchTvShowDetails: async () => ({ seasons: tvSeasons, externalIds: { tvdbId: 1 } }), fetchSonarrLookup: async () => [],
    fetchUserQuota: async () => null, fetchTvSeasonDetails: async () => ({}) });
  h.document.addEventListener('jellyseerr-media-requested', e => events.push(plain(e.detail)));
  let modal, closes = 0;
  h.JE.jellyseerrModal = { createAdvancedOptionsHTML: () => '', populateAdvancedOptions() {}, create(o) {
    const el = h.document.createElement('div'); el.innerHTML = `<div class="jellyseerr-modal-body">${o.bodyHtml}</div>`;
    h.document.body.append(el); modal = { el, o }; return { modalElement: el, show() {} }; } };
  await h.JE.jellyseerrUI.showSeasonSelectionModal(42, 'tv', 'Show', null, false, options);
  const requestBtn = h.document.createElement('button');
  return { ...h, calls, events, toasts, el: modal.el, requestBtn, closed: () => closes,
    save: () => modal.o.onSave(modal.el, requestBtn, () => { closes++; }) };
}

const noSeasons = async () => ({ message: 'No seasons available to request' });
const conflict = async () => { throw Object.assign(new Error('HTTP 409'), { status: 409, responseJSON: { message: 'Request for this media already exists.' } }); };
const placeholderOptions = { preselectedSeasons: [1], treatExistingAsRequested: true };

test('placeholder season request: 202 "No seasons available" announces the seasons and closes without a success toast', async t => {
  const h = await seasonModal(t, { post: noSeasons, options: placeholderOptions });
  await h.save();
  assert.deepEqual(h.calls[0][1].body.seasons, [1]);
  assert.equal(h.toasts.length, 0, `no toast, got ${JSON.stringify(h.toasts)}`);
  assert.equal(h.closed(), 1);
  assert.ok(h.events.some(e => e.mediaType === 'tv' && e.tmdbId == 42 && JSON.stringify(e.seasons) === '[1]'));
});

test('placeholder season request: 409 counts as already requested (no error, modal closes, seasons announced)', async t => {
  for (const partial of [true, false]) {
    const h = await seasonModal(t, { post: conflict, options: placeholderOptions, partial });
    await h.save();
    assert.equal(h.toasts.length, 0, `no toast, got ${JSON.stringify(h.toasts)}`);
    assert.equal(h.closed(), 1);
    const expected = partial ? [1] : [1, 2];
    assert.deepEqual(h.events.map(e => e.seasons), [expected], 'one announcement with the submitted seasons');
    assert.equal(h.events[0].is4k, false);
  }
});

test('other callers keep the existing behaviour: 202 toasts success, 409 reports the error and keeps the modal open', async t => {
  const accepted = await seasonModal(t, { post: noSeasons, options: { preselectedSeasons: [1] } });
  await accepted.save();
  assert.match(accepted.toasts.at(-1)[0], /^jellyseerr_modal_toast_request_success/);
  const failed = await seasonModal(t, { post: conflict, options: { preselectedSeasons: [1] } });
  await failed.save();
  assert.equal(failed.closed(), 0);
  assert.equal(failed.requestBtn.disabled, false);
  assert.ok(failed.toasts.length > 0);
  assert.deepEqual(failed.events, []);
});

test('placeholder flow: other errors are still reported', async t => {
  const h = await seasonModal(t, { post: async () => { throw { status: 500, responseJSON: { message: 'boom' } }; }, options: placeholderOptions });
  await h.save();
  assert.equal(h.closed(), 0);
  assert.equal(h.toasts.at(-1)[0], 'boom');
  assert.deepEqual(h.events, []);
});
