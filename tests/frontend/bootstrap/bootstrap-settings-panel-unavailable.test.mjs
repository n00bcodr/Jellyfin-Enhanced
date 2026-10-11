import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from '../helpers/harness.mjs';

// The panel host (ui-panel.js) and config.js run unchanged; the template and the section wiring
// are stubbed with two panes: one that writes settings.json and one (language) that does not.
const panelHtml = `<div class="panel-header"></div><div class="je-panel-body">
  <div class="je-panel-nav"><div class="je-panel-nav-items"></div></div>
  <div class="je-panel-main"><button id="jePanelBack" class="je-pane-back" type="button"></button>
    <section class="je-pane" data-pane="playback"><h3 class="je-pane-title">Playback</h3><div class="rows"><input type="checkbox" id="autoPauseToggle"></div></section>
    <section class="je-pane" data-pane="language"><h3 class="je-pane-title">Language</h3><div class="rows"><select id="displayLanguageSelect"></select></div></section>
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
  assert.equal(h.pane('language').querySelector('.je-settings-unavailable'), null, 'panes that do not write settings.json stay usable');
  assert.equal(h.pane('language').querySelector('.rows').hasAttribute('inert'), false);

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
