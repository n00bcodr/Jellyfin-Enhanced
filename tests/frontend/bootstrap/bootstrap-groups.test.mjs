import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from '../helpers/harness.mjs';
import { everythingOnConfig, groupClosure, manifestModules, rawGroups, recordEvalReads, resolveGroups } from '../helpers/eval-reads.mjs';

// js/component-groups.json splits the manifest into groups that load on demand (plugin.js,
// Services/ClientScriptBundle.cs). These tests keep the split sound: the file is well formed, the
// loader's rules and the file agree, and every group still loads correctly when it runs with only
// the groups it is "after", later than it does in the single bundle.

const manifest = manifestModules();
const groups = resolveGroups();
const byId = new Map(groups.map(group => [group.id, group]));
const scriptsOf = ids => ids.flatMap(id => byId.get(id).scripts);

/** plugin.js's own description of its rules, read from a real evaluation of the loader. */
function loaderCatalog(t) {
  // Signed out: the loader defines its catalog and then only waits for a user.
  const h = createHarness({ html: '<script plugin="Jellyfin Enhanced" version="1.0.0-test"></script>', apiClient: { getCurrentUserId: () => null, ajax: async () => ({}) } });
  t.after(() => h.close());
  h.load('plugin.js');
  return h.window.JellyfinEnhanced.loader.catalog();
}

test('the groups file is well formed and lists modules in manifest order', () => {
  const position = new Map(manifest.map((path, index) => [path, index]));
  const seen = new Set(['core']);
  const owner = new Map();
  for (const group of rawGroups()) {
    assert.match(group.id, /^[a-z][a-z0-9-]{0,39}$/, `group id ${group.id}`);
    assert.ok(!seen.has(group.id), `group ${group.id} is defined twice`);
    for (const dependency of group.after || []) assert.ok(seen.has(dependency), `${group.id} is after ${dependency}, which is not an earlier group`);
    seen.add(group.id);
    assert.ok(typeof group.note === 'string' && group.note.length > 10, `${group.id} has no note saying what it is and when it loads`);
    assert.ok(group.modules.length > 0, `${group.id} lists no modules`);
    for (const path of group.modules) {
      assert.ok(position.has(path), `${group.id} lists ${path}, which is not in component-scripts.json`);
      assert.ok(!owner.has(path), `${path} is in ${owner.get(path)} and ${group.id}`);
      owner.set(path, group.id);
    }
    assert.deepEqual(group.modules, [...group.modules].sort((a, b) => position.get(a) - position.get(b)), `${group.id} modules are not in manifest order`);
  }
  assert.ok(byId.get('core').scripts.length > 0);
  assert.deepEqual([...groups.flatMap(group => group.scripts)].sort(), [...manifest].sort());
});

test('every group has a loading rule, and every rule and initializer names a real group', t => {
  const catalog = loaderCatalog(t);
  const ruled = catalog.groups.map(group => group.id);
  const lazy = groups.map(group => group.id).filter(id => id !== 'core');
  assert.deepEqual([...ruled].sort(), [...lazy].sort(), 'FEATURE_GROUPS in plugin.js and js/component-groups.json must name the same groups');
  for (const { group, path } of catalog.initializers) assert.ok(byId.has(group), `initializer ${path} names unknown group ${group}`);
  for (const page of catalog.pages) assert.ok(byId.has(page.group), `page ${page.group} is not a group`);
});

test('each stage-6 initializer and lazy export is defined by a module of its own group', async t => {
  const catalog = loaderCatalog(t);
  const wanted = new Map();
  for (const { group, path } of catalog.initializers) wanted.set(path, group);
  for (const group of catalog.groups) for (const path of group.exports) wanted.set(path, group.id);
  // The check is the same recording the ordering test uses: which module wrote the path.
  const { records, failures } = await recordEvalReads(manifest, { pluginConfig: everythingOnConfig() });
  assert.deepEqual(failures.filter(failure => !failure.startsWith('teardown')), []);
  const writer = new Map();
  for (const [module, record] of records) for (const path of record.writes) if (!writer.has(path)) writer.set(path, module);
  const moduleGroup = new Map(groups.flatMap(group => group.scripts.map(path => [path, group.id])));
  const problems = [];
  for (const [path, group] of wanted) {
    // spoilerBlur.init and friends are members of an object literal: the object is what gets assigned.
    const parts = path.split('.');
    let definedBy;
    for (let length = parts.length; length > 0 && !definedBy; length--) definedBy = writer.get(parts.slice(0, length).join('.'));
    if (!definedBy) problems.push(`${path}: no module defines it`);
    else if (moduleGroup.get(definedBy) !== group) problems.push(`${path}: defined by ${definedBy} (group ${moduleGroup.get(definedBy)}), listed under ${group}`);
  }
  assert.deepEqual(problems, []);
});

// A module reads other modules' exports while it loads (`const kit = JE.core.ui`). In the single
// bundle every module ran in manifest order. Split into groups, a module can run without groups
// it is not "after", and after modules that used to follow it. Either changes what such a read
// finds: something it relied on is missing, or something that was not there yet now is.
// This records what every module's top level reads in manifest order, then loads each group with
// only what it is "after" (in the order the loader runs them) and requires the same reads to find
// the same things. A difference is a missing "after", or a module in the wrong group.
const KNOWN_DIFFERENCES = new Map([
  // The tag preview builds its stylesheet from the awards chips' CSS when that module has run.
  // In the single bundle it had not (awardstags.js is later in the manifest), so the preview
  // sheet lacked those rules; the settings group loads after the tags, so now it has them.
  ['enhanced/settingspanel/ui-panel-tag-preview.js', new Set(['awardsTags', 'awardsTags.CSS'])]
]);

for (const [label, pluginConfig] of [['every feature on', everythingOnConfig], ['every feature off', () => ({})]]) {
  test(`each group's modules read the same exports at load time as in the single bundle (${label})`, async () => {
    const baseline = await recordEvalReads(manifest, { pluginConfig: pluginConfig() });
    const problems = [];
    const runs = groups.filter(group => group.id !== 'core').map(group => groupClosure(groups, [group.id]));
    runs.push(['core'], groups.map(group => group.id));
    for (const ids of runs) {
      const order = scriptsOf(ids);
      const { records, failures } = await recordEvalReads(order, { pluginConfig: pluginConfig() });
      for (const failure of failures) if (!failure.startsWith('teardown')) problems.push(`[${ids.join(',')}] ${failure}`);
      for (const module of order) {
        const before = baseline.records.get(module);
        const after = records.get(module);
        const allowed = KNOWN_DIFFERENCES.get(module) || new Set();
        for (const path of new Set([...before.reads.keys(), ...after.reads.keys()])) {
          if (allowed.has(path)) continue;
          const was = before.reads.get(path);
          const is = after.reads.get(path);
          // A path a module assigns itself (`JE.x = JE.x || {}`) is its own namespace, not a dependency.
          if (before.touched.has(path) || after.touched.has(path)) continue;
          if (!was || !is) continue; // only read on one side: follows from another difference, reported there
          if (was.defined !== is.defined) problems.push(`[${ids.join(',')}] ${module} reads JE.${path}: ${was.defined ? `set by ${was.by ?? 'the loader'} in the single bundle, missing here` : 'not set yet in the single bundle, set here'}`);
        }
      }
    }
    assert.deepEqual([...new Set(problems)], []);
  });
}
