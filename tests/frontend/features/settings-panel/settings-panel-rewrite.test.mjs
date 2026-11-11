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

test('the panel stays open while it is used by keyboard, TV remote or touch, and still closes once left alone', async t => {
  const h = panelHarness(t, { ajax: request => request.type === 'GET' ? h.snapshot('loaded-r1') : null });
  h.JE.pluginConfig.HelpPanelAutocloseDelay = 15000;
  let now = 0, nextId = 1; const timers = new Map();
  h.window.setTimeout = (fn, ms = 0) => { timers.set(nextId, { at: now + Number(ms), fn }); return nextId++; };
  h.window.clearTimeout = id => { timers.delete(id); };
  const advance = ms => { now += ms; for (const [id, timer] of [...timers].sort((a, b) => a[1].at - b[1].at)) if (timer.at <= now && timers.delete(id)) timer.fn(); };
  await h.JE.showEnhancedPanel();
  // No mouse event at all: the pointer never enters the panel.
  const inside = h.panel().querySelector('.je-pane-title');
  const uses = [() => inside.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })),
    () => inside.dispatchEvent(new h.window.FocusEvent('focusin', { bubbles: true })),
    () => inside.dispatchEvent(new h.window.Event('touchstart', { bubbles: true }))];
  for (const use of uses) for (let i = 0; i < 3; i++) { advance(10000); assert.ok(h.panel(), `open ${now / 1000} s after opening, used every 10 s`); use(); }
  advance(14999); assert.ok(h.panel());
  advance(1); assert.equal(h.panel(), null, 'closed once nobody used it for the configured delay');
});

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

// jellyfin-web dispatches a bubbling legacy `pagehide` on the view it leaves when it shows the next one, after the address
// has changed (lab: 140-240 ms after its pushState), so a panel opened in between saw it. Only the document's own pagehide
// is the page going away.
for (const [name, hide, opens] of [
  ["jellyfin-web's view pagehide (an in-app navigation)", h => h.document.body.appendChild(Object.assign(h.document.createElement('div'), { className: 'page' }))
    .dispatchEvent(new h.window.CustomEvent('pagehide', { bubbles: true })), true],
  ["the document's own pagehide", h => h.window.dispatchEvent(new h.window.PageTransitionEvent('pagehide', { persisted: false })), false],
]) test(`an opening panel ${opens ? 'still opens after' : 'is cancelled by'} ${name}`, async t => {
  const pending = deferred();
  const h = panelHarness(t, { ajax: request => request.type === 'GET' ? pending.promise : null });
  const opening = h.JE.showEnhancedPanel();
  hide(h);
  pending.resolve(h.snapshot('loaded-r1'));
  await opening;
  assert.equal(!!h.panel(), opens);
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

// A recognised theme's stylesheet (an @import of the author's hosted file) controls the variables the panel is drawn
// with; a stylesheet must not be able to run script through them in the panel's <style>, style attributes or handlers.
test('a theme variable that is not a plain CSS value never reaches the opened panel as markup or script', async t => {
  const h = panelHarness(t, { ajax: request => request.type === 'GET' ? h.snapshot('loaded-r1') : null });
  h.window.console.log = () => {};
  for (const file of ['tags/rating-sources.js', 'enhanced/icons.js', 'enhanced/helpers.js', 'enhanced/player/subtitles.js']) h.load(file);
  Object.assign(h.JE, { themer: undefined, cdn: { url: (repo, file) => `/cdn/${repo}/${file}` } });
  h.load('enhanced/themer.js');
  h.load('enhanced/settingspanel/ui-panel-settings.js');
  // The real template; the controls' wiring is not what this checks.
  for (const name of ['wireShortcutEditor', 'wireSettingsListeners', 'wireHiddenContentListeners', 'wireMiscSettingsControls', 'wireTagGroupEditor', 'wireLanguageControls']) h.ui[name] = () => {};
  delete h.ui.buildPanelHtml;
  h.load('enhanced/settingspanel/ui-panel-template.js');
  const root = h.document.documentElement.style;
  root.setProperty('--theme-updated-on', '2025-01-01'); // Jellyfish
  root.setProperty('--primary-accent-color', '</style><img id="je-theme-probe" src="x" onerror="window.pwned=1">');
  root.setProperty('--alt-accent-color', "red';window.pwned=2;'");
  root.setProperty('--secondary-background-transparent', 'red" onfocus="window.pwned=3" data-x="');
  root.setProperty('--text-color', 'rgba(1, 2, 3, 0.5)');
  await h.JE.showEnhancedPanel();
  const panel = h.panel();
  assert.ok(panel, 'the panel opened with the real template');
  assert.equal(panel.querySelector('#je-theme-probe'), null, 'nothing closed the panel <style> element');
  const carriers = [...panel.querySelectorAll('*')].flatMap(el => [...el.attributes].filter(a => /pwned/.test(a.value)).map(a => `${el.tagName}[${a.name}]`));
  assert.deepEqual(carriers, [], 'no attribute or handler holds the theme text');
  assert.doesNotMatch([...panel.querySelectorAll('style')].map(s => s.textContent).join(''), /pwned|<img/);
  assert.match(panel.querySelector('#releaseNotesBtn').getAttribute('style'), /color:\s*rgba\(1, 2, 3, 0\.5\)/, 'a plain colour is still used');
});

// Upstream 533614b8: the two subtitle offset shortcuts are listed in the panel's Player column.
test('the panel lists the subtitle offset shortcuts in the Player column with their keys', t => {
  const Shortcuts = [{ Name: 'FrameStepForward', Key: '.', Label: 'Step Forward One Frame', Category: 'Player' },
    { Name: 'DecreaseSubtitleOffset', Key: '[', Label: 'Decrease Subtitle Offset', Category: 'Player' },
    { Name: 'IncreaseSubtitleOffset', Key: ']', Label: 'Increase Subtitle Offset', Category: 'Player' },
    { Name: 'JumpToLastPosition', Key: 'Z', Label: 'Jump to Last Position', Category: 'Player' }];
  const h = createHarness({ JE: { pluginConfig: { HelpPanelAutocloseDelay: 60000, Shortcuts }, userConfig: { settings: {}, shortcuts: { Shortcuts: [] } }, currentSettings: {},
    state: { activeShortcuts: Object.fromEntries(Shortcuts.map(s => [s.Name, s.Key])) }, pauseScreenInstance: {}, t: k => k, toast() {} } });
  t.after(() => h.close());
  for (const file of ['core/ui-kit.js', 'tags/rating-sources.js', 'enhanced/config.js', 'enhanced/icons.js', 'enhanced/helpers.js', 'enhanced/player/subtitles.js']) h.load(file);
  h.JE.currentSettings = h.JE.loadSettings();
  h.JE.themer = { getThemeVariables: () => ({}) };
  for (const file of ['ui-panel-settings.js', 'ui-panel-template.js']) h.load(`enhanced/settingspanel/${file}`);
  const tpl = h.document.createElement('template');
  tpl.innerHTML = h.JE.internals.enhancedUi.buildPanelHtml({});
  const rows = [...tpl.content.querySelectorAll('.shortcut-key')].map(key => [key.dataset.action, key.textContent, key.parentElement.parentElement.lastElementChild.textContent.trim()]);
  const at = rows.findIndex(row => row[0] === 'FrameStepForward');
  assert.deepEqual(rows.slice(at, at + 4), [['FrameStepForward', '.', 'Step Forward One Frame'], ['DecreaseSubtitleOffset', '[', 'Decrease Subtitle Offset'],
    ['IncreaseSubtitleOffset', ']', 'Increase Subtitle Offset'], ['JumpToLastPosition', 'Z', 'Jump to Last Position']]);
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

test('the release notes panel and its failure toast are translated, with the date in the chosen language', async t => {
  const toasts = [];
  let fail = false;
  const h = createHarness({
    JE: { t: key => key, toast: message => toasts.push(message), icon: () => '', IconName: {}, escapeHtml: value => String(value ?? ''),
      themer: { getThemeVariables: () => ({}) }, core: { mediaLanguage: { uiLocale: () => 'de' } } },
    fetch: async () => fail ? jsonResponse({}, 500) : jsonResponse({ body: 'Notes', tag_name: 'v12.1', published_at: '2026-11-01T12:00:00Z', html_url: 'https://github.com/x' }),
  });
  t.after(() => h.close());
  h.load('enhanced/settingspanel/ui-release-notes.js');
  await h.JE.internals.enhancedUi.showReleaseNotesNotification();
  const panel = h.document.getElementById('jellyfin-release-notes-notification');
  assert.match(panel.textContent, /release_notes_latest/);
  assert.match(panel.textContent, new RegExp(`v12\\.1 - ${new Date('2026-11-01T12:00:00Z').toLocaleDateString('de').replace(/\./g, '\\.')}`));
  assert.equal(panel.querySelector('a[target="_blank"]').textContent, 'release_notes_view_full');
  assert.equal([...panel.querySelectorAll('button')].at(-1).textContent, 'release_notes_close');
  panel.remove();
  fail = true;
  h.expectConsoleError(/Failed to fetch release notes/);
  await h.JE.internals.enhancedUi.showReleaseNotesNotification();
  assert.match(toasts.at(-1), /release_notes_load_failed/);
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

test('shortcut overrides that failed to load are listed but cannot be rebound over the stored list', t => {
  const writes = [];
  const Shortcuts = [{ Name: 'FrameStepForward', Key: '.', Label: 'Step Forward One Frame', Category: 'Player' }];
  const h = createHarness({ JE: { pluginConfig: { HelpPanelAutocloseDelay: 60000, Shortcuts }, userConfig: { settings: {}, shortcuts: null }, currentSettings: {},
    state: { activeShortcuts: { FrameStepForward: '.' } }, pauseScreenInstance: {}, t: k => k, toast() {},
    keyCombo: e => e.key.toUpperCase() } });
  t.after(() => h.close());
  for (const file of ['core/ui-kit.js', 'tags/rating-sources.js', 'enhanced/config.js', 'enhanced/icons.js', 'enhanced/helpers.js', 'enhanced/player/subtitles.js']) h.load(file);
  h.JE.saveUserSettings = async (file, doc) => { writes.push([file, JSON.parse(JSON.stringify(doc))]); };
  h.JE.currentSettings = h.JE.loadSettings();
  h.JE.themer = { getThemeVariables: () => ({}) };
  for (const file of ['ui-panel-settings.js', 'ui-panel-template.js', 'ui-panel-shortcut-editor.js']) h.load(`enhanced/settingspanel/${file}`);
  const help = h.document.createElement('div');
  help.innerHTML = h.JE.internals.enhancedUi.buildPanelHtml({});
  h.document.body.append(help);
  h.JE.internals.enhancedUi.wireShortcutEditor({ help, pluginShortcuts: Shortcuts, primaryAccentColor: '#0af', kbdBackground: '#222' });
  const key = help.querySelector('.shortcut-key[data-action="FrameStepForward"]');
  assert.equal(key.textContent, '.');
  key.focus();
  key.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'q', bubbles: true, cancelable: true }));
  help.querySelector('.shortcut-toggle[data-action="FrameStepForward"]').click();
  assert.deepEqual(writes, []);
  assert.equal(h.JE.state.activeShortcuts.FrameStepForward, '.');
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
