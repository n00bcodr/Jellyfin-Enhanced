// One JE/Seerr capability model on the configuration page (UX-4, UX-5, UX-6): settings that work with Seerr or with
// Jellyfin Enhanced handling requests live once under the *arr tab's "Requests & discovery" and are gated on what they
// really need, the Seerr tab links to them; with Seerr off, the Seerr Recommendations page settings and the advanced
// Seerr operations are disabled with a short hint and their stored values are saved back unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import { configPage } from '../helpers/config-page.mjs';

const JE_REQUESTS = { ArrIntegrationEnabled: true, ArrPhase1Enabled: true, ArrPhase3Enabled: true, ArrRequestBackend: 'je' };
const SEERR_ON = { JellyseerrEnabled: true, JellyseerrUrls: 'http://seerr.test:5055', JellyseerrApiKey: 'seerr-key' };
// One usable Sonarr, so the *arr tab's own "add a Sonarr/Radarr" gate doesn't hide what is tested here.
const SONARR = { SonarrInstances: JSON.stringify([{ Id: 's1', Name: 'Sonarr', Url: 'http://sonarr.test:8989', ApiKey: 'sonarr-key', Enabled: true }]) };
const MOVED = ['nativeAbsentDetailsEnabled', 'jellyseerrSingleSeasonRequestOnly', 'autoSeasonRequestEnabled', 'autoMovieRequestEnabled'];
const SEERR_ONLY = ['recommendationsPageEnabled', 'importSonarrFromSeerr', 'importRadarrFromSeerr', 'arrSeerrMigrationBtn', 'arrSeerrModalStatus', 'arrSeerrRefreshMinutes'];
// Stored values the Seerr-only controls hold, which a save while Seerr is off must keep.
const STORED = { RecommendationsPageEnabled: true, RecommendationsUseNativeTab: true, ArrSeerrModalStatus: true, ArrSeerrRefreshMinutes: 7 };

async function open(t, config) {
  const page = configPage(t, { config });
  await page.pageshow();
  return page;
}

test('UX-4: with Seerr off and Jellyfin Enhanced handling requests (TMDB key set), the shared request and discovery settings are configurable, once, under Requests & discovery', async t => {
  const page = await open(t, { ...JE_REQUESTS, JellyseerrEnabled: false, TMDB_API_KEY: 'tmdb-key', ...STORED });
  const section = page.$('#requestsDiscoverySection');
  assert.ok(section, 'the Requests & discovery fieldset');
  assert.ok(section.closest('#arr'), 'on the *arr tab');
  for (const id of MOVED) {
    assert.equal(page.document.querySelectorAll('#' + id).length, 1, `${id}: one setting`);
    assert.ok(section.contains(page.$('#' + id)), `${id} under Requests & discovery`);
    assert.equal(page.$('#' + id).disabled, false, `${id} configurable without Seerr`);
  }
  // The Seerr tab keeps links to them, not copies, and they work while the rest of the tab waits for Seerr.
  const links = [...page.document.querySelectorAll('#seerr .je-moved-setting a.je-jump-link')];
  assert.deepEqual(links.map(a => [a.dataset.jumpTab, a.dataset.jumpTarget]).sort(),
    [['arr', '#autoSeasonRequestEnabled'], ['arr', '#jellyseerrSingleSeasonRequestOnly'], ['arr', '#nativeAbsentDetailsEnabled']]);
  assert.equal(page.document.querySelectorAll('#seerr input[id="nativeAbsentDetailsEnabled"], #seerr input[id^="autoSeasonRequest"], #seerr input[id^="autoMovieRequest"]').length, 0);
  // Saving keeps them as one stored setting each.
  page.choose('#nativeAbsentDetailsEnabled', true);
  page.choose('#autoSeasonRequestEnabled', true);
  const saved = await page.save();
  assert.equal(saved.NativeAbsentDetailsEnabled, true);
  assert.equal(saved.AutoSeasonRequestEnabled, true);
});

test('UX-4: each shared setting is gated on what it needs; with neither Seerr nor Jellyfin Enhanced requests they wait with a hint', async t => {
  const page = await open(t, { JellyseerrEnabled: false, ArrRequestBackend: 'seerr', NativeAbsentDetailsEnabled: true });
  for (const id of MOVED) {
    const input = page.$('#' + id);
    assert.equal(input.disabled, true, `${id} waits`);
    assert.match(input.closest('.checkboxContainer').textContent, /Needs/, `${id} says what it needs`);
  }
  assert.equal(page.$('#nativeAbsentDetailsEnabled').checked, true, 'the stored value is shown as it is');
  // Jellyfin Enhanced requests on without a TMDB key: the single-season rule works (JE's request sheet); TMDB-backed ones still wait.
  page.choose('#arrIntegrationEnabled', true); page.choose('#arrPhase1Enabled', true); page.choose('#arrPhase3Enabled', true);
  page.choose('#arrRequestBackend', 'je');
  await page.flush();
  assert.equal(page.$('#jellyseerrSingleSeasonRequestOnly').disabled, false);
  for (const id of ['nativeAbsentDetailsEnabled', 'autoSeasonRequestEnabled', 'autoMovieRequestEnabled']) assert.equal(page.$('#' + id).disabled, true, id);
  // Seerr set up (Seerr handling requests): everything is configurable, as before.
  page.choose('#arrRequestBackend', 'seerr');
  page.choose('#TMDB_API_KEY', 'tmdb-key');
  page.choose('#jellyseerrUrls', SEERR_ON.JellyseerrUrls);
  page.choose('#JellyseerrApiKey', SEERR_ON.JellyseerrApiKey);
  page.choose('#jellyseerrEnabled', true);
  await page.flush();
  for (const id of MOVED) assert.equal(page.$('#' + id).disabled, false, `${id} with Seerr`);
});

test('UX-5/UX-6: with Seerr off, the Seerr Recommendations page and the advanced Seerr operations are disabled with a hint, Seerr setup stays, and stored values save back unchanged', async t => {
  const page = await open(t, { ...JE_REQUESTS, ...SONARR, JellyseerrEnabled: false, TMDB_API_KEY: 'tmdb-key', ...STORED });
  for (const id of SEERR_ONLY) assert.equal(page.$('#' + id).disabled, true, `${id} disabled`);
  assert.equal(page.$('#recommendationsUseNativeTab').disabled, true);
  assert.match(page.$('#recommendationsPageEnabled').closest('.checkboxContainer').textContent, /Seerr is off/);
  assert.match(page.$('#importSonarrFromSeerr').closest('.je-arr-action-row').nextElementSibling.textContent, /Seerr is off/);
  // Seerr's own connection setup stays available.
  for (const id of ['jellyseerrEnabled', 'jellyseerrUrls', 'JellyseerrApiKey']) assert.equal(page.$('#' + id).disabled, false, id);
  // The Requests page help no longer says it needs Seerr whatever handles requests.
  assert.doesNotMatch(page.$('[data-desc-for="arrRequestsHubEnabled"]').textContent, /shows nothing until Seerr is set up/);
  assert.match(page.$('[data-desc-for="arrRequestsHubEnabled"]').textContent, /Seerr isn't needed/);
  const saved = await page.save();
  for (const [field, value] of Object.entries(STORED)) assert.equal(saved[field], value, `${field} kept`);
});

test('UX-5/UX-6 control: with Seerr on, the Seerr-only settings and operations are available again (subject to their own switches)', async t => {
  const page = await open(t, { ...JE_REQUESTS, ...SEERR_ON, ...SONARR, ArrRequestBackend: 'seerr', TMDB_API_KEY: 'tmdb-key', ...STORED });
  for (const id of SEERR_ONLY) {
    assert.equal(page.$('#' + id).disabled, false, `${id} available with Seerr`);
    assert.doesNotMatch((page.$('#' + id).closest('.checkboxContainer, .inputContainer') || page.$('#' + id).closest('.je-arr-action-row').parentElement).textContent, /Seerr is off/);
  }
  // Turning Seerr off disables them at once; turning it back on restores them.
  page.choose('#jellyseerrEnabled', false);
  await page.flush();
  for (const id of SEERR_ONLY) assert.equal(page.$('#' + id).disabled, true, `${id} off with Seerr`);
  page.choose('#jellyseerrEnabled', true);
  await page.flush();
  for (const id of SEERR_ONLY) assert.equal(page.$('#' + id).disabled, false, `${id} back with Seerr`);
});
