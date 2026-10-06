import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import coverage from 'istanbul-lib-coverage';
import { createInstrumenter } from 'istanbul-lib-instrument';
import { createContext } from 'istanbul-lib-report';
import reports from 'istanbul-reports';
import { discoverTests, repositoryRoot, testArguments, testEnvironment } from './discovery.mjs';
process.chdir(repositoryRoot);
const out = resolve('artifacts/frontend-coverage');
const raw = join(out, 'raw');
rmSync(out, { recursive: true, force: true });
mkdirSync(raw, { recursive: true });
const files = discoverTests();
const result = spawnSync(process.execPath, ['--test', ...testArguments, ...files], { stdio: 'inherit', env: testEnvironment({ JE_COVERAGE_DIR: raw }) });
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
for (const file of readdirSync(raw)) map.merge(JSON.parse(readFileSync(join(raw, file), 'utf8')));
const context = createContext({ dir: out, coverageMap: map });
for (const format of ['text-summary', 'json-summary', 'lcovonly', 'html']) reports.create(format).execute(context);
// Baseline floors deliberately include all modules: they prevent regression without
// implying that this small percentage is comprehensive behavioral coverage.
const totals = map.getCoverageSummary();
let failed = false;
for (const [metric, minimum] of Object.entries({ statements: 20, branches: 15, functions: 21, lines: 21 })) {
  if (totals[metric].pct < minimum) { console.error(`Global ${metric}: ${totals[metric].pct}% < ${minimum}%`); failed = true; }
}
for (const name of ['api-client', 'dom-observer', 'lifecycle', 'navigation', 'session']) {
  const summary = map.fileCoverageFor(resolve(`Jellyfin.Plugin.JellyfinEnhanced/js/core/${name}.js`)).toSummary();
  for (const [metric, minimum] of Object.entries({ statements: 60, branches: 45 })) {
    if (summary[metric].pct < minimum) { console.error(`${name} ${metric}: ${summary[metric].pct}% < ${minimum}%`); failed = true; }
  }
}
process.exitCode = result.status === null || result.error || result.signal ? 1 : (result.status || (failed ? 1 : 0));
