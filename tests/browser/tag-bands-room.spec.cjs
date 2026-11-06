const { test, expect } = require('@playwright/test');
const path = require('node:path');
const root = path.resolve(__dirname, '../../Jellyfin.Plugin.JellyfinEnhanced/js');
const english = require('../../Jellyfin.Plugin.JellyfinEnhanced/js/locales/en.json');

// The Bands bottom band may wrap to two rows; on a 140px episode still at the
// larger sizes two rows reach up into the top band's status and age chips.
// The bottom band must keep only the rows that fit below them (then "+N").
test('Bands keeps its bottom rows below the top band on short images', async ({ page }) => {
  test.setTimeout(60000);
  await page.setContent('<style>body{margin:0;padding:8px}</style><div id="jellyfin-enhanced-panel"><div id="preview" style="width:262px"></div></div>');
  await page.evaluate((english) => {
    window.JellyfinEnhanced = { core: {}, helpers: {}, pluginConfig: {}, currentSettings: { tagLayoutSettingsVersion: 1, tagLayout: 'bands',
      statusTagsEnabled: true, statusTagsTrending: true, statusTagsSchedule: true, qualityTagsEnabled: true, ratingTagsEnabled: true, ageRatingTagsEnabled: true,
      languageTagsEnabled: true, languageTagsStyle: 'codes', languageTagsShowSubtitles: true },
      t: (key, params = {}) => Object.entries(params).reduce((s, [k, v]) => s.replaceAll(`{${k}}`, v), english[key] || key),
      tagPipeline: { registerRenderer() {}, clearProcessed() {}, scheduleScan() {} } };
  }, english);
  for (const file of ['core/ui-kit.js', 'core/media-language.js', 'core/tag-renderer-base.js', 'core/tag-layout.js', 'core/tag-look.js', 'tags/tag-layout-styles.js',
    'tags/rating-sources.js', 'tags/status-vocabulary.js', 'tags/statustags.js', 'tags/qualitytags.js', 'tags/ratingtags.js', 'tags/ageratingtags.js', 'tags/languagetags.js',
    'enhanced/settingspanel/ui-panel-tag-editor.js', 'enhanced/settingspanel/ui-panel-tag-preview.js']) {
    await page.addScriptTag({ path: path.join(root, file) });
  }
  await page.evaluate(() => { window.preview = JellyfinEnhanced.internals.enhancedUi.createTagPreview(document.querySelector('#preview'), {}); });
  const failures = [];
  let trimmed = 0;
  for (const scale of ['smaller', 'default', 'larger', 'largest']) {
    for (const density of ['full', 'compact']) {
      const cards = await page.evaluate(async ({ scale, density }) => {
        const JE = window.JellyfinEnhanced;
        Object.assign(JE.currentSettings, { tagScale: scale, tagLabelDensity: density });
        window.preview.refresh();
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        JE.core.tagLayout.flushFit();
        const shown = (el) => !el.closest('[data-je-overflow]') && el.getBoundingClientRect().width > 0;
        return Array.from(document.querySelectorAll('[data-sample]')).map((sample) => {
          const host = sample.querySelector('.je-tag-host');
          const top = Array.from(host.querySelectorAll('[data-je-slot="top"] > [data-je-group] > *')).filter(shown).map((c) => c.getBoundingClientRect());
          const bottomSlot = host.querySelector('[data-je-slot="bottom"]');
          const bottom = bottomSlot ? Array.from(bottomSlot.querySelectorAll('[data-je-group] > *, :scope > .je-tag-more')).filter(shown).map((c) => c.getBoundingClientRect()) : [];
          return { card: sample.dataset.sample, topBottom: Math.max(-Infinity, ...top.map((r) => r.bottom)), bottomTop: Math.min(Infinity, ...bottom.map((r) => r.top)),
            hostBottom: host.getBoundingClientRect().bottom, lowest: Math.max(-Infinity, ...bottom.map((r) => r.bottom)),
            hidden: bottomSlot ? bottomSlot.querySelectorAll('[data-je-group] > [data-je-overflow]').length : 0 };
        });
      }, { scale, density });
      for (const c of cards) {
        if (c.bottomTop < c.topBottom - 0.5) failures.push(`${scale}/${density} ${c.card}: bottom band reaches ${(c.topBottom - c.bottomTop).toFixed(1)}px into the top band`);
        if (c.lowest > c.hostBottom + 0.5) failures.push(`${scale}/${density} ${c.card}: bottom band below the image`);
        if (c.card === 'episode' && scale === 'largest') trimmed += c.hidden;
      }
    }
  }
  expect(failures).toEqual([]);
  expect(trimmed, 'the largest size really leaves room for fewer rows').toBeGreaterThan(0);
});
