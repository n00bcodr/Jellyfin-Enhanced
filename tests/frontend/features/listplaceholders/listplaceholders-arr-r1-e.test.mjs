// Review round 1 (arr track): request ids follow the add they were made for, Minimum availability follows the chosen
// instance, and a search that couldn't be started is shown.
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

test('dialog: a retry with other choices gets its own requestId, the same choices keep theirs', async (t) => {
  const bodies = [];
  let failures = 3;
  const h = setup(t, async (path, options) => {
    if (path.includes('/options')) return TWO_RADARRS;
    if (path.includes('/lookup')) return { results: [] };
    bodies.push(options.body);
    if (failures-- > 0) throw Object.assign(new Error('HTTP 504'), { status: 504, responseJSON: { code: 'arr_timeout', message: 'x' } });
    return { result: 'added', title: 'Man of Steel', instance: { name: 'Movies' } };
  });
  const opened = h.arr.openAddDialog(movie);
  const doc = h.document;
  const primary = () => doc.querySelector('.jellyseerr-modal-button-primary');
  const failedAttempts = (n) => until(() => bodies.length === n && !primary().disabled, `attempt ${n} failed`);
  await until(() => doc.querySelector('#je-lp-arr-root')?.value === '/movies', 'pickers');

  // 1: instance 0 (its answer got lost). 2: the admin switches to instance 1 and retries.
  primary().click();
  await failedAttempts(1);
  choose(h, '#je-lp-arr-instance', '1');
  primary().click();
  await failedAttempts(2);
  // 3: back to instance 0 with the first choices: the first id again, so the server can replay that add.
  choose(h, '#je-lp-arr-instance', '0');
  primary().click();
  await failedAttempts(3);
  // 4: same instance, other quality profile.
  choose(h, '#je-lp-arr-quality', '4');
  primary().click();
  await opened;

  assert.deepEqual(bodies.map((b) => [b.instance, b.qualityProfileId]), [[0, 1], [1, 7], [0, 1], [0, 4]]);
  const ids = bodies.map((b) => b.requestId);
  assert.ok(ids.every((id) => /^[A-Za-z0-9_-]{1,64}$/.test(id)));
  assert.notEqual(ids[1], ids[0]);
  assert.equal(ids[2], ids[0]);
  assert.notEqual(ids[3], ids[0]);
  assert.notEqual(ids[3], ids[1]);
});

test('dialog: Minimum availability follows the chosen instance, Released when it has no remembered value', async (t) => {
  const h = setup(t, async (path) => {
    if (path.includes('/options')) return TWO_RADARRS;
    if (path.includes('/lookup')) return { results: [] };
    throw new Error(path);
  });
  h.window.localStorage.setItem('je-lp-arr-choice:user-a', JSON.stringify({
    'radarr|aaaaaaaaaaaaaaaa': { qualityProfileId: 4, rootFolderPath: '/movies', minimumAvailability: 'announced' },
    'radarr:last': { identity: 'aaaaaaaaaaaaaaaa' },
    'radarr|bbbbbbbbbbbbbbbb': { qualityProfileId: 7, rootFolderPath: '/movies4k', minimumAvailability: 'bogus' }
  }));
  const opened = h.arr.openAddDialog(movie);
  const doc = h.document;
  const availability = () => doc.querySelector('#je-lp-arr-availability').value;
  await until(() => doc.querySelector('#je-lp-arr-quality')?.value === '4', 'remembered instance');
  assert.equal(availability(), 'announced');

  choose(h, '#je-lp-arr-instance', '1');
  assert.equal(availability(), 'released');

  choose(h, '#je-lp-arr-instance', '0');
  assert.equal(availability(), 'announced');
  doc.querySelector('.jellyseerr-modal-button-secondary').click();
  assert.equal(await opened, null);
});

test('result message: a search that could not be started says so', (t) => {
  const { arr } = setup(t, async () => ({}));
  const base = { title: 'Peace<maker>', instance: { name: 'TV <b>' } };
  const failed = arr.resultMessage({ ...base, result: 'monitoring_added', searched: false, searchFailed: true });
  assert.match(failed, /^Peace&lt;maker&gt;: monitoring added in TV &lt;b&gt;<br>/);
  assert.match(failed, /The search couldn't be started\. Start it in TV &lt;b&gt;\./);
  assert.doesNotMatch(failed, /TV <b>/);
  assert.match(arr.resultMessage({ ...base, result: 'added', searchFailed: true }), /Start it in TV &lt;b&gt;/);
  assert.doesNotMatch(arr.resultMessage({ ...base, result: 'added', searched: true }), /search couldn't/);
  assert.doesNotMatch(arr.resultMessage({ ...base, result: 'added', searched: false }), /search couldn't/);
});
