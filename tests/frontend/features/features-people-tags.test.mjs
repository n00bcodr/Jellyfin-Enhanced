import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHarness,deferred} from '../helpers/harness.mjs';

// People tags (tags/peopletags.js) with a details visit's people/info prefetch: the requests a card
// pass would make, started before the cast cards are on the page, which the card pass takes over.
const pid=n=>n.toString(16).padStart(32,'0');
const factsOf=id=>{const n=parseInt(id,16);return {birthDate:`19${50+n%40}-0${1+n%8}-1${n%9}`,birthPlace:n%2?'London, England, UK':'Paris, France'};};
const answer=ids=>({people:Object.fromEntries(ids.map(id=>[id,factsOf(id)]))});
const PAGE=id=>`<div id="itemDetailPage" class="page" data-item="${id}"><div class="itemMiscInfo itemMiscInfo-primary"></div><div id="castCollapsible"><div id="castContent"></div></div><div id="guestCastCollapsible"><div id="guestCastContent"></div></div></div>`;
const card=n=>`<div class="card personCard" data-id="${pid(n)}"><div class="cardBox"><div class="cardScalable"><div class="cardImageContainer"></div></div></div></div>`;
/**
 * An item whose cast is `cast` (person numbers; a repeated number is one person with two cards) and guest
 * stars `guests`. People lists the guest stars first: Jellyfin renders them in their own section after the cast.
 */
const itemOf=(cast,guests=[],extra=[])=>({Type:'Movie',People:[...guests.map(n=>({Id:pid(n),Type:'GuestStar'})),...cast.map((n,i)=>({Id:pid(n),Type:i%5===4?'Director':'Actor'})),...extra]});
const range=(from,to)=>Array.from({length:to-from+1},(_,i)=>from+i);
const abortError=()=>Object.assign(new Error('Request aborted'),{name:'AbortError'});

function setup(t,{id='movie',server,premiere}={}){
 const calls=[],userHandlers=[],tracked=new Set(),timers=[];let epoch=1,subscriber=null,pendingQuiet=null,armed=0,clock=0,nextTimer=1;
 const h=createHarness({html:PAGE(id),url:`http://jellyfin.test/web/index.html#/details?id=${id}`,
  JE:{currentSettings:{peopleTagsEnabled:true},pluginConfig:{},cdn:{flagPng:code=>`/flags/${code}.png`},
   helpers:{
    // The 100 ms trailing debounce: armed by every call, run by quiet().
    debounce:fn=>()=>{armed++;pendingQuiet=fn;},
    createObserver:(_name,fn)=>{subscriber=fn;},
    getItemCached:itemId=>premiere?premiere(itemId):Promise.resolve({Id:itemId,PremiereDate:'2000-06-15T00:00:00.0000000Z'})},
   core:{lifecycle:{register:()=>({track:r=>{tracked.add(r);return r;},untrack:r=>{tracked.delete(r);},
     teardown:()=>{for(const r of [...tracked]){if(typeof r==='function')r();else r.abort?.();}tracked.clear();}})},
    ui:{injectCss:()=>{}},
    api:{plugin:(path,options)=>{assert.match(path,/^\/people\/info\?ids=/);const ids=path.slice('/people/info?ids='.length).split(',').map(decodeURIComponent);
     const call={ids,options};calls.push(call);const response=(server||(()=>Promise.resolve(answer(ids))))(ids,options,call);
     // Like the real client, an aborted request rejects at once.
     const signal=options?.signal;if(!signal)return response;if(signal.aborted)return Promise.reject(abortError());
     return Promise.race([response,new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(abortError()),{once:true}))]);}}},
   session:{getEpoch:()=>epoch,isCurrent:e=>e===epoch,onUserChange:(key,fn)=>userHandlers.push(fn),getServerId:()=>'server-a',getUserId:()=>'user-a'}}});
 t.after(()=>h.close());
 // The completion latch (2 s) and the retry waits (1 s, 3 s) run on a manual clock.
 const realSetTimeout=h.window.setTimeout.bind(h.window),realClearTimeout=h.window.clearTimeout.bind(h.window);
 h.window.setTimeout=(fn,ms,...args)=>{if(!(ms>=1000))return realSetTimeout(fn,ms,...args);const timer={id:`t${nextTimer++}`,fn,at:clock+ms};timers.push(timer);return timer.id;};
 h.window.clearTimeout=timerId=>{const i=timers.findIndex(timer=>timer.id===timerId);if(i!==-1)timers.splice(i,1);else realClearTimeout(timerId);};
 h.load('tags/peopletags.js');h.JE.initializePeopleTags();
 const settle=async(rounds=4)=>{for(let i=0;i<rounds;i++)await new Promise(done=>setImmediate(done));};
 const api={...h,calls,tracked,
  get pages(){return [...h.document.querySelectorAll('#itemDetailPage')];},
  view:()=>h.document.querySelector('#itemDetailPage:not(.hide)'),
  epoch:()=>epoch,armed:()=>armed,settle,
  /** The identity moved on; its reset handlers have not run yet. */
  bumpEpoch(){epoch++;},
  urls:()=>calls.map(({ids})=>ids.join(',')),
  stored:personId=>(h.window.localStorage.getItem('JellyfinEnhanced-peopleTagsCache-v2')||'').includes(personId),
  prefetch(item,itemId=id,view=api.view()){h.JE.internals.peopleTags.prefetch(itemId,item,view,epoch);},
  leave(itemId=id){h.JE.internals.peopleTags.leave(itemId);},
  /** Jellyfin renders the cast cards (one observer flush). */
  mount(cast,guests=[],view=api.view()){view.querySelector('#castContent').insertAdjacentHTML('beforeend',cast.map(card).join(''));view.querySelector('#guestCastContent').insertAdjacentHTML('beforeend',guests.map(card).join(''));api.flush();},
  flush(){subscriber([{addedNodes:[h.document.createElement('div')]}]);},
  /** 100 ms without mutations: the debounced run. */
  async quiet(){const fn=pendingQuiet;pendingQuiet=null;fn?.();await settle();},
  async advance(ms){clock+=ms;for(const timer of timers.filter(timer=>timer.at<=clock).sort((a,b)=>a.at-b.at)){timers.splice(timers.indexOf(timer),1);timer.fn();await settle();}},
  /** Another details view becomes the visible one (Jellyfin keeps the old one hidden). */
  navigate(itemId){for(const page of api.pages)page.classList.add('hide');h.document.body.insertAdjacentHTML('beforeend',PAGE(itemId));h.window.location.hash=`#/details?id=${itemId}`;},
  switchUser(){epoch++;for(const fn of userHandlers)fn({userId:'user-b',serverId:'server-a'});},
  tagged:(view=api.view())=>[...view.querySelectorAll('.personCard')].filter(c=>c.querySelector('.je-people-age-container,.je-people-place-banner')).length,
  cards:(view=api.view())=>view.querySelectorAll('.personCard').length};
 return api;
}

/** The previous flow: cards mount, the page goes quiet, the card pass requests and paints. */
async function oldFlow(t,cast,guests,options){const h=setup(t,options);h.mount(cast,guests);await h.settle();await h.quiet();await h.settle();return h;}

test('the prefetch sends the card pass\'s requests; the cards take them over with no request and the same tags',async t=>{
 const cast=[...range(1,12),1],guests=[20,21,22];
 const old=await oldFlow(t,cast,guests);
 assert.deepEqual(old.urls(),[range(1,8).map(pid).join(','),[...range(9,12),...guests].map(pid).join(',')]);
 const pending=[];const h=setup(t,{server:()=>{const d=deferred();pending.push(d);return d.promise;}});
 h.prefetch(itemOf(cast,guests));
 assert.deepEqual(h.urls(),old.urls(),'first 8, then the rest; cast before guest stars; each person once');
 assert.equal(h.calls[0].options.skipRetry,true);assert.ok(h.calls[0].options.signal);
 h.mount(cast,guests);await h.settle();
 for(const [i,d] of pending.entries())d.resolve(answer(h.calls[i].ids));await h.settle();
 assert.equal(h.calls.length,2,'no request of its own');assert.equal(h.tagged(),cast.length+guests.length,'painted without waiting for quiet');
 assert.equal(h.view().innerHTML,old.view().innerHTML);
 await h.quiet();assert.equal(h.calls.length,2);assert.equal(h.view().innerHTML,old.view().innerHTML);
 assert.equal(h.tracked.size,old.tracked.size,'the prefetch controller is untracked once settled');
});
test('a prefetch answered before the cards: the first flush paints from the cache',async t=>{
 const h=setup(t);h.prefetch(itemOf(range(1,10)));await h.settle();assert.equal(h.calls.length,2);
 h.mount(range(1,10));await h.settle();assert.equal(h.tagged(),10);assert.equal(h.calls.length,2);
 assert.ok(h.window.localStorage.getItem('JellyfinEnhanced-peopleTagsCache-v2').includes(pid(10)),'persisted once settled');
});
test('an all-cached cast takes the fast path with no request',async t=>{
 const h=setup(t);h.mount(range(1,5));await h.settle();await h.quiet();assert.equal(h.calls.length,1);
 h.navigate('other');h.prefetch(itemOf(range(1,5)),'other');assert.equal(h.calls.length,1);
 h.mount(range(1,5));await h.settle();assert.equal(h.tagged(),5);assert.equal(h.calls.length,1);
});
test('a failed prefetch is never shown: the card pass requests that chunk again, one request more',async t=>{
 const cast=range(1,10);const old=await oldFlow(t,cast);assert.equal(old.calls.length,2);
 let n=0;const h=setup(t,{server:ids=>++n===1?Promise.reject(Object.assign(new Error('HTTP 503'),{status:503})):Promise.resolve(answer(ids))});
 h.prefetch(itemOf(cast));await h.settle();assert.equal(h.calls.length,2);
 h.mount(cast);await h.settle();assert.equal(h.tagged(),10);
 assert.deepEqual(h.urls(),[...old.urls(),old.urls()[0]],'the failed chunk is requested again as it was');
 assert.equal(h.calls[2].options.signal.aborted,false);assert.notEqual(h.calls[2].options.signal,h.calls[0].options.signal,'by the card pass');
 assert.equal(h.view().innerHTML,old.view().innerHTML);
});
test('a fallback that keeps failing is retried as before and later items still paint',async t=>{
 let fail=true;const h=setup(t,{server:ids=>fail?Promise.reject(Object.assign(new Error('HTTP 503'),{status:503})):Promise.resolve(answer(ids))});
 h.prefetch(itemOf(range(1,3)));await h.settle();h.mount(range(1,3));await h.settle();assert.equal(h.calls.length,2);
 await h.advance(1000);await h.advance(3000);assert.equal(h.calls.length,4,'prefetch, then the card pass with its two retries');
 assert.equal(h.tagged(),0);fail=false;
 await h.quiet();h.navigate('next');h.prefetch(itemOf(range(4,6)),'next');await h.settle();h.mount(range(4,6));await h.settle();
 assert.equal(h.tagged(),3,'no pass is left hanging');
});
test('leaving before the cards aborts the prefetch and keeps nothing',async t=>{
 const pending=deferred();const h=setup(t,{server:()=>pending.promise});const base=h.tracked.size;h.prefetch(itemOf(range(1,4)));assert.equal(h.tracked.size,base+1);
 h.leave();assert.equal(h.calls[0].options.signal.aborted,true);assert.equal(h.tracked.size,base);
 pending.resolve(answer(h.calls[0].ids));await h.settle();assert.equal(h.stored(pid(1)),false);
 h.navigate('next');h.mount(range(1,4));await h.settle();assert.equal(h.tagged(),0,'no fast path without a prefetch');
 await h.quiet();assert.equal(h.calls.length,2);assert.equal(h.tagged(),4);
});
test('leaving after the card pass joined keeps the request: it paints the view as before',async t=>{
 const pending=deferred();const h=setup(t,{server:()=>pending.promise});h.prefetch(itemOf(range(1,4)));h.mount(range(1,4));await h.settle();
 const view=h.view();h.leave();assert.equal(h.calls[0].options.signal.aborted,false);
 view.classList.add('hide');h.window.location.hash='#/home';pending.resolve(answer(h.calls[0].ids));await h.settle();
 assert.equal(h.tagged(view),4);assert.equal(h.calls.length,1);
});
test('an item change or a user switch leaves no late caching or painting',async t=>{
 const first=deferred();const h=setup(t,{server:()=>first.promise});h.prefetch(itemOf(range(1,4)));h.mount(range(1,4));await h.settle();
 const view=h.view();h.navigate('next');h.mount([9]);await h.quiet();
 assert.equal(h.calls[0].options.signal.aborted,true,'the new item drops the old prefetch');
 first.resolve(answer(h.calls[0].ids));await h.settle();assert.equal(h.tagged(view),0);
 await h.quiet();assert.deepEqual(h.urls(),[range(1,4).map(pid).join(','),pid(9)],'nothing more for the old item');
 assert.equal(h.stored(pid(1)),false);
 const second=deferred();const u=setup(t,{server:()=>second.promise});u.prefetch(itemOf(range(1,4)));u.mount(range(1,4));await u.settle();
 u.switchUser();assert.equal(u.calls[0].options.signal.aborted,true);second.resolve(answer(u.calls[0].ids));await u.settle();
 assert.equal(u.tagged(),0);assert.equal(u.stored(pid(1)),false);
});
test('the fast path only paints the view the visit started on',async t=>{
 const h=setup(t);h.mount(range(1,3));await h.quiet();assert.equal(h.tagged(),3);const a=h.view();
 const tags=[...a.querySelectorAll('.je-people-age-container')];
 // B's view exists (hidden, its cards built) and B's prefetch registered, while A's view is still the visible one.
 h.document.body.insertAdjacentHTML('beforeend',PAGE('b'));const b=h.pages[1];b.classList.add('hide');h.mount(range(1,3),[],b);
 h.window.location.hash='#/details?id=b';h.prefetch(itemOf(range(1,3)),'b',b);
 h.flush();await h.settle();
 assert.equal(tags.length,3);assert.ok(tags.every(tag=>tag.isConnected),'A\'s cards are not repainted under B');assert.equal(h.tagged(b),0);
 // Once B's view is shown, its cards are painted at once.
 a.classList.add('hide');b.classList.remove('hide');h.flush();await h.settle();assert.equal(h.tagged(b),3);assert.equal(h.calls.length,1);
});
test('the completion latch is still armed by the quiet run only',async t=>{
 const h=setup(t);h.prefetch(itemOf(range(1,4)));await h.settle();h.mount(range(1,4));await h.settle();assert.equal(h.tagged(),4);
 await h.advance(2000);h.mount([5]);await h.settle();await h.quiet();assert.equal(h.tagged(),5,'not complete before the quiet run');
 await h.advance(1999);h.mount([6]);await h.quiet();assert.equal(h.tagged(),6,'quiet + 2 s not reached');
 await h.advance(1);h.mount([7]);await h.quiet();assert.equal(h.tagged(),6,'complete: later cards are left as before');
});
test('a quiet run that comes while a fast pass paints runs after it and arms the latch',async t=>{
 const pending=deferred();let n=0;const h=setup(t,{server:ids=>++n===1?pending.promise:Promise.resolve(answer(ids))});
 h.prefetch(itemOf(range(1,3)));h.mount(range(1,3));await h.settle();
 h.mount([4]);await h.quiet();const armed=h.armed();
 pending.resolve(answer(h.calls[0].ids));await h.settle();assert.equal(h.tagged(),4,'the fast pass picks up the new card');
 assert.equal(h.armed(),armed+1,'the skipped quiet run is scheduled again');
 await h.quiet();await h.advance(2000);h.mount([5]);await h.quiet();assert.equal(h.tagged(),4,'complete 2 s after that run');
});
test('every flush still arms the debounced run and an uncovered card takes it',async t=>{
 const h=setup(t);h.prefetch(itemOf(range(1,3)));await h.settle();
 h.mount([...range(1,3),99]);await h.settle();assert.equal(h.armed(),2,'init and the flush');assert.equal(h.tagged(),0,'person 99 is not covered: no fast path');
 await h.quiet();assert.equal(h.tagged(),4);assert.deepEqual(h.urls().slice(1),[pid(99)]);
});
test('no prefetch for artists, people without an id, the setting off or an item a pass owns',async t=>{
 const h=setup(t);
 h.prefetch(itemOf([1],[],[{Id:pid(2),Type:'Artist'}]));h.prefetch(itemOf([1],[],[{Id:pid(2),Type:'AlbumArtist'}]));h.prefetch(itemOf([1],[],[{Type:'Actor',Name:'No id'}]));
 h.prefetch({Type:'Movie'});h.prefetch(itemOf([]));assert.equal(h.calls.length,0);
 h.JE.currentSettings.peopleTagsEnabled=false;h.prefetch(itemOf([1]));assert.equal(h.calls.length,0);h.JE.currentSettings.peopleTagsEnabled=true;
 h.mount([1]);await h.quiet();assert.equal(h.calls.length,1);h.prefetch(itemOf([2]));assert.equal(h.calls.length,1,'the card pass owns this item');
 const e=setup(t);const epoch=e.epoch();e.switchUser();e.JE.internals.peopleTags.prefetch('movie',itemOf([1]),e.view(),epoch);assert.equal(e.calls.length,0,'stale visit');
});
test('controllers stay bounded over many visits',async t=>{
 const h=setup(t);
 for(let i=0;i<10;i++){const item=`item${i}`;h.navigate(item);h.prefetch(itemOf([100+i*3,101+i*3,102+i*3]),item);h.mount([100+i*3,101+i*3,102+i*3]);await h.settle();await h.quiet();h.leave(item);}
 assert.equal(h.tracked.size,1,'only the batch controller');assert.equal(h.calls.length,10);
 for(let i=0;i<10;i++){const item=`left${i}`;h.navigate(item);h.prefetch(itemOf([200+i]),item);h.leave(item);}
 assert.equal(h.tracked.size,1);
});
test('an answer that arrives as the item changes is released, as a card pass\'s would be',async t=>{
 const premiere=deferred();const h=setup(t,{premiere:itemId=>itemId==='movie'?premiere.promise:Promise.resolve({PremiereDate:'2001-01-01'})});
 h.prefetch(itemOf(range(1,3)));await h.settle();h.mount(range(1,3));await h.settle();
 // Answered and cached; the pass still waits for the item's premiere date when the user moves on.
 const view=h.view();h.navigate('next');h.mount([9]);await h.quiet();premiere.resolve({PremiereDate:'2000-01-01'});await h.settle();
 assert.equal(h.tagged(view),0);assert.equal(h.stored(pid(1)),true);
});
test('a prefetch answer from before an identity change is not kept',async t=>{
 const pending=deferred();const h=setup(t,{server:()=>pending.promise});h.prefetch(itemOf(range(1,3)));
 h.bumpEpoch();pending.resolve(answer(h.calls[0].ids));await h.settle();assert.equal(h.stored(pid(1)),false);
 h.mount(range(1,3));await h.settle();await h.quiet();assert.equal(h.calls.length,2,'the card pass asks again: nothing was cached in memory either');
});
test('at most the visit\'s item and the item a pass owns keep a prefetch',async t=>{
 const h=setup(t,{server:()=>new Promise(()=>{})});h.mount([1]);await h.quiet();
 h.prefetch(itemOf([1,2]),'a');h.prefetch(itemOf([3]),'b');h.prefetch(itemOf([4]),'c');
 assert.deepEqual(h.calls.slice(1).map(({options})=>options.signal.aborted),[true,true,false]);
});
