import { clickAsViewer } from '../helpers/harness.mjs';
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
  let userChange;
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
      session: { getEpoch: () => 0, isCurrent: () => true, onUserChange: (_name, fn) => { userChange = fn; } }
    }
  });
  t.after(() => { h.JE.arrManage?.close(); h.close(); });
  for (const m of MODULES) h.load(m);
  h.JE.initializeArrStatus?.();
  return { ...h, get NATIVE() { return h.NATIVE; }, calls, switchUser: () => userChange() };
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
  await h.JE.arrManage.open({ key: 'movie:tmdb:961' }, { operation: h.NATIVE });
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
  await h.JE.arrManage.open({ key: 'movie:tmdb:961' }, { operation: h.NATIVE });
  await until(() => button(h, 'add-r4'));
  assert.equal(button(h, 'add-r4').tagName, 'BUTTON');
  assert.equal(button(h, 'add-r4').textContent, 'add_circle_outlineAdd to Radarr 4K');
  // The link to the arr stays next to it as a fallback.
  assert.equal(button(h, 'addlink-r4').getAttribute('href'), 'http://radarr4k:7878/add/new?term=tmdb%3A961');
  h.click(button(h, 'add-r4'));
  await until(() => button(h, 'add-profile-r4'));
  const optionsCall = h.calls.find(c => c.path.startsWith('/arr/admin/manage/add-options'));
  assert.equal(optionsCall.path, '/arr/admin/manage/add-options?instanceId=r4&key=movie%3Atmdb%3A961');
  assert.equal(button(h, 'add-profile-r4').value, '5');
  assert.equal(button(h, 'add-folder-r4').value, '/data/movies4k');
  assert.equal(h.document.activeElement, button(h, 'add-profile-r4'));
  // A folder the arr can't write to can't be chosen; free space is shown.
  const folders = [...button(h, 'add-folder-r4').options].map(o => [o.textContent, o.disabled]);
  assert.deepEqual(JSON.parse(JSON.stringify(folders)), [['Choose…', false], ['/data/movies4k · 383.7 GB free', false], ['/data/old · 954 MB free', true]]);
  h.click(button(h, 'add-submit-r4'));
  h.click(button(h, 'add-submit-r4'));   // a second tap while sending does nothing
  await until(() => h.document.querySelector('.je-manage-add-message')?.textContent === 'Added to Radarr 4K. It\'s monitored and being searched for.');
  assert.equal(posts.length, 1);
  assert.deepEqual({ ...posts[0], idempotencyKey: 'k' }, { instanceId: 'r4', key: 'movie:tmdb:961', profileId: 5, rootFolder: '/data/movies4k', seasons: undefined, idempotencyKey: 'k' });
  assert.ok(posts[0].idempotencyKey.length > 8);
  assert.equal(h.document.querySelector('.je-manage-add-message').getAttribute('role'), 'status');
  h.click(button(h, 'add-cancel-r4'));
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
  await h.JE.arrManage.open({ key: 'tv:tvdb:75565:s2' }, { operation: h.NATIVE });
  await until(() => button(h, 'add-r4'));
  h.click(button(h, 'add-r4'));
  await until(() => button(h, 'add-profile-r4'));
  assert.match(h.document.querySelector('.je-manage-add-warn').textContent, /saved add defaults can't be used: Radarr 4K no longer has the quality profile/);
  assert.equal(button(h, 'add-profile-r4').value, '');
  const seasonBoxes = [...h.document.querySelectorAll('.je-manage-add-season input')];
  assert.deepEqual(seasonBoxes.map(b => b.checked), [false, true, true]);
  assert.deepEqual(JSON.parse(JSON.stringify([...h.document.querySelectorAll('.je-manage-add-season')].map(l => l.textContent))), ['Specials', 'Season 1', 'Season 2']);
  // Nothing chosen: no request, a plain explanation.
  h.click(button(h, 'add-submit-r4'));
  assert.equal(posts.length, 0);
  assert.equal(h.document.querySelector('.je-manage-add-message').textContent, 'Choose a quality profile and a root folder.');
  const profile = button(h, 'add-profile-r4');
  profile.value = '4';
h.trusted(profile, new h.window.Event('change', { bubbles: true }));
  const folder = button(h, 'add-folder-r4');
  folder.value = '/data/movies4k';
h.trusted(folder, new h.window.Event('change', { bubbles: true }));
  seasonBoxes[2].checked = false;
h.trusted(seasonBoxes[2], new h.window.Event('change', { bubbles: true }));
  h.click(button(h, 'add-submit-r4'));
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
  await h.JE.arrManage.open({ key: 'movie:tmdb:961' }, { operation: h.NATIVE });
  await until(() => button(h, 'add-r4'));
  h.click(button(h, 'add-r4'));
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
  await h.JE.arrManage.open({ key: 'movie:tmdb:961' }, { operation: h.NATIVE });
  await until(() => button(h, 'add-r4'));
  h.click(button(h, 'add-r4'));
  await until(() => button(h, 'add-submit-r4'));
  h.click(button(h, 'add-submit-r4'));
  await until(() => h.document.querySelector('.je-manage-add-failed'));
  assert.equal(h.document.querySelector('.je-manage-add-failed').textContent, "Couldn't add it: Radarr 4K doesn't know this title");
  assert.equal(button(h, 'add-sheetlink-r4').tagName, 'A');
});


const queuedChoice = (version = 1, extra = {}) => ({ owner: 'admin-a', version, profileId: 4, rootFolder: '/data/movies4k', ...extra });
const choiceError = choice => Object.assign(new Error('HTTP 409'), { status: 409,
  responseJSON: { outcome: 'conflict', reason: 'choice_conflict', message: 'A queued choice exists.', choice } });

async function conflictSheet(t, respond = () => choiceError(queuedChoice()), user = () => ({ name: 'Alex <admin>' }), kind = 'movie') {
  const posts = [];
  const info = overview(true, kind);
  info.instances.push({ ...info.instances[1], id: 'other', name: 'Other Radarr' });
  const h = setup(t, (path, opts) => {
    if (path.startsWith('/arr/admin/manage?')) return info;
    if (path.startsWith('/arr/admin/manage/add-options')) return options(kind === 'movie' ? {} : {
      title: { title: "Blake's 7", seasons: [{ seasonNumber: 0 }, { seasonNumber: 1 }, { seasonNumber: 2 }] }
    });
    if (path.startsWith('/arr/admin/users/')) return user(path);
    if (path === '/arr/admin/manage/add') { posts.push(opts.body); return respond(posts.length, opts.body); }
    return null;
  });
  await h.JE.arrManage.open({ key: 'movie:tmdb:961' }, { operation: h.NATIVE });
  await until(() => button(h, 'add-r4'));
  clickAsViewer(button(h, 'add-r4'));
  await until(() => button(h, 'add-submit-r4'));
  clickAsViewer(button(h, 'add-submit-r4'));
  await until(() => posts.length === 1 && button(h, 'add-submit-r4')?.getAttribute('aria-disabled') !== 'true');
  return { h, posts };
}

test('a choice conflict shows the owner, named profile, literal root and version without automatically overriding', async t => {
  const { h, posts } = await conflictSheet(t, () => choiceError(queuedChoice(1, { rootFolder: '/movies/<queued>' })));
  await until(() => h.document.querySelector('.je-manage-add-conflict')?.textContent.includes('Alex <admin>'));
  const conflict = h.document.querySelector('.je-manage-add-conflict');
  assert.match(conflict.textContent, /HD-1080p/);
  assert.match(conflict.textContent, /\/movies\/<queued>/);
  assert.match(conflict.textContent, /Version 1/);
  assert.equal(conflict.querySelector('admin, queued'), null);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].overrideChoiceVersion, undefined);
  assert.equal(button(h, 'add-profile-r4').value, '5');
});

test('replacing requires a separate confirmation and a stale confirmation must show the new owner and version', async t => {
  const { h, posts } = await conflictSheet(t, n => n === 1 ? choiceError(queuedChoice()) :
    n === 2 ? choiceError(queuedChoice(2, { owner: 'admin-c' })) : { outcome: 'accepted' },
    path => ({ name: path.endsWith('admin-c') ? 'Casey' : 'Alex' }));
  assert.ok(button(h, 'add-replace-r4'));
  clickAsViewer(button(h, 'add-replace-r4'));
  assert.equal(posts.length, 1);
  assert.match(h.document.querySelector('.je-manage-add-confirm').textContent, /Replace this title's queued profile and folder\?/);
  assert.match(h.document.querySelector('.je-manage-add-confirm').textContent, /Ultra-HD/);
  assert.equal(button(h, 'add-profile-r4').disabled, true);
  clickAsViewer(button(h, 'add-confirm-r4'));
  await until(() => h.document.querySelector('.je-manage-add-conflict')?.textContent.includes('Casey'));
  assert.equal(posts[1].overrideChoiceVersion, 1);
  assert.equal(posts[1].profileId, 5);
  assert.match(h.document.querySelector('.je-manage-add-conflict').textContent, /Version 2/);
  assert.equal(button(h, 'add-confirm-r4'), null);
  assert.equal(posts.length, 2);
  clickAsViewer(button(h, 'add-replace-r4'));
  clickAsViewer(button(h, 'add-confirm-r4'));
  await until(() => h.document.querySelector('.je-manage-add-message')?.textContent.includes("hasn't confirmed it yet"));
  assert.equal(posts[2].overrideChoiceVersion, 2);
  assert.equal(h.document.querySelector('.je-manage-add-conflict'), null);
});

test('using queued settings submits matching fields with no override and preserves separate series seasons', async t => {
  const { h, posts } = await conflictSheet(t, n => n === 1 ? choiceError(queuedChoice()) : { outcome: 'accepted' }, undefined, 'tv');
  assert.ok(button(h, 'add-use-r4'));
  assert.match(h.document.querySelector('.je-manage-add-conflict').textContent, /Profile and folder apply to the whole series. Season selections stay separate./);
  clickAsViewer(button(h, 'add-use-r4'));
  await until(() => posts.length === 2);
  assert.equal(posts[1].profileId, 4);
  assert.equal(posts[1].rootFolder, '/data/movies4k');
  assert.equal(posts[1].overrideChoiceVersion, undefined);
  assert.deepEqual(posts[1].seasons, [1, 2]);
});

test('cancelling confirmation sends nothing and a normal submit never retains the override', async t => {
  const { h, posts } = await conflictSheet(t);
  assert.ok(button(h, 'add-replace-r4'));
  clickAsViewer(button(h, 'add-replace-r4'));
  clickAsViewer(button(h, 'add-keep-r4'));
  assert.equal(posts.length, 1);
  assert.equal(button(h, 'add-profile-r4').disabled, false);
  clickAsViewer(button(h, 'add-submit-r4'));
  await until(() => posts.length === 2);
  assert.equal(posts[1].overrideChoiceVersion, undefined);
});

for (const teardown of ['sheet', 'drawer', 'navigation', 'account', 'title', 'instance']) {
  test(`a pending replacement cannot survive ${teardown} changes or a detached confirmation click`, async t => {
    const { h, posts } = await conflictSheet(t);
    assert.ok(button(h, 'add-replace-r4'));
    clickAsViewer(button(h, 'add-replace-r4'));
    const confirm = button(h, 'add-confirm-r4');
    if (teardown === 'sheet') clickAsViewer(button(h, 'add-cancel-r4'));
    else if (teardown === 'drawer') h.JE.arrManage.close();
    else if (teardown === 'navigation') h.document.dispatchEvent(new h.window.Event('viewshow'));
    else if (teardown === 'account') h.switchUser();
    else if (teardown === 'instance') clickAsViewer(button(h, 'add-other'));
    else {
  await h.JE.arrManage.open({ key: 'movie:tmdb:962' }, { operation: h.NATIVE });
    }
    clickAsViewer(confirm);
    await wait(30);
    assert.equal(posts.length, 1);
    assert.equal(h.document.querySelector('.je-manage-add-confirm'), null);
  });
}

test('owner lookup failure keeps a usable confirmation with a translated fallback', async t => {
  const { h, posts } = await conflictSheet(t, undefined, () => Object.assign(new Error('not available'), { status: 404 }));
  assert.ok(button(h, 'add-replace-r4'));
  assert.match(h.document.querySelector('.je-manage-add-conflict').textContent, /Administrator unavailable/);
  assert.equal(posts.length, 1);
});

for (const choice of [null, queuedChoice('1'), queuedChoice(-1), queuedChoice(1.5), queuedChoice(1, { profileId: 0 }),
  queuedChoice(1, { profileId: '4' }), queuedChoice(1, { rootFolder: ' ' }), queuedChoice(1, { rootFolder: 5 }), queuedChoice(1, { owner: 7 })]) {
  test(`a malformed conflict cannot authorize replacement (${JSON.stringify(choice)})`, async t => {
    const { h, posts } = await conflictSheet(t, () => choiceError(choice));
    assert.equal(button(h, 'add-replace-r4'), null);
    assert.equal(button(h, 'add-confirm-r4'), null);
    assert.equal(posts[0].overrideChoiceVersion, undefined);
  });
}

test('a late owner lookup cannot repaint a closed drawer or replace a newer conflict owner', async t => {
  let resolveOwner;
  const firstOwner = new Promise(resolve => { resolveOwner = resolve; });
  const { h } = await conflictSheet(t, n => choiceError(queuedChoice(n, { owner: n === 1 ? 'admin-a' : 'admin-b' })),
    path => path.endsWith('admin-a') ? firstOwner : { name: 'Blair' });
  clickAsViewer(button(h, 'add-replace-r4'));
  clickAsViewer(button(h, 'add-confirm-r4'));
  await until(() => h.document.querySelector('.je-manage-add-conflict')?.textContent.includes('Blair'));
  resolveOwner({ name: 'Outdated admin' });
  await wait(30);
  assert.doesNotMatch(h.document.querySelector('.je-manage-add-conflict').textContent, /Outdated admin/);
  h.JE.arrManage.close();
  assert.equal(h.document.querySelector('.je-manage-add-conflict'), null);
});

test('an immutable queued request retains server guidance and drops the previous replacement confirmation', async t => {
  const { h, posts } = await conflictSheet(t, n => n === 1 ? choiceError(queuedChoice()) : Object.assign(new Error('HTTP 409'), {
    status: 409, responseJSON: { reason: 'request_in_flight', message: 'Already sending. Check the title in Manage.' }
  }));
  clickAsViewer(button(h, 'add-replace-r4'));
  clickAsViewer(button(h, 'add-confirm-r4'));
  await until(() => h.document.querySelector('.je-manage-add-message')?.textContent.includes('Already sending.'));
  assert.equal(h.document.querySelector('.je-manage-add-conflict'), null);
  clickAsViewer(button(h, 'add-submit-r4'));
  await until(() => posts.length === 3);
  assert.equal(posts[1].overrideChoiceVersion, 1);
  assert.equal(posts[2].overrideChoiceVersion, undefined);
});

test('an unavailable queued profile is named by id and cannot be adopted from stale options', async t => {
  const { h, posts } = await conflictSheet(t, () => choiceError(queuedChoice(1, { profileId: 99 })));
  assert.match(h.document.querySelector('.je-manage-add-conflict').textContent, /Profile 99/);
  assert.equal(button(h, 'add-use-r4').disabled, true);
  assert.ok(button(h, 'add-replace-r4'));
  assert.equal(posts.length, 1);
});

// The server's RequestChoice contract (LR-1): profile and folder are nullable, the owner of an identity
// split is the empty GUID, and a split before the first job is revision 0 (TitleChoiceRoundFiveTests).
const EMPTY_OWNER = '00000000-0000-0000-0000-000000000000';
const splitChoice = version => ({ owner: EMPTY_OWNER, version, profileId: null, rootFolder: null });

for (const version of [0, 3]) {
  test(`an identity split at revision ${version} reaches an explicit confirmation bound to that revision`, async t => {
    const { h, posts } = await conflictSheet(t, n => n === 1 ? choiceError(splitChoice(version)) : { outcome: 'accepted' });
    assert.ok(button(h, 'add-replace-r4'), 'replace offered');
    const conflict = h.document.querySelector('.je-manage-add-conflict');
    assert.match(conflict.textContent, new RegExp(translate('arr_manage_add_choice_heading_unowned')));
    assert.match(conflict.textContent, /No profile queued/);
    assert.match(conflict.textContent, /No folder queued/);
    assert.match(conflict.textContent, new RegExp(`Version ${version}`));
    assert.equal(button(h, 'add-use-r4'), null, 'nothing queued to adopt');
    assert.equal(conflict.querySelector('.je-manage-add-choice-root'), null, 'the fallback is not styled as a path');
    assert.equal(h.calls.filter(c => c.path.startsWith('/arr/admin/users/')).length, 0, 'no lookup of the empty owner');
    assert.match(h.document.querySelector('.je-manage-add-message').textContent, /explicit confirmation/);
    clickAsViewer(button(h, 'add-replace-r4'));
    assert.equal(posts.length, 1, 'replace alone sends nothing');
    clickAsViewer(button(h, 'add-confirm-r4'));
    await until(() => posts.length === 2);
    assert.equal(posts[1].overrideChoiceVersion, version);
    assert.equal(posts[1].profileId, 5);
    assert.equal(posts[1].rootFolder, '/data/movies4k');
    assert.equal(posts[1].idempotencyKey, posts[0].idempotencyKey);
    await until(() => h.document.querySelector('.je-manage-add-message')?.textContent.includes("hasn't confirmed it yet"));
    assert.equal(h.document.querySelector('.je-manage-add-conflict'), null);
    clickAsViewer(button(h, 'add-cancel-r4'));
    clickAsViewer(button(h, 'add-r4'));
    await until(() => button(h, 'add-submit-r4'));
    clickAsViewer(button(h, 'add-submit-r4'));
    await until(() => posts.length === 3);
    assert.equal(posts[2].overrideChoiceVersion, undefined, 'the revision binds one send only');
  });
}

test('a partial owned choice shows the missing field, adopts the queued one and keeps the sheet selection for the rest', async t => {
  const { h, posts } = await conflictSheet(t, n => n === 1 ? choiceError(queuedChoice(2, { profileId: 4, rootFolder: null })) : { outcome: 'accepted' });
  await until(() => h.document.querySelector('.je-manage-add-conflict')?.textContent.includes('Alex <admin>'));
  const conflict = h.document.querySelector('.je-manage-add-conflict');
  assert.match(conflict.textContent, /HD-1080p \(profile 4\)/);
  assert.match(conflict.textContent, /No folder queued/);
  assert.match(conflict.textContent, /Version 2/);
  assert.ok(button(h, 'add-replace-r4'));
  assert.equal(button(h, 'add-use-r4').disabled, false);
  clickAsViewer(button(h, 'add-use-r4'));
  await until(() => posts.length === 2);
  assert.equal(posts[1].profileId, 4);
  assert.equal(posts[1].rootFolder, '/data/movies4k');
  assert.equal(posts[1].overrideChoiceVersion, undefined);
});

test('a partial choice can be explicitly replaced at its revision, and only adoption depends on current options', async t => {
  const { h, posts } = await conflictSheet(t, n => n === 1 ? choiceError(queuedChoice(4, { profileId: null, rootFolder: '/gone' })) : { outcome: 'accepted' });
  const conflict = h.document.querySelector('.je-manage-add-conflict');
  assert.match(conflict.textContent, /No profile queued/);
  assert.match(conflict.textContent, /\/gone/);
  assert.equal(button(h, 'add-use-r4').disabled, true);
  assert.match(conflict.textContent, /no longer available/);
  clickAsViewer(button(h, 'add-replace-r4'));
  clickAsViewer(button(h, 'add-confirm-r4'));
  await until(() => posts.length === 2);
  assert.equal(posts[1].overrideChoiceVersion, 4);
});

test('a choice without an owner field still offers confirmation with the unowned wording', async t => {
  const { h, posts } = await conflictSheet(t, n => n === 1 ? choiceError({ version: 0 }) : { outcome: 'accepted' });
  assert.ok(button(h, 'add-replace-r4'));
  assert.match(h.document.querySelector('.je-manage-add-conflict').textContent, new RegExp(translate('arr_manage_add_choice_heading_unowned')));
  clickAsViewer(button(h, 'add-replace-r4'));
  clickAsViewer(button(h, 'add-confirm-r4'));
  await until(() => posts.length === 2);
  assert.equal(posts[1].overrideChoiceVersion, 0);
});

// Phase 2 F36: a title no arr has yet has no name in the overview; the drawer's heading is then the opener's name for the
// title, or the plain "Manage" — never the title key.
test('F36: the drawer heading never shows the title key: the opener\'s name, else a plain "Manage"', async t => {
  const unnamed = () => ({ ...overview(true), title: null, instances: overview(true).instances.map(i => ({ ...i, inArr: false, arrId: undefined })) });
  const keyOnly = setup(t, path => (path.startsWith('/arr/admin/manage?') ? unnamed() : null));
  await keyOnly.JE.arrManage.open({ key: 'movie:tmdb:961' }, { operation: keyOnly.NATIVE });
  await until(() => keyOnly.document.querySelector('.je-manage-version'));
  const heading = keyOnly.document.querySelector('.je-manage-title').textContent;
  assert.equal(heading, translate('arr_manage_button'));
  assert.doesNotMatch(heading, /tmdb|movie:/);
  keyOnly.JE.arrManage.close();

  const named = setup(t, path => (path.startsWith('/arr/admin/manage?') ? unnamed() : null));
  await named.JE.arrManage.open({ key: 'movie:tmdb:961', name: 'The General' }, { operation: named.NATIVE });
  await until(() => named.document.querySelector('.je-manage-version'));
  assert.equal(named.document.querySelector('.je-manage-title').textContent, translate('arr_manage_title', { title: 'The General' }));
});

test('F36 control: the arr\'s own name wins over the opener\'s, with the scope after it', async t => {
  const h = setup(t, path => (path.startsWith('/arr/admin/manage?') ? overview(true, 'tv') : null));
  await h.JE.arrManage.open({ key: 'tv:tvdb:75565:s2', name: 'Something else' }, { operation: h.NATIVE });
  await until(() => h.document.querySelector('.je-manage-version'));
  assert.equal(h.document.querySelector('.je-manage-title').textContent, translate('arr_manage_title', { title: `Blake's 7 · ${translate('arr_hub_season', { list: 2 })}` }));
});

test('F36: the details page\'s own Manage button names the drawer after the page\'s title', async t => {
  const unnamed = { ...overview(true), title: null, instances: overview(true).instances.map(i => ({ ...i, inArr: false, arrId: undefined })) };
  const h = setup(t, path => (path.startsWith('/arr/admin/manage?') ? unnamed : null));
  const page = h.document.createElement('div');
  page.innerHTML = '<div class="nameContainer"><h1 class="itemName">The General</h1><h4 class="itemName originalTitle">El General</h4></div><div class="mainDetailButtons"></div>';
  h.document.body.appendChild(page);
  h.JE.internals.arrManage.attachDetails(page, { admin: {}, itemId: 'f5e445a8368ae1b1bb5d6378ddd7b68d', key: 'movie:tmdb:961' });
  const button = page.querySelector('.je-manage-open');
  assert.ok(button);
  h.click(button);
  await until(() => h.document.querySelector('.je-manage-version'));
  assert.equal(h.document.querySelector('.je-manage-title').textContent, translate('arr_manage_title', { title: 'The General' }));
});
