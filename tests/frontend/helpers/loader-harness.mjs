import assert from 'node:assert/strict';
import { createHarness } from './harness.mjs';
import { resolveGroups } from './eval-reads.mjs';

/**
 * Boots the real plugin.js loader against a component manifest and groups file the test chooses, with the
 * script transport simulated (no network). Real modules named in `real` execute unchanged; any other module
 * runs the test's own function from `modules` (or nothing), so a test controls exactly what each group does.
 *
 * Everything observable goes into one ordered `log`: `<module path>` when a module runs, `init:<path>` when an
 * initializer made by `defines()` is called, `tab:<id>` when JE.nativeTabs.register is called (once the real
 * enhanced/native-tabs.js has run), and whatever the test pushes itself.
 */

/** Modules plugin.js needs to boot at all: navigation (triggers), session (user switch), config (loadSettings). */
export const BOOT_MODULES = ['core/navigation.js', 'core/session.js', 'enhanced/config.js'];
/** Adds what the Home tab rules use: the lifecycle registry, the body observer, helpers and the native-tab registry. */
export const TAB_MODULES = ['core/navigation.js', 'core/session.js', 'core/lifecycle.js', 'core/dom-observer.js', 'core/ui-kit.js',
  'enhanced/config.js', 'enhanced/helpers.js', 'enhanced/native-tabs.js'];

/** Polls a condition (no fixed sleeps): resolves as soon as it holds, fails after three seconds. */
export async function until(predicate, message = 'the loader did not reach the expected state') {
  const deadline = performance.now() + 3000;
  while (performance.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  assert.ok(predicate(), message);
}

/**
 * A module body that defines the given JE functions (dotted paths create their namespace the way the real
 * modules do, `JE.x = JE.x || {}`). Each records `init:<path>` and its arguments when called.
 * @param {...string} paths
 * @returns {(JE: object, boot: object) => void}
 */
export function defines(...paths) {
  return (JE, boot) => {
    for (const path of paths) {
      const parts = path.split('.');
      let owner = JE;
      for (const part of parts.slice(0, -1)) owner = owner[part] = owner[part] || {};
      owner[parts[parts.length - 1]] = function (...args) {
        boot.log.push(`init:${path}`);
        boot.calls.push({ path, args });
        return `result:${path}`;
      };
    }
  };
}

/**
 * @param {import('node:test').TestContext} t
 * @param {object} options
 * @param {string[]} options.manifest - The component manifest (ComponentScripts).
 * @param {Array<object>|undefined} [options.groups] - The raw groups array (ComponentGroups); undefined leaves it out of the payload.
 * @param {object} [options.publicConfig] - PublicConfig of every payload.
 * @param {object|((userId: string) => object)} [options.userSettings] - The saved settings document (PascalCase), or one per user.
 * @param {(userId: string) => object|Promise<object>} [options.data] - The whole bootstrap payload per user (overrides the two above).
 * @param {(path: string, request: object) => any} [options.ajax] - Answers every ApiClient.ajax call (overrides `data`).
 * @param {string[]} [options.real] - Modules that execute for real.
 * @param {Object<string, Function>} [options.modules] - Test bodies for the other modules: (JE, boot) => void.
 * @param {(ids: string[]|null, index: number) => ({ fail?: boolean, define?: string[], hold?: Promise<any> }|undefined)} [options.bundle]
 *   How a bundle request is answered. `ids` is the `g=` list, null for the whole-manifest route.
 * @param {(name: string) => ('ok'|'error')} [options.file] - How a per-file request is answered.
 * @param {boolean} [options.dev] - The script tag says dev mode.
 * @param {string} [options.url] - The page address.
 * @param {object} [options.translations] - What the translations module loads.
 * @param {(name: string, JE: object, boot: object) => void} [options.afterModule] - Called after every module.
 */
export function bootLoader(t, {
  manifest, groups, publicConfig = {}, userSettings = {}, data, ajax, real = BOOT_MODULES, modules = {}, bundle, file, dev = false,
  url = 'http://jellyfin.test/web/index.html#!/home', html = '', translations = {}, afterModule, expectedConsoleErrors = []
} = {}) {
  let userId = 'user-a';
  const log = [], calls = [], requests = [], files = [], scripts = [], arrivals = [], registrations = [];
  const realSet = new Set(real);
  const settingsFor = id => (typeof userSettings === 'function' ? userSettings(id) : userSettings);
  const payloadFor = id => {
    const body = { UserId: id, Version: '1.2.3', PublicConfig: { ...publicConfig }, PrivateConfig: null, HasCustomTabs: false, HasPluginPages: false,
      UserSettings: { Settings: { ...settingsFor(id) } }, ComponentScripts: manifest };
    if (groups !== undefined) body.ComponentGroups = groups;
    return body;
  };
  const h = createHarness({ url, expectedConsoleErrors,
    html: `<script plugin="Jellyfin Enhanced" version="1.2.3-build123"${dev ? ' dev="true"' : ''}></script>${html}`,
    apiClient: { getCurrentUserId: () => userId, ajax: async request => {
      const path = new URL(request.url).pathname;
      if (ajax) return ajax(path, request);
      if (path.endsWith('/bootstrap')) return data ? data(userId) : payloadFor(userId);
      throw new Error(`Unexpected endpoint ${path}`);
    } } });
  t.after(() => h.close());
  h.window.requestIdleCallback = callback => { queueMicrotask(() => callback({ didTimeout: false, timeRemaining: () => 100 })); return 1; };
  const JE = () => h.window.JellyfinEnhanced;
  const boot = { log, calls };
  let resolved = null;
  const groupScripts = id => {
    resolved = resolved || new Map(resolveGroups(manifest, groups).map(group => [group.id, group.scripts]));
    return resolved.get(id);
  };
  const execute = name => {
    log.push(name);
    if (realSet.has(name)) h.load(name);
    modules[name]?.(JE(), boot);
    if (name === 'enhanced/native-tabs.js' && JE().nativeTabs && typeof JE().nativeTabs.register === 'function') {
      const register = JE().nativeTabs.register;
      JE().nativeTabs.register = (...args) => { log.push(`tab:${args[0]}`); registrations.push(args); return register(...args); };
    }
    afterModule?.(name, JE(), boot);
  };
  const append = h.document.head.appendChild.bind(h.document.head);
  h.document.head.appendChild = node => {
    const result = append(node);
    if (node.tagName !== 'SCRIPT') return result;
    scripts.push(node);
    const address = new URL(node.src);
    const path = address.pathname;
    if (path.endsWith('/translations.js')) {
      queueMicrotask(() => { JE().loadTranslations = async () => ({ ...translations }); node.onload?.(); });
    } else if (path.endsWith('/bundle.js')) {
      const g = address.searchParams.get('g');
      const ids = g === null ? null : g.split(',');
      const index = requests.length;
      requests.push({ ids, url: node.src, currentSettings: JE().currentSettings, loadSettings: JE().loadSettings });
      const plan = bundle?.(ids, index) || {};
      Promise.resolve(plan.hold).then(() => {
        arrivals.push(ids ? ids.join(',') : 'whole');
        if (plan.fail) { node.onerror?.(new h.window.Event('error')); return; }
        if (ids) {
          const defined = h.window.__JE_BUNDLES = h.window.__JE_BUNDLES || {};
          for (const id of plan.define || ids) {
            const names = groupScripts(id);
            defined[id] = { total: names.length, modules: names.map(name => () => execute(name)) };
          }
        } else {
          h.window.__JE_BUNDLE_TOTAL = manifest.length;
          h.window.__JE_BUNDLE_MODULES = manifest.map(name => () => execute(name));
        }
        node.onload?.();
      });
    } else {
      const name = path.split('/js/')[1];
      queueMicrotask(() => {
        if (manifest.includes(name)) {
          files.push({ name, async: node.async });
          if ((file?.(name) || 'ok') === 'error') { node.onerror?.(new h.window.Event('error')); return; }
          execute(name);
        }
        node.onload?.();
      });
    }
    return result;
  };
  h.load('plugin.js');
  return {
    ...h, log, calls, requests, files, scripts, arrivals, registrations,
    get plugin() { return JE(); },
    get userId() { return userId; },
    /** Changes the signed-in user without telling the session module (as the host does before its check runs). */
    setUser(id) { userId = id; },
    /** Changes the signed-in user and lets the real session module notice. */
    switchUser(id) { userId = id; JE().session.checkNow('test'); },
    /** The `g=` lists asked for so far ("whole" for the route without one). */
    get asked() { return requests.map(request => (request.ids ? request.ids.join(',') : 'whole')); },
    /** Boots and waits until JE.initialized and every batch asked for has run. */
    async booted() { await until(() => JE().initialized === true, 'JE.initialized was never set'); await JE().loader.settled(); },
    /** Changes the address the way the host router does and waits for the loader's navigation work to finish. */
    async navigate(hash) {
      const before = requests.length;
      h.window.location.hash = hash;
      await new Promise(resolve => h.window.addEventListener('hashchange', resolve, { once: true }));
      await JE().loader.settled();
      return requests.slice(before);
    }
  };
}
