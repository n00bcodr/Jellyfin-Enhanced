// Review round 5 (arr): the instance options of an admin's slow GET /arr/options never reach the next user.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { createHarness, jsRoot } from '../../helpers/harness.mjs';

const en = JSON.parse(readFileSync(resolve(jsRoot, 'locales/en.json'), 'utf8'));
const escapeHtml = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));

const ADMIN_OPTIONS = {
  radarr: [{ id: 0, name: 'Admin Movies', key: 'aaaaaaaaaaaaaaaa', qualityProfiles: [{ id: 1, name: 'Any' }], rootFolders: [{ path: '/secret/movies', freeSpace: 1 }] }],
  sonarr: [],
  minimumAvailability: ['announced', 'inCinemas', 'released'],
  seriesTypes: ['standard', 'daily', 'anime']
};

const movie = { id: 'a'.repeat(32), kind: 'movie', mediaType: 'movie', tmdbId: 49521, title: 'Man of Steel', year: 2013 };

/** The arr module (and the real Seerr modal) with a GET /arr/options the test answers by hand. */
function setup(t) {
  const session = { epoch: 1, user: 'admin', listeners: [] };
  const optionCalls = [];
  const JE = {
    pluginConfig: { ListPlaceholdersEnabled: true, ListPlaceholdersArrEnabled: true },
    currentSettings: { isAdmin: true },
    translations: en,
    escapeHtml,
    t: (key) => (en[key] ?? key).replace(/\{\{icon:[a-zA-Z]+\}\}\s*/g, ''),
    session: {
      userScopedKey: (base) => `${base}:${session.user}`,
      getEpoch: () => session.epoch,
      isCurrent: (epoch) => epoch === session.epoch,
      onUserChange: (_name, fn) => session.listeners.push(fn)
    },
    toast: () => {},
    core: {
      api: {
        plugin: (path) => {
          if (path.includes('/options')) return new Promise((res, rej) => optionCalls.push({ res, rej }));
          if (path.includes('/lookup')) return Promise.resolve({ results: [] });
          return new Promise(() => {});
        }
      }
    }
  };
  const h = createHarness({ JE, apiClient: { serverAddress: () => 'http://jf.example:8096/' } });
  t.after(() => h.close());
  h.load('jellyseerr/modal.js');
  h.load('jellyseerr/listplaceholders/listplaceholders-arr.js');
  const switchUser = () => {
    session.epoch++;
    session.user = 'viewer';
    session.listeners.forEach((fn) => fn());
  };
  return { ...h, arr: h.JE.listPlaceholders.arr, optionCalls, switchUser };
}

test('R5: options answered after a user switch are not cached or returned for the new user', async (t) => {
  const h = setup(t);
  const adminRead = h.arr.getOptions({ type: 'movie' });
  assert.equal(h.optionCalls.length, 1);
  h.switchUser();
  h.optionCalls[0].res(ADMIN_OPTIONS);
  await assert.rejects(adminRead, (error) => error.name === 'AbortError');

  // The new session reads the options itself; nothing of the admin's answer is served from memory.
  const viewerRead = h.arr.getOptions({ type: 'movie' });
  assert.equal(h.optionCalls.length, 2);
  h.optionCalls[1].res({ radarr: [], sonarr: [] });
  assert.deepEqual(await viewerRead, { radarr: [], sonarr: [] });
});

test('R5: the same read with no user switch is cached for a minute', async (t) => {
  const h = setup(t);
  const read = h.arr.getOptions({ type: 'movie' });
  h.optionCalls[0].res(ADMIN_OPTIONS);
  assert.equal(await read, ADMIN_OPTIONS);
  assert.equal(await h.arr.getOptions({ type: 'movie' }), ADMIN_OPTIONS);
  assert.equal(h.optionCalls.length, 1);
});

test('R5: a dialog whose options arrive after a user switch fills nothing in', async (t) => {
  const h = setup(t);
  h.arr.openAddDialog(movie);
  await sleep(5);
  h.switchUser();
  h.optionCalls[0].res(ADMIN_OPTIONS);
  await sleep(20);
  assert.ok(h.document.querySelector('#je-lp-arr-root'));
  assert.ok(!h.document.body.innerHTML.includes('/secret/movies'));
  assert.ok(!h.document.body.innerHTML.includes('Admin Movies'));
});
