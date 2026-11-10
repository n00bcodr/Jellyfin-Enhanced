import type { BookmarkDocumentResponse, BootstrapResponse, RevisionedSettingsResponse } from '../contracts/generated';

export type JsonRecord = Record<string, unknown>;
export type TranslationParams = Record<string, unknown>;
export type Translations = Record<string, string>;
export type Translate = (key: string, params?: TranslationParams | null) => string;

/** The Jellyfin 12 ApiClient members the loader and page scripts consume. */
export interface LoaderClient {
    ajax(request: { type: 'GET'; url: string; dataType: 'json' | 'text' }): Promise<unknown>;
    getUrl(path: string): string;
    getCurrentUserId?(): unknown;
    getCurrentUser?(): Promise<unknown>;
    accessToken?(): unknown;
    serverId?: unknown;
    _serverInfo?: { Id?: unknown };
}

/** Exactly what js/contracts/bootstrap.js publishes; verified before use. */
export interface BootstrapValidator {
    parseBootstrap(value: unknown, expectedUserId: string, isAdmin: boolean): BootstrapResponse;
    parseSettingsDocument(value: unknown, isAdmin: boolean): RevisionedSettingsResponse;
    parseBookmarkDocument(value: unknown): BookmarkDocumentResponse;
}

export interface LoaderSession {
    getEpoch(): number;
    isCurrent(epoch: number): boolean;
    onUserChange(name: string, callback: () => void): unknown;
}

/** Settings the loader reads; every other field belongs to the settings feature. */
export interface LoaderSettings {
    displayLanguage?: string;
    qualityTagsEnabled?: boolean; genreTagsEnabled?: boolean; ratingTagsEnabled?: boolean;
    ageRatingTagsEnabled?: boolean; statusTagsEnabled?: boolean; awardsTagsEnabled?: boolean;
    customTagsEnabled?: boolean; languageTagsEnabled?: boolean; logoTagsEnabled?: boolean; peopleTagsEnabled?: boolean;
}

export interface UserConfigView {
    settings: JsonRecord; shortcuts: unknown; elsewhere: unknown; hiddenContent: unknown;
    bookmark?: unknown; bookmarks?: unknown; settingsRevision?: string | null;
    bookmarkRevision?: string | null; bookmarkBinding?: BookmarkBinding;
}
/** Binds a loaded bookmark document to the host session that read it. */
export interface BookmarkBinding { client: LoaderClient; userId: unknown; token: unknown; baseUrl: string }

export interface CacheManager {
    callbacks: Set<() => void>; dirty: boolean; scheduleId: number | null;
    register(saveCallback: () => void): void;
    unregister(saveCallback: () => void): void;
    markDirty(): void;
    _flush(): void;
    forceSave(): void;
}

export interface LocalCdn {
    url(source: string, path?: string | null): string;
    selfhst(file: string): string;
    flagPng(code: string, size?: string): string;
    flagSvg(code: string): string;
    font(name: string): string;
}

type Hook = () => void;
type FeatureInitializer = 'initializePluginRevisions' | 'initializeEnhancedScript' | 'initializeElsewhereScript'
    | 'initializeJellyseerrScript' | 'initializePauseScreen' | 'initializeBookmarks' | 'initializeQualityTags'
    | 'initializeGenreTags' | 'initializeRatingTags' | 'initializeAgeRatingTags' | 'initializeStatusTags'
    | 'initializeAwardsTags' | 'initializeCustomTags' | 'initializeTagStyles' | 'initializeUserReviewTags'
    | 'initializeArrLinksScript' | 'initializeArrTagLinksScript' | 'initializeSeerrDetailLinkScript'
    | 'initializeLetterboxdLinksScript' | 'initializeReviewsScript' | 'initializeAwardsScript'
    | 'initializeDoesTheDogDieScript' | 'initializeMdblistRatingsScript' | 'initializeLanguageTags'
    | 'initializeLogoTags' | 'initializePeopleTags' | 'initializeOsdRating' | 'initializePlaybackRatingBadge'
    | 'initializeHiddenContent' | 'initializeColoredRatings' | 'initializeThemeSelector' | 'initializeActivityIcons'
    | 'initializePluginIcons' | 'initializeDownloadsPage' | 'initializeCalendarPage' | 'initializeHiddenContentPage'
    | 'initializeSplashScreen' | 'hideSplashScreen';

/**
 * The live namespace plugin.js creates. Later scripts extend it; the loader
 * only names the slots it reads or calls.
 */
export interface LoaderNamespace extends Partial<Record<FeatureInitializer, Hook>> {
    core: object;
    pluginConfig: JsonRecord;
    userConfig: UserConfigView;
    translations: Translations;
    translationsLang?: string;
    translationsFromEnglish?: ReadonlySet<string> | null;
    pluginVersion: string;
    cdn: LocalCdn;
    icon(name?: string): string;
    IconName: Record<string, string>;
    state: { activeShortcuts: object; removeContext: unknown; pauseScreenClickTimer: unknown };
    _cacheManager: CacheManager;
    escapeHtml(value: unknown): string;
    t: Translate;
    loadSettings(): LoaderSettings;
    initializeShortcuts(): void;
    saveUserSettings(fileName: string): Promise<void>;
    toCamelCase: (value: unknown) => unknown;
    toPascalCase: (value: unknown) => unknown;
    takePrefetched(name: string, maxAgeMs?: number): unknown;
    hasCustomTabs?: boolean;
    currentSettings?: LoaderSettings;
    session?: LoaderSession;
    initialized?: boolean;
    loadTranslations?(): Promise<Translations>;
    themer?: { init?(): void };
    tagPipeline?: { initialize?(): void };
    spoilerBlur?: { init?(): void };
    activeStreams?: { initialize?(): void };
    jellyseerrIssueReporter?: { initialize?(): void };
}

/** Bundle globals are written by Features/Platform/Services/ClientScriptBundle.cs. */
interface LoaderWindow extends Window {
    JellyfinEnhanced?: LoaderNamespace;
    ApiClient?: LoaderClient;
    __JE_BOOTSTRAP_CONTRACT__?: Partial<BootstrapValidator>;
    __JE_BUNDLE_MODULES?: unknown;
    __JE_BUNDLE_TOTAL?: unknown;
    __JE_BUNDLE_PROGRESS?: number;
}
const loaderWindow = (): LoaderWindow => window;

/** Publish the namespace; everything else receives it as an explicit dependency. */
export function installNamespace(namespace: LoaderNamespace): LoaderNamespace {
    loaderWindow().JellyfinEnhanced = namespace;
    return namespace;
}
/** The live global, because the translator must follow a replaced namespace. */
export const liveNamespace = (): LoaderNamespace | undefined => loaderWindow().JellyfinEnhanced;
export const optionalClient = (): LoaderClient | undefined => loaderWindow().ApiClient;
export function client(): LoaderClient {
    const api = optionalClient();
    if (!api) throw new Error('Jellyfin ApiClient is not available');
    return api;
}

/** The validator global is untrusted until all three parsers are present. */
export function readBootstrapValidator(): BootstrapValidator | null {
    const contract = loaderWindow().__JE_BOOTSTRAP_CONTRACT__;
    const { parseBootstrap, parseSettingsDocument, parseBookmarkDocument } = contract ?? {};
    if (typeof parseBootstrap !== 'function' || typeof parseSettingsDocument !== 'function'
        || typeof parseBookmarkDocument !== 'function') return null;
    return { parseBootstrap, parseSettingsDocument, parseBookmarkDocument };
}

export function resetBundleGlobals(): void {
    const host = loaderWindow();
    host.__JE_BUNDLE_PROGRESS = -1;
    host.__JE_BUNDLE_MODULES = undefined;
}
/** Take the bundle's module list exactly once; the functions are single-use. */
export function takeBundle(): { modules: unknown; total: unknown } {
    const host = loaderWindow();
    const bundle = { modules: host.__JE_BUNDLE_MODULES, total: host.__JE_BUNDLE_TOTAL };
    delete host.__JE_BUNDLE_MODULES;
    return bundle;
}
export function reportBundleProgress(count: number): void {
    loaderWindow().__JE_BUNDLE_PROGRESS = count;
}

// ---- Standalone Plugin Pages ------------------------------------------------

export type ActivityFacade = {
    injectStyles(): void; renderForCustomTab(host: HTMLElement): Promise<void> | void; stopPolling?(): void;
};
// Step C4: the three page facades below are declared here, structurally (host/ may not import features/), with the
// signatures of their owners' types: features/calendar/types.ts CalendarFacade, features/downloads/types.ts
// PublicPage and State, features/seerr/recommendations/types.ts RecommendationsFacade. Types only.
export type CalendarPageFacade = {
    injectStyles(): void; loadSettings(): void; renderPage(target?: HTMLElement): void; refresh(): Promise<void>;
    handleEventClick(event: Event): void;
};
export type CatchUpFacade = { injectStyles(): void; renderPage(container?: HTMLElement): void };
/** The members of the downloads page state (`State`) the page script reads and writes. */
export interface DownloadsPageState { pageVisible: boolean; _customTabMode?: boolean; _pluginPageVisible?: boolean }
export type DownloadsPageFacade = { injectStyles(): void; renderPage(target?: HTMLElement): void; refresh(): Promise<void> }
    & { startPolling?(): void; stopPolling?(): void; _state?: DownloadsPageState }
    & { _pluginPageVisible?: boolean };
export type HiddenContentPageFacade = { injectStyles?(): void; renderPage?(target?: HTMLElement): void };
export type RecommendationsPageFacade = { renderForCustomTab(element: HTMLElement | null): void };

/** What the seven page scripts may read; each facade stays owned by its feature. */
export interface PagesBridge {
    userConfig?: object;
    pluginConfig?: { DownloadsPagePollingEnabled?: boolean; DownloadsPollIntervalSeconds?: number };
    activityPage?: ActivityFacade;
    bookmarks?: object;
    calendarPage?: CalendarPageFacade;
    catchUpPage?: CatchUpFacade;
    downloadsPage?: DownloadsPageFacade;
    hiddenContent?: object;
    hiddenContentPage?: HiddenContentPageFacade;
    recommendationsPage?: RecommendationsPageFacade;
}
export interface PagesClient { getCurrentUserId?(): unknown; getUrl?(path: string): string; accessToken?(): unknown; serverId?: unknown }
interface PagesWindow extends Window {
    JellyfinEnhanced?: PagesBridge;
    ApiClient?: PagesClient;
    Emby?: { Page?: { showItem?(id: string): void } };
}
const pagesWindow = (): PagesWindow => window;
/** Read at every use: the namespace may appear after the page script starts. */
export const pagesBridge = (): PagesBridge | undefined => pagesWindow().JellyfinEnhanced;
export const pagesClient = (): PagesClient | undefined => pagesWindow().ApiClient;
export function showItem(id: string): void {
    pagesWindow().Emby?.Page?.showItem?.(id);
}
