import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, plain } from '../../helpers/harness.mjs';

// The bulk-import parser (design §7/E2): every construct of the user's DC watch guide, CSV exports, URLs and ids,
// episode notation, chains, alternatives, prose skipping, duplicates, limits and speed.

function setup(t) {
  const h = createHarness({ JE: {} });
  t.after(() => h.close());
  h.load('arr/lists/list-parser.js');
  const parser = h.JE.arrListImport.parser;
  assert.ok(Object.isFrozen(parser));
  assert.equal(h.JE.listPlaceholders, undefined); // #936's namespace is not published (it would clash with the old module)
  return { ...h, parser, parse: (text, options) => plain(parser.parse(text, options)) };
}

/** Only the fields a test cares about, so expectations stay readable. */
const pick = (entries, ...keys) => entries.map(e => Object.fromEntries(keys.filter(k => e[k] !== undefined).map(k => [k, e[k]])));

const CATALOGUE = `### DCEU

1. [Man of Steel](https://www.dc.com/movies/man-of-steel-2013) (2013) · Film · Released
5. [Etta's Mission](https://en.wikipedia.org/wiki/List) (2017) · Short · Released — Optional Wonder Woman home-video short; watch after Wonder Woman.
7. [Zack Snyder's Justice League](https://www.dc.com/movies/zsjl) (2021) · Alternate edition · Released — Alternative to Justice League (2017).
11. [Wonder Woman 1984](https://www.dc.com/movies/wonder-woman-1984-2020) (2020) · Film · Released
13. [Peacemaker - Season 1](https://www.dc.com/tv/peacemaker-2022) (2022) · TV series · Released — 8 episodes. Background for season 2.

### DCU

1. [Creature Commandos - Season 1](https://www.dc.com/tv/creature-commandos-2024) (2024-12-05) · TV series · Released — 7 episodes.
6. [Clayface](https://www.dc.com/movies) (2026-10-23) · Film · Scheduled — Scheduled; story placement still unassigned.
8. [Blue Beetle (animated series)](https://www.gamesradar.com/x/) (TBA) · TV series · In development — Development.
10. [Creature Commandos - Season 2](https://www.dc.com/tv/creature-commandos-2024) (TBA) · TV season · In development — Renewed.
13. [Swamp Thing (DCU film)](https://www.dc.com/blog/x) (TBA) · Film · In development — Announced film.
1. [Batgirl](https://en.wikipedia.org/wiki/x) (2022) · Unreleased project · Shelved — Filmed then shelved.
`;

test('numbered catalogue lines: link titles, dates, kinds, statuses, notes, seasons and qualifiers', t => {
  const { parse } = setup(t);
  const result = parse(CATALOGUE);
  assert.equal(result.format, 'text');
  assert.deepEqual(pick(result.entries, 'title', 'year', 'date', 'typeHint', 'kind', 'season', 'status'), [
    { title: 'Man of Steel', year: 2013, typeHint: 'movie', kind: 'movie', status: 'released' },
    { title: "Etta's Mission", year: 2017, typeHint: 'movie', kind: 'movie', status: 'released' },
    // "Alternate edition" exists as films and as TV (the DC guide's short-series cuts): no type hint of its own.
    { title: "Zack Snyder's Justice League", year: 2021, status: 'released' },
    { title: 'Wonder Woman 1984', year: 2020, typeHint: 'movie', kind: 'movie', status: 'released' },
    { title: 'Peacemaker', year: 2022, typeHint: 'tv', kind: 'season', season: 1, status: 'released' },
    { title: 'Creature Commandos', year: 2024, date: '2024-12-05', typeHint: 'tv', kind: 'season', season: 1, status: 'released' },
    { title: 'Clayface', year: 2026, date: '2026-10-23', typeHint: 'movie', kind: 'movie', status: 'scheduled' },
    { title: 'Blue Beetle', typeHint: 'tv', kind: 'series', status: 'tba' },
    { title: 'Creature Commandos', typeHint: 'tv', kind: 'season', season: 2, status: 'tba' },
    { title: 'Swamp Thing', typeHint: 'movie', kind: 'movie', status: 'tba' },
    { title: 'Batgirl', year: 2022, status: 'tba' }
  ]);
  assert.equal(result.entries[1].note, 'Optional Wonder Woman home-video short; watch after Wonder Woman.');
  assert.equal(result.entries[4].note, '8 episodes. Background for season 2.');
  assert.equal(result.entries[7].qualifier, 'animated series');
  assert.deepEqual(result.sections.map(s => s.title), ['DCEU', 'DCU']);
  assert.equal(result.entries[5].section, 'DCU');
  assert.deepEqual(result.entries.map(e => e.index), result.entries.map((_, i) => i));
  assert.equal(result.entries[0].line, 3);
  assert.match(result.entries[0].raw, /^1\. \[Man of Steel\]/);
  assert.deepEqual(result.skipped, []);
});

const DCEU_TABLE = `## 1. DCEU: the complete main watch order

For a first watch, use this order. It mostly follows release order, with the alternative Justice League version placed beside the theatrical film.

| Step | Watch | Released | Notes |
| --- | --- | --- | --- |
| 1 | Man of Steel | 2013 | Start here. |
| 4 | Wonder Woman | 2017 | Optional extra afterward: **Etta’s Mission**. |
| 5 | Justice League **or** Zack Snyder’s Justice League | 2017 / 2021 | Two versions of the same adventure. |
| 9 | Wonder Woman 1984 | 2020 | A historical story released later. |
| 11 | Peacemaker — season 1 | 2022 | All 8 episodes; follows The Suicide Squad. |

That is **15 original feature films + Peacemaker season 1**, with Snyder’s Justice League as an additional alternative version.

### DCEU story timeline

**1918:** Wonder Woman → **1984:** Wonder Woman 1984 → **modern era:** Man of Steel → Batman v Superman → Peacemaker S1 → Blue Beetle / Aquaman and the Lost Kingdom.
`;

test('markdown tables: header roles, "A or B" alternatives with "2017 / 2021", em-dash seasons, notes; prose skipped', t => {
  const { parse } = setup(t);
  const result = parse(DCEU_TABLE);
  const table = result.entries.filter(e => e.source === 'table');
  assert.deepEqual(pick(table, 'title', 'year', 'season', 'kind'), [
    { title: 'Man of Steel', year: 2013 },
    { title: 'Wonder Woman', year: 2017 },
    { title: 'Justice League', year: 2017 },
    { title: 'Wonder Woman 1984', year: 2020 },
    { title: 'Peacemaker', year: 2022, season: 1, kind: 'season' }
  ]);
  assert.deepEqual(table[2].alternatives, [{ title: 'Justice League', year: 2017 }, { title: "Zack Snyder's Justice League", year: 2021 }]);
  assert.equal(table[1].note, "Optional extra afterward: Etta's Mission.");
  assert.deepEqual(result.skipped.map(s => s.reason), ['prose', 'prose']);

  // The story timeline is a → chain: bold labels go, "S1" is a season, "A / B" are alternatives.
  const chain = result.entries.filter(e => e.source === 'chain');
  assert.deepEqual(chain.map(e => e.title), ['Wonder Woman', 'Wonder Woman 1984', 'Man of Steel', 'Batman v Superman', 'Peacemaker', 'Blue Beetle']);
  assert.equal(chain[4].season, 1);
  assert.deepEqual(chain[5].alternatives.map(a => a.title), ['Blue Beetle', 'Aquaman and the Lost Kingdom']);
  assert.deepEqual(chain.map(e => e.chain), [0, 1, 2, 3, 4, 5]);
  assert.equal(chain[0].section, 'DCEU story timeline');
});

test('tables with a Format column set the type; tables without a title column are skipped', t => {
  const { parse } = setup(t);
  const result = parse(`| Step | Watch | Released | Format |
| --- | --- | --- | --- |
| Background | The Suicide Squad | 2021 | Optional background film. |
| 1 | Creature Commandos — season 1 | 2024 | Animated series, 7 episodes. |
| 2 | Superman | 2025 | Live-action film. |

| Tracks | How to watch them |
| --- | --- |
| DCEU → DCU | Carry The Suicide Squad and Peacemaker S1 forward as background. |
`);
  assert.deepEqual(pick(result.entries, 'title', 'year', 'typeHint', 'season'), [
    { title: 'The Suicide Squad', year: 2021, typeHint: 'movie' },
    { title: 'Creature Commandos', year: 2024, typeHint: 'tv', season: 1 },
    { title: 'Superman', year: 2025, typeHint: 'movie' }
  ]);
  assert.deepEqual(result.skipped.map(s => s.reason), ['table', 'table']);
});

const CROSSOVERS = `| Event | Exact chapter order |
| --- | --- |
| Flash vs. Arrow (2014) | Flash **1x08** → Arrow **3x08** |
| Heroes Join Forces (2015) | Flash **2x08** → Arrow **4x08**; then begin Legends season 1. |
| Worlds Finest (2016) | Flash **2x18** supplies the departure context → Supergirl **1x18**. Preserve Flash episode order by watching 2x17 first. |
| Invasion! (2016) | Optional setup: Supergirl **2x08** → Flash **3x08** → Arrow **5x08** → Legends **2x07** |
| Crisis on Infinite Earths (2019–20) | Setup: Black Lightning **3x09** → Supergirl **5x09** → Arrow **8x08** → Legends **“Crisis on Infinite Earths: Part Five”** |
| Armageddon (2021) | Flash **8x01–05**, in order. Guest heroes appear inside The Flash; no other show provides numbered chapters. |
`;

test('crossover tables: → chains of episodes with labels, prose, quoted episode titles and ranges', t => {
  const { parse } = setup(t);
  const result = parse(CROSSOVERS);
  const short = result.entries.map(e => `${e.title} ${e.episodes ? e.episodes.map(x => `${x.s}x${x.e}`).join(',') : `"${e.episodeTitle}"`} ${e.year}`);
  assert.deepEqual(short, [
    'Flash 1x8 2014', 'Arrow 3x8 2014',
    'Flash 2x8 2015', 'Arrow 4x8 2015',
    'Flash 2x18 2016', 'Supergirl 1x18 2016',
    'Supergirl 2x8 2016', 'Flash 3x8 2016', 'Arrow 5x8 2016', 'Legends 2x7 2016',
    'Black Lightning 3x9 2019', 'Supergirl 5x9 2019', 'Arrow 8x8 2019', 'Legends "Crisis on Infinite Earths: Part Five" 2019',
    'Flash 8x1,8x2,8x3,8x4,8x5 2021'
  ]);
  assert.ok(result.entries.every(e => e.kind === 'episodes' && e.typeHint === 'tv'));
  assert.equal(result.entries[0].note, 'Flash vs. Arrow (2014)');
  assert.equal(result.entries[14].season, 8);
});

test('seasons tables split "Show N" lists and season ranges, and ignore prose items', t => {
  const { parse } = setup(t);
  const result = parse(`| Broadcast block | Seasons |
| --- | --- |
| 2013–14 | Arrow 2; episodes 8–9 introduce Barry Allen. |
| 2014–15 | Arrow 3, Flash 1, Constantine 1 |
| 2021–22 | Flash 7–8, Supergirl 6 |
`);
  assert.deepEqual(result.entries.map(e => `${e.title} S${e.season} ${e.year}`), [
    'Arrow S2 2013', 'Arrow S3 2014', 'Flash S1 2014', 'Constantine S1 2014', 'Flash S7 2021', 'Flash S8 2021', 'Supergirl S6 2021'
  ]);
});

test('episode notations, ranges, cross-season ranges and named episodes', t => {
  const { parse } = setup(t);
  const result = parse(`The Flash S01E08
Flash S8E01–05
Peacemaker 1x05 (2022)
Arrow Season 2 Episode 3
Doctor Who S1E5-S2E3
Legends "Crisis on Infinite Earths: Part Five"
Show S1E1-E150`);
  const e = result.entries;
  assert.deepEqual(pick(e, 'title', 'season', 'year'), [
    { title: 'The Flash', season: 1 }, { title: 'Flash', season: 8 }, { title: 'Peacemaker', season: 1, year: 2022 },
    { title: 'Arrow', season: 2 }, { title: 'Doctor Who', season: 1 }, { title: 'Doctor Who', season: 2 },
    { title: 'Legends' }, { title: 'Show', season: 1 }, { title: 'Show', season: 1 }
  ]);
  assert.deepEqual(e[1].episodes.map(x => x.e), [1, 2, 3, 4, 5]);
  assert.deepEqual(e[3].episodes, [{ s: 2, e: 3 }]);
  assert.equal(e[4].openEnded, true);
  assert.deepEqual(e[5].episodes.map(x => `${x.s}x${x.e}`), ['2x1', '2x2', '2x3']);
  assert.equal(e[6].episodeTitle, 'Crisis on Infinite Earths: Part Five');
  assert.equal(e[6].kind, 'episodes');
  // Split into entries of at most 100 episodes, none dropped.
  assert.deepEqual([e[7], e[8]].map(x => [x.episodes[0].e, x.episodes.length]), [[1, 100], [101, 50]]);
});

test('lone "Season N" lines attach to the series above them (or the heading)', t => {
  const { parse } = setup(t);
  const result = parse(`Peacemaker
Season 1
Season 2 — the DCU one

## Lanterns
Season 1`);
  assert.deepEqual(result.entries.map(e => `${e.title} S${e.season}${e.note ? ' ' + e.note : ''}`), ['Peacemaker S1', 'Peacemaker S2 the DCU one', 'Lanterns S1']);
});

test('plain lines, bullets, task lists, bracket years, notes, ids and URLs', t => {
  const { parse } = setup(t);
  const result = parse(`Superman (2025)
- Supergirl [2026]
* [ ] Lanterns
2) The Batman (2022) — watch before The Penguin
https://www.themoviedb.org/movie/49521-man-of-steel
[Peacemaker](https://www.themoviedb.org/tv/110492-peacemaker/season/2)
https://www.themoviedb.org/tv/60735/season/1/episode/8
tt0770828
tmdb:tv/1399
Show tvdb:391153
https://thetvdb.com/dereferrer/series/391153
&quot;Amélie&quot; &amp; friends (2001)`);
  const e = result.entries;
  assert.deepEqual(pick(e.slice(0, 4), 'title', 'year', 'note'), [
    { title: 'Superman', year: 2025 }, { title: 'Supergirl', year: 2026 }, { title: 'Lanterns' },
    { title: 'The Batman', year: 2022, note: 'watch before The Penguin' }
  ]);
  assert.deepEqual(e[4].ids, { tmdb: 49521, tmdbType: 'movie' });
  assert.equal(e[4].typeHint, 'movie');
  assert.deepEqual([e[5].title, e[5].ids, e[5].season, e[5].kind], ['Peacemaker', { tmdb: 110492, tmdbType: 'tv' }, 2, 'season']);
  assert.deepEqual([e[6].ids.tmdb, e[6].episodes], [60735, [{ s: 1, e: 8 }]]);
  assert.deepEqual(e[7].ids, { imdb: 'tt0770828' });
  assert.deepEqual(e[8].ids, { tmdb: 1399, tmdbType: 'tv' });
  assert.deepEqual([e[9].title, e[9].ids], ['Show', { tvdb: 391153 }]);
  assert.deepEqual(e[10].ids, { tvdb: 391153 });
  assert.deepEqual([e[11].title, e[11].year], ['"Amélie" & friends', 2001]);
});

test('list URLs are pointed at the URL import instead of being parsed as titles', t => {
  const { parse } = setup(t);
  const result = parse(`https://mdblist.com/lists/linaspurinis/top-watched-movies-of-the-week
https://trakt.tv/users/justin/lists/imdb-top-rated-movies
https://letterboxd.com/dave/list/official-top-250/
https://www.imdb.com/list/ls055592025/
https://www.themoviedb.org/list/8136-star-wars
<https://www.imdb.com/chart/top/>`);
  assert.equal(result.entries.length, 0);
  assert.deepEqual(result.skipped.map(s => [s.reason, s.provider]), [
    ['listUrl', 'mdblist'], ['listUrl', 'trakt'], ['listUrl', 'letterboxd'], ['listUrl', 'imdb'], ['listUrl', 'tmdb'], ['listUrl', 'imdb']
  ]);
});

test('chronolists watch-order URLs go to the URL import; other chronolists pages do not', t => {
  const { parse } = setup(t);
  const result = parse(`https://chronolists.com/dctv
chronolists.com/star-wars/
<https://www.chronolists.com/mcu?ref=home>
https://chronolists.com/dctv/extra
Watch it all: https://chronolists.com/dctv`);
  assert.deepEqual(result.skipped.filter(s => s.reason === 'listUrl').map(s => [s.line, s.provider]), [
    [1, 'chronolists'], [2, 'chronolists'], [3, 'chronolists']
  ]);
  assert.ok(!result.skipped.some(s => s.reason === 'listUrl' && s.line > 3));
});

test('IMDb CSV exports: ids, title types, episodes and quoted fields', t => {
  const { parse } = setup(t);
  const csv = `Position,Const,Created,Modified,Description,Title,Original Title,URL,Title Type,IMDb Rating,Runtime (mins),Year,Genres,Num Votes,Release Date,Directors
1,tt0770828,2024-01-01,2024-01-01,"A note, with a comma",Man of Steel,Man of Steel,https://www.imdb.com/title/tt0770828/,Movie,7.1,143,2013,"Action, Adventure",800000,2013-06-12,Zack Snyder
2,tt13146488,2024-01-01,2024-01-01,,Peacemaker,Peacemaker,https://www.imdb.com/title/tt13146488/,TV Series,8.3,40,2022,Action,200000,2022-01-13,
3,tt0959621,2024-01-01,2024-01-01,"Line one
line two",Pilot,Pilot,https://www.imdb.com/title/tt0959621/,TV Episode,9.0,58,2008,Drama,40000,2008-01-20,Vince Gilligan
4,tt1234567,2024-01-01,2024-01-01,,Batman: Arkham Knight,,https://www.imdb.com/title/tt1234567/,Video Game,9.0,,2015,,1,,
`;
  const result = parse(csv);
  assert.equal(result.format, 'csv-imdb');
  assert.deepEqual(pick(result.entries, 'title', 'year', 'date', 'typeHint', 'ids', 'imdbEpisode', 'note'), [
    { title: 'Man of Steel', year: 2013, date: '2013-06-12', typeHint: 'movie', ids: { imdb: 'tt0770828' }, note: 'A note, with a comma' },
    { title: 'Peacemaker', year: 2022, date: '2022-01-13', typeHint: 'tv', ids: { imdb: 'tt13146488' } },
    { title: 'Pilot', year: 2008, date: '2008-01-20', typeHint: 'tv', ids: { imdb: 'tt0959621' }, imdbEpisode: true, note: 'Line one line two' }
  ]);
  assert.equal(result.entries[2].kind, 'episodes');
  assert.deepEqual(result.skipped.map(s => s.reason), ['unsupportedType']);
});

test('Letterboxd CSV exports (with the list-metadata preamble) and generic CSV sheets', t => {
  const { parse } = setup(t);
  const letterboxd = parse(`Letterboxd list export v7
Date,Name,Tags,URL,Description
2024-01-01,DC favourites,,https://boxd.it/abc,My list

Position,Name,Year,URL,Description
1,Man of Steel,2013,https://boxd.it/1,
2,"Superman, the Movie",1978,https://boxd.it/2,the best
`);
  assert.equal(letterboxd.format, 'csv-letterboxd');
  assert.deepEqual(pick(letterboxd.entries, 'title', 'year', 'typeHint', 'note'), [
    { title: 'Man of Steel', year: 2013, typeHint: 'movie' },
    { title: 'Superman, the Movie', year: 1978, typeHint: 'movie', note: 'the best' }
  ]);

  const generic = parse(`title,year,tmdb_id,type,season,episode
Peacemaker,2022,110492,tv,1,
The Flash,2014,60735,tv,1,8
Superman,2025,1061474,movie,,
`);
  assert.equal(generic.format, 'csv');
  assert.deepEqual(pick(generic.entries, 'title', 'kind', 'season', 'episodes', 'ids'), [
    { title: 'Peacemaker', kind: 'season', season: 1, ids: { tmdb: 110492, tmdbType: 'tv' } },
    { title: 'The Flash', kind: 'episodes', season: 1, episodes: [{ s: 1, e: 8 }], ids: { tmdb: 60735, tmdbType: 'tv' } },
    { title: 'Superman', kind: 'movie', ids: { tmdb: 1061474, tmdbType: 'movie' } }
  ]);
});

test('headings, rules, fences, blank lines and prose are skipped; duplicates are flagged', t => {
  const { parse } = setup(t);
  const result = parse(`# DC watch orders

Checked **10 October 2026**. Start with the DCEU and DCU sections, then pick any of the separate tracks.

---
\`\`\`
Superman (1978)
Superman (1978)
Superman (2025)
Pick one of these:
The clean story sequence is **Creature Commandos → Superman → Peacemaker S2**. Supergirl follows Superman, but a fully fixed relative position for every DCU story is not asserted here at all.`);
  assert.deepEqual(result.entries.map(e => [e.title, e.year, e.dupOf ?? null]), [['Superman', 1978, null], ['Superman', 1978, 0], ['Superman', 2025, null]]);
  assert.deepEqual(result.skipped.map(s => s.reason), ['prose', 'prose', 'prose']);
  assert.deepEqual(result.sections, [{ title: 'DC watch orders', line: 1, firstEntry: 0 }]);
});

test('limits: entries are capped and long pastes parse fast', t => {
  const { parse } = setup(t);
  const lines = Array.from({ length: 300 }, (_, i) => `${i + 1}. [Title ${i}](https://example.test/${i}) (${1950 + (i % 70)}) · Film · Released — note ${i}`).join('\n');
  parse(lines.split('\n').slice(0, 20).join('\n')); // warm-up (regex compilation), so only the parse itself is timed
  const started = performance.now();
  const result = parse(lines);
  const elapsed = performance.now() - started;
  assert.equal(result.entries.length, 300);
  // ~85 ms alone; the bound leaves room for the coverage-instrumented, parallel CI run and still catches a blow-up.
  assert.ok(elapsed < 1500, `300 lines took ${elapsed} ms`);

  const capped = parse(lines, { maxEntries: 10 });
  assert.equal(capped.entries.length, 10);
  assert.equal(capped.truncated, true);

  const huge = parse('x'.repeat(10) + '\n' + 'Title (2000)\n'.repeat(2500));
  assert.equal(huge.entries.length, 2000);
  assert.equal(huge.truncated, true);
  assert.equal(parse('').entries.length, 0);
  assert.equal(parse(null).entries.length, 0);
});

test('internals: release values, type and status words, episode refs, markdown stripping', t => {
  const { parser } = setup(t);
  const i = parser.internals;
  assert.deepEqual(plain(i.parseRelease('2019–20')), { year: 2019 });
  assert.deepEqual(plain(i.parseRelease('TBA')), { status: 'tba' });
  assert.deepEqual(plain(i.parseRelease('2024-12-05')), { year: 2024, date: '2024-12-05' });
  assert.equal(i.parseRelease('1700'), null);
  assert.equal(i.parseRelease('soon'), null);
  assert.equal(i.typeFromWords('TV season'), 'tv');
  // Formats that are films or TV (the DC guide: compilations and specials of TV shows, short-series alternate editions)
  // give no hint, unless other words say which.
  for (const neutral of ['Compilation', 'TV special', 'Special', 'Alternate edition', 'Short collection']) assert.equal(i.typeFromWords(neutral), undefined, neutral);
  assert.equal(i.typeFromWords('Compilation film'), 'movie');
  assert.equal(i.typeFromWords('Compilation series'), 'tv');
  assert.equal(i.typeFromWords('Short'), 'movie');
  assert.equal(i.typeFromWords('Short series'), 'tv');
  assert.equal(i.typeFromWords('Pilot'), undefined);
  assert.equal(i.statusFromWords('Reported / uncertain'), 'tba');
  assert.equal(i.statusFromWords('Post production'), 'scheduled');
  assert.equal(i.statusFromWords('Pilot only'), 'released');
  assert.equal(i.findEpisodeRef('no numbers here 2019'), null);
  assert.equal(i.stripMarkdown('**Bold** [link](https://x.test) `code` _em_ snake_case'), 'Bold link code em snake_case');
  assert.equal(i.looksLikeProse('Man of Steel'), false);
  assert.equal(i.looksLikeProse('Watch these next:'), true);
});

test('cross-season ranges cover every season in between (review round)', t => {
  const { parse } = setup(t);
  const e = parse(`Doctor Who S1E5-S3E3
The Flash 7x18-8x02
Show S1E1-S2E3`).entries;
  const shape = e.map(x => ({ title: x.title, kind: x.kind, season: x.season, eps: (x.episodes || []).map(ep => `${ep.s}x${ep.e}`).join(','), openEnded: x.openEnded }));
  assert.deepEqual(shape, [
    // Season 1 from episode 5 to its end (the server fills the rest), all of season 2, season 3 episodes 1-3.
    { title: 'Doctor Who', kind: 'episodes', season: 1, eps: '1x5', openEnded: true },
    { title: 'Doctor Who', kind: 'season', season: 2, eps: '', openEnded: undefined },
    { title: 'Doctor Who', kind: 'episodes', season: 3, eps: '3x1,3x2,3x3', openEnded: undefined },
    { title: 'The Flash', kind: 'episodes', season: 7, eps: '7x18', openEnded: true },
    { title: 'The Flash', kind: 'episodes', season: 8, eps: '8x1,8x2', openEnded: undefined },
    // A range starting at episode 1 is the whole first season.
    { title: 'Show', kind: 'season', season: 1, eps: '', openEnded: undefined },
    { title: 'Show', kind: 'episodes', season: 2, eps: '2x1,2x2,2x3', openEnded: undefined }
  ]);
  // An episode reference after the year still counts.
  const dated = parse('Doctor Who (2005) S1E11-S3E2').entries;
  assert.deepEqual(dated.map(x => [x.title, x.year, x.season, (x.episodes || []).map(ep => ep.e).join(',')]), [
    ['Doctor Who', 2005, 1, '11'], ['Doctor Who', 2005, 2, ''], ['Doctor Who', 2005, 3, '1,2']
  ]);
});

test('instruction parentheticals are notes, not episode titles (WATCH_GUIDE DCAU line)', t => {
  const { parse } = setup(t);
  const line = 'Practical order: Batman: TAS → Mask of the Phantasm → SubZero → Superman: TAS and The New Batman Adventures → Mystery of the Batwoman → Static Shock → Justice League → Justice League Unlimited (save “Epilogue”) → Batman Beyond → Return of the Joker → The Zeta Project → “Epilogue.” Superman: TAS and The New Batman Adventures overlap; their major “World’s Finest” crossover is part of Superman: TAS.';
  const e = parse(line).entries;
  const jlu = e.find(x => x.title.startsWith('Justice League Unlimited'));
  assert.equal(jlu.title, 'Justice League Unlimited');
  assert.equal(jlu.episodeTitle, undefined);
  assert.equal(jlu.kind, undefined);
  assert.equal(jlu.note, 'save "Epilogue"');
  assert.ok(!e.some(x => /\(/.test(x.title)), 'no title keeps an unbalanced parenthesis');
  assert.ok(!e.some(x => x.title === 'Epilogue.'), 'no trailing period on the quoted title');

  const single = parse('Justice League Unlimited (save "Epilogue")').entries;
  assert.deepEqual(pick(single, 'title', 'note', 'episodeTitle'), [{ title: 'Justice League Unlimited', note: 'save "Epilogue"' }]);
  // A quote right after the series name is still an episode title.
  assert.equal(parse('Legends "Crisis on Infinite Earths: Part Five"').entries[0].episodeTitle, 'Crisis on Infinite Earths: Part Five');
});

test('chain segments keep the ids of their links', t => {
  const { parse } = setup(t);
  const e = parse('[The Flash](https://www.themoviedb.org/tv/60735) **1x08** → [Arrow](https://www.themoviedb.org/tv/1412) **3x08** → [Supergirl](https://www.imdb.com/title/tt4016454/) 2x08').entries;
  assert.deepEqual(e.map(x => [x.title, x.ids]), [
    ['The Flash', { tmdb: 60735, tmdbType: 'tv' }],
    ['Arrow', { tmdb: 1412, tmdbType: 'tv' }],
    ['Supergirl', { imdb: 'tt4016454' }]
  ]);
});

test('CSV exports honour the entry cap and report truncation', t => {
  const { parse } = setup(t);
  const rows = Array.from({ length: 2001 }, (_, i) => `2024-01-01,Film ${i},${1950 + (i % 70)},https://boxd.it/x${i},`).join('\n');
  const csv = `Date,Name,Year,Letterboxd URI,Description\n${rows}`;
  const result = parse(csv);
  assert.equal(result.format, 'csv-letterboxd');
  assert.equal(result.entries.length, 2000);
  assert.equal(result.truncated, true);
  const small = parse(csv, { maxEntries: 5 });
  assert.equal(small.entries.length, 5);
  assert.equal(small.truncated, true);
  const exact = parse(`Date,Name,Year,Letterboxd URI\n2024-01-01,A,2001,u\n2024-01-01,B,2002,u\n\n`);
  assert.equal(exact.entries.length, 2);
  assert.equal(exact.truncated, false);
});

test('duplicate flags: titles in any script and bare TVDB ids keep their identity (review round)', t => {
  const { parse } = setup(t);
  const japanese = parse('千と千尋の神隠し (2001)\nメトロポリス (2001)\n千と千尋の神隠し (2001)').entries;
  assert.deepEqual(japanese.map(e => e.dupOf), [undefined, undefined, 0]);
  const cyrillic = parse('Брат\nСталкер\nБРАТ').entries;
  assert.deepEqual(cyrillic.map(e => e.dupOf), [undefined, undefined, 0]);
  const tvdb = parse('tvdb:391153\ntvdb:279121\nhttps://thetvdb.com/dereferrer/series/279121').entries;
  assert.deepEqual(tvdb.map(e => e.ids?.tvdb), [391153, 279121, 279121]);
  assert.deepEqual(tvdb.map(e => e.dupOf), [undefined, undefined, 1]);
});

test('a season or episode selector after a leading link stays with the title (review round)', t => {
  const { parse } = setup(t);
  const [flash] = parse('1. [The Flash](https://www.themoviedb.org/tv/60735) S01E08 (2014)').entries;
  assert.deepEqual(pick([flash], 'title', 'year', 'kind', 'season', 'episodes')[0], { title: 'The Flash', year: 2014, kind: 'episodes', season: 1, episodes: [{ s: 1, e: 8 }] });
  assert.equal(flash.ids.tmdb, 60735);
  for (const line of ['[Peacemaker](https://www.themoviedb.org/tv/110492) — Season 1 (2022)', '[Peacemaker](https://www.themoviedb.org/tv/110492) Season 1 (2022)']) {
    const entries = parse(line).entries;
    assert.deepEqual(pick(entries, 'title', 'year', 'kind', 'season'), [{ title: 'Peacemaker', year: 2022, kind: 'season', season: 1 }], line);
    assert.equal(entries[0].note, undefined, line);
  }
  // After the year, as on plain lines ("Doctor Who (2005) S1E11–S3E2").
  const who = parse('[Doctor Who](https://www.themoviedb.org/tv/57243) (2005) S1E11–S3E2').entries;
  assert.deepEqual(who.map(e => e.season), [1, 2, 3]);
  assert.ok(who.every(e => e.title === 'Doctor Who' && e.year === 2005 && e.ids.tmdb === 57243));
  // Metadata that merely mentions a season stays a note.
  const [steel] = parse('[Man of Steel](https://x.example/m) (2013) · Film · Released — Season 1 of the saga').entries;
  assert.deepEqual(pick([steel], 'title', 'kind', 'note')[0], { title: 'Man of Steel', kind: 'movie', note: 'Season 1 of the saga' });
});
