// The All / Movies / Series tabs of the Seerr discovery sections and the Recommendations page under a
// community theme's rules, in a real browser's cascade (jsdom does not resolve one). The theme's rule is
// copied verbatim and comes after JE's stylesheet, as jellyfin-web puts the server's custom CSS in the body.
const { test, expect } = require('@playwright/test');
const path = require('node:path');
const root = path.resolve(__dirname, '../../Jellyfin.Plugin.JellyfinEnhanced/js');

// Zesty (stpnwf/ZestyTheme theme.css): "hides trailer tab", unscoped, so every third tab button anywhere.
const ZESTY = 'button.emby-tab-button:nth-child(3) { display: none; }';

test('All, Movies and Series all show under a theme that hides every third tab button (Zesty)', async ({ page }) => {
  await page.setContent(`<div class="jellyseerr-discovery-header" id="section"></div><div class="je-reco-tools" id="page"></div><style>${ZESTY}</style>`);
  await page.evaluate(() => { window.JellyfinEnhanced = { t: key => key, pluginConfig: {} }; });
  for (const file of ['jellyseerr/discovery/discovery-styles.js', 'jellyseerr/discovery/discovery-filter-utils.js']) {
    await page.addScriptTag({ path: path.join(root, file) });
  }
  await page.evaluate(() => {
    for (const id of ['section', 'page']) {
      document.getElementById(id).append(window.JellyfinEnhanced.discoveryFilter.createFilterControl(`theme-${id}`, () => {}));
    }
  });
  for (const id of ['section', 'page']) {
    const tabs = page.locator(`#${id} .jellyseerr-discovery-filter > .jellyseerr-filter-btn`);
    await expect(tabs).toHaveCount(3);
    // (The theme's rule does match Series: it is the group's third button.)
    expect(await tabs.nth(2).evaluate(tab => tab.matches('button.emby-tab-button:nth-child(3)'))).toBe(true);
    for (const mode of ['mixed', 'movies', 'tv']) await expect(page.locator(`#${id} .jellyseerr-filter-btn[data-mode="${mode}"]`)).toBeVisible();
  }
});
