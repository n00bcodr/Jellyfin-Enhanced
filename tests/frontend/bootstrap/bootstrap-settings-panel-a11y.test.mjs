import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from '../helpers/harness.mjs';

// Design item A10: the panel is a modal dialog with a focus trap and focus restore, scoped for
// jellyfin-web's D-pad navigation, with real buttons and accessible names on its icon controls.

const settle = () => new Promise(resolve => setImmediate(resolve));

// The panel host (ui-panel.js) runs unchanged; the template is a stub with three panes, the
// inactive ones hidden by the same rule the real template uses.
const panelHtml = `<style>.je-pane { display: none; } .je-pane.active { display: block; }</style>
  <div class="panel-header"></div><div class="je-panel-body">
  <div class="je-panel-nav"><input id="jePanelSearch" type="text"><div class="je-panel-nav-items"></div></div>
  <div class="je-panel-main"><button id="jePanelBack" class="je-pane-back" type="button" style="display: none"></button>
    <section class="je-pane" data-pane="shortcuts"><h3 class="je-pane-title">Shortcuts</h3><button type="button" id="hiddenWhenInactive"></button></section>
    <section class="je-pane" data-pane="playback"><h3 class="je-pane-title">Playback</h3><input type="checkbox" id="autoPauseToggle"><button type="button" id="lastControl"></button><button type="button" disabled id="disabledControl"></button></section>
  </div></div><button id="closeSettingsPanel" type="button"></button>`;

function setup(t, { autoClose } = {}) {
  const timers = [];
  let nextId = 0;
  const keyListeners = { added: 0, removed: 0 };
  const h = createHarness({
    html: '<button id="opener" type="button">open</button><input id="pageField"><div role="dialog" id="otherDialog"><button id="otherDialogButton" type="button"></button></div>',
    globals: {
      matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
      ...(autoClose ? {
        setTimeout: (fn, ms) => { const id = ++nextId; timers.push({ id, fn, ms, cleared: false }); return id; },
        clearTimeout: id => { const timer = timers.find(entry => entry.id === id); if (timer) timer.cleared = true; }
      } : {})
    },
    JE: { pluginConfig: { HelpPanelAutocloseDelay: autoClose }, userConfig: { settings: {}, shortcuts: { Shortcuts: [] }, settingsStatus: 'ok' },
      currentSettings: {}, state: { activeShortcuts: { OpenSearch: '/' } }, t: key => key, keyListener() {},
      toCamelCase: value => Object.fromEntries(Object.entries(value).map(([k, v]) => [k[0].toLowerCase() + k.slice(1), v])),
      themer: { getThemeVariables: () => ({}) } },
    apiClient: { ajax: async () => ({ LastOpenedTab: 'playback' }) }
  });
  t.after(() => h.close());
  const add = h.document.addEventListener.bind(h.document), remove = h.document.removeEventListener.bind(h.document);
  h.document.addEventListener = (type, fn, options) => { if (fn === h.JE.keyListener) keyListeners.added++; return add(type, fn, options); };
  h.document.removeEventListener = (type, fn, options) => { if (fn === h.JE.keyListener) keyListeners.removed++; return remove(type, fn, options); };
  h.load('enhanced/config.js');
  h.JE.internals = { enhancedUi: { buildPanelHtml: () => panelHtml, wireShortcutEditor() {}, wireSettingsListeners() {},
    wireHiddenContentListeners() {}, wireMiscSettingsControls() {}, wireLanguageControls() {} } };
  h.load('enhanced/settingspanel/ui-panel.js');
  const panel = () => h.document.getElementById('jellyfin-enhanced-panel');
  const tab = (target, shiftKey = false) => {
    const event = new h.window.KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true });
    (target || h.document.activeElement || h.document.body).dispatchEvent(event);
    return event;
  };
  const key = (name, target) => {
    const event = new h.window.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true });
    (target || h.document.activeElement || h.document.body).dispatchEvent(event);
    return event;
  };
  return { ...h, panel, tab, key, timers, keyListeners };
}

test('the panel is a labelled modal dialog scoped as a jellyfin-web focus container, with initial focus inside', async t => {
  const h = setup(t);
  h.document.getElementById('opener').focus();
  await h.JE.showEnhancedPanel();
  const panel = h.panel();
  assert.equal(panel.getAttribute('role'), 'dialog');
  assert.equal(panel.getAttribute('aria-modal'), 'true');
  assert.equal(panel.getAttribute('aria-label'), 'Jellyfin Enhanced');
  assert.ok(panel.classList.contains('focuscontainer'), 'jellyfin-web D-pad navigation stays inside the panel');
  assert.equal(h.document.activeElement, panel.querySelector('.tab-button[data-tab="playback"]'), 'focus starts on the open section');
});

test('Tab and Shift+Tab wrap inside the panel and skip hidden, inert and disabled controls', async t => {
  const h = setup(t);
  await h.JE.showEnhancedPanel();
  const search = h.document.getElementById('jePanelSearch');
  const close = h.document.getElementById('closeSettingsPanel');
  close.focus();
  let event = h.tab();
  assert.equal(event.defaultPrevented, true);
  assert.equal(h.document.activeElement, search, 'Tab on the last control goes to the first');
  event = h.tab(undefined, true);
  assert.equal(h.document.activeElement, close, 'Shift+Tab on the first control goes to the last');

  // Between the edges the browser moves focus; the trap leaves it alone.
  const last = h.document.getElementById('lastControl');
  last.focus();
  assert.equal(h.tab().defaultPrevented, false);

  // The closing button inert (phone layer) and the pane controls hidden: the edges move.
  close.setAttribute('inert', '');
  h.panel().querySelector('.je-pane.active').classList.remove('active');
  h.panel().querySelector('.je-pane[data-pane="shortcuts"]').classList.add('active');
  search.focus();
  h.tab(undefined, true);
  assert.equal(h.document.activeElement, h.document.getElementById('hiddenWhenInactive'), 'last reachable control: the visible pane\'s button');
});

test('Tab from anywhere on the page behind the modal panel brings focus back into it', async t => {
  const h = setup(t);
  await h.JE.showEnhancedPanel();
  h.document.activeElement.blur();
  assert.equal(h.document.activeElement, h.document.body);
  assert.equal(h.tab(h.document.body).defaultPrevented, true);
  assert.equal(h.document.activeElement, h.document.getElementById('jePanelSearch'));
  // A click on the page behind (or a jellyfin-web autofocus) put focus on a page control.
  const pageField = h.document.getElementById('pageField');
  pageField.focus();
  assert.equal(h.tab().defaultPrevented, true);
  assert.equal(h.document.activeElement, h.document.getElementById('jePanelSearch'), 'Tab: the first panel control');
  pageField.focus();
  assert.equal(h.tab(undefined, true).defaultPrevented, true);
  assert.equal(h.document.activeElement, h.document.getElementById('closeSettingsPanel'), 'Shift+Tab: the last panel control');
});

test('focus in another dialog (one opened on top of the panel) is left alone', async t => {
  const h = setup(t);
  await h.JE.showEnhancedPanel();
  const other = h.document.getElementById('otherDialogButton');
  other.focus();
  assert.equal(h.tab().defaultPrevented, false);
  assert.equal(h.document.activeElement, other);
});

test('closing returns focus to the opener on every close path and restores the shortcut listener', async t => {
  for (const close of ['escape', 'button', 'toggle']) {
    await t.test(close, async st => {
      const h = setup(st);
      const opener = h.document.getElementById('opener');
      opener.focus();
      await h.JE.showEnhancedPanel();
      assert.notEqual(h.document.activeElement, opener);
      if (close === 'escape') h.key('Escape');
      else if (close === 'button') h.document.getElementById('closeSettingsPanel').click();
      else await h.JE.showEnhancedPanel();
      assert.equal(h.panel(), null);
      assert.equal(h.document.activeElement, opener);
      assert.equal(h.keyListeners.added, 1, 'shortcuts work again after the panel closes');
    });
  }
});

test('closing does not pull focus back when the user already moved it to the page', async t => {
  const h = setup(t);
  h.document.getElementById('opener').focus();
  await h.JE.showEnhancedPanel();
  h.document.getElementById('pageField').focus();
  h.document.getElementById('closeSettingsPanel').click();
  assert.equal(h.document.activeElement, h.document.getElementById('pageField'));
});

test('keyboard, focus and touch activity restart the auto-close timer', async t => {
  const h = setup(t, { autoClose: 15000 });
  await h.JE.showEnhancedPanel();
  const live = () => h.timers.filter(timer => !timer.cleared && timer.ms === 15000);
  assert.equal(live().length, 1);
  for (const fire of [
    () => h.key('ArrowDown'),
    () => h.document.getElementById('autoPauseToggle').focus(),
    () => h.panel().dispatchEvent(new h.window.Event('touchstart', { bubbles: true }))
  ]) {
    const before = live()[0];
    fire();
    assert.equal(before.cleared, true);
    assert.equal(live().length, 1);
    assert.notEqual(live()[0], before);
  }
  live()[0].fn();
  assert.equal(h.panel(), null, 'the timer still closes an idle panel');
  await settle();
});

// --- Template: real buttons and accessible names (ui-panel-template.js with stubbed presets). ---

// JE.t that knows every key (returns a marked translation) or none (returns the key, like a locale
// file that does not have the new keys yet).
const translateAll = (key, params) => params ? `${key}(${Object.values(params).join(',')})` : `[${key}]`;
const translateNone = key => key;

function buildTemplate(t, translate = translateAll) {
  const presets = [{ name: 'Small', size: 0.8, family: 'Arial', previewText: 'Aa', textColor: '#FFFFFFFF', bgColor: 'transparent' },
    { name: 'Normal', size: 1, family: 'Arial', previewText: 'Aa', textColor: '#FFFFFFFF', bgColor: 'transparent' },
    { name: 'Large', size: 1.2, family: 'Arial', previewText: 'Aa', textColor: '#FFFFFFFF', bgColor: 'transparent' }];
  const h = createHarness({
    JE: { pluginConfig: { Shortcuts: [{ Name: 'OpenSearch', Key: '/', Label: 'Open search', Category: 'Global' },
      { Name: 'CycleAudioTracks', Key: 'A', Label: 'Cycle audio' }] },
    userConfig: { shortcuts: { Shortcuts: [] } }, state: { activeShortcuts: { OpenSearch: '/', CycleAudioTracks: 'A', JumpToPercentage: '0-9' } },
    currentSettings: { qualityTagsEnabled: true, ratingTagsEnabled: true }, pluginVersion: '1.0',
    t: translate,
    escapeHtml: value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'),
    icon: () => '', IconName: new Proxy({}, { get: (target, name) => String(name) }), icons: { wrapEmoji: value => value },
    subtitlePresets: presets, fontSizePresets: presets, fontFamilyPresets: presets, subtitleTextEffectPresets: presets,
    getSubtitleTextShadow: () => 'none', decodeSubtitleColor: () => ({ swatch: '#FFFFFF', alphaValue: 255 }),
    internals: { enhancedUi: { GITHUB_REPO: 'owner/repo' } } }
  });
  t.after(() => h.close());
  h.load('enhanced/settingspanel/ui-panel-template.js');
  const root = h.document.createElement('div');
  root.innerHTML = h.JE.internals.enhancedUi.buildPanelHtml({});
  h.document.body.appendChild(root);
  return { ...h, root };
}

test('preset tiles, tag position cells and shortcut keys are buttons that keyboard and D-pad focus can reach', t => {
  const { root } = buildTemplate(t);
  const tiles = root.querySelectorAll('.preset-box');
  assert.equal(tiles.length, 12);
  for (const tile of tiles) {
    assert.equal(tile.tagName, 'BUTTON'); assert.equal(tile.type, 'button');
    assert.ok(['Small', 'Normal', 'Large'].includes(tile.getAttribute('aria-label')));
    assert.equal(tile.getAttribute('aria-pressed'), 'false');
  }
  const selectors = root.querySelectorAll('.position-selector');
  assert.equal(selectors.length, 5);
  for (const selector of selectors) {
    assert.equal(selector.getAttribute('role'), 'group');
    assert.equal(selector.getAttribute('aria-label'), '[panel_position_group]');
    assert.equal(selector.closest('label'), null, 'the cells are not part of the feature checkbox\'s label');
    assert.deepEqual([...selector.querySelectorAll('button[data-pos]')].map(cell => [cell.dataset.pos, cell.getAttribute('aria-label')]), [
      ['top-left', '[panel_position_top_left]'], ['top-right', '[panel_position_top_right]'],
      ['bottom-left', '[panel_position_bottom_left]'], ['bottom-right', '[panel_position_bottom_right]']]);
  }
  const keys = [...root.querySelectorAll('.shortcut-key:not([data-readonly])')];
  assert.ok(keys.length >= 2);
  for (const key of keys) assert.equal(key.tagName, 'BUTTON');
  assert.equal(root.querySelector('.shortcut-key[data-readonly]').tagName, 'SPAN', 'the read-only 0-9 row is not interactive');
});

test('icon-only controls have accessible names', t => {
  const { root } = buildTemplate(t);
  assert.equal(root.querySelector('#closeSettingsPanel').getAttribute('aria-label'), '[panel_close]');
  assert.equal(root.querySelector('#jePanelBack').getAttribute('aria-label'), '[panel_back]');
  assert.equal(root.querySelector('#subtitlePositionReset').getAttribute('aria-label'), '[panel_settings_subtitles_position_reset]');
  assert.equal(root.querySelector('#jePanelSearch').getAttribute('aria-label'), '[panel_search_placeholder]', 'the placeholder text');
  const toggles = [...root.querySelectorAll('.shortcut-toggle')];
  assert.ok(toggles.length >= 2);
  assert.equal(root.querySelector('.shortcut-toggle[data-action="OpenSearch"]').getAttribute('aria-label'), 'panel_shortcuts_toggle([shortcut_OpenSearch])');
  for (const toggle of toggles) assert.ok(toggle.getAttribute('aria-label'));
});

test('a locale file without the new keys gets English names, not raw keys', t => {
  const { root } = buildTemplate(t, translateNone);
  assert.equal(root.querySelector('#closeSettingsPanel').getAttribute('aria-label'), 'Close');
  assert.equal(root.querySelector('#jePanelBack').getAttribute('aria-label'), 'Back to sections');
  assert.equal(root.querySelector('#subtitlePositionReset').getAttribute('aria-label'), 'Reset position');
  assert.equal(root.querySelector('#subtitlePositionReset').getAttribute('title'), 'Reset position');
  assert.equal(root.querySelector('.shortcut-toggle[data-action="OpenSearch"]').getAttribute('aria-label'), 'Turn Open search on or off');
  assert.equal(root.querySelector('.shortcut-toggle[data-action="CycleAudioTracks"]').getAttribute('aria-label'), 'Turn Cycle audio on or off');
  const selector = root.querySelector('.position-selector');
  assert.equal(selector.getAttribute('aria-label'), 'Tag position');
  assert.deepEqual([...selector.querySelectorAll('button[data-pos]')].map(cell => cell.getAttribute('aria-label')),
    ['Top left', 'Top right', 'Bottom left', 'Bottom right']);
  assert.doesNotMatch(root.innerHTML, /(aria-label|title)="(panel_close|panel_back|panel_shortcuts_toggle|panel_position_|panel_settings_subtitles_position_reset)/,
    'no new accessible name is a raw key');
});

test('the phone sheet drops the 350px minimum width and touch-only devices hide the keyboard hint', t => {
  const { root } = buildTemplate(t);
  const css = root.querySelector('style').textContent;
  const phone = /@media \(max-width: 760px\) \{\s*#jellyfin-enhanced-panel \{([^}]*)\}/.exec(css);
  assert.ok(phone, 'phone sheet rule');
  assert.match(phone[1], /min-width: 0 !important/);
  assert.match(css, /@media \(hover: none\) and \(pointer: coarse\) \{\s*#jellyfin-enhanced-panel \.panel-footer \{ display: none !important; \}/);
});
