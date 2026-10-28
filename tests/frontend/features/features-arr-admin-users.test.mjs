import { clickAsViewer } from '../helpers/harness.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHarness, deferred, jsonResponse } from '../helpers/harness.mjs';
const A='11111111111111111111111111111111', B='22222222222222222222222222222222';
function muiTabs(){return '<div class="MuiTabs-root"><div role="tablist">'+['profile','access','parentalcontrol','password'].map((t,i)=>`<button role="tab" class="MuiTab-root ${i===1?'Mui-selected':''}" aria-selected="${i===1}" tabindex="${i===1?0:-1}" data-native="${t}">${t}</button>`).join('')+'</div><span class="MuiTabs-indicator" style="left:80px;width:80px"></span></div>';}
function legacyTabs(){return '<div class="localnav" data-role="controlgroup">'+['profile','access','parentalcontrol','password'].map(t=>`<a class="emby-button ${t==='access'?'ui-btn-active':''}" href="#/dashboard/users/${t}?userId=${A}">${t}</a>`).join('')+'</div>';}
const tick=()=>new Promise(r=>setTimeout(r,45));
function view(id=A){return {id,name:'<script>bad</script>',disabled:false,revisions:{policy:'p1',display:'d1','pool-membership':'g1','seerr-import':'s1'},policy:{available:true,stored:{role:null,quotaLimit:null,quotaGb:null,fourKInstances:null},effective:{role:'member'},roles:['Member','Kid'],backend:'je'},display:{available:true,stored:{listStatus:null,acquisitionBadges:false},effective:{listStatus:false},gates:{listStatus:false}},pools:{available:true,choices:[{id:'family',name:'Family'}],explicit:null},usage:{available:false,pending:null,quota:null},consents:{available:true,person:id,stored:{autoMovieRequests:false,listSwapIn:true}},notifications:{available:false},seerr:{state:'unavailable',blocked:false},safety:{}};}
function setup(hash,html,read=()=>Promise.resolve(view())){
 let epoch=1, change, nav, mutation;const writes=[];let summaries=0;
 const nativeNav=()=>{const root=h.document.querySelector('#usersEditPage');if(root&&!root.querySelector('[role="tablist"]'))root.querySelector('.content-primary').insertAdjacentHTML('afterbegin',muiTabs());};
 const h=createHarness({url:'http://jellyfin.test/web/'+hash,html,JE:{t:k=>k,pluginConfig:{ArrIntegrationEnabled:true},session:{getEpoch:()=>epoch,onUserChange:(_,f)=>(change=f,()=>{})},core:{lifecycle:{register:()=>({teardown(){},track(){}})},navigation:{onNavigate:f=>(nav=f,()=>{})},dom:{onBodyMutation:(_,f)=>(mutation=f,()=>{})}}},apiClient:{getCurrentUser:()=>Promise.resolve({Policy:{IsAdministrator:true}})}});
 h.load('arr/adminusers/admin-users-api.js');
 h.JE.arrAdminUsersApi={...h.JE.arrAdminUsersApi,read,summary:async()=>{summaries++;return {people:[{id:A,role:'member',pending:null,quota:null}]};},patch:async(id,group,body)=>{writes.push({id,group,body});return view(id);}};
 nativeNav();h.load('arr/adminusers/admin-user-tabs.js');h.load('arr/adminusers/admin-users.js');h.JE.initializeArrAdminUsers();
 return {...h,writes, summaries:()=>summaries,mutate:()=>{nativeNav();mutation();},go:async hash=>{h.window.history.replaceState({},'',hash);nav();await tick();},reset:()=>{epoch++;change();}};
}
test('route parsing normalizes GUIDs and ignores add/malformed routes',()=>{const h=setup('#/home','');try{const parse=h.JE.arrAdminUsers.parseRoute;assert.equal(parse(`#/dashboard/users/${A}/profile/`).id,A);assert.equal(parse(`#/dashboard/users/access?userId=${A}`).id,A);assert.equal(parse('#/dashboard/users/').kind,'list');assert.equal(parse('#/dashboard/users/add'),null);assert.equal(parse('#/dashboard/users/no/profile'),null);}finally{h.close();}});
test('one batch decorates replacement cards without changing native links or showing unknown zero',async()=>{const h=setup('#/dashboard/users/',`<div id="userProfilesPage"><div class="localUsers"><div class="card" data-userid="${A}"><a href="#native">native</a><div class="cardFooter"></div></div></div></div>`);try{await tick();h.mutate();h.mutate();await tick();assert.equal(h.summaries(),1);assert.equal(h.document.querySelectorAll('[data-je-user-chip]').length,1);assert.doesNotMatch(h.document.querySelector('[data-je-user-chip]').textContent,/0/);assert.equal(h.document.querySelector('a').getAttribute('href'),'#native');h.document.querySelector('.cardFooter').innerHTML='';h.mutate();await tick();assert.equal(h.document.querySelectorAll('[data-je-user-chip]').length,1);assert.equal(h.summaries(),1);}finally{h.close();}});
test('late target response is discarded, drafts survive React replacement and logout clears everything',async()=>{const late=deferred();const h=setup(`#/dashboard/users/${A}/access?jeTab=jellyfinenhanced`,'<div id="usersEditPage"><div class="content-primary"></div></div>',id=>id===A?late.promise:Promise.resolve(view(B)));try{await tick();await h.go(`#/dashboard/users/${B}/access?jeTab=jellyfinenhanced`);late.resolve(view(A));await tick();assert.equal(h.document.querySelector('[data-je-admin-user]').dataset.jeAdminUser,B);const field=h.document.querySelector('[data-field="quotaLimit"]');field.value='8';field.dispatchEvent(new h.window.Event('change',{bubbles:true}));h.document.querySelector('.content-primary').innerHTML='';h.mutate();await tick();assert.equal(h.document.querySelector('[data-field="quotaLimit"]').value,'8');h.reset();assert.equal(h.document.querySelector('[data-je-admin-user]'),null);}finally{h.close();}});
test('transport sends PATCH with a separate JSON read and never rewrites personal documents',async()=>{const calls=[];const h=createHarness({fetch:async(url,options)=>{calls.push({url,options});return jsonResponse(view());}});try{h.load('arr/adminusers/admin-users-api.js');await h.JE.arrAdminUsersApi.patch(A,'display',{revision:'x',listStatus:false});assert.equal(calls[0].options.method,'PATCH');assert.match(calls[0].url,/arr\/admin\/users\//);assert.equal(calls[0].options.headers.Accept,'application/json');}finally{h.close();}});
test('an edit made while Save waits survives its answer and a conflict keeps the draft',async()=>{
 const h=setup(`#/dashboard/users/${A}/access?jeTab=jellyfinenhanced`,'<div id="usersEditPage"><div class="content-primary"></div></div>');
 try{await tick();const pending=deferred();h.JE.arrAdminUsersApi.patch=()=>pending.promise;
 let field=h.document.querySelector('[data-field="quotaLimit"]');field.value='3';field.dispatchEvent(new h.window.Event('change',{bubbles:true}));clickAsViewer(h.document.querySelector('[data-je-user-save]'));
 field=h.document.querySelector('[data-field="quotaLimit"]');field.value='8';field.dispatchEvent(new h.window.Event('change',{bubbles:true}));pending.resolve(view());await tick();
 assert.equal(h.document.querySelector('[data-field="quotaLimit"]').value,'8');
 h.JE.arrAdminUsersApi.patch=async()=>{throw {status:409};};clickAsViewer(h.document.querySelector('[data-je-user-save]'));await tick();
 assert.equal(h.document.querySelector('[data-field="quotaLimit"]').value,'8');assert.match(h.document.querySelector('[data-je-admin-user]').textContent,/conflict/);
 }finally{h.close();}
});
test('admin demotion on navigation immediately removes private DOM and drafts',async()=>{const h=setup(`#/dashboard/users/${A}/access?jeTab=jellyfinenhanced`,'<div id="usersEditPage"><div class="content-primary"></div></div>');try{await tick();assert.ok(h.document.querySelector('[data-je-admin-user]'));h.window.ApiClient.getCurrentUser=async()=>({Policy:{IsAdministrator:false}});await h.go(`#/dashboard/users/${A}/access?jeTab=jellyfinenhanced`);assert.equal(h.document.querySelector('[data-je-admin-user]'),null);}finally{h.close();}});
test('delayed React mount and repeated lifecycle mutations produce one retained section',async()=>{const h=setup(`#/dashboard/users/${A}/access?jeTab=jellyfinenhanced`,'');try{await tick();assert.equal(h.document.querySelector('[data-je-admin-user]'),null);h.document.body.innerHTML='<div id="usersEditPage"><div class="content-primary"><form></form></div></div>';h.mutate();h.mutate();await tick();assert.equal(h.document.querySelectorAll('[data-je-admin-user]').length,1);h.mutate();await tick();assert.equal(h.document.querySelectorAll('[data-je-admin-user]').length,1);}finally{h.close();}});
test('native Save cannot silently persist a JE draft and display inheritance stays null',async()=>{const h=setup(`#/dashboard/users/${A}/access?jeTab=jellyfinenhanced`,'<div id="usersEditPage"><div class="content-primary"><form><button type="submit">Native Save</button></form></div></div>');try{await tick();h.document.querySelector('form:not([data-je-admin-user])').addEventListener('submit',e=>e.preventDefault());const field=h.document.querySelector('[data-field="acquisitionBadges"]');field.value='';field.dispatchEvent(new h.window.Event('change',{bubbles:true}));clickAsViewer(h.document.querySelector('form:not([data-je-admin-user]) button'));await tick();assert.equal(h.writes.length,0);clickAsViewer(h.document.querySelector('[data-je-user-save]'));await tick();assert.equal(h.writes[0].body.acquisitionBadges,null);assert.deepEqual(Object.keys(h.writes[0].body).sort(),['acquisitionBadges','revision']);}finally{h.close();}});
test('unavailable components never present editable defaults or consent controls',async()=>{const data=view();data.policy.available=false;data.display.available=false;data.consents.available=false;const h=setup(`#/dashboard/users/${A}/access?jeTab=jellyfinenhanced`,'<div id="usersEditPage"><div class="content-primary"></div></div>',async()=>data);try{await tick();assert.equal(h.document.querySelector('[data-group="policy"] input'),null);assert.equal(h.document.querySelector('[data-group="display"] select'),null);assert.equal(h.document.querySelector('[data-field="autoMovieRequests"],[data-field="listSwapIn"]'),null);assert.match(h.document.querySelector('[data-je-admin-user]').textContent,/unavailable/);}finally{h.close();}});
test('a server/account epoch change rejects a pending transport response',async()=>{let epoch=1;const pending=deferred();const h=createHarness({JE:{session:{getEpoch:()=>epoch}},fetch:()=>pending.promise});try{h.load('arr/adminusers/admin-users-api.js');const read=h.JE.arrAdminUsersApi.read(A);epoch++;pending.resolve(jsonResponse(view()));await assert.rejects(read,error=>error.stale===true);}finally{h.close();}});
test('a cached native current-user object cannot keep administrator data after demotion',async()=>{const h=setup(`#/dashboard/users/${A}/access?jeTab=jellyfinenhanced`,'<div id="usersEditPage"><div class="content-primary"></div></div>');try{await tick();h.window.ApiClient.getUser=async()=>({Policy:{IsAdministrator:false}});await h.go(`#/dashboard/users/${A}/access?jeTab=jellyfinenhanced`);assert.equal(h.document.querySelector('[data-je-admin-user]'),null);}finally{h.close();}});
test('a synchronous native permission-read failure removes private data',async()=>{const h=setup(`#/dashboard/users/${A}/access?jeTab=jellyfinenhanced`,'<div id="usersEditPage"><div class="content-primary"></div></div>');try{await tick();h.window.ApiClient.getUser=()=>{throw new Error('session unavailable');};await h.go(`#/dashboard/users/${A}/access?jeTab=jellyfinenhanced`);assert.equal(h.document.querySelector('[data-je-admin-user]'),null);}finally{h.close();}});
test('a known JE unlimited count is distinguished from an unknown backend limit',async()=>{for(const backend of ['je','seerr']){const data=view();data.policy.backend=backend;data.policy.limit=null;const h=setup(`#/dashboard/users/${A}/access?jeTab=jellyfinenhanced`,'<div id="usersEditPage"><div class="content-primary"></div></div>',async()=>data);try{await tick();const line=[...h.document.querySelectorAll('p')].find(n=>n.textContent.startsWith('arr_user_effectiveLimit:'));assert.equal(line.textContent,`arr_user_effectiveLimit: arr_user_${backend==='je'?'unlimited':'unknown'}`);}finally{h.close();}}});
test('clearing an assigned ntfy topic stays cleared when the native reply omits null fields',async()=>{const data=view();data.notifications={available:true,topic:'old-topic',ntfy:true,assigned:true};const h=setup(`#/dashboard/users/${A}/access?jeTab=jellyfinenhanced`,'<div id="usersEditPage"><div class="content-primary"></div></div>',async()=>data);try{await tick();h.JE.arrAdminUsersApi.assignTopic=async(id,body)=>{assert.equal(id,A);assert.equal(body.topic,'');return {id:A,ntfy:false};};const field=h.document.querySelector('[data-group="notifications"] input');field.value='';field.dispatchEvent(new h.window.Event('change',{bubbles:true}));clickAsViewer(h.document.querySelector('[data-je-user-save]'));await tick();assert.equal(h.document.querySelector('[data-group="notifications"] input').value,'');}finally{h.close();}});
test('Ready playlist and TV messages are shown read-only: stored, switch and in effect, with no save control',async()=>{const data=view();data.ready={available:true,playlistGate:true,playlistStored:true,playlistEffective:true,state:'active',entries:4,messagesGate:false,messagesStored:true,messagesEffective:false};const h=setup(`#/dashboard/users/${A}/access?jeTab=jellyfinenhanced`,'<div id="usersEditPage"><div class="content-primary"></div></div>',async()=>data);try{await tick();const section=h.document.querySelector('[data-je-admin-user]');const group=section.querySelector('[data-group="ready"]');assert.ok(group);assert.equal(group.querySelector('h2').textContent,'arr_user_ready');assert.equal(group.querySelector('input,select,button'),null);assert.match(group.textContent,/arr_user_readyPlaylistStored: arr_user_yes/);assert.match(group.textContent,/arr_user_readyState: arr_user_readyState_active/);assert.match(group.textContent,/arr_user_readyEntries: 4/);assert.match(group.textContent,/arr_user_readyMessagesEffective: arr_user_no/);const shown=[...group.querySelectorAll(':scope > p')].map(p=>p.textContent);for(const label of ['readyPlaylistStored','readyState','readyMessagesStored'])assert.ok(shown.some(text=>text.startsWith('arr_user_'+label+':')),label+' is shown, not folded into details');const children=[...group.children];assert.ok(children.findIndex(n=>n.tagName==='DETAILS')>Math.max(...['readyPlaylistStored','readyState','readyMessagesStored'].map(label=>children.findIndex(n=>n.textContent.startsWith('arr_user_'+label+':')))),'the choices come before the details');assert.match(group.querySelector('details').textContent,/arr_user_readyPlaylistGate: arr_user_yes.*arr_user_readyEntries: 4.*arr_user_readyMessagesEffective: arr_user_no/);}finally{h.close();}
 const missing=view();const h2=setup(`#/dashboard/users/${A}/access?jeTab=jellyfinenhanced`,'<div id="usersEditPage"><div class="content-primary"></div></div>',async()=>missing);try{await tick();const group=h2.document.querySelector('[data-je-admin-user] [data-group="ready"]');assert.match(group.textContent,/arr_user_unavailable/);}finally{h2.close();}});
// 4f review round 2: the read-only Ready state shows "lost" as itself, not as off.
test('a lost Ready playlist reads as lost on the user page',async()=>{const data=view();data.ready={available:true,playlistGate:true,playlistStored:false,playlistEffective:false,state:'lost',entries:0,messagesGate:false,messagesStored:false,messagesEffective:false};const h=setup(`#/dashboard/users/${A}/access?jeTab=jellyfinenhanced`,'<div id="usersEditPage"><div class="content-primary"></div></div>',async()=>data);try{await tick();const group=h.document.querySelector('[data-je-admin-user] [data-group="ready"]');assert.match(group.textContent,/arr_user_readyState: arr_user_readyState_lost/);}finally{h.close();}});

for (const outcome of ['demoted', 'failed', 'allowed']) test(`a pending permission recheck hides drafts until ${outcome}`, async () => {
 const h=setup(`#/dashboard/users/${A}/access?jeTab=jellyfinenhanced`,'<div id="usersEditPage"><div class="content-primary"></div></div>');
 try {
  await tick();
  const field=h.document.querySelector('[data-field="quotaLimit"]');field.value='8';field.dispatchEvent(new h.window.Event('change',{bubbles:true}));
  const permission=deferred();h.window.ApiClient.getUser=()=>permission.promise;
  const navigation=h.go(`#/dashboard/users/${A}/access?jeTab=jellyfinenhanced`);
  assert.equal(h.document.querySelector('[data-je-admin-user]'),null);
  await navigation;h.mutate();await tick();
  assert.equal(h.document.querySelector('[data-je-admin-user]'),null,'cached drafts stay private during the check');
  if(outcome==='failed')permission.reject(new Error('offline'));else permission.resolve({Policy:{IsAdministrator:outcome==='allowed'}});
  await tick();
  if(outcome==='allowed')assert.equal(h.document.querySelector('[data-field="quotaLimit"]').value,'8');
  else {
   assert.equal(h.document.querySelector('[data-je-admin-user]'),null);
   h.window.ApiClient.getUser=async()=>({Policy:{IsAdministrator:true}});
   await h.go(`#/dashboard/users/${A}/access?jeTab=jellyfinenhanced`);
   assert.equal(h.document.querySelector('[data-field="quotaLimit"]').value,'','refusal/failure discards the retained draft');
  }
 } finally {h.close();}
});

for(const completion of ['read','save','summary'])test(`an old ${completion} completion cannot expose private DOM during a permission recheck`,async()=>{
 const pending=deferred();
 const h=setup(`#/dashboard/users/${A}/access?jeTab=jellyfinenhanced`,'<div id="usersEditPage"><div class="content-primary"></div></div>',completion==='read'?()=>pending.promise:async()=>view());
 try {
  await tick();
  if(completion==='save'){
   h.JE.arrAdminUsersApi.patch=()=>pending.promise;
   const field=h.document.querySelector('[data-field="quotaLimit"]');field.value='3';field.dispatchEvent(new h.window.Event('change',{bubbles:true}));
   clickAsViewer(h.document.querySelector('[data-je-user-save]'));
  }else if(completion==='summary'){
   h.JE.arrAdminUsersApi.summary=()=>pending.promise;
   h.document.body.innerHTML=`<div id="userProfilesPage"><div class="localUsers"><div class="card" data-userid="${A}"><div class="cardFooter"></div></div></div></div>`;
   await h.go('#/dashboard/users/');
  }
  const permission=deferred();h.window.ApiClient.getUser=()=>permission.promise;
  // The same-route lifecycle check must also suspend authorization.
  const navigation=h.go(h.window.location.hash);
  pending.resolve(completion==='summary'?{people:[{id:A,role:'member'}]}:view());
  await navigation;h.mutate();await tick();
  assert.equal(h.document.querySelector('[data-je-admin-user],[data-je-user-chip]'),null);
  permission.resolve({Policy:{IsAdministrator:false}});await tick();
  assert.equal(h.document.querySelector('[data-je-admin-user],[data-je-user-chip]'),null);
 }finally{h.close();}
});

test('B1: single Save advances successful revisions while pending edits and failed groups retain drafts',async()=>{
 const h=setup(`#/dashboard/users/${A}/access?jeTab=jellyfinenhanced`,'<div id="usersEditPage"><div class="content-primary"></div></div>');
 try {
  await tick();const pending=deferred();const writes=[];let revision='p1';
  h.JE.arrAdminUsersApi.patch=async(id,group,body)=>{
   writes.push({group,body});
   if(group!=='policy')throw {status:409};
   if(body.revision!==revision)throw {status:409};
   if(writes.filter(w=>w.group==='policy').length===1)return pending.promise;
   const data=view();data.revisions.policy='p3';data.policy.stored.quotaLimit=body.quotaLimit;return data;
  };
  const change=(field,value)=>{const input=h.document.querySelector(`[data-field="${field}"]`);input.value=value;input.dispatchEvent(new h.window.Event('change',{bubbles:true}));};
  change('listStatus','false');change('poolId','family');change('blocked','true');change('quotaLimit','3');
  clickAsViewer(h.document.querySelector('[data-je-user-save]'));change('quotaLimit','8');
  const saved=view();saved.policy.stored.quotaLimit=3;saved.revisions={policy:'p2',display:'d2','pool-membership':'g2','seerr-import':'s2'};revision='p2';pending.resolve(saved);await tick();
  assert.equal(h.document.querySelector('[data-field="quotaLimit"]').value,'8');
  assert.equal(h.document.querySelector('[data-group="policy"] [role="status"]').textContent,'arr_user_unsaved');
  for(const [group,expected] of [['display','d1'],['pool-membership','g1'],['seerr-import','s1']]){
   assert.equal(writes.find(w=>w.group===group).body.revision,expected);
   assert.equal(h.document.querySelector(`[data-group="${group}"] [role="status"]`).textContent,'arr_user_conflict');
  }
  clickAsViewer(h.document.querySelector('[data-je-user-save]'));await tick();
  const second=writes.filter(w=>w.group==='policy')[1];assert.equal(second.body.revision,'p2');assert.equal(second.body.quotaLimit,8);
  assert.equal(h.document.querySelector('[data-group="policy"] [role="status"]').textContent,'arr_user_saved');
 }finally{h.close();}
});

test('editor uses native controls and localized roles, backends and specific 4K restrictions',async()=>{
 const data=view();data.policy.fourKMoviesReason='not_visible_to_user';data.policy.effective.canRequestMovies=true;data.seerr.quotaSource='je';
 const h=setup(`#/dashboard/users/${A}/access?jeTab=jellyfinenhanced`,'<div id="usersEditPage"><div class="content-primary"></div></div>',async()=>data);
 try{
  await tick();const section=h.document.querySelector('[data-je-admin-user]');
  assert.ok(section.querySelector('[data-je-user-save]').classList.contains('button-submit'));
  for(const select of section.querySelectorAll('select'))assert.ok(select.classList.contains('emby-select-withcolor'));
  assert.match(section.textContent,/arr_user_backend: arr_user_backend_je/);
  assert.match(section.textContent,/arr_user_effectiveRole: arr_user_role_member/);
  assert.match(section.textContent,/arr_user_quotaSource: arr_user_backend_je/);
  assert.match(section.textContent,/arr_user_fourKMoviesBlocking: arr_user_restriction_not_visible_to_user/);
  assert.doesNotMatch(section.textContent,/arr_user_blocking:/);
  assert.doesNotMatch(section.textContent,/arr_user_fourKSeriesBlocking:/);
 }finally{h.close();}
});

for(const backend of ['je','seerr','status_only'])test(`request handling ${backend} has a human localized label`,async()=>{
 const data=view();data.policy.backend=backend;
 const h=setup(`#/dashboard/users/${A}/access?jeTab=jellyfinenhanced`,'<div id="usersEditPage"><div class="content-primary"></div></div>',async()=>data);
 try{await tick();assert.match(h.document.querySelector('[data-je-admin-user]').textContent,new RegExp(`arr_user_backend: arr_user_backend_${backend}`));}finally{h.close();}
});

test('a successful same-route permission recheck reuses the single list batch',async()=>{
 const h=setup('#/dashboard/users/',`<div id="userProfilesPage"><div class="localUsers"><div class="card" data-userid="${A}"><div class="cardFooter"></div></div></div></div>`);
 try{await tick();assert.equal(h.summaries(),1);await h.go('#/dashboard/users/');assert.equal(h.summaries(),1);assert.equal(h.document.querySelectorAll('[data-je-user-chip]').length,1);}finally{h.close();}
});

for(const family of ['12','10'])test(`${family}: native tab position, selection, history, reload and replacement`,async()=>{
 const native=tab=>family==='12'?`#/dashboard/users/${A}/${tab}`:`#/dashboard/users/${tab}?userId=${A}`;
 const je=native('access')+(family==='12'?'?':'&')+'jeTab=jellyfinenhanced';
 const root=family==='12'?'usersEditPage':'userLibraryAccessPage';
 const html=`<div id="${root}"><div class="content-primary">${family==='12'?muiTabs():legacyTabs()}<form class="userLibraryAccessForm"><input id="native-field"><button>Native Save</button></form></div></div>`;
 const h=setup(native('access'),html);
 try{
  await tick();let tab=h.document.querySelector('[data-je-user-tab]');assert.ok(tab);
  assert.equal(tab.previousElementSibling.textContent,'access');assert.equal(tab.nextElementSibling.textContent,'parentalcontrol');
  assert.equal(h.document.querySelector('[data-je-admin-user]'),null,'JE only owns its own panel');
  assert.equal(tab.textContent,'arr_user_tab');
  clickAsViewer(tab);await tick();assert.equal(h.window.location.hash,je);await h.go(je);
  tab=h.document.querySelector('[data-je-user-tab]');let panel=h.document.querySelector('[data-je-admin-user]');assert.ok(panel);assert.equal(panel.tagName,'FORM');assert.equal(panel.closest('form:not([data-je-admin-user])'),null);
  assert.equal(h.document.querySelector('.userLibraryAccessForm').hidden,true);
  assert.equal(tab.getAttribute('aria-selected'),'true');assert.equal(tab.tabIndex,0);
  if(family==='12'){
   assert.equal(h.document.querySelectorAll('[role="tab"][aria-selected="true"]').length,1);
   assert.equal(h.document.querySelectorAll('.Mui-selected').length,1);
   assert.equal(tab.getAttribute('aria-controls'),panel.id);
  }
  assert.equal(panel.querySelectorAll('button[type="submit"]').length,1);assert.ok(panel.querySelector('button.raised.button-submit.block'));
  assert.equal(panel.querySelector('[data-save],[data-cancel],legend'),null);assert.equal(h.document.querySelector('details.je-admin-user'),null);
  assert.equal(panel.querySelectorAll('[data-group] > h2').length,8);assert.ok(panel.querySelector('.fieldDescription'));assert.ok(panel.querySelector('details > summary'));
  const input=panel.querySelector('[data-field="quotaLimit"]');input.value='9';input.dispatchEvent(new h.window.Event('change',{bubbles:true}));
  for(let i=0;i<8;i++){h.mutate();await tick();}assert.equal(h.document.querySelectorAll('[data-je-user-tab]').length,1);assert.equal(h.document.querySelectorAll('[data-je-admin-user]').length,1);
  clickAsViewer(h.document.querySelector('[data-je-user-tab]').previousElementSibling);assert.equal(h.window.location.hash,native('access'),'native Access leaves the JE tab even though React still considers Access selected');
  await h.go(native('access'));assert.equal(h.document.querySelector('[data-je-admin-user]'),null);assert.equal(h.document.querySelector('.userLibraryAccessForm').hidden,false);
  if(family==='12')assert.equal(h.document.querySelector('[data-native="access"]').getAttribute('aria-selected'),'true');
  // Back and Forward replay the actual recorded locations.
  await h.go(je);assert.equal(h.document.querySelector('[data-field="quotaLimit"]').value,'9');await h.go(native('access'));await h.go(je);
  h.document.getElementById(root).outerHTML=html;h.mutate();await tick();
  assert.equal(h.document.querySelectorAll('[data-je-user-tab]').length,1);assert.equal(h.document.querySelectorAll('[data-je-admin-user]').length,1);assert.equal(h.document.querySelector('[data-field="quotaLimit"]').value,'9');
  tab=h.document.querySelector('[data-je-user-tab]');tab.focus();tab.dispatchEvent(new h.window.KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));
  assert.equal(h.document.activeElement.textContent,'parentalcontrol');
  tab.focus();tab.dispatchEvent(new h.window.KeyboardEvent('keydown',{key:'Home',bubbles:true}));assert.equal(h.document.activeElement.textContent,'profile');
  h.reset();assert.equal(h.document.querySelector('[data-je-user-tab],[data-je-admin-user]'),null);assert.equal(h.document.querySelector('.userLibraryAccessForm').hidden,false);
 }finally{h.close();}
 const cold=setup(je,html);try{await tick();assert.ok(cold.document.querySelector('[data-je-admin-user]'));}finally{cold.close();}
});

test('one Save sends only dirty groups, continues after a failure and uses native toasts',async()=>{
 const h=setup(`#/dashboard/users/${A}/access?jeTab=jellyfinenhanced`,'<div id="usersEditPage"><div class="content-primary"><form class="userLibraryAccessForm"></form></div></div>');
 try{
  const toasts=[];h.window.require=(deps,callback)=>callback(msg=>toasts.push(msg),{translate:key=>'native:'+key});await tick();
  const change=(field,v)=>{const input=h.document.querySelector(`[data-field="${field}"]`);input.value=v;input.dispatchEvent(new h.window.Event('change',{bubbles:true}));};
  let calls=[];h.JE.arrAdminUsersApi.patch=async(id,group,body)=>{calls.push({group,body});if(group==='display')throw {status:409};const result=view();result.policy.stored.quotaLimit=7;result.revisions.policy='p2';return result;};
  change('quotaLimit','7');change('listStatus','false');change('blocked','true');clickAsViewer(h.document.querySelector('[data-je-user-save]'));await tick();
  assert.deepEqual(calls.map(c=>c.group),['policy','display','seerr-import']);
  assert.equal(h.document.querySelector('[data-group="display"] [role="status"]').textContent,'arr_user_conflict');assert.equal(h.document.querySelector('[data-field="listStatus"]').value,'false');
  assert.equal(toasts.at(-1),'arr_user_saveError');
  calls=[];h.JE.arrAdminUsersApi.patch=async(id,group,body)=>{calls.push({group,body});const result=view();result.display.stored.listStatus=false;return result;};
  clickAsViewer(h.document.querySelector('[data-je-user-save]'));await tick();assert.deepEqual(calls.map(c=>c.group),['display']);assert.equal(toasts.at(-1),'native:SettingsSaved');
  clickAsViewer(h.document.querySelector('[data-je-user-save]'));await tick();assert.equal(calls.length,1,'unchanged groups never sent');
 }finally{h.close();}
});

test('native toast remains available on current Jellyfin without the removed AMD loader',async()=>{
 const h=setup(`#/dashboard/users/${A}/access?jeTab=jellyfinenhanced`,'<div id="usersEditPage"><div class="content-primary"></div></div>');
 try{await tick();const input=h.document.querySelector('[data-field="quotaLimit"]');input.value='6';input.dispatchEvent(new h.window.Event('change',{bubbles:true}));clickAsViewer(h.document.querySelector('[data-je-user-save]'));await tick();assert.equal(h.document.querySelector('.toastContainer .toast').textContent,'arr_user_settingsSaved');h.reset();assert.equal(h.document.querySelector('[data-je-user-toast]'),null);}finally{h.close();}
});

for(const family of ['12','10'])for(const tab of ['profile','access','parentalcontrol','password'])test(`${family} ${tab}: one tab and no JE panel on native routes`,async()=>{
 const root=family==='12'?'usersEditPage':{profile:'editUserPage',access:'userLibraryAccessPage',parentalcontrol:'userParentalControlPage',password:'userPasswordPage'}[tab];
 const hash=family==='12'?`#/dashboard/users/${A}/${tab}`:`#/dashboard/users/${tab}?userId=${A}`;
 const h=setup(hash,`<div id="${root}"><div class="content-primary">${family==='12'?muiTabs():legacyTabs()}<form id="native-form"></form></div></div>`);
 try{await tick();assert.equal(h.document.querySelectorAll('[data-je-user-tab]').length,1);assert.equal(h.document.querySelector('[data-je-admin-user]'),null);assert.equal(h.document.querySelector('#native-form').hidden,false);}finally{h.close();}
});

test('returning controls to their stored values sends no unchanged sections',async()=>{
 const h=setup(`#/dashboard/users/${A}/access?jeTab=jellyfinenhanced`,'<div id="usersEditPage"><div class="content-primary"></div></div>');
 try{await tick();const input=h.document.querySelector('[data-field="quotaLimit"]');input.value='6';input.dispatchEvent(new h.window.Event('change',{bubbles:true}));input.value='';input.dispatchEvent(new h.window.Event('change',{bubbles:true}));clickAsViewer(h.document.querySelector('[data-je-user-save]'));await tick();assert.equal(h.writes.length,0);}finally{h.close();}
});

test('reverting an in-flight edit to its pre-save value remains a new draft',async()=>{
 const data=view();data.policy.stored.quotaLimit=3;
 const h=setup(`#/dashboard/users/${A}/access?jeTab=jellyfinenhanced`,'<div id="usersEditPage"><div class="content-primary"></div></div>',async()=>data);
 try{await tick();const pending=deferred();h.JE.arrAdminUsersApi.patch=()=>pending.promise;
 const change=n=>{const input=h.document.querySelector('[data-field="quotaLimit"]');input.value=n;input.dispatchEvent(new h.window.Event('change',{bubbles:true}));};change('6');clickAsViewer(h.document.querySelector('[data-je-user-save]'));change('3');const saved=view();saved.policy.stored.quotaLimit=6;saved.revisions.policy='p2';pending.resolve(saved);await tick();assert.equal(h.document.querySelector('[data-field="quotaLimit"]').value,'3');assert.equal(h.document.querySelector('[data-group="policy"] [role="status"]').textContent,'arr_user_unsaved');
 }finally{h.close();}
});

test('React attribute-only tab updates reconcile selection and indicator without an observer loop',async()=>{
 const h=setup(`#/dashboard/users/${A}/access?jeTab=jellyfinenhanced`,'<div id="usersEditPage"><div class="content-primary"></div></div>');
 try{await tick();let mutations=0;const observer=new h.window.MutationObserver(records=>{mutations+=records.length});observer.observe(h.document.querySelector('.MuiTabs-root'),{attributes:true,subtree:true});
 const access=h.document.querySelector('[data-native="access"]');access.classList.add('Mui-selected');access.setAttribute('aria-selected','true');h.document.querySelector('.MuiTabs-indicator').style.left='80px';await tick();
 assert.equal(access.getAttribute('aria-selected'),'false');assert.equal(access.classList.contains('Mui-selected'),false);assert.equal(h.document.querySelector('.MuiTabs-indicator').style.left,'0px');
 const settled=mutations;await tick();assert.equal(mutations,settled,'owned mutations settle');observer.disconnect();
 }finally{h.close();}
});

function edit(h,field,value){const input=h.document.querySelector(`[data-field="${field}"]`);input.value=value;input.dispatchEvent(new h.window.Event('change',{bubbles:true}));}
function save(h){clickAsViewer(h.document.querySelector('[data-je-user-save]'));}
function status(h,group){return h.document.querySelector(`[data-group="${group}"] [role="status"]`).textContent;}

test('a native-tab conflict explains the available reload action and retains the draft',async()=>{
 const en=JSON.parse(readFileSync(new URL('../../../Jellyfin.Plugin.JellyfinEnhanced/js/locales/en.json',import.meta.url),'utf8'));
 const h=setup(`#/dashboard/users/${A}/access?jeTab=jellyfinenhanced`,'<div id="usersEditPage"><div class="content-primary"></div></div>');
 try{h.JE.t=key=>en[key]||key;await tick();h.JE.arrAdminUsersApi.patch=async()=>{throw {status:409};};edit(h,'quotaLimit','5');save(h);await tick();assert.equal(h.document.querySelector('[data-field="quotaLimit"]').value,'5');assert.match(status(h,'policy'),/Reload the page/);assert.doesNotMatch(status(h,'policy'),/Cancel/);}finally{h.close();}
});

test('B2: reverting a queued display group to inheritance survives the whole Save',async()=>{
 const h=setup(`#/dashboard/users/${A}/access?jeTab=jellyfinenhanced`,'<div id="usersEditPage"><div class="content-primary"></div></div>');
 try{
  await tick();const pending=deferred(),writes=[];let stored=view();
  h.JE.arrAdminUsersApi.patch=async(id,group,body)=>{
   writes.push({group,body});if(group==='policy')await pending.promise;
   stored=structuredClone(stored);
   if(group==='policy'){stored.policy.stored.quotaLimit=body.quotaLimit;stored.revisions.policy='p2';}
   else {stored.display.stored.listStatus=body.listStatus;stored.revisions.display='d'+writes.length;}
   return structuredClone(stored);
  };
  edit(h,'quotaLimit','5');edit(h,'listStatus','false');save(h);edit(h,'listStatus','');pending.resolve();await tick();
  assert.equal(writes.length,2);assert.equal(writes[1].body.listStatus,false,'queued submission remains the Save-start snapshot');
  assert.equal(h.document.querySelector('[data-field="listStatus"]').value,'','desired inheritance survives the queued write');
  assert.equal(status(h,'display'),'arr_user_unsaved');save(h);await tick();
  assert.equal(writes.length,3);assert.equal(writes[2].body.listStatus,null);assert.equal(writes[2].body.revision,'d2');
  assert.equal(stored.display.stored.listStatus,null);assert.equal(status(h,'display'),'arr_user_saved');
 }finally{h.close();}
});

test('B3: 5 to 8 to 5 during a failed Save keeps 5 and retries it',async()=>{
 const h=setup(`#/dashboard/users/${A}/access?jeTab=jellyfinenhanced`,'<div id="usersEditPage"><div class="content-primary"></div></div>');
 try{
  await tick();const pending=deferred(),writes=[];
  h.JE.arrAdminUsersApi.patch=async(id,group,body)=>{writes.push({group,body});if(writes.length===1)return pending.promise;const data=view();data.policy.stored.quotaLimit=body.quotaLimit;data.revisions.policy='p2';return data;};
  edit(h,'quotaLimit','5');save(h);edit(h,'quotaLimit','8');edit(h,'quotaLimit','5');pending.reject({status:503});await tick();
  assert.equal(h.document.querySelector('[data-field="quotaLimit"]').value,'5');assert.equal(status(h,'policy'),'arr_user_saveError');save(h);await tick();
  assert.equal(writes.length,2);assert.equal(writes[1].body.quotaLimit,5);assert.equal(writes[1].body.revision,'p1');assert.equal(status(h,'policy'),'arr_user_saved');
 }finally{h.close();}
});

for(const later of ['pool-membership','seerr-import'])test(`B4: ${later} advances a retained policy draft past this Save's own config writes`,async()=>{
 const h=setup(`#/dashboard/users/${A}/access?jeTab=jellyfinenhanced`,'<div id="usersEditPage"><div class="content-primary"></div></div>');
 try{
  await tick();const pending=deferred(),writes=[];let stored=view(),counter=1;
  h.JE.arrAdminUsersApi.patch=async(id,group,body)=>{
   writes.push({group,body});if(body.revision!==stored.revisions[group])throw {status:409};
   if(writes.length===1)await pending.promise;
   const previousRevisions={...stored.revisions};stored=structuredClone(stored);stored.revisions.policy='p'+(++counter);
   if(group==='policy')stored.policy.stored.quotaLimit=body.quotaLimit;
   else if(group==='pool-membership'){stored.pools.explicit=body.poolId;stored.revisions[group]='g2';}
   else {stored.seerr.blocked=body.blocked;stored.revisions[group]='s2';}
   return {...structuredClone(stored),previousRevisions};
  };
  edit(h,'quotaLimit','5');edit(h,later==='pool-membership'?'poolId':'blocked',later==='pool-membership'?'family':'true');
  save(h);edit(h,'quotaLimit','8');pending.resolve();await tick();
  assert.equal(writes.length,2);assert.equal(status(h,later),'arr_user_saved');assert.equal(status(h,'policy'),'arr_user_unsaved');
  save(h);await tick();assert.equal(writes.length,3);assert.equal(writes[2].body.revision,'p3');assert.equal(writes[2].body.quotaLimit,8);assert.equal(status(h,'policy'),'arr_user_saved');
 }finally{h.close();}
});

test('a genuine external display writer still conflicts after this Save writes policy',async()=>{
 const h=setup(`#/dashboard/users/${A}/access?jeTab=jellyfinenhanced`,'<div id="usersEditPage"><div class="content-primary"></div></div>');
 try{
  await tick();const writes=[];
  h.JE.arrAdminUsersApi.patch=async(id,group,body)=>{writes.push({group,body});if(group==='display'){if(body.revision!=='external-d2')throw {status:409};throw new Error('external edit overwritten');}const data=view();data.policy.stored.quotaLimit=5;data.revisions.policy='p2';data.revisions.display='external-d2';data.display.stored.listStatus=true;return data;};
  edit(h,'quotaLimit','5');edit(h,'listStatus','false');save(h);await tick();
  assert.equal(writes.length,2);assert.equal(writes[1].body.revision,'d1');assert.equal(status(h,'display'),'arr_user_conflict');assert.equal(h.document.querySelector('[data-field="listStatus"]').value,'false');
 }finally{h.close();}
});

test('an external policy write before our pool write cannot be adopted as our own revision',async()=>{
 const h=setup(`#/dashboard/users/${A}/access?jeTab=jellyfinenhanced`,'<div id="usersEditPage"><div class="content-primary"></div></div>');
 try{
  await tick();const pending=deferred(),writes=[];
  h.JE.arrAdminUsersApi.patch=async(id,group,body)=>{
   writes.push({group,body});if(writes.length===1){await pending.promise;const data=view();data.policy.stored.quotaLimit=5;data.revisions.policy='p2';return data;}
   if(group==='pool-membership'){const data=view();data.pools.explicit='family';data.policy.stored.quotaLimit=9;data.revisions.policy='p4';data.revisions['pool-membership']='g2';return {...data,previousRevisions:{policy:'external-p3','pool-membership':'g1'}};}
   if(body.revision!=='p4')throw {status:409};throw new Error('external edit overwritten');
  };
  edit(h,'quotaLimit','5');edit(h,'poolId','family');save(h);edit(h,'quotaLimit','8');pending.resolve();await tick();save(h);await tick();
  assert.equal(writes.length,3);assert.equal(writes[2].body.revision,'p2');assert.equal(status(h,'policy'),'arr_user_conflict');assert.equal(h.document.querySelector('[data-field="quotaLimit"]').value,'8');
 }finally{h.close();}
});

// Q-REBUILD1-3 (b), D43: 4c3's list-page and 4d's home-row preferences are Display rows like the others (tri-state, saved
// through the display group), each labelled from en.json (D50).
test('list-page and home-row preferences render and save as tri-state Display rows with en.json labels',async()=>{
 const en=JSON.parse(readFileSync(new URL('../../../Jellyfin.Plugin.JellyfinEnhanced/js/locales/en.json',import.meta.url),'utf8'));
 const added=['listPlaylistUi','listCollectionUi','homeRowRequests','homeRowSoon','homeRowArrived'];
 const withRows=()=>{const v=view();v.display.stored={...v.display.stored,listPlaylistUi:false,listCollectionUi:null,homeRowRequests:null,homeRowSoon:true,homeRowArrived:null};v.display.gates={...v.display.gates,...Object.fromEntries(added.map(k=>[k,true]))};v.display.effective={...v.display.effective,listPlaylistUi:false,listCollectionUi:true,homeRowRequests:true,homeRowSoon:true,homeRowArrived:true};return v;};
 const h=setup(`#/dashboard/users/${A}/access?jeTab=jellyfinenhanced`,'<div id="usersEditPage"><div class="content-primary"></div></div>',()=>Promise.resolve(withRows()));
 try{
  await tick();
  for(const field of added){const select=h.document.querySelector(`[data-group="display"] [data-field="${field}"]`);assert.ok(select,field);assert.deepEqual([...select.options].map(o=>o.value),['','true','false']);assert.ok(typeof en['arr_user_'+field]==='string'&&en['arr_user_'+field].length>0,'en.json label for '+field);}
  assert.equal(h.document.querySelector('[data-field="listPlaylistUi"]').value,'false');assert.equal(h.document.querySelector('[data-field="homeRowSoon"]').value,'true');assert.equal(h.document.querySelector('[data-field="homeRowArrived"]').value,'');
  const change=(field,value)=>{const el=h.document.querySelector(`[data-field="${field}"]`);el.value=value;el.dispatchEvent(new h.window.Event('change',{bubbles:true}));};
  change('homeRowArrived','false');change('listPlaylistUi','');clickAsViewer(h.document.querySelector('[data-je-user-save]'));await tick();
  const write=h.writes.find(w=>w.group==='display');assert.ok(write);assert.equal(write.body.homeRowArrived,false);assert.equal(write.body.listPlaylistUi,null);assert.equal(write.body.revision,'d1');
  assert.ok(!('homeOpsStrip' in write.body));
 }finally{h.close();}
});
test('UX-7: with Seerr off the Seerr group shows no identity, keeps the stored import exclusion read-only, links only to Seerr setup; quota help follows the backend',async()=>{
 const data=view();data.seerr={enabled:false,state:'unavailable',blocked:true,adminUrl:'http://seerr.test/users',quotaSource:'je'};
 const h=setup(`#/dashboard/users/${A}/access?jeTab=jellyfinenhanced`,'<div id="usersEditPage"><div class="content-primary"></div></div>',async()=>data);
 try{await tick();
  const group=h.document.querySelector('[data-group="seerr-import"]');
  assert.match(group.textContent,/arr_user_seerrOff/);
  assert.doesNotMatch(group.textContent,/arr_user_state_unavailable|arr_user_linkState|arr_user_account/);
  const select=group.querySelector('[data-field="blocked"]');
  assert.equal(select.disabled,true);assert.equal(select.value,'true','the stored exclusion is shown as it is');
  assert.deepEqual([...group.querySelectorAll('a')].map(a=>[a.textContent,a.getAttribute('href')]),[['arr_user_seerrSetup','#/configurationpage?name=Jellyfin%20Enhanced']]);
  const policy=h.document.querySelector('[data-group="policy"]').textContent;
  assert.match(policy,/arr_user_quotaHelpJe/);assert.doesNotMatch(policy,/arr_user_quotaHelp(?!Je)/);
 }finally{h.close();}
});
test('UX-7 control: with Seerr on (or an older server) the Seerr group and the Seerr quota wording are as before',async()=>{
 for(const enabled of [true,undefined]){
  const data=view();data.policy.backend='seerr';data.seerr={enabled,state:'linked',account:'Ann',blocked:false,adminUrl:'http://seerr.test/users',quotaSource:'seerr'};
  const h=setup(`#/dashboard/users/${A}/access?jeTab=jellyfinenhanced`,'<div id="usersEditPage"><div class="content-primary"></div></div>',async()=>data);
  try{await tick();
   const group=h.document.querySelector('[data-group="seerr-import"]');
   assert.doesNotMatch(group.textContent,/arr_user_seerrOff/);
   assert.match(group.textContent,/arr_user_state_linked/);assert.match(group.textContent,/arr_user_importHelp/);
   assert.equal(group.querySelector('[data-field="blocked"]').disabled,false);
   assert.equal(group.querySelector('a').getAttribute('href'),'http://seerr.test/users');
   assert.match(h.document.querySelector('[data-group="policy"]').textContent,/arr_user_quotaHelp(?!Je)/);
  }finally{h.close();}
 }
});
