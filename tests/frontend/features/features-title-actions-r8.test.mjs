import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, mount, settle, delivered, moreInfo, seerrModal } from '../helpers/title-actions-scopes.mjs';

// D46 slice 2 review round 8. Shapes: (1) owners flow through every hand-over: a shared link's operation reaches the
// window its fallback opens, through the window's details read; (2) one publication path: every completion (the
// window's requests, the advanced and 4K forms, the cards' sync, the quota dialog) changes UI only through the
// publication of its originating surface (owner + that surface + its newest intent + the identity: title, media type
// and edition); (4) a host dialog that attaches after its owner ended is dismissed on arrival; (5) the row's Request
// sees a status change that lands between its setup read and its subscription. Real core transport and real owners;
// only the server is scripted.

/** Seerr modals show 10 ms after they open. */
const shown = () => new Promise(resolve => setTimeout(resolve, 30));
const posts = h => h.sent('POST', '/jellyseerr/request');
const QUOTA = [403, { message: 'Quota exceeded' }];

/** Opens Seerr's More Info window natively (a search card, a hub entry: no title action), at phone width. */
async function nativeWindow(h, id = 603, type = 'movie') {
  Object.defineProperty(h.window, 'innerWidth', { value: 100, writable: true, configurable: true });
  h.a.initialize(); await settle();
  await h.JE.jellyseerrMoreInfo.open(id, type, undefined, h.NATIVE); await delivered();
  h.a.scan(); await delivered();
  assert.ok(moreInfo(h), 'the window opened');
  return moreInfo(h);
}

/** Loads the search page's result module (its cards follow requests made elsewhere). */
function withResults(h) {
  h.JE.core.ui = { addTouchTapListener() {} };
  h.load('jellyseerr/ui/ui-results.js');
}

/** A search-result card's split Request (standard) and its 4K arrow, as ui-buttons draws them, before the window. */
function card(h, id = 603, type = 'movie') {
  const node = h.document.createElement('div');
  node.className = 'jellyseerr-card';
  node.innerHTML = `<div class="jellyseerr-button-group"><button class="jellyseerr-request-button jellyseerr-split-main jellyseerr-button-request" data-tmdb-id="${id}" data-media-type="${type}"><span>jellyseerr_btn_request</span></button>` +
    `<button class="jellyseerr-split-arrow" data-tmdb-id="${id}" data-media-type="${type}" data-toggle4k="true"></button></div>`;
  h.document.body.prepend(node);
  return { main: node.querySelector('.jellyseerr-split-main'), arrow: node.querySelector('.jellyseerr-split-arrow') };
}

/** Opens the window's own More sheet and returns its entries. */
async function windowSheet(h) {
  moreInfo(h).querySelector('.je-actions-more, .je-actions-wide-more').click(); await delivered();
  return [...h.document.querySelectorAll('.je-actions-entry')];
}

// ---------------------------------------------------------------- D46S2-R8-1: the link's owner reaches its fallback

test('R8-1: a shared link whose fallback window waits for its details, then leave → no window on the new route', async t => {
  const h = setup(t, { asks: false });
  h.load('jellyseerr/nativedetails/native-details.js');
  assert.equal(h.JE.titleDetails.available(), false, 'no native details (as on 10.11): the window is the fallback');
  const held = h.hold('GET', '/jellyseerr/movie/603');
  const receive = h.a.receive('movie:tmdb:603'); await settle();
  assert.equal(h.sent('GET', '/jellyseerr/movie/603').length, 1, 'the fallback read its details');
  await h.leave();
  held.resolve(); await receive; await delivered();
  assert.equal(moreInfo(h), null, 'the link\'s operation ended: its window never opens');
});

test('control: a shared link\'s fallback window while the route stays → it opens', async t => {
  const h = setup(t, { asks: false });
  h.load('jellyseerr/nativedetails/native-details.js');
  assert.equal(await h.a.receive('movie:tmdb:603'), true);
  await delivered();
  assert.equal(moreInfo(h)?.dataset.tmdbId, '603');
});

test('R8-1: the shared link\'s fallback window belongs to the link\'s operation (not a native one), so leaving closes it', async t => {
  const h = setup(t, { asks: false });
  h.load('jellyseerr/nativedetails/native-details.js');
  await h.a.receive('movie:tmdb:603'); await delivered();
  assert.ok(moreInfo(h));
  assert.notEqual(h.JE.ownerOf(moreInfo(h)), h.NATIVE, 'owned by the link\'s operation');
  await h.leave(); await new Promise(resolve => setTimeout(resolve, 350));
  assert.equal(moreInfo(h), null, 'closed with it');
});

// ---------------------------------------------------------------- D46S2-R8-2: one publication path

test('R8-2: a held movie POST released after a newer Refresh of the window → the refreshed Request stays as drawn', async t => {
  const h = setup(t, { asks: false, seerr4k: true });
  withResults(h);
  const modal = await nativeWindow(h);
  const original = modal.querySelector('.jellyseerr-split-main');
  const held = h.hold('POST', '/jellyseerr/request');
  original.click(); await settle();
  h.manager.clearCache();
  modal.querySelector('.modal-refresh').click(); await delivered();
  const newer = modal.querySelector('.jellyseerr-split-main');
  assert.notEqual(newer, original, 'the Refresh redrew the controls');
  assert.equal(newer.disabled, false);
  held.resolve(); await delivered();
  assert.equal(posts(h).length, 1);
  assert.equal(newer.disabled, false, 'the older write did not publish over the newer Refresh');
  assert.match(newer.textContent, /jellyseerr_btn_request$/);
});

test('R8-2: advanced on, More → Request in 4K → only the 4K state changes: the standard Request and the bar\'s proxy stay', async t => {
  const h = setup(t, { asks: false, seerr4k: true, advanced: true });
  withResults(h);
  await h.JE.jellyseerrAPI.checkUserStatus();
  const modal = await nativeWindow(h);
  const standard = modal.querySelector('.jellyseerr-split-main');
  assert.match(standard.textContent, /jellyseerr_btn_request$/);
  (await windowSheet(h)).find(n => n.dataset.action === 'request-4k').click(); await delivered();
  const form = seerrModal(h); assert.ok(form, 'the 4K form opened'); await new Promise(resolve => setTimeout(resolve, 150));
  form.querySelector('#movie-server').value = '1'; form.querySelector('#movie-server').dispatchEvent(new h.window.Event('change'));
  form.querySelector('#movie-quality').value = '4'; form.querySelector('#movie-folder').value = '/movies';
  form.querySelector('.jellyseerr-modal-button-primary').click(); await delivered(); h.a.scan(); await delivered();
  assert.equal(posts(h).length, 1);
  assert.equal(posts(h)[0][3].is4k, true, 'a 4K request');
  const now = moreInfo(h).querySelector('.jellyseerr-split-main');
  assert.ok(now, 'the standard Request is still offered');
  assert.match(now.textContent, /jellyseerr_btn_request$/, 'the standard Request is not labelled Requested');
  assert.equal(now.disabled, false);
  assert.match(moreInfo(h).querySelector('.je-actions-primary').textContent, /jellyseerr_btn_request$/, 'the bar\'s proxy follows the standard Request');
  assert.match(moreInfo(h).querySelector('[data-mount="je-status-chip"]').textContent, /4K/, 'the 4K state is drawn');
});

test('R8-2: the window\'s Request in 4K → a card of the same title elsewhere: its 4K arrow changes, its standard Request does not', async t => {
  const h = setup(t, { asks: false, seerr4k: true });
  withResults(h);
  const { main, arrow } = card(h);
  await nativeWindow(h);
  (await windowSheet(h)).find(n => n.dataset.action === 'request-4k').click(); await delivered();
  assert.equal(posts(h).length, 1);
  assert.match(main.textContent, /jellyseerr_btn_request$/, 'the card\'s standard Request stays');
  assert.equal(main.disabled, false);
  assert.ok(arrow.classList.contains('jellyseerr-4k-pending'), 'the card\'s 4K arrow shows the request');
});

test('control: the window\'s standard Request → a card of the same title elsewhere shows Requested', async t => {
  const h = setup(t, { asks: false, seerr4k: true });
  withResults(h);
  const { main, arrow } = card(h);
  const modal = await nativeWindow(h);
  modal.querySelector('.jellyseerr-split-main').click(); await delivered();
  assert.equal(posts(h).length, 1);
  assert.match(main.textContent, /jellyseerr_btn_requested/);
  assert.equal(main.disabled, true);
  assert.ok(!arrow.classList.contains('jellyseerr-4k-pending'), 'its 4K arrow stays');
});

test('R8-2: a movie request → a series card with the same TMDB number is left alone (identity includes the media type)', async t => {
  const h = setup(t, { asks: false, seerr4k: true });
  withResults(h);
  const series = card(h, 603, 'tv');
  const modal = await nativeWindow(h);
  modal.querySelector('.jellyseerr-split-main').click(); await delivered();
  assert.equal(posts(h).length, 1);
  assert.match(series.main.textContent, /jellyseerr_btn_request$/);
  assert.equal(series.main.disabled, false);
});

test('R8-2: a completion event without a publication changes nothing', async t => {
  const h = setup(t, { asks: false, seerr4k: true });
  withResults(h);
  const { main } = card(h);
  h.document.dispatchEvent(new h.window.CustomEvent('jellyseerr-media-requested', { detail: { tmdbId: '603', mediaType: 'movie', is4k: false } }));
  await delivered();
  assert.match(main.textContent, /jellyseerr_btn_request$/);
  assert.equal(main.disabled, false);
});

test('R8-2: the window\'s request answers after the window was replaced → the cards elsewhere are left alone too', async t => {
  const h = setup(t, { asks: false, seerr4k: true });
  withResults(h);
  const { main } = card(h);
  const modal = await nativeWindow(h);
  const held = h.hold('POST', '/jellyseerr/request');
  modal.querySelector('.jellyseerr-split-main').click(); await settle();
  await h.JE.jellyseerrMoreInfo.open(1399, 'tv', undefined, h.NATIVE); await delivered();
  held.resolve(); await delivered();
  assert.equal(posts(h).length, 1);
  assert.match(main.textContent, /jellyseerr_btn_request$/);
});

test('control: the window\'s Collection request → a card of a part elsewhere shows Requested (each movie\'s publication reaches it)', async t => {
  const h = setup(t, { asks: false, seerr4k: true });
  withResults(h);
  const part = card(h, 604);
  const modal = await nativeWindow(h);
  modal.querySelector('.je-collection-card-button').click(); await delivered(); await shown();
  const form = seerrModal(h);
  assert.ok(form?.classList.contains('show'), 'the Collection form opened');
  form.querySelector('.jellyseerr-modal-button-primary').click(); await delivered();
  assert.deepEqual(posts(h).map(p => p[3].mediaId), [604]);
  assert.match(part.main.textContent, /jellyseerr_btn_requested/);
  assert.equal(part.main.disabled, true);
});

// ---------------------------------------------------------------- D46S2-R8-6: the quota dialog is a publication of its window

test('R8-6: a quota refusal answering after the window was replaced by another title → no dialog', async t => {
  const h = setup(t, { asks: false, seerr4k: false });
  h.respond('POST', '/jellyseerr/request', QUOTA);
  const modal = await nativeWindow(h);
  const held = h.hold('POST', '/jellyseerr/request');
  modal.querySelector('.jellyseerr-request-button').click(); await settle();
  await h.JE.jellyseerrMoreInfo.open(1399, 'tv', undefined, h.NATIVE); await delivered();
  assert.equal(moreInfo(h).dataset.tmdbId, '1399');
  held.resolve(); await delivered();
  assert.equal(h.alerts.length, 0, 'no dialog of the movie over the series\' window');
});

test('R8-6: the window is replaced while the quota dialog reads the quota → no dialog', async t => {
  const h = setup(t, { asks: false, seerr4k: false });
  h.respond('POST', '/jellyseerr/request', QUOTA);
  const modal = await nativeWindow(h);
  const quota = h.hold('GET', '/jellyseerr/quota');
  modal.querySelector('.jellyseerr-request-button').click(); await settle(); await delivered();
  await h.JE.jellyseerrMoreInfo.open(1399, 'tv', undefined, h.NATIVE); await delivered();
  quota.resolve(); await delivered();
  assert.equal(h.alerts.length, 0);
});

test('control: a quota refusal in a window that stays → one dialog', async t => {
  const h = setup(t, { asks: false, seerr4k: false });
  h.respond('POST', '/jellyseerr/request', QUOTA);
  const modal = await nativeWindow(h);
  modal.querySelector('.jellyseerr-request-button').click(); await delivered();
  assert.equal(h.alerts.length, 1);
});

// ---------------------------------------------------------------- D46S2-R8-4: a host dialog arriving after its owner ended

test('R8-4: a host dialog that attaches after its owner ended (pagehide) is dismissed on arrival', async t => {
  const h = setup(t, { asks: false });
  h.a.initialize(); mount(h); await settle();
  const owner = h.a.generation();
  h.JE.openHostDialog(mark => h.window.Dashboard.alert({ title: 'quota', message: mark('old title') }), owner);
  assert.equal(h.document.querySelector('.dialogContainer'), null, 'the host adds its dialog a moment later');
  h.pagehide();
  assert.equal(owner.current(), false);
  await delivered();
  assert.equal(h.document.querySelector('.dialogContainer'), null, 'dismissed as it arrived');
});

test('control: a host dialog that attaches while its owner lives stays; a native one stays after a pagehide', async t => {
  const h = setup(t, { asks: false });
  h.a.initialize(); mount(h); await settle();
  const owner = h.a.generation();
  h.JE.openHostDialog(mark => h.window.Dashboard.alert({ title: 'a', message: mark('a') }), owner);
  await delivered();
  assert.equal(h.document.querySelectorAll('.dialogContainer').length, 1);
  h.JE.openHostDialog(() => h.window.Dashboard.alert({ title: 'b', message: 'b' }), h.NATIVE);
  h.pagehide(); await delivered();
  assert.equal(h.document.querySelectorAll('.dialogContainer').length, 1, 'the owned one closed with its owner, the native one stays');
});

// ---------------------------------------------------------------- D46S2-R8-5: read and subscribe are bridged

test('R8-5: the title is asked for between the row\'s setup read and its subscription → no Request', async t => {
  const h = setup(t, { asks: true, stage: 'notHere' });
  const caps = h.hold('GET', '/acquire/requests/me');
  h.a.initialize(); mount(h); await settle();
  assert.ok(h.sent('GET', '/acquire/status').length, 'the setup read the status');
  h.setStage('asked'); h.feed(); await delivered();
  caps.resolve(); await delivered(); h.a.scan(); await delivered();
  assert.equal(h.row().querySelector('[data-je-action-kind="request"]'), null);
});

test('R8-5: the ask is cancelled between the row\'s setup read and its subscription → Request is offered', async t => {
  const h = setup(t, { asks: true, stage: 'asked' });
  const caps = h.hold('GET', '/acquire/requests/me');
  h.a.initialize(); mount(h); await settle();
  assert.ok(h.sent('GET', '/acquire/status').length);
  h.setStage('notHere'); h.feed(); await delivered();
  caps.resolve(); await delivered(); h.a.scan(); await delivered();
  assert.ok(h.row().querySelector('[data-je-action-kind="request"]'));
});

test('control: nothing changes during setup → Request offered, the status read once', async t => {
  const h = setup(t, { asks: true, stage: 'notHere' });
  const caps = h.hold('GET', '/acquire/requests/me');
  h.a.initialize(); mount(h); await settle();
  const reads = h.sent('GET', '/acquire/status').length;
  caps.resolve(); await delivered(); h.a.scan(); await delivered();
  assert.ok(h.row().querySelector('[data-je-action-kind="request"]'));
  assert.equal(h.sent('GET', '/acquire/status').length, reads, 'no extra read without a change');
});

