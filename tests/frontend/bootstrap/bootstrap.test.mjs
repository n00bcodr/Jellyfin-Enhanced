import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, plain, deferred } from '../helpers/harness.mjs';
import { bootstrapFixture, contractValue } from '../contracts/fixtures.mjs';

const modules = ['core/navigation.js', 'core/session.js', 'enhanced/config.js'];
const payload = (extra = {}) => bootstrapFixture({ ComponentScripts: modules, ...extra });
async function until(predicate) {
  const deadline = performance.now() + 3000;
  while (performance.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  assert.ok(predicate(), 'bootstrap did not reach expected state');
}
// Script transport is simulated; plugin.js, config.js and session.js execute unchanged.
// Optional feature callbacks are spies to verify the bootstrap dispatch contract.
function setup(t, { data = payload(), ajax, bundle = 'ok', dev = false, storage = {}, admin = () => false, expectedConsoleErrors = [] } = {}) {
  let userId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  let serverId = 'server-a';
  const calls = [], scripts = [], initialized = [];
  let translationLoads = 0;
  const h = createHarness({ expectedConsoleErrors, html: `<script plugin="Jellyfin Enhanced" version="1.2.3-build123"${dev ? ' dev="true"' : ''}></script>`,
    apiClient: { serverId: () => serverId, getCurrentUserId: () => userId, getCurrentUser: async () => ({ Id: userId, Policy: { IsAdministrator: admin(userId) } }), ajax: async request => {
      const path = new URL(request.url).pathname; calls.push(path);
      if (ajax) return ajax(path, request);
      if (path.endsWith('/bootstrap')) return typeof data === 'function' ? data(userId) : data;
      throw new Error(`Unexpected endpoint ${path}`);
    } } });
  t.after(() => h.close());
  for (const [key, value] of Object.entries(storage)) h.window.localStorage.setItem(key, value);
  h.window.requestIdleCallback = callback => { queueMicrotask(() => callback({ didTimeout: false, timeRemaining: () => 100 })); return 1; };
  const append = h.document.head.appendChild.bind(h.document.head);
  const executeModule = name => {
    h.load(name);
    if (name === 'enhanced/config.js') {
      for (const name of ['QualityTags', 'HiddenContent', 'CalendarPage', 'JellyseerrScript', 'ReviewsScript'])
        h.window.JellyfinEnhanced[`initialize${name}`] = () => initialized.push(name);
      h.window.JellyfinEnhanced.hideSplashScreen = () => initialized.push('hideSplash');
    }
  };
  h.document.head.appendChild = node => {
    const result = append(node);
    if (node.tagName !== 'SCRIPT') return result;
    scripts.push(node);
    queueMicrotask(() => {
      const path = new URL(node.src).pathname;
      if (path.endsWith('/translations.js')) h.window.JellyfinEnhanced.loadTranslations = async () => { translationLoads++; return { greeting: 'Hello' }; };
      else if (path.endsWith('/contracts/bootstrap.js')) h.load('contracts/bootstrap.js');
      else if (path.endsWith('/bundle.js')) {
        if (bundle === 'error') { node.onerror(); return; }
        if (bundle === 'ok') {
          h.window.__JE_BUNDLE_TOTAL = modules.length;
          h.window.__JE_BUNDLE_MODULES = modules.map(name => () => executeModule(name));
        }
      } else {
        const name = path.split('/js/')[1];
        if (modules.includes(name)) executeModule(name);
      }
      node.onload?.();
    });
    return result;
  };
  h.load('plugin.js');
  return { ...h, calls, scripts, initialized, get translationLoads() { return translationLoads; }, get plugin() { return h.window.JellyfinEnhanced; },
    switchServer(id) { serverId = id; h.window.JellyfinEnhanced.session?.checkNow('test'); },
    switchUser(id) { userId = id; h.window.JellyfinEnhanced.session.checkNow('test'); } };
}

test('bootstrap shares one request and loads actual settings before enabled feature initialization', async t => {
  const h = setup(t, { data: payload({ PublicConfig: { QualityTagsEnabled: true, HiddenContentEnabled: true, CalendarPageEnabled: true,
    JellyseerrEnabled: true, JellyseerrShowSearchResults: false, ShowReviews: true }, UserSettings: { Settings: { QualityTagsEnabled: false } } }) });
  await until(() => h.plugin.initialized);
  assert.deepEqual(h.calls, ['/JellyfinEnhanced/bootstrap']);
  assert.equal(h.plugin.pluginVersion, '1.2.3');
  assert.equal(h.plugin.currentSettings.qualityTagsEnabled, false);
  assert.deepEqual(h.initialized, ['ReviewsScript', 'HiddenContent', 'CalendarPage', 'hideSplash']);
  assert.equal(h.window.__JE_BUNDLE_PROGRESS, 3);
  assert.equal(h.window.__JE_BUNDLE_MODULES, undefined);
  assert.ok(h.scripts.every(s => s.src.includes('v=1.2.3-build123')));
});

for (const bundle of ['error', 'malformed']) test(`bundle ${bundle} falls back to ordered real modules`, async t => {
  const h = setup(t, { bundle, data: payload({ ComponentScripts: [' // comment', 'core/navigation.js', ' core/session.js ', '', 'enhanced/config.js'] }) });
  await until(() => h.plugin.initialized);
  const components = h.scripts.filter(s => modules.some(name => s.src.includes(name)));
  assert.equal(components.length, 3);
  assert.ok(components[0].src.includes('core/navigation.js'));
  assert.ok(components.every(s => s.async === false));
  assert.equal(h.plugin.session.getUserId(), 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
});

test('development mode bypasses bundle and executes manifest modules', async t => {
  const h = setup(t, { dev: true }); await until(() => h.plugin.initialized);
  assert.equal(h.scripts.some(s => s.src.includes('/bundle.js')), false);
  assert.ok(h.plugin.loadSettings);
});

test('wrong-user bootstrap is rejected and endpoint failures retain safe defaults', async t => {
  const h = setup(t, { expectedConsoleErrors: ['Failed to fetch public config', 'Failed to fetch version'], ajax: async path => {
    if (path.endsWith('/bootstrap')) return payload({ UserId: 'other-user', PrivateConfig: { SonarrUrl: 'secret' }, UserSettings: { Settings: { QualityTagsEnabled: true } } });
    if (path.endsWith('/component-scripts.json')) return modules;
    if (path === '/Plugins') return [];
    throw new Error('offline');
  } });
  await until(() => h.plugin.initialized);
  assert.equal(h.plugin.pluginConfig.SonarrUrl, undefined);
  assert.equal(h.plugin.currentSettings.qualityTagsEnabled, false);
  assert.equal(h.plugin.pluginVersion, 'unknown');
  assert.deepEqual(plain(h.plugin.userConfig.bookmark), { bookmarks: {} });
  assert.equal(h.calls.filter(p => p.includes('/user-settings/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/')).length, 5);
});

for (const installed of [true, false]) test(`delivery plugin flags reflect installed=${installed}`, async t => {
  const h = setup(t, { data: payload({ HasCustomTabs: installed, HasPluginPages: installed,
    PublicConfig: { BookmarksUseCustomTabs: true, CalendarUsePluginPages: true } }) });
  await until(() => h.plugin.initialized);
  assert.equal(h.plugin.pluginConfig.BookmarksUseCustomTabs, installed);
  assert.equal(h.plugin.pluginConfig.CalendarUsePluginPages, installed);
});

test('identity transition immediately removes private admin data and replaces user documents', async t => {
  const h = setup(t, { admin: id => id === 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', data: id => payload({ UserId: id, PrivateConfig: id === 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' ? { SonarrUrl: 'secret' } : null,
    UserSettings: { Settings: { IsAdmin: id === 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', QualityTagsEnabled: id === 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }, Bookmark: null, BookmarkSnapshot: { Revision: 'snapshot:1', Document: JSON.stringify({ Bookmarks: { [id]: contractValue('BookmarkItem', { Name: id }) } }) } } }) });
  await until(() => h.plugin.initialized);
  assert.equal(h.plugin.pluginConfig.SonarrUrl, 'secret');
  const loaded = new Promise(resolve => h.document.addEventListener('je:user-data-loaded', resolve, { once: true }));
  h.switchUser('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
  assert.equal(h.plugin.pluginConfig.SonarrUrl, undefined);
  assert.deepEqual(plain(h.plugin.currentSettings), {});
  assert.deepEqual(plain(h.plugin.userConfig.bookmark), { bookmarks: {} });
  await loaded;
  assert.equal(h.plugin.currentSettings.qualityTagsEnabled, true);
  assert.deepEqual(plain(h.plugin.userConfig.bookmark.bookmarks), { 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb': Object.fromEntries(Object.entries(contractValue('BookmarkItem', { Name: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' })).map(([key, value]) => [key.charAt(0).toLowerCase() + key.slice(1), value])) });
  assert.ok(h.initialized.includes('QualityTags'));
});

for (const saved of [null, 'fr']) test(`default display language respects existing preference ${saved}`, async t => {
  const h = setup(t, { data: payload({ PublicConfig: { DefaultLanguage: 'pt-br' } }), storage: saved ? { 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-language': saved } : {} });
  await until(() => h.plugin.initialized);
  assert.equal(h.window.localStorage.getItem('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-language'), saved || 'pt-BR');
});

test('translation cache clear removes stale locales but preserves newer entries and unrelated storage', async t => {
  const h = setup(t, { data: payload({ PublicConfig: { ClearTranslationCacheTimestamp: 2000 } }), storage: {
    JE_translation_en: 'old', JE_translation_ts_en: '1000', JE_translation_fr: 'new', JE_translation_ts_fr: '3000', unrelated: 'keep'
  } });
  await until(() => h.plugin.initialized);
  assert.equal(h.window.localStorage.getItem('JE_translation_en'), null);
  assert.equal(h.window.localStorage.getItem('JE_translation_ts_en'), null);
  assert.equal(h.window.localStorage.getItem('JE_translation_fr'), 'new');
  assert.equal(h.window.localStorage.getItem('JE_translation_ts_fr'), '3000');
  assert.equal(h.window.localStorage.getItem('unrelated'), 'keep');
  assert.equal(h.window.localStorage.getItem('JE_translation_clear_ts'), '2000');
  assert.equal(h.translationLoads, 2);
});

test('translation cache already newer than invalidation avoids redundant reload', async t => {
  const h = setup(t, { data: payload({ PublicConfig: { ClearTranslationCacheTimestamp: 2000 } }), storage: {
    JE_translation_en: 'new', JE_translation_ts_en: '3000'
  } });
  await until(() => h.plugin.initialized);
  assert.equal(h.translationLoads, 1);
  assert.equal(h.window.localStorage.getItem('JE_translation_en'), 'new');
});

for (const expired of [false, true]) test(`maintenance banner treats message as text and suppresses expired=${expired}`, async t => {
  const h = setup(t, { data: payload({ PublicConfig: { MaintenanceModeEnabled: true,
    MaintenanceModeMessage: '<img src=x onerror=alert(1)>', MaintenanceModeEndsAt: expired ? '2000-01-01T00:00:00Z' : null,
    EnableLoginImage: true } }) });
  await until(() => h.plugin.initialized);
  const banner = h.document.querySelector('#je-maintenance-banner');
  if (expired) assert.equal(banner, null);
  else { assert.ok(banner.textContent.includes('<img')); assert.equal(banner.querySelector('img'), null); }
  assert.equal(h.scripts.filter(s => s.src.includes('/extras/login-image.js')).length, 1);
});

test('after a switch, a bootstrap answered for another user is replaced by the new user\'s own data', async t => {
  // A misrouted or cached bootstrap still names the previous user: reload per endpoint instead.
  let current = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const h = setup(t, { admin: id => id === 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', ajax: async path => {
    if (path.endsWith('/bootstrap')) return payload({ UserId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', PrivateConfig: { SonarrUrl: 'secret' }, UserSettings: { Bookmark: { Bookmarks: { [current === 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' ? 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' : 'stolen']: {} } } } });
    if (path === '/JellyfinEnhanced/user-settings/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/bookmark-document') return { Revision: 'fallback:1', Document: JSON.stringify({ Bookmarks: { 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb': { Name: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' } } }) };
    if (path.startsWith('/JellyfinEnhanced/user-settings/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/') || path.endsWith('/private-config')) return {};
    throw new Error(`Unexpected endpoint ${path}`);
  } });
  await until(() => h.plugin.initialized);
  assert.equal(h.plugin.pluginConfig.SonarrUrl, 'secret');
  const loaded = new Promise(resolve => h.document.addEventListener('je:user-data-loaded', resolve, { once: true }));
  current = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'; h.switchUser('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
  await loaded;
  assert.equal(h.plugin.pluginConfig.SonarrUrl, undefined);
  assert.deepEqual(plain(h.plugin.userConfig.bookmark.bookmarks), { 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb': { name: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' } });
  assert.ok(h.calls.includes('/JellyfinEnhanced/user-settings/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/bookmark-document'));
});

test('late bootstrap for previous identity cannot restore private config or bookmarks', async t => {
  const stale = deferred();
  let bStarted = false;
  const h = setup(t, { data: id => {
    if (id === 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb') { bStarted = true; return stale.promise; }
    return payload({ UserId: id, UserSettings: { Bookmark: null, BookmarkSnapshot: { Revision: 'snapshot:1', Document: JSON.stringify({ Bookmarks: { [id]: contractValue('BookmarkItem', { Name: id }) } }) } } });
  } });
  await until(() => h.plugin.initialized);
  h.switchUser('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
  await until(() => bStarted);
  const loaded = new Promise(resolve => h.document.addEventListener('je:user-data-loaded', resolve, { once: true }));
  h.switchUser('cccccccccccccccccccccccccccccccc');
  await loaded;
  stale.resolve(payload({ UserId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', PrivateConfig: { SonarrUrl: 'secret' }, UserSettings: { Bookmark: { Bookmarks: { stolen: {} } } } }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.plugin.pluginConfig.SonarrUrl, undefined);
  assert.deepEqual(plain(h.plugin.userConfig.bookmark.bookmarks), { 'cccccccccccccccccccccccccccccccc': Object.fromEntries(Object.entries(contractValue('BookmarkItem', { Name: 'cccccccccccccccccccccccccccccccc' })).map(([key, value]) => [key.charAt(0).toLowerCase() + key.slice(1), value])) });
});

// The per-endpoint fallback (a bootstrap naming another user) has its own late-response guards.
for (const late of ['private-config', 'settings']) test(`per-endpoint fallback drops a late ${late} response from the previous identity`, async t => {
  const stale = deferred();
  let bWaiting = false;
  const h = setup(t, { ajax: async path => {
    if (path.endsWith('/bootstrap')) return payload({ UserId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' });
    if (path.endsWith('/private-config')) {
      if (late === 'private-config' && h.plugin.session.getUserId() === 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb') { bWaiting = true; return stale.promise; }
      return {};
    }
    if (path === '/JellyfinEnhanced/user-settings/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/bookmark-document' && late === 'settings') { bWaiting = true; return stale.promise; }
    if (path === '/JellyfinEnhanced/user-settings/cccccccccccccccccccccccccccccccc/bookmark-document') return { Revision: 'fallback:1', Document: JSON.stringify({ Bookmarks: { 'cccccccccccccccccccccccccccccccc': { Name: 'cccccccccccccccccccccccccccccccc' } } }) };
    if (/^\/JellyfinEnhanced\/user-settings\/[bc]{32}\//.test(path)) return {};
    throw new Error(`Unexpected endpoint ${path}`);
  } });
  await until(() => h.plugin.initialized);
  h.switchUser('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
  await until(() => bWaiting);
  const loaded = new Promise(resolve => h.document.addEventListener('je:user-data-loaded', resolve, { once: true }));
  h.switchUser('cccccccccccccccccccccccccccccccc');
  await loaded;
  stale.resolve(late === 'private-config' ? { SonarrUrl: 'secret' } : { Revision: 'stale:1', Document: JSON.stringify({ Bookmarks: { stolen: {} } }) });
  for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.plugin.pluginConfig.SonarrUrl, undefined);
  assert.deepEqual(plain(h.plugin.userConfig.bookmark.bookmarks), { 'cccccccccccccccccccccccccccccccc': { name: 'cccccccccccccccccccccccccccccccc' } });
});

// Item looks are projected per caller (only items that user can see); a same-tab switch must not keep the last user's list.
const LOOK_A = [contractValue('TagLookItemOverride', { ItemId: 'a'.repeat(32), Layout: 'bands' })], LOOK_B = [contractValue('TagLookItemOverride', { ItemId: 'b'.repeat(32), Layout: 'minimal' })];
test('a same-tab user switch serves the incoming user\'s item looks from the bootstrap', async t => {
  const h = setup(t, { data: id => payload({ UserId: id, PublicConfig: { TagLookItemOverrides: id === 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' ? LOOK_A : LOOK_B } }) });
  await until(() => h.plugin.initialized);
  assert.deepEqual(plain(h.plugin.pluginConfig.TagLookItemOverrides), LOOK_A);
  const loaded = new Promise(resolve => h.document.addEventListener('je:user-data-loaded', resolve, { once: true }));
  h.switchUser('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
  assert.equal(h.plugin.pluginConfig.TagLookItemOverrides, null, 'nothing reads the outgoing list during the switch');
  await loaded;
  assert.deepEqual(plain(h.plugin.pluginConfig.TagLookItemOverrides), LOOK_B);
  assert.equal(h.calls.filter(p => p.endsWith('/bootstrap')).length, 2);
});

test('a same-tab user switch on the per-endpoint fallback refetches the public config for the item looks', async t => {
  let id = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const h = setup(t, { ajax: async path => {
    if (path.endsWith('/bootstrap')) return payload({ UserId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', PublicConfig: { TagLookItemOverrides: LOOK_A } });
    if (path.endsWith('/public-config')) return { TagLookItemOverrides: id === 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' ? LOOK_B : LOOK_A, QualityTagsEnabled: true };
    if (path.endsWith('/private-config') || path.startsWith('/JellyfinEnhanced/user-settings/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/')) return {};
    throw new Error(`Unexpected endpoint ${path}`);
  } });
  await until(() => h.plugin.initialized);
  assert.deepEqual(plain(h.plugin.pluginConfig.TagLookItemOverrides), LOOK_A);
  assert.ok(!h.calls.includes('/JellyfinEnhanced/public-config'), 'the boot used the bootstrap');
  const loaded = new Promise(resolve => h.document.addEventListener('je:user-data-loaded', resolve, { once: true }));
  id = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'; h.switchUser('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
  await loaded;
  assert.deepEqual(plain(h.plugin.pluginConfig.TagLookItemOverrides), LOOK_B);
  assert.equal(h.plugin.pluginConfig.QualityTagsEnabled, false, 'only the per-user fields are taken from it');
  assert.ok(h.calls.includes('/JellyfinEnhanced/public-config'));
});

for (const [name, mutate] of [
  ['missing user identity', p => { delete p.UserId; }],
  ['malformed public field', p => { p.PublicConfig.QualityTagsEnabled = 'true'; }],
  ['private data for a non-admin', p => { p.PrivateConfig = contractValue('BootstrapPrivateConfig', { SonarrUrl: 'do-not-apply' }); }],
  ['forged administrator status', p => { p.UserSettings.Settings = contractValue('BootstrapSettings', { IsAdmin: true }); }],
  ['partial document', p => { p.UserSettings.Bookmark = { Bookmarks: { stolen: {} } }; }],
]) test(`real loader rejects ${name} and uses endpoint fallback`, async t => {
  const invalid = payload({ PublicConfig: { QualityTagsEnabled: true } });
  mutate(invalid);
  const h = setup(t, { ajax: async path => {
    if (path.endsWith('/bootstrap')) return invalid;
    if (path.endsWith('/component-scripts.json')) return modules;
    if (path === '/Plugins') return [];
    if (path.endsWith('/version')) return { Version: 'fallback' };
    return {};
  } });
  await until(() => h.plugin.initialized);
  assert.ok(h.calls.some(path => path.includes('/user-settings/')));
  assert.equal(h.plugin.pluginConfig.SonarrUrl, undefined);
  assert.equal(h.plugin.currentSettings.qualityTagsEnabled, false);
  assert.equal(h.plugin.userConfig.settings.isAdmin, undefined);
  assert.deepEqual(plain(h.plugin.userConfig.bookmark), { bookmarks: {} });
  assert.equal(h.plugin.userConfig.bookmarkRevision, null);
});

test('real loader preserves null document failures without throwing or inventing a payload', async t => {
  const h = setup(t, { data: payload({ UserSettings: { Settings: null, Shortcuts: null, Bookmark: null, Elsewhere: null, HiddenContent: null } }) });
  await until(() => h.plugin.initialized);
  assert.deepEqual(h.calls, ['/JellyfinEnhanced/bootstrap']);
  assert.deepEqual(plain(h.plugin.userConfig.bookmark.bookmarks), {});
  assert.equal(h.plugin.currentSettings.qualityTagsEnabled, false);
});


test('real loader discards a same-user response after server identity changes during boot', async t => {
  const stale = deferred();
  let requests = 0;
  const h = setup(t, { data: () => ++requests === 1 ? stale.promise : payload() });
  await until(() => requests === 1);
  h.switchServer('server-b');
  stale.resolve(payload({ PublicConfig: { MaintenanceModeMessage: 'stale-server', QualityTagsEnabled: true } }));
  await until(() => h.plugin.initialized);
  assert.ok(requests >= 2);
  assert.equal(h.plugin.currentSettings.qualityTagsEnabled, false);
  assert.notEqual(h.plugin.pluginConfig.MaintenanceModeMessage, 'stale-server');
  assert.ok(!h.calls.some(path => path.includes('/user-settings/')), 'stale identity retries bootstrap instead of applying fallback for the old user');
});

test('fallback settings loader carries the validated content and matching revision into actual saves', async t => {
  const snapshot = contractValue('RevisionedSettingsResponse', { Revision: 'fallback-r1', Settings: { IsAdmin: false, AutoPauseEnabled: false } });
  const writes = [];
  const h = setup(t, { ajax: async (path, request) => {
    if (path.endsWith('/bootstrap')) throw new Error('bootstrap unavailable');
    if (path.endsWith('/public-config')) return {};
    if (path.endsWith('/version')) return '1.2.3';
    if (path.endsWith('/component-scripts.json')) return modules;
    if (path.endsWith('/settings-document')) {
      if (request.type === 'GET') return snapshot;
      writes.push(JSON.parse(request.data)); return { Revision: 'fallback-r2' };
    }
    return {};
  } });
  await until(() => h.plugin.initialized);
  assert.equal(h.plugin.userConfig.settingsRevision, 'fallback-r1');
  assert.equal(h.plugin.currentSettings.autoPauseEnabled, false);
  h.plugin.currentSettings.autoPauseEnabled = true;
  await h.plugin.saveUserSettings('settings.json', h.plugin.currentSettings, { throwOnError: true });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].Revision, 'fallback-r1');
  assert.equal(writes[0].Settings.AutoPauseEnabled, true);
  assert.equal(h.plugin.userConfig.settingsRevision, 'fallback-r2');
});


test('bookmark snapshot loading preserves uppercase record IDs and pairs content with its revision', async t => {
  const h = setup(t, { data: payload({UserSettings: {Bookmark: null, BookmarkSnapshot: {
    Revision: 'snapshot:uppercase', Document: '{"Future":1e400,"Bookmarks":{"Bm_UPPER":{"ItemId":"movie","Timestamp":2.5,"Future":1e-400}}}'
  }}}) });
  await until(() => h.plugin.initialized);
  assert.equal(h.plugin.userConfig.bookmarkRevision, 'snapshot:uppercase');
  assert.deepEqual(Object.keys(h.plugin.userConfig.bookmark.bookmarks), ['Bm_UPPER']);
  assert.equal(h.plugin.userConfig.bookmark.bookmarks.Bm_UPPER.timestamp, 2.5);
  assert.equal(h.plugin.userConfig.bookmarkBinding.userId, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
});

// BUG-008: the per-file fallback needs the component-script manifest. A failed manifest request is retried once
// after a delay; if it fails again boot reports one clear error instead of "All component scripts loaded" + FATAL.
function manifestFailure(t, failures, expectedConsoleErrors = [], failure = () => new Error('manifest offline')) {
  let manifestRequests = 0;
  const h = setup(t, { bundle: 'error', expectedConsoleErrors, ajax: async path => {
    if (path.endsWith('/bootstrap')) return payload({ ComponentScripts: null });
    if (path.endsWith('/component-scripts.json')) { if (++manifestRequests <= failures) throw failure(); return modules; }
    throw new Error(`Unexpected endpoint ${path}`);
  } });
  const logs = [], delays = [];
  const setTimer = h.window.setTimeout.bind(h.window);
  for (const level of ['log', 'error']) {
    const write = h.window.console[level].bind(h.window.console);
    h.window.console[level] = (...args) => { logs.push(args.map(String).join(' ')); write(...args); };
  }
  // The retry waits about a second; run it at once and record the requested delay instead.
  h.window.setTimeout = (fn, ms, ...rest) => { delays.push(ms); return setTimer(fn, ms >= 500 ? 0 : ms, ...rest); };
  return { ...h, logs, delays, get manifestRequests() { return manifestRequests; } };
}

test('a component-script manifest that fails once is retried after a delay and the fallback scripts load', async t => {
  const h = manifestFailure(t, 1);
  await until(() => h.plugin.initialized);
  assert.equal(h.manifestRequests, 2);
  assert.ok(h.delays.some(ms => ms >= 500), 'the retry waits before asking again');
  assert.equal(h.scripts.filter(s => modules.some(name => s.src.includes(name))).length, 3);
});

test('a component-script manifest that keeps failing ends boot with one clear error, not "All component scripts loaded"', async t => {
  const h = manifestFailure(t, Infinity, [/CRITICAL INITIALIZATION FAILURE.*component-script manifest/]);
  await until(() => h.logs.some(line => /CRITICAL|FATAL|All components initialized/.test(line)));
  assert.equal(h.manifestRequests, 2, 'one bounded retry');
  assert.equal(h.logs.some(line => line.includes('All component scripts loaded')), false);
  assert.equal(h.logs.filter(line => /CRITICAL|FATAL/.test(line)).length, 1);
  assert.equal(h.logs.some(line => line.includes('All components initialized')), false);
  assert.equal(h.plugin.initialized, undefined);
});

// jellyfin-web's ApiClient.ajax rejects with the fetch Response itself; the boot error ended in "[object Response]".
test('a manifest request that keeps answering an HTTP error names the status in the boot error', async t => {
  const h = manifestFailure(t, Infinity, [/CRITICAL INITIALIZATION FAILURE.*component-script manifest/], () => new Response('Service Unavailable', { status: 503 }));
  await until(() => h.logs.some(line => /CRITICAL/.test(line)));
  const critical = h.logs.find(line => /CRITICAL/.test(line));
  assert.match(critical, /component-script manifest: HTTP 503$/);
  assert.doesNotMatch(critical, /\[object /);
});
