import assert from 'node:assert/strict';
import { createContext, runInContext } from 'node:vm';
import { performance } from 'node:perf_hooks';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInstrumenter } from 'istanbul-lib-instrument';
import { instrumentSource } from '../../frontend/helpers/instrumentation.mjs';

const file = resolve('Jellyfin.Plugin.JellyfinEnhanced/js/core/session-action.js');
const source = readFileSync(file, 'utf8');
const expected = createInstrumenter().instrumentSync(source, file);
const started = performance.now();
for (let i = 0; i < 40; i++) {
  assert.equal(instrumentSource(source, file), expected);
}
const small = 'globalThis.example = value => value ? 1 : 2;';
const script = instrumentSource(small, '/example.js');
const a = createContext({}), b = createContext({});
runInContext(script, a); runInContext(script, b);
runInContext('example(true)', a);
assert.notDeepEqual(JSON.parse(JSON.stringify(a.__coverage__)), JSON.parse(JSON.stringify(b.__coverage__)));
assert.equal(runInContext('example(false)', b), 2);
assert.notEqual(instrumentSource(small.replace('1 : 2', '3 : 4'), '/example.js'), script);
assert.notEqual(instrumentSource(small, '/other.js'), script);
assert.notEqual(instrumentSource(small, '/example.js', { compact: false }), script);
console.log(JSON.stringify({ iterations: 40, seconds: (performance.now() - started) / 1000 }));

delete process.env.JE_COVERAGE_DIR;
const { createHarness } = await import('../../frontend/helpers/harness.mjs');
process.env.JE_COVERAGE_DIR = process.env.TMPDIR + '/cache-witness-raw';
const first = createHarness(), second = createHarness();
const firstMap = first.window.__coverage__, secondMap = second.window.__coverage__;
assert.notEqual(firstMap, secondMap);
for (const name of Object.keys(firstMap)) {
  assert.notEqual(firstMap[name], secondMap[name]);
  assert.notEqual(firstMap[name].s, secondMap[name].s);
}
const before = JSON.stringify(secondMap);
const entry = Object.values(firstMap)[0];
entry.s[Object.keys(entry.s)[0]] += 100;
assert.equal(JSON.stringify(secondMap), before);
assert.throws(() => first.load('core/session-action.js', text => text), /plant does not apply/);
first.close(); second.close();
