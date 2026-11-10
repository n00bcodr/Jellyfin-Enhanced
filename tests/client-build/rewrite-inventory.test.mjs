import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { buildClient, repositoryRoot } from '../../scripts/client-build.mjs';

const plugin = 'Jellyfin.Plugin.JellyfinEnhanced';
const page = 'PluginPages/Page.html';
const legacyPage = 'PluginPages/Legacy.html';

/** A git repository whose first commit is the pinned baseline, as the real inventory expects. */
function repository(t) {
  const root = mkdtempSync(join(tmpdir(), 'je-inventory-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (path, content) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  };
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd: root, encoding: 'utf8' });
  git('init', '--quiet');
  mkdirSync(join(root, 'scripts'));
  copyFileSync(join(repositoryRoot, 'scripts/rewrite-inventory.mjs'), join(root, 'scripts/rewrite-inventory.mjs'));
  symlinkSync(join(repositoryRoot, 'node_modules'), join(root, 'node_modules'), 'dir');
  put('.gitignore', 'node_modules\n');
  put(`${plugin}/js/component-scripts.json`, '["kept.js"]');
  put(`${plugin}/js/kept.js`, '// kept\n');
  put(`${plugin}/JellyfinEnhanced.csproj`, `<Project><ItemGroup><EmbeddedResource Include="${page.replace('/', '\\')}"/></ItemGroup></Project>`);
  put(`${plugin}/${page}`, '<div></div><script>window.first = 1;</script><script src="/x.js"></script><script type="text/javascript">window.second = 2;</script>\n');
  put(`${plugin}/${legacyPage}`, '<script>window.legacy = 1;</script>\n');
  put('rewrite-baseline.json', '{}');
  git('add', '-A');
  git('commit', '--quiet', '-m', 'baseline');
  put('rewrite-baseline.json', JSON.stringify({ commit: git('rev-parse', 'HEAD').trim() }));
  mkdirSync(join(root, 'client/entries'), { recursive: true });
  const run = (...args) => {
    const result = spawnSync(process.execPath, ['scripts/rewrite-inventory.mjs', ...args], { cwd: root, encoding: 'utf8' });
    return { status: result.status, stderr: result.stderr, stdout: result.stdout };
  };
  const inventory = () => {
    run();
    return JSON.parse(readFileSync(join(root, 'docs/rewrite/migration-inventory.json'), 'utf8'));
  };
  mkdirSync(join(root, 'docs/rewrite'), { recursive: true });
  return { root, put, run, inventory };
}

/** Converts the fixture's page to a typed page and builds it with the real builder. */
async function typePage(f) {
  f.put('client/tsconfig.json', readFileSync(join(repositoryRoot, 'client/tsconfig.json')));
  f.put('client/src/page.ts', 'document.title = "typed";\n');
  f.put('client/html/pages/page.html', '<div></div><!-- JE_TYPED_SCRIPT:main -->\n<!-- JE_TYPED_SCRIPT:after -->\n');
  f.put('client/html-entries/pages.json', JSON.stringify({ [page]: { template: 'client/html/pages/page.html', scripts: { main: 'client/src/page.ts', after: 'client/src/page.ts' } } }));
  await buildClient({ root: f.root });
}

test('with no typed HTML the document shape is unchanged, so committed inventories stay valid', t => {
  const f = repository(t);
  const inventory = f.inventory();
  assert.deepEqual(Object.keys(inventory), ['schemaVersion', 'baseline', 'limitation', 'baselineCounts', 'currentCounts', 'missingBaselineScripts', 'missingMappedOutputs', 'scripts', 'inlineScripts']);
  assert.deepEqual(Object.keys(inventory.currentCounts), ['javascriptFiles', 'typedOutputs', 'legacyJavascript', 'inlineRuntimeScripts']);
  assert.deepEqual(inventory.inlineScripts.map(script => [script.path, script.scriptIndex, script.status]), [
    [legacyPage, 0, 'inline-runtime-unmigrated'],
    [page, 0, 'inline-runtime-unmigrated'],
    [page, 2, 'inline-runtime-unmigrated'],
  ]);
  assert.equal(f.run('--check').status, 0);
  const incomplete = f.run('--require-complete');
  assert.notEqual(incomplete.status, 0);
  assert.match(incomplete.stderr, /Structural migration is incomplete/);
});

test('generated scripts count as typed only when their text matches the ledger', async t => {
  const f = repository(t);
  await typePage(f);
  const inventory = f.inventory();
  assert.equal(inventory.currentCounts.typedHtmlScripts, 2);
  assert.equal(inventory.currentCounts.inlineRuntimeScripts, 1);
  assert.deepEqual(inventory.inlineScripts.map(script => script.path), [legacyPage]);
  assert.deepEqual(inventory.typedHtmlScripts.map(script => [script.path, script.scriptIndex, script.marker, script.status, script.source, script.template]), [
    [page, 0, 'main', 'typed-generated', 'client/src/page.ts', 'client/html/pages/page.html'],
    [page, 1, 'after', 'typed-generated', 'client/src/page.ts', 'client/html/pages/page.html'],
  ]);
  assert.deepEqual(inventory.baselineInlineScripts, { [legacyPage]: 1, [page]: 2 });
  assert.deepEqual(inventory.unresolvedTypedHtml, []);
  assert.equal(f.run('--check').status, 0);
});

test('an edited, extra or stale script is unmigrated however the page is mapped', async t => {
  const f = repository(t);
  await typePage(f);
  const output = join(f.root, plugin, page);
  const generated = readFileSync(output, 'utf8');
  writeFileSync(output, generated.replace('document.title = "typed"', 'document.title = "edited"'));
  const edited = f.inventory();
  assert.equal(edited.currentCounts.typedHtmlScripts, 1);
  assert.equal(edited.currentCounts.inlineRuntimeScripts, 2);
  assert.equal(edited.unresolvedTypedHtml.length, 1);
  assert.match(edited.unresolvedTypedHtml[0], /#main: generated script is stale/);
  assert.notEqual(f.run().status, 0);

  writeFileSync(output, generated.replace('<div></div>', '<div></div><script>window.handAdded = 1;</script>'));
  const added = f.inventory();
  assert.equal(added.inlineScripts.filter(script => script.path === page).length, 3, 'an extra script shifts indexes and claims nothing');

  writeFileSync(output, generated);
  rmSync(join(f.root, 'client/generated-manifest.json'));
  const unledgered = f.inventory();
  assert.equal(unledgered.currentCounts.typedHtmlScripts, 0);
  assert.match(unledgered.unresolvedTypedHtml[0], /missing from the build ledger/);
  assert.notEqual(f.run().status, 0);
});

test('require-complete passes only when no legacy script remains, and baseline pages cannot vanish', async t => {
  const f = repository(t);
  await typePage(f);
  const legacy = join(f.root, plugin, legacyPage);
  const original = readFileSync(legacy, 'utf8');

  writeFileSync(legacy, '<p>script removed</p>\n');
  assert.deepEqual(f.inventory().emptiedBaselineHtml, [legacyPage]);
  assert.notEqual(f.run().status, 0);

  rmSync(legacy);
  assert.deepEqual(f.inventory().missingBaselineHtml, [legacyPage]);
  assert.notEqual(f.run().status, 0);

  writeFileSync(legacy, original);
  f.put('client/src/legacy.ts', 'document.title = "legacy";\n');
  f.put('client/html/pages/legacy.html', '<!-- JE_TYPED_SCRIPT:main -->\n');
  f.put('client/html-entries/legacy.json', JSON.stringify({ [legacyPage]: { template: 'client/html/pages/legacy.html', scripts: { main: 'client/src/legacy.ts' } } }));
  f.put(`${plugin}/JellyfinEnhanced.csproj`, `<Project><ItemGroup><EmbeddedResource Include="${page.replace('/', '\\')}"/><EmbeddedResource Include="${legacyPage.replace('/', '\\')}"/></ItemGroup></Project>`);
  await buildClient({ root: f.root });
  // Legacy JavaScript elsewhere is still incomplete: make the one file typed-free for this check.
  f.put(`${plugin}/js/component-scripts.json`, '[]');
  f.put('client/src/kept.ts', 'export {};\n');
  f.put('client/entries/kept.json', JSON.stringify({ 'js/kept.js': 'client/src/kept.ts' }));
  await buildClient({ root: f.root });
  assert.equal(f.inventory().currentCounts.inlineRuntimeScripts, 0);
  const complete = f.run('--require-complete');
  assert.equal(complete.status, 0, complete.stderr);
});

test('scripts hidden from a plain query still count', t => {
  const f = repository(t);
  f.put(`${plugin}/${legacyPage}`, '<template><script>window.inTemplate = 1;</script></template><!--<script>window.commented = 1;</script>-->\n<div data-role="page"></div>\n');
  const inventory = f.inventory();
  assert.deepEqual(inventory.inlineScripts.filter(script => script.path === legacyPage).map(script => script.scriptIndex), [0, 1]);
  assert.equal(f.run().status, 0);
});

test('R2 inventory counts every executable JavaScript MIME alias and legacy language', t => {
  const f = repository(t);
  const types = [
    'application/ecmascript', 'application/javascript', 'application/x-ecmascript', 'application/x-javascript',
    'text/ecmascript', 'text/javascript', 'text/javascript1.0', 'text/javascript1.1', 'text/javascript1.2',
    'text/javascript1.3', 'text/javascript1.4', 'text/javascript1.5', 'text/jscript', 'text/livescript',
    'text/x-ecmascript', 'text/x-javascript', ' TEXT/JAVASCRIPT ', 'module', 'MoDuLe', '',
  ];
  const scripts = types.map((type, i) => '<script type="' + type + '">window.alias' + i + '=1;</script>');
  scripts.push('<script language="JavaScript1.2">window.language=1;</script>', '<script>window.defaultType=1;</script>');
  f.put(plugin + '/' + legacyPage, scripts.join('\n'));
  const actual = f.inventory().inlineScripts.filter(script => script.path === legacyPage);
  assert.equal(actual.length, scripts.length);
  assert.deepEqual(actual.map(script => script.scriptIndex), scripts.map((_, i) => i));
  assert.notEqual(f.run('--require-complete').status, 0);
});
test('R2 inventory excludes data blocks and invalid MIME types without broad trim', t => {
  const f = repository(t);
  const types = ['application/json', 'importmap', 'speculationrules', 'text/javascript;charset=utf-8', 'module ', '\u00a0text/javascript\u00a0'];
  f.put(plugin + '/' + legacyPage, types.map(type => '<script type="' + type + '">{"data":1}</script>').join('\n') +
    '<script language="python">data=1</script><script type="application/json" language="javascript">{"data":2}</script>');
  const actual = f.inventory().inlineScripts.filter(script => script.path === legacyPage);
  assert.equal(actual.length, 0);
});
