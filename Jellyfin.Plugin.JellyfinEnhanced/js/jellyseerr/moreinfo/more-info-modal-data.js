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
 * @param {number} tmdbId TMDB id.
 * @param {string} mediaType 'movie' or 'tv'.
 * @param {{publicDetails?: boolean}} [options] publicDetails: the window shows public details ({@link fetchMediaDetails}),
 *   so the ratings come from the same public route.
 */
async function fetchRatings(tmdbId, mediaType, options = {}) {
    // The core owns submission identity through the awaited response body.
    try {
        const endpoint = mediaType === 'tv'
            ? `/tv/${tmdbId}/ratings`
            : `/movie/${tmdbId}/ratingscombined`;
        const url = ApiClient.getUrl(`/JellyfinEnhanced/jellyseerr${endpoint}`);
        let response;
        const JE = window.JellyfinEnhanced;
        if (options.publicDetails && JE?.jellyseerrAPI?.fetchPublic) {
            response = await JE.jellyseerrAPI.fetchPublic(`/title/${mediaType === 'tv' ? 'tv' : 'movie'}/${tmdbId}/ratings`);
        } else {
            response = await JE.core.api.fetch(url);
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
 * True when Jellyfin Enhanced handles requests (Requests & downloads in Jellyfin Enhanced mode): no Seerr account
 * is needed to ask for a title, so none is needed to see it either.
 * @returns {boolean}
 */
function jeMode() {
    return JE.internals?.arrAskSeerr?.jeMode?.() === true;
}

/**
 * The error a window gets when Seerr won't answer through the viewer's own account and there is no other way
 * (Seerr handles requests): `seerrAccount` says why, so the window says that instead of "try again".
 * @param {'unlinked'|'blocked'} reason Why.
 * @returns {Error}
 */
function accountError(reason) {
    const error = new Error(`Seerr won't answer for this account (${reason})`);
    error.seerrAccount = reason;
    return error;
}

/**
 * The title's public details from Jellyfin Enhanced's own route (see JE.jellyseerrAPI.fetchPublic), marked
 * `jePublicDetails` so the window leaves out what only the viewer's Seerr account has. A failure is marked
 * `jePublic` (the window says what it means; it's not logged as an error); a server without the route
 * (Jellyfin 10.11 answers a bare 404) is Seerr's refusal again.
 * @param {number} tmdbId TMDB id.
 * @param {string} mediaType 'movie' or 'tv'.
 * @param {'unlinked'|'blocked'} refusal Why Seerr won't answer for the viewer.
 * @returns {Promise<Object>}
 */
async function fetchPublicDetails(tmdbId, mediaType, refusal) {
    let data;
    try {
        data = await JE.jellyseerrAPI.fetchPublic(`/title/${mediaType === 'movie' ? 'movie' : 'tv'}/${tmdbId}`);
    } catch (error) {
        if (error?.status === 404 && !error.responseJSON?.code) throw accountError(refusal);
        if (error && typeof error === 'object') error.jePublic = true;
        throw error;
    }
    if (data && typeof data === 'object') data.jePublicDetails = true;
    return data;
}

/**
 * Fetch media details from Jellyseerr API via proxy. A viewer Seerr won't answer for (no linked account, or
 * Seerr turned off for them) gets the title's public details instead while Jellyfin Enhanced handles requests,
 * and an error saying why (`seerrAccount`) otherwise.
 * @param {number} tmdbId TMDB id.
 * @param {string} mediaType 'movie' or 'tv'.
 * @returns {Promise<Object|null>}
 */
async function fetchMediaDetails(tmdbId, mediaType) {
    const api = JE?.jellyseerrAPI;
    // Known from the user status: no read through the viewer's account that the proxy would refuse.
    let refusal = typeof api?.accountRefusal === 'function' ? await api.accountRefusal().catch(() => null) : null;
    try {
        if (refusal) throw accountError(refusal);
        let data;
        if (JE && JE.jellyseerrAPI) {
            data = mediaType === 'movie'
                ? await JE.jellyseerrAPI.fetchMovieDetails(tmdbId, { throwOnError: true })
                : await JE.jellyseerrAPI.fetchTvShowDetails(tmdbId, { throwOnError: true });
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
        if (data && typeof data === 'object') data.jePublicDetails = false;
        return data;
    } catch (error) {
        refusal = error?.seerrAccount || api?.accountRefusalOf?.(error) || null;
        if (!refusal) {
            console.error(`${logPrefix} Failed to fetch ${mediaType} details for TMDB ID ${tmdbId}:`, error);
            throw error;
        }
    }
    if (!jeMode()) throw accountError(refusal);
    return fetchPublicDetails(tmdbId, mediaType, refusal);
}

/**
 * The message key for a window that couldn't load or refresh its title: why Seerr won't answer for the viewer,
 * a title the server won't show them, or the general "try again" (`fallbackKey`).
 * @param {any} error The failure.
 * @param {string} fallbackKey Key for any other failure.
 * @returns {string} Translation key.
 */
function errorKey(error, fallbackKey) {
    if (error?.seerrAccount === 'blocked') return 'jellyseerr_modal_seerr_blocked';
    if (error?.seerrAccount === 'unlinked') return 'jellyseerr_modal_seerr_unlinked';
    if (error?.jePublic && error.responseJSON?.code === 'not_found') return 'jellyseerr_modal_not_available';
    return fallbackKey;
}

/**
 * True for a failure the window explains itself ({@link errorKey}): not logged as an error.
 * @param {any} error The failure.
 * @returns {boolean}
 */
function isExplained(error) {
    return !!(error?.seerrAccount || error?.jePublic);
}

/**
 * Get content rating for specified region
 */
function getContentRating(data, mediaType) {
    // Resolve region: prefer Elsewhere user setting → plugin fallback → US
    const region = (JE?.userConfig?.elsewhere?.Region || JE?.pluginConfig?.DEFAULT_REGION || 'US')?.toUpperCase();

    if (mediaType === 'movie' && Array.isArray(data.releases?.results)) {
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
 * Tells the viewer the modal couldn't load or refresh its title.
 * @param {string} key Translation key of the message.
 */
function showError(key) {
    // A toast, not a blocking browser dialog (an outage of Seerr is not the viewer's error).
    const text = JE.t ? JE.t(key) : key;
    console.warn(`${logPrefix} ${key}`);
    if (typeof JE.toast === 'function') JE.toast(JE.escapeHtml ? JE.escapeHtml(text) : text, 5000);
    else alert(text);
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
    internal.errorKey = errorKey;
    internal.isExplained = isExplained;
    internal.getContentRating = getContentRating;
    internal.showError = showError;
    internal.formatCurrency = formatCurrency;

})(window.JellyfinEnhanced);
