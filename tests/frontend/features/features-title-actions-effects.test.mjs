import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readSources } from '../helpers/bundle-scan.mjs';
import { reachable, inventory, members } from '../helpers/effect-inventory.mjs';
import { ROOTS, BOUNDARY, SITES as MANIFEST_SITES, TOKENS, CHECKS, REGRESSIONS } from '../helpers/effect-inventory-manifest.mjs';
import { sitesOf } from '../helpers/effect-inventory.mjs';
const SITES = MANIFEST_SITES;
import { repositoryRoot } from '../helpers/discovery.mjs';

// D46 slice 2 review round 11: the mechanical effect inventory. Every module a title's action can run code in (the
// closure over called JE members from the absent-title surfaces) is listed, and so is every effect primitive in it
// (owned writes, navigation, reload, feedback, dialogs, surfaces, focus moves, shared state), each with its token source
// and its check; a site after an await or inside a timer has a check before it (or a stated reason), a shared counter
// moves only after admission (or by its module's own lifecycle), and every category has an executed regression.

const REASON = /^(lifecycle|render|after): ./;

/** Every way `sources` differ from the manifest (empty: the inventory is complete and checked). */
function lint(sources, SITES = MANIFEST_SITES) {
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
      // A foreground node put in the document is registered on the one surface stack by the function that inserts it,
      // or listed with its reason (D46S2-R12-5: whatever its opener is called).
      if (site.unregistered && !REASON.test(check)) failures.push(`${file}: ${key} (line ${site.lines.join(', ')}): a foreground surface inserted without registering it on the surface stack`);
      if (check === 'registered' && site.unregistered) failures.push(`${file}: ${key}: listed as registered, but the function that inserts it registers nothing`);
      if (check === 'forwarded' && !/ write transport dynamic /.test(` ${key} `)) failures.push(`${file}: ${key}: only a transport wrapper forwarding its caller's options is "forwarded"`);
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

// ---------------------------------------------------------------- D46 slice 2 review round 12 (B40, B41)
// The inventory sees what an effect IS, not what it is called: a foreground node inserted under any name, a member
// reached through a nested or renamed alias, a closure-local counter, a write by method and route; and a guard counts
// only where it decides the effect (a guard in another branch, in a nested callback, or a decoy owner word does not).

test('R12-5 (B40): a renamed, local dialog inserted without registering it fails the lint at its real site', () => {
  const sources = readSources();
  const file = 'arr/ask/ask-episodes.js';
  sources[file] = sources[file].replace('    function closeDialog() {', "    function showThing() { const box = document.createElement('div'); box.setAttribute('role', 'dialog'); document.body.appendChild(box); }\n    function closeDialog() {");
  const failures = lint(sources);
  assert.ok(failures.some(f => f.startsWith(`${file}: showThing surface insert body`)), failures.join('\n'));
  // Listed as registered, it still fails: the function that inserts it registers nothing.
  const listed = { ...SITES, [file]: { ...SITES[file], 'showThing surface insert body': [1, 'press', 'registered'] } };
  assert.ok(lint(sources, listed).some(f => /showThing surface insert body.*(without registering|registers nothing)/.test(f)));
  // Control: the episode dialog's own insertion is registered (openDetails calls openSurface).
  assert.equal(sitesOf(file, readSources()[file]).filter(site => site.fn === 'openDetails' && site.target === 'insert body' && !site.registered).length, 0);
});

test('R12-5 (B41): a member reached through a nested or renamed alias is followed (the drawer\'s Remove reaches the admin tabs)', () => {
  const sources = readSources();
  assert.match(reachable(sources, ROOTS, BOUNDARY).get('arr/admin/admin-tabs.js') || '', /manage-drawer\.js → internals\.arrHub\.admin\./);
  const file = 'arr/admin/admin-tabs.js';
  sources[file] = sources[file].replace('    const H = (JE.internals = JE.internals || {}).arrHub = JE.internals.arrHub || {};\n    const A = H.admin = H.admin || {};',
    '    const Hub = (JE.internals = JE.internals || {}).arrHub = JE.internals.arrHub || {};\n    const Adm = Hub.admin = Hub.admin || {};\n    const A = Adm;');
  assert.notEqual(sources[file], readSources()[file], 'the plant applies');
  assert.ok(reachable(sources, ROOTS, BOUNDARY).has(file), 'still reached under its new names');
});

test('R12-7 (B31): a closure-local counter advanced before admission fails the lint', () => {
  const sources = readSources();
  const file = 'core/session-action.js';
  sources[file] = sources[file].replace(`            const admitted = admit(owner);
            if (!admitted) return () => false;
            const mine = ++latest;`, `            const mine = ++latest;
            const admitted = admit(owner);
            if (!admitted) return () => false;`);
  assert.notEqual(sources[file], readSources()[file], 'the plant applies');
  assert.ok(lint(sources).some(f => /latestIntent state closure latest: a counter advanced before admission/.test(f)));
});

test('R12 (B41): a decoy owner word or a guard in another branch is no check; an unlisted transport write fails', () => {
  const file = 'arr/notify/notify-follow.js';
  const planted = readSources()[file].replace('    function syncAll() {', `    async function decoy(operationName, other) {
        await Promise.resolve();
        if (other) { if (!other.current()) return; }
        JE.toast('decoy', operationName);
    }
    function syncAll() {`);
  const site = sitesOf(file, planted).find(s => s.fn === 'decoy' && s.category === 'feedback');
  assert.ok(site);
  assert.equal(site.handed, false, 'an argument named like an owner is not one');
  assert.equal(site.guarded, false, 'a guard in another branch decides nothing about the effect');
  const sources = readSources();
  sources[file] = planted;
  const listed = { ...SITES, [file]: { ...SITES[file], 'decoy feedback toast': [1, 'press', 'effect'] } };
  assert.ok(lint(sources, listed).some(f => /decoy feedback toast.*(no check before it|has no check)/.test(f)));
  const write = readSources();
  write[file] = write[file].replace('    function syncAll() {', "    function plantedWrite() { JE.core.api.plugin('/acquire/requests', { method: 'POST', body: {} }); }\n    function syncAll() {");
  assert.ok(lint(write).some(f => f.startsWith(`${file}: plantedWrite write transport POST /acquire/requests`)));
});
