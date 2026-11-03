const { test, expect } = require('@playwright/test');
const path = require('node:path');
const root = path.resolve(__dirname, '../../Jellyfin.Plugin.JellyfinEnhanced/js');
const english = require('../../Jellyfin.Plugin.JellyfinEnhanced/js/locales/en.json');

// The caption strip reserves a fixed two-row height and clips what is below
// it. Language codes on desktop (sized by the viewport, not the strip) made a
// row taller than the strip's own chips, so on ~270px posters the second row
// was cut at the bottom. Logos and awards keep chips of their own size too:
// the fitting pass must measure rows against the reserved height and keep
// only those that fit (then "+N").
const CASES = { 'boxed groups': {}, 'logos and awards too': { logoTagsEnabled: true, awardsTagsEnabled: true } };
for (const [name, extra] of Object.entries(CASES)) test(`the caption strip shows only whole rows of chips within its reserved height (${name})`, async ({ page }) => {
  test.setTimeout(90000);
  await page.setContent('<style>body{margin:0;padding:8px}</style><div id="jellyfin-enhanced-panel"><div id="preview" style="width:550px"></div></div>');
  await page.evaluate(({ english, extra }) => {
    window.JellyfinEnhanced = { core: {}, helpers: {}, pluginConfig: {}, currentSettings: { tagLayoutSettingsVersion: 1, tagLayout: 'caption',
      statusTagsEnabled: true, statusTagsTrending: true, statusTagsSchedule: true, qualityTagsEnabled: true, ratingTagsEnabled: true, ageRatingTagsEnabled: true,
      languageTagsEnabled: true, languageTagsStyle: 'codes', languageTagsShowSubtitles: true, genreTagsEnabled: true, ...extra },
      t: (key, params = {}) => Object.entries(params).reduce((s, [k, v]) => s.replaceAll(`{${k}}`, v), english[key] || key),
      tagPipeline: { registerRenderer() {}, clearProcessed() {}, scheduleScan() {} } };
  }, { english, extra });
  for (const file of ['core/ui-kit.js', 'core/media-language.js', 'core/tag-renderer-base.js', 'core/tag-layout.js', 'core/tag-look.js', 'tags/tag-layout-styles.js',
    'tags/rating-sources.js', 'tags/status-vocabulary.js', 'tags/statustags.js', 'tags/qualitytags.js', 'tags/ratingtags.js', 'tags/ageratingtags.js', 'tags/languagetags.js',
    'tags/genretags.js', 'tags/logotags.js', 'tags/awardstags.js', 'enhanced/settingspanel/ui-panel-tag-editor.js', 'enhanced/settingspanel/ui-panel-tag-preview.js']) {
    await page.addScriptTag({ path: path.join(root, file) });
  }
  await page.evaluate(() => { window.preview = JellyfinEnhanced.internals.enhancedUi.createTagPreview(document.querySelector('#preview'), {}); });
  const failures = [];
  let strips = 0;
  for (const width of [262, 550]) {
    for (const scale of ['smaller', 'default', 'larger', 'largest']) {
      for (const density of ['full', 'compact']) {
        const captions = await page.evaluate(async ({ width, scale, density }) => {
          const JE = window.JellyfinEnhanced;
          document.querySelector('#preview').style.width = `${width}px`;
          Object.assign(JE.currentSettings, { tagScale: scale, tagLabelDensity: density });
          window.preview.refresh();
          await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
          JE.core.tagLayout.flushFit();
          return Array.from(document.querySelectorAll('.je-tag-caption')).map((caption) => {
            const box = caption.getBoundingClientRect();
            const chips = Array.from(caption.querySelectorAll(':scope > [data-je-group] > *, :scope > .je-tag-more'))
              .filter((c) => !c.closest('[data-je-overflow]')).map((c) => c.getBoundingClientRect()).filter((r) => r.height > 0);
            return { card: caption.closest('[data-sample]').dataset.sample, chips: chips.length,
              cut: chips.filter((r) => r.bottom > box.bottom + 0.5 || r.top < box.top - 0.5).length };
          });
        }, { width, scale, density });
        for (const c of captions) {
          strips++;
          if (c.cut) failures.push(`${width}px ${scale}/${density} ${c.card}: ${c.cut} of ${c.chips} chips cut by the strip`);
        }
      }
    }
  }
  expect(strips).toBeGreaterThan(0);
  expect(failures).toEqual([]);
});
