/** Cache immutable source text only: evaluation always allocates realm-local counters. */
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInstrumenter } from 'istanbul-lib-instrument';

const require = createRequire(import.meta.url);
const version = require('istanbul-lib-instrument/package.json').version;
let dependencyIdentity;
const memory = new Map();
const options = Object.freeze({});

/** The final served/transformed text includes locale and language-policy inputs. */
export function instrumentSource(source, filename, instrumenterOptions = options) {
  const enabled = process.env.JE_INSTRUMENT_CACHE === '1' || (process.env.JE_SPEED_PROFILE === '1' && process.env.JE_INSTRUMENT_CACHE !== '0');
  if (!enabled) return createInstrumenter(instrumenterOptions).instrumentSync(source, filename);
  dependencyIdentity ??= createHash('sha256').update(readFileSync(new URL('../../../package-lock.json', import.meta.url))).digest('hex');
  const identity = createHash('sha256').update(JSON.stringify([
    'je-instrumentation-v2', resolve(filename), version, dependencyIdentity, instrumenterOptions, source
  ])).digest('hex');
  if (enabled && memory.has(identity)) return memory.get(identity);
  const folder = enabled && process.env.JE_INSTRUMENT_CACHE_DIR;
  const cached = folder && join(folder, identity + '.json');
  let result;
  if (cached) {
    try {
      const entry = JSON.parse(readFileSync(cached, 'utf8'));
      if (entry && typeof entry.source === 'string') {
        const digest = createHash('sha256').update(entry.source).digest('hex');
        if (entry.identity === identity && entry.digest === digest) result = entry.source;
      }
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }
  }
  if (result === undefined) {
    result = createInstrumenter(instrumenterOptions).instrumentSync(source, resolve(filename));
    if (cached) {
      mkdirSync(folder, { recursive: true });
      const temporary = cached + '.' + process.pid + '.' + randomUUID();
      writeFileSync(temporary, JSON.stringify({ identity,
        digest: createHash('sha256').update(result).digest('hex'), source: result }));
      renameSync(temporary, cached);
    }
  }
  if (enabled) {
    // Bound per-worker memory; evicting text changes performance only.
    if (memory.size >= 256) memory.delete(memory.keys().next().value);
    memory.set(identity, result);
  }
  return result;
}
