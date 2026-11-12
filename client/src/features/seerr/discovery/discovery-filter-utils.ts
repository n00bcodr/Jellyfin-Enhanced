// /js/jellyseerr/discovery/discovery-filter-utils.js
// Shared utilities for the discovery sections, published as JE.discoveryFilter, and the sections' parts
// every discovery entry reads at call time, published in upstream's load order before it:
// JE.discoveryStyles, JE.discoveryBusy, JE.discoveryMenu, JE.discoveryRoles, JE.discoverySection and
// JE.discoveryFilters (one copy each: their state lives only here).
import { discoveryHost, type SeerrDiscoveryHost } from '../host-discovery';
import { createDiscoveryBusy } from './busy';
import { createCardRendering } from './card-rendering';
import { injectDiscoveryStyles } from './discovery-styles';
import { createFilterPanel } from './filter-panel';
import { createDiscoveryMenu } from './menu';
import { createDiscoveryRoles } from './roles';
import { createSay } from './say';
import { createDiscoverySection } from './section';
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
    const label = createSay(JE);
    // (The scroll engine's retry row uses the sections' stylesheet outside the sections too.)
    injectDiscoveryStyles();
    JE.discoveryStyles = { inject: injectDiscoveryStyles };
    JE.discoveryBusy = createDiscoveryBusy();
    JE.discoveryMenu = createDiscoveryMenu(JE);
    JE.discoveryRoles = createDiscoveryRoles(label);
    JE.discoverySection = createDiscoverySection(JE);
    JE.discoveryFilters = createFilterPanel(JE, label);
    injectFilterStyles();
    JE.discoveryFilter = createDiscoveryFilter(JE, api);
})();
