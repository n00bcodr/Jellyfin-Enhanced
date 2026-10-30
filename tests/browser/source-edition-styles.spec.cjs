const { test, expect } = require('@playwright/test');
const path = require('node:path');
const root = path.resolve(__dirname, '../../Jellyfin.Plugin.JellyfinEnhanced/js');

for (const stylesFirst of [false, true]) {
  test(`edition colours inherit Tag Styles with overrides injected ${stylesFirst ? 'first' : 'last'}`, async ({ page }) => {
    await page.setContent('<div class="card" data-id="film"><div class="cardBox"><div class="cardScalable"><div class="je-tag-host"></div></div></div></div>');
    await page.evaluate(() => {
      window.JellyfinEnhanced = {
        currentSettings: { qualityTagsEnabled: true, qualityTagsPreferredAudioLanguage: 'none' },
        pluginConfig: {}, t: key => key,
        tagPipeline: { registerRenderer(name, renderer) { this[name] = renderer; }, clearProcessed() {}, scheduleScan() {} }
      };
    });
    for (const file of ['core/ui-kit.js', 'core/tag-renderer-base.js', 'tags/tag-styles.js', 'tags/qualitytags.js']) {
      await page.addScriptTag({ path: path.join(root, file) });
    }
    await page.evaluate(stylesFirst => {
      const JE = window.JellyfinEnhanced;
      const inject = () => JE.core.ui.injectCss('test-tag-styles', JE.tagStyles.buildCss({ quality: {
        '*': { background: 'rgba(11, 22, 33, 1)', color: 'rgba(44, 55, 66, 1)' },
        Extended: { background: 'rgba(77, 88, 99, 1)', color: 'rgba(111, 122, 133, 1)' }
      } }));
      if (stylesFirst) inject();
      JE.initializeQualityTags();
      if (!stylesFirst) inject();
      window.renderEdition = edition => JE.tagPipeline.quality.renderFromServerCache(document.querySelector('.je-tag-host'), { Edition: edition, StreamData: { Streams: [] } }, edition);
      window.renderEdition('Fan Edit');
    }, stylesFirst);
    const chip = page.locator('[data-je-edition]');
    await expect(chip).toHaveCSS('background-color', 'rgb(11, 22, 33)');
    await expect(chip).toHaveCSS('color', 'rgb(44, 55, 66)');
    await page.evaluate(() => { window.JellyfinEnhanced.reinitializeQualityTags(); window.renderEdition('Fan Edit'); });
    await expect(chip).toHaveCSS('background-color', 'rgb(11, 22, 33)');
    await expect(chip).toHaveCSS('color', 'rgb(44, 55, 66)');
    await page.evaluate(() => { window.JellyfinEnhanced.reinitializeQualityTags(); window.renderEdition('Extended'); });
    await expect(chip).toHaveCSS('background-color', 'rgb(77, 88, 99)');
    await expect(chip).toHaveCSS('color', 'rgb(111, 122, 133)');
  });
}
