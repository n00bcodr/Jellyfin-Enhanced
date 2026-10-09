import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as settle } from 'node:timers/promises';
import { createHarness, deferred } from '../helpers/harness.mjs';
const card='<div class="card" data-id="AA-BB" data-type="Movie"><div class="cardScalable"><div class="cardImageContainer"></div><div class="cardOverlayContainer"></div></div></div>';
function setup(t,html=card){const idle=[],timers=new Map(),changes=new Map(),calls=[],rendered=[];let seq=0;const response=deferred();
 const h=createHarness({html,globals:{requestIdleCallback:fn=>idle.push(fn),setTimeout:(fn,ms)=>{timers.set(++seq,{fn,ms});return seq;},clearTimeout:id=>timers.delete(id)},apiClient:{ajax:options=>{calls.push(options);return response.promise;}},JE:{pluginConfig:{TagCacheServerMode:false},currentSettings:{},core:{tagRenderer:{applyCornerStacking(){},scheduleCornerStacking(){}}},session:{onUserChange:(id,fn)=>changes.set(id,fn)}}});t.after(()=>h.close());h.load('tags/tag-pipeline.js');
 h.JE.tagPipeline.registerRenderer('probe',{isEnabled:()=>true,render:(host,item)=>{rendered.push({host,item});const chip=h.document.createElement('span');chip.className='probe-tag';host.append(chip);}});
 return Object.assign(h,{idle,timers,response,calls,rendered,changes,scan(){while(idle.length)idle.shift()({timeRemaining:()=>50});},fetch(){for(const[id,timer]of[...timers])if(timer.ms===150){timers.delete(id);timer.fn();}}});}
test('tag pipeline re-resolves a detached host before rendering a delayed response',async t=>{
 const h=setup(t);h.scan();h.fetch();assert.equal(h.calls.length,1);assert.deepEqual(JSON.parse(h.calls[0].data),['aabb']);
 const old=h.document.querySelector('.je-tag-host');old.remove();h.response.resolve({Items:[{Id:'aabb',Type:'Movie'}]});await settle();
 assert.equal(h.rendered.length,1);assert.notEqual(h.rendered[0].host,old);assert.equal(h.rendered[0].host.isConnected,true);assert.equal(h.document.querySelectorAll('.probe-tag').length,1);
 assert.equal(h.document.querySelector('.cardImageContainer .probe-tag'),null);
});
test('tag pipeline renders duplicate IDs to every card with one batch item lookup',async t=>{
 const h=setup(t,card+card);h.scan();h.fetch();assert.deepEqual(JSON.parse(h.calls[0].data),['aabb']);h.response.resolve({Items:[{Id:'aabb',Type:'Movie'}]});await settle();assert.equal(h.document.querySelectorAll('.probe-tag').length,2);
});
test('tag pipeline drops removed cards while a lookup is pending',async t=>{
 const h=setup(t);h.scan();h.fetch();h.document.querySelector('.card').remove();h.response.resolve({Items:[{Id:'aabb',Type:'Movie'}]});await settle();assert.equal(h.rendered.length,0);
});
test('tag pipeline rejects a late previous-user batch after identity reset',async t=>{
 const h=setup(t);h.scan();h.fetch();h.changes.get('tag-pipeline')({userId:'b'});h.response.resolve({Items:[{Id:'aabb',Type:'Movie',Genres:['private']} ]});await settle();assert.equal(h.rendered.length,0);
});
test('identity reset drops the previous user\'s review ratings',async t=>{
 const changes=new Map();
 const h=createHarness({globals:{requestIdleCallback:()=>{}},apiClient:{ajax:async()=>({reviewRatings:{'movie:42':{average:4.5}},items:{},count:0})},JE:{pluginConfig:{TagCacheServerMode:true},currentSettings:{qualityTagsEnabled:true},helpers:{onBodyMutation(){},onNavigate(){},addCSS(){}},core:{tagRenderer:{applyCornerStacking(){},scheduleCornerStacking(){}}},
  session:{getUserId:()=>'user-a',getServerId:()=>'server-a',getEpoch:()=>0,isCurrent:()=>true,onUserChange:(id,fn)=>changes.set(id,fn)}}});t.after(()=>h.close());
 // The cache is only wanted while a tag type is on: start the pipeline with one enabled.
 h.load('tags/tag-pipeline.js');h.JE.tagPipeline.initialize();await h.JE.tagPipeline.invalidateServerCache();
 assert.equal(h.JE.tagPipeline.peekReviewRatings()?.get('movie:42'),4.5);
 changes.get('tag-pipeline')({userId:'b'});assert.equal(h.JE.tagPipeline.peekReviewRatings(),null);
});
test('tag pipeline skips hidden/admin/nonmedia cards without transport',t=>{
 const h=setup(t,`<div id="pluginsPage">${card}</div>${card.replace('class="card"','class="card je-hidden"')}${card.replace('data-type="Movie"','data-type="Person"')}`);h.scan();h.fetch();assert.equal(h.calls.length,0);assert.equal(h.rendered.length,0);
});
