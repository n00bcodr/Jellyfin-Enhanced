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
    const submitted = JE.captureSubmitted(owner);
    // Admitted before it touches any shared state (D46S2-R11-7): a stale or owner-less call never advances the opening
    // generation, so it cannot supersede the viewer's pending opening.
    if (!submitted.owner || !submitted.current()) return;
    const generation = ++openGeneration;
    // Feedback in the press's own frame: a title-free loading shell, admitted for the owner, before the details are read.
    const pending = JE.admitSurface(submitted.owner, 'the More Info window', () => generation === openGeneration) ? showShell(submitted) : null;
    try {
        // Fetch details first so the modal can open immediately
        const data = await internal.fetchMediaDetails(tmdbId, mediaType);
        if (generation !== openGeneration || !submitted.current()) return;
        if (!data) {
            dropShell(pending);
            internal.showError('jellyseerr_modal_load_failed');
            return;
        }

        // Render modal immediately: the window opens only as its owner's effect, admitted now, before anything else is
        // touched (D46S2-R9-1, audit S2).
        if (!JE.admitSurface(submitted.owner, 'the More Info window', () => generation === openGeneration)) return;
        if (!showModal(data, mediaType, scope, submitted, pending)) return;
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
        dropShell(pending);
        // Seerr won't answer for this viewer, or the server won't show them the title: said, not an error.
        if (!internal.isExplained?.(error)) console.error('Error opening more info modal:', error);
        internal.showError(internal.errorKey ? internal.errorKey(error, 'jellyseerr_modal_load_failed') : 'jellyseerr_modal_load_failed');
    } finally {
        // An opening that ended without its window (stale, refused, failed) takes its shell away.
        dropShell(pending);
    }
}

/** The pending opening's loading shell ({el, release}), at most one; null once it became the window or went. */
let shell = null;

/**
 * Draws the loading shell of an admitted opening: the window's backdrop with a busy line and Close, nothing about the
 * title, registered on the surface stack for the opening's owner (Escape, Back and Close cancel the opening). The
 * window is later drawn into the same element (showModal). Null when the stack refused it.
 */
function showShell(submitted) {
    // A shell never keeps a window from opening: before the translations have loaded it names its key.
    const say = key => (typeof JE.t === 'function' ? JE.t(key) : key);
    closeCurrentModal();
    const el = document.createElement('div');
    el.className = 'je-more-info-shell';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-busy', 'true');
    el.setAttribute('aria-label', say('title_actions_loading'));
    const box = document.createElement('div');
    box.className = 'je-more-info-shell-box';
    const busy = document.createElement('div');
    busy.className = 'je-more-info-shell-busy';
    busy.setAttribute('role', 'status');
    busy.textContent = say('title_actions_loading');
    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'je-more-info-shell-close';
    dismiss.setAttribute('aria-label', say('title_actions_close'));
    dismiss.textContent = '×';
    box.append(busy, dismiss);
    el.append(box);
    // Its close is the window's once it has become the window.
    const release = JE.openSurface(el, () => {
        if (shell?.el === el) moreInfoModal.close();
        else if (state.currentModal === el) closeCurrentModal();
    }, submitted.owner);
    if (!release) return null;
    el.addEventListener('click', (e) => { if (e.target === el && shell?.el === el) moreInfoModal.close(); });
    dismiss.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); if (shell?.el === el) moreInfoModal.close(); });
    document.body.appendChild(el);
    dismiss.focus();
    return shell = { el, release };
}

/** Takes the loading shell away (only `pending`, when given and still pending). */
function dropShell(pending) {
    if (!shell || (pending !== undefined && shell !== pending)) return;
    const drawn = shell;
    shell = null;
    drawn.release();
    drawn.el.remove();
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
function showModal(data, mediaType, scope, submitted, pending) {
    // The opening's loading shell (when it is still the pending one) becomes the window in place: the same surface.
    const adopted = pending && shell === pending ? pending : null;
    if (adopted) shell = null;
    // Replace the current modal without canceling this open operation.
    closeCurrentModal();

    // These are UI selection hints for this opening, never fields added to cached provider metadata.
    data = { ...data };
    delete data.jeActionScope;
    if (mediaType === 'tv' && Number.isInteger(scope?.season) && scope.season >= 0 && scope.season <= 65535 &&
        (scope.episode == null || Number.isInteger(scope.episode) && scope.episode >= 0 && scope.episode <= 65535))
        data.jeActionScope = { season: scope.season, ...(scope.episode != null ? { episode: scope.episode } : {}) };

    const modal = adopted ? adopted.el : document.createElement('div');
    // An adopted shell is already shown: the window is drawn over it without fading in again.
    modal.className = adopted ? 'je-more-info-modal active' : 'je-more-info-modal';
    modal.innerHTML = internal.buildModalContent(data, mediaType);
    if (adopted) {
        modal.removeAttribute('aria-busy');
        modal.removeAttribute('aria-label');
        // Named by its title, as the surface stack names a window it registers.
        const heading = modal.querySelector('h1, h2, h3, [role="heading"]');
        if (heading) { if (!heading.id) heading.id = `je-more-info-title-${openGeneration}`; modal.setAttribute('aria-labelledby', heading.id); }
    }
    // Tag modal so async updates only apply to the current item
    modal.dataset.tmdbId = String(data.id || '');
    modal.dataset.mediaType = mediaType;
    modal.jeActionScope = data.jeActionScope;

    // Opened for a title action: the window is in that operation's scope, with everything opened from it (its 4K popup,
    // the Collection and request modals); once the operation ends, it takes no more input and closes.
    // Its owner ending closes this window only (D46S2-R11-7): never the opening generation, so a newer opening the viewer
    // has pending is not superseded by an older window's lifecycle.
    modal._releaseScope = adopted ? adopted.release : JE.openSurface(modal, () => { if (state.currentModal === modal) closeCurrentModal(); }, submitted.owner);
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

    if (!adopted) document.body.appendChild(modal);
    state.currentModal = modal;
    // The shell's Close had focus and is gone: focus goes into the window, as the surface stack does when it opens one.
    if (adopted) JE.focusIn?.(modal, modal.querySelector('[autofocus]') || modal.querySelector('button:not([disabled]), [href], input:not([type="hidden"]), select, textarea, [tabindex]:not([tabindex="-1"])'));

    // Escape and every Back key reach the window through the surface stack only (D46S2-R12-3): the viewer's key, while
    // it is the topmost surface (a form, popup or host dialog over it takes its own).

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
    dropShell();
    if (state.currentModal) {
        if (state.currentModal._isClosing) return;
        state.currentModal._isClosing = true;
        state.currentModal._releaseScope?.();

        // Clean up TV request listener if exists
        if (state.currentModal._cleanupRequestListener) {
            state.currentModal._cleanupRequestListener();
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
