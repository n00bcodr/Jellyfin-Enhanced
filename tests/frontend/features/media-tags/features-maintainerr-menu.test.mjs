import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from '../../helpers/harness.mjs';

const MOVIE = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SERIES = 'cccccccccccccccccccccccccccccccc';
const EPISODE = 'dddddddddddddddddddddddddddddddd';

/** A Jellyfin 12 card with its ⋮ button. */
const card = (id, type) => `<div class="card" data-id="${id}" data-type="${type}"><div class="cardBox"><button is="paper-icon-button-light" data-action="menu" class="cardOverlayButton">⋮</button><div class="cardText">t</div></div></div>`;

/**
 * The Maintainerr rows (upstream 481a10ee) over the real UI kit and DOM observer, with the Jellyfin API mocked: the
 * current user, and the plugin's /maintainerr routes (state per item, and the actions). The rows ship inside
 * tags/tag-item-menu.js here (the bundle's load order is pinned), after the Media Tags row.
 */
function setup(t, { admin = true, available = true, html = '', states = {}, fail = null } = {}) {
  const requests = [];
  const userChange = [];
  const io = { epoch: 0 };
  const h = createHarness({
    html: html + '<div id="sheets"></div>',
    JE: {
      pluginConfig: { MaintainerrActionsAvailable: available, ToastDuration: 1500 },
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
        requests.push({ type, path: u.pathname.replace('/JellyfinEnhanced/maintainerr/', ''), body: data ? JSON.parse(data) : null });
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
  /** Press a card's ⋮, open Jellyfin's sheet and let the rows arrive. */
  const open = async (id, rows = ['addtocollection', 'share']) => {
    click($(`.card[data-id="${id}"] [data-action="menu"]`));
    openSheet(rows);
    await frame();
    await settle();
  };
  const rowIds = () => $$('.actionSheetScroller [data-id^="je-maintainerr-"]').map((el) => el.dataset.id);
  const toasts = () => $$('.jellyfin-enhanced-toast').map((el) => el.textContent);
  /** Another user signs in (the session's reset callbacks run, and earlier leases stop being current). */
  const switchUser = () => { io.epoch++; for (const fn of userChange) fn({ epoch: io.epoch }); };
  return { ...h, requests, settle, frame, $, $$, click, open, rowIds, toasts, switchUser };
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
  assert.deepEqual(h.requests.at(-1), { type: 'POST', path: 'mark', body: { itemId: MOVIE } });
  assert.equal(h.toasts().length, 1);
  assert.ok(h.toasts()[0].startsWith('maintainerr_marked'), h.toasts()[0]);
  const undo = h.$('.jellyfin-enhanced-toast-action');
  assert.equal(undo.textContent, 'maintainerr_undo');
  h.click(undo);
  await h.settle();
  assert.deepEqual(h.requests.at(-1), { type: 'POST', path: 'unmark', body: { itemId: MOVIE } });
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
  assert.deepEqual(h.requests.at(-1), { type: 'POST', path: 'postpone', body: { itemId: SERIES, days: 14 } });

  // A custom count: out-of-range values stay in the dialog, a valid one posts.
  h.JE.maintainerrMenu.postpone(SERIES, { Marked: true, DeleteAt: null }, null);
  const custom = h.$('.je-mt-dialog');
  assert.equal(custom.querySelector('.je-mt-hint'), null, 'no days-left line without a delete date');
  const input = custom.querySelector('.je-mt-input');
  input.value = '0';
  h.click(custom.querySelector('.je-mt-apply'));
  assert.ok(h.$('.je-mt-dialog'), 'zero days is not sent');
  input.value = '45';
  h.click(custom.querySelector('.je-mt-apply'));
  await h.settle();
  assert.deepEqual(h.requests.at(-1), { type: 'POST', path: 'postpone', body: { itemId: SERIES, days: 45 } });

  // Reset sends no days; Escape and Cancel close without a request.
  h.JE.maintainerrMenu.postpone(SERIES, { Marked: true, DeleteAt: soon }, null);
  h.click(h.$('.je-mt-reset'));
  await h.settle();
  assert.deepEqual(h.requests.at(-1), { type: 'POST', path: 'postpone', body: { itemId: SERIES } });
  const before = h.requests.length;
  h.JE.maintainerrMenu.postpone(SERIES, { Marked: true, DeleteAt: soon }, null);
  h.document.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(h.$('.je-mt-dialog'), null);
  h.JE.maintainerrMenu.postpone(SERIES, { Marked: true, DeleteAt: soon }, null);
  h.click(h.$('.je-mt-cancel'));
  assert.equal(h.$('.je-mt-dialog'), null);
  assert.equal(h.requests.length, before);

  // Keep posts unmark with Undo back to mark.
  await h.open(SERIES);
  h.click(h.$('[data-id="je-maintainerr-keep"]'));
  await h.settle();
  assert.deepEqual(h.requests.at(-1), { type: 'POST', path: 'unmark', body: { itemId: SERIES } });
  assert.ok(h.toasts().at(-1).startsWith('maintainerr_kept'));
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
