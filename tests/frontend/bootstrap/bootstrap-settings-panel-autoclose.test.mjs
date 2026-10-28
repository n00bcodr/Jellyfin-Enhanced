// The settings panel's idle auto-close is for a pointer that left it. A panel opened from the keyboard, a remote or a
// screen reader, or one that takes a key or the focus while open, stays open until it is closed: a reader can read
// without sending any further event, and moving the pointer afterwards does not turn the timer back on.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHarness, jsRoot, loadKeyCombo } from '../helpers/harness.mjs';

const en = JSON.parse(readFileSync(resolve(jsRoot, 'locales/en.json'), 'utf8'));
const tr = (key, params) => {
  let text = key in en ? en[key] : key;
  for (const [k, v] of Object.entries(params || {})) text = text.replace(`{${k}}`, v);
  return text;
};
const tick = () => new Promise(r => setImmediate(r));
async function settle(n = 20) { for (let i = 0; i < n; i++) await tick(); }
const preset = { name: 'p', previewText: 'Aa', size: 1, family: 'sans-serif', bgColor: '#000', textColor: '#fff' };
const escapeHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** The real panel (template, settings store, ui-panel.js) over a page with an opener button. */
function panelPage(t, fetch) {
  const h = createHarness({
    html: '<div class="page mainAnimatedPage"><button id="opener">Enhanced Panel</button></div>',
    JE: {
      pluginConfig: { Shortcuts: [] }, userConfig: { settings: {}, shortcuts: { Shortcuts: [] }, bookmark: { bookmarks: {} } }, currentSettings: {},
      t: tr, toast() {}, escapeHtml, icon: () => '', IconName: new Proxy({}, { get: (_, k) => String(k) }),
      icons: { wrapEmoji: s => s }, state: { activeShortcuts: {} }, pluginVersion: '0.0.0',
      themer: { getThemeVariables: () => ({}) },
      fontSizePresets: [preset, preset, preset, preset], fontFamilyPresets: [preset], subtitlePresets: [preset], subtitleTextEffectPresets: [preset],
      decodeSubtitleColor: () => ({ swatch: '#FFFFFF', alpha: 255, alphaValue: 255 }), getSubtitleTextShadow: () => 'none',
    },
    apiClient: { ajax: async () => ({}) },
    fetch,
  });
  t.after(() => h.close());
  // A desktop-width window (jsdom has no media queries).
  h.window.matchMedia = media => ({ matches: false, media, addEventListener() {}, removeEventListener() {} });
  for (const m of ['core/navigation.js', 'core/session.js', 'enhanced/translations.js', 'enhanced/config.js']) h.load(m);
  h.JE.currentSettings = h.JE.loadSettings();
  h.load('enhanced/settingspanel/ui-panel-template.js');
  h.load('enhanced/settingspanel/ui-panel.js');
  // The sections' own wiring is other tests' (bootstrap-settings-*): here only the panel's lifetime matters.
  const internal = h.JE.internals.enhancedUi;
  for (const name of ['wireShortcutEditor', 'wireSettingsListeners', 'wireHiddenContentListeners', 'wireMiscSettingsControls', 'wireLanguageControls']) internal[name] = () => {};
  const opener = h.document.getElementById('opener');
  opener.addEventListener('click', e => { h.JE.showEnhancedPanel(e); });
  // The panel reads performance.now() to tell a press's own focus from focus that comes later: tests move it on.
  let skew = 0;
  const realNow = h.window.performance.now.bind(h.window.performance);
  Object.defineProperty(h.window.performance, 'now', { configurable: true, value: () => realNow() + skew });
  const advance = ms => { skew += ms; };
  const panel = () => h.document.getElementById('jellyfin-enhanced-panel');
  const key = (target, name, init = {}) => target.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...init }));
  const mouse = (target, type, init = {}) => target.dispatchEvent(new h.window.MouseEvent(type, { bubbles: true, cancelable: true, ...init }));
  return { ...h, opener, panel, key, mouse, advance };
}

/** Clicks the opener with a pointer (detail 1) and waits for the panel. */
async function openWithPointer(h) {
  h.mouse(h.opener, 'click', { detail: 1 });
  await settle();
  const panel = h.panel();
  assert.ok(panel, 'the panel opened');
  return panel;
}

/**
 * Captures the panel's 15-second auto-close timers. `expire()` runs every pending one at its deadline (none when the
 * panel has turned auto-close off) and returns how many ran; `pending()` counts them.
 */
function capturePanelTimer(h) {
  const nativeSet = h.window.setTimeout.bind(h.window);
  const nativeClear = h.window.clearTimeout.bind(h.window);
  const timers = new Map();
  h.window.setTimeout = (callback, ms, ...args) => {
    const id = nativeSet(callback, ms, ...args);
    if (ms === 15000) timers.set(id, callback);
    return id;
  };
  h.window.clearTimeout = id => { timers.delete(id); nativeClear(id); };
  const expire = () => {
    const due = [...timers];
    for (const [id, callback] of due) { nativeClear(id); timers.delete(id); callback(); }
    return due.length;
  };
  expire.pending = () => timers.size;
  return expire;
}
/** Lets the panel's opening settle (its own opening focus is not keyboard use). */
const later = (h, ms = 5) => new Promise(r => h.window.setTimeout(r, ms));

test('control: a panel opened with the pointer that never takes a key or the focus still closes at its deadline', async t => {
  const h = panelPage(t), expire = capturePanelTimer(h);
  await openWithPointer(h); await later(h);
  assert.equal(expire(), 1, 'its auto-close was pending');
  await settle();
  assert.equal(h.panel(), null);
});

test('a panel opened from the keyboard stays open for a reader that sends no further event', async t => {
  const h = panelPage(t), expire = capturePanelTimer(h);
  await h.JE.showEnhancedPanel(new h.window.KeyboardEvent('keydown', { key: '?' }));
  assert.ok(h.panel());
  await later(h);
  assert.equal(expire.pending(), 0, 'no deadline is armed');
  h.panel().dispatchEvent(new h.window.MouseEvent('mouseleave'));
  assert.equal(expire(), 0);
  assert.ok(h.panel(), 'the panel stays while its reader reads');
});

for (const [label, open] of [
  ['a link activated with Enter (a click with no pointer)', h => h.mouse(h.opener, 'click', { detail: 0 })],
  ['a programmatic call', h => h.JE.showEnhancedPanel()],
]) test(`a panel opened by ${label} does not auto-close`, async t => {
  const h = panelPage(t), expire = capturePanelTimer(h);
  open(h); await settle(); await later(h);
  assert.ok(h.panel());
  assert.equal(expire(), 0);
  assert.ok(h.panel());
});

test('keyboard use inside the panel turns auto-close off for that open; moving the pointer does not turn it back on', async t => {
  const h = panelPage(t), expire = capturePanelTimer(h);
  const panel = await openWithPointer(h); await later(h);
  h.key(panel.querySelector('#jePanelSearch'), 'ArrowDown');
  assert.equal(expire.pending(), 0, 'the deadline is cleared');
  h.mouse(h.document, 'mousemove');
  panel.dispatchEvent(new h.window.MouseEvent('mouseleave'));
  h.mouse(panel, 'click', { detail: 1 });
  assert.equal(expire(), 0, 'no deadline is armed again');
  assert.ok(h.panel(), 'still open after the pointer moved, clicked and left');
});

test('focus arriving inside the panel (Tab, a screen reader) turns auto-close off', async t => {
  const h = panelPage(t), expire = capturePanelTimer(h);
  const panel = await openWithPointer(h); await later(h);
  panel.querySelector('#closeSettingsPanel').focus();
  h.mouse(h.document, 'mousemove');
  panel.dispatchEvent(new h.window.MouseEvent('mouseleave'));
  assert.equal(expire(), 0);
  assert.ok(h.panel());
});

/** A pointer press on a control the way a browser delivers it: the focus comes between the press and the release. */
function pressWithPointer(h, control) {
  h.mouse(control, 'pointerdown'); h.mouse(control, 'mousedown');
  control.focus();
  h.mouse(control, 'pointerup'); h.mouse(control, 'mouseup'); h.mouse(control, 'click', { detail: 1 });
}

for (const [label, selector] of [['a toggle', 'input[type="checkbox"]'], ['the search box', '#jePanelSearch']]) {
  test(`control: a mouse click that focuses ${label} keeps the auto-close`, async t => {
    const h = panelPage(t), expire = capturePanelTimer(h);
    const panel = await openWithPointer(h); await later(h);
    const control = panel.querySelector(selector);
    pressWithPointer(h, control);
    assert.equal(h.document.activeElement, control);
    await later(h);
    panel.dispatchEvent(new h.window.MouseEvent('mouseleave'));
    assert.equal(expire(), 1, 'the deadline is still armed');
    await settle();
    assert.equal(h.panel(), null);
  });
}

test('a finished pointer press does not hide focus that arrives later without one', async t => {
  const h = panelPage(t), expire = capturePanelTimer(h);
  const panel = await openWithPointer(h); await later(h);
  pressWithPointer(h, panel.querySelector('input[type="checkbox"]'));
  // Later than the press's own focus window (time-based since the press is no longer held as state).
  await later(h); h.advance(1000);
  panel.querySelector('#closeSettingsPanel').focus();
  panel.dispatchEvent(new h.window.MouseEvent('mouseleave'));
  assert.equal(expire(), 0);
  assert.ok(h.panel());
});

const nextFrame = h => new Promise(r => h.window.requestAnimationFrame(() => r()));

for (const [label, interrupt] of [
  ['the window loses focus', h => h.window.dispatchEvent(new h.window.Event('blur'))],
  ['the page is hidden', h => {
    Object.defineProperty(h.document, 'hidden', { configurable: true, value: true });
    h.document.dispatchEvent(new h.window.Event('visibilitychange'));
  }],
]) test(`a press interrupted when ${label} (no release) does not hide focus that arrives later`, async t => {
  const h = panelPage(t), expire = capturePanelTimer(h);
  const panel = await openWithPointer(h); await later(h);
  const toggle = panel.querySelector('input[type="checkbox"]');
  h.mouse(toggle, 'pointerdown'); h.mouse(toggle, 'mousedown'); toggle.focus();
  interrupt(h);
  // Later than the press's own focus window (time-based since the press is no longer held as state).
  await later(h); h.advance(1000);
  panel.querySelector('#closeSettingsPanel').focus();
  h.mouse(h.document, 'mousemove');
  panel.dispatchEvent(new h.window.MouseEvent('mouseleave'));
  assert.equal(expire(), 0, 'independent focus disarms the deadline after the interruption');
  assert.ok(h.panel());
});

test('a press that focuses nothing and is never released does not hide focus that arrives later', async t => {
  const h = panelPage(t), expire = capturePanelTimer(h);
  const panel = await openWithPointer(h); await later(h);
  h.mouse(panel, 'pointerdown'); h.mouse(panel, 'mousedown');
  // Later than the press's own focus window (time-based since the press is no longer held as state).
  await nextFrame(h); await later(h); h.advance(1000);
  panel.querySelector('#closeSettingsPanel').focus();
  panel.dispatchEvent(new h.window.MouseEvent('mouseleave'));
  assert.equal(expire(), 0);
  assert.ok(h.panel());
});

test('control: a click on a toggle\'s label held past a frame keeps the auto-close (its focus comes at the click)', async t => {
  const h = panelPage(t), expire = capturePanelTimer(h);
  const panel = await openWithPointer(h); await later(h);
  const toggle = panel.querySelector('label input[type="checkbox"]');
  const label = toggle.closest('label');
  h.mouse(label, 'pointerdown'); h.mouse(label, 'mousedown');
  await nextFrame(h); await later(h, 20);
  h.mouse(label, 'pointerup'); h.mouse(label, 'mouseup'); toggle.focus(); h.mouse(label, 'click', { detail: 1 });
  assert.equal(h.document.activeElement, toggle);
  await later(h);
  panel.dispatchEvent(new h.window.MouseEvent('mouseleave'));
  assert.equal(expire(), 1, 'the deadline is still armed');
  await settle();
  assert.equal(h.panel(), null);
});

test('a label press whose release was lost outside the window does not hide focus that arrives later', async t => {
  const h = panelPage(t), expire = capturePanelTimer(h);
  const panel = await openWithPointer(h); await later(h);
  const label = panel.querySelector('label input[type="checkbox"]').closest('label');
  h.mouse(label, 'pointerdown', { buttons: 1 }); h.mouse(label, 'mousedown', { buttons: 1 });
  await nextFrame(h); await later(h, 20);
  // Released outside the window: no up event and no window blur reach the page; the pointer comes back unpressed.
  h.advance(1000);
  h.mouse(h.document, 'mousemove', { buttons: 0 }); await nextFrame(h);
  panel.querySelector('#closeSettingsPanel').focus();
  panel.dispatchEvent(new h.window.MouseEvent('mouseleave'));
  assert.equal(expire(), 0, 'the released label does not hide later independent focus');
  assert.ok(h.panel());
});

test('control: a label click made while an earlier press on the panel is still down keeps the auto-close', async t => {
  const h = panelPage(t), expire = capturePanelTimer(h);
  const panel = await openWithPointer(h); await later(h);
  const toggle = panel.querySelector('label input[type="checkbox"]');
  const label = toggle.closest('label');
  h.mouse(panel, 'pointerdown', { pointerId: 1 }); h.mouse(panel, 'mousedown', { button: 2 });
  h.mouse(label, 'pointerdown', { pointerId: 2 }); h.mouse(label, 'mousedown', { button: 0 });
  await nextFrame(h); await later(h, 20);
  h.mouse(label, 'pointerup', { pointerId: 2 }); toggle.focus(); h.mouse(label, 'click', { detail: 1 });
  h.mouse(h.window, 'pointerup', { pointerId: 1 }); await later(h);
  panel.dispatchEvent(new h.window.MouseEvent('mouseleave'));
  assert.equal(expire(), 1, 'a label click made by overlapping pointers keeps pointer auto-close');
  await settle();
  assert.equal(h.panel(), null);
});

/** Counts the listeners the panel adds to the window and the document and has not removed (the shortcut key listener is the host's). */
function trackOutsideListeners(h) {
  const live = [];
  for (const target of [h.window, h.document]) {
    const add = target.addEventListener.bind(target), remove = target.removeEventListener.bind(target);
    const capture = opts => typeof opts === 'boolean' ? opts : !!opts?.capture;
    target.addEventListener = (type, fn, opts) => {
      if (fn && fn !== h.JE.keyListener && !live.some(x => x.target === target && x.type === type && x.fn === fn && x.capture === capture(opts))) {
        live.push({ target, type, fn, capture: capture(opts) });
      }
      return add(type, fn, opts);
    };
    target.removeEventListener = (type, fn, opts) => {
      const i = live.findIndex(x => x.target === target && x.type === type && x.fn === fn && x.capture === capture(opts));
      if (i >= 0) live.splice(i, 1);
      return remove(type, fn, opts);
    };
  }
  return () => live.map(x => `${x.target === h.window ? 'window' : 'document'}:${x.type}`);
}

for (const mode of ['close button', 'Escape', '?', 'auto-close', 'opener toggle']) {
  test(`20 panels closed by ${mode} leave no listeners on the window or the document`, async t => {
    const h = panelPage(t), expire = capturePanelTimer(h), remaining = trackOutsideListeners(h);
    const cycle = async () => {
      const panel = await openWithPointer(h); await later(h);
      if (mode === 'close button') h.mouse(panel.querySelector('#closeSettingsPanel'), 'click');
      else if (mode === 'Escape') h.key(h.document.body, 'Escape');
      else if (mode === '?') h.key(h.document.body, '?');
      else if (mode === 'auto-close') expire();
      else await h.JE.showEnhancedPanel(new h.window.MouseEvent('click', { detail: 1 }));
      assert.equal(h.panel(), null);
    };
    // One cycle first: jsdom's selector engine adds its own document listeners on first use.
    await cycle();
    const baseline = remaining();
    for (let i = 0; i < 20; i++) await cycle();
    assert.deepEqual(remaining(), baseline);
  });
}

test('a Shift+Tab right after dragging the panel turns auto-close off even when a control stops the key', async t => {
  const h = panelPage(t), expire = capturePanelTimer(h);
  const panel = await openWithPointer(h); await later(h);
  const close = panel.querySelector('#closeSettingsPanel');
  close.addEventListener('keydown', e => e.stopPropagation());
  h.mouse(panel.querySelector('.panel-header'), 'mousedown', { clientX: 10, clientY: 10 });
  h.mouse(h.document, 'mousemove', { clientX: 100, clientY: 100 });
  h.mouse(h.document, 'mouseup');
  panel.dispatchEvent(new h.window.MouseEvent('mouseleave'));
  assert.equal(expire.pending(), 1, 'the drag left a deadline armed');
  h.key(close, 'Tab', { shiftKey: true });
  assert.equal(expire(), 0);
  assert.ok(h.panel(), 'keyboard navigation right after a drag keeps it open');
});

test('after keyboard use the deadline does not close the panel under the release notes it opened', async t => {
  const fetch = async () => ({ ok: true, json: async () => ({ body: 'Notes', tag_name: 'v1', published_at: '2026-01-01', html_url: 'https://example.test/release' }) });
  const h = panelPage(t, fetch), expire = capturePanelTimer(h);
  const panel = await openWithPointer(h); await later(h);
  h.load('enhanced/settingspanel/ui-release-notes.js');
  const notesButton = panel.querySelector('#releaseNotesBtn');
  notesButton.focus();
  h.key(notesButton, 'Enter');
  await h.JE.internals.enhancedUi.showReleaseNotesNotification();
  const notes = h.document.getElementById('jellyfin-release-notes-notification');
  assert.ok(notes, 'the release notes opened');
  panel.dispatchEvent(new h.window.MouseEvent('mouseleave'));
  h.mouse(notes, 'mousemove');
  for (let i = 0; i < 5; i++) expire();
  await settle();
  assert.ok(h.panel(), 'the settings panel stays under its release notes');
});

test('the explicit close still closes a keyboard-opened panel', async t => {
  const h = panelPage(t), expire = capturePanelTimer(h);
  await h.JE.showEnhancedPanel(new h.window.KeyboardEvent('keydown', { key: '?' }));
  h.mouse(h.panel().querySelector('#closeSettingsPanel'), 'click', { detail: 1 });
  assert.equal(h.panel(), null);
  assert.equal(expire.pending(), 0);
});

test('every entry point hands the panel the event that opened it', async t => {
  const opened = [];
  const h = createHarness({
    html: '<div class="mainDrawer"></div>'
      + '<div class="videoOsdBottom"><div class="buttons focuscontainer-x"><button class="btnVideoOsdSettings"></button></div></div>'
      + '<div id="app-user-menu"><a href="#/mypreferencesmenu"><svg></svg><span class="MuiListItemText-primary">Settings</span></a></div>'
      + '<div id="myPreferencesMenuPage"><div class="verticalSection"></div></div>',
    JE: {
      pluginConfig: { DisableAllShortcuts: true }, currentSettings: {}, state: { activeShortcuts: {} }, t: key => key,
      showEnhancedPanel: e => opened.push(e),
      injectGlobalStyles() {}, addUserMenuLink() {}, addRandomButton() {}, applySavedStylesWhenReady() {},
      helpers: { createObserver() {}, throttle: fn => fn, debounce: fn => fn, onBodyMutation: (_, fn) => fn([]),
        getSidebarContainer: () => h.document.querySelector('.mainDrawer') },
    },
  });
  t.after(() => h.close());
  loadKeyCombo(h); h.load('enhanced/events.js'); h.load('enhanced/settingspanel/ui-entry-points.js');
  const addPluginMenuButton = h.JE.addPluginMenuButton;
  h.JE.addPluginMenuButton = () => {};
  h.JE.initializeEnhancedScript();
  addPluginMenuButton(); h.JE.addOsdSettingsButton(); h.JE.addUserMenuLink(); h.JE.addUserPreferencesLink();
  const presses = [];
  const keyPress = new h.window.KeyboardEvent('keydown', { key: '?', bubbles: true, cancelable: true });
  h.document.body.dispatchEvent(keyPress); presses.push(keyPress);
  for (const id of ['jellyfinEnhancedSettingsLink', 'enhancedSettingsBtn', 'jellyfinEnhancedUserMenuLink', 'jellyfinEnhancedUserPrefsLink']) {
    const click = new h.window.MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 });
    h.document.getElementById(id).dispatchEvent(click); presses.push(click);
  }
  assert.equal(opened.length, 5);
  opened.forEach((event, i) => assert.equal(event, presses[i], `entry ${i} passes its event`));
});
