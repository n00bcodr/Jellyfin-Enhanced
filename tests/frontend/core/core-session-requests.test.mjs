import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import {join} from 'node:path';
import {parse} from '@babel/parser';
import {createHarness, deferred, jsonResponse, jsRoot} from '../helpers/harness.mjs';
const tick=()=>new Promise(r=>setImmediate(r));
function setup(t, fetch) {
 let user='a', token='token-a',server='one';
 const h=createHarness({fetch,apiClient:{getCurrentUserId:()=>user,accessToken:()=>token,serverId:()=>server,
 setAuthenticationInfo(nextToken,nextUser){token=nextToken;user=nextUser;}}});
 t.after(()=>h.close());
 for(const m of ['navigation','session','api-client'])h.load('core/'+m+'.js');
 return {...h,get NATIVE(){return h.NATIVE;},switchUser(mode='both'){
  if(mode==='server'){server='two';return;}
  if(mode==='token'){token='replacement-token';return;}
  if(mode==='epoch'){server='two';h.JE.session.checkNow('test');return;}
  if(mode==='identity'){user='b';token='token-b';return;}
  h.window.ApiClient.setAuthenticationInfo('token-b','b');
 }};
}
for(const method of ['GET','POST','PUT','DELETE','PATCH']) for(const mode of ['both','identity','epoch','server','token','same'])
test(`released ${method} retains submitting identity (${mode})`,async t=>{
 const sent=[];const h=setup(t,async(u,o)=>{sent.push(o);return jsonResponse({ok:true});});
 const gates=Array.from({length:4},deferred);
 const busy=gates.map(g=>h.JE.core.api.manager.withConcurrencyLimit(()=>g.promise));
 const signal=new h.window.AbortController().signal;
 const remove=signal.removeEventListener.bind(signal);
 signal.removeEventListener=(...a)=>{remove(...a);if(mode!=='same')h.switchUser(mode);};
 const pending=h.JE.core.api.plugin('/queued',{method,signal});
 const outcome=pending.then(v=>({v}),e=>({e}));
 gates[0].resolve();await busy[0];const result=await outcome;
 gates.slice(1).forEach(g=>g.resolve());await Promise.all(busy);
 if(mode==='same'){assert.equal(result.v.ok,true);assert.equal(sent.length,1);assert.equal(sent[0].headers['X-Emby-Token'],'token-a');}
 else {assert.equal(result.e?.name,'AbortError');assert.equal(sent.length,0,'released work is never sent under incoming credentials');}
});
for(const method of ['GET','POST'])test(`queued ${method} cancels on session switch`,async t=>{
 let calls=0;const h=setup(t,async()=>{calls++;return jsonResponse({});});
 const gates=Array.from({length:4},deferred),busy=gates.map(g=>h.JE.core.api.manager.withConcurrencyLimit(()=>g.promise));
 const pending=h.JE.core.api.plugin('/queued',{method});const rejected=assert.rejects(pending,{name:'AbortError'});
 h.switchUser();await rejected;gates.forEach(g=>g.resolve());await Promise.all(busy);assert.equal(calls,0);
});
for(const method of ['GET','POST','DELETE'])for(const mode of ['both','server','token'])test(`in-flight ${method} cannot retry after a ${mode} switch`,async t=>{
 const first=deferred(),sent=[];const h=setup(t,(u,o)=>{sent.push(o);return sent.length===1?first.promise:Promise.resolve(jsonResponse({}));});
 h.JE.core.api.manager.CONFIG.retry.baseDelayMs=1;
 const pending=h.JE.core.api.plugin('/retry',{method});const outcome=pending.then(v=>({v}),e=>({e}));
 h.switchUser(mode);first.resolve(jsonResponse({},503));const result=await outcome;
 assert.equal(sent.length,1,'only the original A request reaches transport');
 // A read is aborted; a sent write keeps what happened to it (D46S2-R12-4): sent, answered 503, never "unsent".
 if(method==='GET')assert.equal(result.e?.name,'AbortError');
 else {assert.equal(result.e?.status,503);assert.equal(result.e?.jeSent,true);assert.deepEqual({...h.JE.core.api.writeOutcome(result.e)},{outcome:'failed',sent:true});}
});
/** Finds raw mutating calls, treating dynamic methods/options as potential writes. */
function nonCoreWrites(source,file) {
 const found=[],localReads=[];
 const path=node=>node?.type==='Identifier'?node.name:
  ['MemberExpression','OptionalMemberExpression'].includes(node?.type)?path(node.object)+'.'+(node.computed?node.property.value:node.property.name):'';
 const walk=node=>{
  if(!node||typeof node!=='object')return;
  if(['CallExpression','OptionalCallExpression'].includes(node.type)) {
   if(node.callee?.object?.type==='ThisExpression'&&node.callee?.property?.name==='fetchWithRetry')localReads.push(node.arguments[1]);
   const name=path(node.callee),ajax=['ApiClient.ajax','window.ApiClient.ajax'].includes(name);
   if(ajax||['fetch','window.fetch'].includes(name)) {
    const opts=node.arguments[ajax?0:1];
    if(opts) {
     const props=opts.type==='ObjectExpression'?opts.properties:null;
     const method=props?.find(p=>(p.key?.name||p.key?.value)===(ajax?'type':'method'))?.value;
     const value=method?.type==='StringLiteral'?method.value.toUpperCase():null;
     const maybeWrite=!props||method&&!['GET','HEAD'].includes(value)||props.some(p=>p.type==='SpreadElement');
     const url=ajax?props?.find(p=>(p.key?.name||p.key?.value)==='url')?.value:node.arguments[0];
     const route=url?source.slice(url.start,url.end):'';
     // POST is read-only on these explicit existing batch/poll contracts.
     const readOnly=value==='POST'&&(file==='arr/live/arr-live.js'&&route==='ApiClient.getUrl(ROUTE)'&&source.includes("const ROUTE = '/JellyfinEnhanced/acquire/changes'")
      || ['tags/tag-pipeline.js','enhanced/itemdetails/features-details-media-info.js'].includes(file)&&route.includes('/JellyfinEnhanced/tag-data/'));
     if(maybeWrite&&!readOnly)found.push(file+':'+source.slice(node.start,node.end).slice(0,80));
    }
   }
  }
  for(const value of Object.values(node))if(value&&typeof value==='object')Array.isArray(value)?value.forEach(walk):walk(value);
 };
 walk(parse(source,{sourceType:'script'}));
 // The pause screen's only retry helper reads item metadata; audit every local caller as GET.
 const readOnlyLocal=file==='enhanced/player/pausescreen.js'&&localReads.length>0&&localReads.every(o=>o?.type==='ObjectExpression'&&o.properties.every(p=>p.type!=='SpreadElement'&&(!['method','type'].includes(p.key?.name||p.key?.value)||p.value?.type==='StringLiteral'&&['GET','HEAD'].includes(p.value.value.toUpperCase()))));
 return readOnlyLocal?found.filter(s=>!s.includes('fetch(url, options)')):found;
}
test('JE write helpers all enter the core transport',()=>{
 const walk=d=>readdirSync(d,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(join(d,e.name)):e.name.endsWith('.js')?[join(d,e.name)]:[]);
 // A dynamic mutation must not hide from the audit merely because its verb is not a literal.
 assert.equal(nonCoreWrites("ApiClient.ajax({type:hidden?'PUT':'DELETE',url:'/rule'})",'probe.js').length,1);
 assert.equal(nonCoreWrites("window.fetch('/rule',opts)",'probe.js').length,1);
 // Play edge only (Q-PLAYD51-3): modules from tracks merged beside D46 that the integration rebuild binds to the
 // core transport ("session-bound client modules" rule). Exactly these files; anything new still fails.
 // 4c2's list import transport (own fetch, bound per operation to its session like list-api.js) joins them.
 const pendingRebuild=['arr/adminusers/admin-users-api.js','arr/lists/list-api.js','arr/lists/list-grid.js','arr/lists/list-import.js'];
 const bypass=walk(jsRoot).filter(f=>!f.endsWith('/core/api-client.js')).flatMap(f=>nonCoreWrites(readFileSync(f,'utf8'),f.slice(jsRoot.length+1)));
 assert.deepEqual(bypass.filter(s=>!pendingRebuild.includes(s.split(':')[0])),[]);
 assert.deepEqual([...new Set(bypass.map(s=>s.split(':')[0]))].sort(),pendingRebuild,'drop an entry once the rebuild binds it');
 const readers=walk(jsRoot).filter(f=>!f.endsWith('/core/api-client.js')).filter(f=>/JE\.requestManager\.(?:fetchWithRetry|deduplicatedFetch|withConcurrencyLimit)\(/.test(readFileSync(f,'utf8')));
 assert.deepEqual(readers,[],'legacy reader transports must use core fetch for body/publication binding');
});
test('the settings saver retains its unavailable-ApiClient failure contract',async t=>{
 const h=createHarness();t.after(()=>h.close());h.load('core/mutation-queue.js');h.load('enhanced/config.js');h.window.ApiClient=undefined;
 h.expectConsoleError(/ApiClient not available/);
 await h.JE.saveUserSettings('settings.json',{});
 await assert.rejects(h.JE.saveUserSettings('settings.json',{}, {throwOnError:true}),/ApiClient not available/);
});
for(const status of [200,201,400,409,503])test(`status-preserving plugin requests keep HTTP ${status} without retry`,async t=>{
 let calls=0;const h=setup(t,async()=>{calls++;return jsonResponse({outcome:'honest'},status);});
 const answer=await h.JE.core.api.pluginResponse('/acquire/requests',{method:'POST',body:{key:'movie:tmdb:42'}});
 assert.equal(answer.status,status);assert.equal(answer.body.outcome,'honest');assert.equal(calls,1);
});
test('status-preserving requests tolerate empty and malformed HTTP bodies',async t=>{
 let response=new Response(null,{status:204});const h=setup(t,async()=>response);
 assert.equal((await h.JE.core.api.pluginResponse('/acquire/requests')).body,null);
 response=new Response('not JSON',{status:502});const answer=await h.JE.core.api.pluginResponse('/acquire/requests');
 assert.equal(answer.status,502);assert.equal(answer.body,null);
});
test('status-preserving writes use the same released-slot session fence',async t=>{
 let calls=0;const h=setup(t,async()=>{calls++;return jsonResponse({});});
 const gates=Array.from({length:4},deferred),busy=gates.map(g=>h.JE.core.api.manager.withConcurrencyLimit(()=>g.promise));
 const signal=new h.window.AbortController().signal,remove=signal.removeEventListener.bind(signal);
 signal.removeEventListener=(...a)=>{remove(...a);h.switchUser();};
 const pending=h.JE.core.api.pluginResponse('/acquire/requests',{method:'POST',signal});
 const rejected=assert.rejects(pending,{name:'AbortError'});gates[0].resolve();await rejected;
 gates.slice(1).forEach(g=>g.resolve());await Promise.all(busy);assert.equal(calls,0);
});

for(const method of ['GET','POST']) for(const mode of ['identity','epoch','server','token'])
test(`late ${method} response rejects changed submission ${mode}`,async t=>{
 const response=deferred();const h=setup(t,()=>response.promise);
 const pending=h.JE.core.api.plugin('/late',{method,skipRetry:true,cacheKey:'late'});const outcome=pending.then(value=>({value}),error=>({error}));
 h.switchUser(mode);response.resolve(jsonResponse({owner:'a'}));
 assert.equal((await outcome).error?.name,'AbortError');assert.equal(h.JE.core.api.manager.getCached('late'),null);
});
for(const responseMode of ['json','status']) for(const mode of ['identity','epoch','server','token','same'])
test(`${responseMode} body publication retains submission ${mode}`,async t=>{
 const body=deferred(),started=deferred();const h=setup(t,async()=>({ok:true,status:200,text(){started.resolve();return body.promise;}}));
 const pending=h.JE.core.api.plugin('/body',{method:responseMode==='status'?'POST':'GET',responseMode,skipRetry:true});const outcome=pending.then(value=>({value}),error=>({error}));
 await started.promise;if(mode!=='same')h.switchUser(mode);body.resolve('{"owner":"a"}');
 const result=await outcome;if(mode==='same')assert.equal((responseMode==='status'?result.value.body:result.value).owner,'a');else assert.equal(result.error?.name,'AbortError');
});
for(const responseMode of ['json','status'])
test(`${responseMode} publication after timeout cleanup rejects the outgoing session`,async t=>{
 const h=setup(t,async()=>jsonResponse({owner:'a'}));const signal=new h.window.AbortController().signal;
 const remove=signal.removeEventListener.bind(signal);signal.removeEventListener=(...args)=>{remove(...args);h.switchUser();};
 const outcome=h.JE.core.api.plugin('/publication',{responseMode,method:'POST',signal,timeoutMs:1000}).then(value=>({value}),error=>({error}));
 assert.equal((await outcome).error?.name,'AbortError');
});

for(const mode of ['identity','server','token'])test(`unobserved ${mode} transition cannot reuse outgoing cache or in-flight work`,async t=>{
 let n=0;const h=setup(t,async()=>jsonResponse({call:++n}));
 assert.equal((await h.JE.core.api.plugin('/private',{cacheKey:'private'})).call,1);
 h.switchUser(mode);assert.equal((await h.JE.core.api.plugin('/private',{cacheKey:'private'})).call,2);
});
for(const responseMode of ['json','status'])test(`${responseMode} rejected body of a sent write under a stale session stays sent (no answer)`,async t=>{
 const body=deferred(),started=deferred();const h=setup(t,async()=>({ok:true,status:200,text(){started.resolve();return body.promise;}}));
 const outcome=h.JE.core.api.plugin('/body-error',{responseMode,method:'POST',skipRetry:true}).then(value=>({value}),error=>({error}));
 await started.promise;h.switchUser();body.reject(new TypeError('Failed to fetch'));
 // A sent write whose answer was lost: sent, with no answer (never "unsent", never a fresh AbortError: D46S2-R12-4).
 const {error}=await outcome;assert.equal(error?.jeSent,true);assert.deepEqual({...h.JE.core.api.writeOutcome(error)},{outcome:'failed',sent:true});
});
test('public authHeaders keeps its no-argument contract for the read-only change feed',t=>{
 const h=setup(t,async()=>jsonResponse({}));assert.equal(h.JE.core.api.authHeaders()['X-Emby-Token'],'token-a');
});
function legacyReader(h,kind) {
 h.JE.requestManager=h.JE.core.api.manager;
 if(kind==='discovery'){h.load('jellyseerr/discovery/discovery-filter-utils.js');return ()=>h.JE.discoveryFilter.fetchWithManagedRequest('/JellyfinEnhanced/jellyseerr/discover/tv','discovery');}
 h.JE.seerrStatus={MEDIA:{}};h.load('jellyseerr/moreinfo/more-info-modal-data.js');return ()=>h.JE.internals.moreInfoModal.fetchRatings(42,'tv');
}
for(const kind of ['discovery','ratings']) for(const mode of ['identity','server','token']) {
 test(`${kind} reader binds the identity before its queue slot (${mode})`,async t=>{
  const sent=[];const h=setup(t,async(u,o)=>{sent.push(o);return jsonResponse({score:99});});const read=legacyReader(h,kind);
  const gates=Array.from({length:4},deferred),busy=gates.map(g=>h.JE.core.api.manager.withConcurrencyLimit(()=>g.promise));
  const outcome=read().then(value=>({value}),error=>({error}));await tick();assert.equal(sent.length,0,'the reader uses the shared queue');
  h.switchUser(mode);gates.forEach(g=>g.resolve());await Promise.all(busy);const result=await outcome;
  if(kind==='ratings')assert.equal(result.value,null);else assert.equal(result.error?.name,'AbortError');assert.equal(sent.length,0);
 });
 test(`${kind} reader discards a body after changing ${mode}`,async t=>{
  const body=deferred(),started=deferred();const h=setup(t,async()=>({ok:true,status:200,json(){started.resolve();return body.promise;},async text(){started.resolve();return JSON.stringify(await body.promise);}}));const read=legacyReader(h,kind);
  const outcome=read().then(value=>({value}),error=>({error}));await started.promise;h.switchUser(mode);body.resolve({score:99});const result=await outcome;
  if(kind==='ratings')assert.equal(result.value,null);else assert.equal(result.error?.name,'AbortError');
 });
}
for(const kind of ['discovery','ratings'])test(`${kind} reader still publishes the same session body`,async t=>{
 const h=setup(t,async()=>jsonResponse({score:99}));const result=await legacyReader(h,kind)();assert.equal((kind==='ratings'?result.rt:result).score,99);
});
