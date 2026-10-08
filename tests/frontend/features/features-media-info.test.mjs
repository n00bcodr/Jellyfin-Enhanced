import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHarness,deferred} from '../helpers/harness.mjs';
function setup(t,request=async()=>({size:1073741824,progress:50,totalPlaybackTicks:600000000,totalRuntimeTicks:1200000000})){
 const calls=[],saved=[],handlers=[];let epoch=0;const h=createHarness({html:'<div id="info" class="hide"></div>',globals:{requestAnimationFrame:fn=>{fn();return 1;}},JE:{currentSettings:{},t:key=>key,saveUserSettings:async(file,data)=>saved.push([file,{...data}]),core:{api:{plugin:(...args)=>{calls.push(args);return request(...args);}}},session:{getEpoch:()=>epoch,isCurrent:e=>e===epoch,onUserChange:(key,fn)=>handlers.push(fn)}}});
 t.after(()=>h.close());h.load('enhanced/itemdetails/features-details-media-info.js');return {...h,calls,saved,api:h.JE.internals.features,container:h.document.getElementById('info'),async settle(){await new Promise(done=>setImmediate(done));},switchUser(){epoch++;for(const fn of handlers)fn();}};
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
