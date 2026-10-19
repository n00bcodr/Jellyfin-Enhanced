// @ts-check
// /js/jellyseerr/discovery/genre-discovery.js
// Adds "More [Genre]" section to genre list pages using Seerr API.
// Dual-feed spec over JE.discoveryBase — the base owns the TV/movie
// pagination, filter/sort controls, infinite scroll, dedup and lifecycle
// wiring; this module keeps the Jellyfin-genre → TMDB-genre resolution.
// A genre the viewer's library doesn't offer (linked from a native details
// page of a title not in the library) has a synthetic id that carries its
// TMDB genre id; its list page holds nothing else, the row is its content.
// Its feeds come from the server's native-details discovery route, filtered
// there for the viewer (no Seerr account needed).
(function(JE) {
    'use strict';

    // Jellyfin genre id -> genre info ({id, name, type}); kept for the tab,
    // per user (see JE.discoveryFilter.createSessionCache).
    const genreInfoCache = JE.discoveryFilter.createSessionCache('genre-info',
        (v) => !!v && typeof v === 'object' && typeof v.name === 'string');

    // Dynamic genre cache (populated from TMDB API)
    let tmdbGenreCache = null;

    // Alias for shared utilities
    const fetchWithManagedRequest = (path, options) =>
        JE.discoveryFilter.fetchWithManagedRequest(path, 'genre', options);

    /**
     * Fetches TMDB genre lists and caches them. Normally already prefetched at
     * startup or kept in sessionStorage (JE.discoveryFilter.fetchTmdbGenreList).
     * @param {AbortSignal} [signal] - Optional abort signal
     * @param {boolean} [native] - Read them from the server's native route (no Seerr account)
     */
    async function fetchTmdbGenres(signal, native = false) {
        if (tmdbGenreCache) return tmdbGenreCache;

        try {
            if (signal?.aborted) {
                throw new DOMException('Aborted', 'AbortError');
            }

            const fetchOptions = { signal, native };
            const [tvResponse, movieResponse] = await Promise.all([
                JE.discoveryFilter.fetchTmdbGenreList('tv', fetchOptions).catch(() => []),
                JE.discoveryFilter.fetchTmdbGenreList('movie', fetchOptions).catch(() => [])
            ]);

            if (signal?.aborted) {
                throw new DOMException('Aborted', 'AbortError');
            }

            // Build lookup map by genre name (lowercase for matching)
            const cache = {};
            (tvResponse || []).forEach(g => {
                const key = g.name.toLowerCase();
                if (!cache[key]) cache[key] = { tv: null, movie: null };
                cache[key].tv = g.id;
            });
            (movieResponse || []).forEach(g => {
                const key = g.name.toLowerCase();
                if (!cache[key]) cache[key] = { tv: null, movie: null };
                cache[key].movie = g.id;
            });

            // An empty answer (a list that couldn't be read) is not kept: the next page asks again.
            if (Object.keys(cache).length) tmdbGenreCache = cache;
            return cache;
        } catch (error) {
            if (error.name === 'AbortError') throw error;
            return {};
        }
    }

    /**
     * The TMDB genre id a synthetic genre id carries (see js/jellyseerr/nativedetails), or 0.
     * @param {string} genreId
     * @returns {number}
     */
    function syntheticGenreTmdb(genreId) {
        const parts = JE.titleDetails?.parse?.(genreId);
        return parts && parts.kind === 'genre' ? parts.tmdbId : 0;
    }

    /**
     * Gets genre information from Jellyfin
     * @param {string} genreId
     * @param {AbortSignal} [signal]
     * @returns {Promise<Object|null>} Genre info object or null
     */
    async function getGenreInfo(genreId, signal) {
        const cache = genreInfoCache.scope();
        if (cache.has(genreId)) {
            return cache.get(genreId);
        }
        try {
            if (signal?.aborted) {
                throw new DOMException('Aborted', 'AbortError');
            }

            // A synthetic genre: its name is the page's own item (JE's genre route knows library genres only).
            const response = syntheticGenreTmdb(genreId)
                ? await ApiClient.getItem(ApiClient.getCurrentUserId(), genreId).then(item => (item?.Name ? { name: item.Name } : null))
                : await fetchWithManagedRequest(`/JellyfinEnhanced/genre/${genreId}`, { signal });

            if (signal?.aborted) {
                throw new DOMException('Aborted', 'AbortError');
            }

            if (response) {
                cache.set(genreId, response);
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
     * @param {boolean} [native] - Genre lists from the server's native route
     * @returns {Promise<{tv: number|null, movie: number|null}|null>} Genre IDs or null
     */
    async function getTmdbGenreIds(genreName, signal, native = false) {
        const cacheKey = genreName.toLowerCase().trim();
        const genres = await fetchTmdbGenres(signal, native);

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
        // Fetch genre info and user status in parallel
        const genreInfoPromise = getGenreInfo(genreId, signal);
        const statusPromise = JE.jellyseerrAPI?.checkUserStatus();

        const [genreInfo, status] = await Promise.all([genreInfoPromise, statusPromise]);

        if (signal.aborted) return null;

        if (!status?.active || !genreInfo?.name) return null;
        // No Seerr account (Jellyfin Enhanced request mode): the server's native feeds, filtered there.
        const nativeFeeds = !!JE.discoveryFilter.useNativeFeeds?.(status);
        if (status.userFound === false && !nativeFeeds && !syntheticGenreTmdb(genreId)) return null;

        let tmdbGenreIds = await getTmdbGenreIds(genreInfo.name, signal, nativeFeeds || !!syntheticGenreTmdb(genreId) && status.userFound === false);
        if (signal.aborted) return null;

        // A synthetic genre names its TMDB id: that id for the media type whose list has it
        // (both when the lists can't be read: a feed of the other type's id is just empty).
        const direct = syntheticGenreTmdb(genreId);
        if (direct) {
            const known = Object.values(await fetchTmdbGenres(signal, status.userFound === false) || {});
            const movie = known.some(g => g.movie === direct) ? direct : null;
            const tv = known.some(g => g.tv === direct) ? direct : null;
            tmdbGenreIds = known.length === 0
                ? { movie: direct, tv: direct }
                : { movie: movie || tmdbGenreIds?.movie || null, tv: tv || tmdbGenreIds?.tv || null };
        }

        if (!tmdbGenreIds || (!tmdbGenreIds.tv && !tmdbGenreIds.movie)) return null;

        return {
            tvId: tmdbGenreIds.tv,
            movieId: tmdbGenreIds.movie,
            native: !!direct || nativeFeeds,
            title: JE.t('discovery_more_with_genre', { genre: genreInfo.name })
        };
    }

    const discovery = JE.discoveryBase.createDiscovery({
        key: 'genre',
        mode: 'dual-feed',
        logLabel: 'Genre Discovery',
        configKey: 'JellyseerrShowGenreDiscovery',
        getIdFromUrl: JE.discoveryBase.idFromListParam('genreId'),
        // A synthetic genre's page lists nothing of the library's own: this row is its only list of titles,
        // library titles included (as a synthetic person's filmography).
        keepLibraryItems: (id) => syntheticGenreTmdb(id) > 0,
        resolveFeeds,
        buildDiscoverPath: (kind, id, feeds) => {
            // A synthetic genre's page, or a viewer without a Seerr account: the server filters the feeds for the viewer.
            if (feeds?.native) return `/JellyfinEnhanced/native-details/discover/${kind === 'tv' ? 'tv' : 'movie'}/genre/${id}`;
            return kind === 'tv'
                ? `/JellyfinEnhanced/jellyseerr/discover/tv/genre/${id}`
                : `/JellyfinEnhanced/jellyseerr/discover/movies/genre/${id}`;
        }
    });

    discovery.start();

})(window.JellyfinEnhanced);
