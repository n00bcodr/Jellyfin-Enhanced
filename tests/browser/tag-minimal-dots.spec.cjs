const { test, expect } = require('@playwright/test');
const path = require('node:path');
const root = path.resolve(__dirname, '../../Jellyfin.Plugin.JellyfinEnhanced/js');
const english = require('../../Jellyfin.Plugin.JellyfinEnhanced/js/locales/en.json');

// Minimal puts the quality dots bottom-left and the score stack bottom-right.
// On the hub's ~126px sample posters five dots and a score chip are wider
// than the card at the default size and up: the stack must clear the dots,
// not paint over them. With several rating sources the stack is taller than
// the room above the dots on a short episode still: it keeps the chips that
// fit inside the image, below the top stack, and the rest wait for the hover
// reveal.
const CASES = { 'one rating': {}, 'five rating sources': { ratingTagsSources: ['imdb', 'tmdb', 'rtCritic', 'community', 'critic'], tagGroupCaps: { rating: 0 } } };
for (const [name, extra] of Object.entries(CASES)) test(`Minimal keeps its score stack clear of the quality dots on narrow cards (${name})`, async ({ page }) => {
  test.setTimeout(60000);
  await page.setContent('<style>body{margin:0;padding:8px}</style><div id="jellyfin-enhanced-panel"><div id="preview" style="width:262px"></div></div>');
  await page.evaluate(({ english, extra }) => {
    window.JellyfinEnhanced = { core: {}, helpers: {}, pluginConfig: {}, currentSettings: { tagLayoutSettingsVersion: 1, tagLayout: 'minimal', statusTagsEnabled: true,
      statusTagsTrending: true, statusTagsSchedule: true, qualityTagsEnabled: true, ratingTagsEnabled: true, ...extra },
      t: (key, params = {}) => Object.entries(params).reduce((s, [k, v]) => s.replaceAll(`{${k}}`, v), english[key] || key),
      tagPipeline: { registerRenderer() {}, clearProcessed() {}, scheduleScan() {} } };
  }, { english, extra });
  for (const file of ['core/ui-kit.js', 'core/media-language.js', 'core/tag-renderer-base.js', 'core/tag-layout.js', 'core/tag-look.js', 'tags/tag-layout-styles.js', 'tags/rating-sources.js',
    'tags/status-vocabulary.js', 'tags/statustags.js', 'tags/qualitytags.js', 'tags/ratingtags.js', 'enhanced/settingspanel/ui-panel-tag-editor.js', 'enhanced/settingspanel/ui-panel-tag-preview.js']) {
    await page.addScriptTag({ path: path.join(root, file) });
  }
  await page.evaluate(() => { window.preview = JellyfinEnhanced.internals.enhancedUi.createTagPreview(document.querySelector('#preview'), {}); });
  const failures = [];
  let lifted = 0;
  for (const scale of ['smaller', 'default', 'larger', 'largest']) {
    for (const width of [262, 550]) {
      const cards = await page.evaluate(async ({ scale, width }) => {
        const JE = window.JellyfinEnhanced;
        document.querySelector('#preview').style.width = `${width}px`;
        JE.currentSettings.tagScale = scale;
        window.preview.refresh();
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        JE.core.tagLayout.flushFit();
        return Array.from(document.querySelectorAll('[data-sample]')).map((sample) => {
          const host = sample.querySelector('.je-tag-host');
          const dots = host.querySelector('.je-tag-slot[data-je-slot="dots"]');
          const corner = host.querySelector('.je-tag-slot[data-je-slot="corner"]');
          if (!dots || !corner) return null;
          const d = dots.getBoundingClientRect(), h = host.getBoundingClientRect();
          const rects = (el) => Array.from(el?.querySelectorAll('[data-je-group] > *') || []).map((c) => c.getBoundingClientRect()).filter((r) => r.width);
          const meets = (a, b) => a.left < b.right - 0.5 && a.right > b.left + 0.5 && a.top < b.bottom - 0.5 && a.bottom > b.top + 0.5;
          const chips = rects(corner);
          const top = rects(host.querySelector('.je-tag-slot[data-je-slot="top"]'));
          return { card: sample.dataset.sample,
            overlap: chips.some((r) => meets(r, d)),
            top: chips.some((r) => top.some((t) => meets(r, t))),
            inside: chips.every((r) => r.top >= h.top - 0.5 && r.bottom <= h.bottom + 0.5),
            lifted: corner.getBoundingClientRect().bottom < d.top };
        }).filter(Boolean);
      }, { scale, width });
      expect(cards.length).toBeGreaterThan(0);
      for (const c of cards) {
        if (c.overlap) failures.push(`${scale} ${width}px ${c.card}: score stack over the dots`);
        if (c.top) failures.push(`${scale} ${width}px ${c.card}: score stack over the top stack`);
        if (!c.inside) failures.push(`${scale} ${width}px ${c.card}: score stack outside the card`);
        if (c.lifted) lifted++;
      }
    }
  }
  expect(failures).toEqual([]);
  expect(lifted, 'narrow posters really needed to clear the dots').toBeGreaterThan(0);
  // Wide posters keep the stack in its corner, level with the dots.
  const wide = await page.evaluate(async () => {
    const JE = window.JellyfinEnhanced;
    document.querySelector('#preview').style.width = '550px';
    JE.currentSettings.tagScale = 'default';
    window.preview.refresh();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    JE.core.tagLayout.flushFit();
    const host = document.querySelector('[data-sample="movie"] .je-tag-host');
    return host.getBoundingClientRect().bottom - host.querySelector('.je-tag-slot[data-je-slot="corner"]').getBoundingClientRect().bottom;
  });
  expect(wide).toBeCloseTo(6, 1);
});
