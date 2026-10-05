import test from 'node:test';
import assert from 'node:assert/strict';
import {createHarness,deferred} from '../helpers/harness.mjs';

// #550 / #551: protected avatar requests must retain a Jellyfin reverse-proxy prefix.
test('history551 protected avatars preserve the configured Jellyfin base path and authorization',async t=>{
  const requests=[];
  const h=createHarness({apiClient:{getUrl:path=>`https://media.test/jellyfin${path}`},fetch:async(url,options)=>{requests.push({url,options});return new Response('image');}});
  t.after(()=>h.close());h.window.URL.createObjectURL=()=> 'blob:avatar';h.load('enhanced/helpers.js');
  assert.equal(await h.JE.helpers.resolveProtectedAvatarUrl('/JellyfinEnhanced/proxy/avatar?path=%2Favatar%2F1'),'blob:avatar');
  assert.equal(requests[0].url,'https://media.test/jellyfin/JellyfinEnhanced/proxy/avatar?path=%2Favatar%2F1');
  assert.equal(requests[0].options.headers['X-MediaBrowser-Token'],'test-token');
});

// #504: simultaneous and repeated renders share a single authenticated blob download.
test('history504 repeated and concurrent avatar rendering downloads one blob and releases it',async t=>{
  const response=deferred();let downloads=0,created=0;const revoked=[];
  const h=createHarness({fetch:()=>{downloads++;return response.promise;}});t.after(()=>h.close());
  h.window.URL.createObjectURL=()=>`blob:avatar-${++created}`;
  h.window.URL.revokeObjectURL=url=>revoked.push(url);h.load('enhanced/helpers.js');
  const path='/JellyfinEnhanced/proxy/avatar?path=%2Favatar%2F1';
  const first=h.JE.helpers.resolveProtectedAvatarUrl(path),second=h.JE.helpers.resolveProtectedAvatarUrl(path);
  response.resolve(new Response('image'));
  assert.deepEqual(await Promise.all([first,second]),['blob:avatar-1','blob:avatar-1']);
  assert.equal(await h.JE.helpers.resolveProtectedAvatarUrl(path),'blob:avatar-1');
  assert.equal(downloads,1);assert.equal(created,1);
  h.JE.helpers.clearAvatarObjectUrlCache(true);assert.deepEqual(revoked,['blob:avatar-1']);
});

// #413 / #414: native Jellyfin ::cue styles survive enabling and disabling JE styling.
test('history414 legacy cue stylesheet survives custom subtitle enable and disable',t=>{
  const h=createHarness({html:'<video></video><style id="htmlvideoplayer-cuestyle">.htmlvideoplayer::cue {color: yellow; font-size: 18px;}</style>',JE:{currentSettings:{},helpers:{onBodyMutation:()=>({unsubscribe(){}})}}});
  t.after(()=>h.close());h.load('enhanced/player/subtitles.js');
  const native=h.document.getElementById('htmlvideoplayer-cuestyle');
  const original=[...native.sheet.cssRules].map(rule=>rule.cssText);
  h.JE.applySubtitleStyles('#fff','transparent',2,'sans-serif','none');
  assert.deepEqual([...native.sheet.cssRules].map(rule=>rule.cssText),original);
  assert.ok(h.document.getElementById('je-html-videoplayer-cuestyle').sheet.cssRules.length);
  h.JE.currentSettings.disableCustomSubtitleStyles=true;h.JE.applySavedStylesWhenReady();
  assert.deepEqual([...native.sheet.cssRules].map(rule=>rule.cssText),original);
  assert.equal(h.document.getElementById('je-html-videoplayer-cuestyle').sheet.cssRules.length,0);
});
