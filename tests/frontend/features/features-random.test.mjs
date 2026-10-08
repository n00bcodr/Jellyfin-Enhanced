import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHarness,deferred} from '../helpers/harness.mjs';
function setup(t,{settings={},ajax=async()=>({Items:[{Id:'picked',Type:'Movie'}]}),getItem=async()=>null}={}){
 const paths=[],toasts=[],timers=[],intervals=new Set();const h=createHarness({html:'<div id="tray"></div>',apiClient:{ajax:options=>{paths.push(options.url);return ajax(options);},getItem},globals:{setInterval:fn=>{intervals.add(fn);return fn;},clearInterval:fn=>intervals.delete(fn),setTimeout:fn=>{timers.push(fn);return fn;}},JE:{currentSettings:{randomButtonEnabled:true,randomIncludeMovies:true,randomIncludeShows:true,...settings},t:key=>key,toast:text=>toasts.push(text),icon:()=>'',IconName:{ERROR:'error'},escapeHtml:text=>text,helpers:{}}});
 h.JE.helpers.getHeaderButtonTray=()=>h.document.getElementById('tray');h.load('enhanced/features-random-button.js');t.after(()=>h.close());
 return {...h,paths,toasts,intervals,async click(){h.document.getElementById('randomItemButton').click();await new Promise(done=>setImmediate(done));while(timers.length)timers.shift()();}};
}
test('random button repeated mounting stays single and disabling removes it',t=>{
 const h=setup(t);h.JE.addRandomButton();h.JE.addRandomButton();assert.equal(h.document.querySelectorAll('#randomItemButton').length,1);h.JE.currentSettings.randomButtonEnabled=false;h.JE.addRandomButton();assert.equal(h.document.querySelector('#randomItemButton'),null);
});
test('random library pick navigates to details and clears loading/animation state',async t=>{
 const h=setup(t);h.JE.addRandomButton();await h.click();assert.match(h.paths[0],/IncludeItemTypes=Movie,Series&Recursive=true/);assert.match(h.window.location.hash,/id=picked/);assert.equal(h.document.querySelector('button').disabled,false);assert.equal(h.intervals.size,0);assert.deepEqual(h.toasts,['toast_random_item_loaded']);
});
test('random pinned collection includes episodes and falls back when unwatched filter empties it',async t=>{
 const h=setup(t,{settings:{randomSourceId:'collection',randomUnwatchedOnly:true},getItem:async()=>({Id:'collection',Type:'BoxSet',Name:'Collection'}),ajax:async({url})=>url.includes('ParentId=')?{Items:[{Id:'watched',Type:'Movie',UserData:{Played:true}}]}:{Items:[{Id:'eligible',Type:'Series',UserData:{UnplayedItemCount:1}},{Id:'watched-series',Type:'Series',UserData:{UnplayedItemCount:0}}]}});
 h.JE.addRandomButton();await h.click();assert.equal(h.paths.length,2);assert.match(h.paths[0],/Movie,Series,Episode&ParentId=collection/);assert.match(h.window.location.hash,/id=eligible/);assert.deepEqual(h.toasts,['toast_random_source_empty']);
});
test('random missing pinned source falls back with a single explanatory toast',async t=>{
 const h=setup(t,{settings:{randomSourceId:'missing'},getItem:async()=>{throw new Error('404');}});h.JE.addRandomButton();await h.click();assert.match(h.window.location.hash,/id=picked/);assert.deepEqual(h.toasts,['toast_random_source_missing']);
});
test('random metadata failure restores button and stops dice timer',async t=>{
 const h=setup(t,{ajax:async()=>{throw new Error('offline');}});h.expectConsoleError(/Error fetching random item/);h.JE.addRandomButton();await h.click();assert.equal(h.document.querySelector('button').disabled,false);assert.equal(h.intervals.size,0);assert.match(h.toasts[0],/offline/);
});
