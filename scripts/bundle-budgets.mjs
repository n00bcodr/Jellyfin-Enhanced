#!/usr/bin/env node
// Prints what scripts/bundle-budgets.json measures, from the current tree: per scenario the groups a cold
// Home load runs, its module count and raw / gzip-9 bytes, plus each group's raw bytes and the manifest's.
// Use it to fill in "measured" and a new "history" entry when a change moves the numbers on purpose.
// Run from the repository root after `npm ci`: node scripts/bundle-budgets.mjs
import { groupSizes, manifestSize, measureScenario, scenarios } from '../tests/frontend/helpers/bundle-budget.mjs';

const cleanups = [];
const context = { after: fn => cleanups.push(fn) };
const result = { manifest: manifestSize(), scenarios: {}, groups: Object.fromEntries(groupSizes().map(group => [group.id, group.rawBytes])) };
try {
  for (const [name, scenario] of Object.entries(scenarios())) {
    const { requests, ...measured } = await measureScenario(context, scenario);
    result.scenarios[name] = measured;
  }
} finally {
  for (const cleanup of cleanups) cleanup();
}
console.log(JSON.stringify(result, null, 2));
