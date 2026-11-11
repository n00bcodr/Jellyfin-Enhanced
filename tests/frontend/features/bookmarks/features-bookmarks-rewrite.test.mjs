import {installBookmarkPersistenceFixture} from '../../helpers/bookmark-persistence.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHarness, plain} from '../../helpers/harness.mjs';
const tick = async () => {for(let i=0;i<15;i++) await new Promise(r=>setImmediate(r));};
function setup(t, records={}, save=async()=>{}) {
 let epoch=0;
 const handlers=new Map(), toasts=[];
 const h=createHarness({JE:{
  pluginConfig:{BookmarksEnabled:true},userConfig:{bookmark:{bookmarks:records,extension:{retained:true}}},
  t:k=>k,toast:m=>toasts.push(m),escapeHtml:v=>String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;'),
  saveUserSettings:save,session:{getEpoch:()=>epoch,isCurrent:e=>e===epoch,onUserChange:(key,fn)=>{handlers.set(key,fn);return ()=>handlers.delete(key);}},
  helpers:{isActiveTabContainer:()=>false},core:{api:{fetch:async()=>({Items:[]})}}
 },apiClient:{getItem:async(_user,id)=>({Id:id,Name:id,Type:'Movie'}),getImageUrl:()=>''}});
 installBookmarkPersistenceFixture(h, save);
 t.after(()=>h.close());h.load('enhanced/bookmarks/bookmarks.js');
 const load=(...names)=>names.forEach(name=>h.load('enhanced/bookmarks/bookmarks-library-'+name+'.js'));
 const change=()=>{epoch++;for(const fn of [...handlers.values()])fn();};
 return {...h,load,change,toasts};
}
test('atomic offset failure rolls back every changed record and preserves extensions', async t=>{
 let calls=0;
 const h=setup(t,{a:{itemId:'i',timestamp:4,syncedFrom:'old',custom:{a:1}},b:{itemId:'i',timestamp:8,syncedFrom:'old'}},async()=>{calls++;throw new Error('offline');});
 const before=plain(h.JE.userConfig.bookmark);
 await assert.rejects(h.JE.bookmarks.adjustOffsets(Object.entries(before.bookmarks).map(([id,b])=>({...b,id})),5),/offline/);
 assert.equal(calls,1);assert.deepEqual(plain(h.JE.userConfig.bookmark),before);
});
test('offset batches serialize behind deletion and update only surviving records',async t=>{
 let release;const saved=[];
 const h=setup(t,{a:{itemId:'i',timestamp:4},b:{itemId:'i',timestamp:8,syncedFrom:'old'}},async(_,doc)=>{
  saved.push(plain(doc));if(saved.length===1)await new Promise(r=>release=r);
 });
 const selected=Object.entries(h.JE.userConfig.bookmark.bookmarks).map(([id,b])=>({...b,id}));
 const deleting=h.JE.bookmarks.delete('a');const adjusting=h.JE.bookmarks.adjustOffsets(selected,-10);
 await tick();release();assert.equal(await deleting,true);assert.equal(await adjusting,1);
 assert.equal(saved.length,2);assert.deepEqual(Object.keys(saved[1].bookmarks),['b']);assert.equal(saved[1].bookmarks.b.timestamp,0);assert.equal(saved[1].bookmarks.b.syncedFrom,'');
});
test('migration preserves unknown record and document fields',async t=>{
 const h=setup(t,{a:{itemId:'old',timestamp:4,custom:{precision:'9007199254740993'}}});
 const result=await h.JE.bookmarks.syncBookmarks([{...h.JE.userConfig.bookmark.bookmarks.a,id:'a'}],{itemId:'new'},3,{replaceOriginals:true});
 assert.deepEqual(plain(result[0].custom),{precision:'9007199254740993'});
 assert.deepEqual(plain(h.JE.userConfig.bookmark.extension),{retained:true});
 assert.equal(result[0].timestamp,7);assert.equal(h.JE.userConfig.bookmark.bookmarks.a,undefined);
});
test('cleanup refuses transient errors and stale missing-item responses',async t=>{
 let saves=0, reject;
 const h=setup(t,{a:{itemId:'old',timestamp:4}},async()=>saves++);
 h.window.ApiClient.getItem=async()=>{throw new Error('offline');};
 assert.deepEqual(plain(await h.JE.bookmarks.cleanupOrphaned()),{cleaned:0,errors:1});
 h.window.ApiClient.getItem=()=>new Promise((_,r)=>reject=r);
 const pending=h.JE.bookmarks.cleanupOrphaned();
 h.JE.userConfig={bookmark:{bookmarks:{a:{itemId:'new',timestamp:9}}}};h.change();
 reject({status:404});assert.deepEqual(plain(await pending),{cleaned:0,errors:0});
 assert.equal(saves,0);assert.equal(h.JE.userConfig.bookmark.bookmarks.a.itemId,'new');
});
test('late series metadata is not cached after an epoch change on the same owner',async t=>{
 let release,calls=0;
 const h=setup(t);h.document.body.innerHTML='<div class="videoOsdBottom"><button class="btnUserRating" data-id="episode"></button></div>';
 const persistence=h.window.ApiClient.ajax;
 h.window.ApiClient.ajax=async request=>{if(request.type==='POST')return persistence(request);calls++;if(calls===1)return {Items:[{Id:'episode',Type:'Episode',SeriesId:'series'}]};if(calls===2)return await new Promise(r=>release=r);return {Items:[{Id:'episode',Name:'New account',Type:'Movie'}]};};
 const pending=h.JE.bookmarks.add(1);await tick();h.change();release({Items:[{Id:'series',ProviderIds:{Tmdb:'private'}}]});
 assert.equal(await pending,null);assert.equal((await h.JE.bookmarks.add(2)).name,'New account');assert.equal(calls,3);
});
test('an expired library render never inserts old metadata into a new account',async t=>{
 let resolve;
 const h=setup(t,{a:{itemId:'private',timestamp:4,mediaType:'movie',name:'Private movie'}});
 h.JE.helpers.getItemCached=()=>new Promise(r=>resolve=r);h.load('render','items');
 const container=h.document.createElement('div');container.className='sections bookmarks';h.document.body.append(container);
 const pending=h.JE.internals.bookmarksLibrary.renderBookmarksLibrary(container);await tick();
 h.JE.userConfig={bookmark:{bookmarks:{}}};h.change();
 resolve({Id:'private',Name:'Private movie',Type:'Movie'});await pending;
 assert.equal(container.textContent,'');
});
test('replacement lookup cannot create an old-account dialog after logout',async t=>{
 let resolve;const h=setup(t);h.JE.core.api.fetch=()=>new Promise(r=>resolve=r);h.load('replacements');
 const pending=h.JE.internals.bookmarksLibrary.findAndOfferReplacement({details:{itemId:'old',tmdbId:'42',mediaType:'movie'},bookmarks:[]},h.document.createElement('button'));
 h.change();resolve({Items:[{Id:'new',Name:'Private',ProviderIds:{Tmdb:'42'}}]});await pending;
 assert.equal(h.document.querySelector('.je-bm-library-modal-overlay'),null);assert.deepEqual(h.toasts,[]);
});
test('a bookmark document that failed to load is shown as a failure, not as no bookmarks',async t=>{
 const h=setup(t);h.JE.userConfig.bookmarkRevision=null;
 h.load('render','items');const container=h.document.createElement('div');h.document.body.append(container);
 await h.JE.internals.bookmarksLibrary.renderBookmarksLibrary(container);
 assert.equal(container.querySelector('.je-bookmarks-empty-title')?.textContent.trim(),'bookmarks_library_load_failed');
 assert.equal(container.textContent.includes('bookmarks_library_empty_title'),false);
});
test('library search and tab changes operate on the generated controls',async t=>{
 const h=setup(t,{a:{itemId:'a',timestamp:4,mediaType:'movie',name:'Alpha'},b:{itemId:'b',timestamp:8,mediaType:'movie',name:'Beta'},c:{itemId:'c',timestamp:1,mediaType:'tv',name:'Series'}});
 h.load('render','items');const container=h.document.createElement('div');h.document.body.append(container);
 await h.JE.internals.bookmarksLibrary.renderBookmarksLibrary(container);
 const input=container.querySelector('.je-bookmark-search');input.value='beta';input.dispatchEvent(new h.window.Event('input'));
 assert.deepEqual(Array.from(container.querySelectorAll('.je-bookmark-item'),el=>el.hidden),[true,false]);
 container.querySelector('[data-tab="tv"]').click();await tick();
 assert.equal(container.querySelectorAll('.je-bookmark-item').length,1);assert.equal(container.querySelector('.je-bookmark-item').hidden,true);
});
test('invalid transport items do not create bookmarks and malformed timestamp input is rejected',async t=>{
 const h=setup(t);h.document.body.innerHTML='<div class="videoOsdBottom"><button class="btnUserRating" data-id="item"></button></div>';
 h.window.ApiClient.ajax=async()=>({Items:[{Id:7,Name:'Invalid'}]});
 assert.equal(await h.JE.bookmarks.add(2),null);h.load('render');
 const parse=h.JE.internals.bookmarksLibrary.parseTimestampInput;
 for(const value of ['1x','Infinity','1:foo','-1','1:2:3:4'])assert.equal(parse(value),null);
 assert.equal(parse('1:02:03.5'),3723.5);
});
test('same-owner epoch change followed by failed offset never reports success',async t=>{
 let reject;const h=setup(t,{a:{itemId:'i',timestamp:1,syncedFrom:'old'}},()=>new Promise((_,r)=>reject=r));
 h.load('render','modals');const group={details:{itemId:'i',name:'Item'},bookmarks:[{...h.JE.userConfig.bookmark.bookmarks.a,id:'a'}]};
 h.JE.internals.bookmarksLibrary.showOffsetAdjustmentModal(group);
 h.document.querySelector('.btnApplyOffset').click();await tick();h.change();
 h.expectConsoleError(/Failed to apply offset/);reject(new Error('offline'));await tick();
 assert.equal(h.JE.userConfig.bookmark.bookmarks.a.timestamp,1);assert.deepEqual(h.toasts,[]);assert.equal(h.document.querySelector('[role="dialog"]'),null);
});
test('all eight entries boot in manifest order and dispose tab observer subscriptions',async t=>{
 const h=setup(t);let observe=0,teardown=0,viewOff=0;
 h.JE.pluginConfig.BookmarksUseCustomTabs=true;
 h.JE.core.navigation={onViewPage:()=>()=>viewOff++,onNavigate:()=>()=>{}};
 h.JE.helpers.observeTabContainers=()=>{observe++;return {teardown:()=>teardown++};};
 h.load('styles','page','render','items','modals','replacements','init');
 await new Promise(r=>setTimeout(r,130));
 assert.equal(observe,1);
 h.window.dispatchEvent(new h.window.Event('pagehide'));
 assert.equal(teardown,1);assert.equal(viewOff,1);
});
test('player markers are removed after the final bookmark is deleted',async t=>{
 const h=setup(t,{a:{itemId:'movie',timestamp:5}});
 h.document.body.innerHTML='<div class="videoPlayerContainer"><video></video></div><div class="videoOsdBottom"><button class="btnUserRating" data-id="movie"></button><div class="sliderContainer"><input class="osdPositionSlider"></div></div>';
 Object.defineProperty(h.document.querySelector('video'),'duration',{value:100});
 const persistence=h.window.ApiClient.ajax;
 h.window.ApiClient.ajax=async request=>request.type==='POST'?persistence(request):({Items:[{Id:'movie',Type:'Movie',Name:'Movie'}]});
 await h.JE.bookmarks.updateMarkers();assert.equal(h.document.querySelectorAll('.je-bookmark-marker').length,1);
 assert.equal(await h.JE.bookmarks.delete('a'),true);await h.JE.bookmarks.updateMarkers();
 assert.equal(h.document.querySelectorAll('.je-bookmark-marker').length,0);
});
test('player cleanup cancels pending injection and supports initialization again',async t=>{
 const h=setup(t);
 h.document.body.innerHTML='<div class="videoPlayerContainer"><video></video></div><div class="videoOsdBottom"><div class="buttons focuscontainer-x"><button class="btnVideoOsdSettings"></button></div></div>';
 let observers=0;h.JE.isVideoPage=()=>true;h.JE.helpers.createObserver=()=>observers++;h.JE.helpers.disconnectObserver=()=>{};
 h.JE.initializeBookmarks();h.JE.cleanupBookmarks();await new Promise(r=>setTimeout(r,230));
 assert.equal(h.document.querySelector('#jeBookmarkBtn'),null);
 h.JE.initializeBookmarks();await new Promise(r=>setTimeout(r,230));
 assert.equal(h.document.querySelectorAll('#jeBookmarkBtn').length,1);assert.equal(observers,2);
 h.JE.cleanupBookmarks();
});
test('replacement search pages beyond 500 records and never offers a series as an episode',async t=>{
 const h=setup(t);let calls=0;
 h.JE.core.api.fetch=async url=>{
  calls++;assert.match(url,/Fields=ProviderIds/);
  if(calls===1)return {Items:Array.from({length:500},(_,i)=>({Id:'unrelated-'+i,Type:'Movie'}))};
  assert.match(url,/StartIndex=500/);
  return {Items:[{Id:'series',Type:'Series',ProviderIds:{Tmdb:'42'}},{Id:'wrong',Type:'Episode',ParentIndexNumber:1,IndexNumber:3,ProviderIds:{Tmdb:'42'}},{Id:'correct',Name:'Correct episode',Type:'Episode',ParentIndexNumber:1,IndexNumber:2,ProviderIds:{Tmdb:'42'}}]};
 };
 h.load('replacements');
 await h.JE.internals.bookmarksLibrary.findAndOfferReplacement({details:{itemId:'old',mediaType:'tv',tmdbId:'42',seasonNumber:1,episodeNumber:2},bookmarks:[]},h.document.createElement('button'));
 assert.equal(calls,2);assert.equal(h.document.querySelectorAll('.replacement-option').length,1);assert.match(h.document.querySelector('.replacement-option').textContent,/Correct episode/);
});
test('replacement search for an episode asks the server only for that season and episode number',async t=>{
 const h=setup(t);const urls=[];
 h.JE.core.api.fetch=async url=>{urls.push(url);return {Items:[{Id:'correct',Name:'Correct episode',Type:'Episode',ParentIndexNumber:3,IndexNumber:4,ProviderIds:{Tvdb:'77'}}]};};
 h.load('replacements');
 await h.JE.internals.bookmarksLibrary.findAndOfferReplacement({details:{itemId:'old',mediaType:'tv',tmdbId:'42',tvdbId:'77',seasonNumber:3,episodeNumber:4},bookmarks:[]},h.document.createElement('button'));
 assert.equal(urls.length,1);
 // Jellyfin's legacy Users/{id}/Items route drops IndexNumber; Items?userId= applies it.
 const url=new URL(urls[0]),query=url.searchParams;
 assert.deepEqual([url.pathname,query.get('userId')],['/Items','user-a']);
 assert.deepEqual([query.get('IncludeItemTypes'),query.get('ParentIndexNumber'),query.get('IndexNumber')],['Episode','3','4']);
 assert.equal(h.document.querySelectorAll('.replacement-option').length,1);
});
// BUG-016: jellyfin-web's legacy page events include a bubbling "pagehide" on the view element it hides (seen after a
// details page). Only the document's own unload may dispose the bookmarks lifetimes; otherwise the library page is
// left unstyled and empty until reload.
test('a bubbling element pagehide leaves the bookmarks library styled and rendering',async t=>{
 const h=setup(t,{a:{itemId:'a',timestamp:4,mediaType:'movie',name:'Alpha'}});
 h.document.body.innerHTML='<div class="mainAnimatedPages"><div class="page" id="itemDetailPage"></div></div>';
 h.load('styles','render','items');
 const styles=()=>h.document.head.querySelectorAll('style').length,before=styles();
 assert.ok(before>=2);
 h.document.getElementById('itemDetailPage').dispatchEvent(new h.window.CustomEvent('pagehide',{bubbles:true}));
 // A back/forward-cache hide keeps the page alive too: it may be shown again.
 h.window.dispatchEvent(new h.window.PageTransitionEvent('pagehide',{persisted:true}));
 assert.equal(styles(),before,'library styles survive');
 const container=h.document.createElement('div');h.document.body.append(container);
 await h.JE.internals.bookmarksLibrary.renderBookmarksLibrary(container);
 assert.equal(container.querySelectorAll('.je-bookmark-item').length,1,'the library still renders its rows');
});
