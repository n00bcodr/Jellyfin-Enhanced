// Requests & downloads, phase 2: the bell and inbox, toasts (never during playback), Notify me /
// Following on details pages, in Seerr's more-info window and on Requests page rows, Remind, and
// the "Requests & alerts" settings, rendered by the real modules from server answers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { createHarness, jsRoot } from '../helpers/harness.mjs';
import { fakeClock } from '../helpers/fake-clock.mjs';

const en = JSON.parse(readFileSync(resolve(jsRoot, 'locales/en.json'), 'utf8'));
const MODULES = ['core/mutation-queue.js', 'arr/status/status-core.js', 'arr/notify/notify-core.js', 'arr/notify/notify-follow.js', 'arr/notify/notify-bell.js', 'arr/notify/notify-panel.js', 'arr/notify/notify-styles.js'];
const USER = '0123456789abcdef0123456789abcdef';
const plain = v => JSON.parse(JSON.stringify(v));

function translate(key, params) {
  const text = en[key];
  if (text === undefined) throw new Error(`missing en.json key ${key}`);
  return Object.entries(params || {}).reduce((s, [k, v]) => s.split(`{${k}}`).join(String(v)), text);
}

const item = (id, kind, params = {}, extra = {}) => ({ id, kind, createdAt: new Date(Date.now() - 5 * 60000).toISOString(), read: false, params, link: '#/requests', ...extra });
const prefsBody = (over = {}) => ({
  prefs: { toasts: true, ready: true, episodes: true, declined: true, autoFollowRequests: true, ntfy: true, ntfyTopic: 'je-abcdefghijkl', email: false, hideTitles: false, quietHours: true, quietFrom: '22:00', quietTo: '07:00', ...over },
  channels: { ntfy: { available: true, server: 'https://ntfy.example' }, email: { available: true } },
  contact: 'Dad',
  admin: false
});

function setup(t, { config = {}, routes = {}, hash = '#/home', clock } = {}) {
  const calls = [];
  const subscriptions = [];
  const navigation = [];
  const userChange = [];
  const state = {
    inbox: { unread: 0, more: false, items: [] },
    follows: { follows: [], muted: [], requested: [] },
    prefs: prefsBody()
  };
  const h = createHarness({
    html: '<div class="skinHeader"><div class="headerRight"><div id="tray"></div></div></div><div id="itemDetailPage"><div class="mainDetailButtons"></div><div class="detailPagePrimaryContent"><div class="detailSection"></div></div></div>',
    url: `http://jellyfin.test/web/index.html${hash}`,
    // A manual clock for the page's timers when the test passes one (helpers/fake-clock.mjs).
    globals: clock ? clock.globals : {},
    apiClient: { getCurrentUserId: () => USER },
    JE: {
      pluginConfig: { ArrStatusEnabled: true, ArrNotificationsEnabled: true, ...config },
      t: translate,
      escapeHtml: s => String(s).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`),
      helpers: { debounce: fn => fn, getHeaderButtonTray: () => h.document.getElementById('tray'), onBodyMutation: () => ({ unsubscribe() {} }), addCSS: (id, css) => { const s = h.document.createElement('style'); s.id = id; s.textContent = css; h.document.head.appendChild(s); } },
      core: {
        api: {
          plugin: async (path, options = {}) => {
            calls.push({ path, method: options.method || 'GET', body: options.body });
            const route = Object.keys(routes).find(r => path.startsWith(r));
            if (route) return routes[route](path, options, state);
            // An older page (`before=`) answers from `olderInbox` when a test sets one, so a first-page refresh still in flight
            // answers the first page.
            if (path.startsWith('/acquire/notify/inbox')) return JSON.parse(JSON.stringify(path.includes('before=') && state.olderInbox ? state.olderInbox : state.inbox));
            if (path === '/acquire/follows' && !options.method) return state.follows;
            if (path === '/acquire/follows') {
              const list = new Set(state.follows.follows.map(f => f.key));
              if (options.body.on) list.add(options.body.key); else list.delete(options.body.key);
              state.follows = { ...state.follows, follows: [...list].map(key => ({ key })) };
              return { key: options.body.key, following: options.body.on };
            }
            if (path === '/acquire/notify/prefs' && !options.method) return state.prefs;
            if (path === '/acquire/notify/prefs') { state.prefs = prefsBody({ ...state.prefs.prefs, ...options.body }); return state.prefs; }
            if (path === '/acquire/notify/read') { state.inbox.unread = 0; return { changed: 1, unread: 0 }; }
            throw Object.assign(new Error('HTTP 404'), { status: 404 });
          }
        },
        navigation: { onNavigate: fn => { navigation.push(fn); return () => {}; }, onViewPage: () => () => {} },
        lifecycle: { register: () => ({ track: x => x }) }
      },
      arr: {
        live: { position: () => ({ epoch: 'e1', cursor: 1 }) },
        onStatusChange(keys, cb) {
          const sub = { keys: [...keys], cb, active: true };
          subscriptions.push(sub);
          return () => { sub.active = false; };
        }
      },
      session: { getEpoch: () => 0, isCurrent: () => true, onUserChange: (name, fn) => { userChange.push(fn); } },
      isVideoPage: () => h.window.location.hash.startsWith('#/video')
    }
  });
  t.after(() => h.close());
  for (const m of MODULES) h.load(m);
  return { ...h, get NATIVE() { return h.NATIVE; }, calls, subscriptions, navigation, state, N: h.JE.internals.arrNotify, switchUser: () => userChange.forEach(fn => fn()) };
}

async function until(check, ms = 10000) {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await wait(10);
  assert.ok(check(), 'condition never became true');
}

test('every key the notification modules use is in en.json', () => {
  const dir = resolve(jsRoot, 'arr/notify');
  for (const file of readdirSync(dir)) {
    const source = readFileSync(resolve(dir, file), 'utf8');
    for (const [, key] of source.matchAll(/'(arr_notify_[a-z0-9_]+)'/g)) {
      if (key === 'arr_notify_err_') continue;
      assert.ok(key in en, `${file}: ${key}`);
    }
    for (const [, list] of source.matchAll(/const ERRORS = \[([^\]]+)\]/g)) {
      for (const [, code] of list.matchAll(/'([a-z_]+)'/g)) assert.ok(`arr_notify_err_${code}` in en, code);
    }
  }
});

test('OK\'d requests read in family words (on its way when someone else asked), and their switch shows only when the server offers it', async t => {
  const h = setup(t);
  h.state.inbox = {
    unread: 2, more: false, items: [
      item(7, 'approved', { title: 'Firefly', contact: 'Dad', scope: 'S1E4' }),
      item(6, 'approved', { title: 'Dune', shared: '1' }),
      item(5, 'stuck_digest', { count: '1', hours: '6', items: 'Dune' })
    ]
  };
  h.JE.initializeArrNotify();
  await until(() => h.document.getElementById('je-notify-bell'));
  await h.JE.arrNotify.loadPrefs();
  await h.JE.arrNotify.refresh();
  h.click(h.document.getElementById('je-notify-bell'));
  const rows = [...h.document.querySelectorAll('.je-notify-panel .je-notify-item')];
  assert.deepEqual(rows.map(r => r.querySelector('.je-notify-text').textContent), [
    "Dad OK'd Firefly S1E4",
    'Dune is on its way',
    '1 download has needed attention for over 6 h'
  ]);
  // UX-15: the digest reads as its count; the downloads it lists (a digest stored before its fields: its one-line list) are a tap away.
  assert.deepEqual([...rows[2].querySelectorAll('.je-notify-digest-list li')].map(li => li.textContent), ['Dune']);
  // The "OK'd" switch: absent while the server sends null, present (and saved) when it sends a value.
  h.document.body.insertAdjacentHTML('beforeend', `<div id="jellyfin-enhanced-panel">${h.N.buildSettingsHtml()}</div>`);
  const help = h.document.getElementById('jellyfin-enhanced-panel');
  h.N.wireSettings({ help });
  const host = help.querySelector('.je-arr-alerts');
  await until(() => host.querySelector('.je-arr-alerts-group'));
  const label = translate('arr_notify_pref_approved');
  assert.ok(![...host.querySelectorAll('.je-arr-alerts-check')].some(b => b.textContent.startsWith(label)));
  h.state.prefs = prefsBody({ approved: true });
  await h.JE.arrNotify.loadPrefs();
  h.N.wireSettings({ help });
  await until(() => [...host.querySelectorAll('.je-arr-alerts-check')].some(b => b.textContent.startsWith(label)));
  const box = [...host.querySelectorAll('.je-arr-alerts-check')].find(b => b.textContent.startsWith(label)).querySelector('input');
  box.checked = false;
  box.dispatchEvent(new h.window.Event('change'));
  await until(() => h.calls.some(c => c.method === 'PUT' && c.body.approved === false));
});

test('an ask or a reminder whose title is withheld from the administrator reads "a title", not "Something you follow"', async t => {
  const h = setup(t);
  h.state.inbox = {
    unread: 3, more: false, items: [
      item(9, 'approval', { type: 'movie', user: 'Robin' }),
      item(8, 'remind', { type: 'movie', user: 'Robin' }),
      item(7, 'ready', { type: 'movie' })
    ]
  };
  h.JE.initializeArrNotify();
  await until(() => h.document.getElementById('je-notify-bell'));
  await h.JE.arrNotify.refresh();
  h.click(h.document.getElementById('je-notify-bell'));
  const rows = [...h.document.querySelectorAll('.je-notify-panel .je-notify-item')].map(r => r.querySelector('.je-notify-text').textContent);
  assert.match(rows[0], /^Robin asked for a title\./);
  assert.match(rows[1], /^Robin .*a title/);
  assert.match(rows[2], /^Something you follow/);
});

test('the bell shows the unread count and an inbox with titles as text, Play for what is ready, and Mark all read', async t => {
  const h = setup(t);
  h.state.inbox = {
    unread: 2, more: true, items: [
      item(5, 'ready', { title: '<img src=x onerror=alert(1)>', image: 'a'.repeat(32) }, { itemId: 'b'.repeat(32) }),
      item(4, 'episodes', { title: 'Severance', mode: 'single', season: '2', episode: '5' }, { itemId: 'c'.repeat(32) }),
      item(3, 'declined', { title: 'Peacemaker', contact: 'Dad', reason: "Let's watch it together" }, { read: true }),
      item(2, 'episodes', { title: 'Andor', mode: 'season', season: '1', count: '12' })
    ]
  };
  h.JE.initializeArrNotify();
  await until(() => h.document.getElementById('je-notify-bell'));
  await h.JE.arrNotify.loadPrefs();
  await h.JE.arrNotify.refresh();
  const bell = h.document.getElementById('je-notify-bell');
  assert.equal(bell.querySelector('.je-notify-badge').textContent, '2');
  assert.equal(bell.getAttribute('aria-label'), 'Notifications (2 new)');
  h.click(bell);
  const panel = h.document.querySelector('.je-notify-panel');
  assert.ok(panel);
  assert.equal(h.document.activeElement, panel);
  const rows = [...panel.querySelectorAll('.je-notify-item')];
  assert.deepEqual(rows.map(r => r.querySelector('.je-notify-text').textContent), [
    '<img src=x onerror=alert(1)> is ready',
    'Severance: episode 5 is ready',
    "Dad said no to Peacemaker: Let's watch it together",
    'Andor: Season 1 is ready'
  ]);
  assert.equal(panel.querySelector('img[src="x"]'), null);
  assert.equal(rows[0].querySelector('strong').textContent, '<img src=x onerror=alert(1)>');
  assert.ok(rows[0].querySelector('.je-notify-poster').src.includes(`/Items/${'a'.repeat(32)}/Images/Primary`));
  // A just-added item without its image yet falls back to the placeholder icon.
  rows[0].querySelector('img.je-notify-poster').dispatchEvent(new h.window.Event('error'));
  assert.ok(rows[0].querySelector('.je-notify-poster-empty'));
  assert.deepEqual(rows.map(r => !!r.querySelector('.je-notify-play')), [true, true, false, false]);
  assert.deepEqual(rows.map(r => r.classList.contains('je-notify-unread')), [true, true, false, true]);
  assert.equal(panel.querySelector('.je-notify-new').textContent, '2 new');
  assert.match(panel.querySelector('.je-notify-foot-text').textContent, /Phone alerts: on \(ntfy\) · Quiet hours 22:00–07:00/);
  assert.ok(panel.querySelector('.je-notify-more'));
  h.click(panel.querySelector('.je-notify-markall'));
  await until(() => h.calls.some(c => c.path === '/acquire/notify/read'));
  assert.deepEqual(plain(h.calls.find(c => c.path === '/acquire/notify/read').body), { all: true });
  await until(() => bell.querySelector('.je-notify-badge').hidden);
  // Opening an item marks it read and goes to its page; Escape closes and focus returns to the bell.
  h.click(h.document.querySelector('.je-notify-panel .je-notify-body'));
  assert.match(h.window.location.hash, /#\/details\?id=b{32}/);
  h.click(bell);
  h.document.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(h.document.querySelector('.je-notify-panel'), null);
  assert.equal(h.document.activeElement, bell);
});

test('a new notification arriving through the feed shows a toast, but never during playback', async t => {
  const h = setup(t);
  h.JE.initializeArrNotify();
  await until(() => h.subscriptions.length === 1);
  assert.deepEqual(plain(h.subscriptions[0].keys), [`ntf:u:${USER}`, `req:u:${USER}`]);
  h.state.inbox = { unread: 1, more: false, items: [item(7, 'ready', { title: 'Dune: Part Two' }, { itemId: 'd'.repeat(32) })] };
  h.subscriptions[0].cb([`ntf:u:${USER}`]);
  await until(() => h.document.querySelector('.je-notify-toast'));
  const toast = h.document.querySelector('.je-notify-toast');
  assert.equal(toast.querySelector('.je-notify-toast-text').textContent, 'Dune: Part Two is ready');
  assert.ok(toast.querySelector('.je-notify-toast-play'));
  h.click(toast.querySelector('.je-notify-toast-close'));
  assert.equal(h.document.querySelector('.je-notify-toast'), null);

  // During playback: no toast; after leaving the player, one summary toast.
  h.window.location.hash = '#/video';
  h.state.inbox = { unread: 3, more: false, items: [item(9, 'ready', { title: 'B' }), item(8, 'ready', { title: 'A' }), ...h.state.inbox.items] };
  h.subscriptions[0].cb([`ntf:u:${USER}`]);
  await until(() => h.JE.arrNotify.unread === 3);
  assert.equal(h.document.querySelector('.je-notify-toast'), null);
  h.window.location.hash = '#/home';
  h.N.flushHeld();
  assert.equal(h.document.querySelector('.je-notify-toast-text').textContent, '2 more notifications arrived');
});

test('toasts switched off in the settings stay off', async t => {
  const h = setup(t);
  h.state.prefs = prefsBody({ toasts: false });
  h.JE.initializeArrNotify();
  await until(() => h.subscriptions.length === 1);
  h.state.inbox = { unread: 1, more: false, items: [item(7, 'ready', { title: 'X' })] };
  h.subscriptions[0].cb([]);
  await until(() => h.JE.arrNotify.unread === 1);
  assert.equal(h.document.querySelector('.je-notify-toast'), null);
});

test('Notify me on details pages, in the more-info window and on Requests rows share one follow state', async t => {
  const h = setup(t);
  h.state.follows = { follows: [], muted: [], requested: ['movie:tmdb:1'] };
  const page = h.document.getElementById('itemDetailPage');
  h.N.attachDetails(page, { key: 'tv:tvdb:7', kind: 'series', itemId: 'e'.repeat(32) }, { contact: 'Dad' });
  const icon = page.querySelector('.je-notify-follow-details');
  assert.ok(icon);
  await until(() => icon.getAttribute('aria-label') === 'Notify me about new episodes');
  assert.equal(icon.getAttribute('aria-pressed'), 'false');
  h.click(icon);
  await until(() => icon.getAttribute('aria-pressed') === 'true');
  assert.deepEqual(plain(h.calls.find(c => c.method === 'PUT').body), { key: 'tv:tvdb:7', on: true });
  assert.equal(icon.getAttribute('aria-label'), 'Following new episodes');

  // A Requests row of the same series updates with it; an own request reads "Following".
  const buttons = h.document.createElement('div');
  h.N.rowButton({ key: 'tv:tvdb:7' }, buttons);
  const mine = h.document.createElement('div');
  h.N.rowButton({ key: 'movie:tmdb:1' }, mine);
  h.document.body.append(buttons, mine);
  await until(() => mine.querySelector('.je-notify-follow-text').textContent === 'Following');
  assert.equal(buttons.querySelector('.je-notify-follow-text').textContent, 'Following new episodes');
  assert.equal(mine.querySelector('.je-notify-chip').title, 'Following (you asked for it). Tap to stop.');

  // Episode pages get no follow button; the more-info window gets a text button for the key.
  h.N.attachDetails(page, { key: 'tv:tvdb:7:s1:e2', kind: 'episode' }, {});
  assert.equal(page.querySelector('.je-notify-follow-details'), null);
  const mount = h.document.createElement('div');
  h.N.attachModal(mount, null, 'movie:tmdb:99', {});
  assert.equal(mount.querySelector('.je-notify-follow-text').textContent, 'Notify me');
  h.N.attachModal(mount, null, 'tv:tmdb:abc;', {});
  assert.equal(mount.querySelector('.je-notify-chip'), null);
});

test('Remind shows for family members on stuck titles only, and says when it was already sent', async t => {
  let replies = [{ reminded: true }, Object.assign(new Error('HTTP 429'), { status: 429, responseJSON: { code: 'too_soon' } })];
  const h = setup(t, { routes: { '/acquire/remind': () => { const r = replies.shift(); if (r instanceof Error) throw r; return r; } } });
  const page = h.document.getElementById('itemDetailPage');
  const section = page.querySelector('.detailSection');
  const block = h.document.createElement('div');
  block.className = 'je-arr-status';
  block.dataset.jeArrSurface = 'details';
  section.appendChild(block);
  h.N.attachDetails(page, { key: 'movie:tmdb:5', kind: 'movie', attention: true, itemId: 'f'.repeat(32) }, { contact: 'Dad' });
  const remind = block.querySelector('.je-notify-remind');
  assert.equal(remind.textContent, 'campaignRemind Dad');
  h.click(remind);
  await until(() => remind.textContent.includes('Reminded'));
  assert.deepEqual(plain(h.calls.find(c => c.path === '/acquire/remind').body), { key: 'movie:tmdb:5', itemId: 'f'.repeat(32) });
  h.N.attachDetails(page, { key: 'movie:tmdb:5', kind: 'movie', attention: true, itemId: 'f'.repeat(32) }, { contact: 'Dad' });
  h.click(block.querySelector('.je-notify-remind'));
  await until(() => block.querySelector('.je-notify-remind').textContent.includes('Already reminded today'));
  // Administrators have the arr's own words and the Manage drawer instead.
  h.N.attachDetails(page, { key: 'movie:tmdb:5', kind: 'movie', attention: true, admin: { variants: [] } }, { contact: 'Dad' });
  assert.equal(block.querySelector('.je-notify-remind'), null);
});

test('the Requests & alerts settings save each change with the time zone, make up topics and confirm e-mail', async t => {
  let pending = null;
  const h = setup(t, {
    routes: {
      '/acquire/notify/ntfy/topic': (p, o, s) => { s.prefs = prefsBody({ ...s.prefs.prefs, ntfyTopic: 'je-newrandomtopic', ntfy: true }); return s.prefs; },
      '/acquire/notify/email/verify': (p, o, s) => {
        if (o.body.code !== '123456') throw Object.assign(new Error('HTTP 400'), { status: 400, responseJSON: { code: 'wrong_code' } });
        s.prefs = prefsBody({ ...s.prefs.prefs, email: true, emailAddress: pending, emailPending: null });
        return s.prefs;
      },
      '/acquire/notify/email': (p, o, s) => { pending = o.body.address; s.prefs = prefsBody({ ...s.prefs.prefs, emailPending: pending }); return { sent: true }; }
    }
  });
  assert.match(h.N.buildSettingsHtml(), /data-pane="requests-alerts"/);
  h.document.body.insertAdjacentHTML('beforeend', `<div id="jellyfin-enhanced-panel">${h.N.buildSettingsHtml()}</div>`);
  const help = h.document.getElementById('jellyfin-enhanced-panel');
  h.N.wireSettings({ help });
  const host = help.querySelector('.je-arr-alerts');
  await until(() => host.querySelector('.je-arr-alerts-group'));
  const boxes = () => [...host.querySelectorAll('.je-arr-alerts-check')];
  const episodes = boxes().find(b => b.textContent.startsWith('New episodes')).querySelector('input');
  episodes.checked = false;
  episodes.dispatchEvent(new h.window.Event('change'));
  await until(() => h.calls.some(c => c.method === 'PUT' && c.body.episodes === false));
  const put = h.calls.find(c => c.method === 'PUT' && c.body.episodes === false).body;
  assert.equal(typeof put.utcOffsetMinutes, 'number');
  assert.ok('timeZone' in put);
  // The topic and the server to subscribe on; a new random topic.
  assert.match(host.textContent, /subscribe on server https:\/\/ntfy\.example to the topic je-abcdefghijkl/);
  const link = host.querySelector('.je-arr-alerts-link');
  assert.equal(link.href, 'https://ntfy.example/je-abcdefghijkl');
  h.click([...host.querySelectorAll('.je-arr-alerts-btn')].find(b => b.textContent === 'Make up a new topic'));
  await until(() => host.textContent.includes('je-newrandomtopic'));
  // E-mail: ask for a code, a wrong one, then the right one.
  const address = host.querySelector('input[type="email"]');
  address.value = 'emma@home.test';
  h.click([...host.querySelectorAll('.je-arr-alerts-btn')].find(b => b.textContent === 'Send me a code'));
  await until(() => host.querySelector('.je-arr-alerts-code'));
  host.querySelector('.je-arr-alerts-code').value = '000000';
  h.click([...host.querySelectorAll('.je-arr-alerts-btn')].find(b => b.textContent === 'Confirm'));
  await until(() => host.querySelector('.je-arr-alerts-note')?.textContent === "That code isn't right.");
  host.querySelector('.je-arr-alerts-code').value = '123456';
  h.click([...host.querySelectorAll('.je-arr-alerts-btn')].find(b => b.textContent === 'Confirm'));
  await until(() => host.textContent.includes('To emma@home.test'));
});

test('nothing is drawn or fetched while notifications are off', async t => {
  const h = setup(t, { config: { ArrNotificationsEnabled: false } });
  h.JE.initializeArrNotify();
  h.N.attachDetails(h.document.getElementById('itemDetailPage'), { key: 'movie:tmdb:1', kind: 'movie' }, {});
  await wait(700);
  assert.equal(h.N.buildSettingsHtml(), '');
  assert.equal(h.document.getElementById('je-notify-bell'), null);
  assert.equal(h.document.querySelector('.je-notify-follow'), null);
  assert.equal(h.calls.length, 0);
});

// Stage 1 fix round 3: this test and the two below run the page's timers on a manual clock. On real timers they timed out
// under host load (~40): the link's 800 ms delay (and the harness's own set-up) against a 2 s wall-clock budget here, the
// bell's 500 ms and the start-up read's 600 ms timers against 10 s below. Their budgets are now page time, so the outcome
// depends only on what the page does and when its timers are due.
test('the e-mail unsubscribe link opens the settings at Requests & alerts', async t => {
  const clock = fakeClock();
  const h = setup(t, { hash: '#/home?je=alerts', clock });
  let opened = 0;
  let picked = null;
  // The real panel reloads the user's settings as it opens and restores the last section (here another one).
  h.JE.showEnhancedPanel = async () => {
    opened++;
    h.JE.currentSettings = { lastOpenedTab: 'shortcuts' };
    h.document.body.insertAdjacentHTML('beforeend', '<div id="jellyfin-enhanced-panel"><button class="tab-button active" data-tab="shortcuts"></button><button class="tab-button" data-tab="requests-alerts"></button></div>');
    h.document.querySelector('.tab-button[data-tab="requests-alerts"]').addEventListener('click', () => { picked = 'requests-alerts'; });
  };
  h.JE.currentSettings = {};
  h.JE.initializeArrNotify();
  await clock.until(() => picked === 'requests-alerts', 2000);
  assert.equal(opened, 1);
  // It opens once: later page time (the start-up read, the bell) doesn't open it again.
  await clock.advance(10000);
  assert.equal(opened, 1);
});

// ------------------------------------------------------------------ review round 1

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

test('answers for a user who signed out meanwhile are dropped (prefs, follows, older inbox pages)', async t => {
  const prefs = deferred();
  const follows = deferred();
  const older = deferred();
  const h = setup(t, {
    routes: {
      '/acquire/notify/prefs': () => prefs.promise,
      '/acquire/follows': () => follows.promise,
      '/acquire/notify/inbox?limit=20&before=': () => older.promise
    }
  });
  h.state.inbox = { unread: 1, more: true, items: [item(9, 'ready', { title: 'A' })] };
  await h.JE.arrNotify.refresh();
  const loadingPrefs = h.JE.arrNotify.loadPrefs(true);
  const loadingFollows = h.JE.arrNotify.loadFollows(true);
  const loadingMore = h.JE.arrNotify.loadMore();
  // User A signs out, user B signs in; then A's answers arrive.
  h.switchUser();
  prefs.resolve(prefsBody({ ntfyTopic: 'je-usera-private-topic', emailAddress: 'a@home.test' }));
  follows.resolve({ follows: [{ key: 'movie:tmdb:1' }], muted: [], requested: [] });
  older.resolve({ unread: 0, more: false, items: [item(3, 'ready', { title: 'Older A' })] });
  assert.equal(await loadingPrefs, null);
  await loadingFollows;
  await loadingMore;
  assert.equal(h.JE.arrNotify.prefs, null);
  assert.equal(h.N.state.follows, null);
  assert.deepEqual(plain(h.JE.arrNotify.items), []);
  assert.equal(h.JE.arrNotify.isFollowing('movie:tmdb:1'), false);
  // A settings call on its way when the user changed is not applied either.
  const put = deferred();
  const h2 = setup(t, { routes: { '/acquire/notify/ntfy/topic': () => put.promise } });
  const call = h2.N.prefsCall('/acquire/notify/ntfy/topic', 'POST', { generate: true });
  h2.switchUser();
  put.resolve(prefsBody({ ntfyTopic: 'je-usera-private-topic' }));
  assert.equal((await call).ok, false);
  assert.equal(h2.JE.arrNotify.prefs, null);
});

test('a toast on screen goes away when playback starts', async t => {
  const clock = fakeClock();
  const h = setup(t, { clock });
  h.JE.initializeArrNotify();
  await clock.until(() => h.subscriptions.length === 1);
  h.state.inbox = { unread: 1, more: false, items: [item(7, 'ready', { title: 'Dune: Part Two' }, { itemId: 'd'.repeat(32) })] };
  h.subscriptions[0].cb([`ntf:u:${USER}`]);
  await clock.until(() => h.document.querySelector('.je-notify-toast'));
  // The user opens the item and presses Play within the toast's 8 seconds: it goes with the navigation, long before its
  // own 8 seconds are up.
  h.window.location.hash = '#/video';
  const hooks = h.navigation.length;
  h.navigation.forEach(fn => fn());
  await clock.until(() => h.document.querySelector('.je-notify-toast') === null, 1500);
  // Starting again (another user) doesn't add a second navigation hook.
  h.switchUser();
  h.JE.arrNotify.start();
  assert.equal(h.navigation.length, hooks);
});

test('the follow state follows the user\'s own requests and the "follow what I request" setting', async t => {
  const h = setup(t);
  h.JE.initializeArrNotify();
  await until(() => h.subscriptions.length === 1);
  await h.JE.arrNotify.loadFollows(false);
  assert.equal(h.JE.arrNotify.isFollowing('movie:tmdb:5'), false);
  const inboxReads = () => h.calls.filter(c => c.path.startsWith('/acquire/notify/inbox')).length;
  const readsBefore = inboxReads();
  // The user asks for the title in Seerr's window: their request-list key moves.
  h.state.follows = { follows: [], muted: [], requested: ['movie:tmdb:5'] };
  h.subscriptions[0].cb([`req:u:${USER}`]);
  await until(() => h.JE.arrNotify.isFollowing('movie:tmdb:5'));
  assert.equal(inboxReads(), readsBefore, 'a request change alone does not re-read the inbox');
  // "Follow what I request" switched off: requested titles are no longer followed.
  h.state.follows = { follows: [], muted: [], requested: [] };
  await h.N.prefsCall('/acquire/notify/prefs', 'PUT', { autoFollowRequests: false });
  await until(() => !h.JE.arrNotify.isFollowing('movie:tmdb:5'));
});

test('keyboard and TV focus stays on the control after each settings change and in the inbox', async t => {
  // "Show older" reads its own page, so an inbox refresh that lands meanwhile still returns the first one.
  const clock = fakeClock();
  const h = setup(t, { clock, routes: { '/acquire/notify/inbox?limit=20&before=': (path, options, state) => JSON.parse(JSON.stringify(state.olderInbox)) } });
  h.document.body.insertAdjacentHTML('beforeend', `<div id="jellyfin-enhanced-panel">${h.N.buildSettingsHtml()}</div>`);
  const help = h.document.getElementById('jellyfin-enhanced-panel');
  h.N.wireSettings({ help });
  const host = help.querySelector('.je-arr-alerts');
  await clock.until(() => host.querySelector('.je-arr-alerts-group'));
  const box = () => [...host.querySelectorAll('.je-arr-alerts-check')].find(b => b.textContent.startsWith('Pop-ups')).querySelector('input');
  const before = box();
  before.focus();
  before.checked = false;
  before.dispatchEvent(new h.window.Event('change'));
  await clock.until(() => box() !== before);
  assert.equal(h.document.activeElement, box());
  assert.equal(box().checked, false);
  // A button that changes its label keeps focus too.
  const make = [...host.querySelectorAll('.je-arr-alerts-btn')].find(b => b.textContent === 'Make up a new topic');
  make.focus();
  h.click(make);
  await clock.until(() => !make.isConnected);
  assert.equal(h.document.activeElement.dataset.jeFocus, 'phone-generate');

  // The inbox: Mark all read (then disabled) and Show older keep focus inside the panel.
  h.state.inbox = { unread: 2, more: true, items: [item(5, 'ready', { title: 'A' }), item(4, 'ready', { title: 'B' })] };
  h.JE.initializeArrNotify();
  await clock.until(() => h.document.getElementById('je-notify-bell'));
  // Wait for the delayed startup read before replacing the mock's newest page with an older page.
  await clock.until(() => h.subscriptions.some(subscription => subscription.active));
  await h.JE.arrNotify.refresh();
  h.click(h.document.getElementById('je-notify-bell'));
  const panel = h.document.querySelector('.je-notify-panel');
  panel.querySelector('.je-notify-markall').focus();
  h.click(panel.querySelector('.je-notify-markall'));
  await clock.until(() => panel.querySelector('.je-notify-markall').disabled);
  assert.ok(panel.contains(h.document.activeElement) && h.document.activeElement !== h.document.body);
  assert.equal(h.document.activeElement, panel.querySelector('.je-notify-body'));
  h.state.olderInbox = { unread: 0, more: false, items: [item(2, 'ready', { title: 'Older' })] };
  panel.querySelector('.je-notify-more').focus();
  h.click(panel.querySelector('.je-notify-more'));
  await clock.until(() => panel.querySelectorAll('.je-notify-item').length === 3);
  assert.equal(h.document.activeElement.closest('.je-notify-item')?.dataset.id, '2');
  // Focus outside the panel: Tab brings it back in.
  h.document.activeElement.blur();
  assert.equal(h.document.activeElement, h.document.body);
  h.document.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
  assert.ok(panel.contains(h.document.activeElement));
});

// ------------------------------------------------------------------ review round 2

test('"Hide titles" is offered for e-mail too, with phone alerts not set up or switched off', async t => {
  const label = en.arr_notify_pref_hide_titles;
  const render = async (channels, prefs = {}) => {
    const h = setup(t);
    h.state.prefs = { ...prefsBody({ hideTitles: true, ...prefs }), channels };
    h.document.body.insertAdjacentHTML('beforeend', `<div id="jellyfin-enhanced-panel">${h.N.buildSettingsHtml()}</div>`);
    const help = h.document.getElementById('jellyfin-enhanced-panel');
    h.N.wireSettings({ help });
    const host = help.querySelector('.je-arr-alerts');
    await until(() => host.querySelector('.je-arr-alerts-group'));
    return { h, host, box: [...host.querySelectorAll('.je-arr-alerts-check')].find(b => b.textContent.startsWith(label)) };
  };
  // E-mail only (no ntfy): the e-mail controls and the privacy switch, which still saves.
  const mailOnly = await render({ ntfy: { available: false }, email: { available: true } }, { ntfyTopic: null });
  assert.ok(mailOnly.host.querySelector('input[type="email"]'));
  assert.ok(mailOnly.box, 'hide titles is shown for e-mail');
  const input = mailOnly.box.querySelector('input');
  assert.equal(input.checked, true);
  input.checked = false;
  input.dispatchEvent(new mailOnly.h.window.Event('change'));
  await until(() => mailOnly.h.calls.some(c => c.method === 'PUT' && c.body.hideTitles === false));
  // Both channels: shown once. Neither: nothing goes out, so nothing to hide.
  const both = await render({ ntfy: { available: true, server: 'https://ntfy.example' }, email: { available: true } });
  assert.equal([...both.host.querySelectorAll('.je-arr-alerts-check')].filter(b => b.textContent.startsWith(label)).length, 1);
  const neither = await render({ ntfy: { available: false }, email: { available: false } });
  assert.equal(neither.box, undefined);
});

test('a notice about a title that is not in the library opens its native page; alerts keep their tab; no page, the Requests page', async t => {
  const h = setup(t);
  h.state.inbox = {
    unread: 3, more: false, items: [
      item(9, 'declined', { title: 'Dune' }, { key: 'movie:tmdb:693134' }),
      item(8, 'episodes', { title: 'Andor' }, { key: 'tv:tvdb:393189:s1:e3' }),
      item(7, 'attention', { code: 'import_blocked', title: 'Severance', scope: 'S02E05', instance: 'Sonarr' }, { key: 'tv:tvdb:1', link: '#/requests?tab=overview' })
    ]
  };
  const keyed = [];
  let answer = true;
  h.JE.titleDetails = { available: () => true, openKey: async (key, o) => { keyed.push([key, o.season ?? null, o.episode ?? null, o.modal]); return answer; } };
  h.JE.initializeArrNotify();
  await until(() => h.document.getElementById('je-notify-bell'));
  await h.JE.arrNotify.loadPrefs();
  await h.JE.arrNotify.refresh();
  const row = n => { h.click(h.document.getElementById('je-notify-bell')); return [...h.document.querySelectorAll('.je-notify-panel .je-notify-item')][n].querySelector('.je-notify-body'); };
  h.click(row(0));
  h.click(row(1));
  await wait(5);
  assert.deepEqual(keyed, [['movie:tmdb:693134', null, null, false], ['tv:tvdb:393189', 1, 3, false]]);
  h.click(row(2));
  assert.equal(h.window.location.hash, '#/requests?tab=overview');
  assert.equal(keyed.length, 2);
  // Nowhere to open it (the navigator answered no): the Requests page as before.
  answer = false;
  h.click(row(0));
  await wait(5);
  assert.equal(h.window.location.hash, '#/requests');
});

test('administrators\' Needs attention alerts read like the Overview row and open the tab the server linked', async t => {
  const h = setup(t);
  h.state.inbox = {
    unread: 3, more: false, items: [
      item(9, 'attention', { code: 'import_blocked', title: 'Severance', scope: 'S02E05', instance: 'Sonarr' }, { link: '#/requests?tab=overview' }),
      item(8, 'attention', { code: 'approved_not_in_arr', title: 'Dune', variant: '4k', user: 'Emma' }, { link: '#/requests?tab=overview' }),
      item(7, 'low_disk', { instance: 'Radarr', path: '/data/movies', percent: '4', free: '40 GB' }, { link: 'javascript:alert(1)' })
    ]
  };
  h.JE.initializeArrNotify();
  await until(() => h.document.getElementById('je-notify-bell'));
  await h.JE.arrNotify.loadPrefs();
  await h.JE.arrNotify.refresh();
  h.click(h.document.getElementById('je-notify-bell'));
  const rows = [...h.document.querySelectorAll('.je-notify-panel .je-notify-item')];
  assert.deepEqual(rows.map(r => r.querySelector('.je-notify-text').textContent), [
    'Severance S02E05 needs a manual import in Sonarr',
    "Dune (4K) was OK'd in Seerr, but none of the 4K Sonarr/Radarr Jellyfin Enhanced watches has it",
    'Low disk space on Radarr: /data/movies has 4% free (40 GB)'
  ]);
  h.click(rows[0].querySelector('.je-notify-body'));
  assert.equal(h.window.location.hash, '#/requests?tab=overview');
  // A link that isn't one of the Requests page's own tabs is never followed.
  h.click(h.document.getElementById('je-notify-bell'));
  h.click([...h.document.querySelectorAll('.je-notify-panel .je-notify-item')][2].querySelector('.je-notify-body'));
  assert.equal(h.window.location.hash, '#/requests');
});

test('F83: a request held because its episode can\'t be matched to Sonarr\'s reads as such in an administrator\'s bell', async t => {
  const h = setup(t);
  h.state.inbox = { unread: 1, more: false, items: [item(9, 'attention', { code: 'episode_identity_unresolved', title: 'Firefly', scope: 'S0E7', user: 'Emma' }, { link: '#/requests?tab=overview' })] };
  h.JE.initializeArrNotify();
  await until(() => h.document.getElementById('je-notify-bell'));
  await h.JE.arrNotify.loadPrefs();
  await h.JE.arrNotify.refresh();
  h.click(h.document.getElementById('je-notify-bell'));
  const row = h.document.querySelector('.je-notify-panel .je-notify-item');
  assert.equal(row.querySelector('.je-notify-text').textContent, "Firefly S0E7 is held: it couldn't be matched to Sonarr's episodes, so it wasn't searched for");
});

test('a notification created while the inbox is being read still becomes a toast', async t => {
  let release = null;
  const h = setup(t, {
    routes: {
      '/acquire/notify/inbox': async (path, options, state) => {
        const answer = JSON.parse(JSON.stringify(state.inbox));
        if (state.slow) await new Promise(resolve => { release = resolve; });
        return answer;
      }
    }
  });
  h.JE.initializeArrNotify();
  await until(() => h.subscriptions.length === 1);
  await h.JE.arrNotify.refresh();
  // One notification arrives; the read it causes is still under way when a second one arrives.
  h.state.slow = true;
  h.state.inbox = { unread: 1, more: false, items: [item(7, 'ready', { title: 'Casablanca' })] };
  h.subscriptions[0].cb(['ntf:u:' + USER]);
  await until(() => release);
  h.state.inbox = { unread: 2, more: false, items: [item(8, 'ready', { title: 'Citizen Kane' }), item(7, 'ready', { title: 'Casablanca' })] };
  h.subscriptions[0].cb(['ntf:u:' + USER]);
  h.state.slow = false;
  release();
  await until(() => h.document.querySelectorAll('.je-notify-toast').length === 2);
  assert.deepEqual([...h.document.querySelectorAll('.je-notify-toast-text')].map(x => x.textContent).sort(), ['Casablanca is ready', 'Citizen Kane is ready']);
  assert.equal(h.JE.arrNotify.unread, 2);
});


// UX-15: a stuck-download digest filled most of a phone's inbox with a semicolon list of titles and reason codes.
test('a 20-download digest is a short count with Open Overview, and its list (in Overview\'s words) only on demand', async t => {
  const h = setup(t);
  const entries = Array.from({ length: 20 }, (_, i) => ({ title: `Angelina Ballerina`, scope: `S01E${String(i + 1).padStart(2, '0')}`, instance: 'Sonarr', code: i ? 'import_blocked' : 'download_stalled' }));
  h.state.inbox = {
    unread: 2, more: false, items: [
      item(9, 'stuck_digest', { count: '24', hours: '6', items: entries.map(e => `${e.title} ${e.scope} (${e.instance}, ${e.code})`).join('; '), entries: JSON.stringify(entries) }, { link: '#/requests?tab=overview' }),
      item(8, 'ready', { title: 'Dune' }, { itemId: 'b'.repeat(32) })
    ]
  };
  h.JE.initializeArrNotify();
  await until(() => h.document.getElementById('je-notify-bell'));
  await h.JE.arrNotify.refresh();
  h.click(h.document.getElementById('je-notify-bell'));
  const rows = [...h.document.querySelectorAll('.je-notify-panel .je-notify-item')];
  assert.equal(rows.length, 2);
  const digest = rows[0];
  assert.equal(digest.querySelector('.je-notify-text').textContent, '24 downloads have needed attention for over 6 h');
  // Collapsed: nothing of the list shows, so the Ready row right after it stays in view.
  const list = digest.querySelector('.je-notify-digest-list');
  const toggle = digest.querySelector('.je-notify-digest-toggle');
  assert.equal(list.hidden, true);
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(toggle.getAttribute('aria-controls'), list.id);
  assert.equal(toggle.textContent, 'Show which (20)');
  assert.doesNotMatch(digest.textContent.replace(list.textContent, ''), /import_blocked|Angelina/);
  assert.equal(rows[1].querySelector('.je-notify-text').textContent, 'Dune is ready');
  // Expanded in place: every listed download, its reason as Overview names it, and how many more the Overview has.
  h.click(toggle);
  assert.equal(list.hidden, false);
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  const lines = [...list.querySelectorAll('li')].map(li => li.textContent);
  assert.equal(lines.length, 21);
  assert.equal(lines[0], 'Angelina Ballerina S01E01 · Sonarr · Download stalled');
  assert.equal(lines[19], 'Angelina Ballerina S01E20 · Sonarr · Import blocked');
  assert.equal(lines[20], 'and 4 more on the Overview');
  assert.equal(list.querySelector('strong').textContent, 'Angelina Ballerina S01E01');
  assert.ok(h.document.querySelector('.je-notify-panel'), 'expanding keeps the inbox open');
  // A redraw while it is open keeps it open; Hide closes it again.
  h.JE.internals.arrNotify.state.items = [...h.JE.arrNotify.items];
  await h.JE.arrNotify.refresh();
  const again = h.document.querySelector('.je-notify-panel .je-notify-item .je-notify-digest-list');
  assert.equal(again.hidden, false);
  h.click(h.document.querySelector('.je-notify-digest-toggle'));
  assert.equal(h.document.querySelector('.je-notify-digest-list').hidden, true);
  // Open Overview: the administrators' tab the digest is about, and the digest is read.
  h.click(h.document.querySelector('.je-notify-digest-open'));
  assert.equal(h.window.location.hash, '#/requests?tab=overview');
  assert.equal(h.document.querySelector('.je-notify-panel'), null);
  await until(() => h.calls.some(c => c.path === '/acquire/notify/read' && JSON.stringify(c.body).includes('9')));
});

test('a digest whose fields can\'t be read lists nothing made up, and its count still opens the Overview', async t => {
  const h = setup(t);
  h.state.inbox = { unread: 1, more: false, items: [item(4, 'stuck_digest', { count: '2', hours: '6', entries: '{not json' }, { link: '#/requests?tab=overview' })] };
  h.JE.initializeArrNotify();
  await until(() => h.document.getElementById('je-notify-bell'));
  await h.JE.arrNotify.refresh();
  h.click(h.document.getElementById('je-notify-bell'));
  const row = h.document.querySelector('.je-notify-panel .je-notify-item');
  assert.equal(row.querySelector('.je-notify-text').textContent, '2 downloads have needed attention for over 6 h');
  assert.equal(row.querySelector('.je-notify-digest-toggle'), null);
  assert.ok(row.querySelector('.je-notify-digest-open'));
  assert.deepEqual(plain(h.N.digestEntries({ params: { entries: JSON.stringify([{ title: 'X', code: '<b>' }, null, { code: 'import_blocked' }]) } })), [{ title: 'X', scope: '', instance: '', reason: '' }]);
});
