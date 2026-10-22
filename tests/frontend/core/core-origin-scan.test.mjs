// Stage 1 fix round 12: where an action's authority comes from (RBS1-R12-1, -2). Round 11 checked every write against the
// session it was bound to, right before it was sent; but the binding itself was taken late: after the action's own
// preparation (a metadata read, a dialog, a queue), so a continuation of A's action carried a fresh binding of B. And the
// configuration page's inline scripts were outside the scan entirely. This scan reads the client's sources (every .js file
// and every script of the configuration page) as syntax trees and checks, for every write:
//   W  a raw network write (fetch, any .ajax, ApiClient.fetch, a native ApiClient write command; a method or type it can't
//      read counts as a write) is sent from inside the one send of its kind: JE.core.userWrite.send/ajax in the scripts,
//      jeAdminSend/jeAdminFetch/jeAdminNative on the configuration page;
//   T  the transmit a send is handed sends at once: no await before its network call (an async transmit that waits first
//      would send after the check);
//   M  an origin is minted (JE.core.userWrite.origin/bind/originOf, JE.session.bind, jeOrigin) only at an action's start:
//      never after an await of the function it is in, never in a callback a promise, timer or frame runs later;
//   E  an action's entry point called after such a wait is handed the origin the caller took (an argument naming origin,
//      session or scope);
//   C  a core fetch write (JE.core.api.plugin/jf/fetch and their local aliases) names its origin (session:) or is a read
//      sent as POST (readOnly: true).
// Each rule has plants it must find and shapes it must accept. Runtime tests: features-action-origin, features-answer-owner,
// features-write-outcome, features-request-origin, pages-config-action-origin.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { jsRoot } from '../helpers/harness.mjs';
import { configPagePath } from '../helpers/config-page.mjs';

// @babel/parser ships with the istanbul-lib-instrument devDependency; resolve it through that package.
const { parse } = createRequire(createRequire(import.meta.url).resolve('istanbul-lib-instrument'))('@babel/parser');
const ast = source => parse(source, { sourceType: 'script', allowReturnOutsideFunction: true, errorRecovery: true });

/** Calls `visit(node, ancestors)` for every node. */
function walk(node, visit, ancestors = []) {
  if (!node || typeof node.type !== 'string') return;
  visit(node, ancestors);
  const next = [...ancestors, node];
  for (const [key, value] of Object.entries(node)) {
    if (key === 'loc' || key === 'start' || key === 'end' || key === 'extra' || key === 'leadingComments' || key === 'trailingComments') continue;
    if (Array.isArray(value)) value.forEach(child => walk(child, visit, next));
    else if (value && typeof value.type === 'string') walk(value, visit, next);
  }
}

const isFunction = node => !!node && (/Function/.test(node.type) || node.type === 'ObjectMethod' || node.type === 'ClassMethod');
/** a.b.c for a member chain (computed parts as []). */
const pathOf = node => !node ? '?' : node.type === 'Identifier' ? node.name : node.type === 'ThisExpression' ? 'this'
  : node.type === 'MemberExpression' || node.type === 'OptionalMemberExpression'
    ? `${pathOf(node.object)}.${node.computed ? '[]' : node.property.name}` : node.type === 'CallExpression' || node.type === 'OptionalCallExpression' ? `${pathOf(node.callee)}()` : '?';
const calleeName = call => { const p = pathOf(call.callee); return p.slice(p.lastIndexOf('.') + 1); };
const isCall = node => node && (node.type === 'CallExpression' || node.type === 'OptionalCallExpression');

/** The innermost function around a node (null: top level). */
const innermostFunction = ancestors => { for (let i = ancestors.length - 1; i >= 0; i--) if (isFunction(ancestors[i])) return { fn: ancestors[i], parent: ancestors[i - 1] }; return null; };

/** Awaits (and yields) of a function itself, not of the functions inside it. */
function ownAwaits(fn) {
  const found = [];
  walk(fn.body, (node, ancestors) => {
    if (node.type !== 'AwaitExpression' && node.type !== 'YieldExpression') return;
    if (ancestors.some(a => a !== fn && isFunction(a) && a !== fn.body)) {
      // Inside a nested function: not this one's.
      const nested = ancestors.findIndex(a => isFunction(a));
      if (nested !== -1) return;
    }
    found.push(node);
  });
  return found;
}

const DEFERRERS = new Set(['then', 'catch', 'finally', 'setTimeout', 'setInterval', 'requestAnimationFrame', 'requestIdleCallback', 'queueMicrotask']);

/**
 * Whether a node runs after a wait of the action it belongs to: after an await of its innermost function (one that ends
 * before it), or in a function a promise, timer or frame calls later.
 */
function deferred(node, ancestors) {
  const inner = innermostFunction(ancestors);
  if (!inner) return null;
  const { fn, parent } = inner;
  if (ownAwaits(fn).some(w => w.end <= node.start)) return 'after an await';
  if (isCall(parent) && parent.arguments.includes(fn) && DEFERRERS.has(calleeName(parent))) return `in a ${calleeName(parent)} callback`;
  return null;
}

// ---------------------------------------------------------------- what a write is

const NATIVE_WRITE = /^(update|delete|mark|send|create|reset|remove|post)[A-Z]\w*$/;
/** The value of a literal string (or a template without expressions). */
const literal = node => node?.type === 'StringLiteral' ? node.value : node?.type === 'TemplateLiteral' && node.expressions.length === 0 ? node.quasis[0].value.cooked : undefined;
/** Reads an options object: 'read' (GET/HEAD or none), 'write', or 'unknown' (a value it can't see). */
function verbOf(options, key) {
  if (!options) return 'read';
  if (options.type !== 'ObjectExpression') return 'unknown';
  let verdict = 'read';
  for (const prop of options.properties) {
    if (prop.type === 'SpreadElement') { verdict = 'unknown'; continue; }
    const name = prop.key?.name || prop.key?.value;
    if (name !== key) continue;
    const value = literal(prop.value);
    if (value === undefined) return 'unknown';
    return ['GET', 'HEAD'].includes(value.toUpperCase()) ? 'read' : 'write';
  }
  return verdict;
}
/** A raw network write call: its kind, or null. */
function rawWrite(call) {
  const path = pathOf(call.callee);
  const name = calleeName(call);
  if (path === 'fetch' || path === 'window.fetch') return verbOf(call.arguments[1], 'method') !== 'read' ? 'fetch' : null;
  if (name === 'ajax' && !/userWrite\.ajax$/.test(path)) return verbOf(call.arguments[0], 'type') !== 'read' ? 'ajax' : null;
  if (/ApiClient\.fetch$|apiClient\.fetch$/.test(path)) return verbOf(call.arguments[0], 'type') !== 'read' ? 'ApiClient.fetch' : null;
  if (/(^|\.)(ApiClient|apiClient|ac)$/.test(path.slice(0, path.lastIndexOf('.'))) && NATIVE_WRITE.test(name)) return 'native ' + name;
  return null;
}

const SENDS = { script: /(^|\.)userWrite\.(send|ajax)$/, page: /^jeAdmin(Send|Fetch|Native)$/ };
const MINTS = /(^|\.)(userWrite\.(origin|bind|originOf)|session\.bind)$|^jeOrigin$/;

// Entry points of actions: called after a wait, they must be handed the origin the caller took.
const ENTRIES = new Set(['updateSettings', 'patchUserSettings', 'saveUserSettings', 'setPersonalConsent', 'hideItem', 'unhideItem', 'unhideAll',
  'removeFromHomeSurface', 'requestMedia', 'requestTvSeasons', 'reportIssue', 'showSeasonSelectionModal', 'showMovieRequestModal',
  'showCollectionRequestModal', 'adminUnhideForUser', 'adminHideForUser', 'requestEntries', 'createPlaylist', 'createCollection', 'prefsCall',
  'setFollow', 'remind', 'markRead', 'setUserPrefs', 'enableForSeries', 'disableForSeries', 'enableForMovie', 'disableForMovie',
  'enableForCollection', 'disableForCollection', 'enableForTmdb', 'disableForTmdb', 'trackUsage', 'getEpisodes', 'syncBookmarks',
  'addBookmark', 'updateBookmark', 'deleteBookmark', 'deleteAllBookmarks', 'cleanupOrphanedBookmarks', 'jeSave', 'performMultiRemove',
  'saveGroup', 'cancelAll', 'askAgain', 'collectionAsk', 'adminSearch', 'familySearch']);
const ENTRY_PATHS = /(^|\.)(arrAsk\.(ask|cancel|adminSearch|familySearch)|bookmarks\.(add|update|delete|deleteAll|cleanupOrphaned))$/;
const CARRIES_ORIGIN = /\b(origin|session|scope|bound|binding)\b/;

// The implementations of the sends and of the core fetch's own network call: the writes they make are the send itself.
const IMPLEMENTATIONS = [
  ['core/api-client.js', 'fetchWithRetry'], ['core/mutation-queue.js', 'ajax'], ['page', 'jeAdminSend'], ['page', 'jeAdminFetch'], ['page', 'jeAdminNative']
];
// Raw requests that aren't a person's write (Q-REBUILD1FIX11-4), by file and a text of the call, with the reason.
const NOT_A_WRITE = [
  // Reads that send their list of ids in the body (no state changes on the server).
  ['arr/lists/list-grid.js', '/JellyfinEnhanced/acquire/lists/summaries'],
  ['tags/tag-pipeline.js', '/JellyfinEnhanced/tag-data/'],
  ['enhanced/itemdetails/features-details-media-info.js', '/JellyfinEnhanced/tag-data/'],
  // The live updates' long poll (a read of the person's events; ROUTE is the live route).
  ['arr/live/arr-live.js', 'ApiClient.getUrl(ROUTE)'],
  // The pause screen's item read (its one caller passes GET options).
  ['enhanced/player/pausescreen.js', 'fetch(url, options)'],
  // The configuration page: dry runs (nothing is changed: a preview of the Seerr move, of the usage report).
  ['page', '/JellyfinEnhanced/acquire/migration/seerr/preview'],
  ['page', '/JellyfinEnhanced/usage/preview'],
];

/** The violations of one source ('script' or 'page' kind). */
export function originViolations(file, source, kind = 'script') {
  const tree = ast(source);
  const found = [];
  const text = node => source.slice(node.start, node.end).replace(/\s+/g, ' ');
  const line = node => source.slice(0, node.start).split('\n').length;
  const report = (rule, node, why) => found.push({ file, rule, line: line(node), call: text(node).slice(0, 140), why });
  // Functions by name (a transmit handed by name), and the functions handed to a send.
  const named = new Map();
  walk(tree, (node, ancestors) => {
    if (node.type === 'FunctionDeclaration' && node.id) named.set(node.id.name, node);
    if (node.type === 'VariableDeclarator' && node.id?.type === 'Identifier' && isFunction(node.init)) named.set(node.id.name, node.init);
  });
  const sendTransmits = new Set();
  walk(tree, node => {
    if (!isCall(node) || !SENDS[kind].test(pathOf(node.callee))) return;
    for (const arg of node.arguments) {
      if (isFunction(arg)) sendTransmits.add(arg);
      else if (arg.type === 'Identifier' && named.has(arg.name)) sendTransmits.add(named.get(arg.name));
    }
  });
  const implementation = ancestors => ancestors.some((a, i) => isFunction(a) && IMPLEMENTATIONS.some(([f, n]) => (f === file || (f === 'page' && kind === 'page'))
    && (a.id?.name === n || (ancestors[i - 1]?.type === 'VariableDeclarator' && ancestors[i - 1].id.name === n)
      || ((ancestors[i - 1]?.type === 'ObjectProperty' || ancestors[i - 1]?.type === 'ObjectMethod') && (ancestors[i - 1].key?.name === n)) || (a.type === 'ObjectMethod' && a.key?.name === n))));
  walk(tree, (node, ancestors) => {
    if (!isCall(node)) return;
    const path = pathOf(node.callee);
    const name = calleeName(node);
    // W: a raw write inside its send.
    const write = rawWrite(node);
    if (write && !implementation(ancestors)) {
      const inSend = ancestors.some((a, i) => (isCall(a) && SENDS[kind].test(pathOf(a.callee)) && a.arguments.some(arg => arg.start <= node.start && node.end <= arg.end))
        || sendTransmits.has(a));
      const allowed = NOT_A_WRITE.some(([f, t]) => (f === file || (f === 'page' && kind === 'page')) && text(node).includes(t));
      if (!inSend && !allowed) report('W', node, `${write} outside the send`);
    }
    // M: a mint at an action's start only.
    if (MINTS.test(path) && !/^(mintOrigin|bind|jeOrigin)$/.test(innermostName(ancestors))) {
      const late = deferred(node, ancestors);
      if (late) report('M', node, `origin minted ${late}`);
    }
    // E: an entry point after a wait is handed its origin.
    if ((ENTRIES.has(name) || ENTRY_PATHS.test(path)) && !/^function/.test(text(node))) {
      const late = deferred(node, ancestors);
      if (late && !node.arguments.some(arg => CARRIES_ORIGIN.test(text(arg)))) report('E', node, `entry point called ${late} without the origin`);
    }
    // C: a core fetch write names its origin.
    if (/(^|\.)core\.api\.(plugin|jf|fetch)$/.test(path) || (['jf', 'request', 'api'].includes(path) && node.arguments.length === 2)) {
      const options = node.arguments[1];
      if (options && verbOf(options, 'method') !== 'read') {
        const props = options.type === 'ObjectExpression' ? options.properties.map(p => p.key?.name || p.key?.value) : [];
        if (options.type === 'ObjectExpression' && !props.includes('session') && !props.includes('readOnly')
          && !options.properties.some(p => p.type === 'SpreadElement')) report('C', node, 'core fetch write without its origin');
      }
    }
  });
  // T: a send's transmit sends at once (no await before its network call).
  for (const fn of sendTransmits) {
    const awaits = ownAwaits(fn);
    if (!awaits.length) continue;
    let firstNetwork = Infinity;
    walk(fn.body, n => { if (isCall(n) && (rawWrite(n) || /fetchWithRetry$|\.fetch$|^fetch$|\.ajax$/.test(pathOf(n.callee)))) firstNetwork = Math.min(firstNetwork, n.start); });
    const early = awaits.find(w => w.start < firstNetwork && !(isCall(w.argument) && w.argument.start <= firstNetwork && firstNetwork < w.argument.end));
    if (early) report('T', early, 'the transmit waits before it sends');
  }
  return found;

  function innermostName(ancestors) {
    const inner = innermostFunction(ancestors);
    if (!inner) return '';
    const { fn, parent } = inner;
    return fn.id?.name || (parent?.type === 'VariableDeclarator' ? parent.id.name : '') || ((parent?.type === 'ObjectProperty') ? (parent.key?.name || '') : '') || (fn.type === 'ObjectMethod' ? fn.key?.name : '');
  }
}

function scriptSources() {
  const files = [];
  const visit = dir => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) { if (name !== 'locales') visit(path); } else if (name.endsWith('.js')) files.push(path);
    }
  };
  visit(jsRoot);
  return files.map(path => [relative(jsRoot, path), readFileSync(path, 'utf8')]);
}
/** Every script of the configuration page (head and body), in page order. */
function pageScripts() {
  const source = readFileSync(configPagePath, 'utf8');
  return [...source.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m, i) => [`configPage.html#script${i}`, m[1]]);
}
const shown = v => `${v.file}:${v.line} [${v.rule}] ${v.why}: ${v.call}`;

test('R12 scan: every script\'s writes are sent through JE.core.userWrite, from an origin taken at the action\'s start', () => {
  const found = scriptSources().flatMap(([file, source]) => originViolations(file, source, 'script')).map(shown);
  assert.deepEqual(found, [], `origin violations:\n${found.join('\n')}`);
});

test('R12 scan: the configuration page\'s inline scripts send every write through its own origin-checked send', () => {
  const scripts = pageScripts();
  assert.ok(scripts.length >= 2, 'the page has its scripts');
  const found = scripts.flatMap(([file, source]) => originViolations(file, source, 'page')).map(shown);
  assert.deepEqual(found, [], `origin violations:\n${found.join('\n')}`);
  // Every listed read sent as POST still names a raw request (an entry that matches nothing any more is removed).
  const all = [...scriptSources().map(([f, s]) => [f, s, 'script']), ...scripts.map(([f, s]) => [f, s, 'page'])];
  for (const [file, text] of NOT_A_WRITE) {
    assert.ok(all.some(([f, s, k]) => (f === file || (file === 'page' && k === 'page')) && s.includes(text)), `${file}: ${text}`);
  }
});

test('R12 scan finds planted origin escapes, and accepts the permitted shapes', () => {
  const plants = [
    // W: an inline page write sent with Jellyfin's ApiClient directly.
    ['page', "async function save(patch) { await ApiClient.ajax({ type: 'PATCH', url: u, data: JSON.stringify(patch) }); }"],
    // W: a computed verb outside the send.
    ['page', "function hook(what) { return ApiClient.ajax({ type: what === 'add' ? 'POST' : 'DELETE', url: u }); }"],
    // W: a native ApiClient write command.
    ['page', "function store(c) { return ApiClient.updatePluginConfiguration(pluginId, c); }"],
    // W: a script's raw write after an await, outside JE.core.userWrite.
    ['script', "async function hide(id) { await flush(); return ApiClient.ajax({ type: 'POST', url: ApiClient.getUrl('/x/' + id) }); }"],
    // T: an async transmit that waits before it sends (the check would come before the wait).
    ['page', "function imp(origin) { return jeAdminNative(origin, async () => { await prepare(); return ApiClient.fetch({ type: 'POST', url: u }); }, 'x'); }"],
    ['script', "function save(b) { return JE.core.userWrite.send(b, async () => { await JE.whenLoaded(); return fetch(u, { method: 'POST' }); }, 'x'); }"],
    // M: an origin minted after the action's own wait.
    ['script', "async function hideShow(id) { const series = await getItem(id); const origin = JE.core.userWrite.origin(); return send(origin, series); }"],
    // M: minted in a callback a promise runs later.
    ['script', "function swipe() { lookup().then(seasons => { const origin = JE.core.userWrite.bind(); mark(origin, seasons); }); }"],
    // M: the page's mint in a timer.
    ['page', "function later() { setTimeout(function() { var origin = jeOrigin(); jeAdminSend(origin, { type: 'POST', url: u }); }, 10); }"],
    // E: an entry point after a wait without the origin (it would mint the next person's).
    ['script', "async function onShow(id) { const s = await getItem(id); JE.hiddenContent.hideItem({ itemId: s.Id }); }"],
    ['script', "async function search(key) { const found = await JE.arrAsk.familySearch(key, { session: origin }); if (!found) return JE.arrAsk.ask(input); }"],
    // C: a core fetch write without its origin.
    ['script', "function log(ev) { return JE.core.api.plugin('/catchup/event', { method: 'POST', body: ev }); }"]
  ];
  for (const [kind, plant] of plants) assert.equal(originViolations('plant.js', plant, kind).length, 1, `${kind}: ${plant}\n${originViolations('plant.js', plant, kind).map(shown).join('\n')}`);
  for (const [kind, ok] of [
    ['page', "function save(origin, patch) { return jeAdminSend(origin, { type: 'PATCH', url: u, data: JSON.stringify(patch) }); }"],
    ['page', "async function act() { var origin = jeOrigin(); await jeSave(origin); return jeAdminSend(origin, { type: 'POST', url: u }); }"],
    ['page', "function imp(origin) { return jeAdminNative(origin, () => ApiClient.fetch({ type: 'POST', url: u }), 'x'); }"],
    ['page', "function read() { return ApiClient.ajax({ type: 'GET', url: u, dataType: 'json' }); }"],
    ['script', "function click() { const origin = JE.core.userWrite.origin(); lookup().then(s => mark(s, origin)); }"],
    ['script', "async function hideShow(id, origin) { origin = JE.core.userWrite.originOf(origin); const s = await getItem(id); JE.hiddenContent.hideItem({ itemId: s.Id }, origin); }"],
    ['script', "function log(ev, origin) { return JE.core.api.plugin('/catchup/event', { method: 'POST', body: ev, session: origin }); }"],
    ['script', "function preview(ids) { return JE.core.api.plugin('/x/preview', { method: 'POST', body: ids, readOnly: true }); }"],
    ['script', "function save(b) { return JE.core.userWrite.send(b, async () => { const r = await fetch(u, { method: 'POST' }); return r.json(); }, 'x'); }"]
  ]) assert.deepEqual(originViolations('ok.js', ok, kind).map(shown), [], `${kind}: ${ok}`);
});
