// Review round 3: the season modal's success toast is HTML (JE.toast sets innerHTML), and a list placeholder passes
// its editor-controlled title as the show title, so the title must be escaped at that sink.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, plain } from '../helpers/harness.mjs';

const tvSeasons = [{ seasonNumber: 1, episodeCount: 3, airDate: '2020-01-01' }, { seasonNumber: 2, episodeCount: 3, airDate: '2021-01-01' }];
const hostile = '<img src=x onerror=alert(1)>';

/**
 * Real api.js + season modal over a stubbed modal shell, opened with `title`; every request succeeds.
 * @returns {Promise<object>} Harness with the toasts and `save`.
 */
async function seasonModal(t, { title, partial }) {
  const toasts = [];
  const h = createHarness({ JE: {
    pluginConfig: {}, t: (key, args) => key + (args ? ` ${args.title}` : ''),
    escapeHtml: value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    toast: (...args) => toasts.push(args), helpers: { trackUsage() {} },
    session: { getEpoch: () => 0, isCurrent: value => value === 0, onUserChange() {} },
    core: { api: { fetch: async () => ({}), plugin: async (url, o) => { plain(o); return {}; } } }
  } });
  t.after(() => h.close());
  for (const file of ['api.js', 'seerr-status.js', 'ui/ui-icons.js', 'ui/ui-quota.js', 'ui/ui-season-modal.js']) h.load(`jellyseerr/${file}`);
  const api = h.JE.jellyseerrAPI;
  api.addToWatchlist = async () => {};
  h.JE.internals.jellyseerrUi.markCardRequested = () => {};
  Object.assign(api, { fetchRequestSettings: async () => ({ partialRequestsEnabled: partial, enableSpecialEpisodes: false }),
    fetchTvShowDetails: async () => ({ seasons: tvSeasons, externalIds: { tvdbId: 1 } }), fetchSonarrLookup: async () => [],
    fetchUserQuota: async () => null, fetchTvSeasonDetails: async () => ({}) });
  let modal;
  h.JE.jellyseerrModal = { createAdvancedOptionsHTML: () => '', populateAdvancedOptions() {}, create(o) {
    const el = h.document.createElement('div'); el.innerHTML = `<div class="jellyseerr-modal-body">${o.bodyHtml}</div>`;
    h.document.body.append(el); modal = { el, o }; return { modalElement: el, show() {} }; } };
  await h.JE.jellyseerrUI.showSeasonSelectionModal(42, 'tv', title, null, false, { preselectedSeasons: [1] });
  return { toasts, save: () => modal.o.onSave(modal.el, h.document.createElement('button'), () => {}) };
}

test('the success toast escapes the show title (partial and whole-show requests)', async t => {
  for (const partial of [true, false]) {
    const h = await seasonModal(t, { title: hostile, partial });
    await h.save();
    const text = h.toasts.at(-1)[0];
    assert.match(text, /^jellyseerr_modal_toast_request_success/);
    assert.ok(!text.includes('<img'), `raw markup in toast: ${text}`);
    assert.ok(text.includes('&lt;img src=x onerror=alert(1)&gt;'), text);
  }
});
