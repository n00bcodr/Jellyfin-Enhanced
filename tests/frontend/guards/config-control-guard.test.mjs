// C1: every settable PluginConfiguration property has a control on the admin configuration page
// (config-control.mjs). Ratcheted by config-control-guard-baseline.json. Adapted from Jellyfin Canopy's
// Tests/Configuration/ConfigControlCoverageTests.cs (GPL-3.0).
import test from 'node:test';
import assert from 'node:assert/strict';
import { guard } from './guards.mjs';
import { clientProject } from './lib.mjs';
import { CONFIG_FILE, settableProperties } from './config-control.mjs';
import { assertPlantedFails, assertRatchet, scanPlanted } from './harness.mjs';

const g = guard('config-control-guard');

test('C1: no new configuration property without an admin-page control (ratchet)', t => {
  assertRatchet(t, g, g.scan(clientProject()));
});

test('C1: the C# reader finds the PluginConfiguration properties', () => {
  const properties = settableProperties(clientProject().read(CONFIG_FILE));
  assert.ok(properties.length > 300, `only ${properties.length} properties read from ${CONFIG_FILE}`);
  for (const name of ['ToastDuration', 'TMDB_API_KEY', 'MaintenanceModeEnabled']) assert.ok(properties.includes(name), name);
});

const CSHARP = `
  public class Shortcut { public string Name { get; set; } = string.Empty; }
  public class PluginConfiguration : BasePluginConfiguration
  {
      public PluginConfiguration() { Foo = true; }
      public bool Foo { get; set; }
      // public bool Commented { get; set; }
      public string Bar { get; set; } = "";
      public bool Baz => Foo;
      private int Hidden { get; set; }
      public List<string> Things() { var x = new { A = 1 }; return new(); }
  }`;

test('C1 self-test: a property no admin source names or writes fails', () => {
  assert.deepEqual(settableProperties(CSHARP), ['Bar', 'Foo']);
  const v = scanPlanted(g, {
    'client/src/admin/config/sections/planted.ts': "export const FIELDS = [{ id: 'foo', prop: 'Foo', type: 'toggle' }];",
    'client/src/features/planted/planted.ts': "export const notAdmin = { Bar: 1 };",
  }, CSHARP);
  assertPlantedFails(g, v, ['C1-no-control Bar'], CONFIG_FILE);
  assert.ok(!v.some(x => x.key === 'C1-no-control Foo'), 'Foo has a control');
});

test('C1 self-test: a property written by the page (config.X = …) passes', () => {
  const v = scanPlanted(g, {
    'client/src/admin/config/page/planted.ts': "export function save(config: Record<string, unknown>) { config.Bar = 1; return { Foo: true }; }",
  }, CSHARP);
  assert.deepEqual(v, []);
});
