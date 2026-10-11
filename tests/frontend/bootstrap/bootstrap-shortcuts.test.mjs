import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, loadKeyCombo, plain } from '../helpers/harness.mjs';

function setup(t, disabled = false) {
  const actions = [], saves = [];
  const h = createHarness({ html: '<video></video><input id="typing"><div id="help"><div><kbd tabindex="0" class="shortcut-key" data-action="CycleAudioTracks">A</kbd></div><div></div></div>',
    JE: { pluginConfig: { DisableAllShortcuts: disabled }, currentSettings: {}, state: { activeShortcuts: { CycleAudioTracks: 'A', CycleSubtitleTracks: 'S', GoToHome: 'H', JumpToPercentage: '' } },
      userConfig: { shortcuts: { Shortcuts: [] } }, t: key => key, saveUserSettings: (...args) => saves.push(args),
      isVideoPage: () => true, cycleAudioTrack: () => actions.push('audio'), cycleSubtitleTrack: () => actions.push('subtitle'),
      showEnhancedPanel: () => actions.push('panel'),
      injectGlobalStyles() {}, addPluginMenuButton() {}, addUserMenuLink() {}, addRandomButton() {}, applySavedStylesWhenReady() {},
      helpers: { createObserver() {}, throttle: fn => fn, onBodyMutation() {} } } });
  t.after(() => h.close());
  loadKeyCombo(h); h.load('enhanced/events.js'); h.load('enhanced/settingspanel/ui-panel-shortcut-editor.js');
  h.JE.internals.enhancedUi.wireShortcutEditor({ help: h.document.getElementById('help'), pluginShortcuts: [{ Name: 'CycleAudioTracks', Key: 'A' }], primaryAccentColor: 'blue', kbdBackground: 'black' });
  const key = h.document.querySelector('kbd');
  const press = (target, name, modifiers = {}) => { const event = new h.window.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...modifiers }); target.dispatchEvent(event); return event; };
  return { ...h, actions, saves, key, press };
}

for (const [key, modifiers] of [['k', {}], ['ArrowLeft', {}], [' ', {}], ['Enter', {}], ['n', { shiftKey: true }]]) {
  test(`shortcut editor rejects reserved player key ${key} ${JSON.stringify(modifiers)}`, t => {
    const h = setup(t); h.key.click(); h.press(h.key, key, modifiers);
    assert.equal(h.JE.state.activeShortcuts.CycleAudioTracks, 'A'); assert.equal(h.saves.length, 0);
    assert.ok(h.key.classList.contains('shake-error'));
  });
}

test('editor rejects conflicts and modifier-only input, disables with Delete and restores with Backspace', t => {
  const h = setup(t); h.key.click(); h.press(h.key, 's'); h.press(h.key, 'Control');
  assert.equal(h.saves.length, 0);
  h.press(h.key, 'Delete'); assert.equal(h.JE.state.activeShortcuts.CycleAudioTracks, '');
  assert.equal(h.JE.userConfig.shortcuts.Shortcuts[0].Key, '');
  h.key.click(); h.press(h.key, 'Backspace');
  assert.equal(h.JE.state.activeShortcuts.CycleAudioTracks, 'A'); assert.equal(h.JE.userConfig.shortcuts.Shortcuts.length, 0);
});

// A page reload rebuilds the bindings from the plugin defaults and the user's saved shortcuts.json.
for (const [label, press, expected] of [['rebinding', 'q', 'Q'], ['disabling', 'Delete', '']]) {
  test(`shortcut ${label} saved by the editor overrides the plugin default after a reload`, t => {
    const h = setup(t); h.key.click(); h.press(h.key, press);
    const [file, saved] = h.saves.at(-1); assert.equal(file, 'shortcuts.json');
    const reloaded = createHarness({ JE: { pluginConfig: { Shortcuts: [{ Name: 'CycleAudioTracks', Key: 'A' }, { Name: 'GoToHome', Key: 'H' }] }, userConfig: { shortcuts: plain(saved) } } });
    t.after(() => reloaded.close());
    reloaded.load('enhanced/config.js'); reloaded.JE.initializeShortcuts();
    assert.equal(reloaded.JE.state.activeShortcuts.CycleAudioTracks, expected);
    assert.equal(reloaded.JE.state.activeShortcuts.GoToHome, 'H', 'bindings the user never changed keep the plugin default');
  });
}

test('actual player capture listener suppresses host defaults and ignores track auto-repeat', t => {
  const h = setup(t); let hostCalls = 0;
  h.document.addEventListener('keydown', () => hostCalls++);
  h.JE.initializeEnhancedScript();
  assert.equal(h.press(h.document.body, 'a').defaultPrevented, true);
  h.press(h.document.body, 'a', { repeat: true });
  assert.deepEqual(h.actions, ['audio']); assert.equal(hostCalls, 0);
  h.document.getElementById('typing').focus(); h.press(h.document.getElementById('typing'), 'a');
  assert.equal(hostCalls, 1); assert.deepEqual(h.actions, ['audio']);
});

test('editor-created combined-modifier shortcut executes through actual playback handler', t => {
  const h = setup(t); h.key.click(); h.press(h.key, 'z', { ctrlKey: true, shiftKey: true });
  assert.equal(h.saves.length, 1);
  h.JE.initializeEnhancedScript(); h.document.body.focus();
  h.press(h.document.body, 'z', { ctrlKey: true, shiftKey: true });
  assert.deepEqual(h.actions, ['audio']);
});

// Admin-typed bindings may list modifiers in any order; they must keep matching the runtime combo.
for (const [stored, key, modifiers] of [['Shift+Ctrl+Z', 'Z', { ctrlKey: true, shiftKey: true }], ['Ctrl+Shift+z', 'Z', { ctrlKey: true, shiftKey: true }],
  ['Shift+Alt+Meta+Ctrl+Q', 'Q', { metaKey: true, ctrlKey: true, altKey: true, shiftKey: true }], ['Ctrl++', '+', { ctrlKey: true }]]) {
  test(`stored shortcut ${stored} matches whatever its modifier order`, t => {
    const h = setup(t); h.JE.state.activeShortcuts.CycleAudioTracks = stored;
    h.JE.initializeEnhancedScript(); h.document.body.focus();
    h.press(h.document.body, key, { ...modifiers, altKey: !modifiers.altKey });
    assert.deepEqual(h.actions, []);
    h.press(h.document.body, key, modifiers);
    assert.deepEqual(h.actions, ['audio']);
  });
}

// The conflict check must see a stored binding the key listener would fire for the same press.
for (const stored of ['Shift+Ctrl+S', 'Ctrl+Shift+s']) {
  test(`shortcut editor rejects a combo that collides with stored ${stored}`, t => {
    const h = setup(t); h.JE.state.activeShortcuts.CycleSubtitleTracks = stored;
    h.key.click(); h.press(h.key, 'S', { ctrlKey: true, shiftKey: true });
    assert.equal(h.JE.state.activeShortcuts.CycleAudioTracks, 'A'); assert.equal(h.saves.length, 0);
    assert.ok(h.key.classList.contains('shake-error'));
  });
}

test('administrator disabling shortcuts leaves panel key available but player bindings inactive', t => {
  const h = setup(t, true); h.JE.initializeEnhancedScript();
  h.press(h.document.body, 'a'); h.press(h.document.body, '?');
  assert.deepEqual(h.actions, ['panel']);
  h.key.click(); h.press(h.key, 'z'); assert.equal(h.saves.length, 0);
});

// Design item A10: focus alone never captures, so keyboard users can Tab through the list.
test('a focused key does not capture: Tab moves on and Escape or ? reach the panel', t => {
  const h = setup(t); let documentKeys = [];
  h.document.addEventListener('keydown', event => documentKeys.push(event.key));
  h.key.focus();
  assert.equal(h.key.hasAttribute('data-listening'), false);
  assert.equal(h.key.textContent, 'A');
  for (const name of ['q', 'Tab', 'Escape', '?']) assert.equal(h.press(h.key, name).defaultPrevented, false);
  assert.deepEqual(documentKeys, ['q', 'Tab', 'Escape', '?']);
  assert.equal(h.JE.state.activeShortcuts.CycleAudioTracks, 'A'); assert.equal(h.saves.length, 0);
});

test('Enter starts capturing, Escape cancels without closing the panel, Tab leaves the capture', t => {
  const h = setup(t); let documentKeys = [];
  h.document.addEventListener('keydown', event => documentKeys.push(event.key));
  h.key.focus();
  assert.equal(h.press(h.key, 'Enter').defaultPrevented, true);
  assert.equal(h.key.hasAttribute('data-listening'), true);
  assert.equal(h.key.textContent, 'panel_shortcuts_listening');
  assert.equal(h.press(h.key, 'Escape').defaultPrevented, true);
  assert.equal(h.key.hasAttribute('data-listening'), false);
  assert.equal(h.key.textContent, 'A');
  assert.deepEqual(documentKeys, [], 'Enter and Escape stayed in the editor');
  assert.equal(h.document.activeElement, h.key, 'focus stays on the key');

  h.press(h.key, 'Enter');
  const tab = h.press(h.key, 'Tab');
  assert.equal(tab.defaultPrevented, false, 'the browser moves focus as usual');
  assert.deepEqual(documentKeys, ['Tab'], 'the focus trap still sees Tab');
  assert.equal(h.key.hasAttribute('data-listening'), false);
  assert.equal(h.JE.state.activeShortcuts.CycleAudioTracks, 'A'); assert.equal(h.saves.length, 0);
});

test('after a capture the key keeps focus and stops listening', t => {
  const h = setup(t);
  h.key.click(); h.press(h.key, 'q');
  assert.equal(h.JE.state.activeShortcuts.CycleAudioTracks, 'Q');
  assert.equal(h.key.textContent, 'Q');
  assert.equal(h.key.hasAttribute('data-listening'), false);
  assert.equal(h.document.activeElement, h.key);
  h.press(h.key, 'w');
  assert.equal(h.JE.state.activeShortcuts.CycleAudioTracks, 'Q', 'the next key is not captured without Enter or a click');
  assert.equal(h.saves.length, 1);
  assert.equal(h.saves[0][2].notifyOnError, true, 'a failed save is reported');
});
