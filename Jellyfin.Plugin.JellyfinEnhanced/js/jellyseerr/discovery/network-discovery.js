// @ts-check
// /js/jellyseerr/discovery/network-discovery.js
// Adds "More from [Network]" section to studio/network list pages using
// Seerr API. Dual-feed spec over JE.discoveryBase — the base owns the
// TV/movie pagination, filter/sort controls, infinite scroll, dedup and
// lifecycle wiring; this module keeps the studio → TMDB network/company
// resolution (known-network map + company search scoring).
(function(JE) {
    'use strict';

    // Cache for network ID mappings (studioName -> TMDB networkId)
    const networkIdCache = new Map();

    // Cache for studio info (studioId -> studioInfo)
    const studioInfoCache = new Map();

    // Alias for shared utilities
    const fetchWithManagedRequest = (path, options) =>
        JE.discoveryFilter.fetchWithManagedRequest(path, 'network', options);

    // TMDB TV Network IDs (these are different from company/studio IDs)
    const TV_NETWORKS = {
        'netflix': 213,
        'hbo': 49,
        'hbo max': 3186,
        'max': 3186,
        'amazon': 1024,
        'amazon prime video': 1024,
        'prime video': 1024,
        'apple tv+': 2552,
        'apple tv': 2552,
        'disney+': 2739,
        'disney plus': 2739,
        'hulu': 453,
        'paramount+': 4330,
        'paramount plus': 4330,
        'peacock': 3353,
        'fx': 88,
        'fx networks': 88,
        'amc': 174,
        'showtime': 67,
        'starz': 318,
        'abc': 2,
        'nbc': 6,
        'cbs': 16,
        'fox': 19,
        'the cw': 71,
        'cw': 71,
        'bbc': 4,
        'bbc one': 4,
        'bbc two': 332,
        'itv': 9,
        'channel 4': 26,
        'sky': 1063,
        'syfy': 77,
        'usa network': 30,
        'tnt': 41,
        'tbs': 68,
        'a&e': 129,
        'history': 65,
        'discovery': 64,
        'national geographic': 43,
        'nat geo': 43,
        'adult swim': 80,
        'cartoon network': 56,
        'nickelodeon': 13,
        'comedy central': 47,
        'mtv': 33,
        'bet': 24,
        'espn': 29,
        'crunchyroll': 1112,
        'anime network': 171,
        'funimation': 102,
        'youtube': 247,
        'youtube premium': 1436
    };

    /**
     * Gets studio information from Jellyfin (with caching)
     * @param {string} studioId
     * @param {AbortSignal} [signal]
     */
    async function getStudioInfo(studioId, signal) {
        if (studioInfoCache.has(studioId)) {
            return studioInfoCache.get(studioId);
        }

        try {
            if (signal?.aborted) {
                throw new DOMException('Aborted', 'AbortError');
            }

            const response = await fetchWithManagedRequest(`/JellyfinEnhanced/studio/${studioId}`, { signal });

            if (signal?.aborted) {
                throw new DOMException('Aborted', 'AbortError');
            }

            if (response) {
                studioInfoCache.set(studioId, response);
            }
            return response;
        } catch (error) {
            if (error.name === 'AbortError') throw error;
            return null;
        }
    }

    /**
     * Gets TMDB TV network ID from known networks list
     * @param {string} networkName - Name of the network to look up
     * @returns {number|null} TMDB network ID or null if not found
     */
    function getKnownNetworkId(networkName) {
        const key = networkName.toLowerCase().trim();
        if (TV_NETWORKS[key]) return TV_NETWORKS[key];

        for (const [name, id] of Object.entries(TV_NETWORKS)) {
            if (key.includes(name) || name.includes(key)) {
                return id;
            }
        }
        return null;
    }

    /**
     * Gets TMDB company ID by searching TMDB (for movie studios)
     * @param {string} networkName
     * @param {AbortSignal} [signal]
     */
    async function searchTmdbCompany(networkName, signal) {
        const cacheKey = networkName.toLowerCase().trim();

        if (networkIdCache.has(cacheKey)) {
            return networkIdCache.get(cacheKey);
        }

        try {
            if (signal?.aborted) {
                throw new DOMException('Aborted', 'AbortError');
            }

            const response = await fetchWithManagedRequest(
                `/JellyfinEnhanced/tmdb/search/company?query=${encodeURIComponent(networkName)}`,
                { signal }
            );

            if (signal?.aborted) {
                throw new DOMException('Aborted', 'AbortError');
            }

            if (response?.results?.length > 0) {
                // Filter to exact name matches first
                const exactMatches = response.results.filter(r =>
                    r.name.toLowerCase() === networkName.toLowerCase()
                );

                // Score matches: prefer US origin + logo, then US origin, then any logo
                const scored = (exactMatches.length > 0 ? exactMatches : response.results).map(r => ({
                    ...r,
                    score: (r.origin_country === 'US' ? 2 : 0) + (r.logo_path ? 1 : 0)
                }));

                // Sort by score descending, pick highest
                scored.sort((a, b) => b.score - a.score);

                if (scored.length === 0) return null;
                const companyId = scored[0].id;

                networkIdCache.set(cacheKey, companyId);
                return companyId;
            }
        } catch (error) {
            if (error.name === 'AbortError') throw error;
            // Silent fail
        }

        return null;
    }

    /**
     * Resolves the TMDB TV network / movie company feed ids + section title.
     * @param {{id: string, signal: AbortSignal}} ctx
     * @returns {Promise<{tvId: number|null, movieId: number|null, title: string}|null>}
     */
    async function resolveFeeds({ id: studioId, signal }) {
        const studioInfoPromise = getStudioInfo(studioId, signal);
        const statusPromise = JE.jellyseerrAPI?.checkUserStatus();

        const [studioInfo, status] = await Promise.all([studioInfoPromise, statusPromise]);

        if (signal.aborted) return null;

        if (!status?.active || !studioInfo?.name) return null;

        // TV network IDs are different from company IDs in TMDB
        // Always use name lookup for TV networks
        const tvNetworkId = getKnownNetworkId(studioInfo.name);

        // For movie studios, use stored tmdbId if available, otherwise search
        const companyId = studioInfo.tmdbId
            ? parseInt(studioInfo.tmdbId)
            : await searchTmdbCompany(studioInfo.name, signal);

        if (signal.aborted) return null;

        if (!tvNetworkId && !companyId) return null;

        return {
            tvId: tvNetworkId,
            movieId: companyId,
            title: JE.t('discovery_more_from_studio', { studio: studioInfo.name })
        };
    }

    const discovery = JE.discoveryBase.createDiscovery({
        key: 'network',
        mode: 'dual-feed',
        logLabel: 'Network Discovery',
        configKey: 'JellyseerrShowNetworkDiscovery',
        // Unlike the other discovery sections, network discovery is opt-in.
        defaultEnabled: false,
        getIdFromUrl: JE.discoveryBase.idFromListParam('studioId'),
        // Historical page-key format: no 'network-' prefix.
        pageKey: (id) => `${id}-${window.location.hash}`,
        resolveFeeds,
        buildDiscoverPath: (kind, id) => kind === 'tv'
            ? `/JellyfinEnhanced/jellyseerr/discover/tv/network/${id}`
            : `/JellyfinEnhanced/jellyseerr/discover/movies/studio/${id}`
    });

    discovery.start();

})(window.JellyfinEnhanced);
