import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import { buildClient, checkSourcePolicy, discoverEntries, repositoryRoot } from '../../scripts/client-build.mjs';

/** Isolated tiny projects exercise real TypeScript and esbuild without touching product assets. */
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'je-client-build-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (path, content) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  };
  mkdirSync(join(root, 'client/entries'), { recursive: true });
  put('client/tsconfig.json', readFileSync(join(repositoryRoot, 'client/tsconfig.json')));
  put('client/src/entry.ts', 'document.title = "typed entry";\n');
  const manifest = value => put('client/entries/core.json', JSON.stringify(value));
  manifest({ 'js/core/entry.js': 'client/src/entry.ts' });
  return { root, put, manifest, output: join(root, 'Jellyfin.Plugin.JellyfinEnhanced/js/core/entry.js') };
}

for (const [name, source] of [
  ['explicit annotation', 'const value: any = 1;'],
  ['nested generic type', 'export type Values = Array<{ value: any }>;'],
  ['type assertion', 'const value = {} as any;'],
  ['conditional type', 'export type Value<T> = T extends string ? any : never;'],
  ['nocheck', '// @ts-nocheck\nconst value: string = 1;'],
  ['nocheck followed by check', '// @ts-nocheck\n// @ts-check\nconst value = 1;'],
  ['ignore', '// @ts-ignore\nconst value: string = 1;'],
  ['expect error', '// @ts-expect-error\nconst value: string = 1;'],
  ['block ignore', '/* @ts-ignore */\nconst value: string = 1;'],
  ['multiline expect error', '/* reason\n * @ts-expect-error */\nconst value: string = 1;'],
]) {
  test(`source policy rejects ${name} with a source location`, t => {
    const f = fixture(t);
    f.put('client/src/violation.ts', source);
    assert.throws(() => checkSourcePolicy(f.root), /client\/src\/violation\.ts:\d+:\d+: (Explicit any|TypeScript suppression)/);
  });
}

test('source policy allows words, identifiers, literal strings/templates/regex and explanatory comments', async t => {
  const f = fixture(t);
  f.put('client/src/harmless.ts', String.raw`
// Never use any types or @ts-ignore to hide a problem.
/* Documentation mentions @ts-expect-error and @ts-nocheck. */
const any = 1;
const object = { any };
type Value = { any: string; label: 'any' };
const directive = "// @ts-ignore";
const template = \`// @ts-nocheck
// @ts-expect-error\`;
const expression = /\/\/ @ts-ignore/;
`.replaceAll('\\`', '`'));
  f.put('tests/negative.ts', '// @ts-nocheck\nconst value: any = 1;');
  assert.doesNotThrow(() => checkSourcePolicy(f.root));
  await buildClient({ root: f.root, typecheckOnly: true });
});

for (const mode of [{}, { check: true }, { typecheckOnly: true }]) {
  test(`source policy runs before build/check/typecheck: ${JSON.stringify(mode)}`, async t => {
    const f = fixture(t);
    f.put('client/src/entry.ts', '// @ts-nocheck\nconst value: any = 1;');
    f.put('Jellyfin.Plugin.JellyfinEnhanced/js/core/entry.js', '// preserve runnable legacy');
    await assert.rejects(buildClient({ root: f.root, ...mode }), /Client source policy failed/);
    assert.equal(readFileSync(f.output, 'utf8'), '// preserve runnable legacy');
  });
}

for (const [name, raw] of [
  ['invalid JSON', '{'],
  ['array', '[]'],
  ['null', 'null'],
  ['string', '"x"'],
  ['empty object', '{}'],
  ['non-string source', '{"js/core/entry.js": 3}'],
  ['duplicate JSON key', '{"js/core/entry.js":"client/src/entry.ts","js/core/entry.js":"client/src/entry.ts"}'],
  ['escaped duplicate key', '{"js/core/entry.js":"client/src/entry.ts","js/core/\\u0065ntry.js":"client/src/entry.ts"}'],
]) {
  test(`rejects ${name} manifests`, t => {
    const f = fixture(t);
    f.put('client/entries/core.json', raw);
    assert.throws(() => discoverEntries(f.root), /manifest|Duplicate|relative/);
  });
}

for (const output of ['../escape.js', '/tmp/escape.js', 'js/../escape.js', 'js//escape.js', 'js\\escape.js', 'C:/escape.js', 'js/escape.css']) {
  test(`rejects output escape or alias: ${output}`, t => {
    const f = fixture(t);
    f.manifest({ [output]: 'client/src/entry.ts' });
    assert.throws(() => discoverEntries(f.root), /relative/);
  });
}

for (const source of ['../escape.ts', '/tmp/escape.ts', 'client/src/../escape.ts', 'elsewhere/entry.ts', 'client/src/types.d.ts', 'client/src/missing.ts']) {
  test(`rejects invalid source: ${source}`, t => {
    const f = fixture(t);
    f.manifest({ 'js/core/entry.js': source });
    assert.throws(() => discoverEntries(f.root), /relative|executable|missing/);
  });
}

for (const alias of ['js/core/entry.js', 'js/core/ENTRY.js', 'js/core.entry.js']) {
  test(`rejects cross-manifest resource collision: ${alias}`, t => {
    const f = fixture(t);
    f.put('client/entries/other.json', JSON.stringify({ [alias]: 'client/src/entry.ts' }));
    assert.throws(() => discoverEntries(f.root), /Duplicate output\/resource/);
  });
}

test('rejects symlinked output ancestors, output leaves and source leaves', t => {
  const f = fixture(t);
  const outside = mkdtempSync(join(tmpdir(), 'je-outside-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  symlinkSync(outside, join(f.root, 'Jellyfin.Plugin.JellyfinEnhanced'), 'dir');
  assert.throws(() => discoverEntries(f.root), /Symlink/);
  rmSync(join(f.root, 'Jellyfin.Plugin.JellyfinEnhanced'));
  mkdirSync(dirname(f.output), { recursive: true });
  symlinkSync(join(outside, 'absent.js'), f.output);
  assert.throws(() => discoverEntries(f.root), /Symlink/);
  rmSync(f.output);
  rmSync(join(f.root, 'client/src/entry.ts'));
  symlinkSync(join(outside, 'source.ts'), join(f.root, 'client/src/entry.ts'));
  assert.throws(() => discoverEntries(f.root), /Symlink/);
});

test('builds runnable classic scripts and portable maps; stale checks never mutate files', async t => {
  const f = fixture(t);
  f.put('client/src/value.ts', 'export const title: string = "bundled value";\n');
  f.put('client/src/entry.ts', 'import { title } from "./value";\ndocument.title = title;\n');
  f.put('Jellyfin.Plugin.JellyfinEnhanced/js/legacy.js', '// existing runnable legacy\n');
  await buildClient({ root: f.root });
  const original = readFileSync(f.output, 'utf8');
  const sandbox = { document: { title: '' } };
  runInNewContext(`${original}\ndocument.strictLeaked = (function () { return this === undefined; })();`, sandbox);
  assert.equal(sandbox.document.title, 'bundled value');
  assert.equal(sandbox.document.strictLeaked, false, 'module strictness must not leak into adjacent legacy code');
  const map = JSON.parse(readFileSync(`${f.output}.map`, 'utf8'));
  assert.ok(map.sources.every(source => !source.startsWith('/') && !source.includes(f.root)));
  assert.ok(map.sourcesContent.some(source => source.includes('bundled value')));
  assert.equal((await buildClient({ root: f.root, check: true })).changed, 0);
  f.put('client/src/value.ts', 'export const title: string = "new value";\n');
  await assert.rejects(buildClient({ root: f.root, check: true }), /Stale or missing/);
  assert.equal(readFileSync(f.output, 'utf8'), original);
  await buildClient({ root: f.root });
  f.put('Jellyfin.Plugin.JellyfinEnhanced/js/core/entry.js.map', '{}');
  await assert.rejects(buildClient({ root: f.root, check: true }), /entry.js.map/);
  await buildClient({ root: f.root });
  rmSync(f.output);
  await assert.rejects(buildClient({ root: f.root, check: true }), /entry.js/);
  assert.equal(readFileSync(join(f.root, 'Jellyfin.Plugin.JellyfinEnhanced/js/legacy.js'), 'utf8'), '// existing runnable legacy\n');
});

test('output bytes reproduce in different checkout paths', async t => {
  const a = fixture(t);
  const b = fixture(t);
  await buildClient({ root: a.root });
  await buildClient({ root: b.root });
  for (const path of ['Jellyfin.Plugin.JellyfinEnhanced/js/core/entry.js', 'Jellyfin.Plugin.JellyfinEnhanced/js/core/entry.js.map', 'client/generated-manifest.json']) {
    assert.deepEqual(readFileSync(join(a.root, path)), readFileSync(join(b.root, path)), path);
  }
});

test('type errors in mapped and unmapped source preserve existing output', async t => {
  const f = fixture(t);
  f.put('Jellyfin.Plugin.JellyfinEnhanced/js/core/entry.js', '// runnable legacy');
  f.put('client/src/entry.ts', 'const bad: string = 3;\n');
  await assert.rejects(buildClient({ root: f.root }), /not assignable/);
  assert.equal(readFileSync(f.output, 'utf8'), '// runnable legacy');
  f.put('client/src/entry.ts', 'document.title = "valid";\n');
  f.put('client/src/unmapped.ts', 'const item: { name?: string } = { name: undefined };\n');
  await assert.rejects(buildClient({ root: f.root }), /exactOptionalPropertyTypes/);
  assert.equal(readFileSync(f.output, 'utf8'), '// runnable legacy');
});

test('bundle failure in a later entry writes none of the earlier outputs', async t => {
  const f = fixture(t);
  f.put('Jellyfin.Plugin.JellyfinEnhanced/js/core/entry.js', '// runnable legacy');
  f.put('client/src/await.ts', 'await Promise.resolve();\nexport {};\n');
  f.put('client/entries/later.json', JSON.stringify({ 'js/z.js': 'client/src/await.ts' }));
  // Valid ES module TypeScript, but top-level await cannot be bundled as a classic IIFE.
  await assert.rejects(buildClient({ root: f.root }), /Top-level await/);
  assert.equal(readFileSync(f.output, 'utf8'), '// runnable legacy');
});

test('a .css import bundles as its exact text; .js and out-of-tree inputs are still rejected (frontend.md §3 D1)', async t => {
  const f = fixture(t);
  // Backslashes, `${`, quotes, a backtick and non-ASCII must survive: the loader emits the file bytes as one string.
  const css = '\n  .je-x::before { content: "\\e5cd"; }\n  .je-y { --v: `${a}`; font-family: \'Ünï\'; }\n';
  f.put('client/src/types/css.d.ts', readFileSync(join(repositoryRoot, 'client/src/types/css.d.ts')));
  f.put('client/src/styles.css', css);
  f.put('client/src/entry.ts', 'import css from "./styles.css";\n(globalThis as unknown as { css: string }).css = css;\n');
  await buildClient({ root: f.root });
  await buildClient({ root: f.root, check: true });
  const sandbox = {};
  runInNewContext(readFileSync(f.output, 'utf8'), sandbox);
  assert.equal(sandbox.css, css);
  const ledger = JSON.parse(readFileSync(join(f.root, 'client/generated-manifest.json'), 'utf8'));
  assert.deepEqual(ledger.entries.map(entry => entry.source), ['client/src/entry.ts']);

  const javascript = fixture(t);
  javascript.put('client/src/legacy.d.ts', 'export declare const value: string;\n');
  javascript.put('client/src/legacy.js', 'export const value = "untyped";\n');
  javascript.put('client/src/entry.ts', 'import { value } from "./legacy";\ndocument.title = value;\n');
  await assert.rejects(buildClient({ root: javascript.root }), /checked TypeScript under client\/src/);

  const outside = fixture(t);
  outside.put('client/src/types/css.d.ts', readFileSync(join(repositoryRoot, 'client/src/types/css.d.ts')));
  outside.put('client/outside.css', '.je-x {}\n');
  outside.put('client/src/entry.ts', 'import css from "../outside.css";\ndocument.title = css;\n');
  await assert.rejects(buildClient({ root: outside.root }), /checked TypeScript under client\/src/);
});

test('a removed mapping fails until retired artifacts are explicitly removed', async t => {
  const f = fixture(t);
  await buildClient({ root: f.root });
  rmSync(join(f.root, 'client/entries/core.json'));
  await assert.rejects(buildClient({ root: f.root, check: true }), /Orphan generated/);
  await assert.rejects(buildClient({ root: f.root }), /Orphan generated/);
  rmSync(f.output);
  rmSync(`${f.output}.map`);
  await buildClient({ root: f.root });
  assert.equal((await buildClient({ root: f.root, check: true })).entries, 0);
});

test('the initial source-less migration needs no fake entry', async t => {
  const f = fixture(t);
  rmSync(join(f.root, 'client/entries/core.json'));
  rmSync(join(f.root, 'client/src'), { recursive: true });
  const result = await buildClient({ root: f.root });
  assert.equal(result.entries, 0);
  assert.equal(result.sources, 0);
  await buildClient({ root: f.root, check: true });
});

test('direct MSBuild blocks stale plugin resources and excludes unrelated projects', async t => {
  const { spawnSync } = await import('node:child_process');
  const f = fixture(t);
  f.put('scripts/client-build.mjs', readFileSync(join(repositoryRoot, 'scripts/client-build.mjs')));
  f.put('scripts/typecheck-tool.mjs', readFileSync(join(repositoryRoot, 'scripts/typecheck-tool.mjs')));
  f.put('scripts/tag-data.mjs', readFileSync(join(repositoryRoot, 'scripts/tag-data.mjs')));
  f.put('Directory.Build.targets', readFileSync(join(repositoryRoot, 'Directory.Build.targets')));
  symlinkSync(join(repositoryRoot, 'node_modules'), join(f.root, 'node_modules'), 'dir');
  const project = '<Project><Import Project="../Directory.Build.targets"/><Target Name="PrepareForBuild"/></Project>';
  f.put('Jellyfin.Plugin.JellyfinEnhanced/JellyfinEnhanced.csproj', project);
  f.put('unrelated/Other.csproj', project);
  const invoke = path => spawnSync('dotnet', ['msbuild', path, '-t:PrepareForBuild', '-nologo', '-v:minimal'], {
    cwd: f.root, encoding: 'utf8', env: { ...process.env, DOTNET_PROCESSOR_COUNT: '2' },
  });
  const unrelated = invoke('unrelated/Other.csproj');
  assert.equal(unrelated.status, 0, unrelated.stdout + unrelated.stderr);
  const stale = invoke('Jellyfin.Plugin.JellyfinEnhanced/JellyfinEnhanced.csproj');
  assert.notEqual(stale.status, 0);
  assert.match(stale.stdout + stale.stderr, /Stale or missing generated|Frontend verification failed/);
  await buildClient({ root: f.root });
  const current = invoke('Jellyfin.Plugin.JellyfinEnhanced/JellyfinEnhanced.csproj');
  assert.equal(current.status, 0, current.stdout + current.stderr);
  rmSync(join(f.root, 'node_modules'));
  const missing = invoke('Jellyfin.Plugin.JellyfinEnhanced/JellyfinEnhanced.csproj');
  assert.notEqual(missing.status, 0);
  assert.match(missing.stdout + missing.stderr, /npm ci/);
});

for (const output of ['js/my-feature/entry.js', 'js/core/entry.en.js', 'js/core/entry.zh-Hans.js', 'js/1feature/entry.js', 'js/my.feature/entry.js']) {
  test(`rejects output that MSBuild cannot embed under the runtime lookup name: ${output}`, async t => {
    const f = fixture(t);
    f.manifest({ [output]: 'client/src/entry.ts' });
    const schema = JSON.parse(readFileSync(join(repositoryRoot, 'client/entry-manifest.schema.json'), 'utf8'));
    assert.equal(new RegExp(schema.propertyNames.pattern).test(output), false);
    for (const mode of [{}, { check: true }, { typecheckOnly: true }]) {
      await assert.rejects(buildClient({ root: f.root, ...mode }), /cannot round-trip through embedded-resource lookup/);
    }
  });
}

test('single-extension hyphenated filenames remain valid production resources', async t => {
  const f = fixture(t);
  f.manifest({ 'js/core/my-feature.js': 'client/src/entry.ts' });
  const schema = JSON.parse(readFileSync(join(repositoryRoot, 'client/entry-manifest.schema.json'), 'utf8'));
  assert.equal(new RegExp(schema.propertyNames.pattern).test('js/core/my-feature.js'), true);
  await buildClient({ root: f.root });
  await buildClient({ root: f.root, check: true });
});

test('component scripts get a runnable minified twin under min/ that --check keeps fresh (canopy K1)', async t => {
  const f = fixture(t);
  f.put('client/src/value.ts', 'export const title: string = "bundled   value";\n');
  f.put('client/src/entry.ts', 'import { title } from "./value";\n// a comment the twin drops\ndocument.title = title;\n');
  f.manifest({ 'js/core/entry.js': 'client/src/entry.ts', 'js/core/other.js': 'client/src/value.ts' });
  f.put('Jellyfin.Plugin.JellyfinEnhanced/js/component-scripts.json', JSON.stringify(['// a note', 'core/entry.js']));
  await buildClient({ root: f.root });
  const twin = join(f.root, 'Jellyfin.Plugin.JellyfinEnhanced/min/js/core/entry.js');
  const code = readFileSync(twin, 'utf8');
  assert.ok(code.length < readFileSync(f.output, 'utf8').length);
  assert.doesNotMatch(code, /a comment the twin drops|sourceMappingURL/);
  const sandbox = { document: { title: '' } };
  runInNewContext(code, sandbox);
  assert.equal(sandbox.document.title, 'bundled   value', 'string contents are kept');
  const map = JSON.parse(readFileSync(`${twin}.map`, 'utf8'));
  assert.equal(map.sourcesContent, undefined);
  assert.deepEqual(map.sources, JSON.parse(readFileSync(`${f.output}.map`, 'utf8')).sources);
  assert.equal(existsSync(join(f.root, 'Jellyfin.Plugin.JellyfinEnhanced/min/js/core/other.js')), false, 'not a component script');
  const ledger = JSON.parse(readFileSync(join(f.root, 'client/generated-manifest.json'), 'utf8'));
  assert.ok(ledger.outputs['Jellyfin.Plugin.JellyfinEnhanced/min/js/core/entry.js']);
  f.put('Jellyfin.Plugin.JellyfinEnhanced/min/js/core/entry.js', 'stale');
  await assert.rejects(buildClient({ root: f.root, check: true }), /min\/js\/core\/entry\.js/);
});
