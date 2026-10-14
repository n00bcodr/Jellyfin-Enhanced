import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHarness, plain } from '../helpers/harness.mjs';
import { repositoryRoot } from '../helpers/discovery.mjs';

// Golden (d), the client fallback, golden (a) on the client, and the C#/JS parity
// checks. The C# side (tests/backend/Core/CoreSettingsDefaultsTests.cs) writes the
// initializers, the legacy served documents, the new-user seed and the public-config
// input these tests feed through config.js. JE_UPDATE_GOLDENS=1 regenerates
// client-fallback.json and client-legacy-files.json after a deliberate change.
const fixtures = resolve(repositoryRoot, 'tests/fixtures/settings');
const fixture = name => JSON.parse(readFileSync(resolve(fixtures, name), 'utf8'));
const legacy = fixture('legacy-partial-files.json');
const initializers = legacy.Initializers;
const seeds = fixture('new-user-seed.json');
const publicConfigs = fixture('public-config-user-defaults.json');
const allowlist = fixture('parity-allowlist.json');
const camel = key => key.charAt(0).toLowerCase() + key.slice(1);
const camelKeys = object => Object.fromEntries(Object.entries(object).map(([key, value]) => [camel(key), value]));
/** The public config a server from before UserSettingDefaults sends (design B3: rolled-back server). */
const withoutBlock = ({ UserSettingDefaults, ...config }) => config;

/** JE.loadSettings from the real config.js, plus the plugin-config keys it read. */
function loadSettings(t, pluginConfig, userSettings = {}) {
  const read = new Set();
  const recorded = new Proxy(pluginConfig, { get(target, key) { if (typeof key === 'string') read.add(key); return target[key]; } });
  const h = createHarness({ JE: { pluginConfig: recorded, userConfig: { settings: userSettings } } });
  t.after(() => h.close());
  h.load('enhanced/config.js');
  return { settings: plain(h.JE.loadSettings()), read };
}

/** Compares with the committed golden, or rewrites it when JE_UPDATE_GOLDENS=1. */
function matchGolden(name, actual) {
  const path = resolve(fixtures, name);
  if (process.env.JE_UPDATE_GOLDENS === '1') writeFileSync(path, JSON.stringify(actual, null, 2) + '\n');
  assert.deepEqual(actual, JSON.parse(readFileSync(path, 'utf8')), `${name} differs (JE_UPDATE_GOLDENS=1 regenerates it after a deliberate change)`);
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
  matchGolden('client-fallback.json', actual);
});

test('client fallback against a server without UserSettingDefaults matches the golden for each admin config', t => {
  // A newer bundle talking to a server from before the block resolves exactly as config.js did
  // before it: the same-named public-config fields and the legacy alias table.
  const actual = {};
  for (const [name, config] of Object.entries(publicConfigs)) {
    assert.ok(Object.hasOwn(config, 'UserSettingDefaults'), `${name}: the backend golden must carry the block`);
    actual[name] = loadSettings(t, withoutBlock(config)).settings;
  }
  matchGolden('client-fallback-legacy-server.json', actual);
});

test('legacy partial files resolve through config.js to the golden for each admin config', t => {
  // The golden holds, per admin config and legacy case, every key config.js resolves to a value other
  // than the one GET settings.json served (the served document camelCased like plugin.js toCamelCase).
  const actual = {};
  const differences = {};
  for (const [configName, config] of Object.entries(publicConfigs)) {
    actual[configName] = {};
    for (const [caseName, { DiffersFromInitializers }] of Object.entries(legacy.Cases)) {
      // The backend test asserts the served document has exactly the initializer keys.
      const served = camelKeys({ ...initializers, ...DiffersFromInitializers });
      const { settings } = loadSettings(t, config, served);
      const keys = differingKeys(settings, served);
      actual[configName][caseName] = Object.fromEntries(keys.map(key => [key, Object.hasOwn(settings, key) ? settings[key] : '(dropped)']));
      differences[`${configName} / ${caseName}`] = keys;
    }
  }
  matchGolden('client-legacy-files.json', actual);
  assertOnlyAllowlistedDrift('ClientLegacyVsServed', differences);
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

test('the admin subtitle text effect is the fallback for selectedTextEffectPresetIndex', t => {
  // Design A9: config.js reads DefaultSubtitleTextEffect like its style, size and font siblings.
  assert.equal(loadSettings(t, { DefaultSubtitleTextEffect: 3 }).settings.selectedTextEffectPresetIndex, 3);
  // A stored choice, including 0, still wins over the admin default.
  assert.equal(loadSettings(t, { DefaultSubtitleTextEffect: 3 }, { selectedTextEffectPresetIndex: 0 }).settings.selectedTextEffectPresetIndex, 0);
  assert.equal(loadSettings(t, {}).settings.selectedTextEffectPresetIndex, 0);
});

test('loadSettings resolves the user value, then UserSettingDefaults, then hardcodedDefaults', t => {
  // Design 7.4 / B3: with the block the plain admin fields are not consulted for registry keys.
  const config = {
    UserSettingDefaults: { SelectedStylePresetIndex: 4, WatchProgressMode: 'time', QualityTagsPosition: 'bottom-left', AutoPauseEnabled: false, ResolutionTagOrder: 6, GenreTagsPosition: null },
    DefaultSubtitleStyle: 1, WatchProgressDefaultMode: 'remaining', QualityTagsPosition: 'top-right', AutoPauseEnabled: true, ResolutionTagOrder: 2,
    GenreTagsPosition: 'bottom-right', QualityTagsPreferredAudioLanguage: 'fra', ShowFileSizes: true,
    DefaultLanguage: 'de', DisableAllShortcuts: true,
  };
  const { settings } = loadSettings(t, config, { selectedStylePresetIndex: 0, autoPauseEnabled: true, resolutionTagOrder: null });
  // A stored value wins, including 0 and a value equal to the plain admin field.
  assert.equal(settings.selectedStylePresetIndex, 0);
  assert.equal(settings.autoPauseEnabled, true);
  // Missing or null in the document: the block, not the plain or aliased admin field.
  assert.equal(settings.resolutionTagOrder, 6);
  assert.equal(settings.watchProgressMode, 'time');
  assert.equal(settings.qualityTagsPosition, 'bottom-left');
  // Missing or null in the block: hardcodedDefaults, not the plain admin field.
  assert.equal(settings.genreTagsPosition, 'top-right');
  assert.equal(settings.showFileSizes, false);
  assert.equal(settings.qualityTagsPreferredAudioLanguage, '');
  // Left out of the block on purpose: read from the plain public-config field.
  assert.equal(settings.displayLanguage, 'de');
  assert.equal(settings.disableAllShortcuts, true);

  // The same config from a server without the block: the plain fields and the alias table.
  const legacy = loadSettings(t, withoutBlock(config), { resolutionTagOrder: null }).settings;
  assert.equal(legacy.selectedStylePresetIndex, 1);
  assert.equal(legacy.watchProgressMode, 'remaining');
  assert.equal(legacy.qualityTagsPosition, 'top-right');
  assert.equal(legacy.resolutionTagOrder, 2);
  assert.equal(legacy.genreTagsPosition, 'bottom-right');
  assert.equal(legacy.showFileSizes, true);
  assert.equal(legacy.qualityTagsPreferredAudioLanguage, 'fra');
  assert.equal(legacy.displayLanguage, 'de');

  // A malformed block is ignored (legacy lookup), and an empty one leaves only hardcodedDefaults.
  assert.equal(loadSettings(t, { ...withoutBlock(config), UserSettingDefaults: [1] }).settings.selectedStylePresetIndex, 1);
  assert.equal(loadSettings(t, { ...withoutBlock(config), UserSettingDefaults: {} }).settings.selectedStylePresetIndex, 0);
});
