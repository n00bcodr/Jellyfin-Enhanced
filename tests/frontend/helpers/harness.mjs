import { randomUUID } from 'node:crypto';
import { JSDOM, VirtualConsole } from 'jsdom';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { instrumentSource } from './instrumentation.mjs';
import coverage from 'istanbul-lib-coverage';
import { repositoryRoot, speedProfile } from './discovery.mjs';
import { served } from './served-scripts.mjs';

export const jsRoot = resolve(repositoryRoot, 'Jellyfin.Plugin.JellyfinEnhanced/js');
const collected = coverage.createCoverageMap({});
if (process.env.JE_COVERAGE_DIR) process.on('exit', () => {
  mkdirSync(process.env.JE_COVERAGE_DIR, { recursive: true });
  writeFileSync(resolve(process.env.JE_COVERAGE_DIR, `${process.pid}${speedProfile ? '-' + randomUUID() : ''}.json`), JSON.stringify(collected));
});

/** Load real classic-script modules into a fresh browser realm; no network is permitted by default. */
export function createHarness({ html = '', url = 'http://jellyfin.test/web/index.html#!/home', JE = {}, apiClient = {}, fetch, globals = {}, expectedConsoleErrors = [] } = {}) {
  const errors = [];
  // Expected errors must occur before close(); optional ones (allowConsoleError) may.
  const allowedErrors = expectedConsoleErrors.map(pattern => ({ pattern, required: true, matched: false }));
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('error', (...args) => {
    const message = args.map(String).join(' ');
    const matches = allowedErrors.filter(({ pattern }) => typeof pattern === 'string' ? message.includes(pattern) : pattern.test(message));
    for (const expected of matches) expected.matched = true;
    if (!matches.length) errors.push(new Error(`Unexpected console.error: ${message}`));
  });
  virtualConsole.on('jsdomError', error => errors.push(error));
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, {
    url, runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole
  });
  const { window } = dom;
  // Modules loaded by the host bundle run after the document is ready.
  Object.defineProperty(window.document, 'readyState', { configurable: true, value: 'complete' });
  window.JellyfinEnhanced = JE;
  // D46S2-R6: an owner-taking call (an opener or an owned write) made without an owner throws in tests.
  if (JE.strictOwners === undefined) JE.strictOwners = true;
  window.ApiClient = {
    getCurrentUserId: () => 'user-a', accessToken: () => 'test-token', serverId: () => 'server-a',
    getUrl: path => `http://jellyfin.test${path.startsWith('/') ? '' : '/'}${path}`, ...apiClient
  };
  // Legacy-helper unit fixtures keep their ajax mock; transport tests load the real core below.
  JE.core = JE.core || {};
  JE.core.api = JE.core.api || {};
  JE.core.api.ajax = JE.core.api.ajax || (options => window.ApiClient.ajax(options));
  window.fetch = fetch || ((url) => {
    const error = new Error(`Unexpected network request: ${url}; provide a fetch fixture`);
    errors.push(error);
    throw error;
  });
  // Request-surface fixtures provide raw HTTP responses; preserve the core status/body contract.
  JE.core.api.pluginResponse = JE.core.api.pluginResponse || (async (path, options = {}) => {
    const response = await window.fetch(window.ApiClient.getUrl('/JellyfinEnhanced' + path), {
      method: options.method || 'GET', signal: options.signal,
      body: options.body === undefined ? undefined : JSON.stringify(options.body)
    });
    let body = null;
    try { const text = await response.text(); body = text ? JSON.parse(text) : null; } catch (_) { /* malformed fixture body */ }
    return { status: response.status, body };
  });
  window.structuredClone = structuredClone;
  Object.assign(window, globals);
  /** Evaluates and instruments a module as it runs in the production bundle. */
  function load(path, transform) {
    const file = resolve(jsRoot, path);
    // As the server serves it (the translations script carries the language policy it writes in).
    let source = served(path, readFileSync(file, 'utf8'));
    if (transform) {
      // A planted construct (a test runs it to show what the runtime does with it): the transform must apply.
      const planted = transform(source);
      if (planted === source) throw new Error(`The plant does not apply to ${path}`);
      source = planted;
    }
    if (process.env.JE_COVERAGE_DIR) source = instrumentSource(source, file);
    window.eval(`[function () {\n${source}\n}][0]();\n//# sourceURL=${file}`);
    return JE;
  }
  // The viewer's own gestures are trusted events, as a browser dispatches them; script-made ones are not (D46S2-R10:
  // native authority is minted only from trusted events). A click() the test makes outside every production module
  // is the viewer's; one a production module makes (its own synthetic click) stays untrusted, as in the browser.
  const implOf = object => object[Object.getOwnPropertySymbols(object).find(symbol => String(symbol) === 'Symbol(impl)')];
  function dispatchTrusted(target, event) {
    const impl = implOf(event);
    impl.isTrusted = true;
    implOf(target)._dispatch(impl);
    return !impl._canceledFlag;
  }
  function fromProduction() {
    const limit = Error.stackTraceLimit;
    Error.stackTraceLimit = 200;
    const stack = new Error().stack || '';
    Error.stackTraceLimit = limit;
    return stack.includes(jsRoot);
  }
  const syntheticClick = window.HTMLElement.prototype.click;
  const clicking = new WeakSet();
  window.HTMLElement.prototype.click = function () {
    if (fromProduction()) return syntheticClick.call(this);
    if (this.matches(':disabled') || clicking.has(this)) return;
    clicking.add(this);
    try { dispatchTrusted(this, new window.MouseEvent('click', { bubbles: true, cancelable: true, composed: true, view: window, detail: 1 })); }
    finally { clicking.delete(this); }
  };
  // Deferred feature actions use the shared identity primitive in the real bundle, and every document a feature writes
  // has its session-bound write queue (core/mutation-queue.js loads before every feature module in the bundle).
  load('core/session-action.js');
  load('core/mutation-queue.js');
  window.addEventListener('error', event => errors.push(event.error || new Error(event.message)));
  window.addEventListener('unhandledrejection', event => errors.push(event.reason));
  return {
    window, document: window.document, JE, errors,
    /**
     * A viewer's native owner, as a gesture of theirs mints it now (a trusted event; its session, document and route
     * are the current ones): JE.nativeFrom on a trusted event the harness dispatches.
     */
    get NATIVE() {
      let token = null;
      // (Before tokens a native owner was named during a dispatched event: kept for a replay against older sources.)
      const probe = event => { token = JE.nativeFrom ? JE.nativeFrom(event) : (typeof JE.nativeRoot === 'function' ? JE.nativeRoot('a test') : JE.NATIVE); };
      window.document.addEventListener('je-test-gesture', probe);
      try { dispatchTrusted(window.document, new window.Event('je-test-gesture')); }
      finally { window.document.removeEventListener('je-test-gesture', probe); }
      return token;
    },
    /** Dispatches `event` on `target` as the browser would for the viewer (trusted). Returns false when cancelled. */
    trusted: dispatchTrusted,
    /**
     * The viewer clicks `node` (a trusted click through its onclick handler property), and the handler's own result
     * (the promise an async handler returns) comes back for the test to await.
     */
    viewerPress(node) {
      const handler = node.onclick;
      let result;
      node.onclick = function (event) { result = handler.call(this, event); return result; };
      try { dispatchTrusted(node, new window.MouseEvent('click', { bubbles: true, cancelable: true, view: window, detail: 1 })); }
      finally { node.onclick = handler; }
      return result;
    },
    /** The viewer presses `key` on `target` (a trusted keydown). */
    key(target, key, init = {}) { return dispatchTrusted(target, new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })); },
    /** Declares a console.error the test must produce; close() fails if none matched. */
    expectConsoleError(pattern) { allowedErrors.push({ pattern, required: true, matched: false }); },
    /** Tolerates a console.error that may or may not happen (timing-dependent diagnostics). */
    allowConsoleError(pattern) { allowedErrors.push({ pattern, required: false, matched: false }); },
    load,
    close() {
      if (window.__coverage__) collected.merge(window.__coverage__);
      window.close();
      for (const { pattern, required, matched } of allowedErrors) {
        if (required && !matched) errors.push(new Error(`Expected console.error never happened: ${pattern}`));
      }
      if (errors.length) throw new AggregateError(errors, 'Unexpected browser errors');
    }
  };
}

export function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
export const jsonResponse = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
export const plain = value => JSON.parse(JSON.stringify(value));

/** Install the real JE.keyCombo from config.js without running the rest of that module (it needs a full JE). */
export function loadKeyCombo(harness) {
  const source = readFileSync(resolve(jsRoot, 'enhanced/config.js'), 'utf8');
  const match = /JE\.keyCombo = function[\s\S]*?\n    };/.exec(source);
  if (!match) throw new Error('JE.keyCombo not found in enhanced/config.js');
  harness.window.eval(`(function(JE){${match[0]}})(window.JellyfinEnhanced)`);
}
