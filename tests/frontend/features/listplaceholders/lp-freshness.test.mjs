// Phase 3 client: fill progress, "Available — adding…", freshness after server-side swaps (B3),
// "Link to a title" and adds whose answer already contains library items.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, ph, view, playlistPage, tick, LIST, COLLECTION, ITEM_A, ITEM_B, ITEM_C } from './lp-harness.mjs';

const PLAYLIST = { Id: LIST, Name: 'Marathon', Type: 'Playlist' };
const BOXSET = { Id: COLLECTION, Name: 'Cars Collection', Type: 'BoxSet' };
const COLLECTION_PAGE = '<div class="itemDetailPage page"><div class="detailSection"><div class="collectionItems"><div class="verticalSection"><div class="itemsContainer collectionItemsContainer"></div></div></div></div></div>';
const dashed = id => id.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
const until = async (fn, tries = 50) => { for (let i = 0; i < tries; i++) { const v = fn(); if (v) return v; await tick(); } throw new Error('timeout'); };

/**
 * Replaces the page's timers with a manual queue (node's own timers keep driving tick()).
 * @returns {{delays: function(): number[], fire: function(number): Promise<number>}}
 */
function fakeTimers(h) {
  const queue = new Map();
  let next = 1;
  h.window.setTimeout = (fn, ms = 0) => { const id = next++; queue.set(id, { fn, ms }); return id; };
  h.window.clearTimeout = (id) => { queue.delete(id); };
  return {
    delays: () => [...queue.values()].map(timer => timer.ms).sort((a, b) => a - b),
    async fire(ms) {
      const due = [...queue.entries()].filter(([, timer]) => timer.ms === ms);
      for (const [id, timer] of due) { queue.delete(id); timer.fn(); }
      await tick(); await tick(); await tick();
      return due.length;
    }
  };
}

/** A playlist page with a controller; GETs answer from `views` in turn (the last one repeats). */
async function mountPlaylist(t, views, { ids = [ITEM_A, ITEM_B], fake = true, plugin, jellyseerrAPI } = {}) {
  let index = 0;
  const h = setup(t, {
    html: playlistPage(ids),
    jellyseerrAPI,
    plugin: async (path, options = {}) => {
      if (path === `/list-placeholders/${LIST}` && !options.method) return views[Math.min(index++, views.length - 1)];
      if (plugin) return plugin(path, options);
      throw new Error('unexpected ' + path);
    }
  });
  h.window.ApiClient.subscribe = (types, fn) => { h.JE.__library = fn; return () => {}; };
  const timers = fake ? fakeTimers(h) : null;
  const page = h.document.querySelector('.itemDetailPage');
  const container = page.querySelector('.itemsContainer');
  let refreshes = 0;
  // jellyfin-web re-renders its rows and calls afterRefresh (rows themselves stay as they are here)
  container.refreshItems = () => { refreshes++; container.afterRefresh?.({ Items: [] }); return Promise.resolve(); };
  container.fetchData = () => Promise.resolve({ Items: [] });
  h.JE.initializeListPlaceholders();
  const ctrl = h.lp.playlist.attach(page, PLAYLIST);
  await tick(); await tick(); await tick();
  const gets = () => h.calls.filter(([path, options]) => path === `/list-placeholders/${LIST}` && !options.method).length;
  return { ...h, page, container, ctrl, timers, gets, refreshes: () => refreshes, library: data => h.JE.__library({ MessageType: 'LibraryChanged', Data: data }) };
}

/** A collection page with a controller; GETs answer `current` (setView changes it). */
async function mountCollection(t, placeholders, { plugin } = {}) {
  let current = view({ listId: COLLECTION, listKind: 'collection', order: null, placeholders });
  let doc;
  const h = setup(t, {
    html: COLLECTION_PAGE,
    plugin: async (path, options = {}) => {
      if (!options.method) return current;
      return plugin(path, options);
    },
    jellyseerrUI: {
      createJellyseerrCard: (item) => {
        const card = doc.createElement('div');
        card.className = 'card overflowPortraitCard jellyseerr-card';
        card.innerHTML = '<div class="cardBox"><div class="cardScalable"><div class="cardImageContainer"></div></div><div class="jellyseerr-meta"><bdi>y</bdi></div></div>';
        card.__item = item;
        return card;
      }
    }
  });
  doc = h.document;
  h.window.ApiClient.subscribe = (types, fn) => { h.JE.__library = fn; return () => {}; };
  const page = h.document.querySelector('.itemDetailPage');
  let nativeRefreshes = 0;
  page.querySelector('.collectionItemsContainer').notifyRefreshNeeded = () => { nativeRefreshes++; };
  h.JE.initializeListPlaceholders();
  const ctrl = h.lp.collection.attach(page, BOXSET);
  await tick(); await tick(); await tick();
  const card = id => page.querySelector(`.je-lp-card[data-je-lp-id="${id}"]`);
  return { ...h, page, ctrl, card, nativeRefreshes: () => nativeRefreshes, setView(v) { current = v; } };
}

test('progress labels: "n of m aired" with upcoming episodes, episode fills, and the count before metadata', t => {
  const h = setup(t);
  const r = h.lp.render;
  const parts = value => [...r.progressParts(value)];
  const season = extra => ph('s', { kind: 'season', mediaType: 'tv', seasonNumber: 1, ...extra });
  assert.deepEqual(parts(season({ expectedCount: 8, airedCount: 6, filledCount: 3 })),
    ['listPlaceholders_progress_aired{"filled":3,"aired":6}', 'listPlaceholders_progress_upcoming{"count":2}']);
  assert.deepEqual(parts(season({ expectedCount: 8, airedCount: 8, filledCount: 0 })), ['listPlaceholders_progress_aired{"filled":0,"aired":8}']);
  assert.deepEqual(parts(season({ expectedCount: 8, airedCount: 0, filledCount: 0 })), ['listPlaceholders_progress_upcoming{"count":8}'], 'nothing aired yet');
  assert.deepEqual(parts({ ...season({ expectedCount: 184, airedCount: 184, filledCount: 3 }), kind: 'series', seasonNumber: null }),
    ['listPlaceholders_progress_aired{"filled":3,"aired":184}']);
  // expected set not known yet: the creation-time episode count, or what is in the list
  assert.deepEqual(parts(season({ expectedCount: 0, episodeTotal: 10, filledCount: 0 })), ['listPlaceholders_episode_count{"count":10}']);
  assert.deepEqual(parts(season({ expectedCount: 0, filledCount: 2 })), ['listPlaceholders_progress_in_list{"count":2}']);
  // episodes placeholders only show progress once some of the listed episodes are in
  const episodes = extra => ph('e', { kind: 'episodes', mediaType: 'tv', seasonNumber: 1, episodes: [{ s: 1, e: 8 }, { s: 1, e: 9 }, { s: 1, e: 11 }], expectedCount: 3, ...extra });
  assert.deepEqual(parts(episodes({ filledCount: 0 })), []);
  assert.deepEqual(parts(episodes({ filledCount: 2 })), ['listPlaceholders_episodes_of{"filled":2,"total":3}']);
  assert.deepEqual(parts(ph('m', { expectedCount: 0, filledCount: 0 })), [], 'movies have none');
  // garbage counts are ignored
  assert.deepEqual(parts(season({ expectedCount: -1, airedCount: 'x', filledCount: null })), []);
  // the row subtitle carries the progress between the kind and the date
  assert.deepEqual([...r.subtitleParts(season({ expectedCount: 8, airedCount: 6, filledCount: 3, releaseDate: '2022-01-13' }))],
    ['jellyseerr_season_name{"number":1}', 'listPlaceholders_progress_aired{"filled":3,"aired":6}', 'listPlaceholders_progress_upcoming{"count":2}', '2022']);
});

test('"Available — adding…" replaces the request button with a link to the library item (rows and cards)', t => {
  const h = setup(t, { jellyseerrUI: { createJellyseerrCard: (item) => { const c = h.document.createElement('div'); c.innerHTML = '<div class="cardBox"><div class="cardScalable"><div class="cardImageContainer"></div></div><div class="jellyseerr-meta"></div></div>'; c.__item = item; return c; } } });
  const r = h.lp.render;
  const ctx = { seerrEnabled: true, statusReady: true, user: { active: true, userFound: true } };
  const adding = ph('a', { status: 1, inLibraryItemId: dashed(ITEM_C).toUpperCase() });
  const holder = h.document.createElement('div');
  holder.innerHTML = r.statusHtml(adding, ctx);
  const link = holder.querySelector('a.je-lp-adding');
  assert.ok(link);
  assert.equal(link.getAttribute('href'), `#/details?id=${ITEM_C}`, 'normalised N-form id');
  assert.match(link.textContent, /listPlaceholders_available_adding/);
  assert.equal(holder.querySelector('.je-lp-request'), null, 'nothing to request');
  // independent of Seerr (swap-in works without it)
  assert.match(r.statusHtml(adding, { ...ctx, seerrEnabled: false }), /je-lp-adding/);
  // anything that isn't a GUID is ignored (and never reaches the markup)
  const bogus = ph('b', { status: 1, inLibraryItemId: '"><img src=x onerror=alert(1)>' });
  assert.doesNotMatch(r.statusHtml(bogus, ctx), /je-lp-adding|onerror/);
  assert.match(r.statusHtml(bogus, ctx), /je-lp-request/);
  // cards: the Seerr card reads as available with the library item, and a chip says what is happening
  const item = r.toSeerrItem(adding);
  assert.deepEqual(JSON.parse(JSON.stringify(item.mediaInfo)), { status: 5, status4k: 1, jellyfinMediaId: ITEM_C });
  const card = r.buildCard(adding, { seerrEnabled: true, user: ctx.user });
  assert.match(card.querySelector('.je-lp-progress-chip.je-lp-adding').textContent, /listPlaceholders_available_adding/);
  const progress = r.buildCard(ph('s', { kind: 'season', mediaType: 'tv', seasonNumber: 1, expectedCount: 8, airedCount: 8, filledCount: 2 }), { seerrEnabled: true, user: ctx.user });
  assert.equal(progress.querySelector('.je-lp-progress-chip').textContent, 'listPlaceholders_progress_aired{"filled":2,"aired":8}');
  assert.equal(progress.querySelector('.je-lp-kind-chip').textContent, 'jellyseerr_season_name{"number":1}');
  assert.equal(r.buildCard(ph('m'), { seerrEnabled: true, user: ctx.user }).querySelector('.je-lp-progress-chip'), null);
});

test('playlist: a placeholder being swapped in is looked at again 3 s later, once; the swapped view reloads the rows', async t => {
  const adding = view({ placeholders: [ph('x', { status: 1, inLibraryItemId: dashed(ITEM_C) })], order: [`e:${ITEM_A}:0`, 'p:x', `e:${ITEM_B}:0`] });
  const swapped = view({ rev: 2, placeholders: [], order: [`e:${ITEM_A}:0`, `e:${ITEM_C}:0`, `e:${ITEM_B}:0`] });
  const h = await mountPlaylist(t, [adding, adding, swapped]);
  const row = h.container.querySelector('.je-lp-row');
  assert.equal(row.querySelector('.je-lp-adding').getAttribute('href'), `#/details?id=${ITEM_C}`);
  assert.equal(row.querySelector('.je-lp-request'), null);
  assert.ok(h.timers.delays().includes(3000));
  assert.equal(h.gets(), 1);
  // still adding (Jellyfin slow, or a failed swap waiting for its retry): no polling
  await h.timers.fire(3000);
  assert.equal(h.gets(), 2);
  assert.equal(h.timers.delays().includes(3000), false);
  // the swap went through: LibraryChanged names the playlist → re-GET → jellyfin-web rows reloaded once
  h.library({ ItemsUpdated: [dashed(LIST)] });
  await h.timers.fire(1000);
  assert.equal(h.gets(), 3);
  assert.equal(h.ctrl.view.rev, 2);
  assert.equal(h.refreshes(), 1);
  assert.equal(h.container.querySelector('.je-lp-row'), null);
});

test('LibraryChanged: an updated library item re-fetches shown lists with matchable placeholders after 3 s, not custom-only ones', async t => {
  const season = ph('s', { kind: 'season', mediaType: 'tv', seasonNumber: 1, filledCount: 3, expectedCount: 8, airedCount: 8 });
  const filled = view({ rev: 2, placeholders: [{ ...season, filledCount: 4 }], order: [`e:${ITEM_A}:0`, 'p:s'] });
  const h = await mountPlaylist(t, [view({ placeholders: [season], order: [`e:${ITEM_A}:0`, 'p:s'] }), filled]);
  // an existing episode file was re-identified as S01E04 (ItemUpdated only): the server filled the season
  h.library({ ItemsUpdated: ['11111111111111111111111111111111'] });
  assert.deepEqual(h.timers.delays(), [3000]);
  await h.timers.fire(3000);
  assert.equal(h.gets(), 2);
  assert.equal(h.ctrl.view.rev, 2);
  assert.match(h.container.querySelector('.je-lp-row .je-lp-sub').textContent, /"filled":4/);

  const custom = await mountPlaylist(t, [view({ placeholders: [ph('c', { kind: 'custom', tmdbId: null })], order: [`e:${ITEM_A}:0`, 'p:c'] })]);
  custom.library({ ItemsUpdated: ['11111111111111111111111111111111'] });
  assert.deepEqual(custom.timers.delays(), [], 'nothing in the library can fill a custom entry');
});

test('LibraryChanged: the list itself re-fetches after 1 s, new library items re-fetch lists with placeholders after 3 s', async t => {
  const v = view({ placeholders: [ph('x', { kind: 'custom', tmdbId: null })], order: [`e:${ITEM_A}:0`, 'p:x'] });
  const h = await mountPlaylist(t, [v]);
  h.library({ ItemsUpdated: ['11111111111111111111111111111111'] });
  assert.deepEqual(h.timers.delays(), [], 'an unrelated update');
  h.library({ ItemsAdded: ['11111111111111111111111111111111'], ItemsUpdated: [] });
  assert.deepEqual(h.timers.delays(), [3000], 'an arrival may have been swapped into a placeholder');
  h.library({ ItemsUpdated: [dashed(LIST)] });
  assert.deepEqual(h.timers.delays(), [1000], 'the earlier re-fetch replaces the later one');
  h.library({ ItemsAdded: ['22222222222222222222222222222222'] });
  assert.deepEqual(h.timers.delays(), [1000], 'a pending earlier re-fetch is kept');
  await h.timers.fire(1000);
  assert.equal(h.gets(), 2);
  // a page jellyfin-web keeps hidden doesn't fetch; it does on viewshow
  h.page.classList.add('hide');
  h.library({ ItemsUpdated: [LIST], ItemsAdded: ['22222222222222222222222222222222'] });
  assert.deepEqual(h.timers.delays(), []);
  await h.ctrl.load();
  assert.equal(h.gets(), 2);
});

test('LibraryChanged: lists without placeholders only react to their own id; answers for a page left meanwhile are dropped', async t => {
  let release;
  const empty = view({ placeholders: [], order: [`e:${ITEM_A}:0`] });
  const later = view({ rev: 5, placeholders: [ph('n')], order: [`e:${ITEM_A}:0`, 'p:n'] });
  const h = await mountPlaylist(t, [empty, new Promise(resolve => { release = resolve; }), later]);
  h.library({ ItemsAdded: ['11111111111111111111111111111111'] });
  assert.deepEqual(h.timers.delays(), []);
  h.library({ ItemsUpdated: [LIST] });
  assert.deepEqual(h.timers.delays(), [1000]);
  await h.timers.fire(1000);
  assert.equal(h.gets(), 2);
  // the user navigates away while the GET runs: the answer is not applied to the hidden page
  h.page.classList.add('hide');
  release(later);
  await tick(); await tick();
  assert.equal(h.ctrl.view.rev, 1);
  assert.equal(h.container.querySelector('.je-lp-row'), null);
  // shown again (viewshow) → fetched and applied
  h.page.classList.remove('hide');
  h.JE.__items = { [LIST]: PLAYLIST };
  await h.lp.onViewShow(h.page, `#/details?id=${LIST}`);
  await until(() => h.ctrl.view.rev === 5);
  assert.equal(h.container.querySelectorAll('.je-lp-row').length, 1);
});

test('collection: swaps reload Jellyfin\'s cards and update progress; removals here don\'t; adding state rebuilds the card', async t => {
  const season = extra => ph('s', { kind: 'season', mediaType: 'tv', tmdbId: 110492, seasonNumber: 1, expectedCount: 8, airedCount: 8, ...extra });
  const h = await mountCollection(t, [ph('m', { tmdbId: 7 }), season({ filledCount: 1 })], {
    plugin: async (path, options) => {
      assert.equal(options.method, 'DELETE');
      return view({ listId: COLLECTION, listKind: 'collection', rev: 4, order: null, placeholders: [] });
    }
  });
  h.window.ApiClient.subscribe = () => () => {};
  assert.match(h.card('s').querySelector('.je-lp-progress-chip').textContent, /"filled":1/);
  assert.equal(h.nativeRefreshes(), 0);
  // the movie arrived (placeholder gone) and episode 2 filled the season: Jellyfin's cards reload once
  h.setView(view({ listId: COLLECTION, listKind: 'collection', rev: 2, order: null, placeholders: [season({ filledCount: 2 })] }));
  await h.ctrl.load();
  assert.equal(h.nativeRefreshes(), 1);
  assert.match(h.card('s').querySelector('.je-lp-progress-chip').textContent, /"filled":2/);
  assert.equal(h.card('m'), null);
  // same revision again: nothing
  await h.ctrl.load();
  assert.equal(h.nativeRefreshes(), 1);
  // a later episode of a season only changes the progress (its Season item is already in the collection)
  h.setView(view({ listId: COLLECTION, listKind: 'collection', rev: 3, order: null, placeholders: [season({ filledCount: 3 })] }));
  await h.ctrl.load();
  assert.equal(h.nativeRefreshes(), 1);
  assert.match(h.card('s').querySelector('.je-lp-progress-chip').textContent, /"filled":3/);
  // the first episode of a season (Season item added) and every episode of an episodes placeholder do reload
  assert.equal(h.ctrl.swappedSince({ rev: 1, placeholders: [season({ filledCount: 0 })] }, { rev: 2, placeholders: [season({ filledCount: 1 })] }), true);
  const eps = filled => ph('e', { kind: 'episodes', mediaType: 'tv', seasonNumber: 1, filledCount: filled });
  assert.equal(h.ctrl.swappedSince({ rev: 1, placeholders: [eps(1)] }, { rev: 2, placeholders: [eps(2)] }), true);
  assert.equal(h.ctrl.swappedSince({ rev: 2, placeholders: [eps(1)] }, { rev: 2, placeholders: [eps(2)] }), false, 'same revision');
  // a match is being added (no new revision): the card is rebuilt as available and looked at again later
  const before = h.card('s');
  h.setView(view({ listId: COLLECTION, listKind: 'collection', rev: 3, order: null, placeholders: [season({ filledCount: 3, inLibraryItemId: ITEM_C })] }));
  await h.ctrl.load();
  assert.notEqual(h.card('s'), before);
  assert.equal(h.card('s').__item.mediaInfo.jellyfinMediaId, ITEM_C);
  assert.ok(h.card('s').querySelector('.je-lp-progress-chip.je-lp-adding'));
  assert.equal(h.nativeRefreshes(), 1, 'no swap yet');
  // removing the placeholder on this page is not a swap
  await h.lp.actions.remove(h.ctrl, h.ctrl.byId('s'));
  assert.equal(h.ctrl.view.rev, 4);
  assert.equal(h.nativeRefreshes(), 1);
});

test('collection: a removal that loses the race against a swap still reloads Jellyfin\'s cards', async t => {
  const swapped = view({ listId: COLLECTION, listKind: 'collection', rev: 2, order: null, placeholders: [] });
  const h = await mountCollection(t, [ph('m', { tmdbId: 7 })], {
    plugin: async (path, options) => {
      assert.equal(options.method, 'DELETE');
      throw Object.assign(new Error('HTTP 409'), { status: 409, responseJSON: { code: 'rev_conflict', message: 'The list changed; reload it.', view: swapped } });
    }
  });
  h.window.ApiClient.subscribe = () => () => {};
  assert.equal(h.nativeRefreshes(), 0);
  await h.lp.actions.remove(h.ctrl, h.ctrl.byId('m'));
  assert.equal(h.ctrl.view.rev, 2);
  assert.equal(h.card('m'), null);
  assert.equal(h.nativeRefreshes(), 1, 'the movie went in: its native card is loaded');
  assert.equal(h.ctrl.removedHere.size, 0);
});

test('collection: new library items re-fetch it after 3 s and its own id after 1 s', async t => {
  const h = await mountCollection(t, [ph('m', { tmdbId: 7 })]);
  const timers = fakeTimers(h);
  h.JE.__library?.({ MessageType: 'LibraryChanged', Data: { ItemsAdded: ['11111111111111111111111111111111'] } });
  assert.deepEqual(timers.delays(), [3000]);
  h.JE.__library?.({ MessageType: 'LibraryChanged', Data: { ItemsUpdated: [dashed(COLLECTION)] } });
  assert.deepEqual(timers.delays(), [1000]);
  const before = h.calls.length;
  await timers.fire(1000);
  assert.equal(h.calls.length, before + 1);
});

test('Link to a title: starts from the entry\'s title, PATCHes the pick, and an in-library title reloads the rows', async t => {
  const searches = [];
  const patches = [];
  const custom = ph('c', { kind: 'custom', mediaType: 'movie', tmdbId: null, title: 'Toy Story 3' });
  const first = view({ placeholders: [custom], order: [`e:${ITEM_A}:0`, 'p:c', `e:${ITEM_B}:0`] });
  const linked = view({ rev: 2, placeholders: [], order: [`e:${ITEM_A}:0`, `e:${ITEM_C}:0`, `e:${ITEM_B}:0`] });
  const h = await mountPlaylist(t, [first], {
    fake: false,
    jellyseerrAPI: { search: async (query) => { searches.push(query); return { results: [{ id: 10193, mediaType: 'movie', title: 'Toy Story 3', releaseDate: '2010-06-16', posterPath: '/ts3.jpg' }] }; } },
    plugin: async (path, options) => { patches.push([path, options.method, JSON.parse(JSON.stringify(options.body))]); return linked; }
  });
  h.load('jellyseerr/modal.js');
  const modal = h.lp.search.open(h.ctrl, { mode: 'link', placeholder: h.ctrl.byId('c') });
  const root = modal.modalElement;
  assert.equal(root.querySelector('.je-lp-query').value, 'Toy Story 3');
  (await until(() => root.querySelector('.je-lp-result'))).click();
  assert.deepEqual(searches, ['Toy Story 3']);
  root.querySelector('.jellyseerr-modal-button-primary').click();
  await until(() => patches.length);
  assert.equal(patches[0][0], `/list-placeholders/${LIST}/items/c`);
  assert.equal(patches[0][1], 'PATCH');
  assert.equal(patches[0][2].rev, 1);
  assert.deepEqual(patches[0][2].link, { mediaType: 'movie', tmdbId: 10193, title: 'Toy Story 3', releaseDate: '2010-06-16', year: 2010, posterPath: '/ts3.jpg', kind: 'movie' });
  await until(() => h.toasts.length);
  assert.match(h.toasts.at(-1), /listPlaceholders_linked_in_library/);
  assert.equal(h.ctrl.view.rev, 2);
  assert.equal(h.refreshes(), 1, 'jellyfin-web rows reloaded from the answer');
  assert.equal(h.container.querySelector('.je-lp-row'), null);
  // still a placeholder (not in the library): the plain message
  assert.equal(h.lp.search.linkedIntoLibrary(view({ placeholders: [ph('c', { kind: 'movie' })] }), 'c'), false);
  assert.equal(h.lp.search.linkedIntoLibrary(view({ placeholders: [ph('c', { kind: 'season', filledCount: 2 })] }), 'c'), true);
});

test('collection: linking a custom entry to a title in the library reloads Jellyfin\'s cards', async t => {
  const h = await mountCollection(t, [ph('c', { kind: 'custom', tmdbId: null })], {
    plugin: async () => view({ listId: COLLECTION, listKind: 'collection', rev: 2, order: null, placeholders: [] })
  });
  await h.lp.api.patchPlaceholder(COLLECTION, 'c', { rev: 1, link: { kind: 'movie', mediaType: 'movie', tmdbId: 10193, title: 'Toy Story 3' } });
  assert.equal(h.nativeRefreshes(), 1);
  assert.equal(h.card('c'), null);
});

test('Add title: a season partly in the library sends kind season / episodes S1E8, reloads the rows once and says so', async t => {
  const posts = [];
  const first = view({ placeholders: [], order: [`e:${ITEM_A}:0`] });
  const after = view({ rev: 2, placeholders: [ph('n', { kind: 'season', mediaType: 'tv', tmdbId: 60735, seasonNumber: 1, filledCount: 1 })], order: [`e:${ITEM_A}:0`, `e:${ITEM_B}:0`, 'p:n'] });
  const h = await mountPlaylist(t, [first], {
    ids: [ITEM_A],
    fake: false,
    jellyseerrAPI: {
      search: async () => ({ results: [{ id: 60735, mediaType: 'tv', name: 'The Flash', firstAirDate: '2014-10-07' }] }),
      fetchTvShowDetails: async () => ({ id: 60735, name: 'The Flash', seasons: [{ seasonNumber: 1, episodeCount: 23, airDate: '2014-10-07' }] }),
      fetchTvSeasonDetails: async () => ({ episodes: [{ episodeNumber: 8, name: 'Flash vs. Arrow', airDate: '2014-12-02' }] })
    },
    plugin: async (path, options) => { posts.push(JSON.parse(JSON.stringify(options.body))); return { added: ['n'], addedAsItems: [ITEM_B], skipped: [], view: after }; }
  });
  h.load('jellyseerr/modal.js');
  /** Opens Add title, picks The Flash and a granularity mode, submits. */
  const add = async (mode) => {
    const root = h.lp.search.open(h.ctrl).modalElement;
    root.querySelector('.je-lp-query').value = 'flash';
    root.querySelector('.je-lp-query').dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Enter' }));
    (await until(() => root.querySelector('.je-lp-result'))).click();
    await until(() => root.querySelector('.je-lp-granularity select option'));
    const radio = root.querySelector(`.je-lp-granularity input[value="${mode}"]`);
    radio.checked = true;
    radio.dispatchEvent(new h.window.Event('change', { bubbles: true }));
    if (mode === 'episodes') (await until(() => root.querySelector('.je-lp-episode input[value="8"]'))).checked = true;
    root.querySelector('.jellyseerr-modal-button-primary').click();
    await until(() => posts.length && h.toasts.length);
  };
  await add('season');
  assert.equal(posts[0].placeholders[0].kind, 'season');
  assert.equal(posts[0].placeholders[0].seasonNumber, 1);
  assert.match(h.toasts.at(-1), /listPlaceholders_added_partly/);
  assert.equal(h.refreshes(), 1, 'the published view and afterRealItemsAdded reload the rows only once');
  posts.length = 0;
  h.toasts.length = 0;
  await add('episodes');
  assert.equal(posts[0].placeholders[0].kind, 'episodes');
  assert.deepEqual(posts[0].placeholders[0].episodes, [{ s: 1, e: 8, title: 'Flash vs. Arrow', airDate: '2014-12-02' }]);
  assert.equal(h.refreshes(), 1, 'same revision: no second reload');
});

test('picker: a partly present TV scope says so and reloads an open page of that list', async t => {
  const v = view({ placeholders: [ph('x')], order: [`e:${ITEM_A}:0`, 'p:x'] });
  const h = await mountPlaylist(t, [v], { fake: false });
  h.lp.picker.reportPicked({ added: ['n'], addedAsItems: [ITEM_B] }, LIST, 'Marathon');
  assert.match(h.toasts.at(-1), /listPlaceholders_picked_partly/);
  assert.match(h.toasts.at(-1), new RegExp(`#/details\\?id=${LIST}`));
  // afterRealItemsAdded on the open page reloads once per revision
  h.ctrl.afterRealItemsAdded();
  h.ctrl.afterRealItemsAdded();
  assert.equal(h.refreshes(), 1);
});
