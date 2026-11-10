// frontend.md §2.4 / §5.2: feature boundaries, strict since step C4 (boundary-baseline.json is gone: any violation
// fails). Imports are read from the TypeScript AST (scan.mjs), never with a regex.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  bridgeViolations, cycles, importViolations, moduleReferences, readJson, repoRoot, ts, virtualProgram, withoutComments,
} from './scan.mjs';

const owners = withoutComments(readJson('internals-owners.json'));
const imports = importViolations();

/** Every violation of one group of rules (violation keys starting with one of `rules`) fails: there is no baseline. */
function strict(current, rules, label) {
  const found = Object.entries(current).flatMap(([file, keys]) => Object.entries(keys)
    .filter(([key]) => rules.includes(key.split(' ')[0]))
    .map(([key, count]) => `${file}: ${key} ×${count}`)).sort();
  assert.deepEqual(found, [], `${label}: violations (fix the code; frontend.md §2.4)\n  ${found.join('\n  ')}`);
}

test('the scanner reads every import form from the AST, and none from comments or strings', () => {
  const text = [
    "// import fake from './comment';",
    "/* export * from './block-comment'; */",
    "const s = \"import('./string')\";",
    "import a from './a';",
    "import type { B } from './b';",
    "import { type C } from './c';",
    "import './d';",
    "export { e } from './e';",
    "export type { F } from './f';",
    "export * from './g';",
    "import h = require('./h');",
    "const i = import('./i');",
    "let j: import('./j').J;",
  ].join('\n');
  const sf = ts.createSourceFile('x.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const refs = moduleReferences('client/src/features/x/x.ts', sf).map(r => `${r.kind} ${r.specifier} ${r.typeOnly ? 'type' : 'runtime'}`);
  assert.deepEqual(refs, [
    'import ./a runtime',
    'import ./b type',
    'import ./c runtime',   // verbatimModuleSyntax keeps `import './c'`
    'import ./d runtime',
    'export ./e runtime',
    'export ./f type',
    'export ./g runtime',
    'import-equals ./h runtime',
    'dynamic-import ./i runtime',
    'import-type ./j type',
  ]);
});

test('every relative import in client/src resolves to a file', () => {
  assert.deepEqual(imports.unresolved, []);
});

test('rules 1-2: no cross-feature import and no host/ → features/ import (strict)', () => {
  strict(imports.violations, ['import', 'host-import'], 'feature/host imports');
});

test('rules 3-4: no JE.internals access outside its owner host and no raw window.JellyfinEnhanced outside the allowlist (strict)', () => {
  strict(bridgeViolations(owners), ['internals', 'internals-foreign', 'raw-global'], 'internals/raw-global');
});

// Planted violations for rules 3-4 (review G3): every bypass form must be caught, through the TypeScript AST and the
// type checker, in a program of in-memory files with client/tsconfig.json's options. Feature `alpha` owns slot
// `mine`; `other` belongs to `beta`. Each file holds one form; `expected` is the exact violation map.
const PLANT = 'client/src/features/alpha';
const BRIDGE = [
  'declare global { interface Window { JellyfinEnhanced: Bridge } var JellyfinEnhanced: Bridge; }',
  'interface Bridge { internals: Internals; t(): string }',
  'interface Internals { mine: { x: number }; other: { y: number } }',
  'declare const JE: Bridge;',
  'declare const name: string;',
].join(' ');
const planted = {
  // Rule 3 outside a host file: every internals reference, however written.
  'mod-destructure': 'const { internals } = JE; void internals;',
  'mod-destructure-alias': 'const { internals: i } = JE; void i.mine;',
  'mod-destructure-nested': 'const { internals: { other } } = JE; void other;',
  'mod-destructure-param': 'export function f({ internals }: Bridge) { return internals; }',
  'mod-destructure-for-of': 'for (const { internals } of [JE]) void internals;',
  'mod-assignment-pattern': 'let i: Internals; ({ internals: i } = JE); void i;',
  'mod-alias-bridge': 'const j = JE; void j.internals.other;',
  'mod-optional-chain': 'void JE?.internals?.other;',
  'mod-element-literal': "void JE['internals']; void JE[`internals`];",
  'mod-element-const-key': "const key = 'internals'; void JE[key];",
  'mod-reflect-get': "void Reflect.get(JE, 'internals');",
  'mod-cast': 'void (JE as Bridge).internals;',
  'mod-via-host-accessor': "import { rawInternals } from './host-accessor'; void rawInternals().other;",
  // Rule 3 in a host file: the whole object is the owner's own; every slot read must be owned.
  'host-accessor': 'export const rawInternals = () => JE.internals;',
  'host-owned': 'const i = JE.internals; const { mine } = JE.internals; void i.mine; void JE.internals.mine; void mine;'
    + ' export const ctx = { internalsObject: () => JE.internals };',
  'host-destructure-slot': 'const { other } = JE.internals; void other;',
  'host-destructure-nested': 'const { internals: { other } } = JE; void other;',
  'host-alias': 'const i = JE.internals; void i.other;',
  'host-alias-assign': 'const i = (JE.internals ||= {} as Internals); void i.other;',
  'host-cast': 'void (JE.internals as Internals).other; void (<Internals>JE.internals).other; void JE.internals!.other;',
  'host-optional-element': "void JE.internals?.['other'];",
  'host-const-key': "const k = 'other' as const; void JE.internals[k];",
  'host-accessor-call': 'const get = () => JE.internals; void get().other;',
  'host-dynamic-key': 'void JE.internals[name as keyof Internals];',
  'host-rest': 'const { mine, ...rest } = JE.internals; void mine; void rest;',
  // Rule 4 outside the allowlist: every read form and destructuring of the global.
  'g-element-literal': "void window['JellyfinEnhanced']; void window[`JellyfinEnhanced`];",
  'g-element-const-key': "const key = 'JellyfinEnhanced'; void window[key];",
  'g-optional-chain': 'void window?.JellyfinEnhanced; void globalThis?.JellyfinEnhanced;',
  'g-cast-element': "void (globalThis as unknown as Window)?.['JellyfinEnhanced'];",
  'g-alias': 'const w = window; void w.JellyfinEnhanced;',
  'g-global-alias-element': "const w = globalThis.window; void w['JellyfinEnhanced'];",
  'g-destructure': 'const { JellyfinEnhanced } = window; void JellyfinEnhanced;',
  'g-destructure-alias': 'const { JellyfinEnhanced: je } = globalThis; void je;',
  'g-destructure-param-type': 'export function f({ JellyfinEnhanced }: Window) { return JellyfinEnhanced; }',
  'g-destructure-param-default': 'export function f({ JellyfinEnhanced } = window) { return JellyfinEnhanced; }',
  'g-destructure-nested': 'const { w: { JellyfinEnhanced } } = { w: window }; void JellyfinEnhanced;',
  'g-assignment-pattern': 'let je: Bridge; ({ JellyfinEnhanced: je } = window); void je;',
  'g-reflect-get': "void Reflect.get(self, 'JellyfinEnhanced');",
  'g-function': 'const host = () => window; void host().JellyfinEnhanced;',
  // Not violations: a plain object with the same key, and the global read from an allowed host file.
  'g-plain-object': "const o = { JellyfinEnhanced: 1 }; void o.JellyfinEnhanced; void o['JellyfinEnhanced']; const { JellyfinEnhanced } = o; void JellyfinEnhanced;",
  'host-global': "void window['JellyfinEnhanced']; const { JellyfinEnhanced } = window; void JellyfinEnhanced;",
  'mod-this': 'export class C { internals = {}; m() { void this.internals; const { internals } = this; void internals; } }',
};
const plantedExpected = {
  'mod-destructure': { 'internals *': 1 },
  'mod-destructure-alias': { 'internals *': 1, 'internals mine': 1 },
  'mod-destructure-nested': { 'internals other': 1 },
  'mod-destructure-param': { 'internals *': 1 },
  'mod-destructure-for-of': { 'internals *': 1 },
  'mod-assignment-pattern': { 'internals *': 1 },
  'mod-alias-bridge': { 'internals other': 1 },
  'mod-optional-chain': { 'internals other': 1 },
  'mod-element-literal': { 'internals *': 2 },
  'mod-element-const-key': { 'internals *': 1 },
  'mod-reflect-get': { 'internals *': 1 },
  'mod-cast': { 'internals *': 1 },
  'mod-via-host-accessor': { 'internals other': 1 },
  'host-destructure-slot': { 'internals-foreign other': 1 },
  'host-destructure-nested': { 'internals-foreign other': 1 },
  'host-alias': { 'internals-foreign other': 1 },
  'host-alias-assign': { 'internals-foreign other': 1 },
  'host-cast': { 'internals-foreign other': 3 },
  'host-optional-element': { 'internals-foreign other': 1 },
  'host-const-key': { 'internals-foreign other': 1 },
  'host-accessor-call': { 'internals-foreign other': 1 },
  'host-dynamic-key': { 'internals-foreign ?': 1 },
  'host-rest': { 'internals-foreign ?': 1 },
  'g-element-literal': { 'raw-global JellyfinEnhanced': 2 },
  'g-element-const-key': { 'raw-global JellyfinEnhanced': 1 },
  'g-optional-chain': { 'raw-global JellyfinEnhanced': 2 },
  'g-cast-element': { 'raw-global JellyfinEnhanced': 1 },
  'g-alias': { 'raw-global JellyfinEnhanced': 1 },
  'g-global-alias-element': { 'raw-global JellyfinEnhanced': 1 },
  'g-destructure': { 'raw-global JellyfinEnhanced': 1 },
  'g-destructure-alias': { 'raw-global JellyfinEnhanced': 1 },
  'g-destructure-param-type': { 'raw-global JellyfinEnhanced': 1 },
  'g-destructure-param-default': { 'raw-global JellyfinEnhanced': 1 },
  'g-destructure-nested': { 'raw-global JellyfinEnhanced': 1 },
  'g-assignment-pattern': { 'raw-global JellyfinEnhanced': 1 },
  'g-reflect-get': { 'raw-global JellyfinEnhanced': 1 },
  'g-function': { 'raw-global JellyfinEnhanced': 1 },
};

test('rules 3-4 self-test: planted destructuring, alias, optional-chain, element-access and cast bypasses are all caught', () => {
  const files = Object.fromEntries(Object.entries(planted).map(([name, body]) => [`${PLANT}/${name}.ts`, `${BRIDGE}\n${body}\nexport {};\n`]));
  const prog = virtualProgram(files);
  const errors = ts.getPreEmitDiagnostics(prog).filter(d => d.file && d.file.fileName.includes('/features/alpha/'))
    .map(d => `${d.file.fileName.split('/').pop()}: ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`);
  assert.deepEqual(errors, [], 'the planted files must type-check, so the checker sees what real code would');
  const found = bridgeViolations({ mine: ['alpha'], other: ['beta'] }, prog);
  const expected = Object.fromEntries(Object.entries(plantedExpected).map(([name, keys]) => [`${PLANT}/${name}.ts`, keys]));
  assert.deepEqual(found, expected);
});

test('no runtime import cycle inside a feature', () => {
  assert.deepEqual(cycles(imports.edges), []);
});

test('internals-owners.json names only real features', () => {
  const features = new Set(readdirSync(join(repoRoot, 'client/src/features'), { withFileTypes: true })
    .filter(d => d.isDirectory() && d.name !== 'admin-tags').map(d => d.name));
  const unknown = Object.entries(owners).flatMap(([slot, list]) => list.filter(f => !features.has(f)).map(f => `${slot} → ${f}`));
  assert.deepEqual(unknown, []);
});
