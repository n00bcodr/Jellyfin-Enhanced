import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, mount, settle, delivered, moreInfo, seerrModal, deferred } from '../helpers/title-actions-scopes.mjs';

// D46 slice 2 review round 10 (with the full-track audit): authority is explicit. Every effect (a write, a navigation,
// a window, sheet, form, popup or host dialog opening, a publication, a render) takes an owner token, checked as it
// happens; a native token is minted only from a trusted gesture (never from whatever event is being dispatched, nor
// from JE's own events), and every token carries its lifetimes: the session, the document and the semantic route (a
// search query and a hub tab included), through portals and child surfaces. Callbacks hold only a scoped handle. Each
// fetch → effect path re-checks its owner and generation right before it draws or navigates. Host dialogs are claimed
// by an explicit marker. Surfaces are admitted before they touch anything, close once (inert at once) and only the
// topmost one takes Escape. Real core transport and real owners; only the server is scripted.

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const posts = h => h.sent('POST', '/jellyseerr/request');

/** Watches refusals the way production meets them (logged, nothing opens or is sent) instead of throwing. */
function recordRefusals(h) {
  h.JE.strictOwners = 'record';
  h.JE.refusals = [];
  return () => h.JE.refusals || [];
}

/** A button on the page whose click handler is `body` (a handler property, as a planted onclick would be). */
function button(h, body) {
  const node = h.document.createElement('button');
  h.document.body.append(node);
  node.onclick = body;
  return node;
}

/** A host dialog container as jellyfin-web adds one, showing `text`; its OK closes it. */
function dialog(h, text) {
  const node = h.document.createElement('div'); node.className = 'dialogContainer';
  node.innerHTML = '<div class="text"></div><button class="btnOption">OK</button>';
  node.querySelector('.text').textContent = text;
  node.querySelector('button').onclick = () => node.remove();
  h.document.body.append(node);
  return node;
}

/** The search page's Seerr script with the real popup, buttons, cards and results modules. */
async function searchPage(t, { before, ...options } = {}) {
  const h = setup(t, { asks: false, seerr4k: true, ...options });
  h.JE.core.ui = { addTouchTapListener() {}, addDelegatedTouchTapListener() {} };
  h.JE.pluginConfig.ShowCollectionsInSearch = false;
  h.JE.cdn.selfhst = () => 'data:,';
  h.JE.hiddenContent = { getSettings: () => ({ enabled: false }), filterJellyseerrResults: results => results };
  for (const m of ['jellyseerr/ui/ui-popover.js', 'jellyseerr/ui/ui-badges.js', 'jellyseerr/ui/ui-buttons.js', 'jellyseerr/ui/ui-cards.js', 'jellyseerr/ui/ui-results.js']) h.load(m);
  Object.assign(h.JE.jellyseerrUI, { addMainStyles() {}, addSeasonModalStyles() {}, updateJellyseerrIcon() {} });
  h.JE.discoveryFilter = {};
  before?.(h);
  h.load('jellyseerr/jellyseerr.js'); h.JE.initializeJellyseerrScript();
  await delivered();
  return h;
}

/** A search card's request control configured by the real ui-buttons (a split button with its 4K arrow for a movie). */
function requestCard(h, item) {
  const card = h.document.createElement('div'); card.className = 'jellyseerr-card';
  const node = h.document.createElement('button'); node.className = 'jellyseerr-request-button';
  node.dataset.tmdbId = item.id; node.dataset.mediaType = item.mediaType;
  card.append(node); h.document.body.append(card);
  h.JE.jellyseerrUI.configureRequestButton(node, item, true, true);
  return card;
}

// ---------------------------------------------------------------- shape 1: every effect takes an explicit owner token

test('R10-1: an operation\'s press reaches the real requestMedia without its binding → nothing is read or sent, also after leaving', async t => {
  const h = setup(t, { asks: false }); const refusals = recordRefusals(h); h.a.initialize(); mount(h); await settle();
  const op = h.a.generation();
  const gate = h.hold('GET', '/jellyseerr/overrideRule');
  let done;
  const planted = button(h, () => { done = h.JE.jellyseerrAPI.requestMedia(603, 'movie', {}, false, { id: 603, title: 'Old title' }).catch(error => error); });
  h.JE.press(planted, op); await delivered();
  await h.leave('#/details?id=new-title');
  gate.resolve([]); await done; await delivered();
  assert.equal(posts(h).length, 0, 'no POST for the old title');
  assert.equal(h.sent('GET', '/jellyseerr/overrideRule').length, 0, 'nothing read for it either');
  assert.ok(refusals().some(m => /without its owner's binding/.test(m)), 'refused as a missing binding');
});

test('R10-1: a session-only binding taken inside an operation\'s press ends with it → the queued write is not sent after leaving', async t => {
  const h = setup(t, { asks: false }); h.a.initialize(); mount(h); await settle();
  const op = h.a.generation();
  const release = h.holdPool(); let done;
  const planted = button(h, () => { done = h.JE.core.api.plugin('/arr/session-only', { method: 'POST', body: { tmdbId: 603 }, bound: h.JE.createSessionAction().bound() }).catch(error => error); });
  h.JE.press(planted, op); await delivered();
  await h.leave('#/details?id=new-title');
  await release(); const outcome = await done; await delivered();
  assert.equal(h.sent('POST', '/arr/session-only').length, 0);
  assert.equal(h.JE.core.api.writeOutcome(outcome).outcome, 'unsent');
});

test('R10-2: JE\'s own navigation event, dispatched by a stale continuation, opens nothing natively (no owner, or an untrusted event)', async t => {
  const h = setup(t, { asks: false }); const refusals = recordRefusals(h); h.a.initialize(); mount(h); await settle();
  h.load('jellyseerr/nativedetails/native-details.js');
  h.JE.pluginConfig.NativeAbsentDetailsEnabled = false;
  const op = h.a.generation(); const gate = deferred(); let done;
  // One listener names no owner, the other takes one from the event being dispatched (JE's own je:navigate).
  h.window.addEventListener('je:navigate', () => h.JE.titleDetails.show(603, 'movie'));
  h.window.addEventListener('je:navigate', event => h.JE.titleDetails.show(604, 'movie', undefined, h.JE.ownerOf(event)));
  const planted = button(h, () => { done = gate.promise.then(() => h.window.history.replaceState({}, '', '#/details?id=newer-title')); });
  h.JE.press(planted, op);
  await h.leave('#/details?id=new-title');
  const reads = () => h.sent('GET', '/jellyseerr/movie/603').length + h.sent('GET', '/jellyseerr/movie/604').length;
  const before = reads();
  gate.resolve(); await done; await delivered();
  assert.equal(moreInfo(h), null, 'no window opened');
  assert.equal(reads(), before, 'nothing read for it');
  assert.equal(refusals().length, 2, 'both refused as owner-less');
});

test('R10-3: a native action wrapper run inside an operation\'s press is refused: the nested write is not sent', async t => {
  const h = setup(t, { asks: false }); const refusals = recordRefusals(h); h.a.initialize(); mount(h); await settle();
  const op = h.a.generation();
  const gesture = h.NATIVE;
  const nativeAction = h.JE.createSessionAction({ owner: gesture });
  let ran = false; let done = null;
  const planted = button(h, () => h.JE.runAs(nativeAction, () => {
    ran = true;
    done = h.JE.core.api.plugin('/arr/nested-write', { method: 'POST', body: { tmdbId: 999 } });
  }));
  h.JE.press(planted, op); await done?.catch(() => {}); await delivered();
  assert.equal(ran, false, 'the wrapper ran nothing');
  assert.equal(h.sent('POST', '/arr/nested-write').length, 0);
  assert.ok(refusals().some(m => /native owner inside an operation/.test(m)));
});

test('R10-4: JE.press with an ended owner dispatches nothing → a native onclick does not navigate over the newer title', async t => {
  const h = setup(t, { asks: false }); h.a.initialize(); mount(h); await settle();
  const op = h.a.generation();
  const native = button(h, () => { h.window.location.hash = '#/details?id=old-native-title'; });
  await h.leave('#/details?id=new-title');
  assert.equal(op.current(), false);
  assert.equal(h.JE.press(native, op), false);
  await delivered();
  assert.equal(h.window.location.hash, '#/details?id=new-title');
});

test('R10-5: a Discover poster pressed for an operation opens as that operation\'s; once it ended, or with no owner, nothing navigates', async t => {
  const h = setup(t, { asks: false }); const refusals = recordRefusals(h); h.a.initialize(); mount(h); await settle();
  h.JE.pluginConfig.NativeAbsentDetails = { Enabled: true, ContractVersion: 1 };
  h.load('jellyseerr/nativedetails/native-details.js'); h.load('arr/hub/hub-discover.js');
  const card = h.JE.internals.arrDiscover.buildCard({ key: 'movie:tmdb:603', kind: 'movie', tmdbId: 603, title: 'Old title', inLibrary: false }, { surface: 'discover', caps: null });
  h.document.body.append(card);
  const op = h.a.generation();
  await h.leave('#/details?id=new-title');
  assert.equal(h.JE.press(card.querySelector('.je-discover-poster-box'), op), false, 'an ended operation presses nothing');
  h.JE.titleDetails.open(603, 'movie');
  await delivered();
  assert.equal(h.window.location.hash, '#/details?id=new-title', 'nothing navigated');
  assert.ok(refusals().some(m => /a title page was called without an owner/.test(m)), 'the owner-less open is refused');
  // Control: a current operation's press opens the title as its own effect (no refusal).
  const before = refusals().length;
  const live = h.a.generation();
  h.JE.press(card.querySelector('.je-discover-poster-box'), live); await delivered();
  assert.match(h.window.location.hash, /^#\/details\?id=/);
  assert.notEqual(h.window.location.hash, '#/details?id=new-title');
  assert.equal(refusals().length, before);
});

test('controls: a trusted key press names the viewer\'s native owner; an untrusted (synthetic) one names none', async t => {
  const h = setup(t, { asks: false }); await settle();
  const opener = h.document.createElement('button'); h.document.body.append(opener);
  const seen = [];
  opener.addEventListener('keydown', e => seen.push(h.JE.ownerOf(e)));
  h.key(opener, 'Enter');
  opener.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  assert.equal(seen[0]?.native, true, 'the viewer\'s key press is native');
  assert.equal(seen[1], null, 'a synthetic one has no owner');
  // The token it minted carries the route: after a route change it is ended for page effects.
  await h.leave('#/details?id=other');
  assert.equal(seen[0].current(), false);
});

test('control: a native click that captures its owner before awaiting still opens More Info on the same route', async t => {
  const h = setup(t, { asks: false });
  const opener = h.document.createElement('button'); h.document.body.append(opener);
  opener.onclick = async e => { const owner = h.JE.ownerOf(e); await Promise.resolve(); await h.JE.jellyseerrMoreInfo.open(603, 'movie', undefined, owner); };
  h.click(opener); await delivered();
  assert.equal(moreInfo(h)?.dataset.tmdbId, '603');
  assert.equal(h.JE.ownerOf(moreInfo(h)).native, true);
});

test('controls: an unbound write inside a press is refused; a raw observer and a nested synthetic click open nothing', async t => {
  const h = setup(t, { asks: false }); const refusals = recordRefusals(h); h.a.initialize(); mount(h); await settle();
  const op = h.a.generation(); let done;
  const inner = button(h, e => h.JE.jellyseerrMoreInfo.open(603, 'movie', undefined, h.JE.ownerOf(e)));
  const outer = button(h, () => { done = h.JE.core.api.plugin('/arr/direct-write', { method: 'POST', body: {} }).catch(error => error); h.click(inner); });
  h.JE.press(outer, op); await done; await delivered();
  assert.equal(h.sent('POST', '/arr/direct-write').length, 0);
  assert.equal(moreInfo(h), null, 'the nested synthetic click has no owner');
  let observed = false;
  const observer = new h.window.MutationObserver(() => { observed = true; h.JE.jellyseerrMoreInfo.open(603, 'movie', undefined, h.JE.ownerOf(outer)); observer.disconnect(); });
  observer.observe(outer, { childList: true }); outer.append(h.document.createElement('i')); await delivered();
  assert.equal(observed, true); assert.equal(moreInfo(h), null, 'a node on the page is no native owner');
  assert.ok(refusals().length >= 2);
});

test('controls: write identities are independent; an ended operation\'s runner, host dialog and window do nothing', async t => {
  const h = setup(t, { asks: false }); h.a.initialize(); mount(h); await settle(); const op = h.a.generation();
  const surface = h.document.createElement('div'); h.document.body.append(surface);
  const pub = (id, type, is4k = false, variant) => h.JE.publication({ owner: op, surface, identity: { tmdbId: id, mediaType: type, is4k, variant } });
  const all = [pub(603, 'movie'), pub(603, 'movie', true), pub(603, 'tv'), pub(603, 'tv', false, '1,2'), pub(603, 'tv', false, '3'), pub(604, 'movie')];
  assert.deepEqual(all.map(x => x.current()), [true, true, true, true, true, true]);
  pub(603, 'movie'); assert.equal(all[0].current(), false); assert.equal(all[1].current(), true);
  h.JE.surfaceIntent(surface, op); assert.ok(all.every(x => !x.current()));
  await h.leave();
  let ran = false;
  h.JE.runAs(op, () => { ran = true; });
  h.JE.openHostDialog(() => { ran = true; }, op);
  assert.equal(ran, false);
  await h.JE.jellyseerrMoreInfo.open(603, 'movie', undefined, op); assert.equal(moreInfo(h), null);
});

test('control: the document lifecycle and every route step end an operation for good', async t => {
  const h = setup(t, { asks: false }); h.a.initialize(); mount(h); await settle();
  const op = h.a.generation(); h.pagehide(); h.pageshow(); assert.equal(op.current(), false);
  h.window.history.pushState({}, '', '#/details?id=other');
  h.window.dispatchEvent(new h.window.PopStateEvent('popstate'));
  h.window.history.replaceState({}, '', '#/details?id=x');
  assert.equal(op.current(), false);
  await h.JE.jellyseerrMoreInfo.open(603, 'movie', undefined, op); assert.equal(moreInfo(h), null);
});

// ---------------------------------------------------------------- shape 2: callbacks hold only a scoped handle

test('R10-6: a follower that reaches for a native owner while a publication publishes from a timer opens nothing', async t => {
  const h = setup(t, { asks: false }); const refusals = recordRefusals(h); h.a.initialize(); mount(h); await settle(); const op = h.a.generation();
  const surface = h.document.createElement('div'); surface.dataset.tmdbId = '603'; surface.dataset.mediaType = 'movie'; h.document.body.append(surface);
  let opened = null;
  h.JE.followPublications({ selector: '[data-tmdb-id="603"]' }, () => {
    opened = h.JE.jellyseerrMoreInfo.open(1399, 'tv', undefined, h.JE.routeOwner(h.JE.routeKey(), 'a follower'));
  });
  const publication = h.JE.publication({ owner: op, surface, identity: { tmdbId: 603, mediaType: 'movie' } });
  await new Promise(resolve => h.window.setTimeout(() => { publication.publish(); resolve(); }, 0));
  await opened; await delivered();
  assert.equal(moreInfo(h), null, 'no window for 1399');
  assert.ok(refusals().some(m => /route owner .* inside an operation/.test(m)));
});

test('R10-6: a publication\'s run from a raw timer restricts what runs inside it: an unbound write there is refused', async t => {
  const h = setup(t, { asks: false }); const refusals = recordRefusals(h); h.a.initialize(); mount(h); await settle(); const op = h.a.generation();
  const surface = h.document.createElement('div'); h.document.body.append(surface);
  const publication = h.JE.publication({ owner: op, surface, identity: { tmdbId: 603, mediaType: 'movie' } });
  let sent;
  await new Promise(resolve => h.window.setTimeout(() => { publication.run(() => { sent = h.JE.core.api.plugin('/arr/publication-write', { method: 'POST', body: { tmdbId: 999 } }).catch(error => error); }); resolve(); }, 0));
  await sent; await delivered();
  assert.equal(h.sent('POST', '/arr/publication-write').length, 0);
  assert.ok(refusals().some(m => /without its binding inside an operation/.test(m)));
});

test('R10-6: followers are declarative: no follower code runs to select nodes, and a publication of 999 leaves 603\'s window alone', async t => {
  const h = setup(t, { asks: false }); await settle();
  await h.JE.jellyseerrMoreInfo.open(603, 'movie', undefined, h.NATIVE); await delivered();
  const modal = moreInfo(h); const request = modal.querySelector('.jellyseerr-request-button'); assert.ok(request);
  const label = request.textContent;
  let selected = 0; let applied = 0;
  // A candidates callback (the old shape) is not a follower at all: it never runs.
  h.JE.followPublications(() => { selected++; request.textContent = 'WRONG TITLE REQUESTED'; return [modal]; }, () => { applied++; });
  h.JE.followPublications({ selector: '.je-more-info-modal' }, () => { applied++; });
  const origin = h.document.createElement('div'); origin.dataset.tmdbId = '999'; origin.dataset.mediaType = 'movie'; h.document.body.append(origin);
  h.JE.publication({ owner: h.NATIVE, surface: origin, identity: { tmdbId: 999, mediaType: 'movie' } }).publish();
  assert.equal(selected, 0); assert.equal(applied, 0);
  assert.equal(request.textContent, label);
});

test('controls: the card followers are registered once per bundle (not per card); a window follows while open and is released on close', async t => {
  const h = setup(t, { asks: false }); let following = 0; let total = 0;
  const follow = h.JE.followPublications;
  h.JE.followPublications = (...args) => { following++; total++; const off = follow(...args); let active = true; return () => { if (active) { active = false; following--; } return off(); }; };
  h.JE.core.ui = { addTouchTapListener() {}, addDelegatedTouchTapListener() {} };
  h.JE.cdn = { url: () => 'data:,', selfhst: () => 'data:,' };
  h.JE.hiddenContent = { getSettings: () => ({ enabled: false }) };
  for (const path of ['jellyseerr/ui/ui-popover.js', 'jellyseerr/ui/ui-badges.js', 'jellyseerr/ui/ui-buttons.js', 'jellyseerr/ui/ui-cards.js', 'jellyseerr/ui/ui-results.js']) h.load(path);
  const row = h.document.createElement('div'); h.document.body.append(row);
  for (let id = 1000; id < 1500; id++) row.append(h.JE.jellyseerrUI.createJellyseerrCard({ id, mediaType: 'movie', title: 'Card', mediaInfo: { status: 1, status4k: 1 } }, true, true));
  assert.equal(total, 2); assert.equal(following, 2);
  for (let count = 0; count < 3; count++) {
    await h.JE.jellyseerrMoreInfo.open(603, 'movie', undefined, h.NATIVE); await delivered(); assert.equal(following, 3);
    h.JE.jellyseerrMoreInfo.close(); assert.equal(following, 2);
    moreInfo(h)?.remove(); h.JE.internals.moreInfoModal.state.currentModal = null;
  }
});

// ---------------------------------------------------------------- shape 3: every await carries its generation

/** The search page with a scripted search and a drawn marker, its first search answered. */
async function searchWithMarker(t, query) {
  const h = await searchPage(t, { before: h => {
    h.document.body.insertAdjacentHTML('beforeend', `<div id="searchPage"><input id="searchTextInput" value="${query}"><div id="drawn"></div></div>`);
    h.JE.jellyseerrUI.renderJellyseerrResults = results => { h.document.querySelector('#drawn').textContent = results.map(r => r.title).join(','); };
    h.JE.jellyseerrUI.hideHoverPopover = () => {}; h.JE.jellyseerrUI.toggleHoverPopoverLock = () => {};
    h.window.history.replaceState({}, '', `#/search?query=${query}`);
    h.respond('GET', '/jellyseerr/search', [200, { results: [{ id: 999, mediaType: 'movie', title: 'Initial' }], page: 1, totalPages: 1 }]);
  } });
  await wait(350); await delivered();
  return h;
}

test('R10-7: the delayed 4K refresh\'s search answers after pagehide and pageshow → the restored page is not redrawn with it', async t => {
  const h = await searchWithMarker(t, 'same');
  const searches = () => h.sent('GET', '/jellyseerr/search').length;
  const before = searches();
  const op = h.a.generation();
  const card = requestCard(h, { id: 603, mediaType: 'movie', title: 'Old title', mediaInfo: { status: 1, status4k: 1 } });
  h.JE.press(card.querySelector('.jellyseerr-split-arrow'), op); await delivered();
  const gate = h.hold('GET', '/jellyseerr/search');
  h.JE.press(h.document.querySelector('.jellyseerr-4k-popup-item'), op); await delivered();
  assert.equal(posts(h).length, 1);
  await wait(1050); await delivered(); assert.equal(searches(), before + 1, 'the refresh GET started');
  h.pagehide(); h.pageshow(); assert.equal(op.current(), false);
  h.document.querySelector('#drawn').textContent = 'Restored page';
  gate.resolve({ results: [{ id: 603, mediaType: 'movie', title: 'Stale refresh title 603' }], page: 1, totalPages: 1 });
  await wait(400); await delivered();
  assert.equal(h.document.querySelector('#drawn').textContent, 'Restored page');
});

test('control: the delayed 4K refresh with the same search and its operation standing redraws once', async t => {
  const h = await searchWithMarker(t, 'same');
  const op = h.a.generation();
  const card = requestCard(h, { id: 603, mediaType: 'movie', title: 'Old title', mediaInfo: { status: 1, status4k: 1 } });
  h.JE.press(card.querySelector('.jellyseerr-split-arrow'), op); await delivered();
  h.respond('GET', '/jellyseerr/search', [200, { results: [{ id: 603, mediaType: 'movie', title: 'Refreshed' }], page: 1, totalPages: 1 }]);
  h.JE.press(h.document.querySelector('.jellyseerr-4k-popup-item'), op); await delivered();
  await wait(1500); await delivered();
  assert.equal(h.document.querySelector('#drawn').textContent, 'Refreshed');
});

test('R10-8: a Calendar title clicked, then another page opened before the provider lookup answers → it stays on the newer page', async t => {
  const h = setup(t, { asks: false }); h.a.initialize(); await settle();
  const gate = h.hold('GET', '/items/by-providers');
  h.load('arr/calendar/calendar-page-data.js');
  h.JE.internals.calendarPage.state.events = [{ id: 'a', type: 'Series', hasFile: true, tmdbId: 1399, tvdbId: 121361 }];
  h.load('arr/calendar/calendar-page-actions.js');
  const node = h.document.createElement('button'); node.className = 'je-calendar-event'; node.dataset.eventId = 'a'; h.document.body.append(node);
  node.addEventListener('click', h.JE.internals.calendarPage.handleEventClick);
  h.click(node); await delivered();
  assert.equal(h.sent('GET', '/items/by-providers').length, 1);
  await h.leave('#/details?id=new-title');
  gate.resolve('11111111111111111111111111111111'); await delivered();
  assert.equal(h.window.location.hash, '#/details?id=new-title');
});

test('control: the Calendar click whose lookup answers on the same page navigates to the title', async t => {
  const h = setup(t, { asks: false }); h.a.initialize(); await settle();
  h.respond('GET', '/items/by-providers', [200, '11111111111111111111111111111111']);
  h.load('arr/calendar/calendar-page-data.js');
  h.JE.internals.calendarPage.state.events = [{ id: 'a', type: 'Series', hasFile: true, tmdbId: 1399, tvdbId: 121361 }];
  h.load('arr/calendar/calendar-page-actions.js');
  const node = h.document.createElement('button'); node.className = 'je-calendar-event'; node.dataset.eventId = 'a'; h.document.body.append(node);
  node.addEventListener('click', h.JE.internals.calendarPage.handleEventClick);
  h.click(node); await delivered();
  assert.equal(h.window.location.hash, '#/details?id=11111111111111111111111111111111');
});

// ---------------------------------------------------------------- shape 5: openings correlate by identity

test('R10-10: a quota dialog whose host alert throws leaves no opening behind → the next quota dialog stays', async t => {
  const h = setup(t, { asks: false }); h.a.initialize(); mount(h); await settle();
  const error = { status: 403, responseJSON: { message: 'Movie quota exceeded' } };
  const first = h.a.generation();
  const alert = h.window.Dashboard.alert;
  h.window.Dashboard.alert = () => { throw new Error('host alert failed before attaching'); };
  await h.JE.jellyseerrUI.showQuotaErrorDialog(error, 'movie', first);
  assert.equal(h.toasts.length, 1, 'the toast fallback ran');
  h.pagehide(); h.pageshow(); await delivered(); assert.equal(first.current(), false);
  h.window.Dashboard.alert = alert;
  await h.JE.jellyseerrUI.showQuotaErrorDialog(error, 'movie', h.a.generation()); await delivered();
  assert.equal(h.alerts.length, 1);
  assert.equal(h.document.querySelectorAll('.dialogContainer').length, 1, 'the current quota message stays');
  // …and a native confirmation after it stays too.
  h.JE.openHostDialog(() => dialog(h, 'Unrelated native confirmation'), h.NATIVE); await delivered();
  assert.equal(h.document.querySelectorAll('.dialogContainer').length, 2);
});

test('R10-10: an opening that adds no container never claims a later native one', async t => {
  const h = setup(t, { asks: false }); h.a.initialize(); mount(h); await settle();
  h.JE.openHostDialog(() => undefined, h.a.generation());
  h.pagehide(); await delivered();
  h.JE.openHostDialog(() => dialog(h, 'native confirmation'), h.NATIVE); await delivered();
  assert.equal(h.document.querySelectorAll('.dialogContainer').length, 1);
});

test('R10-10: two dialogs with the same title arriving out of order: the marked owned one goes with its owner, the native one stays', async t => {
  const h = setup(t, { asks: false }); h.a.initialize(); mount(h); await settle();
  let late;
  h.JE.openHostDialog(mark => { late = () => dialog(h, mark('quota title')); }, h.a.generation());
  h.pagehide(); await delivered();
  const native = h.JE.openHostDialog(() => dialog(h, 'quota title'), h.NATIVE);
  await delivered(); const owned = late(); await delivered();
  assert.equal(native.isConnected, true, 'the native dialog survives');
  assert.equal(owned.isConnected, false, 'the owned one is dismissed as it arrives');
});

// ---------------------------------------------------------------- shape 6: owner tokens carry their full lifetime

test('AX2-2: a native season form whose settings read spans an account switch → nothing opens for the new account', async t => {
  const h = setup(t, { asks: false });
  const gate = h.hold('GET', '/jellyseerr/settings/partial-requests');
  const opening = h.JE.jellyseerrUI.showSeasonSelectionModal(1399, 'tv', 'User A title', null, false, h.NATIVE, h.page);
  await delivered();
  h.switchUser(); gate.resolve();
  await opening; await delivered();
  assert.equal(seerrModal(h), null);
  assert.equal(h.sent('GET', '/jellyseerr/tv/1399').filter(r => r[0] === 'user-b').length, 0, 'nothing read as the new account');
});

test('AX2-2: an open native advanced form closes on an account switch, and its Save sends nothing as the new account', async t => {
  const h = setup(t, { asks: false, advanced: true });
  await h.JE.jellyseerrUI.showMovieRequestModal(603, 'User A title', null, false, h.NATIVE, h.page);
  await wait(120);
  const form = seerrModal(h); assert.ok(form?.classList.contains('show'));
  form.querySelector('#movie-quality').value = '4';
  form.querySelector('#movie-folder').value = '/movies';
  h.switchUser(); await delivered();
  assert.equal(form.classList.contains('show'), false, 'closed');
  assert.ok(form.hasAttribute('inert'));
  h.click(form.querySelector('.jellyseerr-modal-button-primary')); await delivered();
  assert.equal(posts(h).length, 0);
});

test('AX2-3: the search card\'s 4K popup is its opener\'s: after navigation it is gone and its button sends nothing', async t => {
  const h = await searchPage(t);
  const card = requestCard(h, { id: 603, mediaType: 'movie', title: 'Movie A', mediaInfo: { status: 1, status4k: 1 } });
  const owner = h.a.generation();
  h.JE.press(card.querySelector('.jellyseerr-split-arrow'), owner); await delivered();
  const popup = h.document.querySelector('.jellyseerr-4k-popup'); assert.ok(popup);
  assert.equal(h.JE.scopeOf(popup), owner, 'registered for the operation that opened it');
  await h.leave();
  assert.equal(popup.isConnected, false);
  h.click(popup.querySelector('button')); await delivered();
  assert.equal(posts(h).length, 0);
});

test('AX2-7: a new search query and a hub tab change are route changes: a held bound request is not sent', async t => {
  const h = setup(t, { asks: false });
  h.window.history.replaceState({}, '', '#/search?query=old');
  const owner = h.a.generation(() => h.page.isConnected);
  const gate = h.hold('GET', '/jellyseerr/overrideRule');
  const pending = h.JE.jellyseerrAPI.requestMedia(603, 'movie', {}, false, { id: 603 }, null, { bound: h.JE.captureSubmitted(owner).bound() }).catch(error => error);
  await delivered();
  h.window.history.replaceState({}, '', '#/search?query=new');
  assert.equal(owner.current(), false);
  gate.resolve(); await pending;
  assert.equal(posts(h).length, 0);
  h.window.history.replaceState({}, '', '#/requests?tab=discover');
  const hub = h.a.generation();
  h.window.history.replaceState({}, '', '#/requests?tab=calendar');
  assert.equal(hub.current(), false);
});

test('AX2-7: a card\'s More opener whose admission answers after the search query changed → no sheet', async t => {
  const h = await searchPage(t); h.window.history.replaceState({}, '', '#/search?query=old');
  requestCard(h, { id: 603, mediaType: 'movie', title: 'Movie A', mediaInfo: { status: 1 } }); h.a.initialize(); h.a.scan();
  const admission = h.hold('GET', '/title-actions/movie/603');
  h.click(h.document.querySelector('.je-card-more')); await delivered();
  assert.equal(h.sent('GET', '/title-actions/movie/603').length, 1);
  h.window.history.replaceState({}, '', '#/search?query=new');
  admission.resolve(); await delivered();
  assert.equal(h.document.querySelector('.je-actions-sheet'), null);
});

// ---------------------------------------------------------------- shape 7: one terminal surface lifecycle

test('AX2-1: a Collection form whose advanced-options read answers after its operation ended → nothing is shown', async t => {
  const h = setup(t, { asks: false, advanced: true });
  await h.JE.jellyseerrAPI.checkUserStatus();
  const owner = h.a.generation();
  const gate = h.hold('GET', '/jellyseerr/radarr');
  const opening = h.JE.jellyseerrUI.showCollectionRequestModal(2344, 'Collection A', null, { operation: owner, origin: h.page });
  await delivered();
  await h.leave(); await wait(350);
  gate.resolve(); await opening; await delivered();
  assert.equal(seerrModal(h)?.isConnected ?? false, false);
});

test('AX2-8: a sheet shown for an ended owner leaves the current sheet alone and reports nothing opened', async t => {
  const h = setup(t, { asks: false });
  const ended = h.a.generation(); await h.leave();
  const live = h.a.generation();
  h.a.show({ name: 'Current title' }, [], h.page, live);
  const result = h.a.show({ name: 'Old title' }, [], h.page, ended);
  await delivered();
  assert.equal(result, false);
  assert.equal(h.document.querySelector('.je-actions-subtitle')?.textContent, 'Current title');
  assert.ok(h.document.querySelector('.je-actions-backdrop'));
});

test('AX2-9: a dismissed request form is inert at once: Save during its exit animation sends nothing, focus goes back', async t => {
  const h = setup(t, { asks: false, advanced: true });
  const opener = h.document.createElement('button'); h.document.body.append(opener); opener.focus();
  await h.JE.jellyseerrUI.showMovieRequestModal(603, 'Movie A', null, false, h.NATIVE, h.page);
  await wait(120);
  const form = seerrModal(h); assert.ok(form);
  form.querySelector('#movie-quality').value = '4';
  form.querySelector('#movie-folder').value = '/movies';
  const primary = form.querySelector('.jellyseerr-modal-button-primary');
  primary.focus();
  h.key(primary, 'Escape'); await wait(40);
  assert.equal(form.classList.contains('show'), false);
  assert.equal(primary.disabled, true); assert.ok(form.hasAttribute('inert'));
  assert.equal(h.document.activeElement, opener, 'focus is back on its opener');
  h.click(primary); h.key(primary, 'Enter'); await delivered();
  assert.equal(posts(h).length, 0);
});

test('AX2-10: Escape in a request form closes the form only; the More Info window underneath stays', async t => {
  const h = setup(t, { asks: false, advanced: true });
  await h.JE.jellyseerrMoreInfo.open(603, 'movie', undefined, h.NATIVE); await delivered();
  const info = moreInfo(h); h.click(info.querySelector('.jellyseerr-request-button'));
  await wait(120); const form = seerrModal(h); assert.ok(form?.classList.contains('show'));
  form.querySelector('.jellyseerr-modal-button-primary').focus();
  h.key(form.querySelector('.jellyseerr-modal-button-primary'), 'Escape'); await delivered();
  assert.equal(form.classList.contains('show'), false, 'the form closed');
  assert.ok(!info._isClosing, 'the window stays');
  h.key(info, 'Escape'); await delivered();
  assert.equal(info._isClosing, true, 'then Escape closes the window');
});

test('AX2-9: a popstate that did not leave the form\'s history entry (queued by a navigation just before) closes nothing; Back closes it', async t => {
  const h = setup(t, { asks: false, advanced: true });
  await h.JE.jellyseerrUI.showMovieRequestModal(603, 'Movie A', null, false, h.NATIVE, h.page);
  await wait(120);
  const form = seerrModal(h); assert.ok(form?.classList.contains('show'));
  h.window.dispatchEvent(new h.window.PopStateEvent('popstate', { state: h.window.history.state }));
  await delivered();
  assert.ok(form.classList.contains('show'), 'a stale popstate leaves it open');
  h.window.history.back(); await wait(20); await delivered();
  assert.equal(form.classList.contains('show'), false, 'Back closes it');
});

test('control (D46S2-R11-1 replaces Q-D46S2FIX10-2): focus alone is no gesture; the host\'s own verified gamepad activation of the focused control is the viewer\'s, and inside an operation\'s press it is refused', async t => {
  const h = setup(t, { asks: false }); const refusals = recordRefusals(h); h.a.initialize(); mount(h); await settle();
  const seen = [];
  const focused = h.document.createElement('button'); h.document.body.append(focused);
  const other = h.document.createElement('button'); h.document.body.append(other);
  for (const node of [focused, other]) node.addEventListener('click', e => seen.push(h.JE.ownerOf(e)));
  /** jellyfin-web's gamepad OK (its gamepad-to-key module): a keyup Event on the focused element, then its click(). */
  const gamepadOk = () => {
    const key = new h.window.Event('keyup', { bubbles: true, cancelable: true });
    key.key = 'GamepadA'; key.keyCode = 13;
    const target = h.document.activeElement;
    target.dispatchEvent(key);
    if (!key.defaultPrevented) target.click();
  };
  focused.focus();
  focused.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  assert.equal(seen[0], null, 'a synthetic click on the focused control is no one\'s');
  gamepadOk();
  assert.equal(seen[1]?.native, true, 'the host\'s own activation of the focused control is native');
  other.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  assert.equal(seen[2], null, 'another control\'s synthetic click has no owner');
  // Inside an operation's press, the host's activation is refused (that operation acts).
  const outer = button(h, () => gamepadOk());
  h.JE.press(outer, h.a.generation()); await delivered();
  assert.equal(seen[3], null);
  assert.ok(refusals().some(m => /native owner was minted inside an operation/.test(m)));
});
