import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { createHarness } from '../helpers/harness.mjs';
import { repositoryRoot } from '../helpers/discovery.mjs';

// The configuration page's per-instance "When Jellyfin Enhanced adds a title" block (Requests &
// downloads, phase 3): its real helpers in a fresh realm against a scripted admin API.
const page = readFileSync(resolve(repositoryRoot, 'Jellyfin.Plugin.JellyfinEnhanced/Configuration/configPage.html'), 'utf8');
function block(start, end) {
  const from = page.indexOf(start);
  const to = page.indexOf(end, from);
  if (from < 0 || to < 0) throw new Error(`config page block not found: ${start}`);
  return page.slice(from, to);
}
const createEl = block('        function createEl(tag, attrs, children) {', '        // ==================== Stored credentials');
const helpers = block('        // ==================== Arr instance add defaults', '        /**\n         * Builds the registry fields of an instance card');
const plain = value => JSON.parse(JSON.stringify(value));

const options = {
  direct: false, reason: 'phase_off',
  profiles: [{ id: 4, name: 'HD-1080p' }, { id: 5, name: 'Ultra-HD' }],
  rootFolders: [{ path: '/data/movies', freeSpace: 1e12, accessible: true }, { path: '/data/old', accessible: false }],
  tags: [{ id: 2, name: 'je-requested' }, { id: 3, name: '<b>kids</b>' }],
  defaultsValid: false, defaultsMessage: 'Radarr has no quality profile and root folder set for adding titles.'
};

function setup(t, respond) {
  const requests = [];
  const h = createHarness({
    html: '<div id="host"></div>',
    apiClient: {
      ajax: async o => { requests.push(o); return respond(o); },
      getUrl: path => `http://jellyfin.test${path}`
    }
  });
  t.after(() => h.close());
  h.window.eval(`${createEl}\n${helpers}\nwindow.__je = { jeBuildInstanceAddDefaults, jeReadInstanceAddDefaults };`);
  return { ...h, je: h.window.__je, requests };
}

/** A card like createInstanceCard's (a <details> holding the block), opened or not. */
function card(h, type, row, open) {
  const details = h.document.createElement('details');
  details.className = 'arr-instance-card';
  details._jeRow = row;
  details.open = open;
  details.appendChild(h.je.jeBuildInstanceAddDefaults(type, row));
  h.document.getElementById('host').appendChild(details);
  return details;
}

async function until(check, ms = 2000) {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await wait(5);
  assert.ok(check(), 'condition not met in time');
}

test('a closed card asks nothing until it is opened, then offers only the instance\'s own choices and reads them back', async t => {
  const h = setup(t, async () => options);
  const row = { Id: 'r1', Name: 'Radarr', Defaults: { QualityProfileId: 42, RootFolderPath: '/data/movies', Tags: [3] } };
  const details = card(h, 'radarr', row, false);
  await wait(20);
  assert.equal(h.requests.length, 0);
  // Not loaded: whatever was stored is kept.
  assert.equal(h.je.jeReadInstanceAddDefaults(details), undefined);
  details.open = true;
  details.dispatchEvent(new h.window.Event('toggle'));
  await until(() => details.querySelector('.arr-instance-add').dataset.loaded === '1');
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].url, 'http://jellyfin.test/JellyfinEnhanced/arr/admin/manage/add-options?instanceId=r1');
  const profile = details.querySelector('.arr-instance-add-profile');
  // A stored profile the instance no longer lists stays visible (and selected) instead of being swapped for another.
  assert.deepEqual(plain([...profile.options].map(o => o.textContent)), ['Not set', 'HD-1080p', 'Ultra-HD', '42 (not in Radarr now)']);
  assert.equal(profile.value, '42');
  assert.equal(details.querySelector('.arr-instance-add-root').value, '/data/movies');
  assert.deepEqual(plain([...details.querySelector('.arr-instance-add-root').options].map(o => o.textContent)), ['Not set', '/data/movies', '/data/old (not accessible)']);
  assert.equal(details.querySelector('.arr-instance-add-availability').value, '');
  assert.equal(details.querySelector('.arr-instance-add-seriestype'), null);
  // Tag names are text, never markup.
  assert.equal(details.querySelector('.arr-instance-add-tags b'), null);
  assert.deepEqual(plain([...details.querySelectorAll('.arr-instance-add-tag')].map(cb => cb.checked)), [false, true]);
  assert.match(details.querySelector('.arr-instance-add-status').textContent, /no quality profile and root folder set/);

  profile.value = '5';
  details.querySelector('.arr-instance-add-availability').value = 'inCinemas';
  details.querySelectorAll('.arr-instance-add-tag')[0].checked = true;
  assert.deepEqual(plain(h.je.jeReadInstanceAddDefaults(details)), { QualityProfileId: 5, RootFolderPath: '/data/movies', Tags: [2, 3], MinimumAvailability: 'inCinemas' });
  // Clearing everything clears the defaults.
  profile.value = '';
  details.querySelector('.arr-instance-add-root').value = '';
  details.querySelector('.arr-instance-add-availability').value = '';
  details.querySelectorAll('.arr-instance-add-tag').forEach(cb => { cb.checked = false; });
  assert.equal(h.je.jeReadInstanceAddDefaults(details), null);
});

test('Sonarr offers a series type; an unsaved instance or a failed read keeps the stored defaults', async t => {
  const h = setup(t, async () => ({ ...options, tags: [], defaultsValid: true }));
  const sonarr = card(h, 'sonarr', { Id: 's1', Name: 'Sonarr', Defaults: { QualityProfileId: 4, RootFolderPath: '/data/movies', SeriesType: 'anime' } }, true);
  await until(() => sonarr.querySelector('.arr-instance-add').dataset.loaded === '1');
  assert.equal(sonarr.querySelector('.arr-instance-add-seriestype').value, 'anime');
  assert.equal(sonarr.querySelector('.arr-instance-add-availability'), null);
  assert.deepEqual(plain(h.je.jeReadInstanceAddDefaults(sonarr)), { QualityProfileId: 4, RootFolderPath: '/data/movies', Tags: [], SeriesType: 'anime' });

  const fresh = card(h, 'sonarr', { Name: 'New' }, true);
  await wait(20);
  assert.match(fresh.querySelector('.arr-instance-add-status').textContent, /Save this instance first/);
  assert.equal(h.je.jeReadInstanceAddDefaults(fresh), undefined);

  const failing = setup(t, async () => { throw { status: 403 }; });
  const stored = { Id: 'r2', Name: 'Radarr', Defaults: { QualityProfileId: 4, RootFolderPath: '/data/movies' } };
  const down = card(failing, 'radarr', stored, true);
  await until(() => /saved add defaults are kept/.test(down.querySelector('.arr-instance-add-status').textContent));
  assert.equal(failing.je.jeReadInstanceAddDefaults(down), undefined);
});
