import test from 'node:test';
import assert from 'node:assert/strict';
import { bootGenerated, settle } from '../../helpers/admin-config-page.mjs';

// Saves of the settings page against what is stored: a list that did not load is unknown, not empty.

const USER_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const USER_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const failed = () => Promise.reject(Object.assign(new Error('Bad Gateway'), { status: 502 }));
const pending = () => new Promise(() => {});

/** The generated page, loaded from `saved`, with `answers` replying to the requests whose URL they match. */
async function page(t, { saved = {}, answers = [] } = {}) {
  const h = bootGenerated({ saved, ajax: r => answers.find(([pattern]) => pattern.test(r.url))?.[1](r) });
  t.after(() => h.close());
  await h.ready();
  h.show();
  await settle(h.window, 60);
  h.submit = async () => {
    h.document.querySelector('#JellyfinEnhancedForm').dispatchEvent(new h.window.Event('submit', { bubbles: true, cancelable: true }));
    await settle(h.window, 120);
  };
  h.lastPut = () => h.calls.puts.at(-1);
  h.posted = path => h.calls.ajax.filter(r => r.type === 'POST' && new URL(r.url).pathname === path).map(r => JSON.parse(r.data));
  return h;
}

const selectedMaintenance = { MaintenanceModeEnabled: true, MaintenanceModeAction: 'disable_accounts', MaintenanceModeAffectedUsers: JSON.stringify([USER_A]) };

for (const [what, answer] of [['failed to load', failed], ['has not answered yet', pending]]) {
  test(`with the maintenance user list that ${what}, a save keeps the stored selection and maintenance keeps its targets`, async t => {
    const h = await page(t, { saved: selectedMaintenance, answers: [[/MaintenanceMode\/Users/, answer]] });
    assert.equal(h.document.getElementById('mmUsers_select').checked, true, 'the page shows "Select specific users"');
    assert.equal(h.document.querySelectorAll('.je-mm-user-cb').length, 0, 'no user boxes to read');
    await h.submit();
    assert.equal(h.calls.puts.length, 1);
    assert.equal(h.lastPut().MaintenanceModeAffectedUsers, JSON.stringify([USER_A]), 'not "[]", which means every non-administrator');
    assert.deepEqual(h.posted('/JellyfinEnhanced/MaintenanceMode/Enable').map(b => b.affectedUserIds), [[USER_A]]);
  });
}

test('control: with the user list loaded, a save stores the users ticked', async t => {
  const users = [{ id: USER_A, username: 'child', hasImage: false }, { id: USER_B, username: 'guest', hasImage: false }];
  const h = await page(t, { saved: selectedMaintenance, answers: [[/MaintenanceMode\/Users/, () => users]] });
  assert.deepEqual([...h.document.querySelectorAll('.je-mm-user-cb')].map(cb => [cb.value, cb.checked]), [[USER_A, true], [USER_B, false]]);
  h.document.querySelector(`.je-mm-user-cb[value="${USER_B}"]`).checked = true;
  h.document.querySelector(`.je-mm-user-cb[value="${USER_A}"]`).checked = false;
  await h.submit();
  assert.equal(h.lastPut().MaintenanceModeAffectedUsers, JSON.stringify([USER_B]));
  assert.deepEqual(h.posted('/JellyfinEnhanced/MaintenanceMode/Enable').map(b => b.affectedUserIds), [[USER_B]]);
});

const customMovieRequests = {
  AutoMovieRequestEnabled: true, AutoMovieRequestQualityMode: 'custom',
  AutoMovieRequestCustomServerId: 2, AutoMovieRequestCustomProfileId: 7, AutoMovieRequestCustomRootFolder: '/movies4k',
};
const radarrServers = () => [{ id: 0, name: 'Radarr', is4k: false }, { id: 2, name: 'Radarr 4K', is4k: true }];
const radarrDetails = () => ({ profiles: [{ id: 7, name: 'UHD' }, { id: 8, name: 'HD' }], rootFolders: [{ path: '/movies' }, { path: '/movies4k' }] });
const autoMovie = put => [put.AutoMovieRequestCustomServerId, put.AutoMovieRequestCustomProfileId, put.AutoMovieRequestCustomRootFolder];

for (const [what, saved, answers] of [
  ['Seerr\'s server list failed', customMovieRequests, [[/jellyseerr\/radarr$/, failed]]],
  ['Seerr\'s server list has not answered', customMovieRequests, [[/jellyseerr\/radarr$/, pending]]],
  ['the server\'s profiles and folders failed', customMovieRequests, [[/jellyseerr\/radarr$/, radarrServers], [/jellyseerr\/radarr\/2$/, failed]]],
  ['the mode is not "Custom", so nothing was loaded', { ...customMovieRequests, AutoMovieRequestQualityMode: 'default' }, []],
]) {
  test(`when ${what}, a save keeps the stored automatic-request server, profile and folder`, async t => {
    const h = await page(t, { saved, answers });
    await h.submit();
    assert.equal(h.calls.puts.length, 1);
    assert.deepEqual(autoMovie(h.lastPut()), [2, 7, '/movies4k']);
  });
}

test('control: with the lists loaded, a save stores what the selects show', async t => {
  const h = await page(t, { saved: customMovieRequests, answers: [[/jellyseerr\/radarr$/, radarrServers], [/jellyseerr\/radarr\/2$/, radarrDetails]] });
  assert.equal(h.document.getElementById('autoMovieRequestProfile').value, '7', 'the stored profile is shown');
  h.document.getElementById('autoMovieRequestProfile').value = '8';
  await h.submit();
  assert.deepEqual(autoMovie(h.lastPut()), [2, 8, '/movies4k']);
});

test('control: picking another server whose details fail stores that server with Seerr\'s default profile and folder', async t => {
  const h = await page(t, { saved: customMovieRequests, answers: [[/jellyseerr\/radarr$/, radarrServers], [/jellyseerr\/radarr\/2$/, radarrDetails], [/jellyseerr\/radarr\/0$/, failed]] });
  const server = h.document.getElementById('autoMovieRequestServer');
  server.value = '0';
  server.dispatchEvent(new h.window.Event('change', { bubbles: true }));
  await settle(h.window, 40);
  await h.submit();
  assert.deepEqual(autoMovie(h.lastPut()), [0, 0, ''], 'the stored profile and folder belong to the other server');
});

const locales = () => ['en', 'de', 'fr'];
const cultures = () => [{ TwoLetterISOLanguageName: 'en', DisplayName: 'English' }, { TwoLetterISOLanguageName: 'de', DisplayName: 'German' }, { TwoLetterISOLanguageName: 'fr', DisplayName: 'French' }];

test('when the language list fails, a save keeps the stored default language', async t => {
  const h = await page(t, { saved: { DefaultLanguage: 'de' }, answers: [[/JellyfinEnhanced\/locales/, failed], [/Localization\/Cultures/, cultures]] });
  await h.submit();
  assert.equal(h.lastPut().DefaultLanguage, 'de');
});

test('when the language list arrives after the settings, the stored default language is shown and kept', async t => {
  let release;
  const late = new Promise(resolve => { release = resolve; });
  const h = await page(t, { saved: { DefaultLanguage: 'de' }, answers: [[/JellyfinEnhanced\/locales/, () => late.then(locales)], [/Localization\/Cultures/, cultures]] });
  release();
  await settle(h.window, 40);
  const select = h.document.getElementById('DefaultLanguage');
  assert.equal(select.value, 'de');
  assert.deepEqual([...select.options].map(o => o.textContent), ['System Default', 'English', 'French', 'German'], 'each language once, by name');
  await h.submit();
  assert.equal(h.lastPut().DefaultLanguage, 'de');
});

test('control: with the language list in first, the admin\'s pick is saved', async t => {
  const h = await page(t, { saved: { DefaultLanguage: 'de' }, answers: [[/JellyfinEnhanced\/locales/, locales], [/Localization\/Cultures/, cultures]] });
  const select = h.document.getElementById('DefaultLanguage');
  assert.equal(select.value, 'de');
  select.value = 'fr';
  await h.submit();
  assert.equal(h.lastPut().DefaultLanguage, 'fr');
});

const radarrInstances = count => JSON.stringify(Array.from({ length: count }, (_, i) => (
  { Name: 'Radarr ' + (i + 1), Url: 'http://radarr' + (i + 1) + '.test:7878', ApiKey: 'key-' + (i + 1), UrlMappings: '', Enabled: true })));

test('a page left open saves what was changed on it over what was saved elsewhere since it loaded', async t => {
  const h = await page(t, { saved: { RadarrInstances: radarrInstances(1), RadarrUrl: 'http://radarr1.test:7878', RadarrApiKey: 'key-1', ShowFileSizes: false, TMDB_API_KEY: 'tmdb-old' } });
  // Another tab, opened later, adds a Radarr instance and changes a key this page also shows.
  Object.assign(h.server.config, { RadarrInstances: radarrInstances(2), TMDB_API_KEY: 'tmdb-new' });
  h.document.getElementById('showFileSizes').checked = true;
  await h.submit();
  const first = h.lastPut();
  assert.equal(first.ShowFileSizes, true, 'the change made on this page');
  assert.equal(first.RadarrInstances, radarrInstances(2), 'the instance added elsewhere stays');
  assert.equal(first.TMDB_API_KEY, 'tmdb-new', 'the key changed elsewhere stays');
  // The form still shows what it loaded; a second save from it reverts nothing either.
  h.document.getElementById('showFileSizes').checked = false;
  await h.submit();
  const second = h.lastPut();
  assert.deepEqual([second.ShowFileSizes, second.RadarrInstances, second.TMDB_API_KEY], [false, radarrInstances(2), 'tmdb-new']);
});

test('control: a setting changed on this page is saved even when another tab changed it too', async t => {
  const h = await page(t, { saved: { TMDB_API_KEY: 'tmdb-old' } });
  h.server.config.TMDB_API_KEY = 'tmdb-elsewhere';
  const key = h.document.getElementById('TMDB_API_KEY');
  key.value = 'tmdb-here';
  key.dispatchEvent(new h.window.Event('input', { bubbles: true }));
  await h.submit();
  assert.equal(h.lastPut().TMDB_API_KEY, 'tmdb-here');
});

const BROADCAST = '/JellyfinEnhanced/MaintenanceMode/Broadcast';
const ENABLE = '/JellyfinEnhanced/MaintenanceMode/Enable';

test('saving while maintenance is already on re-applies it but does not announce it again', async t => {
  const h = await page(t, { saved: { MaintenanceModeEnabled: true, MaintenanceModeAction: 'disable_remote' } });
  h.document.getElementById('showFileSizes').checked = true;
  await h.submit();
  assert.equal(h.posted(ENABLE).length, 1, 'the server still reconciles the window');
  assert.equal(h.posted(BROADCAST).length, 0);
});

test('control: turning maintenance on announces it once, and later saves while it is on do not', async t => {
  const h = await page(t, { saved: { MaintenanceModeEnabled: false, MaintenanceModeAction: 'disable_remote' } });
  h.document.getElementById('maintenanceModeEnabled').checked = true;
  await h.submit();
  assert.deepEqual([h.posted(ENABLE).length, h.posted(BROADCAST).length], [1, 1]);
  h.document.getElementById('showFileSizes').checked = true;
  await h.submit();
  assert.deepEqual([h.posted(ENABLE).length, h.posted(BROADCAST).length], [2, 1]);
});

const statusRequests = h => h.calls.ajax.filter(r => /mdblist-ratings\/account-status/.test(r.url)).map(r => r.url);

test('the MDBList status check sends no key when the key is the saved one (the server uses the saved key)', async t => {
  const h = await page(t, { saved: { MdblistRatingsEnabled: true, MdblistApiKey: 'mdb-saved-secret' } });
  h.document.getElementById('checkMdblistStatusBtn').click();
  await settle(h.window, 20);
  const urls = statusRequests(h);
  assert.ok(urls.length >= 3, 'the status dashboard, the check on page load and the button');
  for (const url of urls) assert.doesNotMatch(url, /apiKey|mdb-saved-secret/);
});

test('control: a typed key that is not saved yet is still the one checked', async t => {
  const h = await page(t, { saved: { MdblistRatingsEnabled: true, MdblistApiKey: 'mdb-saved-secret' } });
  h.document.getElementById('mdblistApiKey').value = 'mdb-new-key';
  h.document.getElementById('checkMdblistStatusBtn').click();
  await settle(h.window, 20);
  assert.equal(new URL(statusRequests(h).at(-1)).searchParams.get('apiKey'), 'mdb-new-key');
});

test('switching automatic requests to Custom shows the stored server, profile and folder, and a save keeps them', async t => {
  const saved = { ...customMovieRequests, AutoMovieRequestQualityMode: 'default' };
  const h = await page(t, { saved, answers: [[/jellyseerr\/radarr$/, radarrServers], [/jellyseerr\/radarr\/2$/, radarrDetails]] });
  const mode = h.document.getElementById('autoMovieRequestQualityMode');
  mode.value = 'custom';
  mode.dispatchEvent(new h.window.Event('change', { bubbles: true }));
  await settle(h.window, 60);
  assert.deepEqual(['autoMovieRequestServer', 'autoMovieRequestProfile', 'autoMovieRequestRootFolder'].map(id => h.document.getElementById(id).value), ['2', '7', '/movies4k']);
  await h.submit();
  assert.deepEqual(autoMovie(h.lastPut()), [2, 7, '/movies4k']);
});

test('a region picked before the full region list arrives stays picked, and a save stores it', async t => {
  const h = bootGenerated({ saved: { DEFAULT_REGION: 'US' } });
  t.after(() => h.close());
  await h.ready();
  let release;
  const empty = { ok: true, status: 200, json: async () => ({}), text: async () => '' };
  h.window.fetch = async url => /regions\.txt/.test(String(url))
    ? new Promise(resolve => { release = () => resolve({ ok: true, status: 200, text: async () => 'US\tUnited States\nDE\tGermany\nPT\tPortugal\n' }); })
    : empty;
  h.show();
  await settle(h.window, 60);
  const region = h.document.getElementById('DEFAULT_REGION');
  assert.equal(region.value, 'US');
  region.value = 'DE';
  region.dispatchEvent(new h.window.Event('change', { bubbles: true }));
  assert.equal(typeof release, 'function', 'the region list was requested');
  release();
  await settle(h.window, 60);
  assert.ok(h.document.querySelector('#DEFAULT_REGION option[value="PT"]'), 'the full list arrived');
  assert.equal(region.value, 'DE');
  h.document.querySelector('#JellyfinEnhancedForm').dispatchEvent(new h.window.Event('submit', { bubbles: true, cancelable: true }));
  await settle(h.window, 120);
  assert.equal(h.calls.puts.at(-1).DEFAULT_REGION, 'DE');
});

test('the TMDB key test sends the key in a header, not in the address Jellyfin and proxies log', async t => {
  const h = await page(t, { saved: { TMDB_API_KEY: 'tmdb-secret-key' }, answers: [[/tmdb\/validate/, () => ({ ok: true })]] });
  h.document.querySelector('.testTmdbBtn').dispatchEvent(new h.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await settle(h.window, 60);
  const request = h.calls.ajax.find(r => /tmdb\/validate/.test(r.url));
  assert.ok(request, 'the key was tested');
  assert.doesNotMatch(request.url, /tmdb-secret-key/);
  assert.equal(request.headers?.['X-Arr-ApiKey'], 'tmdb-secret-key');
});
