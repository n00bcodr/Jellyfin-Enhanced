import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHarness,deferred,jsonResponse} from '../helpers/harness.mjs';

// The details page's visit owner (features-details-page.js) with the real chip modules: a fresh
// details view starts the chips' item-stats and release lookups once the item is known, and the
// chips take them over when they are placed.
const PAGE='<div id="itemDetailPage" class="page libraryPage itemDetailPage"><div class="itemMiscInfo itemMiscInfo-primary"></div><select class="selectSource"></select></div>';
const ITEMS={
 movie:{Id:'movie',Type:'Movie',ProviderIds:{Tmdb:'42'},MediaSources:[{Id:'src1'}]},
 multi:{Id:'multi',Type:'Movie',ProviderIds:{Tmdb:'43'},MediaSources:[{Id:'a'},{Id:'b'}]},
 series:{Id:'series',Type:'Series',ProviderIds:{Tmdb:'7'}},
 person:{Id:'person',Type:'Person'}
};
const RELEASES={results:[{iso_3166_1:'US',release_dates:[{type:3,release_date:'2025-03-01'}]}]};

function setup(t,{id='movie',settings={showWatchProgress:true,showFileSizes:true},config={ShowReleaseDates:true,TmdbEnabled:true},stats,people}={}){
 const views=[],navs=[],debounced={},userHandlers=[],items=new Map(),plugin=[],tmdb=[];let epoch=0,lookups=0;
 const h=createHarness({html:PAGE,url:`http://jellyfin.test/web/index.html#/details?id=${id}`,
  fetch:async url=>{tmdb.push(String(url));return jsonResponse(RELEASES);},
  globals:{requestAnimationFrame:fn=>{fn();return 1;}},
  JE:{currentSettings:settings,pluginConfig:config,t:key=>key,internals:people?{peopleTags:people}:{},
   helpers:{
    // The shared item cache: one request per item, every caller gets the same promise.
    getItemCached:itemId=>{lookups++;if(!items.has(itemId))items.set(itemId,deferred());return items.get(itemId).promise;},
    debounce:(fn,wait)=>{debounced[wait]=fn;return ()=>{};},createObserver:()=>{},onViewPage:()=>{},addCSS:()=>{}},
   core:{navigation:{onViewPage:fn=>views.push(fn),onNavigate:fn=>navs.push(fn)},
    api:{plugin:(path,options)=>{plugin.push([path,options]);return stats?stats(path,options):Promise.resolve({size:1024,progress:50,totalPlaybackTicks:1,totalRuntimeTicks:2});},
     manager:{withConcurrencyLimit:fn=>fn()}}},
   session:{getEpoch:()=>epoch,isCurrent:e=>e===epoch,onUserChange:(key,fn)=>userHandlers.push(fn)}}});
 t.after(()=>h.close());
 for(const file of ['features-details-media-info.js','features-release-dates.js','features-details-page.js'])h.load(`enhanced/itemdetails/${file}`);
 const page=h.document.getElementById('itemDetailPage'),row=page.querySelector('.itemMiscInfo-primary');
 return {...h,page,row,plugin,tmdb,
  itemRequests:()=>[...items.keys()],lookups:()=>lookups,
  bumpEpoch(){epoch++;},epoch:()=>epoch,
  giveItem(itemId=id){if(!items.has(itemId))items.set(itemId,deferred());items.get(itemId).resolve(ITEMS[itemId]);},
  async resolveItem(itemId=id){this.giveItem(itemId);await this.flush();},
  viewshow(rawEvent={target:page,detail:{params:{id}}}){for(const fn of views)fn('itemDetailPage',page,h.window.location.hash,null,rawEvent);},
  navigate(hash){h.window.location.hash=hash;for(const fn of navs)fn();},
  switchUser(){epoch++;for(const fn of userHandlers)fn();},
  // runItemDetails' early (info row filled) and settled runs.
  runEarly(){debounced[16]();},runSettled(){debounced[100]();},
  fillInfoRow(){row.insertAdjacentHTML('afterbegin','<div class="mediaInfoItem">2025</div>');},
  tick:()=>new Promise(done=>h.window.setTimeout(done,0)),
  settle:()=>new Promise(done=>setImmediate(done)),
  // Promise chains, then the visit's setTimeout(0) that starts the lookups.
  async flush(){await this.settle();await this.tick();await this.settle();}};
}

/** The page loads: Jellyfin fills its info row and runItemDetails places the chips. */
async function placeChips(h){h.fillInfoRow();h.runEarly();await h.flush();}

test('a fresh details view starts the chips\' requests once the item is known; the chips take them over',async t=>{
 const old=setup(t);await placeChips(old);await old.resolveItem();await old.settle();
 const h=setup(t);h.viewshow();assert.deepEqual(h.itemRequests(),['movie']);assert.equal(h.plugin.length,0);
 await h.resolveItem();
 assert.deepEqual(h.plugin.map(([path])=>path),['/item-stats/user-a/movie?mediaSourceId=src1']);assert.ok(h.plugin[0][1].signal);
 assert.equal(h.tmdb.length,1);assert.match(h.tmdb[0],/\/tmdb\/movie\/42\/release_dates$/);
 await placeChips(h);
 assert.deepEqual(h.plugin.map(([path])=>path),old.plugin.map(([path])=>path),'the same item-stats request as without the prefetch');
 assert.deepEqual(h.tmdb,old.tmdb,'the same TMDB request as without the prefetch');assert.deepEqual(h.itemRequests(),old.itemRequests());
 assert.equal(h.row.innerHTML,old.row.innerHTML);assert.equal(h.row.querySelectorAll('.mediaInfoItem-fileSize,.mediaInfoItem-watchProgress,.mediaInfoItem-releaseDate').length,3);
 h.navigate('#/home');assert.equal(h.plugin[0][1].signal.aborted,false,'a claimed prefetch is not dropped with its visit');
});
test('the prefetch uses the chips\' source and item gates',async t=>{
 const series=setup(t,{id:'series'});series.viewshow();await series.resolveItem();
 assert.deepEqual(series.plugin.map(([path])=>path),['/item-stats/user-a/series']);assert.match(series.tmdb[0],/\/tmdb\/tv\/7$/);
 const multi=setup(t,{id:'multi'});multi.viewshow();await multi.resolveItem();
 assert.equal(multi.plugin.length,0,'the selected version is not known yet');assert.equal(multi.tmdb.length,1);
 const person=setup(t,{id:'person'});person.viewshow();await person.resolveItem();assert.equal(person.plugin.length+person.tmdb.length,0);
 const sizesOnly=setup(t,{settings:{showFileSizes:true},config:{ShowReleaseDates:true,TmdbEnabled:false}});sizesOnly.viewshow();await sizesOnly.resolveItem();
 assert.equal(sizesOnly.plugin.length,1);assert.equal(sizesOnly.tmdb.length,0);
 const releaseOnly=setup(t,{settings:{}});releaseOnly.viewshow();await releaseOnly.resolveItem();assert.equal(releaseOnly.plugin.length,0);assert.equal(releaseOnly.tmdb.length,1);
});
test('no visit for restored or other views, a mismatched id, or with every feature off',async t=>{
 const h=setup(t);
 h.viewshow({target:h.page,detail:{params:{id:'movie'},isRestored:true}});
 h.viewshow(null);
 h.viewshow({target:h.document.body,detail:{}});
 h.viewshow({target:h.page,detail:{params:{id:'other'}}});
 assert.deepEqual(h.itemRequests(),[]);
 const off=setup(t,{settings:{showAudioLanguages:true},config:{ShowReleaseDates:true}});off.viewshow();assert.deepEqual(off.itemRequests(),[]);
});
test('no visit when runItemDetails already knows the item',async t=>{
 const h=setup(t);h.fillInfoRow();h.runEarly();await h.resolveItem();await h.settle();assert.equal(h.plugin.length,1);
 // Home, then a freshly built view of the same item: the chips are cached and no lookup is made.
 h.navigate('#/home');h.navigate('#/details?id=movie');h.row.replaceChildren();
 const lookups=h.lookups();h.viewshow();await h.flush();assert.equal(h.lookups(),lookups,'no item lookup (it may have left the 30 s item cache)');assert.equal(h.plugin.length,1);
});
test('leaving, a hidden view or a user switch before the item is known starts nothing',async t=>{
 const left=setup(t);left.viewshow();left.navigate('#/home');await left.resolveItem();assert.equal(left.plugin.length+left.tmdb.length,0);
 const hidden=setup(t);hidden.viewshow();hidden.page.classList.add('hide');await hidden.resolveItem();assert.equal(hidden.plugin.length+hidden.tmdb.length,0);
 const switched=setup(t);switched.viewshow();switched.switchUser();await switched.resolveItem();assert.equal(switched.plugin.length+switched.tmdb.length,0);
 // Left between the item and the timer that starts the lookups.
 const late=setup(t);late.viewshow();late.giveItem();await late.settle();late.navigate('#/home');await late.flush();assert.equal(late.plugin.length+late.tmdb.length,0);
 // The URL or the identity moved on before their callbacks reached the visit.
 const moved=setup(t);moved.viewshow();moved.giveItem();await moved.settle();moved.window.location.hash='#/details?id=series';await moved.flush();assert.equal(moved.plugin.length+moved.tmdb.length,0);
 const epoch=setup(t);epoch.viewshow();epoch.giveItem();await epoch.settle();epoch.bumpEpoch();await epoch.flush();assert.equal(epoch.plugin.length+epoch.tmdb.length,0);
});
test('leaving before the chips drops the visit\'s prefetch: still queued, it is aborted; the next visit asks again',async t=>{
 const queued=deferred();let n=0;
 const h=setup(t,{stats:()=>++n===1?queued.promise:Promise.resolve({size:2048,progress:20,totalPlaybackTicks:1,totalRuntimeTicks:2})});
 h.viewshow();await h.resolveItem();assert.equal(h.plugin.length,1);
 h.navigate('#/details?id=series');assert.equal(h.plugin[0][1].signal.aborted,true);queued.reject(Object.assign(new Error('Request aborted'),{name:'AbortError'}));
 // Back to the movie in a fresh view; Jellyfin keeps the old one hidden.
 h.navigate('#/details?id=movie');h.viewshow();await h.flush();assert.equal(h.plugin.length,2);
 await placeChips(h);assert.equal(h.plugin.length,2);assert.match(h.row.textContent,/20%/);assert.match(h.row.textContent,/2 KB/);
});

/** People tags' entry points, recording their calls. */
function peopleSpy(){const calls=[];return {calls,prefetch:(...args)=>calls.push(['prefetch',...args]),leave:itemId=>calls.push(['leave',itemId])};}

test('people/info starts once Jellyfin has filled the info row, once per visit',async t=>{
 const people=peopleSpy();const h=setup(t,{settings:{showFileSizes:true,peopleTagsEnabled:true},people});
 h.viewshow();await h.resolveItem();assert.equal(h.plugin.length,1);assert.deepEqual(people.calls,[],'the row is still empty');
 await placeChips(h);
 assert.deepEqual(people.calls.map(([kind,itemId,item,view,epoch])=>[kind,itemId,item.Id,view,epoch]),[['prefetch','movie','movie',h.page,h.epoch()]]);
 h.runEarly();h.runSettled();await h.flush();assert.equal(people.calls.length,1);
 h.navigate('#/home');assert.deepEqual(people.calls[1],['leave','movie']);
});
test('a row filled before the item came back starts people/info with the chips',async t=>{
 const people=peopleSpy();const h=setup(t,{settings:{peopleTagsEnabled:true},config:{},people});
 h.viewshow();assert.deepEqual(h.itemRequests(),['movie'],'people tags alone start a visit');h.fillInfoRow();await h.resolveItem();
 assert.equal(people.calls.length,1);assert.equal(people.calls[0][0],'prefetch');assert.equal(h.plugin.length+h.tmdb.length,0);
});
test('no people/info prefetch without people tags, after leaving, or on another view',async t=>{
 const off=setup(t,{settings:{peopleTagsEnabled:true},config:{}});off.viewshow();assert.deepEqual(off.itemRequests(),[],'people tags not initialised');
 const people=peopleSpy();const left=setup(t,{settings:{showFileSizes:true,peopleTagsEnabled:true},people});
 left.viewshow();left.navigate('#/details?id=series');left.navigate('#/details?id=movie');await left.resolveItem();await placeChips(left);
 assert.deepEqual(people.calls.filter(([kind])=>kind==='prefetch'),[]);
 const other=peopleSpy();const h=setup(t,{settings:{showFileSizes:true,peopleTagsEnabled:true},people:other});
 h.viewshow({target:h.page,detail:{params:{id:'movie'}}});await h.resolveItem();
 // Jellyfin shows another details view of the same item (the visit's one is hidden).
 h.page.classList.add('hide');h.document.body.insertAdjacentHTML('beforeend',PAGE);const second=h.document.querySelectorAll('#itemDetailPage')[1];
 second.querySelector('.itemMiscInfo-primary').insertAdjacentHTML('afterbegin','<div class="mediaInfoItem">2025</div>');h.runEarly();await h.flush();
 assert.deepEqual(other.calls,[]);
 // Both views visible during a transition, the other one first: its row is not the visit's.
 const both=peopleSpy();const v=setup(t,{settings:{showFileSizes:true,peopleTagsEnabled:true},people:both});
 v.viewshow();await v.resolveItem();v.document.body.insertAdjacentHTML('afterbegin',PAGE);
 v.document.querySelector('#itemDetailPage .itemMiscInfo-primary').insertAdjacentHTML('afterbegin','<div class="mediaInfoItem">2025</div>');v.runEarly();await v.flush();
 assert.deepEqual(both.calls,[]);
 const stale=peopleSpy();const e=setup(t,{settings:{showFileSizes:true,peopleTagsEnabled:true},people:stale});
 e.viewshow();await e.resolveItem();e.bumpEpoch();await placeChips(e);assert.deepEqual(stale.calls,[],'the identity moved on');
});
