const {test,expect}=require('@playwright/test');
const path=require('node:path'); const {provideFeatureContext}=require('../frontend/helpers/feature-context.cjs'); // canopy K1: ui-kit.js publishes featureContext in production; these fixtures load features without it
const root=path.resolve(__dirname,'../../Jellyfin.Plugin.JellyfinEnhanced/js');
async function setup(page) {
 await page.route('http://social.fixture/**',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html><head></head><body><main></main></body></html>'}));
 await page.goto('http://social.fixture/');
 await page.evaluate(()=>{
  let epoch=0;const callbacks=new Map();window.calls=[];window.toasts=[];window.fail=false;
  const item=id=>({Id:id,Name:id,Type:'Movie',ImageTags:{Primary:'poster'}});
  window.JellyfinEnhanced={internals:{},pluginConfig:{CatchUpEnabled:true,ActivityFeedEnabled:true,ActivityFeedShowWatched:true,ActivityFeedShowReviewed:true},session:{getEpoch:()=>epoch,isCurrent:e=>e===epoch,onUserChange:(k,f)=>callbacks.set(k,f)},t:()=>'',toast:m=>window.toasts.push(m),core:{ui:{skeletonGridHtml:()=>''},api:{jf:async(path,opts)=>{window.calls.push(path);if(path==='/Users/Me')return {Policy:{IsAdministrator:false}};if(opts?.method){if(window.fail)throw Error('fixture offline');return {};}if(path.includes('/Seasons?'))return {Items:[1,2,3].map(n=>({Id:`s${n}`,Name:`Season ${n}`,IndexNumber:n,ChildCount:4}))};return {Items:path.includes('IncludeItemTypes=Series')?[{...item('Series'),Type:'Series'}]:[item('First'),item('Second'),item('Third')]};},plugin:async(path)=>{window.calls.push(path);if(path==='/catchup/event')return {};if(window.fail)throw Error('fixture offline');return {items:Array.from({length:path.includes('100')?100:50},(_,n)=>({ActivityType:n%2?'Reviewed':'Watched',UserId:'u',UserName:'Viewer',Timestamp:n,Item:{Id:String(n),Name:`Movie ${n}`}}))};}}}};
  window.changeAccount=()=>{epoch++;callbacks.forEach(fn=>fn());};
  window.ApiClient={getCurrentUserId:()=> 'user',getUrl:p=>{if(!p)throw Error('Url name cannot be empty');return 'http://social.fixture'+p;},getImageUrl:()=>''};
 });
 await provideFeatureContext(page); for(const file of ['core','styles','deck','activity','page'])await page.addScriptTag({path:path.join(root,`enhanced/catchup/catchup-${file}.js`)});
 await page.addScriptTag({path:path.join(root,'extras/activity-page.js')});
}
test('fixture Catch Up keyboard journey, failure recovery, season selection and account teardown',async({page})=>{
 await setup(page);await page.evaluate(()=>window.JellyfinEnhanced.catchUpPage.renderPage(document.querySelector('main')));
 const top=page.locator('.je-catchup-card:not(.leaving):not(.back) h2');await expect(top).toHaveText('First');
 await page.keyboard.press('ArrowLeft');await expect(top).toHaveText('Second');await page.keyboard.press('Backspace');await expect(top).toHaveText('First');
 await page.evaluate(()=>window.fail=true);await page.keyboard.press('ArrowRight');await expect.poll(()=>page.evaluate(()=>window.toasts.at(-1))).toContain('fixture offline');await expect(top).toHaveText('First');
 await page.evaluate(()=>window.fail=false);await page.keyboard.press('ArrowUp');await expect(top).toHaveText('Second');
 await page.getByRole('button',{name:'Shows',exact:true}).click();await expect(top).toHaveText('Series');await page.locator('.je-catchup-buttons .r').click();await page.locator('.je-catchup-grid button').nth(1).click();await expect(page.locator('.je-catchup-grid .on')).toHaveCount(2);
 await page.getByRole('button',{name:'Mark 2 season(s) watched',exact:true}).click();await expect.poll(()=>page.evaluate(()=>window.calls.filter(p=>p.includes('/PlayedItems/')))).toContain('/Users/user/PlayedItems/s2');
 await page.evaluate(()=>window.changeAccount());await expect(page.locator('.je-catchup')).toBeEmpty();
});
test('fixture Activity paging, filter, failed refresh recovery and account switch',async({page})=>{
 await setup(page);await page.evaluate(()=>{const P=window.JellyfinEnhanced.activityPage;P.injectStyles();return P.renderForCustomTab(document.querySelector('main'));});
 await expect(page.locator('.je-activity-row')).toHaveCount(50);await page.getByRole('button',{name:'Load more',exact:true}).click();await expect(page.locator('.je-activity-row')).toHaveCount(100);
 await page.getByRole('combobox',{name:'Activity type'}).selectOption('Reviewed');await expect(page.locator('.je-activity-section:not([hidden]) .je-activity-row')).toHaveCount(50);
 await page.evaluate(()=>window.fail=true);await page.getByRole('button',{name:'Refresh',exact:true}).click();await expect(page.locator('.je-activity-error')).toHaveCount(2);
 await page.evaluate(()=>window.fail=false);await page.getByRole('button',{name:'Refresh',exact:true}).click();await expect(page.locator('.je-activity-row')).toHaveCount(100);
 await page.evaluate(()=>window.changeAccount());await expect(page.locator('.je-activity-feed')).toBeEmpty();
});
