import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, plain, deferred } from '../helpers/harness.mjs';

const modules = ['core/navigation.js', 'core/session.js', 'enhanced/config.js'];
const payload = (extra = {}) => ({ UserId: 'user-a', Version: '1.2.3', PublicConfig: {}, PrivateConfig: null,
  HasCustomTabs: false, HasPluginPages: false, UserSettings: {}, ComponentScripts: modules, ...extra });
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
function setup(t, { data = payload(), ajax, bundle = 'ok', dev = false, storage = {}, expectedConsoleErrors = [] } = {}) {
  let userId = 'user-a';
  const calls = [], scripts = [], initialized = [];
  let translationLoads = 0;
  const h = createHarness({ expectedConsoleErrors, html: `<script plugin="Jellyfin Enhanced" version="1.2.3-build123"${dev ? ' dev="true"' : ''}></script>`,
    apiClient: { getCurrentUserId: () => userId, ajax: async request => {
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
  const h = setup(t, { bundle, data: payload({ ComponentScripts: [' // comment', null, 'core/navigation.js', ' core/session.js ', '', 'enhanced/config.js'] }) });
  await until(() => h.plugin.initialized);
  const components = h.scripts.filter(s => modules.some(name => s.src.includes(name)));
  assert.equal(components.length, 3);
  assert.ok(components[0].src.includes('core/navigation.js'));
  assert.ok(components.every(s => s.async === false));
  assert.equal(h.plugin.session.getUserId(), 'user-a');
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
  assert.equal(h.calls.filter(p => p.includes('/user-settings/user-a/')).length, 5);
});

for (const installed of [true, false]) test(`delivery plugin flags reflect installed=${installed}`, async t => {
  const h = setup(t, { data: payload({ HasCustomTabs: installed, HasPluginPages: installed,
    PublicConfig: { BookmarksUseCustomTabs: true, CalendarUsePluginPages: true } }) });
  await until(() => h.plugin.initialized);
  assert.equal(h.plugin.pluginConfig.BookmarksUseCustomTabs, installed);
  assert.equal(h.plugin.pluginConfig.CalendarUsePluginPages, installed);
});

test('identity transition immediately removes private admin data and replaces user documents', async t => {
  const h = setup(t, { data: id => payload({ UserId: id, PrivateConfig: id === 'user-a' ? { SonarrUrl: 'secret' } : null,
    UserSettings: { Settings: { QualityTagsEnabled: id === 'user-b' }, Bookmark: { Bookmarks: { [id]: { Name: id } } } } }) });
  await until(() => h.plugin.initialized);
  assert.equal(h.plugin.pluginConfig.SonarrUrl, 'secret');
  const loaded = new Promise(resolve => h.document.addEventListener('je:user-data-loaded', resolve, { once: true }));
  h.switchUser('user-b');
  assert.equal(h.plugin.pluginConfig.SonarrUrl, undefined);
  assert.deepEqual(plain(h.plugin.currentSettings), {});
  assert.deepEqual(plain(h.plugin.userConfig.bookmark), { bookmarks: {} });
  await loaded;
  assert.equal(h.plugin.currentSettings.qualityTagsEnabled, true);
  assert.deepEqual(plain(h.plugin.userConfig.bookmark.bookmarks), { 'user-b': { name: 'user-b' } });
  assert.ok(h.initialized.includes('QualityTags'));
});

for (const saved of [null, 'fr']) test(`default display language respects existing preference ${saved}`, async t => {
  const h = setup(t, { data: payload({ PublicConfig: { DefaultLanguage: 'pt-br' } }), storage: saved ? { 'user-a-language': saved } : {} });
  await until(() => h.plugin.initialized);
  assert.equal(h.window.localStorage.getItem('user-a-language'), saved || 'pt-BR');
  // A seeded language is recorded as the settings' one; a language set elsewhere is not.
  assert.equal(h.window.localStorage.getItem('JE_seededLanguage_user-a'), saved ? null : 'pt-BR');
});

// A locked display language is the user's language: it replaces the stored one and the
// translations are loaded again in it. A followed one replaces only a stored language the settings
// put there (JE_seededLanguage_*), never one picked in jellyfin-web, which shares the key. A
// language the user chose (or "Auto") never replaces it.
for (const [label, meta, settings, seeded, expected, loads] of [
  ['locked', { Locked: ['DisplayLanguage'] }, { DisplayLanguage: 'de' }, null, 'de', 2],
  ['following', { Following: ['DisplayLanguage'] }, { DisplayLanguage: 'de-de' }, 'fr', 'de-DE', 2],
  ['following (language from jellyfin-web)', { Following: ['DisplayLanguage'] }, { DisplayLanguage: 'de' }, null, 'fr', 1],
  ['following (language from jellyfin-web, seeded earlier)', { Following: ['DisplayLanguage'] }, { DisplayLanguage: 'de' }, 'de', 'fr', 1],
  ['chosen', { Chosen: ['DisplayLanguage'] }, { DisplayLanguage: 'de' }, 'fr', 'fr', 1],
  ['locked to Auto', { Locked: ['DisplayLanguage'] }, { DisplayLanguage: '' }, null, 'fr', 1]
]) test(`a ${label} display language ${expected === 'fr' ? 'keeps' : 'replaces'} the stored language`, async t => {
  const data = payload({ UserSettings: { Settings: settings, SettingsMeta: { Schema: 2, ...meta }, SettingsStatus: 'ok' } });
  const storage = { 'user-a-language': 'fr' };
  if (seeded !== null) storage['JE_seededLanguage_user-a'] = seeded;
  const h = setup(t, { data, storage });
  await until(() => h.plugin.initialized);
  assert.equal(h.window.localStorage.getItem('user-a-language'), expected);
  assert.equal(h.translationLoads, loads);
  if (expected !== 'fr') assert.equal(h.window.localStorage.getItem('JE_seededLanguage_user-a'), expected);

  // A lock arriving later (focus check, save answer) applies from the next page load.
  if (label !== 'chosen') return;
  h.plugin.userConfig.settingsMeta = { locked: ['displayLanguage'] };
  h.plugin.currentSettings.displayLanguage = 'it';
  h.document.dispatchEvent(new h.window.CustomEvent('je:settings-changed', { detail: { keys: [], rejected: [], meta: true } }));
  assert.equal(h.window.localStorage.getItem('user-a-language'), 'it');
});

test('a followed display language replaces the stored one only while it is the settings\' language', async t => {
  // "Follow my defaults where nothing changes" made an old seed's value follow: the stored
  // language equals it, so it is recorded as the settings' one, and a new default replaces it.
  const data = payload({ UserSettings: { Settings: { DisplayLanguage: 'de' }, SettingsMeta: { Schema: 2, Following: ['DisplayLanguage'] }, SettingsStatus: 'ok' } });
  const h = setup(t, { data, storage: { 'user-a-language': 'de' } });
  await until(() => h.plugin.initialized);
  assert.equal(h.window.localStorage.getItem('JE_seededLanguage_user-a'), 'de');
  const changeDefault = (language) => {
    h.plugin.currentSettings.displayLanguage = language;
    h.document.dispatchEvent(new h.window.CustomEvent('je:settings-changed', { detail: { keys: ['displayLanguage'], rejected: [] } }));
  };
  changeDefault('es');
  assert.equal(h.window.localStorage.getItem('user-a-language'), 'es');
  // The user then picks French in jellyfin-web's own display settings: the next default keeps it.
  h.window.localStorage.setItem('user-a-language', 'fr');
  changeDefault('it');
  assert.equal(h.window.localStorage.getItem('user-a-language'), 'fr');
  assert.equal(h.window.localStorage.getItem('JE_seededLanguage_user-a'), 'es');
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
  let current = 'user-a';
  const h = setup(t, { ajax: async path => {
    if (path.endsWith('/bootstrap')) return payload({ UserId: 'user-a', PrivateConfig: { SonarrUrl: 'secret' }, UserSettings: { Bookmark: { Bookmarks: { [current === 'user-a' ? 'user-a' : 'stolen']: {} } } } });
    if (path === '/JellyfinEnhanced/user-settings/user-b/bookmark.json') return { Bookmarks: { 'user-b': { Name: 'user-b' } } };
    if (path.startsWith('/JellyfinEnhanced/user-settings/user-b/') || path.endsWith('/private-config')) return {};
    throw new Error(`Unexpected endpoint ${path}`);
  } });
  await until(() => h.plugin.initialized);
  assert.equal(h.plugin.pluginConfig.SonarrUrl, 'secret');
  const loaded = new Promise(resolve => h.document.addEventListener('je:user-data-loaded', resolve, { once: true }));
  current = 'user-b'; h.switchUser('user-b');
  await loaded;
  assert.equal(h.plugin.pluginConfig.SonarrUrl, undefined);
  assert.deepEqual(plain(h.plugin.userConfig.bookmark.bookmarks), { 'user-b': { name: 'user-b' } });
  assert.ok(h.calls.includes('/JellyfinEnhanced/user-settings/user-b/bookmark.json'));
});

test('late bootstrap for previous identity cannot restore private config or bookmarks', async t => {
  const stale = deferred();
  let bStarted = false;
  const h = setup(t, { data: id => {
    if (id === 'user-b') { bStarted = true; return stale.promise; }
    return payload({ UserId: id, UserSettings: { Bookmark: { Bookmarks: { [id]: { Name: id } } } } });
  } });
  await until(() => h.plugin.initialized);
  h.switchUser('user-b');
  await until(() => bStarted);
  const loaded = new Promise(resolve => h.document.addEventListener('je:user-data-loaded', resolve, { once: true }));
  h.switchUser('user-c');
  await loaded;
  stale.resolve(payload({ UserId: 'user-b', PrivateConfig: { SonarrUrl: 'secret' }, UserSettings: { Bookmark: { Bookmarks: { stolen: {} } } } }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.plugin.pluginConfig.SonarrUrl, undefined);
  assert.deepEqual(plain(h.plugin.userConfig.bookmark.bookmarks), { 'user-c': { name: 'user-c' } });
});

// The per-endpoint fallback (a bootstrap naming another user) has its own late-response guards.
for (const late of ['private-config', 'settings']) test(`per-endpoint fallback drops a late ${late} response from the previous identity`, async t => {
  const stale = deferred();
  let bWaiting = false;
  const h = setup(t, { ajax: async path => {
    if (path.endsWith('/bootstrap')) return payload({ UserId: 'user-a' });
    if (path.endsWith('/private-config')) {
      if (late === 'private-config' && h.plugin.session.getUserId() === 'user-b') { bWaiting = true; return stale.promise; }
      return {};
    }
    if (path === '/JellyfinEnhanced/user-settings/user-b/bookmark.json' && late === 'settings') { bWaiting = true; return stale.promise; }
    if (path === '/JellyfinEnhanced/user-settings/user-c/bookmark.json') return { Bookmarks: { 'user-c': { Name: 'user-c' } } };
    if (/^\/JellyfinEnhanced\/user-settings\/user-[bc]\//.test(path)) return {};
    throw new Error(`Unexpected endpoint ${path}`);
  } });
  await until(() => h.plugin.initialized);
  h.switchUser('user-b');
  await until(() => bWaiting);
  const loaded = new Promise(resolve => h.document.addEventListener('je:user-data-loaded', resolve, { once: true }));
  h.switchUser('user-c');
  await loaded;
  stale.resolve(late === 'private-config' ? { SonarrUrl: 'secret' } : { Bookmarks: { stolen: {} } });
  for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.plugin.pluginConfig.SonarrUrl, undefined);
  assert.deepEqual(plain(h.plugin.userConfig.bookmark.bookmarks), { 'user-c': { name: 'user-c' } });
});

// Settings that failed to load are fallback defaults: saving them would overwrite the stored
// file, so settings.json saves are refused until a load succeeds (other documents still save).
test('settings the bootstrap reports unavailable are never saved back; a user whose settings load saves normally', async t => {
  const posts = [];
  let current = 'user-a';
  const h = setup(t, { ajax: async (path, request) => {
    if (request.type === 'POST') { posts.push(path); return {}; }
    if (path.endsWith('/bootstrap')) {
      const user = current;
      return user === 'user-a'
        ? payload({ UserSettings: { Settings: null, SettingsStatus: 'unavailable', Shortcuts: { Shortcuts: [] } } })
        : payload({ UserId: user, UserSettings: { Settings: { AutoPauseEnabled: false }, SettingsStatus: 'ok' } });
    }
    throw new Error(`Unexpected endpoint ${path}`);
  } });
  await until(() => h.plugin.initialized);
  assert.equal(h.plugin.userConfig.settingsStatus, 'unavailable');
  assert.equal(h.plugin.currentSettings.autoPauseEnabled, true, 'fallback defaults are in memory');
  await h.plugin.saveUserSettings('settings.json', h.plugin.currentSettings);
  await assert.rejects(h.plugin.saveUserSettings('settings.json', h.plugin.currentSettings, { throwOnError: true }), /could not be loaded/);
  await h.plugin.saveUserSettings('shortcuts.json', { Shortcuts: [] });
  assert.deepEqual(posts, ['/JellyfinEnhanced/user-settings/user-a/shortcuts.json']);

  const loaded = new Promise(resolve => h.document.addEventListener('je:user-data-loaded', resolve, { once: true }));
  current = 'user-b'; h.switchUser('user-b');
  await loaded;
  assert.equal(h.plugin.userConfig.settingsStatus, 'ok');
  assert.equal(h.plugin.currentSettings.autoPauseEnabled, false);
  await h.plugin.saveUserSettings('settings.json', h.plugin.currentSettings, { throwOnError: true });
  assert.deepEqual(posts.slice(1), ['/JellyfinEnhanced/user-settings/user-b/settings.json']);
});

for (const [label, userSettings, expected] of [
  ['a loaded document', { Settings: { AutoPauseEnabled: false }, SettingsStatus: 'ok' }, 'ok'],
  ['a document from a server that predates the status', { Settings: { AutoPauseEnabled: false } }, 'ok'],
  ['no document', { Settings: null }, 'unavailable'],
]) test(`bootstrap with ${label} marks settings ${expected}`, async t => {
  const h = setup(t, { data: payload({ UserSettings: userSettings }) });
  await until(() => h.plugin.initialized);
  assert.equal(h.plugin.userConfig.settingsStatus, expected);
});

for (const settingsFails of [true, false]) test(`per-endpoint fallback marks settings ${settingsFails ? 'unavailable when its GET fails' : 'ok when its GET succeeds'}`, async t => {
  const posts = [];
  const h = setup(t, { expectedConsoleErrors: ['Failed to fetch public config', 'Failed to fetch version'], ajax: async (path, request) => {
    if (request.type === 'POST') { posts.push(path); return {}; }
    if (path.endsWith('/component-scripts.json')) return modules;
    if (path === '/Plugins') return [];
    if (path === '/JellyfinEnhanced/user-settings/user-a/settings.json') {
      if (settingsFails) throw new Error('503 Service Unavailable');
      return { AutoPauseEnabled: false };
    }
    if (path.startsWith('/JellyfinEnhanced/user-settings/user-a/')) return {};
    throw new Error('offline');
  } });
  await until(() => h.plugin.initialized);
  assert.equal(h.plugin.userConfig.settingsStatus, settingsFails ? 'unavailable' : 'ok');
  // Without a bootstrap the capabilities are unknown, so the key-level route is tried.
  assert.equal(h.plugin.serverCapabilities, null);
  await h.plugin.saveUserSettings('settings.json', { ...h.plugin.currentSettings, autoPauseEnabled: true });
  assert.deepEqual(posts, settingsFails ? [] : ['/JellyfinEnhanced/user-settings/user-a/settings.json/patch']);
});

// Design item C3 (review): a failed bootstrap must not strand settings that follow the server
// default on the whole-document route (which refuses them): /patch is tried, and a server without
// it (404/405) gets the whole document as before, from then on.
for (const patchRoute of [true, false]) test(`after a failed bootstrap, settings saves try /patch ${patchRoute ? 'and use it' : 'and fall back on a 404'}`, async t => {
  const posts = [];
  const h = setup(t, { expectedConsoleErrors: ['Failed to fetch public config', 'Failed to fetch version'], ajax: async (path, request) => {
    if (request.type === 'POST') {
      posts.push({ path, body: JSON.parse(request.data) });
      if (path.endsWith('/patch')) {
        if (!patchRoute) throw Object.assign(new Error('Not Found'), { status: 404 });
        return { success: true, Rejected: [], Settings: { AutoPauseEnabled: false, AutoPipEnabled: true }, Meta: { Following: [] } };
      }
      return {};
    }
    if (path.endsWith('/component-scripts.json')) return modules;
    if (path === '/Plugins') return [];
    if (path === '/JellyfinEnhanced/user-settings/user-a/settings.json') return { AutoPauseEnabled: false, AutoPipEnabled: false };
    if (path.startsWith('/JellyfinEnhanced/user-settings/user-a/')) return {};
    throw new Error('offline');
  } });
  await until(() => h.plugin.initialized);
  h.plugin.currentSettings.autoPipEnabled = true;
  await h.plugin.saveUserSettings('settings.json', h.plugin.currentSettings);
  h.plugin.currentSettings.autoPauseEnabled = true;
  await h.plugin.saveUserSettings('settings.json', h.plugin.currentSettings);
  const patch = '/JellyfinEnhanced/user-settings/user-a/settings.json/patch', whole = '/JellyfinEnhanced/user-settings/user-a/settings.json';
  if (patchRoute) {
    assert.deepEqual(posts, [{ path: patch, body: { Set: { AutoPipEnabled: true } } }, { path: patch, body: { Set: { AutoPauseEnabled: true } } }]);
  } else {
    assert.deepEqual(posts.map(p => p.path), [patch, whole, whole]);
    assert.equal(posts[2].body.AutoPauseEnabled, true);
  }
});

// Between a user switch and the incoming user's settings arriving, JE.currentSettings is the
// reset {}: a settings.json save in that gap would write it over that user's stored file.
test('no settings.json save goes out while the incoming user\'s settings are still loading', async t => {
  const posts = [];
  const pending = deferred();
  let bRequested = false, current = 'user-a';
  const h = setup(t, { ajax: async (path, request) => {
    if (request.type === 'POST') { posts.push(path); return {}; }
    if (path.endsWith('/bootstrap')) {
      if (current !== 'user-b') return payload({ UserSettings: { Settings: { AutoPauseEnabled: false }, SettingsStatus: 'ok' } });
      bRequested = true;
      return pending.promise;
    }
    throw new Error(`Unexpected endpoint ${path}`);
  } });
  await until(() => h.plugin.initialized);
  assert.equal(h.plugin.userConfig.settingsStatus, 'ok');

  current = 'user-b'; h.switchUser('user-b');
  assert.equal(h.plugin.userConfig.settingsStatus, 'loading');
  await until(() => bRequested);
  await h.plugin.saveUserSettings('settings.json', { ...h.plugin.currentSettings, autoPipEnabled: true });
  await assert.rejects(h.plugin.saveUserSettings('settings.json', h.plugin.currentSettings, { throwOnError: true }), /still loading/);
  await h.plugin.saveUserSettings('shortcuts.json', { Shortcuts: [] });
  assert.deepEqual(posts, ['/JellyfinEnhanced/user-settings/user-b/shortcuts.json']);

  const loaded = new Promise(resolve => h.document.addEventListener('je:user-data-loaded', resolve, { once: true }));
  pending.resolve(payload({ UserId: 'user-b', UserSettings: { Settings: { AutoPauseEnabled: false, AutoPipEnabled: true }, SettingsStatus: 'ok' } }));
  await loaded;
  assert.equal(h.plugin.userConfig.settingsStatus, 'ok');
  await h.plugin.saveUserSettings('settings.json', h.plugin.currentSettings, { throwOnError: true });
  assert.deepEqual(posts.slice(1), ['/JellyfinEnhanced/user-settings/user-b/settings.json']);
});

// The panel-open refresh of settings.json can still be in flight when the identity changes: its
// answer (or its 503) is the previous user's and must not lift the incoming user's 'loading'.
for (const [label, answer] of [
  ['answers', () => ({ AutoPauseEnabled: false, AutoPipEnabled: true })],
  ['fails unavailable', () => { throw new Response(JSON.stringify({ success: false, status: 'unavailable' }), { status: 503 }); }],
]) test(`a panel refresh for the previous user that ${label} after a switch is dropped`, async t => {
  const posts = [];
  const panelGet = deferred(), bBootstrap = deferred();
  let panelRequested = false, bRequested = false, current = 'user-a';
  const h = setup(t, { ajax: async (path, request) => {
    if (request.type === 'POST') { posts.push(path); return {}; }
    if (path === '/JellyfinEnhanced/user-settings/user-a/settings.json') { panelRequested = true; return panelGet.promise.then(answer); }
    if (path.endsWith('/bootstrap')) {
      if (current !== 'user-b') return payload({ UserSettings: { Settings: { AutoPauseEnabled: true }, SettingsStatus: 'ok' } });
      bRequested = true;
      return bBootstrap.promise;
    }
    throw new Error(`Unexpected endpoint ${path}`);
  } });
  await until(() => h.plugin.initialized);
  h.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  Object.assign(h.plugin, { t: key => key, keyListener() {}, themer: { getThemeVariables: () => ({}) } });
  h.plugin.internals = { enhancedUi: { buildPanelHtml: () => '<div class="je-panel-main"></div>', wireShortcutEditor() {},
    wireSettingsListeners() {}, wireHiddenContentListeners() {}, wireMiscSettingsControls() {}, wireLanguageControls() {} } };
  h.load('enhanced/settingspanel/ui-panel.js');

  const opening = h.plugin.showEnhancedPanel();
  await until(() => panelRequested);
  current = 'user-b'; h.switchUser('user-b');
  await until(() => bRequested);
  panelGet.resolve();
  await opening;
  assert.equal(h.plugin.userConfig.settingsStatus, 'loading');
  assert.deepEqual(plain(h.plugin.currentSettings), {}, 'user-a\'s settings are not installed for user-b');
  assert.equal(h.document.getElementById('jellyfin-enhanced-panel'), null, 'no panel is built from the stale answer');
  await h.plugin.saveUserSettings('settings.json', h.plugin.currentSettings);
  assert.deepEqual(posts, []);

  const loaded = new Promise(resolve => h.document.addEventListener('je:user-data-loaded', resolve, { once: true }));
  bBootstrap.resolve(payload({ UserId: 'user-b', UserSettings: { Settings: { AutoPauseEnabled: true }, SettingsStatus: 'ok' } }));
  await loaded;
  assert.equal(h.plugin.userConfig.settingsStatus, 'ok');
  assert.equal(h.plugin.currentSettings.autoPipEnabled, false);
});

// Design item C1: the bootstrap advertises the key-level save route and carries the settings Meta.
for (const advertised of [true, false]) test(`settings saves use ${advertised ? 'the patch route' : 'the whole-document route'} when Capabilities ${advertised ? 'has' : 'lacks'} settingsPatch`, async t => {
  const posts = [];
  const meta = { Schema: 2, Following: ['AutoPipEnabled'], Chosen: ['QualityTagsEnabled'], Defaults: { AutoPipEnabled: false }, Unavailable: { UseNativePosterTags: 'NativePosterTagsEnabled' } };
  const settings = { AutoPipEnabled: false, QualityTagsEnabled: true, IsAdmin: false };
  const data = payload({ UserSettings: { Settings: settings, SettingsMeta: meta, SettingsStatus: 'ok' }, ...(advertised ? { Capabilities: ['settingsPatch'] } : {}) });
  const h = setup(t, { ajax: async (path, request) => {
    if (path.endsWith('/bootstrap')) return data;
    posts.push({ path, body: JSON.parse(request.data) });
    return path.endsWith('/patch') ? { success: true, Rejected: [], Settings: { ...settings, ...JSON.parse(request.data).Set }, Meta: meta } : undefined;
  } });
  await until(() => h.plugin.initialized);
  assert.deepEqual(plain(h.plugin.serverCapabilities), advertised ? ['settingsPatch'] : []);
  assert.deepEqual(plain(h.plugin.settingsMeta), { schema: 2, following: ['autoPipEnabled'], chosen: ['qualityTagsEnabled'],
    defaults: { autoPipEnabled: false }, unavailable: { useNativePosterTags: 'NativePosterTagsEnabled' } });
  h.plugin.currentSettings.autoPipEnabled = true;
  const saved = h.plugin.saveUserSettings('settings.json', h.plugin.currentSettings);
  h.window.dispatchEvent(new h.window.Event('pagehide')); // send the merge window now
  await saved;
  if (advertised) {
    assert.deepEqual(posts, [{ path: '/JellyfinEnhanced/user-settings/user-a/settings.json/patch', body: { Set: { AutoPipEnabled: true } } }]);
  } else {
    assert.deepEqual(posts.map(p => p.path), ['/JellyfinEnhanced/user-settings/user-a/settings.json']);
    assert.equal(posts[0].body.AutoPipEnabled, true);
    assert.equal(posts[0].body.QualityTagsEnabled, true);
  }
});
