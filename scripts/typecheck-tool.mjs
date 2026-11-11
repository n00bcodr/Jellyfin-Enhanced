// The repository's type checker: tsc-rs, a Rust port of the TypeScript 7 compiler, pinned exactly in package.json
// devDependencies. Every type check runs it: scripts/client-build.mjs (client:typecheck, client:check, client:build,
// and so every plugin build), the gates, and scripts/typecheck-selftest.mjs. Nothing runs tsc.
//
// Upgrades: change the exact pin here and in package.json together, run `npm install`, then
// `node scripts/typecheck-selftest.mjs`; land the bump only when it passes (it checks the planted errors and the
// strictness fixtures in tests/typecheck/).
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

export const tscRsVersion = '0.8.0';
const require = createRequire(import.meta.url);

function unavailable(what) {
  return new Error(`The type checker is unavailable: ${what}. Run npm ci at the repository root: package-lock.json pins `
    + `tsc-rs ${tscRsVersion} and its platform package @tsc-rs/${process.platform}-${process.arch} (an offline npm cache must `
    + 'contain both). tsc-rs ships binaries for linux x64/arm64, macOS x64/arm64 and Windows x64/arm64.');
}

/** The tsc-rs executable for this platform; throws a message naming what is missing. */
export function tscRs() {
  let manifest;
  try { manifest = require.resolve('tsc-rs/package.json'); } catch { throw unavailable('tsc-rs is not installed'); }
  const version = JSON.parse(readFileSync(manifest, 'utf8')).version;
  if (version !== tscRsVersion) throw unavailable(`tsc-rs ${version} is installed, ${tscRsVersion} is pinned`);
  const platform = `@tsc-rs/${process.platform}-${process.arch}`;
  let platformManifest;
  try { platformManifest = createRequire(manifest).resolve(`${platform}/package.json`); }
  catch { throw unavailable(`${platform}, its binary for this platform, is not installed`); }
  const exe = join(dirname(platformManifest), 'lib', process.platform === 'win32' ? 'tsc.exe' : 'tsc');
  if (!existsSync(exe)) throw unavailable(`${exe} is missing`);
  return exe;
}

/** Runs tsc-rs with these arguments (it takes no lock: the builder must stay usable inside verify:rewrite's lock). */
export function runTscRs(args, cwd) {
  const result = spawnSync(tscRs(), args, { cwd, encoding: 'utf8', maxBuffer: 64 << 20 });
  if (result.error) throw new Error(`tsc-rs could not run: ${result.error.message}`);
  return { status: result.status, output: `${result.stdout}${result.stderr}`, stdout: result.stdout };
}
