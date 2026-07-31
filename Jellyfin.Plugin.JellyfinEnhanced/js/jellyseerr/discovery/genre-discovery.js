// @ts-check
// /js/jellyseerr/discovery/genre-discovery.js
// Adds "More [Genre]" section to genre list pages using Seerr API.
// Dual-feed spec over JE.discoveryBase — the base owns the TV/movie
// pagination, filter/sort controls, infinite scroll, dedup and lifecycle
// wiring; this module keeps the Jellyfin-genre → TMDB-genre resolution.
(function(JE) {
    'use strict';

    const genreInfoCache = new Map();

    // Dynamic genre cache (populated from TMDB API)
    let tmdbGenreCache = null;

    // Alias for shared utilities
    const fetchWithManagedRequest = (path, options) =>
        JE.discoveryFilter.fetchWithManagedRequest(path, 'genre', options);

    /**
     * Fetches TMDB genre lists and caches them
     * @param {AbortSignal} [signal] - Optional abort signal
     */
    async function fetchTmdbGenres(signal) {
        if (tmdbGenreCache) return tmdbGenreCache;

        try {
            if (signal?.aborted) {
                throw new DOMException('Aborted', 'AbortError');
            }

            const fetchOptions = { signal };
            const [tvResponse, movieResponse] = await Promise.all([
                fetchWithManagedRequest('/JellyfinEnhanced/tmdb/genres/tv', fetchOptions).catch(() => []),
                fetchWithManagedRequest('/JellyfinEnhanced/tmdb/genres/movie', fetchOptions).catch(() => [])
            ]);

            if (signal?.aborted) {
                throw new DOMException('Aborted', 'AbortError');
            }

            // Build lookup map by genre name (lowercase for matching)
            tmdbGenreCache = {};
            (tvResponse || []).forEach(g => {
                const key = g.name.toLowerCase();
                if (!tmdbGenreCache[key]) tmdbGenreCache[key] = { tv: null, movie: null };
                tmdbGenreCache[key].tv = g.id;
            });
            (movieResponse || []).forEach(g => {
                const key = g.name.toLowerCase();
                if (!tmdbGenreCache[key]) tmdbGenreCache[key] = { tv: null, movie: null };
                tmdbGenreCache[key].movie = g.id;
            });

            return tmdbGenreCache;
        } catch (error) {
            if (error.name === 'AbortError') throw error;
            return {};
        }
    }

    /**
     * Gets genre information from Jellyfin
     * @param {string} genreId
     * @param {AbortSignal} [signal]
     * @returns {Promise<Object|null>} Genre info object or null
     */
    async function getGenreInfo(genreId, signal) {
        if (genreInfoCache.has(genreId)) {
            return genreInfoCache.get(genreId);
        }
        try {
            if (signal?.aborted) {
                throw new DOMException('Aborted', 'AbortError');
            }

            const response = await fetchWithManagedRequest(`/JellyfinEnhanced/genre/${genreId}`, { signal });

            if (signal?.aborted) {
                throw new DOMException('Aborted', 'AbortError');
            }

            if (response) {
                genreInfoCache.set(genreId, response);
            }
            return response;
        } catch (error) {
            if (error.name === 'AbortError') throw error;
            return null;
        }
    }

    /**
     * Gets TMDB genre IDs from genre name (fetches from TMDB API)
     * @param {string} genreName
     * @param {AbortSignal} [signal]
     * @returns {Promise<{tv: number|null, movie: number|null}|null>} Genre IDs or null
     */
    async function getTmdbGenreIds(genreName, signal) {
        const cacheKey = genreName.toLowerCase().trim();
        const genres = await fetchTmdbGenres(signal);

        // Start with exact match result (if any)
        const result = { tv: null, movie: null };

        if (genres[cacheKey]) {
            result.tv = genres[cacheKey].tv;
            result.movie = genres[cacheKey].movie;
        }

        // Also check partial matches and merge (e.g., "adventure" also matches "action & adventure")
        // This handles cases where TV and Movie genres have different names
        for (const [key, ids] of Object.entries(genres)) {
            if (key === cacheKey) continue; // Skip exact match already processed
            if (cacheKey.includes(key) || key.includes(cacheKey)) {
                // Merge: only fill in missing IDs
                if (!result.tv && ids.tv) result.tv = ids.tv;
                if (!result.movie && ids.movie) result.movie = ids.movie;
            }
        }

        // Return null if nothing found
        if (!result.tv && !result.movie) return null;
        return result;
    }

    /**
     * Resolves the TMDB genre feed ids + section title for the base.
     * @param {{id: string, signal: AbortSignal}} ctx
     * @returns {Promise<{tvId: number|null, movieId: number|null, title: string}|null>}
     */
    async function resolveFeeds({ id: genreId, signal }) {
        // Fetch genre info, user status and TMDB genres in parallel
        const genreInfoPromise = getGenreInfo(genreId, signal);
        const statusPromise = JE.jellyseerrAPI?.checkUserStatus();
        const tmdbGenresPromise = fetchTmdbGenres(signal);

        const [genreInfo, status] = await Promise.all([genreInfoPromise, statusPromise, tmdbGenresPromise]);

        if (signal.aborted) return null;

        if (!status?.active || !genreInfo?.name) return null;

        // TMDB genres are already cached from the parallel fetch above
        const tmdbGenreIds = await getTmdbGenreIds(genreInfo.name, signal);
        if (signal.aborted) return null;

        if (!tmdbGenreIds || (!tmdbGenreIds.tv && !tmdbGenreIds.movie)) return null;

        return {
            tvId: tmdbGenreIds.tv,
            movieId: tmdbGenreIds.movie,
            title: JE.t('discovery_more_with_genre', { genre: genreInfo.name })
        };
    }

    const discovery = JE.discoveryBase.createDiscovery({
        key: 'genre',
        mode: 'dual-feed',
        logLabel: 'Genre Discovery',
        configKey: 'JellyseerrShowGenreDiscovery',
        getIdFromUrl: JE.discoveryBase.idFromListParam('genreId'),
        resolveFeeds,
        buildDiscoverPath: (kind, id) => kind === 'tv'
            ? `/JellyfinEnhanced/jellyseerr/discover/tv/genre/${id}`
            : `/JellyfinEnhanced/jellyseerr/discover/movies/genre/${id}`
    });

    discovery.start();

})(window.JellyfinEnhanced);
