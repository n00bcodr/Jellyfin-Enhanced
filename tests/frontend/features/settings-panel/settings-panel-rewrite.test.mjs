import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, deferred, jsonResponse } from '../../helpers/harness.mjs';
import { contractValue } from '../../contracts/fixtures.mjs';

// The settings panel's TypeScript bundles (client/src/features/settings-panel) loaded as the
// production scripts. These cover the defects fixed by the rewrite (SETTINGS-PANEL-*) and the
// registry contract other bundles (admin Media Tags page, item editor) read.

/** The real dialog host with a minimal template, over the real settings save path and contract. */
function panelHarness(t, { revision = 'loaded-r1', isAdmin = false, hostAdmin, ajax } = {}) {
  const requests = [];
  const h = createHarness({
    html: '<button id="opener">open</button>',
    JE: {
      pluginConfig: { HelpPanelAutocloseDelay: 60000 },
      userConfig: { settings: { isAdmin, autoPauseEnabled: false }, settingsRevision: revision, shortcuts: { Shortcuts: [] } },
      currentSettings: {},
      t: key => key, toast() {}, keyListener() {}, initializeShortcuts() {}, state: { activeShortcuts: { x: '1' } },
      themer: { getThemeVariables: () => ({ panelBg: '#000', secondaryBg: '#111', primaryAccent: '#0af', altAccent: '#222', blur: '0px', textColor: '#fff', logo: '' }) },
    },
    apiClient: { ajax: async request => { requests.push(request); return ajax ? ajax(request) : null; },
      ...(hostAdmin === undefined ? {} : { getCurrentUser: async () => ({ Id: 'user-a', Policy: { IsAdministrator: hostAdmin } }) }) },
    globals: { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) },
  });
  t.after(() => h.close());
  h.load('contracts/bootstrap.js');
  for (const file of ['core/ui-kit.js', 'enhanced/config.js']) h.load(file);
  h.JE.currentSettings = h.JE.loadSettings();
  h.JE.escapeHtml = h.JE.core.ui.escapeHtml;
  h.JE.toCamelCase = value => Object.fromEntries(Object.entries(value).map(([k, v]) => [k.charAt(0).toLowerCase() + k.slice(1), v]));
  h.window.Element.prototype.getClientRects = function () { return [{ width: 1, height: 1 }]; };
  h.load('enhanced/settingspanel/ui-panel.js');
  const ui = h.JE.internals.enhancedUi;
  ui.buildPanelHtml = () => '<div class="panel-header"><div id="jePanelTitle">JE</div><button id="closeSettingsPanel">x</button></div>'
    + '<div class="je-panel-body"><nav class="je-panel-nav"><div class="je-panel-nav-items"></div></nav>'
    + '<div class="je-panel-main"><section class="je-pane" data-pane="ui"><h3 class="je-pane-title">UI</h3></section></div></div>';
  const snapshot = (rev, settings = {}) => contractValue('RevisionedSettingsResponse', { Revision: rev, Settings: { IsAdmin: isAdmin, ...settings } });
  const posts = () => requests.filter(r => r.type === 'POST' && r.url.endsWith('/settings-document')).map(r => JSON.parse(r.data));
  return { ...h, ui, requests, posts, snapshot, panel: () => h.document.getElementById('jellyfin-enhanced-panel') };
}

test('SETTINGS-PANEL-01: opening the panel loads the revisioned document and the next save uses its revision', async t => {
  let answer;
  const h = panelHarness(t, { ajax: request => request.type === 'GET' ? answer : { Revision: 'saved-r3' } });
  answer = h.snapshot('other-tab-r2', { AutoPauseEnabled: true });
  const before = h.JE.currentSettings;
  await h.JE.showEnhancedPanel();
  const get = h.requests.find(r => r.type === 'GET');
  assert.match(get.url, /\/JellyfinEnhanced\/user-settings\/user-a\/settings-document\?_=\d+$/, 'the revisioned route, never the unrevisioned settings.json');
  assert.equal(h.JE.userConfig.settingsRevision, 'other-tab-r2', 'content and revision change together');
  assert.notEqual(h.JE.currentSettings, before, 'a fresh loaded settings object (with its own inheritance state)');
  assert.equal(h.JE.currentSettings.autoPauseEnabled, true);
  assert.ok(h.panel());
  await h.JE.saveUserSettings('settings.json', h.JE.currentSettings, { throwOnError: true });
  assert.equal(h.posts().at(-1).Revision, 'other-tab-r2', 'the panel save is not a spurious conflict');
});

test('SETTINGS-PANEL-01: an unchanged revision keeps the loaded object, so queued edits are never replaced', async t => {
  const h = panelHarness(t, { revision: 'same-r1', ajax: request => request.type === 'GET' ? h.snapshot('same-r1', { AutoPauseEnabled: true }) : null });
  const loaded = h.JE.currentSettings;
  loaded.autoPauseEnabled = 'edited locally';
  await h.JE.showEnhancedPanel();
  assert.equal(h.JE.currentSettings, loaded);
  assert.equal(h.JE.currentSettings.autoPauseEnabled, 'edited locally');
  assert.ok(h.panel());
});

test('SETTINGS-PANEL-01: a local save finishing during the request keeps the newer local document', async t => {
  const pending = deferred();
  const h = panelHarness(t, { revision: 'start-r1', ajax: request => request.type === 'GET' ? pending.promise : null });
  const loaded = h.JE.currentSettings;
  const opening = h.JE.showEnhancedPanel();
  // This tab's own save completed meanwhile (its receipt advanced the revision).
  h.JE.userConfig.settingsRevision = 'local-r2';
  pending.resolve(h.snapshot('server-r3', { AutoPauseEnabled: true }));
  await opening;
  assert.equal(h.JE.currentSettings, loaded);
  assert.equal(h.JE.userConfig.settingsRevision, 'local-r2');
});

for (const [name, answer] of [
  ['an invalid transport', { Revision: 'r9', Settings: { AutoPauseEnabled: 'yes' } }],
  ['another caller authority', 'admin-mismatch'],
  ['a document without a revision', 'no-revision'],
]) test(`SETTINGS-PANEL-01: ${name} keeps the loaded document and still opens the panel`, async t => {
  const h = panelHarness(t, { ajax: request => {
    if (request.type !== 'GET') return null;
    if (answer === 'admin-mismatch') return h.snapshot('r9', { IsAdmin: true });
    if (answer === 'no-revision') return h.snapshot('', { AutoPauseEnabled: true });
    return answer;
  } });
  const warnings = [];
  h.window.console.warn = (...args) => warnings.push(args.map(String).join(' '));
  const loaded = h.JE.currentSettings;
  await h.JE.showEnhancedPanel();
  assert.equal(h.JE.currentSettings, loaded);
  assert.equal(h.JE.userConfig.settingsRevision, 'loaded-r1');
  assert.ok(warnings.some(w => w.includes('Could not refresh settings for panel display')));
  assert.ok(h.panel());
});

for (const [hostAdmin, documentAdmin, applied] of [[true, true, true], [false, true, false], [true, false, false]]) {
  test(`SETTINGS-PANEL-01: the host's own policy decides the caller authority (host ${hostAdmin}, document ${documentAdmin})`, async t => {
    // The loaded document says "not an administrator": the host's policy wins, as the loader checks it.
    const h = panelHarness(t, { hostAdmin, ajax: request => request.type === 'GET'
      ? contractValue('RevisionedSettingsResponse', { Revision: 'policy-r2', Settings: { IsAdmin: documentAdmin } }) : null });
    h.window.console.warn = () => {};
    await h.JE.showEnhancedPanel();
    assert.equal(h.JE.userConfig.settingsRevision, applied ? 'policy-r2' : 'loaded-r1');
    assert.ok(h.panel());
  });
}

test('SETTINGS-PANEL-01: without the contract validator nothing unvalidated is applied', async t => {
  const h = panelHarness(t, { ajax: request => request.type === 'GET' ? h.snapshot('r2', { AutoPauseEnabled: true }) : null });
  delete h.window.__JE_BOOTSTRAP_CONTRACT__;
  h.window.console.warn = () => {};
  const loaded = h.JE.currentSettings;
  await h.JE.showEnhancedPanel();
  assert.equal(h.JE.currentSettings, loaded);
  assert.equal(h.JE.userConfig.settingsRevision, 'loaded-r1');
});

const TOGGLES = ['autoPauseToggle', 'autoResumeToggle', 'autoPipToggle', 'autoSkipIntroToggle', 'autoSkipOutroToggle',
  'randomButtonToggle', 'randomUnwatchedOnly', 'randomScopeCurrentContainer', 'showWatchProgressToggle', 'showFileSizesToggle',
  'showAudioLanguagesToggle', 'removeContinueWatchingToggle', 'qualityTagsToggle', 'genreTagsToggle', 'pauseScreenToggle',
  'languageTagsToggle', 'ratingTagsToggle', 'ageRatingTagsToggle', 'statusTagsToggle', 'logoTagsToggle', 'customTagsToggle', 'peopleTagsToggle',
  'tagsHideOnHoverToggle', 'disableCustomSubtitleStyles', 'longPress2xEnabled'];

/** The real Settings-tab wiring over the real save path, with document listener bookkeeping. */
function settingsHarness(t, { settings = {}, html = '' } = {}) {
  const writes = [];
  const h = createHarness({
    html: TOGGLES.map(id => `<input type="checkbox" id="${id}">`).join('') + html,
    JE: { pluginConfig: {}, userConfig: { settings: {}, shortcuts: { Shortcuts: [] } }, currentSettings: {},
      t: (key, params) => params ? `${key}:${JSON.stringify(params)}` : key, toast() {} },
    apiClient: { ajax: async request => { if (request.type === 'POST') writes.push(JSON.parse(request.data).Settings); } },
  });
  t.after(() => h.close());
  const counts = new Map();
  const { addEventListener, removeEventListener } = h.document;
  h.document.addEventListener = function (type, ...rest) { counts.set(type, (counts.get(type) || 0) + 1); return addEventListener.call(this, type, ...rest); };
  h.document.removeEventListener = function (type, ...rest) { counts.set(type, (counts.get(type) || 0) - 1); return removeEventListener.call(this, type, ...rest); };
  h.load('tags/rating-sources.js'); h.load('enhanced/config.js');
  h.JE.currentSettings = Object.assign(h.JE.loadSettings(), settings);
  h.load('enhanced/settingspanel/ui-panel-settings.js');
  return { ...h, writes, counts, settle: () => new Promise(resolve => setImmediate(resolve)) };
}

const GRID = '<div id="subtitlePositionGrid"></div><div id="subtitlePositionPreview"></div>';

test('SETTINGS-PANEL-02: the subtitle position drag listeners go with the panel instead of accumulating', async t => {
  const h = settingsHarness(t, { html: GRID });
  const grid = h.document.getElementById('subtitlePositionGrid');
  grid.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 100 });
  const tracked = ['mousemove', 'mouseup', 'touchmove', 'touchend'];
  const closers = [];
  for (let open = 0; open < 3; open++) {
    h.JE.internals.enhancedUi.wireSettingsListeners({ createToast: () => '', resetAutoCloseTimer() {}, onClose: fn => closers.push(fn) });
  }
  for (const type of tracked) assert.equal(h.counts.get(type), 3, `${type} bound once per open panel`);
  // Dragging still follows the pointer anywhere on the page and saves on release.
  grid.dispatchEvent(new h.window.MouseEvent('mousedown', { clientX: 50, clientY: 50, bubbles: true }));
  h.document.dispatchEvent(new h.window.MouseEvent('mousemove', { clientX: 150, clientY: 20, bubbles: true }));
  h.document.dispatchEvent(new h.window.MouseEvent('mouseup', { bubbles: true }));
  await h.settle();
  assert.equal(h.JE.currentSettings.subtitleHorizontalPosition, 75);
  assert.equal(h.JE.currentSettings.subtitleVerticalPosition, 20);
  assert.equal(h.writes.at(-1).subtitleHorizontalPosition, 75);
  // Closing every panel removes every document listener it added.
  closers.forEach(fn => fn());
  for (const type of tracked) assert.equal(h.counts.get(type), 0, `${type} released on close`);
  const saves = h.writes.length;
  h.document.dispatchEvent(new h.window.MouseEvent('mousemove', { clientX: 10, clientY: 10, bubbles: true }));
  h.document.dispatchEvent(new h.window.MouseEvent('mouseup', { bubbles: true }));
  await h.settle();
  assert.equal(h.JE.currentSettings.subtitleHorizontalPosition, 75, 'a closed panel never moves the subtitles');
  assert.equal(h.writes.length, saves);
});

test('SETTINGS-PANEL-02: a drag still held when the panel closes is saved, once', async t => {
  const h = settingsHarness(t, { html: GRID });
  const grid = h.document.getElementById('subtitlePositionGrid');
  grid.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 100 });
  let close;
  h.JE.internals.enhancedUi.wireSettingsListeners({ createToast: () => '', resetAutoCloseTimer() {}, onClose: fn => { close = fn; } });
  grid.dispatchEvent(new h.window.MouseEvent('mousedown', { clientX: 30, clientY: 40, bubbles: true }));
  close();
  await h.settle();
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0].subtitleHorizontalPosition, 30);
  h.document.dispatchEvent(new h.window.MouseEvent('mouseup', { bubbles: true }));
  await h.settle();
  assert.equal(h.writes.length, 1);
});

test('a crafted subtitle colour never breaks out of the panel preview style attributes', t => {
  const h = createHarness({ JE: { pluginConfig: { HelpPanelAutocloseDelay: 60000 }, userConfig: { settings: {}, shortcuts: { Shortcuts: [] } }, currentSettings: {}, state: { activeShortcuts: {} }, pauseScreenInstance: {}, t: k => k, toast() {} } });
  t.after(() => h.close());
  for (const file of ['core/ui-kit.js', 'tags/rating-sources.js', 'enhanced/config.js', 'enhanced/icons.js', 'enhanced/helpers.js', 'enhanced/player/subtitles.js']) h.load(file);
  h.JE.currentSettings = h.JE.loadSettings();
  h.JE.currentSettings.customSubtitleTextColor = 'red" onmouseover="window.pwned=1" data-x="';
  h.JE.currentSettings.customSubtitleBgColor = 'red; background-image: url(https://tracker.invalid/x)';
  h.JE.themer = { getThemeVariables: () => ({}) };
  for (const file of ['ui-panel-settings.js', 'ui-panel-template.js']) h.load(`enhanced/settingspanel/${file}`);
  const tpl = h.document.createElement('template');
  tpl.innerHTML = h.JE.internals.enhancedUi.buildPanelHtml({});
  for (const id of ['subtitleColorPreview', 'subtitlePositionPreview']) {
    const el = tpl.content.getElementById(id);
    assert.equal(el.getAttribute('onmouseover'), null, `${id}: no attribute from the stored colour`);
    assert.doesNotMatch(el.getAttribute('style'), /tracker\.invalid|background-image/, `${id}: no declaration from the stored colour`);
  }
  assert.equal(tpl.content.getElementById('customSubtitleTextColorPicker').value, '#ffffff');
});

/** The subtitle preset grids the template renders, with the real preset lists' shape. */
function presetHarness(t, settings) {
  const applied = [];
  const h = settingsHarness(t, {
    settings,
    html: '<input id="randomIncludeMovies" type="checkbox" checked><input id="randomIncludeShows" type="checkbox" checked><button id="releaseNotesBtn"></button>'
      + '<div id="subtitle-style-presets-container"><div class="preset-box style-preset" data-preset-index="1"><span>Aa</span></div></div>'
      + '<div id="font-size-presets-container"><div class="preset-box font-size-preset" data-preset-index="0"></div></div>'
      + '<div id="text-effect-presets-container"><div class="preset-box text-effect-preset" data-preset-index="1"></div></div>',
  });
  Object.assign(h.JE, {
    subtitlePresets: [{ name: 'Clean', textColor: '#FFFFFFFF', bgColor: '#00000000' }, { name: 'Boxed', textColor: '#FFFF00FF', bgColor: '#000000CC' }],
    fontSizePresets: [{ name: 'Tiny', size: 0.6 }, { name: 'Small', size: 0.8 }, { name: 'Normal', size: 1 }],
    fontFamilyPresets: [{ name: 'Default', family: 'inherit' }, { name: 'Serif', family: 'serif' }],
    subtitleTextEffectPresets: [{ name: 'Auto' }, { name: 'Outline' }],
    decodeSubtitleColor: value => ({ swatch: String(value).slice(0, 7), alphaValue: 255 }),
    getSubtitleTextShadow: (bg, effect) => `shadow:${bg}:${effect ?? ''}`,
    applySubtitleStyles: (...args) => applied.push(args),
    applySavedStylesWhenReady() {},
  });
  h.JE.internals.enhancedUi.wireMiscSettingsControls({ primaryAccentColor: '#0af', resetAutoCloseTimer() {}, closePanel() {} });
  return { ...h, applied, click: selector => h.document.querySelector(selector).click() };
}

for (const stored of [99, -1, 'large']) test(`SETTINGS-PANEL-03: a style preset applies and saves with a stored size index ${JSON.stringify(stored)} the presets lack`, async t => {
  const h = presetHarness(t, { selectedFontSizePresetIndex: stored, selectedFontFamilyPresetIndex: 7 });
  h.click('.style-preset');
  await h.settle();
  assert.deepEqual(h.applied.at(-1), ['#FFFF00FF', '#000000CC', 1, 'inherit', 'shadow:#000000CC:'], 'Normal size and the first font, as the template shows them');
  assert.equal(h.writes.at(-1).selectedStylePresetIndex, 1);
  assert.equal(h.writes.at(-1).customSubtitleBgColor, '#000000CC');
  h.click('.text-effect-preset');
  await h.settle();
  assert.deepEqual(h.applied.at(-1), ['#FFFF00FF', '#000000CC', 1, 'inherit', 'shadow:#000000CC:1']);
  assert.equal(h.writes.at(-1).selectedTextEffectPresetIndex, 1);
});

test('SETTINGS-PANEL-03: in-range stored indexes keep their presets', async t => {
  const h = presetHarness(t, { selectedFontSizePresetIndex: 1, selectedFontFamilyPresetIndex: 1 });
  h.click('.style-preset');
  await h.settle();
  assert.deepEqual(h.applied.at(-1).slice(2, 4), [0.8, 'serif']);
  h.click('.font-size-preset');
  await h.settle();
  assert.deepEqual(h.applied.at(-1).slice(2, 4), [0.6, 'serif']);
  assert.equal(h.writes.at(-1).selectedFontSizePresetIndex, 0);
});

test('release notes keep a GitHub link only when it is http(s), and escape release text', async t => {
  const h = createHarness({
    JE: { t: key => key, toast() {}, icon: () => '', IconName: {}, escapeHtml: value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
      themer: { getThemeVariables: () => ({}) } },
    fetch: async () => jsonResponse({ body: '**Bold** <img src=x onerror=alert(1)>', tag_name: 'v12.1', published_at: '2026-11-01T00:00:00Z', html_url: 'javascript:alert(1)' }),
  });
  t.after(() => h.close());
  h.load('enhanced/settingspanel/ui-release-notes.js');
  await h.JE.internals.enhancedUi.showReleaseNotesNotification();
  const panel = h.document.getElementById('jellyfin-release-notes-notification');
  assert.equal(panel.querySelector('a[target="_blank"]').getAttribute('href'), 'https://github.com/n00bcodr/Jellyfin-Enhanced/releases/latest');
  assert.equal(panel.querySelector('img'), null, 'release text cannot add elements');
  assert.ok(panel.querySelector('strong'));
  assert.match(panel.textContent, /v12\.1/);
  panel.remove();
});

test('a rebound shortcut the plugin defaults lack is stored under its action name', async t => {
  const writes = [];
  const h = createHarness({
    html: '<div id="p"><div style="display: flex; justify-content: space-between;"><div><span class="shortcut-key" tabindex="0" data-action="FrameStepBack">,</span></div><div></div></div></div>',
    JE: { pluginConfig: {}, userConfig: { shortcuts: { Shortcuts: [] } }, state: { activeShortcuts: { FrameStepBack: ',' } }, t: key => key,
      keyCombo: e => e.key.toUpperCase(), saveUserSettings: async (file, doc) => { writes.push(JSON.parse(JSON.stringify(doc))); } },
  });
  t.after(() => h.close());
  h.load('enhanced/settingspanel/ui-panel-shortcut-editor.js');
  h.JE.internals.enhancedUi.wireShortcutEditor({ help: h.document.getElementById('p'), pluginShortcuts: [], primaryAccentColor: '#0af', kbdBackground: '#222' });
  const key = h.document.querySelector('.shortcut-key');
  key.focus();
  key.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'q', bubbles: true, cancelable: true }));
  assert.deepEqual(writes.at(-1).Shortcuts, [{ Name: 'FrameStepBack', Key: 'Q' }]);
  key.focus();
  key.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true }));
  assert.deepEqual(writes.at(-1).Shortcuts, [{ Name: 'FrameStepBack', Key: '' }]);
});

test('the shared panel registry keeps every member the admin page and item editor read', t => {
  const h = createHarness({ JE: { t: key => key, escapeHtml: value => String(value), core: {}, currentSettings: {}, pluginConfig: {}, session: { onUserChange() {} } } });
  t.after(() => h.close());
  for (const file of ['ui-release-notes', 'ui-panel-template', 'ui-panel-shortcut-editor', 'ui-panel-settings', 'ui-panel-tag-editor', 'ui-panel-hidden-content',
    'ui-panel-language', 'ui-panel-tag-looks', 'ui-panel-tag-preview', 'ui-panel-tag-portable', 'ui-panel-media-tags', 'ui-panel-resize', 'ui-panel']) {
    h.load(`enhanced/settingspanel/${file}.js`);
  }
  const ui = h.JE.internals.enhancedUi;
  // admin-tags.js, admintags/sections/layout.js and portable.js, tags/tag-item-editor.js, configPage.html.
  assert.equal(typeof ui.createTagPreview, 'function');
  assert.equal(typeof ui.bindTagPreviewInteraction, 'function');
  assert.deepEqual(Object.keys(ui.tagGroupEditorData).sort(), ['GROUP_META', 'QUALITY_CATS', 'effectiveBool', 'sortedQualityCats', 'stepCap']);
  assert.deepEqual(Object.keys(ui.tagPortable).sort(), ['buttonHtml', 'copyText', 'download', 'errorOf', 'errorText', 'fieldName', 'injectDialogCss',
    'openDialog', 'parseDocument', 'previewHtml', 'readFile', 'sourceHtml', 'stamp', 'valueText', 'wireSource']);
  assert.equal(ui.createTagPreview(null), null, 'no preview without a mount or layout controller');
  assert.equal(ui.tagGroupEditorData.stepCap(10, 1, { capAll: true }), 0);
  assert.equal(ui.tagGroupEditorData.stepCap(0, -1, {}), 10);
  assert.equal(ui.tagGroupEditorData.stepCap(3, 1, { capFixed: true }), null);
  const plain = value => JSON.parse(JSON.stringify(value));
  assert.deepEqual(plain(ui.tagPortable.parseDocument('[1]')), { error: 'not-object' });
  assert.deepEqual(plain(ui.tagPortable.parseDocument('{')), { error: 'not-json' });
  assert.equal(typeof h.JE.showEnhancedPanel, 'function');
});
