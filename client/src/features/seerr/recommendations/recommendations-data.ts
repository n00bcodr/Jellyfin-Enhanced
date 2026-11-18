// /js/jellyseerr/recommendations/recommendations-data.js
// Recommendations Page: shared state, Seerr fetch helpers and the identity reset.
import { filterOf, identityKey } from '../host-discovery';
import { decodeFeedPage, decodeGenreSlider } from '../discovery/domain';
import type { FeedKind, FeedPage, GenreSliderEntry, ManagedFetchOptions, SeerrResult } from '../discovery/types';
import { FILTER_MODULE, LOG_PREFIX, part, PLUGIN_PAGE_LINK, recommendationsHost, SORT_MODULE } from './stage';
import type { CategoryState, RecommendationsState, RowDefinition, RowResult } from './types';

/** A failed (or empty) slider is retried after this, so one outage can't blank genres until a reload. */
const EMPTY_SLIDER_RETRY_MS = 60 * 1000;
// Pages of Trending read for its row while filters narrow it, and the titles that are enough to stop at.
const TRENDING_FILTERED_PAGES = 3;
const TRENDING_FILTERED_ENOUGH = 12;

/** Today in the viewer's calendar, as Seerr's dates are written. */
function localDay(now = new Date()): string {
    const two = (value: number) => String(value).padStart(2, '0');
    return `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}`;
}
/** Whether a row or feed of this kind (none: both kinds) shows under All | Movies | Series ('mixed', 'movies' or 'tv'). */
function shownForType(kind: FeedKind | null | undefined, mode: string): boolean {
    return !kind || mode === 'mixed' || (mode === 'movies' ? kind === 'movie' : kind === 'tv');
}
/** Seerr's Trending feed takes no filters: its titles are kept as they come, by what each says of itself. */
const isTrendingPath = (path: string): boolean => /\/discover\/trending$/.test(path);
/**
 * The request for one page of a feed with the page's filters (`filterQuery`: the `&name=value` pairs the controls give,
 * '' for none). Seerr takes no filters on its upcoming feeds either, so with filters set an upcoming feed is asked as
 * discover from today (`today`, YYYY-MM-DD), which is what its upcoming titles are; a later lower date in the filters is
 * kept. Trending is asked plainly.
 */
function feedRequest(path: string, page: number, filterQuery: string, today: string): string {
    if (!filterQuery || isTrendingPath(path)) return `${path}?page=${page}`;
    const upcoming = /\/discover\/(movies|tv)\/upcoming$/.exec(path);
    if (!upcoming) return `${path}?page=${page}${filterQuery}`;
    const name = upcoming[1] === 'movies' ? 'primaryReleaseDateGte' : 'firstAirDateGte';
    const own = new RegExp(`&${name}=([^&]*)`).exec(filterQuery)?.[1];
    let given = '';
    try { given = own ? decodeURIComponent(own) : ''; } catch { given = ''; }
    const from = given > today ? given : today;
    const rest = filterQuery.replace(new RegExp(`&${name}=[^&]*`, 'g'), '');
    return `${path.replace(/\/upcoming$/, '')}?page=${page}&${name}=${encodeURIComponent(from)}${rest}`;
}

const idleCategory = (): CategoryState => ({
    activeScrollObserver: null, isLoading: false, filtered: false, feeds: [], controller: null,
    yieldStats: { fetched: 0, rendered: 0 }, shown: new Set()
});

(function () {
    'use strict';
    const { JE, P } = recommendationsHost();
    // Resolved once at load: the sidebar node and whether the Plugin Pages link already exists.
    const sidebar = document.querySelector('.mainDrawer-scrollContainer');
    const state: RecommendationsState = {
        pageVisible: false, previousPage: null, currentAbortController: null,
        categoryPageVisible: false, categoryPreviousPage: null, categoryReturnsToPage: false,
        categoryState: idleCategory(), renders: new Map()
    };
    const fetchWithManagedRequest = (path: string, options?: ManagedFetchOptions) =>
        filterOf(JE).fetchWithManagedRequest(path, 'recommendations', options);
    const filters = () => filterOf(JE);

    /** One page of a feed under the page's filters, asked as the feed's kind takes them (none: Trending). */
    async function feedPage(path: string, kind: FeedKind | null | undefined, page: number, options?: ManagedFetchOptions): Promise<FeedPage> {
        const query = kind ? (filters().feedQuery?.(FILTER_MODULE, kind) ?? '') : '';
        // (A genre's category names its genre itself: the other genres are asked, or kept, as routeFeed says.)
        const routed = kind && JE.discoveryFilters?.routeFeed
            ? JE.discoveryFilters.routeFeed(path, kind, filters().getFilters?.(FILTER_MODULE) ?? {}, query)
            : { query, keep: null };
        const answer = decodeFeedPage(await fetchWithManagedRequest(feedRequest(path, page, routed.query, localDay()), options));
        // (A narrowed copy of the answer: the request cache keeps Seerr's own.)
        const keep = routed.keep;
        return keep ? { ...answer, results: answer.results.filter(keep) } : answer;
    }
    /**
     * Titles of a feed that takes no filters (Trending), kept by All | Movies | Series and by the filters a title can be
     * checked against; null when a filter is set that it can't be (runtime, rating, services, keywords), so nothing of
     * it can be said to match.
     */
    function keepLoaded(results: SeerrResult[]): SeerrResult[] | null {
        const selection = filters().getFilters(FILTER_MODULE);
        if (JE.discoveryFilters?.checkableOnLoaded && !JE.discoveryFilters.checkableOnLoaded(selection)) return null;
        return filters().filterByMediaType(filters().keepByFilters(FILTER_MODULE, results), filters().getFilterMode(FILTER_MODULE));
    }
    /** Whether anything narrows the page: a type other than All, or a further filter. */
    const isNarrowed = (): boolean => (filters().getFilterMode?.(FILTER_MODULE) ?? 'mixed') !== 'mixed' || !!filters().hasMoreFilters?.(FILTER_MODULE);
    /** What the rows are filled for: All | Movies | Series and the further filters. */
    const filterSignature = (): string => JSON.stringify([filters().getFilterMode(FILTER_MODULE), filters().getFilters(FILTER_MODULE)]);
    /** Back to everything: All, and no further filter. */
    function clearFilters(): void {
        filters().clearFilters(FILTER_MODULE);
        filters().setFilterMode(FILTER_MODULE, filters().MODES.MIXED);
    }
    /** Whether the page's address holds its filters: on Home (its tab) or on its own page. */
    const addressHoldsFilters = (): boolean => !!JE.discoveryAddress?.isRecommendationsHash(window.location.hash);
    /** One media row's titles under the page's filters: its first page, or for Trending while filters narrow it as many of its first pages as give a row. */
    async function fetchRowResults(row: RowDefinition, signal: AbortSignal): Promise<SeerrResult[]> {
        if (!isTrendingPath(row.path) || !isNarrowed()) return (await feedPage(row.path, row.kind, 1, { signal })).results;
        const kept: SeerrResult[] = [];
        for (let page = 1; page <= TRENDING_FILTERED_PAGES && kept.length < TRENDING_FILTERED_ENOUGH; page++) {
            const answer = decodeFeedPage(await fetchWithManagedRequest(`${row.path}?page=${page}`, { signal }));
            const fit = keepLoaded(answer.results);
            if (fit === null) break;
            kept.push(...fit);
            if (page >= (Number(answer.totalPages) || 1)) break;
        }
        return kept;
    }
    /**
     * The media rows of the kinds All | Movies | Series shows, in parallel, under the page's filters. One failing or empty
     * category never blanks the whole page.
     */
    function fetchAllRows(signal: AbortSignal): Promise<RowResult[]> {
        const mode = filters().getFilterMode?.(FILTER_MODULE) ?? 'mixed';
        const load = async (row: RowDefinition): Promise<RowResult> => {
            try { return { row, results: await fetchRowResults(row, signal), failed: false }; }
            catch { return { row, results: [], failed: true }; }
        };
        return Promise.all(part(P, 'ROWS').filter(row => shownForType(row.kind, mode)).map(load));
    }
    // The genre slider per identity and media type, so switching between the standalone page and
    // the custom tab doesn't re-fetch, and no list outlives the account it was fetched for.
    const genreSliders = new Map<string, { promise: Promise<GenreSliderEntry[]>; retryAt: number }>();
    function fetchGenreSlider(mediaType: FeedKind): Promise<GenreSliderEntry[]> {
        const key = `${identityKey(JE)}|${mediaType}`;
        const cached = genreSliders.get(key);
        if (cached && Date.now() < cached.retryAt) return cached.promise;
        const entry = { promise: Promise.resolve<GenreSliderEntry[]>([]), retryAt: Date.now() + EMPTY_SLIDER_RETRY_MS };
        entry.promise = Promise.resolve()
            .then(() => JE.jellyseerrAPI?.fetchGenreSlider?.(mediaType))
            .then(decodeGenreSlider)
            .catch((): GenreSliderEntry[] => [])
            .then(list => {
                if (list.length > 0) entry.retryAt = Infinity;
                return list;
            });
        genreSliders.set(key, entry);
        return entry.promise;
    }
    /** Ends a container's render and empties it: nothing it held stays in the page. */
    function disposeRender(container: HTMLElement): void {
        const owner = state.renders.get(container);
        if (!owner) return;
        state.renders.delete(container);
        owner.controller.abort();
        if (state.currentAbortController === owner.controller) state.currentAbortController = null;
        owner.disposers.splice(0).forEach(stop => stop());
        JE.jellyseerrUI?.releasePosters?.(container);
        container.replaceChildren();
    }
    /** A host may drop its container without telling us (Plugin Pages): nothing outlives it. */
    function sweepRenders(): void {
        for (const container of [...state.renders.keys()]) if (!container.isConnected) disposeRender(container);
    }
    /** Cards carry per-user availability and request state: none of it reaches the next identity. */
    function resetIdentity(): void {
        P.hideCategoryPage?.();
        P.hidePage?.();
        for (const container of [...state.renders.keys()]) disposeRender(container);
        genreSliders.clear();
        P.MOVIE_GENRES = [];
        P.TV_GENRES = [];
        JE.discoveryFilter?.resetFilterMode(FILTER_MODULE);
        JE.discoveryFilter?.resetSortMode(SORT_MODULE);
    }
    JE.session?.onUserChange('recommendations-page', resetIdentity);

    P.logPrefix = LOG_PREFIX;
    P.sidebar = sidebar;
    P.pluginPagesExists = !!sidebar?.querySelector(PLUGIN_PAGE_LINK);
    P.state = state;
    P.fetchWithManagedRequest = fetchWithManagedRequest;
    P.localDay = localDay;
    P.shownForType = shownForType;
    P.isTrendingPath = isTrendingPath;
    P.feedRequest = feedRequest;
    P.feedPage = feedPage;
    P.keepLoaded = keepLoaded;
    P.isNarrowed = isNarrowed;
    P.filterSignature = filterSignature;
    P.clearFilters = clearFilters;
    P.addressHoldsFilters = addressHoldsFilters;
    P.fetchAllRows = fetchAllRows;
    P.fetchGenreSlider = fetchGenreSlider;
    P.disposeRender = disposeRender;
    P.sweepRenders = sweepRenders;
})();
