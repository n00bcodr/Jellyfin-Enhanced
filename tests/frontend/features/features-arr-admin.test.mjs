// Requests & downloads, phase 2: the administrator's Overview / Activity / System / Audit tabs of the
// Requests page and their actions, rendered by the real modules from server answers; plus the new
// "OK'd in Seerr, not in any Sonarr/Radarr" reason in the shared status pill.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { createHarness, jsRoot } from '../helpers/harness.mjs';

const en = JSON.parse(readFileSync(resolve(jsRoot, 'locales/en.json'), 'utf8'));
const MODULES = [
  'arr/status/status-core.js', 'arr/status/status-styles.js',
  'arr/manage/manage-styles.js', 'arr/manage/manage-drawer.js',
  'arr/hub/hub-styles.js', 'arr/hub/hub-render.js',
  'arr/admin/admin-styles.js', 'arr/admin/admin-render.js', 'arr/admin/admin-tabs.js',
  'arr/hub/hub-page.js'
];
const USER = '0123456789abcdef0123456789abcdef';

function translate(key, params) {
  const text = en[key];
  if (text === undefined) throw new Error(`missing en.json key ${key}`);
  return Object.entries(params || {}).reduce((s, [k, v]) => s.split(`{${k}}`).join(String(v)), text);
}

function setup(t, { hash = '#/requests?tab=overview', responses = () => null, hub = true, seerrBase = 'http://seerr.test', feed = null } = {}) {
  const calls = [];
  const h = createHarness({
    html: '<div class="mainDrawer"><div class="jellyfinEnhancedSection"></div></div><div class="mainAnimatedPages"><div class="mainAnimatedPage" id="homePage"></div></div>',
    url: `http://jellyfin.test/web/index.html${hash}`,
    apiClient: { getCurrentUserId: () => USER, serverAddress: () => 'http://jellyfin.test' },
    JE: {
      pluginConfig: { ArrStatusEnabled: true, ArrRequestsHubEnabled: true, ArrManageDrawerEnabled: true },
      t: translate,
      helpers: { debounce: fn => fn, onSidebarRebuilt: () => {} },
      jellyseerrAPI: { resolveJellyseerrBaseUrl: () => seerrBase },
      core: {
        api: {
          plugin: async (path, options) => {
            calls.push({ path, options });
            if (path === '/acquire/hub') return hubAnswer(hub);
            const answer = responses(path, options, calls.length);
            if (answer instanceof Error) throw answer;
            return answer;
          }
        },
        navigation: { onNavigate: () => () => {}, onViewPage: () => () => {} },
        lifecycle: { register: () => ({ track: x => x }) }
      },
      arr: {
        live: { position: () => ({ epoch: 'e1', cursor: 1 }) },
        onStatusChange: (keys, cb) => {
          const sub = { keys, cb, off: false };
          feed?.push(sub);
          return () => { sub.off = true; };
        }
      },
      calendarPage: { renderForCustomTab: () => {} },
      downloadsPage: { renderForCustomTab: () => {} },
      session: { getEpoch: () => 0, isCurrent: () => true, onUserChange: () => {} }
    }
  });
  t.after(() => {
    h.JE.internals?.arrHub?.admin?.leave?.();
    h.close();
  });
  for (const m of MODULES) h.load(m);
  return { ...h, calls };
}

const hubAnswer = (hub) => ({
  contact: 'Dad', lookingHours: 24, seerr: { configured: true, loaded: true, unavailable: false },
  mine: [], soon: [], ready: [],
  ...(hub === null ? {} : { admin: { downloads: true, calendar: true, hub } })
});

async function until(check, ms = 3000) {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await wait(10);
}

const iso = minutes => new Date(Date.now() + minutes * 60000).toISOString();
const card = (id, name, kind, extra = {}) => ({
  id, name, kind, role: 'standard', url: `http://${kind.toLowerCase()}:7878`, urlMappings: `http://jellyfin.test|https://${kind.toLowerCase()}.example`,
  version: '6.0.4', live: { expected: true, connection: { state: 'Connected', since: iso(-60) }, webhook: false }, queue: 1, queueAttention: 1,
  health: 'ok', healthIssues: 0, disks: [{ path: '/data/movies4k', usedPercent: 94, free: 412e9, total: 7e12, low: true, accessible: true }], ...extra
});
const overview = () => ({
  instances: [card('r1', 'Radarr', 'Radarr'), card('s1', 'Sonarr', 'Sonarr')],
  needsAttention: [
    { id: 'a1', code: 'import_blocked', severity: 'error', instanceId: 's1', instance: 'Sonarr', title: 'Peacemaker', scope: 'S02E05', since: iso(-41), message: 'Manual Import required.', fixes: ['open_in_arr', 'remove_search'], arrLink: '/activity/queue', downloadId: 'dlA' },
    { id: 'a2', code: 'import_waiting', severity: 'warning', instanceId: 'r1', instance: 'Radarr', title: 'Cosmos', year: 2015, since: iso(-5), message: 'Sample', fixes: ['retry_import', 'open_in_arr', 'remove_search'], arrLink: '/activity/queue', downloadId: 'dlB' },
    { id: 'a3', code: 'download_failed', severity: 'error', instanceId: 'r1', instance: 'Radarr', title: 'Detour', key: 'movie:tmdb:20367', since: iso(-30), fixes: ['search_now', 'open_in_arr'], arrLink: '/activity/history' },
    { id: 'a4', code: 'not_in_jellyfin', severity: 'warning', instanceId: 's1', instance: 'Sonarr', title: 'The Flash', scope: 'S09E05', since: iso(-12), message: 'not_scanned', detail: '/media/tv/The Flash/Season 09/E05.mkv', fixes: ['scan_now', 'open_system'], arrPath: '/data/tv/The Flash/Season 09/E05.mkv' },
    { id: 'a5', code: 'low_disk', severity: 'warning', instanceId: 'r1', instance: 'Radarr', title: '/data/movies4k', params: { used: '94', free: '412000000000' }, fixes: ['open_system'] },
    { id: 'a6', code: 'approved_not_in_arr', severity: 'warning', title: '<img src=x onerror=alert(1)>', year: 2010, key: 'movie:tmdb:27205', since: iso(-20), message: 'Emma', fixes: ['open_seerr'] },
    { id: 'a7', code: 'download_stalled', severity: 'warning', instanceId: 'r1', instance: 'Radarr', title: 'Plan 9', since: iso(-50), params: { pct: '35' }, fixes: ['remove_search', 'open_in_arr'], arrLink: '/activity/queue', downloadId: 'dlC' }
  ],
  next24h: [{ title: 'Severance', season: 3, episode: 6, at: iso(600), instance: 'Sonarr', monitored: true, hasFile: false }],
  downloading: 7, waitingForOk: 3,
  days: Array.from({ length: 14 }, (_, i) => ({ date: `2026-10-${String(i + 1).padStart(2, '0')}`, grabs: i % 3, imports: i % 2 })),
  seerr: true
});
const activity = () => ({
  instances: [card('r1', 'Radarr', 'Radarr'), card('s1', 'Sonarr', 'Sonarr')],
  queue: [
    { instanceId: 's1', instance: 'Sonarr', kind: 'Sonarr', downloadId: 'pack', ids: [1, 2, 3], title: 'Peacemaker', scope: 'S02E01–E03', episodes: 3, status: 'warning', state: 'downloading', health: 'warning', percent: 37, size: 3e9, client: 'Mock SABnzbd', quality: 'WEBDL-1080p', release: 'Peacemaker.S02.1080p-GRP', messages: ['client reports no peers'], problem: 'download_warning', actions: ['remove', 'remove_with_data', 'search'] },
    { instanceId: 'r1', instance: 'Radarr', kind: 'Radarr', downloadId: 'dlB', ids: [9], title: 'Cosmos', year: 2015, episodes: 0, status: 'completed', state: 'importPending', health: 'warning', percent: 100, messages: ['Sample'], problem: 'import_waiting', actions: ['remove', 'remove_with_data', 'search', 'retry_import'] }
  ],
  history: [{ instanceId: 'r1', instance: 'Radarr', event: 'downloadFolderImported', title: 'Sintel', date: iso(-90), quality: 'Bluray-1080p' }, { instanceId: 'r1', instance: 'Radarr', event: 'somethingNew', title: 'X', date: iso(-95) }]
});
const system = () => ({
  instances: [{ card: card('r1', 'Radarr', 'Radarr', { live: { expected: true, connection: { state: 'Waiting', since: iso(-15), lastError: 'Connection refused' }, webhook: true, webhookSilent: true, webhookAccepted: 3, webhookRefused: 1 } }), appName: 'Radarr', health: [{ source: 'UpdateCheck', type: 'warning', message: 'New update is available' }], diskSpace: [], tasks: [{ name: 'RSS Sync', interval: 30, lastExecution: iso(-10), nextExecution: iso(20) }] }],
  seerr: { lastReadAt: iso(-1), lastError: null }, seerrRequests: 15,
  bridge: {
    targetedRefresh: true, refreshes: 4, found: 4,
    recent: [{ at: iso(-2), jellyfinPath: '/media/tv/Firefly/Season 01/E4.mkv', folder: '/media/tv/Firefly/Season 01', outcome: 'refresh', found: true, ms: 140 }, { at: iso(-3), jellyfinPath: '/media/tv/New/S01/E1.mkv', folder: '/media/tv', outcome: 'library_root', found: false, ms: 0 }],
    notInJellyfin: [{ instanceId: 's1', instance: 'Sonarr', title: 'Firefly', season: 1, episode: 5, arrPath: '/data/tv/Firefly/Season 01/E5.mkv', jellyfinPath: '/media/tv/Firefly/Season 01/E5.mkv', importedAt: iso(-15), problem: 'not_scanned', library: 'Shows' }],
    missingTitles: { titles: [{ instanceId: 'r1', instance: 'Radarr', title: 'Dune', year: 2021, jellyfinPath: '/data/movies/Dune', problem: 'outside_library' }], counts: { r1: 1 } },
    pathDoctor: [{ instanceId: 'r1', instance: 'Radarr', verdict: 'problem', mappings: [], roots: [{ arrPath: '/data/movies', jellyfinPath: '/data/movies', mapped: false, exists: false, problem: 'not_visible' }], samples: [{ title: 'Sintel', arrPath: '/data/movies/Sintel', expected: '/data/movies/Sintel', actual: '/rigmedia/movies/Sintel', match: false }], suggestion: { arrPath: '/data', jellyfinPath: '/rigmedia' } }]
  },
  settings: { libraryPendingMinutes: 10, lowDiskPercent: 10, seerrHandoffGraceMinutes: 15 }
});

test('every key the admin tabs use exists in en.json, including every code, fix, problem and outcome they show', () => {
  const source = ['arr/admin/admin-render.js', 'arr/admin/admin-tabs.js', 'arr/manage/manage-drawer.js'].map(m => readFileSync(resolve(jsRoot, m), 'utf8')).join('\n');
  const keys = [...source.matchAll(/'(arr_[a-z0-9_]+)'/g)].map(m => m[1]);
  assert.ok(keys.length > 80, String(keys.length));
  for (const key of keys) assert.ok(key in en, key);
  const families = {
    arr_ops_code_: ['import_blocked', 'import_waiting', 'download_failed', 'download_warning', 'download_stalled', 'client_unavailable', 'low_disk', 'root_missing', 'health', 'instance_down', 'live_down', 'webhook_silent', 'not_in_jellyfin', 'approved_not_in_arr'],
    arr_ops_fix_: ['open_in_arr', 'search_now', 'remove_search', 'retry_import', 'scan_now', 'open_system', 'open_seerr'],
    arr_ops_missing_: ['not_scanned', 'not_visible', 'outside_library'],
    arr_ops_doctor_: ['ok', 'problem', 'unknown'],
    arr_ops_doctor_root_: ['not_visible', 'not_in_library'],
    arr_ops_refresh_: ['refresh', 'scan_now', 'present', 'library_root', 'left_to_scan', 'no_ancestor', 'outside_library', 'scan_running', 'library_scan', 'new_folder_refresh', 'failed'],
    arr_hub_tab_: ['overview', 'activity', 'system', 'audit']
  };
  for (const [prefix, values] of Object.entries(families)) for (const v of values) assert.ok(`${prefix}${v}` in en, `${prefix}${v}`);
});

test('administrators get Overview/Activity/System/Audit (Downloads folds into Activity); others get none', async t => {
  const h = setup(t, { responses: path => (path === '/arr/admin/hub/overview' ? overview() : null) });
  h.JE.initializeArrStatus();
  await until(() => h.document.querySelector('.je-ops-attention'));
  const page = h.document.getElementById('je-requests-hub-page');
  assert.deepEqual([...page.querySelectorAll('.je-hub-tab')].map(b => b.dataset.tab), ['mine', 'soon', 'ready', 'overview', 'activity', 'system', 'audit', 'calendar']);

  const member = setup(t, { hub: null });
  member.JE.initializeArrStatus();
  await wait(10);
  const mpage = member.document.getElementById('je-requests-hub-page');
  assert.deepEqual([...mpage.querySelectorAll('.je-hub-tab')].map(b => b.dataset.tab), ['mine', 'soon', 'ready']);
  assert.ok(!member.calls.some(c => c.path.startsWith('/arr/admin/')));
  // Phase 2 off for an admin: the phase-1 tabs.
  const off = setup(t, { hub: false });
  off.JE.initializeArrStatus();
  await wait(10);
  assert.deepEqual([...off.document.querySelectorAll('.je-hub-tab')].map(b => b.dataset.tab), ['mine', 'soon', 'ready', 'downloads', 'calendar']);
});

test('the Overview shows instance cards, Needs attention in the arrs\' words with fixes, the next 24 h and two weeks', async t => {
  const posts = [];
  const h = setup(t, {
    responses: (path, options) => {
      if (path === '/arr/admin/hub/overview') return overview();
      if (options?.method === 'POST') { posts.push({ path, body: options.body }); return { status: 'Succeeded', message: 'Done.', readBack: 'Finished.' }; }
      return null;
    }
  });
  h.JE.initializeArrStatus();
  await until(() => h.document.querySelector('.je-ops-attention'));
  const page = h.document.getElementById('je-requests-hub-page');
  assert.equal(page.querySelectorAll('.je-ops-card').length, 2);
  assert.match(page.querySelector('.je-ops-card').textContent, /live/);
  assert.equal(page.querySelector('.je-ops-bar[role="meter"]').getAttribute('aria-valuenow'), '94');
  const rows = [...page.querySelectorAll('.je-ops-item')];
  assert.equal(rows.length, 7);
  const title = code => page.querySelector(`.je-ops-item[data-attention="${code}"] .je-ops-item-title`).textContent;
  const sub = code => page.querySelector(`.je-ops-item[data-attention="${code}"] .je-ops-item-sub`).textContent;
  assert.equal(title('import_blocked'), 'Import blocked · Peacemaker S02E05 · Sonarr');
  assert.match(sub('import_blocked'), /^Manual Import required\. · for \d+ min$/);
  assert.equal(title('low_disk'), 'Low disk · /data/movies4k 94% · Radarr');
  assert.equal(sub('low_disk'), '412 GB free');
  assert.equal(title('not_in_jellyfin'), 'In Sonarr, not in Jellyfin · The Flash S09E05');
  assert.match(sub('not_in_jellyfin'), /^Imported to \/media\/tv\/The Flash\/Season 09\/E05\.mkv; Jellyfin hasn't picked it up · 12 min ago$/);
  assert.match(sub('approved_not_in_arr'), /^OK'd in Seerr 20 min ago, but none of the Sonarr\/Radarr Jellyfin Enhanced watches has it · asked by Emma$/);
  assert.match(sub('download_stalled'), /reports no time left at 35%/);
  // Titles are text, never HTML.
  assert.equal(page.querySelectorAll('img[src="x"]').length, 0);
  // Open in links use the instance URL mapping for this Jellyfin address.
  const open = page.querySelector('.je-ops-item[data-attention="import_blocked"] a.je-ops-btn');
  assert.equal(open.getAttribute('href'), 'https://sonarr.example/activity/queue');
  assert.equal(open.getAttribute('rel'), 'noopener noreferrer');
  assert.equal(page.querySelector('.je-ops-item[data-attention="approved_not_in_arr"] a.je-ops-btn').getAttribute('href'), 'http://seerr.test/settings/services');
  assert.match(page.querySelector('.je-ops-side').textContent, /Severance S03E06/);
  assert.match(page.querySelector('.je-ops-spark').textContent, /14 days: 13 grabs, 7 imports/);

  // Fixes: Retry import and Search now (a failed download no longer queued) post the actions.
  page.querySelector('.je-ops-item[data-attention="import_waiting"] .je-ops-btn-primary').click();
  await until(() => posts.length === 1);
  assert.equal(posts[0].path, '/arr/admin/queue/action');
  assert.deepEqual({ ...posts[0].body, idempotencyKey: undefined }, { instanceId: 'r1', downloadId: 'dlB', action: 'retry_import', idempotencyKey: undefined });
  await until(() => page.querySelector('.je-ops-banner'));
  assert.equal(page.querySelector('.je-ops-banner').textContent, 'Done. Finished.');
  page.querySelector('.je-ops-item[data-attention="download_failed"] .je-ops-btn-primary').click();
  await until(() => posts.length === 2);
  assert.equal(posts[1].path, '/arr/admin/hub/search');
  assert.equal(posts[1].body.key, 'movie:tmdb:20367');
  page.querySelector('.je-ops-item[data-attention="not_in_jellyfin"] .je-ops-btn-primary').click();
  await until(() => posts.length === 3);
  assert.deepEqual([posts[2].path, posts[2].body.path], ['/arr/admin/bridge/scan', '/data/tv/The Flash/Season 09/E05.mkv']);
  assert.notEqual(posts[0].body.idempotencyKey, posts[1].body.idempotencyKey);
  // Open System switches tab.
  page.querySelector('.je-ops-item[data-attention="low_disk"] .je-ops-btn-primary').click();
  assert.equal(h.window.location.hash, '#/requests?tab=system');
});

test('Remove & search again asks first (keeps the data); deleting the data needs the server\'s token and the typed word', async t => {
  const posts = [];
  const h = setup(t, {
    hash: '#/requests?tab=activity',
    responses: (path, options) => {
      if (path === '/arr/admin/hub/activity') return activity();
      if (path === '/arr/admin/queue/confirm') { posts.push({ path, body: options.body }); return { token: 'TOKEN-1', expiresAt: iso(2), download: activity().queue[0] }; }
      if (options?.method === 'POST') { posts.push({ path, body: options.body }); return { status: 'Succeeded', message: 'Done.', readBack: 'Removed from the queue.' }; }
      return null;
    }
  });
  h.JE.initializeArrStatus();
  await until(() => h.document.querySelector('.je-ops-dl'));
  const page = h.document.getElementById('je-requests-hub-page');
  const pack = page.querySelector('.je-ops-dl[data-download-id="pack"]');
  assert.match(pack.textContent, /Peacemaker · S02E01–E03 · Sonarr/);
  assert.match(pack.textContent, /client reports no peers/);
  assert.equal([...pack.querySelectorAll('.je-ops-btn')].map(b => [...b.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('')).join('|'), 'Remove…|Search again|Remove and delete data…|Open in Sonarr');
  assert.match(page.querySelector('.je-ops-table').textContent, /Imported/);
  assert.match(page.querySelector('.je-ops-table').textContent, /somethingNew/);

  // Tier 2: the dialog, with the season pack's blast radius; Esc closes it without a call.
  const remove = pack.querySelector('[data-je-focus="dl:s1|pack:remove"]');
  remove.click();
  let dialog = h.document.querySelector('.je-ops-dialog');
  assert.equal(dialog.getAttribute('role'), 'dialog');
  assert.match(dialog.textContent, /This download covers S02E01–E03; removing it affects all 3 episodes\./);
  assert.match(dialog.textContent, /its data is kept/);
  h.document.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(h.document.querySelector('.je-ops-dialog'), null);
  assert.equal(posts.length, 0);
  remove.click();
  dialog = h.document.querySelector('.je-ops-dialog');
  const [blocklist, search] = dialog.querySelectorAll('input[type="checkbox"]');
  assert.equal(blocklist.checked, true);
  search.checked = false;
  dialog.querySelector('.je-ops-btn-primary').click();
  await until(() => posts.length === 1);
  assert.deepEqual({ ...posts[0].body, idempotencyKey: 'k' }, { instanceId: 's1', downloadId: 'pack', action: 'remove', blocklist: true, searchAgain: false, idempotencyKey: 'k' });

  // While it runs the row's buttons are busy; the outcome shows as the banner.
  await until(() => page.querySelector('.je-ops-banner'));
  assert.equal(page.querySelector('.je-ops-banner').textContent, 'Done. Removed from the queue.');

  // Tier 3: the server's token, then the typed word.
  page.querySelector('[data-je-focus="dl:s1|pack:remove_with_data"]').click();
  await until(() => h.document.querySelector('.je-ops-warnbox'));
  dialog = h.document.querySelector('.je-ops-dialog');
  assert.match(dialog.textContent, /deletes what the download client has of it/);
  const confirm = dialog.querySelector('.je-ops-btn-danger');
  assert.equal(confirm.disabled, true);
  confirm.click();
  assert.equal(posts.length, 2); // only the confirm call
  const input = dialog.querySelector('input[type="text"]');
  input.value = 'delet';
  input.dispatchEvent(new h.window.Event('input'));
  assert.equal(confirm.disabled, true);
  input.value = 'delete';
  input.dispatchEvent(new h.window.Event('input'));
  assert.equal(confirm.disabled, false);
  confirm.click();
  await until(() => posts.length === 3);
  assert.equal(posts[1].path, '/arr/admin/queue/confirm');
  assert.deepEqual({ ...posts[1].body }, { instanceId: 's1', downloadId: 'pack' });
  assert.equal(posts[2].body.action, 'remove_with_data');
  assert.equal(posts[2].body.confirmationToken, 'TOKEN-1');
  assert.equal(h.document.querySelector('.je-ops-dialog'), null);
});

test('the System tab shows live state, health, tasks, Seerr, the bridge and the path doctor; Audit lists actions', async t => {
  const posts = [];
  const h = setup(t, {
    hash: '#/requests?tab=system',
    responses: (path, options) => {
      if (path === '/arr/admin/hub/system') return system();
      if (path === '/arr/admin/audit?take=200') return { entries: [{ id: '1', time: iso(-3), userName: 'real-admin', action: 'queue.remove_with_data', target: 'download:x', outcome: 'rejected', message: 'needs a fresh confirmation', details: { title: 'Plan 9', instance: 'Radarr' } }, { id: '2', time: iso(-4), userName: 'real-admin', action: 'custom.thing', target: 't', outcome: 'succeeded' }] };
      if (options?.method === 'POST') { posts.push({ path, body: options.body }); return { status: 'Succeeded', message: 'Done.', readBack: 'Jellyfin has it now.' }; }
      return null;
    }
  });
  h.JE.initializeArrStatus();
  await until(() => h.document.querySelector('.je-ops-bridge'));
  const page = h.document.getElementById('je-requests-hub-page');
  const text = page.textContent;
  assert.match(text, /Radarr · Radarr 6\.0\.4/);
  assert.match(text, /Connection refused/);
  assert.match(text, /Webhook: 3 received, 1 refused/);
  assert.match(text, /New update is available/);
  assert.match(text, /RSS Sync/);
  assert.match(text, /15 requests held/);
  assert.match(text, /4 folder refreshes so far \(imports and Scan now\), 4 found their file/);
  // Short columns (type, check) keep their words whole; only messages and paths may break anywhere.
  const healthRow = [...page.querySelectorAll('.je-ops-table tbody tr')].find(r => /New update is available/.test(r.textContent));
  assert.deepEqual([...healthRow.children].map(c => c.classList.contains('je-ops-wrap')), [false, false, true]);
  const css = [...h.document.querySelectorAll('style')].map(x => x.textContent).join('\n');
  assert.match(css, /\.je-ops-table th, \.je-ops-table td \{[^}]*overflow-wrap: break-word;/);
  assert.match(css, /\.je-ops-table \.je-ops-wrap \{ overflow-wrap: anywhere; \}/);
  assert.match(text, /new folder in a TV library: left to Jellyfin's library monitor/);
  assert.match(text, /Suggested path mapping .*: \/data → \/rigmedia/);
  assert.match(text, /Sintel: expected at \/data\/movies\/Sintel, Jellyfin has it at \/rigmedia\/movies\/Sintel/);
  assert.match(text, /1 titles have files in Sonarr\/Radarr but aren't in Jellyfin at all/);
  page.querySelector('.je-ops-bridge .je-ops-item .je-ops-btn').click();
  await until(() => posts.length === 1);
  assert.deepEqual([posts[0].path, posts[0].body.instanceId, posts[0].body.path], ['/arr/admin/bridge/scan', 's1', '/data/tv/Firefly/Season 01/E5.mkv']);

  page.querySelector('.je-hub-tab[data-tab="audit"]').click();
  await until(() => page.querySelector('.je-ops-table td'));
  const cells = [...page.querySelectorAll('.je-ops-table tbody tr')].map(r => [...r.children].map(c => c.textContent));
  assert.equal(cells[0][2], 'Remove and delete data');
  assert.equal(cells[0][3], 'Plan 9 · Radarr');
  assert.match(cells[0][4], /^rejected · needs a fresh confirmation$/);
  assert.equal(cells[1][2], 'custom.thing');
  // Leaving the admin tabs stops the poll.
  page.querySelector('.je-hub-tab[data-tab="mine"]').click();
  assert.equal(h.JE.internals.arrHub.admin.state.timer, null);
  assert.equal(h.JE.internals.arrHub.admin.state.tab, null);
});

test('a tab that can\'t be read says so and the poll reads it again', async t => {
  let n = 0;
  const h = setup(t, { responses: path => (path === '/arr/admin/hub/overview' ? (++n === 1 ? Object.assign(new Error('boom'), { status: 500 }) : overview()) : null) });
  h.allowConsoleError(/could not load/);
  h.JE.initializeArrStatus();
  await until(() => h.document.querySelector('.je-hub-empty')?.textContent?.startsWith("Couldn't load this tab"));
  assert.match(h.document.querySelector('.je-hub-empty').textContent, /^Couldn't load this tab/);
  await h.JE.internals.arrHub.admin.refresh();
  await until(() => h.document.querySelector('.je-ops-attention'));
  assert.ok(h.document.querySelector('.je-ops-attention'));
});

test('the status pill: "Taking longer than usual" for the family, the admin line with the age and the fix', async t => {
  const h = setup(t, { hub: null });
  const S = h.JE.arrStatus;
  const status = { key: 'movie:tmdb:27205', kind: 'movie', stage: 'approved', reason: { code: 'approved_not_in_arr' }, attention: true, actions: [] };
  assert.equal(S.familyText(status, { contact: 'Dad' }), 'Taking longer than usual');
  const lines = S.adminLines({ ...status, admin: { variants: [], approvedNotInArrSince: iso(-20) } });
  assert.equal(lines.length, 1);
  assert.match(lines[0].text, /^OK'd in Seerr 20 min ago, but none of the Sonarr\/Radarr Jellyfin Enhanced watches has it$/);
  assert.equal(lines[0].fix, "Fix: check Seerr's Sonarr/Radarr settings");
  assert.equal(lines[0].attention, true);
  // A 4K request no 4K Radarr has says so (a standard copy may well exist).
  const fourK = S.adminLines({ ...status, admin: { variants: [], approvedNotInArrSince: iso(-20), approvedNotIn4k: true } });
  assert.equal(fourK[0].text, "4K request OK'd in Seerr 20 min ago, but none of the 4K Radarr Jellyfin Enhanced watches has it");
  assert.equal(S.ageText(iso(-3 * 60)), '3 h');
  assert.equal(S.ageText(iso(-3 * 1440)), '3 d');
  assert.equal(S.ageText(iso(5)), '');
  const pill = S.buildPill(status, { contact: 'Dad' });
  assert.equal(pill.querySelector('.je-arr-pill-text').textContent, 'Taking longer than usual');
});

test('dialogs: the Overview row knows a pack\'s size; focus survives a redraw; D-pad stays inside; a late confirm after leaving opens nothing', async t => {
  let release = null;
  const h = setup(t, {
    responses: (path) => {
      if (path === '/arr/admin/hub/overview') {
        const o = overview();
        o.needsAttention.push({ id: 'a8', code: 'download_warning', severity: 'warning', instanceId: 's1', instance: 'Sonarr', title: 'Peacemaker', scope: 'S02E01–E08', episodes: 8, since: iso(-5), message: 'no peers', fixes: ['remove_search', 'open_in_arr'], arrLink: '/activity/queue', downloadId: 'pack8' });
        return o;
      }
      if (path === '/arr/admin/queue/confirm') return new Promise(r => { release = () => r({ token: 'T', download: activity().queue[0] }); });
      return null;
    }
  });
  h.JE.initializeArrStatus();
  await until(() => h.document.querySelector('.je-ops-item[data-attention="download_warning"]'));
  const page = h.document.getElementById('je-requests-hub-page');
  // Remove & search again from the Overview (no Activity answer read): the pack's blast radius is there.
  const fix = page.querySelector('[data-je-focus="fix:a8:remove_search"]');
  fix.focus();
  fix.click();
  const dialog = h.document.querySelector('.je-ops-dialog');
  assert.match(dialog.textContent, /removing it affects all 8 episodes/);
  // TV: jellyfin-web keeps D-pad focus inside a focuscontainer, and focus that escapes comes back.
  assert.ok(dialog.classList.contains('focuscontainer'));
  page.querySelector('.je-hub-tab[data-tab="mine"]').focus();
  assert.ok(dialog.contains(h.document.activeElement));
  // A poll redraws the panel while the dialog is open (the opener is replaced): Esc still returns focus to that fix.
  await h.JE.internals.arrHub.admin.refresh();
  assert.equal(fix.isConnected, false);
  h.document.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(h.document.querySelector('.je-ops-dialog'), null);
  assert.equal(h.document.activeElement?.dataset?.jeFocus, 'fix:a8:remove_search');
  assert.ok(h.document.activeElement.isConnected);

  // "delete it too?": the confirm answer arrives after the admin left the page: no dialog opens.
  page.querySelector('[data-je-focus="delete:a8"]').click();
  await until(() => release);
  assert.ok(page.querySelector('.je-ops-item[data-attention="download_warning"] .je-ops-btn[disabled], .je-ops-item[data-attention="download_warning"] [aria-busy="true"]') || h.JE.internals.arrHub.admin.state.busy.has('a8'));
  h.JE.internals.arrHub.admin.leave();
  release();
  await wait(20);
  assert.equal(h.document.querySelector('.je-ops-dialog'), null);
  assert.equal(h.JE.internals.arrHub.admin.state.busy.has('a8'), false);
});

test('the Overview tab\'s count follows its answer, and the tabs follow the admin feed key instead of polling every 10 s', async t => {
  const feed = [];
  let reads = 0;
  let rows = 7;
  const h = setup(t, {
    feed,
    responses: (path) => {
      if (path !== '/arr/admin/hub/overview') return null;
      reads++;
      const o = overview();
      o.needsAttention = o.needsAttention.slice(0, rows);
      return o;
    }
  });
  h.JE.initializeArrStatus();
  await until(() => h.document.querySelector('.je-ops-attention'));
  const tab = () => h.document.querySelector('.je-hub-tab[data-tab="overview"] .je-hub-tab-count')?.textContent;
  // The strip was drawn before the first answer: redrawn with the count once it is known.
  await until(() => tab() === '7');
  assert.equal(tab(), '7');
  const sub = feed.find(f => f.keys.includes('admin:ops'));
  assert.ok(sub, 'subscribed to admin:ops');
  // A change on the feed re-reads the shown tab (and the count follows it).
  rows = 2;
  const before = reads;
  sub.cb(['admin:ops']);
  await until(() => reads > before && tab() === '2');
  assert.equal(tab(), '2');
  // With the feed followed, the fallback poll is slow.
  const A = h.JE.internals.arrHub.admin;
  assert.ok(A.state.timer);
  // Leaving stops following.
  h.document.querySelector('.je-hub-tab[data-tab="mine"]').click();
  assert.equal(sub.off, true);
  assert.equal(A.state.unsubscribe, null);
  // The feed client accepts the key.
  const live = readFileSync(resolve(jsRoot, 'arr/live/arr-live.js'), 'utf8');
  assert.match(live, /\|admin:ops\)\$\//);
});

test('an admin:ops change that arrives while the tab is being read is read once more after it', async t => {
  const feed = [];
  let reads = 0;
  let rows = 7;
  let gate = null;
  const h = setup(t, {
    feed,
    responses: (path) => {
      if (path !== '/arr/admin/hub/overview') return null;
      reads++;
      const o = overview();
      o.needsAttention = o.needsAttention.slice(0, rows);
      return gate ? gate.then(() => o) : o;
    }
  });
  h.JE.initializeArrStatus();
  const tab = () => h.document.querySelector('.je-hub-tab[data-tab="overview"] .je-hub-tab-count')?.textContent;
  await until(() => tab() === '7');
  const sub = feed.find(f => f.keys.includes('admin:ops'));
  // A change starts a read that is slow (the server's answer was taken before the next change)...
  let release;
  gate = new Promise(r => { release = r; });
  sub.cb(['admin:ops']);
  await until(() => reads === 2);
  // ...and the next change (a removal finished) arrives while it runs.
  rows = 2;
  sub.cb(['admin:ops']);
  await wait(450);
  assert.equal(reads, 2);
  gate = null;
  release();
  await until(() => tab() === '2');
  assert.equal(tab(), '2');
  assert.equal(reads, 3);
});

test('switching admin tabs closes the Remove dialog the tabs opened on the tab it was opened on', async t => {
  const h = setup(t, {
    hash: '#/requests?tab=activity',
    responses: (path) => path === '/arr/admin/hub/activity' ? activity() : path === '/arr/admin/hub/overview' ? overview() : null
  });
  h.JE.initializeArrStatus();
  await until(() => h.document.querySelector('.je-ops-dl'));
  h.document.querySelector('[data-je-focus="dl:s1|pack:remove"]').click();
  assert.ok(h.document.querySelector('.je-ops-dialog'));
  // A toast's link (or a click on the strip) shows the Overview.
  h.document.querySelector('.je-hub-tab[data-tab="overview"]').click();
  await until(() => h.document.querySelector('.je-ops-attention'));
  assert.equal(h.document.querySelector('.je-ops-dialog'), null);
  assert.equal(h.JE.internals.arrHub.admin.state.dialog, null);
});

test('the Manage drawer offers a download\'s non-destructive queue actions (phase 2), Remove through the consequences dialog', async t => {
  const posts = [];
  const h = setup(t, {
    hash: '#/home',
    responses: (path, options) => {
      if (path.startsWith('/arr/admin/manage?')) {
        return {
          key: 'tv:tvdb:391153:s2', kind: 'tv', title: 'Peacemaker', season: 2,
          instances: [{ id: 's1', name: 'Sonarr', kind: 'Sonarr', role: 'standard', url: 'http://sonarr:8989', urlMappings: '', readable: true, inArr: true, arrId: 1, titleSlug: 'peacemaker', queue: [], timeline: [],
            downloads: [{ instanceId: 's1', instance: 'Sonarr', downloadId: 'pack', title: 'Peacemaker', scope: 'S02E01–E03', episodes: 3, state: 'importPending', percent: 100, client: 'Mock SABnzbd', release: 'Peacemaker.S02-GRP', messages: ['Sample'], problem: 'import_waiting', actions: ['remove', 'remove_with_data', 'search', 'retry_import'] }] }],
          requests: []
        };
      }
      if (options?.method === 'POST') { posts.push({ path, body: options.body }); return { status: 'Succeeded', message: 'Done.' }; }
      return null;
    }
  });
  h.JE.initializeArrStatus();
  await h.JE.arrManage.open({ key: 'tv:tvdb:391153:s2' });
  await until(() => h.document.querySelector('.je-manage-download'));
  const row = h.document.querySelector('.je-manage-download');
  assert.match(row.textContent, /S02E01–E03/);
  const labels = [...row.querySelectorAll('button')].map(b => b.textContent);
  assert.deepEqual(labels, ['Retry import', 'Search again', 'Remove…']);
  row.querySelector('[data-je-focus="dl-retry_import-s1|pack"]').click();
  await until(() => posts.length === 1);
  assert.deepEqual({ ...posts[0].body, idempotencyKey: 'k' }, { instanceId: 's1', downloadId: 'pack', action: 'retry_import', idempotencyKey: 'k' });
  assert.equal(posts[0].path, '/arr/admin/queue/action');
  await until(() => !h.JE.internals.arrHub.admin.state.dialog && h.document.querySelector('.je-manage-result')?.textContent === 'Done.');
  // Remove…: the hub's dialog above the drawer, with the pack warning and without "delete the data".
  let stolen = 0;
  h.document.querySelector('.je-manage').addEventListener('focus', () => stolen++);
  h.document.querySelector('[data-je-focus="dl-remove-s1|pack"]').click();
  const dialog = h.document.querySelector('.je-ops-dialog');
  assert.match(dialog.textContent, /affects all 3 episodes/);
  assert.equal(dialog.querySelector('.je-ops-btn-danger'), null);
  // Focus stays in the dialog (the drawer doesn't pull it back, not even for a moment).
  assert.ok(dialog.contains(h.document.activeElement));
  assert.equal(stolen, 0);
  dialog.querySelector('.je-ops-btn-primary').click();
  await until(() => posts.length === 2);
  assert.deepEqual({ ...posts[1].body, idempotencyKey: 'k' }, { instanceId: 's1', downloadId: 'pack', action: 'remove', blocklist: true, searchAgain: true, idempotencyKey: 'k' });
});

const drawerAnswer = () => ({
  key: 'tv:tvdb:391153:s2', kind: 'tv', title: 'Peacemaker', season: 2,
  instances: [{ id: 's1', name: 'Sonarr', kind: 'Sonarr', role: 'standard', url: 'http://sonarr:8989', urlMappings: '', readable: true, inArr: true, arrId: 1, titleSlug: 'peacemaker', queue: [], timeline: [],
    downloads: [{ instanceId: 's1', instance: 'Sonarr', downloadId: 'pack', title: 'Peacemaker', scope: 'S02E01–E03', episodes: 3, state: 'downloading', percent: 41, actions: ['remove', 'search'] }] }],
  requests: []
});

test('a 4K request no 4K Radarr has is its own Needs attention row, worded for 4K', async t => {
  const h = setup(t, {
    responses: (path) => {
      if (path !== '/arr/admin/hub/overview') return null;
      const o = overview();
      o.needsAttention = [{ id: 'a9', code: 'approved_not_in_arr', severity: 'warning', title: 'Sintel', year: 2010, key: 'movie:tmdb:45745', since: iso(-30), message: 'Emma', params: { variant: '4k' }, fixes: ['open_seerr'] }];
      return o;
    }
  });
  h.JE.initializeArrStatus();
  await until(() => h.document.querySelector('.je-ops-item[data-attention="approved_not_in_arr"]'));
  assert.match(h.document.querySelector('.je-ops-item[data-attention="approved_not_in_arr"] .je-ops-item-sub').textContent, /^4K request OK'd in Seerr 30 min ago, but none of the 4K Radarr Jellyfin Enhanced watches has it · asked by Emma$/);
});

test('the drawer\'s Remove dialog survives hub re-renders and goes away with the drawer', async t => {
  const h = setup(t, {
    hash: '#/requests?tab=mine',
    responses: (path) => (path.startsWith('/arr/admin/manage?') ? drawerAnswer() : null)
  });
  h.JE.initializeArrStatus();
  await until(() => h.document.querySelector('.je-hub-tab[data-tab="mine"]'));
  await h.JE.arrManage.open({ key: 'tv:tvdb:391153:s2' });
  await until(() => h.document.querySelector('[data-je-focus="dl-remove-s1|pack"]'));
  h.document.querySelector('[data-je-focus="dl-remove-s1|pack"]').click();
  assert.ok(h.document.querySelector('.je-ops-dialog'));
  // The hub re-reads (a 1 % progress tick on the followed title) and redraws its "My requests" tab.
  await h.JE.internals.arrHub.load();
  await wait(20);
  assert.ok(h.document.querySelector('.je-ops-dialog'), 'the drawer\'s dialog is still open after the hub redraw');
  assert.equal(h.JE.internals.arrHub.admin.state.dialog?.owner, 'drawer');
  // Closing the drawer (Back: viewshow) closes the dialog it opened, focus trap and all.
  h.JE.arrManage.close();
  assert.equal(h.document.querySelector('.je-ops-dialog'), null);
  assert.equal(h.JE.internals.arrHub.admin.state.dialog, null);
});

test('two instances reporting the same download id are separate rows for busy state and results', async t => {
  let release;
  const pending = new Promise(r => { release = r; });
  const posts = [];
  const twin = (instanceId, instance) => ({ instanceId, instance, kind: 'Radarr', downloadId: 'HASH1', ids: [instanceId === 'r1' ? 5 : 6], title: 'Dune', year: 2021, episodes: 0, status: 'warning', state: 'downloading', percent: 20, actions: ['remove', 'search'] });
  const h = setup(t, {
    hash: '#/requests?tab=activity',
    responses: (path, options) => {
      if (path === '/arr/admin/hub/activity') return { instances: [card('r1', 'Radarr', 'Radarr'), card('r4', 'Radarr 4K', 'Radarr')], queue: [twin('r1', 'Radarr'), twin('r4', 'Radarr 4K')], history: [] };
      if (options?.method === 'POST') { posts.push(options.body); return pending; }
      return null;
    }
  });
  h.JE.initializeArrStatus();
  await until(() => h.document.querySelectorAll('.je-ops-dl').length === 2);
  h.document.querySelector('[data-je-focus="dl:r1|HASH1:search"]').click();
  await until(() => posts.length === 1);
  assert.equal(posts[0].instanceId, 'r1');
  assert.equal(h.document.querySelector('[data-je-focus="dl:r1|HASH1:search"]').getAttribute('aria-disabled'), 'true');
  assert.equal(h.document.querySelector('[data-je-focus="dl:r4|HASH1:search"]').getAttribute('aria-disabled'), null);
  // The other instance's row still works while the first one runs.
  h.document.querySelector('[data-je-focus="dl:r4|HASH1:search"]').click();
  await until(() => posts.length === 2);
  assert.equal(posts[1].instanceId, 'r4');
  release({ status: 'Succeeded', message: 'Done.' });
});

test('Cancel closes every dialog: the tabs\' Remove, the drawer\'s Remove and the delete-data confirmation, focus trap and all', async t => {
  const h = setup(t, {
    hash: '#/requests?tab=activity',
    responses: (path, options) => {
      if (path === '/arr/admin/hub/activity') return activity();
      if (path === '/arr/admin/queue/confirm') return { token: 'TOKEN-1', expiresAt: iso(2), download: activity().queue[0] };
      if (path.startsWith('/arr/admin/manage?')) return drawerAnswer();
      return null;
    }
  });
  const removed = [];
  const remove = h.document.removeEventListener.bind(h.document);
  h.document.removeEventListener = (type, fn, capture) => { removed.push(type); return remove(type, fn, capture); };
  const cancelled = () => {
    const dialog = h.document.querySelector('.je-ops-dialog');
    const cancel = [...dialog.querySelectorAll('.je-ops-btn')].find(b => b.textContent === 'Cancel');
    removed.length = 0;
    cancel.click();
    assert.equal(h.document.querySelector('.je-ops-dialog'), null, 'Cancel closed the dialog');
    assert.equal(h.document.querySelector('.je-ops-dialog-overlay'), null);
    assert.equal(h.JE.internals.arrHub.admin.state.dialog, null);
    assert.deepEqual(removed.sort(), ['focusin', 'keydown'], 'the focus trap listeners are gone');
  };
  h.JE.initializeArrStatus();
  await until(() => h.document.querySelector('.je-ops-dl'));
  const page = h.document.getElementById('je-requests-hub-page');
  // Tabs: Remove…
  page.querySelector('[data-je-focus="dl:s1|pack:remove"]').click();
  assert.equal(h.JE.internals.arrHub.admin.state.dialog?.owner, 'tabs');
  cancelled();
  // Tabs: Remove and delete data… (Tier 3).
  page.querySelector('[data-je-focus="dl:s1|pack:remove_with_data"]').click();
  await until(() => h.document.querySelector('.je-ops-warnbox'));
  cancelled();
  // The Manage drawer's Remove….
  await h.JE.arrManage.open({ key: 'tv:tvdb:391153:s2' });
  await until(() => h.document.querySelector('[data-je-focus="dl-remove-s1|pack"]'));
  h.document.querySelector('[data-je-focus="dl-remove-s1|pack"]').click();
  assert.equal(h.JE.internals.arrHub.admin.state.dialog?.owner, 'drawer');
  cancelled();
});

test('a 4K series request no 4K Sonarr has says Sonarr, on the card and in Needs attention', async t => {
  const h = setup(t, {
    responses: (path) => {
      if (path !== '/arr/admin/hub/overview') return null;
      const o = overview();
      o.needsAttention = [{ id: 'a10', code: 'approved_not_in_arr', severity: 'warning', title: 'Spaced', year: 1999, key: 'tv:tvdb:72658', since: iso(-30), message: 'Emma', params: { variant: '4k' }, fixes: ['open_seerr'] }];
      return o;
    }
  });
  const series = { key: 'tv:tvdb:72658', kind: 'series', stage: 'approved', reason: { code: 'approved_not_in_arr' }, attention: true, actions: [], admin: { variants: [], approvedNotInArrSince: iso(-20), approvedNotIn4k: true } };
  assert.equal(h.JE.arrStatus.adminLines(series)[0].text, "4K request OK'd in Seerr 20 min ago, but none of the 4K Sonarr Jellyfin Enhanced watches has it");
  h.JE.initializeArrStatus();
  await until(() => h.document.querySelector('.je-ops-item[data-attention="approved_not_in_arr"]'));
  assert.match(h.document.querySelector('.je-ops-item[data-attention="approved_not_in_arr"] .je-ops-item-sub').textContent, /^4K request OK'd in Seerr 30 min ago, but none of the 4K Sonarr Jellyfin Enhanced watches has it · asked by Emma$/);
});

test('a tab whose re-read fails keeps what it shows with a note, retries on its own, and says how old a queue is', async t => {
  let fail = false;
  const h = setup(t, {
    hash: '#/requests?tab=activity',
    responses: path => {
      if (path !== '/arr/admin/hub/activity') return null;
      if (fail) return Object.assign(new Error('HTTP 502'), { status: 502 });
      const a = activity();
      a.instances[0] = card('r1', 'Radarr', 'Radarr', { queueAsOf: iso(-12), queueExpired: true });
      return a;
    }
  });
  h.allowConsoleError?.(/could not load/);
  h.JE.initializeArrStatus();
  await until(() => h.document.querySelector('.je-ops-dl'));
  // The Radarr card's queue is past its serving limit: said on the card line and above the queue.
  assert.match(h.document.querySelector('.je-ops-section').textContent, /Radarr · queue can't be read; last read /);
  // The history is the newest N events of every instance.
  assert.match(h.document.body.textContent, /The newest 2 events/);
  fail = true;
  await h.JE.internals.arrHub.admin.refresh();
  await until(() => h.document.querySelector('.je-arr-stale-note'));
  const note = h.document.querySelector('.je-arr-stale-note');
  assert.equal(note.getAttribute('role'), 'status');
  assert.ok(h.document.querySelector('.je-ops-dl'), 'the downloads stay on screen');
  fail = false;
  note.querySelector('.je-arr-stale-retry').click();
  await until(() => !h.document.querySelector('.je-arr-stale-note'));
  assert.equal(h.document.querySelector('.je-arr-stale-note'), null);
});

/**
 * Holds the page's long timers (5 s and more: retries and polls) so a test runs them when it wants;
 * ids grow, so the timers set after a mark are the ones a step started.
 */
function holdLongTimers(h) {
  const held = new Map();
  let next = 1e6;
  const realSet = h.window.setTimeout.bind(h.window);
  const realClear = h.window.clearTimeout.bind(h.window);
  h.window.setTimeout = (fn, ms, ...args) => {
    if (!(ms >= 5000)) return realSet(fn, ms, ...args);
    const id = next++;
    held.set(id, { fn, ms });
    return id;
  };
  h.window.clearTimeout = id => { if (held.has(id)) held.delete(id); else realClear(id); };
  return {
    mark: () => next,
    since: mark => [...held.entries()].filter(([id]) => id >= mark).map(([, x]) => x.ms),
    runSince(mark) {
      const due = [...held.entries()].filter(([id]) => id >= mark);
      for (const [id] of due) held.delete(id);
      for (const [, x] of due) x.fn();
      return due.length;
    }
  };
}

test('a tab whose re-read keeps failing retries on its own after 5 s, backs off to a minute, and stops when left', async t => {
  let fail = false;
  let reads = 0;
  const h = setup(t, {
    hash: '#/requests?tab=activity',
    responses: path => {
      if (path !== '/arr/admin/hub/activity') return null;
      reads++;
      return fail ? Object.assign(new Error('HTTP 502'), { status: 502 }) : activity();
    }
  });
  h.allowConsoleError?.(/could not load/);
  const timers = holdLongTimers(h);
  h.JE.initializeArrStatus();
  await until(() => h.document.querySelector('.je-ops-dl'));
  fail = true;
  let mark = timers.mark();
  await h.JE.internals.arrHub.admin.refresh();
  await until(() => h.document.querySelector('.je-arr-stale-note'));
  assert.deepEqual(timers.since(mark), [5000]);
  // Each failed retry waits twice as long, at most a minute.
  for (const delay of [10000, 20000, 40000, 60000, 60000]) {
    const before = reads;
    const run = mark;
    mark = timers.mark();
    assert.equal(timers.runSince(run), 1);
    await until(() => reads === before + 1 && timers.since(mark).length === 1);
    assert.deepEqual(timers.since(mark), [delay]);
    assert.ok(h.document.querySelector('.je-arr-stale-note'), 'the note stays while it fails');
  }
  // It works again: the note goes without a click, and nothing more is retried.
  fail = false;
  const before = reads;
  const run = mark;
  mark = timers.mark();
  timers.runSince(run);
  await until(() => reads === before + 1 && !h.document.querySelector('.je-arr-stale-note'));
  assert.deepEqual(timers.since(mark), []);
  // A new failure starts again at 5 s; leaving the tabs drops the pending retry.
  fail = true;
  mark = timers.mark();
  await h.JE.internals.arrHub.admin.refresh();
  await until(() => timers.since(mark).length === 1);
  assert.deepEqual(timers.since(mark), [5000]);
  h.JE.internals.arrHub.admin.leave();
  assert.deepEqual(timers.since(mark), []);
  const after = reads;
  await wait(20);
  assert.equal(reads, after);
});

test('a 4K handoff row is tagged 4K in its title', async t => {
  const h = setup(t, {
    responses: (path) => {
      if (path !== '/arr/admin/hub/overview') return null;
      const o = overview();
      o.needsAttention = [{ id: 'a9', code: 'approved_not_in_arr', severity: 'warning', title: 'Sintel', year: 2010, key: 'movie:tmdb:45745', since: iso(-30), message: 'Emma', params: { variant: '4k' }, fixes: ['open_seerr'] }];
      return o;
    }
  });
  h.JE.initializeArrStatus();
  await until(() => h.document.querySelector('.je-ops-item[data-attention="approved_not_in_arr"]'));
  assert.match(h.document.querySelector('.je-ops-item[data-attention="approved_not_in_arr"] .je-ops-item-title').textContent, /Sintel \(2010\) \[4K\]/);
});
