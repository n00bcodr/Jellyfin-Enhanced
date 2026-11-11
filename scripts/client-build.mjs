import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkTagData } from './tag-data.mjs';
import { runTscRs } from './typecheck-tool.mjs';

export const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const pluginDirectory = 'Jellyfin.Plugin.JellyfinEnhanced';
const ledgerPath = 'client/generated-manifest.json';
/** Minified twins of the component scripts, read only by the served bundle (ClientScriptBundle.cs). */
export const minDirectory = 'min';
// TypeScript 6 is only a parser here (entry manifests, the source policy, typed HTML pages, shared modules); the type
// check is tsc-rs's (scripts/typecheck-tool.mjs).
const versions = { typescript: '6.0.3', esbuild: '0.28.2' };
const require = createRequire(import.meta.url);

/** Fail locally, without ever downloading tools during a build. */
function loadTools() {
  try {
    const [major, minor] = process.versions.node.split('.').map(Number);
    if (major < 22 || (major === 22 && minor < 12)) throw new Error(`Node ${process.versions.node} is too old`);
    for (const [name, version] of Object.entries(versions)) {
      const installed = require(`${name}/package.json`).version;
      if (installed !== version) throw new Error(`${name}: expected ${version}, found ${installed}`);
    }
    return { ts: require('typescript'), esbuild: require('esbuild') };
  } catch (error) {
    throw new Error(`Frontend prerequisites unavailable. Install Node >=22.12 and run npm ci at the repository root, then npm run client:build. ${error.message}`);
  }
}

/** Require canonical portable paths, rejecting aliases before checking collisions. */
function validatePath(value, suffix, label) {
  if (typeof value !== 'string' || !value.endsWith(suffix)
      || !value.split('/').every(part => /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(part))) {
    throw new Error(`${label}: expected a relative /-separated ${suffix} path without traversal: ${JSON.stringify(value)}`);
  }
}

/** Reject symlinks in existing ancestors as well as in the leaf being written. */
function safePath(root, path) {
  let current = root;
  for (const segment of path.split('/')) {
    current = join(current, segment);
    try {
      if (lstatSync(current).isSymbolicLink()) throw new Error(`Symlink paths are not allowed: ${path}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return current;
}

/** JSON.parse validates JSON syntax; the TS JSON AST preserves duplicate keys. */
function parseManifest(ts, path, raw) {
  let value;
  try { value = JSON.parse(raw); }
  catch (error) { throw new Error(`Invalid entry manifest ${path}: ${error.message}`); }
  if (!value || Array.isArray(value) || typeof value !== 'object' || !Object.keys(value).length) {
    throw new Error(`Invalid entry manifest ${path}: expected a non-empty output-to-source object`);
  }
  const ast = ts.parseJsonText(path, raw);
  const object = ast.statements[0]?.expression;
  const seen = new Set();
  for (const property of object?.properties ?? []) {
    const key = property.name.text;
    if (seen.has(key)) throw new Error(`Duplicate output ${key} in ${path}`);
    seen.add(key);
  }
  return value;
}

/** Discover typed HTML pages without generating anything; empty when the tree has none. */
export async function discoverHtmlEntries(root = repositoryRoot) {
  const { ts } = loadTools();
  return (await loadHtmlPages(realpathSync(root), ts)).pages;
}

/** Discover independent manifests deterministically; protect MSBuild's flattened names too. */
export function discoverEntries(root = repositoryRoot) {
  const { ts } = loadTools();
  const folder = safePath(root, 'client/entries');
  const entries = [];
  const owners = new Map();
  for (const file of readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    if (file.isDirectory()) throw new Error(`Entry manifests must be directly under client/entries: ${file.name}`);
    if (!file.name.endsWith('.json')) continue;
    const path = `client/entries/${file.name}`;
    const manifest = parseManifest(ts, path, readFileSync(safePath(root, path), 'utf8'));
    for (const output of Object.keys(manifest).sort()) {
      const source = manifest[output];
      validatePath(output, '.js', path);
      validatePath(source, '.ts', path);
      if (!source.startsWith('client/src/') || source.endsWith('.d.ts')) {
        throw new Error(`${path}: entry must be an executable .ts source under client/src: ${source}`);
      }
      const resourceName = output.split('/').map((part, i, parts) => i < parts.length - 1 ? part.replaceAll('-', '_') : part).join('.').toLowerCase();
      if (owners.has(resourceName)) throw new Error(`Duplicate output/resource ${output}: ${path} conflicts with ${owners.get(resourceName)}`);
      // Runtime resource lookup preserves path spelling, while SDK resource naming
      // rewrites non-identifier directories and moves culture-suffixed files into
      // satellites. Admit only names that round-trip through that embedding rule.
      const parts = output.split('/');
      if (parts.slice(0, -1).some(part => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(part))
          || !/^[A-Za-z0-9_][A-Za-z0-9_-]*\.js$/.test(parts.at(-1))) {
        throw new Error(`${path}: output cannot round-trip through embedded-resource lookup: ${output}. Use identifier directory names and a single .js extension.`);
      }
      owners.set(resourceName, path);
      const input = safePath(root, source);
      if (!existsSync(input) || !lstatSync(input).isFile()) throw new Error(`${path}: missing TypeScript entry ${source}`);
      safePath(root, `${pluginDirectory}/${output}`);
      safePath(root, `${pluginDirectory}/${output}.map`);
      entries.push({ output, source, manifest: path });
    }
  }
  return entries.sort((a, b) => a.output < b.output ? -1 : a.output > b.output ? 1 : 0);
}

/**
 * Type-check all source, including modules not yet mapped to a production entry, with the repository's type checker:
 * tsc-rs (scripts/typecheck-tool.mjs; nothing here runs tsc). Its --showConfig gives the files client/tsconfig.json
 * includes, so every entry can be required to be among them.
 */
function checkTypes(root, entries) {
  const configPath = safePath(root, 'client/tsconfig.json');
  const shown = runTscRs(['--showConfig', '-p', configPath], root);
  // TS18003 (no inputs) is only allowed during the initial, genuinely source-less migration.
  if (shown.status !== 0 && /error TS18003/.test(shown.output) && entries.length === 0) return 0;
  if (shown.status !== 0) throw new Error(`client/tsconfig.json: ${shown.output.trim()}`);
  const files = new Set((JSON.parse(shown.stdout).files ?? []).map(file => resolve(dirname(configPath), file)));
  for (const entry of entries) {
    if (!files.has(resolve(root, entry.source))) throw new Error(`Entry is excluded from type checking: ${entry.source}`);
  }
  if (!files.size) return 0;
  const result = runTscRs(['-p', configPath, '--pretty', 'false'], root);
  if (result.status !== 0) {
    const output = result.output.trim();
    // A run that fails without one diagnostic did not check anything; never read it as a pass.
    if (!/error TS\d+/.test(output)) throw new Error(`tsc-rs exited ${result.status} without a diagnostic:\n${output}`);
    throw new Error(output);
  }
  return files.size;
}


/** Enforce the narrow migration policy using TypeScript's own syntax/comment parser. */
export function checkSourcePolicy(root = repositoryRoot) {
  const { ts } = loadTools();
  const failures = [];
  for (const path of ts.sys.readDirectory(join(root, 'client/src'), ['.ts'], undefined, ['**/*']).sort()) {
    const name = relative(root, path).split(sep).join('/');
    const source = ts.createSourceFile(name, readFileSync(safePath(root, name), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const fail = (position, message) => {
      const { line, character } = source.getLineAndCharacterOfPosition(position);
      failures.push(`${name}:${line + 1}:${character + 1}: ${message}`);
    };
    const visit = node => {
      if (node.kind === ts.SyntaxKind.AnyKeyword) fail(node.getStart(source), 'Explicit any types are prohibited; model the value or narrow unknown.');
      ts.forEachChild(node, visit);
    };
    visit(source);
    // The pinned TS parser records real directives, excluding strings, template
    // text, regex literals and comments that merely discuss a directive.
    for (const directive of source.commentDirectives ?? []) {
      fail(directive.range.pos, 'TypeScript suppression directives (@ts-ignore / @ts-expect-error) are prohibited.');
    }
    const noCheck = source.pragmas.get('ts-nocheck');
    for (const pragma of noCheck ? (Array.isArray(noCheck) ? noCheck : [noCheck]) : []) {
      fail(pragma.range.pos, 'TypeScript suppression directive @ts-nocheck is prohibited.');
    }
  }
  if (failures.length) throw new Error(`Client source policy failed:\n${failures.join('\n')}`);
}

/** The `js/<path>` outputs js/component-scripts.json lists, in load order (its `//` entries are notes); empty when there is none. */
function readComponentScripts(root) {
  const path = `${pluginDirectory}/js/component-scripts.json`;
  const file = safePath(root, path);
  if (!existsSync(file)) return [];
  const list = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(list) || list.some(item => typeof item !== 'string')) throw new Error(`${path}: expected an array of strings`);
  return list.map(item => item.trim()).filter(item => item && !item.startsWith('//')).map(item => `js/${item}`);
}

/** Loads HTML support only for trees with HTML sources; JS-only builds never need it. */
async function loadHtmlPages(root, ts) {
  const present = ['client/html', 'client/html-entries'].some(path => lstatSync(join(root, path), { throwIfNoEntry: false }));
  if (!present) return { support: null, pages: [] };
  const support = await import('./client/html-entries.mjs');
  return { support, pages: support.discoverHtmlPages({ root, ts, safePath, validatePath, pluginDirectory }) };
}

/** Every browser artifact shares one wrapper and one strict input policy (`generated`: inputs a build plugin made). */
async function bundle(esbuild, root, options, generated = () => false) {
  const result = await esbuild.build({
    absWorkingDir: root,
    tsconfig: 'client/tsconfig.json',
    bundle: true,
    format: 'iife',
    // TypeScript strict mode emits a directive before esbuild's IIFE. Scope it
    // inside one outer IIFE so concatenated legacy scripts retain their semantics.
    // esbuild accounts for banner lines when producing the linked source map.
    banner: { js: '(() => {' },
    footer: { js: '})();' },
    platform: 'browser',
    target: 'es2020',
    sourcesContent: true,
    legalComments: 'inline',
    write: false,
    logLevel: 'silent',
    metafile: true,
    // frontend.md §3 D1: a `.css` import is its file's text, emitted as a string literal (static stylesheets only).
    loader: { '.css': 'text' },
    ...options,
  });
  // JS dependencies would evade strict checking; browser dependencies must be TS, or CSS text imports.
  for (const input of Object.keys(result.metafile.inputs)) {
    if (generated(input)) continue;
    const typed = input.endsWith('.ts') && !input.endsWith('.d.ts');
    if (!input.startsWith('client/src/') || !(typed || input.endsWith('.css'))) {
      throw new Error(`Bundle input must be checked TypeScript under client/src (or a .css text import): ${input}`);
    }
    safePath(root, input);
  }
  return result;
}

/**
 * canopy K1b: client/shared-modules.json. Checks each shared module's runtime import closure for state (statefulTopLevel)
 * before anything is built, gives each component-script build its plugin and inject (shared.options), records which
 * modules each readable output stubs (shared.record), and finally (shared.verify) requires every stub to load after its
 * provider in js/component-scripts.json and every listed module to have at least one consumer.
 */
async function prepareSharedModules(ts, esbuild, root, entries, componentScripts) {
  // Loaded only for trees with a manifest, as HTML support is (JS-only fixtures copy client-build.mjs alone). Like the
  // min/ twins, it applies to component scripts only: a tree without js/component-scripts.json has none.
  if (!componentScripts.length || !existsSync(safePath(root, 'client/shared-modules.json'))) {
    return { options: () => ({}), generated: () => false, record() {}, verify() {} };
  }
  const { analyseSharedModule, isSharedModuleInput, readSharedModules, sharedManifestPath, sharedModulesBuild, statefulTopLevel, stubbedSource } =
    await import('./client/shared-modules.mjs');
  const { modules, reviewed } = readSharedModules(root, componentScripts, safePath);
  const analysis = new Map();
  for (const module of modules) {
    const entry = entries.find(candidate => candidate.output === module.provider);
    if (!entry) throw new Error(`${sharedManifestPath}: provider ${module.provider} is not a client/entries output`);
    analysis.set(module.source, await analyseSharedModule(esbuild, root, module.source));
  }
  const closure = [...new Set([...analysis.values()].flatMap(item => item.closure))].sort();
  const stale = Object.keys(reviewed).filter(file => !closure.includes(file));
  if (stale.length) throw new Error(`${sharedManifestPath}: reviewed entries for files no shared module imports: ${stale.join(', ')}`);
  const findings = statefulTopLevel(ts, root, closure, reviewed);
  if (findings.length) {
    throw new Error(`${sharedManifestPath}: a shared module (or a module it imports) may hold state, and one shared copy would merge `
      + `the per-script copies. Remove it from the manifest, or review the binding (reviewed.<file>.bindings + reason):\n${findings.join('\n')}`);
  }
  const stubs = new Map();
  return {
    generated: isSharedModuleInput,
    options(output) {
      if (!componentScripts.includes(output)) return {};
      const { plugins, inject } = sharedModulesBuild({ root, modules, output, exportsOf: source => analysis.get(source).exports });
      return plugins.length ? { plugins, inject } : {};
    },
    record(output, result) {
      if (componentScripts.includes(output)) stubs.set(output, Object.keys(result.metafile.inputs).map(stubbedSource).filter(Boolean));
    },
    verify() {
      const errors = [];
      for (const module of modules) {
        const consumers = [...stubs].filter(([, sources]) => sources.includes(module.source)).map(([output]) => output);
        if (!consumers.length) errors.push(`${module.source}: no component script other than ${module.provider} uses it`);
        for (const output of consumers) {
          if (componentScripts.indexOf(output) < module.providerIndex) errors.push(`${output} uses ${module.source} but loads before its provider ${module.provider}`);
        }
      }
      if (errors.length) throw new Error(`${sharedManifestPath}:\n${errors.join('\n')}`);
    },
  };
}

/** Compile in memory first: invalid source never overwrites runnable legacy assets. */
export async function buildClient({ root = repositoryRoot, check = false, typecheckOnly = false } = {}) {
  root = realpathSync(root);
  const { ts, esbuild } = loadTools();
  const entries = discoverEntries(root);
  const { support: htmlSupport, pages } = await loadHtmlPages(root, ts);
  checkTagData(root, entries);
  checkSourcePolicy(root);
  const htmlSources = pages.flatMap(page => Object.values(page.scripts).map(source => ({ source })));
  const sourceCount = checkTypes(root, [...entries, ...htmlSources]);
  if (typecheckOnly) return { entries: entries.length, sources: sourceCount, html: pages.length };
  const artifacts = new Map();
  const componentScripts = readComponentScripts(root);
  const shared = await prepareSharedModules(ts, esbuild, root, entries, componentScripts);
  // Every bundle is started at once (esbuild builds them on all cores) and then taken in the order the sequential
  // loops used, so the artifacts, the ledger's key order and which failure is reported first are unchanged.
  const started = builds => { for (const build of builds) build.catch(() => {}); return builds; };
  const readable = started(entries.map(entry => bundle(esbuild, root, {
    entryPoints: [entry.source],
    outfile: `${pluginDirectory}/${entry.output}`,
    charset: 'utf8',
    sourcemap: 'linked',
    ...shared.options(entry.output),
  }, shared.generated)));
  const twinEntries = entries.filter(entry => componentScripts.includes(entry.output));
  const twins = started(twinEntries.map(entry => bundle(esbuild, root, {
    entryPoints: [entry.source],
    outfile: `${pluginDirectory}/${entry.output}`,
    charset: 'utf8',
    minify: true,
    sourcemap: 'external',
    sourcesContent: false,
    ...shared.options(entry.output),
  }, shared.generated)));
  for (const [index, entry] of entries.entries()) {
    const result = await readable[index];
    shared.record(entry.output, result);
    for (const output of result.outputFiles) {
      const path = relative(root, output.path).split(sep).join('/');
      const expected = `${pluginDirectory}/${entry.output}`;
      if (path !== expected && path !== `${expected}.map`) throw new Error(`Unexpected generated artifact: ${path}`);
      if (artifacts.has(path)) throw new Error(`Duplicate generated artifact: ${path}`);
      artifacts.set(path, output.contents);
    }
  }
  // The served bundle (/JellyfinEnhanced/bundle.js, ClientScriptBundle.cs) concatenates the component scripts. Each
  // gets a minified twin under min/ that only the bundle reads; js/** stays readable for tests, the per-file
  // loader and debugging (canopy K1). Same source, same wrapper, plus `minify`; built at the readable output's own
  // path so the external map's `sources` match the readable map's (the server copies sourcesContent from that map).
  for (const [index, entry] of twinEntries.entries()) {
    const result = await twins[index];
    for (const output of result.outputFiles) {
      const path = relative(root, output.path).split(sep).join('/');
      const readable = `${pluginDirectory}/${entry.output}`;
      if (path !== readable && path !== `${readable}.map`) throw new Error(`Unexpected generated artifact: ${path}`);
      const twin = `${pluginDirectory}/${minDirectory}/${path.slice(pluginDirectory.length + 1)}`;
      safePath(root, twin);
      if (artifacts.has(twin)) throw new Error(`Duplicate generated artifact: ${twin}`);
      artifacts.set(twin, output.contents);
    }
  }
  shared.verify();
  const htmlLedger = [];
  for (const page of pages) {
    const scripts = [];
    for (const marker of page.markers) {
      const source = page.scripts[marker.name];
      const result = await bundle(esbuild, root, {
        entryPoints: [source],
        // Not written. At the root, esbuild's map sources are repository-relative.
        outfile: 'je-inline-html.js',
        // ServerContentPage rewrites every ${ in the fetched page, and ASCII makes the
        // script independent of how the page's bytes are decoded.
        supported: { 'template-literal': false },
        charset: 'ascii',
        sourcemap: 'external',
      });
      const code = result.outputFiles.find(output => output.path.endsWith('.js'));
      const map = result.outputFiles.find(output => output.path.endsWith('.js.map'));
      const inputs = Object.keys(result.metafile.inputs).sort();
      scripts.push({
        name: marker.name,
        source,
        text: htmlSupport.inlineScript({ ts, code: code.text, map: map.text, file: `${page.output}#${marker.name}` }),
        inputs: Object.fromEntries(inputs.map(input => [input, htmlSupport.htmlHash(readFileSync(safePath(root, input)))])),
      });
    }
    const { bytes, ledger } = htmlSupport.renderPage(page, scripts);
    const path = `${pluginDirectory}/${page.output}`;
    if (artifacts.has(path)) throw new Error(`Duplicate generated artifact: ${path}`);
    artifacts.set(path, bytes);
    htmlLedger.push(ledger);
  }
  const ledger = {
    version: 1,
    tools: versions,
    entries,
    ...(htmlLedger.length ? { html: htmlLedger } : {}),
    outputs: Object.fromEntries([...artifacts].map(([path, bytes]) => [path, createHash('sha256').update(bytes).digest('hex')])),
  };
  const ledgerFile = safePath(root, ledgerPath);
  if (existsSync(ledgerFile)) {
    const previous = JSON.parse(readFileSync(ledgerFile, 'utf8'));
    const orphans = Object.keys(previous.outputs ?? {}).filter(path => !artifacts.has(path));
    // Never delete an old resource automatically: another feature may still depend on it.
    if (orphans.some(path => existsSync(resolve(root, path)))) {
      throw new Error(`Orphan generated outputs after removing an entry. Restore its mapping or explicitly remove the retired files before building:\n${orphans.join('\n')}`);
    }
  }
  artifacts.set(ledgerPath, Buffer.from(`${JSON.stringify(ledger, null, 2)}\n`));
  const stale = [...artifacts].filter(([path, bytes]) => {
    const absolute = safePath(root, path);
    return !existsSync(absolute) || !readFileSync(absolute).equals(Buffer.from(bytes));
  });
  if (check && stale.length) {
    throw new Error(`Stale or missing generated client artifacts. Run npm run client:build and commit the outputs:\n${stale.map(([path]) => path).join('\n')}`);
  }
  if (!check) {
    for (const [path, bytes] of stale) {
      const absolute = safePath(root, path);
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, bytes);
    }
  }
  return { entries: entries.length, sources: sourceCount, html: pages.length, changed: stale.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length > 1 || args.some(arg => !['--check', '--typecheck'].includes(arg))) throw new Error('Usage: node scripts/client-build.mjs [--check | --typecheck]');
    const result = await buildClient({ check: args.includes('--check'), typecheckOnly: args.includes('--typecheck') });
    console.log(`Client: ${result.sources} TypeScript sources checked; ${result.entries} mapped browser entries${result.entries ? '' : ' (temporary migration state; legacy JavaScript remains active)'}${result.html ? `; ${result.html} typed HTML pages` : ''}.`);
  } catch (error) {
    console.error(`Client build failed: ${error.message}`);
    process.exitCode = 1;
  }
}
