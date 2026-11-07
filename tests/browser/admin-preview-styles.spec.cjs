const { test, expect } = require('@playwright/test');
const path = require('node:path');
const root = path.resolve(__dirname, '../../Jellyfin.Plugin.JellyfinEnhanced/js');
const english = require('../../Jellyfin.Plugin.JellyfinEnhanced/js/locales/en.json');

/** Use the real admin seed and shared preview with no tag renderers initialized. */
async function setup(page, personal, defaults, admin = true) {
  // The configuration page holding the Media Tags tab (#media-tags), as configPage.html has it.
  await page.setContent('<div id="adminPage" data-role="page"><div id="media-tags"><div class="je-tag-admin" style="width:340px"><div id="preview"></div></div></div></div><a id="movies" href="#/movies">Movies</a>');
  await page.evaluate(({ personal, defaults, english }) => {
    window.JellyfinEnhanced = { currentSettings: { tagLayoutSettingsVersion: 1, ...personal }, pluginConfig: {},
      t: (key, params = {}) => Object.entries(params).reduce((s, [key, value]) => s.replace(`{${key}}`, value), english[key] || key),
      helpers: {}, tagPipeline: { registerRenderer() { throw new Error('preview activated a renderer'); } } };
    window.defaults = { TagLayout: 'corners', StatusTagsTrending: true, ...defaults };
  }, { personal, defaults, english });
  for (const file of ['core/ui-kit.js', 'core/tag-renderer-base.js', 'core/tag-layout.js', 'core/tag-look.js',
    'tags/tag-layout-styles.js', 'tags/rating-sources.js', 'tags/status-vocabulary.js', 'tags/statustags.js', 'tags/genretags.js',
    'enhanced/admintags/admin-tags.js', 'enhanced/settingspanel/ui-panel-tag-preview.js']) {
    await page.addScriptTag({ path: path.join(root, file) });
  }
  await page.evaluate(async admin => {
    const JE = window.JellyfinEnhanced;
    if (admin === 'page') {
      window.Dashboard = {};
      window.jeCdnUrl = path => `/Jellyfin.Plugin.JellyfinEnhanced/${path}`;
      window.ApiClient = {
        getCurrentUserId: () => 'admin', serverId: () => 'server',
        getUrl: path => `${location.origin}${path.replace('/JellyfinEnhanced/js/', '/Jellyfin.Plugin.JellyfinEnhanced/js/')}`,
        getPluginConfiguration: async () => ({ ...window.defaults }),
        getJSON: async () => [], ajax: async () => null,
      };
      window.admin = await JE.adminTags.mountTab(document.querySelector('#media-tags'));
      // The fixture router emits Jellyfin's view lifecycle on a same-document navigation; shown again with the
      // Media Tags tab open, the configuration page mounts the tab again (pageshow → jeMountMediaTags).
      window.addEventListener('hashchange', () => {
        const away = location.hash === '#/movies';
        document.querySelector('#adminPage').dispatchEvent(new Event(away ? 'viewbeforehide' : 'viewshow'));
        if (!away) JE.adminTags.mountTab(document.querySelector('#media-tags'));
      });
      return;
    }
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

test('navigation away releases admin-only sheets and returning reloads them', async ({ page }) => {
  await page.goto('/');
  await setup(page, { statusTagsEnabled: false, genreTagsEnabled: false }, { StatusTagsEnabled: true, GenreTagsEnabled: true }, 'page');
  const owned = page.locator('style[data-je-tag-preview-owned]');
  await expect(owned).toHaveCount(2);
  await expect(page.locator('.status-tag').first()).toHaveCSS('display', 'flex');
  await page.locator('#movies').click();
  await expect(page).toHaveURL(/#\/movies$/);
  await expect(owned).toHaveCount(0);
  await expect(page.locator('#genre-tags-styles, #jellyfin-enhanced-status-tags-css')).toHaveCount(0);
  await page.evaluate(() => {
    document.dispatchEvent(new Event('je:tag-layout-changed'));
    window.admin.preview.refresh();
  });
  await expect(owned).toHaveCount(0);
  await page.evaluate(() => { location.hash = '#/configurationpage?name=Jellyfin%20Enhanced&jeSection=media-tags'; });
  await expect(owned).toHaveCount(2);
  await expect(page.locator('.genre-tag').first()).toHaveCSS('border-radius', '50%');
  await page.evaluate(() => window.admin.dispose());
  await expect(owned).toHaveCount(0);
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


test('real sample hover and keyboard focus expand genre names and Summary reveal through shared styles', async ({ page }) => {
  await setup(page, { genreTagsEnabled: true, tagLayout: 'corners' }, {}, false);
  const movie = page.locator('[data-sample="movie"] .je-mtp-card');
  const series = page.locator('[data-sample="series"] .je-mtp-card');
  const movieName = movie.locator('.genre-text').first();
  await page.mouse.move(0, 0);
  await expect(movieName).toHaveCSS('opacity', '0');
  await movie.hover();
  await expect(movieName).toHaveCSS('opacity', '1');
  await expect(series.locator('.genre-text').first()).toHaveCSS('opacity', '0');
  await page.mouse.move(0, 0);
  await expect(movieName).toHaveCSS('opacity', '0');
  await series.focus();
  await expect(series.locator('.genre-text').first()).toHaveCSS('opacity', '1');
  await page.evaluate(() => { document.activeElement.blur(); JellyfinEnhanced.currentSettings.tagLayout = 'summary'; window.preview.refresh(); });
  const reveal = movie.locator('[data-je-slot="hover"]');
  await expect(reveal).toHaveCSS('opacity', '0');
  await movie.hover();
  await expect(reveal).toHaveCSS('opacity', '1');
  await expect(series.locator('[data-je-slot="hover"]')).toHaveCSS('opacity', '0');
  await page.locator('[data-view="hover"]').click();
  await expect(series.locator('[data-je-slot="hover"]')).toHaveCSS('opacity', '1');
});

test('the real item editor sample reveals Summary on hover, focus and the touch pin', async ({ page }) => {
  await setup(page, { tagLayout: 'summary', genreTagsEnabled: true, qualityTagsEnabled: false }, {}, false);
  await page.evaluate(() => {
    const JE = JellyfinEnhanced, id = 'a'.repeat(32);
    window.ApiClient = { getCurrentUserId: () => 'admin', serverId: () => 'server', getCurrentUser: async () => ({ Policy: {} }) };
    // Copy the visible item's actual group through the production editor path.
    const sample = document.querySelector('[data-sample="movie"] .je-mtp-card');
    const card = document.createElement('div'); card.className = 'card'; card.dataset.id = id;
    card.innerHTML = '<div class="cardScalable"></div>';document.body.append(card);
    const L = JE.core.tagLayout;
    for (const group of L.GROUPS) {
      const master = L.getGroup(sample.querySelector('.je-tag-host'), group);
      if (master) L.commitGroup(card.firstElementChild, group, master.cloneNode(true));
    }
  });
  await page.addScriptTag({ path: path.join(root, 'tags/tag-item-editor.js') });
  await page.evaluate(() => JellyfinEnhanced.tagItemEditor.open('a'.repeat(32), { item: { Id: 'a'.repeat(32), Type: 'Movie', Name: 'Movie sample' } }));
  const sample = page.locator('.je-tie-card');
  const reveal = sample.locator('.je-tag-slot[data-je-slot="hover"]');
  await expect(sample).toHaveAttribute('tabindex', '0');
  await expect(sample).toHaveAccessibleName('Live preview: Movie sample');
  await expect(reveal).toHaveCSS('opacity', '0');
  await sample.hover();
  await expect(reveal).toHaveCSS('opacity', '1');
  await page.mouse.move(0, 0);
  await expect(reveal).toHaveCSS('opacity', '0');
  await sample.focus();
  await expect(reveal).toHaveCSS('opacity', '1');
  await page.locator('.je-tie-close').focus();
  await expect(reveal).toHaveCSS('opacity', '0');
  await page.locator('.je-tie-view [data-view="hover"]').click();
  await page.mouse.move(0, 0);
  await expect(reveal).toHaveCSS('opacity', '1');
});
