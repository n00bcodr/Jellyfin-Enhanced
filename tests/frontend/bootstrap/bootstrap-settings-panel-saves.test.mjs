import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from '../helpers/harness.mjs';

// Design item A7: panel saves are not amplified (no settings.json write per section click, one write
// per colour drag) and a failed save is visible.

/** Window timers the test advances by hand (the code under test runs in the jsdom window). */
function manualTimers() {
  let nextId = 0;
  const pending = new Map();
  return {
    setTimeout: (fn, ms) => { const id = ++nextId; pending.set(id, { fn, ms }); return id; },
    clearTimeout: id => { pending.delete(id); },
    pending,
    runAll() { for (const [id, { fn }] of [...pending]) { pending.delete(id); fn(); } }
  };
}

const settle = () => new Promise(resolve => setImmediate(resolve));

// What a failed save says when the loaded locale file has no 'toast_settings_save_failed' yet.
const SAVE_FAILED_EN = "Couldn't save your settings. Check your connection, then try again.";

const colourHtml = `<input type="color" id="customSubtitleTextColorPicker" value="#ffffff"><input type="range" id="customSubtitleTextAlpha" min="0" max="255" value="255">
  <input type="color" id="customSubtitleBgColorPicker" value="#000000"><input type="range" id="customSubtitleBgAlpha" min="0" max="255" value="0">
  <div id="subtitleColorPreview"></div><input type="checkbox" id="autoPauseToggle">`;

function setupSettings(t, { fail = false, patch = false } = {}) {
  const posts = [], toasts = [], closeCallbacks = [];
  const timers = manualTimers();
  // JE.session (core/session.js): the epoch moves on every user switch.
  const session = { epoch: 1, getEpoch() { return this.epoch; }, isCurrent(epoch) { return epoch === this.epoch; } };
  const h = createHarness({ html: colourHtml, globals: { setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout },
    JE: { pluginConfig: {}, userConfig: { settings: {}, shortcuts: { Shortcuts: [] } }, currentSettings: {}, session,
      t: key => key, toast: message => toasts.push(message), applySavedStylesWhenReady() {}, getSubtitleTextShadow: () => 'none' },
    apiClient: { ajax: async request => {
      posts.push(JSON.parse(request.data));
      if (fail) throw new Error('500 Internal Server Error');
    } } });
  t.after(() => h.close());
  h.load('enhanced/config.js'); h.JE.currentSettings = h.JE.loadSettings();
  if (patch) {
    // A server document to save against: only keys it has are sent.
    h.JE.serverCapabilities = ['settingsPatch'];
    h.JE.userConfig.settings = { customSubtitleTextColor: '#FFFFFFFF', customSubtitleBgColor: '#00000000', usingCustomColors: false };
  }
  h.load('enhanced/settingspanel/ui-panel-settings.js');
  // Only the colour pickers and one toggle exist; the wiring skips absent controls except these ids.
  for (const id of ['autoResumeToggle', 'autoPipToggle', 'autoSkipIntroToggle', 'autoSkipOutroToggle', 'randomButtonToggle',
    'randomUnwatchedOnly', 'randomScopeCurrentContainer', 'showWatchProgressToggle', 'showFileSizesToggle', 'showAudioLanguagesToggle',
    'removeContinueWatchingToggle', 'qualityTagsToggle', 'genreTagsToggle', 'pauseScreenToggle', 'languageTagsToggle', 'ratingTagsToggle',
    'ageRatingTagsToggle', 'peopleTagsToggle', 'tagsHideOnHoverToggle', 'disableCustomSubtitleStyles', 'longPress2xEnabled']) {
    h.document.body.insertAdjacentHTML('beforeend', `<input type="checkbox" id="${id}">`);
  }
  h.JE.internals.enhancedUi.wireSettingsListeners({ createToast: (key, enabled) => `${key}:${enabled}`, resetAutoCloseTimer() {},
    onPanelClose: fn => closeCallbacks.push(fn) });
  const fire = (id, type, value) => {
    const input = h.document.getElementById(id);
    if (value !== undefined) input.value = value;
    input.dispatchEvent(new h.window.Event(type, { bubbles: true }));
  };
  return { ...h, posts, toasts, timers, closeCallbacks, session, fire };
}

test('dragging a colour or alpha control previews live and saves once after it settles', async t => {
  const h = setupSettings(t);
  for (const alpha of ['250', '200', '150', '100', '64']) h.fire('customSubtitleTextAlpha', 'input', alpha);
  h.fire('customSubtitleBgColorPicker', 'input', '#102030');
  await settle();
  assert.equal(h.posts.length, 0, 'no write while the control is still moving');
  assert.equal(h.JE.currentSettings.customSubtitleTextColor, '#ffffff40', 'the live value is current');
  assert.equal(h.document.getElementById('subtitleColorPreview').style.backgroundColor, 'rgba(16, 32, 48, 0)');
  assert.equal(h.timers.pending.size, 1, 'one pending save, restarted by every movement');
  assert.equal([...h.timers.pending.values()][0].ms, 300);

  h.timers.runAll(); await settle();
  assert.equal(h.posts.length, 1);
  assert.equal(h.posts[0].customSubtitleTextColor, '#ffffff40');
  assert.equal(h.posts[0].customSubtitleBgColor, '#10203000');
  assert.equal(h.posts[0].usingCustomColors, true);
});

test('releasing the control saves at once and cancels the pending delayed save', async t => {
  const h = setupSettings(t);
  h.fire('customSubtitleBgAlpha', 'input', '128');
  h.fire('customSubtitleBgAlpha', 'change');
  await settle();
  assert.equal(h.posts.length, 1);
  assert.equal(h.posts[0].customSubtitleBgColor, '#00000080');
  assert.equal(h.timers.pending.size, 0);
  h.fire('customSubtitleBgAlpha', 'change'); await settle();
  assert.equal(h.posts.length, 1, 'a release with nothing pending writes nothing');
});

test('closing the panel flushes a pending colour save', async t => {
  const h = setupSettings(t);
  h.fire('customSubtitleTextColorPicker', 'input', '#ff0000');
  assert.equal(h.closeCallbacks.length, 1);
  h.closeCallbacks[0](); await settle();
  assert.equal(h.posts.length, 1);
  assert.equal(h.posts[0].customSubtitleTextColor, '#ff0000FF');
  assert.equal(h.timers.pending.size, 0);
});

test('a pending colour save is flushed when the page is hidden or unloaded, until the panel closes', async t => {
  const h = setupSettings(t);
  h.fire('customSubtitleTextColorPicker', 'input', '#00ff00');
  h.window.dispatchEvent(new h.window.Event('pagehide')); await settle();
  assert.equal(h.posts.length, 1, 'pagehide (reload, navigation) saves the pending colour');
  assert.equal(h.posts[0].customSubtitleTextColor, '#00ff00FF');
  assert.equal(h.timers.pending.size, 0);

  h.fire('customSubtitleTextColorPicker', 'input', '#0000ff');
  h.document.dispatchEvent(new h.window.Event('visibilitychange')); await settle();
  assert.equal(h.posts.length, 1, 'a visibilitychange while still visible does nothing');
  Object.defineProperty(h.document, 'visibilityState', { configurable: true, value: 'hidden' });
  h.document.dispatchEvent(new h.window.Event('visibilitychange')); await settle();
  assert.equal(h.posts.length, 2, 'hiding the tab saves it');
  assert.equal(h.posts[1].customSubtitleTextColor, '#0000ffFF');

  h.closeCallbacks[0]();
  h.fire('customSubtitleTextColorPicker', 'input', '#ff00ff');
  h.window.dispatchEvent(new h.window.Event('pagehide'));
  h.document.dispatchEvent(new h.window.Event('visibilitychange')); await settle();
  assert.equal(h.posts.length, 2, 'the page listeners go away with the panel');
});

test('with key-level saves, a colour flushed on pagehide is sent at once, not after the merge window', async t => {
  const h = setupSettings(t, { patch: true });
  h.fire('customSubtitleTextColorPicker', 'input', '#00ff00');
  // The transport's own pagehide flush runs first (config.js loads first) and finds nothing yet.
  h.window.dispatchEvent(new h.window.Event('pagehide')); await settle();
  assert.equal(h.posts.length, 1, 'sent before the page goes away');
  assert.equal(h.posts[0].Set.CustomSubtitleTextColor, '#00ff00FF');
  assert.equal(h.timers.pending.size, 0, 'no merge-window timer left behind');

  // Hidden (not unloaded) also sends at once.
  h.fire('customSubtitleTextColorPicker', 'input', '#0000ff');
  Object.defineProperty(h.document, 'visibilityState', { configurable: true, value: 'hidden' });
  h.document.dispatchEvent(new h.window.Event('visibilitychange')); await settle();
  assert.equal(h.posts.length, 2);
  assert.equal(h.posts[1].Set.CustomSubtitleTextColor, '#0000ffFF');
});

test('a colour save scheduled before a user switch is dropped, not written to the incoming user', async t => {
  const h = setupSettings(t);
  h.fire('customSubtitleBgColorPicker', 'input', '#123456');
  h.session.epoch++;
  h.timers.runAll(); await settle();
  assert.deepEqual(h.posts, [], 'the delayed save is dropped');

  h.fire('customSubtitleBgColorPicker', 'input', '#654321');
  h.session.epoch++;
  h.closeCallbacks[0](); await settle();
  assert.deepEqual(h.posts, [], 'so is the flush on close');
  assert.equal(h.timers.pending.size, 0);
});

test('a failed panel save shows a translated error toast once per burst and keeps the new value', async t => {
  const h = setupSettings(t, { fail: true });
  h.expectConsoleError(/Failed to save settings\.json/);
  const toggle = h.document.getElementById('autoPauseToggle');
  toggle.checked = false; toggle.dispatchEvent(new h.window.Event('change', { bubbles: true }));
  await settle(); await settle();
  assert.deepEqual(h.toasts, ['feature_auto_pause:false', SAVE_FAILED_EN], 'English while the locale lacks the key');
  assert.equal(h.JE.currentSettings.autoPauseEnabled, false, 'no revert is promised (design 5.3)');
  // A second failure right after does not stack another toast.
  toggle.checked = true; toggle.dispatchEvent(new h.window.Event('change', { bubbles: true }));
  await settle(); await settle();
  assert.deepEqual(h.toasts, ['feature_auto_pause:false', SAVE_FAILED_EN, 'feature_auto_pause:true']);
});

test('saveUserSettings toasts only when asked to and only for a failed request', async t => {
  const toasts = [];
  let failing = true;
  const h = createHarness({ JE: { pluginConfig: {}, userConfig: { settings: {}, settingsStatus: 'ok' },
    t: key => key === 'toast_settings_save_failed' ? 'Nicht gespeichert' : key, toast: m => toasts.push(m) },
    apiClient: { ajax: async () => { if (failing) throw new Error('offline'); } } });
  t.after(() => h.close());
  h.expectConsoleError(/Failed to save settings\.json/);
  h.load('enhanced/config.js');
  await h.JE.saveUserSettings('settings.json', { a: 1 });
  assert.deepEqual(toasts, [], 'callers that did not opt in keep the log-only behaviour');
  await assert.rejects(h.JE.saveUserSettings('settings.json', { a: 2 }, { throwOnError: true, notifyOnError: true }), /offline/);
  assert.deepEqual(toasts, ['Nicht gespeichert'], 'the translation when the locale has it');
  failing = false;
  await h.JE.saveUserSettings('settings.json', { a: 3 }, { notifyOnError: true });
  assert.deepEqual(toasts, ['Nicht gespeichert'], 'a successful save shows nothing');
  h.JE.userConfig.settingsStatus = 'unavailable';
  await h.JE.saveUserSettings('settings.json', { a: 4 }, { notifyOnError: true });
  assert.deepEqual(toasts, ['Nicht gespeichert'], 'a refusal while settings are unavailable is the panel\'s notice, not a toast');
});

// The panel host (ui-panel.js) runs unchanged; the template is a stub with three panes.
const panelHtml = `<style>.je-pane { display: none; } .je-pane.active { display: block; }</style><div class="panel-header"></div><div class="je-panel-body">
  <div class="je-panel-nav"><div class="je-panel-nav-items"></div></div>
  <div class="je-panel-main"><button id="jePanelBack" class="je-pane-back" type="button"></button>
    <section class="je-pane" data-pane="shortcuts"><h3 class="je-pane-title">Shortcuts</h3></section>
    <section class="je-pane" data-pane="playback"><h3 class="je-pane-title">Playback</h3><input type="checkbox" id="autoPauseToggle"></section>
    <section class="je-pane" data-pane="language"><h3 class="je-pane-title">Language</h3></section>
  </div></div><button id="closeSettingsPanel" type="button"></button>`;

function setupPanel(t, { stored = {}, userId = 'user-a', storage = {}, failPosts = false, phone = false } = {}) {
  const posts = [], toasts = [];
  const requests = { gets: 0 };
  const h = createHarness({
    globals: { matchMedia: () => ({ matches: phone, addEventListener() {}, removeEventListener() {} }) },
    JE: { pluginConfig: {}, userConfig: { settings: {}, shortcuts: { Shortcuts: [] }, settingsStatus: 'ok' }, currentSettings: {},
      state: { activeShortcuts: { OpenSearch: '/' } }, t: key => key, keyListener() {}, toast: message => toasts.push(message),
      toCamelCase: value => Object.fromEntries(Object.entries(value).map(([k, v]) => [k[0].toLowerCase() + k.slice(1), v])),
      themer: { getThemeVariables: () => ({}) } },
    apiClient: { getCurrentUserId: () => userId, ajax: async request => {
      if (request.type === 'POST') {
        posts.push(new URL(request.url).pathname);
        if (failPosts) throw new Error('offline');
        return {};
      }
      requests.gets++;
      return stored;
    } }
  });
  t.after(() => h.close());
  for (const [key, value] of Object.entries(storage)) h.window.localStorage.setItem(key, value);
  h.load('enhanced/config.js');
  h.JE.internals = { enhancedUi: { buildPanelHtml: () => panelHtml, wireShortcutEditor() {}, wireSettingsListeners() {},
    wireHiddenContentListeners() {}, wireMiscSettingsControls() {}, wireLanguageControls() {} } };
  h.load('enhanced/settingspanel/ui-panel.js');
  const panel = () => h.document.getElementById('jellyfin-enhanced-panel');
  const activePane = () => panel().querySelector('.je-pane.active')?.dataset.pane;
  const nav = name => panel().querySelector(`.je-panel-nav-items .tab-button[data-tab="${name}"]`);
  return { ...h, posts, toasts, requests, panel, activePane, nav };
}

test('switching sections writes nothing to the server and the next panel reopens the last section', async t => {
  const h = setupPanel(t, { stored: { LastOpenedTab: 'shortcuts' } });
  await h.JE.showEnhancedPanel();
  assert.equal(h.activePane(), 'shortcuts');
  h.nav('language').click(); h.nav('playback').click();
  await settle();
  assert.deepEqual(h.posts, [], 'section clicks no longer POST settings.json');
  assert.equal(h.window.localStorage.getItem('JE_panel_last_tab_server-a_user-a'), 'playback');
  assert.equal(h.JE.currentSettings.lastOpenedTab, 'shortcuts', 'the stored document is left as it was');

  await h.JE.showEnhancedPanel(); // closes
  await h.JE.showEnhancedPanel();
  assert.equal(h.activePane(), 'playback');
});

test('a value stored in settings.json by an older version is used once, then the device value wins', async t => {
  const h = setupPanel(t, { stored: { LastOpenedTab: 'language' } });
  await h.JE.showEnhancedPanel();
  assert.equal(h.activePane(), 'language');
  assert.equal(h.window.localStorage.getItem('JE_panel_last_tab_server-a_user-a'), 'language', 'copied to this device');
  h.nav('playback').click();
  await h.JE.showEnhancedPanel(); await h.JE.showEnhancedPanel();
  assert.equal(h.activePane(), 'playback', 'the legacy value no longer applies');
  assert.deepEqual(h.posts, []);
});

test('the remembered section is per server and user', async t => {
  const h = setupPanel(t, { userId: 'user-b', stored: { LastOpenedTab: 'shortcuts' },
    storage: { 'JE_panel_last_tab_server-a_user-a': 'language', 'JE_panel_last_tab_server-b_user-b': 'language' } });
  await h.JE.showEnhancedPanel();
  assert.equal(h.activePane(), 'shortcuts', 'another user\'s or server\'s choice is not used');
});

test('a failed save while the panel is open is shown inside it, where the phone sheet cannot cover it', async t => {
  const h = setupPanel(t, { failPosts: true, phone: true });
  h.expectConsoleError(/Failed to save settings\.json/);
  await h.JE.showEnhancedPanel();
  await h.JE.saveUserSettings('settings.json', { a: 1 }, { notifyOnError: true });
  const strip = h.panel().querySelector('.je-save-error');
  assert.ok(strip, 'the message is in the panel');
  assert.equal(strip.getAttribute('role'), 'alert', 'announced by screen readers');
  assert.equal(strip.textContent, SAVE_FAILED_EN);
  assert.equal(strip.previousElementSibling, h.panel().querySelector('.panel-header'), 'between the header and the sections');
  assert.equal(strip.closest('[inert]'), null, 'outside the phone layers that go inert');
  assert.deepEqual(h.toasts, [], 'not a toast under the panel');

  // With the panel closed, the toast is the place for it.
  await h.JE.showEnhancedPanel();
  assert.equal(h.panel(), null);
  const now = h.window.Date.now();
  h.window.Date.now = () => now + 5000;
  await h.JE.saveUserSettings('settings.json', { a: 2 }, { notifyOnError: true });
  assert.deepEqual(h.toasts, [SAVE_FAILED_EN]);
});

test('closing the panel by opening it again flushes pending saves before the settings are re-read', async t => {
  const h = setupPanel(t, { stored: { CustomSubtitleTextColor: '#FFFFFFFF' } });
  const atClose = [];
  h.JE.internals.enhancedUi.wireSettingsListeners = ctx => ctx.onPanelClose(() =>
    atClose.push({ colour: h.JE.currentSettings.customSubtitleTextColor, gets: h.requests.gets }));
  await h.JE.showEnhancedPanel();
  assert.equal(h.requests.gets, 1);
  h.JE.currentSettings.customSubtitleTextColor = '#FF0000FF'; // a colour the user just picked, not yet saved
  await h.JE.showEnhancedPanel();
  assert.equal(h.panel(), null);
  assert.deepEqual(atClose, [{ colour: '#FF0000FF', gets: 1 }], 'the pending save sees the user\'s colour, no refresh first');
  assert.equal(h.requests.gets, 1, 'closing does not re-read the settings');
});
