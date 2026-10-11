import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, tick } from './lp-harness.mjs';

// Review round 3 (import): confirming an alternative in Change match without touching the season picker keeps the
// alternative's whole scope ("Doctor Who Seasons 1–3 **or** Torchwood Season 1" adds seasons 1, 2 and 3).

const until = async (fn, tries = 200) => { for (let i = 0; i < tries; i++) { const v = fn(); if (v) return v; await tick(); } throw new Error('timeout'); };
const plainJson = value => JSON.parse(JSON.stringify(value));
const seasons = [1, 2, 3].map(n => ({ seasonNumber: n, episodeCount: 10, airDate: `200${4 + n}-03-26` }));

/**
 * Import modal over a /resolve that answers the alternatives line with both shows.
 * @returns {Promise<{h: object, root: HTMLElement, calls: Array}>}
 */
async function reviewAlternatives(t) {
  const calls = [];
  const dw = { mediaType: 'tv', tmdbId: 57243, title: 'Doctor Who', year: 2005, releaseDate: '2005-03-26', alternative: 0, season: { seasonNumber: 1, episodeCount: 10, airDate: '2005-03-26' } };
  const tw = { mediaType: 'tv', tmdbId: 1, title: 'Torchwood', year: 2006, alternative: 1, season: { seasonNumber: 1, episodeCount: 13, airDate: '2006-10-22' } };
  const h = setup(t, {
    plugin: async (path, options = {}) => {
      calls.push([path, plainJson(options.body ?? null)]);
      if (path === '/list-placeholders/resolve') {
        return { results: [{ index: 0, state: 'ok', confidence: 'low', kind: 'season', match: dw, candidates: [dw, tw], reasons: ['alternatives'], alternatives: true }] };
      }
      return { listId: 'f'.repeat(32), name: 'x', result: { added: [], addedAsItems: [], skipped: [] } };
    },
    jellyseerrAPI: {
      search: async () => ({ results: [] }),
      fetchTvShowDetails: async () => ({ id: 57243, name: 'Doctor Who', seasons }),
      fetchTvSeasonDetails: async () => ({ episodes: [] })
    }
  });
  h.load('jellyseerr/modal.js');
  h.load('jellyseerr/listplaceholders/listplaceholders-parser.js');
  const root = h.lp.importer.open({ mode: 'new' }).modalElement;
  root.querySelector('.je-lp-import-text').value = 'Doctor Who Seasons 1–3 **or** Torchwood Season 1';
  root.querySelector('.jellyseerr-modal-button-primary').click();
  await until(() => root.querySelector('.je-lp-import-progress').hidden);
  root.querySelector('.je-lp-irow[data-i="0"] .je-lp-irow-edit').click();
  const ed = root.querySelector('.je-lp-ieditor');
  const radio = ed.querySelectorAll('.je-lp-ieditor-cand input')[0];
  radio.checked = true;
  radio.dispatchEvent(new h.window.Event('change', { bubbles: true }));
  await until(() => !ed.querySelector('.je-lp-ieditor-done').disabled);
  return { h, root, ed, calls };
}

/** Saves the review as a new playlist and returns the apply entries. */
async function save(h, root, calls) {
  root.querySelector('.je-lp-new-name').value = 'DW';
  root.querySelector('.jellyseerr-modal-button-primary').click();
  await until(() => calls.some(c => c[0] === '/list-placeholders/playlists'));
  return calls.find(c => c[0] === '/list-placeholders/playlists')[1].entries.map(e => e.placeholder);
}

test('R3: Change match → Done with the picker untouched keeps every season of the chosen alternative', async t => {
  const { h, root, ed, calls } = await reviewAlternatives(t);
  ed.querySelector('.je-lp-ieditor-done').click();
  assert.equal(root.querySelector('.je-lp-ieditor'), null);
  const placeholders = await save(h, root, calls);
  assert.deepEqual(placeholders.map(p => [p.tmdbId, p.kind, p.seasonNumber]), [[57243, 'season', 1], [57243, 'season', 2], [57243, 'season', 3]]);
});

test('R3: a scope changed in the picker is still taken as set (no extra seasons)', async t => {
  const { h, root, ed, calls } = await reviewAlternatives(t);
  const select = ed.querySelector('.je-lp-ieditor-gran select');
  select.value = '2';
  select.dispatchEvent(new h.window.Event('change', { bubbles: true }));
  await tick();
  ed.querySelector('.je-lp-ieditor-done').click();
  const placeholders = await save(h, root, calls);
  assert.deepEqual(placeholders.map(p => [p.tmdbId, p.kind, p.seasonNumber]), [[57243, 'season', 2]]);
});
