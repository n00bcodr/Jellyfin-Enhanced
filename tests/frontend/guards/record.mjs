// Baseline tool for the guard tests (not a test file).
//
//   node tests/frontend/guards/record.mjs                 lower every baseline to today's counts (never raises one,
//                                                         never adds a key); run it after fixing violations
//   node tests/frontend/guards/record.mjs --list [guard]  print every current violation with its line (for triage)
//   node tests/frontend/guards/record.mjs --init <guard>  write a guard's baseline from scratch (a NEW guard only)
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { GUARDS, guard } from './guards.mjs';
import { baselinePath, clientProject, countViolations, sortedMap } from './lib.mjs';

const args = process.argv.slice(2);
const project = clientProject();

const COMMENTS = {
  'escape-guard': 'X1: values interpolated into HTML that are not recognisably safe or escaped.',
  'css-injection-guard': 'X2: values interpolated into CSS text (style attributes, stylesheets, cssText) that are not recognisably safe or validated.',
  'error-as-empty-guard': 'R9: failure branches that return, cache or render an empty answer without an error channel.',
  'leak-guard': 'L1-L6: unbounded long-lived collections, global listeners, observers and intervals without teardown, uncapped retries, unrevoked object URLs.',
  'performance-rules-guard': 'R3/R5/R6: body-wide MutationObservers, setInterval DOM polling, runtime loads of remote assets.',
  'config-control-guard': 'C1: PluginConfiguration properties with no control on the admin configuration page.',
};

function write(name, counts) {
  const comment = `${COMMENTS[name]} Ratchet recorded by tests/frontend/guards/record.mjs: {file: {"<rule> <scope>[ <detail>]": count}}. Counts may only fall: run record.mjs after a fix to lower them. Never add a key or raise a count; fix the code instead. Triage: artifacts/restructure-plan/step-logs/canopy-k2-triage.md.`;
  writeFileSync(baselinePath(name), `${JSON.stringify({ _comment: comment, ...sortedMap(counts) }, null, 2)}\n`);
}

if (args[0] === '--list') {
  for (const g of args[1] ? [guard(args[1])] : GUARDS) {
    for (const v of g.scan(project)) console.log(`${g.name}\t${v.file}:${v.line}\t${v.key}\t${v.text}`);
  }
} else if (args[0] === '--init') {
  const g = guard(args[1]);
  if (existsSync(baselinePath(g.name)) && !args.includes('--force')) throw new Error(`${baselinePath(g.name)} exists; lower it with record.mjs instead`);
  write(g.name, countViolations(g.scan(project)));
} else {
  for (const g of GUARDS) {
    const raw = JSON.parse(readFileSync(baselinePath(g.name), 'utf8'));
    const current = countViolations(g.scan(project));
    const lowered = {};
    for (const [file, keys] of Object.entries(raw)) {
      if (file.startsWith('_')) continue;
      for (const [key, count] of Object.entries(keys)) {
        const now = Math.min(count, current[file]?.[key] ?? 0);
        if (now > 0) (lowered[file] ??= {})[key] = now;
      }
    }
    write(g.name, lowered);
  }
}
