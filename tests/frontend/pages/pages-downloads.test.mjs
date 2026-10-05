import test from 'node:test';
import assert from 'node:assert/strict';
import {createHarness,deferred,plain} from '../helpers/harness.mjs';
function setup(t,{api=async()=>({}),ajax=async()=>({results:[]}),config={}}={}){
  let epoch=0,changed;const notices=[],calls=[];
  const h=createHarness({JE:{pluginConfig:{JellyseerrEnabled:true,DownloadsPageShowIssues:true,DownloadsShowHistory:true,...config},helpers:{},t:key=>key,toast:message=>notices.push(message),session:{getEpoch:()=>epoch,isCurrent:value=>value===epoch,onUserChange:(_key,fn)=>{changed=fn;}},core:{api:{plugin:async(...args)=>{calls.push(args);return api(...args);}}}},apiClient:{ajax,getUrl:(path,params)=>'http://jellyfin.test'+path+(params?'?'+new URLSearchParams(params):'')}});
  t.after(()=>h.close());h.load('arr/requests/requests-page-data.js');const P=h.JE.internals.requestsPage;const rendered=[];P.renderPage=()=>rendered.push(P.state.isLoading);
  return {...h,P,notices,calls,rendered,switchUser:()=>{epoch++;changed();}};
}
test('downloads page loads queue, paginated requests/history and issues while exposing loading lifecycle',async t=>{
  const h=setup(t,{api:async path=>path==='/arr/queue'?{items:[{id:'download'}]}:path.startsWith('/arr/requests')?{requests:[{id:'request'}],totalPages:4,canApproveRequests:true}:{items:[{id:'history'}],visible:true,totalPages:3}});
  h.P.state.requestsPage=2;h.P.state.requestsFilter='pending';h.P.state.historyPage=3;
  await h.P.loadAllData();assert.deepEqual(h.rendered,[true,false]);assert.equal(h.P.state.downloads[0].id,'download');assert.equal(h.P.state.requests[0].id,'request');assert.equal(h.P.state.history[0].id,'history');assert.equal(h.P.state.canApproveRequests,true);
  const request=new URL(h.calls.find(([p])=>p.startsWith('/arr/requests'))[0],'http://test');assert.equal(request.searchParams.get('skip'),'20');assert.equal(request.searchParams.get('filter'),'pending');
  const history=new URL(h.calls.find(([p])=>p.startsWith('/arr/history'))[0],'http://test');assert.equal(history.searchParams.get('skip'),'40');
});
test('downloads pending queue, request and history responses cannot restore previous account data or permissions',async t=>{
  const pending=deferred();const h=setup(t,{api:()=>pending.promise,config:{DownloadsPageShowIssues:false}});
  const run=h.P.loadAllData();h.switchUser();pending.resolve({items:[{id:'old'}],requests:[{id:'old'}],canApproveRequests:true});await run;
  assert.equal(h.P.state.downloads.length,0);assert.equal(h.P.state.requests.length,0);assert.equal(h.P.state.history.length,0);assert.equal(h.P.state.canApproveRequests,false);
});
test('downloads issue permission denial is sticky for current user and resets on account switch',async t=>{
  let count=0;const h=setup(t,{ajax:async()=>{count++;throw {status:403};}});h.expectConsoleError('Requests Page: Failed to fetch issues:');
  await h.P.fetchIssues();await h.P.fetchIssues();assert.equal(count,1);assert.equal(h.notices.length,1);assert.equal(h.P.state.issuesPermissionDenied,true);
  h.switchUser();await h.P.fetchIssues();assert.equal(count,2);assert.equal(h.notices.length,2);
});
test('downloads stale issue denial does not deny the new account',async t=>{
  const pending=deferred();const h=setup(t,{ajax:()=>pending.promise});h.expectConsoleError('Requests Page: Failed to fetch issues:');
  const run=h.P.fetchIssues();h.switchUser();pending.reject({status:403});await run;assert.equal(h.P.state.issuesPermissionDenied,false);assert.equal(h.notices.length,0);
});
test('downloads issues hydrate alternate metadata shapes and reuse cache only within account',async t=>{
  const calls=[];const h=setup(t,{ajax:async options=>{calls.push(options);return options.url.includes('/issue')?{results:[{id:1,media:{mediaType:'tv',tmdbId:42}}],pageInfo:{pages:2}}:{id:42,name:'Series',poster_path:'/poster.jpg',first_air_date:'2020-01-01'};}});
  await h.P.fetchIssues();await h.P.fetchIssues();assert.equal(calls.length,3);
  assert.equal(h.P.state.issues[0].media.title,'Series');assert.equal(h.P.state.issues[0].media.posterPath,'/poster.jpg');assert.equal(h.P.state.issuesTotalPages,2);
  assert.equal(calls[0].headers['X-Jellyfin-User-Id'],'user-a');
  h.switchUser();await h.P.fetchIssues();assert.equal(calls.length,5);
});
test('downloads disabled optional sources clear stale state without network',async t=>{
  const h=setup(t,{config:{DownloadsShowHistory:false,DownloadsPageShowIssues:false}});h.P.state.history=[{}];h.P.state.issues=[{}];await h.P.fetchHistory();await h.P.fetchIssues();
  assert.equal(h.P.state.history.length,0);assert.equal(h.P.state.historyVisible,false);assert.equal(h.P.state.issues.length,0);assert.equal(h.calls.length,0);
});
test('downloads approval uses a single non-retried mutation then refreshes permission and data',async t=>{
  const h=setup(t,{api:async()=>({requests:[],canApproveRequests:false})});h.document.body.innerHTML='<button data-request-id="17"><span class="material-icons">check</span></button>';
  await h.P.handleRequestAction(h.document.querySelector('button'),'approve');assert.equal(h.calls[0][0],'/arr/requests/17/approve');assert.deepEqual(plain(h.calls[0][1]),{method:'POST',skipRetry:true});assert.equal(h.calls.length,2);assert.equal(h.P.state.canApproveRequests,false);
});
