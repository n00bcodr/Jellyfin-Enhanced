import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, delivered, moreInfo, mount, press } from '../helpers/title-actions-scopes.mjs';
import { hostInput, HOSTS, publishRouterEarly } from '../helpers/host-input.mjs';

// D46 slice 2 review round 14: jellyfin-web's remote Back is arbitrated before its router decides whether it can go back
// (Home included); the window a title action started in stays that action's origin after the operation it submitted
// outlives its sheet or confirmation (Hide's Undo); a card's mount is one immutable incarnation that a removal or a
// recycle ends for good, checked through every await of an opening; and a dispatched press leaves the registry once its
// synchronous dispatch is over, while the work it handed on (a confirmation, a held write) keeps its own lifetime.

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

// ------------------------------------------------------------------ R14-2: host Back before the router's availability gate

/** Home, with an earlier entry in the history (the router's gate is still false there without a host dialog). */
async function home(h) {
  h.window.history.replaceState(null, '', '#/search?query=matrix'); h.window.history.pushState(null, '', '#/home'); await delivered();
}
/** Opens `surface` on the current page: More Info, the card's More sheet, or a request form over More Info. */
async function openSurface(h, surface) {
  let form = null;
  if (surface === 'more-sheet') h.click(h.document.querySelector('.je-card-more'));
  else {
    await h.JE.jellyseerrMoreInfo.open(603, 'movie', undefined, h.NATIVE);
    if (surface === 'request-form') {
      form = h.JE.jellyseerrModal.create({ title: 'Request', bodyHtml: '<input>', onSave() {}, operation: h.JE.scopeOf(moreInfo(h)) });
      form.show();
    }
  }
  await delivered();
  return () => surface === 'more-sheet' ? !!h.document.querySelector('.je-actions-backdrop') : surface === 'request-form' ? !form.modalElement._isClosing : !!moreInfo(h);
}

for (const version of HOSTS) {
  for (const surface of ['more-info', 'more-sheet', 'request-form']) {
    test(`R14-2: another client's remote Back on Home closes the top ${surface}, with no router step and no Exit (${version})`, async t => {
      const h = setup(t, { asks: false, card: true }); await home(h);
      const input = hostInput(h, version, { tv: true, exit: true }); const remote = await input.remote(); t.after(() => remote.close());
      h.a.initialize(); await delivered();
      const open = await openSurface(h, surface);
      assert.equal(open(), true);
      assert.equal(h.document.querySelector('.dialogContainer'), null);
      assert.equal(h.window.history.length > 1, true);
      assert.equal(input.appRouter.canGoBack(), false, 'the real gate: Home without a host dialog cannot go back');
      await remote.command('Back'); await wait(30); await delivered();
      assert.equal(open(), false, 'the remote Back dismissed the JE surface on Home');
      assert.equal(input.back, 0, 'the router took no step');
      assert.equal(input.exits, 0, 'the app did not exit');
      assert.equal(h.window.location.hash, '#/home');
    });
  }

  test(`R14-2: on Home a nested form, then More Info, close one per remote Back; a third Back is the host's own (no surface: Exit) (${version})`, async t => {
    const h = setup(t, { asks: false }); await home(h);
    const input = hostInput(h, version, { tv: true, exit: true }); const remote = await input.remote(); t.after(() => remote.close());
    const formOpen = await openSurface(h, 'request-form');
    await remote.command('Back'); await wait(30); await delivered();
    assert.equal(formOpen(), false); assert.ok(moreInfo(h), 'More Info under the form stays');
    await remote.command('Back'); await wait(30); await delivered();
    assert.equal(moreInfo(h), null);
    assert.equal(input.exits, 0);
    await remote.command('Back'); await wait(30); await delivered();
    assert.equal(input.exits, 1, 'with no JE surface the host keeps its own Back: the router cannot go back on Home, the app exits');
    assert.equal(input.back, 0);
    assert.equal(h.window.location.hash, '#/home');
  });

  test(`R14-2: on Home with no JE surface and no Exit support, remote Back does nothing (${version})`, async t => {
    const h = setup(t, { asks: false }); await home(h);
    const input = hostInput(h, version, { tv: true, exit: false }); const remote = await input.remote(); t.after(() => remote.close());
    await remote.command('Back'); await wait(30); await delivered();
    assert.equal(input.back, 0); assert.equal(input.exits, 0); assert.equal(h.window.location.hash, '#/home');
  });

  test(`R14-2: on Home a host dialog over More Info keeps the host's Back (its dialog closes, More Info stays) (${version})`, async t => {
    const h = setup(t, { asks: false }); await home(h);
    const input = hostInput(h, version, { tv: true, exit: true }); const remote = await input.remote(); t.after(() => remote.close());
    await h.JE.jellyseerrMoreInfo.open(603, 'movie', undefined, h.NATIVE); await delivered();
    const host = h.document.createElement('div'); host.className = 'dialogContainer'; host.innerHTML = '<div class="dialog opened"><button class="btnOption">Delete</button></div>';
    let pressed = 0; host.querySelector('button').addEventListener('click', () => { pressed++; host.remove(); });
    h.window.history.pushState({ dialogId: 'host' }, '', h.window.location.href);
    h.window.addEventListener('popstate', () => host.remove(), { once: true });
    h.document.body.append(host); await delivered();
    await remote.command('Back'); await wait(30); await delivered();
    assert.equal(host.isConnected, false); assert.equal(pressed, 0);
    assert.ok(moreInfo(h)); assert.equal(input.back, 1); assert.equal(input.exits, 0);
    assert.equal(h.window.location.hash, '#/home');
  });

  test(`R14-2: after consumed remote Backs on Search, the router's own Back (its header button) still navigates (${version})`, async t => {
    const h = setup(t, { asks: false, card: true });
    h.window.history.replaceState(null, '', '#/home'); h.window.history.pushState(null, '', '#/search?query=matrix'); await delivered();
    const input = hostInput(h, version, { tv: true }); const remote = await input.remote(); t.after(() => remote.close());
    h.a.initialize(); await delivered();
    await openSurface(h, 'more-info');
    await remote.command('Back'); await wait(30); await delivered();
    assert.equal(moreInfo(h), null);
    await openSurface(h, 'more-sheet');
    await remote.command('Back'); await wait(30); await delivered();
    assert.equal(h.document.querySelector('.je-actions-backdrop'), null);
    assert.equal(h.window.location.hash, '#/search?query=matrix');
    await input.appRouter.back(); await delivered();
    assert.equal(h.window.location.hash, '#/home', 'the header Back is not left waiting on a step the remote Back never took');
  });

  test(`R14-2: a router that is not published still gets its remote Back on Search through the history step (${version})`, async t => {
    const h = setup(t, { asks: false });
    h.window.history.replaceState(null, '', '#/home'); h.window.history.pushState(null, '', '#/search?query=matrix'); await delivered();
    const input = hostInput(h, version, { tv: true, exposeRouter: false }); const remote = await input.remote(); t.after(() => remote.close());
    await openSurface(h, 'more-info');
    await remote.command('Back'); await wait(30); await delivered();
    assert.equal(moreInfo(h), null); assert.equal(h.window.location.hash, '#/search?query=matrix');
    await remote.command('Back'); await wait(30); await delivered();
    assert.equal(h.window.location.hash, '#/home');
  });

  test(`R14-2: a router the host published before Jellyfin Enhanced loaded (as on a real host) arbitrates remote Back on Home (${version})`, async t => {
    const h = setup(t, { asks: false, beforeLoad: h => publishRouterEarly(h.window) }); await home(h);
    const input = hostInput(h, version, { tv: true, exit: true }); const remote = await input.remote(); t.after(() => remote.close());
    assert.equal(input.appRouter, h.window.Emby.Page, 'inputManager asks the router published at start-up');
    const open = await openSurface(h, 'more-info');
    await remote.command('Back'); await wait(30); await delivered();
    assert.equal(open(), false, 'adapted where it was published, before any plugin script ran');
    assert.equal(input.back, 0); assert.equal(input.exits, 0);
    await remote.command('Back'); await wait(30); await delivered();
    assert.equal(input.exits, 1, 'with no JE surface the host keeps its own Back');
  });

  test(`R14-2 control: the viewer's Escape on Home still closes the top surface (${version})`, async t => {
    const h = setup(t, { asks: false }); await home(h);
    hostInput(h, version, { tv: true });
    await openSurface(h, 'more-info');
    h.key(moreInfo(h).querySelector('button'), 'Escape', { keyCode: 27 }); await delivered();
    assert.equal(moreInfo(h), null);
  });
}

test('R14-2 control: a script calling the router outside any host command does not dismiss a JE surface', async t => {
  const h = setup(t, { asks: false });
  h.window.history.replaceState(null, '', '#/home'); h.window.history.pushState(null, '', '#/search?query=matrix'); await delivered();
  const input = hostInput(h, '12.2', { tv: true });
  await openSurface(h, 'more-info');
  assert.equal(input.appRouter.canGoBack(), true);
  input.handleCommand('back'); await wait(30); await delivered();
  assert.equal(h.window.location.hash, '#/home', 'the router went back as it does for any caller');
  assert.equal(input.back, 1);
});

// ------------------------------------------------------------------ R14-1: Undo belongs to the window the action started in

function hiddenContent(h) {
  h.JE.userConfig = { hiddenContent: { items: {}, settings: { enabled: true, showHideButtons: true, showButtonDetails: true, showButtonJellyseerr: true, showHideConfirmation: true } } };
  h.load('enhanced/hiddencontent/hidden-content-data.js'); h.load('enhanced/hiddencontent/hidden-content-dialogs.js');
  const hc = h.JE.internals.hiddenContent; hc.refreshNativeCardVisibility = () => {};
  // The public export hidden-content-init.js publishes (the More Info renderer and the action bar use it).
  h.JE.hiddenContent = { buildTitleControl: hc.buildTitleControl };
  return hc;
}
/** More Info with the action bar initialized; its production renderer draws the secondary Hide. */
async function managedInfo(h) {
  h.a.initialize();
  await h.JE.jellyseerrMoreInfo.open(603, 'movie', undefined, h.NATIVE);
  await wait(30); await delivered(); h.a.scan(); await delivered();
  const info = moreInfo(h); assert.ok(info);
  return info;
}
/** Starts Hide through `via` (the managed original secondary Hide, More → Hide, or an unmanaged control) and confirms. */
async function hideVia(h, info, via) {
  if (via === 'original') {
    const original = info.querySelector('[data-mount="je-secondary-actions"] .je-detail-hide-btn');
    assert.ok(original, 'the production More Info renderer drew Hide');
    h.click(original);
  } else if (via === 'more-sheet') {
    h.click(info.querySelector('.je-actions-wide-more, .je-actions-more')); await delivered();
    const entry = h.document.querySelector('.je-actions-entry[data-action="hide"]');
    assert.ok(entry, 'the actual sheet offers the existing Hide');
    h.click(entry);
  } else {
    const control = h.JE.hiddenContent.buildTitleControl({ mediaType: 'movie', tmdbId: 603, name: 'The Matrix' });
    info.querySelector('.modal-content').append(control); h.click(control);
  }
  await delivered();
  const confirm = h.document.querySelector('.je-hide-confirm-hide'); assert.ok(confirm, 'the confirmation opened');
  h.click(confirm); await delivered();
}

for (const via of ['original', 'more-sheet', 'unmanaged']) {
  test(`R14-1: Hide via ${via} inside More Info: one PUT, and its Undo is in the window, focusable and pressable (one DELETE)`, async t => {
    const h = setup(t, { asks: false }); hiddenContent(h);
    const info = via === 'unmanaged' ? (await h.JE.jellyseerrMoreInfo.open(603, 'movie', undefined, h.NATIVE), await delivered(), moreInfo(h)) : await managedInfo(h);
    await hideVia(h, info, via);
    assert.equal(h.sent('PUT', '/user-settings/').length, 1, 'the confirmed write was sent');
    const toast = h.document.querySelector('.je-undo-toast'); assert.ok(toast);
    const undo = toast.querySelector('button');
    assert.equal(info.contains(toast), true, 'Undo is in the window the action started in');
    assert.equal(info.contains(h.document.activeElement), true, 'focus came back into More Info, not onto the page');
    assert.equal(h.JE.isCovered(undo), false);
    assert.equal(toast.closest('[inert]'), null);
    undo.focus(); assert.equal(h.document.activeElement, undo);
    h.click(undo); await delivered();
    const deletes = h.sent('DELETE', '/user-settings/');
    assert.equal(deletes.length, 1);
    assert.equal(deletes[0][0], 'user-a'); assert.match(deletes[0][2], /movie%3Atmdb%3A603$/);
  });
}

test('R14-1: a Hide the More sheet draws itself inside More Info (constructed: the window\'s own Hide hidden) answers inside More Info', async t => {
  const h = setup(t, { asks: false }); hiddenContent(h);
  const info = await managedInfo(h);
  info.querySelector('[data-mount="je-secondary-actions"] .je-detail-hide-btn').classList.add('hide');
  h.click(info.querySelector('.je-actions-wide-more, .je-actions-more')); await delivered();
  const entry = h.document.querySelector('.je-actions-entry[data-action="hide"]'); assert.ok(entry, 'the sheet offers its own Hide');
  h.click(entry); await delivered();
  h.click(h.document.querySelector('.je-hide-confirm-hide')); await delivered();
  assert.equal(h.sent('PUT', '/user-settings/').length, 1);
  const toast = h.document.querySelector('.je-undo-toast'); assert.ok(toast);
  assert.equal(info.contains(toast), true, 'the origin was taken before the sheet closed');
  h.click(toast.querySelector('button')); await delivered();
  assert.equal(h.sent('DELETE', '/user-settings/').length, 1);
});

test('R14-1 core: an origin that closed while its operation is still current names no surface (the feedback is the page\'s)', async t => {
  const h = setup(t, { asks: false });
  await h.JE.jellyseerrMoreInfo.open(603, 'movie', undefined, h.NATIVE); await delivered();
  const info = moreInfo(h); assert.ok(info);
  const operation = h.a.generation();
  h.JE.originate(operation, info);
  assert.equal(h.JE.surfaceOf(operation), info);
  h.JE.jellyseerrMoreInfo.close(); await delivered();
  assert.equal(operation.current(), true, 'a page operation outlives the window');
  assert.equal(h.JE.surfaceOf(operation), null);
});

test('R14-1: a newer form over More Info covers the managed Undo; closing it uncovers it', async t => {
  const h = setup(t, { asks: false }); hiddenContent(h);
  const info = await managedInfo(h);
  await hideVia(h, info, 'original');
  const undo = h.document.querySelector('.je-undo-toast button');
  const form = h.JE.jellyseerrModal.create({ title: 'Form', bodyHtml: '<input>', onSave() {}, operation: h.JE.scopeOf(info) });
  form.show(); await delivered();
  assert.equal(h.JE.isCovered(undo), true);
  h.click(undo); await delivered();
  assert.equal(h.sent('DELETE', '/user-settings/').length, 0);
  form.close(); await delivered();
  assert.equal(h.JE.isCovered(undo), false);
});

test('R14-1: an origin that closed before the answer is not replaced by another open window', async t => {
  const h = setup(t, { asks: false }); hiddenContent(h);
  const info = await managedInfo(h);
  const gate = h.hold('PUT', '/user-settings/');
  await hideVia(h, info, 'original');
  assert.equal(h.sent('PUT', '/user-settings/').length, 1);
  h.JE.jellyseerrMoreInfo.close(); await delivered();
  const other = h.JE.jellyseerrModal.create({ title: 'Another window', bodyHtml: '<input>', onSave() {}, operation: h.NATIVE });
  other.show(); await delivered();
  gate.resolve(); await delivered();
  // Closing More Info ended the operation its Hide belonged to: the late answer offers no Undo anywhere, least of all
  // in the window open now.
  assert.equal(h.document.querySelector('.je-undo-toast'), null, 'the old origin never attaches to another window');
  assert.equal(other.modalElement.querySelector('.je-undo-toast, .je-undo-btn'), null);
  other.close();
});

test('R14-1: Hide started on the page (row More → Hide) answers on the page, not in a window opened meanwhile', async t => {
  const h = setup(t, { asks: false }); hiddenContent(h);
  mount(h); await delivered();
  const gate = h.hold('PUT', '/user-settings/');
  await press(h, 'hide');
  h.click(h.document.querySelector('.je-hide-confirm-hide')); await delivered();
  assert.equal(h.sent('PUT', '/user-settings/').length, 1);
  const other = h.JE.jellyseerrModal.create({ title: 'Another window', bodyHtml: '<input>', onSave() {}, operation: h.NATIVE });
  other.show(); await delivered();
  gate.resolve(); await delivered();
  const toast = h.document.querySelector('.je-undo-toast'); assert.ok(toast);
  assert.equal(other.modalElement.contains(toast), false, 'a page origin never becomes the newest window');
  assert.equal(toast.parentElement, h.document.body);
  other.close(); await delivered();
  const undo = toast.querySelector('button');
  assert.equal(h.JE.isCovered(undo), false);
  h.click(undo); await delivered();
  assert.equal(h.sent('DELETE', '/user-settings/').length, 1);
});

test('R14-1: an account switch ends the managed Undo shown in More Info; pressing it writes nothing', async t => {
  const h = setup(t, { asks: false }); hiddenContent(h);
  const info = await managedInfo(h);
  await hideVia(h, info, 'original');
  const undo = info.querySelector('.je-undo-toast button'); assert.ok(undo);
  h.switchUser(); await wait(350); await delivered();
  assert.equal(undo.isConnected, false, 'the Undo went with its window and its account');
  h.click(undo); await delivered();
  assert.equal(h.sent('DELETE', '/user-settings/').length, 0);
});

test('R14-1: the managed Undo expires while More Info stays open, and expiry writes nothing', async t => {
  const h = setup(t, { asks: false }); hiddenContent(h);
  const info = await managedInfo(h);
  // The Undo's 8 s expiry, run on demand (every other timer is the window's own).
  const expiries = []; const native = h.window.setTimeout;
  h.window.setTimeout = (fn, ms, ...rest) => ms === 8000 ? (expiries.push(fn), 0) : native.call(h.window, fn, ms, ...rest);
  t.after(() => { h.window.setTimeout = native; });
  await hideVia(h, info, 'more-sheet');
  assert.ok(info.querySelector('.je-undo-toast')); assert.equal(expiries.length, 1);
  expiries[0](); await wait(350); await delivered();
  assert.equal(h.document.querySelector('.je-undo-toast'), null);
  assert.ok(moreInfo(h), 'More Info stays open');
  assert.equal(h.sent('DELETE', '/user-settings/').length, 0);
});

test('R14-1: closing the window removes its Undo; nothing is written', async t => {
  const h = setup(t, { asks: false }); hiddenContent(h);
  const info = await managedInfo(h);
  await hideVia(h, info, 'more-sheet');
  assert.ok(info.querySelector('.je-undo-toast'));
  h.JE.jellyseerrMoreInfo.close(); await wait(350); await delivered();
  assert.equal(h.document.querySelector('.je-undo-toast')?.isConnected === true && !h.document.querySelector('.je-undo-toast').closest('.je-more-info-modal'), false);
  assert.equal(h.sent('DELETE', '/user-settings/').length, 0);
});

// ------------------------------------------------------------------ R14-3: one immutable card incarnation

function discoverCard(h, parent = h.document.body) {
  const node = h.document.createElement('div'); node.className = 'je-discover-card';
  node.dataset.jeHideTitle = 'movie:tmdb:603'; node.dataset.jeHideName = 'Original';
  const poster = h.document.createElement('div'); node.append(poster); parent.append(node);
  return { node, poster };
}
function touchDown(h, target) {
  const event = new h.window.Event('pointerdown', { bubbles: true, cancelable: true });
  Object.defineProperties(event, { pointerType: { value: 'touch' }, clientX: { value: 10 }, clientY: { value: 10 } });
  h.trusted(target, event);
}
const sheetShown = h => !!h.document.querySelector('.je-actions-sheet');

test('R14-3: a card removed and put back before the reconciliation cannot complete its old long press', async t => {
  const h = setup(t, { asks: false }); const { node, poster } = discoverCard(h);
  h.a.initialize(); await delivered(); touchDown(h, poster);
  node.remove(); h.document.body.append(node);
  await wait(620); await delivered();
  assert.equal(sheetShown(h), false, 'removal ends the press even if the same node returns before reconciliation');
});

test('R14-3: a card removed and put back with the observer delivered in between cannot complete its old long press', async t => {
  const h = setup(t, { asks: false }); const { node, poster } = discoverCard(h);
  h.a.initialize(); await delivered(); touchDown(h, poster);
  node.remove(); await delivered(); h.document.body.append(node); await delivered();
  await wait(620); await delivered();
  assert.equal(sheetShown(h), false);
});

test('R14-3: a card whose container is removed and put back cannot complete its old long press', async t => {
  const h = setup(t, { asks: false });
  const row = h.document.createElement('section'); h.document.body.append(row);
  const { poster } = discoverCard(h, row);
  h.a.initialize(); await delivered(); touchDown(h, poster);
  row.remove(); h.document.body.append(row);
  await wait(620); await delivered();
  assert.equal(sheetShown(h), false);
});

test('R14-3: recycled away and back while the long press\'s admission is held, the opening shows nothing', async t => {
  const h = setup(t, { asks: false }); const { node, poster } = discoverCard(h);
  h.a.initialize(); await delivered();
  const gate = h.hold('GET', '/title-actions/movie/603'); touchDown(h, poster);
  await wait(620); await delivered();
  assert.equal(h.sent('GET', '/title-actions/movie/603').length, 1, 'the timer reached the real admission await');
  node.dataset.jeHideTitle = 'movie:tmdb:604'; node.dataset.jeHideTitle = 'movie:tmdb:603';
  await wait(45); await delivered();
  const sent = h.requests.length;
  gate.resolve(); await wait(30); await delivered();
  assert.equal(sheetShown(h), false, 'the recycle dominates the post-await opening');
  assert.deepEqual(h.requests.slice(sent, sent + 5).map(r => r[2]), [], 'the ended opening reads no entries after its admission');
});

test('R14-3: recycled away and back while the menu\'s entries are read, the opening shows nothing', async t => {
  const h = setup(t, { asks: false }); const { node, poster } = discoverCard(h);
  h.a.initialize(); await delivered();
  const gate = h.hold('GET', '/acquire/status'); touchDown(h, poster);
  await wait(620); await delivered();
  assert.equal(h.sent('GET', '/acquire/status').length >= 1, true, 'the opening reached its entry reads');
  node.dataset.jeHideTitle = 'movie:tmdb:604'; node.dataset.jeHideTitle = 'movie:tmdb:603';
  await delivered();
  gate.resolve(); await wait(30); await delivered();
  assert.equal(sheetShown(h), false);
});

test('R14-3: removed and put back while the entries are read (records still pending at the answer), nothing is shown', async t => {
  const h = setup(t, { asks: false }); const { node, poster } = discoverCard(h);
  h.a.initialize(); await delivered();
  const gate = h.hold('GET', '/acquire/status'); touchDown(h, poster);
  await wait(620); await delivered();
  node.remove(); h.document.body.append(node); gate.resolve();
  await wait(30); await delivered();
  assert.equal(sheetShown(h), false);
});

test('R14-3: a right-click menu whose card is recycled away and back during its admission shows nothing; unchanged it opens', async t => {
  const h = setup(t, { asks: false }); const { node, poster } = discoverCard(h);
  h.a.initialize(); await delivered();
  const gate = h.hold('GET', '/title-actions/movie/603');
  h.trusted(poster, new h.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true })); await delivered();
  node.dataset.jeHideTitle = 'movie:tmdb:604'; node.dataset.jeHideTitle = 'movie:tmdb:603'; await delivered();
  gate.resolve(); await wait(30); await delivered();
  assert.equal(sheetShown(h), false);
  h.trusted(poster, new h.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true })); await wait(30); await delivered();
  assert.equal(sheetShown(h), true, 'a fresh right-click on the unchanged card opens its menu');
});

test('R14-3 control: a fresh long press made in the same task as a recycle away and back opens the title the card shows now', async t => {
  const h = setup(t, { asks: false }); const { node, poster } = discoverCard(h);
  h.a.initialize(); await delivered();
  node.dataset.jeHideTitle = 'movie:tmdb:604'; node.dataset.jeHideTitle = 'movie:tmdb:603'; touchDown(h, poster);
  await wait(620); await delivered();
  assert.equal(sheetShown(h), true, 'the press was made on the card as it is now');
});

test('R14-3 control: a fresh right-click in the same task as a removal and reinsertion opens the card', async t => {
  const h = setup(t, { asks: false }); const { node, poster } = discoverCard(h);
  h.a.initialize(); await delivered();
  node.remove(); h.document.body.append(node);
  h.trusted(poster, new h.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true })); await wait(30); await delivered();
  assert.equal(sheetShown(h), true);
});

test('R14-3 control: an unchanged long press opens its title, also with reconciliation passes during its admission', async t => {
  const h = setup(t, { asks: false }); const { poster } = discoverCard(h);
  h.a.initialize(); await delivered();
  const gate = h.hold('GET', '/title-actions/movie/603'); touchDown(h, poster);
  h.a.scan();
  await wait(620); await delivered();
  h.a.scan(); h.a.scan(); await delivered();
  gate.resolve(); await wait(30); await delivered();
  assert.equal(sheetShown(h), true);
  assert.ok(h.document.querySelector('.je-actions-sheet').textContent.includes('Original'));
});

test('R14-3 control: incarnations stay plain records — 40 unchanged passes mint nothing, removal releases at the pass', async t => {
  const h = setup(t, { asks: false });
  h.a.initialize(); await delivered();
  const initial = h.a.registrySize();
  const nodes = Array.from({ length: 40 }, (_, i) => { const { node } = discoverCard(h); node.dataset.jeHideTitle = `movie:tmdb:${700 + i}`; return node; });
  h.a.scan(); await delivered();
  let mints = 0; const operation = h.JE.operation; h.JE.operation = (...a) => { mints++; return operation(...a); };
  for (let i = 0; i < 40; i++) h.a.scan();
  await delivered();
  assert.equal(mints, 0);
  nodes.forEach(n => n.remove()); h.a.scan(); await delivered();
  assert.equal(h.a.registrySize(), initial);
  assert.equal(mints, 0);
});

// ------------------------------------------------------------------ R14-4: one bounded dispatch lifetime

/** A library row in its compact (phone) layout with `controls` (native buttons) in it. */
async function libraryRow(h, controls) {
  for (const control of controls) h.row().append(control);
  Object.defineProperty(h.window, 'innerWidth', { value: 390, writable: true, configurable: true });
  h.row().getBoundingClientRect = () => ({ width: 100 });
  h.a.mountRow(h.row(), h.page, h.a.context({ Id: 'x', Type: 'Movie', Name: 'Library movie', ProviderIds: { Tmdb: '603' }, absent: false }));
  await delivered();
}

test('R14-4: forty settled presses on a compact native proxy leave the registry where it was', async t => {
  const h = setup(t, { asks: false });
  let invoked = 0;
  const favorite = h.document.createElement('button'); favorite.className = 'btnFavorite detailButton'; favorite.title = 'Favourite';
  favorite.addEventListener('click', () => { invoked++; });
  await libraryRow(h, [favorite]);
  const proxy = h.row().querySelector('.je-actions-favorite'); assert.ok(proxy);
  const before = h.a.registrySize();
  for (let i = 0; i < 40; i++) h.click(proxy);
  await delivered(); h.a.scan(); await delivered();
  assert.equal(invoked, 40, 'every press reached the original control exactly once');
  assert.equal(h.a.registrySize(), before, 'finished proxy dispatches are not outstanding submitted work');
});

test('R14-4: forty direct presses on a row\'s managed Report control leave the registry where it was', async t => {
  const h = setup(t, { asks: false });
  let invoked = 0;
  const report = h.document.createElement('button'); report.className = 'jellyseerr-report-issue-icon'; report.title = 'Report';
  report.addEventListener('click', () => { invoked++; });
  await libraryRow(h, [report]);
  const before = h.a.registrySize();
  for (let i = 0; i < 40; i++) h.click(report);
  await delivered(); h.a.scan(); await delivered();
  assert.equal(invoked, 40);
  assert.equal(h.a.registrySize(), before);
});

test('R14-4: a held write a proxied native handler started after its press still goes out for its owner, then nothing stays registered', async t => {
  const h = setup(t, { asks: false });
  const gate = h.hold('PUT', '/acquire/follows');
  let work = null;
  const favorite = h.document.createElement('button'); favorite.className = 'btnFavorite detailButton'; favorite.title = 'Favourite';
  favorite.addEventListener('click', event => {
    const submitted = h.JE.captureSubmitted(h.JE.ownerOf(event));
    work = h.JE.core.api.pluginResponse('/acquire/follows', { method: 'PUT', body: { key: 'movie:tmdb:603', on: true }, bound: submitted.bound() });
  });
  await libraryRow(h, [favorite]);
  const before = h.a.registrySize();
  h.click(h.row().querySelector('.je-actions-favorite')); await delivered();
  assert.ok(work, 'the native handler started its write');
  assert.equal(h.sent('PUT', '/acquire/follows').length, 1);
  gate.resolve(); await work; await delivered();
  assert.equal(h.a.registrySize(), before);
});

test('R14-4: a write a proxied native handler queues behind its own await is sent after the press settled, and not after a user switch', async t => {
  for (const switched of [false, true]) {
    const h = setup(t, { asks: false });
    let release; const held = new Promise(resolve => { release = resolve; });
    let work = null;
    const favorite = h.document.createElement('button'); favorite.className = 'btnFavorite detailButton'; favorite.title = 'Favourite';
    favorite.addEventListener('click', event => {
      const submitted = h.JE.captureSubmitted(h.JE.ownerOf(event));
      work = held.then(() => h.JE.core.api.pluginResponse('/acquire/follows', { method: 'PUT', body: { key: 'movie:tmdb:603', on: true }, bound: submitted.bound() })).catch(error => error);
    });
    await libraryRow(h, [favorite]);
    const before = h.a.registrySize();
    h.click(h.row().querySelector('.je-actions-favorite')); await delivered();
    assert.equal(h.a.registrySize(), before, 'the press settled: nothing stays registered while the handler waits');
    if (switched) { h.switchUser(); await delivered(); }
    release(); await work; await delivered();
    assert.equal(h.sent('PUT', '/acquire/follows').length, switched ? 0 : 1, switched ? 'another account signed in: the old press writes nothing' : 'the held work kept its owner');
  }
});

test('R14-4: the confirmation a released card press handed on closes when its card goes (the registry then empty); the bar going off after it writes nothing', async t => {
  const h = setup(t, { asks: false }); hiddenContent(h);
  const { node, poster } = discoverCard(h);
  h.a.initialize(); await delivered();
  h.trusted(poster, new h.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true })); await wait(30); await delivered();
  const entry = h.document.querySelector('.je-actions-entry[data-action="hide"]'); assert.ok(entry, 'the card menu offers Hide');
  h.click(entry); await delivered();
  const confirm = h.document.querySelector('.je-hide-confirm-hide'); assert.ok(confirm, 'the confirmation is open');
  // The grid drops the card while the confirmation is open; the next pass releases the cards' shared lifetime.
  node.remove(); h.a.scan(); await delivered();
  assert.equal(h.a.registrySize(), 0, 'the menu finished, the press was released and no card is drawn: nothing is registered');
  assert.equal(confirm.isConnected && !confirm.closest('[inert]'), false, 'the operation ended with its card: its confirmation closed');
  h.a.end(); await delivered();
  h.click(confirm); await delivered();
  assert.equal(h.sent('PUT', '/user-settings/').length, 0);
});

test('R14-4: a provider run holds its operation until it settles, then leaves the registry', async t => {
  const h = setup(t, { asks: false });
  let resolveRun; let ran = 0; let current = null;
  const unregister = h.a.register('test-provider', () => ({ id: 'test-run', group: 'other', icon: 'x', label: 'Test run',
    run: (_opener, submitted) => { ran++; current = submitted; return new Promise(resolve => { resolveRun = resolve; }); } }));
  t.after(unregister);
  mount(h); await delivered();
  const before = h.a.registrySize();
  h.click(h.row().querySelector('.je-actions-more')); await delivered();
  h.click(h.document.querySelector('.je-actions-entry[data-action="test-run"]')); await delivered();
  assert.equal(ran, 1);
  assert.equal(current.current(), true, 'the run\'s operation is live while it runs');
  resolveRun(true); await delivered();
  h.a.close?.(false); await delivered();
  assert.equal(h.a.registrySize(), before);
});
