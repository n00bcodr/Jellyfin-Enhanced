import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHarness } from '../helpers/harness.mjs';
import { repositoryRoot } from '../helpers/discovery.mjs';

// The configuration page is one inline script, not a bundled module: run the real masked-credential
// and instance-registry helpers (and the createEl they use) from it in a fresh realm.
const page = readFileSync(resolve(repositoryRoot, 'Jellyfin.Plugin.JellyfinEnhanced/Configuration/configPage.html'), 'utf8');
function block(start, end) {
  const from = page.indexOf(start);
  const to = page.indexOf(end, from);
  if (from < 0 || to < 0) throw new Error(`config page block not found: ${start}`);
  return page.slice(from, to);
}
const helpers = block('        // ==================== Asynchronously filled fields', '        // Auto Movie Request - Quality Profile Mode helpers')
  + block('        function createEl(tag, attrs, children) {', '        function createInstanceCard(type, instance, startOpen) {');

const PREFIX = '•'.repeat(8);
function setup(t, { libraries = [] } = {}) {
  const h = createHarness({
    html: '<div class="je-api-row"><input id="a"><span></span></div><div class="je-api-row"><input id="b"></div><div class="je-api-row"><input id="c"></div>',
    apiClient: { getVirtualFolders: async () => libraries },
  });
  t.after(() => h.close());
  h.window.eval(`${helpers}\nwindow.__je = { jeSecretInit, jeSecretSetState, jeSecretRead, jeSecretWireValue, jeSecretBindServers, jeSecretCheckServers, jeImportedKeysLost, jeIsSecretPlaceholder, jeNewGuid, jeBuildInstanceRegistryFields, jeReadInstanceRegistryFields, JE_SECRET_CLEAR };`);
  return { ...h, get NATIVE() { return h.NATIVE; }, je: h.window.__je, $: id => h.document.getElementById(id) };
}

test('a saved credential shows its placeholder read-only and posts it back unchanged', t => {
  const { je, $ } = setup(t);
  const input = $('a');
  je.jeSecretInit(input, PREFIX + '3f9a');
  assert.equal(input.value, PREFIX + '3f9a');
  assert.equal(input.readOnly, true);
  assert.equal(je.jeSecretRead(input), PREFIX + '3f9a');
  const [replace, clear] = input.nextElementSibling.querySelectorAll('button');
  assert.equal(input.nextElementSibling.style.display, '');
  // Replace: an empty field still means "keep"; a typed key replaces it (whitespace dropped).
  replace.click();
  assert.equal(input.readOnly, false);
  assert.equal(input.value, '');
  assert.equal(je.jeSecretRead(input), PREFIX + '3f9a');
  input.value = ' new key ';
  assert.equal(je.jeSecretRead(input), 'newkey');
  replace.click(); // "Keep saved"
  assert.equal(je.jeSecretRead(input), PREFIX + '3f9a');
  // Clear posts the explicit clear token; Undo restores.
  clear.click();
  assert.equal(input.value, '');
  assert.equal(je.jeSecretRead(input), je.JE_SECRET_CLEAR);
  clear.click();
  assert.equal(je.jeSecretRead(input), PREFIX + '3f9a');
});

test('an unset credential is a plain input without buttons, and re-initialising does not duplicate them', t => {
  const { je, $, document } = setup(t);
  const input = $('a');
  je.jeSecretInit(input, '');
  assert.equal(input.readOnly, false);
  assert.equal(input.nextElementSibling.style.display, 'none');
  input.value = 'typed';
  assert.equal(je.jeSecretRead(input), 'typed');
  je.jeSecretInit(input, PREFIX);
  assert.equal(document.querySelectorAll('.je-secret-actions').length, 1);
  assert.equal(input.readOnly, true);
});

test('peer inputs for one credential share its state', t => {
  const { je, $ } = setup(t);
  je.jeSecretInit($('a'), PREFIX + 'abcd', [$('b')]);
  assert.equal($('b').value, PREFIX + 'abcd');
  $('b').nextElementSibling.querySelector('.je-secret-clear').click();
  assert.equal(je.jeSecretRead($('a')), je.JE_SECRET_CLEAR);
  assert.equal(je.jeSecretRead($('b')), je.JE_SECRET_CLEAR);
});

test('new instance ids are v4 GUIDs', t => {
  const { je } = setup(t);
  const ids = new Set(Array.from({ length: 20 }, () => je.jeNewGuid()));
  assert.equal(ids.size, 20);
  for (const id of ids) assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('instance registry fields round-trip, keeping links to libraries that are not listed', async t => {
  const { je, document, window } = setup(t, { libraries: [{ Name: 'Movies', ItemId: 'aaaa1111' }, { Name: 'Movies <4K>', ItemId: 'BBBB2222' }] });
  const card = document.createElement('div');
  card.className = 'arr-instance-card';
  card._jeRow = { Role: '4k', IsDefault: true, LinkedLibraryIds: ['bbbb2222', 'gone0000'], PathMappings: [{ ArrPath: '/movies', JellyfinPath: '/media/movies' }] };
  card.appendChild(je.jeBuildInstanceRegistryFields('radarr', card._jeRow));
  document.body.appendChild(card);
  // Before the library list arrives, the stored links are kept as they were.
  assert.deepEqual(JSON.parse(JSON.stringify(je.jeReadInstanceRegistryFields(card).LinkedLibraryIds)), ['bbbb2222', 'gone0000']);
  await new Promise(r => window.setTimeout(r, 0));
  const labels = [...card.querySelectorAll('.arr-instance-libraries label span')].map(s => s.textContent);
  assert.deepEqual(labels, ['Movies', 'Movies <4K>']);
  assert.equal(card.querySelector('.arr-instance-libraries').innerHTML.includes('<4K>'), false); // text, not markup
  const out = JSON.parse(JSON.stringify(je.jeReadInstanceRegistryFields(card)));
  assert.deepEqual(out, { Role: '4k', IsDefault: true, LinkedLibraryIds: ['bbbb2222', 'gone0000'], LiveUpdates: 'auto', PathMappings: [{ ArrPath: '/movies', JellyfinPath: '/media/movies' }] });
  card.querySelector('[data-library-id="aaaa1111"]').checked = true;
  card.querySelector('[data-library-id="aaaa1111"]').dispatchEvent(new window.Event('change', { bubbles: true }));
  card.querySelector('.arr-instance-role').value = 'anime';
  card.querySelector('.arr-instance-pathmappings').value = '/tv|/media/tv\nbroken line\n|/x';
  const edited = JSON.parse(JSON.stringify(je.jeReadInstanceRegistryFields(card)));
  assert.deepEqual(edited.LinkedLibraryIds.sort(), ['aaaa1111', 'bbbb2222', 'gone0000']);
  assert.equal(edited.Role, 'anime');
  assert.deepEqual(edited.PathMappings, [{ ArrPath: '/tv', JellyfinPath: '/media/tv' }]);
  // Live updates (phase 1): on unless switched off for this instance; a stored "off" is kept.
  card.querySelector('.arr-instance-live').checked = false;
  assert.equal(je.jeReadInstanceRegistryFields(card).LiveUpdates, 'off');
  const off = je.jeBuildInstanceRegistryFields('radarr', { LiveUpdates: 'off' });
  assert.equal(off.querySelector('.arr-instance-live').checked, false);
});

// What fetch / XMLHttpRequest do with a header value: anything outside Latin-1 throws before sending.
function assertSendableHeader(value) {
  assert.doesNotThrow(() => new Headers({ 'X-Arr-ApiKey': value }), `not sendable as a header: ${JSON.stringify(value)}`);
}

test('Test buttons get an ASCII stand-in for a saved key or import handle, never the bullet placeholder', t => {
  const { je, $ } = setup(t);
  assert.throws(() => new Headers({ 'X-Arr-ApiKey': PREFIX + '3f9a' })); // why the stand-in exists
  je.jeSecretInit($('a'), PREFIX + '3f9a');
  assert.equal(je.jeSecretWireValue($('a')), '__je_saved_secret__');
  $('a').nextElementSibling.querySelector('.je-secret-replace').click();     // editing, nothing typed: still the saved key
  assert.equal(je.jeSecretWireValue($('a')), '__je_saved_secret__');
  $('a').value = 'typed-key';
  assert.equal(je.jeSecretWireValue($('a')), 'typed-key');
  $('a').nextElementSibling.querySelector('.je-secret-replace').click();     // keep saved
  $('a').nextElementSibling.querySelector('.je-secret-clear').click();
  assert.equal(je.jeSecretWireValue($('a')), '');
  je.jeSecretInit($('b'), PREFIX + 'seerr-0123abcd');
  assert.equal(je.jeSecretWireValue($('b')), '__je_handle__:0123abcd');
  je.jeSecretInit($('c'), '');
  assert.equal(je.jeSecretWireValue($('c')), '');
  for (const v of ['__je_saved_secret__', '__je_handle__:0123abcd']) assertSendableHeader(v);
});

test('a saved key asks to be re-entered when its address moves to another server, and comes back with it', t => {
  const { je, $ } = setup(t);
  const input = $('a');
  je.jeSecretInit(input, PREFIX + '3f9a');
  je.jeSecretBindServers(input, ['http://sonarr.lan:8989']);
  je.jeSecretCheckServers(input, ['http://sonarr.lan:8989/sonarr']);      // same server: unchanged
  assert.equal(input.dataset.jeSecretState, 'set');
  je.jeSecretCheckServers(input, ['https://elsewhere.example']);
  assert.equal(input.dataset.jeSecretState, 'editing');
  assert.match(input.placeholder, /Re-enter the API key/);
  assert.equal(input.nextElementSibling.querySelector('.je-secret-replace').disabled, true);
  assert.equal(je.jeSecretRead(input), '');            // the saved key is not posted for the new address
  assert.equal(je.jeSecretWireValue(input), '');
  input.value = 'new-key';
  assert.equal(je.jeSecretRead(input), 'new-key');
  input.value = '';
  je.jeSecretCheckServers(input, ['http://SONARR.lan:8989/']);
  assert.equal(input.dataset.jeSecretState, 'set');
  assert.equal(je.jeSecretRead(input), PREFIX + '3f9a');
  // Several Seerr URLs: adding one on another server counts as moved.
  je.jeSecretBindServers(input, ['http://seerr.lan:5055', 'https://seerr.example']);
  je.jeSecretCheckServers(input, ['http://seerr.lan:5055', 'https://seerr.example']);
  assert.equal(input.dataset.jeSecretState, 'set');
  je.jeSecretCheckServers(input, ['http://seerr.lan:5055', 'https://attacker.example']);
  assert.equal(input.dataset.jeSecretState, 'editing');
});

test('rows saved with an import handle that came back without a key are reported', t => {
  const { je } = setup(t);
  const fresh = {
    SonarrInstances: JSON.stringify([{ Id: 'a', ApiKey: PREFIX + 'abcd' }, { Id: 'b', ApiKey: '' }]),
    RadarrInstances: 'not json',
  };
  assert.deepEqual([...je.jeImportedKeysLost({ a: 'Kept', b: 'Lost', c: 'Elsewhere' }, fresh)], ['Lost']);
  assert.deepEqual([...je.jeImportedKeysLost({}, fresh)], []);
});

// The real Test / scan-now handlers with a masked key: every request they make must be sendable.
const testHandlers = [
  block('        function connectionErrorMessage(error, serviceName, url) {', '        function addIssue(container, text) {'),
  block('        async function testJellyseerrConnection() {', '        async function testTmdbConnection(event) {'),
  block('        async function triggerSeerrScanNow() {', "        document.querySelector('#triggerSeerrScanNowBtn').addEventListener("),
].join('\n');

test('the arr, Seerr and scan-now buttons send a saved key in a header the browser accepts', async t => {
  const requests = [];
  const alerts = [];
  const h = createHarness({
    html: `<details class="arr-instance-card" data-type="radarr" data-instance-id="6f1c0c2e-6f39-4c39-9a51-2f7f1b8d0a11">
             <input class="arr-instance-name" value="Movies"><input class="arr-instance-url" value="http://radarr.lan:7878">
             <input class="arr-instance-apikey"><span class="arr-instance-status"></span><button class="arr-instance-test"></button></details>
           <textarea id="jellyseerrUrls">http://seerr.lan:5055</textarea><input id="JellyseerrApiKey">
           <button id="triggerSeerrScanNowBtn"></button><span id="triggerSeerrScanNowStatus"></span>
           <span id="seerrIndicator"></span><button id="seerrTest"></button>`,
    apiClient: {
      getUrl: (path, query) => 'http://jellyfin.test' + path + (query ? '?' + new URLSearchParams(query) : ''),
      ajax: async options => {
        // Same rule as fetch: a non-Latin-1 header value throws before anything is sent.
        new Headers(options.headers || {});
        requests.push(options);
        return { ok: true };
      },
    },
    globals: { Dashboard: { alert: a => alerts.push(a) } },
  });
  t.after(() => h.close());
  h.window.eval(`${helpers}\nvar jeTestAlert = function (a) { Dashboard.alert(a); };
    var setConnectionTestResult = function () {}; var updateAllDependencies = function () {};
    var _jeNormalizeArrUrl = function (u) { return u; };
    var testJellyseerrBtn = document.getElementById('seerrTest');
    var jellyseerrStatusIndicator = document.getElementById('seerrIndicator');
    ${testHandlers}
    window.__t = { jeSecretInit, testInstanceConnection, testJellyseerrConnection, triggerSeerrScanNow };`);
  const je = h.window.__t;
  const card = h.document.querySelector('.arr-instance-card');
  je.jeSecretInit(card.querySelector('.arr-instance-apikey'), PREFIX + '3f9a');
  je.jeSecretInit(h.document.getElementById('JellyseerrApiKey'), PREFIX + 'beef');

  await je.testInstanceConnection(card);
  await je.testJellyseerrConnection();
  await je.triggerSeerrScanNow();

  assert.equal(requests.length, 3);
  for (const r of requests) assert.equal(r.headers['X-Arr-ApiKey'], '__je_saved_secret__');
  assert.match(requests[0].url, /instanceId=6f1c0c2e/);
  assert.deepEqual(alerts.map(a => a.title), ['Success', 'Success', 'Scan Triggered']);
});

test('every credential field the page saves goes through the masked-credential helpers', () => {
  // The legacy arr key mirrors are written from the instance cards; every other credential the page
  // saves must post jeSecretRead's value (a placeholder keeps the stored key), and be shown with
  // jeSecretInit, so no key is ever put into a plain input (upstream's DoesTheDogDie key included).
  const saves = [...page.matchAll(/config\.([A-Za-z_]*(?:ApiKey|API_KEY|Token|Password|Passphrase)) = ([^;]*);/g)]
    .filter(([, field]) => field !== 'SonarrApiKey' && field !== 'RadarrApiKey');
  assert.ok(saves.some(([, field]) => field === 'DoesTheDogDieApiKey'));
  for (const [, field, value] of saves) {
    assert.match(value, /^jeSecretRead\(document\.querySelector\('#[A-Za-z_]+'\)\)$/, `${field} is saved through jeSecretRead`);
    const id = value.match(/#([A-Za-z_]+)/)[1];
    assert.ok(new RegExp(`jeSecretInit\\([^;]*querySelector\\('#${id}'\\)`).test(page), `#${id} is shown through jeSecretInit (or as a peer)`);
    assert.ok(!new RegExp(`querySelector\\('#${id}'\\)\\.value = `).test(page), `#${id} is never filled with a raw value`);
  }
});
