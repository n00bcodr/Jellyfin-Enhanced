// Details-providers rewrite: a real-browser journey over the production emitted
// scripts with an intercepted local fixture (no Jellyfin host, no network).
const { test, expect } = require('@playwright/test');
const path = require('node:path'); const {provideFeatureContext}=require('../frontend/helpers/feature-context.cjs'); // canopy K1: ui-kit.js publishes featureContext in production; these fixtures load features without it
const root = path.resolve(__dirname, '../../Jellyfin.Plugin.JellyfinEnhanced/js');
const SCRIPTS = ['enhanced/itemdetails/features-details-media-info.js', 'enhanced/itemdetails/features-release-dates.js', 'enhanced/itemdetails/features-details-page.js',
  'elsewhere/reviews.js', 'awards/awards.js', 'others/letterboxd-links.js', 'extras/colored-ratings.js'];
const PAGE = `<!doctype html><html><head></head><body>
  <div id="itemDetailPage" class="page libraryPage itemDetailPage">
    <div class="itemMiscInfo itemMiscInfo-primary"><div class="mediaInfoItem">2024</div><div class="mediaInfoItem mediaInfoOfficialRating">DE-16</div></div>
    <select class="selectSource"></select>
    <div class="detailSectionContent"><div class="itemExternalLinks"><a class="button-link" href="https://www.imdb.com/title/tt1">IMDb</a></div></div>
    <div class="tagline"></div>
  </div></body></html>`;

async function setup(page) {
  await page.route('http://details.fixture/**', route => route.fulfill({ contentType: 'text/html', body: PAGE }));
  await page.goto('http://details.fixture/web/index.html#!/details?id=one');
  await page.evaluate(() => {
    let epoch = 0; const users = new Map(); const views = []; window.calls = []; window.saved = []; window.reviews = [];
    window.items = { one: { Id: 'one', Type: 'Movie', Name: 'One', ProviderIds: { Tmdb: '1', Imdb: 'tt1' }, MediaSources: [{ Id: 'src' }] },
      two: { Id: 'two', Type: 'Movie', Name: 'Two', ProviderIds: { Tmdb: '2', Imdb: 'tt2' } } };
    window.hold = null;
    window.lookups = [];
    // Each lookup records which production script asked (addScriptTag sets sourceURL).
    const lookup = id => { window.lookups.push({ id, stack: String(new Error().stack) }); return window.hold && id === window.hold.id ? window.hold.promise : Promise.resolve(window.items[id] ?? null); };
    const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    window.ApiClient = { getCurrentUserId: () => 'user-a', serverId: () => 'server', accessToken: () => 'token',
      getUrl: p => `http://details.fixture${p.startsWith('/') ? '' : '/'}${p}`, getItem: (_u, id) => lookup(id),
      getCurrentUser: async () => ({ Id: 'user-a', Policy: { IsAdministrator: false } }) };
    window.JellyfinEnhanced = {
      internals: {}, currentSettings: { showWatchProgress: true, showFileSizes: true }, pluginConfig: { ShowUserReviews: true, ShowAwards: true, LetterboxdEnabled: true, ShowLetterboxdLinkAsText: true, ColoredRatingsEnabled: true },
      session: { getEpoch: () => epoch, isCurrent: e => e === epoch, onUserChange: (name, fn) => users.set(name, fn) },
      t: (key, params) => params ? `${key} ${Object.values(params).join(' ')}` : key, escapeHtml, toast() {}, icon: () => '★', IconName: { STAR: 'star' },
      cdn: { url: (source, file) => `http://details.fixture/cdn/${source}/${file}`, selfhst: p => `http://details.fixture/cdn/${p}` },
      saveUserSettings: async (file, doc) => { window.saved.push([file, JSON.parse(JSON.stringify(doc))]); },
      helpers: {
        getItemCached: id => lookup(id), addCSS(id, css) { const s = document.createElement('style'); s.id = id; s.textContent = css; document.head.appendChild(s); },
        debounce: (fn, wait) => { let timer; return () => { clearTimeout(timer); timer = setTimeout(fn, wait); }; },
        createObserver: (_name, fn, target, config) => { const o = new MutationObserver(fn); o.observe(target, config); return o; },
        onViewPage: fn => { views.push(fn); return () => {}; }, onNavigate: () => () => {}, getExternalLinkIconSize: () => 20,
        createExternalLink: (href, options = {}) => { const a = document.createElement('a'); a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer'; if (options.className) a.className = options.className; if (options.title) a.title = options.title; if (options.text) a.textContent = options.text; return a; }
      },
      core: { navigation: { onViewPage: fn => views.push(fn), onNavigate() {} },
        api: { manager: { clearCacheMatching() {} }, fetch: async url => { window.calls.push(url); return { results: [] }; },
          plugin: async (p, options) => {
            window.calls.push(`${options?.method || 'GET'} ${p}`);
            if (p.startsWith('/item-stats/')) return { size: 3 * 1073741824, progress: 25, totalPlaybackTicks: 1, totalRuntimeTicks: 4 };
            if (p.startsWith('/awards/')) return { Found: true, Confirmed: true, Wins: 1, Nominations: 2, Awards: [{ Name: `Academy Award for ${p}`, Result: 'Won', Year: 2024 }] };
            if (p.startsWith('/reviews/')) {
              if (options?.method === 'POST') { window.reviews = [{ userId: 'user-a', userName: 'Me', ...options.body }]; return {}; }
              return { reviews: window.reviews };
            }
            return {};
          } } }
    };
    window.showView = () => views.forEach(fn => fn('itemDetailPage', document.getElementById('itemDetailPage'), location.hash, null, { target: document.getElementById('itemDetailPage'), detail: { params: { id: new URLSearchParams(location.hash.split('?')[1]).get('id') } } }));
    window.changeAccount = () => { epoch++; users.forEach(fn => fn()); };
  });
  await provideFeatureContext(page);  for (const file of SCRIPTS) await page.addScriptTag({ path: path.join(root, file) });
  await page.evaluate(() => {
    const JE = window.JellyfinEnhanced;
    JE.initializeReviewsScript(); JE.initializeAwardsScript(); JE.initializeLetterboxdLinksScript(); JE.initializeColoredRatings();
  });
}

test('details page journey: chips, rating colour, Letterboxd, awards, a review written and read back', async ({ page }) => {
  const errors = []; page.on('pageerror', error => errors.push(String(error)));
  await setup(page);
  await page.evaluate(() => { document.querySelector('.itemMiscInfo-primary').append(document.createElement('span')); window.showView(); });
  const row = page.locator('.itemMiscInfo-primary');
  await expect(row.locator('.mediaInfoItem-fileSize')).toHaveText(/3 GB/);
  await expect(row.locator('.mediaInfoItem-watchProgress')).toHaveText(/25%/);
  await row.locator('.mediaInfoItem-watchProgress').click();
  await expect.poll(() => page.evaluate(() => window.saved.at(-1)?.[1].watchProgressMode)).toBe('time');
  await expect(page.locator('.mediaInfoOfficialRating')).toHaveAttribute('rating', 'FSK-16');
  await expect(page.locator('a.letterboxd-link')).toHaveAttribute('href', 'https://letterboxd.com/imdb/tt1');
  await expect(page.locator('.je-awards-section .je-awards-stats')).toHaveText(/awards_wins_count 1/);
  const section = page.locator('.tmdb-reviews-section');
  await expect(section.locator('summary')).toContainText('reviews_title 0');
  await section.locator('summary').click();
  await section.locator('.je-review-write-btn').click();
  await section.locator('textarea').fill('A *fine* film');
  await section.locator('.je-review-submit-btn').click();
  await expect(page.locator('.je-user-review-card .tmdb-review-text em')).toHaveText('fine');
  expect(await page.evaluate(() => window.calls.filter(c => c.startsWith('POST')))).toEqual(['POST /reviews/movie/1']);
  await expect(page.locator('.je-review-write-btn')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('details page journey: a slow item answer after navigating or an account switch leaves the page clean', async ({ page }) => {
  await setup(page);
  // Reviews and awards have each started their visit for the item (and hold its lease).
  const pending = id => page.evaluate(id => ['elsewhere/reviews.js', 'awards/awards.js'].every(file => window.lookups.some(l => l.id === id && l.stack.includes(file))), id);
  await page.evaluate(() => {
    let resolve; window.hold = { id: 'one', promise: new Promise(r => { resolve = r; }) }; window.release = () => resolve(window.items.one);
    window.lookups.length = 0; window.showView();
  });
  await expect.poll(() => pending('one')).toBe(true);
  // Jellyfin reuses the view for the next item, then the old answer arrives.
  await page.evaluate(() => {
    history.replaceState({}, '', '#!/details?id=two');
    // As Jellyfin does for a reused view: the external links row is rebuilt for the new item.
    document.querySelector('.itemExternalLinks').innerHTML = '<a class="button-link" href="https://www.imdb.com/title/tt2">IMDb</a>';
    window.release(); window.hold = null; window.showView();
  });
  const awards = page.locator('.je-awards-section');
  await expect(awards).toHaveCount(1);
  await expect(awards).toContainText('/awards/movie/2');
  await expect(awards).not.toContainText('/awards/movie/1');
  await expect(page.locator('.tmdb-reviews-section')).toHaveCount(1);
  await expect(page.locator('a.letterboxd-link')).toHaveAttribute('href', 'https://letterboxd.com/imdb/tt2');
  expect(await page.evaluate(() => window.calls.filter(c => c.includes('/awards/movie/1') || c.includes('/reviews/movie/1')))).toEqual([]);
  // An account switch while item two is looked up again: the old session's answer is dropped.
  await page.evaluate(() => {
    document.querySelectorAll('.tmdb-reviews-section, .je-awards-section').forEach(n => n.remove());
    let resolve; window.hold = { id: 'two', promise: new Promise(r => { resolve = r; }) }; window.release = () => resolve(window.items.two);
    window.lookups.length = 0; window.calls.length = 0; window.showView();
  });
  await expect.poll(() => pending('two')).toBe(true);
  await page.evaluate(() => { window.changeAccount(); window.release(); window.hold = null; });
  // Let the released answer's promise chains run (no timers are involved in them).
  for (let i = 0; i < 3; i++) await page.evaluate(() => new Promise(r => setTimeout(r, 0)));
  await expect(page.locator('.tmdb-reviews-section, .je-awards-section')).toHaveCount(0);
  expect(await page.evaluate(() => window.calls)).toEqual([]);
  // The new session's own visit renders once.
  await page.evaluate(() => window.showView());
  await expect(page.locator('.je-awards-section')).toHaveCount(1);
  await expect(page.locator('.tmdb-reviews-section')).toHaveCount(1);
});
