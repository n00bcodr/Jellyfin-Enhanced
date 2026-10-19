// R14: a native verdict's resolved marker is written only together with its applied effect.
// The interleaving model is generated from a table: decision path x async boundary x disturbance.
import test, {describe} from 'node:test';
import assert from 'node:assert/strict';
import {createHarness} from '../helpers/harness.mjs';

const MARK='data-je-hidden-checked';
const tick=()=>new Promise(r=>setImmediate(r));

/** The decision paths, each with its rules, its retained node and the step that starts the decision. */
const PATHS={
 direct:{rules:{d:{itemId:'e0',type:'Movie'}},type:'Movie'},
 provider:{rules:{p:{type:'Movie',tmdbId:'42'}},type:'Movie',tmdb:'42'},
 parent:{rules:{p:{type:'Series',tmdbId:'42'}},type:'Episode'},
 title:{rules:{p:{type:'Movie',tmdbId:'42'}},type:'Movie'},
 recovery:{rules:{p:{type:'Series',tmdbId:'42'}},type:'Episode',failFirst:true},
 unhide:{rules:{d:{itemId:'e0',type:'Movie'}},type:'Movie',hiddenFirst:true}
};
/** Where the disturbance lands relative to the decision: before the 1st/2nd frame, a microtask, a timer, or inside the network request. */
const BOUNDARIES=['raf1','raf2','microtask','timer','network'];
const DISTURBANCES=['none','detach','scope','eligibility','session'];
/** The table's verdict for the retained node after ordinary scans (true = hidden). */
function expected(path,disturbance){
 if(disturbance==='eligibility'||disturbance==='session')return false;
 return path!=='unhide';
}

/** Real navigation, session and Hidden Content modules; native metadata answers are the only fixture. */
function rig(t,{rules,type,tmdb,failFirst},{rows=false}={}){
 let user='a',token='a',failProviders=!!failFirst,onRequest=null;
 const h=createHarness({apiClient:{getCurrentUserId:()=>user,accessToken:()=>token,setAuthenticationInfo(next,id){token=next;user=id;},
  getUrl:(path,params)=>`http://jellyfin.test${path}${params?'?'+new URLSearchParams(params):''}`,
  ajax:async o=>{
   const hook=onRequest;onRequest=null;if(hook){await tick();hook();}
   const u=new URL(o.url),ids=u.searchParams.get('Ids').split(','),field=u.searchParams.get('Fields');
   if(field==='ProviderIds'&&failProviders)throw Error('503');
   return {Items:ids.map(Id=>field==='SeriesId'?{Id,SeriesId:'s0'}:{Id,Type:Id==='s0'?'Series':'Movie',ProviderIds:{Tmdb:'42'}})};
  }},
  JE:{t:k=>k,pluginConfig:{HiddenContentEnabled:true},userConfig:{hiddenContent:{items:structuredClone(rules),settings:{}}}}});
 t.after(()=>h.close());
 for(const m of ['core/navigation.js','core/session.js','core/session-action.js','enhanced/hiddencontent/hidden-content-data.js'])h.load(m);
 const api=h.JE.internals.hiddenContent;api.resetFromUserConfig();
 h.load('enhanced/hiddencontent/hidden-content-filter.js');h.load('enhanced/hiddencontent/hidden-content-buttons.js');
 api.debouncedSave=()=>{};
 h.JE.helpers={onViewPage:h.JE.core.navigation.onViewPage};api.setupNativeObserver();
 const tag=rows?'div class="listItem"':'div class="card"';
 h.document.body.innerHTML=`<div class="section" id="view"><${tag} data-id="e0" data-type="${type}"${tmdb?` data-tmdb-id="${tmdb}"`:''}></div></div>`;
 const view=h.document.getElementById('view'),node=view.firstElementChild;
 const raf=h.window.requestAnimationFrame.bind(h.window);
 const nav=hash=>{h.window.location.hash=hash;h.JE.core.navigation.replayViewShow();};
 // The invariant, observed after every synchronous step: a current marker records exactly the applied effect.
 const violations=[];
 const resolved=n=>api.nativeDecisionResolved?api.nativeDecisionResolved(n):
  n.hasAttribute(MARK)&&n.getAttribute(MARK).split(':')[0]===String(api.getRulesGeneration());
 const check=()=>{if(resolved(node)&&node.getAttribute(MARK).endsWith(':hide')!==node.classList.contains('je-hidden'))
  violations.push(`${node.getAttribute(MARK)} with je-hidden=${node.classList.contains('je-hidden')} connected=${node.isConnected}`);};
 const observer=new h.window.MutationObserver(check);observer.observe(node,{attributes:true,attributeFilter:['class',MARK]});
 t.after(()=>observer.disconnect());
 return {h,api,node,view,nav,violations,check,
  /** Frames and tasks flushed without passing through the test's frame hook. */
  async settle(){for(let n=0;n<6;n++){await tick();await new Promise(r=>raf(r));}},
  later(){const now=h.window.Date.now;h.window.Date.now=()=>now()+31000;},
  succeedProviders(){failProviders=false;},
  onRequest(fn){onRequest=fn;},
  switchUser(){h.window.ApiClient.setAuthenticationInfo('b','b');h.JE.session?.checkNow?.('test');
   h.JE.userConfig={hiddenContent:{items:{},settings:{}}};api.resetFromUserConfig();}};
}

/** Each disturbance: phase one at the boundary, phase two (if any) once the interrupted work has drained. */
function disturbance(r,kind){
 switch(kind){
  case 'detach':return [()=>{r.node.remove();r.nav('#!/other');},()=>{r.view.append(r.node);r.nav('#!/home');}];
  case 'scope':return [()=>{r.api.getHiddenData().items.extra={itemId:'unrelated'};r.api.rebuildSets();r.nav('#!/home');}];
  case 'eligibility':return [()=>r.api.updateSettings({filterLibrary:false})];
  case 'session':return [()=>r.switchUser()];
  default:return [()=>{}];
 }
}

/** Runs one generated cell and returns the observations the table is checked against. */
async function runCell(t,path,boundary,kind){
 const spec=PATHS[path];const r=rig(t,spec);const {h,api}=r;
 if(spec.hiddenFirst||spec.failFirst){api.filterNativeCards();await r.settle();}
 if(spec.hiddenFirst)assert.equal(r.node.classList.contains('je-hidden'),true,'precondition: hidden and resolved');
 if(spec.failFirst){r.later();r.succeedProviders();}
 const [first,second]=disturbance(r,kind);let fired=false;
 const fire=()=>{if(!fired){fired=true;first();}};
 if(boundary.startsWith('raf')){
  // Production frames go through this hook; the settle helper uses the original scheduler.
  const raf=h.window.requestAnimationFrame.bind(h.window);let frames=0;const want=boundary==='raf1'?1:2;
  h.window.requestAnimationFrame=cb=>{const n=++frames;return raf(ts=>{if(n===want)fire();cb(ts);});};
 }
 if(boundary==='network')r.onRequest(fire);
 const trigger=()=>spec.hiddenFirst?api.unhideItem('e0'):api.filterNativeCards();
 trigger();
 if(boundary==='microtask')h.window.queueMicrotask(fire);
 if(boundary==='timer')h.window.setTimeout(fire,0);
 await r.settle();
 const postSettle=!fired;fire();await r.settle();
 if(second){second();await r.settle();}
 r.later();
 for(let n=0;n<2;n++){api.filterNativeCards();await r.settle();}
 r.check();
 return {r,postSettle};
}

// The three-scenario regression for D46-R13-B1: a detach rejects the deferred paint; the node must stay unresolved.
for(const rows of [false,true])test(`a ${rows?'list row':'card'} detached before its paint is decided again when navigation reattaches it`,async t=>{
 const r=rig(t,PATHS.provider,{rows});const raf=r.h.window.requestAnimationFrame.bind(r.h.window);let first=true;
 r.h.window.requestAnimationFrame=cb=>raf(ts=>{if(first){first=false;r.node.remove();r.nav('#!/other');}cb(ts);});
 r.api.filterNativeCards();await r.settle();
 assert.equal(r.node.hasAttribute(MARK),false,'a rejected paint leaves no resolved marker');
 r.view.append(r.node);r.nav('#!/home');await r.settle();r.api.filterNativeCards();await r.settle();
 assert.equal(r.h.document.getElementById('view').firstElementChild,r.node,'exact retained node');
 assert.equal(r.node.classList.contains('je-hidden'),true,'the ordinary scan after return hides the title');
 assert.ok(r.node.getAttribute(MARK)?.endsWith(':hide'));
 assert.deepEqual(r.violations,[]);
});

// The generated model. Each cell: retained node, real production trigger, disturbance at the boundary, ordinary scans.
const rows=[];
for(const path of Object.keys(PATHS))for(const boundary of BOUNDARIES)for(const kind of DISTURBANCES)rows.push({path,boundary,kind,want:expected(path,kind)});
describe('generated marker/effect interleavings',{concurrency:8},()=>{
 for(const {path,boundary,kind,want} of rows)test(`${path} x ${boundary} x ${kind} -> ${want?'hidden':'visible'}`,async t=>{
  const {r}=await runCell(t,path,boundary,kind);
  assert.equal(r.node.isConnected,true,'exact retained node is attached');
  assert.deepEqual(r.violations,[],'a resolved marker never records an effect that is not applied');
  assert.equal(r.node.classList.contains('je-hidden'),want,'verdict from the table');
  assert.equal(r.node.hasAttribute(MARK),true,'ordinary scans resolve the retained node');
  assert.equal(r.node.getAttribute(MARK).endsWith(':hide'),want,'the marker records the applied verdict');
 });
});
test('the generated table covers every path, boundary and disturbance',()=>{
 assert.equal(rows.length,Object.keys(PATHS).length*BOUNDARIES.length*DISTURBANCES.length);
 assert.equal(rows.length,150);
});
