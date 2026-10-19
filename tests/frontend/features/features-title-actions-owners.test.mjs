import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, deferred } from '../helpers/harness.mjs';

// D46 slice 2 review round 3: the submitted operation reaches every owner the action bar invokes. Each owner
// entry point (the Report modal → reportIssue → reportContext → POST; the Request sheet → me/quota → sheet →
// submit; the one-tap ask; the Manage drawer → feedPosition → overview; Seerr's More Info window and request
// writes) takes the operation it was invoked for, checks it after every await and right before every write or
// open, and behaves exactly as before when invoked natively without one. Every owner here is the REAL module;
// only the server is scripted.

const settle = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); };
const MEMBER = { role: 'member', canRequest: true, canRequestMovies: true, canRequestSeries: true, canApprove: false, asksFirst: false,
  can4kMovies: false, can4kSeries: false, backend: 'je', contact: 'Dad', freeEpisodes: 5 };
const QUOTA = { used: 0, limit: 10, remaining: 10, nextSlotAt: null, usedGb: 0, available: true };
const OVERVIEW = { key: 'movie:tmdb:603', kind: 'movie', title: 'The Matrix', tmdbId: 603, instances: [], requests: [] };

/**
 * An absent title's details page with the action bar and the real owners. `requests` records every server call
 * as [user, method, path]; `hold(method, prefix)` holds the next matching call until released.
 */
function setup(t, { asks = true, seerrMoreInfo = false } = {}) {
  let user = 'user-a'; let epoch = 1; const switches = [];
  const requests = []; const gates = []; const toasts = [];
  let prime = null;
  async function answer(method, path, body) {
    requests.push([user, method, path, body]);
    const index = gates.findIndex(g => g.method === method && path.startsWith(g.prefix));
    if (index >= 0) { const [gate] = gates.splice(index, 1); await gate.d.promise; }
    if (path.startsWith('/title-actions/')) return { allowed: true, itemId: null };
    if (path.startsWith('/acquire/status')) return { items: [{ key: 'movie:tmdb:603', stage: 'notHere', admin: { instances: [] } }] };
    if (path.startsWith('/jellyseerr/user-status')) return { active: true, userFound: true, canReportIssues: true };
    if (path.startsWith('/jellyseerr/movie/603')) return { id: 603, title: 'The Matrix', mediaInfo: { id: 77 } };
    if (path.startsWith('/jellyseerr/issue') && method === 'GET') return { results: [] };
    if (path === '/jellyseerr/issue' && method === 'POST') return { id: 1 };
    if (path === '/jellyseerr/request' && method === 'POST') return { id: 2 };
    if (path.startsWith('/jellyseerr/overrideRule')) return [];
    if (path.startsWith('/arr/admin/manage?')) return OVERVIEW;
    if (path === '/acquire/requests/me') return { me: MEMBER };
    if (path.startsWith('/acquire/requests/quota')) return { quota: QUOTA };
    if (path.startsWith('/acquire/requests/check')) return { check: { canRequest: true, blocked: null } };
    if (path === '/acquire/requests' && method === 'POST') return { outcome: 'accepted', reason: 'looking', certainty: 'Succeeded', message: 'Asked', requestId: 'a'.repeat(32) };
    return null;
  }
  const status = (method, path) => method === 'POST' && path === '/acquire/requests' ? 201 : 200;
  const h = createHarness({
    url: 'http://jellyfin.test/web/index.html#/details?id=x',
    html: '<div id="page"><div class="mainDetailButtons"></div></div>',
    apiClient: { getCurrentUserId: () => user },
    JE: {
      t: (k, p) => p?.n ? k + ':' + p.n : k, toast: m => toasts.push(m), icon: () => '', escapeHtml: s => String(s),
      IconName: { VIDEO: 'v', AUDIO: 'a', SUBTITLES: 's', QUESTION: 'q' },
      pluginConfig: { NativeAbsentDetailsEnabled: true, ArrManageDrawerEnabled: true, ArrStatusEnabled: true, ArrRequestsEnabled: asks,
        JellyseerrEnabled: true, JellyseerrShowReportButton: true },
      session: { getEpoch: () => epoch, isCurrent: e => e === epoch, onUserChange: (_name, fn) => { switches.push(fn); return () => {}; }, userScopedKey: k => k + ':' + user },
      helpers: { debounce: fn => fn, trackUsage() {}, addCSS() {}, getItemCached: async () => null },
      arr: { live: { position: () => null, prime: () => prime ? prime.promise : Promise.resolve({ epoch: 'e1', cursor: 1 }) }, onStatusChange: () => () => {} },
      internals: { arrNotify: { attachModal() {} }, ...(seerrMoreInfo ? { moreInfoModal: {
        state: { currentModal: null }, buildModalContent: () => '<div data-mount="ratings"></div>', renderActions() {},
        enrichSeasonCardsWithJellyfinLinks() {}, backfillSeasonMetadata() {}, buildRatingLogos: () => '' } } : {}) },
      seerrStatus: { MEDIA: { UNKNOWN: 1, AVAILABLE: 5 } },
      core: {
        api: {
          plugin: async (path, options = {}) => answer(options.method || 'GET', path, options.body),
          pluginResponse: async (path, options = {}) => ({ status: status(options.method || 'GET', path), body: await answer(options.method || 'GET', path, options.body) }),
          fetch: async (url, options = {}) => answer(options.method || 'GET', url.replace('http://jellyfin.test/JellyfinEnhanced', ''), options.body),
        },
        navigation: { onNavigate: () => () => {}, onViewPage: () => () => {} },
        lifecycle: { register: () => ({ track: x => x }) },
      },
      titleDetails: { openKey: async () => true, openItem() {} },
    },
  });
  h.allowConsoleError(/could not load|Failed to load|Error opening more info/);
  t.after(() => { h.JE.titleActions?.dispose?.(); h.JE.arrManage?.close?.(); h.JE.arrAskSheet?.close?.(); h.close(); });
  h.load('jellyseerr/api.js');
  h.load('jellyseerr/modal.js');
  h.load('jellyseerr/issue-reporter.js');
  h.load('arr/status/status-core.js');
  h.load('arr/manage/manage-styles.js');
  h.load('arr/manage/manage-drawer.js');
  if (asks) for (const m of ['arr/ask/ask-core.js', 'arr/ask/ask-episodes.js', 'arr/ask/ask-sheet-styles.js', 'arr/ask/ask-sheet.js']) h.load(m);
  if (seerrMoreInfo) { h.load('jellyseerr/moreinfo/more-info-modal-data.js'); h.load('jellyseerr/moreinfo/more-info-modal-init.js'); }
  h.load('arr/actions/title-actions.js');
  h.load('arr/actions/title-actions-sheet.js');
  h.load('arr/actions/title-actions-hosts.js');
  h.JE.initializeArrStatus?.();
  const a = h.JE.titleActions;
  const page = h.document.querySelector('#page');
  const row = () => h.document.querySelector('.mainDetailButtons');
  return {
    ...h, a, page, row, requests, toasts,
    hold(method, prefix) { const d = deferred(); gates.push({ method, prefix, d }); return d; },
    holdFeed() { prime = deferred(); return prime; },
    sent: (method, prefix) => requests.filter(r => r[1] === method && r[2].startsWith(prefix)),
    switchUser() { user = 'user-b'; epoch++; switches.forEach(fn => fn({ userId: user })); },
    navigate(hash = '#/movies') { h.window.location.hash = hash; },
    featureOff() { h.JE.pluginConfig.NativeAbsentDetailsEnabled = false; a.scan(); },
  };
}

/** Mounts the absent title's row in its compact (phone) layout. */
function mount(h, width = 390) {
  Object.defineProperty(h.window, 'innerWidth', { value: width, writable: true, configurable: true });
  const row = h.row(); row.getBoundingClientRect = () => ({ width: 100 });
  h.a.mountRow(row, h.page, h.a.fromKey('movie:tmdb:603'));
}

function remount(h) {
  const row = h.row(); const clone = row.cloneNode(true); row.replaceWith(clone);
  clone.getBoundingClientRect = () => ({ width: 100 });
  h.a.mountRow(clone, h.page, h.a.fromKey('movie:tmdb:603'));
}

const INTERRUPTS = [
  ['navigation', h => h.navigate()],
  ['remount (cloned row)', remount],
  ['session switch', h => h.switchUser()],
  ['feature-off', h => h.featureOff()],
];

/** Opens the row's More sheet and presses `id`. */
async function press(h, id) {
  h.row().querySelector('.je-actions-more').click(); await settle();
  const entry = h.document.querySelector(`.je-actions-entry[data-action="${id}"]`);
  assert.ok(entry, 'the sheet offers ' + id);
  entry.click(); await settle();
}

/** ask-core reads capabilities once a minute: the next read goes to the server again. */
function expireCapabilities(h) {
  const now = h.window.Date.now.bind(h.window.Date); let skew = 0;
  h.window.Date.now = () => now() + skew;
  return () => { skew += 120000; };
}

// ---------------------------------------------------------------- Report (D46S2-R3-1)

/** Picks an issue type in the open Report form and submits it. */
async function submitReport(h) {
  const modal = h.document.querySelector('.jellyseerr-season-modal');
  assert.ok(modal, 'the Report form is open');
  modal.querySelector('input[name="issue-type"]').checked = true;
  modal.querySelector('.jellyseerr-modal-button-primary').click(); await settle();
}

for (const [name, interrupt] of INTERRUPTS) {
  test(`Report: ${name} while reportIssue awaits reportContext → no POST /jellyseerr/issue`, async t => {
    const h = setup(t); h.a.initialize(); mount(h); await settle();
    await press(h, 'report');
    const context = h.hold('GET', '/jellyseerr/movie/603');
    await submitReport(h);
    interrupt(h);
    context.resolve(); await settle();
    assert.equal(h.sent('POST', '/jellyseerr/issue').length, 0);
  });

  test(`Report: ${name} while the form is open, then submit → no reportContext read, no POST`, async t => {
    const h = setup(t); h.a.initialize(); mount(h); await settle();
    await press(h, 'report');
    interrupt(h); await settle();
    // A remount's own row setup reads the record for the new mount; the form must not read or post.
    const reads = h.sent('GET', '/jellyseerr/movie/603').length;
    if (h.document.querySelector('.jellyseerr-season-modal')) await submitReport(h);
    assert.equal(h.sent('GET', '/jellyseerr/movie/603').length, reads);
    assert.equal(h.sent('POST', '/jellyseerr/issue').length, 0);
  });
}

test('controls: Report submitted on the same session, route and mount posts once', async t => {
  const h = setup(t); h.a.initialize(); mount(h); await settle();
  await press(h, 'report');
  await submitReport(h);
  assert.equal(h.sent('POST', '/jellyseerr/issue').length, 1);
});

test('controls: the native Report form (no operation) still posts after navigating while reportContext is out', async t => {
  const h = setup(t);
  h.JE.jellyseerrIssueReporter.showReportModal('603', 'The Matrix', 'movie'); await settle();
  const context = h.hold('GET', '/jellyseerr/movie/603');
  await submitReport(h);
  h.navigate();
  context.resolve(); await settle();
  assert.equal(h.sent('POST', '/jellyseerr/issue').length, 1, 'exactly as before');
});

// ---------------------------------------------------------------- Request sheet (D46S2-R3-2)

const sheet = h => h.document.querySelector('.je-sheet');

for (const [name, interrupt] of INTERRUPTS) {
  test(`Request: ${name} while open() awaits me() → no request sheet`, async t => {
    const h = setup(t); h.a.initialize(); mount(h); await settle();
    const expire = expireCapabilities(h);
    h.row().querySelector('.je-actions-more').click(); await settle();
    expire();
    const me = h.hold('GET', '/acquire/requests/me');
    h.document.querySelector('.je-actions-entry[data-action="request"]').click(); await settle();
    assert.equal(h.sent('GET', '/acquire/requests/me').length >= 2, true, 'open() reads capabilities');
    interrupt(h);
    const quotas = h.sent('GET', '/acquire/requests/quota').length;
    me.resolve(); await settle();
    assert.equal(sheet(h), null);
    assert.equal(h.sent('GET', '/acquire/requests/quota').length, quotas, 'open() stops right after me(): no further reads');
    assert.equal(h.sent('POST', '/acquire/requests').length, 0);
  });

  test(`Request: ${name} while open() awaits the quota → no request sheet`, async t => {
    const h = setup(t); h.a.initialize(); mount(h); await settle();
    const quota = h.hold('GET', '/acquire/requests/quota');
    await press(h, 'request');
    interrupt(h);
    quota.resolve(); await settle();
    assert.equal(sheet(h), null);
  });

  test(`Request: ${name} while the request sheet is open, then submit → no ask`, async t => {
    const h = setup(t); h.a.initialize(); mount(h); await settle();
    await press(h, 'request');
    assert.ok(sheet(h), 'the request sheet is open');
    interrupt(h);
    sheet(h)?.querySelector('.je-sheet-primary')?.click(); await settle();
    assert.equal(h.sent('POST', '/acquire/requests').length, 0);
  });
}

test('controls: Request on the same session, route and mount opens the sheet, and its submit asks once', async t => {
  const h = setup(t); h.a.initialize(); mount(h); await settle();
  await press(h, 'request');
  assert.ok(sheet(h));
  sheet(h).querySelector('.je-sheet-primary').click(); await settle();
  assert.equal(h.sent('POST', '/acquire/requests').length, 1);
});

test('controls: the native request sheet (no operation) still opens after navigating while me() is out', async t => {
  const h = setup(t);
  const me = h.hold('GET', '/acquire/requests/me');
  const opened = h.JE.arrAskSheet.open({ key: 'movie:tmdb:603', kind: 'movie', name: 'The Matrix' }); await settle();
  h.navigate();
  me.resolve(); await settle();
  assert.ok(sheet(h), 'exactly as before');
  sheet(h).querySelector('.je-sheet-primary').click(); await settle();
  assert.equal(h.sent('POST', '/acquire/requests').length, 1);
  await opened;
});

/** The page's own Request control (the ask mount) as the row's primary, pressed through the compact row. */
async function mountWithAsk(h) {
  h.JE.arrAskSheet.mount(h.row(), { key: 'movie:tmdb:603', kind: 'movie', name: 'The Matrix' }); await settle();
  assert.ok(h.row().querySelector('.je-ask-mount-request'), 'the page offers its own Request');
  mount(h); await settle();
  const primary = h.row().querySelector('.je-actions-row .je-actions-primary');
  assert.ok(primary, 'the compact row shows it as its primary');
  return primary;
}

for (const [name, interrupt] of INTERRUPTS) {
  test(`one-tap ask through the row's primary: ${name} while openOrAsk awaits the quota → no ask`, async t => {
    const h = setup(t); h.a.initialize();
    const primary = await mountWithAsk(h);
    const quota = h.hold('GET', '/acquire/requests/quota');
    primary.click(); await settle();
    interrupt(h);
    quota.resolve(); await settle();
    assert.equal(h.sent('POST', '/acquire/requests').length, 0);
    assert.equal(sheet(h), null);
  });
}

test('controls: the one-tap ask through the row\'s primary asks once on the same route', async t => {
  const h = setup(t); h.a.initialize();
  (await mountWithAsk(h)).click(); await settle();
  assert.equal(h.sent('POST', '/acquire/requests').length, 1);
});

test('controls: the page\'s own Request pressed natively (action bar off) still asks after navigating while the quota is out', async t => {
  const h = setup(t);
  h.JE.arrAskSheet.mount(h.row(), { key: 'movie:tmdb:603', kind: 'movie', name: 'The Matrix' }); await settle();
  const quota = h.hold('GET', '/acquire/requests/quota');
  h.row().querySelector('.je-ask-mount-request').click(); await settle();
  h.navigate();
  quota.resolve(); await settle();
  assert.equal(h.sent('POST', '/acquire/requests').length, 1, 'exactly as before');
});

// ---------------------------------------------------------------- Manage drawer (D46S2-R3-3)

const drawer = h => h.document.querySelector('.je-manage-overlay');

for (const [name, interrupt] of INTERRUPTS) {
  test(`Manage: ${name} while the drawer awaits feedPosition → no overview read, no drawer`, async t => {
    const h = setup(t); h.a.initialize(); mount(h); await settle();
    h.row().querySelector('.je-actions-more').click(); await settle();
    // The sheet has read the status; the drawer's own feed position is held.
    const feed = h.holdFeed();
    h.document.querySelector('.je-actions-entry[data-action="manage"]').click(); await settle();
    assert.ok(drawer(h) || h.sent('GET', '/arr/admin/manage?').length === 0, 'the drawer is opening');
    interrupt(h);
    feed.resolve({ epoch: 'e1', cursor: 1 }); await settle();
    assert.equal(h.sent('GET', '/arr/admin/manage?').length, 0);
    assert.equal(drawer(h), null);
  });

  test(`Manage: ${name} while the overview read is out → the drawer closes, nothing rendered`, async t => {
    const h = setup(t); h.a.initialize(); mount(h); await settle();
    const read = h.hold('GET', '/arr/admin/manage?');
    await press(h, 'manage');
    interrupt(h);
    read.resolve(); await settle();
    assert.equal(drawer(h), null);
  });
}

test('controls: Manage on the same session, route and mount reads the overview once and shows it', async t => {
  const h = setup(t); h.a.initialize(); mount(h); await settle();
  await press(h, 'manage');
  assert.equal(h.sent('GET', '/arr/admin/manage?').length, 1);
  assert.ok(drawer(h));
});

test('controls: the native Manage drawer (no operation) still reads after navigating while feedPosition is out', async t => {
  const h = setup(t);
  const feed = h.holdFeed();
  const opened = h.JE.arrManage.open({ key: 'movie:tmdb:603' }); await settle();
  h.navigate();
  feed.resolve({ epoch: 'e1', cursor: 1 }); await settle(); await opened;
  assert.equal(h.sent('GET', '/arr/admin/manage?').length, 1, 'exactly as before');
  assert.ok(drawer(h));
});

// ---------------------------------------------------------------- Seerr's own request owners (inventory)

const moreInfo = h => h.document.querySelector('.je-more-info-modal');

for (const [name, interrupt] of INTERRUPTS) {
  test(`Seerr request (More Info window): ${name} while open() awaits the title's details → no window`, async t => {
    const h = setup(t, { asks: false, seerrMoreInfo: true }); h.a.initialize(); mount(h); await settle();
    const details = h.hold('GET', '/jellyseerr/movie/603');
    await press(h, 'request');
    interrupt(h);
    details.resolve(); await settle();
    assert.equal(moreInfo(h), null);
  });
}

test('controls: Seerr request (More Info window) on the same route opens the window', async t => {
  const h = setup(t, { asks: false, seerrMoreInfo: true }); h.a.initialize(); mount(h); await settle();
  await press(h, 'request');
  assert.ok(moreInfo(h));
});

test('controls: the native More Info window (no operation) still opens after navigating while its details are out', async t => {
  const h = setup(t, { asks: false, seerrMoreInfo: true });
  const details = h.hold('GET', '/jellyseerr/movie/603');
  const opened = h.JE.jellyseerrMoreInfo.open(603, 'movie'); await settle();
  h.navigate();
  details.resolve(); await settle(); await opened;
  assert.ok(moreInfo(h), 'exactly as before');
});

/** An operation of a mounted row, as the action bar submits it. */
function operationOf(h) {
  let live = true;
  return { op: h.a.generation(() => live), end: () => { live = false; } };
}

for (const [name, end] of [['navigation', (h) => h.navigate()], ['remount/feature-off (the mount ends)', (_h, o) => o.end()], ['session switch', h => h.switchUser()]]) {
  test(`Seerr requestMedia for an operation: ${name} during override-rule evaluation → no POST /jellyseerr/request`, async t => {
    const h = setup(t);
    const o = operationOf(h);
    const rules = h.hold('GET', '/jellyseerr/overrideRule');
    const sent = h.JE.runSubmitted(o.op, () => h.JE.jellyseerrAPI.requestMedia(603, 'movie', {}, false, { id: 603, originalLanguage: 'en' }));
    await settle();
    assert.equal(h.sent('GET', '/jellyseerr/overrideRule').length, 1, 'the rules are read first');
    end(h, o);
    rules.resolve(); await assert.rejects(sent, e => e?.name === 'AbortError'); await settle();
    assert.equal(h.sent('POST', '/jellyseerr/request').length, 0);
  });

  test(`Seerr requestTvSeasons for an operation: ${name} during override-rule evaluation → no POST`, async t => {
    const h = setup(t);
    const o = operationOf(h);
    const rules = h.hold('GET', '/jellyseerr/overrideRule');
    const sent = h.JE.runSubmitted(o.op, () => h.JE.jellyseerrAPI.requestTvSeasons(1399, [1], {}, { id: 1399, originalLanguage: 'en' }));
    await settle();
    end(h, o);
    rules.resolve(); await assert.rejects(sent, e => e?.name === 'AbortError'); await settle();
    assert.equal(h.sent('POST', '/jellyseerr/request').length, 0);
  });
}

test('controls: Seerr requestMedia for a current operation, and natively after navigating, posts once each', async t => {
  const h = setup(t);
  const o = operationOf(h);
  await h.JE.runSubmitted(o.op, () => h.JE.jellyseerrAPI.requestMedia(603, 'movie', {}, false, { id: 603, originalLanguage: 'en' }));
  assert.equal(h.sent('POST', '/jellyseerr/request').length, 1);
  const rules = h.hold('GET', '/jellyseerr/overrideRule');
  const native = h.JE.jellyseerrAPI.requestMedia(603, 'movie', {}, false, { id: 603, originalLanguage: 'en' }); await settle();
  h.navigate();
  rules.resolve(); await native;
  assert.equal(h.sent('POST', '/jellyseerr/request').length, 2, 'natively exactly as before');
});

test('the shared Seerr modal opened for an operation: navigation, then its primary button → onSave never runs', async t => {
  const h = setup(t);
  const o = operationOf(h); let saved = 0;
  const modal = h.JE.runSubmitted(o.op, () => h.JE.jellyseerrModal.create({ title: 'x', subtitle: 'y', bodyHtml: '', onSave: () => { saved++; } }));
  modal.show(); await settle();
  h.navigate();
  modal.modalElement.querySelector('.jellyseerr-modal-button-primary').click(); await settle();
  assert.equal(saved, 0);
  const native = h.JE.jellyseerrModal.create({ title: 'x', subtitle: 'y', bodyHtml: '', onSave: () => { saved++; } });
  native.show(); await settle();
  native.modalElement.querySelector('.jellyseerr-modal-button-primary').click(); await settle();
  assert.equal(saved, 1, 'a native modal saves as before');
});

/** Seerr's season-selection modal (real, over the real modal shell) with its title reads held by `details`. */
function seasonSetup(t) {
  const h = setup(t);
  for (const file of ['seerr-status.js', 'ui/ui-icons.js', 'ui/ui-quota.js', 'ui/ui-season-modal.js']) h.load(`jellyseerr/${file}`);
  h.JE.internals.jellyseerrUi.markCardRequested = () => {};
  let details = null;
  Object.assign(h.JE.jellyseerrAPI, { fetchRequestSettings: async () => ({ partialRequestsEnabled: true, enableSpecialEpisodes: false }),
    fetchTvShowDetails: async () => { if (details) await details.promise; return { name: 'Show', seasons: [{ seasonNumber: 1, episodeCount: 3, airDate: '2020-01-01' }], externalIds: { tvdbId: 1 } }; },
    fetchSonarrLookup: async () => [], fetchUserQuota: async () => null, fetchTvSeasonDetails: async () => ({}) });
  return { ...h, holdDetails() { details = deferred(); return details; },
    modal: () => h.document.querySelector('.jellyseerr-season-modal'),
    async request() {
      const modal = h.document.querySelector('.jellyseerr-season-modal');
      modal.querySelector('.jellyseerr-season-checkbox[data-season-number="1"]').checked = true;
      modal.querySelector('.jellyseerr-modal-button-primary').click(); await settle();
    } };
}

for (const [name, end] of [['navigation', h => h.navigate()], ['remount/feature-off (the mount ends)', (_h, o) => o.end()], ['session switch', h => h.switchUser()]]) {
  test(`Seerr season modal for an operation: ${name} while the show's details are out → no modal`, async t => {
    const h = seasonSetup(t); const o = operationOf(h);
    const details = h.holdDetails();
    const opened = h.JE.runSubmitted(o.op, () => h.JE.jellyseerrUI.showSeasonSelectionModal(1399, 'tv', 'Show'));
    await settle(); end(h, o); details.resolve(); await opened; await settle();
    assert.equal(h.modal(), null);
  });

  test(`Seerr season modal for an operation: ${name} while it is open, then Request → no POST`, async t => {
    const h = seasonSetup(t); const o = operationOf(h);
    await h.JE.runSubmitted(o.op, () => h.JE.jellyseerrUI.showSeasonSelectionModal(1399, 'tv', 'Show')); await settle();
    assert.ok(h.modal(), 'the modal is open');
    end(h, o);
    if (h.modal()?.querySelector('.jellyseerr-season-checkbox[data-season-number="1"]')) await h.request();
    assert.equal(h.sent('POST', '/jellyseerr/request').length, 0);
  });
}

test('controls: the season modal for a current operation, and natively after navigating, requests once each', async t => {
  const h = seasonSetup(t); const o = operationOf(h);
  await h.JE.runSubmitted(o.op, () => h.JE.jellyseerrUI.showSeasonSelectionModal(1399, 'tv', 'Show')); await settle();
  await h.request();
  assert.equal(h.sent('POST', '/jellyseerr/request').length, 1);
  h.modal()?.remove();
  const details = h.holdDetails();
  const opened = h.JE.jellyseerrUI.showSeasonSelectionModal(1399, 'tv', 'Show'); await settle();
  h.navigate(); details.resolve(); await opened; await settle();
  assert.ok(h.modal(), 'natively the modal still opens');
  await h.request();
  assert.equal(h.sent('POST', '/jellyseerr/request').length, 2, 'and requests, exactly as before');
});
