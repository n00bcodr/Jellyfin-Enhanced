const {test,expect}=require('@playwright/test');
const path=require('node:path'); const {provideFeatureContext}=require('../frontend/helpers/feature-context.cjs'); // canopy K1: ui-kit.js publishes featureContext in production; these fixtures load features without it
const root=path.resolve(__dirname,'../../Jellyfin.Plugin.JellyfinEnhanced/js/enhanced/bookmarks');
async function setup(page) {
 await page.route('http://bookmarks.fixture/**',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html><head></head><body><button id="opener">Open bookmarks</button><div class="sections bookmarks"></div></body></html>'}));
 await page.goto('http://bookmarks.fixture/');
 await page.evaluate(()=>{
  const callbacks=new Map();let epoch=0;
  window.toasts=[];window.saves=0;window.failSave=true;
  window.JellyfinEnhanced={internals:{},pluginConfig:{BookmarksEnabled:true},userConfig:{bookmarkRevision:"fixture:1",bookmark:{bookmarks:{
   a:{itemId:'movie',timestamp:5,label:'Alpha',name:'Movie',mediaType:'movie',syncedFrom:'old'},
   b:{itemId:'movie',timestamp:10,label:'Beta',name:'Movie',mediaType:'movie',syncedFrom:'old'},
   c:{itemId:'other',timestamp:7,label:'Gamma',name:'Other movie',mediaType:'movie'}
  }}},session:{getEpoch:()=>epoch,isCurrent:e=>e===epoch,onUserChange:(key,fn)=>{callbacks.set(key,fn);return ()=>callbacks.delete(key);}},
  t:k=>k,toast:m=>window.toasts.push(m),escapeHtml:v=>String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;'),
  saveUserSettings:async()=>{window.saves++;if(window.failSave)throw new Error('offline');},
  helpers:{isActiveTabContainer:()=>false},core:{navigation:{onViewPage:()=>()=>{}}}};
  window.changeAccount=()=>{epoch++;window.JellyfinEnhanced.userConfig={bookmark:{bookmarks:{}}};callbacks.forEach(fn=>fn());};
  window.ApiClient={getUrl:path=>path,ajax:async request=>{if(request.type!=='POST'||!request.url.endsWith('/bookmark-document'))throw new Error('Unexpected request');window.saves++;if(window.conflict)throw {status:409};if(window.failSave)throw new Error('offline');return {Revision:'fixture:2'};},getCurrentUserId:()=> 'user',getItem:async(_,id)=>({Id:id,Type:'Movie',Name:id}),getImageUrl:()=>''};
 });
 await provideFeatureContext(page); for(const name of ['bookmarks','bookmarks-library-styles','bookmarks-library-render','bookmarks-library-items','bookmarks-library-modals'])await page.addScriptTag({path:path.join(root,name+'.js')});
}
test('bookmark offset failure is atomic; keyboard focus traps, Escape restores focus',async({page})=>{
 await setup(page);await page.locator('#opener').focus();
 await page.evaluate(()=>{
  const JE=window.JellyfinEnhanced;JE.internals.bookmarksLibrary.showOffsetAdjustmentModal({details:{itemId:'movie',name:'Movie'},bookmarks:Object.entries(JE.userConfig.bookmark.bookmarks).filter(([,b])=>b.itemId==='movie').map(([id,b])=>({...b,id}))});
 });
 await expect(page.locator('#offset-adjustment-input')).toBeFocused();
 await page.locator('#offset-adjustment-input').fill('5');
 await page.locator('.btnApplyOffset').click();
 await expect.poll(()=>page.evaluate(()=>window.toasts.at(-1))).toBe('bookmark_offset_failed');
 expect(await page.evaluate(()=>[window.saves,...Object.values(window.JellyfinEnhanced.userConfig.bookmark.bookmarks).map(b=>b.timestamp)])).toEqual([1,5,10,7]);
 await page.locator('.btnApplyOffset').focus();await page.keyboard.press('Tab');
 await expect(page.locator('.je-bm-library-modal-close')).toBeFocused();
 await page.keyboard.press('Escape');await expect(page.locator('[role="dialog"]')).toHaveCount(0);await expect(page.locator('#opener')).toBeFocused();
});
test('generated library search filters cards and account change clears private content',async({page})=>{
 await setup(page);
 await page.evaluate(()=>window.JellyfinEnhanced.internals.bookmarksLibrary.renderBookmarksLibrary(document.querySelector('.sections.bookmarks')));
 await expect(page.locator('.je-bookmark-item')).toHaveCount(2);
 await page.locator('.je-bookmark-search').fill('Beta');
 await expect(page.locator('.je-bookmark-item:visible')).toHaveCount(1);
 await expect(page.locator('.je-bookmark-item:visible')).toContainText('Alpha');
 await page.evaluate(()=>window.changeAccount());
 await expect(page.locator('.sections.bookmarks')).toBeEmpty();
});

test('conflicting bookmark edit restores records and leaves explicit reload guidance visible',async({page})=>{
 await setup(page);
 await page.evaluate(()=>{
  window.conflict=true;
  const JE=window.JellyfinEnhanced;
  JE.internals.bookmarksLibrary.showOffsetAdjustmentModal({details:{itemId:'movie',name:'Movie'},bookmarks:Object.entries(JE.userConfig.bookmark.bookmarks).filter(([,b])=>b.itemId==='movie').map(([id,b])=>({...b,id}))});
 });
 await page.locator('#offset-adjustment-input').fill('5');await page.locator('.btnApplyOffset').click();
 await expect.poll(()=>page.evaluate(()=>window.toasts.at(-1))).toMatch(/changed in another tab.*Reload before saving again/);
 expect(await page.evaluate(()=>[window.saves,window.JellyfinEnhanced.userConfig.bookmarkRevision,...Object.values(window.JellyfinEnhanced.userConfig.bookmark.bookmarks).map(b=>b.timestamp)])).toEqual([1,'fixture:1',5,10,7]);
 await expect(page.locator('[role="dialog"]')).toHaveCount(1);
});
