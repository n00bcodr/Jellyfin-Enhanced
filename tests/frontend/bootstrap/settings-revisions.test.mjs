import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, deferred } from '../helpers/harness.mjs';

function setup(t) {
  const requests = [], notices = [];
  let revision = 'r1', user = 'user-a', base = 'http://a';
  const h = createHarness({ JE: { userConfig: { settings: {}, settingsRevision: revision, bookmark: { bookmarks: {} } }, toast: text => notices.push(text) },
    apiClient: { getCurrentUserId: () => user, getUrl: path => base + path, ajax: async request => {
      requests.push(request);
      const body = JSON.parse(request.data);
      assert.ok(request.url.endsWith('/settings-document'));
      if (body.Revision !== revision) throw { status: 409 };
      revision += '+';
      return { Revision: revision };
    } } });
  t.after(() => h.close());
  h.load('enhanced/config.js'); h.JE.currentSettings = h.JE.loadSettings();
  return { ...h, requests, notices, externalWrite() { revision += 'external'; }, switchServer() { base = 'http://b'; }, switchUser() { user = 'user-b'; } };
}

test('compiled settings use loaded revision, chain successful revisions and refuse external conflict without retry', async t => {
  const h = setup(t);
  const settings = h.JE.currentSettings;
  settings.autoPauseEnabled = false;
  await h.JE.saveUserSettings('settings.json', settings, { throwOnError: true });
  assert.equal(JSON.parse(h.requests[0].data).Revision, 'r1');
  settings.autoPauseEnabled = true;
  await h.JE.saveUserSettings('settings.json', settings, { throwOnError: true });
  assert.equal(JSON.parse(h.requests[1].data).Revision, 'r1+');
  h.externalWrite();
  let rolledBack = false;
  settings.autoPauseEnabled = false;
  await assert.rejects(h.JE.saveUserSettings('settings.json', settings, { throwOnError: true, onError() { settings.autoPauseEnabled = true; rolledBack = true; } }));
  assert.equal(h.requests.length, 3);
  assert.equal(rolledBack, true);
  assert.match(h.notices.at(-1), /Reload/);
  assert.equal(h.JE.userConfig.settingsRevision, 'r1++');
});

for (const change of ['switchServer', 'switchUser']) test(`loaded settings cannot save after ${change} without caller guard`, async t => {
  const h = setup(t); h[change]();
  await h.JE.saveUserSettings('settings.json', h.JE.currentSettings, { throwOnError: true });
  assert.equal(h.requests.length, 0);
});

test('missing revision is a hard failure and never fetched opportunistically', async t => {
  const h = setup(t); h.JE.userConfig.settingsRevision = null;
  await assert.rejects(h.JE.saveUserSettings('settings.json', h.JE.currentSettings, { throwOnError: true }), /revision/);
  assert.equal(h.requests.length, 0);
});

test('invalid successful response does not invent a revision or retry the write', async t => {
  const h = setup(t);
  let writes = 0;
  h.window.ApiClient.ajax = async () => { writes++; return {}; };
  await assert.rejects(h.JE.saveUserSettings('settings.json', h.JE.currentSettings, { throwOnError: true }), /Invalid settings save response/);
  assert.equal(writes, 1);
  assert.equal(h.JE.userConfig.settingsRevision, 'r1');
});


test('other documents retain their existing wire body and loaded account binding', async t => {
  const h = setup(t);
  const requests = [];
  h.window.ApiClient.ajax = async request => { requests.push(request); };
  const bookmarks = h.JE.userConfig.bookmark;
  await h.JE.saveUserSettings('bookmark.json', bookmarks, { throwOnError: true });
  assert.equal(requests.length, 1);
  assert.ok(requests[0].url.endsWith('/bookmark.json'));
  assert.deepEqual(JSON.parse(requests[0].data), { bookmarks: {} });
  assert.equal(requests[0].dataType, undefined);
  h.switchServer();
  bookmarks.bookmarks.new = { label: 'stale account' };
  await h.JE.saveUserSettings('bookmark.json', bookmarks, { throwOnError: true });
  assert.equal(requests.length, 1);
});

for (const throwOnError of [false, true]) test(`stale failed writes retain throwOnError=${throwOnError} without stale callbacks`, async t => {
  const h = setup(t);
  const gate = deferred();
  let rollbacks = 0;
  h.window.ApiClient.ajax = () => gate.promise;
  const pending = h.JE.saveUserSettings('settings.json', h.JE.currentSettings, { throwOnError, onError() { rollbacks++; } });
  await new Promise(resolve => setImmediate(resolve));
  h.switchUser();
  gate.reject(new Error('offline'));
  if (throwOnError) await assert.rejects(pending, /offline/);
  else await pending;
  assert.equal(rollbacks, 0);
  assert.equal(h.notices.length, 0);
  assert.equal(h.JE.userConfig.settingsRevision, 'r1');
});
