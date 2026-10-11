import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, plain } from '../../helpers/harness.mjs';

// Review round 4 (parser, → chains): linked " / " alternatives keep their own ids, "Show: \"Episode\"" keeps its
// show, and plain " / " splits never cut a title's parentheses or a dash commentary.

function setup(t) {
  const h = createHarness({ JE: {} });
  t.after(() => h.close());
  h.load('jellyseerr/listplaceholders/listplaceholders-parser.js');
  return { parse: (text, options) => plain(h.JE.listPlaceholders.parser.parse(text, options)) };
}

test('R4: linked " / " alternatives in a chain keep their own ids, season and episode', t => {
  const { parse } = setup(t);
  const [episodes] = parse('[The Flash](https://themoviedb.org/tv/60735/season/1/episode/8) / [Arrow](https://themoviedb.org/tv/1412/season/3/episode/8) → Legends 1x01').entries;
  assert.deepEqual(episodes.alternatives.map(a => [a.title, a.ids?.tmdb, a.episodes?.map(x => `${x.s}x${x.e}`)]),
    [['The Flash', 60735, ['1x8']], ['Arrow', 1412, ['3x8']]]);
  const [movies] = parse("[Justice League](https://www.themoviedb.org/movie/141052) / [Zack Snyder's Justice League](https://www.themoviedb.org/movie/791373) → [Batman v Superman](https://www.themoviedb.org/movie/209112)").entries;
  assert.deepEqual(movies.alternatives.map(a => [a.title, a.ids?.tmdb]), [['Justice League', 141052], ["Zack Snyder's Justice League", 791373]]);
  // Commentary after " / " (no reference, quote or id) still stays with the piece before it.
  assert.deepEqual(parse('[Supergirl](https://themoviedb.org/tv/62688) 2x08 — optional / skippable → Arrow 5x08').entries.map(e => [e.title, !!e.alternatives]),
    [['Supergirl', false], ['Arrow', false]]);
});

test('R4: "Show: \\"Episode title\\"" in a chain keeps the show, whatever its length', t => {
  const { parse } = setup(t);
  const crisis = parse('Supergirl: "Crisis on Infinite Earths: Part One" → Batwoman: "Crisis on Infinite Earths: Part Two" → The Flash: "Crisis on Infinite Earths: Part Three" → Arrow: "Crisis on Infinite Earths: Part Four" → Legends of Tomorrow: "Crisis on Infinite Earths: Part Five"').entries;
  assert.deepEqual(crisis.map(e => [e.title, e.episodeTitle]), [
    ['Supergirl', 'Crisis on Infinite Earths: Part One'],
    ['Batwoman', 'Crisis on Infinite Earths: Part Two'],
    ['The Flash', 'Crisis on Infinite Earths: Part Three'],
    ['Arrow', 'Crisis on Infinite Earths: Part Four'],
    ['Legends of Tomorrow', 'Crisis on Infinite Earths: Part Five']
  ]);
  assert.deepEqual(parse('The Flash: "Invasion!" → Arrow: "Invasion!"').entries.map(e => [e.title, e.episodeTitle]),
    [['The Flash', 'Invasion!'], ['Arrow', 'Invasion!']]);
  // Instruction labels are still dropped, before a reference or a quoted title.
  assert.deepEqual(parse('Optional setup: Supergirl 2x08 → Then: Arrow 1x01').entries.map(e => e.title), ['Supergirl', 'Arrow']);
});

test('R4: plain " / " in a chain splits at depth 0 only, never in dash commentary', t => {
  const { parse } = setup(t);
  const runner = parse('Blade Runner (theatrical / final cut) → Blade Runner 2049').entries;
  assert.equal(runner.length, 2);
  assert.equal(runner[0].alternatives, undefined);
  const cuts = parse("Blade Runner (theatrical / director's cut) / Blade Runner 2049 → Dune (2021)").entries;
  assert.equal(cuts[0].alternatives.length, 2);
  assert.equal(cuts[0].alternatives[1].title, 'Blade Runner 2049');
  const league = parse('Justice League (2017) — skip / optional → Aquaman').entries;
  assert.deepEqual(league.map(e => [e.title, !!e.alternatives]), [['Justice League', false], ['Aquaman', false]]);
  // Real plain alternatives still split.
  assert.deepEqual(parse('Movie A / Movie B → Movie C').entries[0].alternatives.map(a => a.title), ['Movie A', 'Movie B']);
});
