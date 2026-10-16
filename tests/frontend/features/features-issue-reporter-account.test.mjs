import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from '../helpers/harness.mjs';

// Issues are read and reported as the viewer's own Seerr account. A viewer without one (Jellyfin
// Enhanced request mode lets them in) gets no report button, rather than one whose every call is
// refused (a 404 and a console error on each details page).

/**
 * The issue reporter with Seerr up and the viewer's Seerr status given.
 * @param {object} t Test context.
 * @param {object} status The viewer's Seerr status.
 * @returns {object} Harness and the reporter.
 */
function reporter(t, status) {
  const h = createHarness({
    JE: {
      pluginConfig: { JellyseerrEnabled: true },
      t: key => key,
      jellyseerrAPI: { checkUserStatus: async () => status },
    },
    apiClient: { ajax: async () => ({ active: true }), getUrl: path => path },
  });
  t.after(() => h.close());
  h.load('jellyseerr/issue-reporter.js');
  return { ...h, reporter: h.JE.jellyseerrIssueReporter || h.JE.issueReporter };
}

test('a viewer without a Seerr account gets no report button; a linked viewer does', async t => {
  const item = { Id: 'x', Type: 'Movie', Name: 'Dune', ProviderIds: { Tmdb: '693134' } };
  const unlinked = reporter(t, { active: true, userFound: false, reason: 'unlinked' });
  assert.equal(await unlinked.reporter.checkReportingAvailability(item), 'no-account');
  const linked = reporter(t, { active: true, userFound: true });
  assert.equal(await linked.reporter.checkReportingAvailability(item), 'available');
  // Seerr unreachable is still the old "no Seerr" answer, not "no account".
  const down = reporter(t, { active: false, userFound: false });
  assert.equal(await down.reporter.checkReportingAvailability(item), 'available');
});

test('an account Seerr won\'t show issues to is asked once, quietly, until the user changes', async t => {
  const calls = [];
  const switches = [];
  const h = createHarness({
    JE: {
      t: key => key,
      session: { onUserChange: (_name, fn) => switches.push(fn) },
      core: { api: { fetch: async url => { calls.push(url); throw Object.assign(new Error('HTTP 403'), { status: 403 }); } } },
    },
    apiClient: { getUrl: path => path },
  });
  t.after(() => h.close());
  const errors = [];
  h.window.console.error = (...args) => errors.push(args.join(' '));
  h.load('jellyseerr/api.js');
  const api = h.JE.jellyseerrAPI;
  assert.deepEqual(JSON.parse(JSON.stringify(await api.fetchIssuesForMedia(603, 'movie'))), { results: [], forbidden: true });
  assert.deepEqual(JSON.parse(JSON.stringify(await api.fetchIssuesForMedia(604, 'movie'))), { results: [], forbidden: true });
  assert.equal(calls.length, 1);
  assert.deepEqual(errors, []);
  // Another user may be allowed: asked again.
  switches.forEach(fn => fn());
  await api.fetchIssuesForMedia(603, 'movie');
  assert.equal(calls.length, 2);
});

test('a status saying the account may not view issues means no issue read at all', async t => {
  const calls = [];
  const h = createHarness({
    JE: {
      t: key => key,
      core: { api: { fetch: async url => { calls.push(url); if (url.includes('/user-status')) return { active: true, userFound: true, reason: 'linked', canViewIssues: false }; return { results: [] }; } } },
    },
    apiClient: { getUrl: path => path },
  });
  t.after(() => h.close());
  h.load('jellyseerr/api.js');
  const api = h.JE.jellyseerrAPI;
  api.surfaceUserStatusBanner = () => {};
  await api.checkUserStatus();
  await api.fetchIssuesForMedia(603, 'movie');
  assert.deepEqual(calls.filter(u => u.includes('/issue')), []);
});
