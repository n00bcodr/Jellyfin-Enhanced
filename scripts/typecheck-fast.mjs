#!/usr/bin/env node
// The inner loop's fast type pre-check (`npm run client:typecheck:fast`, run first by `restructure-gates.sh quick`).
//
// tsc-rs (a Rust port of TypeScript 7, pinned exactly in package.json's optionalDependencies) checks client/ in about
// 0.2 s where the repository's TypeScript 6 takes 3 s, and answers an edit in watch mode in milliseconds. It only
// fails fast: TypeScript 6 (`client:typecheck`, `client:build`) runs after it and stays the authority in every gate.
// On 121 seeded mutations tsc-rs 0.8.0 reported exactly the errors TypeScript 6 did, file and line
// (artifacts/restructure-plan/test-speed/RESULTS.md §7); the `tool` gate keeps checking a sample of sites.
//
// When tsc-rs or its platform binary is not installed (an offline checkout whose npm cache lacks them: the dependency
// is optional for that reason), it says so and passes; TypeScript 6 still checks next.
//   --available   exit 0 when tsc-rs can run here, 1 when not (prints nothing)
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const bin = join(root, 'node_modules/.bin/tsc-rs');

export function tscRsCommand() {
  if (!existsSync(bin)) return null;
  const probe = spawnSync(bin, ['--version'], { encoding: 'utf8' });
  return probe.status === 0 ? bin : null;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const command = tscRsCommand();
  if (process.argv.includes('--available')) process.exit(command ? 0 : 1);
  if (!command) {
    console.log('client:typecheck:fast: tsc-rs is not installed here (an optional dependency); skipped, TypeScript 6 checks next');
    process.exit(0);
  }
  const started = performance.now();
  const result = spawnSync(command, ['-p', 'client/tsconfig.json', '--pretty', 'false'], { cwd: root, stdio: 'inherit' });
  const took = ((performance.now() - started) / 1000).toFixed(2);
  if (result.status === 0) console.log(`client:typecheck:fast: tsc-rs found no type errors in ${took} s`);
  else console.log(`client:typecheck:fast: tsc-rs reports type errors (above, ${took} s); TypeScript 6 has the final word in the gates`);
  process.exit(result.status ?? 1);
}
