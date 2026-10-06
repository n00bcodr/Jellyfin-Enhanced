import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHarness,deferred} from '../helpers/harness.mjs';
function setup(t){const h=createHarness();t.after(()=>h.close());h.load('enhanced/player/auto-skip.js');return {...h,api:h.JE.internals.autoSkip};}
for(const [src,expected] of [['/Videos/a/stream?StartTimeTicks=100000000',100000000],['/Videos/a/stream?starttimeticks=100&CopyTimestamps=True',0],['/Videos/a/master.m3u8?StartTimeTicks=100',0],['/Videos/a/stream?StartTimeTicks=100&Static=true',0],['blob:test',0],['/Videos/a/stream?StartTimeTicks=-10',0]]){
 test(`auto-skip transcode offset ${src}`,t=>{const h=setup(t);assert.equal(h.api.parseTranscodeOffsetTicksFromSrc(src),expected);});
}
async function engine(t,{segments=[{Id:'intro',Type:'Intro',StartTicks:100000000,EndTicks:200000000}],fetchSegments,offset=0,duration=100}={}){
 const h=setup(t);const skipped=[];let item='first';let loads=0;
 const video=h.document.createElement('video');Object.defineProperty(video,'duration',{value:duration});
 const e=h.api.createAutoSkipEngine({shouldSkipType:type=>type==='Intro',resolveItemId:()=>item,fetchSegments:fetchSegments|| (async()=>{loads++;return segments;}),getPositionOffsetTicks:()=>offset,onSkipped:s=>skipped.push(s.Id)});
 e.attach(video);await new Promise(done=>setImmediate(done));
 return {...h,e,video,skipped,loads:()=>loads,setItem:id=>{item=id;},tick(time){video.currentTime=time;video.dispatchEvent(new h.window.Event('timeupdate'));}};
}
test('auto-skip honors exact boundaries, clamps duration and ignores unsupported segments',async t=>{
 const h=await engine(t,{duration:18});h.tick(9);assert.equal(h.video.currentTime,9);h.tick(10);assert.equal(h.video.currentTime,18);assert.deepEqual(h.skipped,['intro']);
});
test('auto-skip backward entry is ignored, while a fresh replay skips again',async t=>{
 const h=await engine(t);h.tick(9);h.tick(10);assert.equal(h.video.currentTime,20);
 h.tick(21);h.tick(12);assert.equal(h.video.currentTime,12);h.tick(13);assert.equal(h.video.currentTime,13);
 h.e.detach();h.e.attach(h.video);await new Promise(done=>setImmediate(done));
 h.tick(9);h.tick(10);assert.equal(h.video.currentTime,20);assert.equal(h.skipped.length,2);
});
test('auto-skip repeated attach fetches once and detach removes timeupdate behavior',async t=>{
 const h=await engine(t);h.e.attach(h.video);h.e.attach(h.video);assert.equal(h.loads(),1);
 h.e.detach();h.e.detach();h.tick(10);assert.equal(h.video.currentTime,10);assert.deepEqual(h.skipped,[]);
});
test('auto-skip converts absolute segment end to progressive element clock',async t=>{
 const h=await engine(t,{offset:100000000});h.tick(0);assert.equal(h.video.currentTime,10);
});
test('auto-skip ignores missing end, short segments, unsupported types and reversed boundaries',async t=>{
 const h=await engine(t,{segments:[{Type:'Intro',StartTicks:0},{Type:'Intro',StartTicks:0,EndTicks:5000000},{Type:'Recap',StartTicks:10000000,EndTicks:50000000},{Type:'Intro',StartTicks:60000000,EndTicks:50000000}]});
 for(const pos of [0,1,2,6]){h.tick(pos);assert.equal(h.video.currentTime,pos);}assert.deepEqual(h.skipped,[]);
});
test('old-item segment response cannot seek after playback identity changes',async t=>{
 const first=deferred(),second=deferred();const h=await engine(t,{fetchSegments:id=>id==='first'?first.promise:second.promise});
 const settle=()=>new Promise(done=>setImmediate(done));
 h.setItem('second');h.tick(0);
 // The current item's answer lands first; the stale one must not replace it afterwards.
 second.resolve([]);await settle();
 first.resolve([{Id:'intro',Type:'Intro',StartTicks:100000000,EndTicks:200000000}]);await settle();
 h.tick(9);h.tick(10);assert.equal(h.video.currentTime,10);assert.deepEqual(h.skipped,[]);
});
test('session resolver coalesces source probes and discards old-source results',async t=>{
 const h=setup(t);const first=deferred();let calls=0;
 const resolve=h.api.createSessionItemResolver({parseFromSrc:()=>null,fallbackId:()=>null,probeNowPlayingId:()=>{calls++;return calls===1?first.promise:Promise.resolve('new');}});
 const video={currentSrc:'blob:first'};assert.equal(resolve(video),null);assert.equal(resolve(video),null);assert.equal(calls,1);
 video.currentSrc='blob:second';resolve(video);first.resolve('old');await new Promise(done=>setImmediate(done));
 assert.equal(resolve(video),null);await new Promise(done=>setImmediate(done));assert.equal(resolve(video),'new');assert.equal(calls,2);
});
