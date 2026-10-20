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

/** The dotted path of an expression (`window.ApiClient.ajax`), or null when it isn't a plain path. */
function pathOf(node) {
  if (!node) return null;
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'ThisExpression') return 'this';
  if (MEMBER.has(node.type) && !node.computed) { const object = pathOf(node.object); return object && node.property?.name ? object + '.' + node.property.name : null; }
  if (MEMBER.has(node.type) && node.computed && node.property.type === 'StringLiteral') { const object = pathOf(node.object); return object ? object + '.' + node.property.value : null; }
  if (CALL.has(node.type)) { const callee = pathOf(node.callee); return callee ? callee + '()' : null; }
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
function frames(ast) {
  const all = [];
  const top = { node: ast, name: '(module)', params: [], consts: new Map(), mutated: new Set(), parent: null };
  all.push(top);
  const visits = [];
  (function walk(node, frame, parentNode, nameHint) {
    if (!node || typeof node !== 'object') return;
    let inner = frame;
    if (FUNCTION.has(node.type)) {
      const name = node.id?.name || (node.key ? keyName(node) : null) || nameHint || null;
      inner = { node, name, params: paramNames(node), defaults: node.params.map(p => p.type === 'AssignmentPattern'), consts: new Map(), mutated: new Set(), parent: frame };
      all.push(inner);
    }
    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && node.init) inner.consts.set(node.id.name, { init: node.init, kind: parentNode?.kind });
    // `const { requestMedia, fetchUserQuota: quota } = JE.jellyseerrAPI`: each local name stands for the member it takes.
    if (node.type === 'VariableDeclarator' && node.id.type === 'ObjectPattern' && node.init) {
      const from = pathOf(node.init);
      for (const p of node.id.properties) if (p.type === 'ObjectProperty' && p.value.type === 'Identifier' && from) inner.consts.set(p.value.name, { destructured: from + '.' + keyName(p), kind: parentNode?.kind });
    }
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
  return { all, visits };
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

/** Resolves a callee path through const aliases (`const ac = window.ApiClient; ac.ajax`) to a normal path. */
function resolvePath(path, frame, depth = 0) {
  if (!path || depth > 5) return normal(path);
  const [head, ...rest] = path.split('.');
  if (['window', 'globalThis', 'self', 'JE', 'JellyfinEnhanced', 'ApiClient', 'fetch', 'navigator', 'XMLHttpRequest', 'ConnectionManager'].includes(head)) return normal(path);
  const binding = lookup(frame, head);
  if (!binding || binding.param) return normal(path);
  let init = binding.init;
  // `window.ApiClient || ConnectionManager.currentApiClient()` and `JE.core?.api`: the first operand names it.
  while (init?.type === 'LogicalExpression') init = init.left;
  const target = pathOf(init);
  if (!target || !transportRoot(resolvePath(target, binding.frame, depth + 1))) return normal(path);
  return resolvePath([target, ...rest].join('.'), binding.frame, depth + 1);
}

const WRITE = new Set(['POST', 'PUT', 'DELETE', 'PATCH']);
const API_TRANSPORT = { plugin: 1, pluginResponse: 1, fetch: 1, jf: 1, ajax: 0 };
const API_OTHER = new Set(['session', 'authHeaders', 'isPresentationAbort', 'manager']);
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
  // Pass 1: the entry points.
  for (const [file, { visits }] of modules) {
    for (const [node, frame, parent] of visits) {
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
          const target = resolvePath(pathOf(node), frame);
          const m = target?.match(/^(JE\.core\.api|ApiClient)\.([A-Za-z]+)$/);
          if (m && (m[1] === 'ApiClient' ? !CLIENT_ACCESSORS.has(m[2]) && !/^get[A-Z]/.test(m[2]) : m[2] in API_TRANSPORT)
            && !(parent?.type === 'UnaryExpression' && ['typeof', '!'].includes(parent.operator)) && !(parent?.type === 'IfStatement' || parent?.type === 'ConditionalExpression' && parent.test === node || parent?.type === 'LogicalExpression' && parent.left === node && parent.operator === '&&'))
            record({ file, line: node.loc.start.line, fn: named(frame).name, entry: target, kind: 'unmodelled', detail: 'a transport method taken as a value' });
        }
        continue;
      }
      const target = resolvePath(pathOf(node.callee), frame);
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
function ownerParam(value, frame, depth = 0) {
  if (!value || depth > 4) return null;
  if (CALL.has(value.type) && /^JE\.(ownerOf|requireOwner)$/.test(normal(pathOf(value.callee)) || '')) return ownerParam(value.arguments[0], frame, depth + 1);
  if (value.type === 'Identifier') {
    const b = lookup(frame, value.name);
    if (b?.param) return b.frame.params[b.index] && !b.frame.defaults?.[b.index] ? { frame: b.frame, index: b.index } : null;
    if (b?.kind === 'const' && b.init) return ownerParam(b.init, b.frame, depth + 1);
    return null;
  }
  if (MEMBER.has(value.type) && ['operation', 'owner'].includes(value.property?.name) && value.object?.type === 'Identifier') {
    const b = lookup(frame, value.object.name);
    if (b?.param && !b.frame.defaults?.[b.index]) return { frame: b.frame, index: b.index, prop: value.property.name };
  }
  return null;
}

/**
 * The owner scan. `openers`: [{name, arg, prop?, callee: RegExp, file?, forbid?: string[], optional?: boolean}]: a call
 * of `name` whose dotted callee (through const aliases) matches `callee` (a bare call only in `file`, when given) must
 * pass argument `arg` (or that object argument's `prop`), not undefined/null; `forbid`: object keys that may never be
 * passed. An owner taken from an enclosing named function's parameter makes that function an owner-taker too (its
 * calls become sites); a parameter with a default (an explicit native fallback) does not. Returns {sites, failures, takers}.
 */
export function scanOwners(sources, openers, config = {}) {
  const sites = []; const failures = [];
  const takers = new Map();
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
        const from = ownerParam(value, frame);
        if (from) { derive(from, 'from a parameter'); continue; }
        sites.push({ ...site, owner: sourceText(sources[file], value) });
      }
    }
    if (!grew) break;
  }
  return { sites, failures, takers };
}

/** The source text of a node (one line). */
function sourceText(text, node) {
  return node?.start != null ? text.slice(node.start, node.end).replace(/\s+/g, ' ').slice(0, 80) : '?';
}
