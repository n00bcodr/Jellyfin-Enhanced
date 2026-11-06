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
  for (const file of ['core/ui-kit.js', 'core/tag-renderer-base.js', 'core/tag-layout.js', 'tags/tag-layout-styles.js', 'tags/ageratingtags.js', 'tags/status-vocabulary.js', 'tags/statustags.js']) {
    await page.addScriptTag({ path: path.join(root, 'js', file) });
  }
  await page.evaluate(() => {
    const JE = window.JellyfinEnhanced;
    JE.initializeAgeRatingTags(); JE.initializeStatusTags();
    for (const width of [120, 168, 220]) for (const isSeason of [false, true]) {
      const card = document.createElement('div'); card.className = 'card'; card.dataset.id = `card${width}${isSeason}`;
      card.innerHTML = `<div class="cardBox"><div class="cardScalable" style="width:${width}px"><div class="cardImageContainer"></div><div class="countIndicator">12</div><div class="je-tag-host"></div><div class="cardOverlayContainer"></div></div><div class="cardText">Title</div></div>`;
      document.getElementById('cards').append(card);
      const host = card.querySelector('.je-tag-host');
      const now = Date.now();
      // The longest milestone label a season shows without TMDB facts: Season Premiere.
      const entry = { Type: isSeason ? 'Season' : 'Series', DateCreated: now, OfficialRating: 'TV-MA', SeasonPremiere: { Season: 2, Aired: now - 1000 } };
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
  expect(geometry.map(g => g.label)).toEqual(['New Season', 'Premiere', 'New Season', 'Season Premiere', 'New Season', 'Season Premiere']);
  expect(geometry.every(g => g.contained), JSON.stringify(geometry)).toBe(true);
  expect(geometry.every(g => g.overlap <= 0.5), JSON.stringify(geometry)).toBe(true);
});

// Positions are physical, as on native posters: a right-to-left page does not mirror the corners.
test('Corners keep their physical side on a right-to-left page', async ({ page }) => {
  test.setTimeout(45000);
  await page.setContent('<html dir="rtl" lang="ar"><body><style>.cardScalable { position: relative; height: 260px; } .je-tag-host { position: absolute; inset: 0; }</style><div id="cards"></div></body></html>');
  await page.evaluate(en => {
    window.JellyfinEnhanced = {
      currentSettings: { tagLayoutSettingsVersion: 1, tagLayout: 'corners', tagLabelDensity: 'full', statusTagsEnabled: true, statusTagsTrending: false, ageRatingTagsEnabled: true },
      pluginConfig: {}, t: key => en[key] || key, helpers: {},
      tagPipeline: { renderers: {}, registerRenderer(name, renderer) { this.renderers[name] = renderer; }, clearProcessed() {}, scheduleScan() {} },
    };
  }, english);
  for (const file of ['core/ui-kit.js', 'core/tag-renderer-base.js', 'core/tag-layout.js', 'tags/tag-layout-styles.js', 'tags/ageratingtags.js', 'tags/status-vocabulary.js', 'tags/statustags.js']) {
    await page.addScriptTag({ path: path.join(root, 'js', file) });
  }
  await page.evaluate(() => {
    const JE = window.JellyfinEnhanced;
    JE.initializeAgeRatingTags(); JE.initializeStatusTags();
    const card = document.createElement('div'); card.className = 'card'; card.dataset.id = 'rtl1';
    card.innerHTML = '<div class="cardBox"><div class="cardScalable" style="width:200px"><div class="cardImageContainer"></div><div class="je-tag-host"></div></div></div>';
    document.getElementById('cards').append(card);
    const host = card.querySelector('.je-tag-host');
    const entry = { Type: 'Movie', DateCreated: Date.now(), OfficialRating: 'PG-13' };
    for (const name of ['status', 'agerating']) JE.tagPipeline.renderers[name].renderFromServerCache(host, entry, 'rtl1');
    JE.core.tagLayout.flushFit();
  });
  const sides = await page.evaluate(() => {
    const host = document.querySelector('.je-tag-host').getBoundingClientRect();
    const side = el => { const r = el.getBoundingClientRect(); return { slot: el.closest('[data-je-slot]').dataset.jeSlot, nearLeft: r.left - host.left, nearRight: host.right - r.right }; };
    return [...document.querySelectorAll('.status-tag, .age-rating-tag')].map(side);
  });
  expect(sides.length).toBe(2);
  for (const s of sides) {
    if (s.slot.endsWith('r')) expect(s.nearRight, JSON.stringify(s)).toBeLessThan(s.nearLeft);
    if (s.slot.endsWith('l')) expect(s.nearLeft, JSON.stringify(s)).toBeLessThan(s.nearRight);
  }
});
