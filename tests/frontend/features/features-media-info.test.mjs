import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHarness,deferred} from '../helpers/harness.mjs';
function setup(t,request=async()=>({size:1073741824,progress:50,totalPlaybackTicks:600000000,totalRuntimeTicks:1200000000})){
 const calls=[],saved=[],handlers=[],maps=[];let epoch=0;const h=createHarness({html:'<div id="info" class="hide"></div>',globals:{requestAnimationFrame:fn=>{fn();return 1;}},JE:{currentSettings:{},t:key=>key,saveUserSettings:async(file,data)=>saved.push([file,{...data}]),core:{api:{plugin:(...args)=>{calls.push(args);return request(...args);}}},session:{getEpoch:()=>epoch,isCurrent:e=>e===epoch,onUserChange:(key,fn)=>handlers.push(fn)}}});
 // Every Map the module creates, so a test can check what its caches hold on to.
 const BaseMap=h.window.Map;h.window.Map=class extends BaseMap{constructor(...args){super(...args);maps.push(this);}};
 t.after(()=>h.close());h.load('enhanced/itemdetails/features-details-media-info.js');return {...h,calls,saved,api:h.JE.internals.features,container:h.document.getElementById('info'),async settle(){await new Promise(done=>setImmediate(done));},switchUser(){epoch++;for(const fn of handlers)fn();},
  /** Whether a value in any of the module's maps refers to `target`. */
  retains(target){return maps.some(map=>[...map.values()].some(value=>value===target||(value&&typeof value==='object'&&Object.values(value).includes(target))));}};
}
test('watch progress and file-size chips share request and deduplicate repeated rendering',async t=>{
 const h=setup(t);h.api.displayWatchProgress('item',h.container);h.api.displayItemSize('item',h.container);h.api.displayWatchProgress('item',h.container);h.api.displayItemSize('item',h.container);await h.settle();
 assert.equal(h.calls.length,1);assert.equal(h.container.classList.contains('hide'),false);assert.equal(h.container.children.length,2);assert.match(h.container.textContent,/50%/);assert.match(h.container.textContent,/1.*GB/);
});
test('watch progress cycles percentage/time/remaining and persists preference',async t=>{
 const h=setup(t);h.api.displayWatchProgress('item',h.container);await h.settle();const chip=h.container.firstChild;
 chip.click();assert.equal(h.JE.currentSettings.watchProgressMode,'time');assert.match(chip.textContent,/1m.*2m/);chip.click();assert.equal(h.JE.currentSettings.watchProgressMode,'remaining');assert.match(chip.textContent,/-1m/);chip.click();assert.equal(h.JE.currentSettings.watchProgressMode,'percentage');assert.equal(h.saved.length,3);
});
test('file-size cache distinguishes media source and failure keeps unavailable chip',async t=>{
 let fail=false;const h=setup(t,async()=>{if(fail)throw new Error('offline');return {size:100};});h.api.displayItemSize('item',h.container,'first');await h.settle();h.api.displayItemSize('item',h.container,'second');await h.settle();assert.equal(h.calls.length,2);assert.match(h.calls[1][0],/mediaSourceId=second/);
 fail=true;h.expectConsoleError(/Error fetching item size/);h.api.displayItemSize('other',h.container);await h.settle();assert.match(h.container.textContent,/-/);
});
test('old-user watch progress cannot repopulate cache after user switch',async t=>{
 const pending=deferred();let first=true;const h=setup(t,()=>{if(first){first=false;return pending.promise;}return Promise.resolve({progress:10});});h.api.displayWatchProgress('item',h.container);h.switchUser();pending.resolve({progress:99});await h.settle();h.container.replaceChildren();h.api.displayWatchProgress('item',h.container);await h.settle();assert.equal(h.calls.length,2);assert.match(h.container.textContent,/10%/);assert.doesNotMatch(h.container.textContent,/99/);
});
test('old-user file-size result cannot repopulate cache after user switch',async t=>{
 const pending=deferred();let first=true;const h=setup(t,()=>{if(first){first=false;return pending.promise;}return Promise.resolve({size:1024});});h.api.displayItemSize('item',h.container);h.switchUser();pending.resolve({size:1073741824});await h.settle();h.container.replaceChildren();h.api.displayItemSize('item',h.container);await h.settle();assert.equal(h.calls.length,2);assert.match(h.container.textContent,/1.*KB/);
});
test('audio language projection deduplicates tracks, omits undetermined and non-audio streams',async t=>{
 const h=setup(t);h.JE.cdn={flagSvg:code=>`/flags/${code}.svg`};h.load('core/media-language.js');h.window.ApiClient.ajax=async()=>({Items:[{Type:'Movie',MediaStreams:[{Type:'Audio',Language:'en-US'},{Type:'Audio',Language:'en-US'},{Type:'Audio',Language:'und'},{Type:'Subtitle',Language:'fr'}]}]});
 h.api.displayAudioLanguages('item',h.container);await h.settle();const languages=h.container.querySelectorAll('.audio-language-item');assert.equal(languages.length,1);assert.equal(languages[0].dataset.lang,'en-US');
});
test('audio language selected native source fallback excludes other versions',async t=>{
 const h=setup(t);h.JE.cdn={flagSvg:code=>`/flags/${code}.svg`};h.load('core/media-language.js');h.window.ApiClient.ajax=async()=>{throw new Error('not available');};h.window.ApiClient.getItem=async()=>({Type:'Movie',MediaSources:[{Id:'a',MediaStreams:[{Type:'Audio',Language:'en'}]},{Id:'b',MediaStreams:[{Type:'Audio',Language:'fr'}]}]});
 h.api.displayAudioLanguages('item',h.container,'b');await h.settle();assert.deepEqual(Array.from(h.container.querySelectorAll('.audio-language-item'),e=>e.dataset.lang),['fr']);
});
test('old-user audio languages cannot repopulate cache after user switch',async t=>{
 const h=setup(t);h.JE.cdn={flagSvg:code=>`/flags/${code}.svg`};h.load('core/media-language.js');const pending=deferred();let calls=0;h.window.ApiClient.ajax=()=>{calls++;return calls===1?pending.promise:Promise.resolve({Items:[{Type:'Movie',MediaStreams:[{Type:'Audio',Language:'fr'}]}]});};
 h.api.displayAudioLanguages('item',h.container);h.switchUser();pending.resolve({Items:[{Type:'Movie',MediaStreams:[{Type:'Audio',Language:'en'}]}]});await h.settle();h.container.replaceChildren();h.api.displayAudioLanguages('item',h.container);await h.settle();assert.equal(calls,2);assert.deepEqual(Array.from(h.container.querySelectorAll('.audio-language-item'),e=>e.dataset.lang),['fr']);
});
// Details-visit prefetch (features-details-page.js starts it once the item is known).
const stats=(progress,size)=>({size,progress,totalPlaybackTicks:600000000,totalRuntimeTicks:1200000000});
test('chips take over a visit prefetch: one request, the same chips as without it',async t=>{
 const without=setup(t);without.api.displayWatchProgress('item',without.container,'src');without.api.displayItemSize('item',without.container,'src');await without.settle();
 const h=setup(t);const visit={};h.api.prefetchItemStats('item','src',{watchProgress:true,fileSize:true},visit);
 assert.equal(h.calls.length,1);assert.match(h.calls[0][0],/^\/item-stats\/user-a\/item\?mediaSourceId=src$/);assert.equal(h.calls[0][1].skipRetry,true);assert.ok(h.calls[0][1].signal);
 h.api.displayWatchProgress('item',h.container,'src');h.api.displayItemSize('item',h.container,'src');await h.settle();
 assert.equal(h.calls.length,1);assert.equal(h.container.innerHTML,without.container.innerHTML);
 assert.deepEqual(without.calls.map(([path])=>path),h.calls.map(([path])=>path));
});
test('a prefetch is only made when an enabled chip would request',async t=>{
 const h=setup(t);h.api.displayWatchProgress('item',h.container);h.api.displayItemSize('item',h.container);await h.settle();assert.equal(h.calls.length,1);
 h.api.prefetchItemStats('item',null,{watchProgress:true,fileSize:true},{});assert.equal(h.calls.length,1,'fresh chip caches: no prefetch');
 const p=setup(t);p.api.displayWatchProgress('item',p.container);await p.settle();assert.equal(p.calls.length,1);
 p.api.prefetchItemStats('item',null,{watchProgress:true,fileSize:false},{});assert.equal(p.calls.length,1,'sizes off and progress cached: no prefetch');
 p.api.prefetchItemStats('item','other',{watchProgress:true,fileSize:true},{});assert.equal(p.calls.length,2,'that source has no cached size');
 let fail=true;const f=setup(t,async()=>{if(fail)throw new Error('offline');return stats(1,1);});f.expectConsoleError(/Error fetching watch progress/);f.expectConsoleError(/Error fetching item size/);
 f.api.displayWatchProgress('item',f.container);f.api.displayItemSize('item',f.container);await f.settle();fail=false;
 f.api.prefetchItemStats('item',null,{watchProgress:true,fileSize:true},{});assert.equal(f.calls.length,1,'both chips cached the failure for an hour: no prefetch');
});
test('a prefetch that failed before the chips is never shown: they request again',async t=>{
 let n=0;const h=setup(t,async()=>{if(++n===1)throw new Error('busy');return stats(30,2048);});const visit={};
 h.api.prefetchItemStats('item',null,{watchProgress:true,fileSize:true},visit);await h.settle();
 h.api.displayWatchProgress('item',h.container);h.api.displayItemSize('item',h.container);await h.settle();
 assert.equal(h.calls.length,2);assert.match(h.container.textContent,/30%/);assert.match(h.container.textContent,/2 KB/);
});
test('a prefetch that fails after the chips took it over is retried once for both chips',async t=>{
 const first=deferred();let n=0;const h=setup(t,()=>++n===1?first.promise:Promise.resolve(stats(40,4096)));
 h.api.prefetchItemStats('item',null,{watchProgress:true,fileSize:true},{});h.api.displayWatchProgress('item',h.container);h.api.displayItemSize('item',h.container);
 first.reject(new Error('busy'));await h.settle();
 assert.equal(h.calls.length,2);assert.equal(h.calls[1][1].signal,undefined);assert.match(h.container.textContent,/40%/);assert.match(h.container.textContent,/4 KB/);
});
test('a visit drops its unclaimed prefetch, aborting it while queued; a claimed one survives',async t=>{
 const queued=deferred();let n=0;const h=setup(t,()=>++n===1?queued.promise:Promise.resolve(stats(50,1024)));const visit={};
 h.api.prefetchItemStats('item',null,{watchProgress:true,fileSize:true},visit);h.api.discardItemStatsPrefetch(visit);
 assert.equal(h.calls[0][1].signal.aborted,true);queued.reject(Object.assign(new Error('aborted'),{name:'AbortError'}));
 h.api.displayWatchProgress('item',h.container);await h.settle();assert.equal(h.calls.length,2,'the chip asks again after the discard');
 const done=setup(t);done.api.prefetchItemStats('item',null,{watchProgress:true,fileSize:true},visit);await done.settle();done.api.discardItemStatsPrefetch(visit);
 done.api.displayItemSize('item',done.container);await done.settle();assert.equal(done.calls.length,2,'an answered but unused prefetch is not reused');
 const pending=deferred();const kept=setup(t,()=>pending.promise);kept.api.prefetchItemStats('item',null,{watchProgress:true,fileSize:true},visit);
 kept.api.displayWatchProgress('item',kept.container);kept.api.discardItemStatsPrefetch(visit);assert.equal(kept.calls[0][1].signal.aborted,false);
 pending.resolve(stats(70,1024));await kept.settle();kept.api.displayItemSize('item',kept.container);await kept.settle();
 assert.equal(kept.calls.length,1);assert.match(kept.container.textContent,/70%/);assert.match(kept.container.textContent,/1 KB/);
});
test('a user switch aborts an unclaimed prefetch; its late answer is neither shown nor cached',async t=>{
 const old=deferred();let n=0;const h=setup(t,()=>++n===1?old.promise:Promise.resolve(stats(10,1024)));
 h.api.prefetchItemStats('item',null,{watchProgress:true,fileSize:true},{});h.switchUser();assert.equal(h.calls[0][1].signal.aborted,true);
 h.api.displayWatchProgress('item',h.container);old.resolve(stats(99,1073741824));await h.settle();
 assert.equal(h.calls.length,2);assert.match(h.container.textContent,/10%/);assert.doesNotMatch(h.container.textContent,/99/);
});
test('a chip that took over a prefetch does not retry it after a user switch',async t=>{
 const first=deferred();const h=setup(t,()=>first.promise);
 h.api.prefetchItemStats('item',null,{watchProgress:false,fileSize:true},{});h.api.displayItemSize('item',h.container);h.switchUser();
 first.reject(new Error('signed out'));await h.settle();assert.equal(h.calls.length,1);assert.match(h.container.textContent,/\.\.\./);
});
test('a prefetch the chips took over lets go of its visit, which holds the view and the item',async t=>{
 const h=setup(t);const visit={itemId:'item',view:h.container,item:{Id:'item',Type:'Movie'}};
 h.api.prefetchItemStats('item',null,{watchProgress:true,fileSize:true},visit);
 assert.equal(h.retains(visit),true,'kept while no chip has taken it over, so the visit can drop it');
 h.api.displayWatchProgress('item',h.container);assert.equal(h.retains(visit),false);
 h.api.displayItemSize('item',h.container);await h.settle();
 assert.equal(h.calls.length,1);assert.equal(h.retains(visit),false);assert.match(h.container.textContent,/50%/);assert.match(h.container.textContent,/1 GB/);
 // Its visit ending changes nothing: the answer stays for the next chip, as before.
 h.api.discardItemStatsPrefetch(visit);h.container.replaceChildren();h.api.displayItemSize('item',h.container,null);await h.settle();
 assert.equal(h.calls.length,1);assert.match(h.container.textContent,/1 GB/);
});
