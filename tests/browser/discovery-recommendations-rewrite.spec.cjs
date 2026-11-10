// The generated discovery and recommendations scripts in a real browser, on the emitted core runtime
// and scroll engine with real layout. Only Seerr's card renderer and the HTTP answers are fixtures.
const { test, expect } = require('@playwright/test');
const path = require('node:path');
const root = path.resolve(__dirname, '../../Jellyfin.Plugin.JellyfinEnhanced/js');
const scripts = ['core/navigation.js', 'core/session.js', 'core/lifecycle.js', 'core/dom-observer.js', 'core/ui-kit.js', 'core/api-client.js',
  'enhanced/helpers.js', 'jellyseerr/seerr-status.js', 'jellyseerr/request-manager.js', 'jellyseerr/seamless-scroll.js',
  'jellyseerr/discovery/discovery-filter-utils.js', 'jellyseerr/discovery/discovery-base.js', 'jellyseerr/discovery/genre-discovery.js',
  ...['styles', 'catalog', 'data', 'render', 'page', 'category', 'init', 'custom-tab'].map(name => `jellyseerr/recommendations/recommendations-${name}.js`)];
const shell = `<!doctype html><html dir="ltr"><head><style>
  body{margin:0;background:#101010;color:#eee;font-family:sans-serif}
  .hide{display:none!important}
  .card{display:inline-block;width:160px;height:240px;margin:4px;background:#333;vertical-align:top}
  .itemsContainer{min-height:10px}
  .emby-scroller{overflow:auto;white-space:nowrap}
  .scrollSlider{display:inline-block;white-space:nowrap}
</style></head><body>
  <div class="jellyfinEnhancedSection"></div>
  <div class="mainAnimatedPages">
    <div class="page libraryPage mainAnimatedPage" id="list"><div class="verticalSection"><div class="itemsContainer"></div></div></div>
    <div class="page mainAnimatedPage hide" id="indexPage"><div class="tabContent is-active" id="home-tab"></div></div>
  </div>
</body></html>`;
const pageOf = (url, base, kind) => {
  const page = Number(url.searchParams.get('page'));
  return { totalPages: 12, results: Array.from({ length: 20 }, (_, index) => ({ id: base + (page - 1) * 20 + index, mediaType: kind })) };
};
function answer(url) {
  const p = url.pathname;
  if (p.endsWith('/JellyfinEnhanced/genre/g1')) return { id: 'g1', name: 'Comedy', type: 'Genre' };
  if (p.endsWith('/tmdb/genres/tv')) return [{ id: 35, name: 'Comedy' }];
  if (p.endsWith('/tmdb/genres/movie')) return [{ id: 36, name: 'Comedy' }];
  if (p.includes('/discover/tv')) return pageOf(url, 1000, 'tv');
  if (p.includes('/discover/trending')) return pageOf(url, 5000, url.searchParams.get('page') % 2 ? 'movie' : 'tv');
  if (p.includes('/discover/')) return pageOf(url, 3000, 'movie');
  return null;
}
// While `holding` is set, feed pages after the first are not answered yet (`release` answers them): a test can then
// see a feed that has re-read only its first page, however fast the engine would go on filling its read-ahead buffer.
const feed = { holding: false, held: [] };
async function release() {
  feed.holding = false;
  for (const route of feed.held.splice(0)) await route.fulfill({ contentType: 'application/json', body: JSON.stringify(answer(new URL(route.request().url()))) }).catch(() => {});
}
async function boot(page) {
  feed.holding = false;
  feed.held.length = 0;
  await page.route('http://discovery.fixture/**', route => {
    const url = new URL(route.request().url());
    if (feed.holding && url.pathname.includes('/discover/') && url.searchParams.get('page') !== '1') { feed.held.push(route); return; }
    if (url.pathname.startsWith('/JellyfinEnhanced/')) return route.fulfill({ contentType: 'application/json', body: JSON.stringify(answer(url)) });
    return route.fulfill({ contentType: 'text/html', body: shell });
  });
  await page.goto('http://discovery.fixture/web/index.html#/list?genreId=g1');
  await page.evaluate(() => {
    const who = window.who = { user: 'user-a', server: 'server-a' };
    window.ApiClient = {
      getCurrentUserId: () => who.user, serverId: () => who.server, accessToken: () => `token-${who.user}`,
      getUrl: path => `http://discovery.fixture${path}`, getItem: async () => ({})
    };
    window.JellyfinEnhanced = {
      internals: {}, t: key => key, cdn: { selfhst: () => 'data:,' }, nativeTabs: { register() {} },
      pluginConfig: { RecommendationsPageEnabled: true, JellyseerrShowGenreDiscovery: true },
      jellyseerrAPI: { checkUserStatus: async () => ({ active: true }), fetchGenreSlider: async () => [{ id: 7, name: 'Comedy', backdrops: [] }] },
      jellyseerrUI: {
        createJellyseerrCard: item => {
          const card = document.createElement('div');
          card.className = 'card';
          card.dataset.id = String(item.id);
          return card;
        },
        releasePosters() {}
      }
    };
  });
  for (const file of scripts) await page.addScriptTag({ path: path.join(root, file) });
}
const visibleCards = (page, scope) => page.locator(`${scope} .card:visible`);

test('generated discovery and recommendations page, filter, sort, paginate, close and leave no account data', async ({ page }, testInfo) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await boot(page);

  // Discovery: both feeds interleave, and the real engine pages as the viewer scrolls.
  const section = '.jellyseerr-genre-discovery-section';
  await expect(page.locator(`${section} .sectionTitle`)).toHaveText('discovery_more_with_genre');
  await expect.poll(() => page.locator(`${section} .card`).count()).toBeGreaterThan(40);
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  const beforeScroll = await page.locator(`${section} .card`).count();
  await expect.poll(async () => {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    return page.locator(`${section} .card`).count();
  }).toBeGreaterThan(beforeScroll);
  expect(await page.evaluate(sel => {
    const seen = [...document.querySelectorAll(`${sel} .card`)].map(card => card.dataset.id);
    return new Set(seen).size === seen.length;
  }, section)).toBe(true);

  // The filter hides by class, and sorting re-reads the feed from the top.
  await page.locator(`${section} .jellyseerr-filter-btn[data-mode="movies"]`).click();
  await expect(page.locator(`${section} [data-media-type="tv"]`).first()).toBeHidden();
  const sortRequest = page.waitForRequest(request => request.url().includes('sortBy=first_air_date.desc'));
  // Hold the pages after the first, so the re-read first page can be seen before the engine fills its buffer further.
  feed.holding = true;
  await page.locator(`${section} .jellyseerr-sort-select`).selectOption('release_date.desc');
  await sortRequest;
  // Reloaded from page 1: both types are on the page, with the filter still hiding the series.
  await expect.poll(() => page.locator(`${section} .card`).count()).toBe(40);
  await expect(page.locator(`${section} [data-media-type="tv"]`).first()).toBeHidden();
  await expect(page.locator(`${section} .card`).first()).toHaveAttribute('data-id', '1000');
  await release();

  // Standalone page: leaving the list removes its section; rows and tiles render.
  await page.evaluate(() => { window.JellyfinEnhanced.recommendationsPage.showPage(); });
  await expect(page).toHaveURL(/#\/recommendations$/);
  await expect(page.locator(section)).toHaveCount(0);
  await expect(page.locator('#je-recommendations-page .je-recommendations-section')).toHaveCount(9);
  await expect(page.locator('#je-recommendations-page .je-tile-logo').first()).toHaveAttribute('loading', 'lazy');

  // Category page: both media types, filter, sort, and paging through the category's own scroller.
  await page.locator('#je-recommendations-page a.sectionTitleTextButton').first().click();
  const category = '#je-recommendations-category-page';
  await expect(page.locator(`${category}:not(.hide)`)).toHaveCount(1);
  await expect(page.locator('#je-recommendations-page')).toBeHidden();
  await expect.poll(() => page.locator(`${category} .card`).count()).toBeGreaterThan(19);
  await expect(page.locator(`${category} .jellyseerr-filter-btn`)).toHaveCount(3);
  await page.locator(`${category} .jellyseerr-filter-btn[data-mode="tv"]`).click();
  await expect.poll(() => visibleCards(page, category).count()).toBeGreaterThan(0);
  expect(await page.locator(`${category} [data-media-type="movie"]:visible`).count()).toBe(0);
  await page.screenshot({ path: testInfo.outputPath('category.png') });
  await page.locator('#je-recommendations-category-back').click();
  await expect(page.locator('#je-recommendations-page')).toBeVisible();
  await expect(page.locator(`${category} .card`)).toHaveCount(0);
  await expect(page).toHaveURL(/#\/recommendations$/);
  await expect(page.locator('#je-recommendations-page .je-recommendations-section')).toHaveCount(9);
  await page.screenshot({ path: testInfo.outputPath('recommendations.png') });

  // Another account: nothing rendered for the first one stays anywhere in the page.
  await page.evaluate(() => { window.who.user = 'user-b'; window.JellyfinEnhanced.session.checkNow('test'); });
  await expect(page.locator('#je-recommendations-page')).toBeHidden();
  await expect(page.locator('#je-recommendations-container .card')).toHaveCount(0);
  expect(await page.evaluate(() => window.JellyfinEnhanced.internals.recommendationsPage.state.renders.size)).toBe(0);
  expect(errors).toEqual([]);
});
