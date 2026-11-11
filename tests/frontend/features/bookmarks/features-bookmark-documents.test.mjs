import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHarness, plain, deferred} from '../../helpers/harness.mjs';
const tick=async()=>{for(let i=0;i<12;i++)await new Promise(r=>setImmediate(r));await new Promise(r=>setTimeout(r,5));};
function setup(t, ajax, records={A:{itemId:'old',timestamp:5,label:'before'}}) {
 const calls=[],toasts=[];
 const h=createHarness({JE:{pluginConfig:{BookmarksEnabled:true},userConfig:{bookmarkRevision:'loaded:1',bookmark:{bookmarks:records}},
  t:k=>k,toast:m=>toasts.push(m),saveUserSettings:()=>{throw new Error('Legacy writes forbidden');}},
  apiClient:{ajax:request=>{calls.push(request);return ajax(request);}}});
 t.after(()=>h.close());h.load('enhanced/bookmarks/bookmarks.js');
 return {...h,calls,toasts};
}
test('queued operations use only successful receipts; a conflict whose document cannot be read again rolls back and keeps the revision',async t=>{
 const first=deferred();let count=0;
 const h=setup(t,()=>++count===1?first.promise:Promise.reject({status:409}));
 h.expectConsoleError(/Failed to update bookmark/);h.expectConsoleError(/Failed to delete bookmark/);
 const a=h.JE.bookmarks.update('A',{label:'saved'}), b=h.JE.bookmarks.update('A',{label:'stale'});
 await tick();assert.equal(h.calls.length,1);
 first.resolve({Revision:'loaded:2'});assert.equal(await a,true);assert.equal(await b,false);
 assert.equal(h.JE.userConfig.bookmark.bookmarks.A.label,'saved');assert.equal(h.JE.userConfig.bookmarkRevision,'loaded:2');
 assert.equal(await h.JE.bookmarks.delete('A'),false);await tick();
 const posts=h.calls.filter(c=>c.type==='POST');assert.equal(posts.length,3);assert.ok(posts.every(c=>c.url.endsWith('/bookmark-document')));
 assert.deepEqual(posts.map(c=>JSON.parse(c.data).Revision),['loaded:1','loaded:2','loaded:2']);
 assert.ok(h.toasts.some(m=>/another tab.*Reload/.test(m)));
});
test('copy and replace send stored provenance and metadata, never source extensions or a whole document',async t=>{
 const h=setup(t,async()=>({Revision:'loaded:2'}),{Bm_UPPER:{itemId:'old',timestamp:4,label:'keep',createdAt:'creation',tmdbId:'old-provider',tvdbId:'old-tv',future:Infinity}});
 const result=await h.JE.bookmarks.syncBookmarks([{id:'Bm_UPPER',...h.JE.userConfig.bookmark.bookmarks.Bm_UPPER}],{itemId:'new',seasonNumber:1,episodeNumber:2},3,{replaceOriginals:true});
 const request=JSON.parse(h.calls[0].data),op=request.Operations[0];
 assert.equal(op.Kind,'replace');assert.equal(op.SourceId,'Bm_UPPER');assert.equal(op.ExpectedItemId,'old');assert.equal(op.Offset,3);
 assert.equal(op.Id,result[0].id);assert.equal(op.Fields.itemId,'new');assert.equal(op.Fields.tmdbId,null);assert.equal(op.Fields.tvdbId,null);assert.equal(result[0].tmdbId,null);
 for(const field of ['future','timestamp','label','createdAt','bookmarks'])assert.equal(field in op.Fields,false);
 assert.equal(result[0].future,Infinity);
});
test('missing revision refuses saves and never silently falls back',async t=>{
 const h=setup(t,async()=>{throw new Error('must not call');});delete h.JE.userConfig.bookmarkRevision;
 h.expectConsoleError(/Failed to update bookmark/);
 assert.equal(await h.JE.bookmarks.update('A',{label:'lost'}),false);assert.equal(h.calls.length,0);
 assert.equal(h.JE.userConfig.bookmark.bookmarks.A.label,'before');assert.match(h.toasts[0],/Reload/);
});
for(const receipt of [null,{}, {Revision:7}, {Revision:'next',Unexpected:true}])test(`invalid receipt ${JSON.stringify(receipt)} rolls back and retains the loaded token`,async t=>{
 const h=setup(t,async()=>receipt);h.expectConsoleError(/Failed to update bookmark/);
 assert.equal(await h.JE.bookmarks.update('A',{label:'changed'}),false);
 assert.equal(h.JE.userConfig.bookmark.bookmarks.A.label,'before');assert.equal(h.JE.userConfig.bookmarkRevision,'loaded:1');assert.equal(h.calls.length,1);
});
test('failed first mutation rolls back before copy resolves its stored selection',async t=>{
 const pending=deferred();let count=0;
 const h=setup(t,()=>++count===1?pending.promise:Promise.resolve({Revision:'loaded:2'}));h.expectConsoleError(/Failed to update bookmark/);
 const selection=[{id:'A',...h.JE.userConfig.bookmark.bookmarks.A}];
 const edit=h.JE.bookmarks.update('A',{timestamp:99,label:'failed'});const copy=h.JE.bookmarks.syncBookmarks(selection,{itemId:'new'},2);
 await tick();pending.reject(new Error('offline'));assert.equal(await edit,false);
 const result=await copy;assert.equal(result[0].timestamp,7);assert.equal(result[0].label,'before');
 assert.equal(JSON.parse(h.calls[1].data).Revision,'loaded:1');
});
test('bound token change blocks mutations before sending',async t=>{
 const h=setup(t,async()=>({Revision:'unexpected'}));h.expectConsoleError(/Failed to update bookmark/);
 h.JE.userConfig.bookmarkBinding={client:h.window.ApiClient,userId:h.window.ApiClient.getCurrentUserId(),baseUrl:h.window.ApiClient.getUrl('/'),token:'old'};
 h.window.ApiClient.accessToken=()=> 'new';
 assert.equal(await h.JE.bookmarks.update('A',{label:'changed'}),false);assert.equal(h.calls.length,0);
});
test('successful old-owner receipt never updates a new owner revision',async t=>{
 const pending=deferred();const h=setup(t,()=>pending.promise);
 const owner=h.JE.userConfig;const saving=h.JE.bookmarks.update('A',{label:'saved'});await tick();
 h.JE.userConfig={bookmarkRevision:'other',bookmark:{bookmarks:{}}};pending.resolve({Revision:'saved:2'});
 assert.equal(await saving,true);assert.equal(owner.bookmarkRevision,'saved:2');assert.equal(h.JE.userConfig.bookmarkRevision,'other');assert.deepEqual(plain(h.JE.userConfig.bookmark.bookmarks),{});
});

test('undefined partial edit fields are omitted consistently from memory and the operation',async t=>{
 const h=setup(t,async()=>({Revision:'loaded:2'}));
 assert.equal(await h.JE.bookmarks.update('A',{label:undefined,timestamp:7}),true);
 assert.equal(h.JE.userConfig.bookmark.bookmarks.A.label,'before');
 assert.deepEqual(JSON.parse(h.calls[0].data).Operations[0].Fields,{timestamp:7});
});
test('a save after another device changed the document reads it again, sends the same change once more and shows both',async t=>{
 const stored={Bookmarks:{A:{ItemId:'old',Timestamp:5,Label:'before'},P:{ItemId:'phone',Timestamp:9,Label:'from phone',SeasonNumber:1}},Extension:{kept:true}};
 let posts=0;
 const h=setup(t,async request=>{
  if(request.type==='GET'){assert.match(request.url,/\/JellyfinEnhanced\/user-settings\/user-a\/bookmark-document/);return {Document:JSON.stringify(stored),Revision:'phone:7'};}
  return ++posts===1?Promise.reject({status:409}):{Revision:'phone:8'};
 });
 assert.equal(await h.JE.bookmarks.update('A',{label:'saved'}),true);
 assert.deepEqual(h.calls.map(c=>c.type),['POST','GET','POST']);
 assert.deepEqual(h.calls.filter(c=>c.type==='POST').map(c=>JSON.parse(c.data).Revision),['loaded:1','phone:7']);
 assert.deepEqual(JSON.parse(h.calls[2].data).Operations,JSON.parse(h.calls[0].data).Operations);
 assert.equal(h.JE.userConfig.bookmarkRevision,'phone:8');
 const bookmarks=plain(h.JE.userConfig.bookmark.bookmarks);
 assert.equal(bookmarks.A.label,'saved');assert.equal(bookmarks.P.itemId,'phone');assert.equal(bookmarks.P.seasonNumber,1);
 assert.deepEqual(plain(h.JE.userConfig.bookmark.Extension),{kept:true});
 assert.deepEqual(h.toasts,[]);
 // The next save goes on from the new revision without another read.
 assert.equal(await h.JE.bookmarks.delete('P'),true);
 assert.deepEqual(h.calls.map(c=>c.type),['POST','GET','POST','POST']);assert.equal(JSON.parse(h.calls[3].data).Revision,'phone:8');
});
