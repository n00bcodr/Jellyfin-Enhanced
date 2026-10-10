import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from '../helpers/harness.mjs';

const toggles = ['autoPauseToggle', 'autoResumeToggle', 'autoPipToggle', 'autoSkipIntroToggle', 'autoSkipOutroToggle',
  'randomButtonToggle', 'randomUnwatchedOnly', 'randomScopeCurrentContainer', 'showWatchProgressToggle', 'showFileSizesToggle',
  'showAudioLanguagesToggle', 'simplifyDubLanguageFlagsToggle', 'removeContinueWatchingToggle', 'qualityTagsToggle', 'genreTagsToggle', 'pauseScreenToggle',
  'languageTagsToggle', 'ratingTagsToggle', 'ageRatingTagsToggle', 'peopleTagsToggle', 'tagsHideOnHoverToggle',
  'disableCustomSubtitleStyles', 'longPress2xEnabled', 'nativePosterTagsToggle'];
function setup(t, config = {}) {
  const writes = [], toasts = [];
  const h = createHarness({ html: toggles.map(id => `<input type="checkbox" id="${id}">`).join('') + '<input id="pauseScreenDelayInput">',
    JE: { pluginConfig: config, userConfig: { settings: {}, shortcuts: { Shortcuts: [] } }, currentSettings: {},
      t: key => key, toast: message => toasts.push(message), pauseScreenInstance: {} }, apiClient: { ajax: async request => { writes.push(request); } } });
  t.after(() => h.close());
  h.load('enhanced/config.js'); h.JE.currentSettings = h.JE.loadSettings();
  h.load('enhanced/settingspanel/ui-panel-settings.js');
  h.JE.internals.enhancedUi.wireSettingsListeners({ createToast: (key, enabled) => `${key}:${enabled}`, resetAutoCloseTimer() {} });
  return { ...h, writes, toasts, async change(id, value) {
    const input = h.document.getElementById(id);
    if (input.type === 'checkbox') input.checked = value; else input.value = value;
    input.dispatchEvent(new h.window.Event('change', { bubbles: true }));
    await new Promise(resolve => setImmediate(resolve));
  } };
}

for (const [input, expected] of [['0', 5], ['-3', 1], ['200', 60], ['12', 12], ['invalid', 5]]) {
  test(`pause delay ${input} persists clamped value ${expected} to the real settings endpoint`, async t => {
    const h = setup(t); await h.change('pauseScreenDelayInput', input);
    assert.equal(h.JE.pauseScreenInstance.pauseScreenDelayMs, expected * 1000);
    assert.equal(h.writes.length, 1);
    assert.ok(h.writes[0].url.endsWith('/user-a/settings.json'));
    assert.equal(JSON.parse(h.writes[0].data).pauseScreenDelaySeconds, expected);
  });
}

test('pause delay digit keys do not bubble into host playback shortcuts', t => {
  const h = setup(t); let keys = 0; h.document.addEventListener('keydown', () => keys++);
  h.document.getElementById('pauseScreenDelayInput').dispatchEvent(new h.window.KeyboardEvent('keydown', { key: '5', bubbles: true }));
  assert.equal(keys, 0);
});

for (const enabled of [false, true]) test(`native poster preference is editable only with server feature enabled=${enabled}`, async t => {
  const h = setup(t, { NativePosterTagsEnabled: enabled }); await h.change('nativePosterTagsToggle', false);
  assert.equal(h.writes.length, enabled ? 1 : 0);
  assert.equal(h.JE.userConfig.settings.useNativePosterTags, enabled ? false : undefined);
  if (enabled) assert.equal(JSON.parse(h.writes[0].data).useNativePosterTags, false);
});

test('quality toggle initializes on enable and removes overlays on disable while persisting each choice', async t => {
  const h = setup(t); let initialized = 0; h.JE.initializeQualityTags = () => initialized++;
  await h.change('qualityTagsToggle', true);
  assert.equal(initialized, 1); assert.equal(h.JE.currentSettings.qualityTagsEnabled, true);
  h.document.body.insertAdjacentHTML('beforeend', '<div class="quality-overlay-container"></div><div class="genre-overlay-container"></div>');
  await h.change('qualityTagsToggle', false);
  assert.equal(h.document.querySelector('.quality-overlay-container'), null);
  assert.ok(h.document.querySelector('.genre-overlay-container'));
  assert.equal(h.writes.length, 2);
  assert.equal(JSON.parse(h.writes[1].data).qualityTagsEnabled, false);
});
