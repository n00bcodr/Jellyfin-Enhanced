import { installOnce, onDispose, selectionLease, enqueueWrite, pendingWrites } from './host';
import { host, registry, type HiddenHost } from './host';
/**
 * @file Hidden Content — initialization: wires the modules together and
 * exposes the frozen JE.initializeHiddenContent / JE.hiddenContent surface.
 * Split from hidden-content.js (code motion; body verbatim except the
 * two-line data reset, which moved into resetFromUserConfig() in
 * hidden-content-data.js where the hiddenData closure variable lives).
 * Loads last among the hidden-content-* modules.
 */
(function (JE: HiddenHost) {
    if(!installOnce(JE,'hidden-content-init'))return;
    'use strict';
    const internal = registry(JE, 'hiddenContent');

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
    let observerInstalled=false;
    JE.initializeHiddenContent = function () {
        resetFromUserConfig();
        injectCSS();
        if(!observerInstalled){setupNativeObserver();observerInstalled=true;}

        if (getHiddenCount() > 0) {
            setTimeout(filterAllNativeCards, INIT_FILTER_DELAY_MS);
        }

        // Expose public API
        JE.hiddenContent = {
            isLoadOk:internal.isLoadOk,
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

})(host.JellyfinEnhanced);
