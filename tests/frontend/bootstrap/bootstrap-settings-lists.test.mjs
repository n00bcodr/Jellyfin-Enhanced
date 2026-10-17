// Phase 4c1 (D29): each person's list preferences in the JE settings panel. Display preferences (entries, status) are
// tri-state: unset/null follows the household, "Hide" is false. Swap-in is a consent: only an explicit Yes is true. The
// box only exists while lists are on; status and swap-in selects only with their admin switches; untouched choices are
// never written.
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
    // Settings saves are POSTs; the panel also reads the server's cultures (answered empty).
    apiClient: { ajax: async request => { if (request.type === 'POST') writes.push(request); return []; } }
  });
  tt.after(() => h.close());
  h.load('enhanced/config.js');
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


const lists = { ArrListsEnabled: true, ArrListStatusEnabled: true, ArrListSwapInEnabled: true };

for (const config of [{}, { ArrListsEnabled: false }, { ArrListStatusEnabled: true, ArrListSwapInEnabled: true }]) test(`the Lists box is absent while lists are off (${JSON.stringify(config)})`, t => {
  const h = panel(t, { config });
  for (const id of ['listPlaceholdersSelect', 'listStatusSelect', 'listSwapInSelect']) assert.equal(h.document.getElementById(id), null);
  assert.ok(!h.document.body.textContent.includes(tr('panel_settings_lists_desc')));
});

test('with lists on, the box shows each preference; status and swap-in only with their own switches', t => {
  const only = panel(t, { config: { ArrListsEnabled: true } });
  assert.ok(only.document.getElementById('listPlaceholdersSelect'));
  assert.equal(only.document.getElementById('listStatusSelect'), null);
  assert.equal(only.document.getElementById('listSwapInSelect'), null);

  const h = panel(t, { config: lists, settings: { listPlaceholders: false, listSwapIn: true } });
  const pane = h.document.querySelector('section[data-pane="ui"]');
  const entries = pane.querySelector('#listPlaceholdersSelect');
  const status = pane.querySelector('#listStatusSelect');
  const swap = pane.querySelector('#listSwapInSelect');
  assert.ok(entries && status && swap);
  assert.deepEqual([...entries.options].map(o => [o.value, o.textContent]), [['', tr('panel_settings_lists_follow')], ['off', tr('panel_settings_lists_hide')]]);
  assert.deepEqual([...swap.options].map(o => [o.value, o.textContent]), [['', tr('panel_settings_lists_swapin_no')], ['on', tr('panel_settings_lists_swapin_yes')]]);
  assert.equal(entries.value, 'off');
  assert.equal(status.value, '');
  assert.equal(swap.value, 'on');
  assert.match(pane.textContent, new RegExp(tr('panel_settings_lists_desc').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('choosing saves Hide as false, household as null and swap-in Yes as true; untouched choices stay unwritten', async t => {
  const h = panel(t, { config: lists });
  h.wire();
  await h.choose('listStatusSelect', 'off');
  let saved = JSON.parse(h.writes.at(-1).data);
  assert.equal(saved.listStatus, false);
  assert.ok(!('listPlaceholders' in saved) && !('listSwapIn' in saved));
  assert.deepEqual(h.toasts, [tr('toast_list_settings_saved')]);
  await h.choose('listSwapInSelect', 'on');
  saved = JSON.parse(h.writes.at(-1).data);
  assert.equal(saved.listSwapIn, true);
  await h.choose('listSwapInSelect', '');
  saved = JSON.parse(h.writes.at(-1).data);
  assert.equal(saved.listSwapIn, null);
  await h.choose('listStatusSelect', '');
  assert.equal(JSON.parse(h.writes.at(-1).data).listStatus, null);
  assert.equal(h.writes.length, 4);
});

test('a select left on the page after lists were turned off saves nothing', async t => {
  const h = panel(t, { config: lists });
  h.wire();
  h.JE.pluginConfig.ArrListsEnabled = false;
  await h.choose('listSwapInSelect', 'on');
  assert.equal(h.writes.length, 0);
});

test('translated list labels are escaped', t => {
  const h = panel(t, { config: lists, translate: key => (key.startsWith('panel_settings_lists') ? '<img src=x onerror=alert(1)>' : tr(key)) });
  assert.equal(h.document.querySelectorAll('img[src="x"]').length, 0);
  assert.equal(h.document.getElementById('listSwapInSelect').options[1].textContent, '<img src=x onerror=alert(1)>');
});
