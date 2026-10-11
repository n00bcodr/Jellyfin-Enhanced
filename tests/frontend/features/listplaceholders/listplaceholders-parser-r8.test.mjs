import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, plain } from '../../helpers/harness.mjs';

// Review round 8 (parser): on ordinary lines a link or bare URL in the note/commentary names another title, not the
// entry; in a → chain a period after a title abbreviation ("Dr. No", "Vol. 2") is not a sentence end.

function setup(t) {
  const h = createHarness({ JE: {} });
  t.after(() => h.close());
  h.load('jellyseerr/listplaceholders/listplaceholders-parser.js');
  return { parse: (text, options) => plain(h.JE.listPlaceholders.parser.parse(text, options)) };
}

const eps = entry => entry.episodes?.map(x => `${x.s}x${x.e}`);

test('R8: a link or bare URL in a plain line\'s commentary does not give the entry its id', t => {
  const { parse } = setup(t);
  const batman = parse('The Batman (2022) — watch before [The Penguin](https://www.themoviedb.org/tv/194764)').entries;
  assert.equal(batman.length, 1);
  assert.equal(batman[0].title, 'The Batman');
  assert.equal(batman[0].year, 2022);
  assert.equal(batman[0].ids, undefined);
  const flash = parse('The Flash S01E08 (see https://www.themoviedb.org/tv/62643 for Legends)').entries;
  assert.equal(flash[0].title, 'The Flash');
  assert.deepEqual(eps(flash[0]), ['1x8']);
  assert.equal(flash[0].ids, undefined);
  const arrow = parse('The Flash 1x08 — continues in [Arrow 3x08](https://www.themoviedb.org/tv/1412/season/3/episode/8)').entries;
  assert.equal(arrow[0].title, 'The Flash');
  assert.deepEqual(eps(arrow[0]), ['1x8']);
  assert.equal(arrow[0].ids, undefined);
  const superman = parse('Superman (2025) - see also https://www.themoviedb.org/movie/1061474').entries;
  assert.equal(superman[0].title, 'Superman');
  assert.equal(superman[0].ids, undefined);
  const dotted = parse('- Batman (1989). Not [Batman](https://www.themoviedb.org/movie/2661) from 1966').entries;
  assert.equal(dotted[0].ids, undefined);
  // A leading link keeps its own target, never one from its note.
  const linked = parse('- [The Batman](https://www.themoviedb.org/movie/414906) (2022) — see [The Penguin](https://www.themoviedb.org/tv/194764)').entries;
  assert.deepEqual(linked[0].ids, { tmdb: 414906, tmdbType: 'movie' });
});

test('R8: a URL before the commentary, or right after the separator, still names the entry', t => {
  const { parse } = setup(t);
  assert.deepEqual(parse('Superman (2025) - https://www.themoviedb.org/movie/1061474').entries[0].ids, { tmdb: 1061474, tmdbType: 'movie' });
  assert.deepEqual(parse('- The Batman (2022) https://www.themoviedb.org/movie/414906').entries[0].ids, { tmdb: 414906, tmdbType: 'movie' });
  const noted = parse('- The Batman https://www.themoviedb.org/movie/414906 — watch before The Penguin').entries[0];
  assert.deepEqual(noted.ids, { tmdb: 414906, tmdbType: 'movie' });
  assert.equal(noted.note, 'watch before The Penguin');
  const year = parse('- The Flash S01E08 (2014) https://www.themoviedb.org/tv/60735').entries[0];
  assert.deepEqual(year.ids, { tmdb: 60735, tmdbType: 'tv' });
  assert.equal(year.year, 2014);
  const range = parse('- Doctor Who (2005) S1E11 – S3E2 https://www.themoviedb.org/tv/57243').entries;
  assert.equal(range.length, 3);
  assert.ok(range.every(entry => entry.ids?.tmdb === 57243));
  // Bare id tokens in the metadata still count.
  assert.deepEqual(parse('- Batman (1989) tt0096895 — see tt0059968').entries[0].ids, { imdb: 'tt0096895' });
});

test('R8: a chain keeps a title abbreviation and its year', t => {
  const { parse } = setup(t);
  const bond = parse('Dr. No (1962) → From Russia with Love (1963)').entries;
  assert.deepEqual(bond.map(e => [e.title, e.year]), [['Dr. No', 1962], ['From Russia with Love', 1963]]);
  const gotg = parse('Guardians of the Galaxy Vol. 2 (2017) → Avengers: Infinity War (2018)').entries;
  assert.deepEqual(gotg.map(e => [e.title, e.year]), [['Guardians of the Galaxy Vol. 2', 2017], ['Avengers: Infinity War', 2018]]);
  const mcu = parse('Iron Man (2008) → Guardians of the Galaxy Vol. 2 (2017) → Thor').entries;
  assert.deepEqual(mcu.map(e => [e.title, e.year]), [['Iron Man', 2008], ['Guardians of the Galaxy Vol. 2', 2017], ['Thor', undefined]]);
  // A real sentence end still drops the commentary.
  const credits = parse('Iron Man (2008). Then the credits → Thor; skip the rest').entries;
  assert.deepEqual(credits.map(e => [e.title, e.year]), [['Iron Man', 2008], ['Thor', undefined]]);
});
