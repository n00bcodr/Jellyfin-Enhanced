// Phase 4e (D29): each person's acquisition-badge preferences in the JE settings panel. Both are display preferences:
// unset/null follows the household, "Hide" is false. The box only exists while acquisition badges are on; the native
// select only while the native stamps are on too; untouched choices are never written; the web choice reaches the
// poster cards without a reload.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHarness, deferred, jsRoot } from '../helpers/harness.mjs';

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
    // Settings saves are POSTs; the panel also reads the server's cultures (answered empty).
    apiClient: { ajax: async request => { if (request.type === 'POST') writes.push(request); return []; } }
  });
  tt.after(() => h.close());
  h.load('enhanced/config.js');
  h.JE.currentSettings = h.JE.loadSettings();
  h.load('enhanced/settingspanel/ui-panel-template.js');
  h.load('enhanced/settingspanel/ui-panel-settings.js');
  h.document.body.innerHTML = h.JE.internals.enhancedUi.buildPanelHtml({ presetBoxBackground: '#111', detailsBackground: '#222', toggleAccentColor: '#333' });
  const resets = [];
  h.JE.internals.arrStatusCards = { reset: () => resets.push(h.JE.currentSettings.acquisitionBadges) };
  return { ...h, writes, toasts, resets,
    wire() { h.JE.internals.enhancedUi.wireSettingsListeners({ createToast: (key, enabled) => `${key}:${enabled}`, resetAutoCloseTimer() {} }); },
    async choose(id, value) {
      const select = h.document.getElementById(id);
      select.value = value;
      select.dispatchEvent(new h.window.Event('change', { bubbles: true }));
      await new Promise(done => setImmediate(done));
    } };
}

const badges = { ArrAcquisitionBadgesEnabled: true, ArrNativeStampsEnabled: true };

for (const config of [{}, { ArrAcquisitionBadgesEnabled: false }, { ArrAcquisitionBadgesEnabled: 'true' }, { ArrNativeStampsEnabled: true }]) test(`the Poster badges box is absent while acquisition badges are off (${JSON.stringify(config)})`, t => {
  const h = panel(t, { config });
  for (const id of ['acquisitionBadgesSelect', 'nativeAcquisitionStampsSelect']) assert.equal(h.document.getElementById(id), null);
  assert.ok(!h.document.body.textContent.includes(tr('panel_settings_badges_desc')));
});

test('with badges on, the box shows the web choice; the native-app choice only with native stamps on', t => {
  const only = panel(t, { config: { ArrAcquisitionBadgesEnabled: true } });
  assert.ok(only.document.getElementById('acquisitionBadgesSelect'));
  assert.equal(only.document.getElementById('nativeAcquisitionStampsSelect'), null);

  const h = panel(t, { config: badges, settings: { nativeAcquisitionStamps: false } });
  const pane = h.document.querySelector('section[data-pane="ui"]');
  const web = pane.querySelector('#acquisitionBadgesSelect');
  const native = pane.querySelector('#nativeAcquisitionStampsSelect');
  assert.ok(web && native);
  for (const select of [web, native]) {
    assert.deepEqual([...select.options].map(o => [o.value, o.textContent]), [['', tr('panel_settings_badges_follow')], ['off', tr('panel_settings_badges_hide')]]);
  }
  assert.equal(web.value, '');
  assert.equal(native.value, 'off');
  assert.equal(pane.querySelector('label[for="acquisitionBadgesSelect"]').textContent, tr('panel_settings_badges_web'));
  assert.equal(pane.querySelector('label[for="nativeAcquisitionStampsSelect"]').textContent, tr('panel_settings_badges_native'));
  assert.ok(pane.textContent.includes(tr('panel_settings_badges')));
  assert.ok(pane.textContent.includes(tr('panel_settings_badges_desc')));
});

test('choosing saves Hide as false and the household as null; untouched choices stay unwritten; the cards follow', async t => {
  const h = panel(t, { config: badges });
  h.wire();
  await h.choose('acquisitionBadgesSelect', 'off');
  let saved = JSON.parse(h.writes.at(-1).data);
  assert.equal(saved.acquisitionBadges, false);
  assert.ok(!('nativeAcquisitionStamps' in saved));
  assert.equal(h.JE.userConfig.settings.acquisitionBadges, false);
  assert.deepEqual(h.toasts, [tr('toast_badge_settings_saved')]);
  assert.deepEqual(h.resets, [false], 'the poster cards are reset with the new choice in place');
  await h.choose('nativeAcquisitionStampsSelect', 'off');
  saved = JSON.parse(h.writes.at(-1).data);
  assert.equal(saved.nativeAcquisitionStamps, false);
  assert.equal(h.resets.length, 1, 'the native choice does not touch the web cards');
  await h.choose('acquisitionBadgesSelect', '');
  assert.equal(JSON.parse(h.writes.at(-1).data).acquisitionBadges, null);
  assert.deepEqual(h.resets, [false, null]);
  await h.choose('nativeAcquisitionStampsSelect', '');
  assert.equal(JSON.parse(h.writes.at(-1).data).nativeAcquisitionStamps, null);
  assert.equal(h.writes.length, 4);
});

test('a select left on the page after badges were turned off saves nothing', async t => {
  const h = panel(t, { config: badges });
  h.wire();
  h.JE.pluginConfig.ArrAcquisitionBadgesEnabled = false;
  await h.choose('acquisitionBadgesSelect', 'off');
  assert.equal(h.writes.length, 0);
  assert.equal(h.resets.length, 0);
});

test('translated badge labels are escaped', t => {
  const h = panel(t, { config: badges, translate: key => (key.startsWith('panel_settings_badges') ? '<img src=x onerror=alert(1)>' : tr(key)) });
  assert.equal(h.document.querySelectorAll('img[src="x"]').length, 0);
  assert.equal(h.document.getElementById('nativeAcquisitionStampsSelect').options[1].textContent, '<img src=x onerror=alert(1)>');
});


for (const outcome of ['saved', 'failed', 'hidden', 'switched']) test(`show badges waits for persistence and ignores obsolete completion: ${outcome}`, async t => {
  const h = panel(t, { config: badges, settings: { acquisitionBadges: false } });
  const held = deferred();
  let epoch = 1;
  h.JE.session = { getEpoch: () => epoch, isCurrent: captured => captured === epoch };
  h.window.ApiClient.ajax = () => held.promise;
  h.wire();
  await h.choose('acquisitionBadgesSelect', '');
  assert.deepEqual(h.resets, [], 'no card refresh while the server still has Hide');
  assert.deepEqual(h.toasts, [], 'no saved toast before persistence');
  if (outcome === 'hidden') {
    await h.choose('acquisitionBadgesSelect', 'off');
    assert.deepEqual(h.resets, [false], 'Hide removes badges immediately, even with a pending save');
  }
  if (outcome === 'switched') epoch++;
  if (outcome === 'failed') held.reject(new Error('save failed'));
  else held.resolve();
  await new Promise(done => setImmediate(done));
  assert.deepEqual(h.resets, outcome === 'saved' ? [null] : outcome === 'hidden' || outcome === 'failed' ? [false] : []);
  if (outcome === 'failed') assert.deepEqual(h.toasts, [], 'failed persistence never claims success');
});

test('rewiring the panel while Show is pending still refreshes cards after the document saves', async t => {
  const h = panel(t, { config: badges, settings: { acquisitionBadges: false } });
  const held = deferred();
  h.window.ApiClient.ajax = () => held.promise;
  h.wire();
  await h.choose('acquisitionBadgesSelect', '');
  h.wire(); // a replacement panel observes the same in-flight document
  held.resolve();
  await new Promise(done => setImmediate(done));
  assert.deepEqual(h.resets, [null]);
});
