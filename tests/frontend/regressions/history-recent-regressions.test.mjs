import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from '../helpers/harness.mjs';

/** Exercise real card and page rendering; only unrelated image hydration is stubbed. */
function requests(t) {
  const actions = [], navigations = [];
  const state = { canApproveRequests: true, requestsFilter: 'all', requests: [], downloads: [], history: [], isLoading: false };
  const P = { state, clearAvatarObjectUrlCache() {}, hydrateAvatarImages() {}, hydrateExternalLinks() {},
    handleRequestAction: (button, action) => actions.push([button.dataset.requestId, action]) };
  const h = createHarness({ html: '<main id="je-downloads-container"></main>',
    globals: { Emby: { Page: { showItem: id => navigations.push(id) } } },
    JE: { pluginConfig: { JellyseerrEnabled: true, ShowDownloadsInRequests: false },
      internals: { requestsPage: P }, cdn: { selfhst: p => '/fixtures/' + p } } });
  t.after(() => h.close());
  h.load('core/ui-kit.js');
  h.JE.escapeHtml = h.JE.core.ui.escapeHtml;
  h.load('arr/requests/requests-page-render-helpers.js');
  h.load('arr/requests/requests-page-render-cards.js');
  h.load('arr/requests/requests-page-render.js');
  return { ...h, P, state, actions, navigations };
}
const pending = { id: 42, title: 'Existing series, new season', type: 'tv', requestStatus: 1,
  mediaStatus: 'Partially Available', jellyfinMediaId: 'series-a' };

test('history PR 658 pending season remains approvable on an available series', t => {
  const h = requests(t);
  for (const mediaStatus of ['Partially Available', 'Available', 'Pending']) {
    h.state.requests = [{ ...pending, mediaStatus }]; h.P.renderPage();
    assert.equal(h.document.querySelector('.je-request-approve-btn')?.dataset.requestId, '42');
    assert.equal(h.document.querySelector('.je-request-decline-btn')?.dataset.requestId, '42');
  }
  for (const requestStatus of [2, 3, 4]) {
    h.state.requests = [{ ...pending, requestStatus }]; h.P.renderPage();
    assert.equal(h.document.querySelector('.je-request-approve-btn'), null);
  }
  h.state.canApproveRequests = false; h.state.requests = [pending]; h.P.renderPage();
  assert.equal(h.document.querySelector('.je-request-approve-btn'), null);
});

test('history PR 658 rerendering requests dispatches one approval or navigation per click', t => {
  const h = requests(t); h.state.requests = [pending];
  for (let i = 0; i < 5; i++) h.P.renderPage();
  h.document.querySelector('.je-request-approve-btn .material-icons').click();
  assert.deepEqual(h.actions, [['42', 'approve']]);
  h.document.querySelector('.je-request-decline-btn').click();
  assert.deepEqual(h.actions, [['42', 'approve'], ['42', 'decline']]);
  h.document.querySelector('.je-request-watch-btn').click();
  assert.deepEqual(h.navigations, ['series-a']);
  const custom = h.document.createElement('section'); h.document.body.append(custom);
  for (let i = 0; i < 3; i++) h.P.renderPage(custom);
  custom.querySelector('.je-request-approve-btn').click();
  assert.deepEqual(h.actions, [['42', 'approve'], ['42', 'decline'], ['42', 'approve']]);
});

/** Register the actual quality renderer and its shared overlay implementation. */
function quality(t) {
  const renderers = new Map();
  const h = createHarness({ html: '<div class="card"><div class="je-tag-host"></div></div>',
    JE: { currentSettings: { qualityTagsEnabled: true, qualityTagsPreferredAudioLanguage: 'none' },
      pluginConfig: { TagCacheServerMode: false },
      session: { getUserId: () => 'a', getServerId: () => 's', onUserChange() {} },
      _cacheManager: { register() {}, markDirty() {} },
      tagPipeline: { registerRenderer: (key, renderer) => renderers.set(key, renderer), clearProcessed() {}, scheduleScan() {} } } });
  t.after(() => h.close());
  h.load('core/ui-kit.js'); h.load('core/tag-renderer-base.js'); h.load('tags/qualitytags.js'); h.JE.initializeQualityTags();
  return { ...h, renderers };
}

test('history issue 659 stereo first cannot hide richer audio badges', t => {
  const h = quality(t);
  const stereo = { Type: 'Audio', Channels: 2, ChannelLayout: 'stereo', DisplayTitle: 'MP2 - Stereo - Standard', IsDefault: true };
  const surround = { Type: 'Audio', Channels: 6, ChannelLayout: '5.1', DisplayTitle: 'Dolby Digital - 5.1' };
  const fullest = { Type: 'Audio', Channels: 8, ChannelLayout: '7.1' };
  for (const [i, streams] of [[stereo, surround], [surround, stereo], [stereo, surround, fullest], [fullest, stereo, surround]].entries()) {
    const host = h.document.createElement('div'); host.className = 'je-tag-host'; h.document.body.append(host);
    h.renderers.get('quality').render(host, { Id: `movie-${i}`, Type: 'Movie', MediaStreams: streams }, {});
    const badges = Array.from(host.querySelectorAll('[data-quality]'), el => el.dataset.quality);
    assert.ok(badges.includes(streams.length === 2 ? '5.1' : '7.1'), JSON.stringify(badges));
    assert.ok(!badges.includes('2.0'));
  }
});
