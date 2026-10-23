import test from 'node:test';
import assert from 'node:assert/strict';
import {createHarness, plain} from '../helpers/harness.mjs';
function setup(t, fetch, genre = async()=>[]) {
  const h=createHarness({JE:{discoveryFilter:{fetchWithManagedRequest:fetch},jellyseerrAPI:{fetchGenreSlider:genre}}});
  t.after(()=>h.close()); h.load('jellyseerr/recommendations/recommendations-data.js');
  return {...h,P:h.JE.internals.recommendationsPage};
}
function setupTiles(t, fetch) {
  const h=setup(t,fetch);
  h.JE.escapeHtml=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  h.load('jellyseerr/recommendations/recommendations-catalog.js');h.load('jellyseerr/recommendations/recommendations-render.js');
  return h;
}
test('recommendations preserve successful categories when neighboring categories fail or are empty',async t=>{
  const calls=[]; const h=setup(t,async(path,scope,opts)=>{calls.push({path,scope,opts}); if(path.startsWith('/bad')) throw Error('offline'); return path.startsWith('/good')?{results:[{id:1}]}:{};});
  h.P.ROWS=[{path:'/good'},{path:'/bad'},{path:'/empty'}]; const controller=new AbortController();
  const rows=await h.P.fetchAllRows(controller.signal);
  assert.deepEqual(plain(rows.map(x=>x.results)),[[{id:1}],[],[]]);
  assert.equal(calls.length,3); for(const call of calls){assert.equal(call.scope,'recommendations');assert.equal(call.opts.signal,controller.signal);assert.ok(call.path.endsWith('?page=1'));}
});
test('recommendations studio and network catalogs have unique numeric ids and TMDB logo paths',t=>{
  const h=setup(t,async()=>({}));h.load('jellyseerr/recommendations/recommendations-catalog.js');
  for(const items of [h.P.STUDIOS,h.P.NETWORKS]){
    assert.ok(items.length>0);assert.equal(new Set(items.map(item=>item.id)).size,items.length);
    for(const item of items){assert.equal(typeof item.id,'number');assert.ok(Number.isFinite(item.id));assert.match(item.logo,/^\/[A-Za-z0-9]+\.(png|svg)$/);}
  }
});
test('recommendations tiles render lazy catalog logos without requests and keep text when a logo is missing',async t=>{
  const calls=[];const h=setupTiles(t,async(...args)=>{calls.push(args);return {};});
  for(const [kind,catalog] of [['studio',h.P.STUDIOS],['network',h.P.NETWORKS]]){
    const items=[...catalog,{id:999,name:'No logo'}];const row=h.P.createTileRow(kind,items,kind);h.document.body.appendChild(row);
    const tiles=row.querySelectorAll('.je-recommendations-tile');assert.equal(tiles.length,items.length);
    catalog.forEach((item,i)=>{
      const images=tiles[i].querySelectorAll('img');assert.equal(images.length,1);const img=images[0];
      assert.equal(img.className,'je-tile-logo');assert.equal(img.src,`https://image.tmdb.org/t/p/w300${item.logo}`);assert.equal(img.loading,'lazy');
      assert.equal(tiles[i].querySelector('.je-tile-fallback-text'),null);
    });
    const textTile=tiles[tiles.length-1];assert.equal(textTile.querySelector('img'),null);assert.equal(textTile.querySelector('.je-tile-fallback-text').textContent,'No logo');
  }
  await Promise.resolve();assert.deepEqual(calls,[]);
});
test('recommendations failed logos restore fallback spans and HTML names remain text',t=>{
  const h=setupTiles(t,async()=>({}));const name='<b>x</b> & "Studio"';
  for(const kind of ['studio','network']){
    const row=h.P.createTileRow(kind,[{id:1,name,logo:'/logo.png'},{id:2,name}],kind);h.document.body.appendChild(row);
    const images=row.querySelectorAll('.je-tile-image');const img=images[0].querySelector('img.je-tile-logo');assert.ok(img);
    assert.equal(images[0].querySelector('.je-tile-fallback-text'),null);img.dispatchEvent(new h.window.Event('error'));
    for(const image of images){
      assert.equal(image.querySelector('img'),null);assert.equal(image.querySelector('b'),null);assert.equal(image.children.length,1);
      const fallback=image.querySelector('span.je-tile-fallback-text');assert.ok(fallback);assert.equal(fallback.textContent,name);
    }
  }
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
  h.load('enhanced/helpers.js');h.load('jellyseerr/recommendations/recommendations-page.js');
  h.P.showPage();h.P.showPage();assert.equal(renders,1);assert.equal(home.classList.contains('hide'),true);
  assert.equal(h.window.location.hash,'#/recommendations');assert.equal(h.document.querySelectorAll('#je-recommendations-page').length,1);
  // Jellyfin clears the backdrop on pageshow for any page that isn't a backdrop page.
  const page=h.document.querySelector('#je-recommendations-page');
  assert.equal(page.classList.contains('backdropPage'),true);assert.equal(page.classList.contains('globalBackdropPage'),true);
  assert.equal(page.getAttribute('data-backdroptype'),'movie,series,book');
  const controller=new AbortController();h.P.state.currentAbortController=controller;h.P.hidePage();
  assert.equal(controller.signal.aborted,true);assert.equal(home.classList.contains('hide'),false);assert.deepEqual(events,['hide','show']);
  assert.equal(h.P.state.pageVisible,false);
  // With Backdrops off Jellyfin strips backdropPage; reopening the reused page marks it again.
  page.classList.remove('backdropPage');h.P.showPage();
  assert.equal(page.classList.contains('backdropPage'),true);
});
test('a JE page shows the backdrop again when Jellyfin\'s Page not found page clears it after the JE page opened',t=>{
  const h=setup(t,async()=>({}));h.JE.pluginConfig={RecommendationsPageEnabled:true};h.JE.t=key=>key;
  h.document.body.innerHTML='<div class="mainAnimatedPages"><div id="home" class="mainAnimatedPage"></div><div id="fallbackPage" class="page mainAnimatedPage hide"></div></div>';
  h.P.renderInto=()=>{};h.P.hideCategoryPage=()=>{};
  h.load('enhanced/helpers.js');h.load('jellyseerr/recommendations/recommendations-page.js');
  const shows=[];h.document.addEventListener('pageshow',e=>shows.push(e.target.id));
  const fallbackShows=()=>h.document.getElementById('fallbackPage').dispatchEvent(new h.window.CustomEvent('pageshow',{bubbles:true}));
  h.P.showPage();assert.deepEqual(shows,['je-recommendations-page']);
  const page=h.document.querySelector('#je-recommendations-page');page.classList.remove('backdropPage');
  fallbackShows();assert.deepEqual(shows,['je-recommendations-page','fallbackPage','je-recommendations-page']);
  assert.equal(page.classList.contains('backdropPage'),true);
  // Once the page is hidden, the fallback page is left alone.
  h.P.hidePage();fallbackShows();
  assert.deepEqual(shows,['je-recommendations-page','fallbackPage','je-recommendations-page','fallbackPage']);
});
test('recommendations disabled standalone page leaves current host untouched',t=>{
  const h=setup(t,async()=>({}));h.JE.pluginConfig={RecommendationsPageEnabled:false};h.JE.t=key=>key;h.P.renderInto=()=>{throw Error('must not render');};
  h.load('jellyseerr/recommendations/recommendations-page.js');h.P.showPage();assert.equal(h.document.querySelector('#je-recommendations-page'),null);
});
