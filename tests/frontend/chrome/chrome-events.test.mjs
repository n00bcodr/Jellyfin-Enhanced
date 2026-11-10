// Core event wiring (enhanced/events.js): shortcuts, long press, visibility, remove context.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, loadKeyCombo } from '../helpers/harness.mjs';
import { chromeJs } from './helpers.mjs';

function events(t, { settings = {}, config = {}, video = true } = {}) {
  const calls = [];
  const record = name => (...args) => calls.push([name, ...args]);
  const h = createHarness({ html: `${video ? '<video></video>' : ''}<div class="card" data-id="item-1"><button data-action="menu"></button></div><input id="typing">`,
    JE: { pluginConfig: config, currentSettings: settings, state: { activeShortcuts: { GoToHome: 'H', CycleAudioTracks: 'A', JumpToPercentage: '5' } },
      t: key => key, toast: record('toast'), isVideoPage: () => true, showEnhancedPanel: record('panel'), cycleAudioTrack: record('audio'),
      jumpToPercentage: record('jump'), attachSeekTracker: record('seek'), detectCardSurface: () => 'Continue Watching',
      addRemoveButton: record('remove'), handleLongPressDown: record('down'), handleLongPressUp: record('up'),
      injectGlobalStyles: record('styles'), addPluginMenuButton() {}, addUserMenuLink() {}, addRandomButton() {}, applySavedStylesWhenReady() {},
      helpers: { createObserver() {}, throttle: fn => fn, onBodyMutation: (id, callback) => { if (id === 'action-sheets') calls.sheet = callback; } } } });
  t.after(() => h.close());
  // jsdom cannot create trusted events and the gesture listeners ignore untrusted ones,
  // so record the document listeners the module installs and call them with a trusted-shaped event.
  const listeners = [];
  const add = h.document.addEventListener.bind(h.document);
  h.document.addEventListener = (type, fn, options) => { listeners.push([type, fn]); return add(type, fn, options); };
  loadKeyCombo(h); h.load(chromeJs('enhanced/events.js'));
  const key = (name, init = {}, target = h.document.body) => { const e = new h.window.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...init }); target.dispatchEvent(e); return e; };
  const mouse = type => { const event = { type, isTrusted: true, button: 0, target: h.document.querySelector('video') }; for (const [name, fn] of listeners) if (name === type) fn(event); };
  return { ...h, calls, key, mouse, names: () => calls.map(([name]) => name) };
}

test('events: public facades keep stable identities and canonical shortcut matching', t => {
  const h = events(t);
  const listener = h.JE.keyListener;
  assert.equal(h.JE.internals.canonicalCombo('shift+ctrl+s'), 'shift+ctrl+s');
  assert.equal(h.JE.internals.canonicalCombo('Shift+Ctrl+s'), 'Ctrl+Shift+S');
  assert.equal(h.JE.internals.canonicalCombo(''), '');
  assert.equal(h.JE.internals.canonicalCombo(null), null);
  h.JE.initializeEnhancedScript();
  assert.equal(h.JE.keyListener, listener, 'ui-panel.js removes/re-adds this exact listener');
});

test('events: global and player shortcuts, typing guard, digits and the panel key', t => {
  const h = events(t);
  h.JE.initializeEnhancedScript();
  assert.equal(h.key('h').defaultPrevented, true);
  assert.equal(h.window.location.hash, '#/home.html');
  h.key('a'); h.key('7'); h.key('7', { ctrlKey: true });
  h.key('?');
  const typing = h.document.getElementById('typing'); typing.focus();
  h.key('a', {}, typing);
  assert.deepEqual(h.names(), ['styles', 'toast', 'audio', 'jump', 'panel']);
  assert.deepEqual(h.calls.find(([name]) => name === 'jump'), ['jump', 70]);
});

test('events: Remove context is captured from the card menu only while the feature is enabled', t => {
  const h = events(t, { settings: { removeContinueWatchingEnabled: false } });
  h.JE.initializeEnhancedScript();
  const menu = h.document.querySelector('button[data-action="menu"]');
  menu.dispatchEvent(new h.window.MouseEvent('mousedown', { bubbles: true }));
  assert.equal(h.JE.state.removeContext, undefined);
  h.JE.currentSettings.removeContinueWatchingEnabled = true;
  menu.dispatchEvent(new h.window.MouseEvent('mousedown', { bubbles: true }));
  assert.equal(h.JE.state.removeContext.itemId, 'item-1');
  assert.equal(h.JE.state.removeContext.surface, 'Continue Watching');
});

// CHR-EVENTS-1: long-press listeners were installed only if the boot user had it enabled.
test('CHR-EVENTS-1 events: long press follows the signed-in user\'s current setting and live handlers', t => {
  const h = events(t, { settings: { longPress2xEnabled: false } });
  h.JE.initializeEnhancedScript();
  h.JE.currentSettings.longPress2xEnabled = true; // next user / settings panel toggle
  const replaced = [];
  h.JE.handleLongPressDown = () => replaced.push('down');
  h.mouse('mousedown');
  assert.deepEqual(replaced, ['down']);
});

// CHR-EVENTS-2: repeated initialization duplicated every listener.
test('CHR-EVENTS-2 events: repeated initialization does not duplicate gesture or visibility handling', t => {
  const h = events(t, { settings: { longPress2xEnabled: true, autoPipEnabled: true } });
  Object.defineProperty(h.document, 'pictureInPictureEnabled', { configurable: true, value: true });
  let hidden = false; Object.defineProperty(h.document, 'hidden', { configurable: true, get: () => hidden });
  const video = h.document.querySelector('video');
  Object.defineProperty(video, 'readyState', { value: 4 });
  let pip = 0; video.requestPictureInPicture = () => { pip++; return new Promise(() => {}); };
  h.JE.initializeEnhancedScript(); h.JE.initializeEnhancedScript();
  h.mouse('mousedown');
  assert.equal(h.names().filter(name => name === 'down').length, 1);
  hidden = true; h.document.dispatchEvent(new h.window.Event('visibilitychange'));
  assert.equal(pip, 1);
});

// CHR-EVENTS-3: blocked storage aborted the whole initialization.
test('CHR-EVENTS-3 events: blocked local storage does not prevent shortcuts from installing', t => {
  const h = events(t, { config: { ClearLocalStorageTimestamp: 5 } });
  Object.defineProperty(h.window, 'localStorage', { configurable: true, get() { throw new h.window.DOMException('denied', 'SecurityError'); } });
  try { h.JE.initializeEnhancedScript(); } catch { /* baseline throws here */ }
  h.key('?');
  assert.ok(h.names().includes('panel'));
});

// CHR-EVENTS-4: the auto-resume promise rejection (autoplay policy) escaped as an unhandled rejection.
test('CHR-EVENTS-4 events: a refused auto-resume is not an unhandled page error', async t => {
  const h = events(t, { settings: { autoPauseEnabled: true, autoResumeEnabled: true } });
  const video = h.document.querySelector('video');
  let paused = false, hidden = false;
  Object.defineProperty(video, 'paused', { get: () => paused });
  Object.defineProperty(h.document, 'hidden', { configurable: true, get: () => hidden });
  video.pause = () => { paused = true; };
  video.play = () => Promise.reject(new h.window.DOMException('blocked', 'NotAllowedError'));
  let unhandled = 0; h.window.addEventListener('unhandledrejection', event => { unhandled++; event.preventDefault(); });
  const count = () => unhandled++; process.on('unhandledRejection', count); t.after(() => process.off('unhandledRejection', count));
  h.JE.initializeEnhancedScript();
  hidden = true; h.document.dispatchEvent(new h.window.Event('visibilitychange'));
  hidden = false; h.document.dispatchEvent(new h.window.Event('visibilitychange'));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(unhandled, 0);
  assert.equal(video.dataset.wasPlayingBeforeHidden, undefined);
});

test('events: action-sheet injection is frame-coalesced and gated on the Remove setting', async t => {
  const h = events(t, { settings: { removeContinueWatchingEnabled: true } });
  h.JE.initializeEnhancedScript();
  const sheet = h.document.createElement('div'); sheet.className = 'actionSheet';
  h.calls.sheet([{ target: h.document.body, addedNodes: [sheet] }]);
  h.calls.sheet([{ target: h.document.body, addedNodes: [sheet] }]);
  await new Promise(resolve => h.window.requestAnimationFrame(resolve));
  assert.equal(h.names().filter(name => name === 'remove').length, 1);
});
