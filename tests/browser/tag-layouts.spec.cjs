const { test, expect } = require('@playwright/test');
const path = require('node:path');
const root = path.resolve(__dirname, '../../Jellyfin.Plugin.JellyfinEnhanced');
const english = require('../../Jellyfin.Plugin.JellyfinEnhanced/js/locales/en.json');

// Real renderer and layout styles: long milestone labels share the top band
// with an age rating and Jellyfin's count indicator on narrow posters.
test('Bands keeps milestone and age chips inside the card without overlap', async ({ page }) => {
  test.setTimeout(45000);
  await page.setContent('<style>.cardScalable { position: relative; height: 260px; } .je-tag-host { position: absolute; inset: 0; }</style><div id="cards"></div>');
  await page.evaluate(en => {
    window.JellyfinEnhanced = {
      currentSettings: { tagLayoutSettingsVersion: 1, tagLayout: 'bands', tagLabelDensity: 'full', statusTagsEnabled: true, statusTagsTrending: false, ageRatingTagsEnabled: true },
      pluginConfig: {}, t: key => en[key] || key, helpers: {},
      tagPipeline: { renderers: {}, registerRenderer(name, renderer) { this.renderers[name] = renderer; }, clearProcessed() {}, scheduleScan() {} },
    };
  }, english);
  for (const file of ['core/ui-kit.js', 'core/tag-renderer-base.js', 'core/tag-layout.js', 'tags/tag-layout-styles.js', 'tags/ageratingtags.js', 'tags/statustags.js']) {
    await page.addScriptTag({ path: path.join(root, 'js', file) });
  }
  await page.evaluate(() => {
    const JE = window.JellyfinEnhanced;
    JE.initializeAgeRatingTags(); JE.initializeStatusTags();
    for (const width of [120, 168, 220]) for (const complete of [false, true]) {
      const card = document.createElement('div'); card.className = 'card'; card.dataset.id = `card${width}${complete}`;
      card.innerHTML = `<div class="cardBox"><div class="cardScalable" style="width:${width}px"><div class="cardImageContainer"></div><div class="countIndicator">12</div><div class="je-tag-host"></div><div class="cardOverlayContainer"></div></div><div class="cardText">Title</div></div>`;
      document.getElementById('cards').append(card);
      const host = card.querySelector('.je-tag-host');
      const now = Date.now();
      const entry = { Type: complete ? 'Season' : 'Series', DateCreated: now, OfficialRating: 'TV-MA',
        SeasonPremiere: { Season: 2, Aired: now - 1000 }, SeasonAddedSpan: complete ? { First: now - 1000, Last: now, Count: 8 } : null };
      for (const name of ['status', 'agerating']) JE.tagPipeline.renderers[name].renderFromServerCache(host, entry, card.dataset.id);
    }
    JE.core.tagLayout.flushFit();
  });
  await expect(page.locator('.status-tag')).toHaveCount(6);
  const geometry = await page.evaluate(() => [...document.querySelectorAll('.je-tag-slot[data-je-slot="top"]')].map(slot => {
    const status = slot.querySelector('.status-tag'), age = slot.querySelector('.age-rating-tag');
    const s = status.getBoundingClientRect(), a = age.getBoundingClientRect(), host = slot.parentElement.getBoundingClientRect();
    return { label: status.textContent,
      overlap: Math.max(0, Math.min(s.right, a.right) - Math.max(s.left, a.left)) * Math.max(0, Math.min(s.bottom, a.bottom) - Math.max(s.top, a.top)),
      contained: [s, a].every(r => r.left >= host.left - 0.5 && r.right <= host.right + 0.5) };
  }));
  expect(geometry.map(g => g.label)).toEqual(['New Season', 'Complete', 'New Season', 'Complete Season', 'New Season', 'Complete Season']);
  expect(geometry.every(g => g.contained), JSON.stringify(geometry)).toBe(true);
  expect(geometry.every(g => g.overlap <= 0.5), JSON.stringify(geometry)).toBe(true);
});
