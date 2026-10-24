import test from 'node:test';
import assert from 'node:assert/strict';
import { configPage } from '../helpers/config-page.mjs';

// Stage 1 fix round 11: the configuration page compares the edits it keeps across a refresh with what the server holds
// now, and says when what it shows may be out of date. RBS1-R11-5: read 1500, edit 1600, another administrator saves 1700,
// a refresh keeps 1600; choosing 1500 again and saving sent nothing (it was compared with the value from before the
// refresh), so the server kept 1700. RBS1-R11-6: a refresh dropped during a save was read again afterwards, and when that
// read failed the page showed the older values with a clean save marker.

const config = () => ({ ToastDuration: 1500, HelpPanelAutocloseDelay: 15000, Shortcuts: [], JellyseerrUrls: '', JellyseerrUrlMappings: '' });

test('R11-5: after a refresh keeps an edit, choosing the value from before the refresh is a change, and is saved', async t => {
  const p = configPage(t, { config: config() });
  await p.pageshow();
  p.choose('#ToastDuration', '1600');
  p.server.config.ToastDuration = 1700;
  await p.pageshow();
  await p.flush(30);
  assert.equal(p.$('#ToastDuration').value, '1600', 'the unsaved edit is kept');
  assert.ok(p.$('.je-save-dock').classList.contains('je-dirty'));
  p.choose('#ToastDuration', '1500');
  await p.flush(20);
  assert.ok(p.$('.je-save-dock').classList.contains('je-dirty'), '1500 differs from what the server holds now');
  await p.save();
  assert.equal(p.server.config.ToastDuration, 1500);
});

test('R11-5: a kept edit changed to what the server holds now is no change', async t => {
  const p = configPage(t, { config: config() });
  await p.pageshow();
  p.choose('#ToastDuration', '1600');
  p.server.config.ToastDuration = 1700;
  await p.pageshow();
  await p.flush(30);
  p.choose('#ToastDuration', '1700');
  await p.flush(20);
  assert.ok(!p.$('.je-save-dock').classList.contains('je-dirty'), 'the form holds what the server holds');
});

test('R11-6: a failed read again of a refresh dropped during a save shows the page may be out of date', async t => {
  let offline = false;
  const server = { config: config() };
  const p = configPage(t, { server, overrides: {
    pluginConfig: [kind => kind === 'getPluginConfiguration', () => {
      if (offline) throw new Error('offline');
      return structuredClone(server.config);
    }]
  } });
  await p.pageshow();
  p.choose('#ToastDuration', '1600');
  const release = p.server.holdWrite();
  p.$('#JellyfinEnhancedForm').dispatchEvent(new p.window.Event('submit', { cancelable: true }));
  await p.flush();
  p.server.config.HelpPanelAutocloseDelay = 20000;
  await p.pageshow();
  // The read again after the save fails (and so does the redraw of the saved fields).
  offline = true;
  release();
  await p.flush(60);
  assert.equal(p.server.config.HelpPanelAutocloseDelay, 20000);
  assert.equal(p.$('#HelpPanelAutocloseDelay').value, '15000', 'the older value is still shown');
  const warning = p.$('#je-config-read-warning');
  assert.notEqual(warning.style.display, 'none', 'the page says it may be out of date');
  assert.match(p.$('#je-config-read-warning-msg').textContent, /may show values older/);
  assert.equal(p.$('#je-config-read-warning-title').textContent, 'Settings may be out of date');
  assert.ok(p.$('.je-save-dock').classList.contains('je-stale'), 'the save marker is not shown as clean');
  // Retry reads the saved settings and clears it.
  offline = false;
  p.$('#je-config-read-retry-btn').click();
  await p.flush(60);
  assert.equal(p.$('#HelpPanelAutocloseDelay').value, '20000');
  assert.equal(warning.style.display, 'none');
  assert.ok(!p.$('.je-save-dock').classList.contains('je-stale'));
});

test('R11-6 control: overlapping refreshes settle without a read loop and keep an unsaved edit', async t => {
  const p = configPage(t, { config: config() });
  await p.pageshow();
  p.choose('#ToastDuration', '1600');
  const held = p.hold('pluginConfig');
  await p.pageshow();
  await held.reached;
  await p.pageshow();
  await held.resolve({ ...p.server.config });
  await p.flush(60);
  const count = p.requests.length;
  await p.flush(60);
  assert.equal(p.requests.length, count, 'no continued requests once refreshed');
  assert.equal(p.$('#ToastDuration').value, '1600');
  assert.ok(p.$('.je-save-dock').classList.contains('je-dirty'));
  assert.ok(!p.$('.je-save-dock').classList.contains('je-stale'));
});
