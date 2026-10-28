import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, mount, remount, press, settle, delivered, moreInfo, popup, sheet, seerrModal } from '../helpers/title-actions-scopes.mjs';

// D46 slice 2 review round 5 (shape): an action-bar operation owns everything it opens. Every surface created while
// it is current (sheets, drawers, modals, body-portaled popups, nested owner modals) is registered in the
// operation's scope and closed when it ends, so nothing outlives it (D46S2-R5-3, -R5-4); the document's own
// lifecycle (pagehide, freeze, pageshow) moves it like a route change (D46S2-R5-1); in-flight work is joined only by
// live work of the same owner (D46S2-R5-2). Real core transport and real owners; only the server is scripted.

/** Waits out a closing surface's exit animation (Seerr modals keep their node for 300 ms). */
const gone = () => new Promise(resolve => setTimeout(resolve, 350));

const INTERRUPTS = [
  ['the row re-renders', async h => { remount(h); h.a.scan(); await settle(); }],
  ['another user signs in', async h => { h.switchUser(); await settle(); }],
  ['the person leaves the page', async h => { await h.leave(); }],
];

/** Opens Seerr's More Info window from the row (JE requests off: the row's Request opens the window). */
async function openWindow(h) {
  h.a.initialize(); mount(h); await settle();
  await press(h, 'request'); await delivered();
  assert.ok(moreInfo(h), 'the More Info window opened for the operation');
}

// ---------------------------------------------------------------- D46S2-R5-3: the More Info 4K popup

for (const [name, interrupt] of INTERRUPTS) {
  test(`4K popup (body-portaled): ${name} while it is open → the popup closes and its option sends nothing`, async t => {
    const h = setup(t, { asks: false });
    await openWindow(h);
    h.click(moreInfo(h).querySelector('.jellyseerr-split-arrow')); await settle();
    assert.ok(popup(h), 'the 4K popup is open');
    await interrupt(h); await delivered();
    assert.equal(popup(h), null, 'the popup did not outlive its operation');
    assert.equal(moreInfo(h), null, 'nor did the window');
    h.document.querySelector('.je-4k-popup-item')?.click(); await delivered();
    assert.equal(h.sent('POST', '/jellyseerr/request').length, 0);
  });
}

test('4K popup: option pressed with the transport pool full, the person leaves, released → 0 sends', async t => {
  const h = setup(t, { asks: false });
  await openWindow(h);
  h.click(moreInfo(h).querySelector('.jellyseerr-split-arrow')); await settle();
  const release = h.holdPool();
  h.click(popup(h).querySelector('.je-4k-popup-item')); await settle();
  await h.leave();
  await release(); await delivered();
  assert.equal(h.sent('POST', '/jellyseerr/request').length, 0);
});

test('control: the 4K popup on the current operation requests once', async t => {
  const h = setup(t, { asks: false });
  await openWindow(h);
  h.click(moreInfo(h).querySelector('.jellyseerr-split-arrow')); await settle();
  h.click(popup(h).querySelector('.je-4k-popup-item')); await delivered();
  assert.equal(h.sent('POST', '/jellyseerr/request').length, 1);
});

test('the More Info window\'s own More sheet (JE requests off) offers no second Request: the window\'s Request is its primary', async t => {
  const h = setup(t, { asks: false });
  h.a.initialize(); await settle();
  await h.JE.jellyseerrMoreInfo.open(603, 'movie', undefined, h.NATIVE); await delivered();
  const more = moreInfo(h).querySelector('.je-actions-more, .je-actions-wide-more');
  assert.ok(more, 'the window has the action bar');
  h.click(more); await settle();
  const entries = [...h.document.querySelectorAll('.je-actions-entry')].map(n => n.dataset.action);
  assert.ok(entries.length > 0, 'the sheet is open');
  assert.equal(entries.includes('request'), false, 'no second window over the one it is pressed in');
  assert.ok(moreInfo(h).querySelector('.je-actions-row .je-actions-primary, .jellyseerr-request-button'), 'the window\'s own Request stays');
});

test('control: the native More Info window (no operation) keeps its popup and request on its route; after navigating both are gone', async t => {
  // D46S2-R10 / audit S1: a viewer's own native owner carries the route it was minted on; its page effects (a window,
  // sheet, form, drawer or popup) end with that route, while a write the viewer already submitted still goes out.
  const h = setup(t, { asks: false });
  await h.JE.jellyseerrMoreInfo.open(603, 'movie', undefined, h.NATIVE); await delivered();
  h.click(moreInfo(h).querySelector('.jellyseerr-split-arrow')); await settle();
  assert.ok(popup(h), 'natively the popup is the window\'s own');
  h.click(popup(h).querySelector('.je-4k-popup-item')); await delivered();
  assert.equal(h.sent('POST', '/jellyseerr/request').length, 1);
  { const arrow = moreInfo(h).querySelector('.jellyseerr-split-arrow'); if (arrow) h.click(arrow); } await settle();
  await h.leave();
  assert.equal(popup(h), null);
});

// ---------------------------------------------------------------- D46S2-R5-4: the Collection modal (a nested owner)

for (const [name, interrupt] of INTERRUPTS) {
  test(`Collection: ${name} while the collection details are read → no form, no POST`, async t => {
    const h = setup(t, { asks: false });
    await openWindow(h);
    const details = h.hold('GET', '/jellyseerr/collection/2344');
    h.click(moreInfo(h).querySelector('.je-collection-card-button')); await settle();
    await interrupt(h);
    details.resolve(); await delivered();
    const form = seerrModal(h);
    if (form) { h.click(form.querySelector('.jellyseerr-modal-button-primary')); await delivered(); }
    assert.equal(h.sent('POST', '/jellyseerr/request').length, 0);
    await gone();
    assert.equal(seerrModal(h), null, 'no collection form for an ended operation');
  });

  test(`Collection: ${name} while its form is open → the form closes; Save sends nothing`, async t => {
    const h = setup(t, { asks: false });
    await openWindow(h);
    h.click(moreInfo(h).querySelector('.je-collection-card-button')); await delivered();
    const form = seerrModal(h);
    assert.ok(form, 'the collection form is open');
    await interrupt(h); await delivered(); await gone();
    assert.equal(form.isConnected, false, 'the form did not outlive its operation');
    h.click(form.querySelector('.jellyseerr-modal-button-primary')); await delivered();
    assert.equal(h.sent('POST', '/jellyseerr/request').length, 0);
  });
}

test('Collection: Save with the transport pool full, the row re-renders, released → 0 sends', async t => {
  const h = setup(t, { asks: false });
  await openWindow(h);
  h.click(moreInfo(h).querySelector('.je-collection-card-button')); await delivered();
  const release = h.holdPool();
  h.click(seerrModal(h).querySelector('.jellyseerr-modal-button-primary')); await settle();
  remount(h);
  await release(); await delivered();
  assert.equal(h.sent('POST', '/jellyseerr/request').length, 0);
});

test('control: the Collection form on the current operation requests once', async t => {
  const h = setup(t, { asks: false });
  await openWindow(h);
  h.click(moreInfo(h).querySelector('.je-collection-card-button')); await delivered();
  h.click(seerrModal(h).querySelector('.jellyseerr-modal-button-primary')); await delivered();
  assert.equal(h.sent('POST', '/jellyseerr/request').length, 1);
});

// ---------------------------------------------------------------- a nested owner opened synchronously from inside the window

/** The window's Request with advanced options: the movie request modal opens from inside the window, with its selects filled. */
async function openAdvanced(h) {
  await openWindow(h);
  h.click(moreInfo(h).querySelector('.jellyseerr-split-main')); await delivered();
  const form = seerrModal(h);
  assert.ok(form, 'the advanced movie request modal is open');
  for (const [id, value] of [['movie-server', '1'], ['movie-quality', '4'], ['movie-folder', '/movies']]) {
    const select = form.querySelector('#' + id);
    if (![...select.options].some(o => o.value === value)) select.append(new h.window.Option(value, value));
    select.value = value;
  }
  return form;
}

test('advanced movie modal (opened from inside the window, no explicit origin): the row re-renders → it closes; Save sends nothing', async t => {
  const h = setup(t, { asks: false, advanced: true });
  const form = await openAdvanced(h);
  remount(h); h.a.scan(); await delivered(); await gone();
  assert.equal(form.isConnected, false, 'the modal is in the window\'s operation\'s scope');
  h.click(form.querySelector('.jellyseerr-modal-button-primary')); await delivered();
  assert.equal(h.sent('POST', '/jellyseerr/request').length, 0);
});

test('advanced movie modal: Save with the transport pool full, the row re-renders, released → 0 sends', async t => {
  const h = setup(t, { asks: false, advanced: true });
  const form = await openAdvanced(h);
  const release = h.holdPool();
  h.click(form.querySelector('.jellyseerr-modal-button-primary')); await settle();
  remount(h);
  await release(); await delivered();
  assert.equal(h.sent('POST', '/jellyseerr/request').length, 0);
});

test('control: the advanced movie modal on the current operation requests once', async t => {
  const h = setup(t, { asks: false, advanced: true });
  const form = await openAdvanced(h);
  h.click(form.querySelector('.jellyseerr-modal-button-primary')); await delivered();
  assert.equal(h.sent('POST', '/jellyseerr/request').length, 1);
});

// ---------------------------------------------------------------- shape 1: every surface opened for an operation closes with it

const SURFACES = {
  'request sheet': { asks: true, open: async h => { await press(h, 'request'); await delivered(); }, shown: h => sheet(h) },
  'Manage drawer': { asks: true, open: async h => { await press(h, 'manage'); await delivered(); }, shown: h => h.document.querySelector('.je-manage-overlay') },
  'Report form (Seerr modal shell)': { asks: true, open: async h => { await press(h, 'report'); await delivered(); }, shown: h => seerrModal(h)?.classList.contains('show') || seerrModal(h)?.isConnected ? seerrModal(h) : null },
  'More Info window': { asks: false, open: async h => { await press(h, 'request'); await delivered(); }, shown: h => moreInfo(h) },
};
for (const [surface, { asks, open, shown }] of Object.entries(SURFACES)) {
  test(`scope: the ${surface} opened for an operation closes when the operation ends (the row re-renders), with no interaction`, async t => {
    const h = setup(t, { asks });
    h.a.initialize(); mount(h); await settle();
    await open(h);
    const node = shown(h);
    assert.ok(node, `the ${surface} is open`);
    remount(h); h.a.scan(); await delivered(); await gone();
    assert.equal(node.isConnected, false, `the ${surface} did not outlive its operation`);
  });
}

// ---------------------------------------------------------------- D46S2-R5-1: the document lifecycle

test('bfcache: the request sheet is open, pagehide (persisted) → the sheet closes; after pageshow its Request asks nothing', async t => {
  const h = setup(t);
  h.a.initialize(); mount(h); await settle();
  await press(h, 'request'); await delivered();
  const open = sheet(h);
  assert.ok(open, 'the request sheet is open');
  h.pagehide(true); await settle();
  assert.equal(open.isConnected, false, 'pagehide ends the operation and closes its sheet');
  h.pageshow(true); await settle();
  open.querySelector('.je-sheet-primary')?.click(); await delivered();
  assert.equal(h.sent('POST', '/acquire/requests').length, 0);
});

test('bfcache: the Report form is open, pagehide (persisted) → it closes; its Submit after pageshow posts nothing', async t => {
  const h = setup(t);
  h.a.initialize(); mount(h); await settle();
  await press(h, 'report'); await delivered();
  const form = seerrModal(h);
  assert.ok(form, 'the Report form is open');
  h.pagehide(true); await settle(); h.pageshow(true); await settle();
  form.querySelector('input[name="issue-type"]').checked = true;
  h.click(form.querySelector('.jellyseerr-modal-button-primary')); await delivered(); await gone();
  assert.equal(form.isConnected, false, 'the form closed with its operation');
  assert.equal(h.sent('POST', '/jellyseerr/issue').length, 0);
});

for (const [name, depart, restore] of [
  ['pagehide (persisted) and pageshow', h => h.pagehide(true), h => h.pageshow(true)],
  ['pagehide (not persisted)', h => h.pagehide(false), () => {}],
  ['freeze and resume', h => h.freeze(), h => h.resume()],
]) {
  test(`document lifecycle: a Report queued behind a full pool, ${name}, released → 0 POST /jellyseerr/issue`, async t => {
    const h = setup(t);
    h.a.initialize(); mount(h); await settle();
    await press(h, 'report'); await delivered();
    const form = seerrModal(h);
    form.querySelector('input[name="issue-type"]').checked = true;
    const release = h.holdPool();
    h.click(form.querySelector('.jellyseerr-modal-button-primary')); await settle();
    depart(h); await settle(); restore(h); await settle();
    await release(); await delivered();
    assert.equal(h.sent('POST', '/jellyseerr/issue').length, 0);
  });

  test(`document lifecycle: a one-tap ask queued behind a full pool, ${name}, released → 0 asks`, async t => {
    const h = setup(t);
    h.a.initialize(); mount(h); await settle();
    const op = h.a.generation();
    await h.JE.arrAsk.me(); await h.JE.arrAsk.quota('movie');
    const release = h.holdPool();
    const done = h.JE.arrAskSheet.openOrAsk({ key: 'movie:tmdb:603', kind: 'movie', name: 'The Matrix' }, { operation: op });
    await settle();
    depart(h); await settle(); restore(h); await settle();
    await release(); await done; await delivered();
    assert.equal(op.current(), false, 'the operation ended with the document');
    assert.equal(h.sent('POST', '/acquire/requests').length, 0);
  });
}

test('control: jellyfin-web\'s own view pagehide/pageshow/freeze events (bubbling from a view) are not the document leaving', async t => {
  const h = setup(t);
  h.a.initialize(); mount(h); await settle();
  await press(h, 'request'); await delivered();
  const open = sheet(h);
  assert.ok(open, 'the request sheet is open');
  // Host evidence (12.2): every view change dispatches CustomEvent pagehide/pageshow from the view element.
  for (const type of ['pagehide', 'pageshow', 'freeze', 'resume']) h.page.dispatchEvent(new h.window.CustomEvent(type, { bubbles: true }));
  await settle();
  assert.equal(open.isConnected, true, 'the sheet stays open');
  h.click(open.querySelector('.je-sheet-primary')); await delivered();
  assert.equal(h.sent('POST', '/acquire/requests').length, 1);
});

test('bfcache control: after pageshow a fresh press on the restored page works (one ask)', async t => {
  const h = setup(t);
  h.a.initialize(); mount(h); await settle();
  h.pagehide(true); await settle(); h.pageshow(true); await delivered();
  // The restored page reconciles fresh controls: Jellyfin shows no new view, the action bar remounts its rows.
  const more = h.row().querySelector('.je-actions-more');
  assert.ok(more, 'the restored row has its controls');
  await press(h, 'request'); await delivered();
  assert.ok(sheet(h), 'a fresh press opens the sheet');
  h.click(sheet(h).querySelector('.je-sheet-primary')); await delivered();
  assert.equal(h.sent('POST', '/acquire/requests').length, 1);
});

test('bfcache: the Manage drawer and the title-action sheet close on pagehide', async t => {
  const h = setup(t);
  h.a.initialize(); mount(h); await settle();
  // The sheet open, and the drawer opened over it (a covered row takes no press: D46S2-R12-9).
  h.click(h.row().querySelector('.je-actions-more')); await settle();
  const offer = h.document.querySelector('.je-actions-backdrop');
  assert.ok(offer);
  await h.JE.arrManage.open({ key: 'movie:tmdb:603' }, { operation: h.NATIVE }); await delivered();
  const drawer = h.document.querySelector('.je-manage-overlay');
  assert.ok(drawer);
  h.pagehide(true); await settle();
  assert.equal(drawer.isConnected, false);
  assert.equal(offer.isConnected, false);
});

// ---------------------------------------------------------------- D46S2-R5-2: in-flight work is never joined across owners

const TITLE = { key: 'movie:tmdb:603', kind: 'movie', name: 'The Matrix' };

test('one-tap ask: a fresh press after away and back is not joined to the ended press → it asks once', async t => {
  const h = setup(t);
  h.a.initialize(); mount(h); await settle();
  await h.JE.arrAsk.me();
  const quota = h.hold('GET', '/acquire/requests/quota');
  const first = h.a.generation();
  const ended = h.JE.arrAskSheet.openOrAsk(TITLE, { operation: first }); await settle();
  await h.leave(); await h.back(); mount(h); await settle();
  const fresh = h.a.generation();
  const asked = h.JE.arrAskSheet.openOrAsk(TITLE, { operation: fresh });
  quota.resolve(); await delivered();
  assert.equal(await ended, null, 'the ended press sends nothing');
  const result = await asked;
  assert.equal(result?.ok, true, 'the fresh press asked');
  assert.equal(h.sent('POST', '/acquire/requests').length, 1);
});

test('one-tap ask: an old press settling never removes the replacement\'s entry (cleanup by identity) → one ask', async t => {
  const h = setup(t);
  await h.JE.arrAsk.me();
  const aQuota = h.hold('GET', '/acquire/requests/quota');
  const old = h.JE.arrAskSheet.openOrAsk(TITLE, { operation: h.NATIVE }); await settle();
  h.switchUser(); await settle();
  const bMe = h.hold('GET', '/acquire/requests/me');
  const first = h.JE.arrAskSheet.openOrAsk(TITLE, { operation: h.NATIVE }); await settle();
  aQuota.resolve(); await old; await settle();
  // B taps again while the first tap is still out: it joins it (one request).
  const second = h.JE.arrAskSheet.openOrAsk(TITLE, { operation: h.NATIVE });
  bMe.resolve(); await delivered(); await first; await second;
  assert.deepEqual(h.sent('POST', '/acquire/requests').map(r => r[0]), ['user-b']);
});

test('control: two presses of the same live operation join (one ask)', async t => {
  const h = setup(t);
  h.a.initialize(); mount(h); await settle();
  await h.JE.arrAsk.me();
  const quota = h.hold('GET', '/acquire/requests/quota');
  const op = h.a.generation();
  const one = h.JE.arrAskSheet.openOrAsk(TITLE, { operation: op });
  const two = h.JE.arrAskSheet.openOrAsk(TITLE, { operation: op });
  quota.resolve(); await delivered(); await one; await two;
  assert.equal(h.sent('POST', '/acquire/requests').length, 1);
});

test('control: a native double tap (no operation) is one ask, as before', async t => {
  const h = setup(t);
  await h.JE.arrAsk.me();
  const quota = h.hold('GET', '/acquire/requests/quota');
  const one = h.JE.arrAskSheet.openOrAsk(TITLE, { operation: h.NATIVE });
  const two = h.JE.arrAskSheet.openOrAsk(TITLE, { operation: h.NATIVE });
  quota.resolve(); await delivered(); await one; await two;
  assert.equal(h.sent('POST', '/acquire/requests').length, 1);
});

test('one-tap ask: a native tap never adopts an operation\'s in-flight work, nor the reverse', async t => {
  const h = setup(t);
  h.a.initialize(); mount(h); await settle();
  await h.JE.arrAsk.me();
  const quota = h.hold('GET', '/acquire/requests/quota');
  const op = h.a.generation();
  const owned = h.JE.arrAskSheet.openOrAsk(TITLE, { operation: op }); await settle();
  await h.leave(); await h.back();
  const native = h.JE.arrAskSheet.openOrAsk(TITLE, { operation: h.NATIVE });
  assert.notEqual(native, owned, 'the native tap starts its own work');
  quota.resolve(); await delivered();
  assert.equal(await owned, null, 'the ended operation sends nothing');
  assert.equal((await native)?.ok, true, 'the native tap asked');
  assert.equal(h.sent('POST', '/acquire/requests').length, 1);
});
