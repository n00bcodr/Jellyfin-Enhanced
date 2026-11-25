import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from '../helpers/harness.mjs';

/** Real player and event modules, with a controlled clock and trusted input at the DOM boundary. */
function setup(t) {
  const h = createHarness({
    html: '<div id="videoOsdPage"><div class="osdControls"><button>Pause</button></div></div><video></video>',
    JE: {
      currentSettings: { longPress2xEnabled: true }, state: {}, pluginConfig: { DisableAllShortcuts: true },
      isVideoPage: () => true, icon: () => '', IconName: { FAST_FORWARD: 'forward', PLAY: 'play' },
      helpers: { createObserver() {}, throttle: f => f, onBodyMutation() {} }
    }
  });
  t.after(() => h.close());
  for (const name of ['injectGlobalStyles', 'addPluginMenuButton', 'addUserMenuLink', 'addRandomButton', 'applySavedStylesWhenReady']) h.JE[name] = () => {};
  h.window.PointerEvent = class extends h.window.MouseEvent {
    constructor(type, init) { super(type, init); this.pointerType = init.pointerType; this.pointerId = init.pointerId; }
  };
  let now = 1000, nextId = 0;
  const timers = new Map();
  h.window.Date.now = () => now;
  h.window.setTimeout = (fn, delay) => { const id = ++nextId; timers.set(id, { fn, at: now + delay }); return id; };
  h.window.clearTimeout = id => timers.delete(id);
  const advance = ms => {
    now += ms;
    for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.fn(); }
  };
  const listeners = new Map();
  const add = h.document.addEventListener.bind(h.document);
  h.document.addEventListener = (type, fn, options) => {
    if (!listeners.has(type)) listeners.set(type, []);
    listeners.get(type).push({ fn, options });
    add(type, fn, options);
  };
  h.load('enhanced/player/playback.js');
  h.load('enhanced/events.js');
  h.JE.initializeEnhancedScript();
  const video = h.document.querySelector('video');
  Object.defineProperty(video, 'paused', { configurable: true, value: false });
  video.playbackRate = 1.25;
  const surface = h.document.querySelector('#videoOsdPage');
  const taps = [];
  let pointerHeld = false;
  h.window.addEventListener('pointerdown', () => { pointerHeld = true; }, true);
  h.window.addEventListener('pointerup', () => { pointerHeld = false; }, true);
  surface.addEventListener('pointerdown', e => taps.push(e));
  surface.addEventListener('click', e => taps.push(e));
  // jsdom cannot create trusted events. Feed the registered capture listener directly;
  // forwarded synthetic taps still travel through the real DOM and its isTrusted guard.
  const input = (type, props = {}) => {
    const e = {
      type, target: surface, isTrusted: true, cancelable: true,
      clientX: 100, clientY: 100, pointerType: 'touch', pointerId: 1,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this.stopped = true; },
      stopImmediatePropagation() { this.stopped = true; }, ...props
    };
    for (const { fn } of listeners.get(type) || []) { fn(e); if (e.stopped) break; }
    return e;
  };
  const start = (x = 100, y = 100) => {
    input('pointerdown', { clientX: x, clientY: y });
    return input('touchstart', { touches: [{ clientX: x, clientY: y }] });
  };
  return { ...h, video, surface, input, start, advance, taps, listeners, pointerHeld: () => pointerHeld };
}

test('touch tap reaches the OSD once on release, without arming a synthetic hold', t => {
  const h = setup(t);
  assert.equal(h.start().defaultPrevented, true);
  assert.equal(h.taps.length, 0);
  h.advance(100);
  h.input('touchend');
  assert.equal(h.taps.length, 1);
  assert.equal(h.taps[0].pointerType, 'touch');
  assert.equal(h.pointerHeld(), false);
  h.advance(600);
  assert.equal(h.video.playbackRate, 1.25);
});

test('hold claims movement, does not tap the OSD, and restores the original rate', t => {
  const h = setup(t);
  h.start(); h.advance(500);
  assert.equal(h.video.playbackRate, 2);
  const move = h.input('touchmove', { touches: [{ clientX: 100, clientY: 220 }] });
  assert.equal(move.defaultPrevented, true);
  assert.equal(move.stopped, true);
  assert.equal(h.video.playbackRate, 2);
  const end = h.input('touchend');
  assert.equal(end.defaultPrevented, true);
  assert.equal(h.video.playbackRate, 1.25);
  assert.equal(h.taps.length, 0);
  assert.equal(h.input('click').stopped, true);
});

test('movement before the threshold cancels the hold and tap, including coordinates at zero', t => {
  const h = setup(t);
  h.start(0, 0);
  h.input('touchmove', { touches: [{ clientX: 0, clientY: 20 }] });
  h.advance(600); h.input('touchend');
  assert.equal(h.video.playbackRate, 1.25);
  assert.equal(h.taps.length, 0);
});

for (const cancel of ['touchcancel', 'pointercancel', 'blur', 'hashchange']) {
  test(`${cancel} restores speed and does not replay a tap`, t => {
    const h = setup(t);
    h.start(); h.advance(500);
    if (cancel === 'blur' || cancel === 'hashchange') h.window.dispatchEvent(new h.window.Event(cancel));
    else h.input(cancel);
    assert.equal(h.video.playbackRate, 1.25);
    h.input('touchend');
    assert.equal(h.taps.length, 0);
  });
}

test('multitouch cancels an active hold', t => {
  const h = setup(t);
  h.start(); h.advance(500);
  h.input('touchstart', { touches: [{ clientX: 100, clientY: 100 }, { clientX: 120, clientY: 100 }] });
  assert.equal(h.video.playbackRate, 1.25);
  h.input('touchend');
  assert.equal(h.taps.length, 0);
});

test('release over a control or after navigation still restores the original video', t => {
  const h = setup(t);
  h.start(); h.advance(500);
  h.video.remove();
  const replacement = h.document.createElement('video');
  h.document.body.append(replacement);
  h.JE.isVideoPage = () => false;
  h.input('touchend', { target: h.document.querySelector('button') });
  assert.equal(h.video.playbackRate, 1.25);
  assert.equal(replacement.playbackRate, 1);
});

test('paused video, controls, dialogs and disabled settings retain native input', t => {
  const h = setup(t);
  const button = h.document.querySelector('button');
  assert.equal(h.input('pointerdown', { target: button }).stopped, undefined);
  assert.equal(h.input('touchstart', { target: button, touches: [{}] }).defaultPrevented, undefined);
  Object.defineProperty(h.video, 'paused', { value: true });
  assert.equal(h.start().defaultPrevented, undefined);
  Object.defineProperty(h.video, 'paused', { value: false });
  h.JE.currentSettings.longPress2xEnabled = false;
  assert.equal(h.start().defaultPrevented, undefined);
  h.advance(600);
  assert.equal(h.video.playbackRate, 1.25);
});

test('mouse hold suppresses the trailing click, but the next deliberate click works', t => {
  const h = setup(t);
  h.input('mousedown', { button: 0 }); h.advance(500);
  assert.equal(h.video.playbackRate, 2);
  h.input('mouseup');
  assert.equal(h.input('click').stopped, true);
  h.input('mousedown', { button: 0 }); h.input('mouseup');
  assert.equal(h.input('click').stopped, undefined);
  assert.equal(h.video.playbackRate, 1.25);
});

test('a deliberate control tap immediately after a hold is not a trailing click', t => {
  const h = setup(t);
  h.start(); h.advance(500); h.input('touchend');
  const target = h.document.querySelector('button');
  h.input('pointerdown', { target });
  assert.equal(h.input('click', { target }).stopped, undefined);
});

test('hiding the page restores the speed and cancels the gesture', t => {
  const h = setup(t);
  h.start(); h.advance(500);
  Object.defineProperty(h.document, 'hidden', { value: true });
  h.document.dispatchEvent(new h.window.Event('visibilitychange'));
  assert.equal(h.video.playbackRate, 1.25);
  h.input('touchend');
  assert.equal(h.taps.length, 0);
});

test('pausing while waiting for the hold does not restart playback', t => {
  const h = setup(t);
  h.start();
  Object.defineProperty(h.video, 'paused', { value: true });
  h.advance(500); h.input('touchend');
  assert.equal(h.video.playbackRate, 1.25);
  assert.equal(h.taps.length, 0);
});

test('touch listeners can prevent native scrolling and ignore programmatic input', t => {
  const h = setup(t);
  for (const type of ['touchstart', 'touchmove', 'touchend']) {
    assert.equal(h.listeners.get(type)[0].options.passive, false);
  }
  h.input('touchstart', { isTrusted: false, touches: [{ clientX: 100, clientY: 100 }] });
  h.advance(600);
  assert.equal(h.video.playbackRate, 1.25);
});
