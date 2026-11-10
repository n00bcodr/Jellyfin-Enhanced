// canopy K1b: modules that many component scripts used to inline ship once, from the first script that uses them.
//
// client/shared-modules.json maps a module (client/src/**.ts) to its *provider*: a js/component-scripts.json output.
// When the component scripts are built (scripts/client-build.mjs, readable outputs and min/ twins alike):
// - the provider gets an injected module, evaluated before its own code, that publishes the module's namespace on
//   JE.core.sharedModules (client/src/host/context.ts publishSharedModules);
// - every other component script that imports the module gets a stub instead, which reads that namespace when the
//   script loads (sharedModule) and re-exports it, so the script no longer inlines the module.
// Sources are unchanged. Sharing is only sound for modules that hold no state: two inlined copies of a stateful module
// are two separate states, and one shared copy would merge them. checkStateless enforces that over the module's whole
// runtime import closure; a binding the syntactic check cannot clear needs a reviewed entry with its reason.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const sharedManifestPath = 'client/shared-modules.json';
// Generated modules get file paths under a folder that never exists on disk, so source maps name them like any other
// repository-relative source (bundle.js.map rebases every source against the repository).
export const virtualRoot = 'client/generated-shared';
const publishPath = 'je-shared-publish';
const contextSource = 'client/src/host/context.ts';

/** A module's id on JE.core.sharedModules: its path under client/src without `.ts`. */
export const sharedModuleId = source => source.slice('client/src/'.length, -'.ts'.length);

/**
 * The manifest, validated against the ordered component scripts (`js/<path>` outputs): every provider is a component
 * script. Returns [] when there is no manifest.
 */
export function readSharedModules(root, componentScripts, safePath) {
  const file = safePath(root, sharedManifestPath);
  if (!existsSync(file)) return { modules: [], reviewed: {} };
  if (existsSync(join(root, virtualRoot))) throw new Error(`${virtualRoot} must not exist: the build generates its modules in memory`);
  const manifest = JSON.parse(readFileSync(file, 'utf8'));
  const order = [...componentScripts];
  const modules = Object.entries(manifest.modules ?? {}).map(([source, provider]) => {
    if (!/^client\/src\/[A-Za-z0-9_/.-]+\.ts$/.test(source) || source.endsWith('.d.ts') || source.includes('..')) {
      throw new Error(`${sharedManifestPath}: not a client/src TypeScript module: ${source}`);
    }
    if (source === contextSource) throw new Error(`${sharedManifestPath}: ${contextSource} carries the lookup itself`);
    if (!existsSync(safePath(root, source))) throw new Error(`${sharedManifestPath}: missing module ${source}`);
    const index = order.indexOf(provider);
    if (index < 0) throw new Error(`${sharedManifestPath}: provider of ${source} is not in js/component-scripts.json: ${provider}`);
    return { source, id: sharedModuleId(source), provider, providerIndex: index };
  });
  const reviewed = manifest.reviewed ?? {};
  for (const [source, entry] of Object.entries(reviewed)) {
    if (!Array.isArray(entry?.bindings) || typeof entry.reason !== 'string' || entry.reason.length < 40) {
      throw new Error(`${sharedManifestPath}: reviewed ${source} needs "bindings" and a "reason" of at least 40 characters`);
    }
  }
  return { modules, reviewed };
}

/** Resolve a relative import the way the client sources write them (extensionless, or a directory index). */
function resolveRelative(resolveDir, specifier) {
  const base = resolve(resolveDir, specifier);
  return [base, `${base}.ts`, join(base, 'index.ts')].find(path => existsSync(path) && statSync(path).isFile()) ?? null;
}

/**
 * The esbuild plugin and inject list for one component-script output (`js/<path>`). `exportsOf(source)` lists the
 * module's runtime exports.
 */
export function sharedModulesBuild({ root, modules, output, exportsOf }) {
  const provided = modules.filter(module => module.provider === output);
  const stubbed = new Map(modules.filter(module => module.provider !== output).map(module => [resolve(root, module.source), module]));
  if (!provided.length && !stubbed.size) return { plugins: [], inject: [] };
  const plugin = {
    name: 'je-shared-modules',
    setup(build) {
      const publishFile = resolve(root, virtualRoot, 'publish', `${output}.ts`);
      const stubFile = module => resolve(root, virtualRoot, 'stub', module.source);
      const stubs = new Map([...stubbed.values()].map(module => [stubFile(module), module]));
      build.onResolve({ filter: new RegExp(`^${publishPath}$`) }, () => ({ path: publishFile }));
      build.onResolve({ filter: /^\./ }, args => {
        if (args.namespace !== 'file') return undefined;
        const target = resolveRelative(args.resolveDir, args.path);
        const module = target && stubbed.get(target);
        return module ? { path: stubFile(module) } : undefined;
      });
      build.onLoad({ filter: /[\\/]client[\\/]generated-shared[\\/]/ }, args => {
        if (args.path === publishFile) {
          const lines = [
            `// canopy K1b: publishes what js/${output.slice('js/'.length)} ships for later scripts (client/shared-modules.json).`,
            `import { publishSharedModules } from './${contextSource}';`,
          ];
          provided.forEach((module, i) => lines.push(`import * as shared${i} from './${module.source}';`));
          lines.push(`publishSharedModules({ ${provided.map((module, i) => `${JSON.stringify(module.id)}: shared${i}`).join(', ')} });`);
          return { contents: `${lines.join('\n')}\n`, loader: 'ts', resolveDir: root };
        }
        const module = stubs.get(args.path);
        if (!module) throw new Error(`Unknown generated shared module ${args.path}`);
        const names = exportsOf(module.source);
        const lines = [
          `// canopy K1b: ${module.source} ships once, from ${module.provider} (client/shared-modules.json).`,
          `import { sharedExport, sharedModule } from './${contextSource}';`,
          `const shared = /* @__PURE__ */ sharedModule(${JSON.stringify(module.id)});`,
          ...names.map((name, i) => `const export${i} = /* @__PURE__ */ sharedExport(shared, ${JSON.stringify(name)});`),
          `export { ${names.map((name, i) => `export${i} as ${name}`).join(', ')} };`,
        ];
        return { contents: `${lines.join('\n')}\n`, loader: 'ts', resolveDir: root };
      });
    },
  };
  return { plugins: [plugin], inject: provided.length ? [publishPath] : [] };
}

/** Is `input` (an esbuild metafile input) one of this plugin's generated modules? */
export const isSharedModuleInput = input => input.startsWith(`${virtualRoot}/`);
/** The shared module a metafile input stands for, if it is a consumer stub. */
export const stubbedSource = input => input.startsWith(`${virtualRoot}/stub/`) ? input.slice(`${virtualRoot}/stub/`.length) : null;

// ---------------------------------------------------------------------------------------------------------------------
// Statelessness

/**
 * Why a top-level initializer may hold state, or null when it cannot: literals, functions, templates and operators over
 * them, reads of other bindings, frozen values, and object/array literals of those. Object and array literals are
 * mutable in principle; tests/client-build/shared-modules.test.mjs checks that no client source mutates them.
 */
function stateIn(ts, node, sf) {
  let e = node;
  while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e) || ts.isTypeAssertionExpression(e) || ts.isNonNullExpression(e)) e = e.expression;
  if (ts.isStringLiteral(e) || ts.isNumericLiteral(e) || ts.isBigIntLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)
    || [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword].includes(e.kind)) return null;
  if (ts.isRegularExpressionLiteral(e)) return /\/[a-z]*[gy][a-z]*$/.test(e.text) ? 'a global or sticky regex (lastIndex)' : null;
  if (ts.isArrowFunction(e) || ts.isFunctionExpression(e) || ts.isIdentifier(e) || ts.isPropertyAccessExpression(e)) return null;
  if (ts.isPrefixUnaryExpression(e) || ts.isTypeOfExpression(e)) return stateIn(ts, e.operand ?? e.expression, sf);
  if (ts.isBinaryExpression(e)) return stateIn(ts, e.left, sf) ?? stateIn(ts, e.right, sf);
  if (ts.isConditionalExpression(e)) return stateIn(ts, e.condition, sf) ?? stateIn(ts, e.whenTrue, sf) ?? stateIn(ts, e.whenFalse, sf);
  if (ts.isTemplateExpression(e)) return e.templateSpans.map(span => stateIn(ts, span.expression, sf)).find(Boolean) ?? null;
  if (ts.isObjectLiteralExpression(e)) {
    for (const property of e.properties) {
      if (ts.isPropertyAssignment(property)) { const why = stateIn(ts, property.initializer, sf); if (why) return why; }
      else if (ts.isSpreadAssignment(property)) { const why = stateIn(ts, property.expression, sf); if (why) return why; }
      else if (ts.isComputedPropertyName(property.name ?? {})) return 'a computed key';
    }
    return null;
  }
  if (ts.isArrayLiteralExpression(e)) return e.elements.map(element => stateIn(ts, ts.isSpreadElement(element) ? element.expression : element, sf)).find(Boolean) ?? null;
  if (ts.isCallExpression(e) && e.expression.getText(sf) === 'Object.freeze' && e.arguments.length === 1) return stateIn(ts, e.arguments[0], sf);
  if (ts.isCallExpression(e)) return `a call to ${e.expression.getText(sf)}`;
  if (ts.isNewExpression(e)) return `new ${e.expression.getText(sf)}`;
  return `a ${ts.SyntaxKind[e.kind]}`;
}

/** A reviewed binding name; `*` matches any run of identifier characters. */
const matchesBinding = (patterns, name) => patterns.some(pattern =>
  new RegExp(`^${pattern.split('*').map(part => part.replace(/[$]/g, '\\$&')).join('[A-Za-z0-9_$]*')}$`).test(name));

/**
 * Every top-level statement of `files` (repository-relative TypeScript) that may hold module state, as
 * `file: reason`. Allowed: imports, re-exports, types, function declarations, and `const` bindings without state
 * (stateIn). Everything else (let/var, classes, collections, calls, top-level statements) is reported unless
 * `reviewed[file].bindings` names the binding.
 */
export function statefulTopLevel(ts, root, files, reviewed = {}) {
  const findings = [];
  for (const file of files) {
    const sf = ts.createSourceFile(file, readFileSync(join(root, file), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const allowed = reviewed[file]?.bindings ?? [];
    const report = (name, why) => { if (!matchesBinding(allowed, name)) findings.push(`${file}: ${name}: ${why}`); };
    for (const statement of sf.statements) {
      if (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement) || ts.isInterfaceDeclaration(statement)
        || ts.isTypeAliasDeclaration(statement) || ts.isFunctionDeclaration(statement) || ts.isEmptyStatement(statement)
        || statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.DeclareKeyword)) continue;
      if (ts.isVariableStatement(statement)) {
        const constant = (statement.declarationList.flags & ts.NodeFlags.Const) !== 0;
        for (const declaration of statement.declarationList.declarations) {
          const name = declaration.name.getText(sf);
          if (!constant) report(name, 'a let/var binding');
          else if (!ts.isIdentifier(declaration.name)) report(name, 'a destructured binding');
          else if (declaration.initializer) { const why = stateIn(ts, declaration.initializer, sf); if (why) report(name, why); }
        }
        continue;
      }
      if (ts.isClassDeclaration(statement)) { report(statement.name?.text ?? 'class', 'a class (identity, static members)'); continue; }
      if (ts.isEnumDeclaration(statement)) { report(statement.name.text, 'an enum object'); continue; }
      report(`line ${sf.getLineAndCharacterOfPosition(statement.getStart(sf)).line + 1}`, `a top-level ${ts.SyntaxKind[statement.kind]}`);
    }
  }
  return findings;
}

/** A shared module's runtime exports and runtime import closure (repository-relative inputs), from esbuild. */
export async function analyseSharedModule(esbuild, root, source) {
  const result = await esbuild.build({
    absWorkingDir: root, tsconfig: 'client/tsconfig.json', entryPoints: [source], bundle: true, format: 'esm',
    platform: 'browser', target: 'es2020', write: false, metafile: true, logLevel: 'silent', outfile: 'je-shared-analysis.js',
  });
  const output = Object.values(result.metafile.outputs).find(candidate => candidate.entryPoint);
  return { exports: [...output.exports].sort(), closure: Object.keys(result.metafile.inputs).sort() };
}
