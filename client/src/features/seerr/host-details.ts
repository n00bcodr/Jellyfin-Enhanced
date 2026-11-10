/**
 * Narrow adapters for the Seerr details slice: the more-info modal, the detail-page
 * rows and link, the issue reporter and the scroll engine.
 *
 * Every member names a facade another owner keeps stable (`JE.jellyseerrAPI`,
 * `JE.jellyseerrUI`, `JE.seerrStatus`, `JE.jellyseerrModal`, core services). Replies are
 * `unknown` here: a consumer earns a shape by narrowing. Scripts load one at a time, so
 * every lookup happens when it is used, never while an entry loads.
 */
import { featureContext, type FeatureContext } from '../../host/context';
import type { SpoilerBlurPeerApi } from '../spoiler-guard/public-api';
export type MediaType = 'movie' | 'tv';
export type TmdbId = number | string;
export type UrlParams = Record<string, string | number | boolean>;

export interface ApiClientFacade {
    getCurrentUserId(): string | null | undefined;
    accessToken(): string;
    getUrl(path: string, params?: UrlParams): string;
    ajax(request: { type: 'GET'; url: string; dataType: 'json'; headers?: Record<string, string> }): Promise<unknown>;
    getItem(userId: string, itemId: string): Promise<unknown>;
}

export interface SessionFacade {
    getEpoch?(): number;
    isCurrent?(epoch: number): boolean;
    onUserChange?(name: string, callback: () => void): unknown;
}

export interface ItemCacheOptions { userId?: string }

export interface SeerrStatusFacade {
    readonly MEDIA: {
        readonly UNKNOWN: number; readonly PENDING: number; readonly PROCESSING: number; readonly PARTIALLY_AVAILABLE: number;
        readonly AVAILABLE: number; readonly BLOCKED: number; readonly DELETED: number;
    };
    readonly DISPLAY: {
        readonly AVAILABLE: string; readonly PENDING: string; readonly PROCESSING: string;
        readonly REQUESTED: string; readonly BLOCKED: string;
    };
    isRequestable(status: number | undefined): boolean;
    hasStatus(status: number | undefined): boolean;
    effectiveMediaStatus(status: number | undefined, jellyfinId: string | null,
        presence?: Readonly<Record<number, boolean>> | null, seasonNumber?: number | null): number;
    resolveDisplayStatus(status: number | undefined, hasActiveDownloads?: boolean): string;
    getChipConfig(display: string): { labelKey: string; cssClass: string };
}

export interface FollowUpOptions { headers?: Record<string, string>; skipCache?: boolean }
export interface IssueQuery { take: number; filter: 'all' | 'open' }

export interface SeerrApiFacade {
    followUpOptions?(details: unknown): FollowUpOptions | undefined;
    fetchMovieDetails(id: TmdbId, options?: { skipCache: boolean }): Promise<unknown>;
    fetchTvShowDetails(id: TmdbId, options?: { skipCache: boolean }): Promise<unknown>;
    fetchTmdbTvDetails?(id: TmdbId, options?: FollowUpOptions): Promise<unknown>;
    fetchTvSeasonDetails?(id: TmdbId, season: number, options?: FollowUpOptions): Promise<unknown>;
    fetchUserQuota?(): Promise<unknown>;
    shouldShowAdvanced(): boolean;
    requestMedia(id: TmdbId, type: MediaType, advanced: Record<string, never>, is4k: boolean, details: unknown): Promise<unknown>;
    resolveJellyseerrBaseUrl?(): string;
    checkUserStatus(): Promise<unknown>;
    fetchSimilarMovies(id: number, options: { signal: AbortSignal }): Promise<unknown>;
    fetchSimilarTvShows(id: number, options: { signal: AbortSignal }): Promise<unknown>;
    fetchRecommendedMovies(id: number, options: { signal: AbortSignal }): Promise<unknown>;
    fetchRecommendedTvShows(id: number, options: { signal: AbortSignal }): Promise<unknown>;
    fetchIssuesForMedia(id: TmdbId, type: MediaType, query: IssueQuery): Promise<unknown>;
    fetchIssueById(id: unknown): Promise<unknown>;
    reportIssue(id: TmdbId, type: MediaType, issueType: string, message: string, season: number, episode: number): Promise<unknown>;
    search?(query: string): Promise<unknown>;
}

export interface SeerrUiFacade {
    /** The Seerr icon library (core contract `SeerrUiFacade.icons`); only what More Info draws. */
    icons?: { request?: string; error?: string };
    showSeasonSelectionModal?(id: TmdbId, type: 'tv', title: string, details: unknown, is4k?: boolean): unknown;
    showMovieRequestModal?(id: TmdbId, title: string, details: unknown, is4k: boolean): unknown;
    showCollectionRequestModal?(id: number, name: string): unknown;
    isQuotaError?(error: unknown): boolean;
    showQuotaErrorDialog?(error: unknown, mediaType: 'movie'): Promise<unknown>;
    buildQuotaChip?(quota: unknown, mediaType: MediaType): unknown;
    formatEtaText?(download: unknown): string | null;
    createJellyseerrCard?(item: unknown, active: boolean, userFound: boolean): HTMLElement | null;
    cardInputsKey?(items: readonly unknown[]): unknown;
    releasePosters?(root: ParentNode): void;
    addMainStyles?(): void;
}

/** Core lets a replaced dialog factory leave out `close`. */
export interface SeerrModalHandle { modalElement: HTMLElement; show(): void; close?(): void }
export interface SeerrModalOptions {
    title: string; subtitle: string; bodyHtml: string; backdropUrl: string | null; buttonText: string;
    onSave(modal: HTMLElement, button: HTMLButtonElement, close: () => void): void | Promise<void>;
    onClose(): void;
}

export interface PluginConfigFacade {
    DEFAULT_REGION?: string;
    ColoredRatingsEnabled?: boolean;
    TmdbEnabled?: boolean;
    JellyseerrEnable4KRequests?: boolean;
    JellyseerrEnable4KTvRequests?: boolean;
    JellyseerrEnabled?: boolean;
    JellyseerrShowDetailPageLink?: boolean;
    JellyseerrShowDetailPageLinkAsText?: boolean;
    JellyseerrUseMoreInfoModal?: boolean;
    JellyseerrExcludeLibraryItems?: boolean;
    JellyseerrExcludeBlocklistedItems?: boolean;
    JellyseerrShowSimilar?: boolean;
    JellyseerrShowRecommended?: boolean;
    JellyseerrShowRequestMoreOnSeries?: boolean;
    JellyseerrShowReportButton?: boolean;
    JellyseerrShowIssueIndicator?: boolean;
}

export interface RequestManagerFacade {
    fetchWithRetry(url: string, options: RequestInit): Promise<{ json(): Promise<unknown> }>;
    metrics?: { enabled?: boolean };
    startMeasurement?(name: string): void;
    endMeasurement?(name: string): void;
}

export interface LifecycleHandleFacade { onTeardown(callback: () => void): unknown; teardownOn(event: 'navigate'): unknown }
export interface BodySubscription { unsubscribe(): void }
export interface ObserverFacade { disconnect(): void }

export interface CoreFacade {
    ui?: { isTvLayout?(): boolean; injectCss?(id: string, css: string): unknown };
    api?: {
        plugin(path: string, options: { skipRetry: boolean; signal?: AbortSignal }): Promise<unknown>;
        fetch(url: string, options: { skipRetry: boolean; signal?: AbortSignal }): Promise<unknown>;
    };
    lifecycle?: { register(name: string): LifecycleHandleFacade };
    navigation?: {
        onNavigate(callback: () => void): unknown;
        onViewPage(callback: (view: unknown, element: unknown, hash: unknown, item: unknown, event: Event | null) => void): unknown;
    };
}

export interface HelpersFacade {
    getItemCached?(id: string, options?: ItemCacheOptions): Promise<unknown>;
    getExternalLinkIconSize?(): number;
    hydrateAvatarImages?(root: ParentNode): void;
    createObserver?(id: string, callback: () => void, target: Node, config: MutationObserverInit): ObserverFacade;
    onBodyMutation?(id: string, callback: () => void): BodySubscription;
    throttle?(callback: () => void, wait: number): () => void;
}

export interface MoreInfoFacade {
    open?(id: TmdbId, type: string): Promise<void>;
    close?(): void;
    checkForUnrequestedSeasons?: UnrequestedSeasonsCheck;
}
export type UnrequestedSeasonsCheck = (details: unknown, signal?: AbortSignal) => Promise<boolean>;

export interface CdnFacade { selfhst(path: string): string; flagPng(code: string): string }

/** The fields of the shared JE global this slice reads or owns. */
export interface SeerrDetailsBridge {
    pluginConfig?: PluginConfigFacade;
    userConfig?: { elsewhere?: { Region?: string } };
    t?(key: string, params?: Record<string, string | number>): string;
    toast?(message: string, duration?: number): void;
    escapeHtml?(value: unknown): string;
    icon?(name: string): string;
    IconName?: { VIDEO: string; AUDIO: string; SUBTITLES: string; QUESTION: string };
    cdn?: CdnFacade;
    core?: CoreFacade;
    session?: SessionFacade;
    helpers?: HelpersFacade;
    requestManager?: RequestManagerFacade;
    seerrStatus?: SeerrStatusFacade;
    jellyseerrAPI?: SeerrApiFacade;
    jellyseerrUI?: SeerrUiFacade;
    jellyseerrModal?: { create(options: SeerrModalOptions): SeerrModalHandle };
    jellyseerrMoreInfo?: MoreInfoFacade;
    jellyseerrIssueReporter?: object;
    takePrefetched?(key: 'SeerrStatus'): unknown;
    initializeSeerrDetailLinkScript?: () => void;
    seamlessScroll?: object;
    internals?: { moreInfoModal?: MoreInfoRegistry };
}

/** The host object Jellyfin Enhanced loads onto; a typed view, not a copy. */
export function bridge(): SeerrDetailsBridge {
    const host: Window & { JellyfinEnhanced?: SeerrDetailsBridge } = window;
    if (!host.JellyfinEnhanced) throw new Error('Seerr details loaded before Jellyfin Enhanced');
    return host.JellyfinEnhanced;
}

/** Only the scroll engine may load first: its consumers feature-test it. */
export function bridgeOrNew(): SeerrDetailsBridge {
    const host: Window & { JellyfinEnhanced?: SeerrDetailsBridge } = window;
    return host.JellyfinEnhanced ?? (host.JellyfinEnhanced = {});
}

export function apiClient(): ApiClientFacade {
    const host: Window & { ApiClient?: ApiClientFacade } = window;
    if (!host.ApiClient) throw new Error('Jellyfin ApiClient unavailable');
    return host.ApiClient;
}

/** A background-priority task queue, where the browser has one. */
export interface PostTaskScheduler {
    postTask(task: () => void, options: { priority: 'background'; signal: AbortSignal }): Promise<void>;
}
export function taskScheduler(): PostTaskScheduler | null {
    const host: Window & { scheduler?: PostTaskScheduler } = window;
    return typeof host.scheduler?.postTask === 'function' ? host.scheduler : null;
}

export interface MoreInfoModalElement extends HTMLDivElement {
    /** Read across features (Spoiler Guard's toggle) to refuse a modal on its way out. */
    _isClosing?: boolean;
    _scope?: ModalScope;
}

/** What a modal's asynchronous work needs from its owner. */
export interface ModalScope {
    readonly signal: AbortSignal;
    onDispose(callback: () => void): void;
    dispose(): void;
    /** The modal's own requests in flight: their events are not news to it. */
    requests: number;
}

/** Buttons report what happened to them; `live` says whether anyone is still looking. */
export interface ActionContext {
    /** The modal is still the current one and its account is still signed in. */
    live(): boolean;
    /** A later render has not replaced this one. */
    current(): boolean;
    readonly signal: AbortSignal;
    onDispose(callback: () => void): void;
    readonly scope: ModalScope | null;
    readonly modal: MoreInfoModalElement | null;
}

export interface MoreInfoState { currentModal: MoreInfoModalElement | null }

export interface MoreInfoSurface {
    fetchRatings(tmdbId: TmdbId, mediaType: MediaType, details: unknown, signal?: AbortSignal): Promise<unknown>;
    fetchMediaDetails(tmdbId: TmdbId, mediaType: MediaType): Promise<unknown>;
    getContentRating(details: unknown, mediaType: MediaType): string;
    showError(message: string): void;
    formatCurrency(amount: unknown): string | null;

    backfillSeasonMetadata(tmdbId: TmdbId, details: unknown): Promise<void>;
    getSeasonStatusInfo(details: unknown, seasonNumber: number): Record<string, unknown> | null;
    getSeasonJellyfinId(season: Record<string, unknown> | null, is4k?: boolean): string | null;
    buildSeasonAvailabilityLinks(season: Record<string, unknown> | null, id?: string | null, id4k?: string | null): string;
    fetchJellyfinSeasonMap(seriesId: string): Promise<Record<number, { id: string; name: string | null }>>;
    enrichSeasonCardsWithJellyfinLinks(details: unknown, modal?: MoreInfoModalElement | null, options?: { refresh?: boolean }): Promise<void>;
    checkForUnrequestedSeasons: UnrequestedSeasonsCheck;
    buildSeasonsSection(details: unknown): string;

    buildRatingLogos(ratings: unknown, details: unknown, mediaType: MediaType, tmdbId: TmdbId): string;
    buildMediaFacts(details: unknown, mediaType: MediaType, tmdbId: TmdbId): string;
    buildStatusChip(status: number, status4k: number, isMovie: boolean, downloads?: readonly unknown[], downloads4k?: readonly unknown[],
        jellyfinId?: string | null, jellyfinId4k?: string | null, is4kChip?: boolean): HTMLElement;
    resolveStatusLabel(status: number, status4k: number, isMovie: boolean, downloads?: readonly unknown[], downloads4k?: readonly unknown[],
        is4kChip?: boolean): { text: string; className: string };
    buildDownloadBars(downloads?: readonly unknown[], downloads4k?: readonly unknown[]): HTMLElement | null;

    buildModalContent(details: unknown, mediaType: MediaType): string;
    buildRightPanel(details: unknown, mediaType: MediaType, parts: { budget: string | null; revenue: string | null; releaseDate: string | undefined; tmdbId: TmdbId }): string;
    buildStreamingProviders(details: unknown): string;
    buildCollectionCard(collection: unknown): string;
    buildKeywordsSection(details: unknown): string;
    buildCrewSection(details: unknown, mediaType: MediaType): string;
    buildTrailersSection(details: unknown): string;
    buildCastSection(details: unknown): string;
    buildPersonPlaceholder(): string;

    buildTvActions(details: unknown, show4k?: boolean, context?: ActionContext): HTMLElement | null;
    buildSingleTv4kButton(details: unknown, context?: ActionContext): HTMLElement;
    buildTvRequestMoreButton(details: unknown, show4k?: boolean, canRequest4k?: boolean, context?: ActionContext): HTMLElement;

    buildSingle4kButton(details: unknown, context?: ActionContext): HTMLElement;
    buildMovieActions(details: unknown, actionMount: Element | null, chipMount: Element | null, show4k: boolean, context?: ActionContext): HTMLElement | null;
    mountRequestedChip(details: unknown, mediaType: MediaType, is4k: boolean, response?: unknown, context?: ActionContext): void;
    maybeRenderMoreInfoQuotaChip(mount: HTMLElement | null, mediaType: MediaType, context?: ActionContext): Promise<void>;
    renderActions(details: unknown, mediaType: MediaType, modal?: MoreInfoModalElement | null): void;
}

export type MoreInfoRegistry = Partial<MoreInfoSurface> & { state: MoreInfoState };

/** The details group's own `JE.internals` slot (frontend.md §2.3). Its `JE.<name>` facades stay on the typed bridge. */
export type SeerrDetailsOwn = { moreInfoModal?: MoreInfoRegistry };
/** Other features' facades the details group reads (published by their owners; optional, they may load later). */
export interface SeerrDetailsPeers {
    hiddenContent: { filterJellyseerrResults(results: readonly unknown[], surface: 'recommendations'): unknown[] };
    /** details-providers' official-rating colour key (colored ratings). */
    normalizeOfficialRating(rating: string): string;
    /** spoiler-guard's facade: its more-info toggle (step C4). */
    spoilerBlur: SpoilerBlurPeerApi;
}
export type SeerrDetailsContext = FeatureContext<SeerrDetailsOwn, SeerrDetailsPeers, SeerrDetailsBridge>;
const detailsContexts = new WeakMap<SeerrDetailsBridge, SeerrDetailsContext>();
/** The feature context around a details-group bridge, one per bridge object. */
export function seerrDetailsContext(JE: SeerrDetailsBridge): SeerrDetailsContext {
    let ctx = detailsContexts.get(JE);
    if (!ctx) {
        ctx = featureContext<SeerrDetailsOwn, SeerrDetailsPeers, SeerrDetailsBridge>('seerr', JE, {
            internalSlots: ['moreInfoModal'],
            internalsObject: () => JE.internals ?? (JE.internals = {}),
        });
        detailsContexts.set(JE, ctx);
    }
    return ctx;
}

/** The registry the eight more-info scripts share across their bundles. */
export function moreInfoRegistry(JE: SeerrDetailsBridge): MoreInfoRegistry {
    const own = seerrDetailsContext(JE).own;
    return own.moreInfoModal ?? (own.moreInfoModal = { state: { currentModal: null } });
}

/** A sibling script's export. Scripts load in order; a missing one is a loader fault. */
export function sibling<K extends keyof MoreInfoSurface>(registry: MoreInfoRegistry, key: K): NonNullable<Partial<MoreInfoSurface>[K]> {
    const value = registry[key];
    if (value === undefined) throw new Error(`More Info loader dependency missing: ${key}`);
    return value;
}

/** Translate, falling back while a locale is still loading or lacks the key. */
export function translator(JE: SeerrDetailsBridge) {
    return (key: string, fallback = '', params?: Record<string, string | number>): string => {
        const text = params ? JE.t?.(key, params) : JE.t?.(key);
        return text || fallback;
    };
}

/** HTML-escape through the shared kit, or strictly here before it has loaded. */
export function escaper(JE: SeerrDetailsBridge): (value: unknown) => string {
    return value => {
        if (JE.escapeHtml) return JE.escapeHtml(value);
        return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
    };
}

/** The account a piece of work started under, for checks after each await. */
export function identityLease(JE: SeerrDetailsBridge): () => boolean {
    const epoch = JE.session?.getEpoch?.();
    return () => epoch === undefined || typeof JE.session?.isCurrent !== 'function' || JE.session.isCurrent(epoch);
}

export const SEERR_LOG = '🪼 Jellyfin Enhanced:';
