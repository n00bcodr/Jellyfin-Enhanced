const { test, expect } = require('@playwright/test');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const root = path.resolve(__dirname, '../../Jellyfin.Plugin.JellyfinEnhanced/js');
const en = require('../../Jellyfin.Plugin.JellyfinEnhanced/js/locales/en.json');

/** Optional baseline replay records the same production probe without requiring git in CI. */
async function setup(page) {
  await page.setContent('<style>.cardScalable{position:relative;height:270px;width:80px}.je-tag-host{position:absolute;inset:0}.mixed-rating-fit .rating-tag{width:70px}.mixed-rating-fit .language-chip{box-sizing:border-box;width:30px}.mixed-rating-fit .je-tag-more{width:24px}</style><div class="card"><div class="cardScalable"><div class="je-tag-host"></div></div></div>');
  await page.evaluate(en => {
    window.JellyfinEnhanced = { currentSettings: { tagLayoutSettingsVersion: 1, tagLayout: 'corners', tagEdgeSpacing: 'default', tagScale: 'largest' },
      pluginConfig: {}, t: key => en[key] || key,
      tagPipeline: { registerRenderer(name, renderer) { this[name] = renderer; renderer.injectCss?.(); }, clearProcessed() {}, scheduleScan() {} } };
  }, en);
  for (const file of ['core/ui-kit.js', 'core/media-language.js', 'core/tag-renderer-base.js', 'core/tag-layout.js', 'tags/tag-layout-styles.js',
    'tags/rating-sources.js', 'tags/ratingtags.js', 'tags/status-vocabulary.js', 'tags/statustags.js', 'tags/languagetags.js']) {
    if (process.env.JE_RATING_BASELINE) {
      await page.addScriptTag({ content: execFileSync('git', ['show', `${process.env.JE_RATING_BASELINE}:Jellyfin.Plugin.JellyfinEnhanced/js/${file}`], { encoding: 'utf8', cwd: path.resolve(__dirname, '../..') }) });
    } else await page.addScriptTag({ path: path.join(root, file) });
  }
  await page.evaluate(() => { JellyfinEnhanced.initializeRatingTags(); JellyfinEnhanced.initializeStatusTags(); JellyfinEnhanced.initializeLanguageTags(); });
}

/** Repeated real fitting captures visibility, constraints and text CSS, including stale-state cleanup. */
async function probe(page, width, slot, mixed = false) {
  return page.evaluate(async ({ width, slot, mixed }) => {
    const JE = JellyfinEnhanced, L = JE.core.tagLayout, host = document.querySelector('.je-tag-host');
    for (const group of ['rating', 'status', 'language']) L.removeGroup(host, group);
    document.querySelector('.cardScalable').style.width = `${width}px`;
    // At 100/113px, a 30px language chip plus the 4px gap leaves 32/45px:
    // enough for the 24px +N, never the 70px rating, regardless of system fonts.
    // Natural chip geometry is retained for the no-language baseline replay.
    host.classList.toggle('mixed-rating-fit', mixed);
    Object.assign(JE.currentSettings, { tagScale: mixed ? 'default' : 'largest', tagEdgeSpacing: mixed ? 'flush' : 'default', statusTagsEnabled: true, statusTagsShowJustAdded: true, statusTagsJustAddedDays: 30,
      languageTagsStyle: 'codes', languageTagsShowAudio: true,
      tagLayouts: { corners: { groups: [{ group: 'rating', slot }, { group: 'status', slot: 'mr' }, { group: 'language', slot: slot === 'bc' ? 'bl' : 'tl' }] } } });
    L.invalidateSettings();
    const rating = document.createElement('div');rating.className = 'rating-overlay-container';
    rating.append(JE.ratingSources.chip({ id: 'imdb', value: 10, text: '10.0' }));L.commitGroup(host, 'rating', rating);
    if (mixed) L.commitGroup(host, 'language', JE.core.languageTags.buildGroup([{ code: 'en', name: 'English' }]));
    else JE.tagPipeline.status.renderFromServerCache(host, { Type: 'Movie', DateCreated: new Date().toISOString() });
    const results = [];
    for (let pass = 0; pass < 3; pass++) {
      L.refreshPresentation(host);
      await document.fonts.ready;
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      L.flushFit();
      const chip = host.querySelector('.rating-tag'), text = chip.querySelector('.rating-text');
      results.push({ label: chip.title, value: text.textContent, hidden: chip.hasAttribute('data-je-overflow'), constrained: chip.hasAttribute('data-je-fit-width'),
        ellipsis: getComputedStyle(text).textOverflow, textClipped: text.scrollWidth > text.clientWidth,
        more: [...host.querySelectorAll('.je-tag-more:not([data-je-overflow])')].map(el => ({ text: el.textContent, title: el.title })) });
    }
    return results;
  }, { width, slot, mixed });
}

test('no-language constrained ratings match the recorded 83ffd1b3 browser outcome at ml/c/tc', async ({ page }, testInfo) => {
  await setup(page);
  const evidence = [];
  // Recorded by replaying this probe with JE_RATING_BASELINE=83ffd1b3:
  // all six cases keep the first rating visible, constrained and ellipsized.
  for (const width of [80, 50]) for (const slot of ['ml', 'c', 'tc']) {
    const rows = await probe(page, width, slot);
    evidence.push({ width, slot, rows });
    for (const row of rows) {
      expect(row, `${width}px ${slot}`).toMatchObject({ hidden: false, constrained: true, ellipsis: 'ellipsis', textClipped: true });
      expect(row.more.some(more => more.title.includes(row.label))).toBe(false);
    }
    expect(rows[2]).toEqual(rows[0]);
  }
  await testInfo.attach('rating-baseline-comparison', { body: JSON.stringify({ revision: process.env.JE_RATING_BASELINE || 'working-tree', evidence }, null, 2), contentType: 'application/json' });
});

test('only the mixed language and rating row overflows the whole value and resets when languages leave', async ({ page }) => {
  await setup(page);
  for (const width of [100, 113]) {
    for (const row of await probe(page, width, 'bc', true)) {
      expect(row).toMatchObject({ value: '10.0', hidden: true, constrained: false, textClipped: false });
      expect(row.label).toContain(row.value);
      expect(row.more).toContainEqual({ text: '+1', title: row.label });
    }
    for (const row of await probe(page, 50, 'bc')) expect(row).toMatchObject({ hidden: false, constrained: true, ellipsis: 'ellipsis', textClipped: true });
  }
});
