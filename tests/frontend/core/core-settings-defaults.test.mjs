import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHarness, plain } from '../helpers/harness.mjs';
import { repositoryRoot } from '../helpers/discovery.mjs';

// Golden (d), the client fallback, and the C#/JS parity checks. The C# side
// (tests/backend/Core/CoreSettingsDefaultsTests.cs) writes the initializers, the
// new-user seed and the public-config input these tests feed through config.js.
// JE_UPDATE_GOLDENS=1 regenerates client-fallback.json after a deliberate change.
const fixtures = resolve(repositoryRoot, 'tests/fixtures/settings');
const fixture = name => JSON.parse(readFileSync(resolve(fixtures, name), 'utf8'));
const initializers = fixture('legacy-partial-files.json').Initializers;
const seeds = fixture('new-user-seed.json');
const publicConfigs = fixture('public-config-user-defaults.json');
const allowlist = fixture('parity-allowlist.json');
const camel = key => key.charAt(0).toLowerCase() + key.slice(1);
const camelKeys = object => Object.fromEntries(Object.entries(object).map(([key, value]) => [camel(key), value]));

/** JE.loadSettings from the real config.js, plus the plugin-config keys it read. */
function loadSettings(t, pluginConfig, userSettings = {}) {
  const read = new Set();
  const recorded = new Proxy(pluginConfig, { get(target, key) { if (typeof key === 'string') read.add(key); return target[key]; } });
  const h = createHarness({ JE: { pluginConfig: recorded, userConfig: { settings: userSettings } } });
  t.after(() => h.close());
  h.load('enhanced/config.js');
  return { settings: plain(h.JE.loadSettings()), read };
}

/** Keys whose values differ between two flat settings objects (a key missing on one side differs). */
function differingKeys(left, right) {
  return [...new Set([...Object.keys(left), ...Object.keys(right)])]
    .filter(key => !Object.hasOwn(left, key) || !Object.hasOwn(right, key) || !Object.is(left[key], right[key]));
}

/** Every difference must be on the named allowlist, and every allowlist entry must still be a difference. */
function assertOnlyAllowlistedDrift(listName, differencesByCase) {
  const allowed = new Set(Object.keys(allowlist[listName]).map(camel));
  const seen = new Set();
  for (const [name, keys] of Object.entries(differencesByCase)) {
    for (const key of keys) {
      assert.ok(allowed.has(key), `${name}: ${key} differs but is not on the ${listName} allowlist`);
      seen.add(key);
    }
  }
  assert.deepEqual([...allowed].filter(key => !seen.has(key)), [], `${listName} lists drift that no longer exists; remove it with its fix`);
}

test('client fallback with no settings document matches the golden for each admin config', t => {
  const userKeys = new Set(Object.keys(initializers));
  const actual = {};
  for (const [name, config] of Object.entries(publicConfigs)) {
    const { settings, read } = loadSettings(t, config);
    actual[name] = settings;
    // The C# side copies only UserSettings names and its alias list out of the public config;
    // any other server key config.js starts reading must be added to that list first.
    const uncovered = [...read].filter(key => /^[A-Z]/.test(key) && !userKeys.has(key) && !Object.hasOwn(config, key));
    assert.deepEqual(uncovered, [], `${name}: config.js reads public-config keys missing from public-config-user-defaults.json`);
  }
  const path = resolve(fixtures, 'client-fallback.json');
  if (process.env.JE_UPDATE_GOLDENS === '1') writeFileSync(path, JSON.stringify(actual, null, 2) + '\n');
  assert.deepEqual(actual, JSON.parse(readFileSync(path, 'utf8')), 'client-fallback.json differs (JE_UPDATE_GOLDENS=1 regenerates it after a deliberate change)');
});

test('JS hardcoded defaults match the C# initializers apart from the allowlisted drift', t => {
  const { settings } = loadSettings(t, {});
  assertOnlyAllowlistedDrift('JsDefaultsVsInitializers', { 'empty plugin config': differingKeys(settings, camelKeys(initializers)) });
});

test('client fallback matches the new-user seed apart from the allowlisted drift', t => {
  const differences = {};
  for (const [name, config] of Object.entries(publicConfigs)) {
    differences[name] = differingKeys(loadSettings(t, config).settings, camelKeys(seeds[name]));
  }
  assertOnlyAllowlistedDrift('ClientFallbackVsSeed', differences);
});

test('a newly seeded user resolves to the seed apart from the allowlisted drift', t => {
  const differences = {};
  for (const [name, config] of Object.entries(publicConfigs)) {
    const seed = camelKeys(seeds[name]);
    differences[name] = differingKeys(loadSettings(t, config, seed).settings, seed);
  }
  assertOnlyAllowlistedDrift('ClientSeededVsSeed', differences);
});
