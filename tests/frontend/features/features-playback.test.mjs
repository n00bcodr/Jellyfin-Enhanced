import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHarness} from '../helpers/harness.mjs';
function setup(t,html='<video></video>'){
 const toasts=[];const h=createHarness({html,JE:{currentSettings:{},t:(key,args)=>args?`${key}:${JSON.stringify(args)}`:key,toast:text=>toasts.push(text)}});t.after(()=>h.close());h.load('enhanced/player/playback.js');return {...h,toasts,video:h.document.querySelector('video')};
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
