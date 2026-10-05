import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, plain } from '../helpers/harness.mjs';

function setup(t, bookmarks = {}, save = async()=>{}) {
  const events=[];
  const h=createHarness({JE:{pluginConfig:{BookmarksEnabled:true},userConfig:{bookmark:{bookmarks}},saveUserSettings:save,t:key=>key,toast:()=>{}}});
  t.after(()=>h.close());
  h.document.addEventListener('je-bookmarks-updated',e=>events.push(e.detail.reason));
  h.load('enhanced/bookmarks/bookmarks.js');
  return {...h,events,api:h.JE.bookmarks};
}
test('bookmarks remain inactive when feature is disabled',t=>{
  const h=createHarness({JE:{pluginConfig:{BookmarksEnabled:false}}});t.after(()=>h.close());
  h.load('enhanced/bookmarks/bookmarks.js');
  assert.equal(h.JE.bookmarks,undefined);
  assert.equal(h.JE.initializeBookmarks,undefined);
});
test('bookmark lookup prefers exact item IDs and ignores corrupt entries',t=>{
  const h=setup(t,{exact:{itemId:'current',tmdbId:'42'},other:{itemId:'old',tmdbId:'42'},bad:null,legacy:34});
  const result=h.api.findForItem('current','42');
  assert.deepEqual(Array.from(result.bookmarks,b=>b.id),['exact']);
  assert.equal(result.hasIdMismatch,false);
  assert.equal(result.providerMatches.length,1);
});
test('episode provider fallback excludes other episodes and seasons but retains legacy records',t=>{
  const h=setup(t,{same:{itemId:'old',tmdbId:'42',seasonNumber:2,episodeNumber:3},episode:{tmdbId:'42',seasonNumber:2,episodeNumber:4},season:{tmdbId:'42',seasonNumber:1,episodeNumber:3},legacy:{tvdbId:'tv42'}});
  const result=h.api.findForItem('new','42','tv42',2,3);
  assert.deepEqual(Array.from(result.bookmarks,b=>b.id),['same','legacy']);
  assert.equal(result.hasIdMismatch,true);
});
test('bookmark update/delete persist and emit only successful changes',async t=>{
  const saved=[]; const h=setup(t,{one:{itemId:'item',label:'old'}},async(file,data)=>saved.push([file,plain(data)]));
  assert.equal(await h.api.update('missing',{}),false);
  assert.equal(await h.api.delete('missing'),false);
  assert.equal(saved.length,0);
  assert.equal(await h.api.update('one',{label:'new'}),true);
  assert.equal(saved[0][0],'bookmark.json');
  assert.equal(saved[0][1].bookmarks.one.label,'new');
  assert.equal(await h.api.delete('one'),true);
  assert.deepEqual(h.events,['update','delete']);
  assert.equal(Object.keys(h.JE.userConfig.bookmark.bookmarks).length,0);
});
for(const operation of ['update','delete']){
  test(`failed bookmark ${operation} restores in-memory record without emitting success`,async t=>{
    const original={itemId:'item',label:'keep',updatedAt:'old'};
    const h=setup(t,{one:{...original}},async()=>{throw new Error('offline');});
    h.expectConsoleError(new RegExp(`Failed to ${operation} bookmark`));
    assert.equal(await h.api[operation]('one',{label:'lost'}),false);
    assert.deepEqual(plain(h.JE.userConfig.bookmark.bookmarks.one),original);
    assert.deepEqual(h.events,[]);
  });
}
test('bookmark sync preserves originals, offsets timestamps and rolls back failed copies',async t=>{
  let fail=false;
  const h=setup(t,{old:{itemId:'old-item',timestamp:5,label:'scene'}},async()=>{if(fail)throw new Error('offline');});
  const result=await h.api.syncBookmarks([{id:'old',...h.JE.userConfig.bookmark.bookmarks.old}],{itemId:'new-item',tmdbId:'42'},-10);
  assert.equal(result[0].timestamp,0);
  assert.equal(result[0].syncedFrom,'old-item');
  assert.equal(h.JE.userConfig.bookmark.bookmarks.old.itemId,'old-item');
  const before=plain(h.JE.userConfig.bookmark.bookmarks);
  fail=true;
  h.expectConsoleError(/Failed to sync bookmarks/);
  await assert.rejects(h.api.syncBookmarks([result[0]],{itemId:'another'},2),/offline/);
  assert.deepEqual(plain(h.JE.userConfig.bookmark.bookmarks),before);
  assert.deepEqual(h.events,['sync']);
});
test('adding bookmark without active item fails gracefully',async t=>{
  const h=setup(t); assert.equal(await h.api.add(12),null);assert.deepEqual(h.events,[]);
});
for(const operation of ['update','delete']) {
 test(`old-user failed bookmark ${operation} cannot restore data into new-user store`,async t=>{
  let reject;
  const h=setup(t,{one:{itemId:'secret',label:'old-user'}},()=>new Promise((_,r)=>{reject=r;}));
  const pending=h.api[operation]('one',{label:'new'});
  h.JE.userConfig={bookmark:{bookmarks:{}}};
  h.expectConsoleError(new RegExp(`Failed to ${operation} bookmark`));
  reject(new Error('offline'));
  assert.equal(await pending,false);
  assert.deepEqual(plain(h.JE.userConfig.bookmark.bookmarks),{});
 });
}
test('bookmark item lookup resolving after a user switch cannot add old-user data',async t=>{
 let resolve;let saves=0;
 const h=setup(t,{},async()=>{saves++;});
 h.document.body.innerHTML='<div class="videoOsdBottom"><button class="btnUserRating" data-id="secret"></button></div>';
 h.window.ApiClient.ajax=()=>new Promise(r=>{resolve=r;});
 const pending=h.api.add(5);
 h.JE.userConfig={bookmark:{bookmarks:{}}};
 resolve({Items:[{Id:'secret',Name:'Secret movie',Type:'Movie',ProviderIds:{Tmdb:'42'}}]});
 assert.equal(await pending,null);
 assert.equal(saves,0);assert.deepEqual(plain(h.JE.userConfig.bookmark.bookmarks),{});
});
for(const operation of ['add','update','delete','syncBookmarks'])for(const failure of [false,true]){
 test(`bookmark ${operation} ${failure?'failure':'success'} after logout leaves absent config untouched`,async t=>{
  let resolve,reject;const h=setup(t,{one:{itemId:'old',timestamp:5}},()=>new Promise((a,b)=>{resolve=a;reject=b;}));
  h.document.body.innerHTML='<div class="videoOsdBottom"><button class="btnUserRating" data-id="item"></button></div>';
  h.window.ApiClient.ajax=async()=>({Items:[{Id:'item',Name:'Movie',Type:'Movie'}]});
  const pending=operation==='add'?h.api.add(5):operation==='syncBookmarks'?h.api.syncBookmarks([{itemId:'old',timestamp:5}],{itemId:'new'}):h.api[operation]('one',{label:'updated'});
  await new Promise(done=>setImmediate(done));
  h.JE.userConfig={};
  if(failure){h.expectConsoleError(new RegExp(`Failed to ${operation==='add'?'save':operation==='syncBookmarks'?'sync':operation} bookmark`));reject(new Error('offline'));if(operation==='add'||operation==='syncBookmarks')await assert.rejects(pending,/offline/);else assert.equal(await pending,false);}else{resolve();await pending;}
  assert.deepEqual(h.JE.userConfig,{});assert.deepEqual(h.events,[]);
 });
}
test('bookmark metadata cached for one user is fetched again after account switch',async t=>{
 const h=setup(t);let calls=0;
 h.document.body.innerHTML='<div class="videoOsdBottom"><button class="btnUserRating" data-id="item"></button></div>';
 h.window.ApiClient.ajax=async()=>{calls++;return {Items:[{Id:'item',Name:calls===1?'Private name':'Redacted',Type:'Movie'}]};};
 assert.equal((await h.api.add(1)).name,'Private name');
 h.JE.userConfig={bookmark:{bookmarks:{}}};
 assert.equal((await h.api.add(2)).name,'Redacted');assert.equal(calls,2);
});
test('stale episode metadata cannot start a secondary series lookup as the old user',async t=>{
 let resolve,calls=0;const h=setup(t);h.document.body.innerHTML='<div class="videoOsdBottom"><button class="btnUserRating" data-id="episode"></button></div>';
 h.window.ApiClient.ajax=()=>{calls++;return new Promise(r=>{resolve=r;});};const pending=h.api.add(5);h.JE.userConfig={};resolve({Items:[{Id:'episode',Type:'Episode',SeriesId:'private-series'}]});assert.equal(await pending,null);assert.equal(calls,1);
});
