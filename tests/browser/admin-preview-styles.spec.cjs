const { test, expect } = require('@playwright/test');
const path = require('node:path');
const root = path.resolve(__dirname, '../../Jellyfin.Plugin.JellyfinEnhanced/js');
const english = require('../../Jellyfin.Plugin.JellyfinEnhanced/js/locales/en.json');

/** Use the real admin seed and shared preview with no tag renderers initialized. */
async function setup(page, personal, defaults, admin = true) {
  await page.setContent('<div class="je-tag-admin" style="width:340px"><div id="preview"></div></div>');
  await page.evaluate(({ personal, defaults, english }) => {
    window.JellyfinEnhanced = { currentSettings: { tagLayoutSettingsVersion: 1, ...personal }, pluginConfig: {},
      t: (key, params = {}) => Object.entries(params).reduce((s, [key, value]) => s.replace(`{${key}}`, value), english[key] || key),
      helpers: {}, tagPipeline: { registerRenderer() { throw new Error('preview activated a renderer'); } } };
    window.defaults = { TagLayout: 'corners', StatusTagsTrending: true, ...defaults };
  }, { personal, defaults, english });
  for (const file of ['core/ui-kit.js', 'core/tag-renderer-base.js', 'core/tag-layout.js', 'core/tag-look.js',
    'tags/tag-layout-styles.js', 'tags/status-vocabulary.js', 'tags/statustags.js', 'tags/genretags.js',
    'enhanced/admintags/admin-tags.js', 'enhanced/settingspanel/ui-panel-tag-preview.js']) {
    await page.addScriptTag({ path: path.join(root, file) });
  }
  await page.evaluate(admin => {
    const JE = window.JellyfinEnhanced;
    window.preview = JE.internals.enhancedUi.createTagPreview(document.querySelector('#preview'), admin
      ? { source: () => ({ settings: JE.adminTags.seedUser(window.defaults), plugin: window.defaults }) } : {});
  }, admin);
}

test('admin preview styles server-enabled Status and Genre with both personal groups off', async ({ page }) => {
  await setup(page, { statusTagsEnabled: false, genreTagsEnabled: false }, { StatusTagsEnabled: true, GenreTagsEnabled: true });
  await expect(page.locator('[data-sample="movie"] .status-tag--trending').first()).toHaveText('#3 Today');
  await expect(page.locator('.status-tag').first()).toHaveCSS('display', 'flex');
  await expect(page.locator('.status-tag').first()).toHaveCSS('background-color', 'rgba(15, 15, 15, 0.72)');
  await expect(page.locator('.genre-tag').first()).toHaveCSS('border-radius', '50%');
  await expect(page.locator('.genre-tag').first()).toHaveCSS('background-color', 'rgba(10, 10, 10, 0.8)');
  await expect(page.locator('.genre-tag .je-msym-outlined').first()).toHaveCSS('font-family', '"JE Material Symbols Outlined"');
  expect(await page.evaluate(() => [JellyfinEnhanced.currentSettings.statusTagsEnabled, JellyfinEnhanced.currentSettings.genreTagsEnabled])).toEqual([false, false]);
});

test('admin preview omits server-disabled groups and styles them immediately when the draft enables them', async ({ page }) => {
  await setup(page, { statusTagsEnabled: true, genreTagsEnabled: true }, { StatusTagsEnabled: false, GenreTagsEnabled: false });
  await expect(page.locator('.status-tag, .genre-tag')).toHaveCount(0);
  await expect(page.locator('#genre-tags-styles, #jellyfin-enhanced-status-tags-css')).toHaveCount(0);
  await page.evaluate(() => { Object.assign(window.defaults, { StatusTagsEnabled: true, GenreTagsEnabled: true }); window.preview.refresh(); });
  await expect(page.locator('.status-tag').first()).toHaveCSS('display', 'flex');
  await expect(page.locator('.genre-tag').first()).toHaveCSS('border-radius', '50%');
  await expect(page.locator('.genre-tag').first()).toHaveCSS('background-color', 'rgba(10, 10, 10, 0.8)');
});

test('hub preview keeps personal group switches when server defaults disagree', async ({ page }) => {
  await setup(page, { statusTagsEnabled: false, genreTagsEnabled: false }, { StatusTagsEnabled: true, GenreTagsEnabled: true }, false);
  await expect(page.locator('.status-tag, .genre-tag')).toHaveCount(0);
  await page.evaluate(() => { Object.assign(JellyfinEnhanced.currentSettings, { statusTagsEnabled: true, genreTagsEnabled: true }); window.preview.refresh(); });
  await expect(page.locator('.status-tag').first()).toHaveCSS('display', 'flex');
  await expect(page.locator('.genre-tag').first()).toHaveCSS('border-radius', '50%');
  await expect(page.locator('.genre-tag').first()).toHaveCSS('background-color', 'rgba(10, 10, 10, 0.8)');
});
