// /js/jellyseerr/discovery/discovery-filter-utils.js
// Shared utilities for the discovery sections, published as JE.discoveryFilter.
import { discoveryHost, type SeerrDiscoveryHost } from '../host-discovery';
import { createCardRendering } from './card-rendering';
import { applyFilterVisibility, createControls, injectFilterStyles } from './controls';
import {
    filterByMediaType, FILTER_MODES, hasBothTypes, interleaveArrays, resultHasBothTypes, SORT_OPTIONS
} from './domain';
import { createGenreListFetch, createManagedFetch } from './managed-fetch';
import { createPageReady } from './page-ready';
import { createSessionCacheFactory } from './session-cache';
import type { DiscoveryFilterFacade } from './types';

/** Assembles the facade from its explicit parts. */
function createDiscoveryFilter(JE: SeerrDiscoveryHost, client: ReturnType<typeof discoveryHost>['api']): DiscoveryFilterFacade {
    const storage = () => window.sessionStorage;
    const now = () => Date.now();
    const fetchWithManagedRequest = createManagedFetch(JE, client);
    return {
        MODES: FILTER_MODES, SORT_OPTIONS,
        ...createControls(JE),
        interleaveArrays, filterByMediaType,
        hasBothTypes, resultHasBothTypes,
        fetchWithManagedRequest,
        fetchTmdbGenreList: createGenreListFetch(JE, { storage, now, fetchWithManagedRequest }),
        createSessionCache: createSessionCacheFactory({
            storage, now, userId: () => JE.session?.getUserId?.(), serverId: () => JE.session?.getServerId?.()
        }),
        ...createCardRendering(JE),
        waitForPageReady: createPageReady(JE),
        setupInfiniteScroll(state, selector, loadMore, hasMore, isLoading, options) {
            JE.seamlessScroll?.setupInfiniteScroll(state, selector, loadMore, hasMore, isLoading, options);
        },
        cleanupScrollObserver(state) { JE.seamlessScroll?.cleanupInfiniteScroll(state); },
        applyFilterVisibility
    };
}

(function () {
    'use strict';
    const { JE, api } = discoveryHost();
    injectFilterStyles();
    JE.discoveryFilter = createDiscoveryFilter(JE, api);
})();
