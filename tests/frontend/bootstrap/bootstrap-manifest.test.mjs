import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { createHarness, jsRoot } from '../helpers/harness.mjs';

// @babel/parser ships with the istanbul-lib-instrument devDependency; resolve it through that package.
const { parse } = createRequire(createRequire(import.meta.url).resolve('istanbul-lib-instrument'))('@babel/parser');
const manifestFiles = () => JSON.parse(readFileSync(resolve(jsRoot, 'component-scripts.json'), 'utf8')).filter(entry => !entry.startsWith('//'));

/**
 * Dev mode and the fallback loader run each module as its own classic script, unwrapped, so its
 * top level must be exactly one IIFE: no directive, declaration or other statement there.
 * @param {string} source The module's source.
 * @param {string} filename Its path, for error messages.
 * @returns {string|null} What breaks the rule, or null.
 */
function unwrappedProblem(source, filename) {
  try { new vm.Script(source, { filename }); } catch (error) { return `does not compile as a classic script: ${error.message}`; }
  const { program } = parse(source, { sourceType: 'script' });
  if (program.directives.length) return `has a top-level ${program.directives[0].value.value} directive`;
  const [statement, ...rest] = program.body;
  if (rest.length || statement?.type !== 'ExpressionStatement') return `top level is ${program.body.map(node => node.type).join(', ') || 'empty'}, not one IIFE`;
  const call = statement.expression;
  if (call.type !== 'CallExpression' || !['FunctionExpression', 'ArrowFunctionExpression'].includes(call.callee.type)) return `top-level expression is ${call.type}, not an IIFE`;
  return null;
}

// The production bundle runs every js/component-scripts.json entry in order, each wrapped
// in its own function (Services/ClientScriptBundle.cs); the harness load() uses that
// wrapper. Host stubs are only what plugin.js provides before the component stage.
test('every manifest module loads in bundle order without load-time errors', async t => {
  const manifest = manifestFiles();
  assert.ok(manifest.length > 100);
  const cdnUrl = (source, path) => `http://jellyfin.test/JellyfinEnhanced/cdn/${source}/${path}`;
  const h = createHarness({
    JE: {
      pluginConfig: {}, userConfig: {}, translations: {}, currentSettings: {}, state: { activeShortcuts: {} },
      t: key => key, icon: () => '', IconName: {}, escapeHtml: value => String(value ?? ''),
      cdn: { url: cdnUrl, selfhst: file => cdnUrl('selfhst', file), flagPng: code => cdnUrl('flagcdn', code), flagSvg: code => cdnUrl('flag-icons', code), font: name => `http://jellyfin.test/JellyfinEnhanced/fonts/${name}` }
    },
    // jsdom lacks ResizeObserver; every supported browser has it.
    globals: { ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } }
  });
  t.after(() => h.close());
  const failures = [];
  for (const path of manifest) {
    try { h.load(path); } catch (error) { failures.push(`${path}: ${error?.message ?? error}`); }
  }
  // Let deferred startup work (timers, promise chains) run inside the window, so an error it
  // throws is reported by close() instead of being lost when the realm is torn down.
  await new Promise(done => setTimeout(done, 300));
  assert.deepEqual(failures, []);
});

test('every manifest module is a single top-level IIFE when loaded unwrapped', () => {
  const problems = manifestFiles().map(path => [path, unwrappedProblem(readFileSync(resolve(jsRoot, path), 'utf8'), path)]).filter(([, problem]) => problem);
  assert.deepEqual(problems, []);
});
