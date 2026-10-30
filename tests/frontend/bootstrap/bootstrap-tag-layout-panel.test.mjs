import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from '../helpers/harness.mjs';

const toggles = ['autoPauseToggle', 'autoResumeToggle', 'autoPipToggle', 'autoSkipIntroToggle', 'autoSkipOutroToggle',
  'randomButtonToggle', 'randomUnwatchedOnly', 'randomScopeCurrentContainer', 'showWatchProgressToggle', 'showFileSizesToggle',
  'showAudioLanguagesToggle', 'removeContinueWatchingToggle', 'qualityTagsToggle', 'genreTagsToggle', 'pauseScreenToggle',
  'languageTagsToggle', 'ratingTagsToggle', 'ageRatingTagsToggle', 'statusTagsToggle', 'logoTagsToggle', 'peopleTagsToggle', 'tagsHideOnHoverToggle',
  'disableCustomSubtitleStyles', 'longPress2xEnabled', 'nativePosterTagsToggle', 'randomIncludeMovies', 'randomIncludeShows'];

/**
 * The real settings panel handlers over the controls the panel template
 * renders for tag layouts, with the real layout controller and settings
 * transport (writes are captured).
 */
function setup(t, stored = {}, cards = '') {
  const writes = [], toasts = [], reinit = [];
  const html = toggles.map(id => `<input type="checkbox" id="${id}">`).join('') + '<input id="pauseScreenDelayInput"><button id="releaseNotesBtn"></button>'
    // The Media Tags hub's layout tiles and density pills (radio groups, as ui-panel-media-tags.js renders them).
    + `<div id="jeTagLayoutChoice" role="radiogroup">${['corners', 'bands', 'caption', 'summary', 'minimal'].map(v => `<input type="radio" name="jeTagLayout" value="${v}">`).join('')}</div>`
    + '<div id="jeTagDensityChoice" role="radiogroup"><input type="radio" name="jeTagDensity" value="full"><input type="radio" name="jeTagDensity" value="compact"></div>'
    + '<div id="panel"></div>' + cards;
  const h = createHarness({ html,
    JE: { pluginConfig: {}, userConfig: { settings: { ageRatingTagsPosition: 'bottom-right', ...stored }, shortcuts: { Shortcuts: [] } }, currentSettings: {},
      t: key => key, toast: message => toasts.push(message), pauseScreenInstance: {} },
    apiClient: { ajax: async request => { writes.push(request); } } });
  t.after(() => h.close());
  h.load('core/ui-kit.js'); h.load('core/tag-renderer-base.js'); h.load('core/tag-layout.js');
  h.load('tags/rating-sources.js'); h.load('enhanced/config.js'); h.JE.currentSettings = h.JE.loadSettings();
  h.JE.toast = message => toasts.push(message); // ui-kit installs its own
  const real = h.JE.reinitializeTagLayout;
  h.JE.reinitializeTagLayout = () => { reinit.push(h.JE.currentSettings.tagLayout); return real(); };
  h.load('enhanced/settingspanel/ui-panel-settings.js');
  const ctx = { createToast: (key, enabled) => `${key}:${enabled}`, resetAutoCloseTimer() {}, help: h.document.getElementById('panel'), primaryAccentColor: '#fff' };
  h.JE.internals.enhancedUi.wireSettingsListeners(ctx);
  h.JE.internals.enhancedUi.wireMiscSettingsControls(ctx);
  const settle = () => new Promise(resolve => setImmediate(resolve));
  return { ...h, writes, toasts, reinit, settle, async choose(name, value) {
    const el = h.document.querySelector(`input[name="${name}"][value="${value}"]`); el.checked = true;
    el.dispatchEvent(new h.window.Event('change', { bubbles: true })); await settle();
  } };
}

test('the layout tiles and density pills save a normalized document and re-present the cards', async t => {
  const h = setup(t);
  assert.equal(h.JE.currentSettings.tagLayoutSettingsVersion, 0, 'a document from before layouts');
  await h.choose('jeTagLayout', 'caption');
  let saved = JSON.parse(h.writes.at(-1).data);
  assert.equal(saved.tagLayout, 'caption');
  assert.equal(saved.tagLayoutSettingsVersion, 1, 'saving a layout setting promotes the document');
  assert.equal(saved.tagLayouts, null, 'profiles keep inheriting until edited');
  assert.deepEqual(h.reinit, ['caption']);
  assert.equal(h.JE.core.tagLayout.normalizeSettings().layout, 'caption');
  await h.choose('jeTagDensity', 'compact');
  saved = JSON.parse(h.writes.at(-1).data);
  assert.equal(saved.tagLabelDensity, 'compact');
  assert.equal(h.reinit.length, 2);
  assert.equal(h.toasts.at(-1), 'toast_tag_layout_updated');
});

/** Jellyfin 12 Modern card with its tag host (caption outlets go before the title). */
const card = id => `<div class="card" data-id="${id}" data-type="Movie"><div class="cardBox"><div class="cardScalable"><a class="cardImageContainer" href="#"></a><div class="je-tag-host"></div><div class="cardOverlayContainer"></div></div><div class="cardText cardText-first">Title</div></div></div>`;
const OFF = { qualityTagsEnabled: false, genreTagsEnabled: false, languageTagsEnabled: false, ratingTagsEnabled: false, ageRatingTagsEnabled: false, statusTagsEnabled: false };

test('the tag toggles re-evaluate the caption reservation: the last caption group off gives the strips back, one on reserves them', async t => {
  const h = setup(t, { ...OFF, languageTagsEnabled: true, tagLayoutSettingsVersion: 1, tagLayout: 'caption' }, card('a'.repeat(32)) + card('b'.repeat(32)));
  const strips = () => h.document.querySelectorAll('.je-tag-caption').length;
  const toggle = async (id, checked, { sync } = {}) => {
    const el = h.document.getElementById(id); el.checked = checked;
    el.dispatchEvent(new h.window.Event('change', { bubbles: true }));
    sync?.();
    await h.settle();
  };
  await h.JE.reinitializeTagLayout();
  assert.equal(strips(), 2, 'language can fill the strip: every card reserves it');
  assert.equal(h.JE.core.tagLayout.normalizeSettings().reserveCaption, true);
  await toggle('languageTagsToggle', false, { sync: () => assert.equal(strips(), 0, 'the toggle itself gives the space back, not only a later re-present') });
  assert.equal(strips(), 0);
  assert.equal(JSON.parse(h.writes.at(-1).data).languageTagsEnabled, false);
  await toggle('statusTagsToggle', true);
  assert.equal(strips(), 0, 'status shows on the poster: still nothing for the strip');
  await toggle('ratingTagsToggle', true);
  assert.equal(strips(), 2, 'a caption group back on reserves the strip on every card before its data arrives');
  await toggle('ratingTagsToggle', false);
  assert.equal(strips(), 0);
});
