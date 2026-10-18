import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, plain } from '../../helpers/harness.mjs';

// Review round 5 (parser, → chains): "Show: 1x08" keeps a multi-word show name, and a " / " pair where only one
// alternative is linked keeps that alternative's id.

function setup(t) {
  const h = createHarness({ JE: {} });
  t.after(() => h.close());
  h.load('arr/lists/list-parser.js');
  return { parse: (text, options) => plain(h.JE.arrListImport.parser.parse(text, options)) };
}

const eps = entry => entry.episodes?.map(x => `${x.s}x${x.e}`);

test('R5: "Show: 1x08" / "Show: S01E08" in a chain keeps the show, whatever its length', t => {
  const { parse } = setup(t);
  const crossover = parse('Arrow: 3x08 → The Flash: 1x08 → Legends of Tomorrow: S01E01 → Supergirl 2x08');
  assert.deepEqual(crossover.entries.map(e => [e.title, eps(e)]),
    [['Arrow', ['3x8']], ['The Flash', ['1x8']], ['Legends of Tomorrow', ['1x1']], ['Supergirl', ['2x8']]]);
  assert.deepEqual(crossover.skipped, []);
  assert.deepEqual(parse('Doctor Who: S01E05 → Torchwood: S01E01').entries.map(e => [e.title, eps(e)]),
    [['Doctor Who', ['1x5']], ['Torchwood', ['1x1']]]);
  const pair = parse('The Flash: 1x08 → Legends of Tomorrow: 1x01');
  assert.deepEqual(pair.entries.map(e => [e.title, eps(e)]), [['The Flash', ['1x8']], ['Legends of Tomorrow', ['1x1']]]);
  assert.deepEqual(pair.skipped, []);
  // A label with a title between the colon and the reference is still dropped.
  assert.deepEqual(parse('Optional setup: Supergirl 2x08 → Watch first: Arrow 1x01').entries.map(e => e.title), ['Supergirl', 'Arrow']);
});

test('R5: a " / " pair with one linked alternative keeps that alternative\'s id', t => {
  const { parse } = setup(t);
  const [first] = parse("[Justice League](https://www.themoviedb.org/movie/141052) / Zack Snyder's Justice League → Aquaman").entries;
  assert.deepEqual(first.alternatives.map(a => [a.title, a.ids?.tmdb ?? null]), [['Justice League', 141052], ["Zack Snyder's Justice League", null]]);
  const [second] = parse("Justice League / [Zack Snyder's Justice League](https://www.themoviedb.org/movie/791373) → Aquaman").entries;
  assert.deepEqual(second.alternatives.map(a => [a.title, a.ids?.tmdb ?? null]), [['Justice League', null], ["Zack Snyder's Justice League", 791373]]);
  // Plain pairs and parentheses are unchanged.
  assert.deepEqual(parse('Blade Runner (theatrical / final cut) → Blade Runner 2049').entries.map(e => e.title),
    ['Blade Runner (theatrical / final cut)', 'Blade Runner 2049']);
  assert.deepEqual(parse('Movie A / Movie B → Movie C').entries[0].alternatives.map(a => [a.title, a.ids ?? null]), [['Movie A', null], ['Movie B', null]]);
});
