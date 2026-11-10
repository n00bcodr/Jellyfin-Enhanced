import test from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { setImmediate as settle } from 'node:timers/promises';
import { createHarness, deferred, jsRoot } from '../../helpers/harness.mjs';
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
test('the Spoiler Guard tag strip revision comes from the bootstrap, then each current /tag-data answer, and resets with the user',async t=>{
 const idle=[],timers=new Map(),changes=new Map(),answers=[],extras=[];let seq=0;
 const h=createHarness({html:card,globals:{requestIdleCallback:fn=>idle.push(fn),setTimeout:(fn,ms)=>{timers.set(++seq,{fn,ms});return seq;},clearTimeout:id=>timers.delete(id)},
  apiClient:{ajax:()=>{const answer=deferred();answers.push(answer);return answer.promise;}},
  JE:{pluginConfig:{TagCacheServerMode:false},currentSettings:{},takePrefetched:name=>name==='TagStripRevision'?'none':undefined,core:{tagRenderer:{applyCornerStacking(){},scheduleCornerStacking(){}}},session:{onUserChange:(id,fn)=>changes.set(id,fn)}}});
 t.after(()=>h.close());h.load('tags/tag-pipeline.js');
 h.JE.tagPipeline.registerRenderer('probe',{isEnabled:()=>true,render:(host,item,extra)=>extras.push(extra.stripRevision)});
 const scan=()=>{while(idle.length)idle.shift()({timeRemaining:()=>50});};
 const fetch=()=>{for(const[id,timer]of[...timers])if(timer.ms===150){timers.delete(id);timer.fn();}};
 assert.equal(h.JE.tagPipeline.tagStripRevision(),'none','the bootstrap value before any request');
 // A batch cancelled by a reinitialize: its answer is dropped, revision and all.
 scan();fetch();h.JE.tagPipeline.clearProcessed();h.JE.tagPipeline.scheduleScan();scan();
 answers[0].resolve({Items:[],StripRevision:'g1:old'});await settle();
 assert.equal(h.JE.tagPipeline.tagStripRevision(),'none');
 fetch();await settle();
 assert.equal(answers.length,2);
 answers[1].resolve({Items:[{Id:'aabb',Type:'Movie'}],StripRevision:'g1:new'});await settle();
 assert.equal(h.JE.tagPipeline.tagStripRevision(),'g1:new');
 assert.deepEqual(extras,['g1:new'],'each render learns its own answer\'s revision');
 changes.get('tag-pipeline')({userId:'b'});
 assert.equal(h.JE.tagPipeline.tagStripRevision(),null,'unknown for the next user until an answer says');
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

test('cache-off navigation cancels the old debounce and requeues every pending season card', async t => {
 const ids=['11111111111111111111111111111111','22222222222222222222222222222222'];
 const seasons=ids.map(id=>card.replace('AA-BB',id).replace('Movie','Season')).join('');
 const h=setup(t,seasons);let navigate;
 h.JE.currentSettings.qualityTagsEnabled=true;
 h.JE.helpers={onBodyMutation(){},onNavigate(fn){navigate=fn;}};
 h.JE.tagPipeline.initialize();await settle();h.scan();
 assert.ok([...h.timers.values()].some(timer=>timer.ms===150),'seasons queued before navigation');
 const detached=h.document.querySelector('.card');detached.remove();
 h.window.location.hash='#/details?id=series';navigate();
 assert.equal([...h.timers.values()].filter(timer=>timer.ms===150).length,0,'the cancelled queue owns no fetch timer');
 h.document.body.append(detached);h.scan();h.fetch();
 assert.equal(h.calls.length,1);
 assert.deepEqual(JSON.parse(h.calls[0].data).sort(),ids,'both surviving and reattached seasons are retried');
 h.response.resolve({Items:ids.map(Id=>({Id,Type:'Season'}))});await settle();
 assert.equal(h.document.querySelectorAll('.probe-tag').length,2,'both seasons render without reload');
 h.window.location.hash='#/details?id=another-series';navigate();h.scan();h.fetch();
 assert.equal(h.calls.length,1,'completed cards keep their processed markers');
});

for (const attribute of ['data-id', 'data-itemid']) for (const artworkReady of [false, true]) {
 test(`episode identity uses ${attribute} before and after borrowed artwork loads (ready=${artworkReady})`, async t => {
  const episode='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',season='bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const html=card.replace('data-id="AA-BB"',`${attribute}="AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA"`).replace('Movie','Episode');
  const h=setup(t,html),image=h.document.querySelector('.cardImageContainer');
  const loadArtwork=()=>{image.style.backgroundImage=`url("/Items/${season}/Images/Primary")`;};
  if(artworkReady)loadArtwork();
  h.scan();
  if(!artworkReady)loadArtwork();
  h.fetch();
  assert.deepEqual(JSON.parse(h.calls[0].data),[episode],'the episode, never its season artwork, supplies tag data');
  h.response.resolve({Items:[{Id:episode,Type:'Episode',CommunityRating:9.1},{Id:season,Type:'Season',CommunityRating:4.2}]});await settle();
  assert.equal(h.rendered.length,1);
  assert.equal(h.rendered[0].item.Id,episode);
  assert.equal(h.rendered[0].item.CommunityRating,9.1);
 });
}

test('valid card identity wins for other media types while artwork remains a fallback', async t => {
 const item='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',poster='bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
 const withImage=card.replace('AA-BB',item).replace('class="cardImageContainer"',`class="cardImageContainer" style='background-image:url("/Items/${poster.toUpperCase()}/Images/Primary")'`);
 const h=setup(t,withImage+withImage.replace(`data-id="${item}"`,'')+withImage.replace(item,'not-an-item'));
 h.scan();h.fetch();
 assert.deepEqual(JSON.parse(h.calls[0].data).sort(),[item,poster]);
 h.response.resolve({Items:[{Id:item,Type:'Movie'},{Id:poster,Type:'Movie'}]});await settle();
 assert.equal(h.rendered.length,3,'missing or invalid attributes retain the poster URL fallback');
});

test('borrowed episode artwork also uses the episode entry from the server cache', async t => {
 const episode='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',season='bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
 const rendered=[],calls=[];
 const h=createHarness({html:card.replace('AA-BB',episode).replace('Movie','Episode').replace('class="cardImageContainer"',`class="cardImageContainer" style='background-image:url("/Items/${season}/Images/Primary")'`),
  globals:{requestIdleCallback(){}},apiClient:{ajax:async options=>{calls.push(options.url);return {items:{[episode]:{Type:'Episode',CommunityRating:9.1},[season]:{Type:'Season',CommunityRating:4.2}},count:2};}},
  JE:{pluginConfig:{TagCacheServerMode:true},currentSettings:{qualityTagsEnabled:true},helpers:{onBodyMutation(){},onNavigate(){}},core:{tagRenderer:{applyCornerStacking(){},scheduleCornerStacking(){}}}}});
 t.after(()=>h.close());h.load('tags/tag-pipeline.js');
 h.JE.tagPipeline.registerRenderer('probe',{isEnabled:()=>true,renderFromServerCache:(host,entry,id)=>rendered.push({id,entry})});
 h.JE.tagPipeline.initialize();await h.JE.tagPipeline.invalidateServerCache();await settle();
 assert.ok(rendered.length>0);
 assert.ok(rendered.every(({id,entry})=>id===episode&&entry.Type==='Episode'&&entry.CommunityRating===9.1));
 assert.ok(calls.every(url=>url.includes('/tag-cache/')),'no batch fallback is needed');
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

for (const schema of [undefined, 9, 20, 21, 22, 11, 12, 13, 14, 15, 16, 17, 18, 19]) test(`a stored tag cache copy from an older entry schema (${schema ?? 'missing'}) is dropped and downloaded in full`, async t => {
  const { calls, cleared } = await loadWithStoredCopy(t, schema === undefined ? {} : { schema });
  assert.deepEqual(cleared, ['server-a:user-a'], 'the copy without the current schema is cleared');
  assert.ok(calls.length > 0 && calls.every(url => !url.includes('since=')), 'a full download, never a delta on top of it');
});

test('a stored tag cache copy with the current entry schema is restored and only the delta is fetched', async t => {
  const { calls, cleared } = await loadWithStoredCopy(t, { schema: Number(readFileSync(`${jsRoot}/../Features/MediaTags/Services/TagCache/TagCacheService.cs`, 'utf8').match(/CurrentCacheSchemaVersion = (\d+);/)[1]) });
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

test('guard invalidation releases a drain waiting for an old first episode and rejects that episode when it eventually arrives', async t => {
 const idle=[],timers=new Map(),seen=[],oldEpisode=deferred();let seq=0,guarded=false,requests=0;
 const html=card+card.replace('AA-BB','CC-DD').replace('data-type="Movie"','data-type="Series"');
 const h=createHarness({html,globals:{requestIdleCallback:fn=>idle.push(fn),setTimeout:(fn,ms)=>{timers.set(++seq,{fn,ms});return seq;},clearTimeout:id=>timers.delete(id)},
  apiClient:{ajax:async options=>{
   const ids=JSON.parse(options.data);if(ids.length===1&&ids[0]==='eeff')return oldEpisode.promise;
   requests++;return {StripRevision:guarded?'g2:guarded':'none',Items:[{Id:'aabb',Type:'Movie'},{Id:'ccdd',Type:'Series',FirstEpisode:guarded?null:{Id:'eeff',NeedsStreamFetch:true}}]};
  }},JE:{pluginConfig:{TagCacheServerMode:false},currentSettings:{},helpers:{onBodyMutation(){},onNavigate(){},addCSS(){}},core:{tagRenderer:{applyCornerStacking(){},scheduleCornerStacking(){}}}}});
 t.after(()=>h.close());h.load('tags/tag-pipeline.js');
 h.JE.tagPipeline.registerRenderer('probe',{isEnabled:()=>true,needsFirstEpisode:true,render:(el,item,extras)=>seen.push([item.Id,extras.stripRevision])});h.JE.tagPipeline.initialize();
 const flush=async()=>{for(let n=0;n<5;n++){while(idle.length)idle.shift()({timeRemaining:()=>50});for(const[id,timer]of[...timers])if(timer.ms===150){timers.delete(id);timer.fn();}await settle();}};
 await flush();assert.equal(requests,1);assert.deepEqual(seen,[['aabb','none']]);
 guarded=true;await h.JE.tagPipeline.invalidateServerCache();await flush();
 assert.equal(requests,2,'new policy is fetched while the obsolete episode remains unresolved');
 assert.deepEqual(seen,[['aabb','none'],['aabb','g2:guarded'],['ccdd','g2:guarded']]);
 oldEpisode.resolve({Items:[{Id:'eeff',Type:'Episode',Genres:['obsolete']}],StripRevision:'none'});await flush();
 assert.equal(seen.length,3,'obsolete first-episode completion cannot render or stamp anything');
 assert.equal(h.JE.tagPipeline.tagStripRevision(),'g2:guarded');
});

test('a delta\'s removed ids leave memory and the stored copy without a full download', async t => {
  const urls = [];
  const applied = [];
  let deltas = 0;
  const h = createHarness({
    // Idle slices run promptly so the stored copy is written and the delta lands on it.
    globals: { requestIdleCallback: cb => setTimeout(() => cb({ timeRemaining: () => 50, didTimeout: false }), 0) },
    apiClient: {
      getCurrentUserId: () => 'user-a',
      ajax: async ({ url }) => {
        urls.push(url);
        if (!url.includes('since=')) return { items: { gone: { Type: 'Movie' }, kept: { Type: 'Movie' }, back: { Type: 'Movie' } }, count: 3, version: 4, timestamp: 50, filterRevision: 'all', servedAt: 60 };
        deltas++;
        // The second delta has nothing new: the first one's cursor moved past its removals.
        return deltas === 1
          ? { items: { back: { Type: 'Movie', CommunityRating: 7 } }, removed: ['gone', 'back'], count: 1, version: 4, timestamp: 70, filterRevision: 'all', servedAt: 80 }
          : { items: {}, count: 0, version: 4, timestamp: 70, filterRevision: 'all', servedAt: 90 };
      },
    },
    JE: {
      pluginConfig: { TagCacheServerMode: true }, currentSettings: { qualityTagsEnabled: true },
      helpers: { onBodyMutation() {}, onNavigate() {}, addCSS() {} },
      core: { tagRenderer: { applyCornerStacking() {}, scheduleCornerStacking() {} } },
      session: { getUserId: () => 'user-a', getServerId: () => 'server-a', getEpoch: () => 0, isCurrent: () => true, onUserChange() {} },
      tagCacheStore: {
        available: () => true,
        getMeta: async () => null,
        getMany: async () => ({ entries: new Map(), meta: null }),
        clearScope: async () => {}, clearOtherScopes: async () => {},
        beginFullWrite: async () => true, putManyIfOwner: async () => true, commitFullWrite: async () => true,
        applyDelta: async (scope, base, entries, timestamp, servedAt, removed) => { applied.push({ ids: entries.map(e => e[0]), removed, timestamp }); return true; },
      },
    },
  });
  t.after(() => h.close());
  h.load('tags/tag-pipeline.js');
  const refreshed = [];
  h.JE.tagPipeline.registerRenderer('probe', { render() {}, isEnabled: () => false, onServerCacheRefresh: ids => refreshed.push(ids) });
  h.JE.tagPipeline.initialize();
  await h.JE.tagPipeline.invalidateServerCache();
  await settle();
  urls.length = 0;
  const pipeline = h.JE.tagPipeline;
  assert.equal(await pipeline.waitForServerCache(entries => [...entries].length === 2, { delays: [0] }), true);
  assert.equal(pipeline.peekServerEntry('gone'), null);
  assert.equal(pipeline.peekServerEntry('kept')?.Type, 'Movie');
  // An id that came back in the same delta is an update, never a removal.
  assert.equal(pipeline.peekServerEntry('back')?.CommunityRating, 7);
  // The delta waits behind the stored copy's write (which starts after a short idle delay).
  for (let i = 0; i < 60 && applied.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.deepEqual(JSON.parse(JSON.stringify(applied)), [{ ids: ['back'], removed: ['gone'], timestamp: 70 }]);
  assert.ok(refreshed.some(ids => ids?.includes('gone') && ids.includes('back')), 'renderers hear about removed ids too');
  assert.ok(urls.length > 0 && urls.every(url => url.includes('since=')), 'deltas only, never a full download');
});

/**
 * A full load of three movies under filter `r1`/`b1`, then deltas from `answers` (one per delta request); the stub
 * store keeps the full write and records reconciles.
 */
async function accessHarness(t, answers) {
  const urls = [];
  const reconciled = [];
  let deltas = 0;
  const h = createHarness({
    globals: { requestIdleCallback: cb => setTimeout(() => cb({ timeRemaining: () => 50, didTimeout: false }), 0) },
    apiClient: {
      getCurrentUserId: () => 'user-a',
      ajax: async ({ url }) => {
        urls.push(url);
        if (!url.includes('since=')) return { items: { a: { Type: 'Movie' }, b: { Type: 'Movie' }, c: { Type: 'Movie' } }, count: 3, version: 4, timestamp: 50, filterRevision: deltas > 0 ? 'r2' : 'r1', filterBase: 'b1', servedAt: 60 };
        return answers[Math.min(deltas++, answers.length - 1)];
      },
    },
    JE: {
      pluginConfig: { TagCacheServerMode: true }, currentSettings: { qualityTagsEnabled: true },
      helpers: { onBodyMutation() {}, onNavigate() {}, addCSS() {} },
      core: { tagRenderer: { applyCornerStacking() {}, scheduleCornerStacking() {} } },
      session: { getUserId: () => 'user-a', getServerId: () => 'server-a', getEpoch: () => 0, isCurrent: () => true, onUserChange() {} },
      tagCacheStore: {
        available: () => true,
        getMeta: async () => null,
        getMany: async () => ({ entries: new Map(), meta: null }),
        clearScope: async () => {}, clearOtherScopes: async () => {},
        beginFullWrite: async () => true, putManyIfOwner: async () => true, commitFullWrite: async () => true,
        applyDelta: async () => true,
        reconcileAccess: async (scope, base, next, entries, removed, visible) => { reconciled.push({ base, next, visible: [...visible] }); return { applied: true, dropped: [] }; },
      },
    },
  });
  t.after(() => h.close());
  h.load('tags/tag-pipeline.js');
  const refreshed = [];
  h.JE.tagPipeline.registerRenderer('probe', { render() {}, isEnabled: () => false, onServerCacheRefresh: (ids, info) => refreshed.push({ ids, info }) });
  h.JE.tagPipeline.initialize();
  await h.JE.tagPipeline.invalidateServerCache();
  await settle();
  urls.length = 0;
  return { h, urls, reconciled, refreshed, pipeline: h.JE.tagPipeline };
}

test('an access-only change drops what the user can no longer see without a full download', async t => {
  const { urls, reconciled, refreshed, pipeline } = await accessHarness(t, [
    { items: {}, count: 0, version: 4, timestamp: 70, filterRevision: 'r2', filterBase: 'b1', visible: ['a', 'b'], servedAt: 80 },
    { items: {}, count: 0, version: 4, timestamp: 70, filterRevision: 'r2', filterBase: 'b1', servedAt: 90 },
  ]);
  assert.equal(await pipeline.waitForServerCache(entries => [...entries].length === 2, { delays: [0] }), true);
  assert.equal(pipeline.peekServerEntry('c'), null);
  assert.equal(pipeline.peekServerEntry('a')?.Type, 'Movie');
  assert.ok(urls[0].includes('known=r1'), 'the delta names the filter its copy was made under');
  assert.ok(refreshed.some(({ ids, info }) => ids?.includes('c') && !info?.replaced), 'renderers hear about the dropped id; nothing is replaced');
  for (let i = 0; i < 60 && reconciled.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.deepEqual(JSON.parse(JSON.stringify(reconciled)), [{ base: { timestamp: 50, version: 4, filterRevision: 'r1' }, next: { timestamp: 70, servedAt: 80, filterRevision: 'r2', filterBase: 'b1' }, visible: ['a', 'b'] }]);
  await pipeline.waitForServerCache(() => false, { delays: [0] });
  assert.ok(urls.length > 1 && urls.every(url => url.includes('since=')), 'deltas only, never a full download');
  assert.ok(urls.at(-1).includes('known=r2'), 'later deltas are asked under the new filter');
});

test('an access change that makes an item the copy lacks visible downloads in full', async t => {
  const { urls, reconciled, pipeline } = await accessHarness(t, [
    { items: {}, count: 0, version: 4, timestamp: 70, filterRevision: 'r2', filterBase: 'b1', visible: ['a', 'b', 'c', 'new'], servedAt: 80 },
  ]);
  await pipeline.waitForServerCache(() => false, { delays: [0] });
  for (let i = 0; i < 40 && !urls.some(url => !url.includes('since=')); i++) await new Promise(resolve => setTimeout(resolve, 25));
  assert.ok(urls.some(url => !url.includes('since=')), 'a full download brings the newly visible item');
  assert.deepEqual(reconciled, []);
});

test('a Spoiler Guard or ratings filter change still replaces the copy, whatever is visible', async t => {
  const { urls, reconciled, pipeline } = await accessHarness(t, [
    { items: {}, count: 0, version: 4, timestamp: 70, filterRevision: 'r2', filterBase: 'b2', visible: ['a', 'b'], servedAt: 80 },
  ]);
  await pipeline.waitForServerCache(() => false, { delays: [0] });
  for (let i = 0; i < 40 && !urls.some(url => !url.includes('since=')); i++) await new Promise(resolve => setTimeout(resolve, 25));
  assert.ok(urls.some(url => !url.includes('since=')), 'a full download replaces the copy');
  assert.deepEqual(reconciled, []);
});
