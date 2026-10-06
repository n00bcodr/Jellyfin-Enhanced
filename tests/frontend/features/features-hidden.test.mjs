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
