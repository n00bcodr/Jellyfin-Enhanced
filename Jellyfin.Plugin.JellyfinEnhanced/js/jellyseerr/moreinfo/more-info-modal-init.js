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

/**
 * Open the more info modal for a movie or TV show
 * @param {number} tmdbId - The TMDB ID
 * @param {string} mediaType - 'movie' or 'tv'
 * @param {{season?: number, episode?: number}|undefined} scope - The season/episode a title action opened it for
 * @param {Object|Node|Event} owner - The owner (required, D46S2-R6): the operation a title action submitted, a viewer's
 *   native owner, or the node or press it is opened from. The window opens only while it is current (and is still the
 *   newest opening) and belongs to its scope.
 */
moreInfoModal.open = async function(tmdbId, mediaType, scope, owner) {
    const generation = ++openGeneration;
    const submitted = JE.captureSubmitted(owner);
    if (!submitted.owner) return;
    try {
        // Fetch details first so the modal can open immediately
        const data = await internal.fetchMediaDetails(tmdbId, mediaType);
        if (generation !== openGeneration || !submitted.current()) return;
        if (!data) {
            internal.showError('jellyseerr_modal_load_failed');
            return;
        }

        // Render modal immediately: the window opens only as its owner's effect, admitted now, before anything else is
        // touched (D46S2-R9-1, audit S2).
        if (!JE.admitSurface(submitted.owner, 'the More Info window', () => generation === openGeneration)) return;
        if (!showModal(data, mediaType, scope, submitted)) return;
        const openedModal = state.currentModal;

        // For TV shows, backfill missing season metadata (poster, overview, airDate) from TMDB/episodes
        if (mediaType === 'tv' && data.seasons?.some(s => s.episodeCount > 0 && (!s.airDate || !s.posterPath))) {
            internal.backfillSeasonMetadata(tmdbId, data);
        }

        // Fetch ratings in the background and populate when ready
        internal.fetchRatings(tmdbId, mediaType, { publicDetails: data.jePublicDetails === true })
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
        if (generation !== openGeneration || !submitted.current()) return;
        // Seerr won't answer for this viewer, or the server won't show them the title: said, not an error.
        if (!internal.isExplained?.(error)) console.error('Error opening more info modal:', error);
        internal.showError(internal.errorKey ? internal.errorKey(error, 'jellyseerr_modal_load_failed') : 'jellyseerr_modal_load_failed');
    }
}

/**
 * Refresh modal data and update displays. The answer renders only for the window's newest intent; the button's busy
 * state clears in `finally` whatever happens to the answer, once no other Refresh of it is still reading (D46S2-R7-6).
 */
async function refreshModalData(data, mediaType, modal, refreshBtn) {
    const newest = JE.surfaceIntent(modal, JE.ownerOf(modal));
    const read = startRead(modal);
    const shown = () => state.currentModal === modal && !modal._isClosing && newest() && read.newest();
    refreshBtn._jeRefreshing = (refreshBtn._jeRefreshing || 0) + 1;
    try {
        // Show loading state on button
        refreshBtn.classList.add('loading');
        refreshBtn.disabled = true;

        // Fetch fresh data
        const freshData = await internal.fetchMediaDetails(data.id, mediaType);
        if (!shown()) return;
        if (!freshData) {
            internal.showError('jellyseerr_modal_refresh_failed');
            return;
        }

        // Update data object with fresh info
        read.drawn();
        Object.assign(data, freshData);

        // Re-render the action buttons/chips to show updated status (chip, downloads, request button)
        internal.renderActions(data, mediaType);
        if (mediaType === 'tv') {
            internal.enrichSeasonCardsWithJellyfinLinks(data, modal);
        }
    } catch (error) {
        if (!shown()) return;
        if (!internal.isExplained?.(error)) console.error('Error refreshing modal data:', error);
        internal.showError(internal.errorKey ? internal.errorKey(error, 'jellyseerr_modal_refresh_failed') : 'jellyseerr_modal_refresh_failed');
    } finally {
        if (--refreshBtn._jeRefreshing === 0) {
            refreshBtn.classList.remove('loading');
            refreshBtn.disabled = false;
        }
    }
}

/**
 * The window's reads of its title's state, in the order they started (D46S2-R10-9): an answer is drawn only while no read
 * that started later has been drawn, so an older answer never replaces a newer one (the standard and 4K rereads of two
 * completions keep the newer state).
 */
function startRead(modal) {
    const mine = modal._jeReads = (modal._jeReads || 0) + 1;
    return { newest: () => (modal._jeDrawn || 0) <= mine, drawn: () => { modal._jeDrawn = Math.max(modal._jeDrawn || 0, mine); } };
}

/**
 * Show the modal with media information
 */
function showModal(data, mediaType, scope, submitted) {
    // Replace the current modal without canceling this open operation.
    closeCurrentModal();

    // These are UI selection hints for this opening, never fields added to cached provider metadata.
    data = { ...data };
    delete data.jeActionScope;
    if (mediaType === 'tv' && Number.isInteger(scope?.season) && scope.season >= 0 && scope.season <= 65535 &&
        (scope.episode == null || Number.isInteger(scope.episode) && scope.episode >= 0 && scope.episode <= 65535))
        data.jeActionScope = { season: scope.season, ...(scope.episode != null ? { episode: scope.episode } : {}) };

    const modal = document.createElement('div');
    modal.className = 'je-more-info-modal';
    modal.innerHTML = internal.buildModalContent(data, mediaType);
    // Tag modal so async updates only apply to the current item
    modal.dataset.tmdbId = String(data.id || '');
    modal.dataset.mediaType = mediaType;
    modal.jeActionScope = data.jeActionScope;

    // Opened for a title action: the window is in that operation's scope, with everything opened from it (its 4K popup,
    // the Collection and request modals); once the operation ends, it takes no more input and closes.
    modal._releaseScope = JE.openSurface(modal, () => { if (state.currentModal === modal) moreInfoModal.close(); }, submitted.owner);
    if (!modal._releaseScope) return false;
    // The window's reads (Refresh, a TV request's refresh) and the writes answering into it render only for its newest
    // intent while their owner is current (JE.surfaceIntent, JE.publication).

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
                // The press's owner (D46S2-R7-1), taken before its details are read: a title action's operation that
                // pressed it, else the window's.
                JE.jellyseerrUI.showCollectionRequestModal(collectionId, collectionName, null, { operation: JE.ownerOf(e), origin: modal });
            }
        });
    }

    document.body.appendChild(modal);
    state.currentModal = modal;

    // Add Escape key handler: only while the window is the topmost surface (a form or popup opened over it takes its
    // own Escape; D46S2 audit S2).
    const handleEscape = (e) => {
        if (e.key === 'Escape' && JE.isTopmostSurface(modal)) {
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

    // Completions published into this window (D46S2-R8-2, R9-5, R10-6): its own requests and the forms opened from it
    // publish here; core selects the window and calls this only for a publication that reaches it now (its owner, the
    // window and its intent current), with a scoped handle. A movie's answer is drawn as it is (only the edition it was
    // for); a series re-reads its seasons' state from Seerr (a read that starts after the write, never one that was
    // already in flight: D46S2-R10-9), as a newest intent of that publication's identity.
    const handleRequested = async handle => {
        const { is4k, response } = handle.answer;
        if (mediaType === 'movie') {
            handle.mutate(() => { internal.applyRequested(data, is4k, response); internal.renderActions(data, mediaType); });
            return;
        }
        const newest = handle.intent(modal);
        const read = startRead(modal);
        const shown = () => state.currentModal === modal && !modal._isClosing && newest() && read.newest();
        try {
            // Refresh details to pull latest status/progress
            const fresh = await internal.fetchMediaDetails(data.id, 'tv');
            if (!shown()) return;
            read.drawn();
            if (fresh?.mediaInfo) {
                data.mediaInfo = fresh.mediaInfo;
            } else {
                // Fallback: mark requested
                const mediaInfo = data.mediaInfo || (data.mediaInfo = {});
                mediaInfo.status = mediaInfo.status || 2;
            }
        } catch (_) {
            if (!shown()) return;
            const mediaInfo = data.mediaInfo || (data.mediaInfo = {});
            mediaInfo.status = mediaInfo.status || 2;
        }
        internal.renderActions(data, mediaType);
        internal.enrichSeasonCardsWithJellyfinLinks(data, modal);
    };
    modal._cleanupRequestListener = JE.followPublications({ selector: '.je-more-info-modal', within: modal }, handleRequested);

    // Let other surfaces add to the modal (Requests & downloads: the status pill).
    document.dispatchEvent(new CustomEvent('jellyseerr-more-info-opened', { detail: { modal, data, mediaType, scope } }));

    // Trigger animation
    setTimeout(() => modal.classList.add('active'), 10);
    return true;
}

/**
 * Close the modal
 */
function closeCurrentModal() {
    if (state.currentModal) {
        if (state.currentModal._isClosing) return;
        state.currentModal._isClosing = true;
        state.currentModal._releaseScope?.();

        // Clean up TV request listener if exists
        if (state.currentModal._cleanupRequestListener) {
            state.currentModal._cleanupRequestListener();
        }
        // Clean up Escape key listener if exists
        if (state.currentModal._cleanupEscapeListener) {
            state.currentModal._cleanupEscapeListener();
        }
        state.currentModal.classList.remove('active');
        // The fading modal keeps its DOM for the exit animation but takes no more input.
        state.currentModal.setAttribute('inert', '');
        state.currentModal.style.pointerEvents = 'none';
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
        closeCurrentModal();
    };

    // Remove rendered metadata synchronously, then reopen from the current server projection. The replacement is the
    // replaced window's: it inherits that window's owner, taken before it closes, and opens only while it is current
    // (D46S2-R6-1); an ended operation's window just closes.
    window.addEventListener('je-spoiler-policy-changed', event => {
        const modal = state.currentModal;
        if (!modal || modal._isClosing) return;
        const type = modal.dataset.mediaType;
        const id = Number(modal.dataset.tmdbId);
        if (event.detail?.type && (type !== event.detail.type || id !== Number(event.detail.tmdbId))) return;
        const owner = JE.ownerOf(modal);
        modal.replaceChildren();
        moreInfoModal.close();
        if (owner && owner.current() !== false) void moreInfoModal.open(id, type, modal.jeActionScope, owner);
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
