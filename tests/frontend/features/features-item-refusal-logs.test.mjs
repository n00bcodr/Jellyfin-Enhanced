import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate as nextTurn} from 'node:timers/promises';
import {createHarness} from '../helpers/harness.mjs';

// A details page whose item the server refuses with an HTTP answer (a 404 for a page the viewer may
// not open, a 503) has nothing to decorate: the MDBList ratings row and the arr tag links skip it
// without logging an error. A real failure reading the item is still an error.
const REFUSED={status:404};

async function ratings(t,failure,errors=[]){
  let hook;const calls=[];
  const h=createHarness({html:'<div id="itemDetailPage"><div class="tagline"></div></div>',url:'http://jellyfin.test/web/index.html#!/details?id=item',expectedConsoleErrors:errors,
    JE:{pluginConfig:{MdblistRatingsEnabled:true,MdblistRatingsShowOnItemDetails:true},t:key=>key,cdn:{url:(_source,path)=>`https://cdn.test/${path}`},
      helpers:{getItemCached:async()=>{throw failure;},onViewPage:fn=>{hook=fn;return()=>{};}},core:{api:{plugin:async path=>{calls.push(path);return null;}}}}});
  t.after(()=>h.close());h.window.setTimeout=fn=>{queueMicrotask(fn);return 1;};h.load('others/mdblist-ratings.js');h.JE.initializeMdblistRatingsScript();
  await hook(null,h.document.querySelector('#itemDetailPage'),h.window.location.hash);await nextTurn();return {...h,get NATIVE(){return h.NATIVE;},calls};
}
test('MDBList ratings item refused by the server (HTTP 404) logs no error and leaves page usable',async t=>{
  const h=await ratings(t,REFUSED);assert.equal(h.calls.length,0);assert.equal(h.document.querySelector('.je-mdblist-ratings-section'),null);assert.ok(h.document.querySelector('.tagline'));
});
test('MDBList ratings item read failing for real is still logged as an error',async t=>{
  const h=await ratings(t,Error('boom'),[/MDBList Ratings: Error processing page/]);assert.equal(h.calls.length,0);assert.equal(h.document.querySelector('.je-mdblist-ratings-section'),null);
});

async function tagLinks(t,failure,errors=[]){
  const timers=[];let reads=0;
  const h=createHarness({html:'<div id="itemDetailPage"><div class="itemExternalLinks"></div></div>',url:'http://jellyfin.test/web/index.html#!/details?id=item',expectedConsoleErrors:errors,
    globals:{setTimeout:fn=>{timers.push(fn);return timers.length;}},
    JE:{pluginConfig:{ArrTagsShowAsLinks:true},icon:()=>'',IconName:{TAG:'tag'},
      helpers:{getItemCached:async()=>{reads++;throw failure;},debounce:fn=>fn,createObserver:()=>({disconnect(){}})},
      core:{lifecycle:{register:()=>({track:()=>{}})},navigation:{onNavigate:()=>()=>{},onViewPage:()=>()=>{}}}}});
  t.after(()=>h.close());h.load('arr/arr-tag-links.js');await h.JE.initializeArrTagLinksScript();
  // The first check on an already open details page.
  timers.shift()();await nextTurn();return {...h,get NATIVE(){return h.NATIVE;},reads:()=>reads};
}
test('arr tag links item refused by the server (HTTP 404) logs no error and adds no link',async t=>{
  const h=await tagLinks(t,REFUSED);assert.equal(h.reads(),1);assert.equal(h.document.querySelector('.arr-tag-link'),null);assert.ok(h.document.querySelector('.itemExternalLinks'));
});
test('arr tag links item read failing for real is still logged as an error',async t=>{
  const h=await tagLinks(t,Error('boom'),[/Arr Tag Links: Error adding tag links/]);assert.equal(h.reads(),1);assert.equal(h.document.querySelector('.arr-tag-link'),null);
});
