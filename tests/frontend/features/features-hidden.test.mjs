import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHarness,deferred} from '../helpers/harness.mjs';
function setup(t,{items={},settings={},html='',ajax=async()=>({Items:[]})}={}){
 let epoch=0; const handlers=new Map();const frames=[];
 const h=createHarness({html,apiClient:{ajax},globals:{requestAnimationFrame:fn=>frames.push(fn)},JE:{userConfig:{hiddenContent:{items,settings}},session:{getEpoch:()=>epoch,isCurrent:e=>e===epoch,onUserChange:(key,fn)=>handlers.set(key,fn)}}});
 t.after(()=>h.close());
 h.load('enhanced/hiddencontent/hidden-content-data.js');h.load('enhanced/hiddencontent/hidden-content-filter.js');
 const api=h.JE.internals.hiddenContent;api.resetFromUserConfig();
 return {...h,api,flush(){while(frames.length)frames.shift()();},switchUser(){epoch++;h.JE.userConfig={hiddenContent:{items:{},settings:{}}};for(const fn of handlers.values())fn({userId:'next'});}};
}
test('hidden scope filters home rows without hiding same title in the library',t=>{
 const h=setup(t,{items:{global:{itemId:'AA-BB'},next:{itemId:'CC-DD',hideScope:'nextup'}},html:'<div class="card" data-id="AABB"></div><div class="section"><h2>Next Up</h2><div class="card" data-id="ccdd"></div></div><div class="card" data-itemid="ccdd"></div>'});
 h.api.filterNativeCards();h.flush();const cards=h.document.querySelectorAll('.card');
 assert.equal(cards[0].classList.contains('je-hidden'),true);
 assert.equal(cards[1].classList.contains('je-hidden'),true);
 assert.equal(cards[2].classList.contains('je-hidden'),false);
 h.api.restoreNativeCardsForIds(new Set(['AA-BB']));
 assert.equal(cards[0].classList.contains('je-hidden'),false);
});
test('home-section scopes merge without weakening an existing global hide',t=>{
 const h=setup(t,{items:{a:{itemId:'a',hideScope:'nextup'},b:{itemId:'b',hideScope:'global'}}});
 h.api.markScopedHidden('a','continuewatching');h.api.markScopedHidden('b','nextup');
 assert.equal(h.api.isHiddenOnSurface('a','nextup'),true);
 assert.equal(h.api.isHiddenOnSurface('a','continuewatching'),true);
 assert.equal(h.api.isHiddenOnSurface('a','library'),false);
 assert.equal(h.api.isHiddenOnSurface('b','library'),true);
});
test('disabled filtering and search default preserve cards; image-editor cards are ignored',t=>{
 const h=setup(t,{items:{a:{itemId:'a'}},html:'<div class="card" data-id="a"></div><div class="card" data-id="a" data-imagetype="Primary"></div>'});
 h.window.location.hash='!/search';h.api.filterNativeCards();h.flush();assert.equal(h.document.querySelectorAll('.je-hidden').length,0);
 h.window.location.hash='!/home';h.api.filterNativeCards();h.flush();assert.equal(h.document.querySelectorAll('.je-hidden').length,1);
 h.api.getHiddenData().settings.enabled=false;h.api.refreshNativeCardVisibility();h.flush();assert.equal(h.document.querySelectorAll('.je-hidden').length,0);
});
test('hidden requests/calendar normalize IDs and respect surface settings',t=>{
 const h=setup(t,{items:{a:{itemId:'AA-BB',tmdbId:42,type:'Series',name:'Show (US)'},scoped:{itemId:'scoped',tmdbId:55,hideScope:'nextup'}}});
 assert.deepEqual(Array.from(h.api.filterRequestItems([{tmdbId:42,type:'Series'},{jellyfinMediaId:'AA-BB'},{tmdbId:55}]),x=>x.tmdbId),[55]);
 assert.equal(h.api.filterCalendarEvents([{title:'Show'},{title:'Visible'},{itemId:'AA-BB'}]).length,1);
 h.api.getHiddenData().settings.filterRequests=false;
 assert.equal(h.api.filterRequestItems([{tmdbId:42,type:'Series'}]).length,1);
 h.api.getHiddenData().settings.filterCalendar=false;
 assert.equal(h.api.filterCalendarEvents([{title:'Show'},{tmdbId:42,type:'Series'},{itemId:'AA-BB'}]).length,3);
});
test('switching users clears previous hidden DOM marks and cached policy',t=>{
 const h=setup(t,{items:{a:{itemId:'a',tmdbId:42,type:'Series'}},html:'<div class="card" data-id="a"></div>'});
 h.api.filterNativeCards();h.flush();assert.equal(h.api.getHiddenCount(),1);assert.equal(h.api.filterRequestItems([{tmdbId:42,type:'Series'}]).length,0);
 h.switchUser();
 const card=h.document.querySelector('.card');assert.equal(card.classList.contains('je-hidden'),false);assert.equal(card.hasAttribute('data-je-hidden-checked'),false);assert.equal(h.api.hiddenIdSet.size,0);
 // The incoming user sees none of the previous user's hidden IDs, TMDB IDs or items.
 assert.equal(h.api.filterRequestItems([{tmdbId:42,type:'Series'}]).length,1);assert.equal(h.api.getHiddenCount(),0);assert.equal(h.api.isHiddenOnSurface('a','library'),false);
});
test('old-user hidden-content refresh cannot overwrite incoming preferences',async t=>{
 const pending=deferred();const h=setup(t,{ajax:()=>pending.promise});
 const refresh=h.api.refresh();h.switchUser();pending.resolve({items:{secret:{itemId:'secret'}},settings:{}});await refresh;
 assert.equal(h.api.hiddenIdSet.size,0);assert.equal(Object.keys(h.JE.userConfig.hiddenContent.items).length,0);
});
test('parent-series API IDs are normalized before cascading hidden policy',async t=>{
 const response=deferred();const h=setup(t,{items:{series:{itemId:'AA-BB'}},html:'<div class="card" data-id="CC-DD" data-type="Episode"></div>',ajax:()=>response.promise});
 h.api.filterNativeCards();response.resolve({Items:[{Id:'CC-DD',SeriesId:'AA-BB'}]});await response.promise;await new Promise(resolve=>setImmediate(resolve));h.flush();
 assert.equal(h.document.querySelector('.card').classList.contains('je-hidden'),true);
});
test('parent-series response after disabling filtering cannot hide cards',async t=>{
 const response=deferred();const h=setup(t,{items:{series:{itemId:'series'}},html:'<div class="card" data-id="episode" data-type="Episode"></div>',ajax:()=>response.promise});
 h.api.filterNativeCards();h.api.getHiddenData().settings.enabled=false;response.resolve({Items:[{Id:'episode',SeriesId:'series'}]});await response.promise;await new Promise(resolve=>setImmediate(resolve));h.flush();
 assert.equal(h.document.querySelector('.card').classList.contains('je-hidden'),false);
});
test('absent title cards save only typed provider identity and report failed saves honestly',async t=>{
 const SYN='4a45ad11000a938e00000000f9c67720';
 const writes=[];let fail=false;
 const h=createHarness({apiClient:{getCurrentUserId:()=> 'viewer',getUrl:p=>p,ajax:async o=>{writes.push(o);if(fail)throw new Error('offline');return {success:true};}},
  JE:{t:k=>k,titleDetails:{parse:id=>id===SYN?{kind:'movie',tmdbId:42}:null,isSynthetic:id=>id===SYN},userConfig:{hiddenContent:{items:{},settings:{enabled:true,showHideButtons:true,showButtonJellyseerr:true}}}}});
 t.after(()=>h.close());h.load('enhanced/hiddencontent/hidden-content-data.js');
 const api=h.JE.internals.hiddenContent;api.resetFromUserConfig();Object.assign(api,{refreshNativeCardVisibility:()=>{},showUndoToast:()=>{}});
 const btn=api.buildTitleControl({itemId:SYN,name:'Absent'});h.document.body.appendChild(btn);
 await btn.onclick({preventDefault(){},stopPropagation(){}});
 assert.deepEqual(Object.keys(api.getHiddenData().items),['movie:tmdb:42']);
 assert.equal(JSON.parse(writes[0].data).itemId,'');assert.equal(JSON.stringify(writes).includes(SYN),false);
 assert.equal(btn.getAttribute('aria-label'),'hidden_content_unhide');
 await api.unhideItem('movie:tmdb:42');assert.deepEqual(Object.keys(api.getHiddenData().items),[]);
 fail=true;await btn.onclick({preventDefault(){},stopPropagation(){}});
 assert.deepEqual(Object.keys(api.getHiddenData().items),[]);assert.equal(btn.textContent,'hidden_content_save_failed_persistent');
});
test('the hidden content page takes over when Jellyfin answers its own #/hidden-content route with another page',t=>{
 const h=createHarness({html:'<div class="mainAnimatedPages"><div id="home" class="mainAnimatedPage">home</div></div>',JE:{t:k=>k,pluginConfig:{HiddenContentEnabled:true},hiddenContent:{},helpers:{onSidebarRebuilt:()=>()=>{}}}});
 t.after(()=>h.close());
 h.load('enhanced/hiddencontent/hidden-content-page-state.js');
 Object.assign(h.JE.internals.hiddenContentPage,{injectStyles:()=>{},renderPage:()=>{}});
 h.load('enhanced/hiddencontent/hidden-content-page-nav.js');h.load('enhanced/hiddencontent/hidden-content-page-init.js');
 h.JE.hiddenContentPage.initialize();
 const show=el=>el.dispatchEvent(new h.window.CustomEvent('viewshow',{bubbles:true}));
 // A hash change to #/hidden-content inside the app: Jellyfin's router shows its own "Page not found" page.
 const home=h.document.getElementById('home');h.window.history.replaceState(null,'','#/hidden-content');
 const notFound=h.document.createElement('div');notFound.className='mainAnimatedPage';notFound.textContent='Page not found';
 home.after(notFound);home.classList.add('hide');show(notFound);
 const page=h.document.getElementById('je-hidden-content-page');
 assert.ok(page&&!page.classList.contains('hide'),'the hidden content page shows');assert.ok(notFound.classList.contains('hide'));
 // The router showing its page again on the same route is hidden again; ours stays.
 notFound.classList.remove('hide');show(notFound);
 assert.ok(notFound.classList.contains('hide'));assert.equal(page.classList.contains('hide'),false);
 // Another route's page still hides it as before.
 h.window.history.replaceState(null,'','#/home');home.classList.remove('hide');show(home);
 assert.ok(page.classList.contains('hide'));
});

test('provider hides distinguish movie from TV and never guess an ambiguous legacy type',t=>{
 const h=setup(t,{items:{'movie:tmdb:42':{type:'Movie',tmdbId:'42'},'tmdb-51':{tmdbId:'51'}}});
 const rows=[{id:42,mediaType:'movie'},{id:42,mediaType:'tv'},{id:51,mediaType:'tv'}];
 assert.deepEqual(Array.from(h.api.filterJellyseerrResults(rows,'discovery'),x=>x.mediaType),['tv','tv']);
});
test('shared card host mounts typed controls without lookup and repairs a cloned control',t=>{
 const h=setup(t,{html:'<div data-je-hide-title="tv:tmdb:42" data-je-hide-name="Show" data-je-hide-surface="discovery"></div>',settings:{enabled:true,showHideButtons:true,showButtonJellyseerr:true}});
 h.JE.t=k=>k;h.load('enhanced/hiddencontent/hidden-content-buttons.js');
 h.api.addLibraryHideButtons();const root=h.document.querySelector('[data-je-hide-title]');
 assert.equal(root.querySelectorAll('.je-hide-btn').length,1);
 const copy=root.cloneNode(true);root.replaceWith(copy);h.api.addLibraryHideButtons();
 assert.equal(copy.querySelectorAll('.je-hide-btn').length,1);assert.equal(copy.querySelector('.je-hide-btn').jeHideButtonLive,true);
});

test('a shared card control evaluates its mounted surface and preserves that filter setting',async t=>{
 const h=setup(t,{html:'<div class="jellyseerr-card"></div>',settings:{enabled:true,showHideButtons:true,filterDiscovery:true,filterRecommendations:false}});
 h.JE.t=k=>k;Object.assign(h.api,{showUndoToast:()=>{}});
 const root=h.document.querySelector('.jellyseerr-card');
 const button=h.api.buildTitleControl({mediaType:'movie',tmdbId:42,name:'Film'},{surface:()=> 'discovery'});root.appendChild(button);
 await button.onclick({preventDefault(){},stopPropagation(){}});h.flush();
 assert.equal(root.classList.contains('je-hidden'),true);
 await h.api.unhideItem('movie:tmdb:42');h.flush();
 h.api.getHiddenData().settings.filterDiscovery=false;
 await button.onclick({preventDefault(){},stopPropagation(){}});h.flush();
 assert.equal(root.classList.contains('je-hidden'),false);
});

for (const library of [true,false]) test(`native recommendation cards use their own surface in both passes and control mounting (library=${library})`,async t=>{
 const h=setup(t,{html:'<div id="itemDetailPage"><div id="similarCollapsible"><div class="card" data-id="synthetic" data-type="Movie"><div class="cardBox"></div></div></div></div>',items:{'movie:tmdb:42':{type:'Movie',tmdbId:'42'}},settings:{filterLibrary:library,filterRecommendations:!library,enabled:true,showHideButtons:true,showButtonJellyseerr:true}});
 h.window.location.hash='#/details?id=parent';h.JE.t=k=>k;
 h.JE.titleDetails={parse:id=>id==='synthetic'?{kind:'movie',tmdbId:42}:null,isSynthetic:id=>id==='synthetic'};
 const card=h.document.querySelector('.card');
 h.api.filterNativeCards();h.flush();assert.equal(card.classList.contains('je-hidden'),!library);
 h.api.filterAllNativeCards();h.flush();assert.equal(card.classList.contains('je-hidden'),!library);
 h.load('enhanced/hiddencontent/hidden-content-buttons.js');h.api.addLibraryHideButtons();
 Object.assign(h.api,{showUndoToast:()=>{}});await h.api.unhideItem('movie:tmdb:42');h.flush();
 await card.querySelector('.je-hide-btn').onclick({preventDefault(){},stopPropagation(){}});h.flush();
 assert.equal(card.classList.contains('je-hidden'),!library);
});
test('failed provider Undo keeps translated failure and retry control until confirmed',async t=>{
 let fail=true;const h=setup(t,{ajax:async()=>{if(fail)throw new Error('rejected');return {success:true};},items:{'movie:tmdb:42':{type:'Movie',tmdbId:'42'}}});
 h.JE.t=k=>k;h.load('enhanced/hiddencontent/hidden-content-dialogs.js');h.api.showUndoToast('Film','movie:tmdb:42');
 const button=h.document.querySelector('.je-undo-btn');button.click();await new Promise(r=>setImmediate(r));
 assert.equal(h.document.querySelector('.je-undo-toast-text').textContent,'hidden_content_save_failed_persistent');
 assert.equal(button.disabled,false);assert.equal(h.api.isHiddenByTmdbId(42,'movie'),true);
 fail=false;button.click();await new Promise(r=>setImmediate(r));assert.equal(h.api.isHiddenByTmdbId(42,'movie'),false);
});
test('bulk save and atomic rule share acknowledgement ordering',async t=>{
 const bulk=deferred(),put=deferred();const requests=[];
 const h=setup(t,{ajax:o=>{requests.push(o);return o.type==='POST'?bulk.promise:put.promise;}});
 h.JE.t=k=>k;h.load('enhanced/hiddencontent/hidden-content-save.js');Object.assign(h.api,{showUndoToast:()=>{}});
 h.api.debouncedSave();const saving=h.api.flushPendingSave();await new Promise(r=>setImmediate(r));
 const hiding=h.api.saveTitleRule({mediaType:'movie',tmdbId:42,name:'Film'},true);await new Promise(r=>setImmediate(r));
 assert.equal(requests.filter(o=>o.type==='PUT').length,0,'rule must wait for pending bulk persistence');
 bulk.resolve({success:true});await saving;await new Promise(r=>setImmediate(r));
 assert.equal(requests.filter(o=>o.type==='PUT').length,1);put.resolve({success:true});assert.equal(await hiding,true);
 assert.equal(requests.find(o=>o.type==='POST').dataType,'json');assert.equal(requests.find(o=>o.type==='PUT').dataType,'json');
});

test('atomic acknowledgement refreshes its full rule base without losing newer local edits',async t=>{
 const put=deferred(),requests=[];const h=setup(t,{ajax:o=>{requests.push(o);return o.type==='PUT'?put.promise:Promise.resolve({success:true,revision:'bulk'});}});
 h.JE.t=k=>k;h.load('enhanced/hiddencontent/hidden-content-save.js');Object.assign(h.api,{showUndoToast:()=>{}});
 const hiding=h.api.saveTitleRule({type:'Movie',tmdbId:42,name:'Film'},true);await new Promise(r=>setImmediate(r));
 h.api.getHiddenData().items.local={itemId:'local',type:'Movie'};
 put.resolve({success:true,revision:'rules',items:{'movie:tmdb:42':{type:'Movie',tmdbId:'42'},'tv:tmdb:51':{type:'Series',tmdbId:'51'}}});await hiding;
 assert.equal(h.api.isHiddenByTmdbId(51,'tv'),true,'another tab rule accompanies the new base revision');
 assert.equal(h.api.getHiddenData().items.local.itemId,'local');
 h.api.updateSettings({filterSearch:true});await h.api.flushPendingSave();const body=JSON.parse(requests.find(o=>o.type==='POST').data);
 assert.ok(body.items['tv:tmdb:51']);assert.ok(body.items.local);assert.equal(body.revision,'rules');
});
