// /js/jellyseerr/listplaceholders/listplaceholders-requests.js
// Seerr requests from placeholder rows/cards and the "requested" state they share (B5/B6):
// movie → JE's movie request flow, TV → the season modal pre-ticking the placeholder's
// season. Every row/card with the same mediaType|tmdbId|season updates together.
(function (JE) {
    'use strict';

    JE.internals = JE.internals || {};
    const lp = JE.internals.listPlaceholders = JE.internals.listPlaceholders || {};

    /** Keys requested this session: movie|id, tv|id|<season>, tv|id|* (whole show). */
    const requested = new Set();
    /** Pending user-status promise (Seerr reachable + current user linked). */
    let userStatusPromise = null;

    /**
     * Seerr seasons a placeholder's request covers (B6): season/episodes → its season, series → none.
     * @param {Object} ph
     * @returns {number[]}
     */
    function preselectedSeasons(ph) {
        if ((ph.kind === 'season' || ph.kind === 'episodes') && Number.isInteger(ph.seasonNumber)) return [ph.seasonNumber];
        return [];
    }

    /**
     * Whether this session requested what a placeholder stands for.
     * @param {Object} ph
     * @returns {boolean}
     */
    function isRequested(ph) {
        if (!ph || !ph.tmdbId) return false;
        if (ph.mediaType === 'movie') return requested.has(`movie|${ph.tmdbId}`);
        if (requested.has(`tv|${ph.tmdbId}|*`)) return true;
        if (ph.kind === 'series') {
            for (const key of requested) if (key.startsWith(`tv|${ph.tmdbId}|`)) return true;
            return false;
        }
        return requested.has(`tv|${ph.tmdbId}|${ph.seasonNumber}`);
    }

    /**
     * Records a request announced by JE's Seerr API (`jellyseerr-media-requested`).
     * 4K requests don't change the placeholder (it tracks the regular status).
     * @param {{tmdbId: (string|number), mediaType: string, is4k?: boolean, seasons?: (number[]|string)}} detail
     * @returns {boolean} Whether anything was recorded.
     */
    function markRequested(detail) {
        if (!detail || detail.is4k) return false;
        const id = Number(detail.tmdbId);
        if (!Number.isInteger(id) || id <= 0) return false;
        const type = String(detail.mediaType || '').toLowerCase();
        if (type === 'movie') {
            requested.add(`movie|${id}`);
            return true;
        }
        if (type !== 'tv') return false;
        if (Array.isArray(detail.seasons) && detail.seasons.length) {
            for (const season of detail.seasons) {
                if (Number.isInteger(Number(season))) requested.add(`tv|${id}|${Number(season)}`);
            }
        } else {
            requested.add(`tv|${id}|*`);
        }
        return true;
    }

    /** Forgets the session's requested state (user switch). */
    function reset() {
        requested.clear();
        userStatusPromise = null;
    }

    /**
     * Seerr user status for request buttons, fetched once per page load.
     * @param {boolean} [fresh] - Ask again (after a failure).
     * @returns {Promise<{active: boolean, userFound: boolean}>}
     */
    function userStatus(fresh) {
        if (!JE.jellyseerrAPI?.checkUserStatus || JE.pluginConfig?.JellyseerrEnabled !== true) {
            return Promise.resolve({ active: false, userFound: false });
        }
        if (!userStatusPromise || fresh) {
            userStatusPromise = JE.jellyseerrAPI.checkUserStatus()
                .then(s => ({ active: !!s?.active, userFound: !!s?.userFound }))
                .catch(() => ({ active: false, userFound: false }));
        }
        return userStatusPromise;
    }

    /**
     * Whether fresh Seerr details say the title was already requested or is available
     * (pending, processing, partially available, available).
     * @param {number|undefined} status - Seerr media status.
     * @returns {boolean}
     */
    function isAlreadyRequested(status) {
        const M = JE.seerrStatus?.MEDIA;
        if (!M || !status) return false;
        return status === M.PENDING || status === M.PROCESSING || status === M.PARTIALLY_AVAILABLE || status === M.AVAILABLE;
    }

    /**
     * Announces "requested" to every placeholder UI (409/202 answers count as requested, B5).
     * @param {Object} ph
     */
    function announce(ph) {
        document.dispatchEvent(new CustomEvent('jellyseerr-media-requested', {
            detail: { tmdbId: String(ph.tmdbId), mediaType: ph.mediaType, is4k: false, seasons: ph.mediaType === 'tv' ? preselectedSeasons(ph) : undefined }
        }));
    }

    /**
     * Requests the title behind a placeholder.
     * Movies use JE's movie flow (advanced-options modal when allowed, else a direct request);
     * TV opens the season modal with the placeholder's season pre-ticked.
     * @param {Object} ph - Placeholder (tmdb-backed).
     * @param {HTMLButtonElement} [button] - Button to show progress on.
     * @returns {Promise<void>}
     */
    async function requestPlaceholder(ph, button) {
        const api = JE.jellyseerrAPI;
        const ui = JE.jellyseerrUI;
        if (!api || !ui || !ph?.tmdbId) return;
        const tmdbId = Number(ph.tmdbId);
        if (ph.mediaType === 'tv') {
            await ui.showSeasonSelectionModal(tmdbId, 'tv', ph.title, null, false, { preselectedSeasons: preselectedSeasons(ph) });
            return;
        }
        const details = (await api.fetchMovieDetails(tmdbId)) || lp.render.toSeerrItem(ph);
        if (isAlreadyRequested(details?.mediaInfo?.status)) {
            // Requested (or added) since the last status refresh: Seerr would answer 409 (B5).
            announce(ph);
            return;
        }
        if (api.shouldShowAdvanced()) {
            await ui.showMovieRequestModal(tmdbId, ph.title, details, false);
            return;
        }
        const label = button ? button.innerHTML : '';
        if (button) {
            button.disabled = true;
            button.innerHTML = `<span>${lp.render.esc(JE.t('jellyseerr_btn_requesting'))}</span><span class="je-lp-spinner"></span>`;
        }
        try {
            await api.requestMedia(tmdbId, 'movie', {}, false, details);
        } catch (error) {
            if (error?.status === 409) {
                announce(ph);
                return;
            }
            if (button) {
                button.disabled = false;
                button.innerHTML = label;
            }
            if (ui.isQuotaError?.(error)) {
                await ui.showQuotaErrorDialog(error, 'movie');
                return;
            }
            let message = JE.t('jellyseerr_btn_error');
            if (error?.status === 403) {
                const code = error.responseJSON?.code;
                message = JE.t(code ? `jellyseerr_err_${code}` : 'jellyseerr_err_no_request_permission');
            } else if (error?.responseJSON?.message) {
                message = error.responseJSON.message;
            }
            JE.toast(lp.render.esc(message), 4000);
        }
    }

    lp.requests = {
        preselectedSeasons,
        isRequested,
        markRequested,
        reset,
        userStatus,
        requestPlaceholder
    };

})(window.JellyfinEnhanced);
