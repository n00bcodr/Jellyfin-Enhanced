import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, ph, view, tick, LIST, COLLECTION } from './lp-harness.mjs';

const TV_DETAILS = {
  id: 60735, name: 'The Flash', firstAirDate: '2014-10-07', posterPath: '/flash.jpg', externalIds: { tvdbId: 279121 },
  seasons: [{ seasonNumber: 0, episodeCount: 5, airDate: '2014-01-01' }, { seasonNumber: 1, episodeCount: 23, airDate: '2014-10-07' }, { seasonNumber: 2, episodeCount: 0 }]
};
const SEASON_1 = { episodes: [{ episodeNumber: 8, name: 'Flash vs. Arrow', airDate: '2014-12-02' }, { episodeNumber: 9, name: 'Yellow Suit', airDate: '2014-12-09' }] };

function setupModals(t, { plugin, search, config } = {}) {
  const h = setup(t, {
    config,
    plugin: plugin || (async () => ({})),
    jellyseerrAPI: {
      search: search || (async () => ({ results: [] })),
      fetchTvShowDetails: async () => TV_DETAILS,
      fetchTvSeasonDetails: async () => SEASON_1
    }
  });
  h.load('jellyseerr/modal.js');
  return h;
}

const until = async (fn, tries = 50) => { for (let i = 0; i < tries; i++) { const v = fn(); if (v) return v; await tick(); } throw new Error('timeout'); };

test('the card action is offered for movies and shows only, never on placeholder cards or when off', t => {
  const h = setupModals(t);
  const doc = h.document;
  const card = () => { const c = doc.createElement('div'); c.innerHTML = '<div class="cardBox"><div class="jellyseerr-meta"></div></div>'; return c; };
  const cases = [
    [{ id: 1, mediaType: 'movie' }, true], [{ id: '2', mediaType: 'tv' }, true],
    [{ id: 3, mediaType: 'collection' }, false], [{ id: 4, mediaType: 'person' }, false],
    [{ id: 5, mediaType: 'movie', __jeLp: true }, false], [{ id: 'x', mediaType: 'movie' }, false]
  ];
  for (const [item, expected] of cases) {
    const c = card();
    h.JE.listPlaceholders.appendCardAction(c, item);
    assert.equal(!!c.querySelector('.je-lp-card-add'), expected, JSON.stringify(item));
  }
  const mount = doc.createElement('div');
  h.JE.listPlaceholders.appendModalAction(mount, { id: 7 }, 'tv');
  assert.ok(mount.querySelector('.je-lp-modal-add'));
  h.JE.listPlaceholders.appendModalAction(mount, { id: 8 }, 'collection');
  assert.equal(mount.querySelectorAll('.je-lp-modal-add').length, 1);
  h.JE.pluginConfig.ListPlaceholdersEnabled = false;
  const off = card();
  h.JE.listPlaceholders.appendCardAction(off, { id: 1, mediaType: 'movie' });
  assert.equal(off.querySelector('.je-lp-card-add'), null);
});

test('picker adds a movie to the chosen playlist at the start and links the list in the toast', async t => {
  const posts = [];
  const h = setupModals(t, { plugin: async (path, options = {}) => {
    if (path === '/list-placeholders/editable-lists') return { playlists: [{ id: LIST, name: 'Mine <i>', isOwn: true }, { id: 'f'.repeat(32), name: 'Theirs', isOwn: false, ownerName: 'bob' }], collections: [{ id: COLLECTION, name: 'Cars' }], canManageCollections: true };
    posts.push([path, options.body]);
    return { added: ['n'], addedAsItems: [], skipped: [], view: view() };
  } });
  const card = h.document.createElement('div');
  card.innerHTML = '<div class="cardBox"><div class="jellyseerr-meta"></div></div>';
  h.JE.listPlaceholders.appendCardAction(card, { id: 151960, mediaType: 'movie', title: 'Planes', releaseDate: '2013-08-09', posterPath: '/p.jpg', overview: 'o' });
  card.querySelector('.je-lp-card-add').click();
  const select = await until(() => h.document.querySelector('.je-lp-list-select'));
  assert.deepEqual([...select.options].map(o => o.textContent), ['Mine <i>', 'listPlaceholders_owned_by{"name":"Theirs","owner":"bob"}', 'Cars', 'listPlaceholders_new_playlist', 'listPlaceholders_import_picker_option']);
  h.document.querySelector('.je-lp-position-select').value = 'start';
  h.document.querySelector('.jellyseerr-modal-button-primary').click();
  await until(() => posts.length);
  assert.equal(posts[0][0], `/list-placeholders/${LIST}/items`);
  assert.deepEqual(JSON.parse(JSON.stringify(posts[0][1].placeholders)), [{ mediaType: 'movie', tmdbId: 151960, title: 'Planes', releaseDate: '2013-08-09', year: 2013, overview: 'o', posterPath: '/p.jpg', kind: 'movie' }]);
  assert.equal(posts[0][1].position.atStart, true);
  await until(() => h.toasts.length);
  assert.ok(h.toasts[0].includes('#/details?id=639da0c2a67ecc2670e96f200244c7e3'));
  assert.match(h.toasts[0], /Mine &lt;i&gt;/);
});

test('picker creates a new playlist with a TV season placeholder', async t => {
  const posts = [];
  const h = setupModals(t, { plugin: async (path, options = {}) => {
    if (path === '/list-placeholders/editable-lists') return { playlists: [], collections: [], canManageCollections: false };
    posts.push([path, options.body]);
    return { listId: 'a'.repeat(32), listKind: 'playlist', name: 'DC', result: { added: ['x'], addedAsItems: [], skipped: [], view: view({ listId: 'a'.repeat(32) }) } };
  } });
  const modal = await h.lp.picker.openPicker({ item: { id: 60735, name: 'The Flash' }, mediaType: 'tv' });
  const root = modal.modalElement;
  assert.equal(root.querySelector('.je-lp-list-select').value, '__new_playlist__');
  assert.equal(root.querySelector('.je-lp-new-playlist').hidden, false);
  await until(() => root.querySelector('.je-lp-granularity select option'));
  root.querySelector('.je-lp-granularity input[value="season"]').checked = true;
  root.querySelector('.je-lp-granularity input[value="season"]').dispatchEvent(new h.window.Event('change', { bubbles: true }));
  root.querySelector('.je-lp-new-name').value = '';
  root.querySelector('.jellyseerr-modal-button-primary').click();
  await tick();
  assert.equal(posts.length, 0, 'a name is required');
  root.querySelector('.je-lp-new-name').value = 'DC';
  root.querySelector('.jellyseerr-modal-button-primary').click();
  await until(() => posts.length);
  assert.equal(posts[0][0], '/list-placeholders/playlists');
  const body = JSON.parse(JSON.stringify(posts[0][1]));
  assert.equal(body.name, 'DC');
  assert.ok(body.requestId);
  assert.deepEqual(body.entries, [{ type: 'placeholder', placeholder: { mediaType: 'tv', tmdbId: 60735, title: 'The Flash', releaseDate: '2014-10-07', year: 2014, posterPath: '/flash.jpg', tvdbId: 279121, kind: 'season', seasonNumber: 1, episodeTotal: 23 } }]);
});

test('Add title: Seerr search (movies/shows only), position after a row, in-library title reported', async t => {
  const posts = [];
  let afterReal = 0;
  const h = setupModals(t, {
    search: async (query) => ({ results: [
      { id: 9, mediaType: 'person', name: 'Someone' },
      { id: 10, mediaType: 'collection', name: 'Coll' },
      { id: 862, mediaType: 'movie', title: '<b>Toy</b> Story', releaseDate: '1995-10-30', mediaInfo: { jellyfinMediaId: 'x', status: 5 } }
    ] }),
    plugin: async (path, options = {}) => { posts.push([path, options.body]); return { added: [], addedAsItems: ['x'], skipped: [], view: view() }; }
  });
  const ctrl = { listId: LIST, listKind: 'playlist', listName: 'Marathon', view: view(), positionOptions: () => [{ value: 'end', label: 'End' }, { value: 'e:abc:0', label: 'After: A' }], afterRealItemsAdded: () => afterReal++ };
  const modal = h.lp.search.open(ctrl);
  const root = modal.modalElement;
  const input = root.querySelector('.je-lp-query');
  input.value = 'toy';
  input.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Enter' }));
  await until(() => root.querySelector('.je-lp-result'));
  const results = root.querySelectorAll('.je-lp-result');
  assert.equal(results.length, 1);
  assert.equal(root.querySelector('.je-lp-result b'), null, 'escaped');
  assert.ok(root.querySelector('.je-lp-inlib'));
  root.querySelector('.jellyseerr-modal-button-primary').click();
  await tick();
  assert.equal(posts.length, 0);
  assert.match(h.toasts[0], /listPlaceholders_pick_result/);
  results[0].click();
  root.querySelector('.je-lp-position-select').value = 'e:abc:0';
  root.querySelector('.jellyseerr-modal-button-primary').click();
  await until(() => posts.length);
  const body = JSON.parse(JSON.stringify(posts[0][1]));
  assert.equal(body.placeholders[0].kind, 'movie');
  assert.equal(body.placeholders[0].tmdbId, 862);
  assert.deepEqual(body.position, { afterToken: 'e:abc:0' });
  await until(() => afterReal);
  assert.match(h.toasts.at(-1), /listPlaceholders_added_as_item/);
  assert.match(h.toasts.at(-1), /&lt;b&gt;Toy&lt;\/b&gt;/);
});

test('Add title: custom entries are validated before posting', async t => {
  const posts = [];
  const h = setupModals(t, { plugin: async (path, options = {}) => { posts.push(options.body); return { added: ['c'], addedAsItems: [], skipped: [], view: view({ listId: COLLECTION }) }; } });
  const modal = h.lp.search.open({ listId: COLLECTION, listKind: 'collection', listName: 'Cars', view: view() });
  const root = modal.modalElement;
  assert.equal(root.querySelector('.je-lp-position'), null, 'collections have no position');
  root.querySelector('.je-lp-tab[data-tab="custom"]').click();
  assert.equal(root.querySelector('[data-pane="custom"]').hidden, false);
  const save = () => root.querySelector('.jellyseerr-modal-button-primary').click();
  save(); await tick();
  assert.match(h.toasts.at(-1), /listPlaceholders_custom_title_required/);
  root.querySelector('.je-lp-custom-title').value = 'Clayface';
  root.querySelector('.je-lp-custom-year').value = '1700';
  save(); await tick();
  assert.match(h.toasts.at(-1), /listPlaceholders_custom_bad_year/);
  root.querySelector('.je-lp-custom-year').value = '';
  root.querySelector('.je-lp-custom-date').value = '2026-10-23';
  root.querySelector('.je-lp-custom-type').value = 'tv';
  root.querySelector('.je-lp-custom-note').value = 'DCU';
  save();
  await until(() => posts.length);
  assert.deepEqual(JSON.parse(JSON.stringify(posts[0].placeholders)), [{ kind: 'custom', mediaType: 'tv', title: 'Clayface', releaseDate: '2026-10-23', year: 2026, note: 'DCU' }]);
  assert.equal('position' in posts[0], false);
});

test('without Seerr the Add title modal offers only custom entries; link mode needs Seerr', t => {
  const h = setupModals(t, { config: { JellyseerrEnabled: false } });
  const modal = h.lp.search.open({ listId: LIST, listKind: 'playlist', view: view() });
  assert.equal(modal.modalElement.querySelector('.je-lp-tabs'), null);
  assert.equal(modal.modalElement.querySelector('[data-pane="search"]').hidden, true);
  assert.equal(modal.modalElement.querySelector('[data-pane="custom"]').hidden, false);
  assert.equal(h.lp.search.open({ listId: LIST, listKind: 'playlist', view: view() }, { mode: 'link', placeholder: ph('c', { kind: 'custom' }) }), null);
});

test('linking a custom entry PATCHes the TV granularity and retries a rev conflict once', async t => {
  const patches = [];
  const fresh = view({ rev: 4, placeholders: [ph('c', { kind: 'custom' })] });
  const h = setupModals(t, {
    search: async () => ({ results: [{ id: 60735, mediaType: 'tv', name: 'The Flash', firstAirDate: '2014-10-07' }] }),
    plugin: async (path, options = {}) => {
      patches.push([path, JSON.parse(JSON.stringify(options.body))]);
      if (patches.length === 1) throw Object.assign(new Error('HTTP 409'), { status: 409, responseJSON: { code: 'rev_conflict', view: fresh } });
      return fresh;
    }
  });
  const ctrl = { listId: LIST, listKind: 'playlist', view: view({ rev: 3, placeholders: [ph('c', { kind: 'custom' })] }) };
  const modal = h.lp.search.open(ctrl, { mode: 'link', placeholder: ph('c', { kind: 'custom', title: 'Flash ep' }) });
  const root = modal.modalElement;
  assert.equal(root.querySelector('[data-pane="custom"]'), null);
  root.querySelector('.je-lp-query').value = 'flash';
  root.querySelector('.je-lp-query').dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Enter' }));
  (await until(() => root.querySelector('.je-lp-result'))).click();
  await until(() => root.querySelector('.je-lp-granularity select option'));
  const episodes = root.querySelector('.je-lp-granularity input[value="episodes"]');
  episodes.checked = true;
  episodes.dispatchEvent(new h.window.Event('change', { bubbles: true }));
  root.querySelector('.jellyseerr-modal-button-primary').click();
  await tick();
  assert.equal(patches.length, 0, 'no episode ticked yet');
  (await until(() => root.querySelector('.je-lp-episode input[value="8"]'))).checked = true;
  root.querySelector('.jellyseerr-modal-button-primary').click();
  await until(() => patches.length === 2);
  assert.equal(patches[0][0], `/list-placeholders/${LIST}/items/c`);
  assert.equal(patches[0][1].rev, 3);
  assert.equal(patches[1][1].rev, 4);
  assert.deepEqual(patches[1][1].link, { mediaType: 'tv', tmdbId: 60735, title: 'The Flash', releaseDate: '2014-12-02', year: 2014, posterPath: '/flash.jpg', tvdbId: 279121, kind: 'episodes', seasonNumber: 1, episodes: [{ s: 1, e: 8, title: 'Flash vs. Arrow', airDate: '2014-12-02' }] });
});

test('granularity helpers: usable seasons and placeholders per kind', t => {
  const h = setupModals(t);
  const g = h.lp.granularity;
  assert.deepEqual(g.usableSeasons(TV_DETAILS).map(s => s.seasonNumber), [1, 0]);
  const media = { id: 60735, mediaType: 'tv', name: 'The Flash', firstAirDate: '2014-10-07', posterPath: '/bad path.jpg' };
  const series = JSON.parse(JSON.stringify(g.toPlaceholder(media, { kind: 'series' }, null)));
  assert.deepEqual(series, { mediaType: 'tv', tmdbId: 60735, title: 'The Flash', releaseDate: '2014-10-07', year: 2014, kind: 'series' });
  assert.equal(g.toPlaceholder(media, { kind: 'episodes', seasonNumber: 1, episodes: [] }, TV_DETAILS), null);
  assert.equal(g.toPlaceholder(media, null, TV_DETAILS), null, 'incomplete picker selection');
  assert.equal(g.toPlaceholder(media, undefined, null).kind, 'series', 'no picker: whole series');
  const movie = g.toPlaceholder({ id: '5', mediaType: 'movie', title: 'x'.repeat(250), releaseDate: '' }, null, null);
  assert.equal(movie.kind, 'movie');
  assert.equal(movie.title.length, 200);
  assert.equal(movie.releaseDate, null);
  assert.equal('year' in movie, false);
});

test('menu actions: remove retries a rev conflict once, then reports errors', async t => {
  let calls = 0;
  const fresh = view({ rev: 9, placeholders: [ph('x')] });
  const h = setupModals(t, { plugin: async (path, options = {}) => {
    calls++;
    if (calls === 1) throw Object.assign(new Error('HTTP 409'), { status: 409, responseJSON: { code: 'rev_conflict', view: fresh } });
    if (calls === 2) return view({ rev: 10 });
    throw Object.assign(new Error('HTTP 403'), { status: 403, responseJSON: { code: 'forbidden' } });
  } });
  const ctrl = { listId: LIST, listKind: 'playlist', view: view({ rev: 8, placeholders: [ph('x')] }) };
  await h.lp.actions.remove(ctrl, ph('x', { title: '<i>T</i>' }));
  assert.equal(calls, 2);
  assert.match(h.calls[1][0], /items\/x\?rev=9&requestId=/);
  assert.match(h.toasts.at(-1), /&lt;i&gt;T&lt;\/i&gt;/);
  await h.lp.actions.remove(ctrl, ph('x'));
  assert.equal(h.toasts.at(-1), 'listPlaceholders_err_forbidden');
  assert.deepEqual(h.lp.actions.shiftedOrder(['a', 'p:x', 'b'], 'p:x', 1), ['a', 'b', 'p:x']);
  assert.equal(h.lp.actions.shiftedOrder(['p:x'], 'p:x', -1), null);
});

test('granularity: season modes stay disabled until seasons load, and for good when loading fails', async t => {
  let resolveDetails;
  const h = setupModals(t);
  h.JE.jellyseerrAPI.fetchTvShowDetails = () => new Promise((resolve) => { resolveDetails = resolve; });
  const gran = h.lp.granularity.create({ tmdbId: 60735 });
  const radio = value => gran.element.querySelector(`input[value="${value}"]`);
  assert.equal(radio('season').disabled, true);
  assert.equal(radio('episodes').disabled, true);
  // even a forced choice can't turn the empty season list into season 0 (Specials)
  radio('season').checked = true;
  assert.equal(gran.getSelection(), null);
  resolveDetails(TV_DETAILS);
  await gran.ready;
  assert.equal(radio('season').disabled, false);
  assert.deepEqual(JSON.parse(JSON.stringify(gran.getSelection())), { kind: 'season', seasonNumber: Number(gran.element.querySelector('select').value) });

  h.JE.jellyseerrAPI.fetchTvShowDetails = async () => { throw new Error('offline'); };
  const failed = h.lp.granularity.create({ tmdbId: 60735 });
  await failed.ready;
  assert.equal(failed.element.querySelector('input[value="season"]').disabled, true);
  assert.equal(failed.element.querySelector('.je-lp-gran-status').textContent, 'listPlaceholders_err_generic');
  assert.deepEqual(JSON.parse(JSON.stringify(failed.getSelection())), { kind: 'series' });
});

test('picker: retrying a failed "New playlist" create reuses the request id (no second playlist)', async t => {
  const posts = [];
  const h = setupModals(t, { plugin: async (path, options = {}) => {
    if (path === '/list-placeholders/editable-lists') return { playlists: [], collections: [], canManageCollections: false };
    posts.push(JSON.parse(JSON.stringify(options.body)));
    if (posts.length === 1) throw Object.assign(new Error('HTTP 500'), { status: 500, responseJSON: { code: 'list_update_failed', listId: 'a'.repeat(32), listKind: 'playlist' } });
    return { listId: 'a'.repeat(32), listKind: 'playlist', name: 'DC', result: { added: ['x'], addedAsItems: [], skipped: [], view: view({ listId: 'a'.repeat(32) }) } };
  } });
  const modal = await h.lp.picker.openPicker({ item: { id: 862, title: 'Toy Story' }, mediaType: 'movie' });
  const root = modal.modalElement;
  root.querySelector('.je-lp-new-name').value = 'DC';
  root.querySelector('.jellyseerr-modal-button-primary').click();
  await until(() => posts.length === 1 && h.toasts.length);
  await until(() => !root.querySelector('.jellyseerr-modal-button-primary').disabled);
  root.querySelector('.jellyseerr-modal-button-primary').click();
  await until(() => posts.length === 2);
  assert.ok(posts[0].requestId);
  assert.equal(posts[1].requestId, posts[0].requestId);
});
