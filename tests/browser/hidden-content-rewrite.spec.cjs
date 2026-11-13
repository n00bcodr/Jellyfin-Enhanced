const {test,expect}=require('@playwright/test');
const path=require('node:path'); const {provideFeatureContext}=require('../frontend/helpers/feature-context.cjs'); // canopy K1: ui-kit.js publishes featureContext in production; these fixtures load features without it
const fs=require('node:fs');
const jsRoot=path.resolve(__dirname,'../../Jellyfin.Plugin.JellyfinEnhanced/js');
const entries=JSON.parse(fs.readFileSync(path.join(jsRoot,'component-scripts.json'),'utf8')).filter(p=>/^(enhanced\/hiddencontent\/|enhanced\/homeremoval\/)/.test(p));
async function setup(page){
 await page.route('http://hidden.fixture/**',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html><head></head><body><div class="section nextup"><h2>Next Up</h2><div class="card" data-id="episode"><div class="cardBox"><span class="cardText">Episode</span></div></div></div><div class="section"><h2>Library</h2><div class="card" data-id="episode"><div class="cardBox">Same episode</div></div></div><div id="management"></div></body></html>'}));
 await page.goto('http://hidden.fixture/');
 await page.evaluate(()=>{
  let epoch=0;const handlers=new Map();window.saved=[];window.stored={items:{},settings:{showHideConfirmation:false}};
  window.ApiClient={getCurrentUserId:()=> 'current',getUrl:p=>p,getDisplayPreferences:async()=>({CustomPrefs:{}}),ajax:async request=>{
   if(request.url.includes('/admin/hidden-content-users'))return {users:[{userId:'a',userName:'Alice',count:1},{userId:'b',userName:'Bob',count:1}]};
   if(request.url.endsWith('/admin/hidden-content/a'))return {hiddenContent:{items:{a:{itemId:'a',name:'Alice secret',type:'Movie'}},settings:{}}};
   if(request.url.endsWith('/admin/hidden-content/b'))return {hiddenContent:{items:{b:{itemId:'b',name:'Bob secret',type:'Movie'}},settings:{}}};
   // Every save reads the stored list first: the list the page loaded, then the last one written.
   if(request.type==='GET'&&request.url.includes('/hidden-content.json'))return structuredClone(window.stored);
   if(request.type==='POST'){window.saved.push({url:request.url,data:request.data});if(request.url.includes('/hidden-content.json'))window.stored=JSON.parse(request.data);return {success:true};}
   return {Items:[]};
  }};
  window.JellyfinEnhanced={internals:{},userConfig:{hiddenContent:{items:{},settings:{showHideConfirmation:false}}},pluginConfig:{HiddenContentEnabled:true},currentSettings:{removeContinueWatchingEnabled:true},state:{removeContext:null},
   session:{getEpoch:()=>epoch,isCurrent:e=>epoch===e,userScopedKey:key=>key,onUserChange:(key,fn)=>{handlers.set(key,fn);return ()=>handlers.delete(key);}},
   t:key=>key,helpers:{isAdmin:()=>true,debounce:fn=>fn,addCSS:(id,css)=>{const s=document.createElement('style');s.id=id;s.textContent=css;document.head.append(s);},onBodyMutation:()=>{},onViewPage:()=>{},onSidebarRebuilt:()=>{},isActiveTabContainer:()=>true,observeTabContainers:()=>{}},
   core:{api:{fetch:async()=>({Items:[]})},ui:{skeletonGridHtml:()=>'<span>Loading</span>'}}};
  window.switchAccount=()=>{epoch++;handlers.forEach(fn=>fn());window.JellyfinEnhanced.userConfig={hiddenContent:{items:{},settings:{}}};document.dispatchEvent(new Event('je:user-data-loaded'));};
 });
 await provideFeatureContext(page); for(const entry of entries)await page.addScriptTag({path:path.join(jsRoot,entry)});
 await page.evaluate(()=>window.JellyfinEnhanced.initializeHiddenContent());
}
test('shipped hide and undo update native cards and persist the final intent',async({page})=>{
 await setup(page);
 await page.evaluate(()=>window.JellyfinEnhanced.hiddenContent.hideItem({itemId:'episode',name:'Episode'}));
 await expect(page.locator('.card.je-hidden')).toHaveCount(2);
 // The hide is saved first: a hide undone before its save writes nothing.
 await page.evaluate(()=>window.JellyfinEnhanced.hiddenContent.flushPendingSave());
 expect(await page.evaluate(()=>Object.keys(JSON.parse(window.saved.at(-1).data).items))).toEqual(['episode']);
 await page.locator('.je-undo-btn').click();
 await expect(page.locator('.card.je-hidden')).toHaveCount(0);
 await page.evaluate(()=>window.JellyfinEnhanced.hiddenContent.flushPendingSave());
 expect(await page.evaluate(()=>JSON.parse(window.saved.at(-1).data).items)).toEqual({});
});
test('scoped filtering hides the Next Up copy and leaves the library copy visible',async({page})=>{
 await setup(page);
 await page.evaluate(()=>window.JellyfinEnhanced.hiddenContent.hideItem({itemId:'episode',name:'Episode',hideScope:'nextup'}));
 await expect(page.locator('.nextup .card')).toBeHidden();
 await expect(page.locator('.section').nth(1).locator('.card')).toBeVisible();
 await page.locator('.je-undo-btn').click();await expect(page.locator('.nextup .card')).toBeVisible();
});
test('administrator switching invalidates an open confirmation and clears prior account content',async({page})=>{
 await setup(page);
 await page.evaluate(()=>window.JellyfinEnhanced.hiddenContentPage.renderForCustomTab(document.querySelector('#management')));
 const select=page.locator('.je-hidden-admin-user-filter');await expect(select).toBeVisible();
 await select.selectOption('a');await expect(page.locator('#management')).toContainText('Alice secret');
 await page.locator('.je-hidden-admin-edit-toggle').click();await page.locator('.je-hidden-item-unhide').click();
 await expect(page.locator('.je-hide-confirm-overlay')).toBeVisible();
 // Simulate another view control switching while a confirmation is pending.
 await page.evaluate(()=>window.JellyfinEnhanced.internals.hiddenContentPage.onAdminUserChange('b'));
 await page.locator('.je-hide-confirm-hide').click();
 await expect(page.locator('#management')).toContainText('Bob secret');
 expect(await page.evaluate(()=>window.saved.filter(r=>r.url.endsWith('/unhide')).length)).toBe(0);
 await page.evaluate(()=>window.switchAccount());await expect(page.locator('#management')).toBeEmpty();
});

test('Undo remains usable after same-account navigation and clears on account change',async({page})=>{
 await setup(page);
 await page.evaluate(()=>window.JellyfinEnhanced.hiddenContent.hideItem({itemId:'episode',name:'Episode'}));
 await expect(page.locator('.je-undo-btn')).toBeVisible();
 // The hide is saved first: a hide undone before its save writes nothing.
 await page.evaluate(()=>window.JellyfinEnhanced.hiddenContent.flushPendingSave());
 expect(await page.evaluate(()=>Object.keys(JSON.parse(window.saved.at(-1).data).items))).toEqual(['episode']);
 await page.evaluate(()=>{history.pushState({},'', '#/details?id=other');window.dispatchEvent(new Event('popstate'));document.dispatchEvent(new Event('viewhide'));});
 await expect(page.locator('.je-undo-btn')).toBeVisible();await page.locator('.je-undo-btn').click();
 await page.evaluate(()=>window.JellyfinEnhanced.hiddenContent.flushPendingSave());
 expect(await page.evaluate(()=>JSON.parse(window.saved.at(-1).data).items)).toEqual({});
 await page.evaluate(()=>window.JellyfinEnhanced.hiddenContent.hideItem({itemId:'episode',name:'Episode'}));
 await expect(page.locator('.je-undo-btn')).toBeVisible();await page.evaluate(()=>window.switchAccount());
 await expect(page.locator('.je-undo-toast')).toHaveCount(0);
});
