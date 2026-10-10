// /js/jellyseerr/listplaceholders/listplaceholders-collection.js
// Collection (BoxSet) pages: a "Not in your library" section right after Jellyfin's
// `.collectionItems` (a sibling survives that block's re-renders), cards ordered by release
// date with TBA last. TMDB placeholders use JE's Seerr card; TV request buttons are handled
// here (the global handler only exists while Seerr search results are on) and open the
// season modal with the placeholder's season pre-ticked.
(function (JE) {
    'use strict';

    JE.internals = JE.internals || {};
    const lp = JE.internals.listPlaceholders = JE.internals.listPlaceholders || {};

    const POLL_DELAYS = [2000, 4000, 8000, 16000, 32000];
    const REFETCH_DEBOUNCE_MS = 1000;
    /** Cards built per slice, so hundreds of placeholders never block the main thread for long. */
    const CARD_CHUNK = 24;

    /**
     * Collection order: release date ascending, TBA last, then title.
     * @param {Array<Object>} placeholders
     * @returns {Array<Object>} A sorted copy.
     */
    function sortForCollection(placeholders) {
        return (placeholders || []).slice().sort((a, b) => {
            const da = a.releaseDate || '';
            const db = b.releaseDate || '';
            if (da !== db) {
                if (!da) return 1;
                if (!db) return -1;
                return da < db ? -1 : 1;
            }
            return String(a.title || '').localeCompare(String(b.title || ''));
        });
    }

    /**
     * Identity of what a card shows for status, to rebuild only cards whose state changed.
     * @param {Object} ph
     * @returns {string}
     */
    function statusSignature(ph) {
        return `${ph.status ?? ''}|${lp.requests.isRequested(ph) ? 1 : 0}|${lp.render.addingItemId(ph) || ''}|${lp.render.progressParts(ph).join(',')}`;
    }

    /**
     * Controller for one collection page.
     * @param {HTMLElement} page - .itemDetailPage element.
     * @param {Object} item - BoxSet item.
     * @returns {Object}
     */
    function createController(page, item) {
        const ctrl = {
            listId: lp.normalizeId(item.Id),
            listKind: 'collection',
            listName: item.Name || '',
            page,
            view: null,
            user: null,
            userPending: false,
            section: null,
            renderToken: 0,
            pollIndex: 0,
            pollTimer: null,
            refetchTimer: null,
            refetchAt: 0,
            addingSeen: new Set(),
            removedHere: new Set()
        };

        /** @returns {boolean} Whether the page still exists. */
        ctrl.isAlive = () => page.isConnected;

        /** @returns {boolean} Whether the page is the one on screen (jellyfin-web hides cached pages). */
        ctrl.isShown = () => ctrl.isAlive() && !page.classList.contains('hide');

        /**
         * Looks up a visible placeholder by id.
         * @param {string} id
         * @returns {Object|undefined}
         */
        ctrl.byId = (id) => (ctrl.view?.placeholders || []).find(p => p.id === id);

        /** @returns {Object} Card context. */
        ctrl.cardContext = () => ({
            canEdit: !!ctrl.view?.canEdit,
            seerrEnabled: !!ctrl.view?.seerrEnabled && JE.pluginConfig?.JellyseerrEnabled === true,
            user: ctrl.user
        });

        /**
         * Creates (or re-attaches) the section right after `.collectionItems`.
         * @returns {HTMLElement|null}
         */
        ctrl.ensureSection = () => {
            const anchor = page.querySelector('.collectionItems');
            if (!anchor) return null;
            if (ctrl.section && ctrl.section.isConnected) {
                if (anchor.nextElementSibling !== ctrl.section) anchor.after(ctrl.section);
                return ctrl.section;
            }
            lp.ensureStyles?.();
            const esc = lp.render.esc;
            const section = document.createElement('div');
            section.className = 'verticalSection je-lp-collection-section';
            section.setAttribute('data-je-lp-section', 'true');
            section.innerHTML = '<div class="sectionTitleContainer sectionTitleContainer-cards padded-left je-lp-section-head">'
                + `<h2 class="sectionTitle sectionTitle-cards">${esc(JE.t('listPlaceholders_section_title'))}</h2></div>`
                + '<div class="itemsContainer vertical-wrap padded-left padded-right je-lp-cards"></div>';
            section.addEventListener('click', ctrl.onClick, true);
            anchor.after(section);
            ctrl.section = section;
            return section;
        };

        /** Renders the section (cards in slices). */
        ctrl.render = () => {
            const view = ctrl.view;
            if (!view || !ctrl.isAlive()) return;
            const placeholders = sortForCollection(view.placeholders);
            if (!placeholders.length && !view.canEdit) {
                ctrl.removeSection();
                return;
            }
            const section = ctrl.ensureSection();
            if (!section) return;
            const head = section.querySelector('.je-lp-section-head');
            head.querySelector('h2').hidden = placeholders.length === 0;
            let bar = head.querySelector('.je-lp-toolbar');
            if (view.canEdit && !bar) {
                bar = lp.toolbar.create(ctrl);
                head.appendChild(bar);
            } else if (!view.canEdit && bar) {
                bar.remove();
                bar = null;
            }
            if (bar) lp.toolbar.update(bar, 0, placeholders.length);
            const cards = section.querySelector('.je-lp-cards');
            JE.jellyseerrUI?.releasePosters?.(cards);
            cards.textContent = '';
            const token = ++ctrl.renderToken;
            const context = ctrl.cardContext();
            let index = 0;
            /** Builds the next slice of cards. */
            const step = () => {
                if (token !== ctrl.renderToken || !cards.isConnected) return;
                const fragment = document.createDocumentFragment();
                const end = Math.min(index + CARD_CHUNK, placeholders.length);
                for (; index < end; index++) {
                    const ph = placeholders[index];
                    const card = lp.render.buildCard(ph, context);
                    card.__jeLpSignature = statusSignature(ph);
                    fragment.appendChild(card);
                }
                cards.appendChild(fragment);
                if (index < placeholders.length) setTimeout(step, 0);
            };
            step();
        };

        /** Rebuilds the cards whose status changed (status poll, requests). */
        ctrl.updateStatuses = () => {
            const cards = ctrl.section?.querySelector('.je-lp-cards');
            if (!cards || !ctrl.view) return;
            const context = ctrl.cardContext();
            let replaced = false;
            cards.querySelectorAll(':scope > .je-lp-card').forEach((card) => {
                const ph = ctrl.byId(card.getAttribute('data-je-lp-id'));
                if (!ph) return;
                const signature = statusSignature(ph);
                if (card.__jeLpSignature === signature) return;
                const next = lp.render.buildCard(ph, context);
                next.__jeLpSignature = signature;
                card.replaceWith(next);
                replaced = true;
            });
            // Detached cards' poster observers are released so they can be collected.
            if (replaced) JE.jellyseerrUI?.releasePosters?.();
        };

        /** Removes the section. */
        ctrl.removeSection = () => {
            if (ctrl.section) {
                JE.jellyseerrUI?.releasePosters?.(ctrl.section);
                ctrl.section.remove();
            }
            ctrl.section = null;
        };

        /**
         * Adopts a view from the server.
         * @param {Object} view
         */
        ctrl.applyView = (view) => {
            if (!view || lp.normalizeId(view.listId) !== ctrl.listId || !ctrl.isAlive()) return;
            const previous = ctrl.view;
            if (lp.isOlderView(view, previous)) return; // a late answer for an older revision
            ctrl.view = view;
            const sectionGone = !ctrl.section || !ctrl.section.isConnected;
            if (!previous || previous.rev !== view.rev || sectionGone || previous.placeholders.length !== view.placeholders.length) {
                ctrl.render();
            } else {
                ctrl.updateStatuses();
            }
            if (ctrl.swappedSince(previous, view)) ctrl.afterRealItemsAdded();
            ctrl.schedulePoll();
            lp.freshness.checkAdding(ctrl, view);
            ctrl.ensureUser();
        };

        /**
         * Whether a newer view shows items that went into the collection since the previous one
         * (B3), so Jellyfin's own cards above the section need a reload: a placeholder that left
         * without being removed on this page (swapped in, or linked to a title in the library), an
         * episodes placeholder with more episodes filled (each Episode item is added), or a season
         * placeholder's first filled episode (its Season item is added once; later episodes only
         * change the progress).
         * @param {Object|null} previous - The view shown before.
         * @param {Object} view - The new view.
         * @returns {boolean}
         */
        ctrl.swappedSince = (previous, view) => {
            if (!previous || !(view.rev > previous.rev)) return false;
            const now = new Map((view.placeholders || []).map(ph => [ph.id, ph]));
            let swapped = false;
            for (const ph of previous.placeholders || []) {
                const next = now.get(ph.id);
                if (!next) {
                    if (!ctrl.removedHere.delete(ph.id)) swapped = true;
                    continue;
                }
                const before = Number(ph.filledCount) || 0;
                const after = Number(next.filledCount) || 0;
                if (after > before && (next.kind === 'episodes' || before === 0)) swapped = true;
            }
            return swapped;
        };

        /**
         * Remembers a placeholder being removed from this page, so its disappearance isn't taken
         * for a swap (and forgets it again when the removal failed).
         * @param {string} placeholderId
         * @param {boolean} [removing=true] - false: the removal failed.
         */
        ctrl.noteRemoved = (placeholderId, removing = true) => {
            if (removing) ctrl.removedHere.add(placeholderId); else ctrl.removedHere.delete(placeholderId);
        };

        /**
         * Whether request buttons need the Seerr user status (cards built without it show "Offline").
         * @param {Object|null} view
         * @returns {boolean}
         */
        ctrl.needsUser = (view) => !ctrl.user && !!view?.seerrEnabled && JE.pluginConfig?.JellyseerrEnabled === true
            && (view.placeholders || []).length > 0;

        /**
         * Loads the Seerr user status once placeholders exist (e.g. the first one was just added)
         * and rebuilds the cards with it.
         */
        ctrl.ensureUser = () => {
            if (ctrl.userPending || !ctrl.needsUser(ctrl.view)) return;
            const epoch = lp.epochNow();
            ctrl.userPending = true;
            lp.requests.userStatus().then((user) => {
                ctrl.userPending = false;
                if (!lp.isCurrentEpoch(epoch) || !ctrl.isAlive() || ctrl.user) return;
                ctrl.user = user;
                ctrl.render();
            });
        };

        /** Polls with backoff while Seerr statuses are not ready yet (D2). */
        ctrl.schedulePoll = () => {
            clearTimeout(ctrl.pollTimer);
            const view = ctrl.view;
            if (!view || view.seerrStatusReady || !view.seerrEnabled) {
                ctrl.pollIndex = 0;
                return;
            }
            if (ctrl.pollIndex >= POLL_DELAYS.length) return;
            ctrl.pollTimer = setTimeout(() => ctrl.load(), POLL_DELAYS[ctrl.pollIndex++]);
        };

        /** Fetches and applies the view (shared with the "Missing from" discovery, B7) while the page is shown. */
        ctrl.load = async () => {
            if (!ctrl.isShown()) return;
            const epoch = lp.epochNow();
            let view;
            try {
                view = await lp.api.getView(ctrl.listId);
            } catch (error) {
                if (error?.status !== 404) console.warn('🪼 Jellyfin Enhanced: List placeholders: could not load the collection view', error);
                return;
            }
            // A page left meanwhile re-fetches when it is shown again (viewshow, B3).
            if (!lp.isCurrentEpoch(epoch) || !ctrl.isShown()) return;
            if (ctrl.needsUser(view)) {
                ctrl.user = await lp.requests.userStatus();
                if (!lp.isCurrentEpoch(epoch) || !ctrl.isShown()) return;
            }
            ctrl.applyView(view);
        };

        /**
         * Debounced re-fetch (LibraryChanged, a swap in progress, requests; B3).
         * @param {number} [delayMs] - Wait before the GET (default 1 s); an earlier pending one wins.
         */
        ctrl.scheduleRefetch = (delayMs = REFETCH_DEBOUNCE_MS) => lp.freshness.schedule(ctrl, delayMs);

        /** A request was announced: update cards now and fetch statuses shortly. */
        ctrl.onRequested = () => {
            ctrl.updateStatuses();
            ctrl.scheduleRefetch();
        };

        /** Real items were added: let Jellyfin re-render its collection cards. */
        ctrl.afterRealItemsAdded = () => {
            page.querySelectorAll('.collectionItems .itemsContainer').forEach((container) => {
                try { container.notifyRefreshNeeded?.(true); } catch (_) { /* ignore */ }
            });
        };

        /**
         * Capture-phase clicks in the section: "…" menus and TV / 4K request buttons of placeholder cards.
         * @param {MouseEvent} e
         */
        ctrl.onClick = (e) => {
            const card = e.target.closest?.('.je-lp-card');
            if (!card) return;
            const ph = ctrl.byId(card.getAttribute('data-je-lp-id'));
            if (!ph) return;
            const menuButton = e.target.closest('.je-lp-menu-btn');
            if (menuButton) {
                e.preventDefault();
                e.stopPropagation();
                lp.actions.showPlaceholderMenu(ctrl, ph, menuButton);
                return;
            }
            const popupItem = e.target.closest('.jellyseerr-4k-popup-item');
            const requestButton = e.target.closest('.jellyseerr-request-button');
            if (ph.mediaType === 'tv' && (requestButton || popupItem)) {
                if (requestButton?.disabled) return;
                e.preventDefault();
                e.stopPropagation();
                popupItem?.closest('.jellyseerr-4k-popup')?.remove();
                JE.jellyseerrUI.showSeasonSelectionModal(Number(ph.tmdbId), 'tv', ph.title, null, !!popupItem,
                    { preselectedSeasons: lp.requests.preselectedSeasons(ph) });
                return;
            }
            if (ph.mediaType === 'movie' && requestButton && !popupItem) {
                // JE's placeholder flow instead of the card button's own handler: a 409 (requested
                // elsewhere since the last status refresh) marks every matching row/card (B5).
                e.preventDefault();
                e.stopPropagation();
                if (!requestButton.disabled) lp.requests.requestPlaceholder(ph, requestButton);
                return;
            }
            if (ph.mediaType === 'movie' && popupItem && popupItem.dataset.action === 'request4k') {
                // Same as the global handler, which only exists while Seerr search results are on.
                e.preventDefault();
                e.stopPropagation();
                popupItem.closest('.jellyseerr-4k-popup')?.remove();
                const item = lp.render.toSeerrItem(ph);
                if (JE.jellyseerrAPI.shouldShowAdvanced()) {
                    JE.jellyseerrUI.showMovieRequestModal(Number(ph.tmdbId), ph.title, item, true);
                } else {
                    JE.jellyseerrAPI.requestMedia(Number(ph.tmdbId), 'movie', {}, true, item)
                        .then(() => JE.toast(JE.t('listPlaceholders_requested_4k', { title: lp.render.esc(ph.title) }), 3000))
                        .catch(error => JE.toast(lp.errorMessage(error), 4000));
                }
                return;
            }
            if (ph.kind === 'custom' && ctrl.view?.canEdit && !e.target.closest('button')) {
                const anchor = card.querySelector('.je-lp-menu-btn');
                if (anchor) {
                    e.preventDefault();
                    e.stopPropagation();
                    lp.actions.showPlaceholderMenu(ctrl, ph, anchor);
                }
            }
        };

        /**
         * Stops the timers and card slicing when the controller leaves lp.controllers (page dropped
         * by jellyfin-web, or user switch); a dropped page's posters are released.
         */
        ctrl.dispose = () => {
            clearTimeout(ctrl.pollTimer);
            clearTimeout(ctrl.refetchTimer);
            ctrl.pollTimer = ctrl.refetchTimer = null;
            ctrl.refetchAt = 0;
            ctrl.renderToken++;
            if (ctrl.section && !ctrl.isAlive()) JE.jellyseerrUI?.releasePosters?.(ctrl.section);
        };

        /** Takes a disposed controller back into use (its page is shown again, e.g. after a user switch). */
        ctrl.reactivate = () => {
            ctrl.view = null;
            ctrl.user = null;
            ctrl.pollIndex = 0;
            ctrl.addingSeen = new Set();
            ctrl.removedHere = new Set();
        };

        return ctrl;
    }

    /**
     * Attaches to (or refreshes) the collection page shown.
     * @param {HTMLElement} page
     * @param {Object} item - BoxSet item.
     * @returns {Object}
     */
    function attach(page, item) {
        let ctrl = page.__jeLpCollectionController;
        if (!ctrl) {
            ctrl = createController(page, item);
            page.__jeLpCollectionController = ctrl;
            lp.controllers.add(ctrl);
        } else if (!lp.controllers.has(ctrl)) {
            ctrl.reactivate();
            lp.controllers.add(ctrl);
        }
        ctrl.load();
        return ctrl;
    }

    /**
     * TMDB ids already in a collection as placeholders of a media type (B7: the
     * "Missing from <collection>" discovery leaves those out).
     * @param {string} listId
     * @param {'movie'|'tv'} mediaType
     * @returns {Promise<Set<number>>}
     */
    async function placeholderTmdbIds(listId, mediaType) {
        const view = await lp.api.getView(listId, { maxAgeMs: 5000 });
        const ids = new Set();
        for (const ph of view?.placeholders || []) {
            if (ph.mediaType === mediaType && ph.tmdbId) ids.add(Number(ph.tmdbId));
        }
        return ids;
    }

    lp.collection = { attach, createController, sortForCollection, placeholderTmdbIds };

})(window.JellyfinEnhanced);
