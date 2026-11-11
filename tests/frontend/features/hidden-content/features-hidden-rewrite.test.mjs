import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHarness,deferred} from '../../helpers/harness.mjs';
const entries=JSON.parse(readFileSync(new URL('../../../../Jellyfin.Plugin.JellyfinEnhanced/js/component-scripts.json',import.meta.url)));
const owned=entries.filter(p=>typeof p==='string' && /^(enhanced\/hiddencontent\/|enhanced\/homeremoval\/)/.test(p));
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function setup(t,{items={},settings={},ajax=async()=>({success:true}),html=''}={}){
 let epoch=0,uid='user-a'; const resets=new Map(),frames=[];
 const h=createHarness({html,apiClient:{ajax,getCurrentUserId:()=>uid,getDisplayPreferences:async()=>({CustomPrefs:{}})},globals:{requestAnimationFrame:fn=>frames.push(fn)},JE:{
  userConfig:{hiddenContent:{items,settings}},pluginConfig:{HiddenContentEnabled:true},currentSettings:{removeContinueWatchingEnabled:true},state:{removeContext:null},
  session:{getEpoch:()=>epoch,isCurrent:e=>e===epoch,onUserChange:(name,fn)=>{resets.set(name,fn);return ()=>resets.delete(name);},userScopedKey:key=>key+':'+uid},
  t:key=>key,toast:()=>{},helpers:{isAdmin:()=>true,addCSS:()=>{},debounce:fn=>fn,onViewPage:()=>{},onBodyMutation:()=>{},onSidebarRebuilt:()=>{},isActiveTabContainer:()=>true,observeTabContainers:()=>{}},
  core:{api:{fetch:async()=>({Items:[]})},ui:{skeletonGridHtml:()=>'<span>Loading</span>'}}
 }});
 t.after(()=>h.close());for(const path of owned)h.load(path);
 h.JE.initializeHiddenContent();
 return {...h,api:h.JE.internals.hiddenContent,page:h.JE.internals.hiddenContentPage,home:h.JE.internals.features,
  frames(){while(frames.length)frames.shift()();},
  switchUser(){epoch++;for(const fn of resets.values())fn();uid='user-b';h.JE.userConfig={hiddenContent:{items:{},settings:{}}};},
  ready(){h.document.dispatchEvent(new h.window.Event('je:user-data-loaded'));},
 };
}
test('all 18 shipped entries install in production order and duplicate loads keep one data/page owner',t=>{
 const h=setup(t,{items:{a:{itemId:'a'}}});assert.equal(owned.length,18);
 const data=h.api.getHiddenData(),state=h.page.state;
 for(const path of owned)h.load(path);
 assert.equal(h.api.getHiddenData(),data);assert.equal(h.page.state,state);assert.equal(h.api.getHiddenCount(),1);
});
test('malformed refresh never replaces existing policy or future fields',async t=>{
 const h=setup(t,{items:{a:{itemId:'a',future:{value:2}}},ajax:async()=>({items:[]})});
 assert.equal(await h.api.refresh(),false);assert.equal(h.api.isHidden('a'),true);assert.equal(h.api.getHiddenData().items.a.future.value,2);
});
test('invalid bootstrap policy blocks writes until a validated reload',async t=>{
 const h=setup(t);h.JE.userConfig.hiddenContent={items:{a:null}};h.api.resetFromUserConfig();
 assert.equal(h.api.isLoadOk(),false);assert.throws(()=>h.api.hideItem({itemId:'b'}),/unavailable/);
 assert.throws(()=>h.api.updateSettings({enabled:false}),/unavailable/);assert.throws(()=>h.api.unhideAll(),/unavailable/);
});
test('Pascal document fields decode without altering extension data or map keys',async t=>{
 const h=setup(t,{ajax:async()=>({Items:{'AA-BB':{ItemId:'AA-BB',Name:'Title',FutureField:{ExactCase:1}}},Settings:{FilterSearch:true,FutureSetting:'keep'},FutureDocument:{ExactCase:2}})});
 assert.equal(await h.api.refresh(),true);assert.equal(h.api.isHidden('aabb'),true);
 const data=h.api.getHiddenData();assert.equal(data.items['AA-BB'].FutureField.ExactCase,1);assert.equal(data.FutureDocument.ExactCase,2);assert.equal(data.settings.FutureSetting,'keep');assert.equal(h.api.getSettings().filterSearch,true);
});
test('scoped merge preserves extension metadata and earliest timestamp across GUID keys',t=>{
 const id='123456781234123412341234567890ab',dashed='12345678-1234-1234-1234-1234567890ab';
 const h=setup(t,{items:{[id]:{itemId:id,hideScope:'nextup',hiddenAt:'2020',future:1},[dashed]:{itemId:dashed,hideScope:'continuewatching',hiddenAt:'2019',extra:2}}});
 h.api.markScopedHidden(id,'nextup');const item=h.api.getHiddenData().items[id];assert.equal(item.hideScope,'homesections');assert.equal(item.hiddenAt,'2019');assert.equal(item.future,1);assert.equal(item.extra,2);assert.equal(Object.keys(h.api.getHiddenData().items).length,1);
});
test('calendar title fallback excludes home-only hides',t=>{
 const h=setup(t,{items:{x:{itemId:'x',name:'Only Next Up',hideScope:'nextup'}}});assert.equal(h.api.filterCalendarEvents([{title:'Only Next Up'}]).length,1);
});
test('refresh started before a local mutation cannot erase the newer intent',async t=>{
 const pending=deferred();const h=setup(t,{ajax:()=>pending.promise});
 const refresh=h.api.refresh();h.api.hideItem({itemId:'new'});pending.resolve({items:{},settings:{}});
 assert.equal(await refresh,false);assert.equal(h.api.isHidden('new'),true);
});
test('queued animation frame cannot hide new account cards',t=>{
 const h=setup(t,{items:{a:{itemId:'a'}},html:'<div class="card" data-id="a"></div>'});h.api.filterNativeCards();h.switchUser();h.frames();assert.equal(h.document.querySelectorAll('.je-hidden').length,0);
});
test('stale hide confirmation and undo cannot mutate next account',t=>{
 const h=setup(t);h.api.confirmAndHide({itemId:'a',name:'Secret'});const confirm=h.document.querySelector('.je-hide-confirm-hide');
 h.switchUser();h.ready();confirm.click();assert.equal(h.api.getHiddenCount(),0);assert.equal(h.document.querySelector('.je-hide-confirm-overlay'),null);
 h.api.hideItem({itemId:'b'});const undo=h.document.querySelector('.je-undo-btn');h.switchUser();h.ready();undo.click();assert.equal(h.api.getHiddenCount(),0);
});
test('admin malformed loads return null instead of an authoritative empty list',async t=>{
 const h=setup(t,{ajax:async()=>({users:'bad',hiddenContent:{items:[]}})});assert.equal(await h.api.fetchHiddenContentUsers(),null);assert.equal(await h.api.fetchUserHiddenItemsForAdmin('u'),null);
});
test('admin selected-user load rejects an out-of-order completion',async t=>{
 const a=deferred(),b=deferred();const h=setup(t,{ajax:request=>request.url.endsWith('/a')?a.promise:b.promise});
 h.page.state.adminUsers=[{userId:'a',userName:'A',count:1},{userId:'b',userName:'B',count:1}];
 const first=h.page.onAdminUserChange('a'),second=h.page.onAdminUserChange('b');
 b.resolve({hiddenContent:{items:{b:{itemId:'b'}},settings:{}}});await second;
 a.resolve({hiddenContent:{items:{a:{itemId:'a'}},settings:{}}});await first;
 assert.equal(h.page.state.adminItemsUserId,'b');assert.equal(h.page.state.adminItems[0]._key,'b');
});
test('admin sent unhide must not prune another selected user on completion',async t=>{
 const pending=deferred();const h=setup(t,{ajax:()=>pending.promise});
 Object.assign(h.page.state,{selectedAdminUserId:'a',adminItemsUserId:'a',adminEditMode:true,adminItems:[{_key:'shared',itemId:'shared'}]});
 h.page.handleUnhide('shared');Object.assign(h.page.state,{selectedAdminUserId:'b',adminItemsUserId:'b',adminItems:[{_key:'shared',itemId:'shared'}],adminLoadToken:1});
 pending.resolve({success:true});await tick();assert.equal(h.page.state.adminItems.length,1);
});
test('admin confirmation is invalidated by selecting another target without a session change',t=>{
 const h=setup(t);Object.assign(h.page.state,{selectedAdminUserId:'a',adminEditMode:true});let calls=0;
 h.page.showUnhideConfirmation('Unhide?',()=>calls++);h.page.state.selectedAdminUserId='b';h.page.state.adminLoadToken++;
 h.document.querySelector('.je-hide-confirm-hide').click();assert.equal(calls,0);
});
test('account change immediately clears own and administrator management page content',t=>{
 const h=setup(t,{html:'<div id="je-hidden-content-container">Private title</div><div id="je-hidden-content-container-tab">Another title</div>'});h.switchUser();assert.equal(h.document.getElementById('je-hidden-content-container').textContent,'');assert.equal(h.document.getElementById('je-hidden-content-container-tab').textContent,'');
});
test('whole document writes are serialized and preserve latest local intent',async t=>{
 const first=deferred(),writes=[];let count=0;
 const h=setup(t,{ajax:request=>{writes.push(JSON.parse(request.data));return ++count===1?first.promise:Promise.resolve({});}});
 h.api.hideItem({itemId:'a'});const saveA=h.api.flushPendingSave();await tick();h.api.hideItem({itemId:'b'});const saveB=h.api.flushPendingSave();await tick();assert.equal(writes.length,1);
 first.resolve({});await Promise.all([saveA,saveB]);assert.equal(writes.length,2);assert.deepEqual(Object.keys(writes[1].items),['a','b']);
});
test('sent scoped write reconciles after route change but cannot affect a new account',async t=>{
 const pending=deferred();const h=setup(t,{ajax:()=>pending.promise});
 const result=h.home.removeFromHomeSurface('a','nextup');await tick();h.switchUser();pending.resolve({success:true});
 assert.equal(await result,true);assert.equal(h.api.getHiddenCount(),0);
});
test('scoped write flush awaiting another write rejects account switch before sending',async t=>{
 const pending=deferred();let requests=0;const h=setup(t,{ajax:()=>{requests++;return pending.promise;}});
 h.api.hideItem({itemId:'a'});const save=h.api.flushPendingSave();await tick();const scoped=h.home.removeFromHomeSurface('b','nextup');h.switchUser();pending.resolve({});await save;assert.equal(await scoped,false);assert.equal(requests,1);
});
test('hide and undo preserve unrelated stored extensions in the shipped assets',async t=>{
 let sent;const h=setup(t,{ajax:async request=>{sent=JSON.parse(request.data);return {};}});
 h.api.getHiddenData().extension={v:1};h.api.hideItem({itemId:'a',name:'A'});h.document.querySelector('.je-undo-btn').click();await h.api.flushPendingSave();assert.deepEqual(sent.items,{});assert.equal(sent.extension.v,1);
});
test('malformed scoped mutation acknowledgement does not mark an item hidden',async t=>{
 const h=setup(t,{ajax:async()=>({success:'yes'})});assert.equal(await h.home.removeFromHomeSurface('a','nextup'),false);assert.equal(h.api.getHiddenCount(),0);
});
test('undo restores an earlier home scope and unknown fields instead of deleting the prior policy',async t=>{
 let saved;const h=setup(t,{items:{a:{itemId:'a',hideScope:'nextup',future:42}},ajax:async request=>{saved=JSON.parse(request.data);return {};}});
 h.api.hideItem({itemId:'a',hideScope:'global'});assert.equal(h.api.isHidden('a'),true);h.document.querySelector('.je-undo-btn').click();await h.api.flushPendingSave();
 assert.equal(saved.items.a.hideScope,'nextup');assert.equal(saved.items.a.future,42);assert.equal(h.api.isHidden('a'),false);
});
test('disabling a scoped-only policy restores its native card',t=>{
 const h=setup(t,{items:{a:{itemId:'a',hideScope:'nextup'}},html:'<div class="section nextup"><div class="card" data-id="a"></div></div>'});h.api.filterNativeCards();h.frames();assert.equal(h.document.querySelectorAll('.je-hidden').length,1);h.api.updateSettings({enabled:false});h.frames();assert.equal(h.document.querySelectorAll('.je-hidden').length,0);
});
test('scoped merge does not narrow a legacy entry with implicit global scope',t=>{
 const h=setup(t,{items:{a:{itemId:'a',future:42}}});h.api.markScopedHidden('a','nextup');assert.equal(h.api.getHiddenData().items.a.hideScope,'global');assert.equal(h.api.isHidden('a'),true);
});
test('GUID unhide removes equivalent storage aliases while retaining unrelated TMDB records',t=>{
 const h=setup(t,{items:{'aa-bb':{itemId:'AA-BB'},aabb:{itemId:'aabb'},'tmdb-5':{tmdbId:5}}});h.api.unhideItem('AA-BB');assert.equal(h.api.getHiddenCount(),1);assert.equal(h.api.isHiddenByTmdbId(5),true);
});
test('already-sent scoped mutation reconciles policy after leaving its view',async t=>{
 const pending=deferred();const h=setup(t,{ajax:()=>pending.promise,html:'<div class="card" data-id="a"></div>'});const card=h.document.querySelector('.card');
 const saving=h.home.removeFromHomeSurface('a','nextup',card);await tick();h.document.dispatchEvent(new h.window.Event('viewhide'));pending.resolve({success:true});assert.equal(await saving,true);assert.equal(h.api.isHiddenOnSurface('a','nextup'),true);assert.equal(card.classList.contains('je-hidden'),false);
});
test('parent lookup cannot hide a recycled card whose item ID changed',async t=>{
 const pending=deferred();const h=setup(t,{items:{series:{itemId:'series'}},ajax:()=>pending.promise,html:'<div class="card" data-id="episode" data-type="Episode"></div>'});h.api.filterNativeCards();h.document.querySelector('.card').dataset.id='other';pending.resolve({Items:[{Id:'episode',SeriesId:'series'}]});await tick();h.frames();assert.equal(h.document.querySelectorAll('.je-hidden').length,0);
});
test('undo restores an emptied home section after its deferred card visibility pass',t=>{
 const h=setup(t,{html:'<div class="section nextup"><h2>Next Up</h2><div class="card" data-id="a"></div></div>'});h.api.hideItem({itemId:'a',hideScope:'nextup'});h.frames();assert.equal(h.document.querySelector('.section').style.display,'none');h.document.querySelector('.je-undo-btn').click();h.frames();assert.equal(h.document.querySelector('.section').style.display,'');
});
test('local undo queued during a scoped write survives its later acknowledgement',async t=>{
 const pending=deferred(),writes=[];
 const h=setup(t,{items:{a:{itemId:'a',hideScope:'nextup'}},ajax:request=>{if(request.url.includes('/next-up/hide/'))return pending.promise;writes.push(JSON.parse(request.data));return Promise.resolve({});}});
 const scoped=h.home.removeFromHomeSurface('a','nextup');await tick();h.api.unhideItem('a');const correction=h.api.flushPendingSave();pending.resolve({success:true});assert.equal(await scoped,true);await correction;assert.equal(h.api.getHiddenCount(),0);assert.deepEqual(writes.at(-1).items,{});
});
// BUG-011: the admin add-items search reports a failed search instead of "No matching titles".
async function adminSearch(h,{library,seerr}){
 h.JE.core.api.fetch=library;if(seerr)h.JE.jellyseerrAPI={search:seerr};
 Object.assign(h.page.state,{selectedAdminUserId:'a',adminUserName:'A',adminItems:[]});
 h.page.openAdminAddModal();
 const overlay=h.document.querySelector('.je-hidden-admin-add-overlay'),input=overlay.querySelector('.je-hidden-management-search');
 const setTimer=h.window.setTimeout.bind(h.window);h.window.setTimeout=(fn,ms,...rest)=>setTimer(fn,ms===300?0:ms,...rest);// the search debounce
 input.value='alpha';input.dispatchEvent(new h.window.Event('input'));
 await new Promise(resolve=>setTimer(resolve,0));// equal-delay timers run in order, so the debounced search has started
 for(let i=0;i<10;i++)await tick();
 return overlay.querySelector('.je-hidden-management-grid');
}
test('admin add-items search shows an error, not "no matches", when the searches fail',async t=>{
 const h=setup(t);
 const grid=await adminSearch(h,{library:async()=>{throw Error('offline');},seerr:async()=>{throw Error('offline');}});
 assert.doesNotMatch(grid.textContent,/hidden_content_admin_add_none/);
 assert.match(grid.textContent,/hidden_content_admin_add_failed/);
});
test('admin add-items search keeps library results and notes that Seerr results are unavailable when only Seerr fails',async t=>{
 const h=setup(t);
 const grid=await adminSearch(h,{library:async()=>({Items:[{Id:'lib1',Name:'Alpha',Type:'Movie',ProviderIds:{Tmdb:'5'}}]}),seerr:async()=>{throw Error('offline');}});
 assert.equal(grid.querySelectorAll('.je-hidden-item-card').length,1);
 assert.match(grid.textContent,/hidden_content_admin_add_seerr_failed/);
});
test('admin add-items search through the real Seerr API notes that Seerr results are unavailable when its search request fails',async t=>{
 const h=setup(t);for(const file of ['seerr-status.js','api.js'])h.load(`jellyseerr/${file}`);
 h.allowConsoleError(/Search failed/);// the pre-fix Seerr API logs the failure it then swallows
 const library={Items:[{Id:'lib1',Name:'Alpha',Type:'Movie',ProviderIds:{Tmdb:'5'}}]};
 const fetch=url=>url.includes('/JellyfinEnhanced/jellyseerr/search')?Promise.reject(Object.assign(new Error('HTTP 502'),{status:502})):Promise.resolve(library);
 const grid=await adminSearch(h,{library:fetch});
 assert.equal(grid.querySelectorAll('.je-hidden-item-card').length,1);
 assert.match(grid.textContent,/hidden_content_admin_add_seerr_failed/);
});
// A Seerr card stores only a TMDB id, and the library hides by Jellyfin item id: a library title offered as a Seerr
// card stays visible in the user's library after "Hide". With the library search failed nothing removed those cards.
test('admin add-items search does not offer a title Seerr links to the library as a Seerr card when the library search fails',async t=>{
 const h=setup(t);for(const file of ['seerr-status.js','api.js'])h.load(`jellyseerr/${file}`);
 const seerrPage={page:1,totalPages:1,totalResults:2,results:[
  {id:655,mediaType:'tv',name:'Star Trek: The Next Generation',firstAirDate:'1987-09-28',posterPath:'/tng.jpg',mediaInfo:{id:3,status:4,jellyfinMediaId:'646003098f4dc870953118d252d50fb6',jellyfinMediaId4k:null}},
  {id:61923,mediaType:'tv',name:'Star vs. the Forces of Evil',firstAirDate:'2015-01-18',posterPath:'/svtfoe.jpg',mediaInfo:null}]};
 const fetch=url=>url.includes('/JellyfinEnhanced/jellyseerr/search')?Promise.resolve(seerrPage):Promise.reject(Object.assign(new Error('HTTP 500'),{status:500}));
 const grid=await adminSearch(h,{library:fetch});
 assert.match(grid.textContent,/hidden_content_admin_add_failed/);
 assert.deepEqual([...grid.querySelectorAll('.je-hidden-item-name')].map(n=>n.textContent),['Star vs. the Forces of Evil']);
});
