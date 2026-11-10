#!/usr/bin/env node
// Does another TypeScript checker agree with the one the gates use (the repository's TypeScript 6 `tsc`)?
//
//   node scripts/typecheck-agreement.mjs --checker tsc6="node $PWD/node_modules/typescript/bin/tsc" \
//        --checker ts7='node /path/ts7/bin/tsc' --checker tsrs='/path/tsc-rs' [--per-kind 6] [--jobs 4] [--out FILE]
//   node scripts/typecheck-agreement.mjs --gate --sample 4 --seed <commit> --jobs 2 --checker tsc6=... --checker tsrs=...
//        the `tool` gate's cheap form: the clean tree plus 4 of all the sites, drawn by the seed (so each commit
//        tries others), and a failure only when the verdict or the file:line set differs (codes may differ: TypeScript
//        7, and so tsc-rs, reports some TS2345 as TS2741 by design).
//
// 1. Copies client/ to a scratch directory and runs every checker on the clean tree (`-p <copy>/tsconfig.json
//    --pretty false`): all must report nothing.
// 2. Finds mutation sites in the real sources with the TypeScript 6 API (this file's KINDS: a removed `override`, an
//    `import type` turned into a value import, a removed `break`, a wrong argument type, a missing or excess property,
//    `undefined` for an optional property under exactOptionalPropertyTypes, a removed non-null assertion on an
//    indexed access, ...), at most --per-kind per kind, spread over different files.
// 3. Applies each mutation alone to its file in the copy, runs every checker, and compares each checker's diagnostics
//    with the first checker's (the authority) as a set of `file:line TScode`. A mutation the authority rejects is a
//    "seeded error"; one it accepts still counts: any error another checker reports there is a false error.
// Output: a JSON record of every run and a summary table (stdout, or --out FILE.md and FILE.json).
import { execFile } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const ts = createRequire(import.meta.url)('typescript');

const args = process.argv.slice(2);
const checkers = [];
let perKind = 6, jobs = 4, out = null, sample = 0, seed = '', gate = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--checker') { const [name, ...cmd] = args[++i].split('='); checkers.push({ name, cmd: cmd.join('=').split(' ') }); }
  else if (args[i] === '--per-kind') perKind = Number(args[++i]);
  else if (args[i] === '--jobs') jobs = Number(args[++i]);
  else if (args[i] === '--out') out = args[++i];
  else if (args[i] === '--sample') sample = Number(args[++i]);
  else if (args[i] === '--seed') seed = args[++i];
  else if (args[i] === '--gate') gate = true;
  else if (args[i] === '--list') checkers.push({ list: true });
  else throw new Error(`unknown argument ${args[i]}`);
}
const listOnly = checkers.some(c => c.list);
if (!listOnly && checkers.length < 2) throw new Error('give at least two --checker name=command (the first is the authority)');

// ------------------------------------------------------------------ mutation sites (TypeScript 6 API, real sources)
const config = ts.getParsedCommandLineOfConfigFile(join(root, 'client/tsconfig.json'), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: d => { throw new Error(String(d.messageText)); } });
const program = ts.createProgram(config.fileNames, { ...config.options, noEmit: true });
const checker = program.getTypeChecker();
const sources = program.getSourceFiles().filter(f => !f.isDeclarationFile && f.fileName.startsWith(join(root, 'client/src')));
const rel = f => relative(join(root, 'client'), f.fileName);
const text = (f, node) => f.text.slice(node.getStart(f), node.end);
const typeText = t => checker.typeToString(t);

/** Each kind: (sourceFile, node) -> {start, end, replacement, note} | null. One edit per mutation. */
const KINDS = {
  'override-removed (noImplicitOverride)': (f, n) => {
    const m = ts.canHaveModifiers(n) && ts.getModifiers(n)?.find(x => x.kind === ts.SyntaxKind.OverrideKeyword);
    return m ? { start: m.getStart(f), end: m.end + 1, replacement: '', note: text(f, n).split('\n')[0].slice(0, 60) } : null;
  },
  'type-import-as-value-import (verbatimModuleSyntax)': (f, n) => {
    if (!ts.isImportDeclaration(n) || !n.importClause?.isTypeOnly || !n.importClause.namedBindings || !ts.isNamedImports(n.importClause.namedBindings)) return null;
    const names = n.importClause.namedBindings.elements;
    const allTypes = names.every(e => { const s = checker.getAliasedSymbol(checker.getSymbolAtLocation(e.name)); return s && !(s.flags & ts.SymbolFlags.Value); });
    if (!allTypes) return null;
    const kw = n.importClause.getStart(f);
    return { start: kw, end: kw + 'type '.length, replacement: '', note: text(f, n).slice(0, 70) };
  },
  'type-only-import-used-as-value': (f, n) => {
    if (!ts.isImportDeclaration(n) || !n.importClause?.isTypeOnly || !n.importClause.namedBindings || !ts.isNamedImports(n.importClause.namedBindings)) return null;
    const value = n.importClause.namedBindings.elements.find(e => { const s = checker.getAliasedSymbol(checker.getSymbolAtLocation(e.name)); return s && (s.flags & ts.SymbolFlags.Class); });
    return value ? { start: f.text.length, end: f.text.length, replacement: `\nexport const __probeValue = ${value.name.text};\n`, note: value.name.text } : null;
  },
  'break-removed (noFallthroughCasesInSwitch)': (f, n) => {
    if (!ts.isCaseClause(n) || n.statements.length < 2) return null;
    const last = n.statements.at(-1);
    const clauses = n.parent.clauses;
    if (!ts.isBreakStatement(last) || last.label || clauses.indexOf(n) === clauses.length - 1) return null;
    return { start: last.getStart(f), end: last.end, replacement: '', note: text(f, n.expression).slice(0, 50) };
  },
  'wrong-argument-type': (f, n) => {
    if (!ts.isCallExpression(n) || !n.arguments.length) return null;
    const sig = checker.getResolvedSignature(n);
    if (!sig) return null;
    for (const [i, arg] of n.arguments.entries()) {
      const p = sig.parameters[i];
      if (!p) break;
      const pt = checker.getTypeOfSymbolAtLocation(p, n);
      if (ts.isStringLiteral(arg) && pt.flags & ts.TypeFlags.String) return { start: arg.getStart(f), end: arg.end, replacement: '42', note: `${text(f, n.expression)}(…${text(f, arg)}…): ${typeText(pt)}` };
      if (ts.isNumericLiteral(arg) && pt.flags & ts.TypeFlags.Number) return { start: arg.getStart(f), end: arg.end, replacement: "'42'", note: `${text(f, n.expression)}(…${text(f, arg)}…): ${typeText(pt)}` };
    }
    return null;
  },
  'wrong-argument-count': (f, n) => {
    if (!ts.isCallExpression(n)) return null;
    const sig = checker.getResolvedSignature(n);
    if (!sig || sig.declaration && sig.declaration.parameters?.some(p => p.dotDotDotToken)) return null;
    if (!sig.declaration || n.arguments.length !== sig.parameters.length || sig.parameters.length === 0) return null;
    const lastArg = n.arguments.at(-1);
    return { start: lastArg.end, end: lastArg.end, replacement: ', 0', note: text(f, n.expression).slice(0, 50) };
  },
  'property-misspelt': (f, n) => {
    if (!ts.isPropertyAccessExpression(n) || n.questionDotToken || !ts.isIdentifier(n.name)) return null;
    const t = checker.getTypeAtLocation(n.expression);
    if (t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown) || !checker.getPropertyOfType(checker.getApparentType(t), n.name.text)) return null;
    if (ts.isCallExpression(n.parent) && n.parent.expression === n) return null; // keep it a read
    return { start: n.name.getStart(f), end: n.name.end, replacement: `${n.name.text}Probe`, note: text(f, n).slice(0, 60) };
  },
  'missing-required-property': (f, n) => {
    if (!ts.isObjectLiteralExpression(n) || n.properties.length < 2) return null;
    const target = checker.getContextualType(n);
    if (!target || target.isUnion()) return null;
    const p = n.properties.find(x => ts.isPropertyAssignment(x) && ts.isIdentifier(x.name) && (() => { const s = checker.getPropertyOfType(target, x.name.text); return s && !(s.flags & ts.SymbolFlags.Optional); })());
    if (!p) return null;
    const end = f.text[p.end] === ',' ? p.end + 1 : p.end;
    return { start: p.getStart(f), end, replacement: '', note: `${p.name.text} of ${typeText(target)}`.slice(0, 70) };
  },
  'excess-property': (f, n) => {
    if (!ts.isObjectLiteralExpression(n) || !n.properties.length) return null;
    const target = checker.getContextualType(n);
    if (!target || target.isUnion() || target.flags & ts.TypeFlags.Any || checker.getIndexInfosOfType(target).length) return null;
    if (!checker.getPropertiesOfType(target).length) return null;
    const first = n.properties[0];
    return { start: first.getStart(f), end: first.getStart(f), replacement: '__probeExtra: 1, ', note: typeText(target).slice(0, 70) };
  },
  'optional-property-set-undefined (exactOptionalPropertyTypes)': (f, n) => {
    if (!ts.isPropertyAssignment(n) || !ts.isIdentifier(n.name) || !ts.isObjectLiteralExpression(n.parent)) return null;
    const target = checker.getContextualType(n.parent);
    if (!target || target.isUnion()) return null;
    const s = checker.getPropertyOfType(target, n.name.text);
    if (!s || !(s.flags & ts.SymbolFlags.Optional)) return null;
    const decl = s.valueDeclaration;
    if (!decl || !decl.type || /undefined/.test(decl.type.getText())) return null;
    return { start: n.initializer.getStart(f), end: n.initializer.end, replacement: 'undefined', note: `${n.name.text}?: ${decl.type.getText()}`.slice(0, 70) };
  },
  'non-null-removed-on-index (noUncheckedIndexedAccess)': (f, n) => {
    if (!ts.isNonNullExpression(n) || !ts.isElementAccessExpression(n.expression)) return null;
    return { start: n.end - 1, end: n.end, replacement: '', note: text(f, n).slice(0, 60) };
  },
  'non-null-removed': (f, n) => {
    if (!ts.isNonNullExpression(n) || ts.isElementAccessExpression(n.expression)) return null;
    return { start: n.end - 1, end: n.end, replacement: '', note: text(f, n).slice(0, 60) };
  },
  'optional-chain-removed': (f, n) => {
    if (!ts.isPropertyAccessExpression(n) || !n.questionDotToken) return null;
    const t = checker.getTypeAtLocation(n.expression);
    if (!(t.flags & ts.TypeFlags.Union) || !t.types.some(x => x.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null))) return null;
    return { start: n.questionDotToken.getStart(f), end: n.questionDotToken.end, replacement: '.', note: text(f, n).slice(0, 60) };
  },
  'return-type-mismatch': (f, n) => {
    if (!ts.isReturnStatement(n) || !n.expression) return null;
    const fn = ts.findAncestor(n, ts.isFunctionLike);
    if (!fn?.type || ts.findAncestor(n.parent, x => x !== fn && ts.isFunctionLike(x)) !== fn && ts.findAncestor(n.parent, ts.isFunctionLike) !== fn) return null;
    const rt = fn.type.getText();
    const bad = rt === 'boolean' ? "'yes'" : rt === 'number' ? "'1'" : rt === 'string' ? '1' : null;
    return bad ? { start: n.expression.getStart(f), end: n.expression.end, replacement: bad, note: `returns ${rt}` } : null;
  },
  'unreachable-case (narrowed union)': (f, n) => {
    if (!ts.isSwitchStatement(n) || !n.caseBlock.clauses.length) return null;
    const t = checker.getTypeAtLocation(n.expression);
    if (!t.isUnion() || !t.types.every(x => x.isStringLiteral())) return null;
    const first = n.caseBlock.clauses[0];
    return { start: first.getStart(f), end: first.getStart(f), replacement: "case '__probe_never__': break;\n", note: typeText(t).slice(0, 70) };
  },
  'implicit-any-parameter': (f, n) => {
    if (!(ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) || !n.body) return null;
    const p = n.parameters.find(x => x.type && ts.isIdentifier(x.name) && !x.initializer);
    return p ? { start: p.name.end, end: p.type.end, replacement: '', note: `${p.name.text}: ${p.type.getText()}`.slice(0, 60) } : null;
  },
  'catch-variable-is-unknown (useUnknownInCatchVariables)': (f, n) => {
    if (!ts.isCatchClause(n) || !n.variableDeclaration || !ts.isIdentifier(n.variableDeclaration.name) || n.variableDeclaration.type) return null;
    const at = n.block.getStart(f) + 1;
    return { start: at, end: at, replacement: ` void ${n.variableDeclaration.name.text}.message;`, note: n.variableDeclaration.name.text };
  },
  'readonly-assigned': (f, n) => {
    if (!ts.isPropertyDeclaration(n) || !ts.getModifiers(n)?.some(m => m.kind === ts.SyntaxKind.ReadonlyKeyword) || !ts.isIdentifier(n.name)) return null;
    if (ts.getModifiers(n).some(m => m.kind === ts.SyntaxKind.StaticKeyword)) return null;
    const method = n.parent.members.find(m => ts.isMethodDeclaration(m) && m.body && !ts.getModifiers(m)?.some(x => x.kind === ts.SyntaxKind.StaticKeyword));
    if (!method) return null;
    const at = method.body.getStart(f) + 1;
    return { start: at, end: at, replacement: ` this.${n.name.text} = this.${n.name.text};`, note: n.name.text };
  },
  'const-reassigned': (f, n) => {
    if (!ts.isVariableStatement(n) || !(n.declarationList.flags & ts.NodeFlags.Const) || !ts.isBlock(n.parent)) return null;
    const d = n.declarationList.declarations[0];
    if (!ts.isIdentifier(d.name)) return null;
    return { start: n.end, end: n.end, replacement: ` ${d.name.text} = ${d.name.text};`, note: d.name.text };
  },
  'null-to-non-nullable': (f, n) => {
    if (!ts.isVariableDeclaration(n) || !n.type || !n.initializer || /null|undefined|unknown|any/.test(n.type.getText())) return null;
    return { start: n.initializer.getStart(f), end: n.initializer.end, replacement: 'null', note: `: ${n.type.getText()}`.slice(0, 60) };
  },
  'wrong-generic-argument': (f, n) => {
    // An explicit type argument (a call `f<T>(…)` or `new C<T>(…)`, or a typed `Map`/`Set`) replaced by an unrelated type.
    if (!(ts.isCallExpression(n) || ts.isNewExpression(n)) || !n.typeArguments?.length) return null;
    const a = n.typeArguments[0];
    if (a.kind === ts.SyntaxKind.UnknownKeyword || a.kind === ts.SyntaxKind.AnyKeyword) return null;
    return { start: a.getStart(f), end: a.end, replacement: 'symbol', note: text(f, n).slice(0, 60) };
  },
  'type-reexport-without-type (isolatedModules)': (f, n) => {
    if (!ts.isExportDeclaration(n) || !n.isTypeOnly || !n.moduleSpecifier) return null;
    const kw = text(f, n).indexOf('type ');
    return kw < 0 ? null : { start: n.getStart(f) + kw, end: n.getStart(f) + kw + 5, replacement: '', note: text(f, n).slice(0, 60) };
  },
};

const sites = Object.fromEntries(Object.keys(KINDS).map(k => [k, []]));
for (const f of sources) {
  const visit = node => {
    for (const [kind, find] of Object.entries(KINDS)) {
      try { const m = find(f, node); if (m) sites[kind].push({ kind, file: rel(f), line: f.getLineAndCharacterOfPosition(m.start).line + 1, ...m }); } catch { /* a site the finder cannot type */ }
    }
    ts.forEachChild(node, visit);
  };
  visit(f);
}
/** At most perKind per kind, spread evenly over the sites (one per file first), in a fixed order. */
function pick(list) {
  const byFile = new Map();
  for (const s of list) byFile.has(s.file) || byFile.set(s.file, s);
  const firsts = [...byFile.values()];
  const pool = firsts.length >= perKind ? firsts : [...firsts, ...list.filter(s => !firsts.includes(s))];
  const step = pool.length / Math.min(perKind, pool.length);
  return Array.from({ length: Math.min(perKind, pool.length) }, (_, i) => pool[Math.floor(i * step)]);
}
function sampled(all) {
  // A seeded draw over every site of every kind (mulberry32 over a hash of the seed), in a fixed order for a seed.
  if (!sample) return Object.values(sites).flatMap(pick);
  let h = 2166136261;
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  const random = () => { h = (h + 0x6D2B79F5) >>> 0; let t = h; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const pool = all.slice();
  for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  return pool.slice(0, sample);
}
const mutations = sampled(Object.values(sites).flat()).map((m, i) => ({ id: i + 1, ...m }));
if (listOnly) {
  for (const [kind, list] of Object.entries(sites)) console.log(`${String(list.length).padStart(5)} sites, ${String(pick(list).length).padStart(2)} picked: ${kind}`);
  console.log(`${mutations.length} mutations`);
  for (const m of mutations.slice(0, 8)) console.log(`  #${m.id} ${m.kind} ${m.file}:${m.line} ${JSON.stringify(m.replacement).slice(0, 40)} (${m.note})`);
  process.exit(0);
}

// ------------------------------------------------------------------ running the checkers
const diag = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/;
function parse(output, dir) {
  const set = [];
  for (const line of output.split('\n')) {
    const m = diag.exec(line.trim());
    if (m) set.push({ file: relative(dir, resolve(dir, m[1])).replace(/^\.\.\/.*client\//, ''), line: Number(m[2]), code: m[4], message: m[5] });
  }
  return set;
}
async function check(c, dir) {
  const started = performance.now();
  let output = '';
  let failed = false;
  try { output = (await run(c.cmd[0], [...c.cmd.slice(1), '-p', join(dir, 'tsconfig.json'), '--pretty', 'false'], { cwd: dir, maxBuffer: 64 << 20 })).stdout; }
  catch (e) { output = `${e.stdout ?? ''}${e.stderr ?? ''}`; failed = true; }
  const diags = parse(output, dir);
  // A checker that fails without a single diagnostic did not check anything (a wrong path, a missing binary): that
  // must never read as "no errors". (The commands run in the copy, so give them absolute paths.)
  if (failed && !diags.length) throw new Error(`checker ${c.name} (${c.cmd.join(' ')}) failed without a diagnostic:\n${output.slice(0, 2000)}`);
  return { diags, ms: performance.now() - started, raw: output.slice(0, 4000) };
}
const key = d => `${d.file}:${d.line} ${d.code}`;
const fileLine = d => `${d.file}:${d.line}`;

const workdirs = Array.from({ length: jobs }, () => { const d = mkdtempSync(join(tmpdir(), 'je-tc-agree-')); cpSync(join(root, 'client'), d, { recursive: true }); return d; });
const clean = {};
for (const c of checkers) clean[c.name] = await check(c, workdirs[0]);
const results = [];
let next = 0;
await Promise.all(workdirs.map(async dir => {
  while (next < mutations.length) {
    const m = mutations[next++];
    const path = join(dir, m.file);
    const original = readFileSync(path, 'utf8');
    writeFileSync(path, original.slice(0, m.start) + m.replacement + original.slice(m.end));
    const r = {};
    for (const c of checkers) r[c.name] = await check(c, dir);
    writeFileSync(path, original);
    results.push({ ...m, results: Object.fromEntries(Object.entries(r).map(([k, v]) => [k, { diags: v.diags, ms: v.ms }])) });
  }
}));
for (const d of workdirs) rmSync(d, { recursive: true, force: true });
results.sort((a, b) => a.id - b.id);

// ------------------------------------------------------------------ comparison
const authority = checkers[0].name;
const lines = [];
lines.push(`# Type-checker agreement with ${authority}\n`);
lines.push(`Checkers: ${checkers.map(c => `\`${c.name}\` = \`${c.cmd.join(' ')}\``).join('; ')}.\n`);
lines.push('## Clean tree\n');
for (const c of checkers) lines.push(`- ${c.name}: ${clean[c.name].diags.length} error(s)${clean[c.name].diags.length ? ': ' + clean[c.name].diags.slice(0, 5).map(key).join(', ') : ''}`);
const rejected = results.filter(r => r.results[authority].diags.length);
lines.push(`\n## Mutations: ${results.length} applied one at a time; ${authority} rejects ${rejected.length} (the seeded errors) and accepts ${results.length - rejected.length}\n`);
const kinds = [...new Set(results.map(r => r.kind))];
lines.push(`| kind | mutations | rejected by ${authority} | ${checkers.slice(1).map(c => `${c.name}: same verdict / same file:line / same file:line+code`).join(' | ')} |`);
lines.push(`|---|---:|---:|${checkers.slice(1).map(() => '---:').join('|')}|`);
const disagreements = [];
for (const kind of kinds) {
  const rs = results.filter(r => r.kind === kind);
  const cells = checkers.slice(1).map(c => {
    let verdict = 0, place = 0, exact = 0;
    for (const r of rs) {
      const a = r.results[authority].diags, b = r.results[c.name].diags;
      const sameVerdict = (a.length > 0) === (b.length > 0);
      const samePlace = JSON.stringify([...new Set(a.map(fileLine))].sort()) === JSON.stringify([...new Set(b.map(fileLine))].sort());
      const sameExact = JSON.stringify([...new Set(a.map(key))].sort()) === JSON.stringify([...new Set(b.map(key))].sort());
      verdict += sameVerdict; place += samePlace; exact += sameExact;
      if (!sameExact) disagreements.push({ id: r.id, kind, checker: c.name, file: r.file, line: r.line, note: r.note,
        missed: a.filter(d => !b.some(x => key(x) === key(d))).map(key), extra: b.filter(d => !a.some(x => key(x) === key(d))).map(key) });
    }
    return `${verdict}/${rs.length} · ${place}/${rs.length} · ${exact}/${rs.length}`;
  });
  lines.push(`| ${kind} | ${rs.length} | ${rs.filter(r => r.results[authority].diags.length).length} | ${cells.join(' | ')} |`);
}
lines.push('\n## Disagreements (missed = reported by the authority only; extra = reported by the other checker only)\n');
if (!disagreements.length) lines.push('None.');
else {
  lines.push('| # | checker | kind | site | missed | extra |\n|---:|---|---|---|---|---|');
  for (const d of disagreements) lines.push(`| ${d.id} | ${d.checker} | ${d.kind} | ${d.file}:${d.line} (${d.note.replaceAll('|', '\\|')}) | ${d.missed.join(', ') || '-'} | ${d.extra.join(', ') || '-'} |`);
}
lines.push('\n## Time per check (median ms over all mutation runs; the copies run in parallel, so these are not benchmark numbers)\n');
for (const c of checkers) { const ms = results.map(r => r.results[c.name].ms).sort((a, b) => a - b); lines.push(`- ${c.name}: ${Math.round(ms[Math.floor(ms.length / 2)])} ms`); }
const md = lines.join('\n') + '\n';
if (out) {
  writeFileSync(`${out}.md`, md);
  writeFileSync(`${out}.json`, JSON.stringify({ checkers, clean, mutations: results }, null, 1));
}
process.stdout.write(md);
// --gate fails on a different verdict or file:line set only; the default also fails on a different error code.
const failing = gate ? disagreements.filter(d => { const r = results.find(x => x.id === d.id);
  const a = r.results[authority].diags, b = r.results[d.checker].diags;
  return (a.length > 0) !== (b.length > 0) || JSON.stringify([...new Set(a.map(fileLine))].sort()) !== JSON.stringify([...new Set(b.map(fileLine))].sort()); })
  : disagreements;
if (gate) console.error(`typecheck agreement: ${results.length} mutation(s) and the clean tree; ${failing.length} verdict or file:line disagreement(s), ${disagreements.length - failing.length} error-code difference(s)`);
process.exitCode = failing.length || checkers.some(c => clean[c.name].diags.length) ? 1 : 0;
