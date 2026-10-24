import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { createHarness, deferred } from '../helpers/harness.mjs';
const flush=async(n=10)=>{for(let i=0;i<n;i++)await nextTurn();};
const revised=(data,revision,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json','X-JE-Revision':revision}});
function core(h){for(const m of ['core/navigation.js','core/session.js','core/access-revision.js','core/api-client.js'])h.load(m);}

test('filmography must still be current after waiting for the page element',async t=>{
 const h=createHarness({html:'<main id="detail"></main>'});let controller;let access='a1';let reads=0;const ready=deferred();
 t.after(()=>{controller?.cleanup();h.close();});
 h.JE.core={revision:{access:()=>access}};
 h.JE.jellyseerrUI={createJellyseerrCard(item){const c=h.document.createElement('div');c.className='card';c.dataset.id=String(item.id);return c;}};
 h.load('jellyseerr/seerr-status.js');h.load('jellyseerr/discovery/discovery-filter-utils.js');
 h.JE.discoveryFilter.waitForPageReady=()=>ready.promise;h.JE.discoveryFilter.setupInfiniteScroll=()=>{};h.JE.discoveryFilter.cleanupScrollObserver=()=>{};
 h.load('jellyseerr/discovery/discovery-base.js');
 controller=h.JE.discoveryBase.createDiscovery({key:'person',mode:'client-paged',logLabel:'Person',configKey:'JellyseerrShowPersonDiscovery',pageSize:2,getIdFromUrl:()=> '1',resolveItems:async()=>{reads++;return {title:'Person',items:(access==='a1'?[1,2,3]:[1]).map(id=>({id,mediaType:'movie'}))};}});
 const pending=controller.render();await flush();assert.equal(reads,1);
 access='a2';h.document.dispatchEvent(new h.window.CustomEvent('je-access-revision',{detail:{revision:access}}));
 ready.resolve(h.document.querySelector('#detail'));await pending;
 assert.equal(h.document.querySelector('.card[data-id="2"]'),null,'a card forbidden before the page became ready was drawn');
});

test('r7 filmography must stay current while waiting for its page container',async t=>{
  const h=createHarness({html:'<main id="detail"></main>'});let access='a1';let controller;const ready=deferred();let waits=0;
  t.after(()=>{controller?.cleanup();h.close();});
  h.JE.core={revision:{access:()=>access}};
  h.JE.jellyseerrUI={createJellyseerrCard(item){const c=h.document.createElement('div');c.className='card';c.dataset.id=String(item.id);return c;}};
  h.load('jellyseerr/seerr-status.js');h.load('jellyseerr/discovery/discovery-filter-utils.js');
  h.JE.discoveryFilter.waitForPageReady=()=>{waits++;return ready.promise;};
  h.JE.discoveryFilter.setupInfiniteScroll=()=>{};h.JE.discoveryFilter.cleanupScrollObserver=()=>{};
  h.load('jellyseerr/discovery/discovery-base.js');
  controller=h.JE.discoveryBase.createDiscovery({key:'person',mode:'client-paged',logLabel:'Person',configKey:'JellyseerrShowPersonDiscovery',pageSize:2,getIdFromUrl:()=> '1',resolveItems:async()=>({title:'Person',items:access==='a1'?[{id:603,mediaType:'movie'}]:[]})});
  const pending=controller.render();await flush();assert.equal(waits,1);
  access='a2';h.document.dispatchEvent(new h.window.CustomEvent('je-access-revision',{detail:{revision:access}}));
  ready.resolve(h.document.querySelector('#detail'));await pending;
  assert.equal(h.document.querySelector('.card[data-id="603"]'),null,'known-forbidden title must not be drawn after page readiness');
});

