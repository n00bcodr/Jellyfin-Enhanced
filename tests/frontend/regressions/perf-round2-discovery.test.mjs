import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from '../helpers/harness.mjs';

test('person discovery retries an unrendered chunk after a transient card build failure', async () => {
  const h = createHarness({ html: '<main id="detail"></main>',
    expectedConsoleErrors: ['Error loading more items: Error: controlled card build failure'] });
  let failNextCard = false;
  let loadMore;
  h.JE.jellyseerrUI = {
    createJellyseerrCard(item) {
      if (failNextCard) {
        failNextCard = false;
        throw new Error('controlled card build failure');
      }
      const card = h.document.createElement('div');
      card.className = 'card';
      card.dataset.id = String(item.id);
      return card;
    }
  };
  h.load('jellyseerr/discovery/discovery-filter-utils.js');
  // The scroll engine is driven explicitly; real production rendering,
  // filtering and pagination run normally. No timing or geometry dependency.
  h.JE.discoveryFilter.waitForPageReady = async () => h.document.querySelector('#detail');
  h.JE.discoveryFilter.setupInfiniteScroll = (_state, _selector, callback) => { loadMore = callback; };
  h.JE.discoveryFilter.cleanupScrollObserver = () => {};
  h.load('jellyseerr/discovery/discovery-base.js');
  const controller = h.JE.discoveryBase.createDiscovery({
    key: 'person', mode: 'client-paged', logLabel: 'Person Discovery',
    configKey: 'JellyseerrShowPersonDiscovery', pageSize: 2,
    getIdFromUrl: () => 'person-1',
    resolveItems: async () => ({ title: 'Person', items: Array.from({ length: 6 }, (_, i) => ({ id: i + 1, mediaType: 'movie' })) })
  });
  try {
    await controller.render();
    const rendered = () => [...h.document.querySelectorAll('.card')].map(card => Number(card.dataset.id));
    assert.deepEqual(rendered(), [1, 2]);
    assert.equal(typeof loadMore, 'function');
    failNextCard = true;
    await assert.rejects(loadMore(), /controlled card build failure/);
    assert.deepEqual(rendered(), [1, 2]);
    await loadMore();
    assert.deepEqual(rendered(), [1, 2, 3, 4], 'retry must retain the failed chunk rather than skip its titles');
    await loadMore();
    assert.deepEqual(rendered(), [1, 2, 3, 4, 5, 6]);
  } finally {
    controller.cleanup();
    h.close();
  }
});
