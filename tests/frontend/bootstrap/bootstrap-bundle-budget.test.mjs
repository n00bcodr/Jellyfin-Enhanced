import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { budgetPath, groupSizes, manifestSize, measureScenario, scenarios } from '../helpers/bundle-budget.mjs';

// scripts/bundle-budgets.json: what a cold Home load downloads and runs under the component-group loader,
// so the gain of loading groups on demand cannot silently regress. Its "description" says how to update it.

const budget = JSON.parse(readFileSync(budgetPath, 'utf8'));
const UPDATE = 'Run `node scripts/bundle-budgets.mjs` and update scripts/bundle-budgets.json deliberately (see its "description").';
/** Groups too large for the shared per-group ceiling, each covered by the scenario limits instead. */
const CEILING_EXEMPT = new Set(['core', 'tags', 'seerr', 'settings']);

/** Every numeric limit as path -> value, for comparing history entries. */
function numericLeaves(value, prefix = '') {
  if (typeof value === 'number') return [[prefix, value]];
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, child]) => numericLeaves(child, prefix ? `${prefix}.${key}` : key));
}

test('the budget is a ratchet: limits are the last history entry\'s, and an entry that raises a limit says why', () => {
  assert.ok(typeof budget.description === 'string' && budget.description.includes('scripts/bundle-budgets.mjs'));
  const history = budget.history;
  assert.ok(Array.isArray(history) && history.length > 0, 'history has no entries');
  assert.deepEqual(budget.limits, history.at(-1).limits, '"limits" must equal the last history entry\'s limits');
  for (const [index, entry] of history.entries()) {
    assert.match(entry.date, /^\d{4}-\d{2}-\d{2}$/, `history[${index}] needs a date`);
    assert.ok(entry.change && entry.measured && entry.limits, `history[${index}] needs change, measured and limits`);
    const previous = index === 0 ? null : new Map(numericLeaves(history[index - 1].limits));
    const raised = numericLeaves(entry.limits).filter(([path, value]) => !previous || !previous.has(path) || value > previous.get(path)).map(([path]) => path);
    if (raised.length) {
      assert.ok(typeof entry.reason === 'string' && entry.reason.trim().length > 0,
        `history[${index}] (${entry.date}) sets or raises ${raised.join(', ')}, so it needs a non-empty "reason".`);
    }
  }
  assert.deepEqual(Object.keys(budget.limits.scenarios).sort(), Object.keys(scenarios()).sort());
  assert.deepEqual(Object.keys(budget.measured.scenarios).sort(), Object.keys(scenarios()).sort());
});

for (const [name, scenario] of Object.entries(scenarios())) test(`cold Home load, ${name}: the groups, modules and bytes stay within the budget`, async t => {
  const measured = await measureScenario(t, scenario);
  const limit = budget.limits.scenarios[name];
  const summary = `${name}: ${measured.modules} modules, ${measured.rawBytes.toLocaleString('en')} raw, ${measured.gzipBytes.toLocaleString('en')} gzip-9 bytes`;
  assert.deepEqual(measured.groups, budget.measured.scenarios[name].groups,
    `The groups a cold Home load runs for "${name}" changed. If that is intended, ${UPDATE}`);
  assert.ok(measured.modules <= limit.maxModules, `${summary}: over ${limit.maxModules} modules. Load less at boot, or ${UPDATE}`);
  assert.ok(measured.rawBytes <= limit.maxRawBytes, `${summary}: over ${limit.maxRawBytes.toLocaleString('en')} raw bytes. Load less at boot, or ${UPDATE}`);
  assert.ok(measured.gzipBytes <= limit.maxGzipBytes, `${summary}: over ${limit.maxGzipBytes.toLocaleString('en')} gzip-9 bytes. Load less at boot, or ${UPDATE}`);
  if (name === 'allFeaturesOn') {
    const whole = manifestSize().rawBytes;
    const share = budget.limits.allFeaturesOnMaxShareOfManifestRaw;
    assert.ok(measured.rawBytes <= share * whole,
      `${summary}: more than ${share * 100}% of the whole manifest (${whole.toLocaleString('en')} raw bytes). ${UPDATE}`);
  }
});

test('core stays within its budget and no other group outgrows the per-group ceiling', () => {
  const sizes = groupSizes();
  const core = sizes.find(group => group.id === 'core');
  assert.ok(core.rawBytes <= budget.limits.coreMaxRawBytes,
    `core is ${core.rawBytes.toLocaleString('en')} raw bytes, over ${budget.limits.coreMaxRawBytes.toLocaleString('en')}: it loads on every page. Move code into a group, or ${UPDATE}`);
  const ceiling = budget.limits.groupMaxRawBytes;
  const over = sizes.filter(group => !CEILING_EXEMPT.has(group.id) && group.rawBytes > ceiling).map(group => `${group.id} (${group.rawBytes.toLocaleString('en')})`);
  assert.deepEqual(over, [], `groups over the ${ceiling.toLocaleString('en')}-byte per-group ceiling: split them, or ${UPDATE}`);
});
