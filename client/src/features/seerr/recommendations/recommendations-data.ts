// /js/jellyseerr/recommendations/recommendations-data.js
// Recommendations Page: shared state, Seerr fetch helpers and the identity reset.
import { filterOf, identityKey } from '../host-discovery';
import { decodeFeedPage, decodeGenreSlider } from '../discovery/domain';
import type { FeedKind, GenreSliderEntry, ManagedFetchOptions } from '../discovery/types';
import { FILTER_MODULE, LOG_PREFIX, part, PLUGIN_PAGE_LINK, recommendationsHost, SORT_MODULE } from './stage';
import type { CategoryState, RecommendationsState, RowDefinition, RowResult } from './types';

/** A failed (or empty) slider is retried after this, so one outage can't blank genres until a reload. */
const EMPTY_SLIDER_RETRY_MS = 60 * 1000;

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

    /** All media rows in parallel. One failing or empty category never blanks the whole page. */
    function fetchAllRows(signal: AbortSignal): Promise<RowResult[]> {
        const load = async (row: RowDefinition): Promise<RowResult> => {
            try {
                return { row, results: decodeFeedPage(await fetchWithManagedRequest(`${row.path}?page=1`, { signal })).results, failed: false };
            } catch { return { row, results: [], failed: true }; }
        };
        return Promise.all(part(P, 'ROWS').map(load));
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
    P.fetchAllRows = fetchAllRows;
    P.fetchGenreSlider = fetchGenreSlider;
    P.disposeRender = disposeRender;
    P.sweepRenders = sweepRenders;
})();
