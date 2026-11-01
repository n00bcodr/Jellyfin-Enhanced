const { test, expect } = require('@playwright/test');
const path = require('node:path');
const root = path.resolve(__dirname, '../../Jellyfin.Plugin.JellyfinEnhanced/js');

/** Real layout and genre styles around library cards, list rows and an explicit preview. */
async function setup(page) {
  await page.setContent('<style>body{padding:60px}.card,.listItem,.je-tie-side{position:relative;width:180px;height:240px;margin:20px;display:inline-block}.je-tag-host{position:absolute;inset:0}button{position:absolute;top:40px}</style>');
  await page.evaluate(() => {
    document.body.classList.add('je-tags-hide-on-hover');
    for (const cls of ['card', 'listItem', 'je-tie-side']) {
      const el = document.createElement('div'); el.className = cls;
      el.innerHTML = '<button>Focus</button><div class="je-tag-host" data-je-layout="corners"><div class="je-tag-slot" data-je-slot="tl"><div data-je-group="genre" class="genre-overlay-container"><span class="genre-tag"><span class="genre-text">Drama</span></span></div></div></div>';
      document.body.append(el);
    }
    window.JellyfinEnhanced = { core: {}, helpers: {}, currentSettings: { genreTagsEnabled: true, tagsHideOnHover: true }, pluginConfig: {},
      tagPipeline: { registerRenderer(name, renderer) { renderer.injectCss(); } } };
  });
  for (const file of ['core/ui-kit.js', 'core/tag-renderer-base.js', 'core/tag-layout.js', 'tags/tag-layout-styles.js', 'tags/genretags.js']) await page.addScriptTag({ path: path.join(root, file) });
  await page.evaluate(() => {
    const sheet = document.createElement('style');sheet.textContent = JellyfinEnhanced.core.tagLayout.buildStyles();document.head.append(sheet);
    JellyfinEnhanced.initializeGenreTags();
    document.body.classList.add('je-tags-hide-on-hover');
  });
  await page.mouse.move(0, 0);
}

test('Hide on hover preserves focused library Corners slots and only hides pointer-hovered cards', async ({ page }) => {
  await setup(page);
  const slot = page.locator('.card .je-tag-slot');
  await page.locator('.card button').focus();
  await page.waitForTimeout(200);
  await expect(slot).toHaveCSS('opacity', '1');
  await expect(page.locator('.card .genre-text')).toHaveCSS('opacity', '0');
  await page.locator('.card').hover();
  await expect(slot).toHaveCSS('opacity', '0');
});

test('genre names stay hidden on hovered or focused library list rows; preview hooks remain active', async ({ page }) => {
  await setup(page);
  await expect(page.locator('.listItem .genre-text')).toHaveCSS('display', 'none');
  await page.locator('.listItem').hover();
  await expect(page.locator('.listItem .genre-text')).toHaveCSS('opacity', '0');
  await expect(page.locator('.listItem .genre-text')).toHaveCSS('display', 'none');
  await page.locator('.listItem button').focus();
  await expect(page.locator('.listItem .genre-text')).toHaveCSS('opacity', '0');
  await expect(page.locator('.listItem .genre-text')).toHaveCSS('display', 'none');
  await page.evaluate(() => {
    const preview = document.querySelector('.je-tie-side');
    preview.dataset.jeHideOnHover = 'true';
    const card = document.createElement('div');card.className = 'je-tag-reveal';
    card.append(...preview.childNodes);preview.append(card);
  });
  await expect(page.locator('.je-tie-side .genre-text')).toHaveCSS('opacity', '1');
  await expect(page.locator('.je-tie-side .je-tag-slot')).toHaveCSS('opacity', '0');
});
