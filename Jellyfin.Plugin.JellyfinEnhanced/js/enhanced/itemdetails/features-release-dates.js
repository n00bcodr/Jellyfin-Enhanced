/** @file Details-page release/air-date chips resolved from TMDB via the plugin proxy. */
(function(JE) {
    'use strict';

    JE.internals = JE.internals || {};
    const internal = JE.internals.features = JE.internals.features || {};

    const RELEASEDATE_CACHE_TTL = 60 * 60 * 1000; // 1 hour
    const releaseDateCache = new Map(); // Map<itemId, { infos, ts }>

    function tmdbGet(path) {
        const url = ApiClient.getUrl(`/JellyfinEnhanced/tmdb${path}`);
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

    // TMDB release_dates `type` values bucketed into the three release
    // moments we show; theatrical premiere/limited/wide (1-3) collapse into
    // one "cinema" bucket, digital(4) and physical(5) stay separate.
    const MOVIE_RELEASE_BUCKETS = [
        { types: [1, 2, 3], icon: 'local_movies', titleKey: 'calendar_cinema_release', type: 'cinema' },
        { types: [4], icon: 'ondemand_video', titleKey: 'calendar_digital_release', type: 'digital' },
        { types: [5], icon: 'album', titleKey: 'calendar_physical_release', type: 'physical' },
    ];

    /** Returns the earliest `release_date` among entries of the given bucket's types, or null. */
    function earliestOfBucket(releaseDates, bucket) {
        const matches = (releaseDates || []).filter(d => bucket.types.includes(d.type) && d.release_date);
        if (matches.length === 0) return null;
        return matches.reduce((a, b) => (a.release_date < b.release_date ? a : b));
    }

    // Each bucket cascades through the configured region, then US, then any
    // region at all, since most countries only record one release type.
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
            if (earliest) infos.push({ date: earliest.release_date, icon: bucket.icon, titleKey: bucket.titleKey, type: bucket.type });
        }
        return infos;
    }

    async function getSeriesReleaseInfo(tmdbId) {
        const data = await tmdbGet(`/tv/${tmdbId}`);
        const date = data?.next_episode_to_air?.air_date || data?.last_episode_to_air?.air_date;
        return date ? [{ date, icon: 'tv_guide', titleKey: 'calendar_episode', type: 'episode' }] : [];
    }

    async function getSeasonReleaseInfo(tmdbId, seasonNumber) {
        const data = await tmdbGet(`/tv/${tmdbId}/season/${seasonNumber}`);
        const episodes = data?.episodes;
        if (!Array.isArray(episodes) || episodes.length === 0) return [];

        const withDates = episodes.filter(e => e.air_date);
        if (withDates.length === 0) return [];

        const today = todayIso();
        const upcoming = withDates.find(e => e.air_date >= today);
        const date = (upcoming || withDates[withDates.length - 1]).air_date;
        return [{ date, icon: 'tv_guide', titleKey: 'calendar_episode', type: 'episode' }];
    }

    async function getEpisodeReleaseInfo(tmdbId, seasonNumber, episodeNumber) {
        const data = await tmdbGet(`/tv/${tmdbId}/season/${seasonNumber}/episode/${episodeNumber}`);
        return data?.air_date ? [{ date: data.air_date, icon: 'tv_guide', titleKey: 'calendar_episode', type: 'episode' }] : [];
    }

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

    // No dates found is a valid outcome (most back-catalog items lack a
    // digital/physical date on TMDB), so no chip is rendered rather than a
    // placeholder dash. The placeholder below is inserted synchronously so
    // repeated calls from the debounced MutationObserver dedupe against it
    // instead of each firing their own TMDB fetch.
    async function displayReleaseDate(itemId, container) {
        const existing = container.querySelectorAll('.mediaInfoItem-releaseDate');
        if (existing.length > 0) {
            if (existing[0].dataset.itemId === itemId) return;
            existing.forEach(el => el.remove());
        }

        const now = Date.now();
        const cached = releaseDateCache.get(itemId);
        if (cached && (now - cached.ts) < RELEASEDATE_CACHE_TTL) {
            if (cached.infos.length > 0) renderReleaseDateChips(container, itemId, cached.infos);
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
                if (!placeholder.isConnected) return; // navigated away while fetching
                if (infos.length > 0) {
                    fillReleaseDateChips(placeholder, infos);
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

    function fillReleaseDateChip(chip, info) {
        ensureReleaseDateIconFont();
        chip.classList.add(`je-release-date-${info.type}`);
        chip.title = JE.t(info.titleKey);
        chip.style.display = 'inline-flex';
        chip.style.alignItems = 'center';
        chip.style.gap = '0.3em';
        chip.style.whiteSpace = 'nowrap';
        chip.style.margin = '0 1em 0 0 !important';
        chip.innerHTML = `<span class="je-release-date-icon" style="font-size: inherit;">${info.icon}</span><span>${formatReleaseDate(info.date)}</span>`;
    }

    // Each date is its own flex sibling (like every other stat chip in this
    // row) rather than one chip bundling all of them, so the row's own
    // flex-wrap breaks lines between whole chips instead of wrapping inside
    // a single nested chip.
    function fillReleaseDateChips(placeholder, infos) {
        fillReleaseDateChip(placeholder, infos[0]);
        let anchor = placeholder;
        for (let i = 1; i < infos.length; i++) {
            const chip = document.createElement('div');
            chip.className = 'mediaInfoItem mediaInfoItem-releaseDate';
            chip.dataset.itemId = placeholder.dataset.itemId;
            fillReleaseDateChip(chip, infos[i]);
            anchor.after(chip);
            anchor = chip;
        }
    }

    /** Cache-hit path, where there's no placeholder to fill. */
    function renderReleaseDateChips(container, itemId, infos) {
        infos.forEach(info => {
            const chip = document.createElement('div');
            chip.className = 'mediaInfoItem mediaInfoItem-releaseDate';
            chip.dataset.itemId = itemId;
            fillReleaseDateChip(chip, info);
            container.appendChild(chip);
        });
    }

    internal.displayReleaseDate = displayReleaseDate;

})(window.JellyfinEnhanced);
