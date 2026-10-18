// A processed DOM marker is a resolved verdict; retained nodes must survive lookup outages.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHarness,deferred} from '../helpers/harness.mjs';
const tick=()=>new Promise(r=>setImmediate(r));
/** Real session ownership and privacy modules, with native metadata response fixtures only. */
function setup(t,reply){
 let user='a',token='a';const reads=[];
 const h=createHarness({apiClient:{getCurrentUserId:()=>user,accessToken:()=>token,setAuthenticationInfo(next,id){token=next;user=id;},
  getUrl:(path,params)=>`http://jellyfin.test${path}${params?'?'+new URLSearchParams(params):''}`,
  ajax:async o=>{reads.push({url:o.url,user});return reply(o,reads.length,user);}},
  JE:{t:k=>k,pluginConfig:{HiddenContentEnabled:true},userConfig:{hiddenContent:{items:{provider:{type:'Series',tmdbId:'42'}},settings:{showButtonLibrary:false}}}}});
 t.after(()=>h.close());h.load('core/navigation.js');h.load('core/session.js');h.load('core/session-action.js');h.load('enhanced/hiddencontent/hidden-content-data.js');
 const api=h.JE.internals.hiddenContent;api.resetFromUserConfig();
 h.load('enhanced/hiddencontent/hidden-content-filter.js');h.load('enhanced/hiddencontent/hidden-content-buttons.js');
 return {...h,api,reads,async settle(){for(let n=0;n<6;n++){await tick();await new Promise(r=>h.window.requestAnimationFrame(r));}},
  later(){const now=h.window.Date.now;h.window.Date.now=()=>now()+31000;},
  switchUser(){h.window.ApiClient.setAuthenticationInfo('b','b');h.JE.userConfig={hiddenContent:{items:{provider:{type:'Series',tmdbId:'42'}},settings:{}}};api.resetFromUserConfig();}};
}
/** Native child/parent metadata, distinguishing the two batched fields. */
function metadata(o,tmdb='42'){
 const u=new URL(o.url),ids=u.searchParams.get('Ids').split(',');
 return {Items:ids.map(Id=>u.searchParams.get('Fields')==='SeriesId'?{Id,SeriesId:Id.replace(/^e/,'s')}:{Id,Type:'Series',ProviderIds:{Tmdb:tmdb}})};
}
/** Mount once; all recovery passes retain these exact nodes. */
function mount(h,count,type='Episode'){
 h.document.body.innerHTML='<div class="section">'+Array.from({length:count},(_,i)=>`<div class="card" data-id="e${i}" data-type="${type}"></div>`).join('')+'</div>';
 return [...h.document.querySelectorAll('.card')];
}
for(const type of ['Episode','Season'])for(const count of [1,60,120])test(`retained ${count} ${type} cards resolve only after parent provider recovery`,async t=>{
 let fail=true;const h=setup(t,o=>{if(new URL(o.url).searchParams.get('Fields')==='ProviderIds'&&fail)throw Error('503');return metadata(o);});
 const cards=mount(h,count,type);h.api.filterNativeCards();await h.settle();
 assert.equal(cards.filter(c=>c.classList.contains('je-hidden')).length,0);
 const before=h.reads.length;for(let n=0;n<3;n++)h.api.filterNativeCards();await h.settle();assert.equal(h.reads.length,before,'outstanding identities respect backoff');
 fail=false;h.later();h.api.filterNativeCards();await h.settle();
 assert.equal(cards.filter(c=>c.classList.contains('je-hidden')).length,count,'ordinary pass resolves all retained nodes');
 assert.equal(cards.filter(c=>c.hasAttribute('data-je-hidden-checked')).length,count,'only settled decisions are checked');
 assert.deepEqual([...h.document.querySelectorAll('.card')],cards);
 const settled=h.reads.length;h.api.filterNativeCards();await h.settle();assert.equal(h.reads.length,settled,'resolved nodes do no extra work');
});
for(const field of ['ProviderIds','SeriesId'])test(`retained middle ${field} batch failure recovers every unresolved identity`,async t=>{
 let batches=0,fail=true;const h=setup(t,o=>{if(new URL(o.url).searchParams.get('Fields')===field&&++batches===2&&fail)throw Error('503');return metadata(o);});
 const cards=mount(h,120);h.api.filterNativeCards();await h.settle();
 const before=h.reads.length;h.api.filterNativeCards();await h.settle();assert.equal(h.reads.length,before,'no immediate retry of middle failure');
 fail=false;h.later();h.api.filterNativeCards();await h.settle();
 assert.equal(cards.filter(c=>c.classList.contains('je-hidden')).length,120);
 assert.deepEqual([...h.document.querySelectorAll('.card')],cards);
});
test('a pending parent decision has no resolved marker and repeated passes deduplicate by identity',async t=>{
 const gate=deferred();let parents=0;const h=setup(t,o=>{if(new URL(o.url).searchParams.get('Fields')==='ProviderIds'){parents++;return gate.promise;}return metadata(o);});
 const [card]=mount(h,1);h.api.filterNativeCards();await h.settle();
 assert.equal(card.hasAttribute('data-je-hidden-checked'),false,'pending is independent of DOM');
 const duplicate=card.cloneNode(true);card.parentNode.append(duplicate);for(let n=0;n<3;n++)h.api.filterNativeCards();await h.settle();
 assert.equal(parents,1,'one request per identity while pending');
 gate.resolve({Items:[{Id:'s0',Type:'Series',ProviderIds:{Tmdb:'42'}}]});await h.settle();h.api.filterNativeCards();await h.settle();
 assert.ok(card.classList.contains('je-hidden'));assert.ok(duplicate.classList.contains('je-hidden'));
});
for(const stage of ['pending','failed'])test(`new session does not inherit ${stage} parent work, backoff or verdict`,async t=>{
 const gate=deferred();let oldCalls=0;const h=setup(t,(o,n,user)=>{
  if(user==='a'&&new URL(o.url).searchParams.get('Fields')==='ProviderIds'){oldCalls++;if(stage==='pending')return gate.promise;throw Error('503');}
  return metadata(o,'99');
 });
 const cards=mount(h,1);h.api.filterNativeCards();await h.settle();assert.equal(oldCalls,1);
 h.switchUser();h.api.filterNativeCards();await h.settle();
 assert.ok(h.reads.some(r=>r.user==='b'&&new URL(r.url).searchParams.get('Fields')==='ProviderIds'),'new session immediately owns a fresh lookup');
 gate.resolve({Items:[{Id:'s0',Type:'Series',ProviderIds:{Tmdb:'42'}}]});await h.settle();
 assert.equal(cards[0].classList.contains('je-hidden'),false,'outgoing hidden provider never paints incoming card');
 assert.equal(h.api.titleData({itemId:'s0'})?.tmdbId,'99');
 assert.equal(cards[0].hasAttribute('data-je-hidden-checked'),true);
});
for(const all of [false,true])test(`${all?'full':'ordinary'} title pass leaves failed identity unresolved, including duplicate retained nodes`,async t=>{
 let fail=true;const gate=deferred();const h=setup(t,async o=>{if(fail)return gate.promise;const ids=new URL(o.url).searchParams.get('Ids').split(',');return {Items:ids.map(Id=>({Id,Type:'Movie',ProviderIds:{Tmdb:'42'}}))};});
 h.api.getHiddenData().items={provider:{type:'Movie',tmdbId:'42'}};h.api.rebuildSets();
 const cards=mount(h,2,'Movie');cards[1].dataset.id='e0';
 const pass=()=>all?h.api.filterAllNativeCards():h.api.filterNativeCards();pass();await h.settle();
 assert.ok(cards.every(c=>!c.hasAttribute('data-je-hidden-checked')),'pending identity cannot be checked');
 gate.reject(Error('503'));await h.settle();pass();await h.settle();assert.equal(h.reads.length,1);
 assert.ok(cards.every(c=>!c.hasAttribute('data-je-hidden-checked')),'failed identity cannot be checked');
 fail=false;h.later();pass();await h.settle();assert.equal(h.reads.length,2,'duplicate cards share one identity batch');
 assert.ok(cards.every(c=>c.classList.contains('je-hidden')&&c.hasAttribute('data-je-hidden-checked')));
});
test('a completed parent lookup cannot undo a direct hide saved while it was pending',async t=>{
 const gate=deferred();const h=setup(t,o=>new URL(o.url).searchParams.get('Fields')==='ProviderIds'?gate.promise:metadata(o));
 const [card]=mount(h,1);h.api.filterNativeCards();await h.settle();
 h.api.getHiddenData().items.direct={itemId:'e0',type:'Episode'};h.api.rebuildSets();h.api.filterAllNativeCards();await h.settle();assert.ok(card.classList.contains('je-hidden'));
 gate.resolve({Items:[{Id:'s0',Type:'Series',ProviderIds:{Tmdb:'99'}}]});await h.settle();assert.ok(card.classList.contains('je-hidden'));
});
test('overlapping 120-card scans share future child and provider batches by identity',async t=>{
 const gates=[deferred(),deferred()];const requested=[];
 const h=setup(t,async o=>{const u=new URL(o.url),ids=u.searchParams.get('Ids').split(','),field=u.searchParams.get('Fields');requested.push({ids,field});
  if(field==='SeriesId'&&ids[0]==='e0')await gates[0].promise;
  if(field==='SeriesId'&&ids[0]==='e50')await gates[1].promise;
  return metadata(o);
 });
 const cards=mount(h,120);h.api.filterNativeCards();await h.settle();h.api.filterNativeCards();await h.settle();
 gates[0].resolve();await h.settle();gates[1].resolve();await h.settle();h.api.filterNativeCards();await h.settle();
 assert.equal(cards.filter(c=>c.classList.contains('je-hidden')).length,120);
 for(const field of ['SeriesId','ProviderIds']){
  const ids=requested.filter(r=>r.field===field).flatMap(r=>r.ids);assert.equal(ids.length,120,`${field}: each identity requested exactly once across interleaved scans`);
 }
});
test('a later view can resolve provider metadata that a successful earlier read omitted',async t=>{
 let arrived=false,onView;const h=setup(t,o=>{const ids=new URL(o.url).searchParams.get('Ids').split(',');return {Items:ids.map(Id=>({Id,Type:'Movie',ProviderIds:arrived?{Tmdb:'42'}:{}}))};});
 h.JE.helpers={onViewPage:h.JE.core.navigation.onViewPage};h.api.setupNativeObserver();onView=()=>h.JE.core.navigation.replayViewShow();
 h.api.getHiddenData().items={provider:{type:'Movie',tmdbId:'42'}};h.api.rebuildSets();
 let cards=mount(h,1,'Movie');h.api.filterNativeCards();await h.settle();assert.equal(cards[0].hasAttribute('data-je-hidden-checked'),true);assert.equal(cards[0].classList.contains('je-hidden'),false);
 arrived=true;onView();cards=mount(h,1,'Movie');h.api.filterNativeCards();await h.settle();assert.equal(cards[0].classList.contains('je-hidden'),true,'a new view must not inherit an earlier missing-provider verdict');
});

// R11: verdicts have lifetimes; boundaries must revisit the same retained node.
for(const type of ['Episode','Season','Movie','Series'])for(const boundary of ['view','session','rules'])test(`retained ${type} missing-provider verdict expires across ${boundary} with an ordinary scan`,async t=>{
 let arrived=false,onView;const child=['Episode','Season'].includes(type);
 const h=setup(t,o=>{const u=new URL(o.url),ids=u.searchParams.get('Ids').split(',');
  return {Items:ids.map(Id=>u.searchParams.get('Fields')==='SeriesId'?{Id,SeriesId:'s0'}:{Id,Type:child?'Series':type,ProviderIds:arrived?{Tmdb:'42'}:{}})};
 });
 h.JE.helpers={onViewPage:h.JE.core.navigation.onViewPage};h.api.setupNativeObserver();onView=()=>h.JE.core.navigation.replayViewShow();
 h.api.getHiddenData().items={provider:{type:child?'Series':type,tmdbId:'42'}};h.api.rebuildSets();
 const [card]=mount(h,1,type);h.api.filterNativeCards();await h.settle();
 assert.equal(card.classList.contains('je-hidden'),false);assert.equal(card.hasAttribute('data-je-hidden-checked'),true);
 const reads=h.reads.length;arrived=true;
 if(boundary==='view')onView();
 if(boundary==='session'){
  h.switchUser();h.api.getHiddenData().items={provider:{type:child?'Series':type,tmdbId:'42'}};h.api.rebuildSets();
 }
 if(boundary==='rules'){
  h.api.getHiddenData().items.extra={itemId:'unrelated',type:'Movie'};h.api.rebuildSets();
 }
 h.api.filterNativeCards();await h.settle();
 assert.equal(h.document.querySelector('.card'),card,'exact node retained across the boundary');
 assert.ok(h.reads.length>reads,'expired negative identity is read again');
 assert.equal(card.classList.contains('je-hidden'),true,'ordinary scan applies arriving metadata');
});
for(const stage of ['pending','failed'])for(const field of ['SeriesId','ProviderIds'])test(`${stage} ${field} identity work keeps ownership and backoff across view and rules`,async t=>{
 const gate=deferred();let onView,attempts=0,fail=true;
 const h=setup(t,o=>{if(new URL(o.url).searchParams.get('Fields')===field){attempts++;if(fail){if(stage==='pending')return gate.promise;throw Error('503');}}return metadata(o);});
 h.JE.helpers={onViewPage:h.JE.core.navigation.onViewPage};h.api.setupNativeObserver();onView=()=>h.JE.core.navigation.replayViewShow();
 const [card]=mount(h,1);h.api.filterNativeCards();await h.settle();assert.equal(attempts,1);
 onView();h.api.getHiddenData().items.extra={itemId:'unrelated'};h.api.rebuildSets();h.api.filterNativeCards();await h.settle();
 assert.equal(attempts,1,'boundary never resets pending/failure ownership');assert.equal(card.hasAttribute('data-je-hidden-checked'),false);
 fail=false;if(stage==='pending'){gate.resolve(metadata({url:`http://jellyfin.test/Items?Ids=${field==='SeriesId'?'e0':'s0'}&Fields=${field}`}));await h.settle();}
 else h.later();
 h.api.filterNativeCards();await h.settle();assert.equal(card.classList.contains('je-hidden'),true);
});
for(const type of ['Episode','Season','Movie','Series'])test(`retained positive ${type} hide survives view restoration and expires with its rule`,async t=>{
 let onView;const child=['Episode','Season'].includes(type);const h=setup(t,o=>metadata(o));
 h.JE.helpers={onViewPage:h.JE.core.navigation.onViewPage};h.api.setupNativeObserver();onView=()=>h.JE.core.navigation.replayViewShow();
 h.api.getHiddenData().items={provider:{type:child?'Series':type,tmdbId:'42'}};h.api.rebuildSets();
 const [card]=mount(h,1,type);if(!child)card.dataset.tmdbId='42';h.api.filterNativeCards();await h.settle();assert.equal(card.classList.contains('je-hidden'),true);
 const reads=h.reads.length;onView();h.api.filterNativeCards();await h.settle();assert.equal(card.classList.contains('je-hidden'),true);assert.equal(h.reads.length,reads,'positive hide needs no view retry');
 h.api.getHiddenData().items={unrelated:{itemId:'other'}};h.api.rebuildSets();h.api.filterNativeCards();await h.settle();
 assert.equal(h.document.querySelector('.card'),card);assert.equal(card.classList.contains('je-hidden'),false,'ordinary scan re-decides after Unhide');
});
for(const field of ['SeriesId','ProviderIds'])test(`a missing ${field} answer completing after view restoration cannot finalize the incoming view`,async t=>{
 const gate=deferred();let arrived=false,onView;
 const h=setup(t,o=>{const u=new URL(o.url);if(!arrived&&u.searchParams.get('Fields')===field)return gate.promise;return metadata(o);});
 h.JE.helpers={onViewPage:h.JE.core.navigation.onViewPage};h.api.setupNativeObserver();onView=()=>h.JE.core.navigation.replayViewShow();
 const [card]=mount(h,1);h.api.filterNativeCards();await h.settle();onView();arrived=true;
 gate.resolve({Items:[{Id:field==='SeriesId'?'e0':'s0',Type:'Series',ProviderIds:{}}]});await h.settle();
 h.api.filterNativeCards();await h.settle();assert.equal(card.classList.contains('je-hidden'),true);assert.equal(h.document.querySelector('.card'),card);
});
for(const type of ['Episode','Season'])test(`retained ${type} successful missing-parent verdict expires on view restoration`,async t=>{
 let arrived=false,onView;const h=setup(t,o=>new URL(o.url).searchParams.get('Fields')==='SeriesId'&&!arrived?{Items:[]} :metadata(o));
 h.JE.helpers={onViewPage:h.JE.core.navigation.onViewPage};h.api.setupNativeObserver();onView=()=>h.JE.core.navigation.replayViewShow();
 const [card]=mount(h,1,type);h.api.filterNativeCards();await h.settle();assert.equal(card.hasAttribute('data-je-hidden-checked'),true);assert.equal(card.classList.contains('je-hidden'),false);
 arrived=true;onView();h.api.filterNativeCards();await h.settle();assert.equal(card.classList.contains('je-hidden'),true);assert.equal(h.document.querySelector('.card'),card);
});
test('retained cards moved between home-row scopes are re-decided by the ordinary scan',async t=>{
 const h=setup(t,o=>metadata(o));h.JE.detectCardRowSurface=card=>card.parentNode.dataset.surface;
 h.api.getHiddenData().items={scoped:{itemId:'e0',hideScope:'nextup'}};h.api.rebuildSets();
 const [card]=mount(h,1,'Movie');card.parentNode.dataset.surface='nextup';h.api.filterNativeCards();await h.settle();assert.equal(card.classList.contains('je-hidden'),true);
 card.parentNode.dataset.surface='continuewatching';h.api.filterNativeCards();await h.settle();assert.equal(card.classList.contains('je-hidden'),false);
});
for(const stage of ['pending','failed'])test(`${stage} title identity work survives view and rule boundaries without resetting backoff`,async t=>{
 const gate=deferred();let fail=true;
 const h=setup(t,()=>fail?gate.promise:{Items:[{Id:'e0',Type:'Movie',ProviderIds:{Tmdb:'42'}}]});
 h.JE.helpers={onViewPage:h.JE.core.navigation.onViewPage};h.api.setupNativeObserver();
 h.api.getHiddenData().items={provider:{type:'Movie',tmdbId:'42'}};h.api.rebuildSets();
 const [card]=mount(h,1,'Movie');h.api.filterNativeCards();await h.settle();
 if(stage==='failed'){gate.reject(Error('503'));await h.settle();}
 h.JE.core.navigation.replayViewShow();h.api.getHiddenData().items.extra={itemId:'other'};h.api.rebuildSets();h.api.filterNativeCards();await h.settle();
 assert.equal(h.reads.length,1,'view/rules retain the title identity work or its retry deadline');assert.equal(card.hasAttribute('data-je-hidden-checked'),false);
 fail=false;if(stage==='pending')gate.resolve({Items:[{Id:'e0',Type:'Movie',ProviderIds:{Tmdb:'42'}}]});else h.later();
 h.api.filterNativeCards();await h.settle();assert.equal(card.classList.contains('je-hidden'),true);assert.equal(h.document.querySelector('.card'),card);
});
