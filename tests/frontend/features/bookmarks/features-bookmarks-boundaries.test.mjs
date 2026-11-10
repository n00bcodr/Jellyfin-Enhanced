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

test('queued replacement uses the latest successfully saved record',async t=>{
 let release;let calls=0;
 const h=setup(t,{a:{itemId:'old',timestamp:4,label:'before',custom:1}},async()=>{if(++calls===1)await new Promise(r=>release=r);});
 const selected=[{...h.JE.userConfig.bookmark.bookmarks.a,id:'a'}];
 const updating=h.JE.bookmarks.update('a',{timestamp:99,label:'after',custom:2});
 const replacing=h.JE.bookmarks.syncBookmarks(selected,{itemId:'new'},0,{replaceOriginals:true});
 await tick();release();assert.equal(await updating,true);const result=await replacing;assert.equal(result[0].custom,2);
 assert.equal(result[0].timestamp,99);assert.equal(result[0].label,'after');
 assert.equal(h.JE.userConfig.bookmark.bookmarks.a,undefined);
});
test('replacement lookup cannot open a dialog after navigation',async t=>{
 let release;const h=setup(t);h.load('replacements');h.JE.core.api.fetch=()=>new Promise(r=>release=r);
 const pending=h.JE.internals.bookmarksLibrary.findAndOfferReplacement({details:{itemId:'old',tmdbId:'42',mediaType:'movie'},bookmarks:[]},h.document.createElement('button'));
 h.document.dispatchEvent(new h.window.Event('viewshow'));release({Items:[{Id:'new',Name:'New',ProviderIds:{Tmdb:'42'}}]});await pending;
 assert.equal(h.document.querySelector('.je-bm-library-modal-overlay'),null);
});
test('queued cleanup retains a record retargeted after the missing-item check',async t=>{
 let releaseSave,releaseLookup;let calls=0;
 const h=setup(t,{a:{itemId:'missing',timestamp:4},b:{itemId:'',timestamp:1}},async()=>{if(++calls===1)await new Promise(r=>releaseSave=r);});
 h.window.ApiClient.getItem=()=>new Promise((_,r)=>releaseLookup=r);
 const blocking=h.JE.bookmarks.update('b',{timestamp:2});await tick();
 const cleaning=h.JE.bookmarks.cleanupOrphaned();releaseLookup({status:404});
 // The missing response schedules deletion behind this update in the same client queue.
 const update=h.JE.bookmarks.update('a',{itemId:'exists'});await tick();releaseSave();
 await blocking;assert.equal(await update,true);const result=await cleaning;
 assert.equal(result.cleaned,0);assert.equal(h.JE.userConfig.bookmark.bookmarks.a.itemId,'exists');
});
test('initial card arrival applies the active search query',async t=>{
 let release;const h=setup(t,{a:{itemId:'a',timestamp:4,mediaType:'movie',name:'Alpha'}});
 h.load('render','items');h.JE.helpers.getItemCached=()=>new Promise(r=>release=r);
 const container=h.document.createElement('div');h.document.body.append(container);
 const pending=h.JE.internals.bookmarksLibrary.renderBookmarksLibrary(container);
 const input=container.querySelector('.je-bookmark-search');input.value='no-match';input.dispatchEvent(new h.window.Event('input'));
 release({Id:'a',Name:'Alpha'});await pending;
 assert.equal(container.querySelector('.je-bookmark-item').hidden,true);
});

for (const change of ['delete','retarget']) {
 test(`replacement rejects a ${change} selection without resurrecting or copying it`, async t=>{
  let writes=0;
  const h=setup(t,{a:{itemId:'old',timestamp:4,label:'before'}},async()=>{writes++;});
  const selected=[{...h.JE.userConfig.bookmark.bookmarks.a,id:'a'}];
  if(change==='delete') await h.JE.bookmarks.delete('a'); else await h.JE.bookmarks.update('a',{itemId:'different'});
  const before=plain(h.JE.userConfig.bookmark.bookmarks);
  await assert.rejects(h.JE.bookmarks.syncBookmarks(selected,{itemId:'new'},0,{replaceOriginals:true}), /selection changed/i);
  assert.deepEqual(plain(h.JE.userConfig.bookmark.bookmarks),before); assert.equal(writes,1);
 });
}
test('closing a replacement dialog during detail lookup prevents a later migration write',async t=>{
 let release,writes=0;
 const h=setup(t,{a:{itemId:'old',timestamp:4}},async()=>{writes++;}); h.load('replacements');
 h.JE.core.api.fetch=async()=>({Items:[{Id:'new',Name:'New',ProviderIds:{Tmdb:'42'}}]});
 await h.JE.internals.bookmarksLibrary.findAndOfferReplacement({details:{itemId:'old',tmdbId:'42',mediaType:'movie'},bookmarks:[{...h.JE.userConfig.bookmark.bookmarks.a,id:'a'}]},h.document.createElement('button'));
 const modal=h.document.querySelector('.je-bm-library-modal-overlay');
 modal.querySelector('.replacement-option').click(); h.window.ApiClient.getItem=()=>new Promise(r=>release=r);
 modal.querySelector('.je-bookmark-btn-submit').click(); await tick();
 modal.querySelector('.je-bm-library-modal-close').click(); release({Id:'new',Name:'New'}); await tick();
 assert.equal(writes,0); assert.ok(h.JE.userConfig.bookmark.bookmarks.a); assert.deepEqual(h.toasts,[]);
});
