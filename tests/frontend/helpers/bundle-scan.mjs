import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createRequire } from 'node:module';
import { jsRoot } from './harness.mjs';

// D46 slice 2 review round 6: the whole-bundle scans behind features-title-actions-writes-scan.
// Shape 2 (fail closed): every call of every transport entry point in js/ (the core transport JE.core.api.*, fetch,
// ApiClient.*, XMLHttpRequest, navigator.sendBeacon, and any alias of them) is a site. A site is a READ only when it is
// provably GET; its options must be an inline literal, a same-function const literal, or forwarded to its callers (whose
// calls become sites); a write passes only with `bound`; anything else is "unmodelled" and fails.
// Shape 1 (explicit ownership): every call of an owner-taking function (an opener or an owned write) passes its owner
// argument; an owner taken from the enclosing function's parameter makes that function's callers sites too.
// Review round 7: inside a HANDLER (a listener, an on* property, a modal's onSave, a title action's run) the owner is
// its PRESS argument, nothing else (a node, a closure value, an enclosing function's parameter fail); JE.NATIVE and an
// owner taken from a node outside a handler only at pinned roots; host dialogs (Dashboard.alert/confirm, alert,
// confirm, prompt) only through JE.openHostDialog. The transport scan fails closed on what it cannot resolve: a
// computed member on a transport root that is not a constant, a transport method through call/apply/bind, and a
// transport value escaping into anything but a const alias.

// @babel/parser ships with the istanbul-lib-instrument devDependency; resolve it through that package.
const { parse } = createRequire(createRequire(import.meta.url).resolve('istanbul-lib-instrument'))('@babel/parser');

const cache = new Map();
/** The AST of a source text (cached by text). */
export function parsed(text) {
  if (!cache.has(text)) cache.set(text, parse(text, { sourceType: 'script', errorRecovery: false }));
  return cache.get(text);
}

/** Every module under js/ except the locales, by path relative to js/. */
export function readSources() {
  const out = {};
  (function read(dir) {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) { if (name !== 'locales') read(path); } else if (name.endsWith('.js')) out[relative(jsRoot, path)] = readFileSync(path, 'utf8');
    }
  })(jsRoot);
  return out;
}

const FUNCTION = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression', 'ObjectMethod', 'ClassMethod']);
const CALL = new Set(['CallExpression', 'OptionalCallExpression', 'NewExpression']);
const MEMBER = new Set(['MemberExpression', 'OptionalMemberExpression']);
const keyName = p => p?.key?.name ?? p?.key?.value;
const isUndefined = n => !n || (n.type === 'Identifier' && n.name === 'undefined') || n.type === 'NullLiteral' || (n.type === 'UnaryExpression' && n.operator === 'void');

/**
 * The dotted path of an expression (`window.ApiClient.ajax`), or null when it isn't a plain path. A computed member
 * counts when its key is a constant (`api['plug' + 'in']`, a const of one; resolved through `frame` when given).
 */
function pathOf(node, frame) {
  if (!node) return null;
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'ThisExpression') return 'this';
  if (MEMBER.has(node.type) && !node.computed) { const object = pathOf(node.object, frame); return object && node.property?.name ? object + '.' + node.property.name : null; }
  if (MEMBER.has(node.type) && node.computed) { const key = constString(node.property, frame); const object = key != null && pathOf(node.object, frame); return object ? object + '.' + key : null; }
  if (CALL.has(node.type)) { const callee = pathOf(node.callee, frame); return callee ? callee + '()' : null; }
  return null;
}

/** The string a constant expression always is (a literal, 'plug' + 'in', a template of constants, a const of one), else null. */
function constString(node, frame, depth = 0) {
  if (!node || depth > 6) return null;
  if (node.type === 'StringLiteral') return node.value;
  if (node.type === 'NumericLiteral') return String(node.value);
  if (node.type === 'TemplateLiteral') {
    let out = '';
    for (let i = 0; i < node.quasis.length; i++) {
      out += node.quasis[i].value.cooked;
      if (i < node.expressions.length) { const part = constString(node.expressions[i], frame, depth + 1); if (part == null) return null; out += part; }
    }
    return out;
  }
  if (node.type === 'BinaryExpression' && node.operator === '+') {
    const a = constString(node.left, frame, depth + 1); const b = a != null ? constString(node.right, frame, depth + 1) : null;
    return b != null ? a + b : null;
  }
  if (node.type === 'Identifier' && frame) {
    const b = lookup(frame, node.name);
    if (b?.kind === 'const' && b.init && !b.frame.mutated.has(node.name)) return constString(b.init, b.frame, depth + 1);
  }
  return null;
}

/** A path with the global prefixes dropped and the JE namespace's spellings unified. */
function normal(path) {
  if (!path) return path;
  let p = path.replace(/^(window|globalThis|self)\./, '');
  p = p.replace(/^JellyfinEnhanced(?=\.|$)/, 'JE').replace(/^ConnectionManager\.currentApiClient\(\)/, 'ApiClient').replace(/^ConnectionManager\.getApiClient\(\)/, 'ApiClient');
  return p;
}

/** Names of a function's parameters by index (a destructured or defaulted one by its binding name, else null). */
function paramNames(fn) {
  return fn.params.map(p => p.type === 'Identifier' ? p.name : p.type === 'AssignmentPattern' && p.left.type === 'Identifier' ? p.left.name : p.type === 'RestElement' ? p.argument.name : null);
}

/**
 * Walks every node with its enclosing function chain. Each function frame: {node, name, params, consts: name → init,
 * mutated: Set of names assigned or member-assigned in it, parent}.
 */
/**
 * Handlers by the object key they are passed under, with the index of their press argument: a click handler's event,
 * a Seerr modal's onSave(modal, button, close, press), a title action entry's run(opener, submitted).
 */
export const HANDLER_KEYS = { onClick: 0, onclick: 0, onSave: 3, run: 1 };

function frames(ast) {
  const all = [];
  const extractions = [];
  const top = { node: ast, name: '(module)', params: [], consts: new Map(), mutated: new Set(), parent: null };
  all.push(top);
  const visits = [];
  // A handler's function node → the index of its press argument (see HANDLER_KEYS; listeners and on* properties: 0).
  const pressOf = new WeakMap();
  const listened = [];
  const parents = new WeakMap();
  (function walk(node, frame, parentNode, nameHint) {
    if (!node || typeof node !== 'object') return;
    if (parentNode) parents.set(node, parentNode);
    let inner = frame;
    if (FUNCTION.has(node.type)) {
      const name = node.id?.name || (node.key ? keyName(node) : null) || nameHint || null;
      inner = { node, name, params: paramNames(node), defaults: node.params.map(p => p.type === 'AssignmentPattern'), consts: new Map(), mutated: new Set(), parent: frame, press: pressOf.get(node) ?? null,
        // `(function (JE) { … })(window.JellyfinEnhanced)`: what each parameter is called with.
        iife: CALL.has(parentNode?.type) && parentNode.callee === node ? parentNode.arguments : null };
      all.push(inner);
    }
    if (CALL.has(node.type) && MEMBER.has(node.callee?.type) && node.callee.property?.name === 'addEventListener') {
      const handler = node.arguments[1];
      if (FUNCTION.has(handler?.type)) pressOf.set(handler, 0); else if (handler?.type === 'Identifier') listened.push([handler.name, inner]);
    }
    if (node.type === 'AssignmentExpression' && MEMBER.has(node.left.type) && /^on[a-z]+$/.test(node.left.property?.name || '') && FUNCTION.has(node.right.type)) pressOf.set(node.right, 0);
    if (node.type === 'ObjectProperty' && FUNCTION.has(node.value?.type) && Object.hasOwn(HANDLER_KEYS, keyName(node))) pressOf.set(node.value, HANDLER_KEYS[keyName(node)]);
    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && node.init) inner.consts.set(node.id.name, { init: node.init, kind: parentNode?.kind });
    // Every function a name is given in this frame (block-scoped twins included), for listeners added by name.
    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && FUNCTION.has(node.init?.type)) (inner.functions ||= new Map()).set(node.id.name, [...(inner.functions?.get(node.id.name) || []), node.init]);
    // Binding patterns (D46S2-R8-3), recursively: `const { core: { api: { plugin: send = x } }, ...rest } = JE`: each local
    // name stands for the member path it takes (a default only replaces an undefined member; a rest stands for the
    // object itself). What has no constant path (a computed key that is not a constant, an array element), or is bound
    // by an assignment or a let/var, is an extraction the transport scan checks against the namespaces it leads from.
    if (node.type === 'VariableDeclarator' && ['ObjectPattern', 'ArrayPattern'].includes(node.id.type)) {
      let init = node.init;
      while (init?.type === 'LogicalExpression') init = init.left;
      bindPattern(node.id, init ? pathOf(init, inner) : null, inner, parentNode?.kind, extractions, parentNode?.kind !== 'const' ? 'a ' + parentNode?.kind + ' binding' : null);
    }
    if (node.type === 'AssignmentExpression' && ['ObjectPattern', 'ArrayPattern'].includes(node.left.type)) {
      let right = node.right;
      while (right?.type === 'LogicalExpression') right = right.left;
      bindPattern(node.left, pathOf(right, inner), inner, 'assign', extractions, 'a destructuring assignment');
    }
    // An IIFE's destructured parameter (`(function ({ core }) { … })(window.JellyfinEnhanced)`) takes from its argument.
    if (FUNCTION.has(node.type) && inner.iife) node.params.forEach((param, i) => {
      if (!['ObjectPattern', 'ArrayPattern'].includes(param.type) && !(param.type === 'AssignmentPattern' && ['ObjectPattern', 'ArrayPattern'].includes(param.left.type))) return;
      bindPattern(param.type === 'AssignmentPattern' ? param.left : param, pathOf(inner.iife[i]), inner, 'param', extractions, null);
    });
    if (node.type === 'AssignmentExpression') {
      const target = node.left.type === 'Identifier' ? node.left.name : MEMBER.has(node.left.type) ? rootName(node.left) : null;
      if (target) inner.mutated.add(target);
    }
    if (node.type === 'UpdateExpression' && node.argument.type === 'Identifier') inner.mutated.add(node.argument.name);
    visits.push([node, inner, parentNode]);
    for (const [key, value] of Object.entries(node)) {
      if (!value || typeof value !== 'object' || key === 'loc' || key === 'leadingComments' || key === 'trailingComments' || key === 'innerComments' || key === 'extra') continue;
      let hint = null;
      if (node.type === 'VariableDeclarator' && key === 'init') hint = node.id?.name;
      if (node.type === 'AssignmentExpression' && key === 'right') hint = MEMBER.has(node.left.type) ? node.left.property?.name : node.left.name;
      if ((node.type === 'ObjectProperty' || node.type === 'Property') && key === 'value') hint = keyName(node);
      if (Array.isArray(value)) value.forEach(v => walk(v, inner, node, hint)); else walk(value, inner, node, hint);
    }
  })(ast, top, null, null);
  // A listener added by name (`const onClick = e => …; node.addEventListener('click', onClick)`) is a handler too.
  for (const [name, frame] of listened) {
    for (let f = frame; f; f = f.parent) {
      const inits = f.functions?.get(name);
      if (!inits) { if (f.params.includes(name) || f.consts.has(name)) break; continue; }
      for (const init of inits) { const fn = all.find(x => x.node === init); if (fn && fn.press == null) fn.press = 0; }
      break;
    }
  }
  return { all, visits, parents, extractions };
}

/**
 * Binds every name of a binding pattern taken from `from` (a path, or null when unknown): {destructured: path} where the
 * path is constant; an extraction {node, frame, from, why} where it is not (or where `why` already says it can't be).
 */
function bindPattern(pattern, from, frame, kind, extractions, why) {
  if (!pattern) return;
  if (pattern.type === 'AssignmentPattern') { bindPattern(pattern.left, from, frame, kind, extractions, why); return; }
  if (pattern.type === 'Identifier') {
    BINDINGS.add(pattern);
    frame.consts.set(pattern.name, from && !why ? { destructured: from, kind: kind === 'param' ? 'const' : kind } : { kind: kind === 'param' ? 'let' : kind, extracted: true });
    if (from && why) extractions.push({ node: pattern, frame, from, why });
    return;
  }
  if (pattern.type === 'RestElement') { bindPattern(pattern.argument, from, frame, kind, extractions, why); return; }
  if (pattern.type === 'ObjectPattern') {
    for (const p of pattern.properties) {
      if (p.type === 'RestElement') { bindPattern(p.argument, from, frame, kind, extractions, why); continue; }
      const key = p.computed ? constString(p.key, frame) : keyName(p);
      if (key == null && from) extractions.push({ node: p, frame, from, why: why || 'a computed key that is not a constant' });
      bindPattern(p.value, from && key != null ? from + '.' + key : null, frame, kind, extractions, key == null ? why || 'a computed key that is not a constant' : why);
    }
    return;
  }
  if (pattern.type === 'ArrayPattern') {
    if (from) extractions.push({ node: pattern, frame, from, why: why || 'an array element' });
    for (const element of pattern.elements) bindPattern(element, null, frame, kind, extractions, why);
  }
}

/** The nearest handler frame enclosing `frame` (itself included), or null. */
function handlerOf(frame) {
  for (let f = frame; f; f = f.parent) if (f.press != null) return f;
  return null;
}

/** True when `inner` is `outer` or nested in it. */
function within(inner, outer) {
  for (let f = inner; f; f = f.parent) if (f === outer) return true;
  return false;
}

/** The identifier an expression starts from (`a` in a.b.c). */
function rootName(node) {
  while (MEMBER.has(node?.type)) node = node.object;
  return node?.type === 'Identifier' ? node.name : null;
}

/** Finds a binding visible from `frame` (nearest first): {init, kind, frame} or null. */
function lookup(frame, name) {
  for (let f = frame; f; f = f.parent) {
    if (f.params.includes(name)) return { param: true, frame: f, index: f.params.indexOf(name) };
    if (f.consts.has(name)) return { ...f.consts.get(name), frame: f };
  }
  return null;
}

/** What a transport alias resolves to: 'ApiClient', 'JE.core.api', 'fetch' or null. */
const TRANSPORT_ROOTS = ['ApiClient', 'JE.core.api', 'fetch', 'XMLHttpRequest', 'navigator.sendBeacon'];
function transportRoot(path) {
  const p = normal(path);
  return TRANSPORT_ROOTS.find(root => p === root || p?.startsWith(root + '.')) || null;
}

/** True when a normal path is, or leads to, a transport root (`JE`, `JE.core`, `window`, `JE.core.api.plugin`…). */
function reaches(path) {
  if (!path) return false;
  if (['window', 'globalThis', 'self', 'navigator', 'ConnectionManager'].includes(path)) return true;
  return TRANSPORT_ROOTS.some(root => root === path || root.startsWith(path + '.') || path.startsWith(root + '.'));
}

/** Resolves a callee path through const aliases (`const ac = window.ApiClient; ac.ajax`) to a normal path. */
function resolvePath(path, frame, depth = 0) {
  if (!path || depth > 5) return normal(path);
  const [head, ...rest] = path.split('.');
  if (['window', 'globalThis', 'self', 'JE', 'JellyfinEnhanced', 'ApiClient', 'fetch', 'navigator', 'XMLHttpRequest', 'ConnectionManager'].includes(head)) return normal(path);
  const binding = lookup(frame, head);
  // A parameter an IIFE is called with a path for (`(function (J) { … })(window.JellyfinEnhanced)`) is that path.
  const called = binding?.param ? binding.frame.iife?.[binding.index] : null;
  if (called) { const target = pathOf(called); return target && reaches(normal(target)) ? resolvePath([target, ...rest].join('.'), binding.frame.parent, depth + 1) : normal(path); }
  if (!binding || binding.param) return normal(path);
  // `const { plugin } = JE.core.api`: the local name is that member.
  if (binding.destructured) return resolvePath([binding.destructured, ...rest].join('.'), binding.frame, depth + 1);
  let init = binding.init;
  // `window.ApiClient || ConnectionManager.currentApiClient()` and `JE.core?.api`: the first operand names it.
  while (init?.type === 'LogicalExpression') init = init.left;
  const target = pathOf(init, binding.frame);
  if (!target || !reaches(resolvePath(target, binding.frame, depth + 1))) return normal(path);
  return resolvePath([target, ...rest].join('.'), binding.frame, depth + 1);
}

// The transport values a module may hold only as a const alias (anything else lets a call escape the scan).
const TRANSPORT_VALUES = new Set(['JE.core.api', 'JE.core', 'ApiClient', 'fetch', 'navigator.sendBeacon']);
// The namespaces that lead to a transport root (D46S2-R8-3): held only as an IIFE's parameter or a const alias (or
// destructured by one); anything else (an argument, a let, a property, a return) hands the transport out unseen.
const NAMESPACE_VALUES = new Set(['JE']);
const TRANSPORT_METHOD = /^(JE\.core\.api\.(plugin|pluginResponse|fetch|ajax|jf)|ApiClient\.[A-Za-z]+|fetch|navigator\.sendBeacon)$/;

/**
 * True when a transport value (`node`) escapes: used as anything but a member's object, a call's callee, a const alias
 * (directly or as the first operand of `||`/`??` in one, or destructured by one), or a test (`typeof`, `!`, `&&`, a
 * comparison, a condition).
 */
function escapes(node, parents) {
  let child = node; let parent = parents.get(node);
  // A namespace initialiser `JE.core = JE.core || {}`: its target and its own first operand.
  const initialiser = a => a?.type === 'AssignmentExpression' && a.operator === '=' && a.right.type === 'LogicalExpression' && ['||', '??'].includes(a.right.operator) &&
    normal(pathOf(a.left)) === normal(pathOf(a.right.left)) && a.right.right.type === 'ObjectExpression' && !a.right.right.properties.length;
  if (initialiser(parent) && parent.left === child) return false;
  if (parent?.type === 'LogicalExpression' && parent.left === child && initialiser(parents.get(parent))) return false;
  if (MEMBER.has(parent?.type) && parent.object === child) return false;
  if (CALL.has(parent?.type) && parent.callee === child) return false;
  // `(function (JE) { … })(window.JellyfinEnhanced)`: the IIFE's parameter is resolved to it.
  if (CALL.has(parent?.type) && FUNCTION.has(parent.callee?.type) && parent.arguments.includes(child)) return false;
  if (parent?.type === 'UnaryExpression' && ['typeof', '!'].includes(parent.operator)) return false;
  if (parent?.type === 'BinaryExpression' && ['==', '!=', '===', '!=='].includes(parent.operator)) return false;
  while (parent?.type === 'LogicalExpression') {
    if (parent.operator === '&&' && parent.left === child) return false;
    child = parent; parent = parents.get(parent);
  }
  if ((parent?.type === 'IfStatement' || parent?.type === 'ConditionalExpression' || parent?.type === 'WhileStatement') && parent.test === child) return false;
  if (parent?.type === 'UnaryExpression' && parent.operator === '!') return false;
  // A const alias, or a const binding pattern (its names are resolved, or fail as extractions, D46S2-R8-3).
  if (parent?.type === 'VariableDeclarator' && parent.init === child && parents.get(parent)?.kind === 'const') return false;
  return true;
}

const NAMESPACE_NAMES = new Set(['JE', 'JellyfinEnhanced']);
/**
 * True when the JE namespace (`node`, already not a member's object, a callee, a test or a const alias) escapes the
 * scan (D46S2-R8-3). It stays seen where the scan resolves it: an assignment defining it or publishing it under its own
 * name (window.JE = JE), an IIFE's
 * argument (`(function (JE) { … })(window.JellyfinEnhanced || (window.JellyfinEnhanced = {}))`), a declaration of a
 * binding named JE, an argument whose parameter is named JE (a same-file function's, or a callback's that a same-file
 * function is called with), and a return whose every same-file call binds a name JE. Anything else hands it out unseen.
 */
function namespaceEscapes(node, parents, visits) {
  let child = node; let parent = parents.get(node);
  while (parent?.type === 'LogicalExpression') { child = parent; parent = parents.get(parent); }
  // Defining it, or publishing it under its own name (window.JE = JE): the scan resolves both names.
  if (parent?.type === 'AssignmentExpression' && (parent.left === child || NAMESPACE_NAMES.has(normal(pathOf(parent.left))))) return false;
  // Defining one of its members by a constant name (Object.defineProperty(JE, 'NATIVE', …), D46S2-R9-4): a member, as JE.x = ….
  if (CALL.has(parent?.type) && normal(pathOf(parent.callee)) === 'Object.defineProperty' && parent.arguments[0] === child && parent.arguments[1]?.type === 'StringLiteral') return false;
  if (CALL.has(parent?.type) && FUNCTION.has(parent.callee?.type) && parent.arguments.includes(child)) return false;
  if (parent?.type === 'VariableDeclarator' && parent.init === child && NAMESPACE_NAMES.has(parent.id?.name)) return false;
  const functions = name => visits.filter(([n]) => (n.type === 'FunctionDeclaration' && n.id?.name === name) ||
    (n.type === 'VariableDeclarator' && n.id?.name === name && FUNCTION.has(n.init?.type))).map(([n]) => n.type === 'VariableDeclarator' ? n.init : n);
  const paramNamed = (fn, index) => fn?.params?.[index]?.type === 'Identifier' && NAMESPACE_NAMES.has(fn.params[index].name);
  if (CALL.has(parent?.type) && parent.callee?.type === 'Identifier' && parent.arguments.includes(child)) {
    const index = parent.arguments.indexOf(child);
    const own = functions(parent.callee.name);
    if (own.length && own.every(fn => paramNamed(fn, index))) return false;
    // A callback parameter: every same-file call of its function passes a function whose parameter is named JE.
    for (const [n] of visits) {
      if (!FUNCTION.has(n.type) || !n.params.some(q => q.type === 'Identifier' && q.name === parent.callee.name) || !(n.start <= parent.start && parent.end <= n.end)) continue;
      const at = n.params.findIndex(q => q.type === 'Identifier' && q.name === parent.callee.name);
      const name = n.id?.name || (parents.get(n)?.type === 'VariableDeclarator' ? parents.get(n).id.name : null);
      const calls = name ? visits.filter(([c]) => CALL.has(c.type) && c.callee?.type === 'Identifier' && c.callee.name === name).map(([c]) => c.arguments[at]) : [];
      if (calls.length && calls.every(fn => FUNCTION.has(fn?.type) && paramNamed(fn, index))) return false;
    }
  }
  if (parent?.type === 'ReturnStatement') {
    let fn = parents.get(parent);
    while (fn && !FUNCTION.has(fn.type)) fn = parents.get(fn);
    const name = fn?.id?.name;
    const calls = name ? visits.filter(([c]) => CALL.has(c.type) && c.callee?.type === 'Identifier' && c.callee.name === name) : [];
    if (calls.length && calls.every(([c]) => parents.get(c)?.type === 'VariableDeclarator' && NAMESPACE_NAMES.has(parents.get(c).id?.name))) return false;
  }
  return true;
}

// Identifiers a binding pattern declares (not references).
const BINDINGS = new WeakSet();
/** True when an identifier node is a reference (not a declaration, a parameter, a property key or a non-computed member). */
function reference(node, parent) {
  if (!parent) return true;
  if (BINDINGS.has(node)) return false;
  if (MEMBER.has(parent.type) && parent.property === node && !parent.computed) return false;
  if ((parent.type === 'ObjectProperty' || parent.type === 'ObjectMethod') && parent.key === node && !parent.computed) return false;
  if (parent.type === 'VariableDeclarator' && parent.id === node) return false;
  if (FUNCTION.has(parent.type) && (parent.params.includes(node) || parent.id === node)) return false;
  return !['LabeledStatement', 'BreakStatement', 'ContinueStatement', 'CatchClause', 'ImportSpecifier'].includes(parent.type);
}

const WRITE = new Set(['POST', 'PUT', 'DELETE', 'PATCH']);
const API_TRANSPORT = { plugin: 1, pluginResponse: 1, fetch: 1, jf: 1, ajax: 0 };
const API_OTHER = new Set(['session', 'authHeaders', 'isPresentationAbort', 'writeOutcome', 'writeEpoch', 'manager']);
// subscribe: jellyfin-web's websocket message listener (no request).
const CLIENT_ACCESSORS = new Set(['subscribe', 'getUrl', 'getCurrentUserId', 'serverId', 'accessToken', 'serverAddress', 'getImageUrl', 'getScaledImageUrl', 'deviceId', 'deviceName', 'appName', 'appVersion', 'serverInfo', 'isLoggedIn', 'getApiClient']);

/**
 * Where a binding value comes from: {param: {frame, index, member}} when it is (a const of) an enclosing function's
 * parameter or that parameter's `.bound`, else 'yes' (the call's own binding), or null for undefined.
 */
function boundSource(value, frame) {
  if (isUndefined(value)) return null;
  let node = value; let member = false;
  if (node.type === 'Identifier') {
    const b = lookup(frame, node.name);
    if (b?.param) return { param: { frame: b.frame, index: b.index, member: false } };
    if (b?.init && MEMBER.has(b.init.type) && b.init.property?.name === 'bound') { node = b.init; frame = b.frame; } else return 'yes';
  }
  if (MEMBER.has(node.type) && node.property?.name === 'bound' && node.object?.type === 'Identifier') {
    const b = lookup(frame, node.object.name);
    member = true;
    if (b?.param) return { param: { frame: b.frame, index: b.index, member } };
  }
  return 'yes';
}

/**
 * Classifies an options argument: {methods: Set|null (null: unknown), bound: null | 'yes' | {param} (the binding comes
 * from a parameter of an enclosing function), forwarded: {frame, index} (the options are a parameter's), spread:
 * {frame, index} (a parameter's options spread in), why}. `methodKeys`: the keys naming the method.
 */
function options(arg, frame, methodKeys, depth = 0) {
  if (!arg) return { methods: new Set(['GET']), bound: null };
  if (arg.type === 'Identifier') {
    const binding = lookup(frame, arg.name);
    if (binding?.param) return { methods: null, bound: null, forwarded: { frame: binding.frame, index: binding.index } };
    if (binding && binding.kind === 'const' && ['ObjectExpression', 'CallExpression', 'ConditionalExpression'].includes(binding.init?.type) && !binding.frame.mutated.has(arg.name) && depth < 3)
      return { ...options(binding.init, binding.frame, methodKeys, depth + 1), resolved: arg.name };
    return { methods: null, bound: null, why: `options "${arg.name}" are not a same-function const literal` };
  }
  if (arg.type === 'LogicalExpression' && ['||', '??'].includes(arg.operator) && arg.right.type === 'ObjectExpression' && !arg.right.properties.length)
    return options(arg.left, frame, methodKeys, depth + 1);
  // A primitive can't name a method (a page number passed where options may go): the request is a GET.
  if (['NumericLiteral', 'StringLiteral', 'BooleanLiteral', 'NullLiteral'].includes(arg.type) || isUndefined(arg)) return { methods: new Set(['GET']), bound: null };
  if (arg.type === 'ConditionalExpression') {
    const a = options(arg.consequent, frame, methodKeys, depth + 1); const b = options(arg.alternate, frame, methodKeys, depth + 1);
    // One side the caller's options, the other a read: the caller's options decide (its calls are classified).
    const readOnly = x => x.methods && [...x.methods].every(m => m === 'GET') && !x.bound;
    if (a.forwarded && (readOnly(b) || b.forwarded)) return a;
    if (b.forwarded && readOnly(a)) return b;
    return { methods: a.methods && b.methods ? new Set([...a.methods, ...b.methods]) : null, bound: a.bound === 'yes' && b.bound === 'yes' ? 'yes' : null, explicit: a.explicit || b.explicit, why: a.why || b.why };
  }
  // Object.assign({...}, options || {}): the literal's keys, then the caller's options spread over them.
  if (arg.type === 'CallExpression' && normal(pathOf(arg.callee)) === 'Object.assign') {
    const properties = arg.arguments.flatMap(a => a.type === 'ObjectExpression' ? a.properties
      : [{ type: 'SpreadElement', argument: a.type === 'LogicalExpression' && ['||', '??'].includes(a.operator) ? a.left : a }]);
    return options({ type: 'ObjectExpression', properties }, frame, methodKeys, depth + 1);
  }
  if (arg.type !== 'ObjectExpression') return { methods: null, bound: null, why: `options are a ${arg.type}` };
  let methods = new Set(['GET']); let bound = null; let spread = null; let unknown = false; let explicit = false;
  for (const p of arg.properties) {
    if (p.type === 'SpreadElement') {
      const name = p.argument.type === 'Identifier' ? p.argument.name : null;
      const binding = name && lookup(frame, name);
      if (binding?.param) { spread = { frame: binding.frame, index: binding.index }; explicit = false; }
      else if ((binding && binding.kind === 'const' && binding.init?.type === 'ObjectExpression') || ['ObjectExpression', 'ConditionalExpression'].includes(p.argument.type)) {
        // A literal (or a ternary of literals) spread in: its method, if it names one, and its binding.
        const inner = binding?.init && p.argument.type === 'Identifier' ? options(binding.init, binding.frame, methodKeys, depth + 1) : options(p.argument, frame, methodKeys, depth + 1);
        if (!inner.methods) unknown = true; else if (inner.explicit) { methods = inner.methods; explicit = true; }
        if (inner.bound) bound = inner.bound;
      } else unknown = true;
      continue;
    }
    const key = keyName(p);
    if (methodKeys.includes(key)) {
      const literal = literals(p.value);
      if (literal) { methods = literal; unknown = false; explicit = true; } else unknown = true;
    }
    if (key === 'bound') bound = boundSource(p.shorthand ? { type: 'Identifier', name: 'bound' } : p.value, frame);
  }
  // A parameter's options spread in without a method of its own: the method is the caller's.
  if (spread && !explicit) return { methods: null, bound, spread };
  return { methods: unknown ? null : methods, bound, explicit, why: unknown ? 'the method is not a literal' : undefined };
}

/** The upper-case method literals an expression can be ('POST', a ternary of literals), else null. */
function literals(value) {
  if (value?.type === 'StringLiteral') return new Set([value.value.toUpperCase()]);
  if (value?.type === 'TemplateLiteral' && !value.expressions.length) return new Set([value.quasis[0].value.cooked.toUpperCase()]);
  if (value?.type === 'ConditionalExpression') { const a = literals(value.consequent); const b = literals(value.alternate); return a && b ? new Set([...a, ...b]) : null; }
  return null;
}

/** The enclosing named function of a frame (closures count as their parent's), for exclusions and forwarding. */
function named(frame) {
  for (let f = frame; f; f = f.parent) if (f.name) return f;
  return frame;
}

/** First string argument (a path), for messages and exclusions. */
const pathArg = node => { const a = node.arguments?.[0]; return a?.type === 'StringLiteral' ? a.value : a?.type === 'TemplateLiteral' ? a.quasis.map(q => q.value.raw).join('*') : ''; };

/**
 * The transport scan. `config`: {excludedModules: {file: reason}, excludedSites: {file: {functionName: reason}}}.
 * Returns {sites, failures, forwarders, wrappers}: each site {file, line, fn, entry, kind: 'read'|'write'|'bound'|
 * 'forward'|'wrapper'|'unmodelled'|'excluded', detail}.
 */
export function scanTransport(sources, config) {
  const sites = []; const failures = [];
  const modules = Object.entries(sources).map(([file, text]) => [file, frames(parsed(text))]);
  // Functions whose options (or binding) come from a parameter: their calls are classified at each caller.
  const forwarders = new Map(); // 'file::name' → {file, name, index, kind: 'options'|'bound', member}
  const wrappers = new Set();
  const record = (site) => {
    const excludedModule = config.excludedModules[site.file];
    const excludedSite = config.excludedSites[site.file]?.[site.fn] || config.excludedSites[site.file]?.['*'];
    if ((excludedModule || excludedSite) && ['write', 'unmodelled'].includes(site.kind)) site.excluded = excludedModule ? 'module' : 'site';
    sites.push(site);
    if (!site.excluded && ['write', 'unmodelled'].includes(site.kind)) failures.push(`${site.file}:${site.line} ${site.kind} ${site.entry}${site.detail ? ' (' + site.detail + ')' : ''}${site.path ? ' ' + site.path : ''}`);
  };
  /** Classifies one entry-point (or forwarder) call. */
  function classify(file, node, frame, entry, optionsArg, methodKeys) {
    const fn = named(frame);
    const base = { file, line: node.loc.start.line, fn: fn.name, entry, path: pathArg(node) };
    const o = options(optionsArg, frame, methodKeys);
    const reads = o.methods && [...o.methods].every(m => m === 'GET' || m === 'HEAD');
    if (o.bound === 'yes') return record({ ...base, kind: o.spread ? 'wrapper' : 'bound', detail: o.spread ? 'binds whatever its callers send' : undefined }, o.spread && wrappers.add(`${file}::${fn.name}`));
    if (o.bound?.param && reads) return record({ ...base, kind: 'read', detail: 'forwards its caller\'s binding' });
    if (o.bound?.param) {
      const owner = named(o.bound.param.frame);
      forwarders.set(`${file}::${owner.name}`, { file, name: owner.name, index: o.bound.param.index, kind: 'bound', member: o.bound.param.member, method: [...(o.methods || [])].find(m => WRITE.has(m)) || 'POST' });
      return record({ ...base, kind: 'forward', detail: 'its binding comes from its caller' });
    }
    const from = o.forwarded || o.spread;
    if (from) {
      const owner = named(from.frame);
      forwarders.set(`${file}::${owner.name}`, { file, name: owner.name, index: from.index, kind: 'options', methodKeys });
      return record({ ...base, kind: 'forward', detail: 'its options come from its caller' });
    }
    if (!o.methods) return record({ ...base, kind: 'unmodelled', detail: o.why || 'unresolvable options' });
    if (reads) return record({ ...base, kind: 'read' });
    const writes = [...o.methods].filter(m => WRITE.has(m));
    return record({ ...base, kind: writes.length ? 'write' : 'unmodelled', detail: writes.length ? writes.join('|') + ' without bound' : 'method ' + [...o.methods].join('|') });
  }
  // Extractions (D46S2-R8-3): a binding pattern without a constant path, from anything leading to a transport root.
  for (const [file, { extractions }] of modules) for (const { node, frame, from, why } of extractions) {
    const source = resolvePath(from, frame);
    if (reaches(source) || TRANSPORT_VALUES.has(source)) record({ file, line: node.loc.start.line, fn: named(frame).name, entry: source, kind: 'unmodelled', detail: `an unresolvable extraction from a namespace leading to a transport root (${why})` });
  }
  // Pass 1: the entry points.
  for (const [file, { visits, parents }] of modules) {
    for (const [node, frame, parent] of visits) {
      const unmodelled = detail => record({ file, line: node.loc.start.line, fn: named(frame).name, entry: sourceText(sources[file], node), kind: 'unmodelled', detail });
      // Fail closed on what the scan cannot resolve (D46S2-R7-2). A computed member of a transport root (or of anything
      // leading to one: JE, JE.core, window…) must be a constant key; `api[name]` could be any entry point.
      if (MEMBER.has(node.type) && node.computed && constString(node.property, frame) == null && reaches(resolvePath(pathOf(node.object, frame), frame))) {
        unmodelled('a computed member of a transport root (not a constant)');
        continue;
      }
      // A transport method through call/apply/bind takes its options where the scan does not look.
      if (MEMBER.has(node.type) && ['call', 'apply', 'bind'].includes(node.computed ? constString(node.property, frame) : node.property?.name)) {
        const target = resolvePath(pathOf(node.object, frame), frame);
        if (target && TRANSPORT_METHOD.test(target) && !CLIENT_ACCESSORS.has(target.split('.').pop())) { unmodelled('a transport method through call/apply/bind'); continue; }
      }
      // A transport value (the api, the client, fetch) held anywhere but in a const alias escapes the scan.
      if ((MEMBER.has(node.type) || (node.type === 'Identifier' && reference(node, parent))) && TRANSPORT_VALUES.has(resolvePath(pathOf(node, frame), frame)) && escapes(node, parents)) {
        unmodelled('a transport value that escapes (not a const alias, member, call or test)');
        continue;
      }
      if ((MEMBER.has(node.type) || (node.type === 'Identifier' && reference(node, parent))) && !(MEMBER.has(parent?.type) && parent.object === node) &&
          NAMESPACE_VALUES.has(resolvePath(pathOf(node, frame), frame)) && escapes(node, parents) && namespaceEscapes(node, parents, visits) &&
          !config.namespaceSites?.[file]?.[named(frame).name]) {
        unmodelled('a namespace leading to a transport root that escapes (not an IIFE parameter, a const alias, member or test)');
        continue;
      }
      // XMLHttpRequest and sendBeacon: any reference at all is a site (nothing can bind them).
      if (node.type === 'Identifier' && node.name === 'XMLHttpRequest' && !(MEMBER.has(parent?.type) && parent.property === node && !parent.computed)) {
        record({ file, line: node.loc.start.line, fn: named(frame).name, entry: 'XMLHttpRequest', kind: 'unmodelled', detail: 'XMLHttpRequest cannot carry a binding' });
        continue;
      }
      if (MEMBER.has(node.type) && node.property?.name === 'sendBeacon') {
        record({ file, line: node.loc.start.line, fn: named(frame).name, entry: 'navigator.sendBeacon', kind: 'write', detail: 'a beacon cannot carry a binding' });
        continue;
      }
      if (!CALL.has(node.type) || node.type === 'NewExpression') {
        // A transport method taken as a value (`const f = ApiClient.ajax`, `.then(JE.core.api.plugin)`) escapes the scan.
        if (MEMBER.has(node.type) && !(CALL.has(parent?.type) && parent.callee === node) && !(MEMBER.has(parent?.type) && parent.object === node)) {
          const target = resolvePath(pathOf(node, frame), frame);
          const m = target?.match(/^(JE\.core\.api|ApiClient)\.([A-Za-z]+)$/);
          if (m && (m[1] === 'ApiClient' ? !CLIENT_ACCESSORS.has(m[2]) && !/^get[A-Z]/.test(m[2]) : m[2] in API_TRANSPORT)
            && !(parent?.type === 'UnaryExpression' && ['typeof', '!'].includes(parent.operator)) && !(parent?.type === 'IfStatement' || parent?.type === 'ConditionalExpression' && parent.test === node || parent?.type === 'LogicalExpression' && parent.left === node && parent.operator === '&&'))
            record({ file, line: node.loc.start.line, fn: named(frame).name, entry: target, kind: 'unmodelled', detail: 'a transport method taken as a value' });
        }
        continue;
      }
      const target = resolvePath(pathOf(node.callee, frame), frame);
      if (!target) continue;
      if (target === 'fetch') { classify(file, node, frame, 'fetch', node.arguments[1], ['method']); continue; }
      let m = target.match(/^JE\.core\.api\.([A-Za-z]+)$/);
      if (m) {
        if (API_OTHER.has(m[1])) continue;
        if (m[1] in API_TRANSPORT) classify(file, node, frame, target, node.arguments[API_TRANSPORT[m[1]]], m[1] === 'ajax' ? ['type', 'method'] : ['method']);
        else record({ file, line: node.loc.start.line, fn: named(frame).name, entry: target, kind: 'unmodelled', detail: 'an unknown core transport entry point' });
        continue;
      }
      if (/^JE\.core\.api\.manager\./.test(target)) continue;
      m = target.match(/^ApiClient\.([A-Za-z]+)$/);
      if (m) {
        if (CLIENT_ACCESSORS.has(m[1])) continue;
        if (m[1] === 'ajax' || m[1] === 'fetch') classify(file, node, frame, target, node.arguments[0], ['type', 'method']);
        else if (/^get[A-Z]/.test(m[1])) record({ file, line: node.loc.start.line, fn: named(frame).name, entry: target, kind: 'read' });
        else record({ file, line: node.loc.start.line, fn: named(frame).name, entry: target, kind: 'write', detail: 'an ApiClient write cannot carry a binding' });
      }
    }
  }
  // Pass 2: calls of forwarders are sites, classified by their own argument at the forwarded position (repeated, so a
  // forwarder of a forwarder is followed). A bare call matches a forwarder of its own file; a member call matches only
  // the callee pattern the forwarder is pinned to (config.forwarders), and a forwarder that isn't pinned fails.
  const seen = new Set();
  for (let round = 0; round < 6; round++) {
    const before = forwarders.size;
    for (const [file, { visits }] of modules) {
      for (const [node, frame] of visits) {
        if (!CALL.has(node.type) || node.type === 'NewExpression') continue;
        const callee = node.callee;
        let forward = null;
        let dotted = MEMBER.has(callee.type) ? normal(pathOf(callee)) : null;
        let name = MEMBER.has(callee.type) ? callee.property?.name : null;
        if (callee.type === 'Identifier') {
          forward = forwarders.get(`${file}::${callee.name}`);
          // A name destructured from a namespace (`const { requestMedia } = JE.jellyseerrAPI`) is that member.
          const alias = !forward && lookup(frame, callee.name);
          if (alias?.destructured) { dotted = normal(alias.destructured); name = dotted.split('.').pop(); }
        }
        if (!forward && dotted) for (const [key, f] of forwarders) if (f.name === name && config.forwarders?.[key] instanceof RegExp && config.forwarders[key].test(dotted)) forward = f;
        if (!forward) continue;
        // The forwarder's own recursive call is not a caller.
        if (named(frame).name === forward.name && forward.file === file) continue;
        const id = `${file}:${node.start}`;
        if (seen.has(id)) continue;
        seen.add(id);
        const arg = node.arguments[forward.index];
        const entry = forward.name + '()';
        if (forward.kind === 'bound') {
          const base = { file, line: node.loc.start.line, fn: named(frame).name, entry, path: pathArg(node) };
          if (forward.member) {
            // The forwarder writes: its caller's options must carry the binding (none, or options without it, is a write).
            const o = options(arg, frame, ['method']);
            if (o.bound === 'yes') { record({ ...base, kind: 'bound' }); continue; }
            const from = o.bound?.param ? { frame: o.bound.param.frame, index: o.bound.param.index, member: o.bound.param.member } : o.forwarded || o.spread ? { ...(o.forwarded || o.spread), member: true } : null;
            if (from) { const owner = named(from.frame); forwarders.set(`${file}::${owner.name}`, { file, name: owner.name, index: from.index, kind: 'bound', member: from.member, method: forward.method }); record({ ...base, kind: 'forward', detail: 'its binding comes from its caller' }); continue; }
            record({ ...base, kind: 'write', detail: `${forward.method || 'POST'} without bound` });
            continue;
          }
          const source = boundSource(arg, frame);
          if (source?.param) { const owner = named(source.param.frame); forwarders.set(`${file}::${owner.name}`, { file, name: owner.name, index: source.param.index, kind: 'bound', member: source.param.member, method: forward.method }); record({ ...base, kind: 'forward', detail: 'its binding comes from its caller' }); continue; }
          record({ ...base, kind: source ? 'bound' : 'write', detail: source ? undefined : 'a binding forwarder called without bound' });
        } else classify(file, node, frame, entry, arg, forward.methodKeys);
      }
    }
    if (forwarders.size === before) break;
  }
  for (const key of forwarders.keys()) if (!(key in (config.forwarders || {}))) failures.push(`${key}: a forwarder the scan found is not pinned (its callers would go unchecked)`);
  return { sites, failures, forwarders, wrappers };
}

/** Function names too common to match as members anywhere (only their bare calls in their own file are sites). */
const GENERIC = new Set(['open', 'close', 'show', 'run', 'toggle', 'fire', 'onSave', 'onClick', 'onclick', 'create', 'update', 'init', 'start', 'call', 'handler', 'callback', 'get', 'set', 'add', 'remove']);

/** Resolves a dotted callee through const path aliases (`const sheet = JE.arrAskSheet`, destructured names). */
function aliasPath(path, frame, depth = 0) {
  if (!path || depth > 5) return normal(path);
  const [head, ...rest] = path.split('.');
  const binding = lookup(frame, head);
  if (binding?.destructured) return aliasPath([binding.destructured, ...rest].join('.'), binding.frame, depth + 1);
  if (!binding || binding.param || binding.kind !== 'const') return normal(path);
  let init = binding.init;
  while (init?.type === 'LogicalExpression') init = init.left;
  const target = init && MEMBER.has(init.type) || init?.type === 'Identifier' ? pathOf(init) : null;
  return target ? aliasPath([target, ...rest].join('.'), binding.frame, depth + 1) : normal(path);
}

/**
 * The parameter an owner value comes from: {frame, index, prop} when it is an enclosing named function's parameter (or
 * its `.operation`/`.owner`, a const of either, or JE.ownerOf/JE.requireOwner of one), else null.
 */
const OWNER_OF = /^JE\.(ownerOf|requireOwner|captureSubmitted)$/;
/** The `owner` a JE.publication({ owner, … }) call is taken for (a publication stands for its owner, D46S2-R8-2), else null. */
function publicationOwner(value) {
  if (!CALL.has(value?.type) || normal(pathOf(value.callee)) !== 'JE.publication' || value.arguments[0]?.type !== 'ObjectExpression') return null;
  const p = value.arguments[0].properties.find(q => q.type === 'ObjectProperty' && keyName(q) === 'owner');
  return p ? (p.shorthand ? { type: 'Identifier', name: 'owner', start: p.start, end: p.end } : p.value) : null;
}
function ownerParam(value, frame, depth = 0) {
  if (!value || depth > 6) return null;
  if (publicationOwner(value)) return ownerParam(publicationOwner(value), frame, depth + 1);
  // JE.ownerOf(x), JE.requireOwner(x) and a capture JE.captureSubmitted(x) (or its owner) stand for x's owner.
  if (CALL.has(value.type) && OWNER_OF.test(normal(pathOf(value.callee)) || '')) return ownerParam(value.arguments[0], frame, depth + 1);
  if (value.type === 'Identifier') {
    const b = lookup(frame, value.name);
    if (b?.param) return b.frame.params[b.index] && !b.frame.defaults?.[b.index] ? { frame: b.frame, index: b.index } : null;
    if (b?.kind === 'const' && b.init) return ownerParam(b.init, b.frame, depth + 1);
    return null;
  }
  if (MEMBER.has(value.type) && ['operation', 'owner'].includes(value.property?.name) && value.object?.type === 'Identifier') {
    const b = lookup(frame, value.object.name);
    if (b?.param && !b.frame.defaults?.[b.index]) return { frame: b.frame, index: b.index, prop: value.property.name };
    if (b?.kind === 'const' && CALL.has(b.init?.type) && OWNER_OF.test(normal(pathOf(b.init.callee)) || '')) return ownerParam(b.init, b.frame, depth + 1);
  }
  return null;
}

/**
 * True when an owner value is a native root taken without a gesture (directly or through a const): the route's own
 * owner (JE.routeOwner, D46S2-R10-2), or the retired JE.NATIVE / JE.nativeRoot (gone at run time: a planted one fails).
 */
function nativeValue(value, frame, depth = 0) {
  if (!value || depth > 4) return false;
  if (normal(pathOf(value)) === 'JE.NATIVE') return true;
  if (CALL.has(value.type) && /^JE\.(nativeRoot|routeOwner)$/.test(normal(pathOf(value.callee)) || '')) return true;
  if (publicationOwner(value)) return nativeValue(publicationOwner(value), frame, depth + 1);
  if (value.type === 'Identifier') { const b = lookup(frame, value.name); return b?.kind === 'const' && nativeValue(b.init, b.frame, depth + 1); }
  return false;
}

/** The argument of the JE.ownerOf / JE.requireOwner call an owner value is taken from (directly or through a const), else null. */
function ownerOfCall(value, frame, depth = 0) {
  if (!value || depth > 4) return null;
  if (CALL.has(value.type) && /^JE\.(ownerOf|requireOwner)$/.test(normal(pathOf(value.callee)) || '')) return value;
  if (CALL.has(value.type) && normal(pathOf(value.callee)) === 'JE.captureSubmitted') return ownerOfCall(value.arguments[0], frame, depth + 1);
  if (publicationOwner(value)) return ownerOfCall(publicationOwner(value), frame, depth + 1);
  if (value.type === 'Identifier') { const b = lookup(frame, value.name); return b?.kind === 'const' ? ownerOfCall(b.init, b.frame, depth + 1) : null; }
  if (MEMBER.has(value.type) && value.property?.name === 'owner' && value.object?.type === 'Identifier') { const b = lookup(frame, value.object.name); return b?.kind === 'const' ? ownerOfCall(b.init, b.frame, depth + 1) : null; }
  return null;
}

/** A pinned root's reason: `roots[file][fn]` or `roots[file]['fn: value text']`. */
const pinned = (roots, file, fn, text) => roots?.[file]?.[`${fn}: ${text}`] || roots?.[file]?.[fn] || null;

/** Calls that capture an owner into a const (an operation, a capture, a publication, a session action for an owner). */
const CAPTURES = /(^|\.)(generation|captureSubmitted|ownerOf|requireOwner|publication)$/;
/** Members of a parameter that only an owner has (an operation's current(), a capture's owner/operation/bound). */
const OWNER_MEMBERS = new Set(['current', 'owner', 'operation', 'bound']);

/**
 * D46S2-R8-1 (owners flow through every hand-over): a pinned JE.NATIVE is a genuine root only where no caller-owned
 * operation exists. It fails when the function it is in holds an owner, an enclosing function holds one that the inner
 * functions reference (a captured owner), or a function that reaches it through calls does: bare calls in its file and
 * calls of the path it is exported under (`JE.titleDetails = Object.freeze({ show, … })`, `api.open = function …`,
 * `internal.x = x`), followed through named callers; a callback (an anonymous function the host calls) is where the
 * chain starts. Holding an owner: a parameter used as one (its current/owner/operation/bound, or passed where an owner
 * goes), or a const captured from one (generation(), JE.captureSubmitted/ownerOf/requireOwner/publication,
 * createSessionAction({ owner })).
 */
function nativeReach(modules, natives) {
  const failures = [];
  if (!natives.length) return failures;
  const holding = new Map(); // frame → Map(name → why)
  const hold = (frame, name, why) => {
    if (!frame || frame.name === '(module)') return;
    if (!holding.has(frame)) holding.set(frame, new Map());
    if (!holding.get(frame).has(name)) holding.get(frame).set(name, why);
  };
  const exportsOf = new Map(); // normal path → 'file::name'
  const calls = []; // {file, frame, bare, dotted}
  const references = new Map(); // file → [[identifier node, frame]]
  for (const [file, { visits, parents }] of modules) {
    const refs = [];
    references.set(file, refs);
    for (const [node, frame, parent] of visits) {
      if (node.type === 'Identifier' && reference(node, parent)) refs.push([node, frame]);
      // The JE namespace itself is no owner (JE.operation() mints one; the namespace parameter holds none).
      if (MEMBER.has(node.type) && !node.computed && OWNER_MEMBERS.has(node.property?.name) && node.object?.type === 'Identifier' && !NAMESPACE_NAMES.has(node.object.name)) {
        const b = lookup(frame, node.object.name);
        if (b?.param) hold(b.frame, node.object.name, `its parameter ${node.object.name}.${node.property.name}`);
      }
      if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && CALL.has(node.init?.type)) {
        const callee = normal(pathOf(node.init.callee)) || '';
        const options = node.init.arguments[0];
        if (CAPTURES.test(callee) || (/(^|\.)createSessionAction$/.test(callee) && options?.type === 'ObjectExpression' && options.properties.some(q => keyName(q) === 'owner')))
          hold(frame, node.id.name, `${node.id.name} = ${callee}(…)`);
      }
      if (CALL.has(node.type) && node.type !== 'NewExpression') {
        // An owner handed on from a parameter (JE.ownerOf(e), { owner: options.owner }, a publication's owner).
        const ownerCall = OWNER_OF.test(normal(pathOf(node.callee)) || '') || !!publicationOwner(node);
        for (const a of node.arguments) {
          const from = ownerCall ? ownerParam(a, frame) : a?.type === 'ObjectExpression'
            ? a.properties.filter(q => q.type === 'ObjectProperty' && ['owner', 'operation'].includes(keyName(q))).map(q => ownerParam(q.value, frame)).find(Boolean) : null;
          if (from) hold(from.frame, from.frame.params[from.index], `its parameter ${from.frame.params[from.index]} (an owner)`);
        }
        const callee = node.callee;
        calls.push({ file, frame, bare: callee.type === 'Identifier' ? callee.name : null, dotted: MEMBER.has(callee.type) ? normal(aliasPath(pathOf(callee), frame)) : null });
      }
      // Exported names: `X.name = function …`, `X.name = name`, `X = Object.freeze({ name, … })`, `Object.assign(X, { name, … })`.
      if (node.type === 'AssignmentExpression' && MEMBER.has(node.left.type)) {
        const target = normal(aliasPath(pathOf(node.left), frame));
        if (target && FUNCTION.has(node.right.type)) exportsOf.set(target, `${file}::${node.right.id?.name || node.left.property?.name}`);
        if (target && node.right.type === 'Identifier') exportsOf.set(target, `${file}::${node.right.name}`);
      }
      const objectOf = n => n?.type === 'ObjectExpression' ? n : CALL.has(n?.type) && normal(pathOf(n.callee)) === 'Object.freeze' ? n.arguments[0] : null;
      const exported = (target, object) => { if (target) for (const q of object?.properties || []) if (q.type === 'ObjectProperty' && q.value?.type === 'Identifier') exportsOf.set(`${target}.${keyName(q)}`, `${file}::${q.value.name}`); };
      if (node.type === 'AssignmentExpression' && MEMBER.has(node.left.type)) exported(normal(aliasPath(pathOf(node.left), frame)), objectOf(node.right));
      if (CALL.has(node.type) && normal(pathOf(node.callee)) === 'Object.assign') exported(normal(aliasPath(pathOf(node.arguments[0]), frame)), objectOf(node.arguments[1]));
    }
  }
  /** The frame on `frame`'s chain that holds an owner it can use: itself, or an enclosing one whose owner the inner code references. */
  const held = (file, frame) => {
    if (holding.has(frame)) return [frame, [...holding.get(frame).values()][0]];
    for (let g = frame.parent; g; g = g.parent) {
      if (!holding.has(g)) continue;
      const names = holding.get(g);
      const used = references.get(file).find(([n, f]) => n.start >= frame.node.start && n.end <= frame.node.end && names.has(n.name) && lookup(f, n.name)?.frame === g);
      if (used) return [g, `${names.get(used[0].name)}, captured`];
    }
    return null;
  };
  for (const { file, line, name, frame } of natives) {
    const where = held(file, frame);
    if (where) { failures.push(`${file}:${line} ${name}(JE.NATIVE) is in reach of ${where[0].name || 'a function'}, which holds an owner (${where[1]})`); continue; }
    const seen = new Set();
    let frontier = [[file, named(frame).name]];
    let found = null;
    for (let depth = 0; depth < 6 && frontier.length && !found; depth++) {
      const next = [];
      for (const [f, fn] of frontier) {
        const key = `${f}::${fn}`;
        if (!fn || fn === '(module)' || seen.has(key)) continue;
        seen.add(key);
        const paths = new Set([...exportsOf].filter(([, v]) => v === key).map(([k]) => k));
        for (const call of calls) {
          if (!((call.bare === fn && call.file === f) || (call.dotted && paths.has(call.dotted)))) continue;
          const caller = held(call.file, call.frame);
          if (caller) { found = `${call.file} ${caller[0].name || 'a function'}, which holds an owner (${caller[1]})`; break; }
          // A callback the host calls (anonymous, not an IIFE) starts the chain; a named function is followed to its callers.
          if (call.frame.name && !call.frame.iife) next.push([call.file, call.frame.name]);
        }
        if (found) break;
      }
      frontier = next;
    }
    if (found) failures.push(`${file}:${line} ${name}(JE.NATIVE) in ${named(frame).name} is reached from ${found}`);
  }
  return failures;
}

/**
 * The owner scan. `openers`: [{name, arg, prop?, callee: RegExp, file?, forbid?: string[], optional?: boolean}]: a call
 * of `name` whose dotted callee (through const aliases) matches `callee` (a bare call only in `file`, when given) must
 * pass argument `arg` (or that object argument's `prop`), not undefined/null; `forbid`: object keys that may never be
 * passed. An owner taken from an enclosing named function's parameter makes that function an owner-taker too (its
 * calls become sites); a parameter with a default (an explicit native fallback) does not. Returns {sites, failures, takers}.
 */
export function scanOwners(sources, openers, config = {}) {
  // config.nativeRoots / config.ownerRoots: {file: {fn | 'fn: value text': reason}}: where JE.NATIVE, and an owner taken
  // from a node (JE.ownerOf of anything but a press or a parameter), are genuine roots. config.hostDialogs: {file: reason},
  // modules whose host dialogs the bar cannot reach.
  const sites = []; const failures = [];
  const takers = new Map();
  const natives = [];
  const add = spec => { const list = takers.get(spec.name) || []; if (!list.some(x => x.file === spec.file && x.arg === spec.arg && String(x.callee) === String(spec.callee))) { list.push(spec); takers.set(spec.name, list); return true; } return false; };
  openers.forEach(add);
  const modules = Object.entries(sources).map(([file, text]) => [file, frames(parsed(text))]);
  const seen = new Set();
  for (let round = 0; round < 8; round++) {
    let grew = false;
    for (const [file, { visits }] of modules) {
      for (const [node, frame] of visits) {
        if (!CALL.has(node.type) || node.type === 'NewExpression') continue;
        const callee = node.callee;
        const name = callee.type === 'Identifier' ? callee.name : MEMBER.has(callee.type) ? callee.property?.name : null;
        const specs = name && takers.get(name);
        if (!specs) continue;
        const dotted = aliasPath(pathOf(callee), frame) || name;
        const spec = specs.find(x => x.callee.test(dotted) && !(x.file && callee.type === 'Identifier' && dotted === name && x.file !== file));
        if (!spec) continue;
        const id = `${file}:${node.start}`;
        if (seen.has(id)) continue;
        seen.add(id);
        const line = node.loc.start.line; const fn = named(frame).name;
        const site = { file, line, fn, opener: spec.label || name };
        const excluded = config.excludedModules?.[file];
        const fail = message => { if (excluded) site.excluded = true; else failures.push(message); };
        const arg = node.arguments[spec.arg];
        if (spec.forbid && arg?.type === 'ObjectExpression' && arg.properties.some(q => spec.forbid.includes(keyName(q)))) {
          sites.push({ ...site, owner: 'inferred' }); fail(`${file}:${line} ${name}({ ${spec.forbid.join(', ')} }) infers its owner`); continue;
        }
        if (spec.optional && (!arg || (arg.type === 'ObjectExpression' && !arg.properties.some(q => keyName(q) === spec.prop)))) continue;
        // `unless`: literal options under which the call opens nothing (openKey's { modal: false }).
        if (spec.unless && arg?.type === 'ObjectExpression' && Object.entries(spec.unless).every(([k, v]) =>
          arg.properties.some(q => q.type === 'ObjectProperty' && keyName(q) === k && q.value?.type === 'BooleanLiteral' && q.value.value === v))) continue;
        let value = arg;
        const derive = (from, how) => {
          const owner = from.frame.name;
          // The function takes an owner too: its bare calls in this file, and (unless its name is a common one or is
          // already declared) member calls of the same name anywhere. `holder`: the owner is a property of the
          // argument (an operation or capture passed whole), so only its presence is checked.
          if (owner && owner !== '(module)' && !openers.some(x => x.name === owner && !x.file)) {
            const member = !GENERIC.has(owner) && !openers.some(x => x.name === owner);
            const derived = { name: owner, arg: from.index, prop: from.prop, holder: !!from.prop, derived: `${file}:${line}` };
            grew = add({ ...derived, callee: new RegExp(`^${owner}$`), file }) || grew;
            if (member) grew = add({ ...derived, callee: new RegExp(`\\.${owner}$`) }) || grew;
          }
          sites.push({ ...site, owner: how + (owner ? ` (${owner} argument ${from.index}${from.prop ? '.' + from.prop : ''})` : ' (an anonymous callback\'s argument: a native entry point)') });
        };
        // An options object held in a const (`const options = cond ? {...} : {...}`): its literal(s).
        const literal = arg?.type === 'Identifier' && lookup(frame, arg.name)?.kind === 'const' ? lookup(frame, arg.name).init : null;
        if (spec.prop && literal && ['ObjectExpression', 'ConditionalExpression'].includes(literal.type)) {
          const objects = literal.type === 'ConditionalExpression' ? [literal.consequent, literal.alternate] : [literal];
          const values = objects.map(o => o.type === 'ObjectExpression' ? o.properties.find(q => q.type !== 'SpreadElement' && keyName(q) === spec.prop) : null)
            .map(q => q && (q.shorthand ? { type: 'Identifier', name: spec.prop, start: q.start, end: q.end } : q.value));
          if (values.some(v => !v || isUndefined(v))) { sites.push({ ...site, owner: 'missing' }); fail(`${file}:${line} ${name}(…) without an owner (${arg.name} has no ${spec.prop})`); continue; }
          const from = values.map(v => ownerParam(v, lookup(frame, arg.name).frame)).find(Boolean);
          if (from) { derive(from, `from a parameter via ${arg.name}.${spec.prop}`); continue; }
          sites.push({ ...site, owner: `${arg.name}.${spec.prop}` });
          continue;
        }
        if (spec.holder && arg && arg.type !== 'ObjectExpression') value = arg;
        else if (spec.prop && arg) {
          if (arg.type === 'ObjectExpression') {
            const p = arg.properties.find(q => q.type !== 'SpreadElement' && keyName(q) === spec.prop);
            const spread = arg.properties.find(q => q.type === 'SpreadElement' && q.argument.type === 'Identifier' && lookup(frame, q.argument.name)?.param);
            if (p) value = p.shorthand ? { type: 'Identifier', name: spec.prop, start: p.start, end: p.end } : p.value;
            else if (spread) { const b = lookup(frame, spread.argument.name); value = { forwarded: { frame: b.frame, index: b.index, prop: spec.prop } }; }
            else value = null;
          } else if (arg.type === 'Identifier' && lookup(frame, arg.name)?.param) { const b = lookup(frame, arg.name); value = { forwarded: { frame: b.frame, index: b.index, prop: spec.prop } }; }
          else value = { opaque: true };
        }
        if (value?.forwarded) { derive(value.forwarded, 'forwarded'); continue; }
        if (value?.opaque) { sites.push({ ...site, owner: 'unmodelled' }); fail(`${file}:${line} ${name}(…) passes its owner in options the scan cannot read`); continue; }
        if (!value || isUndefined(value)) { sites.push({ ...site, owner: 'missing' }); fail(`${file}:${line} ${name}(…) without an owner`); continue; }
        const text = sourceText(sources[file], value);
        // JE.NATIVE only at a pinned native root (D46S2-R7-1: a handler the bar can press never names itself native).
        if (nativeValue(value, frame)) {
          sites.push({ ...site, owner: 'JE.NATIVE' });
          if (!pinned(config.nativeRoots, file, fn, text)) fail(`${file}:${line} ${name}(JE.NATIVE) outside a pinned native root (${fn})`);
          else natives.push({ file, line, name, frame });
          continue;
        }
        const from = ownerParam(value, frame);
        // Inside a handler the owner is its press (D46S2-R7-1): its press argument, or an inner function's parameter
        // (that function's callers are sites); a node, a closure value or an enclosing function's parameter fail.
        const handler = handlerOf(frame);
        if (handler) {
          if (from && from.frame === handler && from.index === handler.press) { sites.push({ ...site, owner: 'the press' }); continue; }
          if (from && from.frame !== handler && within(from.frame, handler)) { derive(from, 'from a parameter'); continue; }
          if (!pinned(config.ownerRoots, file, fn, text)) {
            sites.push({ ...site, owner: 'not the press' });
            fail(`${file}:${line} ${name}(…) in a handler takes its owner from ${from ? (from.frame === handler ? 'argument ' + from.index : 'an enclosing function\'s parameter') : text}, not its press`);
            continue;
          }
        }
        // Outside a handler an owner taken from a node (JE.ownerOf of anything but a parameter) is a pinned root only.
        const taken = ownerOfCall(value, frame);
        const argument = taken?.arguments[0];
        const fromParameter = argument && (argument.type === 'Identifier' || MEMBER.has(argument.type)) && lookup(frame, rootName(argument) || '')?.param;
        if (taken && !fromParameter && !ownerParam(argument, frame) && !pinned(config.ownerRoots, file, fn, text)) {
          sites.push({ ...site, owner: 'from a node' });
          fail(`${file}:${line} ${name}(…) takes its owner from a node (${text}) outside a pinned root`);
          continue;
        }
        if (from) { derive(from, 'from a parameter'); continue; }
        sites.push({ ...site, owner: text });
      }
    }
    if (!grew) break;
  }
  failures.push(...nativeReach(modules, natives));
  // Host dialogs are openers (D46S2-R7-4): only JE.openHostDialog(() => …, owner) opens one.
  for (const [file, { visits }] of modules) {
    if (config.hostDialogs?.[file]) continue;
    for (const [node, frame] of visits) {
      if (!CALL.has(node.type)) continue;
      const callee = normal(pathOf(node.callee));
      if (!/^(Dashboard\.(alert|confirm)|alert|confirm|prompt)$/.test(callee || '')) continue;
      let inside = false;
      for (let f = frame; f && !inside; f = f.parent) {
        const parentCall = visits.find(([n]) => CALL.has(n.type) && n.arguments?.[0] === f.node);
        if (parentCall && normal(pathOf(parentCall[0].callee)) === 'JE.openHostDialog') inside = true;
      }
      if (!inside) failures.push(`${file}:${node.loc.start.line} ${callee}(…) opens a host dialog outside JE.openHostDialog`);
    }
  }
  return { sites, failures, takers };
}

/** The source text of a node (one line). */
function sourceText(text, node) {
  return node?.start != null ? text.slice(node.start, node.end).replace(/\s+/g, ' ').slice(0, 80) : '?';
}

// D46S2-R8-2 (one publication path): what a completion changes in the UI goes through the publication of the surface it
// started in (JE.publication), whose events carry it; a listener acts only where JE.published(event, node) holds.
const MUTATING_PROPS = new Set(['innerHTML', 'outerHTML', 'textContent', 'innerText', 'disabled', 'className', 'hidden', 'value', 'checked', 'title', 'src', 'href']);
const MUTATING_CALLS = new Set(['appendChild', 'append', 'prepend', 'insertBefore', 'insertAdjacentHTML', 'insertAdjacentElement', 'insertAdjacentText',
  'replaceWith', 'replaceChildren', 'removeChild', 'remove', 'setAttribute', 'removeAttribute', 'toggleAttribute', 'before', 'after']);
const GLOBAL_TARGETS = new Set(['document', 'window', 'document.body', 'document.documentElement']);
// Calls that only read the DOM (a completion listener may make them before its JE.published test).
const DOM_QUERIES = new Set(['querySelector', 'querySelectorAll', 'closest', 'matches', 'contains', 'getAttribute', 'hasAttribute', 'getBoundingClientRect']);

/** True when a node changes the DOM directly (a mutating property, style/dataset, classList, a mutating method). */
function domMutation(node) {
  if (node.type === 'AssignmentExpression' && MEMBER.has(node.left.type)) {
    if (MUTATING_PROPS.has(node.left.property?.name)) return true;
    if (MEMBER.has(node.left.object?.type) && ['style', 'dataset'].includes(node.left.object.property?.name)) return true;
  }
  if (CALL.has(node.type) && MEMBER.has(node.callee?.type)) {
    const method = node.callee.property?.name;
    if (MEMBER.has(node.callee.object?.type) && node.callee.object.property?.name === 'classList') return true;
    if (MUTATING_CALLS.has(method)) return true;
  }
  return false;
}

/**
 * The publication scan. `config`: {completion: RegExp (completion event types), publisher: the one module that may
 * dispatch them, listeners: {type: reason} (custom events whose listeners may change the DOM without a publication)}.
 * Fails: a completion event dispatched anywhere but the publisher (or an event of a type that is not a constant); a
 * listener of a completion event that changes the DOM (itself or through same-file functions it calls) without first
 * testing JE.published(event, node); a listener of any other custom event (document, window or body; a type with '-' or
 * ':') that changes the DOM, unless its type is listed with a reason. Returns {sites, failures}.
 */
export function scanPublications(sources, config) {
  const sites = []; const failures = [];
  for (const [file, text] of Object.entries(sources)) {
    const { visits, parents } = frames(parsed(text));
    const line = n => n.loc.start.line;
    // Functions by name in this module (declarations and const/let function values), for listeners added by name and calls.
    const named = new Map();
    for (const [node] of visits) {
      if (node.type === 'FunctionDeclaration' && node.id) named.set(node.id.name, [...(named.get(node.id.name) || []), node]);
      if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && FUNCTION.has(node.init?.type)) named.set(node.id.name, [...(named.get(node.id.name) || []), node.init]);
    }
    const inside = (n, fn) => n.start >= fn.start && n.end <= fn.end;
    /** The first DOM change a function makes (source position), directly or through same-file functions it calls. */
    const firstChange = (fn, seen = new Set()) => {
      if (seen.has(fn)) return null;
      seen.add(fn);
      let first = null;
      for (const [node] of visits) {
        if (!inside(node, fn)) continue;
        let at = null;
        if (domMutation(node)) at = node.start;
        else if (CALL.has(node.type) && node.callee?.type === 'Identifier' && named.has(node.callee.name) && named.get(node.callee.name).some(f => firstChange(f, seen) != null)) at = node.start;
        if (at != null && (first == null || at < first)) first = at;
      }
      return first;
    };
    /**
     * The first effect of a completion listener (source position): a DOM change, or any call but a DOM query, the
     * JE.published test itself and a type check (what another module's function does is not seen, so it counts).
     */
    const firstEffect = fn => {
      let first = firstChange(fn);
      for (const [node] of visits) {
        if (!inside(node, fn) || !CALL.has(node.type) || node === fn) continue;
        const callee = normal(pathOf(node.callee)) || '';
        if (callee === 'JE.published' || DOM_QUERIES.has(node.callee?.property?.name) || /^(String|Number|Array\.isArray|Boolean)$/.test(callee)) continue;
        if (first == null || node.start < first) first = node.start;
      }
      return first;
    };
    /** The first JE.published(…) a function tests (in an if, a condition or a logical expression), else null. */
    const firstGuard = fn => {
      let first = null;
      for (const [node] of visits) {
        if (!inside(node, fn) || !CALL.has(node.type) || normal(pathOf(node.callee)) !== 'JE.published') continue;
        let tested = false;
        for (let p = parents.get(node), c = node; p && !tested; c = p, p = parents.get(p)) {
          if ((p.type === 'IfStatement' || p.type === 'ConditionalExpression') && p.test === c) tested = true;
          else if (p.type === 'LogicalExpression' || (p.type === 'UnaryExpression' && p.operator === '!')) continue;
          else break;
        }
        if (tested && (first == null || node.start < first)) first = node.start;
      }
      return first;
    };
    // Listener functions of completion events (their effects follow a JE.published test).
    const completionListeners = [];
    for (const [node, frame] of visits) {
      // Dispatching a completion event: only the publication does.
      if (node.type === 'NewExpression' && ['CustomEvent', 'Event'].includes(normal(pathOf(node.callee)))) {
        const type = constString(node.arguments[0], frame);
        if (type == null && file !== config.publisher) { failures.push(`${file}:${line(node)} an event of a type that is not a constant (it could be a completion)`); continue; }
        if (type != null && config.completion.test(type) && file !== config.publisher) failures.push(`${file}:${line(node)} dispatches the completion event ${type} outside the publication (JE.publication)`);
        continue;
      }
      if (!CALL.has(node.type) || !MEMBER.has(node.callee?.type) || node.callee.property?.name !== 'addEventListener') continue;
      const type = constString(node.arguments[0], frame);
      const target = normal(aliasPath(pathOf(node.callee.object), frame));
      const completion = type != null && config.completion.test(type);
      const custom = type != null && /[-:]/.test(type);
      if (!completion && !(custom && GLOBAL_TARGETS.has(target))) continue;
      const handler = node.arguments[1];
      const fns = FUNCTION.has(handler?.type) ? [handler] : handler?.type === 'Identifier' ? named.get(handler.name) || [] : [];
      if (!fns.length) { failures.push(`${file}:${line(node)} a ${type} listener the scan cannot read`); continue; }
      for (const fn of fns) {
        const change = completion ? firstEffect(fn) : firstChange(fn);
        const site = { file, line: line(node), type, changes: change != null };
        sites.push(site);
        if (completion) completionListeners.push(fn);
        if (change == null) continue;
        if (completion) {
          // D46S2-R9-5: the publication is a capability; completions are not events any more. A listener of one is a
          // second channel (whatever it tests), so it fails.
          const guard = firstGuard(fn);
          failures.push(`${file}:${line(node)} a ${type} listener acts on a completion outside its publication (${guard == null || guard > change ? 'no JE.published test first' : 'completions are followed through JE.followPublications only'})`);
        } else if (!config.listeners?.[type]) failures.push(`${file}:${line(node)} a ${type} listener changes the DOM: a completion goes through JE.publication; any other custom event is listed with its reason`);
      }
    }
    // The publication's followers (D46S2-R9-5): functions handed to JE.followPublications, which core calls only for the
    // nodes a publication reaches. The capability's old guard is gone: JE.published anywhere fails.
    const followerFns = [];
    for (const [node] of visits) {
      if (!CALL.has(node.type)) continue;
      const callee = normal(pathOf(node.callee));
      if (callee === 'JE.followPublications') followerFns.push(...node.arguments.filter(a => FUNCTION.has(a?.type)));
      if (callee === 'JE.published') failures.push(`${file}:${line(node)} tests a completion with JE.published (a guard; completions change UI only through their publication's handle)`);
    }
    // Controls selected by title id across the document (the r7 cards' sync, the advanced form's "original button"):
    // only inside a follower's candidates (core applies what a publication reaches).
    for (const [node] of visits) {
      if (!CALL.has(node.type) || !['querySelector', 'querySelectorAll'].includes(node.callee?.property?.name)) continue;
      if (!GLOBAL_TARGETS.has(normal(pathOf(node.callee.object)))) continue;
      const selector = node.arguments[0];
      const text = selector?.type === 'StringLiteral' ? selector.value : selector?.type === 'TemplateLiteral' ? selector.quasis.map(q => q.value.cooked).join('') : '';
      if (!/data-tmdb-id/.test(text) || followerFns.some(fn => inside(node, fn))) continue;
      failures.push(`${file}:${line(node)} selects controls by title id across the document outside a publication's follower (one publication path)`);
    }
  }
  return { sites, failures };
}
