// /js/jellyseerr/moreinfo/more-info-modal-init.js
// Public surface + orchestration for the Jellyseerr more-info modal:
// open/close, modal lifecycle, refresh and navigation cleanup.
(function(JE) {
    'use strict';

    const moreInfoModal = JE.jellyseerrMoreInfo = JE.jellyseerrMoreInfo || {};
    JE.internals = JE.internals || {};
    // Shared state is seeded by more-info-modal-data.js, which plugin.js loads
    // first in this group.
    const internal = JE.internals.moreInfoModal;
    const state = internal.state;
    const logPrefix = '🪼 Jellyfin Enhanced: Jellyseerr More Info:';
    let openGeneration = 0;
    // Back (B on a TV controller) has to close the modal instead of leaving the
    // page behind it, so an open modal owns one history entry that Back pops.
    let historyEntryActive = false;
    let popPending = false;
    const FOCUSABLE = 'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Open the more info modal for a movie or TV show
 * @param {number} tmdbId - The TMDB ID
 * @param {string} mediaType - 'movie' or 'tv'
 */
moreInfoModal.open = async function(tmdbId, mediaType) {
    const generation = ++openGeneration;
    try {
        // Fetch details first so the modal can open immediately
        const data = await internal.fetchMediaDetails(tmdbId, mediaType);
        if (generation !== openGeneration) return;
        if (!data) {
            internal.showError('Failed to load media information');
            return;
        }

        // Render modal immediately
        showModal(data, mediaType);
        const openedModal = state.currentModal;

        // For TV shows, backfill missing season metadata (poster, overview, airDate) from TMDB/episodes
        if (mediaType === 'tv' && data.seasons?.some(s => s.episodeCount > 0 && (!s.airDate || !s.posterPath))) {
            internal.backfillSeasonMetadata(tmdbId, data);
        }

        // Fetch ratings in the background and populate when ready
        internal.fetchRatings(tmdbId, mediaType)
            .then((ratings) => {
                // Modal might have been closed or replaced; ensure we're updating the correct one
                if (state.currentModal !== openedModal || openedModal._isClosing) return;
                const modalTmdbId = state.currentModal?.dataset?.tmdbId;
                const modalMediaType = state.currentModal?.dataset?.mediaType;
                if (String(modalTmdbId) !== String(data.id) || modalMediaType !== mediaType) return;

                data.ratings = ratings;
                const mount = state.currentModal.querySelector('[data-mount="ratings"]');
                if (mount) {
                    const logos = internal.buildRatingLogos(ratings, data, mediaType, tmdbId);
                    mount.innerHTML = logos || '';
                }
            })
            .catch((error) => {
                console.error(`${logPrefix} Failed to fetch ratings for TMDB ID ${tmdbId}:`, error);
                // Silently fail; modal is already shown without ratings
            });
    } catch (error) {
        if (generation !== openGeneration) return;
        console.error('Error opening more info modal:', error);
        internal.showError('Failed to load media information');
    }
}

/**
 * Refresh modal data and update displays
 */
async function refreshModalData(data, mediaType, modal, refreshBtn) {
    try {
        // Show loading state on button
        refreshBtn.classList.add('loading');
        refreshBtn.disabled = true;

        // Fetch fresh data
        const freshData = await internal.fetchMediaDetails(data.id, mediaType);
        if (state.currentModal !== modal || modal._isClosing) return;
        if (!freshData) {
            internal.showError('Failed to refresh media information');
            refreshBtn.classList.remove('loading');
            refreshBtn.disabled = false;
            return;
        }

        // Update data object with fresh info
        Object.assign(data, freshData);

        // Re-render the action buttons/chips to show updated status (chip, downloads, request button)
        internal.renderActions(data, mediaType);
        if (mediaType === 'tv') {
            internal.enrichSeasonCardsWithJellyfinLinks(data, modal);
        }

        refreshBtn.classList.remove('loading');
        refreshBtn.disabled = false;

    } catch (error) {
        if (state.currentModal !== modal || modal._isClosing) return;
        console.error('Error refreshing modal data:', error);
        internal.showError('Failed to refresh modal data');
        refreshBtn.classList.remove('loading');
        refreshBtn.disabled = false;
    }
}

/**
 * Show the modal with media information
 */
function showModal(data, mediaType) {
    // Replace the current modal without canceling this open operation.
    closeCurrentModal();

    const modal = document.createElement('div');
    modal.className = 'je-more-info-modal';
    modal.innerHTML = internal.buildModalContent(data, mediaType);
    // Tag modal so async updates only apply to the current item
    modal.dataset.tmdbId = String(data.id || '');
    modal.dataset.mediaType = mediaType;

    // Add event listeners
    modal.addEventListener('click', (e) => {
        if (e.target === modal || e.target.classList.contains('modal-overlay')) {
            dismissModal();
        }
    });

    // Refresh button handler
    const refreshBtn = modal.querySelector('.modal-refresh');
    if (refreshBtn) {
        refreshBtn.addEventListener('click', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            await refreshModalData(data, mediaType, modal, refreshBtn);
        });
    }

    // Close button handler
    const closeBtn = modal.querySelector('.modal-close');
    if (closeBtn) {
        closeBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            dismissModal();
        });
    }

    // Collection button handler
    const collectionBtn = modal.querySelector('.je-collection-card-button');
    if (collectionBtn) {
        collectionBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const collectionId = parseInt(collectionBtn.dataset.collectionId, 10);
            const collectionName = collectionBtn.dataset.collectionName;
            if (collectionId && collectionName) {
                JE.jellyseerrUI.showCollectionRequestModal(collectionId, collectionName);
            }
        });
    }

    document.body.appendChild(modal);
    state.currentModal = modal;

    if (!historyEntryActive) {
        history.pushState(null, '', location.href);
        historyEntryActive = true;
    }

    // Add Escape key handler
    const handleEscape = (e) => {
        if (e.key === 'Escape') {
            dismissModal();
        }
    };
    document.addEventListener('keydown', handleEscape);
    // Capture phase so Jellyfin's focus manager never sees the D-pad while the
    // modal is open; otherwise focus walks out to the page behind it.
    const handleNav = (e) => trapDirectionalFocus(e, modal);
    document.addEventListener('keydown', handleNav, true);
    modal._cleanupEscapeListener = () => {
        document.removeEventListener('keydown', handleEscape);
        document.removeEventListener('keydown', handleNav, true);
    };

    // Render action buttons/chips after mount
    internal.renderActions(data, mediaType);
    if (mediaType === 'tv') {
        internal.enrichSeasonCardsWithJellyfinLinks(data, modal);
    }

    // Listen for TV season requests to update status
    if (mediaType === 'tv') {
        const handleTvRequest = async (e) => {
            if (!e.detail?.tmdbId || String(e.detail.tmdbId) !== String(data.id)) return;

            try {
                // Refresh details to pull latest status/progress
                const fresh = await internal.fetchMediaDetails(data.id, 'tv');
                if (state.currentModal !== modal || modal._isClosing) return;
                if (fresh?.mediaInfo) {
                    data.mediaInfo = fresh.mediaInfo;
                } else {
                    // Fallback: mark requested
                    const mediaInfo = data.mediaInfo || (data.mediaInfo = {});
                    mediaInfo.status = mediaInfo.status || 2;
                }
            } catch (_) {
                if (state.currentModal !== modal || modal._isClosing) return;
                const mediaInfo = data.mediaInfo || (data.mediaInfo = {});
                mediaInfo.status = mediaInfo.status || 2;
            }

            internal.renderActions(data, mediaType);
            internal.enrichSeasonCardsWithJellyfinLinks(data, modal);
        };
        document.addEventListener('jellyseerr-tv-requested', handleTvRequest);
        modal._cleanupTvListener = () => document.removeEventListener('jellyseerr-tv-requested', handleTvRequest);
    }

    // Trigger animation
    setTimeout(() => modal.classList.add('active'), 10);

    if (JE.core?.ui?.isTvLayout?.()) {
        setTimeout(() => {
            if (state.currentModal !== modal || modal._isClosing) return;
            const first = modal.querySelector('.je-more-info-actions button:not([disabled])')
                || modal.querySelector('.modal-close');
            first?.focus();
        }, 60);
    }
}

/**
 * Close from a user action (X, backdrop, Escape). Goes through history so the
 * entry pushed on open is consumed and the popstate handler closes the modal.
 */
function dismissModal() {
    if (!historyEntryActive) {
        moreInfoModal.close();
        return;
    }
    if (popPending) return;
    popPending = true;
    history.back();
}

/**
 * Keep D-pad / arrow navigation inside the modal.
 */
function trapDirectionalFocus(e, modal) {
    const dir = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' }[e.key];
    if (!dir || modal._isClosing || state.currentModal !== modal) return;
    // Another dialog (e.g. the season request modal) is on top and owns focus.
    if (document.body.classList.contains('jellyseerr-modal-is-open')) return;
    const active = document.activeElement;
    if (active && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName)) return;

    e.preventDefault();
    e.stopPropagation();

    const items = Array.from(modal.querySelectorAll(FOCUSABLE)).filter(el => el.getClientRects().length > 0);
    if (!items.length) return;
    if (!active || !modal.contains(active)) {
        items[0].focus();
        return;
    }

    const from = active.getBoundingClientRect();
    const fx = from.left + from.width / 2;
    const fy = from.top + from.height / 2;
    let best = null;
    let bestScore = Infinity;
    for (const el of items) {
        if (el === active) continue;
        const r = el.getBoundingClientRect();
        const dx = r.left + r.width / 2 - fx;
        const dy = r.top + r.height / 2 - fy;
        const along = dir === 'up' ? -dy : dir === 'down' ? dy : dir === 'left' ? -dx : dx;
        if (along <= 1) continue;
        const across = dir === 'up' || dir === 'down' ? Math.abs(dx) : Math.abs(dy);
        const score = along + across * 2;
        if (score < bestScore) { bestScore = score; best = el; }
    }
    best?.focus();
}

/**
 * Close the modal
 */
function closeCurrentModal() {
    if (state.currentModal) {
        if (state.currentModal._isClosing) return;
        state.currentModal._isClosing = true;

        // Clean up TV request listener if exists
        if (state.currentModal._cleanupTvListener) {
            state.currentModal._cleanupTvListener();
        }
        // Clean up Escape key listener if exists
        if (state.currentModal._cleanupEscapeListener) {
            state.currentModal._cleanupEscapeListener();
        }
        state.currentModal.classList.remove('active');
        // A replacement can open during the exit animation. Remove only the
        // modal this close owns, never the replacement stored in currentModal.
        const closingModal = state.currentModal;
        setTimeout(() => {
            closingModal.remove();
            if (state.currentModal === closingModal) state.currentModal = null;
            // Work held back while the modal covered the page (the
            // seamless-scroll fill) resumes on this.
            document.dispatchEvent(new CustomEvent('jellyseerr-more-info-closed'));
        }, 300);
    }
}

    moreInfoModal.close = function() {
        openGeneration++;
        historyEntryActive = false;
        popPending = false;
        closeCurrentModal();
    };

    window.addEventListener('popstate', function() {
        if (!historyEntryActive) return;
        // A dialog stacked above the modal closes first and keeps this entry.
        if (document.body.classList.contains('jellyseerr-modal-is-open')) return;
        moreInfoModal.close();
    });

    // Request permissions and details belong to the active account. Invalidate
    // pending opens immediately on identity changes, before navigation arrives.
    JE.session?.onUserChange('jellyseerr-more-info', () => moreInfoModal.close());

    // Close modal on page navigation
    document.addEventListener('viewshow', function() {
        moreInfoModal.close();
    });

    // Expose helpers used by other modules (e.g., item-details.js for the
    // Series page "Request More" button) so the unrequested-seasons check
    // logic does not need to be duplicated.
    moreInfoModal.checkForUnrequestedSeasons = internal.checkForUnrequestedSeasons;

})(window.JellyfinEnhanced);
