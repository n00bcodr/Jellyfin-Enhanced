import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from '../helpers/harness.mjs';

const toggles = ['autoPauseToggle', 'autoResumeToggle', 'autoPipToggle', 'autoSkipIntroToggle', 'autoSkipOutroToggle',
  'randomButtonToggle', 'randomUnwatchedOnly', 'randomScopeCurrentContainer', 'showWatchProgressToggle', 'showFileSizesToggle',
  'showAudioLanguagesToggle', 'removeContinueWatchingToggle', 'qualityTagsToggle', 'genreTagsToggle', 'pauseScreenToggle',
  'languageTagsToggle', 'ratingTagsToggle', 'ageRatingTagsToggle', 'statusTagsToggle', 'peopleTagsToggle', 'tagsHideOnHoverToggle',
  'disableCustomSubtitleStyles', 'longPress2xEnabled', 'nativePosterTagsToggle', 'randomIncludeMovies', 'randomIncludeShows'];

/**
 * The real settings panel handlers over the controls the panel template
 * renders for tag layouts, with the real layout controller and settings
 * transport (writes are captured).
 */
function setup(t, stored = {}) {
  const writes = [], toasts = [], reinit = [];
  const html = toggles.map(id => `<input type="checkbox" id="${id}">`).join('') + '<input id="pauseScreenDelayInput"><button id="releaseNotesBtn"></button>'
    + `<select id="tagLayoutSelect">${['corners', 'bands', 'caption', 'summary', 'minimal'].map(v => `<option value="${v}">${v}</option>`).join('')}</select>`
    + '<select id="tagLabelDensitySelect"><option value="full">full</option><option value="compact">compact</option></select>'
    + '<div id="panel"></div>';
  const h = createHarness({ html,
    JE: { pluginConfig: {}, userConfig: { settings: { ageRatingTagsPosition: 'bottom-right', ...stored }, shortcuts: { Shortcuts: [] } }, currentSettings: {},
      t: key => key, toast: message => toasts.push(message), pauseScreenInstance: {} },
    apiClient: { ajax: async request => { writes.push(request); } } });
  t.after(() => h.close());
  h.load('core/ui-kit.js'); h.load('core/tag-renderer-base.js'); h.load('core/tag-layout.js');
  h.load('enhanced/config.js'); h.JE.currentSettings = h.JE.loadSettings();
  h.JE.toast = message => toasts.push(message); // ui-kit installs its own
  const real = h.JE.reinitializeTagLayout;
  h.JE.reinitializeTagLayout = () => { reinit.push(h.JE.currentSettings.tagLayout); return real(); };
  h.load('enhanced/settingspanel/ui-panel-settings.js');
  const ctx = { createToast: (key, enabled) => `${key}:${enabled}`, resetAutoCloseTimer() {}, help: h.document.getElementById('panel'), primaryAccentColor: '#fff' };
  h.JE.internals.enhancedUi.wireSettingsListeners(ctx);
  h.JE.internals.enhancedUi.wireMiscSettingsControls(ctx);
  const settle = () => new Promise(resolve => setImmediate(resolve));
  return { ...h, writes, toasts, reinit, settle, async select(id, value) {
    const el = h.document.getElementById(id); el.value = value;
    el.dispatchEvent(new h.window.Event('change', { bubbles: true })); await settle();
  } };
}

test('layout and density selects save a normalized document and re-present the cards', async t => {
  const h = setup(t);
  assert.equal(h.JE.currentSettings.tagLayoutSettingsVersion, 0, 'a document from before layouts');
  await h.select('tagLayoutSelect', 'caption');
  let saved = JSON.parse(h.writes.at(-1).data);
  assert.equal(saved.tagLayout, 'caption');
  assert.equal(saved.tagLayoutSettingsVersion, 1, 'saving a layout setting promotes the document');
  assert.equal(saved.tagLayouts, null, 'profiles keep inheriting until edited');
  assert.deepEqual(h.reinit, ['caption']);
  assert.equal(h.JE.core.tagLayout.normalizeSettings().layout, 'caption');
  await h.select('tagLabelDensitySelect', 'compact');
  saved = JSON.parse(h.writes.at(-1).data);
  assert.equal(saved.tagLabelDensity, 'compact');
  assert.equal(h.reinit.length, 2);
  assert.equal(h.toasts.at(-1), 'toast_tag_layout_updated');
});
