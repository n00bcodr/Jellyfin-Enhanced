const { test, expect } = require('@playwright/test');
const path = require('node:path');
const root = path.resolve(__dirname, '../../Jellyfin.Plugin.JellyfinEnhanced/js');
const english = require('../../Jellyfin.Plugin.JellyfinEnhanced/js/locales/en.json');

// Minimal's top and corner stacks and Caption's poster stack hold whole chips
// with no fitting of their own: a chip wider than the card must keep its box
// inside the 6px slot inset and end its label with an ellipsis, not slide
// past the card edge or lose its last letters.
test('an oversized chip in a Minimal or Caption stack ellipsizes at the slot edge', async ({ page }) => {
  test.setTimeout(60000);
  // 150px of preview: about 70px posters, narrower than "#3 Today" at the largest size.
  await page.setContent('<style>body{margin:0;padding:8px}</style><div id="jellyfin-enhanced-panel"><div id="preview" style="width:150px"></div></div>');
  await page.evaluate((english) => {
    window.JellyfinEnhanced = { core: {}, helpers: {}, pluginConfig: {}, currentSettings: { tagLayoutSettingsVersion: 1, statusTagsEnabled: true, statusTagsTrending: true, statusTagsSchedule: true },
      t: (key, params = {}) => Object.entries(params).reduce((s, [k, v]) => s.replaceAll(`{${k}}`, v), english[key] || key),
      tagPipeline: { registerRenderer() {}, clearProcessed() {}, scheduleScan() {} } };
  }, english);
  for (const file of ['core/ui-kit.js', 'core/tag-renderer-base.js', 'core/tag-layout.js', 'core/tag-look.js', 'tags/tag-layout-styles.js',
    'tags/status-vocabulary.js', 'tags/statustags.js', 'enhanced/settingspanel/ui-panel-tag-preview.js']) {
    await page.addScriptTag({ path: path.join(root, file) });
  }
  await page.evaluate(() => { window.preview = JellyfinEnhanced.internals.enhancedUi.createTagPreview(document.querySelector('#preview'), {}); });
  const failures = [];
  let fitted = 0;
  for (const [layout, slot] of [['minimal', 'top'], ['minimal', 'corner'], ['caption', 'poster']]) {
    for (const scale of ['default', 'largest']) {
      const chips = await page.evaluate(async ({ layout, slot, scale }) => {
        const JE = window.JellyfinEnhanced;
        Object.assign(JE.currentSettings, { tagLayout: layout, tagScale: scale, tagLayouts: { [layout]: { groups: [{ group: 'status', slot }] } } });
        window.preview.refresh();
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        JE.core.tagLayout.flushFit();
        return Array.from(document.querySelectorAll('[data-sample="movie"], [data-sample="series"]')).map((sample) => {
          const chip = sample.querySelector(`.je-tag-slot[data-je-slot="${slot}"] .status-tag`);
          const host = sample.querySelector('.je-tag-host').getBoundingClientRect();
          const r = chip.getBoundingClientRect();
          const label = chip.querySelector('.je-tag-fit-text');
          const style = label && getComputedStyle(label);
          return { card: sample.dataset.sample, text: chip.textContent, left: r.left - host.left, right: host.right - r.right, width: r.width, cardWidth: host.width,
            spills: chip.scrollWidth > chip.clientWidth + 1,
            ellipsis: !!label && label.scrollWidth > label.clientWidth && style.textOverflow === 'ellipsis' && style.overflowX === 'hidden' };
        });
      }, { layout, slot, scale });
      for (const c of chips) {
        const where = `${layout}/${slot}/${scale} ${c.card} "${c.text}" (${Math.round(c.width)}px on a ${Math.round(c.cardWidth)}px card)`;
        if (c.left < 6 - 0.5 || c.right < 6 - 0.5) failures.push(`${where}: outside the 6px inset (${c.left.toFixed(1)} / ${c.right.toFixed(1)})`);
        if (c.spills) failures.push(`${where}: label spills out of the chip`);
        if (c.width > c.cardWidth - 12 - 0.5 && !c.ellipsis) failures.push(`${where}: no ellipsis`);
        if (c.ellipsis) fitted++;
      }
    }
  }
  expect(failures).toEqual([]);
  // The largest size really is too wide for these posters: every stack ellipsized something.
  expect(fitted).toBeGreaterThanOrEqual(3);
});
