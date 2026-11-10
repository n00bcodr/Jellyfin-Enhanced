// Test helpers shared by the guard tests (not a test file).
import assert from 'node:assert/strict';
import { createProject, explain, ratchet, readBaseline } from './lib.mjs';

/**
 * The ratchet: a NEW (file, key) or a higher count fails; a lower count is a diagnostic note (lower the baseline
 * with `node tests/frontend/guards/record.mjs`). There are no exemptions beyond the recorded baseline.
 */
export function assertRatchet(t, guard, violations) {
  const { regressions, improvements } = ratchet(violations, readBaseline(guard.name));
  for (const line of improvements) t.diagnostic(`${guard.name}: fewer violations than recorded, lower the baseline (node tests/frontend/guards/record.mjs): ${line}`);
  assert.deepEqual(regressions, [], `${guard.name}: new violations (fix the code; never raise ${guard.name}-baseline.json)\n  `
    + `${regressions.join('\n  ')}\n  at:\n  ${explain(violations, regressions).join('\n  ')}`);
}

/** The planted file every self-test uses: a path no baseline lists, so any finding there is NEW. */
export const PLANTED = 'client/src/features/planted/planted.ts';

/** Scan synthetic sources ({path: text}; a string is the planted file) with a guard's scanner. */
export function scanPlanted(guard, sources, ...extra) {
  const files = typeof sources === 'string' ? { [PLANTED]: sources } : sources;
  return guard.scan(createProject(files), ...extra);
}

/**
 * A planted violation is found under `keys`, and the guard's ratchet against its real baseline fails on it.
 * @param {string[]} keys expected `<rule> <scope>[ <detail>]` keys in the planted file
 */
export function assertPlantedFails(guard, violations, keys, file = PLANTED) {
  const found = violations.filter(v => v.file === file).map(v => v.key);
  for (const key of keys) assert.ok(found.includes(key), `${guard.name}: planted ${key} not found; found:\n  ${found.join('\n  ')}`);
  const { regressions } = ratchet(violations, readBaseline(guard.name));
  for (const key of keys) {
    assert.ok(regressions.some(r => r.startsWith(`${file}: ${key} ×`)), `${guard.name}: the ratchet did not fail on planted ${key}`);
  }
}

/** The safe counterpart of a planted violation produces no finding at all. */
export function assertClean(guard, violations, file = PLANTED) {
  const found = violations.filter(v => v.file === file);
  assert.deepEqual(found.map(v => `${v.key} :: ${v.text}`), [], `${guard.name}: false positives in the safe sample`);
}
