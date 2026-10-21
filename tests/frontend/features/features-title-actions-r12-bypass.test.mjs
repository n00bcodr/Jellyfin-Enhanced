import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, mount, settle, delivered, moreInfo, seerrModal, MEMBER } from '../helpers/title-actions-scopes.mjs';
import { hostInput, HOSTS } from '../helpers/host-input.mjs';

// D46 slice 2 review round 12: the finite boundary cells behind the round's bypass inventory (B01–B43). Each grouped path
// meets ONE common enforcement point: the transport verifies every write's binding by the core's record (whatever its
// route or method); a press is bound to its dispatch and target; every interaction inside a surface is checked as a
// press of its own at the surface's root; the one stack decides who takes keys and focus and covers what is under the
// topmost modal surface; openings are admitted before they change anything shared; offers finish; a sent write keeps
// its facts. A legitimate control accompanies each refusal.

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

// ------------------------------------------------------------------ R1 (B01–B09): every write meets the core at the send

/** Every title-action write route and method the bar can reach (B01–B08), sent through the core transport. */
const ROUTES = [
  ['B01 ask', 'POST', '/acquire/requests', { clientRequestId: 'x', input: { key: 'movie:tmdb:603', kind: 'movie' } }],
  ['B02 cancel', 'POST', `/acquire/requests/${'a'.repeat(32)}/cancel`, {}],
  ['B03 admin Search', 'POST', '/arr/admin/manage/search', { instanceId: 'r1', key: 'movie:tmdb:603' }],
  ['B04 family Search', 'POST', '/acquire/requests/search', { key: 'movie:tmdb:603' }],
  ['B05 queue action', 'POST', '/arr/admin/queue/action', { action: 'remove' }],
  ['B06 Manage add', 'POST', '/arr/admin/manage/add', { instanceId: 'r1' }],
  ['B07 Hide rule (PUT)', 'PUT', '/user-settings/user-a/hidden-content/rule/movie%3Atmdb%3A603', {}],
  ['B07 Hide rule (DELETE)', 'DELETE', '/user-settings/user-a/hidden-content/rule/movie%3Atmdb%3A603', undefined],
  ['B08 Guard series (POST)', 'POST', '/spoiler-blur/series/k', undefined],
  ['B08 Guard series (DELETE)', 'DELETE', '/spoiler-blur/series/k', undefined],
  ['B08 Guard movie (POST)', 'POST', '/spoiler-blur/movies/k', { MovieName: '' }],
  ['B08 Guard movie (DELETE)', 'DELETE', '/spoiler-blur/movies/k', undefined],
  ['B08 Guard collection (POST)', 'POST', '/spoiler-blur/collections/k', { CollectionName: '' }],
  ['B08 Guard collection (DELETE)', 'DELETE', '/spoiler-blur/collections/k', undefined],
  ['B08 Guard pending (POST)', 'POST', '/spoiler-blur/pending/movie/603', undefined],
  ['B08 Guard pending (DELETE)', 'DELETE', '/spoiler-blur/pending/movie/603', undefined],
  ['B08 Guard user prefs', 'POST', '/spoiler-blur/user-prefs', {}],
  ['Seerr request', 'POST', '/jellyseerr/request', { mediaId: 603 }],
  ['Seerr issue', 'POST', '/jellyseerr/issue', { mediaId: 603 }],
  ['Follow', 'PUT', '/acquire/follows', { key: 'movie:tmdb:603', on: true }],
  ['Remind', 'POST', '/acquire/remind', { key: 'movie:tmdb:603' }],
];
const send = (h, method, path, body, bound, extra = {}) => h.JE.core.api.plugin(path, { method, body, skipRetry: true, bound, ...extra }).then(v => ({ v }), e => ({ e }));
const sentTo = (h, method, path) => h.requests.filter(r => r[1] === method && r[2] === path);

for (const [name, method, path, body] of ROUTES) {
  test(`R12-1 ${name} (${method} ${path}): an ended token, A's token with B's session, and a binding the core never made send nothing; a current binding sends once`, async t => {
    const h = setup(t);
    const ended = h.a.generation();
    await h.leave('#/details?id=next');
    let r = await send(h, method, path, body, { token: ended, session: ended.session, current: () => true });
    assert.equal(h.JE.core.api.writeOutcome(r.e).outcome, 'unsent');
    const tokenA = h.a.generation();
    h.JE.strictOwners = 'record'; h.JE.refusals = [];
    r = await send(h, method, path, body, { session: { userId: 'user-a', serverId: 'server-a', token: 'test-token', current: () => true }, current: () => true });
    assert.equal(h.JE.core.api.writeOutcome(r.e).outcome, 'unsent', 'a session the core never captured');
    assert.ok(h.JE.refusals.some(m => /a binding the core did not make/.test(m)), 'refused with its diagnostic');
    h.JE.strictOwners = true;
    h.switchUser(); await delivered();
    r = await send(h, method, path, body, { token: tokenA, session: h.NATIVE.session, current: () => true });
    assert.equal(h.JE.core.api.writeOutcome(r.e).outcome, 'unsent');
    assert.equal(sentTo(h, method, path).length, 0, 'nothing reached the server');
    const current = h.a.generation();
    r = await send(h, method, path, body, current.bound());
    assert.equal(r.e, undefined, String(r.e?.stack || ''));
    assert.deepEqual(sentTo(h, method, path).map(w => w[0]), ['user-b'], 'the current binding sends once, as its own session');
  });
}

for (const [name, method, path, body] of ROUTES.filter(([n]) => /^B0[1-6]|Hide rule \(PUT\)|pending \(POST\)/.test(n))) {
  test(`R12-1 ${name}: its token ends while the write waits in the queue → released, nothing is sent (checked after the wait)`, async t => {
    const h = setup(t);
    const op = h.a.generation();
    const release = h.holdPool();
    const pending = send(h, method, path, body, op.bound());
    await settle();
    op.end();
    await release();
    const r = await pending;
    assert.equal(h.JE.core.api.writeOutcome(r.e).outcome, 'unsent');
    assert.equal(sentTo(h, method, path).length, 0);
  });
}

test('R12-1: a sent write\'s retry is checked again before it goes out: the token ended after the first attempt → no second send, the first attempt\'s answer stays (sent, failed)', async t => {
  const h = setup(t);
  const op = h.a.generation();
  // The first attempt is sent; its owner ends while it is answered (503, retryable).
  h.respond('POST', '/acquire/remind', () => { op.end(); return [503, { message: 'busy' }]; });
  const r = await h.JE.core.api.plugin('/acquire/remind', { method: 'POST', body: { key: 'movie:tmdb:603' }, bound: op.bound() }).then(v => ({ v }), e => ({ e }));
  assert.equal(sentTo(h, 'POST', '/acquire/remind').length, 1, 'the retry was refused at its own send');
  assert.equal(r.e?.status, 503);
  assert.deepEqual({ ...h.JE.core.api.writeOutcome(r.e) }, { outcome: 'failed', sent: true });
});

test('R12-1 (B09): the notification read acknowledgement is sent with its explicit session-only binding (the session the core captured)', async t => {
  const h = setup(t);
  h.load('arr/notify/notify-core.js');
  await h.JE.arrNotify.markRead([1]);
  assert.equal(sentTo(h, 'POST', '/acquire/notify/read').length, 1, 'positive control: sent');
  assert.equal(sentTo(h, 'POST', '/acquire/notify/read')[0][0], 'user-a');
});

test('R12-1: a read-only POST says so (readOnly) and moves no write epoch; a write does', async t => {
  const h = setup(t);
  const before = h.JE.core.api.writeEpoch('arr');
  await h.JE.core.api.plugin('/arr/calendar/user-data', { method: 'POST', body: { events: [] }, readOnly: true });
  assert.equal(h.JE.core.api.writeEpoch('arr'), before, 'the lookup moved nothing');
  await h.JE.core.api.plugin('/arr/admin/manage/search', { method: 'POST', body: {}, bound: h.a.generation().bound() });
  assert.ok(h.JE.core.api.writeEpoch('arr') > before);
});

// ------------------------------------------------------------------ R5 (B43): sent facts at every await

for (const mode of ['json', 'status']) {
  for (const at of ['response', 'body']) {
    test(`R12-4 (B43, ${mode}): a write sent, then its owner's route ends at the ${at} await → accepted for its origin, never unsent`, async t => {
      const h = setup(t);
      const op = h.a.generation();
      const gate = at === 'response' ? h.hold('POST', '/acquire/remind') : null;
      let release;
      const bodyHeld = new Promise(resolve => { release = resolve; });
      if (at === 'body') {
        const fetch = h.window.fetch;
        h.window.fetch = async (...args) => { const response = await fetch(...args); const text = await response.text(); return { ok: true, status: 200, headers: response.headers, clone() { return this; }, text: async () => { await bodyHeld; return text; } }; };
      }
      const pending = h.JE.core.api.plugin('/acquire/remind', { method: 'POST', body: {}, bound: op.bound(), responseMode: mode, skipRetry: true }).then(v => ({ v }), e => ({ e }));
      await settle();
      assert.equal(sentTo(h, 'POST', '/acquire/remind').length, 1);
      await h.leave('#/movies');
      gate?.resolve({ nextAt: 'later' }); release();
      const r = await pending;
      const outcome = h.JE.core.api.writeOutcome(r.e);
      assert.equal(outcome.outcome, 'accepted');
      assert.equal(outcome.sessionChanged, false);
      assert.equal(r.e.jeSent, true);
    });
  }
}

// ------------------------------------------------------------------ R2 (B10): a kept event authorizes nothing later

test('R12-2 (B10): a trusted gesture kept for later names no one once its dispatch is over; during it, every listener resolves the same owner', async t => {
  const h = setup(t);
  const node = h.document.createElement('button'); h.document.body.append(node);
  let kept, first, second;
  node.addEventListener('click', e => { kept = e; first = h.JE.ownerOf(e); }, true);
  node.addEventListener('click', e => { second = h.JE.ownerOf(e); });
  h.click(node);
  assert.ok(first);
  assert.equal(second, first, 'capture and target listeners of one press resolve one owner');
  assert.equal(h.JE.ownerOf(kept), null, 'after its dispatch it names no one');
  assert.equal(h.JE.nativeFrom(kept), null);
});

// ------------------------------------------------------------------ R3 (B11–B21): every final interaction is a press

/** A surface's control: a script's interaction does nothing (the surface stays, nothing is written); the viewer's acts. */
async function finalPress(h, control, { stays, acted }) {
  control.click(); await delivered();
  assert.ok(stays(), 'a script\'s click changes nothing');
  h.click(control); await delivered();
  assert.ok(acted(), 'the viewer\'s press acts');
}

test('R12-3 (B13): the request sheet\'s Cancel, backdrop and pickers take only the viewer\'s press', async t => {
  const h = setup(t);
  const SERIES = { key: 'tv:tmdb:1399', kind: 'series', name: 'Show', seasons: [{ season: 1, episodes: 10 }, { season: 2, episodes: 10 }] };
  h.JE.arrAskSheet.open(SERIES, { operation: h.NATIVE, caps: MEMBER, quota: null }); await delivered();
  const sheet = () => h.document.querySelector('.je-sheet');
  const card = sheet().querySelector('.je-sheet-card[data-choice="pick"]');
  if (card) {
    card.click(); await delivered();
    assert.notEqual(card.getAttribute('aria-pressed'), 'true', 'a script picks nothing');
    h.click(card); await delivered();
    assert.equal(card.getAttribute('aria-pressed'), 'true');
    // A script's change on a season box reaches none of the sheet's listeners.
    const box = sheet().querySelector('.je-sheet-pick input[type="checkbox"]:not(:disabled)');
    const change = new h.window.Event('change', { bubbles: true, cancelable: true });
    box.dispatchEvent(change);
    assert.equal(change.defaultPrevented, true, 'refused at the sheet');
  }
  const backdrop = h.document.querySelector('.je-sheet-backdrop');
  backdrop.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true, cancelable: true })); await delivered();
  assert.ok(sheet(), 'a script\'s backdrop click closes nothing');
  await finalPress(h, sheet().querySelector('.je-sheet-secondary'), { stays: () => !!sheet(), acted: () => !sheet() });
  assert.equal(h.sent('POST', '/acquire/requests').length, 0);
});

test('R12-3 (B14): the Hide confirmation\'s Cancel and backdrop take only the viewer\'s press, and its suppression box only the viewer\'s change', async t => {
  const h = setup(t, { asks: false });
  h.JE.userConfig = { hiddenContent: { items: {}, settings: { enabled: true, showHideButtons: true, showButtonJellyseerr: true, showHideConfirmation: true } } };
  h.load('enhanced/hiddencontent/hidden-content-data.js'); h.load('enhanced/hiddencontent/hidden-content-dialogs.js');
  const hc = h.JE.internals.hiddenContent; hc.refreshNativeCardVisibility = () => {};
  const control = hc.buildTitleControl({ mediaType: 'movie', tmdbId: 603, name: 'Absent movie' }); h.document.body.append(control);
  h.click(control); await delivered();
  const overlay = () => h.document.querySelector('.je-hide-confirm-overlay');
  const dialog = overlay().querySelector('.je-hide-confirm-dialog');
  assert.equal(dialog.getAttribute('role'), 'dialog', 'B30: the stack names it a modal dialog');
  assert.equal(dialog.getAttribute('aria-modal'), 'true');
  assert.ok(dialog.getAttribute('aria-labelledby'));
  overlay().dispatchEvent(new h.window.MouseEvent('click', { bubbles: true, cancelable: true })); await delivered();
  assert.ok(overlay(), 'a script\'s backdrop click closes nothing');
  await finalPress(h, overlay().querySelector('.je-hide-confirm-cancel'), { stays: () => !!overlay(), acted: () => !overlay() });
  assert.equal(h.sent('PUT', '/user-settings/').length, 0);
});

test('R12-3 (B15): the Guard confirmation\'s accept, cancel and a native cancel event take only the viewer', async t => {
  const h = setup(t, { asks: false });
  const internal = h.JE.internals.spoilerGuard = { whenLoaded: () => Promise.resolve(), getUserPrefs: () => ({}), isDisableSnoozed: () => false, setDisableSnooze() {} };
  h.load('enhanced/spoilerguard/dialog.js');
  const answer = internal.confirmDisableSpoiler(h.NATIVE); await delivered();
  const dialog = h.document.querySelector('.je-spoiler-confirm-dialog');
  assert.ok(dialog);
  dialog.querySelector('.je-spoiler-confirm-accept').click();
  dialog.dispatchEvent(new h.window.Event('cancel', { cancelable: true })); await delivered();
  assert.ok(dialog.isConnected, 'a script accepts and cancels nothing');
  h.click(dialog.querySelector('.je-spoiler-confirm-accept'));
  assert.equal(await answer, true, 'the viewer accepts');
});

test('R12-3 (B16, B28): Manage\'s Search now and close take only the viewer\'s press', async t => {
  const h = setup(t);
  await h.JE.arrManage.open({ key: 'movie:tmdb:603' }, { operation: h.NATIVE }); await delivered();
  const overlay = () => h.document.querySelector('.je-manage-overlay');
  const close = overlay().querySelector('.je-manage-close');
  close.click(); await delivered();
  assert.ok(overlay(), 'a script closes nothing');
  overlay().dispatchEvent(new h.window.MouseEvent('click', { bubbles: true, cancelable: true })); await delivered();
  assert.ok(overlay(), 'a script\'s backdrop click closes nothing');
  h.click(overlay().querySelector('.je-manage-close')); await delivered();
  assert.equal(overlay(), null);
});

test('R12-3 (B18): a generic Seerr form\'s Save, Cancel, backdrop and form submission take only the viewer', async t => {
  const h = setup(t);
  let saved = 0;
  const modal = h.JE.jellyseerrModal.create({ title: 'x', subtitle: 'y', bodyHtml: '<form class="je-f"><button class="je-f-go">go</button></form>', onSave: () => { saved++; }, operation: h.NATIVE });
  modal.show(); await settle();
  const el = modal.modalElement;
  el.querySelector('.jellyseerr-modal-button-primary').click();
  el.querySelector('.jellyseerr-modal-button-secondary').click();
  el.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  const submit = new h.window.Event('submit', { bubbles: true, cancelable: true });
  el.querySelector('.je-f').dispatchEvent(submit); await delivered();
  assert.equal(saved, 0, 'a script saves nothing');
  assert.equal(submit.defaultPrevented, true, 'a script\'s form submission has no default');
  assert.equal(el._isClosing, undefined, 'and closes nothing');
  h.click(el.querySelector('.jellyseerr-modal-button-primary')); await delivered();
  assert.equal(saved, 1, 'the viewer saves');
});

test('R12-3 (B19): More Info\'s Refresh and Close take only the viewer\'s press', async t => {
  const h = setup(t, { asks: false });
  await h.JE.jellyseerrMoreInfo.open(603, 'movie', undefined, h.NATIVE); await delivered();
  const info = moreInfo(h);
  const reads = () => h.sent('GET', '/jellyseerr/movie/603').length;
  const before = reads();
  info.querySelector('.modal-refresh')?.click(); await delivered();
  assert.equal(reads(), before, 'a script refreshes nothing');
  info.querySelector('.modal-close').click(); await delivered();
  assert.equal(info._isClosing, undefined, 'a script closes nothing');
  h.click(info.querySelector('.modal-close')); await delivered();
  assert.equal(info._isClosing, true);
});

test('R12-3 (B20): the More sheet\'s close and backdrop take only the viewer\'s press', async t => {
  const h = setup(t, { asks: false }); h.a.initialize(); mount(h); await delivered();
  h.click(h.row().querySelector('.je-actions-more')); await delivered();
  const backdrop = () => h.document.querySelector('.je-actions-backdrop');
  backdrop().dispatchEvent(new h.window.MouseEvent('click', { bubbles: true, cancelable: true })); await delivered();
  assert.ok(backdrop());
  await finalPress(h, backdrop().querySelector('.je-actions-close'), { stays: () => !!backdrop(), acted: () => !backdrop() });
});

test('R12-3 (B21): the 4K popup\'s arrow and an outside click take only the viewer\'s press', async t => {
  const h = setup(t, { asks: false });
  h.JE.core.ui = { addTouchTapListener() {}, addDelegatedTouchTapListener() {} };
  h.load('jellyseerr/ui/ui-popover.js'); h.load('jellyseerr/ui/ui-buttons.js');
  const card = h.document.createElement('div'); card.className = 'jellyseerr-card';
  card.innerHTML = '<button class="jellyseerr-request-button" data-tmdb-id="603" data-media-type="movie"></button>';
  h.document.body.append(card);
  h.JE.jellyseerrUI.configureRequestButton(card.firstChild, { id: 603, mediaType: 'movie', title: 'M', mediaInfo: { status: 1, status4k: 1 } }, true, true);
  const arrow = card.querySelector('.jellyseerr-split-arrow');
  assert.ok(arrow);
  const popup = () => h.document.querySelector('.jellyseerr-4k-popup');
  arrow.click(); await delivered();
  assert.equal(popup(), null, 'a script opens nothing');
  h.click(arrow); await delivered();
  assert.ok(popup(), 'the viewer opens it');
  arrow.click(); await delivered();
  assert.ok(popup(), 'a script closes nothing');
  h.click(arrow); await delivered();
  assert.equal(popup(), null, 'the viewer closes it');
});

// ------------------------------------------------------------------ R4 (B22–B28): one stack for every surface, key and focus

const exposeRow = { 'arr/ask/ask-episodes.js': source => source.replace('JE.initializeArrAskEpisodes = initialize;', 'JE.initializeArrAskEpisodes = initialize; JE.__buildEpisodeRow = buildRow;') };
const episode = { episode: 2, season: 1, key: 'tv:tmdb:1399:s1:e2', stage: 'notHere', reason: { code: 'unmonitored' } };
for (const [entry, selector, tv] of [['image', '.je-ask-row-image', false], ['title', '.je-ask-row-title', false], ['info', '.je-ask-row-info', false], ['TV row', null, true]]) {
  test(`R12-5 (B22): the episode details' ${entry} entry opens only for the viewer's press, admitted and on the stack`, async t => {
    const h = setup(t, { plants: exposeRow });
    if (tv) h.document.documentElement.classList.add('layout-tv');
    const row = h.JE.__buildEpisodeRow(episode, { contact: 'Dad' });
    h.document.body.append(row);
    const target = selector ? row.querySelector(selector) : row;
    target.click(); await delivered();
    assert.equal(h.document.querySelector('.je-ask-dialog-backdrop'), null, 'a script opens nothing');
    h.click(target); await delivered();
    const dialog = h.document.querySelector('.je-ask-dialog-backdrop');
    assert.ok(dialog);
    assert.ok(h.JE.scopeOf(dialog));
    assert.equal(h.JE.isTopmostSurface(dialog), true);
    assert.equal(row.hasAttribute('inert') || row.closest('[inert]') !== null, true, 'the page behind it is covered');
    h.JE.internals.arrAskEpisodes.closeDialog(); await delivered();
    assert.equal(h.document.querySelector('.je-ask-dialog-backdrop'), null);
    assert.equal(row.closest('[inert]'), null, 'the page is live again');
  });
}

test('R12-5 (B22): an older episode dialog is left alone by a rejected opening (admitted before it is replaced)', async t => {
  const h = setup(t, { plants: exposeRow });
  const row = h.JE.__buildEpisodeRow(episode, { contact: 'Dad' }); h.document.body.append(row);
  const stale = h.a.generation(); stale.end();
  h.click(row.querySelector('.je-ask-row-title')); await delivered();
  const shown = h.document.querySelector('.je-ask-dialog-backdrop');
  h.JE.strictOwners = 'record';
  h.JE.internals.arrAskEpisodes.openDetails(episode, { contact: 'Dad' }, stale); await delivered();
  assert.equal(h.document.querySelector('.je-ask-dialog-backdrop'), shown, 'the dialog shown stays');
});

for (const host of HOSTS) {
  test(`R12-6 (B24–B27, ${host}): a host dialog over the request sheet, More and the Remove dialog keeps its focus and keys; the covered surface keeps still`, async t => {
    const h = setup(t);
    hostInput(h, host, { tv: true });
    h.JE.arrAskSheet.open({ key: 'movie:tmdb:603', kind: 'movie', name: 'M' }, { operation: h.NATIVE, caps: MEMBER, quota: null }); await delivered();
    const sheet = h.document.querySelector('.je-sheet-backdrop');
    assert.ok(sheet);
    const dialog = h.document.createElement('div'); dialog.className = 'dialogContainer'; dialog.innerHTML = '<div class="dialog opened"><button class="a">A</button><button class="b">B</button></div>';
    h.document.body.append(dialog); await delivered();
    dialog.querySelector('.b').focus();
    h.key(dialog.querySelector('.b'), 'Tab');
    h.key(dialog.querySelector('.b'), 'Backspace');
    h.key(dialog.querySelector('.b'), 'Escape', { keyCode: 27 }); await delivered();
    assert.ok(sheet.isConnected, 'the covered sheet took none of the host dialog\'s keys');
    assert.equal(h.document.activeElement, dialog.querySelector('.b'), 'focus stays in the host dialog');
    assert.equal(sheet.hasAttribute('inert'), true, 'the covered sheet is inert while the host dialog is on top');
    dialog.remove(); await delivered();
    assert.equal(sheet.hasAttribute('inert'), false, 'and live again after');
  });
}

test('R12-6 (B27): a covered card\'s ContextMenu opens nothing while a surface is on top', async t => {
  const h = setup(t, { card: true }); h.a.initialize(); await delivered();
  await h.JE.jellyseerrMoreInfo.open(603, 'movie', undefined, h.NATIVE); await delivered();
  const card = h.document.querySelector('.card');
  h.key(card, 'ContextMenu'); await delivered();
  assert.equal(h.document.querySelector('.je-actions-backdrop'), null);
});

test('R12-6 (B28): a covered drawer\'s re-render never takes focus from the host dialog above it', async t => {
  const h = setup(t);
  await h.JE.arrManage.open({ key: 'movie:tmdb:603' }, { operation: h.NATIVE }); await delivered();
  const drawer = h.document.querySelector('.je-manage');
  drawer.querySelector('button')?.focus();
  const dialog = h.document.createElement('div'); dialog.className = 'dialogContainer'; dialog.innerHTML = '<button>OK</button>';
  h.document.body.append(dialog); await delivered();
  dialog.querySelector('button').focus();
  h.feed(); await wait(20); await delivered();
  assert.equal(h.document.activeElement, dialog.querySelector('button'));
});

// ------------------------------------------------------------------ R6 (B33–B37): admission before shared state

test('R12-7 (B34): a rejected Seerr collection opening leaves the viewer\'s pending one to open', async t => {
  const h = setup(t, { asks: false });
  const stale = h.a.generation(); stale.end();
  const gate = h.hold('GET', '/jellyseerr/collection/2344');
  const current = h.JE.jellyseerrUI.showCollectionRequestModal(2344, 'The Matrix Collection', null, { operation: h.NATIVE }); await delivered();
  h.JE.strictOwners = 'record';
  await h.JE.jellyseerrUI.showCollectionRequestModal(9, 'Another', null, { operation: stale });
  gate.resolve(); await current; await delivered();
  assert.ok(seerrModal(h), 'the current collection opening opened');
});

test('R12-7 (B36): a stale publication supersedes nothing (admitted before the surface\'s intent slots change)', async t => {
  const h = setup(t);
  const surface = h.document.createElement('div'); h.document.body.append(surface);
  const live = h.a.generation();
  const read = h.JE.surfaceIntent(surface, live);
  const stale = h.a.generation(); stale.end();
  const publication = h.JE.publication({ owner: stale, surface, identity: { tmdbId: 603, mediaType: 'movie' } });
  assert.equal(publication.current(), false);
  assert.equal(read(), true, 'the live read is still the newest');
  assert.equal(h.JE.surfaceIntent(surface, null)(), false, 'an owner that resolves to nothing starts nothing');
  assert.equal(read(), true);
});

test('R12-7 (B37): a Hide confirmation for an ended owner leaves the shown confirmation alone', async t => {
  const h = setup(t, { asks: false });
  h.JE.userConfig = { hiddenContent: { items: {}, settings: { enabled: true, showHideButtons: true, showButtonJellyseerr: true, showHideConfirmation: true } } };
  h.load('enhanced/hiddencontent/hidden-content-data.js'); h.load('enhanced/hiddencontent/hidden-content-dialogs.js');
  const hc = h.JE.internals.hiddenContent;
  hc.showHideConfirmation('Shown', () => {}, { owner: h.NATIVE }); await delivered();
  const shown = h.document.querySelector('.je-hide-confirm-overlay');
  const stale = h.a.generation(); stale.end();
  h.JE.strictOwners = 'record';
  hc.showHideConfirmation('Stale', () => {}, { owner: stale }); await delivered();
  assert.equal(h.document.querySelector('.je-hide-confirm-overlay'), shown);
});

// ------------------------------------------------------------------ R7 (B38, B39): offers finish, submitted work lives on

test('R12-8 (B38, B39): a card opening that fails or is superseded finishes; what the viewer submits from the sheet outlives it closing', async t => {
  const h = setup(t, { card: true }); h.a.initialize(); await delivered();
  const more = h.document.querySelector('.je-card-more');
  const baseline = h.a.registrySize();
  // Superseded: two presses, the first's admission held.
  const held = h.hold('GET', '/title-actions/');
  h.click(more); h.click(more); await delivered();
  held.resolve(); await delivered();
  h.a.close(); await delivered();
  // Failed: the admission refuses.
  h.respond('GET', '/title-actions/', [200, { allowed: false }]);
  h.click(more); await delivered();
  assert.equal(h.document.querySelector('.je-actions-backdrop'), null);
  assert.ok(h.a.registrySize() <= baseline + 1, `bounded: ${baseline} → ${h.a.registrySize()}`);
});

test('R12-8 (B39): Request pressed in a card\'s More: the sheet closes, the request sheet it opened still asks', async t => {
  const h = setup(t, { card: true }); h.a.initialize(); await delivered();
  h.click(h.document.querySelector('.je-card-more')); await delivered();
  const request = h.document.querySelector('.je-actions-entry[data-action="request"]');
  assert.ok(request);
  h.click(request); await delivered();
  assert.equal(h.document.querySelector('.je-actions-backdrop'), null, 'the offer closed');
  const primary = h.document.querySelector('.je-sheet-primary');
  assert.ok(primary, 'the submitted operation opened the request sheet');
  h.click(primary); await delivered();
  assert.equal(h.sent('POST', '/acquire/requests').length, 1);
});

// ------------------------------------------------------------------ R8 (B42): the host's input, narrowly

test('R12-9 (B42): jellyfin-web\'s gamepad OK chain without a connected gamepad is no one\'s (a forged key chain); with one, it is the viewer\'s', async t => {
  const h = setup(t);
  const node = h.document.createElement('button'); h.document.body.append(node);
  const seen = [];
  node.addEventListener('click', e => seen.push(!!h.JE.ownerOf(e)));
  const chain = () => { const key = new h.window.Event('keyup', { bubbles: true, cancelable: true }); key.key = 'GamepadA'; key.keyCode = 13; node.dispatchEvent(key); node.click(); };
  node.focus();
  Object.defineProperty(h.window.navigator, 'getGamepads', { configurable: true, value: () => [] });
  chain();
  Object.defineProperty(h.window.navigator, 'getGamepads', { configurable: true, value: () => [{ index: 0, connected: true, buttons: [] }] });
  chain();
  assert.deepEqual(seen, [false, true]);
});

// ------------------------------------------------------------------ R9 (B29, B30): semantics and background from the stack

test('R12-11 (B30): More Info is a named modal dialog; the page and dynamically added siblings are inert while it is open, and live again once it closes', async t => {
  const h = setup(t, { asks: false });
  const page = h.page;
  await h.JE.jellyseerrMoreInfo.open(603, 'movie', undefined, h.NATIVE); await delivered();
  const info = moreInfo(h);
  const dialog = info.matches('[role="dialog"]') ? info : info.querySelector('[role="dialog"]');
  assert.ok(dialog, 'a dialog');
  assert.equal(dialog.getAttribute('aria-modal'), 'true');
  assert.ok(dialog.getAttribute('aria-label') || h.document.getElementById(dialog.getAttribute('aria-labelledby'))?.textContent, 'named');
  assert.equal(page.hasAttribute('inert'), true);
  const late = h.document.createElement('div'); h.document.body.append(late); await delivered();
  assert.equal(late.hasAttribute('inert'), true, 'a sibling appended meanwhile is covered too');
  assert.equal(info.closest('[inert]'), null, 'no inert ancestor around the top surface');
  h.key(info.querySelector('button'), 'Escape', { keyCode: 27 }); await delivered();
  assert.equal(page.hasAttribute('inert'), false);
  assert.equal(late.hasAttribute('inert'), false);
});

test('R12-10 (B29): the More sheet closed after its card vanished: the page is live first, then focus lands on a live page control (never the body)', async t => {
  const h = setup(t, { card: true }); h.a.initialize(); await delivered();
  // jellyfin-web's shown view.
  h.page.classList.add('page', 'mainAnimatedPage');
  const play = h.document.createElement('button'); play.id = 'pagePlay'; h.page.prepend(play);
  const card = h.document.querySelector('.card');
  h.click(card.querySelector('.je-card-more')); await delivered();
  card.remove();
  h.key(h.document.activeElement, 'Escape', { keyCode: 27 }); await delivered();
  assert.equal(h.document.querySelector('.je-actions-backdrop'), null);
  assert.notEqual(h.document.activeElement, h.document.body);
  assert.equal(h.document.activeElement, play);
  assert.equal(h.page.hasAttribute('inert'), false);
});

test('R12-10: a page with no control left: focus lands on the page itself (focusable), not the body', async t => {
  const h = setup(t, { asks: false });
  h.page.classList.add('page');
  await h.JE.jellyseerrMoreInfo.open(603, 'movie', undefined, h.NATIVE); await delivered();
  h.page.querySelectorAll('button').forEach(n => n.remove());
  h.key(moreInfo(h).querySelector('button'), 'Escape', { keyCode: 27 }); await delivered();
  assert.equal(h.document.activeElement, h.page);
});

// ------------------------------------------------------------------ added cells (each tied to an enforcing check)

for (const host of HOSTS) {
  test(`R12-9 (B42, ${host}): inside a remote Select's server message, a click on another control than the focused one is no one's`, async t => {
    const h = setup(t, { asks: false });
    h.JE.core.ui = { addTouchTapListener() {}, addDelegatedTouchTapListener() {} };
    h.load('jellyseerr/ui/ui-popover.js'); h.load('jellyseerr/ui/ui-buttons.js');
    const cards = [603, 604].map(id => {
      const node = h.document.createElement('div'); node.className = 'jellyseerr-card';
      node.innerHTML = `<button class="jellyseerr-request-button" data-tmdb-id="${id}" data-media-type="movie"></button>`;
      h.document.body.append(node);
      h.JE.jellyseerrUI.configureRequestButton(node.firstChild, { id, mediaType: 'movie', title: 'M' + id, mediaInfo: { status: 1, status4k: 1 } }, true, true);
      return node.querySelector('.jellyseerr-split-main') || node.querySelector('button');
    });
    const input = hostInput(h, host);
    const remote = await input.remote();
    t.after(() => remote.close());
    // A listener of the same server message clicks the unfocused 604 (after the host's own select of 603).
    remote.socket.addEventListener('message', () => cards[1].click());
    cards[0].focus();
    await remote.command('Select'); await delivered();
    assert.deepEqual(h.sent('POST', '/jellyseerr/request').map(r => r[3].mediaId), [603], 'only the focused control is the remote\'s press');
  });
}

test('R12-3 (B21): More Info\'s 4K popup closes on the viewer\'s click outside it, never on a script\'s', async t => {
  const h = setup(t, { asks: false });
  await h.JE.jellyseerrMoreInfo.open(603, 'movie', undefined, h.NATIVE); await delivered();
  const info = moreInfo(h);
  const arrow = info.querySelector('.jellyseerr-split-arrow');
  assert.ok(arrow, 'the window offers 4K');
  h.click(arrow); await delivered();
  const popup = () => h.document.querySelector('.je-4k-popup');
  assert.ok(popup());
  const outside = info.querySelector('.modal-refresh') || info.querySelector('h2') || info;
  outside.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true, cancelable: true })); await delivered();
  assert.ok(popup(), 'a script\'s click outside closes nothing');
  h.click(info.querySelector('.je-more-info-modal h2, h2') || outside); await delivered();
  assert.equal(popup(), null, 'the viewer\'s click outside closes it');
});

test('R12-7 (B33): a rejected season-selection opening leaves the shown modal\'s refresh running', async t => {
  const h = setup(t, { asks: false });
  let cleared = 0;
  const clear = h.window.clearInterval;
  await h.JE.jellyseerrUI.showSeasonSelectionModal(1399, 'tv', 'Shown', null, false, h.NATIVE); await delivered();
  assert.ok(seerrModal(h));
  h.window.clearInterval = id => { cleared++; return clear.call(h.window, id); };
  const stale = h.a.generation(); stale.end();
  h.JE.strictOwners = 'record';
  await h.JE.jellyseerrUI.showSeasonSelectionModal(1398, 'tv', 'Stale', null, false, stale); await delivered();
  h.window.clearInterval = clear;
  assert.equal(cleared, 0, 'nothing shared was cancelled');
});

for (const host of HOSTS) {
  test(`R12-6 (B27, ${host}): the More sheet's arrows move nothing while a host dialog is above it`, async t => {
    const h = setup(t, { asks: false }); h.a.initialize(); mount(h); await delivered();
    hostInput(h, host);
    h.click(h.row().querySelector('.je-actions-more')); await delivered();
    const entries = [...h.document.querySelectorAll('.je-actions-entry')];
    entries[0].focus();
    const dialog = h.document.createElement('div'); dialog.className = 'dialogContainer'; dialog.innerHTML = '<button>OK</button>';
    h.document.body.append(dialog); await delivered();
    h.key(entries[0], 'ArrowDown');
    assert.notEqual(h.document.activeElement, entries[1], 'the covered sheet moved no focus');
    dialog.remove(); await delivered();
    entries[0].focus(); h.key(entries[0], 'ArrowDown');
    assert.equal(h.document.activeElement, entries[1], 'control: on top again, its arrows move focus');
  });
}

test('R12-6 (B28): focus moved under the topmost JE surface (a covered control focused by code) comes back into the surface', async t => {
  const h = setup(t, { asks: false });
  const behind = h.document.createElement('button'); behind.textContent = 'behind'; h.page.append(behind);
  await h.JE.jellyseerrMoreInfo.open(603, 'movie', undefined, h.NATIVE); await delivered();
  const info = moreInfo(h);
  behind.focus();
  assert.ok(info.contains(h.document.activeElement), 'the stack keeps focus in the topmost surface');
});

test('R12-6 (B28): a form\'s delayed first focus never takes focus from a host dialog that arrived before it', async t => {
  const h = setup(t);
  const modal = h.JE.jellyseerrModal.create({ title: 'x', subtitle: 'y', bodyHtml: '<button class="je-inside">in</button>', onSave: () => {}, operation: h.NATIVE });
  modal.show();
  const dialog = h.document.createElement('div'); dialog.className = 'dialogContainer'; dialog.innerHTML = '<button>OK</button>';
  h.document.body.append(dialog); dialog.querySelector('button').focus();
  await wait(40); await delivered();
  assert.equal(h.document.activeElement, dialog.querySelector('button'));
});

test('R12-4: an ask accepted after its owner ended (same account) spends its idempotency key: the next ask of the same input is a new one', async t => {
  const h = setup(t);
  const op = h.a.generation();
  const gate = h.hold('POST', '/acquire/requests');
  const input = h.JE.arrAsk.movieInput('movie:tmdb:603');
  const pending = h.JE.arrAsk.ask(input, { bound: op.bound() });
  await delivered();
  const first = h.sent('POST', '/acquire/requests')[0][3].clientRequestId;
  op.end();
  gate.resolve({ outcome: 'accepted', certainty: 'Succeeded', reason: 'looking', requestId: 'a'.repeat(32) });
  const result = await pending;
  assert.equal(result.accepted, true);
  await h.JE.arrAsk.ask(input, { bound: h.a.generation().bound() });
  assert.notEqual(h.sent('POST', '/acquire/requests')[1][3].clientRequestId, first, 'the accepted ask\'s key is spent');
});

test('R12-10: a host dialog over More Info closes and leaves focus nowhere: focus goes back into the window', async t => {
  const h = setup(t, { asks: false });
  await h.JE.jellyseerrMoreInfo.open(603, 'movie', undefined, h.NATIVE); await delivered();
  const info = moreInfo(h);
  const dialog = h.document.createElement('div'); dialog.className = 'dialogContainer'; dialog.innerHTML = '<button>OK</button>';
  h.document.body.append(dialog); await delivered();
  dialog.querySelector('button').focus();
  dialog.remove(); await delivered();
  assert.equal(info.hasAttribute('inert'), false, 'the window is live again');
  assert.ok(info.contains(h.document.activeElement), 'focus is back inside it, not on the body');
});

test('a Seerr override-rules read cancelled by an account switch logs no error and returns none of the previous account\'s rules', async t => {
  const h = setup(t, { asks: false });
  const logged = [];
  const error = h.window.console.error;
  h.window.console.error = (...a) => { logged.push(a.map(String).join(' ')); };
  t.after(() => { h.window.console.error = error; });
  const gate = h.hold('GET', '/jellyseerr/overrideRule');
  const pending = h.JE.jellyseerrAPI.fetchOverrideRules();
  await delivered();
  h.switchUser(); await delivered();
  gate.resolve([{ id: 1 }]);
  assert.deepEqual([...await pending], []);
  assert.deepEqual(logged.filter(m => /override rules/.test(m)), []);
});
