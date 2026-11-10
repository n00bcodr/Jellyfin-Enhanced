import type { createStatusFacade } from './status';
import type {
    AdvancedRequestData, IssuePage, MovieCollection, OverrideRule, QuotaSide, RelatedPage, RequestSettings,
    RequestSettingsOverride, SearchPage, SeerrDetails, SeerrMediaItem, SonarrCandidate, UserQuota, UserStatus
} from './types';

/**
 * Public facades owned by the Seerr core group. Every bundle (this group's
 * and the concurrent Seerr details/discovery owners') reaches the single
 * runtime instance through these globals; import the types from here rather
 * than redeclaring them. Calls are late-bound: a member replaced on the
 * facade is what the group's own modules call next.
 */
export type SeerrStatusFacade = ReturnType<typeof createStatusFacade>;

export interface ReadOptions {
    signal?: AbortSignal | null;
    skipCache?: boolean;
    skipRetry?: boolean;
    headers?: Record<string, string>;
}
export interface SearchOptions { skipCache?: boolean; signal?: AbortSignal | null; throwOnError?: boolean }
export interface FollowUpOptions { skipCache: true; headers: Record<string, string> }
export type PageOrOptions = number | (ReadOptions & { page?: number });
export interface IssueQuery { take?: number; skip?: number; filter?: string; sort?: string }

export interface SeerrApiFacade {
    followUpOptions(details: unknown): FollowUpOptions | undefined;
    checkUserStatus(): Promise<UserStatus>;
    surfaceUserStatusBanner(status: unknown): void;
    shouldShowAdvanced(): boolean;
    clearUserStatusCache(): void;
    search(query: string, page?: number, options?: SearchOptions): Promise<SearchPage>;
    fetchMovieCollection(tmdbId: number | string, options?: { signal?: AbortSignal | null }): Promise<MovieCollection | null>;
    addCollections(results: SeerrMediaItem[], options?: { signal?: AbortSignal | null }): Promise<SeerrMediaItem[]>;
    fetchTvShowDetails(tmdbId: number | string, options?: ReadOptions): Promise<SeerrDetails | null>;
    fetchSonarrLookup(tmdbId: number | string): Promise<SonarrCandidate[]>;
    fetchTvSeasonDetails(tmdbId: number | string, seasonNumber: number, options?: ReadOptions): Promise<SeerrDetails | null>;
    fetchTmdbTvDetails(tmdbId: number | string, options?: ReadOptions): Promise<SeerrDetails | null>;
    fetchOverrideRules(): Promise<OverrideRule[]>;
    getCurrentJellyseerrUserId(): Promise<string | null>;
    evaluateOverrideRules(mediaData: unknown, mediaType: string, is4k?: boolean): Promise<RequestSettingsOverride | null>;
    requestMedia(tmdbId: number | string, mediaType: string, advancedSettings?: object, is4k?: boolean,
        mediaData?: unknown, tvdbId?: number | null): Promise<unknown>;
    requestTvSeasons(tmdbId: number | string, seasonNumbers: readonly number[], advancedSettings?: object,
        mediaData?: unknown, is4k?: boolean, tvdbId?: number | null): Promise<unknown>;
    fetchIssuesForMedia(tmdbId: number | string, mediaType: string, options?: IssueQuery): Promise<IssuePage>;
    fetchIssueById(issueId: number | string): Promise<SeerrDetails | null>;
    fetchAdvancedRequestData(mediaType: string): Promise<AdvancedRequestData>;
    fetchUserQuota(options?: ReadOptions): Promise<UserQuota | null>;
    fetchRequestSettings(): Promise<RequestSettings>;
    addToWatchlist(tmdbId: number | string, mediaType: string): Promise<boolean>;
    reportIssue(mediaId: number | string, mediaType: string, problemType: unknown, message?: string,
        problemSeason?: unknown, problemEpisode?: unknown): Promise<unknown>;
    fetchSimilarMovies(tmdbId: number | string, pageOrOptions?: PageOrOptions): Promise<RelatedPage>;
    fetchRecommendedMovies(tmdbId: number | string, pageOrOptions?: PageOrOptions): Promise<RelatedPage>;
    fetchSimilarTvShows(tmdbId: number | string, pageOrOptions?: PageOrOptions): Promise<RelatedPage>;
    fetchRecommendedTvShows(tmdbId: number | string, pageOrOptions?: PageOrOptions): Promise<RelatedPage>;
    fetchMovieDetails(tmdbId: number | string, options?: ReadOptions): Promise<SeerrDetails | null>;
    fetchCollectionDetails(collectionId: number | string): Promise<SeerrDetails | null>;
    fetchGenreSlider(mediaType: string): Promise<unknown[]>;
    resolveJellyseerrBaseUrl(): string;
}

export type IconName = 'star' | 'available' | 'error' | 'cloud_off' | 'person_off' | 'pending' | 'requested'
    | 'partially_available' | 'cancel' | 'request';
export type SeerrIcons = Readonly<Record<IconName, string>>;
export interface QuotaLine { text: string; restricted: boolean; unlimited: boolean; resetText: string }
export interface SeasonAnalysis { overallStatus: number; statusSummary: string | null; total: number; availableCount?: number }
export interface InlineProgressInput { size?: number | null; sizeLeft?: number | null; status?: string | null }

/** JE.jellyseerrUI: assembled by the ui-*.js entries in load order. */
export interface SeerrUiFacade {
    icons: SeerrIcons;
    addMainStyles(): void;
    addSeasonModalStyles(): void;
    hideHoverPopover(): void;
    toggleHoverPopoverLock(lockState?: boolean): void;
    formatEtaText(downloadStatus: unknown): string | null;
    releasePosters(root?: ParentNode): void;
    isInLibrary(item: unknown): boolean;
    cardInputsKey(items: readonly unknown[]): string;
    createJellyseerrCard(item: unknown, isJellyseerrActive: boolean, jellyseerrUserFound: boolean): HTMLElement | null;
    configureRequestButton(button: HTMLButtonElement, item: unknown, isJellyseerrActive: boolean, jellyseerrUserFound: boolean): void;
    isQuotaError(error: unknown): boolean;
    showQuotaErrorDialog(error: unknown, mediaType: string): Promise<void>;
    buildQuotaChip(quota: unknown, mediaType: string): HTMLElement | null;
    updateJellyseerrIcon(isJellyseerrActive: boolean, jellyseerrUserFound: boolean, isJellyseerrOnlyMode: boolean, onToggleFilter: (() => void) | null): void;
    clearInjectedSearchResults(): void;
    renderJellyseerrResults(results: SeerrMediaItem[], query: string, isJellyseerrOnlyMode: boolean, isJellyseerrActive: boolean, jellyseerrUserFound: boolean): void;
    updateJellyseerrResults(newResults: readonly SeerrMediaItem[], isJellyseerrActive: boolean, jellyseerrUserFound: boolean, container?: ParentNode): void;
    showMovieRequestModal(tmdbId: number | string, title: string, searchResultItem: unknown, is4k?: boolean): Promise<void>;
    showCollectionRequestModal(collectionId: number | string, collectionName: string, searchResultItem?: unknown): Promise<void>;
    showSeasonSelectionModal(tmdbId: number | string, mediaType: string, showTitle: string, searchResultItem?: unknown, is4k?: boolean): Promise<void>;
}

export interface SeerrUiState {
    jellyseerrHoverPopover: HTMLElement | null;
    jellyseerrHoverLock: boolean;
    active4KPopup: HTMLElement | null;
}
/**
 * JE.internals.jellyseerrUi: the group's shared state and sibling functions.
 * Siblings are optional because the entries load (and are tested) in subsets.
 */
export interface SeerrUiInternals {
    state: SeerrUiState;
    installed?: Set<string>;
    viewOrigins?: WeakMap<Element, { readonly epoch: number | null; current(): boolean }>;
    icons?: SeerrIcons;
    ensureHoverPopover?(): HTMLElement;
    formatEtaText?(downloadStatus: unknown): string | null;
    fillHoverPopover?(item: SeerrMediaItem): HTMLElement | null;
    positionHoverPopover?(element: HTMLElement, x: number, y: number): void;
    createInlineProgress?(downloadStatus: InlineProgressInput | null | undefined): HTMLElement | null;
    hide4KPopup?(): void;
    show4KPopup?(buttonGroup: HTMLElement, item: SeerrMediaItem): void;
    addDownloadProgressHover?(button: HTMLElement, item: SeerrMediaItem): void;
    clearDownloadProgressHover?(button: HTMLElement): void;
    setStatusBadge?(card: HTMLElement, item: SeerrMediaItem, seasonAnalysis?: SeasonAnalysis | null): void;
    fetchProviderIcons?(container: HTMLElement, tmdbId: number, mediaType: string, signal?: AbortSignal): Promise<void>;
    isSafeTmdbImagePath?(path: unknown): boolean;
    addMediaTypeBadge?(card: HTMLElement, item: SeerrMediaItem, imageContainer?: HTMLElement, label?: string): void;
    addCollectionMembershipBadge?(card: HTMLElement, item: SeerrMediaItem, imageContainer?: HTMLElement): void;
    createJellyseerrCard?(item: unknown, isJellyseerrActive: boolean, jellyseerrUserFound: boolean): HTMLElement | null;
    configureRequestButton?(button: HTMLButtonElement, item: unknown, isJellyseerrActive: boolean, jellyseerrUserFound: boolean): void;
    configureCollectionButton?(button: HTMLButtonElement, item: SeerrMediaItem): void;
    configureTvShowButton?(button: HTMLButtonElement, overallStatus: number | null | undefined, seasonAnalysis: SeasonAnalysis | null, item: SeerrMediaItem): void;
    configureMovieButton?(button: HTMLButtonElement, item: SeerrMediaItem): void;
    isQuotaError?(error: unknown): boolean;
    formatNextReset?(resetAt: unknown): string;
    formatQuotaLine?(quota: QuotaSide | null | undefined, type: string): QuotaLine;
    buildQuotaChip?(quota: unknown, mediaType: string): HTMLElement | null;
    showQuotaErrorDialog?(error: unknown, mediaType: string): Promise<void>;
    handleRequestError?(error: unknown, mediaType: string, requestBtn: HTMLButtonElement | null, resetLabel: string): Promise<void>;
    markCardRequested?(tmdbId: string, mediaType: string, is4k?: boolean): void;
    analyzeSeasonStatuses?(seasons: unknown): SeasonAnalysis;
    createJellyseerrSection?(results: SeerrMediaItem[], isJellyseerrOnlyMode: boolean, isJellyseerrActive: boolean, jellyseerrUserFound: boolean): HTMLElement;
    updateSeasonList?(seasonListElement: Element | null, tvDetails: unknown, partialRequestsEnabled?: boolean,
        enableSpecialEpisodes?: boolean, is4kMode?: boolean, jellyfinSeasonMap?: Readonly<Record<number, boolean>> | null): void;
    outcomes?: RequestOutcome[];
}

/** A request write as this client observed it; diagnostic, bounded, never replayed. */
export interface RequestOutcome {
    kind: 'acknowledged' | 'rejected' | 'uncertain' | 'not-sent';
    mediaType: string;
    tmdbId: number;
    is4k: boolean;
    /** The outcome reached the client after its originating identity had changed. */
    stale: boolean;
    status?: number;
}

export interface ModalOptions {
    title: string;
    subtitle: string;
    bodyHtml: string;
    backdropPath?: string | null | undefined;
    backdropUrl?: string | null | undefined;
    onSave: (modalElement: HTMLElement, requestBtn: HTMLButtonElement, close: () => void) => unknown;
    onClose?: (() => void) | undefined;
    buttonText?: string | undefined;
}
/** A replaced facade (tests, themes) may return an instance without close. */
export interface ModalInstance { modalElement: HTMLElement; show(): void; close?(): void }
/** JE.jellyseerrModal. */
export interface SeerrModalFacade {
    create(options: ModalOptions): ModalInstance;
    createAdvancedOptionsHTML(idPrefix: string): string;
    populateAdvancedOptions(modalElement: HTMLElement, data: unknown, idPrefix: string, is4k?: boolean): void;
}
