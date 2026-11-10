#!/usr/bin/env node
// Structural migration inventory. This never substitutes for behavioral parity evidence.
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const plugin = 'Jellyfin.Plugin.JellyfinEnhanced';
const output = join(root, 'docs/rewrite/migration-inventory.json');
const args = new Set(process.argv.slice(2));
for (const arg of args) {
  if (!['--check', '--require-complete'].includes(arg)) throw new Error('Unknown argument: ' + arg);
}
const baseline = JSON.parse(readFileSync(join(root, 'rewrite-baseline.json'), 'utf8')).commit;
const baselinePaths = execFileSync('git', ['ls-tree', '-r', '--name-only', baseline, '--', plugin], {
  cwd: root, encoding: 'utf8'
}).trim().split('\n');
const baselineJs = baselinePaths.filter(path => path.endsWith('.js')).map(path => path.slice(plugin.length + 1));
const baselineManifest = JSON.parse(execFileSync('git', ['show', baseline + ':' + plugin + '/js/component-scripts.json'], {
  cwd: root, encoding: 'utf8'
})).filter(path => typeof path === 'string' && !path.startsWith('//') && path.endsWith('.js'));
const currentManifest = JSON.parse(readFileSync(join(root, plugin, 'js/component-scripts.json'), 'utf8'))
  .filter(path => typeof path === 'string' && !path.startsWith('//') && path.endsWith('.js'));
const entries = new Map();
for (const file of readdirSync(join(root, 'client/entries')).filter(file => file.endsWith('.json')).sort()) {
  const map = JSON.parse(readFileSync(join(root, 'client/entries', file), 'utf8'));
  for (const [target, source] of Object.entries(map)) {
    if (entries.has(target)) throw new Error('Duplicate client output: ' + target);
    if (typeof source !== 'string' || !source.startsWith('client/src/') || !source.endsWith('.ts') || !existsSync(join(root, source))) {
      throw new Error('Missing typed source for ' + target);
    }
    entries.set(target, { source, manifest: 'client/entries/' + file });
  }
}
// min/ (canopy K1) holds the generated minified twins of typed outputs, read only by the served bundle; they are not
// scripts of their own (scripts/client-build.mjs, tests/client-build/feature-context.test.mjs).
const minDirectory = join(root, plugin, 'min');
function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (['bin', 'obj', 'node_modules'].includes(entry.name)) return [];
    if (join(directory, entry.name) === minDirectory) return [];
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(path) : entry.isFile() ? [path] : [];
  });
}
const files = walk(join(root, plugin)).sort();
const scripts = files.filter(file => file.endsWith('.js')).map(file => {
  const path = relative(join(root, plugin), file).split('\\').join('/');
  const entry = entries.get(path);
  return {
    path,
    orderedComponent: currentManifest.includes(path.replace(/^js\//, '')),
    existedAtBaseline: baselineJs.includes(path),
    status: entry ? 'typed-output' : 'legacy-javascript',
    ...(entry ?? {})
  };
});
const currentPaths = new Set(scripts.map(script => script.path));
const missingBaselineScripts = baselineJs.filter(path => !currentPaths.has(path)).sort();
const missingMappedOutputs = [...entries.keys()].filter(path => !currentPaths.has(path)).sort();
// WHATWG JavaScript MIME essence matches; type parameters are NOT accepted.
// https://mimesniff.spec.whatwg.org/#javascript-mime-type
const legacyScriptTypes = new Set([
  'application/ecmascript', 'application/javascript', 'application/x-ecmascript', 'application/x-javascript',
  'text/ecmascript', 'text/javascript', 'text/javascript1.0', 'text/javascript1.1', 'text/javascript1.2',
  'text/javascript1.3', 'text/javascript1.4', 'text/javascript1.5', 'text/jscript', 'text/livescript',
  'text/x-ecmascript', 'text/x-javascript'
]);
const asciiTrim = value => value.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, '');
function executableScript(node) {
  const declared = node.getAttribute('type');
  const language = node.getAttribute('language');
  const type = declared === null ? (language ? 'text/' + language : 'text/javascript') : (declared || 'text/javascript');
  const lower = type.toLowerCase();
  return lower === 'module' || legacyScriptTypes.has(lower)
    || (declared !== null && legacyScriptTypes.has(asciiTrim(lower)));
}
/** Inline scripts Jellyfin would run, in document order, including those in <template>. */
function inlineScriptsIn(html) {
  // jellyfin-web's parseHtml re-activates commented-out scripts before parsing the page.
  const active = html.replaceAll('<!--<script', '<script').replaceAll('</script>-->', '</script>');
  const dom = new JSDOM(active); // No script execution or network resource loading.
  const found = [];
  let scriptIndex = 0;
  const visit = parent => {
    for (const node of parent.childNodes) {
      if (node.nodeType !== 1) continue;
      if (node.localName === 'script') {
        if (!node.hasAttribute('src') && node.textContent.trim() && executableScript(node)) {
          found.push({ scriptIndex, text: node.textContent });
        }
        scriptIndex += 1;
      }
      visit(node);
      if (node.localName === 'template' && node.content) visit(node.content);
    }
  };
  visit(dom.window.document);
  dom.window.close();
  return found;
}
const sha256 = text => createHash('sha256').update(text).digest('hex');
// The ledger is the only evidence a script is generated, and only its hash can claim one.
// A listed page whose script text differs is hand-edited or stale, and stays unmigrated.
const ledgerPath = join(root, 'client/generated-manifest.json');
const typedPages = new Map((existsSync(ledgerPath) ? JSON.parse(readFileSync(ledgerPath, 'utf8')).html ?? [] : []).map(page => [page.output, page]));
const htmlManifestDirectory = join(root, 'client/html-entries');
const mappedHtml = !existsSync(htmlManifestDirectory) ? [] : readdirSync(htmlManifestDirectory).filter(file => file.endsWith('.json')).sort()
  .flatMap(file => Object.keys(JSON.parse(readFileSync(join(htmlManifestDirectory, file), 'utf8'))));
const unresolvedTypedHtml = mappedHtml.filter(path => !typedPages.has(path)).map(path => path + ': mapped but missing from the build ledger');
const inlineScripts = [];
const typedHtmlScripts = [];
const currentHtml = new Map();
for (const file of files.filter(file => file.endsWith('.html'))) {
  const path = relative(join(root, plugin), file).split('\\').join('/');
  const found = inlineScriptsIn(readFileSync(file, 'utf8'));
  currentHtml.set(path, found.length);
  const typed = new Map((typedPages.get(path)?.scripts ?? []).map(script => [script.scriptIndex, script]));
  for (const { scriptIndex, text } of found) {
    const script = typed.get(scriptIndex);
    if (script?.sha256 === sha256(text)) {
      typed.delete(scriptIndex);
      typedHtmlScripts.push({ path, scriptIndex, status: 'typed-generated', marker: script.name, source: script.source, template: typedPages.get(path).template, manifest: typedPages.get(path).manifest, sha256: script.sha256 });
    } else {
      inlineScripts.push({ path, scriptIndex, status: 'inline-runtime-unmigrated' });
    }
  }
  for (const script of typed.values()) unresolvedTypedHtml.push(path + '#' + script.name + ': generated script is stale or was edited');
}
for (const path of typedPages.keys()) {
  if (!currentHtml.has(path)) unresolvedTypedHtml.push(path + ': generated page is missing');
}
// Inline behavior has no module list, so each baseline page must still carry some.
const baselineInlineScripts = Object.fromEntries(baselinePaths.filter(path => path.endsWith('.html')).map(path => [
  path.slice(plugin.length + 1),
  inlineScriptsIn(execFileSync('git', ['show', baseline + ':' + path], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })).length
]));
const missingBaselineHtml = Object.keys(baselineInlineScripts).filter(path => !currentHtml.has(path)).sort();
const emptiedBaselineHtml = Object.entries(baselineInlineScripts).filter(([path, count]) => count && currentHtml.get(path) === 0).map(([path]) => path).sort();
// Additive so the committed inventory stays valid until the first typed page lands.
const trackTypedHtml = typedPages.size || mappedHtml.length || missingBaselineHtml.length || emptiedBaselineHtml.length || unresolvedTypedHtml.length;
const inventory = {
  schemaVersion: 1,
  baseline,
  limitation: 'Structural inventory only. Typed output does not establish behavioral parity; removed scripts and inline behavior require review.',
  baselineCounts: {
    orderedComponents: baselineManifest.length,
    uniqueOrderedComponents: new Set(baselineManifest).size,
    javascriptFiles: baselineJs.length,
    outsideOrderedManifest: baselineJs.filter(path => !baselineManifest.includes(path.replace(/^js\//, ''))).length
  },
  currentCounts: {
    javascriptFiles: scripts.length,
    typedOutputs: scripts.filter(script => script.status === 'typed-output').length,
    legacyJavascript: scripts.filter(script => script.status === 'legacy-javascript').length,
    inlineRuntimeScripts: inlineScripts.length,
    ...(trackTypedHtml ? { typedHtmlScripts: typedHtmlScripts.length } : {})
  },
  missingBaselineScripts,
  missingMappedOutputs,
  ...(trackTypedHtml ? { baselineInlineScripts, missingBaselineHtml, emptiedBaselineHtml, unresolvedTypedHtml } : {}),
  scripts,
  inlineScripts,
  ...(trackTypedHtml ? { typedHtmlScripts } : {})
};
const serialized = JSON.stringify(inventory, null, 2) + '\n';
if (args.has('--check')) {
  if (!existsSync(output) || readFileSync(output, 'utf8') !== serialized) {
    console.error('Migration inventory is stale. Run node scripts/rewrite-inventory.mjs.');
    process.exitCode = 1;
  }
} else if (!existsSync(output) || readFileSync(output, 'utf8') !== serialized) {
  writeFileSync(output, serialized);
}
const unresolved = [...missingBaselineScripts, ...missingMappedOutputs, ...missingBaselineHtml, ...emptiedBaselineHtml, ...unresolvedTypedHtml];
if (unresolved.length) {
  console.error('Unresolved missing production scripts: ' + unresolved.join(', '));
  process.exitCode = 1;
}
if (args.has('--require-complete') && (inventory.currentCounts.legacyJavascript || inlineScripts.length)) {
  console.error('Structural migration is incomplete: legacy JavaScript or inline runtime scripts remain.');
  process.exitCode = 1;
}
console.log(JSON.stringify({ baseline: inventory.baselineCounts, current: inventory.currentCounts }));
