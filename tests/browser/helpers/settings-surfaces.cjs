// Real settings surfaces in a fixture page, for the standing settings guards: the admin Media Tags
// page (admin-tags.js and its sections), the personal Media Tags hub (the panel host around
// ui-panel-media-tags.js) and the item Media Tags editor. Server calls are answered from fixtures.
const path = require('node:path');
const root = path.resolve(__dirname, '../../../Jellyfin.Plugin.JellyfinEnhanced/js');
const english = require('../../../Jellyfin.Plugin.JellyfinEnhanced/js/locales/en.json');

const LIBRARY = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const ITEM = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

// Jellyfin web's UI font family (the repo ships its bold cut for native posters): text is measured as wide
// as on a real dashboard, not in the fixture's narrower default face.
// JE.t exactly as plugin.js defines it (plural forms included), not a stand-in.
const pluginSource = require('node:fs').readFileSync(path.join(root, 'plugin.js'), 'utf8');
const translate = pluginSource.slice(pluginSource.indexOf('        t: (key, params = {}) => {'), pluginSource.indexOf('        loadSettings: () =>'));

const noto = require('node:zlib').brotliDecompressSync(require('node:fs').readFileSync(path.join(root, '../Assets/PosterTags/fonts/NotoSans-Bold.ttf.br'))).toString('base64');

/** Shared JE globals and an ApiClient whose answers come from small fixtures. */
async function base(page, { plugin = {}, settings = {}, admin = true, theme = 'dark' } = {}) {
  await page.goto('/');
  await page.addStyleTag({ content: `@font-face { font-family: 'JE Fixture Noto'; src: url(data:font/ttf;base64,${noto}); } html, body, button, input, select, textarea { font-family: 'JE Fixture Noto', sans-serif; }` });
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(({ english, plugin, settings, admin, theme, LIBRARY, ITEM, translate }) => {
    document.documentElement.dataset.jeFixtureTheme = theme;
    document.documentElement.style.colorScheme = theme;
    // The host page's own colours, which the surfaces detect their theme from.
    document.documentElement.style.backgroundColor = document.body.style.backgroundColor = theme === 'light' ? '#ffffff' : '#101010';
    document.documentElement.style.color = document.body.style.color = theme === 'light' ? '#111111' : '#ffffff';
    document.body.innerHTML = '';
    // Jellyfin web's icon font draws a ligature ("arrow_upward") as one 1em glyph; the fixture has no
    // font file, so each ligature gets the glyph's box instead of spelling out its name.
    const icons = document.createElement('style');
    icons.textContent = '.material-icons, .material-icons-outlined, .material-symbols-outlined, .je-msym, .je-msym-outlined { display: inline-block; width: 1em; height: 1em; overflow: hidden; line-height: 1; white-space: nowrap; color: transparent; vertical-align: middle; flex-shrink: 0; }';
    document.head.append(icons);
    // eslint-disable-next-line no-eval
    const { t } = (0, eval)(`({${translate}})`);
    window.JellyfinEnhanced = { core: {}, helpers: {}, internals: {}, pluginConfig: { TagCacheServerMode: true, ...plugin },
      userConfig: { settings: { tagLayoutSettingsVersion: 1, qualityTagsEnabled: true, ratingTagsEnabled: true, statusTagsEnabled: true, genreTagsEnabled: true,
        languageTagsEnabled: true, ageRatingTagsEnabled: true, ...settings, isAdmin: admin }, shortcuts: { Shortcuts: [] } },
      currentSettings: {}, t, translations: english, translationsLang: 'en', IconName: {}, toast() {}, keyListener() {}, initializeShortcuts() {}, state: { activeShortcuts: { x: 1 } }, pauseScreenInstance: {},
      themer: { getThemeVariables: () => (theme === 'light'
        ? { panelBg: '#fff', secondaryBg: '#f2f2f2', primaryAccent: '#0077aa', altAccent: '#ddd', blur: '0px', textColor: '#111', logo: '' }
        : { panelBg: '#101010', secondaryBg: '#1c1c1c', primaryAccent: '#00a4dc', altAccent: '#222', blur: '0px', textColor: '#fff', logo: '' }) },
      tagPipeline: { registerRenderer() {}, clearProcessed() {}, scheduleScan() {} } };
    window.Dashboard = { alert() {}, showLoadingMsg() {}, hideLoadingMsg() {} };
    window.jeCdnUrl = (p) => `/Jellyfin.Plugin.JellyfinEnhanced/${p}`;
    const config = { TagLayout: 'corners', QualityTagsEnabled: true, GenreTagsEnabled: true, RatingTagsEnabled: true, AgeRatingTagsEnabled: true, StatusTagsEnabled: true,
      LanguageTagsEnabled: true, PeopleTagsEnabled: true, AwardsTagsEnabled: true, LogoTagsEnabled: true, CustomTagsEnabled: true, TagCacheServerMode: true, ...plugin };
    window.__jeFixtureConfig = config;
    window.ApiClient = {
      getCurrentUserId: () => 'admin', serverId: () => 'server', accessToken: () => 'token',
      getUrl: (p, query) => `${location.origin}${p.replace('/JellyfinEnhanced/js/', '/Jellyfin.Plugin.JellyfinEnhanced/js/')}${query ? `?${new URLSearchParams(query)}` : ''}`,
      getPluginConfiguration: async () => ({ ...config }),
      getJSON: async () => [],
      getItem: async () => ({ Id: ITEM, Name: 'Sample Movie', Type: 'Movie', ParentId: LIBRARY, Genres: ['Drama'], OfficialRating: 'PG-13' }),
      getCurrentUser: async () => ({ Policy: { IsAdministrator: admin } }),
      getScaledImageUrl: () => 'data:image/gif;base64,R0lGODlhAQABAAAAACw=',
      ajax: async (request) => {
        const url = new URL(request.url, location.origin);
        if (url.pathname.includes('/JellyfinEnhanced/tag-data/')) return { Items: [{ Id: ITEM, Type: 'Movie', Genres: ['Drama'], OfficialRating: 'PG-13', CommunityRating: 7.5 }] };
        if (request.type && request.type !== 'GET') return { values: {}, Values: {} };
        if (url.pathname.endsWith('/UserViews') || url.pathname.endsWith('/MediaFolders')) return { Items: [{ Id: LIBRARY, Name: 'Movies', CollectionType: 'movies' }] };
        if (url.pathname.endsWith('/Genres')) return { Items: [{ Name: 'Drama' }] };
        if (url.pathname.includes('/JellyfinEnhanced/tag-data/')) return { Items: [{ Id: ITEM, Type: 'Movie', Genres: ['Drama'], OfficialRating: 'PG-13', CommunityRating: 7.5 }] };
        if (url.pathname.includes('/Items')) return { Items: [{ Id: ITEM, Name: 'Sample Movie', Type: 'Movie' }], TotalRecordCount: 1 };
        return null;
      },
    };
  }, { english, plugin, settings, admin, theme, LIBRARY, ITEM, translate });
}

/** Load plugin scripts in order (paths relative to js/). */
async function load(page, files) {
  for (const file of files) await page.addScriptTag({ path: path.join(root, file) });
}

const CORE = ['core/ui-kit.js', 'core/media-language.js', 'core/tag-renderer-base.js', 'core/tag-layout.js', 'core/tag-look.js', 'tags/tag-layout-styles.js',
  'tags/rating-sources.js', 'tags/status-vocabulary.js',
  // The group modules carry the chip styles the live previews draw with (as on a real dashboard and hub).
  'tags/statustags.js', 'tags/qualitytags.js', 'tags/ratingtags.js', 'tags/ageratingtags.js', 'tags/languagetags.js', 'tags/genretags.js', 'tags/logotags.js', 'tags/awardstags.js'];

/** The admin Media Tags page, mounted the way Jellyfin's plugin page does. */
async function adminPage(page, options = {}) {
  await base(page, options);
  await page.evaluate(() => { document.body.innerHTML = '<div id="adminPage" class="page type-interior"><div class="content-primary"><div class="je-tag-admin"></div></div></div>'; });
  // The page's own stylesheet, as Configuration/mediaTagsPage.html links it.
  await page.addStyleTag({ path: path.join(root, 'enhanced/admintags/admin-tags.css') });
  await load(page, [...CORE, 'enhanced/settingspanel/ui-panel-tag-editor.js', 'enhanced/settingspanel/ui-panel-tag-preview.js', 'enhanced/admintags/admin-tags.js']);
  await page.evaluate(async () => { window.admin = await window.JellyfinEnhanced.adminTags.mount(document.querySelector('#adminPage')); });
  await page.waitForSelector('.je-tag-admin [role="tab"]');
  await page.waitForTimeout(300);
}

/** The personal settings panel open on its Media Tags hub. */
async function hub(page, options = {}) {
  await base(page, options);
  // Panel controls outside the Media Tags hub that the settings wiring binds by id.
  await page.evaluate(() => {
    const others = ['autoPauseToggle', 'autoResumeToggle', 'autoPipToggle', 'autoSkipIntroToggle', 'autoSkipOutroToggle', 'randomButtonToggle', 'randomUnwatchedOnly',
      'randomScopeCurrentContainer', 'showWatchProgressToggle', 'showFileSizesToggle', 'showAudioLanguagesToggle', 'removeContinueWatchingToggle', 'pauseScreenToggle',
      'disableCustomSubtitleStyles', 'longPress2xEnabled', 'randomIncludeMovies', 'randomIncludeShows'];
    document.body.innerHTML = `<div hidden>${others.map((id) => `<input type="checkbox" id="${id}">`).join('')}<input id="pauseScreenDelayInput"><button id="releaseNotesBtn"></button></div><button id="opener">open</button>`;
  });
  await load(page, [...CORE, 'enhanced/config.js', 'enhanced/icons.js', 'enhanced/helpers.js']);
  await page.evaluate(() => {
    const JE = window.JellyfinEnhanced;
    JE.currentSettings = JE.loadSettings();
    JE.escapeHtml = JE.core.ui.escapeHtml;
  });
  // The production panel template, for its stylesheet (the panel shell's grid, scroll areas and phone layout).
  await page.evaluate(() => Object.assign(window.JellyfinEnhanced, { fontSizePresets: [{ size: 1 }, { size: 1 }, { size: 1 }], fontFamilyPresets: [{ family: 'sans-serif' }],
    subtitlePresets: [], subtitleTextEffectPresets: [], decodeSubtitleColor: () => ({ swatch: '#fff', alphaValue: 255 }), getSubtitleTextShadow: () => 'none' }));
  await load(page, ['enhanced/settingspanel/ui-panel-settings.js', 'enhanced/settingspanel/ui-panel-tag-editor.js', 'enhanced/settingspanel/ui-panel-tag-looks.js',
    'enhanced/settingspanel/ui-panel-tag-preview.js', 'enhanced/settingspanel/ui-panel-tag-portable.js', 'enhanced/settingspanel/ui-panel-media-tags.js',
    'enhanced/settingspanel/ui-panel-template.js']);
  await page.evaluate(() => {
    const ui = window.JellyfinEnhanced.internals.enhancedUi;
    const production = ui.buildPanelHtml;
    const shellStyle = (ctx) => { try { return (production(ctx).match(/<style>[\s\S]*?<\/style>/) || [''])[0]; } catch (e) { return ''; } };
    ui.buildPanelHtml = (ctx) => shellStyle(ctx) + '<div class="panel-header"><div id="jePanelTitle">Jellyfin Enhanced</div><button id="closeSettingsPanel">Close</button></div>'
      + '<div class="je-panel-dock"><select id="jePanelSection"></select></div><div class="je-panel-body"><nav class="je-panel-nav"><input id="jePanelSearch" type="search"><ul id="jePanelSearchResults" hidden></ul><div class="je-panel-nav-items"></div></nav>'
      + `<div class="je-panel-main"><button id="jePanelBack">Back</button>${ui.buildMediaTagsHubHtml(ctx)}</div></div>`;
    for (const name of ['wireShortcutEditor', 'wireHiddenContentListeners', 'wireLanguageControls', 'wireMiscSettingsControls']) ui[name] = ui[name] || (() => {});
  });
  await load(page, ['enhanced/settingspanel/ui-panel.js']);
  await page.evaluate(async () => { await window.JellyfinEnhanced.showEnhancedPanel(); });
  // On a phone the panel opens on its section list: choose Media Tags, as a user does.
  await page.waitForSelector('#jeMediaTagsHub [role="tab"]', { state: 'attached' });
  await page.evaluate(() => {
    const select = document.querySelector('#jePanelSection');
    if (select && select.value !== 'media-tags') { select.value = 'media-tags'; select.dispatchEvent(new Event('change', { bubbles: true })); }
    document.querySelector('.je-panel-nav-items [data-tab="media-tags"]')?.click();
  });
  await page.waitForSelector('#jeMediaTagsHub [role="tab"]');
  await page.waitForTimeout(300);
}

/** The item Media Tags editor (the card menu's "Media Tags…"), open on a movie. */
async function itemEditor(page, options = {}) {
  // Without the server cache the editor reads the item's tag data the way the batch path does.
  await base(page, { ...options, plugin: { TagCacheServerMode: false, ...(options.plugin || {}) } });
  await page.evaluate(() => {
    const JE = window.JellyfinEnhanced;
    JE.currentSettings = { ...JE.userConfig.settings };
    JE.escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    JE.saveUserSettings = async () => {};
    JE.session = { onUserChange() {}, getEpoch: () => 0, getUserId: () => 'admin', isCurrent: () => true };
    document.body.innerHTML = '<div id="sheets"></div>';
  });
  await load(page, ['core/ui-kit.js', 'core/dom-observer.js', 'core/media-language.js', 'core/tag-renderer-base.js', 'core/tag-layout.js', 'core/tag-look.js', 'tags/tag-layout-styles.js',
    'tags/rating-sources.js', 'tags/status-vocabulary.js', 'tags/statustags.js', 'tags/qualitytags.js', 'tags/ratingtags.js', 'tags/ageratingtags.js', 'tags/languagetags.js',
    'tags/genretags.js', 'tags/tag-pipeline.js', 'enhanced/settingspanel/ui-panel-tag-preview.js', 'tags/tag-item-editor.js']);
  // The group renderers, registered with the real pipeline, so the editor's sample draws real tags.
  await page.evaluate(() => {
    const JE = window.JellyfinEnhanced;
    for (const init of ['initializeGenreTags', 'initializeQualityTags', 'initializeRatingTags', 'initializeAgeRatingTags', 'initializeLanguageTags', 'initializeStatusTags']) {
      try { JE[init]?.(); } catch (e) { console.warn(init, e); }
    }
  });
  await page.evaluate(async (id) => { await window.JellyfinEnhanced.tagItemEditor.open(id); }, ITEM);
  await page.waitForSelector('.je-tie-groups [data-group]');
  await page.waitForTimeout(300);
}

module.exports = { base, load, adminPage, hub, itemEditor, english, root, LIBRARY, ITEM };
