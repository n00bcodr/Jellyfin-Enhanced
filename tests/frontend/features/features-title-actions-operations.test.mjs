import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, deferred } from '../helpers/harness.mjs';

// D46 slice 2 review round 2: two owners. The OFFER (the sheet or row that showed a choice) decides whether a
// press counts; dismissing it first cancels. The OPERATION a person submitted is owned by the session, the route
// and the owning row/card: it survives the sheet closing and is carried through every await and confirmation,
// rechecked by the existing owner right before its write. Adapter nodes are tracked by identity, so a host copy
// is replaced rather than adopted. Phone (layout-mobile) pages keep the native header; only the row changes.

const settle = async () => { for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve)); };
const ITEM = '12345678901234567890123456789012';

/** Title actions on an absent title's page with the real Spoiler Guard toggle, Hide control and Report owner. */
function setup(t, { html, extra = {}, url = 'http://jellyfin.test/web/index.html#/details?id=x', layout = 'layout-mobile' } = {}) {
  let user = 'user-a'; let epoch = 1; const switches = [];
  const writes = []; const opened = []; const toasts = []; const gates = []; const modals = []; const calls = [];
  const h = createHarness({
    url, html: html ?? '<div id="page"><div class="mainDetailButtons"><button class="je-native-absent-legacy-request" aria-label="Request">Request</button></div></div>',
    apiClient: { getCurrentUserId: () => user, ajax: async o => { writes.push([user, 'hide', o.type || 'POST']); return { success: true }; } },
    JE: {
      t: (k, p) => p?.n ? k + ':' + p.n : k, toast: m => toasts.push(m), icon: () => '', IconName: { VIDEO: 'v', AUDIO: 'a', SUBTITLES: 's', QUESTION: 'q' },
      pluginConfig: { NativeAbsentDetailsEnabled: true, SpoilerBlurEnabled: true, HiddenContentEnabled: true, ArrManageDrawerEnabled: true,
        JellyseerrEnabled: true, JellyseerrShowReportButton: true },
      userConfig: { hiddenContent: { items: {}, settings: {} } },
      session: { getEpoch: () => epoch, isCurrent: e => e === epoch, onUserChange: (_name, fn) => { switches.push(fn); return () => {}; }, userScopedKey: k => k + ':' + user },
      core: { api: { plugin: async (path, options = {}) => { calls.push([options.method || 'GET', path]); const gate = gates.shift(); return gate ? gate.promise : { allowed: true, itemId: ITEM }; } } },
      titleDetails: { openKey: async key => { opened.push([user, 'key', key]); return true; }, openItem: id => opened.push([user, 'item', id]) },
      arrNotify: { enabled: () => true, loadFollows: async () => {}, isFollowing: () => false, onChange() {},
        setFollow: async (key, on) => { writes.push([user, 'follow', key, on]); return { ok: true }; } },
      arrAsk: { enabled: () => true, me: async () => ({}), canAsk: () => true },
      arrAskSheet: { open: input => { opened.push([user, 'ask', input.key]); } },
      arrManage: { open: target => { opened.push([user, 'manage', target.key]); } },
      arrStatus: { enabled: () => true, fetchKey: async () => ({ items: [{ admin: {} }] }) },
      jellyseerrAPI: { checkUserStatus: async () => ({ active: true, userFound: true, canReportIssues: true }), reportContext: async () => ({ mediaId: 5 }),
        fetchIssuesForMedia: async () => ({ results: [] }), reportIssue: async () => { writes.push([user, 'report']); return { id: 1 }; } },
      jellyseerrModal: { create: options => {
        const modalElement = document().createElement('div'); modalElement.innerHTML = options.bodyHtml;
        modalElement.querySelector('input[name="issue-type"]').checked = true;
        const modal = { options, modalElement, closed: false };
        modals.push(modal);
        const close = () => { modal.closed = true; modalElement.remove(); };
        // As the real modal shell: registered for the owner it is opened for, so a press inside it is that owner's.
        return { modalElement, show() { document().body.append(modalElement); h.JE.openSurface(modalElement, close, options.operation); }, close };
      } },
      ...extra,
    },
  });
  const document = () => h.document;
  h.document.documentElement.className = layout;
  t.after(() => { h.JE.titleActions?.dispose?.(); h.close(); });
  // The real owners: Hide (data + its confirmation), the Spoiler Guard toggle and its dialog, Report.
  h.load('enhanced/hiddencontent/hidden-content-data.js');
  const hidden = h.JE.internals.hiddenContent;
  Object.assign(hidden, { refreshNativeCardVisibility() {}, restoreNativeCardsForIds() {}, debouncedSave() {} });
  hidden.resetFromUserConfig();
  h.load('enhanced/hiddencontent/hidden-content-dialogs.js');
  h.JE.hiddenContent = hidden;
  h.load('enhanced/spoilerguard/seerr-toggle.js');
  h.load('enhanced/spoilerguard/dialog.js');
  const guard = h.JE.internals.spoilerGuard;
  const confirms = [];
  Object.assign(guard, { isTmdbKnown: () => true, isTmdbEnabled: () => true, whenLoaded: async () => {}, bindStateView() {},
    confirmDisableSpoiler: () => { const d = deferred(); confirms.push(d); return d.promise; },
    disableForTmdb: async (type, id) => { writes.push([user, 'guard-off', type, id]); } });
  h.load('jellyseerr/issue-reporter.js');
  h.load('arr/actions/title-actions.js');
  h.load('arr/actions/title-actions-sheet.js');
  h.load('arr/actions/title-actions-hosts.js');
  const a = h.JE.titleActions;
  const page = h.document.querySelector('#page');
  const row = () => h.document.querySelector('.mainDetailButtons');
  return {
    ...h, a, writes, opened, toasts, page, row, confirms, modals, guard, hidden, calls,
    gate() { const d = deferred(); gates.push(d); return d; },
    switchUser() { user = 'user-b'; epoch++; switches.forEach(fn => fn({ userId: user })); },
    navigate(hash = '#/movies') { h.window.location.hash = hash; },
    featureOff() { h.JE.pluginConfig.NativeAbsentDetailsEnabled = false; a.scan(); },
  };
}

/** Mounts the absent title row in its compact (phone) layout. */
function mountAbsent(h, width = 390) {
  Object.defineProperty(h.window, 'innerWidth', { value: width, writable: true, configurable: true });
  const row = h.row(); row.getBoundingClientRect = () => ({ width: 100 });
  const c = h.a.fromKey('movie:tmdb:603');
  h.a.mountRow(row, h.page, c);
  return c;
}

function cloneRow(h) {
  const row = h.row(); const clone = row.cloneNode(true); row.replaceWith(clone);
  clone.getBoundingClientRect = () => ({ width: 100 });
  return clone;
}

const INTERRUPTS = [
  ['navigation', h => h.navigate()],
  ['remount (cloned row)', h => { const clone = cloneRow(h); h.a.mountRow(clone, h.page, h.a.fromKey('movie:tmdb:603')); }],
  ['session switch', h => h.switchUser()],
  ['feature-off', h => h.featureOff()],
];

/** Opens the row's More sheet and returns the entry button for `id`. */
async function openSheet(h, id) {
  h.row().querySelector('.je-actions-more').click(); await settle();
  const entry = h.document.querySelector(`.je-actions-entry[data-action="${id}"]`);
  assert.ok(entry, 'the sheet offers ' + id);
  return entry;
}
const escape = h => h.document.querySelector('.je-actions-sheet').dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

/**
 * Each sheet action: how to finish it once submitted (accept its confirmation), and what its completion looks
 * like. `share` copies the link; `open` goes to the actual copy.
 */
const ACTIONS = {
  request: { finish: async () => {}, done: h => h.opened.some(o => o[1] === 'ask'), none: h => !h.opened.some(o => o[1] === 'ask') },
  follow: { finish: async () => {}, done: h => h.writes.some(w => w[1] === 'follow'), none: h => !h.writes.some(w => w[1] === 'follow') },
  manage: { finish: async () => {}, done: h => h.opened.some(o => o[1] === 'manage'), none: h => !h.opened.some(o => o[1] === 'manage') },
  open: { finish: async () => {}, done: h => h.opened.some(o => o[1] === 'item'), none: h => !h.opened.some(o => o[1] === 'item') },
  share: { finish: async () => {}, done: h => h.toasts.includes('title_actions_copied'), none: h => !h.toasts.includes('title_actions_copied') && h.shared === 0 },
  guard: { finish: async h => { h.confirms.at(-1)?.resolve(true); await settle(); }, done: h => h.writes.some(w => w[1] === 'guard-off'), none: h => !h.writes.some(w => w[1] === 'guard-off') },
  hide: { finish: async h => { h.document.querySelector('.je-hide-confirm-overlay .je-hide-confirm-hide')?.click(); await settle(); },
    done: h => h.writes.some(w => w[1] === 'hide'), none: h => !h.writes.some(w => w[1] === 'hide') },
  report: { finish: async h => { const m = h.modals.at(-1); if (m) { const button = h.document.createElement('button'); m.modalElement.append(button); await m.options.onSave(m.modalElement, button, () => {}, { type: 'click', target: button }); } await settle(); },
    done: h => h.writes.some(w => w[1] === 'report'), none: h => !h.writes.some(w => w[1] === 'report') },
};

/** A row whose title needs a guard toggle (a real one, in the row as native-details draws it) and Open. */
function prepare(t, id) {
  const h = setup(t, { extra: id === 'open' ? { arrAsk: { enabled: () => false } } : {} });
  h.shared = 0; h.window.navigator.clipboard = { writeText: async () => { h.shared++; } };
  const toggle = h.guard.buildSeerrToggle({ id: 603, title: 'Title' }, 'movie', { detail: true });
  h.row().append(toggle);
  h.a.initialize();
  mountAbsent(h);
  return h;
}

for (const id of Object.keys(ACTIONS)) {
  test(`${id}: submitted, then the sheet is closed before admission answers → the operation still completes`, async t => {
    const h = prepare(t, id); await settle();
    const entry = await openSheet(h, id);
    const gate = h.gate();
    entry.click(); await settle();
    if (h.document.querySelector('.je-actions-sheet')) escape(h);
    gate.resolve({ allowed: true, itemId: ITEM }); await settle();
    await ACTIONS[id].finish(h);
    assert.equal(ACTIONS[id].done(h), true, id + ' completes after its sheet closed');
  });

  test(`${id}: the sheet dismissed before the press → nothing runs`, async t => {
    const h = prepare(t, id); await settle();
    const entry = await openSheet(h, id);
    escape(h);
    entry.click(); await settle();
    await ACTIONS[id].finish(h);
    assert.equal(ACTIONS[id].none(h), true, id);
  });

  for (const [name, interrupt] of INTERRUPTS) {
    test(`${id}: ${name} during the submitted admission → no mutation`, async t => {
      const h = prepare(t, id); await settle();
      const entry = await openSheet(h, id);
      const gate = h.gate();
      entry.click(); await settle();
      interrupt(h);
      gate.resolve({ allowed: true, itemId: ITEM }); await settle();
      await ACTIONS[id].finish(h);
      assert.equal(ACTIONS[id].none(h), true, id);
    });
  }
}

// SEC-R2-1 and its relatives: the confirmation is part of the operation; the owner rechecks before writing.
for (const id of ['guard', 'hide', 'report']) {
  for (const [name, interrupt] of INTERRUPTS) {
    test(`${id}: ${name} while its confirmation is open → accepting writes nothing`, async t => {
      const h = prepare(t, id); await settle();
      const entry = await openSheet(h, id);
      entry.click(); await settle();
      assert.equal(h.document.querySelector('.je-actions-sheet'), null, 'the sheet gave way to the owner');
      if (id === 'guard') assert.equal(h.confirms.length, 1, 'the Guard asks first');
      if (id === 'hide') assert.ok(h.document.querySelector('.je-hide-confirm-overlay'), 'Hide asks first');
      if (id === 'report') assert.equal(h.modals.length, 1, 'Report opens its form');
      interrupt(h);
      await ACTIONS[id].finish(h);
      assert.equal(ACTIONS[id].none(h), true, id);
    });
  }
  test(`controls: ${id} accepted on the same session, route and mount writes once`, async t => {
    const h = prepare(t, id); await settle();
    (await openSheet(h, id)).click(); await settle();
    await ACTIONS[id].finish(h);
    assert.equal(h.writes.filter(w => w[1] === { guard: 'guard-off', hide: 'hide', report: 'report' }[id]).length, 1);
  });
}

// A direct press on an owner control the adapter placed in a wide row is an operation of that row as well.
for (const id of ['guard', 'hide', 'report']) {
  for (const [name, interrupt] of INTERRUPTS) {
    test(`${id}: a direct press on the adapted row control, then ${name} during its confirmation → no write`, async t => {
      const h = setup(t);
      h.a.initialize();
      Object.defineProperty(h.window, 'innerWidth', { value: 1280, writable: true, configurable: true });
      const row = h.row(); row.getBoundingClientRect = () => ({ width: 2000 });
      h.a.mountRow(row, h.page, h.a.fromKey('movie:tmdb:603')); await settle();
      assert.equal(row.classList.contains('je-actions-compact'), false, 'the wide row');
      const node = row.querySelector(`.je-actions-adapted[data-je-action-kind="${id}"]`);
      assert.ok(node, 'the adapter placed the owner control');
      node.click(); await settle();
      assert.equal({ guard: h.confirms.length, hide: h.document.querySelectorAll('.je-hide-confirm-overlay').length, report: h.modals.length }[id], 1, 'the owner asks first, once');
      interrupt(h);
      await ACTIONS[id].finish(h);
      assert.equal(ACTIONS[id].none(h), true, id);
    });
  }
  test(`controls: ${id} pressed directly on the adapted row control writes once`, async t => {
    const h = setup(t);
    Object.defineProperty(h.window, 'innerWidth', { value: 1280, writable: true, configurable: true });
    const row = h.row(); row.getBoundingClientRect = () => ({ width: 2000 });
    h.a.mountRow(row, h.page, h.a.fromKey('movie:tmdb:603')); await settle();
    row.querySelector(`.je-actions-adapted[data-je-action-kind="${id}"]`).click(); await settle();
    await ACTIONS[id].finish(h);
    assert.equal(h.writes.filter(w => w[1] === { guard: 'guard-off', hide: 'hide', report: 'report' }[id]).length, 1);
  });
}

// A native Guard control (native-details draws it in the absent row) pressed directly in a managed wide row.
for (const [name, interrupt] of INTERRUPTS) {
  test(`native guard: a direct press in the managed row, then ${name} during its confirmation → no write`, async t => {
    const h = setup(t);
    h.row().append(h.guard.buildSeerrToggle({ id: 603, title: 'Title' }, 'movie', { detail: true }));
    h.a.initialize();
    Object.defineProperty(h.window, 'innerWidth', { value: 1280, writable: true, configurable: true });
    const row = h.row(); row.getBoundingClientRect = () => ({ width: 2000 });
    h.a.mountRow(row, h.page, h.a.fromKey('movie:tmdb:603')); await settle();
    row.querySelector('.je-spoiler-pending-detail').click(); await settle();
    assert.equal(h.confirms.length, 1, 'the Guard asks once');
    interrupt(h);
    await ACTIONS.guard.finish(h);
    assert.equal(ACTIONS.guard.none(h), true);
  });
}

for (const [name, interrupt] of INTERRUPTS) {
  test(`external guard (More Info's secondary actions): a direct press, then ${name} during its confirmation → no write`, async t => {
    const h = setup(t, { html: '<div id="page"><div class="secondary"></div><div class="mainDetailButtons"><button class="je-native-absent-legacy-request" aria-label="Request">Request</button></div></div>' });
    const toggle = h.guard.buildSeerrToggle({ id: 603, title: 'Title' }, 'movie');
    h.document.querySelector('.secondary').append(toggle);
    h.a.initialize();
    Object.defineProperty(h.window, 'innerWidth', { value: 1280, writable: true, configurable: true });
    const row = h.row(); row.getBoundingClientRect = () => ({ width: 2000 });
    h.a.mountRow(row, h.page, h.a.fromKey('movie:tmdb:603')); await settle();
    toggle.click(); await settle();
    assert.equal(h.confirms.length, 1, 'the Guard asks once');
    interrupt(h);
    await ACTIONS.guard.finish(h);
    assert.equal(ACTIONS.guard.none(h), true);
  });
}

test('native guard: with the action bar off, a direct press behaves exactly as without it', async t => {
  const h = setup(t);
  const toggle = h.guard.buildSeerrToggle({ id: 603, title: 'Title' }, 'movie', { detail: true });
  h.row().append(toggle);
  h.a.initialize();
  Object.defineProperty(h.window, 'innerWidth', { value: 1280, writable: true, configurable: true });
  const row = h.row(); row.getBoundingClientRect = () => ({ width: 2000 });
  h.a.mountRow(row, h.page, h.a.fromKey('movie:tmdb:603')); await settle();
  h.featureOff(); await settle();
  toggle.click(); await settle();
  assert.equal(h.confirms.length, 1, 'the owner still asks');
  await ACTIONS.guard.finish(h);
  assert.equal(h.writes.filter(w => w[1] === 'guard-off').length, 1, 'and writes on accept');
});

test('controls: a native guard pressed directly in a current managed row writes once (one listener after remounts)', async t => {
  const h = setup(t);
  const toggle = h.guard.buildSeerrToggle({ id: 603, title: 'Title' }, 'movie', { detail: true });
  h.row().append(toggle);
  Object.defineProperty(h.window, 'innerWidth', { value: 1280, writable: true, configurable: true });
  const row = h.row(); row.getBoundingClientRect = () => ({ width: 2000 });
  const c = h.a.fromKey('movie:tmdb:603');
  h.a.mountRow(row, h.page, c); await settle();
  // Disposed and remounted on the same node: one listener, now owned by the new mount.
  h.featureOff(); h.JE.pluginConfig.NativeAbsentDetailsEnabled = true; h.a.mountRow(row, h.page, c); await settle(); h.a.scan(); await settle();
  toggle.click(); await settle();
  assert.equal(h.confirms.length, 1);
  await ACTIONS.guard.finish(h);
  assert.equal(h.writes.filter(w => w[1] === 'guard-off').length, 1);
});

// The recheck sits right before the write itself, in the owner's one update path, so an accepted write that waits
// behind another one in its owner's queue still stops when the operation goes stale.
test('Guard: accepted, then navigation while the write waits in the Spoiler Guard queue → no DELETE', async t => {
  for (const stale of [true, false]) {
    const h = prepare(t, 'guard'); await settle();
    h.load('enhanced/spoilerguard/ids.js');
    h.load('enhanced/spoilerguard/state.js');
    Object.assign(h.guard, { isTmdbKnown: () => true, isTmdbEnabled: () => true, whenLoaded: async () => {}, bindStateView() {},
      confirmDisableSpoiler: () => { const d = deferred(); h.confirms.push(d); return d.promise; } });
    (await openSheet(h, 'guard')).click(); await settle();
    const busy = h.gate(); h.guard.enableForTmdb('movie', 999, 'Other', h.NATIVE); await settle();
    h.confirms.at(-1).resolve(true); await settle();
    if (stale) h.navigate();
    busy.resolve({}); await settle();
    const deletes = h.calls.filter(([method, path]) => method === 'DELETE' && path.includes('/spoiler-blur/pending/movie/603'));
    assert.equal(deletes.length, stale ? 0 : 1, stale ? 'stale' : 'control');
  }
});

test('Hide: accepted, then navigation while the write waits in the Hidden Content queue → no PUT', async t => {
  for (const stale of [true, false]) {
    const h = prepare(t, 'hide'); await settle();
    (await openSheet(h, 'hide')).click(); await settle();
    const busy = deferred(); h.hidden.enqueuePersistence(() => busy.promise);
    h.document.querySelector('.je-hide-confirm-overlay .je-hide-confirm-hide').click(); await settle();
    if (stale) h.navigate();
    busy.resolve(); await settle();
    assert.equal(h.writes.filter(w => w[1] === 'hide').length, stale ? 0 : 1, stale ? 'stale' : 'control');
  }
});

test('SEC-R2-1: the real Guard dialog refuses its accept after navigation and closes', async t => {
  const h = prepare(t, 'guard'); await settle();
  // The production confirmation (dialog.js), not a stub.
  h.load('enhanced/spoilerguard/dialog.js');
  Object.assign(h.guard, { whenLoaded: async () => {}, getUserPrefs: () => ({}), isDisableSnoozed: () => false, setDisableSnooze: () => h.writes.push(['snooze']) });
  (await openSheet(h, 'guard')).click(); await settle();
  const dialog = h.document.querySelector('.je-spoiler-confirm-dialog');
  assert.ok(dialog);
  h.navigate(); await settle();
  dialog.querySelector('.je-spoiler-confirm-accept').click(); await settle();
  assert.deepEqual(h.writes, []);
});

test('SEC-R2-1: the library Guard (native button in a library row) carries the operation into its confirmation', async t => {
  const pending = deferred();
  const html = `<div id="page"><div class="mainDetailButtons"><button class="btnPlay" title="Play" data-action="resume"></button><button class="btnUserRating" title="Favorite"></button><button class="btnMoreCommands" title="More"></button></div></div>`;
  const h = setup(t, { html, url: 'http://jellyfin.test/web/index.html#/details?id=' + ITEM });
  h.JE.core.ui = { placeDetailAction: (row, button) => row.appendChild(button) };
  h.load('enhanced/spoilerguard/detail-button.js');
  Object.assign(h.guard, { isStateLoaded: () => true, kindOf: () => 'movie', isEnabledForKind: () => true, isKnownForKind: () => true,
    confirmDisableSpoiler: () => pending.promise, disableForMovie: async () => { h.writes.push(['movie-guard-off']); } });
  h.guard.addSpoilerBlurButton(ITEM, h.page, 'Movie');
  Object.defineProperty(h.window, 'innerWidth', { value: 390, writable: true, configurable: true });
  const row = h.row(); row.getBoundingClientRect = () => ({ width: 100 });
  h.a.mountRow(row, h.page, h.a.context({ Id: ITEM, Type: 'Movie', ProviderIds: { Tmdb: '603' }, absent: false })); await settle();
  (await openSheet(h, 'guard')).click(); await settle();
  h.navigate('#/details?id=abcdefabcdefabcdefabcdefabcdefab');
  pending.resolve(true); await settle();
  assert.deepEqual(h.writes, []);
});

// B-R2-1: Open and Share keep working although the sheet closes before they run.
test('B-R2-1: Open from the sheet goes to the actual copy', async t => {
  const h = prepare(t, 'open'); await settle();
  (await openSheet(h, 'open')).click(); await settle();
  assert.deepEqual(h.opened, [['user-a', 'item', ITEM]]);
});

test('B-R2-1: Open from a card\'s sheet (the sheet admits the same title) still goes to the actual copy', async t => {
  const h = setup(t, { html: '<div class="jellyseerr-card"><a data-tmdb-id="603" data-media-type="movie">Title</a></div>', extra: { arrAsk: { enabled: () => false } } });
  h.a.initialize(); h.a.scan();
  h.document.querySelector('.je-card-more').click(); await settle();
  h.document.querySelector('.je-actions-entry[data-action="open"]').click(); await settle();
  assert.deepEqual(h.opened, [['user-a', 'item', ITEM]]);
});

test('B-R2-1: Share from a card\'s sheet still confirms the copy', async t => {
  const h = setup(t, { html: '<div class="jellyseerr-card"><a data-tmdb-id="603" data-media-type="movie">Title</a></div>' });
  h.window.navigator.clipboard = { writeText: async () => {} };
  h.a.initialize(); h.a.scan();
  h.document.querySelector('.je-card-more').click(); await settle();
  h.document.querySelector('.je-actions-entry[data-action="share"]').click(); await settle();
  assert.deepEqual(h.toasts, ['title_actions_copied']);
});

for (const [name, configure, expect] of [
  ['Web Share failure shows the selectable link', h => { h.window.navigator.share = async () => { throw new TypeError('no'); }; }, h => h.document.querySelector('.je-actions-link')],
  ['clipboard success confirms the copy', () => {}, h => h.toasts.includes('title_actions_copied')],
  ['clipboard failure shows the selectable link', h => { h.window.navigator.clipboard = { writeText: async () => { throw new Error('denied'); } }; }, h => h.document.querySelector('.je-actions-link')],
]) {
  test(`B-R2-1: Share: ${name}`, async t => {
    const h = prepare(t, 'share'); await settle();
    configure(h);
    (await openSheet(h, 'share')).click(); await settle();
    assert.ok(expect(h));
    const link = h.document.querySelector('.je-actions-link');
    if (link) assert.equal(link.value, 'http://jellyfin.test/web/index.html#/home?jeTitle=movie%3Atmdb%3A603');
  });
}

// B-R2-2 (Rule 2): a copied compact row, or a copied More inside the live one, never stands in for the tracked node.
for (const [name, copy] of [
  ['the whole compact row copied in place', h => { const live = h.row().querySelector('.je-actions-row'); live.replaceWith(live.cloneNode(true)); }],
  ['the More button copied in place', h => { const live = h.row().querySelector('.je-actions-more'); live.replaceWith(live.cloneNode(true)); }],
]) {
  test(`B-R2-2: ${name} → More still opens the sheet, and the primary still works`, async t => {
    const h = prepare(t, 'request'); await settle();
    copy(h);
    h.a.scan(); await settle();
    assert.equal(h.row().querySelectorAll('.je-actions-row').length, 1);
    assert.equal(h.row().querySelectorAll('.je-actions-more').length, 1);
    h.row().querySelector('.je-actions-more').click(); await settle();
    assert.ok(h.document.querySelector('.je-actions-sheet'), 'More opens');
    escape(h);
    let requested = 0; h.row().querySelector('.je-native-absent-legacy-request').onclick = () => requested++;
    h.row().querySelector('.je-actions-primary').click();
    assert.equal(requested, 1);
  });
}

test('Rule 2: a host copy of a card\'s More beside the live one is removed; the live one keeps working', async t => {
  const h = setup(t, { html: '<div class="jellyseerr-card"><a data-tmdb-id="603" data-media-type="movie">Title</a></div>' });
  h.a.initialize(); h.a.scan();
  const card = h.document.querySelector('.jellyseerr-card'); const live = card.querySelector('.je-card-more');
  card.append(live.cloneNode(true));
  h.a.scan(); await settle();
  assert.deepEqual([...card.querySelectorAll('.je-card-more')], [live]);
  live.click(); await settle();
  assert.ok(h.document.querySelector('.je-actions-sheet'));
});

test('B-R2-2: a host copy of the compact row queues one reconciliation pass by itself', async t => {
  const h = prepare(t, 'request'); await settle();
  const live = h.row().querySelector('.je-actions-row');
  live.replaceWith(live.cloneNode(true));
  await new Promise(resolve => h.window.requestAnimationFrame(resolve)); await settle();
  await new Promise(resolve => h.window.requestAnimationFrame(resolve)); await settle();
  const more = h.row().querySelector('.je-actions-more');
  more.click(); await settle();
  assert.ok(h.document.querySelector('.je-actions-sheet'), 'the copy was replaced without any other DOM change');
});

test('controls: an unchanged compact row keeps its live nodes (focus stays on More)', async t => {
  const h = prepare(t, 'request'); await settle();
  const more = h.row().querySelector('.je-actions-more'); const primary = h.row().querySelector('.je-actions-primary');
  more.focus(); h.a.scan(); await settle(); h.a.scan();
  assert.equal(h.row().querySelector('.je-actions-more'), more);
  assert.equal(h.row().querySelector('.je-actions-primary'), primary);
  assert.equal(h.document.activeElement, more);
});

// Rule 0: on a phone (layout-mobile) the action bar replaces only the native button row.
test('Rule 0: layout-mobile keeps the native header: no page, ribbon or info classes, only the row is compact', async t => {
  const h = setup(t, { html: '<div id="page" class="itemDetailPage"><div class="detailPagePrimaryContainer"><div class="detailRibbon"><div class="infoWrapper"><div class="nameContainer"><h1 class="itemName">Title</h1></div></div><div class="mainDetailButtons"><button class="je-native-absent-legacy-request" aria-label="Request">Request</button></div></div></div></div>' });
  mountAbsent(h, 390); await settle();
  assert.equal(h.row().classList.contains('je-actions-compact'), true);
  assert.equal(h.document.querySelector('.je-actions-phone-page, .je-actions-ribbon, .je-actions-desktop-narrow'), null);
  assert.equal(h.page.className, 'itemDetailPage');
  assert.equal(h.document.querySelector('.detailRibbon').className, 'detailRibbon');
});

test('Rule 0: no injected rule restyles the native header outside desktop-at-narrow-width', async t => {
  const h = setup(t);
  h.a.styles();
  const css = h.document.getElementById('je-title-actions-style').textContent;
  const header = /detailImageContainer|infoWrapper|detailRibbon|detailPagePrimaryContainer|detailPageWrapperContainer|detailPagePrimaryContent|itemName|itemMiscInfo|miscInfo|originalTitle/;
  // Every selector in every rule, media blocks flattened.
  const selectors = css.replace(/@media[^{]*\{/g, '').split('}').map(rule => rule.split('{')[0]).flatMap(s => s.split(',')).map(s => s.trim()).filter(Boolean);
  const offenders = selectors.filter(s => header.test(s) && !s.startsWith('.layout-desktop '));
  assert.deepEqual(offenders, []);
});

test('Rule 0: desktop at narrow width (layout-desktop) gets only its scoped ribbon class', async t => {
  const h = setup(t, { layout: 'layout-desktop', html: '<div id="page" class="itemDetailPage"><div class="detailRibbon"><div class="infoWrapper"></div><div class="mainDetailButtons"><button class="je-native-absent-legacy-request" aria-label="Request">Request</button></div></div></div>' });
  mountAbsent(h, 390); await settle();
  assert.equal(h.document.querySelector('.detailRibbon').classList.contains('je-actions-ribbon'), true);
  h.document.documentElement.className = 'layout-mobile';
  h.window.innerWidth = 391; h.a.scan(); await settle();
  assert.equal(h.document.querySelector('.je-actions-ribbon, .je-actions-phone-page, .je-actions-desktop-narrow'), null, 'never in layout-mobile');
});

// Rule 2b: the primary label is never truncated; the row makes room first.
function emulateLabel(h, needs) {
  // Width the primary label gets: secondaries shrink at <=360px; fit-1 moves Report to More; fit-2 wraps the label.
  const label = h.row().querySelector('.je-actions-primary-label');
  const row = h.row().querySelector('.je-actions-row');
  Object.defineProperty(label, 'scrollWidth', { configurable: true, get: () => row.classList.contains('je-actions-fit-2') ? 0 : needs });
  Object.defineProperty(label, 'clientWidth', { configurable: true, get: () => row.classList.contains('je-actions-fit-1') ? 110 : 80 });
}

for (const [needs, expected] of [[70, []], [100, ['je-actions-fit-1']], [160, ['je-actions-fit-1', 'je-actions-fit-2']]]) {
  test(`Rule 2b: a primary label needing ${needs} px gets ${expected.join(' + ') || 'no change'}; never an ellipsis`, async t => {
    const h = setup(t, { extra: { pluginConfig: { NativeAbsentDetailsEnabled: true, JellyseerrEnabled: true, JellyseerrShowReportButton: true } } });
    h.row().insertAdjacentHTML('beforeend', '<button class="jellyseerr-report-issue-icon" title="Report"></button>');
    mountAbsent(h, 320); await settle();
    emulateLabel(h, needs);
    h.window.innerWidth = 320.5; h.a.scan(); await settle(); h.window.innerWidth = 320; h.a.scan(); await settle();
    const row = h.row().querySelector('.je-actions-row');
    assert.deepEqual([...row.classList].filter(c => c.startsWith('je-actions-fit')), expected);
    if (expected.length) {
      h.row().querySelector('.je-actions-more').click(); await settle();
      assert.ok(h.document.querySelector('.je-actions-entry[data-action="report"]'), 'Report stays reachable in More');
    }
  });
}

// D46S2-R4-2: ended is forever. Leaving the page and coming back (the page kept by the view cache) does not
// revive the operation an open confirmation, or a write queued behind another, belongs to.
// The host's frame callbacks (the reconciliation pass) are held while away and run after coming back, as for a
// retained card: nothing re-scans the page meanwhile, so no cell can pass by a timing accident.
const awayAndBack = async h => {
  const delivered = async () => { await new Promise(resolve => setTimeout(resolve, 0)); await settle(); };
  const frame = h.window.requestAnimationFrame; const held = [];
  // A pass already queued runs first, on the page, before leaving.
  await new Promise(resolve => frame.call(h.window, resolve)); await settle();
  h.window.requestAnimationFrame = fn => held.push(fn);
  try {
    h.navigate(); await delivered();
    h.navigate('#/details?id=x'); await delivered();
  } finally { h.window.requestAnimationFrame = frame; held.forEach(fn => frame.call(h.window, fn)); }
  await delivered();
};

for (const id of ['guard', 'hide', 'report']) {
  test(`${id}: away and back while its confirmation is open → accepting writes nothing`, async t => {
    const h = prepare(t, id); await settle();
    (await openSheet(h, id)).click(); await settle();
    await awayAndBack(h);
    await ACTIONS[id].finish(h);
    assert.equal(ACTIONS[id].none(h), true, id);
  });
}

test('Guard: accepted, then away and back while the write waits in the Spoiler Guard queue → no DELETE', async t => {
  const h = prepare(t, 'guard'); await settle();
  h.load('enhanced/spoilerguard/ids.js');
  h.load('enhanced/spoilerguard/state.js');
  Object.assign(h.guard, { isTmdbKnown: () => true, isTmdbEnabled: () => true, whenLoaded: async () => {}, bindStateView() {},
    confirmDisableSpoiler: () => { const d = deferred(); h.confirms.push(d); return d.promise; } });
  (await openSheet(h, 'guard')).click(); await settle();
  const busy = h.gate(); h.guard.enableForTmdb('movie', 999, 'Other', h.NATIVE); await settle();
  h.confirms.at(-1).resolve(true); await settle();
  await awayAndBack(h);
  busy.resolve({}); await settle();
  assert.equal(h.calls.filter(([method, path]) => method === 'DELETE' && path.includes('/spoiler-blur/pending/movie/603')).length, 0);
});

test('Hide: accepted, then away and back while the write waits in the Hidden Content queue → no PUT', async t => {
  for (const stale of [true, false]) {
    const h = prepare(t, 'hide'); await settle();
    (await openSheet(h, 'hide')).click(); await settle();
    const confirm = h.document.querySelector('.je-hide-confirm-overlay .je-hide-confirm-hide');
    assert.ok(confirm, 'Hide asks first');
    const busy = deferred(); h.hidden.enqueuePersistence(() => busy.promise);
    confirm.click(); await settle();
    if (stale) await awayAndBack(h);
    // The queued write gets every chance to go out before counting (the control's does).
    busy.resolve(); for (let i = 0; i < 3; i++) { await new Promise(resolve => setTimeout(resolve, 0)); await settle(); }
    assert.equal(h.writes.filter(w => w[1] === 'hide').length, stale ? 0 : 1, stale ? 'stale' : 'control');
  }
});

test('the real Guard dialog refuses its accept after away and back and closes', async t => {
  const h = prepare(t, 'guard'); await settle();
  h.load('enhanced/spoilerguard/dialog.js');
  Object.assign(h.guard, { whenLoaded: async () => {}, getUserPrefs: () => ({}), isDisableSnoozed: () => false, setDisableSnooze: () => h.writes.push(['snooze']) });
  (await openSheet(h, 'guard')).click(); await settle();
  const dialog = h.document.querySelector('.je-spoiler-confirm-dialog');
  assert.ok(dialog);
  await awayAndBack(h);
  dialog.querySelector('.je-spoiler-confirm-accept')?.click(); await settle();
  assert.deepEqual(h.writes, []);
});

// D46 slice 2 review round 5 (shape 1): a confirmation opened for an operation is in its scope, so it closes when
// the operation ends, even untouched (nothing outlives its operation).
for (const id of ['guard', 'hide']) {
  test(`scope: the ${id === 'guard' ? 'real Guard dialog' : 'Hide confirmation'} closes when its row re-renders, untouched`, async t => {
    const h = prepare(t, id); await settle();
    if (id === 'guard') {
      h.load('enhanced/spoilerguard/dialog.js');
      Object.assign(h.guard, { whenLoaded: async () => {}, getUserPrefs: () => ({}), isDisableSnoozed: () => false, setDisableSnooze: () => h.writes.push(['snooze']) });
    }
    (await openSheet(h, id)).click(); await settle();
    const surface = h.document.querySelector(id === 'guard' ? '.je-spoiler-confirm-dialog' : '.je-hide-confirm-overlay');
    assert.ok(surface, 'the owner asks first');
    const clone = cloneRow(h); h.a.mountRow(clone, h.page, h.a.fromKey('movie:tmdb:603')); h.a.scan(); await settle();
    assert.equal(surface.isConnected, false, 'the confirmation did not outlive its operation');
    assert.deepEqual(h.writes, []);
  });
}
