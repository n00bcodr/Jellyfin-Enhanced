const { test, expect } = require('@playwright/test');
const manifest = require('../../Jellyfin.Plugin.JellyfinEnhanced/js/component-scripts.json');

// Exercise the real ordered module list, including registration of the iframe integration.
const modules = manifest.filter(name => [
  'core/dom-observer.js', 'core/lifecycle.js',
  'jellyseerr/api.js', 'jellyseerr/seerr-iframe-mapping.js'
].includes(name));

async function setup(page, { local = true, existing = false } = {}) {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.route('https://requests.example.test/**', route => route.fulfill({
    contentType: 'text/html', body: '<h1>Cloudflare Access</h1>'
  }));
  await page.route('https://seerr.homelab/**', route => route.fulfill({
    contentType: 'text/html', body: '<h1>Local Seerr</h1>'
  }));
  await page.goto('/');
  await page.evaluate(({ local, existing }) => {
    window.ApiClient = { serverAddress: () => local ? 'https://jellyfin.homelab' : 'https://watch.example.test' };
    JellyfinEnhanced.pluginConfig = {
      JellyseerrEnabled: true,
      JellyseerrBaseUrl: 'https://requests.example.test',
      JellyseerrUrlMappings: 'https://watch.example.test|https://requests.example.test\nhttps://jellyfin.homelab|https://seerr.homelab'
    };
    // Same manually configured Requests iframe returned by CustomTabs/Config.
    window.showRequests = (source = 'https://requests.example.test') => {
      document.querySelector('main').innerHTML = `<div class="sections"><iframe class="requestIframe" title="Requests" src="${source}/movie/42?language=en#details"></iframe></div>`;
    };
    if (existing) showRequests();
  }, { local, existing });
  for (const name of modules) await page.addScriptTag({ url: `/Jellyfin.Plugin.JellyfinEnhanced/js/${name}` });
  return errors;
}

for (const existing of [true, false]) {
  test(`local Seerr mapping applies to ${existing ? 'existing' : 'lazy-mounted'} Custom Tabs iframe`, async ({ page }) => {
    const errors = await setup(page, { existing });
    if (!existing) await page.evaluate(() => showRequests());
    const frame = page.locator('iframe[title="Requests"]');
    await expect(frame).toHaveAttribute('src', 'https://seerr.homelab/movie/42?language=en#details');
    await expect(page.frameLocator('iframe[title="Requests"]').getByRole('heading')).toHaveText('Local Seerr');
    // Custom Tabs can discard and rebuild its panels on a later Home visit.
    await page.evaluate(() => showRequests());
    await expect(frame).toHaveAttribute('src', 'https://seerr.homelab/movie/42?language=en#details');
    await expect(page.frameLocator('iframe[title="Requests"]').getByRole('heading')).toHaveText('Local Seerr');
    expect(errors).toEqual([]);
  });
}

test('public Jellyfin retains the public Seerr mapping', async ({ page }) => {
  const errors = await setup(page, { local: false });
  await page.evaluate(() => showRequests('https://seerr.homelab'));
  await expect(page.locator('iframe[title="Requests"]')).toHaveAttribute('src', 'https://requests.example.test/movie/42?language=en#details');
  await expect(page.frameLocator('iframe[title="Requests"]').getByRole('heading')).toHaveText('Cloudflare Access');
  expect(errors).toEqual([]);
});
