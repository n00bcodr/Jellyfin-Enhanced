// The admin Media Tags tab's account identity over Jellyfin's real ApiClient, whose getUrl('') throws
// ("Url name cannot be empty"). Opening the tab reads the configuration once and draws the page, and a
// whole-page write held by the tab (holdSaves) still runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { boot, BASE } from '../../../helpers/admin-tags-page.mjs';

/** Jellyfin's ApiClient.getUrl: an empty URL name throws. */
const strictGetUrl = (path, query) => {
  if (!path) throw new Error('Url name cannot be empty');
  return `http://jellyfin.test/${path.replace(/^\//, '')}${query ? `?${new URLSearchParams(query)}` : ''}`;
};

test('activating the Media Tags tab makes exactly one configuration request and builds the page', async (t) => {
  let reads = 0;
  const h = boot(t, {
    server: structuredClone(BASE),
    apiClient: {
      getUrl: strictGetUrl,
      // Past a handful of reads the answer never comes, so a read loop cannot spin forever.
      getPluginConfiguration: async () => (++reads > 5 ? new Promise(() => {}) : structuredClone(BASE)),
    },
  });
  h.document.body.innerHTML = '<div data-role="page" id="cfg"><div id="media-tags"><div class="je-tag-admin"><p class="je-ta-wait">Loading Media Tags settings…</p></div></div></div>';
  const page = h.document.getElementById('cfg');
  const ctx = await Promise.race([h.A.activate(page), new Promise((r) => setTimeout(() => r('timeout'), 2000))]);
  if (ctx && ctx !== 'timeout') h.cleanup.push(() => ctx.dispose());
  for (let i = 0; i < 20; i++) await h.settle();
  assert.equal(reads, 1, 'one configuration request');
  assert.ok(h.document.querySelector('.je-ta-tabs'), 'the page was built');
  assert.equal(h.document.querySelector('.je-ta-wait'), null, 'no longer loading');
});

test('holdSaves(fn) runs fn once the tab is loaded, over Jellyfin\'s strict getUrl', async (t) => {
  const h = boot(t, { server: structuredClone(BASE), apiClient: { getUrl: strictGetUrl } });
  let ran = false;
  const result = await h.A.holdSaves(async () => { ran = true; return 'written'; });
  assert.equal(ran, true, 'the held write ran');
  assert.equal(result, 'written');
});
