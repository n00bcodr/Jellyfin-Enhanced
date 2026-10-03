#!/usr/bin/env node
// Native poster tags parity run: real JS tag modules vs the C# PosterTagResolver.
//
//   node scripts/poster-tags-parity/run.mjs --server URL --admin NAME:PASSWORD --config-dir PATH [--user NAME:PASSWORD ...]
//   node scripts/poster-tags-parity/run.mjs --skip-fetch     (reuse data/inputs)
//
// Steps: fetch real inputs from a JE test server (read-only; see fetch-inputs.mjs
// for --server/--admin/--user/--config-dir), build the profiles and synthetic
// entries, let the C# harness write the server's view of synthetic settings,
// compute the web's tags (web-expected.mjs), run the C# resolver, compare
// (diff.mjs), and check the language-name port against Intl (names) and the
// string casing port against String.prototype (casing).
// Everything lands in scripts/poster-tags-parity/data/ (git-ignored).
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const data = join(here, 'data');
const args = process.argv.slice(2);
const skipFetch = args.includes('--skip-fetch');
const passThrough = args.filter((a) => a !== '--skip-fetch');

// Credentials never reach the log: --admin/--user values print as NAME:***.
const redact = (cmdArgs) => cmdArgs.map((a, i) => (i > 0 && (cmdArgs[i - 1] === '--admin' || cmdArgs[i - 1] === '--user') ? a.replace(/:[\s\S]*$/, ':***') : a));
const run = (cmd, cmdArgs, opts = {}) => {
    const shown = `${cmd} ${redact(cmdArgs).join(' ')}`;
    console.log(`\n$ ${shown}`);
    try {
        execFileSync(cmd, cmdArgs, { stdio: 'inherit', cwd: here, ...opts });
    } catch (e) {
        // execFileSync's error carries the full argument list; rethrow without it.
        throw new Error(`Command failed (${e.status != null ? `exit ${e.status}` : e.signal || e.code}): ${shown}`);
    }
};

if (!skipFetch) run('node', ['fetch-inputs.mjs', ...passThrough]);
run('node', ['profiles.mjs']);
run('dotnet', ['build', 'PosterTagParity/PosterTagParity.csproj', '-c', 'Release', '-nologo', '-v', 'q']);
const harness = join(here, 'PosterTagParity', 'bin', 'Release', 'net10.0', 'PosterTagParity.dll');
run('dotnet', [harness, 'prepare', data]);
run('node', ['web-expected.mjs']);
run('dotnet', [harness, 'resolve', data]);
run('node', ['names-expected.mjs']);
run('dotnet', [harness, 'names', data]);
run('node', ['casing-expected.mjs']);
run('dotnet', [harness, 'casing', data]);
try {
    run('node', ['diff.mjs']);
} catch {
    process.exitCode = 1;
}
