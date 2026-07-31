/**
 * @file Hidden Content — initialization: wires the modules together and
 * exposes the frozen JE.initializeHiddenContent / JE.hiddenContent surface.
 * Split from hidden-content.js (code motion; body verbatim except the
 * two-line data reset, which moved into resetFromUserConfig() in
 * hidden-content-data.js where the hiddenData closure variable lives).
 * Loads last among the hidden-content-* modules.
 */
(function (JE) {
    'use strict';

    JE.internals = JE.internals || {};
    const internal = JE.internals.hiddenContent = JE.internals.hiddenContent || {};

    const {
        injectCSS,
        setupNativeObserver,
        filterAllNativeCards,
        resetFromUserConfig,
        isHidden,
        isHiddenByTmdbId,
        isHiddenOnSurface,
        hideItem,
        unhideItem,
        confirmAndHide,
        getSettings,
        updateSettings,
        getAllHiddenItems,
        getHiddenCount,
        filterJellyseerrResults,
        filterCalendarEvents,
        filterRequestItems,
        filterNativeCards,
        showUndoToast,
        showManagementPanel,
        createItemCard,
        unhideAll,
        addLibraryHideButtons,
        removeLibraryHideButtons,
        refresh,
        markScopedHidden,
        flushPendingSave,
        fetchHiddenContentUsers,
        fetchUserHiddenItemsForAdmin,
        adminUnhideForUser,
        adminHideForUser,
    } = internal;

    /** Initial filter delay after module initialization. */
    const INIT_FILTER_DELAY_MS = 150;

    // ============================================================
    // Initialization
    // ============================================================

    /**
     * Initializes the hidden content module: loads data, rebuilds lookup sets,
     * injects CSS, sets up the MutationObserver, and exposes the public API.
     */
    JE.initializeHiddenContent = function () {
        resetFromUserConfig();
        injectCSS();
        setupNativeObserver();

        if (getHiddenCount() > 0) {
            setTimeout(filterAllNativeCards, INIT_FILTER_DELAY_MS);
        }

        // Expose public API
        JE.hiddenContent = {
            isHidden,
            isHiddenByTmdbId,
            isHiddenOnSurface,
            hideItem,
            unhideItem,
            confirmAndHide,
            getSettings,
            updateSettings,
            getAllHiddenItems,
            getHiddenCount,
            filterJellyseerrResults,
            filterCalendarEvents,
            filterRequestItems,
            filterNativeCards,
            showUndoToast,
            showManagementPanel,
            createItemCard,
            unhideAll,
            addLibraryHideButtons,
            removeLibraryHideButtons,
            refresh,
            markScopedHidden,
            flushPendingSave,
            // Admin-only cross-user visibility + editing
            fetchHiddenContentUsers,
            fetchUserHiddenItemsForAdmin,
            adminUnhideForUser,
            adminHideForUser
        };

        console.log(`🪼 Jellyfin Enhanced: Hidden Content initialized (${getHiddenCount()} items hidden)`);
    };

})(window.JellyfinEnhanced);
