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
function panel(tt, { config = {}, settings = {}, answer = () => [] } = {}) {
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
    apiClient: { ajax: async request => { if (request.type === 'POST' || request.type === 'PATCH') writes.push(request); return answer(request); } }
  });
  tt.after(() => h.close());
  h.load('enhanced/translations.js');
  h.load('enhanced/config.js');
  // A language change schedules a page reload after 1.5 s of real time; none of these tests is about it (and a reload
  // firing under load would end the page mid-test).
  h.JE.internals.scheduleReloadWhenIdle = () => {};
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

// (From English, so each save is a change of JE's language: JE writes the shared key only then, stage 1 fix round 3.)
test('a stored language that is no language tag is mirrored to the browser as Auto, never as the junk value', async t => {
  const h = panel(t, { config: {}, settings: { displayLanguage: 'en-GB' } });
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
for (const [stored, expected] of [['zz-ZZ', ''], ['xx', ''], ['en_US!', ''], ['null', ''], ['', ''], ['en-AU', 'en-AU'], ['pr', 'pr'],
  ['haw-AU', ''], ['kok-GB', ''], ['ja', '']]) test(`a stored language ${JSON.stringify(stored)} is mirrored as ${JSON.stringify(expected)}`, async t => {
  const h = panel(t, { config: {}, settings: { displayLanguage: 'en-GB' } });
  h.window.localStorage.setItem('user-a-language', 'de');
  await h.JE.updateSettings({ displayLanguage: stored });
  await new Promise(done => setImmediate(done));
  assert.equal(h.window.localStorage.getItem('user-a-language'), expected);
});

// Stage 1 fix round 3 (RBS1-R3-2): the client mirrors only what the server stored. A save answers the display language it
// stored; the store takes that as the persisted value, so Jellyfin's shared key, JE's settings and the panel's select show
// it, whatever was sent (haw-AU was stored as Auto while the client kept and mirrored haw-AU until a reload). A server
// whose answer carries no display language (older) leaves the client's own gated value.
for (const [sent, stored] of [['haw-AU', ''], ['kok-GB', ''], ['fr', ''], ['pt-br', 'pt-BR'], ['en-AU', 'en-AU']]) test(`a saved ${sent} is mirrored as the server stored it (${JSON.stringify(stored)})`, async t => {
  const h = panel(t, { settings: { displayLanguage: 'en-GB' }, answer: request => request.type === 'POST' ? { success: true, file: 'settings.json', consents: {}, displayLanguage: stored } : [] });
  const select = h.document.getElementById('displayLanguageSelect');
  for (const code of ['', 'haw-AU', 'kok-GB', 'fr', 'pt-br', 'pt-BR', 'en-AU']) select.appendChild(Object.assign(h.document.createElement('option'), { value: code, textContent: code || 'Auto' }));
  h.window.localStorage.setItem('user-a-language', 'de');
  await h.JE.updateSettings({ displayLanguage: sent });
  await new Promise(done => setImmediate(done));
  assert.equal(h.window.localStorage.getItem('user-a-language'), stored);
  assert.equal(h.JE.currentSettings.displayLanguage, stored);
  assert.equal(h.JE.userConfig.settings.displayLanguage, stored);
  assert.equal(select.value, stored);
});

test('the consent operation\'s answer also sets the persisted display language', async t => {
  // The server stores Auto (an older file's language, gated), while this page still had French.
  const h = panel(t, { settings: { displayLanguage: 'fr' }, answer: request => request.type === 'PATCH' ? { success: true, consents: { ListSwapIn: true }, displayLanguage: '' } : [] });
  h.window.localStorage.setItem('user-a-language', 'de');
  await h.JE.setPersonalConsent('listSwapIn', true);
  await new Promise(done => setImmediate(done));
  assert.equal(h.JE.currentSettings.displayLanguage, '');
  assert.equal(h.window.localStorage.getItem('user-a-language'), '');
});
