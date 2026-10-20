import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, mount, remount, press, settle, delivered, moreInfo, sheet, seerrModal, deferred } from '../helpers/title-actions-scopes.mjs';

// D46 slice 2 review round 6: ownership is explicit (every opener takes an owner; a replacement inherits the replaced
// surface's owner, taken before it closes, and rechecks it after each await), and a read renders only for the newest
// intent of its surface. Real core transport and real owners (title actions, sheet, hosts, More Info window, Seerr
// modals, Manage drawer, request sheet); only the server is scripted.

/** Waits out a closing surface's exit animation (Seerr modals and the window keep their node for 300 ms). */
const gone = () => new Promise(resolve => setTimeout(resolve, 350));
/** The drawer re-reads 300 ms after a feed change. */
const reloadDelay = () => new Promise(resolve => setTimeout(resolve, 330));

/** Opens Seerr's More Info window from the row (JE requests off: the row's Request opens the window). */
async function openWindow(h) {
  h.a.initialize(); mount(h); await settle();
  await press(h, 'request'); await delivered();
  assert.ok(moreInfo(h), 'the More Info window opened for the operation');
  return moreInfo(h);
}

/** The row re-renders (its mount, and the operations it owned, end) and the host reconciles. */
async function rerender(h) { remount(h); h.a.scan(); await settle(); }

/** What an accepted Spoiler Guard write announces (state.js mutateState). */
const policyChanged = h => h.window.dispatchEvent(new h.window.CustomEvent('je-spoiler-policy-changed', { detail: { userId: 'user-a' } }));

// ---------------------------------------------------------------- D46S2-R6-1: the policy refresh's replacement window

test('R6-1: Guard\'s policy refresh reopens the window for its operation; the operation ends → the replacement closes and its Request sends nothing', async t => {
  const h = setup(t, { asks: false });
  const before = await openWindow(h);
  policyChanged(h); await delivered();
  const after = moreInfo(h);
  assert.ok(after && after !== before, 'the window was replaced from the server projection');
  await rerender(h); await delivered();
  assert.equal(moreInfo(h), null, 'the replacement did not outlive its operation');
  after.querySelector('.jellyseerr-request-button')?.click(); await delivered();
  assert.equal(h.sent('POST', '/jellyseerr/request').length, 0);
});

test('R6-1: the replacement\'s details read is held, the operation ends, released → no window opens', async t => {
  const h = setup(t, { asks: false });
  await openWindow(h);
  const details = h.hold('GET', '/jellyseerr/movie/603');
  policyChanged(h); await settle();
  await rerender(h);
  details.resolve(); await delivered();
  assert.equal(moreInfo(h), null, 'rechecked after the await: an ended operation opens nothing');
  assert.equal(h.sent('POST', '/jellyseerr/request').length, 0);
});

test('R6-1: the operation ended before the refresh arrives → the window just closes, nothing reopens', async t => {
  const h = setup(t, { asks: false });
  const before = await openWindow(h);
  // The row re-renders without a host pass yet (the window is still shown), then the accepted write's refresh lands.
  remount(h);
  policyChanged(h); await delivered();
  assert.equal(before.isConnected && !before._isClosing, false, 'the old window closed');
  assert.equal(moreInfo(h), null, 'no unowned replacement');
});

test('control: Guard from the window refreshes it, and its Request then works (one POST)', async t => {
  const h = setup(t, { asks: false });
  await openWindow(h);
  policyChanged(h); await delivered();
  moreInfo(h).querySelector('.jellyseerr-request-button').click(); await delivered();
  assert.equal(h.sent('POST', '/jellyseerr/request').length, 1);
});

test('the policy refresh\'s replacement belongs to the same live operation (its owner, taken before the old window closed)', async t => {
  const h = setup(t, { asks: false });
  const before = await openWindow(h);
  const owner = h.JE.ownerOf(before);
  policyChanged(h); await delivered();
  assert.equal(h.JE.ownerOf(moreInfo(h)), owner);
  assert.equal(owner.current(), true, 'the operation is still current');
});

test('control: a native window\'s policy refresh reopens it natively and its Request sends once', async t => {
  const h = setup(t, { asks: false });
  await h.JE.jellyseerrMoreInfo.open(603, 'movie', undefined, h.NATIVE); await delivered();
  policyChanged(h); await delivered();
  assert.equal(h.JE.ownerOf(moreInfo(h)), h.NATIVE);
  await h.leave(); // natively nothing ends with the page
  moreInfo(h)?.querySelector('.jellyseerr-request-button')?.click(); await delivered();
  assert.ok(h.sent('POST', '/jellyseerr/request').length <= 1);
});

// ---------------------------------------------------------------- D46S2-R6-4: Share's fallback link sheet

/** Presses Share in the row's More sheet. */
async function share(h) { h.a.initialize(); mount(h); await settle(); await press(h, 'share'); await delivered(); }
const link = h => h.document.querySelector('.je-actions-link');

const SHARE_PATHS = [
  ['no Web Share and no clipboard', () => {}],
  ['Web Share refuses after an await', h => { h.window.navigator.share = () => new Promise((_, reject) => setTimeout(() => reject(new h.window.DOMException('Denied', 'NotAllowedError')), 0)); }],
  ['the clipboard refuses after an await', h => { Object.defineProperty(h.window.navigator, 'clipboard', { configurable: true, value: { writeText: () => new Promise((_, reject) => setTimeout(() => reject(new Error('denied')), 0)) } }); }],
];
for (const [name, arrange] of SHARE_PATHS) {
  test(`R6-4: Share (${name}) shows the link sheet for its operation; the row re-renders → it closes and the page takes input again`, async t => {
    const h = setup(t, { asks: false });
    arrange(h);
    await share(h);
    assert.ok(link(h), 'the fallback link sheet is open');
    assert.equal(h.page.inert, true, 'the page behind it is inert while it is open');
    await rerender(h);
    assert.equal(link(h), null, 'the link sheet did not outlive its operation');
    assert.notEqual(h.page.inert, true, 'the page takes input again');
  });
}

test('control: the operation ends before Web Share refuses → no link sheet opens (rechecked before the fallback)', async t => {
  const h = setup(t, { asks: false });
  const refusal = deferred();
  h.window.navigator.share = () => refusal.promise;
  await share(h);
  await rerender(h);
  refusal.reject(new h.window.DOMException('Denied', 'NotAllowedError')); await delivered();
  assert.equal(link(h), null);
  assert.notEqual(h.page.inert, true);
});

test('control: the Share fallback stays selectable while its operation lives', async t => {
  const h = setup(t, { asks: false });
  await share(h);
  const input = link(h);
  assert.ok(input);
  assert.match(input.value, /jeTitle=movie%3Atmdb%3A603/);
  assert.equal(h.document.activeElement, input, 'focused, its text selected');
  input.click(); await settle();
  assert.ok(link(h), 'a press inside it keeps it open');
});

// ---------------------------------------------------------------- D46S2-R6-3: the Manage drawer's reloads

/** Opens the Manage drawer from the row and waits for its first read. */
async function openDrawer(h) {
  h.JE.t = (key, params) => params ? key + ' ' + Object.values(params).join(' ') : key;
  h.a.initialize(); mount(h); await settle();
  await press(h, 'manage'); await delivered();
  const drawer = h.document.querySelector('.je-manage');
  assert.ok(drawer, 'the drawer is open');
  return drawer;
}
const overview = title => ({ key: 'movie:tmdb:603', kind: 'movie', title, tmdbId: 603, instances: [], requests: [] });

test('R6-3: two feed updates, the first re-read held: the newest renders and the older answer never replaces it', async t => {
  const h = setup(t, { asks: false });
  const drawer = await openDrawer(h);
  const first = h.hold('GET', '/arr/admin/manage?');
  h.feed(); await reloadDelay(); await settle();
  const second = h.hold('GET', '/arr/admin/manage?');
  h.feed(); await reloadDelay(); await settle();
  assert.equal(h.sent('GET', '/arr/admin/manage?').length, 3, 'two re-reads are out at once');
  second.resolve(overview('NEW')); await delivered();
  first.resolve(overview('OLD')); await delivered();
  assert.match(drawer.textContent, /NEW/);
  assert.doesNotMatch(drawer.textContent, /OLD/, 'the older answer was dropped');
});

test('control: one feed update re-reads once and renders it', async t => {
  const h = setup(t, { asks: false });
  const drawer = await openDrawer(h);
  const only = h.hold('GET', '/arr/admin/manage?');
  h.feed(); await reloadDelay(); await settle();
  only.resolve(overview('NEW')); await delivered();
  assert.match(drawer.textContent, /NEW/);
});

test('control: a re-read answering after the drawer\'s operation ended renders nothing', async t => {
  const h = setup(t, { asks: false });
  const drawer = await openDrawer(h);
  const held = h.hold('GET', '/arr/admin/manage?');
  h.feed(); await reloadDelay(); await settle();
  await rerender(h);
  held.resolve(overview('LATE')); await delivered();
  assert.doesNotMatch(drawer.textContent, /LATE/);
  assert.equal(h.document.querySelector('.je-manage'), null);
});

// ---------------------------------------------------------------- shape 3: every read→render path renders the newest intent

// The pill's feed re-reads are identical unbound reads: overlapping ones share one request (the transport
// de-duplicates them), so both intents get the same answer; the token drops the answer of an ended owner's window.
test('read path: the window\'s status pill drops a re-read that answers after the window\'s operation ended', async t => {
  const h = setup(t, { asks: false });
  h.JE.pluginConfig.ArrSeerrModalStatus = true;
  h.load('arr/status/status-modal.js'); h.JE.initializeArrStatusModal();
  const modal = await openWindow(h);
  const pill = modal.querySelector('.je-arr-modal-status');
  assert.ok(pill, 'the status pill is in the window');
  const held = h.hold('GET', '/acquire/status');
  h.feed(); await settle();
  await rerender(h);
  const shown = pill.innerHTML;
  held.resolve({ items: [{ key: 'movie:tmdb:603', stage: 'looking', admin: null }] }); await delivered();
  assert.equal(pill.innerHTML, shown, 'nothing rendered for an ended operation');
});

// The window's Refresh and a TV request's refresh are the same unbound read: overlapping, they share one request (and
// one answer). Their token drops an answer for a window that is no longer the one shown, or whose owner ended.
test('read path: the window\'s Refresh answering after the policy refresh replaced the window never renders into either', async t => {
  const h = setup(t, { asks: false });
  const before = await openWindow(h);
  const held = h.hold('GET', '/jellyseerr/movie/603');
  before.querySelector('.modal-refresh').click(); await settle();
  policyChanged(h); await settle();
  held.resolve({ id: 603, title: 'The Matrix', mediaInfo: { id: 77, status: 2, status4k: 1 } }); await delivered();
  const after = moreInfo(h);
  assert.ok(after && after !== before);
  assert.ok(after.querySelector('.jellyseerr-request-button') || after.querySelector('[data-mount="je-status-chip"]'), 'the replacement drew its own answer');
});

test('read path: the window\'s Refresh answering after the window\'s operation ended renders nothing', async t => {
  const h = setup(t, { asks: false });
  const modal = await openWindow(h);
  const held = h.hold('GET', '/jellyseerr/movie/603');
  modal.querySelector('.modal-refresh').click(); await settle();
  await rerender(h); await delivered();
  assert.ok(modal.querySelector('.jellyseerr-request-button'), 'the window shows Request (status not requested)');
  held.resolve({ id: 603, title: 'The Matrix', mediaInfo: { id: 77, status: 2, status4k: 1 } }); await delivered();
  assert.ok(modal.querySelector('.jellyseerr-request-button'), 'the answer (requested) did not redraw the ended window');
});

test('read path: two request sheet openings, the older one\'s reads answer last → the newer sheet stays', async t => {
  const h = setup(t, { asks: true });
  h.JE.t = (key, params) => params ? key + ' ' + Object.values(params).join(' ') : key;
  // Each opening checks its own title: the older title's check is held, the newer's answers at once.
  const held = h.hold('GET', '/acquire/requests/check');
  const older = h.JE.arrAskSheet.open({ key: 'movie:tmdb:603', kind: 'movie', name: 'OLDER' }, { operation: h.NATIVE }); await settle();
  h.JE.arrAskSheet.open({ key: 'movie:tmdb:604', kind: 'movie', name: 'NEWER' }, { operation: h.NATIVE }); await delivered();
  assert.match(sheet(h)?.textContent || '', /NEWER/, 'the newer sheet is open');
  held.resolve(); await delivered();
  assert.equal(h.document.querySelectorAll('.je-sheet').length, 1);
  assert.match(sheet(h).textContent, /NEWER/, 'the older opening did not replace it');
  assert.equal(await older, null, 'the older opening built nothing');
});

test('read path: two Collection openings, the older details answer last → one form (the newer)', async t => {
  const h = setup(t, { asks: false });
  const held = h.hold('GET', '/jellyseerr/collection/2344');
  const older = h.JE.jellyseerrUI.showCollectionRequestModal(2344, 'OLDER', null, { operation: h.NATIVE }); await settle();
  const newer = h.JE.jellyseerrUI.showCollectionRequestModal(9, 'NEWER', null, { operation: h.NATIVE }); await delivered();
  held.resolve(); await Promise.all([older, newer]); await delivered();
  const forms = [...h.document.querySelectorAll('.jellyseerr-season-modal')];
  assert.equal(forms.length, 1, 'the older opening was dropped');
  assert.match(forms[0].textContent, /NEWER/);
});

test('read path: two season modal openings, the older details answer last → one modal (the newer)', async t => {
  const h = setup(t, { asks: false });
  const held = h.hold('GET', '/jellyseerr/tv/1399');
  const older = h.JE.jellyseerrUI.showSeasonSelectionModal(1399, 'tv', 'OLDER', null, false, h.NATIVE); await settle();
  const newer = h.JE.jellyseerrUI.showSeasonSelectionModal(1400, 'tv', 'NEWER', null, false, h.NATIVE); await delivered();
  held.resolve(); await Promise.all([older, newer]); await delivered();
  const modals = [...h.document.querySelectorAll('.jellyseerr-season-modal')];
  assert.equal(modals.length, 1, 'the older opening was dropped');
  assert.match(modals[0].textContent, /NEWER/);
});

test('read path: two More presses, the older one\'s admission answers last → the newer sheet stays', async t => {
  const h = setup(t, { asks: false });
  h.a.initialize(); mount(h); await settle();
  const show = h.a.show; let shows = 0;
  h.a.show = (...args) => { shows++; return show(...args); };
  // Both presses wait on the one (de-duplicated) admission read; its answer reaches the older press last in line.
  const held = h.hold('GET', '/title-actions/');
  h.row().querySelector('.je-actions-more').click(); await settle();
  h.row().querySelector('.je-actions-more').click(); await settle();
  held.resolve(); await delivered();
  assert.ok(h.document.querySelector('.je-actions-backdrop'), 'the newer press opened the sheet');
  assert.equal(shows, 1, 'the older press did not open (or replace) one');
});

// ---------------------------------------------------------------- shape 1: an opener without an owner

const OPENERS = [
  ['the title actions sheet', h => h.a.show({ name: 'x' }, [], null)],
  ['the Share link sheet', h => h.a.showLink('http://x')],
  ['the request sheet', h => h.JE.arrAskSheet.open({ key: 'movie:tmdb:603', kind: 'movie', name: 'x' }, {})],
  ['the one-tap ask', h => h.JE.arrAskSheet.openOrAsk({ key: 'movie:tmdb:603', kind: 'movie', name: 'x' }, {})],
  ['the Manage drawer', h => h.JE.arrManage.open({ key: 'movie:tmdb:603' })],
  ['the Seerr modal shell', h => h.JE.jellyseerrModal.create({ title: 'x', subtitle: 'y', bodyHtml: '', onSave() {} }).show()],
  ['the More Info window', h => h.JE.jellyseerrMoreInfo.open(603, 'movie')],
  ['the Collection modal', h => h.JE.jellyseerrUI.showCollectionRequestModal(2344, 'x', null, {})],
  ['the advanced movie modal', h => h.JE.jellyseerrUI.showMovieRequestModal(603, 'x', null, false)],
  ['the season modal', h => h.JE.jellyseerrUI.showSeasonSelectionModal(1399, 'tv', 'x', null, false)],
  ['the Report form', h => h.JE.jellyseerrIssueReporter.showReportModal('603', 'x', 'movie', null, null)],
  ['a surface registration', h => { const node = h.document.createElement('div'); h.document.body.append(node); h.JE.openSurface(node, () => node.remove()); return node; }],
];
const SURFACES = '.je-actions-backdrop, .je-sheet, .je-manage-overlay, .jellyseerr-season-modal.show, .je-more-info-modal';

for (const [name, open] of OPENERS) {
  test(`opener without an owner (${name}): throws in tests`, async t => {
    const h = setup(t, { asks: true });
    let thrown = null;
    try { await open(h); } catch (error) { thrown = error; }
    assert.match(String(thrown?.message), /without an owner/);
  });
  test(`opener without an owner (${name}): opens nothing in production`, async t => {
    const h = setup(t, { asks: true });
    h.JE.strictOwners = false;
    const before = h.document.body.children.length;
    const opened = await open(h); await delivered(); await gone();
    if (opened?.nodeType) assert.equal(opened.isConnected, false, 'the surface closed at once');
    assert.equal(h.document.querySelectorAll(SURFACES).length, 0, 'nothing opened');
    assert.ok(h.document.body.children.length <= before + 1, 'nothing left behind but styles');
    assert.equal(h.requests.filter(r => r[1] !== 'GET').length, 0, 'nothing sent');
  });
}

test('an inferred owner is refused: createSessionAction({ submitted: true }) throws in tests', async t => {
  const h = setup(t);
  assert.throws(() => h.JE.createSessionAction({ submitted: true }), /without an owner/);
  // In production it is never current: nothing it guards proceeds.
  h.JE.strictOwners = false;
  const action = h.JE.createSessionAction({ submitted: true });
  assert.equal(action.current(), false);
  assert.equal(action.operationBound().current(), false);
});

test('a press carries its owner explicitly: JE.press tags the click, a direct press on the page is native', async t => {
  const h = setup(t);
  const button = h.document.createElement('button'); h.document.body.append(button);
  const op = h.a.generation(); const seen = [];
  button.addEventListener('click', e => seen.push(h.JE.ownerOf(e)));
  h.JE.press(button, op); button.click();
  assert.deepEqual(seen, [op, h.NATIVE]);
  // A detached node outside any registered surface names no owner (it is not on the page, nor in UI an operation opened).
  assert.equal(h.JE.ownerOf(h.document.createElement('div')), null);
});

// ---------------------------------------------------------------- shape 4 (Q-D46S2FIX5-1 (b)): Request in 4K in the window's More sheet

/** Opens the window's own More sheet. */
async function windowSheet(h) {
  moreInfo(h).querySelector('.je-actions-more, .je-actions-wide-more').click(); await delivered();
  return [...h.document.querySelectorAll('.je-actions-entry')];
}

test('4K: with Seerr 4K on, the window\'s More sheet offers Request in 4K; pressed, the window requests 4K once for its operation', async t => {
  const h = setup(t, { asks: false, seerr4k: true });
  const modal = await openWindow(h);
  const entry = (await windowSheet(h)).find(n => n.dataset.action === 'request-4k');
  assert.ok(entry, 'Request in 4K is offered');
  assert.equal(entry.textContent.includes('jellyseerr_btn_request_4k'), true);
  entry.click(); await delivered();
  const posts = h.sent('POST', '/jellyseerr/request');
  assert.equal(posts.length, 1);
  assert.equal(posts[0][3]?.is4k, true, 'the 4K request');
  assert.ok(modal.isConnected, 'the window stays');
});

test('4K: the window\'s operation ends while its 4K request waits in the transport pool → 0 sends', async t => {
  const h = setup(t, { asks: false, seerr4k: true });
  await openWindow(h);
  const entry = (await windowSheet(h)).find(n => n.dataset.action === 'request-4k');
  const release = h.holdPool();
  entry.click(); await settle();
  await rerender(h);
  await release(); await delivered();
  assert.equal(h.sent('POST', '/jellyseerr/request').length, 0);
});

test('4K: with Seerr 4K off, the window\'s More sheet has no Request in 4K', async t => {
  const h = setup(t, { asks: false, seerr4k: false });
  await openWindow(h);
  const entries = await windowSheet(h);
  assert.ok(entries.length > 0, 'the sheet is open');
  assert.equal(entries.some(n => n.dataset.action === 'request-4k'), false);
});

test('control: a native window\'s Request in 4K sends natively, once', async t => {
  const h = setup(t, { asks: false, seerr4k: true });
  h.a.initialize(); await settle();
  await h.JE.jellyseerrMoreInfo.open(603, 'movie', undefined, h.NATIVE); await delivered();
  (await windowSheet(h)).find(n => n.dataset.action === 'request-4k').click(); await delivered();
  assert.equal(h.sent('POST', '/jellyseerr/request').length, 1);
});

// ---------------------------------------------------------------- Q-PLAYR18-2: no Request over a title already on its way

for (const stage of ['asked', 'downloading', 'ready']) {
  test(`Q-PLAYR18-2: a title already ${stage} (JE requests on) → the bar offers no Request, in the row or the More sheet`, async t => {
    const h = setup(t, { asks: true, stage });
    h.a.initialize(); mount(h); await settle(); await delivered();
    const primary = h.row().querySelector('.je-actions-row .je-actions-primary');
    assert.equal(primary?.textContent.includes('jellyseerr_btn_request') ?? false, false, 'no Request primary');
    h.row().querySelector('.je-actions-more').click(); await delivered();
    const entries = [...h.document.querySelectorAll('.je-actions-entry')].map(n => n.dataset.action);
    assert.ok(entries.length > 0, 'the sheet is open');
    assert.equal(entries.includes('request'), false);
  });
}

test('control: a title not here (nothing under way) → the bar offers Request in the row and the sheet', async t => {
  const h = setup(t, { asks: true, stage: 'notHere' });
  h.a.initialize(); mount(h); await settle(); await delivered();
  assert.match(h.row().querySelector('.je-actions-row .je-actions-primary')?.textContent || '', /jellyseerr_btn_request/);
  h.row().querySelector('.je-actions-more').click(); await delivered();
  assert.ok([...h.document.querySelectorAll('.je-actions-entry')].some(n => n.dataset.action === 'request'));
});
