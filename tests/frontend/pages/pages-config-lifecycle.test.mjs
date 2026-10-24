import test from 'node:test';
import assert from 'node:assert/strict';
import { configPage } from '../helpers/config-page.mjs';

// Stage 1 fix round 10: the configuration page's read, save and unsaved-changes lifecycle. A configuration read that
// overlaps any save (one that failed too) is not drawn and is read again once the saves are done; a read that is drawn
// keeps every field the administrator changed and hasn't saved (still marked unsaved); and leaving the page warns while a
// save is out. (RBS1-R10-7: a read overlapping a failed save erased the edits; R10-11: a slow save cleared the warning;
// R10-12: a refresh dropped for overlapping a save left older values shown as saved.)
const BASE = { JellyseerrUrls: '', JellyseerrUrlMappings: '', Shortcuts: [], ToastDuration: 1500, HelpPanelAutocloseDelay: 15000 };
const open = (t, config = {}) => configPage(t, { config: { ...BASE, ...config } });
const submit = p => p.$('#JellyfinEnhancedForm').dispatchEvent(new p.window.Event('submit', { cancelable: true }));
const dirty = p => p.$('.je-save-dock').classList.contains('je-dirty');
const leaving = p => {
  const event = new p.window.Event('beforeunload', { cancelable: true });
  p.window.dispatchEvent(event);
  return event.defaultPrevented;
};

test('R10-7: a configuration read overlapping a failed save keeps the unsaved edit', async t => {
  const p = open(t);
  await p.pageshow();
  p.choose('#ToastDuration', '1600');
  p.server.failWrites = true;
  const release = p.server.holdWrite();
  submit(p);
  await p.flush();
  const read = p.hold('pluginConfig');
  await p.pageshow();
  await read.reached;
  release();
  await p.flush(40);
  assert.equal(p.$('#ToastDuration').value, '1600');
  assert.ok(dirty(p));
  await read.resolve({ ...p.server.config });
  await p.flush(40);
  assert.equal(p.$('#ToastDuration').value, '1600', 'the edit the failed save didn\'t store is still on the form');
  assert.ok(dirty(p), 'and still marked unsaved');
  p.server.failWrites = false;
  await p.save();
  assert.equal(p.server.config.ToastDuration, 1600);
});

test('R10-12: a refresh dropped because it overlapped a save is read again after the save', async t => {
  const p = open(t);
  await p.pageshow();
  p.choose('#ToastDuration', '1600');
  const release = p.server.holdWrite();
  submit(p);
  await p.flush();
  // Another administrator saved meanwhile; this page is shown again while its own save is out.
  p.server.config.HelpPanelAutocloseDelay = 20000;
  await p.pageshow();
  release();
  await p.flush(60);
  assert.equal(p.server.config.ToastDuration, 1600);
  assert.equal(p.server.config.HelpPanelAutocloseDelay, 20000);
  assert.equal(p.$('#HelpPanelAutocloseDelay').value, '20000', 'the other administrator\'s value is shown');
  assert.ok(!dirty(p), 'and as saved');
});

test('R10-7: a refresh that is drawn keeps the field the administrator changed and shows the others as stored', async t => {
  const p = open(t);
  await p.pageshow();
  p.choose('#ToastDuration', '1600');
  await p.flush();
  p.server.config.HelpPanelAutocloseDelay = 20000;
  p.server.config.ToastDuration = 1550;
  await p.pageshow();
  await p.flush(20);
  assert.equal(p.$('#ToastDuration').value, '1600', 'the unsaved edit stays');
  assert.equal(p.$('#HelpPanelAutocloseDelay').value, '20000', 'what changed on the server is shown');
  assert.ok(dirty(p));
  const saved = await p.save();
  assert.equal(saved.ToastDuration, 1600);
  assert.equal(saved.HelpPanelAutocloseDelay, 20000);
  assert.deepEqual(Object.keys(p.patches.at(-1).Set), ['ToastDuration'], 'only the administrator\'s change is sent');
});

test('R10-11: leaving the page warns while a save is out, and not once it is stored', async t => {
  const p = open(t);
  await p.pageshow();
  p.choose('#ToastDuration', '1600');
  await p.flush();
  assert.ok(leaving(p), 'an unsaved change warns');
  const release = p.server.holdWrite();
  submit(p);
  await p.flush();
  assert.ok(leaving(p), 'the save is not answered yet: leaving still warns');
  release();
  await p.flush(40);
  assert.equal(p.server.config.ToastDuration, 1600);
  assert.ok(!leaving(p), 'stored: no warning');
});

test('R10-11: a failed save keeps the warning', async t => {
  const p = open(t);
  await p.pageshow();
  p.choose('#ToastDuration', '1600');
  p.server.failWrites = true;
  await p.save();
  assert.ok(dirty(p));
  assert.ok(leaving(p));
});

// int12 live smoke: the once-a-second unsaved-changes check outlived the page. Once Jellyfin removed the page (the
// administrator went to another page), each tick read the gone form's fields and threw, once a second until a reload.
test('leaving the page stops its unsaved-changes check', async t => {
  const p = open(t);
  await p.pageshow();
  p.choose('#ToastDuration', '1600');
  await p.flush();
  assert.ok(dirty(p));
  p.$('#JellyfinEnhancedPage').remove();
  await new Promise(r => p.window.setTimeout(r, 2300));
  await p.flush();
  assert.deepEqual(p.errors.map(String), [], 'no tick runs against the removed page');
});

test('a page shown again checks for unsaved changes again', async t => {
  const p = open(t);
  await p.pageshow();
  const page = p.$('#JellyfinEnhancedPage');
  const parent = page.parentNode;
  page.remove();
  await new Promise(r => p.window.setTimeout(r, 1300));
  parent.appendChild(page);
  await p.pageshow();
  // A value set without an input or change event (a script's own fill) is only seen by the tick.
  p.$('#ToastDuration').value = '1700';
  await new Promise(r => p.window.setTimeout(r, 1300));
  await p.flush();
  assert.ok(dirty(p), 'the tick runs again');
  assert.deepEqual(p.errors.map(String), []);
});
