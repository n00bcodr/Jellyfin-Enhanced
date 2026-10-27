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
  await expect(page).not.toHaveTitle('Requests');
});

test('a direct Requests address keeps the phone header', async ({ page, arr }) => {
  await visit(page, '#/requests', 390);
  await expectHubShown(page);
  await expectPhoneHeader(page);
  await expect(page).toHaveURL(/#\/requests$/);
});
