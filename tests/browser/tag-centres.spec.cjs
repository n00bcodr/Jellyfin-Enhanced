const { test, expect } = require('@playwright/test');
const path = require('node:path');
const { readFileSync } = require('node:fs');
const root = path.resolve(__dirname, '../../Jellyfin.Plugin.JellyfinEnhanced/js');
const iconFont = readFileSync(path.join(root, 'fonts/materialsymbolsoutlined-subset.woff2')).toString('base64');
const english = require('../../Jellyfin.Plugin.JellyfinEnhanced/js/locales/en.json');
const errorsFor = new WeakMap();

test.beforeEach(async ({ page }) => {
  const errors = [];
  errorsFor.set(page, errors);
  page.on('pageerror', error => errors.push(String(error)));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
});

test.afterEach(async ({ page }, info) => {
  await page.screenshot({ path: info.outputPath('geometry.png'), animations: 'disabled' });
  expect(errorsFor.get(page)).toEqual([]);
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
    @font-face { font-family: 'JE Material Symbols Outlined'; src: url(data:font/woff2;base64,${iconFont}); }
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
      tagPipeline: { renderers: {}, registerRenderer(name, renderer) { this.renderers[name] = renderer; renderer.injectCss?.(); }, clearProcessed() {}, scheduleScan() {} },
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
  test(`${slot} keeps its lone oversized quality label with an ellipsis`, async ({ page, request }) => {
    await setup(page, request);
    await qualityCard(page, { slot, width: 64 });
    const chip = page.locator('.quality-overlay-label');
    await expect(chip).toHaveText('Dolby Vision');
    await expect(chip).toBeVisible();
    await expect(chip).toHaveAttribute('data-je-fit-width', '');
    const text = chip.locator('.je-tag-fit-text');
    await expect(text).toHaveCSS('text-overflow', 'ellipsis');
    expect(await text.evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true);
    await expect(page.locator('.je-tag-more')).toBeHidden();
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

for (const slot of ['ml', 'mr']) {
  test(`${slot} shows its genre name on hover while excess icons stay hidden`, async ({ page, request }) => {
    await setup(page, request, { genreTagsEnabled: true, genreTagsPosition: slot === 'ml' ? 'center-left' : 'center-right' });
    await page.addScriptTag({ path: path.join(root, 'tags/genretags.js') });
    await page.evaluate(() => {
      const JE = JellyfinEnhanced;
      JE.initializeGenreTags();
      document.querySelector('#cards').innerHTML = '<div class="card"><div class="cardBox"><div class="cardScalable" style="width:180px;height:80px"><div class="cardImageContainer"></div><div class="je-tag-host"></div></div><div class="cardText">Genre hover</div></div></div>';
      JE.tagPipeline.renderers.genre.renderFromServerCache(document.querySelector('.je-tag-host'), { Type: 'Movie', Genres: ['Drama', 'Crime', 'Thriller'] }, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
      JE.core.tagLayout.flushFit();
    });
    await expect(page.locator('.genre-tag:not([data-je-overflow])')).toHaveCount(1);
    await expect(page.locator('.je-tag-more')).toHaveText('+2');
    await page.locator('.card').hover();
    const label = page.locator('.genre-tag:not([data-je-overflow]) .genre-text');
    await expect(label).toHaveCSS('opacity', '1');
    const visibleFraction = await label.evaluate(label => {
      const r = label.getBoundingClientRect();
      let left = r.left, right = r.right, top = r.top, bottom = r.bottom;
      for (let parent = label.parentElement; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent), box = parent.getBoundingClientRect();
        if (['hidden', 'clip', 'auto', 'scroll'].includes(style.overflowX)) { left = Math.max(left, box.left); right = Math.min(right, box.right); }
        if (['hidden', 'clip', 'auto', 'scroll'].includes(style.overflowY)) { top = Math.max(top, box.top); bottom = Math.min(bottom, box.bottom); }
      }
      return Math.max(0, right - left) * Math.max(0, bottom - top) / (r.width * r.height);
    });
    expect(visibleFraction).toBeGreaterThan(0.99);
  });
}

for (const slot of ['ml', 'mr']) {
  test(`${slot} bounds a long hover name before the opposite Status badge`, async ({page,request}) => {
    await setup(page,request,{genreTagsEnabled:true,genreTagsPosition:slot==='ml'?'center-left':'center-right'});
    await page.addScriptTag({path:path.join(root,'tags/genretags.js')});
    await page.evaluate(slot=>{
      const JE=JellyfinEnhanced,L=JE.core.tagLayout;
      JE.initializeGenreTags();
      document.querySelector('#cards').innerHTML='<div class="card"><div class="cardBox"><div class="cardScalable" style="width:180px;height:260px"><div class="cardImageContainer"></div><div class="je-tag-host"></div></div></div></div>';
      const host=document.querySelector('.je-tag-host');
      JE.currentSettings.tagLayouts={corners:{groups:[{group:'genre',slot},{group:'status',slot:slot==='ml'?'mr':'ml'}]}};L.invalidateSettings();
      JE.tagPipeline.renderers.genre.renderFromServerCache(host,{Type:'Movie',Genres:['Science Fiction']},'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
      const status=document.createElement('div');status.innerHTML='<span class="status-tag" style="width:70px;height:20px;display:block">Added</span>';L.commitGroup(host,'status',status);L.flushFit();
    },slot);
    await page.locator('.card').hover();
    const distance=await page.evaluate(slot=>{const name=document.querySelector('.genre-text').getBoundingClientRect(),status=document.querySelector('.status-tag').getBoundingClientRect();return slot==='ml'?status.left-name.right:name.left-status.right;},slot);
    expect(distance).toBeGreaterThanOrEqual(3.9);
    await expect(page.locator('.genre-text')).toHaveCSS('opacity','1');
  });
}
