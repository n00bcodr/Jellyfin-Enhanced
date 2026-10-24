import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHarness} from '../helpers/harness.mjs';
function setup(t,html='<video></video>'){
 const toasts=[];const h=createHarness({html,JE:{currentSettings:{},t:(key,args)=>args?`${key}:${JSON.stringify(args)}`:key,toast:text=>toasts.push(text)}});t.after(()=>h.close());h.load('core/mutation-queue.js');h.load('enhanced/player/playback.js');return {...h,get NATIVE(){return h.NATIVE;},toasts,video:h.document.querySelector('video')};
}
test('playback speed steps, clamps at supported limits and resets',t=>{
 const h=setup(t);h.JE.adjustPlaybackSpeed('increase');assert.equal(h.video.playbackRate,1.25);h.JE.adjustPlaybackSpeed('decrease');assert.equal(h.video.playbackRate,1);h.video.playbackRate=2;h.JE.adjustPlaybackSpeed('increase');assert.equal(h.video.playbackRate,2);h.video.playbackRate=0.25;h.JE.adjustPlaybackSpeed('decrease');assert.equal(h.video.playbackRate,0.25);h.JE.resetPlaybackSpeed();assert.equal(h.video.playbackRate,1);
});
test('playback controls without a video show translated feedback',t=>{
 const h=setup(t,'');h.JE.adjustPlaybackSpeed('increase');h.JE.resetPlaybackSpeed();h.JE.jumpToPercentage(50);assert.deepEqual(h.toasts,['toast_no_video_found','toast_no_video_found','toast_no_video_found']);
});
test('percentage seek uses actual duration and last-position tracker is consumed once',t=>{
 const h=setup(t);Object.defineProperty(h.video,'duration',{value:200});h.JE.jumpToPercentage(25);assert.equal(h.video.currentTime,50);h.JE.attachSeekTracker(h.video);h.JE.attachSeekTracker(h.video);h.video.dispatchEvent(new h.window.Event('timeupdate'));h.video.currentTime=100;h.video.dispatchEvent(new h.window.Event('seeking'));h.JE.jumpToLastPosition();assert.equal(h.video.currentTime,50);h.video.currentTime=80;h.JE.jumpToLastPosition();assert.equal(h.video.currentTime,80);
});
test('player item identity comes from the video route id',t=>{
 const h=setup(t);h.window.location.hash='#!/video?id=route-item';assert.equal(h.JE.internals.player.getCurrentVideoItemId(),'route-item');
});
// Stage 1 fix round 12 (P11): a track press belongs to the session of the keypress, through its queue behind an earlier
// press and its probes. Before, a press queued behind another took its session when its turn came, so a press made by A
// sent B's player a track command after a switch.
test('a track press queued behind another across an account switch never commands the next person\'s player',async t=>{
 let user='a',release;const held=new Promise(r=>{release=r;});const posts=[];let probes=0;
 const session={Id:'s1',DeviceId:'dev',NowPlayingItem:{Id:'item1',MediaStreams:[{Type:'Subtitle',Index:2},{Type:'Subtitle',Index:3}]},PlayState:{SubtitleStreamIndex:-1}};
 const h=createHarness({html:'<video></video>',url:'http://jellyfin.test/web/index.html#!/video?id=item1',JE:{currentSettings:{},t:key=>key,toast(){},escapeHtml:s=>String(s),isVideoPage:()=>true},
  apiClient:{getCurrentUserId:()=>user,deviceId:()=>'dev',ajax:async req=>{if(req.type==='GET'){if(++probes===1)await held;return [session];}posts.push({user,url:req.url});return {};}}});
 h.allowConsoleError(/./);t.after(()=>h.close());h.load('core/mutation-queue.js');h.load('enhanced/player/playback.js');
 h.JE.cycleSubtitleTrack();h.JE.cycleSubtitleTrack();
 await new Promise(r=>setImmediate(r));
 user='b';release();
 await new Promise(r=>setTimeout(r,30));
 assert.deepEqual(posts,[],'neither of A\'s presses commands B\'s player');
 // A press made now is B's own and commands B's player.
 h.JE.cycleSubtitleTrack();await new Promise(r=>setTimeout(r,30));
 assert.deepEqual(posts.map(p=>p.user),['b']);
});
