import { clickAsViewer } from '../helpers/harness.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { configPage } from '../helpers/config-page.mjs';

// Stage 1 fix round 8: the configuration page compares against what the server last handed out (a read or a save's
// answer); an edit is anything that makes the form say something else (typed, a card removed, a list reset), and a redraw
// that waited for the server checks for edits made meanwhile right before it applies. Whole page, its own scripts, a
// scripted server (helpers/config-page.mjs applies patches with the server's rules).
const BASE = { JellyseerrUrls: '', JellyseerrUrlMappings: '', Shortcuts: [] };
const open = (t, config, options = {}) => configPage(t, { config: { ...BASE, ...config }, ...options });
const submit = p => p.$('#JellyfinEnhancedForm').dispatchEvent(new p.window.Event('submit', { cancelable: true }));
const R1 = '11111111-1111-4111-8111-111111111111', R2 = '22222222-2222-4222-8222-222222222222';
const radarr = (...rows) => JSON.stringify(rows.map(row => ({ Url: 'http://radarr.test', ApiKey: 'k', UrlMappings: '', Enabled: true, ...row })));
const rows = config => JSON.parse(config.RadarrInstances || '[]');
const dirty = p => p.$('.je-save-dock').classList.contains('je-dirty');
const wait = (p, ms) => new Promise(r => p.window.setTimeout(r, ms));

// RBS1-R8-2: after a save the page reads the configuration again and redraws the credentials and *arr cards. It checked
// for edits before that read and not after: an edit made while the read ran was drawn over, and the next save kept the
// old value.
test('R8-2: an instance renamed while the post-save read runs keeps its new name, and the next save stores it', async t => {
  const p = open(t, { ToastDuration: 1500, RadarrInstances: radarr({ Id: R1, Name: 'Movies' }) });
  await p.pageshow();
  p.choose('#ToastDuration', '1600');
  const read = p.hold('pluginConfig');
  submit(p);
  await read.reached;
  p.choose(p.$('#radarrInstancesList .arr-instance-name'), 'Films');
  await read.resolve();
  await p.flush(20);
  assert.equal(p.$('#radarrInstancesList .arr-instance-name').value, 'Films', 'the edit is still on screen');
  assert.ok(dirty(p), 'and shows as unsaved');
  await p.save();
  assert.equal(rows(p.server.config)[0].Name, 'Films');
  assert.equal(p.server.config.ToastDuration, 1600);
});

test('R8-2: a key typed while the post-save read runs stays typed and is saved next; the other credentials are redrawn', async t => {
  const p = open(t, { ToastDuration: 1500, TMDB_API_KEY: '', MdblistApiKey: '' });
  await p.pageshow();
  p.choose('#mdblistApiKey', 'mdb-typed-before');
  const read = p.hold('pluginConfig');
  submit(p);
  await read.reached;
  p.choose('#TMDB_API_KEY', 'tmdb-typed-during');
  // The server keeps only a placeholder of a saved key (what its read hands out).
  p.server.config.MdblistApiKey = '••••••••3f9a';
  await read.resolve();
  await p.flush(20);
  assert.equal(p.$('#TMDB_API_KEY').value, 'tmdb-typed-during');
  assert.notEqual(p.$('#mdblistApiKey').value, 'mdb-typed-before', 'a key saved by this save is shown as saved, not as typed');
  assert.equal(p.$('#mdblistApiKey').dataset.jeSecretToken, '••••••••3f9a');
  await p.save();
  assert.equal(p.server.config.TMDB_API_KEY, 'tmdb-typed-during');
});

// RBS1-R8-5: "Reset Radarr instances" on an unreadable stored list could not be expressed as a change: nothing was sent,
// the unreadable value and the banner came back.
const CORRUPT = '{"Id": "broken", [unreadable';
test('R8-5: a confirmed reset of an unreadable Radarr list is saved; the banner is gone after a reload; an untouched unreadable Sonarr list stays', async t => {
  const p = open(t, { RadarrInstances: CORRUPT, RadarrUrl: 'http://old.test', RadarrApiKey: 'old', SonarrInstances: CORRUPT });
  await p.pageshow();
  assert.ok(p.$('#radarrInstancesList .arr-corrupt-banner'));
  clickAsViewer(p.$('#radarrInstancesList .arr-corrupt-banner button'));
  await wait(p, 600);
  assert.ok(dirty(p), 'the confirmed reset shows as unsaved');
  await p.save();
  assert.equal(p.server.config.RadarrInstances, '[]');
  assert.equal(p.server.config.RadarrUrl, '');
  assert.equal(p.server.config.SonarrInstances, CORRUPT, 'the Sonarr list nobody reset keeps its bytes');
  const reloaded = configPage(t, { server: p.server });
  await reloaded.pageshow();
  assert.equal(reloaded.$('#radarrInstancesList .arr-corrupt-banner'), null);
  assert.ok(reloaded.$('#sonarrInstancesList .arr-corrupt-banner'));
});

test('R8-5: a reset followed by a new instance in the same save stores that instance', async t => {
  const p = open(t, { RadarrInstances: CORRUPT });
  await p.pageshow();
  clickAsViewer(p.$('#radarrInstancesList .arr-corrupt-banner button'));
  clickAsViewer(p.$('#addRadarrInstance'));
  const card = p.$('#radarrInstancesList .arr-instance-card');
  p.choose(card.querySelector('.arr-instance-name'), 'New');
  p.choose(card.querySelector('.arr-instance-url'), 'http://new.test');
  p.choose(card.querySelector('.arr-instance-apikey'), 'new-key');
  await p.save();
  assert.deepEqual(rows(p.server.config).map(r => [r.Name, r.Url]), [['New', 'http://new.test']]);
  assert.equal(p.server.config.RadarrUrl, 'http://new.test');
});

test('R8-5: a reset is not applied over a list another writer repaired meanwhile; the page says so', async t => {
  const p = open(t, { RadarrInstances: CORRUPT });
  await p.pageshow();
  clickAsViewer(p.$('#radarrInstancesList .arr-corrupt-banner button'));
  const repaired = radarr({ Id: R2, Name: 'Repaired' });
  p.server.beforeWrite = server => { server.config.RadarrInstances = repaired; };
  p.server.beforeWrite = (fn => { let done = false; return s => { if (!done) { done = true; fn(s); } }; })(p.server.beforeWrite);
  await p.save();
  assert.equal(p.server.config.RadarrInstances, repaired);
  assert.match(p.alerts.map(a => a.message || '').join('\n'), /Radarr/);
});

test('R8-5 control: saving other settings never touches an unreadable list nobody reset', async t => {
  const p = open(t, { ToastDuration: 1500, RadarrInstances: CORRUPT });
  await p.pageshow();
  p.choose('#ToastDuration', '1700');
  await p.save();
  assert.equal(p.server.config.RadarrInstances, CORRUPT);
  assert.equal(p.server.config.ToastDuration, 1700);
});

// RBS1-R8-6: the page marked the form saved again 0.5 s after the read unless an input or change event came: removing a
// card fires neither, so the dock showed no unsaved changes while the form and the server differed.
test('R8-6: an instance removed right after the page loaded shows as unsaved, and the save removes it', async t => {
  const p = open(t, { RadarrInstances: radarr({ Id: R1, Name: 'One' }, { Id: R2, Name: 'Two' }) });
  await p.pageshow();
  clickAsViewer(p.$('#radarrInstancesList .arr-instance-card .arr-instance-remove'));
  await wait(p, 800);
  assert.ok(dirty(p), 'the removal shows as unsaved');
  await p.save();
  assert.deepEqual(rows(p.server.config).map(r => r.Name), ['Two']);
  await wait(p, 50);
  assert.equal(dirty(p), false, 'saved: nothing left unsaved');
});

test('R8-6 control: an untouched page stays clean after its late lists settle, and an edit undone is clean again', async t => {
  const p = open(t, { ToastDuration: 1500, MaintenanceModeAffectedUsers: '["u1"]', RadarrInstances: radarr({ Id: R1, Name: 'One' }) });
  await p.pageshow();
  await wait(p, 800);
  assert.equal(dirty(p), false);
  p.choose('#ToastDuration', '1600');
  await p.flush(2);
  assert.ok(dirty(p));
  p.choose('#ToastDuration', '1500');
  await p.flush(2);
  assert.equal(dirty(p), false);
});
