// Leak guard, adapted from Jellyfin Canopy's src/test/leak-guard.test.ts (GPL-3.0), extended for JE.
//
//   L1-unbounded-cache  a Map/Set/array/object that lives as long as the page (module scope, a top-level IIFE, or
//                       the closure of a top-level install/create function) and only grows: it is written
//                       (`set`/`add`/`push`/`unshift`/`x[k] =`) but the file never deletes from, clears, trims or
//                       reassigns it, and never hands it to other code. WeakMap/WeakSet are not counted.
//   L2-global-listener  `addEventListener` on window/document/document.body without a `signal` or `once: true`,
//                       in a file that never removes a listener for that event type.
//   L3-observer         a Mutation/Resize/Intersection/PerformanceObserver that is never disconnected (by the name it
//                       is stored under, or from its own callback) and never passed to `track(…)`.
//   L4-interval         a raw `setInterval` whose id is never stored, or stored under a name the file never passes to
//                       `clearInterval` or `track(…)`.
//   L5-retry-uncapped   a function that reschedules itself with setTimeout/requestAnimationFrame and has no bound:
//                       no comparison against a counter or limit, no Date.now()/performance.now() budget.
//   L6-object-url       URL.createObjectURL in a file that never calls URL.revokeObjectURL.
import {
  calleeName, findProperty, functionName, isFunctionLike, lastName, lineOf, receiverOf, references, resolve,
  scopeName, snippet, ts, unwrap, walk,
} from './lib.mjs';

const GLOBAL_TARGETS = new Set(['window', 'document', 'globalThis', 'self']);
const OBSERVERS = new Set(['MutationObserver', 'ResizeObserver', 'IntersectionObserver', 'PerformanceObserver']);
const RAW_TIMER_RECEIVERS = new Set(['window', 'globalThis', 'self']);
const ARRAY_ITERATION = new Set(['forEach', 'map', 'filter', 'reduce', 'some', 'every', 'flatMap', 'find', 'sort', 'findIndex']);
const GROW = new Set(['set', 'add', 'push', 'unshift']);
const SHRINK = new Set(['delete', 'clear', 'splice', 'shift', 'pop', 'length']);

const violation = (rule, node, detail = '') => ({
  rule, file: node.getSourceFile().fileName, key: `${rule} ${scopeName(node)}${detail ? ` ${detail}` : ''}`,
  line: lineOf(node), text: snippet(node, 90),
});

/** Names (last member names) passed to calls of `fnName` anywhere in the file, e.g. clearInterval(x.timer) → timer. */
function argumentNames(sf, predicate) {
  const names = new Set();
  walk(sf, node => {
    if (ts.isCallExpression(node) && predicate(node)) for (const a of node.arguments) { const n = lastName(a); if (n) names.add(n); }
  });
  return names;
}

/** The name a value is stored under: `const x = v`, `x = v`, `o.x = v`, `{ x: v }`; null when it is not stored. */
function holderName(node) {
  let e = node;
  let p = node.parent;
  while (p && (ts.isParenthesizedExpression(p) || ts.isAsExpression(p) || ts.isNonNullExpression(p) || ts.isSatisfiesExpression(p))) { e = p; p = p.parent; }
  if (!p) return null;
  if (ts.isVariableDeclaration(p) && p.initializer === e && ts.isIdentifier(p.name)) return p.name.text;
  if (ts.isBinaryExpression(p) && p.right === e && p.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    // `a = b = v` chains: the outermost holder is as good as any.
    return lastName(p.left);
  }
  if (ts.isPropertyAssignment(p) && p.initializer === e) return p.name.getText();
  if (ts.isPropertyDeclaration(p) && p.initializer === e) return p.name.getText();
  return null;
}

const isTrackCall = node => ts.isCallExpression(node) && calleeName(node) === 'track';
function trackedDirectly(node) {
  let p = node.parent;
  while (p && (ts.isParenthesizedExpression(p) || ts.isAsExpression(p))) p = p.parent;
  return Boolean(p && isTrackCall(p));
}

// ---------------------------------------------------------------------------------------------------------
// L1

const TOP_FACTORY = /^(install|create|init|setup|register|mount|start|boot|initialize|load)/i;

/** Does `scope` (a declaration's scope) live as long as the page? */
function longLived(scope) {
  if (ts.isSourceFile(scope)) return true;
  if (!isFunctionLike(scope) && !ts.isBlock(scope)) return false;
  const fn = ts.isBlock(scope) ? scope.parent : scope;
  if (!isFunctionLike(fn) || !(ts.isBlock(scope) ? true : fn.body)) return false;
  // a top-level IIFE, or a top-level (or exported) install/create… function
  let p = fn.parent;
  while (p && (ts.isParenthesizedExpression(p))) p = p.parent;
  if (p && ts.isCallExpression(p) && ts.isExpressionStatement(p.parent) && ts.isSourceFile(p.parent.parent)) return true;
  const atTop = ts.isSourceFile(fn.parent) || (ts.isVariableDeclaration(fn.parent) && ts.isSourceFile(fn.parent.parent.parent.parent));
  return atTop && TOP_FACTORY.test(functionName(fn) ?? '');
}

function collectionKind(init) {
  const e = unwrap(init);
  if (!e) return null;
  if (ts.isNewExpression(e) && ['Map', 'Set'].includes(lastName(e.expression) ?? '')) return lastName(e.expression);
  if (ts.isArrayLiteralExpression(e) && !e.elements.length) return 'Array';
  if (ts.isObjectLiteralExpression(e) && !e.properties.length) return 'Object';
  if (ts.isCallExpression(e) && e.expression.getText() === 'Object.create' && e.arguments[0]?.kind === ts.SyntaxKind.NullKeyword) return 'Object';
  return null;
}

function isIterationCallback(fn) {
  const p = fn.parent;
  return ts.isCallExpression(p) && p.arguments.includes(fn) && ARRAY_ITERATION.has(calleeName(p) ?? '');
}

function scanUnboundedCaches(sf) {
  const out = [];
  walk(sf, node => {
    if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name) || !node.initializer) return;
    const kind = collectionKind(node.initializer);
    if (!kind) return;
    const binding = resolve(node.name);
    if (!binding || !longLived(binding.scope)) return;
    const declaringFn = ts.isSourceFile(binding.scope) ? null : (ts.isBlock(binding.scope) ? binding.scope.parent : binding.scope);
    let grows = false;
    let bounded = false;
    for (const ref of references(binding)) {
      const p = ref.parent;
      if (ts.isPropertyAccessExpression(p) && p.expression === ref) {
        const name = p.name.text;
        const call = ts.isCallExpression(p.parent) && p.parent.expression === p ? p.parent : null;
        if (call && GROW.has(name)) {
          // Growth from the declaring function's own straight-line code is set-up, not a cache; count growth
          // that happens later, from a callback or nested function (other than an array iteration callback).
          let fn = null;
          for (let q = call.parent; q && q !== declaringFn; q = q.parent) if (isFunctionLike(q) && !isIterationCallback(q)) { fn = q; break; }
          if (fn) grows = true;
        }
        if (SHRINK.has(name)) bounded = true;
      } else if (ts.isElementAccessExpression(p) && p.expression === ref) {
        if (ts.isBinaryExpression(p.parent) && p.parent.left === p && p.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
          for (let q = p.parent.parent; q && q !== declaringFn; q = q.parent) if (isFunctionLike(q) && !isIterationCallback(q)) { grows = true; break; }
        }
        if (ts.isDeleteExpression(p.parent)) bounded = true;
      } else if (ts.isBinaryExpression(p) && p.left === ref && p.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        bounded = true;   // reassigned (reset)
      } else if ((ts.isCallExpression(p) && p.arguments.includes(ref)) || ts.isShorthandPropertyAssignment(p)
        || (ts.isPropertyAssignment(p) && p.initializer === ref) || ts.isReturnStatement(p)
        || (ts.isBinaryExpression(p) && p.right === ref) || ts.isExportSpecifier(p)) {
        bounded = true;   // handed to other code: its lifetime is managed there
      }
    }
    if (grows && !bounded) out.push(violation('L1-unbounded-cache', node, node.name.text));
  });
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// L2–L6

/** window, document, globalThis, self (also `host.window`), and `document.body` / `document.documentElement`. */
function isGlobalTarget(target) {
  const e = unwrap(target);
  if (!e) return false;
  if (GLOBAL_TARGETS.has(lastName(e) ?? '')) return true;
  return ts.isPropertyAccessExpression(e) && ['body', 'documentElement'].includes(e.name.text) && lastName(e.expression) === 'document';
}

function eventType(arg) {
  const e = arg && unwrap(arg);
  return e && ts.isStringLiteralLike(e) ? e.text : '<dynamic>';
}

function scanListeners(sf) {
  const removed = new Set();
  walk(sf, node => {
    if (ts.isCallExpression(node) && calleeName(node) === 'removeEventListener') removed.add(eventType(node.arguments[0]));
  });
  const out = [];
  walk(sf, node => {
    if (!ts.isCallExpression(node) || calleeName(node) !== 'addEventListener') return;
    const target = receiverOf(node);
    if (!target || !isGlobalTarget(target)) return;
    let options = node.arguments[2] && unwrap(node.arguments[2]);
    if (options && ts.isIdentifier(options)) {
      // `const listening = { signal }` … addEventListener(type, fn, listening)
      const binding = resolve(options);
      options = binding && ts.isVariableDeclaration(binding.decl) && binding.decl.initializer ? unwrap(binding.decl.initializer) : options;
    }
    if (options && ts.isObjectLiteralExpression(options)) {
      if (findProperty(options, 'signal')) return;
      const once = findProperty(options, 'once');
      if (once && ts.isPropertyAssignment(once) && once.initializer.kind === ts.SyntaxKind.TrueKeyword) return;
    }
    const type = eventType(node.arguments[0]);
    if (removed.has(type) || removed.has('<dynamic>')) return;
    out.push(violation('L2-global-listener', node, type));
  });
  return out;
}

function callbackDisconnects(callback) {
  const fn = callback && unwrap(callback);
  if (!fn || !(ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) return false;
  let found = false;
  walk(fn, n => { if (ts.isCallExpression(n) && calleeName(n) === 'disconnect') found = true; });
  return found;
}

function scanObservers(sf) {
  const disconnected = new Set();
  walk(sf, node => {
    if (ts.isCallExpression(node) && calleeName(node) === 'disconnect') {
      const r = receiverOf(node);
      const n = r && lastName(r);
      if (n) disconnected.add(n);
    }
  });
  const tracked = argumentNames(sf, isTrackCall);
  const out = [];
  walk(sf, node => {
    if (!ts.isNewExpression(node) || !OBSERVERS.has(lastName(node.expression) ?? '')) return;
    if (trackedDirectly(node) || callbackDisconnects(node.arguments?.[0])) return;
    const holder = holderName(node);
    if (holder && (disconnected.has(holder) || tracked.has(holder))) return;
    out.push(violation('L3-observer', node));
  });
  return out;
}

function isRawTimer(call, name) {
  if (calleeName(call) !== name) return false;
  const r = receiverOf(call);
  return !r || RAW_TIMER_RECEIVERS.has(lastName(r) ?? '');
}

function scanIntervals(sf) {
  const cleared = argumentNames(sf, n => calleeName(n) === 'clearInterval');
  const tracked = argumentNames(sf, isTrackCall);
  const out = [];
  walk(sf, node => {
    if (!ts.isCallExpression(node) || !isRawTimer(node, 'setInterval') || trackedDirectly(node)) return;
    const holder = holderName(node);
    if (holder && (cleared.has(holder) || tracked.has(holder))) return;
    out.push(violation('L4-interval', node));
  });
  return out;
}

function scanRetries(sf) {
  const out = [];
  walk(sf, node => {
    if (!isFunctionLike(node) || !node.body) return;
    const name = functionName(node);
    if (!name) return;
    let reschedules = null;
    let bounded = false;
    walk(node.body, n => {
      if (ts.isCallExpression(n) && (isRawTimer(n, 'setTimeout') || calleeName(n) === 'requestAnimationFrame')) {
        const cb = n.arguments[0] && unwrap(n.arguments[0]);
        const callsSelf = cb && ((ts.isIdentifier(cb) && cb.text === name)
          || ((ts.isArrowFunction(cb) || ts.isFunctionExpression(cb)) && (() => {
            let self = false;
            walk(cb, m => { if (ts.isCallExpression(m) && ts.isIdentifier(unwrap(m.expression)) && unwrap(m.expression).text === name) self = true; });
            return self;
          })()));
        if (callsSelf) reschedules ??= n;
      }
      if (ts.isBinaryExpression(n) && [ts.SyntaxKind.LessThanToken, ts.SyntaxKind.LessThanEqualsToken,
        ts.SyntaxKind.GreaterThanToken, ts.SyntaxKind.GreaterThanEqualsToken].includes(n.operatorToken.kind)) bounded = true;
      if (ts.isCallExpression(n) && calleeName(n) === 'now') bounded = true;
      return undefined;
    }, { ownOnly: false });
    if (reschedules && !bounded) out.push(violation('L5-retry-uncapped', reschedules));
  });
  return out;
}

function scanObjectUrls(sf) {
  let revokes = false;
  const creates = [];
  walk(sf, node => {
    if (!ts.isCallExpression(node)) return;
    if (calleeName(node) === 'revokeObjectURL') revokes = true;
    if (calleeName(node) === 'createObjectURL') creates.push(node);
  });
  return revokes ? [] : creates.map(n => violation('L6-object-url', n));
}

export function scanLeaks(project) {
  const out = [];
  for (const sf of project.files) {
    out.push(...scanUnboundedCaches(sf), ...scanListeners(sf), ...scanObservers(sf), ...scanIntervals(sf),
      ...scanRetries(sf), ...scanObjectUrls(sf));
  }
  return out.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}
