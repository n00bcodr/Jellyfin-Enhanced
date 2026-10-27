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
