const { test, expect } = require('@playwright/test');
const path = require('node:path');
const root = path.resolve(__dirname, '../../Jellyfin.Plugin.JellyfinEnhanced/js');
const english = require('../../Jellyfin.Plugin.JellyfinEnhanced/js/locales/en.json');

// Grid cards are rarely a whole number of pixels wide, but clientWidth is
// rounded. The fitting pass planned rows against the rounded width, so when
// the last chip or "+N" fitted only in that extra fraction of a pixel, flex
// wrapped it onto a third row: below the caption strip (cut) or above the
// bottom band's two rows. Sweep the sample cards over fractional widths and
// require every wrapping slot to keep its rows, whole, inside its box.
const SLOTS = { caption: '.je-tag-caption', bands: '.je-tag-slot:is([data-je-slot="top"], [data-je-slot="bottom"])',
  summary: '.je-tag-slot[data-je-slot="reveal"]', minimal: '.je-tag-slot[data-je-slot="reveal"]' };

test('wrapping slots keep their chip rows inside their box at fractional card widths', async ({ page }) => {
  test.setTimeout(180000);
  await page.setContent('<style>body{margin:0;padding:8px}*,*::before,*::after{transition:none!important}</style><div id="jellyfin-enhanced-panel"><div id="preview" style="width:420px"></div></div>');
  await page.evaluate((english) => {
    window.JellyfinEnhanced = { core: {}, helpers: {}, pluginConfig: {}, currentSettings: { tagLayoutSettingsVersion: 1,
      statusTagsEnabled: true, statusTagsTrending: true, statusTagsSchedule: true, qualityTagsEnabled: true, ratingTagsEnabled: true, ageRatingTagsEnabled: true,
      languageTagsEnabled: true, languageTagsStyle: 'codes', languageTagsShowSubtitles: true, genreTagsEnabled: true },
      t: (key, params = {}) => Object.entries(params).reduce((s, [k, v]) => s.replaceAll(`{${k}}`, v), english[key] || key),
      tagPipeline: { registerRenderer() {}, clearProcessed() {}, scheduleScan() {} } };
  }, english);
  for (const file of ['core/ui-kit.js', 'core/media-language.js', 'core/tag-renderer-base.js', 'core/tag-layout.js', 'core/tag-look.js', 'tags/tag-layout-styles.js',
    'tags/rating-sources.js', 'tags/status-vocabulary.js', 'tags/statustags.js', 'tags/qualitytags.js', 'tags/ratingtags.js', 'tags/ageratingtags.js', 'tags/languagetags.js',
    'tags/genretags.js', 'enhanced/settingspanel/ui-panel-tag-editor.js', 'enhanced/settingspanel/ui-panel-tag-preview.js']) {
    await page.addScriptTag({ path: path.join(root, file) });
  }
  await page.evaluate(() => { window.preview = JellyfinEnhanced.internals.enhancedUi.createTagPreview(document.querySelector('#preview'), {}); });
  const failures = [];
  let slots = 0;
  for (const [layout, selector] of Object.entries(SLOTS)) {
    for (const scale of ['smaller', 'default']) {
      const found = await page.evaluate(async ({ layout, selector, scale }) => {
        const JE = window.JellyfinEnhanced;
        const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        Object.assign(JE.currentSettings, { tagLayout: layout, tagScale: scale, tagLabelDensity: 'full' });
        const out = { slots: 0, failures: [] };
        // 0.13px steps: every fraction of a pixel, over a few whole pixels of card width.
        for (let width = 420; width < 436; width += 0.13) {
          document.querySelector('#preview').style.width = `${width}px`;
          window.preview.refresh();
          await frame();
          JE.core.tagLayout.flushFit();
          document.querySelectorAll('.je-mtp-card').forEach((card) => card.classList.add('je-tag-reveal'));
          for (const slot of document.querySelectorAll(selector)) {
            const box = slot.getBoundingClientRect();
            const chips = Array.from(slot.querySelectorAll(':scope > [data-je-group] > *, :scope > .je-tag-more'))
              .filter((c) => !c.closest('[data-je-overflow]')).map((c) => c.getBoundingClientRect()).filter((r) => r.height > 0);
            if (!chips.length) continue;
            out.slots++;
            // Chips of one row overlap vertically (a row aligns chips of different heights).
            const tops = [];
            for (const r of [...chips].sort((a, b) => a.top - b.top)) {
              const row = tops.find((t) => r.top < t.bottom - 1 && r.bottom > t.top + 1);
              if (row) row.bottom = Math.max(row.bottom, r.bottom); else tops.push({ top: r.top, bottom: r.bottom });
            }
            const cut = chips.filter((r) => r.bottom > box.bottom + 0.5 || r.top < box.top - 0.5 || r.right > box.right + 0.5).length;
            if (tops.length > 2 || cut) {
              out.failures.push(`${layout}/${scale} at ${width.toFixed(2)}px, ${slot.closest('[data-sample]').dataset.sample} ${slot.dataset.jeSlot || 'caption'}: ${tops.length} rows, ${cut} of ${chips.length} chips outside the slot`);
            }
          }
          document.querySelectorAll('.je-mtp-card').forEach((card) => card.classList.remove('je-tag-reveal'));
        }
        return out;
      }, { layout, selector, scale });
      slots += found.slots;
      failures.push(...found.failures);
    }
  }
  expect(slots).toBeGreaterThan(0);
  expect(failures.slice(0, 10), `${failures.length} slots overflowed`).toEqual([]);
});
