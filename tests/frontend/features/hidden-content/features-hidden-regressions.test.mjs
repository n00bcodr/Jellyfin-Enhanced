import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHarness} from '../../helpers/harness.mjs';
const owned=JSON.parse(readFileSync('Jellyfin.Plugin.JellyfinEnhanced/js/component-scripts.json')).filter(p=>/^(enhanced\/hiddencontent\/|enhanced\/homeremoval\/)/.test(p));
function setup(t,{items={},settings={},ajax=async()=>({success:true}),html='',globals={}}={}){
 const frames=[];
 const h=createHarness({html,apiClient:{ajax,getDisplayPreferences:async()=>({CustomPrefs:{}})},globals:{requestAnimationFrame:fn=>frames.push(fn),...globals},JE:{
  userConfig:{hiddenContent:{items,settings}},pluginConfig:{HiddenContentEnabled:true},currentSettings:{removeContinueWatchingEnabled:true},state:{removeContext:null},t:k=>k,
  helpers:{isAdmin:()=>false,addCSS:()=>{},debounce:fn=>fn,onViewPage:()=>{},onBodyMutation:()=>{},onSidebarRebuilt:()=>{},isActiveTabContainer:()=>true,observeTabContainers:()=>{}},
  core:{api:{fetch:async()=>({Items:[]})},ui:{skeletonGridHtml:()=>''}}
 }});
 t.after(()=>h.close());h.load('core/session.js');
 for(const p of owned)h.load(p);
 h.JE.initializeHiddenContent();
 return {...h,api:h.JE.hiddenContent,internal:h.JE.internals.hiddenContent,frames(){while(frames.length)frames.shift()();}};
}
test('HC-R1-001 new-session hide must use the replacement ApiClient, never the prior server',async t=>{
 const oldWrites=[],newWrites=[];
 const h=setup(t,{ajax:async r=>{oldWrites.push(r);return {};}});
 h.window.ApiClient={...h.window.ApiClient,getCurrentUserId:()=> 'user-b',serverId:()=> 'server-b',getUrl:p=>'http://server-b'+p,ajax:async r=>{newWrites.push(r);return {};}};
 h.JE.session.checkNow('server-replaced');
 h.JE.userConfig={hiddenContent:{items:{b:{itemId:'b',name:'B private'}},settings:{}}};
 h.document.dispatchEvent(new h.window.Event('je:user-data-loaded'));
 h.api.hideItem({itemId:'c',name:'B new hide'});await h.api.flushPendingSave();
 assert.equal(oldWrites.length,0,'must not overwrite old server/user document with new account data');
 assert.equal(newWrites.length,1);
});
test('HC-R1-002 unchanged successful refresh must leave Undo applicable',async t=>{
 let server={items:{},settings:{}};
 const h=setup(t,{ajax:async r=>{if(r.type==='POST'){server=JSON.parse(r.data);return {};}return structuredClone(server);}});
 h.api.hideItem({itemId:'a',name:'A'});await h.api.flushPendingSave();
 assert.equal(await h.api.refresh(),true);
 h.document.querySelector('.je-undo-btn').click();await h.api.flushPendingSave();
 assert.equal(h.api.isHidden('a'),false,'unchanged item is still this hide operation');
 assert.deepEqual(server.items,{});
});
test('HC-R1-003 ordinary hide must retain the original hiddenAt',async t=>{
 const hiddenAt='2020-03-04T05:06:07.1234567+08:00';let saved;
 const h=setup(t,{items:{a:{itemId:'a',hideScope:'nextup',hiddenAt,FutureField:{ExactCase:1}}},ajax:async r=>{saved=JSON.parse(r.data);return {};}});
 h.api.hideItem({itemId:'a',name:'A',hideScope:'global'});await h.api.flushPendingSave();
 assert.equal(saved.items.a.hiddenAt,hiddenAt);
});
test('HC-R1-004 scoped hide choice must retain the other home scope',async t=>{
 const h=setup(t,{items:{a:{itemId:'a',hideScope:'continuewatching'}},settings:{showButtonLibrary:true},html:'<div class="section nextup"><h2>Next Up</h2><div class="card" data-id="a"><div class="cardBox"><span class="cardText">A</span></div></div></div>'});
 h.window.ApiClient.getItem=async()=>({Id:'a',Name:'A',Type:'Movie'});
 h.api.addLibraryHideButtons();h.document.querySelector('.je-hide-btn').click();
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(h.document.querySelector('.je-hide-confirm-hide').textContent,'hidden_content_confirm_hide_nextup_only');
 h.document.querySelector('.je-hide-confirm-hide').click();
 assert.equal(h.api.isHiddenOnSurface('a','continuewatching'),true);
 assert.equal(h.api.isHiddenOnSurface('a','nextup'),true);
});
test('HC-R1-005 disabling filtering must invalidate queued direct-card hide frames',t=>{
 const h=setup(t,{items:{a:{itemId:'a'}},html:'<div class="section nextup"><div class="card" data-id="a"></div></div>'});
 h.api.filterNativeCards();h.api.updateSettings({enabled:false});h.frames();
 assert.equal(h.document.querySelector('.card').classList.contains('je-hidden'),false);
});

for(const change of ['client','token','base'])test(`HC-R1-001 unloaded ${change} replacement cannot save the previous policy`,t=>{
 const calls=[];const h=setup(t,{items:{a:{itemId:'a'}},ajax:async r=>{calls.push(r);return {};}});
 if(change==='client')h.window.ApiClient={...h.window.ApiClient};
 if(change==='token')h.window.ApiClient.accessToken=()=> 'replacement-token';
 if(change==='base')h.window.ApiClient.getUrl=p=>'http://jellyfin.test/other'+p;
 assert.throws(()=>h.api.hideItem({itemId:'b'}),/policy unavailable/);
 assert.throws(()=>h.api.updateSettings({enabled:false}),/policy unavailable/);
 assert.equal(calls.length,0);
});
test('HC-R1-001 sent and queued writes remain bound to their original owners',async t=>{
 let complete;const pending=new Promise(resolve=>{complete=resolve;});const oldWrites=[],newWrites=[];
 const h=setup(t,{ajax:async r=>{oldWrites.push(r);return pending;}});
 h.api.hideItem({itemId:'old'});const oldSave=h.api.flushPendingSave();await new Promise(r=>setImmediate(r));
 h.window.ApiClient={...h.window.ApiClient,getCurrentUserId:()=> 'user-b',serverId:()=> 'server-b',getUrl:p=>'http://server-b'+p,ajax:async r=>{newWrites.push(r);return {};}};
 h.JE.session.checkNow('test');h.JE.userConfig={hiddenContent:{items:{},settings:{}}};h.document.dispatchEvent(new h.window.Event('je:user-data-loaded'));
 h.api.hideItem({itemId:'new'});const newSave=h.api.flushPendingSave();complete({});await Promise.all([oldSave,newSave]);
 assert.equal(oldWrites.length,1);assert.deepEqual(Object.keys(JSON.parse(oldWrites[0].data).items),['old']);
 assert.equal(newWrites.length,1);assert.deepEqual(Object.keys(JSON.parse(newWrites[0].data).items),['new']);
});
test('HC-R1-002 later identical hide still supersedes an earlier Undo',t=>{
 const h=setup(t),undo=[];h.internal.showUndoToast=(_name,_key,fn)=>undo.push(fn);
 h.api.hideItem({itemId:'a',name:'A'});h.api.hideItem({itemId:'a',name:'A'});undo[0]();
 assert.equal(h.api.isHidden('a'),true);
});
test('HC-R1-002 changed remote policy cannot revive an old Undo by reverting its contents',async t=>{
 let server={items:{},settings:{}};const undo=[];
 const h=setup(t,{ajax:async r=>{if(r.type==='POST'){server=JSON.parse(r.data);return {};}return structuredClone(server);}});
 h.internal.showUndoToast=(_name,_key,fn)=>undo.push(fn);h.api.hideItem({itemId:'a',name:'A'});await h.api.flushPendingSave();
 const original=structuredClone(server);server.items.a.name='remote edit';await h.api.refresh();server=original;await h.api.refresh();undo[0]();
 assert.equal(h.api.isHidden('a'),true);
});
test('HC-R1-003/004 aliases retain earliest instant, both scopes and extensions; Undo restores the exact records',t=>{
 const dashed='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',compact=dashed.replaceAll('-','');
 const items={
  [dashed]:{itemId:dashed,hideScope:'continuewatching',hiddenAt:'2020-03-04T05:06:07.1234567+08:00',First:{ExactCase:1}},
  [compact]:{itemId:compact,hideScope:'nextup',hiddenAt:'2020-03-04T00:00:00.0000000Z',Second:'keep'}
 };
 const h=setup(t,{items});h.api.hideItem({itemId:compact,hideScope:'nextup'});
 const merged=h.internal.getHiddenData().items[compact];assert.equal(merged.hiddenAt,items[dashed].hiddenAt);
 assert.equal(merged.hideScope,'homesections');assert.equal(merged.First.ExactCase,1);assert.equal(merged.Second,'keep');
 h.document.querySelector('.je-undo-btn').click();assert.deepEqual(JSON.parse(JSON.stringify(h.internal.getHiddenData().items)),items);
});
for(const method of ['filterNativeCards','filterAllNativeCards'])for(const transition of ['disable','unhide','recycle'])test(`HC-R1-005 ${method} rejects stale visibility after ${transition}`,t=>{
 const h=setup(t,{items:{a:{itemId:'a'}},html:'<div class="section nextup"><div class="card" data-id="a"></div></div>'});
 h.internal[method]();
 if(transition==='disable')h.api.updateSettings({enabled:false});
 if(transition==='unhide')h.api.unhideItem('a');
 if(transition==='recycle')h.document.querySelector('.card').dataset.id='b';
 h.frames();assert.equal(h.document.querySelector('.card').classList.contains('je-hidden'),false);
});

const dashed='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',compact=dashed.replaceAll('-','');
for(const method of ['ordinary','scoped'])for(const [later,earlier] of [
 ['2020-01-01T00:00:00.1239999Z','2020-01-01T08:00:00.1230001+08:00'],
 ['1960-01-01T00:00:00.999999999Z','1960-01-01T00:00:00.999999998Z'],
 ['2020-01-01T00:00:00.123001Z','2020-01-01T00:00:00.123Z']
])test(`HC-R2-001 ${method} preserves full timestamp precision: ${earlier}`,t=>{
 const h=setup(t,{items:{[compact]:{itemId:compact,hiddenAt:later},[dashed]:{itemId:dashed,hiddenAt:earlier}}});
 if(method==='ordinary')h.api.hideItem({itemId:compact});else h.internal.markScopedHidden(compact);
 assert.equal(h.internal.getHiddenData().items[compact].hiddenAt,earlier);
});
for(const method of ['ordinary','scoped'])for(const empty of [false,true])test(`HC-R2-002 ${method} preserves alias metadata (empty=${empty})`,async t=>{
 const metadata={name:'Known title',type:'Episode',tmdbId:123,posterPath:'/poster',seriesId:'series',seriesName:'Known series',seasonNumber:0,episodeNumber:3};
 const primary=empty?{name:'',type:'',tmdbId:'',posterPath:'',seriesId:'',seriesName:'',seasonNumber:null,episodeNumber:null}:{};
 const items={[compact]:{itemId:compact,...primary},[dashed]:{itemId:dashed,...metadata,Extra:{Case:1}}};
 let saved;const h=setup(t,{items,ajax:async r=>{saved=JSON.parse(r.data);return {};}});
 if(method==='ordinary'){h.api.hideItem({itemId:compact,hideScope:'nextup'});await h.api.flushPendingSave();}
 else {h.internal.markScopedHidden(compact,'nextup');saved=h.internal.getHiddenData();}
 const result=saved.items[compact];for(const [key,value] of Object.entries(metadata))assert.equal(result[key],value,key);
 assert.equal(result.Extra.Case,1);
 if(method==='ordinary'){h.document.querySelector('.je-undo-btn').click();assert.deepEqual(JSON.parse(JSON.stringify(h.internal.getHiddenData().items)),items);}
});
test('HC-R2-002 explicit new metadata overrides alias fallback, including null episode values',t=>{
 const h=setup(t,{items:{[dashed]:{itemId:dashed,name:'Alias',seasonNumber:2},[compact]:{itemId:compact,name:'Primary',seasonNumber:1}}});
 h.api.hideItem({itemId:compact,name:'',seasonNumber:null});
 assert.equal(h.internal.getHiddenData().items[compact].name,'');assert.equal(h.internal.getHiddenData().items[compact].seasonNumber,null);
});
for(const transition of ['undo','settings-revert','reset'])test(`HC-R2-003 refresh rejects intervening ${transition}`,async t=>{
 let finish;const h=setup(t,{settings:{enabled:true},ajax:r=>r.type==='GET'?new Promise(resolve=>finish=resolve):Promise.resolve({})});
 const refresh=h.api.refresh();
 if(transition==='undo'){h.api.hideItem({itemId:'a'});h.document.querySelector('.je-undo-btn').click();}
 if(transition==='settings-revert'){h.api.updateSettings({enabled:false});h.api.updateSettings({enabled:true});}
 if(transition==='reset')h.internal.resetFromUserConfig();
 finish({items:{a:{itemId:'a',name:'Stale remote hide'}},settings:{}});
 assert.equal(await refresh,false);assert.equal(h.api.isHidden('a'),false);
});
test('HC-R2-003 overlapping refreshes accept only the newest request',async t=>{
 const pending=[];const h=setup(t,{ajax:()=>new Promise(resolve=>pending.push(resolve))});
 const first=h.api.refresh(),second=h.api.refresh();
 pending[0]({items:{old:{itemId:'old'}},settings:{}});assert.equal(await first,false);
 pending[1]({items:{new:{itemId:'new'}},settings:{}});assert.equal(await second,true);
 assert.equal(h.api.isHidden('new'),true);assert.equal(h.api.isHidden('old'),false);
});

for(const method of ['ordinary','scoped'])for(const [label,later,earlier] of [
 ['offset-rollover','2020-01-01T00:00:00.0000002Z','2019-12-31T19:00:00.0000001-05:00'],
 ['compact-offset','2020-01-01T00:00:00.0000002Z','2020-01-01T08:00:00.0000001+0800'],
 ['unequal-length','2020-01-01T00:00:00.10000001Z','2020-01-01T00:00:00.1Z'],
 ['pre-epoch-second','1969-12-31T23:59:59.9999999Z','1969-12-31T23:59:58.99999999Z'],
 ['lowercase-t','2020-01-01T00:00:00.1230002Z','2020-01-01t08:00:00.1230003+08:00'],
 ['no-offset','2020-01-01T00:00:00.1230002','2020-01-01T00:00:00.1230001']
])test(`HC-R3-001 timestamp ${method} ${label}`,async t=>{
 // lowercase-t deliberately supplies a LATER second alias: truncated fallback must not select it.
 const expected=label==='lowercase-t'?later:earlier;
 assert.ok(Number.isFinite(Date.parse(later))&&Number.isFinite(Date.parse(earlier)));
 let saved;const h=setup(t,{items:{[compact]:{itemId:compact,hiddenAt:later},[dashed]:{itemId:dashed,hiddenAt:earlier}},ajax:async r=>{saved=JSON.parse(r.data);return {};}});
 if(method==='ordinary'){h.api.hideItem({itemId:compact});await h.api.flushPendingSave();}else {h.api.markScopedHidden(compact,'nextup');h.api.updateSettings({enabled:true});await h.api.flushPendingSave();}
 assert.equal(saved.items[compact].hiddenAt,expected);
});

const tick=()=>new Promise(resolve=>setImmediate(resolve));
for(const mode of ['no-edit','unhide','hide-undo','bootstrap','unhide-all','unrelated','settings','alias-undo'])test(`HC-R3-002 scoped acknowledgement respects ${mode}`,async t=>{
 let finish;const writes=[];const id=mode==='alias-undo'?compact:'a';
 const h=setup(t,{ajax:r=>r.url.includes('/next-up/hide/')?new Promise(resolve=>finish=resolve):Promise.resolve((writes.push(JSON.parse(r.data)),{}))});
 const pending=h.JE.internals.features.removeFromHomeSurface(id,'nextup');await tick();assert.ok(finish);
 if(mode==='unhide')h.api.unhideItem(id);
 if(mode==='hide-undo'||mode==='alias-undo'){h.api.hideItem({itemId:mode==='alias-undo'?dashed:id});h.document.querySelector('.je-undo-btn').click();}
 if(mode==='bootstrap'){h.JE.userConfig.hiddenContent={items:{},settings:{}};h.document.dispatchEvent(new h.window.Event('je:user-data-loaded'));}
 if(mode==='unhide-all')h.api.unhideAll();
 if(mode==='unrelated')h.api.hideItem({itemId:'b'});
 if(mode==='settings')h.api.updateSettings({filterSearch:true});
 const correcting=['unhide','hide-undo','alias-undo','unhide-all'].includes(mode);
 const correction=correcting?h.api.flushPendingSave():Promise.resolve();
 finish({success:true});assert.equal(await pending,true);await correction;
 const expected=['no-edit','unrelated','settings'].includes(mode);
 assert.equal(h.api.isHiddenOnSurface(id,'nextup'),expected);
 if(correcting)assert.deepEqual(writes.at(-1).items,{});
});
test('HC-R3-002 newer unhide cancels a scoped write still waiting for a prior save',async t=>{
 let finish;const urls=[];const h=setup(t,{ajax:r=>{urls.push(r.url);return urls.length===1?new Promise(resolve=>finish=resolve):Promise.resolve({success:true});}});
 h.api.hideItem({itemId:'b'});const saving=h.api.flushPendingSave();await tick();
 const pending=h.JE.internals.features.removeFromHomeSurface('a','nextup');h.api.unhideItem('a');
 finish({});await saving;assert.equal(await pending,false);assert.equal(urls.some(url=>url.includes('/next-up/hide/')),false);
});
test('HC-R3-002 sequential scoped actions on the same item still compose home scopes',async t=>{
 let finish;const urls=[];const h=setup(t,{ajax:r=>{urls.push(r.url);if(urls.length===1)return new Promise(resolve=>finish=resolve);return Promise.resolve({success:true});}});
 const first=h.JE.internals.features.removeFromHomeSurface('a','nextup');await tick();
 const second=h.JE.internals.features.removeFromHomeSurface('a','continuewatching');finish({success:true});
 assert.equal(await first,true);assert.equal(await second,true);assert.equal(urls.length,2);
 assert.equal(h.api.isHiddenOnSurface('a','nextup'),true);assert.equal(h.api.isHiddenOnSurface('a','continuewatching'),true);
});

for(const event of ['hashchange','popstate','viewhide'])test(`HC-R4B-001 same-account ${event} retains usable Undo`,async t=>{
 let saved;const h=setup(t,{ajax:async r=>{saved=JSON.parse(r.data);return {};}});
 h.api.hideItem({itemId:'a'});assert.ok(h.document.querySelector('.je-undo-btn'));
 if(event==='viewhide')h.document.dispatchEvent(new h.window.Event(event));
 else {h.window.history.replaceState({},'', '#/details?id=another');h.window.dispatchEvent(new h.window.Event(event));}
 assert.ok(h.document.querySelector('.je-undo-btn'));h.document.querySelector('.je-undo-btn').click();await h.api.flushPendingSave();assert.deepEqual(saved.items,{});
});
test('HC-R4B-001 identity change dismisses Undo synchronously',t=>{
 const h=setup(t);h.api.hideItem({itemId:'a'});
 h.window.ApiClient={...h.window.ApiClient,getCurrentUserId:()=> 'user-b'};h.JE.session.checkNow('test');
 assert.equal(h.document.querySelector('.je-undo-btn'),null);
});
test('HC-R4B-001 replacement and expiry release toast timers and callbacks',t=>{
 const timers=new Map();let next=0;
 const h=setup(t,{globals:{setTimeout:(fn,delay)=>{const id=++next;timers.set(id,{fn,delay});return id;},clearTimeout:id=>timers.delete(id)}});
 h.api.hideItem({itemId:'a'});h.api.hideItem({itemId:'b'});
 assert.equal(h.document.querySelectorAll('.je-undo-toast').length,1);
 assert.equal([...timers.values()].filter(t=>t.delay===8000).length,1);
 const expiry=[...timers.values()].find(t=>t.delay===8000);expiry.fn();
 const fade=[...timers.values()].find(t=>t.delay===300);fade.fn();assert.equal(h.document.querySelector('.je-undo-toast'),null);
});
for(const firstKind of ['scoped','document'])for(const change of ['user','server'])test(`HC-R4B-002 pending ${firstKind} write does not block new ${change} document`,async t=>{
 let finish;const oldWrites=[],newWrites=[];
 const h=setup(t,{ajax:r=>{oldWrites.push(r);return new Promise(resolve=>finish=resolve);}});
 let first;if(firstKind==='scoped')first=h.JE.internals.features.removeFromHomeSurface('a','nextup');else {h.api.hideItem({itemId:'a'});first=h.api.flushPendingSave();}
 await tick();assert.equal(oldWrites.length,1);
 const oldApi=h.window.ApiClient;
 h.window.ApiClient={...oldApi,getCurrentUserId:()=>change==='user'?'user-b':oldApi.getCurrentUserId(),getUrl:p=>change==='server'?'http://server-b'+p:oldApi.getUrl(p),ajax:async r=>{newWrites.push(r);return {};}};
 h.JE.session.checkNow('test');h.JE.userConfig={hiddenContent:{items:{},settings:{}}};h.document.dispatchEvent(new h.window.Event('je:user-data-loaded'));
 h.api.hideItem({itemId:'b'});const second=h.api.flushPendingSave();await tick();
 try {assert.equal(newWrites.length,1,'new destination must send before old response settles');assert.deepEqual(Object.keys(JSON.parse(newWrites[0].data).items),['b']);}
 finally {finish({success:true});await Promise.all([first,second]);}
 assert.deepEqual(Object.keys(h.internal.getHiddenData().items),['b']);
});
test('HC-R4B-002 returning to the same document retains its pending write barrier',async t=>{
 let finish;const writes=[];const h=setup(t,{ajax:r=>{writes.push(r);return new Promise(resolve=>finish=resolve);}});
 const original=h.window.ApiClient;h.api.hideItem({itemId:'old-a'});const first=h.api.flushPendingSave();await tick();
 h.window.ApiClient={...original,getCurrentUserId:()=> 'user-b',ajax:async()=>({})};h.JE.session.checkNow('b');
 h.JE.userConfig={hiddenContent:{items:{},settings:{}}};h.document.dispatchEvent(new h.window.Event('je:user-data-loaded'));
 h.api.hideItem({itemId:'b'});const b=h.api.flushPendingSave();await tick();
 h.window.ApiClient={...original,ajax:async r=>{writes.push(r);return {};}};h.JE.session.checkNow('a-again');
 h.JE.userConfig={hiddenContent:{items:{},settings:{}}};h.document.dispatchEvent(new h.window.Event('je:user-data-loaded'));
 h.api.hideItem({itemId:'new-a'});const second=h.api.flushPendingSave();await tick();assert.equal(writes.length,1);
 finish({});await Promise.all([first,b,second]);assert.equal(writes.length,2);assert.deepEqual(Object.keys(JSON.parse(writes[1].data).items),['new-a']);
});

for(const method of ['ordinary','scoped'])for(const [label,early,late] of [
 ['mixed-later-minute','2020-01-01T00:00:00.1230002Z','Jan 1 2020 00:0:00.1230003 GMT'],
 ['mixed-later-second','2020-01-01T00:00:00.1230002Z','Jan 1 2020 00:00:0.1230003 GMT'],
 ['single-minute','Jan 1 2020 00:0:00.1230001 GMT','2020-01-01T00:00:00.1230002Z'],
 ['single-second','Jan 1 2020 00:00:0.1230001 GMT','2020-01-01T00:00:00.1230002Z'],
 ['single-all','Jan 1 2020 0:0:0.1230001 GMT','Jan 1 2020 0:0:0.1230002 GMT'],
 ['comment-clock','(01:02:03.9999999) Jan 1 2020 00:00:00.1230001 GMT','2020-01-01T00:00:00.1230002Z'],
 ['rfc-clock','Wed, 01 Jan 2020 00:00:00.1230001 GMT','2020-01-01T00:00:00.1230002Z'],
 ['single-hour','Jan 1 2020 0:00:00.1230001 GMT','2020-01-01T00:00:00.1230002Z'],
 ['pre-epoch','Dec 31 1969 23:59:59.1230001 GMT','1969-12-31T23:59:59.1230002Z']
])test(`HC-R4-001 timestamp ${method} ${label}`,async t=>{
 assert.equal(Date.parse(early),Date.parse(late));assert.ok(Number.isFinite(Date.parse(early)));
 let saved;const h=setup(t,{items:{[compact]:{itemId:compact,hiddenAt:late,hideScope:'nextup'},[dashed]:{itemId:dashed,hiddenAt:early,hideScope:'nextup'}},ajax:async r=>{saved=JSON.parse(r.data);return {};}});
 if(method==='ordinary')h.api.hideItem({itemId:compact});else {h.api.markScopedHidden(compact,'continuewatching');h.api.updateSettings({enabled:true});}
 await h.api.flushPendingSave();assert.equal(saved.items[compact].hiddenAt,early);
});

for(const method of ['ordinary','scoped'])for(const [label,early,late] of [
 ['nested-comment','(outer (clock 1:2:3.9999999)) Jan 1 2020 0:0:0.1230001 GMT','2020-01-01T00:00:00.1230002Z'],
 ['date-dots','2020.01.01 0:0:0.1230001 GMT','2020-01-01T00:00:00.1230002Z'],
 ['fraction-comment','(0.0000001) Jan 1 2020 0:0:0.1230001 GMT','2020-01-01T00:00:00.1230002Z'],
 ['maximum-date','+275760-09-13T00:00:00.0000001Z','+275760-09-13T00:00:00.0000002Z'],
 ['minimum-date','-271821-04-20T00:00:00.0000001Z','-271821-04-20T00:00:00.0000002Z']
])test(`HC-R4-001 ${method} identifies effective fraction in ${label}`,t=>{
 assert.ok(Number.isFinite(Date.parse(early)));assert.equal(Date.parse(early),Date.parse(late));
 const h=setup(t,{items:{[compact]:{itemId:compact,hiddenAt:late},[dashed]:{itemId:dashed,hiddenAt:early}}});
 if(method==='ordinary')h.api.hideItem({itemId:compact});else h.api.markScopedHidden(compact,'nextup');
 assert.equal(h.internal.getHiddenData().items[compact].hiddenAt,early);
});
