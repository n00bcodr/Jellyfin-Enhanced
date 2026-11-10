// The guard suite itself: every guard has a baseline and a test file, baselines only hold the guard's own rules,
// the ratchet notes a drop and fails a rise, and tests/frontend/run.mjs discovers this folder.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { discoverTests } from '../helpers/discovery.mjs';
import { GUARDS } from './guards.mjs';
import { baselinePath, here, ratchet, readBaseline, repoRoot } from './lib.mjs';

test('every guard has a test file and a commented, sorted baseline that only holds its own rules', () => {
  for (const g of GUARDS) {
    assert.ok(existsSync(join(here, `${g.name}.test.mjs`)), `${g.name}.test.mjs missing`);
    const raw = JSON.parse(readFileSync(baselinePath(g.name), 'utf8'));
    assert.equal(typeof raw._comment, 'string', `${g.name}-baseline.json has no _comment`);
    const files = Object.keys(raw).filter(k => !k.startsWith('_'));
    assert.deepEqual(files, [...files].sort(), `${g.name}-baseline.json files are not sorted (write it with record.mjs)`);
    for (const [file, keys] of Object.entries(readBaseline(g.name))) {
      assert.ok(existsSync(join(repoRoot, file)), `${g.name}-baseline.json lists a missing file ${file} (lower it with record.mjs)`);
      for (const [key, count] of Object.entries(keys)) {
        assert.ok(g.rules.includes(key.split(' ')[0]), `${g.name}: ${file}: ${key} is not one of ${g.rules.join(', ')}`);
        assert.ok(Number.isInteger(count) && count > 0, `${g.name}: ${file}: ${key} has count ${count}`);
      }
    }
  }
});

test('the ratchet fails a new key or a higher count and notes a lower one', () => {
  const baseline = { 'a.ts': { 'X1 f': 2, 'X1 g': 1 } };
  const violation = key => ({ file: 'a.ts', key });
  assert.deepEqual(ratchet([violation('X1 f'), violation('X1 f'), violation('X1 g')], baseline), { regressions: [], improvements: [] });
  const grown = ratchet([violation('X1 f'), violation('X1 f'), violation('X1 f'), violation('X1 h')], baseline);
  assert.deepEqual(grown.regressions, ['a.ts: X1 f ×3 (baseline 2)', 'a.ts: X1 h ×1 (baseline 0)']);
  assert.deepEqual(grown.improvements, ['a.ts: X1 g ×0 (baseline 1; lower it)']);
});

test('tests/frontend/run.mjs discovers the guard tests', () => {
  const found = discoverTests().map(f => f.replaceAll('\\', '/'));
  for (const g of GUARDS) assert.ok(found.some(f => f.endsWith(`/guards/${g.name}.test.mjs`)), `${g.name}.test.mjs not discovered`);
});
