// Phase 4a (D29): each person's automatic-request preferences in the JE settings panel. Tri-state:
// unset/null follows the household (the administrator's choice), On / Off are explicit. The box only
// exists while the server's automation engine is on; an untouched choice is never written. They are
// consents: only the consent operation (PATCH user-settings/{id}/consent) saves them, one field at a
// time, and a whole settings save never changes them (Q-REBUILD1-1 (b), integration rebuild).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHarness, jsRoot } from '../helpers/harness.mjs';

const en = JSON.parse(readFileSync(resolve(jsRoot, 'locales/en.json'), 'utf8'));
const tr = key => (key in en ? en[key] : key);
const preset = { name: 'p', previewText: 'Aa', size: 1, family: 'sans-serif', bgColor: '#000', textColor: '#fff' };
const escapeHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** The real panel template (and, when wired, the real settings listeners) with the panel's helpers stubbed. */
function panel(tt, { config = {}, settings = {}, translate = tr } = {}) {
  const writes = [], toasts = [];
  const h = createHarness({
    JE: {
      pluginConfig: { Shortcuts: [], ...config }, userConfig: { settings: { ...settings }, shortcuts: { Shortcuts: [] } }, currentSettings: {},
      t: translate, toast: message => toasts.push(message), escapeHtml, icon: () => '', IconName: new Proxy({}, { get: (_, k) => String(k) }),
      icons: { wrapEmoji: s => s }, state: { activeShortcuts: {} }, pluginVersion: '0.0.0',
      fontSizePresets: [preset, preset, preset, preset], fontFamilyPresets: [preset], subtitlePresets: [preset], subtitleTextEffectPresets: [preset],
      decodeSubtitleColor: () => ({ swatch: '#FFFFFF', alpha: 255, alphaValue: 255 }), getSubtitleTextShadow: () => 'none'
    },
    // Settings saves are POSTs, consent choices PATCHes; the panel also reads the server's cultures (answered empty).
    apiClient: { ajax: async request => { if (request.type === 'POST' || request.type === 'PATCH') writes.push(request); return []; } }
  });
  tt.after(() => h.close());
  h.load('core/mutation-queue.js'); h.load('enhanced/config.js');
  h.JE.currentSettings = h.JE.loadSettings();
  h.load('enhanced/settingspanel/ui-panel-template.js');
  h.load('enhanced/settingspanel/ui-panel-settings.js');
  h.document.body.innerHTML = h.JE.internals.enhancedUi.buildPanelHtml({ presetBoxBackground: '#111', detailsBackground: '#222', toggleAccentColor: '#333' });
  return { ...h, writes, toasts,
    wire() { h.JE.internals.enhancedUi.wireSettingsListeners({ createToast: (key, enabled) => `${key}:${enabled}`, resetAutoCloseTimer() {} }); },
    async choose(id, value) {
      const select = h.document.getElementById(id);
      select.value = value;
      select.dispatchEvent(new h.window.Event('change', { bubbles: true }));
      await new Promise(done => setImmediate(done));
    } };
}

const ids = ['autoSeasonRequestsSelect', 'autoMovieRequestsSelect'];

for (const value of [undefined, false, 'yes']) test(`the automatic-request box is absent unless the automation engine is on (ArrAutomationEngineEnabled=${value})`, t => {
  const h = panel(t, { config: value === undefined ? {} : { ArrAutomationEngineEnabled: value } });
  for (const id of ids) assert.equal(h.document.getElementById(id), null);
  assert.ok(h.document.getElementById('removeContinueWatchingToggle'));
  assert.ok(!h.document.body.textContent.includes('Automatic requests'));
});

test('with the engine on, the box sits in the UI pane after Remove from Continue Watching and selects each stored choice', t => {
  const h = panel(t, { config: { ArrAutomationEngineEnabled: true }, settings: { autoSeasonRequests: true, autoMovieRequests: false } });
  const pane = h.document.querySelector('section[data-pane="ui"]');
  const season = pane.querySelector('#autoSeasonRequestsSelect');
  const movie = pane.querySelector('#autoMovieRequestsSelect');
  assert.ok(season && movie);
  const box = season.closest('div');
  assert.ok(h.document.getElementById('removeContinueWatchingToggle').compareDocumentPosition(box) & h.window.Node.DOCUMENT_POSITION_FOLLOWING);
  assert.match(box.textContent, /Automatic requests/);
  assert.match(box.textContent, /"Household setting" follows what your administrator chose\./);
  assert.equal(pane.querySelector('label[for="autoSeasonRequestsSelect"]').textContent, 'Next season of a show you\'re watching');
  assert.equal(pane.querySelector('label[for="autoMovieRequestsSelect"]').textContent, 'Next movie in a collection you\'re watching');
  assert.deepEqual([...season.options].map(o => [o.value, o.textContent]), [['', 'Household setting'], ['on', 'On'], ['off', 'Off']]);
  assert.equal(season.value, 'on');
  assert.equal(movie.value, 'off');
});

for (const stored of [{}, { autoSeasonRequests: null, autoMovieRequests: null }]) test(`an unset or null choice shows Household setting (${JSON.stringify(stored)})`, t => {
  const h = panel(t, { config: { ArrAutomationEngineEnabled: true }, settings: stored });
  for (const id of ids) assert.equal(h.document.getElementById(id).value, '');
  // Loading the settings never invents a value for them.
  assert.equal(h.JE.currentSettings.autoSeasonRequests ?? null, null);
  assert.equal(h.JE.currentSettings.autoMovieRequests ?? null, null);
});

test('translated labels are escaped', t => {
  const h = panel(t, { config: { ArrAutomationEngineEnabled: true }, translate: key => (key.startsWith('panel_settings_ui_auto_requests') ? '<img src=x onerror=alert(1)>' : tr(key)) });
  assert.equal(h.document.querySelectorAll('img[src="x"]').length, 0);
  assert.equal(h.document.getElementById('autoSeasonRequestsSelect').options[0].textContent, '<img src=x onerror=alert(1)>');
});

test('choosing saves On / Off / Household setting as true / false / null through the consent operation, one field at a time', async t => {
  const h = panel(t, { config: { ArrAutomationEngineEnabled: true } });
  h.wire();
  await h.choose('autoSeasonRequestsSelect', 'on');
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0].type, 'PATCH');
  assert.ok(h.writes[0].url.endsWith('/user-a/consent'));
  assert.deepEqual(JSON.parse(h.writes[0].data), { Field: 'AutoSeasonRequests', Value: true });
  assert.equal(h.JE.userConfig.settings.autoSeasonRequests, true);
  assert.equal(h.JE.currentSettings.autoSeasonRequests, true);
  assert.ok(!('autoMovieRequests' in h.JE.userConfig.settings), 'the untouched choice is not written');
  assert.deepEqual(h.toasts, ['Automatic request preference saved.']);

  await h.choose('autoMovieRequestsSelect', 'off');
  assert.deepEqual(JSON.parse(h.writes[1].data), { Field: 'AutoMovieRequests', Value: false });

  await h.choose('autoSeasonRequestsSelect', '');
  assert.deepEqual(JSON.parse(h.writes[2].data), { Field: 'AutoSeasonRequests', Value: null });
  assert.equal(h.JE.userConfig.settings.autoSeasonRequests, null);
  assert.equal(h.JE.userConfig.settings.autoMovieRequests, false);
  assert.equal(h.writes.length, 3);
  assert.ok(h.writes.every(w => w.type === 'PATCH'), 'no whole settings document carried a choice');
});

test('a whole settings save never carries consent intent, and a failed choice rolls back', async t => {
  const h = panel(t, { config: { ArrAutomationEngineEnabled: true }, settings: { autoSeasonRequests: false } });
  h.wire();
  // A stale whole document that still says On: the store keeps the stored Off in every view.
  await h.JE.saveUserSettings('settings.json', { ...h.JE.currentSettings, autoSeasonRequests: true });
  assert.equal(h.JE.userConfig.settings.autoSeasonRequests, false);
  assert.equal(h.document.getElementById('autoSeasonRequestsSelect').value, 'off');
  // The server refuses the choice: the panel goes back to what is stored.
  h.window.ApiClient.ajax = async request => { if (request.type === 'PATCH') { h.writes.push(request); throw new Error('refused'); } return []; };
  await h.choose('autoSeasonRequestsSelect', 'on');
  await new Promise(done => setImmediate(done));
  assert.equal(h.writes.at(-1).type, 'PATCH');
  assert.equal(h.JE.userConfig.settings.autoSeasonRequests, false);
  assert.equal(h.document.getElementById('autoSeasonRequestsSelect').value, 'off');
});

test('the store refuses an automatic-request consent that is not true, false or null, and null for list swap-in', async t => {
  const h = panel(t, { config: { ArrAutomationEngineEnabled: true } });
  await assert.rejects(h.JE.setPersonalConsent('autoMovieRequests', 'on'));
  await assert.rejects(h.JE.setPersonalConsent('autoMovieRequests', undefined));
  await assert.rejects(h.JE.setPersonalConsent('listSwapIn', null));
  await assert.rejects(h.JE.setPersonalConsent('listStatus', true));
  assert.equal(h.writes.length, 0);
});

test('an unrelated setting saved by someone who never chose keeps both choices unset', async t => {
  const h = panel(t, { config: { ArrAutomationEngineEnabled: true } });
  h.wire();
  h.document.getElementById('showFileSizesToggle').checked = true;
  h.document.getElementById('showFileSizesToggle').dispatchEvent(new h.window.Event('change', { bubbles: true }));
  await new Promise(done => setImmediate(done));
  const saved = JSON.parse(h.writes.at(-1).data).Set;
  assert.equal(saved.showFileSizes, true);
  assert.ok(!('autoSeasonRequests' in saved) && !('autoMovieRequests' in saved));
});

test('a select left on the page after the engine was turned off saves nothing', async t => {
  const h = panel(t, { config: { ArrAutomationEngineEnabled: true } });
  h.wire();
  h.JE.pluginConfig.ArrAutomationEngineEnabled = false;
  await h.choose('autoMovieRequestsSelect', 'on');
  assert.equal(h.writes.length, 0);
  assert.equal(h.JE.userConfig.settings.autoMovieRequests, undefined);
});
