import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from '@babel/parser';
import { createHarness } from '../../helpers/harness.mjs';
import { repositoryRoot } from '../../helpers/discovery.mjs';

// Admin config page gating of the List Placeholders settings (review r1 F62/F63). The page's inline script needs
// the whole Jellyfin dashboard to run, so the real dependency functions and rule tables are taken from it and
// evaluated against the page's own markup.

const PAGE = readFileSync(resolve(repositoryRoot, 'Jellyfin.Plugin.JellyfinEnhanced/Configuration/configPage.html'), 'utf8');
const NAMES = ['hasAtLeastOneValidSeerrUrl', 'hasJellyseerrConfigured', 'hasAnyArrService', 'hasTmdbKey', 'isMetadataIconsEnabled',
  'SECTION_DEPS', 'INDIVIDUAL_DEPS', 'PARENT_DEPS', 'addDepTag', 'removeDepTag', 'createDepBanner',
  'updateSectionDep', 'updateIndividualDep', 'updateParentDep', 'renderFeaturesDashboard'];

/** Source of each named top-level function or `var` of the page's main inline script. */
function extractSources(script) {
  const ast = parse(script, { sourceType: 'script', errorRecovery: true });
  const found = new Map();
  (function walk(node) {
    if (!node || typeof node.type !== 'string') return;
    if (node.type === 'FunctionDeclaration' && NAMES.includes(node.id?.name) && !found.has(node.id.name)) {
      found.set(node.id.name, script.slice(node.start, node.end));
      return;
    }
    if (node.type === 'VariableDeclaration' && node.declarations.length === 1 && NAMES.includes(node.declarations[0].id?.name)
      && !found.has(node.declarations[0].id.name)) {
      found.set(node.declarations[0].id.name, script.slice(node.start, node.end));
      return;
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value.type === 'string') walk(value);
    }
  })(ast.program);
  for (const name of NAMES) assert.ok(found.has(name), `configPage.html no longer defines ${name}`);
  return NAMES.map(name => found.get(name));
}

function setup(t) {
  const body = PAGE.slice(PAGE.indexOf('<body'), PAGE.lastIndexOf('</body>'));
  const h = createHarness({ html: body.slice(body.indexOf('>') + 1) });
  t.after(() => h.close());
  const scripts = h.document.querySelectorAll('script');
  const sources = extractSources(scripts[scripts.length - 1].textContent);
  const page = h.window.eval(`(function () {
    var hasIntroSkipper = true, hasPluginPages = true, hasCustomTabs = true, isJellyfin12 = true;
    ${sources.join('\n')}
    return { SECTION_DEPS, INDIVIDUAL_DEPS, PARENT_DEPS, updateSectionDep, updateIndividualDep, updateParentDep, renderFeaturesDashboard };
  })()`);
  const $ = id => h.document.getElementById(id);
  /** Same order as the page's updateAllDependencies. */
  const update = () => {
    page.SECTION_DEPS.forEach(page.updateSectionDep);
    page.INDIVIDUAL_DEPS.forEach(page.updateIndividualDep);
    page.PARENT_DEPS.forEach(page.updateParentDep);
  };
  const configureSeerr = () => {
    $('jellyseerrEnabled').checked = true;
    $('jellyseerrUrls').value = 'http://seerr.test:5055';
    $('JellyseerrApiKey').value = 'key';
  };
  return { ...h, page, $, update, configureSeerr };
}

test('List Placeholders settings stay editable without Seerr; only the Seerr-only options are gated (F62)', t => {
  const { $, update, configureSeerr, document } = setup(t);
  update();
  // Unrelated Seerr settings are still gated.
  assert.equal($('jellyseerrShowCollectionDiscovery').disabled, true);
  assert.equal($('listPlaceholdersAutoRequestEnabled').disabled, true, 'auto-requests need Seerr');

  assert.equal($('listPlaceholdersEnabled').disabled, false, 'the feature works without Seerr (custom entries, *arr adds)');
  const fieldset = $('listPlaceholdersEnabled').closest('fieldset');
  assert.equal(fieldset.querySelector('.je-dep-banner:not(.je-hidden)'), null, 'no "Enable Seerr" banner over the whole section');

  $('listPlaceholdersEnabled').checked = true;
  update();
  assert.equal($('listPlaceholdersArrEnabled').disabled, false);
  assert.equal($('listPlaceholdersPosterCollage').disabled, false);
  for (const id of ['listPlaceholdersImdbEnabled', 'traktClientId']) {
    assert.equal($(id).disabled, true, `${id} needs Seerr (list import)`);
  }
  // R5-15: the scheduled sync works without Seerr for Chronolists links (other sources report seerr_unavailable).
  assert.equal($('listPlaceholdersSyncEnabled').disabled, false, 'sync is not gated on Seerr');
  assert.doesNotMatch($('listPlaceholdersSyncEnabled').closest('label').textContent, /Set up Seerr/);
  const traktLabel = document.querySelector('label[for="traktClientId"]');
  assert.match(traktLabel.textContent, /Seerr/, 'the Trakt field says why it is disabled');

  configureSeerr();
  update();
  for (const id of ['listPlaceholdersSyncEnabled', 'listPlaceholdersImdbEnabled', 'traktClientId', 'listPlaceholdersAutoRequestEnabled', 'jellyseerrShowCollectionDiscovery']) {
    assert.equal($(id).disabled, false, `${id} enabled once Seerr is configured`);
  }
  assert.doesNotMatch(traktLabel.textContent, /Seerr/);

  // The parent toggle still gates its options.
  $('listPlaceholdersEnabled').checked = false;
  update();
  for (const id of ['listPlaceholdersArrEnabled', 'listPlaceholdersSyncEnabled', 'traktClientId', 'listPlaceholdersPosterCollage']) {
    assert.equal($(id).disabled, true, `${id} needs the List Placeholders toggle`);
  }
});

test('"Add placeholders to *arr" warns when only disabled *arr instances are configured (F63)', t => {
  const { $, page, document } = setup(t);
  $('listPlaceholdersEnabled').checked = true;
  $('listPlaceholdersArrEnabled').checked = true;
  $('radarrInstancesList').innerHTML = `<details class="arr-instance-card">
    <input class="arr-instance-enabled" type="checkbox"><input class="arr-instance-url" value="http://radarr.test:7878">
    <input class="arr-instance-apikey" value="key"></details>`;
  const row = () => [...document.querySelectorAll('#je-features-dashboard .je-feature-row')]
    .find(r => r.querySelector('.je-feature-name').textContent === 'Add placeholders to *arr');

  page.renderFeaturesDashboard();
  assert.ok(row().classList.contains('je-state-warn'), 'a disabled instance is not used for *arr adds');
  assert.equal(row().querySelector('.je-feature-detail').textContent, 'Enabled but no *arr instance is configured');

  document.querySelector('.arr-instance-enabled').checked = true;
  page.renderFeaturesDashboard();
  assert.ok(row().classList.contains('je-state-on'));
});
