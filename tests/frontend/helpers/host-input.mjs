import { readFileSync } from 'node:fs';
import { repositoryRoot } from './discovery.mjs';

// The host's OWN input handling, verbatim (tests/fixtures/host-input/<host>, made by
// tests/host/web-bundle/extract-input.mjs): jellyfin-web's keyboardNavigation (its window keydown listener: Back keys,
// TV Escape, the D-pad, a UWP gamepad's OK), inputManager (back → the router; select → click() on the focused element),
// focusManager (D-pad focus moves inside focus containers) and the gamepad-to-key chunk (a gamepad's buttons → key
// events; OK → click() on the focused element). They run in the test's browser realm through a minimal module loader;
// only their imports that are not part of this (the router, the layout and browser flags, the app host) are fixtures.

export const HOSTS = ['12.2', '10.11.11'];
const fixture = (host, file) => readFileSync(`${repositoryRoot}tests/fixtures/host-input/${host}/${file}`, 'utf8');

/** A value that answers any property and any call (the host's unrelated collaborators: polyfills, the player). */
function inert() {
  const f = function () { return inert(); };
  return new Proxy(f, { get: (t, k) => k === Symbol.toPrimitive ? () => '' : k === 'then' ? undefined : inert() });
}

/**
 * Loads the host's input modules for `host` into harness `h` and enables its keyboard navigation (as the app does at
 * start-up). `tv`: jellyfin-web's TV layout (Escape is Back there). Returns { back: the router's back() calls,
 * handleCommand, focusManager, gamepad(pad) } — gamepad() loads the gamepad-to-key chunk with `pad` as the only gamepad
 * (pad.buttons[i].pressed is read on each of the host's own 20 ms polls).
 */
export function hostInput(h, host, { tv = false, canGoBack = true } = {}) {
  const { window } = h;
  const calls = { back: 0, home: 0 };
  const appRouter = { canGoBack: () => canGoBack, back() { calls.back++; window.history.back(); }, goHome() { calls.home++; },
    showSettings() {}, showSearch() {}, showFavorites() {}, showGuide() {}, showLiveTV() {}, showRecordedTV() {}, showNowPlaying() {} };
  const dom = {
    addEventListener: (target, type, handler, options) => target.addEventListener(type, handler, options),
    removeEventListener: (target, type, handler, options) => target.removeEventListener(type, handler, options),
    parentWithClass(element, className) {
      for (let n = element; n && n.classList; n = n.parentNode) if (n.classList.contains(className)) return n;
      return null;
    },
  };
  const stubs = {
    22622: { g: { supports: () => false, exit() {}, getWindowState: () => 'Normal' } },
    70267: { appRouter },
    97339: { Y: { Exit: 'Exit' } },
    36300: { Ay: dom, default: dom },
    34789: { A: { tv, edgeUwp: false, hisense: false, vidaa: false }, default: { tv } },
    46782: { A: { tv }, default: { tv } },
    90381: { A: { enableGamepad: () => false }, default: { enableGamepad: () => false } },
    93599: { Ay: { isEnabled: () => false }, default: { isEnabled: () => false } },
  };
  const factories = {};
  const exports = {};
  function require(id) {
    if (id in exports) return exports[id];
    if (factories[id]) {
      const module = { exports: {} };
      exports[id] = module.exports;
      factories[id].call(module.exports, module, module.exports, require);
      return exports[id];
    }
    return stubs[id] || inert();
  }
  require.r = target => Object.defineProperty(target, '__esModule', { value: true });
  require.d = (target, getters) => { for (const key of Object.keys(getters)) if (!(key in target)) Object.defineProperty(target, key, { enumerable: true, get: getters[key] }); };
  require.n = module => { const getter = module?.__esModule ? () => module.default : () => module; require.d(getter, { a: getter }); return getter; };
  require.o = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  require.e = () => Promise.resolve();
  for (const name of ['focus-manager', 'input-manager', 'keyboard-navigation']) {
    const text = fixture(host, `${name}.module.js`);
    const box = window.eval(`(function () { const module = {}; ${text.replace(/^\/\/.*\n/, '')}\n return module.exports; })()`);
    factories[box.id] = box.module;
  }
  const keyboard = require(74550);
  (keyboard.Ay || keyboard.default).enable();
  const input = require(38490);
  return {
    get back() { return calls.back; },
    handleCommand: (...args) => (input.Ay || input.default).handleCommand(...args),
    focusManager: require(9164).A,
    /**
     * Loads the host's gamepad-to-key chunk with `pad` connected (its 20 ms poll reads pad.buttons[i].pressed; the page
     * has focus, as a TV app's does). Returns stop(): the pad disconnects and the host's poll ends.
     */
    gamepad(pad) {
      Object.defineProperty(window.navigator, 'getGamepads', { configurable: true, value: () => [pad] });
      window.document.hasFocus = () => true;
      const chunks = [];
      window.webpackChunk = { push: chunk => chunks.push(chunk) };
      window.eval(fixture(host, 'gamepadtokey.chunk.js'));
      const [[, modules]] = chunks;
      for (const [id, factory] of Object.entries(modules)) factories[id] = factory;
      require(84348);
      window.dispatchEvent(new window.Event('gamepadconnected'));
      return () => { pad.connected = false; window.dispatchEvent(new window.Event('gamepaddisconnected')); };
    },
  };
}

/** A standard-mapping gamepad whose buttons the test presses (0: A / OK, 1: B / Back). */
export function gamepad() {
  return { index: 0, connected: true, mapping: 'standard', axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })) };
}
