import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHarness,deferred,jsonResponse,jsRoot} from '../helpers/harness.mjs';
const tick=()=>new Promise(r=>setImmediate(r));
function setup(t) {
 let user='a', token='token-a', state={};const calls=[];let slow=null;
 const h=createHarness({html:'<div id="itemDetailPage"><h1 class="itemName">Title</h1><div class="detailButtons"></div></div>',
 apiClient:{getCurrentUserId:()=>user,accessToken:()=>token,setAuthenticationInfo(t,u){token=t;user=u;}},
 JE:{t:k=>k,pluginConfig:{SpoilerBlurEnabled:true},core:{ui:{placeDetailAction:(row,b)=>row.appendChild(b)}}},
 fetch:async(url,o)=>{calls.push({url,...o});if(url.includes('native-details'))return slow.promise;
 if(o.method==='GET')return jsonResponse(state);
 const kind=url.includes('/movies/')?'Movies':url.includes('/collections/')?'Collections':'Series';
 if(url.includes('/pending/'))state={ProviderTitles:{'movie:tmdb:42':{}},Movies:{aabb:{},ccdd:{}}};
 else if(o.method==='DELETE')state={};else state={[kind]:{aabb:{}}};
 return jsonResponse({success:true});}});
 t.after(()=>h.close());for(const m of ['navigation','session','api-client'])h.load('core/'+m+'.js');
 for(const m of ['ids','state','detail-button','seerr-toggle'])h.load('enhanced/spoilerguard/'+m+'.js');
 let reloads=0;const api=h.JE.internals.spoilerGuard;Object.assign(api,{confirmDisableSpoiler:async()=>true,refreshSpoilerableImages(){},scheduleFullReload(){reloads++;},getUserPrefs:()=>({})});
 return {...h,get NATIVE(){return h.NATIVE;},api,calls,reloads:()=>reloads,setState(v){state=v;},slow(){slow=deferred();return slow;}};
}
for(const kind of ['Movie','Series','Collection'])test(`native ${kind} invalidates old provider reply and refreshes page`,async t=>{
 const h=setup(t);await h.api.loadState();const old=h.slow();
 let refresh=0;h.window.addEventListener('je-spoiler-policy-changed',()=>refresh++);
 const pending=h.JE.core.api.plugin('/native-details/movie/42',{cacheKey:'title'});
 const result=pending.then(v=>({v}),e=>({e}));
 h.api.addSpoilerBlurButton('aabb',h.document.querySelector('#itemDetailPage'),kind==='Collection'?'BoxSet':kind);
 h.click(h.document.querySelector('.je-spoiler-blur-btn'));await tick();
 old.resolve(jsonResponse({overview:'old spoiler',jeSpoiler:{guarded:false}}));
 assert.equal((await result).e?.name,'AbortError');assert.equal(refresh,1);assert.equal(h.reloads(),1,'native page refreshes even with strict refresh off');
 assert.equal(h.JE.core.api.manager.getCached('title'),null);
});
for(const [kind,type,field] of [['Movie','movie','Movies'],['Series','tv','Series']])test(`${kind} arrival then native disable reconciles all copies and provider control`,async t=>{
 const h=setup(t);h.setState({ProviderTitles:{[type+':tmdb:42']:{}},[field]:{aabb:{},ccdd:{}}});await h.api.loadState();
 assert.equal(h.api.isTmdbEnabled(type,42),true);
 h.api.addSpoilerBlurButton('aabb',h.document.querySelector('#itemDetailPage'),kind==='Collection'?'BoxSet':kind);
 h.click(h.document.querySelector('.je-spoiler-blur-btn'));await tick();
 assert.equal(h.api.isTmdbEnabled(type,42),false);assert.equal(h.api.isEnabledForKind(kind.toLowerCase(),'ccdd'),false);
 const b=h.api.buildSeerrToggle({id:42,title:'Title'},type,{detail:true});
 assert.equal(b.getAttribute('aria-pressed'),'false');assert.match(b.title,/button_off/);
});
for(const host of ['provider page','card','jf10 window'])test(`${host} adopts server state and emits once`,async t=>{
 const h=setup(t);await h.api.loadState();let events=0;h.window.addEventListener('je-spoiler-policy-changed',()=>events++);
 const b=h.api.buildSeerrToggle({id:42,title:'Title'},'movie',{detail:host==='provider page'});h.document.body.appendChild(b);h.click(b);await tick();
 assert.equal(h.api.isMovieEnabledFor('ccdd'),true,'all server copies adopted');assert.equal(events,1);assert.equal(b.getAttribute('aria-pressed'),'true');
});
test('all Spoiler Guard mutations use one authoritative update path',()=>{
 const state=readFileSync(resolve(jsRoot,'enhanced/spoilerguard/state.js'),'utf8');
 assert.match(state,/function mutateState\(/);
 for(const name of ['enableForSeries','disableForSeries','enableForMovie','disableForMovie','enableForCollection','disableForCollection','enableForTmdb','disableForTmdb','setUserPrefs']){
  const body=state.split('internal.'+name+' = function')[1]?.split('\n    };')[0];assert.ok(body?.includes('mutateState('),name);
 }
 for(const file of ['detail-button.js','seerr-toggle.js','settings-tab.js'])assert.doesNotMatch(readFileSync(resolve(jsRoot,'enhanced/spoilerguard',file),'utf8'),/dispatchEvent\(new CustomEvent\('je-spoiler-policy-changed'/);
});
for(const host of ['group card','group item','standard card'])for(const mode of ['switch','identity','epoch','server','token','close'])test(`manager ${host} fade belongs to session (${mode})`,async t=>{
 let user='a',epoch=1,server='one',token='token-a';const writes=[],timers=[];
 const h=createHarness({JE:{t:k=>k,session:{getEpoch:()=>epoch,isCurrent:e=>e===epoch,onUserChange(){}},hiddenContent:{getAllHiddenItems:()=>[{type:'Movie',itemId:'x',name:'Title'}],createItemCard:()=>{const c=h.document.createElement('div');c.innerHTML='<button class="je-hidden-item-unhide"></button>';return c;}}},apiClient:{getCurrentUserId:()=>user,serverId:()=>server,accessToken:()=>token}});
 t.after(()=>h.close());h.load('enhanced/hiddencontent/hidden-content-page-state.js');const api=h.JE.internals.hiddenContentPage;
 Object.assign(api,{adminActionScope:()=>({origin:h.JE.core.userWrite.origin(),uid:null,token:api.state.adminLoadToken}),showUnhideConfirmation:(m,fn)=>fn(),handleUnhide:key=>writes.push({key,user}),handleUnhideMany(){},applyAdminThemeVars(){},maybeInitAdminFilter(){},createPageContainer(){}});
 h.load('enhanced/hiddencontent/hidden-content-page-cards.js');h.load('enhanced/hiddencontent/hidden-content-page-render.js');
 h.window.setTimeout=fn=>{timers.push(fn);return timers.length;};
 const hostEl=h.document.createElement('div');h.document.body.appendChild(hostEl);
 if(host==='standard card')api.renderPage(hostEl);
 else hostEl.appendChild(api.createGroupCard({seriesId:'s',seriesName:'Title',items:host==='group card'?[{type:'Series',itemId:'x',name:'Title'}]:[{type:'Episode',itemId:'x',name:'One',seasonNumber:1,episodeNumber:1},{type:'Episode',itemId:'y',name:'Two',seasonNumber:1,episodeNumber:2}]}));
 const sel=host==='standard card'?'.je-hidden-item-unhide':host==='group card'?'.je-hidden-group-unhide':'.je-hidden-group-item-unhide';h.click(hostEl.querySelector(sel));
 assert.equal(timers.length,1);if(mode==='switch'){user='b';epoch++;}else if(mode==='identity')user='b';else if(mode==='epoch')epoch++;else if(mode==='server')server='two';else if(mode==='token')token='token-b';else hostEl.remove();
 timers.shift()();assert.equal(writes.length,mode==='close'?1:0);if(writes.length)assert.equal(writes[0].user,'a');
});

test('a successful write invalidates old reads while its authoritative refresh is still pending',async t=>{
 const h=setup(t);await h.api.loadState();const old=h.slow(),refresh=deferred();
 const original=h.window.fetch;let hold=false;
 h.window.fetch=(u,o)=>hold&&u.endsWith('/spoiler-blur/series')&&o.method==='GET'?refresh.promise:original(u,o);
 const pending=h.JE.core.api.plugin('/native-details/movie/42');const result=pending.then(v=>({v}),e=>({e}));
 hold=true;const save=h.api.enableForMovie('aabb', undefined, h.NATIVE);await tick();old.resolve(jsonResponse({overview:'stale'}));
 assert.equal((await result).e?.name,'AbortError');refresh.resolve(jsonResponse({Movies:{aabb:{}}}));await save;
});
for(const host of ['native','provider'])test(`${host} silently discards a rejected write after switching viewers`,async t=>{
 const h=setup(t);await h.api.loadState();const write=deferred(),toasts=[];h.JE.toast=m=>toasts.push(m);
 const fetch=h.window.fetch;h.window.fetch=(u,o)=>o.method==='POST'?write.promise:fetch(u,o);
 let button;if(host==='native'){h.api.addSpoilerBlurButton('aabb',h.document.querySelector('#itemDetailPage'),'Movie');button=h.document.querySelector('.je-spoiler-blur-btn');}
 else {button=h.api.buildSeerrToggle({id:42,title:'Title'},'movie',{detail:true});h.document.body.append(button);}
 h.click(button);await tick();h.window.ApiClient.setAuthenticationInfo('token-b','b');write.reject(new h.window.DOMException('Session changed','AbortError'));await tick();
 assert.deepEqual(toasts,[],'incoming viewer does not get an outgoing action failure toast');
});
