// Round 15: actual Discover renderer, deferred opening identity, and the managed HC feedback lifecycle.
const {test,expect}=require('@playwright/test');
const {read,boot,press}=require('./title-actions-host.cjs');
test.skip(({browserName})=>browserName!=='chromium','Chromium touch and focus controls');
test.use({hasTouch:true});
/** Opens the production More Info row with the real Hidden Content data and dialog modules. */
async function managedInfo(page, isMobile) {
  await page.evaluate(() => { window.JellyfinEnhanced.userConfig = { hiddenContent: { items: {}, settings: { enabled: true, showHideButtons: true, showButtonDetails: true, showButtonJellyseerr: true, showHideConfirmation: true } } }; });
  for (const file of ['enhanced/hiddencontent/hidden-content-data.js', 'enhanced/hiddencontent/hidden-content-dialogs.js']) await page.addScriptTag({ content: read('Jellyfin.Plugin.JellyfinEnhanced/js/' + file) });
  await page.evaluate(() => {
    const JE = window.JellyfinEnhanced; const hc = JE.internals.hiddenContent; hc.refreshNativeCardVisibility = () => {};
    JE.hiddenContent = { buildTitleControl: hc.buildTitleControl };
    // The rule write answers after a network round trip (a few frames), as a real server does.
    const fetch = window.fetch;
    window.fetch = async (url, options = {}) => { if ((options.method || 'GET') !== 'GET' && String(url).includes('/hidden-content/rule/')) await new Promise(r => setTimeout(r, 300)); return fetch(url, options); };
  });
  await press(page, page.locator('#openInfo'), isMobile);
  await page.locator('.je-more-info-modal.active [data-mount="je-secondary-actions"] .je-detail-hide-btn').waitFor({ state: 'attached' });
  await page.locator('.je-more-info-modal.active .je-actions-more').waitFor();
}


/** Starts the actual More Info row's managed Hide and confirms its real HC write. */
async function undoInInfo(page,isMobile){
 await managedInfo(page,isMobile);
 await page.evaluate(()=>{const timer=window.setTimeout;window.setTimeout=(fn,ms,...args)=>ms===8000?(window.expireUndo=fn,0):timer(fn,ms,...args);});
 await press(page,page.locator('.je-more-info-modal.active .je-actions-more'),isMobile);
 await press(page,page.locator('.je-actions-entry[data-action="hide"]'),isMobile);
 await press(page,page.locator('.je-hide-confirm-hide'),isMobile);
 await page.locator('.je-undo-btn').waitFor();
}
for(const terminal of ['success','expiry'])for(const moved of [false,true]){
 test(`Undo ${terminal} preserves ${moved?'deliberate focus':'focus inside More Info'}`,async({page,isMobile})=>{
  await page.setViewportSize({width:isMobile?390:1280,height:844});const host=await boot(page);await undoInInfo(page,isMobile);
  await page.locator('.je-undo-btn').focus();
  if(terminal==='success')await press(page,page.locator('.je-undo-btn'),isMobile);
  if(moved)await page.locator('.je-more-info-modal.active .modal-refresh').focus();
  if(terminal==='expiry')await page.evaluate(()=>window.expireUndo());
  await expect(page.locator('.je-undo-btn')).toHaveCount(0);
  expect(await page.evaluate(()=>document.querySelector('.je-more-info-modal.active').contains(document.activeElement))).toBe(true);
  if(moved)expect(await page.evaluate(()=>document.activeElement.classList.contains('modal-refresh'))).toBe(true);
  expect(await page.evaluate(()=>window.sent.filter(([m,p])=>m==='DELETE'&&p.includes('/hidden-content/rule/')).length)).toBe(terminal==='success'?1:0);
  expect(host.errors).toEqual([]);
 });
}

for(const phase of ['hold','admission','entries','unchanged']){
 test(`Discover uninterrupted incarnation through ${phase}`,async({page,isMobile})=>{
  await page.setViewportSize({width:isMobile?390:1280,height:844});const host=await boot(page,{home:true});
  await page.addScriptTag({content:read('Jellyfin.Plugin.JellyfinEnhanced/js/arr/hub/hub-discover.js')});
  await page.evaluate(()=>{
  window.JellyfinEnhanced.pluginConfig.JellyseerrEnabled = false;

  const node = window.JellyfinEnhanced.internals.arrDiscover.buildCard({ key: 'movie:tmdb:603', kind: 'movie', tmdbId: 603, title: 'Original', inLibrary: false }, { caps: { canRequest: false }, surface: 'discover' });
  document.body.append(node);
  node.id="actualDiscover"; node.style.cssText="position:relative;width:160px;height:240px";
});
  await page.locator('#actualDiscover .je-card-more').waitFor();
  await page.evaluate(phase=>{const fetch=window.fetch;window.gateReached=false;
   window.fetch=async(url,options)=>{if((phase==='admission'&&String(url).includes('/title-actions/movie/603'))||(phase==='entries'&&String(url).includes('/acquire/status'))){window.gateReached=true;await new Promise(r=>window.releaseOpening=r);}return fetch(url,options);};
  },phase);
  const cdp=await page.context().newCDPSession(page);await cdp.send('Emulation.setTouchEmulationEnabled',{enabled:true});
  const box=await page.locator('#actualDiscover .je-discover-poster-box').boundingBox();
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:box.x+10,y:box.y+10}]});
  if(['admission','entries'].includes(phase))await expect.poll(()=>page.evaluate(()=>window.gateReached)).toBe(true);
  if(phase!=='unchanged')await page.evaluate(()=>{const node=document.getElementById('actualDiscover');
      node.dataset.key = 'movie:tmdb:604';
      node.dataset.key = 'movie:tmdb:603';
});
  if(['admission','entries'].includes(phase))await page.evaluate(()=>window.releaseOpening());
  await page.waitForTimeout(700);
  expect(await page.locator('.je-actions-sheet').count()).toBe(phase==='unchanged'?1:0);
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  if(phase==='unchanged') {
   await expect(page.locator('.je-actions-sheet')).toHaveCount(1);
   if(isMobile)await page.locator('.je-actions-backdrop').tap({position:{x:5,y:5}});else await page.locator('.je-actions-backdrop').click({position:{x:5,y:5}});
   await expect(page.locator('.je-actions-sheet')).toHaveCount(0);
  }
  await cdp.detach();
  expect(host.errors).toEqual([]);
 });
}
