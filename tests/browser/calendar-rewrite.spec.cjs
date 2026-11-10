const {test,expect}=require('@playwright/test');
const path=require('node:path'); const {provideFeatureContext}=require('../frontend/helpers/feature-context.cjs'); // canopy K1: ui-kit.js publishes featureContext in production; these fixtures load features without it
test.use({timezoneId:'America/New_York'});
const root=path.resolve(__dirname,'../../Jellyfin.Plugin.JellyfinEnhanced/js/arr/calendar');
test('generated calendar switches views, expands episodes, retries errors, rejects account-stale navigation and remounts',async({page},testInfo)=>{
 await page.route('http://calendar.fixture/**',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html><head></head><body><div class="mainAnimatedPages"></div><div class="jellyfinEnhancedSection"></div></body></html>'}));
 await page.goto('http://calendar.fixture/#/calendar');
 await page.evaluate(()=>{
  let epoch=0;const changes=new Map(),lifes=new Map();window.fail=false;window.pendingLookup=null;window.calls=0;
  const esc=v=>String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
  window.JellyfinEnhanced={internals:{},pluginConfig:{CalendarPageEnabled:true},currentSettings:{calendarDefaultViewMode:'agenda'},t:k=>k,escapeHtml:esc,cdn:{selfhst:()=>''},saveUserSettings:async()=>{},
   session:{getEpoch:()=>epoch,isCurrent:e=>e===epoch,getServerId:()=> 'server',userScopedKey:k=>k+':u'+epoch,onUserChange:(k,f)=>{changes.set(k,f);return()=>changes.delete(k);}},
   helpers:{onNavigate:f=>{window.addEventListener('hashchange',f);return()=>window.removeEventListener('hashchange',f);},onSidebarRebuilt:()=>()=>{},isActiveTabContainer:el=>el.isConnected&&!el.closest('.hide')},
   core:{api:{plugin:async path=>{
    if(path.startsWith('/items/'))return await new Promise(r=>window.pendingLookup=r);
    window.calls++;if(window.fail)throw new TypeError('invalid response');
    return {events:[1,2].map(n=>({id:'episode'+n,title:'Calendar show',type:'Series',source:'Sonarr',releaseType:'Episode',releaseDate:'2026-03-08',seasonNumber:1,episodeNumber:n,hasFile:true,tmdbId:7}))};
   }},ui:{injectCss:(id,css)=>{if(document.getElementById(id))return;const s=document.createElement('style');s.id=id;s.textContent=css;document.head.appendChild(s);},skeletonGridHtml:()=>'<div>loading</div>'},lifecycle:{register:k=>{
    if(lifes.has(k))return lifes.get(k);const rs=[];const life={track:r=>(rs.push(r),r),untrack:r=>{const i=rs.indexOf(r);if(i>=0)rs.splice(i,1);},addListener:(el,type,fn,c)=>{el.addEventListener(type,fn,c);rs.push(()=>el.removeEventListener(type,fn,c));},teardown:()=>rs.splice(0).forEach(f=>f())};lifes.set(k,life);return life;
   }}}};
  window.changeUser=()=>{epoch++;changes.forEach(f=>f());};
 });
 await provideFeatureContext(page); for(const name of ['styles','data','render-events','render-views','actions','init'])await page.addScriptTag({path:path.join(root,'calendar-page-'+name+'.js')});
 await page.evaluate(()=>{window.JellyfinEnhanced.internals.calendarPage.state.currentDate=new Date(2026,2,8);window.JellyfinEnhanced.calendarPage.initialize();});
 await expect(page.locator('.je-calendar-agenda-event')).toHaveCount(1);
 await page.locator('.je-calendar-group-toggle').click();await expect(page.locator('.je-calendar-agenda-event')).toHaveCount(2);
 await page.getByRole('button',{name:'calendar_day',exact:true}).click();await expect(page.locator('.je-calendar-day-hours')).toBeVisible();
 await page.locator('.je-calendar-mode-btn[data-mode=cards]').click();await expect(page.locator('.je-calendar-card')).toHaveCount(2);
 await page.evaluate(()=>{window.fail=true;return window.JellyfinEnhanced.calendarPage.refresh();});await expect(page.getByRole('alert')).toContainText('could not be loaded');
 await page.evaluate(()=>window.fail=false);await page.getByRole('button',{name:'Retry',exact:true}).click();await expect(page.locator('.je-calendar-card')).toHaveCount(2);
 await page.locator('.je-calendar-card').first().click();await expect.poll(()=>page.evaluate(()=>typeof window.pendingLookup)).toBe('function');
 await page.evaluate(()=>{window.changeUser();window.pendingLookup('old-private-item');});await expect(page).toHaveURL(/#\/calendar$/);await expect(page.locator('.je-calendar-card')).toHaveCount(0);
 await page.evaluate(()=>{const JE=window.JellyfinEnhanced;const target=document.createElement('div');target.id='custom-mount';document.body.appendChild(target);JE.calendarPage.renderForCustomTab(target);});
 await expect(page.locator('#custom-mount .je-calendar-card')).toHaveCount(1);
 await page.screenshot({path:testInfo.outputPath('calendar-interaction.png'),fullPage:true});
});
