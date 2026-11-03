const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const { detectTagClipping, clippingConfigurations } = require('./helpers/tag-clipping.cjs');
const root = path.resolve(__dirname, '../../Jellyfin.Plugin.JellyfinEnhanced/js');
const english = require('../../Jellyfin.Plugin.JellyfinEnhanced/js/locales/en.json');

const FILES = ['core/ui-kit.js', 'core/media-language.js', 'core/tag-renderer-base.js', 'core/tag-layout.js', 'core/tag-look.js',
  'tags/tag-layout-styles.js', 'tags/rating-sources.js', 'tags/status-vocabulary.js', 'tags/statustags.js', 'tags/qualitytags.js',
  'tags/ratingtags.js', 'tags/ageratingtags.js', 'tags/languagetags.js', 'tags/genretags.js',
  'enhanced/settingspanel/ui-panel-tag-editor.js', 'enhanced/settingspanel/ui-panel-tag-preview.js'];

/** Every group the sweep inspects, as the user had them: Trending and Schedule status, codes with subtitles. */
const GROUPS_ON = { statusTagsEnabled: true, statusTagsTrending: true, statusTagsSchedule: true, qualityTagsEnabled: true,
  ratingTagsEnabled: true, languageTagsEnabled: true, languageTagsStyle: 'codes', languageTagsShowSubtitles: true,
  genreTagsEnabled: true, ageRatingTagsEnabled: true };

/**
 * The production preview (hub panel or admin page column) at a given mount width.
 * @param {import('@playwright/test').Page} page
 * @param {'hub'|'admin'} surface
 * @param {number} width - The preview mount's width (the hub's default panel gives ~126px poster samples).
 */
async function setup(page, surface, width) {
  const holder = surface === 'admin' ? `<div class="je-tag-admin"><div id="preview" style="width:${width}px"></div></div>`
    : `<div id="jellyfin-enhanced-panel"><div id="preview" style="width:${width}px"></div></div>`;
  await page.setContent(`<style>body{margin:0;padding:8px;font-family:Arial,sans-serif;background:#111;color:#fff}*,*::before,*::after{transition:none!important}</style>${holder}`);
  await page.evaluate(({ english, settings }) => {
    window.JellyfinEnhanced = { core: {}, helpers: {}, pluginConfig: {}, currentSettings: { tagLayoutSettingsVersion: 1, ...settings },
      t: (key, params = {}) => Object.entries(params).reduce((s, [k, v]) => s.replaceAll(`{${k}}`, v), english[key] || key),
      tagPipeline: { registerRenderer() {}, clearProcessed() {}, scheduleScan() {} } };
  }, { english, settings: GROUPS_ON });
  for (const file of FILES) await page.addScriptTag({ path: path.join(root, file) });
  await page.evaluate(() => {
    const JE = window.JellyfinEnhanced;
    window.preview = JE.internals.enhancedUi.createTagPreview(document.querySelector('#preview'), {});
  });
  await page.mouse.move(0, 0);
}

/**
 * Redraw the preview in one configuration and settle its fitting pass.
 * @param {import('@playwright/test').Page} page
 * @param {{layout: string, scale: string, density: string, edge: string, hover: boolean}} conf
 */
async function configure(page, conf) {
  await page.evaluate(async (conf) => {
    const JE = window.JellyfinEnhanced;
    Object.assign(JE.currentSettings, { tagLayout: conf.layout, tagScale: conf.scale, tagLabelDensity: conf.density, tagEdgeSpacing: conf.edge });
    window.preview.refresh();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    JE.core.tagLayout.flushFit();
    document.querySelectorAll('.je-mtp-card').forEach((card) => card.classList.toggle('je-tag-reveal', conf.hover));
  }, conf);
}

/** Corners' corner stacks, which keep their pre-layouts geometry. */
const LEGACY_STACK = new Set(['tl', 'tr', 'bl', 'br']);

const SURFACES = [
  // The hub at its default panel width, and widened so the posters are ~270px like the user's phone screenshot.
  { name: 'hub', surface: 'hub', width: 262 },
  { name: 'hub-wide', surface: 'hub', width: 550 },
  { name: 'admin', surface: 'admin', width: 300 },
];

for (const { name, surface, width } of SURFACES) {
  test(`${name} preview: no chip is clipped, spilled, wrapped, overlapping or outside its card`, async ({ page }, testInfo) => {
    test.setTimeout(240000);
    await setup(page, surface, width);
    const results = [];
    for (const conf of clippingConfigurations()) {
      await configure(page, conf);
      results.push({ conf, ...await page.evaluate(detectTagClipping, { root: '.je-mtp' }) });
    }
    const report = testInfo.outputPath(`${name}-clipping.json`);
    fs.writeFileSync(report, JSON.stringify(results, null, 1));
    if (process.env.JE_CLIPPING_REPORT) fs.writeFileSync(path.join(process.env.JE_CLIPPING_REPORT, `${name}-${testInfo.project.name}.json`), JSON.stringify(results, null, 1));
    expect(results.every((r) => r.chips > 0)).toBe(true);
    const all = results.flatMap((r) => r.findings.map((f) => ({ conf: `${r.conf.layout}/${r.conf.scale}/${r.conf.density}/${r.conf.edge}/${r.conf.hover ? 'hover' : 'rest'}`, ...f })));
    // Corners' four corner stacks keep the geometry tags had before layouts
    // (pinned pixel for pixel for legacy settings): they are not fitted
    // against each other or a short image, so with every group on, a 140px
    // episode still or the larger sizes make them meet. Everything else is
    // fitted and must be clean.
    const legacy = (f) => f.conf.startsWith('corners/') && LEGACY_STACK.has(f.slot) && (!f.other || LEGACY_STACK.has(f.other.slot));
    const failures = all.filter((f) => !legacy(f));
    expect(failures.slice(0, 8), `${failures.length} findings (full matrix in ${report})`).toEqual([]);
    expect(all.filter(legacy).every((f) => ['slot-overlap', 'ancestor-clip', 'outside-card', 'container-trim'].includes(f.type))).toBe(true);
  });
}
