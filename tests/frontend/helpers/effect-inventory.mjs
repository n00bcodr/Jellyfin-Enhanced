import { parsed, readSources } from './bundle-scan.mjs';

// D46 slice 2 review round 11: the mechanical EFFECT INVENTORY behind features-title-actions-effects.test.mjs.
// 1. Reachability: from the absent-title surfaces (ROOTS of the manifest), every function member a module CALLS through
//    the JE namespace (JE.a.b(), or an alias of it: `const internal = JE.internals.x`) leads to the modules that define
//    it; the closure is every module a title's action can run code in. Start-up wiring (initialize*, style injection) is
//    not a press's path; the manifest's BOUNDARY names the other edges not followed, each with its reason.
// 2. Sites: every effect primitive in every inventoried module, by enclosing function: owned writes, navigation, reload,
//    feedback, host and JE dialogs, surface open/close, focus moves and shared-state mutation (a module-level binding
//    changed inside a function: counters, intent slots, registries, caches).
// 3. Check at the effect: a site after an await in its function, or inside a timer's callback, must have an owner or
//    intent check between that point and itself (a recognised guard call), unless the manifest says why not.
// Run `node tests/frontend/helpers/effect-inventory.mjs` to print the inventory as found (a draft for the manifest).

const FUNCTION = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression', 'ObjectMethod', 'ClassMethod']);
const CALL = new Set(['CallExpression', 'OptionalCallExpression']);
const MEMBER = new Set(['MemberExpression', 'OptionalMemberExpression']);
const SKIP = new Set(['loc', 'start', 'end', 'leadingComments', 'trailingComments', 'innerComments', 'extra']);

/** Visits every node with its ancestors (`stack`, outermost first). */
function visit(node, fn, stack = []) {
  if (!node || typeof node.type !== 'string') return;
  fn(node, stack);
  stack.push(node);
  for (const key in node) {
    if (SKIP.has(key)) continue;
    const value = node[key];
    if (Array.isArray(value)) for (const child of value) visit(child, fn, stack);
    else if (value && typeof value.type === 'string') visit(value, fn, stack);
  }
  stack.pop();
}

/** The names of a member chain (`JE.a.b` → ['JE', 'a', 'b']), or null when it is not a plain chain. */
function chain(node) {
  const parts = [];
  while (node && MEMBER.has(node.type) && !node.computed) { parts.unshift(node.property.name); node = node.object; }
  if (node?.type === 'Identifier') { parts.unshift(node.name); return parts; }
  if (node?.type === 'ThisExpression') { parts.unshift('this'); return parts; }
  return null;
}

/** Each module's JE aliases (`const internal = JE.internals.x = …` → internal ↦ internals.x). */
function aliases(ast) {
  const map = new Map([['JE', ''], ['JellyfinEnhanced', '']]);
  const resolve = names => names && map.has(names[0]) ? [...(map.get(names[0]) ? map.get(names[0]).split('.') : []), ...names.slice(1)].join('.') : null;
  visit(ast.program, node => {
    if (node.type !== 'VariableDeclarator' || node.id.type !== 'Identifier' || !node.init) return;
    let value = node.init;
    while (value.type === 'AssignmentExpression') value = value.left;
    if (value.type === 'LogicalExpression') value = value.left;
    const path = resolve(chain(value));
    if (path) map.set(node.id.name, path);
  });
  // A local object published later (`JE.jellyseerrAPI = api`, `JE.x = Object.freeze(api)`): the local is that path too.
  visit(ast.program, node => {
    if (node.type !== 'AssignmentExpression') return;
    const path = resolve(chain(node.left));
    let value = node.right;
    if (CALL.has(value.type) && /^(freeze|assign)$/.test(value.callee.property?.name || '')) value = value.arguments[0];
    if (path && value?.type === 'Identifier' && !map.has(value.name)) map.set(value.name, path);
  });
  return resolve;
}

const isFunctionValue = v => !!v && (FUNCTION.has(v.type) || v.type === 'Identifier');

/** Per module: the JE function members it defines and the ones it calls. */
export function members(sources) {
  const defines = new Map(), calls = new Map(), reexports = new Map();
  for (const [file, text] of Object.entries(sources)) {
    const ast = parsed(text); const resolve = aliases(ast);
    const defined = new Set(), called = new Set();
    const objectKeys = (base, object) => {
      for (const property of object.properties || []) {
        if (!property.key) continue;
        const path = base + '.' + (property.key.name ?? property.key.value);
        if (property.type === 'ObjectMethod' || property.shorthand || isFunctionValue(property.value)) defined.add(path);
        // A re-export (`buildTitleControl: internal.buildTitleControl`): a call of it reaches the member it names.
        const named = MEMBER.has(property.value?.type) ? resolve(chain(property.value)) : null;
        if (named) { defined.add(path); reexports.set(path, named); }
      }
    };
    visit(ast.program, node => {
      if (node.type === 'AssignmentExpression') {
        const path = resolve(chain(node.left));
        if (!path) return;
        let value = node.right;
        while (value.type === 'AssignmentExpression') value = value.right;
        if (isFunctionValue(value)) defined.add(path);
        if (CALL.has(value.type) && /^(freeze|assign)$/.test(value.callee.property?.name || '')) value = value.arguments.at(-1);
        if (value?.type === 'ObjectExpression') objectKeys(path, value);
      }
      if (CALL.has(node.type) && node.callee.type === 'MemberExpression' && node.callee.object.name === 'Object' && node.callee.property.name === 'assign') {
        const path = resolve(chain(node.arguments[0]));
        if (path) for (const argument of node.arguments.slice(1)) if (argument.type === 'ObjectExpression') objectKeys(path, argument);
      }
      if (CALL.has(node.type)) { const path = resolve(chain(node.callee)); if (path) called.add(path); }
    });
    defines.set(file, defined); calls.set(file, called);
  }
  return { defines, calls, reexports };
}

/** Start-up wiring a press never runs: module initialisers and style injection. */
const STARTUP = /(^|\.)(initialize\w*|init|inject\w*Styles?|ensure|addMainStyles|addSeasonModalStyles|loadSettings|loadTranslations|styles)$/;

/**
 * The modules a title's action can run code in: the closure from `roots` over called JE function members, except the
 * start-up wiring and the `boundary` members ({ 'path.member': reason }) and modules ({ file: reason }).
 * Returns Map(file → how it was reached).
 */
export function reachable(sources, roots, boundary = {}) {
  const { defines, calls, reexports } = members(sources);
  const definers = new Map();
  for (const [file, defined] of defines) for (const path of defined) { if (!definers.has(path)) definers.set(path, new Set()); definers.get(path).add(file); }
  // A boundary member names a path or, ending in '.*', every member under it.
  const bounded = path => Object.keys(boundary.members || {}).some(key => key.endsWith('.*') ? path.startsWith(key.slice(0, -1)) : key === path);
  const reached = new Map(roots.map(root => [root, 'root']));
  const queue = [...roots];
  while (queue.length) {
    const file = queue.shift();
    for (const called of calls.get(file) || []) {
      // A re-exported member reaches the module it re-exports too.
      const paths = [called]; for (let p = reexports.get(called); p && !paths.includes(p); p = reexports.get(p)) paths.push(p);
      for (const path of paths) {
      if (STARTUP.test(path) || bounded(path)) continue;
      for (const next of definers.get(path) || []) {
        if (reached.has(next) || boundary.modules?.[next]) continue;
        reached.set(next, `${file} → ${path}`);
        queue.push(next);
      }
      }
    }
  }
  return reached;
}

// ------------------------------------------------------------------ effect primitives

const PRIMITIVES = [
  // Owned writes (the title actions' own write functions; a transport write is a site of its caller's function).
  ['write', /^(requestMedia|requestTvSeasons|reportIssue|setFollow|remind|saveTitleRule|mutateState|enableFor\w+|disableFor\w+|setUserPrefs|hideItem|unhideItem)$/],
  // Navigation.
  ['navigation', /^(navigate|navigateToJellyfinItem|showItem|openKey|openItem|pushState|replaceState|go|forward|assign|receive)$/],
  ['reload', /^(reload|scheduleFullReload)$/],
  // Feedback a page shows.
  ['feedback', /^(toast|showUndoToast|showMessage|announce|showError|setStatusText)$/],
  // Host and JE dialogs.
  ['dialog', /^(alert|confirm|prompt|openHostDialog|showQuotaErrorDialog|handleRequestError|showHideConfirmation|confirmAndHide|confirmDisableSpoiler|showModal|showReportModal|openDialog|removeDialog|showSeasonSelectionModal|showMovieRequestModal|showCollectionRequestModal)$/],
  // Surface open/close.
  ['surface', /^(openSurface|openPopup|admitSurface|show4KPopup|toggle4KPopup|showLink|openOrAsk|openCard|openRow|closeCurrentModal)$/],
  ['focus', /^(focus|blur|select)$/],
];
// Calls named like a primitive that are not one (value reads, array methods): the object they are called on.
const NOT_PRIMITIVE = /^(Promise|Object|Array|Math|JSON|console|URLSearchParams|Reflect|window\.history\.state)$/;
// The surface and navigation methods whose short names are too common to match alone: matched with their object.
const QUALIFIED = [
  ['write', /(^|\.)arrAsk\.(ask|cancel|adminSearch|familySearch)$/],
  ['navigation', /(^|\.)(Dashboard|appRouter|Page|titleDetails|history)\.(navigate|show\w*|back|open\w*)$/],
  ['navigation', /(^|\.)location\.(assign|replace)$/],
  ['surface', /(^|\.)(titleActions|A|arrAskSheet|arrManage|jellyseerrMoreInfo|moreInfoModal|jellyseerrModal|modal|ui)\.(show|open|close|create)$/],
];

/** The name of the nearest named enclosing function of `stack` ('(module)' at the top). */
function functionName(stack) {
  for (let i = stack.length - 1; i >= 0; i--) {
    const node = stack[i];
    if (!FUNCTION.has(node.type)) continue;
    if (node.id?.name) return node.id.name;
    if (node.key) return node.key.name ?? node.key.value;
    const parent = stack[i - 1];
    if (parent?.type === 'VariableDeclarator' && parent.id.type === 'Identifier') return parent.id.name;
    if (parent?.type === 'AssignmentExpression') { const names = chain(parent.left); if (names) return names.at(-1); }
    if (parent?.type === 'ObjectProperty' && parent.key) return parent.key.name ?? parent.key.value;
  }
  return '(module)';
}

/** The innermost function of `stack` (or the program). */
const innermost = stack => { for (let i = stack.length - 1; i >= 0; i--) if (FUNCTION.has(stack[i].type)) return stack[i]; return null; };
/** True when `stack` is inside a timer's callback (setTimeout, setInterval, requestAnimationFrame, queueMicrotask). */
function inTimer(stack) {
  for (let i = stack.length - 1; i > 0; i--) {
    const node = stack[i], parent = stack[i - 1];
    if (FUNCTION.has(node.type) && CALL.has(parent.type) && parent.arguments.includes(node)) {
      const name = chain(parent.callee)?.at(-1);
      if (/^(setTimeout|setInterval|requestAnimationFrame|queueMicrotask)$/.test(name || '')) return true;
    }
  }
  return false;
}
// Calls that check an owner, intent or surface at the moment they run.
// An argument that hands the callee its owner or binding.
const OWNER_ARGUMENT = /\b(bound|owner|submitted|operation|press)\b/;
const GUARD = /^(current|effectOwner|admitSurface|runAs|later|isTopmostSurface|writable|mayWrite|newest|reaches|apply|mutate|run|shown|live|requireOrigin|isCurrent|holds|stillCurrent|admitted|valid|alive|isConnected|sameSession|mayAsk)$/;

/** The module-level mutable bindings of a module (the classic-script IIFE's top level). */
function moduleBindings(ast) {
  let body = ast.program.body;
  const iife = body.find(s => s.type === 'ExpressionStatement' && CALL.has(s.expression.type) && FUNCTION.has(s.expression.callee.type));
  if (iife) body = iife.expression.callee.body.body;
  const names = new Map();
  for (const statement of body) {
    if (statement.type !== 'VariableDeclaration') continue;
    for (const d of statement.declarations) {
      if (d.id.type !== 'Identifier') continue;
      const init = d.init;
      const collection = init?.type === 'NewExpression' && /^(Map|Set|WeakMap|WeakSet)$/.test(init.callee.name);
      if (statement.kind === 'let' || collection || init?.type === 'ArrayExpression') names.set(d.id.name, statement.kind === 'let' ? 'let' : collection ? init.callee.name : 'Array');
    }
  }
  return { names, top: body };
}

/** Every effect site of `file`: { file, fn, category, target, line, guarded, deferred }. */
export function sitesOf(file, text) {
  const ast = parsed(text);
  const { names } = moduleBindings(ast);
  const out = [];
  // Await positions per function (source offsets), and guard calls per function.
  const awaits = new Map(), guards = new Map();
  visit(ast.program, (node, stack) => {
    const fn = innermost(stack);
    if (node.type === 'AwaitExpression') { if (!awaits.has(fn)) awaits.set(fn, []); awaits.get(fn).push(node.end); }
    if (CALL.has(node.type)) {
      const name = chain(node.callee)?.at(-1) ?? node.callee.property?.name;
      if (GUARD.test(name || '')) for (let i = stack.length - 1; i >= 0; i--) {
        if (!FUNCTION.has(stack[i].type)) continue;
        if (!guards.has(stack[i])) guards.set(stack[i], []);
        guards.get(stack[i]).push(node.start);
      }
    }
  });
  const add = (node, stack, category, target) => {
    const fn = innermost(stack);
    const lastAwait = Math.max(-1, ...(awaits.get(fn) || []).filter(at => at <= node.start));
    const deferred = lastAwait >= 0 ? 'await' : inTimer(stack) ? 'timer' : null;
    const from = deferred === 'await' ? lastAwait : fn ? fn.start : 0;
    // A write, opener or navigation handed its owner (or its binding) is checked by its callee at the effect: the
    // transport right before the bytes go out, an opener's admission before it touches anything.
    const handed = category !== 'state' && CALL.has(node.type) && node.arguments.some(argument => OWNER_ARGUMENT.test(text.slice(argument.start, argument.end)));
    const guarded = handed || (guards.get(fn) || []).some(at => at >= from && at < node.start);
    out.push({ file, fn: functionName(stack), category, target, line: node.loc.start.line, deferred, guarded, handed });
  };
  visit(ast.program, (node, stack) => {
    const insideFunction = stack.some(n => FUNCTION.has(n.type));
    if (CALL.has(node.type)) {
      const names2 = chain(node.callee);
      const path = names2?.join('.') || '';
      const name = names2?.at(-1) || (node.callee.property?.name ?? '');
      if (names2 && NOT_PRIMITIVE.test(names2.slice(0, -1).join('.'))) return;
      const qualified = QUALIFIED.find(([, re]) => re.test(path));
      if (qualified) { add(node, stack, qualified[0], path.split('.').slice(-2).join('.')); return; }
      for (const [category, re] of PRIMITIVES) if (re.test(name)) { add(node, stack, category, name); return; }
      // Shared state: a module-level collection changed inside a function.
      if (insideFunction && node.callee.type === 'MemberExpression' && node.callee.object.type === 'Identifier' && names.has(node.callee.object.name) &&
        /^(set|add|delete|clear|push|splice|pop|shift|unshift)$/.test(node.callee.property.name)) add(node, stack, 'state', node.callee.object.name);
      return;
    }
    if (node.type === 'AssignmentExpression') {
      const names2 = chain(node.left);
      if (names2 && /^(window\.)?location\.(hash|href)$/.test(names2.join('.'))) { add(node, stack, 'navigation', names2.slice(-2).join('.')); return; }
      if (insideFunction && node.left.type === 'Identifier' && names.has(node.left.name)) add(node, stack, 'state', node.left.name);
      return;
    }
    if (insideFunction && node.type === 'UpdateExpression' && node.argument.type === 'Identifier' && names.has(node.argument.name)) add(node, stack, 'state', node.argument.name);
  });
  return out;
}

/** The key a manifest entry lists a site under. */
export const siteKey = site => `${site.fn} ${site.category} ${site.target}`;

/** Every site of `modules`, grouped: { file: { key: { n, lines, deferred, unguarded, handed, guarded } } }. */
export function inventory(sources, modules) {
  const out = {};
  for (const file of [...modules].sort()) {
    const grouped = {};
    for (const site of sitesOf(file, sources[file])) {
      const entry = grouped[siteKey(site)] ||= { n: 0, lines: [], deferred: 0, unguarded: 0, handed: 0, guarded: 0 };
      entry.n++; entry.lines.push(site.line);
      if (site.handed) entry.handed++;
      if (site.guarded) entry.guarded++;
      if (site.deferred) { entry.deferred++; if (!site.guarded) entry.unguarded++; }
    }
    out[file] = grouped;
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { ROOTS, BOUNDARY } = await import('./effect-inventory-manifest.mjs');
  const sources = readSources();
  const reached = reachable(sources, ROOTS, BOUNDARY);
  for (const [file, how] of reached) console.log(`# ${file}  ⇐ ${how}`);
  console.log(JSON.stringify(inventory(sources, reached.keys()), null, 1));
}
