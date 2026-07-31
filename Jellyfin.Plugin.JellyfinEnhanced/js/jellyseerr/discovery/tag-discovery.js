// @ts-check
// /js/jellyseerr/discovery/tag-discovery.js
// Adds "More [Tag]" section to tag list pages using Seerr API.
// Dual-feed spec over JE.discoveryBase — the base owns the TV/movie
// pagination, filter/sort controls, infinite scroll, dedup and lifecycle
// wiring; this module keeps the tag → TMDB-keyword resolution. Both feeds
// share the same keyword id.
(function(JE) {
    'use strict';

    const keywordIdCache = new Map();

    // Alias for shared utilities
    const fetchWithManagedRequest = (path, options) =>
        JE.discoveryFilter.fetchWithManagedRequest(path, 'tag', options);

    /**
     * Extracts tag name from the current URL
     * @returns {string|null} The tag name or null if not on a tag page
     */
    function getTagFromUrl() {
        const hash = window.location.hash;
        if (!hash.includes('/list') || !hash.includes('type=tag') || !hash.includes('tag=')) {
            return null;
        }
        try {
            const params = new URLSearchParams(hash.split('?')[1]);
            if (params.get('type') !== 'tag') return null;
            return decodeURIComponent(params.get('tag') || '');
        } catch (error) {
            return null;
        }
    }

    /**
     * Searches for TMDB keyword ID by name (cached)
     * @param {string} tagName
     * @param {AbortSignal} [signal]
     */
    async function searchTmdbKeyword(tagName, signal) {
        const cacheKey = tagName.toLowerCase().trim();
        if (keywordIdCache.has(cacheKey)) {
            return keywordIdCache.get(cacheKey);
        }

        try {
            if (signal?.aborted) {
                throw new DOMException('Aborted', 'AbortError');
            }

            const response = await fetchWithManagedRequest(
                `/JellyfinEnhanced/tmdb/search/keyword?query=${encodeURIComponent(tagName)}`,
                { signal }
            );

            if (signal?.aborted) {
                throw new DOMException('Aborted', 'AbortError');
            }

            if (response?.results?.length > 0) {
                const exactMatch = response.results.find(r =>
                    r.name.toLowerCase() === tagName.toLowerCase()
                );
                const keywordId = exactMatch ? exactMatch.id : response.results[0].id;
                keywordIdCache.set(cacheKey, keywordId);
                return keywordId;
            }
        } catch (error) {
            if (error.name === 'AbortError') throw error;
            // Silent fail
        }

        return null;
    }

    /**
     * Resolves the TMDB keyword id (used for both feeds) + section title.
     * @param {{id: string, signal: AbortSignal}} ctx
     * @returns {Promise<{tvId: number, movieId: number, title: string}|null>}
     */
    async function resolveFeeds({ id: tagName, signal }) {
        const status = await JE.jellyseerrAPI?.checkUserStatus();

        if (signal.aborted) return null;

        if (!status?.active) return null;

        // Search for TMDB keyword
        const keywordId = await searchTmdbKeyword(tagName, signal);
        if (signal.aborted) return null;

        if (!keywordId) return null;

        return {
            tvId: keywordId,
            movieId: keywordId,
            title: JE.t('discovery_more_with_tag', { tag: tagName })
        };
    }

    const discovery = JE.discoveryBase.createDiscovery({
        key: 'tag',
        mode: 'dual-feed',
        logLabel: 'Tag Discovery',
        configKey: 'JellyseerrShowTagDiscovery',
        getIdFromUrl: getTagFromUrl,
        resolveFeeds,
        buildDiscoverPath: (kind, id) => kind === 'tv'
            ? `/JellyfinEnhanced/jellyseerr/discover/tv/keyword/${id}`
            : `/JellyfinEnhanced/jellyseerr/discover/movies/keyword/${id}`
    });

    discovery.start();

})(window.JellyfinEnhanced);
