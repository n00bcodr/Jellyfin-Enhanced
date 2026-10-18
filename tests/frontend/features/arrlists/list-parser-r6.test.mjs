import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, plain } from '../../helpers/harness.mjs';

// Review round 6 (parser, → chains): a bold show name right before its episode reference stays the title, show names
// with a colon keep both halves, links in dropped commentary name nothing, and a plain " / " alternative between
// linked ones stays its own alternative.

function setup(t) {
  const h = createHarness({ JE: {} });
  t.after(() => h.close());
  h.load('arr/lists/list-parser.js');
  return { parse: (text, options) => plain(h.JE.arrListImport.parser.parse(text, options)) };
}

const eps = entry => entry.episodes?.map(x => `${x.s}x${x.e}`);
const titled = result => result.entries.map(e => [e.title, eps(e) ?? null]);

test('R6: a bold "**Show:**" right before an episode reference is the show, not a label', t => {
  const { parse } = setup(t);
  const one = parse('**The Flash:** 1x08 → Arrow 3x08');
  assert.deepEqual(titled(one), [['The Flash', ['1x8']], ['Arrow', ['3x8']]]);
  assert.deepEqual(one.skipped, []);
  const both = parse('**The Flash:** 1x08 → **Arrow:** 3x08');
  assert.deepEqual(titled(both), [['The Flash', ['1x8']], ['Arrow', ['3x8']]]);
  assert.deepEqual(both.skipped, []);
  // Bold labels and dates before a title are still dropped.
  assert.deepEqual(titled(parse('**Optional setup:** Supergirl 2x08 → Arrow 3x08')), [['Supergirl', ['2x8']], ['Arrow', ['3x8']]]);
  assert.deepEqual(parse('**1918:** Wonder Woman → **1938:** Captain America').entries.map(e => e.title), ['Wonder Woman', 'Captain America']);
  // An instruction label before a bare reference is still a label (nothing names the show).
  assert.deepEqual(titled(parse('**Then:** 1x08 → Arrow 3x08')), [['Arrow', ['3x8']]]);
});

test('R6: a show name with a colon keeps both halves in a chain', t => {
  const { parse } = setup(t);
  assert.deepEqual(titled(parse('Star Trek: Discovery 1x08 → Star Trek: Picard 1x01')),
    [['Star Trek: Discovery', ['1x8']], ['Star Trek: Picard', ['1x1']]]);
  assert.deepEqual(titled(parse('Star Wars: The Clone Wars 1x01 → Star Wars: Rebels 1x01')),
    [['Star Wars: The Clone Wars', ['1x1']], ['Star Wars: Rebels', ['1x1']]]);
  // Instruction labels (lowercase words) are still dropped.
  assert.deepEqual(parse('Optional setup: Supergirl 2x08 → Watch this first: Arrow 1x01').entries.map(e => e.title), ['Supergirl', 'Arrow']);
  assert.deepEqual(parse('Optional setup: Supergirl 2x08 → Watch first: Arrow 1x01').entries.map(e => e.title), ['Supergirl', 'Arrow']);
});

test('R6: links in commentary a chain option drops name nothing', t => {
  const { parse } = setup(t);
  const flash = parse('Arrow 3x08 → The Flash 1x08 (see also [Legends](https://www.themoviedb.org/tv/62643)) → Supergirl 2x08').entries[1];
  assert.equal(flash.title, 'The Flash');
  assert.deepEqual(eps(flash), ['1x8']);
  assert.equal(flash.ids?.tmdb, undefined);
  const dashed = parse('The Flash 1x08 — then read [Crisis](https://www.themoviedb.org/movie/12345) → Arrow 3x08').entries[0];
  assert.equal(dashed.title, 'The Flash');
  assert.equal(dashed.ids?.tmdb, undefined);
  const sentence = parse('Wonder Woman. Then [Man of Steel](https://www.themoviedb.org/movie/49521) → Aquaman').entries[0];
  assert.equal(sentence.title, 'Wonder Woman');
  assert.equal(sentence.ids?.tmdb, undefined);
  const [pair] = parse('Movie A / Movie B. See also [Movie C](https://www.themoviedb.org/movie/3) → Movie D').entries;
  assert.deepEqual(pair.alternatives.map(a => [a.title, a.ids?.tmdb ?? null]), [['Movie A', null], ['Movie B', null]]);
  // The kept text's own link and bare ids in the commentary still count.
  assert.equal(parse('[The Flash](https://www.themoviedb.org/tv/60735) 1x08 (crossover) → Arrow 3x08').entries[0].ids.tmdb, 60735);
  assert.equal(parse('The Flash 1x08 tmdb:tv:60735 → Arrow 3x08').entries[0].ids.tmdb, 60735);
});

test('R6: a plain " / " alternative between linked ones stays its own alternative', t => {
  const { parse } = setup(t);
  const [first] = parse('[Justice League](https://www.themoviedb.org/movie/141052) / Batman v Superman / [Man of Steel](https://www.themoviedb.org/movie/49521) → Aquaman').entries;
  assert.deepEqual(first.alternatives.map(a => [a.title, a.ids?.tmdb ?? null]),
    [['Justice League', 141052], ['Batman v Superman', null], ['Man of Steel', 49521]]);
  const [leading] = parse('Justice League / [Zack Snyder\'s Justice League](https://www.themoviedb.org/movie/791373) / [Man of Steel](https://www.themoviedb.org/movie/49521) → Aquaman').entries;
  assert.deepEqual(leading.alternatives.map(a => [a.title, a.ids?.tmdb ?? null]),
    [['Justice League', null], ["Zack Snyder's Justice League", 791373], ['Man of Steel', 49521]]);
  // Commentary after a dash, an instruction word or an episodic option's piece without a reference still joins.
  const [optional] = parse('[Flash](https://www.themoviedb.org/tv/60735) 1x08 / [Arrow](https://www.themoviedb.org/tv/1412) 3x09 / optional → Supergirl 2x08').entries;
  assert.deepEqual(optional.alternatives.map(a => [a.title, eps(a)]), [['Flash', ['1x8']], ['Arrow', ['3x9']]]);
});
