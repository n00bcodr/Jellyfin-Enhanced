import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { buildClient, repositoryRoot } from '../../scripts/client-build.mjs';

// The type-check pass cache (scripts/client-build.mjs typecheckCache): a pass is reused only for the same inputs, and
// every kind of relevant change makes the check run again.
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'je-tc-cache-'));
  const cache = mkdtempSync(join(tmpdir(), 'je-tc-cache-dir-'));
  t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(cache, { recursive: true, force: true }); });
  const put = (path, content) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), content); };
  put('client/tsconfig.json', readFileSync(join(repositoryRoot, 'client/tsconfig.json')));
  put('client/entries/core.json', JSON.stringify({ 'js/core/entry.js': 'client/src/entry.ts' }));
  put('client/src/entry.ts', "import { greet } from './greet';\ndocument.title = greet('x');\n");
  put('client/src/greet.ts', 'export function greet(name: string): string { return `hi ${name}`; }\n');
  put('package-lock.json', '{"lockfileVersion": 3}\n');
  const check = async () => {
    const before = process.env.JE_TYPECHECK_CACHE_DIR;
    process.env.JE_TYPECHECK_CACHE_DIR = cache;
    try { return (await buildClient({ root, typecheckOnly: true })).typecheck; } finally {
      if (before === undefined) delete process.env.JE_TYPECHECK_CACHE_DIR; else process.env.JE_TYPECHECK_CACHE_DIR = before;
    }
  };
  return { root, cache, put, check, entries: () => readdirSync(cache).filter(f => f.endsWith('.json')) };
}

test('a pass is reused for the same inputs', async t => {
  const f = fixture(t);
  assert.equal(await f.check(), 'checked');
  assert.equal(f.entries().length, 1);
  assert.equal(await f.check(), 'cached');
});

test('an edited source file runs the check again, and its error is reported', async t => {
  const f = fixture(t);
  await f.check();
  f.put('client/src/greet.ts', 'export function greet(name: string): number { return `hi ${name}`; }\n');
  await assert.rejects(f.check(), /not assignable to type 'number'/);
  f.put('client/src/greet.ts', 'export function greet(name: string): string { return `hi ${name}`; }\n');
  assert.equal(await f.check(), 'cached', 'back to the stored inputs');
});

test('a new or a removed source file runs the check again', async t => {
  const f = fixture(t);
  await f.check();
  f.put('client/src/extra.ts', 'export const extra: number = 1;\n');
  assert.equal(await f.check(), 'checked');
  rmSync(join(f.root, 'client/src/extra.ts'));
  assert.equal(await f.check(), 'cached');
  f.put('client/src/broken.ts', 'export const broken: number = "1";\n');
  await assert.rejects(f.check(), /not assignable to type 'number'/);
});

test('a changed compiler option or lockfile runs the check again', async t => {
  const f = fixture(t);
  await f.check();
  const config = JSON.parse(readFileSync(join(f.root, 'client/tsconfig.json'), 'utf8'));
  config.compilerOptions.noUnusedLocals = true;
  f.put('client/tsconfig.json', JSON.stringify(config));
  assert.equal(await f.check(), 'checked');
  f.put('package-lock.json', '{"lockfileVersion": 3, "x": 1}\n');
  assert.equal(await f.check(), 'checked');
});

test('a changed file outside the roots that the program loaded (a lib file) runs the check again', async t => {
  const f = fixture(t);
  await f.check();
  const [name] = f.entries();
  const path = join(f.cache, name);
  const entry = JSON.parse(readFileSync(path, 'utf8'));
  assert.ok(entry.loaded.some(([file]) => /lib\.[^/]*\.d\.ts$/.test(file)), 'the lib files are recorded');
  entry.loaded[0][1] = '0'.repeat(64);    // as if that file's bytes had changed since the pass
  writeFileSync(path, JSON.stringify(entry));
  assert.equal(await f.check(), 'checked');
});

test('a failing check is never stored, and no cache directory means no cache', async t => {
  const f = fixture(t);
  f.put('client/src/greet.ts', 'export function greet(name: string): number { return name; }\n');
  await assert.rejects(f.check());
  assert.equal(f.entries().length, 0);
  await assert.rejects(f.check(), 'still checked, still failing');
  f.put('client/src/greet.ts', 'export function greet(name: string): string { return name; }\n');
  delete process.env.JE_TYPECHECK_CACHE_DIR;
  assert.equal((await buildClient({ root: f.root, typecheckOnly: true })).typecheck, 'checked');
  assert.equal(f.entries().length, 0, 'nothing written without JE_TYPECHECK_CACHE_DIR');
});

test('JE_TYPECHECK_CACHE_VERIFY=1 checks even on a hit (the audit)', async t => {
  const f = fixture(t);
  await f.check();
  process.env.JE_TYPECHECK_CACHE_VERIFY = '1';
  t.after(() => { delete process.env.JE_TYPECHECK_CACHE_VERIFY; });
  assert.equal(await f.check(), 'checked');
});
