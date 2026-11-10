// BUG-014 / BUG-015: the language lists (admin page Default Language, settings panel Display Language) came
// partly from api.github.com at runtime; the admin page awaited that call before rendering, with no timeout.
// The list now comes only from the plugin's own embedded locales (GET /JellyfinEnhanced/locales).
//
// GitHub is modelled as blackholed: a request to it never answers. The lists must render anyway, and no
// request may leave for api.github.com (or any host other than the Jellyfin server) at all.
import test from 'node:test';
import assert from 'node:assert/strict';
import { bootGenerated, settle } from '../helpers/admin-config-page.mjs';
import { createHarness } from '../helpers/harness.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const EMBEDDED = ['en', 'de', 'fr', 'zh-HK'];
const CULTURES = [
  { TwoLetterISOLanguageName: 'de', DisplayName: 'German' },
  { TwoLetterISOLanguageName: 'fr', DisplayName: 'French' },
  { TwoLetterISOLanguageName: 'en', DisplayName: 'English' },
];

/** A fetch that records every URL and never answers for anything off the Jellyfin server. */
function offlineFetch(origin, answer = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' })) {
  const urls = [];
  const fetch = (input, init) => {
    const url = String(input?.url ?? input);
    urls.push(url);
    if (new URL(url, origin).origin !== origin) return new Promise(() => {});   // blackholed: no answer, ever
    return answer(url, init);
  };
  return { urls, fetch, remote: () => urls.filter(u => new URL(u, origin).origin !== origin) };
}

test('BUG-014: the admin Default Language list renders from the embedded locales with GitHub unreachable', async t => {
  const h = bootGenerated({
    ajax: async request => {
      if (/\/JellyfinEnhanced\/locales$/.test(request.url)) return EMBEDDED;
      if (/\/Localization\/Cultures$/.test(request.url)) return CULTURES;
      return undefined;
    },
  });
  t.after(() => h.close());
  // The page's start-up work runs after the engine arrives (a timer), so the fetch can still be replaced here.
  const net = offlineFetch('http://jf.test', h.window.fetch);
  h.window.fetch = net.fetch;
  await h.ready();
  await settle(h.window, 80);

  const select = h.document.getElementById('DefaultLanguage');
  assert.ok(select, 'the Default Language control exists');
  const codes = Array.from(select.options, o => o.value).filter(Boolean).sort();
  assert.deepEqual(codes, [...EMBEDDED].sort(), 'every embedded locale is offered, and only those');
  assert.equal(select.querySelector('option[value="zh-HK"]').textContent, 'Chinese (Hong Kong)');
  assert.deepEqual(net.urls.filter(u => u.includes('api.github.com')), [], 'no request to api.github.com');
  assert.deepEqual(net.remote(), [], 'no request leaves the Jellyfin server');
});

test('BUG-015: the settings panel Display Language list makes no GitHub request and renders offline', async t => {
  const net = offlineFetch('http://jellyfin.test');
  const h = createHarness({
    html: '<select id="displayLanguageSelect"><option value="">Auto</option></select>',
    JE: { pluginConfig: {}, userConfig: { settings: { displayLanguage: 'fr' }, settingsRevision: 'r1', shortcuts: { Shortcuts: [] } }, t: k => k, toast() {}, session: { getEpoch: () => 0 } },
    apiClient: {
      getCurrentUserId: () => 'user-a',
      ajax: async request => (request.url.endsWith('/JellyfinEnhanced/locales') ? EMBEDDED : request.url.endsWith('/Localization/Cultures') ? CULTURES : []),
    },
    fetch: net.fetch,
  });
  t.after(() => h.close());
  h.load('enhanced/config.js');
  h.JE.currentSettings = h.JE.loadSettings();
  h.load('enhanced/settingspanel/ui-panel-language.js');
  const closes = [];
  // Opened twice: every panel open used to ask GitHub again.
  for (let open = 0; open < 2; open++) {
    h.JE.internals.enhancedUi.wireLanguageControls({ resetAutoCloseTimer() {}, onClose: fn => closes.push(fn) });
    await tick(); await tick();
  }

  const select = h.document.getElementById('displayLanguageSelect');
  assert.deepEqual(Array.from(select.options, o => o.value).filter(Boolean).sort(), [...EMBEDDED].sort());
  assert.equal(select.value, 'fr', 'the saved language stays selected');
  assert.deepEqual(net.urls.filter(u => u.includes('api.github.com')), [], 'no request to api.github.com');
  assert.deepEqual(net.remote(), [], 'no request leaves the Jellyfin server');
  closes.forEach(fn => fn());
});
