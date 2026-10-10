import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, ph, view, playlistPage, realRow, tick, frames, LIST, ITEM_A, ITEM_B, ITEM_C } from './lp-harness.mjs';

const ITEM = { Id: LIST, Name: 'Marathon', Type: 'Playlist' };

/** Mounts a playlist page and a controller fed by `views` (one GET per load). */
async function mount(t, { views = [view()], ids = [ITEM_A, ITEM_B, ITEM_C], sortable = true, reorder, tv = false } = {}) {
  let viewIndex = 0;
  const reorders = [];
  const h = setup(t, {
    html: playlistPage(ids),
    plugin: async (path, options = {}) => {
      if (options.method === 'PUT') {
        reorders.push(options.body);
        if (reorder) return reorder(options.body);
        return view({ ...views[Math.min(viewIndex, views.length - 1)], rev: options.body.rev + 1, order: options.body.order });
      }
      if (path === `/list-placeholders/${LIST}`) return views[Math.min(viewIndex++, views.length - 1)];
      throw new Error('unexpected ' + path);
    }
  });
  if (tv) h.document.documentElement.classList.add('layout-tv');
  const page = h.document.querySelector('.itemDetailPage');
  const container = page.querySelector('.itemsContainer');
  const options = { draggable: '.listItem', disabled: false };
  if (sortable) container.sortable = { option: (k, v) => { if (v === undefined) return options[k]; options[k] = v; return undefined; } };
  let refreshes = 0;
  container.refreshItems = () => { refreshes++; return Promise.resolve(); };
  container.fetchData = () => Promise.resolve({ Items: [] });
  h.JE.initializeListPlaceholders();
  const ctrl = h.lp.playlist.attach(page, ITEM);
  await tick(); await tick();
  const order = () => [...container.children].map(el => el.classList.contains('listItem') ? 'e:' + el.getAttribute('data-id') : el.classList.contains('je-lp-row') ? 'p:' + el.getAttribute('data-je-lp-id') : '?' + el.className);
  return { ...h, page, container, ctrl, options, reorders, order, refreshes: () => refreshes };
}

test('placement plan anchors placeholders after the nearest preceding real row on screen', t => {
  const h = setup(t);
  const plan = h.lp.playlist.planPlacement(
    ['p:s1', `e:${ITEM_A}:0`, 'p:x', `e:${ITEM_C}:0`, 'p:y', 'p:z', `e:${ITEM_B}:0`, 'p:gone', 'p:x'],
    new Set([`e:${ITEM_A}:0`, `e:${ITEM_B}:0`]),
    new Set(['s1', 'x', 'y', 'z', 'orphan']));
  assert.deepEqual([...plan.start], ['s1']);
  // ITEM_C is not on screen (skipped token): y and z stay after ITEM_A's group
  assert.deepEqual([...plan.after.get(`e:${ITEM_A}:0`)], ['x', 'y', 'z']);
  assert.equal(plan.after.has(`e:${ITEM_B}:0`), false);
  assert.deepEqual([...plan.orphans], ['orphan']);
});

test('rows are inserted in the projected order after the native render, with occurrence tokens', async t => {
  const v = view({
    placeholders: [ph('s1'), ph('mid', { title: 'Mid' }), ph('end')],
    order: ['p:s1', `e:${ITEM_A}:0`, `e:${ITEM_B}:0`, 'p:mid', `e:${ITEM_C}:0`, `e:${ITEM_A}:1`, 'p:end']
  });
  const h = await mount(t, { views: [v], ids: [ITEM_A, ITEM_B, ITEM_C, ITEM_A] });
  assert.deepEqual(h.order(), ['p:s1', `e:${ITEM_A}`, `e:${ITEM_B}`, 'p:mid', `e:${ITEM_C}`, `e:${ITEM_A}`, 'p:end']);
  const rows = [...h.container.querySelectorAll('.listItem')];
  assert.deepEqual(rows.map(r => r.__jeLpToken), [`e:${ITEM_A}:0`, `e:${ITEM_B}:0`, `e:${ITEM_C}:0`, `e:${ITEM_A}:1`]);
  // editors get the toolbar and draggable placeholders joining jellyfin-web's Sortable
  assert.ok(h.page.querySelector('.je-lp-toolbar'));
  assert.equal(h.options.draggable, '.listItem, .je-lp-row');
  assert.equal(h.container.querySelectorAll('.je-lp-row .listViewDragHandle').length, 3);
  // native re-render (innerHTML replace) through afterRefresh re-inserts the rows
  h.container.innerHTML = [ITEM_A, ITEM_B, ITEM_C, ITEM_A].map(id => realRow(id)).join('');
  h.container.afterRefresh({ Items: [] });
  assert.deepEqual(h.order(), ['p:s1', `e:${ITEM_A}`, `e:${ITEM_B}`, 'p:mid', `e:${ITEM_C}`, `e:${ITEM_A}`, 'p:end']);
});

test('a chained afterRefresh hook keeps the previous hook', async t => {
  const h = setup(t, { html: playlistPage([ITEM_A]), plugin: async () => view({ placeholders: [ph('x')], order: [`e:${ITEM_A}:0`, 'p:x'] }) });
  const page = h.document.querySelector('.itemDetailPage');
  const container = page.querySelector('.itemsContainer');
  const seen = [];
  container.afterRefresh = (result) => seen.push(result);
  h.lp.playlist.attach(page, ITEM);
  await tick(); await tick();
  container.afterRefresh({ Items: [1] });
  assert.equal(seen.length, 1);
  assert.equal(container.querySelectorAll('.je-lp-row').length, 1);
});

/** Dispatches SortableJS's DOM `end` event the way Sortable does, then runs a stand-in for jellyfin-web's onEnd. */
function sortableEnd(h, item) {
  const evt = new h.window.CustomEvent('end', { bubbles: true, cancelable: true });
  evt.item = item;
  evt.newIndex = [...h.container.children].indexOf(item);
  h.container.dispatchEvent(evt);
  // jellyfin-web's onDrop reads these synchronously right after the DOM event
  return { playlistId: item.getAttribute('data-playlistid'), newIndex: evt.newIndex };
}

test('dragging a real row strips data-playlistid for jellyfin-web, fixes the index and saves with moved', async t => {
  const v = view({ placeholders: [ph('x')], order: [`e:${ITEM_A}:0`, 'p:x', `e:${ITEM_B}:0`, `e:${ITEM_C}:0`] });
  const h = await mount(t, { views: [v] });
  const rowC = h.container.querySelector(`.listItem[data-id="${ITEM_C}"]`);
  // user drags C above the placeholder: DOM now A, C, x, B
  h.container.querySelector('.je-lp-row').before(rowC);
  const seen = sortableEnd(h, rowC);
  assert.equal(seen.playlistId, null, 'jellyfin-web must take its no-server-call branch');
  assert.equal(seen.newIndex, 1, 'index counts .listItem rows only');
  assert.equal(h.ctrl.busy, true);
  await tick();
  assert.equal(rowC.getAttribute('data-playlistid'), LIST, 'restored after jellyfin-web ran');
  await tick(); await tick();
  assert.equal(h.reorders.length, 1);
  assert.deepEqual([...h.reorders[0].order], [`e:${ITEM_A}:0`, `e:${ITEM_C}:0`, 'p:x', `e:${ITEM_B}:0`]);
  assert.equal(h.reorders[0].moved, `e:${ITEM_C}:0`);
  assert.equal(h.reorders[0].rev, 1);
  assert.ok(h.reorders[0].requestId);
  assert.equal(h.ctrl.busy, false);
  assert.equal(h.options.disabled, false);
});

test('dragging a placeholder saves the order without moved; an unchanged drop saves nothing', async t => {
  const v = view({ placeholders: [ph('x')], order: [`e:${ITEM_A}:0`, 'p:x', `e:${ITEM_B}:0`, `e:${ITEM_C}:0`] });
  const h = await mount(t, { views: [v] });
  const row = h.container.querySelector('.je-lp-row');
  sortableEnd(h, row);
  await tick(); await tick();
  assert.equal(h.reorders.length, 0);
  h.container.appendChild(row);
  sortableEnd(h, row);
  await tick(); await tick();
  assert.equal(h.reorders.length, 1);
  assert.deepEqual([...h.reorders[0].order], [`e:${ITEM_A}:0`, `e:${ITEM_B}:0`, `e:${ITEM_C}:0`, 'p:x']);
  assert.equal('moved' in h.reorders[0], false);
});

test('moving a second copy of a duplicated item is refused before any call', async t => {
  const v = view({ placeholders: [ph('x')], order: [`e:${ITEM_A}:0`, 'p:x', `e:${ITEM_B}:0`, `e:${ITEM_A}:1`] });
  const h = await mount(t, { views: [v], ids: [ITEM_A, ITEM_B, ITEM_A] });
  const second = h.container.querySelectorAll(`.listItem[data-id="${ITEM_A}"]`)[1];
  h.container.insertBefore(second, h.container.firstChild);
  sortableEnd(h, second);
  await tick(); await tick();
  assert.equal(h.reorders.length, 0);
  assert.equal(h.toasts.length, 1);
  assert.equal(h.refreshes(), 1);
});

test('a refused save refreshes jellyfin-web rows from the fresh view', async t => {
  const fresh = view({ rev: 5, placeholders: [ph('x')], order: [`e:${ITEM_A}:0`, `e:${ITEM_B}:0`, 'p:x', `e:${ITEM_C}:0`] });
  const h = await mount(t, {
    views: [view({ placeholders: [ph('x')], order: [`e:${ITEM_A}:0`, 'p:x', `e:${ITEM_B}:0`, `e:${ITEM_C}:0`] })],
    reorder: () => { throw Object.assign(new Error('HTTP 409'), { status: 409, responseJSON: { code: 'rev_conflict', view: fresh } }); }
  });
  const rowC = h.container.querySelector(`.listItem[data-id="${ITEM_C}"]`);
  h.container.insertBefore(rowC, h.container.firstChild);
  sortableEnd(h, rowC);
  await tick(); await tick(); await tick();
  assert.equal(h.ctrl.view.rev, 5);
  assert.equal(h.refreshes(), 1, 'DOM no longer matches the server: jellyfin-web reloads its rows');
  assert.equal(h.toasts.length, 1);
});

test('without placeholders on screen jellyfin-web keeps its own Move untouched', async t => {
  const h = await mount(t, { views: [view({ placeholders: [], order: [`e:${ITEM_A}:0`, `e:${ITEM_B}:0`, `e:${ITEM_C}:0`] })] });
  const rowC = h.container.querySelector(`.listItem[data-id="${ITEM_C}"]`);
  h.container.insertBefore(rowC, h.container.firstChild);
  const seen = sortableEnd(h, rowC);
  assert.equal(seen.playlistId, LIST);
  assert.equal(seen.newIndex, 0);
  await tick(); await tick();
  assert.equal(h.reorders.length, 0);
  assert.equal(h.options.draggable, '.listItem');
});

test('the MutationObserver fallback re-inserts only when every JE row is gone, and not while dragging', async t => {
  const v = view({ placeholders: [ph('x'), ph('y')], order: [`e:${ITEM_A}:0`, 'p:x', `e:${ITEM_B}:0`, 'p:y', `e:${ITEM_C}:0`] });
  const h = await mount(t, { views: [v] });
  const before = h.container.querySelector('.je-lp-row');
  // an unrelated mutation (a row moved by Sortable) must not rebuild or reposition JE rows
  h.container.appendChild(h.container.querySelector(`.listItem[data-id="${ITEM_A}"]`));
  await frames();
  assert.equal(h.container.querySelector('.je-lp-row'), before);
  assert.deepEqual(h.order(), [`p:x`, `e:${ITEM_B}`, 'p:y', `e:${ITEM_C}`, `e:${ITEM_A}`]);
  // native innerHTML re-render that bypasses afterRefresh, while a drag is in progress
  h.container.dispatchEvent(new h.window.CustomEvent('choose'));
  h.container.innerHTML = [ITEM_A, ITEM_B, ITEM_C].map(id => realRow(id)).join('');
  await frames();
  assert.equal(h.container.querySelectorAll('.je-lp-row').length, 0, 'suspended while dragging');
  h.container.dispatchEvent(new h.window.CustomEvent('unchoose'));
  await frames();
  assert.deepEqual(h.order(), [`e:${ITEM_A}`, 'p:x', `e:${ITEM_B}`, 'p:y', `e:${ITEM_C}`]);
  // and again without a drag
  h.container.innerHTML = [ITEM_A, ITEM_B, ITEM_C].map(id => realRow(id)).join('');
  await frames();
  assert.deepEqual(h.order(), [`e:${ITEM_A}`, 'p:x', `e:${ITEM_B}`, 'p:y', `e:${ITEM_C}`]);
});

test('TV layout: focusable rows, no drag handles, Move up/down in the menu instead', async t => {
  const v = view({ placeholders: [ph('x'), ph('y')], order: [`e:${ITEM_A}:0`, 'p:x', 'p:y', `e:${ITEM_B}:0`] });
  const h = await mount(t, { views: [v], ids: [ITEM_A, ITEM_B], tv: true });
  assert.equal(h.container.querySelectorAll('.je-lp-row .listViewDragHandle').length, 0);
  assert.equal(h.options.draggable, '.listItem');
  assert.ok(h.container.querySelector('.je-lp-row .je-lp-row-main.focusable'));
  h.container.querySelector('.je-lp-row[data-je-lp-id="y"] .je-lp-menu-btn').click();
  const labels = [...h.document.querySelectorAll('.je-lp-menu-item')].map(b => b.lastChild.textContent);
  assert.deepEqual(labels, ['listPlaceholders_move_up', 'listPlaceholders_move_down', 'listPlaceholders_remove']);
  h.document.querySelectorAll('.je-lp-menu-item')[0].click();
  await tick(); await tick();
  assert.deepEqual([...h.reorders[0].order], [`e:${ITEM_A}:0`, 'p:y', 'p:x', `e:${ITEM_B}:0`]);
  assert.equal('moved' in h.reorders[0], false);
  assert.equal(h.document.querySelector('.je-lp-menu'), null);
});

test('admins who are not native editors get the menu moves but no drag handles; viewers get neither', async t => {
  const v = view({ nativeCanEdit: false, placeholders: [ph('x')], order: [`e:${ITEM_A}:0`, 'p:x'] });
  const h = await mount(t, { views: [v], ids: [ITEM_A], sortable: false });
  assert.equal(h.container.querySelectorAll('.listViewDragHandle.je-lp-drag').length, 0);
  assert.ok(h.container.querySelector('.je-lp-menu-btn'));
  const viewer = await mount(t, { views: [view({ canEdit: false, nativeCanEdit: false, placeholders: [ph('x')], order: [`e:${ITEM_A}:0`, 'p:x'] })], ids: [ITEM_A], sortable: false });
  assert.equal(viewer.container.querySelector('.je-lp-menu-btn'), null);
  assert.equal(viewer.page.querySelector('.je-lp-toolbar'), null);
  assert.ok(viewer.container.querySelector('.je-lp-request'));
});

test('a newer revision with different real rows reloads jellyfin-web rows once', async t => {
  const first = view({ placeholders: [ph('x')], order: [`e:${ITEM_A}:0`, 'p:x', `e:${ITEM_B}:0`] });
  const second = view({ rev: 2, placeholders: [ph('x')], order: [`e:${ITEM_A}:0`, 'p:x', `e:${ITEM_B}:0`, `e:${ITEM_C}:0`] });
  const h = await mount(t, { views: [first, second], ids: [ITEM_A, ITEM_B] });
  assert.equal(h.refreshes(), 0);
  await h.ctrl.load();
  assert.equal(h.refreshes(), 1);
  await h.ctrl.load();
  assert.equal(h.refreshes(), 1, 'not again for the same revision');
});

test('statuses poll with backoff while the Seerr index is not ready', async t => {
  const timers = [];
  const h = setup(t, { html: playlistPage([ITEM_A]), plugin: async () => view({ seerrStatusReady: false, placeholders: [ph('x', { status: null })], order: [`e:${ITEM_A}:0`, 'p:x'] }) });
  const realSetTimeout = h.window.setTimeout;
  h.window.setTimeout = (fn, ms) => { timers.push(ms); return realSetTimeout(() => {}, 0); };
  const page = h.document.querySelector('.itemDetailPage');
  const ctrl = h.lp.playlist.attach(page, ITEM);
  await tick(); await tick();
  assert.ok(timers.includes(2000));
  assert.ok(page.querySelector('.je-lp-badge-loading'));
  ctrl.pollIndex = 4;
  ctrl.schedulePoll();
  assert.ok(timers.includes(32000));
  timers.length = 0;
  ctrl.schedulePoll();
  assert.equal(timers.includes(32000), false, 'gives up after five tries');
});

test('a failed placeholder drag at the same revision puts the row back where the server has it', async t => {
  const v = view({ placeholders: [ph('x')], order: [`e:${ITEM_A}:0`, 'p:x', `e:${ITEM_B}:0`, `e:${ITEM_C}:0`] });
  const h = await mount(t, {
    views: [v],
    reorder: () => { throw Object.assign(new Error('HTTP 500'), { status: 500, responseJSON: { code: 'list_update_failed', view: v } }); }
  });
  h.container.appendChild(h.container.querySelector('.je-lp-row'));
  sortableEnd(h, h.container.querySelector('.je-lp-row'));
  await tick(); await tick(); await tick();
  assert.equal(h.reorders.length, 1);
  assert.deepEqual(h.order(), [`e:${ITEM_A}`, 'p:x', `e:${ITEM_B}`, `e:${ITEM_C}`]);
  assert.equal(h.refreshes(), 0, 'real rows were not touched: no jellyfin-web reload needed');
  assert.equal(h.toasts.length, 1);
});

test('every failed real-row move reloads jellyfin-web rows, also twice at the same revision', async t => {
  const v = view({ placeholders: [ph('x')], order: [`e:${ITEM_A}:0`, 'p:x', `e:${ITEM_B}:0`, `e:${ITEM_C}:0`] });
  const h = await mount(t, {
    views: [v],
    reorder: () => { throw Object.assign(new Error('HTTP 409'), { status: 409, responseJSON: { code: 'move_failed', view: v } }); }
  });
  const rowC = h.container.querySelector(`.listItem[data-id="${ITEM_C}"]`);
  for (let attempt = 1; attempt <= 2; attempt++) {
    h.container.insertBefore(rowC, h.container.firstChild);
    sortableEnd(h, rowC);
    await tick(); await tick(); await tick();
    assert.equal(h.refreshes(), attempt, `attempt ${attempt} reloads the rows once`);
  }
  assert.equal(h.reorders.length, 2);
});

test('a GET answer for an older revision never rolls back what a mutation published', async t => {
  let pendingGet = null;
  let gets = 0;
  const h = setup(t, {
    html: playlistPage([ITEM_A]),
    plugin: (path, options = {}) => {
      if (options.method === 'DELETE') return Promise.resolve(view({ rev: 2, placeholders: [ph('y')], order: [`e:${ITEM_A}:0`, 'p:y'] }));
      gets++;
      const v1 = view({ rev: 1, placeholders: [ph('x'), ph('y')], order: [`e:${ITEM_A}:0`, 'p:x', 'p:y'] });
      if (gets === 1) return Promise.resolve(v1);
      return new Promise((resolve) => { pendingGet = () => resolve(v1); });
    }
  });
  h.JE.initializeListPlaceholders();
  const page = h.document.querySelector('.itemDetailPage');
  const ctrl = h.lp.playlist.attach(page, ITEM);
  await tick(); await tick();
  const rows = () => [...page.querySelectorAll('.je-lp-row')].map(r => r.getAttribute('data-je-lp-id'));
  assert.deepEqual(rows(), ['x', 'y']);
  const poll = ctrl.load(); // reads rev 1 ...
  await h.lp.api.removePlaceholder(LIST, 'x', 1); // ... while a removal publishes rev 2
  assert.deepEqual(rows(), ['y']);
  pendingGet();
  await poll;
  assert.equal(ctrl.view.rev, 2);
  assert.deepEqual(rows(), ['y']);
  assert.equal((await h.lp.api.getView(LIST, { maxAgeMs: 5000 })).rev, 2, 'the cache keeps the newer view');
  // an older view published directly is ignored as well
  h.lp.api.publish(view({ rev: 1, placeholders: [ph('x')], order: [`e:${ITEM_A}:0`, 'p:x'] }));
  assert.deepEqual(rows(), ['y']);
});

test('controllers of pages jellyfin-web dropped are disposed on the next view show; a reused page is re-activated', async t => {
  const v = view({ placeholders: [ph('x')], order: [`e:${ITEM_A}:0`, 'p:x', `e:${ITEM_B}:0`, `e:${ITEM_C}:0`] });
  const h = await mount(t, { views: [v] });
  h.ctrl.scheduleRefetch();
  let disconnected = 0;
  const realDisconnect = h.ctrl.observer.disconnect.bind(h.ctrl.observer);
  h.ctrl.observer.disconnect = () => { disconnected++; realDisconnect(); };
  // a cached page that is still in the DOM stays
  await h.JE.__viewHandler(null, null, '#/home');
  assert.equal(h.lp.controllers.has(h.ctrl), true);
  h.page.remove();
  const gets = h.calls.length;
  await h.JE.__viewHandler(null, null, '#/home');
  assert.equal(h.lp.controllers.has(h.ctrl), false);
  assert.equal(disconnected, 1);
  assert.equal(h.ctrl.refetchTimer, null);
  await new Promise(r => setTimeout(r, 1100));
  assert.equal(h.calls.length, gets, 'no request for a dropped page');
  // user switch: controllers leave the set; showing the same cached page again takes it back with a fresh view
  h.document.body.appendChild(h.page);
  h.lp.playlist.attach(h.page, ITEM);
  h.switchUser();
  assert.equal(h.lp.controllers.size, 0);
  const again = h.lp.playlist.attach(h.page, ITEM);
  assert.equal(again, h.ctrl);
  assert.equal(h.lp.controllers.has(h.ctrl), true);
  await tick(); await tick();
  assert.equal(h.ctrl.view.rev, 1);
  assert.equal(h.ctrl.user?.active, true, 'Seerr user status fetched again for the new user');
});
