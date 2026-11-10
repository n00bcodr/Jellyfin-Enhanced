// The whole settings panel as production loads it: every TypeScript-built panel bundle in manifest
// order, the real template and section wiring, the real settings save path and the generated
// settings-document validator. Server calls are answered from fixtures.
const { test, expect } = require('@playwright/test');
const { base, load } = require('./helpers/settings-surfaces.cjs');
// The loader's own document key conversions (bootstrap/loader/keys.ts; the settings document crosses them both ways).
const { loaderSource } = require('./helpers/loader-source.cjs');

const CORE = ['core/ui-kit.js', 'core/media-language.js', 'core/tag-renderer-base.js', 'core/tag-layout.js', 'core/tag-look.js', 'tags/tag-layout-styles.js',
  'tags/rating-sources.js', 'tags/status-vocabulary.js', 'tags/statustags.js', 'tags/qualitytags.js', 'tags/ratingtags.js', 'tags/ageratingtags.js',
  'tags/languagetags.js', 'tags/genretags.js', 'tags/logotags.js', 'tags/awardstags.js', 'enhanced/config.js', 'enhanced/icons.js', 'enhanced/helpers.js', 'contracts/bootstrap.js'];
const PANEL = ['enhanced/ui-styles.js', ...['ui-entry-points', 'ui-release-notes', 'ui-panel-template', 'ui-panel-shortcut-editor', 'ui-panel-settings', 'ui-panel-tag-editor',
  'ui-panel-hidden-content', 'ui-panel-language', 'ui-panel-tag-looks', 'ui-panel-tag-preview', 'ui-panel-tag-portable', 'ui-panel-media-tags', 'ui-panel-resize',
  'ui-panel'].map(name => `enhanced/settingspanel/${name}.js`)];

async function boot(page) {
  const { contractValue } = await import('../frontend/contracts/fixtures.mjs');
  const snapshot = contractValue('RevisionedSettingsResponse', { Revision: 'browser-r2', Settings: { IsAdmin: true, AutoPauseEnabled: false, SubtitleHorizontalPosition: 50, SubtitleVerticalPosition: 95 } });
  await base(page);
  await page.evaluate(({ snapshot, loader }) => {
    // eslint-disable-next-line no-eval
    const { toCamelCase, toPascalCase } = (0, eval)(loader);
    Object.assign(window.JellyfinEnhanced, { toCamelCase, toPascalCase });
    document.body.innerHTML = '<main id="page"><button id="opener">Open settings</button><a id="outside" href="#">outside</a></main>';
    window.panelRequests = [];
    const fixture = window.ApiClient.ajax;
    Object.assign(window.ApiClient, {
      getSessions: async () => [],
      ajax: async (request) => {
        window.panelRequests.push({ type: request.type || 'GET', url: String(request.url), data: request.data || null });
        const url = String(request.url);
        if (url.includes('/settings-document')) {
          // Like the real store: a save replaces the known fields and advances the revision a later read returns.
          if (request.type !== 'POST') return JSON.parse(JSON.stringify(snapshot));
          const posted = JSON.parse(request.data);
          if (posted.Revision !== snapshot.Revision) throw new Error('409 stale revision');
          for (const key of Object.keys(posted.Settings)) if (Object.hasOwn(snapshot.Settings, key) && key !== 'IsAdmin') snapshot.Settings[key] = posted.Settings[key];
          snapshot.Revision = `browser-saved-${window.panelRequests.length}`;
          return { Revision: snapshot.Revision };
        }
        if (url.includes('/user-settings/')) return null;
        if (url.endsWith('/Localization/Cultures') || url.endsWith('/JellyfinEnhanced/locales')) return [];
        return fixture(request);
      },
    });
    window.fetch = async () => new Response('[]', { status: 404 });
  }, { snapshot, loader: loaderSource() });
  await load(page, CORE);
  await page.evaluate(() => {
    const JE = window.JellyfinEnhanced;
    JE.currentSettings = JE.loadSettings();
    JE.escapeHtml = JE.core.ui.escapeHtml;
    Object.assign(JE, {
      pluginVersion: '12.0.0',
      pluginConfig: { ...JE.pluginConfig, Shortcuts: [{ Name: 'OpenSearch', Key: '/', Label: 'Open Search', Category: 'Global' }, { Name: 'FrameStepBack', Key: ',', Label: 'Frame back', Category: 'Player' }] },
      fontSizePresets: [{ name: 'Tiny', previewText: 'Aa', size: 0.6 }, { name: 'Small', previewText: 'Aa', size: 0.8 }, { name: 'Normal', previewText: 'Aa', size: 1 }],
      fontFamilyPresets: [{ name: 'Default', previewText: 'Aa', family: 'inherit' }],
      subtitlePresets: [{ name: 'Clean', previewText: 'Aa', textColor: '#FFFFFFFF', bgColor: '#00000000' }, { name: 'Boxed', previewText: 'Aa', textColor: '#FFFF00FF', bgColor: '#000000CC' }],
      subtitleTextEffectPresets: [{ name: 'Auto', previewText: 'Aa' }, { name: 'Outline', previewText: 'Aa' }],
      decodeSubtitleColor: (value, fallback) => ({ swatch: typeof value === 'string' ? value.slice(0, 7) : fallback.fallbackSwatch, alphaValue: fallback.fallbackAlphaValue }),
      getSubtitleTextShadow: () => 'none', applySubtitleStyles() {}, applySavedStylesWhenReady() {}, applySubtitlePosition() {}, addRandomButton() {},
    });
  });
  await load(page, PANEL);
}

const posts = page => page.evaluate(() => window.panelRequests.filter(r => r.type === 'POST' && r.url.includes('/settings-document')).map(r => JSON.parse(r.data)));

test('the full panel opens on the revisioned document, saves with its revision, and releases the page on close', async ({ page }, testInfo) => {
  // The desktop two-column journey; the phone's stacked layers are covered by settings-overflow and settings-matrix.
  test.skip(testInfo.project.name === 'mobile-chromium', 'desktop layout journey');
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await boot(page);
  await page.focus('#opener');
  await page.evaluate(() => window.JellyfinEnhanced.showEnhancedPanel());
  const dialog = page.locator('#jellyfin-enhanced-panel[role="dialog"]');
  await expect(dialog).toBeVisible();
  expect(await page.evaluate(() => window.panelRequests.some(r => r.type === 'GET' && /\/settings-document\?_=\d+$/.test(r.url)))).toBe(true);
  expect(await page.evaluate(() => window.JellyfinEnhanced.userConfig.settingsRevision)).toBe('browser-r2');
  await expect(page.locator('#page')).toHaveAttribute('inert', '');

  // Every pane is reachable from the nav rail the panes build.
  const nav = page.locator('.je-panel-nav-items .tab-button');
  expect(await nav.count()).toBeGreaterThanOrEqual(8);
  await page.locator('.je-panel-nav-items [data-tab="playback"]').click();
  await page.locator('#autoPauseToggle').check();
  await expect.poll(async () => (await posts(page)).length).toBeGreaterThan(0);
  await expect.poll(async () => (await posts(page)).at(-1).Settings.AutoPauseEnabled).toBe(true);
  // The first save carries the opened document's revision; each later one the previous receipt's (no conflict).
  const chain = (await posts(page)).map(p => p.Revision);
  expect(chain[0]).toBe('browser-r2');
  for (const revision of chain.slice(1)) expect(revision).toMatch(/^browser-saved-\d+$/);

  // The settings search finds a control by name and focuses it in its pane.
  await page.locator('#jePanelSearch').fill('audio languages');
  await expect(page.locator('#jePanelSearchResults button').first()).toBeVisible();
  await page.locator('#jePanelSearch').press('Enter');
  await expect(page.locator('#showAudioLanguagesToggle')).toBeFocused();
  await expect(page.locator('.je-pane[data-pane="ui"]')).toHaveClass(/active/);
  // Clearing the search shows every section again.
  await page.locator('#jePanelSearch').fill('');
  await expect(page.locator('.je-panel-nav-items [data-tab="subtitles"]')).toBeVisible();

  // Dragging on the subtitle position grid follows the pointer and saves on release.
  await page.locator('.je-panel-nav-items [data-tab="subtitles"]').click();
  const grid = page.locator('#subtitlePositionGrid');
  await grid.scrollIntoViewIfNeeded();
  const box = await grid.boundingBox();
  await page.mouse.move(box.x + box.width * 0.25, box.y + box.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.75, box.y + box.height * 0.3, { steps: 4 });
  await page.mouse.up();
  await expect.poll(async () => (await posts(page)).at(-1).Settings.SubtitleHorizontalPosition).toBe(75);
  const afterDrag = (await posts(page)).length;

  // Escape closes through the full teardown: the page is live again and focus returns to the opener.
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('#page')).not.toHaveAttribute('inert', '');
  await expect(page.locator('#opener')).toBeFocused();
  // A closed panel's drag listeners are gone: page-wide pointer moves change nothing.
  await page.mouse.move(box.x + 5, box.y + 5);
  await page.mouse.down();
  await page.mouse.move(box.x + 40, box.y + 40, { steps: 3 });
  await page.mouse.up();
  await page.waitForTimeout(100);
  expect((await posts(page)).length).toBe(afterDrag);
  expect(await page.evaluate(() => window.JellyfinEnhanced.currentSettings.subtitleHorizontalPosition)).toBe(75);

  // Opening again builds a fresh panel (one dialog, one nav) on the last section.
  await page.evaluate(() => window.JellyfinEnhanced.showEnhancedPanel());
  await expect(dialog).toBeVisible();
  await expect(page.locator('#jellyfin-enhanced-panel')).toHaveCount(1);
  expect(await nav.count()).toBe(await page.locator('.je-pane').count());
  await expect(page.locator('.je-pane[data-pane="subtitles"]')).toHaveClass(/active/);
  // Tab stays inside the dialog.
  for (let i = 0; i < 6; i++) await page.keyboard.press('Shift+Tab');
  expect(await page.evaluate(() => document.getElementById('jellyfin-enhanced-panel').contains(document.activeElement))).toBe(true);
  await page.locator('#closeSettingsPanel').click();
  await expect(dialog).toHaveCount(0);
  expect(errors).toEqual([]);
});
