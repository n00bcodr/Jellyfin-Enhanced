import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, tick } from './lp-harness.mjs';

// Review round 4 (import): Change match → Done on an alternative whose first part has more than 100 episodes keeps the
// alternative's later scopes, although the library check that follows looks at 100 episodes only.

const until = async (fn, tries = 400) => { for (let i = 0; i < tries; i++) { const v = fn(); if (v) return v; await tick(); } throw new Error('timeout'); };
const plainJson = value => JSON.parse(JSON.stringify(value));
const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

test('R4: an untouched picker over a >100-episode first part keeps the alternative\'s next season after the library check', async t => {
  const calls = [];
  const fallon = { mediaType: 'tv', tmdbId: 59941, title: 'The Tonight Show Starring Jimmy Fallon', year: 2014, releaseDate: '2014-02-17', alternative: 0,
    season: { seasonNumber: 1, episodeCount: 200, airDate: '2014-02-17' }, episodes: range(5, 200).map(e => ({ s: 1, e })) };
  const lateNight = { mediaType: 'tv', tmdbId: 2, title: 'Late Night', year: 2009, alternative: 1, season: { seasonNumber: 1, episodeCount: 150, airDate: '2009-03-02' } };
  let probes = 0;
  const h = setup(t, {
    plugin: async (path, options = {}) => {
      const body = plainJson(options.body ?? null);
      calls.push([path, body]);
      if (path === '/list-placeholders/resolve') {
        const probe = body.entries[0];
        if (probe.ids) {
          // The library check: the server answers for exactly the episodes it was asked about.
          probes++;
          return { results: [{ index: 0, state: 'ok', confidence: 'high', kind: 'episodes', match: { ...fallon, alternative: undefined, episodes: probe.episodes, inLibrary: null } }] };
        }
        return { results: [{ index: 0, state: 'ok', confidence: 'low', kind: 'episodes', match: fallon, candidates: [fallon, lateNight], reasons: ['alternatives'], alternatives: true }] };
      }
      return { listId: 'f'.repeat(32), name: 'x', result: { added: [], addedAsItems: [], skipped: [] } };
    },
    jellyseerrAPI: {
      search: async () => ({ results: [] }),
      fetchTvShowDetails: async () => ({ id: 59941, name: 'The Tonight Show Starring Jimmy Fallon', seasons: [{ seasonNumber: 1, episodeCount: 200, airDate: '2014-02-17' }, { seasonNumber: 2, episodeCount: 180, airDate: '2014-09-01' }] }),
      fetchTvSeasonDetails: async (id, season) => ({ episodes: range(1, season === 1 ? 200 : 180).map(e => ({ episodeNumber: e, seasonNumber: season, name: `Episode ${e}`, airDate: '2014-03-01' })) })
    }
  });
  h.load('jellyseerr/modal.js');
  h.load('jellyseerr/listplaceholders/listplaceholders-parser.js');
  const root = h.lp.importer.open({ mode: 'new' }).modalElement;
  root.querySelector('.je-lp-import-text').value = 'The Tonight Show Starring Jimmy Fallon S1E5–S2E3 **or** Late Night Season 1';
  root.querySelector('.jellyseerr-modal-button-primary').click();
  await until(() => root.querySelector('.je-lp-import-progress').hidden);
  root.querySelector('.je-lp-irow[data-i="0"] .je-lp-irow-edit').click();
  const ed = root.querySelector('.je-lp-ieditor');
  const radio = ed.querySelectorAll('.je-lp-ieditor-cand input')[0];
  radio.checked = true;
  radio.dispatchEvent(new h.window.Event('change', { bubbles: true }));
  await until(() => !ed.querySelector('.je-lp-ieditor-done').disabled);
  ed.querySelector('.je-lp-ieditor-done').click();
  await until(() => probes === 1);
  for (let i = 0; i < 10; i++) await tick();

  root.querySelector('.je-lp-new-name').value = 'Fallon';
  root.querySelector('.jellyseerr-modal-button-primary').click();
  await until(() => calls.some(c => c[0] === '/list-placeholders/playlists'));
  const placeholders = calls.find(c => c[0] === '/list-placeholders/playlists')[1].entries.map(e => e.placeholder);
  const episodes = placeholders.flatMap(p => (p.episodes || []).map(e => `${e.s}x${e.e}`));
  assert.deepEqual(episodes, [...range(5, 200).map(e => `1x${e}`), '2x1', '2x2', '2x3']);
});
