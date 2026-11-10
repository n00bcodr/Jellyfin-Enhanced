// canopy K1b, checked on the committed outputs and in fixture builds:
// - each module of client/shared-modules.json is inlined by exactly one component script, its provider, which
//   publishes it; every other component script that uses it carries a stub and loads after the provider;
// - shared modules hold no state: no top-level state in their runtime import closure (the build's own check), and no
//   client source mutates one of their top-level object, array or collection bindings;
// - the build rejects a stateful module and a consumer listed before its provider.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import { buildClient, minDirectory, repositoryRoot } from '../../scripts/client-build.mjs';
import { analyseSharedModule, sharedModuleId, statefulTopLevel } from '../../scripts/client/shared-modules.mjs';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const esbuild = require('esbuild');
const plugin = join(repositoryRoot, 'Jellyfin.Plugin.JellyfinEnhanced');
const manifest = JSON.parse(readFileSync(join(repositoryRoot, 'client/shared-modules.json'), 'utf8'));
const modules = Object.entries(manifest.modules).map(([source, provider]) => ({ source, provider: provider.slice('js/'.length) }));
const componentScripts = JSON.parse(readFileSync(join(plugin, 'js/component-scripts.json'), 'utf8'))
  .map(item => item.trim()).filter(item => item && !item.startsWith('//'));
const read = path => readFileSync(join(plugin, path), 'utf8');

test('each shared module is inlined once, by its provider, and every script reading the published copy loads after it', () => {
  assert.ok(modules.length >= 20, `expected the shared modules, found ${modules.length}`);
  for (const { source, provider } of modules) {
    // esbuild labels each module of a readable output with its path; stubs carry the generated-module label instead.
    const carriers = componentScripts.filter(path => read(`js/${path}`).includes(`\n  // ${source}\n`));
    assert.deepEqual(carriers, [provider], `${source}: inlined by`);
    const id = JSON.stringify(sharedModuleId(source));
    for (const tree of ['js', `${minDirectory}/js`]) {
      assert.ok(read(`${tree}/${provider}`).includes(`${id}:`), `${tree}/${provider} publishes ${source}`);
    }
    const consumers = componentScripts.filter(path => read(`js/${path}`).includes(`\n  // client/generated-shared/stub/${source}\n`));
    assert.ok(consumers.length >= 1, `${source}: no consumer`);
    for (const path of consumers) {
      assert.ok(componentScripts.indexOf(path) > componentScripts.indexOf(provider), `${path} loads before ${provider}`);
      assert.ok(read(`${minDirectory}/js/${path}`).includes(id), `${minDirectory}/js/${path} reads ${id}`);
    }
  }
});

test('outside the component scripts nothing reads a shared module (contracts/bootstrap.js keeps its own schema)', () => {
  const walk = dir => require('node:fs').readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? walk(join(dir, entry.name)) : [relative(join(plugin, 'js'), join(dir, entry.name)).split('\\').join('/')]);
  const readers = walk(join(plugin, 'js')).filter(path => path.endsWith('.js') && !componentScripts.includes(path) && read(`js/${path}`).includes('// client/generated-shared/stub/'));
  assert.deepEqual(readers, []);
  assert.ok(read('js/contracts/bootstrap.js').includes('\n  // client/src/contracts/schema.ts\n'));
});

/** Every top-level const of `files` bound to an object, array or collection: what could be shared mutable state. */
function mutableBindings(program, checker, files) {
  const targets = new Map();
  for (const file of files) {
    for (const statement of program.getSourceFile(join(repositoryRoot, file)).statements) {
      if (!ts.isVariableStatement(statement)) continue;
      for (const declaration of statement.declarationList.declarations) {
        let value = declaration.initializer;
        while (value && (ts.isAsExpression(value) || ts.isSatisfiesExpression(value) || ts.isParenthesizedExpression(value))) value = value.expression;
        if (!value || !ts.isIdentifier(declaration.name)) continue;
        if (ts.isObjectLiteralExpression(value) || ts.isArrayLiteralExpression(value) || ts.isNewExpression(value) || ts.isCallExpression(value)) {
          targets.set(checker.getSymbolAtLocation(declaration.name), `${file}:${declaration.name.text}`);
        }
      }
    }
  }
  return targets;
}

test('shared modules hold no state: nothing at top level, and no client source mutates their constant tables', async () => {
  const closure = new Set();
  for (const { source } of modules) for (const file of (await analyseSharedModule(esbuild, repositoryRoot, source)).closure) closure.add(file);
  assert.deepEqual(statefulTopLevel(ts, repositoryRoot, [...closure], manifest.reviewed), []);

  const config = ts.readConfigFile(join(repositoryRoot, 'client/tsconfig.json'), ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, join(repositoryRoot, 'client'));
  const program = ts.createProgram(parsed.fileNames, { ...parsed.options, noEmit: true });
  const checker = program.getTypeChecker();
  const targets = mutableBindings(program, checker, [...closure]);
  assert.ok(targets.size > 10, 'the constant tables were found');
  const MUTATORS = new Set(['push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse', 'fill', 'copyWithin', 'set', 'add', 'delete', 'clear']);
  const ASSIGN = node => ts.isBinaryExpression(node.parent) && node.parent.left === node
    && node.parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment;
  const mutations = [];
  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile) continue;
    (function visit(node) {
      if (ts.isIdentifier(node)) {
        let symbol = checker.getSymbolAtLocation(node);
        if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
        const name = symbol && targets.get(symbol);
        if (name) {
          // The binding itself or any member path under it, e.g. TABLE.a.b.
          let top = node;
          while ((ts.isPropertyAccessExpression(top.parent) || ts.isElementAccessExpression(top.parent)) && top.parent.expression === top) {
            if (ts.isPropertyAccessExpression(top.parent) && ts.isCallExpression(top.parent.parent) && top.parent.parent.expression === top.parent
              && MUTATORS.has(top.parent.name.text)) mutations.push(`${name}: .${top.parent.name.text}() at ${relative(repositoryRoot, sf.fileName)}`);
            top = top.parent;
          }
          const parent = top.parent;
          const where = `${relative(repositoryRoot, sf.fileName)}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}`;
          if (top !== node && ASSIGN(top)) mutations.push(`${name}: assigned at ${where}`);
          if (ts.isDeleteExpression(parent) || ((ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent))
            && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(parent.operator))) mutations.push(`${name}: updated at ${where}`);
          if (ts.isCallExpression(parent) && parent.arguments[0] === top
            && /^Object\.(assign|defineProperty|defineProperties|setPrototypeOf)$/.test(parent.expression.getText(sf))) mutations.push(`${name}: ${parent.expression.getText(sf)} at ${where}`);
        }
      }
      ts.forEachChild(node, visit);
    })(sf);
  }
  assert.deepEqual(mutations, []);
});

test('statefulTopLevel reports module state and accepts constants, functions and reviewed bindings', t => {
  const root = mkdtempSync(join(tmpdir(), 'je-shared-state-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (path, content) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), content); };
  put('a.ts', [
    "import type { X } from './x';", 'export type Y = X;', 'export interface Z { a: number }',
    'export function f() { return 1; }', 'export const g = () => 2;', "export const T = Object.freeze({ a: 1, b: 'x', c: [1, 2] });",
    'export const R = /a/i;', 'export const N = -1;', 'const tpl = `x${N}`;',
  ].join('\n'));
  put('b.ts', [
    'let counter = 0;', 'export const cache = new Map();', 'const W = new WeakMap();', 'export class E extends Error {}',
    "if (typeof window === 'undefined') throw new Error('no window');", 'const G = /a/g;', 'const built = make();', 'function make() { return {}; }',
  ].join('\n'));
  assert.deepEqual(statefulTopLevel(ts, root, ['a.ts']), []);
  assert.deepEqual(statefulTopLevel(ts, root, ['b.ts']).map(finding => finding.split(': ').slice(1, 2)[0]), [
    'counter', 'cache', 'W', 'E', 'line 5', 'G', 'built']);
  assert.deepEqual(statefulTopLevel(ts, root, ['b.ts'], { 'b.ts': { bindings: ['E', 'bu*'], reason: 'reviewed' } }).length, 5);
});

/** A tiny project with two component scripts reading one module. */
function fixture(t, order, moduleSource = 'export const greet = (name: string) => `hi ${name}`;\nexport const unused = 1;\n') {
  const root = mkdtempSync(join(tmpdir(), 'je-shared-build-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (path, content) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), content); };
  put('client/tsconfig.json', readFileSync(join(repositoryRoot, 'client/tsconfig.json')));
  put('client/src/host/context.ts', readFileSync(join(repositoryRoot, 'client/src/host/context.ts')));
  put('client/src/contracts/generated.ts', 'export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };\n');
  put('client/src/greet.ts', moduleSource);
  put('client/src/first.ts', "import { greet } from './greet';\n(window as unknown as { first: string }).first = greet('first');\n");
  put('client/src/second.ts', "import { greet } from './greet';\n(window as unknown as { second: string }).second = greet('second');\n");
  put('client/entries/core.json', JSON.stringify({ 'js/a/first.js': 'client/src/first.ts', 'js/a/second.js': 'client/src/second.ts' }));
  if (order) put('Jellyfin.Plugin.JellyfinEnhanced/js/component-scripts.json', JSON.stringify(order));
  put('client/shared-modules.json', JSON.stringify({ modules: { 'client/src/greet.ts': 'js/a/first.js' } }));
  return { root, put, js: path => readFileSync(join(root, 'Jellyfin.Plugin.JellyfinEnhanced', path), 'utf8') };
}

test('a fixture build ships the module once: the provider publishes, the consumer reads it, and both run', async t => {
  const f = fixture(t, ['a/first.js', 'a/second.js']);
  await buildClient({ root: f.root });
  for (const tree of ['js', `${minDirectory}/js`]) {
    const window = { JellyfinEnhanced: {} };
    window.window = window;
    runInNewContext(f.js(`${tree}/a/first.js`), window);
    const registry = window.JellyfinEnhanced.core.sharedModules;
    assert.deepEqual(Object.keys(window.JellyfinEnhanced.core), [], `${tree}: published non-enumerable`);
    assert.equal(typeof registry.greet.greet, 'function');
    const published = registry.greet;
    runInNewContext(f.js(`${tree}/a/second.js`), window);
    assert.deepEqual([window.first, window.second], ['hi first', 'hi second']);
    assert.equal(registry.greet, published);
    runInNewContext(f.js(`${tree}/a/first.js`), window);
    assert.equal(registry.greet, published, `${tree}: a second publish keeps the existing copy`);
  }
  assert.doesNotMatch(f.js('js/a/second.js'), /`hi \$\{name\}`/, 'the consumer does not inline the module');
  assert.doesNotMatch(f.js(`${minDirectory}/js/a/second.js`), /"unused"/, 'an export nobody imports costs the consumer nothing');
  const lonely = { JellyfinEnhanced: {} };
  lonely.window = lonely;
  assert.throws(() => runInNewContext(f.js('js/a/second.js'), lonely), /greet is not in JE\.core\.sharedModules: load its provider first/);
  await buildClient({ root: f.root, check: true });
});

test('the build rejects a consumer listed before its provider, and a module with state', async t => {
  const early = fixture(t, ['a/second.js', 'a/first.js']);
  await assert.rejects(buildClient({ root: early.root }), /js\/a\/second\.js uses client\/src\/greet\.ts but loads before its provider js\/a\/first\.js/);
  const stateful = fixture(t, ['a/first.js', 'a/second.js'], 'let calls = 0;\nexport const greet = (name: string) => `hi ${name} ${++calls}`;\n');
  await assert.rejects(buildClient({ root: stateful.root }), /client\/src\/greet\.ts: calls: a let\/var binding/);
});

test('a tree without js/component-scripts.json has no component scripts, so nothing is shared', async t => {
  const f = fixture(t, null);
  await buildClient({ root: f.root });
  assert.match(f.js('js/a/second.js'), /`hi \$\{name\}`/, 'each output inlines the module, as before K1b');
  await buildClient({ root: f.root, check: true });
});
