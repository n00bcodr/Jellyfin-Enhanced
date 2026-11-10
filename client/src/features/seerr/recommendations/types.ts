import type { YieldStats } from '../discovery/domain';
import type {
    FeedKind, GenreSliderEntry, ManagedFetchOptions, ScrollHint, ScrollResult, ScrollState, SeerrResult
} from '../discovery/types';

export interface RecommendationsFacade {
    renderForCustomTab(element: HTMLElement | null): void;
    showPage(): void;
    hidePage(): void;
}
export interface RowDefinition { readonly key: string; readonly path: string; readonly titleKey: string }
export interface CatalogEntry {
    readonly name: string;
    readonly id: number;
    readonly logo?: string;
    /** The company whose movies a network's category page shows beside its series. */
    readonly companyId?: number;
}
export interface CategorySource { readonly path: string; readonly mediaType?: FeedKind }
export interface ResolvedCategory { readonly title: string; readonly feeds: CategorySource[] }
export interface RowResult { readonly row: RowDefinition; readonly results: SeerrResult[]; readonly failed: boolean }

/** One feed of a category. page: last committed (0 = page 1 still owed); failing: re-ask one page at a time. */
export interface CategoryFeed {
    readonly path: string;
    readonly mediaType: FeedKind | null;
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
    showCategoryPage(categoryKey: string): Promise<void>;
    hideCategoryPage(): void;
    handleNavigation(): void;
    handleViewShow(event: Event): void;
    injectNavigation(): void;
    setupNavigationWatcher(): void;
}
/** Filled entry by entry in the component order, so a module may only assume what loaded before it. */
export type RecommendationsStage = { sidebar?: Element | null } & Partial<RecommendationsInternals>;
