import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from '../helpers/harness.mjs';

// The panel host (ui-panel.js) and config.js run unchanged; the template and the section wiring
// are stubbed with two panes: playback (all rows write settings.json) and language, laid out like
// the template, where only the display-language row writes settings.json.
const panelHtml = `<div class="panel-header"></div><div class="je-panel-body">
  <div class="je-panel-nav"><div class="je-panel-nav-items"></div></div>
  <div class="je-panel-main"><button id="jePanelBack" class="je-pane-back" type="button"></button>
    <section class="je-pane" data-pane="playback"><h3 class="je-pane-title">Playback</h3><div class="rows"><input type="checkbox" id="autoPauseToggle"></div></section>
    <section class="je-pane" data-pane="language"><h3 class="je-pane-title">Language</h3><div class="rows">
      <div class="language-row"><select id="displayLanguageSelect"></select></div>
      <div class="cache-row"><button id="clearTranslationCacheButton" type="button"></button></div></div></section>
    <section class="je-pane" data-pane="hidden-content"><h3 class="je-pane-title">Hidden</h3><div class="rows"><input type="checkbox" id="hiddenFilterNextUp"></div></section>
  </div></div><button id="closeSettingsPanel" type="button"></button>`;

function setup(t, { settingsStatus, respond }) {
  const gets = [], posts = [];
  const h = createHarness({
    globals: { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) },
    JE: { pluginConfig: {}, userConfig: { settings: {}, shortcuts: { Shortcuts: [] }, settingsStatus }, currentSettings: {},
      state: { activeShortcuts: { OpenSearch: '/' } }, t: key => key, keyListener() {},
      toCamelCase: value => Object.fromEntries(Object.entries(value).map(([k, v]) => [k[0].toLowerCase() + k.slice(1), v])),
      themer: { getThemeVariables: () => ({}) } },
    apiClient: { ajax: async request => {
      if (request.type === 'POST') { posts.push(new URL(request.url).pathname); return {}; }
      gets.push(new URL(request.url).pathname);
      return respond();
    } }
  });
  t.after(() => h.close());
  h.load('enhanced/config.js');
  h.JE.currentSettings = h.JE.loadSettings();
  h.JE.internals = { enhancedUi: { buildPanelHtml: () => panelHtml, wireShortcutEditor() {}, wireSettingsListeners() {},
    wireHiddenContentListeners() {}, wireMiscSettingsControls() {}, wireLanguageControls() {} } };
  h.load('enhanced/settingspanel/ui-panel.js');
  const panel = () => h.document.getElementById('jellyfin-enhanced-panel');
  const pane = name => panel().querySelector(`.je-pane[data-pane="${name}"]`);
  return { ...h, gets, posts, panel, pane };
}

test('a panel opened while settings cannot load is read-only with Retry, saves nothing, and Retry restores it', async t => {
  let available = false;
  const h = setup(t, { settingsStatus: 'unavailable', respond: () => {
    if (!available) throw new Error('503 Service Unavailable');
    return { AutoPauseEnabled: false };
  } });

  await h.JE.showEnhancedPanel();
  const playback = h.pane('playback');
  const notice = playback.querySelector('.je-settings-unavailable');
  assert.ok(notice, 'the settings pane explains why it is read-only');
  assert.equal(notice.getAttribute('role'), 'status');
  assert.ok(notice.textContent.includes('panel_settings_unavailable'));
  assert.equal(playback.querySelector('.rows').hasAttribute('inert'), true);
  assert.equal(playback.querySelector('.je-pane-title').hasAttribute('inert'), false);
  // The display language is stored in settings.json; the translation cache is local only.
  const language = h.pane('language');
  assert.ok(language.querySelector('.je-settings-unavailable'), 'the language pane explains why its selector is read-only');
  assert.equal(language.querySelector('.language-row').hasAttribute('inert'), true);
  assert.equal(language.querySelector('.cache-row').hasAttribute('inert'), false);
  assert.equal(language.querySelector('.rows').hasAttribute('inert'), false);
  assert.equal(h.pane('hidden-content').querySelector('.je-settings-unavailable'), null, 'panes that do not write settings.json stay usable');
  assert.equal(h.pane('hidden-content').querySelector('.rows').hasAttribute('inert'), false);

  // Switching sections persists lastOpenedTab through settings.json, which must not be written.
  h.panel().querySelector('.je-panel-nav-items .tab-button[data-tab="language"]').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.posts, []);

  available = true;
  notice.querySelector('button').click();
  const deadline = performance.now() + 3000;
  while (performance.now() < deadline && !(h.panel() && h.JE.userConfig.settingsStatus === 'ok')) await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal(h.document.querySelectorAll('#jellyfin-enhanced-panel').length, 1, 'Retry replaces the panel');
  assert.equal(h.JE.userConfig.settingsStatus, 'ok');
  assert.equal(h.JE.currentSettings.autoPauseEnabled, false, 'the stored values replace the fallback defaults');
  assert.equal(h.panel().querySelector('.je-settings-unavailable'), null);
  assert.equal(h.pane('playback').querySelector('.rows').hasAttribute('inert'), false);
  assert.equal(h.pane('language').querySelector('.language-row').hasAttribute('inert'), false);
  assert.equal(h.gets.length, 2);

  await h.JE.saveUserSettings('settings.json', h.JE.currentSettings, { throwOnError: true });
  assert.deepEqual(h.posts, ['/JellyfinEnhanced/user-settings/user-a/settings.json']);
});

test('a refresh failure on open keeps a panel whose settings did load editable', async t => {
  const h = setup(t, { settingsStatus: 'ok', respond: () => { throw new Error('offline'); } });
  await h.JE.showEnhancedPanel();
  assert.ok(h.panel());
  assert.equal(h.panel().querySelector('.je-settings-unavailable'), null);
  assert.equal(h.pane('playback').querySelector('.rows').hasAttribute('inert'), false);
  await h.JE.saveUserSettings('settings.json', h.JE.currentSettings, { throwOnError: true });
  assert.equal(h.posts.length, 1);
});

// ApiClient.ajax rejects with the fetch Response, so the panel can read the server's reason.
const unavailable = () => { throw new Response(JSON.stringify({ success: false, status: 'unavailable', message: 'x' }), { status: 503 }); };

test('settings that loaded at boot but are unreadable now make the panel read-only', async t => {
  const h = setup(t, { settingsStatus: 'ok', respond: unavailable });
  await h.JE.showEnhancedPanel();
  assert.equal(h.JE.userConfig.settingsStatus, 'unavailable');
  assert.ok(h.pane('playback').querySelector('.je-settings-unavailable'));
  assert.equal(h.pane('playback').querySelector('.rows').hasAttribute('inert'), true);
  await assert.rejects(h.JE.saveUserSettings('settings.json', h.JE.currentSettings, { throwOnError: true }), /could not be loaded/);
  assert.deepEqual(h.posts, []);
});

test('a 503 that does not report the document unavailable keeps the panel editable', async t => {
  const h = setup(t, { settingsStatus: 'ok', respond: () => { throw new Response('Service Unavailable', { status: 503 }); } });
  await h.JE.showEnhancedPanel();
  assert.equal(h.JE.userConfig.settingsStatus, 'ok');
  assert.equal(h.pane('playback').querySelector('.je-settings-unavailable'), null);
});

test('a panel opened while a switched-to user\'s settings are still loading is read-only if its refresh fails', async t => {
  const h = setup(t, { settingsStatus: 'loading', respond: () => { throw new Error('offline'); } });
  await h.JE.showEnhancedPanel();
  assert.ok(h.pane('playback').querySelector('.je-settings-unavailable'));
  assert.equal(h.pane('playback').querySelector('.rows').hasAttribute('inert'), true);
  assert.deepEqual(h.posts, []);
});

// The real display-language handler (ui-panel-language.js) over config.js's save guard.
function setupLanguage(t, { settingsStatus, failPost = false }) {
  const posts = [], toasts = [];
  const h = createHarness({
    html: '<select id="displayLanguageSelect"><option value="">Auto</option></select><button id="clearTranslationCacheButton"></button>',
    fetch: async () => new Response('[]', { status: 503 }),
    JE: { pluginConfig: {}, userConfig: { settings: {}, settingsStatus }, t: key => key, toast: message => toasts.push(message) },
    apiClient: { ajax: async request => {
      if (request.type === 'POST') {
        posts.push(new URL(request.url).pathname);
        if (failPost) throw new Error('offline');
        return {};
      }
      const path = new URL(request.url).pathname;
      if (path === '/JellyfinEnhanced/locales') return ['de', 'fr'];
      if (path === '/Localization/Cultures') return [{ TwoLetterISOLanguageName: 'de', DisplayName: 'German' }, { TwoLetterISOLanguageName: 'fr', DisplayName: 'French' }];
      throw new Error(`unexpected GET ${path}`);
    } }
  });
  // The success path reloads the page after 1.5 s; record it instead.
  const reloads = [];
  h.window.setTimeout = (fn, ms) => { if (ms === 1500) reloads.push(ms); else setTimeout(fn, ms); };
  t.after(() => h.close());
  h.load('enhanced/config.js');
  h.JE.currentSettings = h.JE.loadSettings();
  h.JE.internals = { enhancedUi: {} };
  h.load('enhanced/settingspanel/ui-panel-language.js');
  h.JE.internals.enhancedUi.wireLanguageControls({ resetAutoCloseTimer() {} });
  const select = h.document.getElementById('displayLanguageSelect');
  const change = async value => {
    while (select.options.length < 3) await new Promise(resolve => setTimeout(resolve, 1));
    select.value = value;
    select.dispatchEvent(new h.window.Event('change'));
    for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
  };
  return { ...h, posts, toasts, reloads, select, change };
}

for (const settingsStatus of ['unavailable', 'loading']) {
  test(`a display-language change while settings are ${settingsStatus} saves nothing and reports no success`, async t => {
    const h = setupLanguage(t, { settingsStatus });
    await h.change('de');
    assert.deepEqual(h.posts, []);
    assert.equal(h.window.localStorage.getItem('user-a-language'), null);
    assert.deepEqual(h.toasts, ['panel_settings_unavailable']);
    assert.deepEqual(h.reloads, []);
    assert.equal(h.select.value, '', 'the selector goes back to the language in use');
    assert.equal(h.JE.currentSettings.displayLanguage, '');
  });
}

test('a display-language change with settings loaded saves, switches and reloads', async t => {
  const h = setupLanguage(t, { settingsStatus: 'ok' });
  await h.change('de');
  assert.deepEqual(h.posts, ['/JellyfinEnhanced/user-settings/user-a/settings.json']);
  assert.equal(h.window.localStorage.getItem('user-a-language'), 'de');
  assert.deepEqual(h.toasts, ['toast_language_changed']);
  assert.deepEqual(h.reloads, [1500]);
});

test('a display-language change whose POST fails still switches locally, as before', async t => {
  const h = setupLanguage(t, { settingsStatus: 'ok', failPost: true });
  h.expectConsoleError('Failed to save settings.json');
  await h.change('fr');
  assert.equal(h.posts.length, 1);
  assert.equal(h.window.localStorage.getItem('user-a-language'), 'fr');
  assert.deepEqual(h.toasts, ['toast_language_changed']);
});
