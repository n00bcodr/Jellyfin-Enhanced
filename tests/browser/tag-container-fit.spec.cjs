const { test, expect } = require('@playwright/test');
const path = require('node:path');
const root = path.resolve(__dirname, '../../Jellyfin.Plugin.JellyfinEnhanced/js');
const english = require('../../Jellyfin.Plugin.JellyfinEnhanced/js/locales/en.json');

// The group containers' legacy max-width (calc(100% - 12px) of the card) must
// not trim their own chips in slots that size themselves to those chips
// (Minimal top / corner, Caption poster): the user's "#3 Today" and "Airs Fri"
// were cut there. Every layout × slot that holds a group box is checked.
const SLOTS = { corners: ['tl', 'tr', 'bl', 'br'], bands: ['top'], caption: ['poster'], minimal: ['top', 'corner'] };
const SINGLE = { status: 'statusTagsEnabled', ageRating: 'ageRatingTagsEnabled' };

test('a single-chip group fits inside its container and slot in every layout slot', async ({ page }) => {
  test.setTimeout(60000);
  await page.setContent('<style>body{margin:0;padding:8px}</style><div id="jellyfin-enhanced-panel"><div id="preview" style="width:262px"></div></div>');
  await page.evaluate((english) => {
    window.JellyfinEnhanced = { core: {}, helpers: {}, pluginConfig: {}, currentSettings: { tagLayoutSettingsVersion: 1, statusTagsTrending: true, statusTagsSchedule: true },
      t: (key, params = {}) => Object.entries(params).reduce((s, [k, v]) => s.replaceAll(`{${k}}`, v), english[key] || key),
      tagPipeline: { registerRenderer() {}, clearProcessed() {}, scheduleScan() {} } };
  }, english);
  for (const file of ['core/ui-kit.js', 'core/tag-renderer-base.js', 'core/tag-layout.js', 'core/tag-look.js', 'tags/tag-layout-styles.js',
    'tags/status-vocabulary.js', 'tags/statustags.js', 'tags/ageratingtags.js', 'enhanced/settingspanel/ui-panel-tag-preview.js']) {
    await page.addScriptTag({ path: path.join(root, file) });
  }
  await page.evaluate(() => { window.preview = JellyfinEnhanced.internals.enhancedUi.createTagPreview(document.querySelector('#preview'), {}); });
  const failures = [];
  let checked = 0;
  for (const [layout, slots] of Object.entries(SLOTS)) {
    for (const slot of slots) {
      for (const [group, enabled] of Object.entries(SINGLE)) {
        for (const scale of ['smaller', 'default', 'largest']) {
          const boxes = await page.evaluate(async ({ layout, slot, group, enabled, scale }) => {
            const JE = window.JellyfinEnhanced;
            Object.assign(JE.currentSettings, { tagLayout: layout, tagScale: scale, statusTagsEnabled: false, ageRatingTagsEnabled: false, [enabled]: true,
              tagLayouts: { [layout]: { groups: [{ group, slot }] } } });
            window.preview.refresh();
            await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
            JE.core.tagLayout.flushFit();
            const rect = (el) => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; };
            return Array.from(document.querySelectorAll(`.je-tag-slot[data-je-slot="${slot}"] > [data-je-group="${group}"]`)).map((container) => {
              const chips = Array.from(container.children).filter((c) => !c.hasAttribute('data-je-overflow'));
              return { card: container.closest('[data-sample]').dataset.sample, count: chips.length, text: chips[0]?.textContent,
                chip: chips[0] && rect(chips[0]), container: rect(container), slot: rect(container.parentElement) };
            });
          }, { layout, slot, group, enabled, scale });
          expect(boxes.length, `${layout} ${slot} ${group}`).toBeGreaterThan(0);
          for (const box of boxes) {
            expect(box.count, `${layout} ${slot} ${group} ${box.card}`).toBe(1);
            checked++;
            for (const outer of ['container', 'slot']) {
              const o = box[outer], c = box.chip;
              if (c.left < o.left - 0.5 || c.right > o.right + 0.5 || c.top < o.top - 0.5 || c.bottom > o.bottom + 0.5) {
                failures.push(`${layout}/${slot}/${scale} ${box.card} "${box.text}" ${Math.round(c.right - c.left)}px outside its ${outer} (${Math.round(o.right - o.left)}px)`);
              }
            }
          }
        }
      }
    }
  }
  expect(checked).toBeGreaterThan(100);
  expect(failures).toEqual([]);
});
