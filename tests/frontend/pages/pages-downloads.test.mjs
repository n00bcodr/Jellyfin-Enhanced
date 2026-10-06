import test from 'node:test';
import assert from 'node:assert/strict';
import {createHarness,deferred,plain} from '../helpers/harness.mjs';
function setup(t,{api=async()=>({}),ajax=async()=>({results:[]}),config={},html='',globals={}}={}){
  let epoch=0,changed;const notices=[],calls=[];
  const h=createHarness({html,globals,JE:{pluginConfig:{JellyseerrEnabled:true,DownloadsPageShowIssues:true,DownloadsShowHistory:true,...config},helpers:{},t:key=>key,toast:message=>notices.push(message),session:{getEpoch:()=>epoch,isCurrent:value=>value===epoch,onUserChange:(_key,fn)=>{changed=fn;}},core:{api:{plugin:async(...args)=>{calls.push(args);return api(...args);}}}},apiClient:{ajax,getUrl:(path,params)=>'http://jellyfin.test'+path+(params?'?'+new URLSearchParams(params):'')}});
  t.after(()=>h.close());h.load('arr/requests/requests-page-data.js');const P=h.JE.internals.requestsPage;const rendered=[];P.renderPage=()=>rendered.push(P.state.isLoading);
  return {...h,P,notices,calls,rendered,switchUser:()=>{epoch++;changed();}};
}
// Pages hold whole grid rows: with three live columns that is four rows of 12 cards.
const grids='<div class="je-requests-grid"></div><div class="je-issues-grid"></div><div class="je-history-grid"></div>';
test('downloads page loads queue, whole-row requests/issues/history pages while exposing loading lifecycle',async t=>{
  let columns='1fr 1fr 1fr';const ajaxUrls=[];
  const h=setup(t,{html:grids,globals:{getComputedStyle:()=>({gridTemplateColumns:columns})},ajax:async options=>{ajaxUrls.push(new URL(options.url));return {results:[]};},
    api:async path=>path==='/arr/queue'?{items:[{id:'download'}]}:path.startsWith('/arr/requests')?{requests:[{id:'request'}],totalPages:4,canApproveRequests:true}:{items:[{id:'history'}],visible:true,totalPages:3}});
  const page=(prefix,from=0)=>new URL(h.calls.slice(from).find(([p])=>p.startsWith(prefix))[0],'http://test').searchParams;
  Object.assign(h.P.state,{requestsPageSize:12,issuesPageSize:12,historyPageSize:12,requestsPage:2,requestsFilter:'pending',issuesPage:3,historyPage:3});
  await h.P.loadAllData();assert.deepEqual(h.rendered,[true,false]);assert.equal(h.P.state.downloads[0].id,'download');assert.equal(h.P.state.requests[0].id,'request');assert.equal(h.P.state.history[0].id,'history');assert.equal(h.P.state.canApproveRequests,true);
  assert.deepEqual([page('/arr/requests').get('skip'),page('/arr/requests').get('take'),page('/arr/requests').get('filter')],['12','12','pending']);
  assert.deepEqual([ajaxUrls[0].searchParams.get('skip'),ajaxUrls[0].searchParams.get('take')],['24','12']);
  assert.deepEqual([page('/arr/history').get('skip'),page('/arr/history').get('take')],['24','12']);
  // A column-count change re-sizes the page and returns to page 1; at 13 columns History drops to three rows under its 48-card cap.
  columns=Array(13).fill('1fr').join(' ');const before=h.calls.length;await h.P.loadAllData();
  assert.deepEqual([page('/arr/requests',before).get('skip'),page('/arr/requests',before).get('take'),h.P.state.requestsPage],['0','52',1]);
  assert.deepEqual([ajaxUrls[1].searchParams.get('skip'),ajaxUrls[1].searchParams.get('take'),h.P.state.issuesPage],['0','52',1]);
  assert.deepEqual([page('/arr/history',before).get('skip'),page('/arr/history',before).get('take'),h.P.state.historyPage],['0','39',1]);
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
