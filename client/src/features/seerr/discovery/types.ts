/** Shared contracts of the Seerr discovery sections and their public facades. */
export type FilterMode = 'mixed' | 'movies' | 'tv';
export type FeedKind = 'tv' | 'movie';
export type DiscoveryMode = 'dual-feed' | 'client-paged' | 'one-shot';

/**
 * One Seerr search-result row. The object is handed unchanged to the shared card
 * renderer, which reads many more fields, so everything stays `unknown` here and
 * consumers narrow only the fields they use.
 */
export interface SeerrResult {
    readonly id?: unknown;
    readonly tmdbId?: unknown;
    readonly mediaType?: unknown;
    readonly title?: unknown;
    readonly name?: unknown;
    readonly mediaInfo?: unknown;
    readonly releaseDate?: unknown;
    readonly firstAirDate?: unknown;
    readonly voteAverage?: unknown;
    readonly jeSortRating?: unknown;
}

/** A decoded feed page. `totalPages` stays absent when the response did not report one. */
export interface FeedPage {
    readonly results: SeerrResult[];
    readonly totalPages?: number;
    readonly failed?: boolean;
}
export interface GenreListEntry { readonly id: number; readonly name: string }
export interface GenreSliderEntry { readonly id: number; readonly name: string; readonly backdrops: string[] }
export interface NamedTmdbInfo { readonly name: string; readonly tmdbId?: string | null }
export interface FeedIds { tv: number | null; movie: number | null }

export interface ManagedFetchOptions { readonly signal?: AbortSignal | undefined }

export interface SessionScope<T> {
    has(key: string | number): boolean;
    get(key: string | number): T | undefined;
    set(key: string | number, value: T): void;
}
export interface SessionCache<T> { scope(): SessionScope<T> }

export interface ScrollHint {
    deficitPx?: number;
    aheadPx?: number;
    spanPx?: number;
    horizontal?: boolean;
    engaged?: boolean;
    pageBudget?: number;
}
export interface ScrollResult { pages: number; rendered: number }
export type LoadMore = (hint?: ScrollHint) => Promise<ScrollResult | void>;
/** The scroll engine stores its observer here and exposes a wake function as `fill`. */
export interface ScrollState {
    activeScrollObserver: IntersectionObserver | null;
    fill?: (() => void) | null;
}
export interface ScrollOptions { horizontal?: boolean; trackSelector?: string; scrollerSelector?: string }

export interface AppendSliceOptions {
    readonly syncCount?: number;
    readonly isCurrent?: (() => boolean) | undefined;
}
export interface AppendCardsOptions {
    readonly cardClass?: string;
    readonly isCurrent?: (() => boolean) | undefined;
}
export interface PageReadyOptions {
    readonly type?: 'list' | 'detail';
    readonly getView?: (() => HTMLElement | null) | null;
    readonly isStalePage?: ((page: Element | null) => boolean) | null;
}

export type FilterChange = (mode: FilterMode) => void;
export type SortChange = (sort: string) => void;

/** Public `JE.discoveryFilter` surface; it is read at call time by every consumer. */
export interface DiscoveryFilterFacade {
    MODES: { readonly MIXED: 'mixed'; readonly MOVIES: 'movies'; readonly TV: 'tv' };
    SORT_OPTIONS: ReadonlyArray<{ readonly value: string; readonly label: string }>;
    getFilterMode(moduleName: string): FilterMode;
    setFilterMode(moduleName: string, mode: string): void;
    resetFilterMode(moduleName: string): void;
    getSortMode(moduleName: string): string;
    getTvSortMode(moduleName: string): string;
    setSortMode(moduleName: string, sort: string): void;
    resetSortMode(moduleName: string): void;
    interleaveArrays<A, B>(first: readonly A[], second: readonly B[]): Array<A | B>;
    filterByMediaType(results: SeerrResult[], mode: string): SeerrResult[];
    hasBothTypes(tvResults: readonly unknown[], movieResults: readonly unknown[]): boolean;
    resultHasBothTypes(results: readonly SeerrResult[]): boolean;
    createFilterControl(moduleName: string, onFilterChange?: FilterChange): HTMLElement;
    createSortControl(moduleName: string, onSortChange?: SortChange): HTMLElement;
    createSectionHeader(title: string, moduleName: string, showFilter: boolean,
        onFilterChange?: FilterChange, onSortChange?: SortChange): HTMLElement;
    fetchWithManagedRequest(path: string, cachePrefix: string, options?: ManagedFetchOptions): Promise<unknown>;
    fetchTmdbGenreList(mediaType: FeedKind, options?: ManagedFetchOptions): Promise<GenreListEntry[]>;
    createSessionCache<T>(name: string, isValid: (value: unknown) => value is T): SessionCache<T>;
    createCardsFragment(results: SeerrResult[], options?: { readonly cardClass?: string }): DocumentFragment;
    appendCards(container: HTMLElement, results: SeerrResult[], options?: AppendCardsOptions): Promise<number>;
    appendInSlices<T>(container: HTMLElement, items: readonly T[], createCard: (item: T) => HTMLElement | null,
        options?: AppendSliceOptions): Promise<number>;
    cardsInView(container: HTMLElement, options?: { readonly horizontal?: boolean }): number;
    waitForPageReady(signal?: AbortSignal, options?: PageReadyOptions): Promise<HTMLElement | null>;
    setupInfiniteScroll(state: ScrollState, sectionSelector: string, loadMore: LoadMore, hasMore: () => boolean,
        isLoading: () => boolean, options?: ScrollOptions): void;
    cleanupScrollObserver(state: ScrollState): void;
    applyFilterVisibility(container: HTMLElement | null, mode: string): void;
}

export interface ResolveContext { readonly id: string; readonly signal: AbortSignal }
export interface ResolvedFeeds {
    readonly tvId: number | null;
    readonly movieId: number | null;
    readonly title: string;
    /** Network and studio feeds read the same id differently; see network discovery. */
    readonly tvSource?: 'network' | 'company';
}
export interface ResolvedItems { readonly items: SeerrResult[]; readonly title: string }
export interface OneShotContext extends ResolveContext {
    readonly pageKey: string;
    waitForPageReady(signal?: AbortSignal): Promise<HTMLElement | null>;
}

interface SpecBase {
    readonly key: string;
    readonly logLabel: string;
    readonly configKey: DiscoveryConfigKey;
    readonly defaultEnabled?: boolean;
    getIdFromUrl(): string | null;
    pageKey?(id: string): string;
    onCleanup?(): void;
}
export interface DualFeedSpec extends SpecBase {
    readonly mode: 'dual-feed';
    resolveFeeds(context: ResolveContext): Promise<ResolvedFeeds | null>;
    buildDiscoverPath(kind: FeedKind, id: number, feeds: ResolvedFeeds): string;
}
export interface ClientPagedSpec extends SpecBase {
    readonly mode: 'client-paged';
    readonly pageSize?: number;
    resolveItems(context: ResolveContext): Promise<ResolvedItems | null>;
}
export interface OneShotSpec extends SpecBase {
    readonly mode: 'one-shot';
    renderOneShot(context: OneShotContext): Promise<boolean | undefined>;
}
export type DiscoverySpec = DualFeedSpec | ClientPagedSpec | OneShotSpec;

export type DiscoveryConfigKey = 'JellyseerrShowNetworkDiscovery' | 'JellyseerrShowPersonDiscovery' |
    'JellyseerrShowGenreDiscovery' | 'JellyseerrShowTagDiscovery' | 'JellyseerrShowCollectionDiscovery';

export interface DiscoveryController {
    initialize(): void;
    cleanup(): void;
    render(): Promise<void>;
    handlePageNavigation(view?: unknown, element?: unknown): void;
    start(): void;
    dispose(): void;
}
export interface DiscoveryBaseFacade {
    createDiscovery(spec: DiscoverySpec): DiscoveryController;
    idFromDetailUrl(): string | null;
    idFromListParam(param: string): () => string | null;
}
