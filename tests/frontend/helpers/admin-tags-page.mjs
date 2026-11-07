import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createHarness } from './harness.mjs';

// The Media Tags tab of the configuration page (Configuration/configPage.html,
// #media-tags): the real tab core and every real section module over a mocked
// plugin configuration and server. Each test changes controls the way an administrator does and reads
// back what the page saved.

const LIBRARY = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OTHER_LIBRARY = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

/** A configuration as the server hands it out (only the fields the page reads). */
const BASE = {
  AwardsTagsEnabled: false, AwardsTagsPosition: 'top-left', AwardsTagsImdb: true, AwardsTagsCertifiedFresh: true, AwardsTagsOscar: true, AwardsTagsEmmy: true, AwardsTagsLetterboxd: true, AwardsTagsImdbList: 'owner/imdb', AwardsTagsLetterboxdList: 'owner/letterboxd', AwardsTagsRefreshHours: 24,
  LogoTagsEnabled: false, LogoTagsPosition: 'bottom-left', LogoTagsMovieMode: 'provider', LogoTagsSeriesMode: 'network', LogoTagsRegion: '', LogoTagsMaxLogos: 1,
  CustomTagsEnabled: false, CustomTagsPosition: 'top-left', CustomTagRules: [], TagScale: 'default', TagGap: 'default', TagEdgeSpacing: 'default',
  QualityTagsEnabled: true, GenreTagsEnabled: false, LanguageTagsEnabled: true, RatingTagsEnabled: true, AgeRatingTagsEnabled: false, StatusTagsEnabled: true, PeopleTagsEnabled: false,
  ShowResolutionTag: true, ShowSourceTag: true, ShowDynamicRangeTag: true, ShowSpecialFormatTag: true, ShowVideoCodecTag: true, ShowAudioInfoTag: true, ShowEditionTag: true, ShowLowQualitySourceTag: false,
  ResolutionTagOrder: 1, SourceTagOrder: 2, DynamicRangeTagOrder: 3, SpecialFormatTagOrder: 4, VideoCodecTagOrder: 5, AudioInfoTagOrder: 6, EditionTagOrder: 7,
  SeriesQualityAggregation: 'representative', QualityTagsPreferredAudioLanguage: '', QualityTagsAudioLanguageFromUser: false,
  QualityTagsPosition: 'top-left', GenreTagsPosition: 'top-right', LanguageTagsPosition: 'bottom-left', RatingTagsPosition: 'bottom-right', AgeRatingTagsPosition: 'bottom-right', StatusTagsPosition: 'top-right',
  LanguageTagsPriority: '', LanguageTagsPriorityStrict: false, LanguageTagsMergeRegions: false, LanguageTagsShowAudio: true, LanguageTagsShowSubtitles: false, LanguageTagsStyle: 'flags', LanguageTagsCountBadge: 'off',
  RatingTagsOnMovies: true, RatingTagsOnSeries: true, RatingTagsOnSeasons: true, RatingTagsOnEpisodes: true, RatingTagsOnContinueWatching: true, RatingTagsOnNextUp: true,
  RatingTagsShowCommunity: true, RatingTagsShowCritic: true, RatingTagsMinScore: 0, RatingTagsColorByScore: false, ShowRatingInPlayer: true,
  StatusTagsJustAdded: true, StatusTagsNewRelease: true, StatusTagsTrending: true, StatusTagsSchedule: true, StatusTagsMilestones: true, StatusTagsSeriesStatus: false, StatusTagsJustAddedDays: 7, StatusTagsNewReleaseDays: 30,
  StatusTagsLeaving: false, StatusTagsDirectPlay: false, LeavingSoonMaintainerrUrl: '', LeavingSoonMaintainerrApiKey: '', LeavingSoonCollections: '', LeavingSoonRefreshHours: 6,
  // As Jellyfin's plugin configuration API sends them: an unset list is [], an
  // unset object (TagLayouts, TagGroupCaps, TagShapeOverrides, RatingTagsSources) is omitted.
  TagLayout: 'corners', TagLabelDensity: 'full', TagGroupOrder: [], TagLookRules: [],
  TagsHideOnHover: false, DisableTagsOnSearchPage: false,
  TagStylesEnabled: true, TagStyleTarget: 'both', TagStyleOverrides: '', TagStylePreset: 'default', TagStylesAllowUserPreset: false,
  TagCacheServerMode: true, TagCacheExcludeLibraries: false, TagCacheExcludedLibraryIds: '', EnableTagsLocalStorageFallback: false, TagsCacheTtlDays: 30,
  NativePosterTagsEnabled: false, NativePosterTagsWebClientNames: '',
  MdblistApiKey: '', MdblistRatingsEnabled: false, MdblistRatingsFetchEnabled: false, TMDB_API_KEY: 'key',
  // A field this page never touches: saves must keep the server's value.
  DevMode: false,
};

const catalog = { presets: ['default', 'glass'], age: [], groups: { quality: [{ key: '4K', name: '4K' }], ageRating: [], rating: [{ key: 'community', name: 'Community' }], genre: [{ key: 'genre', name: 'Genre' }], status: [{ key: 'added', name: 'Just Added' }], language: [{ key: 'flag', name: 'Flag' }] }, palettes: { default: {}, glass: {} } };

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * POST JellyfinEnhanced/admin/configuration as the server answers it
 * (Helpers/PluginConfigurationPatch.cs): refused with the server's values when
 * an expected field moved on (and is not already the requested value),
 * otherwise only the changed fields are written.
 * @param {object} server
 * @param {{Changes: object, Expected?: object}} body
 */
function serverPatch(server, body) {
  const mutation = body.Changes.TagLookItemOverrides;
  if (mutation && !Array.isArray(mutation)) {
    const ids = new Set([...mutation.Remove, ...mutation.Set.map(e => e.ItemId)]);
    body = { Changes: { ...body.Changes, TagLookItemOverrides: [...(server.TagLookItemOverrides || []).filter(e => !ids.has(e.ItemId)), ...mutation.Set].sort((a,b) => b.LockedAt - a.LockedAt) }, Expected: body.Expected };
    if (!body.Changes.TagLookItemOverrides.length) body.Changes.TagLookItemOverrides = null;
  }
  const conflicts = {};
  for (const [key, before] of Object.entries(body.Expected || {})) {
    if (!same(server[key], before) && !same(server[key], body.Changes[key])) conflicts[key] = structuredClone(server[key] ?? null);
  }
  if (Object.keys(conflicts).length) throw { status: 409, json: async () => ({ conflicts }) };
  Object.assign(server, structuredClone(body.Changes));
  const values = structuredClone(body.Changes);
  if ('LeavingSoonMaintainerrApiKey' in values) values.LeavingSoonMaintainerrApiKey = '';
  return { values };
}

/**
 * A browser realm with the page core and every section module loaded, over a
 * mocked server (`server`), without a page built yet. Field saves go through
 * `patch` (default: serverPatch) and are recorded in `patches`.
 * @param {import('node:test').TestContext} t
 * @param {{server: object, url?: string, apiClient?: object, globals?: object, patch?: Function, routes?: Object<string, Function>, session?: boolean}} options
 *   routes: GET path suffix → answer, before the defaults. session: run the real core/session.js first.
 */
function boot(t, { server, url, apiClient = {}, globals = {}, patch, routes = {}, session = false }) {
  const posts = [];
  const patches = [];
  const h = createHarness({
    html: '<div id="jeTaRoot"></div>',
    url: url || 'http://jellyfin.test/web/index.html#/configurationpage?name=Jellyfin%20Enhanced&jeSection=media-tags',
    JE: { t: (key, params) => (params ? `${key}:${Object.values(params).join('|')}` : key), pluginConfig: {}, currentSettings: {} },
    apiClient: {
      getUrl: (path, query) => `http://jellyfin.test/${path.replace(/^\//, '')}${query ? `?${new URLSearchParams(query)}` : ''}`,
      getJSON: async () => [{ ItemId: LIBRARY, Name: 'Movies' }, { ItemId: OTHER_LIBRARY, Name: 'Shows' }],
      getPluginConfiguration: async () => structuredClone(server),
      ajax: async (request) => {
        const path = new URL(request.url).pathname;
        if (request.type === 'POST' && path.endsWith('/JellyfinEnhanced/admin/configuration')) {
          const body = JSON.parse(request.data);
          patches.push(structuredClone(body));
          return (patch || ((b) => serverPatch(server, b)))(body);
        }
        if (request.type === 'POST') { posts.push(path); return { message: 'started' }; }
        for (const [suffix, answer] of Object.entries(routes)) if (path.endsWith(suffix)) return answer(request);
        if (path.endsWith('/tag-cache/summary')) return { enabled: true, entries: 1234, lastModified: 0, rebuilding: false };
        if (path.endsWith('/Localization/Cultures')) return [{ TwoLetterISOLanguageName: 'en', DisplayName: 'English' }, { TwoLetterISOLanguageName: 'ja', DisplayName: 'Japanese' }];
        if (path.endsWith('/tag-styles/catalog')) return catalog;
        return null;
      },
      ...apiClient,
    },
    // configPage.html defines the local CDN route (flags in the colour editor).
    globals: { jeCdnUrl: (path) => `http://jellyfin.test/JellyfinEnhanced/cdn/${path}`, Dashboard: {}, ...globals },
  });
  // Views are disposed before the realm closes.
  const cleanup = [];
  t.after(() => { for (const fn of cleanup.reverse()) fn(); h.close(); });
  // jsdom has no canvas: the colour editor's parser gets a minimal 2D context.
  h.window.HTMLCanvasElement.prototype.getContext = () => {
    let fill = '#000000';
    return { get fillStyle() { return fill; }, set fillStyle(v) { if (/^(#[0-9a-f]{6}|rgba?\([\d.,\s]+\))$/i.test(String(v).trim())) fill = String(v).trim().toLowerCase(); } };
  };
  h.window.Element.prototype.scrollIntoView = function () {};
  for (const file of ['core/ui-kit.js', 'core/tag-renderer-base.js', 'core/tag-layout.js', 'core/tag-look.js', 'tags/rating-sources.js', 'enhanced/settingspanel/ui-panel-tag-editor.js']) h.load(file);
  if (session) {
    h.JE.core.navigation = { onNavigate: () => {} };
    h.load('core/session.js');
  }
  h.load('enhanced/admintags/admin-tags.js');
  h.JE.escapeHtml = h.JE.core.ui.escapeHtml;
  const A = h.JE.adminTags;
  for (const file of A.SECTION_FILES) h.load(`enhanced/admintags/${file}`);
  const settle = () => new Promise((r) => setTimeout(r, 0));
  /** Set a control's value and fire change as a user would. */
  const change = (el, value) => {
    assert.ok(el, 'control exists');
    if (el.type === 'checkbox' || el.type === 'radio') el.checked = value === undefined ? !el.checked : value;
    else el.value = value;
    el.dispatchEvent(new h.window.Event('change', { bubbles: true }));
  };
  return Object.assign(h, { A, posts, patches, settle, change, cleanup });
}

/**
 * The page over a mocked server.
 * @param {import('node:test').TestContext} t
 * @param {{config?: object, url?: string, confirm?: boolean}} [options]
 */
function setup(t, { config = {}, url, confirm = true, apiClient = {}, patch, routes } = {}) {
  const server = structuredClone({ ...BASE, ...config });
  const confirms = [];
  const h = boot(t, { server, url, apiClient, patch, routes });
  const root = h.document.getElementById('jeTaRoot');
  // The page's own host: ApiClient.getPluginConfiguration and the field patch above.
  const ctx = h.A.createPage(root, structuredClone(server), { confirm: (text, title) => { confirms.push(title); return confirm; } });
  h.cleanup.push(() => ctx.dispose());
  const $ = (sel) => root.querySelector(sel);
  return { ...h, ctx, root, server, confirms, $, $$: (sel) => [...root.querySelectorAll(sel)], save: async () => { await ctx.flush(); } };
}

/**
 * The binding oracle, independent of the page's own declarations: every
 * control id of the old main form's Media Tags and Tag Cache fieldsets
 * (configPage.html at aa1354dd) and the PluginConfiguration field its own
 * load/save line used there.
 */
const OLD_FORM = JSON.parse(readFileSync(new URL('../features/features-admin-tags-page.old-form-fields.json', import.meta.url), 'utf8'));
/** Positions are the nine anchors on Layout defaults now (Corners). */
const POSITION_GROUPS = { qualityTagsPosition: 'quality', genreTagsPosition: 'genre', languageTagsPosition: 'language', ratingTagsPosition: 'rating', ageRatingTagsPosition: 'ageRating', statusTagsPosition: 'status', awardsTagsPosition: 'awards', logoTagsPosition: 'logos', customTagsPosition: 'custom' };
/** Fields the new page writes with a control on purpose: without the server cache the browser cache is always on. */
const ALSO_WRITES = { tagCacheServerMode: ['EnableTagsLocalStorageFallback'] };


const PAGE_FIELDS = JSON.parse(readFileSync(new URL('../../fixtures/admin-tags-page-fields.json', import.meta.url), 'utf8')).fields;

/** Two retained views of the configuration page, each with its Media Tags tab (Jellyfin keeps earlier views in the document). */
const TWO_PAGES = '<div class="page" data-role="page" id="JellyfinEnhancedPage"><div id="media-tags" class="jellyfin-tab-content je-mt-tab active"><div class="je-tag-admin"></div></div></div>'
  + '<div class="page" data-role="page" id="JellyfinEnhancedPage"><div id="media-tags" class="jellyfin-tab-content je-mt-tab active"><div class="je-tag-admin"></div></div></div>';

/**
 * The dashboard's ApiClient identity, switched the way Jellyfin signs out and in
 * (setAuthenticationInfo, which core/session.js follows).
 */
function signedIn(user = 'admin-a', server = 'server-a') {
  const who = { user, server };
  return {
    who,
    apiClient: {
      getCurrentUserId: () => who.user,
      serverId: () => who.server,
      setAuthenticationInfo(token, userId) { who.user = userId || null; },
    },
  };
}


export { LIBRARY, OTHER_LIBRARY, BASE, catalog, same, serverPatch, boot, setup, OLD_FORM, POSITION_GROUPS, ALSO_WRITES, PAGE_FIELDS, TWO_PAGES, signedIn };
