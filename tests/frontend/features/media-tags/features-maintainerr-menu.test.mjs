import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from '../../helpers/harness.mjs';

const MOVIE = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SERIES = 'cccccccccccccccccccccccccccccccc';
const EPISODE = 'dddddddddddddddddddddddddddddddd';
const SEASON = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';

/** A Jellyfin 12 card with its ⋮ button. */
const card = (id, type) => `<div class="card" data-id="${id}" data-type="${type}"><div class="cardBox"><button is="paper-icon-button-light" data-action="menu" class="cardOverlayButton">⋮</button><div class="cardText">t</div></div></div>`;

/**
 * The Maintainerr rows (upstream 481a10ee) over the real UI kit and DOM observer, with the Jellyfin API mocked: the
 * current user, and the plugin's /maintainerr routes (state per item, and the actions). The rows ship inside
 * tags/tag-item-menu.js here (the bundle's load order is pinned), after the Media Tags row.
 */
function setup(t, { admin = true, available = true, requests: requestsOn = false, provider = 'maintainerr', html = '', states = {}, fail = null, url } = {}) {
  const requests = [];
  const userChange = [];
  const io = { epoch: 0 };
  const h = createHarness({
    ...(url ? { url } : {}),
    html: html + '<div id="sheets"></div>',
    JE: {
      pluginConfig: { MaintainerrActionsAvailable: available, RemovalRequestsAvailable: requestsOn, LeavingSoonProvider: provider, ToastDuration: 1500 },
      t: (key, params) => params ? `${key}:${Object.values(params).join('|')}` : key,
      session: {
        onUserChange: (name, fn) => userChange.push(fn),
        createLease: () => { const epoch = io.epoch; return { epoch, isCurrent: () => io.epoch === epoch }; },
      },
    },
    apiClient: {
      getCurrentUser: async () => ({ Policy: { IsAdministrator: admin } }),
      getItem: async (userId, id) => ({ Id: id, Type: 'Movie' }),
      ajax: async ({ type, url, data }) => {
        const u = new URL(url);
        // Each removal tool has its own routes (upstream da0ea773): JellyfinEnhanced/maintainerr/... or /reclaimerr/....
        const tool = u.pathname.match(/^\/JellyfinEnhanced\/(maintainerr|reclaimerr)\//)?.[1];
        requests.push({ type, tool, path: u.pathname.replace(/^\/JellyfinEnhanced\/(maintainerr|reclaimerr)\//, ''), body: data ? JSON.parse(data) : null });
        const reject = (status, error) => { throw Object.assign(new Error('HTTP ' + status), { status, json: async () => ({ error }) }); };
        if (type === 'GET') {
          const id = u.pathname.split('/').pop();
          if (!(id in states)) reject(404);
          return { ItemId: id, Supported: true, ...states[id] };
        }
        if (fail) reject(fail.status, fail.error);
        const body = JSON.parse(data);
        const state = states[body.itemId] || {};
        return { ItemId: body.itemId, Supported: true, Marked: u.pathname.endsWith('/mark') || u.pathname.endsWith('/postpone'), DeleteAt: state.DeleteAt ?? null };
      },
    },
  });
  t.after(() => h.close());
  for (const file of ['enhanced/config.js', 'core/ui-kit.js', 'core/dom-observer.js', 'tags/tag-item-menu.js']) h.load(file);
  const settle = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };
  const frame = () => new Promise((resolve) => h.window.requestAnimationFrame(() => resolve()));
  const $ = (sel) => h.document.querySelector(sel);
  const $$ = (sel) => Array.from(h.document.querySelectorAll(sel));
  const click = (el) => el.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  const openSheet = (rows) => {
    const sheet = h.document.createElement('div');
    sheet.className = 'dialog actionSheet';
    sheet.innerHTML = `<div class="actionSheetContent"><div class="actionSheetScroller scrollY">${rows.map((id) => `<button is="emby-button" type="button" class="listItem listItem-button actionSheetMenuItem" data-id="${id}"><span class="actionsheetMenuItemIcon material-icons add"></span><div class="listItemBody actionsheetListItemBody"><div class="listItemBodyText actionSheetItemText">${id}</div></div></button>`).join('')}</div></div>`;
    $('#sheets').appendChild(sheet);
    return sheet;
  };
  /** Press a ⋮ (a card's, or the element `selector` names), open Jellyfin's sheet and let the rows arrive. */
  const openFrom = async (selector, rows = ['addtocollection', 'share']) => {
    click($(selector));
    openSheet(rows);
    await frame();
    await settle();
  };
  const open = (id, rows) => openFrom(`.card[data-id="${id}"] [data-action="menu"]`, rows);
  const rowIds = () => $$('.actionSheetScroller [data-id^="je-maintainerr-"]').map((el) => el.dataset.id);
  const toasts = () => $$('.jellyfin-enhanced-toast').map((el) => el.textContent);
  /** Another user signs in (the session's reset callbacks run, and earlier leases stop being current). */
  const switchUser = () => { io.epoch++; for (const fn of userChange) fn({ epoch: io.epoch }); };
  return { ...h, requests, settle, frame, $, $$, click, open, openFrom, rowIds, toasts, switchUser };
}

test('an administrator gets Mark for removal on an unlisted movie, before Share; Mark posts and offers Undo, which posts the opposite', async t => {
  const h = setup(t, { html: card(MOVIE, 'Movie'), states: { [MOVIE]: { Marked: false } } });
  await h.open(MOVIE);
  assert.deepEqual(h.rowIds(), ['je-maintainerr-mark']);
  const row = h.$('[data-id="je-maintainerr-mark"]');
  assert.equal(row.nextElementSibling.dataset.id, 'share');
  assert.equal(row.querySelector('.actionSheetItemText').textContent, 'maintainerr_mark');
  assert.deepEqual(h.requests.map(r => r.path), [`item/${MOVIE}`]);

  h.click(row);
  await h.settle();
  assert.deepEqual(h.requests.at(-1), { type: 'POST', tool: 'maintainerr', path: 'mark', body: { itemId: MOVIE } });
  assert.equal(h.toasts().length, 1);
  assert.ok(h.toasts()[0].startsWith('maintainerr_marked'), h.toasts()[0]);
  const undo = h.$('.jellyfin-enhanced-toast-action');
  assert.equal(undo.textContent, 'maintainerr_undo');
  h.click(undo);
  await h.settle();
  assert.deepEqual(h.requests.at(-1), { type: 'POST', tool: 'maintainerr', path: 'unmark', body: { itemId: MOVIE } });
  assert.ok(h.toasts().some(text => text.startsWith('maintainerr_kept')));
});

test('a listed item gets Keep and Postpone; Postpone opens a chooser whose day buttons, custom count and reset post accordingly', async t => {
  const soon = Date.now() + 5 * 86400000 + 3600000;
  const h = setup(t, { html: card(SERIES, 'Series'), states: { [SERIES]: { Marked: true, DeleteAt: soon, CollectionId: 2 } } });
  await h.open(SERIES);
  assert.deepEqual(h.rowIds(), ['je-maintainerr-keep', 'je-maintainerr-postpone']);

  h.click(h.$('[data-id="je-maintainerr-postpone"]'));
  await h.settle();
  const dialog = h.$('.je-mt-dialog');
  assert.ok(dialog, 'the chooser opened');
  assert.match(dialog.querySelector('.je-mt-hint').textContent, /maintainerr_postpone_hint:(5|6)/);
  assert.deepEqual(Array.from(dialog.querySelectorAll('.je-mt-day')).map(b => b.textContent), ['maintainerr_postpone_plus_days:7', 'maintainerr_postpone_plus_days:14', 'maintainerr_postpone_plus_days:30', 'maintainerr_postpone_plus_days:90']);
  h.click(dialog.querySelectorAll('.je-mt-day')[1]);
  await h.settle();
  assert.equal(h.$('.je-mt-dialog'), null, 'the chooser closed');
  assert.deepEqual(h.requests.at(-1), { type: 'POST', tool: 'maintainerr', path: 'postpone', body: { itemId: SERIES, days: 14 } });

  // A custom count: out-of-range values stay in the dialog, a valid one posts.
  h.JE.removalMenu.postpone(SERIES, { Marked: true, DeleteAt: null }, null);
  const custom = h.$('.je-mt-dialog');
  assert.equal(custom.querySelector('.je-mt-hint'), null, 'no days-left line without a delete date');
  const input = custom.querySelector('.je-mt-input');
  input.value = '0';
  h.click(custom.querySelector('.je-mt-apply'));
  assert.ok(h.$('.je-mt-dialog'), 'zero days is not sent');
  input.value = '45';
  h.click(custom.querySelector('.je-mt-apply'));
  await h.settle();
  assert.deepEqual(h.requests.at(-1), { type: 'POST', tool: 'maintainerr', path: 'postpone', body: { itemId: SERIES, days: 45 } });

  // Reset sends no days; Escape and Cancel close without a request.
  h.JE.removalMenu.postpone(SERIES, { Marked: true, DeleteAt: soon }, null);
  h.click(h.$('.je-mt-reset'));
  await h.settle();
  assert.deepEqual(h.requests.at(-1), { type: 'POST', tool: 'maintainerr', path: 'postpone', body: { itemId: SERIES } });
  const before = h.requests.length;
  h.JE.removalMenu.postpone(SERIES, { Marked: true, DeleteAt: soon }, null);
  h.document.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(h.$('.je-mt-dialog'), null);
  h.JE.removalMenu.postpone(SERIES, { Marked: true, DeleteAt: soon }, null);
  h.click(h.$('.je-mt-cancel'));
  assert.equal(h.$('.je-mt-dialog'), null);
  assert.equal(h.requests.length, before);

  // Keep posts unmark with Undo back to mark.
  await h.open(SERIES);
  h.click(h.$('[data-id="je-maintainerr-keep"]'));
  await h.settle();
  assert.deepEqual(h.requests.at(-1), { type: 'POST', tool: 'maintainerr', path: 'unmark', body: { itemId: SERIES } });
  assert.ok(h.toasts().at(-1).startsWith('maintainerr_kept'));
});

const VERSION_4K = '44444444444444444444444444444444';
const VERSION_HD = '55555555555555555555555555555555';
/** Jellyfin 12's detail page of MOVIE: its ⋮, the version picker (`.selectSource`, one option per media source) and other cards (More like this). */
const detailPage = (selected, cards = '') => '<div id="itemDetailPage" class="page"><div class="detailButtons"><button is="emby-button" class="btnMoreCommands detailButton">⋮</button></div>'
  + `<div class="trackSelections"><div class="selectContainer selectSourceContainer"><select is="emby-select" class="selectSource detailTrackSelect"><option value="${VERSION_4K}"${selected === VERSION_4K ? ' selected' : ''}>4K</option><option value="${VERSION_HD}"${selected === VERSION_HD ? ' selected' : ''}>1080p</option></select></div></div>`
  + `<div class="moreLikeThis">${cards}</div></div>`;

test('Mark from the detail page sends the version picked there (and so does Keep\'s Undo); a card\'s menu sends none', async t => {
  const h = setup(t, {
    url: `http://jellyfin.test/web/index.html#/details?id=${MOVIE}`,
    html: detailPage(VERSION_HD, card(SERIES, 'Series')),
    states: { [MOVIE]: { Marked: false }, [SERIES]: { Marked: false } },
  });
  await h.openFrom('#itemDetailPage .btnMoreCommands');
  assert.deepEqual(h.rowIds(), ['je-maintainerr-mark']);
  h.click(h.$('[data-id="je-maintainerr-mark"]'));
  await h.settle();
  assert.deepEqual(h.requests.at(-1), { type: 'POST', tool: 'maintainerr', path: 'mark', body: { itemId: MOVIE, mediaSourceId: VERSION_HD } });

  // The version is read when the row is pressed: the one picked on the page then.
  h.$('.selectSource').value = VERSION_4K;
  h.$('#sheets').textContent = '';
  await h.openFrom('#itemDetailPage .btnMoreCommands');
  h.click(h.$('[data-id="je-maintainerr-mark"]'));
  await h.settle();
  assert.deepEqual(h.requests.at(-1), { type: 'POST', tool: 'maintainerr', path: 'mark', body: { itemId: MOVIE, mediaSourceId: VERSION_4K } });

  // A card's menu on the same page (More like this) is about another item: no version.
  h.$('#sheets').textContent = '';
  await h.open(SERIES);
  h.click(h.$('[data-id="je-maintainerr-mark"]'));
  await h.settle();
  assert.deepEqual(h.requests.at(-1), { type: 'POST', tool: 'maintainerr', path: 'mark', body: { itemId: SERIES } });

  // Keep's Undo marks the movie again, with the version picked on the page.
  const k = setup(t, {
    url: `http://jellyfin.test/web/index.html#/details?id=${MOVIE}`,
    html: detailPage(VERSION_4K),
    states: { [MOVIE]: { Marked: true, CollectionId: 2 } },
  });
  await k.openFrom('#itemDetailPage .btnMoreCommands');
  k.click(k.$('[data-id="je-maintainerr-keep"]'));
  await k.settle();
  assert.deepEqual(k.requests.at(-1), { type: 'POST', tool: 'maintainerr', path: 'unmark', body: { itemId: MOVIE } });
  k.click(k.$('.jellyfin-enhanced-toast-action'));
  await k.settle();
  assert.deepEqual(k.requests.at(-1), { type: 'POST', tool: 'maintainerr', path: 'mark', body: { itemId: MOVIE, mediaSourceId: VERSION_4K } });
});

test('a season gets the rows too, from its card and from its own page; an episode still gets none', async t => {
  const h = setup(t, { html: card(SEASON, 'Season') + card(EPISODE, 'Episode'), states: { [SEASON]: { Marked: false }, [EPISODE]: { Marked: false } } });
  await h.open(SEASON);
  assert.deepEqual(h.rowIds(), ['je-maintainerr-mark']);
  h.click(h.$('[data-id="je-maintainerr-mark"]'));
  await h.settle();
  assert.deepEqual(h.requests.at(-1), { type: 'POST', tool: 'maintainerr', path: 'mark', body: { itemId: SEASON } });
  h.$('#sheets').textContent = '';
  const asked = h.requests.length;
  await h.open(EPISODE);
  assert.deepEqual(h.rowIds(), []);
  assert.equal(h.requests.length, asked, 'an episode is not asked about');

  // The season's own detail page (its type comes from the item read when ⋮ is pressed).
  const page = '<div id="itemDetailPage" class="page"><div class="detailButtons"><button is="emby-button" class="btnMoreCommands detailButton">⋮</button></div></div>';
  const p = setup(t, { url: `http://jellyfin.test/web/index.html#/details?id=${SEASON}`, html: page, states: { [SEASON]: { Marked: true, CollectionId: 10 } } });
  p.window.ApiClient.getItem = async (userId, id) => ({ Id: id, Type: 'Season' });
  await p.openFrom('#itemDetailPage .btnMoreCommands');
  assert.deepEqual(p.rowIds(), ['je-maintainerr-keep', 'je-maintainerr-postpone']);
});

test('no rows for non-administrators, with the actions off, on unsupported items, on other menus, or when the server does not know the item', async t => {
  const h1 = setup(t, { admin: false, html: card(MOVIE, 'Movie'), states: { [MOVIE]: {} } });
  await h1.open(MOVIE);
  assert.deepEqual(h1.rowIds(), []);
  assert.deepEqual(h1.requests, [], 'a non-administrator never asks the server');

  const h2 = setup(t, { available: false, html: card(MOVIE, 'Movie'), states: { [MOVIE]: {} } });
  await h2.open(MOVIE);
  assert.deepEqual(h2.rowIds(), []);
  assert.deepEqual(h2.requests, []);

  const h3 = setup(t, { html: card(EPISODE, 'Episode'), states: { [EPISODE]: {} } });
  await h3.open(EPISODE);
  assert.deepEqual(h3.rowIds(), []);
  assert.deepEqual(h3.requests, []);

  const h4 = setup(t, { html: card(MOVIE, 'Movie'), states: { [MOVIE]: {} } });
  await h4.open(MOVIE, ['sort-name', 'sort-date']);
  assert.deepEqual(h4.rowIds(), [], 'a sort menu is not an item menu');

  const h5 = setup(t, { html: card(MOVIE, 'Movie'), states: {} });
  await h5.open(MOVIE);
  assert.deepEqual(h5.rowIds(), [], 'a 404 (actions off on the server) adds nothing');
});

test('a refused action shows the server\'s reason and offers no Undo', async t => {
  const h = setup(t, { html: card(MOVIE, 'Movie'), states: { [MOVIE]: { Marked: false } }, fail: { status: 400, error: 'No Maintainerr manual collection is on this item\'s library (the movie collections are: Leaving Soon (Movies)).' } });
  await h.open(MOVIE);
  h.click(h.$('[data-id="je-maintainerr-mark"]'));
  await h.settle();
  assert.deepEqual(h.toasts(), ['maintainerr_failed:No Maintainerr manual collection is on this item\'s library (the movie collections are: Leaving Soon (Movies)).']);
  assert.equal(h.$('.jellyfin-enhanced-toast-action'), null);
});

test('a user switch while an action is on its way shows the next user nothing, and asks again whether they are an administrator', async t => {
  let release;
  const h = setup(t, { html: card(MOVIE, 'Movie'), states: { [MOVIE]: { Marked: false } } });
  await h.open(MOVIE);
  const ajax = h.window.ApiClient.ajax;
  h.window.ApiClient.ajax = (request) => request.type === 'POST' ? new Promise((resolve) => { release = () => resolve(ajax(request)); }) : ajax(request);
  h.click(h.$('[data-id="je-maintainerr-mark"]'));
  await h.settle();
  h.switchUser();
  release();
  await h.settle();
  assert.deepEqual(h.toasts(), [], 'no toast about the previous user\'s action');
  h.window.ApiClient.ajax = ajax;
  // The next user is asked for again: a non-administrator gets no rows.
  h.window.ApiClient.getCurrentUser = async () => ({ Policy: { IsAdministrator: false } });
  h.$('#sheets').textContent = '';
  const before = h.requests.length;
  await h.open(MOVIE);
  assert.deepEqual(h.rowIds(), []);
  assert.equal(h.requests.length, before, 'a non-administrator never asks the server');
});

// Reclaimerr (upstream da0ea773): its own routes, exact days, and removal requests for anyone signed in.

test('the removal actions are published as JE.removalMenu, with JE.maintainerrMenu the same object', t => {
  const h = setup(t, {});
  assert.ok(h.JE.removalMenu);
  assert.equal(h.JE.maintainerrMenu, h.JE.removalMenu);
  assert.equal(typeof h.JE.removalMenu.act, 'function', 'the Leaving soon page runs the same actions');
  assert.equal(h.JE.removalMenu.ROWS.request, 'je-maintainerr-request');
});

test('a non-administrator gets Request removal only when removal requests are on and the item is not marked; it posts to request', async t => {
  const h = setup(t, { admin: false, available: false, requests: true, provider: 'reclaimerr', html: card(MOVIE, 'Movie'), states: { [MOVIE]: { Marked: false, canRequest: true } } });
  await h.open(MOVIE);
  assert.deepEqual(h.rowIds(), ['je-maintainerr-request']);
  assert.equal(h.$('[data-id="je-maintainerr-request"] .actionSheetItemText').textContent, 'reclaimerr_request');
  h.click(h.$('[data-id="je-maintainerr-request"]'));
  await h.settle();
  assert.deepEqual(h.requests.at(-1), { type: 'POST', tool: 'reclaimerr', path: 'request', body: { itemId: MOVIE } });
  assert.ok(h.toasts().some(text => text.startsWith('reclaimerr_requested')), h.toasts().join(','));
});

test('a non-administrator gets no row when requests are off, or the item is already marked', async t => {
  const off = setup(t, { admin: false, available: true, requests: false, html: card(MOVIE, 'Movie'), states: { [MOVIE]: { Marked: false, canRequest: true } } });
  await off.open(MOVIE);
  assert.deepEqual(off.rowIds(), []);
  assert.deepEqual(off.requests, [], 'nothing is asked of the server');
  const marked = setup(t, { admin: false, available: false, requests: true, provider: 'reclaimerr', html: card(SERIES, 'Series'), states: { [SERIES]: { Marked: true, canRequest: true } } });
  await marked.open(SERIES);
  assert.deepEqual(marked.rowIds(), []);
  const refused = setup(t, { admin: false, available: false, requests: true, provider: 'reclaimerr', html: card(MOVIE, 'Movie'), states: { [MOVIE]: { Marked: false, canRequest: false } } });
  await refused.open(MOVIE);
  assert.deepEqual(refused.rowIds(), [], 'the server says this user may not request');
});

test('with Reclaimerr, Mark opens the schedule chooser: a day button or an exact date posts the date, and there is no reset', async t => {
  const h = setup(t, { provider: 'reclaimerr', html: card(MOVIE, 'Movie'), states: { [MOVIE]: { Marked: false } } });
  await h.open(MOVIE);
  h.click(h.$('[data-id="je-maintainerr-mark"]'));
  await h.settle();
  assert.deepEqual(h.requests.map(r => r.path), [`item/${MOVIE}`], 'nothing is marked until a day is chosen');
  assert.ok(h.requests.every(r => r.tool === 'reclaimerr'), 'Reclaimerr is addressed through its own routes');
  const dialog = h.$('.je-mt-dialog');
  assert.equal(dialog.querySelector('.je-mt-titletext').textContent, 'reclaimerr_schedule_title');
  assert.equal(dialog.querySelector('.je-mt-reset'), null, 'no timer reset when scheduling');
  const before = Date.now();
  h.click(dialog.querySelectorAll('.je-mt-day')[2]); // +30
  await h.settle();
  const posted = h.requests.at(-1);
  assert.equal(posted.path, 'mark');
  assert.equal(posted.body.itemId, MOVIE);
  const days = (new Date(posted.body.date).getTime() - before) / 86400000;
  assert.ok(days > 29.9 && days < 30.1, String(days));
  assert.ok(h.toasts().at(-1).startsWith('maintainerr_marked'));
  assert.equal(h.$('.jellyfin-enhanced-toast-action')?.textContent, 'maintainerr_undo', 'a schedule can be undone (unmark cancels it)');

  h.JE.removalMenu.postpone(MOVIE, { Marked: false }, null, 'mark');
  const again = h.$('.je-mt-dialog');
  again.querySelector('.je-mt-date').value = '2030-01-15';
  h.click(again.querySelector('.je-mt-applydate'));
  await h.settle();
  const exact = h.requests.at(-1);
  assert.equal(exact.path, 'mark');
  assert.equal(new Date(exact.body.date).getFullYear(), 2030);
  assert.equal(new Date(exact.body.date).getMonth(), 0);
  assert.equal(new Date(exact.body.date).getDate(), 15);
});

test('with Reclaimerr, Postpone can send an exact date, and Keep offers no Undo', async t => {
  const h = setup(t, { provider: 'reclaimerr', html: card(SERIES, 'Series'), states: { [SERIES]: { Marked: true, DeleteAt: Date.now() + 5 * 86400000, CollectionId: 2 } } });
  await h.open(SERIES);
  h.click(h.$('[data-id="je-maintainerr-postpone"]'));
  await h.settle();
  const dialog = h.$('.je-mt-dialog');
  assert.ok(dialog.querySelector('.je-mt-reset'), 'a timer reset stays for postpone');
  const date = dialog.querySelector('.je-mt-date');
  assert.ok(date.min > new Date().toISOString().slice(0, 10), 'a cleanup candidate only moves later than its deadline');
  date.value = '2031-06-01';
  h.click(dialog.querySelector('.je-mt-applydate'));
  await h.settle();
  const posted = h.requests.at(-1);
  assert.equal(posted.tool, 'reclaimerr');
  assert.equal(posted.path, 'postpone');
  assert.equal(new Date(posted.body.date).getFullYear(), 2031);
  assert.equal(posted.body.days, undefined);

  h.$('#sheets').textContent = '';
  await h.open(SERIES);
  h.click(h.$('[data-id="je-maintainerr-keep"]'));
  await h.settle();
  assert.deepEqual(h.requests.at(-1), { type: 'POST', tool: 'reclaimerr', path: 'unmark', body: { itemId: SERIES } });
  assert.equal(h.$('.jellyfin-enhanced-toast-action'), null, 'marking again would not undo a Reclaimerr keep');
});

test('with Reclaimerr the postpone row is a date change and the chooser carries the Reclaimerr logo', async t => {
  const h = setup(t, { provider: 'reclaimerr', html: card(SERIES, 'Series'), states: { [SERIES]: { Marked: true, DeleteAt: Date.now() + 5 * 86400000, CollectionId: 2 } } });
  h.JE.cdn = { url: (bucket, file) => `https://cdn.test/${bucket}/${file}` };
  await h.open(SERIES);
  assert.equal(h.$('[data-id="je-maintainerr-postpone"] .actionSheetItemText').textContent, 'reclaimerr_change_date');
  h.click(h.$('[data-id="je-maintainerr-postpone"]'));
  await h.settle();
  assert.equal(h.$('.je-mt-titletext').textContent, 'reclaimerr_change_date');
  assert.equal(h.$('.je-mt-logo').getAttribute('src'), 'https://cdn.test/selfhst/svg/reclaimerr.svg');
});

test('a removal request that is already waiting says so (mine or someone else\'s) instead of failing', async t => {
  for (const [waiting, key] of [['mine', 'maintainerr_already_requested_mine'], ['other', 'maintainerr_already_requested']]) {
    const h = setup(t, { admin: false, available: false, requests: true, provider: 'reclaimerr', html: card(MOVIE, 'Movie'), states: { [MOVIE]: { Marked: false, canRequest: true } } });
    const ajax = h.window.ApiClient.ajax;
    h.window.ApiClient.ajax = async (opts) => (opts.type === 'POST' ? { ItemId: MOVIE, Supported: true, Marked: false, AlreadyRequested: waiting } : ajax(opts));
    await h.open(MOVIE);
    h.click(h.$('[data-id="je-maintainerr-request"]'));
    await h.settle();
    assert.deepEqual(h.toasts(), [key], waiting);
  }
});

test('the change-date dialog shows the current day and previews the day a choice would set', async t => {
  const soon = Date.now() + 5 * 86400000;
  const h = setup(t, { provider: 'reclaimerr', html: card(SERIES, 'Series'), states: { [SERIES]: { Marked: true, DeleteAt: soon, CollectionId: 2 } } });
  h.JE.removalMenu.postpone(SERIES, { Marked: true, DeleteAt: soon }, null);
  const dialog = h.$('.je-mt-dialog');
  assert.ok(dialog.querySelector('.je-mt-when').textContent.length > 0, 'the current day is shown');
  const preview = dialog.querySelector('.je-mt-preview');
  assert.equal(preview.textContent, '');
  const week = dialog.querySelector('.je-mt-day');
  week.dispatchEvent(new h.window.MouseEvent('mouseenter', { bubbles: true }));
  assert.match(preview.textContent, /^reclaimerr_new_date:/);
  week.dispatchEvent(new h.window.MouseEvent('mouseleave', { bubbles: true }));
  assert.equal(preview.textContent, '');
  const days = dialog.querySelector('.je-mt-input');
  days.value = '10';
  days.dispatchEvent(new h.window.Event('input', { bubbles: true }));
  assert.match(preview.textContent, /^reclaimerr_new_date:/);
  h.click(dialog.querySelector('.je-mt-x'));
  assert.equal(h.$('.je-mt-dialog'), null, 'the close button closes it');
});

test('a done action tells the Leaving soon page to reload; a failed one does not', async t => {
  const h = setup(t, { html: card(MOVIE, 'Movie'), states: { [MOVIE]: { Marked: false } } });
  let changed = 0;
  h.window.addEventListener('je-leaving-soon-changed', () => { changed++; });
  await h.JE.removalMenu.act('mark', { itemId: MOVIE }, 'maintainerr_marked', null);
  assert.equal(changed, 1);
  const failing = setup(t, { html: card(MOVIE, 'Movie'), states: { [MOVIE]: { Marked: false } }, fail: { status: 502, error: 'Maintainerr: timed out' } });
  let failed = 0;
  failing.window.addEventListener('je-leaving-soon-changed', () => { failed++; });
  await failing.JE.removalMenu.act('mark', { itemId: MOVIE }, 'maintainerr_marked', null);
  assert.equal(failed, 0);
});
