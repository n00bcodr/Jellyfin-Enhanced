import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, mount, settle, delivered, moreInfo, seerrModal, SHOW } from '../helpers/title-actions-scopes.mjs';

// D46 slice 2 review round 10 (with the full-track audit), state: a write has three outcomes (never sent: nothing
// follows; accepted after its owner ended: reconciled into its session's state from the server, no page effect;
// answered for a current owner: page effects on the page it was made on); a read made after a write never joins one
// made before it, for any resource, and a superseded read touches nothing; controls are reconciled from state after
// every redraw, and an answer keeps its scope (title, edition, seasons); a popup has a lifecycle (it toggles by its
// recorded source, Escape and Back close it with focus back on its arrow, and it is measured into the viewport).

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const posts = h => h.sent('POST', '/jellyseerr/request');

/** The search page's Seerr script with the real popup, buttons, cards and results modules. */
async function searchPage(t, options = {}) {
  const h = setup(t, { asks: false, ...options });
  h.JE.core.ui = { addTouchTapListener() {}, addDelegatedTouchTapListener() {} };
  h.JE.pluginConfig.ShowCollectionsInSearch = false;
  h.JE.cdn.selfhst = () => 'data:,';
  h.JE.hiddenContent = { getSettings: () => ({ enabled: false }), filterJellyseerrResults: results => results };
  for (const m of ['jellyseerr/ui/ui-popover.js', 'jellyseerr/ui/ui-badges.js', 'jellyseerr/ui/ui-buttons.js', 'jellyseerr/ui/ui-cards.js', 'jellyseerr/ui/ui-results.js']) h.load(m);
  Object.assign(h.JE.jellyseerrUI, { addMainStyles() {}, addSeasonModalStyles() {}, updateJellyseerrIcon() {} });
  h.JE.discoveryFilter = {};
  h.load('jellyseerr/jellyseerr.js'); h.JE.initializeJellyseerrScript();
  await delivered();
  return h;
}

/** A search card's request control configured by the real ui-buttons. */
function requestCard(h, item) {
  const card = h.document.createElement('div'); card.className = 'jellyseerr-card';
  const node = h.document.createElement('button'); node.className = 'jellyseerr-request-button';
  node.dataset.tmdbId = item.id; node.dataset.mediaType = item.mediaType;
  card.append(node); h.document.body.append(card);
  h.JE.jellyseerrUI.configureRequestButton(node, item, true, true);
  return card;
}

// ---------------------------------------------------------------- shape 8: three write outcomes

test('AX2-5: a Guard write the server accepted after its operation ended is reconciled: the mirror follows the server, reread and announced', async t => {
  const h = setup(t, { asks: false });
  h.JE.pluginConfig.SpoilerBlurEnabled = true;
  let serverGuard = false; let changes = 0;
  h.respond('GET', '/spoiler-blur/series', () => [200, serverGuard ? { PendingTmdb: { 'movie:603': { DisplayName: 'Movie A' } }, ProviderTitles: { 'movie:tmdb:603': {} } } : {}]);
  h.respond('POST', '/spoiler-blur/pending/movie/603', () => { serverGuard = true; return [200, { promoted: 'pending' }]; });
  h.load('enhanced/spoilerguard/ids.js'); h.load('enhanced/spoilerguard/state.js');
  const sg = h.JE.internals.spoilerGuard; await sg.whenLoaded();
  h.window.addEventListener('je-spoiler-policy-changed', () => changes++);
  const reads = h.sent('GET', '/spoiler-blur/series').length;
  const gate = h.hold('POST', '/spoiler-blur/pending/movie/603');
  const owner = h.a.generation();
  const writing = sg.enableForTmdb('movie', 603, 'Movie A', owner);
  await delivered(); assert.equal(h.sent('POST', '/spoiler-blur/pending/movie/603').length, 1);
  await h.leave(); gate.resolve(); await writing; await sg.whenLoaded(); await delivered();
  assert.equal(serverGuard, true);
  assert.equal(h.sent('GET', '/spoiler-blur/series').length, reads + 1, 'an authoritative reread');
  assert.equal(sg.isTmdbEnabled('movie', 603), true, 'the mirror follows the server');
  assert.equal(changes, 1, 'the policy change is announced');
});

test('AX2-6: a Guard toggle never sent (its operation ended first) announces nothing and leaves the next title\'s reviews alone', async t => {
  const h = setup(t, { asks: false });
  h.JE.pluginConfig.SpoilerBlurEnabled = true;
  h.JE.core.ui = { placeDetailAction: (row, button) => row.append(button) };
  for (const m of ['ids', 'state', 'image-refresh', 'detail-button']) h.load(`enhanced/spoilerguard/${m}.js`);
  const sg = h.JE.internals.spoilerGuard; await sg.whenLoaded();
  let reloads = 0; sg.scheduleFullReload = () => { reloads++; };
  h.page.id = 'itemDetailPage'; h.page.insertAdjacentHTML('afterbegin', '<h1 class="itemName">Old movie</h1>');
  sg.addSpoilerBlurButton('lib1', h.page, 'Movie');
  const guard = h.page.querySelector('.je-spoiler-blur-btn'); assert.ok(guard);
  const owner = h.a.generation(); const releasePool = h.holdPool();
  h.JE.press(guard, owner); await delivered();
  await h.leave('#/details?id=lib2');
  h.page.innerHTML = '<h1 class="itemName">New movie</h1><section class="tmdb-reviews-section">New movie reviews</section>';
  await releasePool(); await delivered();
  assert.equal(h.sent('POST', '/spoiler-blur/movies/lib1').length, 0);
  assert.ok(h.page.querySelector('.tmdb-reviews-section'), 'the next title\'s reviews stay');
  assert.ok(!h.toasts.includes('spoiler_blur_enabled_movie_toast'), 'no success announced');
  assert.equal(reloads, 0, 'no reload scheduled');
});

test('control: a Guard toggle for a current owner announces, strips its own page\'s reviews and reloads once', async t => {
  const h = setup(t, { asks: false });
  h.JE.pluginConfig.SpoilerBlurEnabled = true;
  h.JE.core.ui = { placeDetailAction: (row, button) => row.append(button) };
  for (const m of ['ids', 'state', 'image-refresh', 'detail-button']) h.load(`enhanced/spoilerguard/${m}.js`);
  const sg = h.JE.internals.spoilerGuard; await sg.whenLoaded();
  let reloads = 0; sg.scheduleFullReload = () => { reloads++; };
  h.page.id = 'itemDetailPage'; h.page.insertAdjacentHTML('afterbegin', '<h1 class="itemName">Old movie</h1><section class="tmdb-reviews-section">Reviews</section>');
  const elsewhere = h.document.createElement('section'); elsewhere.className = 'tmdb-reviews-section'; h.document.body.prepend(elsewhere);
  sg.addSpoilerBlurButton('lib1', h.page, 'Movie');
  h.click(h.page.querySelector('.je-spoiler-blur-btn')); await delivered(); await wait(20); await delivered();
  assert.equal(h.sent('POST', '/spoiler-blur/movies/lib1').length, 1);
  assert.ok(h.toasts.includes('spoiler_blur_enabled_movie_toast'));
  assert.equal(h.page.querySelector('.tmdb-reviews-section'), null, 'its page\'s reviews go');
  assert.ok(elsewhere.isConnected, 'reviews of another page are not its target');
  assert.equal(reloads, 1);
});

test('control: a viewer\'s own Seerr request from a search card still goes out after navigating during its rule lookup (the viewer asked)', async t => {
  const h = await searchPage(t);
  const card = requestCard(h, { id: 603, mediaType: 'movie', title: 'Movie A', mediaInfo: { status: 1 } });
  const gate = h.hold('GET', '/jellyseerr/overrideRule');
  h.click(card.querySelector('.jellyseerr-request-button')); await delivered();
  await h.leave(); gate.resolve(); await delivered();
  assert.equal(posts(h).length, 1);
});

// ---------------------------------------------------------------- shapes 4 and 9: reads fresh by epoch and intent

test('R10-9: a series completion\'s reread never adopts a status read that started before the 4K write (the newer state is kept)', async t => {
  const h = setup(t, { asks: false }); h.a.initialize(); await settle();
  await h.JE.jellyseerrMoreInfo.open(1399, 'tv', undefined, h.NATIVE); await delivered();
  const modal = moreInfo(h); assert.ok(modal);
  const internal = h.JE.internals.moreInfoModal;
  const draw = internal.renderActions; const seen = [];
  internal.renderActions = (data, type) => { seen.push({ status: data.mediaInfo?.status, status4k: data.mediaInfo?.status4k }); draw(data, type); };
  h.manager.clearCache();
  const oldRead = h.hold('GET', '/jellyseerr/tv/1399');
  h.JE.publication({ owner: h.NATIVE, surface: modal, identity: { tmdbId: 1399, mediaType: 'tv', variant: '1' } }).publish();
  await delivered();
  const readsBeforeWrite = h.sent('GET', '/jellyseerr/tv/1399').filter(r => !r[2].includes('ratings')).length;
  await h.JE.jellyseerrAPI.requestTvSeasons(1399, [1], {}, null, true, null, { bound: h.NATIVE.bound() });
  h.respond('GET', '/jellyseerr/tv/1399', [200, { id: 1399, name: 'Game of Thrones', mediaInfo: { status: 2, status4k: 2 }, seasons: [] }]);
  h.JE.publication({ owner: h.NATIVE, surface: modal, identity: { tmdbId: 1399, mediaType: 'tv', is4k: true, variant: '1' } }).publish();
  await delivered();
  assert.equal(h.sent('GET', '/jellyseerr/tv/1399').filter(r => !r[2].includes('ratings')).length, readsBeforeWrite + 1, 'the post-write read is its own');
  oldRead.resolve({ id: 1399, name: 'Game of Thrones', mediaInfo: { status: 2, status4k: 1 }, seasons: [] }); await delivered();
  assert.deepEqual(seen.at(-1), { status: 2, status4k: 2 }, 'the newer state stays drawn');
  assert.ok(!seen.some(s => s.status4k === 1 && seen.indexOf(s) > seen.findIndex(x => x.status4k === 2)), 'the older answer is never drawn after it');
});

test('R10-9: standard and 4K series requests answering close together → both editions are shown', async t => {
  const h = setup(t, { asks: false, seerr4k: true }); h.JE.pluginConfig.JellyseerrEnable4KTvRequests = true; h.load('jellyseerr/request-manager.js');
  await h.JE.jellyseerrMoreInfo.open(1399, 'tv', undefined, h.NATIVE); await delivered();
  const modal = moreInfo(h); assert.ok(modal.querySelector('.jellyseerr-split-main'));
  const standard = h.hold('POST', '/jellyseerr/request');
  h.click(modal.querySelector('.jellyseerr-split-main')); await delivered(); await wait(120);
  const form = seerrModal(h); assert.ok(form);
  h.click(form.querySelector('.jellyseerr-modal-button-primary')); await delivered();
  assert.equal(posts(h).length, 1);
  h.click(form.querySelector('.jellyseerr-modal-button-secondary')); await wait(30); await delivered();
  h.click(modal.querySelector('.jellyseerr-split-arrow')); await delivered();
  h.click(h.document.querySelector('.je-4k-popup-item')); await delivered(); await wait(120);
  const fourk = seerrModal(h); assert.notEqual(fourk, form);
  const firstRead = h.hold('GET', '/jellyseerr/tv/1399');
  standard.resolve(); await delivered();
  h.respond('GET', '/jellyseerr/tv/1399', [200, { ...SHOW, mediaInfo: { id: 78, status: 2, status4k: 2 } }]);
  h.click(fourk.querySelector('.jellyseerr-modal-button-primary')); await delivered();
  assert.equal(posts(h).length, 2); assert.equal(posts(h)[1][3].is4k, true);
  firstRead.resolve({ ...SHOW, mediaInfo: { id: 78, status: 2, status4k: 1 } }); await wait(30); await delivered();
  const chips = modal.querySelector('[data-mount="je-status-chip"]').textContent;
  assert.match(chips, /4K/, 'the 4K request stays visible');
});

test('AX2-12: Follow\'s reread after its write never joins (or is replaced by) a follows read from before it', async t => {
  const h = setup(t, { asks: false });
  h.JE.pluginConfig.ArrNotificationsEnabled = true; h.load('arr/notify/notify-core.js');
  const key = 'movie:tmdb:603'; let following = false;
  h.respond('PUT', '/acquire/follows', () => { following = true; return [200, {}]; });
  h.respond('GET', '/acquire/follows', () => [200, { follows: following ? [{ key }] : [] }]);
  const old = h.hold('GET', '/acquire/follows');
  const reading = h.JE.arrNotify.loadFollows(true); await delivered();
  const saving = h.JE.arrNotify.setFollow(key, true, h.a.generation()); await delivered();
  assert.equal(following, true);
  const result = await saving;
  old.resolve({ follows: [] }); await reading; await delivered();
  assert.equal(result.ok, true);
  assert.equal(h.sent('GET', '/acquire/follows').length, 2, 'the reread is a read of its own');
  assert.equal(h.JE.arrNotify.isFollowing(key), true);
});

test('AX2-13: an older Calendar range answering after the newer one leaves the newer period\'s events, state and page alone', async t => {
  const h = setup(t, { asks: false }); h.JE.cdn.selfhst = () => 'data:,';
  for (const m of ['calendar-page-data', 'calendar-page-render-events', 'calendar-page-render-views', 'calendar-page-actions']) h.load('arr/calendar/' + m + '.js');
  const p = h.JE.internals.calendarPage; p.state.viewMode = 'month'; p.state.currentDate = new h.window.Date('2026-10-01T12:00:00');
  p.state._customTabContainer = h.page;
  const october = h.hold('GET', '/arr/calendar?');
  const old = p.loadAllData(); await delivered();
  const november = h.hold('GET', '/arr/calendar?');
  p.shiftPeriod('next'); await delivered();
  november.resolve({ events: [{ id: 'november-title', title: 'November title', type: 'Movie', releaseDate: '2026-11-10T12:00:00', tmdbId: 604 }] }); await delivered();
  assert.ok(h.page.textContent.includes('November title'));
  october.resolve({ events: [{ id: 'october-title', title: 'October title', type: 'Movie', releaseDate: '2026-10-10T12:00:00', tmdbId: 603 }] }); await old; await delivered();
  assert.equal(p.state.currentDate.getMonth(), 10);
  assert.deepEqual(p.state.events.map(e => e.id), ['november-title']);
  assert.equal(p.state.isLoading, false);
  assert.ok(h.page.textContent.includes('November title'));
});

// ---------------------------------------------------------------- shape 10: reconcile from state, keep scope

test('AX2-4: the narrow More Info row keeps its adapted Follow and Report after a request redraws it (compact row too)', async t => {
  const h = setup(t, { asks: false });
  h.JE.pluginConfig.ArrNotificationsEnabled = true;
  h.load('arr/notify/notify-core.js');
  Object.defineProperty(h.window, 'innerWidth', { value: 390, configurable: true });
  h.a.initialize();
  await h.JE.jellyseerrMoreInfo.open(603, 'movie', undefined, h.NATIVE); await delivered(); h.a.scan(); await delivered();
  const row = moreInfo(h).querySelector('[data-mount="je-actions"]');
  const kinds = () => [...row.querySelectorAll('.je-actions-adapted')].map(n => n.dataset.jeActionKind).sort();
  const before = kinds();
  assert.deepEqual(before, ['follow', 'report']);
  h.click(row.querySelector('.jellyseerr-request-button')); await delivered(); h.a.scan(); await delivered();
  assert.equal(posts(h).length, 1);
  assert.deepEqual(kinds(), before);
});

test('AX2-11: a request for one season of two keeps the card\'s Request offered ("Request More") and its 4K arrow', async t => {
  const h = await searchPage(t);
  const item = { id: 1399, mediaType: 'tv', name: 'Two seasons', externalIds: { tvdbId: 121361 }, mediaInfo: { id: 78, status: 1, status4k: 1 }, seasons: [1, 2].map(n => ({ seasonNumber: n, episodeCount: 10, status: 1, airDate: '2011-04-17' })) };
  h.respond('GET', '/jellyseerr/tv/1399', [200, item]);
  h.respond('GET', '/jellyseerr/settings/partial-requests', [200, { partialRequestsEnabled: true }]);
  const card = requestCard(h, item);
  const request = card.querySelector('.jellyseerr-request-button'); assert.equal(request.disabled, false);
  h.click(request); await wait(120);
  const form = seerrModal(h); assert.ok(form);
  const boxes = [...form.querySelectorAll('.jellyseerr-season-item input[type=checkbox]')];
  assert.equal(boxes.length, 2); boxes.forEach((box, i) => { box.checked = i === 0; });
  h.click(form.querySelector('.jellyseerr-modal-button-primary')); await delivered();
  assert.deepEqual(posts(h)[0][3].seasons, [1]);
  assert.equal(request.disabled, false, 'season 2 can still be requested');
  assert.match(request.textContent, /jellyseerr_btn_request_more/);
});

test('control: a request for every season marks the card Requested', async t => {
  const h = await searchPage(t);
  const item = { id: 1399, mediaType: 'tv', name: 'Two seasons', externalIds: { tvdbId: 121361 }, mediaInfo: { id: 78, status: 1, status4k: 1 }, seasons: [1, 2].map(n => ({ seasonNumber: n, episodeCount: 10, status: 1, airDate: '2011-04-17' })) };
  h.respond('GET', '/jellyseerr/tv/1399', [200, item]);
  h.respond('GET', '/jellyseerr/settings/partial-requests', [200, { partialRequestsEnabled: true }]);
  const card = requestCard(h, item);
  const request = card.querySelector('.jellyseerr-request-button');
  h.click(request); await wait(120);
  const form = seerrModal(h);
  [...form.querySelectorAll('.jellyseerr-season-item input[type=checkbox]')].forEach(box => { box.checked = true; });
  h.click(form.querySelector('.jellyseerr-modal-button-primary')); await delivered();
  assert.equal(request.disabled, true);
  assert.match(request.textContent, /jellyseerr_btn_requested/);
});

// ---------------------------------------------------------------- shape 11: a real popup lifecycle

test('AX2-14: the search 4K arrow toggles its popup closed; Escape closes it with focus back on the arrow; a keyboard open focuses its item', async t => {
  const h = await searchPage(t, { seerr4k: true });
  const card = requestCard(h, { id: 603, mediaType: 'movie', title: 'Movie A', mediaInfo: { status: 1, status4k: 1 } });
  const arrow = card.querySelector('.jellyseerr-split-arrow');
  arrow.focus(); h.click(arrow); await delivered();
  assert.ok(h.document.querySelector('.jellyseerr-4k-popup'));
  h.click(arrow); await delivered();
  assert.equal(h.document.querySelector('.jellyseerr-4k-popup'), null, 'the second press closes it');
  // A keyboard (or remote) press: a click without a pointer.
  h.trusted(arrow, new h.window.MouseEvent('click', { bubbles: true, cancelable: true, detail: 0 })); await delivered();
  const popup = h.document.querySelector('.jellyseerr-4k-popup'); assert.ok(popup);
  assert.equal(h.document.activeElement, popup.querySelector('.jellyseerr-4k-popup-item'), 'its item takes focus');
  h.key(h.document.activeElement, 'Escape'); await delivered();
  assert.equal(popup.isConnected, false);
  assert.equal(h.document.activeElement, arrow, 'focus is back on the arrow');
  // A remote's Back key closes it too.
  h.click(arrow); await delivered();
  h.key(arrow, 'GoBack'); await delivered();
  assert.equal(h.document.querySelector('.jellyseerr-4k-popup'), null);
});

/** Lays out the popup and its anchor as a browser would (jsdom has no layout): rects by class. */
function layout(h, { anchor, popup, viewport }) {
  Object.defineProperty(h.window, 'innerWidth', { value: viewport.width, configurable: true });
  Object.defineProperty(h.window, 'innerHeight', { value: viewport.height, configurable: true });
  const rect = (r) => ({ ...r, right: r.left + r.width, bottom: r.top + r.height, x: r.left, y: r.top, toJSON() {} });
  const original = h.window.HTMLElement.prototype.getBoundingClientRect;
  h.window.HTMLElement.prototype.getBoundingClientRect = function () {
    if (this.matches('.jellyseerr-button-group')) return rect(anchor());
    if (this.matches('.jellyseerr-4k-popup')) return rect({ left: 0, top: 0, ...popup });
    return original.call(this);
  };
}

test('AX2-15: at a phone\'s bottom edge the popup opens above its button, inside the viewport, and follows a scroll', async t => {
  const h = await searchPage(t, { seerr4k: true });
  const card = requestCard(h, { id: 603, mediaType: 'movie', title: 'Movie A', mediaInfo: { status: 1, status4k: 1 } });
  let top = 800;
  layout(h, { anchor: () => ({ left: 360, top, width: 240, height: 36 }), popup: { width: 240, height: 40 }, viewport: { width: 390, height: 844 } });
  h.click(card.querySelector('.jellyseerr-split-arrow')); await delivered();
  const popup = h.document.querySelector('.jellyseerr-4k-popup');
  const at = () => ({ top: parseFloat(popup.style.top), left: parseFloat(popup.style.left), width: parseFloat(popup.style.width) });
  assert.equal(popup.dataset.jePlacement, 'above');
  assert.ok(at().top + 40 <= 844 - 8 && at().top >= 8, JSON.stringify(at()));
  assert.ok(at().left + at().width <= 390 - 8 && at().left >= 8, 'clamped inside the width: ' + JSON.stringify(at()));
  top = 200; h.window.dispatchEvent(new h.window.Event('scroll')); await delivered();
  assert.equal(popup.dataset.jePlacement, 'below', 'it follows the button');
  assert.equal(at().top, 200 + 36 + 4);
});

test('control: on a desktop with room below, the popup opens below its button at its width', async t => {
  const h = await searchPage(t, { seerr4k: true });
  const card = requestCard(h, { id: 603, mediaType: 'movie', title: 'Movie A', mediaInfo: { status: 1, status4k: 1 } });
  layout(h, { anchor: () => ({ left: 400, top: 300, width: 240, height: 36 }), popup: { width: 240, height: 40 }, viewport: { width: 1440, height: 1000 } });
  h.click(card.querySelector('.jellyseerr-split-arrow')); await delivered();
  const popup = h.document.querySelector('.jellyseerr-4k-popup');
  assert.equal(popup.dataset.jePlacement, 'below');
  assert.equal(popup.style.top, '340px'); assert.equal(popup.style.left, '400px'); assert.equal(popup.style.width, '240px');
});
