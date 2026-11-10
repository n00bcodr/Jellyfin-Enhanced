/**
 * @file The Media Tags tab of the administrator configuration page
 * (Configuration/configPage.html, `#media-tags`): a hub-like view of every
 * server-wide Media Tags setting, built from section modules
 * (js/enhanced/admintags/sections/*.js). The configuration page mounts it
 * the first time the tab opens (mountTab); it lives outside the page's
 * whole-form <form>, so that form's Save never reads or writes its fields.
 *
 * A section module calls `JE.adminTags.registerSection(def)` (types.ts
 * SectionDef). `fields` is a declarative list, one object per control: `id`
 * is the control's DOM id (kept so search, What's New and the generators
 * keep tracking it), `key` the PluginConfiguration field it reads and writes.
 * These declarations, and each section's `writes`, are the only fields the
 * page writes: pageFields() collects them, and the server's patch
 * (Shared/MediaTags/MediaTagsPageFields.cs) accepts the same list and nothing else.
 *
 * Every change writes the field into the page's working copy and saves it on
 * its own after a short pause (save-store.ts). The configuration page's own
 * Save runs inside holdSaves(), so it never puts an older Media Tags value back.
 *
 * Not part of the user bundle: the configuration page loads this file and the
 * section modules itself, in SECTION_FILES order. It relies on the JE client
 * bundle the dashboard already runs (core/tag-layout.js and the hub's preview).
 */
import { adminBridge, apiClient, dashboard, optionalApiClient } from './host';
import { createLifecycle, type MountState } from './mount';
import { controlValue, fieldHtml, fieldsHtml, fieldValue, redrawList, type TextKit } from './fields';
import { fmt, WORDS, type FmtParams } from './format';
import { createPage as buildPage, fieldName, type PageDeps } from './page';
import { createSaveStore } from './save-store';
import type { AdminTagsCore, PageContext, PageOptions, SectionDef, TabDef, Target } from './types';
import { TAB_IDS } from './types';
import type { Config } from './values';

const JE = adminBridge();

const PLUGIN_ID = 'f69e946a-4b3c-4e9a-8f0a-8d7c1b2c4d9b';
/** The configuration page's name and the Media Tags tab's id on it (`&tab=`). */
const MAIN_PAGE_NAME = 'Jellyfin Enhanced';
const TAB_ID = 'media-tags';
/** The page the settings had before they became a tab: its address now redirects here. */
const LEGACY_PAGE_NAME = 'JellyfinEnhancedMediaTags';
const SAVE_DELAY_MS = 400;
const UNDO_MS = 10000;
const TAB_STORE_KEY = 'JE_mediaTagsAdminTab';
const PREVIEW_STYLE_ID = 'je-tag-admin-preview-styles';

/** The section modules the page loads, in order (paths under js/enhanced/admintags/). */
const SECTION_FILES = [
    'tag-styles-editor.js',
    'custom-rules-editor.js',
    'sections/overview.js',
    'sections/layout.js',
    'sections/quality.js',
    'sections/genre.js',
    'sections/language.js',
    'sections/rating.js',
    'sections/agerating.js',
    'sections/status.js',
    'sections/people.js',
    'sections/awards.js',
    'sections/logos.js',
    'sections/custom.js',
    'sections/rules.js',
    'sections/colours.js',
    'sections/badges.js',
    'sections/server.js',
    'sections/portable.js',
];

/**
 * Who each card's settings reach: 'new' = the defaults a brand-new user
 * starts with, 'all' = every user now (shared, server-wide).
 */
const SECTION_SCOPES: Readonly<Record<string, 'new' | 'all'>> = {
    'layout-look': 'new', 'layout-groups': 'new', 'layout-shapes': 'new', rules: 'new', 'badges-families': 'new',
    colours: 'all', 'badges-windows': 'all', 'badges-tmdb': 'all', 'badges-leaving': 'all',
    'item-looks': 'all', 'server-cache': 'all', 'server-native': 'all', 'server-presets': 'all',
};

/** The icon in each card's header (the configuration page's cards carry one). */
const SECTION_ICONS: Readonly<Record<string, string>> = {
    'layout-look': 'view_quilt', 'layout-groups': 'reorder', 'layout-shapes': 'crop_portrait', 'layout-display': 'tune',
    'rules': 'rule', 'rules-locks': 'lock', 'item-looks': 'movie', 'colours': 'palette',
    'badges-families': 'new_releases', 'badges-windows': 'schedule', 'badges-tmdb': 'img:selfhst/svg/tmdb.svg', 'badges-leaving': 'event_busy',
    'server-cache': 'storage', 'server-native': 'devices', 'server-portable': 'import_export', 'server-presets': 'bookmarks',
};

/** The tabs, in order. */
const TABS: readonly TabDef[] = [
    { id: 'overview', icon: 'dashboard', nameKey: 'Overview', descKey: 'What new users get today and the state of the tag cache. Users can still change their own look in their Media Tags settings.', lead: 'card' },
    { id: 'layout', icon: 'view_quilt', nameKey: 'Layout defaults', shortKey: 'Layout', descKey: 'The layout, label density, group order, positions and limits new users start with.', lead: 'card' },
    { id: 'groups', icon: 'label', nameKey: 'Groups', descKey: 'Turn each tag group on or off for new users, and open a group for its server settings.', lead: 'card' },
    { id: 'rules', icon: 'rule', nameKey: 'Rules', descKey: 'Give some cards a different look by library, type, genre or age rating.', lead: 'card' },
    { id: 'colours', icon: 'palette', nameKey: 'Colours', descKey: 'The colours of the tags, on the web and in native posters.', lead: 'card' },
    { id: 'badges', icon: 'new_releases', nameKey: 'Status badges', shortKey: 'Badges', descKey: 'Which status badges new users start with, and how long a title counts as new.', lead: 'card' },
    { id: 'server', icon: 'dns', nameKey: 'Server', descKey: 'The tag data the server keeps, and tags drawn into poster images for other apps.', lead: 'card' },
];

/** The user guide section behind each tab (docs/enhanced/tags.md headings). */
const DOCS_URL = 'https://n00bcodr.github.io/Jellyfin-Enhanced/enhanced/tags/';
const DOCS_ANCHORS = { overview: 'set-up-your-tags', layout: 'layouts', groups: 'tag-groups-order-position-limits', rules: 'rules-and-locked-items', colours: 'tag-styles-and-css', badges: 'badges-and-priority', server: 'server-side-tag-cache' };

/**
 * The tag settings a new user's document copies from the configuration
 * (Features/Settings/JeSettingsController.cs LoadUserSettingsDocument and
 * the ApplyDefaults helpers it calls), PascalCase on the server.
 */
const SEEDED_KEYS = [
    'QualityTagsEnabled', 'ShowResolutionTag', 'ShowSourceTag', 'ShowEditionTag', 'EditionTagOrder', 'ShowRuntimeTag', 'RuntimeTagOrder', 'ShowAspectRatioTag', 'AspectRatioTagOrder', 'ShowFrameRateTag', 'FrameRateTagOrder', 'ShowVersionsTag', 'VersionsTagOrder', 'ShowLowQualitySourceTag',
    'ShowDynamicRangeTag', 'ShowSpecialFormatTag', 'ShowVideoCodecTag', 'ShowAudioInfoTag', 'ResolutionTagOrder', 'SourceTagOrder',
    'DynamicRangeTagOrder', 'SpecialFormatTagOrder', 'VideoCodecTagOrder', 'AudioInfoTagOrder', 'GenreTagsEnabled', 'LanguageTagsEnabled',
    'RatingTagsEnabled', 'AgeRatingTagsEnabled', 'StatusTagsEnabled', 'PeopleTagsEnabled', 'TagsHideOnHover', 'QualityTagsPosition',
    'QualityAudioDisplayMode', 'QualityVideoCodecDisplayMode', 'QualityHdrDisplayMode', 'QualityMinimumResolution', 'QualityHideSdr',
    'SeriesQualityAggregation', 'GenreTagsPosition', 'LanguageTagsPosition', 'RatingTagsPosition',
    'RatingTagsShowCommunity',
    'RatingTagsShowCritic', 'RatingTagsSources', 'RatingTagsMinScore', 'RatingTagsColorByScore', 'AgeRatingTagsPosition', 'StatusTagsPosition',
    'StatusTagsJustAdded', 'StatusTagsNewRelease', 'StatusTagsTrending', 'StatusTagsSchedule', 'StatusTagsMilestones', 'StatusTagsSeriesStatus', 'StatusTagsScenes',
    'StatusTagsLeaving', 'StatusTagsDirectPlay',
    'AwardsTagsEnabled', 'AwardsTagsPosition', 'LogoTagsEnabled', 'LogoTagsPosition', 'CustomTagsEnabled', 'CustomTagsPosition',
    'ShowRatingInPlayer', 'TagLayout', 'TagLabelDensity', 'TagScale', 'TagGap', 'TagEdgeSpacing', 'TagLayouts', 'TagGroupOrder', 'TagGroupCaps',
    'LanguageTagsShowAudio', 'LanguageTagsShowSubtitles', 'LanguageTagsStyle', 'LanguageTagsCountBadge',
];

/** Registered sections, sorted by tab order then `order`. */
const sections: SectionDef[] = [];

const esc = (value: unknown): string => JE.escapeHtml(String(value ?? ''));
const tx = (value: unknown, params?: FmtParams): string => esc(fmt(value, params));
/** The configuration page's marker for a setting each user holds a personal copy of (its icon, its tooltip). */
const perUserMark = (): string => `<i class="material-icons je-ta-peruser" role="img" aria-label="${tx('Per-user setting')}" title="${tx('Each user has a personal copy. Existing users keep theirs until you overwrite it.')}">group</i>`;
const kit: TextKit = { esc, tx, perUserMark };

/**
 * Register (or replace) a section.
 * @param def - See types.ts.
 */
function registerSection(def: SectionDef): void {
    if (!def || !def.id || !TABS.some((t) => t.id === def.tab)) throw new Error(`JE admin tags: bad section ${def && def.id}`);
    const at = sections.findIndex((s) => s.id === def.id);
    if (at >= 0) sections.splice(at, 1);
    sections.push(def);
    const tabIndex = (s: SectionDef) => TABS.findIndex((t) => t.id === s.tab);
    sections.sort((a, b) => (tabIndex(a) - tabIndex(b)) || ((a.order || 0) - (b.order || 0)));
}

/** The PluginConfiguration fields the page writes: every declared field's key (and an ordered field's orderKey) and each section's `writes`. */
function pageFields(): Set<string> {
    const out = new Set<string>();
    for (const s of sections) {
        for (const f of s.fields || []) {
            out.add(f.key);
            if (f.orderKey) out.add(f.orderKey);
        }
        for (const key of s.writes || []) out.add(key);
    }
    return out;
}

/**
 * A new user's settings document as the server would seed it from this
 * configuration (camelCase, as JE.currentSettings holds it).
 * @param config - The plugin configuration (PascalCase).
 */
function seedUser(config: Config): Config {
    const out: Config = {};
    for (const key of SEEDED_KEYS) {
        if (config[key] !== undefined) out[key.charAt(0).toLowerCase() + key.slice(1)] = config[key];
    }
    // The server seeds a new user's sources with RatingSourceSettings.Defaults: the administrator's list,
    // else Community then Critic as switched on (never the web's legacy Critic-first order).
    if (!Array.isArray(out.ratingTagsSources)) {
        out.ratingTagsSources = ['community', 'critic'].filter((id) => (id === 'community' ? config.RatingTagsShowCommunity : config.RatingTagsShowCritic) !== false);
    }
    out.tagLayoutSettingsVersion = 1;
    out.tagStylePreset = null;
    out.useNativePosterTags = null;
    return out;
}

/** The Media Tags tab's link, optionally at one of its sections and a group. */
function pageUrl(tab?: string | null, group?: string | null): string {
    const base = `${window.location.origin}${window.location.pathname}`;
    return `${base}#/configurationpage?name=${encodeURIComponent(MAIN_PAGE_NAME)}&jeSection=${TAB_ID}${tab ? `&tab=${encodeURIComponent(tab)}` : ''}${group ? `&group=${encodeURIComponent(group)}` : ''}`;
}

/** The main configuration page link, optionally opened at a section (configPage.html reads `jeSection`) and tab. */
function mainPageUrl(section?: string | null, tab?: string | null): string {
    const base = `${window.location.origin}${window.location.pathname}`;
    return `${base}#/configurationpage?name=${encodeURIComponent(MAIN_PAGE_NAME)}${section ? `&jeSection=${encodeURIComponent(section)}` : ''}${tab ? `&tab=${encodeURIComponent(tab)}` : ''}`;
}

/** The address whose section was last opened: returning to the tab later keeps the section the administrator chose since. */
let honouredAddress: string | null = null;

/** The section the URL asks for, once per address (requestedTarget). */
function freshTarget(): Target {
    const target = requestedTarget();
    if (!target.tab || window.location.hash === honouredAddress) return { tab: null, group: null };
    honouredAddress = window.location.hash;
    return target;
}

/**
 * The tab and group the URL asks for: `&jeSection=media-tags&tab=…&group=…`
 * on the configuration page (or `&tab=…&group=…` on the old page's address).
 */
function requestedTarget(): Target {
    try {
        const params = new URLSearchParams(window.location.hash.split('?')[1] || '');
        if (params.get('name') === LEGACY_PAGE_NAME) return { tab: params.get('tab'), group: params.get('group') };
        if (params.get('jeSection') === TAB_ID) return { tab: params.get('tab'), group: params.get('group') };
    } catch { /* no target */ }
    return { tab: null, group: null };
}

/** Capture full client continuity separately from the public server/user event identity. */
let identityStillCurrent: () => boolean = () => false;
let identityRevision = 0;
let identityAccount = '|';
/** The client whose identity could not be read (one revision for it, not a new one per call). */
let identityFailedFor: { client: unknown } | null = null;
function identity(): string {
    try {
        if (!identityStillCurrent()) {
            const client = optionalApiClient();
            const server = () => client && ((typeof client.serverId === 'function' ? client.serverId() : client.serverId) || client._serverInfo?.Id);
            const serverId = server();
            const user = client?.getCurrentUserId?.();
            identityAccount = String(serverId || '') + '|' + String(user || '');
            const token = client?.accessToken?.();
            // Jellyfin's ApiClient throws on an empty URL name.
            const root = client?.getUrl('/');
            // Only an opaque revision reaches store ownership; credentials stay in this closure.
            identityStillCurrent = () => optionalApiClient() === client && server() === serverId
                && client?.getCurrentUserId?.() === user && client?.accessToken?.() === token && client?.getUrl('/') === root;
            identityFailedFor = null;
            identityRevision++;
        }
        return String(identityRevision);
    } catch {
        identityStillCurrent = () => false;
        // A client whose identity cannot be read keeps one revision until it is replaced.
        const client = optionalApiClient();
        if (!identityFailedFor || identityFailedFor.client !== client) {
            identityFailedFor = { client };
            identityRevision++;
        }
        return String(identityRevision);
    }
}

/** Whether an administrator is signed in now (a user id on the ApiClient). */
const signedIn = (): boolean => {
    try { return !!optionalApiClient()?.getCurrentUserId?.(); } catch { return false; }
};

/** The one live page and its mount state (mount.ts). */
const mount: MountState = { active: null };

const saves = createSaveStore({
    identity,
    isSecret: (key) => sections.some((s) => s.fields?.some((f) => f.key === key && f.secret)),
    tagLook: () => {
        const look = JE.core.tagLook;
        if (!look) throw new TypeError('core/tag-look.js must load before the Media Tags tab saves item looks');
        return look;
    },
    announce: (detail) => { document.dispatchEvent(new CustomEvent('je-media-tags-store', { detail })); },
    onReset: () => {
        const previous = mount.active;
        if (!previous) return;
        mount.active = null;
        previous.ctx.dispose();
        previous.root.replaceChildren();
        delete previous.root.dataset.tab;
    },
    reportSaveError: (err) => console.error('🪼 Jellyfin Enhanced: could not save the Media Tags settings', err),
    saveDelayMs: SAVE_DELAY_MS,
});

/**
 * Ask with the dashboard's dialog (the browser's when it is missing).
 * @param text
 * @param title
 */
function askConfirm(text: string, title: string): Promise<boolean> {
    return new Promise((resolve) => {
        try {
            const dialog = dashboard();
            if (dialog && typeof dialog.confirm === 'function') {
                dialog.confirm(esc(text).replace(/\n/g, '<br>'), title, (ok) => resolve(!!ok));
                return;
            }
        } catch { /* fall through */ }
        resolve(window.confirm(`${title}\n\n${text}`));
    });
}

const pageDeps: PageDeps = {
    JE: () => JE, kit, saves, sections, tabs: TABS, seededKeys: SEEDED_KEYS, sectionScopes: SECTION_SCOPES, sectionIcons: SECTION_ICONS,
    docsUrl: DOCS_URL, docsAnchors: DOCS_ANCHORS, pluginId: PLUGIN_ID, pageFields, seedUser, pageUrl, mainPageUrl, freshTarget, askConfirm,
    undoMs: UNDO_MS, tabStoreKey: TAB_STORE_KEY, previewStyleId: PREVIEW_STYLE_ID,
};

/** Build the page into its root and wire it (see page.ts). */
function createPage(root: HTMLElement, config: Config, options?: PageOptions): PageContext {
    return buildPage(pageDeps, root, config, options);
}

/** Whether the URL shows the configuration page (which holds the Media Tags tab). */
function onMediaTagsPage(): boolean {
    try {
        const name = new URLSearchParams(window.location.hash.split('?')[1] || '').get('name');
        return name === MAIN_PAGE_NAME || name === LEGACY_PAGE_NAME;
    } catch {
        return false;
    }
}

/** The last tab shown, when it is one of TABS. */
function savedTab(): string | null {
    let section: string | null = null;
    try { section = window.sessionStorage.getItem(TAB_STORE_KEY); } catch { /* storage unavailable */ }
    return TAB_IDS.some((id) => id === section) ? section : null;
}

/**
 * The configuration page was hidden while an edit was not saved. Jellyfin
 * cannot cancel a view change, so save now and, when that fails and the
 * configuration page is not shown again, ask whether to go back to retry. The
 * edits stay pending in the store either way and the next Media Tags view shows them.
 */
async function leaveWithPending(): Promise<void> {
    const mark = saves.sessionMark();
    if (!saves.hasPending()) return;
    const ok = await saves.flush();
    // Signed out meanwhile: the edits went with that session, nothing to go back to.
    if (ok || !saves.sameSession(mark) || onMediaTagsPage()) return;
    const store = saves.store;
    const names = Array.from(new Set((store.failed.length ? store.failed : Array.from(store.values.keys())).map((k) => fieldName(sections, k)))).join(', ');
    const back = await askConfirm(fmt('These Media Tags changes could not be saved: {fields}. Go back to the Media Tags page to retry? They stay waiting there either way.', { fields: names }), fmt('Media Tags changes not saved'));
    // The answer belongs to the session that was asked: after a sign-out or another sign-in it navigates no one.
    if (!back || !saves.sameSession(mark) || onMediaTagsPage()) return;
    // Back to the Media Tags tab, at the section shown last.
    window.location.href = pageUrl(savedTab() ?? undefined);
}

const lifecycle = createLifecycle({
    mount, saves, signedIn, createPage, pluginId: PLUGIN_ID, tx, sectionFiles: SECTION_FILES,
    getConfiguration: (id) => apiClient().getPluginConfiguration(id),
    scriptUrl: (file, query) => apiClient().getUrl(`/JellyfinEnhanced/js/enhanced/admintags/${file}`) + query,
    leaveWithPending,
    freshTarget,
});

// Signing out, another administrator or another server: the edits and the view go with the old session,
// unless the page noticed first (checkSession) and already belongs to the new one. JE.session reports a
// sign-in or sign-out before the ApiClient has the new credentials, so the change names who comes next.
JE.session?.onUserChange?.('admin-tags', (change) => {
    const current = identity();
    if (!change || saves.store.owner !== current || identityAccount !== `${change.serverId || ''}|${change.userId || ''}`) saves.resetSession();
});

const core: AdminTagsCore = {
    fmt, WORDS,
    TABS,
    SECTION_FILES,
    SEEDED_KEYS,
    MAIN_PAGE_NAME,
    TAB_ID,
    LEGACY_PAGE_NAME,
    PLUGIN_ID,
    sections,
    registerSection,
    pageFields,
    seedUser,
    pageUrl,
    mainPageUrl,
    fieldHtml: (f, config) => fieldHtml(kit, f, config),
    fieldsHtml: (fields, config) => fieldsHtml(kit, fields, config),
    redrawList,
    fieldValue,
    controlValue,
    createPage,
    mountTab: lifecycle.mountTab,
    activate: lifecycle.activate,
    holdSaves: saves.holdSaves,
    /** The tab's context once it is built. */
    current: () => mount.active?.ctx || null,
    requestedTarget,
    /** The unsaved edits (tests, diagnostics). */
    pendingState: () => ({ state: saves.store.state, fields: Array.from(saves.store.values.keys()), failed: saves.store.failed.slice() }),
    leaveWithPending,
};
JE.adminTags = core;
