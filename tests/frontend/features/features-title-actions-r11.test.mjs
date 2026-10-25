import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, mount, delivered, moreInfo } from '../helpers/title-actions-scopes.mjs';
import { hostInput, gamepad, HOSTS } from '../helpers/host-input.mjs';

// D46 slice 2 review round 11: the core decides, callers only restrict. Whether an owner is current, native or may write
// comes from the core's own record of it: a plain object never grants, focus alone never grants (only a trusted event,
// or jellyfin-web's own verified gamepad activation of the focused control), a token remembered for an event serves only
// that target and dispatch and is never consulted inside an operation, a control drawn before an account switch grants
// nothing, and the transport checks an owned write's token itself (a binding's predicate only restricts). Every effect
// reachable from a title's actions checks its owner as it happens (Hide, a notification's navigation, the Guard reload,
// More Info's opening generation, feedback), and every write has three outcomes (never sent, taken after its owner
// ended, answered) with the module caches keyed by their family's write epoch. Real core, transport and owners; only
// the server is scripted. Trust is the harness's explicit test-only h.click / h.trusted (every click() is untrusted).

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const posts = h => h.sent('POST', '/jellyseerr/request');

/** Watches refusals the way production meets them (logged, nothing opens or is sent) instead of throwing. */
function recordRefusals(h) {
  h.JE.strictOwners = 'record';
  h.JE.refusals = [];
  return () => h.JE.refusals || [];
}

/** The search card's real Request button module (its popover and buttons). */
function searchButtons(h) {
  h.JE.core.ui = { addTouchTapListener() {}, addDelegatedTouchTapListener() {} };
  for (const m of ['jellyseerr/ui/ui-popover.js', 'jellyseerr/ui/ui-buttons.js']) h.load(m);
}

/** A search card for `id` with its real Request button (configured as the results page does). */
function card(h, id = 603) {
  const node = h.document.createElement('div'); node.className = 'jellyseerr-card';
  node.dataset.tmdbId = id; node.dataset.mediaType = 'movie';
  node.innerHTML = `<button class="jellyseerr-request-button" data-tmdb-id="${id}" data-media-type="movie"></button>`;
  h.document.body.append(node);
  h.JE.jellyseerrUI.configureRequestButton(node.firstChild, { id, mediaType: 'movie', title: 'Movie ' + id, mediaInfo: { status: 1, status4k: 1 } }, true, true);
  return { node, button: node.querySelector('.jellyseerr-split-main') || node.querySelector('button') };
}

// ------------------------------------------------------------------ shape 1: the core decides who acts

test('R11-1: a plain object shaped like a trusted event grants nothing (nativeFrom, ownerOf), and nothing can be sent for it', async t => {
  const h = setup(t, { asks: false });
  const refusals = recordRefusals(h);
  const forged = { type: 'click', eventPhase: 2, isTrusted: true, target: h.document.body, composedPath: () => [h.document.body] };
  assert.equal(h.JE.nativeFrom(forged), null);
  assert.equal(h.JE.ownerOf(forged), null);
  assert.equal(h.JE.captureSubmitted(forged).owner, null);
  await h.JE.jellyseerrAPI.requestMedia(603, 'movie', {}, false, null, null, { bound: h.JE.captureSubmitted(forged).bound() }).catch(() => null);
  await delivered();
  assert.equal(posts(h).length, 0);
  assert.ok(refusals().length >= 1, 'the owner-less calls were refused');
});

test('R11-1: a script click() on a focused Request (rendered before an account switch) sends nothing as anyone', async t => {
  const h = setup(t, { asks: false }); searchButtons(h); recordRefusals(h);
  const c = card(h);
  let observed;
  c.button.addEventListener('click', e => { observed = { trusted: e.isTrusted, token: h.JE.ownerOf(e) }; });
  c.button.focus();
  assert.equal(h.document.activeElement, c.button);
  h.switchUser(); await delivered();
  c.button.click(); await delivered();
  assert.equal(observed.trusted, false);
  assert.equal(observed.token, null, 'focus alone is no gesture');
  assert.equal(posts(h).length, 0);
});

test('R11-1: a JE timer\'s click() on the focused Request of a search card sends nothing (same account)', async t => {
  const h = setup(t, { asks: false }); searchButtons(h); recordRefusals(h);
  const { button } = card(h);
  button.focus();
  await new Promise(resolve => setTimeout(() => { button.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true, cancelable: true })); resolve(); }, 0));
  await new Promise(resolve => setTimeout(() => { button.click(); resolve(); }, 0));
  await delivered();
  assert.equal(posts(h).length, 0, 'no viewer pressed Request');
  assert.equal(button.disabled, false, 'a click no one made leaves the button as it was');
});

test('R11-1 control: the viewer\'s own click on the same Request sends it once', async t => {
  const h = setup(t, { asks: false }); searchButtons(h);
  const { button } = card(h);
  h.click(button); await delivered();
  assert.equal(posts(h).length, 1);
  assert.equal(posts(h)[0][3].mediaId, 603);
});

test('R11-1: a trusted click on a Request drawn before an account switch is no one\'s: nothing is sent as the new account', async t => {
  const h = setup(t, { asks: false }); searchButtons(h); recordRefusals(h);
  const { button } = card(h);
  h.switchUser(); await delivered();
  h.click(button); await delivered();
  assert.equal(posts(h).length, 0);
});

for (const host of HOSTS) {
  test(`R11-1: jellyfin-web ${host}'s own gamepad OK (its real gamepad-to-key chain) on a focused Request sends it once`, async t => {
    const h = setup(t, { asks: false }); searchButtons(h);
    const { button } = card(h);
    const input = hostInput(h, host);
    const pad = gamepad();
    const stop = input.gamepad(pad);
    t.after(stop);
    button.focus();
    const seen = [];
    button.addEventListener('click', e => seen.push(e.isTrusted));
    pad.buttons[0].pressed = true; await wait(70);
    pad.buttons[0].pressed = false; await wait(70);
    await delivered();
    assert.deepEqual(seen, [false], 'the host clicked the focused control itself (an untrusted click)');
    assert.equal(posts(h).length, 1);
    assert.equal(posts(h)[0][3].mediaId, 603);
  });

  test(`R11-1: jellyfin-web ${host}'s gamepad key event, then a click() in a later task (a JE timer) → nothing is sent`, async t => {
    const h = setup(t, { asks: false }); searchButtons(h); recordRefusals(h);
    const { button } = card(h);
    hostInput(h, host);
    button.focus();
    // The host's own key event, prevented (so the host itself clicks nothing), and a click a timer makes afterwards.
    const key = new h.window.Event('keyup', { bubbles: true, cancelable: true });
    key.key = 'GamepadA'; key.keyCode = 13;
    button.addEventListener('keyup', e => e.preventDefault(), { once: true });
    button.dispatchEvent(key);
    await new Promise(resolve => setTimeout(() => { button.click(); resolve(); }, 0));
    await delivered();
    assert.equal(posts(h).length, 0);
  });
}

test('R11-1: the host\'s UWP gamepad OK (a trusted keydown 195) selects the focused Request through jellyfin-web\'s own input manager → sent once', async t => {
  const h = setup(t, { asks: false }); searchButtons(h);
  const { button } = card(h);
  hostInput(h, '12.2');
  button.focus();
  h.key(button, 'Unidentified', { keyCode: 195 });
  await delivered();
  assert.equal(posts(h).length, 1);
});

test('R11-1: the action bar\'s own entry points take only a press someone made: a script\'s click on its press relay, its row Request, its More and its sheet entry does nothing; the viewer\'s does', async t => {
  const h = setup(t, { asks: false }); recordRefusals(h);
  h.a.initialize(); mount(h); await delivered();
  // The press relay (bindPress): a script's click is swallowed, the viewer's becomes the row's operation.
  const relay = h.document.createElement('button'); h.document.body.append(relay);
  const owners = [];
  relay.addEventListener('click', e => owners.push(h.JE.ownerOf(e)));
  h.a.bindPress(relay, h.a.generation());
  relay.click(); await delivered();
  assert.deepEqual(owners, [], 'a script\'s click reaches no handler as anyone\'s');
  h.click(relay); await delivered();
  assert.equal(owners.length, 1); assert.equal(owners[0]?.kind, 'operation');
  // The row's adapted Request (Seerr's window): a script's click opens nothing; the viewer's opens it.
  const request = h.row().querySelector('[data-je-action-kind="request"], .je-actions-primary');
  assert.ok(request, 'the row offers Request');
  request.click(); await delivered(); await wait(20); await delivered();
  assert.equal(moreInfo(h), null);
  // More: a script's click opens no sheet; the viewer's does, and a script's click on its entry runs nothing.
  const more = h.row().querySelector('.je-actions-more, .je-actions-wide-more');
  more.click(); await delivered();
  assert.equal(h.document.querySelector('.je-actions-sheet'), null);
  h.click(more); await delivered();
  const entry = h.document.querySelector('.je-actions-sheet .je-actions-entry[data-action="request"]');
  assert.ok(entry, 'the sheet offers Request');
  entry.click(); await delivered(); await wait(20); await delivered();
  assert.equal(moreInfo(h), null, 'a script\'s click on the sheet\'s entry runs nothing');
  h.click(entry); await delivered(); await wait(20); await delivered();
  assert.ok(moreInfo(h), 'the viewer\'s press on the entry opens the window');
});

test('R11-2: a remembered trusted gesture handed to code inside an operation\'s press is refused before the memo (nothing is sent after the route ends)', async t => {
  const h = setup(t, { asks: false }); const refusals = recordRefusals(h);
  h.a.initialize(); mount(h); await delivered();
  const seed = h.document.createElement('button'); h.document.body.append(seed);
  let event, native;
  seed.onclick = e => { event = e; native = h.JE.nativeFrom(e); };
  h.trusted(seed, new h.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  assert.equal(native?.native, true, 'the gesture itself is native');
  const op = h.a.generation();
  const gate = h.hold('GET', '/jellyseerr/overrideRule');
  let borrowed = 'not pressed', done = null;
  const trigger = h.document.createElement('button'); h.document.body.append(trigger);
  trigger.onclick = () => {
    borrowed = h.JE.nativeFrom(event);
    if (borrowed) done = h.JE.jellyseerrAPI.requestMedia(603, 'movie', {}, false, { id: 603, title: 'Old title' }, null, { bound: borrowed.bound() });
  };
  h.JE.press(trigger, op); await delivered();
  assert.equal(borrowed, null, 'the restriction applies before any remembered token');
  assert.ok(refusals().some(r => /inside an operation/.test(r)));
  await h.leave('#/details?id=new-title');
  gate.resolve([]); await done; await delivered();
  assert.equal(posts(h).length, 0);
});

test('R11-2: a once-trusted gesture re-dispatched onto another card\'s Request (after its route ended) sends nothing', async t => {
  const h = setup(t, { asks: false }); searchButtons(h); recordRefusals(h);
  const c = card(h);
  const seed = h.document.createElement('button'); h.document.body.append(seed);
  let saved;
  seed.onclick = e => { saved = e; h.JE.nativeFrom(e); };
  h.trusted(seed, new h.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await h.leave('#/details?id=new-title');
  let trusted;
  c.button.addEventListener('click', e => { trusted = e.isTrusted; });
  c.button.dispatchEvent(saved); await delivered();
  assert.equal(trusted, false);
  assert.equal(posts(h).length, 0);
});

test('R11-2: the viewer\'s real click on 603, re-dispatched onto 604\'s Request → only 603 is requested', async t => {
  const h = setup(t, { asks: false }); searchButtons(h); recordRefusals(h);
  const first = card(h, 603).button;
  const other = card(h, 604).button;
  let original;
  first.addEventListener('click', e => { original = e; }, true);
  first.focus();
  h.trusted(first, new h.window.MouseEvent('click', { bubbles: true, cancelable: true })); await delivered();
  assert.equal(posts(h).length, 1);
  other.dispatchEvent(original); await delivered();
  assert.equal(original.isTrusted, false);
  assert.notEqual(h.document.activeElement, other);
  assert.deepEqual(posts(h).map(p => p[3].mediaId), [603], 'the trusted click was on 603, never 604');
});

test('R11-3: the transport checks an owned write\'s token itself: an ended token in a binding whose predicate says yes sends nothing', async t => {
  const h = setup(t, { asks: false }); recordRefusals(h);
  const op = h.a.generation();
  const bound = { token: op, session: op.session, current: () => true };
  await h.leave('#/details?id=new-title');
  assert.equal(op.current(), false);
  const error = await h.JE.jellyseerrAPI.requestMedia(603, 'movie', {}, false, null, null, { bound }).then(() => null, e => e);
  await delivered();
  assert.equal(posts(h).length, 0);
  assert.equal(h.JE.core.api.writeOutcome(error).outcome, 'unsent');
});

test('R11-3: a binding naming another session than its token\'s sends nothing; a binding\'s predicate can only restrict (control)', async t => {
  const h = setup(t, { asks: false }); recordRefusals(h);
  const op = h.a.generation();
  const other = h.a.generation();
  await h.JE.jellyseerrAPI.requestMedia(603, 'movie', {}, false, null, null, { bound: { token: op, session: other.session, current: () => true } }).catch(() => null);
  assert.equal(posts(h).length, 0, 'the token\'s own session only');
  await h.JE.jellyseerrAPI.requestMedia(603, 'movie', {}, false, null, null, { bound: op.bound(() => false) }).catch(() => null);
  assert.equal(posts(h).length, 0, 'a predicate that says no restricts');
  await h.JE.jellyseerrAPI.requestMedia(603, 'movie', {}, false, null, null, { bound: op.bound() });
  assert.equal(posts(h).length, 1, 'a current token with its own binding sends');
});

test('R11 harness: a production module\'s click() and a test\'s click() are untrusted; only the explicit test-only h.click is the viewer\'s', async t => {
  const h = setup(t, { asks: false });
  const owner = h.a.generation();
  // The core dismisses a host dialog the way its viewer would: its own button.click() (a production module's click).
  h.JE.openHostDialog(mark => h.window.Dashboard.alert({ message: mark('Quota') }), owner);
  await delivered();
  const ok = h.document.querySelector('.dialogContainer .btnOption');
  const trust = [];
  ok.addEventListener('click', e => trust.push(e.isTrusted));
  owner.end(); await delivered();
  assert.deepEqual(trust, [false], 'the core\'s click() is untrusted');
  const probe = h.document.createElement('button'); h.document.body.append(probe);
  const seen = [];
  probe.addEventListener('click', e => seen.push(e.isTrusted));
  probe.click(); h.click(probe);
  assert.deepEqual(seen, [false, true]);
});

// ------------------------------------------------------------------ shape 2: every effect checks its owner as it happens

/** The real Hide control of an absent title (Hidden Content's data module), confirmation off. */
function hideControl(h) {
  h.JE.userConfig = { hiddenContent: { items: {}, settings: { enabled: true, showHideButtons: true, showButtonJellyseerr: true, showHideConfirmation: false } } };
  h.load('enhanced/hiddencontent/hidden-content-data.js');
  const hc = h.JE.internals.hiddenContent;
  const undo = [];
  Object.assign(hc, { refreshNativeCardVisibility() {}, showUndoToast: name => undo.push(name) });
  const control = hc.buildTitleControl({ mediaType: 'movie', tmdbId: 603, name: 'Absent movie' });
  h.document.body.append(control);
  return { hc, control, undo };
}
const hidePut = h => h.sent('PUT', '/user-settings/user-a/hidden-content/rule/movie%3Atmdb%3A603');

test('R11-4: an absent title\'s Hide clicked by a script (no owner) writes nothing', async t => {
  const h = setup(t, { asks: false }); recordRefusals(h);
  const { hc, control } = hideControl(h);
  assert.notEqual(h.document.activeElement, control);
  control.click(); await delivered();
  control.focus(); control.click(); await delivered();
  assert.equal(hidePut(h).length, 0);
  assert.equal(hc.isHiddenByTmdbId(603, 'movie'), false);
});

test('R11-4 control: the viewer\'s own press on the absent title\'s Hide hides it once', async t => {
  const h = setup(t, { asks: false });
  const { hc, control, undo } = hideControl(h);
  h.click(control); await delivered(); await wait(10); await delivered();
  assert.equal(hidePut(h).length, 1);
  assert.equal(hc.isHiddenByTmdbId(603, 'movie'), true);
  assert.deepEqual(undo, ['Absent movie']);
});

test('R11-4: the Undo after hiding an absent title: a script\'s click undoes nothing; the viewer\'s Undo removes the rule once', async t => {
  const h = setup(t, { asks: false });
  const { hc, control } = hideControl(h);
  h.click(control); await delivered(); await wait(10); await delivered();
  assert.equal(hc.isHiddenByTmdbId(603, 'movie'), true);
  // The real Undo toast (Hidden Content's dialogs module).
  h.load('enhanced/hiddencontent/hidden-content-dialogs.js');
  hc.showUndoToast('Absent movie', 'movie:tmdb:603');
  const undo = h.document.querySelector('.je-undo-btn');
  const removals = () => h.sent('DELETE', '/user-settings/user-a/hidden-content/rule/movie%3Atmdb%3A603').length;
  undo.click(); await delivered(); await wait(10); await delivered();
  assert.equal(removals(), 0, 'a click no one made undoes nothing');
  h.click(undo); await delivered(); await wait(10); await delivered();
  assert.equal(removals(), 1);
  assert.equal(hc.isHiddenByTmdbId(603, 'movie'), false);
});

test('R11-9: a Hide the server took after its owner ended reconciles the rule for the session and says nothing on the newer page', async t => {
  const h = setup(t, { asks: false });
  const { hc, control, undo } = hideControl(h);
  const op = h.a.generation();
  const gate = h.hold('PUT', '/user-settings/user-a/hidden-content/rule/');
  h.JE.press(control, op); await delivered();
  assert.equal(hidePut(h).length, 1, 'sent while its owner was current');
  await h.leave('#/details?id=next-title');
  gate.resolve({ item: { type: 'Movie', tmdbId: '603', hideScope: 'global' }, items: { 'movie:tmdb:603': { type: 'Movie', tmdbId: '603', hideScope: 'global' } }, revision: 2 });
  await delivered(); await wait(10); await delivered();
  assert.equal(hc.isHiddenByTmdbId(603, 'movie'), true, 'the accepted rule is the session\'s state');
  assert.deepEqual(undo, [], 'no undo toast on the newer page');
});

test('R11-5: a notification opened for an ended press or no owner navigates nothing (every branch)', async t => {
  const h = setup(t, { asks: false }); const refusals = recordRefusals(h);
  h.load('arr/notify/notify-core.js');
  const op = h.a.generation();
  await h.leave('#/details?id=current-title');
  h.JE.arrNotify.open({ id: 'n', read: true, kind: 'ready', key: 'movie:tmdb:603' }, op);
  h.JE.arrNotify.open({ id: 'n', read: true, kind: 'ready', itemId: 'a'.repeat(32) }, op);
  await delivered();
  assert.equal(h.window.location.hash, '#/details?id=current-title');
  h.JE.arrNotify.open({ id: 'n', read: true, kind: 'ready', key: 'movie:tmdb:603' }, null);
  await delivered();
  assert.equal(h.window.location.hash, '#/details?id=current-title');
  assert.ok(refusals().some(r => /a notification was called without an owner/.test(r)));
});

test('R11-5 control: a notification the viewer opens now goes to the Requests page', async t => {
  const h = setup(t, { asks: false });
  h.load('arr/notify/notify-core.js');
  h.JE.arrNotify.open({ id: 'n', read: true, kind: 'ready', key: 'movie:tmdb:603' }, h.NATIVE);
  await delivered();
  assert.equal(h.window.location.hash, '#/requests');
});

/** The real Spoiler Guard detail button on a library title's page, its reload planted as a probe. */
async function guard(h) {
  h.JE.pluginConfig.SpoilerBlurEnabled = true;
  h.JE.core.ui = { placeDetailAction: (row, button) => row.append(button) };
  const reloaded = []; h.window.__reload = hash => reloaded.push(hash);
  for (const m of ['ids', 'state', 'image-refresh', 'detail-button']) h.load(`enhanced/spoilerguard/${m}.js`);
  const sg = h.JE.internals.spoilerGuard; await sg.whenLoaded();
  h.page.id = 'itemDetailPage'; h.page.insertAdjacentHTML('afterbegin', '<h1 class="itemName">Original</h1>');
  sg.addSpoilerBlurButton('lib1', h.page, 'Movie');
  return { reloaded, button: h.page.querySelector('.je-spoiler-blur-btn') };
}
const reloadPlant = { 'enhanced/spoilerguard/image-refresh.js': s => s.replace('location.reload();', 'window.__reload(location.hash);') };

test('R11-6: a Guard toggle, then another title within 600 ms → the newer title is not reloaded', async t => {
  const h = setup(t, { asks: false, plants: reloadPlant });
  const { reloaded, button } = await guard(h);
  const owner = h.a.generation();
  h.JE.press(button, owner); await delivered();
  assert.ok(h.toasts.includes('spoiler_blur_enabled_movie_toast'));
  await h.leave('#/details?id=new-title');
  await wait(650);
  assert.deepEqual(reloaded, []);
});

test('R11-6 control: a Guard toggle on a page that stays reloads it once, 600 ms later', async t => {
  const h = setup(t, { asks: false, plants: reloadPlant });
  const { reloaded, button } = await guard(h);
  h.JE.press(button, h.a.generation()); await delivered();
  await wait(650);
  assert.deepEqual(reloaded, ['#/details?id=x']);
});

test('R11-7: a stale More Info call is refused before it touches the opening generation: the viewer\'s pending opening still opens', async t => {
  const h = setup(t, { asks: false }); recordRefusals(h);
  const stale = h.a.generation();
  await h.leave('#/details?id=current-title');
  const gate = h.hold('GET', '/jellyseerr/movie/603');
  const legitimate = h.JE.jellyseerrMoreInfo.open(603, 'movie', undefined, h.NATIVE);
  await delivered();
  await h.JE.jellyseerrMoreInfo.open(604, 'movie', undefined, stale);
  gate.resolve(); await legitimate; await delivered();
  assert.equal(moreInfo(h)?.dataset.tmdbId, '603');
});

test('R11-7: an older window whose owner ends (its card recycled) closes alone: the viewer\'s newer pending opening still opens', async t => {
  const h = setup(t, { asks: false });
  let mounted = true;
  const op = h.a.generation(() => mounted);
  await h.JE.jellyseerrMoreInfo.open(603, 'movie', undefined, op); await delivered();
  assert.equal(moreInfo(h)?.dataset.tmdbId, '603');
  const gate = h.hold('GET', '/jellyseerr/tv/1399');
  const pending = h.JE.jellyseerrMoreInfo.open(1399, 'tv', undefined, h.NATIVE);
  await delivered();
  mounted = false; h.JE.endScopes(); await delivered();
  gate.resolve(); await pending; await delivered();
  assert.equal(moreInfo(h)?.dataset.tmdbId, '1399', 'the newer opening was not superseded by the older window\'s close');
});

test('R11-8: a native one-tap ask answering after the viewer moved on says nothing on the newer title', async t => {
  const h = setup(t, { asks: true });
  const gate = h.hold('POST', '/acquire/requests');
  const owner = h.NATIVE;
  const done = h.JE.arrAskSheet.openOrAsk({ key: 'movie:tmdb:603', kind: 'movie', name: 'Original movie' }, { operation: owner });
  await delivered();
  assert.equal(h.sent('POST', '/acquire/requests').length, 1, 'the viewer\'s ask went out');
  await h.leave('#/details?id=new-title');
  const before = [...h.toasts];
  gate.resolve(); const result = await done; await delivered();
  assert.equal(result.ok, true);
  assert.deepEqual(h.toasts, before);
});

test('R11-8 control: the same one-tap ask on a page that stays says "asked"', async t => {
  const h = setup(t, { asks: true });
  await h.JE.arrAskSheet.openOrAsk({ key: 'movie:tmdb:603', kind: 'movie', name: 'Original movie' }, { operation: h.NATIVE });
  await delivered();
  assert.ok(h.toasts.includes('arr_ask_toast_asked'));
});

/** The real Follow button of a title's row (notify core and follow modules). */
async function followButton(h) {
  h.JE.pluginConfig.ArrNotificationsEnabled = true;
  h.load('arr/notify/notify-core.js'); h.load('arr/notify/notify-follow.js');
  h.respond('GET', '/acquire/follows', [200, { follows: [] }]);
  await h.JE.arrNotify.loadFollows(true);
  const host = h.document.createElement('div'); h.document.body.append(host);
  h.JE.internals.arrNotify.rowButton({ key: 'movie:tmdb:603' }, host);
  await delivered();
  return host.querySelector('button');
}

test('R11-8: a Follow that was never sent (its press ended while it queued) says nothing on the new page', async t => {
  const h = setup(t, { asks: false });
  const button = await followButton(h);
  const release = h.holdPool(); const op = h.a.generation();
  h.JE.press(button, op); await delivered();
  await h.leave('#/details?id=next-title');
  await release(); await delivered();
  assert.equal(h.sent('PUT', '/acquire/follows').length, 0);
  assert.ok(!h.toasts.includes('arr_notify_follow_failed'));
});

test('R11-8 control: a Follow the server refuses while its page stays says why', async t => {
  const h = setup(t, { asks: false });
  const button = await followButton(h);
  h.respond('PUT', '/acquire/follows', [500, { code: 'failed' }]);
  h.click(button); await delivered();
  assert.equal(h.sent('PUT', '/acquire/follows').length, 1);
  assert.ok(h.toasts.includes('arr_notify_follow_failed'));
});

// ------------------------------------------------------------------ shape 3: three outcomes; module caches see the epoch

test('R11-9: an ask the server took after its owner ended is accepted (not cancelled): the title check after it is a fresh read', async t => {
  const h = setup(t, { asks: true }); const key = 'movie:tmdb:603';
  const oldRead = h.hold('GET', '/acquire/requests/check');
  const first = h.JE.arrAsk.check(key); await delivered();
  const post = h.hold('POST', '/acquire/requests');
  const owner = h.a.generation();
  const write = h.JE.arrAsk.ask(h.JE.arrAsk.movieInput(key), { bound: owner.bound() });
  await delivered();
  assert.equal(h.sent('POST', '/acquire/requests').length, 1);
  await h.leave('#/details?id=new-title');
  post.resolve(); const result = await write;
  assert.equal(result.accepted, true, 'accepted, not cancelled');
  assert.equal(result.stale, true, 'and nobody is told on the newer page');
  assert.equal(result.ok, true);
  h.respond('GET', '/acquire/requests/check', [200, { check: { canRequest: false, blocked: { reason: 'quota_exceeded' } } }]);
  const second = h.JE.arrAsk.check(key);
  assert.notEqual(first, second, 'a check after the write never joins the one from before it');
  oldRead.resolve({ check: { canRequest: true, blocked: null } });
  assert.equal((await second).canRequest, false);
  assert.equal(h.sent('GET', '/acquire/requests/check').length, 2);
});

test('R11-9: the capabilities read after an accepted ask is fresh too (the module memo is keyed by the write epoch)', async t => {
  const h = setup(t, { asks: true });
  const before = await h.JE.arrAsk.me();
  assert.ok(before);
  const reads = () => h.sent('GET', '/acquire/requests/me').length;
  const n = reads();
  await h.JE.arrAsk.me();
  assert.equal(reads(), n, 'unchanged: answered from the memo');
  const owner = h.a.generation();
  await h.JE.arrAsk.ask(h.JE.arrAsk.movieInput('movie:tmdb:603'), { bound: owner.bound() });
  await h.JE.arrAsk.me();
  assert.equal(reads(), n + 1, 'after the write: read again');
});

test('R11-9: an ask never sent (its owner ended first) is unsent: no request, no reconciliation', async t => {
  const h = setup(t, { asks: true });
  const owner = h.a.generation();
  await h.leave('#/details?id=new-title');
  const result = await h.JE.arrAsk.ask(h.JE.arrAsk.movieInput('movie:tmdb:603'), { bound: owner.bound() });
  assert.equal(h.sent('POST', '/acquire/requests').length, 0);
  assert.equal(result.stale, true);
  assert.notEqual(result.accepted, true);
});

test('R11-9: a Report the server took after its form\'s owner ended says nothing (neither success nor error)', async t => {
  const h = setup(t, { asks: false });
  const op = h.a.generation();
  const gate = h.hold('POST', '/jellyseerr/issue');
  const done = h.JE.jellyseerrAPI.reportIssue(603, 'movie', 1, 'broken', 0, 0, op);
  await delivered();
  assert.equal(h.sent('POST', '/jellyseerr/issue').length, 1);
  await h.leave('#/details?id=new-title');
  gate.resolve({ id: 9 });
  const result = await done;
  assert.equal(result.jeAccepted, true, 'accepted: the report exists');
});
