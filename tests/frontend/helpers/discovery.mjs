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
