// Shared scanner for the bug-class guard tests (tests/frontend/guards/*.test.mjs).
// Adapted from Jellyfin Canopy's src/test/*-guard.test.ts (GPL-3.0). Not a test file (no `.test.mjs`).
//
// Every structural check reads the TypeScript AST (the `typescript` devDependency, as
// tests/frontend/architecture/scan.mjs does). Regular expressions are used only to classify the *text* of a
// literal (does a string hold markup, an empty-state key, a remote URL) and the C# property list.
//
// A violation is { rule, file, key, line, text }. `key` is `<rule> <scope>[ <detail>]`, where scope is the chain
// of named functions around the node (see scopeName), so baselines carry no line numbers.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareCounts, listSources, readSource, repoRoot, sortedMap, ts, withoutComments } from '../architecture/scan.mjs';

export { compareCounts, repoRoot, sortedMap, ts, withoutComments };
export const here = fileURLToPath(new URL('./', import.meta.url));

// ---------------------------------------------------------------------------------------------------------
// Projects: the real client/src tree, or synthetic sources for the planted-violation self-tests.

/**
 * @param {Record<string, string>|null} sources repo-relative path → text; null reads every client/src .ts file.
 * @returns {{ files: ts.SourceFile[], byFile: Map<string, ts.SourceFile>, read(path: string): string|null }}
 */
export function createProject(sources = null) {
  const entries = sources
    ? Object.entries(sources)
    : listSources(['.ts']).filter(f => !f.endsWith('.d.ts')).map(f => [f, readSource(f)]);
  const byFile = new Map();
  for (const [file, text] of entries) {
    byFile.set(file, ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS));
  }
  const project = {
    files: [...byFile.values()],
    byFile,
    synthetic: Boolean(sources),
    read(path) {
      if (sources) return sources[path] ?? null;
      const abs = join(repoRoot, path);
      return existsSync(abs) ? readFileSync(abs, 'utf8') : null;
    },
  };
  project.imports = buildImportIndex(project);
  return project;
}

let realProject;
/** The client/src project, parsed once per process. */
export const clientProject = () => (realProject ??= createProject());

const fileOf = node => node.getSourceFile().fileName;

function resolveModule(project, from, specifier) {
  if (!specifier.startsWith('.')) return null;
  const base = posix.normalize(posix.join(posix.dirname(from), specifier));
  const candidates = [base, `${base}.ts`, `${base}/index.ts`, base.replace(/\.m?js$/, '.ts')];
  for (const c of candidates) {
    if (project.byFile.has(c)) return c;
    if (!project.synthetic && existsSync(join(repoRoot, c)) && statSync(join(repoRoot, c)).isFile() && project.byFile.has(c)) return c;
  }
  return null;
}

/** `${targetFile}#${exportedName}` → [{ file, local }] for every named import of it. */
function buildImportIndex(project) {
  const index = new Map();
  for (const sf of project.files) {
    for (const st of sf.statements) {
      if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
      const target = resolveModule(project, sf.fileName, st.moduleSpecifier.text);
      const named = st.importClause?.namedBindings;
      if (!target || !named || !ts.isNamedImports(named)) continue;
      for (const spec of named.elements) {
        const key = `${target}#${(spec.propertyName ?? spec.name).text}`;
        if (!index.has(key)) index.set(key, []);
        index.get(key).push({ file: sf.fileName, local: spec.name });
      }
    }
  }
  return index;
}

// ---------------------------------------------------------------------------------------------------------
// Small AST helpers

/** Strip parentheses, `as`, `satisfies`, `!`, `<T>` casts and `await` around an expression. */
export function unwrap(expression) {
  let e = expression;
  while (e && (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e)
    || ts.isTypeAssertionExpression(e) || ts.isSatisfiesExpression(e) || ts.isAwaitExpression(e))) e = e.expression;
  return e;
}

export const isFunctionLike = node => ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)
  || ts.isArrowFunction(node) || ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node)
  || ts.isSetAccessorDeclaration(node) || ts.isConstructorDeclaration(node);

/** The last name of a callee or member chain: `f` for `f()`, `a.b.f()`, `a?.['f']()`. */
export function lastName(node) {
  const e = unwrap(node);
  if (!e) return null;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  if (ts.isElementAccessExpression(e) && ts.isStringLiteralLike(e.argumentExpression)) return e.argumentExpression.text;
  if (e.kind === ts.SyntaxKind.ThisKeyword) return 'this';
  return null;
}

export const calleeName = call => lastName(call.expression);

/** The receiver of a method call (`a` in `a.f()`), else null. */
export function receiverOf(call) {
  const e = unwrap(call.expression);
  return ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e) ? unwrap(e.expression) : null;
}

/** The left-most identifier of a member chain (`a` for `a.b[c].d`), else null. */
export function rootIdentifier(node) {
  let e = unwrap(node);
  while (e && (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e) || ts.isCallExpression(e))) e = unwrap(e.expression);
  return e && ts.isIdentifier(e) ? e : null;
}

export const lineOf = node => node.getSourceFile().getLineAndCharacterOfPosition(node.getStart()).line + 1;

/** Source text of a node on one line, truncated for messages and reports. */
export function snippet(node, max = 110) {
  const text = node.getText().replace(/\s+/g, ' ');
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** A property's name in an object literal, or null for computed names. */
export function propertyName(p) {
  if (!p.name) return null;
  if (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name) || ts.isNumericLiteral(p.name)) return p.name.text;
  return null;
}

/** Does the object literal have `name: <anything>` (or shorthand / method)? Returns the property or null. */
export function findProperty(object, name) {
  if (!object || !ts.isObjectLiteralExpression(object)) return null;
  return object.properties.find(p => propertyName(p) === name) ?? null;
}

/** Visit every node below `root`; `visit` returns false to skip a subtree. Nested functions are entered unless `ownOnly`. */
export function walk(root, visit, { ownOnly = false } = {}) {
  (function go(node) {
    if (ownOnly && node !== root && isFunctionLike(node)) return;
    if (visit(node) === false) return;
    ts.forEachChild(node, go);
  })(root);
}

// ---------------------------------------------------------------------------------------------------------
// Scope names: the stable identifier a violation is keyed by.

/** The name a function-like or class is known by, or null when it is anonymous. */
export function functionName(fn) {
  if (ts.isConstructorDeclaration(fn)) return 'constructor';
  if ((ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn) || ts.isGetAccessorDeclaration(fn)
    || ts.isSetAccessorDeclaration(fn) || ts.isClassDeclaration(fn) || ts.isClassExpression(fn)
    || ts.isFunctionExpression(fn)) && fn.name && (ts.isIdentifier(fn.name) || ts.isStringLiteral(fn.name))) {
    return fn.name.text;
  }
  let parent = fn.parent;
  while (parent && (ts.isParenthesizedExpression(parent) || ts.isAsExpression(parent) || ts.isSatisfiesExpression(parent))) parent = parent.parent;
  if (!parent) return null;
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
  if ((ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent)) && propertyName(parent)) return propertyName(parent);
  if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken && parent.right === fn) {
    return lastName(parent.left);
  }
  return null;
}

/**
 * The chain of named functions (and classes) enclosing `node`, outermost first, joined with `.`; anonymous
 * callbacks are skipped. `(module)` for top-level code. Stable across edits that move lines.
 */
export function scopeName(node) {
  const names = [];
  for (let p = node.parent; p; p = p.parent) {
    if (isFunctionLike(p) || ts.isClassDeclaration(p) || ts.isClassExpression(p)) {
      const name = functionName(p);
      if (name) names.unshift(name);
    }
  }
  return names.length ? names.join('.') : '(module)';
}

/** The nearest enclosing function-like of a node, or its source file. */
export function enclosingFunction(node) {
  for (let p = node.parent; p; p = p.parent) if (isFunctionLike(p)) return p;
  return node.getSourceFile();
}

// ---------------------------------------------------------------------------------------------------------
// Lexical name resolution (syntax only, no type checker: fast, and works on synthetic sources).

const indexes = new WeakMap();

function scopeOfDeclaration(decl) {
  if (ts.isParameter(decl)) return decl.parent;
  if (ts.isVariableDeclaration(decl)) {
    const list = decl.parent;
    if (ts.isCatchClause(list)) return list;
    const blockScoped = list.flags & ts.NodeFlags.BlockScoped;
    const holder = list.parent;
    if (ts.isForStatement(holder) || ts.isForOfStatement(holder) || ts.isForInStatement(holder)) return blockScoped ? holder : enclosingFunction(holder);
    return blockScoped ? holder.parent : enclosingFunction(holder);
  }
  if (ts.isFunctionExpression(decl) || ts.isClassExpression(decl)) return decl;
  if (ts.isImportSpecifier(decl) || ts.isImportClause(decl) || ts.isNamespaceImport(decl)) return decl.getSourceFile();
  return decl.parent;   // function, class and enum declarations
}

/** Per file: name → [{ decl, nameNode, scope }] and name → every Identifier with that text. */
function fileIndex(sf) {
  let index = indexes.get(sf);
  if (index) return index;
  index = { bindings: new Map(), identifiers: new Map() };
  const add = (nameNode, decl) => {
    const name = nameNode.text;
    if (!index.bindings.has(name)) index.bindings.set(name, []);
    index.bindings.get(name).push({ decl, nameNode, scope: scopeOfDeclaration(decl) });
  };
  const addPattern = (name, decl) => {
    if (ts.isIdentifier(name)) { add(name, decl); return; }
    for (const el of name.elements) {
      if (ts.isOmittedExpression(el)) continue;
      // A destructured name keeps its own BindingElement as `decl`; its scope comes from the owner.
      if (ts.isIdentifier(el.name)) {
        const owner = bindingOwner(el);
        const name = el.name.text;
        if (!index.bindings.has(name)) index.bindings.set(name, []);
        index.bindings.get(name).push({ decl: el, nameNode: el.name, scope: scopeOfDeclaration(owner) });
      } else addPattern(el.name, decl);
    }
  };
  (function visit(node) {
    if (ts.isIdentifier(node)) {
      if (!index.identifiers.has(node.text)) index.identifiers.set(node.text, []);
      index.identifiers.get(node.text).push(node);
    }
    if (ts.isVariableDeclaration(node) || ts.isParameter(node)) addPattern(node.name, node);
    else if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isClassDeclaration(node)
      || ts.isClassExpression(node) || ts.isEnumDeclaration(node)) && node.name) add(node.name, node);
    else if (ts.isImportSpecifier(node) || ts.isNamespaceImport(node)) add(node.name, node);
    else if (ts.isImportClause(node) && node.name) add(node.name, node);
    ts.forEachChild(node, visit);
  })(sf);
  indexes.set(sf, index);
  return index;
}

/** The VariableDeclaration or Parameter a BindingElement belongs to. */
export function bindingOwner(element) {
  let p = element;
  while (p && !ts.isVariableDeclaration(p) && !ts.isParameter(p)) p = p.parent;
  return p;
}

/** The innermost binding of identifier `id` visible at its position, or null (a global or an unknown name). */
export function resolve(id) {
  const sf = id.getSourceFile();
  const candidates = fileIndex(sf).bindings.get(id.text);
  if (!candidates) return null;
  let best = null;
  for (const b of candidates) {
    if (b.nameNode === id) return b;
    if (b.scope.pos <= id.pos && id.end <= b.scope.end) {
      if (!best || (b.scope.end - b.scope.pos) < (best.scope.end - best.scope.pos)) best = b;
    }
  }
  return best;
}

/** Every Identifier in the file with `id`'s text that resolves to the same binding (the declaration excluded). */
export function references(binding) {
  const sf = binding.nameNode.getSourceFile();
  return (fileIndex(sf).identifiers.get(binding.nameNode.text) ?? [])
    .filter(id => id !== binding.nameNode && resolve(id) === binding);
}

/** Is the declaration exported from its module (an `export` modifier, or listed in an `export { }`)? */
export function isExported(binding) {
  let st = binding.decl;
  if (ts.isVariableDeclaration(st)) st = st.parent.parent;
  if (st && ts.canHaveModifiers(st) && (ts.getModifiers(st) ?? []).some(m => m.kind === ts.SyntaxKind.ExportKeyword)) return true;
  const sf = binding.nameNode.getSourceFile();
  return sf.statements.some(s => ts.isExportDeclaration(s) && !s.moduleSpecifier && s.exportClause
    && ts.isNamedExports(s.exportClause) && s.exportClause.elements.some(e => (e.propertyName ?? e.name).text === binding.nameNode.text));
}

/** The exported name of a binding (`export { a as b }` → b), or its own name. */
function exportedNames(binding) {
  const sf = binding.nameNode.getSourceFile();
  const names = new Set([binding.nameNode.text]);
  for (const s of sf.statements) {
    if (ts.isExportDeclaration(s) && !s.moduleSpecifier && s.exportClause && ts.isNamedExports(s.exportClause)) {
      for (const e of s.exportClause.elements) if ((e.propertyName ?? e.name).text === binding.nameNode.text) names.add(e.name.text);
    }
  }
  return names;
}

/** Identifiers in other files that refer to an exported binding through a named import. */
export function importedReferences(project, binding) {
  const out = [];
  const file = binding.nameNode.getSourceFile().fileName;
  for (const name of exportedNames(binding)) {
    for (const { file: importer, local } of project.imports.get(`${file}#${name}`) ?? []) {
      const sf = project.byFile.get(importer);
      const importBinding = resolve(local);
      if (sf && importBinding) out.push(...references(importBinding));
    }
  }
  return out;
}

/** For an import binding, the exported top-level declaration it names in a project file, as a binding. */
export function resolveImport(project, binding) {
  if (!ts.isImportSpecifier(binding.decl)) return null;
  const declaration = binding.decl.parent.parent.parent;
  if (!ts.isStringLiteral(declaration.moduleSpecifier)) return null;
  const target = resolveModule(project, binding.nameNode.getSourceFile().fileName, declaration.moduleSpecifier.text);
  const sf = target && project.byFile.get(target);
  if (!sf) return null;
  const name = (binding.decl.propertyName ?? binding.decl.name).text;
  let local = name;
  for (const s of sf.statements) {
    if (ts.isExportDeclaration(s) && !s.moduleSpecifier && s.exportClause && ts.isNamedExports(s.exportClause)) {
      const e = s.exportClause.elements.find(x => x.name.text === name);
      if (e) local = (e.propertyName ?? e.name).text;
    }
  }
  const found = (fileIndex(sf).bindings.get(local) ?? []).find(b => b.scope === sf);
  return found ?? null;
}

/** Assignments `name = e` / `name += e` (and `name ||= e` …) to the same binding: the right-hand sides. */
export function assignedValues(binding) {
  return references(binding).flatMap(id => {
    const p = id.parent;
    return ts.isBinaryExpression(p) && p.left === id && isAssignmentOperator(p.operatorToken.kind) ? [p.right] : [];
  });
}

export const isAssignmentOperator = kind => kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;

/** The function a binding names: a function declaration, or a `const f = () => …` / `function` expression. */
export function functionOf(binding) {
  if (!binding) return null;
  if (ts.isFunctionDeclaration(binding.decl)) return binding.decl.body ? binding.decl : null;
  if (ts.isVariableDeclaration(binding.decl) && binding.decl.initializer) {
    const init = unwrap(binding.decl.initializer);
    if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) return init;
  }
  return null;
}

/** The expressions a function returns (an expression body, or its own `return x` statements). */
export function returnedExpressions(fn) {
  if (!fn.body) return [];
  if (!ts.isBlock(fn.body)) return [fn.body];
  const out = [];
  walk(fn.body, node => { if (ts.isReturnStatement(node) && node.expression) out.push(node.expression); }, { ownOnly: true });
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// Ratchet

/** {file: {key: count}} from violations. */
export function countViolations(violations) {
  const counts = {};
  for (const v of violations) {
    counts[v.file] ??= {};
    counts[v.file][v.key] = (counts[v.file][v.key] ?? 0) + 1;
  }
  return sortedMap(counts);
}

export const baselinePath = name => join(here, `${name}-baseline.json`);
export function readBaseline(name) {
  const path = baselinePath(name);
  return existsSync(path) ? withoutComments(JSON.parse(readFileSync(path, 'utf8'))) : {};
}

/**
 * Compare a guard's current violations with its baseline: NEW keys or higher counts are regressions; lower
 * counts are improvements (lower the baseline with `node tests/frontend/guards/record.mjs`).
 */
export function ratchet(violations, baseline) {
  return compareCounts(countViolations(violations), baseline);
}

/** One-line messages for the violations behind each regressed (file, key). */
export function explain(violations, regressions) {
  const keys = new Set(regressions.map(r => r.replace(/ ×\d+ \(baseline \d+\)$/, '')));
  return violations.filter(v => keys.has(`${v.file}: ${v.key}`)).map(v => `${v.file}:${v.line} ${v.key} :: ${v.text}`);
}

export const fileOfNode = fileOf;
