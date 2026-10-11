import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHarness, deferred } from '../helpers/harness.mjs';
import { repositoryRoot } from '../helpers/discovery.mjs';

// Design item C2: the admin page's "User settings policy" add-on (js/admin/user-settings-policy.js,
// loaded by Configuration/configPage.html, not part of the bundle). It runs here against the real
// admin page markup (scripts stripped) and the registry route's real answer for a fresh install.

const pagePath = resolve(repositoryRoot, 'Jellyfin.Plugin.JellyfinEnhanced/Configuration/configPage.html');
const pageSource = readFileSync(pagePath, 'utf8');
const pageMarkup = pageSource.slice(pageSource.indexOf('<div class="page'), pageSource.lastIndexOf('</body>'))
  .replace(/<script[\s\S]*?<\/script>/g, '');
const fixture = name => JSON.parse(readFileSync(resolve(repositoryRoot, 'tests/fixtures/settings', name), 'utf8'));
const registryDefault = fixture('admin-registry-default.json');
const lockableKeys = fixture('lockable-keys.json');

/** The page's loader for the policy script (inside its first inline script), as it ships. */
const loaderSource = /\(function \(\) \{\s*function showPolicyLoadFailure\(\)[\s\S]*?\n        \}\)\(\);/.exec(pageSource)?.[0];

/** The page's own save-side lock decision, taken from configPage.html as it ships. */
const applyLocksSource = /function jeApplyUserSettingsLocks\(config\) \{[\s\S]*?\n        \}/.exec(pageSource)?.[0];

function setup(t, { registry = registryDefault, ajax } = {}) {
  const requests = [];
  const h = createHarness({
    html: pageMarkup,
    apiClient: {
      ajax: ajax || (async (request) => { requests.push(request.url); return structuredClone(registry); })
    }
  });
  t.after(() => h.close());
  h.allowConsoleError(/Could not parse CSS stylesheet/);
  const page = h.document.querySelector('#JellyfinEnhancedPage');
  h.load('admin/user-settings-policy.js');
  const policy = h.window.JellyfinEnhancedAdminPolicy;
  const row = key => h.document.getElementById(`jePolicyRow-${key}`);
  const tick = (key, checked = true) => {
    const box = row(key).querySelector('input[type="checkbox"]');
    box.checked = checked;
    box.dispatchEvent(new h.window.Event('change', { bubbles: true }));
  };
  const applyLocks = h.window.eval(`(${applyLocksSource})`);
  return { ...h, page, policy, row, tick, requests, applyLocks };
}

test('every lockable key gets exactly one policy row tied to its admin control, and one badge per control', async t => {
  assert.ok(applyLocksSource, 'jeApplyUserSettingsLocks is in configPage.html');
  const h = setup(t);
  assert.equal(h.policy.ready, false);
  assert.equal(await h.policy.decorate(h.page), true);
  assert.equal(h.policy.ready, true);
  assert.deepEqual(h.requests, ['http://jellyfin.test/JellyfinEnhanced/admin/user-settings/registry']);

  const rows = [...h.document.querySelectorAll('#jeUserSettingsPolicyTable tbody tr[data-setting-key]')];
  assert.deepEqual(rows.map(row => row.dataset.settingKey).sort(), [...lockableKeys].sort());
  for (const entry of registryDefault.filter(e => e.Lockable)) {
    const matches = entry.RowKey
      ? [...h.page.querySelectorAll('[data-order-key]')].filter(el => el.dataset.orderKey === entry.RowKey)
      : [...h.page.querySelectorAll('[id]')].filter(el => el.id === entry.ControlId);
    assert.equal(matches.length, 1, `${entry.Key}: one admin control or row`);
    const link = h.row(entry.Key).querySelector('th a.je-jump-link');
    assert.ok(link, `${entry.Key}: the row links to its control`);
    assert.ok(link.dataset.jumpTab && h.document.getElementById(link.dataset.jumpTab), `${entry.Key}: jumps to a real tab`);
  }
  // Ambiguous admin labels get their tag as context.
  assert.equal(h.row('QualityTagsPosition').querySelector('th').textContent, 'Quality Tags: Position');
  assert.equal(h.row('RatingTagsOnMovies').querySelector('th').textContent, 'Rating Tags: Show on movies');
  assert.equal(h.row('AutoSkipIntro').querySelector('th').textContent.trim(), 'Auto-skip Intro');

  const badges = [...h.page.querySelectorAll('.je-user-default-badge')];
  const anchors = new Set(badges.map(badge => badge.previousElementSibling));
  assert.equal(anchors.size, badges.length, 'one badge per control (a tag row shares one)');
  const qualityBadge = h.page.querySelector('#qualityTagsEnabled').closest('.je-tag-row').nextElementSibling;
  assert.ok(qualityBadge.classList.contains('je-user-default-badge'));
  assert.match(qualityBadge.textContent, /^User default · Web only \(native poster tags are off\) ›$/);
  assert.equal(qualityBadge.querySelector('a[data-jump-target="#nativePosterTagsEnabled"]').dataset.jumpTab, 'display');
  assert.equal(qualityBadge.querySelector('a[aria-label]').dataset.jumpTarget, '#jePolicyRow-QualityTagsEnabled');
  const pipBadge = h.page.querySelector('#autoPipEnabled').closest('.checkboxContainer').nextElementSibling;
  assert.equal(pipBadge.textContent, 'User default · Web only ›');

  // Decorating again (every pageshow) does not duplicate anything.
  await h.policy.decorate(h.page);
  assert.equal(h.document.querySelectorAll('#jeUserSettingsPolicyTable tbody tr[data-setting-key]').length, lockableKeys.length);
  assert.equal(h.page.querySelectorAll('.je-user-default-badge').length, badges.length);
});

test('ticking a lock explains its effect before saving and marks the form changed until saved', async t => {
  const native = registryDefault.map(e => e.Key === 'QualityTagsEnabled' ? { ...e, EffectiveReach: 'Both' } : e);
  const h = setup(t, { registry: native });
  await h.policy.decorate(h.page);
  assert.equal(h.policy.pendingState(), '');
  const impact = h.document.querySelector('#jeUserSettingsPolicyImpact');
  assert.equal(impact.hidden, true);

  h.page.querySelector('#autoPipEnabled').checked = true; // an unsaved admin default goes with the lock
  h.tick('AutoPipEnabled');
  h.tick('QualityTagsEnabled');
  assert.equal(h.policy.pendingState(), 'AutoPipEnabled=true,QualityTagsEnabled=true');
  assert.equal(impact.hidden, false);
  assert.match(impact.textContent, /Locking Auto Picture-in-Picture on tab switch to On: users who chose something else will see On\. Their choice is kept and comes back if you unlock\./);
  assert.match(impact.textContent, /Locking Enable Quality Tags to Off: .*Applies to web overlays and to poster images in native TV and phone apps\./);
  assert.match(h.page.querySelector('#autoPipEnabled').closest('.checkboxContainer').nextElementSibling.textContent, / · Locked ›$/);
  assert.match(h.document.querySelector('#jeUserSettingsPolicySummaryCount').textContent, /2 locked$/);

  h.tick('QualityTagsEnabled', false);
  assert.equal(h.policy.pendingState(), 'AutoPipEnabled=true');
  h.policy.markSaved(['AutoPipEnabled']);
  assert.equal(h.policy.pendingState(), '');
  assert.equal(impact.hidden, true);
});

test('saving locks: fetched minus unticked rendered rows plus ticked ones; unknown keys keep their lock', async t => {
  const locked = registryDefault.map(e => e.Key === 'AutoPipEnabled' || e.Key === 'ShowFileSizes' ? { ...e, Locked: true } : e);
  const h = setup(t, { registry: locked });
  await h.policy.decorate(h.page);
  assert.equal(h.row('AutoPipEnabled').querySelector('input').checked, true);
  h.tick('ShowFileSizes', false);
  h.tick('QualityTagsEnabled');
  // Another admin added a lock since this page loaded, a renamed key lingers, and the case differs.
  const fetched = ['autopipenabled', 'ShowFileSizes', 'NotASetting', 'GenreTagsEnabled'];
  assert.deepEqual(h.policy.applyLocks(fetched).sort(), ['AutoPipEnabled', 'NotASetting', 'QualityTagsEnabled'].sort());
  // GenreTagsEnabled was rendered unticked (it was not locked when the rows were rendered), so it is unlocked.

  const config = { LockedUserSettings: fetched.slice() };
  assert.equal(h.applyLocks(config), true);
  assert.deepEqual(config.LockedUserSettings.sort(), ['AutoPipEnabled', 'NotASetting', 'QualityTagsEnabled'].sort());
});

test('admin save with the policy script blocked, failed or still loading leaves the locks exactly as they were', async t => {
  // Script never loaded (blocked by an extension, 404, no version).
  const blocked = createHarness({ html: pageMarkup });
  t.after(() => blocked.close());
  blocked.allowConsoleError(/Could not parse CSS stylesheet/);
  blocked.allowConsoleError(/user settings policy not ready/);
  const applyBlocked = blocked.window.eval(`(${applyLocksSource})`);
  const warnings = [];
  blocked.window.console.warn = (...args) => warnings.push(args.join(' '));
  const config = { LockedUserSettings: ['AutoPipEnabled', 'NotASetting'], Other: 1 };
  assert.equal(applyBlocked(config), false);
  assert.deepEqual(config, { LockedUserSettings: ['AutoPipEnabled', 'NotASetting'], Other: 1 });
  const status = blocked.document.querySelector('#jeUserSettingsPolicyStatus');
  assert.equal(status.textContent, 'The user settings policy did not load, so this save left the user settings locks as they were.');
  assert.ok(status.classList.contains('je-policy-status-error'));
  assert.match(warnings.join('\n'), /LockedUserSettings left unchanged/);

  // Script loaded but the registry request failed.
  const failed = setup(t, { ajax: async () => { throw new Error('offline'); } });
  failed.window.console.warn = () => {};
  assert.equal(await failed.policy.decorate(failed.page), false);
  assert.equal(failed.policy.ready, false);
  assert.equal(failed.policy.applyLocks(['AutoPipEnabled']), null);
  assert.match(failed.document.querySelector('#jeUserSettingsPolicyStatus').textContent, /could not be loaded.*Saving keeps the current locks/);
  const failedConfig = { LockedUserSettings: ['AutoPipEnabled'] };
  assert.equal(failed.applyLocks(failedConfig), false);
  assert.deepEqual(failedConfig.LockedUserSettings, ['AutoPipEnabled']);

  // Still loading: not ready until the rows are rendered.
  const gate = deferred();
  const loading = setup(t, { ajax: () => gate.promise });
  const pending = loading.policy.decorate(loading.page);
  const loadingConfig = { LockedUserSettings: ['ShowFileSizes'] };
  loading.window.console.warn = () => {};
  assert.equal(loading.applyLocks(loadingConfig), false);
  assert.deepEqual(loadingConfig.LockedUserSettings, ['ShowFileSizes']);
  gate.resolve(structuredClone(registryDefault));
  assert.equal(await pending, true);
});

test('a lock edited while the rows reload (pageshow) is kept; older edits are reset to the server state', async t => {
  let gate = null;
  const h = setup(t, { ajax: async () => { if (gate) await gate.promise; return structuredClone(registryDefault); } });
  await h.policy.decorate(h.page);
  h.tick('ShowFileSizes'); // before the reload: discarded like every other unsaved field
  gate = deferred();
  const reload = h.policy.decorate(h.page);
  assert.equal(h.policy.ready, true, 'rows stay usable while they reload');
  h.tick('AutoPipEnabled'); // during the reload: kept
  gate.resolve();
  await reload;
  assert.equal(h.row('ShowFileSizes').querySelector('input').checked, false);
  assert.equal(h.row('AutoPipEnabled').querySelector('input').checked, true);
  assert.equal(h.policy.pendingState(), 'AutoPipEnabled=true');
});

test('a lock edited while a save is in flight is kept as an unsaved edit after the save', async t => {
  let answer = registryDefault;
  const h = setup(t, { ajax: async () => structuredClone(answer) });
  await h.policy.decorate(h.page);
  h.tick('AutoPipEnabled');
  const saved = h.policy.applyLocks([]); // the save is built from the boxes here
  assert.deepEqual(saved, ['AutoPipEnabled']);
  h.tick('ShowFileSizes'); // ticked while the save is in flight: not part of it
  answer = registryDefault.map(e => e.Key === 'AutoPipEnabled' ? { ...e, Locked: true } : e);
  h.policy.markSaved(saved);
  assert.equal(h.policy.pendingState(), 'ShowFileSizes=true');
  // markSaved reads the registry again and re-renders the rows.
  for (let i = 0; i < 3; i++) await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(h.row('AutoPipEnabled').querySelector('input').checked, true);
  assert.equal(h.row('ShowFileSizes').querySelector('input').checked, true, 'the in-flight edit is not reverted');
  assert.equal(h.policy.pendingState(), 'ShowFileSizes=true');
  assert.match(h.document.querySelector('#jeUserSettingsPolicyImpact').textContent, /^Locking .*Locks take effect when you save\.$/);
  // A pageshow reload still resets edits made before it started.
  await h.policy.decorate(h.page);
  assert.equal(h.row('ShowFileSizes').querySelector('input').checked, false);
  assert.equal(h.policy.pendingState(), '');
});

test('registry values and page labels are written as text, never as markup', async t => {
  const hostile = '<img src=x onerror="window.__pwned=1">';
  const registry = registryDefault.map(e => e.Key === 'DisplayLanguage' ? { ...e, AdminValue: hostile } : e);
  const h = setup(t, { registry });
  h.page.querySelector('#autoPipEnabled').closest('label').querySelector('span').textContent = '<b onclick="x()">Auto PiP</b>';
  await h.policy.decorate(h.page);
  h.tick('AutoPipEnabled');
  const fieldset = h.document.querySelector('#jeUserSettingsPolicy');
  assert.equal(fieldset.querySelector('img'), null);
  assert.equal(fieldset.querySelector('b'), null);
  assert.equal(h.row('DisplayLanguage').children[1].textContent, hostile);
  assert.equal(h.row('AutoPipEnabled').querySelector('th').textContent, '<b onclick="x()">Auto PiP</b>');
  assert.match(fieldset.querySelector('#jeUserSettingsPolicyImpact').textContent, /Locking <b onclick="x\(\)">Auto PiP<\/b> to Off/);
  assert.equal(h.window.__pwned, undefined);
});

test('the page says so when the policy script cannot be loaded, and a later visit tries again', async t => {
  assert.ok(loaderSource, 'the policy loader is in configPage.html');
  const settle = () => new Promise(resolve => setTimeout(resolve, 0));
  const status = h => h.document.querySelector('#jeUserSettingsPolicyStatus');
  const failure = /could not be loaded, so locks cannot be changed right now\. Saving keeps the current locks\./;

  // No client tag and /version fails or answers 'unknown': nothing to load, and the fieldset says so.
  for (const answer of [async () => { throw new Error('offline'); }, async () => ({ ok: true, text: async () => 'unknown' })]) {
    const h = createHarness({ html: pageMarkup, fetch: answer });
    t.after(() => h.close());
    h.allowConsoleError(/Could not parse CSS stylesheet/);
    assert.match(status(h).textContent, /^Loading/);
    h.window.eval(`var jeCssVersion = null; ${loaderSource}`);
    await settle(); await settle();
    assert.match(status(h).textContent, failure);
    assert.ok(status(h).classList.contains('je-policy-status-error'));
    assert.equal(h.document.querySelector('script[data-je-admin-policy]'), null);
  }

  // The script fails to load: the status says so and the failed element is removed, so the next
  // visit (the page's inline script runs again with a new view) adds a fresh one.
  const h = createHarness({ html: pageMarkup,
    apiClient: { getUrl: (path, params) => `http://jellyfin.test${path}${params ? '?' + new URLSearchParams(params) : ''}` } });
  t.after(() => h.close());
  h.allowConsoleError(/Could not parse CSS stylesheet/);
  h.window.eval(`var jeCssVersion = '1.2.3'; ${loaderSource}`);
  const first = h.document.querySelector('script[data-je-admin-policy="1.2.3"]');
  assert.match(first.getAttribute('src'), /\/JellyfinEnhanced\/js\/admin\/user-settings-policy\.js\?v=1\.2\.3$/);
  first.onerror();
  assert.equal(first.isConnected, false);
  assert.match(status(h).textContent, failure);
  h.window.eval(`var jeCssVersion = '1.2.3'; ${loaderSource}`);
  const second = h.document.querySelector('script[data-je-admin-policy="1.2.3"]');
  assert.ok(second && second !== first, 'retried');
  // While one is loading (or loaded), another visit does not add a second copy.
  h.window.eval(`var jeCssVersion = '1.2.3'; ${loaderSource}`);
  assert.equal(h.document.querySelectorAll('script[data-je-admin-policy]').length, 1);
});
