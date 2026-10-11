import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHarness } from '../helpers/harness.mjs';
import { repositoryRoot } from '../helpers/discovery.mjs';

// Design item C2: locked and gated rows in the settings panel (ui-panel-provenance.js over the real
// ui-panel-template.js), JE.settings.isLocked, and the panel refresh that brings Meta with it.

const lockableKeys = JSON.parse(readFileSync(resolve(repositoryRoot, 'tests/fixtures/settings/lockable-keys.json'), 'utf8'));
const camel = key => key.charAt(0).toLowerCase() + key.slice(1);

// Lockable keys with no row in the panel, and why. A row added for one of them must be keyed
// (data-setting-key) and taken off this list.
const NO_PANEL_ROW = {
  showRatingInPlayer: 'the per-user value is not used anywhere (decision 6); no panel control',
  reviewsExpandedByDefault: 'set from the reviews section on item pages, which checks JE.settings.isLocked'
};

const translate = (key, params) => params ? `${key}(${Object.values(params).join(',')})` : `[${key}]`;

function buildPanel(t, { meta = {}, settings = {}, t: tr = translate } = {}) {
  const presets = [{ name: 'Small', size: 0.8, family: 'Arial', previewText: 'Aa', textColor: '#FFFFFFFF', bgColor: 'transparent' },
    { name: 'Normal', size: 1, family: 'Arial', previewText: 'Aa', textColor: '#FFFFFFFF', bgColor: 'transparent' },
    { name: 'Large', size: 1.2, family: 'Arial', previewText: 'Aa', textColor: '#FFFFFFFF', bgColor: 'transparent' }];
  const h = createHarness({
    JE: { pluginConfig: { Shortcuts: [], NativePosterTagsEnabled: true },
      userConfig: { shortcuts: { Shortcuts: [] }, settingsMeta: meta }, state: { activeShortcuts: {} },
      currentSettings: { qualityTagsEnabled: true, ratingTagsEnabled: true, ...settings }, pluginVersion: '1.0',
      t: tr,
      escapeHtml: value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'),
      icon: () => '', IconName: new Proxy({}, { get: (target, name) => String(name) }), icons: { wrapEmoji: value => value },
      subtitlePresets: presets, fontSizePresets: presets, fontFamilyPresets: presets, subtitleTextEffectPresets: presets,
      getSubtitleTextShadow: () => 'none', decodeSubtitleColor: () => ({ swatch: '#FFFFFF', alphaValue: 255 }),
      internals: { enhancedUi: { GITHUB_REPO: 'owner/repo' } } }
  });
  t.after(() => h.close());
  h.load('enhanced/config.js');
  h.load('enhanced/settingspanel/ui-panel-template.js');
  h.load('enhanced/settingspanel/ui-panel-provenance.js');
  const root = h.document.createElement('div');
  root.innerHTML = h.JE.internals.enhancedUi.buildPanelHtml({});
  h.document.body.appendChild(root);
  const closers = [];
  const decorate = () => h.JE.internals.enhancedUi.decorateSettingsProvenance({ help: root, onPanelClose: fn => closers.push(fn) });
  const keyed = key => [...root.querySelectorAll('[data-setting-key]')].filter(el => el.dataset.settingKey === key);
  return { ...h, root, decorate, keyed, close: () => closers.forEach(fn => fn()) };
}

/** Controls a keyed element owns (not those of a nested keyed element). */
const ownControls = element => element.matches('input, select, textarea, button') ? [element]
  : [...element.querySelectorAll('input, select, textarea, button')].filter(c => c.closest('[data-setting-key]') === element);

test('every lockable key has a keyed row in the rendered panel, and locking all of them disables each one', t => {
  const h = buildPanel(t, { meta: { locked: lockableKeys.map(camel) } });
  for (const key of lockableKeys.map(camel)) {
    if (NO_PANEL_ROW[key]) {
      assert.equal(h.keyed(key).length, 0, `${key} now has a panel row: key it and drop it from NO_PANEL_ROW`);
      continue;
    }
    assert.ok(h.keyed(key).length >= 1, `${key}: a [data-setting-key] row in the panel`);
  }
  h.decorate();
  for (const key of lockableKeys.map(camel).filter(k => !NO_PANEL_ROW[k])) {
    for (const element of h.keyed(key)) {
      assert.equal(element.getAttribute('aria-disabled'), 'true', key);
      const controls = ownControls(element).filter(c => !c.hasAttribute('aria-expanded'));
      assert.ok(controls.length >= 1, `${key}: the row owns a control`);
      for (const control of controls) assert.equal(control.disabled, true, `${key}: ${control.outerHTML.slice(0, 80)}`);
    }
  }
  // Expanders only show other rows and stay usable; keys that are not lockable are left alone.
  assert.equal(h.root.querySelector('#qualityTagsSubToggleExpander').disabled, false);
  assert.equal(h.root.querySelector('#pauseScreenDelayInput').disabled, false);
  assert.equal(h.root.querySelector('#randomSourceSelect').disabled, false);
});

test('a locked row says who set it, names the saved choice only when it differs, and notes native reach', t => {
  const h = buildPanel(t, {
    meta: { locked: ['autoPipEnabled', 'qualityTagsEnabled', 'autoPauseEnabled', 'selectedFontSizePresetIndex'],
      saved: { autoPipEnabled: true, qualityTagsEnabled: false, autoPauseEnabled: true, selectedFontSizePresetIndex: 2 },
      chosen: ['qualityTagsEnabled'], reach: { qualityTagsEnabled: 'Both', genreTagsEnabled: 'Both' } },
    settings: { autoPipEnabled: false, qualityTagsEnabled: true, autoPauseEnabled: true, selectedFontSizePresetIndex: 0 }
  });
  h.root.querySelector('#autoPipToggle').checked = true; // rendered from an older document
  h.decorate();
  const note = key => h.keyed(key)[0].querySelector(':scope > .je-setting-provenance')?.textContent ?? null;
  assert.equal(note('autoPipEnabled'), '[panel_provenance_locked] panel_provenance_locked_previous([panel_provenance_on])');
  assert.equal(h.root.querySelector('#autoPipToggle').checked, false, 'the switch shows the enforced value');
  assert.equal(note('qualityTagsEnabled'), '[panel_provenance_locked] panel_provenance_locked_your_choice([panel_provenance_off])[panel_provenance_reach_native]');
  assert.equal(note('autoPauseEnabled'), '[panel_provenance_locked]', 'no "comes back" line when the saved value is the same');
  assert.equal(note('selectedFontSizePresetIndex'), '[panel_provenance_locked] panel_provenance_locked_previous(Large)');
  assert.equal(note('genreTagsEnabled'), null, 'unlocked rows get nothing, reach alone included');
  assert.equal(h.keyed('genreTagsEnabled')[0].hasAttribute('aria-disabled'), false);
});

test('English fallbacks, nested keys labelled within their row, one note for the tag order group', t => {
  const h = buildPanel(t, { t: key => key,
    meta: { locked: ['qualityTagsPosition', 'resolutionTagOrder', 'randomIncludeShows'], saved: {} } });
  h.decorate();
  const qualityRow = h.keyed('qualityTagsEnabled')[0];
  const notes = qualityRow.querySelector(':scope > .je-setting-provenance');
  assert.deepEqual([...notes.children].map(line => line.textContent),
    ['Tag position: Set by your administrator.', 'Tag order: Set by your administrator.']);
  assert.equal(h.root.querySelector('#qualityTagsToggle').disabled, false);
  // Locking one order disables every reorder button (a reorder rewrites all six orders).
  for (const button of h.root.querySelectorAll('.je-cat-up, .je-cat-down')) assert.equal(button.disabled, true);
  for (const box of h.root.querySelectorAll('.je-quality-cat-row input')) assert.equal(box.disabled, false);
  const typesNote = h.root.querySelector('#randomIncludeShows').closest('[data-setting-row]').querySelector(':scope > .je-setting-provenance');
  assert.equal(typesNote.textContent, 'panel_settings_random_button_shows: Set by your administrator.');
  assert.equal(h.root.querySelector('#randomIncludeMovies').disabled, false);
});

test('a closed gate disables its row with a one-line reason', t => {
  const h = buildPanel(t, { meta: { unavailable: { useNativePosterTags: 'NativePosterTagsEnabled' } } });
  h.decorate();
  const row = h.keyed('useNativePosterTags')[0];
  assert.equal(h.root.querySelector('#nativePosterTagsToggle').disabled, true);
  assert.equal(row.getAttribute('aria-disabled'), 'true');
  assert.equal(row.querySelector('.je-setting-provenance').textContent, '[panel_provenance_unavailable]');
});

test('decorating again follows the latest Meta: an unlock re-enables only what it disabled', t => {
  const h = buildPanel(t, { meta: { locked: ['resolutionTagOrder', 'autoPipEnabled'] } });
  const firstUp = h.root.querySelector('.je-quality-cat-row .je-cat-up'); // disabled by the template (top row)
  assert.equal(firstUp.disabled, true);
  h.decorate();
  h.decorate();
  assert.equal(h.root.querySelectorAll('.je-setting-provenance').length, 2);
  h.JE.userConfig.settingsMeta = { locked: [] };
  h.document.dispatchEvent(new h.window.CustomEvent('je:settings-changed', { detail: { keys: ['autoPipEnabled'], rejected: [] } }));
  assert.equal(h.root.querySelectorAll('.je-setting-provenance').length, 0);
  assert.equal(h.root.querySelector('#autoPipToggle').disabled, false);
  assert.equal(firstUp.disabled, true, 'the top row\'s up button stays disabled');
  assert.equal(h.root.querySelectorAll('.je-quality-cat-row .je-cat-up:not([disabled])').length, 5);
  assert.equal(h.root.querySelectorAll('[aria-disabled]').length, 0);
  // Closed panels stop listening.
  h.close();
  h.JE.userConfig.settingsMeta = { locked: ['autoPipEnabled'] };
  h.document.dispatchEvent(new h.window.CustomEvent('je:settings-changed', { detail: { keys: [], rejected: [] } }));
  assert.equal(h.root.querySelector('#autoPipToggle').disabled, false);
});

test('a lock that arrives on an open panel moves preset and position selections to the enforced value; the unlock brings the user\'s back', async t => {
  const h = buildPanel(t, { settings: { qualityTagsPosition: 'top-left', selectedFontSizePresetIndex: 0, autoPipEnabled: true } });
  h.load('enhanced/settingspanel/ui-panel-settings.js');
  h.JE.saveUserSettings = async () => {};
  h.window.ApiClient.ajax = async () => ({ Items: [] }); // the random source list
  h.JE.internals.enhancedUi.wireMiscSettingsControls({ help: h.root, primaryAccentColor: 'rgb(1, 2, 3)', resetAutoCloseTimer() {} });
  h.decorate();
  const cell = pos => h.root.querySelector(`.position-selector[data-setting="qualityTagsPosition"] [data-pos="${pos}"]`);
  const preset = index => h.root.querySelector(`#font-size-presets-container [data-preset-index="${index}"]`);
  const pressed = () => [cell('top-left'), cell('bottom-right'), preset(0), preset(2)].map(el => el.getAttribute('aria-pressed'));
  assert.deepEqual(pressed(), ['true', 'false', 'true', 'false']);

  // A patch answer brings the admin's values and the locks while the panel is open.
  Object.assign(h.JE.currentSettings, { qualityTagsPosition: 'bottom-right', selectedFontSizePresetIndex: 2, autoPipEnabled: false });
  h.JE.userConfig.settingsMeta = { locked: ['qualityTagsPosition', 'selectedFontSizePresetIndex', 'autoPipEnabled'] };
  h.document.dispatchEvent(new h.window.CustomEvent('je:settings-changed', { detail: { keys: [], rejected: [], meta: true } }));
  assert.deepEqual(pressed(), ['false', 'true', 'false', 'true']);
  assert.equal(cell('bottom-right').style.background, 'rgb(1, 2, 3)');
  assert.match(preset(2).style.border, /rgb\(1, 2, 3\)/);
  assert.equal(h.root.querySelector('#autoPipToggle').checked, false);

  // Unlocked: the user's values come back with the answer, and the rows show them again.
  Object.assign(h.JE.currentSettings, { qualityTagsPosition: 'top-left', selectedFontSizePresetIndex: 0, autoPipEnabled: true });
  h.JE.userConfig.settingsMeta = { locked: [] };
  h.document.dispatchEvent(new h.window.CustomEvent('je:settings-changed', { detail: { keys: [], rejected: [], meta: true } }));
  assert.deepEqual(pressed(), ['true', 'false', 'true', 'false']);
  assert.equal(h.root.querySelector('#autoPipToggle').checked, true);
  assert.equal(h.root.querySelector('#autoPipToggle').disabled, false);
});

test('saved values are written as text, never as markup', t => {
  const h = buildPanel(t, { meta: { locked: ['displayLanguage'], saved: { displayLanguage: 'xx' }, chosen: ['displayLanguage'] } });
  const select = h.root.querySelector('#displayLanguageSelect');
  const option = h.document.createElement('option');
  option.value = 'xx';
  option.textContent = '<img src=x onerror="window.__pwned=1">';
  select.appendChild(option);
  h.decorate();
  const note = h.keyed('displayLanguage')[0].querySelector('.je-setting-provenance');
  assert.equal(note.querySelector('img'), null);
  assert.match(note.textContent, /panel_provenance_locked_your_choice\(<img src=x onerror="window.__pwned=1">\)/);
  assert.equal(h.window.__pwned, undefined);
});

test('JE.settings.isLocked reads Meta.Locked in either spelling', t => {
  const h = createHarness({ JE: { userConfig: {} } });
  t.after(() => h.close());
  h.load('enhanced/config.js');
  assert.equal(h.JE.settings.isLocked('watchProgressMode'), false);
  h.JE.userConfig.settingsMeta = { locked: ['watchProgressMode'] };
  assert.equal(h.JE.settings.isLocked('watchProgressMode'), true);
  assert.equal(h.JE.settings.isLocked('WatchProgressMode'), true);
  assert.equal(h.JE.settings.isLocked('reviewsExpandedByDefault'), false);
  assert.equal(h.JE.settings.isLocked(''), false);
  assert.equal(h.JE.settings.isLocked(null), false);
});

// --- the panel's refresh brings Meta (ui-panel.js) ---

function openPanel(t, answer) {
  const requests = [];
  const h = createHarness({
    globals: { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) },
    JE: { pluginConfig: {}, userConfig: { settings: {}, shortcuts: { Shortcuts: [] }, settingsStatus: 'ok', settingsMeta: { locked: ['old'] } },
      currentSettings: {}, state: { activeShortcuts: {} }, t: key => key, keyListener() {},
      toCamelCase: value => Object.fromEntries(Object.entries(value).map(([k, v]) => [k[0].toLowerCase() + k.slice(1), v])),
      camelCaseSettingsMeta: meta => ({ locked: meta.Locked.map(camel) }),
      themer: { getThemeVariables: () => ({}) } },
    apiClient: { ajax: async request => { requests.push(request.url); return answer; } }
  });
  t.after(() => h.close());
  h.load('enhanced/config.js');
  let decorated = 0;
  h.JE.internals = { enhancedUi: { buildPanelHtml: () => '<div class="je-panel-body"><div class="je-panel-nav"><div class="je-panel-nav-items"></div></div><div class="je-panel-main"></div></div><button id="closeSettingsPanel"></button>',
    wireShortcutEditor() {}, wireSettingsListeners() {}, wireHiddenContentListeners() {}, wireMiscSettingsControls() {}, wireLanguageControls() {},
    decorateSettingsProvenance: () => { decorated++; } } };
  h.load('enhanced/settingspanel/ui-panel.js');
  return { ...h, requests, decorated: () => decorated };
}

test('opening the panel refreshes the settings with their Meta, then decorates the rows', async t => {
  const h = openPanel(t, { Settings: { AutoPipEnabled: false, IsAdmin: false }, Meta: { Locked: ['AutoPipEnabled'] } });
  await h.JE.showEnhancedPanel();
  assert.match(h.requests[0], /\/JellyfinEnhanced\/user-settings\/user-a\/settings\.json\?meta=true&_=\d+$/);
  assert.deepEqual(h.JE.userConfig.settings, { autoPipEnabled: false, isAdmin: false });
  assert.deepEqual(h.JE.settingsMeta, { locked: ['autoPipEnabled'] });
  assert.equal(h.JE.settings.isLocked('autoPipEnabled'), true);
  assert.equal(h.decorated(), 1);
});

test('a server that ignores ?meta=true (plain document) has no locks or gates: the Meta from a newer server is dropped', async t => {
  const h = openPanel(t, { AutoPipEnabled: true, IsAdmin: false });
  assert.equal(h.JE.settings.isLocked('old'), true);
  await h.JE.showEnhancedPanel();
  assert.deepEqual(h.JE.userConfig.settings, { autoPipEnabled: true, isAdmin: false });
  assert.equal(h.JE.settingsMeta, null);
  assert.equal(h.JE.settings.isLocked('old'), false);
  assert.equal(h.decorated(), 1);
});
