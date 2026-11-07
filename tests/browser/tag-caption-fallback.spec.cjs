const { test, expect } = require('@playwright/test');
const path = require('node:path');
const root = path.resolve(__dirname, '../../Jellyfin.Plugin.JellyfinEnhanced/js');
const english = require('../../Jellyfin.Plugin.JellyfinEnhanced/js/locales/en.json');

// A list row has no title block, so Caption shows the caption groups in the
// poster's top-left stack. On a 92px row image that column ran off the bottom
// of the image; it must keep the whole chips that fit and count the rest in "+N".
test('Caption\'s poster stack on a list row keeps whole chips inside the image, then "+N"', async ({ page }) => {
  test.setTimeout(60000);
  await page.setContent('<style>body{margin:0;padding:8px}</style><div id="jellyfin-enhanced-panel"><div id="preview" style="width:262px"></div></div>');
  await page.evaluate((english) => {
    window.JellyfinEnhanced = { core: {}, helpers: {}, pluginConfig: {}, currentSettings: { tagLayoutSettingsVersion: 1, tagLayout: 'caption',
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
  for (const scale of ['smaller', 'default', 'larger', 'largest']) {
    for (const density of ['full', 'compact']) {
      const row = await page.evaluate(async ({ scale, density }) => {
        const JE = window.JellyfinEnhanced;
        Object.assign(JE.currentSettings, { tagScale: scale, tagLabelDensity: density });
        window.preview.refresh();
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        JE.core.tagLayout.flushFit();
        const host = document.querySelector('[data-sample="list"] .je-tag-host');
        const slot = host.querySelector('.je-tag-slot[data-je-slot="poster"]');
        const shown = (el) => !el.closest('[data-je-overflow]') && el.getBoundingClientRect().height > 0;
        const all = Array.from(slot.querySelectorAll(':scope > [data-je-group] > *'));
        const visible = [...all.filter(shown), ...Array.from(slot.querySelectorAll(':scope > .je-tag-more')).filter(shown)];
        const h = host.getBoundingClientRect();
        return { total: all.length, hidden: all.filter((c) => !shown(c)).length, more: slot.querySelector(':scope > .je-tag-more:not([data-je-overflow])')?.textContent || '',
          lowest: Math.max(...visible.map((c) => c.getBoundingClientRect().bottom)) - h.top, height: h.height };
      }, { scale, density });
      const where = `${scale}/${density}`;
      if (row.lowest > row.height - 6 + 0.5) failures.push(`${where}: the stack ends ${(row.lowest - row.height).toFixed(1)}px past the ${row.height}px image`);
      if (row.hidden && row.more !== `+${row.hidden}`) failures.push(`${where}: ${row.hidden} hidden chips but "${row.more}"`);
      if (row.total - row.hidden < 2) failures.push(`${where}: only ${row.total - row.hidden} chips shown`);
    }
  }
  expect(failures).toEqual([]);
});
