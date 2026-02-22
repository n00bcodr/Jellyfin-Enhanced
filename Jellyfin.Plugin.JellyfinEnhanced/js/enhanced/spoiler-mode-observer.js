/**
 * @file Spoiler Mode Observer — card filtering, MutationObserver,
 * navigation hooks, and auto-enable features.
 *
 * Depends on: spoiler-mode.js (core), spoiler-mode-redaction.js,
 * and spoiler-mode-surfaces.js must load first.
 */
(function (JE) {
    'use strict';

    var core = JE._spoilerCore;
    if (!core) {
        console.warn('🪼 Jellyfin Enhanced: spoiler-mode-observer.js loaded before core');
        return;
    }

    // ============================================================
    // Local helpers
    // ============================================================

    /** @see core.getCardItemId — local alias for readability. */
    var getCardItemId = core.getCardItemId;

    /**
     * Detects the surface context of a card from its parent section headers.
     * Caches the result on the section element via core.sectionSurfaceCache (WeakMap).
     * @param {HTMLElement} card The card element.
     * @returns {string} The detected surface name (e.g. 'home', 'search', 'detail', 'recentlyAdded').
     */
    function getCardSurface(card) {
        var section = card.closest('.verticalSection, .section, .homeSectionsContainer, .itemsContainer');
        if (!section) return '';

        var cached = core.sectionSurfaceCache.get(section);
        if (cached !== undefined) return cached;

        var surface = '';

        // Check section header text for known surface patterns
        var headerEl = section.querySelector('.sectionTitle, .sectionTitle-sectionTitle, h2, h3');
        var headerText = headerEl ? (headerEl.textContent || '').trim().toLowerCase() : '';

        if (headerText.indexOf('recently added') !== -1 || headerText.indexOf('latest') !== -1) {
            surface = 'recentlyAdded';
        } else if (headerText.indexOf('continue watching') !== -1 || headerText.indexOf('next up') !== -1) {
            surface = 'home';
        } else if (headerText.indexOf('search') !== -1) {
            surface = 'search';
        }

        // Fall back to page-level context if section header is ambiguous
        if (!surface) {
            var hash = window.location.hash || '';
            if (hash.indexOf('search') !== -1) {
                surface = 'search';
            } else if (hash.indexOf('details') !== -1 || hash.indexOf('item') !== -1) {
                surface = 'detail';
            } else if (hash.indexOf('home') !== -1 || hash === '' || hash === '#/' || hash === '#/home.html') {
                surface = 'home';
            }
        }

        core.sectionSurfaceCache.set(section, surface);
        return surface;
    }

    /**
     * Detects the current surface from the URL hash.
     * @returns {string} The current surface ('home', 'search', 'detail', 'player', etc.).
     */
    function getCurrentSurface() {
        var hash = window.location.hash || '';
        if (hash.indexOf('video') !== -1 || hash.indexOf('nowplaying') !== -1) return 'player';
        if (hash.indexOf('search') !== -1) return 'search';
        if (hash.indexOf('details') !== -1 || hash.indexOf('item') !== -1) return 'detail';
        if (hash.indexOf('home') !== -1 || hash === '' || hash === '#/' || hash === '#/home.html') return 'home';
        if (hash.indexOf('list') !== -1 || hash.indexOf('library') !== -1) return 'library';
        return '';
    }

    /**
     * Checks whether a given surface should have spoiler protection applied.
     * @param {string} surface The surface name.
     * @returns {boolean} True if the surface should be protected.
     */
    function shouldProtectSurface(surface) {
        var settings = core.getSettings();
        if (settings.enabled === false) return false;

        switch (surface) {
            case 'home': return settings.protectHome !== false;
            case 'search': return settings.protectSearch !== false;
            case 'recentlyAdded': return settings.protectRecentlyAdded !== false;
            case 'detail': return true;
            case 'library': return true;
            case 'player': return settings.protectOverlay !== false;
            default: return true;
        }
    }

    // ============================================================
    // Special card processors
    // ============================================================

    /**
     * Processes an episode card that lacks season/episode numbers in its data attributes.
     * Fetches the item from the API to determine whether it should be redacted.
     * @param {HTMLElement} card The card element.
     * @param {string} itemId The episode Jellyfin ID.
     * @param {string} seriesId The parent series Jellyfin ID.
     * @returns {Promise<void>}
     */
    async function processEpisodeWithoutNumbers(card, itemId, seriesId) {
        if (!core.isValidId(itemId)) return;

        try {
            var item = await ApiClient.ajax({
                type: 'GET',
                url: ApiClient.getUrl('/Items/' + itemId, {
                    Fields: 'UserData,ParentIndexNumber,IndexNumber'
                }),
                dataType: 'json'
            });

            if (!item) return;

            if (core.shouldRedactEpisode(item)) {
                var pastBoundary = await core.isEpisodePastBoundary(
                    seriesId,
                    item.ParentIndexNumber || 0,
                    item.IndexNumber || 0
                );

                if (pastBoundary !== false && core.redactCard) {
                    core.redactCard(card, {
                        ParentIndexNumber: item.ParentIndexNumber,
                        IndexNumber: item.IndexNumber,
                        IndexNumberEnd: item.IndexNumberEnd || null
                    });
                }
            }
        } catch (err) {
            console.warn('🪼 Jellyfin Enhanced: Error processing episode without numbers', itemId, err);
        }
    }

    /**
     * Processes a season card — blurs artwork if any unwatched episode exists
     * past the user's watch boundary.
     * @param {HTMLElement} card The card element.
     * @param {string} itemId The season Jellyfin ID.
     * @returns {Promise<void>}
     */
    async function processSeasonCard(card, itemId) {
        if (!core.isValidId(itemId)) return;

        try {
            var item = await ApiClient.ajax({
                type: 'GET',
                url: ApiClient.getUrl('/Items/' + itemId, {
                    Fields: 'SeriesId'
                }),
                dataType: 'json'
            });

            if (!item || !item.SeriesId) return;
            if (!core.isProtected(item.SeriesId)) return;

            var boundary = await core.computeBoundary(item.SeriesId);
            if (!boundary) {
                // No boundary means nothing watched — blur the season
                core.blurCardArtwork(card);
                core.bindCardReveal(card);
                return;
            }

            var seasonNum = item.IndexNumber || 0;
            if (seasonNum > boundary.season) {
                if (core.blurCardArtwork) core.blurCardArtwork(card);
                if (core.bindCardReveal) core.bindCardReveal(card);
            }
        } catch (err) {
            console.warn('🪼 Jellyfin Enhanced: Error processing season card', itemId, err);
        }
    }

    // ============================================================
    // Main card processor
    // ============================================================

    /**
     * Processes a single card element for spoiler protection.
     * Determines item type, checks protection status, and applies
     * appropriate redaction (blur, text replacement, etc.).
     *
     * FIX: Uses `else if` for season check so season cards never
     * fall through into the episode path.
     *
     * @param {HTMLElement} card The card or list-item element.
     * @returns {Promise<void>}
     */
    async function processCard(card) {
        var settings = core.getSettings();
        if (settings.enabled === false) return;
        if (core.revealAllActive) {
            card.setAttribute(core.SCANNED_ATTR, '1');
            return;
        }

        var itemId = getCardItemId(card);
        if (!itemId) return;

        // Avoid reprocessing
        if (card.hasAttribute(core.PROCESSED_ATTR)) {
            card.setAttribute(core.SCANNED_ATTR, '1');
            return;
        }
        card.setAttribute(core.PROCESSED_ATTR, '1');

        // Check surface-level protection
        var surface = getCardSurface(card);
        var currentSurface = getCurrentSurface();
        var effectiveSurface = surface || currentSurface;
        if (!shouldProtectSurface(effectiveSurface)) {
            card.setAttribute(core.SCANNED_ATTR, '1');
            return;
        }

        try {
            var cardType = (card.dataset?.type || '').toLowerCase();

            // ---- Directly protected items (series, movie, collection) ----
            if (core.isProtected(itemId)) {
                if (cardType === 'movie') {
                    var watched = await core.isMovieWatched(itemId);
                    if (!watched) {
                        if (core.blurCardArtwork) core.blurCardArtwork(card);
                        if (core.bindCardReveal) core.bindCardReveal(card);
                    }
                } else if (cardType === 'series' || cardType === 'boxset') {
                    // Series/BoxSet cards just get a blur
                    if (core.blurCardArtwork) core.blurCardArtwork(card);
                    if (core.bindCardReveal) core.bindCardReveal(card);
                }
                card.setAttribute(core.SCANNED_ATTR, '1');
                return;
            }

            // ---- Collection membership: movie belongs to a protected BoxSet ----
            if (cardType === 'movie') {
                var collectionId = await core.getProtectedCollectionForMovie(itemId);
                if (collectionId) {
                    var movieWatched = await core.isMovieWatched(itemId);
                    if (!movieWatched) {
                        if (core.blurCardArtwork) core.blurCardArtwork(card);
                        if (core.bindCardReveal) core.bindCardReveal(card);
                    }
                    card.setAttribute(core.SCANNED_ATTR, '1');
                    return;
                }
            }

            // ---- Episode cards ----
            // Jellyfin-web's card builder does not set data-seriesid,
            // data-parentindexnumber, or data-indexnumber on cards, so we
            // always fetch from the API via processEpisodeWithoutNumbers.
            if (cardType === 'episode') {
                var seriesId = await core.getParentSeriesId(itemId);

                if (!seriesId || !core.isProtected(seriesId)) {
                    card.setAttribute(core.SCANNED_ATTR, '1');
                    return;
                }

                await processEpisodeWithoutNumbers(card, itemId, seriesId);
                card.setAttribute(core.SCANNED_ATTR, '1');
                return;
            }

            // ---- Season cards (else if prevents fall-through from episode path) ----
            else if (cardType === 'season') {
                await processSeasonCard(card, itemId);
                card.setAttribute(core.SCANNED_ATTR, '1');
                return;
            }

            // ---- Unrecognized card types: try parent series lookup ----
            if (!cardType || (cardType !== 'movie' && cardType !== 'series' && cardType !== 'boxset')) {
                var parentSeriesId = await core.getParentSeriesId(itemId);
                if (parentSeriesId && core.isProtected(parentSeriesId)) {
                    core.blurCardArtwork(card);
                    core.bindCardReveal(card);
                }
            }

        } catch (err) {
            console.warn('🪼 Jellyfin Enhanced: Error processing card', itemId, err);
        }

        card.setAttribute(core.SCANNED_ATTR, '1');
    }

    // ============================================================
    // Batch card filters
    // ============================================================

    /**
     * Filters only cards that have not yet been processed by spoiler mode.
     * Uses the CARD_SEL_NEW selector to find unprocessed cards.
     */
    function filterNewCards() {
        if (core.protectedIdSet.size === 0) return;

        var cards = document.querySelectorAll(core.CARD_SEL_NEW);
        for (var i = 0; i < cards.length; i++) {
            var card = cards[i];
            if (!card.hasAttribute(core.PROCESSED_ATTR)) {
                processCard(card);
            }
        }
    }

    /**
     * Re-filters all cards on the page, first unredacting any previously redacted
     * cards that are no longer protected, then processing all cards fresh.
     * Called after settings changes or rule toggles.
     */
    function filterAllCards() {
        var settings = core.getSettings();
        if (settings.enabled === false) {
            core.clearAllRedactions();
            return;
        }

        // Unredact cards that may no longer need protection
        var redactedCards = document.querySelectorAll('[' + core.REDACTED_ATTR + ']');
        for (var i = 0; i < redactedCards.length; i++) {
            core.unredactCard(redactedCards[i]);
        }

        // Strip processing markers so all cards get re-evaluated
        var processedCards = document.querySelectorAll('[' + core.PROCESSED_ATTR + ']');
        for (var j = 0; j < processedCards.length; j++) {
            processedCards[j].removeAttribute(core.PROCESSED_ATTR);
            processedCards[j].removeAttribute(core.SCANNED_ATTR);
        }

        // Re-process every card
        var allCards = document.querySelectorAll(core.CARD_SEL);
        for (var k = 0; k < allCards.length; k++) {
            processCard(allCards[k]);
        }
    }

    /**
     * Processes the current page from scratch. Resets detail page state,
     * clears processing markers, and re-runs full card filtering.
     * Typically called after navigation or settings changes.
     */
    function processCurrentPage() {
        var settings = core.getSettings();

        // Reset detail page tracking
        core.lastDetailPageItemId = null;

        if (settings.enabled === false || core.protectedIdSet.size === 0) {
            core.clearAllRedactions();
            return;
        }

        // Strip all processing markers for a fresh scan
        var scannedCards = document.querySelectorAll(
            '[' + core.PROCESSED_ATTR + '], [' + core.SCANNED_ATTR + ']'
        );
        for (var i = 0; i < scannedCards.length; i++) {
            scannedCards[i].removeAttribute(core.PROCESSED_ATTR);
            scannedCards[i].removeAttribute(core.SCANNED_ATTR);
        }

        filterAllCards();
    }

    // ============================================================
    // Player OSD handling
    // ============================================================

    /**
     * Extracts the currently-playing item ID from the OSD or URL hash.
     * @returns {string|null} The playing item Jellyfin ID or null.
     */
    function getPlayerItemId() {
        // Try to get from OSD data attributes
        var osdEl = document.querySelector('.videoOsdBottom, .osdControls, .nowPlayingBar');
        if (osdEl) {
            var id = osdEl.dataset?.id || osdEl.dataset?.itemid || null;
            if (id) return id;
        }

        // Fall back to the URL hash
        var hash = window.location.hash || '';
        var params = new URLSearchParams(hash.split('?')[1]);
        return params.get('id') || null;
    }

    /**
     * Handles MutationObserver events on the player OSD surface.
     * Checks if the currently playing item belongs to a protected series
     * and redacts the overlay if needed.
     */
    function handleOsdMutation() {
        var surface = getCurrentSurface();
        if (surface !== 'player') return;
        if (core.protectedIdSet.size === 0) return;

        var playingId = getPlayerItemId();
        if (playingId) {
            core.redactPlayerOverlay(playingId);
        }
    }

    // ============================================================
    // Detail page handler
    // ============================================================

    /**
     * Handles MutationObserver events on detail pages.
     * Detects the item being viewed, determines its type, and applies
     * appropriate redaction (episode list, collection, movie, episode detail).
     * Guards against re-entrant processing via core.detailPageProcessing.
     */
    async function handleDetailPageMutation() {
        var settings = core.getSettings();
        if (settings.enabled === false) return;
        if (core.protectedIdSet.size === 0) return;
        if (core.detailPageProcessing) return;

        var hash = window.location.hash || '';
        var params = new URLSearchParams(hash.split('?')[1]);
        var detailItemId = params.get('id') || '';

        if (!detailItemId || !core.isValidId(detailItemId)) return;

        // Avoid redundant processing for the same item
        if (core.lastDetailPageItemId === detailItemId) return;

        core.detailPageProcessing = true;

        try {
            var visiblePage = document.querySelector('#itemDetailPage:not(.hide)');
            if (!visiblePage) {
                core.detailPageProcessing = false;
                return;
            }

            // Pre-hide overview if conditions are met
            if (core.shouldPrehideDetailOverview()) {
                if (!core.shouldSkipDetailOverviewPrehide(visiblePage)) {
                    core.setDetailOverviewPending(true);
                }
            }

            core.lastDetailPageItemId = detailItemId;

            var item = await ApiClient.ajax({
                type: 'GET',
                url: ApiClient.getUrl('/Items/' + detailItemId, {
                    Fields: 'UserData,SeriesId,ParentIndexNumber,IndexNumber,Tags'
                }),
                dataType: 'json'
            });

            if (!item) {
                core.detailPageProcessing = false;
                return;
            }

            var itemType = item.Type || '';

            // Add toggle button for supported types
            if (core.addSpoilerToggleButton) {
                core.addSpoilerToggleButton(detailItemId, itemType, visiblePage);
            }

            // Check and auto-enable by tag
            if (core.checkAndAutoEnableByTag) {
                core.checkAndAutoEnableByTag(detailItemId, item);
            }

            // Apply redaction based on item type
            if (itemType === 'Series') {
                if (core.isProtected(detailItemId)) {
                    if (core.redactEpisodeList) {
                        await core.redactEpisodeList(detailItemId, visiblePage);
                    }
                }
            } else if (itemType === 'Season') {
                var seasonSeriesId = item.SeriesId || '';
                if (seasonSeriesId && core.isProtected(seasonSeriesId)) {
                    if (core.redactEpisodeList) {
                        await core.redactEpisodeList(detailItemId, visiblePage);
                    }
                }
            } else if (itemType === 'BoxSet') {
                if (core.isProtected(detailItemId)) {
                    if (core.redactCollectionPage) {
                        await core.redactCollectionPage(detailItemId, visiblePage);
                    }
                }
            } else if (itemType === 'Movie') {
                if (core.isProtected(detailItemId)) {
                    if (core.redactMovieDetailPage) {
                        await core.redactMovieDetailPage(detailItemId, visiblePage);
                    }
                } else {
                    // Check collection membership
                    var movieCollectionId = await core.getProtectedCollectionForMovie(detailItemId);
                    if (movieCollectionId) {
                        if (core.redactMovieDetailPage) {
                            await core.redactMovieDetailPage(detailItemId, visiblePage);
                        }
                    }
                }
            } else if (itemType === 'Episode') {
                var epSeriesId = item.SeriesId || '';
                if (epSeriesId && core.isProtected(epSeriesId)) {
                    if (core.redactEpisodeDetailPage) {
                        await core.redactEpisodeDetailPage(item, visiblePage);
                    }
                }
            }

            core.setDetailOverviewPending(false);

        } catch (err) {
            console.warn('🪼 Jellyfin Enhanced: Error in detail page mutation handler', err);
        } finally {
            core.detailPageProcessing = false;
        }
    }

    // ============================================================
    // Debounced handlers
    // ============================================================

    var debouncedFilter = JE.helpers?.debounce
        ? JE.helpers.debounce(function () { requestAnimationFrame(filterNewCards); }, core.FILTER_DEBOUNCE_MS)
        : filterNewCards;

    var debouncedDetailPageHandler = JE.helpers?.debounce
        ? JE.helpers.debounce(handleDetailPageMutation, core.TOGGLE_RESCAN_DELAY_MS)
        : handleDetailPageMutation;

    var debouncedOsdHandler = JE.helpers?.debounce
        ? JE.helpers.debounce(handleOsdMutation, core.OSD_MUTATION_DEBOUNCE_MS)
        : handleOsdMutation;

    // ============================================================
    // Unified MutationObserver
    // ============================================================

    /**
     * Unified MutationObserver callback. Routes DOM mutations to the
     * appropriate handler based on the current surface.
     * Uses performance-optimized for-loops for mutation iteration.
     * @param {MutationRecord[]} mutations The observed mutation records.
     */
    function handleMutations(mutations) {
        var settings = core.getSettings();
        if (settings.enabled === false) return;
        if (core.protectedIdSet.size === 0) return;

        var surface = getCurrentSurface();
        var hasCardMutations = false;
        var hasDetailMutations = false;
        var hasOsdMutations = false;

        for (var i = 0; i < mutations.length; i++) {
            var mutation = mutations[i];

            if (mutation.type !== 'childList' || mutation.addedNodes.length === 0) continue;

            for (var j = 0; j < mutation.addedNodes.length; j++) {
                var node = mutation.addedNodes[j];
                if (node.nodeType !== 1) continue; // Element nodes only

                // Check if the added node is or contains a card
                if (node.matches && (node.matches(core.CARD_SEL) || node.querySelector && node.querySelector(core.CARD_SEL))) {
                    hasCardMutations = true;
                }

                // Check for detail page content changes
                if (surface === 'detail') {
                    if (node.matches && (
                        node.matches('#itemDetailPage, .detailSection, .verticalSection, .detailVerticalSection') ||
                        node.closest && node.closest('#itemDetailPage')
                    )) {
                        hasDetailMutations = true;
                    }
                    if (node.querySelector && node.querySelector('.card[data-id], .listItem[data-id], .detailSection, .verticalSection')) {
                        hasDetailMutations = true;
                    }
                }

                // Check for OSD content changes
                if (surface === 'player') {
                    if (node.matches && (
                        node.matches('.osdTitle, .videoOsdTitle, .osd-title, .chapterCard, .nowPlayingPageTitle') ||
                        node.closest && node.closest('.videoOsdBottom, .osdControls')
                    )) {
                        hasOsdMutations = true;
                    }
                    if (node.querySelector && node.querySelector('.osdTitle, .videoOsdTitle, .chapterCard')) {
                        hasOsdMutations = true;
                    }
                }
            }
        }

        if (hasCardMutations) {
            debouncedFilter();
        }

        if (hasDetailMutations) {
            debouncedDetailPageHandler();
        }

        if (hasOsdMutations) {
            debouncedOsdHandler();
        }
    }

    /**
     * Creates and connects the unified MutationObserver on document.body.
     * Stores the observer reference in core.unifiedObserver.
     */
    function connectObserver() {
        if (core.unifiedObserver) return;

        var observer = new MutationObserver(handleMutations);
        observer.observe(document.body, {
            childList: true,
            subtree: true
        });

        core.unifiedObserver = observer;
    }

    /**
     * Disconnects and nulls the unified MutationObserver.
     */
    function disconnectObserver() {
        if (core.unifiedObserver) {
            core.unifiedObserver.disconnect();
            core.unifiedObserver = null;
        }
    }

    // ============================================================
    // Navigation hooks and setup
    // ============================================================

    /**
     * Sets up the onViewPage navigation hook and connects the MutationObserver.
     * On each navigation event:
     * - Resets detail page tracking state
     * - Clears pending navigation timers
     * - Removes episode protection CSS class
     * - Schedules surface-appropriate re-scan handlers via setTimeout
     */
    function setupObservers() {
        if (!JE.helpers?.onViewPage) {
            console.warn('🪼 Jellyfin Enhanced: helpers.onViewPage not available for spoiler observer setup');
            return;
        }

        JE.helpers.onViewPage(function (view, element, hash) {
            // Reset detail page state
            core.lastDetailPageItemId = null;
            core.detailPageProcessing = false;

            // Clear any pending navigation timers
            for (var i = 0; i < core.navigationTimers.length; i++) {
                clearTimeout(core.navigationTimers[i]);
            }
            core.navigationTimers = [];

            // Remove episode detail page protection class from all elements
            var protectedElements = document.querySelectorAll('.je-spoiler-episode-protected');
            for (var j = 0; j < protectedElements.length; j++) {
                protectedElements[j].classList.remove('je-spoiler-episode-protected');
            }

            var settings = core.getSettings();
            if (settings.enabled === false || core.protectedIdSet.size === 0) return;

            var surface = getCurrentSurface();

            // Schedule surface-appropriate handlers
            if (surface === 'detail') {
                // Detail pages need multiple scans as content loads asynchronously
                core.navigationTimers.push(
                    setTimeout(function () {
                        handleDetailPageMutation();
                        filterNewCards();
                    }, core.DETAIL_RESCAN_DELAY_MS)
                );

                core.navigationTimers.push(
                    setTimeout(function () {
                        handleDetailPageMutation();
                        filterNewCards();
                    }, core.DETAIL_FINAL_RESCAN_DELAY_MS)
                );
            } else if (surface === 'player') {
                core.navigationTimers.push(
                    setTimeout(function () {
                        handleOsdMutation();
                    }, core.PLAYER_OSD_DELAY_MS)
                );
            } else {
                // Home, search, library, etc.
                core.navigationTimers.push(
                    setTimeout(function () {
                        filterNewCards();
                    }, core.DETAIL_RESCAN_DELAY_MS)
                );
            }
        });

        // Connect observer if there are protected items
        if (core.protectedIdSet.size > 0) {
            connectObserver();
        }
    }

    // ============================================================
    // Auto-enable features
    // ============================================================

    /**
     * Checks whether an item should have spoiler mode auto-enabled
     * based on its tags matching the user's tagAutoEnable list.
     * @param {Object} item Jellyfin item object with Tags array.
     * @returns {boolean} True if the item should be auto-enabled.
     */
    function shouldAutoEnableByTag(item) {
        var data = core.getSpoilerData();
        var autoTags = data.tagAutoEnable;
        if (!Array.isArray(autoTags) || autoTags.length === 0) return false;
        if (!item?.Tags || !Array.isArray(item.Tags)) return false;

        var itemTagsLower = item.Tags.map(function (t) { return (t || '').toLowerCase(); });
        for (var i = 0; i < autoTags.length; i++) {
            var tag = (autoTags[i] || '').toLowerCase();
            if (tag && itemTagsLower.indexOf(tag) !== -1) {
                return true;
            }
        }

        return false;
    }

    /**
     * Auto-enables spoiler mode when the user starts playing an item for the first time.
     * Only triggers if the autoEnableOnFirstPlay setting is active and the item
     * is not already protected.
     * @param {string} itemId The Jellyfin ID of the item being played.
     * @returns {Promise<void>}
     */
    async function handleAutoEnableOnFirstPlay(itemId) {
        var data = core.getSpoilerData();
        if (!data.autoEnableOnFirstPlay) return;
        if (!itemId || !core.isValidId(itemId)) return;
        if (core.isProtected(itemId)) return;

        try {
            var item = await ApiClient.ajax({
                type: 'GET',
                url: ApiClient.getUrl('/Items/' + itemId, {
                    Fields: 'UserData,SeriesId,Type'
                }),
                dataType: 'json'
            });

            if (!item) return;

            // Determine the root item to protect (series for episodes/seasons, movie for movies)
            var protectId = null;
            var protectName = '';
            var protectType = '';

            if (item.Type === 'Episode' || item.Type === 'Season') {
                protectId = item.SeriesId;
                protectName = item.SeriesName || '';
                protectType = 'Series';
            } else if (item.Type === 'Movie') {
                protectId = item.Id;
                protectName = item.Name || '';
                protectType = 'Movie';
            } else if (item.Type === 'Series') {
                protectId = item.Id;
                protectName = item.Name || '';
                protectType = 'Series';
            }

            if (!protectId || !core.isValidId(protectId)) return;
            if (core.isProtected(protectId)) return;

            // Only auto-enable on first play (nothing watched yet)
            if (item.UserData?.Played) return;

            core.setRule({
                itemId: protectId,
                itemName: protectName,
                itemType: protectType,
                enabled: true
            });

            var safeName = core.escapeHtml(protectName);
            JE.toast('🛡️ Spoiler Mode auto-enabled for ' + safeName);

        } catch (err) {
            console.warn('🪼 Jellyfin Enhanced: Error in auto-enable on first play', itemId, err);
        }
    }

    /**
     * Checks if an item should be auto-enabled by its tags and enables
     * spoiler protection if a matching tag is found.
     * @param {string} itemId The Jellyfin item ID.
     * @param {Object} item The Jellyfin item object (must include Tags).
     */
    function checkAndAutoEnableByTag(itemId, item) {
        if (!itemId || !item) return;
        if (core.isProtected(itemId)) return;
        if (!shouldAutoEnableByTag(item)) return;

        var protectType = item.Type || '';
        var protectName = item.Name || item.SeriesName || '';

        // Only auto-enable for series, movies, and collections
        if (protectType !== 'Series' && protectType !== 'Movie' && protectType !== 'BoxSet') return;

        core.setRule({
            itemId: itemId,
            itemName: protectName,
            itemType: protectType,
            enabled: true
        });
    }

    // ============================================================
    // Register on core
    // ============================================================

    core.processCard = processCard;
    core.filterNewCards = filterNewCards;
    core.filterAllCards = filterAllCards;
    core.processCurrentPage = processCurrentPage;
    core.connectObserver = connectObserver;
    core.disconnectObserver = disconnectObserver;
    core.setupObservers = setupObservers;
    core.handleAutoEnableOnFirstPlay = handleAutoEnableOnFirstPlay;
    core.checkAndAutoEnableByTag = checkAndAutoEnableByTag;
    core.handleDetailPageMutation = handleDetailPageMutation;

})(window.JellyfinEnhanced);
