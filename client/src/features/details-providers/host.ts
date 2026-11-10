import { featureContext, type FeatureContext, type SaveOptions } from '../../host/context';
import type { BootstrapArrInstance, BootstrapPrivateConfig, BootstrapPublicConfig, ElsewhereSettings } from '../../contracts/generated';

/**
 * Host boundary for the details-page provider features. Each entry names the
 * finite slice of the legacy `window.JellyfinEnhanced` facade it consumes; no
 * aggregate bag is shared between entries. Every Jellyfin API call reads the
 * active `window.ApiClient` at call time, because Jellyfin replaces it on a
 * server change and tests replace its methods after a module has loaded.
 */

export type Translate = (key: string, params?: Record<string, string | number>) => string;
export interface DetailsSession {
    getEpoch(): number;
    isCurrent(epoch: number): boolean;
    onUserChange(name: string, callback: () => void): unknown;
}
export interface ItemLookupOptions { userId?: string | null }
export interface ItemCacheHelper { getItemCached?(itemId: string, options?: ItemLookupOptions): Promise<unknown> }
export type ViewHook = (view: string | null | undefined, element: Element | null | undefined,
    hash: string | undefined, item: Promise<unknown> | null, rawEvent: Event | null) => unknown;
export interface ViewHookOptions { pages?: readonly string[] | null; fetchItem?: boolean; immediate?: boolean }
export interface ObserverHandleLike { disconnect(): void }
export type Unregister = () => void;
export interface ExternalLinkOptions {
    text?: string; title?: string; className?: string; resetStyle?: boolean;
    setup?: (anchor: HTMLAnchorElement) => void;
}
export type ExternalLinkFactory = (url: string, options?: ExternalLinkOptions) => HTMLAnchorElement;
export interface BodyObserverHelper {
    createObserver(name: string, callback: (records: MutationRecord[]) => void, target: Node, config: MutationObserverInit): ObserverHandleLike | undefined | void;
}
export interface ViewPageHelper { onViewPage(callback: ViewHook, options?: ViewHookOptions): Unregister | undefined | void }
export interface Debounced { (): void }
export interface DebounceHelper { debounce(callback: () => void, wait: number, options?: { maxWait?: number }): Debounced }
export interface CdnUrls { url(source: string, path: string): string }
export interface SelfhstCdn { selfhst(path: string): string }
export interface RequestOptions {
    method?: string; body?: unknown; signal?: AbortSignal; cacheKey?: string; skipRetry?: boolean;
}
export interface PluginApi { plugin(path: string, options?: RequestOptions): Promise<unknown> }
export interface FetchApi { fetch(url: string, options?: RequestOptions): Promise<unknown> }
export interface CacheManager { clearCacheMatching(pattern: string): void }
export interface ConcurrencyManager { withConcurrencyLimit?<T>(fn: () => Promise<T>, options: { signal: AbortSignal }): Promise<T> }
export interface DetailsNavigation {
    onViewPage(callback: ViewHook): unknown;
    onNavigate(callback: () => void): unknown;
}

export interface AjaxRequest {
    type: 'GET' | 'POST'; url: string; dataType?: 'json'; data?: string; contentType?: string;
}
export type UrlQuery = Record<string, string | number | boolean>;
/** The Jellyfin `ApiClient` operations these features call. */
export interface DetailsApiClient {
    getCurrentUserId(): string | null;
    getUrl(path: string, query?: UrlQuery): string;
    getItem(userId: string | null, itemId: string): Promise<unknown>;
    ajax(request: AjaxRequest): Promise<unknown>;
    serverId(): string | null | undefined;
    accessToken(): string;
    serverAddress?(): string;
    getCurrentUser?(): Promise<unknown>;
}
interface DashboardHost {
    navigate?(url: string): unknown;
    confirm?(text: string, title: string, callback: (confirmed: boolean) => void): unknown;
    alert?(options: { title: string; message: string }): unknown;
}
interface EmbyHost { Page?: { show?(path: string): unknown } }
export interface BrowserTranslator { translate(text: string): Promise<string>; destroy?(): void }
export interface BrowserTranslatorFactory {
    availability(options: { sourceLanguage: string; targetLanguage: string }): Promise<string>;
    create(options: { sourceLanguage: string; targetLanguage: string }): Promise<BrowserTranslator>;
}
interface HostWindow extends Window {
    JellyfinEnhanced?: object;
    ApiClient?: DetailsApiClient;
    Dashboard?: DashboardHost;
    Emby?: EmbyHost;
    Translator?: BrowserTranslatorFactory;
}
function hostWindow(): HostWindow { return window; }

/** The legacy facade, narrowed by the caller to the slice its entry consumes. */
export function bridge<T extends object>(feature: string): T {
    const host: Window & { JellyfinEnhanced?: T } = window;
    const JE = host.JellyfinEnhanced;
    if (!JE) throw new Error(`${feature} loaded before Jellyfin Enhanced`);
    return JE;
}
export function optionalBridge<T extends object>(): T | undefined {
    const host: Window & { JellyfinEnhanced?: T } = window;
    return host.JellyfinEnhanced;
}
/** The active Jellyfin client, read for every call. */
export function api(): DetailsApiClient {
    const client = hostWindow().ApiClient;
    if (!client) throw new Error('Jellyfin ApiClient unavailable');
    return client;
}
export function hasApi(): boolean { return hostWindow().ApiClient !== undefined; }
export function currentUserId(): string | null {
    const id = hostWindow().ApiClient?.getCurrentUserId();
    return typeof id === 'string' && id ? id : null;
}
export function serverId(): string {
    const id = api().serverId();
    return typeof id === 'string' ? id : '';
}
export function dashboard(): DashboardHost | undefined { return hostWindow().Dashboard; }
export function embyPage(): EmbyHost['Page'] { return hostWindow().Emby?.Page; }
export function browserTranslator(): BrowserTranslatorFactory | undefined { return hostWindow().Translator; }

// ── Per-entry facade slices ───────────────────────────────────────────────

type Pub<K extends keyof BootstrapPublicConfig> = Partial<Pick<BootstrapPublicConfig, K>>;
type Priv<K extends keyof BootstrapPrivateConfig> = Partial<Pick<BootstrapPrivateConfig, K>>;

export interface RandomSettings {
    randomButtonEnabled?: boolean; randomIncludeMovies?: boolean; randomIncludeShows?: boolean;
    randomScopeCurrentContainer?: boolean; randomSourceId?: string | null; randomUnwatchedOnly?: boolean;
}
export interface RandomBridge {
    currentSettings: RandomSettings;
    helpers: ItemCacheHelper & { getHeaderButtonTray(): Element | null };
    session?: DetailsSession;
    t: Translate; toast(html: string, duration?: number): void;
    icon(name: string): string; IconName: { ERROR: string };
    escapeHtml(value: string): string;
    addRandomButton?: () => void;
}

export interface MediaLanguage {
    resolveFlag(lang: { code: string; name: string }): string | null | undefined;
    flagSrc(code: string): string;
    isLanguageless(code: string): boolean;
    displayName(code: string): string;
}
export interface DisplaySettings {
    showWatchProgress?: boolean; showFileSizes?: boolean; showAudioLanguages?: boolean;
    peopleTagsEnabled?: boolean; watchProgressMode?: string; watchProgressTimeFormat?: string;
    reviewsExpandedByDefault?: boolean;
}
/** Visit handles are opaque to the chip modules: they only compare identity. */
export type VisitHandle = object;
export interface ChipSelection { watchProgress: boolean; fileSize: boolean }
export interface DetailsFeatures {
    displayWatchProgress?(itemId: string, container: HTMLElement, mediaSourceId?: string | null): Promise<void>;
    displayItemSize?(itemId: string, container: HTMLElement, mediaSourceId?: string | null): Promise<void>;
    displayAudioLanguages?(itemId: string, container: HTMLElement, mediaSourceId?: string | null): Promise<void>;
    prefetchItemStats?(itemId: string, mediaSourceId: string | null, chips: ChipSelection, visit: VisitHandle): void;
    discardItemStatsPrefetch?(visit: VisitHandle): void;
    displayReleaseDate?(itemId: string, container: HTMLElement): Promise<void>;
    prefetchReleaseDate?(itemId: string, item: unknown, visit: VisitHandle): void;
    discardReleasePrefetch?(visit: VisitHandle): void;
}
export interface PeopleTagsInternals {
    prefetch?(itemId: string, item: unknown, view: Element, epoch: number): void;
    leave?(itemId: string): void;
}
export interface DetailsInternals { features?: DetailsFeatures }
export interface MediaInfoBridge {
    session?: DetailsSession;
    currentSettings?: DisplaySettings;
    saveUserSettings?(file: 'settings.json', settings: DisplaySettings): unknown;
    t: Translate;
    core?: { api?: Partial<PluginApi>; mediaLanguage?: MediaLanguage };
    pluginConfig?: Pub<'AudioLanguageTagSyncEnabled' | 'AudioLanguageTagShowAsLinks'>;
    helpers?: ItemCacheHelper;
}
export interface SpoilerStateProbe { hasAnyState?(): boolean }
export interface ReleaseBridge {
    session?: DetailsSession;
    pluginConfig?: Pub<'DEFAULT_REGION'>;
    helpers?: ItemCacheHelper & { addCSS?(id: string, css: string): void };
    core?: { api?: { manager?: ConcurrencyManager } };
    t: Translate;
}

export interface HiddenItemData {
    itemId: string; name: string; type: string; tmdbId: string; posterPath?: string;
    seriesId?: string; seriesName?: string; seasonNumber?: number | null; episodeNumber?: number | null;
}
export interface HiddenContentSettings { enabled?: boolean; showHideButtons?: boolean; showButtonCast?: boolean; showButtonDetails?: boolean }
export interface HiddenContentFacade {
    getSettings(): HiddenContentSettings;
    isHidden(itemId: string): boolean;
    unhideItem(itemId: string): void;
    hideItem(item: HiddenItemData): void;
    confirmAndHide(item: HiddenItemData, onHidden?: () => void, options?: { showEpisodeChoice?: boolean; onChooseShow?(): void | Promise<void> }): void;
}
export interface DetailsPageBridge {
    /** Its own `features` slot goes through the context. */
    internals?: DetailsInternals;
    helpers: ItemCacheHelper & DebounceHelper & BodyObserverHelper & ViewPageHelper;
    core: { navigation: DetailsNavigation };
    session?: DetailsSession;
    currentSettings?: DisplaySettings;
    pluginConfig?: Pub<'ShowReleaseDates' | 'TmdbEnabled'>;
    t: Translate;
}

export interface ElsewhereBridge {
    pluginConfig: Pub<'ElsewhereEnabled' | 'TmdbEnabled' | 'DEFAULT_REGION' | 'DEFAULT_PROVIDERS' | 'IGNORE_PROVIDERS'
        | 'ElsewhereCustomBrandingText' | 'ElsewhereCustomBrandingImageUrl' | 'ElsewhereSeasonProviders'>;
    helpers: ItemCacheHelper & BodyObserverHelper & ViewPageHelper & Partial<DebounceHelper> & { createExternalLink?: ExternalLinkFactory };
    cdn: CdnUrls;
    t: Translate;
    session?: DetailsSession;
    userConfig: { elsewhere?: Partial<ElsewhereSettings> | null };
    saveUserSettings(file: 'elsewhere.json', settings: ElsewhereSettings, options?: SaveOptions): unknown;
    core: { api: FetchApi };
    initializeElsewhereScript?: () => void;
}

export interface SpoilerGuardProbe {
    whenLoaded?(): Promise<unknown>;
    isLoadOk?(): boolean;
    getUserPrefs?(): { HideReviews?: boolean | null } | null | undefined;
    isMovieInScope?(itemId: string): Promise<boolean>;
    isEnabledFor?(seriesId: string): boolean;
}
export interface ReviewsBridge {
    pluginConfig: Pub<'ShowReviews' | 'TmdbEnabled' | 'ShowUserReviews' | 'ShowAnilistReviews' | 'SpoilerBlurEnabled'
        | 'SpoilerStripReviews' | 'ReviewTranslationEnabled' | 'ReviewTranslationServer'>;
    core: { api: PluginApi & FetchApi };
    helpers: ItemCacheHelper & ViewPageHelper & { createExternalLink: ExternalLinkFactory };
    session?: DetailsSession;
    escapeHtml(value: string): string;
    t: Translate; toast(html: string, duration?: number): void;
    icon(name: string): string; IconName: { STAR: string };
    cdn: CdnUrls;
    currentSettings?: DisplaySettings;
    loadSettings?(): DisplaySettings;
    saveUserSettings?(file: 'settings.json', settings: DisplaySettings): unknown;
    initializeReviewsScript?: () => void;
}

/** details-providers' own `JE.internals` slot (frontend.md §2.3; hidden-content co-owns `features`, internals-owners.json). */
export type DetailsOwn = Pick<DetailsInternals, 'features'>;
/** Other features' facades details-providers reads, read at call time (their owners may load later). */
export interface DetailsPeers {
    hiddenContent: HiddenContentFacade;
    spoilerBlur: SpoilerStateProbe & SpoilerGuardProbe & { addSpoilerBlurButton?(itemId: string, page: Element, itemType: string): void };
    invalidateUserReviewTagCache(tmdbKey: string): void;
    /** media-tags' people tags, for the details page's visits (step C4). */
    peopleTags: PeopleTagsInternals;
}
export type DetailsContext<Core extends object> = FeatureContext<DetailsOwn, DetailsPeers, Core>;
/** The feature context around an entry's bridge slice. Its own facades stay on that bridge. */
export function detailsContext<Core extends object>(JE: Core): DetailsContext<Core> {
    const holder = JE as { internals?: DetailsInternals };
    return featureContext<DetailsOwn, DetailsPeers, Core>('details-providers', JE, {
        internalSlots: ['features'],
        internalsObject: () => holder.internals ??= {},
    });
}

export interface AwardsBridge {
    pluginConfig?: Pub<'ShowAwards'>;
    escapeHtml?(value: string): string;
    core: { api: PluginApi & { manager: CacheManager } };
    cdn: CdnUrls;
    t: Translate;
    session?: DetailsSession;
    helpers: ItemCacheHelper & ViewPageHelper;
    initializeAwardsScript?: () => void;
}
export interface MdblistBridge {
    pluginConfig?: Pub<'MdblistRatingsEnabled' | 'MdblistRatingsShowOnItemDetails' | 'MdblistRatingsSources' | 'MdblistRatingsShowPercentSymbol'>;
    escapeHtml?(value: string): string;
    core: { api: PluginApi & { manager: CacheManager } };
    cdn: CdnUrls;
    t: Translate;
    session?: DetailsSession;
    helpers: ItemCacheHelper & ViewPageHelper & { createExternalLink?: ExternalLinkFactory };
    initializeMdblistRatingsScript?: () => void;
}
export interface DddBridge {
    pluginConfig?: Pub<'DoesTheDogDieEnabled'>;
    core: { api: PluginApi & { manager: CacheManager }; ui: { skeletonGridHtml(count: number, options: { minWidth: string; height: string; label: string }): string } };
    t: Translate;
    session?: DetailsSession;
    helpers: ItemCacheHelper & ViewPageHelper & { createExternalLink?: ExternalLinkFactory };
    saveUserSettings(file: 'ddd-triggers.json', settings: { Triggers: number[] }, options?: SaveOptions): unknown;
    initializeDoesTheDogDieScript?: () => void;
}

export type ArrInstanceConfig = Partial<BootstrapArrInstance> | null;
export interface ArrLinksBridge {
    pluginConfig: Pub<'ArrLinksEnabled' | 'ArrLinksShowStatusSingle' | 'ShowArrLinksAsText'>
        & Priv<'SonarrInstancesCorrupt' | 'RadarrInstancesCorrupt' | 'SonarrUrl' | 'SonarrUrlMappings'
            | 'RadarrUrl' | 'RadarrUrlMappings' | 'BazarrUrl' | 'BazarrUrlMappings'>
        & { SonarrInstances?: ArrInstanceConfig[]; RadarrInstances?: ArrInstanceConfig[] };
    session?: DetailsSession;
    helpers: ItemCacheHelper & BodyObserverHelper & {
        isAdmin(): boolean | null | undefined; createExternalLink?: ExternalLinkFactory;
        escHtml?(value: unknown): string; getExternalLinkIconSize(): number;
    };
    toast?(html: string, duration?: number): void;
    cdn: SelfhstCdn;
    core: { api: PluginApi };
    themer?: { getThemeVariables?(): { secondaryBg?: string; textColor?: string } };
    _arrDropdownCloserInstalled?: boolean;
    _arrLinksObserver?: ObserverHandleLike | null;
    initializeArrLinksScript?: () => Promise<void>;
}
export interface LifecycleRegistration { track<T>(resource: T): T }
export interface ArrTagLinksBridge {
    pluginConfig?: Pub<'ArrTagsShowAsLinks' | 'ArrTagsPrefix' | 'ArrTagsLinksFilter' | 'ArrTagsLinksHideFilter'>;
    session?: DetailsSession;
    helpers: ItemCacheHelper & BodyObserverHelper & DebounceHelper;
    core: { lifecycle: { register(name: string): LifecycleRegistration }; navigation: DetailsNavigation };
    icon(name: string): string; IconName: { TAG: string };
    initializeArrTagLinksScript?: () => Promise<void>;
}
export interface ColoredRatingsBridge {
    cdn: CdnUrls;
    pluginConfig?: Pub<'ColoredRatingsEnabled'>;
    helpers?: Partial<BodyObserverHelper & ViewPageHelper> & { onNavigate?(callback: () => void): Unregister | undefined | void };
    initializeColoredRatings?: () => void;
    normalizeOfficialRating?: (rating: string) => string;
    pauseRatingsPolling?: () => void;
    resumeRatingsPolling?: () => void;
}
export interface LetterboxdBridge {
    pluginConfig?: Pub<'LetterboxdEnabled' | 'ShowLetterboxdLinkAsText'>;
    cdn: SelfhstCdn;
    session?: DetailsSession;
    helpers: ItemCacheHelper & BodyObserverHelper & ViewPageHelper & {
        createExternalLink?: ExternalLinkFactory; getExternalLinkIconSize(): number;
    };
    initializeLetterboxdLinksScript?: () => Promise<void>;
}
