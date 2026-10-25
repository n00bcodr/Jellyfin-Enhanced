import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, mount, delivered, moreInfo, seerrModal, MEMBER } from '../helpers/title-actions-scopes.mjs';
import { hostInput, HOSTS } from '../helpers/host-input.mjs';
import { inventory } from '../helpers/effect-inventory.mjs';
import { readSources } from '../helpers/bundle-scan.mjs';

// D46 slice 2 review round 12: authority is checked at EVERY boundary, never borrowed. Every write the transport sends
// is verified against the core's own record of its authority (no endpoint list decides whether it is); a press is its
// event, its one dispatch, its target and its owner, and acts once; every final interaction inside an open surface is a
// press of its own (submit, confirm, Escape); every foreground surface (episode details included) is on the one stack,
// and only the topmost takes keys and focus; a write that was sent and answered stays answered across an account
// switch; an opening is admitted before it changes anything shared; an offer finishes on every terminal path; and
// another Jellyfin client's remote "Select" is the viewer's press, through jellyfin-web's real remote-command path.

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const record = h => { h.JE.strictOwners = 'record'; h.JE.refusals = []; };

/** A search card whose Request is drawn by the production card code (configureRequestButton). */
function seerrCard(h, id) {
  const node = h.document.createElement('div');
  node.className = 'jellyseerr-card'; node.dataset.tmdbId = String(id); node.dataset.mediaType = 'movie';
  node.innerHTML = `<button class="jellyseerr-request-button" data-tmdb-id="${id}" data-media-type="movie"></button>`;
  h.document.body.append(node);
  h.JE.jellyseerrUI.configureRequestButton(node.firstChild, { id, mediaType: 'movie', title: 'Movie ' + id, mediaInfo: { status: 1, status4k: 1 } }, true, true);
  return node.querySelector('.jellyseerr-split-main') || node.querySelector('button');
}
function loadCards(h) {
  h.JE.core.ui = { addTouchTapListener() {}, addDelegatedTouchTapListener() {} };
  h.load('jellyseerr/ui/ui-popover.js'); h.load('jellyseerr/ui/ui-buttons.js');
}
const requested = h => h.sent('POST', '/jellyseerr/request').map(r => r[3].mediaId);

// ------------------------------------------------------------------ R12-1 (S1): every write verifies at the send

test('R12-1: an ask bound to an ended operation is not sent, whatever its binding\'s own predicate says; a current binding sends once', async t => {
  const h = setup(t);
  const token = h.a.generation();
  await h.leave('#/details?id=next');
  assert.equal(h.JE.mayWrite(token, token.session), false);
  const result = await h.JE.arrAsk.ask(h.JE.arrAsk.movieInput('movie:tmdb:603'), { bound: { token, session: token.session, current: () => true } });
  assert.equal(result.ok, false);
  assert.equal(result.stale, true);
  assert.equal(h.sent('POST', '/acquire/requests').length, 0, 'an ended token sends nothing');
  // Control: the same ask, bound to a current operation, is sent once.
  const fresh = h.a.generation();
  const answered = await h.JE.arrAsk.ask(h.JE.arrAsk.movieInput('movie:tmdb:604'), { bound: fresh.bound() });
  assert.equal(answered.ok, true);
  assert.equal(h.sent('POST', '/acquire/requests').length, 1);
});

test('R12-1: an ask whose binding names another account than its token\'s is not sent; the new account\'s own binding sends as it', async t => {
  const h = setup(t);
  const tokenA = h.a.generation();
  h.switchUser(); await delivered();
  const sessionB = h.NATIVE.session;
  assert.equal(h.JE.mayWrite(tokenA, sessionB), false);
  const result = await h.JE.arrAsk.ask(h.JE.arrAsk.movieInput('movie:tmdb:603'), { bound: { token: tokenA, session: sessionB, current: () => true } });
  assert.equal(result.ok, false);
  assert.equal(h.sent('POST', '/acquire/requests').length, 0, 'A\'s token never sends as B');
  const tokenB = h.a.generation();
  assert.equal((await h.JE.arrAsk.ask(h.JE.arrAsk.movieInput('movie:tmdb:603'), { bound: tokenB.bound() })).ok, true);
  const writes = h.sent('POST', '/acquire/requests');
  assert.equal(writes.length, 1);
  assert.equal(writes[0][0], 'user-b');
});

// ------------------------------------------------------------------ R12-2 (S2): a press acts once, on its own target

test('R12-2: a title action\'s relayed press acts once on its own target; replayed on another title or on the same one, it is no one\'s', async t => {
  const h = setup(t, { asks: false });
  loadCards(h);
  const first = seerrCard(h, 603), second = seerrCard(h, 604);
  let forwarded;
  first.addEventListener('click', event => { forwarded = event; });
  // The viewer's real press on a relay, exactly as an action-bar proxy forwards it to its source.
  const relay = h.document.createElement('button'); h.document.body.append(relay);
  relay.onclick = event => h.JE.press(first, h.JE.operation({ parent: h.JE.ownerOf(event) }));
  h.click(relay); await delivered();
  assert.equal(forwarded.isTrusted, false);
  assert.deepEqual(requested(h), [603], 'the original relay acts once');
  assert.equal(h.JE.ownerOf(forwarded), null, 'once its dispatch is over, the relayed event names no owner');
  second.dispatchEvent(forwarded); await delivered();
  assert.deepEqual(requested(h), [603], 'replayed onto another title: nothing');
  // The same title again (its button usable again once the first answer is in): the replay is still no one's.
  first.disabled = false; first.dispatchEvent(forwarded); await delivered();
  assert.deepEqual(requested(h), [603], 'replayed onto the same target: nothing');
});

// ------------------------------------------------------------------ R12-3 (S3): the final press is a press of its own

test('R12-3: a script\'s click on the request sheet\'s Request sends nothing and leaves the sheet usable; the viewer\'s own press then asks once', async t => {
  const h = setup(t);
  const pending = h.JE.arrAskSheet.open({ key: 'movie:tmdb:603', kind: 'movie', name: 'Absent movie' }, { operation: h.NATIVE });
  await delivered();
  const request = h.document.querySelector('.je-sheet-primary');
  assert.ok(request);
  request.click(); await delivered();
  assert.equal(h.sent('POST', '/acquire/requests').length, 0, 'a script\'s Request is no one\'s');
  assert.ok(h.document.querySelector('.je-sheet'), 'the sheet stays open');
  assert.equal(request.disabled, false, 'its Request stays usable');
  h.click(request); await pending; await delivered();
  assert.equal(h.sent('POST', '/acquire/requests').length, 1, 'the viewer\'s press asks once');
});

test('R12-3: a script\'s click on the Hide confirmation\'s Hide writes nothing; the viewer\'s own press then hides the title', async t => {
  const h = setup(t, { asks: false });
  h.JE.userConfig = { hiddenContent: { items: {}, settings: { enabled: true, showHideButtons: true, showButtonJellyseerr: true, showHideConfirmation: true } } };
  h.load('enhanced/hiddencontent/hidden-content-data.js');
  h.load('enhanced/hiddencontent/hidden-content-dialogs.js');
  const hc = h.JE.internals.hiddenContent;
  hc.refreshNativeCardVisibility = () => {};
  const control = hc.buildTitleControl({ mediaType: 'movie', tmdbId: 603, name: 'Absent movie' });
  h.document.body.append(control);
  h.click(control); await delivered();
  const accept = h.document.querySelector('.je-hide-confirm-hide');
  assert.ok(accept);
  accept.click(); await delivered();
  assert.equal(h.sent('PUT', '/user-settings/').length, 0, 'a script\'s confirm writes nothing');
  assert.equal(hc.isHiddenByTmdbId(603, 'movie'), false);
  assert.ok(accept.isConnected, 'the confirmation stays open for the viewer');
  h.click(accept); await delivered();
  assert.equal(h.sent('PUT', '/user-settings/').length, 1);
  assert.equal(hc.isHiddenByTmdbId(603, 'movie'), true);
});

test('R12-3: a script\'s Escape does not dismiss More Info; the viewer\'s Escape does', async t => {
  const h = setup(t, { asks: false });
  await h.JE.jellyseerrMoreInfo.open(603, 'movie', undefined, h.NATIVE); await delivered();
  const info = moreInfo(h);
  assert.ok(info);
  const event = new h.window.KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true, cancelable: true });
  info.querySelector('button').dispatchEvent(event); await delivered();
  assert.notEqual(info._isClosing, true, 'a script\'s Escape is no one\'s');
  assert.equal(moreInfo(h), info, 'the window stays open (the surface refused the script\'s key: it reached none of its listeners)');
  h.key(info.querySelector('button'), 'Escape', { keyCode: 27 }); await delivered();
  assert.equal(info._isClosing, true, 'the viewer\'s Escape closes it');
});

// ------------------------------------------------------------------ R12-4 (S4): sent and answered survive a switch

test('R12-4: a write sent as A and answered after B signs in is accepted (sent, with its answer), never unsent', async t => {
  const h = setup(t);
  const owner = h.NATIVE;
  const gate = h.hold('POST', '/acquire/requests');
  const pending = h.JE.core.api.pluginResponse('/acquire/requests', {
    method: 'POST', body: { input: { key: 'movie:tmdb:603', kind: 'movie' } }, bound: owner.bound()
  }).then(value => ({ value }), error => ({ error, outcome: h.JE.core.api.writeOutcome(error) }));
  await delivered();
  assert.equal(h.sent('POST', '/acquire/requests').length, 1);
  assert.equal(h.sent('POST', '/acquire/requests')[0][0], 'user-a');
  h.switchUser();
  gate.resolve({ outcome: 'accepted', certainty: 'Succeeded', requestId: 'a'.repeat(32) });
  const result = await pending;
  assert.equal(result.value, undefined, 'nothing is published to the new account');
  assert.equal(result.outcome.outcome, 'accepted');
  assert.equal(result.outcome.sessionChanged, true);
  assert.equal(result.error.jeSent, true);
  assert.equal(result.outcome.answer.status, 200);
  assert.equal(result.outcome.answer.body.requestId, 'a'.repeat(32));
});

test('R12-4: an ask accepted after an account switch stays accepted: its key is spent, nothing reaches the new account', async t => {
  const h = setup(t);
  const changes = [];
  h.JE.arrAsk.onChange(change => changes.push(change));
  const gate = h.hold('POST', '/acquire/requests');
  const input = h.JE.arrAsk.movieInput('movie:tmdb:603');
  const pending = h.JE.arrAsk.ask(input, { bound: h.NATIVE.bound() });
  await delivered();
  assert.equal(h.sent('POST', '/acquire/requests').length, 1);
  const firstId = h.sent('POST', '/acquire/requests')[0][3].clientRequestId;
  h.switchUser();
  gate.resolve({ outcome: 'accepted', certainty: 'Succeeded', reason: 'looking', requestId: 'a'.repeat(32) });
  const result = await pending;
  assert.equal(result.stale, true);
  assert.equal(result.accepted, true);
  assert.notEqual(result.reason, 'aborted');
  assert.equal(result.sessionChanged, true);
  assert.deepEqual(changes, [], 'no change event for the new account');
  assert.deepEqual(h.toasts, [], 'nothing said');
  // The idempotency key is spent: the new account's own ask of the same input is a new ask.
  await h.JE.arrAsk.ask(input, { bound: h.NATIVE.bound() });
  const writes = h.sent('POST', '/acquire/requests');
  assert.equal(writes.length, 2);
  assert.notEqual(writes[1][3].clientRequestId, firstId);
  assert.equal(writes[1][0], 'user-b');
});

// ------------------------------------------------------------------ R12-5 (S5): episode details are on the stack

const exposeRow = { 'arr/ask/ask-episodes.js': source => source.replace('JE.initializeArrAskEpisodes = initialize;', 'JE.initializeArrAskEpisodes = initialize; JE.__buildEpisodeRow = buildRow;') };
const episode = { episode: 2, season: 1, key: 'tv:tmdb:1399:s1:e2', stage: 'notHere', reason: { code: 'unmonitored' } };

for (const host of HOSTS) {
  test(`R12-5: a script's click on an episode row opens nothing; the viewer's opens an owned, topmost dialog that alone takes Escape (${host})`, async t => {
    const h = setup(t, { plants: exposeRow });
    hostInput(h, host, { tv: true });
    await h.JE.jellyseerrMoreInfo.open(603, 'movie', undefined, h.NATIVE); await delivered();
    const info = moreInfo(h);
    const row = h.JE.__buildEpisodeRow(episode, { contact: 'Dad' });
    h.document.body.append(row);
    row.querySelector('.je-ask-row-title').click(); await delivered();
    assert.equal(h.document.querySelector('.je-ask-dialog-backdrop'), null, 'a script opens nothing');
    assert.equal(h.JE.isTopmostSurface(info), true);
    // The viewer opens it from the season page (More Info closed by the viewer first).
    h.key(info.querySelector('button'), 'Escape', { keyCode: 27 }); await wait(10); await delivered();
    assert.equal(info._isClosing, true);
    const title = row.querySelector('.je-ask-row-title');
    title.focus();
    h.click(title); await delivered();
    const dialog = h.document.querySelector('.je-ask-dialog-backdrop');
    assert.ok(dialog, 'the viewer opens it');
    assert.ok(h.JE.scopeOf(dialog), 'owned');
    assert.equal(h.JE.isTopmostSurface(dialog), true, 'on the stack, topmost');
    h.key(dialog.querySelector('button'), 'Escape', { keyCode: 27 }); await delivered();
    assert.equal(dialog.isConnected, false, 'Escape closes the episode dialog');
    assert.equal(h.document.activeElement, title, 'focus back on its opener');
  });
}

test('R12-5: the effect inventory sees the episode dialog\'s opening (a surface), not just known opener names', () => {
  const found = inventory(readSources(), ['arr/ask/ask-episodes.js']);
  const sites = found['arr/ask/ask-episodes.js'];
  const opening = Object.keys(sites).filter(key => key.startsWith('openDetails ') && / (surface|dialog) /.test(key));
  assert.ok(opening.length > 0, 'openDetails opens a surface: ' + Object.keys(sites).filter(key => key.startsWith('openDetails ')).join(', '));
});

// ------------------------------------------------------------------ R12-6 (S6): a host dialog above Manage keeps focus and keys

for (const version of HOSTS) {
  test(`R12-6: a host dialog above Manage keeps its focus, and Escape leaves the covered drawer open (${version})`, async t => {
    const h = setup(t);
    hostInput(h, version);
    await h.JE.arrManage.open({ key: 'movie:tmdb:603' }, { operation: h.NATIVE }); await delivered();
    const drawer = h.document.querySelector('.je-manage-overlay');
    assert.ok(drawer);
    const host = h.document.createElement('div'); host.className = 'dialogContainer'; host.innerHTML = '<button>Host OK</button>';
    h.document.body.append(host); await delivered();
    assert.equal(h.JE.isTopmostSurface(host), true);
    host.querySelector('button').focus();
    assert.equal(h.document.activeElement, host.querySelector('button'), 'the top host dialog keeps focus');
    h.key(h.document.activeElement, 'Escape', { keyCode: 27 }); await delivered();
    assert.equal(drawer.isConnected, true, 'the covered drawer ignores the host dialog\'s keys');
    assert.equal(host.isConnected, true);
    host.remove(); await delivered();
    // Control: with the host dialog gone, the drawer is topmost again and takes Escape.
    assert.equal(h.JE.isTopmostSurface(drawer), true);
    h.key(drawer.querySelector('button') || drawer, 'Escape', { keyCode: 27 }); await delivered();
    assert.equal(drawer.isConnected, false);
  });
}

// ------------------------------------------------------------------ R12-7 (S7): admission before shared state

test('R12-7: an ended request-sheet opening changes nothing: the viewer\'s pending opening still opens', async t => {
  const h = setup(t);
  const stale = h.NATIVE;
  await h.leave('#/details?id=new');
  const gate = h.hold('GET', '/acquire/requests/me');
  const current = h.JE.arrAskSheet.open({ key: 'movie:tmdb:603', kind: 'movie', name: 'Current' }, { operation: h.NATIVE });
  await delivered();
  assert.equal(await h.JE.arrAskSheet.open({ key: 'movie:tmdb:604', kind: 'movie', name: 'Old' }, { operation: stale, caps: MEMBER }), null);
  gate.resolve();
  await delivered();
  assert.equal(h.document.querySelectorAll('.je-sheet').length, 1, 'the current opening opens its sheet');
  // It is the current title's: its Request asks for 603 (the rejected opening was for 604).
  h.click(h.document.querySelector('.je-sheet-primary'));
  await current; await delivered();
  assert.deepEqual(h.sent('POST', '/acquire/requests').map(r => r[3].input.key), ['movie:tmdb:603']);
});

test('R12-7: an ended season-selection opening changes nothing: the viewer\'s pending opening still opens', async t => {
  const h = setup(t, { asks: false });
  const stale = h.NATIVE;
  await h.leave('#/details?id=new');
  const gate = h.hold('GET', '/jellyseerr/settings/partial-requests');
  const current = h.JE.jellyseerrUI.showSeasonSelectionModal(1399, 'tv', 'Current', null, false, h.NATIVE);
  await delivered();
  const invalid = h.JE.jellyseerrUI.showSeasonSelectionModal(1398, 'tv', 'Old', null, false, stale);
  await delivered();
  gate.resolve();
  await Promise.all([current, invalid]); await delivered();
  const modal = seerrModal(h);
  assert.ok(modal, 'the current opening opens its modal');
  assert.match(modal.textContent, /Current/);
});

// ------------------------------------------------------------------ R12-8 (S8 = B4): offers finish

test('R12-8: opening and closing one card\'s menu 40 times keeps the operation registry bounded', async t => {
  const h = setup(t, { card: true });
  h.a.scan(); await delivered();
  const button = h.document.querySelector('.je-card-more');
  assert.ok(button);
  const baseline = h.a.registrySize();
  const sizes = [];
  for (let i = 0; i < 40; i++) {
    h.click(button); await delivered();
    assert.ok(h.document.querySelector('.je-actions-sheet'));
    h.click(h.document.querySelector('.je-actions-close')); await delivered();
    assert.equal(h.document.querySelector('.je-actions-sheet'), null);
    sizes.push(h.a.registrySize());
  }
  assert.ok(sizes.at(-1) <= baseline + 1, `bounded: ${baseline} → ${sizes.join(',')}`);
  assert.equal(sizes.at(-1), sizes[0], 'constant after settlement');
});

// ------------------------------------------------------------------ R12-9 (B1): another client's remote Select

for (const host of HOSTS) {
  test(`R12-9: a remote Select (jellyfin-web's real remote-command path, ${host}) requests the focused title once; a direct click() does not`, async t => {
    const h = setup(t, { asks: false }); record(h);
    loadCards(h);
    const button = seerrCard(h, 603);
    const input = hostInput(h, host);
    const remote = await input.remote();
    t.after(() => remote.close());
    button.focus();
    // Negative controls first: a script's click on the focused Request, a forged command event, and the input
    // manager's own select called outside any server message.
    button.click(); await delivered();
    button.dispatchEvent(new h.window.CustomEvent('command', { detail: { command: 'select' }, bubbles: true, cancelable: true })); button.click(); await delivered();
    input.handleCommand('select'); await delivered();
    assert.equal(h.sent('POST', '/jellyseerr/request').length, 0, 'no script path requests');
    await remote.command('Select'); await delivered();
    assert.equal(h.sent('POST', '/jellyseerr/request').length, 1, 'the person controlling this browser from another client can Request');
  });

  test(`R12-9: a remote Select (${host}) opens the focused row's More`, async t => {
    const h = setup(t, { asks: false }); record(h); h.a.initialize(); mount(h); await delivered();
    const input = hostInput(h, host);
    const remote = await input.remote();
    t.after(() => remote.close());
    const more = h.row().querySelector('.je-actions-more'); more.focus();
    input.handleCommand('select'); await delivered();
    assert.equal(h.document.querySelector('.je-actions-backdrop'), null, 'select outside a server message opens nothing');
    await remote.command('Select'); await delivered();
    assert.ok(h.document.querySelector('.je-actions-backdrop'), 'remote Select opens More');
  });

  test(`R12-9 control: remote Back closes only the nested request form (${host})`, async t => {
    const h = setup(t, { asks: false, advanced: true }); record(h);
    const input = hostInput(h, host, { tv: true });
    h.window.history.pushState({}, '', '#/search?query=matrix'); await delivered();
    await h.JE.jellyseerrMoreInfo.open(603, 'movie', undefined, h.NATIVE); await delivered();
    const info = moreInfo(h); h.click(info.querySelector('.jellyseerr-request-button')); await wait(70); await delivered();
    const form = seerrModal(h); assert.ok(form); form.querySelector('button').focus();
    input.handleCommand('back'); await wait(40); await delivered();
    assert.ok(form._isClosing); assert.ok(!info._isClosing);
  });

  test(`R12-9 control: a remote Back through the server's message closes only the nested request form (${host})`, async t => {
    const h = setup(t, { asks: false, advanced: true }); record(h);
    const input = hostInput(h, host, { tv: true });
    const remote = await input.remote();
    t.after(() => remote.close());
    h.window.history.pushState({}, '', '#/search?query=matrix'); await delivered();
    await h.JE.jellyseerrMoreInfo.open(603, 'movie', undefined, h.NATIVE); await delivered();
    const info = moreInfo(h); h.click(info.querySelector('.jellyseerr-request-button')); await wait(70); await delivered();
    const form = seerrModal(h); assert.ok(form); form.querySelector('button').focus();
    await remote.command('Back'); await wait(40); await delivered();
    assert.ok(form._isClosing); assert.ok(!info._isClosing);
  });
}

test('R12-8: reopening and dismissing the same card\'s More 30 times releases every finished opening', async t => {
  const plants = { 'arr/actions/title-actions.js': s => s.replace('const live = new Set();', 'const live = new Set(); A.__liveCount = () => live.size;') };
  const h = setup(t, { asks: false, plants }); record(h); h.a.initialize();
  const card = h.document.createElement('div'); card.className = 'jellyseerr-card';
  card.dataset.tmdbId = '603'; card.dataset.mediaType = 'movie'; h.document.body.append(card); h.a.scan(); await delivered();
  const counts = [];
  for (let i = 0; i < 30; i++) {
    h.click(card.querySelector('.je-card-more')); await delivered();
    assert.ok(h.document.querySelector('.je-actions-backdrop'));
    h.a.close(); await delivered();
    if ([0, 9, 29].includes(i)) counts.push(h.a.__liveCount());
  }
  assert.ok(counts.at(-1) <= counts[0], `finished openings are released: ${counts.join(',')}`);
});
