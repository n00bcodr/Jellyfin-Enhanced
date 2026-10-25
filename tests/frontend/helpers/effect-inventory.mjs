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
  for (;;) {
    if (node && MEMBER.has(node.type) && !node.computed) { parts.unshift(node.property.name); node = node.object; continue; }
    // A member of an assignment or a default (`(JE.internals = JE.internals || {}).arrHub`, `(JE.x || {}).y`) is a
    // member of what it assigns to or defaults (D46S2-R12: such nested aliases were invisible to the reachability).
    if (node && (node.type === 'AssignmentExpression' || node.type === 'LogicalExpression')) { node = node.left; continue; }
    break;
  }
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
const GUARD = /^(admit|current|effectOwner|admitSurface|runAs|later|isTopmostSurface|surfaceInput|focusIn|writable|mayWrite|newest|reaches|apply|mutate|run|shown|live|requireOrigin|isCurrent|holds|stillCurrent|admitted|valid|alive|isConnected|sameSession|mayAsk|ownerOf|isViewerInput|isCovered)$/;
// The names an argument hands its callee an owner or binding by (D46S2-R12: the argument itself, not a word in it).
const OWNER_NAME = /^(bound|owner|submitted|operation|press|event|e|ev|admitted|native|owned|action|publication|handle)$/;
const BINDING_CALL = /^(bound|operationBound)$/;
// Registering a foreground surface on the one stack (an opener's own function does it, or hands the node to one).
const REGISTER = /^(openSurface|openPopup|openHostDialog)$/;
// A node that is a foreground surface when it is inserted: its class or role says so.
const FOREGROUND = /(dialog|modal|sheet|drawer|backdrop|overlay|popup|popover)/i;
const WRITE_METHOD = /^(POST|PUT|DELETE|PATCH)$/i;

/** True when the AST `argument` hands its callee an owner or a binding (an identifier or member named as one, a
 * `.bound()` call, or an options object with such a property). A decoy word inside a longer name does not. */
function handsOwner(argument) {
  if (!argument) return false;
  if (argument.type === 'Identifier') return OWNER_NAME.test(argument.name);
  if (MEMBER.has(argument.type) && !argument.computed) return OWNER_NAME.test(argument.property.name);
  if (CALL.has(argument.type)) return BINDING_CALL.test(chain(argument.callee)?.at(-1) || '') || /^(ownerOf|captureSubmitted|effectOwner|requireOwner)$/.test(chain(argument.callee)?.at(-1) || '');
  if (argument.type === 'ObjectExpression') return argument.properties.some(p => p.type === 'ObjectProperty' && /^(bound|operation|owner)$/.test(p.key?.name ?? p.key?.value ?? '') && handsOwner(p.value.type === 'Identifier' && /^(bound|operation|owner)$/.test(p.value.name) ? p.value : p.value));
  if (argument.type === 'SpreadElement') return false;
  return false;
}
/** True when `node` (a statement) always leaves its block: return, throw, break, continue (or a block ending so). */
function exits(node) {
  if (!node) return false;
  if (/^(ReturnStatement|ThrowStatement|BreakStatement|ContinueStatement)$/.test(node.type)) return true;
  if (node.type === 'BlockStatement') return node.body.length > 0 && exits(node.body.at(-1));
  if (node.type === 'ExpressionStatement') return false;
  return false;
}
const within = (outer, node) => !!outer && node.start >= outer.start && node.end <= outer.end;
/**
 * True when `guard` dominates the effect at `node` (its ancestors `stack`), inside function `fn` (D46S2-R12: a guard
 * in another branch, in a nested function, or merely earlier in the source is no evidence): the effect is in the branch
 * a conditional's test containing the guard selects; or a statement before the effect's (in a block that contains it)
 * leaves the block when a test containing the guard (or a name declared from it) says so.
 */
function dominates(guard, node, stack, fn) {
  const from = fn ? stack.indexOf(fn) : -1;
  const chainOf = stack.slice(from + 1);
  for (let i = 0; i < chainOf.length; i++) {
    const a = chainOf[i], child = chainOf[i + 1] || node;
    if ((a.type === 'IfStatement' || a.type === 'ConditionalExpression') && within(a.test, guard) && (child === a.consequent || child === a.alternate)) return true;
    if (a.type === 'LogicalExpression' && a.operator === '&&' && within(a.left, guard) && child === a.right) return true;
    const body = a.type === 'BlockStatement' || a.type === 'Program' ? a.body : a.type === 'SwitchCase' ? a.consequent : null;
    if (!body) continue;
    const at = body.indexOf(child);
    const declared = new Set();
    for (const statement of body.slice(0, Math.max(0, at))) {
      if (statement.type === 'VariableDeclaration' && within(statement, guard)) for (const d of statement.declarations) if (d.id.type === 'Identifier') declared.add(d.id.name);
      if (statement.type !== 'IfStatement' || !exits(statement.consequent)) continue;
      if (within(statement.test, guard)) return true;
      let named = false;
      visit(statement.test, n => { if (n.type === 'Identifier' && declared.has(n.name)) named = true; });
      if (named) return true;
    }
  }
  return false;
}

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

/** The literal prefix of a route argument (a string, or a template up to its first expression). */
function routeOf(argument) {
  if (!argument) return '?';
  if (argument.type === 'StringLiteral') return argument.value.split('?')[0];
  if (argument.type === 'TemplateLiteral') return (argument.quasis[0]?.value.cooked || '').split('?')[0] + (argument.expressions.length ? '…' : '');
  return '…';
}
/** The method a transport call's options name: 'GET' when none, 'dynamic' when it is not a literal. */
function methodOf(options) {
  if (!options || options.type !== 'ObjectExpression') return options ? 'dynamic' : 'GET';
  const property = options.properties.find(p => p.type === 'ObjectProperty' && /^(method|type)$/.test(p.key?.name ?? p.key?.value ?? ''));
  if (!property) return options.properties.some(p => p.type === 'SpreadElement') ? 'dynamic' : 'GET';
  return property.value.type === 'StringLiteral' ? property.value.value.toUpperCase() : 'dynamic';
}

/** Every effect site of `file`: { file, fn, category, target, line, guarded, deferred, handed, registered }. */
export function sitesOf(file, text) {
  const ast = parsed(text);
  const { names } = moduleBindings(ast);
  const out = [];
  // Await positions per function (source offsets); guard calls per innermost function (never an enclosing one: a
  // nested callback's guard does not check its outer function's effect); registrations and foreground nodes per function.
  const awaits = new Map(), guards = new Map(), registers = new Set(), foreground = new Map(), locals = new Map();
  visit(ast.program, (node, stack) => {
    const fn = innermost(stack);
    if (node.type === 'AwaitExpression') { if (!awaits.has(fn)) awaits.set(fn, []); awaits.get(fn).push(node.end); }
    if (CALL.has(node.type)) {
      const name = chain(node.callee)?.at(-1) ?? node.callee.property?.name;
      if (GUARD.test(name || '')) { if (!guards.has(fn)) guards.set(fn, []); guards.get(fn).push(node); }
      if (REGISTER.test(name || '')) registers.add(fn);
      // A node marked a foreground surface in this function: `x.className = '…dialog…'`, `x.setAttribute('role', 'dialog')`,
      // `el('div', '…backdrop…')`, `document.createElement('dialog')`.
      const first = node.arguments[0], second = node.arguments[1];
      const parent = stack.at(-1);
      const assigned = parent?.type === 'VariableDeclarator' && parent.id.type === 'Identifier' ? parent.id.name : null;
      if (assigned && ((first?.type === 'StringLiteral' && first.value === 'dialog') || (second?.type === 'StringLiteral' && FOREGROUND.test(second.value)))) {
        if (!foreground.has(fn)) foreground.set(fn, new Set()); foreground.get(fn).add(assigned);
      }
      if (name === 'setAttribute' && first?.type === 'StringLiteral' && first.value === 'role' && second?.type === 'StringLiteral' && /dialog/.test(second.value)) {
        const target = chain(node.callee.object)?.[0];
        if (target) { if (!foreground.has(fn)) foreground.set(fn, new Set()); foreground.get(fn).add(target); }
      }
    }
    if (node.type === 'AssignmentExpression' && MEMBER.has(node.left.type) && node.left.property?.name === 'className' && node.right.type === 'StringLiteral' && FOREGROUND.test(node.right.value)) {
      const target = chain(node.left.object)?.[0];
      if (target) { if (!foreground.has(fn)) foreground.set(fn, new Set()); foreground.get(fn).add(target); }
    }
    // Closure-local mutable bindings: a `let` declared in a function (not the module's top level).
    if (node.type === 'VariableDeclaration' && node.kind === 'let' && fn && stack.some(n => FUNCTION.has(n.type))) {
      for (const d of node.declarations) if (d.id.type === 'Identifier') locals.set(d.id.name + '@' + fn.start, fn);
    }
  });
  const localOwner = (name, stack) => {
    for (let i = stack.length - 1; i >= 0; i--) if (FUNCTION.has(stack[i].type) && locals.has(name + '@' + stack[i].start)) return stack[i];
    return null;
  };
  const add = (node, stack, category, target, extra = {}) => {
    const fn = innermost(stack);
    const lastAwait = Math.max(-1, ...(awaits.get(fn) || []).filter(at => at <= node.start));
    const deferred = lastAwait >= 0 ? 'await' : inTimer(stack) ? 'timer' : null;
    const from = deferred === 'await' ? lastAwait : fn ? fn.start : 0;
    // A write, opener or navigation handed its owner (or its binding) is checked by its callee at the effect: the
    // transport right before the bytes go out, an opener's admission before it touches anything.
    const handed = category !== 'state' && CALL.has(node.type) && node.arguments.some(handsOwner);
    const guarded = handed || (guards.get(fn) || []).some(g => g.start >= from && g.start < node.start && dominates(g, node, stack, fn));
    out.push({ file, fn: functionName(stack), category, target, line: node.loc.start.line, deferred, guarded, handed, registered: registers.has(fn), ...extra });
  };
  visit(ast.program, (node, stack) => {
    const insideFunction = stack.some(n => FUNCTION.has(n.type));
    if (CALL.has(node.type)) {
      const names2 = chain(node.callee);
      const path = names2?.join('.') || '';
      const name = names2?.at(-1) || (node.callee.property?.name ?? '');
      if (names2 && NOT_PRIMITIVE.test(names2.slice(0, -1).join('.'))) return;
      // A transport write (D46S2-R12-1): the core transport called with a write method, by method and route.
      if (/(^|\.)core\.api\.(plugin|ajax|pluginResponse|fetch|jf)$/.test(path)) {
        const options = name === 'ajax' ? node.arguments[0] : node.arguments[1];
        const method = methodOf(options);
        if (method !== 'GET') { add(node, stack, 'write', `transport ${method} ${name === 'ajax' ? '(ajax)' : routeOf(node.arguments[0])}`); return; }
      }
      const qualified = QUALIFIED.find(([, re]) => re.test(path));
      if (qualified) { add(node, stack, qualified[0], path.split('.').slice(-2).join('.')); return; }
      for (const [category, re] of PRIMITIVES) if (re.test(name)) { add(node, stack, category, name); return; }
      // A foreground node put in the document (D46S2-R12-5): inserted into the body, or a node this function marked a
      // dialog, sheet, drawer, backdrop, overlay or popup — whatever the opener is called. It must be registered on the
      // one surface stack (the lint checks), else listed with its reason.
      if (/^(appendChild|append|insertBefore|prepend|insertAdjacentElement|replaceWith|after|before)$/.test(name) && insideFunction) {
        const host = chain(node.callee.object)?.join('.') || '';
        const inserted = node.arguments.map(a => a.type === 'Identifier' ? a.name : null).filter(Boolean);
        const marked = foreground.get(innermost(stack)) || new Set();
        if (/(^|\.)document\.(body|documentElement)$/.test(host)) { add(node, stack, 'surface', 'insert body'); return; }
        if (inserted.some(n => marked.has(n)) && !/(^|\.)document\.head$/.test(host)) { add(node, stack, 'surface', 'insert foreground'); return; }
      }
      // Shared state: a module-level collection changed inside a function.
      if (insideFunction && node.callee.type === 'MemberExpression' && node.callee.object.type === 'Identifier' && names.has(node.callee.object.name) &&
        /^(set|add|delete|clear|push|splice|pop|shift|unshift)$/.test(node.callee.property.name)) add(node, stack, 'state', node.callee.object.name);
      return;
    }
    if (node.type === 'AssignmentExpression') {
      const names2 = chain(node.left);
      if (names2 && /^(window\.)?location\.(hash|href)$/.test(names2.join('.'))) { add(node, stack, 'navigation', names2.slice(-2).join('.')); return; }
      if (insideFunction && node.left.type === 'Identifier' && names.has(node.left.name)) { add(node, stack, 'state', node.left.name); return; }
      if (node.left.type === 'Identifier') { const owner = localOwner(node.left.name, stack); if (owner && owner !== innermost(stack)) add(node, stack, 'state', 'closure ' + node.left.name); }
      return;
    }
    if (insideFunction && node.type === 'UpdateExpression' && node.argument.type === 'Identifier') {
      if (names.has(node.argument.name)) { add(node, stack, 'state', node.argument.name); return; }
      // A closure-local counter changed by a function it returned (D46S2-R12-7: latestIntent's own counter).
      const owner = localOwner(node.argument.name, stack);
      if (owner && owner !== innermost(stack)) add(node, stack, 'state', 'closure ' + node.argument.name);
    }
  });
  return out;
}

/** The key a manifest entry lists a site under. */
export const siteKey = site => `${site.fn} ${site.category} ${site.target}`;

/** Every site of `modules`, grouped: { file: { key: { n, lines, deferred, unguarded, handed, guarded, unregistered } } }. */
export function inventory(sources, modules) {
  const out = {};
  for (const file of [...modules].sort()) {
    const grouped = {};
    for (const site of sitesOf(file, sources[file])) {
      const entry = grouped[siteKey(site)] ||= { n: 0, lines: [], deferred: 0, unguarded: 0, handed: 0, guarded: 0, unregistered: 0 };
      entry.n++; entry.lines.push(site.line);
      if (site.category === 'surface' && site.target.startsWith('insert') && !site.registered) entry.unregistered++;
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
