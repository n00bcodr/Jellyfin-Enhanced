const { test, expect } = require('@playwright/test');
const path = require('node:path'); const {provideFeatureContext}=require('../frontend/helpers/feature-context.cjs'); // canopy K1: ui-kit.js publishes featureContext in production; these fixtures load features without it

// A small journey through the emitted Seerr details scripts in a real browser: real history,
// layout, IntersectionObserver and CSS, with the Seerr facades stubbed behind a fixture page.
const jsRoot = path.resolve(__dirname, '../../Jellyfin.Plugin.JellyfinEnhanced/js');
const scripts = ['seerr-status', 'ui/ui-icons', 'ui/ui-styles', 'modal', ...['styles', 'data', 'seasons', 'badges', 'render', 'actions-tv', 'actions', 'init'].map(part => `moreinfo/more-info-modal-${part}`),
  'hss-discovery-handler', 'issue-reporter', 'seamless-scroll'].map(name => `jellyseerr/${name}.js`);
const fixture = `<!doctype html><html><head></head><body>
  <div class="discover-card" data-tmdb-id="603" data-media-type="movie" style="width:200px;height:120px;background:#333">Discover</div>
  <section id="feed"><div class="itemsContainer"></div></section>
</body></html>`;

async function setup(page) {
  await page.route('http://seerr-details.fixture/**', route => route.fulfill({ contentType: 'text/html', body: fixture }));
  await page.goto('http://seerr-details.fixture/web/index.html#!/home');
  await page.evaluate(() => {
    window.requests = [];
    window.reportCalls = [];
    let epoch = 0;
    const handlers = new Map();
    const css = id => { let el = document.getElementById(id); if (!el) { el = document.createElement('style'); el.id = id; document.head.append(el); } return el; };
    window.ApiClient = { getCurrentUserId: () => 'alice', accessToken: () => 'token', getUrl: value => value, getItem: async () => ({}),
      ajax: async request => (request.url.includes('/status') ? { active: true } : { Items: [] }) };
    window.JellyfinEnhanced = { pluginConfig: { TmdbEnabled: true, JellyseerrEnable4KRequests: true, JellyseerrEnabled: true, JellyseerrShowReportButton: true }, userConfig: {}, t: key => key,
      escapeHtml: value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;'),
      cdn: { flagPng: code => `/flag/${code}.png`, selfhst: file => `/cdn/${file}` }, toast() {}, icon: () => '', IconName: {},
      session: { getEpoch: () => epoch, isCurrent: value => value === epoch, onUserChange: (name, fn) => handlers.set(name, fn) },
      core: { ui: { injectCss: (id, text) => { css(id).textContent = text; }, isTvLayout: () => false }, api: { plugin: async () => ({ results: [] }), fetch: async () => ({ Items: [] }) } },
      helpers: { hydrateAvatarImages() {} },
      requestManager: { fetchWithRetry: async () => ({ json: async () => ({ rt: { criticsScore: 91, criticsRating: 'Fresh', url: 'https://www.rottentomatoes.com/m/matrix' } }) }) },
      jellyseerrAPI: { fetchMovieDetails: async id => ({ id: Number(id), title: `Movie ${id}`, overview: 'Plot', releaseDate: '1999-03-31', backdropPath: '/b.jpg', mediaInfo: window.mediaInfo }),
        followUpOptions: () => undefined, shouldShowAdvanced: () => false, resolveJellyseerrBaseUrl: () => 'https://seerr.test/base', fetchUserQuota: async () => null,
        requestMedia: async (...args) => { window.requests.push(args.slice(0, 4)); return { media: { status: 2, status4k: 3 } }; },
        fetchIssuesForMedia: async () => ({ results: [] }), reportIssue: async () => ({ id: 1 }) },
      jellyseerrUI: { isQuotaError: () => false, buildQuotaChip: () => null, addMainStyles() {} } };
    window.switchAccount = () => { epoch++; handlers.forEach(fn => fn()); };
  });
  await provideFeatureContext(page);  for (const script of scripts) await page.addScriptTag({ path: path.join(jsRoot, script) });
}

const modal = page => page.locator('.je-more-info-modal');

test('a discover card opens the styled modal, ratings fill in, and Back closes it without leaving the page', async ({ page }) => {
  await setup(page);
  const url = page.url();
  await page.locator('.discover-card').click();
  await expect(modal(page)).toHaveClass(/active/);
  await expect(modal(page).locator('h1.title')).toContainText('Movie 603');
  expect(await modal(page).evaluate(element => getComputedStyle(element).position)).toBe('fixed');
  await expect(modal(page).locator('.je-more-info-fact.rt')).toHaveAttribute('href', 'https://www.rottentomatoes.com/m/matrix');
  await expect(modal(page).locator('.je-more-info-fact.jellyseerr')).toHaveAttribute('href', 'https://seerr.test/base/movie/603');
  // The core icon library draws the button at the size its stylesheet gives Seerr buttons.
  const icon = await modal(page).locator('.jellyseerr-request-button svg').first().evaluate(element => {
    const { width, height } = element.getBoundingClientRect();
    return { width, height, size: parseFloat(getComputedStyle(element).fontSize) };
  });
  expect(icon.width).toBeCloseTo(icon.size * 1.2, 0);
  expect(icon.height).toBeCloseTo(icon.size * 1.2, 0);
  await page.goBack();
  await expect(modal(page)).toHaveCount(0);
  expect(page.url()).toBe(url);
});

test('the 4K menu sends one request; leaving with it open sends none', async ({ page }) => {
  await setup(page);
  await page.locator('.discover-card').click();
  await expect(modal(page)).toHaveClass(/active/);
  await page.locator('.jellyseerr-split-arrow').click();
  await expect(page.locator('.je-4k-popup')).toBeVisible();
  await page.locator('.modal-close').click();
  await expect(modal(page)).toHaveCount(0);
  await expect(page.locator('.je-4k-popup')).toHaveCount(0);
  expect(await page.evaluate(() => window.requests.length)).toBe(0);

  await page.locator('.discover-card').click();
  await expect(modal(page)).toHaveClass(/active/);
  await page.locator('.jellyseerr-split-arrow').click();
  await page.locator('.je-4k-popup-item').click();
  await expect(modal(page).locator('.je-status-chip')).toHaveText('4K jellyseerr_btn_requested');
  await expect(page.locator('.je-4k-popup')).toHaveCount(0);
  expect(await page.evaluate(() => window.requests)).toEqual([[603, 'movie', {}, true]]);
});

test('Escape closes a dialog on top and leaves the modal; a second one closes the modal', async ({ page }) => {
  await setup(page);
  await page.locator('.discover-card').click();
  await expect(modal(page)).toHaveClass(/active/);
  await page.evaluate(() => window.JellyfinEnhanced.jellyseerrIssueReporter.showReportModal(603, 'Movie 603', 'movie'));
  await expect(page.locator('.jellyseerr-season-modal.show')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.jellyseerr-season-modal')).toHaveCount(0);
  await expect(modal(page)).toHaveClass(/active/);
  await page.keyboard.press('Escape');
  await expect(modal(page)).toHaveCount(0);
});

test('an account change closes the modal and its menu at once, and nothing in them can request', async ({ page }) => {
  await setup(page);
  await page.locator('.discover-card').click();
  await expect(modal(page)).toHaveClass(/active/);
  await page.locator('.jellyseerr-split-arrow').click();
  const clicked = await page.evaluate(() => {
    const request = document.querySelector('.jellyseerr-split-main');
    window.switchAccount();
    request.click();
    return { closing: document.querySelector('.je-more-info-modal')._isClosing, menus: document.querySelectorAll('.je-4k-popup').length };
  });
  expect(clicked).toEqual({ closing: true, menus: 0 });
  await expect(modal(page)).toHaveCount(0);
  expect(await page.evaluate(() => window.requests.length)).toBe(0);
});

test('the scroll engine waits under the modal, then fills a real buffer when it closes', async ({ page }) => {
  await setup(page);
  await page.locator('.discover-card').click();
  await expect(modal(page)).toHaveClass(/active/);
  await page.evaluate(() => {
    window.loads = 0;
    const list = document.querySelector('#feed .itemsContainer');
    window.scrollState = {};
    window.JellyfinEnhanced.seamlessScroll.setupInfiniteScroll(window.scrollState, '#feed', async () => {
      window.loads++;
      for (let index = 0; index < 4; index++) {
        const card = document.createElement('div');
        card.className = 'card';
        card.style.cssText = 'height:400px;margin:4px;background:#222';
        list.append(card);
      }
      return { pages: 1, rendered: 4 };
    }, () => window.loads < 60, () => false);
  });
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => window.loads)).toBe(0);
  await page.locator('.modal-close').click();
  await expect(modal(page)).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.loads)).toBeGreaterThan(1);
  await expect.poll(() => page.evaluate(() => document.querySelector('.je-scroll-sentinel').getBoundingClientRect().top - window.innerHeight >= Math.max(window.innerHeight * 3, 2400))).toBe(true);
  const settled = await page.evaluate(() => window.loads);
  await page.waitForTimeout(150);
  expect(await page.evaluate(() => window.loads)).toBe(settled);
});
