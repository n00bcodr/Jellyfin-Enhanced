import test from 'node:test';
import assert from 'node:assert/strict';
import { configPage, fieldBytes } from '../helpers/config-page.mjs';
import { shippedLocales } from '../helpers/served-scripts.mjs';
import { readFileSync } from 'node:fs';

// Stage 1 fix round 5 (found along the way): the administrator's Default UI Language on the configuration page. Its options
// load asynchronously (the server's locales, Jellyfin's cultures, a GitHub probe) while loadConfig applies the stored value,
// so a stored "de" set before the list had arrived showed "System Default", and the next save of the page wrote ''. Runs the
// whole page (round 6: the field is one of the page's asynchronously filled fields).
const CULTURES = JSON.parse(readFileSync(new URL('../helpers/jellyfin-12.2-cultures.json', import.meta.url), 'utf8'));
const LOCALES = shippedLocales().filter(code => code !== 'en');

function setup(t, stored, { fail = false } = {}) {
  let list;
  const p = configPage(t, {
    config: { JellyseerrUrls: '', JellyseerrUrlMappings: '', Shortcuts: [], DefaultLanguage: stored },
    overrides: {
      cultures: [(kind, url) => url.includes('/Localization/Cultures'), () => structuredClone(CULTURES)],
      locales: [(kind, url) => url.includes('/JellyfinEnhanced/locales'), () => { if (fail) throw new Error('locales unavailable'); return [...LOCALES]; }]
    },
    before: page => { list = page.hold('locales'); }
  });
  const select = p.$('#DefaultLanguage');
  const shown = () => ({ value: select.value, text: select.options[select.selectedIndex]?.textContent, same: [...select.options].filter(o => o.value === select.value).length,
    placeholders: select.querySelectorAll('option[data-je-placeholder]').length });
  const settle = () => fail ? list.reject() : list.resolve([...LOCALES]);
  return { p, select, shown, settle, saved: async () => fieldBytes(await p.save(), 'DefaultLanguage') };
}

test('a stored default applied before the language list arrives is shown and kept by a save, then named by the list', async t => {
  const h = setup(t, 'de');
  await h.p.pageshow();
  assert.equal(h.select.value, 'de');
  assert.equal(await h.saved(), '"de"', 'a save before the list keeps the default');
  await h.settle();
  assert.deepEqual(h.shown(), { value: 'de', text: 'German', same: 1, placeholders: 0 });
  assert.equal(await h.saved(), '"de"');
});

test('a stored default applied after the language list arrives is shown and kept', async t => {
  const h = setup(t, 'pt-BR');
  await h.settle();
  await h.p.pageshow();
  assert.deepEqual(h.shown(), { value: 'pt-BR', text: 'Portuguese (Brazil)', same: 1, placeholders: 0 });
  assert.equal(await h.saved(), '"pt-BR"');
  h.p.server.config.DefaultLanguage = 'fr'; // the page shown again (pageshow) with another stored default
  await h.p.pageshow();
  assert.deepEqual(h.shown(), { value: 'fr', text: 'French', same: 1, placeholders: 0 });
});

test('a language list that fails to load still keeps the stored default', async t => {
  const h = setup(t, 'de', { fail: true });
  await h.p.pageshow();
  await h.settle();
  assert.equal(h.select.value, 'de');
  assert.equal(await h.saved(), '"de"');
});

test('a stored default the list does not hold stays as it is; an empty one is System Default', async t => {
  const h = setup(t, 'en-AU');
  await h.p.pageshow();
  await h.settle();
  assert.equal(h.select.value, 'en-AU');
  assert.equal(await h.saved(), '"en-AU"');
  h.p.server.config.DefaultLanguage = '';
  await h.p.pageshow();
  assert.equal(h.select.value, '');
  assert.equal(h.select.options[h.select.selectedIndex].textContent, 'System Default');
  assert.equal(await h.saved(), '""');
});
