import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate as nextTurn} from 'node:timers/promises';
import {createHarness,deferred} from '../helpers/harness.mjs';
function setup(t,{details=async id=>({id}),ratings=async()=>({}),withSession=false}={}){
  const timers=[];const actions=[],errors=[];const state={currentModal:null};
  const internal={state,fetchMediaDetails:details,fetchRatings:ratings,showError:message=>errors.push(message),buildModalContent:()=>'<button class="modal-close"></button><button class="modal-refresh"></button><div data-mount="ratings"></div>',renderActions:data=>actions.push(data.id),enrichSeasonCardsWithJellyfinLinks:()=>{},backfillSeasonMetadata:()=>{},buildRatingLogos:value=>String(value.label||'')};
  const h=createHarness({JE:{internals:{moreInfoModal:internal}}});t.after(()=>h.close());
  h.window.setTimeout=(fn,ms)=>{timers.push({fn,ms});return timers.length;};
  if(withSession){h.JE.core={navigation:{onNavigate:()=>{}}};h.load('core/session.js');}
  h.load('jellyseerr/moreinfo/more-info-modal-init.js');
  return {...h,state,actions,errors,internal,P:h.JE.jellyseerrMoreInfo,runClosing:()=>{for(const timer of timers.splice(0))timer.fn();}};
}
test('more-info replacing a modal cannot let old close timeout remove its successor',async t=>{
  const h=setup(t);await h.P.open(1,'movie');await h.P.open(2,'movie');h.runClosing();
  assert.equal(h.document.querySelectorAll('.je-more-info-modal').length,1);assert.equal(h.state.currentModal?.dataset.tmdbId,'2');
});
test('more-info late ratings do not replace ratings of a newer item',async t=>{
  const old=deferred();const h=setup(t,{ratings:id=>id===1?old.promise:Promise.resolve({label:'new'})});
  await h.P.open(1,'movie');await h.P.open(2,'movie');old.resolve({label:'old'});await nextTurn();
  assert.equal(h.state.currentModal.querySelector('[data-mount="ratings"]').textContent,'new');
});
test('more-info close removes TV request listeners and navigation dismisses modal',async t=>{
  let detailCalls=0;const h=setup(t,{details:async id=>{detailCalls++;return {id};}});await h.P.open(1,'tv');
  const request=()=>h.document.dispatchEvent(new h.window.CustomEvent('jellyseerr-tv-requested',{detail:{tmdbId:1}}));
  // Control: while open, a request event refreshes the details.
  request();await nextTurn();assert.equal(detailCalls,2);
  const count=h.actions.length;
  h.document.dispatchEvent(new h.window.Event('viewshow'));h.runClosing();
  request();await nextTurn();
  assert.equal(h.state.currentModal,null);assert.equal(h.actions.length,count);assert.equal(detailCalls,2);
});
test('more-info failed data returns a visible error without mounting modal',async t=>{
  const h=setup(t,{details:async()=>null});await h.P.open(1,'movie');assert.equal(h.errors.length,1);assert.equal(h.state.currentModal,null);
});
test('more-info late initial details cannot replace a newer user selection',async t=>{
  const old=deferred();const h=setup(t,{details:id=>id===1?old.promise:Promise.resolve({id})});
  const first=h.P.open(1,'movie');await h.P.open(2,'movie');old.resolve({id:1});await first;
  assert.equal(h.state.currentModal.dataset.tmdbId,'2');
});
test('more-info closing while details are pending cancels the pending open',async t=>{
  const pending=deferred();const h=setup(t,{details:()=>pending.promise});const opening=h.P.open(1,'movie');h.P.close();pending.resolve({id:1});await opening;
  assert.equal(h.state.currentModal,null);
});
test('more-info stale refresh cannot update replacement modal actions',async t=>{
  const pending=deferred();let oldCalls=0;const h=setup(t,{details:id=>id===1&&oldCalls++>0?pending.promise:Promise.resolve({id})});
  await h.P.open(1,'movie');h.state.currentModal.querySelector('.modal-refresh').click();await h.P.open(2,'movie');pending.resolve({id:1});await nextTurn();
  assert.deepEqual(h.actions,[1,2]);
});
test('more-info stale TV request completion cannot render into replacement',async t=>{
  const pending=deferred();let firstCalls=0;const h=setup(t,{details:id=>id===1&&firstCalls++>0?pending.promise:Promise.resolve({id})});
  await h.P.open(1,'tv');h.document.dispatchEvent(new h.window.CustomEvent('jellyseerr-tv-requested',{detail:{tmdbId:1}}));await h.P.open(2,'movie');
  pending.resolve({id:1,mediaInfo:{status:2}});await nextTurn();assert.deepEqual(h.actions,[1,2]);
});
test('more-info ratings from an earlier opening of the same item cannot overwrite fresh ratings',async t=>{
  const pending=deferred();let calls=0;const h=setup(t,{ratings:()=>++calls===1?pending.promise:Promise.resolve({label:'fresh'})});
  await h.P.open(1,'movie');await h.P.open(1,'movie');pending.resolve({label:'stale'});await nextTurn();
  assert.equal(h.state.currentModal.querySelector('[data-mount="ratings"]').textContent,'fresh');
});
test('more-info navigation cancels pending open and suppresses stale fetch errors',async t=>{
  const pending=deferred();const h=setup(t,{details:()=>pending.promise});const opening=h.P.open(1,'movie');h.document.dispatchEvent(new h.window.Event('viewshow'));pending.reject(Error('offline'));await opening;
  assert.equal(h.state.currentModal,null);assert.deepEqual(h.errors,[]);
});
test('more-info actual session transition cancels prior-user pending open without navigation',async t=>{
  const pending=deferred();const h=setup(t,{withSession:true,details:()=>pending.promise});const opening=h.P.open(1,'movie');
  h.window.ApiClient.getCurrentUserId=()=> 'user-b';h.JE.session.checkNow('regression-user-switch');pending.resolve({id:1});await opening;
  assert.equal(h.state.currentModal,null);assert.equal(h.document.querySelector('.je-more-info-modal'),null);
});
test('more-info actual session transition closes existing modal and invalidates pending ratings',async t=>{
  const pending=deferred();const h=setup(t,{withSession:true,ratings:()=>pending.promise});await h.P.open(1,'movie');const previous=h.state.currentModal;
  h.window.ApiClient.getCurrentUserId=()=> 'user-b';h.JE.session.checkNow('regression-user-switch');pending.resolve({label:'old user'});await nextTurn();
  assert.equal(previous._isClosing,true);assert.equal(previous.querySelector('[data-mount="ratings"]').textContent,'');h.runClosing();assert.equal(h.state.currentModal,null);
});
test('more-info same-ID replacement rejects stale refresh by modal identity',async t=>{
  const pending=deferred();let calls=0;const h=setup(t,{details:id=>++calls===2?pending.promise:Promise.resolve({id})});
  await h.P.open(1,'movie');h.state.currentModal.querySelector('.modal-refresh').click();await h.P.open(1,'movie');pending.resolve({id:1});await nextTurn();
  assert.deepEqual(h.actions,[1,1]);
});
