// Round 8: confirmed outcomes, retryable failed reads and view-scoped modals, through the real modules.
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
 let user='a',token='token-a',gets='up',writes=200;const calls=[];const server={Movies:{},PendingTmdb:{},Prefs:{}};
 const h=createHarness({html:'<div id="itemDetailPage"><h1 class="itemName">Title</h1><div class="detailButtons"></div></div>',
  apiClient:{getCurrentUserId:()=>user,accessToken:()=>token,setAuthenticationInfo(next,u){token=next;user=u;}},
  JE:{t:k=>k,pluginConfig:{SpoilerBlurEnabled:true},core:{ui:{placeDetailAction:(row,b)=>row.appendChild(b)}}},
  fetch:async(url,o)=>{const method=o.method||'GET';calls.push({url,method,token:o.headers?.['X-Emby-Token'],body:o.body});
   if(method==='GET')return gets==='up'?jsonResponse(server):jsonResponse({error:'unavailable'},503);
   if(writes!==200)return jsonResponse({error:'unavailable'},writes);
   const id=decodeURIComponent(url.split('/').pop().split('?')[0]);
   if(url.includes('/user-prefs'))server.Prefs=JSON.parse(o.body);
   else if(url.includes('/pending/'))method==='DELETE'?delete server.PendingTmdb[`movie:${id}`]:server.PendingTmdb[`movie:${id}`]={};
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

test('accepted guard with both rereads failing stays truthful, refreshes the page and recovers',async t=>{
 const h=sgSetup(t);await h.api.loadState();const timers=controlTimers(h,slow);
 h.api.addSpoilerBlurButton('aabb',h.page(),'Movie');const button=h.document.querySelector('.je-spoiler-blur-btn');
 h.setGets('down');const before=h.reads();button.click();await until(()=>!button.disabled,'toggle settles');
 assert.ok(h.server.Movies.aabb,'server accepted the guard');assert.equal(h.reads()-before,2,'both reread attempts failed');
 assert.equal(button.getAttribute('aria-pressed'),'true','control shows the accepted guard, not the stale OFF');
 assert.equal(h.reloads(),1,'native refresh still happens after an accepted write');
 assert.deepEqual(h.toasts,['spoiler_blur_enabled_movie_toast']);
 assert.equal(h.api.isLoadOk(),false,'consumers stay fail-closed until the state is reconciled');
 h.setGets('up');assert.equal(timers.fire(),1,'one bounded recovery read is scheduled');
 await until(()=>h.api.isLoadOk(),'recovery adopts server state');
 assert.equal(h.api.isMovieEnabledFor('aabb'),true);assert.equal(button.getAttribute('aria-pressed'),'true');
 const box=mountPrefs(h);await until(()=>!box.disabled,'prefs sync');
 box.checked=false;box.dispatchEvent(new h.window.Event('change'));
 await until(()=>h.calls.some(c=>c.url.includes('/user-prefs')),'preferences save');
 assert.equal(h.server.Prefs.HideCast,false,'preferences save again after recovery');assert.equal(box.checked,false);
});
test('accepted provider guard with failing rereads keeps the pending control truthful',async t=>{
 const h=sgSetup(t);await h.api.loadState();controlTimers(h,slow);
 const button=h.api.buildSeerrToggle({id:42,title:'Title'},'movie',{detail:true});h.document.body.append(button);
 h.setGets('down');button.click();await until(()=>!button.disabled,'toggle settles');
 assert.ok(h.server.PendingTmdb['movie:42']);assert.equal(button.getAttribute('aria-pressed'),'true');
 assert.deepEqual(h.toasts,['spoiler_blur_pending_enabled_toast']);
});
test('preferences saved while the reread fails are kept and the box is not reverted',async t=>{
 const h=sgSetup(t);await h.api.loadState();controlTimers(h,slow);
 const box=mountPrefs(h);await until(()=>!box.disabled,'prefs sync');
 h.setGets('down');box.checked=false;box.dispatchEvent(new h.window.Event('change'));
 await until(()=>h.reads()>=3&&!box.disabled,'save settles');
 assert.equal(h.server.Prefs.HideCast,false);assert.equal(box.checked,false,'accepted save is not shown as failed');
 assert.equal(h.api.getUserPrefs().HideCast,false);assert.deepEqual(h.toasts,[]);
});
test('a refused guard write leaves the control, state and page unchanged',async t=>{
 const h=sgSetup(t);await h.api.loadState();controlTimers(h,slow);
 h.api.addSpoilerBlurButton('aabb',h.page(),'Movie');const button=h.document.querySelector('.je-spoiler-blur-btn');
 h.setWrites(503);button.click();await until(()=>!button.disabled,'toggle settles');
 assert.equal(button.getAttribute('aria-pressed'),'false');assert.equal(h.reloads(),0);assert.equal(h.api.isLoadOk(),true);
 assert.deepEqual(h.toasts,['spoiler_blur_error_toast']);
});
test('a failed state read is retried on demand after a bounded wait, never cached forever',async t=>{
 const h=sgSetup(t);controlTimers(h,slow);h.setGets('down');await h.api.loadState();
 assert.equal(h.api.isLoadOk(),false);const failed=h.reads();
 await h.api.whenLoaded();assert.equal(h.reads(),failed,'no request storm inside the retry window');
 const now=h.window.Date.now;h.window.Date.now=()=>now()+6000;h.setGets('up');
 await h.api.whenLoaded();assert.equal(h.api.isLoadOk(),true,'later demand reloads the state');
});
test('recovery reads are bounded and cancelled by an identity change',async t=>{
 const h=sgSetup(t);const timers=controlTimers(h,slow);h.setGets('down');await h.api.loadState();
 for(let attempt=0;attempt<3;attempt++){const n=h.reads();assert.equal(timers.fire(),1,`recovery ${attempt+1}`);await until(()=>h.reads()>=n+2&&h.api.isLoaded(),'attempt settles');await tick();}
 assert.equal(timers.fire(),0,'the ladder stops after three attempts');
 const h2=sgSetup(t);const timers2=controlTimers(h2,slow);h2.setGets('down');await h2.api.loadState();
 assert.equal(timers2.live().length,1);h2.switchUser();assert.equal(timers2.live().length,0,'recovery timer is cancelled');
 assert.equal(h2.calls.filter(c=>c.token==='token-b').length,0,'nothing is read for the outgoing session as the incoming viewer');
});
test('after a failed state read the native control shows retrying, not a guessed OFF, and recovers',async t=>{
 const h=sgSetup(t);h.server.Movies.aabb={};const timers=controlTimers(h,slow);h.setGets('down');await h.api.loadState();
 h.api.addSpoilerBlurButton('aabb',h.page(),'Movie');const button=h.document.querySelector('.je-spoiler-blur-btn');
 assert.equal(button.getAttribute('aria-pressed'),null);assert.equal(button.getAttribute('aria-busy'),'true');assert.equal(button.disabled,true);
 assert.equal(button.title,'spoiler_blur_state_retrying');assert.equal(button.querySelector('.material-icons').textContent,'sync','not drawn as OFF');button.click();await tick();assert.equal(h.calls.filter(c=>c.method!=='GET').length,0,'unknown state cannot be toggled');
 h.setGets('up');timers.fire();await until(()=>h.api.isLoadOk(),'recovery');
 assert.equal(button.getAttribute('aria-pressed'),'true','recovered control shows the server guard');assert.equal(button.disabled,false);
});
test('after a failed state read the provider control shows the server projection of its title',async t=>{
 const h=sgSetup(t);controlTimers(h,slow);h.setGets('down');await h.api.loadState();
 const button=h.api.buildSeerrToggle({id:42,title:'Title',jeSpoiler:{guarded:true}},'movie',{detail:true});h.document.body.append(button);await tick();
 assert.equal(button.getAttribute('aria-pressed'),'true','not a guessed OFF from empty mirrors');
});
test('an identity change removes the outgoing viewer\'s native guard control',async t=>{
 const h=sgSetup(t);await h.api.loadState();h.api.addSpoilerBlurButton('aabb',h.page(),'Movie');
 assert.ok(h.document.querySelector('.je-spoiler-blur-btn'));h.switchUser();
 assert.equal(h.document.querySelector('.je-spoiler-blur-btn'),null,'the incoming viewer never toggles from the outgoing state');
});
test('a preferences view mounted for one viewer cannot save for the next',async t=>{
 const h=sgSetup(t);h.server.Prefs={HideCast:false};await h.api.loadState();const box=mountPrefs(h);await until(()=>!box.disabled,'prefs sync');
 assert.equal(box.checked,false);h.switchUser();box.checked=true;box.dispatchEvent(new h.window.Event('change'));
 for(let i=0;i<20;i++)await tick();
 assert.equal(h.calls.filter(c=>c.method==='POST').length,0,'no preference write from the outgoing view');
});

/** Hidden Content data/save/panel modules with a real session, provider rules and an ajax fixture. */
function hcSetup(t,{items,ajax}){
 let user='a',token='token-a';const ajaxCalls=[];const toasts=[];
 const h=createHarness({JE:{t:k=>k,userConfig:{hiddenContent:{items,settings:{}}},pluginConfig:{HiddenContentEnabled:true,HiddenContentAdmin:false},toast:m=>toasts.push(m)},
  apiClient:{getCurrentUserId:()=>user,accessToken:()=>token,setAuthenticationInfo(next,u){token=next;user=u;},ajax:async o=>{ajaxCalls.push(o);return ajax(o);}}});
 t.after(()=>h.close());
 for(const m of ['navigation','session'])h.load('core/'+m+'.js');h.load('core/session-action.js');
 for(const m of ['data','save','panel'])h.load(`enhanced/hiddencontent/hidden-content-${m}.js`);
 const internal=h.JE.internals.hiddenContent;Object.assign(internal,{refreshNativeCardVisibility(){},restoreNativeCardsForIds(){},showUndoToast(){}});
 internal.resetFromUserConfig();
 h.JE.hiddenContent={getAllHiddenItems:internal.getAllHiddenItems,createItemCard:internal.createItemCard,unhideItem:internal.unhideItem,unhideAll:internal.unhideAll,
  unhideConfirmed:internal.unhideConfirmed,showUnhideFailed:internal.showUnhideFailed,adminUnhideForUser:internal.adminUnhideForUser,adminHideForUser:internal.adminHideForUser};
 return {...h,internal,ajaxCalls,toasts,switchUser(){h.window.ApiClient.setAuthenticationInfo('token-b','b');}};
}
const unavailable=()=>{const e=new Error('Service Unavailable');e.status=503;throw e;};
const providerRule={'movie:tmdb:42':{itemId:'',type:'Movie',tmdbId:'42',name:'Title',hideScope:'global'},'movie:tmdb:43':{itemId:'',type:'Movie',tmdbId:'43',name:'Other',hideScope:'global'}};

test('manager panel Unhide keeps the card, count and rule when the DELETE fails, then retries',async t=>{
 let fail=true;const h=hcSetup(t,{items:{...providerRule},ajax:o=>fail?unavailable():{items:{'movie:tmdb:43':providerRule['movie:tmdb:43']},revision:'r2'}});
 const timers=controlTimers(h);h.internal.showManagementPanel();
 const heading=()=>h.document.querySelector('.je-hidden-management-header h2').textContent;
 const card=[...h.document.querySelectorAll('.je-hidden-item-card')].find(c=>c.querySelector('.je-hidden-item-name').textContent==='Title');
 const button=card.querySelector('.je-hidden-item-unhide');
 button.click();assert.equal(timers.fire(),1);await until(()=>h.ajaxCalls.length===1&&!button.disabled,'unhide settles');await tick();
 assert.equal(card.isConnected,true,'card restored');assert.equal(card.classList.contains('je-hidden-item-removing'),false);
 assert.match(heading(),/\(2\)/,'count unchanged');assert.equal(h.document.querySelector('.je-hidden-management-empty'),null);
 assert.equal(button.textContent,'hidden_content_unhide_failed_retry','visible error that retries');
 assert.equal(h.internal.getHiddenCount(),2,'rule preserved');
 fail=false;button.click();timers.fire();await until(()=>!card.isConnected,'retry removes the card');
 assert.match(heading(),/\(1\)/);assert.equal(h.internal.getHiddenCount(),1);
 const search=h.document.querySelector('.je-hidden-management-search');search.value='Title';search.dispatchEvent(new h.window.Event('input'));
 assert.equal(h.document.querySelectorAll('.je-hidden-item-card').length,0,'a confirmed unhide does not reappear in the panel search');
});
test('manager panel removes the card only once the unhide is confirmed',async t=>{
 const h=hcSetup(t,{items:{'movie:tmdb:42':providerRule['movie:tmdb:42']},ajax:()=>({items:{},revision:'r2'})});
 const timers=controlTimers(h);h.internal.showManagementPanel();
 h.document.querySelector('.je-hidden-item-unhide').click();timers.fire();
 await until(()=>!h.document.querySelector('.je-hidden-item-card'),'card removed');
 assert.match(h.document.querySelector('.je-hidden-management-header h2').textContent,/\(0\)/);
 assert.ok(h.document.querySelector('.je-hidden-management-empty'));assert.equal(h.internal.getHiddenCount(),0);
});
test('manager panel Unhide submitted before closing still completes for the same viewer',async t=>{
 const h=hcSetup(t,{items:{'movie:tmdb:42':providerRule['movie:tmdb:42']},ajax:()=>({items:{},revision:'r2'})});
 const timers=controlTimers(h);h.internal.showManagementPanel();
 h.document.querySelector('.je-hidden-item-unhide').click();h.document.querySelector('.je-hidden-management-close').click();
 timers.fire();await until(()=>h.internal.getHiddenCount()===0,'unhide completes');assert.equal(h.ajaxCalls[0].type,'DELETE');
});

/** The full Hidden Content page with real routing (own store or admin endpoint). */
function pageSetup(t,{items,ajax,admin}){
 const h=hcSetup(t,{items,ajax});
 for(const m of ['state','admin'])h.load(`enhanced/hiddencontent/hidden-content-page-${m}.js`);
 const page=h.JE.internals.hiddenContentPage;page.showUnhideConfirmation=(message,confirm)=>confirm();
 for(const m of ['cards','render'])h.load(`enhanced/hiddencontent/hidden-content-page-${m}.js`);
 if(admin){h.JE.pluginConfig.HiddenContentAdmin=true;Object.assign(page.state,{adminIsAdmin:true,adminUsers:[{userId:'target-c',userName:'C',count:admin.length}],selectedAdminUserId:'target-c',adminEditMode:true,adminItemsUserId:'target-c',adminItems:admin});}
 const container=h.document.createElement('div');h.document.body.appendChild(container);
 return {...h,page,container};
}
const episodes=[{type:'Episode',itemId:'e1',_key:'e1',name:'One',seriesId:'s',seriesName:'Show',seasonNumber:1,episodeNumber:1},{type:'Episode',itemId:'e2',_key:'e2',name:'Two',seriesId:'s',seriesName:'Show',seasonNumber:1,episodeNumber:2}];
for(const host of ['standard card','group card','group item'])test(`manager page ${host} is restored with a retry when unhide fails`,async t=>{
 const h=pageSetup(t,{items:host==='group card'?{'tv:tmdb:7':{itemId:'',type:'Series',tmdbId:'7',name:'Show',hideScope:'global'}}:{...providerRule},
  ajax:unavailable,admin:host==='group item'?episodes:null});
 const timers=controlTimers(h);h.page.renderPage(h.container);
 const selector=host==='standard card'?'.je-hidden-item-unhide':host==='group card'?'.je-hidden-group-unhide':'.je-hidden-group-item-unhide';
 const button=h.container.querySelector(selector);const entry=host==='standard card'?button.closest('.je-hidden-item-card'):host==='group card'?button.closest('.je-hidden-group-card'):button.closest('.je-hidden-group-item');
 button.click();assert.equal(timers.fire(),1);await until(()=>h.ajaxCalls.length===1,'unhide sent');for(let i=0;i<10;i++)await tick();
 assert.equal(entry.isConnected,true);assert.equal(entry.classList.contains('je-hidden-item-removing'),false,'fade removed');assert.equal(entry.style.opacity,'','opacity restored');
 assert.equal(button.textContent,'hidden_content_unhide_failed_retry');
});
test('manager page bulk unhide reports a failed write',async t=>{
 const h=pageSetup(t,{items:{},ajax:unavailable,admin:episodes});h.page.renderPage(h.container);
 h.container.querySelector('.je-hidden-content-page-unhide-all').click();
 await until(()=>h.ajaxCalls.length>=1,'bulk write');for(let i=0;i<10;i++)await tick();
 assert.deepEqual(h.toasts,['hidden_content_unhide_failed_retry'],'bulk failure is visible');
});
test('the manager page is dismissed on an identity change and its controls cannot write',async t=>{
 const h=pageSetup(t,{items:{...providerRule},ajax:()=>({items:{},revision:'r2'})});
 const timers=controlTimers(h);h.page.renderPage(h.container);
 const button=h.container.querySelector('.je-hidden-item-unhide');assert.ok(button);
 button.click();h.switchUser();
 assert.equal(h.container.querySelector('.je-hidden-item-card'),null,'outgoing viewer\'s list is gone');
 button.click();timers.fire();for(let i=0;i<10;i++)await tick();assert.equal(h.ajaxCalls.length,0,'no write from the dismissed view');
});

/** Admin Add modal with the real core transport; records each request's credentials. */
function addSetup(t){
 let user='a',token='token-a';const sent=[];let hideGate=null;
 const h=createHarness({JE:{t:k=>k,pluginConfig:{HiddenContentEnabled:true}},
  apiClient:{getCurrentUserId:()=>user,accessToken:()=>token,setAuthenticationInfo(next,u){token=next;user=u;}},
  fetch:async(url,o)=>{sent.push({url,method:o.method||'GET',token:o.headers?.['X-Emby-Token'],body:o.body});
   if(url.endsWith('/Items'))return jsonResponse({Items:[{Id:'m1',Name:'Captured Title',Type:'Movie',ProviderIds:{Tmdb:'42'}}]});
   if(url.endsWith('/hide'))return hideGate?hideGate.promise:jsonResponse({added:1});
   return jsonResponse({});}});
 t.after(()=>h.close());
 for(const m of ['navigation','session','api-client'])h.load('core/'+m+'.js');h.load('core/session-action.js');
 h.load('enhanced/hiddencontent/hidden-content-save.js');const internal=h.JE.internals.hiddenContent;
 h.JE.hiddenContent={adminHideForUser:internal.adminHideForUser,adminUnhideForUser:internal.adminUnhideForUser};
 for(const m of ['state','admin'])h.load(`enhanced/hiddencontent/hidden-content-page-${m}.js`);
 const page=h.JE.internals.hiddenContentPage;let renders=0;page.renderPage=()=>{renders++;};
 Object.assign(page.state,{selectedAdminUserId:'target-c',adminUserName:'C',adminItems:[],adminItemsUserId:'target-c'});
 const timers=controlTimers(h);
 async function search(term){const input=h.document.querySelector('.je-hidden-admin-add-overlay .je-hidden-management-search');input.value=term;input.dispatchEvent(new h.window.Event('input'));}
 return {...h,page,sent,timers,search,renders:()=>renders,gate(){hideGate=deferred();return hideGate;},switchUser(){h.window.ApiClient.setAuthenticationInfo('token-b','b');}};
}
test('identity change dismisses the admin Add modal; its search and captured results never submit',async t=>{
 const h=addSetup(t);h.page.openAdminAddModal();await h.search('Captured');h.timers.fire();
 await until(()=>h.document.querySelector('.je-hidden-admin-add-overlay .je-hidden-item-card'),'results');
 const hide=h.document.querySelector('.je-hidden-admin-add-overlay .je-hidden-item-unhide');
 await h.search('Captured T');const searchesBefore=h.sent.filter(s=>s.url.endsWith('/Items')).length;
 h.switchUser();
 assert.equal(h.document.querySelector('.je-hidden-admin-add-overlay'),null,'modal dismissed');
 assert.equal(h.document.body.style.overflow,'','page scroll restored');
 assert.equal(h.timers.live().length,0,'pending search timer cancelled');
 h.timers.fire();hide.click();for(let i=0;i<20;i++)await tick();
 assert.equal(h.sent.filter(s=>s.url.endsWith('/Items')).length,searchesBefore,'no search after the switch');
 assert.equal(h.sent.filter(s=>s.url.endsWith('/hide')).length,0,'captured title is never hidden for anyone');
 assert.equal(h.sent.filter(s=>s.token==='token-b').length,0);
});
test('a search reply that lands after an identity change is not published',async t=>{
 const h=addSetup(t);const reply=deferred();const original=h.window.fetch;h.window.fetch=(u,o)=>u.endsWith('/Items')?reply.promise:original(u,o);
 h.page.openAdminAddModal();const overlay=h.document.querySelector('.je-hidden-admin-add-overlay');await h.search('Captured');h.timers.fire();await tick();
 h.switchUser();reply.resolve(jsonResponse({Items:[{Id:'m1',Name:'Captured Title',Type:'Movie'}]}));for(let i=0;i<20;i++)await tick();
 assert.equal(overlay.querySelector('.je-hidden-item-card'),null);
});
test('a Hide submitted in the session completes after the Add modal closes',async t=>{
 const h=addSetup(t);h.page.openAdminAddModal();await h.search('Captured');h.timers.fire();
 await until(()=>h.document.querySelector('.je-hidden-admin-add-overlay .je-hidden-item-card'),'results');
 const gate=h.gate();h.document.querySelector('.je-hidden-admin-add-overlay .je-hidden-item-unhide').click();
 await until(()=>h.sent.some(s=>s.url.endsWith('/hide')),'hide submitted');
 h.document.dispatchEvent(new h.window.KeyboardEvent('keydown',{key:'Escape'}));
 assert.equal(h.document.querySelector('.je-hidden-admin-add-overlay'),null);
 gate.resolve(jsonResponse({added:1}));await until(()=>h.page.state.adminItems.length===1,'hide recorded');
 assert.equal(h.page.state.adminItems[0]._key,'m1');assert.equal(h.renders(),1);
 assert.equal(h.sent.find(s=>s.url.endsWith('/hide')).token,'token-a');
});

/** Native card filtering with an ajax fixture that can fail its first reads. */
function filterSetup(t,items,reply){
 const reads=[];
 const h=createHarness({apiClient:{getCurrentUserId:()=>'viewer-a',getUrl:(path,params)=>`http://jellyfin.test${path}${params?'?'+new URLSearchParams(params):''}`,ajax:async o=>{reads.push(o.url);return reply(o,reads.length);}},
  JE:{t:k=>k,pluginConfig:{HiddenContentEnabled:true},userConfig:{hiddenContent:{items,settings:{showButtonLibrary:false}}},
   session:{getEpoch:()=>1,isCurrent:()=>true,onUserChange(){},userScopedKey:k=>k}}});
 t.after(()=>h.close());h.load('enhanced/hiddencontent/hidden-content-data.js');
 const api=h.JE.internals.hiddenContent;Object.assign(api,{refreshNativeCardVisibility(){},restoreNativeCardsForIds(){},debouncedSave(){}});api.resetFromUserConfig();
 h.load('enhanced/hiddencontent/hidden-content-filter.js');h.load('enhanced/hiddencontent/hidden-content-buttons.js');
 const settle=async()=>{for(let i=0;i<4;i++){await tick();await new Promise(r=>h.window.requestAnimationFrame(r));}};
 const later=ms=>{const now=h.window.Date.now;h.window.Date.now=()=>now()+ms;};
 return {...h,api,reads,settle,later};
}
test('a failed parent provider batch is retried by a later view, not cached for the session',async t=>{
 const h=filterSetup(t,{provider:{type:'Series',tmdbId:'42'}},(o,n)=>{
  if(o.url.includes('SeriesId'))return {Items:[{Id:'episode',Type:'Episode',SeriesId:'series'}]};
  if(n===2)unavailable();return {Items:[{Id:'series',Type:'Series',ProviderIds:{Tmdb:'42'}}]};});
 const view=()=>{h.document.body.innerHTML='<div class="section">'+'<div class="card" data-id="episode" data-type="Episode"></div>'.repeat(3)+'</div>';h.api.filterNativeCards();};
 view();await h.settle();assert.equal(h.document.querySelectorAll('.je-hidden').length,0,'outage: nothing resolved');
 const failed=h.reads.length;view();await h.settle();assert.equal(h.reads.length,failed,'no retry storm inside the window');
 h.later(31000);view();await h.settle();
 assert.equal(h.document.querySelectorAll('.je-hidden').length,3,'the provider-hidden parent applies once reads recover');
});
test('a failed ID-only card title batch is retried for the same retained card',async t=>{
 const h=filterSetup(t,{provider:{type:'Movie',tmdbId:'42'}},(o,n)=>{if(n===1)unavailable();return {Items:[{Id:'copy',Type:'Movie',ProviderIds:{Tmdb:'42'}}]};});
 h.document.body.innerHTML='<div class="card" data-id="copy" data-type="Movie"><div class="cardBox"></div></div>';
 h.api.filterNativeCards();await h.settle();const card=h.document.querySelector('.card');assert.equal(card.dataset.tmdbId,undefined);
 h.later(31000);h.api.filterNativeCards();await h.settle();
 assert.equal(card.dataset.tmdbId,'42','retained card resolves its title after the outage');
});
test('a failed single parent lookup is not cached as "no parent"',async t=>{
 const h=filterSetup(t,{series:{itemId:'series',type:'Series',name:'Show',hideScope:'global'}},(o,n)=>{
  if(n<=2)unavailable();return o.url.includes('/Items/episode')?{SeriesId:'series'}:{Items:[{Id:'episode',SeriesId:'series'}]};});
 const view=()=>{h.document.body.innerHTML='<div class="section"><div class="card" data-id="episode" data-type="Episode"></div></div>';h.api.filterNativeCards();};
 view();await h.settle();assert.equal(h.document.querySelectorAll('.je-hidden').length,0);
 view();await h.settle();assert.equal(h.document.querySelectorAll('.je-hidden').length,1,'the next view looks the parent up again');
});
