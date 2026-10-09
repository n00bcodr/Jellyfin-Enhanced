import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate as nextTurn} from 'node:timers/promises';
import {createHarness,deferred} from '../helpers/harness.mjs';
function setup(t){
  const observers=[];const h=createHarness({html:'<section id="feed"><div class="itemsContainer"></div></section>',globals:{IntersectionObserver:class{constructor(fn){this.fn=fn;this.disconnected=false;observers.push(this);}observe(){}disconnect(){this.disconnected=true;}}}});
  t.after(()=>h.close());h.load('jellyseerr/seamless-scroll.js');const state={};
  const section=h.document.querySelector('section');section.getClientRects=()=>[{}];
  t.after(()=>h.JE.seamlessScroll.cleanupInfiniteScroll(state));
  return {...h,P:h.JE.seamlessScroll,state,section,observers};
}
test('sparse scroll historical regression: nonempty pages with no measured growth stop at safety valve',async t=>{
  const h=setup(t);let loads=0;h.P.setupInfiniteScroll(h.state,'#feed',async()=>{loads++;return {pages:1,rendered:1};},()=>true,()=>false);
  await nextTurn();assert.equal(loads,h.P.CONFIG.maxStuckFills);assert.ok(h.document.querySelector('.je-retry-row button'));
  h.observers[0].fn([{isIntersecting:true}]);await nextTurn();assert.equal(loads,h.P.CONFIG.maxStuckFills);
  h.document.querySelector('.je-retry-row button').click();await nextTurn();assert.equal(loads,2*h.P.CONFIG.maxStuckFills);
});
test('empty page budget pauses without dropping continuation and supplies remaining budget',async t=>{
  const h=setup(t);h.P.CONFIG.maxConsecutiveEmptyPages=4;const budgets=[];
  h.P.setupInfiniteScroll(h.state,'#feed',async hint=>{budgets.push(hint.pageBudget);return {pages:1,rendered:0};},()=>true,()=>false);
  await nextTurn();assert.deepEqual(budgets,[4,3,2,1]);assert.ok(h.document.querySelector('.je-retry-row'));
});
test('scroll zero-progress and exhausted feeds terminate without retries or runaway loads',async t=>{
  const h=setup(t);let loads=0;h.P.setupInfiniteScroll(h.state,'#feed',async()=>{loads++;return {pages:0,rendered:0};},()=>true,()=>false);
  await nextTurn();assert.equal(loads,1);assert.equal(h.document.querySelector('.je-retry-row'),null);
  h.P.setupInfiniteScroll(h.state,'#feed',async()=>{loads++;return {pages:1,rendered:1};},()=>false,()=>false);await nextTurn();assert.equal(loads,1);assert.equal(h.observers[0].disconnected,true);
});
test('hidden scroll sections do not fetch and teardown prevents pending load from fetching again',async t=>{
  const h=setup(t);let loads=0;h.section.getClientRects=()=>[];
  h.P.setupInfiniteScroll(h.state,'#feed',async()=>{loads++;},()=>true,()=>false);await nextTurn();assert.equal(loads,0);
  h.section.getClientRects=()=>[{}];const pending=deferred();h.P.setupInfiniteScroll(h.state,'#feed',async()=>{loads++;return pending.promise;},()=>true,()=>false);
  h.P.cleanupInfiniteScroll(h.state);pending.resolve({pages:1,rendered:1});await nextTurn();assert.equal(loads,1);assert.equal(h.state.fill,null);assert.equal(h.document.querySelector('.je-scroll-sentinel'),null);
});
