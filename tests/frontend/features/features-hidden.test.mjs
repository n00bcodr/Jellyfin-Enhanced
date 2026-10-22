import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHarness,deferred} from '../helpers/harness.mjs';
// Hidden Content keeps its document in the settings store (config.js): every change is an operation the server answers.
const patching=ajax=>async request=>request.type==='PATCH'?{success:true}:ajax(request);
function setup(t,{items={},settings={},html='',ajax=async()=>({Items:[]})}={}){
 let epoch=0; const handlers=new Map();const frames=[];
 const h=createHarness({html,apiClient:{ajax:patching(ajax)},globals:{requestAnimationFrame:fn=>frames.push(fn)},JE:{userConfig:{hiddenContent:{items,settings}},session:{getEpoch:()=>epoch,isCurrent:e=>e===epoch,onUserChange:(key,fn)=>handlers.set(key,fn)}}});
 t.after(()=>h.close());
 h.load('core/mutation-queue.js'); h.load('enhanced/config.js');h.load('enhanced/hiddencontent/hidden-content-data.js');h.load('enhanced/hiddencontent/hidden-content-save.js');h.load('enhanced/hiddencontent/hidden-content-filter.js');
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
 // Stage 1 fix round 12: a route's answer goes into the document it was sent for (the handle taken at the action).
 const doc=h.JE.internals.userDocumentHandle('hidden-content.json',h.JE.core.userWrite.origin());
 h.api.markScopedHidden('a','continuewatching',undefined,doc);h.api.markScopedHidden('b','nextup',undefined,doc);
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
 const h=setup(t,{items:{a:{itemId:'AA-BB',tmdbId:42,name:'Show (US)'},scoped:{itemId:'scoped',tmdbId:55,hideScope:'nextup'}}});
 assert.deepEqual(Array.from(h.api.filterRequestItems([{tmdbId:42},{jellyfinMediaId:'AA-BB'},{tmdbId:55}]),x=>x.tmdbId),[55]);
 assert.equal(h.api.filterCalendarEvents([{title:'Show'},{title:'Visible'},{itemId:'AA-BB'}]).length,1);
 h.api.getHiddenData().settings.filterRequests=false;
 assert.equal(h.api.filterRequestItems([{tmdbId:42}]).length,1);
 h.api.getHiddenData().settings.filterCalendar=false;
 assert.equal(h.api.filterCalendarEvents([{title:'Show'},{tmdbId:42},{itemId:'AA-BB'}]).length,3);
});
test('switching users clears previous hidden DOM marks and cached policy',t=>{
 const h=setup(t,{items:{a:{itemId:'a',tmdbId:42}},html:'<div class="card" data-id="a"></div>'});
 h.api.filterNativeCards();h.flush();assert.equal(h.api.getHiddenCount(),1);assert.equal(h.api.filterRequestItems([{tmdbId:42}]).length,0);
 h.switchUser();
 const card=h.document.querySelector('.card');assert.equal(card.classList.contains('je-hidden'),false);assert.equal(card.hasAttribute('data-je-hidden-checked'),false);assert.equal(h.api.hiddenIdSet.size,0);
 // The incoming user sees none of the previous user's hidden IDs, TMDB IDs or items.
 assert.equal(h.api.filterRequestItems([{tmdbId:42}]).length,1);assert.equal(h.api.getHiddenCount(),0);assert.equal(h.api.isHiddenOnSurface('a','library'),false);
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
test('titles that are not in the library (native details synthetic ids) never become Hidden Content rules',async t=>{
 const SYN='4a45ad11000a938e00000000f9c67720',REAL='0123456789abcdef0123456789abcdef';
 const html=`<div class="card" data-id="${SYN}" data-type="Movie"><div class="cardBox"></div></div><div class="card" data-id="${REAL}" data-type="Movie"><div class="cardBox"></div></div>`;
 let saves=0;
 const h=createHarness({html,apiClient:{ajax:async request=>{if(request.type==='PATCH')saves++;return {Items:[]};}},globals:{requestAnimationFrame:fn=>fn()},JE:{t:k=>k,titleDetails:{isSynthetic:id=>String(id).replace(/-/g,'').toLowerCase()===SYN},userConfig:{hiddenContent:{items:{},settings:{enabled:true,showHideButtons:true,showButtonLibrary:true}}}}});
 t.after(()=>h.close());
 h.load('core/mutation-queue.js'); h.load('enhanced/config.js');h.load('enhanced/hiddencontent/hidden-content-data.js');h.load('enhanced/hiddencontent/hidden-content-save.js');h.load('enhanced/hiddencontent/hidden-content-filter.js');h.load('enhanced/hiddencontent/hidden-content-buttons.js');
 const api=h.JE.internals.hiddenContent;api.resetFromUserConfig();
 Object.assign(api,{showUndoToast:()=>{}});
 api.addLibraryHideButtons();
 assert.equal(h.document.querySelector(`[data-id="${SYN}"] .je-hide-btn`),null);
 assert.ok(h.document.querySelector(`[data-id="${REAL}"] .je-hide-btn`));
 api.hideItem({itemId:SYN,name:'Dune: Part Two',type:'Movie'});
 api.hideItem({itemId:'',tmdbId:1,seriesId:SYN,name:'Episode',type:'Episode'});
 assert.deepEqual(Object.keys(api.getHiddenData().items),[]);
 assert.equal(saves,0);
 api.hideItem({itemId:REAL,name:'Real',type:'Movie'});
 assert.deepEqual(Object.keys(api.getHiddenData().items),[REAL]);
 await new Promise(r=>setTimeout(r,0));assert.equal(saves,1,'one item operation for the real title');
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
