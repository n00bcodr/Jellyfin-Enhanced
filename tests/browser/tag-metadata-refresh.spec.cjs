const { test, expect } = require('@playwright/test');
const path = require('node:path');
const { readFileSync } = require('node:fs');
const plugin = path.resolve(__dirname, '../../Jellyfin.Plugin.JellyfinEnhanced');
const english = require('../../Jellyfin.Plugin.JellyfinEnhanced/js/locales/en.json');
const flags = Object.fromEntries(['gb', 'fr', 'jp'].map(code => [code,
  `data:image/webp;base64,${readFileSync(path.join(plugin, 'Assets/PosterTags/flags', `${code}.webp`)).toString('base64')}`]));
const movie = 'a'.repeat(32), other = 'b'.repeat(32);

// Exercise the production pipeline and layout in the mock host, including real
// browser scheduling. Only the tag-cache endpoint and media artwork are fixtures.
for (const replacement of [false, true]) {
  test(`existing language flags refresh after a ${replacement ? 'full replacement' : 'metadata delta'}`, async ({ page }, info) => {
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.route('**/je-metadata-refresh', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body></body></html>' }));
    await page.route('**/favicon.ico', route => route.fulfill({ status: 204 }));
    await page.goto('/je-metadata-refresh');
    await page.setContent(`<style>
      body { background: #222; color: white; font-family: Arial, sans-serif; margin: 20px; }
      #cards { display: flex; flex-wrap: wrap; gap: 20px; margin-top: 20px; }
      .card { width: 150px; }
      .cardScalable { position: relative; height: 220px; background: #444; }
      .cardImageContainer { position: absolute; inset: 0; }
      .cardText { margin-top: 8px; }
    </style><button id="refresh">Receive updated metadata</button><div id="cards">${[movie, movie, other].map((id, index) =>
      `<div class="card" data-id="${id}" data-type="Movie"><div class="cardScalable"><div class="cardImageContainer"></div><div class="cardOverlayContainer"></div></div><div class="cardText">Fixture ${index + 1}</div></div>`).join('')}</div>`);
    await page.evaluate(({ movie, other, replacement, flags, english }) => {
      let changed = false, navigate;
      window.cacheRequests = [];
      window.ApiClient = {
        getCurrentUserId: () => 'fixture-user', getUrl: url => url,
        ajax: async ({ url }) => {
          cacheRequests.push(url);
          if (!url.includes('/tag-cache/')) throw new Error(`Unexpected request: ${url}`);
          const delta = url.includes('since=');
          return { items: delta ? { [movie]: { Type: 'Movie', AudioLanguages: ['en'] } }
            : { [movie]: { Type: 'Movie', AudioLanguages: changed ? ['en'] : ['en', 'fr'] },
                [other]: { Type: 'Movie', AudioLanguages: ['ja'] } },
          count: 2, version: changed && replacement ? 2 : 1, timestamp: changed ? 200 : 100, filterRevision: 'all' };
        }
      };
      window.JellyfinEnhanced = {
        pluginConfig: { TagCacheServerMode: true }, currentSettings: { languageTagsEnabled: true },
        helpers: { onBodyMutation() {}, onNavigate(fn) { navigate = fn; }, addCSS(id, css) {
          let style = document.getElementById(id);
          if (!style) { style = document.createElement('style'); style.id = id; document.head.append(style); }
          style.textContent = css;
        } },
        t: key => english[key] || key, cdn: { flagSvg: code => flags[code] },
        session: { getUserId: () => 'fixture-user', getServerId: () => 'fixture-server', getEpoch: () => 0, isCurrent: () => true, onUserChange() {} },
        _cacheManager: { register() {}, markDirty() {} }
      };
      document.getElementById('refresh').onclick = () => {
        window.unaffectedFlag = document.querySelectorAll('.card')[2].querySelector('.language-flag');
        changed = true;
        location.hash = '#/movies';
        navigate();
      };
    }, { movie, other, replacement, flags, english });
    for (const file of ['core/ui-kit.js', 'core/tag-renderer-base.js', 'core/tag-layout.js', 'tags/tag-layout-styles.js',
      'core/media-language.js', 'tags/tag-pipeline.js', 'tags/languagetags.js']) {
      await page.addScriptTag({ path: path.join(plugin, 'js', file) });
    }
    await page.evaluate(() => {
      JellyfinEnhanced.initializeLanguageTags();
      JellyfinEnhanced.tagPipeline.initialize();
    });
    const readFlags = () => page.locator('.card').evaluateAll(cards => cards.map(card =>
      [...card.querySelectorAll('.language-flag')].map(flag => flag.dataset.lang)));
    await expect.poll(readFlags).toEqual([['gb', 'fr'], ['gb', 'fr'], ['jp']]);
    await expect(page.locator('.language-flag').first()).toBeVisible();
    await info.attach('before-metadata-refresh', { body: await page.screenshot(), contentType: 'image/png' });
    await page.getByRole('button', { name: 'Receive updated metadata' }).click();
    await expect.poll(readFlags).toEqual([['gb'], ['gb'], ['jp']]);
    await expect(page.locator('.language-flag').first()).toBeVisible();
    if (!replacement) expect(await page.evaluate(() =>
      document.querySelectorAll('.card')[2].querySelector('.language-flag') === unaffectedFlag)).toBe(true);
    expect(await page.evaluate(() => cacheRequests.length)).toBe(replacement ? 3 : 2);
    await info.attach('after-metadata-refresh', { body: await page.screenshot(), contentType: 'image/png' });
    expect(errors).toEqual([]);
  });
}
