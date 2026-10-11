import test from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './lp-harness.mjs';

// Review round 1 (track h1, F52): an "A or B" alternative is imported with its own season and episodes, not the first
// alternative's.

const plainJson = value => JSON.parse(JSON.stringify(value));

function setupImport(t) {
  const h = setup(t, {
    plugin: async () => ({}),
    jellyseerrAPI: { search: async () => ({ results: [] }), fetchTvShowDetails: async () => ({}), fetchTvSeasonDetails: async () => ({ episodes: [] }) }
  });
  h.load('jellyseerr/modal.js');
  return h;
}

const entry = (first, second) => ({
  title: 'Flash', typeHint: 'tv', kind: 'episodes', season: first.s, episodes: [first],
  alternatives: [
    { title: 'Flash', typeHint: 'tv', season: first.s, episodes: [first] },
    { title: 'Arrow', typeHint: 'tv', season: second.s, episodes: [second] }
  ]
});

test('F52: toImportEntry sends each alternative\'s own episodes and open-ended flag', t => {
  const imp = setupImport(t).lp.importer;
  const dto = plainJson(imp.toImportEntry({
    title: 'Flash', episodes: [{ s: 1, e: 8 }],
    alternatives: [
      { title: 'Flash', season: 1, episodes: [{ s: 1, e: 8 }] },
      { title: 'Doctor Who', season: 1, episodes: [{ s: 1, e: 5 }], openEnded: true },
      { title: 'Arrow', episodes: Array.from({ length: 120 }, (_, i) => ({ s: 3, e: i + 1 })) }
    ]
  }, 0));
  assert.deepEqual(dto.alternatives[0], { title: 'Flash', season: 1, episodes: [{ s: 1, e: 8 }] });
  assert.deepEqual(dto.alternatives[1], { title: 'Doctor Who', season: 1, episodes: [{ s: 1, e: 5 }], openEnded: true });
  assert.equal(dto.alternatives[2].episodes.length, 100);
});

test('F52: the second alternative\'s placeholder uses its own season and episodes', t => {
  const imp = setupImport(t).lp.importer;
  // "Flash 1x08 or Arrow 3x09", Arrow candidate not enriched (no season facts).
  const bare = imp.placeholderFromCandidate({ mediaType: 'tv', tmdbId: 1412, title: 'Arrow', alternative: 1 }, entry({ s: 1, e: 8 }, { s: 3, e: 9 }), 'episodes');
  assert.equal(bare.kind, 'episodes');
  assert.equal(bare.seasonNumber, 3);
  assert.deepEqual(plainJson(bare.episodes), [{ s: 3, e: 9 }]);
  // Enriched with season 3 facts: still episode 9, not the whole season.
  const enriched = imp.placeholderFromCandidate({ mediaType: 'tv', tmdbId: 1412, title: 'Arrow', alternative: 1, season: { seasonNumber: 3, episodeCount: 23 } }, entry({ s: 1, e: 8 }, { s: 3, e: 9 }), 'episodes');
  assert.deepEqual(plainJson(enriched.episodes), [{ s: 3, e: 9 }]);
  // Same season, different episode: Arrow 1x09, not Flash's 1x08.
  const same = imp.placeholderFromCandidate({ mediaType: 'tv', tmdbId: 1412, title: 'Arrow', alternative: 1, season: { seasonNumber: 1 } }, entry({ s: 1, e: 8 }, { s: 1, e: 9 }), 'episodes');
  assert.deepEqual(plainJson(same.episodes), [{ s: 1, e: 9 }]);
  // The first alternative is unchanged.
  const first = imp.placeholderFromCandidate({ mediaType: 'tv', tmdbId: 60735, title: 'The Flash', alternative: 0 }, entry({ s: 1, e: 8 }, { s: 3, e: 9 }), 'episodes');
  assert.deepEqual(plainJson(first.episodes), [{ s: 1, e: 8 }]);
  // A whole-show alternative ("Flash 1x08 or Arrow") stays the whole show; its own season makes it a season.
  const whole = entry({ s: 1, e: 8 }, { s: 3, e: 9 });
  delete whole.alternatives[1].episodes;
  delete whole.alternatives[1].season;
  assert.equal(imp.placeholderFromCandidate({ mediaType: 'tv', tmdbId: 1412, title: 'Arrow', alternative: 1 }, whole, 'episodes').kind, 'series');
  whole.alternatives[1].season = 2;
  const season = imp.placeholderFromCandidate({ mediaType: 'tv', tmdbId: 1412, title: 'Arrow', alternative: 1 }, whole, 'episodes');
  assert.deepEqual([season.kind, season.seasonNumber], ['season', 2]);
});
