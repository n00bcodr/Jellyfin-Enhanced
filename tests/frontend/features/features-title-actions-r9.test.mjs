import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, mount, settle, delivered, moreInfo, seerrModal } from '../helpers/title-actions-scopes.mjs';

// D46 slice 2 review round 9: the guarantees hold at run time, at the moment of each effect (the static scans are lint).
// (1) Effects verify as they happen: a delayed refresh runs through the checked runner; JE.NATIVE is accepted only where
// a native context is acting (never inside an operation's press, nor in a raw continuation); a native owner taken
// inside an operation, or a write sent without its binding there, is refused. (2) The publication is a capability: only
// its handle changes UI for an answer, so no guard in a listener can be inverted. (3) A write's identity is title +
// media type + edition + variant: a standard and a 4K request answer independently. (4) A portaled 4K popup's origin is
// resolved before it goes; none fails closed. (5) One host-dialog opening owns one container. Planted constructs of
// rounds 7–9 are executed here, not scanned. Real core transport and real owners; only the server is scripted.

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const posts = h => h.sent('POST', '/jellyseerr/request');
const CARD = (id = 603, type = 'movie') => `<div class="jellyseerr-button-group"><button class="jellyseerr-request-button jellyseerr-split-main jellyseerr-button-request" data-tmdb-id="${id}" data-media-type="${type}"><span>jellyseerr_btn_request</span></button>` +
  `<button class="jellyseerr-split-arrow" data-tmdb-id="${id}" data-media-type="${type}" data-toggle4k="true"></button></div>`;

/** Watches refusals the way production meets them (logged, nothing opens or is sent) instead of throwing. */
function recordRefusals(h) {
  h.JE.strictOwners = 'record';
  h.JE.refusals = [];
  return () => h.JE.refusals || [];
}

/** The search page's Seerr script (its cards, 4K popup and request handlers) with the real results module. */
async function searchPage(t, { advanced = false, query = null, search = null, plants, cards = false } = {}) {
  const h = setup(t, { asks: false, advanced, seerr4k: true, plants });
  h.JE.core.ui = { addTouchTapListener() {}, addDelegatedTouchTapListener() {} };
  h.JE.pluginConfig.ShowCollectionsInSearch = false;
  h.load('jellyseerr/ui/ui-popover.js');
  if (cards) { h.JE.cdn = { url: () => 'data:,', selfhst: () => 'data:,' }; h.JE.hiddenContent = { getSettings: () => ({ enabled: false }) }; h.load('jellyseerr/ui/ui-badges.js'); h.load('jellyseerr/ui/ui-buttons.js'); h.load('jellyseerr/ui/ui-cards.js'); }
  h.load('jellyseerr/ui/ui-results.js');
  const searches = []; const renders = [];
  h.JE.jellyseerrAPI.search = search || (async q => { searches.push(q); return { results: [{ id: 603, mediaType: 'movie', title: 'The Matrix' }], page: 1, totalPages: 1 }; });
  Object.assign(h.JE.jellyseerrUI, { addMainStyles() {}, addSeasonModalStyles() {}, updateJellyseerrIcon() {}, hideHoverPopover() {}, toggleHoverPopoverLock() {},
    renderJellyseerrResults(_results, q) { renders.push(q); const drawn = h.document.querySelector('#drawn'); if (drawn) drawn.textContent = q; } });
  h.JE.discoveryFilter = {};
  if (query != null) {
    h.document.body.insertAdjacentHTML('beforeend', `<div id="searchPage"><input id="searchTextInput" value="${query}"><div id="drawn"></div></div>`);
    h.window.history.replaceState({}, '', `#/search?query=${query}`);
  }
  if (advanced) await h.JE.jellyseerrAPI.checkUserStatus();
  h.load('jellyseerr/jellyseerr.js');
  h.JE.initializeJellyseerrScript();
  await delivered();
  return { ...h, get NATIVE() { return h.NATIVE; }, searches, renders };
}

/** A search-result card (standard Request + 4K arrow) and its 4K popup, as ui-buttons and ui-popover draw them. */
function cardWithPopup(h, id = 603, type = 'movie', owner = h.NATIVE) {
  const card = h.document.createElement('div');
  card.className = 'jellyseerr-card';
  card.innerHTML = CARD(id, type);
  h.document.body.append(card);
  const item = { id, mediaType: type, title: 'Title ' + id, name: 'Title ' + id, mediaInfo: { status: 1, status4k: 1 } };
  // The popup is its opener's surface (D46S2-R10, audit S1): here the viewer's own press, unless a test names another.
  h.JE.internals.jellyseerrUi.show4KPopup(card.firstChild, item, owner);
  return { card, item, main: card.querySelector('.jellyseerr-split-main'), arrow: card.querySelector('.jellyseerr-split-arrow'),
    popupItem: h.document.querySelector('.jellyseerr-4k-popup-item') };
}

/** Opens Seerr's More Info window natively, at phone width, with the bar's adapted controls. */
async function nativeWindow(h, id = 603, type = 'movie') {
  Object.defineProperty(h.window, 'innerWidth', { value: 100, writable: true, configurable: true });
  h.a.initialize(); await settle();
  await h.JE.jellyseerrMoreInfo.open(id, type, undefined, h.NATIVE); await delivered();
  h.a.scan(); await delivered();
  assert.ok(moreInfo(h), 'the window opened');
  return moreInfo(h);
}

/** A planted button whose click handler runs `body` (a statement over JE and the event `e`), in a module of its own. */
function plantHandler(h, id, body) {
  h.window.eval(`(function (JE) { document.addEventListener('click', function (e) { if (e.target.id !== '${id}') return; ${body} }); })(window.JellyfinEnhanced);`);
  const node = h.document.createElement('button'); node.id = id; h.document.body.append(node);
  return node;
}

// ---------------------------------------------------------------- D46S2-R9-1: the 4K success's delayed refresh

test('R9-1: a 4K request\'s delayed refresh, then a newer search → the newer results stay', async t => {
  const h = await searchPage(t, { query: 'old' });
  await wait(450);
  assert.deepEqual(h.searches, ['old'], 'the page searched its query');
  const { popupItem } = cardWithPopup(h);
  popupItem.click(); await delivered();
  assert.equal(posts(h).length, 1);
  const input = h.document.querySelector('#searchTextInput');
  input.value = 'new'; h.window.history.replaceState({}, '', '#/search?query=new'); input.dispatchEvent(new h.window.Event('input'));
  await wait(450);
  assert.equal(h.document.querySelector('#drawn').textContent, 'new');
  await wait(800); await delivered();
  assert.deepEqual(h.searches, ['old', 'new'], 'the older query was not searched again');
  assert.equal(h.document.querySelector('#drawn').textContent, 'new', 'the newer results stay');
});

test('R9-1: a 4K request pressed for an operation, which then ends (leave, pagehide, pageshow) → no refresh of its query', async t => {
  const h = setup(t, { asks: false, seerr4k: true });
  h.a.initialize(); mount(h); await settle();
  const page = h.document.createElement('div'); page.id = 'searchPage';
  page.innerHTML = '<input id="searchTextInput" value="alpha"><div id="grid">newer grid</div><div class="jellyseerr-card"><button class="jellyseerr-request-button" data-tmdb-id="603" data-media-type="movie"></button><div class="jellyseerr-4k-popup"><button class="jellyseerr-4k-popup-item" data-tmdb-id="603" data-action="request4k" data-media-type="movie">4K</button></div></div>';
  h.document.body.append(page);
  await h.leave('#/search?query=alpha');
  const live = h.a.generation();
  const searches = [];
  h.JE.core.ui = { addTouchTapListener() {} };
  h.JE.pluginConfig.ShowCollectionsInSearch = false;
  h.JE.jellyseerrAPI.checkUserStatus = () => new Promise(() => {});
  h.JE.jellyseerrAPI.search = async query => { searches.push(query); return { results: [{ id: 7, mediaType: 'movie', title: query }], page: 1, totalPages: 1 }; };
  Object.assign(h.JE.jellyseerrUI, { addMainStyles() {}, addSeasonModalStyles() {}, renderJellyseerrResults(_r, query) { h.document.querySelector('#grid').textContent = query; } });
  h.load('jellyseerr/jellyseerr.js'); h.JE.initializeJellyseerrScript();
  h.JE.press(page.querySelector('.jellyseerr-4k-popup-item'), live); await delivered();
  assert.equal(posts(h).length, 1);
  await h.leave('#/search?query=beta'); h.pagehide(); h.pageshow();
  page.querySelector('input').value = 'beta'; h.document.querySelector('#grid').textContent = 'beta';
  assert.equal(live.current(), false);
  await wait(1100); await delivered();
  assert.deepEqual(searches, [], 'nothing searched for the ended operation');
  assert.equal(h.document.querySelector('#grid').textContent, 'beta');
});

test('control: a 4K request and the same search still standing → its results refresh once, a second later', async t => {
  const h = await searchPage(t, { query: 'old' });
  await wait(450);
  const { popupItem } = cardWithPopup(h);
  popupItem.click(); await delivered();
  assert.equal(posts(h).length, 1);
  await wait(1100); await delivered();
  assert.deepEqual(h.searches, ['old', 'old'], 'refreshed once');
  assert.equal(h.document.querySelector('#drawn').textContent, 'old');
});

// ---------------------------------------------------------------- D46S2-R9-2: a portaled popup's origin

test('R9-2: advanced on, a card\'s 4K popup → the form → Save → that card\'s 4K arrow shows the request (not offered again)', async t => {
  const h = await searchPage(t, { advanced: true });
  const { main, arrow, popupItem } = cardWithPopup(h);
  popupItem.click(); await delivered(); await wait(150);
  const form = seerrModal(h); assert.ok(form, 'the 4K form opened');
  form.querySelector('#movie-server').value = '1'; form.querySelector('#movie-server').dispatchEvent(new h.window.Event('change'));
  form.querySelector('#movie-quality').value = '4'; form.querySelector('#movie-folder').value = '/movies';
  form.querySelector('.jellyseerr-modal-button-primary').click(); await delivered();
  assert.equal(posts(h).length, 1);
  assert.equal(posts(h)[0][3].is4k, true);
  assert.equal(arrow.disabled, true, 'the 4K arrow no longer offers the request');
  assert.ok(arrow.classList.contains('jellyseerr-4k-pending'));
  assert.equal(main.disabled, false, 'the standard Request stays');
});

/** Opens (or closes) a real search card's overview, where its Request is drawn (a phone taps the poster; Space here). */
function toggleOverview(h, card) {
  const poster = card.querySelector('.jellyseerr-poster-image');
  poster.dispatchEvent(new h.window.FocusEvent('focusin', { bubbles: true }));
  poster.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }));
}

test('R9-2: a real search card whose overview closed while its 4K form answers → reopened, its 4K arrow shows the request', async t => {
  const h = await searchPage(t, { advanced: true, cards: true });
  const row = h.document.createElement('div'); row.className = 'itemsContainer'; h.document.body.append(row);
  const card = h.JE.jellyseerrUI.createJellyseerrCard({ id: 603, mediaType: 'movie', title: 'The Matrix', mediaInfo: { status: 1, status4k: 1 } }, true, true);
  row.append(card);
  toggleOverview(h, card);
  const arrow = card.querySelector('.jellyseerr-split-arrow');
  assert.ok(arrow, 'the overview draws the split Request');
  arrow.click(); await settle();
  // A phone's tap on the popup closes the card's overview first (the split button goes with it), then the popup acts.
  toggleOverview(h, card);
  assert.equal(card.querySelector('.jellyseerr-split-arrow'), null, 'the overview closed');
  h.document.querySelector('.jellyseerr-4k-popup-item[data-action="request4k"]').click(); await delivered(); await wait(150);
  const form = seerrModal(h); assert.ok(form, 'the 4K form opened');
  form.querySelector('#movie-server').value = '1'; form.querySelector('#movie-server').dispatchEvent(new h.window.Event('change'));
  form.querySelector('#movie-quality').value = '4'; form.querySelector('#movie-folder').value = '/movies';
  form.querySelector('.jellyseerr-modal-button-primary').click(); await delivered();
  assert.equal(posts(h).length, 1);
  toggleOverview(h, card);
  const again = card.querySelector('.jellyseerr-split-arrow');
  assert.ok(again, 'the overview is back');
  assert.ok(again.classList.contains('jellyseerr-4k-pending'), 'the card shows its 4K request');
  assert.match(card.querySelector('.jellyseerr-split-main').textContent, /jellyseerr_btn_request$/, 'its standard Request stays');
});

test('R9-2: a series card\'s 4K popup → the season form → Save → that card\'s 4K arrow shows the request', async t => {
  const h = await searchPage(t);
  const { main, arrow, popupItem } = cardWithPopup(h, 1399, 'tv');
  popupItem.click(); await delivered(); await wait(150);
  const form = seerrModal(h); assert.ok(form, 'the season form opened');
  form.querySelector('.jellyseerr-modal-button-primary').click(); await delivered();
  assert.equal(posts(h).length, 1);
  assert.equal(posts(h)[0][3].is4k, true);
  assert.ok(arrow.classList.contains('jellyseerr-4k-pending'), 'the series card\'s 4K arrow shows the request');
  assert.equal(main.disabled, false);
});

test('R9-2: a 4K popup whose origin is unknown → refused: nothing opens or is sent (fails closed)', async t => {
  const h = await searchPage(t);
  const refusals = recordRefusals(h);
  const popup = h.document.createElement('div'); popup.className = 'jellyseerr-4k-popup';
  popup.innerHTML = '<button class="jellyseerr-4k-popup-item" data-tmdb-id="603" data-media-type="movie" data-action="request4k">4K</button>';
  h.document.body.append(popup);
  popup.firstChild.click(); await delivered(); await wait(150);
  assert.equal(posts(h).length, 0, 'nothing sent');
  assert.equal(seerrModal(h), null, 'no form');
  assert.ok(refusals().some(m => /has no origin/.test(m)), 'refused: ' + JSON.stringify(refusals()));
});

// ---------------------------------------------------------------- D46S2-R9-3: one intent slot per write identity

test('R9-3: the window\'s standard Request held, its Request in 4K answers first → both requests are shown', async t => {
  const h = setup(t, { asks: false, seerr4k: true });
  const modal = await nativeWindow(h);
  const held = h.hold('POST', '/jellyseerr/request');
  modal.querySelector('.jellyseerr-split-main').click(); await settle();
  modal.querySelector('.je-actions-more, .je-actions-wide-more').click(); await delivered();
  h.document.querySelector('.je-actions-entry[data-action="request-4k"]').click(); await delivered();
  assert.equal(posts(h).length, 2);
  held.resolve(); await delivered();
  const now = moreInfo(h);
  const main = now.querySelector('.jellyseerr-split-main');
  assert.ok(!main || main.disabled === true, 'the standard Request is no longer offered');
  const chip = now.querySelector('[data-mount="je-status-chip"]').textContent;
  assert.match(chip, /4K/, 'the 4K request is shown: ' + chip);
  assert.match(chip.replace(/4K[^,]*/, ''), /requested|pending/i, 'the standard request is shown too: ' + chip);
});

test('control: both requests held, then a Refresh of the window → neither answer is drawn over it', async t => {
  const h = setup(t, { asks: false, seerr4k: true });
  const modal = await nativeWindow(h);
  const first = h.hold('POST', '/jellyseerr/request');
  const second = h.hold('POST', '/jellyseerr/request');
  modal.querySelector('.jellyseerr-split-main').click(); await settle();
  modal.querySelector('.je-actions-more, .je-actions-wide-more').click(); await delivered();
  h.document.querySelector('.je-actions-entry[data-action="request-4k"]').click(); await settle();
  assert.equal(posts(h).length, 2);
  h.manager.clearCache();
  modal.querySelector('.modal-refresh').click(); await delivered();
  const refreshed = moreInfo(h).querySelector('.jellyseerr-split-main');
  first.resolve(); second.resolve(); await delivered();
  assert.equal(refreshed.disabled, false, 'the Refresh superseded both writes');
  assert.match(refreshed.textContent, /jellyseerr_btn_request$/);
});

// ---------------------------------------------------------------- D46S2-R9-4: JE.NATIVE only where a native context acts

test('R9-4 (plant executed): an operation\'s handler hands a native opener to a callback ([fn].forEach) → refused, no window', async t => {
  const h = setup(t, { asks: false });
  const refusals = recordRefusals(h);
  h.a.initialize(); await settle();
  h.load('jellyseerr/nativedetails/native-details.js');
  const node = plantHandler(h, 'plant-foreach', 'const owner = JE.ownerOf(e); [JE.titleDetails.show].forEach(fn => fn(603, \'movie\'));');
  const owner = h.a.generation();
  const held = h.hold('GET', '/jellyseerr/movie/603');
  h.JE.press(node, owner); await settle();
  await h.leave(); assert.equal(owner.current(), false);
  held.resolve(); await delivered();
  assert.equal(moreInfo(h), null, 'no window');
  assert.equal(h.sent('GET', '/jellyseerr/movie/603').length, 0, 'not even its details were read');
  // JE.NATIVE is gone (D46S2-R10): the plant names no owner, and is refused as such.
  assert.ok(refusals().some(m => /without an owner|inside an operation/.test(m)), JSON.stringify(refusals()));
});

test('R9-4 (plant executed): a shared link whose promise continuation drops its operation for a native opener → no window after leaving', async t => {
  const before = 'return await JE.titleDetails.openKey(c.key, { owner: action }) === true;';
  const h = setup(t, { asks: false, plants: { 'arr/actions/title-actions.js': s => s.replace(before,
    'if (window.__gate) return await window.__gate.then(() => JE.titleDetails.show(c.tmdbId, c.type)); ' + before) } });
  const refusals = recordRefusals(h);
  h.load('jellyseerr/nativedetails/native-details.js');
  let release; h.window.__gate = new Promise(resolve => { release = resolve; });
  const receive = h.JE.titleActions.receive('movie:tmdb:603'); await settle();
  await h.leave(); release(); await receive; await delivered();
  assert.equal(moreInfo(h), null, 'no window on the new route');
  assert.ok(refusals().some(m => /without an owner/.test(m)), JSON.stringify(refusals()));
});

test('control: a viewer\'s own click on a native opener (no operation acting) → the window opens, natively', async t => {
  const h = setup(t, { asks: false });
  h.load('jellyseerr/nativedetails/native-details.js');
  const node = plantHandler(h, 'native-show', 'JE.titleDetails.show(603, \'movie\', undefined, JE.ownerOf(e));');
  node.click(); await delivered();
  assert.equal(moreInfo(h)?.dataset.tmdbId, '603');
  assert.equal(h.JE.ownerOf(moreInfo(h)).native, true);
});

test('R8-1 (plant executed): a card holding its press hands its title to the native show() → refused inside the operation', async t => {
  const h = setup(t, { asks: false });
  const refusals = recordRefusals(h);
  h.a.initialize(); await settle();
  h.load('jellyseerr/nativedetails/native-details.js');
  const node = plantHandler(h, 'card-title', 'const owner = JE.ownerOf(e); JE.titleDetails.show(603, \'movie\');');
  h.JE.press(node, h.a.generation()); await delivered();
  assert.equal(moreInfo(h), null);
  assert.ok(refusals().some(m => /without an owner|inside an operation/.test(m)));
});

test('R8-1 (plant executed): a captured operation reaching a native window in a raw timer → refused, no window', async t => {
  const h = setup(t, { asks: false });
  const refusals = recordRefusals(h);
  h.a.initialize(); await settle();
  const node = plantHandler(h, 'hub-entry', 'const op = JE.titleActions.generation(); setTimeout(() => { if (op.current()) JE.jellyseerrMoreInfo.open(603, \'movie\', undefined, JE.NATIVE); });');
  node.click(); await wait(20); await delivered();
  assert.equal(moreInfo(h), null);
  assert.ok(refusals().some(m => /without an owner/.test(m)));
});

test('R8-1 (plant executed): the shared link dropping its owner at the hand-over → refused (no owner), no window', async t => {
  const h = setup(t, { asks: false, plants: { 'arr/actions/title-actions.js': s => s.replace('return await JE.titleDetails.openKey(c.key, { owner: action }) === true;', 'return await JE.titleDetails.openKey(c.key, {}) === true;') } });
  h.load('jellyseerr/nativedetails/native-details.js');
  h.JE.strictOwners = false;
  await h.JE.titleActions.receive('movie:tmdb:603'); await delivered();
  assert.equal(moreInfo(h), null);
});

test('R7-1 (plant executed): the window\'s Request handler names itself native; the bar presses it → refused, nothing sent', async t => {
  const h = setup(t, { asks: false, seerr4k: true, plants: { 'jellyseerr/moreinfo/more-info-modal-actions.js': s => s.replace(
    "            // The press is the owner (D46S2-R7-1): the action bar's operation when the bar pressed it, else the window's.\n            const owner = JE.ownerOf(e);",
    '            const owner = JE.NATIVE;') } });
  const refusals = recordRefusals(h);
  const modal = await nativeWindow(h);
  modal.querySelector('.je-actions-primary').click(); await delivered();
  assert.equal(posts(h).length, 0, 'no request sent for a dropped owner');
  assert.ok(refusals().some(m => /without an owner|inside an operation/.test(m)), JSON.stringify(refusals()));
});

test('R7-1 (plant executed): the window\'s Request handler takes its owner from its button; the bar presses it → refused, nothing sent', async t => {
  const h = setup(t, { asks: false, seerr4k: true, plants: { 'jellyseerr/moreinfo/more-info-modal-actions.js': s => s.replace(
    "            // The press is the owner (D46S2-R7-1): the action bar's operation when the bar pressed it, else the window's.\n            const owner = JE.ownerOf(e);",
    '            const owner = JE.ownerOf(mainButton);') } });
  const refusals = recordRefusals(h);
  const modal = await nativeWindow(h);
  modal.querySelector('.je-actions-primary').click(); await delivered();
  assert.equal(posts(h).length, 0);
  assert.ok(refusals().some(m => /native owner inside an operation/.test(m)), JSON.stringify(refusals()));
});

test('control: the bar presses the window\'s Request (its press carries the operation) → sent, bound to it', async t => {
  const h = setup(t, { asks: false, seerr4k: true });
  const modal = await nativeWindow(h);
  modal.querySelector('.je-actions-primary').click(); await delivered();
  assert.equal(posts(h).length, 1);
});

test('R8-3 (plant executed): nested destructuring of the transport, an unbound POST inside an operation\'s press → refused at the send', async t => {
  const h = setup(t, { asks: false });
  const refusals = recordRefusals(h);
  h.a.initialize(); await settle();
  const node = plantHandler(h, 'nested-post', 'const { core: { api } } = JE; api.plugin(\'/arr/x\', { method: \'POST\', body: {} }).catch(() => {});');
  h.JE.press(node, h.a.generation()); await delivered();
  assert.equal(h.sent('POST', '/arr/x').length, 0, 'not sent');
  assert.ok(refusals().some(m => /without its binding inside an operation/.test(m)), JSON.stringify(refusals()));
});

test('control: the same unbound POST from a viewer\'s own click (native) → sent', async t => {
  const h = setup(t, { asks: false });
  const node = plantHandler(h, 'native-post', 'const { core: { api } } = JE; api.plugin(\'/arr/x\', { method: \'POST\', body: {}, session: JE.core.userWrite.origin() }).catch(() => {});');
  node.click(); await delivered();
  assert.equal(h.sent('POST', '/arr/x').length, 1);
});

// ---------------------------------------------------------------- D46S2-R9-5: the publication is a capability

const INVERT = s => s.includes('if (!JE.published(e, modal)) return;') ? s.replace('if (!JE.published(e, modal)) return;', 'if (JE.published(e, modal)) return;') : s + '\n';

test('R9-5 (plant executed): the window\'s follower with its publication test inverted, a completion for another title → the window is unchanged', async t => {
  const h = setup(t, { asks: false, seerr4k: false, plants: { 'jellyseerr/moreinfo/more-info-modal-init.js': INVERT } });
  const modal = await nativeWindow(h);
  assert.ok(modal.querySelector('.jellyseerr-request-button'));
  h.document.dispatchEvent(new h.window.CustomEvent('jellyseerr-media-requested', { detail: { tmdbId: '999', mediaType: 'movie', is4k: false, response: { media: { status: 2 } } } }));
  const other = h.document.createElement('button'); other.dataset.tmdbId = '999'; other.dataset.mediaType = 'movie'; h.document.body.append(other);
  h.JE.publication?.({ owner: h.NATIVE, surface: other, identity: { tmdbId: 999, mediaType: 'movie' } })?.publish?.({ response: { media: { status: 2 } } });
  await delivered();
  assert.ok(moreInfo(h).querySelector('.jellyseerr-request-button'), 'the movie\'s Request is still offered');
});

test('R8-2 (plant executed): a raw completion listener marking cards by title id → it never sees an answer; the card\'s standard Request stays after a 4K request', async t => {
  const h = setup(t, { asks: false, seerr4k: true });
  h.JE.core.ui = { addTouchTapListener() {} };
  h.load('jellyseerr/ui/ui-results.js');
  h.window.eval("document.addEventListener('jellyseerr-media-requested', e => { for (const b of document.querySelectorAll(`.jellyseerr-request-button[data-tmdb-id=\"${e.detail.tmdbId}\"]`)) b.disabled = true; });");
  const card = h.document.createElement('div'); card.className = 'jellyseerr-card'; card.innerHTML = CARD(); h.document.body.prepend(card);
  await nativeWindow(h);
  moreInfo(h).querySelector('.je-actions-more, .je-actions-wide-more').click(); await delivered();
  h.document.querySelector('.je-actions-entry[data-action="request-4k"]').click(); await delivered();
  assert.equal(posts(h).length, 1);
  assert.equal(card.querySelector('.jellyseerr-split-main').disabled, false, 'the standard Request stays');
  assert.ok(card.querySelector('.jellyseerr-split-arrow').classList.contains('jellyseerr-4k-pending'), 'the 4K arrow follows the publication');
});

test('R8-2 (plant executed): the transport broadcasting a completion event again → no card or window changes', async t => {
  const h = setup(t, { asks: false, seerr4k: true });
  h.JE.core.ui = { addTouchTapListener() {} };
  h.load('jellyseerr/ui/ui-results.js');
  const card = h.document.createElement('div'); card.className = 'jellyseerr-card'; card.innerHTML = CARD(); h.document.body.prepend(card);
  h.document.dispatchEvent(new h.window.CustomEvent('jellyseerr-media-requested', { detail: { tmdbId: '603', mediaType: 'movie', is4k: false } }));
  await delivered();
  assert.equal(card.querySelector('.jellyseerr-split-main').disabled, false);
});

test('R9-5: a publication\'s handle changes nothing once it is no longer current (a newer write of the same identity)', async t => {
  const h = setup(t, { asks: false });
  if (!h.JE.followPublications) assert.fail('no publication handle (followers)');
  const button = h.document.createElement('button'); button.dataset.tmdbId = '603'; button.dataset.mediaType = 'movie'; h.document.body.append(button);
  const seen = [];
  h.JE.followPublications({ selector: '[data-tmdb-id="603"]' }, handle => seen.push(handle.answer.is4k));
  const older = h.JE.publication({ owner: h.NATIVE, surface: button, identity: { tmdbId: 603, mediaType: 'movie' } });
  const newer = h.JE.publication({ owner: h.NATIVE, surface: button, identity: { tmdbId: 603, mediaType: 'movie' } });
  assert.equal(older.run(() => seen.push('run')), false);
  assert.equal(older.apply(button, () => seen.push('apply')), false);
  assert.equal(older.publish(), false);
  assert.deepEqual(seen, []);
  assert.equal(newer.publish(), true);
  assert.deepEqual(seen, [false]);
});

// ---------------------------------------------------------------- D46S2-R9-6: one opening, one container

test('R9-6: two quota dialogs for one operation, then pagehide → none is left', async t => {
  const h = setup(t, { asks: false }); h.a.initialize(); mount(h); await settle();
  const owner = h.a.generation();
  h.JE.openHostDialog(mark => h.window.Dashboard.alert({ message: mark('first') }), owner);
  h.JE.openHostDialog(mark => h.window.Dashboard.alert({ message: mark('second') }), owner);
  await delivered();
  assert.equal(h.document.querySelectorAll('.dialogContainer').length, 2);
  h.pagehide(); await delivered();
  assert.equal(h.document.querySelectorAll('.dialogContainer').length, 0);
});

test('R9-6: an owned dialog arriving late and a native one arriving first; the owner ends → the native one stays, the owned one goes', async t => {
  const h = setup(t, { asks: false }); h.a.initialize(); mount(h); await settle();
  const owner = h.a.generation();
  h.window.Dashboard.alert = options => {
    const container = h.document.createElement('div'); container.className = 'dialogContainer';
    container.innerHTML = '<div class="text"></div><button class="btnOption">OK</button>';
    container.querySelector('.text').textContent = options.message;
    container.querySelector('button').onclick = () => container.remove();
    h.window.setTimeout(() => h.document.body.append(container), options.message.startsWith('owned') ? 30 : 0);
  };
  h.JE.openHostDialog(mark => h.window.Dashboard.alert({ message: mark('owned') }), owner);
  h.pagehide();
  h.JE.openHostDialog(() => h.window.Dashboard.alert({ message: 'native' }), h.NATIVE);
  await wait(60); await delivered();
  assert.deepEqual([...h.document.querySelectorAll('.dialogContainer')].map(n => n.textContent.replace('OK', '')), ['native']);
});

test('control: one owned dialog while its owner lives stays; a native one stays after a pagehide', async t => {
  const h = setup(t, { asks: false }); h.a.initialize(); mount(h); await settle();
  const owner = h.a.generation();
  h.JE.openHostDialog(mark => h.window.Dashboard.alert({ message: mark('a') }), owner);
  await delivered();
  assert.equal(h.document.querySelectorAll('.dialogContainer').length, 1);
  h.pagehide(); await delivered();
  h.JE.openHostDialog(() => h.window.Dashboard.alert({ message: 'b' }), h.NATIVE);
  await delivered();
  assert.deepEqual([...h.document.querySelectorAll('.dialogContainer')].map(n => n.querySelector('.text').textContent), ['b']);
});
