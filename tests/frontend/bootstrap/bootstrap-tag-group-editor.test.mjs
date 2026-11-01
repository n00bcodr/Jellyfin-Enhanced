import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from '../helpers/harness.mjs';

// Panel controls outside the Media Tags hub that the settings wiring binds by id.
const otherToggles = ['autoPauseToggle', 'autoResumeToggle', 'autoPipToggle', 'autoSkipIntroToggle', 'autoSkipOutroToggle',
  'randomButtonToggle', 'randomUnwatchedOnly', 'randomScopeCurrentContainer', 'showWatchProgressToggle', 'showFileSizesToggle',
  'removeContinueWatchingToggle', 'pauseScreenToggle', 'disableCustomSubtitleStyles', 'longPress2xEnabled', 'randomIncludeMovies', 'randomIncludeShows'];

/**
 * The real Media Tags hub (ui-panel-media-tags.js) with the real tag group
 * editor (ui-panel-tag-editor.js) on its Groups tab and its live preview
 * (ui-panel-tag-preview.js), wired by the real settings panel modules over
 * the real layout controller and settings transport (writes are captured).
 * jsdom has no IntersectionObserver, so the hub builds its preview at once.
 * @param {import('node:test').TestContext} t
 * @param {{stored?: object, plugin?: object}} [options]
 */
function setup(t, { stored = {}, plugin = {}, looks = false } = {}) {
  const writes = [], toasts = [], calls = [];
  const html = otherToggles.map(id => `<input type="checkbox" id="${id}">`).join('')
    + '<input id="pauseScreenDelayInput"><button id="releaseNotesBtn"></button><div id="jellyfin-enhanced-panel"></div>';
  const h = createHarness({ html,
    JE: { pluginConfig: plugin, userConfig: { settings: { ...stored }, shortcuts: { Shortcuts: [] } }, currentSettings: {},
      t: (key, params) => (params ? `${key}${JSON.stringify(params)}` : key), toast: message => toasts.push(message), pauseScreenInstance: {} },
    apiClient: {
      getUrl: path => path,
      ajax: async request => { if (request.type === 'GET') return []; writes.push(request); },
    } });
  t.after(() => h.close());
  for (const file of ['core/ui-kit.js', 'core/media-language.js', 'core/tag-renderer-base.js', 'core/tag-layout.js', 'tags/tag-layout-styles.js', 'tags/rating-sources.js', 'enhanced/config.js', 'enhanced/icons.js']) h.load(file);
  h.JE.currentSettings = h.JE.loadSettings();
  h.JE.cdn = { flagSvg: code => `/flags/${code}.svg` };
  h.load('tags/languagetags.js');
  h.JE.escapeHtml = h.JE.core.ui.escapeHtml;
  h.JE.toast = message => toasts.push(message);
  for (const name of ['reinitializeTagLayout', 'reinitializeRatingTags', 'reinitializeGenreTags', 'reinitializeLanguageTags']) {
    const real = h.JE[name];
    h.JE[name] = (...args) => { calls.push(name); return real?.(...args); };
  }
  for (const file of ['ui-panel-settings.js', 'ui-panel-tag-editor.js', 'ui-panel-tag-preview.js', 'ui-panel-media-tags.js']) h.load(`enhanced/settingspanel/${file}`);
  const ui = h.JE.internals.enhancedUi;
  const ctx = { createToast: (key, enabled) => `${key}:${enabled}`, resetAutoCloseTimer() {}, help: h.document.getElementById('jellyfin-enhanced-panel'),
    primaryAccentColor: '#fff', toggleAccentColor: '#0af', detailsBackground: '#222', presetBoxBackground: '#111' };
  ctx.help.innerHTML = ui.buildMediaTagsHubHtml(ctx);
  if (looks) {
    h.load('core/tag-look.js');
    h.load('enhanced/settingspanel/ui-panel-tag-looks.js');
    ui.wireTagLooks(ctx);
  }
  ui.wireSettingsListeners(ctx);
  ui.wireMiscSettingsControls(ctx);
  ui.wireTagGroupEditor(ctx);
  ui.wireMediaTagsHub(ctx);
  const settle = () => new Promise(resolve => setImmediate(resolve));
  const $ = selector => h.document.querySelector(selector);
  const row = group => $(`.je-tge-row[data-group="${group}"]`);
  return { ...h, writes, toasts, calls, settle, $, row,
    saved: () => JSON.parse(writes.at(-1).data),
    order: () => Array.from(h.document.querySelectorAll('.je-tge-row')).map(r => r.dataset.group),
    async click(el) { el.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true })); await settle(); },
    async change(el, value) {
      if (typeof value === 'boolean') el.checked = value; else el.value = value;
      el.dispatchEvent(new h.window.Event('change', { bubbles: true })); await settle();
    },
    /** Pick a layout tile on the hub's Layout tab. */
    async layout(value) {
      const tile = $(`input[name="jeTagLayout"][value="${value}"]`);
      tile.checked = true;
      tile.dispatchEvent(new h.window.Event('change', { bubbles: true })); await settle();
    },
    preview: () => $('.je-mtp-sample[data-sample="movie"] .je-tag-host'),
    card: () => $('.je-mtp-sample[data-sample="movie"] .je-mtp-card'),
  };
}

test('rows follow the default order for a document without one; moving writes the order and keeps focus', async t => {
  const h = setup(t);
  assert.deepEqual(h.order(), ['status', 'quality', 'rating', 'ageRating', 'language', 'genre', 'awards', 'logos', 'custom']);
  assert.equal(h.row('status').querySelector('[data-dir="up"]').disabled, true);
  assert.equal(h.row('custom').querySelector('[data-dir="down"]').disabled, true);
  assert.equal(h.row('genre').querySelector('[data-dir="up"]').getAttribute('aria-label'), 'panel_settings_ui_tag_editor_move_up{"group":"common_genre"}');

  const up = h.row('genre').querySelector('[data-dir="up"]');
  up.focus();
  await h.click(up);
  assert.deepEqual(h.order(), ['status', 'quality', 'rating', 'ageRating', 'genre', 'language', 'awards', 'logos', 'custom']);
  let saved = h.saved();
  assert.deepEqual(saved.tagGroupOrder, ['status', 'quality', 'rating', 'ageRating', 'genre', 'language', 'awards', 'logos', 'custom']);
  assert.equal(saved.tagLayoutSettingsVersion, 1);
  assert.equal(h.document.activeElement, up, 'focus stays on the moved row\'s button');
  assert.equal(h.row('custom').querySelector('[data-dir="down"]').disabled, true);

  // Moving the top row down: its up button becomes enabled, the next row's disabled.
  await h.click(h.row('status').querySelector('[data-dir="down"]'));
  saved = h.saved();
  assert.deepEqual(saved.tagGroupOrder.slice(0, 2), ['quality', 'status']);
  assert.equal(h.row('quality').querySelector('[data-dir="up"]').disabled, true);
  assert.ok(h.calls.includes('reinitializeTagLayout'));
});

test('a position pill writes the selected layout\'s profile; corners also keeps the old position setting', async t => {
  const h = setup(t, { stored: { tagLayoutSettingsVersion: 1, tagLayout: 'corners', ageRatingTagsPosition: 'bottom-right' } });
  const pills = () => Array.from(h.row('ageRating').querySelectorAll('.je-tge-pill')).map(p => p.dataset.slot);
  assert.deepEqual(pills(), ['tl', 'tc', 'tr', 'ml', 'c', 'mr', 'bl', 'bc', 'br', 'off']);
  assert.equal(h.row('ageRating').querySelector('[aria-pressed="true"]').dataset.slot, 'br');

  await h.click(h.row('ageRating').querySelector('[data-slot="tl"]'));
  let saved = h.saved();
  assert.equal(saved.ageRatingTagsPosition, 'top-left', 'Native Poster Tags keep reading the position setting');
  assert.deepEqual(saved.tagLayouts.corners.groups, [{ group: 'ageRating', slot: 'tl' }]);
  assert.equal(h.row('ageRating').querySelector('.je-tge-summary').textContent, 'panel_settings_ui_tag_slot_corners_tl');

  // Off in corners hides the group but leaves the position setting alone.
  await h.click(h.row('ageRating').querySelector('[data-slot="off"]'));
  saved = h.saved();
  assert.equal(saved.ageRatingTagsPosition, 'top-left');
  assert.deepEqual(saved.tagLayouts.corners.groups, [{ group: 'ageRating', slot: 'off' }]);
  assert.equal(h.row('ageRating').querySelector('.je-tge-summary').textContent, 'hidden_content_already_hidden');

  // Another layout: its pills, its own profile, the corners pick untouched.
  await h.layout('minimal');
  assert.deepEqual(pills(), ['top', 'corner', 'hover', 'off'], 'dots are offered to quality only');
  assert.deepEqual(Array.from(h.row('quality').querySelectorAll('.je-tge-pill')).map(p => p.dataset.slot), ['top', 'dots', 'corner', 'hover', 'off']);
  assert.equal(h.row('quality').querySelector('.je-tge-summary').textContent, 'panel_settings_ui_tag_slot_minimal_dots · panel_settings_ui_tag_editor_summary_all');
  await h.click(h.row('ageRating').querySelector('[data-slot="corner"]'));
  saved = h.saved();
  assert.deepEqual(saved.tagLayouts.minimal.groups, [{ group: 'ageRating', slot: 'corner' }]);
  assert.deepEqual(saved.tagLayouts.corners.groups, [{ group: 'ageRating', slot: 'off' }]);
  assert.equal(saved.ageRatingTagsPosition, 'top-left');
  assert.equal(h.JE.core.tagLayout.normalizeSettings().slots.ageRating, 'corner');
});

test('the cap stepper clamps to 1..10, offers All only for quality and rating, and fixes age rating and status at one', async t => {
  const h = setup(t, { stored: { tagLayoutSettingsVersion: 1 } });
  const cap = group => h.row(group).querySelector('.je-tge-cap').textContent;
  const step = (group, dir) => h.row(group).querySelector(`.je-tge-step[data-step="${dir}"]`);

  assert.equal(cap('genre'), '3');
  await h.click(step('genre', 1));
  assert.equal(h.saved().tagGroupCaps.genre, 4);
  for (let i = 0; i < 10; i++) if (!step('genre', 1).disabled) await h.click(step('genre', 1));
  assert.equal(cap('genre'), '10');
  assert.equal(step('genre', 1).disabled, true, 'genre stops at 10');
  for (let i = 0; i < 12; i++) if (!step('genre', -1).disabled) await h.click(step('genre', -1));
  assert.equal(cap('genre'), '1');
  assert.equal(step('genre', -1).disabled, true, 'never below 1');
  assert.equal(h.saved().tagGroupCaps.genre, 1);

  assert.equal(cap('quality'), 'jellyseerr_discover_all');
  assert.equal(step('quality', 1).disabled, true);
  await h.click(step('quality', -1));
  assert.equal(h.saved().tagGroupCaps.quality, 10);
  await h.click(step('quality', 1));
  assert.equal(h.saved().tagGroupCaps.quality, 0, 'above 10 is All');
  assert.equal(h.row('quality').querySelector('.je-tge-summary').textContent, 'panel_settings_ui_tag_slot_corners_tl · panel_settings_ui_tag_editor_summary_all');

  for (const group of ['ageRating', 'status']) {
    assert.equal(cap(group), '1');
    assert.equal(step(group, 1).disabled && step(group, -1).disabled, true);
  }
  assert.equal(h.JE.internals.enhancedUi.tagGroupEditor.nextCap('status', 1, 1), null);
  assert.ok(h.calls.includes('reinitializeTagLayout'));
});

test('rating source checkboxes save ordered sources and re-render rating tags; the preview follows', async t => {
  const h = setup(t, { stored: { ratingTagsEnabled: true, tagLayoutSettingsVersion: 1 } });
  const chips = () => Array.from(h.preview().querySelectorAll('.rating-tag')).map(c => c.className);
  assert.deepEqual(chips(), ['rating-tag rating-tag-critic', 'rating-tag rating-tag-tmdb']);

  await h.change(h.row('rating').querySelector('[data-rating-source="community"]'), false);
  assert.deepEqual(h.saved().ratingTagsSources, ['critic']);
  assert.ok(h.calls.includes('reinitializeRatingTags'));
  assert.deepEqual(chips(), ['rating-tag rating-tag-critic']);

  // Quality and the others have nothing (or their own controls) to include.
  assert.ok(h.row('genre').textContent.includes('panel_settings_ui_tag_editor_nothing_to_include'));
  assert.equal(h.row('quality').querySelectorAll('#qualityTagsSubToggles .je-quality-cat-row').length, 10);
});

test('reset restores the administrator\'s layout defaults and keeps the enable toggles and includes', async t => {
  const plugin = { TagLayout: 'bands', TagLabelDensity: 'compact', TagGroupOrder: ['genre', 'quality'], TagGroupCaps: { Genre: 5 },
    TagLayouts: { Bands: { Groups: [{ Group: 'genre', Slot: 'top' }] } }, QualityTagsPosition: 'bottom-right' };
  const h = setup(t, { plugin, stored: { tagLayoutSettingsVersion: 1, tagLayout: 'minimal', qualityTagsEnabled: true, qualityTagsPosition: 'top-right',
    tagGroupOrder: ['status'], tagGroupCaps: { genre: 1 }, ratingTagsShowCritic: false } });
  await h.click(h.$('#jeTgeReset'));
  const saved = h.saved();
  assert.equal(saved.tagLayout, 'bands');
  assert.equal(saved.tagLabelDensity, 'compact');
  assert.deepEqual(saved.tagGroupOrder, ['genre', 'quality']);
  assert.deepEqual(saved.tagGroupCaps, { Genre: 5 });
  assert.deepEqual(saved.tagLayouts, { Bands: { Groups: [{ Group: 'genre', Slot: 'top' }] } });
  assert.equal(saved.qualityTagsPosition, 'bottom-right');
  assert.equal(saved.genreTagsPosition, 'top-right', 'an unset admin position falls back to the built-in one');
  assert.equal(saved.qualityTagsEnabled, true);
  assert.equal(saved.ratingTagsShowCritic, false);
  assert.equal(h.$('input[name="jeTagLayout"]:checked').value, 'bands', 'the Layout tab\'s tiles follow');
  assert.equal(h.$('input[name="jeTagDensity"]:checked').value, 'compact');
  assert.deepEqual(h.order().slice(0, 3), ['genre', 'quality', 'status']);
  assert.equal(h.row('genre').querySelector('.je-tge-cap').textContent, '5');
  assert.equal(h.toasts.at(-1), 'toast_tag_layout_reset');
});

test('Reset refreshes Otherwise to the admin layout and density with one save and preserves an open rule form', async t => {
  const h = setup(t, { looks: true, plugin: { TagLayout: 'bands', TagLabelDensity: 'compact' },
    stored: { tagLayoutSettingsVersion: 1, tagLayout: 'minimal', tagLabelDensity: 'full' } });
  await h.settle();
  const summary = () => h.$('[data-je-row="otherwise"] .je-tag-looks-outcome').textContent;
  assert.match(summary(), /tag_looks_layout_minimal.*tag_density_full/);
  const form = h.$('.je-tag-looks-form');
  assert.ok(form, 'the add form is always open');
  const input = form.querySelector('select');
  input.focus();
  await h.click(h.$('#jeTgeReset'));
  assert.match(summary(), /tag_looks_layout_bands.*tag_density_compact/);
  assert.equal(h.writes.length, 1, 'the refresh must not save again');
  assert.equal(h.$('.je-tag-looks-form'), form, 'the open editor is not rebuilt');
  assert.equal(h.document.activeElement, input, 'the refresh preserves focus');
});

test('programmatic layout and density changes refresh Otherwise without a save', async t => {
  const h = setup(t, { looks: true, stored: { tagLayoutSettingsVersion: 1, tagLayout: 'corners', tagLabelDensity: 'full' } });
  await h.settle();
  Object.assign(h.JE.currentSettings, { tagLayout: 'caption', tagLabelDensity: 'compact' });
  await h.JE.reinitializeTagLayout();
  assert.match(h.$('[data-je-row="otherwise"]').textContent, /panel_settings_ui_tag_slot_caption_caption.*tag_density_compact/);
  assert.equal(h.writes.length, 0);
});

test('reset refills genre caches truncated by an older cap when genres are enabled', async t => {
  const plugin = { TagGroupCaps: { Genre: 5 } };
  const h = setup(t, { plugin, stored: { tagLayoutSettingsVersion: 1, genreTagsEnabled: true, tagGroupCaps: { genre: 1 } } });
  h.calls.length = 0;
  await h.click(h.$('#jeTgeReset'));
  assert.ok(h.calls.includes('reinitializeGenreTags'), 'reset re-renders genre tags so a larger cap refills three-genre cache entries');
});

test('reset leaves genre tags alone when the group is off', async t => {
  const plugin = { TagGroupCaps: { Genre: 5 } };
  const h = setup(t, { plugin, stored: { tagLayoutSettingsVersion: 1, genreTagsEnabled: false, tagGroupCaps: { genre: 1 } } });
  h.calls.length = 0;
  await h.click(h.$('#jeTgeReset'));
  assert.ok(!h.calls.includes('reinitializeGenreTags'));
});

test('the preview re-renders through the layout controller on every editor change', async t => {
  const h = setup(t, { stored: { tagLayoutSettingsVersion: 1, qualityTagsEnabled: true, ratingTagsEnabled: true, statusTagsEnabled: true, genreTagsEnabled: false } });
  const host = h.preview();
  assert.ok(host, 'the preview cards are built with the hub');
  assert.equal(h.card().closest('.card'), null, 'not a .card: the pipeline and hover rules leave it alone');
  assert.equal(h.document.querySelector('.je-mtp-card .cardImageContainer'), null);
  assert.equal(host.dataset.jeLayout, 'corners');
  assert.deepEqual(Array.from(host.querySelectorAll('.quality-overlay-label')).map(c => c.textContent), ['4K', 'Dolby Vision', 'IMAX', 'HEVC', 'ATMOS 7.1']);
  assert.equal(host.querySelector('.genre-overlay-container'), null, 'disabled groups are not sampled');

  await h.layout('summary');
  assert.equal(host.dataset.jeLayout, 'summary');
  assert.ok(host.querySelector('.je-tag-pill'), 'summary draws its pill');

  await h.click(h.row('quality').querySelector('[data-slot="hover"]'));
  assert.equal(host.querySelector('.je-tag-pill [data-je-group="quality"]'), null, 'quality left the pill');
  assert.ok(host.querySelector('.je-tag-slot[data-je-slot="hover"] .quality-overlay-container'));

  await h.click(h.$('.je-mtp-view [data-view="hover"]'));
  assert.ok(h.card().classList.contains('je-tag-reveal'));
  assert.equal(h.$('.je-mtp-view [data-view="hover"]').getAttribute('aria-pressed'), 'true');
  await h.click(h.$('.je-mtp-view [data-view="rest"]'));
  assert.equal(h.card().classList.contains('je-tag-reveal'), false);

  // A quality category toggle (ui-panel-settings.js) and the enable toggle reach the preview too.
  await h.change(h.$('#showVideoCodecTagToggle'), false);
  // The hover reveal always uses compact labels, whatever the density setting.
  assert.deepEqual(Array.from(host.querySelectorAll('.je-tag-slot[data-je-slot="hover"] .quality-overlay-label')).map(c => c.textContent), ['4K', 'DV', 'IMAX', 'ATMOS']);
  await h.change(h.$('#qualityTagsToggle'), false);
  assert.equal(host.querySelector('.quality-overlay-container'), null);
  await h.change(h.$('#genreTagsToggle'), true);
  assert.ok(host.querySelector('.genre-overlay-container'));
  assert.ok(h.JE.core.tagLayout.buildStyles().includes('.je-tag-reveal) .je-tag-host > .je-tag-slot[data-je-slot="hover"] { opacity: 1; }'));
});

test('expanding a row is a real button with aria-expanded; every editor control is a focusable button or input', async t => {
  const h = setup(t);
  const expand = h.row('quality').querySelector('.je-tge-expand');
  const body = h.row('quality').querySelector('.je-tge-body');
  assert.equal(expand.tagName, 'BUTTON');
  assert.equal(body.hidden, true);
  await h.click(expand);
  assert.equal(expand.getAttribute('aria-expanded'), 'true');
  assert.equal(body.hidden, false);
  assert.equal(expand.getAttribute('aria-controls'), body.id);
  await h.click(expand);
  assert.equal(body.hidden, true);
  for (const el of h.document.querySelectorAll('.je-tge-pill, .je-tge-step, .je-tge-move, .je-tge-badges, .je-mtp-view button, #jeTgeReset')) {
    assert.equal(el.tagName, 'BUTTON');
    assert.equal(el.getAttribute('type'), 'button');
  }
  assert.equal(h.document.querySelectorAll('.je-tge-move[aria-label], .je-tge-step[aria-label]').length, 36);
});


test('status badge families live on the Status badges tab with defaults and personal overrides', async t => {
  const h = setup(t, { stored: { statusTagsEnabled: true } });
  h.JE.reinitializeStatusTags = () => h.calls.push('status');
  assert.equal(h.$('#jeMthPanel-badges').querySelectorAll('#statusTagsSubToggles input').length, 9);
  assert.equal(h.row('status').querySelector('#statusTagsSubToggles'), null, 'not duplicated in the Status row');
  for (const [name, expected] of [['Schedule', true], ['Milestones', true], ['SeriesStatus', false], ['Leaving', false], ['DirectPlay', false]]) {
    const input = h.$(`#statusTags${name}Toggle`);
    assert.equal(input.checked, expected, name);
    await h.change(input, !expected);
    assert.equal(h.saved()[`statusTags${name}`], !expected);
  }
  assert.equal(h.calls.filter(name => name === 'status').length, 5);
  const inherited = setup(t, { plugin: { StatusTagsSeriesStatus: true, StatusTagsSchedule: false } });
  assert.equal(inherited.$('#statusTagsSeriesStatusToggle').checked, true);
  assert.equal(inherited.$('#statusTagsScheduleToggle').checked, false);
});


test('source and edition settings inherit defaults, save, reorder and reset through the Quality editor', async t => {
  const h = setup(t, { plugin: { ShowEditionTag: false, EditionTagOrder: 1, ShowLowQualitySourceTag: true }, stored: { qualityTagsEnabled: true } });
  h.JE.reinitializeQualityTags = () => h.calls.push('reinitializeQualityTags');
  assert.equal(h.$('#showEditionTagToggle').checked, false);
  assert.equal(h.$('#showLowQualitySourceTagToggle').checked, true);
  assert.equal(h.$('#qualityTagsSubToggles .je-quality-cat-row').dataset.catKey, 'showResolutionTag');
  await h.change(h.$('#showEditionTagToggle'), true);
  assert.equal(h.saved().showEditionTag, true);
  await h.change(h.$('#showLowQualitySourceTagToggle'), false);
  assert.equal(h.saved().showLowQualitySourceTag, false);
  assert.ok(h.calls.includes('reinitializeQualityTags'));
  const edition = h.$('[data-cat-key="showEditionTag"]');
  await h.click(edition.querySelector('.je-cat-up'));
  assert.equal(h.saved().editionTagOrder, 1);
  await h.click(h.$('#jeTgeReset'));
  assert.equal(h.saved().showEditionTag, true, 'layout reset preserves category choices');
  assert.equal(h.saved().showLowQualitySourceTag, false);
  assert.equal(h.saved().editionTagOrder, 1);
});

test('inherited quality settings save as null until changed; a reorder makes the whole order the user\'s', async t => {
  const h = setup(t, { plugin: { SeriesQualityAggregation: 'best', ShowEditionTag: false, SourceTagOrder: 2 }, stored: { qualityTagsEnabled: true } });
  const orders = ['resolutionTagOrder', 'sourceTagOrder', 'dynamicRangeTagOrder', 'specialFormatTagOrder', 'videoCodecTagOrder', 'audioInfoTagOrder', 'editionTagOrder', 'runtimeTagOrder', 'aspectRatioTagOrder', 'frameRateTagOrder'];
  await h.change(h.$('#showLowQualitySourceTagToggle'), true);
  assert.equal(h.saved().showLowQualitySourceTag, true, 'a changed field is the user\'s');
  for (const key of ['seriesQualityAggregation', 'showEditionTag', ...orders]) assert.equal(h.saved()[key], null, `${key} follows the administrator`);
  assert.equal(h.JE.currentSettings.seriesQualityAggregation, 'best', 'shown as the administrator\'s');
  await h.click(h.$('[data-cat-key="showSourceTag"]').querySelector('.je-cat-up'));
  assert.deepEqual(orders.map(key => h.saved()[key]), [2, 1, 3, 4, 5, 6, 7, 8, 9, 10]);
  // Toggled back to the administrator's value: still the user's choice.
  await h.change(h.$('#showLowQualitySourceTagToggle'), false);
  assert.equal(h.saved().showLowQualitySourceTag, false);
  assert.equal(h.saved().seriesQualityAggregation, null, 'a field nobody touched still follows');
});

test('choosing another value and then the administrator\'s keeps it the user\'s through an administrator change', async t => {
  const plugin = { SeriesQualityAggregation: 'representative', ShowEditionTag: true, ShowLowQualitySourceTag: false };
  const h = setup(t, { plugin, stored: { qualityTagsEnabled: true } });
  const select = h.$('#seriesQualityAggregationSelect');
  assert.equal(select.value, '', 'an untouched policy follows the server');
  await h.change(select, 'best');
  await h.change(select, 'representative');
  await h.change(h.$('#showEditionTagToggle'), false);
  await h.change(h.$('#showEditionTagToggle'), true);
  await h.change(h.$('#showLowQualitySourceTagToggle'), true);
  await h.change(h.$('#showLowQualitySourceTagToggle'), false);
  const saved = h.saved();
  assert.equal(saved.seriesQualityAggregation, 'representative');
  assert.equal(saved.showEditionTag, true);
  assert.equal(saved.showLowQualitySourceTag, false);
  assert.equal(saved.sourceTagOrder, null, 'untouched orders still follow');
  for (const key of ['seriesQualityAggregation', 'showEditionTag', 'showLowQualitySourceTag']) assert.equal(h.JE.isSettingInherited(h.JE.currentSettings, key), false, key);

  // The administrator changes every default; the user keeps their choices.
  const later = setup(t, { plugin: { SeriesQualityAggregation: 'latest', ShowEditionTag: false, ShowLowQualitySourceTag: true }, stored: saved });
  assert.equal(later.JE.currentSettings.seriesQualityAggregation, 'representative');
  assert.equal(later.$('#seriesQualityAggregationSelect').value, 'representative');
  assert.equal(later.$('#showEditionTagToggle').checked, true);
  assert.equal(later.$('#showLowQualitySourceTagToggle').checked, false);
  await later.click(later.$('[data-cat-key="showSourceTag"]').querySelector('.je-cat-up'));
  assert.equal(later.saved().seriesQualityAggregation, 'representative', 'later saves keep it');

  // Across a reopen: the first choice was saved, then the administrator's value is picked.
  const reopened = setup(t, { plugin, stored: { qualityTagsEnabled: true, seriesQualityAggregation: 'best' } });
  await reopened.change(reopened.$('#seriesQualityAggregationSelect'), 'representative');
  assert.equal(reopened.saved().seriesQualityAggregation, 'representative');

  // Both changes before the first save serializes: the choice is still the user's.
  const quick = setup(t, { plugin, stored: { qualityTagsEnabled: true } });
  const quickSelect = quick.$('#seriesQualityAggregationSelect');
  for (const policy of ['best', 'representative']) {
    quickSelect.value = policy;
    quickSelect.dispatchEvent(new quick.window.Event('change', { bubbles: true }));
  }
  await quick.settle();
  assert.equal(quick.saved().seriesQualityAggregation, 'representative');
});

test('the Follow server policy and Follow server settings make the quality fields follow the administrator again', async t => {
  const orders = ['resolutionTagOrder', 'sourceTagOrder', 'dynamicRangeTagOrder', 'specialFormatTagOrder', 'videoCodecTagOrder', 'audioInfoTagOrder', 'editionTagOrder', 'runtimeTagOrder', 'aspectRatioTagOrder', 'frameRateTagOrder'];
  const stored = { qualityTagsEnabled: true, seriesQualityAggregation: 'best', showEditionTag: false, showLowQualitySourceTag: true,
    showRuntimeTag: true, showAspectRatioTag: true, showFrameRateTag: true,
    qualityAudioDisplayMode: 'all', qualityVideoCodecDisplayMode: 'all', qualityHdrDisplayMode: 'all', qualityMinimumResolution: '4k', qualityHideSdr: true,
    ...Object.fromEntries(orders.map((key, i) => [key, orders.length - i])) };
  const h = setup(t, { plugin: { SeriesQualityAggregation: 'latest', EditionTagOrder: 1, ResolutionTagOrder: 2 }, stored });
  let refreshed = 0; h.JE.reinitializeQualityTags = () => refreshed++;
  const select = h.$('#seriesQualityAggregationSelect');
  assert.equal(select.value, 'best');
  assert.equal(select.options[0].textContent, 'language_priority_inherit{"policy":"series_quality_aggregation_latest"}');
  await h.change(select, '');
  assert.equal(h.saved().seriesQualityAggregation, null);
  assert.equal(h.JE.currentSettings.seriesQualityAggregation, 'latest', 'shown as the administrator\'s');
  assert.equal(h.saved().showEditionTag, false, 'other choices are kept');

  await h.click(h.$('#qualityTagsFollowServer'));
  const saved = h.saved();
  assert.equal(h.JE.inheritedSettingKeys.length, 21);
  for (const key of h.JE.inheritedSettingKeys) assert.equal(saved[key], null, key);
  for (const key of ['showRuntimeTag', 'showAspectRatioTag', 'showFrameRateTag']) assert.equal(h.$(`[data-cat-key="${key}"] input`).checked, false, key);
  for (const key of ['qualityAudioDisplayMode', 'qualityVideoCodecDisplayMode', 'qualityHdrDisplayMode', 'qualityMinimumResolution', 'qualityHideSdr']) assert.equal(h.$(`#${key}Select`).value, '', key);
  assert.equal(h.$('#showEditionTagToggle').checked, true);
  assert.equal(h.$('#showLowQualitySourceTagToggle').checked, false);
  assert.equal(select.value, '');
  const rows = [...h.document.querySelectorAll('#qualityTagsSubToggles .je-quality-cat-row')];
  assert.deepEqual(rows.map(r => r.dataset.catKey).slice(0, 2), ['showEditionTag', 'showResolutionTag'], 'the administrator\'s order');
  assert.equal(rows[0].querySelector('.je-cat-up').disabled, true);
  assert.equal(rows.at(-1).querySelector('.je-cat-down').disabled, true);
  assert.ok(refreshed >= 2);
  assert.ok(h.toasts.includes('toast_quality_tags_follow_server'));

  // A later administrator change reaches the user.
  const later = setup(t, { plugin: { SeriesQualityAggregation: 'mixed', ShowEditionTag: false }, stored: saved });
  assert.equal(later.JE.currentSettings.seriesQualityAggregation, 'mixed');
  assert.equal(later.$('#seriesQualityAggregationSelect').value, '');
  assert.equal(later.$('#showEditionTagToggle').checked, false);
});

test('rating source order, minimum and colour persist through the real hub and preview', async t => {
  const h = setup(t, { stored: { ratingTagsEnabled: true, ratingTagsSources: ['imdb', 'tmdb', 'rtCritic'], tagLayoutSettingsVersion: 1 } });
  const box = h.row('rating');
  const chips = () => [...h.preview().querySelectorAll('.rating-tag')].map(el => el.dataset.jeRatingSource);
  assert.deepEqual(chips(), ['imdb', 'tmdb', 'rtCritic']);
  await h.click(box.querySelector('[data-source="tmdb"] [data-rating-move="-1"]'));
  assert.deepEqual(h.saved().ratingTagsSources, ['tmdb', 'imdb', 'rtCritic']);
  assert.deepEqual(chips(), ['tmdb', 'imdb', 'rtCritic']);
  await h.change(box.querySelector('[data-rating-minimum]'), '8');
  assert.equal(h.saved().ratingTagsMinScore, 8);
  await h.change(box.querySelector('[data-rating-color]'), true);
  assert.equal(h.saved().ratingTagsColorByScore, true);
  await h.change(box.querySelector('[data-rating-source="letterboxd"]'), true);
  assert.deepEqual(h.saved().ratingTagsSources, ['tmdb', 'imdb', 'rtCritic', 'letterboxd']);
  assert.ok(h.preview().querySelector('[data-je-rating-source="letterboxd"] svg'));
});

test('quality row exposes all aggregation policies, inherits the admin default, and persists changes', async t => {
  const h = setup(t, { plugin: { SeriesQualityAggregation: 'latest' } });
  let refreshed = 0; h.JE.reinitializeQualityTags = () => refreshed++;
  const select = h.$('#seriesQualityAggregationSelect');
  assert.equal(select.value, '', 'follows the server');
  assert.equal(h.JE.currentSettings.seriesQualityAggregation, 'latest');
  assert.deepEqual([...select.options].map(option => option.value), ['', 'representative', 'latest', 'best', 'shared', 'mixed']);
  assert.equal(select.labels[0].textContent, 'series_quality_aggregation_label');
  await h.change(select, 'mixed');
  assert.equal(h.saved().seriesQualityAggregation, 'mixed');
  assert.equal(refreshed, 1);
});

test('Language includes, style and badge controls save, reinitialize and refresh the real preview', async t => {
  const h = setup(t, { stored: { languageTagsEnabled: true } });
  const control = key => h.row('language').querySelector(`[data-language-key="${key}"]`);
  await h.change(control('languageTagsShowSubtitles'), true);
  assert.equal(h.saved().languageTagsShowSubtitles, true);
  await h.change(control('languageTagsStyle'), 'codes');
  assert.equal(h.saved().languageTagsStyle, 'codes');
  assert.ok(h.card().querySelector('.language-code'));
  await h.change(control('languageTagsCountBadge'), 'only');
  assert.equal(h.saved().languageTagsCountBadge, 'only');
  assert.ok(h.card().querySelector('.language-count-badge'));
  assert.ok(h.card().querySelector('.language-cc'));
  await h.change(control('languageTagsShowAudio'), false);
  assert.equal(h.saved().languageTagsShowAudio, false);
  assert.equal(h.card().querySelector('.language-count-badge'), null);
  assert.ok(h.calls.includes('reinitializeLanguageTags'));
});

test('centre pills save both position representations and repaint the live preview', async t => {
  const h = setup(t, { stored: { qualityTagsEnabled: true } });
  const positions = { tc: 'top-center', bc: 'bottom-center', ml: 'center-left', mr: 'center-right', c: 'center' };
  for (const [slot, position] of Object.entries(positions)) {
    await h.click(h.row('quality').querySelector(`[data-slot="${slot}"]`));
    assert.equal(h.saved().qualityTagsPosition, position);
    assert.ok(h.saved().tagLayouts.corners.groups.some(g => g.group === 'quality' && g.slot === slot));
    assert.ok(h.preview().querySelector(`[data-je-slot="${slot}"] [data-je-group="quality"]`));
  }
  assert.equal(h.row('quality').querySelector('.je-tge-pills').dataset.layout, 'corners');
  const css = h.document.getElementById('je-tag-group-editor').textContent;
  assert.match(css, /grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
});

test('language Priority editor adds by name/code, moves/removes, preserves focus and drives the real preview', async t => {
  const h = setup(t, { stored: { languageTagsEnabled: true }, plugin: { LanguageTagsPriority: 'German' } });
  const $ = selector => h.row('language').querySelector(selector);
  assert.equal($('[data-language-follow]').checked, true);
  await h.change($('[data-language-follow]'), false);
  assert.deepEqual(h.saved().languageTagsPriority, []);
  assert.equal($('[data-language-personal]').hidden, false);
  const search = async text => {
    const input = $('[data-language-priority-search]'); input.value = text;
    input.dispatchEvent(new h.window.Event('input', { bubbles: true })); await h.settle();
  };
  await search('jpn');
  assert.equal($('[data-language-priority-choice]').value, 'ja');
  await h.click($('[data-language-priority-action="add"]'));
  await search('French');
  await h.click($('[data-language-priority-action="add"]'));
  assert.deepEqual(h.saved().languageTagsPriority, ['ja', 'fr']);
  assert.deepEqual([...h.preview().querySelectorAll('.language-flag')].map(el => el.dataset.lang), ['jp', 'fr', 'de']);
  const up = $('[data-language-priority-code="fr"] [data-language-priority-action="up"]');
  up.focus(); await h.click(up);
  assert.deepEqual(h.saved().languageTagsPriority, ['fr', 'ja']);
  assert.equal(h.document.activeElement.closest('[data-language-priority-code]').dataset.languagePriorityCode, 'fr');
  await h.click($('[data-language-priority-code="ja"] [data-language-priority-action="remove"]'));
  assert.deepEqual(h.saved().languageTagsPriority, ['fr']);
  await h.change($('[data-language-priority-strict]'), 'true');
  assert.equal(h.saved().languageTagsPriorityStrict, true);
  assert.equal(h.preview().querySelectorAll('.language-flag').length, 1);
  await h.change($('[data-language-priority-strict]'), 'inherit');
  assert.equal(h.saved().languageTagsPriorityStrict, null);
  await h.change($('[data-language-follow]'), true);
  assert.equal(h.saved().languageTagsPriority, null);
  assert.deepEqual([...h.preview().querySelectorAll('.language-flag')].map(el => el.dataset.lang), ['de', 'fr', 'jp']);
  assert.equal(h.JE.currentSettings.tagLayoutSettingsVersion, 0, 'priority edits do not migrate legacy layout documents');
  assert.ok(h.calls.includes('reinitializeLanguageTags'));
  const entries = h.JE.internals.enhancedUi.mediaTagsHub.searchIndex();
  assert.ok(entries.some(e => e.label.includes('language_priority_follow')));
});

test('personal language editor enforces 12 languages, deduplicates aliases, and serializes saves', async t => {
  const values = ['en', 'ja', 'fr', 'de', 'it', 'pt', 'es', 'zh', 'ko', 'ar', 'hi', 'ru'];
  const h = setup(t, { stored: { languageTagsEnabled: true, languageTagsPriority: values } });
  const $ = selector => h.row('language').querySelector(selector);
  assert.equal($('[data-language-priority-action="add"]').disabled, true);
  assert.equal($('[data-language-priority-choice]').disabled, true);
  await h.click($('[data-language-priority-code="ru"] [data-language-priority-action="remove"]'));
  assert.equal(h.saved().languageTagsPriority.length, 11);
  const input = $('[data-language-priority-search]'); input.value = 'eng';
  input.dispatchEvent(new h.window.Event('input', { bubbles: true }));
  assert.equal([...$('[data-language-priority-choice]').options].some(o => o.value === 'en'), false);
  let finish;
  h.window.ApiClient.ajax = () => new Promise(resolve => { finish = resolve; });
  const saving = h.change($('[data-language-priority-strict]'), 'true');
  await h.settle();
  assert.equal($('.je-language-priority').disabled, true);
  assert.equal(typeof finish, 'function');
  finish(); await saving; await h.settle();
  assert.equal($('.je-language-priority').disabled, false);
});

test('personal language save failure restores the last policy and preview and permits retry', async t => {
  const h = setup(t, { stored: { languageTagsEnabled: true, languageTagsPriority: ['ja', 'fr'] } });
  const $ = selector => h.row('language').querySelector(selector);
  h.window.ApiClient.ajax = async () => { throw new Error('offline'); };
  await h.click($('[data-language-priority-code="fr"] [data-language-priority-action="up"]'));
  assert.deepEqual(Array.from(h.JE.currentSettings.languageTagsPriority), ['ja', 'fr']);
  assert.deepEqual([...h.preview().querySelectorAll('.language-flag')].map(el => el.dataset.lang), ['jp', 'fr', 'de']);
  assert.equal($('[data-language-priority-status]').textContent, 'language_priority_save_failed');
  assert.equal($('.je-language-priority').disabled, false);
  h.window.ApiClient.ajax = async req => h.writes.push(req);
  await h.click($('[data-language-priority-code="fr"] [data-language-priority-action="up"]'));
  assert.deepEqual(h.saved().languageTagsPriority, ['fr', 'ja']);
});

test('priority save fails while a subtitles toggle save is queued: persisted document keeps the old list and new subtitles value', async t => {
  const oldList = ['ja', 'en', 'fr'];
  const h = setup(t, { stored: { languageTagsEnabled: true, languageTagsPriority: oldList } });
  const requests = [];
  let rejectFirst, persisted;
  h.window.ApiClient.ajax = req => {
    const doc = JSON.parse(req.data);
    requests.push(doc);
    if (requests.length === 1) return new Promise((resolve, reject) => { rejectFirst = reject; });
    persisted = doc;
    return Promise.resolve();
  };
  await h.click(h.$('[data-language-priority-code="fr"] [data-language-priority-action="up"]'));
  assert.deepEqual(requests[0].languageTagsPriority, ['ja', 'fr', 'en']);
  await h.change(h.$('[data-language-key="languageTagsShowSubtitles"]'), true);
  assert.equal(requests.length, 1, 'the subtitles write waits for the priority outcome');
  rejectFirst(new Error('HTTP 500'));
  await h.settle();
  assert.equal(requests.length, 2);
  assert.deepEqual(persisted.languageTagsPriority, oldList);
  assert.equal(persisted.languageTagsShowSubtitles, true);
  assert.deepEqual(Array.from(h.JE.currentSettings.languageTagsPriority), oldList);
  assert.equal(h.JE.currentSettings.languageTagsShowSubtitles, true);
  assert.deepEqual(Array.from(h.$('[data-language-priority-list]').children, el => el.dataset.languagePriorityCode), oldList);
  assert.equal(h.$('[data-language-priority-status]').textContent, 'language_priority_save_failed');
});

test('two priority edits in quick succession where the first fails: pending edit is dropped and retry uses rolled-back state', async t => {
  const h = setup(t, { stored: { languageTagsEnabled: true, languageTagsPriority: ['ja', 'en', 'fr'] } });
  const requests = [];
  let rejectFirst;
  h.window.ApiClient.ajax = req => {
    requests.push(JSON.parse(req.data));
    if (requests.length === 1) return new Promise((resolve, reject) => { rejectFirst = reject; });
    return Promise.resolve();
  };
  await h.click(h.$('[data-language-priority-code="fr"] [data-language-priority-action="up"]'));
  assert.equal(h.$('.je-language-priority').disabled, true);
  // Dispatch even though a real disabled fieldset prevents this interaction.
  await h.click(h.$('[data-language-priority-code="en"] [data-language-priority-action="up"]'));
  await h.change(h.$('[data-language-priority-strict]'), 'true');
  assert.equal(requests.length, 1, 'click and change events while saving are dropped');
  rejectFirst(new Error('HTTP 500'));
  await h.settle();
  assert.equal(requests.length, 1, 'no deferred priority edit is replayed after failure');
  assert.deepEqual(Array.from(h.JE.currentSettings.languageTagsPriority), ['ja', 'en', 'fr']);
  assert.equal(h.JE.currentSettings.languageTagsPriorityStrict, null);
  assert.equal(h.$('[data-language-priority-strict]').value, 'inherit');
  await h.click(h.$('[data-language-priority-code="en"] [data-language-priority-action="up"]'));
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1].languageTagsPriority, ['en', 'ja', 'fr']);
  assert.deepEqual(Array.from(h.JE.currentSettings.languageTagsPriority), requests[1].languageTagsPriority);
  assert.equal(h.$('[data-language-priority-status]').textContent, 'language_priority_saved');
});

test('earlier queued settings saves cannot persist a priority edit that later fails', async t => {
  const oldList = ['ja', 'en', 'fr'];
  const h = setup(t, { stored: { languageTagsEnabled: true, languageTagsPriority: oldList } });
  const requests = [];
  let finishFirst, persisted;
  h.window.ApiClient.ajax = req => {
    const doc = JSON.parse(req.data);
    requests.push(doc);
    if (requests.length === 1) return new Promise(resolve => { finishFirst = () => { persisted = doc; resolve(); }; });
    if (requests.length === 3) return Promise.reject(new Error('HTTP 500'));
    persisted = doc;
    return Promise.resolve();
  };
  await h.change(h.$('[data-language-key="languageTagsShowSubtitles"]'), true);
  await h.change(h.$('[data-language-key="languageTagsStyle"]'), 'codes');
  await h.click(h.$('[data-language-priority-code="fr"] [data-language-priority-action="up"]'));
  assert.equal(requests.length, 1);
  finishFirst();
  await h.settle();
  assert.equal(requests.length, 3);
  assert.deepEqual(requests[2].languageTagsPriority, ['ja', 'fr', 'en']);
  assert.deepEqual(persisted.languageTagsPriority, oldList);
  assert.equal(persisted.languageTagsShowSubtitles, true);
  assert.equal(persisted.languageTagsStyle, 'codes');
  assert.deepEqual(Array.from(h.JE.currentSettings.languageTagsPriority), oldList);
  assert.equal(h.$('[data-language-priority-status]').textContent, 'language_priority_save_failed');
});

test('the Logos row precedes Custom by default, switches the group, offers All and previews a made-up logo', async t => {
  const h = setup(t, { plugin: { LogoTagsMaxLogos: 2 } });
  h.load('tags/logotags.js');
  const row = h.row('logos');
  assert.ok(row, 'the Logos row exists');
  assert.equal(h.order().at(-2), 'logos');
  assert.equal(row.querySelector('.je-tge-name').textContent, 'common_logos');
  assert.equal(row.querySelector('.je-tge-cap').textContent, 'jellyseerr_discover_all');
  assert.match(row.querySelector('.je-tge-body').textContent, /panel_settings_ui_logo_tags_include/);
  const toggle = row.querySelector('#logoTagsToggle');
  assert.equal(toggle.checked, false, 'off by default');
  await h.change(toggle, true);
  assert.equal(h.saved().logoTagsEnabled, true);
  const chip = h.preview()?.querySelector('.je-logo-chip');
  assert.ok(chip, 'the movie sample shows a logo');
  assert.equal(chip.title, 'Streamflix');
  assert.match(chip.querySelector('img').getAttribute('src'), /^data:image\/svg\+xml,/, 'the preview never fetches a logo');
  await h.click(row.querySelector('[data-step="-1"]'));
  assert.equal(h.saved().tagGroupCaps.logos, 10);
  await h.change(toggle, false);
  assert.equal(h.saved().logoTagsEnabled, false);
  assert.equal(h.preview()?.querySelector('.je-logo-chip') ?? null, null);
});


test('Quality display fields preserve inheritance, save independently and update preview extras and threshold', async t => {
  const h = setup(t, { stored: { qualityTagsEnabled: true }, plugin: { QualityAudioDisplayMode: 'all', QualityMinimumResolution: '4k' } });
  const fields = ['qualityAudioDisplayMode', 'qualityVideoCodecDisplayMode', 'qualityHdrDisplayMode', 'qualityMinimumResolution', 'qualityHideSdr'];
  for (const key of fields) {
    assert.equal(h.JE.isSettingInherited(h.JE.currentSettings, key), true, `${key} follows admin until chosen`);
    assert.equal(h.$(`#${key}Select`).value, '');
  }
  await h.change(h.$('#qualityAudioDisplayModeSelect'), 'highest');
  assert.equal(h.saved().qualityAudioDisplayMode, 'highest');
  assert.equal(h.saved().qualityVideoCodecDisplayMode, null);
  await h.change(h.$('#qualityAudioDisplayModeSelect'), 'all');
  assert.equal(h.saved().qualityAudioDisplayMode, 'all');
  assert.ok(h.preview().querySelector('[data-quality="DTS"]'));
  await h.change(h.$('#qualityHdrDisplayModeSelect'), 'all');
  assert.ok(h.preview().querySelector('[data-quality="SDR"]'));
  await h.change(h.$('#qualityHideSdrSelect'), 'true');
  assert.equal(h.saved().qualityHideSdr, true);
  assert.equal(h.preview().querySelector('[data-quality="SDR"]'), null);
  await h.change(h.$('#qualityMinimumResolutionSelect'), '4k');
  assert.equal(h.saved().qualityMinimumResolution, '4k');
  await h.change(h.$('#qualityAudioDisplayModeSelect'), '');
  assert.equal(h.saved().qualityAudioDisplayMode, null);
  assert.equal(h.saved().tagLayoutSettingsVersion, 0, 'display settings do not promote the legacy layout');
});


test('all nullable Quality choices preserve the loaded defaults across an administrator race and pin explicit equal choices', async t => {
  const h = setup(t, { stored: { qualityTagsEnabled: true }, plugin: { ShowRuntimeTag: false, QualityAudioDisplayMode: 'highest', QualityHideSdr: false } });
  const fields = h.JE.inheritedSettingKeys;
  const defaults = Object.fromEntries(fields.map(key => [key, h.JE.inheritedSettingDefault(h.JE.currentSettings, key)]));
  h.JE.pluginConfig = { ShowRuntimeTag: true, QualityAudioDisplayMode: 'all', QualityHideSdr: true, SeriesQualityAggregation: 'mixed' };
  await h.JE.saveUserSettings('settings.json', h.JE.currentSettings);
  for (const key of fields) {
    assert.equal(h.saved()[key], null, key);
    assert.equal(h.JE.isSettingInherited(h.JE.currentSettings, key), true, key);
    assert.equal(h.JE.inheritedSettingDefault(h.JE.currentSettings, key), defaults[key], key);
  }
  for (const key of ['showRuntimeTag', 'showAspectRatioTag', 'showFrameRateTag']) {
    await h.change(h.$(`[data-cat-key="${key}"] input`), true);
    await h.change(h.$(`[data-cat-key="${key}"] input`), false);
    assert.equal(h.saved()[key], false, key);
  }
  for (const [key, other, original] of [
    ['qualityAudioDisplayMode', 'all', 'highest'], ['qualityVideoCodecDisplayMode', 'all', 'highest'],
    ['qualityHdrDisplayMode', 'all', 'highest'], ['qualityMinimumResolution', '4k', 'off'], ['qualityHideSdr', 'true', 'false'],
  ]) {
    await h.change(h.$(`#${key}Select`), other);
    await h.change(h.$(`#${key}Select`), original);
    assert.equal(h.JE.isSettingInherited(h.JE.currentSettings, key), false, key);
    assert.equal(h.saved()[key], key === 'qualityHideSdr' ? false : original, key);
  }
  const later = setup(t, { stored: h.saved(), plugin: h.JE.pluginConfig });
  assert.equal(later.JE.currentSettings.showRuntimeTag, false);
  assert.equal(later.JE.currentSettings.qualityAudioDisplayMode, 'highest');
  assert.equal(later.JE.currentSettings.qualityHideSdr, false);
  assert.equal(later.JE.currentSettings.seriesQualityAggregation, 'mixed', 'untouched policy follows new default');
});

for (const maximum of [1, 2]) test(`single-chip group controls are hidden for a logo maximum of ${maximum}`, t => {
  const h = setup(t, { stored: { tagLayoutSettingsVersion: 1, tagGroupCaps: { status: 8, ageRating: 8, logos: 8 } }, plugin: { LogoTagsMaxLogos: maximum } });
  for (const group of ['status', 'ageRating', 'logos', 'quality', 'genre', 'language', 'rating', 'awards', 'custom']) {
    const fixed = ['status', 'ageRating'].includes(group) || (group === 'logos' && maximum === 1);
    assert.equal(h.row(group).querySelector('[data-je-cap-control]').hidden, fixed, group);
    if (fixed) assert.equal(h.row(group).querySelector('.je-tge-summary').textContent.includes('summary_up_to'), false, group);
  }
});
