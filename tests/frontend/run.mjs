import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { discoverTests, repositoryRoot, splitFirst, testArguments, testEnvironment } from './helpers/discovery.mjs';

// JE_TESTS_FIRST names a file listing test files (repository-relative), e.g. the ones a change can reach
// (scripts/restructure-gates.sh takes them from the affected map); JE_TESTS_PART=first runs only those, =rest only the
// others. The gate runs the two parts one after the other, so a broken change fails in the first seconds.
function selected() {
  const all = discoverTests();
  if (!process.env.JE_TESTS_FIRST || !process.env.JE_TESTS_PART) return all;
  const parts = splitFirst(all, readFileSync(process.env.JE_TESTS_FIRST, 'utf8').split('\n').filter(Boolean));
  if (!(process.env.JE_TESTS_PART in parts)) throw new Error(`JE_TESTS_PART must be first or rest, not ${process.env.JE_TESTS_PART}`);
  return parts[process.env.JE_TESTS_PART];
}
const files = selected();

// JE_EARLY_FAILURES names a file that each failing test is appended to the moment it fails (tests/runner/early-failures.mjs).
const early = process.env.JE_EARLY_FAILURES ? [`--import=${join(repositoryRoot, 'tests/runner/early-failures.mjs')}`] : [];
if (files.length === 0) {
  // An empty part runs nothing (`node --test` with no files would discover its own).
  process.exitCode = 0;
} else {
  const result = spawnSync(process.execPath,
    [...early, '--test', ...testArguments, ...process.argv.slice(2), ...files],
    { cwd: repositoryRoot, stdio: 'inherit', env: testEnvironment() });
  process.exitCode = result.error || result.signal || result.status === null ? 1 : result.status;
}
