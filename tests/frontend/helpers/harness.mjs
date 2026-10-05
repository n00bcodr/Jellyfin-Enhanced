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
  const allowedErrors = [...expectedConsoleErrors];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('error', (...args) => {
    const message = args.map(String).join(' ');
    if (!allowedErrors.some(pattern => typeof pattern === 'string' ? message.includes(pattern) : pattern.test(message))) {
      errors.push(new Error(`Unexpected console.error: ${message}`));
    }
  });
  virtualConsole.on('jsdomError', error => errors.push(error));
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, {
    url, runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole
  });
  const { window } = dom;
  // Modules loaded by the host bundle run after the document is ready.
  Object.defineProperty(window.document, 'readyState', { configurable: true, value: 'complete' });
  window.JellyfinEnhanced = JE;
  window.ApiClient = {
    getCurrentUserId: () => 'user-a', accessToken: () => 'test-token', serverId: () => 'server-a',
    getUrl: path => `http://jellyfin.test${path.startsWith('/') ? '' : '/'}${path}`, ...apiClient
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
    expectConsoleError(pattern) { allowedErrors.push(pattern); },
    load(path) {
      const file = resolve(jsRoot, path);
      let source = readFileSync(file, 'utf8');
      if (process.env.JE_COVERAGE_DIR) source = createInstrumenter().instrumentSync(source, file);
      window.eval(`${source}\n//# sourceURL=${file}`);
      return JE;
    },
    close() {
      if (window.__coverage__) collected.merge(window.__coverage__);
      window.close();
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
