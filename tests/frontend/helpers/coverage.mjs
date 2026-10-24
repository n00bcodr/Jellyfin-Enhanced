import { spawn } from 'node:child_process';
import { readdirSync, readFileSync, mkdirSync, mkdtempSync, writeFileSync, rmSync, cpSync } from 'node:fs';
import { resolve, join } from 'node:path';
import coverage from 'istanbul-lib-coverage';
import { createInstrumenter } from 'istanbul-lib-instrument';
import { createContext } from 'istanbul-lib-report';
import reports from 'istanbul-reports';
import { discoverTests, repositoryRoot, testArguments, testEnvironment, nestedConcurrency } from './discovery.mjs';
process.chdir(repositoryRoot);
const out = resolve(process.env.JE_FRONTEND_COVERAGE_ROOT || 'artifacts/frontend-coverage');
const files = discoverTests();
const shardCount = Number(process.env.JE_FRONTEND_SHARDS || 1);
const concurrency = Number(process.env.JE_NODE_FILE_CONCURRENCY || 8);
if (![1, 2, 3, 4].includes(shardCount) || ![1, 2, 3, 4, 5, 6, 7, 8].includes(concurrency) || shardCount > concurrency) {
  throw new Error('Frontend requires 1–8 total workers and 1–4 nonempty shards, no more shards than workers');
}
// The ordinary single-process collector keeps the historical tree exactly.
// Isolated runs own their private directories; remove only the old compatibility
// raw maps before launch so a collector cannot mistake retained data for fresh.
const isolated = shardCount > 1;
if (isolated) {
  rmSync(join(out, 'raw'), { recursive: true, force: true });
} else {
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
}
// Private counters live beside the compatibility tree, so refreshing the old
// tree cannot remove counters belonging to any other invocation or shard.
const runs = join(out, '..', '.frontend-coverage-runs');
mkdirSync(runs, { recursive: true });
const run = mkdtempSync(join(runs, 'run-'));
const shards = Array.from({ length: shardCount }, (_, index) => ({
  id: `shard-${index}`, files: files.filter((_, i) => i % shardCount === index),
  directory: join(run, `shard-${index}`)
}));
const started = performance.now();
await Promise.all(shards.map(async (shard, index) => {
  if (!shard.files.length) throw new Error('Empty frontend partition');
  const raw = join(shard.directory, 'raw');
  mkdirSync(raw, { recursive: true });
  const workers = Math.floor(concurrency / shardCount) + (index < concurrency % shardCount ? 1 : 0);
  let output = '';
  const child = spawn(process.execPath, ['--test', ...testArguments.filter(arg => !arg.startsWith('--test-concurrency=')),
    `--test-concurrency=${workers}`, '--test-reporter=tap', ...shard.files], {
    env: testEnvironment({ JE_COVERAGE_DIR: raw,
      JE_INSTRUMENT_CACHE_DIR: process.env.JE_INSTRUMENT_CACHE_DIR || join(out, '..', '.frontend-instrumented'),
      JE_NODE_NESTED_CONCURRENCY: String(nestedConcurrency) }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {
    output += chunk;
    process.stdout.write(chunk);
  });
  const status = await new Promise(resolve => {
    child.on('error', error => { output += String(error); resolve(1); });
    child.on('close', (code, signal) => resolve(signal || code === null ? 1 : code));
  });
  writeFileSync(join(shard.directory, 'tests.log'), output);
  const count = Number(output.match(/^# tests (\d+)$/m)?.[1] || 0);
  Object.assign(shard, { status, count, workers });
  if (!count || !readdirSync(raw).length) shard.status = 1;
}));
const map = coverage.createCoverageMap({});
// Include every production JS module, including those never loaded by a test.
function inventory(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = join(dir, entry.name);
    if (entry.isDirectory()) inventory(file);
    else if (file.endsWith('.js')) {
      const instrumenter = createInstrumenter();
      instrumenter.instrumentSync(readFileSync(file, 'utf8'), file);
      map.addFileCoverage(instrumenter.lastFileCoverage());
    }
  }
}
inventory(resolve('Jellyfin.Plugin.JellyfinEnhanced/js'));
for (const shard of shards) {
  const raw = join(shard.directory, 'raw');
  const shardMap = coverage.createCoverageMap({});
  for (const file of readdirSync(raw)) {
    const data = JSON.parse(readFileSync(join(raw, file), 'utf8'));
    shardMap.merge(data);
    map.merge(data);
  }
  if (isolated) {
    const report = join(shard.directory, 'report');
    mkdirSync(report);
    writeFileSync(join(report, 'coverage-final.json'), JSON.stringify(shardMap));
    writeFileSync(join(report, 'coverage-summary.json'), JSON.stringify(shardMap.getCoverageSummary()));
  }
}
if (!isolated) cpSync(join(shards[0].directory, 'raw'), join(out, 'raw'), { recursive: true });
const context = createContext({ dir: out, coverageMap: map });
for (const format of ['text-summary', 'json-summary', ...(isolated ? ['json'] : []), 'lcovonly', 'html']) reports.create(format).execute(context);
// Baseline floors deliberately include all modules: they prevent regression without
// implying that this small percentage is comprehensive behavioral coverage.
const totals = map.getCoverageSummary();
let failed = false;
for (const [metric, minimum] of Object.entries({ statements: 28, branches: 20, functions: 29, lines: 30 })) {
  if (totals[metric].pct < minimum) { console.error(`Global ${metric}: ${totals[metric].pct}% < ${minimum}%`); failed = true; }
}
for (const name of ['api-client', 'dom-observer', 'lifecycle', 'navigation', 'session']) {
  const summary = map.fileCoverageFor(resolve(`Jellyfin.Plugin.JellyfinEnhanced/js/core/${name}.js`)).toSummary();
  for (const [metric, minimum] of Object.entries({ statements: 60, branches: 45 })) {
    if (summary[metric].pct < minimum) { console.error(`${name} ${metric}: ${summary[metric].pct}% < ${minimum}%`); failed = true; }
  }
}
writeFileSync(join(run, 'manifest.json'), JSON.stringify({ files, shards, seconds: (performance.now() - started) / 1000, totals }, null, 2));
process.exitCode = shards.some(shard => shard.status !== 0) || failed ? 1 : 0;
