const { test, expect } = require('@playwright/test');
const path = require('node:path');
const root = path.resolve(__dirname, '../../Jellyfin.Plugin.JellyfinEnhanced/js');
const en = require('../../Jellyfin.Plugin.JellyfinEnhanced/js/locales/en.json');

for (const preset of ['default', 'poster']) for (const viewport of [1400, 420]) {
  test(`mixed language and rating chips remain whole at ${viewport} with ${preset}`, async ({ page }) => {
    await page.setViewportSize({ width: viewport, height: 900 });
    await page.setContent(`<style>body{font-family:Arial}.card{display:inline-block;margin:8px}.cardScalable{position:relative;width:${viewport === 420 ? 113 : 201}px;height:${viewport === 420 ? 170 : 302}px}.je-tag-host{position:absolute;inset:0;container-type:inline-size}</style><div id="cards"></div>`);
    await page.evaluate(en => {
      window.JellyfinEnhanced = { core: {}, helpers: {}, pluginConfig: {}, t: key => en[key] || key,
        currentSettings: { tagLayoutSettingsVersion: 1, tagLayout: 'corners', ratingTagsEnabled: true, languageTagsEnabled: true,
          languageTagsStyle: 'codes', languageTagsShowSubtitles: true, languageTagsCountBadge: 'both',
          tagGroupCaps: { language: 6 }, tagLayouts: { corners: { groups: [{ group: 'rating', slot: 'bc' }, { group: 'language', slot: 'bl' }] } } },
        tagPipeline: { registerRenderer(name, renderer) { renderer.injectCss(); }, clearProcessed() {}, scheduleScan() {} } };
    }, en);
    for (const file of ['core/ui-kit.js', 'core/media-language.js', 'core/tag-renderer-base.js', 'core/tag-layout.js', 'tags/tag-layout-styles.js',
      'tags/qualitytags.js', 'tags/languagetags.js', 'tags/rating-sources.js', 'tags/ratingtags.js', 'tags/tag-styles.js']) await page.addScriptTag({ path: path.join(root, file) });
    await page.evaluate(preset => {
      const JE = JellyfinEnhanced, L = JE.core.tagLayout;
      JE.initializeLanguageTags(); JE.initializeRatingTags();
      for (const [index, score] of ['7.7', '7.5', '6.5', '6.9'].entries()) {
        const card = document.createElement('div');card.className = 'card overflowPortraitCard';card.dataset.id = String(index);
        card.innerHTML = '<div class="cardScalable"><a class="cardImageContainer" href="#item"></a></div>';document.querySelector('#cards').append(card);
        const target = card.firstElementChild;
        const language = JE.core.languageTags.buildGroup({ audio: ['en'], subtitles: [{ code: 'en', sdh: true }, 'fr', 'es'] }, 0);
        L.commitGroup(target, 'language', language);
        const rating = document.createElement('div');rating.className = 'rating-overlay-container';
        rating.innerHTML = `<span class="rating-tag rating-tag-tmdb"><span class="rating-star-icon">★</span><span class="rating-text">${score}</span></span><span class="rating-tag rating-tag-critic"><span class="rating-text">83%</span></span>`;
        L.commitGroup(target, 'rating', rating);
        if (preset === 'poster') {
          const host = card.querySelector('.je-tag-host');host.dataset.jePosterColour = '';
          host.style.setProperty('--je-tag-bg', 'rgb(80,30,30)');host.style.setProperty('--je-tag-border', 'rgb(120,60,60)');host.style.setProperty('--je-tag-fg', '#fff');
        }
      }
      const css = document.createElement('style');css.textContent = JE.tagStyles.buildCss({ preset });document.head.append(css);
      L.refreshPresentation();
    }, preset);
    await page.evaluate(() => JellyfinEnhanced.core.tagLayout.flushFit());
    const evidence = await page.evaluate(() => [...document.querySelectorAll('.card')].map(card => {
      const host = card.querySelector('.je-tag-host').getBoundingClientRect();
      const ratings = [...card.querySelectorAll('.rating-tag')].map(chip => {
        const text = chip.querySelector('.rating-text'), box = chip.getBoundingClientRect(), slot = chip.closest('.je-tag-slot').getBoundingClientRect();
        const hidden = chip.hasAttribute('data-je-overflow');
        return { value: text.textContent, hidden, complete: text.scrollWidth <= text.clientWidth + 1 && box.width <= slot.width + 0.1 && box.left >= host.left && box.right <= host.right };
      });
      const more = [...card.querySelectorAll('.je-tag-more:not([data-je-overflow])')].map(chip => ({ text: chip.textContent, title: chip.title }));
      const languages = [...card.querySelectorAll('[data-je-group="language"] > *:not(.je-tag-more):not([data-je-overflow])')].map(chip => chip.textContent);
      return { ratings, more, languages };
    }));
    expect(evidence).toHaveLength(4);
    for (const card of evidence) {
      expect(card.ratings.every(chip => chip.hidden || chip.complete), JSON.stringify(card)).toBe(true);
      for (const chip of card.ratings.filter(chip => chip.hidden)) expect(card.more.some(m => m.title.includes(chip.value)), JSON.stringify(card)).toBe(true);
      expect(card.languages[0]).toBe('EN');
      if (viewport === 420) expect(card.more.length, JSON.stringify(card)).toBeGreaterThan(0);
    }
    await page.evaluate(() => {
      JellyfinEnhanced.currentSettings.tagGroupCaps.language = 1;
      JellyfinEnhanced.core.tagLayout.invalidateSettings();
      document.querySelectorAll('.card .je-tag-host').forEach(host => JellyfinEnhanced.core.tagLayout.refreshPresentation(host));
      JellyfinEnhanced.core.tagLayout.flushFit();
    });
    expect(await page.locator('[data-je-group="language"] .language-chip').count()).toBe(4);
    expect(await page.locator('[data-je-group="language"] .je-tag-more:not([data-je-overflow])').count()).toBe(0);
  });
}
