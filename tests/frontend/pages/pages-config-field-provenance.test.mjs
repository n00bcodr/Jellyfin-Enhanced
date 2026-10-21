import test from 'node:test';
import assert from 'node:assert/strict';
import { configPage, fieldBytes } from '../helpers/config-page.mjs';

// Stage 1 fix round 6: the configuration page's asynchronously filled controls, by finding (the whole page, its own
// scripts, against a scripted server; persisted bytes asserted). The generated per-field matrix is in
// pages-config-bytes-*.test.mjs.
const BASE = { JellyseerrUrls: '', JellyseerrUrlMappings: '', Shortcuts: [] };
const open = (t, config, options = {}) => configPage(t, { config: { ...BASE, ...config }, ...options });
const enableCalls = p => p.posts.filter(x => x.url.includes('/MaintenanceMode/Enable'));
const checkedUsers = p => [...p.document.querySelectorAll('.je-mm-user-cb')].filter(cb => cb.checked).map(cb => cb.value);

// RBS1-R6-1 (upstream Maintenance Mode, #638): the server reads an empty affected-user list as every non-admin user.
for (const outcome of ['pending', 'failed']) {
  test(`R6-1: maintenance users ${outcome}: a save keeps the selection, and with maintenance on the Enable call carries it, never a wider set`, async t => {
    const p = open(t, { MaintenanceModeEnabled: true, MaintenanceModeAffectedUsers: '["u1"]', MaintenanceModeAction: 'disable_accounts' });
    const users = p.hold('mmUsers');
    await p.pageshow();
    if (outcome === 'failed') await users.reject();
    const saved = await p.save();
    assert.equal(fieldBytes(saved, 'MaintenanceModeAffectedUsers'), JSON.stringify('["u1"]'));
    const calls = enableCalls(p);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].data.affectedUserIds, ['u1']);
    if (outcome === 'failed') assert.match(p.$('#je-mm-users-inner').textContent, /Saving keeps the current selection/);
  });
}

test('R6-1: "specific users" picked while the list loads is not saved as an empty (everyone) list', async t => {
  const p = open(t, { MaintenanceModeEnabled: true, MaintenanceModeAffectedUsers: 'all' });
  const first = p.hold('mmUsers');
  await p.pageshow();
  await first.resolve();
  const again = p.hold('mmUsers'); // choosing "specific users" reads the list again
  p.choose('#mmUsers_select', true);
  await p.flush();
  const saved = await p.save();
  assert.equal(fieldBytes(saved, 'MaintenanceModeAffectedUsers'), '"all"');
  assert.deepEqual(enableCalls(p)[0].data.affectedUserIds, []);
  await again.reject();
});

test('R6-1 control: with the list loaded, the selection the admin makes is saved and sent', async t => {
  const p = open(t, { MaintenanceModeEnabled: true, MaintenanceModeAffectedUsers: '["u1"]' });
  await p.pageshow();
  assert.deepEqual(checkedUsers(p), ['u1']);
  p.choose(p.$('.je-mm-user-cb[value="u3"]'), true);
  let saved = await p.save();
  assert.equal(fieldBytes(saved, 'MaintenanceModeAffectedUsers'), JSON.stringify('["u1","u3"]'));
  assert.deepEqual(enableCalls(p).at(-1).data.affectedUserIds, ['u1', 'u3']);
  p.choose('#mmUsers_all', true);
  saved = await p.save();
  assert.equal(fieldBytes(saved, 'MaintenanceModeAffectedUsers'), '"all"');
  assert.deepEqual(enableCalls(p).at(-1).data.affectedUserIds, []);
});

// RBS1-R6-2: the custom auto-movie destination.
const CUSTOM = { AutoMovieRequestQualityMode: 'custom', AutoMovieRequestCustomServerId: 2, AutoMovieRequestCustomProfileId: 7, AutoMovieRequestCustomRootFolder: '/films' };
const destination = saved => [saved.AutoMovieRequestCustomServerId, saved.AutoMovieRequestCustomProfileId, saved.AutoMovieRequestCustomRootFolder];

test('R6-2: a save before the Radarr server list resolves keeps server 2, profile 7 and "/films"', async t => {
  const p = open(t, CUSTOM);
  p.hold('radarrServers');
  await p.pageshow();
  assert.deepEqual(destination(await p.save()), [2, 7, '/films']);
});

test('R6-2: a failed server-details request keeps profile 7 and "/films"', async t => {
  const p = open(t, CUSTOM);
  const details = p.hold('radarrDetails');
  await p.pageshow();
  await details.reject();
  assert.deepEqual(destination(await p.save()), [2, 7, '/films']);
});

test('R6-2 control: picking another server saves it with that server\'s profile and folder as chosen', async t => {
  const p = open(t, CUSTOM);
  await p.pageshow();
  assert.equal(p.$('#autoMovieRequestServer').value, '2');
  assert.equal(p.$('#autoMovieRequestProfile').value, '7');
  p.choose('#autoMovieRequestServer', '0');
  await p.flush();
  assert.deepEqual(destination(await p.save()), [0, 0, '']);
  p.choose('#autoMovieRequestProfile', '4');
  p.choose('#autoMovieRequestRootFolder', '/movies');
  assert.deepEqual(destination(await p.save()), [0, 4, '/movies']);
});

// RBS1-R6-3: the tag cache's excluded libraries after a successful list and a later reload whose list failed.
test('R6-3: after a successful list, a reload (pageshow) whose library list fails leaves the exclusions alone', async t => {
  const p = open(t, { TagCacheExcludedLibraryIds: 'aaaa0000000000000000000000000001' });
  await p.pageshow();
  assert.equal(p.document.querySelectorAll('#tagCacheExcludedLibraryList input:checked').length, 1);
  const folders = p.hold('virtualFolders');
  await p.pageshow();
  await folders.reject();
  assert.equal(p.document.querySelectorAll('#tagCacheExcludedLibraryList input').length, 0);
  const saved = await p.save();
  assert.equal(fieldBytes(saved, 'TagCacheExcludedLibraryIds'), '"aaaa0000000000000000000000000001"');
});

// RBS1-R6-4: a choice made while the language list loads survives the list's arrival.
for (const [label, id, route, stored] of [['Default UI Language', 'DefaultLanguage', 'locales', 'de'], ['sound-tag audio language', 'qualityTagsPreferredAudioLanguage', 'cultures', 'ja']]) {
  test(`R6-4: ${label}: a choice made while the list loads is what gets saved`, async t => {
    let list;
    const field = id === 'DefaultLanguage' ? 'DefaultLanguage' : 'QualityTagsPreferredAudioLanguage';
    const p = open(t, { [field]: stored }, { before: page => { list = page.hold(route); } });
    await p.pageshow();
    assert.equal(p.$('#' + id).value, stored);
    p.choose('#' + id, '');
    await list.resolve();
    assert.equal(p.$('#' + id).value, '', 'the list did not put the stored value back');
    assert.equal(fieldBytes(await p.save(), field), '""');
  });
}

// RBS1-R6-5: temporary options never accumulate.
test('R6-5: stored values applied one after another while the list failed leave at most one temporary option', async t => {
  let list;
  const p = open(t, { DefaultLanguage: 'de' }, { before: page => { list = page.hold('locales'); } });
  await p.pageshow();
  await list.reject();
  const temporary = () => [...p.document.querySelectorAll('#DefaultLanguage option[data-je-placeholder]')].map(o => o.value);
  assert.deepEqual(temporary(), ['de']);
  p.server.config.DefaultLanguage = 'fr';
  await p.pageshow();
  assert.deepEqual(temporary(), ['fr']);
  assert.equal(p.$('#DefaultLanguage').value, 'fr');
  p.server.config.DefaultLanguage = '';
  await p.pageshow();
  assert.deepEqual(temporary(), []);
  assert.equal(p.$('#DefaultLanguage').value, '');
});

test('R6-5: the real option replaces the temporary one when the list arrives; picking another removes it', async t => {
  let list;
  const p = open(t, { DefaultLanguage: 'de' }, { before: page => { list = page.hold('locales'); } });
  await p.pageshow();
  assert.equal(p.document.querySelectorAll('#DefaultLanguage option[data-je-placeholder]').length, 1);
  await list.resolve();
  assert.equal(p.document.querySelectorAll('#DefaultLanguage option[data-je-placeholder]').length, 0);
  assert.equal(p.document.querySelectorAll('#DefaultLanguage option[value="de"]').length, 1);
  p.server.config.DefaultLanguage = 'en-AU';
  await p.pageshow();
  assert.equal(p.document.querySelectorAll('#DefaultLanguage option[data-je-placeholder]').length, 1);
  p.choose('#DefaultLanguage', 'fr');
  assert.equal(p.document.querySelectorAll('#DefaultLanguage option[data-je-placeholder]').length, 0);
});

// Q-REBUILD1FIX5-1 (configuration page): no whole save before one read of the configuration succeeded.
test('Q-REBUILD1FIX5-1: when the configuration read fails, saving and "Apply to all users" refuse and say why', async t => {
  const p = open(t, { DefaultLanguage: 'de', MaintenanceModeAffectedUsers: '["u1"]' });
  const read = p.hold('pluginConfig');
  await p.pageshow();
  await read.reject();
  const banner = p.$('#je-config-read-warning');
  assert.equal(banner.style.display, '');
  assert.match(banner.textContent, /could not read its saved settings/);
  assert.equal(await p.save(), null, 'nothing was sent');
  assert.equal(p.alerts.at(-1).title, 'Settings not saved');
  p.$('#resetAllUserSettingsBtn').click();
  await p.flush();
  assert.equal(p.saves.length, 0);
  assert.equal(p.posts.filter(x => x.url.includes('reset-all-users-settings')).length, 0);
  // Retry: the read succeeds, the banner goes and saving works again (the stored values intact).
  p.$('#je-config-read-retry-btn').click();
  await p.flush();
  assert.equal(banner.style.display, 'none');
  const saved = await p.save();
  assert.equal(saved.DefaultLanguage, 'de');
  assert.equal(saved.MaintenanceModeAffectedUsers, '["u1"]');
});

test('Q-REBUILD1FIX5-1 control: a read that fails after one succeeded leaves the form and saving as they were', async t => {
  const p = open(t, { DefaultLanguage: 'de' });
  await p.pageshow();
  const read = p.hold('pluginConfig');
  await p.pageshow();
  await read.reject();
  // Round 11: the page says it may be out of date (the form may be older than the saved settings), with Retry.
  assert.notEqual(p.$('#je-config-read-warning').style.display, 'none');
  assert.match(p.$('#je-config-read-warning-msg').textContent, /may show values older/);
  assert.ok(p.$('.je-save-dock').classList.contains('je-stale'));
  const saved = await p.save();
  assert.equal(saved.DefaultLanguage, 'de');
});
