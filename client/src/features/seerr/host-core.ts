import type { SeerrApiFacade, SeerrModalFacade, SeerrStatusFacade, SeerrUiFacade, SeerrUiInternals } from './core/contract';
import { featureContext, type FeatureContext } from '../../host/context';

/**
 * The narrow legacy-global boundary of the Seerr core group. Each member is
 * a host or sibling-feature API this group reads, or one of the facades it
 * owns (seerrStatus, requestManager alias, jellyseerrAPI, jellyseerrUI,
 * jellyseerrModal, internals.jellyseerrUi, initializeJellyseerrScript).
 * Sibling members are optional: the group loads before several of them and
 * must keep working when one is absent.
 */
export type Translate = (key: string, params?: Readonly<Record<string, string | number>>) => string;

export interface SeerrPluginConfig {
    JellyseerrEnabled?: boolean;
    JellyseerrShowSearchResults?: boolean;
    JellyseerrShowAdvanced?: boolean;
    JellyseerrShowQuotaInfo?: boolean;
    JellyseerrEnable4KRequests?: boolean;
    JellyseerrEnable4KTvRequests?: boolean;
    JellyseerrSingleSeasonRequestOnly?: boolean;
    JellyseerrUseMoreInfoModal?: boolean;
    JellyseerrAvailablePosterLinksToJellyfin?: boolean;
    JellyseerrSearchExcludeLibraryItems?: boolean;
    JellyseerrShowGenreDiscovery?: boolean;
    JellyseerrUrlMappings?: unknown;
    JellyseerrBaseUrl?: unknown;
    AddRequestedMediaToWatchlist?: boolean;
    ShowCollectionsInSearch?: boolean;
    ShowElsewhereOnJellyseerr?: boolean;
    TmdbEnabled?: boolean;
    DEFAULT_REGION?: unknown;
    DEFAULT_PROVIDERS?: unknown;
    IGNORE_PROVIDERS?: unknown;
}

export interface SeerrSession {
    getEpoch(): number;
    isCurrent(epoch: number): boolean;
    onUserChange(name: string, callback: () => void): unknown;
}

export interface SeerrFetchOptions {
    signal?: AbortSignal;
    cacheKey?: string;
    skipCache?: boolean;
    skipRetry?: boolean;
    headers?: Record<string, string>;
    method?: string;
    body?: unknown;
    priority?: 'low' | 'normal';
}
export interface SeerrRequestManager {
    clearCacheMatching?(pattern: string): void;
    getCached?(key: string): unknown;
    setCache?(key: string, value: unknown): void;
    getAbortSignal?(key: string): AbortSignal;
    abortRequest?(key: string): void;
}
export interface SeerrCoreApi {
    fetch(url: string, options?: SeerrFetchOptions): Promise<unknown>;
    plugin(path: string, options?: SeerrFetchOptions): Promise<unknown>;
    manager?: SeerrRequestManager;
}
export interface SeerrCoreUi {
    isTvLayout?(): boolean;
    addTouchTapListener?(element: HTMLElement, onTap: (event: TouchEvent) => void): unknown;
    addDelegatedTouchTapListener?(root: HTMLElement, resolve: (target: Element) => HTMLElement | null,
        onTap: (event: TouchEvent, element: HTMLElement) => void): unknown;
}
export interface SeerrHiddenContent {
    filterJellyseerrResults?<T>(items: T[], surface: string): T[];
    getSettings?(): { enabled?: boolean; showHideButtons?: boolean; showButtonJellyseerr?: boolean } | null | undefined;
    isHiddenByTmdbId?(id: number): boolean;
    unhideItem?(key: string): unknown;
    confirmAndHide?(item: { itemId: string; name: string; type: string; tmdbId: number; posterPath: string }, onHidden: () => void): unknown;
}
export interface ScrollHint {
    deficitPx?: number;
    spanPx?: number;
    horizontal?: boolean;
    pageBudget?: number;
    engaged?: boolean;
}
export interface ScrollState { fill?: (() => void) | null }
export interface Deduplicator {
    add(item: { mediaType: string; id: number }): boolean;
    filter<T extends { mediaType: string; id: number }>(items: T[]): T[];
    clear(): void;
}
export interface SeerrSeamlessScroll {
    setupInfiniteScroll(state: ScrollState, selector: string, load: (hint?: ScrollHint) => Promise<unknown>,
        hasMore: () => boolean, isLoading: () => boolean, options?: { horizontal?: boolean; trackSelector?: string; scrollerSelector?: string }): void;
    cleanupInfiniteScroll(state: ScrollState): void;
    createDeduplicator?(): Deduplicator;
    cardsNeeded?(container: Element | null, hint: ScrollHint | undefined, fallback?: number): number;
}
export interface SeerrDiscoveryFilter {
    appendInSlices?<T>(container: HTMLElement, items: readonly T[], createCard: (item: T) => HTMLElement | null,
        options?: { syncCount?: number; isCurrent?: () => boolean }): Promise<number>;
    cardsInView?(container: HTMLElement, options?: { horizontal?: boolean }): number;
    fetchTmdbGenreList?(mediaType: string, options: object): Promise<unknown> | undefined;
}
export interface SeerrHelpers {
    trackUsage?(key: string): void;
    onBodyMutation?(name: string, callback: () => void): unknown;
    onNavigate?(callback: () => void): unknown;
}
export interface SeerrMoreInfo { open(tmdbId: number, mediaType: string): unknown }
export interface SeerrSearchController { fetchAndRenderResults(query: string, options?: { skipCache?: boolean }): unknown }

export interface SeerrCoreBridge {
    pluginConfig?: SeerrPluginConfig;
    t: Translate;
    /** Installed by the core UI kit; the group falls back to its own escaper when absent. */
    escapeHtml?: (value: unknown) => string;
    toast?(message: string, duration?: number): void;
    session?: SeerrSession;
    core?: { api?: SeerrCoreApi; ui?: SeerrCoreUi };
    cdn?: { url?(host: string, path: string): string; selfhst?(path: string): string };
    helpers?: SeerrHelpers;
    seamlessScroll?: SeerrSeamlessScroll;
    discoveryFilter?: SeerrDiscoveryFilter;
    jellyseerrMoreInfo?: SeerrMoreInfo;
    jellyseerr?: SeerrSearchController;
    takePrefetched?(name: string): unknown;
    internals?: { jellyseerrUi?: SeerrUiInternals };
    seerrStatus?: SeerrStatusFacade;
    requestManager?: SeerrRequestManager;
    jellyseerrAPI?: SeerrApiFacade;
    jellyseerrUI?: Partial<SeerrUiFacade>;
    jellyseerrModal?: SeerrModalFacade;
    initializeJellyseerrScript?: () => void;
}

export interface SeerrApiClient {
    getCurrentUserId?(): unknown;
    accessToken?(): unknown;
    serverAddress?(): unknown;
    serverId?: unknown;
    getUrl(path: string, query?: Record<string, string | number | boolean>): string;
    ajax?(request: { type: string; url: string; dataType: string }): Promise<unknown>;
}
export interface SeerrWindow extends Window {
    JellyfinEnhanced?: SeerrCoreBridge;
    ApiClient?: SeerrApiClient;
    Emby?: { Page?: { showItem?(id: string): unknown } };
    Dashboard?: { alert?(options: { title: string; message: string }): unknown };
    __JE_userStatusBannerShown?: string | null;
}

export interface SeerrCoreHost {
    JE: SeerrCoreBridge;
    window: SeerrWindow;
    document: Document;
    /** The live ApiClient, read at call time (the host can replace it on sign-in). */
    apiClient(): SeerrApiClient | undefined;
    /** `window.JellyfinEnhanced`, read at call time. */
    liveBridge(): SeerrCoreBridge | undefined;
}

/** The core group's own `JE.internals` slot (frontend.md §2.3). Its `JE.<name>` facades stay on the typed bridge. */
export type SeerrCoreOwn = { jellyseerrUi?: SeerrUiInternals };
/** Other features' facades the core group reads (published by their owners; optional, they may load later). */
export interface SeerrCorePeers { hiddenContent: SeerrHiddenContent }
export type SeerrCoreContext = FeatureContext<SeerrCoreOwn, SeerrCorePeers, SeerrCoreBridge>;
const coreContexts = new WeakMap<SeerrCoreBridge, SeerrCoreContext>();
/** The feature context around a core-group bridge, one per bridge object. */
export function seerrCoreContext(JE: SeerrCoreBridge): SeerrCoreContext {
    let ctx = coreContexts.get(JE);
    if (!ctx) {
        ctx = featureContext<SeerrCoreOwn, SeerrCorePeers, SeerrCoreBridge>('seerr', JE, {
            internalSlots: ['jellyseerrUi'],
            internalsObject: () => JE.internals ||= {},
        });
        coreContexts.set(JE, ctx);
    }
    return ctx;
}

/** The only access to the legacy global: no assertion, the bridge is structurally optional. */
export function seerrCoreHost(): SeerrCoreHost {
    const host: SeerrWindow = window;
    const JE = host.JellyfinEnhanced;
    if (!JE) throw new Error('Jellyfin Enhanced must be initialized before the Seerr core group');
    return { JE, window: host, document, apiClient: () => host.ApiClient, liveBridge: () => host.JellyfinEnhanced };
}
