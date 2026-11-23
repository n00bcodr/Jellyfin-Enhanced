import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from '../helpers/harness.mjs';

// TMDB reads a bare "pt" as Portugal, so a Brazilian browser got Portuguese (Portugal)
// titles ("Sacanas Sem Lei" instead of "Bastardos Inglórios"). The region has to reach Seerr.
test('search asks Seerr for titles in the browser language, region included', async t => {
  const urls = [];
  const h = createHarness({ JE: {
    pluginConfig: {},
    core: { api: { fetch: async url => { urls.push(url); return { results: [] }; } } },
  } });
  t.after(() => h.close());
  Object.defineProperty(h.window.navigator, 'language', { configurable: true, value: 'pt-BR' });
  h.load('jellyseerr/api.js');

  await h.JE.jellyseerrAPI.search('Bastardos');

  assert.equal(new URL(urls[0], 'http://jellyfin.test').searchParams.get('language'), 'pt-BR');
});
