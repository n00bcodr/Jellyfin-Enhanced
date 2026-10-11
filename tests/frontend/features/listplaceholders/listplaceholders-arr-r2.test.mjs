// Review round 2 (arr): an add that fails after the admin closed the dialog still says so.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { createHarness, jsRoot, plain } from '../../helpers/harness.mjs';

const en = JSON.parse(readFileSync(resolve(jsRoot, 'locales/en.json'), 'utf8'));
const escapeHtml = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));

const TWO_RADARRS = {
  radarr: [
    { id: 0, name: 'Movies', key: 'aaaaaaaaaaaaaaaa', qualityProfiles: [{ id: 1, name: 'Any' }, { id: 4, name: 'HD-1080p' }], rootFolders: [{ path: '/movies' }] },
    { id: 1, name: 'Movies 4K', key: 'bbbbbbbbbbbbbbbb', qualityProfiles: [{ id: 7, name: '2160p' }], rootFolders: [{ path: '/movies4k' }] }
  ],
  sonarr: [],
  minimumAvailability: ['announced', 'inCinemas', 'released'],
  seriesTypes: ['standard', 'daily', 'anime']
};

const movie = { id: 'a'.repeat(32), kind: 'movie', mediaType: 'movie', tmdbId: 49521, title: 'Man of Steel', year: 2013 };

/** Loads the real Seerr modal + the arr module with a stubbed JE; `reply(path, options)` answers JE.core.api.plugin. */
function setup(t, reply) {
  const calls = [];
  const toasts = [];
  const JE = {
    pluginConfig: { ListPlaceholdersEnabled: true, ListPlaceholdersArrEnabled: true },
    currentSettings: { isAdmin: true },
    translations: en,
    escapeHtml,
    t: (key, params = {}) => {
      let text = en[key] ?? key;
      for (const [name, value] of Object.entries(params)) text = text.replace(new RegExp(`{${name}}`, 'g'), value);
      return text.replace(/\{\{icon:[a-zA-Z]+\}\}\s*/g, '');
    },
    session: { userScopedKey: (base) => `${base}:user-a` },
    toast: (html, ms) => toasts.push({ html, ms }),
    core: {
      api: {
        plugin: async (path, options = {}) => {
          calls.push({ path, options: plain({ ...options, signal: undefined }) });
          if (!path.startsWith('/list-placeholders/arr/')) throw new Error(`Unexpected route ${path}`);
          return reply(path, options);
        }
      }
    }
  };
  const h = createHarness({ JE, apiClient: { serverAddress: () => 'http://jf.example:8096/' } });
  t.after(() => h.close());
  h.load('jellyseerr/modal.js');
  h.load('jellyseerr/listplaceholders/listplaceholders-arr.js');
  return { ...h, arr: h.JE.listPlaceholders.arr, calls, toasts };
}

/** Waits until `predicate()` is truthy (modal timers, promise chains). */
async function until(predicate, label = 'condition') {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await sleep(5);
  }
  assert.fail(`timed out waiting for ${label}`);
}

/** Picks a value in a dialog select the way a user does. */
function choose(h, selector, value) {
  const select = h.document.querySelector(selector);
  select.value = value;
  select.dispatchEvent(new h.window.Event('change'));
}

test('R2: an add that fails after the dialog was closed shows its error as a toast', async (t) => {
  let fail;
  const h = setup(t, async (path) => {
    if (path.includes('/options')) return TWO_RADARRS;
    if (path.includes('/lookup')) return { results: [] };
    return new Promise((_, reject) => { fail = reject; });
  });
  const opened = h.arr.openAddDialog(movie);
  const doc = h.document;
  await until(() => doc.querySelector('#je-lp-arr-root')?.value === '/movies', 'pickers');
  doc.querySelector('.jellyseerr-modal-button-primary').click();
  await until(() => fail, 'add sent');
  doc.querySelector('.jellyseerr-modal-button-secondary').click();
  assert.equal(await opened, null);

  fail(Object.assign(new Error('HTTP 400'), { status: 400, responseJSON: { code: 'invalid_root_folder', message: 'x' } }));
  await until(() => h.toasts.length, 'toast');
  assert.equal(h.toasts[0].html, en.listPlaceholders_arr_error_root.replace('{service}', 'Radarr'));
});

test('R2: an add that fails with the dialog open shows it in the dialog only', async (t) => {
  let calls = 0;
  const h = setup(t, async (path) => {
    if (path.includes('/options')) return TWO_RADARRS;
    if (path.includes('/lookup')) return { results: [] };
    calls++;
    throw Object.assign(new Error('HTTP 400'), { status: 400, responseJSON: { code: 'invalid_root_folder', message: 'x' } });
  });
  h.arr.openAddDialog(movie);
  const doc = h.document;
  await until(() => doc.querySelector('#je-lp-arr-root')?.value === '/movies', 'pickers');
  doc.querySelector('.jellyseerr-modal-button-primary').click();
  await until(() => calls === 1 && doc.querySelector('.je-lp-arr-message').textContent, 'message');
  await sleep(10);
  assert.equal(h.toasts.length, 0);
});
