import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, plain } from '../../helpers/harness.mjs';

// Review round 1 (track h1): per-alternative episodes, alternatives inside → chains, season selectors and bare ids after
// a parenthesised year, range caps that dropped coordinates, and CSV text cut at the size cap.

function setup(t) {
  const h = createHarness({ JE: {} });
  t.after(() => h.close());
  h.load('arr/lists/list-parser.js');
  return { parse: (text, options) => plain(h.JE.arrListImport.parser.parse(text, options)) };
}

const pick = (entries, ...keys) => entries.map(e => Object.fromEntries(keys.filter(k => e[k] !== undefined).map(k => [k, e[k]])));

test('F52: every alternative keeps its own episodes', t => {
  const { parse } = setup(t);
  const [bold] = parse('Flash 1x08 **or** Arrow 3x09').entries;
  assert.deepEqual(bold.alternatives, [
    { title: 'Flash', typeHint: 'tv', season: 1, episodes: [{ s: 1, e: 8 }] },
    { title: 'Arrow', typeHint: 'tv', season: 3, episodes: [{ s: 3, e: 9 }] }
  ]);
  // Same season, different episode: Arrow is 1x09, not the first alternative's 1x08.
  const [slash] = parse('| Watch |\n| --- |\n| Flash 1x08 / Arrow 1x09 |').entries;
  assert.deepEqual(slash.alternatives.map(a => a.episodes), [[{ s: 1, e: 8 }], [{ s: 1, e: 9 }]]);
  // An open-ended range stays with the alternative that has it.
  const [open] = parse('Doctor Who S1E5–S2E3 **or** Torchwood 1x01').entries;
  assert.equal(open.alternatives[0].openEnded, true);
  assert.equal(open.alternatives[1].openEnded, undefined);
  // A whole-title alternative has no episodes.
  const [whole] = parse('Flash 1x08 **or** Arrow').entries;
  assert.equal(whole.alternatives[1].episodes, undefined);
});

test('F53: "A **or** B" inside a → chain is an alternatives entry with each side\'s own ids and episodes', t => {
  const { parse } = setup(t);
  const episodes = parse('[Flash](https://themoviedb.org/tv/60735) S1E8 **or** [Arrow](https://themoviedb.org/tv/1412) S3E9 → Batman (1989)').entries;
  assert.equal(episodes.length, 2);
  assert.deepEqual(pick(episodes, 'title', 'chain'), [{ title: 'Flash', chain: 0 }, { title: 'Batman', chain: 1 }]);
  assert.deepEqual(episodes[0].alternatives, [
    { title: 'Flash', typeHint: 'tv', ids: { tmdb: 60735, tmdbType: 'tv' }, season: 1, episodes: [{ s: 1, e: 8 }] },
    { title: 'Arrow', typeHint: 'tv', ids: { tmdb: 1412, tmdbType: 'tv' }, season: 3, episodes: [{ s: 3, e: 9 }] }
  ]);
  assert.equal(episodes[1].year, 1989);

  const films = parse("Justice League (2017) **or** Zack Snyder's Justice League (2021) → Batman (1989)").entries;
  assert.equal(films.length, 2);
  assert.deepEqual(films[0].alternatives, [{ title: 'Justice League', year: 2017 }, { title: "Zack Snyder's Justice League", year: 2021 }]);
  assert.equal(films[0].chain, 0);
  assert.equal(films[1].title, 'Batman');

  // Commentary after an alternative's episode is still dropped; a single segment parses as before.
  const commented = parse('Flash 1x08 crossover part one **or** Arrow 3x09 → Legends 1x01').entries;
  assert.deepEqual(commented[0].alternatives.map(a => a.title), ['Flash', 'Arrow']);
  assert.deepEqual(pick(commented, 'title', 'season'), [{ title: 'Flash', season: 1 }, { title: 'Legends', season: 1 }]);
});

test('F54: a season selector after a parenthesised year stays on the title', t => {
  const { parse } = setup(t);
  assert.deepEqual(pick(parse('Peacemaker (2022) - Season 1').entries, 'title', 'year', 'kind', 'season'),
    [{ title: 'Peacemaker', year: 2022, kind: 'season', season: 1 }]);
  assert.deepEqual(pick(parse('Peacemaker (2022) — Seasons 1-2 · TV series').entries, 'title', 'year', 'kind', 'season'),
    [{ title: 'Peacemaker', year: 2022, kind: 'season', season: 1 }, { title: 'Peacemaker', year: 2022, kind: 'season', season: 2 }]);
  // Anything after the selector is still metadata.
  const [noted] = parse('Peacemaker (2022) Season 2 — Renewed').entries;
  assert.deepEqual(pick([noted], 'title', 'season', 'note'), [{ title: 'Peacemaker', season: 2, note: 'Renewed' }]);
});

test('F55: bare ids after the year are read (and are not type words)', t => {
  const { parse } = setup(t);
  assert.deepEqual(pick(parse('Batman (1989) tmdb:movie:268').entries, 'title', 'year', 'ids'), [{ title: 'Batman', year: 1989, ids: { tmdb: 268, tmdbType: 'movie' } }]);
  assert.deepEqual(pick(parse('Batman (1989) tt0096895').entries, 'title', 'year', 'ids'), [{ title: 'Batman', year: 1989, ids: { imdb: 'tt0096895' } }]);
  assert.deepEqual(pick(parse('The Flash (2014) tvdb:279121').entries, 'title', 'year', 'ids'), [{ title: 'The Flash', year: 2014, ids: { tvdb: 279121 } }]);
  assert.deepEqual(pick(parse('1. [Batman](https://example.com/b) (1989) · tt0096895 · Film').entries, 'title', 'ids', 'typeHint'),
    [{ title: 'Batman', ids: { imdb: 'tt0096895' }, typeHint: 'movie' }]);
});

test('F60: long episode ranges split into entries of ≤100 episodes; season ranges reach the server bound', t => {
  const { parse } = setup(t);
  const onePiece = parse('One Piece 1x01-150').entries;
  assert.deepEqual(onePiece.map(e => [e.episodes[0].e, e.episodes.at(-1).e, e.episodes.length]), [[1, 100, 100], [101, 150, 50]]);
  assert.ok(onePiece.every(e => e.title === 'One Piece' && e.season === 1 && e.kind === 'episodes'));

  const simpsons = parse('The Simpsons Seasons 1-35').entries;
  assert.deepEqual(simpsons.map(e => e.season), Array.from({ length: 35 }, (_, i) => i + 1));
  const lone = parse('## The Simpsons\nSeasons 1-35').entries;
  assert.equal(lone.length, 35);
  const table = parse('| Seasons |\n| --- |\n| Simpsons 1-35 |').entries;
  assert.equal(table.length, 35);
  assert.equal(parse('Peacemaker (2022) Seasons 1-250').entries.at(-1).season, 200);

  // Cross-season: every season in between, and the last season's episodes in chunks too.
  const cross = parse('Long Show S1E1-S40E150').entries;
  assert.deepEqual(cross.map(e => e.season), [...Array.from({ length: 40 }, (_, i) => i + 1), 40]);
  assert.deepEqual(cross.slice(-2).map(e => [e.episodes[0].e, e.episodes.at(-1).e]), [[1, 100], [101, 150]]);
});

test('F61: CSV text over the size cap is reported and its cut-off record dropped; an unclosed quote is not a row', t => {
  const { parse } = setup(t);
  const description = 'x'.repeat(1400);
  const rows = Array.from({ length: 1500 }, (_, i) => `Title ${i},${2000 + (i % 20)},"${description} ${i}"`);
  const text = `Title,Year,Description\n${rows.join('\n')}\n`;
  assert.ok(text.length > 2_000_000);
  let complete = 0;
  for (let used = 'Title,Year,Description\n'.length; complete < rows.length && used + rows[complete].length + 1 <= 2_000_000; complete++) {
    used += rows[complete].length + 1;
  }
  const result = parse(text);
  assert.equal(result.format, 'csv');
  assert.equal(result.truncated, true);
  assert.equal(result.entries.length, complete);
  assert.equal(result.entries.at(-1).title, `Title ${complete - 1}`);

  const open = parse('Title,Year\nAlpha,2001\n"Beta,2002\nGamma,2003\n');
  assert.deepEqual(open.entries.map(e => e.title), ['Alpha']);
  assert.deepEqual(open.skipped.map(s => [s.line, s.reason]), [[3, 'unterminated']]);
  assert.equal(open.truncated, false);
});
