import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHarness,deferred,jsonResponse} from '../helpers/harness.mjs';
function setup(t,{item={Type:'Movie',ProviderIds:{Tmdb:'42'}},data={},fetch,getItem,JE={}}={}){
 let itemCalls=0,fetchCalls=0;const h=createHarness({html:'<div id="info"></div>',apiClient:{getItem:async(...args)=>{itemCalls++;return getItem?getItem(...args):item;}},fetch:async(...args)=>{fetchCalls++;return fetch?fetch(...args):jsonResponse(data);},globals:{requestAnimationFrame:fn=>{fn();return 1;}},JE:{pluginConfig:{DEFAULT_REGION:'AU'},t:key=>key,helpers:{addCSS:()=>{}},...JE}});
 t.after(()=>h.close());h.load('enhanced/itemdetails/features-release-dates.js');return {...h,api:h.JE.internals.features,container:h.document.getElementById('info'),counts:()=>({itemCalls,fetchCalls}),async settle(){await new Promise(done=>setImmediate(done));}};
}
test('release chips deduplicate in-flight requests and resolve regional theatrical/digital/physical dates',async t=>{
 const pending=deferred();const h=setup(t,{fetch:()=>pending.promise});h.api.displayReleaseDate('movie',h.container);h.api.displayReleaseDate('movie',h.container);
 pending.resolve(jsonResponse({results:[{iso_3166_1:'AU',release_dates:[{type:3,release_date:'2025-03-01'},{type:2,release_date:'2025-02-01'}]},{iso_3166_1:'US',release_dates:[{type:4,release_date:'2025-04-01'}]},{iso_3166_1:'GB',release_dates:[{type:5,release_date:'2025-05-01'}]}]}));await h.settle();
 assert.equal(h.container.querySelectorAll('.mediaInfoItem-releaseDate').length,3);assert.match(h.container.querySelector('.je-release-date-cinema').textContent,/Feb/);assert.deepEqual(h.counts(),{itemCalls:1,fetchCalls:1});
 h.container.replaceChildren();h.api.displayReleaseDate('movie',h.container);assert.equal(h.container.children.length,3);assert.deepEqual(h.counts(),{itemCalls:1,fetchCalls:1});
});
test('a release type listed in several countries prefers the configured region, then US, over list order',async t=>{
 // GB is listed first and has the earliest date, US the next earliest; the configured AU still wins.
 const dates={GB:'2025-01-05',US:'2025-02-05',AU:'2025-03-05'};
 const data=countries=>({results:countries.map(iso=>({iso_3166_1:iso,release_dates:[{type:4,release_date:dates[iso]}]}))});
 const configured=setup(t,{data:data(['GB','US','AU'])});configured.api.displayReleaseDate('movie',configured.container);await configured.settle();
 assert.match(configured.container.querySelector('.je-release-date-digital').textContent,/Mar/);
 const fallback=setup(t,{data:data(['GB','US'])});fallback.api.displayReleaseDate('movie',fallback.container);await fallback.settle();
 assert.match(fallback.container.querySelector('.je-release-date-digital').textContent,/Feb/);
});
test('episode premiere date bypasses external TMDB request',async t=>{
 const h=setup(t,{getItem:async(_user,id)=>id==='series'?{Type:'Series',ProviderIds:{Tmdb:'42'}}:{Type:'Episode',SeriesId:'series',PremiereDate:'2025-02-03T00:00:00Z'}});h.api.displayReleaseDate('episode',h.container);await h.settle();assert.equal(h.container.children.length,1);assert.equal(h.counts().fetchCalls,0);
});
test('missing metadata produces no placeholder or external request',async t=>{
 const h=setup(t,{item:{Type:'Movie'}});h.api.displayReleaseDate('movie',h.container);await h.settle();assert.equal(h.container.children.length,0);assert.equal(h.counts().fetchCalls,0);
});
test('release-date network failure removes placeholder and logs expected diagnostic',async t=>{
 const h=setup(t,{fetch:async()=>jsonResponse({},503)});h.expectConsoleError(/TMDB request failed/);h.api.displayReleaseDate('movie',h.container);await h.settle();assert.equal(h.container.children.length,0);
});
test('release response arriving after navigation does not recreate removed chips',async t=>{
 const response=deferred();const h=setup(t,{fetch:()=>response.promise});h.api.displayReleaseDate('movie',h.container);await Promise.resolve();
 const placeholder=h.container.querySelector('.mediaInfoItem-releaseDate');assert.ok(placeholder);h.container.replaceChildren();
 response.resolve(jsonResponse({results:[{iso_3166_1:'US',release_dates:[{type:3,release_date:'2025-01-01'}]}]}));await h.settle();
 assert.equal(h.container.children.length,0);assert.equal(placeholder.childNodes.length,0);assert.equal(placeholder.textContent,'');
});
test('calendar dates show the same day west of UTC',async t=>{
 // Runners pin TZ=UTC; switch this process to a zone behind UTC for the duration of the test.
 const previous=process.env.TZ;process.env.TZ='America/Los_Angeles';
 t.after(()=>{if(previous===undefined)delete process.env.TZ;else process.env.TZ=previous;});
 assert.ok(new Date(2025,1,1).getTimezoneOffset()>0);
 const h=setup(t,{data:{results:[{iso_3166_1:'AU',release_dates:[{type:3,release_date:'2025-02-01T00:00:00.000Z'},{type:4,release_date:'2025-03-01'}]}]}});
 h.api.displayReleaseDate('movie',h.container);await h.settle();
 const format=(year,month,day)=>new Date(year,month-1,day).toLocaleDateString(undefined,{year:'numeric',month:'short',day:'numeric'});
 assert.equal(h.container.querySelector('.je-release-date-cinema').textContent.slice('local_movies'.length),format(2025,2,1));
 assert.equal(h.container.querySelector('.je-release-date-digital').textContent.slice('ondemand_video'.length),format(2025,3,1));
 const episode=setup(t,{getItem:async(_user,id)=>id==='series'?{Type:'Series',ProviderIds:{Tmdb:'42'}}:{Type:'Episode',SeriesId:'series',PremiereDate:'2025-02-03T00:00:00.0000000Z'}});
 episode.api.displayReleaseDate('episode',episode.container);await episode.settle();
 assert.equal(episode.container.textContent.slice('tv_guide'.length),format(2025,2,3));
});
test('season chip picks the episode airing today by the local date west of UTC',async t=>{
 const previous=process.env.TZ;process.env.TZ='America/Los_Angeles';
 t.after(()=>{if(previous===undefined)delete process.env.TZ;else process.env.TZ=previous;});
 const episodes=[{air_date:'2025-03-03'},{air_date:'2025-03-10'},{air_date:'2025-03-17'}];
 // Real Season DTOs carry SeriesId (not the series' provider ids): the series is looked up.
 const h=setup(t,{getItem:async(_user,id)=>id==='series'?{Type:'Series',ProviderIds:{Tmdb:'42'}}:{Type:'Season',IndexNumber:1,SeriesId:'series'},data:{episodes}});
 // 20:00 on 10 March in Los Angeles is already 11 March in UTC.
 const RealDate=h.window.Date,now=new RealDate(2025,2,10,20).getTime();assert.equal(new RealDate(now).toISOString().slice(0,10),'2025-03-11');
 h.window.Date=class extends RealDate{constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}};
 h.api.displayReleaseDate('season',h.container);await h.settle();
 const format=(year,month,day)=>new RealDate(year,month-1,day).toLocaleDateString(undefined,{year:'numeric',month:'short',day:'numeric'});
 assert.equal(h.container.textContent.slice('tv_guide'.length),format(2025,3,10));
});
test('malformed external release date cannot inject HTML into details',async t=>{
 const malicious='<img src=x onerror="alert(1)">';const h=setup(t,{data:{results:[{iso_3166_1:'US',release_dates:[{type:3,release_date:malicious}]}]}});h.api.displayReleaseDate('movie',h.container);await h.settle();assert.equal(h.container.querySelector('img'),null);assert.ok(h.container.textContent.includes(malicious));
});
// Details-visit prefetch (features-details-page.js starts it once the item is known).
const movie={Type:'Movie',ProviderIds:{Tmdb:'42'}};
const releases={results:[{iso_3166_1:'AU',release_dates:[{type:3,release_date:'2025-03-01'},{type:4,release_date:'2025-04-01'}]}]};
/** A limiter stub recording each prefetch's signal; `gate` holds a slot until resolved. */
function limiter(gate){const signals=[];return {signals,manager:{withConcurrencyLimit:async(fn,options)=>{signals.push(options.signal);if(gate)await gate;if(options.signal.aborted)throw Object.assign(new Error('Request aborted'),{name:'AbortError'});return fn();}}};}
function sessionStub(){let epoch=0;const handlers=[];return {session:{getEpoch:()=>epoch,isCurrent:e=>e===epoch,onUserChange:(key,fn)=>handlers.push(fn)},switchUser(){epoch++;for(const fn of handlers)fn();}};}
test('a chip takes over the release prefetch: one TMDB request through the limiter, the same chips',async t=>{
 const without=setup(t,{data:releases});without.api.displayReleaseDate('movie',without.container);await without.settle();
 const {signals,manager}=limiter();const h=setup(t,{data:releases,JE:{core:{api:{manager}}}});const visit={};
 h.api.prefetchReleaseDate('movie',movie,visit);await h.settle();assert.equal(signals.length,1);assert.equal(h.counts().fetchCalls,1);
 h.api.displayReleaseDate('movie',h.container);await h.settle();
 assert.equal(h.counts().fetchCalls,1);assert.equal(h.counts().itemCalls,0,'the visit already had the item');assert.equal(h.container.innerHTML,without.container.innerHTML);
 h.api.discardReleasePrefetch(visit);assert.equal(signals[0].aborted,false);
 for(const run of [without,h]){run.container.replaceChildren();run.api.displayReleaseDate('movie',run.container);}
 assert.equal(h.container.innerHTML,without.container.innerHTML,'the answer was cached as before');assert.equal(h.counts().fetchCalls,1);
});
test('a prefetch that never ran is never shown: the chip looks up itself, with the same chips',async t=>{
 const without=setup(t,{data:releases});without.api.displayReleaseDate('movie',without.container);await without.settle();
 const manager={withConcurrencyLimit:async()=>{throw new Error('Request queue full - too many pending requests');}};
 const h=setup(t,{data:releases,JE:{core:{api:{manager}}}});h.api.prefetchReleaseDate('movie',movie,{});h.api.displayReleaseDate('movie',h.container);await h.settle();
 assert.deepEqual(h.counts(),{itemCalls:1,fetchCalls:1});assert.equal(h.container.innerHTML,without.container.innerHTML);
});
test('a prefetch after the chip has started its own lookup joins it',async t=>{
 const response=deferred();const h=setup(t,{fetch:()=>response.promise});h.api.displayReleaseDate('movie',h.container);await h.settle();
 h.api.prefetchReleaseDate('movie',movie,{});response.resolve(jsonResponse(releases));await h.settle();
 assert.deepEqual(h.counts(),{itemCalls:1,fetchCalls:1});assert.equal(h.container.querySelectorAll('.mediaInfoItem-releaseDate').length,2);
 h.api.prefetchReleaseDate('movie',movie,{});assert.equal(h.counts().fetchCalls,1,'a cached answer needs no prefetch');
});
test('a visit drops its unused release prefetch (aborted while queued); the next chip looks up again',async t=>{
 const gate=deferred();const {signals,manager}=limiter(gate.promise);const h=setup(t,{data:releases,JE:{core:{api:{manager}}}});const visit={};
 h.api.prefetchReleaseDate('movie',movie,visit);h.api.discardReleasePrefetch(visit);assert.equal(signals[0].aborted,true);gate.resolve();
 h.api.displayReleaseDate('movie',h.container);await h.settle();assert.deepEqual(h.counts(),{itemCalls:1,fetchCalls:1});
 const done=setup(t,{data:releases,JE:{core:{api:limiter()}}});done.api.prefetchReleaseDate('movie',movie,visit);await done.settle();done.api.discardReleasePrefetch(visit);
 done.api.displayReleaseDate('movie',done.container);await done.settle();assert.deepEqual(done.counts(),{itemCalls:1,fetchCalls:2});
});
test('a user switch drops the unclaimed release prefetches',async t=>{
 const gate=deferred();const {signals,manager}=limiter(gate.promise);const {session,switchUser}=sessionStub();
 const h=setup(t,{data:releases,JE:{core:{api:{manager}},session}});h.api.prefetchReleaseDate('movie',movie,{});switchUser();assert.equal(signals[0].aborted,true);gate.resolve();
 h.api.displayReleaseDate('movie',h.container);await h.settle();assert.deepEqual(h.counts(),{itemCalls:1,fetchCalls:1});assert.equal(h.container.querySelectorAll('.mediaInfoItem-releaseDate').length,2);
});
test('an episode prefetch looks up the series once and asks TMDB nothing, as before',async t=>{
 const episode={Type:'Episode',SeriesId:'series',PremiereDate:'2025-02-03T00:00:00Z'};const lookups=[];
 const h=setup(t,{getItem:async(_user,id)=>{lookups.push(id);return id==='series'?{Type:'Series',ProviderIds:{Tmdb:'42'}}:episode;},JE:{core:{api:limiter()}}});
 h.api.prefetchReleaseDate('episode',episode,{});h.api.displayReleaseDate('episode',h.container);await h.settle();
 assert.deepEqual(lookups,['series']);assert.equal(h.counts().fetchCalls,0);assert.equal(h.container.querySelectorAll('.je-release-date-episode').length,1);
});
test('a TMDB failure in the prefetch still removes the placeholder',async t=>{
 const h=setup(t,{fetch:async()=>jsonResponse({},503),JE:{core:{api:limiter()}}});h.expectConsoleError(/TMDB request failed/);
 h.api.prefetchReleaseDate('movie',movie,{});h.api.displayReleaseDate('movie',h.container);await h.settle();
 assert.equal(h.container.children.length,0);assert.equal(h.counts().fetchCalls,1);
});
test('an expired answer is looked up again: a finished lookup is not kept for the next prefetch or chip',async t=>{
 const h=setup(t,{data:releases,JE:{core:{api:limiter()}}});const RealDate=h.window.Date;let now=RealDate.now();
 h.window.Date=class extends RealDate{constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}};
 h.api.displayReleaseDate('movie',h.container);await h.settle();assert.equal(h.counts().fetchCalls,1);
 now+=2*60*60*1000;h.container.replaceChildren();h.api.displayReleaseDate('movie',h.container);await h.settle();assert.equal(h.counts().fetchCalls,2);
 now+=2*60*60*1000;h.api.prefetchReleaseDate('movie',movie,{});await h.settle();assert.equal(h.counts().fetchCalls,3);
});
