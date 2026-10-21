import test from 'node:test';
import assert from 'node:assert/strict';
import { configPage } from '../helpers/config-page.mjs';

// Stage 1 fix round 9: while a save is out, the configuration page compares the form with what the server will hold once
// that save is answered (what it last answered + the save's own snapshot), so a value changed back during the save shows
// as unsaved and the next save sends it; and a configuration read that began before a save was answered (or before a
// value the server now holds was taken) is not drawn over it. Whole page, its own scripts, a scripted server.
const BASE = { JellyseerrUrls: '', JellyseerrUrlMappings: '', Shortcuts: [] };
const open = (t, config, options = {}) => configPage(t, { config: { ...BASE, ...config }, ...options });
const submit = p => p.$('#JellyfinEnhancedForm').dispatchEvent(new p.window.Event('submit', { cancelable: true }));
const dirty = p => p.$('.je-save-dock').classList.contains('je-dirty');

test('R9-1: a field changed back while its save is out shows as unsaved, and the next save stores it', async t => {
  const p = open(t, { ToastDuration: 1500 });
  await p.pageshow();
  p.choose('#ToastDuration', '1600');
  const release = p.server.holdWrite();
  submit(p);
  await p.flush();
  p.choose('#ToastDuration', '1500');
  await p.flush();
  assert.ok(dirty(p), 'the server will hold 1600: the form (1500) is unsaved');
  release();
  await p.flush(40);
  assert.equal(p.server.config.ToastDuration, 1600);
  assert.ok(dirty(p));
  await p.save();
  assert.equal(p.server.config.ToastDuration, 1500);
  assert.ok(!dirty(p));
});

test('R9-1: an asynchronously filled field changed back while its save is out shows as unsaved, and the next save stores it', async t => {
  const p = open(t, { DefaultLanguage: 'de' });
  await p.pageshow();
  p.choose('#DefaultLanguage', 'fr');
  const release = p.server.holdWrite();
  submit(p);
  await p.flush();
  p.choose('#DefaultLanguage', 'de');
  await p.flush();
  assert.ok(dirty(p), 'the server will hold fr');
  release();
  await p.flush(40);
  assert.equal(p.server.config.DefaultLanguage, 'fr');
  await p.save();
  assert.equal(p.server.config.DefaultLanguage, 'de');
  assert.ok(!dirty(p));
});

test('R9-1 control: Save pressed again after the change back, while the first save is out: the server ends with the form', async t => {
  const p = open(t, { ToastDuration: 1500 });
  await p.pageshow();
  p.choose('#ToastDuration', '1600');
  const release = p.server.holdWrite();
  submit(p);
  await p.flush();
  p.choose('#ToastDuration', '1500');
  submit(p);
  await p.flush();
  release();
  await p.flush(60);
  assert.equal(p.server.config.ToastDuration, 1500);
  assert.ok(!dirty(p));
});

test('R9-1: a page left untouched while its save is out shows as saved during and after (the save carries what it says)', async t => {
  const p = open(t, { ToastDuration: 1500 });
  await p.pageshow();
  p.choose('#ToastDuration', '1600');
  const release = p.server.holdWrite();
  submit(p);
  await p.flush();
  assert.ok(!dirty(p), 'what the form says is on its way');
  release();
  await p.flush(40);
  assert.ok(!dirty(p));
  assert.equal(p.server.config.ToastDuration, 1600);
});

test('R9-3: a configuration read that began before a save was answered is not drawn over the saved value', async t => {
  const p = open(t, { ToastDuration: 1500 });
  await p.pageshow();
  const older = JSON.parse(JSON.stringify(p.server.config));
  const read = p.hold('pluginConfig');
  await p.pageshow(); // the page is shown again: it reads the configuration
  await read.reached;
  p.choose('#ToastDuration', '1600');
  await p.save();
  assert.equal(p.server.config.ToastDuration, 1600);
  await read.resolve(older);
  await p.flush(20);
  assert.equal(p.$('#ToastDuration').value, '1600', 'the older read is not drawn over the answer');
  assert.ok(!dirty(p));
});

test('R9-3 control: a configuration read after the save shows another administrator\'s change', async t => {
  const p = open(t, { ToastDuration: 1500, HelpPanelAutocloseDelay: 15000 });
  await p.pageshow();
  p.choose('#ToastDuration', '1600');
  await p.save();
  p.server.config.HelpPanelAutocloseDelay = 20000; // another administrator
  await p.pageshow();
  await p.flush(20);
  assert.equal(p.$('#ToastDuration').value, '1600');
  assert.equal(p.$('#HelpPanelAutocloseDelay').value, '20000');
  assert.ok(!dirty(p));
});
