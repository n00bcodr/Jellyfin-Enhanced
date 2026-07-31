// /js/jellyseerr/moreinfo/more-info-modal-seasons.js
// Season-level logic: metadata backfill from TMDB, Jellyfin season links,
// availability chips, unrequested-season detection and the seasons section.
(function(JE) {
    'use strict';

    JE.internals = JE.internals || {};
    // Shared state is seeded by more-info-modal-data.js, which plugin.js loads
    // first in this group.
    const internal = JE.internals.moreInfoModal;
    const state = internal.state;
    const logPrefix = '🪼 Jellyfin Enhanced: Jellyseerr More Info:';
    const escapeHtml = JE.escapeHtml;
    const MediaStatus = JE.seerrStatus.MEDIA;

    /**
     * Validates that a string starts with an ISO date format (YYYY-MM-DD).
     * @param {string} d - The date string to validate.
     * @returns {boolean} True if the string matches the date pattern.
     */
    const isValidDate = (d) => /^\d{4}-\d{2}-\d{2}/.test(d);

    /** Validates that a TMDB poster path matches the expected format (e.g., /abc123.jpg). */
    const isValidPosterPath = (p) => /^\/[a-zA-Z0-9._-]+\.[a-zA-Z]+$/.test(p);

/**
 * Backfills missing season metadata (posterPath, overview, airDate) from TMDB and episode data.
 * Fetches data asynchronously, then updates DOM season cards in-place.
 * @param {number} tmdbId - The TMDB ID of the TV show.
 * @param {object} data - The Seerr TV show details object (seasons are mutated with backfilled values).
 */
async function backfillSeasonMetadata(tmdbId, data) {
    try {
        if (!state.currentModal || !data?.seasons) return;

        const api = JE.jellyseerrAPI;
        const seasonsMissingData = data.seasons.filter(s => s.episodeCount > 0 && (!s.airDate || !s.posterPath || !s.overview));
        if (seasonsMissingData.length === 0) return;

        // Fetch TMDB data + per-season episode data in parallel
        const tmdbPromise = (JE.pluginConfig?.TmdbEnabled && api?.fetchTmdbTvDetails)
            ? api.fetchTmdbTvDetails(tmdbId).catch(() => null)
            : Promise.resolve(null);

        const episodePromises = (api?.fetchTvSeasonDetails)
            ? seasonsMissingData.map(s =>
                api.fetchTvSeasonDetails(tmdbId, s.seasonNumber)
                    .then(detail => ({ seasonNumber: s.seasonNumber, firstEpDate: detail?.episodes?.[0]?.airDate || '' }))
                    .catch(() => ({ seasonNumber: s.seasonNumber, firstEpDate: '' }))
            )
            : [];

        const [tmdbData, ...episodeResults] = await Promise.all([tmdbPromise, ...episodePromises]);

        // Build TMDB season lookup
        const tmdbMap = {};
        if (tmdbData?.seasons) {
            tmdbData.seasons.forEach(s => { tmdbMap[s.season_number] = s; });
        }

        // Build episode air date lookup
        const epDateMap = {};
        episodeResults.forEach(r => {
            if (r.firstEpDate && isValidDate(r.firstEpDate)) {
                epDateMap[r.seasonNumber] = r.firstEpDate;
            }
        });

        // Bail if modal was closed/replaced during async fetch
        if (!state.currentModal || String(state.currentModal.dataset?.tmdbId) !== String(tmdbId)) return;

        // Update each season card in the DOM
        data.seasons.forEach(season => {
            const sNum = season.seasonNumber;
            const card = state.currentModal.querySelector(`.season-card[data-season-number="${CSS.escape(String(sNum))}"]`);
            if (!card) return;

            const tmdbSeason = tmdbMap[sNum];

            // Backfill posterPath (validate format to prevent loading from unexpected URLs)
            // Try TMDB season poster first, then fall back to the show poster
            if (!season.posterPath) {
                const tmdbPoster = tmdbSeason?.poster_path;
                const fallbackPoster = (tmdbPoster && isValidPosterPath(tmdbPoster)) ? tmdbPoster : data.posterPath;
                if (fallbackPoster && isValidPosterPath(fallbackPoster)) {
                    season.posterPath = fallbackPoster;
                    const posterEl = card.querySelector('.season-poster');
                    if (posterEl) {
                        const newSrc = `https://image.tmdb.org/t/p/w185${season.posterPath}`;
                        const existingImg = posterEl.querySelector('img');
                        if (existingImg) {
                            // Update src if it changed (e.g., replacing show poster with season poster)
                            if (existingImg.src !== newSrc) existingImg.src = newSrc;
                        } else {
                            const img = document.createElement('img');
                            img.src = newSrc;
                            img.alt = card.querySelector('.season-name')?.textContent || '';
                            posterEl.appendChild(img);
                        }
                    }
                }
            }

            // Backfill overview (textContent is safe from XSS)
            if (!season.overview && tmdbSeason?.overview) {
                season.overview = tmdbSeason.overview;
                const infoEl = card.querySelector('.season-info');
                if (infoEl && !infoEl.querySelector('.season-overview')) {
                    const overviewEl = document.createElement('div');
                    overviewEl.className = 'season-overview';
                    overviewEl.textContent = season.overview;
                    infoEl.appendChild(overviewEl);
                }
            }

            // Backfill airDate (episode date first, then TMDB fallback)
            if (!season.airDate) {
                const epDate = epDateMap[sNum];
                const tmdbDate = tmdbSeason?.air_date || '';
                const bestDate = epDate || (isValidDate(tmdbDate) ? tmdbDate : '');
                if (bestDate) {
                    season.airDate = bestDate;
                    const metaEl = card.querySelector('.season-meta');
                    if (metaEl) {
                        const year = new Date(bestDate).getFullYear();
                        const currentText = metaEl.textContent || '';
                        if (!currentText.includes(String(year))) {
                            metaEl.textContent = `${season.episodeCount} Episodes \u2022 ${year}`;
                        }
                    }
                }
            }
        });
    } catch (e) {
        console.debug(`${logPrefix} Failed to backfill season metadata:`, e);
    }
}

function getSeasonStatusInfo(data, seasonNumber) {
    const seasons = data?.mediaInfo?.seasons;
    if (!Array.isArray(seasons) || !seasonNumber) return null;
    return seasons.find(s => Number(s?.seasonNumber) === Number(seasonNumber)) || null;
}

function getSeasonJellyfinId(seasonInfo, is4k = false) {
    if (!seasonInfo || typeof seasonInfo !== 'object') return null;
    if (is4k) {
        return seasonInfo.jellyfinMediaId4k || seasonInfo.jellyfinSeasonId4k || seasonInfo.jellyfinId4k || null;
    }
    return seasonInfo.jellyfinMediaId || seasonInfo.jellyfinSeasonId || seasonInfo.jellyfinId || null;
}

function buildSeasonAvailabilityLinks(seasonInfo, jellyfinSeasonId = null, jellyfinSeasonId4k = null) {
    const normalStatus = seasonInfo?.status;
    const status4k = seasonInfo?.status4k;
    // A season is only "available" if Jellyseerr says so AND we have a real Jellyfin ID to back it up.
    // If Jellyseerr reports status 5 (available) but there's no jellyfinSeasonId, the library entry
    // was deleted and Jellyseerr's status is stale — don't show the Available chip.
    const isNormalAvailable = (normalStatus === MediaStatus.AVAILABLE && !!jellyfinSeasonId)
        || normalStatus === MediaStatus.PARTIALLY_AVAILABLE
        || (!normalStatus && !!jellyfinSeasonId);
    const is4kAvailable = (status4k === MediaStatus.AVAILABLE && !!jellyfinSeasonId4k)
        || status4k === MediaStatus.PARTIALLY_AVAILABLE
        || (!status4k && !!jellyfinSeasonId4k);

    const pills = [];

    if (isNormalAvailable) {
        if (jellyfinSeasonId) {
            pills.push(`<a is="emby-linkbutton" class="season-link-chip available" href="#!/details?id=${encodeURIComponent(jellyfinSeasonId)}">Available</a>`);
        } else {
            pills.push('<span class="season-link-chip available">Available</span>');
        }
    }

    if (is4kAvailable) {
        if (jellyfinSeasonId4k) {
            pills.push(`<a is="emby-linkbutton" class="season-link-chip available-4k" href="#!/details?id=${encodeURIComponent(jellyfinSeasonId4k)}">4K Available</a>`);
        } else if (jellyfinSeasonId) {
            pills.push(`<a is="emby-linkbutton" class="season-link-chip available-4k" href="#!/details?id=${encodeURIComponent(jellyfinSeasonId)}">4K Available</a>`);
        } else {
            pills.push('<span class="season-link-chip available-4k">4K Available</span>');
        }
    }

    if (!pills.length) return '';
    return `<div class="season-links">${pills.join('')}</div>`;
}

async function fetchJellyfinSeasonMap(seriesId) {
    const userId = ApiClient.getCurrentUserId?.();
    if (!userId || !seriesId) return {};

    try {
        const response = await ApiClient.ajax({
            type: 'GET',
            url: ApiClient.getUrl(`/Users/${userId}/Items`, {
                ParentId: seriesId,
                IncludeItemTypes: 'Season',
                Recursive: false,
                Fields: 'ParentIndexNumber,IndexNumber,Name'
            }),
            dataType: 'json'
        });

        const map = {};
        const items = Array.isArray(response?.Items) ? response.Items : [];
        for (const season of items) {
            const seasonNumber = Number(season?.IndexNumber);
            if (season?.Id && Number.isFinite(seasonNumber) && seasonNumber > 0) {
                map[seasonNumber] = { id: season.Id, name: season.Name || null };
            }
        }
        return map;
    } catch (error) {
        console.debug(`${logPrefix} Could not load Jellyfin season links:`, error);
        return {};
    }
}

async function enrichSeasonCardsWithJellyfinLinks(data, modal = state.currentModal) {
    if (!modal || data?.mediaType === 'movie') return;

    const cards = modal.querySelectorAll('[data-season-number]');
    if (!cards.length) return;

    const seriesId = data?.mediaInfo?.jellyfinMediaId;
    if (!seriesId) return;

    if (!data._jellyfinSeasonIdMap) {
        data._jellyfinSeasonIdMap = await fetchJellyfinSeasonMap(seriesId);
    }

    cards.forEach(card => {
        const seasonNumber = Number(card.dataset.seasonNumber);
        const mount = card.querySelector('[data-season-links]');
        if (!mount || !Number.isFinite(seasonNumber)) return;

        const seasonInfo = getSeasonStatusInfo(data, seasonNumber);
        const jellyfinEntry = data._jellyfinSeasonIdMap?.[seasonNumber];
        const jellyfinId = typeof jellyfinEntry === 'object' ? jellyfinEntry?.id : jellyfinEntry;
        const seasonId = jellyfinId || getSeasonJellyfinId(seasonInfo, false) || null;
        const seasonId4k = getSeasonJellyfinId(seasonInfo, true) || null;
        mount.innerHTML = buildSeasonAvailabilityLinks(seasonInfo, seasonId, seasonId4k);

        // Override the season display name with what Jellyfin actually calls it,
        // so TVDB subtitles like "Beast Hunters" are replaced with "Season 3".
        const jellyfinName = typeof jellyfinEntry === 'object' ? jellyfinEntry?.name : null;
        if (jellyfinName) {
            const nameEl = card.querySelector('.season-name');
            if (nameEl) nameEl.textContent = jellyfinName;
        }
    });
}

/**
 * Check if a TV show has any unrequested seasons by querying the request endpoint
 * @param {object} data - The TV show data from Jellyseerr
 * @returns {Promise<boolean>} - True if there are seasons that can be requested
 */
async function checkForUnrequestedSeasons(data) {
    // Get all seasons from TMDB data that have episodes (excluding specials and unaired seasons)
    const tmdbSeasons = (data.seasons || []).filter(s => s.seasonNumber > 0 && s.episodeCount > 0);
    if (tmdbSeasons.length === 0) return false;

    const tmdbId = data.id;

    try {
        // Query the request endpoint to get ALL requests for this show
        const response = await ApiClient.ajax({
            type: 'GET',
            url: ApiClient.getUrl(`/JellyfinEnhanced/jellyseerr/request?take=500&skip=0&filter=all`),
            headers: { 'X-Jellyfin-User-Id': ApiClient.getCurrentUserId() },
            dataType: 'json'
        });

        // Collect all season statuses from all requests for this TMDB ID
        const statusMap = {};

        if (response.results) {
            for (const request of response.results) {
                if (request.type === 'tv' && request.media && request.media.tmdbId === tmdbId) {
                    if (request.seasons) {
                        for (const season of request.seasons) {
                            const seasonNum = season.seasonNumber;
                            const status = season.status;
                            if (!statusMap[seasonNum] || status > statusMap[seasonNum]) {
                                statusMap[seasonNum] = status;
                            }
                        }
                    }
                }
            }
        }

        // Also check mediaInfo.seasons for available seasons
        if (data.mediaInfo && data.mediaInfo.seasons) {
            for (const season of data.mediaInfo.seasons) {
                const seasonNum = season.seasonNumber;
                const status = season.status;
                if (!statusMap[seasonNum] || status > statusMap[seasonNum]) {
                    statusMap[seasonNum] = status;
                }
            }
        }

        // Check if any TMDB season is unrequested. Status 0/undefined and 1
        // (Unknown) mean it has never been requested. Status 7 (Deleted) means
        // a prior request was removed and the season can be re-requested.
        // Status 5 (Available) can be stale: Seerr keeps showing a season as
        // available after it was deleted from the library. The show-level check
        // (!jellyfinMediaId) only catches full-show deletions; for partial
        // deletions (one missing season in an otherwise-present show) the show
        // still has a jellyfinMediaId so the old check misses them. Query
        // Jellyfin directly to get the authoritative per-season presence map.
        const jellyfinMediaId = data.mediaInfo?.jellyfinMediaId || null;
        let jellyfinSeasonPresenceMap = null;
        if (jellyfinMediaId) {
            try {
                const userId = ApiClient.getCurrentUserId?.();
                if (userId) {
                    const resp = await ApiClient.ajax({
                        type: 'GET',
                        url: ApiClient.getUrl(`/Users/${userId}/Items`, {
                            ParentId: jellyfinMediaId,
                            IncludeItemTypes: 'Season',
                            Recursive: false,
                            Fields: 'IndexNumber'
                        }),
                        dataType: 'json'
                    });
                    jellyfinSeasonPresenceMap = {};
                    for (const s of (resp?.Items || [])) {
                        const idx = Number(s?.IndexNumber);
                        if (Number.isFinite(idx) && idx >= 0) jellyfinSeasonPresenceMap[idx] = true;
                    }
                }
            } catch (_) {}
        }

        for (const tmdbSeason of tmdbSeasons) {
            const rawStatus = statusMap[tmdbSeason.seasonNumber];
            const effectiveStatus = JE.seerrStatus.effectiveMediaStatus(
                rawStatus, jellyfinMediaId, jellyfinSeasonPresenceMap, tmdbSeason.seasonNumber
            );
            if (JE.seerrStatus.isRequestable(effectiveStatus)) {
                return true;
            }
        }

        return false;
    } catch (error) {
        console.error(`[More Info Modal] Error checking unrequested seasons:`, error);
        return false;
    }
}

/**
 * Build seasons section (TV shows only)
 */
function buildSeasonsSection(data) {
    if (!data.seasons || !data.seasons.length) return '';

    return `
        <div class="seasons-section">
            <h3>Seasons</h3>
            <div class="seasons-grid">
                ${data.seasons.map(season => {
                    const seasonInfo = getSeasonStatusInfo(data, season.seasonNumber);
                    const seasonJellyfinId = getSeasonJellyfinId(seasonInfo, false);
                    const seasonJellyfinId4k = getSeasonJellyfinId(seasonInfo, true);
                    const seasonPosterPath = season.posterPath
                        || (data.posterPath && isValidPosterPath(data.posterPath) ? data.posterPath : null);
                    const posterUrl = seasonPosterPath
                        ? `https://image.tmdb.org/t/p/w185${seasonPosterPath}`
                        : '';

                    // Derive a display name: if the API returns just the number (TheTVDB), generate a proper label.
                    // The numeric regex catches bare numbers and zero-padded variants (e.g., "01");
                    // this may also match year-named seasons, which is an acceptable tradeoff.
                    const sNum = season.seasonNumber;
                    const trimmedName = (season.name || '').trim();
                    const isNumericOnly = trimmedName === String(sNum) || /^0*\d+$/.test(trimmedName);
                    const displayName = (trimmedName && !isNumericOnly)
                        ? trimmedName
                        : (sNum === 0 ? JE.t('jellyseerr_season_specials') : JE.t('jellyseerr_season_name', { number: sNum }));

                    return `
                        <div class="season-card" data-season-number="${escapeHtml(String(sNum))}">
                            <div class="season-poster">
                                ${posterUrl ? `<img src="${escapeHtml(posterUrl)}" alt="${escapeHtml(displayName)}" />` : ''}
                            </div>
                            <div class="season-info">
                                <div class="season-name">${escapeHtml(displayName)}</div>
                                <div class="season-meta">
                                    ${escapeHtml(season.episodeCount || 0)} Episodes
                                    ${season.airDate && isValidDate(season.airDate) ? ` \u2022 ${escapeHtml(season.airDate.substring(0, 4))}` : ''}
                                </div>
                                <div data-season-links>${buildSeasonAvailabilityLinks(seasonInfo, seasonJellyfinId, seasonJellyfinId4k)}</div>
                                ${season.overview ? `<div class="season-overview">${escapeHtml(season.overview)}</div>` : ''}
                            </div>
                        </div>
                    `;
                }).join('')}
            </div>
        </div>
    `;
}
    internal.backfillSeasonMetadata = backfillSeasonMetadata;
    internal.getSeasonStatusInfo = getSeasonStatusInfo;
    internal.getSeasonJellyfinId = getSeasonJellyfinId;
    internal.buildSeasonAvailabilityLinks = buildSeasonAvailabilityLinks;
    internal.fetchJellyfinSeasonMap = fetchJellyfinSeasonMap;
    internal.enrichSeasonCardsWithJellyfinLinks = enrichSeasonCardsWithJellyfinLinks;
    internal.checkForUnrequestedSeasons = checkForUnrequestedSeasons;
    internal.buildSeasonsSection = buildSeasonsSection;

})(window.JellyfinEnhanced);
