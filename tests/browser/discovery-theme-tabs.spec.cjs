// The All / Movies / Series tabs of the Seerr discovery sections and the Recommendations page under a
// community theme's rules, in a real browser's cascade (jsdom does not resolve one). The theme's rule is
// copied verbatim and comes after JE's stylesheet, as jellyfin-web puts the server's custom CSS in the body.
const { test, expect } = require('@playwright/test');
const path = require('node:path');
const root = path.resolve(__dirname, '../../Jellyfin.Plugin.JellyfinEnhanced/js');

// Zesty (stpnwf/ZestyTheme theme.css): "hides trailer tab", unscoped, so every third tab button anywhere.
const ZESTY = 'button.emby-tab-button:nth-child(3) { display: none; }';
// JellyFlix (prayag17/JellyFlix default.css): a bar in ::after, shown on the chosen tab and on hover.
const JELLYFLIX = `.emby-tab-button.emby-tab-button-active::after { transform: scale(1); }
.emby-tab-button::after { content: ""; width: calc(100% - 2em); position: absolute; height: 4px; background: #e50914; border-radius: 10px; transform: scaleX(0); transition: 0.2s; left: 1em; bottom: 0.75em; }`;

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

test('the Recommendations Filters pill, filled while a filter is set, takes no chosen-tab bar through its words (JellyFlix)', async ({ page }) => {
  await page.setContent(`<div class="je-reco-tools" id="bar"></div><style>${JELLYFLIX}</style>`);
  await page.evaluate(() => { window.JellyfinEnhanced = { t: key => key, pluginConfig: {} }; });
  for (const file of ['jellyseerr/discovery/discovery-styles.js', 'jellyseerr/discovery/discovery-filter-utils.js',
    'jellyseerr/discovery/discovery-filters.js', 'jellyseerr/discovery/discovery-filter-panel.js', 'jellyseerr/recommendations/recommendations-styles.js']) {
    await page.addScriptTag({ path: path.join(root, file) });
  }
  await page.evaluate(() => {
    const JE = window.JellyfinEnhanced, bar = document.getElementById('bar');
    JE.discoveryFilter.setFilters('theme-recommendations', { score: ['7', ''] });
    bar.append(JE.discoveryFilter.createFiltersButton(bar, 'theme-recommendations', 'feed', () => {}, { place: () => document.body }));
  });
  const pill = page.locator('#bar .jellyseerr-filters-btn');
  await expect(pill).toHaveAttribute('data-on', '');
  await expect(pill).toHaveClass(/emby-tab-button-active/);
  // The theme's rule does reach it (its bar is shown at full width), and draws nothing.
  const after = await pill.evaluate(button => { const style = getComputedStyle(button, '::after'); return { transform: style.transform, image: style.backgroundImage, colour: style.backgroundColor }; });
  expect(after).toEqual({ transform: 'matrix(1, 0, 0, 1, 0, 0)', image: 'none', colour: 'rgba(0, 0, 0, 0)' });
});
