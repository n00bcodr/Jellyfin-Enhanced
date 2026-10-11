// Review round 2: a season modal whose caller's session ended while it loaded (isCurrent() false) never shows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, plain } from '../helpers/harness.mjs';

const tvSeasons = [{ seasonNumber: 1, episodeCount: 3, airDate: '2020-01-01' }, { seasonNumber: 2, episodeCount: 3, airDate: '2021-01-01' }];

/**
 * Real api.js + season modal over a stubbed modal shell; `post` answers POST /jellyseerr/request.
 * @returns {Promise<object>} Harness with the modal element, its request button, `save` and `closed()`.
 */
async function seasonModal(t, { post = async () => ({}), options, partial = true, details } = {}) {
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
    fetchTvShowDetails: details || (async () => ({ seasons: tvSeasons, externalIds: { tvdbId: 1 } })), fetchSonarrLookup: async () => [],
    fetchUserQuota: async () => null, fetchTvSeasonDetails: async () => ({}) });
  h.document.addEventListener('jellyseerr-media-requested', e => events.push(plain(e.detail)));
  let modal = null, closes = 0;
  h.JE.jellyseerrModal = { createAdvancedOptionsHTML: () => '', populateAdvancedOptions() {}, create(o) {
    const el = h.document.createElement('div'); el.innerHTML = `<div class="jellyseerr-modal-body">${o.bodyHtml}</div>`;
    h.document.body.append(el); modal = { el, o }; return { modalElement: el, show() {} }; } };
  await h.JE.jellyseerrUI.showSeasonSelectionModal(42, 'tv', 'Show', null, false, options);
  const requestBtn = h.document.createElement('button');
  return { ...h, calls, events, toasts, modal, requestBtn, closed: () => closes };
}

test('a stale session stops the season modal before it is created', async t => {
  let current = true;
  const h = await seasonModal(t, { options: { preselectedSeasons: [1], isCurrent: () => current },
    details: async () => { current = false; return { seasons: tvSeasons, externalIds: { tvdbId: 1 } }; } });
  assert.equal(h.modal, null);
  assert.equal(h.toasts.length, 0);
});

test('a stale session also suppresses the "no season info" toast', async t => {
  let current = true;
  const h = await seasonModal(t, { options: { isCurrent: () => current }, details: async () => { current = false; return null; } });
  assert.equal(h.modal, null);
  assert.equal(h.toasts.length, 0);
});

test('a current session (or no check) shows the modal as before', async t => {
  const checked = await seasonModal(t, { options: { preselectedSeasons: [1], isCurrent: () => true } });
  assert.ok(checked.modal);
  const unchecked = await seasonModal(t, { options: { preselectedSeasons: [1] } });
  assert.ok(unchecked.modal);
});
