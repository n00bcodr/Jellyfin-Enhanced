// Round 9: confirmed outcomes, retryable failed reads and view-scoped modals, through the real modules.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHarness,deferred,jsonResponse} from '../helpers/harness.mjs';
const tick=()=>new Promise(r=>setImmediate(r));
/** Polls a bounded number of macrotasks; core retry sleeps run as zero-delay timers here. */
async function until(predicate,label='condition'){for(let i=0;i<400;i++){if(predicate())return;await tick();}assert.fail(`timed out waiting for ${label}`);}

/** Runs short timers at once and parks long ones (recovery ladders, debounces) for explicit firing. */
function controlTimers(h,isLong=ms=>ms>=150){
 const parked=[];const setT=h.window.setTimeout.bind(h.window),clearT=h.window.clearTimeout.bind(h.window);
 h.window.setTimeout=(fn,ms,...args)=>{if(isLong(ms||0)){parked.push({fn,ms,args});return 1e6+parked.length-1;}return setT(fn,0,...args);};
 h.window.clearTimeout=id=>{if(id>=1e6){const p=parked[id-1e6];if(p)p.cancelled=true;}else clearT(id);};
 return {parked,live:()=>parked.filter(p=>!p.cancelled&&!p.fired),fire(match=()=>true){const due=parked.filter(p=>!p.cancelled&&!p.fired&&match(p));for(const p of due){p.fired=true;p.fn(...p.args);}return due.length;}};
}

function sgSetup(t){
 let user='a',token='token-a',gets='up',writes=200;const calls=[];const server={Series:{},Movies:{},Collections:{},ProviderTitles:{},PendingTmdb:{},Prefs:{}};
 const h=createHarness({html:'<div id="itemDetailPage"><h1 class="itemName">Title</h1><div class="detailButtons"></div></div>',
  apiClient:{getCurrentUserId:()=>user,accessToken:()=>token,setAuthenticationInfo(next,u){token=next;user=u;}},
  JE:{t:k=>k,pluginConfig:{SpoilerBlurEnabled:true},core:{ui:{placeDetailAction:(row,b)=>row.appendChild(b)}}},
  fetch:async(url,o)=>{const method=o.method||'GET';calls.push({url,method,token:o.headers?.['X-Emby-Token'],body:o.body});
   if(method==='GET')return gets==='up'?jsonResponse(server):jsonResponse({error:'unavailable'},503);
   if(writes!==200)return jsonResponse({error:'unavailable'},writes);
   const id=decodeURIComponent(url.split('/').pop().split('?')[0]);
   if(url.includes('/user-prefs'))server.Prefs=JSON.parse(o.body);
   else if(url.includes('/pending/')){
    const type=url.split('/pending/')[1].split('/')[0],key=`${type}:${id}`;
    if(method==='DELETE'){delete server.PendingTmdb[key];delete server.ProviderTitles[`${type}:tmdb:${id}`];server[type==='movie'?'Movies':'Series']={};}
    else server.ProviderTitles[`${type}:tmdb:${id}`]={};
   }
   else method==='DELETE'?delete server.Movies[id]:server.Movies[id]={};
   return jsonResponse({success:true});}});
 t.after(()=>h.close());h.allowConsoleError(/toggle failed|state load failed|preference save failed/);
 for(const m of ['navigation','session','api-client'])h.load('core/'+m+'.js');
 h.load('core/session-action.js');
 for(const m of ['ids','state','detail-button','seerr-toggle','settings-tab'])h.load('enhanced/spoilerguard/'+m+'.js');
 let reloads=0;const toasts=[];h.JE.toast=m=>toasts.push(m);
 const api=h.JE.internals.spoilerGuard;Object.assign(api,{confirmDisableSpoiler:async()=>true,refreshSpoilerableImages(){},scheduleFullReload(){reloads++;}});
 return {...h,api,calls,server,toasts,reloads:()=>reloads,reads:()=>calls.filter(c=>c.method==='GET').length,
  setGets(v){gets=v;},setWrites(v){writes=v;},switchUser(){h.window.ApiClient.setAuthenticationInfo('token-b','b');},
  page:()=>h.document.querySelector('#itemDetailPage')};
}
const slow=ms=>ms>=1500;
/** Mounts the Spoiler Guard preference section as the panel does, with one checkbox. */
function mountPrefs(h){
 const help=h.document.createElement('div');help.innerHTML='<input type="checkbox" id="sbPrefHideCast" data-pref="HideCast" checked>';h.document.body.appendChild(help);
 h.api.wireSettings({help,resetAutoCloseTimer(){}});return help.querySelector('input');
}

function filterSetup(t,items,reply){
 const reads=[];
 const h=createHarness({apiClient:{getCurrentUserId:()=>'viewer-a',getUrl:(path,params)=>`http://jellyfin.test${path}${params?'?'+new URLSearchParams(params):''}`,ajax:async o=>{reads.push(o.url);return reply(o,reads.length);}},
  JE:{t:k=>k,pluginConfig:{HiddenContentEnabled:true},userConfig:{hiddenContent:{items,settings:{showButtonLibrary:true}}},
   session:{getEpoch:()=>1,isCurrent:()=>true,onUserChange(){},userScopedKey:k=>k}}});
 t.after(()=>h.close());h.load('enhanced/hiddencontent/hidden-content-data.js');
 const api=h.JE.internals.hiddenContent;Object.assign(api,{refreshNativeCardVisibility(){},restoreNativeCardsForIds(){},debouncedSave(){}});api.resetFromUserConfig();
 h.load('enhanced/hiddencontent/hidden-content-filter.js');h.load('enhanced/hiddencontent/hidden-content-buttons.js');
 const settle=async()=>{for(let i=0;i<4;i++){await tick();await new Promise(r=>h.window.requestAnimationFrame(r));}};
 const later=ms=>{const now=h.window.Date.now;h.window.Date.now=()=>now()+ms;};
 return {...h,api,reads,settle,later};
}

for(const recovery of ['timer','demand','mutation'])test(`mounted preferences resync and enable on ${recovery} recovery`,async t=>{
 const h=sgSetup(t),timers=controlTimers(h,slow);h.setGets('down');h.server.Prefs={HideCast:false,SkipDisableConfirm:true};
 const box=mountPrefs(h);await until(()=>h.reads()===2&&h.api.isLoaded(),'failed load');await tick();
 assert.equal(box.disabled,true);assert.equal(box.checked,true);
 h.setGets('up');
 if(recovery==='timer')timers.fire();
 else if(recovery==='mutation')await h.api.enableForMovie('aabb','Title');
 else {const now=h.window.Date.now;h.window.Date.now=()=>now()+6000;await h.api.whenLoaded();}
 await until(()=>h.api.isLoadOk(),'recovered');await tick();
 assert.equal(box.checked,false,'server value replaces guessed checkbox');assert.equal(box.disabled,false,'mounted section is usable');
 box.checked=true;box.dispatchEvent(new h.window.Event('change'));await until(()=>h.server.Prefs.HideCast===null,'save after recovery');
});
test('outgoing preferences ignore incoming recovery and stay inert',async t=>{
 const h=sgSetup(t);controlTimers(h,slow);h.setGets('down');const box=mountPrefs(h);
 await until(()=>h.reads()===2&&h.api.isLoaded(),'failed load');await tick();h.switchUser();
 h.server.Prefs={HideCast:false};h.setGets('up');const now=h.window.Date.now;h.window.Date.now=()=>now()+6000;await h.api.loadState();
 assert.equal(box.checked,true,'incoming preferences never populate outgoing section');assert.equal(box.disabled,true);
 box.checked=false;box.dispatchEvent(new h.window.Event('change'));await tick();
 assert.equal(h.calls.filter(c=>c.method==='POST').length,0);
});

for(const failedBatch of [1,2])test(`ID-only cards release all unresolved work when batch ${failedBatch} fails`,async t=>{
 const count=failedBatch===1?60:120,requested=[];let fail=true;
 const h=filterSetup(t,{provider:{type:'Movie',tmdbId:'42'}},(o,n)=>{
  const ids=new URL(o.url).searchParams.get('Ids').split(',');requested.push(ids);
  if(fail&&n===failedBatch){const e=new Error('503');e.status=503;throw e;}
  return {Items:ids.map(Id=>({Id,Type:'Movie',ProviderIds:{Tmdb:'42'}}))};
 });
 h.document.body.innerHTML='<div class="section">'+Array.from({length:count},(_,i)=>`<div class="card" data-id="m${i}" data-type="Movie"><div class="cardBox"></div></div>`).join('')+'</div>';
 h.api.addLibraryHideButtons();await h.api.hydrateCardTitles();await h.settle();
 const before=requested.length;h.api.filterNativeCards();await h.settle();assert.equal(requested.length,before,'bounded retry window');
 fail=false;h.later(31000);await h.api.hydrateCardTitles();h.api.filterNativeCards();await h.settle();
 assert.equal(new Set(requested.flat()).size,count,'every later batch was requested');
 assert.equal(h.document.querySelectorAll('.card[data-tmdb-id="42"]').length,count);
 assert.equal(h.document.querySelectorAll('.je-hidden').length,count,'all provider-hidden cards suppressed');
 assert.equal(h.document.querySelectorAll('.je-already-hidden').length,count,'all controls offer Unhide');
});

for(const mediaType of ['movie','tv'])for(const enabled of [false,true])test(`confirmed provider ${mediaType} ${enabled?'enable':'disable'} overrides stale fallback until reconciliation`,async t=>{
 const h=sgSetup(t);controlTimers(h,slow);const kind=mediaType==='movie'?'Movies':'Series';
 if(!enabled){h.server[kind]={aabb:{},ccdd:{}};h.server.ProviderTitles[`${mediaType}:tmdb:42`]={};}
 await h.api.loadState();
 const data={id:42,title:'Title',mediaInfo:{jellyfinMediaId:'aabb'},jeSpoiler:{guarded:!enabled}};
 const button=h.api.buildSeerrToggle(data,mediaType,{detail:true});h.document.body.append(button);await tick();
 h.setGets('down');button.click();await until(()=>!button.disabled,'accepted toggle');
 assert.equal(h.api.isLoadOk(),false,'other consumers stay fail-closed');
 assert.equal(button.getAttribute('aria-pressed'),String(enabled),'clicked title shows confirmed outcome over stale copies');
 assert.equal(h.api.isTmdbEnabled(mediaType,42,'aabb'),enabled);
 assert.equal(h.api.isTmdbKnown(mediaType,99),false,'unrelated title is unknown');
 assert.equal(h.api.isKnownForKind(mediaType==='movie'?'movie':'series','ccdd'),false,'unrelated copy is not confirmed');
 if(!enabled)assert.equal(h.api.isEnabledForKind(mediaType==='movie'?'movie':'series','ccdd'),true,'stale sibling mirror remains conservative');
 button.click();await until(()=>!button.disabled,'second toggle');
 const writes=h.calls.filter(c=>c.method!=='GET');assert.deepEqual(writes.map(c=>c.method),enabled?['POST','DELETE']:['DELETE','POST'],'next click reverses the confirmed outcome');
 h.setGets('up');const now=h.window.Date.now;h.window.Date.now=()=>now()+6000;await h.api.loadState();
 assert.equal(h.api.isLoadOk(),true);assert.equal(button.getAttribute('aria-pressed'),String(!enabled));
 assert.equal(h.api.isEnabledForKind(mediaType==='movie'?'movie':'series','ccdd'),false,'reconciliation removes stale sibling copies');
});

for(const detail of [false,true])test(`mounted provider ${detail?'detail/modal':'card'} follows recovery and ignores the next session`,async t=>{
 const h=sgSetup(t),timers=controlTimers(h,slow);h.setGets('down');await h.api.loadState();
 const button=h.api.buildSeerrToggle({id:42,jeSpoiler:{guarded:false}},'movie',{detail});h.document.body.append(button);
 assert.equal(button.getAttribute('aria-pressed'),'false');h.server.ProviderTitles['movie:tmdb:42']={};h.setGets('up');timers.fire();
 await until(()=>h.api.isLoadOk(),'recovery');assert.equal(button.getAttribute('aria-pressed'),'true');
 h.switchUser();h.server.ProviderTitles={};await h.api.loadState();
 assert.equal(button.getAttribute('aria-pressed'),'true','outgoing view never paints incoming state');assert.equal(button.disabled,true);
 button.click();await tick();assert.equal(h.calls.filter(c=>c.method!=='GET').length,0);
});
for(const failedBatch of [1,2])test(`parent identity batches release retry work when batch ${failedBatch} fails`,async t=>{
 let fail=true,parentCalls=0;const count=failedBatch===1?60:120;
 const h=filterSetup(t,{provider:{type:'Series',tmdbId:'42'}},o=>{
  const ids=new URL(o.url).searchParams.get('Ids').split(',');
  if(o.url.includes('SeriesId'))return {Items:ids.map(Id=>({Id,Type:'Episode',SeriesId:Id.replace('e','s')}))};
  parentCalls++;if(fail&&parentCalls===failedBatch)throw new Error('503');
  return {Items:ids.map(Id=>({Id,Type:'Series',ProviderIds:{Tmdb:'42'}}))};
 });
 h.document.body.innerHTML='<div class="section">'+Array.from({length:count},(_,i)=>`<div class="card" data-id="e${i}" data-type="Episode"></div>`).join('')+'</div>';
 const retained=[...h.document.querySelectorAll('.card')];
 h.api.filterNativeCards();await h.settle();fail=false;h.later(31000);h.api.filterNativeCards();await h.settle();
 assert.deepEqual([...h.document.querySelectorAll('.card')],retained,'ordinary recovery reuses every retained node');
 assert.equal(h.document.querySelectorAll('.je-hidden').length,count);
});
