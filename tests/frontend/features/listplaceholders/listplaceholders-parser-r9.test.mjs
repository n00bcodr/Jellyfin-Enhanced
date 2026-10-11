import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, plain } from '../../helpers/harness.mjs';

// Review round 9 (parser): a spaced dash in a title before its year is not commentary; an id link ("[TMDB](…)") right
// after a separator still names the entry; commentary after a season selector or after the year neither gives ids nor
// type words; a chain keeps dotted initialisms and "Inc."; a table's id column reads its link targets.

function setup(t) {
  const h = createHarness({ JE: {} });
  t.after(() => h.close());
  h.load('jellyseerr/listplaceholders/listplaceholders-parser.js');
  return { parse: (text, options) => plain(h.JE.listPlaceholders.parser.parse(text, options)) };
}

const eps = entry => entry.episodes?.map(x => `${x.s}x${x.e}`);

test('R9: a spaced dash inside a title before its year keeps the line\'s own ids', t => {
  const { parse } = setup(t);
  const fallout = parse('Mission: Impossible – Fallout (2018) https://www.themoviedb.org/movie/353081').entries[0];
  assert.equal(fallout.title, 'Mission: Impossible – Fallout');
  assert.equal(fallout.year, 2018);
  assert.deepEqual(fallout.ids, { tmdb: 353081, tmdbType: 'movie' });
  const potter = parse('Harry Potter and the Deathly Hallows – Part 1 (2010) [TMDB](https://www.themoviedb.org/movie/12444)').entries[0];
  assert.equal(potter.title, 'Harry Potter and the Deathly Hallows – Part 1');
  assert.deepEqual(potter.ids, { tmdb: 12444, tmdbType: 'movie' });
  assert.deepEqual(parse('Mission: Impossible – Fallout (2018) https://www.imdb.com/title/tt4912910/').entries[0].ids, { imdb: 'tt4912910' });
  assert.deepEqual(parse('Mission: Impossible – Fallout (2018) <https://www.themoviedb.org/movie/353081>').entries[0].ids, { tmdb: 353081, tmdbType: 'movie' });
  // A link between the dash and the year is commentary about another title.
  assert.equal(parse('Joker: Folie à Deux — sequel to [Joker](https://www.themoviedb.org/movie/475557) (2019)').entries[0].ids, undefined);
});

test('R9: an id link right after a separator names the entry; a title link there does not', t => {
  const { parse } = setup(t);
  const imdb = parse('The Batman (2022) — [IMDb](https://www.imdb.com/title/tt1877830/)').entries[0];
  assert.deepEqual(imdb.ids, { imdb: 'tt1877830' });
  assert.equal(imdb.note, undefined);
  for (const line of [
    'The Batman (2022) - [TMDB](https://www.themoviedb.org/movie/414906)',
    'The Batman — [TMDB](https://www.themoviedb.org/movie/414906)',
    'The Batman (2022) ([TMDB](https://www.themoviedb.org/movie/414906))',
    'The Batman (2022): [TMDB](https://www.themoviedb.org/movie/414906)'
  ]) {
    const entry = parse(line).entries[0];
    assert.equal(entry.title, 'The Batman', line);
    assert.deepEqual(entry.ids, { tmdb: 414906, tmdbType: 'movie' }, line);
  }
  const peacemaker = parse('Peacemaker S01E01 - [TMDB](https://www.themoviedb.org/tv/110492/season/1/episode/1)').entries[0];
  assert.deepEqual(eps(peacemaker), ['1x1']);
  assert.deepEqual(peacemaker.ids, { tmdb: 110492, tmdbType: 'tv' });
  const penguin = parse('The Batman — [The Penguin](https://www.themoviedb.org/tv/194764)').entries[0];
  assert.equal(penguin.ids, undefined);
  assert.equal(penguin.note, 'The Penguin');
  // In a chain, an id link after the reference counts; one in the commentary doesn't.
  const chain = parse('The Flash 1x08 [TMDB](https://www.themoviedb.org/tv/60735) → Arrow 3x08 [TMDB](https://www.themoviedb.org/tv/1412)').entries;
  assert.deepEqual(chain.map(e => e.ids), [{ tmdb: 60735, tmdbType: 'tv' }, { tmdb: 1412, tmdbType: 'tv' }]);
  const noted = parse('The Flash 1x08 - [TMDB](https://www.themoviedb.org/tv/60735) → Arrow 3x08 — then [Legends](https://www.themoviedb.org/tv/62643)').entries;
  assert.deepEqual(noted.map(e => e.ids), [{ tmdb: 60735, tmdbType: 'tv' }, undefined]);
});

test('R9: a link in the commentary after a season selector does not give the season its id', t => {
  const { parse } = setup(t);
  for (const line of [
    'Peacemaker (2022) - Season 1 (see [Arrow](https://www.themoviedb.org/tv/1412))',
    'Peacemaker - Season 1 - watch after [The Suicide Squad](https://www.themoviedb.org/movie/436969)',
    'Peacemaker (2022) - Season 1. Watch after [The Suicide Squad](https://www.themoviedb.org/movie/436969)',
    'Peacemaker (2022) Season 1 - watch after [The Suicide Squad](https://www.themoviedb.org/movie/436969)'
  ]) {
    const entry = parse(line).entries[0];
    assert.equal(entry.title, 'Peacemaker', line);
    assert.equal(entry.kind, 'season', line);
    assert.equal(entry.season, 1, line);
    assert.equal(entry.ids, undefined, line);
  }
  assert.equal(parse('Peacemaker - Season 1 - watch after [The Suicide Squad](https://www.themoviedb.org/movie/436969)').entries[0].note, 'watch after The Suicide Squad');
  // The season's own id link still counts.
  assert.deepEqual(parse('Peacemaker — Season 1 — [TMDB](https://www.themoviedb.org/tv/110492)').entries[0].ids, { tmdb: 110492, tmdbType: 'tv' });
});

test('R9: commentary after the year is the note, not type words', t => {
  const { parse } = setup(t);
  for (const line of ['The Flash (2014) - watch before the Batman movie', 'The Flash (2014). Watch before the Batman movie']) {
    const entry = parse(line).entries[0];
    assert.equal(entry.title, 'The Flash', line);
    assert.equal(entry.year, 2014, line);
    assert.equal(entry.typeHint, undefined, line);
    assert.notEqual(entry.kind, 'movie', line);
    assert.match(entry.note, /^[Ww]atch before the Batman movie$/, line);
  }
  // Only type/status words after the separator stay metadata.
  assert.equal(parse('Batman (1989) - TV series').entries[0].typeHint, 'tv');
  assert.equal(parse('The Flash (2014): Released').entries[0].status, 'released');
});

test('R9: a chain keeps dotted initialisms and corporate abbreviations', t => {
  const { parse } = setup(t);
  const la = parse('L.A. Confidential (1997) → Chinatown (1974)').entries;
  assert.deepEqual(la.map(e => [e.title, e.year]), [['L.A. Confidential', 1997], ['Chinatown', 1974]]);
  const et = parse('E.T. the Extra-Terrestrial (1982) → Close Encounters of the Third Kind (1977)').entries;
  assert.deepEqual(et.map(e => [e.title, e.year]), [['E.T. the Extra-Terrestrial', 1982], ['Close Encounters of the Third Kind', 1977]]);
  const pixar = parse('Toy Story (1995) → Monsters, Inc. (2001) → Finding Nemo (2003)').entries;
  assert.deepEqual(pixar.map(e => e.year), [1995, 2001, 2003]);
  assert.equal(parse('Iron Man (2008) → Agents of S.H.I.E.L.D. (2013)').entries[1].year, 2013);
  // A real sentence end still ends the option.
  const sentence = parse('Iron Man (2008). Then the credits → Thor (2011)').entries;
  assert.deepEqual(sentence.map(e => e.title), ['Iron Man', 'Thor']);
});

test('R9: a table id column reads markdown link targets', t => {
  const { parse } = setup(t);
  const link = parse('| Title | Year | Link |\n|---|---|---|\n| The Batman | 2022 | [TMDB](https://www.themoviedb.org/movie/414906) |').entries[0];
  assert.equal(link.title, 'The Batman');
  assert.deepEqual(link.ids, { tmdb: 414906, tmdbType: 'movie' });
  assert.deepEqual(parse('| Title | TMDB |\n|---|---|\n| The Batman | [Link](https://www.themoviedb.org/movie/414906) |').entries[0].ids, { tmdb: 414906, tmdbType: 'movie' });
  assert.deepEqual(parse('| Title | TMDB |\n|---|---|\n| The Batman | [414906](https://www.themoviedb.org/movie/414906) |').entries[0].ids, { tmdb: 414906, tmdbType: 'movie' });
});
