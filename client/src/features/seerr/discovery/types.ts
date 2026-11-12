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
    readonly voteCount?: unknown;
    readonly jeSortRating?: unknown;
    /** Spoiler Guard keeps a guarded title's vote count here, so Most votes keeps it in place. */
    readonly jeSortVotes?: unknown;
    readonly genreIds?: unknown;
    readonly originalLanguage?: unknown;
    /** On a person's titles: what the person did in this one (person discovery merges the credits). */
    readonly jeCredit?: JeCredit;
}
/**
 * What a person did in one title: the parts played (cast rows), the jobs held (crew rows), each once, in
 * Seerr's order; `crew` pairs each job with its department (TMDB's names, "Directing").
 */
export interface JeCredit {
    readonly acted: boolean;
    readonly characters: readonly string[];
    readonly jobs: readonly string[];
    readonly departments: readonly string[];
    readonly crew: ReadonlyArray<readonly [string, string]>;
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
/** Which further filters a section can offer: a list page's feed (Seerr filters it) or a person's titles (filtered here). */
export type FilterScope = 'feed' | 'person';
export interface SortOption { readonly value: string; readonly label: string; readonly labelKey: string }
/** The All / Movies / Series choice of a header's tabs, for the Filters menu where the tabs are out of sight. */
export interface TypePicker {
    groupOf(): MenuGroup;
    choose(mode: string): void;
    tabsShowing(): boolean;
}

// ---- The menus (menu.ts) -------------------------------------------------------------------------
export interface MenuChoice { readonly id: string; readonly name: string; readonly selected: boolean }
/** What a group's own body has of the menu: its row's words, and a new place after its size changed. */
export interface GroupHandle {
    say(value: string, set: boolean): void;
    placed(): void;
}
export interface MenuGroup {
    readonly id: string;
    readonly name: string;
    readonly choices?: readonly MenuChoice[] | undefined;
    /** A body of the caller's own, built when the group is first opened (and again after "clear"). */
    readonly build?: ((host: HTMLElement, handle: GroupHandle) => void) | undefined;
    /** With a body of its own: what the group's row says, and whether that is narrowing the list. */
    readonly value?: string | undefined;
    readonly set?: boolean | undefined;
    /** What its row says when nothing is set in it. */
    readonly any?: string | undefined;
    /** The menu opens with this group open (the one the viewer came for). */
    readonly open?: boolean | undefined;
}
export interface MenuOptions {
    readonly anchor: HTMLElement;
    readonly title: string;
    readonly choices?: readonly MenuChoice[] | undefined;
    readonly groups?: readonly MenuGroup[] | undefined;
    readonly clearLabel?: string | undefined;
    readonly doneLabel?: string | undefined;
    onPick(id: string, groupId?: string): void;
    readonly onClear?: (() => void) | undefined;
    readonly onClose?: (() => void) | undefined;
}
export interface MenuRow { readonly item: HTMLButtonElement; readonly text: HTMLElement; readonly body: HTMLElement }
export interface DiscoveryMenuFacade {
    openMenu(options: MenuOptions): () => void;
    menuRow(name: string, iconName: string, iconHidden: boolean): MenuRow;
    groupedMenuRoom(groupCount: number): number;
}

// ---- A list being replaced (busy.ts), the role line (roles.ts) -----------------------------------
export interface DiscoveryBusyFacade {
    circle(className: string): HTMLElement;
    hold(control: Element | null | undefined): void;
    release(list: HTMLElement | null | undefined): void;
    mark(section: Element | null | undefined): void;
    heldAt(section: HTMLElement, header: HTMLElement): number;
    readonly HOLD_LIST_MS: number;
}
export interface DiscoveryRolesFacade {
    decorateCard(card: HTMLElement | null | undefined, item: SeerrResult | null | undefined): void;
    fitRoleLines(section: Element | null | undefined): void;
    readonly ROLE_ASKED: string;
}

// ---- The section and its join (section.ts) -------------------------------------------------------
export type SectionPage = 'detail' | 'list';
export interface MessageRowOptions {
    readonly message: string;
    readonly actionLabel?: string | undefined;
    readonly onAction?: (() => void) | undefined;
}
export interface DiscoverySectionFacade {
    buildSection(options: { readonly key: string; readonly page: SectionPage; readonly header: HTMLElement }): HTMLElement;
    placeSection(anchor: HTMLElement, section: HTMLElement, page: SectionPage): boolean;
    attachJoin(section: HTMLElement, onListPage: boolean): void;
    readonly PLACEHOLDER_CARDS: number;
    buildPlaceholderCards(count: number, cardClass: string): DocumentFragment;
    clearPlaceholders(container: ParentNode): void;
    buildMessageRow(options: MessageRowOptions): HTMLElement;
    buildRetrySection(key: string, message: string, actionLabel: string, onAction: () => void): HTMLElement;
}

// ---- The further filters (filters.ts, filter-panel.ts) -------------------------------------------
/** One thing picked from a list: what it is to Seerr, and its name for the eye. */
export interface Picked { readonly id: string; readonly name: string }
/** What was typed as the lower and the upper bound; '' for none. */
export type Range = readonly [string, string];
export type RangeId = 'year' | 'score' | 'votes' | 'runtime';
export type ListId = 'role' | 'genres' | 'language' | 'rating' | 'services' | 'keywords' | 'without';
export type FilterId = RangeId | ListId;
/**
 * The further filters set in a section. A genre's id is `<movie id>/<tv id>`, a language's its two-letter
 * code, a content rating's `<movie|tv>:<country>:<rating>`, a service's and a keyword's TMDB's id, a role
 * `cast` or a crew department by TMDB's name.
 */
export type FilterSelection = { readonly [K in RangeId]?: Range | undefined } & { readonly [K in ListId]?: readonly Picked[] | undefined };
export interface RatingList { readonly kind: FeedKind; readonly ratings: readonly Picked[] }
export interface FilterData {
    readonly region: string;
    genres(): Promise<Picked[]>;
    languages(locale: string): Promise<Picked[]>;
    ratings(): Promise<RatingList[]>;
    services(): Promise<Picked[]>;
    searchKeywords(query: string, signal: AbortSignal): Promise<Picked[]>;
}
export interface FilterDataDependencies {
    readonly region: string;
    fetch(path: string, options?: ManagedFetchOptions): Promise<unknown>;
    fetchGenres(kind: FeedKind): Promise<unknown>;
}
export type Say = (key: string, fallback: string, values?: Record<string, string | number>) => string;
export interface FilterToken { readonly words: string; without(selection: FilterSelection): FilterSelection }
export interface FilterMenuOptions {
    readonly offered: readonly FilterId[];
    readonly data: FilterData;
    readonly locale: string;
    readonly label: Say;
    selection(): FilterSelection;
    change(next: FilterSelection, focusAt?: number): void;
    /** On a person's page: what that person did across the titles, the most credits first. */
    readonly roles?: (() => Picked[]) | undefined;
    /** On a genre's page: that genre's name (every title of the list is in it already). */
    readonly ownGenre?: string | undefined;
}
export interface DiscoveryFiltersFacade {
    readonly FILTER_SWITCHES: Readonly<Record<FilterId, string>>;
    offeredFilters(scope: FilterScope, config: unknown): FilterId[];
    activeFilterCount(selection: FilterSelection | null | undefined): number;
    dayOf(text: string, last: boolean): string | null;
    numberOf(id: RangeId, text: string): number | null;
    isBound(id: RangeId, text: string, upper: boolean): boolean;
    isReversed(id: RangeId, range: Range): boolean;
    feedFilterQuery(selection: FilterSelection | null | undefined, kind: FeedKind, region: string): string;
    keepByFilters(results: SeerrResult[], selection: FilterSelection | null | undefined): SeerrResult[];
    rolesOf(results: readonly SeerrResult[], actingName: string, nameOf: (department: string) => string): Picked[];
    createFilterData(dependencies: FilterDataDependencies): FilterData;
    createFiltersControl(header: HTMLElement, moduleName: string, scope: FilterScope, onChange: () => void,
        ownGenre?: string): HTMLButtonElement;
    feedQuery(name: string, kind: FeedKind): string;
    keep(name: string, results: SeerrResult[]): SeerrResult[];
    active(name: string): boolean;
    reset(name: string): void;
    repaint(element: Element | null | undefined): void;
    noteIfEmpty(moduleName: string, container: HTMLElement | null | undefined, hasMore: boolean): void;
    roomUnderMenu(section: HTMLElement | null, header: HTMLElement, open: boolean): void;
    filterMenuGroups(options: FilterMenuOptions): MenuGroup[];
    filterTokens(options: { readonly offered: readonly FilterId[]; readonly label: Say; readonly locale: string;
        readonly selection: FilterSelection }): FilterToken[];
    selectionOf(name: string): FilterSelection;
}

/** Public `JE.discoveryFilter` surface; it is read at call time by every consumer. */
export interface DiscoveryFilterFacade {
    MODES: { readonly MIXED: 'mixed'; readonly MOVIES: 'movies'; readonly TV: 'tv' };
    SORT_OPTIONS: readonly SortOption[];
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
    createFilterControl(moduleName: string, onFilterChange?: FilterChange, heldTitle?: string): HTMLElement;
    addFilterControl(header: Element, moduleName: string, onFilterChange?: FilterChange): void;
    typePickerOf(tabs: Element | null): TypePicker | undefined;
    createSortControl(moduleName: string, onSortChange?: SortChange): HTMLElement;
    createSectionHeader(title: string, moduleName: string, showFilter: boolean,
        onFilterChange?: FilterChange, onSortChange?: SortChange, subject?: string, scope?: FilterScope): HTMLElement;
    feedQuery(moduleName: string, kind: FeedKind): string;
    keepByFilters(moduleName: string, results: SeerrResult[]): SeerrResult[];
    hasMoreFilters(moduleName: string): boolean;
    noteIfEmpty(moduleName: string, container: HTMLElement, hasMore: boolean): void;
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
    /** The name the title is about, kept whole when the heading wraps. */
    readonly name?: string | undefined;
    /** Network and studio feeds read the same id differently; see network discovery. */
    readonly tvSource?: 'network' | 'company';
}
export interface ResolvedItems { readonly items: SeerrResult[]; readonly title: string; readonly name?: string | undefined }
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
