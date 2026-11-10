import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate as turn} from 'node:timers/promises';
import {createHarness,deferred,jsonResponse} from '../../helpers/harness.mjs';
const flush=async()=>{for(let i=0;i<8;i++)await turn();};
const load=(h,path)=>h.load(path);
function elsewhere(t,{before=false,catalog='US\tUnited States\nGB\tUnited Kingdom',region='GB'}={}){
 const idle=[],saved=[],pending=deferred();
 const h=createHarness({url:'http://jellyfin.test/web/index.html#!/details?id=one',html:'<div id="itemDetailPage"><div class="detailSectionContent"><div class="itemExternalLinks"><a href="https://www.themoviedb.org/movie/7">TMDB</a></div></div></div>',
 apiClient:{getItem:async()=>null,ajax:async()=>h.JE.userConfig.elsewhere},
 fetch:async url=>String(url).endsWith('regions.txt')?(catalog===null?pending.promise:new Response(catalog)):new Response('Netflix'),globals:{requestIdleCallback:fn=>idle.push(fn)},
 JE:{pluginConfig:{ElsewhereEnabled:true,TmdbEnabled:true,DEFAULT_REGION:'US'},userConfig:{elsewhere:{Region:region,Regions:[],Services:[],SeasonProviders:true}},saveUserSettings:async(f,d)=>saved.push(JSON.parse(JSON.stringify(d))),cdn:{url:(s,f)=>`/cdn/${s}/${f}`},t:k=>k,helpers:{createObserver(){},onViewPage(){}},core:{api:{fetch:async()=>({results:{GB:{flatrate:[{provider_name:'Netflix',logo_path:'/n.png'}]}}})}}}});
 t.after(()=>h.close());load(h,'elsewhere/elsewhere.js',before);h.JE.initializeElsewhereScript();
 return {...h,saved,async ready(){await flush();while(idle.length){idle.shift()();await flush();}},async open(){h.document.querySelector('.elsewhere-settings-button').click();await flush();}};
}
for(const before of [false])for(const scenario of ['pending catalog','missing saved country'])test(`R3 regression ${before?'exact baseline':'current'}: ${scenario} preserves saved Region`,async t=>{
 const h=elsewhere(t,{before,catalog:scenario==='pending catalog'?null:'US\tUnited States',region:'GB'});await h.ready();await h.open();
 const select=h.document.querySelector('#region-select');assert.ok(select);assert.equal(select.value,'GB');h.document.querySelector('#save-settings').click();await flush();
 assert.equal(h.saved[0].Region,'GB');console.log(JSON.stringify({before,scenario,saved:h.saved[0]}));
});
for(const before of [false])test(`R3 regression ${before?'exact baseline':'current'}: account change before queued frame retires release chip`,async t=>{
 let epoch=0;const handlers=[],frames=[];
 const h=createHarness({html:'<div id="info"></div>',apiClient:{getItem:async()=>({Type:'Movie',ProviderIds:{Tmdb:'7'}})},fetch:async()=>jsonResponse({results:[{iso_3166_1:'US',release_dates:[{type:4,release_date:'2025-04-01'}]}]}),globals:{requestAnimationFrame:fn=>{frames.push(fn);return 1;}},JE:{pluginConfig:{DEFAULT_REGION:'US'},session:{getEpoch:()=>epoch,isCurrent:e=>epoch===e,onUserChange:(_n,fn)=>handlers.push(fn)},helpers:{addCSS(){}},t:k=>k}});
 t.after(()=>h.close());load(h,'enhanced/itemdetails/features-release-dates.js',before);
 const container=h.document.getElementById('info');h.JE.internals.features.displayReleaseDate('one',container);await flush();assert.equal(frames.length,1);epoch++;handlers.forEach(fn=>fn());frames.shift()();await flush();
 assert.equal(container.querySelector('.mediaInfoItem-releaseDate'),null);
});
for(const before of [false])test(`R3 regression ${before?'exact baseline':'current'}: unknown revisit metadata hides retained reviews`,async t=>{
 let hook,missing=false,hide=false,scopeCalls=0;
 const h=createHarness({url:'http://jellyfin.test/web/index.html#!/details?id=one',html:'<div id="itemDetailPage"><div class="mediaInfoItems"></div><div class="tagline"></div></div>',apiClient:{getItem:async()=>missing?null:{Id:'one',Type:'Movie',ProviderIds:{Tmdb:'7'}},getCurrentUser:async()=>({Id:'user-a'})},JE:{pluginConfig:{ShowUserReviews:true,SpoilerBlurEnabled:true},escapeHtml:v=>String(v).replace(/[&<>"']/g,c=>`&#${c.charCodeAt(0)};`),t:k=>k,icon:()=>'',IconName:{STAR:'star'},cdn:{url:()=>''},helpers:{onViewPage:fn=>{hook=fn;}},spoilerBlur:{whenLoaded:async()=>{},isLoadOk:()=>true,getUserPrefs:()=>({HideReviews:hide}),isMovieInScope:async()=>{scopeCalls++;return true;}},core:{api:{plugin:async()=>({reviews:[{userId:'x',userName:'X',content:'spoiler text',rating:5}]})}}}});
 t.after(()=>h.close());h.window.setTimeout=fn=>{queueMicrotask(fn);return 1;};load(h,'elsewhere/reviews.js',before);h.JE.initializeReviewsScript();await hook(null,h.document.querySelector('#itemDetailPage'),h.window.location.hash);await flush();assert.match(h.document.body.textContent,/spoiler text/);
 hide=true;missing=true;await hook(null,h.document.querySelector('#itemDetailPage'),h.window.location.hash);await flush();assert.doesNotMatch(h.document.body.textContent,/spoiler text/);assert.equal(h.document.querySelector('.je-avg-user-rating-chip'),null);assert.equal(scopeCalls,0);
});
function sess(){let epoch=0;const callbacks=[];return {session:{getEpoch:()=>epoch,isCurrent:e=>e===epoch,onUserChange:(_n,f)=>callbacks.push(f)},change(){epoch++;callbacks.forEach(f=>f());}};}
test('BLIND-DP-001: retained release row fetches incoming account data',async()=>{
const s=sess();let user='a',calls=0;
const h=createHarness({html:'<div id="itemDetailPage"><div id="row"></div></div>',url:'http://jellyfin.test/web/index.html#!/details?id=one',apiClient:{getCurrentUserId:()=>user,getItem:async()=>({Id:'one',Type:'Series',ProviderIds:{Tmdb:'7'}})},fetch:async()=>{calls++;return jsonResponse({next_episode_to_air:{air_date:user==='a'?'2026-11-08':'2026-12-09'}});},JE:{session:s.session,t:k=>k,helpers:{addCSS(){}},internals:{}}});
h.window.requestAnimationFrame=f=>{queueMicrotask(f);return 1;};load(h,'enhanced/itemdetails/features-release-dates.js',false);
const row=h.document.querySelector('#row');await h.JE.internals.features.displayReleaseDate('one',row);await flush();const before=row.textContent;
user='b';s.change();await h.JE.internals.features.displayReleaseDate('one',row);await flush();
assert.equal(calls,2);assert.notEqual(row.textContent,before);h.close();
});
for(const malformed of ['unreadable',null,{},[1,'bad'],[null]])test('BLIND-DP-002: malformed trigger document cannot save '+JSON.stringify(malformed),async()=>{
const saved=[];let hook;
const h=createHarness({html:'<div id="itemDetailPage"><div class="tagline"></div></div>',url:'http://jellyfin.test/web/index.html#!/details?id=one',apiClient:{getItem:async()=>({Id:'one',Type:'Movie',ProviderIds:{Tmdb:'7'}}),ajax:async()=>({Triggers:malformed})},JE:{pluginConfig:{DoesTheDogDieEnabled:true},t:k=>k,saveUserSettings:async(f,d)=>saved.push([f,JSON.parse(JSON.stringify(d))]),helpers:{onViewPage:f=>{hook=f;return()=>{};}},core:{ui:{skeletonGridHtml:()=>''},api:{manager:{clearCacheMatching(){}},plugin:async p=>p==='/ddd/topics'?{Topics:[{Id:1,Name:'dog dies',Category:'Animals',Group:'Content'}]}:{Found:true,Confirmed:true,ItemId:3,Topics:[{Id:1,Name:'dog dies',Yes:9,No:1}]}}}}});
h.window.setTimeout=f=>{queueMicrotask(f);return 1;};load(h,'others/doesthedogdie.js',false);h.JE.initializeDoesTheDogDieScript();await hook(null,h.document.querySelector('#itemDetailPage'),h.window.location.hash);await flush();h.document.querySelector('.je-ddd-gear').click();await flush();const save=h.document.querySelector('.je-ddd-save');assert.equal(save.disabled,true);save.click();await flush();assert.deepEqual(saved,[]);h.close();
});
test('BLIND-DP-003: queued removed-section toggle cannot save the incoming account',async()=>{
const s=sess();let user='a',hook;const saves=[];
const h=createHarness({html:'<div id="itemDetailPage"><div class="tagline"></div></div>',url:'http://jellyfin.test/web/index.html#!/details?id=one',apiClient:{getCurrentUserId:()=>user,getCurrentUser:async()=>({Id:user}),getItem:async()=>({Id:'one',Type:'Movie',ProviderIds:{Tmdb:'7'}})},JE:{session:s.session,pluginConfig:{ShowUserReviews:true},currentSettings:{reviewsExpandedByDefault:false},t:k=>k,escapeHtml:value=>String(value),saveUserSettings:(f,d)=>saves.push({user,file:f,value:d.reviewsExpandedByDefault}),helpers:{onViewPage:f=>{hook=f;return()=>{};}},core:{api:{plugin:async()=>({reviews:[]})}}}});
h.window.setTimeout=f=>{queueMicrotask(f);return 1;};load(h,'elsewhere/reviews.js',false);h.JE.initializeReviewsScript();await hook(null,h.document.querySelector('#itemDetailPage'),h.window.location.hash);await flush();const section=h.document.querySelector('.tmdb-reviews-section');section.open=true;user='b';h.JE.currentSettings={reviewsExpandedByDefault:false};s.change();await new Promise(r=>setTimeout(r,15));assert.deepEqual(saves,[]);assert.equal(h.JE.currentSettings.reviewsExpandedByDefault,false);h.close();
});
