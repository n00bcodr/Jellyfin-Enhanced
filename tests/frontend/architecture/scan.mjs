// Shared scanner and rule collectors for the architecture guard tests (frontend.md §2.4, §5).
// Not a test file (no `.test.mjs`), so tests/frontend/run.mjs does not run it on its own.
//
// Import edges come from the TypeScript AST (the `typescript` devDependency), never from a regex, so
// imports inside comments or strings are not counted and every import form is (static, `export … from`,
// `import x = require()`, dynamic `import()`, and `import('x').T` type nodes).
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export { ts };
export const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
export const here = fileURLToPath(new URL('./', import.meta.url));
export const srcRoot = 'client/src';

// ---------------------------------------------------------------------------------------------------------
// Files

/** Repo-relative POSIX paths of every file under client/src ending in one of `extensions`, sorted. */
export function listSources(extensions = ['.ts']) {
  const out = [];
  (function walk(folder) {
    for (const entry of readdirSync(join(repoRoot, folder), { withFileTypes: true })) {
      const path = `${folder}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else if (extensions.some(ext => entry.name.endsWith(ext))) out.push(path);
    }
  })(srcRoot);
  return out.sort();
}

export const readSource = file => readFileSync(join(repoRoot, file), 'utf8');
export const readJson = name => JSON.parse(readFileSync(join(here, name), 'utf8'));

/** The canonical feature map (PLAN.md "Canonical feature list"), shared with the backend parity test. */
export const featureMapPath = 'docs/feature-map.json';
export const readFeatureMap = () => JSON.parse(readFileSync(join(repoRoot, featureMapPath), 'utf8'));
/** The map's rows whose own folder is client/src/features/<name> (kind `feature`), in map order. */
export const mappedFeatures = (map = readFeatureMap()) => map.features.filter(row => row.kind === 'feature');

/** `wc -l` semantics (the plan's baseline command): the number of newline characters. */
export const lineCount = text => text.split('\n').length - 1;

/**
 * Where a client/src file belongs. `features/admin-tags` is part of `media-tags` (PLAN.md canonical
 * feature list: admin-tags is folded into media-tags on both sides).
 * @returns {{ area: string, feature?: string }}
 */
export function classify(file) {
  const inner = file.startsWith(`${srcRoot}/`) ? file.slice(srcRoot.length + 1) : file;
  const parts = inner.split('/');
  if (parts[0] === 'features' && parts.length > 2) {
    return { area: 'feature', feature: parts[1] === 'admin-tags' ? 'media-tags' : parts[1] };
  }
  return { area: parts.length > 1 ? parts[0] : '(root)' };
}

/**
 * A feature's own bridge file: `features/<f>/**​/host.ts`, `host-*.ts` or `*-host.ts`. C1 moves
 * `host/<f>-host.ts` to `features/<f>/host*.ts` (seerr gets several, media-tags gets host.ts,
 * rules-host.ts and admin/host.ts), so all of these names count.
 */
export function isFeatureHostFile(file) {
  if (classify(file).area !== 'feature') return false;
  const base = posix.basename(file);
  return base === 'host.ts' || base.startsWith('host-') || base.endsWith('-host.ts');
}

// ---------------------------------------------------------------------------------------------------------
// Parsing

const parsed = new Map();
/** Parse a repo-relative .ts file once (syntax only). */
export function parse(file) {
  if (!parsed.has(file)) {
    parsed.set(file, ts.createSourceFile(file, readSource(file), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS));
  }
  return parsed.get(file);
}

let cachedConfig;
function clientConfig() {
  cachedConfig ??= ts.getParsedCommandLineOfConfigFile(join(repoRoot, 'client/tsconfig.json'), {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: d => { throw new Error(ts.flattenDiagnosticMessageText(d.messageText, '\n')); },
  });
  return cachedConfig;
}

let cachedProgram;
/** One type-checked program over client/tsconfig.json (needed only for rules 3 and 4). */
export function program() {
  if (!cachedProgram) {
    const config = clientConfig();
    cachedProgram = ts.createProgram({ rootNames: config.fileNames, options: config.options });
  }
  return cachedProgram;
}

/**
 * A type-checked program over in-memory files ({repo-relative path: text}) with client/tsconfig.json's options, for
 * the planted-violation self-tests. Other files (the libs) come from disk.
 */
export function virtualProgram(files) {
  const options = clientConfig().options;
  const texts = new Map(Object.entries(files).map(([path, text]) => [join(repoRoot, path).replaceAll('\\', '/'), text]));
  const host = ts.createCompilerHost(options);
  const { getSourceFile, fileExists, readFile, directoryExists } = host;
  host.getSourceFile = (name, language, ...rest) => texts.has(name)
    ? ts.createSourceFile(name, texts.get(name), language, true, ts.ScriptKind.TS)
    : getSourceFile.call(host, name, language, ...rest);
  host.fileExists = name => texts.has(name) || fileExists.call(host, name);
  host.readFile = name => texts.get(name) ?? readFile.call(host, name);
  host.directoryExists = name => [...texts.keys()].some(path => path.startsWith(`${name.replace(/\/$/, '')}/`))
    || directoryExists.call(host, name);
  return ts.createProgram({ rootNames: [...texts.keys()], options, host });
}

function resolveRelative(from, specifier) {
  const base = posix.normalize(posix.join(posix.dirname(from), specifier));
  const candidates = [base, `${base}.ts`, `${base}/index.ts`];
  if (/\.m?js$/.test(base)) candidates.push(base.replace(/\.m?js$/, '.ts'));
  for (const candidate of candidates) {
    const abs = join(repoRoot, candidate);
    if (existsSync(abs) && statSync(abs).isFile()) return candidate;
  }
  return null;
}

/**
 * Every module reference in a file.
 * kind: import | export | import-equals | dynamic-import | import-type (an `import('x').T` type node).
 * typeOnly: erased at build time. client/tsconfig.json sets `verbatimModuleSyntax`, so only an
 * `import type` / `export type` clause is erased; `import { type A } from 'x'` still emits `import 'x'`
 * (a runtime side-effect import), so it counts as runtime here.
 * target: the resolved repo-relative file for a relative specifier, else null.
 * @returns {{ specifier: string, target: string|null, typeOnly: boolean, kind: string, line: number }[]}
 */
export function moduleReferences(file, sf = parse(file)) {
  const refs = [];
  const add = (node, literal, kind, typeOnly) => {
    if (!literal || !ts.isStringLiteralLike(literal)) return;
    const specifier = literal.text;
    refs.push({
      specifier,
      target: specifier.startsWith('.') ? resolveRelative(file, specifier) : null,
      typeOnly,
      kind,
      line: lineOf(sf, node),
    });
  };
  (function visit(node) {
    if (ts.isImportDeclaration(node)) {
      add(node, node.moduleSpecifier, 'import', Boolean(node.importClause?.isTypeOnly));
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      add(node, node.moduleSpecifier, 'export', node.isTypeOnly);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      add(node, node.moduleReference.expression, 'import-equals', node.isTypeOnly);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      add(node, node.arguments[0], 'dynamic-import', false);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      add(node, node.argument.literal, 'import-type', true);
    }
    ts.forEachChild(node, visit);
  })(sf);
  return refs;
}

export const lineOf = (sf, node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

/** Strip parentheses, `as`, `satisfies`, `!` and `<T>` casts around an expression. */
export function unwrap(expression) {
  let e = expression;
  while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e)
    || ts.isTypeAssertionExpression(e) || ts.isSatisfiesExpression(e)) e = e.expression;
  return e;
}

// ---------------------------------------------------------------------------------------------------------
// Ratchet: current {file: {key: count}} against a baseline of the same shape.

/**
 * @returns {{ regressions: string[], improvements: string[] }} regressions: a (file, key) pair that is new or
 * whose count grew. improvements: a recorded pair whose count fell or vanished (the baseline can be lowered).
 */
export function compareCounts(current, baseline) {
  const regressions = [];
  const improvements = [];
  for (const [file, keys] of Object.entries(current)) {
    for (const [key, count] of Object.entries(keys)) {
      const allowed = baseline[file]?.[key] ?? 0;
      if (count > allowed) regressions.push(`${file}: ${key} ×${count} (baseline ${allowed})`);
    }
  }
  for (const [file, keys] of Object.entries(baseline)) {
    for (const [key, allowed] of Object.entries(keys)) {
      const count = current[file]?.[key] ?? 0;
      if (count < allowed) improvements.push(`${file}: ${key} ×${count} (baseline ${allowed}; lower it)`);
    }
  }
  return { regressions: regressions.sort(), improvements: improvements.sort() };
}

const bump = (map, file, key) => {
  map[file] ??= {};
  map[file][key] = (map[file][key] ?? 0) + 1;
};

/** Sort a {file: {key: n}} or {file: n} map for stable JSON. */
export function sortedMap(map) {
  return Object.fromEntries(Object.keys(map).sort().map(file => [file,
    typeof map[file] === 'object' ? Object.fromEntries(Object.keys(map[file]).sort().map(k => [k, map[file][k]])) : map[file]]));
}

// ---------------------------------------------------------------------------------------------------------
// §2.4 rules 1 and 2: imports

/** Runtime imports of these `features/<f>/public-api.ts` files are allowed (they re-export only pure modules). */
export const PURE_PUBLIC_APIS = new Set([]);

const CONTEXT = `${srcRoot}/host/context.ts`;

/**
 * Rule 1 (feature import rule) and rule 2 (host rule). A feature file may import its own feature, core/,
 * contracts/, host/context.ts, features/shared/ and `import type` from another feature's public-api.ts.
 * host/** may not import features/**.
 * @returns {{ violations: Record<string, Record<string, number>>, unresolved: string[], edges: Map<string, Set<string>> }}
 *   edges: runtime import edges between files of the same feature (for the cycle check).
 */
export function importViolations(files = listSources()) {
  const violations = {};
  const unresolved = [];
  const edges = new Map();
  for (const file of files) {
    const from = classify(file);
    for (const ref of moduleReferences(file)) {
      if (!ref.specifier.startsWith('.')) continue;   // client/src has no package imports today
      if (!ref.target) { unresolved.push(`${file}:${ref.line} ${ref.specifier}`); continue; }
      const to = classify(ref.target);
      if (from.area === 'feature') {
        if (to.area === 'feature' && to.feature === from.feature) {
          if (!ref.typeOnly) {
            if (!edges.has(file)) edges.set(file, new Set());
            edges.get(file).add(ref.target);
          }
          continue;
        }
        if (to.area === 'core' || to.area === 'contracts' || ref.target === CONTEXT) continue;
        if (to.area === 'feature' && to.feature === 'shared') continue;
        if (to.area === 'feature' && ref.target === `${srcRoot}/features/${to.feature}/public-api.ts`
          && (ref.typeOnly || PURE_PUBLIC_APIS.has(ref.target))) continue;
        bump(violations, file, `import ${ref.target}`);
      } else if (from.area === 'host' && to.area === 'feature') {
        bump(violations, file, `host-import ${ref.target}`);
      }
    }
  }
  return { violations, unresolved, edges };
}

/**
 * Import cycles inside one feature: strongly connected components (Tarjan) of the runtime same-feature
 * import graph that have more than one file or a self-import. Type-only imports are erased and never form
 * a runtime cycle, so they are left out.
 * @returns {string[][]} each component's files, sorted.
 */
export function cycles(edges) {
  let index = 0;
  const stack = [];
  const info = new Map();
  const out = [];
  const nodes = [...new Set([...edges.keys(), ...[...edges.values()].flatMap(s => [...s])])].sort();
  function strong(v) {
    info.set(v, { index, low: index, on: true });
    index++;
    stack.push(v);
    for (const w of [...(edges.get(v) ?? [])].sort()) {
      if (!info.has(w)) { strong(w); info.get(v).low = Math.min(info.get(v).low, info.get(w).low); }
      else if (info.get(w).on) info.get(v).low = Math.min(info.get(v).low, info.get(w).index);
    }
    if (info.get(v).low === info.get(v).index) {
      const component = [];
      let w;
      do { w = stack.pop(); info.get(w).on = false; component.push(w); } while (w !== v);
      if (component.length > 1 || edges.get(v)?.has(v)) out.push(component.sort());
    }
  }
  for (const v of nodes) if (!info.has(v)) strong(v);
  return out.sort((a, b) => a[0].localeCompare(b[0]));
}

// ---------------------------------------------------------------------------------------------------------
// §2.4 rules 3 and 4: internals and the raw global

const GLOBAL_NAMES = new Set(['window', 'globalThis', 'self']);

/**
 * Rule 4's platform files (frontend.md §2.4 rule 4, §5.2; step 1 decision, applied in C4): the core platform hosts
 * that stay in host/ after C1 and core/lifecycle-entry.ts. They are how the platform reaches the global, not features.
 */
export const PLATFORM_GLOBAL_FILES = new Set([
  'core-host.ts', 'api-host.ts', 'dom-host.ts', 'navigation-host.ts', 'session-host.ts', 'ui-host.ts',
  'admin-config-host.ts', 'bootstrap-pages-host.ts',
].map(name => `${srcRoot}/host/${name}`).concat(`${srcRoot}/core/lifecycle-entry.ts`));

function typeIsGlobal(type, checker, seen = new Set()) {
  if (seen.has(type)) return false;
  seen.add(type);
  if (type.isUnionOrIntersection()) return type.types.some(t => typeIsGlobal(t, checker, seen));
  const name = type.getSymbol()?.getName();
  if (name === 'Window' || name === 'globalThis') return true;
  return type.isClassOrInterface() && (checker.getBaseTypes(type) ?? []).some(t => typeIsGlobal(t, checker, seen));
}

const isThis = expression => unwrap(expression).kind === ts.SyntaxKind.ThisKeyword;

/**
 * The property names an expression used as a key can be: a string/number literal's text, else (through the checker)
 * the string literal type or union of them it has (`const k = 'internals'; o[k]`). null: not known (a dynamic key).
 */
export function keyExpressionNames(expression, checker) {
  const e = unwrap(expression);
  if (ts.isStringLiteralLike(e) || ts.isNumericLiteral(e)) return [e.text];
  if (!checker) return null;
  const type = checker.getTypeAtLocation(e);
  const parts = type.isUnion() ? type.types : [type];
  return parts.every(t => t.isStringLiteral()) ? parts.map(t => t.value) : null;
}

/** The names a declared property key (`{ k }`, `{ 'k': v }`, `{ [k]: v }`) can be; null: not known. */
function propertyKeyNames(name, checker) {
  if (!name) return null;
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name) || ts.isPrivateIdentifier(name)) {
    return [name.text];
  }
  if (ts.isComputedPropertyName(name)) return keyExpressionNames(name.expression, checker);
  return null;
}

/**
 * A property read: `a.b`, `a?.b`, `a['b']`, `` a[`b`] ``, `a[k]` (k typed as string literal(s), through the
 * checker) and `Reflect.get(a, 'b')`.
 * @returns {{ object: ts.Expression, names: string[]|null }|null} names: null for a dynamic key.
 */
export function propertyRead(node, checker) {
  if (ts.isPropertyAccessExpression(node)) return { object: node.expression, names: [node.name.text] };
  if (ts.isElementAccessExpression(node)) return { object: node.expression, names: keyExpressionNames(node.argumentExpression, checker) };
  if (ts.isCallExpression(node) && node.arguments.length >= 2) {
    const callee = unwrap(node.expression);
    if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'get'
      && ts.isIdentifier(unwrap(callee.expression)) && unwrap(callee.expression).text === 'Reflect') {
      return { object: node.arguments[0], names: keyExpressionNames(node.arguments[1], checker) };
    }
  }
  return null;
}

/** Is `node` an object/array literal written as an assignment target (`({ a } = v)`, `for ({ a } of vs)`, nested)? */
function isAssignmentPattern(node) {
  if (!ts.isObjectLiteralExpression(node) && !ts.isArrayLiteralExpression(node)) return false;
  let e = node;
  while (ts.isParenthesizedExpression(e.parent)) e = e.parent;
  const parent = e.parent;
  if (ts.isBinaryExpression(parent) && parent.left === e && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) return true;
  if ((ts.isForOfStatement(parent) || ts.isForInStatement(parent)) && parent.initializer === e) return true;
  if (ts.isPropertyAssignment(parent) && parent.initializer === e) return isAssignmentPattern(parent.parent);
  return ts.isArrayLiteralExpression(parent) && isAssignmentPattern(parent);
}

/**
 * The properties a destructuring pattern reads: `{ k }`, `{ k: x }`, `{ k: { … } }` and `{ ...rest }` in variable
 * declarations, parameters, catch clauses and for-of heads (ObjectBindingPattern), and the same as an assignment
 * target (`({ k: x } = v)`). names: null for a rest element or a dynamic key. value: the binding name or target
 * (an identifier, a nested pattern, or a member expression).
 * @returns {{ element: ts.Node, names: string[]|null, value: ts.Node|undefined }[]|null} null: not a pattern.
 */
export function patternElements(node, checker) {
  if (ts.isObjectBindingPattern(node)) {
    return node.elements.map(el => ({
      element: el,
      names: el.dotDotDotToken ? null : propertyKeyNames(el.propertyName ?? el.name, checker),
      value: el.name,
    }));
  }
  if (ts.isObjectLiteralExpression(node) && isAssignmentPattern(node)) {
    return node.properties.map(p => {
      if (ts.isShorthandPropertyAssignment(p)) return { element: p, names: [p.name.text], value: p.name };
      if (ts.isPropertyAssignment(p)) {
        const value = ts.isBinaryExpression(p.initializer) && p.initializer.operatorToken.kind === ts.SyntaxKind.EqualsToken
          ? p.initializer.left : p.initializer;   // `{ k: x = d }` → x
        return { element: p, names: propertyKeyNames(p.name, checker), value: unwrap(value) };
      }
      return { element: p, names: null, value: ts.isSpreadAssignment(p) ? p.expression : undefined };
    });
  }
  return null;
}

/**
 * What a pattern destructures: { expression } when the value is written (`= init`, a parameter default, the right side
 * of an assignment), { outer, names } for a nested pattern (the property `names` of the outer pattern's value), or {}.
 */
function patternSource(pattern) {
  const parent = pattern.parent;
  if (ts.isObjectBindingPattern(pattern)) {
    if ((ts.isVariableDeclaration(parent) || ts.isParameter(parent)) && parent.initializer) return { expression: parent.initializer };
    if (ts.isBindingElement(parent) && ts.isObjectBindingPattern(parent.parent)) {
      return { outer: parent.parent, names: parent.dotDotDotToken ? null : propertyKeyNames(parent.propertyName ?? parent.name) };
    }
    return {};
  }
  let e = pattern;
  while (ts.isParenthesizedExpression(e.parent)) e = e.parent;
  if (ts.isBinaryExpression(e.parent) && e.parent.left === e) return { expression: e.parent.right };
  if (ts.isPropertyAssignment(e.parent) && isAssignmentPattern(e.parent.parent)) {
    return { outer: e.parent.parent, names: propertyKeyNames(e.parent.name) };
  }
  return {};
}

/** Does this declaration hold the browser global (`x = window`, `{ host: window }`, `{ host } = f()`)? */
function declarationIsGlobal(d, checker, seen) {
  if (seen.has(d)) return false;
  seen.add(d);
  if ((ts.isVariableDeclaration(d) || ts.isPropertyAssignment(d)) && ts.isIdentifier(d.name) && d.initializer) {
    return isGlobalReference(d.initializer, checker, seen);
  }
  if (ts.isShorthandPropertyAssignment(d)) {
    return (checker.getShorthandAssignmentValueSymbol(d)?.declarations ?? []).some(x => declarationIsGlobal(x, checker, seen));
  }
  if (ts.isBindingElement(d) && ts.isObjectBindingPattern(d.parent) && ts.isVariableDeclaration(d.parent.parent)
    && d.parent.parent.initializer) {
    const name = (d.propertyName ?? d.name).getText();
    const property = checker.getTypeAtLocation(d.parent.parent.initializer).getProperty(name);
    return (property?.declarations ?? []).some(x => declarationIsGlobal(x, checker, seen));
  }
  return false;
}

/**
 * Does `expression` evaluate to the browser global (window/globalThis/self)? Follows what the hosts
 * actually do: `const host: X = window` aliases (casts included), `{ host } = bridge()` destructuring and
 * `{ host: window }` properties, `host.window` / `host['window']`, functions that `return window` (in any file,
 * through the checker), and anything typed `Window`, `typeof globalThis` or an interface extending Window.
 */
export function isGlobalReference(expression, checker, seen = new Set()) {
  const e = unwrap(expression);
  if (seen.has(e)) return false;
  seen.add(e);
  if (ts.isIdentifier(e)) {
    let symbol = checker.getSymbolAtLocation(e);
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    const declarations = symbol?.declarations ?? [];
    if (GLOBAL_NAMES.has(e.text) && declarations.every(d => d.getSourceFile().isDeclarationFile)) return true;
    if (declarations.some(d => declarationIsGlobal(d, checker, seen))) return true;
  } else if (ts.isPropertyAccessExpression(e)) {
    if (GLOBAL_NAMES.has(e.name.text)) return true;
    const declarations = checker.getSymbolAtLocation(e.name)?.declarations ?? [];
    if (declarations.some(d => declarationIsGlobal(d, checker, seen))) return true;
  } else if (ts.isElementAccessExpression(e)) {
    if ((keyExpressionNames(e.argumentExpression, checker) ?? []).some(n => GLOBAL_NAMES.has(n))) return true;
  } else if (ts.isCallExpression(e)) {
    const declaration = checker.getResolvedSignature(e)?.declaration;
    if (declaration && !seen.has(declaration) && functionReturns(declaration, checker, seen, isGlobalReference)) return true;
  }
  return typeIsGlobal(checker.getTypeAtLocation(e), checker);
}

/** Does any `return` of this function (or its expression body) satisfy `test`? */
function functionReturns(declaration, checker, seen, test) {
  seen.add(declaration);
  const body = declaration.body;
  if (!body) return false;
  if (!ts.isBlock(body)) return test(body, checker, seen);
  let found = false;
  (function visit(node) {
    if (found || (node !== body && ts.isFunctionLike(node))) return;
    if (ts.isReturnStatement(node) && node.expression && test(node.expression, checker, seen)) found = true;
    ts.forEachChild(node, visit);
  })(body);
  return found;
}

/** Is the value a destructuring pattern reads the browser global (directly, through an alias or by its type)? */
function patternIsGlobal(pattern, checker) {
  const source = patternSource(pattern);
  if (source.expression && isGlobalReference(source.expression, checker)) return true;
  const type = ts.isObjectBindingPattern(pattern) ? checker.getTypeAtLocation(pattern)
    : source.expression ? checker.getTypeAtLocation(source.expression) : null;
  return Boolean(type && typeIsGlobal(type, checker));
}

const INTERNALS = 'internals';
const RAW_GLOBAL = 'JellyfinEnhanced';
const VALUE_OPERATORS = new Set([
  ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.AmpersandAmpersandToken,
  ts.SyntaxKind.EqualsToken, ts.SyntaxKind.BarBarEqualsToken, ts.SyntaxKind.QuestionQuestionEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken, ts.SyntaxKind.CommaToken,
]);

/** Does this declaration hold a `JE.internals` object (`i = JE.internals`, `{ internals: i } = JE`, `{ i: JE.internals }`)? */
function declarationIsInternals(d, checker, seen) {
  if (seen.has(d)) return false;
  seen.add(d);
  if ((ts.isVariableDeclaration(d) || ts.isParameter(d) || ts.isPropertyAssignment(d) || ts.isPropertyDeclaration(d))
    && ts.isIdentifier(d.name) && d.initializer) {
    return isInternalsValue(d.initializer, checker, seen);
  }
  if (ts.isShorthandPropertyAssignment(d)) {
    return (checker.getShorthandAssignmentValueSymbol(d)?.declarations ?? []).some(x => declarationIsInternals(x, checker, seen));
  }
  if (ts.isBindingElement(d) && ts.isIdentifier(d.name) && ts.isObjectBindingPattern(d.parent) && !d.dotDotDotToken) {
    const source = patternSource(d.parent);
    return Boolean(propertyKeyNames(d.propertyName ?? d.name, checker)?.includes(INTERNALS)
      && !(source.expression && isThis(source.expression)));
  }
  return false;
}

/**
 * Does `expression` evaluate to a `JE.internals` object? `x.internals` / `x?.['internals']` / `x[k]` /
 * `Reflect.get(x, 'internals')` on anything but `this`, aliases (`const i = JE.internals`, `{ internals: i } = JE`,
 * `{ i: JE.internals }`), `JE.internals ||= {}` / `??` / `||` / `,` / `?:` values, and functions that return one
 * (through the checker, in any file).
 */
export function isInternalsValue(expression, checker, seen = new Set()) {
  const e = unwrap(expression);
  if (seen.has(e)) return false;
  seen.add(e);
  const read = propertyRead(e, checker);
  if (read) {
    if (read.names?.includes(INTERNALS) && !isThis(read.object)) return true;
    if (!ts.isPropertyAccessExpression(e)) return false;
    return (checker.getSymbolAtLocation(e.name)?.declarations ?? []).some(d => declarationIsInternals(d, checker, seen));
  }
  if (ts.isIdentifier(e)) {
    let symbol = checker.getSymbolAtLocation(e);
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    return (symbol?.declarations ?? []).some(d => declarationIsInternals(d, checker, seen));
  }
  if (ts.isBinaryExpression(e) && VALUE_OPERATORS.has(e.operatorToken.kind)) {
    return (e.operatorToken.kind !== ts.SyntaxKind.CommaToken && isInternalsValue(e.left, checker, seen))
      || isInternalsValue(e.right, checker, seen);
  }
  if (ts.isConditionalExpression(e)) return isInternalsValue(e.whenTrue, checker, seen) || isInternalsValue(e.whenFalse, checker, seen);
  if (ts.isCallExpression(e)) {
    const declaration = checker.getResolvedSignature(e)?.declaration;
    return Boolean(declaration && !seen.has(declaration) && functionReturns(declaration, checker, seen, isInternalsValue));
  }
  return false;
}

/** Does a destructuring pattern read a `JE.internals` object (`{ a } = JE.internals`, `{ internals: { a } } = JE`)? */
function patternIsInternals(pattern, checker) {
  const source = patternSource(pattern);
  if (source.expression) return isInternalsValue(source.expression, checker);
  if (source.outer) {
    const outer = patternSource(source.outer);
    return Boolean(source.names?.includes(INTERNALS) && !(outer.expression && isThis(outer.expression)));
  }
  return false;
}

/** The outermost expression whose value is `node` (through parentheses, `as`, `!`, `satisfies`, `<T>`). */
function outermost(node) {
  let e = node;
  while (e.parent && (ts.isParenthesizedExpression(e.parent) || ts.isAsExpression(e.parent) || ts.isNonNullExpression(e.parent)
    || ts.isTypeAssertionExpression(e.parent) || ts.isSatisfiesExpression(e.parent)) && e.parent.expression === e) e = e.parent;
  return e;
}

/**
 * The slots read directly off an internals reference `node` (counted on the reference, outside a host file):
 * `node.slot`, `(node as T)?.['slot']`, `const { slot } = node`; else ['*'] (the whole object).
 */
function directSlots(node, checker) {
  const outer = outermost(node);
  const read = propertyRead(outer.parent, checker);
  if (read && read.object === outer) return read.names ?? ['?'];
  if (ts.isVariableDeclaration(outer.parent) && outer.parent.initializer === outer && ts.isObjectBindingPattern(outer.parent.name)) {
    return patternElements(outer.parent.name, checker).flatMap(el => el.names ?? ['?']);
  }
  return ['*'];
}

/** Is `expression` itself an internals reference (`x.internals`, `x['internals']`, …), not an alias of one? */
const isDirectInternals = (expression, checker) => {
  const read = propertyRead(unwrap(expression), checker);
  return Boolean(read?.names?.includes(INTERNALS) && !isThis(read.object));
};

/**
 * Rule 3 (internals) and rule 4 (raw global), from the type-checked program (`prog`, default the client program).
 *
 * Rule 3. An internals reference is any read of a property named `internals` on anything but `this`: `.internals`,
 * `?.internals`, `['internals']`, `[k]` with k typed `'internals'`, `Reflect.get(x, 'internals')`, and destructuring
 * (`{ internals } = JE`, `{ internals: i }`, `{ internals: { slot } }`, in declarations, parameters, for-of heads
 * and assignment patterns). Today every one of them is on a JE bridge (`JE`, `je`, `JE()`), and counting all of them
 * closes the `const b = JE; b.internals` loophole. Outside a feature host file each one is a violation
 * (`internals <slot>`, `*` for the whole object), and so is each slot read off a `JE.internals` value the file got
 * through an alias or a call (a host function that returns `JE.internals`). In a feature host file the whole object
 * is the owner's own (it hands it to featureContext), but every slot read off it must be a slot the feature owns
 * (internals-owners.json), however it is reached: `JE.internals.slot`, `(JE.internals as T)?.['slot']`,
 * `{ slot } = JE.internals`, `{ internals: { slot } } = JE`, `const i = JE.internals; i.slot`,
 * `(JE.internals ||= {}).slot`, a function returning `JE.internals`, or a key typed as a literal. A slot read with a
 * dynamic key (`JE.internals[name]`) or a `...rest` of it is not provably owned and counts as `internals-foreign ?`.
 *
 * Rule 4 flags reading `JellyfinEnhanced` off the browser global, allowed only in host/context.ts,
 * features/<f>/host*.ts, bootstrap/**, and PLATFORM_GLOBAL_FILES: the core platform hosts that stay in host/ after C1
 * and core/lifecycle-entry.ts (frontend.md §2.4 rule 4, §5.2; step C4). Every read form counts (`window.X`,
 * `window?.X`, `window['X']`, `window[k]`, `Reflect.get(window, 'X')`) on anything that is the global (isGlobalReference:
 * aliases, `host.window`, functions returning it, values typed Window/globalThis), and every destructuring of it
 * (`{ JellyfinEnhanced } = window`, `{ JellyfinEnhanced: je } = globalThis`, a `(w: Window)` or `= window` parameter
 * pattern, nested patterns, `({ JellyfinEnhanced: je } = window)`).
 */
export function bridgeViolations(owners, prog = program()) {
  const violations = {};
  const checker = prog.getTypeChecker();
  for (const sf of prog.getSourceFiles()) {
    if (sf.isDeclarationFile) continue;
    const file = posix.relative(repoRoot.replaceAll('\\', '/'), sf.fileName.replaceAll('\\', '/'));
    if (!file.startsWith(`${srcRoot}/`)) continue;
    const where = classify(file);
    const hostFile = isFeatureHostFile(file);
    const globalAllowed = hostFile || file === CONTEXT || where.area === 'bootstrap' || PLATFORM_GLOBAL_FILES.has(file);
    // A slot read off a JE.internals value: outside a host file every one is a violation; in a host file only one the
    // feature does not own (or a dynamic key / rest, `?`).
    const slotRead = slot => {
      if (!hostFile) bump(violations, file, `internals ${slot}`);
      else if (slot === '?' || !(owners[slot] ?? []).includes(where.feature)) bump(violations, file, `internals-foreign ${slot}`);
    };
    (function visit(node) {
      const read = propertyRead(node, checker);
      if (read) {
        // Rule 3: the internals reference itself, outside a host file (with the slots read directly off it).
        if (!hostFile && read.names?.includes(INTERNALS) && !isThis(read.object)) {
          for (const slot of directSlots(node, checker)) bump(violations, file, `internals ${slot}`);
        }
        // Rule 3: a slot read off a JE.internals value (outside a host file, unless already counted on the reference).
        if ((hostFile || !isDirectInternals(read.object, checker)) && isInternalsValue(read.object, checker)) {
          for (const slot of read.names ?? ['?']) slotRead(slot);
        }
        // Rule 4.
        if (!globalAllowed && read.names?.includes(RAW_GLOBAL) && isGlobalReference(read.object, checker)) {
          bump(violations, file, `raw-global ${RAW_GLOBAL}`);
        }
      }
      const elements = patternElements(node, checker);
      if (elements) {
        const source = patternSource(node);
        const ofThis = Boolean(source.expression && isThis(source.expression));
        // Already counted on the reference outside a host file: `{ slot } = JE.internals` (directSlots) and
        // `{ internals: { slot } } = JE` (below).
        const counted = !hostFile && (source.outer || (source.expression && isDirectInternals(source.expression, checker)));
        const internalsPattern = !counted && patternIsInternals(node, checker);
        let globalPattern;
        for (const { names, value } of elements) {
          // Rule 3: `{ internals } = JE`, `{ internals: i }`, `{ internals: { slot } }`.
          if (!hostFile && !ofThis && names?.includes(INTERNALS)) {
            const nested = value && patternElements(value, checker);
            for (const slot of nested ? nested.flatMap(n => n.names ?? ['?']) : ['*']) bump(violations, file, `internals ${slot}`);
          }
          // Rule 3: `{ slot } = <JE.internals value>`.
          if (internalsPattern) for (const slot of names ?? ['?']) slotRead(slot);
          // Rule 4.
          if (!globalAllowed && names?.includes(RAW_GLOBAL)) {
            globalPattern ??= patternIsGlobal(node, checker);
            if (globalPattern) bump(violations, file, `raw-global ${RAW_GLOBAL}`);
          }
        }
      }
      ts.forEachChild(node, visit);
    })(sf);
  }
  return violations;
}

// ---------------------------------------------------------------------------------------------------------
// §5.3 generated markers

/**
 * Generated files under client/src (frontend.md §5.3). An entry with a `/` is a path; a bare name is looked up
 * by basename anywhere under client/src, so B2's moves of the GEN files need no edit here.
 */
export const GENERATED_SOURCES = [
  'client/src/contracts/generated.ts',
  'client/src/contracts/schema.ts',
  'status-vocabulary.ts',
  'compact-quality.ts',
  'per-user-props.ts',
  'genre-table.ts',
];
// Not listed (coordinator decision E1 (a), step-logs/lane-lm.md): awards-data.ts, rating-data.ts and
// media-language.ts are hand-written source-of-truth tables (no generator; scripts/build_poster_assets.py only
// reads them), and quality-data.ts is hand-written apart from the aspect-ratio region that
// scripts/generate_technical_ratios.py rewrites between its in-body markers. None carries a file header or
// linguist-generated, and all four stay under the file-size guardrail.

/** Other generated outputs that must carry `linguist-generated` in .gitattributes (§5.3). */
export const GENERATED_OUTPUTS = [
  'client/generated-manifest.json',
  'Jellyfin.Plugin.JellyfinEnhanced/js/**/*.js.map',
];

/**
 * The file's header: the comments before its first token (after a BOM or shebang).
 * A generated header starts with `Generated by <tool>` or `GENERATED by <tool>` and the tool path exists, e.g.
 * `// Generated by tools/ClientContracts. Do not edit.`
 * @returns {{ header: string, generated: boolean, tool: string|null, toolExists: boolean }}
 */
export function generatedHeader(text) {
  const start = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const ranges = ts.getLeadingCommentRanges(text, ts.getShebang(text.slice(start))?.length ?? start) ?? [];
  const header = ranges.map(r => text.slice(r.pos, r.end)).join('\n');
  const first = ranges[0] ? text.slice(ranges[0].pos, ranges[0].end).replace(/^\/[/*]+\s*/, '') : '';
  const match = /^(?:Generated|GENERATED) by\s+([^\s;,]+?)[.;,]?(?:\s|$)/.exec(first);
  const tool = match?.[1] ?? null;
  return { header, generated: Boolean(match), tool, toolExists: Boolean(tool && existsSync(join(repoRoot, tool))) };
}

/**
 * Resolve GENERATED_SOURCES to files. A bare name must match exactly one file under client/src.
 * @returns {{ entry: string, files: string[] }[]}
 */
export function generatedSourceFiles(sources = listSources()) {
  return GENERATED_SOURCES.map(entry => ({
    entry,
    files: entry.includes('/') ? sources.filter(f => f === entry) : sources.filter(f => posix.basename(f) === entry),
  }));
}

/** path → its `linguist-generated` attribute value (`true`, `unspecified`, …), or null without git. */
export function linguistGenerated(paths) {
  const result = spawnSync('git', ['check-attr', '--stdin', 'linguist-generated'], {
    cwd: repoRoot, input: paths.join('\n') + '\n', encoding: 'utf8',
  });
  if (result.error || result.status !== 0) return null;
  const values = new Map();
  for (const line of result.stdout.split('\n')) {
    const at = line.lastIndexOf(': linguist-generated: ');
    if (at >= 0) values.set(line.slice(0, at), line.slice(at + ': linguist-generated: '.length));
  }
  return values;
}

/** Tracked files for a GENERATED_OUTPUTS pattern (git pathspec glob), or null without git. */
export function trackedFiles(pattern) {
  const result = spawnSync('git', ['ls-files', '-z', '--', `:(glob)${pattern}`], { cwd: repoRoot, encoding: 'utf8' });
  if (result.error || result.status !== 0) return null;
  return result.stdout.split('\0').filter(Boolean).sort();
}

/**
 * §5.3 gaps: {entry: ['header' | 'gitattributes' | 'missing' | 'ambiguous']}.
 * header: the generated source does not start with a `Generated by <existing tool>` header.
 * gitattributes: the file (or, for an output glob, any tracked match) lacks `linguist-generated=true`.
 * @returns {{ gaps: Record<string, string[]>, gitAvailable: boolean }}
 */
export function generatedGaps() {
  const gaps = {};
  const add = (entry, gap) => { (gaps[entry] ??= []).push(gap); };
  const checked = [];   // {entry, files} whose files must all be linguist-generated
  for (const { entry, files } of generatedSourceFiles()) {
    if (files.length !== 1) { add(entry, files.length ? 'ambiguous' : 'missing'); continue; }
    const marker = generatedHeader(readSource(files[0]));
    if (!marker.generated || !marker.toolExists) add(entry, 'header');
    checked.push({ entry, files });
  }
  let values = null;
  const outputs = GENERATED_OUTPUTS.map(entry => ({ entry, files: entry.includes('*') ? trackedFiles(entry) : [entry] }));
  if (outputs.every(o => o.files !== null)) {
    for (const o of outputs) {
      if (o.files.length) checked.push(o);
      else add(o.entry, 'missing');
    }
    values = linguistGenerated(checked.flatMap(c => c.files));
  }
  if (values) {
    for (const { entry, files } of checked) if (files.some(f => values.get(f) !== 'true')) add(entry, 'gitattributes');
  }
  for (const entry of Object.keys(gaps)) gaps[entry].sort();
  return { gaps, gitAvailable: values !== null };
}

// ---------------------------------------------------------------------------------------------------------
// §5.1 file size

export const MAX_LINES = 800;
export const MAX_STYLE_LINES = 1500;

/** The limit for a client/src file: none for a marked generated file, 1500 for `*-styles.ts`/`*.css`, else 800. */
export function lineLimit(file, text = readSource(file)) {
  if (generatedHeader(text).generated) return Infinity;
  return file.endsWith('-styles.ts') || file.endsWith('.css') ? MAX_STYLE_LINES : MAX_LINES;
}

/** {file: lines} for every client/src .ts/.css file over its limit. */
export function sizeOffenders(files = listSources(['.ts', '.css'])) {
  const out = {};
  for (const file of files) {
    const text = readSource(file);
    const lines = lineCount(text);
    if (lines > lineLimit(file, text)) out[file] = lines;
  }
  return out;
}

/** Drop `_comment`-style keys from a baseline or map file. */
export const withoutComments = map => Object.fromEntries(Object.entries(map).filter(([key]) => !key.startsWith('_')));

// ---------------------------------------------------------------------------------------------------------
// Feature map → CONTRIBUTING.md "Where things live" (backend.md §7.6)

/** The table rows of CONTRIBUTING.md's "Where things live" section, rendered from docs/feature-map.json. */
export function whereThingsLiveRows(map = readFeatureMap()) {
  const code = path => `\`${path}/\``;
  return map.features.map(row => {
    const name = `\`${row.name}\`${row.kind === 'area' ? ' (area)' : ''}`;
    const client = row.client.map(path => code(path.slice(srcRoot.length + 1))).join(', ');
    const backend = row.backend ? code(row.backend)
      : row.backendServedBy ? `none (served by ${code(row.backendServedBy)})` : 'none';
    const tests = [...row.tests.frontend, ...row.tests.backend].map(code).join(', ') || '–';
    return `| ${name} | ${client} | ${backend} | ${tests} |`;
  });
}
