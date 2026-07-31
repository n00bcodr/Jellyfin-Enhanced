/**
 * @file Details-page release/air-date chip resolved from TMDB via the plugin proxy.
 * Split from features.js (code motion; bodies verbatim).
 */
(function(JE) {
    'use strict';

    JE.internals = JE.internals || {};
    const internal = JE.internals.features = JE.internals.features || {};

    const RELEASEDATE_CACHE_TTL = 60 * 60 * 1000; // 1 hour
    const releaseDateCache = new Map(); // Map<itemId, { infos: Array<{date, icon, titleKey}>, ts: number }>

    /**
     * Fetches a path from TMDB via the plugin's proxy endpoint.
     * @param {string} path TMDB API path, e.g. `/movie/{id}/release_dates`.
     * @returns {Promise<object|null>}
     */
    function tmdbGet(path) {
        const url = ApiClient.getUrl(`/JellyfinEnhanced/tmdb${path}`);
        // Jellyfin 12 authenticates from the Authorization header; the legacy
        // X-Emby-Token is kept for 10.11 back-compat.
        return fetch(url, { headers: { "Authorization": `MediaBrowser Token="${ApiClient.accessToken()}"`, "X-Emby-Token": ApiClient.accessToken() } })
            .then(r => r.ok ? r.json() : Promise.reject(`API Error: ${r.status}`))
            .catch(error => {
                console.error(`🪼 Jellyfin Enhanced: Release Date: TMDB request failed for ${path}`, error);
                return null;
            });
    }

    function todayIso() {
        return new Date().toISOString().slice(0, 10);
    }

    function formatReleaseDate(dateStr) {
        const d = new Date(dateStr);
        if (isNaN(d.getTime())) return dateStr;
        return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    }

    // TMDB /movie/{id}/release_dates `type` values, bucketed into the three
    // distinct release moments we show, in chronological display order.
    // Theatrical premiere(1)/limited(2)/wide(3) collapse into one "cinema"
    // bucket (earliest of the three) so a movie doesn't show three near-
    // identical theatrical chips; digital(4) and physical(5) stay separate.
    const MOVIE_RELEASE_BUCKETS = [
        { types: [1, 2, 3], icon: 'local_movies', titleKey: 'calendar_cinema_release' },
        { types: [4], icon: 'ondemand_video', titleKey: 'calendar_digital_release' },
        { types: [5], icon: 'album', titleKey: 'calendar_physical_release' },
    ];

    /** Returns the earliest `release_date` among entries of the given bucket's types, or null. */
    function earliestOfBucket(releaseDates, bucket) {
        const matches = (releaseDates || []).filter(d => bucket.types.includes(d.type) && d.release_date);
        if (matches.length === 0) return null;
        return matches.reduce((a, b) => (a.release_date < b.release_date ? a : b));
    }

    /**
     * Resolves every known release date for a movie (cinema/digital/physical,
     * whichever TMDB has). Each bucket is resolved independently, cascading
     * through the configured region, then US, then any region at all that
     * has that type. This matters because most countries only ever record a
     * single release type (often just theatrical) — locking the whole movie
     * to one region's entry would silently drop digital/physical dates that
     * TMDB has recorded under a different country.
     * @returns {Promise<Array<{date: string, icon: string, titleKey: string}>>}
     */
    async function getMovieReleaseInfo(tmdbId) {
        const data = await tmdbGet(`/movie/${tmdbId}/release_dates`);
        const results = data?.results;
        if (!Array.isArray(results) || results.length === 0) return [];

        const region = (JE.pluginConfig?.DEFAULT_REGION || 'US').toUpperCase();
        const preferredOrder = [region, 'US'].filter((iso, i, arr) => iso && arr.indexOf(iso) === i);

        const infos = [];
        for (const bucket of MOVIE_RELEASE_BUCKETS) {
            let earliest = null;
            for (const iso of preferredOrder) {
                const entry = results.find(r => r.iso_3166_1 === iso);
                earliest = entry && earliestOfBucket(entry.release_dates, bucket);
                if (earliest) break;
            }
            if (!earliest) {
                for (const entry of results) {
                    earliest = earliestOfBucket(entry.release_dates, bucket);
                    if (earliest) break;
                }
            }
            if (earliest) infos.push({ date: earliest.release_date, icon: bucket.icon, titleKey: bucket.titleKey });
        }
        return infos;
    }

    /** Resolves the next (or, if none, most recent) episode air date for a series. */
    async function getSeriesReleaseInfo(tmdbId) {
        const data = await tmdbGet(`/tv/${tmdbId}`);
        const date = data?.next_episode_to_air?.air_date || data?.last_episode_to_air?.air_date;
        return date ? [{ date, icon: 'tv_guide', titleKey: 'calendar_episode' }] : [];
    }

    /** Resolves the next (or, if none, most recent) episode air date within a season. */
    async function getSeasonReleaseInfo(tmdbId, seasonNumber) {
        const data = await tmdbGet(`/tv/${tmdbId}/season/${seasonNumber}`);
        const episodes = data?.episodes;
        if (!Array.isArray(episodes) || episodes.length === 0) return [];

        const withDates = episodes.filter(e => e.air_date);
        if (withDates.length === 0) return [];

        const today = todayIso();
        const upcoming = withDates.find(e => e.air_date >= today);
        const date = (upcoming || withDates[withDates.length - 1]).air_date;
        return [{ date, icon: 'tv_guide', titleKey: 'calendar_episode' }];
    }

    /** Resolves a single episode's air date. */
    async function getEpisodeReleaseInfo(tmdbId, seasonNumber, episodeNumber) {
        const data = await tmdbGet(`/tv/${tmdbId}/season/${seasonNumber}/episode/${episodeNumber}`);
        return data?.air_date ? [{ date: data.air_date, icon: 'tv_guide', titleKey: 'calendar_episode' }] : [];
    }

    /**
     * Resolves release/air date info for an item, branching on Jellyfin item
     * type. Season/Episode look up the series' TMDB ID (preferring
     * SeriesProviderIds, falling back to fetching the series item) the same
     * way reviews.js does for TMDB reviews.
     * @returns {Promise<Array<{date: string, icon: string, titleKey: string}>>}
     */
    async function resolveReleaseInfo(item, userId) {
        const mediaType = item?.Type;

        if (mediaType === 'Movie') {
            const tmdbId = item?.ProviderIds?.Tmdb;
            return tmdbId ? getMovieReleaseInfo(tmdbId) : [];
        }

        if (mediaType === 'Series') {
            const tmdbId = item?.ProviderIds?.Tmdb;
            return tmdbId ? getSeriesReleaseInfo(tmdbId) : [];
        }

        if (mediaType === 'Season' || mediaType === 'Episode') {
            let seriesTmdbId = item?.SeriesProviderIds?.Tmdb;
            if (!seriesTmdbId && item?.SeriesId) {
                try {
                    const series = await ApiClient.getItem(userId, item.SeriesId);
                    seriesTmdbId = series?.ProviderIds?.Tmdb;
                } catch (_) { /* fall through to empty below */ }
            }
            if (!seriesTmdbId) return [];

            if (mediaType === 'Season') {
                return item?.IndexNumber != null ? getSeasonReleaseInfo(seriesTmdbId, item.IndexNumber) : [];
            }
            return (item?.ParentIndexNumber != null && item?.IndexNumber != null)
                ? getEpisodeReleaseInfo(seriesTmdbId, item.ParentIndexNumber, item.IndexNumber)
                : [];
        }

        return [];
    }

    /**
     * Shows a release/air date chip (icon + date per known release type) on
     * an item's details page. Unlike file size / audio language, there's no
     * "unavailable" dash state: most back-catalog items genuinely have no
     * digital/physical release date recorded on TMDB, so the chip is skipped
     * entirely rather than always rendering a placeholder.
     *
     * A placeholder element (with dataset.itemId set) is inserted
     * synchronously, before the async TMDB fetch starts. This is required for
     * the dedup check above to work: the shared MutationObserver re-invokes
     * handleItemDetails() several times in quick succession (debounced, but
     * still well within the requestIdleCallback window of a slow TMDB
     * round-trip), and without an early placeholder each of those calls would
     * independently fetch and append its own chip for the same item.
     * @param {string} itemId The ID of the item.
     * @param {HTMLElement} container The DOM element to append the chip to.
     */
    async function displayReleaseDate(itemId, container) {
        const existing = container.querySelector('.mediaInfoItem-releaseDate');
        if (existing) {
            // Already rendered (or in flight) for this itemId — nothing to do.
            if (existing.dataset.itemId === itemId) return;
            existing.remove();
        }

        const now = Date.now();
        const cached = releaseDateCache.get(itemId);
        if (cached && (now - cached.ts) < RELEASEDATE_CACHE_TTL) {
            if (cached.infos.length > 0) renderReleaseDateChip(container, itemId, cached.infos);
            return;
        }

        const placeholder = document.createElement('div');
        placeholder.className = 'mediaInfoItem mediaInfoItem-releaseDate';
        placeholder.dataset.itemId = itemId;
        placeholder.style.display = 'none';
        container.appendChild(placeholder);

        const performFetch = async () => {
            try {
                const userId = ApiClient.getCurrentUserId();
                const item = JE.helpers?.getItemCached
                    ? await JE.helpers.getItemCached(itemId, { userId })
                    : await ApiClient.getItem(userId, itemId);
                const infos = await resolveReleaseInfo(item, userId);
                releaseDateCache.set(itemId, { infos, ts: now });
                // The user may have navigated away while this was in flight.
                if (!placeholder.isConnected) return;
                if (infos.length > 0) {
                    fillReleaseDateChip(placeholder, infos);
                } else {
                    placeholder.remove();
                }
            } catch (error) {
                console.error(`🪼 Jellyfin Enhanced: Release Date: Error fetching release info for ${itemId}:`, error);
                releaseDateCache.set(itemId, { infos: [], ts: now });
                placeholder.remove();
            }
        };

        if (typeof requestIdleCallback !== 'undefined') {
            requestIdleCallback(() => performFetch(), { timeout: 2000 });
        } else {
            setTimeout(() => performFetch(), 0);
        }
    }

    let releaseDateIconFontInjected = false;
    function ensureReleaseDateIconFont() {
        if (releaseDateIconFontInjected) return;
        releaseDateIconFontInjected = true;
        JE.helpers.addCSS('je-release-date-symbols', `
            @font-face {
                font-family: 'Material Symbols Rounded';
                font-style: normal;
                font-weight: 100 700;
                font-display: block;
                src: url(${JE.cdn.url('gfont', 's/materialsymbolsrounded/v258/syl0-zNym6YjUruM-QrEh7-nyTnjDwKNJ_190FjpZIvDmUSVOK7BDB_Qb9vUSzq3wzLK-P0J-V_Zs-QtQth3-jOcbTCVpeRL2w5rwZu2rIelXxc.woff2')}) format('woff2');
            }
            .je-release-date-icon {
                font-family: 'Material Symbols Rounded';
                font-weight: normal;
                font-style: normal;
                line-height: 1;
                letter-spacing: normal;
                text-transform: none;
                display: inline-block;
                white-space: nowrap;
                word-wrap: normal;
                direction: ltr;
                -webkit-font-feature-settings: 'liga';
                -moz-font-feature-settings: 'liga';
                font-feature-settings: 'liga';
                -webkit-font-smoothing: antialiased;
            }
        `);
    }

    /** Fills an existing release-date placeholder element with one icon+date pair per known release type. */
    function fillReleaseDateChip(chip, infos) {
        ensureReleaseDateIconFont();
        chip.title = JE.t('release_date_tooltip');
        chip.style.display = 'flex';
        chip.style.alignItems = 'center';
        chip.style.gap = '0.6em';
        chip.style.margin = '0 1em 0 0 !important';
        chip.innerHTML = infos.map(info => `<span style="display: inline-flex; align-items: center;"><span class="je-release-date-icon" style="font-size: inherit; margin-right: 0.3em;" title="${JE.t(info.titleKey)}">${info.icon}</span>${formatReleaseDate(info.date)}</span>`).join('');
    }

    /** Creates and appends a fresh release-date chip (cache-hit path, where there's no placeholder to fill). */
    function renderReleaseDateChip(container, itemId, infos) {
        const chip = document.createElement('div');
        chip.className = 'mediaInfoItem mediaInfoItem-releaseDate';
        chip.dataset.itemId = itemId;
        fillReleaseDateChip(chip, infos);
        container.appendChild(chip);
    }

    // Shared with the details-page dispatcher (features-details-page.js).
    internal.displayReleaseDate = displayReleaseDate;

})(window.JellyfinEnhanced);
