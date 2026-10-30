const { test, expect } = require('@playwright/test');
const path = require('node:path');
const { readFileSync, mkdirSync, writeFileSync } = require('node:fs');
const { brotliDecompressSync } = require('node:zlib');
const root = path.resolve(__dirname, '../../Jellyfin.Plugin.JellyfinEnhanced');
const fixtures = path.resolve(__dirname, '../fixtures/native-overflow');
const metrics = require('../fixtures/native-overflow/metrics.json');
// Use the actual pipeline's container-query CSS along with the group/layout modules.
const scaleCss = readFileSync(path.join(root, 'js/tags/tag-pipeline.js'), 'utf8').match(/JE\.helpers\.addCSS\('je-tag-card-scale', `([\s\S]*?)`\);/)[1];
const font = brotliDecompressSync(readFileSync(path.join(root, 'Assets/PosterTags/fonts/NotoSans-Bold.ttf.br'))).toString('base64');

// Pin the same bold face and DPR as the native CSS-pixel engine. No mocked rectangles.
test.use({ viewport: { width: 800, height: 600 }, deviceScaleFactor: 1, isMobile: false });

/** Load production chip styles and fitting on an isolated page, optionally using a lab origin. */
async function setup(page, request) {
  if (process.env.JE_BROWSER_LAB_URL) {
    expect((await request.get('/health')).ok()).toBe(true);
    await page.route('**/je-overflow-regression', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body></body></html>' }));
    await page.goto('/je-overflow-regression');
  }
  await page.setContent(`<style>
    @font-face { font-family: 'Noto Sans'; font-weight: 700; src: url(data:font/ttf;base64,${font}); }
    body { margin: 0; color: white; font-family: 'Noto Sans'; }
    .cardScalable { position: relative; width: 180px; height: 270px; container-type: inline-size; background: rgb(70,90,130); }
    .je-tag-host { position: absolute; inset: 0; }
  </style><div class="card"><div class="cardScalable"><div class="je-tag-host"></div></div></div>`);
  await page.evaluate(() => {
    window.JellyfinEnhanced = {
      currentSettings: { tagLayoutSettingsVersion: 1, tagLayout: 'bands', tagLayouts: null, tagLookRules: [], qualityTagsEnabled: true, tagLabelDensity: 'full' },
      pluginConfig: {}, helpers: {}, t: key => key,
      tagPipeline: { registerRenderer(name, renderer) { renderer.injectCss?.(); }, clearProcessed() {}, scheduleScan() {} },
    };
  });
  for (const file of ['core/ui-kit.js', 'core/tag-renderer-base.js', 'core/tag-layout.js', 'tags/tag-layout-styles.js', 'tags/qualitytags.js']) {
    await page.addScriptTag({ path: path.join(root, 'js', file) });
  }
  await page.evaluate(() => JellyfinEnhanced.initializeQualityTags());
  await page.addStyleTag({ content: scaleCss });
  await page.evaluate(() => document.fonts.load('700 11px "Noto Sans"'));
}

test('natural narrow 4I band retains nine chips and +3 with the real +12 reservation', async ({ page, request }) => {
  await setup(page, request);
  await page.evaluate(() => {
    const group = document.createElement('div'); group.className = 'quality-overlay-container';
    for (let i = 0; i < 12; i++) {
      const chip = document.createElement('span'); chip.className = 'quality-overlay-label';
      chip.textContent = '4I'; chip.dataset.quality = '4I'; group.append(chip);
    }
    JellyfinEnhanced.core.tagLayout.commitGroup(document.querySelector('.je-tag-host'), 'quality', group);
    JellyfinEnhanced.core.tagLayout.flushFit();
  });
  await expect(page.locator('.quality-overlay-label:not([data-je-overflow])')).toHaveCount(metrics.narrow.shown);
  await expect(page.locator('.je-tag-more')).toHaveText(metrics.narrow.more);
  const width = await page.locator('.quality-overlay-label').first().evaluate(e => e.getBoundingClientRect().width);
  expect(Math.abs(width - metrics.narrow.qualityWidth)).toBeLessThanOrEqual(metrics.rectTolerance);
});

for (const layout of ['corners', 'bands']) {
  for (const count of [1, 12]) {
    test(`${layout} +${count} matches the overflow metrics and supplies the native pixel oracle`, async ({ page, request }, info) => {
      await setup(page, request);
      await page.evaluate(({ layout, count }) => {
        const host = document.querySelector('.je-tag-host'); host.dataset.jeLayout = layout;
        // A single chip isolates .je-tag-more paint from fitting; the natural case above exercises fitting.
        host.innerHTML = `<div class="je-tag-slot" data-je-slot="${layout === 'bands' ? 'top' : 'tl'}"><span class="je-tag-more">+${count}</span></div>`;
        JellyfinEnhanced.core.ui.injectCss('je-tag-layout', JellyfinEnhanced.core.tagLayout.buildStyles());
      }, { layout, count });
      const rect = await page.locator('.je-tag-more').evaluate(e => {
        const r = e.getBoundingClientRect(), s = getComputedStyle(e);
        return { width: r.width, height: r.height, fontSize: s.fontSize, weight: s.fontWeight, padding: s.padding, radius: s.borderRadius, spacing: s.letterSpacing };
      });
      expect(Math.abs(rect.width - metrics.widths[count])).toBeLessThanOrEqual(metrics.rectTolerance);
      expect(Math.abs(rect.height - metrics.height)).toBeLessThanOrEqual(metrics.rectTolerance);
      expect(rect).toMatchObject({ fontSize: '11px', weight: '700', padding: '2px 5px', radius: '3px', spacing: 'normal' });
      // Isolate the shared overflow tile from the existing band-gradient implementation.
      await page.addStyleTag({ content: '.je-tag-slot { background: none !important; }' });
      const png = await page.locator('.cardScalable').screenshot({ animations: 'disabled' });
      await info.attach('overflow', { body: png, contentType: 'image/png' });
      // Explicit regeneration only, reviewed before committing. Backend tests compare native chip pixels to these Chromium captures.
      if (process.env.JE_UPDATE_OVERFLOW_FIXTURES === '1' && info.project.name === 'chromium') {
        mkdirSync(fixtures, { recursive: true });
        writeFileSync(path.join(fixtures, `${layout}-${count}.png`), png);
      }
    });
  }
}
