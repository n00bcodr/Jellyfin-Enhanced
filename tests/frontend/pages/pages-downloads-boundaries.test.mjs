import test from 'node:test';
import assert from 'node:assert/strict';
import {createHarness,deferred} from '../helpers/harness.mjs';
const files=['styles','data','render-helpers','render-cards','render','actions','init'];
function setup(t,{api=async p=>p==='/arr/queue'?{items:[]}:{requests:[],items:[]},ajax=async()=>({results:[]}),render=true}={}){
 let epoch=0;const resets=new Map(),calls=[],resources=[];
 const h=createHarness({html:'<div id="je-downloads-container"></div>',JE:{internals:{},pluginConfig:{JellyseerrEnabled:true,DownloadsShowHistory:true,DownloadsPageShowIssues:true,DownloadsPageEnabled:true},t:()=>'',escapeHtml:s=>String(s??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;'),cdn:{selfhst:()=>''},toast:()=>{},session:{getEpoch:()=>epoch,isCurrent:e=>e===epoch,onUserChange:(k,f)=>{resets.set(k,f);return ()=>resets.delete(k);}},helpers:{clearAvatarObjectUrlCache(){},hydrateAvatarImages(){},isAdmin:()=>false,onSidebarRebuilt(){},onNavigate:()=>()=>{}},core:{api:{plugin:async(...args)=>{calls.push(args);return api(...args);}},ui:{injectCss(){},skeletonGridHtml:()=>'',isTvLayout:()=>false},lifecycle:{register:()=>({track:r=>{resources.push(r);return r;},untrack(){}})}}},apiClient:{ajax,getUrl:p=>p,serverAddress:()=> 'http://server'}});
 t.after(()=>h.close());for(const f of render?files:['data'])h.load('arr/requests/requests-page-'+f+'.js');
 const P=h.JE.internals.requestsPage;if(!render)P.renderPage=()=>{};
 return {...h,P,calls,resources,change(){epoch++;resets.forEach(fn=>fn());}};
}
test('last requests selection owns response even when the previous request finishes later',async t=>{
 const old=deferred(),next=deferred();let n=0;const h=setup(t,{render:false,api:()=>++n===1?old.promise:next.promise});
 const a=h.P.fetchRequests();h.P.state.requestsFilter='pending';const b=h.P.fetchRequests();next.resolve({requests:[{id:2}],canApproveRequests:false});await b;
 old.resolve({requests:[{id:1}],canApproveRequests:true});await a;assert.equal(h.P.state.requests[0].id,2);assert.equal(h.P.state.canApproveRequests,false);
});
test('issue enrichment does not cancel the independent requests lane',async t=>{
 const requests=deferred();const h=setup(t,{render:false,api:()=>requests.promise,ajax:async o=>o.url.includes('/issue')?{results:[{media:{mediaType:'tv',tmdbId:42}},{media:{mediaType:'tv',tmdbId:43}}]}:{title:'Series'}});
 const a=h.P.fetchRequests();await h.P.fetchIssues();requests.resolve({requests:[{id:9}]});await a;assert.equal(h.P.state.requests[0].id,9);assert.equal(h.P.state.issues.length,2);
});
test('navigation invalidates in-flight loads and loading completion render',async t=>{
 const pending=deferred();const h=setup(t,{render:false,api:()=>pending.promise});let renders=0;h.P.renderPage=()=>renders++;
 const run=h.P.loadAllData();h.window.history.replaceState({},'','#/other');h.window.dispatchEvent(new h.window.Event('popstate'));
 pending.resolve({items:[{id:'old'}],requests:[{id:'old'}]});await run;assert.equal(renders,1);assert.equal(h.P.state.downloads.length,0);assert.equal(h.P.state.isLoading,false);
});
test('already-sent approval reconciles success after switch without new-account requests or rendering',async t=>{
 const pending=deferred();const h=setup(t,{render:false,api:(_p,o)=>o?.method==='POST'?pending.promise:Promise.resolve({requests:[{id:5,requestStatus:1}],canApproveRequests:true})});await h.P.fetchRequests();h.calls.length=0;h.document.body.innerHTML='<button data-request-id="5"></button>';const button=h.document.querySelector('button');
 const run=h.P.handleRequestAction(button,'approve');h.change();pending.resolve({});await run;assert.equal(h.calls.length,1);assert.deepEqual([...h.P.runtime.mutations.values()],['succeeded']);
});
for(const [failure,outcome] of [[{status:403},'failed'],[new Error('network interrupted'),'uncertain']])test('approval failure preserves '+outcome+' outcome without automatic retry',async t=>{
 const h=setup(t,{render:false,api:async(_p,o)=>{if(o?.method==='POST')throw failure;return {requests:[{id:5,requestStatus:1}],canApproveRequests:true};}});await h.P.fetchRequests();h.calls.length=0;h.expectConsoleError('Failed to approve');h.document.body.innerHTML='<button data-request-id="5"><span class="material-icons">check</span></button>';const btn=h.document.querySelector('button');
 await h.P.handleRequestAction(btn,'approve');assert.equal(h.calls.length,1);assert.equal(h.calls[0][1].skipRetry,true);assert.equal(btn.disabled,false);assert.deepEqual([...h.P.runtime.mutations.values()],[outcome]);
});
test('detached and hidden buttons and stale selection never send a write',async t=>{
 const h=setup(t,{render:false});const button=h.document.createElement('button');button.dataset.requestId='5';await h.P.handleRequestAction(button,'approve');
 const container=h.document.querySelector('#je-downloads-container');container.append(button);container.className='hide';await h.P.handleRequestAction(button,'approve');container.className='';h.P.state.requests=[{id:6,requestStatus:1}];h.P.state.canApproveRequests=true;await h.P.handleRequestAction(button,'approve');assert.equal(h.calls.length,0);
});
test('malformed queue response surfaces failure, not a successful empty state',async t=>{
 const h=setup(t,{api:async p=>p==='/arr/queue'?{items:[{progress:'bad'}]}:{}});h.expectConsoleError('Failed to fetch downloads');await h.P.loadAllData();assert.equal(h.P.state.downloadsError,true);assert.match(h.document.body.textContent,/Unable to load downloads/);
});
test('history that failed on every instance shows the failure, not "no history"',async t=>{
 const h=setup(t,{api:async p=>p.startsWith('/arr/history')?{items:[],totalPages:0,visible:true,errors:[{instanceName:'Sonarr',source:'Sonarr',reason:'HTTP 500'}]}:p==='/arr/queue'?{items:[]}:{requests:[]}});
 await h.P.loadAllData();assert.equal(h.P.state.historyError,true);assert.match(h.document.querySelector('.je-history-section').textContent,/Unable to load history/);
});
test('queue titles, ETA and search markup cannot create elements; progress remains bounded',t=>{
 const h=setup(t);h.P.state.downloads=[{title:'<img id="attack">',subtitle:'<svg onload="x">',timeRemaining:'<img id="eta">',progress:900,status:'Downloading'}];h.P.state.downloadsSearchVisible=true;h.P.state.downloadsSearchQuery='" autofocus onfocus="x';h.P.renderPage();
 assert.equal(h.document.querySelector('#attack,#eta,[onfocus]'),null);assert.equal(h.document.querySelector('.je-downloads-search-input').value,'" autofocus onfocus="x');
 h.P.state.downloadsSearchQuery='';h.P.renderPage();assert.equal(h.document.querySelector('.je-download-progress-bar').style.width,'100%');
});
test('each generated entry shares one owner and repeated evaluation does not replace state',t=>{
 const h=setup(t);const state=h.P.state,owner=h.P.runtime;state.requests=[{id:5}];for(const file of files)h.load('arr/requests/requests-page-'+file+'.js');assert.equal(h.P.state,state);assert.equal(h.P.runtime,owner);assert.equal(owner.installed.size,7);
});
test('colliding titles with delimiters and different instances do not form a pack',t=>{
 const h=setup(t);const entries=[1,2,3].map(n=>({source:'Sonarr',title:'Series',seasonNumber:1,episodeNumber:n,progress:0,instanceId:n,instanceName:'same name'}));assert.equal(h.P.groupDownloads(entries).every(g=>g.type==='single'),true);
});
test('hiding custom tab prevents pending data and external links from updating the DOM',async t=>{
 const pending=deferred();const h=setup(t,{api:()=>pending.promise});const container=h.document.querySelector('#je-downloads-container');const panel=h.document.createElement('section');panel.className='tabContent is-active';container.replaceWith(panel);panel.append(container);h.P.state._customTabContainer=container;
 const run=h.P.loadAllData();panel.classList.remove('is-active');pending.resolve({items:[{id:9}],requests:[{id:9}]});await run;assert.equal(h.P.state.downloads.length,0);
});

test('disposed feature rejects new refresh and request reads before sending network work',async t=>{
 const h=setup(t,{render:false});h.P.runtime.dispose();await h.P.loadAllData();await h.P.fetchRequests();assert.equal(h.calls.length,0);
});
test('server identity change rejects an in-flight response even before session notification',async t=>{
 const pending=deferred();const h=setup(t,{render:false,api:()=>pending.promise});const run=h.P.fetchRequests();h.window.ApiClient.serverAddress=()=> 'http://other-server';pending.resolve({requests:[{id:'old-server'}],canApproveRequests:true});await run;assert.equal(h.P.state.requests.length,0);assert.equal(h.P.state.canApproveRequests,false);
});
test('each section that failed to load says so from the translations',async t=>{
 const h=setup(t,{api:async p=>{throw new Error('offline '+p);}});h.JE.t=key=>key;
 h.expectConsoleError('Failed to fetch downloads');h.expectConsoleError('Failed to fetch requests');h.expectConsoleError('Failed to fetch history');
 await h.P.loadAllData();
 assert.match(h.document.querySelector('.je-active-downloads-section').textContent,/requests_downloads_load_failed/);
 assert.match(h.document.querySelector('.je-requests-section').textContent,/requests_requests_load_failed/);
 assert.match(h.document.querySelector('.je-history-section').textContent,/requests_history_load_failed/);
});

