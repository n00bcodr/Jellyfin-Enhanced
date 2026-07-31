// /js/jellyseerr/moreinfo/more-info-modal-data.js
// Fetch + pure data helpers for the more-info modal (ratings, details,
// content rating resolution, currency formatting, error reporting).
(function(JE) {
    'use strict';

    JE.internals = JE.internals || {};
    // This module loads first in the More Info modal group, so it OWNS the shared
    // state shape. Siblings read it and must not re-seed it — a duplicated
    // default literal is silently dead everywhere but the first-loaded file.
    const internal = JE.internals.moreInfoModal = JE.internals.moreInfoModal || { state: { currentModal: null } };
    const logPrefix = '🪼 Jellyfin Enhanced: Jellyseerr More Info:';
    const MediaStatus = JE.seerrStatus.MEDIA;

/**
 * Fetch ratings from Jellyseerr API
 */
async function fetchRatings(tmdbId, mediaType) {
    // prefer request-manager (retry, dedup, abort, cache, cf-ray
    // logging) over raw ApiClient.ajax. Falls back to ApiClient.ajax only if
    // request-manager hasn't loaded yet (early page navigations).
    try {
        const endpoint = mediaType === 'tv'
            ? `/tv/${tmdbId}/ratings`
            : `/movie/${tmdbId}/ratingscombined`;
        const url = ApiClient.getUrl(`/JellyfinEnhanced/jellyseerr${endpoint}`);
        let response;
        const JE = window.JellyfinEnhanced;
        if (JE && JE.requestManager) {
            const httpResponse = await JE.requestManager.fetchWithRetry(url, {
                method: 'GET',
                headers: {
                    'X-Jellyfin-User-Id': ApiClient.getCurrentUserId(),
                    // Jellyfin 12 authenticates from the Authorization header; the
                    // legacy X-Emby-Token is kept for 10.11 back-compat.
                    'Authorization': 'MediaBrowser Token="' + ApiClient.accessToken() + '"',
                    'X-Emby-Token': ApiClient.accessToken(),
                    'Accept': 'application/json'
                }
            });
            response = await httpResponse.json();
        } else {
            response = await ApiClient.ajax({
                type: 'GET',
                url,
                headers: { 'X-Jellyfin-User-Id': ApiClient.getCurrentUserId() },
                dataType: 'json'
            });
        }
        if (mediaType === 'tv') {
            return response ? { rt: response } : null;
        }
        return response;
    } catch (error) {
        console.warn(`${logPrefix} Failed to fetch ratings for ${mediaType} ${tmdbId}:`, error);
        return null;
    }
}

function sanitizeMediaInfo4kStatus(data) {
    const mediaInfo = data?.mediaInfo;
    if (!mediaInfo || mediaInfo.status4k !== MediaStatus.AVAILABLE) return;
    const hasDistinct4kLibraryItem = mediaInfo.jellyfinMediaId4k
        && mediaInfo.jellyfinMediaId4k !== mediaInfo.jellyfinMediaId;
    if (!hasDistinct4kLibraryItem) {
        mediaInfo.status4k = MediaStatus.UNKNOWN;
    }
}

/**
 * Fetch media details from Jellyseerr API via proxy.  */
async function fetchMediaDetails(tmdbId, mediaType) {
    try {
        let data;
        if (JE && JE.jellyseerrAPI) {
            data = mediaType === 'movie'
                ? await JE.jellyseerrAPI.fetchMovieDetails(tmdbId)
                : await JE.jellyseerrAPI.fetchTvShowDetails(tmdbId);
        } else {
            const endpoint = mediaType === 'movie'
                ? `/movie/${tmdbId}`
                : `/tv/${tmdbId}`;

            data = await ApiClient.ajax({
                type: 'GET',
                url: ApiClient.getUrl(`/JellyfinEnhanced/jellyseerr${endpoint}`),
                headers: { 'X-Jellyfin-User-Id': ApiClient.getCurrentUserId() },
                dataType: 'json'
            });
        }

        sanitizeMediaInfo4kStatus(data);
        return data;
    } catch (error) {
        console.error(`${logPrefix} Failed to fetch ${mediaType} details for TMDB ID ${tmdbId}:`, error);
        throw error;
    }
}

/**
 * Get content rating for specified region
 */
function getContentRating(data, mediaType) {
    // Resolve region: prefer Elsewhere user setting → plugin fallback → US
    const region = (JE?.userConfig?.elsewhere?.Region || JE?.pluginConfig?.DEFAULT_REGION || 'US')?.toUpperCase();

    if (mediaType === 'movie') {
        // For movies: releases.results[].release_dates[].certification
        const releases = data.releases?.results;
        if (!Array.isArray(releases)) return 'N/A';

        // Find region release
        let regionRelease = releases.find(r => r.iso_3166_1 === region);
        if (!regionRelease) {
            regionRelease = releases.find(r => r.iso_3166_1 === 'US');
        }
        if (!regionRelease && releases.length > 0) {
            regionRelease = releases[0];
        }

        if (!regionRelease?.release_dates?.length) return 'N/A';

        // Get first theatrical release (type 3) with certification
        let release = regionRelease.release_dates.find(rd => rd.type === 3 && rd.certification);
        if (!release) {
            release = regionRelease.release_dates.find(rd => rd.certification);
        }

        return release?.certification || 'N/A';
    } else {
        // For TV: contentRatings.results[].rating
        const results = data.contentRatings?.results;
        if (!Array.isArray(results)) return 'N/A';

        let regionRating = results.find(r => r.iso_3166_1 === region);
        if (!regionRating) {
            regionRating = results.find(r => r.iso_3166_1 === 'US');
        }
        if (!regionRating && results.length > 0) {
            regionRating = results[0];
        }

        return regionRating?.rating || 'N/A';
    }
}

/**
 * Show error message
 */
function showError(message) {
    // You can customize this to match your error handling
    console.error(message);
    alert(message);
}

/**
 * Format currency
 */
function formatCurrency(amount) {
    if (!amount || amount === 0) return null;
    return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: 0,
        maximumFractionDigits: 0
    }).format(amount);
}
    internal.fetchRatings = fetchRatings;
    internal.fetchMediaDetails = fetchMediaDetails;
    internal.getContentRating = getContentRating;
    internal.showError = showError;
    internal.formatCurrency = formatCurrency;

})(window.JellyfinEnhanced);
