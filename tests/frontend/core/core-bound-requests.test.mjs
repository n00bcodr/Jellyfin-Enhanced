// D46 r17 (review round 16, D46-R16-3): a deferred request carries the session that asked for it (and optionally its
// owner's current() predicate), and the core transport checks both immediately before the bytes go out: after the
// queue releases it, after any prerequisite the caller awaited, and before each retry attempt. Otherwise it rejects
// with an AbortError and nothing is sent. Every retry path (Elsewhere, the Requests page, the Manage drawer, admin
// tabs, details status, people tags, seamless scroll) sends through it. Real core modules (navigation, session,
// session-action, api-client) and the real feature modules; fetch is the only fixture.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {setTimeout as wait} from 'node:timers/promises';
import {createHarness, deferred, jsonResponse, jsRoot} from '../helpers/harness.mjs';

const tick=()=>new Promise(r=>setImmediate(r));
async function settle(n=60){for(let i=0;i<n;i++)await tick();}
const A='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',B='bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const en=JSON.parse(readFileSync(resolve(jsRoot,'locales/en.json'),'utf8'));
const translate=(key,params)=>Object.entries(params||{}).reduce((s,[k,v])=>s.split(`{${k}}`).join(String(v)),en[key]??key);

/** A harness with the real core transport. `route(path, sent)` answers each request (a Response, a promise of one, or null). */
function setup(t,{html='',hash='#/home',JE={},route=()=>null,core=['navigation','session','api-client']}={}){
 let user=A,token='token-a';
 const sent=[];
 const h=createHarness({html,url:`http://jellyfin.test/web/index.html${hash}`,
  apiClient:{getCurrentUserId:()=>user,accessToken:()=>token,serverId:()=>'server-a',
   setAuthenticationInfo(nextToken,nextUser){token=nextToken;user=nextUser;}},
  JE:{t:translate,helpers:{debounce:fn=>fn,addCSS(){},onBodyMutation:()=>({unsubscribe(){}}),onSidebarRebuilt(){}},...JE},
  fetch:async(url,options={})=>{
   const path=String(url).replace('http://jellyfin.test','');
   const request={path,method:options.method||'GET',token:options.headers?.['X-Emby-Token']};
   sent.push(request);
   const answer=await route(path,request);
   return answer||jsonResponse({});
  }});
 t.after(()=>h.close());
 for(const m of core)h.load('core/'+m+'.js');
 h.JE.core.api.manager.CONFIG.retry.baseDelayMs=1;h.JE.core.api.manager.CONFIG.retry.maxDelayMs=2;
 return {h,sent,
  /** Another account signs in; 'silent': before the session hook has seen it (detection is delayed on some hosts). */
  switchAccount(mode){if(mode==='silent'){user=B;token='token-b';return;}h.window.ApiClient.setAuthenticationInfo('token-b',B);},
  sentAs:(token,match)=>sent.filter(s=>s.token===token&&(!match||s.path.includes(match)))};
}

/** Holds every pool slot so the next request waits in the queue until release(). */
function holdPool(h){
 const gates=Array.from({length:h.JE.core.api.manager.CONFIG.concurrency?.maxConcurrent||4},deferred);
 const busy=gates.map(g=>h.JE.core.api.manager.withConcurrencyLimit(()=>g.promise));
 return async()=>{gates.forEach(g=>g.resolve());await Promise.all(busy);};
}

// ---- The primitive. ----

test('a request bound to a session that is no longer signed in is never sent (switch during the prerequisite await)',async t=>{
 const {h,sent,switchAccount}=setup(t);
 const session=h.JE.core.api.session();
 const prerequisite=deferred();
 const run=(async()=>{await prerequisite.promise;return h.JE.core.api.plugin('/acquire/hub',{skipRetry:true,bound:{session}});})();
 const outcome=run.then(v=>({v}),e=>({e}));
 switchAccount();prerequisite.resolve();
 const result=await outcome;
 assert.equal(result.e?.name,'AbortError');
 assert.equal(sent.length,0,'nothing is sent, and never with the incoming account\'s token');
});

for(const method of ['GET','POST'])
test(`a queued bound ${method} whose current() turns false while queued is never sent`,async t=>{
 const {h,sent}=setup(t);
 const release=holdPool(h);
 let live=true;
 const pending=h.JE.core.api.plugin('/acquire/requests',{method,body:method==='POST'?{tmdbId:1}:undefined,bound:{session:h.JE.core.api.session(),current:()=>live}});
 const outcome=pending.then(v=>({v}),e=>({e}));
 live=false;
 await release();
 const result=await outcome;
 assert.equal(result.e?.name,'AbortError');
 assert.equal(sent.length,0,'send count 0');
});

test('a queued bound write is never sent after another account signs in while it waits',async t=>{
 const {h,sent,switchAccount}=setup(t);
 const release=holdPool(h);
 const pending=h.JE.core.api.plugin('/acquire/requests',{method:'POST',body:{tmdbId:1},bound:{session:h.JE.core.api.session()}});
 const outcome=pending.then(v=>({v}),e=>({e}));
 switchAccount();await release();
 assert.equal((await outcome).e?.name,'AbortError');
 assert.equal(sent.length,0);
});

test('a bound request whose owner ends during the retry backoff is not sent again',async t=>{
 let live=true;
 const {h,sent}=setup(t,{route:()=>{live=false;return jsonResponse({},503);}});
 const outcome=h.JE.core.api.plugin('/retry',{bound:{session:h.JE.core.api.session(),current:()=>live}}).then(v=>({v}),e=>({e}));
 const result=await outcome;
 assert.equal(result.e?.name,'AbortError');
 assert.equal(sent.length,1,'only the first attempt went out');
});

test('controls: a bound request of the signed-in session is sent once with its token; an unbound call keeps today\'s behaviour',async t=>{
 const {h,sent,switchAccount}=setup(t,{route:()=>jsonResponse({ok:true})});
 const bound=await h.JE.core.api.plugin('/acquire/hub',{skipRetry:true,bound:{session:h.JE.core.api.session(),current:()=>true}});
 assert.equal(bound.ok,true);
 assert.deepEqual(sent.map(s=>s.token),['token-a']);
 // A native call made after the switch is the new account's own request (unchanged; nothing binds it).
 switchAccount();
 await h.JE.core.api.plugin('/acquire/hub',{skipRetry:true});
 assert.deepEqual(sent.map(s=>s.token),['token-a','token-b']);
});

test('a session action carries its session into the transport: action.bound(current) is the request binding',async t=>{
 const {h,sent,switchAccount}=setup(t,{route:()=>jsonResponse({ok:true})});
 const action=h.JE.createSessionAction();
 let open=true;
 const binding=action.bound(()=>open);
 assert.equal(binding.session,action.session);
 assert.equal((await h.JE.core.api.plugin('/x',{bound:binding})).ok,true);
 open=false;
 await assert.rejects(h.JE.core.api.plugin('/x',{bound:binding}),{name:'AbortError'});
 open=true;switchAccount();
 await assert.rejects(h.JE.core.api.plugin('/x',{bound:binding}),{name:'AbortError'});
 assert.equal(sent.length,1);
});

// ---- Every retry path: another account signs in during the retry's prerequisite await. ----

const ARR=['arr/status/status-core.js','arr/status/status-episodes.js','arr/status/status-details.js','arr/status/status-cards.js',
 'arr/status/status-modal.js','arr/status/status-styles.js','arr/manage/manage-styles.js','arr/manage/manage-drawer.js',
 'arr/hub/hub-styles.js','arr/hub/hub-render.js','arr/hub/hub-page.js'];

/** The change feed: position() is unknown, so every status read awaits prime() first (held when `hold` is set). */
function feed(){
 const subs=[];let hold=null;
 return {subs,live:()=>subs.filter(s=>s.active),hold(){hold=deferred();return hold;},
  arr:{live:{position:()=>null,prime:()=>hold?hold.promise:Promise.resolve({epoch:'e1',cursor:7})},
   onStatusChange(keys,cb,opts){const sub={keys:[...keys],cb,opts,active:true};subs.push(sub);return()=>{sub.active=false;};}}};
}

/** Runs the retry timers (5 s and longer) by hand; shorter ones run normally. */
function holdLongTimers(h){
 const held=new Map();let next=1e6;
 const realSet=h.window.setTimeout.bind(h.window),realClear=h.window.clearTimeout.bind(h.window);
 h.window.setTimeout=(fn,ms,...a)=>{if(!(ms>=5000))return realSet(fn,ms,...a);const id=next++;held.set(id,fn);return id;};
 h.window.clearTimeout=id=>{if(held.has(id))held.delete(id);else realClear(id);};
 return {run(){const all=[...held.values()];held.clear();all.forEach(fn=>fn());return all.length;},count:()=>held.size};
}

/** Waits (up to 5 s) until `check` is true. */
async function until(check,ms=5000){const end=Date.now()+ms;while(!check()&&Date.now()<end)await wait(20);}

const hubAnswer={contact:'Dad',lookingHours:24,seerr:{configured:true,loaded:true,unavailable:false},
 mine:[{key:'movie:tmdb:693134',kind:'movie',tmdbId:693134,title:'Dune',year:2024,request:'approved',group:'onTheWay',
  status:{key:'movie:tmdb:693134',kind:'movie',stage:'downloading',reason:{code:'downloading'},quiet:false,actions:[]}}],soon:[],ready:[]};

test('the Requests page: a retry is never sent as another account that signs in while it awaits the feed position',async t=>{
 const f=feed();let fail=false;
 const s=setup(t,{hash:'#/requests',html:'<div class="mainDrawer"><div class="jellyfinEnhancedSection"></div></div><div class="mainAnimatedPages"><div class="mainAnimatedPage" id="homePage"></div></div>',
  JE:{pluginConfig:{ArrStatusEnabled:true,ArrRequestsHubEnabled:true},arr:f.arr,core:{lifecycle:{register:()=>({track:x=>x})}}},
  route:path=>path.startsWith('/JellyfinEnhanced/acquire/hub')?(fail?jsonResponse({},502):jsonResponse(hubAnswer)):null});
 for(const m of ARR)s.h.load(m);
 const timers=holdLongTimers(s.h);
 s.h.JE.initializeArrStatus();await settle();
 assert.equal(s.sentAs('token-a','/acquire/hub').length,1);
 fail=true;f.live().at(-1).cb(['movie:tmdb:693134']);await until(()=>s.h.document.querySelector('.je-hub-refresh-failed'));
 assert.ok(s.h.document.querySelector('.je-hub-refresh-failed'),'the re-read failed and a retry is scheduled');
 const held=f.hold();assert.equal(timers.run(),1);await settle();
 s.switchAccount();fail=false;held.resolve({epoch:'e1',cursor:8});await settle();await wait(30);
 assert.equal(s.sentAs('token-b','/acquire/hub').length,0,'the retry is never sent with the new account\'s token');
});

test('the Manage drawer: a retry is never sent as another account that signs in while it awaits the feed position',async t=>{
 const f=feed();let fail=false;
 const s=setup(t,{JE:{pluginConfig:{ArrStatusEnabled:true,ArrManageDrawerEnabled:true},arr:f.arr,core:{lifecycle:{register:()=>({track:x=>x})}}},
  route:path=>path.startsWith('/JellyfinEnhanced/arr/admin/manage?')?(fail?jsonResponse({},502):jsonResponse({key:'movie:tmdb:1',kind:'movie',title:'Dune',
   status:{key:'movie:tmdb:1',kind:'movie',stage:'downloading',reason:{code:'downloading'},quiet:false,actions:[]},instances:[],requests:[]})):null});
 for(const m of ARR)s.h.load(m);
 const timers=holdLongTimers(s.h);
 s.h.JE.initializeArrStatus();
 await s.h.JE.arrManage.open({key:'movie:tmdb:1'}, { operation: s.h.NATIVE });await settle();
 fail=true;f.live().find(x=>x.keys.includes('movie:tmdb:1')).cb(['movie:tmdb:1']);await until(()=>s.h.document.querySelector('.je-manage-stale'));
 assert.ok(s.h.document.querySelector('.je-manage-stale'));
 const held=f.hold();assert.equal(timers.run(),1);await settle();
 s.switchAccount();fail=false;held.resolve({epoch:'e1',cursor:8});await settle();await wait(30);
 assert.equal(s.sentAs('token-b','/arr/admin/manage').length,0);
});

const detailsHtml='<div id="itemDetailPage" class="page libraryPage"><div class="detailPagePrimaryContent"><div class="detailSection"><form class="trackSelections"></form></div></div></div>';

for(const mode of ['hooked','silent'])
test(`details status: a re-read is never sent as another account that signs in while it awaits the feed position (${mode})`,async t=>{
 const f=feed();
 const s=setup(t,{html:detailsHtml,hash:'#/details?id=movie1',JE:{pluginConfig:{ArrStatusEnabled:true},arr:f.arr,core:{lifecycle:{register:()=>({track:x=>x})}}},
  route:path=>path.includes('/acquire/status/item/')?jsonResponse({items:[{key:'movie:tmdb:1',kind:'movie',stage:'downloading',reason:{code:'downloading'},quiet:false,actions:[]}]}):null});
 for(const m of ARR)s.h.load(m);
 await s.h.JE.internals.arrStatusDetails.update(false);
 assert.equal(s.sentAs('token-a','/acquire/status/item/').length,1);
 const held=f.hold();
 const reread=s.h.JE.internals.arrStatusDetails.update(true);await settle();
 s.switchAccount(mode);held.resolve({epoch:'e1',cursor:8});await reread;await settle();
 assert.equal(s.sentAs('token-b','/acquire/status/item/').length,0);
});

test('admin tabs: a retry released from the queue after another account signs in is never sent',async t=>{
 const s=setup(t,{route:()=>jsonResponse({})});
 const sources=readFileSync(resolve(jsRoot,'arr/admin/admin-tabs.js'),'utf8');
 assert.match(sources,/bound:\s*action\?\.bound/);
 // The transport half of the contract (the tab passes its action's binding): the queued retry is refused at release.
 const action=s.h.JE.createSessionAction();
 const release=holdPool(s.h);
 const pending=s.h.JE.core.api.plugin('/arr/admin/overview',{skipRetry:true,bound:action.bound(()=>true)}).then(v=>({v}),e=>({e}));
 s.switchAccount();await release();
 assert.equal((await pending).e?.name,'AbortError');
 assert.equal(s.sent.length,0);
});

test('Elsewhere: a same-session policy retry is asked again with its session; a switch while it is queued sends nothing',async t=>{
 const held=[];
 const PROVIDERS={results:{US:{link:'https://tmdb.test/watch',flatrate:[{provider_id:8,provider_name:'Netflix',logo_path:'/n.png',display_priority:1}]}}};
 const s=setup(t,{html:'<div class="detailSectionContent"><div class="itemExternalLinks"><a href="https://www.themoviedb.org/movie/603">TMDB</a></div></div>',
  JE:{pluginConfig:{ElsewhereEnabled:true,TmdbEnabled:true,DEFAULT_REGION:'US',ElsewhereSeasonProviders:false},
   helpers:{createObserver(){},onViewPage(){},debounce:fn=>fn},cdn:{url:(_,f)=>'http://cdn.test/'+f},userConfig:{elsewhere:{}}},
  route:path=>{if(path.includes('/watch/providers')){const d=deferred();held.push(d);return d.promise;}
   return jsonResponse(path.includes('regions')?{results:[{iso_3166_1:'US',english_name:'United States'}]}:{results:[]});}});
 s.h.window.requestIdleCallback=fn=>s.h.window.setTimeout(fn,0);
 s.h.load('elsewhere/elsewhere.js');s.h.JE.initializeElsewhereScript();await settle();
 assert.equal(s.sentAs('token-a','/watch/providers').length,1);
 const release=holdPool(s.h);
 s.h.window.dispatchEvent(new s.h.window.Event('je-hidden-content-changed'));
 held[0].resolve(jsonResponse(PROVIDERS));await settle();
 s.switchAccount();await release();await settle();
 assert.equal(s.sentAs('token-b','/watch/providers').length,0);
});

test('seamless scroll: a load retry hands its loader the row\'s binding, so a switch during the loader\'s own await sends nothing',async t=>{
 const s=setup(t,{html:'<section id="feed"><div class="itemsContainer"></div></section>',route:()=>jsonResponse({results:[]})});
 s.h.window.IntersectionObserver=class{constructor(fn){this.fn=fn;}observe(){}disconnect(){}};
 s.h.load('jellyseerr/seamless-scroll.js');
 const P=s.h.JE.seamlessScroll;P.CONFIG.retry.baseDelayMs=1;P.CONFIG.retry.maxDelayMs=1;
 s.h.document.querySelector('section').getClientRects=()=>[{}];
 const state={};t.after(()=>P.cleanupInfiniteScroll(state));
 let loads=0;const prerequisite=deferred();const bindings=[];
 P.setupInfiniteScroll(state,'#feed',async(hint,bound)=>{
  loads++;bindings.push(bound);
  if(loads===1)throw Object.assign(new Error('HTTP 502'),{status:502});
  await prerequisite.promise;
  await s.h.JE.core.api.plugin('/jellyseerr/discover/movies?page=2',{bound});
  return {pages:1,rendered:1};
 },()=>loads<2,()=>false);
 await wait(40);
 assert.equal(loads,2,'the retry ran');
 s.switchAccount();prerequisite.resolve();await settle();await wait(20);
 assert.ok(bindings[1]?.session,'the retry carries the row\'s session');
 assert.equal(s.sentAs('token-b').length,0,'nothing is sent as the new account');
});

// ---- Every retry path sends through the primitive (source scan; the behaviour is tested above and in the modules' own tests). ----

const PATHS={
 'elsewhere/elsewhere.js':[/fetchStreamingData\(/,/bound:\s*action\?\.bound\?\.\(/],
 'arr/hub/hub-page.js':[/\/acquire\/hub/,/bound:\s*action\?\.bound\?\.\(owned\)/],
 // Slice 2: every drawer read and write goes through boundApi, which hands the transport the drawer's binding.
 'arr/manage/manage-drawer.js':[/boundApi\(state, `\/arr\/admin\/manage\?\$\{q\}`, \{ skipRetry: true \}, owned\)/,/JE\.core\.api\.plugin\(path, \{ \.\.\.options, bound: state\.action\.bound\(/],
 'arr/admin/admin-tabs.js':[/route\(tab\)/,/bound:\s*action\?\.bound\?\.\(owned\)/],
 'arr/status/status-details.js':[/fetchItem\(itemId, controller\.signal, action\?\.bound\?\.\(/],
 'arr/status/status-core.js':[/bound: options\?\.bound/],
 'tags/peopletags.js':[/bound:\s*action\?\.bound\?\.\(/],
 'jellyseerr/seamless-scroll.js':[/loadMoreFn\(hint, action\?\.bound\?\.\(/],
 'jellyseerr/discovery/discovery-base.js':[/async function loadMoreItems\(hint, bound\)/,/fetchWithManagedRequest\(path, \{ signal, bound \}\)/,/p, signal, false, bound\)/],
 'jellyseerr/discovery/discovery-filter-utils.js':[/bound: options\.bound/],
 'jellyseerr/recommendations/recommendations-category.js':[/\(hint, bound\) => loadMoreCategoryItems\(st, container, hint, stale, bound\)/,/\?page=\$\{p\}`, \{ bound \}\)/],
 'jellyseerr/jellyseerr.js':[/\(hint, bound\) => loadMoreSearchResults\(query, hint, bound\)/,/throwOnError: true, bound \}/],
 'jellyseerr/api.js':[/\{ skipCache, signal, bound \}/],
};
test('every retry path sends through the bound-request primitive',()=>{
 for(const [file,patterns] of Object.entries(PATHS)){
  const source=readFileSync(resolve(jsRoot,file),'utf8');
  for(const pattern of patterns)assert.match(source,pattern,`${file}: ${pattern}`);
 }
 const core=readFileSync(resolve(jsRoot,'core/api-client.js'),'utf8');
 // ONE primitive: the binding is checked by the transport itself, immediately before fetch().
 assert.equal((core.match(/function bindRequest\(/g)||[]).length,1);
 // (A write marks itself sent there, for its outcome: D46S2 audit S3.)
 assert.match(core,/assertSession\(\);\s*\n\s*if \(onSend\) onSend\(\);\s*\n\s*const response = await fetch\(url, options\);/);
});

// ---- D46 r18 (review round 17, D46-R17-3): the binding is part of request identity. De-duplication, caching and
// queueing key on the binding (its session + its owner's predicate): a bound request never shares an in-flight promise
// with another binding or with an unbound caller, and one binding ending cancels only that binding's request. ----

const outcome=p=>p.then(v=>({v}),e=>({e}));

test('the Requests page: leaving and reopening while the pool is held loads the new visit (the old visit\'s queued read is not adopted)',async t=>{
 const f=feed();
 const s=setup(t,{hash:'#/requests',html:'<div class="mainDrawer"><div class="jellyfinEnhancedSection"></div></div><div class="mainAnimatedPages"><div class="mainAnimatedPage" id="homePage"></div></div>',
  JE:{pluginConfig:{ArrStatusEnabled:true,ArrRequestsHubEnabled:true},arr:f.arr,core:{lifecycle:{register:()=>({track:x=>x})}}},
  route:path=>path.startsWith('/JellyfinEnhanced/acquire/hub')?jsonResponse(hubAnswer):null});
 for(const m of ARR)s.h.load(m);
 const release=holdPool(s.h);
 s.h.JE.initializeArrStatus();await settle();
 // Leave, then come back, while the first visit's read still waits for a pool slot.
 s.h.JE.arrHub.hide();s.h.JE.arrHub.show();await settle();
 await release();await settle();await until(()=>s.h.JE.internals.arrHub.state.data||s.h.JE.internals.arrHub.state.error);
 const state=s.h.JE.internals.arrHub.state;
 assert.equal(s.sentAs('token-a','/acquire/hub').length,1,'the new visit\'s read is sent (the old visit\'s is not)');
 assert.ok(state.data,'the new visit shows its answer');
 assert.ok(!state.error,'no error is shown');
});

test('a bound request and an unbound caller of the same URL never share one request: the bound owner ending leaves the unbound caller\'s answer',async t=>{
 const {h,sent}=setup(t,{route:()=>jsonResponse({ok:true})});
 const release=holdPool(h);
 let live=true;
 const bound=outcome(h.JE.core.api.plugin('/acquire/hub',{bound:{session:h.JE.core.api.session(),current:()=>live}}));
 const unbound=outcome(h.JE.core.api.plugin('/acquire/hub'));
 live=false;
 await release();
 assert.equal((await bound).e?.name,'AbortError');
 assert.equal((await unbound).v?.ok,true,'the unbound caller is not cancelled by another caller\'s binding');
 assert.equal(sent.length,1,'only the unbound caller\'s own request went out');
});

test('a bound request does not adopt an unbound caller\'s in-flight request (its own binding is checked before its own send)',async t=>{
 const {h,sent}=setup(t,{route:()=>jsonResponse({ok:true})});
 const release=holdPool(h);
 const unbound=outcome(h.JE.core.api.plugin('/acquire/hub'));
 const bound=outcome(h.JE.core.api.plugin('/acquire/hub',{bound:{session:h.JE.core.api.session(),current:()=>true}}));
 await release();
 assert.equal((await unbound).v?.ok,true);
 assert.equal((await bound).v?.ok,true);
 assert.equal(sent.length,2,'each sends its own request');
});

test('two bindings of the same URL: the first one\'s owner ending while queued leaves the second binding\'s request sent and answered',async t=>{
 const {h,sent}=setup(t,{route:()=>jsonResponse({ok:true})});
 const release=holdPool(h);
 let first=true;
 const one=outcome(h.JE.core.api.plugin('/acquire/hub',{skipRetry:true,bound:{session:h.JE.core.api.session(),current:()=>first}}));
 const two=outcome(h.JE.core.api.plugin('/acquire/hub',{skipRetry:true,bound:{session:h.JE.core.api.session(),current:()=>true}}));
 first=false;
 await release();
 assert.equal((await one).e?.name,'AbortError');
 assert.equal((await two).v?.ok,true,'the second binding is answered');
 assert.equal(sent.length,1,'only the live binding\'s request went out');
});

test('two bindings of the same cache key: a binding never reads another binding\'s (or the shared) cached answer, nor fills the shared cache',async t=>{
 let n=0;
 const {h,sent}=setup(t,{route:()=>jsonResponse({n:++n})});
 const api=h.JE.core.api;
 const a={session:api.session(),current:()=>true};
 assert.equal((await api.plugin('/tmdb/x',{cacheKey:'k'})).n,1,'an unbound read fills the shared cache');
 assert.equal((await api.plugin('/tmdb/x',{cacheKey:'k',bound:a})).n,2,'a binding reads for itself');
 assert.equal((await api.plugin('/tmdb/x',{cacheKey:'k',bound:a})).n,2,'and keeps its own answer');
 assert.equal((await api.plugin('/tmdb/x',{cacheKey:'k',bound:{session:api.session(),current:()=>true}})).n,3,'another binding reads for itself');
 assert.equal((await api.plugin('/tmdb/x',{cacheKey:'k'})).n,1,'the shared cache still holds the unbound answer');
 assert.equal(sent.length,3);
});

test('control: one binding asking twice for the same URL shares its own in-flight request',async t=>{
 const {h,sent}=setup(t,{route:()=>jsonResponse({ok:true})});
 const release=holdPool(h);
 const binding={session:h.JE.core.api.session(),current:()=>true};
 const one=outcome(h.JE.core.api.plugin('/acquire/hub',{bound:binding}));
 const two=outcome(h.JE.core.api.plugin('/acquire/hub',{bound:binding}));
 await release();
 assert.equal((await one).v?.ok,true);assert.equal((await two).v?.ok,true);
 assert.equal(sent.length,1);
});

test('a caller\'s abort cancels only its own binding\'s request',async t=>{
 const {h,sent}=setup(t,{route:()=>jsonResponse({ok:true})});
 const release=holdPool(h);
 const controller=new h.window.AbortController();
 const one=outcome(h.JE.core.api.plugin('/acquire/hub',{signal:controller.signal,bound:{session:h.JE.core.api.session(),current:()=>true}}));
 const two=outcome(h.JE.core.api.plugin('/acquire/hub',{bound:{session:h.JE.core.api.session(),current:()=>true}}));
 controller.abort();
 await release();
 assert.equal((await one).e?.name,'AbortError');
 assert.equal((await two).v?.ok,true);
 assert.equal(sent.length,1);
});
