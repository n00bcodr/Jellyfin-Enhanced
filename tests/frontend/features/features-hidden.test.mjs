import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHarness,deferred} from '../helpers/harness.mjs';
// Hidden Content keeps its document in the settings store (config.js): every change is an operation the server answers.
// A test's own `patch` answers the store's PATCHes (else at once).
const patching=(ajax,patch)=>async request=>request.type==='PATCH'?(patch?patch(request):{success:true}):ajax(request);
function setup(t,{items={},settings={},html='',ajax=async()=>({Items:[]}),patch}={}){
 let epoch=0; const handlers=new Map();const frames=[];
 const h=createHarness({html,apiClient:{ajax:patching(ajax,patch)},globals:{requestAnimationFrame:fn=>frames.push(fn)},JE:{userConfig:{hiddenContent:{items,settings}},session:{getEpoch:()=>epoch,isCurrent:e=>e===epoch,onUserChange:(key,fn)=>handlers.set(key,fn)}}});
 t.after(()=>h.close());
 h.load('core/mutation-queue.js'); h.load('enhanced/config.js');h.load('enhanced/hiddencontent/hidden-content-data.js');h.load('enhanced/hiddencontent/hidden-content-save.js');h.load('enhanced/hiddencontent/hidden-content-filter.js');
 const api=h.JE.internals.hiddenContent;api.resetFromUserConfig();
 return {...h,get NATIVE(){return h.NATIVE;},api,flush(){while(frames.length)frames.shift()();},switchUser(){epoch++;h.JE.userConfig={hiddenContent:{items:{},settings:{}}};for(const fn of handlers.values())fn({userId:'next'});}};
}
for (const type of ['Movie','Series']) for (const mode of ['confirm','cancel','preference','timer','switch'])
 test(`native ${type} provider hide respects ${mode} before persistence`,async t=>{
  const writes=[];
  const h=setup(t,{html:`<div class="card" data-id="library" data-type="${type}" data-tmdb-id="42"><div class="cardBox"></div><div class="cardText">Entry</div></div>`,
   settings:{enabled:true,showHideButtons:true,showButtonLibrary:true,showHideConfirmation:mode!=='preference'},
   ajax:async o=>{writes.push(o);return {success:true};}});
  h.JE.t=k=>k;
  h.JE.session.userScopedKey=k=>k+':anonymous';
  h.load('enhanced/hiddencontent/hidden-content-dialogs.js');
  if(mode==='timer') h.window.localStorage.setItem('je_hide_confirm_suppressed_until:anonymous',new Date(Date.now()+60000).toISOString());
  h.load('enhanced/hiddencontent/hidden-content-buttons.js');h.api.addLibraryHideButtons();
  const card=h.document.querySelector('.card');const button=card.querySelector('.je-hide-btn');assert.ok(button);
  await h.viewerPress(button);
  const dialog=h.document.querySelector('.je-hide-confirm-overlay');
  if(mode==='confirm'||mode==='cancel'||mode==='switch'){
   assert.ok(dialog,'confirmation opens');assert.equal(writes.length,0,'no persistence before confirmation');
   assert.equal(card.classList.contains('je-hidden'),false);
   if(mode==='switch') h.switchUser();
   dialog.querySelector(mode==='cancel'?'.je-hide-confirm-cancel':'.je-hide-confirm-hide').click();
  }else assert.equal(dialog,null);
  await new Promise(r=>setImmediate(r));h.flush();
  assert.equal(writes.length,mode==='cancel'||mode==='switch'?0:1);
  assert.equal(card.classList.contains('je-hidden'),mode!=='cancel'&&mode!=='switch');
  if(writes.length) assert.ok(decodeURIComponent(writes[0].url).includes((type==='Movie'?'movie':'tv')+':tmdb:42'));
 });
for (const type of ['Movie','Series']) test(`ID-only native ${type} retains its provider hide across filter repaints`,async t=>{
 const h=setup(t,{html:`<div class="card" data-id="library" data-type="${type}"><div class="cardBox"></div><div class="cardText">Entry</div></div>`,
  settings:{enabled:true,showHideButtons:true,showButtonLibrary:true,showHideConfirmation:false}});
 h.JE.t=k=>k;h.window.ApiClient.getItem=async()=>({Type:type,ProviderIds:{Tmdb:'42'}});
 h.load('enhanced/hiddencontent/hidden-content-dialogs.js');h.load('enhanced/hiddencontent/hidden-content-buttons.js');
 h.api.addLibraryHideButtons();const card=h.document.querySelector('.card');
 await h.viewerPress(card.querySelector('.je-hide-btn'));
 h.api.refreshNativeCardVisibility();h.flush();
 assert.equal(card.classList.contains('je-hidden'),true,'a later filter paint must know the deliberately resolved provider');
 assert.equal(card.dataset.tmdbId,'42');
});

test('hidden scope filters home rows without hiding same title in the library',t=>{
 const h=setup(t,{items:{global:{itemId:'AA-BB'},next:{itemId:'CC-DD',hideScope:'nextup'}},html:'<div class="card" data-id="AABB"></div><div class="section"><h2>Next Up</h2><div class="card" data-id="ccdd"></div></div><div class="card" data-itemid="ccdd"></div>'});
 h.api.filterNativeCards();h.flush();const cards=h.document.querySelectorAll('.card');
 assert.equal(cards[0].classList.contains('je-hidden'),true);
 assert.equal(cards[1].classList.contains('je-hidden'),true);
 assert.equal(cards[2].classList.contains('je-hidden'),false);
 // Unhide goes through the filter (the one visibility writer): the card shows once its rule is gone.
 h.api.debouncedSave=()=>{};h.api.unhideItem('AA-BB');h.flush();
 assert.equal(cards[0].classList.contains('je-hidden'),false);
 assert.equal(cards[1].classList.contains('je-hidden'),true,'the scoped Next Up hide still applies');
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
 const h=setup(t,{items:{a:{itemId:'AA-BB',tmdbId:42,type:'Series',name:'Show (US)'},scoped:{itemId:'scoped',tmdbId:55,hideScope:'nextup'}}});
 assert.deepEqual(Array.from(h.api.filterRequestItems([{tmdbId:42,type:'Series'},{jellyfinMediaId:'AA-BB'},{tmdbId:55}]),x=>x.tmdbId),[55]);
 assert.equal(h.api.filterCalendarEvents([{title:'Show'},{title:'Visible'},{itemId:'AA-BB'}]).length,1);
 h.api.getHiddenData().settings.filterRequests=false;
 assert.equal(h.api.filterRequestItems([{tmdbId:42,type:'Series'}]).length,1);
 h.api.getHiddenData().settings.filterCalendar=false;
 assert.equal(h.api.filterCalendarEvents([{title:'Show'},{tmdbId:42,type:'Series'},{itemId:'AA-BB'}]).length,3);
});
test('switching users re-decides retained markers through an ordinary scan and clears cached policy',t=>{
 const h=setup(t,{items:{a:{itemId:'a',tmdbId:42,type:'Series'}},html:'<div class="card" data-id="a"></div>'});
 h.api.filterNativeCards();h.flush();assert.equal(h.api.getHiddenCount(),1);assert.equal(h.api.filterRequestItems([{tmdbId:42,type:'Series'}]).length,0);
 const card=h.document.querySelector('.card'),marker=card.getAttribute('data-je-hidden-checked');h.switchUser();
 assert.equal(card.getAttribute('data-je-hidden-checked'),marker,'session boundary does not sweep markers');h.flush();
 assert.equal(card.classList.contains('je-hidden'),false);assert.equal(h.api.hiddenIdSet.size,0);
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
 await h.viewerPress(btn);
 assert.deepEqual(Object.keys(api.getHiddenData().items),['movie:tmdb:42']);
 assert.equal(JSON.parse(writes[0].data).itemId,'');assert.equal(JSON.stringify(writes).includes(SYN),false);
 assert.equal(btn.getAttribute('aria-label'),'hidden_content_unhide');
 await api.unhideItem('movie:tmdb:42');assert.deepEqual(Object.keys(api.getHiddenData().items),[]);
 fail=true;await h.viewerPress(btn);
 assert.deepEqual(Object.keys(api.getHiddenData().items),[]);assert.equal(btn.textContent,'hidden_content_save_failed_persistent');
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
 await h.viewerPress(button);h.flush();
 assert.equal(root.classList.contains('je-hidden'),true);
 await h.api.unhideItem('movie:tmdb:42');h.flush();
 // The setting changes as the panel changes it (through the settings store).
 h.api.updateSettings({filterDiscovery:false});await new Promise(r=>setImmediate(r));
 await h.viewerPress(button);h.flush();
 assert.equal(root.classList.contains('je-hidden'),false);
});

for (const library of [true,false]) test(`native recommendation cards use their own surface in both passes and control mounting (library=${library})`,async t=>{
 const h=setup(t,{html:'<div id="itemDetailPage"><div id="similarCollapsible"><div class="card" data-id="synthetic" data-type="Movie"><div class="cardBox"></div></div></div></div>',items:{'movie:tmdb:42':{type:'Movie',tmdbId:'42'}},settings:{filterLibrary:library,filterRecommendations:!library,enabled:true,showHideButtons:true,showButtonJellyseerr:true}});
 h.window.location.hash='#/details?id=parent';h.JE.t=k=>k;
 h.JE.titleDetails={parse:id=>id==='synthetic'?{kind:'movie',tmdbId:42}:null,isSynthetic:id=>id==='synthetic'};
 const card=h.document.querySelector('.card');
 h.api.filterNativeCards();h.flush();assert.equal(card.classList.contains('je-hidden'),!library);
 h.api.filterAllNativeCards();h.flush();assert.equal(card.classList.contains('je-hidden'),!library);
 h.api.getHiddenData().items.native={itemId:'unrelated'};h.api.rebuildSets();
 h.api.refreshNativeCardVisibility();h.flush();assert.equal(card.classList.contains('je-hidden'),!library,'refresh uses each card surface');
 const timers=[];let onView;h.window.setTimeout=fn=>{timers.push(fn);return timers.length;};
 h.JE.helpers={onViewPage:fn=>{onView=fn;}};Object.assign(h.api,{addLibraryHideButtons:()=>{}});
 h.api.setupNativeObserver();onView();for(const fn of timers)fn();h.flush();
 assert.equal(card.classList.contains('je-hidden'),!library,'scheduled detail rescans use each card surface');
 h.load('enhanced/hiddencontent/hidden-content-buttons.js');h.api.addLibraryHideButtons();
 Object.assign(h.api,{showUndoToast:()=>{}});await h.api.unhideItem('movie:tmdb:42');h.flush();
 await h.viewerPress(card.querySelector('.je-hide-btn'));h.flush();
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







test('disabling the master restores provider-only cards and expires their scan scope',t=>{
 const h=setup(t,{items:{'movie:tmdb:42':{type:'Movie',tmdbId:'42'}},html:'<div class="card" data-id="synthetic" data-type="Movie"></div>'});
 h.JE.titleDetails={parse:()=>({kind:'movie',tmdbId:42})};h.api.filterAllNativeCards();h.flush();
 const card=h.document.querySelector('.card');assert.ok(card.classList.contains('je-hidden'));
 h.api.getHiddenData().settings.enabled=false;h.api.refreshNativeCardVisibility();h.flush();
 assert.equal(card.classList.contains('je-hidden'),false);assert.equal(h.api.nativeDecisionResolved(card),false,'the disable expires the old verdict');
 h.api.getHiddenData().settings.enabled=true;h.api.filterNativeCards();h.flush();assert.equal(card.classList.contains('je-hidden'),true,'re-enabled ordinary scan re-decides the retained node');
});

// Ported from D46's bulk-save tests (the play join replaced its debounced whole-document POST with the settings store's
// PATCH queue; title rules keep their own PUT/DELETE route): one ordered write path, no lost edits, no deadlock.
const tick=()=>new Promise(r=>setImmediate(r));
const settle=async(n=10)=>{for(let i=0;i<n;i++)await tick();};
/** A server model: PATCH applies the store's operation, PUT/DELETE a title rule; every answer carries the whole document. */
function modelSetup(t,{items={},hold={}}={}){
 const requests=[];let server=JSON.parse(JSON.stringify(items));let revision=1;
 const answer=()=>({success:true,revision:String(++revision),items:JSON.parse(JSON.stringify(server))});
 const h=setup(t,{items,
  patch:async o=>{requests.push(o);const op=JSON.parse(o.data);const n=requests.filter(r=>r.type==='PATCH').length;if(hold.patch?.[n-1])await hold.patch[n-1].promise;
   for(const key of op.Remove||op.remove||[])delete server[key];Object.assign(server,JSON.parse(JSON.stringify(op.Upsert||op.upsert||{})));return answer();},
  ajax:async o=>{if(o.type!=='PUT'&&o.type!=='DELETE')return {Items:[]};requests.push(o);if(hold.rule)await hold.rule.promise;
   const key=decodeURIComponent(o.url.split('/').pop());if(o.type==='PUT')server[key]=JSON.parse(o.data);else delete server[key];return answer();}});
 h.JE.t=k=>k;Object.assign(h.api,{showUndoToast:()=>{}});
 return {h,requests,server:()=>server};
}

test('a title rule goes out only after the item changes queued before it are answered',async t=>{
 const patch=deferred();const {h,requests}=modelSetup(t,{hold:{patch:[patch]}});
 h.api.hideItem({itemId:'item1',name:'Item',type:'Movie'});await settle();
 const hiding=h.api.saveTitleRule({mediaType:'movie',tmdbId:42,name:'Film'},true,h.NATIVE);await settle();
 assert.equal(requests.filter(o=>o.type==='PUT').length,0,'the rule waits for the item change queued before it');
 patch.resolve();assert.equal(await hiding,true);
 assert.deepEqual(requests.map(o=>o.type),['PATCH','PUT']);
 assert.equal(h.api.isHiddenByTmdbId(42,'movie'),true);
});

test('same-title rule writes after a queued item change neither overtake it nor deadlock',async t=>{
 const patch=deferred();const {h,requests}=modelSetup(t,{hold:{patch:[patch]}});
 h.api.hideItem({itemId:'item1',name:'Item',type:'Movie'});await settle();
 const first=h.api.saveTitleRule({type:'Movie',tmdbId:42},true,h.NATIVE);
 const second=h.api.saveTitleRule({type:'Movie',tmdbId:42},false,h.NATIVE);
 await settle();patch.resolve();
 await Promise.race([Promise.all([first,second]),new Promise((_,reject)=>setTimeout(()=>reject(new Error('persistence queue deadlocked')),2000))]);
 assert.deepEqual(requests.map(o=>o.type),['PATCH','PUT','DELETE']);assert.equal(h.api.isHiddenByTmdbId(42,'movie'),false);
});

test('a rule answer keeps the server\'s rule base and every local change through the store\'s later publications',async t=>{
 const rule=deferred();const {h,requests,server}=modelSetup(t,{items:{'tv:tmdb:51':{type:'Series',tmdbId:'51'}},hold:{rule}});
 const hiding=h.api.saveTitleRule({type:'Movie',tmdbId:42,name:'Film'},true,h.NATIVE);await settle();
 // An item hidden while the rule's answer is out (its PATCH is answered first).
 h.api.hideItem({itemId:'local',name:'Local',type:'Movie'});await settle();
 rule.resolve();assert.equal(await hiding,true);await settle();
 assert.equal(h.api.isHiddenByTmdbId(42,'movie'),true,'the new rule');
 assert.equal(h.api.isHiddenByTmdbId(51,'tv'),true,'the server\'s rule base');
 assert.ok(h.api.getHiddenData().items.local,'the local change');
 // A later item change: the store's next publication still has the rule (before: the store's copy lacked it and the title
 // was shown again until that change's own answer).
 const later=deferred();
 h.window.ApiClient.ajax=(prev=>async o=>{if(o.type==='PATCH'){await later.promise;}return prev(o);})(h.window.ApiClient.ajax);
 h.api.hideItem({itemId:'later',name:'Later',type:'Movie'});await settle();
 assert.equal(h.api.isHiddenByTmdbId(42,'movie'),true,'still hidden while the later change is out');
 later.resolve();await settle();
 assert.equal(h.api.isHiddenByTmdbId(42,'movie'),true);assert.ok(server()['movie:tmdb:42']);assert.ok(server().local);assert.ok(server().later);
 assert.deepEqual(requests.map(o=>o.type),['PUT','PATCH','PATCH']);
});

test('edits made before a rule, removals included, are all saved before it and none is lost',async t=>{
 const {h,requests,server}=modelSetup(t,{items:{native:{itemId:'native',type:'Movie'},kept:{itemId:'kept'}}});
 await h.api.unhideItem('native');
 h.api.hideItem({itemId:'added',name:'Added',type:'Movie'});
 await h.api.saveTitleRule({type:'Movie',tmdbId:42,name:'Film'},true,h.NATIVE);await settle();
 assert.deepEqual(requests.map(o=>o.type),['PATCH','PATCH','PUT']);
 assert.equal(h.api.getHiddenData().items.native,undefined);assert.ok(h.api.getHiddenData().items.added);
 assert.equal(server().native,undefined);assert.ok(server().added);assert.ok(server().kept);assert.ok(server()['movie:tmdb:42']);
});

test('a rule waits only for the item changes queued before it: later ones never hold it',async t=>{
 const first=deferred(),second=deferred();const {h,requests}=modelSetup(t,{hold:{patch:[first,second]}});
 h.api.hideItem({itemId:'one',name:'One',type:'Movie'});await settle();
 const hiding=h.api.saveTitleRule({type:'Movie',tmdbId:42},true,h.NATIVE);
 h.api.hideItem({itemId:'two',name:'Two',type:'Movie'});await settle();
 first.resolve();assert.equal(await hiding,true);
 assert.equal(requests.filter(o=>o.type==='PUT').length,1,'the rule went out while the later change is still out');
 second.resolve();await settle();assert.ok(h.api.getHiddenData().items.two);assert.equal(h.api.isHiddenByTmdbId(42,'movie'),true);
});

test('an acknowledged save tells the page the server now answers with the saved rules',async t=>{
 const acknowledgement=deferred(),saved=[];const h=setup(t,{patch:()=>acknowledgement.promise});
 h.JE.t=k=>k;h.load('enhanced/hiddencontent/hidden-content-save.js');
 h.window.addEventListener('je-hidden-content-saved',()=>saved.push('saved'));
 h.api.updateSettings({filterSearch:true});const flushing=h.api.flushPendingSave();await new Promise(r=>setImmediate(r));
 assert.deepEqual(saved,[],'nothing is announced before the server answers');
 acknowledgement.resolve({success:true,revision:'r1'});await flushing;await new Promise(r=>setImmediate(r));
 assert.deepEqual(saved,['saved']);
});
