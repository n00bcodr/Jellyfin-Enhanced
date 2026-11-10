import test from 'node:test';
import assert from 'node:assert/strict';
import {createHarness,deferred} from '../helpers/harness.mjs';
const files=['styles','data','render-helpers','render-cards','render','actions','init'];
function setup(t,{api=async p=>p==='/arr/queue'?{items:[]}:{requests:[],items:[]},ajax=async()=>({results:[]}),render=true,realCore=false,realHelpers=false}={}){
 let epoch=0;const resets=new Map(),calls=[],resources=[];
 const h=createHarness({html:'<div id="je-downloads-container"></div>',JE:{internals:{},pluginConfig:{JellyseerrEnabled:true,DownloadsShowHistory:true,DownloadsPageShowIssues:true,DownloadsPageEnabled:true},t:()=>'',escapeHtml:s=>String(s??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;'),cdn:{selfhst:()=>''},toast:()=>{},session:{getEpoch:()=>epoch,isCurrent:e=>e===epoch,onUserChange:(k,f)=>{resets.set(k,f);return ()=>resets.delete(k);}},helpers:{clearAvatarObjectUrlCache(){},hydrateAvatarImages(){},isAdmin:()=>false,onSidebarRebuilt(){},onNavigate:()=>()=>{}},core:{api:{plugin:async(...args)=>{calls.push(args);return api(...args);}},ui:{injectCss(){},skeletonGridHtml:()=>'',isTvLayout:()=>false},lifecycle:{register:()=>({track:r=>{resources.push(r);return r;},untrack(){}})}}},apiClient:{ajax,getUrl:p=>p,serverAddress:()=> 'http://server'}});
 t.after(()=>h.close());if(realCore){delete h.JE.session;delete h.JE.core.api;h.load('core/session.js');h.load('core/api-client.js');}if(realHelpers){delete h.JE.helpers;delete h.JE.core.lifecycle;for(const f of ['navigation','lifecycle','dom-observer'])h.load('core/'+f+'.js');h.load('enhanced/helpers.js');}for(const f of render?files:['data']){const path='arr/requests/requests-page-'+f+'.js';h.load(path);}
 const P=h.JE.internals.requestsPage;if(!render)P.renderPage=()=>{};
 return {...h,P,calls,resources,change(){epoch++;resets.forEach(fn=>fn());}};
}
// Exercise the emitted cards and real session/API boundary.
for (const suffix of ['', '/', '/proxy', '/proxy/']) test('service links retain a single separator and proxy prefix: '+suffix,async t=>{
 const h=setup(t,{api:async()=>({movies:{42:{matches:[{instanceUrl:'https://radarr.example'+suffix,urlMappings:'',titleSlug:''}]}},series:{7:{matches:[{instanceUrl:'https://sonarr.example'+suffix,urlMappings:'',titleSlug:'series'}]}}})});
 h.JE.jellyseerrAPI={resolveJellyseerrBaseUrl:()=> 'https://seerr.example'+suffix};
 h.JE.pluginConfig.ArrLinksEnabled=true;h.JE.helpers.isAdmin=()=>true;
 h.P.state.requests=[{id:1,tmdbId:42,type:'movie'},{id:2,tmdbId:43,tvdbId:7,type:'tv'}];h.P.renderPage();
 await new Promise(resolve=>setImmediate(resolve));
 const urls=[...h.document.querySelectorAll('.je-request-external-link')].map(a=>a.href);
 assert.ok(urls.includes('https://seerr.example'+suffix.replace(/\/$/,'')+'/movie/42'));
 assert.ok(urls.includes('https://radarr.example'+suffix.replace(/\/$/,'')+'/movie/42'));
 assert.ok(urls.includes('https://sonarr.example'+suffix.replace(/\/$/,'')+'/series/series'));
});
for(const switchKind of ['user','server','token','client'])test('DL-R1-002 silent '+switchKind+' replacement rejects old card mutation (real session/API)',async t=>{
 const h=setup(t,{realCore:true});
 const sent=[];
 h.window.fetch=async(url,options)=>{sent.push({url,method:options.method,user:options.headers['X-Jellyfin-User-Id']});return new Response(JSON.stringify(options.method==='POST'?{success:true}:{requests:[{id:5,requestStatus:1,title:'Old server request'}],canApproveRequests:true}),{status:200});};
 await h.P.fetchRequests();h.P.renderPage();
 const btn=h.document.querySelector('.je-request-approve-btn');assert.ok(btn);
 if(switchKind==='user')h.window.ApiClient.getCurrentUserId=()=> 'user-b';
 else if(switchKind==='token')h.window.ApiClient.accessToken=()=> 'different-token';
 else if(switchKind==='client')h.window.ApiClient={...h.window.ApiClient};
 else {h.window.ApiClient.serverId=()=> 'server-b';h.window.ApiClient.serverAddress=()=> 'http://other-server';h.window.ApiClient.getUrl=p=>'http://other-server'+p;}
 await h.P.handleRequestAction(btn,'approve');
 assert.equal(sent.filter(c=>c.method==='POST').length,0);
});
test('DL-R1-003 empty refreshed selection rejects stale visible approval while another lane waits',async t=>{
 const queue=deferred();
 const h=setup(t,{api:async(p,o)=>p==='/arr/queue'?queue.promise:o?.method==='POST'?{success:true}:{requests:[],items:[],canApproveRequests:false}});
 h.P.state.requests=[{id:5,requestStatus:1,title:'Previously pending'}];h.P.state.canApproveRequests=true;h.P.renderPage();
 const loading=h.P.loadAllData();await new Promise(resolve=>setImmediate(resolve));
 assert.equal(h.P.state.requests.length,0);assert.equal(h.P.state.canApproveRequests,false);
 const stale=h.document.querySelector('.je-request-approve-btn');assert.ok(stale?.isConnected);
 await h.P.handleRequestAction(stale,'approve');
 assert.equal(h.calls.filter(([,o])=>o?.method==='POST').length,0);
 queue.resolve({items:[]});await loading;
});
// Opening the page in-app (Jellyfin's router pushes the route, or Back pops it) must not cancel the load it starts.
test('in-app navigation to the page renders the loaded queue instead of loading placeholders',async t=>{
 const queue={items:[{id:'9001',source:'Sonarr',instanceName:'Sonarr',title:'Mock Signals',subtitle:'S01E02 - Episode 2',tvdbId:90101,seasonNumber:1,episodeNumber:2,status:'downloading',progress:75,totalSize:4294967296,sizeRemaining:1073741824,timeRemaining:'00:12:00'}],errors:[]};
 const h=setup(t,{realHelpers:true,api:async p=>p==='/arr/queue'?queue:p.startsWith('/arr/history')?{items:[],totalPages:0,visible:true}:{requests:[],totalPages:1,canApproveRequests:false}});
 h.JE.core.ui.skeletonGridHtml=n=>'<div class="je-skeleton-block"></div>'.repeat(n);
 h.document.getElementById('je-downloads-container').remove();
 h.document.body.insertAdjacentHTML('beforeend','<div class="mainAnimatedPages"><div id="indexPage" class="page mainAnimatedPage"></div></div>');
 h.window.history.replaceState({},'','#/home');h.JE.initializeDownloadsPage();
 const settled=async()=>{for(let i=0;i<5;i++)await new Promise(resolve=>setImmediate(resolve));};
 const shown=()=>{const page=h.document.getElementById('je-downloads-page');return {hidden:page.classList.contains('hide'),placeholders:page.querySelectorAll('.je-skeleton-block').length,cards:page.querySelectorAll('.je-download-card').length};};
 h.window.history.pushState({},'','#/downloads');await settled();
 assert.deepEqual(shown(),{hidden:false,placeholders:0,cards:1});
 h.window.history.pushState({},'','#/home');await settled();
 h.window.history.back();
 for(let i=0;i<100 && h.window.location.hash!=='#/downloads';i++)await new Promise(resolve=>setTimeout(resolve,10));
 await settled();assert.equal(h.window.location.hash,'#/downloads');
 assert.deepEqual(shown(),{hidden:false,placeholders:0,cards:1});
});
