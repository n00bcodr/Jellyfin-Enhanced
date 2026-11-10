import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, deferred } from '../../helpers/harness.mjs';
const settle = () => new Promise(resolve => setImmediate(resolve));
function setup(t, extra = {}) {
 const navigations = [], resets = new Map(); let epoch = 0;
 const h = createHarness({ html: '<div class="videoPlayerContainer"><video></video></div>', ...extra,
  JE: { currentSettings: {}, state: {}, internals: {}, toast() {}, t: key => key, escapeHtml: String,
   isVideoPage: () => true, icons: { wrapEmoji: x => x }, icon: () => '', IconName: { PLAY:'play',FAST_FORWARD:'fast' },
   helpers: { onBodyMutation: () => ({unsubscribe(){}}) },
   core: { navigation: { onNavigate: fn => { navigations.push(fn); return () => {}; } } },
   session: { getEpoch: () => epoch, isCurrent: e => e === epoch, getUserId: () => 'user-a',
    createLease: () => { const e = epoch; return { isCurrent: () => e === epoch }; },
    onUserChange: (name,fn) => { resets.set(name,fn); return () => resets.delete(name); } }, ...extra.JE }
 });
 t.after(() => h.close());
 return { ...h, video: h.document.querySelector('video'), navigate: () => navigations.forEach(fn => fn()), switchUser: () => { epoch++; for (const fn of resets.values()) fn(); } };
}
function clock(h) {
 let now=0, id=0; const jobs=new Map();
 h.window.setTimeout=(fn,ms=0)=>{jobs.set(++id,{fn,at:now+ms});return id;};
 h.window.clearTimeout=n=>jobs.delete(n);
 return { advance(ms) { const end=now+ms; for (;;) { const next=[...jobs].filter(([,v])=>v.at<=end).sort((a,b)=>a[1].at-b[1].at)[0]; if(!next)break; jobs.delete(next[0]);now=next[1].at;next[1].fn(); } now=end; }, size:()=>jobs.size };
}
test('compiled player restores original boosted element on replacement and navigation', t => {
 const h=setup(t); const c=clock(h); h.JE.currentSettings.longPress2xEnabled=true; h.load('enhanced/player/playback.js');
 Object.defineProperty(h.video,'paused',{value:false}); h.video.playbackRate=1.5;
 h.JE.handleLongPressDown({button:0,clientX:0,clientY:0}); c.advance(500); assert.equal(h.video.playbackRate,2);
 const next=h.document.createElement('video'); h.video.replaceWith(next); next.playbackRate=0.75;
 h.navigate(); assert.equal(h.video.playbackRate,1.5); assert.equal(next.playbackRate,0.75); assert.equal(c.size(),0);
 assert.equal(h.document.querySelector('[data-speed-overlay]'),null);
});
test('compiled player cancels long press dragged from zero coordinates', t => {
 const h=setup(t); const c=clock(h); h.JE.currentSettings.longPress2xEnabled=true;h.load('enhanced/player/playback.js');
 h.JE.handleLongPressDown({button:0,clientX:0,clientY:0});h.JE.handleLongPressMove({clientX:20,clientY:0});c.advance(600);assert.equal(h.video.playbackRate,1);
});
test('compiled frame-step ignores metadata after account switch and retries in next account', async t => {
 const pending=deferred();let calls=0;
 const h=setup(t,{url:'http://jellyfin.test/web/index.html#!/video?id=item',apiClient:{getItem:()=>{calls++;return calls===1?pending.promise:Promise.resolve({MediaSources:[{MediaStreams:[{Type:'Video',RealFrameRate:25}]}]});}}});
 h.load('enhanced/player/playback.js');const first=h.JE.frameStep('forward'); h.switchUser(); pending.resolve({MediaSources:[{MediaStreams:[{Type:'Video',RealFrameRate:60}]}]});await first;assert.equal(h.video.currentTime,0);
 await h.JE.frameStep('forward');assert.equal(h.video.currentTime,1/25);assert.equal(calls,2);
});
test('compiled track commands serialize rapid presses across lagging session reports', async t => {
 const commands=[]; const h=setup(t,{url:'http://jellyfin.test/web/index.html#!/video?id=item',apiClient:{deviceId:()=> 'device',ajax:async request=>{
  if(request.type==='POST'){commands.push(JSON.parse(request.data));return {};}
  return [{Id:'session',DeviceId:'device',NowPlayingItem:{Id:'item',MediaStreams:[{Type:'Subtitle',Index:2,DisplayTitle:'one'},{Type:'Subtitle',Index:4,DisplayTitle:'two'}]},PlayState:{SubtitleStreamIndex:-1,MediaSourceId:'source'}}];
 }}});h.load('enhanced/player/playback.js');h.JE.cycleSubtitleTrack();h.JE.cycleSubtitleTrack();await settle();await settle();assert.deepEqual(commands.map(c=>c.Arguments.Index),['2','4']);
});
test('compiled track command never posts after an account transition while probing', async t => {
 const pending=deferred(), commands=[];const h=setup(t,{url:'http://jellyfin.test/web/index.html#!/video?id=item',apiClient:{deviceId:()=> 'device',ajax:request=>{if(request.type==='POST'){commands.push(request);return {};}return pending.promise;}}});
 h.load('enhanced/player/playback.js');h.JE.cycleSubtitleTrack();await settle();h.switchUser();pending.resolve([{Id:'session',DeviceId:'device',NowPlayingItem:{Id:'item',MediaStreams:[{Type:'Subtitle',Index:2}]},PlayState:{SubtitleStreamIndex:-1}}]);await settle();assert.equal(commands.length,0);
});
test('compiled OSD rating discards pending account data and refetches without stale cache', async t => {
 const pending=deferred();let callback, calls=0;const h=setup(t,{html:'<div class="videoOsdBottom"><button class="btnUserRating" data-id="item"></button><span class="osdTimeText"></span></div>',apiClient:{ajax:()=>++calls===1?pending.promise:Promise.resolve({Items:[{CommunityRating:7}]})}});
 const c=clock(h);h.JE.helpers.onBodyMutation=(_key,fn)=>{callback=fn;return {unsubscribe(){}};};h.load('enhanced/player/osd-rating.js');h.JE.initializeOsdRating();callback();c.advance(200);h.switchUser();pending.resolve({Items:[{CommunityRating:9}]});await settle();assert.equal(h.document.querySelector('#je-osd-rating-container'),null);
 callback();c.advance(200);await settle();assert.match(h.document.querySelector('#je-osd-rating-container').textContent,/7.0/);assert.equal(calls,2);
});
test('compiled subtitle cleanup restores native styles and releases subscription on navigation', t => {
 let releases=0;const h=setup(t,{html:'<video></video><div class="videoSubtitles"><div class="videoSubtitlesInner" style="color: red">hi</div></div>'});
 h.JE.helpers.onBodyMutation=()=>({unsubscribe(){releases++;}});h.load('enhanced/player/subtitles.js');h.JE.applySavedStylesWhenReady();h.navigate();assert.equal(h.document.querySelector('.videoSubtitlesInner').getAttribute('style'),'color: red');assert.equal(releases,1);
});
test('compiled now-playing session resolver rejects stale account and malformed wire data', async t => {
 const pending=deferred();const h=setup(t,{apiClient:{deviceId:()=> 'device',ajax:()=>pending.promise}});h.load('enhanced/player/now-playing.js');const result=h.JE.internals.nowPlaying.itemIdFromSession(h.video);h.switchUser();pending.resolve([{DeviceId:'device',NowPlayingItem:{Id:'old'}}]);assert.equal(await result,null);
 h.window.ApiClient.ajax=async()=>[{DeviceId:'device',NowPlayingItem:{Id:{bad:true},RunTimeTicks:'not a number'}}];assert.equal(await h.JE.internals.nowPlaying.itemIdFromSession(h.video),null);
});
test('compiled badge cancels late ratings on account change and preserves series advisory fallback', async t => {
 const pending=deferred();let calls=0;
 const h=setup(t,{url:'http://jellyfin.test/web/index.html#!/video?id=item',apiClient:{ajax:async()=>++calls===1?pending.promise: calls===2?{Items:[{SeriesId:'series',OfficialRating:'PG'}]}:{Items:[{Genres:['Adventure'],Tags:['violence','cartoon violence']}]}}});
 h.JE.pluginConfig={ShowPlaybackRatingBadge:true}; h.load('enhanced/player/playback.js');h.load('enhanced/player/now-playing.js');h.load('enhanced/player/playback-rating-badge.js');h.JE.initializePlaybackRatingBadge();
 h.video.dispatchEvent(new h.window.Event('playing'));await settle();h.switchUser();pending.resolve({Items:[{OfficialRating:'OLD'}]});await settle();assert.equal(h.document.getElementById('je-playback-rating-badge'),null);
 h.video.dispatchEvent(new h.window.Event('playing'));await settle();await settle();const badge=h.document.getElementById('je-playback-rating-badge');assert.ok(badge);assert.match(badge.textContent,/PG/);assert.match(badge.textContent,/Adventure/);assert.match(badge.textContent,/Cartoon Violence/);h.navigate();assert.equal(h.document.getElementById('je-playback-rating-badge'),null);
});
test('compiled badge permits initial playing event before video route becomes active', async t => {
 let active=false;const h=setup(t,{apiClient:{ajax:async()=>({Items:[{OfficialRating:'PG'}]})}});const c=clock(h);
 h.JE.isVideoPage=()=>active;h.JE.pluginConfig={ShowPlaybackRatingBadge:true};h.load('enhanced/player/playback.js');h.load('enhanced/player/now-playing.js');
 h.JE.internals.nowPlaying.itemIdFromRoute=()=> 'item';h.load('enhanced/player/playback-rating-badge.js');h.JE.initializePlaybackRatingBadge();h.video.dispatchEvent(new h.window.Event('playing'));await settle();active=true;h.navigate();c.advance(250);await settle();assert.ok(h.document.getElementById('je-playback-rating-badge'));h.navigate();
});
test('compiled new-account track command does not wait for abandoned old-account probe', async t => {
 const pending=deferred(),commands=[];let old=true;const session={Id:'session',DeviceId:'device',NowPlayingItem:{Id:'item',MediaStreams:[{Type:'Subtitle',Index:2}]},PlayState:{SubtitleStreamIndex:-1}};
 const h=setup(t,{url:'http://jellyfin.test/web/index.html#!/video?id=item',apiClient:{deviceId:()=> 'device',ajax:async request=>{if(request.type==='POST'){commands.push(request);return {};}return old?pending.promise:[session];}}});
 h.load('enhanced/player/playback.js');h.JE.cycleSubtitleTrack();await settle();h.switchUser();old=false;h.JE.cycleSubtitleTrack();await settle();assert.equal(commands.length,1);pending.resolve([session]);await settle();assert.equal(commands.length,1);
});
test('compiled obsolete native-menu completion cannot clear a newer account menu lock', async t => {
 const first=deferred(),second=deferred();let opens=0;
 const h=setup(t,{html:'<video></video><button class="btnSubtitles" title="Subtitles"></button>'});
 h.JE.core.dom={waitForElement:()=>++opens===1?first.promise:second.promise};
 h.load('enhanced/player/playback.js');h.JE.cycleSubtitleTrack();await settle();assert.equal(opens,1);
 h.switchUser();h.JE.cycleSubtitleTrack();await settle();assert.equal(opens,2);
 first.resolve(null);await settle();h.JE.cycleSubtitleTrack();await settle();assert.equal(opens,2);
 second.resolve(null);await settle();
});

// Upstream 533614b8: [ and ] nudge the subtitle offset through jellyfin-web's own subtitle sync slider.
const SUBTITLE_SYNC = '<div class="videoPlayerContainer"><video></video></div><div class="subtitleSyncContainer hide"><input class="subtitleSyncSlider" value="0"></div>';
function subtitleSync(t, html = SUBTITLE_SYNC) {
 const toasts = []; const h = setup(t, { html, JE: { toast: text => toasts.push(text) } }); const c = clock(h);
 const slider = h.document.querySelector('.subtitleSyncSlider'), box = h.document.querySelector('.subtitleSyncContainer'), applied = [];
 if (slider) slider.updateOffset = value => { applied.push(value); slider.value = String(value); };
 h.load('enhanced/player/playback.js');
 return { ...h, c, slider, box, applied, toasts };
}
test('subtitle offset shortcut moves the host slider in 0.1 s steps and shows its panel for two idle seconds', t => {
 const h = subtitleSync(t);
 h.JE.adjustSubtitleOffset(0.1); h.JE.adjustSubtitleOffset(0.1); h.JE.adjustSubtitleOffset(0.1);
 assert.deepEqual(h.applied, [0.1, 0.2, 0.3]); assert.equal(h.box.classList.contains('hide'), false);
 h.c.advance(1999); h.JE.adjustSubtitleOffset(-0.1);
 assert.deepEqual(h.applied, [0.1, 0.2, 0.3, 0.2]);
 h.c.advance(1999); assert.equal(h.box.classList.contains('hide'), false);
 h.c.advance(1); assert.equal(h.box.classList.contains('hide'), true);
 h.slider.value = ''; h.JE.adjustSubtitleOffset(-0.1); assert.equal(h.applied.at(-1), -0.1);
 assert.deepEqual(h.toasts, []);
});
test('subtitle offset shortcut says so when the host has no usable slider and changes nothing', t => {
 for (const html of ['<div class="videoPlayerContainer"><video></video></div>', SUBTITLE_SYNC]) {
  const h = subtitleSync(t, html); if (h.slider) h.slider.updateOffset = undefined;
  h.JE.adjustSubtitleOffset(0.1);
  assert.deepEqual(h.toasts, ['Subtitle offset is not available']); assert.deepEqual(h.applied, []);
  if (h.box) assert.equal(h.box.classList.contains('hide'), true);
  assert.equal(h.c.size(), 0);
 }
});
test('leaving the player hides the subtitle offset panel the shortcut opened and drops its timer', t => {
 const h = subtitleSync(t);
 h.JE.adjustSubtitleOffset(0.1); h.navigate();
 assert.equal(h.box.classList.contains('hide'), true); assert.equal(h.c.size(), 0);
});
