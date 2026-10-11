import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, plain } from '../helpers/harness.mjs';

// Review round 7: a 4K request must announce itself as 4K. List placeholders trust the event's
// is4k flag; a 4K request announced as regular marked the regular version requested.

function setup(t) {
  const posts = [], events = [];
  const h = createHarness({ JE: {
    pluginConfig: { JellyseerrEnable4KRequests: true }, t: key => key,
    escapeHtml: value => String(value),
    helpers: { trackUsage: () => {} },
    session: { getEpoch: () => 0, isCurrent: () => true, onUserChange: () => {} },
    requestManager: { clearCacheMatching: () => {} },
    core: { api: {
      fetch: async () => [],
      plugin: async (url, options) => { posts.push([url, plain(options).body]); return { id: 7, media: { status4k: 3 } }; }
    } }
  }});
  t.after(() => h.close());
  h.load('jellyseerr/seerr-status.js');
  h.load('jellyseerr/api.js');
  h.document.addEventListener('jellyseerr-media-requested', e => events.push(plain(e.detail)));
  return { ...h, api: h.JE.jellyseerrAPI, posts, events };
}

test('a 4K flag passed only in the settings is announced as a 4K request', async t => {
  const h = setup(t);
  h.api.addToWatchlist = async () => {};
  await h.api.requestMedia(42, 'movie', { is4k: true }, false, null);
  assert.equal(h.posts[0][1].is4k, true);
  assert.deepEqual(h.events, [{ tmdbId: '42', mediaType: 'movie', is4k: true }]);
  await h.api.requestTvSeasons(43, [1], { is4k: true }, null, false);
  assert.equal(h.posts[1][1].is4k, true);
  assert.equal(h.events[1].is4k, true);
});

for (const path of ['single 4K button', 'split-button 4K option']) test(`more info ${path} sends a 4K request announced as 4K`, async t => {
  const h = setup(t);
  h.api.addToWatchlist = async () => {};
  h.api.shouldShowAdvanced = () => false;
  h.api.fetchUserQuota = async () => null;
  const calls = [];
  const real = h.api.requestMedia;
  h.api.requestMedia = (...args) => { calls.push(plain(args.slice(0, 4))); return real(...args); };
  const modal = h.document.createElement('div');
  modal.innerHTML = '<div data-mount="je-actions"></div><div data-mount="je-status-chip"></div>';
  h.document.body.appendChild(modal);
  h.JE.internals = { moreInfoModal: { state: { currentModal: modal }, buildStatusChip: () => null, buildDownloadBars: () => null } };
  h.load('jellyseerr/moreinfo/more-info-modal-actions.js');
  const internal = h.JE.internals.moreInfoModal;
  const data = { id: 42, title: 'Movie', mediaInfo: { status: path === 'single 4K button' ? 5 : 1, status4k: 1 } };
  if (path === 'single 4K button') {
    const button = internal.buildSingle4kButton(data);
    modal.appendChild(button);
    button.click();
  } else {
    const row = internal.buildMovieActions(data, modal.querySelector('[data-mount="je-actions"]'), null, true);
    modal.appendChild(row);
    row.querySelector('.jellyseerr-split-arrow').click();
    h.document.querySelector('.je-4k-popup-item').click();
  }
  for (let i = 0; i < 20 && !h.events.some(e => e.is4k); i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(calls, [[42, 'movie', {}, true]]);
  assert.equal(h.posts[0][1].is4k, true);
  assert.ok(h.events.length > 0);
  assert.ok(h.events.every(e => e.is4k === true), JSON.stringify(h.events));
});
