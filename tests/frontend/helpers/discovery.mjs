import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
export const frontendRoot = fileURLToPath(new URL('../', import.meta.url));

/** Discover every nested behavioral spec; an empty suite is an error. */
export function discoverTests(directory = frontendRoot) {
  function walk(folder) {
    return readdirSync(folder, { withFileTypes: true }).flatMap(entry => {
      const path = join(folder, entry.name);
      return entry.isDirectory() ? walk(path) : entry.name.endsWith('.test.mjs') ? [path] : [];
    });
  }
  const files = walk(directory).sort();
  if (!files.length) throw new Error(`No frontend tests discovered under ${directory}`);
  return files;
}

/**
 * A hung test fails on its own instead of stalling the whole run. Node 22 (CI)
 * applies --test-timeout to each test file as a whole, newer Node to each test,
 * so the limit leaves room for the heaviest file on a slow runner.
 */
// Only two files contain nested concurrent suites. At most eight Node workers
// and 22 asynchronous cases can be active; the lane still supplies eight CPUs.
const fileConcurrency = Number(process.env.JE_NODE_FILE_CONCURRENCY || 8);
if (![1, 2, 3, 4, 5, 6, 7, 8].includes(fileConcurrency)) throw new Error('JE_NODE_FILE_CONCURRENCY must be 1–8');
export const nestedConcurrency = Number(process.env.JE_NODE_NESTED_CONCURRENCY || 8);
if (!Number.isInteger(nestedConcurrency) || nestedConcurrency < 1 || nestedConcurrency > 8 || fileConcurrency + Math.min(fileConcurrency, 2) * (nestedConcurrency - 1) > 22) {
  throw new Error('Node file workers and the two nested suites must fit the 22-case asynchronous budget');
}
export const testArguments = ['--test-timeout=120000', `--test-concurrency=${fileConcurrency}`];

/** Dates and locale-formatted text must not depend on the machine running the tests. */
export function testEnvironment(extra = {}) {
  return { ...process.env, TZ: 'UTC', LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8', ...extra };
}
