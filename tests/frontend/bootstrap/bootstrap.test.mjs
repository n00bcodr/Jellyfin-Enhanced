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
  // The hidden list and shortcut overrides are saved whole: one that failed to load stays unknown (null),
  // never an empty list the next change would be saved over.
  assert.equal(h.plugin.userConfig.hiddenContent, null);
  assert.equal(h.plugin.userConfig.shortcuts, null);
  assert.equal(h.calls.filter(p => p.includes('/user-settings/user-a/')).length, 5);
});

// The server answers null for a document it could not load, and Jellyfin's serializer leaves null
// properties out of the response, so the bootstrap simply lacks that document.
for (const [label, userSettings] of [['left out', { Settings: {}, Bookmark: {}, Elsewhere: {} }], ['null', { Settings: {}, Shortcuts: null, Bookmark: {}, Elsewhere: {}, HiddenContent: null }]]) {
  test(`a hidden list or shortcut list the server could not read (${label}) stays unknown`, async t => {
    const h = setup(t, { data: payload({ UserSettings: userSettings }) });
    await until(() => h.plugin.initialized);
    assert.equal(h.plugin.userConfig.hiddenContent, null);
    assert.equal(h.plugin.userConfig.shortcuts, null);
  });
}

test('documents the server loaded are used as they are, empty ones included', async t => {
  const h = setup(t, { data: payload({ UserSettings: { Settings: {}, Shortcuts: { Shortcuts: [] }, Bookmark: {}, Elsewhere: {}, HiddenContent: { Items: { a: { ItemId: 'a' } }, Settings: {} } } }) });
  await until(() => h.plugin.initialized);
  assert.deepEqual(plain(h.plugin.userConfig.hiddenContent), { items: { a: { itemId: 'a' } }, settings: {} });
  assert.deepEqual(plain(h.plugin.userConfig.shortcuts), { Shortcuts: [] });
});

// hidden-content.json as the server stores and answers it: the C# model's property names with every
// property present. A POST is bound to that model (names matched case-insensitively, absent ones at
// their defaults) and written back out with the model's names.
const HIDDEN_SETTINGS = { Enabled: true, FilterLibrary: true, FilterDiscovery: true, FilterUpcoming: true, FilterCalendar: true, FilterSearch: false,
  FilterRecommendations: true, FilterRequests: true, FilterNextUp: true, FilterContinueWatching: true, ShowHideButtons: true,
  ShowHideConfirmation: true, ShowButtonJellyseerr: true, ShowButtonLibrary: false, ShowButtonDetails: true, ShowButtonCast: false,
  ExperimentalHideCollections: false };
const HIDDEN_ITEM = { ItemId: '', Name: '', Type: '', TmdbId: '', HiddenAt: '', PosterPath: '', SeriesId: '', SeriesName: '',
  SeasonNumber: null, EpisodeNumber: null, HideScope: 'global' };
const bindTo = (model, body) => Object.fromEntries(Object.entries(model).map(([name, value]) => {
  const posted = Object.keys(body || {}).find(key => key.toLowerCase() === name.toLowerCase());
  return [name, posted === undefined ? value : body[posted]];
}));
const asStoredHiddenContent = body => ({
  Items: Object.fromEntries(Object.entries(body.Items ?? body.items ?? {}).map(([key, entry]) => [key, bindTo(HIDDEN_ITEM, entry)])),
  Settings: bindTo(HIDDEN_SETTINGS, body.Settings ?? body.settings)
});

test('a hidden list booted and saved in the shape the server answers and stores keeps every change', async t => {
  const dashed = '01234567-89ab-cdef-0123-456789abcdef', undashed = '0123456789abcdef0123456789abcdef';
  let stored = asStoredHiddenContent({ items: { a: { itemId: 'a', name: 'A' },
    [dashed]: { itemId: dashed, name: 'Episode', type: 'Episode', hideScope: 'continuewatching' },
    [undashed]: { itemId: undashed, name: 'Episode', type: 'Episode' } }, settings: { filterSearch: true } });
  const requests = [];
  const h = setup(t, { ajax: async (path, request) => {
    if (path.endsWith('/bootstrap')) return payload({ UserSettings: { Settings: {}, Shortcuts: { Shortcuts: [] }, Bookmark: {}, Elsewhere: {}, HiddenContent: plain(stored) } });
    if (path !== '/JellyfinEnhanced/user-settings/user-a/hidden-content.json') throw new Error(`Unexpected endpoint ${path}`);
    requests.push({ type: request.type, body: request.data && JSON.parse(request.data) });
    if (request.type === 'GET') return plain(stored);
    stored = asStoredHiddenContent(JSON.parse(request.data));
    return { success: true, file: 'hidden-content.json' };
  } });
  await until(() => h.plugin.initialized);
  for (const name of ['data', 'save', 'dialogs', 'filter']) h.load(`enhanced/hiddencontent/hidden-content-${name}.js`);
  const hc = h.plugin.internals.hiddenContent;
  hc.resetFromUserConfig();
  const posts = () => requests.filter(r => r.type === 'POST');

  // Another device hides b and turns the calendar filter off; this tab removes the Continue Watching
  // entry (not the hide of the same episode), turns the library filter off and hides c.
  stored.Items.b = asStoredHiddenContent({ items: { b: { itemId: 'b', name: 'B' } } }).Items.b;
  stored.Settings.FilterCalendar = false;
  assert.equal(hc.unhideItem(dashed), true);
  assert.equal(hc.updateSettings({ filterLibrary: false }), true);
  assert.equal(hc.hideItem({ itemId: 'c', name: 'C', type: 'Movie' }), true);
  await until(() => posts().length === 1);

  assert.deepEqual(Object.keys(stored.Items).sort(), [undashed, 'a', 'b', 'c']);
  assert.equal(stored.Items[undashed].Name, 'Episode');
  assert.deepEqual(stored.Settings, { ...HIDDEN_SETTINGS, FilterSearch: true, FilterCalendar: false, FilterLibrary: false });
  assert.deepEqual(Object.keys(posts()[0].body).sort(), ['items', 'settings'], 'one spelling of each property is posted');
  assert.equal(hc.isHidden('b'), true, 'the tab shows what the save read');

  assert.equal(hc.unhideItem('b'), true);
  await until(() => posts().length === 2);
  assert.deepEqual(Object.keys(stored.Items).sort(), [undashed, 'a', 'c']);
  await new Promise(resolve => setTimeout(resolve, 1000));
  assert.equal(requests.length, 4, 'two saves, one read and one write each; the stored shape is not taken as a change');
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

// Item looks are projected per caller (only items that user can see); a same-tab switch must not keep the last user's list.
const LOOK_A = [{ ItemId: 'a'.repeat(32), Layout: 'bands' }], LOOK_B = [{ ItemId: 'b'.repeat(32), Layout: 'minimal' }];
test('a same-tab user switch serves the incoming user\'s item looks from the bootstrap', async t => {
  const h = setup(t, { data: id => payload({ UserId: id, PublicConfig: { TagLookItemOverrides: id === 'user-a' ? LOOK_A : LOOK_B } }) });
  await until(() => h.plugin.initialized);
  assert.deepEqual(plain(h.plugin.pluginConfig.TagLookItemOverrides), LOOK_A);
  const loaded = new Promise(resolve => h.document.addEventListener('je:user-data-loaded', resolve, { once: true }));
  h.switchUser('user-b');
  assert.equal(h.plugin.pluginConfig.TagLookItemOverrides, null, 'nothing reads the outgoing list during the switch');
  await loaded;
  assert.deepEqual(plain(h.plugin.pluginConfig.TagLookItemOverrides), LOOK_B);
  assert.equal(h.calls.filter(p => p.endsWith('/bootstrap')).length, 2);
});

test('a same-tab user switch on the per-endpoint fallback refetches the public config for the item looks', async t => {
  let id = 'user-a';
  const h = setup(t, { ajax: async path => {
    if (path.endsWith('/bootstrap')) return payload({ UserId: 'user-a', PublicConfig: { TagLookItemOverrides: LOOK_A } });
    if (path.endsWith('/public-config')) return { TagLookItemOverrides: id === 'user-b' ? LOOK_B : LOOK_A, QualityTagsEnabled: true };
    if (path.endsWith('/private-config') || path.startsWith('/JellyfinEnhanced/user-settings/user-b/')) return {};
    throw new Error(`Unexpected endpoint ${path}`);
  } });
  await until(() => h.plugin.initialized);
  assert.deepEqual(plain(h.plugin.pluginConfig.TagLookItemOverrides), LOOK_A);
  assert.ok(!h.calls.includes('/JellyfinEnhanced/public-config'), 'the boot used the bootstrap');
  const loaded = new Promise(resolve => h.document.addEventListener('je:user-data-loaded', resolve, { once: true }));
  id = 'user-b'; h.switchUser('user-b');
  await loaded;
  assert.deepEqual(plain(h.plugin.pluginConfig.TagLookItemOverrides), LOOK_B);
  assert.equal(h.plugin.pluginConfig.QualityTagsEnabled, undefined, 'only the per-user fields are taken from it');
  assert.ok(h.calls.includes('/JellyfinEnhanced/public-config'));
});
