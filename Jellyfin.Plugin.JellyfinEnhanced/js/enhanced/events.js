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
            JE.toast('🔗 Quick Connect');
        } else if (combo === activeShortcuts.PlayRandomItem && !JE.isVideoPage()) {
            e.preventDefault();
            document.getElementById('randomItemButton')?.click();
        } else if (combo === activeShortcuts.ClearAllBookmarks && !JE.isVideoPage()) {
            e.preventDefault();
            JE.userConfig.bookmarks.Bookmarks = {};
            JE.saveUserSettings('bookmarks.json', JE.userConfig.bookmarks);
            JE.toast(JE.t('toast_all_bookmarks_cleared'));
        }

        // --- Player-Only Shortcuts ---
        if (!JE.isVideoPage() || !video) return;

        switch (combo) {
            case activeShortcuts.BookmarkCurrentTime:
                e.preventDefault();
                e.stopPropagation();
                const videoId = document.title?.replace(/^Playing:\s*/, '').trim() || 'unknown';
                JE.userConfig.bookmarks.Bookmarks[videoId] = video.currentTime;
                JE.saveUserSettings('bookmarks.json', JE.userConfig.bookmarks);
                const h_set = Math.floor(video.currentTime / 3600);
                const m_set = Math.floor((video.currentTime % 3600) / 60);
                const s_set = Math.floor(video.currentTime % 60);
                const time_set = `${h_set > 0 ? `${h_set}:` : ''}${m_set.toString().padStart(h_set > 0 ? 2 : 1, '0')}:${s_set.toString().padStart(2, '0')}`;
                JE.toast(JE.t('toast_bookmarked_at', { time: time_set }));
                break;
            case activeShortcuts.GoToSavedBookmark:
                e.preventDefault();
                e.stopPropagation();
                const videoId_get = document.title?.replace(/^Playing:\s*/, '').trim() || 'unknown';
                const bookmarkTime = JE.userConfig.bookmarks.Bookmarks[videoId_get];
                if (bookmarkTime !== undefined) {
                    video.currentTime = bookmarkTime;
                    const h_get = Math.floor(bookmarkTime / 3600);
                    const m_get = Math.floor((bookmarkTime % 3600) / 60);
                    const s_get = Math.floor(bookmarkTime % 60);
                    const time_get = `${h_get > 0 ? `${h_get}:` : ''}${m_get.toString().padStart(h_get > 0 ? 2 : 1, '0')}:${s_get.toString().padStart(2, '0')}`;
                    JE.toast(JE.t('toast_returned_to_bookmark', { time: time_get }));
                } else {
                    JE.toast(JE.t('toast_no_bookmarks_found'));
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
                JE.openSettings(() => document.querySelector('.actionSheetContent button[data-id="stats"]')?.click());
                break;
            case activeShortcuts.SubtitleMenu:
                e.preventDefault();
                e.stopPropagation();
                const subtitleMenuTitle = Array.from(document.querySelectorAll('.actionSheetContent .actionSheetTitle')).find(el => el.textContent === 'Subtitles');
                if (subtitleMenuTitle) {
                    document.querySelector('.dialogBackdrop.dialogBackdropOpened')?.click();
                } else {
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
            } else {
                JE.stopAutoSkip();
            }
        };

        const observer = new MutationObserver(() => {
            runPageSpecificFunctions();
            JE.addRandomButton();
            onUserButtonLongPress();
        });

        observer.observe(document.body, { childList: true, subtree: true });
    }

    /**
     * Sets up listeners for the action sheet to add the "Remove" button.
     */
    function observeActionSheets() {
        const observer = new MutationObserver(() => {
            if (JE.currentSettings.removeContinueWatchingEnabled) {
                setTimeout(JE.addRemoveButton, 150);
            }
        });

        observer.observe(document.body, { childList: true, subtree: true });
    }

    /**
     * Listens for context menu clicks to identify "Continue Watching" items.
     */
    function addContextMenuListener() {
        /**
         * Helper function to check if an item is in Continue Watching and set context state
         */
        const checkAndSetContinueWatchingContext = (itemElement) => {
            if (!itemElement) return;

            JE.state.isContinueWatchingContext = false;
            JE.state.currentContextItemId = null;

            // Primary: Check for data-positionticks attribute
            // This indicates the item has playback progress and should be in Continue Watching
            const card = itemElement.closest('.card');
            const hasPositionTicks = card?.getAttribute('data-positionticks') || itemElement.getAttribute('data-positionticks');

            if (hasPositionTicks) {
                JE.state.isContinueWatchingContext = true;
                JE.state.currentContextItemId = itemElement.dataset.id;
                console.log('🪼 Jellyfin Enhanced: Continue Watching item detected via data-positionticks for item:', itemElement.dataset.id);
                return;
            }

            // Fallback: Check section-based approach
            const section = itemElement.closest('.verticalSection');
            if (section) {
                const titleElement = section.querySelector('.sectionTitle');
                const isDefaultSection = titleElement && titleElement.textContent.trim() === 'Continue Watching';

                if (section.classList.contains('ContinueWatching') || isDefaultSection) {
                    JE.state.isContinueWatchingContext = true;
                    JE.state.currentContextItemId = itemElement.dataset.id;
                    console.log('🪼 Jellyfin Enhanced: Continue Watching item detected via section title for item:', itemElement.dataset.id);
                }
            }
        };

        // Listen for three-dot menu button clicks
        document.body.addEventListener('mousedown', (e) => {
            if (!JE.currentSettings.removeContinueWatchingEnabled) return;

            const menuButton = e.target.closest('button[data-action="menu"]');
            if (!menuButton) return;

            const itemElement = menuButton.closest('[data-id]');
            checkAndSetContinueWatchingContext(itemElement);
        }, true);

        // Listen for right-click (contextmenu) events on card items
        document.body.addEventListener('contextmenu', (e) => {
            if (!JE.currentSettings.removeContinueWatchingEnabled) return;

            // Find the card or item element that was right-clicked
            const cardElement = e.target.closest('.card[data-id]');
            const itemElement = cardElement || e.target.closest('[data-id]');
            
            checkAndSetContinueWatchingContext(itemElement);
        }, true);
    }

    /**
     * Adds long-press functionality to the user button to open the settings panel.
     */
    function onUserButtonLongPress() {
        const userButton = document.querySelector('.headerUserButton');
        if (!userButton || userButton.dataset.longPressEnhanced) return;

        let pressTimer = null;
        const startPress = (e) => {
            if (e.button && e.button !== 0) return;
            userButton.classList.add('long-press-active');
            pressTimer = setTimeout(() => {
                userButton.classList.remove('long-press-active');
                JE.showEnhancedPanel();
                pressTimer = null;
            }, 750);
        };
        const cancelPress = () => {
            userButton.classList.remove('long-press-active');
            clearTimeout(pressTimer);
        };
        const handleClick = (e) => {
            if (!pressTimer) {
                e.preventDefault();
                e.stopPropagation();
            }
        };

        userButton.addEventListener('mousedown', startPress);
        userButton.addEventListener('mouseup', cancelPress);
        userButton.addEventListener('mouseleave', cancelPress);
        userButton.addEventListener('touchstart', startPress, { passive: true });
        userButton.addEventListener('touchend', cancelPress);
        userButton.addEventListener('touchcancel', cancelPress);
        userButton.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                startPress(e);
            }
        });
        userButton.addEventListener('keyup', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                cancelPress();
            }
        });
        userButton.addEventListener('click', handleClick, { capture: true });
        userButton.dataset.longPressEnhanced = 'true';
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
                    if (e.target.closest('.osdControls, .pause-screen-active, .jellyfin-enhanced-panel')) return;
                    handler(e);
                }
            };

            document.addEventListener('mousedown', videoPageCheck(JE.handleLongPressDown), true);
            document.addEventListener('mouseup', videoPageCheck(JE.handleLongPressUp), true);
            document.addEventListener('mouseleave', videoPageCheck(JE.handleLongPressCancel), true);
            document.addEventListener('touchstart', videoPageCheck(JE.handleLongPressDown), { capture: true, passive: true });
            document.addEventListener('touchend', videoPageCheck(JE.handleLongPressUp), { capture: true, passive: false });
            document.addEventListener('touchcancel', videoPageCheck(JE.handleLongPressCancel), { capture: true, passive: false });
        }

        // Listeners for tab visibility (auto-pause/resume/PiP)
        document.addEventListener('visibilitychange', () => {
            const video = document.querySelector('video');
            if (!video) return;

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