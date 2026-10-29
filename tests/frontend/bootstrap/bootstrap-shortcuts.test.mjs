import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, loadKeyCombo, plain } from '../helpers/harness.mjs';

/** The settings store's shortcuts.json, as the editor uses it: an operation changes the document and its published view. */
function shortcutStore(saves) {
  const store = { document: { Shortcuts: [] } };
  store.patch = (file, op) => {
    saves.push([file, plain(op)]);
    const list = store.document.Shortcuts.filter(s => !(op.remove || []).includes(s.Name));
    for (const [name, record] of Object.entries(op.upsert || {})) {
      const index = list.findIndex(s => s.Name === name);
      if (index >= 0) list[index] = { ...record, Name: name }; else list.push({ ...record, Name: name });
    }
    store.document = { Shortcuts: list };
    store.view.Shortcuts = plain(list);
    return Promise.resolve();
  };
  return store;
}

function setup(t, disabled = false) {
  const actions = [], saves = [];
  const store = shortcutStore(saves);
  const h = createHarness({ html: '<video></video><input id="typing"><div id="help"><div><kbd tabindex="0" class="shortcut-key" data-action="CycleAudioTracks">A</kbd></div><div></div></div>',
    JE: { pluginConfig: { DisableAllShortcuts: disabled }, currentSettings: {}, state: { activeShortcuts: { CycleAudioTracks: 'A', CycleSubtitleTracks: 'S', GoToHome: 'H', JumpToPercentage: '' } },
      userConfig: { shortcuts: { Shortcuts: [] } }, t: key => key, patchUserSettings: (...args) => store.patch(...args),
      internals: { userDocument: () => ({ document: plain(store.document), read: true }) },
      isVideoPage: () => true, cycleAudioTrack: () => actions.push('audio'), cycleSubtitleTrack: () => actions.push('subtitle'),
      showEnhancedPanel: () => actions.push('panel'),
      injectGlobalStyles() {}, addPluginMenuButton() {}, addUserMenuLink() {}, addRandomButton() {}, applySavedStylesWhenReady() {},
      helpers: { createObserver() {}, throttle: fn => fn, onBodyMutation() {} } } });
  t.after(() => h.close());
  store.view = h.JE.userConfig.shortcuts;
  // Stage 1 fix round 12: the editor's saves carry the origin of the key press (JE.core.userWrite).
  h.load('core/mutation-queue.js');
  loadKeyCombo(h); h.load('enhanced/events.js'); h.load('enhanced/settingspanel/ui-panel-shortcut-editor.js');
  h.JE.internals.enhancedUi.wireShortcutEditor({ help: h.document.getElementById('help'), pluginShortcuts: [{ Name: 'CycleAudioTracks', Key: 'A' }], primaryAccentColor: 'blue', kbdBackground: 'black' });
  const key = h.document.querySelector('kbd');
  const press = (target, name, modifiers = {}) => { const event = new h.window.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...modifiers }); target.dispatchEvent(event); return event; };
  return { ...h, get NATIVE() { return h.NATIVE; }, actions, saves, store, key, press };
}

for (const [key, modifiers] of [['k', {}], ['ArrowLeft', {}], [' ', {}], ['Enter', {}], ['n', { shiftKey: true }]]) {
  test(`shortcut editor rejects reserved player key ${key} ${JSON.stringify(modifiers)}`, t => {
    const h = setup(t); h.key.focus(); h.press(h.key, key, modifiers);
    assert.equal(h.JE.state.activeShortcuts.CycleAudioTracks, 'A'); assert.equal(h.saves.length, 0);
    assert.ok(h.key.classList.contains('shake-error'));
  });
}

// Phase 2 UX-13: the panel keeps keyboard focus inside it, so a keyboard user tabs through the key list. Focusing a key
// starts listening; Tab must move on and Escape must reach the panel instead of being saved as the shortcut.
for (const [key, modifiers] of [['Tab', {}], ['Tab', { shiftKey: true }], ['Escape', {}]]) {
  test(`UX-13: ${modifiers.shiftKey ? 'Shift+' : ''}${key} on a listening key passes on and records nothing`, t => {
    const h = setup(t); h.key.focus();
    const event = h.press(h.key, key, modifiers);
    assert.equal(event.defaultPrevented, false, 'the browser (or the panel) gets the key');
    assert.equal(h.JE.state.activeShortcuts.CycleAudioTracks, 'A');
    assert.equal(h.saves.length, 0);
  });
}

test('editor rejects conflicts and modifier-only input, disables with Delete and restores with Backspace', t => {
  const h = setup(t); h.key.focus(); h.press(h.key, 's'); h.press(h.key, 'Control');
  assert.equal(h.saves.length, 0);
  h.press(h.key, 'Delete'); assert.equal(h.JE.state.activeShortcuts.CycleAudioTracks, '');
  assert.equal(h.JE.userConfig.shortcuts.Shortcuts[0].Key, '');
  h.key.focus(); h.press(h.key, 'Backspace');
  assert.equal(h.JE.state.activeShortcuts.CycleAudioTracks, 'A'); assert.equal(h.JE.userConfig.shortcuts.Shortcuts.length, 0);
});

// A page reload rebuilds the bindings from the plugin defaults and the user's saved shortcuts.json.
for (const [label, press, expected] of [['rebinding', 'q', 'Q'], ['disabling', 'Delete', '']]) {
  test(`shortcut ${label} saved by the editor overrides the plugin default after a reload`, t => {
    const h = setup(t); h.key.focus(); h.press(h.key, press);
    const [file] = h.saves.at(-1); assert.equal(file, 'shortcuts.json');
    const reloaded = createHarness({ JE: { pluginConfig: { Shortcuts: [{ Name: 'CycleAudioTracks', Key: 'A' }, { Name: 'GoToHome', Key: 'H' }] }, userConfig: { shortcuts: plain(h.store.document) } } });
    t.after(() => reloaded.close());
    reloaded.load('core/mutation-queue.js'); reloaded.load('enhanced/config.js'); reloaded.JE.initializeShortcuts();
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
  const h = setup(t); h.key.focus(); h.press(h.key, 'z', { ctrlKey: true, shiftKey: true });
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
    h.key.focus(); h.press(h.key, 'S', { ctrlKey: true, shiftKey: true });
    assert.equal(h.JE.state.activeShortcuts.CycleAudioTracks, 'A'); assert.equal(h.saves.length, 0);
    assert.ok(h.key.classList.contains('shake-error'));
  });
}

test('administrator disabling shortcuts leaves panel key available but player bindings inactive', t => {
  const h = setup(t, true); h.JE.initializeEnhancedScript();
  h.press(h.document.body, 'a'); h.press(h.document.body, '?');
  assert.deepEqual(h.actions, ['panel']);
  h.key.focus(); h.press(h.key, 'z'); assert.equal(h.saves.length, 0);
});

// Phase 2 F53: while a JE window is open (the More sheet, a request sheet, a dialog: a modal surface on the one stack),
// JE's own keyboard shortcuts do nothing, so a key pressed inside it never acts on the page behind it. A popup (not
// modal) doesn't stop them; once the window closes they work again.
const viewerKey = (h, target, key) => h.trusted(target, new h.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
test('F53: JE shortcuts (global, player and the panel key) do nothing while a JE modal window is open', async t => {
  const h = setup(t); h.JE.initializeEnhancedScript();
  const opener = h.document.createElement('button'); opener.textContent = 'More'; h.document.body.append(opener);
  const sheet = h.document.createElement('div'); sheet.innerHTML = '<h2>More</h2><button id="inside">Hide</button>';
  let release = null;
  h.pressIn(opener, e => { release = h.JE.openSurface(sheet, () => sheet.remove(), h.JE.ownerOf(e)); });
  h.document.body.append(sheet);
  await new Promise(r => setImmediate(r));
  assert.ok(release, 'the window is on the surface stack');
  const before = h.window.location.hash;
  const inside = sheet.querySelector('#inside');
  inside.focus();
  viewerKey(h, inside, 'H'); viewerKey(h, inside, 'a'); viewerKey(h, inside, '?');
  assert.equal(h.window.location.hash, before, 'Go home did not run behind the window');
  assert.deepEqual(h.actions, [], 'no player shortcut and no settings panel');
  release();
  h.document.body.focus();
  viewerKey(h, h.document.body, 'a');
  assert.deepEqual(h.actions, ['audio'], 'shortcuts work again once it closed');
});

test('F53 control: a JE popup (not modal) leaves the shortcuts on', async t => {
  const h = setup(t); h.JE.initializeEnhancedScript();
  const opener = h.document.createElement('button'); h.document.body.append(opener);
  const popup = h.document.createElement('div'); popup.innerHTML = '<button>One</button>';
  h.pressIn(opener, e => { h.JE.openSurface(popup, () => popup.remove(), h.JE.ownerOf(e), { modal: false }); });
  h.document.body.append(popup);
  await new Promise(r => setImmediate(r));
  h.document.body.focus();
  viewerKey(h, h.document.body, 'a');
  assert.deepEqual(h.actions, ['audio']);
});

// F53's helper (not a behavioural regression: the tests above are): true only while a modal JE surface is open.
test('F53 helper: JE.hasModalSurface follows the stack (modal yes, popup no, released no)', async t => {
  const h = setup(t);
  const opener = h.document.createElement('button'); h.document.body.append(opener);
  const sheet = h.document.createElement('div'); sheet.innerHTML = '<button>In</button>';
  let release = null;
  h.pressIn(opener, e => { release = h.JE.openSurface(sheet, () => sheet.remove(), h.JE.ownerOf(e)); });
  h.document.body.append(sheet);
  await new Promise(r => setImmediate(r));
  assert.equal(h.JE.hasModalSurface(), true);
  release();
  assert.equal(h.JE.hasModalSurface(), false);
  const popup = h.document.createElement('div');
  h.pressIn(opener, e => { h.JE.openSurface(popup, () => popup.remove(), h.JE.ownerOf(e), { modal: false }); });
  h.document.body.append(popup);
  await new Promise(r => setImmediate(r));
  assert.equal(h.JE.hasModalSurface(), false);
});
