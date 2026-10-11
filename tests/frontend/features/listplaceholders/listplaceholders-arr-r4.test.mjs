// Review round 4 (arr): an add that finishes after another user signed in shows and stores nothing for them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { createHarness, jsRoot } from '../../helpers/harness.mjs';

const en = JSON.parse(readFileSync(resolve(jsRoot, 'locales/en.json'), 'utf8'));
const escapeHtml = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));

const RADARR = {
  radarr: [{ id: 0, name: 'Movies', key: 'aaaaaaaaaaaaaaaa', qualityProfiles: [{ id: 1, name: 'Any' }], rootFolders: [{ path: '/movies' }] }],
  sonarr: [],
  minimumAvailability: ['announced', 'inCinemas', 'released'],
  seriesTypes: ['standard', 'daily', 'anime']
};

const movie = { id: 'a'.repeat(32), kind: 'movie', mediaType: 'movie', tmdbId: 49521, title: 'Man of Steel', year: 2013 };

/** Loads the real Seerr modal + the arr module; the add route waits for the test to settle it. */
function setup(t) {
  const toasts = [];
  const session = { epoch: 1, user: 'user-a' };
  const pending = {};
  const JE = {
    pluginConfig: { ListPlaceholdersEnabled: true, ListPlaceholdersArrEnabled: true },
    currentSettings: { isAdmin: true },
    translations: en,
    escapeHtml,
    t: (key) => (en[key] ?? key).replace(/\{\{icon:[a-zA-Z]+\}\}\s*/g, ''),
    session: {
      userScopedKey: (base) => `${base}:${session.user}`,
      getEpoch: () => session.epoch,
      isCurrent: (epoch) => epoch === session.epoch
    },
    toast: (html, ms) => toasts.push({ html, ms }),
    core: {
      api: {
        plugin: async (path) => {
          if (path.includes('/options')) return RADARR;
          if (path.includes('/lookup')) return { results: [] };
          return new Promise((res, rej) => { pending.resolve = res; pending.reject = rej; });
        }
      }
    }
  };
  const h = createHarness({ JE, apiClient: { serverAddress: () => 'http://jf.example:8096/' } });
  t.after(() => h.close());
  h.load('jellyseerr/modal.js');
  h.load('jellyseerr/listplaceholders/listplaceholders-arr.js');
  return { ...h, arr: h.JE.listPlaceholders.arr, toasts, session, pending };
}

/** Waits until `predicate()` is truthy. */
async function until(predicate, label = 'condition') {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await sleep(5);
  }
  assert.fail(`timed out waiting for ${label}`);
}

for (const outcome of ['succeeds', 'fails']) {
  test(`R4: an add that ${outcome} after a user switch shows no toast and remembers nothing for the new user`, async (t) => {
    const h = setup(t);
    let done = 0;
    const opened = h.arr.openAddDialog(movie, { onDone: () => { done++; } });
    const doc = h.document;
    await until(() => doc.querySelector('#je-lp-arr-root')?.value === '/movies', 'pickers');
    doc.querySelector('.jellyseerr-modal-button-primary').click();
    await until(() => h.pending.resolve, 'add sent');
    doc.querySelector('.jellyseerr-modal-button-secondary').click();
    assert.equal(await opened, null);

    // The admin signs out; a viewer signs in on the same browser.
    h.session.epoch = 2;
    h.session.user = 'user-b';
    if (outcome === 'succeeds') {
      h.pending.resolve({ added: true, service: 'radarr', instanceName: 'Movies', instanceUrl: 'http://radarr.lan:7878', title: 'Man of Steel' });
    } else {
      h.pending.reject(Object.assign(new Error('HTTP 400'), { status: 400, responseJSON: { code: 'invalid_root_folder', message: 'x' } }));
    }
    await sleep(30);
    assert.deepEqual(h.toasts, []);
    assert.equal(done, 0);
    assert.equal(h.window.localStorage.getItem('je-lp-arr-choice:user-b'), null);
    assert.equal(h.window.localStorage.getItem('je-lp-arr-choice:user-a'), null);
  });
}

test('R4: the same add with no user switch still reports and remembers', async (t) => {
  const h = setup(t);
  h.arr.openAddDialog(movie);
  const doc = h.document;
  await until(() => doc.querySelector('#je-lp-arr-root')?.value === '/movies', 'pickers');
  doc.querySelector('.jellyseerr-modal-button-primary').click();
  await until(() => h.pending.resolve, 'add sent');
  h.pending.resolve({ added: true, service: 'radarr', instanceName: 'Movies', title: 'Man of Steel' });
  await until(() => h.toasts.length, 'toast');
  assert.notEqual(h.window.localStorage.getItem('je-lp-arr-choice:user-a'), null);
});
