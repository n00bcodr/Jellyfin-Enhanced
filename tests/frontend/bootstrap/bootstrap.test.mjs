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
