import { JSDOM, VirtualConsole } from 'jsdom';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInstrumenter } from 'istanbul-lib-instrument';
import coverage from 'istanbul-lib-coverage';
import { repositoryRoot } from './discovery.mjs';

export const jsRoot = resolve(repositoryRoot, 'Jellyfin.Plugin.JellyfinEnhanced/js');
const collected = coverage.createCoverageMap({});
if (process.env.JE_COVERAGE_DIR) process.on('exit', () => {
  mkdirSync(process.env.JE_COVERAGE_DIR, { recursive: true });
  writeFileSync(resolve(process.env.JE_COVERAGE_DIR, `${process.pid}.json`), JSON.stringify(collected));
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
    let source = readFileSync(file, 'utf8');
    if (transform) {
      // A planted construct (a test runs it to show what the runtime does with it): the transform must apply.
      const planted = transform(source);
      if (planted === source) throw new Error(`The plant does not apply to ${path}`);
      source = planted;
    }
    if (process.env.JE_COVERAGE_DIR) source = createInstrumenter().instrumentSync(source, file);
    window.eval(`[function () {\n${source}\n}][0]();\n//# sourceURL=${file}`);
    return JE;
  }
  // Deferred feature actions use the shared identity primitive in the real bundle.
  load('core/session-action.js');
  window.addEventListener('error', event => errors.push(event.error || new Error(event.message)));
  window.addEventListener('unhandledrejection', event => errors.push(event.reason));
  return {
    window, document: window.document, JE, errors,
    /** The native owner as test code names it: a test runs outside every gesture, as a native root (JE.nativeRoot). */
    get NATIVE() { return typeof JE.nativeRoot === 'function' ? JE.nativeRoot('a test') : JE.NATIVE; },
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
