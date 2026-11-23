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
            // Saves a switch's change. updateSettings refuses (and says why) while the hidden list
            // is not loaded; the switch then goes back to the stored value and nothing else runs.
            const refused = (partial, e) => {
                if (JE.hiddenContent.updateSettings(partial) !== false) return false;
                e.target.checked = !e.target.checked;
                resetAutoCloseTimer();
                return true;
            };
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
                        if (refused({ [key]: e.target.checked }, e)) return;
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
                    if (refused({ enabled: e.target.checked }, e)) return;
                    resetAutoCloseTimer();
                });
            }
            const buttonsToggle = document.getElementById('hiddenShowHideButtons');
            if (buttonsToggle) {
                buttonsToggle.addEventListener('change', (e) => {
                    if (refused({ showHideButtons: e.target.checked }, e)) return;
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
                        if (refused({ [key]: e.target.checked }, e)) return;
                        resetAutoCloseTimer();
                    });
                }
            }
            const confirmToggle = document.getElementById('hiddenShowConfirmation');
            if (confirmToggle) {
                confirmToggle.addEventListener('change', (e) => {
                    if (refused({ showHideConfirmation: e.target.checked }, e)) return;
                    localStorage.removeItem('je_hide_confirm_suppressed_until');
                    resetAutoCloseTimer();
                });
            }
            const experimentalCollections = document.getElementById('hiddenExperimentalCollections');
            if (experimentalCollections) {
                experimentalCollections.addEventListener('change', (e) => {
                    if (refused({ experimentalHideCollections: e.target.checked }, e)) return;
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
                    // Both the page and fallback modal take over from this dialog.
                    ctx.closePanel();
                    // Placed as a tab or Plugin Page, the page never opens over the current view: manage here instead.
                    const pageShown = !!(JE.pluginConfig?.HiddenContentEnabled && JE.hiddenContentPage?.showPage());
                    if (!pageShown) {
                        JE.hiddenContent.showManagementPanel();
                    }
                });
            }
        }
    };

})(window.JellyfinEnhanced);
