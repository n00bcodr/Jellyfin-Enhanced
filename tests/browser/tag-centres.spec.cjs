const { test, expect } = require('@playwright/test');
const path = require('node:path');
const root = path.resolve(__dirname, '../../Jellyfin.Plugin.JellyfinEnhanced/js');
const english = require('../../Jellyfin.Plugin.JellyfinEnhanced/js/locales/en.json');

test.afterEach(async ({ page }, info) => {
  await page.screenshot({ path: info.outputPath('geometry.png'), animations: 'disabled' });
});

/** Run the production renderers and CSS with actual browser layout, never mocked rectangles. */
async function setup(page, request, settings = {}) {
  if (process.env.JE_BROWSER_LAB_URL) {
    expect((await request.get('/health')).ok()).toBe(true);
    // Keep the fixture on the selected lab origin, isolated from Jellyfin's app boot.
    await page.route('**/je-centres-regression', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body></body></html>' }));
    await page.goto('/je-centres-regression');
  }
  await page.setContent(`<style>
    body { background: #222; color: white; font-family: Arial, sans-serif; }
    #cards { display: flex; flex-wrap: wrap; gap: 30px; padding: 20px; }
    .cardScalable { position: relative; height: 260px; background: #444; }
    .je-tag-host { position: absolute !important; inset: 0; pointer-events: none; overflow: visible; }
  </style><div id="cards"></div>`);
  await page.evaluate(({ english, settings }) => {
    window.JellyfinEnhanced = {
      currentSettings: { tagLayoutSettingsVersion: 1, tagLayout: 'corners', tagLabelDensity: 'full', qualityTagsEnabled: true,
        showResolutionTag: false, showSourceTag: false, showDynamicRangeTag: true, showSpecialFormatTag: false,
        showVideoCodecTag: false, showAudioInfoTag: false, ...settings },
      pluginConfig: {}, t: key => english[key] || key, helpers: {},
      tagPipeline: { renderers: {}, registerRenderer(name, renderer) { this.renderers[name] = renderer; }, clearProcessed() {}, scheduleScan() {} },
    };
  }, { english, settings });
  for (const file of ['core/ui-kit.js', 'core/tag-renderer-base.js', 'core/tag-layout.js', 'tags/tag-layout-styles.js', 'tags/qualitytags.js']) {
    await page.addScriptTag({ path: path.join(root, file) });
  }
  await page.evaluate(() => JellyfinEnhanced.initializeQualityTags());
}

/** Render an actual Dolby Vision chip, optionally sharing its row with a corner stack. */
async function qualityCard(page, { slot, width, corner = false, mixed = false }) {
  await page.evaluate(({ slot, width, corner, mixed }) => {
    const JE = JellyfinEnhanced;
    JE.currentSettings.qualityTagsPosition = JE.core.tagLayout.SLOT_TO_POSITION[slot];
    JE.currentSettings.showResolutionTag = mixed;
    JE.core.tagLayout.invalidateSettings();
    const card = document.createElement('div'); card.className = 'card';
    card.innerHTML = `<div class="cardBox"><div class="cardScalable" style="width:${width}px"><div class="cardImageContainer"></div><div class="je-tag-host"></div></div><div class="cardText">${slot}, ${width}px${corner ? ', occupied corner' : ''}</div></div>`;
    document.querySelector('#cards').append(card);
    const host = card.querySelector('.je-tag-host');
    JE.tagPipeline.renderers.quality.renderFromServerCache(host, {
      Type: 'Movie', StreamData: { Streams: [{ Type: 'Video', Codec: 'hevc', Height: 2160, VideoRangeType: 'DOVIWithHDR10', DisplayTitle: '4K HEVC Dolby Vision' }], Sources: [] },
    }, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    if (corner) {
      const group = document.createElement('div');
      group.innerHTML = '<span style="display:block;width:60px;height:20px">Corner</span>';
      JE.core.tagLayout.commitGroup(host, 'rating', group);
      JE.currentSettings.ratingTagsPosition = 'top-left';
      JE.core.tagLayout.invalidateSettings();
      JE.core.tagLayout.refreshPresentation(host);
    }
    JE.core.tagLayout.flushFit();
  }, { slot, width, corner, mixed });
}

for (const slot of ['tc', 'bc', 'c', 'ml', 'mr']) {
  test(`${slot} hides an oversized quality chip whole and counts it in +N`, async ({ page, request }) => {
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await setup(page, request);
    await qualityCard(page, { slot, width: 64 });
    const chip = page.locator('.quality-overlay-label');
    await expect(chip).toHaveText('Dolby Vision');
    await expect(chip).toBeHidden();
    await expect(page.locator('.je-tag-more')).toBeVisible();
    await expect(page.locator('.je-tag-more')).toHaveText('+1');
    await expect(page.locator('.je-tag-more')).toHaveAttribute('title', 'Dolby Vision');
    expect(errors).toEqual([]);
  });
}

test('top centre fits whole chips plus +N between occupied corners and refits when widened', async ({ page, request }) => {
  await setup(page, request);
  await qualityCard(page, { slot: 'tc', width: 220, corner: true, mixed: true });
  await expect(page.locator('[data-je-slot="tc"] .quality-overlay-label[data-quality="4K"]')).toBeVisible();
  await expect(page.locator('[data-je-slot="tc"] .quality-overlay-label[data-quality="Dolby Vision"]')).toBeHidden();
  await expect(page.locator('.je-tag-more')).toHaveText('+1');
  await expect(page.locator('.je-tag-more')).toBeVisible();
  const geometry = await page.locator('[data-je-slot="tc"]').evaluate(slot => {
    const box = slot.getBoundingClientRect();
    return [...slot.querySelectorAll('[data-je-group] > :not([data-je-overflow]), .je-tag-more:not([data-je-overflow])')].every(chip => {
      const r = chip.getBoundingClientRect();
      return r.left >= box.left - 0.01 && r.right <= box.right + 0.01 && chip.scrollWidth <= chip.clientWidth;
    });
  });
  expect(geometry).toBe(true);
  await page.evaluate(() => {
    document.querySelector('.cardScalable').style.width = '360px';
    JellyfinEnhanced.core.tagLayout.refreshPresentation(document.querySelector('.je-tag-host'));
    JellyfinEnhanced.core.tagLayout.flushFit();
  });
  await expect(page.locator('[data-quality="Dolby Vision"]')).toBeVisible();
  await expect(page.locator('.je-tag-more')).toBeHidden();
});
