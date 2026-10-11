import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, tick } from './lp-harness.mjs';

// Review round 5 (import): a review made by one user is never sent after a sign-out / user switch: the switch closes
// the import modal, and a click that still reaches its Import button sends nothing.

const until = async (fn, tries = 400) => { for (let i = 0; i < tries; i++) { const v = fn(); if (v) return v; await tick(); } throw new Error('timeout'); };

const MOVIE = { mediaType: 'movie', tmdbId: 49521, title: 'Man of Steel', year: 2013, releaseDate: '2013-06-12' };

/** The import modal of a new playlist, reviewed and ready to import. */
async function reviewed(t, { initialize }) {
  const calls = [];
  const h = setup(t, {
    plugin: async (path, options = {}) => {
      calls.push(path);
      if (path === '/list-placeholders/resolve') {
        return { results: [{ index: 0, state: 'ok', confidence: 'high', kind: 'movie', match: MOVIE }] };
      }
      return { listId: 'f'.repeat(32), name: 'x', result: { added: [], addedAsItems: [], skipped: [] } };
    },
    jellyseerrAPI: { search: async () => ({ results: [] }) }
  });
  h.load('jellyseerr/modal.js');
  h.load('jellyseerr/listplaceholders/listplaceholders-parser.js');
  if (initialize) h.JE.initializeListPlaceholders();
  const modal = h.lp.importer.open({ mode: 'new' });
  const root = modal.modalElement;
  modal.show?.();
  root.querySelector('.je-lp-import-text').value = 'Man of Steel (2013)';
  root.querySelector('.jellyseerr-modal-button-primary').click();
  await until(() => calls.includes('/list-placeholders/resolve') && root.querySelector('.je-lp-import-progress').hidden);
  for (let i = 0; i < 10; i++) await tick();
  root.querySelector('.je-lp-new-name').value = 'Mine';
  return { h, root, calls };
}

test('R5: a user switch closes the import modal; its Import button sends nothing', async t => {
  const { h, root, calls } = await reviewed(t, { initialize: true });
  h.switchUser();
  assert.equal(root.classList.contains('show'), false);
  root.querySelector('.jellyseerr-modal-button-primary').click();
  for (let i = 0; i < 10; i++) await tick();
  assert.ok(!calls.includes('/list-placeholders/playlists'));
});

test('R5: Import does nothing for a review whose user changed, even while its modal is still shown', async t => {
  const { h, root, calls } = await reviewed(t, { initialize: false });
  h.switchUser();
  root.querySelector('.jellyseerr-modal-button-primary').click();
  for (let i = 0; i < 10; i++) await tick();
  assert.ok(!calls.includes('/list-placeholders/playlists'));
});

test('R5: without a user switch the reviewed import is sent', async t => {
  const { root, calls } = await reviewed(t, { initialize: true });
  root.querySelector('.jellyseerr-modal-button-primary').click();
  await until(() => calls.includes('/list-placeholders/playlists'));
});
