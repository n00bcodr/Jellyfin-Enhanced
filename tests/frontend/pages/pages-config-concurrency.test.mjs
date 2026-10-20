import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { configPage, configPagePath, FOLDERS } from '../helpers/config-page.mjs';
import { FIELDS } from '../helpers/config-page-fields.mjs';

// Stage 1 fix round 7: the configuration page's save sends only what the administrator changed, and the server applies it
// to the configuration it holds then. Another writer (an administrator in another tab, the Household tab, a server write)
// that lands between the page's read and its save keeps its value unless this page changed that same field. Whole page,
// its own scripts, a scripted server (`server.beforeWrite` is the other writer, landing just before the page's write
// arrives; `server.holdWrite()` holds a write; `server.failWrites` fails them); the stored bytes are asserted.
const BASE = { JellyseerrUrls: '', JellyseerrUrlMappings: '', Shortcuts: [] };
const open = (t, config, options = {}) => configPage(t, { config: { ...BASE, ...config }, ...options });
const once = fn => { let done = false; return server => { if (!done) { done = true; fn(server); } }; };
const submit = p => p.$('#JellyfinEnhancedForm').dispatchEvent(new p.window.Event('submit', { cancelable: true }));
const R1 = '11111111-1111-4111-8111-111111111111', R2 = '22222222-2222-4222-8222-222222222222';
const radarr = (...rows) => JSON.stringify(rows.map(row => ({ Url: 'http://radarr.test', ApiKey: 'k', UrlMappings: '', Enabled: true, ...row })));
const rows = config => JSON.parse(config.RadarrInstances || '[]');

// RBS1-R7-1: an untouched asynchronously filled field another writer changed before the save arrived.
test('R7-1: an untouched Default UI Language read as "de" keeps the "fr" another writer stored before the save arrived', async t => {
  const p = open(t, { DefaultLanguage: 'de', ToastDuration: 1500 });
  await p.pageshow();
  p.choose('#ToastDuration', '3000');
  p.server.beforeWrite = once(server => { server.config.DefaultLanguage = 'fr'; });
  await p.save();
  assert.equal(p.server.config.DefaultLanguage, 'fr');
  assert.equal(p.server.config.ToastDuration, 3000);
});

// RBS1-R7-2: synchronous controls are written only when the administrator changed them.
test('R7-2: an untouched synchronous control (MaintenanceScheduleEnabled) keeps the newer value another writer stored', async t => {
  const p = open(t, { MaintenanceScheduleEnabled: false, ToastDuration: 1500 });
  await p.pageshow();
  p.choose('#ToastDuration', '3000');
  p.server.beforeWrite = once(server => { server.config.MaintenanceScheduleEnabled = true; });
  await p.save();
  assert.equal(p.server.config.MaintenanceScheduleEnabled, true);
  assert.equal(p.server.config.ToastDuration, 3000);
});

// Every field the form writes from a synchronous control (`config.X = …` in the save): another writer changes all of them
// before the save arrives; the administrator changed one. Only that one is the page's.
const pageSource = readFileSync(configPagePath, 'utf8');
const NOT_FORM = new Set(['SonarrInstances', 'RadarrInstances', 'SonarrUrl', 'SonarrApiKey', 'SonarrUrlMappings', 'RadarrUrl', 'RadarrApiKey',
  'RadarrUrlMappings', 'ArrServerOwnedSeen', 'ClearLocalStorageTimestamp']);
const SYNC_FIELDS = [...new Set([...pageSource.matchAll(/\bconfig\.([A-Za-z_][A-Za-z0-9_]*)\s*=(?!=)/g)].map(m => m[1]))].filter(f => !NOT_FORM.has(f));
test(`every synchronous form field (${SYNC_FIELDS.length}) keeps another writer's value unless the administrator changed it`, async t => {
  assert.ok(SYNC_FIELDS.length > 300, 'the save writes a few hundred fields from controls');
  const p = open(t, { ToastDuration: 1500 });
  await p.pageshow();
  p.choose('#ToastDuration', '4321');
  const other = Object.fromEntries(SYNC_FIELDS.filter(f => f !== 'ToastDuration').map(f => [f, 'other writer: ' + f]));
  p.server.beforeWrite = once(server => Object.assign(server.config, other));
  await p.save();
  const lost = Object.keys(other).filter(f => p.server.config[f] !== other[f]);
  assert.equal(lost.length, 0, `fields the page overwrote: ${lost.slice(0, 40).join(', ')}${lost.length > 40 ? ' …' : ''}`);
  assert.equal(p.server.config.ToastDuration, 4321);
});

// Every registered asynchronously filled field (round 6's list), loaded and untouched: another writer's value survives.
const OTHER = {
  MaintenanceModeAffectedUsers: '["u3"]', TagCacheExcludedLibraryIds: FOLDERS[2].ItemId, SpoilerAutoEnableLibraryIds: FOLDERS[1].ItemId,
  JellyseerrImportBlockedUsers: 'gran', DefaultLanguage: 'fr', QualityTagsPreferredAudioLanguage: 'de', DEFAULT_REGION: 'AT',
  AutoMovieRequestCustomServerId: 0, AutoMovieRequestCustomProfileId: 4, AutoMovieRequestCustomRootFolder: '/movies'
};
for (const spec of FIELDS) {
  test(`registered field ${spec.name}: loaded and untouched, another writer's value survives the save`, async t => {
    const p = open(t, { ...spec.config, ToastDuration: 1500 });
    await p.pageshow();
    if (spec.prepare) await spec.prepare(p);
    p.choose('#ToastDuration', '3000');
    if (spec.field.startsWith('RadarrInstances')) {
      const key = spec.field.endsWith('Defaults') ? 'Defaults' : 'LinkedLibraryIds';
      const value = key === 'Defaults' ? { QualityProfileId: 9, RootFolderPath: '/other', Tags: [7] } : ['other0000'];
      p.server.beforeWrite = once(server => { const list = rows(server.config); list[0][key] = value; server.config.RadarrInstances = JSON.stringify(list); });
      await p.save();
      assert.deepEqual(rows(p.server.config)[0][key], value);
    } else {
      p.server.beforeWrite = once(server => { server.config[spec.field] = OTHER[spec.field]; });
      await p.save();
      assert.equal(JSON.stringify(p.server.config[spec.field]), JSON.stringify(OTHER[spec.field]));
    }
    assert.equal(p.server.config.ToastDuration, 3000);
  });
}

// RBS1-R7-3: an unchanged *arr card is never sent; a changed one sends only its changed fields, by id.
test('R7-3: an unchanged card keeps what another writer changed (links, add defaults, an unshown Seerr server); a changed card sends only its change', async t => {
  const p = open(t, { RadarrInstances: radarr(
    { Id: R1, Name: 'Radarr', LinkedLibraryIds: [FOLDERS[0].ItemId], Defaults: { QualityProfileId: 4, RootFolderPath: '/data/movies', Tags: [2] }, SeerrServerId: 0 },
    { Id: R2, Name: 'Radarr 4K', Url: 'http://radarr4k.test', LinkedLibraryIds: [], SeerrServerId: 1 }) });
  await p.pageshow();
  p.choose(p.document.querySelectorAll('#radarrInstancesList .arr-instance-name')[1], 'Movies 4K');
  p.server.beforeWrite = once(server => {
    const list = rows(server.config);
    list[0].LinkedLibraryIds = [FOLDERS[0].ItemId, FOLDERS[1].ItemId];
    list[0].Defaults.QualityProfileId = 5;
    list[0].SeerrServerId = 3;
    list[1].SeerrServerId = 4;
    server.config.RadarrInstances = JSON.stringify(list);
  });
  await p.save();
  const [r1, r2] = rows(p.server.config);
  assert.deepEqual(r1.LinkedLibraryIds, [FOLDERS[0].ItemId, FOLDERS[1].ItemId]);
  assert.equal(r1.Defaults.QualityProfileId, 5);
  assert.equal(r1.SeerrServerId, 3);
  assert.equal(r2.Name, 'Movies 4K');
  assert.equal(r2.SeerrServerId, 4, 'the changed card carries only its changed field');
});

test('R7-3: another writer added an instance and this page removed one: both happen; one this page changed but another writer removed is reported', async t => {
  const p = open(t, { RadarrInstances: radarr({ Id: R1, Name: 'Radarr' }, { Id: R2, Name: 'Radarr 4K' }) });
  await p.pageshow();
  p.document.querySelector('#radarrInstancesList .arr-instance-card .arr-instance-remove').click(); // removes R1
  assert.equal(p.document.querySelectorAll('#radarrInstancesList .arr-instance-card').length, 1);
  p.choose(p.document.querySelector('#radarrInstancesList .arr-instance-name'), 'Changed');
  const R3 = '33333333-3333-4333-8333-333333333333';
  p.server.beforeWrite = once(server => {
    const list = rows(server.config).filter(row => row.Id !== R2); // another administrator removed R2
    list.push({ Id: R3, Name: 'Added elsewhere', Url: 'http://r3.test', ApiKey: 'k', UrlMappings: '', Enabled: true });
    server.config.RadarrInstances = JSON.stringify(list);
  });
  await p.save();
  assert.deepEqual(rows(p.server.config).map(row => row.Id), [R3]);
  assert.match(p.alerts.at(-1)?.message || '', /another administrator removed or re-added/);
});

test('two admin tabs saving different settings and cards, in either order: every change survives', async t => {
  for (const order of [['a', 'b'], ['b', 'a']]) {
    const server = { config: { ...BASE, ToastDuration: 1500, DefaultLanguage: 'de', RadarrInstances: radarr({ Id: R1, Name: 'Radarr' }, { Id: R2, Name: 'Radarr 4K' }) } };
    const tabs = { a: configPage(t, { server }), b: configPage(t, { server }) };
    await tabs.a.pageshow();
    await tabs.b.pageshow();
    tabs.a.choose('#ToastDuration', '2500');
    tabs.a.choose(tabs.a.document.querySelectorAll('#radarrInstancesList .arr-instance-name')[0], 'A name');
    tabs.b.choose('#DefaultLanguage', 'ja');
    tabs.b.choose(tabs.b.document.querySelectorAll('#radarrInstancesList .arr-instance-url')[1], 'http://b.test');
    for (const tab of order) await tabs[tab].save();
    assert.equal(server.config.ToastDuration, 2500, order.join());
    assert.equal(server.config.DefaultLanguage, 'ja', order.join());
    const [r1, r2] = rows(server.config);
    assert.equal(r1.Name, 'A name', order.join());
    assert.equal(r2.Url, 'http://b.test', order.join());
  }
});

// RBS1-R7-5: Import Users Now saves first and imports only once that save is stored; a running save is waited for.
const importCalls = p => p.requests.filter(r => r.url.includes('jellyseerr/import-users'));
// The import button is usable once Seerr is set up.
const SEERR = { JellyseerrEnabled: true, JellyseerrUrls: 'http://seerr.test', JellyseerrApiKey: 'k', JellyseerrAutoImportUsers: true };
test('R7-5: Import Users Now whose save fails imports nothing and says so', async t => {
  const p = open(t, { ...SEERR, JellyseerrImportBlockedUsers: 'aa11' });
  await p.pageshow();
  p.server.failWrites = true;
  p.$('#btnImportJellyseerrUsers').click();
  await p.flush(30);
  assert.equal(importCalls(p).length, 0);
  assert.match(p.$('#importUsersResult').textContent, /Import was not attempted/);
});

test('R7-5: Import Users Now during a running save waits for it, then saves and imports with the blocklist as saved', async t => {
  const p = open(t, { ...SEERR, JellyseerrImportBlockedUsers: 'aa11', ToastDuration: 1500 });
  await p.pageshow();
  p.choose('#ToastDuration', '2000');
  const release = p.server.holdWrite();
  submit(p);
  await p.flush();
  p.$('#btnImportJellyseerrUsers').click();
  await p.flush(30);
  assert.equal(importCalls(p).length, 0, 'not while the save runs');
  release();
  await p.flush(40);
  assert.equal(importCalls(p).length, 1);
  assert.equal(p.server.config.ToastDuration, 2000);
  const importAt = p.requests.findIndex(r => r.url.includes('jellyseerr/import-users'));
  const lastWrite = p.requests.map((r, i) => (r.type === 'PATCH' && /\/configuration$/.test(r.url)) ? i : -1).filter(i => i >= 0).at(-1);
  if (lastWrite !== undefined) assert.ok(lastWrite < importAt, 'the import follows its own save');
});

test('Apply to all users: a failing save resets nobody; during a running save it waits, saves, then resets', async t => {
  const p = open(t, { ToastDuration: 1500 });
  await p.pageshow();
  const resets = () => p.posts.filter(x => x.url.includes('reset-all-users-settings')).length;
  p.server.failWrites = true;
  p.$('#resetAllUserSettingsBtn').click();
  await p.flush(30);
  assert.equal(resets(), 0);
  p.server.failWrites = false;
  p.choose('#ToastDuration', '2200');
  const release = p.server.holdWrite();
  submit(p);
  await p.flush();
  p.$('#resetAllUserSettingsBtn').click();
  await p.flush(30);
  assert.equal(resets(), 0, 'not while the save runs');
  release();
  await p.flush(40);
  assert.equal(resets(), 1);
  assert.equal(p.server.config.ToastDuration, 2200);
});

// RBS1-R7-7: a changed flag clears only if no later edit happened since the save took its snapshot.
test('R7-7: a Default UI Language changed (fr → ja) while its save runs is saved by the next save', async t => {
  const p = open(t, { DefaultLanguage: 'de' });
  await p.pageshow();
  p.choose('#DefaultLanguage', 'fr');
  const release = p.server.holdWrite();
  submit(p);
  await p.flush();
  p.choose('#DefaultLanguage', 'ja');
  release();
  await p.flush(40);
  assert.equal(p.server.config.DefaultLanguage, 'fr');
  assert.ok(p.$('.je-save-dock').classList.contains('je-dirty'), 'the later edit shows as unsaved');
  await p.save();
  assert.equal(p.server.config.DefaultLanguage, 'ja');
});

test('R7-7 control: a synchronous control edited while its save runs is saved by the next save, and an untouched page saves nothing', async t => {
  const p = open(t, { ToastDuration: 1500 });
  await p.pageshow();
  p.choose('#ToastDuration', '1600');
  const release = p.server.holdWrite();
  submit(p);
  await p.flush();
  p.choose('#ToastDuration', '1700');
  release();
  await p.flush(40);
  assert.equal(p.server.config.ToastDuration, 1600);
  await p.save();
  assert.equal(p.server.config.ToastDuration, 1700);
  const before = JSON.stringify(p.server.config);
  p.server.beforeWrite = once(server => { server.config.ToastDuration = 9999; });
  await p.save();
  assert.equal(p.server.config.ToastDuration, 9999, 'nothing changed on the page: nothing of it is written');
  assert.notEqual(before, JSON.stringify(p.server.config));
});

// Q-REBUILD1FIX6-3: "Select specific users" with nobody ticked would be stored as [] (= every non-admin user).
test('Q-REBUILD1FIX6-3: "Select specific users" with nobody ticked is refused with the reason; the stored selection stays', async t => {
  const p = open(t, { MaintenanceModeEnabled: true, MaintenanceModeAffectedUsers: '["u1"]' });
  await p.pageshow();
  p.choose('#mmUsers_select', true);
  await p.flush();
  for (const box of p.document.querySelectorAll('.je-mm-user-cb:checked')) p.choose(box, false);
  const writes = p.saves.length;
  await p.save();
  assert.equal(p.saves.length, writes, 'nothing was saved');
  assert.equal(p.server.config.MaintenanceModeAffectedUsers, '["u1"]');
  assert.match(p.alerts.at(-1)?.message || '', /no user is ticked/);
  assert.equal(p.posts.filter(x => x.url.includes('/MaintenanceMode/Enable')).length, 0, 'no Enable call for every non-admin');
  // Ticking one user saves it.
  p.choose(p.$('.je-mm-user-cb[value="u2"]'), true);
  await p.save();
  assert.equal(p.server.config.MaintenanceModeAffectedUsers, '["u2"]');
});

test('Q-REBUILD1FIX6-3 control: "All non-admin users" still saves "all"', async t => {
  const p = open(t, { MaintenanceModeAffectedUsers: '["u1"]' });
  await p.pageshow();
  p.choose('#mmUsers_all', true);
  await p.save();
  assert.equal(p.server.config.MaintenanceModeAffectedUsers, 'all');
});
