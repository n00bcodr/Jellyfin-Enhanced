import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, plain } from '../../helpers/harness.mjs';

// Review round 3 (parser, → chains): " / " commentary is no alternative, " / " inside parentheses doesn't hide a real
// one, "Show 2x08: Episode title" keeps its show, and bare ids after an episode reference survive the cleaning.

function setup(t) {
  const h = createHarness({ JE: {} });
  t.after(() => h.close());
  h.load('arr/lists/list-parser.js');
  return { parse: (text, options) => plain(h.JE.arrListImport.parser.parse(text, options)) };
}

const brief = e => [e.title, e.episodes?.map(x => `${x.s}x${x.e}`).join(','), e.alternatives ? 'alternatives' : undefined].filter(Boolean).join(' ');

test('R3: commentary after " / " in a chain segment stays commentary', t => {
  const { parse } = setup(t);
  assert.deepEqual(parse('Supergirl 2x08 — optional / skippable → Arrow 5x08 → The Flash 3x08').entries.map(brief),
    ['Supergirl 2x8', 'Arrow 5x8', 'The Flash 3x8']);
  assert.deepEqual(parse('Arrow 2x08 - The Scientist, introduces Barry / sets up the show → The Flash 1x01').entries.map(brief),
    ['Arrow 2x8', 'The Flash 1x1']);
  // Plain " / " titles in a chain are still alternatives.
  const [alt] = parse('Movie A / Movie B → Movie C').entries;
  assert.deepEqual(alt.alternatives.map(a => a.title), ['Movie A', 'Movie B']);
});

test('R3: a " / " inside parentheses does not hide the alternative after it', t => {
  const { parse } = setup(t);
  const entries = parse('[Flash](https://themoviedb.org/tv/60735) 1x08 (part 1 / 2) / [Arrow](https://themoviedb.org/tv/1412) 3x09 → Legends 1x01').entries;
  assert.equal(entries.length, 2);
  assert.deepEqual(entries[0].alternatives.map(a => [a.title, a.ids?.tmdb, a.episodes.map(x => `${x.s}x${x.e}`)]),
    [['Flash', 60735, ['1x8']], ['Arrow', 1412, ['3x9']]]);
  assert.equal(brief(entries[1]), 'Legends 1x1');
});

test('R3: "Show 2x08: Episode title" in a chain keeps the show and episode', t => {
  const { parse } = setup(t);
  const entries = parse('Supergirl 2x08: Medusa → The Flash 3x08: Invasion! → Arrow 5x08: Invasion! → Legends of Tomorrow 2x07: Invasion!').entries;
  assert.deepEqual(entries.map(brief), ['Supergirl 2x8', 'The Flash 3x8', 'Arrow 5x8', 'Legends of Tomorrow 2x7']);
  assert.ok(entries.every(e => !e.duplicateOf), 'no duplicates');
  // A real label before the reference is still dropped.
  assert.deepEqual(parse('Optional setup: Supergirl 2x08 → Flash 3x08').entries.map(brief), ['Supergirl 2x8', 'Flash 3x8']);
});

test('R3: bare ids after an episode reference in a chain name the title', t => {
  const { parse } = setup(t);
  const entries = parse('Flash S1E8 tmdb:tv:60735 → Arrow 3x08 tt2193021 → Legends 1x01').entries;
  assert.deepEqual(entries.map(e => e.ids), [{ tmdb: 60735, tmdbType: 'tv' }, { imdb: 'tt2193021' }, undefined]);
  assert.deepEqual(entries.map(brief), ['Flash 1x8', 'Arrow 3x8', 'Legends 1x1']);
});
