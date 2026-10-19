// Phase 4 integration (4c3a list pages + 4e settings store + the upstream language fix): the list-page preferences and the
// display language go through 4e's settings document like every other panel setting, keeping each track's behaviour.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHarness, jsRoot } from '../helpers/harness.mjs';

const en = JSON.parse(readFileSync(resolve(jsRoot, 'locales/en.json'), 'utf8'));
const tr = key => (key in en ? en[key] : key);
const preset = { name: 'p', previewText: 'Aa', size: 1, family: 'sans-serif', bgColor: '#000', textColor: '#fff' };
const escapeHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** The real panel template, settings listeners and settings store, with the panel's helpers stubbed. */
function panel(tt, { config = {}, settings = {} } = {}) {
  const writes = [], toasts = [], listPages = [];
  const h = createHarness({
    JE: {
      pluginConfig: { Shortcuts: [], ...config }, userConfig: { settings: { ...settings }, shortcuts: { Shortcuts: [] } }, currentSettings: {},
      t: tr, toast: message => toasts.push(message), escapeHtml, icon: () => '', IconName: new Proxy({}, { get: (_, k) => String(k) }),
      icons: { wrapEmoji: s => s }, state: { activeShortcuts: {} }, pluginVersion: '0.0.0',
      fontSizePresets: [preset, preset, preset, preset], fontFamilyPresets: [preset], subtitlePresets: [preset], subtitleTextEffectPresets: [preset],
      decodeSubtitleColor: () => ({ swatch: '#FFFFFF', alpha: 255, alphaValue: 255 }), getSubtitleTextShadow: () => 'none',
      arrListPages: { settingsChanged: () => listPages.push({ ...h.JE.currentSettings }) }
    },
    apiClient: { ajax: async request => { if (request.type === 'POST' || request.type === 'PATCH') writes.push(request); return []; } }
  });
  tt.after(() => h.close());
  h.load('enhanced/translations.js');
  h.load('enhanced/config.js');
  h.JE.currentSettings = h.JE.loadSettings();
  h.load('enhanced/settingspanel/ui-panel-template.js');
  h.load('enhanced/settingspanel/ui-panel-settings.js');
  h.document.body.innerHTML = h.JE.internals.enhancedUi.buildPanelHtml({ presetBoxBackground: '#111', detailsBackground: '#222', toggleAccentColor: '#333' });
  h.JE.internals.enhancedUi.wireSettingsListeners({ createToast: (key, enabled) => `${key}:${enabled}`, resetAutoCloseTimer() {} });
  return { ...h, writes, toasts, listPages,
    async choose(id, value) {
      const select = h.document.getElementById(id);
      select.value = value;
      select.dispatchEvent(new h.window.Event('change', { bubbles: true }));
      await new Promise(done => setImmediate(done));
      await new Promise(done => setImmediate(done));
    } };
}

const listPages = { ArrListsEnabled: true, ArrListPlaylistUiEnabled: true, ArrListCollectionUiEnabled: true };

test('a list-page preference is saved through the settings document and the list pages follow it at once', async t => {
  const h = panel(t, { config: listPages });
  await h.choose('listPlaylistUiSelect', 'off');
  const saved = JSON.parse(h.writes.at(-1).data);
  assert.equal(saved.listPlaylistUi, false);
  assert.equal(h.JE.currentSettings.listPlaylistUi, false);
  assert.ok(h.listPages.length >= 1, 'the list pages were told');
  assert.equal(h.listPages.at(-1).listPlaylistUi, false, 'they read the new value');
  assert.deepEqual(h.toasts, [tr('toast_list_settings_saved')]);
  await h.choose('listCollectionUiSelect', 'off');
  assert.equal(JSON.parse(h.writes.at(-1).data).listCollectionUi, false);
  assert.equal(h.listPages.at(-1).listCollectionUi, false);
});

test('the list-page selects show the settings document, also when it changes elsewhere', async t => {
  const h = panel(t, { config: listPages, settings: { listCollectionUi: false } });
  assert.equal(h.document.getElementById('listCollectionUiSelect').value, 'off');
  assert.equal(h.document.getElementById('listPlaylistUiSelect').value, '');
  await h.JE.updateSettings({ listPlaylistUi: false });
  await new Promise(done => setImmediate(done));
  assert.equal(h.document.getElementById('listPlaylistUiSelect').value, 'off');
});

test('a stored language that is no language tag is mirrored to the browser as Auto, never as the junk value', async t => {
  const h = panel(t, { config: {} });
  h.window.localStorage.setItem('user-a-language', 'de');
  await h.JE.updateSettings({ displayLanguage: 'undefined' });
  await new Promise(done => setImmediate(done));
  assert.notEqual(h.window.localStorage.getItem('user-a-language'), 'undefined');
  assert.equal(h.window.localStorage.getItem('user-a-language'), '');
  await h.JE.updateSettings({ displayLanguage: 'en-gb' });
  await new Promise(done => setImmediate(done));
  assert.equal(h.window.localStorage.getItem('user-a-language'), 'en-GB');
});

// Dashcrash §7 (integration rebuild): the store's mirror writes a supported language or Auto, never an unsupported or
// malformed one (the panel's own choice: bootstrap-settings-badges).
for (const [stored, expected] of [['zz-ZZ', ''], ['xx', ''], ['en_US!', ''], ['null', ''], ['', ''], ['en-AU', 'en-AU'], ['pr', 'pr']]) test(`a stored language ${JSON.stringify(stored)} is mirrored as ${JSON.stringify(expected)}`, async t => {
  const h = panel(t, { config: { SupportedLanguages: ['en', 'pr'] } });
  h.window.localStorage.setItem('user-a-language', 'de');
  await h.JE.updateSettings({ displayLanguage: stored });
  await new Promise(done => setImmediate(done));
  assert.equal(h.window.localStorage.getItem('user-a-language'), expected);
});
