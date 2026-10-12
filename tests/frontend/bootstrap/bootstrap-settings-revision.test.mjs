import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, plain, deferred } from '../helpers/harness.mjs';

// Design item C5: when the page becomes visible or the window gets focus (at most once a minute,
// never while hidden, no timer), GET user-settings/{userId}/revision asks whether the settings file
// or the admin configuration changed; only then is the bootstrap fetched again and applied beneath
// pending edits, with `je:settings-changed` and the JE.settings.onChange handlers.

const modules = ['core/navigation.js', 'core/session.js', 'enhanced/config.js'];
const MINUTE = 60000;

/** A bootstrap payload for `userId` with the given settings (PascalCase) and Meta revision/epoch. */
function payload(userId, { settings = {}, revision = 'rev-1', epoch = 'epoch-1', publicConfig = {}, privateConfig = null, capabilities = ['settingsPatch', 'settingsRevision'], meta = {} } = {}) {
  return {
    UserId: userId, Version: '1.2.3', PublicConfig: structuredClone(publicConfig), PrivateConfig: privateConfig ? structuredClone(privateConfig) : null,
    HasCustomTabs: false, HasPluginPages: false, Capabilities: capabilities, ComponentScripts: modules,
    UserSettings: { Settings: { AutoPipEnabled: false, QualityTagsEnabled: false, WatchProgressMode: 'percentage', IsAdmin: false, ...settings },
      SettingsMeta: { Schema: 2, Revision: revision, ConfigEpoch: epoch, Locked: [], Unavailable: {}, ...meta }, SettingsStatus: 'ok' }
  };
}

async function until(predicate) {
  const deadline = performance.now() + 3000;
  while (performance.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  assert.ok(predicate(), 'did not reach the expected state');
}
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve)); };

/**
 * Boots plugin.js (with session.js and config.js) for user-a. `server[userId]` is what that user's
 * bootstrap and revision answer; `respond(path, request)` may answer a request first (return
 * undefined to fall through). The clock (window Date.now) and page visibility are the test's.
 */
async function setup(t, { server: initial, respond } = {}) {
  let userId = 'user-a';
  const calls = [], events = [];
  const server = initial || { 'user-a': { bootstrap: () => payload('user-a'), revision: { Settings: 'rev-1', Config: 'epoch-1' } } };
  let clock = 1_000_000;
  let visibility = 'visible';
  const h = createHarness({ html: '<script plugin="Jellyfin Enhanced" version="1.2.3-build123"></script>',
    apiClient: { getCurrentUserId: () => userId, ajax: async request => {
      const path = new URL(request.url).pathname;
      calls.push(request.type === 'POST' ? `POST ${path}` : path);
      if (respond) {
        const answer = await respond(path, request);
        if (answer !== undefined) return answer;
      }
      const user = server[path.split('/')[3]] || server[userId];
      if (path.endsWith('/bootstrap')) return server[userId].bootstrap();
      if (path.endsWith('/revision')) return structuredClone(user.revision);
      throw new Error(`Unexpected endpoint ${path}`);
    } } });
  t.after(() => h.close());
  h.window.Date.now = () => clock;
  Object.defineProperty(h.document, 'visibilityState', { configurable: true, get: () => visibility });
  h.window.requestIdleCallback = callback => { queueMicrotask(() => callback({ didTimeout: false, timeRemaining: () => 100 })); return 1; };
  const append = h.document.head.appendChild.bind(h.document.head);
  h.document.head.appendChild = node => {
    const result = append(node);
    if (node.tagName !== 'SCRIPT') return result;
    queueMicrotask(() => {
      const path = new URL(node.src).pathname;
      if (path.endsWith('/translations.js')) h.window.JellyfinEnhanced.loadTranslations = async () => ({});
      else if (path.endsWith('/bundle.js')) {
        h.window.__JE_BUNDLE_TOTAL = modules.length;
        h.window.__JE_BUNDLE_MODULES = modules.map(name => () => {
          h.load(name);
          if (name === 'enhanced/config.js') h.window.JellyfinEnhanced.hideSplashScreen = () => {};
        });
      }
      node.onload?.();
    });
    return result;
  };
  h.load('plugin.js');
  await until(() => h.window.JellyfinEnhanced.initialized);
  h.document.addEventListener('je:settings-changed', e => events.push(plain(e.detail)));
  return {
    ...h, calls, events, server,
    get plugin() { return h.window.JellyfinEnhanced; },
    /** Advances the clock. */
    tick(ms) { clock += ms; },
    hide() { visibility = 'hidden'; h.document.dispatchEvent(new h.window.Event('visibilitychange')); },
    show() { visibility = 'visible'; h.document.dispatchEvent(new h.window.Event('visibilitychange')); },
    focus() { h.window.dispatchEvent(new h.window.Event('focus')); },
    switchUser(id) { userId = id; h.window.JellyfinEnhanced.session.checkNow('test'); },
    /** Requests made after boot (the boot bootstrap excluded). */
    get later() { return calls.slice(1); }
  };
}

test('nothing is requested while the page is hidden, or within a minute of boot', async t => {
  const h = await setup(t);
  h.show(); h.focus(); await settle();
  assert.deepEqual(h.later, [], 'boot loaded everything a moment ago');
  h.tick(MINUTE);
  h.hide(); h.focus(); await settle();
  assert.deepEqual(h.later, [], 'hidden: no request, even on focus');
  h.show(); await settle();
  assert.deepEqual(h.later, ['/JellyfinEnhanced/user-settings/user-a/revision'], 'one check on becoming visible');
  assert.equal(h.events.length, 0, 'nothing changed');
});

test('checks are throttled to one a minute, with no polling in between', async t => {
  const h = await setup(t);
  h.tick(MINUTE);
  h.show(); h.focus(); h.focus(); await settle();
  assert.equal(h.later.length, 1, 'visibilitychange and focus together make one check');
  h.tick(MINUTE - 1); h.focus(); await settle();
  assert.equal(h.later.length, 1, 'still within the minute');
  h.tick(10 * MINUTE); await settle();
  assert.equal(h.later.length, 1, 'no request without a focus or visibility change');
  h.focus(); await settle();
  assert.equal(h.later.length, 2);
  assert.ok(h.later.every(path => path.endsWith('/revision')), 'unchanged revisions fetch nothing else');
});

test('a settings change made elsewhere is fetched with one bootstrap, applied and announced', async t => {
  const h = await setup(t);
  const seen = [];
  const off = h.plugin.settings.onChange('QualityTagsEnabled', (value, key) => seen.push([key, value]));
  h.plugin.settings.onChange('qualityTagsEnabled', () => { throw new Error('broken handler'); });
  h.plugin.settings.onChange('qualityTagsEnabled', (value) => seen.push(['second', value]));
  h.expectConsoleError(/settings change handler for qualityTagsEnabled failed/);
  const before = h.plugin.currentSettings;
  // Another device turned quality tags on and chose another progress mode.
  h.server['user-a'].bootstrap = () => payload('user-a', { settings: { QualityTagsEnabled: true, WatchProgressMode: 'time' }, revision: 'rev-2' });
  h.server['user-a'].revision = { Settings: 'rev-2', Config: 'epoch-1' };
  h.tick(MINUTE); h.focus(); await settle();
  assert.deepEqual(h.later, ['/JellyfinEnhanced/user-settings/user-a/revision', '/JellyfinEnhanced/bootstrap']);
  assert.equal(h.plugin.currentSettings, before, 'updated in place');
  assert.equal(h.plugin.currentSettings.qualityTagsEnabled, true);
  assert.equal(h.plugin.currentSettings.watchProgressMode, 'time');
  assert.equal(h.plugin.settingsMeta.revision, 'rev-2');
  assert.deepEqual(h.events, [{ keys: ['qualityTagsEnabled', 'watchProgressMode'], rejected: [] }]);
  assert.deepEqual(seen, [['qualityTagsEnabled', true], ['second', true]], 'handlers of the changed key, a failing one does not stop the next');

  // The same revision again: no bootstrap.
  off();
  h.tick(MINUTE); h.focus(); await settle();
  assert.equal(h.later.filter(path => path.endsWith('/bootstrap')).length, 1);
  // A later change reaches the remaining handler only.
  h.server['user-a'].bootstrap = () => payload('user-a', { settings: { QualityTagsEnabled: false }, revision: 'rev-3' });
  h.server['user-a'].revision = { Settings: 'rev-3', Config: 'epoch-1' };
  h.tick(MINUTE); h.focus(); await settle();
  assert.deepEqual(seen.slice(2), [['second', false]]);
});

test('an admin config change reaches an open tab: master switches, private config, defaults and locks', async t => {
  const h = await setup(t, { server: { 'user-a': {
    bootstrap: () => payload('user-a', { publicConfig: { ShowReviews: false, ToastDuration: 1500, BookmarksUseCustomTabs: true }, privateConfig: { SonarrUrl: 'a' } }),
    revision: { Settings: 'rev-1', Config: 'epoch-1' } } } });
  const config = h.plugin.pluginConfig;
  assert.equal(config.SonarrUrl, 'a');
  assert.equal(config.BookmarksUseCustomTabs, false, 'Custom Tabs is not installed');
  // The admin turns reviews on, drops ToastDuration from the public config (as a server could),
  // changes the private config and locks quality tags On: the served value changes with the lock
  // while the file stays as it was (the settings revision is unchanged).
  h.server['user-a'].bootstrap = () => payload('user-a', { settings: { QualityTagsEnabled: true }, epoch: 'epoch-2',
    meta: { Locked: ['QualityTagsEnabled'] },
    publicConfig: { ShowReviews: true, BookmarksUseCustomTabs: true }, privateConfig: { SonarrUrl: 'b' } });
  h.server['user-a'].revision = { Settings: 'rev-1', Config: 'epoch-2' };
  h.tick(MINUTE); h.show(); await settle();
  assert.deepEqual(h.later, ['/JellyfinEnhanced/user-settings/user-a/revision', '/JellyfinEnhanced/bootstrap']);
  assert.equal(h.plugin.pluginConfig, config, 'JE.pluginConfig is updated in place');
  assert.equal(config.ShowReviews, true);
  assert.equal('ToastDuration' in config, false);
  assert.equal(config.SonarrUrl, 'b');
  assert.equal(config.BookmarksUseCustomTabs, false, 'still forced off');
  assert.equal(h.plugin.currentSettings.qualityTagsEnabled, true);
  assert.equal(h.plugin.settings.isLocked('qualityTagsEnabled'), true);
  assert.deepEqual(h.events, [{ keys: ['qualityTagsEnabled'], rejected: [], meta: true, config: ['ShowReviews', 'ToastDuration', 'SonarrUrl'] }]);

  // The applied config's epoch is remembered: the next check fetches nothing more.
  h.tick(MINUTE); h.focus(); await settle();
  assert.equal(h.later.filter(path => path.endsWith('/bootstrap')).length, 1);
});

test('a config epoch that arrived with a save answer still refreshes the config on the next check', async t => {
  // The save answer's Meta carries the new ConfigEpoch, but not the configuration itself.
  const h = await setup(t, { respond: (path, request) => path.endsWith('/patch')
    ? { success: true, Rejected: [], Settings: { AutoPipEnabled: true, QualityTagsEnabled: false, WatchProgressMode: 'percentage', IsAdmin: false },
      Meta: { Schema: 2, Revision: 'rev-2', ConfigEpoch: 'epoch-2', Locked: [], Unavailable: {} } }
    : undefined });
  h.plugin.currentSettings.autoPipEnabled = true;
  const saved = h.plugin.saveUserSettings('settings.json', h.plugin.currentSettings);
  h.window.dispatchEvent(new h.window.Event('pagehide')); // send the merge window now
  await saved;
  h.server['user-a'].bootstrap = () => payload('user-a', { settings: { AutoPipEnabled: true }, revision: 'rev-2', epoch: 'epoch-2', publicConfig: { ShowReviews: true } });
  h.server['user-a'].revision = { Settings: 'rev-2', Config: 'epoch-2' };
  h.tick(MINUTE); h.focus(); await settle();
  assert.deepEqual(h.later.slice(1), ['/JellyfinEnhanced/user-settings/user-a/revision', '/JellyfinEnhanced/bootstrap']);
  assert.equal(h.plugin.pluginConfig.ShowReviews, true);
  assert.deepEqual(h.events, [{ keys: [], rejected: [], config: ['ShowReviews'] }]);
});

test('pending and unsaved edits survive a refresh; the other device\'s values land beneath them', async t => {
  const gate = deferred();
  const patches = [];
  let stored = { AutoPipEnabled: false, QualityTagsEnabled: false, WatchProgressMode: 'percentage', IsAdmin: false };
  const h = await setup(t, { respond: async (path, request) => {
    if (!path.endsWith('/patch')) return undefined;
    patches.push(JSON.parse(request.data));
    await gate.promise;
    Object.assign(stored, JSON.parse(request.data).Set);
    return { success: true, Rejected: [], Settings: { ...stored }, Meta: { Schema: 2, Revision: 'rev-3', ConfigEpoch: 'epoch-1', Locked: [], Unavailable: {} } };
  } });
  // A save in flight (auto-PiP on), and a value changed on the page and not saved yet.
  h.plugin.currentSettings.autoPipEnabled = true;
  const saved = h.plugin.saveUserSettings('settings.json', h.plugin.currentSettings);
  h.window.dispatchEvent(new h.window.Event('pagehide'));
  await until(() => patches.length === 1);
  h.plugin.currentSettings.watchProgressMode = 'time';
  // Meanwhile another device turned quality tags on and set the progress mode to 'none';
  // the refresh does not have our auto-PiP edit yet.
  stored = { ...stored, QualityTagsEnabled: true, WatchProgressMode: 'none' };
  h.server['user-a'].bootstrap = () => payload('user-a', { settings: stored, revision: 'rev-2' });
  h.server['user-a'].revision = { Settings: 'rev-2', Config: 'epoch-1' };
  h.tick(MINUTE); h.focus(); await settle();
  assert.ok(h.later.includes('/JellyfinEnhanced/bootstrap'));
  assert.equal(h.plugin.currentSettings.autoPipEnabled, true, 'the pending edit stays on top');
  assert.equal(h.plugin.currentSettings.watchProgressMode, 'time', 'the unsaved edit stays');
  assert.equal(h.plugin.currentSettings.qualityTagsEnabled, true, "the other device's value lands");
  assert.deepEqual(h.events, [{ keys: ['qualityTagsEnabled'], rejected: [] }]);

  gate.resolve(); await saved;
  assert.equal(h.plugin.currentSettings.autoPipEnabled, true);
  // The unsaved edit goes out with the next save; the other device's value is not sent back.
  const next = h.plugin.saveUserSettings('settings.json', h.plugin.currentSettings);
  h.window.dispatchEvent(new h.window.Event('pagehide'));
  gate.resolve(); await next;
  assert.deepEqual(patches.map(p => p.Set), [{ AutoPipEnabled: true }, { WatchProgressMode: 'time' }]);
  assert.equal(stored.QualityTagsEnabled, true);
});

test('a check in flight during a user switch is dropped; the next user starts afresh', async t => {
  const revisionGate = deferred();
  let held = false;
  const h = await setup(t, {
    server: {
      'user-a': { bootstrap: () => payload('user-a', { settings: { QualityTagsEnabled: false } }), revision: { Settings: 'rev-1', Config: 'epoch-1' } },
      'user-b': { bootstrap: () => payload('user-b', { settings: { QualityTagsEnabled: true }, revision: 'b-1' }), revision: { Settings: 'b-1', Config: 'epoch-1' } }
    },
    respond: async (path) => {
      if (path === '/JellyfinEnhanced/user-settings/user-a/revision' && !held) { held = true; await revisionGate.promise; return { Settings: 'changed', Config: 'epoch-9' }; }
      return undefined;
    }
  });
  h.tick(MINUTE); h.focus();
  await until(() => held);
  h.tick(MINUTE);
  const loaded = new Promise(resolve => h.document.addEventListener('je:user-data-loaded', resolve, { once: true }));
  h.switchUser('user-b');
  await loaded;
  revisionGate.resolve(); await settle();
  assert.deepEqual(h.later, ['/JellyfinEnhanced/user-settings/user-a/revision', '/JellyfinEnhanced/bootstrap'],
    "only the switch's own bootstrap: user-a's answer starts no refresh");
  assert.equal(h.plugin.currentSettings.qualityTagsEnabled, true, "user-b's settings stay");
  assert.equal(h.events.length, 0);

  // The switch counts as a fresh load for user-b: no check within the minute, then user-b's own.
  h.focus(); await settle();
  assert.equal(h.later.length, 2);
  h.tick(MINUTE); h.focus(); await settle();
  assert.deepEqual(h.later.slice(2), ['/JellyfinEnhanced/user-settings/user-b/revision']);
});

test('no check against a server without the route; a 404 stops the checks for this page', async t => {
  const h = await setup(t, { server: { 'user-a': { bootstrap: () => payload('user-a', { capabilities: ['settingsPatch'] }), revision: null } } });
  h.tick(MINUTE); h.focus(); await settle();
  assert.deepEqual(h.later, [], 'not advertised');

  let first = true;
  const g = await setup(t, { respond: (path) => {
    if (path.endsWith('/revision')) {
      if (first) { first = false; throw Object.assign(new Error('Not Found'), { status: 404 }); }
      throw new Error('should not be asked again');
    }
    return undefined;
  } });
  g.tick(MINUTE); g.focus(); await settle();
  g.tick(MINUTE); g.focus(); await settle();
  assert.deepEqual(g.later, ['/JellyfinEnhanced/user-settings/user-a/revision']);
});

test('settings that were unavailable load on the next check and become writable', async t => {
  const h = await setup(t, { server: { 'user-a': {
    bootstrap: () => ({ ...payload('user-a'), UserSettings: { Settings: null, SettingsMeta: null, SettingsStatus: 'unavailable' } }),
    revision: { Settings: 'rev-1', Config: 'epoch-1' } } } });
  assert.equal(h.plugin.userConfig.settingsStatus, 'unavailable');
  h.server['user-a'].bootstrap = () => payload('user-a', { settings: { QualityTagsEnabled: true } });
  h.tick(MINUTE); h.focus(); await settle();
  assert.equal(h.plugin.userConfig.settingsStatus, 'ok');
  assert.equal(h.plugin.currentSettings.qualityTagsEnabled, true);
  // Once loaded, the Meta's revision and epoch are the reference: an unchanged answer fetches nothing.
  h.tick(MINUTE); h.focus(); await settle();
  assert.deepEqual(h.later, ['/JellyfinEnhanced/user-settings/user-a/revision', '/JellyfinEnhanced/bootstrap', '/JellyfinEnhanced/user-settings/user-a/revision']);
});
