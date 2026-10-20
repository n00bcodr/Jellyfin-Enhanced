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

// ------------------------------------------------------------------ review round 1: dependencies invalidate; initialization is an intent

/** Every declared edge of the scope picker's dependency table and the test(s) that cover it. */
const EDGE_TESTS = {
  'user -> preselect': ['4C3B1-R1-7', '4C3B1-R1-8'],
  'mode -> selection': ['edge mode -> selection'],
  'season -> episodes': ['4C3B1-R1-6', 'edge season -> episodes (loads)'],
  'season -> selection': ['edge season -> selection']
};

test('4C3B1-R1-6: a season change outside episode mode drops the previous season\'s episodes (facts and picks)', async t => {
  const { g, root, reads } = presenter(t);
  await g.setMode('episodes');
  await g.setSeason(1);
  assert.match(root.textContent, /S1 episode title 1/);
  await g.setMode('season');
  await g.setSeason(2);
  await g.setMode('episodes');
  assert.doesNotMatch(root.textContent, /S1 episode title/, 'season 1\'s episodes are not shown for season 2');
  assert.match(root.textContent, /S2 episode title 1/);
  assert.deepEqual(reads.filter(r => r[0] === 'episodes').map(r => r[1]), [1, 2], 'season 2\'s episodes are read');
  assert.equal(g.toggleEpisode(1, true), true);
  assert.deepEqual(g.selection(), { kind: 'episodes', seasonNumber: 2, episodes: [{ s: 2, e: 1 }], edition: 'standard' });
});

test('edge season -> episodes (loads): a season change ends an episode load still running, whatever the mode', async t => {
  const loads = new Map();
  const { g, root } = presenter(t, { episodes: (id, season) => { const d = deferred(); loads.set(season, d); return d.promise; } });
  await g.setMode('episodes');
  const pending = g.setSeason(1);
  await g.setMode('season');
  await g.setSeason(2);
  loads.get(1).resolve({ status: 200, body: EPISODES(1, 3) });
  await pending;
  const back = g.setMode('episodes');
  for (let i = 0; i < 20 && !loads.has(2); i++) await new Promise(r => setTimeout(r, 1));
  assert.doesNotMatch(root.textContent, /S1 episode title/, 'the late season 1 answer is not used');
  assert.ok(loads.has(2), 'season 2\'s episodes are read');
  loads.get(2).resolve({ status: 200, body: EPISODES(2, 2) });
  await back;
  assert.match(root.textContent, /S2 episode title 2/);
  assert.equal(g.toggleEpisode(3, true), false, 'season 1\'s third episode is not an episode of season 2');
});

test('edge mode -> selection: changing the mode drops the episodes picked in the old mode', async t => {
  const { g, root } = presenter(t);
  await g.setMode('episodes');
  await g.setSeason(1);
  g.toggleEpisode(1, true);
  g.toggleEpisode(2, true);
  await g.setMode('season');
  assert.deepEqual(g.selection(), { kind: 'season', seasonNumber: 1, edition: 'standard' });
  await g.setMode('episodes');
  assert.equal(g.selection(), null, 'nothing picked after coming back: the old picks belonged to the old mode');
  assert.equal([...root.querySelectorAll('input[type="checkbox"]')].filter(b => b.checked).length, 0);
  // Choosing the mode already chosen changes nothing.
  g.toggleEpisode(3, true);
  await g.setMode('episodes');
  assert.deepEqual(g.selection().episodes, [{ s: 1, e: 3 }]);
});

test('edge season -> selection: changing the season drops the picks of the old season', async t => {
  const { g } = presenter(t);
  await g.setMode('episodes');
  await g.setSeason(1);
  g.toggleEpisode(2, true);
  await g.setSeason(2);
  assert.equal(g.selection(), null);
  // The same season again keeps them.
  g.toggleEpisode(2, true);
  await g.setSeason(2);
  assert.deepEqual(g.selection().episodes, [{ s: 2, e: 2 }]);
});

test('4C3B1-R1-7: a preselection still loading never overwrites a newer explicit choice', async t => {
  for (const choose of [
    async g => { await g.setMode('series'); return { kind: 'series', edition: 'standard' }; },
    async g => { const p = g.setMode('season'); const q = g.setSeason(2); await Promise.all([p, q]); return { kind: 'season', seasonNumber: 2, edition: 'standard' }; }
  ]) {
    const seasons = deferred();
    const { g, reads, root } = presenter(t, { seasons: () => seasons.promise, initial: { kind: 'episodes', seasonNumber: 1, episodes: [2] } });
    const chosen = choose(g);
    seasons.resolve({ status: 200, body: SEASONS });
    const expected = await chosen;
    await g.ready;
    assert.deepEqual(g.selection(), expected, 'the person\'s choice stands');
    assert.equal(g.reason(), null);
    assert.equal(reads.filter(r => r[0] === 'episodes').length, 0, 'the old preselection reads no episodes');
    assert.equal(root.querySelector(`input[type="radio"][value="${expected.kind}"]`).checked, true);
  }
  // Positive control: untouched, the preselection applies.
  const { g } = presenter(t, { initial: { kind: 'episodes', seasonNumber: 1, episodes: [2] } });
  await g.ready;
  assert.deepEqual(g.selection(), { kind: 'episodes', seasonNumber: 1, episodes: [{ s: 1, e: 2 }], edition: 'standard' });
});

test('4C3B1-R1-8: a failed preselection never blocks a later valid explicit season or episode choice', async t => {
  // The asked-for season is not one of the show's: nothing is chosen (never widened), and the person can still choose.
  const { g, root } = presenter(t, { initial: { kind: 'episodes', seasonNumber: 7, episodes: [1] } });
  await g.ready;
  assert.equal(g.selection(), null);
  assert.equal(g.reason(), 'scope_lost');
  await g.setMode('season');
  assert.equal(g.reason(), null, 'the person\'s choice supersedes the failed preselection');
  assert.equal(g.selection(), null, 'still nothing until a season is chosen (never widened)');
  await g.setSeason(2);
  assert.deepEqual(g.selection(), { kind: 'season', seasonNumber: 2, edition: 'standard' });
  await g.setMode('episodes');
  await g.setSeason(1);
  g.toggleEpisode(1, true);
  assert.deepEqual(g.selection(), { kind: 'episodes', seasonNumber: 1, episodes: [{ s: 1, e: 1 }], edition: 'standard' });
  assert.doesNotMatch(root.textContent, /nothing is chosen/, 'the old reason is no longer said');
  // Episodes that can't all be found: same.
  const p2 = presenter(t, { initial: { kind: 'episodes', seasonNumber: 1, episodes: [2, 9] } });
  await p2.g.ready;
  assert.equal(p2.g.reason(), 'scope_lost');
  await p2.g.setMode('season');
  await p2.g.setSeason(1);
  assert.deepEqual(p2.g.selection(), { kind: 'season', seasonNumber: 1, edition: 'standard' });
});

test('the scope picker\'s dependency table is declared and every edge has its test', t => {
  const s = setupAuthoring(t);
  const edges = Object.entries(s.lp().granularity.DEPENDS).flatMap(([up, downs]) => downs.map(d => `${up} -> ${d}`));
  assert.deepEqual(edges.sort(), Object.keys(EDGE_TESTS).sort());
});
