import type { YieldStats } from '../discovery/domain';
import type {
    FeedKind, FeedPage, GenreSliderEntry, ManagedFetchOptions, ScrollHint, ScrollResult, ScrollState, SeerrResult
} from '../discovery/types';

export interface RecommendationsFacade {
    renderForCustomTab(element: HTMLElement | null): void;
    showPage(): void;
    hidePage(): void;
}
/** A media row; `kind`: what it holds, for the page's All | Movies | Series and the kind its filters are asked for (Trending holds both and takes none). */
export interface RowDefinition { readonly key: string; readonly path: string; readonly titleKey: string; readonly kind?: FeedKind }
export interface CatalogEntry {
    readonly name: string;
    readonly id: number;
    readonly logo?: string;
    /** The company whose movies a network's category page shows beside its series. */
    readonly companyId?: number;
}
/** A category's feed; `kind`: the kind the page's filters are asked for (none for Trending, which takes none: its titles are checked as they come). */
export interface CategorySource { readonly path: string; readonly mediaType?: FeedKind; readonly kind?: FeedKind }
export interface ResolvedCategory { readonly title: string; readonly feeds: CategorySource[] }
export interface RowResult { readonly row: RowDefinition; readonly results: SeerrResult[]; readonly failed: boolean }

/** One feed of a category. page: last committed (0 = page 1 still owed); failing: re-ask one page at a time. */
export interface CategoryFeed {
    readonly path: string;
    readonly mediaType: FeedKind | null;
    /** The kind the filters are asked for (null: Trending takes none, its titles are kept here by what each says of itself). */
    readonly kind: FeedKind | null;
    page: number;
    totalPages: number;
    hasMore: boolean;
    seen: number;
    failing: boolean;
}
/** Each category open and sort reload owns one of these; requests end with its controller. */
export interface CategoryState extends ScrollState {
    isLoading: boolean;
    filtered: boolean;
    readonly feeds: CategoryFeed[];
    readonly controller: AbortController | null;
    readonly yieldStats: YieldStats;
    /** What this state shows, so TMDB's overlapping pages render once. */
    readonly shown: Set<string>;
}
/** What one rendered container owns: its requests, row observers and sticky tracking. */
export interface RenderOwner {
    readonly container: HTMLElement;
    readonly controller: AbortController;
    readonly disposers: Array<() => void>;
}
export interface RecommendationsState {
    pageVisible: boolean;
    previousPage: Element | null;
    /** The standalone page's render; ending it is part of hiding the page. */
    currentAbortController: AbortController | null;
    categoryPageVisible: boolean;
    categoryPreviousPage: Element | null;
    /** The standalone page was open when the category page replaced it. */
    categoryReturnsToPage: boolean;
    categoryState: CategoryState;
    readonly renders: Map<HTMLElement, RenderOwner>;
}
export interface RecommendationsInternals {
    logPrefix: string;
    pluginPagesExists: boolean;
    state: RecommendationsState;
    ROWS: RowDefinition[];
    STUDIOS: CatalogEntry[];
    NETWORKS: CatalogEntry[];
    MOVIE_GENRES: GenreSliderEntry[];
    TV_GENRES: GenreSliderEntry[];
    resolveCategory(categoryKey: string): ResolvedCategory | null;
    fetchWithManagedRequest(path: string, options?: ManagedFetchOptions): Promise<unknown>;
    /** Today in the viewer's calendar, as Seerr's dates are written. */
    localDay(now?: Date): string;
    /** Whether a row or feed of this kind (none: both kinds) shows under All | Movies | Series. */
    shownForType(kind: FeedKind | null | undefined, mode: string): boolean;
    isTrendingPath(path: string): boolean;
    feedRequest(path: string, page: number, filterQuery: string, today: string): string;
    /** One page of a feed under the page's filters, asked as the feed's kind takes them. */
    feedPage(path: string, kind: FeedKind | null | undefined, page: number, options?: ManagedFetchOptions): Promise<FeedPage>;
    /** Titles of a feed that takes no filters, kept by the filters; null when one is set they can't be checked against. */
    keepLoaded(results: SeerrResult[]): SeerrResult[] | null;
    /** Whether anything narrows the page: a type other than All, or a further filter. */
    isNarrowed(): boolean;
    filterSignature(): string;
    clearFilters(): void;
    /** Whether the page's address holds its filters: on Home (its tab) or on its own page. */
    addressHoldsFilters(): boolean;
    /** Whether an address is the page's own (`#/recommendations`, with or without its filters). */
    isPageHash(hash: string): boolean;
    /** After the filters changed elsewhere (a category page): every page shows them, with rows to match. */
    syncFilters(): void;
    /** Follows the address after a navigation, as far as it is a category's on Home: true when it did. */
    followUrl(): boolean;
    fetchAllRows(signal: AbortSignal): Promise<RowResult[]>;
    fetchGenreSlider(mediaType: FeedKind): Promise<GenreSliderEntry[]>;
    disposeRender(container: HTMLElement): void;
    sweepRenders(): void;
    trackStickyBar(bar: HTMLElement): () => void;
    createMediaRow(title: string, results: SeerrResult[], viewAllKey?: string, owner?: RenderOwner): HTMLElement;
    createTileRow(title: string, items: readonly CatalogEntry[], kind: 'studio' | 'network', owner?: RenderOwner): HTMLElement;
    createGenreTileRow(title: string, genres: readonly GenreSliderEntry[], mediaType: FeedKind, owner?: RenderOwner): HTMLElement;
    renderInto(container: HTMLElement): Promise<void>;
    renderForCustomTab(element: HTMLElement | null): void;
    createPageContainer(): HTMLElement;
    showPage(): void;
    hidePage(): void;
    createCategoryPageContainer(): HTMLElement;
    loadMoreCategoryItems(st: CategoryState, container: HTMLElement, hint?: ScrollHint,
        isStale?: () => boolean): Promise<ScrollResult>;
    /** `fromUrl`: opened by its address (a link, a reload, Back, Forward), which names it. */
    showCategoryPage(categoryKey: string, fromUrl?: boolean): Promise<void>;
    hideCategoryPage(): void;
    /** True while the open category page's own history entry is the current one. */
    categoryOnOwnEntry(): boolean;
    handleNavigation(): void;
    handleViewShow(event: Event): void;
    injectNavigation(): void;
    setupNavigationWatcher(): void;
}
/** Filled entry by entry in the component order, so a module may only assume what loaded before it. */
export type RecommendationsStage = { sidebar?: Element | null } & Partial<RecommendationsInternals>;
