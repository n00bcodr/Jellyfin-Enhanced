// Real Chromium journeys for the chrome slice's user-visible controls, on the emitted scripts.
const {test,expect}=require('@playwright/test');
const path=require('node:path'); const {provideFeatureContext}=require('../frontend/helpers/feature-context.cjs'); // canopy K1: ui-kit.js publishes featureContext in production; these fixtures load features without it
const root=path.resolve(process.env.CHROME_JS||path.join(__dirname,'../../Jellyfin.Plugin.JellyfinEnhanced/js'));
// The viewport meta as Jellyfin web's index.html has it: without it a phone (isMobile) lays the page out 980px wide.
const page0=html=>route=>route.fulfill({contentType:'text/html',body:`<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{margin:0;font-family:sans-serif;background:#101010;color:#eee}
 .headerTop{display:flex;align-items:center;height:56px;padding:0 8px;background:#202020}.headerLeft{flex-grow:1;display:flex;align-items:center}
 .headerRight{display:flex;align-items:center}.headerButton{width:40px;height:40px;margin:0 2px;border:0;background:#333;color:#fff}</style></head><body>${html}</body></html>`});
const header='<div class="skinHeader"><div class="headerTop"><div class="headerLeft"><h3 class="pageTitle">Home</h3></div><div class="headerRight"><button class="headerButton" id="native-user">U</button></div></div></div>';

async function bridge(page,{admin=true,sessions=[]}={}){
 await page.evaluate(({admin,sessions})=>{
  let epoch=1,user='admin-a';const resets=new Map();window.posts=[];window.reads=0;
  window.ApiClient={getCurrentUserId:()=>user,serverId:()=>'server-a',getImageUrl:id=>'data:image/gif;base64,R0lGODlhAQABAAAAACw=',getUrl:p=>'/'+p};
  window.signIn=(next)=>{user=next;};
  window.JellyfinEnhanced={t:k=>k,pluginConfig:{ActiveStreamsEnabled:true},
   session:{getUserId:()=>user,getEpoch:()=>epoch,isCurrent:e=>e===epoch,onUserChange:(n,f)=>{resets.set(n,f);return()=>resets.delete(n);}},
   helpers:{isAdmin:()=>admin,getHeaderRightContainer:()=>document.querySelector('.headerRight'),getHeaderButtonTray:()=>window.JellyfinEnhanced.headerActions.getTray(),
    getHeaderBottom:()=>document.querySelector('.headerTop').getBoundingClientRect().bottom,onBodyMutation:()=>({unsubscribe(){}}),
    addCSS:(id,css)=>{if(document.getElementById(id))return;const s=document.createElement('style');s.id=id;s.textContent=css;document.head.appendChild(s);}},
   core:{api:{plugin:async(p,o)=>{if(p.endsWith('broadcast')){window.posts.push(o.body);return {sent:1,skipped:0,errors:[]};}window.reads++;return sessions;}},
    lifecycle:{register:()=>{const r=[];return{track:x=>(r.push(x),x),teardown:()=>r.splice(0).forEach(f=>f())};}},navigation:{onNavigate:()=>()=>{}}}};
  window.changeUser=()=>{epoch++;resets.forEach(f=>f());};
 },{admin,sessions});
}

test('header More menu collapses JE actions on a phone width, forwards to originals and expands on desktop',async({page})=>{
 await page.setViewportSize({width:420,height:800});
 await page.route('http://chrome.fixture/**',page0(header));
 await page.goto('http://chrome.fixture/#/home');
 await bridge(page);
 await provideFeatureContext(page); await page.addScriptTag({path:path.join(root,'enhanced/header-actions.js')});
 await page.evaluate(()=>{const tray=window.JellyfinEnhanced.headerActions.getTray();
  for(const id of ['randomItemButton','calendar','requests','bookmarks','downloads','activity','catchup']){const b=document.createElement('button');b.id=id;b.className='headerButton';b.title=id+' title';b.textContent=id[0];b.onclick=()=>{window.clicked=id;};tray.appendChild(b);}});
 const launcher=page.locator('#je-header-launcher');
 await expect(launcher).toBeVisible();
 await expect(page.locator('#randomItemButton')).toBeVisible();
 const row=await page.locator('.headerTop').boundingBox();const tray=await page.locator('#je-header-buttons-group').boundingBox();
 expect(tray.x+tray.width).toBeLessThanOrEqual(row.x+row.width+0.5);
 await launcher.click();
 const dialog=page.getByRole('dialog',{name:'More from JE'});
 await expect(dialog).toBeVisible();
 const box=await dialog.boundingBox();expect(box.x).toBeGreaterThanOrEqual(0);expect(box.x+box.width).toBeLessThanOrEqual(420);
 await page.screenshot({path:test.info().outputPath('header-more-phone.png')});
 await expect(dialog.getByRole('button')).toHaveText(['close','aactivity title','ccatchup title']);
 await dialog.getByRole('button',{name:'activity title'}).focus();await page.keyboard.press('ArrowDown');
 await expect(dialog.getByRole('button',{name:'catchup title'})).toBeFocused();
 await dialog.getByRole('button',{name:'activity title'}).click();
 await expect.poll(()=>page.evaluate(()=>window.clicked)).toBe('activity');
 await expect(dialog).toBeHidden();
 await page.setViewportSize({width:1280,height:800});
 await expect(launcher).toBeHidden();
 for(const id of ['calendar','requests','bookmarks','catchup'])await expect(page.locator('#'+id)).toBeVisible();
 await page.evaluate(()=>window.changeUser());
 // The next account starts with an empty tray (only More); the previous account's actions are gone.
 for(const id of ['randomItemButton','calendar','requests','bookmarks','downloads','activity','catchup'])await expect(page.locator('#'+id)).toHaveCount(0);
 expect(await page.evaluate(()=>[...document.querySelectorAll('#je-header-buttons-group > *')].map(e=>e.id).filter(id=>id!=='je-header-launcher'))).toEqual([]);
 await expect(page.locator('#native-user')).toBeVisible();
});

test('active streams panel shows sessions to an admin, broadcasts, and refuses after an unannounced account change',async({page})=>{
 await page.setViewportSize({width:1280,height:800});
 await page.route('http://chrome.fixture/**',page0(header));
 await page.goto('http://chrome.fixture/#/home');
 const session={UserId:'u2',UserName:'Viewer',Client:'Web',DeviceName:'Chrome',RemoteEndPoint:'10.0.0.5',NowPlayingItem:{Id:'m',Name:'Movie <b>x</b>',RunTimeTicks:600000000,ProductionYear:2020},PlayState:{IsPaused:false,PositionTicks:300000000,PlayMethod:'DirectPlay'}};
 await bridge(page,{sessions:[session]});
 await provideFeatureContext(page); await page.addScriptTag({path:path.join(root,'enhanced/header-actions.js')});
 await page.addScriptTag({path:path.join(root,'extras/active-streams.js')});
 await page.evaluate(()=>window.JellyfinEnhanced.activeStreams.initialize());
 const counter=page.locator('#je-active-streams');
 await expect(counter).toBeVisible();await expect(counter).toHaveAttribute('title','1 active stream');
 await counter.click();
 const panel=page.locator('#je-active-streams-panel');
 await expect(panel).toBeVisible();
 await expect(panel.locator('.je-as-card-title-link')).toHaveText('Movie <b>x</b>');
 await expect(panel).toContainText('10.0.0.5');
 const hb=await page.locator('.headerTop').boundingBox();expect(await panel.evaluate(el=>parseFloat(el.style.top))).toBeGreaterThanOrEqual(hb.y+hb.height);
 await panel.getByRole('button',{name:'Broadcast message to all sessions'}).click();
 await expect(panel.locator('.je-as-broadcast-timeout-row')).toHaveCSS('display','flex');
 await panel.locator('.je-as-broadcast-textarea').fill('Restart soon');
 await page.screenshot({path:test.info().outputPath('active-streams-admin.png')});
 await panel.getByRole('button',{name:'Send'}).click();
 await expect(panel.locator('.je-as-broadcast-result')).toHaveText('Sent to 1 of 1 sessions');
 expect(await page.evaluate(()=>window.posts)).toEqual([{header:null,text:'Restart soon',timeoutMs:10000}]);
 await panel.locator('.je-as-broadcast-cancel').click();
 await panel.getByRole('button',{name:'Broadcast message to all sessions'}).click();
 await panel.locator('.je-as-broadcast-textarea').fill('Second');
 await page.evaluate(()=>window.signIn('viewer-b'));
 await panel.getByRole('button',{name:'Send'}).click();
 await expect(page.locator('#je-active-streams-panel')).toHaveCount(0);
 expect((await page.evaluate(()=>window.posts)).length).toBe(1);
 await page.keyboard.press('Escape');
 await page.mouse.click(5,700);
});

test('splash covers the page, then gives way to the UI exactly once',async({page})=>{
 await page.route('http://chrome.fixture/**',page0('<div id="app"></div>'));
 await page.goto('http://chrome.fixture/');
 await page.evaluate(()=>{window.JellyfinEnhanced={pluginConfig:{EnableCustomSplashScreen:true,SplashScreenImageUrl:'data:image/gif;base64,R0lGODlhAQABAAAAACw='}};});
 await page.addScriptTag({path:path.join(root,'others/splashscreen.js')});
 await page.evaluate(()=>window.JellyfinEnhanced.initializeSplashScreen());
 const splash=page.locator('.je-loading');
 await expect(splash).toBeVisible();
 const box=await splash.boundingBox();const vp=page.viewportSize();expect(box.width).toBe(vp.width);expect(box.height).toBe(vp.height);
 await page.evaluate(()=>{const m=document.createElement('div');m.id='mainAnimatedPage';document.body.appendChild(m);});
 await expect(splash).toHaveCount(0,{timeout:3000});
 await page.evaluate(()=>{window.JellyfinEnhanced.initializeSplashScreen();window.JellyfinEnhanced.hideSplashScreen();});
 await page.waitForTimeout(1200);
 await expect(page.locator('.je-loading')).toHaveCount(0);
});

test('theme selector renders on the preferences page and toggles the daily theme',async({page})=>{
 await page.route('http://chrome.fixture/**',page0('<div class="verticalSection"><h2 class="headerUsername">User</h2><a class="lnkUserProfile">Profile</a></div>'));
 await page.goto('http://chrome.fixture/#/mypreferencesmenu');
 await page.evaluate(()=>{window.ApiClient={getCurrentUserId:()=>'user-a'};window.Dashboard={alert:m=>{window.alerted=m;}};
  window.JellyfinEnhanced={cdn:{url:(s,p)=>'/cdn/'+s+'/'+p}};localStorage.setItem('user-a-lastRandomThemeDate',new Date().toISOString().split('T')[0]);});
 await provideFeatureContext(page); await page.addScriptTag({path:path.join(root,'extras/theme-selector.js')});
 await page.evaluate(()=>{window.JellyfinEnhanced.initializeThemeSelector();document.body.appendChild(document.createElement('i'));});
 const select=page.getByRole('combobox',{name:'Select theme'});
 await expect(select).toBeVisible();await expect(select).toHaveValue('Default');
 const daily=page.getByRole('button',{name:'Toggle random daily theme'});
 await daily.click();await expect(daily).toHaveAttribute('aria-pressed','true');
 expect(await page.evaluate(()=>[localStorage.getItem('user-a-randomThemeEnabled'),window.alerted])).toEqual(['true','Random daily theme turned ON.']);
 await page.screenshot({path:test.info().outputPath('theme-selector.png')});
});
