// Review round 2 (client pages): a view whose visible placeholders changed while the revision and the count stayed
// the same (the caller's parental projection changed) rebuilds the rows/cards instead of keeping the old ones.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, ph, view, playlistPage, tick, COLLECTION, LIST, ITEM_A, ITEM_B } from './lp-harness.mjs';

test('collection: same revision and count but another placeholder replaces the old card', async t => {
  const page = '<div class="itemDetailPage page"><div class="detailSection"><div class="collectionItems"><div class="verticalSection"><div class="itemsContainer collectionItemsContainer"></div></div></div><div class="nextUpSection"></div></div></div>';
  const first = view({ listId: COLLECTION, listKind: 'collection', rev: 5, order: null, placeholders: [ph('a', { title: 'A' }), ph('b', { title: 'B' })] });
  const h = setup(t, {
    html: page,
    plugin: async () => first,
    jellyseerrUI: {
      createJellyseerrCard: (item) => {
        const card = h.document.createElement('div');
        card.className = 'card jellyseerr-card';
        card.innerHTML = '<div class="cardBox"></div>';
        card.__item = item;
        return card;
      }
    }
  });
  h.JE.initializeListPlaceholders();
  const root = h.document.querySelector('.itemDetailPage');
  const ctrl = h.lp.collection.attach(root, { Id: COLLECTION, Name: 'Cars Collection', Type: 'BoxSet' });
  await tick(); await tick(); await tick();
  const ids = () => [...root.querySelectorAll('.je-lp-card')].map(c => c.getAttribute('data-je-lp-id')).sort();
  assert.deepEqual(ids(), ['a', 'b']);

  ctrl.applyView(view({ listId: COLLECTION, listKind: 'collection', rev: 5, order: null, placeholders: [ph('a', { title: 'A' }), ph('c', { title: 'C' })] }));
  assert.deepEqual(ids(), ['a', 'c']);
});

test('playlist: same revision and count but another placeholder replaces the old row', async t => {
  const first = view({ rev: 5, placeholders: [ph('a'), ph('b')], order: [`e:${ITEM_A}:0`, 'p:a', `e:${ITEM_B}:0`, 'p:b'] });
  const h = setup(t, { html: playlistPage([ITEM_A, ITEM_B]), plugin: async () => first });
  const root = h.document.querySelector('.itemDetailPage');
  const container = root.querySelector('.itemsContainer');
  container.refreshItems = () => Promise.resolve();
  container.fetchData = () => Promise.resolve({ Items: [] });
  h.JE.initializeListPlaceholders();
  const ctrl = h.lp.playlist.attach(root, { Id: LIST, Name: 'Marathon', Type: 'Playlist' });
  await tick(); await tick();
  const rows = () => [...container.querySelectorAll('.je-lp-row')].map(r => r.getAttribute('data-je-lp-id'));
  assert.deepEqual(rows(), ['a', 'b']);

  ctrl.applyView(view({ rev: 5, placeholders: [ph('a'), ph('c')], order: [`e:${ITEM_A}:0`, 'p:a', `e:${ITEM_B}:0`, 'p:c'] }));
  assert.deepEqual(rows(), ['a', 'c']);
});
