import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, plain } from '../../helpers/harness.mjs';

// The import review model and transport (JE.arrListImport, track 4c2a), ported from #936's listplaceholders-import
// tests (the pure decisions, entries, counts and texts) plus the transport and resolve loop on the new routes: no network
// on load, sequential chunks of 25, busy / parental-pending retries, one resubmit of transient rows, prepared rows never
// sent, a missing title lookup stops with its message, answers after a user switch are dropped.

const plainJson = value => JSON.parse(JSON.stringify(value));
const movie = (tmdbId, title, extra = {}) => ({ mediaType: 'movie', tmdbId, title, year: 2013, releaseDate: '2013-06-12', posterPath: `/p${tmdbId}.jpg`, overview: 'o', score: 160, ...extra });
const ok = (index, match, extra = {}) => ({ index, state: 'ok', confidence: 'high', kind: match?.mediaType === 'tv' ? 'series' : 'movie', match, candidates: match ? [match] : [], reasons: [], alternatives: false, ...extra });
const BASE = 'http://jellyfin.test/JellyfinEnhanced/acquire/lists/import';

/**
 * Loads the parser and the import module with a fetch fixture: `routes` maps "METHOD /path" to a handler returning
 * {status, body, headers}.
 */
function load(t, { routes = {}, config = { ArrListImportEnabled: true, ArrListSourcesEnabled: true }, strings } = {}) {
  const calls = [];
  const state = { epoch: 1 };
  const fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init, body: init.body ? JSON.parse(init.body) : null });
    const path = String(url).replace(BASE, '');
    const handler = routes[`${init.method || 'GET'} ${path}`];
    if (!handler) throw new Error(`unexpected ${init.method || 'GET'} ${path}`);
    const { status = 200, body = null, headers = {} } = await handler(calls[calls.length - 1].body, init);
    return { status, headers: { get: name => headers[name] ?? null }, text: async () => (body == null ? '' : JSON.stringify(body)) };
  };
  // Keys (with their params) stand for the text, unless a test gives the strings.
  const t9n = strings
    ? ((key, params = {}) => Object.entries(params).reduce((text, [k, v]) => text.replaceAll(`{${k}}`, v), strings[key] || key))
    : ((key, params) => key + (params ? JSON.stringify(params) : ''));
  const h = createHarness({ fetch, JE: { pluginConfig: config, session: { getEpoch: () => state.epoch }, t: t9n } });
  t.after(() => h.close());
  h.load('arr/lists/list-parser.js');
  h.load('arr/lists/list-import.js');
  const imp = h.JE.arrListImport;
  return { h, imp, review: imp.review, calls, state };
}

// ── Pure model (ported) ─────────────────────────────────────────────

test('no network on load; the switches come from public config', t => {
  const { imp, calls } = load(t);
  assert.equal(calls.length, 0);
  assert.equal(imp.enabled(), true);
  assert.equal(imp.sourcesEnabled(), true);
  assert.ok(Object.isFrozen(imp.review));
  assert.equal(typeof imp.parser.parse, 'function');
  const off = load(t, { config: {} }).imp;
  assert.equal(off.enabled(), false);
  assert.equal(off.sourcesEnabled(), false);
});

test('toImportEntry keeps the fields resolve reads and drops invalid ones', t => {
  const { review } = load(t);
  const dto = review.toImportEntry({
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

test('toImportEntry sends each alternative\'s own episodes and open-ended flag (F52)', t => {
  const { review } = load(t);
  const dto = plainJson(review.toImportEntry({
    title: 'Flash', episodes: [{ s: 1, e: 8 }],
    alternatives: [
      { title: 'Flash', season: 1, episodes: [{ s: 1, e: 8 }] },
      { title: 'Doctor Who', season: 1, episodes: [{ s: 1, e: 5 }], openEnded: true },
      { title: 'Arrow', episodes: Array.from({ length: 120 }, (_, i) => ({ s: 3, e: i + 1 })) }
    ]
  }, 0));
  assert.deepEqual(dto.alternatives[0], { title: 'Flash', season: 1, episodes: [{ s: 1, e: 8 }] });
  assert.deepEqual(dto.alternatives[1], { title: 'Doctor Who', season: 1, episodes: [{ s: 1, e: 5 }], openEnded: true });
  assert.equal(dto.alternatives[2].episodes.length, 100);
});

test('placeholderFromCandidate mirrors the server per kind (C4 dates) and validates fields', t => {
  const { review } = load(t);
  assert.deepEqual(plainJson(review.placeholderFromCandidate(movie(49521, 'Man of Steel', { posterPath: 'javascript:1', imdbId: 'tt0770828' }), { note: 'Start here.' }, 'movie')),
    { kind: 'movie', mediaType: 'movie', tmdbId: 49521, title: 'Man of Steel', year: 2013, releaseDate: '2013-06-12', overview: 'o', imdbId: 'tt0770828', note: 'Start here.' });
  const season = review.placeholderFromCandidate({ mediaType: 'tv', tmdbId: 110492, title: 'Peacemaker', year: 2022, releaseDate: '2022-01-13', tvdbId: 391153, season: { seasonNumber: 1, episodeCount: 8, airDate: '2022-01-13' } }, { season: 1 }, 'season');
  assert.deepEqual([season.kind, season.seasonNumber, season.episodeTotal, season.tvdbId], ['season', 1, 8, 391153]);
  const episodes = review.placeholderFromCandidate({ mediaType: 'tv', tmdbId: 60735, title: 'The Flash', season: { seasonNumber: 8, airDate: '2021-11-16' }, episodes: [{ s: 8, e: 2, title: 'B', airDate: '2021-11-23' }, { s: 8, e: 1, title: 'A', airDate: '2021-11-16' }] }, { episodes: [{ s: 8, e: 1 }, { s: 8, e: 2 }] }, 'episodes');
  assert.deepEqual(plainJson(episodes.episodes), [{ s: 8, e: 1, title: 'A', airDate: '2021-11-16' }, { s: 8, e: 2, title: 'B', airDate: '2021-11-23' }]);
  assert.equal(episodes.releaseDate, '2021-11-16');
  const fromEntry = review.placeholderFromCandidate({ mediaType: 'tv', tmdbId: 1412, title: 'Arrow' }, { episodes: [{ s: 3, e: 8 }] }, 'episodes');
  assert.deepEqual([plainJson(fromEntry.episodes), fromEntry.seasonNumber], [[{ s: 3, e: 8 }], 3]);
  assert.equal(review.placeholderFromCandidate({ mediaType: 'tv', tmdbId: 5, title: 'B', alternative: 1 }, { season: 2 }, 'season').kind, 'series', 'the second version of "A S2 or B" is the whole show');
  assert.equal(review.placeholderFromCandidate({ mediaType: 'person', tmdbId: 5, title: 'x' }, {}, 'movie'), null);
  assert.equal(review.placeholderFromCandidate({ mediaType: 'tv', tmdbId: 5, title: 'x' }, {}, 'episodes').kind, 'series');
  // A spoiler-guarded candidate (no episode titles, no overview) still builds the exact entry.
  const guarded = review.placeholderFromCandidate({ mediaType: 'tv', tmdbId: 7, title: 'Show', spoilerGuarded: true, episodes: [{ s: 1, e: 9, airDate: '2020-01-01' }] }, { episodes: [{ s: 1, e: 9 }] }, 'episodes');
  assert.deepEqual(plainJson(guarded.episodes), [{ s: 1, e: 9, airDate: '2020-01-01' }]);
});

test('placeholderFromCandidate keeps requested episodes TMDB does not list yet; open-ended ranges take the expanded season', t => {
  const { review } = load(t);
  const partial = review.placeholderFromCandidate(
    { mediaType: 'tv', tmdbId: 7, title: 'Show', season: { seasonNumber: 1, airDate: '2024-01-01' }, episodes: [{ s: 1, e: 8, title: 'Eight', airDate: '2024-02-01' }, { s: 1, e: 9, title: 'Nine', airDate: '2024-02-08' }] },
    { episodes: [{ s: 1, e: 8 }, { s: 1, e: 9 }, { s: 1, e: 10 }] }, 'episodes');
  assert.deepEqual(plainJson(partial.episodes), [{ s: 1, e: 8, title: 'Eight', airDate: '2024-02-01' }, { s: 1, e: 9, title: 'Nine', airDate: '2024-02-08' }, { s: 1, e: 10 }]);
  const open = review.placeholderFromCandidate({ mediaType: 'tv', tmdbId: 7, title: 'Show', episodes: [5, 6, 7].map(e => ({ s: 1, e, title: `E${e}` })) }, { episodes: [{ s: 1, e: 5 }], openEnded: true }, 'episodes');
  assert.deepEqual(plainJson(open.episodes.map(e => e.e)), [5, 6, 7]);
});

test('the second alternative\'s placeholder uses its own season and episodes (F52)', t => {
  const { review } = load(t);
  const entry = (first, second) => ({
    title: 'Flash', typeHint: 'tv', kind: 'episodes', season: first.s, episodes: [first],
    alternatives: [{ title: 'Flash', typeHint: 'tv', season: first.s, episodes: [first] }, { title: 'Arrow', typeHint: 'tv', season: second.s, episodes: [second] }]
  });
  const bare = review.placeholderFromCandidate({ mediaType: 'tv', tmdbId: 1412, title: 'Arrow', alternative: 1 }, entry({ s: 1, e: 8 }, { s: 3, e: 9 }), 'episodes');
  assert.deepEqual([bare.kind, bare.seasonNumber, plainJson(bare.episodes)], ['episodes', 3, [{ s: 3, e: 9 }]]);
  const enriched = review.placeholderFromCandidate({ mediaType: 'tv', tmdbId: 1412, title: 'Arrow', alternative: 1, season: { seasonNumber: 3, episodeCount: 23 } }, entry({ s: 1, e: 8 }, { s: 3, e: 9 }), 'episodes');
  assert.deepEqual(plainJson(enriched.episodes), [{ s: 3, e: 9 }]);
  const same = review.placeholderFromCandidate({ mediaType: 'tv', tmdbId: 1412, title: 'Arrow', alternative: 1, season: { seasonNumber: 1 } }, entry({ s: 1, e: 8 }, { s: 1, e: 9 }), 'episodes');
  assert.deepEqual(plainJson(same.episodes), [{ s: 1, e: 9 }]);
  const first = review.placeholderFromCandidate({ mediaType: 'tv', tmdbId: 60735, title: 'The Flash', alternative: 0 }, entry({ s: 1, e: 8 }, { s: 3, e: 9 }), 'episodes');
  assert.deepEqual(plainJson(first.episodes), [{ s: 1, e: 8 }]);
  const whole = entry({ s: 1, e: 8 }, { s: 3, e: 9 });
  delete whole.alternatives[1].episodes;
  delete whole.alternatives[1].season;
  assert.equal(review.placeholderFromCandidate({ mediaType: 'tv', tmdbId: 1412, title: 'Arrow', alternative: 1 }, whole, 'episodes').kind, 'series');
  whole.alternatives[1].season = 2;
  const season = review.placeholderFromCandidate({ mediaType: 'tv', tmdbId: 1412, title: 'Arrow', alternative: 1 }, whole, 'episodes');
  assert.deepEqual([season.kind, season.seasonNumber], ['season', 2]);
});

test('default decisions: high/medium match, in-library items, TBA and no-match as custom, uncertain and hidden rows skipped', t => {
  const { review } = load(t);
  const lib = (kind, id = 'a'.repeat(32)) => ({ itemId: id, kind, title: 'L', complete: true });
  const row = (result, entry = { title: 'X' }, extra = {}) => ({ entry, result, cands: review.candidateList(result), cand: result.match ? 0 : -1, ...extra });
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
    [row(ok(0, { mediaType: 'tv', tmdbId: 2, title: 'S', season: { seasonNumber: 1 }, inLibrary: lib('season') }, { kind: 'season' })), 'collection', 'placeholder'],
    // A title the viewer hid with Hidden Content arrives capped at low: it waits for their choice.
    [row(ok(0, movie(1, 'A', { hidden: true }), { confidence: 'low', reasons: ['hidden'] })), 'playlist', 'skip']
  ];
  cases.forEach(([r, kind, expected], i) => assert.equal(review.defaultAction(r, kind), expected, `case ${i}`));
});

test('TV the library has (part of) is "From your library" and is sent as a placeholder the server expands', t => {
  const { review } = load(t);
  const ids = ['a', 'b'].map(c => c.repeat(32));
  const part = { mediaType: 'tv', tmdbId: 110492, title: 'Peacemaker', year: 2022, season: { seasonNumber: 1, episodeCount: 8, airDate: '2022-01-13' }, inLibrary: { itemId: 'c'.repeat(32), kind: 'season', episodeItemIds: ids, complete: false } };
  const row = { entry: { title: 'Peacemaker', season: 1, sourceKey: 'tv|110492|1|' }, result: ok(0, part, { kind: 'season' }), cands: [part], cand: 0 };
  for (const kind of ['playlist', 'collection']) {
    assert.equal(review.fromLibrary(part, kind), true, kind);
    assert.equal(review.defaultAction(row, kind), 'item', kind);
    const entries = plainJson(review.rowEntries({ ...row, action: 'item' }, kind));
    assert.equal(entries.length, 1);
    assert.equal(entries[0].type, 'placeholder', 'never the Season item or episode ids: the server inserts them (C1)');
    assert.equal(entries[0].placeholder.kind, 'season');
    assert.equal(entries[0].sourceKey, 'tv|110492|1|');
  }
  assert.equal(review.libraryChipText(part, 'playlist'), 'arr_list_import_in_library_part{"count":2,"total":8}');
  assert.equal(review.libraryChipText({ ...part, inLibrary: { ...part.inLibrary, complete: true } }, 'playlist'), 'arr_list_import_in_library');
  const episodes = { mediaType: 'tv', tmdbId: 60735, title: 'The Flash', episodes: [{ s: 1, e: 8 }, { s: 1, e: 9 }, { s: 1, e: 10 }], inLibrary: { itemId: ids[0], kind: 'episodes', episodeItemIds: [ids[0]], complete: false } };
  assert.equal(review.libraryChipText(episodes, 'playlist'), 'arr_list_import_in_library_part{"count":1,"total":3}');
  const empty = { mediaType: 'tv', tmdbId: 1399, title: 'Game of Thrones', inLibrary: { itemId: ids[1], kind: 'series', complete: false } };
  const emptyRow = { entry: { title: 'Game of Thrones' }, result: ok(0, empty), cands: [empty], cand: 0 };
  assert.equal(review.defaultAction(emptyRow, 'playlist'), 'placeholder');
  assert.equal(review.libraryChipText(empty, 'playlist'), '');
  assert.equal(review.defaultAction(emptyRow, 'collection'), 'item');
  assert.deepEqual(plainJson(review.rowEntries({ ...emptyRow, action: 'item' }, 'collection')), [{ type: 'item', itemId: ids[1] }]);
});

test('rowEntries: both versions in order, the source key on the first entry only, custom and skip', t => {
  const { review } = load(t);
  const jl = movie(141052, 'Justice League', { alternative: 0 });
  const zs = movie(791373, "Zack Snyder's Justice League", { alternative: 1, inLibrary: { itemId: 'b'.repeat(32), kind: 'movie', title: 'ZSJL' } });
  const result = ok(0, jl, { confidence: 'low', alternatives: true, candidates: [jl, zs] });
  const row = { entry: { title: 'Justice League', sourceKey: 'movie|141052||' }, result, cands: review.candidateList(result), cand: 0, both: true, action: 'item' };
  const entries = plainJson(review.rowEntries(row, 'playlist'));
  assert.equal(entries.length, 2);
  assert.deepEqual([entries[0].type, entries[0].placeholder.tmdbId, entries[0].sourceKey], ['placeholder', 141052, 'movie|141052||']);
  assert.deepEqual(entries[1], { type: 'item', itemId: 'b'.repeat(32) });
  assert.deepEqual(plainJson(review.rowEntries({ ...row, both: false, action: 'custom', entry: { title: 'Booster Gold', year: 2031, typeHint: 'tv', note: 'In development' } }, 'playlist')),
    [{ type: 'placeholder', placeholder: { kind: 'custom', mediaType: 'tv', title: 'Booster Gold', year: 2031, note: 'In development' } }]);
  assert.equal(review.rowEntries({ ...row, action: 'skip' }, 'playlist').length, 0);
});

test('long episode scopes become several entries of at most 100, and a chosen alternative brings the rest of its scope (R2)', t => {
  const { imp, review } = load(t);
  const placeholders = entries => plain(entries).map(e => e.placeholder);
  const numbers = ph => ph.episodes.map(e => `${e.s}x${e.e}`);
  const episodes = Array.from({ length: 146 }, (_, i) => ({ s: 1, e: i + 5, airDate: `2001-01-${String((i % 28) + 1).padStart(2, '0')}` }));
  const open = placeholders(review.rowEntries({ action: 'placeholder', cand: 0, result: { kind: 'episodes' }, entry: { title: 'Show', season: 1, episodes: [{ s: 1, e: 5 }], openEnded: true }, cands: [{ mediaType: 'tv', tmdbId: 9, title: 'Show', episodes }] }, 'playlist'));
  assert.deepEqual(open.map(p => p.episodes.length), [100, 46]);
  assert.deepEqual([open[0].episodes[0].e, open[1].episodes[0].e, open[1].releaseDate], [5, 105, episodes[100].airDate]);

  const [entry] = plain(imp.parser.parse('Doctor Who S1E5–S2E3 **or** Torchwood 1x01')).entries;
  const row = { action: 'placeholder', cand: 0, result: { kind: 'episodes' }, entry, cands: [{ mediaType: 'tv', tmdbId: 57243, title: 'Doctor Who', alternative: 0, posterPath: '/dw.jpg' }, { mediaType: 'tv', tmdbId: 1, title: 'Torchwood', alternative: 1 }] };
  const doctor = placeholders(review.rowEntries(row, 'playlist'));
  assert.deepEqual(doctor.map(numbers), [['1x5'], ['2x1', '2x2', '2x3']]);
  assert.equal(doctor[1].posterPath, '/dw.jpg');
  row.both = true;
  assert.deepEqual(placeholders(review.rowEntries(row, 'playlist')).map(numbers), [['1x5'], ['2x1', '2x2', '2x3'], ['1x1']]);

  const [long] = plain(imp.parser.parse('One Piece 1x01-150 **or** Naruto 1x01-150')).entries;
  const naruto = placeholders(review.rowEntries({ action: 'placeholder', cand: 1, result: { kind: 'episodes' }, entry: long, cands: [{ mediaType: 'tv', tmdbId: 37854, title: 'One Piece', alternative: 0 }, { mediaType: 'tv', tmdbId: 46260, title: 'Naruto', alternative: 1 }] }, 'playlist'));
  assert.deepEqual(naruto.map(p => [p.tmdbId, p.episodes.length, p.episodes[0].e]), [[46260, 100, 1], [46260, 50, 101]]);
});

test('custom entries keep the qualifier and the line\'s type; dateless matches keep the line\'s year (QA)', t => {
  const { review } = load(t);
  assert.deepEqual(plainJson(review.customFromEntry({ title: 'Wonder Woman', qualifier: 'DCU film', typeHint: 'movie', status: 'tba', note: 'New screenplay.' })),
    { kind: 'custom', mediaType: 'movie', title: 'Wonder Woman (DCU film)', note: 'New screenplay.' });
  assert.equal(review.customFromEntry({ title: 'Blue Beetle', qualifier: 'animated series', typeHint: 'tv' }).mediaType, 'tv');
  assert.equal(review.customFromEntry({ title: 'The Batman/Superman Hour', year: 1968 }, { mediaType: 'tv' }).mediaType, 'tv');
  assert.equal(review.customFromEntry({ title: 'Some Special', year: 1968 }).mediaType, 'movie');
  assert.equal(review.customFromEntry({ title: 'A film', typeHint: 'movie' }, { mediaType: 'tv' }).mediaType, 'movie');
  const knightsEnd = { mediaType: 'movie', tmdbId: 1389764, title: 'Batman: Knightfall Part 3: KnightsEnd' };
  assert.equal(review.placeholderFromCandidate(knightsEnd, { year: 2027 }, 'movie').year, 2027);
  assert.equal(review.placeholderFromCandidate(knightsEnd, { date: '2027-05-01' }, 'movie').year, 2027);
  assert.equal(review.placeholderFromCandidate(movie(1, 'Dated', { year: 2013 }), { year: 2027 }, 'movie').year, 2013);
  assert.equal(review.customFromEntry({ title: 'Show', season: 2 }).note, 'jellyseerr_season_name{"number":2}'); // the shared season string
});

test('"Add both" with both versions in the library counts both items; a repeat of one is left out (QA)', t => {
  const { review } = load(t);
  const jl = movie(141052, 'Justice League', { alternative: 0, inLibrary: { itemId: 'a'.repeat(32), kind: 'movie', title: 'JL' } });
  const zs = movie(791373, "Zack Snyder's Justice League", { alternative: 1, inLibrary: { itemId: 'b'.repeat(32), kind: 'movie', title: 'ZSJL' } });
  const result = ok(0, jl, { confidence: 'low', alternatives: true, candidates: [jl, zs] });
  const row = { i: 0, entry: { title: 'Justice League' }, result, cands: review.candidateList(result), cand: 0, both: true, action: 'item' };
  assert.deepEqual(plainJson(review.rowEntries(row, 'playlist')), [{ type: 'item', itemId: 'a'.repeat(32) }, { type: 'item', itemId: 'b'.repeat(32) }]);
  assert.equal(review.summarize([row], 'playlist').entries, 2);
  assert.equal(review.summarize([row, { ...row, i: 1, both: false }], 'playlist').entries, 2);
});

test('snapshotKeys: a grouped fetch with every row decided sends its own keys; otherwise each decided row sends all of its keys', t => {
  const { review } = load(t);
  const row = (keys, extra = {}) => ({ entry: { sourceKey: keys[0], sourceKeys: keys }, result: { state: 'ok' }, failed: false, ...extra });
  const rows = [row(['tv|1|1|1', 'tv|1|1|2']), row(['movie|2||'])];
  const fetched = { grouped: true, entries: [{}, {}], snapshotKeys: ['tv|1|1|1', 'tv|1|1|2', 'movie|2||'] };
  assert.deepEqual(plainJson(review.snapshotKeys(rows, fetched)), fetched.snapshotKeys);
  rows[0].failed = true;
  assert.deepEqual(plainJson(review.snapshotKeys(rows, fetched)), ['movie|2||']);
  rows[0].failed = false;
  assert.deepEqual(plainJson(review.snapshotKeys([...rows, { entry: { sourceKey: 'movie|3||' }, result: { state: 'ok' } }])), ['tv|1|1|1', 'tv|1|1|2', 'movie|2||', 'movie|3||']);
});

test('texts: reasons, notices, typed source errors (fetch_limited is not "rate limited"), names from URLs, plain lines', t => {
  const { review } = load(t);
  assert.equal(review.reasonKey('hidden'), 'arr_list_import_reason_hidden');
  assert.equal(review.reasonKey('nonsense'), null);
  assert.equal(review.noticeText('imdb_unofficial'), 'arr_list_import_notice_imdb_unofficial');
  assert.equal(review.noticeText(undefined), '');
  for (const [code, key] of [['source_format_changed', 'arr_list_import_err_format_changed'], ['mdblist_not_public', 'arr_list_import_err_mdblist_not_public'],
    ['provider_pinned', 'arr_list_import_err_provider_pinned'], ['provider_disabled', 'arr_list_import_err_provider_disabled'], ['source_empty', 'arr_list_import_err_source_empty'],
    ['read_budget_exhausted', 'arr_list_import_err_rate_limited'], ['letterboxd_unsupported', 'arr_list_import_err_letterboxd'], ['fetch_limited', 'arr_list_import_err_fetch_limited']]) {
    assert.equal(review.sourceErrorKey(code), key, code);
  }
  assert.equal(review.sourceErrorText({ status: 429, responseJSON: { code: 'fetch_limited', message: 'server text' } }), 'arr_list_import_err_fetch_limited');
  assert.equal(review.sourceErrorText({ status: 400, responseJSON: { code: 'odd', message: 'Plain server text' } }), 'Plain server text');
  assert.equal(review.sourceErrorText({ status: 502 }), 'arr_list_import_err_upstream');
  assert.equal(review.fatalResolveText({ status: 503, responseJSON: { code: 'metadata_unavailable' } }), 'arr_list_import_err_metadata');
  assert.equal(review.fatalResolveText({ status: 404, responseJSON: { code: 'disabled' } }), 'arr_list_import_err_disabled');
  assert.equal(review.fatalResolveText({ status: 500 }), null);
  assert.equal(review.plainLine('1. [Man of Steel](https://x.y/a) (2013) · **Film**'), '1. Man of Steel (2013) · Film');
  assert.equal(review.plainLine('| 5 | Justice League **or** ZSJL | 2017 / 2021 |'), '5 · Justice League or ZSJL · 2017 / 2021');
  assert.equal(review.nameFromUrl('https://mdblist.com/lists/linaspurinis/top-watched-movies-of-the-week', 'MDBList'), 'Top watched movies of the week');
  assert.equal(review.nameFromUrl('https://www.themoviedb.org/list/8136', 'TMDB'), 'arr_list_import_site_list{"site":"TMDB"}');
  assert.equal(review.episodeLabel({ seasonNumber: 1, episodes: [{ e: 8 }, { e: 9 }, { e: 10 }] }), 'S01E08–E10');
});

test('counts read "1 title" / "2 titles" through singular|plural strings and keep a "|" inside a value (QA)', t => {
  const { review } = load(t, { strings: { s: '{count} title found|{count} titles found', f: '{title}: {count} entry|{title}: {count} entries', o: '{filled} of {total} episode|{filled} of {total} episodes' } });
  assert.equal(review.tn('s', { count: 1 }), '1 title found');
  assert.equal(review.tn('s', { count: 2 }), '2 titles found');
  assert.equal(review.tn('s', { count: 0 }), '0 titles found');
  assert.equal(review.tn('o', { filled: 1, total: 1 }, 'total'), '1 of 1 episode');
  assert.equal(review.tn('plain', { count: 1 }), 'plain');
  assert.equal(review.tn('f', { title: 'Movies | TV', count: 2 }), 'Movies | TV: 2 entries');
  assert.equal(review.tn('f', { title: 'A|B|C', count: 1 }), 'A|B|C: 1 entry');
});

// ── Transport and the resolve loop ─────────────────────────────────

test('resolve, fetchSource and providers call the import routes with the token and no cache', async t => {
  const { imp, calls } = load(t, {
    routes: {
      'POST /resolve': () => ({ body: { results: [], complete: true } }),
      'POST /source': () => ({ body: { kind: 'mdblist', entries: [] } }),
      'GET /providers': () => ({ body: { maxItems: 1000 } })
    }
  });
  await imp.api.resolve([{ index: 0, title: 'A' }], { listId: 'l1' });
  await imp.api.fetchSource('https://mdblist.com/lists/a/b', { listId: 'l1', useMdblistApi: true });
  await imp.api.fetchSource('https://mdblist.com/lists/a/b');
  assert.equal((await imp.api.providers()).maxItems, 1000);
  assert.deepEqual(calls.map(c => c.body), [{ entries: [{ index: 0, title: 'A' }], listId: 'l1' }, { url: 'https://mdblist.com/lists/a/b', listId: 'l1', useMdblistApi: true }, { url: 'https://mdblist.com/lists/a/b' }, null]);
  assert.ok(calls.every(c => c.init.cache === 'no-store' && /^MediaBrowser Token=/.test(c.init.headers.Authorization)));
});

test('the resolve loop sends sequential chunks of 25, retries busy and parental-pending answers, and resubmits transient rows once', async t => {
  let calls = 0;
  const { imp } = load(t, {
    routes: {
      'POST /resolve': (body) => {
        calls++;
        if (calls === 1) return { status: 429, body: { code: 'busy' }, headers: { 'Retry-After': '0.001' } };
        if (calls === 2) return { status: 504, body: { code: 'parental_pending' }, headers: { 'Retry-After': '0.001' } };
        return {
          body: {
            results: body.entries.map(e => (e.title === 'Flaky' ? { index: e.index, state: 'transient' } : ok(e.index, movie(1000 + e.index, e.title)))),
            complete: !body.entries.some(e => e.title === 'Flaky')
          }
        };
      }
    }
  });
  const entries = Array.from({ length: 30 }, (_, i) => ({ title: i === 29 ? 'Flaky' : `Title ${i}`, year: 2000 }));
  const rows = entries.map((entry, i) => imp.newRow(entry, i, 'playlist'));
  const chunks = [];

  await imp.resolveRows(rows, { listKind: 'playlist', onChunk: (chunk, done) => chunks.push([chunk.length, done]) });

  assert.deepEqual(chunks, [[25, 25], [5, 30], [1, 30]]); // 25 + 5, then the transient row once more
  assert.equal(calls, 2 + 2 + 1);
  assert.ok(rows.slice(0, 29).every(r => r.result && r.action === 'placeholder' && !r.failed));
  assert.deepEqual([rows[29].failed, rows[29].action, rows[29].transient], [true, 'skip', false]);
});

test('prepared rows (exact sources) are never sent; a missing title lookup stops the loop with its message', async t => {
  const sent = [];
  const { imp } = load(t, {
    routes: { 'POST /resolve': (body) => { sent.push(body.entries.map(e => e.index)); return { status: 503, body: { code: 'metadata_unavailable' } }; } }
  });
  const prepared = { title: 'Arrow', sourceKey: 'tv|1412|1|1', sourceKeys: ['tv|1412|1|1', 'tv|1412|1|2'], prepared: ok(0, { mediaType: 'tv', tmdbId: 1412, title: 'Arrow', season: { seasonNumber: 1 } }, { kind: 'season' }) };
  const rows = [imp.newRow(prepared, 0, 'playlist'), imp.newRow({ title: 'Unknown' }, 1, 'playlist')];
  assert.equal(rows[0].action, 'placeholder');

  await assert.rejects(() => imp.resolveRows(rows), error => error.jeImportFatal === 'arr_list_import_err_metadata');
  assert.deepEqual(sent, [[1]]);
  assert.deepEqual([rows[0].failed, rows[1].failed, rows[1].action], [false, true, 'skip']);
});

test('an answer that arrives after a user switch is dropped', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const fixture = load(t, { routes: { 'POST /source': async () => { await gate; return { body: { kind: 'mdblist', entries: [{ title: 'secret of the previous user' }] } }; } } });
  const pending = fixture.imp.api.fetchSource('https://mdblist.com/lists/a/b');
  fixture.state.epoch = 2;
  release();
  await assert.rejects(() => pending, error => error.stale === true);
});

test('a URL read retries while parental checks run, and reports typed errors with Retry-After', async t => {
  let calls = 0;
  const { imp } = load(t, {
    routes: {
      'POST /source': () => {
        calls++;
        if (calls === 1) return { status: 504, body: { code: 'parental_pending' }, headers: { 'Retry-After': '0.001' } };
        if (calls === 2) return { body: { kind: 'mdblist', entries: [{ title: 'A' }], countsHidden: true } };
        return { status: 429, body: { code: 'read_budget_exhausted' }, headers: { 'Retry-After': '3600' } };
      }
    }
  });
  const fetched = await imp.fetchWithRetry('https://mdblist.com/lists/a/b');
  assert.deepEqual([fetched.entries.length, fetched.countsHidden, calls], [1, true, 2]);
  await assert.rejects(() => imp.fetchWithRetry('https://mdblist.com/lists/a/b'), error => error.status === 429 && error.retryAfter === 3600 && error.responseJSON.code === 'read_budget_exhausted');
});
