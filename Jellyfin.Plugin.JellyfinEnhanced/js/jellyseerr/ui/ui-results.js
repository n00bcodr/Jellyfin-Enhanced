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

    // The native Jellyfin search input is the only user-facing search control.
    // Kept as a no-op for callers shared with older builds.
    ui.updateJellyseerrIcon = function() {};

    function getNativeSearchLayoutContainer() {
        const input = document.querySelector('#searchTextInput');
        return input?.closest('.inputContainer') || input?.parentElement || null;
    }

    function clearNativeSearchSpace() {
        document.querySelectorAll('[data-jellyseerr-space="true"]').forEach(container => {
            container.style.marginBottom = container.dataset.jellyseerrPreviousMargin || '';
            delete container.dataset.jellyseerrPreviousMargin;
            delete container.dataset.jellyseerrSpace;
        });
        const host = document.getElementById('jellyseerr-search-host');
        if (host) {
            host.style.removeProperty('top');
            host.style.removeProperty('max-height');
        }
    }

    function reserveNativeSearchSpace(host) {
        const container = getNativeSearchLayoutContainer();
        if (!container) return;
        document.querySelectorAll('[data-jellyseerr-space="true"]').forEach(previous => {
            if (previous === container) return;
            previous.style.marginBottom = previous.dataset.jellyseerrPreviousMargin || '';
            delete previous.dataset.jellyseerrPreviousMargin;
            delete previous.dataset.jellyseerrSpace;
        });
        if (container.dataset.jellyseerrSpace !== 'true') {
            container.dataset.jellyseerrPreviousMargin = container.style.marginBottom || '';
            container.dataset.jellyseerrSpace = 'true';
        }
        requestAnimationFrame(() => {
            if (!host.classList.contains('is-open') || !container.isConnected) return;
            const top = Math.ceil(container.getBoundingClientRect().bottom + 8);
            host.style.top = `${top}px`;
            host.style.maxHeight = `calc(100dvh - ${top}px - env(safe-area-inset-bottom))`;
            container.style.marginBottom = `${Math.ceil(host.getBoundingClientRect().height) + 16}px`;
        });
    }

    let hostResizeObserver = null;
    let viewportListenersBound = false;
    function observeSearchHost(host) {
        if (hostResizeObserver || typeof ResizeObserver === 'undefined') return;
        hostResizeObserver = new ResizeObserver(() => {
            if (host.classList.contains('is-open')) reserveNativeSearchSpace(host);
        });
        hostResizeObserver.observe(host);
        if (!viewportListenersBound) {
            const reposition = () => {
                if (host.classList.contains('is-open')) reserveNativeSearchSpace(host);
            };
            window.addEventListener('resize', reposition, { passive: true });
            window.visualViewport?.addEventListener('resize', reposition, { passive: true });
            window.visualViewport?.addEventListener('scroll', reposition, { passive: true });
            viewportListenersBound = true;
        }
    }

    ui.clearJellyseerrSearchSpace = clearNativeSearchSpace;
    ui.ensureJellyseerrSearchSpace = function() {
        const host = document.getElementById('jellyseerr-search-host');
        if (host?.classList.contains('is-open')) reserveNativeSearchSpace(host);
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
     * Renders Seerr search results into the stable body-owned overlay host.
     * @param {Array} results - Array of search result items.
     * @param {string} query - The search query that generated these results.
     * @param {boolean} isJellyseerrOnlyMode - Whether the filter is active.
     * @param {boolean} isJellyseerrActive - If the server is reachable.
     * @param {boolean} jellyseerrUserFound - If the current user is linked.
     */
    ui.renderJellyseerrResults = function(results, query, isJellyseerrOnlyMode, isJellyseerrActive, jellyseerrUserFound) {
        console.log(`${logPrefix} Rendering results for query: "${query}"`);
        let host = document.getElementById('jellyseerr-search-host');
        if (!host) {
            host = document.createElement('div');
            host.id = 'jellyseerr-search-host';
            document.body.appendChild(host);
        }
        const isMobile = window.matchMedia('(max-width: 900px)').matches;
        const resultLimit = isMobile ? 8 : 20;
        const section = createJellyseerrSection(results.slice(0, resultLimit), isJellyseerrOnlyMode, isJellyseerrActive, jellyseerrUserFound);
        host.replaceChildren(section);
        host.classList.toggle('is-open', results.length > 0);
        observeSearchHost(host);
        if (results.length > 0) reserveNativeSearchSpace(host);
        else clearNativeSearchSpace();
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
