import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, plain } from '../helpers/harness.mjs';

/**
 * Loads the real settings saver and bookmarks. `save` answers each user-settings POST made through
 * ApiClient.ajax (reject it to fail the save); `routes.items` answers item lookups.
 */
function setup(t, bookmarks = {}, save = async()=>{}) {
  const events=[],toasts=[];
  const routes={save,items:null};
  const ajax=request=>{
    if(request.type==='POST'&&request.url.includes('/JellyfinEnhanced/user-settings/user-a/'))return routes.save(request.url.split('/').pop(),JSON.parse(request.data));
    if(routes.items)return routes.items(request);
    throw new Error(`Unexpected request: ${request.url}`);
  };
  const h=createHarness({JE:{pluginConfig:{BookmarksEnabled:true},userConfig:{bookmark:{bookmarks}},t:key=>key,toast:message=>toasts.push(message),escapeHtml:value=>String(value)},apiClient:{ajax}});
  t.after(()=>h.close());
  h.document.addEventListener('je-bookmarks-updated',e=>events.push(e.detail.reason));
  h.load('enhanced/config.js');
  h.load('enhanced/bookmarks/bookmarks.js');
  return {...h,events,toasts,routes,api:h.JE.bookmarks};
}
/** Answers each user-settings save with a promise the test settles, in call order. */
function controlledSaves(){
  const calls=[];
  return {calls,save:(file,data)=>new Promise((resolve,reject)=>calls.push({data,resolve,reject})),
    async next(count){for(let i=0;calls.length<count&&i<200;i++)await new Promise(done=>setImmediate(done));assert.equal(calls.length,count);return calls[count-1];}};
}
const settle=async(until,limit=200)=>{for(let i=0;!until()&&i<limit;i++)await new Promise(done=>setImmediate(done));assert.ok(until(),'condition never became true');};
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
test('saveUserSettings rejects only for callers that opt in',async t=>{
  let fail=true;const h=setup(t,{},async()=>{if(fail)throw new Error('offline');});
  h.expectConsoleError(/Failed to save settings\.json/);
  assert.equal(await h.JE.saveUserSettings('settings.json',{a:1}),undefined);
  await assert.rejects(h.JE.saveUserSettings('settings.json',{a:1},{throwOnError:true}),/offline/);
  fail=false;
  await h.JE.saveUserSettings('settings.json',{a:1},{throwOnError:true});
  h.window.ApiClient.getCurrentUserId=()=>null;
  await assert.rejects(h.JE.saveUserSettings('settings.json',{a:2},{throwOnError:true}),/User ID not available/);
});
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
  await new Promise(done=>setImmediate(done));
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
 h.routes.items=()=>new Promise(r=>{resolve=r;});
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
  h.routes.items=async()=>({Items:[{Id:'item',Name:'Movie',Type:'Movie'}]});
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
 h.routes.items=async()=>{calls++;return {Items:[{Id:'item',Name:calls===1?'Private name':'Redacted',Type:'Movie'}]};};
 assert.equal((await h.api.add(1)).name,'Private name');
 h.JE.userConfig={bookmark:{bookmarks:{}}};
 assert.equal((await h.api.add(2)).name,'Redacted');assert.equal(calls,2);
});
test('stale episode metadata cannot start a secondary series lookup as the old user',async t=>{
 let resolve,calls=0;const h=setup(t);h.document.body.innerHTML='<div class="videoOsdBottom"><button class="btnUserRating" data-id="episode"></button></div>';
 h.routes.items=()=>{calls++;return new Promise(r=>{resolve=r;});};const pending=h.api.add(5);h.JE.userConfig={};resolve({Items:[{Id:'episode',Type:'Episode',SeriesId:'private-series'}]});assert.equal(await pending,null);assert.equal(calls,1);
});

// Overlapping mutations: the first save fails and the second succeeds. Memory must end
// equal to what the server holds, or the next save resurrects or drops a bookmark.
test('overlapping bookmark deletes cannot resurrect a record the server no longer has',async t=>{
  const saves=controlledSaves();const h=setup(t,{a:{itemId:'one'},b:{itemId:'two'}},saves.save);
  h.expectConsoleError(/Failed to delete bookmark/);
  const first=h.api.delete('a'),second=h.api.delete('b');
  (await saves.next(1)).reject(new Error('offline'));
  (await saves.next(2)).resolve();
  assert.deepEqual([await first,await second],[false,true]);
  assert.deepEqual(Object.keys(h.JE.userConfig.bookmark.bookmarks),['a']);
  assert.deepEqual(Object.keys(saves.calls[1].data.bookmarks),['a']);
  assert.deepEqual(h.events,['delete']);
});
test('overlapping bookmark adds leave memory equal to the saved set',async t=>{
  const saves=controlledSaves();const h=setup(t,{},saves.save);
  h.document.body.innerHTML='<div class="videoOsdBottom"><button class="btnUserRating" data-id="item"></button></div>';
  h.routes.items=async()=>({Items:[{Id:'item',Name:'Movie',Type:'Movie'}]});
  h.expectConsoleError(/Failed to save bookmark/);
  const first=h.api.add(1),second=h.api.add(2);const firstFailure=assert.rejects(first,/offline/);
  (await saves.next(1)).reject(new Error('offline'));
  (await saves.next(2)).resolve();
  await firstFailure;const added=await second;
  assert.deepEqual(Object.keys(h.JE.userConfig.bookmark.bookmarks),[added.id]);
  assert.deepEqual(Object.keys(saves.calls[1].data.bookmarks),[added.id]);
  assert.equal(h.JE.userConfig.bookmark.bookmarks[added.id].timestamp,2);
});
test('a queued bookmark mutation does not run for a user who signed out meanwhile',async t=>{
  const saves=controlledSaves();const h=setup(t,{a:{itemId:'one'},b:{itemId:'two'}},saves.save);
  const first=h.api.delete('a'),second=h.api.update('b',{label:'later'});
  (await saves.next(1)).resolve();
  h.JE.userConfig={bookmark:{bookmarks:{}}};
  // Settle any save a regression issues for the signed-out user, so it fails rather than hangs.
  const results=Promise.all([first,second]);for(let i=0;i<10;i++)await new Promise(done=>setImmediate(done));saves.calls.slice(1).forEach(call=>call.resolve());
  assert.deepEqual(await results,[true,false]);
  assert.equal(saves.calls.length,1);assert.deepEqual(plain(h.JE.userConfig.bookmark.bookmarks),{});
});
