#!/usr/bin/env node
// The type checker's self-test: does the pinned tsc-rs still catch every planted type error, and report nothing on
// clean code? It needs no other compiler. Run by `scripts/restructure-gates.sh tool`; run it after every tsc-rs
// version bump (an exact pin) before landing the bump.
//
//   node scripts/typecheck-selftest.mjs [--jobs 4] [--checker /path/to/tsc-rs] [--live]
//   (--live applies the cases to the current tree, as a clone without the recorded commit would.)
//
// 1. The current client/ tree: no diagnostic at all.
// 2. Fixtures (tests/typecheck/fixtures, one per strictness option client/tsconfig.json sets, plus two that must stay
//    clean): copied into a copy of client/src, checked once; each fixture must get exactly its recorded diagnostics
//    (tests/typecheck/planted.json "fixtures": line and code, as TypeScript 6.0.3 reported them).
// 3. Cases (planted.json "cases": 121 single-site mutations of client/src, 22 kinds): each applied alone to the client/
//    tree of the commit they were recorded at (git archive, so they never go stale), checked; the diagnostics must be
//    exactly the recorded ones (file, line, code; "alsoAccept" names the code tsc-rs reports instead at the same place
//    where TypeScript 7 changed it on purpose). Without that commit in the clone (a shallow one), the cases whose source
//    text is unchanged are applied to the current tree instead, and fewer than 100 such cases fail the test.
// Any missed or extra diagnostic fails. Prints one line per failure and a summary.
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tscRs } from './typecheck-tool.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const jobs = Number(opt('--jobs', 4));
const checker = opt('--checker', null) ?? tscRs();
const planted = JSON.parse(readFileSync(join(root, 'tests/typecheck/planted.json'), 'utf8'));
const diag = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/;
const started = performance.now();

function parse(output, tree) {
  const out = [];
  for (const line of output.split('\n')) {
    const m = diag.exec(line.trim());
    if (m) out.push({ file: relative(join(tree, 'client'), resolve(join(tree, 'client'), m[1])).split('\\').join('/'), line: Number(m[2]), code: m[4], message: m[5] });
  }
  return out;
}
function check(tree) {
  return new Promise((resolveCheck, reject) => {
    const child = spawn(checker, ['-p', join(tree, 'client/tsconfig.json'), '--pretty', 'false'], { cwd: join(tree, 'client') });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    child.on('error', reject);
    child.on('close', status => {
      const diags = parse(output, tree);
      // A checker that fails without one diagnostic did not check anything.
      if (status !== 0 && !diags.length) reject(new Error(`${checker} exited ${status} without a diagnostic:\n${output.slice(0, 2000)}`));
      else resolveCheck(diags);
    });
  });
}
const key = d => `${d.file}:${d.line} ${d.code}`;
/** Expected against actual as multisets (one line can carry the same diagnostic twice). */
function compare(expected, actual, also = []) {
  const left = [...actual];
  const take = k => { const i = left.findIndex(d => key(d) === k); if (i < 0) return false; left.splice(i, 1); return true; };
  const missed = [];
  for (const e of expected) {
    if (take(key(e))) continue;
    const alt = also.find(a => a.insteadOf === e.code && a.file === e.file && a.line === e.line);
    if (alt && take(key(alt))) continue;
    missed.push(e);
  }
  return { missed, extra: left };
}
const failures = [];
const fail = text => { failures.push(text); console.log(`FAIL ${text}`); };

// 1. the current tree
const current = mkdtempSync(join(tmpdir(), 'je-tc-self-'));
cpSync(join(root, 'client'), join(current, 'client'), { recursive: true });
const clean = await check(current);
for (const d of clean) fail(`clean tree: ${key(d)} ${d.message}`);

// 2. fixtures
const fixtureDir = join(current, 'client/src/__typecheck_selftest__');
mkdirSync(fixtureDir);
for (const name of Object.keys(planted.fixtures)) cpSync(join(root, 'tests/typecheck/fixtures', name), join(fixtureDir, name));
const onDisk = readdirSync(join(root, 'tests/typecheck/fixtures')).filter(n => n.endsWith('.ts')).sort();
if (JSON.stringify(onDisk) !== JSON.stringify(Object.keys(planted.fixtures).sort())) fail(`fixtures on disk ${onDisk.join(',')} differ from planted.json`);
const fixtureDiags = await check(current);
for (const [name, expected] of Object.entries(planted.fixtures)) {
  const file = `src/__typecheck_selftest__/${name}`;
  const { missed, extra } = compare(expected.map(e => ({ file, ...e })), fixtureDiags.filter(d => d.file === file));
  for (const d of missed) fail(`fixture ${name}: missed ${d.code} at line ${d.line}`);
  for (const d of extra) fail(`fixture ${name}: extra ${key(d)} ${d.message}`);
}
for (const d of fixtureDiags.filter(d => !d.file.startsWith('src/__typecheck_selftest__/'))) fail(`fixture run: diagnostic outside the fixtures ${key(d)}`);
rmSync(current, { recursive: true, force: true });

// 3. the planted cases
const hasCommit = !args.includes('--live') && spawnSync('git', ['cat-file', '-e', `${planted.recordedAt}^{commit}`], { cwd: root }).status === 0;
const base = mkdtempSync(join(tmpdir(), 'je-tc-self-base-'));
let cases = planted.cases, mode;
if (hasCommit) {
  mode = `the recorded commit ${planted.recordedAt.slice(0, 8)}`;
  const archive = spawnSync('git', ['archive', '--format=tar', planted.recordedAt, 'client'], { cwd: root, maxBuffer: 1 << 30 });
  if (archive.status !== 0) throw new Error(`git archive failed: ${archive.stderr}`);
  const untar = spawnSync('tar', ['-x', '-C', base], { input: archive.stdout });
  if (untar.status !== 0) throw new Error(`tar failed: ${untar.stderr}`);
} else {
  mode = 'the current tree (the recorded commit is not in this clone)';
  cpSync(join(root, 'client'), join(base, 'client'), { recursive: true });
  // Relocate each case by its unchanged source line; a case whose line changed or repeats cannot be applied.
  cases = cases.flatMap(c => {
    const path = join(base, 'client', c.file);
    if (!existsSync(path)) return [];
    const text = readFileSync(path, 'utf8');
    const haystack = `\n${text}\n`, needle = `\n${c.context}\n`;
    const at = haystack.indexOf(needle);
    if (at < 0 || haystack.indexOf(needle, at + 1) >= 0) return [];
    const lineStart = at, shift = text.slice(0, lineStart).split('\n').length - c.line;
    const start = lineStart + c.startInLine;
    if (text.slice(start, start + c.original.length) !== c.original) return [];
    return [{ ...c, start, end: start + c.original.length, expect: c.expect.map(e => e.file === c.file ? { ...e, line: e.line + shift } : e),
      alsoAccept: c.alsoAccept.map(e => e.file === c.file ? { ...e, line: e.line + shift } : e) }];
  });
  if (cases.length < 100) fail(`only ${cases.length} of ${planted.cases.length} planted cases still apply to the current tree; fetch ${planted.recordedAt} (git fetch --unshallow)`);
}
const copies = Array.from({ length: jobs }, () => { const d = mkdtempSync(join(tmpdir(), 'je-tc-self-job-')); cpSync(join(base, 'client'), join(d, 'client'), { recursive: true }); return d; });
let next = 0, checked = 0;
await Promise.all(copies.map(async dir => {
  while (next < cases.length) {
    const c = cases[next++];
    const path = join(dir, 'client', c.file);
    const original = readFileSync(path, 'utf8');
    if (original.slice(c.start, c.end) !== c.original) { fail(`case ${c.id} (${c.kind}) ${c.file}:${c.line}: the recorded text is not at its offset`); continue; }
    writeFileSync(path, original.slice(0, c.start) + c.replacement + original.slice(c.end));
    const { missed, extra } = compare(c.expect, await check(dir), c.alsoAccept);
    writeFileSync(path, original);
    checked++;
    for (const d of missed) fail(`case ${c.id} (${c.kind}) ${c.file}:${c.line}: missed ${key(d)}`);
    for (const d of extra) fail(`case ${c.id} (${c.kind}) ${c.file}:${c.line}: extra ${key(d)} ${d.message}`);
  }
}));
for (const d of [base, ...copies]) rmSync(d, { recursive: true, force: true });

const seconds = ((performance.now() - started) / 1000).toFixed(1);
const version = spawnSync(checker, ['--version'], { encoding: 'utf8' }).stdout.trim();
console.log(`typecheck self-test (${version} at ${relative(root, checker) || checker}): clean tree ${clean.length ? 'NOT clean' : 'clean'}; `
  + `${Object.keys(planted.fixtures).length} option fixtures; ${checked} of ${planted.cases.length} planted cases on ${mode}; `
  + `${failures.length} failure(s); ${seconds} s`);
process.exitCode = failures.length ? 1 : 0;
