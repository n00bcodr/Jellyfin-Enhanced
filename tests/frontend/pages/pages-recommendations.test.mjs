import test from 'node:test';
import assert from 'node:assert/strict';
import {createHarness, deferred, plain} from '../helpers/harness.mjs';
function setup(t, fetch, genre = async()=>[]) {
  const h=createHarness({JE:{discoveryFilter:{fetchWithManagedRequest:fetch},jellyseerrAPI:{fetchGenreSlider:genre}}});
  t.after(()=>h.close()); h.load('jellyseerr/recommendations/recommendations-data.js');
  return {...h,P:h.JE.internals.recommendationsPage};
}
test('recommendations preserve successful categories when neighboring categories fail or are empty',async t=>{
  const calls=[]; const h=setup(t,async(path,scope,opts)=>{calls.push({path,scope,opts}); if(path.startsWith('/bad')) throw Error('offline'); return path.startsWith('/good')?{results:[{id:1}]}:{};});
  h.P.ROWS=[{path:'/good'},{path:'/bad'},{path:'/empty'}]; const controller=new AbortController();
  const rows=await h.P.fetchAllRows(controller.signal);
  assert.deepEqual(plain(rows.map(x=>x.results)),[[{id:1}],[],[]]);
  assert.equal(calls.length,3); for(const call of calls){assert.equal(call.scope,'recommendations');assert.equal(call.opts.signal,controller.signal);assert.ok(call.path.endsWith('?page=1'));}
});
test('recommendations coalesce concurrent logo fetches and separate studio/network identities',async t=>{
  const calls=[]; const pending=deferred(); const h=setup(t,path=>{calls.push(path);return pending.promise;});
  const a=h.P.fetchLogoPath('studio',10); const b=h.P.fetchLogoPath('studio',10); const c=h.P.fetchLogoPath('network',10);
  assert.deepEqual(calls,['/JellyfinEnhanced/tmdb/company/10','/JellyfinEnhanced/tmdb/network/10']);
  pending.resolve({logo_path:'/logo.png'}); assert.deepEqual(await Promise.all([a,b,c]),['/logo.png','/logo.png','/logo.png']);
  assert.equal(await h.P.fetchLogoPath('studio',10),'/logo.png');assert.equal(calls.length,2);
});
test('recommendations missing or failed logos fall back to text without rejecting',async t=>{
  const h=setup(t,async path=>{if(path.endsWith('/1')) throw Error('unavailable');return {};});
  assert.equal(await h.P.fetchLogoPath('studio',1),null);assert.equal(await h.P.fetchLogoPath('studio',2),null);
});
test('recommendation genre caches separate media types and gracefully handle failures',async t=>{
  const calls=[];const h=setup(t,async()=>({}),async type=>{calls.push(type);if(type==='tv')throw Error('offline');return [{id:1,name:'Comedy',backdrops:[]}];});
  assert.deepEqual(plain(await h.P.fetchGenreSlider('movie')),[{id:1,name:'Comedy',backdrops:[]}]);
  assert.deepEqual(plain(await h.P.fetchGenreSlider('tv')),[]);await h.P.fetchGenreSlider('movie');await h.P.fetchGenreSlider('tv');
  assert.deepEqual(calls,['movie','tv']);
});
test('recommendations standalone navigation preserves host lifecycle, prevents duplicate mounts and aborts on leave',t=>{
  const h=setup(t,async()=>({}));h.JE.pluginConfig={RecommendationsPageEnabled:true};h.JE.t=key=>key;
  h.document.body.innerHTML='<div class="mainAnimatedPages"><div id="home" class="mainAnimatedPage"></div></div>';
  const home=h.document.querySelector('#home');const events=[];home.addEventListener('viewhide',()=>events.push('hide'));home.addEventListener('viewshow',()=>events.push('show'));
  let renders=0;h.P.renderInto=container=>{renders++;container.textContent='Recommendations';};h.P.hideCategoryPage=()=>{};
  h.load('jellyseerr/recommendations/recommendations-page.js');
  h.P.showPage();h.P.showPage();assert.equal(renders,1);assert.equal(home.classList.contains('hide'),true);
  assert.equal(h.window.location.hash,'#/recommendations');assert.equal(h.document.querySelectorAll('#je-recommendations-page').length,1);
  const controller=new AbortController();h.P.state.currentAbortController=controller;h.P.hidePage();
  assert.equal(controller.signal.aborted,true);assert.equal(home.classList.contains('hide'),false);assert.deepEqual(events,['hide','show']);
  assert.equal(h.P.state.pageVisible,false);
});
test('recommendations disabled standalone page leaves current host untouched',t=>{
  const h=setup(t,async()=>({}));h.JE.pluginConfig={RecommendationsPageEnabled:false};h.JE.t=key=>key;h.P.renderInto=()=>{throw Error('must not render');};
  h.load('jellyseerr/recommendations/recommendations-page.js');h.P.showPage();assert.equal(h.document.querySelector('#je-recommendations-page'),null);
});
