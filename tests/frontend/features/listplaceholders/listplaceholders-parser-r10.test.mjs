import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, plain } from '../../helpers/harness.mjs';

// Review round 10 (parser): a release date, year range or TBA after a season selector or an episode reference is not
// the start of commentary (the line keeps its own id links); a type/status phrase right after the year stays metadata
// while the commentary after it becomes the note.

function setup(t) {
  const h = createHarness({ JE: {} });
  t.after(() => h.close());
  h.load('jellyseerr/listplaceholders/listplaceholders-parser.js');
  return { parse: (text, options) => plain(h.JE.listPlaceholders.parser.parse(text, options)) };
}

test('R10: a release date, range or TBA after a season selector keeps the line\'s own ids', t => {
  const { parse } = setup(t);
  const cases = [
    ['Peacemaker - Season 1 (2022-01-13) [TMDB](https://www.themoviedb.org/tv/110492)', 'Peacemaker', 1, { tmdb: 110492, tmdbType: 'tv' }],
    ['Creature Commandos - Season 1 (2024-12-05) https://www.themoviedb.org/tv/223911', 'Creature Commandos', 1, { tmdb: 223911, tmdbType: 'tv' }],
    ['The Flash Season 1 (2014-2015) https://www.themoviedb.org/tv/60735', 'The Flash', 1, { tmdb: 60735, tmdbType: 'tv' }],
    ['The Flash - Season 1 (2014–2015) [IMDb](https://www.imdb.com/title/tt3107288/)', 'The Flash', 1, { imdb: 'tt3107288' }],
    ['Peacemaker (2022) - Season 1 (2022-01-13) https://www.themoviedb.org/tv/110492', 'Peacemaker', 1, { tmdb: 110492, tmdbType: 'tv' }],
    ['Creature Commandos - Season 2 (TBA) https://www.themoviedb.org/tv/223911', 'Creature Commandos', 2, { tmdb: 223911, tmdbType: 'tv' }],
    ['Arrow Season 1 (2012–2013) https://www.themoviedb.org/tv/1412/season/1', 'Arrow', 1, { tmdb: 1412, tmdbType: 'tv' }],
    ['Arrow - Season 1 (2012-10-10) [TMDB](https://www.themoviedb.org/tv/1412)', 'Arrow', 1, { tmdb: 1412, tmdbType: 'tv' }]
  ];
  for (const [line, title, season, ids] of cases) {
    const entry = parse(line).entries[0];
    assert.equal(entry.title, title, line);
    assert.equal(entry.kind, 'season', line);
    assert.equal(entry.season, season, line);
    assert.deepEqual(entry.ids, ids, line);
  }
  assert.equal(parse('Creature Commandos - Season 2 (TBA) https://www.themoviedb.org/tv/223911').entries[0].status, 'tba');
  const range = parse('Arrow Seasons 1-3 (2012–2015) https://www.themoviedb.org/tv/1412').entries;
  assert.deepEqual(range.map(e => e.season), [1, 2, 3]);
  assert.ok(range.every(e => e.ids?.tmdb === 1412));
  // A parenthetical after the release one is still commentary.
  assert.equal(parse('Arrow Season 1 (2012–2013) (see [The Flash](https://www.themoviedb.org/tv/60735))').entries[0].ids, undefined);
});

test('R10: a release date after an episode reference keeps the line\'s own ids', t => {
  const { parse } = setup(t);
  const entry = parse('The Flash S1E8 (2014-12-02) https://www.themoviedb.org/tv/60735').entries[0];
  assert.equal(entry.title, 'The Flash');
  assert.deepEqual(entry.ids, { tmdb: 60735, tmdbType: 'tv' });
});

test('R10: a type/status phrase after the year stays metadata; only what follows it is the note', t => {
  const { parse } = setup(t);
  for (const line of ['Batman (1966) - Live-action film', 'Batman: Mask of the Phantasm (1993) - Animated film', 'Constantine (2005) - Live action film']) {
    const entry = parse(line).entries[0];
    assert.equal(entry.kind, 'movie', line);
    assert.equal(entry.typeHint, 'movie', line);
    assert.equal(entry.note, undefined, line);
  }
  const hawkeye = parse('Hawkeye (2021) - Disney+ miniseries').entries[0];
  assert.equal(hawkeye.kind, 'series');
  assert.equal(hawkeye.typeHint, 'tv');
  const batgirl = parse('[Batgirl](https://www.themoviedb.org/movie/659730) (2022) - Shelved film (no public release)').entries[0];
  assert.equal(batgirl.status, 'tba');
  assert.equal(batgirl.typeHint, 'movie');
  assert.equal(batgirl.note, 'no public release');
  const squad = parse('Suicide Squad (2016) - Film, DCEU').entries[0];
  assert.equal(squad.typeHint, 'movie');
  assert.equal(squad.note, 'DCEU');
  // Instructions after the year are still the note, never type words (round 9).
  for (const line of ['The Flash (2014) - watch before the Batman movie', 'The Flash (2014). Watch before the Batman movie']) {
    const entry = parse(line).entries[0];
    assert.equal(entry.typeHint, undefined, line);
    assert.match(entry.note, /^[Ww]atch before the Batman movie$/, line);
  }
  const both = parse('Batman (1989) - TV series, Released').entries[0];
  assert.equal(both.typeHint, 'tv');
  assert.equal(both.status, 'released');
  assert.equal(both.note, undefined);
});

test('R11: a release date, year or TBA after an episode reference in a → chain keeps each segment\'s own ids', t => {
  const { parse } = setup(t);
  const flash = { tmdb: 60735, tmdbType: 'tv' };
  const arrow = { tmdb: 1412, tmdbType: 'tv' };
  const chains = [
    'The Flash S1E8 (2014-12-02) https://www.themoviedb.org/tv/60735 → Arrow S3E8 (2014-12-03) https://www.themoviedb.org/tv/1412',
    'The Flash S1E8 (2014) https://www.themoviedb.org/tv/60735 → Arrow S3E8 (2014) https://www.themoviedb.org/tv/1412',
    'Flash 1x08 (2014) [TMDB](https://www.themoviedb.org/tv/60735) → Arrow 3x08 (2014) [TMDB](https://www.themoviedb.org/tv/1412)',
    'Flash 1x08 (TBA) [TMDB](https://www.themoviedb.org/tv/60735) → Arrow 3x08 (2014–2015) [TMDB](https://www.themoviedb.org/tv/1412)'
  ];
  for (const line of chains) {
    const entries = parse(line).entries;
    assert.equal(entries.length, 2, line);
    assert.deepEqual(entries.map(e => [e.kind, e.season, e.chain]), [['episodes', 1, 0], ['episodes', 3, 1]], line);
    assert.deepEqual(entries[0].ids, flash, line);
    assert.deepEqual(entries[1].ids, arrow, line);
  }
  // A parenthetical other than a release one (alone or after one) is still commentary: its link names another title.
  for (const line of [
    'Flash 1x08 (see [Arrow](https://www.themoviedb.org/tv/1412)) → Arrow 3x08',
    'Flash 1x08 (2014) (see [Arrow](https://www.themoviedb.org/tv/1412)) → Arrow 3x08'
  ]) {
    const entries = parse(line).entries;
    assert.equal(entries.length, 2, line);
    assert.equal(entries[0].ids, undefined, line);
    assert.equal(entries[1].ids, undefined, line);
  }
});
