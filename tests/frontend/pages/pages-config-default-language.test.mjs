import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHarness, deferred } from '../helpers/harness.mjs';
import { repositoryRoot } from '../helpers/discovery.mjs';
import { shippedLocales } from '../helpers/served-scripts.mjs';

// Stage 1 fix round 5 (found along the way): the administrator's Default UI Language on the configuration page. Its options
// load asynchronously (the server's locales, Jellyfin's cultures, a GitHub probe) while loadConfig applies the stored value,
// so a stored "de" set before the list had arrived showed "System Default", and the next save of the page wrote ''. Runs the
// page's own code: the saved-option helper, loadConfig's lines for the field, the list loader and saveConfig's line.
const page = readFileSync(resolve(repositoryRoot, 'Jellyfin.Plugin.JellyfinEnhanced/Configuration/configPage.html'), 'utf8');
function block(start, end) {
  const from = page.indexOf(start);
  const to = page.indexOf(end, from);
  if (from < 0 || to < 0) throw new Error(`config page block not found: ${start}`);
  return page.slice(from, to);
}
const helper = block('        function applySavedOption(', '\n        }\n') + '\n        }\n';
const load = block("                const defaultLanguageSelect = document.querySelector('#DefaultLanguage');", "                document.querySelector('#letterboxdEnabled')");
const list = block('        // Populate language options dynamically', '        // Preferred audio language for sound tags');
const save = block("            config.DefaultLanguage = document.querySelector('#DefaultLanguage').value", '\n');
const CULTURES = JSON.parse(readFileSync(new URL('../helpers/jellyfin-12.2-cultures.json', import.meta.url), 'utf8'));
const LOCALES = shippedLocales().filter(code => code !== 'en');

function setup(t, { fail = false } = {}) {
  const locales = deferred();
  const h = createHarness({
    html: '<select id="DefaultLanguage"><option value="">System Default</option></select>',
    fetch: async () => ({ ok: false }),
    apiClient: { ajax: async request => {
      if (request.url.includes('/JellyfinEnhanced/locales')) { await locales.promise; if (fail) throw new Error('locales unavailable'); return [...LOCALES]; }
      if (request.url.includes('/Localization/Cultures')) return structuredClone(CULTURES);
      throw new Error(`unexpected request ${request.url}`);
    } }
  });
  if (fail) h.allowConsoleError(/./);
  t.after(() => h.close());
  h.window.eval(`${helper}
    window.__loadConfig = config => {\n${load}\n};
    window.__saveConfig = () => { const config = {};\n${save}\n; return config.DefaultLanguage; };
    window.__list = () => { const culturesPromise = ApiClient.ajax({ type: 'GET', url: ApiClient.getUrl('/Localization/Cultures'), dataType: 'json' });\n${list}\n};`);
  const select = h.document.getElementById('DefaultLanguage');
  const settle = async () => { locales.resolve(); for (let i = 0; i < 5; i++) await new Promise(done => setImmediate(done)); };
  const shown = () => ({ value: select.value, text: select.options[select.selectedIndex]?.textContent, same: [...select.options].filter(o => o.value === select.value).length,
    placeholders: select.querySelectorAll('option[data-je-placeholder]').length });
  return { ...h, select, settle, shown, loadConfig: value => h.window.__loadConfig({ DefaultLanguage: value }), saveConfig: () => h.window.__saveConfig(), list: () => h.window.__list() };
}

test('a stored default applied before the language list arrives is shown and kept by a save, then named by the list', async t => {
  const h = setup(t);
  h.list();
  h.loadConfig('de');
  assert.equal(h.select.value, 'de');
  assert.equal(h.saveConfig(), 'de', 'a save before the list keeps the default');
  await h.settle();
  assert.deepEqual(h.shown(), { value: 'de', text: 'German', same: 1, placeholders: 0 });
  assert.equal(h.saveConfig(), 'de');
});

test('a stored default applied after the language list arrives is shown and kept', async t => {
  const h = setup(t);
  h.list();
  await h.settle();
  h.loadConfig('pt-BR');
  assert.deepEqual(h.shown(), { value: 'pt-BR', text: 'Portuguese (Brazil)', same: 1, placeholders: 0 });
  assert.equal(h.saveConfig(), 'pt-BR');
  h.loadConfig('fr'); // the page shown again (pageshow) with another stored default
  assert.deepEqual(h.shown(), { value: 'fr', text: 'French', same: 1, placeholders: 0 });
});

test('a language list that fails to load still keeps the stored default', async t => {
  const h = setup(t, { fail: true });
  h.list();
  h.loadConfig('de');
  await h.settle();
  assert.equal(h.select.value, 'de');
  assert.equal(h.saveConfig(), 'de');
});

test('a stored default the list does not hold stays as it is; an empty one is System Default', async t => {
  const h = setup(t);
  h.list();
  h.loadConfig('en-AU');
  await h.settle();
  assert.equal(h.select.value, 'en-AU');
  assert.equal(h.saveConfig(), 'en-AU');
  h.loadConfig('');
  assert.equal(h.select.value, '');
  assert.equal(h.select.options[h.select.selectedIndex].textContent, 'System Default');
  assert.equal(h.saveConfig(), '');
});
