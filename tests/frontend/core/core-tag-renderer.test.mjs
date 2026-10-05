import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from '../helpers/harness.mjs';
function setup(t,config={}){
 const saved=[], renderers=new Map(), changes=new Map();let scans=0;
 const h=createHarness({html:'<div class="card"><div class="cardScalable"><div class="cardImageContainer"></div><div class="je-tag-host"></div></div></div>',JE:{currentSettings:{tags:true},pluginConfig:config,session:{getUserId:()=> 'a',getServerId:()=> 's',onUserChange:(name,fn)=>changes.set(name,fn)},_cacheManager:{register:fn=>saved.push(fn),markDirty(){}},tagPipeline:{registerRenderer:(name,r)=>renderers.set(name,r),getRenderer:name=>renderers.get(name),clearProcessed(){},scheduleScan:()=>scans++}}});
 t.after(()=>h.close());h.load('core/ui-kit.js');h.load('core/tag-renderer-base.js');
 const spec={logPrefix:'test',settingKey:'tags',containerClass:'test-overlay',taggedAttr:'jeTestTagged',styleId:'test-tag-css',buildCss:()=>'.test-overlay{color:red}',position:{userKey:'position',pluginKey:'Position',fallback:'top-right'},cache:{key:'test-v2',legacyPrefix:'test',hotBucket:'test',pruneOnSave:true},pipeline:{render(ctx,el,item){const overlay=h.document.createElement('div');overlay.className='test-overlay';overlay.innerHTML='<span></span>';ctx.commitOverlay(el,overlay);}}};
 return Object.assign(h,{spec,saved,renderers,changes,scans:()=>scans,register:()=>h.JE.core.tagRenderer.register('test',spec),host:h.document.querySelector('.je-tag-host')});
}
test('tag registration preserves enabled contract, hooks and real overlay DOM',t=>{
 const h=setup(t,{TagCacheServerMode:false});const ctx=h.register();h.register();assert.equal(h.saved.length,1);
 const r=h.renderers.get('test');assert.equal(r.isEnabled(),true);r.render(h.host,{});assert.equal(ctx.isTagged(h.host),true);assert.equal(h.host.firstElementChild.dataset.jeCorner,'top-right');
 h.host.firstElementChild.remove();assert.equal(ctx.isTagged(h.host),false,'stale tagged attribute must permit rerender');
 r.render(h.host,{});h.JE.currentSettings.tags=false;h.JE.core.tagRenderer.reinitialize('test',h.spec);
 assert.equal(h.document.querySelector('.test-overlay'),null);assert.equal(h.document.querySelector('.card').dataset.jeTestTagged,undefined);assert.equal(h.scans(),0);
 h.JE.currentSettings.tags=true;h.JE.core.tagRenderer.reinitialize('test',h.spec);assert.equal(h.scans(),1);assert.equal(h.document.querySelectorAll('#test-tag-css').length,1);
});
test('tag position resolves user then administrator then fallback',t=>{
 const h=setup(t,{Position:'bottom-left'});let p=h.JE.core.tagRenderer.resolvePosition('position','Position','top-right');assert.equal(p.bottomVal,'6px');assert.equal(p.leftVal,'6px');
 h.JE.currentSettings.position='top-right';p=h.JE.core.tagRenderer.resolvePosition('position','Position','bottom-left');assert.equal(p.needsTopRightOffset,true);
 delete h.JE.currentSettings.position;delete h.JE.pluginConfig.Position;assert.equal(h.JE.core.tagRenderer.resolvePosition('position','Position','bottom-right').pos,'bottom-right');
});
test('tag cache rejects previous-owner data and clears hot/persistent state on user change',t=>{
 const h=setup(t,{TagCacheServerMode:false});const store=h.window.localStorage;store.setItem('test-v2',JSON.stringify({secret:{owner:'previous'}}));store.setItem('test-v2:identity-owner','s:previous');
 const ctx=h.register();assert.equal(ctx.getPersistent('secret'),undefined);ctx.setPersistent('new',{timestamp:Date.now()});ctx.hot.set('new',1);h.saved[0]();assert.ok(store.getItem('test-v2').includes('new'));
 h.changes.get('tag-cache-test')({serverId:'s',userId:'b'});assert.equal(ctx.getPersistent('new'),undefined);assert.equal(ctx.hot.size,0);assert.equal(store.getItem('test-v2'),null);assert.equal(store.getItem('test-v2:identity-owner'),'s:b');
});
test('tag cache honors TTL pruning, legacy cleanup and server clear timestamp',t=>{
 const h=setup(t,{TagCacheServerMode:false,TagsCacheTtlDays:1});const store=h.window.localStorage;
 store.setItem('test-old','{}');store.setItem('test-v2:identity-owner','s:a');store.setItem('test-v2',JSON.stringify({old:{timestamp:0},fresh:{timestamp:Date.now()}}));
 const ctx=h.register();h.saved[0]();assert.equal(ctx.getPersistent('old'),undefined);assert.ok(ctx.getPersistent('fresh'));assert.equal(store.getItem('test-old'),null);
 h.JE.pluginConfig.ClearLocalStorageTimestamp=Date.now();h.register();assert.equal(ctx.getPersistent('fresh'),undefined);assert.equal(ctx.hot.size,0);
});
test('tag search/admin exclusions apply to sibling render hosts',t=>{
 const h=setup(t,{DisableTagsOnSearchPage:true});const ctx=h.register();assert.equal(ctx.shouldIgnore(h.host),false);
 const section=h.document.createElement('section');section.id='searchPage';h.document.body.append(section);section.append(h.document.querySelector('.card'));assert.equal(ctx.shouldIgnore(h.host),true);
 section.id='pluginsPage';assert.equal(ctx.shouldIgnore(h.host),true);
});
test('empty tag overlays are not committed or marked',t=>{
 const h=setup(t);const ctx=h.register();assert.equal(ctx.commitOverlay(h.host,h.document.createElement('div')),false);assert.equal(ctx.isTagged(h.host),false);
});
test('corner stacking separates top and bottom overlays and clears stale transforms',t=>{
 const h=setup(t);for(const corner of ['top-right','bottom-left'])for(let i=0;i<2;i++){const el=h.document.createElement('div');el.dataset.jeCorner=corner;el.getBoundingClientRect=()=>({top:10,bottom:30,height:20});h.host.append(el);}
 h.JE.core.tagRenderer.applyCornerStacking(h.host);assert.equal(h.host.children[1].style.transform,'translateY(24px)');assert.equal(h.host.children[3].style.transform,'translateY(-24px)');
 h.host.children[0].remove();h.JE.core.tagRenderer.applyCornerStacking(h.host);assert.equal(h.host.children[0].style.transform,'');
});
test('corrupt same-owner tag cache recovers without preventing renderer registration',t=>{
 const h=setup(t,{TagCacheServerMode:false});h.window.localStorage.setItem('test-v2:identity-owner','s:a');h.window.localStorage.setItem('test-v2','{broken');
 const ctx=h.register();assert.equal(ctx.getPersistent('anything'),undefined);assert.ok(h.renderers.get('test'));
});
