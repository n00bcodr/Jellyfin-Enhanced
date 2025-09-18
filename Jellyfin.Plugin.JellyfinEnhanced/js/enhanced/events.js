/**
 * @file Manages all event listeners and observers for the plugin.
 */
(function(JE) {
    'use strict';

    /**
     * The main key listener for all shortcuts.
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
        } else if (key === '?') {
            e.preventDefault();
            e.stopPropagation();
            JE.showEnhancedPanel();
        } else if (combo === activeShortcuts.PlayRandomItem && !JE.isVideoPage()) {
            e.preventDefault();
            document.getElementById('randomItemButton')?.click();
        } else if (combo === activeShortcuts.ClearAllBookmarks && !JE.isVideoPage()) {
            e.preventDefault();
            localStorage.removeItem('jellyfinEnhancedBookmarks');
            JE.toast(JE.t('toast_all_bookmarks_cleared'));
        }

        // --- Player-Only Shortcuts ---
        if (!JE.isVideoPage() || !video) return;

        switch (combo) {
            case activeShortcuts.BookmarkCurrentTime:
                e.preventDefault();
                e.stopPropagation();
                const videoId = document.title?.replace(/^Playing:\s*/, '').trim() || 'unknown';
                const bookmarks = JSON.parse(localStorage.getItem('jellyfinEnhancedBookmarks') || '{}');
                bookmarks[videoId] = video.currentTime;
                localStorage.setItem('jellyfinEnhancedBookmarks', JSON.stringify(bookmarks));
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
                const bookmarks_get = JSON.parse(localStorage.getItem('jellyfinEnhancedBookmarks') || '{}');
                const bookmarkTime = bookmarks_get[videoId_get];
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
                JE.startAutoSkip();
            } else {
                JE.stopAutoSkip();
            }
        };

        const observer = new MutationObserver(() => {
            runPageSpecificFunctions();
            JE.addRandomButton();
            JE.runFileSizeCheck();
            JE.runLanguageCheck();
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
        document.body.addEventListener('mousedown', (e) => {
            if (!JE.currentSettings.removeContinueWatchingEnabled) return;

            const menuButton = e.target.closest('button[data-action="menu"]');
            if (!menuButton) return;

            JE.state.isContinueWatchingContext = false;
            JE.state.currentContextItemId = null;

            const itemElement = menuButton.closest('[data-id]');
            const section = itemElement?.closest('.verticalSection');
            if (section) {
                const titleElement = section.querySelector('.sectionTitle');
                const isDefaultSection = titleElement && titleElement.textContent.trim() === 'Continue Watching';

                if (section.classList.contains('ContinueWatching') || isDefaultSection) {
                    JE.state.isContinueWatchingContext = true;
                    JE.state.currentContextItemId = itemElement.dataset.id;
                }
            }
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
            //setTimeout(() => JE.toast('⚙️ All settings have been reset by the server admin.', 5000), 2000); //Stop sending a toast notification on every new session
        }

        // Initial UI setup
        JE.injectGlobalStyles();
        JE.addPluginMenuButton();
        JE.applySavedStylesWhenReady();

        // Setup persistent listeners and observers
        setupDOMObserver();
        observeActionSheets();
        addContextMenuListener();
        document.addEventListener('keydown', JE.keyListener);


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