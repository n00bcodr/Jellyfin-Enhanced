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
test('tag pipeline drains the cards queued while a cancelled batch was in flight',async t=>{
 // A reinitialize (clearProcessed) while a batch awaits its response bumps the
 // generation; the scan that follows re-queues the card but cannot start a drain
 // while the old one runs. The old drain must hand over when it exits.
 const h=setup(t);h.scan();h.fetch();assert.equal(h.calls.length,1);
 h.JE.tagPipeline.clearProcessed();h.JE.tagPipeline.scheduleScan();h.scan();
 assert.equal(h.calls.length,1,'no second fetch while the first drain is still running');
 h.response.resolve({Items:[{Id:'aabb',Type:'Movie'}]});await settle();
 assert.equal(h.rendered.length,0,'the cancelled generation renders nothing');
 h.fetch();await settle();
 assert.equal(h.calls.length,2,'the queued card is fetched by a new drain');
 assert.equal(h.rendered.length,1);
});
test('tag pipeline skips hidden/admin/nonmedia cards without transport',t=>{
 const h=setup(t,`<div id="pluginsPage">${card}</div>${card.replace('class="card"','class="card je-hidden"')}${card.replace('data-type="Movie"','data-type="Person"')}`);h.scan();h.fetch();assert.equal(h.calls.length,0);assert.equal(h.rendered.length,0);
});

/**
 * The pipeline over a stub IndexedDB store holding one complete copy with the
 * given meta; records which requests and store calls happen.
 */
async function loadWithStoredCopy(t, meta) {
  const calls = [];
  const cleared = [];
  const h = createHarness({
    globals: { requestIdleCallback: () => {} },
    apiClient: { getCurrentUserId: () => 'user-a', ajax: async ({ url }) => { calls.push(url); return { items: {}, count: 0, version: 3, timestamp: 50, filterRevision: 'all', servedAt: 60 }; } },
    JE: {
      pluginConfig: { TagCacheServerMode: true }, currentSettings: { qualityTagsEnabled: true },
      helpers: { onBodyMutation() {}, onNavigate() {}, addCSS() {} },
      core: { tagRenderer: { applyCornerStacking() {}, scheduleCornerStacking() {} } },
      session: { getUserId: () => 'user-a', getServerId: () => 'server-a', getEpoch: () => 0, isCurrent: () => true, onUserChange() {} },
      tagCacheStore: {
        available: () => true,
        getMeta: async () => ({ scope: 'server-a:user-a', version: 3, timestamp: 40, filterRevision: 'all', count: 5, clearStamp: 0, servedAt: 45, savedAt: 1, ...meta }),
        getMany: async () => ({ entries: new Map(), meta: null }),
        clearScope: async scope => { cleared.push(scope); },
        clearOtherScopes: async () => {},
        beginFullWrite: async () => false,
        putManyIfOwner: async () => false,
        commitFullWrite: async () => false,
        applyDelta: async () => true,
      }
    }
  });
  t.after(() => h.close());
  h.load('tags/tag-pipeline.js');
  h.JE.tagPipeline.initialize();
  await h.JE.tagPipeline.invalidateServerCache();
  await settle();
  return { calls, cleared };
}

test('a stored tag cache copy from an older entry schema is dropped and downloaded in full', async t => {
  const { calls, cleared } = await loadWithStoredCopy(t, {});
  assert.deepEqual(cleared, ['server-a:user-a'], 'the copy without the current schema is cleared');
  assert.ok(calls.length > 0 && calls.every(url => !url.includes('since=')), 'a full download, never a delta on top of it');
});

test('a stored tag cache copy with the current entry schema is restored and only the delta is fetched', async t => {
  const { calls, cleared } = await loadWithStoredCopy(t, { schema: 12 });
  assert.deepEqual(cleared, []);
  assert.ok(calls.some(url => url.includes('since=40')), 'the delta since the stored cursor');
});
