import { JSDOM, VirtualConsole } from 'jsdom';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInstrumenter } from 'istanbul-lib-instrument';
import featureContextHelper from './feature-context.cjs';
import coverage from 'istanbul-lib-coverage';
import { repositoryRoot } from './discovery.mjs';

export const jsRoot = resolve(repositoryRoot, 'Jellyfin.Plugin.JellyfinEnhanced/js');
const collected = coverage.createCoverageMap({});
// Cache immutable module sources per file process, never a test's mutable realm.
// Coverage instrumentation is especially expensive for the full admin page setup.
const sources = new Map();
/** Read/instrument a production module once per process, preserving fresh realm evaluation. */
function moduleSource(file) {
  if (!sources.has(file)) {
    let source = readFileSync(file, 'utf8');
    if (process.env.JE_COVERAGE_DIR) source = createInstrumenter().instrumentSync(source, file);
    sources.set(file, `[function () {\n${source}\n}][0]();\n//# sourceURL=${file}`);
  }
  return sources.get(file);
}
const { provideSharedRuntime } = featureContextHelper;
// canopy K1: core/ui-kit.js publishes the shared featureContext in production; load() publishes the same function
// (helpers/feature-context.cjs) for a module that needs it, unless the harness was created with featureContext: false.
// canopy K1b: likewise the shared modules (client/shared-modules.json) a script reads and no provider has published
// yet, unless the harness was created with sharedModules: false.
/** Before evaluating `source` (the script js/`path`) in `window`: publish what its providers would have published. */
export function provideFeatureContext(window, source, path, options) {
  provideSharedRuntime(code => window.eval(code), source, path, options);
}
if (process.env.JE_COVERAGE_DIR) process.on('exit', () => {
  mkdirSync(process.env.JE_COVERAGE_DIR, { recursive: true });
  writeFileSync(resolve(process.env.JE_COVERAGE_DIR, `${process.pid}.json`), JSON.stringify(collected));
});

/** Load real classic-script modules into a fresh browser realm; no network is permitted by default. */
export function createHarness({ html = '', url = 'http://jellyfin.test/web/index.html#!/home', JE = {}, apiClient = {}, fetch, globals = {}, expectedConsoleErrors = [], featureContext = true, sharedModules = true } = {}) {
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
  // Legacy feature fixtures model an already-loaded settings document. Real protocol
  // tests explicitly set settingsRevision (including null) and supply their own receipt.
  if (JE.userConfig?.settings && !Object.hasOwn(JE.userConfig, 'settingsRevision')) JE.userConfig.settingsRevision = 'fixture-loaded';
  window.JellyfinEnhanced = JE;
  window.ApiClient = {
    getCurrentUserId: () => 'user-a', accessToken: () => 'test-token', serverId: () => 'server-a',
    // Jellyfin's real ApiClient rejects an empty URL name. Keep this boundary strict.
    getUrl: path => {
      if (!path) throw new Error('Url name cannot be empty');
      return `http://jellyfin.test${path.startsWith('/') ? '' : '/'}${path}`;
    }, ...apiClient
  };
  const fixtureAjax = window.ApiClient.ajax;
  if (fixtureAjax) window.ApiClient.ajax = async request => {
    const response = await fixtureAjax(request);
    if (request.type === 'POST' && request.url.endsWith('/settings-document') &&
        (response == null || (typeof response === 'object' && Object.keys(response).length === 0)))
      return { Revision: 'fixture-saved' };
    return response;
  };
  window.fetch = fetch || ((url) => {
    const error = new Error(`Unexpected network request: ${url}; provide a fetch fixture`);
    errors.push(error);
    throw error;
  });
  window.structuredClone = structuredClone;
  Object.assign(window, globals);
  window.addEventListener('error', event => errors.push(event.error || new Error(event.message)));
  window.addEventListener('unhandledrejection', event => errors.push(event.reason));
  return {
    window, document: window.document, JE, errors,
    /** Declares a console.error the test must produce; close() fails if none matched. */
    expectConsoleError(pattern) { allowedErrors.push({ pattern, required: true, matched: false }); },
    /** Tolerates a console.error that may or may not happen (timing-dependent diagnostics). */
    allowConsoleError(pattern) { allowedErrors.push({ pattern, required: false, matched: false }); },
    load(path) {
      // JE_TEST_MIN_TWINS=1 (canopy K1): run the module's minified twin, min/js/<path>, which is what the served bundle
      // contains, to check that minifying changed no behaviour. Tests that read js/** as text still read js/**.
      const twin = process.env.JE_TEST_MIN_TWINS === '1' ? resolve(jsRoot, '../min/js', path) : null;
      const file = twin && existsSync(twin) ? twin : resolve(jsRoot, path);
      const source = moduleSource(file);
      provideFeatureContext(window, source, path, { featureContext, shared: sharedModules });
      // Each IIFE is evaluated in this test's independent browser realm, as in the bundle.
      window.eval(source);
      return JE;
    },
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

/**
 * The English source strings with plugin.js's placeholder rules (and `_one` forms for a count of one), for
 * tests that read what a surface shows in English.
 */
const englishStrings = JSON.parse(readFileSync(resolve(jsRoot, 'locales/en.json'), 'utf8'));
export function englishT(key, params = {}) {
  const counted = params && ['count', 'days', 'n', 'items', 'hours', 'minutes', 'seconds'].find(name => typeof params[name] === 'number');
  const form = counted && params[counted] === 1 && englishStrings[`${key}_one`] ? `${key}_one` : key;
  return Object.entries(params || {}).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), englishStrings[form] ?? key);
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
