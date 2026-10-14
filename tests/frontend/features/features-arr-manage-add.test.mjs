// Requests & downloads, phase 3: the Manage drawer's direct "Add to {instance}" — a sheet with the
// instance's own profiles, folders and the title's seasons (GET /arr/admin/manage/add-options), the
// add through the request outbox (POST /arr/admin/manage/add) followed until it settles, and the
// link to the arr kept as a fallback. Rendered by the real modules from scripted server answers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { createHarness, jsRoot } from '../helpers/harness.mjs';

const en = JSON.parse(readFileSync(resolve(jsRoot, 'locales/en.json'), 'utf8'));
const MODULES = ['arr/status/status-core.js', 'arr/status/status-styles.js', 'arr/manage/manage-styles.js', 'arr/manage/manage-drawer.js'];

function translate(key, params) {
  const text = en[key];
  if (text === undefined) throw new Error(`missing en.json key ${key}`);
  return Object.entries(params || {}).reduce((s, [k, v]) => s.split(`{${k}}`).join(String(v)), text);
}

function setup(t, responses) {
  const calls = [];
  const h = createHarness({
    html: '<div class="mainAnimatedPages"></div>',
    url: 'http://jellyfin.test/web/index.html#/home',
    apiClient: { getCurrentUserId: () => '0123456789abcdef0123456789abcdef', serverAddress: () => 'http://jellyfin.test' },
    JE: {
      pluginConfig: { ArrStatusEnabled: true, ArrManageDrawerEnabled: true },
      t: translate,
      helpers: { debounce: fn => fn },
      core: {
        api: {
          plugin: async (path, options) => {
            calls.push({ path, options });
            const answer = responses(path, options, calls);
            if (answer instanceof Error) throw answer;
            return answer;
          }
        },
        navigation: { onNavigate: () => () => {}, onViewPage: () => () => {} },
        lifecycle: { register: () => ({ track: x => x }) }
      },
      arr: { live: { position: () => ({ epoch: 'e1', cursor: 1 }) }, onStatusChange: () => () => {} },
      session: { getEpoch: () => 0, isCurrent: () => true, onUserChange: () => {} }
    }
  });
  t.after(() => { h.JE.arrManage?.close(); h.close(); });
  for (const m of MODULES) h.load(m);
  h.JE.initializeArrStatus?.();
  return { ...h, calls };
}

async function until(check, ms = 4000) {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await wait(10);
  assert.ok(check(), 'condition not met in time');
}

const overview = (addDirect, kind = 'movie') => ({
  key: kind === 'movie' ? 'movie:tmdb:961' : 'tv:tvdb:75565:s2', kind, title: kind === 'movie' ? 'The General' : "Blake's 7", season: kind === 'movie' ? undefined : 2, tmdbId: 961, tvdbId: 75565, addDirect,
  instances: [
    { id: 'r1', name: 'Radarr', kind: kind === 'movie' ? 'Radarr' : 'Sonarr', role: 'standard', url: 'http://radarr:7878', urlMappings: '', readable: true, inArr: true, arrId: 3, queue: [], timeline: [], monitored: true },
    { id: 'r4', name: 'Radarr 4K', kind: kind === 'movie' ? 'Radarr' : 'Sonarr', role: '4k', url: 'http://radarr4k:7878', urlMappings: '', readable: true, inArr: false, queue: [], timeline: [] }
  ],
  requests: []
});

const options = (extra = {}) => ({
  direct: true, instance: { id: 'r4', name: 'Radarr 4K', kind: 'Radarr', role: '4k' },
  profiles: [{ id: 4, name: 'HD-1080p' }, { id: 5, name: 'Ultra-HD' }],
  rootFolders: [{ path: '/data/movies4k', freeSpace: 412e9, accessible: true }, { path: '/data/old', freeSpace: 1e9, accessible: false }],
  tags: [], defaults: { qualityProfileId: 5, rootFolderPath: '/data/movies4k', tags: [] }, defaultsValid: true,
  title: { title: 'The General', year: 1926, inArr: false },
  ...extra
});

const button = (h, focus) => h.document.querySelector(`[data-je-focus="${focus}"]`);

test('without the direct add the version row keeps the link to the arr', async t => {
  const h = setup(t, path => (path.startsWith('/arr/admin/manage?') ? overview(false) : null));
  await h.JE.arrManage.open({ key: 'movie:tmdb:961' });
  await until(() => button(h, 'add-r4'));
  const link = button(h, 'add-r4');
  assert.equal(link.tagName, 'A');
  assert.equal(link.getAttribute('href'), 'http://radarr4k:7878/add/new?term=tmdb%3A961');
  assert.equal(h.calls.filter(c => c.path.startsWith('/arr/admin/manage/add')).length, 0);
});

test('the add sheet preselects only the saved defaults, sends one idempotency key and follows the request to "added"', async t => {
  const posts = [];
  let reads = 0;
  const h = setup(t, (path, opts) => {
    if (path.startsWith('/arr/admin/manage?')) return overview(true);
    if (path.startsWith('/arr/admin/manage/add-options')) return options();
    if (path === '/arr/admin/manage/add') { posts.push(opts.body); return { outcome: 'accepted', reason: 'queued_outage', requestId: 'req1' }; }
    if (path === '/acquire/requests?view=mine') {
      reads++;
      return { items: [{ id: 'req1', status: reads < 2 ? 'queued' : 'sent', reason: 'looking', jobs: [{ id: 'j1', state: reads < 2 ? 'sending' : 'succeeded', reason: 'looking' }] }] };
    }
    return null;
  });
  await h.JE.arrManage.open({ key: 'movie:tmdb:961' });
  await until(() => button(h, 'add-r4'));
  assert.equal(button(h, 'add-r4').tagName, 'BUTTON');
  assert.equal(button(h, 'add-r4').textContent, 'add_circle_outlineAdd to Radarr 4K');
  // The link to the arr stays next to it as a fallback.
  assert.equal(button(h, 'addlink-r4').getAttribute('href'), 'http://radarr4k:7878/add/new?term=tmdb%3A961');
  button(h, 'add-r4').click();
  await until(() => button(h, 'add-profile-r4'));
  const optionsCall = h.calls.find(c => c.path.startsWith('/arr/admin/manage/add-options'));
  assert.equal(optionsCall.path, '/arr/admin/manage/add-options?instanceId=r4&key=movie%3Atmdb%3A961');
  assert.equal(button(h, 'add-profile-r4').value, '5');
  assert.equal(button(h, 'add-folder-r4').value, '/data/movies4k');
  assert.equal(h.document.activeElement, button(h, 'add-profile-r4'));
  // A folder the arr can't write to can't be chosen; free space is shown.
  const folders = [...button(h, 'add-folder-r4').options].map(o => [o.textContent, o.disabled]);
  assert.deepEqual(JSON.parse(JSON.stringify(folders)), [['Choose…', false], ['/data/movies4k · 383.7 GB free', false], ['/data/old · 954 MB free', true]]);
  button(h, 'add-submit-r4').click();
  button(h, 'add-submit-r4').click();   // a second tap while sending does nothing
  await until(() => h.document.querySelector('.je-manage-add-message')?.textContent === 'Added to Radarr 4K. It\'s monitored and being searched for.');
  assert.equal(posts.length, 1);
  assert.deepEqual({ ...posts[0], idempotencyKey: 'k' }, { instanceId: 'r4', key: 'movie:tmdb:961', profileId: 5, rootFolder: '/data/movies4k', seasons: undefined, idempotencyKey: 'k' });
  assert.ok(posts[0].idempotencyKey.length > 8);
  assert.equal(h.document.querySelector('.je-manage-add-message').getAttribute('role'), 'status');
  button(h, 'add-cancel-r4').click();
  await until(() => !h.document.querySelector('.je-manage-add'));
});

test('a series sheet lists the seasons (specials off by default) and nothing is guessed when the defaults are unusable', async t => {
  const posts = [];
  const h = setup(t, (path, opts) => {
    if (path.startsWith('/arr/admin/manage?')) return overview(true, 'tv');
    if (path.startsWith('/arr/admin/manage/add-options')) {
      return options({ instance: { id: 'r4', name: 'Radarr 4K', kind: 'Sonarr', role: '4k' }, defaults: { qualityProfileId: 42 }, defaultsValid: false, defaultsMessage: 'Radarr 4K no longer has the quality profile chosen for adding titles (id 42).',
        title: { title: "Blake's 7", inArr: false, seasons: [{ seasonNumber: 0 }, { seasonNumber: 1 }, { seasonNumber: 2 }] } });
    }
    if (path === '/arr/admin/manage/add') { posts.push(opts.body); return Object.assign(new Error('HTTP 400'), { status: 400, responseJSON: { outcome: 'denied', reason: 'invalid_defaults', message: 'x' } }); }
    return null;
  });
  await h.JE.arrManage.open({ key: 'tv:tvdb:75565:s2' });
  await until(() => button(h, 'add-r4'));
  button(h, 'add-r4').click();
  await until(() => button(h, 'add-profile-r4'));
  assert.match(h.document.querySelector('.je-manage-add-warn').textContent, /saved add defaults can't be used: Radarr 4K no longer has the quality profile/);
  assert.equal(button(h, 'add-profile-r4').value, '');
  const seasonBoxes = [...h.document.querySelectorAll('.je-manage-add-season input')];
  assert.deepEqual(seasonBoxes.map(b => b.checked), [false, true, true]);
  assert.deepEqual(JSON.parse(JSON.stringify([...h.document.querySelectorAll('.je-manage-add-season')].map(l => l.textContent))), ['Specials', 'Season 1', 'Season 2']);
  // Nothing chosen: no request, a plain explanation.
  button(h, 'add-submit-r4').click();
  assert.equal(posts.length, 0);
  assert.equal(h.document.querySelector('.je-manage-add-message').textContent, 'Choose a quality profile and a root folder.');
  const profile = button(h, 'add-profile-r4');
  profile.value = '4';
  profile.dispatchEvent(new h.window.Event('change'));
  const folder = button(h, 'add-folder-r4');
  folder.value = '/data/movies4k';
  folder.dispatchEvent(new h.window.Event('change'));
  seasonBoxes[2].checked = false;
  seasonBoxes[2].dispatchEvent(new h.window.Event('change'));
  button(h, 'add-submit-r4').click();
  await until(() => posts.length === 1 && /Couldn't add it/.test(h.document.querySelector('.je-manage-add-message')?.textContent || ''));
  assert.deepEqual(posts[0].seasons, [1]);
  assert.equal(posts[0].profileId, 4);
  assert.equal(h.document.querySelector('.je-manage-add-message').textContent, 'Couldn\'t add it: check Radarr 4K\'s quality profile and root folder');
  // The form stays, so the administrator can correct it.
  assert.ok(button(h, 'add-submit-r4'));
});

test('when the server says a direct add is not offered, the sheet explains and links to the arr', async t => {
  const h = setup(t, path => {
    if (path.startsWith('/arr/admin/manage?')) return overview(true);
    if (path.startsWith('/arr/admin/manage/add-options')) return { direct: false, reason: 'snapshot_unavailable', message: "Radarr 4K's profiles and root folders couldn't be read just now." };
    return null;
  });
  await h.JE.arrManage.open({ key: 'movie:tmdb:961' });
  await until(() => button(h, 'add-r4'));
  button(h, 'add-r4').click();
  await until(() => h.document.querySelector('.je-manage-add-warn'));
  assert.equal(h.document.querySelector('.je-manage-add-warn').textContent, "Radarr 4K's profiles and root folders couldn't be read just now.");
  assert.equal(button(h, 'add-sheetlink-r4').getAttribute('href'), 'http://radarr4k:7878/add/new?term=tmdb%3A961');
  assert.equal(button(h, 'add-submit-r4'), null);
  assert.equal(h.document.activeElement, button(h, 'add-cancel-r4'));
});

test('a held add says why (the request is parked for the administrator)', async t => {
  const h = setup(t, path => {
    if (path.startsWith('/arr/admin/manage?')) return overview(true);
    if (path.startsWith('/arr/admin/manage/add-options')) return options();
    if (path === '/arr/admin/manage/add') return { outcome: 'accepted', reason: 'queued_outage', requestId: 'req9' };
    if (path === '/acquire/requests?view=mine') return { items: [{ id: 'req9', status: 'pending', reason: 'not_aired', jobs: [{ id: 'j', state: 'parked', reason: 'title_not_found' }] }] };
    return null;
  });
  await h.JE.arrManage.open({ key: 'movie:tmdb:961' });
  await until(() => button(h, 'add-r4'));
  button(h, 'add-r4').click();
  await until(() => button(h, 'add-submit-r4'));
  button(h, 'add-submit-r4').click();
  await until(() => h.document.querySelector('.je-manage-add-failed'));
  assert.equal(h.document.querySelector('.je-manage-add-failed').textContent, "Couldn't add it: Radarr 4K doesn't know this title");
  assert.equal(button(h, 'add-sheetlink-r4').tagName, 'A');
});
