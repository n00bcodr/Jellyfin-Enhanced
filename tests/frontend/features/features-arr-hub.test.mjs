// Requests & downloads, phase 1: the Requests page (#/requests), the administrator's Manage drawer
// and the status pill in Seerr's more-info modal, rendered by the real modules from server answers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { createHarness, jsRoot } from '../helpers/harness.mjs';

const en = JSON.parse(readFileSync(resolve(jsRoot, 'locales/en.json'), 'utf8'));
const MODULES = [
  // Stage 1 fix round 12: the writes go out through JE.core.userWrite with the origin of the click.
  'core/mutation-queue.js',
  'arr/status/status-core.js', 'arr/status/status-episodes.js', 'arr/status/status-details.js', 'arr/status/status-cards.js',
  'arr/status/status-modal.js', 'arr/status/status-styles.js',
  'arr/manage/manage-styles.js', 'arr/manage/manage-drawer.js',
  'arr/hub/hub-styles.js', 'arr/hub/hub-render.js', 'arr/hub/hub-page.js'
];
const USER = '0123456789abcdef0123456789abcdef';

function translate(key, params) {
  const text = en[key];
  if (text === undefined) throw new Error(`missing en.json key ${key}`);
  return Object.entries(params || {}).reduce((s, [k, v]) => s.split(`{${k}}`).join(String(v)), text);
}

function setup(t, { html = '', hash = '#/home', config = {}, responses = () => null, downloads, calendar } = {}) {
  const calls = [];
  const subscriptions = [];
  const navigation = [];
  const h = createHarness({
    html: `<div class="mainDrawer"><div class="jellyfinEnhancedSection"></div></div><div class="mainAnimatedPages"><div class="mainAnimatedPage" id="homePage"></div></div>${html}`,
    url: `http://jellyfin.test/web/index.html${hash}`,
    apiClient: { getCurrentUserId: () => USER, serverAddress: () => 'http://jellyfin.test' },
    JE: {
      pluginConfig: { ArrStatusEnabled: true, ArrRequestsHubEnabled: true, ArrManageDrawerEnabled: true, ArrSeerrModalStatus: true, ...config },
      t: translate,
      helpers: { debounce: fn => fn, onSidebarRebuilt: () => {} },
      core: {
        api: {
          plugin: async (path, options) => {
            calls.push({ path, options });
            const answer = responses(path, options, calls.length);
            if (answer instanceof Error) throw answer;
            return answer;
          }
        },
        navigation: { onNavigate: fn => { navigation.push(fn); return () => {}; }, onViewPage: fn => () => {} },
        lifecycle: { register: () => ({ track: x => x }) }
      },
      arr: {
        live: { position: () => ({ epoch: 'e1', cursor: 7 }) },
        onStatusChange(keys, cb, opts) {
          const sub = { keys: [...keys], cb, opts, active: true };
          subscriptions.push(sub);
          return () => { sub.active = false; };
        }
      },
      downloadsPage: downloads,
      calendarPage: calendar,
      session: { getEpoch: () => 0, isCurrent: () => true, onUserChange: () => {} }
    }
  });
  t.after(() => h.close());
  for (const m of MODULES) h.load(m);
  return { ...h, get NATIVE() { return h.NATIVE; }, calls, subscriptions, navigation, live: () => subscriptions.filter(s => s.active) };
}

/** Waits (up to 5 s) until `check` is true: the drawer's re-reads are timer-driven and slow under coverage. */
async function until(check, ms = 5000) {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await wait(20);
}

const iso = days => new Date(Date.now() + days * 86400000).toISOString();
const status = (stage, code, extra = {}) => ({ key: 'movie:tmdb:1', kind: 'movie', stage, reason: { code }, quiet: false, actions: [], ...extra });
const entry = (title, group, stage, code, { status: statusExtra, ...extra } = {}) => ({
  key: extra.key || `movie:tmdb:${title.length}`, kind: 'movie', tmdbId: title.length, title, year: 2024, poster: '/p.jpg', request: 'approved',
  askedAt: iso(-2), group, ...extra, status: status(stage, code, { key: extra.key || `movie:tmdb:${title.length}`, ...(statusExtra || {}) })
});
const hubAnswer = (over = {}) => ({
  contact: 'Dad', lookingHours: 24, seerr: { configured: true, loaded: true, unavailable: false },
  mine: [
    entry('Waiting Film', 'needsOk', 'asked', 'awaiting_approval'),
    entry('Dune', 'onTheWay', 'downloading', 'downloading', { key: 'movie:tmdb:693134', status: { progress: { percent: 42, etaSeconds: 720 } } }),
    entry('<img src=x onerror=alert(1)>', 'declined', 'notHere', 'declined')
  ],
  soon: [entry('Agent 327', 'notOut', 'notOut', 'not_released', { nextDate: iso(8) })],
  ready: [entry('Sintel', 'ready', 'ready', 'ready', { itemId: 'abc', readyAt: iso(-1), status: { quiet: true } })],
  ...over
});

test('every key the Requests page, the Manage drawer and the modal pill use exists in en.json', () => {
  const source = ['arr/hub/hub-render.js', 'arr/hub/hub-page.js', 'arr/manage/manage-drawer.js', 'arr/status/status-modal.js']
    .map(m => readFileSync(resolve(jsRoot, m), 'utf8')).join('\n');
  const keys = [...source.matchAll(/tr\('([a-z0-9_]+)'/g), ...source.matchAll(/'(arr_(?:hub|manage)_[a-z0-9_]+)'/g)].map(m => m[1]);
  assert.ok(keys.length > 40);
  for (const key of keys) assert.ok(key in en, key);
  for (const status of ['pending', 'approved', 'declined', 'failed', 'available']) assert.ok(`arr_manage_request_${status}` in en, status);
  for (const tab of ['mine', 'soon', 'ready', 'downloads', 'calendar']) assert.ok(`arr_hub_tab_${tab}` in en, tab);
});

test('#/requests shows the own tabs from one read, groups My requests and never parses titles as HTML', async t => {
  const h = setup(t, { hash: '#/requests', responses: path => (path === '/acquire/hub' ? hubAnswer() : null) });
  h.JE.initializeArrStatus();
  await wait(10);
  const page = h.document.getElementById('je-requests-hub-page');
  assert.ok(page && !page.classList.contains('hide'));
  assert.ok(h.document.getElementById('homePage').classList.contains('hide'));
  assert.equal(h.calls.filter(c => c.path === '/acquire/hub').length, 1);
  const tabs = [...page.querySelectorAll('.je-hub-tab')].map(b => b.dataset.tab);
  assert.deepEqual(tabs, ['mine', 'soon', 'ready']);
  assert.equal(page.querySelector('.je-hub-tab[data-tab="mine"] .je-hub-tab-count').textContent, '2');
  const groups = [...page.querySelectorAll('.je-hub-group-title')].map(e => e.textContent);
  assert.deepEqual(groups, ['Waiting for Dad to OK', 'On the way', 'Said no']);
  const dune = [...page.querySelectorAll('.je-hub-row')].find(r => r.dataset.jeArrKey === 'movie:tmdb:693134');
  assert.match(dune.querySelector('.je-arr-pill-text').textContent, /^Downloading · 42% · about 12 min$/);
  assert.equal(dune.querySelector('.je-hub-poster').getAttribute('src'), 'https://image.tmdb.org/t/p/w185/p.jpg');
  assert.equal(page.querySelectorAll('img[src="x"]').length, 0);
  assert.ok([...page.querySelectorAll('.je-hub-name')].some(n => n.textContent.startsWith('<img src=x')));
  // No Manage button for a member (no admin block).
  assert.equal(page.querySelectorAll('.je-hub-manage').length, 0);
  // The sidebar link.
  assert.equal(h.document.querySelector('.je-nav-requests-hub-item .navMenuOptionText').textContent, 'Requests');

  // Coming soon: an agenda by day. Ready: Play opens the item.
  page.querySelector('.je-hub-tab[data-tab="soon"]').click();
  assert.equal(h.window.location.hash, '#/requests?tab=soon');
  assert.equal(page.querySelectorAll('.je-hub-day').length, 1);
  assert.equal(page.querySelector('.je-hub-name').textContent, 'Agent 327 (2024)');
  page.querySelector('.je-hub-tab[data-tab="ready"]').click();
  const shown = [];
  h.window.Emby = { Page: { showItem: id => shown.push(id) } };
  page.querySelector('.je-hub-btn-primary').click();
  assert.deepEqual(shown, ['abc']);
  // A quiet ready status shows no pill (the row says when it arrived).
  assert.equal(page.querySelectorAll('.je-hub-row .je-arr-pill').length, 0);
  assert.match(page.querySelector('.je-hub-meta').textContent, /^Arrived /);
  assert.equal(h.calls.filter(c => c.path === '/acquire/hub').length, 1);
});

test('the page follows its titles and the user\'s request list on the change feed and re-reads once per burst', async t => {
  let n = 0;
  const h = setup(t, {
    hash: '#/requests',
    responses: path => {
      if (path !== '/acquire/hub') return null;
      n++;
      return n === 1 ? hubAnswer() : hubAnswer({ mine: [entry('Waiting Film', 'onTheWay', 'approved', 'approved')] });
    }
  });
  h.JE.initializeArrStatus();
  await wait(10);
  const sub = h.live().at(-1);
  assert.ok(sub.keys.includes(`req:u:${USER}`));
  assert.ok(sub.keys.includes('movie:tmdb:693134'));
  assert.deepEqual(JSON.parse(JSON.stringify(sub.opts)), { since: { epoch: 'e1', cursor: 7 } });
  sub.cb([`req:u:${USER}`]);
  sub.cb(['movie:tmdb:693134']);
  await until(() => h.calls.filter(c => c.path === '/acquire/hub').length >= 2);
  await wait(400);
  assert.equal(h.calls.filter(c => c.path === '/acquire/hub').length, 2);
  const page = h.document.getElementById('je-requests-hub-page');
  assert.deepEqual([...page.querySelectorAll('.je-hub-group-title')].map(e => e.textContent), ['On the way']);
  assert.equal(page.querySelector('.je-arr-pill-text').textContent, "OK'd! Getting started");

  // Jellyfin's own "Page not found" for #/requests is hidden while the page shows.
  assert.ok(h.document.body.classList.contains('je-hub-active'));
  // Navigating away hides the page and stops following.
  h.window.location.hash = '#/home';
  for (const fn of h.navigation) fn();
  assert.ok(page.classList.contains('hide'));
  assert.ok(!h.document.body.classList.contains('je-hub-active'));
  assert.equal(h.live().length, 0);
});

test('administrators get Manage on rows and the Downloads/Calendar tabs; an embedded tab is left cleanly', async t => {
  const rendered = [];
  let polling = 0;
  const downloads = { _state: {}, renderForCustomTab: node => { rendered.push(['downloads', node]); node.appendChild(Object.assign(node.ownerDocument.createElement('div'), { className: 'dl' })); }, stopPolling: () => { polling++; } };
  const calendar = { renderForCustomTab: node => rendered.push(['calendar', node]) };
  const h = setup(t, {
    hash: '#/requests?tab=downloads',
    downloads, calendar,
    responses: path => (path === '/acquire/hub' ? hubAnswer({ admin: { downloads: true, calendar: false, seerr: { lastError: 'Seerr rejected the API key.' } }, seerr: { configured: true, loaded: true, unavailable: true } }) : null)
  });
  h.JE.initializeArrStatus();
  await wait(10);
  const page = h.document.getElementById('je-requests-hub-page');
  assert.deepEqual([...page.querySelectorAll('.je-hub-tab')].map(b => b.dataset.tab), ['mine', 'soon', 'ready', 'downloads']);
  // The tab named in the URL waited for the answer, then rendered the Downloads page into its own container.
  assert.equal(rendered.length, 1);
  const node = rendered[0][1];
  assert.ok(page.contains(node));
  page.querySelector('.je-hub-tab[data-tab="mine"]').click();
  assert.ok(!h.document.contains(node), 'the embedded container is removed');
  assert.equal(polling, 1);
  assert.equal(downloads._state._customTabMode, false);
  // The admin's own error words, and Manage on rows.
  assert.equal(page.querySelector('.je-hub-note-warn').textContent, 'Seerr couldn\'t be read: Seerr rejected the API key.');
  const manage = [...page.querySelectorAll('.je-hub-manage')];
  assert.equal(manage.length, 3);
  manage[1].click();
  await wait(5);
  assert.ok(h.calls.some(c => c.path === '/arr/admin/manage?key=movie%3Atmdb%3A693134'));
  assert.ok(h.document.querySelector('.je-manage'));
  h.JE.arrManage.close();

  // Leaving the page while the Downloads tab shows: its container leaves the document (the
  // Downloads page must never render into the hidden hub later) and its polling stops.
  page.querySelector('.je-hub-tab[data-tab="downloads"]').click();
  const second = rendered.at(-1)[1];
  assert.ok(h.document.contains(second));
  h.window.location.hash = '#/home';
  for (const fn of h.navigation) fn();
  assert.ok(page.classList.contains('hide'));
  assert.ok(!h.document.contains(second));
  assert.equal(polling, 2);
});

test('nothing happens with the Requests page switched off', async t => {
  const h = setup(t, { hash: '#/requests', config: { ArrRequestsHubEnabled: false } });
  h.JE.initializeArrStatus();
  await wait(10);
  assert.equal(h.document.getElementById('je-requests-hub-page'), null);
  assert.equal(h.document.querySelector('.je-nav-requests-hub-item'), null);
  assert.equal(h.calls.length, 0);
});

const overview = () => ({
  key: 'tv:tvdb:78874:s1:e4', kind: 'episode', season: 1, episode: 4, tvdbId: 78874, title: 'Firefly',
  status: {
    key: 'tv:tvdb:78874:s1:e4', kind: 'episode', stage: 'almostReady', reason: { code: 'import_blocked' }, attention: true, actions: [],
    admin: { variants: [{ instance: 'Sonarr (rig)', instanceId: 's1', kind: 'Sonarr', stage: 'almostReady', reason: { code: 'import_blocked' }, attention: true, messages: ['Manual Import required.'], fix: 'manual_import' }] }
  },
  instances: [
    { id: 's1', name: 'Sonarr (rig)', kind: 'Sonarr', role: 'standard', url: 'http://sonarr:8989', urlMappings: 'http://jellyfin.test|https://sonarr.example', live: true, readable: true, inArr: true, arrId: 1, titleSlug: 'firefly', monitored: true, sizeOnDisk: 3 * 1073741824, path: '/data/tv/Firefly',
      queue: [{ season: 1, episode: 4, state: 'importBlocked', health: 'warning', percent: 100, client: 'Mock SABnzbd', release: 'Mystery.Show.S01E04', messages: ['Manual Import required.'] }],
      timeline: [{ event: 'added', at: iso(-1) }, { event: 'grabbed', at: iso(-0.5), season: 1, episode: 4 }, { event: 'audit', at: iso(-0.1), text: 'episode.search · succeeded · jake' }] },
    { id: 's2', name: 'Sonarr 4K', kind: 'Sonarr', role: '4k', url: 'http://sonarr4k:8989', urlMappings: '', live: false, readable: true, inArr: false }
  ],
  copies: [],
  requests: [{ at: iso(-3), status: 'approved', by: 'Sam', answeredBy: 'Jake', is4k: false, seasons: [1] }]
});

test('the Manage drawer explains, offers Search now and Open in, lists versions, the timeline and the requests', async t => {
  let posted = null;
  const h = setup(t, {
    responses: (path, options) => {
      if (path.startsWith('/arr/admin/manage?')) return overview();
      if (path === '/arr/admin/manage/search') { posted = options; return { status: 'Succeeded', message: 'Done.', readBack: 'Search finished: 0 reports downloaded.' }; }
      return null;
    }
  });
  h.JE.initializeArrStatus();
  const opener = h.document.body.appendChild(h.document.createElement('button'));
  opener.focus();
  await h.JE.arrManage.open({ itemId: 'abc' }, { operation: h.NATIVE });
  assert.equal(h.calls[0].path, '/arr/admin/manage?itemId=abc');
  const drawer = h.document.querySelector('.je-manage');
  assert.equal(drawer.getAttribute('role'), 'dialog');
  assert.equal(drawer.querySelector('.je-manage-title').textContent, 'Manage · Firefly · S01E04');
  assert.ok(drawer.querySelector('.je-manage-card.je-manage-attention'));
  assert.match(drawer.querySelector('.je-arr-admin-detail').textContent, /Manual Import required\./);
  // Open in: the URL mapping for this Jellyfin address, the series page by slug.
  const open = [...drawer.querySelectorAll('a.je-manage-btn')].find(a => a.textContent.includes('Open in Sonarr (rig)'));
  assert.equal(open.getAttribute('href'), 'https://sonarr.example/series/firefly');
  assert.equal(open.getAttribute('rel'), 'noopener noreferrer');
  // Versions: the 4K instance doesn't have it; "Add in" opens its add page.
  const add = [...drawer.querySelectorAll('a.je-manage-btn')].find(a => a.textContent.includes('Add in Sonarr 4K'));
  assert.equal(add.getAttribute('href'), 'http://sonarr4k:8989/add/new?term=tvdb%3A78874');
  assert.match(drawer.textContent, /Not in Sonarr 4K/);
  // Timeline (with the queue row and a JE action) and requests.
  const labels = [...drawer.querySelectorAll('.je-manage-event-label')].map(e => e.textContent);
  assert.deepEqual(labels.slice(0, 3), ['Added', 'Grabbed', 'Jellyfin Enhanced: episode.search · succeeded · jake']);
  assert.match(labels[3], /importBlocked 100% · Mock SABnzbd/);
  assert.match(drawer.querySelector('.je-manage-request').textContent, /^Sam · .* · OK'd · Season 1$/);
  // It follows the title on the feed.
  assert.ok(h.live().some(s => s.keys.includes('tv:tvdb:78874:s1:e4')));

  // Search now: one POST with a fresh idempotency key; the outcome is shown.
  drawer.querySelector('.je-manage-btn-primary').click();
  await wait(5);
  assert.equal(posted.method, 'POST');
  assert.equal(posted.body.instanceId, 's1');
  assert.equal(posted.body.key, 'tv:tvdb:78874:s1:e4');
  assert.ok(posted.body.idempotencyKey.length >= 8);
  assert.equal(drawer.querySelector('.je-manage-result').textContent, 'Done. Search finished: 0 reports downloaded.');
  // The search changes the title, so the drawer is read again: the outcome stays shown.
  h.live().find(s => s.keys.includes('tv:tvdb:78874:s1:e4')).cb(['tv:tvdb:78874:s1:e4']);
  const reads = () => h.calls.filter(c => c.path.startsWith('/arr/admin/manage?')).length;
  await until(() => reads() >= 2);
  await wait(20);
  assert.ok(reads() >= 2);
  assert.equal(drawer.querySelector('.je-manage-result').textContent, 'Done. Search finished: 0 reports downloaded.');

  // Esc closes it and gives focus back.
  drawer.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(h.document.querySelector('.je-manage'), null);
  assert.equal(h.document.activeElement, opener);
  assert.equal(h.live().length, 0);
});

test('details pages get the Manage button only with an admin status', t => {
  const h = setup(t, { html: '<div id="itemDetailPage"><div class="mainDetailButtons"></div></div>' });
  const page = h.document.getElementById('itemDetailPage');
  const attach = h.JE.internals.arrManage.attachDetails;
  attach(page, { itemId: 'abc', kind: 'movie', stage: 'ready' });
  assert.equal(page.querySelectorAll('.je-manage-open').length, 0);
  attach(page, { itemId: 'abc', kind: 'movie', stage: 'ready', admin: { variants: [] } });
  attach(page, { itemId: 'abc', kind: 'movie', stage: 'ready', admin: { variants: [] } });
  assert.equal(page.querySelectorAll('.je-manage-open').length, 1);
  attach(page, null);
  assert.equal(page.querySelectorAll('.je-manage-open').length, 0);
});

test('a request whose title the viewer has no copy of opens the title\'s native page; with only a key, through the server', async t => {
  const h = setup(t, { hash: '#/requests', responses: path => (path === '/acquire/hub' ? hubAnswer({ mine: [
    entry('Dune', 'onTheWay', 'downloading', 'downloading', { key: 'movie:tmdb:693134', tmdbId: 693134, kind: 'movie' }),
    entry('Andor', 'onTheWay', 'approved', 'approved', { key: 'tv:tvdb:393189', kind: 'tv', tmdbId: 0 })
  ] }) : null) });
  const shown = [], keyed = [];
  h.JE.titleDetails = { show: (id, type) => { shown.push([id, type]); return true; }, openKey: async (key, o) => { keyed.push([key, o.mediaType]); return true; } };
  h.JE.initializeArrStatus();
  await wait(10);
  const page = h.document.getElementById('je-requests-hub-page');
  const rows = [...page.querySelectorAll('.je-hub-row')];
  rows.find(r => r.dataset.jeArrKey === 'movie:tmdb:693134').click();
  rows.find(r => r.dataset.jeArrKey === 'tv:tvdb:393189').click();
  assert.deepEqual(shown, [[693134, 'movie']]);
  assert.deepEqual(keyed, [['tv:tvdb:393189', 'tv']]);
});

test('on the page of a title that is not in the library, Manage opens by the title\'s key', t => {
  const PAGE_ID = '4a45ad130001479b0001000092805890';
  const h = setup(t, { hash: `#/details?id=${PAGE_ID}`, html: '<div id="itemDetailPage"><div class="mainDetailButtons"></div></div>' });
  h.JE.titleDetails = { isSynthetic: id => id === PAGE_ID };
  const opened = [];
  const page = h.document.getElementById('itemDetailPage');
  h.JE.internals.arrManage.attachDetails(page, { key: 'tv:tvdb:393189:s1', itemId: PAGE_ID, kind: 'season', stage: 'notHere', admin: { variants: [] } });
  const button = page.querySelector('.je-manage-open');
  assert.equal(button.dataset.itemId, 'key:tv:tvdb:393189');
  // A movie status of such a page names no item at all: still by key.
  h.JE.internals.arrManage.attachDetails(page, { key: 'movie:tmdb:5', kind: 'movie', stage: 'notHere', admin: { variants: [] } });
  assert.equal(page.querySelector('.je-manage-open').dataset.itemId, 'key:movie:tmdb:5');
  void opened;
});

test('the Seerr more-info modal gets the pill and journey of its title, follows it, and admins get Manage', async t => {
  const answers = { 'movie:tmdb:5': [status('downloading', 'downloading', { key: 'movie:tmdb:5', progress: { percent: 42 }, journey: [{ stage: 'asked', state: 'done', byYou: false }, { stage: 'downloading', state: 'current' }, { stage: 'ready', state: 'next' }] })] };
  const h = setup(t, {
    responses: path => {
      const m = /keys=([^&]+)&detail=true/.exec(path);
      return m ? { contact: 'Dad', items: answers[decodeURIComponent(m[1])] || [] } : null;
    }
  });
  h.JE.initializeArrStatus();
  const modal = h.document.body.appendChild(h.document.createElement('div'));
  modal.innerHTML = '<div class="header-info"><div data-mount="je-requested-by"></div></div>';
  h.document.dispatchEvent(new h.window.CustomEvent('jellyseerr-more-info-opened', { detail: { modal, data: { id: 5 }, mediaType: 'movie' } }));
  await wait(5);
  assert.equal(h.calls.at(-1).path, '/acquire/status?keys=movie%3Atmdb%3A5&detail=true');
  const pill = modal.querySelector('.je-arr-modal-status .je-arr-pill');
  assert.equal(pill.querySelector('.je-arr-pill-text').textContent, 'Downloading · 42%');
  pill.click();
  assert.match(modal.querySelector('.je-arr-journey').textContent, /Asked by someone in your household/);
  assert.equal(modal.querySelectorAll('.je-arr-modal-manage').length, 0);
  // A change on the feed re-reads in place.
  answers['movie:tmdb:5'] = [status('ready', 'ready', { key: 'movie:tmdb:5', admin: { variants: [] } })];
  h.live().at(-1).cb(['movie:tmdb:5']);
  await wait(5);
  assert.equal(modal.querySelector('.je-arr-pill-text').textContent, 'Ready to watch');
  assert.equal(modal.querySelectorAll('.je-arr-modal-manage').length, 1);

  // A series uses its TVDB id; a quiet answer shows nothing.
  const other = h.document.body.appendChild(h.document.createElement('div'));
  other.innerHTML = '<div data-mount="je-requested-by"></div>';
  answers['tv:tvdb:78874'] = [status('ready', 'ready', { key: 'tv:tvdb:78874', quiet: true })];
  h.document.dispatchEvent(new h.window.CustomEvent('jellyseerr-more-info-opened', { detail: { modal: other, data: { id: 1437, externalIds: { tvdbId: 78874 } }, mediaType: 'tv' } }));
  await wait(5);
  assert.equal(h.calls.at(-1).path, '/acquire/status?keys=tv%3Atvdb%3A78874&detail=true');
  assert.equal(other.querySelectorAll('.je-arr-pill').length, 0);
  // The first modal's late close event doesn't stop the second.
  modal.remove();
  h.document.dispatchEvent(new h.window.CustomEvent('jellyseerr-more-info-closed'));
  assert.ok(h.live().some(s => s.keys.includes('tv:tvdb:78874')));
  other.remove();
  h.document.dispatchEvent(new h.window.CustomEvent('jellyseerr-more-info-closed'));
  assert.equal(h.live().length, 0);
});

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

test('leaving and coming back while the first read is still running starts a new read that renders and follows', async t => {
  const answers = [];
  const h = setup(t, {
    hash: '#/requests',
    responses: path => {
      if (path !== '/acquire/hub') return null;
      const d = deferred();
      answers.push(d);
      return d.promise;
    }
  });
  h.JE.initializeArrStatus();
  await wait(10);
  assert.equal(answers.length, 1);
  // Back, then Forward, before the first answer.
  h.window.location.hash = '#/home';
  for (const fn of h.navigation) fn();
  h.window.location.hash = '#/requests';
  for (const fn of h.navigation) fn();
  await wait(10);
  assert.equal(answers.length, 2, 'the new visit reads again');
  answers[1].resolve(hubAnswer());
  answers[0].resolve(hubAnswer({ mine: [] }));
  await wait(10);
  const page = h.document.getElementById('je-requests-hub-page');
  assert.ok(!page.classList.contains('hide'));
  assert.equal(page.querySelectorAll('.je-hub-group-title').length, 3);
  const sub = h.live().at(-1);
  assert.ok(sub, 'it follows the feed');
  assert.ok(sub.keys.includes(`req:u:${USER}`));
  // The shared request-list state (Seerr first read, failure, recovery) too.
  assert.ok(sub.keys.includes('req:state'));
});

test('Search now stays busy across re-renders (no second search), and focus never leaves the drawer', async t => {
  const posts = [];
  const h = setup(t, {
    responses: (path, options) => {
      if (path.startsWith('/arr/admin/manage?')) {
        const data = overview();
        data.status.journey = [{ stage: 'asked', state: 'done' }, { stage: 'almostReady', state: 'current' }];
        return data;
      }
      if (path === '/arr/admin/manage/search') {
        const d = deferred();
        posts.push(d);
        return d.promise;
      }
      return null;
    }
  });
  h.JE.initializeArrStatus();
  await h.JE.arrManage.open({ key: 'tv:tvdb:78874:s1:e4' }, { operation: h.NATIVE });
  const drawer = h.document.querySelector('.je-manage');
  const search = () => drawer.querySelector('.je-manage-btn-primary');
  // Shift+Tab from the drawer itself (where focus is on open) wraps to its last control.
  assert.equal(h.document.activeElement, drawer);
  drawer.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }));
  assert.ok(drawer.contains(h.document.activeElement) && h.document.activeElement !== drawer);

  search().focus();
  search().click();
  await wait(5);
  assert.equal(posts.length, 1);
  assert.equal(search().getAttribute('aria-disabled'), 'true');
  assert.match(search().textContent, /Searching…$/);
  assert.equal(h.document.activeElement, search(), 'focus stays on the (busy) button');
  // The search changes the title: the drawer re-renders, the button is still busy, a click does nothing.
  const readsBefore = h.calls.filter(c => c.path.startsWith('/arr/admin/manage?')).length;
  h.live().find(s => s.keys.includes('tv:tvdb:78874:s1:e4')).cb(['tv:tvdb:78874:s1:e4']);
  await until(() => h.calls.filter(c => c.path.startsWith('/arr/admin/manage?')).length > readsBefore);
  await wait(20);
  assert.equal(search().getAttribute('aria-disabled'), 'true');
  search().click();
  await wait(5);
  assert.equal(posts.length, 1, 'no second search while the first runs');
  posts[0].resolve({ status: 'Succeeded', message: 'Done.' });
  await wait(5);
  assert.equal(search().getAttribute('aria-disabled'), null);
  assert.equal(drawer.querySelector('.je-manage-result').textContent, 'Done.');
  assert.ok(drawer.contains(h.document.activeElement));

  // The journey pill keeps focus across a live re-render.
  const pill = drawer.querySelector('.je-arr-pill');
  pill.focus();
  h.live().find(s => s.keys.includes('tv:tvdb:78874:s1:e4')).cb(['tv:tvdb:78874:s1:e4']);
  await until(() => drawer.querySelector('.je-arr-pill') !== pill);
  assert.notEqual(drawer.querySelector('.je-arr-pill'), pill, 're-rendered');
  assert.equal(h.document.activeElement, drawer.querySelector('.je-arr-pill'));
  // Focus moved to the page behind comes back to the drawer (Esc keeps working).
  const behind = h.document.body.appendChild(h.document.createElement('button'));
  behind.focus();
  assert.ok(drawer.contains(h.document.activeElement));
  drawer.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(h.document.querySelector('.je-manage'), null);
  // Closed: focus is free again.
  behind.focus();
  assert.equal(h.document.activeElement, behind);
});

test('the drawer sits above Seerr\'s more-info window it can be opened from', () => {
  const zOf = (file, selector) => {
    const source = readFileSync(resolve(jsRoot, file), 'utf8');
    const at = source.indexOf(selector);
    assert.ok(at >= 0, selector);
    return Number(/z-index:\s*(\d+)/.exec(source.slice(at))[1]);
  };
  const drawer = zOf('arr/manage/manage-styles.js', '.je-manage-overlay');
  const modal = zOf('jellyseerr/moreinfo/more-info-modal-styles.js', '.je-more-info-modal');
  const popup = zOf('jellyseerr/moreinfo/more-info-modal-styles.js', '.je-4k-popup');
  assert.ok(drawer > modal, `${drawer} > ${modal}`);
  assert.ok(drawer < popup, `${drawer} < ${popup}`);
});

test('the modal of a series known only by TMDB follows the viewer\'s own request list instead', async t => {
  const h = setup(t, {
    responses: path => (/detail=true/.test(path) ? { contact: 'Dad', items: [status('asked', 'awaiting_approval', { key: 'tv:tmdb:99' })] } : null)
  });
  h.JE.initializeArrStatus();
  const modal = h.document.body.appendChild(h.document.createElement('div'));
  modal.innerHTML = '<div data-mount="je-requested-by"></div>';
  h.document.dispatchEvent(new h.window.CustomEvent('jellyseerr-more-info-opened', { detail: { modal, data: { id: 99, externalIds: {} }, mediaType: 'tv' } }));
  await wait(5);
  assert.equal(h.calls.at(-1).path, '/acquire/status?keys=tv%3Atmdb%3A99&detail=true');
  assert.deepEqual(h.live().at(-1).keys, ['tv:tmdb:99', `req:u:${USER}`]);
  // With a key the feed carries, no extra key.
  assert.deepEqual([...h.JE.internals.arrStatusModal.followKeys('tv:tvdb:5', {})], ['tv:tvdb:5']);
  assert.deepEqual([...h.JE.internals.arrStatusModal.followKeys('tv:tmdb:5', { liveKey: 'tv:tvdb:7' })], ['tv:tmdb:5', 'tv:tvdb:7']);
});

test('keyboard and D-pad focus stays on the same tab, row or button when the page re-renders', async t => {
  let n = 0;
  const h = setup(t, {
    hash: '#/requests',
    responses: path => {
      if (path !== '/acquire/hub') return null;
      n++;
      // Second read: Dune's progress moved. Third: Dune has gone from the list.
      if (n === 3) return hubAnswer({ mine: [entry('Waiting Film', 'needsOk', 'asked', 'awaiting_approval')] });
      return hubAnswer(n === 1 ? {} : { mine: [entry('Dune', 'onTheWay', 'downloading', 'downloading', { key: 'movie:tmdb:693134', status: { progress: { percent: 43, etaSeconds: 700 } } })] });
    }
  });
  h.JE.initializeArrStatus();
  await wait(10);
  const page = h.document.getElementById('je-requests-hub-page');
  const dune = () => [...page.querySelectorAll('.je-hub-row')].find(r => r.dataset.jeArrKey === 'movie:tmdb:693134');
  dune().focus();
  const before = dune();
  assert.equal(h.document.activeElement, before);
  // A progress tick re-reads and rebuilds the list: focus is on the new Dune row, not <body>.
  h.live().at(-1).cb(['movie:tmdb:693134']);
  await until(() => h.calls.filter(c => c.path === '/acquire/hub').length >= 2 && dune() !== before);
  assert.notEqual(dune(), before);
  assert.equal(h.document.activeElement, dune());
  // The row is gone after the next read: the selected tab gets focus.
  h.live().at(-1).cb(['movie:tmdb:693134']);
  await until(() => !dune());
  await wait(20);
  assert.equal(h.document.activeElement, page.querySelector('.je-hub-tab[data-tab="mine"]'));

  // A tab chosen with the keyboard keeps focus once its panel is shown; so does a Play button.
  page.querySelector('.je-hub-tab[data-tab="ready"]').focus();
  page.querySelector('.je-hub-tab[data-tab="ready"]').click();
  assert.equal(h.document.activeElement, page.querySelector('.je-hub-tab[data-tab="ready"]'));
  page.querySelector('.je-hub-btn-primary').focus();
  h.live().at(-1).cb(['movie:tmdb:5']);
  await until(() => h.calls.filter(c => c.path === '/acquire/hub').length >= 4);
  await wait(20);
  assert.equal(h.document.activeElement?.dataset.jeFocus, 'play:movie:tmdb:6');
  // Focus that was never on the page is left alone.
  h.document.activeElement.blur();
  h.live().at(-1).cb(['movie:tmdb:5']);
  await until(() => h.calls.filter(c => c.path === '/acquire/hub').length >= 5);
  await wait(20);
  assert.equal(h.document.activeElement, h.document.body);
});

/**
 * Takes over the page's long timers (≥ 5 s: the re-read retries) so a test runs them when it wants;
 * shorter ones run as usual.
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
    delays: () => [...held.values()].map(x => x.ms),
    run() { const all = [...held.entries()]; held.clear(); for (const [, x] of all) x.fn(); return all.length; }
  };
}

test('a failed re-read keeps the rows, says so with Retry, tries again with backoff and stops when the page is left', async t => {
  let n = 0;
  const outcome = [];
  const h = setup(t, {
    hash: '#/requests',
    responses: path => {
      if (path !== '/acquire/hub') return null;
      n++;
      const next = outcome.shift();
      return next === 'fail' ? Object.assign(new Error('HTTP 502'), { status: 502 }) : hubAnswer();
    }
  });
  const timers = holdLongTimers(h);
  h.JE.initializeArrStatus();
  await wait(10);
  const page = h.document.getElementById('je-requests-hub-page');
  assert.equal(page.querySelectorAll('.je-hub-row').length, 3);
  assert.equal(page.querySelector('.je-hub-refresh-failed'), null);

  // A change asks for a re-read that fails: the rows stay, with the note and a Retry.
  outcome.push('fail');
  h.live().at(-1).cb(['movie:tmdb:693134']);
  await until(() => page.querySelector('.je-hub-refresh-failed'));
  const note = page.querySelector('.je-hub-refresh-failed');
  assert.equal(note.getAttribute('role'), 'status');
  assert.match(note.textContent, /^Couldn't refresh · showing what we had at /);
  const firstNote = note.querySelector('.je-arr-stale-text').textContent;
  assert.equal(page.querySelectorAll('.je-hub-row').length, 3);
  assert.deepEqual(timers.delays(), [5000]);
  // The retry fails again: the time on the note is still the last good read; the wait doubles.
  outcome.push('fail');
  timers.run();
  await until(() => timers.delays().length === 1);
  assert.deepEqual(timers.delays(), [10000]);
  assert.equal(page.querySelector('.je-hub-refresh-failed .je-arr-stale-text').textContent, firstNote);
  // Retry by hand works: the note goes, nothing is scheduled.
  page.querySelector('.je-hub-refresh-failed .je-arr-stale-retry').click();
  await until(() => !page.querySelector('.je-hub-refresh-failed'));
  assert.deepEqual(timers.delays(), []);
  assert.equal(page.querySelectorAll('.je-hub-row').length, 3);

  // Failing again, then leaving the page: the retry is dropped.
  outcome.push('fail');
  h.live().at(-1).cb(['movie:tmdb:693134']);
  await until(() => timers.delays().length === 1);
  h.window.location.hash = '#/home';
  for (const fn of h.navigation) fn();
  assert.deepEqual(timers.delays(), []);
  const reads = n;
  timers.run();
  await wait(20);
  assert.equal(n, reads);
});

test('a first read that fails shows the error box, not old rows', async t => {
  const h = setup(t, { hash: '#/requests', responses: path => (path === '/acquire/hub' ? Object.assign(new Error('HTTP 500'), { status: 500 }) : null) });
  h.JE.initializeArrStatus();
  await wait(20);
  const page = h.document.getElementById('je-requests-hub-page');
  assert.equal(page.querySelector('.je-hub-empty').firstChild.textContent, "Couldn't load your requests. Try again in a moment.");
  assert.equal(page.querySelector('.je-hub-refresh-failed'), null);
});

test('Hidden Content hides rows and counts on the Requests page (global hides, the same kind only)', async t => {
  let settings = { enabled: true, filterRequests: true };
  let hidden = [
    { itemId: 'ABC', hideScope: 'global', type: 'Movie' },              // Sintel (ready) by item id
    { tmdbId: 4, type: 'Movie', hideScope: 'global' },                 // Dune by TMDB id
    { tmdbId: 9, type: 'Series', hideScope: 'global' },                // a series with Agent 327's TMDB id: not it
    { tmdbId: 12, type: 'Movie', hideScope: 'nextup' }                 // Waiting Film hidden from Next Up only
  ];
  const h = setup(t, { hash: '#/requests', responses: path => (path === '/acquire/hub' ? hubAnswer() : null) });
  h.JE.hiddenContent = { getSettings: () => settings, getAllHiddenItems: () => hidden };
  h.JE.initializeArrStatus();
  await wait(10);
  const page = h.document.getElementById('je-requests-hub-page');
  const titles = () => [...page.querySelectorAll('.je-hub-row .je-hub-name')].map(n => n.firstChild.textContent);
  const count = tab => page.querySelector(`.je-hub-tab[data-tab="${tab}"] .je-hub-tab-count`)?.textContent ?? '';
  assert.deepEqual(titles(), ['Waiting Film', '<img src=x onerror=alert(1)>']);
  assert.equal(count('mine'), '1');
  assert.equal(count('ready'), '');
  page.querySelector('.je-hub-tab[data-tab="ready"]').click();
  assert.equal(page.querySelector('.je-hub-empty').textContent, 'Nothing you asked for arrived in the last two weeks.');
  page.querySelector('.je-hub-tab[data-tab="soon"]').click();
  assert.deepEqual(titles(), ['Agent 327']);

  // Unhiding (here or elsewhere) shows at once, without a new read.
  const reads = h.calls.filter(c => c.path === '/acquire/hub').length;
  hidden = [];
  h.window.dispatchEvent(new h.window.CustomEvent('je-hidden-content-changed'));
  assert.equal(count('ready'), '1');
  assert.equal(count('mine'), '2');
  // Hidden Content switched off for requests: nothing is hidden.
  hidden = [{ tmdbId: 4, type: 'Movie', hideScope: 'global' }];
  settings = { enabled: true, filterRequests: false };
  h.window.dispatchEvent(new h.window.CustomEvent('je-hidden-content-changed'));
  assert.equal(count('mine'), '2');
  assert.equal(h.calls.filter(c => c.path === '/acquire/hub').length, reads);
});

test('Coming soon drops a release day that has passed here; the page says when titles are capped or downloads unknown', async t => {
  const pad = n => String(n).padStart(2, '0');
  const day = offset => { const d = new Date(Date.now() + offset * 86400000); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
  const h = setup(t, {
    hash: '#/requests?tab=soon',
    responses: path => (path === '/acquire/hub' ? hubAnswer({
      soon: [
        entry('Yesterday Film', 'notOut', 'notOut', 'not_released', { key: 'movie:tmdb:5001', nextDate: iso(0), nextDay: day(-1) }),
        entry('Today Film', 'notOut', 'notOut', 'not_released', { key: 'movie:tmdb:5002', nextDate: iso(0), nextDay: day(0) })
      ],
      more: true,
      arr: { unavailable: true }
    }) : null)
  });
  h.JE.initializeArrStatus();
  await wait(10);
  const page = h.document.getElementById('je-requests-hub-page');
  assert.deepEqual([...page.querySelectorAll('.je-hub-row .je-hub-name')].map(n => n.firstChild.textContent), ['Today Film']);
  assert.equal(page.querySelector('.je-hub-day').textContent, 'today');
  assert.equal(page.querySelector('.je-hub-tab[data-tab="soon"] .je-hub-tab-count').textContent, '1');
  assert.match(page.querySelector('.je-hub-more').textContent, /200 at most/);
  const arr = page.querySelector('.je-hub-arr-unavailable');
  assert.equal(arr.getAttribute('role'), 'status');
  assert.doesNotMatch(arr.textContent, /Radarr|Sonarr/);
});

test('the Manage drawer says when a queue it can\'t read was last read, and how old a stale one is', async t => {
  let expired = true;
  const h = setup(t, {
    responses: path => path.startsWith('/arr/admin/manage?')
      ? { key: 'movie:tmdb:1', kind: 'movie', title: 'Dune', status: status('looking', 'service_down'), instances: [{ id: 'r1', name: 'Radarr', kind: 'Radarr', inArr: true, readable: true, queue: [], queueTotal: 0, downloads: [], downloadsTotal: 0, timeline: [], queueAsOf: '2026-10-12T10:00:00Z', queueExpired: expired }], requests: [] }
      : null
  });
  h.JE.initializeArrStatus();
  await h.JE.arrManage.open({ key: 'movie:tmdb:1' }, { operation: h.NATIVE });
  const drawer = h.document.querySelector('.je-manage');
  const note = drawer.querySelector('.je-manage-event-queue-asof');
  assert.ok(note, 'the expired queue is said');
  assert.equal(note.getAttribute('role'), 'status');
  assert.match(note.querySelector('.je-manage-event-label').textContent, /^queue can't be read; last read /);
  drawer.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  expired = false;
  await h.JE.arrManage.open({ key: 'movie:tmdb:1' }, { operation: h.NATIVE });
  assert.match(h.document.querySelector('.je-manage .je-manage-event-queue-asof .je-manage-event-label').textContent, /^queue as of /);
});

test('the Manage drawer keeps what it shows when a re-read fails, says so, and retries until it works', async t => {
  let fail = false;
  let reads = 0;
  const h = setup(t, {
    responses: path => {
      if (!path.startsWith('/arr/admin/manage?')) return null;
      reads++;
      return fail ? Object.assign(new Error('HTTP 502'), { status: 502 }) : { key: 'movie:tmdb:1', kind: 'movie', title: 'Dune', status: status('downloading', 'downloading'), instances: [{ id: 'r1', name: 'Radarr', kind: 'Radarr', inArr: true, readable: true, queue: [{ state: 'downloading', percent: 5 }], queueTotal: 3, downloads: [], downloadsTotal: 0, timeline: [] }], requests: [] };
    }
  });
  const timers = holdLongTimers(h);
  h.JE.initializeArrStatus();
  await h.JE.arrManage.open({ key: 'movie:tmdb:1' }, { operation: h.NATIVE });
  const drawer = h.document.querySelector('.je-manage');
  assert.match(drawer.textContent, /and 2 more/);
  fail = true;
  h.live().find(s => s.keys.includes('movie:tmdb:1')).cb(['movie:tmdb:1']);
  await until(() => drawer.querySelector('.je-manage-stale'));
  assert.equal(drawer.querySelector('.je-manage-stale').getAttribute('role'), 'status');
  assert.equal(drawer.querySelector('.je-manage-title').textContent, 'Manage · Dune');
  assert.deepEqual(timers.delays(), [5000]);
  fail = false;
  timers.run();
  await until(() => !drawer.querySelector('.je-manage-stale'));
  assert.deepEqual(timers.delays(), []);
  // Closing drops a pending retry.
  fail = true;
  h.live().find(s => s.keys.includes('movie:tmdb:1')).cb(['movie:tmdb:1']);
  await until(() => timers.delays().length === 1);
  drawer.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.deepEqual(timers.delays(), []);
  assert.ok(reads >= 3);
});

// D46 r16: a retry belongs to the session that failed. Another account signing in (before the session hook has run)
// must not have that retry sent under its credentials or its answer shown in the first account's view.
test('a Requests page retry is never sent or shown after another account signs in', async t => {
  let n = 0;
  const outcome = [];
  const h = setup(t, {
    hash: '#/requests',
    responses: path => {
      if (path !== '/acquire/hub') return null;
      n++;
      return outcome.shift() === 'fail' ? Object.assign(new Error('HTTP 502'), { status: 502 }) : hubAnswer();
    }
  });
  const timers = holdLongTimers(h);
  h.JE.initializeArrStatus();
  await wait(10);
  const page = h.document.getElementById('je-requests-hub-page');
  outcome.push('fail');
  h.live().at(-1).cb(['movie:tmdb:693134']);
  await until(() => page.querySelector('.je-hub-refresh-failed'));
  assert.deepEqual(timers.delays(), [5000]);
  h.window.ApiClient.getCurrentUserId = () => 'fedcba9876543210fedcba9876543210';
  const reads = n;
  timers.run();
  await wait(30);
  assert.equal(n, reads, 'the retry is not sent for the new account');
});

test('a Manage drawer retry is never sent or shown after another account signs in', async t => {
  let fail = false;
  let reads = 0;
  const h = setup(t, {
    responses: path => {
      if (!path.startsWith('/arr/admin/manage?')) return null;
      reads++;
      return fail ? Object.assign(new Error('HTTP 502'), { status: 502 }) : { key: 'movie:tmdb:1', kind: 'movie', title: 'Dune', status: status('downloading', 'downloading'), instances: [], requests: [] };
    }
  });
  const timers = holdLongTimers(h);
  h.JE.initializeArrStatus();
  await h.JE.arrManage.open({ key: 'movie:tmdb:1' }, { operation: h.NATIVE });
  const drawer = h.document.querySelector('.je-manage');
  fail = true;
  h.live().find(s => s.keys.includes('movie:tmdb:1')).cb(['movie:tmdb:1']);
  await until(() => drawer.querySelector('.je-manage-stale'));
  assert.deepEqual(timers.delays(), [5000]);
  h.window.ApiClient.getCurrentUserId = () => 'fedcba9876543210fedcba9876543210';
  fail = false;
  const before = reads;
  timers.run();
  await wait(30);
  assert.equal(reads, before, 'the retry is not sent for the new account');
  assert.ok(drawer.querySelector('.je-manage-stale'), 'nothing new is shown in the first account\'s drawer');
});

// int12 live smoke: from a dashboard page loaded directly (a reload on the plugin settings), Jellyfin's router answers
// #/requests by swapping the whole layout, and the page the hub had just put into the dashboard's layout went with it:
// a blank page. The router's own "not found" page for #/requests is the sign it has finished; the hub mounts again.
test('#/requests from a dashboard page mounts again in the layout the router swaps in', async t => {
  const h = setup(t, {
    html: '<div class="dashboardLayout"><div class="mainAnimatedPages"><div class="mainAnimatedPage page" id="JellyfinEnhancedPage"></div></div></div>',
    hash: '#/configurationpage?name=Jellyfin%20Enhanced',
    responses: path => (path === '/acquire/hub' ? hubAnswer() : null)
  });
  // The dashboard layout comes first in the document, as it does when the dashboard is what loaded.
  const layout = h.document.querySelector('.dashboardLayout');
  h.document.body.prepend(layout);
  h.JE.initializeArrStatus();
  await wait(10);
  h.window.location.hash = '#/requests';
  await wait(10);
  assert.ok(layout.contains(h.document.getElementById('je-requests-hub-page')), 'first put into the dashboard\'s layout');
  // The router swaps the layout and shows its "not found" page.
  layout.remove();
  const fallback = h.document.createElement('div');
  fallback.id = 'fallbackPage';
  fallback.className = 'page mainAnimatedPage libraryPage';
  h.document.querySelector('.mainAnimatedPages').appendChild(fallback);
  fallback.dispatchEvent(new h.window.CustomEvent('viewshow', { bubbles: true }));
  await wait(10);
  const page = h.document.getElementById('je-requests-hub-page');
  assert.ok(page && page.isConnected && !page.classList.contains('hide'), 'the page is in the document again');
  assert.deepEqual([...page.querySelectorAll('.je-hub-tab')].map(b => b.dataset.tab), ['mine', 'soon', 'ready']);
  assert.equal(h.calls.filter(c => c.path === '/acquire/hub').length, 1, 'from the one read');
});
