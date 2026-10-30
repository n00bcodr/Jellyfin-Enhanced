import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from '../helpers/harness.mjs';

// Panel controls outside the Media Tags hub that the settings wiring binds by id.
const otherToggles = ['autoPauseToggle', 'autoResumeToggle', 'autoPipToggle', 'autoSkipIntroToggle', 'autoSkipOutroToggle',
  'randomButtonToggle', 'randomUnwatchedOnly', 'randomScopeCurrentContainer', 'showWatchProgressToggle', 'showFileSizesToggle',
  'removeContinueWatchingToggle', 'pauseScreenToggle', 'disableCustomSubtitleStyles', 'longPress2xEnabled', 'randomIncludeMovies', 'randomIncludeShows'];

// As the public configuration serves them: opaque ids, labels and icons.
const RULES = [
  { Id: 'tag:1a2b3c4d5e6f7081', Label: 'Remaster', Icon: 'auto_awesome' },
  { Id: 'collection:9f2c1e0b7a6d5c4e', Label: 'Criterion', Icon: null },
];

/**
 * The real Media Tags hub with its Groups tab and live preview, the real
 * Custom renderer and layout controller (writes captured).
 * @param {import('node:test').TestContext} t
 * @param {{stored?: object, plugin?: object}} [options]
 */
function setup(t, { stored = {}, plugin = {} } = {}) {
  const writes = [], toasts = [];
  const html = otherToggles.map(id => `<input type="checkbox" id="${id}">`).join('')
    + '<input id="pauseScreenDelayInput"><button id="releaseNotesBtn"></button><div id="jellyfin-enhanced-panel"></div>';
  const renderers = new Map();
  const h = createHarness({ html,
    JE: { pluginConfig: plugin, userConfig: { settings: { ...stored }, shortcuts: { Shortcuts: [] } }, currentSettings: {},
      t: (key, params) => (params ? `${key}${JSON.stringify(params)}` : key), toast: message => toasts.push(message), pauseScreenInstance: {},
      tagPipeline: { registerRenderer: (id, renderer) => renderers.set(id, renderer), getRenderer: id => renderers.get(id), clearProcessed() {}, scheduleScan() {} } },
    apiClient: {
      getUrl: path => path,
      ajax: async request => { if (request.type === 'GET') return []; writes.push(request); },
    } });
  t.after(() => h.close());
  for (const file of ['core/ui-kit.js', 'core/tag-renderer-base.js', 'core/tag-layout.js', 'tags/tag-layout-styles.js', 'tags/rating-sources.js', 'enhanced/config.js', 'enhanced/icons.js']) h.load(file);
  h.JE.currentSettings = h.JE.loadSettings();
  h.load('tags/customtags.js');
  h.JE.escapeHtml = h.JE.core.ui.escapeHtml;
  h.JE.toast = message => toasts.push(message);
  for (const file of ['ui-panel-settings.js', 'ui-panel-tag-editor.js', 'ui-panel-tag-preview.js', 'ui-panel-media-tags.js']) h.load(`enhanced/settingspanel/${file}`);
  const ui = h.JE.internals.enhancedUi;
  const ctx = { createToast: (key, enabled) => `${key}:${enabled}`, resetAutoCloseTimer() {}, help: h.document.getElementById('jellyfin-enhanced-panel'),
    primaryAccentColor: '#fff', toggleAccentColor: '#0af', detailsBackground: '#222', presetBoxBackground: '#111' };
  ctx.help.innerHTML = ui.buildMediaTagsHubHtml(ctx);
  ui.wireSettingsListeners(ctx);
  ui.wireMiscSettingsControls(ctx);
  ui.wireTagGroupEditor(ctx);
  ui.wireMediaTagsHub(ctx);
  const settle = () => new Promise(resolve => setImmediate(resolve));
  const $ = selector => h.document.querySelector(selector);
  return { ...h, writes, toasts, renderers, settle, $,
    row: group => $(`.je-tge-row[data-group="${group}"]`),
    saved: () => JSON.parse(writes.at(-1).data),
    async click(el) { el.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true })); await settle(); },
    async change(el, value) {
      if (typeof value === 'boolean') el.checked = value; else el.value = value;
      el.dispatchEvent(new h.window.Event('change', { bubbles: true })); await settle();
    },
    sample: key => $(`.je-mtp-sample[data-sample="${key}"] .je-tag-host`),
  };
}

test('the Groups tab has a Custom row: last by default, its switch, slot pills and a cap of up to ten', async t => {
  const h = setup(t, { plugin: { CustomTagRules: RULES } });
  const row = h.row('custom');
  assert.ok(row, 'a row for the group');
  assert.equal([...h.document.querySelectorAll('.je-tge-row')].at(-1), row, 'last in the default order');
  assert.equal(row.querySelector('.je-tge-name').textContent, 'panel_settings_ui_tag_group_custom');
  assert.match(row.querySelector('.je-tge-body').textContent, /panel_settings_ui_custom_tags_include/);
  assert.equal(row.querySelector('.je-tge-summary').textContent, 'panel_settings_ui_tag_slot_corners_tl · panel_settings_ui_tag_editor_summary_up_to{"count":3}');
  const toggle = h.$('#customTagsToggle');
  assert.equal(toggle.checked, false, 'off by default');

  await h.change(toggle, true);
  assert.equal(h.saved().customTagsEnabled, true);
  assert.ok(h.renderers.has('custom'), 'turning it on registers the renderer');
  assert.deepEqual(h.toasts.at(-1).split(':')[0], 'feature_custom_tags');

  await h.click(row.querySelector('[data-slot="br"]'));
  let saved = h.saved();
  assert.equal(saved.customTagsPosition, 'bottom-right', 'a corner pick writes the position setting too');
  assert.deepEqual(saved.tagLayouts.corners.groups.find(g => g.group === 'custom'), { group: 'custom', slot: 'br' });

  await h.click(row.querySelector('.je-tge-step[data-step="1"]'));
  saved = h.saved();
  assert.equal(saved.tagGroupCaps.custom, 4);
  assert.equal(saved.tagGroupCaps.genre, 3, 'promotion wrote the other legacy limits explicitly');
});

test('without rules the row says none are set up, and the preview shows a sample chip', async t => {
  const h = setup(t, { stored: { customTagsEnabled: true } });
  assert.match(h.row('custom').querySelector('.je-tge-body').textContent, /panel_settings_ui_custom_tags_none/);
  const chip = h.sample('movie').querySelector('.custom-tag');
  assert.ok(chip, 'the movie sample shows a custom chip');
  assert.equal(chip.dataset.jeCustom, 'custom_tags_sample');
  assert.equal(h.sample('episode').querySelector('.custom-tag'), null, 'episodes have none');
});

test('the preview draws the administrator\'s first rules as the renderer does', async t => {
  const h = setup(t, { stored: { customTagsEnabled: true }, plugin: { CustomTagRules: RULES } });
  const movie = [...h.sample('movie').querySelectorAll('.custom-tag')].filter(el => !el.closest('[data-je-slot="hover"]'));
  assert.deepEqual(movie.map(el => el.dataset.jeCustom), ['Remaster', 'Criterion']);
  assert.equal(movie[0].querySelector('.custom-tag-icon').textContent, 'auto_awesome');
  assert.equal(movie[1].querySelector('.custom-tag-icon'), null);
  const series = [...h.sample('series').querySelectorAll('.custom-tag')].filter(el => !el.closest('[data-je-slot="hover"]'));
  assert.deepEqual(series.map(el => el.dataset.jeCustom), ['Remaster']);

  // Switching the group off takes its chips out of the preview.
  await h.change(h.$('#customTagsToggle'), false);
  assert.equal(h.sample('movie').querySelector('.custom-tag'), null);
});
