// Phase 4d (D29): each person's home rows in the JE settings panel. Each row is tri-state: unset/null follows the
// administrator, "Hide" is false. The server strip select is for administrators only, with its switch on. The box
// only exists while the home rows are on; untouched choices are never written; a saved choice re-reads the home.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHarness, jsRoot } from '../helpers/harness.mjs';

const en = JSON.parse(readFileSync(resolve(jsRoot, 'locales/en.json'), 'utf8'));
const tr = key => (key in en ? en[key] : key);
const preset = { name: 'p', previewText: 'Aa', size: 1, family: 'sans-serif', bgColor: '#000', textColor: '#fff' };
const escapeHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const IDS = ['homeRowRequestsSelect', 'homeRowSoonSelect', 'homeRowArrivedSelect', 'homeOpsStripSelect'];

/** The real panel template (and, when wired, the real settings listeners) with the panel's helpers stubbed. */
function panel(tt, { config = {}, settings = {}, translate = tr } = {}) {
  const writes = [], toasts = [], refreshes = [];
  const h = createHarness({
    JE: {
      pluginConfig: { Shortcuts: [], ...config }, userConfig: { settings: { ...settings }, shortcuts: { Shortcuts: [] } }, currentSettings: {},
      t: translate, toast: message => toasts.push(message), escapeHtml, icon: () => '', IconName: new Proxy({}, { get: (_, k) => String(k) }),
      icons: { wrapEmoji: s => s }, state: { activeShortcuts: {} }, pluginVersion: '0.0.0',
      fontSizePresets: [preset, preset, preset, preset], fontFamilyPresets: [preset], subtitlePresets: [preset], subtitleTextEffectPresets: [preset],
      decodeSubtitleColor: () => ({ swatch: '#FFFFFF', alpha: 255, alphaValue: 255 }), getSubtitleTextShadow: () => 'none',
      arrHome: { refresh: options => { refreshes.push(options); return Promise.resolve(); } }
    },
    apiClient: { ajax: async request => { if (request.type === 'PATCH' && !request.url.endsWith('/consent')) writes.push(request); return []; } }
  });
  tt.after(() => h.close());
  h.load('core/mutation-queue.js'); h.load('enhanced/config.js');
  h.JE.currentSettings = h.JE.loadSettings();
  h.load('enhanced/settingspanel/ui-panel-template.js');
  h.load('enhanced/settingspanel/ui-panel-settings.js');
  h.document.body.innerHTML = h.JE.internals.enhancedUi.buildPanelHtml({ presetBoxBackground: '#111', detailsBackground: '#222', toggleAccentColor: '#333' });
  return { ...h, writes, toasts, refreshes,
    wire() { h.JE.internals.enhancedUi.wireSettingsListeners({ createToast: (key, enabled) => `${key}:${enabled}`, resetAutoCloseTimer() {} }); },
    async choose(id, value) {
      const select = h.document.getElementById(id);
      select.value = value;
      select.dispatchEvent(new h.window.Event('change', { bubbles: true }));
      for (let i = 0; i < 5; i++) await new Promise(done => setImmediate(done));
    } };
}

const home = { ArrHomeRowsEnabled: true, ArrHomeOpsStripEnabled: true };

for (const config of [{}, { ArrHomeRowsEnabled: false }, { ArrHomeOpsStripEnabled: true }]) test(`the Home rows box is absent while the rows are off (${JSON.stringify(config)})`, t => {
  const h = panel(t, { config, settings: { isAdmin: true } });
  for (const id of IDS) assert.equal(h.document.getElementById(id), null);
  assert.ok(!h.document.body.textContent.includes(tr('panel_settings_home_desc')));
  // The same panel with the rows switched on has the box.
  const on = panel(t, { config: { ...config, ArrHomeRowsEnabled: true }, settings: { isAdmin: true } });
  assert.ok(on.document.getElementById('homeRowRequestsSelect'));
});

test('with the rows on, every person gets the three row selects; the server strip only an administrator with its switch on', t => {
  const member = panel(t, { config: home, settings: { homeRowSoon: false } });
  const pane = member.document.querySelector('section[data-pane="ui"]');
  for (const id of IDS.slice(0, 3)) assert.ok(pane.querySelector(`#${id}`), id);
  assert.equal(member.document.getElementById('homeOpsStripSelect'), null, 'not for a non-administrator');
  const soon = member.document.getElementById('homeRowSoonSelect');
  assert.deepEqual([...soon.options].map(o => [o.value, o.textContent]), [['', tr('panel_settings_home_follow')], ['off', tr('panel_settings_home_hide')]]);
  assert.equal(soon.value, 'off');
  assert.equal(member.document.getElementById('homeRowRequestsSelect').value, '');
  assert.match(pane.textContent, new RegExp(tr('panel_settings_home_desc').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  const admin = panel(t, { config: home, settings: { isAdmin: true, homeOpsStrip: false } });
  assert.equal(admin.document.getElementById('homeOpsStripSelect').value, 'off');
  const noSwitch = panel(t, { config: { ArrHomeRowsEnabled: true }, settings: { isAdmin: true } });
  assert.equal(noSwitch.document.getElementById('homeOpsStripSelect'), null, 'strip switch off');
});

test('choosing saves Hide as false and Follow as null, leaves untouched rows unwritten, and re-reads the home rows', async t => {
  const h = panel(t, { config: home, settings: { isAdmin: true } });
  h.wire();
  await h.choose('homeRowArrivedSelect', 'off');
  let saved = JSON.parse(h.writes.at(-1).data).Set;
  assert.equal(saved.homeRowArrived, false);
  assert.ok(!('homeRowRequests' in saved) && !('homeRowSoon' in saved) && !('homeOpsStrip' in saved));
  assert.deepEqual(h.toasts, [tr('panel_settings_home_saved')]);
  assert.equal(h.refreshes.length, 1);
  assert.deepEqual({ ...h.refreshes[0] }, { fresh: true });
  await h.choose('homeOpsStripSelect', 'off');
  assert.equal(JSON.parse(h.writes.at(-1).data).Set.homeOpsStrip, false);
  await h.choose('homeRowArrivedSelect', '');
  saved = JSON.parse(h.writes.at(-1).data).Set;
  assert.equal(saved.homeRowArrived, null);
  assert.ok(!('homeOpsStrip' in saved), 'a save sends only its own field (round 7)');
  assert.equal(h.JE.currentSettings.homeOpsStrip, false);
  assert.equal(h.writes.length, 3);
  assert.equal(h.refreshes.length, 3);
});

test('a select left on the page after the rows were turned off saves nothing', async t => {
  const h = panel(t, { config: home });
  h.wire();
  h.JE.pluginConfig.ArrHomeRowsEnabled = false;
  await h.choose('homeRowRequestsSelect', 'off');
  assert.equal(h.writes.length, 0);
  assert.equal(h.refreshes.length, 0);
});

test('translated home-row labels are escaped', t => {
  const h = panel(t, { config: home, translate: key => (key.startsWith('panel_settings_home') ? '<img src=x onerror=alert(1)>' : tr(key)) });
  assert.equal(h.document.querySelectorAll('img[src="x"]').length, 0);
  assert.equal(h.document.getElementById('homeRowSoonSelect').options[1].textContent, '<img src=x onerror=alert(1)>');
});
