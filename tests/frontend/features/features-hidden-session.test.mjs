import test from 'node:test';
import assert from 'node:assert/strict';
import {createHarness, deferred} from '../helpers/harness.mjs';
import {hiddenContentStore} from '../helpers/hidden-store.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const click = {preventDefault(){}, stopPropagation(){}};
function setup(t, items = {}) {
  let user = 'viewer-a', epoch = 1;
  const handlers = new Map(), writes = [];
  const h = createHarness({apiClient:{getCurrentUserId:()=>user, ajax:async o=>{writes.push(o);return {success:true};}},
    JE:{t:k=>k,pluginConfig:{HiddenContentEnabled:true,SpoilerBlurEnabled:true},userConfig:{hiddenContent:{items,settings:{}}},
      session:{getEpoch:()=>epoch,isCurrent:e=>e===epoch,onUserChange:(k,fn)=>{handlers.set(k,fn);return ()=>handlers.delete(k);},userScopedKey:k=>k+':'+user}}});
  t.after(()=>h.close());
  h.load('enhanced/hiddencontent/hidden-content-data.js');
  const api = h.JE.internals.hiddenContent;
  Object.assign(api,{refreshNativeCardVisibility(){},persist:hiddenContentStore(h,()=>writes.push({bulk:true})).persist});
  api.resetFromUserConfig();
  h.load('enhanced/hiddencontent/hidden-content-dialogs.js');
  return {...h,get NATIVE(){return h.NATIVE;},api,writes,setIdentityWithoutEvent(){user='viewer-b';},switchUser(mode='both'){
    if(mode!=='epoch') user='viewer-b';
    if(mode!=='identity') epoch++;
    h.JE.userConfig={hiddenContent:{items:{},settings:{}}};
    for(const fn of [...handlers.values()]) fn({userId:user});
  }};
}

for(const host of ['absent page','card','modal','jf10 window']) for(const mode of ['both','identity','epoch'])
test(`${host} confirmation is dismissed and cannot write after ${mode} changes`,async t=>{
  const h=setup(t);
  const button=h.api.buildTitleControl({type:'Movie',tmdbId:42,name:'Private title'},{detail:host==='absent page'});
  h.document.body.appendChild(button);
  await h.viewerPress(button);
  const dialog=h.document.querySelector('.je-hide-confirm-overlay');
  assert.ok(dialog);const confirm=dialog.querySelector('.je-hide-confirm-hide');
  h.switchUser(mode);h.click(confirm);await tick();
  assert.equal(h.writes.length,0,'neither outgoing nor incoming viewer receives a write');
  assert.equal(dialog.isConnected,false,'title-bearing dialog closes');
});

test('Undo captured before a user switch cannot unhide for the incoming viewer',async t=>{
  const h=setup(t);h.api.showUndoToast('Private title','movie:tmdb:42');
  const undo=h.document.querySelector('.je-undo-btn');h.switchUser();h.click(undo);await tick();
  assert.equal(h.writes.length,0);assert.equal(h.document.querySelector('.je-undo-toast'),null);
});

test('manager unhide confirmation cannot call a deferred write after a user switch',async t=>{
  const h=setup(t);h.load('enhanced/hiddencontent/hidden-content-page-state.js');
  h.JE.internals.hiddenContentPage.showUnhideConfirmation('Unhide?',()=>h.api.unhideItem('movie:tmdb:42'),'Private title');
  const dialog=h.document.querySelector('.je-hide-confirm-overlay');const confirm=dialog.querySelector('.je-hide-confirm-hide');
  h.switchUser();h.click(confirm);await tick();
  assert.equal(h.writes.length,0);assert.equal(dialog.isConnected,false);
});

for(const detail of [false,true]) test(`provider Spoiler Guard confirmation cannot write after switch (detail=${detail})`,async t=>{
  const h=setup(t);const pending=deferred();h.load('enhanced/spoilerguard/seerr-toggle.js');
  Object.assign(h.JE.internals.spoilerGuard,{isTmdbEnabled:()=>true,whenLoaded:async()=>{},confirmDisableSpoiler:()=>pending.promise,
    disableForTmdb:async()=>h.writes.push({spoiler:true})});
  const button=h.JE.internals.spoilerGuard.buildSeerrToggle({id:42,title:'Private title'},'movie',{detail});
  h.document.body.append(button);h.click(button);h.switchUser();pending.resolve(true);await tick();
  assert.equal(h.writes.length,0);
});

for(const kind of ['Movie','Series']) for(const copy of ['arrived','second-edition','reimport'])
test(`${kind} ${copy} recognizes and removes provider hides plus matching item rules`,async t=>{
  const h=setup(t,{'legacy':{type:kind,tmdbId:'42',itemId:'old-copy'},[kind==='Movie'?'movie:tmdb:42':'tv:tmdb:42']:{type:kind,tmdbId:'42',itemId:''},local:{type:kind,tmdbId:'42',itemId:copy},idOnly:{itemId:copy},other:{type:kind==='Movie'?'Series':'Movie',tmdbId:'42'}});
  const item={Id:copy,Type:kind,ProviderIds:{Tmdb:'42'}};
  assert.equal(h.api.isHidden(item.Id,item),true);
  await h.api.unhideItem(item.Id,item);
  assert.equal(h.api.isHidden(item.Id,item),false);
  assert.equal(h.api.isHiddenByTmdbId(42,kind),false);
  assert.equal(h.api.isHiddenByTmdbId(42,kind==='Movie'?'Series':'Movie'),true,'other media kind remains hidden');
  assert.ok(h.writes.some(o=>o.type==='DELETE'),'provider rule uses atomic delete');
});

for(const kind of ['Movie','Series']) test(`real ${kind} detail page opens as Unhide for a provider-only rule`,async t=>{
  const h=setup(t,{[kind==='Movie'?'movie:tmdb:42':'tv:tmdb:42']:{type:kind,tmdbId:'42',itemId:''}});
  h.JE.hiddenContent=h.api;h.JE.currentSettings={};
  const debounced={};
  h.JE.helpers={debounce:(fn,ms)=>{debounced[ms]=fn;return ()=>{};},createObserver(){},onViewPage(){},
    getItemCached:async id=>({Id:id,Type:kind,Name:'Arrived title',ProviderIds:{Tmdb:'42'}})};
  h.JE.core={...h.JE.core,ui:{placeDetailAction:(row,button)=>row.appendChild(button)},navigation:{onViewPage(){},onNavigate(){}}};
  h.document.body.innerHTML='<div id="itemDetailPage"><h1 class="itemName">Arrived title</h1><div class="itemMiscInfo itemMiscInfo-primary"></div><div class="detailButtons"></div></div>';
  h.window.history.replaceState(null,'','#/details?id=reimport');
  h.load('enhanced/itemdetails/features-details-page.js');
  debounced[100]();await tick();
  const button=h.document.querySelector('.je-detail-hide-btn');assert.ok(button);
  assert.equal(button.classList.contains('je-already-hidden'),true);
  await h.viewerPress(button);
  assert.equal(h.api.isHiddenByTmdbId(42,kind),false);assert.equal(button.classList.contains('je-already-hidden'),false);
});

for(const kind of ['movie','series','collection']) test(`native ${kind} guard confirmation cannot write after switch`,async t=>{
  const h=setup(t);const pending=deferred();
  h.JE.core={...h.JE.core,ui:{placeDetailAction:(row,button)=>row.appendChild(button)}};
  h.load('enhanced/spoilerguard/detail-button.js');
  Object.assign(h.JE.internals.spoilerGuard,{isStateLoaded:()=>true,kindOf:()=>kind,isEnabledForKind:()=>true,
    confirmDisableSpoiler:()=>pending.promise,
    disableForMovie:async()=>h.writes.push({kind}),disableForSeries:async()=>h.writes.push({kind}),disableForCollection:async()=>h.writes.push({kind})});
  h.document.body.innerHTML='<div id="itemDetailPage"><div class="detailButtons"></div></div>';
  h.JE.internals.spoilerGuard.addSpoilerBlurButton('real',h.document.querySelector('#itemDetailPage'),kind);
  h.click(h.document.querySelector('button'));h.switchUser();pending.resolve(true);await tick();
  assert.equal(h.writes.length,0);
});

test('guard dialog is dismissed and cannot snooze or confirm across a session change',async t=>{
  const h=setup(t);h.load('enhanced/spoilerguard/dialog.js');
  Object.assign(h.JE.internals.spoilerGuard,{whenLoaded:async()=>{},getUserPrefs:()=>({}),isDisableSnoozed:()=>false,setDisableSnooze:()=>h.writes.push({snooze:true})});
  const result=h.JE.internals.spoilerGuard.confirmDisableSpoiler(h.NATIVE);await tick();
  const dialog=h.document.querySelector('.je-spoiler-confirm-dialog');assert.ok(dialog);
  dialog.querySelector('input').checked=true;const confirm=dialog.querySelector('.je-spoiler-confirm-accept');
  h.switchUser();h.click(confirm);assert.equal(await result,false);assert.equal(dialog.isConnected,false);assert.equal(h.writes.length,0);
});

test('guard preference loading cannot resume a previous viewer gesture',async t=>{
  const h=setup(t);const pending=deferred();h.load('enhanced/spoilerguard/dialog.js');
  Object.assign(h.JE.internals.spoilerGuard,{whenLoaded:()=>pending.promise,getUserPrefs:()=>({SkipDisableConfirm:true})});
  const result=h.JE.internals.spoilerGuard.confirmDisableSpoiler(h.NATIVE);h.switchUser();pending.resolve();
  assert.equal(await result,false);assert.equal(h.document.querySelector('dialog'),null);
});

for(const kind of ['Movie','Series']) test(`${kind} provider rule is recognized by the shared surface check without lookups`,t=>{
  const h=setup(t,{provider:{type:kind,tmdbId:'42'}});
  h.load('enhanced/hiddencontent/hidden-content-filter.js');
  for(const surface of ['library','search','recommendations','nextup','continuewatching'])
    assert.equal(h.api.isHiddenOnSurface('new-copy',surface,{Type:kind,ProviderIds:{Tmdb:'42'}}),true);
  assert.equal(h.writes.length,0);
});

test('native card metadata that resolves after a switch cannot open another viewer confirmation',async t=>{
  const h=setup(t);const pending=deferred();
  h.load('enhanced/hiddencontent/hidden-content-filter.js');
  h.window.ApiClient.getItem=()=>pending.promise;
  Object.assign(h.api.getHiddenData().settings,{showButtonLibrary:true});
  h.document.body.innerHTML='<div class="card" data-id="old" data-type="Movie"><div class="cardBox"></div></div>';
  h.load('enhanced/hiddencontent/hidden-content-buttons.js');h.api.addLibraryHideButtons();
  const save=h.viewerPress(h.document.querySelector('.je-hide-btn'));
  h.switchUser('identity');pending.resolve({Type:'Movie',ProviderIds:{Tmdb:'42'}});await save;
  assert.equal(h.document.querySelector('.je-hide-confirm-overlay'),null);assert.equal(h.writes.length,0);
});

for(const kind of ['Movie','Series']) test(`ID-only ${kind} cards recognize provider rules with one bounded metadata batch`,async t=>{
  const h=setup(t,{provider:{type:kind,tmdbId:'42'}});const reads=[];
  h.window.ApiClient.ajax=async o=>{
    if(o.type==='GET'){reads.push(o);return {Items:[{Id:'copy',Type:kind,ProviderIds:{Tmdb:'42'}}]};}
    h.writes.push(o);return {success:true};
  };
  Object.assign(h.api.getHiddenData().settings,{showButtonLibrary:true,filterLibrary:false});
  h.load('enhanced/hiddencontent/hidden-content-filter.js');
  h.document.body.innerHTML=Array.from({length:20},()=>`<div class="card" data-id="copy" data-type="${kind}"><div class="cardBox"></div></div>`).join('');
  h.load('enhanced/hiddencontent/hidden-content-buttons.js');h.api.addLibraryHideButtons();await tick();
  assert.equal(reads.length,1,'duplicates are batched, never fetched once per card');
  for(const button of h.document.querySelectorAll('.je-hide-btn'))assert.equal(button.classList.contains('je-already-hidden'),true);
  assert.equal(h.api.isHidden('copy'),true,'known identity also covers ID-only public lookups');
  await h.viewerPress(h.document.querySelector('.je-hide-btn'));await tick();
  assert.equal(h.api.isHiddenByTmdbId(42,kind),false);
  assert.equal(h.document.querySelector('.je-hide-confirm-overlay'),null,'unhide does not prompt to hide again');
  h.api.addLibraryHideButtons();await tick();assert.equal(reads.length,1,'repaints settle');
});

// Ported (the join replaced D46's 500 ms debounced save with the settings store's session-bound PATCH queue): a change
// queued before the signed-in person changes, without the change's event, is never sent as anyone.
test('a queued save rejects a changed identity even before the session detector runs',async t=>{
  const h=setup(t);
  // The real save path: hidden-content-save.js's persist through the settings store (config.js) and its queue.
  h.load('core/mutation-queue.js');h.load('enhanced/config.js');h.load('enhanced/hiddencontent/hidden-content-save.js');
  h.api.hideItem({itemId:'copy',name:'Private title'});
  h.setIdentityWithoutEvent();
  for(let i=0;i<20;i++)await tick();
  assert.equal(h.writes.filter(o=>o.type!=='GET').length,0);
});

test('control: the same queued save goes out while the person is unchanged',async t=>{
  const h=setup(t);
  h.load('core/mutation-queue.js');h.load('enhanced/config.js');h.load('enhanced/hiddencontent/hidden-content-save.js');
  h.api.hideItem({itemId:'copy',name:'Private title'});
  for(let i=0;i<20;i++)await tick();
  assert.equal(h.writes.filter(o=>o.type==='PATCH').length,1);
});

for(const kind of ['Movie','Series']) test(`cached ${kind} cards filter by provider without a Hide control`,async t=>{
  const h=setup(t,{provider:{type:kind,tmdbId:'42'}});let reads=0;
  h.window.ApiClient.ajax=async o=>{if(o.type!=='GET')return {success:true};reads++;return {Items:[{Id:'copy',Type:kind,ProviderIds:{Tmdb:'42'}}]};};
  h.document.body.innerHTML=`<div class="card" data-id="copy" data-type="${kind}"><div class="cardBox"></div></div>`;
  h.load('enhanced/hiddencontent/hidden-content-filter.js');h.load('enhanced/hiddencontent/hidden-content-buttons.js');
  h.api.filterNativeCards();await tick();for(let frame=0;frame<3;frame++)await new Promise(r=>h.window.requestAnimationFrame(r));
  assert.equal(h.document.querySelector('.card').classList.contains('je-hidden'),true);assert.equal(reads,1);
  await h.api.unhideItem('copy');await tick();for(let frame=0;frame<3;frame++)await new Promise(r=>h.window.requestAnimationFrame(r));
  assert.equal(h.document.querySelector('.card').classList.contains('je-hidden'),false);
});

for(const scoped of [false,true]) test(`cached episode cards recognize a provider-only parent series hide in bounded batches (home scope=${scoped})`,async t=>{
  const h=setup(t,{provider:{type:'Series',tmdbId:'42'}});let reads=0;
  h.window.ApiClient.ajax=async o=>o.type!=='GET'?{success:true}:({Items:++reads===1?[{Id:'episode',Type:'Episode',SeriesId:'series'}]:[{Id:'series',Type:'Series',ProviderIds:{Tmdb:'42'}}]});
  h.api.getHiddenData().settings.filterLibrary=!scoped;
  h.document.body.innerHTML='<div class="section">'+(scoped?'<h2>Next Up</h2>':'')+Array.from({length:20},()=>'<div class="card" data-id="episode" data-type="Episode"></div>').join('')+'</div>';
  h.load('enhanced/hiddencontent/hidden-content-filter.js');h.api.filterNativeCards();await tick();for(let frame=0;frame<3;frame++)await new Promise(r=>h.window.requestAnimationFrame(r));
  assert.equal(reads,2,'one child batch and one parent provider batch');
  assert.equal(h.document.querySelectorAll('.je-hidden').length,20);
  await h.api.unhideItem('tv:tmdb:42');await tick();for(let frame=0;frame<3;frame++)await new Promise(r=>h.window.requestAnimationFrame(r));
  assert.equal(h.document.querySelectorAll('.je-hidden').length,0);
});

test('a retained native card repaints its action after being unhidden while detached',async t=>{
  const h=setup(t,{provider:{type:'Series',tmdbId:'42'}});
  Object.assign(h.api.getHiddenData().settings,{showButtonLibrary:true,showHideConfirmation:false});
  h.document.body.innerHTML='<div class="card" data-id="copy" data-type="Series" data-tmdb-id="42"><div class="cardBox"></div></div>';
  h.load('enhanced/hiddencontent/hidden-content-filter.js');h.load('enhanced/hiddencontent/hidden-content-buttons.js');h.api.addLibraryHideButtons();
  const card=h.document.querySelector('.card');card.remove();await h.api.unhideItem('tv:tmdb:42');h.document.body.append(card);h.api.addLibraryHideButtons();
  const button=card.querySelector('.je-hide-btn');assert.equal(button.classList.contains('je-already-hidden'),false);
  await h.viewerPress(button);assert.ok(h.writes.some(w=>w.type==='PUT'));
});

test('a user switch removes outgoing native-card controls before incoming preferences load',t=>{
  const h=setup(t);Object.assign(h.api.getHiddenData().settings,{showButtonLibrary:true});
  h.document.body.innerHTML='<div class="card" data-id="copy" data-type="Movie" data-tmdb-id="42"><div class="cardBox"></div></div>';
  h.load('enhanced/hiddencontent/hidden-content-filter.js');h.load('enhanced/hiddencontent/hidden-content-buttons.js');h.api.addLibraryHideButtons();assert.ok(h.document.querySelector('.je-hide-btn'));
  h.switchUser();assert.equal(h.document.querySelector('.je-hide-btn'),null);
});
