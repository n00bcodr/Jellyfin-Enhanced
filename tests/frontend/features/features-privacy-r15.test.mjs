// R15: native-card visibility has one writer. Every other path (button repaint, deliberate hide callbacks, Unhide
// recovery, the disable path, the session reset) only requests a re-decision, and the one writer uses every rule.
// Model: writer x retained node x ordinary scan; an observer checks every class change against the full rule set.
import test, {describe} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHarness} from '../helpers/harness.mjs';
import {hiddenContentStore} from '../helpers/hidden-store.mjs';

const MARK='data-je-hidden-checked';
const tick=()=>new Promise(r=>setImmediate(r));
const RULES={
 'legacy-id':{d:{itemId:'e0',type:'Movie'}},
 provider:{p:{type:'Movie',tmdbId:'42'}},
 both:{d:{itemId:'e0',type:'Movie'},p:{type:'Movie',tmdbId:'42'}},
 none:{}
};
/** The retained node each writer acts on: a request-surface card with a title control, a library card, an ID-only card, a Next Up episode. */
const NODES={
 title:'<div id="similarCollapsible"><div class="card" data-id="e0" data-type="Movie" data-tmdb-id="42"><div class="cardBox"></div><div class="cardText">Entry</div></div></div>',
 library:'<div class="section" id="view"><div class="card" data-id="e0" data-type="Movie" data-tmdb-id="42"><div class="cardBox"></div><div class="cardText">Entry</div></div></div>',
 idonly:'<div class="section" id="view"><div class="card" data-id="e0" data-type="Movie"><div class="cardBox"></div><div class="cardText">Entry</div></div></div>',
 nextup:'<div class="section" id="view"><h2>Next Up</h2><div class="card" data-id="e0" data-type="Episode"><div class="cardBox"></div><div class="cardText">Entry</div></div></div>'
};

function rig(t,{rules,node,settings={}}){
 let user='a',token='a';const writes=[];
 const h=createHarness({apiClient:{getCurrentUserId:()=>user,accessToken:()=>token,setAuthenticationInfo(next,id){token=next;user=id;},
  getUrl:(path,params)=>`http://jellyfin.test${path}${params?'?'+new URLSearchParams(params):''}`,
  ajax:async o=>{
   const u=new URL(o.url);
   if(u.pathname.includes('/hidden-content/rule/')){writes.push(o);return {success:true};}
   const ids=(u.searchParams.get('Ids')||'').split(',').filter(Boolean),field=u.searchParams.get('Fields');
   return {Items:ids.map(Id=>field==='SeriesId'?{Id,SeriesId:'s0'}:{Id,Type:Id==='s0'?'Series':'Movie'})};
  }},
  JE:{t:k=>k,pluginConfig:{HiddenContentEnabled:true},userConfig:{hiddenContent:{items:structuredClone(rules),
   settings:{showHideConfirmation:false,showButtonLibrary:true,...settings}}}}});
 t.after(()=>h.close());
 for(const m of ['core/navigation.js','core/session.js','core/session-action.js','enhanced/hiddencontent/hidden-content-data.js'])h.load(m);
 const api=h.JE.internals.hiddenContent;api.persist=hiddenContentStore(h).persist;api.resetFromUserConfig();
 h.load('enhanced/hiddencontent/hidden-content-filter.js');h.load('enhanced/hiddencontent/hidden-content-dialogs.js');h.load('enhanced/hiddencontent/hidden-content-buttons.js');
 api.debouncedSave=()=>{};
 h.document.body.innerHTML=NODES[node];
 const card=h.document.querySelector('.card');
 h.JE.helpers={onViewPage:h.JE.core.navigation.onViewPage,getItemCached:async id=>({Id:id,Type:card.dataset.type,SeriesId:'s0',Name:'Entry'})};
 api.setupNativeObserver();
 const raf=h.window.requestAnimationFrame.bind(h.window);
 const surface=()=>api.getCardSurface(card)||api.getCurrentNativeSurface();
 /** The full rule set's verdict for the node right now (item ID, provider, scope, surface and enable switches). */
 const oracle=()=>api.getSettings().enabled&&h.JE.pluginConfig.HiddenContentEnabled!==false&&api.shouldFilterSurface(surface())&&
  api.isHiddenOnSurface('e0',surface(),{type:card.dataset.type,tmdbId:card.dataset.tmdbId});
 const violations=[];
 const check=()=>{
  const shown=card.classList.contains('je-hidden'),want=oracle();
  if(shown!==want)violations.push(`je-hidden=${shown} while every rule says ${want?'hidden':'visible'}`);
  if(api.nativeDecisionResolved(card)&&card.getAttribute(MARK).endsWith(':hide')!==shown)violations.push(`marker ${card.getAttribute(MARK)} with je-hidden=${shown}`);
 };
 const observer=new h.window.MutationObserver(records=>{if(records.some(r=>r.attributeName==='class'&&r.oldValue?.includes('je-hidden')!==card.classList.contains('je-hidden')))check();});
 observer.observe(card,{attributes:true,attributeFilter:['class'],attributeOldValue:true});
 t.after(()=>observer.disconnect());
 return {h,api,card,writes,violations,check,oracle,
  async settle(){for(let n=0;n<8;n++){await tick();await new Promise(r=>raf(r));}},
  later(){const now=h.window.Date.now;h.window.Date.now=()=>now()+31000;},
  async click(){await h.viewerPress(card.querySelector('.je-hide-btn'));},
  switchUser(nextRules){h.window.ApiClient.setAuthenticationInfo('b','b');
   h.JE.userConfig={hiddenContent:{items:structuredClone(nextRules),settings:{showHideConfirmation:false,showButtonLibrary:true}}};
   h.JE.session?.checkNow?.('test');h.document.dispatchEvent(new h.window.Event('je:user-data-loaded'));}};
}

/** Every writer that touched native visibility before this round, with its node, rule variants, action and the table's verdict. */
const WRITERS={
 'button-rescan':{node:'title',rules:['legacy-id','provider','both','none'],act:r=>r.api.addLibraryHideButtons(),want:rules=>rules!=='none'},
 'emit-change':{node:'title',rules:['legacy-id','provider','both','none'],
  act:r=>{r.api.getHiddenData().items.extra={itemId:'unrelated'};r.api.rebuildSets();r.api.emitChange();},want:rules=>rules!=='none'},
 'library-rescan':{node:'library',rules:['legacy-id','provider','both','none'],act:r=>r.api.addLibraryHideButtons(),want:rules=>rules!=='none'},
 'title-confirm':{node:'library',rules:['none'],act:r=>r.click(),want:()=>true},
 'confirm-hide':{node:'idonly',rules:['none'],act:r=>r.click(),want:()=>true},
 'scoped-off':{node:'nextup',rules:['none'],settings:{filterNextUp:false},
  act:async r=>{await r.click();r.h.document.querySelector('.je-hide-confirm-overlay .je-hide-confirm-hide').click();},want:()=>false},
 'scoped-on':{node:'nextup',rules:['none'],
  act:async r=>{await r.click();r.h.document.querySelector('.je-hide-confirm-overlay .je-hide-confirm-hide').click();},want:()=>true},
 restore:{node:'library',rules:['legacy-id','provider','both'],extra:true,act:r=>r.api.unhideItem('x1'),want:()=>true},
 inactive:{node:'library',rules:['legacy-id','provider'],act:r=>r.api.updateSettings({enabled:false}),want:()=>false},
 session:{node:'title',rules:['legacy-id','provider'],act:(r,rules)=>r.switchUser(RULES[rules]),want:()=>true}
};

async function runCell(t,writer,rules){
 const spec=WRITERS[writer];
 const items={...RULES[rules],...(spec.extra?{x:{itemId:'x1'}}:{})};
 const r=rig(t,{rules:items,node:spec.node,settings:spec.settings});
 // Production order: the mutation mounts the controls at once; the debounced scan decides the node.
 r.api.addLibraryHideButtons();r.api.filterNativeCards();await r.settle();
 assert.equal(r.card.classList.contains('je-hidden'),r.oracle(),'precondition: the scan decided the node by every rule');
 await spec.act(r,rules);await r.settle();
 // Ordinary scans only, on the exact retained node.
 r.later();for(let n=0;n<2;n++){r.api.filterNativeCards();await r.settle();}
 r.check();
 return r;
}

const rows=[];
for(const [writer,spec] of Object.entries(WRITERS))for(const rules of spec.rules)rows.push({writer,rules,want:spec.want(rules)});
describe('every visibility writer x retained node x ordinary scan',{concurrency:8},()=>{
 for(const {writer,rules,want} of rows)test(`${writer} x ${rules} -> ${want?'hidden':'visible'}`,async t=>{
  const r=await runCell(t,writer,rules);
  assert.deepEqual(r.violations,[],'no write disagrees with the full rule set, and a resolved marker records the applied effect');
  assert.equal(r.card.classList.contains('je-hidden'),want,'verdict from the table');
  assert.equal(r.card.isConnected,true,'exact retained node');
 });
});

// D46-R14-B1: a button rescan after a legacy item-ID hide must not reveal the title; ordinary scans keep it hidden.
test('a button rescan after a legacy item-ID hide keeps the title hidden through ordinary scans',async t=>{
 const r=rig(t,{rules:RULES['legacy-id'],node:'title'});
 r.api.addLibraryHideButtons();r.api.filterNativeCards();await r.settle();
 assert.equal(r.card.classList.contains('je-hidden'),true);assert.ok(r.card.getAttribute(MARK)?.endsWith(':hide'));
 assert.ok(r.card.querySelector('[data-je-title-key]'),'the title control is mounted on the native card');
 r.api.addLibraryHideButtons();await r.settle();
 for(let n=0;n<2;n++){r.api.filterNativeCards();await r.settle();}
 assert.equal(r.card.classList.contains('je-hidden'),true,'still hidden after the repaint and ordinary scans');
 assert.deepEqual(r.violations,[]);
});

// Inventory: in Hidden Content and Spoiler Guard sources, je-hidden on a native node is written only by applyNativeDecision.
test('je-hidden writers: only the filter writer touches native nodes; other writers are JE-owned cards',()=>{
 const root=new URL('../../../Jellyfin.Plugin.JellyfinEnhanced/js/enhanced/',import.meta.url);
 const files=['hiddencontent/hidden-content-filter.js','hiddencontent/hidden-content-buttons.js','hiddencontent/hidden-content-data.js',
  'hiddencontent/hidden-content-dialogs.js','spoilerguard/state.js','spoilerguard/detail-button.js','spoilerguard/seerr-toggle.js','spoilerguard/dialog.js'];
 const writes=[];
 for(const f of files){const src=readFileSync(new URL(f,root),'utf8');
  src.split('\n').forEach((line,i)=>{if(/classList\.(toggle|add|remove)\(\s*'je-hidden'/.test(line))writes.push(`${f}:${i+1}: ${line.trim()}`);});}
 const native=writes.filter(w=>!w.includes('jeOwnedCard'));
 assert.equal(native.length,1,writes.join('\n'));
 assert.match(native[0],/hidden-content-filter\.js:.*card\.classList\.toggle\('je-hidden', hidden\)/);
});

test('the writer table covers every writer that existed before the single-writer rule',()=>{
 assert.deepEqual(Object.keys(WRITERS).sort(),['button-rescan','confirm-hide','emit-change','inactive','library-rescan','restore','scoped-off','scoped-on','session','title-confirm']);
 assert.equal(rows.length,23);
});
