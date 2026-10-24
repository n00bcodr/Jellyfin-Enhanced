import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, jsonResponse } from '../helpers/harness.mjs';
import { tab, settingsServer, en } from '../helpers/settings-tabs.mjs';

// Stage 1 fix round 12: which answer can tell a page that the server runs another build. RBS1-R12-8: the raw request,
// list and user-page adapters sent through the session fence but never showed their answers to the build check, so an
// older page learned nothing from a newer build's refusal. RBS1-R12-9: an Awards answer the browser kept for 1800 s named
// the previous build and told a current page to reload; only an answer the browser could not have kept proves the build.

function loadCore(h) {
  for (const path of ['core/navigation.js', 'core/session.js', 'core/mutation-queue.js', 'core/api-client.js']) h.load(path);
}

test('R12-8 control: settings writes to a newer build must show the reload notice', async t => {
  const s = settingsServer({ Settings: {}, Shortcuts: { Shortcuts: [] }, Bookmark: { Bookmarks: {} }, Elsewhere: { Region: 'US' }, HiddenContent: { Items: {}, Settings: {} } });
  const h = await tab(t, s);
  h.JE.pageBuild = 'old-build';
  h.JE.serverBuild = 'old-build';
  h.load('core/api-client.js');
  const original = h.window.fetch;
  h.window.fetch = async (url, init = {}) => {
    if (init.method === 'PATCH') {
      const error = new Response(JSON.stringify({ code: 'revision_conflict' }), { status: 409, headers: { 'X-JE-Build': 'new-build' } });
      return error;
    }
    return original(url, init);
  };
  await assert.rejects(h.JE.updateSettings({ autoPauseEnabled: !h.JE.currentSettings.autoPauseEnabled }, { throwOnError: true }));
  assert.ok(h.document.querySelector('.je-reload-notice'), 'the new build header on an ajax refusal must be consumed');
});

test('R12-8: a raw request answer from a newer build must show the reload notice', async t => {
  const h = createHarness({ JE: { pluginConfig: { ArrRequestsEnabled: true }, arrStatus: { enabled: () => true }, pageBuild: 'old-build', serverBuild: 'old-build', t: k => k }, fetch: async (url, init) => new Response(JSON.stringify({ outcome: 'refused', reason: 'invalid_input' }), { status: 400, headers: { 'X-JE-Build': 'new-build' } }) });
  h.allowConsoleError(/./);
  t.after(() => h.close());
  for (const f of ['core/navigation.js', 'core/session.js', 'core/mutation-queue.js', 'core/api-client.js', 'arr/ask/ask-core.js']) h.load(f);
  assert.equal(h.document.querySelector('.je-reload-notice'), null);
  const result = await h.JE.arrAsk.ask({ key: 'tmdb:movie:42', edition: 'standard' });
  assert.equal(result.status, 400, 'the real request ran');
  assert.ok(h.document.querySelector('.je-reload-notice'), 'the raw request response named the new build');
});

test('R12-9: a cached awards response from the previous build must not tell a current page to reload', async t => {
  const h = createHarness({
    JE: { pageBuild: '1.2.3-current', serverBuild: '1.2.3-current', t: key => en[key] ?? key },
    fetch: async url => {
      const response = jsonResponse({ Confirmed: true, Awards: [] });
      response.headers.set('X-JE-Build', String(url).includes('/awards/') ? '1.2.3-previous' : '1.2.3-current');
      response.headers.set('Cache-Control', 'private, max-age=1800');
      response.headers.set('Age', '60');
      return response;
    }
  });
  t.after(() => h.close());
  loadCore(h);
  await h.JE.core.api.plugin('/version');
  await h.JE.core.api.plugin('/awards/movie/123', { cacheKey: 'awards-movie-123' });
  await h.JE.core.api.plugin('/version');
  assert.equal(h.document.querySelectorAll('.je-reload-notice').length, 0);
});
