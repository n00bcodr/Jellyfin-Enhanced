const { test: base, expect } = require('@playwright/test');
const { installArrRoutes } = require('./arr-fixtures.cjs');

// The Requests page under a stand-in for jellyfin-web 12's router (arr-fixture.html ?host=router): leaving the
// Dashboard replaces the page container (UX-1), and a route the router does not know loses the phone menu (UX-2).
const test = base.extend({
  arr: async ({ page, baseURL }, use) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    const arr = await installArrRoutes(page, { origin: baseURL });
    await use(arr);
    arr.check();
    expect(errors, 'unexpected browser errors').toEqual([]);
  }
});

/** Opens the mock host on a route and waits for production bootstrap. */
async function visit(page, route, width) {
  await page.setViewportSize({ width, height: 844 });
  await page.goto(`/arr?host=router${route}`);
  await expect(page.locator('body')).toHaveAttribute('data-arr-ready', 'true');
}
/** The Requests page is the one page shown, with its tabs and rows. */
async function expectHubShown(page) {
  await expect(page.locator('#je-requests-hub-page .je-hub-tab').first()).toBeVisible();
  await expect(page.locator('#je-requests-hub-page .je-hub-row')).toHaveCount(3);
  const shown = await page.locator('.mainAnimatedPage:not(.hide)').evaluateAll(nodes =>
    nodes.filter(n => n.getClientRects().length).map(n => n.id));
  expect(shown).toEqual(['je-requests-hub-page']);
}
/** The app bar has its phone menu and every header control fits the viewport. */
async function expectPhoneHeader(page) {
  await expect(page.locator('.je-mock-appbar')).toHaveAttribute('data-variant', 'menu');
  await expect(page.locator('#je-notify-bell')).toBeVisible();
  const outside = await page.locator('.skinHeader button, .skinHeader a').evaluateAll(nodes => nodes
    .filter(n => n.getClientRects().length)
    .filter(n => { const r = n.getBoundingClientRect(); return r.left < 0 || r.right > innerWidth; })
    .map(n => n.id || n.getAttribute('aria-label') || n.textContent.trim()));
  expect(outside, 'header controls outside the viewport').toEqual([]);
}

for (const width of [1280, 390]) {
  test(`Requests renders after the plugin configuration page at ${width}px`, async ({ page, arr }) => {
    await visit(page, '#/configurationpage?name=Jellyfin%20Enhanced', width);
    await expect(page.locator('#dashboardPage')).toBeVisible();
    await page.evaluate(() => { location.hash = '#/requests'; });
    await expectHubShown(page);
    // The page lives in the container the host draws now, not the Dashboard's replaced one.
    expect(await page.evaluate(() => document.querySelector('.mainAnimatedPages').contains(document.getElementById('je-requests-hub-page')))).toBe(true);
    if (width < 900) await expectPhoneHeader(page);
  });
}

test('entering Requests from Home keeps the phone header, and leaving restores Home', async ({ page, arr }) => {
  await visit(page, '#/home', 390);
  await expect(page.locator('#route-home')).toBeVisible();
  await expectPhoneHeader(page);
  await page.evaluate(() => { location.hash = '#/requests'; });
  await expectHubShown(page);
  await expectPhoneHeader(page);
  await expect(page).toHaveTitle('Requests');
  await expect(page).toHaveURL(/#\/requests$/);
  await page.goBack();
  await expect(page.locator('#je-requests-hub-page')).toBeHidden();
  await expect(page.locator('#route-home')).toBeVisible();
  await expectPhoneHeader(page);
  await expect(page).toHaveTitle('Home');
});

test('a direct Requests address keeps the phone header', async ({ page, arr }) => {
  await visit(page, '#/requests', 390);
  await expectHubShown(page);
  await expectPhoneHeader(page);
  await expect(page).toHaveURL(/#\/requests$/);
});

/** The ids of the pages shown now. */
const shownPages = page => page.locator('.mainAnimatedPage:not(.hide)').evaluateAll(nodes =>
  nodes.filter(n => n.getClientRects().length).map(n => n.id));

test('leaving for Home from a Requests page entered from Details gives Home its own title', async ({ page, arr }) => {
  await visit(page, '#/details?id=1', 390);
  await expect(page).toHaveTitle('Movie details');
  await page.evaluate(() => { location.hash = '#/requests'; });
  await expectHubShown(page);
  await expect(page).toHaveTitle('Requests');
  await page.evaluate(() => { location.hash = '#/home'; });
  await expect(page.locator('#route-home')).toBeVisible();
  await expect(page).toHaveTitle('Home');
  expect(await shownPages(page)).toEqual(['route-home']);
});

test('leaving for a destination that is still loading shows the page under it, and the left page\'s tabs cannot take the address', async ({ page, arr }) => {
  await visit(page, '#/details?id=1', 390);
  await page.evaluate(() => { location.hash = '#/requests'; });
  await expectHubShown(page);
  await page.evaluate(() => { window.__mockRouter.hold(); location.hash = '#/search'; });
  try {
    await expect(page.locator('#je-requests-hub-page')).toBeHidden();
    // Never a blank page: the page the router waited on under Requests (Home once parked; Details where the
    // router never saw the address) shows until Search is drawn.
    const under = await shownPages(page);
    expect(under).toHaveLength(1);
    expect(['route-home', 'route-details']).toContain(under[0]);
    await page.evaluate(() => document.querySelector('#je-requests-hub-page .je-hub-tab[data-tab="soon"]').click());
    await expect(page).toHaveURL(/#\/search$/);
  } finally {
    await page.evaluate(() => window.__mockRouter.release());
  }
  await expect(page.locator('#route-search')).toBeVisible();
  await expect(page).toHaveTitle('Search');
});

test('a hub tab keeps keyboard focus when leaving the Dashboard replaces the page container', async ({ page, arr }) => {
  await visit(page, '#/configurationpage?name=Jellyfin%20Enhanced', 1280);
  await page.evaluate(() => { window.__mockRouter.hold(); location.hash = '#/requests'; });
  const tab = page.locator('#je-requests-hub-page .je-hub-tab[data-tab="soon"]');
  await tab.focus();
  await expect(tab).toBeFocused();
  await page.evaluate(() => window.__mockRouter.release());
  await expectHubShown(page);
  await expect(page.locator('#je-requests-hub-page .je-hub-tab[data-tab="soon"]')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#je-requests-hub-page .je-hub-tab[data-tab="soon"]')).toHaveAttribute('aria-selected', 'true');
});

// Review r2 probes, ported (the departure cover they probed is gone; the same journeys must end right without it).
/** Enters Requests by address from a details page and waits until it is the one page shown. */
async function enterFromDetails(page) {
  await visit(page, '#/details?id=1', 1280);
  await page.evaluate(() => { location.hash = '#/requests'; });
  await expectHubShown(page);
  await expect(page.locator('#route-home')).toBeHidden();
}

test('a disabled opener cannot leave focus in the hidden page', async ({ page, arr }) => {
  await visit(page, '#/home', 1280);
  await page.evaluate(() => {
    const button = document.createElement('button');
    button.id = 'opener';
    button.textContent = 'Open';
    document.getElementById('route-home').append(button);
    button.focus();
    JellyfinEnhanced.arrHub.show();
  });
  await expectHubShown(page);
  await page.locator('.je-hub-tab').first().focus();
  await page.evaluate(() => { document.getElementById('opener').disabled = true; });
  await page.goBack();
  await expect(page.locator('#je-requests-hub-page')).toBeHidden();
  expect(await page.evaluate(() => document.getElementById('je-requests-hub-page').contains(document.activeElement))).toBe(false);
});

test('a direct Requests address then Home gives Home its exact title', async ({ page, arr }) => {
  await visit(page, '#/requests', 1280);
  await expectHubShown(page);
  await page.waitForTimeout(1400);
  await page.evaluate(() => { location.hash = '#/home'; });
  await expect(page.locator('#route-home')).toBeVisible();
  await expect(page).toHaveTitle('Home');
});

test('a localized title set later is restored, and a removed focused control falls back to the selected tab', async ({ page, arr }) => {
  await enterFromDetails(page);
  await page.evaluate(() => { document.title = 'Accueil — Médiathèque'; });
  await expect(page).toHaveTitle('Requests');
  await page.locator('.je-hub-tab[data-tab="soon"]').focus();
  await page.evaluate(() => {
    // The host swaps the container and keeps its routed pages; the focused tab goes with the old one.
    const old = document.querySelector('.mainAnimatedPages');
    const fresh = document.createElement('div');
    fresh.className = 'mainAnimatedPages';
    old.replaceWith(fresh);
    for (const node of [...old.children]) if (node.id !== 'je-requests-hub-page') fresh.append(node);
    old.querySelector('.je-hub-tab[data-tab="soon"]').remove();
  });
  await expect(page.locator('.je-hub-tab[aria-selected="true"]')).toBeFocused();
  await page.evaluate(() => { location.hash = '#/home'; });
  await expect(page.locator('#route-home')).toBeVisible();
  // Home already mounted under Requests keeps the title set later; where the router never saw the address
  // (capture-first engines) Home is drawn now and sets its own.
  await expect(page).toHaveTitle(/^(Accueil — Médiathèque|Home)$/);
});

test('an open modal keeps focus while the host replaces the page container', async ({ page, arr }) => {
  await enterFromDetails(page);
  await page.locator('.je-hub-tab').first().focus();
  await page.evaluate(() => {
    const dialog = document.createElement('dialog');
    dialog.id = 'review-dialog';
    dialog.innerHTML = '<button id="close">Close</button>';
    document.body.append(dialog);
    dialog.showModal();
  });
  await page.evaluate(() => {
    const old = document.querySelector('.mainAnimatedPages');
    const fresh = document.createElement('div');
    fresh.className = 'mainAnimatedPages';
    old.replaceWith(fresh);
  });
  await expect(page.locator('#close')).toBeFocused();
  await page.evaluate(() => document.getElementById('review-dialog').close());
});

test('Back to Requests while a destination loads, then two quick destinations, end on the last one', async ({ page, arr }) => {
  await enterFromDetails(page);
  await page.evaluate(() => { window.__mockRouter.hold(); location.hash = '#/search'; });
  await page.waitForTimeout(50);
  await page.goBack();
  await expectHubShown(page);
  await page.evaluate(() => { location.hash = '#/search'; });
  await page.waitForTimeout(30);
  await page.evaluate(() => { location.hash = '#/details?id=2'; });
  await page.waitForTimeout(30);
  await page.evaluate(() => window.__mockRouter.release());
  await expect(page.locator('#route-details')).toBeVisible();
  await expect(page.locator('#je-requests-hub-page')).toBeHidden();
  expect(await shownPages(page)).toEqual(['route-details']);
  await expect(page).toHaveTitle('Movie details');
});

test('an unknown destination shows Page not found with its own title', async ({ page, arr }) => {
  await enterFromDetails(page);
  await page.evaluate(() => { location.hash = '#/not-real'; });
  await expect(page.locator('#fallbackPage')).toBeVisible();
  await expect(page.locator('#je-requests-hub-page')).toBeHidden();
  await expect(page).toHaveTitle('Page not found');
});

test('rapid Requests, Search, Home ends on Home without a new native mount', async ({ page, arr }) => {
  await visit(page, '#/home', 1280);
  await page.evaluate(() => { location.hash = '#/requests'; });
  await expectHubShown(page);
  await page.evaluate(() => { window.__mockRouter.hold(); location.hash = '#/search'; });
  await page.waitForTimeout(50);
  await page.evaluate(() => { location.hash = '#/home'; });
  await page.waitForTimeout(50);
  await page.evaluate(() => window.__mockRouter.release());
  await page.waitForTimeout(300);
  expect(await shownPages(page)).toEqual(['route-home']);
  await expect(page).toHaveTitle('Home');
});

test('rapid Requests, away, Requests always ends with the Requests page painted', async ({ page, arr }) => {
  await visit(page, '#/home', 390);
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => { location.hash = '#/requests'; });
    await page.waitForTimeout(10);
    await page.evaluate(() => { location.hash = '#/search'; });
    await page.waitForTimeout(10);
  }
  await page.evaluate(() => { location.hash = '#/requests'; });
  await expectHubShown(page);
  await expectPhoneHeader(page);
  await page.waitForTimeout(1400);
  await expect(page).toHaveTitle('Requests');
});

test('the hidden page\'s controls leave the accessibility tree once the destination takes over', async ({ page, arr }) => {
  await enterFromDetails(page);
  expect(await page.locator('body').ariaSnapshot()).toContain('My requests');
  await page.evaluate(() => { location.hash = '#/search'; });
  await expect(page.locator('#route-search')).toBeVisible();
  expect(await page.locator('body').ariaSnapshot()).not.toContain('My requests');
  expect(await page.evaluate(() => document.getElementById('je-requests-hub-page').contains(document.activeElement))).toBe(false);
});

test('an embedded Calendar does not survive an identity change while the page is removed', async ({ page, arr }) => {
  arr.data.hub.admin.calendar = true;
  await visit(page, '#/home', 1280);
  await page.evaluate(() => {
    JellyfinEnhanced.calendarPage = { renderForCustomTab(node) { node.innerHTML = '<div id="identity-canary">Previous private calendar</div>'; } };
    JellyfinEnhanced.arrHub.show();
  });
  await page.locator('.je-hub-tab[data-tab="calendar"]').click();
  await expect(page.locator('#identity-canary')).toBeVisible();
  const held = arr.hold('GET /acquire/hub');
  delete arr.data.hub.admin;
  try {
    await page.evaluate(() => {
      const old = document.querySelector('.mainAnimatedPages');
      const fresh = document.createElement('div');
      fresh.className = 'mainAnimatedPages';
      old.replaceWith(fresh);
      ApiClient.getCurrentUserId = () => 'e'.repeat(32);
      JellyfinEnhanced.session.checkNow('identity switch');
    });
    await held.requested;
    await expect(page.locator('#je-requests-hub-page')).toBeVisible();
    await expect(page.locator('#identity-canary')).toHaveCount(0);
  } finally {
    held.release();
  }
});

// Review r3: Firefox stops the #/requests events before the shared navigation module sees them, so a Back to the
// address it saw last was dropped as a repeat; with the host's page still mounted no viewshow came either, and
// Requests stayed shown at Home or Details. Every engine must leave on the history move itself.
test('Back from Requests to a Details page still mounted underneath leaves Requests', async ({ page, arr }) => {
  await visit(page, '#/home', 1280);
  await page.evaluate(() => { location.hash = '#/details?id=1'; });
  await expect(page.locator('#route-details')).toBeVisible();
  await page.evaluate(() => { location.hash = '#/requests'; });
  await expectHubShown(page);
  await page.goBack();
  await expect(page).toHaveURL(/#\/details\?id=1$/);
  await expect(page.locator('#je-requests-hub-page')).toBeHidden();
  // Chromium shows the parked Home for a moment before Details is drawn (the accepted flash).
  await expect.poll(() => shownPages(page)).toEqual(['route-details']);
  await page.waitForTimeout(1400);
  await expect(page).toHaveTitle('Movie details');
});

test('Back from Requests to a Home already routed leaves Requests', async ({ page, arr }) => {
  await visit(page, '#/search', 390);
  await page.evaluate(() => { location.hash = '#/home'; });
  await expect(page.locator('#route-home')).toBeVisible();
  await page.evaluate(() => { location.hash = '#/requests'; });
  await expectHubShown(page);
  await page.goBack();
  await expect(page).toHaveURL(/#\/home$/);
  await expect(page.locator('#je-requests-hub-page')).toBeHidden();
  await expect.poll(() => shownPages(page)).toEqual(['route-home']);
  await page.waitForTimeout(1400);
  await expect(page).toHaveTitle('Home');
});

for (const gap of [0, 40, 150]) {
  test(`rapid addresses then Back and Forward end on the right page (${gap} ms apart)`, async ({ page, arr }) => {
    await visit(page, '#/home', 390);
    await page.evaluate(async gap => {
      for (const hash of ['#/requests', '#/search', '#/requests', '#/details?id=1', '#/requests']) {
        location.hash = hash;
        await new Promise(r => setTimeout(r, gap));
      }
    }, gap);
    await expectHubShown(page);
    await expectPhoneHeader(page);
    await expect(page).toHaveTitle('Requests');
    await page.goBack();
    await expect(page.locator('#route-details')).toBeVisible();
    await expect(page.locator('#je-requests-hub-page')).toBeHidden();
    await expect(page).toHaveTitle('Movie details');
    await page.goForward();
    await expectHubShown(page);
    await expect(page).toHaveTitle('Requests');
    await page.evaluate(() => { location.hash = '#/search'; });
    await expect(page.locator('#route-search')).toBeVisible();
    await page.waitForTimeout(1300);
    await expect(page).toHaveTitle('Search');
    expect(await shownPages(page)).toEqual(['route-search']);
  });
}

// Review r4 probes, ported. The page's history listener no longer stops events (Jellyfin's router, added first, has
// seen them anyway; stopping only starved JE's later listeners, such as the header launcher's close on hashchange),
// and the address as it is now decides, so a queued older Requests hashchange cannot undo a departure.

const state = page => page.evaluate(() => {
 const s=JellyfinEnhanced.internals.arrHub.state;
 return {hash:location.hash,title:document.title,visible:s.visible,visit:s.visit,watch:!!s.watch,titleWatch:!!s.titleWatch,
 shown:[...document.querySelectorAll('.mainAnimatedPage:not(.hide)')].filter(n=>n.getClientRects().length).map(n=>n.id)};
});
async function observe(page) {
 await page.addInitScript(()=>{
  window.__intercepts=[];
  const add=EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener=function(type,fn,options){
   if(this===window && ['popstate','hashchange'].includes(type) && fn.name==='intercept' && new Error().stack.includes('/hub-page.js')) {
    const original=fn;
    fn=function(e){
     const s=JellyfinEnhanced.internals.arrHub.state;
     const before={type,hash:location.hash,newHash:e.newURL?new URL(e.newURL).hash:null,parking:s.parking,before:s.visible,time:performance.now()};
     try{return original.call(this,e);}finally{window.__intercepts.push({...before,after:s.visible,visit:s.visit,watch:!!s.watch,titleWatch:!!s.titleWatch});}
    };
   }
   return add.call(this,type,fn,options);
  };
 });
}
async function subscribers(page) {
 await page.evaluate(()=>{
  window.__later=[];window.__shared=[];
  for(const type of ['popstate','hashchange','je:navigate']) for(const capture of [true,false]) window.addEventListener(type,e=>{
   window.__later.push({type,capture,hash:location.hash,newHash:e.newURL?new URL(e.newURL).hash:null,parking:JellyfinEnhanced.internals.arrHub.state.parking});
  },capture);
  JellyfinEnhanced.core.navigation.onNavigate(e=>window.__shared.push({type:e?.type,hash:location.hash,parking:JellyfinEnhanced.internals.arrHub.state.parking}));
 });
}
async function hub(page) {
 await page.evaluate(()=>{location.hash='#/requests';});await expectHubShown(page);
 await page.waitForTimeout(100);
}
for(const origin of ['home','details']) test('event-time Back cleanup to warmed '+origin+' needs no native commit',async({page,arr})=>{
 await observe(page);await visit(page,'#/search',1280);
 await page.evaluate(origin=>{location.hash=origin==='home'?'#/home':'#/details?id=1';},origin);
 await expect(page.locator('#route-'+origin)).toBeVisible();await hub(page);await subscribers(page);
 await page.evaluate(()=>{window.__mockRouter.hold();window.__intercepts=[];});
 await page.goBack();
 const immediate=await state(page);
 const events=await page.evaluate(()=>({intercepts:window.__intercepts,later:window.__later,shared:window.__shared}));
 expect(immediate.visible).toBe(false);expect(immediate.watch).toBe(false);expect(immediate.titleWatch).toBe(false);
 const departure=events.intercepts.find(x=>x.type==='popstate'&&!x.parking);
 expect(departure).toBeDefined();expect(departure.after).toBe(false);expect(departure.watch).toBe(false);expect(departure.titleWatch).toBe(false);
 // Event delivery is distinct from the shared service's legitimate same-href deduplication.
 expect(events.later.some(x=>x.type==='popstate'&&!x.capture&&x.hash===immediate.hash)).toBe(true);
 await page.evaluate(()=>window.__mockRouter.release());
 await expect(page.locator('#route-'+origin)).toBeVisible();
 await page.waitForTimeout(1400);
 expect(await state(page)).toMatchObject({visible:false,title:origin==='home'?'Home':'Movie details',shown:['route-'+origin]});
});
for(const delay of [0,5,40]) test('Back immediately followed by Forward at '+delay+' ms',async({page,arr})=>{
 await observe(page);await visit(page,'#/details?id=1',390);await hub(page);
 await page.evaluate(delay=>{
  window.__intercepts=[];
  window.addEventListener('popstate',function forward(){if(location.hash==='#/details?id=1'){
   window.removeEventListener('popstate',forward,true);setTimeout(()=>history.forward(),delay);
  }},true);
  history.back();
 },delay);
 await page.waitForFunction(()=>window.__intercepts.some(x=>x.type==='popstate'&&x.hash==='#/details?id=1'&&!x.after));
 await expect(page).toHaveURL(/#\/requests$/);await expectHubShown(page);await expectPhoneHeader(page);
 await page.waitForTimeout(1400);expect(await state(page)).toMatchObject({visible:true,title:'Requests',shown:['je-requests-hub-page']});
 await page.evaluate(()=>{location.hash='#/search';});await expect(page.locator('#route-search')).toBeVisible();
 await page.waitForTimeout(1400);expect(await state(page)).toMatchObject({visible:false,title:'Search',shown:['route-search']});
});
for(const method of ['hash','replace']) test('Requests query-only changes keep the same visible visit via '+method,async({page,arr})=>{
 await observe(page);await visit(page,'#/home',390);await hub(page);await subscribers(page);
 const before=await state(page);
 await page.evaluate(method=>{
  window.__intercepts=[];
  for(const hash of ['#/requests?tab=soon','#/requests?tab=ready&serverId=fixture','#/requests?tab=mine']){
   if(method==='replace')history.replaceState(history.state,'',hash);else location.hash=hash;
  }
 },method);
 await page.waitForTimeout(1500);
 const after=await state(page);
 expect(after).toMatchObject({visible:true,visit:before.visit,title:'Requests',shown:['je-requests-hub-page']});
 expect(await page.locator('.je-hub-tab[data-tab="mine"]').getAttribute('aria-selected')).toBe('true');
 expect((await page.evaluate(()=>window.__intercepts)).some(x=>x.before&&!x.after)).toBe(false);
});
test('synthetic parking popstate keeps the hub; genuine Home popstate leaves it',async({page,arr})=>{
 await observe(page);await visit(page,'#/requests',390);await expectHubShown(page);
 const entry=await page.evaluate(()=>window.__intercepts);
 const parked=entry.filter(x=>x.type==='popstate'&&x.parking);
 expect(parked.length).toBeGreaterThan(0);for(const e of parked){expect(e.hash).toBe('#/home');expect(e.after).toBe(true);}
 await subscribers(page);
 const result=await page.evaluate(()=>{
  history.replaceState(history.state,'','#/home');
  // A host that dispatches its own popstate after a real replaceState departure.
  window.dispatchEvent(new PopStateEvent('popstate',{state:history.state}));
  const s=JellyfinEnhanced.internals.arrHub.state;return {visible:s.visible,watch:!!s.watch,titleWatch:!!s.titleWatch,later:window.__later,shared:window.__shared};
 });
 expect(result.visible).toBe(false);expect(result.watch).toBe(false);expect(result.titleWatch).toBe(false);
 expect(result.later.some(x=>x.type==='popstate'&&!x.capture&&x.hash==='#/home')).toBe(true);
 await expect(page.locator('#route-home')).toBeVisible();await page.waitForTimeout(1400);await expect(page).toHaveTitle('Home');
});
test('another JE module replaceState departure reaches shared navigation synchronously',async({page,arr})=>{
 await visit(page,'#/home',1280);await hub(page);await subscribers(page);
 const result=await page.evaluate(()=>{
  history.replaceState(history.state,'','#/search?query=je');
  const s=JellyfinEnhanced.internals.arrHub.state;
  return {visible:s.visible,watch:!!s.watch,titleWatch:!!s.titleWatch,shared:window.__shared,later:window.__later,hash:location.hash};
 });
 expect(result.visible).toBe(false);expect(result.watch).toBe(false);expect(result.titleWatch).toBe(false);
 expect(result.shared).toEqual([{type:'je:navigate',hash:'#/search?query=je',parking:false}]);
 expect(result.later.some(x=>x.type==='je:navigate'&&!x.capture&&x.hash==='#/search?query=je')).toBe(true);
 await page.waitForTimeout(1400);expect(await state(page)).toMatchObject({visible:false,hash:'#/search?query=je'});
});
test('Requests hashchange reaches the shared module and JE listeners added after hub initialization',async({page,arr})=>{
 await visit(page,'#/home',390);await subscribers(page);await hub(page);
 await page.evaluate(()=>{window.__later=[];window.__shared=[];location.hash='#/requests?tab=soon';});
 await expect(page.locator('.je-hub-tab[data-tab="soon"]')).toHaveAttribute('aria-selected','true');
 await page.waitForTimeout(100);
 const result=await page.evaluate(()=>({shared:window.__shared,later:window.__later}));
 expect(result.shared.some(x=>x.hash==='#/requests?tab=soon'&&!x.parking)).toBe(true);
 expect(result.later.some(x=>x.type==='hashchange'&&x.newHash==='#/requests?tab=soon')).toBe(true);
});
test('production header launcher closes on Requests query-only hashchange',async({page,arr})=>{
 await visit(page,'#/home',390);await hub(page);
 await page.evaluate(()=>{
  const tray=JellyfinEnhanced.headerActions.getTray();
  for(let i=0;i<8;i++){const b=document.createElement('button');b.className='headerButton';b.id='review-source-'+i;b.title='Review action '+i;b.textContent='Action '+i;b.style.width='80px';tray.append(b);}
 });
 await page.locator('#je-header-launcher').click();
 await expect(page.locator('#je-header-launcher-panel')).toHaveAttribute('open','');
 await page.evaluate(()=>{location.hash='#/requests?tab=soon';});
 await expect(page.locator('.je-hub-tab[data-tab="soon"]')).toHaveAttribute('aria-selected','true');
 await page.waitForTimeout(1400);
 await expect(page.locator('#je-header-launcher-panel')).not.toHaveAttribute('open','');
});

// A different JE module can replace the address in the same task as a hash move;
// its je:navigate cleanup happens before the browser delivers the queued hashchange.
test('a queued Requests tab hashchange cannot undo another module replaceState departure',async({page,arr})=>{
 await observe(page);await visit(page,'#/home',1280);await hub(page);await subscribers(page);
 await page.evaluate(()=>{window.__intercepts=[];location.hash='#/requests?tab=soon';history.replaceState(history.state,'','#/search?query=je');});
 await page.waitForTimeout(1500);
 const result=await state(page);
 expect(result).toMatchObject({hash:'#/search?query=je',visible:false});
});


// Review r5 probes, ported: a router listener added after JE's (late start) or moved behind it (re-registered)
// reads the restored Requests address after a parking and draws "Page not found" again; the page checks afterwards
// and parks it again, so the phone header survives, also with a tab move while the parked Home is pending.
async function setupRouterOrder(page, { late = false } = {}) {
  await page.addInitScript(() => {
    const add = window.addEventListener.bind(window), remove = window.removeEventListener.bind(window);
    window.__routerReads = [];
    window.addEventListener = function (type, fn, opts) {
      if (type === 'popstate' && !window.__routerListener && fn.toString().includes('const path = current()')) {
        const wrapped = e => { window.__routerReads.push({ hash: location.hash, parking: !!window.JellyfinEnhanced?.internals?.arrHub?.state.parking }); return fn.call(window, e); };
        window.__routerListener = { wrapped, opts };
        return add(type, wrapped, opts);
      }
      return add(type, fn, opts);
    };
    window.__moveRouterLast = () => { const r = window.__routerListener; remove('popstate', r.wrapped, r.opts); add('popstate', r.wrapped, r.opts); };
  });
  if (late) await page.route('**/arr?*', async route => {
    const response = await route.fetch();
    let html = await response.text();
    html = html.replace('(function mockRouter() {', 'window.__startMockRouter = function mockRouter() {').replace('})();\n</script>', '};\n</script>');
    html = html.replace("document.body.dataset.arrReady = 'true';", "window.__startMockRouter();\n    document.body.dataset.arrReady = 'true';");
    await route.fulfill({ response, body: html });
  });
  await page.setViewportSize({ width: 390, height: 844 });
}
async function visitOrdered(page, mode, hash = '#/details?id=1') {
  await page.goto('/arr?host=router' + hash);
  await expect(page.locator('body')).toHaveAttribute('data-arr-ready', 'true');
  if (mode === 'reregister') await page.evaluate(() => window.__moveRouterLast());
}
const readOrder = page => page.evaluate(() => ({ hash: location.hash, title: document.title, length: history.length,
  visible: JellyfinEnhanced.internals.arrHub.state.visible, menu: !!document.querySelector('[aria-label="Open menu"]'),
  bar: document.querySelector('.je-mock-appbar')?.dataset.variant,
  shown: [...document.querySelectorAll('.mainAnimatedPage:not(.hide)')].filter(n => n.getClientRects().length).map(n => n.id),
  router: window.__routerReads }));
async function stableHubOrder(page) {
  await expect(page.locator('.je-hub-tab').first()).toBeVisible();
  await page.waitForTimeout(1400);
  expect(await readOrder(page)).toMatchObject({ visible: true, title: 'Requests', bar: 'menu', shown: ['je-requests-hub-page'] });
}

for (const mode of ['normal', 'late', 'reregister']) {
  test(`parking keeps history and the Back title with a ${mode} router`, async ({ page, arr }) => {
    await setupRouterOrder(page, { late: mode === 'late' });
    await visitOrdered(page, mode);
    const before = await readOrder(page);
    await page.evaluate(() => { location.hash = '#/requests'; });
    await stableHubOrder(page);
    const entered = await readOrder(page);
    expect(entered.length).toBe(before.length + 1);
    expect(entered.router.some(e => e.hash === '#/home' && e.parking)).toBe(true);
    await page.goBack();
    await expect(page.locator('#route-details')).toBeVisible();
    await page.waitForTimeout(1400);
    expect(await readOrder(page)).toMatchObject({ hash: '#/details?id=1', visible: false, title: 'Movie details', shown: ['route-details'], length: entered.length });
    await page.goForward();
    await stableHubOrder(page);
    expect((await readOrder(page)).length).toBe(entered.length);
  });
}

for (const mode of ['late', 'reregister']) {
  test(`a router added after JE survives a tab move while its parked Home is pending (${mode})`, async ({ page, arr }) => {
    await setupRouterOrder(page, { late: mode === 'late' });
    await visitOrdered(page, mode);
    await page.evaluate(() => {
      const observer = new MutationObserver(() => {
        if (!document.getElementById('fallbackPage') || window.__queryInjected) return;
        window.__queryInjected = true;
        // A tab move after "Page not found" appears, before the parked Home is drawn.
        setTimeout(() => { location.hash = '#/requests?tab=soon'; }, 0);
      });
      observer.observe(document.body, { childList: true, subtree: true });
      location.hash = '#/requests';
    });
    await page.waitForTimeout(1500);
    expect(await page.evaluate(() => window.__queryInjected)).toBe(true);
    expect(await readOrder(page)).toMatchObject({ hash: '#/requests?tab=soon', visible: true, title: 'Requests', bar: 'menu', shown: ['je-requests-hub-page'] });
    await page.goBack();
    await page.waitForTimeout(1400);
    expect(await readOrder(page)).toMatchObject({ hash: '#/requests', visible: true, title: 'Requests', bar: 'menu' });
  });

  test(`a tab move 30 ms after entering keeps the phone header with a ${mode} router`, async ({ page, arr }) => {
    await setupRouterOrder(page, { late: mode === 'late' });
    await visitOrdered(page, mode);
    await page.evaluate(() => { location.hash = '#/requests'; setTimeout(() => { location.hash = '#/requests?tab=soon'; }, 30); });
    await page.waitForTimeout(1500);
    expect(await readOrder(page)).toMatchObject({ hash: '#/requests?tab=soon', visible: true, title: 'Requests', bar: 'menu', shown: ['je-requests-hub-page'] });
  });
}
