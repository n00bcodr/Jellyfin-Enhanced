// A failed Seerr read must reach the error UI the callers already have, never pass as an empty answer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, plain } from '../helpers/harness.mjs';

const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function setup(t, { get, files = [], je = {} }) {
  const posts = [], toasts = [];
  const h = createHarness({ JE: {
    ...je,
    pluginConfig: {}, t: key => key, escapeHtml, toast: (...args) => toasts.push(args[0]), helpers: { trackUsage() {} },
    session: { getEpoch: () => 0, isCurrent: value => value === 0, onUserChange() {} },
    requestManager: { clearCacheMatching() {} },
    cdn: { url: () => 'https://cdn.test/none.png', selfhst: () => 'https://cdn.test/seerr.svg' },
    core: { api: { fetch: url => get(new URL(url, 'http://jellyfin.test').pathname.replace('/JellyfinEnhanced/jellyseerr', '')),
      plugin: (url, options) => { posts.push([url, plain(options)]); return Promise.resolve({ id: 7 }); } },
      ui: { addTouchTapListener() {}, addDelegatedTouchTapListener() {}, isTvLayout: () => false } }
  } });
  t.after(() => h.close());
  for (const file of ['seerr-status.js', 'api.js', ...files]) h.load(`jellyseerr/${file}`);
  return { ...h, api: h.JE.jellyseerrAPI, posts, toasts };
}
const unavailable = () => Promise.reject(Object.assign(new Error('HTTP 500'), { status: 500 }));

test('BUG-021: a failed server listing rejects instead of answering no servers, and is asked again next time', async t => {
  let down = true;
  const h = setup(t, { get: path => (path === '/sonarr' && down ? unavailable() : path === '/sonarr' ? Promise.resolve([{ id: 1, name: 'Sonarr', isDefault: true }]) : Promise.resolve({})) });
  await assert.rejects(h.api.fetchAdvancedRequestData('tv'));
  down = false;
  const data = await h.api.fetchAdvancedRequestData('tv');
  assert.deepEqual(plain(data.servers.map(server => server.id)), [1]);
});

test('BUG-021: the movie dialog says the server options failed, and Request still sends once without a server override', async t => {
  const h = setup(t, { get: path => (path === '/radarr' ? unavailable() : Promise.resolve({})),
    files: ['ui/ui-icons.js', 'ui/ui-badges.js', 'ui/ui-quota.js', 'ui/ui-results.js', 'modal.js', 'ui/ui-request-modals.js'] });
  h.allowConsoleError(/radarr|advanced options/i);
  await h.JE.jellyseerrUI.showMovieRequestModal(603, 'Film', null, false);
  await settle();
  assert.deepEqual(h.toasts, ['jellyseerr_err_load_server_options']);
  h.document.querySelector('.jellyseerr-modal-button-primary').click();
  await settle();
  assert.equal(h.toasts.includes('jellyseerr_modal_toast_options_missing'), false);
  const requests = h.posts.filter(([url]) => url.endsWith('/request'));
  assert.equal(requests.length, 1);
  const body = requests[0][1].body;
  assert.equal(body.mediaId, 603);
  assert.equal('serverId' in body, false);
});

test('BUG-021: the season dialog says the server options failed, and Request still sends once without a server override', async t => {
  const show = { id: 42, name: 'Show', externalIds: { tvdbId: 5 }, seasons: [{ seasonNumber: 1, episodeCount: 3, airDate: '2020-01-01' }] };
  const h = setup(t, { get: path => (path === '/sonarr' ? unavailable() : path === '/tv/42' ? Promise.resolve(show) : Promise.resolve({})),
    files: ['ui/ui-icons.js', 'ui/ui-badges.js', 'ui/ui-quota.js', 'ui/ui-results.js', 'modal.js', 'ui/ui-season-modal.js'] });
  h.allowConsoleError(/sonarr|advanced options/i);
  h.api.shouldShowAdvanced = () => true;
  await h.JE.jellyseerrUI.showSeasonSelectionModal(42, 'tv', 'Show');
  await settle();
  assert.ok(h.document.querySelector('#tv-server'), 'the dialog offers server options');
  assert.deepEqual(h.toasts, ['jellyseerr_err_load_server_options']);
  h.document.querySelector('.jellyseerr-modal-button-primary').click();
  await settle();
  assert.equal(h.toasts.includes('jellyseerr_modal_toast_options_missing'), false);
  const requests = h.posts.filter(([url]) => url.endsWith('/request'));
  assert.equal(requests.length, 1);
  assert.equal(requests[0][1].body.mediaId, 42);
  assert.equal('serverId' in requests[0][1].body, false);
});

test('BUG-022: a failed issue list says the issues could not be loaded, not that there are none', async t => {
  const h = setup(t, { get: path => (path === '/issue' ? unavailable() : Promise.resolve({})), files: ['modal.js', 'issue-reporter.js'], je: {
    pluginConfig: { JellyseerrEnabled: true, JellyseerrShowReportButton: true }, icon: () => '', IconName: {},
    jellyseerrUI: { addMainStyles() {} } } });
  h.expectConsoleError(/Failed to load existing issues/);
  h.JE.jellyseerrIssueReporter.showReportModal('603', 'Film', 'movie');
  await settle();
  assert.equal(h.document.querySelector('.jellyseerr-issues-empty')?.textContent, 'jellyseerr_load_issues_error');
});
