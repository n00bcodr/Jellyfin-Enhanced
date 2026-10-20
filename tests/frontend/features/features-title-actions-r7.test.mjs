import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, mount, remount, press, settle, delivered, moreInfo, seerrModal } from '../helpers/title-actions-scopes.mjs';

// D46 slice 2 review round 7. Shapes: (1) the press is the only owner source in a handler: a control the bar presses
// takes its owner from the tagged press (JE.ownerOf(event)) and passes it to everything it opens or sends, so a window
// opened natively does not turn the bar's operation into a native one; (2) what a write publishes after its await
// (the window's chips and re-render, toasts) appears only while the window it started in, its owner and its intent
// are current; (3) host dialogs (the quota dialog's Dashboard.alert) are openers: owned, rechecked after their read,
// closed with their owner; (5) UI state is reconciled: the row's Request follows the newest status, busy states clear
// in `finally`. Real core transport and real owners; only the server is scripted.

/** Waits out a closing surface's exit animation (Seerr modals and the window keep their node for 300 ms). */
const gone = () => new Promise(resolve => setTimeout(resolve, 350));
/** Seerr modals show 10 ms after they open. */
const shown = () => new Promise(resolve => setTimeout(resolve, 30));
const posts = h => h.sent('POST', '/jellyseerr/request');

/** Opens Seerr's More Info window natively (a search card, a hub entry: no title action), at phone width. */
async function nativeWindow(h, id = 603, type = 'movie') {
  Object.defineProperty(h.window, 'innerWidth', { value: 100, writable: true, configurable: true });
  h.a.initialize(); await settle();
  await h.JE.jellyseerrMoreInfo.open(id, type, undefined, h.JE.NATIVE); await delivered();
  h.a.scan(); await delivered();
  assert.ok(moreInfo(h), 'the window opened');
  return moreInfo(h);
}

/** The bar's Request in the window's compact row (it presses the window's own Request for its operation). */
const barRequest = h => moreInfo(h).querySelector('.je-actions-row .je-actions-primary');

/**
 * The window's action row re-renders (its mount is replaced): the bar's operations in it end. Unlike leaving the page
 * (Seerr's forms close on any history step natively too), nothing else closes the forms the operation opened.
 */
async function rerenderWindowRow(h) {
  const mount = moreInfo(h).querySelector('[data-mount="je-actions"]');
  mount.replaceWith(mount.cloneNode(true));
  h.a.scan(); await delivered();
}

/** Opens the window's own More sheet and returns its entries. */
async function windowSheet(h) {
  moreInfo(h).querySelector('.je-actions-more, .je-actions-wide-more').click(); await delivered();
  return [...h.document.querySelectorAll('.je-actions-entry')];
}

// ---------------------------------------------------------------- D46S2-R7-1: the press, not the node, owns what follows

test('R7-1: the bar\'s Request inside a natively opened window, then leave while the request waits → 0 sends', async t => {
  const h = setup(t, { asks: false, seerr4k: true });
  await nativeWindow(h);
  const release = h.holdPool();
  barRequest(h).click(); await settle();
  await h.leave();
  await release(); await delivered();
  assert.equal(posts(h).length, 0, 'the bar\'s operation ended: its request is never sent');
});

test('R7-1: the More sheet\'s Request in 4K inside a natively opened window, then leave → 0 sends', async t => {
  const h = setup(t, { asks: false, seerr4k: true });
  await nativeWindow(h);
  const entry = (await windowSheet(h)).find(n => n.dataset.action === 'request-4k');
  assert.ok(entry, 'Request in 4K is offered');
  // The run's admission answers while every transport slot is busy: its 4K request waits in the pool.
  const admission = h.hold('GET', '/title-actions/');
  entry.click(); await settle();
  const release = h.holdPool();
  admission.resolve(); await settle();
  await h.leave();
  await release(); await delivered();
  assert.equal(posts(h).length, 0);
});

test('R7-1: advanced on, the bar\'s Request inside a natively opened window opens the form for its operation; the row re-renders → the form closes, nothing sent', async t => {
  const h = setup(t, { asks: false, seerr4k: true, advanced: true });
  await h.JE.jellyseerrAPI.checkUserStatus(); // the cached status the advanced switch reads
  await nativeWindow(h);
  barRequest(h).click(); await delivered(); await shown();
  assert.ok(seerrModal(h)?.classList.contains('show'), 'the advanced form opened');
  await rerenderWindowRow(h); await gone();
  assert.equal(h.document.querySelector('.jellyseerr-season-modal.show'), null, 'the form did not outlive the operation');
  assert.equal(posts(h).length, 0);
});

test('R7-1: advanced on, Request in 4K from the More sheet of a natively opened window; the row re-renders → the 4K form closes', async t => {
  const h = setup(t, { asks: false, seerr4k: true, advanced: true });
  await h.JE.jellyseerrAPI.checkUserStatus();
  await nativeWindow(h);
  (await windowSheet(h)).find(n => n.dataset.action === 'request-4k').click(); await delivered(); await shown();
  assert.ok(seerrModal(h)?.classList.contains('show'), 'the 4K form opened');
  await rerenderWindowRow(h); await gone();
  assert.equal(h.document.querySelector('.jellyseerr-season-modal.show'), null);
});

test('R7-1: TV, the bar\'s Request inside a natively opened window opens the season form for its operation; the row re-renders → closed', async t => {
  const h = setup(t, { asks: false, seerr4k: false });
  await nativeWindow(h, 1399, 'tv');
  barRequest(h).click(); await delivered(); await shown();
  assert.ok(seerrModal(h)?.classList.contains('show'), 'the season form opened');
  await rerenderWindowRow(h); await gone();
  assert.equal(h.document.querySelector('.jellyseerr-season-modal.show'), null);
});

test('R7-1: a press dispatched for an operation on the window\'s Collection button opens the Collection form for that operation', async t => {
  const h = setup(t, { asks: false });
  await nativeWindow(h);
  const button = moreInfo(h).querySelector('.je-collection-card-button');
  assert.ok(button, 'the window offers its Collection');
  const operation = h.a.generation();
  h.JE.press(button, operation); await delivered(); await shown();
  assert.ok(seerrModal(h)?.classList.contains('show'), 'the Collection form opened');
  assert.equal(h.JE.ownerOf(seerrModal(h)), operation, 'it is the pressing operation\'s');
});

test('control: the window\'s own Request pressed directly (natively) sends once, also after leaving', async t => {
  const h = setup(t, { asks: false, seerr4k: true });
  const modal = await nativeWindow(h);
  const release = h.holdPool();
  modal.querySelector('.jellyseerr-split-main').click(); await settle();
  await h.leave();
  await release(); await delivered();
  assert.equal(posts(h).length, 1, 'a native press is native');
});

test('control: the bar\'s Request inside a natively opened window, staying → one send', async t => {
  const h = setup(t, { asks: false, seerr4k: true });
  await nativeWindow(h);
  barRequest(h).click(); await delivered();
  assert.equal(posts(h).length, 1);
  assert.notEqual(posts(h)[0][3]?.is4k, true);
});

test('control: Request in 4K from the More sheet of a natively opened window, staying → one 4K send', async t => {
  const h = setup(t, { asks: false, seerr4k: true });
  await nativeWindow(h);
  (await windowSheet(h)).find(n => n.dataset.action === 'request-4k').click(); await delivered();
  assert.equal(posts(h).length, 1);
  assert.equal(posts(h)[0][3]?.is4k, true);
});

// ---------------------------------------------------------------- D46S2-R7-3: a write publishes into its own window only

test('R7-3: Request in 4K answers after the window was replaced by another title → the new window gets no chip or controls of the old title', async t => {
  const h = setup(t, { asks: false, seerr4k: true });
  await nativeWindow(h);
  const held = h.hold('POST', '/jellyseerr/request');
  (await windowSheet(h)).find(n => n.dataset.action === 'request-4k').click(); await settle();
  await h.JE.jellyseerrMoreInfo.open(1399, 'tv', undefined, h.JE.NATIVE); await delivered();
  const tv = moreInfo(h);
  assert.equal(tv.dataset.tmdbId, '1399');
  const chips = tv.querySelector('[data-mount="je-status-chip"]').innerHTML;
  held.resolve(); await delivered();
  assert.equal(posts(h).length, 1, 'the request itself was sent');
  assert.equal(tv.querySelector('[data-mount="je-status-chip"]').innerHTML, chips, 'no chip of the movie in the TV window');
  assert.equal(tv.querySelector('[data-tmdb-id="603"]'), null, 'no movie controls in the TV window');
});

test('R7-3: the window\'s own Request answers after the window was replaced → nothing of it in the new window', async t => {
  const h = setup(t, { asks: false, seerr4k: false });
  const modal = await nativeWindow(h);
  const held = h.hold('POST', '/jellyseerr/request');
  modal.querySelector('.jellyseerr-request-button').click(); await settle();
  await h.JE.jellyseerrMoreInfo.open(1399, 'tv', undefined, h.JE.NATIVE); await delivered();
  const tv = moreInfo(h);
  held.resolve(); await delivered();
  assert.equal(tv.querySelector('[data-tmdb-id="603"]'), null);
  assert.equal(tv.querySelector('[data-mount="je-status-chip"]').textContent.trim(), '');
});

test('R7-3: a write answering after a newer Refresh of the same window rendered does not draw its older state over it', async t => {
  const h = setup(t, { asks: false, seerr4k: false });
  const modal = await nativeWindow(h);
  const held = h.hold('POST', '/jellyseerr/request');
  modal.querySelector('.jellyseerr-request-button').click(); await settle();
  const read = h.hold('GET', '/jellyseerr/movie/603');
  h.manager.clearCache(); // a Refresh within the details' cache time answers from it
  modal.querySelector('.modal-refresh').click(); await settle();
  // The Refresh (the newer intent) answers first: the title is here now.
  read.resolve({ id: 603, title: 'The Matrix', mediaInfo: { id: 77, status: 5, status4k: 1, jellyfinMediaId: 'abc' } }); await delivered();
  const drawn = modal.querySelector('[data-mount="je-status-chip"]').innerHTML;
  assert.notEqual(drawn.trim(), '', 'the Refresh drew its answer');
  held.resolve({ id: 2, media: { status: 2, status4k: 1 } }); await delivered();
  assert.equal(modal.querySelector('[data-mount="je-status-chip"]').innerHTML, drawn, 'the older intent (the write) did not redraw over it');
});

test('control: Request in 4K in a window that stays → the 4K chip appears in it', async t => {
  const h = setup(t, { asks: false, seerr4k: true });
  const modal = await nativeWindow(h);
  (await windowSheet(h)).find(n => n.dataset.action === 'request-4k').click(); await delivered();
  assert.equal(posts(h).length, 1);
  assert.notEqual(modal.querySelector('[data-mount="je-status-chip"]').innerHTML.trim(), '', 'the chip is drawn in its own window');
});

// ---------------------------------------------------------------- D46S2-R7-4: the quota dialog is an opener

const QUOTA = [403, { message: 'Quota exceeded' }];

test('R7-4: a quota refusal, its quota read held, the window\'s operation ends → no dialog', async t => {
  const h = setup(t, { asks: false, seerr4k: false });
  h.respond('POST', '/jellyseerr/request', QUOTA);
  h.a.initialize(); mount(h); await settle();
  await press(h, 'request'); await delivered();
  const quota = h.hold('GET', '/jellyseerr/quota');
  moreInfo(h).querySelector('.jellyseerr-request-button').click(); await settle(); await delivered();
  remount(h); h.a.scan(); await settle();
  quota.resolve(); await delivered();
  assert.equal(h.alerts.length, 0, 'no dialog for an ended operation');
});

test('R7-4: the bar\'s Request in a natively opened window is refused for quota, the quota read held, leave → no dialog', async t => {
  const h = setup(t, { asks: false, seerr4k: true });
  h.respond('POST', '/jellyseerr/request', QUOTA);
  await nativeWindow(h);
  const quota = h.hold('GET', '/jellyseerr/quota');
  barRequest(h).click(); await settle(); await delivered();
  await h.leave();
  quota.resolve(); await delivered();
  assert.equal(h.alerts.length, 0);
});

test('R7-4: the quota dialog is open when its operation ends → it closes', async t => {
  const h = setup(t, { asks: false, seerr4k: false });
  h.respond('POST', '/jellyseerr/request', QUOTA);
  h.a.initialize(); mount(h); await settle();
  await press(h, 'request'); await delivered();
  moreInfo(h).querySelector('.jellyseerr-request-button').click(); await delivered();
  assert.equal(h.alerts.length, 1, 'the dialog opened');
  await delivered(); // the host adds its container a moment after the call
  assert.ok(h.document.querySelector('.dialogContainer'));
  remount(h); h.a.scan(); await delivered();
  assert.equal(h.document.querySelector('.dialogContainer'), null, 'the dialog closed with its operation');
});

test('control: a quota refusal while the operation lives → one dialog, the button back to Request', async t => {
  const h = setup(t, { asks: false, seerr4k: false });
  h.respond('POST', '/jellyseerr/request', QUOTA);
  const modal = await nativeWindow(h);
  modal.querySelector('.jellyseerr-request-button').click(); await delivered();
  assert.equal(h.alerts.length, 1);
  assert.match(h.alerts[0].title, /jellyseerr_quota_dialog_title/);
  const button = modal.querySelector('.jellyseerr-request-button');
  assert.equal(button.disabled, false);
  assert.match(button.textContent, /jellyseerr_btn_request/);
});

// ---------------------------------------------------------------- D46S2-R7-5: the row's Request follows the newest status

const rowRequest = h => h.row().querySelector('[data-je-action-kind="request"]');
const primaryLabel = h => h.row().querySelector('.je-actions-row .je-actions-primary')?.textContent || '';

test('R7-5: one mounted row, status not here → asked → not here: Request leaves the row and comes back', async t => {
  const h = setup(t, { asks: true, stage: 'notHere' });
  h.a.initialize(); mount(h); await settle(); await delivered();
  assert.ok(rowRequest(h), 'Request is in the row');
  assert.match(primaryLabel(h), /jellyseerr_btn_request/);
  h.setStage('asked'); h.feed(); await delivered(); h.a.scan(); await delivered();
  assert.equal(rowRequest(h), null, 'asked: no Request in the row');
  assert.doesNotMatch(primaryLabel(h), /jellyseerr_btn_request/);
  h.setStage('notHere'); h.feed(); await delivered(); h.a.scan(); await delivered();
  assert.ok(rowRequest(h), 'not here again: Request is back');
  assert.match(primaryLabel(h), /jellyseerr_btn_request/);
});

test('R7-5: asked when the row mounts, then cancelled (not here) → Request appears', async t => {
  const h = setup(t, { asks: true, stage: 'asked' });
  h.a.initialize(); mount(h); await settle(); await delivered();
  assert.equal(rowRequest(h), null);
  h.setStage('notHere'); h.JE.arrStatus.refresh(['movie:tmdb:603']); await delivered(); h.a.scan(); await delivered();
  assert.ok(rowRequest(h), 'Request is back after the cancel');
});

// Overlapping status re-reads of one title are the same unbound read: the transport shares one request (and answer)
// between them, so they cannot answer out of order; the newest read decides (followStatus) for the generation that asked.
test('R7-5: a status re-read that fails keeps what the row shows', async t => {
  const h = setup(t, { asks: true, stage: 'notHere' });
  h.a.initialize(); mount(h); await settle(); await delivered();
  h.respond('GET', '/acquire/status', [500, { message: 'down' }]);
  h.feed(); await delivered(); h.a.scan(); await delivered();
  assert.ok(rowRequest(h), 'Request stays');
});

test('R7-5: asking from the row\'s Request takes Request away (the ask refreshes the title\'s status)', async t => {
  const h = setup(t, { asks: true, stage: 'notHere' });
  h.respond('POST', '/acquire/requests', () => { h.setStage('asked'); return null; });
  h.a.initialize(); mount(h); await settle(); await delivered();
  rowRequest(h).click(); await delivered();
  const submit = h.document.querySelector('.je-sheet .je-sheet-primary');
  assert.ok(submit, 'the request sheet offers its Request');
  submit.click(); await delivered(); h.a.scan(); await delivered();
  assert.equal(h.sent('POST', '/acquire/requests').length, 1, 'one ask');
  assert.equal(rowRequest(h), null, 'Request left the row after asking');
});

// ---------------------------------------------------------------- D46S2-R7-6: busy states clear in finally

test('R7-6: a Refresh superseded by a newer read of the same window is enabled again when it ends', async t => {
  const h = setup(t, { asks: false });
  const modal = await nativeWindow(h, 1399, 'tv');
  const held = h.hold('GET', '/jellyseerr/tv/1399');
  h.manager.clearCache();
  const refresh = modal.querySelector('.modal-refresh');
  refresh.click(); await settle();
  assert.equal(refresh.disabled, true, 'busy while it reads');
  h.document.dispatchEvent(new h.window.CustomEvent('jellyseerr-tv-requested', { detail: { tmdbId: '1399', mediaType: 'tv' } })); await settle();
  held.resolve(); await delivered();
  assert.equal(refresh.disabled, false, 'enabled again');
  assert.equal(refresh.classList.contains('loading'), false);
});

test('control: a plain Refresh is busy while it reads and enabled after', async t => {
  const h = setup(t, { asks: false });
  const modal = await nativeWindow(h);
  const held = h.hold('GET', '/jellyseerr/movie/603');
  h.manager.clearCache();
  const refresh = modal.querySelector('.modal-refresh');
  refresh.click(); await settle();
  assert.equal(refresh.disabled, true);
  held.resolve(); await delivered();
  assert.equal(refresh.disabled, false);
});

// ---------------------------------------------------------------- host dialogs are openers: an owner is required

const DIALOGS = [
  ['the quota dialog', h => h.JE.jellyseerrUI.showQuotaErrorDialog({ status: 403, responseJSON: { message: 'Quota exceeded' } }, 'movie')],
  ['a host dialog', h => h.JE.openHostDialog(() => h.window.Dashboard.alert({ title: 'x', message: 'y' }))],
];
for (const [name, open] of DIALOGS) {
  test(`opener without an owner (${name}): throws in tests`, async t => {
    const h = setup(t, { asks: false });
    let thrown = null;
    try { await open(h); } catch (error) { thrown = error; }
    assert.match(String(thrown?.message), /without an owner/);
    assert.equal(h.alerts.length, 0);
  });
  test(`opener without an owner (${name}): opens nothing in production`, async t => {
    const h = setup(t, { asks: false });
    h.JE.strictOwners = false;
    await open(h); await delivered();
    assert.equal(h.alerts.length, 0, 'no dialog');
  });
}

test('control: a host dialog opened natively stays open when an operation ends', async t => {
  const h = setup(t, { asks: false });
  h.a.initialize(); mount(h); await settle();
  h.JE.openHostDialog(() => h.window.Dashboard.alert({ title: 'x', message: 'y' }), h.JE.NATIVE);
  remount(h); h.a.scan(); await delivered();
  assert.ok(h.document.querySelector('.dialogContainer'), 'a native dialog is the viewer\'s');
});
