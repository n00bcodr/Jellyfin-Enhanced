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
export const testArguments = ['--test-timeout=120000'];

/** Dates and locale-formatted text must not depend on the machine running the tests. */
export function testEnvironment(extra = {}) {
  return { ...process.env, TZ: 'UTC', LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8', ...extra };
}
