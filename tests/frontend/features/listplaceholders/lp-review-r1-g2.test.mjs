// Review round 1 (track g2) regressions: modal close races, stale identity in the picker, re-renders during a
// drag, the LibraryChanged subscription after an ApiClient switch, the view cache bound and the "Missing from"
// available count.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, deferred } from '../../helpers/harness.mjs';
import { setup, ph, view, playlistPage, tick, LIST, COLLECTION, ITEM_A, ITEM_B, ITEM_C } from './lp-harness.mjs';

const until = async (fn, tries = 100) => { for (let i = 0; i < tries; i++) { const v = fn(); if (v) return v; await tick(); } throw new Error('timeout'); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Counts history.back() calls (still performing them). */
function countBacks(h) {
  const history = h.window.history;
  const original = history.back.bind(history);
  const counter = { count: 0 };
  history.back = () => { counter.count++; original(); };
  return counter;
}

/** List placeholders modules plus modal.js. */
function setupModals(t, plugin, config) {
  const h = setup(t, { plugin, config });
  h.load('jellyseerr/modal.js');
  return h;
}

test('F42: Add title closed while its POST runs does not go back a second time', async t => {
  const pending = deferred();
  const posts = [];
  // Seerr off and no arr lookup: the modal opens on the custom entry form.
  const h = setupModals(t, async (path, options = {}) => { posts.push(path); if (options.method === 'POST') return pending.promise; return {}; },
    { JellyseerrEnabled: false });
  const backs = countBacks(h);
  const modal = h.lp.search.open({ listId: LIST, listKind: 'collection', listName: 'Cars', view: view() });
  modal.show();
  const root = modal.modalElement;
  root.querySelector('.je-lp-custom-title').value = 'Some film';
  root.querySelector('.jellyseerr-modal-button-primary').click();
  await until(() => posts.length === 1);
  // The user gives up while the add runs: Cancel closes through history.back().
  root.querySelector('.jellyseerr-modal-button-secondary').click();
  assert.equal(backs.count, 1);
  await until(() => !h.document.body.classList.contains('jellyseerr-modal-is-open'));
  pending.resolve({ added: ['n'], addedAsItems: [], skipped: [], view: view({ listId: COLLECTION, listKind: 'collection' }) });
  await until(() => h.toasts.length);
  await sleep(10);
  assert.equal(backs.count, 1, 'a closed modal has no history entry left: going back again would leave the page');
});

test('F42: Add title still closes itself after a successful add', async t => {
  const h = setupModals(t, async () => ({ added: ['n'], addedAsItems: [], skipped: [], view: view({ listId: COLLECTION, listKind: 'collection' }) }),
    { JellyseerrEnabled: false });
  const backs = countBacks(h);
  const modal = h.lp.search.open({ listId: LIST, listKind: 'collection', listName: 'Cars', view: view() });
  modal.show();
  modal.modalElement.querySelector('.je-lp-custom-title').value = 'Some film';
  modal.modalElement.querySelector('.jellyseerr-modal-button-primary').click();
  await until(() => backs.count === 1);
  await until(() => !h.document.body.classList.contains('jellyseerr-modal-is-open'));
});

/** Editable lists with one own playlist. */
const LISTS = { playlists: [{ id: LIST, name: 'Mine', isOwn: true }], collections: [], canManageCollections: false };

test('F42: picker closed while its POST runs does not go back a second time', async t => {
  const pending = deferred();
  const posts = [];
  const h = setupModals(t, async (path) => {
    if (path === '/list-placeholders/editable-lists') return LISTS;
    posts.push(path);
    return pending.promise;
  });
  const backs = countBacks(h);
  const modal = await h.lp.picker.openPicker({ item: { id: 862, title: 'Toy Story' }, mediaType: 'movie' });
  const root = modal.modalElement;
  assert.equal(root.querySelector('.je-lp-list-select').value, `playlist:${LIST}`);
  root.querySelector('.jellyseerr-modal-button-primary').click();
  await until(() => posts.length === 1);
  root.querySelector('.jellyseerr-modal-button-secondary').click();
  assert.equal(backs.count, 1);
  await until(() => !h.document.body.classList.contains('jellyseerr-modal-is-open'));
  pending.resolve({ added: ['n'], addedAsItems: [], skipped: [], view: view() });
  await until(() => h.toasts.length);
  await sleep(10);
  assert.equal(backs.count, 1);
});

test('F42: picker still closes itself after a successful add', async t => {
  const h = setupModals(t, async (path) => path === '/list-placeholders/editable-lists' ? LISTS : { added: ['n'], addedAsItems: [], skipped: [], view: view() });
  const backs = countBacks(h);
  const modal = await h.lp.picker.openPicker({ item: { id: 862, title: 'Toy Story' }, mediaType: 'movie' });
  modal.modalElement.querySelector('.jellyseerr-modal-button-primary').click();
  await until(() => backs.count === 1);
});

test('F48: the picker never shows the previous user\'s lists after a user switch', async t => {
  const lists = deferred();
  const h = setupModals(t, async (path) => {
    if (path === '/list-placeholders/editable-lists') return lists.promise;
    throw new Error('unexpected ' + path);
  });
  const opening = h.lp.picker.openPicker({ item: { id: 862, title: 'Toy Story' }, mediaType: 'movie' });
  await tick();
  h.switchUser();
  lists.resolve({ playlists: [{ id: LIST, name: 'Alice private', isOwn: true }], collections: [], canManageCollections: false });
  assert.equal(await opening, null);
  assert.equal(h.document.querySelector('.je-lp-list-select'), null);
  assert.equal(h.document.body.textContent.includes('Alice private'), false);
  assert.equal(h.toasts.length, 0);
});

/** Playlist page with a controller (mirrors lp-playlist.test.mjs). */
async function mountPlaylist(t, { views, reorder }) {
  let viewIndex = 0;
  const reorders = [];
  const h = setup(t, {
    html: playlistPage([ITEM_A, ITEM_B, ITEM_C]),
    plugin: async (path, options = {}) => {
      if (options.method === 'PUT') {
        reorders.push(options.body);
        if (reorder) return reorder(options.body);
        return view({ ...views[0], rev: options.body.rev + 1, order: options.body.order });
      }
      if (path === `/list-placeholders/${LIST}`) return views[Math.min(viewIndex++, views.length - 1)];
      throw new Error('unexpected ' + path);
    }
  });
  const page = h.document.querySelector('.itemDetailPage');
  const container = page.querySelector('.itemsContainer');
  const options = { draggable: '.listItem', disabled: false };
  container.sortable = { option: (k, v) => { if (v === undefined) return options[k]; options[k] = v; return undefined; } };
  let refreshes = 0;
  container.refreshItems = () => { refreshes++; return Promise.resolve(); };
  container.fetchData = () => Promise.resolve({ Items: [] });
  h.JE.initializeListPlaceholders();
  const ctrl = h.lp.playlist.attach(page, { Id: LIST, Name: 'Marathon', Type: 'Playlist' });
  await tick(); await tick();
  const order = () => [...container.children].map(el => el.classList.contains('listItem') ? 'e:' + el.getAttribute('data-id') : 'p:' + el.getAttribute('data-je-lp-id'));
  return { ...h, container, ctrl, reorders, order, refreshes: () => refreshes };
}

/** SortableJS `end` DOM event for `item`. */
function sortableEnd(h, item) {
  const evt = new h.window.CustomEvent('end', { bubbles: true, cancelable: true });
  evt.item = item;
  evt.newIndex = [...h.container.children].indexOf(item);
  h.container.dispatchEvent(evt);
}

test('F49: a newer view arriving during a placeholder drag waits until the drop is saved', async t => {
  const order1 = [`e:${ITEM_A}:0`, 'p:x', `e:${ITEM_B}:0`, `e:${ITEM_C}:0`];
  const v1 = view({ placeholders: [ph('x')], order: order1 });
  const h = await mountPlaylist(t, { views: [v1] });
  assert.deepEqual(h.order(), [`e:${ITEM_A}`, 'p:x', `e:${ITEM_B}`, `e:${ITEM_C}`]);
  const row = h.container.querySelector('.je-lp-row');
  // Pick-up, then a scheduled re-fetch answers with a newer revision (e.g. a status or metadata change).
  h.container.dispatchEvent(new h.window.CustomEvent('choose'));
  h.lp.api.publish(view({ rev: 2, placeholders: [ph('x', { title: 'Renamed' })], order: order1 }));
  assert.equal(row.isConnected, true, 'the row SortableJS is dragging stays in the list');
  assert.equal(h.refreshes(), 0);
  // Drop at the end.
  h.container.appendChild(row);
  h.container.dispatchEvent(new h.window.CustomEvent('unchoose'));
  sortableEnd(h, row);
  await until(() => h.reorders.length === 1);
  assert.deepEqual([...h.reorders[0].order], [`e:${ITEM_A}:0`, `e:${ITEM_B}:0`, `e:${ITEM_C}:0`, 'p:x']);
  await until(() => !h.ctrl.busy && !h.ctrl.suspended);
  await tick();
  // The newest view (the save's answer) is adopted once the drag and the save are over.
  assert.equal(h.ctrl.view.rev, 2);
  assert.deepEqual(h.order(), [`e:${ITEM_A}`, `e:${ITEM_B}`, `e:${ITEM_C}`, 'p:x']);
  assert.equal(h.ctrl.pendingView, null);
});

test('F49: a view published while the order save runs is applied after it, never during it', async t => {
  const order1 = [`e:${ITEM_A}:0`, 'p:x', `e:${ITEM_B}:0`, `e:${ITEM_C}:0`];
  const v1 = view({ placeholders: [ph('x')], order: order1 });
  const save = deferred();
  const h = await mountPlaylist(t, { views: [v1], reorder: () => save.promise });
  const row = h.container.querySelector('.je-lp-row');
  h.container.dispatchEvent(new h.window.CustomEvent('choose'));
  h.container.appendChild(row);
  h.container.dispatchEvent(new h.window.CustomEvent('unchoose'));
  sortableEnd(h, row);
  await until(() => h.reorders.length === 1);
  assert.equal(h.ctrl.busy, true);
  // A re-fetch lands mid-save with a revision whose order is the one before the drop.
  h.lp.api.publish(view({ rev: 2, placeholders: [ph('x', { title: 'Renamed' })], order: order1 }));
  assert.equal(row.isConnected, true);
  assert.deepEqual(h.order(), [`e:${ITEM_A}`, `e:${ITEM_B}`, `e:${ITEM_C}`, 'p:x'], 'the dropped order stays while it is being saved');
  const saved = [`e:${ITEM_A}:0`, `e:${ITEM_B}:0`, `e:${ITEM_C}:0`, 'p:x'];
  save.resolve(view({ rev: 3, placeholders: [ph('x', { title: 'Renamed' })], order: saved }));
  await until(() => !h.ctrl.busy && h.ctrl.view.rev === 3);
  assert.deepEqual(h.order(), [`e:${ITEM_A}`, `e:${ITEM_B}`, `e:${ITEM_C}`, 'p:x']);
  assert.equal(h.container.querySelector('.je-lp-row .je-lp-title').textContent, 'Renamed');
});

test('F49: a view held back during a drag is dropped on a user switch', async t => {
  const v1 = view({ placeholders: [ph('x')], order: [`e:${ITEM_A}:0`, 'p:x', `e:${ITEM_B}:0`, `e:${ITEM_C}:0`] });
  const h = await mountPlaylist(t, { views: [v1] });
  h.container.dispatchEvent(new h.window.CustomEvent('choose'));
  h.lp.api.publish(view({ rev: 2, placeholders: [ph('x')], order: v1.order }));
  h.switchUser();
  assert.equal(h.ctrl.pendingView, null);
});

test('F50: LibraryChanged follows a replaced ApiClient (server switch)', async t => {
  const h = setup(t);
  const log = [];
  /** A fake ApiClient whose subscribe records calls. */
  const client = name => ({
    getCurrentUserId: () => 'user-a', serverId: () => name,
    subscribe: (types, handler) => { log.push(['subscribe', name, types.join(), handler]); return () => log.push(['unsubscribe', name]); }
  });
  h.window.ApiClient = client('one');
  h.JE.initializeListPlaceholders();
  assert.deepEqual(log.map(e => e.slice(0, 3)), [['subscribe', 'one', 'LibraryChanged']]);
  // A user switch on the same client keeps the one subscription.
  h.switchUser();
  assert.equal(log.length, 1);
  // jellyfin-web 12.2 binds subscribe per ApiClient (ServerConnections apiclientcreated).
  h.window.ApiClient = client('two');
  h.switchUser();
  assert.deepEqual(log.slice(1).map(e => e.slice(0, 3)), [['unsubscribe', 'one'], ['subscribe', 'two', 'LibraryChanged']]);
  assert.equal(log[2][3], h.lp.onLibraryChanged);
  assert.equal(typeof h.lp.getLibraryUnsubscribe(), 'function');
});

test('F51: the view cache keeps only the most recently used lists', async t => {
  const id = n => n.toString(16).padStart(32, '0');
  const gets = [];
  const h = setup(t, { plugin: async (path) => { gets.push(path); return view({ listId: path.split('/').pop() }); } });
  for (let n = 1; n <= 60; n++) h.lp.api.publish(view({ listId: id(n), rev: 1 }));
  // The latest lists are reused within the window...
  await h.lp.api.getView(id(60), { maxAgeMs: 60000 });
  assert.equal(gets.length, 0);
  // ...the oldest ones were evicted, so they are read again.
  await h.lp.api.getView(id(1), { maxAgeMs: 60000 });
  assert.deepEqual(gets, [`/list-placeholders/${id(1)}`]);
  // A view just read is kept as recently used.
  await h.lp.api.getView(id(1), { maxAgeMs: 60000 });
  assert.equal(gets.length, 1);
});

/**
 * Loads collection-discovery.js alone with a captured one-shot render and stubbed collaborators.
 * @param {*} t
 * @param {{parts: Array<Object>, placeholderIds: number[]}} options
 */
function setupDiscovery(t, { parts, placeholderIds }) {
  let render = null;
  const JE = {
    pluginConfig: { ListPlaceholdersEnabled: true },
    discoveryBase: {
      createDiscovery: spec => { render = spec.renderOneShot; return { start() {} }; },
      idFromDetailUrl: () => null
    },
    discoveryFilter: {
      fetchWithManagedRequest: async () => ({ id: COLLECTION, name: 'Cars', tmdbId: '87118', type: 'BoxSet' }),
      createCardsFragment: results => {
        const fragment = document.createDocumentFragment();
        for (const r of results) { const card = document.createElement('div'); card.className = 'card'; card.dataset.tmdb = r.id; fragment.appendChild(card); }
        return fragment;
      }
    },
    helpers: { getItemCached: async () => ({ Id: COLLECTION, Type: 'BoxSet' }) },
    jellyseerrAPI: { checkUserStatus: async () => ({ active: true }), fetchCollectionDetails: async () => ({ parts }) },
    listPlaceholders: { getPlaceholderTmdbIds: async () => new Set(placeholderIds) }
  };
  const h = createHarness({ html: '<div class="detail"></div>', JE });
  const document = h.document;
  t.after(() => h.close());
  h.load('jellyseerr/discovery/collection-discovery.js');
  const run = () => render({ id: COLLECTION, signal: new AbortController().signal, waitForPageReady: async () => document.querySelector('.detail') });
  return { ...h, run };
}

const movie = (id, status) => ({ id, title: `Movie ${id}`, releaseDate: `2000-01-0${id}`, mediaInfo: status ? { status } : undefined });

test('F43: "Missing from" counts placeholder-only titles as missing, not available', async t => {
  // 1 available, 2 missing, 2 more missing that are already placeholders of this collection.
  const h = setupDiscovery(t, { parts: [movie(1, 5), movie(2), movie(3, 2), movie(4), movie(5)], placeholderIds: [4, 5] });
  assert.equal(await h.run(), true);
  const section = h.document.querySelector('.jellyseerr-collection-discovery-section');
  assert.equal(section.querySelector('.sectionTitle').textContent, 'Missing from Cars (1/5)');
  assert.deepEqual([...section.querySelectorAll('.card')].map(c => c.dataset.tmdb), ['2', '3']);
});

test('F43: a collection whose missing titles are all placeholders shows no section', async t => {
  const h = setupDiscovery(t, { parts: [movie(1, 5), movie(2)], placeholderIds: [2] });
  assert.equal(await h.run(), undefined);
  assert.equal(h.document.querySelector('.jellyseerr-collection-discovery-section'), null);
});
