import { test } from 'node:test';
import assert from 'node:assert/strict';
import { settle, setup, mount, press, expireCapabilities, submitReport, sheet, drawer, moreInfo, operationOf, HOME } from '../helpers/title-actions-owners.mjs';

// D46 slice 2 review round 4. An ENDED operation does nothing, ever again (D53):
// - Ended is forever (D46S2-R4-2): validity is a lifecycle, not a comparison of state. A route change (same-route
//   modal history excepted), the end of the owning mount, a user switch or the feature going off ends it, and a
//   page that comes back (the view cache keeps it, and its cards) does not revive it.
// - A rejected interaction is fully cancelled (D46S2-R4-3): UI opened for an operation that has ended only closes,
//   and the event's own default (a link, a form submission, a native control) is cancelled with it.
// Every owner here is the REAL module; only the server is scripted.

/** Lets the browser deliver the navigation's own events (jsdom queues popstate and hashchange on its timers). */
const delivered = async () => { await new Promise(resolve => setTimeout(resolve, 0)); await settle(); };

/**
 * Leaves the page and comes back to it; the page (and any card) stays connected, as Jellyfin's view cache keeps it.
 * The host's frame callbacks (the action bar's reconciliation pass) are held while away and run after coming back,
 * as for a retained card: nothing re-scans the page meanwhile, so no cell can pass by a timing accident.
 */
async function awayAndBack(h) {
  const frame = h.window.requestAnimationFrame; const held = [];
  // A pass already queued runs first, on the page, before leaving.
  await new Promise(resolve => frame.call(h.window, resolve)); await settle();
  h.window.requestAnimationFrame = fn => held.push(fn);
  try {
    h.navigate(); await delivered();
    h.navigate(HOME); await delivered();
  } finally { h.window.requestAnimationFrame = frame; held.forEach(fn => frame.call(h.window, fn)); }
  await delivered();
}

/** Opens a retained card's More sheet and presses `id`. */
async function pressCard(h, id) {
  const more = h.document.querySelector('.card .je-card-more');
  assert.ok(more, 'the card has its More');
  more.click(); await settle();
  const entry = h.document.querySelector(`.je-actions-entry[data-action="${id}"]`);
  assert.ok(entry, 'the card sheet offers ' + id);
  entry.click(); await settle();
}

const HOSTS = [
  ['row', async h => { h.a.initialize(); mount(h); await settle(); }, press],
  ['retained card', async h => { h.a.initialize(); await settle(); }, pressCard],
];

/** An overview whose instance holds the title: Search now (a write) and the arr's own page (a link). */
const HELD = { key: 'movie:tmdb:603', kind: 'movie', title: 'The Matrix', tmdbId: 603, requests: [],
  instances: [{ id: 'r1', name: 'Radarr', role: 'standard', url: 'http://radarr.test', readable: true, inArr: true, monitored: true }] };

/** Dispatches a cancelable event and reports whether its default was cancelled and whether it went past the UI. */
function fire(h, node, type, init = {}) {
  let escaped = false;
  const outside = () => { escaped = true; };
  h.document.addEventListener(type, outside);
  const Kind = type === 'submit' ? h.window.Event : h.window.MouseEvent;
  const event = new Kind(type, { bubbles: true, cancelable: true, ...init });
  node.dispatchEvent(event);
  h.document.removeEventListener(type, outside);
  return { prevented: event.defaultPrevented, escaped };
}

// ---------------------------------------------------------------- Ended is forever (the lifecycle itself)

test('ended is forever: an operation does not come back when its route does', async t => {
  const h = setup(t);
  const op = h.a.generation();
  assert.equal(op.current(), true);
  await awayAndBack(h);
  assert.equal(op.current(), false);
});

test('ended is forever: away and back with no check in between still ends it', async t => {
  const h = setup(t);
  const op = h.a.generation();
  h.navigate(); await delivered();
  h.navigate(HOME); await delivered();
  // The first check happens only now, on the original route.
  assert.equal(op.current(), false);
});

test('ended is forever: a retained card recycled for another title and back does not revive its operation', async t => {
  const h = setup(t, { card: true }); h.a.initialize(); await settle();
  const card = h.document.querySelector('.card');
  let owner = null;
  const show = h.a.show;
  h.a.show = (c, entries, opener, action) => { owner = action; return show(c, entries, opener, action); };
  card.querySelector('.je-card-more').click(); await settle();
  assert.ok(owner?.current(), 'the card sheet opened for a current card');
  // Each recycle is reconciled by the observer's next pass (one animation frame), before the card comes back.
  card.dataset.jeHideTitle = 'movie:tmdb:604'; h.a.scan(); await settle();
  card.dataset.jeHideTitle = 'movie:tmdb:603'; h.a.scan(); await settle();
  assert.equal(owner.current(), false);
});

test('ended is forever: a retained card whose feature went off and on again does not revive its operation', async t => {
  const h = setup(t, { card: true }); h.a.initialize(); await settle();
  let owner = null;
  const show = h.a.show;
  h.a.show = (c, entries, opener, action) => { owner = action; return show(c, entries, opener, action); };
  h.document.querySelector('.card .je-card-more').click(); await settle();
  assert.ok(owner?.current());
  h.featureOff(); await settle();
  h.JE.pluginConfig.NativeAbsentDetailsEnabled = true; h.a.scan(); await settle();
  assert.ok(h.document.querySelector('.card .je-card-more'), 'the card has its More again');
  assert.equal(owner.current(), false);
});

test('ended is forever: a row operation ends with its mount and stays ended when the row is mounted again', async t => {
  const h = setup(t); h.a.initialize(); mount(h); await settle();
  const o = operationOf(h);
  const row = h.a.generation(() => h.row().querySelector('.je-actions-more') !== null);
  h.featureOff(); await settle();
  assert.equal(row.current(), false);
  h.JE.pluginConfig.NativeAbsentDetailsEnabled = true; mount(h); await settle();
  assert.ok(h.row().querySelector('.je-actions-more'), 'mounted again');
  assert.equal(row.current(), false);
  assert.equal(o.op.current(), false, 'feature-off ends every operation');
});

test('ended is forever: a mount seen gone stays ended when it comes back', async t => {
  const h = setup(t);
  let mounted = true;
  const op = h.a.generation(() => mounted);
  mounted = false;
  assert.equal(op.current(), false);
  mounted = true;
  assert.equal(op.current(), false);
});

test('ended is forever: another user seen before the session notices stays ended when the first user is back', async t => {
  const h = setup(t);
  const op = h.a.generation();
  h.signedInAs('user-b');
  assert.equal(op.current(), false);
  h.signedInAs('user-a');
  assert.equal(op.current(), false);
});

test('controls: same-route modal history (a modal\'s own history entry and Back) keeps the operation', async t => {
  const h = setup(t);
  const op = h.a.generation();
  h.window.history.pushState(null, '', h.window.location.href); await settle();
  h.window.history.back(); await settle();
  assert.equal(op.current(), true);
});

test('controls: a query parameter other than the shown item or shared title keeps the operation', async t => {
  const h = setup(t);
  const op = h.a.generation();
  h.navigate(HOME + '&serverId=s1'); await settle();
  assert.equal(op.current(), true);
});

test('controls: an operation started after coming back is current', async t => {
  const h = setup(t);
  await awayAndBack(h);
  assert.equal(h.a.generation().current(), true);
});

// ---------------------------------------------------------------- Away and back, each owner (row and retained card)

for (const [host, prepare, pressIn] of HOSTS) {
  test(`${host}: Report form open, away and back, then submit → no reportContext read, no POST`, async t => {
    const h = setup(t, { card: true }); await prepare(h);
    await pressIn(h, 'report');
    assert.ok(h.document.querySelector('.jellyseerr-season-modal'), 'the Report form is open');
    await awayAndBack(h);
    const reads = h.sent('GET', '/jellyseerr/movie/603').length;
    if (h.document.querySelector('.jellyseerr-season-modal')) await submitReport(h);
    assert.equal(h.sent('GET', '/jellyseerr/movie/603').length, reads);
    assert.equal(h.sent('POST', '/jellyseerr/issue').length, 0);
  });

  test(`${host}: reportContext held, away and back, released → no POST`, async t => {
    const h = setup(t, { card: true }); await prepare(h);
    await pressIn(h, 'report');
    const context = h.hold('GET', '/jellyseerr/movie/603');
    await submitReport(h);
    await awayAndBack(h);
    context.resolve(); await settle();
    assert.equal(h.sent('POST', '/jellyseerr/issue').length, 0);
  });

  test(`${host}: request sheet open, away and back, then its Request → no ask`, async t => {
    const h = setup(t, { card: true }); await prepare(h);
    await pressIn(h, 'request');
    assert.ok(sheet(h), 'the request sheet is open');
    await awayAndBack(h);
    sheet(h)?.querySelector('.je-sheet-primary')?.click(); await settle();
    assert.equal(h.sent('POST', '/acquire/requests').length, 0);
  });

  test(`${host}: request sheet's quota held, away and back, released → no sheet`, async t => {
    const h = setup(t, { card: true }); await prepare(h);
    const quota = h.hold('GET', '/acquire/requests/quota');
    await pressIn(h, 'request');
    await awayAndBack(h);
    quota.resolve(); await settle();
    assert.equal(sheet(h), null);
  });

  test(`${host}: Manage overview held, away and back, released → the drawer closes, nothing rendered`, async t => {
    const h = setup(t, { card: true, overview: HELD }); await prepare(h);
    const read = h.hold('GET', '/arr/admin/manage?');
    await pressIn(h, 'manage');
    await awayAndBack(h);
    read.resolve(); await settle();
    assert.equal(drawer(h), null);
  });

  test(`${host}: Manage drawer open, away and back, then Search now → no write, the drawer closes`, async t => {
    const h = setup(t, { card: true, overview: HELD }); await prepare(h);
    await pressIn(h, 'manage');
    const search = drawer(h)?.querySelector('[data-je-focus="search-r1"]');
    assert.ok(search, 'the drawer shows Search now');
    await awayAndBack(h);
    search.click(); await settle();
    assert.equal(h.requests.filter(r => r[1] === 'POST' && r[2].startsWith('/arr/')).length, 0);
    assert.equal(drawer(h), null);
  });
}

test('row: me() held, away and back, released → no request sheet', async t => {
  const h = setup(t); h.a.initialize(); mount(h); await settle();
  const expire = expireCapabilities(h);
  h.row().querySelector('.je-actions-more').click(); await settle();
  expire();
  const me = h.hold('GET', '/acquire/requests/me');
  h.document.querySelector('.je-actions-entry[data-action="request"]').click(); await settle();
  await awayAndBack(h);
  me.resolve(); await settle();
  assert.equal(sheet(h), null);
});

test('row: the one-tap ask (the row\'s primary), quota held, away and back, released → no ask', async t => {
  const h = setup(t); h.a.initialize();
  h.JE.arrAskSheet.mount(h.row(), { key: 'movie:tmdb:603', kind: 'movie', name: 'The Matrix' }); await settle();
  mount(h); await settle();
  const quota = h.hold('GET', '/acquire/requests/quota');
  h.row().querySelector('.je-actions-row .je-actions-primary').click(); await settle();
  await awayAndBack(h);
  quota.resolve(); await settle();
  assert.equal(h.sent('POST', '/acquire/requests').length, 0);
});

test('row: Seerr More Info window, details held, away and back, released → no window', async t => {
  const h = setup(t, { asks: false, seerrMoreInfo: true }); h.a.initialize(); mount(h); await settle();
  const details = h.hold('GET', '/jellyseerr/movie/603');
  await press(h, 'request');
  await awayAndBack(h);
  details.resolve(); await settle();
  assert.equal(moreInfo(h), null);
});

test('Seerr requestMedia for an operation: override rules held, away and back → no POST', async t => {
  const h = setup(t);
  const o = operationOf(h);
  const rules = h.hold('GET', '/jellyseerr/overrideRule');
  const sent = h.JE.runSubmitted(o.op, () => h.JE.jellyseerrAPI.requestMedia(603, 'movie', {}, false, { id: 603, originalLanguage: 'en' }, null, { bound: h.JE.captureSubmitted().bound() }));
  await settle();
  await awayAndBack(h);
  rules.resolve(); await assert.rejects(sent, e => e?.name === 'AbortError'); await settle();
  assert.equal(h.sent('POST', '/jellyseerr/request').length, 0);
});

test('the shared Seerr modal opened for an operation: away and back, then its primary → onSave never runs', async t => {
  const h = setup(t);
  const o = operationOf(h); let saved = 0;
  const modal = h.JE.runSubmitted(o.op, () => h.JE.jellyseerrModal.create({ title: 'x', subtitle: 'y', bodyHtml: '', onSave: () => { saved++; } }));
  modal.show(); await settle();
  await awayAndBack(h);
  modal.modalElement.querySelector('.jellyseerr-modal-button-primary').click(); await settle();
  assert.equal(saved, 0);
});

test('controls: Report through the row, with a modal history entry and Back on the same route, posts once', async t => {
  const h = setup(t); h.a.initialize(); mount(h); await settle();
  await press(h, 'report');
  h.window.history.pushState(null, '', h.window.location.href); await settle();
  h.window.history.back(); await settle();
  // The Report form closes on its own Back; open it again through the same row.
  if (!h.document.querySelector('.jellyseerr-season-modal.show, .jellyseerr-season-modal')) await press(h, 'report');
  await submitReport(h);
  assert.equal(h.sent('POST', '/jellyseerr/issue').length, 1);
});

test('controls: a card\'s Report on the same route posts once; after away and back a NEW press posts once more', async t => {
  const h = setup(t, { card: true }); h.a.initialize(); await settle();
  await pressCard(h, 'report');
  await submitReport(h);
  assert.equal(h.sent('POST', '/jellyseerr/issue').length, 1);
  await awayAndBack(h);
  await pressCard(h, 'report');
  await submitReport(h);
  assert.equal(h.sent('POST', '/jellyseerr/issue').length, 2);
});

test('controls: the native Report form (no operation) still posts after away and back', async t => {
  const h = setup(t);
  h.JE.jellyseerrIssueReporter.showReportModal('603', 'The Matrix', 'movie'); await settle();
  await awayAndBack(h);
  await submitReport(h);
  assert.equal(h.sent('POST', '/jellyseerr/issue').length, 1, 'exactly as before');
});

// ---------------------------------------------------------------- A rejected interaction is fully cancelled

test('D46S2-R4-3: a stale Manage drawer\'s arr link → default cancelled (no new tab), not propagated, the drawer closes', async t => {
  const h = setup(t, { overview: HELD }); h.a.initialize(); mount(h); await settle();
  await press(h, 'manage');
  const link = drawer(h)?.querySelector('a.je-manage-btn[target="_blank"]');
  assert.ok(link, 'the drawer links to the arr');
  h.navigate(); await settle();
  assert.deepEqual(fire(h, link, 'click'), { prevented: true, escaped: false });
  assert.equal(drawer(h), null);
});

for (const [name, init] of [['middle-click (auxclick)', { button: 1 }], ['keyboard Enter (click)', { detail: 0 }]]) {
  test(`a stale Manage drawer's arr link, ${name} → default cancelled`, async t => {
    const h = setup(t, { overview: HELD }); h.a.initialize(); mount(h); await settle();
    await press(h, 'manage');
    const link = drawer(h).querySelector('a.je-manage-btn[target="_blank"]');
    h.navigate(); await settle();
    assert.deepEqual(fire(h, link, name.startsWith('middle') ? 'auxclick' : 'click', init), { prevented: true, escaped: false });
  });
}

test('controls: a current drawer\'s arr link and a native drawer\'s link keep their default', async t => {
  const h = setup(t, { overview: HELD }); h.a.initialize(); mount(h); await settle();
  await press(h, 'manage');
  let link = drawer(h).querySelector('a.je-manage-btn[target="_blank"]');
  link.addEventListener('click', e => e.preventDefault(), { once: true }); // jsdom: no real navigation
  assert.equal(fire(h, link, 'click').escaped, true, 'a current drawer passes the click on');
  h.JE.arrManage.close(); await settle();
  await h.JE.arrManage.open({ key: 'movie:tmdb:603' }); await settle();
  h.navigate(); await settle();
  link = drawer(h).querySelector('a.je-manage-btn[target="_blank"]');
  const result = fire(h, link, 'auxclick', { button: 1 });
  assert.deepEqual(result, { prevented: false, escaped: true }, 'natively exactly as before');
});

/** A Seerr modal shell for an operation with a link, a native form and a checkbox in its body. */
function staleModal(h) {
  const o = operationOf(h); let saved = 0;
  const body = '<a class="je-test-link" href="https://example.test/">x</a><form class="je-test-form"><input type="checkbox" class="je-test-check"><button class="je-test-submit">go</button></form>';
  const modal = h.JE.runSubmitted(o.op, () => h.JE.jellyseerrModal.create({ title: 'x', subtitle: 'y', bodyHtml: body, onSave: () => { saved++; } }));
  modal.show();
  return { o, modal, saved: () => saved };
}

for (const [what, target, type] of [['link', '.je-test-link', 'click'], ['link middle-click', '.je-test-link', 'auxclick'], ['form submit button', '.je-test-submit', 'click'],
  ['form submission', '.je-test-form', 'submit'], ['checkbox', '.je-test-check', 'click']]) {
  test(`Seerr modal shell for an ended operation: ${what} → default cancelled, not propagated, the modal closes`, async t => {
    const h = setup(t);
    const { o, modal } = staleModal(h); await settle();
    o.end();
    const node = modal.modalElement.querySelector(target);
    assert.deepEqual(fire(h, node, type), { prevented: true, escaped: false });
    if (target === '.je-test-check') assert.equal(node.checked, false, 'the checkbox did not toggle');
    await settle();
    assert.equal(modal.modalElement.classList.contains('show'), false, 'closed');
  });
}

test('controls: a native Seerr modal (no operation) keeps every default', async t => {
  const h = setup(t);
  const body = '<input type="checkbox" class="je-test-check"><a class="je-test-link" href="#/x">x</a>';
  const modal = h.JE.jellyseerrModal.create({ title: 'x', subtitle: 'y', bodyHtml: body, onSave: () => {} });
  modal.show(); await settle();
  await awayAndBack(h);
  const check = modal.modalElement.querySelector('.je-test-check');
  assert.equal(fire(h, check, 'click').prevented, false);
  assert.equal(check.checked, true);
});

test('Report form for an ended operation: picking an issue type → cancelled (nothing selected), the form closes', async t => {
  const h = setup(t); h.a.initialize(); mount(h); await settle();
  await press(h, 'report');
  const form = h.document.querySelector('.jellyseerr-season-modal');
  h.navigate(); await settle();
  const radio = form.querySelector('input[name="issue-type"]');
  assert.deepEqual(fire(h, radio, 'click'), { prevented: true, escaped: false });
  assert.equal(radio.checked, false);
});

test('season modal for an ended operation: ticking a season → cancelled, nothing ticked', async t => {
  const h = setup(t);
  for (const file of ['seerr-status.js', 'ui/ui-icons.js', 'ui/ui-quota.js', 'ui/ui-season-modal.js']) h.load(`jellyseerr/${file}`);
  h.JE.internals.jellyseerrUi.markCardRequested = () => {};
  Object.assign(h.JE.jellyseerrAPI, { fetchRequestSettings: async () => ({ partialRequestsEnabled: true, enableSpecialEpisodes: false }),
    fetchTvShowDetails: async () => ({ name: 'Show', seasons: [{ seasonNumber: 1, episodeCount: 3, airDate: '2020-01-01' }], externalIds: { tvdbId: 1 } }),
    fetchSonarrLookup: async () => [], fetchUserQuota: async () => null, fetchTvSeasonDetails: async () => ({}) });
  const o = operationOf(h);
  await h.JE.runSubmitted(o.op, () => h.JE.jellyseerrUI.showSeasonSelectionModal(1399, 'tv', 'Show')); await settle();
  const box = h.document.querySelector('.jellyseerr-season-modal .jellyseerr-season-checkbox[data-season-number="1"]');
  assert.ok(box);
  o.end();
  assert.deepEqual(fire(h, box, 'click'), { prevented: true, escaped: false });
  assert.equal(box.checked, false);
});

for (const [what, type] of [['click', 'click'], ['middle-click', 'auxclick'], ['form submission', 'submit']]) {
  test(`request sheet for an ended operation: ${what} → default cancelled, not propagated, the sheet closes`, async t => {
    const h = setup(t); h.a.initialize(); mount(h); await settle();
    await press(h, 'request');
    const node = sheet(h)?.querySelector('.je-sheet-primary');
    assert.ok(node);
    h.navigate(); await settle();
    assert.deepEqual(fire(h, node, type), { prevented: true, escaped: false });
    await settle();
    assert.equal(sheet(h), null);
  });
}

test('More Info window opened for an operation that ended: a link → default cancelled, not propagated, the window closes', async t => {
  const h = setup(t, { asks: false, seerrMoreInfo: true }); h.a.initialize(); mount(h); await settle();
  await press(h, 'request');
  const window = moreInfo(h);
  assert.ok(window, 'the window opened');
  remountEnds(h);
  const link = window.querySelector('.je-test-link');
  assert.deepEqual(fire(h, link, 'click'), { prevented: true, escaped: false });
  assert.equal(window._isClosing, true);
});

test('controls: a native More Info window (no operation) keeps its links', async t => {
  const h = setup(t, { asks: false, seerrMoreInfo: true });
  await h.JE.jellyseerrMoreInfo.open(603, 'movie'); await settle();
  await awayAndBack(h);
  const link = moreInfo(h).querySelector('.je-test-link');
  link.addEventListener('click', e => e.preventDefault(), { once: true });
  assert.equal(fire(h, link, 'click').escaped, true);
});

/** Ends the row's mount (Jellyfin re-rendered it) while the window it opened stays up. */
function remountEnds(h) {
  const row = h.row(); const clone = row.cloneNode(true); row.replaceWith(clone);
  clone.getBoundingClientRect = () => ({ width: 100 });
  h.a.mountRow(clone, h.page, h.a.fromKey('movie:tmdb:603'));
}

test('a retained card\'s sheet whose card was recycled for another title: a press → cancelled, the sheet closes, nothing runs', async t => {
  const h = setup(t, { card: true }); h.a.initialize(); await settle();
  const card = h.document.querySelector('.card');
  card.querySelector('.je-card-more').click(); await settle();
  const entry = h.document.querySelector('.je-actions-entry[data-action="report"]');
  assert.ok(entry, 'the card sheet is open');
  card.dataset.jeHideTitle = 'movie:tmdb:604'; h.a.scan(); await settle();
  assert.deepEqual(fire(h, entry, 'click'), { prevented: true, escaped: false });
  await settle();
  assert.equal(h.document.querySelector('.je-actions-sheet'), null);
  assert.equal(h.document.querySelector('.jellyseerr-season-modal'), null, 'no Report form');
});
