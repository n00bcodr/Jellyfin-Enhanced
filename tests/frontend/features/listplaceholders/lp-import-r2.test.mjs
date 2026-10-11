import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, plain } from '../../helpers/harness.mjs';
import { setup } from './lp-harness.mjs';

// Review round 2 (import): long episode scopes become several placeholders of at most 100 episodes instead of being cut
// at 100, and a chosen alternative brings the rest of its scope.

function setupImport(t) {
  const h = setup(t, {
    plugin: async () => ({}),
    jellyseerrAPI: { search: async () => ({ results: [] }), fetchTvShowDetails: async () => ({}), fetchTvSeasonDetails: async () => ({ episodes: [] }) }
  });
  h.load('jellyseerr/modal.js');
  h.load('jellyseerr/listplaceholders/listplaceholders-parser.js');
  return h;
}

const placeholders = entries => plain(entries).map(e => e.placeholder);
const numbers = ph => ph.episodes.map(e => `${e.s}x${e.e}`);

test('R2: an open-ended range the server expanded past 100 episodes is split, not cut', t => {
  const imp = setupImport(t).lp.importer;
  const episodes = Array.from({ length: 146 }, (_, i) => ({ s: 1, e: i + 5, airDate: `2001-01-${String((i % 28) + 1).padStart(2, '0')}` }));
  const row = {
    action: 'placeholder', cand: 0, result: { kind: 'episodes' },
    entry: { title: 'Show', season: 1, episodes: [{ s: 1, e: 5 }], openEnded: true },
    cands: [{ mediaType: 'tv', tmdbId: 9, title: 'Show', episodes }]
  };
  const out = placeholders(imp.rowEntries(row, 'playlist'));
  assert.equal(out.length, 2);
  assert.deepEqual(out.map(p => p.episodes.length), [100, 46]);
  assert.equal(out[0].episodes[0].e, 5);
  assert.equal(out[1].episodes[0].e, 105);
  assert.equal(out[1].releaseDate, episodes[100].airDate);
  assert.ok(out.every(p => p.kind === 'episodes' && p.seasonNumber === 1 && p.tmdbId === 9));
});

test('R2: a chosen alternative with a cross-season range brings its later season too', t => {
  const h = setupImport(t);
  const [entry] = plain(h.JE.listPlaceholders.parser.parse('Doctor Who S1E5–S2E3 **or** Torchwood 1x01')).entries;
  const doctorWho = { mediaType: 'tv', tmdbId: 57243, title: 'Doctor Who', alternative: 0, posterPath: '/dw.jpg' };
  const torchwood = { mediaType: 'tv', tmdbId: 1, title: 'Torchwood', alternative: 1 };
  const row = { action: 'placeholder', cand: 0, result: { kind: 'episodes' }, entry, cands: [doctorWho, torchwood] };
  const out = placeholders(h.lp.importer.rowEntries(row, 'playlist'));
  assert.deepEqual(out.map(numbers), [['1x5'], ['2x1', '2x2', '2x3']]);
  assert.equal(out[1].posterPath, '/dw.jpg');
  // The other alternative has no more scope; "Add both" adds each alternative's own.
  row.cand = 1;
  assert.deepEqual(placeholders(h.lp.importer.rowEntries(row, 'playlist')).map(numbers), [['1x1']]);
  row.both = true;
  assert.deepEqual(placeholders(h.lp.importer.rowEntries(row, 'playlist')).map(numbers), [['1x5'], ['2x1', '2x2', '2x3'], ['1x1']]);
});

test('R2: an alternative over 100 episodes keeps every episode, in chunks', t => {
  const h = setupImport(t);
  const [entry] = plain(h.JE.listPlaceholders.parser.parse('One Piece 1x01-150 **or** Naruto 1x01-150')).entries;
  const row = { action: 'placeholder', cand: 1, result: { kind: 'episodes' }, entry,
    cands: [{ mediaType: 'tv', tmdbId: 37854, title: 'One Piece', alternative: 0 }, { mediaType: 'tv', tmdbId: 46260, title: 'Naruto', alternative: 1 }] };
  const out = placeholders(h.lp.importer.rowEntries(row, 'playlist'));
  assert.deepEqual(out.map(p => [p.tmdbId, p.episodes.length, p.episodes[0].e]), [[46260, 100, 1], [46260, 50, 101]]);
});
