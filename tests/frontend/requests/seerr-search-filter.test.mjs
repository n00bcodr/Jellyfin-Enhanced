import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from '../helpers/harness.mjs';
const flush = () => new Promise(resolve => setImmediate(resolve));
const delay = (h, ms) => new Promise(resolve => h.window.setTimeout(resolve, ms));
async function setup(t) {
  let epoch = 0, active = true, userFound = true, navigate;
  const resets = new Map(), searchCalls = [];
  const h = createHarness({html: `<div id="searchPage"><div class="searchFields"><div class="inputContainer"><input id="searchTextInput"></div></div><div class="searchResults"><div id="native" class="verticalSection">Native movie</div><div id="preserved" class="verticalSection section-hidden">Hidden by host</div><div id="empty" class="noItemsMessage">No items</div></div></div>`, JE: {
    pluginConfig: {JellyseerrEnabled:true,JellyseerrShowGenreDiscovery:false},t:k=>k,toast(){},escapeHtml:value=>String(value),
    session:{getEpoch:()=>epoch,isCurrent:e=>e===epoch,onUserChange:(name,fn)=>resets.set(name,fn)},
    helpers:{onBodyMutation(){},onNavigate(fn){navigate=fn;},trackUsage(){}},
    cdn:{selfhst:()=>'/seerr.svg'},core:{ui:{addTouchTapListener(){}},api:{fetch:async()=>({active,userFound}),plugin:async()=>({})}},
    jellyseerrAPI:{requestMedia:async()=>({id:7}),checkUserStatus:async()=>({active,userFound}),search:async(...args)=>{searchCalls.push(args);return {results:[],totalPages:1};},fetchCollectionsForSearchResults:async()=>[]}
  }});
  t.after(()=>h.close());
  for (const file of ['seerr-status.js','ui/ui-icons.js','ui/ui-styles.js','ui/ui-results.js','jellyseerr.js']) {
    h.load(`jellyseerr/${file}`);
  }
  h.JE.initializeJellyseerrScript(); await flush();
  const input=h.document.getElementById('searchTextInput'); input.value='film';
  h.document.querySelector('.searchResults').insertAdjacentHTML('beforeend','<div class="jellyseerr-section"><h2 class="sectionTitle">Discover<button id="refresh">Refresh</button></h2><div class="itemsContainer"></div></div>');
  const icon=h.document.getElementById('jellyseerr-search-icon');
  const toggle=()=>icon.dispatchEvent(new h.window.KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
  return {...h,input,icon,toggle,searchCalls,changeIdentity(status={active:true,userFound:true}){epoch++;active=status.active;userFound=status.userFound;for(const fn of resets.values())fn();},navigate:()=>navigate(),inputEvent:()=>input.dispatchEvent(new h.window.Event('input',{bubbles:true}))};
}
function restored(h) {
  assert.equal(h.document.getElementById('native').classList.contains('section-hidden'),false,'native section restored');
  assert.equal(h.document.getElementById('empty').classList.contains('section-hidden'),false,'native empty message restored');
  assert.equal(h.document.getElementById('preserved').classList.contains('section-hidden'),true,'host-owned hiding preserved');
  assert.equal(h.document.querySelector('#jellyseerr-placeholder'),null,'temporary placement removed');
  assert.equal(h.icon.classList.contains('is-filter-active'),false,'filter icon off');
}
for (const [label,status] of [['linked account',{active:true,userFound:true}],['unlinked account',{active:true,userFound:false}],['disabled server',{active:false,userFound:false}]]) {
  test(`SRC-R1B-001: ${label} reset restores native results before status resolves`,async t=>{
    const h=await setup(t);h.toggle();assert(h.document.getElementById('native').classList.contains('section-hidden'));
    h.changeIdentity(status);restored(h);await delay(h,10);restored(h);
  });
}
test('query cleared restores native results and the icon',async t=>{const h=await setup(t);h.toggle();h.input.value='';h.inputEvent();restored(h);});
test('query replaced restores native results before a new row',async t=>{const h=await setup(t);h.toggle();h.input.value='other';h.inputEvent();await delay(h,230);restored(h);});
test('navigation away restores retained search DOM',async t=>{const h=await setup(t);h.toggle();h.document.getElementById('searchPage').classList.add('hide');h.navigate();await delay(h,230);restored(h);});
test('explicit toggle retains host hiding and restores original row position',async t=>{
 const h=await setup(t);const results=h.document.querySelector('.searchResults');const row=h.document.querySelector('.jellyseerr-section');const original=[...results.children];const refresh=h.document.getElementById('refresh');
 for(let i=0;i<2;i++){h.toggle();assert.equal(results.firstElementChild,row);h.toggle();restored(h);assert.deepEqual([...results.children],original);assert.equal(h.document.getElementById('refresh'),refresh);}
});
test('removed row is not resurrected and its placeholder is still released',async t=>{const h=await setup(t);h.toggle();h.document.querySelector('.jellyseerr-section').remove();h.input.value='';h.inputEvent();restored(h);assert.equal(h.document.querySelector('.jellyseerr-section'),null);});

test('SEERR-CORE-19: modal refresh reaches the current mounted query', async t => {
 const h=await setup(t); h.searchCalls.length=0;
 await h.JE.jellyseerr.fetchAndRenderResults('film',{skipCache:true});
 assert.equal(h.searchCalls.length,1);assert.equal(h.searchCalls[0][0],'film');assert.equal(h.searchCalls[0][2].skipCache,true);
});
test('SEERR-CORE-19: old query refresh after typing or navigation cannot restart it', async t => {
 const h=await setup(t); h.searchCalls.length=0;h.input.value='new';
 await h.JE.jellyseerr.fetchAndRenderResults('film',{skipCache:true});assert.equal(h.searchCalls.length,0);
 h.input.value='film';h.document.getElementById('searchPage').classList.add('hide');
 await h.JE.jellyseerr.fetchAndRenderResults('film',{skipCache:true});assert.equal(h.searchCalls.length,0);
});

for (const transition of ['query','account','unchanged']) test('SEERR-CORE-16: delayed 4K refresh respects '+transition,async t=>{
 const h=await setup(t);const callbacks=[];const realTimer=h.window.setTimeout.bind(h.window);
 h.window.history.replaceState(null,'','#/search?query=film');
 h.window.setTimeout=(fn,ms,...args)=>ms===1000?(callbacks.push(()=>fn(...args)),100000+callbacks.length):realTimer(fn,ms,...args);
 h.JE.jellyseerrAPI.shouldShowAdvanced=()=>false;
 h.JE.jellyseerrAPI.requestMedia=async()=>({id:7});
 const popup=h.document.createElement('div');popup.className='jellyseerr-4k-popup';
 popup.innerHTML='<button class="jellyseerr-4k-popup-item" data-action="request4k" data-tmdb-id="42" data-media-type="movie">4K</button>';
 h.document.body.append(popup);popup.querySelector('button').click();await flush();await flush();
 assert.equal(callbacks.length,1);
 if(transition==='query')h.input.value='other';
 if(transition==='account'){h.changeIdentity();await delay(h,15);}
 h.searchCalls.length=0;callbacks[0]();await flush();
 assert.equal(h.searchCalls.length,transition==='unchanged'?1:0);
});

test('the 4K request item says Requesting and, after a failure, Request in 4K from the translations',async t=>{
 const h=await setup(t);let fail;h.JE.jellyseerrAPI.shouldShowAdvanced=()=>false;
 h.JE.jellyseerrAPI.requestMedia=()=>new Promise((_,reject)=>{fail=reject;});
 const popup=h.document.createElement('div');popup.className='jellyseerr-4k-popup';
 popup.innerHTML='<button class="jellyseerr-4k-popup-item" data-action="request4k" data-tmdb-id="42" data-media-type="movie">4K</button>';
 h.document.body.append(popup);const item=popup.querySelector('button');item.click();await flush();
 assert.equal(item.textContent,'jellyseerr_btn_requesting');
 fail(new Error('down'));await flush();await flush();
 assert.equal(item.textContent,'jellyseerr_btn_request_4k');
});

