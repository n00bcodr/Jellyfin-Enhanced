import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, deferred } from '../helpers/harness.mjs';

// D46 slice 2 review round 1: every setup/action continuation and every adapter-created node is owned
// by one (session, mount, route) generation. It acts only while all three are current, a cancelled
// lookup ends the setup, and adapter nodes are removed and rebuilt on remount or disposal.

const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };
const ABSENT_ROW = '<div id="page"><div class="mainDetailButtons"><button class="je-native-absent-legacy-request" aria-label="Request">Request</button></div></div>';

/**
 * Title actions over a details page, with a live session mock, a gate for admissions and the owners'
 * write paths recorded per user.
 */
function setup(t, { html = ABSENT_ROW, extra = {}, url = 'http://jellyfin.test/web/index.html#/details?id=x' } = {}) {
  let user = 'user-a'; let epoch = 1; const switches = [];
  const calls = []; const writes = []; const opened = [];
  const gates = [];
  const h = createHarness({
    url, html,
    JE: {
      t: k => k,
      pluginConfig: { NativeAbsentDetailsEnabled: true },
      session: { getEpoch: () => epoch, isCurrent: e => e === epoch, onUserChange: (_name, fn) => switches.push(fn) },
      core: { api: { plugin: async path => {
        calls.push([user, path]);
        const gate = gates.shift();
        return gate ? gate.promise : { allowed: true, itemId: '12345678901234567890123456789012' };
      } } },
      titleDetails: { openKey: async key => { opened.push([user, 'key', key]); return true; }, openItem: id => opened.push([user, 'item', id]) },
      arrNotify: { enabled: () => true, loadFollows: async () => {}, isFollowing: () => false, onChange() {},
        setFollow: async (key, on) => { writes.push([user, 'follow', key, on]); return { ok: true }; } },
      arrAsk: { enabled: () => true, me: async () => ({}), canAsk: () => true },
      arrAskSheet: { open: input => { opened.push([user, 'ask', input.key]); } },
      arrManage: { open: target => { opened.push([user, 'manage', target.key]); } },
      ...extra,
    }, apiClient: { getCurrentUserId: () => user },
  });
  t.after(() => { h.JE.titleActions?.dispose?.(); h.close(); });
  h.load('arr/actions/title-actions.js');
  h.load('arr/actions/title-actions-sheet.js');
  h.load('arr/actions/title-actions-hosts.js');
  const a = h.JE.titleActions;
  const page = h.document.querySelector('#page');
  const row = () => h.document.querySelector('.mainDetailButtons');
  return {
    ...h, a, calls, writes, opened, page, row,
    /** The next plugin call waits for the returned gate. */
    gate() { const d = deferred(); gates.push(d); return d; },
    switchUser() { user = 'user-b'; epoch++; switches.forEach(fn => fn()); },
    navigate(hash = '#/movies') { h.window.location.hash = hash; },
    featureOff() { h.JE.pluginConfig.NativeAbsentDetailsEnabled = false; a.scan(); },
  };
}

/** Mounts an absent title row that needs the compact layout. */
function mountAbsent(h) {
  const row = h.row(); row.getBoundingClientRect = () => ({ width: 100 });
  const c = h.a.fromKey('movie:tmdb:603');
  h.a.mountRow(row, h.page, c);
  return c;
}

/** Replaces the row with a copy of itself (no listeners, no expando properties), as hosts do. */
function cloneRow(h) {
  const row = h.row(); const clone = row.cloneNode(true); row.replaceWith(clone);
  clone.getBoundingClientRect = () => ({ width: 100 });
  return clone;
}

const adapted = root => [...root.querySelectorAll('.je-actions-adapted')];

test('B2: a cloned row rebuilds its adapter Follow; the compact proxy writes once through the live owner', async t => {
  const h = setup(t);
  const c = mountAbsent(h); await settle();
  assert.equal(adapted(h.row()).filter(n => n.dataset.jeActionKind === 'follow').length, 1);
  const clone = cloneRow(h);
  h.a.mountRow(clone, h.page, c); await settle();
  assert.equal(adapted(clone).filter(n => n.dataset.jeActionKind === 'follow').length, 1, 'one adapter Follow, never the dead copy');
  clone.querySelector('.je-actions-row [data-action="follow"]').click(); await settle();
  assert.deepEqual(h.writes, [['user-a', 'follow', 'movie:tmdb:603', true]]);
});

test('B2: a host copy of an adapter control inside the retained row is replaced by a live one', async t => {
  const h = setup(t);
  mountAbsent(h); await settle();
  const original = adapted(h.row()).find(n => n.dataset.jeActionKind === 'follow');
  original.replaceWith(original.cloneNode(true));
  h.a.scan(); await settle(); h.a.scan();
  const follows = adapted(h.row()).filter(n => n.dataset.jeActionKind === 'follow');
  assert.equal(follows.length, 1);
  h.row().querySelector('.je-actions-row [data-action="follow"]').click(); await settle();
  assert.deepEqual(h.writes, [['user-a', 'follow', 'movie:tmdb:603', true]]);
});

test('B2: a user switch removes adapter controls holding the old session; a remount acts as the new user', async t => {
  const h = setup(t);
  h.a.initialize();
  const c = mountAbsent(h); await settle();
  assert.ok(adapted(h.row()).length > 0);
  h.switchUser();
  assert.deepEqual(adapted(h.row()), [], 'no control with a cancelled session closure stays attached');
  assert.equal(h.row().querySelector('.je-actions-row'), null);
  h.a.mountRow(h.row(), h.page, c); await settle();
  h.row().querySelector('.je-actions-row [data-action="follow"]').click(); await settle();
  assert.deepEqual(h.writes, [['user-b', 'follow', 'movie:tmdb:603', true]]);
});

test('B2: feature-off disposal removes every adapter node and leaves the native originals intact', async t => {
  const h = setup(t);
  mountAbsent(h); await settle();
  const native = h.row().querySelector('.je-native-absent-legacy-request');
  h.featureOff();
  assert.deepEqual(adapted(h.document), []);
  assert.equal(h.document.querySelector('.je-actions-row, .je-actions-wide-more, .je-actions-original, .je-actions-compact'), null);
  assert.equal(native.isConnected, true);
});

for (const [name, interrupt] of [
  ['session switch', h => h.switchUser()],
  ['remount (cloned row)', h => { const clone = cloneRow(h); h.a.mountRow(clone, h.page, h.a.fromKey('movie:tmdb:603')); }],
  ['navigation', h => h.navigate()],
  ['feature-off disposal', h => h.featureOff()],
]) {
  test(`row setup interrupted by ${name} mid-admission publishes nothing on the old owner`, async t => {
    const h = setup(t); h.a.initialize();
    const gate = h.gate();
    const row = h.row(); mountAbsent(h);
    interrupt(h);
    gate.resolve({ allowed: true }); await settle();
    // Only the current generation (the remount's own setup) may have added controls.
    assert.deepEqual(adapted(row), [], 'the stale continuation never appends to the old row');
    if (name.startsWith('remount')) assert.equal(adapted(h.row()).filter(n => n.dataset.jeActionKind === 'follow').length, 1);
  });

  test(`row More interrupted by ${name} mid-admission opens no sheet`, async t => {
    const h = setup(t); h.a.initialize();
    mountAbsent(h); await settle();
    const gate = h.gate();
    h.row().querySelector('.je-actions-more').click();
    interrupt(h);
    gate.resolve({ allowed: true }); await settle();
    assert.equal(h.document.querySelector('.je-actions-backdrop'), null);
  });

  test(`adapted control action interrupted by ${name} mid-admission never runs its owner`, async t => {
    const h = setup(t); h.a.initialize();
    mountAbsent(h); await settle();
    const gate = h.gate();
    adapted(h.row()).find(n => n.dataset.jeActionKind === 'follow').click();
    interrupt(h);
    gate.resolve({ allowed: true }); await settle();
    assert.deepEqual(h.writes, []);
  });

  test(`sheet actions interrupted by ${name} mid-admission never run (Request, Follow, Manage, Share, Open)`, async t => {
    for (const id of ['request', 'follow', 'manage', 'share', 'open']) {
      const h = setup(t, { extra: { pluginConfig: { NativeAbsentDetailsEnabled: true, ArrManageDrawerEnabled: true },
        arrStatus: { enabled: () => true, fetchKey: async () => ({ items: [{ admin: {} }] }) } } });
      h.a.initialize();
      let shared = 0; h.window.navigator.clipboard = { writeText: async () => { shared++; } };
      mountAbsent(h); await settle();
      h.row().querySelector('.je-actions-more').click(); await settle();
      const gate = h.gate();
      h.document.querySelector(`.je-actions-entry[data-action="${id}"]`).click();
      interrupt(h);
      gate.resolve({ allowed: true, itemId: '12345678901234567890123456789012' }); await settle();
      assert.deepEqual([h.writes, h.opened, shared], [[], [], 0], id);
    }
  });
}

for (const [name, interrupt] of [
  ['session switch', h => h.switchUser()],
  ['card remount', h => { const card = h.document.querySelector('.jellyseerr-card'); card.replaceWith(card.cloneNode(true)); h.a.scan(); }],
  ['navigation', h => h.navigate()],
  ['feature-off disposal', h => h.featureOff()],
]) {
  test(`card menu interrupted by ${name} mid-admission opens no sheet`, async t => {
    const h = setup(t, { html: '<div class="jellyseerr-card"><a data-tmdb-id="603" data-media-type="movie">Title</a></div>' });
    h.a.initialize(); h.a.scan();
    const gate = h.gate();
    h.document.querySelector('.je-card-more').click();
    interrupt(h);
    gate.resolve({ allowed: true }); await settle();
    assert.equal(h.document.querySelector('.je-actions-backdrop'), null);
  });
}

test('feature-off and document disposal remove card More buttons; a user switch rebuilds them', async t => {
  const h = setup(t, { html: '<div class="jellyseerr-card"><a data-tmdb-id="603" data-media-type="movie">Title</a></div>' });
  h.a.initialize(); h.a.scan();
  const first = h.document.querySelector('.je-card-more');
  h.switchUser(); h.a.scan();
  assert.equal(h.document.querySelectorAll('.je-card-more').length, 1);
  assert.notEqual(h.document.querySelector('.je-card-more'), first, 'rebuilt for the current identity');
  h.a.dispose();
  assert.equal(h.document.querySelector('.je-card-more, .je-actions-card'), null);
});

test('B3: a shared link whose admission answers after the viewer navigated away never opens the title', async t => {
  const h = setup(t, { url: 'http://jellyfin.test/web/index.html#/home?jeTitle=movie%3Atmdb%3A603' });
  const gate = h.gate();
  const pending = h.a.receive('movie:tmdb:603');
  h.navigate('#/movies');
  gate.resolve({ allowed: true, itemId: '12345678901234567890123456789012' });
  assert.equal(await pending, false);
  assert.deepEqual(h.opened, []);
});

test('B3: a shared link resolved by key stops when the viewer navigates during the lookup', async t => {
  const h = setup(t, { url: 'http://jellyfin.test/web/index.html#/home?jeTitle=movie%3Atmdb%3A603' });
  const lookup = deferred(); let navigated = 0;
  h.JE.core.api.plugin = async path => path.startsWith('/title-actions/') ? { allowed: true } : lookup.promise;
  h.JE.titleDetails.openKey = async (_key, options = {}) => { await lookup.promise; if (options.current?.() === false) return false; navigated++; return true; };
  const pending = h.a.receive('movie:tmdb:603');
  await settle(); h.navigate('#/movies'); lookup.resolve({}); await pending;
  assert.equal(navigated, 0);
});

test('controls: a same-session share receive still opens the actual copy', async t => {
  const h = setup(t, { url: 'http://jellyfin.test/web/index.html#/home?jeTitle=movie%3Atmdb%3A603' });
  assert.equal(await h.a.receive('movie:tmdb:603'), true);
  assert.deepEqual(h.opened, [['user-a', 'item', '12345678901234567890123456789012']]);
});

test('controls: a shared link that navigates to the actual copy reports success and is not resolved again on Back', async t => {
  const h = setup(t, { url: 'http://jellyfin.test/web/index.html#/home?jeTitle=movie%3Atmdb%3A603' });
  h.JE.titleDetails.openItem = id => { h.opened.push(['user-a', 'item', id]); h.window.location.hash = '#/details?id=' + id; };
  h.a.initialize(); await settle();
  assert.equal(h.opened.length, 1);
  h.navigate('#/home?jeTitle=movie%3Atmdb%3A603'); await settle();
  assert.equal(h.opened.length, 1, 'Back to the link does not bounce the viewer forward again');
});

test('arrival Open in the row stops when the viewer navigates during its admission', async t => {
  const h = setup(t, { html: '<div id="page"><div class="mainDetailButtons"><button class="btnPlayTrailer" title="Trailer"></button></div></div>',
    extra: { arrAsk: { enabled: () => false } } });
  mountAbsent(h); await settle();
  const open = adapted(h.row()).find(n => n.dataset.jeActionKind === 'open');
  assert.ok(open, 'an accessible actual copy is offered');
  const gate = h.gate();
  open.click(); h.navigate();
  gate.resolve({ allowed: true, itemId: '12345678901234567890123456789012' }); await settle();
  assert.deepEqual(h.opened, []);
});

test('controls: same-session row setup, sheet actions and adapted controls still work', async t => {
  const h = setup(t); h.a.initialize();
  mountAbsent(h); await settle();
  h.row().querySelector('.je-actions-row [data-action="follow"]').click(); await settle();
  h.row().querySelector('.je-actions-more').click(); await settle();
  h.document.querySelector('.je-actions-entry[data-action="request"]').click(); await settle();
  assert.deepEqual(h.writes, [['user-a', 'follow', 'movie:tmdb:603', true]]);
  assert.deepEqual(h.opened, [['user-a', 'ask', 'movie:tmdb:603']]);
});

/** A resumable library row as 12.2 and 10.11.11 render it (Resume = .btnPlay, Play from beginning = .btnReplay). */
const RESUMABLE = '<div id="page"><div class="mainDetailButtons">' +
  '<button class="button-flat btnPlay detailButton" title="Resume" data-action="resume"><span class="material-icons detailButton-icon play_arrow"></span></button>' +
  '<button class="button-flat btnReplay detailButton" title="Play" data-action="play"><span class="material-icons detailButton-icon replay"></span></button>' +
  '<button class="button-flat btnPlayTrailer detailButton" title="Trailer"></button>' +
  '<button class="button-flat btnPlaystate detailButton" title="Played"></button>' +
  '<button class="button-flat btnUserRating detailButton" title="Favorite"></button>' +
  '<button class="button-flat btnMoreCommands detailButton" title="More"></button></div></div>';

for (const width of [320, 390]) {
  test(`B1: Resume and Play from beginning are both reachable at ${width} px`, async t => {
    const h = setup(t, { html: RESUMABLE, url: 'http://jellyfin.test/web/index.html#/details?id=12345678901234567890123456789012' });
    Object.defineProperty(h.window, 'innerWidth', { value: width, writable: true });
    const row = h.row(); row.getBoundingClientRect = () => ({ width: width - 32 });
    const played = [];
    row.querySelector('.btnPlay').onclick = () => played.push('resume');
    row.querySelector('.btnReplay').onclick = () => played.push('replay');
    h.a.mountRow(row, h.page, h.a.context({ Id: '12345678901234567890123456789012', Type: 'Movie', ProviderIds: { Tmdb: '603' }, absent: false }));
    await settle();
    assert.equal(row.classList.contains('je-actions-compact'), true);
    assert.equal(row.querySelector('.je-actions-primary-label').textContent, 'Resume');
    row.querySelector('.je-actions-primary').click();
    row.querySelector('.je-actions-more').click(); await settle();
    const replay = h.document.querySelector('.je-actions-entry[data-action="replay"]');
    assert.ok(replay, 'Play from beginning has a place in More');
    assert.equal(replay.previousElementSibling.textContent, 'title_actions_group_watch');
    assert.equal(replay.querySelector('.je-actions-entry-label').textContent, 'title_actions_replay');
    replay.click(); await settle();
    assert.deepEqual(played, ['resume', 'replay']);
  });
}

test('B1: an absent title never offers either native playback action', async t => {
  const h = setup(t, { html: RESUMABLE });
  const row = h.row(); row.getBoundingClientRect = () => ({ width: 288 });
  h.a.mountRow(row, h.page, h.a.fromKey('movie:tmdb:603')); await settle();
  assert.equal(row.querySelector('.je-actions-row [data-action="primary"]')?.getAttribute('aria-label') === 'Play', false);
  row.querySelector('.je-actions-more, .je-actions-wide-more').click(); await settle();
  assert.equal(h.document.querySelector('.je-actions-entry[data-action="replay"], .je-actions-entry[data-action="primary"]'), null);
});

for (const [name, interrupt] of [
  ['session switch', h => h.switchUser()],
  ['remount (cloned row)', h => { const clone = cloneRow(h); h.a.mountRow(clone, h.page, h.a.fromKey('movie:tmdb:603')); }],
  ['navigation', h => h.navigate()],
  ['feature-off disposal', h => h.featureOff()],
]) {
  test(`the adapter Report issue count interrupted by ${name} is never published`, async t => {
    const issues = deferred();
    const h = setup(t, { extra: {
      pluginConfig: { NativeAbsentDetailsEnabled: true, JellyseerrEnabled: true, JellyseerrShowReportButton: true, JellyseerrShowIssueIndicator: true },
      jellyseerrAPI: { checkUserStatus: async () => ({ active: true, userFound: true, canReportIssues: true }), reportContext: async () => ({ mediaId: 5 }),
        fetchIssuesForMedia: () => issues.promise },
    } });
    h.load('jellyseerr/issue-reporter.js');
    h.a.initialize();
    const row = h.row(); mountAbsent(h); await settle();
    const report = adapted(row).find(n => n.dataset.jeActionKind === 'report');
    assert.ok(report, 'a permitted Report control is adapted into the row');
    interrupt(h);
    issues.resolve({ results: [{ id: 1 }, { id: 2 }] }); await settle();
    assert.equal(report.querySelector('.jellyseerr-issue-count-badge'), null);
    assert.equal(report.classList.contains('has-open-issues'), false);
  });
}

test('controls: the adapter Report issue count still appears for the same session and route', async t => {
  const h = setup(t, { extra: {
    pluginConfig: { NativeAbsentDetailsEnabled: true, JellyseerrEnabled: true, JellyseerrShowReportButton: true, JellyseerrShowIssueIndicator: true },
    jellyseerrAPI: { checkUserStatus: async () => ({ active: true, userFound: true, canReportIssues: true }), reportContext: async () => ({ mediaId: 5 }),
      fetchIssuesForMedia: async () => ({ results: [{ id: 1 }, { id: 2 }] }) },
  } });
  h.load('jellyseerr/issue-reporter.js');
  mountAbsent(h); await settle();
  assert.equal(adapted(h.row()).find(n => n.dataset.jeActionKind === 'report').querySelector('.jellyseerr-issue-count-badge').textContent, '2');
});

test('a library row whose item read answers after navigation is not mounted', async t => {
  const read = deferred(); let callback;
  const h = setup(t, { html: RESUMABLE, url: 'http://jellyfin.test/web/index.html#/details?id=12345678901234567890123456789012',
    extra: { helpers: { getItemCached: () => read.promise } } });
  h.JE.core.navigation = { onViewPage: fn => { callback = fn; } };
  h.a.initialize();
  callback('details', h.page);
  h.navigate('#/details?id=abcdefabcdefabcdefabcdefabcdefab');
  read.resolve({ Id: '12345678901234567890123456789012', Type: 'Movie', ProviderIds: { Tmdb: '603' } }); await settle();
  assert.equal(h.row().querySelector('.je-actions-wide-more, .je-actions-row'), null);
});

test('a narrow More Info row replaced by a copy is not resurrected when its old generation is disposed', async t => {
  const h = setup(t, { html: '' });
  Object.defineProperty(h.window, 'innerWidth', { value: 390, writable: true });
  const root = h.document.createElement('div'); root.className = 'je-more-info-modal'; root.dataset.tmdbId = '603';
  root.innerHTML = '<div class="header-section"><div class="header-poster"></div><div class="header-info"><div class="je-more-info-actions" data-mount="je-actions"><button class="jellyseerr-request-button">Request</button></div><div id="secondary"></div></div></div>';
  h.document.body.append(root);
  const row = root.querySelector('[data-mount="je-actions"]'); row.parentElement.getBoundingClientRect = () => ({ width: 100 });
  h.a.initialize();
  h.a.mountRow(row, root, h.a.fromKey('movie:tmdb:603')); await settle();
  assert.equal(row.parentElement, root.querySelector('.header-section'), 'moved below the header at phone width');
  const clone = row.cloneNode(true); row.replaceWith(clone);
  h.a.scan(); await settle(); h.a.scan(); await settle();
  assert.equal(root.querySelectorAll('[data-mount="je-actions"]').length, 1, 'the detached original stays detached');
  assert.equal(root.querySelectorAll('.je-actions-row').length, 1);
  assert.equal(row.isConnected, false);
});

test('Q-PLAYD51-1: a season or episode page reads the title status by title key and still offers admin Manage', async t => {
  for (const key of ['tv:tmdb:603:s1', 'tv:tmdb:603:s1:e2']) {
    const asked = [];
    const h = setup(t, { extra: { pluginConfig: { NativeAbsentDetailsEnabled: true, ArrManageDrawerEnabled: true },
      // The status endpoint refuses scoped keys (400 invalid_key), as ArrStatusController does.
      arrStatus: { enabled: () => true, fetchKey: async k => { asked.push(k); if (/:s\d/.test(k)) throw Object.assign(new Error('HTTP 400'), { status: 400 }); return { items: [{ admin: {} }] }; } } } });
    const c = h.a.fromKey(key);
    const entries = await h.a.entries(c, { action: h.a.generation() });
    assert.deepEqual(asked, ['tv:tmdb:603'], key);
    const manage = entries.find(e => e.id === 'manage');
    assert.ok(manage, key);
    manage.run();
    assert.deepEqual(h.opened.at(-1), ['user-a', 'manage', key], 'Manage still opens on the exact scope');
  }
});

test('Q-PLAYD51-2: Open appears only where it goes somewhere else', async t => {
  const id = '12345678901234567890123456789012';
  const dashed = '12345678-9012-3456-7890-123456789012';
  const h = setup(t, { url: 'http://jellyfin.test/web/index.html#/details?id=' + id });
  const ids = async c => { const g = h.a.generation(); await h.a.admit(c, g); return (await h.a.entries(c, { action: g })).map(e => e.id); };
  // The library item's own page (movie, and an episode page with its scope).
  assert.equal((await ids(h.a.context({ Id: dashed, Type: 'Movie', ProviderIds: { Tmdb: '603' }, absent: false }))).includes('open'), false);
  assert.equal((await ids(h.a.context({ Id: id, mediaType: 'tv', tmdbId: 603, season: 1, episode: 2, absent: false }))).includes('open'), false);
  // An absent title whose actual copy has arrived, and a More Info window for a title in the library.
  assert.equal((await ids(h.a.fromKey('movie:tmdb:603'))).includes('open'), true);
  assert.equal((await ids(h.a.context({ mediaType: 'movie', id: 603, mediaInfo: { jellyfinMediaId: id } }))).includes('open'), true);
});
