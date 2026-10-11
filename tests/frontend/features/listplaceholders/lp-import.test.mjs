import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, view, tick, LIST, COLLECTION } from './lp-harness.mjs';

const until = async (fn, tries = 200) => { for (let i = 0; i < tries; i++) { const v = fn(); if (v) return v; await tick(); } throw new Error('timeout'); };
const plainJson = value => JSON.parse(JSON.stringify(value));
const movie = (tmdbId, title, extra = {}) => ({ mediaType: 'movie', tmdbId, title, year: 2013, releaseDate: '2013-06-12', posterPath: `/p${tmdbId}.jpg`, overview: 'o', score: 160, ...extra });
const ok = (index, match, extra = {}) => ({ index, state: 'ok', confidence: 'high', kind: match?.mediaType === 'tv' ? 'series' : 'movie', match, candidates: match ? [match] : [], reasons: [], alternatives: false, ...extra });

/**
 * Loads the modules plus modal.js; `plugin` answers the list-placeholders routes.
 * @param {*} t
 * @param {Object} [options]
 */
function setupImport(t, { plugin, search, config, tvDetails, html } = {}) {
  const h = setup(t, {
    config,
    html,
    plugin: plugin || (async () => ({})),
    jellyseerrAPI: {
      search: search || (async () => ({ results: [] })),
      fetchTvShowDetails: async () => tvDetails || { id: 1, name: 'Show', seasons: [{ seasonNumber: 1, episodeCount: 8, airDate: '2022-01-13' }, { seasonNumber: 2, episodeCount: 8, airDate: '2025-08-21' }] },
      fetchTvSeasonDetails: async () => ({ episodes: [{ episodeNumber: 1, name: 'One', airDate: '2022-01-13' }, { episodeNumber: 2, name: 'Two', airDate: '2022-01-13' }, { episodeNumber: 7, name: 'Seven', airDate: '2016-12-01' }] })
    }
  });
  h.load('jellyseerr/modal.js');
  return h;
}

/** Resolve handler: every entry → a high-confidence movie match named after the entry. */
function resolveAll(body) {
  return { results: body.entries.map(e => ok(e.index, movie(1000 + e.index, e.title || `T${e.index}`))), complete: true, seerrCalls: body.entries.length };
}

const lines = n => Array.from({ length: n }, (_, i) => `${i + 1}. Title Number ${i + 1} (${2000 + (i % 20)})`).join('\n');

test('toImportEntry keeps the fields /resolve reads and drops invalid ones', t => {
  const h = setupImport(t);
  const imp = h.lp.importer;
  const dto = imp.toImportEntry({
    line: 3, raw: 'x', title: 'Peacemaker', year: 2022, typeHint: 'tv', season: 1, episodes: [{ s: 1, e: 5 }], openEnded: true,
    ids: { tmdb: '110492', tmdbType: 'tv', imdb: 'bad', tvdb: 0 }, status: 'released', note: 'n'.repeat(400), sourceKey: 'tv|110492|1|',
    alternatives: [{ title: 'A', year: 1500, typeHint: 'movie', ids: { imdb: 'tt1234567' } }], section: 'DCEU', dupOf: 1
  }, 7);
  assert.deepEqual(plainJson(dto), {
    index: 7, title: 'Peacemaker', year: 2022, typeHint: 'tv', season: 1, episodes: [{ s: 1, e: 5 }], openEnded: true,
    ids: { tmdb: 110492, tmdbType: 'tv' }, status: 'released',
    alternatives: [{ title: 'A', typeHint: 'movie', ids: { imdb: 'tt1234567' } }], note: 'n'.repeat(300), sourceKey: 'tv|110492|1|'
  });
});

test('placeholderFromCandidate mirrors the server per kind (C4 dates) and validates fields', t => {
  const h = setupImport(t);
  const imp = h.lp.importer;
  assert.deepEqual(plainJson(imp.placeholderFromCandidate(movie(49521, 'Man of Steel', { posterPath: 'javascript:1', imdbId: 'tt0770828' }), { note: 'Start here.' }, 'movie')),
    { kind: 'movie', mediaType: 'movie', tmdbId: 49521, title: 'Man of Steel', year: 2013, releaseDate: '2013-06-12', overview: 'o', imdbId: 'tt0770828', note: 'Start here.' });
  const season = imp.placeholderFromCandidate({ mediaType: 'tv', tmdbId: 110492, title: 'Peacemaker', year: 2022, releaseDate: '2022-01-13', tvdbId: 391153, season: { seasonNumber: 1, episodeCount: 8, airDate: '2022-01-13' } }, { season: 1 }, 'season');
  assert.equal(season.kind, 'season');
  assert.equal(season.seasonNumber, 1);
  assert.equal(season.episodeTotal, 8);
  assert.equal(season.tvdbId, 391153);
  const episodes = imp.placeholderFromCandidate({ mediaType: 'tv', tmdbId: 60735, title: 'The Flash', season: { seasonNumber: 8, airDate: '2021-11-16' }, episodes: [{ s: 8, e: 2, title: 'B', airDate: '2021-11-23' }, { s: 8, e: 1, title: 'A', airDate: '2021-11-16' }] }, { episodes: [{ s: 8, e: 1 }, { s: 8, e: 2 }] }, 'episodes');
  assert.deepEqual(plainJson(episodes.episodes), [{ s: 8, e: 1, title: 'A', airDate: '2021-11-16' }, { s: 8, e: 2, title: 'B', airDate: '2021-11-23' }]);
  assert.equal(episodes.releaseDate, '2021-11-16');
  const fromEntry = imp.placeholderFromCandidate({ mediaType: 'tv', tmdbId: 1412, title: 'Arrow' }, { episodes: [{ s: 3, e: 8 }] }, 'episodes');
  assert.deepEqual(plainJson(fromEntry.episodes), [{ s: 3, e: 8 }]);
  assert.equal(fromEntry.seasonNumber, 3);
  assert.equal(imp.placeholderFromCandidate({ mediaType: 'tv', tmdbId: 5, title: 'B', alternative: 1 }, { season: 2 }, 'season').kind, 'series', 'the second version of "A S2 or B" is the whole show');
  assert.equal(imp.placeholderFromCandidate({ mediaType: 'person', tmdbId: 5, title: 'x' }, {}, 'movie'), null);
  assert.equal(imp.placeholderFromCandidate({ mediaType: 'tv', tmdbId: 5, title: 'x' }, {}, 'episodes').kind, 'series');
});

test('default decisions: high/medium match, in-library items, TBA and no-match as custom, uncertain rows skipped', t => {
  const h = setupImport(t);
  const imp = h.lp.importer;
  const lib = (kind, id = 'a'.repeat(32)) => ({ itemId: id, kind, title: 'L', complete: true });
  const row = (result, entry = { title: 'X' }, extra = {}) => {
    const cands = imp.candidateList(result);
    return { entry, result, cands, cand: result.match ? 0 : -1, ...extra };
  };
  const cases = [
    [row(ok(0, movie(1, 'A'))), 'playlist', 'placeholder'],
    [row(ok(0, movie(1, 'A', { inLibrary: lib('movie') }))), 'playlist', 'item'],
    [row(ok(0, movie(1, 'A'), { confidence: 'medium' })), 'playlist', 'placeholder'],
    [row(ok(0, movie(1, 'A'), { confidence: 'low' })), 'playlist', 'skip'],
    [row(ok(0, movie(1, 'A'), { confidence: 'low', reasons: ['tba'] })), 'playlist', 'custom'],
    [row(ok(0, null, { confidence: 'none', reasons: ['noMatch'] })), 'playlist', 'custom'],
    [row(ok(0, null, { confidence: 'none' }), { ids: { tmdb: 4 } }), 'playlist', 'skip'],
    [row(ok(0, null, { confidence: 'none' }), { title: 'either version', source: 'chain' }), 'playlist', 'skip'],
    [row(ok(0, movie(1, 'A'), { confidence: 'low', alternatives: true })), 'playlist', 'skip'],
    [row(ok(0, movie(1, 'A')), { title: 'X' }, { dupOf: 0 }), 'playlist', 'skip'],
    [row(ok(0, movie(1, 'A')), { title: 'X' }, { failed: true }), 'playlist', 'skip'],
    [row(ok(0, { mediaType: 'tv', tmdbId: 2, title: 'S', inLibrary: lib('series') })), 'collection', 'item'],
    [row(ok(0, { mediaType: 'tv', tmdbId: 2, title: 'S', inLibrary: lib('series') })), 'playlist', 'placeholder'],
    [row(ok(0, { mediaType: 'tv', tmdbId: 2, title: 'S', season: { seasonNumber: 1 }, inLibrary: lib('season') }, { kind: 'season' })), 'collection', 'placeholder']
  ];
  cases.forEach(([r, kind, expected], i) => assert.equal(imp.defaultAction(r, kind), expected, `case ${i}`));
});

test('TV the library has (part of) is "From your library" and is sent as a placeholder the server expands', t => {
  const h = setupImport(t);
  const imp = h.lp.importer;
  const ids = ['a', 'b'].map(c => c.repeat(32));
  const season = (lib) => ({ mediaType: 'tv', tmdbId: 110492, title: 'Peacemaker', year: 2022, season: { seasonNumber: 1, episodeCount: 8, airDate: '2022-01-13' }, inLibrary: lib });
  const part = season({ itemId: 'c'.repeat(32), kind: 'season', episodeItemIds: ids, complete: false });
  const row = { entry: { title: 'Peacemaker', season: 1, sourceKey: 'tv|110492|1|' }, result: ok(0, part, { kind: 'season' }), cands: [part], cand: 0 };

  for (const kind of ['playlist', 'collection']) {
    assert.equal(imp.fromLibrary(part, kind), true, kind);
    assert.equal(imp.defaultAction(row, kind), 'item', kind);
    const entries = plainJson(imp.rowEntries({ ...row, action: 'item' }, kind));
    assert.equal(entries.length, 1);
    assert.equal(entries[0].type, 'placeholder', 'never the Season item or episode ids: the server inserts them (C1)');
    assert.equal(entries[0].placeholder.kind, 'season');
    assert.equal(entries[0].sourceKey, 'tv|110492|1|');
  }
  assert.equal(imp.libraryChipText(part, 'playlist'), 'listPlaceholders_import_in_library_part{"count":2,"total":8}');
  assert.equal(imp.libraryChipText({ ...part, inLibrary: { ...part.inLibrary, complete: true } }, 'playlist'), 'listPlaceholders_in_library');
  const episodes = { mediaType: 'tv', tmdbId: 60735, title: 'The Flash', episodes: [{ s: 1, e: 8 }, { s: 1, e: 9 }, { s: 1, e: 10 }], inLibrary: { itemId: ids[0], kind: 'episodes', episodeItemIds: [ids[0]], complete: false } };
  assert.equal(imp.libraryChipText(episodes, 'playlist'), 'listPlaceholders_import_in_library_part{"count":1,"total":3}');

  // A show whose folder has no episodes adds nothing to a playlist (no chip, no "From your library"), but a
  // collection gets the Series item.
  const empty = { mediaType: 'tv', tmdbId: 1399, title: 'Game of Thrones', inLibrary: { itemId: ids[1], kind: 'series', complete: false } };
  const emptyRow = { entry: { title: 'Game of Thrones' }, result: ok(0, empty), cands: [empty], cand: 0 };
  assert.equal(imp.defaultAction(emptyRow, 'playlist'), 'placeholder');
  assert.equal(imp.libraryChipText(empty, 'playlist'), '');
  assert.equal(imp.defaultAction(emptyRow, 'collection'), 'item');
  assert.equal(imp.libraryChipText(empty, 'collection'), 'listPlaceholders_in_library');
  assert.deepEqual(plainJson(imp.rowEntries({ ...emptyRow, action: 'item' }, 'collection')), [{ type: 'item', itemId: ids[1] }]);

  // The review row offers "From your library" and shows the partial count.
  const box = h.document.createElement('div');
  box.innerHTML = imp.rowHtml({ ...row, i: 0, action: 'item' }, { listKind: 'playlist' });
  assert.deepEqual(Array.from(box.querySelectorAll('option')).map(o => o.value), ['item', 'placeholder', 'custom', 'skip']);
  assert.equal(box.querySelector('.je-lp-chip-lib').textContent, 'listPlaceholders_import_in_library_part{"count":2,"total":8}');

  // A later season shows the year it aired, not the show's first year.
  const s2 = { ...part, season: { seasonNumber: 2, episodeCount: 8, airDate: '2025-08-21' }, inLibrary: null };
  box.innerHTML = imp.rowHtml({ i: 1, entry: { title: 'Peacemaker', season: 2 }, result: ok(1, s2, { kind: 'season' }), cands: [s2], cand: 0, action: 'placeholder' }, { listKind: 'playlist' });
  assert.match(box.querySelector('.je-lp-irow-meta').textContent, /2025/);
  assert.doesNotMatch(box.querySelector('.je-lp-irow-meta').textContent, /2022/);
});

test('rowEntries: both versions in order, the source key on the first entry only, custom and skip', t => {
  const h = setupImport(t);
  const imp = h.lp.importer;
  const jl = movie(141052, 'Justice League', { alternative: 0 });
  const zs = movie(791373, "Zack Snyder's Justice League", { alternative: 1, inLibrary: { itemId: 'b'.repeat(32), kind: 'movie', title: 'ZSJL' } });
  const result = ok(0, jl, { confidence: 'low', alternatives: true, candidates: [jl, zs] });
  const row = { entry: { title: 'Justice League', sourceKey: 'movie|141052||' }, result, cands: imp.candidateList(result), cand: 0, both: true, action: 'item' };
  const entries = plainJson(imp.rowEntries(row, 'playlist'));
  assert.equal(entries.length, 2);
  assert.equal(entries[0].type, 'placeholder');
  assert.equal(entries[0].placeholder.tmdbId, 141052);
  assert.equal(entries[0].sourceKey, 'movie|141052||');
  assert.deepEqual(entries[1], { type: 'item', itemId: 'b'.repeat(32) });
  assert.deepEqual(plainJson(imp.rowEntries({ ...row, both: false, action: 'custom', entry: { title: 'Booster Gold', year: 2031, typeHint: 'tv', note: 'In development' } }, 'playlist')),
    [{ type: 'placeholder', placeholder: { kind: 'custom', mediaType: 'tv', title: 'Booster Gold', year: 2031, note: 'In development' } }]);
  assert.equal(imp.rowEntries({ ...row, action: 'skip' }, 'playlist').length, 0);
});

test('review rows escape every text from the paste and from TMDB', t => {
  const h = setupImport(t);
  const imp = h.lp.importer;
  const evil = '<img src=x onerror="window.__xss=1">';
  const result = ok(0, movie(1, evil, { posterPath: '"><script>' }), { reasons: ['noYear'] });
  const html = imp.rowHtml({ i: 0, entry: { title: evil, raw: `1. [${evil}](http://x) **bold**`, line: 2 }, result, cands: imp.candidateList(result), cand: 0, action: 'placeholder' }, { listKind: 'playlist' });
  const box = h.document.createElement('div');
  box.innerHTML = html;
  assert.equal(box.querySelector('img[onerror]'), null);
  assert.equal(box.querySelector('script'), null);
  assert.match(box.querySelector('.je-lp-irow-line').textContent, /^listPlaceholders_import_line/);
  assert.equal(imp.plainLine('1. [Man of Steel](https://x.y/a) (2013) · **Film**'), '1. Man of Steel (2013) · Film');
  assert.equal(imp.plainLine('| 5 | Justice League **or** ZSJL | 2017 / 2021 |'), '5 · Justice League or ZSJL · 2017 / 2021');
  assert.equal(imp.nameFromUrl('https://mdblist.com/lists/linaspurinis/top-watched-movies-of-the-week', 'MDBList'), 'Top watched movies of the week');
  assert.equal(imp.nameFromUrl('https://www.themoviedb.org/list/8136', 'TMDB'), 'listPlaceholders_import_site_list{"site":"TMDB"}');
  assert.equal(imp.nameFromUrl('https://www.themoviedb.org/collection/10-star-wars-collection', 'TMDB'), 'Star wars collection');
});

test('paste → sequential /resolve chunks of 25 with progress → review → new playlist in order', async t => {
  const calls = [];
  const h = setupImport(t, { plugin: async (path, options = {}) => {
    calls.push([path, plainJson(options.body ?? null), options.skipRetry]);
    if (path === '/list-placeholders/resolve') return resolveAll(options.body);
    if (path === '/list-placeholders/playlists') return { listId: 'c'.repeat(32), listKind: 'playlist', name: 'Mine', result: { added: options.body.entries.map((_, i) => `p${i}`), addedAsItems: [], skipped: [], view: view({ listId: 'c'.repeat(32) }) } };
    return {};
  } });
  const modal = h.JE.listPlaceholders.openImport({ mode: 'new' });
  const root = modal.modalElement;
  assert.ok(root.classList.contains('je-lp-import-modal'));
  root.querySelector('.je-lp-import-text').value = lines(30);
  root.querySelector('.jellyseerr-modal-button-primary').click();
  await until(() => root.querySelector('.je-lp-import-progress').hidden && root.querySelectorAll('.je-lp-irow').length === 30);
  const resolves = calls.filter(c => c[0] === '/list-placeholders/resolve');
  assert.deepEqual(resolves.map(c => c[1].entries.length), [25, 5]);
  assert.equal(resolves[0][1].listId, undefined, 'a new playlist has no list to check the owner against');
  assert.equal(resolves[0][2], true, 'never retried by the API layer');
  assert.deepEqual(resolves[1][1].entries.map(e => e.index), [25, 26, 27, 28, 29]);
  assert.match(root.querySelector('.je-lp-import-summary').textContent, /"total":30/);
  const primary = root.querySelector('.jellyseerr-modal-button-primary');
  assert.match(primary.textContent, /"count":30/);
  primary.click();
  await tick();
  assert.equal(calls.filter(c => c[0] === '/list-placeholders/playlists').length, 0, 'a name is required');
  root.querySelector('.je-lp-new-name').value = 'Mine';
  root.querySelector('.je-lp-new-public').checked = true;
  primary.click();
  await until(() => calls.some(c => c[0] === '/list-placeholders/playlists'));
  const create = calls.find(c => c[0] === '/list-placeholders/playlists')[1];
  assert.equal(create.name, 'Mine');
  assert.equal(create.isPublic, true);
  assert.ok(create.requestId);
  assert.equal(create.source, undefined);
  assert.deepEqual(create.entries.map(e => e.placeholder.tmdbId), Array.from({ length: 30 }, (_, i) => 1000 + i));
  await until(() => h.toasts.some(m => m.includes('listPlaceholders_import_done_toast')));
  assert.ok(h.toasts.find(m => m.includes('listPlaceholders_import_done_toast')).includes(`#/details?id=${'c'.repeat(32)}`));
});

test('busy and parental-pending answers are retried; transient entries are resubmitted once, then shown as failed', async t => {
  let n = 0;
  const seen = [];
  const h = setupImport(t, { plugin: async (path, options = {}) => {
    if (path !== '/list-placeholders/resolve') return {};
    n++;
    seen.push(options.body.entries.map(e => e.index));
    if (n === 1) throw Object.assign(new Error('busy'), { status: 429, responseJSON: { code: 'busy', retryAfter: 0.001 } });
    if (n === 2) throw Object.assign(new Error('pending'), { status: 504, responseJSON: { code: 'parental_pending', retryAfter: 0.001 } });
    // Entry 1 stays transient every time; entry 2 heals on the resubmit.
    return { results: options.body.entries.map(e => (e.index === 1 || (e.index === 2 && n === 3)) ? { index: e.index, state: 'transient', confidence: 'none', candidates: [], reasons: [] } : ok(e.index, movie(10 + e.index, `M${e.index}`))), complete: false };
  } });
  const modal = h.lp.importer.open({ mode: 'new' });
  const root = modal.modalElement;
  root.querySelector('.je-lp-import-text').value = 'Alpha (2001)\nBravo (2002)\nCharlie (2003)';
  root.querySelector('.jellyseerr-modal-button-primary').click();
  await until(() => root.querySelector('.je-lp-import-progress').hidden, 2000);
  assert.deepEqual(plainJson(seen), [[0, 1, 2], [0, 1, 2], [0, 1, 2], [1, 2]]);
  const actions = [...root.querySelectorAll('.je-lp-irow-action')].map(s => s.value);
  assert.deepEqual(actions, ['placeholder', 'skip', 'placeholder']);
  assert.ok(root.querySelector('.je-lp-irow[data-i="1"] .je-lp-conf-none'));
  const retry = root.querySelector('.je-lp-import-retry');
  assert.equal(retry.hidden, false);
  assert.match(retry.textContent, /"count":1/);
});

test('Seerr unavailable (503) and an unlinked Seerr account (403) stop the lookup with a message', async t => {
  for (const [status, code, key] of [[503, 'seerr_unavailable', 'listPlaceholders_import_err_seerr'], [403, 'seerr_unlinked', 'listPlaceholders_import_err_unlinked']]) {
    let calls = 0;
    const h = setupImport(t, { plugin: async (path) => {
      if (path === '/list-placeholders/resolve') { calls++; throw Object.assign(new Error('x'), { status, responseJSON: { code } }); }
      return {};
    } });
    const root = h.lp.importer.open({ mode: 'new' }).modalElement;
    root.querySelector('.je-lp-import-text').value = lines(30);
    root.querySelector('.jellyseerr-modal-button-primary').click();
    await until(() => h.toasts.some(m => m.includes(key)));
    await until(() => root.querySelector('.je-lp-import-progress').hidden);
    assert.equal(calls, 1, `${code}: no further chunks`);
    assert.equal(root.querySelectorAll('.je-lp-irow').length, 30);
    assert.ok([...root.querySelectorAll('.je-lp-irow-action')].every(s => s.value === 'skip'));
  }
});

test('import into an existing playlist: listId on /resolve, apply at the start, retry reuses the request id', async t => {
  const calls = [];
  let applyAttempts = 0;
  let afterReal = 0;
  const h = setupImport(t, { plugin: async (path, options = {}) => {
    calls.push([path, plainJson(options.body ?? null)]);
    if (path === '/list-placeholders/resolve') {
      return { results: options.body.entries.map(e => ok(e.index, movie(5 + e.index, `M${e.index}`, e.index === 0 ? { inLibrary: { itemId: 'd'.repeat(32), kind: 'movie', title: 'M0' } } : {}))) };
    }
    if (path === `/list-placeholders/${LIST}/apply`) {
      applyAttempts++;
      if (applyAttempts === 1) throw Object.assign(new Error('lost'), { status: 502 });
      return { added: ['x'], addedAsItems: ['d'.repeat(32)], skipped: [], view: view() };
    }
    return {};
  } });
  const ctrl = { listId: LIST, listKind: 'playlist', listName: 'Marathon', view: view(), afterRealItemsAdded: () => afterReal++ };
  const root = h.lp.importer.open({ ctrl }).modalElement;
  root.querySelector('.je-lp-import-text').value = 'Toy Story (1995)\nAntz (1998)';
  root.querySelector('.jellyseerr-modal-button-primary').click();
  await until(() => root.querySelector('.je-lp-import-progress').hidden);
  assert.equal(calls[0][1].listId, LIST);
  assert.equal(root.querySelector('.je-lp-new-name'), null);
  root.querySelector('.je-lp-import-position').value = 'start';
  root.querySelector('.jellyseerr-modal-button-primary').click();
  await until(() => applyAttempts === 1 && !root.querySelector('.jellyseerr-modal-button-primary').disabled);
  root.querySelector('.jellyseerr-modal-button-primary').click();
  await until(() => applyAttempts === 2);
  const applies = calls.filter(c => c[0].endsWith('/apply')).map(c => c[1]);
  assert.equal(applies[0].requestId, applies[1].requestId);
  assert.deepEqual(applies[1].position, { atStart: true });
  assert.deepEqual(applies[1].entries[0], { type: 'item', itemId: 'd'.repeat(32) });
  assert.equal(applies[1].entries[1].type, 'placeholder');
  await until(() => afterReal === 1);
});

test('collections: no position, series in the library become the Series item', async t => {
  const calls = [];
  const h = setupImport(t, { plugin: async (path, options = {}) => {
    calls.push([path, plainJson(options.body ?? null)]);
    if (path === '/list-placeholders/resolve') return { results: [ok(0, { mediaType: 'tv', tmdbId: 1399, title: 'Game of Thrones', inLibrary: { itemId: 'e'.repeat(32), kind: 'series', title: 'GoT' } })] };
    return { added: [], addedAsItems: ['e'.repeat(32)], skipped: [], view: view({ listId: COLLECTION, listKind: 'collection' }) };
  } });
  const ctrl = { listId: COLLECTION, listKind: 'collection', listName: 'Cars', view: view({ listId: COLLECTION, listKind: 'collection' }) };
  const root = h.lp.importer.open({ ctrl }).modalElement;
  assert.equal(root.querySelector('.je-lp-import-position'), null);
  root.querySelector('.je-lp-import-text').value = 'Game of Thrones (2011)';
  root.querySelector('.jellyseerr-modal-button-primary').click();
  await until(() => root.querySelector('.je-lp-import-progress').hidden);
  root.querySelector('.jellyseerr-modal-button-primary').click();
  await until(() => calls.some(c => c[0].endsWith('/apply')));
  assert.deepEqual(calls.find(c => c[0].endsWith('/apply'))[1].entries, [{ type: 'item', itemId: 'e'.repeat(32) }]);
});

test('sections picker: unticked sections are not looked up; a pasted list URL offers the URL tab', async t => {
  const seen = [];
  const h = setupImport(t, { plugin: async (path, options = {}) => {
    if (path === '/list-placeholders/resolve') { seen.push(...options.body.entries.map(e => e.title)); return resolveAll(options.body); }
    if (path === '/list-placeholders/source/providers') return { mdblist: true, tmdbLists: false, tmdbCharts: true, trakt: false, imdb: false, syncEnabled: true, maxItems: 1000 };
    return {};
  } });
  const root = h.lp.importer.open({ mode: 'new' }).modalElement;
  const text = root.querySelector('.je-lp-import-text');
  text.value = '### DCEU\n1. Man of Steel (2013)\n2. Aquaman (2018)\n\n### DCU\n1. Superman (2025)\n\nhttps://mdblist.com/lists/someone/top-dc';
  text.dispatchEvent(new h.window.Event('input'));
  await until(() => root.querySelector('.je-lp-import-sections'), 2000);
  const boxes = [...root.querySelectorAll('.je-lp-import-sections input')];
  assert.deepEqual(boxes.map(b => b.dataset.section), ['DCEU', 'DCU']);
  boxes[1].checked = false;
  const useUrl = root.querySelector('.je-lp-import-use-url');
  assert.equal(useUrl.dataset.url, 'https://mdblist.com/lists/someone/top-dc');
  root.querySelector('.jellyseerr-modal-button-primary').click();
  await until(() => root.querySelector('.je-lp-import-progress').hidden);
  assert.deepEqual(seen, ['Man of Steel', 'Aquaman']);
  assert.equal(root.querySelector('.je-lp-new-name').value, 'DCEU', 'one chosen section names the new playlist');
  root.querySelector('.je-lp-import-back').click();
  assert.equal(root.querySelector('.je-lp-import-sections input[data-section="DCU"]').checked, false, 'the choice survives going back');
  root.querySelector('.je-lp-import-use-url').click();
  assert.equal(root.querySelector('[data-pane="url"]').hidden, false);
  assert.equal(root.querySelector('.je-lp-import-url').value, 'https://mdblist.com/lists/someone/top-dc');
  await until(() => root.querySelector('.je-lp-import-providers').textContent.includes('MDBList, TMDB'));
});

test('From URL: fetch → resolve → apply links the source with Keep in sync and source keys', async t => {
  const calls = [];
  const fetched = {
    kind: 'mdblist', provider: 'mdblist', url: 'https://mdblist.com/lists/a/b', title: 'Top watched', unofficial: false, total: 3, truncated: false,
    entries: [
      { title: 'One', year: 2020, typeHint: 'movie', ids: { tmdb: 1, tmdbType: 'movie' }, sourceKey: 'movie|1||' },
      { title: 'Two', year: 2021, typeHint: 'movie', ids: { tmdb: 2, tmdbType: 'movie' }, sourceKey: 'movie|2||' },
      { title: 'Three', year: 2022, typeHint: 'movie', ids: { tmdb: 3, tmdbType: 'movie' }, sourceKey: 'movie|3||' }
    ]
  };
  const h = setupImport(t, { plugin: async (path, options = {}) => {
    calls.push([path, plainJson(options.body ?? null)]);
    if (path === '/list-placeholders/source/providers') return { mdblist: true, syncEnabled: true };
    if (path === '/list-placeholders/source/fetch') {
      if (options.body.url.includes('letterboxd')) throw Object.assign(new Error('x'), { status: 400, responseJSON: { code: 'letterboxd_unsupported' } });
      return fetched;
    }
    if (path === '/list-placeholders/resolve') return { results: options.body.entries.map(e => ok(e.index, movie(e.ids.tmdb, e.title))) };
    if (path === '/list-placeholders/playlists') return { listId: 'f'.repeat(32), name: 'Top watched', result: { added: ['a', 'b'], addedAsItems: [], skipped: [] } };
    return {};
  } });
  const root = h.lp.importer.open({ mode: 'new' }).modalElement;
  root.querySelector('.je-lp-tab[data-tab="url"]').click();
  const url = root.querySelector('.je-lp-import-url');
  url.value = 'https://letterboxd.com/someone/list/x/';
  root.querySelector('.jellyseerr-modal-button-primary').click();
  await until(() => root.querySelector('.je-lp-import-url-error').textContent);
  assert.equal(root.querySelector('.je-lp-import-url-error').textContent, 'listPlaceholders_sourceLetterboxd');
  url.value = 'https://mdblist.com/lists/a/b';
  url.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await until(() => root.querySelector('.je-lp-import-progress').hidden && root.querySelectorAll('.je-lp-irow').length === 3);
  assert.equal(root.querySelector('.je-lp-import-sync').hidden, false);
  assert.equal(root.querySelector('.je-lp-new-name').value, 'Top watched');
  const resolve = calls.find(c => c[0] === '/list-placeholders/resolve')[1];
  assert.deepEqual(resolve.entries.map(e => e.sourceKey), ['movie|1||', 'movie|2||', 'movie|3||']);
  // Skip the second entry: it stays in the snapshot (the server tombstones it).
  const select = root.querySelector('.je-lp-irow[data-i="1"] .je-lp-irow-action');
  select.value = 'skip';
  select.dispatchEvent(new h.window.Event('change', { bubbles: true }));
  root.querySelector('.je-lp-import-remove-dropped').checked = true;
  root.querySelector('.jellyseerr-modal-button-primary').click();
  await until(() => calls.some(c => c[0] === '/list-placeholders/playlists'));
  const body = calls.find(c => c[0] === '/list-placeholders/playlists')[1];
  assert.deepEqual(body.source, { url: 'https://mdblist.com/lists/a/b', syncEnabled: true, removeDropped: true, snapshotKeys: ['movie|1||', 'movie|2||', 'movie|3||'] });
  assert.deepEqual(body.entries.map(e => e.sourceKey), ['movie|1||', 'movie|3||']);
});

test('Change match: pick another candidate, add both versions of an "A or B" line, or search another title', async t => {
  const calls = [];
  const jl = movie(141052, 'Justice League', { alternative: 0, year: 2017 });
  const zs = movie(791373, "Zack Snyder's Justice League", { alternative: 1, year: 2021 });
  const h = setupImport(t, {
    search: async (query) => ({ results: [{ id: 75, mediaType: 'tv', name: "DC's Legends of Tomorrow", firstAirDate: '2016-01-21', posterPath: '/l.jpg' }, { id: 9, mediaType: 'person', name: 'P' }] }),
    plugin: async (path, options = {}) => {
      calls.push([path, plainJson(options.body ?? null)]);
      if (path === '/list-placeholders/resolve') {
        return { results: [
          ok(0, jl, { confidence: 'low', alternatives: true, reasons: ['alternatives'], candidates: [jl, zs] }),
          ok(1, null, { confidence: 'none', reasons: ['noMatch'], kind: 'episodes' })
        ] };
      }
      return { listId: 'f'.repeat(32), name: 'x', result: { added: [], addedAsItems: [], skipped: [] } };
    }
  });
  const root = h.lp.importer.open({ mode: 'new' }).modalElement;
  root.querySelector('.je-lp-import-text').value = '| Watch | Released |\n| --- | --- |\n| Justice League **or** Zack Snyder\'s Justice League | 2017 / 2021 |\n| Legends 2x07 | 2016 |';
  root.querySelector('.jellyseerr-modal-button-primary').click();
  await until(() => root.querySelector('.je-lp-import-progress').hidden);
  assert.match(root.querySelector('.je-lp-irow[data-i="0"] .je-lp-irow-hint').textContent, /alternatives/);
  assert.equal(root.querySelector('.je-lp-irow[data-i="0"] .je-lp-irow-action').value, 'skip');
  assert.ok(root.querySelector('.je-lp-irow[data-i="0"]').classList.contains('je-lp-irow-review'));

  // Row 0: add both versions.
  root.querySelector('.je-lp-irow[data-i="0"] .je-lp-irow-edit').click();
  const editor = root.querySelector('.je-lp-ieditor');
  assert.equal(editor.querySelectorAll('.je-lp-ieditor-cand').length, 2);
  editor.querySelector('.je-lp-ieditor-both').checked = true;
  editor.querySelector('.je-lp-ieditor-both').dispatchEvent(new h.window.Event('change', { bubbles: true }));
  editor.querySelector('.je-lp-ieditor-done').click();
  assert.equal(root.querySelector('.je-lp-ieditor'), null);
  assert.equal(root.querySelector('.je-lp-irow[data-i="0"] .je-lp-irow-action').value, 'placeholder');
  assert.ok(!root.querySelector('.je-lp-irow[data-i="0"]').classList.contains('je-lp-irow-review'));

  // Row 1: no candidates → search another title, pick the show; Escape closes an editor without closing the modal.
  root.querySelector('.je-lp-irow[data-i="1"] .je-lp-irow-edit').click();
  let ed = root.querySelector('.je-lp-ieditor');
  ed.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(root.querySelector('.je-lp-ieditor'), null);
  assert.ok(root.isConnected);
  root.querySelector('.je-lp-irow[data-i="1"] .je-lp-irow-edit').click();
  ed = root.querySelector('.je-lp-ieditor');
  const query = ed.querySelector('.je-lp-ieditor-query');
  query.value = 'legends of tomorrow';
  query.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await until(() => ed.querySelector('.je-lp-ieditor-cand'));
  assert.equal(ed.querySelectorAll('.je-lp-ieditor-cand').length, 1, 'people are not offered');
  const radio = ed.querySelector('.je-lp-ieditor-cand input');
  radio.checked = true;
  radio.dispatchEvent(new h.window.Event('change', { bubbles: true }));
  await until(() => ed.querySelector('.je-lp-episode input:checked'));
  assert.equal(ed.querySelector('.je-lp-episode input:checked').value, '7', 'the line\'s episode is preselected');
  ed.querySelector('.je-lp-ieditor-done').click();
  assert.equal(root.querySelector('.je-lp-irow[data-i="1"] .je-lp-irow-title').textContent, "DC's Legends of Tomorrow");

  root.querySelector('.je-lp-new-name').value = 'JL';
  root.querySelector('.jellyseerr-modal-button-primary').click();
  await until(() => calls.some(c => c[0] === '/list-placeholders/playlists'));
  const entries = calls.find(c => c[0] === '/list-placeholders/playlists')[1].entries;
  assert.deepEqual(entries.map(e => e.placeholder.tmdbId), [141052, 791373, 75]);
  assert.equal(entries[2].placeholder.kind, 'episodes');
  assert.deepEqual(entries[2].placeholder.episodes, [{ s: 2, e: 7, title: 'Seven', airDate: '2016-12-01' }]);
});

test('"Accept all sure and likely matches" restores skipped rows and settles likely ones; "Show only entries to review" filters', async t => {
  const h = setupImport(t, { plugin: async (path, options = {}) => {
    if (path === '/list-placeholders/resolve') return { results: [ok(0, movie(1, 'A')), ok(1, movie(2, 'B'), { confidence: 'medium', reasons: ['closeMatch'] })] };
    return {};
  } });
  const root = h.lp.importer.open({ mode: 'new' }).modalElement;
  root.querySelector('.je-lp-import-text').value = 'A (2001)\nB (2002)';
  root.querySelector('.jellyseerr-modal-button-primary').click();
  await until(() => root.querySelector('.je-lp-import-progress').hidden);
  const set = (i, value) => { const s = root.querySelector(`.je-lp-irow[data-i="${i}"] .je-lp-irow-action`); s.value = value; s.dispatchEvent(new h.window.Event('change', { bubbles: true })); };
  set(0, 'skip');
  set(1, 'skip');
  assert.match(root.querySelector('.jellyseerr-modal-button-primary').textContent, /"count":0/);
  assert.equal(root.querySelector('.jellyseerr-modal-button-primary').disabled, true);
  // Picking an action settles a row: "to review" goes down even for Skip.
  assert.match(root.querySelector('.je-lp-import-summary').textContent, /"review":0/);
  root.querySelector('.je-lp-import-accept').click();
  assert.equal(root.querySelector('.je-lp-irow[data-i="0"] .je-lp-irow-action').value, 'placeholder');
  assert.equal(root.querySelector('.je-lp-irow[data-i="1"] .je-lp-irow-action').value, 'placeholder', 'likely matches are accepted too');
  assert.match(root.querySelector('.je-lp-irow[data-i="1"]').textContent, /listPlaceholders_import_confirmed/);
  assert.match(h.toasts.at(-1), /listPlaceholders_import_accepted\{&quot;count&quot;:2\}/);
  root.querySelector('.je-lp-import-accept').click();
  assert.match(h.toasts.at(-1), /listPlaceholders_import_accepted_none/, 'nothing left to accept is said, not silent');
  const only = root.querySelector('.je-lp-import-only-review');
  only.checked = true;
  only.dispatchEvent(new h.window.Event('change'));
  assert.ok(root.querySelector('.je-lp-import-rows').classList.contains('je-lp-only-review'));
  assert.ok(!root.querySelector('.je-lp-irow[data-i="1"]').classList.contains('je-lp-irow-review'));
  assert.ok(!root.querySelector('.je-lp-irow[data-i="0"]').classList.contains('je-lp-irow-review'));
});

test('"Accept all sure and likely matches" acts on a fresh review: likely rows leave "to review"; low, repeats and changed rows stay', async t => {
  const h = setupImport(t, { plugin: async (path, options = {}) => {
    if (path === '/list-placeholders/resolve') {
      return { results: [
        ok(0, movie(1, 'A')),
        ok(1, movie(2, 'B'), { confidence: 'medium', reasons: ['yearOff'] }),
        ok(2, movie(3, 'C'), { confidence: 'low', reasons: ['lowScore'] }),
        ok(3, movie(1, 'A'), { confidence: 'medium', reasons: ['lowScore'] })
      ] };
    }
    return {};
  } });
  const root = h.lp.importer.open({ mode: 'new' }).modalElement;
  root.querySelector('.je-lp-import-text').value = 'A (2001)\nB (2002)\nC (2003)\nA two (2001)';
  root.querySelector('.jellyseerr-modal-button-primary').click();
  await until(() => root.querySelector('.je-lp-import-progress').hidden);
  assert.match(root.querySelector('.je-lp-import-summary').textContent, /"review":3/);
  root.querySelector('.je-lp-import-accept').click();
  const action = i => root.querySelector(`.je-lp-irow[data-i="${i}"] .je-lp-irow-action`).value;
  assert.deepEqual([action(0), action(1), action(2), action(3)], ['placeholder', 'placeholder', 'skip', 'skip']);
  assert.match(root.querySelector('.je-lp-import-summary').textContent, /"review":2/);
  assert.match(h.toasts.at(-1), /listPlaceholders_import_accepted\{&quot;count&quot;:1\}/);
});

test('closing the modal aborts the running lookup', async t => {
  let signal = null;
  const h = setupImport(t, { plugin: (path, options = {}) => {
    if (path !== '/list-placeholders/resolve') return Promise.resolve({});
    signal = options.signal;
    return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
  } });
  const modal = h.lp.importer.open({ mode: 'new' });
  modal.modalElement.querySelector('.je-lp-import-text').value = 'A (2001)';
  modal.modalElement.querySelector('.jellyseerr-modal-button-primary').click();
  await until(() => signal);
  modal.close();
  assert.equal(signal.aborted, true);
});

test('source chip: last sync, pause reason, Sync now / options / Unlink', async t => {
  const calls = [];
  const linked = { kind: 'mdblist', url: 'https://mdblist.com/lists/a/b', title: 'Top <watched>', syncEnabled: true, removeDropped: false, lastSyncAt: '2026-10-10T10:00:00Z', lastSync: { state: 'ok', added: 2, removed: 1, kept: 0, unresolved: 3 } };
  const h = setupImport(t, { plugin: async (path, options = {}) => {
    calls.push([options.method || 'GET', path, plainJson(options.body ?? null)]);
    if (path.includes('/source/sync')) return { state: 'ok', added: 1, removed: 0, kept: 0, unresolved: 0, view: view({ rev: 5, source: linked }) };
    // An option change answers with the list still linked (the next queued change starts from it); Unlink without.
    if (options.method === 'PUT') return view({ rev: 6, source: { ...linked, syncEnabled: plainJson(options.body).syncEnabled } });
    return view({ rev: 7, source: null });
  } });
  const ctrl = { listId: LIST, listKind: 'playlist', listName: 'P', view: view({ source: linked }), load: () => {} };
  const bar = h.lp.toolbar.create(ctrl);
  h.document.body.appendChild(bar);
  assert.ok(bar.querySelector('.je-lp-import-btn'), 'editors get Import list');
  const chip = bar.querySelector('.je-lp-source-chip');
  assert.ok(chip);
  // the chip leads the end group, so it shrinks before the buttons wrap and wraps with them
  assert.deepEqual([...bar.querySelector('.je-lp-toolbar-end').children].map(el => el.className), ['je-lp-source-chip', 'je-lp-toolbar-btn', 'je-lp-toolbar-btn je-lp-import-btn']);
  assert.match(chip.textContent, /Top <watched>/);
  assert.equal(chip.querySelector('script, watched'), null);
  assert.match(chip.textContent, /listPlaceholders_sourceLastSync/);
  assert.ok(chip.textContent.includes('listPlaceholders_sourceSyncStats') && chip.textContent.includes('added\\":2'));

  chip.click();
  let items = [...h.document.querySelectorAll('.je-lp-menu-item')].map(b => b.textContent);
  assert.deepEqual(items, ['synclistPlaceholders_sourceSyncNow', 'check_boxlistPlaceholders_sourceKeepInSync', 'check_box_outline_blanklistPlaceholders_sourceRemoveDropped', 'open_in_newlistPlaceholders_source_open', 'link_offlistPlaceholders_sourceUnlink']);
  h.document.querySelectorAll('.je-lp-menu-item')[0].click();
  await until(() => calls.some(c => c[1].includes('/source/sync')));
  const sync = calls.find(c => c[1].includes('/source/sync'));
  assert.equal(sync[0], 'POST');
  assert.match(sync[1], /requestId=/);

  chip.click();
  h.document.querySelectorAll('.je-lp-menu-item')[1].click();
  await until(() => calls.some(c => c[0] === 'PUT'));
  const put = calls.find(c => c[0] === 'PUT');
  assert.equal(put[1], `/list-placeholders/${LIST}/source`);
  assert.equal(put[2].syncEnabled, false);
  assert.equal(put[2].removeDropped, false);
  assert.equal(put[2].url, linked.url);

  chip.click();
  items = h.document.querySelectorAll('.je-lp-menu-item');
  items[items.length - 1].click();
  await until(() => calls.some(c => c[0] === 'DELETE'));
  assert.match(calls.find(c => c[0] === 'DELETE')[1], new RegExp(`/list-placeholders/${LIST}/source\\?requestId=`));

  // Paused and unlinked states.
  ctrl.view = view({ source: { ...linked, pausedCode: 'linker_cannot_edit' } });
  h.lp.toolbar.update(bar, 0);
  assert.match(bar.querySelector('.je-lp-source-chip').textContent, /listPlaceholders_sourcePausedLinkerCannotEdit/);
  assert.ok(bar.querySelector('.je-lp-source-chip').classList.contains('je-lp-source-paused'));
  // an untitled source is named after its site
  ctrl.view = view({ source: { kind: 'chronolists', url: 'https://chronolists.com/dctv', syncEnabled: false, removeDropped: false } });
  h.lp.toolbar.update(bar, 0);
  assert.ok(bar.querySelector('.je-lp-source-name').textContent.includes('"name":"Chronolists"'));
  ctrl.view = view({ source: null });
  h.lp.toolbar.update(bar, 0);
  assert.equal(bar.querySelector('.je-lp-source-chip'), null);
});

test('no Import list without Seerr; the picker offers "New playlist from a list…"', async t => {
  const h = setupImport(t, { config: { JellyseerrEnabled: false } });
  const bar = h.lp.toolbar.create({ listId: LIST, listKind: 'playlist', view: view() });
  assert.equal(bar.querySelector('.je-lp-import-btn'), null);
  assert.ok(!h.lp.picker.listOptionsHtml({ playlists: [], collections: [] }).includes('__new_from_list__'));
  h.JE.pluginConfig.JellyseerrEnabled = true;
  assert.ok(h.lp.picker.listOptionsHtml({ playlists: [], collections: [] }).includes('__new_from_list__'));
});

test('Playlists library view: the global button sits next to New Playlist, survives re-renders and leaves with the view', async t => {
  const h = setupImport(t, { html: '<header><div class="toolbar"><div class="box"><button class="MuiButton"><svg data-testid="PlaylistAddIcon"></svg>New Playlist</button></div></div></header>' });
  const doc = h.document;
  h.window.location.hash = '#/playlists?topParentId=x&collectionType=playlists';
  h.lp.sourceUi.onViewShow(null, '#/playlists?topParentId=x&collectionType=playlists');
  const button = doc.querySelector('.je-lp-import-global');
  assert.ok(button);
  assert.equal(button.previousElementSibling.tagName, 'BUTTON');
  // React re-renders the toolbar box: the observer puts the button back.
  doc.querySelector('.box').innerHTML = '<button class="MuiButton"><svg data-testid="PlaylistAddIcon"></svg>New Playlist</button>';
  await until(() => doc.querySelector('.je-lp-import-global'), 50);
  doc.querySelector('.je-lp-import-global').click();
  await until(() => doc.querySelector('.je-lp-import-modal'));
  assert.ok(doc.querySelector('.je-lp-import-modal .je-lp-new-name'), 'creates a new playlist');
  h.lp.sourceUi.onViewShow(null, '#/movies?topParentId=y');
  assert.equal(doc.querySelector('.je-lp-import-global'), null);
  assert.equal(h.lp.sourceUi.isPlaylistsView('#/details?id=1'), false);
});

// ── Review round ────────────────────────────────────────────────────

test('placeholderFromCandidate keeps requested episodes TMDB does not list yet; open-ended ranges take the expanded season', t => {
  const h = setupImport(t);
  const imp = h.lp.importer;
  const partial = imp.placeholderFromCandidate(
    { mediaType: 'tv', tmdbId: 7, title: 'Show', season: { seasonNumber: 1, airDate: '2024-01-01' }, episodes: [{ s: 1, e: 8, title: 'Eight', airDate: '2024-02-01' }, { s: 1, e: 9, title: 'Nine', airDate: '2024-02-08' }] },
    { episodes: [{ s: 1, e: 8 }, { s: 1, e: 9 }, { s: 1, e: 10 }] }, 'episodes');
  assert.deepEqual(plainJson(partial.episodes), [{ s: 1, e: 8, title: 'Eight', airDate: '2024-02-01' }, { s: 1, e: 9, title: 'Nine', airDate: '2024-02-08' }, { s: 1, e: 10 }]);
  const open = imp.placeholderFromCandidate(
    { mediaType: 'tv', tmdbId: 7, title: 'Show', episodes: [5, 6, 7].map(e => ({ s: 1, e, title: `E${e}` })) },
    { episodes: [{ s: 1, e: 5 }], openEnded: true }, 'episodes');
  assert.deepEqual(plainJson(open.episodes.map(e => e.e)), [5, 6, 7]);
});

test('URL imports leave rows whose lookup failed out of the snapshot (the server would decline them)', async t => {
  const calls = [];
  const fetched = {
    kind: 'mdblist', provider: 'mdblist', url: 'https://mdblist.com/lists/a/b', title: 'L', total: 3, truncated: false,
    entries: [1, 2, 3].map(n => ({ title: `M${n}`, year: 2020, typeHint: 'movie', ids: { tmdb: n, tmdbType: 'movie' }, sourceKey: `movie|${n}||` }))
  };
  const h = setupImport(t, { plugin: async (path, options = {}) => {
    calls.push([path, plainJson(options.body ?? null)]);
    if (path === '/list-placeholders/source/providers') return { mdblist: true, syncEnabled: true };
    if (path === '/list-placeholders/source/fetch') return fetched;
    if (path === '/list-placeholders/resolve') {
      return { results: options.body.entries.map(e => e.index === 1 ? { index: 1, state: 'transient', confidence: 'none', candidates: [], reasons: [] } : ok(e.index, movie(e.ids.tmdb, e.title))) };
    }
    if (path === '/list-placeholders/playlists') return { listId: 'f'.repeat(32), name: 'L', result: { added: ['a'], addedAsItems: [], skipped: [] } };
    return {};
  } });
  const root = h.lp.importer.open({ mode: 'new' }).modalElement;
  root.querySelector('.je-lp-tab[data-tab="url"]').click();
  root.querySelector('.je-lp-import-url').value = fetched.url;
  root.querySelector('.jellyseerr-modal-button-primary').click();
  await until(() => root.querySelector('.je-lp-import-progress').hidden && root.querySelectorAll('.je-lp-irow').length === 3);
  assert.equal(root.querySelector('.je-lp-irow[data-i="1"] .je-lp-irow-action').value, 'skip');
  // Rows the reviewer skipped on purpose stay in the snapshot.
  const select = root.querySelector('.je-lp-irow[data-i="2"] .je-lp-irow-action');
  select.value = 'skip';
  select.dispatchEvent(new h.window.Event('change', { bubbles: true }));
  root.querySelector('.jellyseerr-modal-button-primary').click();
  await until(() => calls.some(c => c[0] === '/list-placeholders/playlists'));
  const body = calls.find(c => c[0] === '/list-placeholders/playlists')[1];
  assert.deepEqual(body.source.snapshotKeys, ['movie|1||', 'movie|3||']);
  assert.deepEqual(body.entries.map(e => e.sourceKey), ['movie|1||']);
});

test('a partial fetch that does not know how many entries it lost says so without a count (IMDb; review round)', async t => {
  const fetched = {
    kind: 'imdb', provider: 'imdb', url: 'https://www.imdb.com/list/ls000000001/', title: 'L', total: 5, truncated: false, partial: true, dropped: 0,
    entries: [1, 2].map(n => ({ title: `M${n}`, year: 2020, typeHint: 'movie', ids: { tmdb: n, tmdbType: 'movie' }, sourceKey: `movie|${n}||` }))
  };
  const h = setupImport(t, { plugin: async (path, options = {}) => {
    if (path === '/list-placeholders/source/providers') return { imdb: true, syncEnabled: true };
    if (path === '/list-placeholders/source/fetch') return fetched;
    if (path === '/list-placeholders/resolve') return { results: options.body.entries.map(e => ok(e.index, movie(e.ids.tmdb, e.title))) };
    return {};
  } });
  const root = h.lp.importer.open({ mode: 'new' }).modalElement;
  root.querySelector('.je-lp-tab[data-tab="url"]').click();
  root.querySelector('.je-lp-import-url').value = fetched.url;
  root.querySelector('.jellyseerr-modal-button-primary').click();
  await until(() => root.querySelector('.je-lp-import-progress').hidden && root.querySelectorAll('.je-lp-irow').length === 2);
  const note = root.querySelector('.je-lp-import-sync-note').textContent;
  assert.match(note, /listPlaceholders_sourcePartialUnknown/);
  assert.doesNotMatch(note, /"count":0/);
});

test('"Accept all high-confidence matches" keeps a match the user changed', async t => {
  const dune84 = movie(841, 'Dune', { year: 1984 });
  const dune21 = movie(438631, 'Dune', { year: 2021, releaseDate: '2021-09-15' });
  const calls = [];
  const h = setupImport(t, { plugin: async (path, options = {}) => {
    calls.push([path, plainJson(options.body ?? null)]);
    if (path === '/list-placeholders/resolve') return { results: [ok(0, dune84, { candidates: [dune84, dune21] }), ok(1, movie(2, 'B'))] };
    return { listId: 'f'.repeat(32), name: 'x', result: { added: [], addedAsItems: [], skipped: [] } };
  } });
  const root = h.lp.importer.open({ mode: 'new' }).modalElement;
  root.querySelector('.je-lp-import-text').value = 'Dune (2021)\nB (2002)';
  root.querySelector('.jellyseerr-modal-button-primary').click();
  await until(() => root.querySelector('.je-lp-import-progress').hidden);
  root.querySelector('.je-lp-irow[data-i="0"] .je-lp-irow-edit').click();
  const radio = root.querySelectorAll('.je-lp-ieditor-cand input')[1];
  radio.checked = true;
  radio.dispatchEvent(new h.window.Event('change', { bubbles: true }));
  root.querySelector('.je-lp-ieditor-done').click();
  const s = root.querySelector('.je-lp-irow[data-i="1"] .je-lp-irow-action');
  s.value = 'skip';
  s.dispatchEvent(new h.window.Event('change', { bubbles: true }));
  root.querySelector('.je-lp-import-accept').click();
  assert.equal(root.querySelector('.je-lp-irow[data-i="1"] .je-lp-irow-action').value, 'placeholder');
  root.querySelector('.je-lp-new-name').value = 'Dune';
  root.querySelector('.jellyseerr-modal-button-primary').click();
  await until(() => calls.some(c => c[0] === '/list-placeholders/playlists'));
  const entries = calls.find(c => c[0] === '/list-placeholders/playlists')[1].entries;
  assert.deepEqual(entries.map(e => e.placeholder.tmdbId), [438631, 2]);
});

test('an unconfirmed failed import locks the review and resends the identical request; a plugin error keeps it editable', async t => {
  const applies = [];
  let answer = 'gateway';
  const h = setupImport(t, { plugin: async (path, options = {}) => {
    if (path === '/list-placeholders/resolve') return resolveAll(options.body);
    if (path === `/list-placeholders/${LIST}/apply`) {
      applies.push(plainJson(options.body));
      if (answer === 'gateway') throw Object.assign(new Error('504'), { status: 504 });
      if (answer === 'plugin') throw Object.assign(new Error('500'), { status: 500, responseJSON: { code: 'list_update_failed', message: 'x' } });
      return { added: ['x'], addedAsItems: [], skipped: [], view: view() };
    }
    return {};
  } });
  const ctrl = { listId: LIST, listKind: 'playlist', listName: 'Marathon', view: view() };
  const root = h.lp.importer.open({ ctrl }).modalElement;
  root.querySelector('.je-lp-import-text').value = 'A (2001)\nB (2002)';
  const primary = root.querySelector('.jellyseerr-modal-button-primary');
  primary.click();
  await until(() => root.querySelector('.je-lp-import-progress').hidden);
  primary.click();
  await until(() => applies.length === 1 && !primary.disabled);
  assert.match(primary.textContent, /listPlaceholders_import_retry_apply/);
  assert.match(root.querySelector('.je-lp-import-summary').textContent, /listPlaceholders_import_unconfirmed/);
  assert.ok([...root.querySelectorAll('.je-lp-irow-action, .je-lp-irow-edit, .je-lp-import-position, .je-lp-import-accept, .je-lp-import-back')].every(el => el.disabled));
  // Even a forced edit is not sent: the retry is the same request.
  root.querySelector('.je-lp-import-position').value = 'start';
  answer = 'plugin';
  primary.click();
  await until(() => applies.length === 2 && !primary.disabled);
  assert.deepEqual(applies[1], applies[0]);
  // The plugin answered with an error: the review is editable again and edits are sent (same request id).
  assert.match(primary.textContent, /listPlaceholders_import_apply/);
  const select = root.querySelector('.je-lp-irow[data-i="1"] .je-lp-irow-action');
  assert.equal(select.disabled, false);
  select.value = 'skip';
  select.dispatchEvent(new h.window.Event('change', { bubbles: true }));
  answer = 'ok';
  primary.click();
  await until(() => applies.length === 3);
  assert.equal(applies[2].requestId, applies[0].requestId);
  assert.equal(applies[2].entries.length, 1);
  assert.deepEqual(applies[2].position, { atStart: true });
  assert.equal(h.lp.importer.isUnconfirmedFailure({ status: 0 }), true);
  assert.equal(h.lp.importer.isUnconfirmedFailure({ status: 409, responseJSON: { code: 'rev_conflict' } }), false);
});

test('source chip: failed syncs read as messages, never codes; a still-running Sync now keeps polling until the result lands', async t => {
  const realSetTimeout = setTimeout;
  const h = setupImport(t, { plugin: async () => ({}) });
  const sourceUi = h.lp.sourceUi;
  for (const [code, key] of [['not_found', 'listPlaceholders_import_err_list_not_found'], ['apply_failed', 'listPlaceholders_sourceFailedApply'], ['seerr_unavailable', 'listPlaceholders_import_err_seerr']]) {
    const text = sourceUi.lastSyncText({ lastSyncAt: '2026-10-10T10:00:00Z', lastSync: { state: 'failed', code }, lastSyncResult: 'raw' });
    assert.ok(text.includes(key), `${code} → ${text}`);
  }
  assert.ok(sourceUi.lastSyncText({ lastSyncAt: '2026-10-10T10:00:00Z', lastSync: { state: 'failed', code: 'weird' }, lastSyncResult: 'Readable text' }).includes('Readable text'));

  const linked = { kind: 'mdblist', url: 'https://mdblist.com/lists/a/b', syncEnabled: true, lastSyncAt: '2026-10-10T10:00:00Z', lastSync: { state: 'ok' } };
  let loads = 0;
  const ctrl = {
    listId: LIST, listKind: 'playlist', view: view({ source: linked }), isAlive: () => true,
    load: async () => { loads++; if (loads === 3) ctrl.view = view({ source: { ...linked, lastSyncAt: '2026-10-11T10:00:00Z', lastSync: { state: 'ok', added: 4 } } }); }
  };
  h.lp.api.syncSource = async () => ({ state: 'running', message: 'still running' });
  h.window.setTimeout = (fn) => realSetTimeout(fn, 0);
  const chip = h.document.createElement('button');
  const done = sourceUi.syncNow(ctrl, chip);
  await tick();
  assert.ok(chip.classList.contains('je-lp-source-busy'));
  await done;
  assert.equal(loads, 3);
  assert.ok(!chip.classList.contains('je-lp-source-busy'));
  assert.ok(h.toasts.some(m => m.includes('listPlaceholders_sourceLastSync') && m.includes('listPlaceholders_sourceSyncStats') && /added\\&quot;:4/.test(m)), h.toasts.join('\n'));
});

test('source chip: callers who do not see every entry get no sync counts; a linker who cannot see dropped entries reads as a pause (review round)', async t => {
  const h = setupImport(t, { plugin: async () => ({}) });
  const sourceUi = h.lp.sourceUi;
  const at = '2026-10-10T10:00:00Z';
  const hidden = sourceUi.lastSyncText({ lastSyncAt: at, countsHidden: true, lastSync: { state: 'ok', added: 0 } });
  assert.ok(hidden.includes('listPlaceholders_sourceLastSyncAt'), hidden);
  assert.ok(!hidden.includes('listPlaceholders_sourceSyncStats'), hidden);
  assert.ok(sourceUi.lastSyncText({ lastSyncAt: at, countsHidden: true, lastSync: { state: 'ok', partial: true } }).includes('listPlaceholders_sourceSyncPartial'));
  // Failures keep their reason for everyone.
  assert.ok(sourceUi.lastSyncText({ lastSyncAt: at, countsHidden: true, lastSync: { state: 'failed', code: 'not_found' } }).includes('listPlaceholders_import_err_list_not_found'));
  assert.ok(sourceUi.lastSyncText({ lastSyncAt: at, lastSync: { state: 'ok', added: 2 } }).includes('listPlaceholders_sourceSyncStats'));
  assert.equal(sourceUi.pausedText({ pausedCode: 'linker_cannot_see', pausedReason: 'raw' }), 'listPlaceholders_sourcePausedLinkerCannotSee');

  let refreshed = 0;
  const ctrl = { listId: LIST, listKind: 'collection', view: view({}), isAlive: () => true, load: async () => {}, afterRealItemsAdded: () => { refreshed++; } };
  h.lp.api.syncSource = async () => ({ state: 'ok', added: 0, countsHidden: true, message: 'Synced.' });
  await sourceUi.syncNow(ctrl, null);
  assert.ok(h.toasts.some(m => m.includes('listPlaceholders_sourceSynced')), h.toasts.join('\n'));
  assert.ok(!h.toasts.some(m => m.includes('listPlaceholders_sourceSyncStats')), h.toasts.join('\n'));
  assert.equal(refreshed, 1); // counts unknown: a collection refreshes its items anyway
  h.lp.api.syncSource = async () => ({ state: 'paused', code: 'linker_cannot_see', message: 'raw' });
  await sourceUi.syncNow(ctrl, null);
  assert.ok(h.toasts.some(m => m.includes('listPlaceholders_sourcePausedLinkerCannotSee')), h.toasts.join('\n'));
});

test('exact sources (chronolists): prepared rows skip /resolve; runs send all their keys and the fetch snapshot; listId on the fetch', async t => {
  const calls = [];
  const arrow = { mediaType: 'tv', tmdbId: 1412, title: 'Arrow', year: 2012, releaseDate: '2012-10-10', tvdbId: 257655, season: { seasonNumber: 1, episodeCount: 3, airDate: '2012-10-10', name: 'Season 1' } };
  const flash = {
    mediaType: 'tv', tmdbId: 60735, title: 'The Flash', year: 2014, releaseDate: '2014-10-07',
    season: { seasonNumber: 1, airDate: '2014-10-07' },
    episodes: [{ s: 1, e: 1, title: 'Pilot', airDate: '2014-10-07' }, { s: 1, e: 2, title: 'Fastest Man Alive', airDate: '2014-10-14' }],
    inLibrary: { itemId: 'e'.repeat(32), kind: 'episodes', episodeItemIds: ['e'.repeat(32)], complete: false }
  };
  const ironMan = movie(1726, 'Iron Man', { year: 2008, releaseDate: '2008-04-30', inLibrary: { itemId: 'd'.repeat(32), kind: 'movie', complete: true } });
  const prepared = (index, kind, match) => ({ index, state: 'ok', confidence: 'high', kind, match, candidates: [], reasons: [], alternatives: false });
  const fetched = {
    kind: 'chronolists', provider: 'chronolists', url: 'https://chronolists.com/dctv', title: 'DC Arrowverse', total: 6, truncated: false, dropped: 1, partial: true, grouped: true,
    snapshotKeys: ['tv|1412|1|1', 'tv|1412|1|2', 'tv|1412|1|3', 'movie|1726||', 'tv|60735|1|1', 'tv|60735|1|2'],
    entries: [
      { index: 0, title: 'Arrow', year: 2012, typeHint: 'tv', season: 1, ids: { tmdb: 1412, tmdbType: 'tv' }, sourceKey: 'tv|1412|1|1', sourceKeys: ['tv|1412|1|1', 'tv|1412|1|2', 'tv|1412|1|3'], prepared: prepared(0, 'season', arrow) },
      { index: 1, title: 'Iron Man', year: 2008, typeHint: 'movie', ids: { tmdb: 1726, tmdbType: 'movie' }, sourceKey: 'movie|1726||', sourceKeys: ['movie|1726||'], prepared: prepared(1, 'movie', ironMan) },
      { index: 2, title: 'The Flash', year: 2014, typeHint: 'tv', season: 1, episodes: [{ s: 1, e: 1 }, { s: 1, e: 2 }], ids: { tmdb: 60735, tmdbType: 'tv' }, sourceKey: 'tv|60735|1|1', sourceKeys: ['tv|60735|1|1', 'tv|60735|1|2'], prepared: prepared(2, 'episodes', flash) }
    ]
  };
  const h = setupImport(t, { plugin: async (path, options = {}) => {
    calls.push([path, plainJson(options.body ?? null)]);
    if (path === '/list-placeholders/source/providers') return { mdblist: true, chronolists: true, syncEnabled: true };
    if (path === '/list-placeholders/source/fetch') {
      if (options.body.url.includes('/help')) throw Object.assign(new Error('x'), { status: 502, responseJSON: { code: 'source_format_changed', message: 'changed' } });
      return fetched;
    }
    if (path === `/list-placeholders/${LIST}/apply`) return { added: ['a', 'b'], addedAsItems: ['d'.repeat(32), 'e'.repeat(32)], skipped: [], view: view() };
    return {};
  } });
  const ctrl = { listId: LIST, listKind: 'playlist', listName: 'Arrowverse', view: view() };
  const root = h.lp.importer.open({ ctrl }).modalElement;
  root.querySelector('.je-lp-tab[data-tab="url"]').click();
  await until(() => root.querySelector('.je-lp-import-providers').textContent.includes('Chronolists'));
  assert.ok(!root.querySelector('.je-lp-import-providers').textContent.includes('chronolists.com'), 'site name, not the domain');
  const url = root.querySelector('.je-lp-import-url');
  url.value = 'https://chronolists.com/help';
  root.querySelector('.jellyseerr-modal-button-primary').click();
  await until(() => root.querySelector('.je-lp-import-url-error').textContent);
  assert.equal(root.querySelector('.je-lp-import-url-error').textContent, 'listPlaceholders_sourceFormatChanged');
  url.value = fetched.url;
  root.querySelector('.jellyseerr-modal-button-primary').click();
  await until(() => root.querySelector('.je-lp-import-progress').hidden && root.querySelectorAll('.je-lp-irow').length === 3);

  // The fetch carried the target list; nothing went to /resolve.
  assert.deepEqual(calls.filter(c => c[0] === '/list-placeholders/source/fetch').map(c => c[1]), [{ url: 'https://chronolists.com/help', listId: LIST }, { url: fetched.url, listId: LIST }]);
  assert.equal(calls.filter(c => c[0] === '/list-placeholders/resolve').length, 0);
  assert.match(root.querySelector('.je-lp-import-source').textContent, /^listPlaceholders_import_fetched_grouped.*"count":3.*"total":6/);
  assert.match(root.querySelector('.je-lp-import-sync-note').textContent, /listPlaceholders_sourcePartial\{"count":1\}/);
  // In-library movie and the partly present run are "From your library"; the season is a placeholder.
  assert.deepEqual(Array.from(root.querySelectorAll('.je-lp-irow-action')).map(s => s.value), ['placeholder', 'item', 'item']);
  assert.match(root.querySelector('.je-lp-irow[data-i="2"]').textContent, /listPlaceholders_import_in_library_part\{"count":1,"total":2\}/);

  root.querySelector('.jellyseerr-modal-button-primary').click();
  await until(() => calls.some(c => c[0].endsWith('/apply')));
  const body = calls.find(c => c[0].endsWith('/apply'))[1];
  assert.deepEqual(body.entries.map(e => [e.type, e.sourceKey, e.sourceKeys]), [
    ['placeholder', 'tv|1412|1|1', ['tv|1412|1|1', 'tv|1412|1|2', 'tv|1412|1|3']],
    ['item', 'movie|1726||', ['movie|1726||']],
    ['placeholder', 'tv|60735|1|1', ['tv|60735|1|1', 'tv|60735|1|2']]
  ]);
  assert.deepEqual(body.entries[0].placeholder, { kind: 'season', mediaType: 'tv', tmdbId: 1412, title: 'Arrow', year: 2012, releaseDate: '2012-10-10', tvdbId: 257655, seasonNumber: 1, episodeTotal: 3 });
  assert.deepEqual(body.entries[2].placeholder.episodes, [{ s: 1, e: 1, title: 'Pilot', airDate: '2014-10-07' }, { s: 1, e: 2, title: 'Fastest Man Alive', airDate: '2014-10-14' }]);
  assert.deepEqual(body.source.snapshotKeys, fetched.snapshotKeys);
});

test('snapshotKeys: a grouped fetch with every row decided sends its own keys; otherwise each decided row sends all of its keys', t => {
  const h = setupImport(t);
  const imp = h.lp.importer;
  const row = (keys, extra = {}) => ({ entry: { sourceKey: keys[0], sourceKeys: keys }, result: { state: 'ok' }, failed: false, ...extra });
  const rows = [row(['tv|1|1|1', 'tv|1|1|2']), row(['movie|2||'])];
  const fetched = { grouped: true, entries: [{}, {}], snapshotKeys: ['tv|1|1|1', 'tv|1|1|2', 'movie|2||'] };
  assert.deepEqual(plainJson(imp.snapshotKeys(rows, fetched)), fetched.snapshotKeys);
  // A row whose lookup failed stays out, with every key of its run.
  rows[0].failed = true;
  assert.deepEqual(plainJson(imp.snapshotKeys(rows, fetched)), ['movie|2||']);
  rows[0].failed = false;
  assert.deepEqual(plainJson(imp.snapshotKeys([...rows, { entry: { sourceKey: 'movie|3||' }, result: { state: 'ok' } }])), ['tv|1|1|1', 'tv|1|1|2', 'movie|2||', 'movie|3||']);
  assert.equal(imp.sourceErrorKey('source_format_changed'), 'listPlaceholders_sourceFormatChanged');
});

// ── QA round (the DC watch guide import, .notes/dcimport-report.md) ──────────────────────────

test('QA: a row resolving to the same title as an earlier row is flagged, waits as Skip, is left out of the count and named in the result', async t => {
  const calls = [];
  const movieEdition = movie(703771, 'Deathstroke: Knights & Dragons - The Movie', { year: 2020, releaseDate: '2020-08-04' });
  const h = setupImport(t, { plugin: async (path, options = {}) => {
    calls.push([path, plainJson(options.body ?? null)]);
    if (path === '/list-placeholders/resolve') {
      return { results: [
        ok(0, movieEdition, { confidence: 'medium', reasons: ['lowScore'] }),
        ok(1, movieEdition),
        ok(2, movie(5, 'Other', { year: 2020 }))
      ] };
    }
    return { listId: 'f'.repeat(32), name: 'x', result: { added: ['a', 'b'], addedAsItems: [], skipped: [{ index: 1, reason: 'duplicate', sameAs: 0 }] } };
  } });
  const root = h.lp.importer.open({ mode: 'new' }).modalElement;
  root.querySelector('.je-lp-import-text').value = '### Deathstroke animation\n\n'
    + '1. Deathstroke: Knights & Dragons (2020) · Alternate edition · Released — Short-series release; the film expands it.\n'
    + '2. Deathstroke: Knights & Dragons: The Movie (2020) · Film · Released\n'
    + '3. Other (2020) · Film · Released';
  root.querySelector('.jellyseerr-modal-button-primary').click();
  await until(() => root.querySelector('.je-lp-import-progress').hidden);

  // One section pasted: the playlist is named after its heading.
  assert.equal(root.querySelector('.je-lp-new-name').value, 'Deathstroke animation');
  const row1 = () => root.querySelector('.je-lp-irow[data-i="1"]');
  assert.match(row1().querySelector('.je-lp-irow-hint').textContent, /listPlaceholders_import_same_title\{"row":1\}/);
  assert.equal(row1().querySelector('.je-lp-irow-action').value, 'skip');
  assert.ok(row1().classList.contains('je-lp-irow-review'));
  const primary = root.querySelector('.jellyseerr-modal-button-primary');
  assert.match(primary.textContent, /"count":2/);

  // Kept anyway: still flagged and still not counted (the server drops it), but no longer "to review".
  const select = row1().querySelector('.je-lp-irow-action');
  select.value = 'placeholder';
  select.dispatchEvent(new h.window.Event('change', { bubbles: true }));
  assert.match(primary.textContent, /"count":2/);
  assert.match(row1().querySelector('.je-lp-irow-hint').textContent, /same_title/);
  assert.ok(!row1().classList.contains('je-lp-irow-review'));

  primary.click();
  await until(() => h.toasts.some(m => m.includes('listPlaceholders_import_done_toast')));
  const sent = calls.find(c => c[0] === '/list-placeholders/playlists')[1];
  assert.equal(sent.entries.length, 3, 'a row the user kept is sent; the server reports it');
  const toast = h.toasts.find(m => m.includes('listPlaceholders_import_done_toast'));
  assert.match(toast, /listPlaceholders_import_done_same\{&quot;count&quot;:1,&quot;rows&quot;:&quot;2 \(= 1\)&quot;\}/);
});

test('QA: custom entries keep the qualifier and the line\'s type; dateless matches keep the line\'s year', t => {
  const h = setupImport(t);
  const imp = h.lp.importer;
  assert.deepEqual(plainJson(imp.customFromEntry({ title: 'Wonder Woman', qualifier: 'DCU film', typeHint: 'movie', status: 'tba', note: 'New screenplay.' })),
    { kind: 'custom', mediaType: 'movie', title: 'Wonder Woman (DCU film)', note: 'New screenplay.' });
  assert.equal(imp.customFromEntry({ title: 'Blue Beetle', qualifier: 'animated series', typeHint: 'tv' }).mediaType, 'tv');
  // "Compilation" / "TV special" lines carry no type: the closest match's type decides, else movie.
  assert.equal(imp.customFromEntry({ title: 'The Batman/Superman Hour', year: 1968 }, { mediaType: 'tv' }).mediaType, 'tv');
  assert.equal(imp.customFromEntry({ title: 'Some Special', year: 1968 }).mediaType, 'movie');
  assert.equal(imp.customFromEntry({ title: 'A film', typeHint: 'movie' }, { mediaType: 'tv' }).mediaType, 'movie');

  const knightsEnd = { mediaType: 'movie', tmdbId: 1389764, title: 'Batman: Knightfall Part 3: KnightsEnd' };
  assert.equal(imp.placeholderFromCandidate(knightsEnd, { year: 2027 }, 'movie').year, 2027);
  assert.equal(imp.placeholderFromCandidate(knightsEnd, { date: '2027-05-01' }, 'movie').year, 2027);
  assert.equal(imp.placeholderFromCandidate(movie(1, 'Dated', { year: 2013 }), { year: 2027 }, 'movie').year, 2013);
});

test('QA: the review shows the line, not an unchosen match: custom rows drop the match\'s chip and hints; low rows offer the closest match', t => {
  const h = setupImport(t);
  const imp = h.lp.importer;
  const tas = { mediaType: 'tv', tmdbId: 4303, title: 'Superman: The Animated Series', year: 1996, posterPath: '/tas.jpg' };
  const result = ok(0, tas, { confidence: 'low', reasons: ['lowScore', 'typeMismatch'] });
  const base = { i: 5, entry: { title: 'The New Batman/Superman Adventures', year: 1997, raw: 'x', line: 8 }, result, cands: imp.candidateList(result), cand: 0 };
  const box = h.document.createElement('div');

  box.innerHTML = imp.rowHtml({ ...base, action: 'skip' }, { listKind: 'playlist' });
  assert.equal(box.querySelector('.je-lp-irow-title').textContent, 'The New Batman/Superman Adventures');
  assert.equal(box.querySelector('.je-lp-irow-poster img'), null, 'no poster of a title that is not imported');
  assert.match(box.querySelector('.je-lp-irow-hint').textContent, /listPlaceholders_import_closest/);
  assert.match(box.querySelector('.je-lp-irow-meta').textContent, /listPlaceholders_import_conf_low/);

  box.innerHTML = imp.rowHtml({ ...base, action: 'custom', entry: { ...base.entry, qualifier: 'broadcast package' } }, { listKind: 'playlist' });
  assert.equal(box.querySelector('.je-lp-irow-title').textContent, 'The New Batman/Superman Adventures (broadcast package)');
  assert.equal(box.querySelector('.je-lp-chip'), null, 'no "Unsure" for a match that is not used');
  assert.equal(box.querySelector('.je-lp-irow-hint'), null);
  assert.match(box.querySelector('.je-lp-irow-meta').textContent, /listPlaceholders_kind_custom/);

  box.innerHTML = imp.rowHtml({ ...base, action: 'placeholder' }, { listKind: 'playlist' });
  assert.equal(box.querySelector('.je-lp-irow-title').textContent, 'Superman: The Animated Series');
  assert.ok(box.querySelector('.je-lp-irow-poster img'));
});

test('QA: Change match says when a search finds nothing new, waits for the seasons before Done, and shows the library state of the new match', async t => {
  const calls = [];
  let releaseDetails;
  const detailsGate = new Promise((resolve) => { releaseDetails = resolve; });
  const show = { mediaType: 'tv', tmdbId: 4303, title: 'Superman: The Animated Series', year: 1996 };
  const h = setupImport(t, {
    search: async (query) => (query.includes('nothing') ? { results: [] } : query.includes('same')
      ? { results: [{ id: 4303, mediaType: 'tv', name: 'Superman: The Animated Series', firstAirDate: '1996-09-06' }] }
      : { results: [{ id: 78081, mediaType: 'tv', name: 'Constantine: City of Demons', firstAirDate: '2018-03-24' }] }),
    plugin: async (path, options = {}) => {
      calls.push([path, plainJson(options.body ?? null)]);
      if (path !== '/list-placeholders/resolve') return {};
      if (options.body.entries[0].ids) {
        return { results: [ok(0, { mediaType: 'tv', tmdbId: 78081, title: 'Constantine: City of Demons', episodeTotal: 5, inLibrary: { itemId: 'e'.repeat(32), kind: 'series', episodeItemIds: ['a'.repeat(32), 'b'.repeat(32)], complete: false } })] };
      }
      return { results: [ok(0, show, { confidence: 'low', reasons: ['lowScore'] })] };
    }
  });
  h.JE.jellyseerrAPI.fetchTvShowDetails = async () => { await detailsGate; return { id: 1, name: 'Show', seasons: [{ seasonNumber: 1, episodeCount: 5, airDate: '2018-03-24' }] }; };
  const root = h.lp.importer.open({ mode: 'new' }).modalElement;
  root.querySelector('.je-lp-import-text').value = 'Constantine: City of Demons (2018)';
  root.querySelector('.jellyseerr-modal-button-primary').click();
  await until(() => root.querySelector('.je-lp-import-progress').hidden);
  root.querySelector('.je-lp-irow[data-i="0"] .je-lp-irow-edit').click();
  const ed = root.querySelector('.je-lp-ieditor');
  const done = ed.querySelector('.je-lp-ieditor-done');
  assert.equal(done.disabled, true, 'the season picker of the TV match is still loading');
  const query = ed.querySelector('.je-lp-ieditor-query');
  const search = async (text) => {
    query.value = text;
    query.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await until(() => !/searching/.test(ed.querySelector('.je-lp-ieditor-status').textContent));
  };
  await search('nothing at all');
  assert.match(ed.querySelector('.je-lp-ieditor-status').textContent, /listPlaceholders_import_search_none/);
  await search('same show');
  assert.match(ed.querySelector('.je-lp-ieditor-status').textContent, /listPlaceholders_import_search_no_new/);
  await search('constantine');
  assert.equal(ed.querySelector('.je-lp-ieditor-status').textContent, '');
  const radio = ed.querySelectorAll('.je-lp-ieditor-cand input')[1];
  radio.checked = true;
  radio.dispatchEvent(new h.window.Event('change', { bubbles: true }));
  assert.equal(done.disabled, true);
  releaseDetails();
  await until(() => !done.disabled);
  done.click();

  // The library state of the new match is looked up and shown: the server would put those episodes in anyway.
  await until(() => calls.some(c => c[1]?.entries?.[0]?.ids));
  assert.deepEqual(calls.find(c => c[1]?.entries?.[0]?.ids)[1].entries[0], { index: 0, title: 'Constantine: City of Demons', ids: { tmdb: 78081, tmdbType: 'tv' } });
  await until(() => root.querySelector('.je-lp-irow[data-i="0"] .je-lp-chip-lib'));
  const row = root.querySelector('.je-lp-irow[data-i="0"]');
  assert.equal(row.querySelector('.je-lp-irow-action').value, 'item');
  assert.match(row.querySelector('.je-lp-chip-lib').textContent, /listPlaceholders_import_in_library_part\{"count":2,"total":5\}/);
});

test('QA: counts read "1 title" / "2 titles" through the singular|plural strings', t => {
  const h = setupImport(t);
  const strings = { 'listPlaceholders_import_parse_summary': '{count} title found|{count} titles found', listPlaceholders_episodes_of: '{filled} of {total} episode|{filled} of {total} episodes' };
  h.JE.t = (key, params = {}) => Object.entries(params).reduce((text, [k, v]) => text.replaceAll(`{${k}}`, v), strings[key] || key);
  assert.equal(h.lp.tn('listPlaceholders_import_parse_summary', { count: 1 }), '1 title found');
  assert.equal(h.lp.tn('listPlaceholders_import_parse_summary', { count: 2 }), '2 titles found');
  assert.equal(h.lp.tn('listPlaceholders_import_parse_summary', { count: 0 }), '0 titles found');
  assert.equal(h.lp.tn('listPlaceholders_episodes_of', { filled: 1, total: 1 }, 'total'), '1 of 1 episode');
  assert.equal(h.lp.tn('listPlaceholders_other', { count: 1 }), 'listPlaceholders_other', 'a string without forms is used as is');
});

test('QA: a list source entry with the same title as an earlier one is flagged but still sent (the sync counts it as present)', async t => {
  const calls = [];
  const fetched = {
    kind: 'mdblist', provider: 'mdblist', url: 'https://mdblist.com/lists/a/b', title: 'Twice', total: 2, truncated: false,
    entries: [
      { title: 'One', year: 2020, typeHint: 'movie', ids: { tmdb: 1, tmdbType: 'movie' }, sourceKey: 'movie|1||' },
      { title: 'One again', year: 2020, typeHint: 'movie', ids: { imdb: 'tt0000001' }, sourceKey: 'imdb|tt0000001||' }
    ]
  };
  const h = setupImport(t, { plugin: async (path, options = {}) => {
    calls.push([path, plainJson(options.body ?? null)]);
    if (path === '/list-placeholders/source/providers') return { mdblist: true, syncEnabled: true };
    if (path === '/list-placeholders/source/fetch') return fetched;
    if (path === '/list-placeholders/resolve') return { results: options.body.entries.map(e => ok(e.index, movie(1, 'One'))) };
    return { listId: 'f'.repeat(32), name: 'Twice', result: { added: ['a'], addedAsItems: [], skipped: [{ index: 1, reason: 'duplicate', sameAs: 0 }] } };
  } });
  const root = h.lp.importer.open({ mode: 'new' }).modalElement;
  root.querySelector('.je-lp-tab[data-tab="url"]').click();
  root.querySelector('.je-lp-import-url').value = 'https://mdblist.com/lists/a/b';
  root.querySelector('.jellyseerr-modal-button-primary').click();
  await until(() => root.querySelector('.je-lp-import-progress').hidden && root.querySelectorAll('.je-lp-irow').length === 2);
  const row = root.querySelector('.je-lp-irow[data-i="1"]');
  assert.match(row.querySelector('.je-lp-irow-hint').textContent, /listPlaceholders_import_same_title/);
  assert.equal(row.querySelector('.je-lp-irow-action').value, 'placeholder');
  assert.match(root.querySelector('.jellyseerr-modal-button-primary').textContent, /"count":1/);
  root.querySelector('.jellyseerr-modal-button-primary').click();
  await until(() => calls.some(c => c[0] === '/list-placeholders/playlists'));
  assert.deepEqual(calls.find(c => c[0] === '/list-placeholders/playlists')[1].entries.map(e => e.sourceKey), ['movie|1||', 'imdb|tt0000001||']);
});

// ── QA review round ──────────────────────────────────────────────────────────────────────────

test('QA review: "Add both" with both versions in the library counts both items (each item is its own title)', t => {
  const h = setupImport(t);
  const imp = h.lp.importer;
  const jl = movie(141052, 'Justice League', { alternative: 0, inLibrary: { itemId: 'a'.repeat(32), kind: 'movie', title: 'JL' } });
  const zs = movie(791373, "Zack Snyder's Justice League", { alternative: 1, inLibrary: { itemId: 'b'.repeat(32), kind: 'movie', title: 'ZSJL' } });
  const result = ok(0, jl, { confidence: 'low', alternatives: true, candidates: [jl, zs] });
  const row = { i: 0, entry: { title: 'Justice League' }, result, cands: imp.candidateList(result), cand: 0, both: true, action: 'item' };
  assert.deepEqual(plainJson(imp.rowEntries(row, 'playlist')), [{ type: 'item', itemId: 'a'.repeat(32) }, { type: 'item', itemId: 'b'.repeat(32) }]);
  assert.equal(imp.summarize([row], 'playlist').entries, 2);
  // A later row of the first version still repeats it (its item and its title).
  const again = { ...row, i: 1, both: false };
  assert.equal(imp.summarize([row, again], 'playlist').entries, 2);
});

test('QA review: a retried lookup that resolves to the title of a later, shown row flags that row and moves it to Skip', async t => {
  let n = 0;
  const x = movie(77, 'Movie X', { year: 2020 });
  const h = setupImport(t, { plugin: async (path, options = {}) => {
    if (path !== '/list-placeholders/resolve') return {};
    n++;
    // Row 0 is transient on the first pass and resolves to the same movie as row 1 on the resubmit.
    return { results: options.body.entries.map(e => (e.index === 0 && n === 1) ? { index: 0, state: 'transient', confidence: 'none', candidates: [], reasons: [] } : ok(e.index, x)) };
  } });
  const root = h.lp.importer.open({ mode: 'new' }).modalElement;
  root.querySelector('.je-lp-import-text').value = 'Movie X (2020)\nMovie X again (2020)\nOther (2001)';
  root.querySelector('.jellyseerr-modal-button-primary').click();
  await until(() => root.querySelector('.je-lp-import-progress').hidden, 2000);
  assert.equal(n, 2);
  const row = i => root.querySelector(`.je-lp-irow[data-i="${i}"]`);
  assert.equal(row(0).querySelector('.je-lp-irow-action').value, 'placeholder');
  assert.equal(row(1).querySelector('.je-lp-irow-action').value, 'skip');
  assert.match(row(1).querySelector('.je-lp-irow-hint').textContent, /listPlaceholders_import_same_title\{"row":1\}/);
  assert.ok(row(1).classList.contains('je-lp-irow-review'));
});

test('QA review: a row the user settled keeps its action when a retried lookup flags it', async t => {
  let fail = true;
  const x = movie(77, 'Movie X', { year: 2020 });
  const h = setupImport(t, { plugin: async (path, options = {}) => {
    if (path !== '/list-placeholders/resolve') return {};
    return { results: options.body.entries.map(e => (e.index === 0 && fail) ? { index: 0, state: 'transient', confidence: 'none', candidates: [], reasons: [] } : ok(e.index, x)) };
  } });
  const root = h.lp.importer.open({ mode: 'new' }).modalElement;
  root.querySelector('.je-lp-import-text').value = 'Movie X (2020)\nMovie X again (2020)';
  root.querySelector('.jellyseerr-modal-button-primary').click();
  await until(() => root.querySelector('.je-lp-import-progress').hidden, 2000);
  const row = i => root.querySelector(`.je-lp-irow[data-i="${i}"]`);
  assert.equal(row(0).querySelector('.je-lp-irow-action').value, 'skip', 'row 0 failed twice');
  const select = row(1).querySelector('.je-lp-irow-action');
  select.value = 'placeholder';
  select.dispatchEvent(new h.window.Event('change', { bubbles: true }));
  fail = false;
  root.querySelector('.je-lp-import-retry').click();
  await until(() => row(0).querySelector('.je-lp-irow-action').value === 'placeholder', 2000);
  assert.equal(row(1).querySelector('.je-lp-irow-action').value, 'placeholder', 'the user kept it');
  assert.match(row(1).querySelector('.je-lp-irow-hint').textContent, /listPlaceholders_import_same_title/);
});

test('QA review: Change match on a dateless show keeps the line\'s year', async t => {
  const calls = [];
  const announced = { mediaType: 'tv', tmdbId: 300001, title: 'Announced Show', year: undefined };
  const h = setupImport(t, {
    tvDetails: { id: 300001, name: 'Announced Show', seasons: [{ seasonNumber: 1, episodeCount: 8 }] },
    plugin: async (path, options = {}) => {
      calls.push([path, plainJson(options.body ?? null)]);
      if (path === '/list-placeholders/resolve') return { results: [ok(0, announced)] };
      return { listId: 'f'.repeat(32), name: 'x', result: { added: [], addedAsItems: [], skipped: [] } };
    }
  });
  const root = h.lp.importer.open({ mode: 'new' }).modalElement;
  root.querySelector('.je-lp-import-text').value = 'Announced Show (2027)';
  root.querySelector('.jellyseerr-modal-button-primary').click();
  await until(() => root.querySelector('.je-lp-import-progress').hidden);
  root.querySelector('.je-lp-irow[data-i="0"] .je-lp-irow-edit').click();
  const done = root.querySelector('.je-lp-ieditor .je-lp-ieditor-done');
  await until(() => !done.disabled);
  done.click();
  assert.match(root.querySelector('.je-lp-irow[data-i="0"] .je-lp-irow-meta').textContent, /2027/);
  root.querySelector('.je-lp-new-name').value = 'A';
  root.querySelector('.jellyseerr-modal-button-primary').click();
  await until(() => calls.some(c => c[0] === '/list-placeholders/playlists'));
  const ph = calls.find(c => c[0] === '/list-placeholders/playlists')[1].entries[0].placeholder;
  assert.equal(ph.kind, 'series');
  assert.equal(ph.year, 2027);
  assert.ok(!ph.releaseDate);
});

test('QA review: lp.tn keeps a "|" inside a value (a list titled "Movies | TV")', t => {
  const h = setupImport(t);
  const strings = { listPlaceholders_import_fetched: '{title}: {count} entry|{title}: {count} entries' };
  h.JE.t = (key, params = {}) => Object.entries(params).reduce((text, [k, v]) => text.replaceAll(`{${k}}`, v), strings[key] || key);
  assert.equal(h.lp.tn('listPlaceholders_import_fetched', { title: 'Movies | TV', count: 2 }), 'Movies | TV: 2 entries');
  assert.equal(h.lp.tn('listPlaceholders_import_fetched', { title: 'Movies | TV', count: 1 }), 'Movies | TV: 1 entry');
  assert.equal(h.lp.tn('listPlaceholders_import_fetched', { title: 'A|B|C', count: 3 }), 'A|B|C: 3 entries');
});
