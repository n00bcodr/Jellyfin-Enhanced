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

const colourHtml = `<input type="color" id="customSubtitleTextColorPicker" value="#ffffff"><input type="range" id="customSubtitleTextAlpha" min="0" max="255" value="255">
  <input type="color" id="customSubtitleBgColorPicker" value="#000000"><input type="range" id="customSubtitleBgAlpha" min="0" max="255" value="0">
  <div id="subtitleColorPreview"></div><input type="checkbox" id="autoPauseToggle">`;

function setupSettings(t, { fail = false } = {}) {
  const posts = [], toasts = [], closeCallbacks = [];
  const timers = manualTimers();
  const h = createHarness({ html: colourHtml, globals: { setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout },
    JE: { pluginConfig: {}, userConfig: { settings: {}, shortcuts: { Shortcuts: [] } }, currentSettings: {},
      t: key => key, toast: message => toasts.push(message), applySavedStylesWhenReady() {}, getSubtitleTextShadow: () => 'none' },
    apiClient: { ajax: async request => {
      posts.push(JSON.parse(request.data));
      if (fail) throw new Error('500 Internal Server Error');
    } } });
  t.after(() => h.close());
  h.load('enhanced/config.js'); h.JE.currentSettings = h.JE.loadSettings();
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
  return { ...h, posts, toasts, timers, closeCallbacks, fire };
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

test('a failed panel save shows a translated error toast once per burst and keeps the new value', async t => {
  const h = setupSettings(t, { fail: true });
  h.expectConsoleError(/Failed to save settings\.json/);
  const toggle = h.document.getElementById('autoPauseToggle');
  toggle.checked = false; toggle.dispatchEvent(new h.window.Event('change', { bubbles: true }));
  await settle(); await settle();
  assert.deepEqual(h.toasts, ['feature_auto_pause:false', 'toast_settings_save_failed']);
  assert.equal(h.JE.currentSettings.autoPauseEnabled, false, 'no revert is promised (design 5.3)');
  // A second failure right after does not stack another toast.
  toggle.checked = true; toggle.dispatchEvent(new h.window.Event('change', { bubbles: true }));
  await settle(); await settle();
  assert.deepEqual(h.toasts, ['feature_auto_pause:false', 'toast_settings_save_failed', 'feature_auto_pause:true']);
});

test('saveUserSettings toasts only when asked to and only for a failed request', async t => {
  const toasts = [];
  let failing = true;
  const h = createHarness({ JE: { pluginConfig: {}, userConfig: { settings: {}, settingsStatus: 'ok' }, t: key => key, toast: m => toasts.push(m) },
    apiClient: { ajax: async () => { if (failing) throw new Error('offline'); } } });
  t.after(() => h.close());
  h.expectConsoleError(/Failed to save settings\.json/);
  h.load('enhanced/config.js');
  await h.JE.saveUserSettings('settings.json', { a: 1 });
  assert.deepEqual(toasts, [], 'callers that did not opt in keep the log-only behaviour');
  await assert.rejects(h.JE.saveUserSettings('settings.json', { a: 2 }, { throwOnError: true, notifyOnError: true }), /offline/);
  assert.deepEqual(toasts, ['toast_settings_save_failed']);
  failing = false;
  await h.JE.saveUserSettings('settings.json', { a: 3 }, { notifyOnError: true });
  assert.deepEqual(toasts, ['toast_settings_save_failed'], 'a successful save shows nothing');
  h.JE.userConfig.settingsStatus = 'unavailable';
  await h.JE.saveUserSettings('settings.json', { a: 4 }, { notifyOnError: true });
  assert.deepEqual(toasts, ['toast_settings_save_failed'], 'a refusal while settings are unavailable is the panel\'s notice, not a toast');
});

// The panel host (ui-panel.js) runs unchanged; the template is a stub with three panes.
const panelHtml = `<style>.je-pane { display: none; } .je-pane.active { display: block; }</style><div class="panel-header"></div><div class="je-panel-body">
  <div class="je-panel-nav"><div class="je-panel-nav-items"></div></div>
  <div class="je-panel-main"><button id="jePanelBack" class="je-pane-back" type="button"></button>
    <section class="je-pane" data-pane="shortcuts"><h3 class="je-pane-title">Shortcuts</h3></section>
    <section class="je-pane" data-pane="playback"><h3 class="je-pane-title">Playback</h3><input type="checkbox" id="autoPauseToggle"></section>
    <section class="je-pane" data-pane="language"><h3 class="je-pane-title">Language</h3></section>
  </div></div><button id="closeSettingsPanel" type="button"></button>`;

function setupPanel(t, { stored = {}, userId = 'user-a', storage = {} } = {}) {
  const posts = [];
  const h = createHarness({
    globals: { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) },
    JE: { pluginConfig: {}, userConfig: { settings: {}, shortcuts: { Shortcuts: [] }, settingsStatus: 'ok' }, currentSettings: {},
      state: { activeShortcuts: { OpenSearch: '/' } }, t: key => key, keyListener() {},
      toCamelCase: value => Object.fromEntries(Object.entries(value).map(([k, v]) => [k[0].toLowerCase() + k.slice(1), v])),
      themer: { getThemeVariables: () => ({}) } },
    apiClient: { getCurrentUserId: () => userId, ajax: async request => {
      if (request.type === 'POST') { posts.push(new URL(request.url).pathname); return {}; }
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
  return { ...h, posts, panel, activePane, nav };
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
