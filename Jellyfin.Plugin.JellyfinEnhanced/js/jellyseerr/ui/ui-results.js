// /js/jellyseerr/ui/ui-results.js
// Search-page result rendering: Seerr section, header icon, season
// status analysis and in-place result updates.
(function(JE) {
    'use strict';

    const ui = JE.jellyseerrUI = JE.jellyseerrUI || {};
    JE.internals = JE.internals || {};
    // Shared state is seeded by ui-icons.js, which plugin.js loads first
    // in this group.
    const internal = JE.internals.jellyseerrUi;
    const state = internal.state;
    const logPrefix = '🪼 Jellyfin Enhanced: Seerr UI:';
    const MediaStatus = JE.seerrStatus.MEDIA;
    const icons = internal.icons; // requires ui-icons.js to be loaded first
    const addTouchTapListener = JE.core.ui.addTouchTapListener;

    // Only one search-results reposition watcher may be live at a time; a newer
    // render must cancel the previous one (see renderJellyseerrResults).
    let pendingRepositionObserver = null;
    let pendingRepositionTimeout = null;

    // Keep card buttons in sync when a request is made from other surfaces (e.g., more info modal)
    function markCardRequested(tmdbId, mediaType, is4k = false) {
        const button = document.querySelector(`.jellyseerr-request-button[data-tmdb-id="${tmdbId}"]`);
        if (!button) return;

        const requestedLabel = JE?.t ? JE.t('jellyseerr_btn_requested') : 'Requested';
        const setPending = (target) => {
            target.innerHTML = `${icons.requested}<span>${requestedLabel}</span>`;
            target.classList.remove('jellyseerr-button-request');
            if (!target.classList.contains('jellyseerr-button-pending')) {
                target.classList.add('jellyseerr-button-pending');
            }
            target.disabled = true;
        };

        if (button.classList.contains('jellyseerr-split-main')) {
            setPending(button);
            const arrow = button.parentElement?.querySelector('.jellyseerr-split-arrow');
            if (arrow && is4k) {
                arrow.classList.add('jellyseerr-4k-pending');
                arrow.disabled = true;
            }
        } else {
            setPending(button);
        }

        const card = button.closest('.jellyseerr-card');
        const badge = card?.querySelector('.jellyseerr-status-badge');
        if (badge) {
            badge.innerHTML = icons.requested;
            badge.className = 'jellyseerr-status-badge status-requested';
            badge.style.display = 'flex';
        }
    }

    document.addEventListener('jellyseerr-media-requested', (e) => {
        const { tmdbId, mediaType, is4k } = e.detail || {};
        if (!tmdbId || !mediaType) return;
        markCardRequested(String(tmdbId), mediaType, is4k);
    });

    // ================================
    // UI MANAGEMENT FUNCTIONS
    // ================================

    /**
     * Updates the Seerr icon in the search field based on current state.
     * @param {boolean} isJellyseerrActive - If the server is reachable.
     * @param {boolean} jellyseerrUserFound - If the current user is linked.
     * @param {boolean} isJellyseerrOnlyMode - If the results are filtered.
     * @param {function} onToggleFilter - The function to call to toggle the filter.
     */
    ui.updateJellyseerrIcon = function(isJellyseerrActive, jellyseerrUserFound, isJellyseerrOnlyMode, onToggleFilter) {
        const anchor = document.querySelector('.searchFields .inputContainer') ||
                       document.querySelector('#searchPage .searchFields') ||
                       document.querySelector('#searchPage');
        if (!anchor) return;

        let icon = document.getElementById('jellyseerr-search-icon');
        if (!icon) {
            icon = document.createElement('img');
            icon.id = 'jellyseerr-search-icon';
            icon.className = 'jellyseerr-icon';
            icon.src = JE.cdn.selfhst('svg/seerr.svg');
            icon.alt = 'Seerr';

            let tapCount = 0;
            let tapTimer = null;
            const handleIconInteraction = () => {
                if (!isJellyseerrActive || !jellyseerrUserFound || !onToggleFilter) return;
                tapCount++;
                if (tapCount === 1) {
                    tapTimer = setTimeout(() => { tapCount = 0; }, 300);
                } else if (tapCount === 2) {
                    clearTimeout(tapTimer);
                    tapCount = 0;
                    onToggleFilter();
                }
            };

            icon.addEventListener('click', handleIconInteraction);
            // Tap detection (rather than a bare touchend) so a scroll gesture that
            // happens to start on the icon is not miscounted toward the double-tap
            // filter toggle; preventDefault() suppresses the synthetic click that
            // would otherwise double-count the tap via the click listener above.
            addTouchTapListener(icon, (e) => { e.preventDefault(); handleIconInteraction(); });
            icon.setAttribute('tabindex', '0');
            icon.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    if (!isJellyseerrActive || !jellyseerrUserFound || !onToggleFilter) return;
                    onToggleFilter();
                }
            });
            anchor.appendChild(icon);
        }

        icon.classList.remove('is-active', 'is-disabled', 'is-no-user', 'is-filter-active');
        if (isJellyseerrActive && jellyseerrUserFound) {
            icon.title = JE.t(isJellyseerrOnlyMode ? 'jellyseerr_icon_active_filter_tooltip' : 'jellyseerr_icon_active_tooltip');
            icon.classList.add('is-active');
            if (isJellyseerrOnlyMode) icon.classList.add('is-filter-active');
        } else if (isJellyseerrActive && !jellyseerrUserFound) {
            icon.title = JE.t('jellyseerr_icon_no_user_tooltip');
            icon.classList.add('is-no-user');
        } else {
            icon.title = JE.t('jellyseerr_icon_disabled_tooltip');
            icon.classList.add('is-disabled');
        }
    };

    /**
     * Analyzes season statuses to determine overall show status.
     * @param {Array} seasons - Array of season objects with status information.
     * @returns {object} - Analysis result with overall status and summary.
     */
    function analyzeSeasonStatuses(seasons) {
        if (!seasons || seasons.length === 0) return { overallStatus: 1, statusSummary: null, total: 0 };
        const regularSeasons = seasons.filter(s => s.seasonNumber > 0);
        const total = regularSeasons.length;
        if (total === 0) return { overallStatus: 1, statusSummary: null, total: 0 };

        const statusCounts = {
            available: regularSeasons.filter(s => s.status === MediaStatus.AVAILABLE).length,
            pending: regularSeasons.filter(s => s.status === MediaStatus.PENDING).length,
            processing: regularSeasons.filter(s => s.status === MediaStatus.PROCESSING).length,
            partiallyAvailable: regularSeasons.filter(s => s.status === MediaStatus.PARTIALLY_AVAILABLE).length,
            notRequested: regularSeasons.filter(s => s.status === MediaStatus.UNKNOWN).length
        };
        const requestedCount = statusCounts.pending + statusCounts.processing;
        const availableCount = statusCounts.available + statusCounts.partiallyAvailable;
        const accountedForCount = requestedCount + availableCount;
        let overallStatus, statusSummary = null;

        if (statusCounts.notRequested === 0) {
            overallStatus = (availableCount === total) ? MediaStatus.AVAILABLE : MediaStatus.DELETED;
            if (overallStatus === MediaStatus.DELETED) statusSummary = JE.t('jellyseerr_seasons_accounted_for', { count: accountedForCount, total });
        } else if (accountedForCount > 0) {
            overallStatus = (availableCount > 0) ? MediaStatus.PARTIALLY_AVAILABLE : MediaStatus.PROCESSING;
            statusSummary = (availableCount > 0) ? JE.t('jellyseerr_seasons_available_count', { count: availableCount, total }) : JE.t('jellyseerr_seasons_requested_count', { count: requestedCount, total });
        } else {
            overallStatus = MediaStatus.UNKNOWN;
        }

        // If every regular season is accounted for but the specials season (0) was never
        // requested, still surface a "Request More" affordance instead of marking the
        // show fully Available, so specials-only seasons remain requestable.
        if (overallStatus === MediaStatus.AVAILABLE) {
            const specialsSeason = seasons.find(s => s.seasonNumber === 0);
            if (specialsSeason && specialsSeason.status === MediaStatus.UNKNOWN) {
                overallStatus = MediaStatus.DELETED;
                statusSummary = JE.t('jellyseerr_seasons_accounted_for', { count: accountedForCount, total });
            }
        }

        return { overallStatus, statusSummary, total, availableCount };
    }

    /**
     * Removes every plugin-owned node injected into the search page (results
     * section and no-results replacement message) and restores the native
     * no-results message if positionSection hid it. React-safe: only removes
     * plugin-owned nodes and toggles a class on native ones.
     */
    ui.clearInjectedSearchResults = function() {
        document.querySelectorAll('.jellyseerr-section, .jellyseerr-no-results-message').forEach(el => el.remove());
        document.querySelectorAll('.jellyseerr-native-message-hidden').forEach(el => el.classList.remove('jellyseerr-native-message-hidden'));
    };

    /**
     * Renders Seerr search results into the search page with improved placement logic.
     * @param {Array} results - Array of search result items.
     * @param {string} query - The search query that generated these results.
     * @param {boolean} isJellyseerrOnlyMode - Whether the filter is active.
     * @param {boolean} isJellyseerrActive - If the server is reachable.
     * @param {boolean} jellyseerrUserFound - If the current user is linked.
     */
    ui.renderJellyseerrResults = function(results, query, isJellyseerrOnlyMode, isJellyseerrActive, jellyseerrUserFound) {
        console.log(`${logPrefix} Rendering results for query: "${query}"`);
        const searchPage = document.querySelector('#searchPage');
        if (!searchPage) {
            console.warn(`${logPrefix} #searchPage not found. Cannot render results.`);
            return;
        }

        if (pendingRepositionObserver) {
            pendingRepositionObserver.disconnect();
            pendingRepositionObserver = null;
        }
        if (pendingRepositionTimeout) {
            clearTimeout(pendingRepositionTimeout);
            pendingRepositionTimeout = null;
        }

        searchPage.querySelectorAll('.jellyseerr-section').forEach(section => section.remove());

        const sectionToInject = createJellyseerrSection(results, isJellyseerrOnlyMode, isJellyseerrActive, jellyseerrUserFound);

        const primaryCardTypes = ['movie', 'series'];

        /**
         * Finds the last Movies/Shows section in the search results, identified
         * by each card's data-type attribute rather than the (locale-dependent)
         * section title text.
         * @returns {HTMLElement|null}
         */
        function findLastPrimarySection() {
            const allSections = Array.from(searchPage.querySelectorAll('.verticalSection:not(.jellyseerr-section)'));
            for (let i = allSections.length - 1; i >= 0; i--) {
                const cardType = allSections[i].querySelector('[data-type]')?.dataset.type?.toLowerCase();
                if (cardType && primaryCardTypes.includes(cardType)) {
                    return allSections[i];
                }
            }
            return null;
        }

        /**
         * Places the section after Movies/Shows if found, otherwise appends
         * to the results container or search page.
         * @returns {boolean} True if positioned after a primary section or
         *   no-results message; false if using fallback placement.
         */
        function positionSection() {
            const noResultsMessage = searchPage.querySelector('.noItemsMessage:not(.jellyseerr-no-results-message)');
            if (noResultsMessage) {
                // The no-results message is React-owned, and React reuses the same
                // DOM node for the results container on a later query (both render
                // as plain keyless divs, and cached queries swap between them with
                // no <Loading/> commit in between). Rewriting its textContent here
                // would replace React's own text node, so the next reconciliation
                // of that div throws NotFoundError ("Failed to execute
                // 'removeChild' on 'Node'"). Never mutate its children — hide it
                // with a class and show a plugin-owned message beside it instead.
                noResultsMessage.classList.add('jellyseerr-native-message-hidden');

                let message = searchPage.querySelector('.jellyseerr-no-results-message');
                if (!message) {
                    message = document.createElement('div');
                    message.className = 'noItemsMessage centerMessage jellyseerr-no-results-message';
                }
                // Only write on change — this element is inside the subtree the
                // reposition MutationObserver below watches, so an unconditional
                // write re-triggers it every time, looping forever.
                const desiredText = JE.t('jellyseerr_no_results_jellyfin', { query });
                if (message.textContent !== desiredText) {
                    message.textContent = desiredText;
                }
                if (message.previousElementSibling !== noResultsMessage) {
                    noResultsMessage.parentElement.insertBefore(message, noResultsMessage.nextSibling);
                }
                if (sectionToInject.previousElementSibling !== message) {
                    message.parentElement.insertBefore(sectionToInject, message.nextSibling);
                }
                return true;
            }

            // Not (or no longer) in the no-results state: drop the replacement
            // message and restore the native one if a previous pass hid it.
            searchPage.querySelectorAll('.jellyseerr-no-results-message').forEach(el => el.remove());
            searchPage.querySelectorAll('.jellyseerr-native-message-hidden').forEach(el => el.classList.remove('jellyseerr-native-message-hidden'));

            const lastPrimary = findLastPrimarySection();
            if (lastPrimary) {
                if (sectionToInject.previousElementSibling !== lastPrimary) {
                    lastPrimary.after(sectionToInject);
                }
                return true;
            }

            const resultsContainer = searchPage.querySelector('.searchResults, [class*="searchResults"], .padded-top.padded-bottom-page');
            if (resultsContainer) {
                if (sectionToInject.parentElement !== resultsContainer || resultsContainer.lastElementChild !== sectionToInject) {
                    resultsContainer.appendChild(sectionToInject);
                }
            } else if (searchPage.lastElementChild !== sectionToInject) {
                searchPage.appendChild(sectionToInject);
            }
            return false;
        }

        positionSection();

        const observer = new MutationObserver(() => {
            if (!sectionToInject.isConnected) {
                observer.disconnect();
                return;
            }
            positionSection();
        });
        observer.observe(searchPage, { childList: true, subtree: true });
        pendingRepositionObserver = observer;
        pendingRepositionTimeout = setTimeout(() => observer.disconnect(), 5000);
    };

    /**
     * Creates the main Seerr results section.
     * @param {Array} results - Array of search result items.
     * @param {boolean} isJellyseerrOnlyMode - Whether the filter is active.
     * @param {boolean} isJellyseerrActive - If the server is reachable.
     * @param {boolean} jellyseerrUserFound - If the current user is linked.
     * @returns {HTMLElement} - Section element.
     */
    function createJellyseerrSection(results = [], isJellyseerrOnlyMode, isJellyseerrActive, jellyseerrUserFound) {
        const section = document.createElement('div');
        section.className = 'verticalSection emby-scroller-container jellyseerr-section';
        section.setAttribute('data-jellyseerr-section', 'true');

        const title = document.createElement('h2');
        title.className = 'sectionTitle sectionTitle-cards focuscontainer-x padded-left padded-right';
        title.textContent = isJellyseerrOnlyMode ? JE.t('jellyseerr_results_title') : JE.t('jellyseerr_discover_title');

        // Add a refresh button beside the results heading
        const refreshBtn = document.createElement('button');
        refreshBtn.className = 'jellyseerr-refresh-btn';
        refreshBtn.style.marginLeft = '0.5em';
        refreshBtn.style.verticalAlign = 'middle';
        refreshBtn.style.background = 'none';
        refreshBtn.style.border = 'none';
        refreshBtn.style.cursor = 'pointer';
        refreshBtn.style.display = 'inline-flex';
        refreshBtn.style.alignItems = 'center';
        refreshBtn.style.justifyContent = 'center';
        refreshBtn.style.padding = '0';
        const icon = document.createElement('span');
        icon.className = 'material-icons jellyseerr-refresh-icon';
        icon.textContent = 'refresh';
        icon.style.transition = 'transform 0.5s cubic-bezier(.4,2,.6,1)';
        refreshBtn.appendChild(icon);
        refreshBtn.addEventListener('click', function(e) {
            e.preventDefault();
            e.stopPropagation();
            icon.style.transform = 'rotate(360deg)';
            setTimeout(() => { icon.style.transform = ''; }, 500);
            document.dispatchEvent(new CustomEvent('jellyseerr-manual-refresh'));
        });
        title.appendChild(refreshBtn);
    if (!document.getElementById('jellyseerr-refresh-style')) {
        const style = document.createElement('style');
        style.id = 'jellyseerr-refresh-style';
        style.textContent = `
            .jellyseerr-refresh-btn:focus { outline: none; }
            .jellyseerr-refresh-icon { color: #fff; filter: opacity(0.6); }
            .jellyseerr-refresh-btn:hover .jellyseerr-refresh-icon { color: #fff; filter: opacity(0.9); }
        `;
        document.head.appendChild(style);
    }
        section.appendChild(title);

        const scrollerContainer = document.createElement('div');
        scrollerContainer.setAttribute('is', 'emby-scroller');
        scrollerContainer.className = 'padded-top-focusscale padded-bottom-focusscale emby-scroller';
        scrollerContainer.dataset.horizontal = "true";
        scrollerContainer.dataset.centerfocus = "card";

        const itemsContainer = document.createElement('div');
        itemsContainer.setAttribute('is', 'emby-itemscontainer');
        itemsContainer.className = 'focuscontainer-x itemsContainer scrollSlider';

        const isTvMode = document.querySelector('.alphaPicker-tv') !== null;
        if (isTvMode) {
            itemsContainer.classList.add('itemsContainer-tv');
            itemsContainer.classList.add('animatedScrollX');
        }

        results.forEach(item => {
            const card = internal.createJellyseerrCard(item, isJellyseerrActive, jellyseerrUserFound);
            itemsContainer.appendChild(card);
        });

        scrollerContainer.appendChild(itemsContainer);
        section.appendChild(scrollerContainer);
        return section;
    }

    /**
     * Updates existing Seerr results in the DOM with fresh data.
     * @param {Array} newResults - The new array of result items from the API.
     * @param {boolean} isJellyseerrActive - If the server is reachable.
     * @param {boolean} jellyseerrUserFound - If the current user is linked.
     */
    ui.updateJellyseerrResults = function(newResults, isJellyseerrActive, jellyseerrUserFound) {
        const existingButtons = document.querySelectorAll('.jellyseerr-request-button[data-tmdb-id]');
        if (existingButtons.length === 0) return;

        existingButtons.forEach(button => {
            const tmdbId = button.dataset.tmdbId;
            const newItem = newResults.find(item => item.id.toString() === tmdbId);
            if (!newItem) return;

            const oldItemJSON = button.dataset.searchResultItem;
            if (!oldItemJSON) return;

            // Simple check: compare JSON strings of mediaInfo
            const oldMediaInfo = JSON.parse(oldItemJSON).mediaInfo;
            const newMediaInfo = newItem.mediaInfo;
            if (JSON.stringify(oldMediaInfo) !== JSON.stringify(newMediaInfo)) {
                console.log(`${logPrefix} Status change detected for TMDB ID ${tmdbId}. Updating button.`);
                internal.configureRequestButton(button, newItem, isJellyseerrActive, jellyseerrUserFound);

                // If the popover for this item is currently visible, update it
                if (state.jellyseerrHoverPopover &&
                    state.jellyseerrHoverPopover.classList.contains('show') &&
                    state.jellyseerrHoverPopover.dataset.tmdbId === tmdbId) {

                    console.log(`${logPrefix} Active popover found for TMDB ID ${tmdbId}. Refreshing content.`);
                    const popoverContent = internal.fillHoverPopover(newItem);
                    if (popoverContent) {
                        const { clientX, clientY } = state.jellyseerrHoverPopover.dataset;
                        internal.positionHoverPopover(popoverContent, parseFloat(clientX), parseFloat(clientY));
                    } else {
                        ui.hideHoverPopover(); // Hide if there's no longer valid download data
                    }
                }
            }
        });
    };
    internal.markCardRequested = markCardRequested;
    internal.analyzeSeasonStatuses = analyzeSeasonStatuses;
    internal.createJellyseerrSection = createJellyseerrSection;

})(window.JellyfinEnhanced);
