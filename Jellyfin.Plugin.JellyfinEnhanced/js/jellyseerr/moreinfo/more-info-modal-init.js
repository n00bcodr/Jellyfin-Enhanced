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

/**
 * Open the more info modal for a movie or TV show
 * @param {number} tmdbId - The TMDB ID
 * @param {string} mediaType - 'movie' or 'tv'
 */
moreInfoModal.open = async function(tmdbId, mediaType) {
    try {
        // Fetch details first so the modal can open immediately
        const data = await internal.fetchMediaDetails(tmdbId, mediaType);
        if (!data) {
            internal.showError('Failed to load media information');
            return;
        }

        // Render modal immediately
        showModal(data, mediaType);

        // For TV shows, backfill missing season metadata (poster, overview, airDate) from TMDB/episodes
        if (mediaType === 'tv' && data.seasons?.some(s => s.episodeCount > 0 && (!s.airDate || !s.posterPath))) {
            internal.backfillSeasonMetadata(tmdbId, data);
        }

        // Fetch ratings in the background and populate when ready
        internal.fetchRatings(tmdbId, mediaType)
            .then((ratings) => {
                // Modal might have been closed or replaced; ensure we're updating the correct one
                if (!state.currentModal) return;
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
    // Close existing modal if any
    moreInfoModal.close();

    const modal = document.createElement('div');
    modal.className = 'je-more-info-modal';
    modal.innerHTML = internal.buildModalContent(data, mediaType);
    // Tag modal so async updates only apply to the current item
    modal.dataset.tmdbId = String(data.id || '');
    modal.dataset.mediaType = mediaType;

    // Add event listeners
    modal.addEventListener('click', (e) => {
        if (e.target === modal || e.target.classList.contains('modal-overlay')) {
            moreInfoModal.close();
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
            moreInfoModal.close();
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

    // Add Escape key handler
    const handleEscape = (e) => {
        if (e.key === 'Escape') {
            moreInfoModal.close();
        }
    };
    document.addEventListener('keydown', handleEscape);
    modal._cleanupEscapeListener = () => document.removeEventListener('keydown', handleEscape);

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
                if (fresh?.mediaInfo) {
                    data.mediaInfo = fresh.mediaInfo;
                } else {
                    // Fallback: mark requested
                    const mediaInfo = data.mediaInfo || (data.mediaInfo = {});
                    mediaInfo.status = mediaInfo.status || 2;
                }
            } catch (_) {
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
}

/**
 * Close the modal
 */
moreInfoModal.close = function() {
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
        setTimeout(() => {
            if (document.body.contains(state.currentModal)) {
                document.body.removeChild(state.currentModal);
            }
            state.currentModal = null;
        }, 300);
    }
}

    // Close modal on page navigation
    document.addEventListener('viewshow', function() {
        if (state.currentModal) {
            moreInfoModal.close();
        }
    });

    // Expose helpers used by other modules (e.g., item-details.js for the
    // Series page "Request More" button) so the unrequested-seasons check
    // logic does not need to be duplicated.
    moreInfoModal.checkForUnrequestedSeasons = internal.checkForUnrequestedSeasons;

})(window.JellyfinEnhanced);
