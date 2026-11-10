import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, deferred } from '../../helpers/harness.mjs';
const settle = () => new Promise(resolve => setImmediate(resolve));
const A = 'a'.repeat(32), B = 'b'.repeat(32);

test('compiled badge remembers stale OSD identity across navigation but clears it for a new account', async t => {
  const navigations = [], changes = [];
  let active = true, sourceId = A, sessionId = null;
  const h = createHarness({
    html: `<div class="videoPlayerContainer"><video></video></div><div class="videoOsdBottom"><button class="btnUserRating" data-id="${A}"></button></div>`,
    url: 'http://jellyfin.test/web/index.html#!/video',
    apiClient: { getUrl: (path, params) => 'http://jellyfin.test' + path + '?' + new URLSearchParams(params), ajax: async request => ({ Items: [{ OfficialRating: request.url.includes(B) ? 'NEW-B' : 'OLD-A' }] }) },
    JE: { pluginConfig: { ShowPlaybackRatingBadge: true }, isVideoPage: () => active,
      core: { navigation: { onNavigate: fn => navigations.push(fn) } },
      session: { onUserChange: (_name, fn) => changes.push(fn) },
      internals: { nowPlaying: { itemIdFromSource: () => sourceId, itemIdFromRoute: () => null, itemIdFromSession: async () => sessionId } } }
  });
  t.after(() => h.close());
  h.load('enhanced/player/playback-rating-badge.js'); h.JE.initializePlaybackRatingBadge();
  const video = h.document.querySelector('video');
  video.dispatchEvent(new h.window.Event('playing')); await settle();
  assert.match(h.document.getElementById('je-playback-rating-badge').textContent, /OLD-A/);
  function navigate(hash) {
    h.window.history.replaceState(null, '', hash);
    for (const fn of navigations) fn();
    h.window.dispatchEvent(new h.window.Event('hashchange'));
  }
  active = false; navigate('#!/home'); sourceId = null;
  video.src = 'blob:http://jellyfin.test/new-item'; active = true; navigate('#!/video');
  video.dispatchEvent(new h.window.Event('playing')); await settle();
  assert.equal(h.document.getElementById('je-playback-rating-badge'), null);
  sessionId = B; await new Promise(resolve => setTimeout(resolve, 550));
  assert.match(h.document.getElementById('je-playback-rating-badge').textContent, /NEW-B/);
  for (const fn of changes) fn();
  assert.equal(h.document.getElementById('je-playback-rating-badge'), null);
  video.dispatchEvent(new h.window.Event('playing')); await settle();
  assert.match(h.document.getElementById('je-playback-rating-badge').textContent, /NEW-B/);
});

for (const cleanup of ['destroy', 'clearState']) {
  test(`compiled pause images stop fallback I/O after ${cleanup} during a GET`, async t => {
    const requests = [], started = deferred();
    const h = createHarness({fetch: async (url, options) => {
      requests.push({url, method:options.method || 'GET'});
      if (options.method === 'HEAD') return {ok:true};
      started.resolve();
      return new Promise((_,reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')), {once:true}));
    }, JE: {currentSettings:{pauseScreenEnabled:true}, t:key=>key, helpers:{onBodyMutation:()=>({unsubscribe(){}})}}});
    t.after(() => h.close());
    h.window.localStorage.setItem('jellyfin_credentials', JSON.stringify({Servers:[{Id:'server-a',UserId:'user-a',AccessToken:'test'}]}));
    h.load('core/ui-kit.js'); h.load('enhanced/player/now-playing.js'); h.load('enhanced/player/pausescreen.js');
    h.JE.initializePauseScreen(); const instance = h.JE.pauseScreenInstance;
    const work=instance.firstAvailableBlobURL(['http://jellyfin.test/one','http://jellyfin.test/two']);
    await started.promise; instance[cleanup]();
    assert.equal(await work, null);
    assert.deepEqual(requests, [{url:'http://jellyfin.test/one',method:'HEAD'}, {url:'http://jellyfin.test/one',method:'GET'}]);
    if(cleanup==='destroy') {
      assert.equal(await instance.firstAvailableBlobURL(['http://jellyfin.test/late']), null);
      assert.equal(await instance.probeImage('http://jellyfin.test/late'), false);
      assert.equal(await instance.toBlobURL('http://jellyfin.test/late'), null);
      assert.equal(requests.length, 2);
    } else instance.destroy();
  });
}
