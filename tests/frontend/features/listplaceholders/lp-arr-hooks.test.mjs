// Phase 6 hooks: the admin "Add to Radarr/Sonarr" entry in placeholder menus (rows and
// collection cards) and the Radarr/Sonarr result group of the "Add title" modal.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, ph, view, tick, MODULES, LIST, COLLECTION } from './lp-harness.mjs';

const OPTIONS_MOVIE = {
  radarr: [{ id: 0, name: 'Radarr (lab)', key: '0123456789abcdef', qualityProfiles: [{ id: 4, name: 'HD-1080p' }], rootFolders: [{ path: '/movies', accessible: true }] }],
  sonarr: [], minimumAvailability: ['announced', 'inCinemas', 'released'], seriesTypes: ['standard', 'daily', 'anime']
};
const RADARR_HITS = {
  instance: { service: 'radarr', id: 0, name: 'Radarr <lab>' },
  results: [
    { mediaType: 'movie', tmdbId: 49521, imdbId: 'tt0770828', title: 'Man of <b>Steel</b>', year: 2013, releaseDate: '2013-06-14', posterPath: '/mos.jpg', inArr: true, arrId: 7 },
    { mediaType: 'movie', tmdbId: 209112, title: 'Batman v Superman', year: 2016, posterUrl: 'https://image.example/bvs.jpg', inArr: false }
  ]
};
const SONARR_HITS = {
  instance: { service: 'sonarr', id: 0, name: 'Sonarr (lab)' },
  results: [
    { mediaType: 'tv', tmdbId: 110492, tvdbId: 391153, title: 'Peacemaker', year: 2022, releaseDate: '2022-01-13', posterPath: '/pm.jpg', inArr: false },
    { mediaType: 'tv', tvdbId: 999001, title: 'Obscure Show', year: 1999, posterUrl: 'javascript:alert(1)', inArr: false }
  ]
};

const until = async (fn, tries = 200) => { for (let i = 0; i < tries; i++) { const v = fn(); if (v) return v; await new Promise(r => setTimeout(r, 5)); } throw new Error('timeout'); };

/**
 * List placeholders + Seerr modal + the arr module, as the bundle orders them.
 * @param {*} t
 * @param {{admin?: boolean, arrEnabled?: boolean, seerr?: boolean, plugin?: Function, search?: Function}} [options]
 */
function setupArr(t, { admin = true, arrEnabled = true, seerr = true, plugin, search } = {}) {
  const seerrSearches = [];
  const h = setup(t, {
    config: { ListPlaceholdersArrEnabled: arrEnabled, JellyseerrEnabled: seerr },
    extraJE: { currentSettings: { isAdmin: admin } },
    jellyseerrAPI: {
      search: async (query, page, options) => { seerrSearches.push(query); return search ? search(query, page, options) : { results: [] }; },
      fetchTvShowDetails: async () => ({ id: 110492, name: 'Peacemaker', seasons: [{ seasonNumber: 1, episodeCount: 8, airDate: '2022-01-13' }, { seasonNumber: 2, episodeCount: 8, airDate: '2025-08-21' }] }),
      fetchTvSeasonDetails: async () => ({ episodes: [] })
    },
    plugin: plugin || (async (path) => {
      if (path.startsWith('/list-placeholders/arr/lookup')) return new URLSearchParams(path.split('?')[1]).get('type') === 'tv' ? SONARR_HITS : RADARR_HITS;
      if (path.startsWith('/list-placeholders/arr/options')) return OPTIONS_MOVIE;
      return { added: ['n'], addedAsItems: [], skipped: [], view: view() };
    })
  });
  h.load('jellyseerr/modal.js');
  h.load('jellyseerr/listplaceholders/listplaceholders-arr.js');
  return { ...h, seerrSearches };
}

/** Labels of the open "…" menu. */
const menuLabels = (doc) => Array.from(doc.querySelectorAll('.je-lp-menu-item')).map(b => b.lastElementChild.textContent);
const arrCalls = (h) => h.calls.filter(([path]) => path.startsWith('/list-placeholders/arr/'));

/** Opens the Add title modal and runs a search for `query`. */
async function searchFor(h, ctrl, query) {
  const modal = h.lp.search.open(ctrl);
  const root = modal.modalElement;
  const input = root.querySelector('.je-lp-query');
  input.value = query;
  input.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Enter' }));
  return { modal, root };
}

test('arr results: Radarr and Sonarr hits interleave, at most 8 of each', t => {
  const h = setupArr(t);
  const movies = Array.from({ length: 12 }, (_, i) => ({ mediaType: 'movie', tmdbId: i + 1, title: `M${i}` }));
  const shows = Array.from({ length: 3 }, (_, i) => ({ mediaType: 'tv', tvdbId: i + 1, title: `S${i}` }));
  assert.deepEqual(Array.from(h.lp.search.mixArrResults(movies.concat(shows)), c => c.title),
    ['M0', 'S0', 'M1', 'S1', 'M2', 'S2', 'M3', 'M4', 'M5', 'M6', 'M7']);
  assert.equal(h.lp.search.mixArrResults(null).length, 0);
});

test('init.js and the arr module both merge into JE.listPlaceholders, in either load order', t => {
  const h = setup(t, { load: false, extraJE: { currentSettings: { isAdmin: true } } });
  h.load('jellyseerr/seerr-status.js');
  h.load('jellyseerr/modal.js');
  h.load('jellyseerr/listplaceholders/listplaceholders-arr.js');
  for (const file of MODULES) h.load(`jellyseerr/listplaceholders/${file}`);
  assert.equal(typeof h.JE.listPlaceholders.arr?.openAddDialog, 'function', 'init.js kept the arr API');
  assert.equal(typeof h.JE.listPlaceholders.openPicker, 'function');

  const h2 = setupArr(t);
  assert.equal(typeof h2.JE.listPlaceholders.arr?.menuItemFor, 'function');
  assert.equal(typeof h2.JE.listPlaceholders.getPlaceholderTmdbIds, 'function', 'arr module kept the facade');
});

test('placeholder menu: admins get "Add to Radarr/Sonarr" before Remove on rows and collection cards; it opens the arr dialog', async t => {
  const h = setupArr(t);
  const doc = h.document;
  const anchor = doc.createElement('button');
  doc.body.appendChild(anchor);
  const playlist = { listId: LIST, listKind: 'playlist', view: view({ placeholders: [ph('m')], order: ['p:m'] }), canDragPlaceholders: () => true };
  h.lp.actions.showPlaceholderMenu(playlist, ph('m', { title: 'Man of Steel', tmdbId: 49521 }), anchor);
  assert.deepEqual(menuLabels(doc).slice(-2), ['listPlaceholders_arr_menu_radarr', 'listPlaceholders_remove']);
  assert.equal(arrCalls(h).length, 0, 'opening the menu makes no arr call');
  Array.from(doc.querySelectorAll('.je-lp-menu-item')).find(b => b.lastElementChild.textContent === 'listPlaceholders_arr_menu_radarr').click();
  assert.equal(doc.querySelector('.je-lp-menu'), null, 'menu closed');
  await until(() => doc.querySelector('.je-lp-arr-dialog[data-service="radarr"]'));
  await until(() => arrCalls(h).some(([path]) => path === '/list-placeholders/arr/options?type=movie'));

  const collection = { listId: COLLECTION, listKind: 'collection', view: view({ listId: COLLECTION, listKind: 'collection' }) };
  const anchor2 = doc.createElement('button');
  doc.body.appendChild(anchor2);
  h.lp.actions.showPlaceholderMenu(collection, ph('s', { kind: 'season', mediaType: 'tv', tmdbId: 110492, seasonNumber: 2 }), anchor2);
  assert.ok(menuLabels(doc).includes('listPlaceholders_arr_menu_sonarr'));
  h.lp.actions.closeMenu();

  // Custom entries have no id an arr can use.
  h.lp.actions.showPlaceholderMenu(collection, ph('c', { kind: 'custom', tmdbId: null }), anchor2);
  assert.equal(menuLabels(doc).some(l => l.startsWith('listPlaceholders_arr_')), false);
  h.lp.actions.closeMenu();
});

test('placeholder menu: no arr entry for non-admins or when the arr switch is off', t => {
  for (const options of [{ admin: false }, { arrEnabled: false }]) {
    const h = setupArr(t, options);
    const anchor = h.document.createElement('button');
    h.document.body.appendChild(anchor);
    h.lp.actions.showPlaceholderMenu({ listId: LIST, listKind: 'playlist', view: view({ order: ['p:m'] }), canDragPlaceholders: () => true }, ph('m'), anchor);
    assert.deepEqual(menuLabels(h.document), ['listPlaceholders_remove'], JSON.stringify(options));
    h.lp.actions.closeMenu();
    assert.equal(arrCalls(h).length, 0);
  }
});

test('Add title (admin, Seerr on): Seerr results plus an escaped Radarr/Sonarr group; an arr movie is added as a placeholder with its ids', async t => {
  const posts = [];
  const h = setupArr(t, {
    search: async () => ({ results: [{ id: 862, mediaType: 'movie', title: 'Toy Story', releaseDate: '1995-10-30' }] }),
    plugin: async (path, options = {}) => {
      if (path.startsWith('/list-placeholders/arr/lookup')) return new URLSearchParams(path.split('?')[1]).get('type') === 'tv' ? SONARR_HITS : RADARR_HITS;
      posts.push([path, JSON.parse(JSON.stringify(options.body))]);
      return { added: ['n'], addedAsItems: [], skipped: [], view: view() };
    }
  });
  const ctrl = { listId: LIST, listKind: 'playlist', listName: 'DCEU', view: view() };
  const { root } = await searchFor(h, ctrl, 'man of steel');
  await until(() => root.querySelectorAll('[data-group="arr"] .je-lp-result').length === 4);
  await until(() => root.querySelector('[data-group="seerr"] .je-lp-result'));
  assert.deepEqual(h.seerrSearches, ['man of steel']);
  const lookups = arrCalls(h).map(([path]) => Object.fromEntries(new URLSearchParams(path.split('?')[1])));
  assert.deepEqual(lookups, [{ type: 'movie', term: 'man of steel' }, { type: 'tv', term: 'man of steel' }]);
  assert.equal(root.querySelector('[data-group="arr"] .je-lp-results-heading').textContent, 'listPlaceholders_arr_results_heading');
  const arrGroup = root.querySelector('[data-group="arr"]');
  assert.equal(arrGroup.querySelector('.je-lp-result b'), null, 'titles escaped');
  assert.match(arrGroup.innerHTML, /Man of &lt;b&gt;Steel&lt;\/b&gt;/);
  assert.match(arrGroup.innerHTML, /listPlaceholders_arr_in_instance\{"instance":"Radarr &lt;lab&gt;"\}/);
  assert.match(arrGroup.innerHTML, /listPlaceholders_arr_no_tmdb/, 'the TVDB-only show is flagged');
  const imgs = Array.from(arrGroup.querySelectorAll('img')).map(i => i.getAttribute('src'));
  assert.equal(imgs[0], 'https://image.tmdb.org/t/p/w92/mos.jpg');
  assert.equal(imgs[1], 'https://image.tmdb.org/t/p/w92/pm.jpg', 'Radarr and Sonarr hits interleave');
  assert.equal(imgs[2], 'https://image.example/bvs.jpg');
  assert.ok(!imgs[3].startsWith('javascript:'), 'non-https poster URLs are never used');
  assert.equal(arrGroup.querySelectorAll('.je-lp-arr-result-add').length, 4);

  arrGroup.querySelectorAll('.je-lp-result')[0].click();
  assert.equal(arrGroup.querySelectorAll('.je-lp-result')[0].getAttribute('aria-selected'), 'true');
  assert.equal(root.querySelector('[data-group="seerr"] .je-lp-result').getAttribute('aria-selected'), 'false');
  root.querySelector('.jellyseerr-modal-button-primary').click();
  await until(() => posts.length);
  assert.equal(posts[0][0], `/list-placeholders/${LIST}/items`);
  assert.deepEqual(posts[0][1].placeholders, [{ mediaType: 'movie', tmdbId: 49521, title: 'Man of <b>Steel</b>', releaseDate: '2013-06-14', year: 2013, posterPath: '/mos.jpg', kind: 'movie', imdbId: 'tt0770828' }]);
});

test('Add title (admin, Seerr off): the arr lookup alone drives the search; shows are whole series and TVDB-only hits prefill a custom entry', async t => {
  const posts = [];
  const h = setupArr(t, {
    seerr: false,
    plugin: async (path, options = {}) => {
      if (path.startsWith('/list-placeholders/arr/lookup')) return new URLSearchParams(path.split('?')[1]).get('type') === 'tv' ? SONARR_HITS : RADARR_HITS;
      posts.push(JSON.parse(JSON.stringify(options.body)));
      return { added: ['n'], addedAsItems: [], skipped: [], view: view({ listId: COLLECTION }) };
    }
  });
  const ctrl = { listId: COLLECTION, listKind: 'collection', listName: 'DC', view: view({ listId: COLLECTION }) };
  const { root } = await searchFor(h, ctrl, 'peacemaker');
  assert.ok(root.querySelector('.je-lp-tabs'), 'search + custom tabs');
  assert.equal(root.querySelector('[data-pane="search"]').hidden, false);
  assert.equal(root.querySelector('[data-group="seerr"]'), null);
  await until(() => root.querySelectorAll('.je-lp-arr-result').length === 4);
  assert.deepEqual(h.seerrSearches, [], 'Seerr is never called');

  // TVDB-only show → custom entry form, prefilled.
  root.querySelectorAll('.je-lp-arr-result .je-lp-result')[3].click();
  assert.equal(root.querySelector('[data-pane="custom"]').hidden, false);
  assert.equal(root.querySelector('.je-lp-custom-title').value, 'Obscure Show');
  assert.equal(root.querySelector('.je-lp-custom-year').value, '1999');
  assert.equal(root.querySelector('.je-lp-custom-type').value, 'tv');

  root.querySelector('.je-lp-tab[data-tab="search"]').click();
  root.querySelectorAll('.je-lp-arr-result .je-lp-result')[1].click();
  assert.equal(root.querySelector('.je-lp-granularity'), null, 'no granularity without Seerr');
  assert.match(root.querySelector('.je-lp-selected').textContent, /listPlaceholders_arr_series_only/);
  root.querySelector('.jellyseerr-modal-button-primary').click();
  await until(() => posts.length);
  assert.deepEqual(posts[0].placeholders, [{ mediaType: 'tv', tmdbId: 110492, title: 'Peacemaker', releaseDate: '2022-01-13', year: 2022, posterPath: '/pm.jpg', tvdbId: 391153, kind: 'series' }]);
});

test('Add title (viewer): no arr group, no arr calls; without Seerr only custom entries', async t => {
  const h = setupArr(t, { admin: false });
  const { root } = await searchFor(h, { listId: LIST, listKind: 'playlist', view: view() }, 'steel');
  await until(() => h.seerrSearches.length);
  await tick();
  assert.equal(root.querySelector('[data-group="arr"]'), null);
  assert.equal(arrCalls(h).length, 0);

  const h2 = setupArr(t, { admin: false, seerr: false });
  const modal = h2.lp.search.open({ listId: LIST, listKind: 'playlist', view: view() });
  assert.equal(modal.modalElement.querySelector('.je-lp-tabs'), null);
  assert.equal(modal.modalElement.querySelector('[data-pane="search"]').hidden, true);
  assert.equal(arrCalls(h2).length, 0);
});

test('Add title → "Add to Radarr" closes Add title first, then opens the arr dialog alone (no stacked modals)', async t => {
  const h = setupArr(t);
  const doc = h.document;
  const startLength = h.window.history.length;
  const ctrl = { listId: LIST, listKind: 'playlist', listName: 'DCEU', view: view() };
  const { root } = await searchFor(h, ctrl, 'batman');
  await until(() => root.querySelectorAll('.je-lp-arr-result-add').length === 4);
  root.querySelectorAll('.je-lp-arr-result-add')[2].click();
  // Add title's popstate close runs first; the arr dialog opens after it.
  await until(() => doc.querySelector('.je-lp-arr-dialog'));
  assert.equal(root.classList.contains('show'), false, 'Add title is closing');
  await until(() => !doc.body.contains(root));
  assert.equal(doc.querySelectorAll('.jellyseerr-season-modal').length, 1, 'only the arr dialog is open');
  assert.equal(doc.querySelectorAll('.je-lp-add').length, 0);
  assert.equal(doc.querySelector('.je-lp-arr-dialog').dataset.service, 'radarr');
  assert.equal(doc.body.classList.contains('jellyseerr-modal-is-open'), true, 'the closing modal did not clear the open flag');
  assert.match(doc.querySelector('.je-lp-arr-scope-text').textContent, /listPlaceholders_arr_scope_movie/);
  await until(() => arrCalls(h).some(([path]) => path === '/list-placeholders/arr/options?type=movie'));
  // Cancel returns to the page.
  doc.querySelector('.jellyseerr-season-modal .jellyseerr-modal-button:not(.jellyseerr-modal-button-primary)').click();
  await until(() => !doc.querySelector('.je-lp-arr-dialog'), 400);
  // Add title's entry was popped before the arr dialog pushed its own: no stale entry is left behind.
  assert.equal(h.window.history.length, startLength + 1);
  assert.equal(doc.body.classList.contains('jellyseerr-modal-is-open'), false);
});

test('Add title: an arr hit with a year but no release date keeps its year (movie and whole series)', async t => {
  const posts = [];
  const hits = {
    radarr: { instance: { service: 'radarr', id: 0, name: 'Radarr (lab)' }, results: [{ mediaType: 'movie', tmdbId: 1003, title: 'Announced', year: 2027, inArr: false }] },
    sonarr: { instance: { service: 'sonarr', id: 0, name: 'Sonarr (lab)' }, results: [{ mediaType: 'tv', tmdbId: 2004, tvdbId: 3005, title: 'Upcoming Show', year: 2027, inArr: false }] }
  };
  const h = setupArr(t, {
    seerr: false,
    plugin: async (path, options = {}) => {
      if (path.startsWith('/list-placeholders/arr/lookup')) return new URLSearchParams(path.split('?')[1]).get('type') === 'tv' ? hits.sonarr : hits.radarr;
      posts.push(JSON.parse(JSON.stringify(options.body)));
      return { added: ['n'], addedAsItems: [], skipped: [], view: view() };
    }
  });
  const ctrl = { listId: LIST, listKind: 'playlist', listName: 'Soon', view: view() };
  for (const [index, expected] of [
    [0, { mediaType: 'movie', tmdbId: 1003, title: 'Announced', releaseDate: null, year: 2027, kind: 'movie' }],
    [1, { mediaType: 'tv', tmdbId: 2004, title: 'Upcoming Show', releaseDate: null, year: 2027, tvdbId: 3005, kind: 'series' }]
  ]) {
    const { root } = await searchFor(h, ctrl, 'soon');
    await until(() => root.querySelectorAll('.je-lp-arr-result').length === 2);
    assert.match(root.querySelectorAll('.je-lp-arr-result')[index].textContent, /2027/);
    root.querySelectorAll('.je-lp-arr-result .je-lp-result')[index].click();
    root.querySelector('.jellyseerr-modal-button-primary').click();
    await until(() => posts.length === index + 1);
    assert.deepEqual(posts[index].placeholders, [expected]);
    await until(() => !h.document.querySelector('.jellyseerr-season-modal'));
  }
  // Seerr items carry no `year`: a date-less Seerr result still has none.
  assert.equal(h.lp.granularity.toPlaceholder({ id: 5, mediaType: 'movie', title: 'X' }).year, undefined);
  assert.equal(h.lp.granularity.toPlaceholder({ id: 5, mediaType: 'movie', title: 'X', year: 1700 }).year, undefined, 'out-of-range years are dropped');
});

test('Add title: typing again cancels the running lookup, so results for the old text never render under the new text', async t => {
  let releaseOld;
  const oldGate = new Promise(r => { releaseOld = r; });
  const hit = (title, tmdbId) => ({ instance: { service: 'radarr', id: 0, name: 'Radarr (lab)' }, results: [{ mediaType: 'movie', tmdbId, title, year: 2005, inArr: false }] });
  const h = setupArr(t, {
    seerr: false,
    plugin: async (path) => {
      const params = new URLSearchParams(path.split('?')[1]);
      if (params.get('type') === 'tv') return { instance: { service: 'sonarr', id: 0, name: 'Sonarr (lab)' }, results: [] };
      if (params.get('term') === 'batman') { await oldGate; return hit('Batman (old query)', 268); }
      return hit('Batman Begins', 272);
    }
  });
  const ctrl = { listId: LIST, listKind: 'playlist', listName: 'Bats', view: view() };
  const { root } = await searchFor(h, ctrl, 'batman');
  await until(() => arrCalls(h).some(([path]) => path.includes('term=batman') && path.includes('type=movie')));
  const input = root.querySelector('.je-lp-query');
  input.value = 'batman begins';
  input.dispatchEvent(new h.window.Event('input'));
  releaseOld();
  await tick(); await tick();
  await new Promise(r => setTimeout(r, 20));
  assert.equal(root.querySelectorAll('.je-lp-arr-result').length, 0, 'the old lookup did not render');
  await until(() => root.querySelectorAll('.je-lp-arr-result').length === 1, 400);
  assert.match(root.querySelector('.je-lp-arr-result').textContent, /Batman Begins/);
  assert.doesNotMatch(root.textContent, /old query/);
});
