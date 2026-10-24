import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate as settle} from 'node:timers/promises';
import {createHarness, deferred} from '../helpers/harness.mjs';

for (const mode of ['retained', 'disabled', 'disconnected']) test(`an HC rescan queued behind a revoked batch preserves ${mode} queue eligibility`, async t => {
  const old=deferred(), idle=[], timers=new Map(), rendered=[];
  let seq=0, posts=0, enabled=true;
  const h=createHarness({
    html:'<div class="card" data-id="aabb" data-type="Movie"><div class="cardScalable"><div class="cardImageContainer"></div><div class="cardOverlayContainer"></div></div></div>',
    globals:{requestIdleCallback:fn=>idle.push(fn), setTimeout:(fn,ms)=>{timers.set(++seq,{fn,ms});return seq;},clearTimeout:id=>timers.delete(id)},
    apiClient:{ajax:o => ++posts===1 ? old.promise : Promise.resolve({Items:[{Id:'aabb',Type:'Movie',Name:'current'}]})},
    JE:{pluginConfig:{TagCacheServerMode:false},currentSettings:{qualityTagsEnabled:true},helpers:{onBodyMutation(){},onNavigate(){},addCSS(){}},core:{tagRenderer:{applyCornerStacking(){},scheduleCornerStacking(){}}},session:{getEpoch:()=>0,isCurrent:()=>true,onUserChange(){}}}
  });
  t.after(()=>h.close());
  h.load('tags/tag-pipeline.js');
  h.JE.tagPipeline.registerRenderer('probe',{isEnabled:()=>enabled,render:(host,item)=>rendered.push(item)});
  h.JE.tagPipeline.initialize();
  await settle();
  function scan(){for(let i=0;i<10 && idle.length;i++){for(const fn of idle.splice(0)) fn({timeRemaining:()=>50});}}
  function fetch(){for(const [id,timer] of [...timers])if(timer.ms===150){timers.delete(id);timer.fn();}}
  scan();fetch();assert.equal(posts,1);
  h.window.dispatchEvent(new h.window.CustomEvent('je-hidden-content-saved'));
  await settle();scan();fetch(); // debounce expires while old network call is still pending
  assert.equal(posts,1);
  if (mode==='disabled') enabled=false;
  if (mode==='disconnected') h.document.querySelector('.card').remove();
  old.resolve({Items:[{Id:'aabb',Type:'Movie',Name:'obsolete'}]});
  for(let i=0;i<5;i++){await settle();scan();fetch();}
  assert.equal(rendered.some(x=>x.Name==='obsolete'),false);
  assert.equal(posts,mode==='retained'?2:1,'only an eligible current request is issued');
  assert.equal(rendered.some(x=>x.Name==='current'),mode==='retained');
});
