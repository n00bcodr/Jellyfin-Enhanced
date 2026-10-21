// Every browser cache of a server answer in the production client (review round 4 of the user-change caches): a value
// kept across calls (a Map, WeakMap, Set, object or array, or a `let` holding an answer, declared at a module's top
// level or in its outer function, or held by a closure: declared in a factory and written by a function inside it,
// which keeps it across that function's calls) that is written in a function that awaits a read (a server read, or an
// asynchronous source the closure was handed, such as a factory's resolveItems). Each one is listed in
// tests/fixtures/user-caches/js-caches.tsv with how it follows the signed-in person's access, so a new memo of an
// answer the server projected for the person can't be missed.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative } from 'node:path';
import { repositoryRoot } from './discovery.mjs';

const require = createRequire(join(repositoryRoot, 'package.json'));
const { parse } = require('@babel/parser');
const traverse = require('@babel/traverse').default;

export const jsRoot = join(repositoryRoot, 'Jellyfin.Plugin.JellyfinEnhanced', 'js');
export const registryPath = join(repositoryRoot, 'tests', 'fixtures', 'user-caches', 'js-caches.tsv');

/** How a listed browser cache follows the person's access (see the registry's header). */
export const classes = ['uncached', 'revisioned', 'document', 'revalidated', 'shared', 'own', 'item', 'account', 'state'];

// A call that reads from a server (JE's API client, Jellyfin's ApiClient, fetch, the Seerr/TMDB wrappers).
const SERVER = /(fetch|ajax|plugin|getJSON|managedFetch|tmdbGet|\bget|request|api\.)\w*\s*\(/;
// An asynchronous source handed to a factory (spec.resolveItems, options.load…), awaited by its closure.
const HANDED = /await\s+(\w+\.)+(resolve|load|read|get|fetch)\w*\s*\(/;

/** Every production .js file under js/, relative to it. */
export function files() {
  const found = [];
  (function walk(folder) {
    for (const name of readdirSync(folder)) {
      const path = join(folder, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (path.endsWith('.js')) found.push(relative(jsRoot, path).split('\\').join('/'));
    }
  })(jsRoot);
  return found.sort();
}

/**
 * The caches of server answers in one source file.
 * @param {string} file Path under js/.
 * @param {string} [source] The source (the file on disk when omitted).
 * @returns {{file: string, name: string, kind: string, line: number}[]} The caches.
 */
export function cachesIn(file, source = readFileSync(join(jsRoot, file), 'utf8')) {
  const ast = parse(source, { sourceType: 'script', errorRecovery: true });
  const persistent = [];
  traverse(ast, {
    VariableDeclarator(path) {
      const init = path.node.init;
      if (!init || path.node.id.type !== 'Identifier') return;
      const collection = init.type === 'NewExpression' && ['Map', 'WeakMap', 'Set'].includes(init.callee.name);
      const object = init.type === 'ObjectExpression' && init.properties.length === 0;
      const array = init.type === 'ArrayExpression' && init.elements.length === 0;
      const slot = path.parent.kind === 'let' && (init.type === 'NullLiteral' || (init.type === 'Identifier' && init.name === 'undefined'));
      if (!collection && !object && !array && !slot) return;
      // At the top level or in the module's outer function, it outlives each call. Deeper (a factory's state), it is
      // kept when a function inside the declaring one writes it (that closure keeps it across its own calls).
      const declaredIn = path.getFunctionParent();
      const depth = path.getAncestry().filter(a => a.isFunction()).length;
      persistent.push({ name: path.node.id.name, kind: collection ? init.callee.name : object ? 'object' : array ? 'array' : 'let', line: path.node.loc.start.line, binding: path.scope.getBinding(path.node.id.name), declaredIn, closure: depth > 1 });
    },
  });
  const found = [];
  // Browser storage written in a function that reads the server: kept across page loads.
  traverse(ast, {
    CallExpression(path) {
      const callee = path.node.callee;
      if (callee.type !== 'MemberExpression' || callee.property.name !== 'setItem') return;
      const store = callee.object.type === 'Identifier' ? callee.object.name : callee.object.type === 'MemberExpression' ? callee.object.property.name : '';
      if (!['localStorage', 'sessionStorage'].includes(store)) return;
      const readsServer = path.getAncestry().filter(a => a.isFunction()).slice(0, -1).some(fn => {
        const body = source.slice(fn.node.start, fn.node.end);
        return /await|\.then\(/.test(body) && SERVER.test(body);
      });
      const key = path.node.arguments[0] ? source.slice(path.node.arguments[0].start, path.node.arguments[0].end).replace(/\s+/g, ' ').slice(0, 60) : '?';
      if (readsServer) found.push({ file, name: `${store}:${key}`, kind: 'storage', line: path.node.loc.start.line });
    },
  });
  for (const { name, kind, line, binding, declaredIn, closure } of persistent) {
    if (!binding) continue;
    const writers = [];
    for (const ref of binding.referencePaths) {
      const parent = ref.parentPath;
      const member = parent.isMemberExpression() && parent.node.object === ref.node;
      const call = member && parent.parentPath.isCallExpression() && ['set', 'add'].includes(parent.node.property.name);
      const assigned = member && parent.parentPath.isAssignmentExpression() && parent.parentPath.node.left === parent.node;
      if (call || assigned) writers.push(ref);
    }
    writers.push(...binding.constantViolations);
    // The functions between a write and the declaration (for module state: below the module's own outer function).
    const between = w => {
      const fns = w.getAncestry().filter(a => a.isFunction());
      if (!closure) return fns.slice(0, -1);
      const at = fns.findIndex(fn => fn.node === declaredIn?.node);
      return at < 0 ? [] : fns.slice(0, at);
    };
    // A closure's state counts only when a function inside the declaring one writes it.
    if (closure && !writers.some(w => between(w).length > 0)) continue;
    // Written in a function (or a callback inside one) that awaits a read: a server read, or (closure state) any
    // awaited source the closure was handed.
    const fromServer = writers.some(w => between(w).some(fn => {
      const body = source.slice(fn.node.start, fn.node.end);
      return /await|\.then\(/.test(body) && (SERVER.test(body) || (closure && HANDED.test(body)));
    }));
    if (fromServer) found.push({ file, name, kind, line });
  }
  return found;
}

/** Every cache of a server answer in the client. */
export function inventory() {
  return files().flatMap(file => cachesIn(file));
}

/** The registry rows: {file, name, class, reason}. */
export function registry() {
  return readFileSync(registryPath, 'utf8').split('\n').filter(l => l && !l.startsWith('#')).map(l => {
    const [file, name, cls, reason] = l.split('\t');
    return { file, name, class: cls, reason: reason ?? '' };
  });
}

/**
 * What is wrong with the registry against an inventory (empty: nothing): an unlisted cache, a row whose cache is gone,
 * an unknown class or no reason, a cache said to be dropped on an access-revision change whose file doesn't listen
 * for one, a document mirror whose file doesn't follow its document's revision.
 * @param {{file: string, name: string}[]} found The inventory.
 * @param {ReturnType<typeof registry>} rows The registry.
 * @param {(file: string) => string} [read] Reads a file's source.
 * @returns {string[]} Problems.
 */
export function problems(found, rows, read = file => readFileSync(join(jsRoot, file), 'utf8')) {
  const listed = new Map(rows.map(r => [`${r.file}\t${r.name}`, r]));
  const out = [];
  for (const row of rows) {
    if (!classes.includes(row.class)) out.push(`${row.file} ${row.name}: unknown class ${row.class}`);
    if (!row.reason.trim()) out.push(`${row.file} ${row.name}: no reason`);
    if (row.class === 'revisioned' && !/je-access-revision|serverFilterRevision/.test(read(row.file)))
      out.push(`${row.file} ${row.name}: listed as revisioned, but the file never follows the server's access revision`);
    if (row.class === 'document' && !/je-document-revision/.test(read(row.file)))
      out.push(`${row.file} ${row.name}: listed as a document mirror, but the file never follows the document's revision`);
  }
  for (const cache of found) {
    if (!listed.has(`${cache.file}\t${cache.name}`))
      out.push(`${cache.file}:${cache.line} ${cache.name} (${cache.kind}): a browser cache of a server answer nobody listed; if the server projects the answer for the person (access, parental limits, Seerr account), don't keep it or drop it when their access revision moves`);
  }
  const names = new Set(found.map(c => `${c.file}\t${c.name}`));
  for (const row of rows) if (!names.has(`${row.file}\t${row.name}`)) out.push(`${row.file} ${row.name}: listed, but the client has no such cache`);
  return out;
}

/** The response-cache key prefixes the client uses (cacheKey options and direct setCache calls), by file. */
export function responseCacheKeys() {
  const keys = [];
  for (const file of files()) {
    const source = readFileSync(join(jsRoot, file), 'utf8');
    for (const match of source.matchAll(/cacheKey\s*[:=][^;\n]*?[`'"]([A-Za-z][\w-]*):/g)) keys.push({ file, prefix: match[1] + ':' });
  }
  return keys;
}
