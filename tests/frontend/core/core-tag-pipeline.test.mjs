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
 const h=createHarness({globals:{requestIdleCallback:()=>{}},apiClient:{ajax:async()=>({reviewRatings:{'movie:42':{average:4.5}},items:{series:{Type:'Series',LatestEpisodeIndex:{Season:1,Episode:10}}},count:1})},JE:{pluginConfig:{TagCacheServerMode:true},currentSettings:{qualityTagsEnabled:true},helpers:{onBodyMutation(){},onNavigate(){},addCSS(){}},core:{tagRenderer:{applyCornerStacking(){},scheduleCornerStacking(){}}},
  session:{getUserId:()=>'user-a',getServerId:()=>'server-a',getEpoch:()=>0,isCurrent:()=>true,onUserChange:(id,fn)=>changes.set(id,fn)}}});t.after(()=>h.close());
 // The cache is only wanted while a tag type is on: start the pipeline with one enabled.
 h.load('tags/tag-pipeline.js');h.JE.tagPipeline.initialize();await h.JE.tagPipeline.invalidateServerCache();
 assert.equal(h.JE.tagPipeline.peekReviewRatings()?.get('movie:42'),4.5);
 assert.equal(h.JE.tagPipeline.peekServerEntry('series')?.LatestEpisodeIndex.Episode,10);
 assert.equal(h.JE.tagPipeline.peekServerEntry('missing'),null);
 changes.get('tag-pipeline')({userId:'b'});assert.equal(h.JE.tagPipeline.peekReviewRatings(),null);assert.equal(h.JE.tagPipeline.peekServerEntry('series'),null);
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

test('individual fallback drops facts immediately when the user changed during /Items', async t => {
 const h=setup(t); const item=deferred();
 h.window.ApiClient.getItem=()=>item.promise;
 h.scan();h.fetch();h.response.reject(new Error('tag-data unavailable'));await settle();
 h.changes.get('tag-pipeline')({userId:'b'});
 item.resolve({Id:'aabb',Type:'Movie',Genres:['private']});await settle();
 assert.equal(h.rendered.length,0);
 let fetched=false;h.window.ApiClient.ajax=async()=>{fetched=true;return {Items:[]};};
 await h.JE.tagPipeline.itemLookFacts('aabb');
 assert.equal(fetched,true,'old facts were never remembered');
});

for (const inFlight of [false, true]) test(`navigation retries cards whose work was cancelled (in-flight=${inFlight})`, async t => {
 const h=setup(t);let navigate;
 h.JE.currentSettings.qualityTagsEnabled=true;
 h.JE.helpers={onBodyMutation(){},onNavigate(fn){navigate=fn;}};
 h.JE.tagPipeline.initialize();await settle();h.scan();
 if(inFlight)h.fetch();
 h.window.location.hash='#/details?id=series';navigate();h.scan();
 if(inFlight){h.response.resolve({Items:[{Id:'aabb',Type:'Movie'}]});await settle();assert.equal(h.rendered.length,0,'old navigation cannot render');}
 h.fetch();
 assert.equal(h.calls.length,inFlight?2:1,'cancelled cards are fetched again');
 h.response.resolve({Items:[{Id:'aabb',Type:'Movie'}]});await settle();
 assert.equal(h.rendered.length,1);
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

for (const schema of [undefined, 11, 12, 13, 14, 15]) test(`a stored tag cache copy from an older entry schema (${schema ?? 'missing'}) is dropped and downloaded in full`, async t => {
  const { calls, cleared } = await loadWithStoredCopy(t, schema === undefined ? {} : { schema });
  assert.deepEqual(cleared, ['server-a:user-a'], 'the copy without the current schema is cleared');
  assert.ok(calls.length > 0 && calls.every(url => !url.includes('since=')), 'a full download, never a delta on top of it');
});

test('a stored tag cache copy with the current entry schema is restored and only the delta is fetched', async t => {
  const { calls, cleared } = await loadWithStoredCopy(t, { schema: 17 });
  assert.deepEqual(cleared, []);
  assert.ok(calls.some(url => url.includes('since=40')), 'the delta since the stored cursor');
});

/** Track the private fact maps without exposing production-only diagnostics. */
function factsHarness(t) {
  const maps = [];
  class TrackedMap extends Map {
    constructor(...args) { super(...args); maps.push(this); }
  }
  const h = createHarness({ globals: { Map: TrackedMap, requestIdleCallback() {} } });
  t.after(() => h.close());
  h.load('tags/tag-pipeline.js');
  let now = 1000000;
  h.window.Date.now = () => now;
  const pipeline = h.JE.tagPipeline;
  pipeline.rememberItemFacts({ Id: 'seed', Type: 'Season', SeriesId: 'series', IndexNumber: 1 });
  const seasons = maps.find(map => map.get('series:1') === 'seed');
  const items = maps.find(map => map.get('seed')?.entry?.Id === 'seed');
  return { pipeline, items, seasons, advance() { now += 11 * 60 * 1000; } };
}

test('20,000 expired season facts also evict their season lookups', t => {
  const h = factsHarness(t);
  for (let i = 0; i < 20000; i++) {
    h.pipeline.rememberItemFacts({ Id: `season${i}`, Type: 'Season', SeriesId: 'series', IndexNumber: i + 2 });
    h.advance();
    assert.equal(h.pipeline.peekItemFacts(`season${i}`), null);
  }
  assert.equal(h.pipeline.peekItemFacts('seed'), null);
  assert.equal(h.items.size, 0);
  assert.equal(h.seasons.size, 0, 'expired items leave no orphan season keys');
});

test('replacing season identities and reusing a season key keep both maps consistent', t => {
  const h = factsHarness(t);
  for (let i = 0; i < 20000; i++) {
    h.pipeline.rememberItemFacts({ Id: 'seed', Type: 'Season', SeriesId: 'series', IndexNumber: i + 2 });
  }
  assert.equal(h.items.size, 1);
  assert.equal(h.seasons.size, 1, 'a changed series/season removes its previous key');
  assert.equal(h.pipeline.peekSeasonFacts('series', 1), null);
  h.pipeline.rememberItemFacts({ Id: 'replacement', Type: 'Season', SeriesId: 'series', IndexNumber: 20001 });
  assert.equal(h.pipeline.peekSeasonFacts('series', 20001).Id, 'replacement');
  for (const [key, id] of h.seasons) assert.equal(h.items.get(id)?.seasonKey, key);
  h.pipeline.rememberItemFacts({ Id: 'replacement', Type: 'Series' });
  assert.equal(h.seasons.size, 0, 'replacing a season with another type removes its lookup');
});

test('container facts evict the oldest entries and their lookups at the memory cap', t => {
  const h = factsHarness(t);
  for (let i = 0; i < 20000; i++) {
    h.pipeline.rememberItemFacts({ Id: `season${i}`, Type: 'Season', SeriesId: 'series', IndexNumber: i + 2 });
  }
  assert.equal(h.items.size, 20000);
  assert.equal(h.seasons.size, 20000);
  assert.equal(h.pipeline.peekItemFacts('seed'), null, 'oldest fact evicted first');
  assert.equal(h.pipeline.peekSeasonFacts('series', 1), null);
  assert.equal(h.pipeline.peekSeasonFacts('series', 2).Id, 'season0', 'newer facts survive the cap');
  for (const [key, id] of h.seasons) assert.equal(h.items.get(id)?.seasonKey, key);
});

/**
 * The real pipeline in server cache mode over a server whose background
 * logo warm finishes after `readyAfter` deltas: from then on its cache
 * version moves and the full download carries Logos.
 */
async function logoWarmHarness(t, readyAfter) {
  const urls = [];
  let deltas = 0;
  const h = createHarness({
    globals: { requestIdleCallback: () => {} },
    apiClient: {
      getCurrentUserId: () => 'user-a',
      ajax: async ({ url }) => {
        urls.push(url);
        if (url.includes('since=')) deltas++;
        const warm = deltas >= readyAfter;
        const full = !url.includes('since=');
        return { items: full ? { movie: warm ? { Type: 'Movie', Logos: [{ kind: 'provider', name: 'Netflix' }] } : { Type: 'Movie' } } : {},
          count: full ? 1 : 0, version: warm ? 2 : 1, timestamp: 50, filterRevision: 'all', servedAt: 60 };
      },
    },
    JE: {
      pluginConfig: { TagCacheServerMode: true }, currentSettings: { logoTagsEnabled: true },
      helpers: { onBodyMutation() {}, onNavigate() {}, addCSS() {} },
      core: { tagRenderer: { applyCornerStacking() {}, scheduleCornerStacking() {} } },
      session: { getUserId: () => 'user-a', getServerId: () => 'server-a', getEpoch: () => 0, isCurrent: () => true, onUserChange() {} },
    },
  });
  t.after(() => h.close());
  h.load('tags/tag-pipeline.js');
  h.JE.tagPipeline.initialize();
  await h.JE.tagPipeline.invalidateServerCache();
  urls.length = 0;
  return { h, urls, pipeline: h.JE.tagPipeline };
}

const carriesLogos = entries => [...entries].some(entry => Array.isArray(entry?.Logos) && entry.Logos.length > 0);

test('waitForServerCache keeps fetching deltas until the server\'s delayed republish brings what it waits for', async t => {
  const { urls, pipeline } = await logoWarmHarness(t, 3);
  assert.equal(carriesLogos(pipeline.serverEntries()), false, 'drawn from entries without logos');
  assert.equal(await pipeline.waitForServerCache(carriesLogos, { delays: [0, 0, 0, 0, 0] }), true);
  assert.equal(carriesLogos(pipeline.serverEntries()), true);
  assert.equal(urls.filter(url => url.includes('since=')).length, 3, 'one delta per attempt until the warm finished');
  assert.ok(!urls.at(-1).includes('since='), 'the moved cache version brought a full download');
});

test('waitForServerCache gives up after its bound, when stopped, and with the server cache off', async t => {
  const { urls, pipeline } = await logoWarmHarness(t, Infinity);
  assert.equal(await pipeline.waitForServerCache(carriesLogos, { delays: [0, 0] }), false);
  assert.equal(urls.length, 2);
  const stopped = pipeline.waitForServerCache(carriesLogos, { delays: [0, 0, 0] });
  pipeline.stopWaitingForServerCache();
  assert.equal(await stopped, false);
  assert.equal(urls.length, 2, 'a stopped wait fetches nothing more');
  const off = await logoWarmHarness(t, 0);
  off.h.JE.pluginConfig.TagCacheServerMode = false;
  assert.equal(await off.pipeline.waitForServerCache(carriesLogos, { delays: [0] }), false);
  assert.equal(off.urls.length, 0);
});
