import { readFileSync } from 'node:fs';
import { repositoryRoot } from './discovery.mjs';

// The host's OWN input handling, verbatim (tests/fixtures/host-input/<host>, made by
// tests/host/web-bundle/extract-input.mjs): jellyfin-web's keyboardNavigation (its window keydown listener: Back keys,
// TV Escape, the D-pad, a UWP gamepad's OK), inputManager (back → the router; select → click() on the focused element),
// focusManager (D-pad focus moves inside focus containers), serverNotifications with the events helper (the server's
// WebSocket messages: another client's remote-control commands → inputManager) and the gamepad-to-key chunk (a
// gamepad's buttons → key events; OK → click() on the focused element). They run in the test's browser realm through a minimal module loader;
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
  // The router's back() as jellyfin-web's appRouter does it (12.2 and 10.11.11): one pending back at a time, settled
  // when its history step lands (the history's next change); a back() while one is pending waits on it, so a step
  // that never lands leaves every later Back stuck.
  let pending = null;
  const appRouter = { canGoBack: () => canGoBack, goHome() { calls.home++; },
    back() {
      calls.back++;
      if (pending) return pending;
      pending = new Promise(resolve => {
        window.addEventListener('popstate', () => { pending = null; resolve(); }, { once: true });
        window.history.back();
      });
      return pending;
    },
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
  for (const name of ['focus-manager', 'input-manager', 'keyboard-navigation', 'events', 'server-notifications']) {
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
    /**
     * Another Jellyfin client's remote control (Q-D46S2FIX12-1): the server's WebSocket, as the host reads it. A
     * loopback server (127.0.0.1, this process) holds the other end of a real WebSocket of the test's browser realm, so
     * every message arrives as the browser delivers one (a trusted MessageEvent of that socket). The host's own
     * serverNotifications module (verbatim) subscribes to it the way each host's API client wires its socket — 10.11.11:
     * jellyfin-apiclient's onmessage → Events.trigger(apiClient, 'message', [message]) (the host's events module,
     * verbatim); 12.2: the SDK socket's 'message' listener → the subscribers of the message's type — and turns a
     * GeneralCommand into inputManager.handleCommand (Select → click() on the focused element, Back → the router).
     * Resolves { command(name): the server sends GeneralCommand `name` (resolves once the browser has dispatched it),
     * send(message), close() }.
     */
    async remote() {
      const { WebSocketServer } = await import('ws');
      const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
      await new Promise(resolve => server.once('listening', resolve));
      const accepted = new Promise(resolve => server.once('connection', resolve));
      const socket = new window.WebSocket(`ws://127.0.0.1:${server.address().port}/socket`);
      const [peer] = await Promise.all([accepted, new Promise(resolve => socket.addEventListener('open', resolve, { once: true }))]);
      const events = require(44797).A;
      const apiClient = { serverId: () => 'server-a', serverInfo: () => ({ Id: 'server-a' }), getCurrentUserId: () => 'user-a' };
      if (host === '12.2') {
        // The SDK's WebSocket (node_modules.@jellyfin.sdk: initSocket's 'message' listener) and its subscribe(types, cb).
        const subscriptions = new Map();
        apiClient.subscribe = (types, callback) => {
          for (const type of types) { if (!subscriptions.has(type)) subscriptions.set(type, []); subscriptions.get(type).push(callback); }
          return () => {};
        };
        socket.addEventListener('message', event => { const message = JSON.parse(event.data); subscriptions.get(message.MessageType)?.forEach(callback => callback(message)); });
        stubs[4935] = { De: { Play: 'Play', Playstate: 'Playstate', GeneralCommand: 'GeneralCommand', SyncPlayCommand: 'SyncPlayCommand', SyncPlayGroupUpdate: 'SyncPlayGroupUpdate' } };
      } else {
        // jellyfin-apiclient's openWebSocket: onmessage = j (JSON.parse, then Events.trigger(apiClient, 'message', [msg])).
        socket.onmessage = event => events.trigger(apiClient, 'message', [JSON.parse(event.data)]);
      }
      stubs[67430] = { tF: { getApiClients: () => [apiClient] } };
      const notifications = require(10736);
      (notifications.D || notifications.initializeServerConnections)();
      const send = message => new Promise(resolve => {
        // Resolves after the host's own listener (registered first) has handled the message.
        socket.addEventListener('message', () => resolve(), { once: true });
        peer.send(JSON.stringify(message));
      });
      return {
        socket,
        send,
        command: (name, args = {}) => send({ MessageType: 'GeneralCommand', Data: { Name: name, Arguments: args } }),
        close() { socket.close(); peer.terminate(); server.close(); },
      };
    },
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
