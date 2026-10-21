import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readSources } from '../helpers/bundle-scan.mjs';
import { reachable, inventory, members } from '../helpers/effect-inventory.mjs';
import { ROOTS, BOUNDARY, SITES, TOKENS, CHECKS, REGRESSIONS } from '../helpers/effect-inventory-manifest.mjs';
import { repositoryRoot } from '../helpers/discovery.mjs';

// D46 slice 2 review round 11: the mechanical effect inventory. Every module a title's action can run code in (the
// closure over called JE members from the absent-title surfaces) is listed, and so is every effect primitive in it
// (owned writes, navigation, reload, feedback, dialogs, surfaces, focus moves, shared state), each with its token source
// and its check; a site after an await or inside a timer has a check before it (or a stated reason), a shared counter
// moves only after admission (or by its module's own lifecycle), and every category has an executed regression.

const REASON = /^(lifecycle|render|after): ./;

/** Every way `sources` differ from the manifest (empty: the inventory is complete and checked). */
function lint(sources) {
  const failures = [];
  const reached = reachable(sources, ROOTS, BOUNDARY);
  for (const file of reached.keys()) if (!(file in SITES)) failures.push(`${file}: reachable (${reached.get(file)}) but not inventoried`);
  for (const file of Object.keys(SITES)) if (!reached.has(file)) failures.push(`${file}: inventoried but no longer reachable`);
  const found = inventory(sources, [...reached.keys()].filter(file => file in sources));
  for (const [file, sites] of Object.entries(found)) {
    const listed = SITES[file] || {};
    for (const [key, site] of Object.entries(sites)) {
      const entry = listed[key];
      if (!entry) { failures.push(`${file}: ${key} (line ${site.lines.join(', ')}) is not listed with its token source and check`); continue; }
      const [n, token, check] = entry;
      if (n !== site.n) failures.push(`${file}: ${key}: ${site.n} sites, listed ${n}`);
      if (!(token in TOKENS)) failures.push(`${file}: ${key}: unknown token source ${token}`);
      if (!(check in CHECKS) && !REASON.test(check)) failures.push(`${file}: ${key}: unknown check ${check}`);
      // After an await or inside a timer, a check before the effect, or a stated reason. (Shared state is held to its
      // kind instead: a counter moves only after admission, a cache is keyed by its family's write epoch.)
      if (site.unguarded && key.split(' ')[1] !== 'state' && !/^after: /.test(check)) failures.push(`${file}: ${key} (line ${site.lines.join(', ')}): after an await or in a timer with no check before it`);
      if (check === 'effect' && site.unguarded) failures.push(`${file}: ${key}: listed as checked at the effect, but a deferred site has no check`);
      if (check === 'generation' && site.guarded !== site.n) failures.push(`${file}: ${key}: a counter advanced before admission`);
      if (check === 'transport' && site.handed !== site.n) failures.push(`${file}: ${key}: a write listed as bound that is not handed its binding`);
    }
    for (const key of Object.keys(listed)) if (!sites[key]) failures.push(`${file}: ${key} is listed but no longer found`);
  }
  // Every boundary edge is still a call some reachable module makes (a stale one would hide the next edge of its name).
  const { calls } = members(sources);
  const made = new Set([...reached.keys()].flatMap(file => [...(calls.get(file) || [])]));
  for (const key of Object.keys(BOUNDARY.members)) {
    const hit = key.endsWith('.*') ? [...made].some(path => path.startsWith(key.slice(0, -1))) : made.has(key);
    if (!hit) failures.push(`boundary ${key} is no longer called from a reachable module`);
  }
  return failures;
}

test('the effect inventory is complete: every reachable module and every effect site in it is listed with its token source and check', () => {
  assert.deepEqual(lint(readSources()), []);
});

test('every effect category has an executed regression that exists', () => {
  const categories = new Set(Object.values(SITES).flatMap(sites => Object.keys(sites).map(key => key.split(' ')[1])));
  for (const category of categories) assert.ok(REGRESSIONS[category]?.length, `${category} has a regression`);
  for (const [category, cases] of Object.entries(REGRESSIONS)) for (const [file, pattern] of cases) {
    const text = readFileSync(`${repositoryRoot}tests/frontend/${file}`, 'utf8');
    const titles = [...text.matchAll(/test\(\s*(['`])((?:\\.|(?!\1).)*)\1/g)].map(m => m[2].replace(/\\'/g, "'"));
    assert.ok(titles.some(title => pattern.test(title)), `${category}: ${file} has a test matching ${pattern}`);
  }
});

test('the inventory fails on an unlisted feedback site after an await (a toast with no owner check)', () => {
  const sources = readSources();
  const file = 'arr/notify/notify-follow.js';
  sources[file] = sources[file].replace('    function syncAll() {', '    async function plantedToast(owner) { await Promise.resolve(); JE.toast(\'planted\'); }\n    function syncAll() {');
  assert.ok(lint(sources).some(f => f.startsWith(`${file}: plantedToast feedback toast`)), 'the planted toast is reported');
});

test('the inventory fails on a counter moved before admission and on a module that becomes reachable unlisted', () => {
  const sources = readSources();
  const init = 'jellyseerr/moreinfo/more-info-modal-init.js';
  sources[init] = sources[init].replace(`    if (!submitted.owner || !submitted.current()) return;
    const generation = ++openGeneration;`, `    const generation = ++openGeneration;
    if (!submitted.owner || !submitted.current()) return;`);
  assert.notEqual(sources[init], readSources()[init], 'the plant applies');
  const failures = lint(sources);
  assert.ok(failures.some(f => /open state openGeneration: a counter advanced before admission/.test(f)), failures.join('\n'));
  const reach = readSources();
  reach['arr/actions/title-actions.js'] = reach['arr/actions/title-actions.js'].replace('function end() {', 'function end() { JE.internals?.calendarPage?.loadAllData?.();');
  assert.ok(lint(reach).some(f => /calendar-page-actions\.js: reachable .* but not inventoried/.test(f) || /calendar-page-\w+\.js: reachable/.test(f)));
});
