/**
 * @file Manages all event listeners and observers for the plugin.
 */
(function(JE) {
    'use strict';

    /**
     * An always-active key listener specifically for opening the panel.
     * @param {KeyboardEvent} e The keyboard event.
     */
    function panelKeyListener(e) {
        // Don't open if the panel is already open or if typing in an input field.
        if (document.getElementById('jellyfin-enhanced-panel') || ['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) {
            return;
        }

        if (e.key === '?') {
            e.preventDefault();
            e.stopPropagation();
            JE.showEnhancedPanel();
        }
    }

    /**
     * The main key listener for all other shortcuts.
     * @param {KeyboardEvent} e The keyboard event.
     */
    JE.keyListener = (e) => {
        if (['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;

        const key = e.key;
        const combo = (e.shiftKey ? 'Shift+' : '') +
                      (e.metaKey ? 'Meta+' : '') +
                      (e.ctrlKey ? 'Ctrl+' : '') +
                      (e.altKey ? 'Alt+' : '') +
                      (key.match(/^[a-zA-Z]$/) ? key.toUpperCase() : key);

        const video = document.querySelector('video');
        const activeShortcuts = JE.state.activeShortcuts;

        // --- Global Shortcuts ---
        if (combo === activeShortcuts.OpenSearch) {
            e.preventDefault();
            document.querySelector('button.headerSearchButton')?.click();
            setTimeout(() => document.querySelector('input[type="search"]')?.focus(), 100);
            JE.toast(JE.t('toast_search'));
        } else if (combo === activeShortcuts.GoToHome) {
            e.preventDefault();
            window.location.hash = '#/home.html';
            JE.toast(JE.t('toast_home'));
        } else if (combo === activeShortcuts.GoToDashboard) {
            e.preventDefault();
            window.location.hash = '#/dashboard';
            JE.toast(JE.t('toast_dashboard'));
        } else if (combo === activeShortcuts.QuickConnect) {
            e.preventDefault();
            window.location.hash = '#/quickconnect';
            JE.toast(`${JE.icon(JE.IconName.LINK)} Quick Connect`);
        } else if (combo === activeShortcuts.PlayRandomItem && !JE.isVideoPage()) {
            e.preventDefault();
            document.getElementById('randomItemButton')?.click();
        }

        // --- Player-Only Shortcuts ---
        if (!JE.isVideoPage() || !video) return;

        switch (combo) {
            case activeShortcuts.BookmarkCurrentTime:
                e.preventDefault();
                e.stopPropagation();
                // Open bookmark modal to add/view bookmarks
                if (JE.bookmarks?.showModal) {
                    JE.bookmarks.showModal('add');
                } else {
                    console.warn('🪼 Jellyfin Enhanced: New bookmark system not loaded, using fallback');
                }
                break;
            case activeShortcuts.CycleAspectRatio:
                e.preventDefault();
                e.stopPropagation();
                JE.cycleAspect();
                break;
            case activeShortcuts.ShowPlaybackInfo:
                e.preventDefault();
                e.stopPropagation();
                // Check if stats dialog is already open
                const statsDialog = document.querySelector('.actionSheetContent button[data-id="stats"]');
                if (statsDialog) {
                    // Stats menu is open, close it
                    const dialogBackdropContainer = document.getElementById('dialogBackdropContainer');
                    const dialogContainer = document.getElementById('dialogContainer');
                    if (dialogBackdropContainer) dialogBackdropContainer.remove();
                    if (dialogContainer) dialogContainer.remove();
                } else {
                    // Stats menu is not open, open it
                    JE.openSettings(() => document.querySelector('.actionSheetContent button[data-id="stats"]')?.click());
                }
                break;
            case activeShortcuts.SubtitleMenu:
                e.preventDefault();
                e.stopPropagation();
                const subtitleMenuTitle = Array.from(document.querySelectorAll('.actionSheetContent .actionSheetTitle')).find(el => el.textContent === 'Subtitles');
                if (subtitleMenuTitle) {
                    // Subtitle menu is already open, close it
                    const dialogBackdrop = document.querySelector('.dialogBackdrop.dialogBackdropOpened');
                    const dialogContainer = document.querySelector('.dialogContainer');
                    if (dialogBackdrop) dialogBackdrop.remove();
                    if (dialogContainer) dialogContainer.remove();
                } else {
                    // Subtitle menu is not open, open it
                    document.querySelector('button.btnSubtitles')?.click();
                }
                break;
            case activeShortcuts.CycleSubtitleTracks:
                e.preventDefault();
                e.stopPropagation();
                JE.cycleSubtitleTrack();
                break;
            case activeShortcuts.CycleAudioTracks:
                e.preventDefault();
                e.stopPropagation();
                JE.cycleAudioTrack();
                break;
            case activeShortcuts.ResetPlaybackSpeed:
                e.preventDefault();
                e.stopPropagation();
                JE.resetPlaybackSpeed();
                break;
            case activeShortcuts.IncreasePlaybackSpeed:
                e.preventDefault();
                e.stopPropagation();
                JE.adjustPlaybackSpeed('increase');
                break;
            case activeShortcuts.DecreasePlaybackSpeed:
                e.preventDefault();
                e.stopPropagation();
                JE.adjustPlaybackSpeed('decrease');
                break;
            case activeShortcuts.OpenEpisodePreview:
                e.preventDefault();
                e.stopPropagation();
                const popupFocusContainer = document.getElementById('popupFocusContainer');
                if (popupFocusContainer && popupFocusContainer.classList.contains('opened')) {
                    // Popup is already open, close it by removing all dialog elements
                    const dialogBackdropContainer = document.getElementById('dialogBackdropContainer');
                    const dialogContainer = document.getElementById('dialogContainer');

                    if (dialogBackdropContainer) dialogBackdropContainer.remove();
                    if (dialogContainer) dialogContainer.remove();
                } else {
                    // Popup is not open, try to open it
                    const popupPreviewButton = document.querySelector('button#popupPreviewButton.autoSize.paper-icon-button-light[is="paper-icon-button-light"]');
                    if (popupPreviewButton) {
                        popupPreviewButton.click();
                    }
                }
                break;
            case activeShortcuts.SkipIntroOutro:
                e.preventDefault();
                e.stopPropagation();
                JE.skipIntroOutro();
                break;
            case activeShortcuts.FrameStepBack:
                e.preventDefault();
                e.stopPropagation();
                JE.frameStep('back');
                break;
            case activeShortcuts.FrameStepForward:
                e.preventDefault();
                e.stopPropagation();
                JE.frameStep('forward');
                break;
            case activeShortcuts.JumpToLastPosition:
                e.preventDefault();
                e.stopPropagation();
                JE.jumpToLastPosition();
                break;
        }

        if (key.match(/^[0-9]$/)) {
            JE.jumpToPercentage(parseInt(key) * 10);
        }
    };

    /**
     * Sets up listeners for DOM changes to inject UI elements dynamically.
     */
    function setupDOMObserver() {
        const runPageSpecificFunctions = () => {
            if (JE.isVideoPage()) {
                JE.addOsdSettingsButton();
                JE.initializeAutoSkipObserver();
                JE.applySavedStylesWhenReady();
                // Attach seek tracker to the video element as soon as it exists
                const video = document.querySelector('video');
                if (video) JE.attachSeekTracker(video);
            } else {
                JE.stopAutoSkip();
            }
        };

        // Create managed observer for general DOM changes
        JE.helpers.createObserver(
            'dom-observer',
            JE.helpers.throttle(() => {
                runPageSpecificFunctions();
                JE.addRandomButton();
                JE.addUserPreferencesLink();
            }, 100),
            document.body,
            { childList: true, subtree: true }
        );
    }

    /**
     * Sets up the action-sheet observer that injects the "Remove" item.
     *
     * Injection is coalesced onto a requestAnimationFrame rather than a timer: rAF runs after
     * the mutation but BEFORE the browser paints the freshly-opened sheet, so the Remove item
     * is present on the sheet's first frame and never appears late to reflow it (which would
     * jank the open animation). Coalescing also means at most one pass per frame regardless of
     * how many mutations fire, and the handlers early-return cheaply when no sheet is open.
     */
    function observeActionSheets() {
        let scheduled = false;
        const runInjection = () => {
            scheduled = false;
            if (!JE.currentSettings.removeContinueWatchingEnabled) return;
            if (typeof JE.addRemoveButton === 'function') {
                JE.addRemoveButton();
            } else {
                console.warn('🪼 Jellyfin Enhanced: addRemoveButton not available');
            }
            // Also offer Remove in the multi-select / long-press menu (touch devices
            // with no per-item "…" button).
            if (typeof JE.addMultiSelectRemoveButton === 'function') {
                JE.addMultiSelectRemoveButton();
            }
        };

        JE.helpers.createObserver(
            'action-sheets',
            () => {
                if (scheduled) return;
                scheduled = true;
                requestAnimationFrame(runInjection);
            },
            document.body,
            { childList: true, subtree: true }
        );
    }

    /**
     * Listens for menu triggers to capture which home surface ("Continue Watching" or
     * "Next Up") an item belongs to, so the matching Remove button can be added to the
     * action sheet that opens next. Context is captured on the trigger (menu mousedown /
     * right-click) because that is the only moment the source card is known.
     */
    function addContextMenuListener() {
        /**
         * Records the item + its home surface (or clears it) for the action-sheet observer.
         * @param {Element|null} itemElement The element carrying the item's `data-id`.
         */
        const captureRemoveContext = (itemElement) => {
            if (!itemElement) { JE.state.removeContext = null; return; }

            const card = itemElement.closest('.card') || itemElement;
            const itemId = card?.dataset?.id || itemElement?.dataset?.id || null;
            if (!itemId) { JE.state.removeContext = null; return; }

            const surface = (typeof JE.detectCardSurface === 'function') ? JE.detectCardSurface(card) : null;
            JE.state.removeContext = { itemId, surface, card, ts: Date.now() };
            if (surface) {
                console.log(`🪼 Jellyfin Enhanced: ${surface} item detected for Remove action sheet:`, itemId);
            }
        };

        // Clicks/right-clicks inside an already-open action sheet or dialog are menu interactions,
        // not card triggers — capturing context there would bind to a menu row (e.g. "resume").
        const isInsideOpenMenu = (target) =>
            !!(target.closest && target.closest('.actionSheetContent, .actionSheet, .dialogContainer, dialog'));

        // Listen for three-dot menu button clicks
        document.body.addEventListener('mousedown', (e) => {
            if (!JE.currentSettings.removeContinueWatchingEnabled) return;

            const menuButton = e.target.closest('button[data-action="menu"]');
            if (!menuButton) return;

            const itemElement = menuButton.closest('.card[data-id]') || menuButton.closest('[data-id]');
            captureRemoveContext(itemElement);
        }, true);

        // Listen for right-click (contextmenu) / long-press on home cards
        document.body.addEventListener('contextmenu', (e) => {
            if (!JE.currentSettings.removeContinueWatchingEnabled) return;
            if (isInsideOpenMenu(e.target)) return;

            // Only real cards carry a removable home surface; ignore other [data-id] targets.
            captureRemoveContext(e.target.closest('.card[data-id]'));
        }, true);
    }

    /**
     * Initializes all event listeners for the core Jellyfin Enhanced script.
     */
    JE.initializeEnhancedScript = function() {
        // Check if local storage needs to be cleared by admin request
        const serverClearTimestamp = JE.pluginConfig.ClearLocalStorageTimestamp || 0;
        const localClearedTimestamp = parseInt(localStorage.getItem('jellyfinEnhancedLastCleared') || '0', 10);
        if (serverClearTimestamp > localClearedTimestamp) {
            localStorage.removeItem('jellyfinEnhancedSettings');
            localStorage.setItem('jellyfinEnhancedLastCleared', serverClearTimestamp.toString());
        }

        // Initial UI setup
        JE.injectGlobalStyles();
        JE.addPluginMenuButton();
        JE.applySavedStylesWhenReady();

        // Setup persistent listeners and observers
        setupDOMObserver();
        observeActionSheets();
        addContextMenuListener();

        // Always listen for the panel-opening key
        document.addEventListener('keydown', panelKeyListener);

        // Conditionally listen for all other shortcuts
        if (!JE.pluginConfig.DisableAllShortcuts) {
            document.addEventListener('keydown', JE.keyListener);
        }

        // Add Long Press listeners if enabled
        if (JE.currentSettings.longPress2xEnabled) {
            const videoPageCheck = (handler) => (e) => {
                if (JE.isVideoPage()) {
                    // Don't interfere with clicks on OSD buttons / the pause screen overlay / Enhanced Panel
                    if (e.target && e.target.closest && e.target.closest('.osdControls, .pause-screen-active, .jellyfin-enhanced-panel')) return;
                    handler(e);
                }
            };

            document.addEventListener('mousedown', videoPageCheck(JE.handleLongPressDown), true);
            document.addEventListener('mouseup', videoPageCheck(JE.handleLongPressUp), true);
            document.addEventListener('mousemove', videoPageCheck(JE.handleLongPressMove), true);
            document.addEventListener('click', videoPageCheck(JE.handleLongPressClick), true);
            document.addEventListener('mouseleave', videoPageCheck(JE.handleLongPressCancel), true);
            document.addEventListener('touchstart', videoPageCheck(JE.handleLongPressDown), { capture: true, passive: true });
            document.addEventListener('touchmove', videoPageCheck(JE.handleLongPressMove), { capture: true, passive: true });
            document.addEventListener('touchend', videoPageCheck(JE.handleLongPressUp), { capture: true, passive: false });
            document.addEventListener('touchcancel', videoPageCheck(JE.handleLongPressCancel), { capture: true, passive: false });
        }

        // Listeners for tab visibility (auto-pause/resume/PiP)
        document.addEventListener('visibilitychange', () => {
            const video = document.querySelector('video');
            if (!video) return;

            JE.attachSeekTracker(video);

            if (document.hidden) {
                if (!video.paused && JE.currentSettings.autoPauseEnabled) {
                    video.pause();
                    video.dataset.wasPlayingBeforeHidden = 'true';
                }
                if (JE.currentSettings.autoPipEnabled && !document.pictureInPictureElement) {
                    video.requestPictureInPicture().catch(err => console.error("🪼 Jellyfin Enhanced: Auto PiP Error:", err));
                }
            } else {
                if (video.paused && video.dataset.wasPlayingBeforeHidden === 'true' && JE.currentSettings.autoResumeEnabled) {
                    video.play();
                }
                delete video.dataset.wasPlayingBeforeHidden;
                if (JE.currentSettings.autoPipEnabled && document.pictureInPictureElement) {
                    document.exitPictureInPicture().catch(err => console.error("🪼 Jellyfin Enhanced: Auto PiP Error:", err));
                }
            }
        });
    };

})(window.JellyfinEnhanced);