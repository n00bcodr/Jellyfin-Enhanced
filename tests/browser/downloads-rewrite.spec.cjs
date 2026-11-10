const {test,expect}=require('@playwright/test');
const path=require('node:path'); const {provideFeatureContext}=require('../frontend/helpers/feature-context.cjs'); // canopy K1: ui-kit.js publishes featureContext in production; these fixtures load features without it
const root=path.resolve(__dirname,'../../Jellyfin.Plugin.JellyfinEnhanced/js/arr/requests');
test.beforeEach(async({page})=>{const errors=[];page.on('pageerror',e=>errors.push(e.message));page.__downloadsErrors=errors;});
test.afterEach(async({page})=>{expect(page.__downloadsErrors).toEqual([]);});
async function setup(page,mode='standalone'){
 await page.route('http://downloads.fixture/**',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html><head></head><body><div class="mainAnimatedPages"><div class="page" id="indexPage"><div class="tabContent is-active"><div class="jellyfinenhanced requests"></div></div></div></div><div class="jellyfinEnhancedSection"></div></body></html>'}));
 await page.goto('http://downloads.fixture/#/home');
 await page.evaluate(mode=>{
  let epoch=0;const resets=new Map(),resources=[];window.calls=[];window.notices=[];window.actionMode='success';window.holdQueue=false;
  const escape=s=>String(s??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
  const JE=window.JellyfinEnhanced={internals:{},pluginConfig:{DownloadsPageEnabled:true,DownloadsPagePollingEnabled:true,DownloadsPollIntervalSeconds:1,JellyseerrEnabled:true,DownloadsShowHistory:true,DownloadsUseCustomTabs:mode==='custom',DownloadsUseNativeTab:mode==='native'},
   session:{getEpoch:()=>epoch,isCurrent:e=>e===epoch,onUserChange:(k,f)=>{resets.set(k,f);return()=>resets.delete(k);}},escapeHtml:escape,t:()=>'',toast:s=>window.notices.push(s),cdn:{selfhst:()=>''},
   nativeTabs:{register:(id,title,mount)=>{window.nativeRegistration={id,title};const panel=document.querySelector('.tabContent');panel.replaceChildren();mount(panel);}},
   helpers:{clearAvatarObjectUrlCache(){},hydrateAvatarImages(){},isAdmin:()=>false,onSidebarRebuilt(){},onNavigate:()=>()=>{},isActiveTabContainer:el=>el.isConnected&&!!el.closest('.tabContent.is-active')&&!el.closest('.hide'),observeTabContainers:(_,selector,cb)=>{const ob=new MutationObserver(cb);ob.observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['class']});return()=>ob.disconnect();}},
   core:{ui:{injectCss:(id,css)=>{const s=document.createElement('style');s.id=id;s.textContent=css;document.head.append(s);},skeletonGridHtml:()=>'<div>Loading</div>',isTvLayout:()=>false},lifecycle:{register:()=>({track:r=>{resources.push(r);return r;},untrack:r=>{const i=resources.indexOf(r);if(i>=0)resources.splice(i,1);}})},api:{plugin:async(p,o)=>{
    window.calls.push([p,o]);
    if(o?.method==='POST'){if(window.actionMode==='fail')throw {status:403};if(window.actionMode==='hold')return new Promise(r=>window.finishAction=r);return {};}
    if(p==='/arr/queue'){if(window.holdQueue)return new Promise(r=>window.finishQueue=r);return {items:[{id:'1',title:'Alpha',source:'Sonarr',status:'Downloading',progress:30},{id:'2',title:'Beta',source:'Radarr',status:'Paused',progress:50}]};}
    if(p.startsWith('/arr/requests'))return {requests:[{id:5,title:'Request',requestStatus:1,mediaStatus:'Pending'}],canApproveRequests:true,totalPages:2};
    return {items:[{id:'h',title:'Imported',eventType:'imported'}]};
   }}}};
   window.ApiClient={getCurrentUserId:()=>String(epoch),serverAddress:()=> 'http://downloads.fixture',getUrl:p=>p,ajax:async()=>({results:[]})};
   window.changeAccount=()=>{epoch++;resets.forEach(fn=>fn());};
   window.dispose=()=>{resources.splice(0).forEach(r=>typeof r==='function'?r():typeof r==='number'?clearInterval(r):r.abort?.());};
 },mode);
 await provideFeatureContext(page); for(const name of ['styles','data','render-helpers','render-cards','render','actions','init'])await page.addScriptTag({path:path.join(root,'requests-page-'+name+'.js')});
 await page.evaluate(()=>window.JellyfinEnhanced.downloadsPage.initialize());
 if(mode==='standalone')await page.evaluate(()=>window.JellyfinEnhanced.downloadsPage.showPage());
 else await page.addScriptTag({path:path.join(root,'requests-custom-tab.js')});
 await expect(page.locator('.je-download-card')).toHaveCount(2);
}
test('shipped assets support search, status filters, paging, and one non-retried failed approval',async({page})=>{
 await setup(page);
 await page.locator('.je-downloads-search-toggle').click();await page.locator('.je-downloads-search-input').fill('Beta');await expect(page.locator('.je-download-card')).toHaveCount(1);await expect(page.locator('.je-download-card')).toContainText('Beta');
 await page.locator('.je-downloads-search-toggle').click();await page.locator('[data-tab="Paused"]').click();await expect(page.locator('.je-download-card')).toHaveCount(1);
 await page.locator('.je-requests-section .je-pagination button').last().click();expect(await page.evaluate(()=>window.JellyfinEnhanced.downloadsPage._state.requestsPage)).toBe(2);
 await page.evaluate(()=>{window.actionMode='fail';window.JellyfinEnhanced.downloadsPage.stopPolling();});await page.locator('.je-request-approve-btn').click();await expect(page.locator('.je-request-approve-btn')).toBeEnabled();
 expect(await page.evaluate(()=>window.calls.filter(([,o])=>o?.method==='POST'))).toEqual([['/arr/requests/5/approve',{method:'POST',skipRetry:true}]]);
 expect(await page.evaluate(()=>window.notices)).toHaveLength(1);await page.evaluate(()=>window.dispose());
});
test('late sent action after account change reconciles without stale cards or followup fetch',async({page})=>{
 await setup(page);await page.evaluate(()=>{window.JellyfinEnhanced.downloadsPage.stopPolling();window.actionMode='hold';});await page.locator('.je-request-approve-btn').click();
 await page.evaluate(()=>{window.before=window.calls.length;window.changeAccount();window.finishAction({});});await expect(page.locator('.je-request-card')).toHaveCount(0);
 expect(await page.evaluate(()=>[window.calls.length===window.before,...window.JellyfinEnhanced.internals.requestsPage.runtime.mutations.values()])).toEqual([true,'succeeded']);await page.evaluate(()=>window.dispose());
});
for(const mode of ['custom','native'])test(mode+' tab stops polling on deactivation and remounts on return',async({page})=>{
 await setup(page,mode);if(mode==='native')expect(await page.evaluate(()=>window.nativeRegistration.id)).toBe('requests');
 await page.evaluate(()=>document.querySelector('.tabContent').classList.remove('is-active'));
 await expect.poll(()=>page.evaluate(()=>window.JellyfinEnhanced.downloadsPage._state.pollTimer)).toBe(null);
 await page.evaluate(()=>document.querySelector('.tabContent').classList.add('is-active'));await expect(page.locator('.je-download-card')).toHaveCount(2);await expect.poll(()=>page.evaluate(()=>window.JellyfinEnhanced.downloadsPage._state.pollTimer!==null)).toBe(true);
 await page.evaluate(()=>window.dispose());
});
test('pending queue after navigation does not populate a hidden standalone view',async({page})=>{
 await setup(page);await page.evaluate(()=>{window.holdQueue=true;window.JellyfinEnhanced.downloadsPage.refresh();});
 await page.evaluate(()=>{window.JellyfinEnhanced.downloadsPage.hidePage();history.replaceState({},'','#/other');window.finishQueue({items:[{id:999,title:'Stale secret'}]});});
 await expect(page.locator('body')).not.toContainText('Stale secret');expect(await page.evaluate(()=>window.JellyfinEnhanced.downloadsPage._state.pollTimer)).toBe(null);await page.evaluate(()=>window.dispose());
});

test('Plugin Pages container removal stops the feature poll lifetime',async({page})=>{
 await setup(page);await page.evaluate(()=>{
  const api=window.JellyfinEnhanced.downloadsPage;
  api.hidePage();document.querySelector('#je-downloads-page').remove();
  const container=document.createElement('div');container.id='je-downloads-container';document.body.append(container);
  api._state._pluginPageVisible=true;api.renderPage();api.startPolling();
  window.removedPoll=api._state.pollTimer;container.remove();
 });
 expect(await page.evaluate(()=>window.removedPoll)).not.toBe(null);
 await expect.poll(()=>page.evaluate(()=>window.JellyfinEnhanced.downloadsPage._state.pollTimer)).toBe(null);
 await page.evaluate(()=>window.dispose());
});
