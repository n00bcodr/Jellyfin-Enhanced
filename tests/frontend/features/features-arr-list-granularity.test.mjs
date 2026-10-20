// Phase 4c3b1: what part of a title an entry holds. A movie; for a show the whole show, one season or a set of episodes
// of ONE season (specials are season 0, chosen explicitly). Seasons and episodes load only when asked for, the newest
// season choice wins over a slower older load, the episode set holds 0..100 (the 101st is refused in words), and an
// exact scope asked for by the caller (a season, episodes 2 and 5, the 4K edition) is preselected exactly. When the
// facts can't be read, an asked-for season or episodes never widen to the whole show: nothing is chosen. Guarded
// episode titles never reach the text.
import test from 'node:test';
import { setupAuthoring, deferred, assert } from './fixtures/arr-list-authoring.mjs';

const SEASONS = { state: 'complete', count: 3, seasons: [{ seasonNumber: 0, episodeCount: 2 }, { seasonNumber: 1, episodeCount: 3 }, { seasonNumber: 2, episodeCount: 120 }] };
const EPISODES = (season, n) => ({ state: 'complete', count: n, seasonNumber: season, episodes: Array.from({ length: n }, (_, i) => ({ episodeNumber: i + 1, title: `S${season} episode title ${i + 1}`, airDate: '2011-01-0' + ((i % 9) + 1) })) });
const SHOW = { mediaType: 'tv', tmdbId: 1399, title: 'A Show' };

function presenter(t, { seasons, episodes, policy, initial, media = SHOW } = {}) {
  const s = setupAuthoring(t);
  const L = s.lp();
  const reads = [];
  const ticket = L.gate.issue(null, () => true, policy || L.gate.policy(() => false, false));
  const root = s.mount();
  const g = L.granularity.create({
    ticket, root, media, initial,
    seasons: seasons === null ? undefined : (id, opts) => { reads.push(['seasons', id]); return (seasons || (async () => ({ status: 200, body: SEASONS })))(id, opts); },
    episodes: (id, season, opts) => { reads.push(['episodes', season]); return (episodes || (async (i, n) => ({ status: 200, body: EPISODES(n, n === 2 ? 120 : 3) })))(id, season, opts); }
  });
  t.after(() => g.destroy());
  return { ...s, L, g, root, reads };
}

test('a movie is the movie: no reads, no scope controls', async t => {
  const { g, reads, root } = presenter(t, { media: { mediaType: 'movie', tmdbId: 5, title: 'M' } });
  await g.ready;
  assert.deepEqual(g.selection(), { kind: 'movie', edition: 'standard' });
  assert.deepEqual(reads, []);
  assert.equal(root.querySelectorAll('input[type="radio"]').length, 0);
});

test('a show starts as the whole show; seasons load lazily, specials are an explicit season 0', async t => {
  const { g, reads, root } = presenter(t);
  await g.ready;
  assert.deepEqual(g.selection(), { kind: 'series', edition: 'standard' });
  assert.deepEqual(reads, [], 'nothing read until a season is asked for');
  await g.setMode('season');
  assert.deepEqual(reads, [['seasons', 1399]]);
  const options = [...root.querySelectorAll('select option')].map(o => [o.value, o.textContent]);
  assert.deepEqual(options.map(o => o[0]), ['1', '2', '0'], 'specials last');
  assert.match(options[2][1], /Specials \(season 0\)/);
  assert.equal(g.selection(), null, 'no season picked yet: incomplete, never season 0 by default');
  await g.setSeason(0);
  assert.deepEqual(g.selection(), { kind: 'season', seasonNumber: 0, edition: 'standard' });
  await g.setSeason(1);
  assert.deepEqual(g.selection(), { kind: 'season', seasonNumber: 1, edition: 'standard' });
  await g.setMode('season');
  assert.equal(reads.filter(r => r[0] === 'seasons').length, 1, 'the season list is read once');
});

test('episodes: 0, 1, 100 picks; the 101st is refused in words; the selection is one season', async t => {
  const { g, root } = presenter(t);
  await g.setMode('episodes');
  await g.setSeason(2);
  assert.equal(g.selection(), null, 'no episode yet');
  g.toggleEpisode(1, true);
  assert.deepEqual(g.selection(), { kind: 'episodes', seasonNumber: 2, episodes: [{ s: 2, e: 1 }], edition: 'standard' });
  for (let e = 2; e <= 100; e++) assert.equal(g.toggleEpisode(e, true), true);
  assert.equal(g.selection().episodes.length, 100);
  assert.equal(g.toggleEpisode(101, true), false, 'the 101st pick is refused');
  assert.equal(g.selection().episodes.length, 100);
  assert.match(root.textContent, /At most 100 episodes in one entry/);
  assert.equal(root.querySelector('input[type="checkbox"][value="101"]').checked, false);
  g.toggleEpisode(5, false);
  assert.equal(g.toggleEpisode(101, true), true, 'room again after unticking one');
});

test('a newer season choice wins over an older, slower episode load', async t => {
  const loads = new Map();
  const { g, root } = presenter(t, {
    episodes: (id, season) => { const d = deferred(); loads.set(season, d); return d.promise; }
  });
  await g.setMode('episodes');
  const older = g.setSeason(1);
  const newer = g.setSeason(2);
  loads.get(2).resolve({ status: 200, body: EPISODES(2, 2) });
  await newer;
  loads.get(1).resolve({ status: 200, body: EPISODES(1, 3) });
  await older;
  const boxes = [...root.querySelectorAll('input[type="checkbox"]')];
  assert.equal(boxes.length, 2, 'season 2\'s episodes, not season 1\'s');
  g.toggleEpisode(2, true);
  assert.deepEqual(g.selection().episodes, [{ s: 2, e: 2 }]);
  assert.equal(g.selection().seasonNumber, 2);
});

test('the caller\'s exact scope is preselected (season, episodes 2 and 5, 4K)', async t => {
  const { g, root } = presenter(t, { initial: { kind: 'episodes', seasonNumber: 1, episodes: [2, 5], edition: '4k' }, episodes: async (id, n) => ({ status: 200, body: EPISODES(n, 6) }) });
  await g.ready;
  assert.deepEqual(g.selection(), { kind: 'episodes', seasonNumber: 1, episodes: [{ s: 1, e: 2 }, { s: 1, e: 5 }], edition: '4k' });
  assert.equal(root.querySelector('input[type="radio"][value="episodes"]').checked, true);
  const s2 = presenter(t, { initial: { kind: 'season', seasonNumber: 2 } });
  await s2.g.ready;
  assert.deepEqual(s2.g.selection(), { kind: 'season', seasonNumber: 2, edition: 'standard' });
});

test('when seasons can\'t be read, an asked-for season or episodes never widen to the whole show', async t => {
  for (const failing of [async () => ({ status: 503, body: null }), async () => { throw new Error('down'); }, null]) {
    const { g, root } = presenter(t, { seasons: failing, initial: { kind: 'episodes', seasonNumber: 1, episodes: [2, 5] } });
    await g.ready;
    assert.equal(g.selection(), null, 'nothing chosen');
    assert.equal(g.reason(), 'scope_lost');
    assert.match(root.textContent, /nothing is chosen/);
    assert.equal(root.querySelector('input[type="radio"][value="season"]').disabled, true);
    // Choosing the whole show is the person's own, explicit choice.
    await g.setMode('series');
    assert.deepEqual(g.selection(), { kind: 'series', edition: 'standard' });
  }
  // Without a preselection, the whole show stays available and season choices are disabled with the reason.
  const { g, root } = presenter(t, { seasons: async () => ({ status: 200, body: { state: 'unavailable', reason: 'tmdb' } }) });
  await g.setMode('season');
  assert.equal(g.selection(), null);
  assert.match(root.textContent, /can't be listed right now/);
  await g.setMode('series');
  assert.deepEqual(g.selection(), { kind: 'series', edition: 'standard' });
});

test('partial season facts are usable but say so; an episodes read of another season is ignored', async t => {
  const { g, root } = presenter(t, {
    seasons: async () => ({ status: 200, body: { state: 'partial', seasons: [{ seasonNumber: 1, episodeCount: 3 }] } }),
    episodes: async () => ({ status: 200, body: EPISODES(7, 3) })
  });
  await g.setMode('episodes');
  assert.match(root.textContent, /Only some seasons could be listed/);
  await g.setSeason(1);
  assert.equal(root.querySelectorAll('input[type="checkbox"]').length, 0, 'facts of season 7 are not season 1\'s');
});

test('guarded episode titles stay out of labels, text and tooltips', async t => {
  const s = setupAuthoring(t);
  const L = s.lp();
  const guarded = L.gate.issue(null, () => true, L.gate.policy(() => true, true));
  const root = s.mount();
  const g = L.granularity.create({ ticket: guarded, root, media: SHOW, seasons: async () => ({ status: 200, body: SEASONS }), episodes: async (id, n) => ({ status: 200, body: EPISODES(n, 3) }) });
  t.after(() => g.destroy());
  await g.setMode('episodes');
  await g.setSeason(1);
  const text = root.textContent + [...root.querySelectorAll('[aria-label],[title]')].map(n => (n.getAttribute('aria-label') || '') + (n.title || '')).join(' ');
  assert.doesNotMatch(text, /episode title/);
  assert.doesNotMatch(text, /2011/, 'guarded air dates hidden too');
  assert.match(root.textContent, /Episode 1/);
});
