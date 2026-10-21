import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, plain } from '../../helpers/harness.mjs';

// Review round 2 (parser): dashed episode selectors after a year, " / " alternatives inside → chains, every scope of an
// alternative, and bare ids after an episode reference.

function setup(t) {
  const h = createHarness({ JE: {} });
  t.after(() => h.close());
  h.load('arr/lists/list-parser.js');
  return { parse: (text, options) => plain(h.JE.arrListImport.parser.parse(text, options)) };
}

const scope = e => ({ title: e.title, year: e.year, season: e.season, episodes: e.episodes?.map(x => `${x.s}x${x.e}`), note: e.note });

test('R2: an episode selector after "(year) -" or "(year) –" belongs to the title', t => {
  const { parse } = setup(t);
  for (const line of ['Peacemaker (2022) - S1E1', 'Peacemaker (2022) - 1x01', 'Peacemaker (2022) – S1E1', 'Peacemaker (2022): S1E1']) {
    const [entry] = parse(line).entries;
    assert.deepEqual(scope(entry), { title: 'Peacemaker', year: 2022, season: 1, episodes: ['1x1'], note: undefined }, line);
  }
  const [linked] = parse('[Peacemaker](https://www.themoviedb.org/tv/110492) (2022) - S1E1').entries;
  assert.deepEqual(scope(linked), { title: 'Peacemaker', year: 2022, season: 1, episodes: ['1x1'], note: undefined });
  assert.deepEqual(linked.ids, { tmdb: 110492, tmdbType: 'tv' });
  // A note after the dash is still a note, not a selector.
  const [noted] = parse('Peacemaker (2022) – a good one').entries;
  assert.equal(noted.episodes, undefined);
});

test('R2: "A 1x08 / B 3x09" inside a → chain is an alternatives entry, each with its own ids', t => {
  const { parse } = setup(t);
  const entries = parse('[Flash](https://themoviedb.org/tv/60735) 1x08 / [Arrow](https://themoviedb.org/tv/1412) 3x09 → Legends 1x01').entries;
  assert.equal(entries.length, 2);
  assert.deepEqual(entries[0].alternatives.map(a => [a.title, a.ids?.tmdb, a.episodes.map(x => `${x.s}x${x.e}`)]), [['Flash', 60735, ['1x8']], ['Arrow', 1412, ['3x9']]]);
  assert.deepEqual(entries.map(e => e.chain), [0, 1]);
  const [cell] = parse('| Watch |\n| --- |\n| Flash 1x08 / Arrow 3x08 → Legends 1x01 |').entries;
  assert.deepEqual(cell.alternatives.map(a => a.title), ['Flash', 'Arrow']);
  // A " / " inside parentheses is commentary, not an alternative.
  const [part] = parse('Flash 1x08 (part 1 / 2) → Legends 1x01').entries;
  assert.equal(part.alternatives, undefined);
});

test('R2: an alternative keeps every scope its text names', t => {
  const { parse } = setup(t);
  const [cross] = parse('Doctor Who S1E5–S2E3 **or** Torchwood 1x01').entries;
  assert.deepEqual(cross.alternatives[0].more, [{ season: 2, episodes: [{ s: 2, e: 1 }, { s: 2, e: 2 }, { s: 2, e: 3 }] }]);
  assert.equal(cross.alternatives[1].more, undefined);
  const [long] = parse('One Piece 1x01-150 **or** Naruto 1x01-150').entries;
  for (const alt of long.alternatives) {
    assert.equal(alt.episodes.length, 100);
    assert.equal(alt.more.length, 1);
    assert.equal(alt.more[0].episodes.length, 50);
    assert.equal(alt.more[0].episodes[0].e, 101);
  }
});

test('R2: bare ids after an episode reference name the title and never become the note', t => {
  const { parse } = setup(t);
  const [flash] = parse('Flash (2014) S1E8 tmdb:tv:60735').entries;
  assert.deepEqual(flash.ids, { tmdb: 60735, tmdbType: 'tv' });
  assert.equal(flash.note, undefined);
  const [imdb] = parse('The Flash S1E8 tt3107288').entries;
  assert.deepEqual(imdb.ids, { imdb: 'tt3107288' });
  assert.equal(imdb.note, undefined);
  const [arrow] = parse('Arrow 3x08 tmdb:tv:1412 — crossover').entries;
  assert.deepEqual(arrow.ids, { tmdb: 1412, tmdbType: 'tv' });
  assert.equal(arrow.note, 'crossover');
  const [both] = parse('Arrow 3x08 tmdb:tv:1412 the crossover').entries;
  assert.equal(both.note, 'the crossover');
});
