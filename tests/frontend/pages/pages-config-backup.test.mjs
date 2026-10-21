import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHarness } from '../helpers/harness.mjs';
import { repositoryRoot } from '../helpers/discovery.mjs';

// The configuration page is one inline script: run its real Backup & Restore helpers in a fresh realm.
const page = readFileSync(resolve(repositoryRoot, 'Jellyfin.Plugin.JellyfinEnhanced/Configuration/configPage.html'), 'utf8');
function block(start, end) {
  const from = page.indexOf(start);
  const to = page.indexOf(end, from);
  if (from < 0 || to < 0) throw new Error(`config page block not found: ${start}`);
  return page.slice(from, to);
}
const helpers = block('        function jeBackupExportOptions(doc) {', '        jeBackupInit();');

const html = `
  <select id="backupExportSecrets"><option value="exclude">x</option><option value="encrypt">y</option></select>
  <div id="backupExportPassphraseRow"><input id="backupExportPassphrase"></div>
  <button id="backupExportBtn"></button><div id="backupExportStatus"></div>
  <input id="backupRestoreFile" type="file"><input id="backupRestorePassphrase">
  <button id="backupInspectBtn"></button><button id="backupRestoreBtn"></button><div id="backupRestoreStatus"></div>`;

// jsdom has no object URLs; the download only needs one to exist.
function h_url(window) {
  window.URL.createObjectURL = () => 'blob:x';
  window.URL.revokeObjectURL = () => {};
}
const plain = value => JSON.parse(JSON.stringify(value));

function setup(t, respond) {
  const requests = [];
  const h = createHarness({
    html,
    fetch: async (url, init) => { requests.push({ url, init }); return respond(url, init); },
  });
  h_url(h.window);
  t.after(() => h.close());
  h.window.eval(`${helpers}\nwindow.__je = { jeBackupExportOptions, jeBackupExport, jeBackupUpload, jeBackupSummaryText, jeBackupRestoreText, jeBackupInit };`);
  return { ...h, get NATIVE() { return h.NATIVE; }, je: h.window.__je, requests, $: id => h.document.getElementById(id) };
}

function response(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300, status,
    json: async () => body,
    blob: async () => ({ size: 3 }),
    headers: { get: name => headers[name] ?? null },
  };
}

test('including credentials needs a passphrase of at least 12 characters', t => {
  const { je, $, document } = setup(t, () => response(200, {}));
  assert.deepEqual(plain(je.jeBackupExportOptions(document)), { secrets: 'exclude', passphrase: '', error: null });
  $('backupExportSecrets').value = 'encrypt';
  $('backupExportPassphrase').value = 'too short';
  assert.match(je.jeBackupExportOptions(document).error, /at least 12/);
  $('backupExportPassphrase').value = 'a long enough passphrase';
  assert.deepEqual(plain(je.jeBackupExportOptions(document)), { secrets: 'encrypt', passphrase: 'a long enough passphrase', error: null });
});

test('download posts the choice with the admin token and saves the file under the server name', async t => {
  const { je, $, document, requests } = setup(t, () => response(200, {}, { 'Content-Disposition': 'attachment; filename=jellyfin-enhanced-backup-20261012-120000.zip' }));
  $('backupExportSecrets').value = 'encrypt';
  $('backupExportPassphrase').value = 'a long enough passphrase';
  let clicked = null;
  document.addEventListener('click', e => { if (e.target.tagName === 'A') { clicked = e.target.download; e.preventDefault(); } });

  const message = await je.jeBackupExport(document);

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'http://jellyfin.test/JellyfinEnhanced/admin/backup/export');
  assert.equal(requests[0].init.method, 'POST');
  assert.equal(requests[0].init.headers.Authorization, 'MediaBrowser Token="test-token"');
  assert.deepEqual(JSON.parse(requests[0].init.body), { secrets: 'encrypt', passphrase: 'a long enough passphrase' });
  assert.equal(clicked, 'jellyfin-enhanced-backup-20261012-120000.zip');
  assert.match(message, /API keys included, encrypted/);
  assert.equal(document.querySelectorAll('a').length, 0);
});

test('a refused download shows the server message and nothing is requested for an invalid choice', async t => {
  const { je, $, document, requests } = setup(t, () => response(400, { message: 'The stored credentials can\'t be read right now.' }));
  assert.match(await je.jeBackupExport(document), /can't be read/);
  $('backupExportSecrets').value = 'encrypt';
  assert.match(await je.jeBackupExport(document), /at least 12/);
  assert.equal(requests.length, 1);
});

test('check and restore upload the chosen file with the passphrase; restore adds the confirmation', async t => {
  const { je, $, document, window, requests } = setup(t, (url) => response(200, url.endsWith('/inspect')
    ? { manifest: { createdAt: '2026-10-12T00:00:00Z', pluginVersion: '12.8.0.0' }, hasConfiguration: true, userFolders: 3, dataFiles: 9, hasSecrets: true, passphraseOk: false }
    : { filesRestored: 9, configurationRestored: true, secretsRestored: 2, missingCredentials: ['ShokoApiKey'], safetyBackup: 'pre.zip' }));
  assert.deepEqual(plain(await je.jeBackupUpload(document, 'inspect')), { ok: false, body: { message: 'Choose a backup file first.' } });
  assert.equal(requests.length, 0);

  const file = new window.File(['PK'], 'backup.zip', { type: 'application/zip' });
  Object.defineProperty($('backupRestoreFile'), 'files', { value: [file] });
  $('backupRestorePassphrase').value = 'secret passphrase';
  const inspected = await je.jeBackupUpload(document, 'inspect');
  const restored = await je.jeBackupUpload(document, 'restore');

  assert.deepEqual(requests.map(r => r.url), ['http://jellyfin.test/JellyfinEnhanced/admin/backup/inspect', 'http://jellyfin.test/JellyfinEnhanced/admin/backup/restore']);
  const [inspectForm, restoreForm] = requests.map(r => r.init.body);
  assert.equal(inspectForm.get('file').name, 'backup.zip');
  assert.equal(inspectForm.get('passphrase'), 'secret passphrase');
  assert.equal(inspectForm.get('confirm'), null);
  assert.equal(restoreForm.get('confirm'), 'restore');
  assert.equal(requests[0].init.headers.Authorization, 'MediaBrowser Token="test-token"');
  assert.match(je.jeBackupSummaryText(inspected.body), /plugin settings, 3 user\(s\) with their settings, 9 file\(s\) in total; API keys included, but the passphrase is wrong\./);
  assert.equal(je.jeBackupRestoreText(restored.body),
    'Restored 9 file(s), the plugin settings and 2 API key(s). Enter these again: ShokoApiKey. The previous data was saved as pre.zip. Restart Jellyfin, then reload this page.');
});

test('the passphrase row only shows when credentials are included', t => {
  const { je, $, window } = setup(t, () => response(200, {}));
  je.jeBackupInit();
  assert.equal($('backupExportPassphraseRow').style.display, 'none');
  $('backupExportSecrets').value = 'encrypt';
  $('backupExportSecrets').dispatchEvent(new window.Event('change'));
  assert.equal($('backupExportPassphraseRow').style.display, '');
});
