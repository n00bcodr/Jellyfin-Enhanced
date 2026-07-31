/**
 * @file Hidden Content section wiring inside the settings panel (toggles,
 * surface filters, experimental options, manage button).
 * Split from ui.js (code motion; bodies verbatim).
 */
(function(JE) {
    'use strict';

    JE.internals = JE.internals || {};
    const internal = JE.internals.enhancedUi = JE.internals.enhancedUi || {};

    /**
     * Wires the Hidden Content settings-panel listeners.
     * @param {object} ctx Shared panel context assembled in ui-panel.js.
     */
    internal.wireHiddenContentListeners = function(ctx) {
        const { resetAutoCloseTimer } = ctx;

        // ============================================================
        // Hidden Content — settings panel event listeners
        // Binds change handlers for all hidden-content toggles:
        // master enable, button visibility, surface filters,
        // confirmation dialog, experimental collections, and
        // the "Manage Hidden Content" button.
        // ============================================================
        if (JE.hiddenContent) {
            const hiddenButtonToggles = [
                ['hiddenShowButtonJellyseerr', 'showButtonJellyseerr'],
                ['hiddenShowButtonLibrary', 'showButtonLibrary'],
                ['hiddenShowButtonDetails', 'showButtonDetails'],
                ['hiddenShowButtonCast', 'showButtonCast']
            ];
            for (const [id, key] of hiddenButtonToggles) {
                const el = document.getElementById(id);
                if (el) {
                    el.addEventListener('change', (e) => {
                        JE.hiddenContent.updateSettings({ [key]: e.target.checked });
                        if (key === 'showButtonLibrary' || key === 'showButtonCast') {
                            if (e.target.checked) {
                                JE.hiddenContent.addLibraryHideButtons();
                            } else {
                                JE.hiddenContent.removeLibraryHideButtons();
                                JE.hiddenContent.addLibraryHideButtons();
                            }
                        }
                        resetAutoCloseTimer();
                    });
                }
            }
            const hiddenSurfaceToggles = [
                ['hiddenFilterLibrary', 'filterLibrary'],
                ['hiddenFilterDiscovery', 'filterDiscovery'],
                ['hiddenFilterSearch', 'filterSearch'],
                ['hiddenFilterCalendar', 'filterCalendar'],
                ['hiddenFilterUpcoming', 'filterUpcoming'],
                ['hiddenFilterRecommendations', 'filterRecommendations'],
                ['hiddenFilterRequests', 'filterRequests'],
                ['hiddenFilterNextUp', 'filterNextUp'],
                ['hiddenFilterContinueWatching', 'filterContinueWatching']
            ];
            const masterToggle = document.getElementById('hiddenContentEnabledToggle');
            if (masterToggle) {
                masterToggle.addEventListener('change', (e) => {
                    JE.hiddenContent.updateSettings({ enabled: e.target.checked });
                    resetAutoCloseTimer();
                });
            }
            const buttonsToggle = document.getElementById('hiddenShowHideButtons');
            if (buttonsToggle) {
                buttonsToggle.addEventListener('change', (e) => {
                    JE.hiddenContent.updateSettings({ showHideButtons: e.target.checked });
                    if (e.target.checked) {
                        if (JE.hiddenContent.getSettings().showButtonLibrary) {
                            JE.hiddenContent.addLibraryHideButtons();
                        }
                    } else {
                        JE.hiddenContent.removeLibraryHideButtons();
                    }
                    resetAutoCloseTimer();
                });
            }
            for (const [id, key] of hiddenSurfaceToggles) {
                const el = document.getElementById(id);
                if (el) {
                    el.addEventListener('change', (e) => {
                        JE.hiddenContent.updateSettings({ [key]: e.target.checked });
                        resetAutoCloseTimer();
                    });
                }
            }
            const confirmToggle = document.getElementById('hiddenShowConfirmation');
            if (confirmToggle) {
                confirmToggle.addEventListener('change', (e) => {
                    JE.hiddenContent.updateSettings({ showHideConfirmation: e.target.checked });
                    localStorage.removeItem('je_hide_confirm_suppressed_until');
                    resetAutoCloseTimer();
                });
            }
            const experimentalCollections = document.getElementById('hiddenExperimentalCollections');
            if (experimentalCollections) {
                experimentalCollections.addEventListener('change', (e) => {
                    JE.hiddenContent.updateSettings({ experimentalHideCollections: e.target.checked });
                    if (!e.target.checked) {
                        JE.hiddenContent.removeLibraryHideButtons();
                        JE.hiddenContent.addLibraryHideButtons();
                    }
                    resetAutoCloseTimer();
                });
            }
            const manageBtn = document.getElementById('manageHiddenContentBtn');
            if (manageBtn) {
                manageBtn.addEventListener('click', () => {
                    if (JE.pluginConfig?.HiddenContentEnabled && JE.hiddenContentPage) {
                        JE.hiddenContentPage.showPage();
                    } else {
                        JE.hiddenContent.showManagementPanel();
                    }
                });
            }
        }
    };

})(window.JellyfinEnhanced);
