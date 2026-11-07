const { test, expect } = require('@playwright/test');
const path = require('node:path');
const root = path.resolve(__dirname, '../../Jellyfin.Plugin.JellyfinEnhanced/js');
const english = require('../../Jellyfin.Plugin.JellyfinEnhanced/js/locales/en.json');

// Corners' centre rows reserved room only against the stacks of their own
// edge. On short images (episode stills, list rows) a tall column of the other
// edge reaches into the row's band: quality at top-centre ran into the bottom-
// left languages, ratings at bottom-centre into the top-right status column.
// With Flush edges the top row moved below the top stacks even where that was
// the image's bottom edge. Every centre chip must stay inside the image and
// clear of every other slot's chips.
test('Corners centre rows stay inside the image and clear of the corner stacks', async ({ page }) => {
  test.setTimeout(180000);
  await page.setContent('<style>body{margin:0;padding:8px}*,*::before,*::after{transition:none!important}</style><div id="jellyfin-enhanced-panel"><div id="preview" style="width:262px"></div></div>');
  await page.evaluate((english) => {
    window.JellyfinEnhanced = { core: {}, helpers: {}, pluginConfig: {}, currentSettings: { tagLayoutSettingsVersion: 1, tagLayout: 'corners',
      tagLayouts: { corners: { groups: [{ group: 'quality', slot: 'tc' }, { group: 'rating', slot: 'bc' }] } },
      ratingTagsSources: ['imdb', 'tmdb', 'rtCritic', 'community', 'critic'], tagGroupCaps: { rating: 0 },
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
  let rows = 0;
  for (const width of [262, 550]) {
    for (const scale of ['smaller', 'default']) {
      for (const density of ['full', 'compact']) {
        for (const edge of ['default', 'tight', 'flush']) {
          const found = await page.evaluate(async ({ width, scale, density, edge }) => {
            const JE = window.JellyfinEnhanced;
            document.querySelector('#preview').style.width = `${width}px`;
            Object.assign(JE.currentSettings, { tagScale: scale, tagLabelDensity: density, tagEdgeSpacing: edge });
            window.preview.refresh();
            await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
            JE.core.tagLayout.flushFit();
            const out = { rows: 0, failures: [] };
            const shown = (el) => Array.from(el.querySelectorAll(':scope > [data-je-group] > *, :scope > .je-tag-more'))
              .filter((c) => !c.closest('[data-je-overflow]')).map((c) => ({ c, r: c.getBoundingClientRect() })).filter(({ r }) => r.width > 0 && r.height > 0);
            for (const host of document.querySelectorAll('.je-mtp-card .je-tag-host')) {
              const box = host.getBoundingClientRect();
              const slots = Array.from(host.children).filter((el) => el.matches('.je-tag-slot'));
              for (const centre of slots.filter((el) => ['tc', 'bc'].includes(el.dataset.jeSlot))) {
                const chips = shown(centre);
                if (!chips.length) continue;
                out.rows++;
                const where = `${width}px ${scale}/${density}/${edge} ${host.closest('[data-sample]').dataset.sample} ${centre.dataset.jeSlot}`;
                for (const { c, r } of chips) {
                  const text = (c.textContent || '').trim().slice(0, 16);
                  if (r.left < box.left - 0.5 || r.right > box.right + 0.5 || r.top < box.top - 0.5 || r.bottom > box.bottom + 0.5) out.failures.push(`${where}: "${text}" outside the image`);
                  for (const other of slots.filter((el) => el !== centre)) {
                    for (const o of shown(other)) {
                      if (Math.min(r.right, o.r.right) - Math.max(r.left, o.r.left) > 0.5 && Math.min(r.bottom, o.r.bottom) - Math.max(r.top, o.r.top) > 0.5) {
                        out.failures.push(`${where}: "${text}" over ${other.dataset.jeSlot} "${(o.c.textContent || '').trim().slice(0, 16)}"`);
                      }
                    }
                  }
                }
              }
            }
            return out;
          }, { width, scale, density, edge });
          rows += found.rows;
          failures.push(...found.failures);
        }
      }
    }
  }
  expect(rows).toBeGreaterThan(0);
  expect(failures.slice(0, 12), `${failures.length} centre chips collide`).toEqual([]);
});
