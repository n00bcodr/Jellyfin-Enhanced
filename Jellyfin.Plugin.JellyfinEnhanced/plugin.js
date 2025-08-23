(function() {
    'use strict';

    // --- Plugin Configuration Loading ---
    let pluginConfig = {
        // Jellyfin Enhanced Settings (defaults)
        ClearBookmarksDelay: 3000,
        ToastDuration: 1500,
        HelpPanelAutocloseDelay: 15000,
        AutoskipInterval: 500,
        AutoPauseEnabled: true,
        AutoResumeEnabled: false,
        AutoSkipIntro: false,
        AutoSkipOutro: false,
        RandomButtonEnabled: true,
        RandomIncludeMovies: true,
        RandomIncludeShows: true,
        RandomUnwatchedOnly: false,
        ShowFileSizes: false,
        RemoveContinueWatchingEnabled: false,
        Shortcuts: [],

        // Jellyfin Elsewhere Settings (defaults)
        TMDB_API_KEY: '',
        DEFAULT_REGION: 'US', // Default region to show results for
        DEFAULT_PROVIDERS: '', // Default providers to show (empty = show all)
        IGNORE_PROVIDERS: ''
    };

    let pluginVersion = '...'; // This will be replaced by the fetched version

    // Load plugin configuration and version from Jellyfin
    function loadPluginData() {
        const configPromise = ApiClient.getPluginConfiguration('f69e946a-4b3c-4e9a-8f0a-8d7c1b2c4d9b').then(config => {
            if (config) {
                pluginConfig = { ...pluginConfig, ...config };

                if (pluginConfig.Shortcuts && Array.isArray(pluginConfig.Shortcuts)) {
                    const shortcutMap = new Map();
                    for (const shortcut of pluginConfig.Shortcuts) {
                        if (shortcut.Name) {
                            shortcutMap.set(shortcut.Name, shortcut);
                        }
                    }
                    pluginConfig.Shortcuts = Array.from(shortcutMap.values());
                }
                console.log('🪼 Jellyfin Enhanced: Plugin configuration loaded', pluginConfig);
            }
        }).catch(err => {
            console.warn('🪼 Jellyfin Enhanced: Could not load plugin configuration, using defaults', err);
        });

        const versionPromise = ApiClient.ajax({
            type: 'GET',
            url: ApiClient.getUrl('/JellyfinEnhanced/version'),
            dataType: 'text'
        }).then(version => {
            pluginVersion = version;
            console.log('🪼 Jellyfin Enhanced: Plugin version loaded', pluginVersion);
        }).catch(err => {
            console.warn('🪼 Jellyfin Enhanced: Could not load plugin version', err);
        });
        const publicConfigPromise = ApiClient.ajax({
            type: 'GET',
            url: ApiClient.getUrl('/JellyfinEnhanced/public-config'),
            dataType: 'json'
        }).then(publicConfig => {
            if (publicConfig) {
                pluginConfig = { ...pluginConfig, ...publicConfig };
                console.log('🪼 Jellyfin Enhanced: Public configuration loaded', publicConfig);
            }
        }).catch(err => {
            console.warn('🪼 Jellyfin Enhanced: Could not load public configuration.', err);
        });

        return Promise.all([configPromise, versionPromise, publicConfigPromise]);
    }

    // Wait for ApiClient and load config
    function waitForApiClientAndLoadConfig() {
        if (typeof ApiClient !== 'undefined' && ApiClient.getPluginConfiguration) {
            loadPluginData().then(() => {
                initializeEnhancedScript();
                 // Initialize Jellyfin Elsewhere after a short delay to ensure Enhanced is loaded first
                setTimeout(() => {
                    initializeElsewhereScript();
                }, 1000);
                // Initialize Jellyseerr after Elsewhere
                setTimeout(() => {
                    initializeJellyseerrScript();
                }, 1500);
            });
        } else {
            setTimeout(waitForApiClientAndLoadConfig, 200);
        }
    }

    // --- JELLYFIN ENHANCED SCRIPT ---
    function initializeEnhancedScript() {
        // --- Configuration (now using plugin config) ---
        const CONFIG = {
            CLEAR_BOOKMARKS_DELAY: pluginConfig.ClearBookmarksDelay,
            TOAST_DURATION: pluginConfig.ToastDuration,
            HELP_PANEL_AUTOCLOSE_DELAY: pluginConfig.HelpPanelAutocloseDelay,
            AUTOSKIP_INTERVAL: pluginConfig.AutoskipInterval,
        };

        // --- Global variables ---
        let shiftBTimer = null;
        let shiftBTriggered = false; // Flag to prevent multiple triggers of the clear bookmarks action
        let autoSkipInterval = null; // To hold the interval for auto-skipping
        let activeShortcuts = {}; // Holds final merged shortcuts

        const userShortcutManager = {
            key: 'jellyfinEnhancedUserShortcuts',
            load: function() {
                try {
                    return JSON.parse(localStorage.getItem(this.key)) || {};
                } catch (e) {
                    console.error('🪼 Jellyfin Enhanced: Error loading user shortcuts.', e);
                    return {};
                }
            },
            save: function(shortcuts) {
                try {
                    localStorage.setItem(this.key, JSON.stringify(shortcuts));
                } catch (e) {
                    console.error('🪼 Jellyfin Enhanced: Error saving user shortcuts.', e);
                }
            }
        };

        // To merge all shortcut sources
        function initializeShortcuts() {
            const defaultShortcuts = pluginConfig.Shortcuts.reduce((acc, s) => {
                acc[s.Name] = s.Key;
                return acc;
            }, {});
            const userShortcuts = userShortcutManager.load();
            // User shortcuts override the defaults/admin settings
            activeShortcuts = { ...defaultShortcuts, ...userShortcuts };
        }

        initializeShortcuts();

        // --- Script metadata ---
        const GITHUB_REPO = 'n00bcodr/Jellyfin-Enhanced';

        // --- Remove Continue Watching Variables ---
        let currentContextItemId = null;
        let isContinueWatchingContext = false;

        /*
         * --------------------------------------------------------------------------------
         * GITHUB RELEASE NOTES
         * --------------------------------------------------------------------------------
         */
        const showReleaseNotesNotification = async () => {
            let release;
            try {
                const response = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`);
                if (!response.ok) throw new Error('Failed to fetch release data');
                release = await response.json();
            } catch (error) {
                console.error('🪼 Jellyfin Enhanced: Failed to fetch release notes:', error);
                toast('❌ Could not load release notes.');
                return;
            }

            const notificationId = 'jellyfin-release-notes-notification';
            const existing = document.getElementById(notificationId);
            if (existing) existing.remove();

            const notification = document.createElement('div');
            notification.id = notificationId;

            const getJellyfinThemeVariable = (variableName, defaultValue) => {
                const rootStyle = getComputedStyle(document.documentElement);
                const value = rootStyle.getPropertyValue(variableName).trim();
                return value || defaultValue;
            };

            const isJellyfishThemeActive = getJellyfinThemeVariable('--theme-updated-on', '') !== '' || getJellyfinThemeVariable('--theme-name', '').toLowerCase().includes('jellyfish');

            let panelBg, panelBorder, panelBlur, textColor;

            if (isJellyfishThemeActive) {
                panelBg = getJellyfinThemeVariable('--primary-background-transparent', 'rgba(0,0,0,0.95)');
                panelBorder = `1px solid ${getJellyfinThemeVariable('--primary-accent-color', 'rgba(255,255,255,0.1)')}`;
                textColor = getJellyfinThemeVariable('--text-color', '#fff');
            } else {
                panelBg = 'linear-gradient(135deg, rgba(0,0,0,0.95), rgba(20,20,20,0.95))';
                panelBorder = '1px solid rgba(255,255,255,0.1)';
                textColor = '#fff';
            }

            // Styles for the notification panel
            Object.assign(notification.style, {
                position: 'fixed',
                top: '20px',
                right: '20px',
                background: panelBg,
                color: textColor,
                padding: '20px',
                borderRadius: '12px',
                zIndex: 999999,
                fontSize: '14px',
                fontWeight: '500',
                boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
                backdropFilter: `blur(50px)`,
                border: panelBorder,
                maxWidth: '400px',
                transform: 'translateX(100%)',
                transition: 'transform 0.3s ease-out',
                fontFamily: 'inherit'
            });

            const markdownToHtml = (text) => {
                if (!text) return '';
                return text
                    // Links: [text](url)
                    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" style="color: var(--primary-accent-color, #00a4dc); text-decoration: none;">$1</a>')
                    // Newlines
                    .replace(/\n/g, '<br>');
            };


            const releaseNotes = release.body ?
                (release.body.length > 1500 ? release.body.substring(0, 200) + '...' : release.body) :
                'No release notes available.';

            // HTML content for the notification
            notification.innerHTML = `
                <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 12px;">
                    <div style="width: 40px; height: 40px; background: #3e74f2bd; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 18px;">📋</div>
                    <div>
                        <div style="font-weight: 600; font-size: 16px; color: #779aeadc;">Latest Release Notes</div>
                        <div style="font-size: 12px; color: rgba(255,255,255,0.7);">${release.tag_name}</div>
                    </div>
                </div>
                <div style="margin-bottom: 17px; font-size: 13px; color: rgba(255,255,255,0.8); line-height: 1.4; max-height: 200px; overflow-y: auto;">
                    ${markdownToHtml(releaseNotes)}
                </div>
                <div style="display: flex; gap: 8px; flex-wrap: wrap;">
                    <a href="${release.html_url}" target="_blank" style="background: #3e74f2bd; border: 1px solid #779aeadc; color: white; text-decoration: none; padding: 8px 12px; border-radius: 6px; font-size: 12px; font-weight: 500;">View on GitHub</a>
                    <button onclick="this.parentElement.parentElement.remove()" style="background: #f25151b5; border: 1px solid #f2515133; color: white; padding: 8px 12px; border-radius: 6px; font-size: 12px; font-family: inherit; font-weight: 500; cursor: pointer;">✕ Close</button>
                </div>
            `;

            document.body.appendChild(notification);
            setTimeout(() => { notification.style.transform = 'translateX(0)'; }, 10);
        };

        const injectRandomButtonStyles = () => {
            const styleId = 'jellyfin-enhanced-styles';
            if (document.getElementById(styleId)) return;
            const style = document.createElement('style');
            style.id = styleId;
            style.innerHTML = `
                @keyframes dice {
                    0% { transform: rotate(0deg); }
                    10% { transform: rotate(-15deg); }
                    20% { transform: rotate(15deg); }
                    30% { transform: rotate(-15deg); }
                    40% { transform: rotate(15deg); }
                    50% { transform: rotate(-15deg); }
                    60% { transform: rotate(0deg); }
                    100% { transform: rotate(360deg); }
                }
                button#randomItemButton:not(.loading):hover .material-icons {
                    animation: dice 1.5s;
                }
                .layout-desktop #enhancedSettingsBtn {
                    display: none !important;
                }
                .remove-continue-watching-button {
                    transition: all 0.2s ease;
                }
                .remove-continue-watching-button .material-icons {
                    width: 24px;
                    text-align: center;
                    transition: transform 0.2s ease, color 0.2s ease;
                }
                .remove-continue-watching-button:hover .material-icons {
                    transform: scale(1.1);
                    color: #ff6b6b;
                }
                .remove-continue-watching-button:active .material-icons {
                    transform: scale(0.95);
                }
                .remove-continue-watching-button:disabled {
                    opacity: 0.6;
                    cursor: not-allowed;
                }
                .remove-continue-watching-button:disabled .material-icons {
                    transform: none !important;
                }
                .layout-mobile #jellyfin-enhanced-panel {
                    width: 95vw;
                    max-width: 95vw;
                }
                .layout-mobile #jellyfin-enhanced-panel .shortcuts-container {
                    flex-direction: column;
                }
                .layout-mobile #jellyfin-enhanced-panel #settings-content {
                    width: auto !important;
                }
                .layout-mobile #jellyfin-enhanced-panel .panel-main-content {
                    padding: 0 15px;
                }
                .layout-mobile #jellyfin-enhanced-panel .panel-footer {
                    flex-direction: row;
                    gap: 16px;
                }
                .layout-mobile #jellyfin-enhanced-panel .close-helptext {
                    display: none;
                }
                .layout-mobile #jellyfin-enhanced-panel .footer-buttons {
                    flex-direction: column;
                    align-items: flex-end !important;
                    width: 100%;
                    gap: 10px;
                }
                .layout-mobile #jellyfin-enhanced-panel .footer-buttons > * {
                    justify-content: center;
                }
                @keyframes longPressGlow {
                    from {
                        box-shadow: 0 0 5px 2px var(--primary-accent-color, #fff);
                    }
                    to {
                        box-shadow: 0 0 8px 15px transparent;
                    }
                }
                .headerUserButton.long-press-active {
                    animation: longPressGlow 750ms ease-out;
                }
            `;
            document.head.appendChild(style);
        };

        /*
         * --------------------------------------------------------------------------------
         * Add a button to open the panel in Sidebar
         * --------------------------------------------------------------------------------
         */

        // Add plugin menu button to sidebar
        const addPluginMenuButton = () => {
            const observer = new MutationObserver((mutations) => {
                for (const mutation of mutations) {
                    if (mutation.type === 'childList') {
                        const sidebar = document.querySelector('.mainDrawer-scrollContainer');
                        if (sidebar && !sidebar.querySelector('#jellyfinEnhancedMenuButton')) {
                            addMenuButton(sidebar);
                        }
                    }
                }
            });

            observer.observe(document.body, {
                childList: true,
                subtree: true
            });
        };

        // Add menu button to sidebar
        const addMenuButton = (sidebar) => {
            // Check if Plugin Settings section already exists (Homescreen sections creates it)
            let pluginSettingsSection = sidebar.querySelector('.pluginMenuOptions');

            if (!pluginSettingsSection) {
                // Create new Plugin Settings section if it doesn't exist
                pluginSettingsSection = document.createElement('div');
                pluginSettingsSection.className = 'pluginMenuOptions';
                pluginSettingsSection.innerHTML = '<h3 class="sidebarHeader">Plugin Settings</h3>';

                // Find the settings section to insert after
                const settingsSection = sidebar.querySelector('.navMenuOption[href*="settings"]')?.closest('.drawerSection');
                if (settingsSection && settingsSection.nextSibling) {
                    sidebar.insertBefore(pluginSettingsSection, settingsSection.nextSibling);
                } else {
                    sidebar.appendChild(pluginSettingsSection);
                }
            }

            // Check if Jellyfin Enhanced link already exists
            if (!pluginSettingsSection.querySelector('#jellyfinEnhancedSettingsLink')) {
                // Create Jellyfin Enhanced menu item
                const jellyfinEnhancedLink = document.createElement('a');
                jellyfinEnhancedLink.setAttribute('is', 'emby-linkbutton');
                jellyfinEnhancedLink.className = 'lnkMediaFolder navMenuOption emby-button';
                jellyfinEnhancedLink.href = '#';
                jellyfinEnhancedLink.id = 'jellyfinEnhancedSettingsLink';
                jellyfinEnhancedLink.innerHTML = `
                    <span class="material-icons navMenuOptionIcon" aria-hidden="true">tune</span>
                    <span class="sectionName navMenuOptionText">Jellyfin Enhanced</span>
                `;

                // Add click handler for the menu button
                jellyfinEnhancedLink.addEventListener('click', (e) => {
                    e.preventDefault();
                    showEnhancedPanel();
                });

                pluginSettingsSection.appendChild(jellyfinEnhancedLink);
                console.log('🪼 Jellyfin Enhanced: Menu button added to existing Plugin Settings section');
            }
        };

        /*
         * --------------------------------------------------------------------------------
         * HELPER FUNCTIONS & UI
         * - General utility functions used throughout the script.
         * --------------------------------------------------------------------------------
         */

        // Checks if the current page is a video playback page.
        const isVideoPage = () => location.hash.startsWith('#/video');

        // Checks if the current page is an item details page.
        const isDetailsPage = () => location.hash.includes('/details?id=');

        // Finds the main settings button in the video player OSD.
        const settingsBtn = () => document.querySelector('button[title="Settings"],button[aria-label="Settings"]');

        // Opens the player settings menu and executes a callback function.
        const openSettings = (cb) => {
            settingsBtn()?.click();
            setTimeout(cb, 120); // Wait for the menu to animate open
        };

        // Displays a short-lived message (toast notification) at the bottom-right of the screen.
        const toast = (txt, duration = CONFIG.TOAST_DURATION) => {
            const getJellyfinThemeVariable = (variableName, defaultValue) => {
                const rootStyle = getComputedStyle(document.documentElement);
                const value = rootStyle.getPropertyValue(variableName).trim();
                return value ? value : defaultValue;
            };

            const isJellyfishThemeActive = getJellyfinThemeVariable('--theme-updated-on', '') !== '' || getJellyfinThemeVariable('--theme-name', '').toLowerCase().includes('jellyfish');
            let toastBg, toastBorder;

            if (isJellyfishThemeActive) {
                toastBg = getJellyfinThemeVariable('--secondary-background-transparent', 'rgba(0,0,0,0.6)');
                toastBorder = `1px solid ${getJellyfinThemeVariable('--primary-accent-color', 'rgba(255,255,255,0.1)')}`;
            } else {
                toastBg = 'linear-gradient(135deg, rgba(0,0,0,0.9), rgba(40,40,40,0.9))';
                toastBorder = '1px solid rgba(255,255,255,0.1)';
            }

            const t = document.createElement('div');
            t.className = 'jellyfin-enhanced-toast';
            Object.assign(t.style, {
                position: 'fixed',
                bottom: '20px',
                right: '20px',
                transform: 'translateX(100%)',
                background: toastBg,
                color: '#fff',
                padding: '10px 14px',
                borderRadius: '8px',
                zIndex: 99999,
                fontSize: 'clamp(13px, 2vw, 16px)',
                textShadow: '-1px -1px 5px black',
                fontWeight: '500',
                boxShadow: '0 4px 20px rgba(0,0,0,0.3)',
                backdropFilter: `blur(30px)`,
                border: toastBorder,
                transition: 'transform 0.3s ease-out',
                maxWidth: 'clamp(280px, 80vw, 350px)'
            });
            t.textContent = txt;
            document.body.appendChild(t);
            setTimeout(() => t.style.transform = 'translateX(0)', 10);
            setTimeout(() => {
                t.style.transform = 'translateX(100%)';
                setTimeout(() => t.remove(), 300);
            }, duration);
        };

        /**
         * Converts bytes into a human-readable format (e.g., KB, MB, GB) for item size functionality.
         * @param {number} bytes The size in bytes.
         * @returns {string} The human-readable file size.
         */
        function formatSize(bytes) {
            if (bytes === 0) return '0 Bytes';
            const k = 1024;
            const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB'];
            const i = Math.floor(Math.log(bytes) / Math.log(k));
            const formattedSize = parseFloat((bytes / Math.pow(k, i)).toFixed(2));
            const unit = sizes[i];
            return `${formattedSize} ${unit}`;
        }

        /*
        * --------------------------------------------------------------------------------
        * SETTINGS PERSISTENCE
        * - Saves and loads script settings from localStorage.
        * --------------------------------------------------------------------------------
        */
        const saveSettings = (settings) => {
            try {
                localStorage.setItem('jellyfinEnhancedSettings', JSON.stringify(settings));
            } catch (e) {
                console.error('🪼 Jellyfin Enhanced: Failed to save settings:', e);
            }
        };

        const loadSettings = () => {
            try {
                const settings = JSON.parse(localStorage.getItem('jellyfinEnhancedSettings'));
                // Return saved settings or a default configuration.
                return settings || {
                    autoPauseEnabled: pluginConfig.AutoPauseEnabled,
                    autoResumeEnabled: pluginConfig.AutoResumeEnabled,
                    autoSkipIntro: pluginConfig.AutoSkipIntro,
                    autoSkipOutro: pluginConfig.AutoSkipOutro,
                    selectedStylePresetIndex: 0,
                    selectedFontSizePresetIndex: 2,
                    selectedFontFamilyPresetIndex: 0,
                    randomButtonEnabled: pluginConfig.RandomButtonEnabled,
                    randomIncludeMovies: pluginConfig.RandomIncludeMovies,
                    randomIncludeShows: pluginConfig.RandomIncludeShows,
                    randomUnwatchedOnly: pluginConfig.RandomUnwatchedOnly,
                    showFileSizes: pluginConfig.ShowFileSizes,
                    showAudioLanguages: pluginConfig.ShowAudioLanguages,
                    removeContinueWatchingEnabled: pluginConfig.RemoveContinueWatchingEnabled,
                    lastOpenedTab: 'shortcuts'
                };
            } catch (e) {
                console.error('🪼 Jellyfin Enhanced: Error loading settings:', e);
                // Fallback to default settings on error.
                return {
                    autoPauseEnabled: true,
                    autoResumeEnabled: false,
                    autoSkipIntro: false,
                    autoSkipOutro: false,
                    selectedStylePresetIndex: 0,
                    selectedFontSizePresetIndex: 2,
                    selectedFontFamilyPresetIndex: 0,
                    randomButtonEnabled: true,
                    randomIncludeMovies: true,
                    randomIncludeShows: true,
                    randomUnwatchedOnly: false,
                    showFileSizes: false,
                    removeContinueWatchingEnabled: false,
                    lastOpenedTab: 'shortcuts'
                };
            }
        };

        let currentSettings = loadSettings();

        // Applies the saved subtitle styles when the script loads.
        const applySavedStylesWhenReady = () => {
            const savedStyleIndex = currentSettings.selectedStylePresetIndex ?? 0;
            const savedFontSizeIndex = currentSettings.selectedFontSizePresetIndex ?? 2;
            const savedFontFamilyIndex = currentSettings.selectedFontFamilyPresetIndex ?? 0;

            const stylePreset = subtitlePresets[savedStyleIndex];
            const fontSizePreset = fontSizePresets[savedFontSizeIndex];
            const fontFamilyPreset = fontFamilyPresets[savedFontFamilyIndex];

            if (stylePreset && fontSizePreset && fontFamilyPreset) {
                applySubtitleStyles(
                    stylePreset.textColor,
                    stylePreset.bgColor,
                    fontSizePreset.size,
                    fontFamilyPreset.family
                );
            }
        };

        /*
        * --------------------------------------------------------------------------------
        * REMOVE CONTINUE WATCHING FUNCTIONALITY
        * - Functions for removing items from the Continue Watching section.
        * --------------------------------------------------------------------------------
        */

        // Get the Jellyfin server address from current location
        const getJellyfinServerAddress = () => window.location.origin;

        // Show notifications using Jellyfin's notification system
        const showNotification = (message, type = 'info') => {
            try {
                if (window.Dashboard?.alert) {
                     window.Dashboard.alert(message);
                } else if (window.Emby?.Notifications) {
                    window.Emby.Notifications.show({ title: message, type: type, timeout: 3000 });
                } else {
                    console.log(`🪼 Jellyfin Enhanced: Notification (${type}): ${message}`);
                }
            } catch (e) {
                console.error("🪼 Jellyfin Enhanced: Failed to show notification", e);
                console.log(`🪼 Jellyfin Enhanced: Notification (${type}): ${message}`);
            }
        };

        // Main function to remove item from continue watching
        const removeFromContinueWatching = async (itemId) => {
            const userId = ApiClient.getCurrentUserId();

            if (!userId) {
                console.error("🪼 Jellyfin Enhanced: Remove Continue Watching: User ID not found.");
                showNotification("Please log in to use this feature.", "error");
                return false;
            }

            if (!itemId) {
                console.error("🪼 Jellyfin Enhanced: Remove Continue Watching: No item ID provided.");
                showNotification("No item selected.", "error");
                return false;
            }

            const serverAddress = getJellyfinServerAddress();

            try {
                console.log("🪼 Jellyfin Enhanced: Remove Continue Watching: Attempting to reset user data for item:", itemId);
                const userDataUrl = `${serverAddress}/Users/${userId}/Items/${itemId}/UserData`;
                await ApiClient.ajax({
                    type: 'POST',
                    url: userDataUrl,
                    data: JSON.stringify({ PlaybackPositionTicks: 0 }),
                    headers: { 'Content-Type': 'application/json' }
                });

                console.log("🪼 Jellyfin Enhanced: Remove Continue Watching: Successfully reset user data:", itemId);
                return true;
            } catch (error) {
                console.error("🪼 Jellyfin Enhanced: Remove Continue Watching: API call failed:", error);
                const errorMessage = error.responseJSON?.Message || error.statusText || error.message || 'Unknown error occurred';
                showNotification(`Unable to remove item: ${errorMessage}`, "error");
                return false;
            }
        };

        // Creates the remove button for the action sheet
        const createRemoveButton = (itemId) => {
            const button = document.createElement('button');
            button.setAttribute('is', 'emby-button');
            button.type = 'button';
            button.className = 'listItem listItem-button actionSheetMenuItem emby-button remove-continue-watching-button';
            button.setAttribute('data-id', 'remove-continue-watching');

            button.innerHTML = `
                <span class="actionsheetMenuItemIcon listItemIcon listItemIcon-transparent material-icons" aria-hidden="true">visibility_off</span>
                <div class="listItemBody actionsheetListItemBody">
                    <div class="listItemBodyText actionSheetItemText">Remove</div>
                </div>
            `;

            button.addEventListener('click', async (e) => {
                e.preventDefault();
                e.stopPropagation();
                console.log("🪼 Jellyfin Enhanced: Remove Continue Watching: 'Remove' button clicked. Item ID:", itemId);

                if (!itemId) {
                    showNotification("Could not determine which item to remove.", "error");
                    return;
                }

                const buttonTextElem = button.querySelector('.actionSheetItemText');
                const buttonIconElem = button.querySelector('.material-icons');
                const originalText = buttonTextElem.textContent;
                const originalIcon = buttonIconElem.textContent;

                // Set loading state
                button.disabled = true;
                buttonTextElem.textContent = 'Removing...';
                buttonIconElem.textContent = 'hourglass_empty';

                const success = await removeFromContinueWatching(itemId);

                if (success) {
                    // Close the action sheet first
                    const sheet = document.querySelector('.actionSheet.opened');
                    if (sheet) {
                        const rect = sheet.getBoundingClientRect();
                        const x = rect.left - 10;
                        const y = rect.top - 10;

                        const el = document.elementFromPoint(x, y);
                        if (el) {
                            el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
                            el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
                            el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
                            console.debug("🪼 Jellyfin Enhanced: Simulated outside click to close action sheet.");
                        } else {
                            console.debug("🪼 Jellyfin Enhanced: No element found to click outside.");
                        }
                    } else {
                        console.debug("🪼 Jellyfin Enhanced: No open action sheet found.");
                    }

                    // Show notification after closing
                    showNotification("Item removed from Continue Watching", "success");

                    // Refresh the view
                    setTimeout(() => {
                        try {
                            const currentView = window.Emby?.Page?.currentView;
                            if (currentView && currentView.refresh) {
                                currentView.refresh({ force: true });
                            } else {
                                window.dispatchEvent(new CustomEvent('libraryupdated'));
                            }
                        } catch (refreshError) {
                            console.log("🪼 Jellyfin Enhanced: Could not auto-refresh view:", refreshError);
                            showNotification("Item removed. Please refresh the page to see changes.", "info");
                        }
                    }, 500);

                } else {
                    // Failure: restore button to original state
                    button.disabled = false;
                    buttonTextElem.textContent = originalText;
                    buttonIconElem.textContent = originalIcon;
                }
            });

            return button;
        };

        // Adds the remove button to the action sheet
        const addRemoveButton = () => {
            if (!currentSettings.removeContinueWatchingEnabled || !isContinueWatchingContext) {
                return;
            }

            const actionSheetContent = document.querySelector('.actionSheetContent .actionSheetScroller');
            if (!actionSheetContent || actionSheetContent.querySelector('[data-id="remove-continue-watching"]')) {
                return;
            }

            const itemId = currentContextItemId;
            if (!itemId) {
                console.error("🪼 Jellyfin Enhanced: Remove Continue Watching: Context was correct, but could not get item ID.");
                return;
            }

            // Reset context flags after use to prevent incorrect additions later
            isContinueWatchingContext = false;
            currentContextItemId = null;

            const removeButton = createRemoveButton(itemId);

            let insertionPoint = actionSheetContent.querySelector('[data-id="playallfromhere"]');
            if (!insertionPoint) {
                insertionPoint = actionSheetContent.querySelector('[data-id="resume"]') || actionSheetContent.querySelector('[data-id="play"]');
            }

            if (insertionPoint) {
                insertionPoint.after(removeButton);
            } else {
                actionSheetContent.appendChild(removeButton);
            }

            console.log("🪼 Jellyfin Enhanced: Remove Continue Watching: Button successfully added to action sheet for item:", itemId);
        };

        // Observes action sheets for the remove button
        const observeActionSheets = () => {
            const observer = new MutationObserver((mutations) => {
                if (!currentSettings.removeContinueWatchingEnabled) return;

                for (const mutation of mutations) {
                    const target = mutation.target.nodeType === Node.ELEMENT_NODE ? mutation.target : null;
                    if (!target) continue;

                    if (
                        (mutation.type === 'childList' && target.querySelector('.actionSheetContent')) ||
                        (mutation.type === 'attributes' && target.classList.contains('opened') && target.querySelector('.actionSheetContent'))
                    ) {
                        setTimeout(addRemoveButton, 150);
                        return;
                    }
                }
            });

            observer.observe(document.body, {
                childList: true,
                subtree: true,
                attributes: true,
                attributeFilter: ['class']
            });
        };

        // Context menu listener for Continue Watching detection
        const addContextMenuListener = () => {
            document.body.addEventListener('mousedown', (e) => {
                if (!currentSettings.removeContinueWatchingEnabled) return;

                const menuButton = e.target.closest('button[data-action="menu"]');
                if (!menuButton) return;

                // Reset flags on every menu click
                isContinueWatchingContext = false;
                currentContextItemId = null;

                const itemElement = menuButton.closest('[data-id]');
                if (itemElement) {
                    const section = itemElement.closest('.verticalSection');
                    if (section) {
                        // Check for plugin-specific class OR the default section title
                        const isPluginSection = section.classList.contains('ContinueWatching');
                        const titleElement = section.querySelector('.sectionTitle');
                        const isDefaultSection = titleElement && titleElement.textContent.trim() === 'Continue Watching';

                        if (isPluginSection || isDefaultSection) {
                            isContinueWatchingContext = true;
                            currentContextItemId = itemElement.dataset.id;
                            console.log("🪼 Jellyfin Enhanced: Remove Continue Watching: Captured 'Continue Watching' context for item:", currentContextItemId);
                        }
                    }
                }
            }, true); // Use capture phase to catch the event early
        };

        /*
        * --------------------------------------------------------------------------------
        * SUBTITLE CUSTOMIZATION
        * - Presets and functions for changing subtitle appearance.
        * --------------------------------------------------------------------------------
        */
        const subtitlePresets = [
            { name: "Clean White", textColor: "#FFFFFFFF", bgColor: "transparent", previewText: "Aa" },
            { name: "Classic Black Box", textColor: "#FFFFFFFF", bgColor: "#000000FF", previewText: "Aa" },
            { name: "Netflix Style", textColor: "#FFFFFFFF", bgColor: "#000000B2", previewText: "Aa" },
            { name: "Cinema Yellow", textColor: "#FFFF00FF", bgColor: "#000000B2", previewText: "Aa" },
            { name: "Soft Gray", textColor: "#FFFFFFFF", bgColor: "#444444B2", previewText: "Aa" },
            { name: "High Contrast", textColor: "#000000FF", bgColor: "#FFFFFFFF", previewText: "Aa" }
        ];

        const fontSizePresets = [
            { name: "Tiny", size: 0.8, previewText: "Aa" },
            { name: "Small", size: 1, previewText: "Aa" },
            { name: "Normal", size: 1.2, previewText: "Aa" },
            { name: "Large", size: 1.8, previewText: "Aa" },
            { name: "Extra Large", size: 2, previewText: "Aa" },
            { name: "Gigantic", size: 3, previewText: "Aa" }
        ];

        const fontFamilyPresets = [
            { name: "Default", family: "inherit", previewText: "AaBb" },
            { name: "Noto Sans", family: "Noto Sans,sans-serif", previewText: "AaBb" },
            { name: "Sans Serif", family: "Arial,Helvetica,sans-serif", previewText: "AaBb" },
            { name: "Typewriter", family: "Courier New,Courier,monospace", previewText: "AaBb" },
            { name: "Roboto", family: "Roboto Mono,monospace", previewText: "AaBb" }
        ];

        // Applies the selected subtitle styles by modifying or creating a style element.
        const applySubtitleStyles = (textColor, bgColor, fontSize, fontFamily) => {
            const styleElement = document.getElementById('htmlvideoplayer-cuestyle');

            if (!styleElement) { return; } // Exit if not found

            const sheet = styleElement.sheet;
            if (!sheet) { return; }

            try {
                // Clear existing rules
                while (sheet.cssRules.length > 0) {
                    sheet.deleteRule(0);
                }

                // Create and insert the new rule with the dynamic font size
                const newRule = `
                    .htmlvideoplayer::cue {
                        background-color: ${bgColor} !important;
                        color: ${textColor} !important;
                        font-size: ${fontSize}vw !important;
                        font-family: ${fontFamily} !important;
                    }
                `;
                sheet.insertRule(newRule, 0);

            } catch (e) {
                console.error("🪼 Jellyfin Enhanced: Failed to apply subtitle styles:", e);
            }
        };

        /*
        * --------------------------------------------------------------------------------
        * AUTO-SKIP FUNCTIONALITY
        * --------------------------------------------------------------------------------
        */
        const autoSkipHandler = () => {
            const skipButton = document.querySelector('button.skip-button.emby-button:not(.skip-button-hidden):not(.hide)');
            if (!skipButton) return;

            const buttonText = skipButton.textContent || '';
            if (currentSettings.autoSkipIntro && buttonText.includes('Skip Intro')) {
                skipButton.click();
                toast('↪️ Auto-Skipped Intro');
            } else if (currentSettings.autoSkipOutro && buttonText.includes('Skip Outro')) {
                skipButton.click();
                toast('↪️ Auto-Skipped Outro');
            }
        };

        const startAutoSkip = () => {
            if (!autoSkipInterval) {
                autoSkipInterval = setInterval(autoSkipHandler, CONFIG.AUTOSKIP_INTERVAL);
            }
        };

        const stopAutoSkip = () => {
            if (autoSkipInterval) {
                clearInterval(autoSkipInterval);
                autoSkipInterval = null;
            }
        };


        /*
        * --------------------------------------------------------------------------------
        * RANDOM BUTTON FUNCTIONALITY
        * - Adds a "Random" button to the header to navigate to a random item.
        * --------------------------------------------------------------------------------
        */

        // Fetches a random item (Movie or Series) from the user's library via the API.
        const getRandomItem = async (unwatchedOnly = false) => {
            const userId = ApiClient.getCurrentUserId();
            if (!userId) {
                console.error("🪼 Jellyfin Enhanced: User not logged in.");
                return null;
            }

            const serverAddress = getJellyfinServerAddress();
            const settings = loadSettings();
            const itemTypes = [];
            if (settings.randomIncludeMovies) itemTypes.push('Movie');
            if (settings.randomIncludeShows) itemTypes.push('Series');
            const includeItemTypes = itemTypes.length > 0 ? itemTypes.join(',') : 'Movie,Series';

            // Construct the API URL to fetch a list of random items
            let apiUrl = `${serverAddress}/Users/${userId}/Items?IncludeItemTypes=${includeItemTypes}&Recursive=true&SortBy=Random&Limit=20&Fields=ExternalUrls`;
            if (unwatchedOnly) {
                apiUrl += '&IsPlayed=false';
            }
            apiUrl += `&_=${Date.now()}`;

            try {
                const response = await ApiClient.ajax({
                    type: 'GET',
                    url: apiUrl,
                    headers: { 'Content-Type': 'application/json' },
                    dataType: 'json'
                });

                if (response && response.Items && response.Items.length > 0) {
                    // Pick one item from the fetched list
                    const randomIndex = Math.floor(Math.random() * response.Items.length);
                    return response.Items[randomIndex];
                } else {
                    throw new Error('No items found in selected libraries.');
                }
            } catch (error) {
                console.error('🪼 Jellyfin Enhanced: Error fetching random item:', error);
                toast(`❌ ${error.message || 'Unknown error'}`, 2000);
                return null;
            }
        };

        // Navigates the browser to the details page of the given item.
        const navigateToItem = (item) => {
            if (item && item.Id) {
                const serverAddress = getJellyfinServerAddress();
                const serverId = ApiClient.serverId();
                const itemUrl = `${serverAddress}/web/index.html#!/details?id=${item.Id}${serverId ? `&serverId=${serverId}` : ''}`;
                window.location.href = itemUrl;
                toast(`🎲 Random Item Loaded`, 2000);
            } else {
                console.error('🪼 Jellyfin Enhanced: Invalid item object or ID:', item);
                toast('❌ Uh oh! Something went wrong!', 2000);
            }
        };

        // Creates and injects the "Random" button into the page header.
        const addRandomButton = () => {
            const settings = loadSettings();
            if (!settings.randomButtonEnabled) {
                const existingButton = document.getElementById('randomItemButtonContainer');
                if (existingButton) existingButton.remove();
                return;
            }

            // Check if the button already exists to prevent duplicates.
            if (document.getElementById('randomItemButton')) return;

            // The container helps with positioning in different Jellyfin layouts.
            let buttonContainer = document.createElement('div');
            buttonContainer.id = 'randomItemButtonContainer';

            const randomButton = document.createElement('button');
            randomButton.id = 'randomItemButton';
            // Use 'is' attribute to ensure Jellyfin applies its native button styling.
            randomButton.setAttribute('is', 'paper-icon-button-light');
            // Apply standard Jellyfin header classes for consistent theming.
            randomButton.className = 'headerButton headerButtonRight paper-icon-button-light';
            randomButton.title = 'Show a random item from your library (R)';
            randomButton.innerHTML = `<i class="material-icons">casino</i>`;

            randomButton.addEventListener('click', async () => {
                // Disable button and show a loading state.
                randomButton.disabled = true;
                randomButton.classList.add('loading'); // Use a class for the loading state.
                randomButton.innerHTML = '<i class="material-icons">hourglass_empty</i>';

                try {
                    const item = await getRandomItem(currentSettings.randomUnwatchedOnly);
                    if (item) {
                        navigateToItem(item);
                    }
                } finally {
                    // Re-enable the button after the operation.
                    // A delay prevents the button from resetting before the page navigates away.
                    setTimeout(() => {
                        if (document.getElementById(randomButton.id)) {
                            randomButton.disabled = false;
                            randomButton.classList.remove('loading');
                            randomButton.innerHTML = `<i class="material-icons">casino</i>`;
                        }
                    }, 500);
                }
            });

            buttonContainer.appendChild(randomButton);
            const headerRight = document.querySelector('.headerRight');
            const searchInputContainer = document.querySelector('.searchInputContainer');

            if (headerRight) {
                headerRight.prepend(buttonContainer);
            } else if (searchInputContainer) {
                searchInputContainer.parentNode.insertBefore(buttonContainer, searchInputContainer.nextSibling);
            }
        };


        /*
        * --------------------------------------------------------------------------------
        * FILE SIZE DISPLAY
        * - Shows the total file size of an item on its details page.
        * --------------------------------------------------------------------------------
        */
        const displayItemSize = async (itemId) => {
            const targetSelector = '.itemMiscInfo.itemMiscInfo-primary';
            const elementClassName = 'mediaInfoItem-fileSize';
            const processingClassName = 'fileSize-processing';
            const container = document.querySelector(targetSelector);

            // Exit if container doesn't exist, size is already present, or if it's already being processed.
            if (!container || container.querySelector(`.${elementClassName}`) || container.classList.contains(processingClassName)) {
                return;
            }

            // Add a flag to the container to prevent multiple simultaneous runs.
            container.classList.add(processingClassName);

            try {
                const item = await ApiClient.getItem(ApiClient.getCurrentUserId(), itemId);
                if (item && item.MediaSources && item.MediaSources.length > 0) {
                    // Sum the 'Size' property from all media sources
                    const totalSize = item.MediaSources.reduce((sum, source) => sum + (source.Size || 0), 0);

                    if (totalSize > 0) {
                        // Check again in case another process finished while we were waiting for the API
                        if (container.querySelector(`.${elementClassName}`)) {
                            return;
                        }
                        const sizeText = formatSize(totalSize);

                        // Create and inject the element
                        const sizeElement = document.createElement('div');
                        sizeElement.className = `mediaInfoItem ${elementClassName}`;
                        sizeElement.title = "Total File Size";
                        sizeElement.style.display = 'flex';
                        sizeElement.style.alignItems = 'center';

                        const icon = document.createElement('span');
                        icon.className = 'material-icons';
                        icon.textContent = 'hard_disk';
                        icon.style.fontSize = 'inherit';
                        icon.style.marginRight = '0.3em';

                        const textNode = document.createTextNode(sizeText);

                        sizeElement.appendChild(icon);
                        sizeElement.appendChild(textNode);
                        container.appendChild(sizeElement);
                    }
                }
            } catch (error) {
                console.error(`🪼 Jellyfin Enhanced: Error fetching item size for ID ${itemId}:`, error);
            } finally {
                // Always remove the processing flag when done.
                if (container) {
                    container.classList.remove(processingClassName);
                }
            }
        };
        /*
        * --------------------------------------------------------------------------------
        * AUDIO LANGUAGE DISPLAY
        * - Shows the audio languages of an item on its details page.
        * --------------------------------------------------------------------------------
        */
        const languageToCountryMap={English:"us",eng:"us",Japanese:"jp",jpn:"jp",Spanish:"es",spa:"es",French:"fr",fre:"fr",fra:"fr",German:"de",ger:"de",deu:"de",Italian:"it",ita:"it",Korean:"kr",kor:"kr",Chinese:"cn",chi:"cn",zho:"cn",Russian:"ru",rus:"ru",Portuguese:"pt",por:"pt",Hindi:"in",hin:"in",Dutch:"nl",dut:"nl",nld:"nl",Arabic:"sa",ara:"sa",Bengali:"bd",ben:"bd",Czech:"cz",ces:"cz",Danish:"dk",dan:"dk",Greek:"gr",ell:"gr",Finnish:"fi",fin:"fi",Hebrew:"il",heb:"il",Hungarian:"hu",hun:"hu",Indonesian:"id",ind:"id",Norwegian:"no",nor:"no",Polish:"pl",pol:"pl",Persian:"ir",per:"ir",fas:"ir",Romanian:"ro",ron:"ro",rum:"ro",Swedish:"se",swe:"se",Thai:"th",tha:"th",Turkish:"tr",tur:"tr",Ukrainian:"ua",ukr:"ua",Vietnamese:"vn",vie:"vn",Malay:"my",msa:"my",may:"my",Swahili:"ke",swa:"ke",Tagalog:"ph",tgl:"ph",Filipino:"ph",Tamil:"in",tam:"in",Telugu:"in",tel:"in",Marathi:"in",mar:"in",Punjabi:"in",pan:"in",Urdu:"pk",urd:"pk",Gujarati:"in",guj:"in",Kannada:"in",kan:"in",Malayalam:"in",mal:"in",Sinhala:"lk",sin:"lk",Nepali:"np",nep:"np",Pashto:"af",pus:"af",Kurdish:"iq",kur:"iq",Slovak:"sk",slk:"sk",Slovenian:"si",slv:"si",Serbian:"rs",srp:"rs",Croatian:"hr",hrv:"hr",Bulgarian:"bg",bul:"bg",Macedonian:"mk",mkd:"mk",Albanian:"al",sqi:"al",Estonian:"ee",est:"ee",Latvian:"lv",lav:"lv",Lithuanian:"lt",lit:"lt",Icelandic:"is",ice:"is",isl:"is",Georgian:"ge",kat:"ge",Armenian:"am",hye:"am",Mongolian:"mn",mon:"mn",Kazakh:"kz",kaz:"kz",Uzbek:"uz",uzb:"uz",Azerbaijani:"az",aze:"az",Belarusian:"by",bel:"by",Amharic:"et",amh:"et",Zulu:"za",zul:"za",Afrikaans:"za",afr:"za",Hausa:"ng",hau:"ng",Yoruba:"ng",yor:"ng",Igbo:"ng",ibo:"ng"};

        const displayAudioLanguages = async (itemId) => {
            const targetSelector = '.itemMiscInfo.itemMiscInfo-primary';
            const elementClassName = 'mediaInfoItem-audioLanguage';
            const container = document.querySelector(targetSelector);

            if (!container || container.querySelector(`.${elementClassName}`) || container.classList.contains('language-processing')) {
                return;
            }
            container.classList.add('language-processing');

            try {
                const item = await ApiClient.getItem(ApiClient.getCurrentUserId(), itemId);
                const languages = new Set();
                if (item && item.MediaSources) {
                    item.MediaSources.forEach(source => {
                        if (source.MediaStreams) {
                            source.MediaStreams.filter(stream => stream.Type === 'Audio').forEach(stream => {
                                const langCode = stream.Language;
                                if (langCode && langCode.toLowerCase() !== 'und' && langCode.toLowerCase() !== 'root') {
                                    try {
                                        const langName = new Intl.DisplayNames(['en'], { type: 'language' }).of(langCode);
                                        languages.add(JSON.stringify({ name: langName, code: langCode }));
                                    } catch (e) {
                                        languages.add(JSON.stringify({ name: langCode.toUpperCase(), code: langCode }));
                                    }
                                }
                            });
                        }
                    });
                }

                const uniqueLanguages = Array.from(languages).map(JSON.parse);

                if (uniqueLanguages.length > 0) {
                    const langElement = document.createElement('div');
                    langElement.className = `mediaInfoItem ${elementClassName}`;
                    langElement.title = "Audio Language(s)";
                    langElement.style.display = 'flex';
                    langElement.style.alignItems = 'center';

                    const icon = document.createElement('span');
                    icon.className = 'material-icons';
                    icon.textContent = 'translate';
                    icon.style.fontSize = 'inherit';
                    icon.style.marginRight = '0.3em';
                    langElement.appendChild(icon);

                    uniqueLanguages.forEach((lang, index) => {
                        const countryCode = languageToCountryMap[lang.name] || languageToCountryMap[lang.code];
                        if (countryCode) {
                            const flagImg = document.createElement('img');
                            flagImg.src = `https://flagcdn.com/w20/${countryCode.toLowerCase()}.png`;
                            flagImg.alt = `${lang.name} flag`;
                            flagImg.style.width = '18px';
                            flagImg.style.marginRight = '0.3em';
                            flagImg.style.borderRadius = '2px';
                            langElement.appendChild(flagImg);
                        }
                        langElement.appendChild(document.createTextNode(lang.name));
                        if (index < uniqueLanguages.length - 1) {
                            const separator = document.createElement('span');
                            separator.style.margin = '0 0.25em';
                            separator.textContent = ', ';
                            langElement.appendChild(separator);
                        }
                    });
                    container.appendChild(langElement);
                }
            } catch (error) {
                console.error(`🪼 Jellyfin Enhanced: Error fetching audio languages for ${itemId}:`, error);
            } finally {
                if (container) container.classList.remove('language-processing');
            }
        };


        /*
        * --------------------------------------------------------------------------------
        * OBSERVERS & EVENT LISTENERS
        * - React to changes in the DOM and browser state.
        * --------------------------------------------------------------------------------
        */

        // This function runs checks based on the current page type.
        const runPageSpecificFunctions = () => {
            if (isVideoPage()) {
                addOsdSettingsButton();
                startAutoSkip();
            } else {
                stopAutoSkip();
            }
        };

        // This function specifically handles triggering the file size display
        const runFileSizeCheck = () => {
            if (currentSettings.showFileSizes && isDetailsPage()) {
                try {
                    const urlParams = new URLSearchParams(window.location.hash.split('?')[1]);
                    const itemId = urlParams.get('id');
                    if (itemId) {
                        displayItemSize(itemId);
                    }
                } catch (e) { /* ignore errors from malformed URLs during page transitions */ }
            }
        };

        const runLanguageCheck = () => {
            if (currentSettings.showAudioLanguages && isDetailsPage()) {
                try {
                    const urlParams = new URLSearchParams(window.location.hash.split('?')[1]);
                    const itemId = urlParams.get('id');
                    if (itemId) {
                        displayAudioLanguages(itemId);
                    }
                } catch (e) { /* ignore */ }
            }
        };

        // Adds a button to the mobile video player OSD to open the settings panel.
        const addOsdSettingsButton = () => {
            if (document.getElementById('enhancedSettingsBtn')) return;
            const controlsContainer = document.querySelector('.videoOsdBottom .buttons.focuscontainer-x');
            if (!controlsContainer) return;
            const nativeSettingsButton = controlsContainer.querySelector('.btnVideoOsdSettings');
            if (!nativeSettingsButton) return;

            const enhancedSettingsBtn = document.createElement('button');
            enhancedSettingsBtn.id = 'enhancedSettingsBtn';
            enhancedSettingsBtn.setAttribute('is', 'paper-icon-button-light');
            enhancedSettingsBtn.className = 'autoSize paper-icon-button-light';
            enhancedSettingsBtn.title = 'Jellyfin Enhanced';
            enhancedSettingsBtn.innerHTML = '<span class="largePaperIconButton material-icons" aria-hidden="true">tune</span>';

            enhancedSettingsBtn.onclick = (e) => {
                e.stopPropagation();
                showEnhancedPanel();
            };

            nativeSettingsButton.parentElement.insertBefore(enhancedSettingsBtn, nativeSettingsButton);
        };

        // Observes the DOM for changes to ensure styles and buttons are always applied.
        const setupStyleObserver = () => {
            let isApplyingStyles = false;
            const observer = new MutationObserver(() => {
                // Apply subtitle styles when needed.
                if (!isApplyingStyles) {
                    isApplyingStyles = true;
                    setTimeout(() => {
                        applySavedStylesWhenReady();
                        isApplyingStyles = false;
                    }, 100);
                }
                runPageSpecificFunctions();
            });

            observer.observe(document.body, { childList: true, subtree: true, attributes: false });

            // Re-apply styles on fullscreen change, as some browsers reset them.
            document.addEventListener('fullscreenchange', () => {
                setTimeout(() => {
                    if (!isApplyingStyles) applySavedStylesWhenReady();
                }, 200);
            });
        };

        setupStyleObserver();
        applySavedStylesWhenReady();


        /*
        * --------------------------------------------------------------------------------
        * VIDEO CONTROL FUNCTIONS
        * - Functions for controlling video playback (speed, seeking, etc.).
        * --------------------------------------------------------------------------------
        */

        // Gets the current video element on the page.
        const getVideo = () => document.querySelector('video');

        // Adjusts playback speed up or down through a predefined list of speeds.
        const adjustPlaybackSpeed = (direction) => {
            const video = getVideo();
            if (!video) {
                toast('❌ No Video Found');
                return;
            }
            const speeds = [0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0];
            let currentIndex = speeds.findIndex(speed => Math.abs(speed - video.playbackRate) < 0.01);
            if (currentIndex === -1) {
                currentIndex = speeds.findIndex(speed => speed >= video.playbackRate);
                if (currentIndex === -1) currentIndex = speeds.length - 1;
            }
            if (direction === 'increase') {
                currentIndex = Math.min(currentIndex + 1, speeds.length - 1);
            } else {
                currentIndex = Math.max(currentIndex - 1, 0);
            }
            video.playbackRate = speeds[currentIndex];
            toast(`⚡ Speed: ${speeds[currentIndex]}x`);
        };

        // Resets the video playback speed to normal (1.0x).
        const resetPlaybackSpeed = () => {
            const video = getVideo();
            if (!video) {
                toast('❌ No Video Found');
                return;
            }
            video.playbackRate = 1.0;
            toast('⚡ Speed: Normal');
        };

        // Jumps to a specific percentage of the video's duration.
        const jumpToPercentage = (percentage) => {
            const video = getVideo();
            if (!video || !video.duration) {
                toast('❌ No Video Found');
                return;
            }

            // Only realized while testing this, that Jellyfin has this functionality natively, might be unknown to some, so will leave the toast message for some visual feedback

            // const targetTime = (video.duration * percentage) / 100;
            // video.currentTime = targetTime;
            toast(`⏭️ Jumped to ${percentage}%`);
        };

        // Cycles through available subtitle tracks.
        const cycleSubtitleTrack = () => {
            // This function finds the subtitle menu and clicks the next available option. (There is probably a much better way to do this, but for the love of god, I cannot figure it out.)
            const performCycle = () => {
                // Step 1: Get all list items in the action sheet using a general selector.
                const allItems = document.querySelectorAll('.actionSheetContent .listItem');

                if (allItems.length === 0) {
                    toast('❌ No Subtitles Found');
                    document.body.click();
                    return;
                }

                // Step 2: Filter the items to get only the actual, selectable subtitle tracks.
                const subtitleOptions = Array.from(allItems).filter(item => {
                    const textElement = item.querySelector('.listItemBodyText');
                    if (!textElement) return false; // Ignore if it has no text.

                    const text = textElement.textContent.trim();
                    // Exclude Secondary Subtitles from the list.
                    if (text === 'Secondary Subtitles') return false;
                    // Return true if the item has text and is not a secondary subtitle.
                    return true;
                });

                if (subtitleOptions.length === 0) {
                    toast('❌ No Subtitles Found');
                    // Close the now-empty menu
                    document.body.click();
                    return;
                }

                // Step 3: Find the currently selected subtitle by looking for the checkmark icon.
                let currentIndex = -1;
                // Find the currently selected subtitle by looking for the checkmark icon
                subtitleOptions.forEach((option, index) => {
                    const checkIcon = option.querySelector('.listItemIcon.check');
                    // Check if the icon exists and is visible
                    if (checkIcon && getComputedStyle(checkIcon).visibility !== 'hidden') {
                        currentIndex = index;
                    }
                });

                // Step 4: Calculate the next index and click the corresponding option.
                const nextIndex = (currentIndex + 1) % subtitleOptions.length;
                const nextOption = subtitleOptions[nextIndex];

                if (nextOption) {
                    // Click the next subtitle option
                    nextOption.click();
                    // Show a confirmation toast with the name of the selected subtitle
                    const subtitleName = nextOption.querySelector('.listItemBodyText').textContent.trim();
                    toast(`📝 Subtitle: ${subtitleName}`);
                }
            };

            // Check if the subtitle menu is already open by looking for its title
            const subtitleMenuTitle = Array.from(document.querySelectorAll('.actionSheetContent .actionSheetTitle')).find(el => el.textContent === 'Subtitles');

            if (subtitleMenuTitle) {
                // If the menu is already open, just cycle the options
                performCycle();
            } else {
                // If any other menu is open, close it first before opening the subtitle menu
                if (document.querySelector('.actionSheetContent')) {
                    document.body.click();
                }
                // Click the main subtitle button in the player controls
                document.querySelector('button.btnSubtitles')?.click();
                // Wait a moment for the menu to open, then perform the cycle
                setTimeout(performCycle, 200);
            }
        };

        // Cycles through available audio tracks.
        const cycleAudioTrack = () => {
            // This function finds the audio menu and clicks the next available option, similar to subtitle cycling
            const performCycle = () => {
                // Step 1: Get all list items in the action sheet using a general selector.
                const allItems = document.querySelectorAll('.actionSheetContent .listItem');

                if (allItems.length === 0) {
                    toast('❌ No Audio Tracks Found');
                    document.body.click();
                    return;
                }

                // Step 2: Filter the items to get only the actual, selectable audio tracks.
                const audioOptions = Array.from(allItems).filter(item => {
                    const textElement = item.querySelector('.listItemBodyText.actionSheetItemText');
                    if (!textElement) return false; // Ignore if it has no text.

                    const text = textElement.textContent.trim();
                    // Include items that look like audio tracks (containing language info, codec info, etc.)
                    return text.length > 0;
                });

                if (audioOptions.length === 0) {
                    toast('❌ No Audio Tracks Found');
                    // Close the now-empty menu
                    document.body.click();
                    return;
                }

                // Step 3: Find the currently selected audio track by looking for the checkmark icon.
                let currentIndex = -1;
                // Find the currently selected audio track by looking for the checkmark icon
                audioOptions.forEach((option, index) => {
                    const checkIcon = option.querySelector('.actionsheetMenuItemIcon.listItemIcon.check');
                    // Check if the icon exists and is visible
                    if (checkIcon && getComputedStyle(checkIcon).visibility !== 'hidden') {
                        currentIndex = index;
                    }
                });

                // Step 4: Calculate the next index and click the corresponding option.
                const nextIndex = (currentIndex + 1) % audioOptions.length;
                const nextOption = audioOptions[nextIndex];

                if (nextOption) {
                    // Click the next audio option
                    nextOption.click();
                    // Show a confirmation toast with the name of the selected audio track
                    const audioName = nextOption.querySelector('.listItemBodyText.actionSheetItemText').textContent.trim();
                    toast(`🎵 Audio: ${audioName}`);
                }
            };

            // Check if the audio menu is already open by looking for its title
            const audioMenuTitle = Array.from(document.querySelectorAll('.actionSheetContent .actionSheetTitle')).find(el => el.textContent === 'Audio');

            if (audioMenuTitle) {
                // If the menu is already open, just cycle the options
                performCycle();
            } else {
                // If any other menu is open, close it first before opening the audio menu
                if (document.querySelector('.actionSheetContent')) {
                    document.body.click();
                }
                // Click the main audio button in the player controls
                document.querySelector('button.btnAudio')?.click();
                // Wait a moment for the menu to open, then perform the cycle
                setTimeout(performCycle, 200);
            }
        };

        // Cycles through video aspect ratio modes (Auto, Cover, Fill).
        const cycleAspect = () => {
            const opts = [...document.querySelectorAll('.actionSheetContent button[data-id="auto"], .actionSheetContent button[data-id="cover"], .actionSheetContent button[data-id="fill"]')];
            if (!opts.length) {
                document.querySelector('.actionSheetContent button[data-id="aspectratio"]')?.click();
                return setTimeout(cycleAspect, 120);
            }
            const current = opts.findIndex(b => b.querySelector('.check')?.style.visibility !== 'hidden');
            const next = opts[(current + 1) % opts.length];
            next?.click();
            toast(`📐 Aspect Ratio: ${next?.textContent.trim()}`);
        };

        /*
         * --------------------------------------------------------------------------------
         * SETTINGS & HELP PANEL
         * - A comprehensive UI panel for script settings and shortcuts
         * --------------------------------------------------------------------------------
         */
        const showEnhancedPanel = () => {
            const panelId = 'jellyfin-enhanced-panel';
            const existing = document.getElementById(panelId);
            if (existing) {
                existing.remove();
                return;
            }
            // Get the Jellyfish theme variables to apply consistent styles.
            const getJellyfinThemeVariable = (variableName, defaultValue) => {
                const rootStyle = getComputedStyle(document.documentElement);
                const value = rootStyle.getPropertyValue(variableName).trim();
                return value ? value : defaultValue;
            };

            const isJellyfishThemeActive = getJellyfinThemeVariable('--theme-updated-on', '') !== '' || getJellyfinThemeVariable('--theme-name', '').toLowerCase().includes('jellyfish');
            let panelBgColor, secondaryBg, headerFooterBg, primaryAccentColor, toggleAccentColor, kbdBackground, presetBoxBackground, detailsBackground, panelBlurValue, githubButtonBg, releaseNotesBg, checkUpdatesBorder, releaseNotesTextColor, logoUrl;
            if (isJellyfishThemeActive) {
                panelBgColor = getJellyfinThemeVariable('--primary-background-transparent', 'rgba(0,0,0,0.95)');
                secondaryBg = getJellyfinThemeVariable('--secondary-background-transparent', 'rgba(0,0,0,0.2)');
                headerFooterBg = secondaryBg;
                detailsBackground = secondaryBg;
                primaryAccentColor = getJellyfinThemeVariable('--primary-accent-color', '#00A4DC');
                toggleAccentColor = primaryAccentColor;
                kbdBackground = getJellyfinThemeVariable('--alt-accent-color', '#ffffff20');
                presetBoxBackground = getJellyfinThemeVariable('--alt-accent-color', '#ffffff20');
                panelBlurValue = getJellyfinThemeVariable('--blur', '20px');
                githubButtonBg = 'rgba(102, 179, 255, 0.1)';
                releaseNotesBg = primaryAccentColor;
                checkUpdatesBorder = `1px solid ${primaryAccentColor}`;
                releaseNotesTextColor = getJellyfinThemeVariable('--text-color', '#000000');
                const rawLogoValue = getJellyfinThemeVariable('--logo', '');
                logoUrl = rawLogoValue.replace(/url\(['"]?(.*?)['"]?\)/i, '$1');
            } else {
                panelBgColor = 'linear-gradient(135deg, rgba(0,0,0,0.95), rgba(20,20,20,0.95))';
                headerFooterBg = 'linear-gradient(135deg, rgba(0,0,0,0.95), rgba(20,20,20,0.95))';
                detailsBackground = 'rgba(0,0,0,0.2)';
                primaryAccentColor = '#00A4DC';
                toggleAccentColor = '#AA5CC3';
                kbdBackground = 'rgba(255,255,255,0.1)';
                presetBoxBackground = 'rgba(255,255,255,0.05)';
                panelBlurValue = '20px';
                githubButtonBg = 'rgba(102, 179, 255, 0.1)';
                releaseNotesBg = 'linear-gradient(135deg, #AA5CC3, #00A4DC)';
                checkUpdatesBorder = `1px solid ${primaryAccentColor}`;
                releaseNotesTextColor = '#FFFFFF';
            }

            const help = document.createElement('div');
            help.id = panelId;
            Object.assign(help.style, {
                position: 'fixed',
                top: '50%',
                left: '50%',
                transform: 'translate(-50%, -50%)',
                background: 'rgb(24, 24, 24)',
                color: '#fff',
                padding: '0',
                borderRadius: '16px',
                zIndex: 999999,
                fontSize: '14px',
                backdropFilter: `blur(${panelBlurValue})`,
                minWidth: '350px',
                maxWidth: '90vw',
                maxHeight: '90vh',
                boxShadow: '0 10px 30px rgba(0,0,0,0.7)',
                border: '1px solid rgba(255,255,255,0.1)',
                overflow: 'hidden',
                cursor: 'grab',
                display: 'flex',
                fontFamily: 'inherit',
                flexDirection: 'column'
            });

            const shortcuts = pluginConfig.Shortcuts.reduce((acc, s) => ({ ...acc, [s.Name]: s }), {});
            // --- Draggable Panel Logic ---------
            let isDragging = false;
            let offset = { x: 0, y: 0 };
            let autoCloseTimer = null;
            let isMouseInside = false;

            const resetAutoCloseTimer = () => {
                if (autoCloseTimer) clearTimeout(autoCloseTimer);
                autoCloseTimer = setTimeout(() => {
                    if (!isMouseInside && document.getElementById(panelId)) {
                        help.remove();
                        document.removeEventListener('keydown', closeHelp);
                        document.removeEventListener('mousemove', handleMouseMove);
                        document.removeEventListener('mouseup', handleMouseUp);
                        document.addEventListener('keydown', keyListener);
                    }
                }, CONFIG.HELP_PANEL_AUTOCLOSE_DELAY);
            };

            const handleMouseDown = (e) => {
                if (e.target.closest('.preset-box, button, a, details, input')) return;
                isDragging = true;
                offset = { x: e.clientX - help.getBoundingClientRect().left, y: e.clientY - help.getBoundingClientRect().top };
                help.style.cursor = 'grabbing';
                e.preventDefault();
                resetAutoCloseTimer();
            };

            const handleMouseMove = (e) => {
                if (isDragging) {
                    help.style.left = `${e.clientX - offset.x}px`;
                    help.style.top = `${e.clientY - offset.y}px`;
                    help.style.transform = 'none';
                }
                resetAutoCloseTimer();
            };

            const handleMouseUp = () => {
                isDragging = false;
                help.style.cursor = 'grab';
                resetAutoCloseTimer();
            };

            help.addEventListener('mousedown', handleMouseDown);
            document.addEventListener('mousemove', handleMouseMove);
            document.addEventListener('mouseup', handleMouseUp);
            // Reset the auto-close timer when the mouse enters or leaves the panel.
            help.addEventListener('mouseenter', () => { isMouseInside = true; if (autoCloseTimer) clearTimeout(autoCloseTimer); });
            help.addEventListener('mouseleave', () => { isMouseInside = false; resetAutoCloseTimer(); });
            help.addEventListener('click', resetAutoCloseTimer);
            help.addEventListener('wheel', (e) => { e.stopPropagation(); resetAutoCloseTimer(); });

            const generatePresetHTML = (presets, type) => {
                return presets.map((preset, index) => {
                    let previewStyle = '';
                    if (type === 'style') {
                        previewStyle = `background-color: ${preset.bgColor}; color: ${preset.textColor}; border: 1px solid rgba(255,255,255,0.3); text-shadow: #000000 0px 0px 3px;`;
                    } else if (type === 'font-size') {
                        previewStyle = `font-size: ${preset.size}em; color: #fff; text-shadow: 0 0 4px rgba(0,0,0,0.8);`;
                    } else if (type === 'font-family') {
                        previewStyle = `font-family: ${preset.family}; color: #fff; text-shadow: 0 0 4px rgba(0,0,0,0.8); font-size: 1.5em;`;
                    }
                    return `
                        <div class="preset-box ${type}-preset" data-preset-index="${index}" title="${preset.name}" style="display: flex; justify-content: center; align-items: center; padding: 8px; border: 2px solid transparent; border-radius: 8px; cursor: pointer; transition: all 0.2s; background: ${presetBoxBackground}; min-height: 30px;" onmouseover="this.style.background='rgba(255,255,255,0.3)'" onmouseout="this.style.background='${presetBoxBackground}'">
                            <span style="display: inline-block; ${type === 'style' ? `width: 40px; height: 25px; border-radius: 4px; line-height: 25px;` : ''} ${previewStyle} text-align: center; font-weight: bold;">${preset.previewText}</span>
                        </div>`;
                }).join('');
            };
            const userShortcuts = userShortcutManager.load();
            help.innerHTML = `
                <style>
                    #jellyfin-enhanced-panel .tabs { display: flex; border-bottom: 1px solid rgba(255,255,255,0.1); background: rgba(0,0,0,0.2); }
                    #jellyfin-enhanced-panel .tab-button { font-family: inherit; flex: 1; padding: 14px; text-align: center; cursor: pointer; background: transparent; border: none; color: rgba(255,255,255,0.6); font-size: 15px; font-weight: 600; transition: all 0.2s; border-bottom: 2px solid transparent; background: ${panelBgColor}; }
                    #jellyfin-enhanced-panel .tab-button:hover { background: ${panelBgColor}; color: #fff; }
                    #jellyfin-enhanced-panel .tab-button.active { color: #fff; border-bottom-color: ${primaryAccentColor}; background: ${headerFooterBg}; }
                    #jellyfin-enhanced-panel .tab-content { display: none; }
                    #jellyfin-enhanced-panel .tab-content.active { display: block; }
                    @keyframes shake {
                        10%, 90% { transform: translateX(-1px); }
                        20%, 80% { transform: translateX(2px); }
                        30%, 50%, 70% { transform: translateX(-4px); }
                        40%, 60% { transform: translateX(4px); }
                    }
                    .shake-error {
                        animation: shake 0.5s ease-in-out;
                    }
                </style>
                <div style="padding: 18px 20px; border-bottom: 1px solid rgba(255,255,255,0.1); background: ${headerFooterBg};">
                    <div style="font-size: 24px; font-weight: 700; margin-bottom: 8px; text-align: center; background: ${primaryAccentColor}; -webkit-background-clip: text; -webkit-text-fill-color: transparent;">🪼 Jellyfin Enhanced</div>
                    <div style="text-align: center; font-size: 12px; color: rgba(255,255,255,0.8);">Version ${pluginVersion}</div>
                </div>
                <div class="tabs">
                    <button class="tab-button" data-tab="shortcuts">Shortcuts</button>
                    <button class="tab-button" data-tab="settings">Settings</button>
                </div>
                <div class="panel-main-content" style="padding: 0 20px; flex: 1; overflow-y: auto; position: relative; background: ${panelBgColor};">
                     <div id="shortcuts-content" class="tab-content" style="padding-top: 20px; padding-bottom: 20px;">
                     <!-- Keyboard Shortcut Sections -->
                     <div class="shortcuts-container" style="display: flex; flex-wrap: wrap; gap: 20px; margin-bottom: 24px;">
                            <div style="flex: 1; min-width: 400px;">
                                <h3 style="margin: 0 0 12px 0; font-size: 18px; color: ${primaryAccentColor}; font-family: inherit;">Global</h3>
                                <div style="display: grid; gap: 8px; font-size: 14px;">
                                    ${pluginConfig.Shortcuts.filter(s => s.Category === 'Global').map(s => `
                                        <div style="display: flex; justify-content: space-between; align-items: center;">
                                            <span
                                            class="shortcut-key"
                                            tabindex="0"
                                            data-action="${s.Name}"
                                            style="background:${kbdBackground}; padding:2px 8px; border-radius:3px; cursor:pointer; transition: all 0.2s;"
                                            >${activeShortcuts[s.Name]}</span>
                                            <div style="display: flex; align-items: center; gap: 8px;">
                                                ${userShortcuts.hasOwnProperty(s.Name) ? `
                                                    <span title="Modified by user" style="color:${primaryAccentColor}; font-size: 20px; line-height: 1;">•</span>
                                                ` : ''}
                                                <span>${s.Label}</span>
                                            </div>
                                        </div>
                                    `).join('')}
                                </div>
                            </div>
                            <div style="flex: 1; min-width: 400px;">
                                <h3 style="margin: 0 0 12px 0; font-size: 18px; color: ${primaryAccentColor}; font-family: inherit;">Player</h3>
                                <div style="display: grid; gap: 8px; font-size: 14px;">
                                    ${pluginConfig.Shortcuts.filter(s => s.Category === 'Player').map(s => `
                                        <div style="display: flex; justify-content: space-between; align-items: center;">
                                            <span
                                            class="shortcut-key"
                                            tabindex="0"
                                            data-action="${s.Name}"
                                            style="background:${kbdBackground}; padding:2px 8px; border-radius:3px; cursor:pointer; transition: all 0.2s;"
                                            >${activeShortcuts[s.Name]}</span>
                                            <div style="display: flex; align-items: center; gap: 8px;">
                                                ${userShortcuts.hasOwnProperty(s.Name) ? `
                                                    <span class="modified-indicator" title="Modified" style="color:${primaryAccentColor}; font-size: 20px; line-height: 1;">•</span>
                                                ` : ''}
                                                <span>${s.Label}</span>
                                            </div>
                                        </div>
                                    `).join('')}
                                    <div style="display: flex; justify-content: space-between;">
                                        <span style="background:${kbdBackground}; padding:2px 8px; border-radius:3px;">0-9</span>
                                        <span>Jump to % of video</span>
                                    </div>
                                </div>
                            </div>
                            </div>
                            <div style="text-align: center; font-size: 11px; color: rgba(255,255,255,0.6);">
                                ⓘ Click a key to change it. Press <kbd style="background:${kbdBackground}; padding:1px 4px; border-radius:3px;">Backspace</kbd> while listening to reset to default.
                            </div>
                    </div>
                    <div id="settings-content" class="tab-content" style="padding-top: 20px; padding-bottom: 20px; width: 50vw;">
                        <details open style="margin-bottom: 16px; border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; background: ${detailsBackground};">
                            <summary style="padding: 16px; font-weight: 600; color: ${primaryAccentColor}; cursor: pointer; user-select: none; font-family: inherit;">⏯️ Playback Settings</summary>
                            <div style="padding: 0 16px 16px 16px;">
                                <div style="margin-bottom: 16px; padding: 12px; background: ${presetBoxBackground}; border-radius: 6px; border-left: 3px solid ${toggleAccentColor};">
                                    <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
                                        <input type="checkbox" id="autoPauseToggle" ${currentSettings.autoPauseEnabled ? 'checked' : ''} style="width:18px; height:18px; accent-color:${toggleAccentColor}; cursor:pointer;">
                                        <div><div style="font-weight:500;">Auto-pause</div><div style="font-size:12px; color:rgba(255,255,255,0.6); margin-top:2px;">Pause when switching tabs</div></div>
                                    </label>
                                </div>
                                <div style="padding: 12px; background: ${presetBoxBackground}; border-radius: 6px; border-left: 3px solid ${toggleAccentColor};">
                                    <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
                                        <input type="checkbox" id="autoResumeToggle" ${currentSettings.autoResumeEnabled ? 'checked' : ''} style="width:18px; height:18px; accent-color:${toggleAccentColor}; cursor:pointer;">
                                        <div><div style="font-weight:500;">Auto-resume</div><div style="font-size:12px; color:rgba(255,255,255,0.6); margin-top:2px;">Resume when returning to tab</div></div>
                                    </label>
                                </div>
                            </div>
                        </details>
                        <details style="margin-bottom: 16px; border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; background: ${detailsBackground};">
                            <summary style="padding: 16px; font-weight: 600; color: ${primaryAccentColor}; cursor: pointer; user-select: none; font-family: inherit;">↪️ Auto-Skip Settings</summary>
                            <div style="font-size:12px; color:rgba(255,255,255,0.6); margin-left: 18px; margin-bottom: 10px;"> ⓘ Depends on Intro-Skipper Plugin being available</div>
                            <div style="padding: 0 16px 16px 16px;">
                                <div style="margin-bottom: 16px; padding: 12px; background: ${presetBoxBackground}; border-radius: 6px; border-left: 3px solid ${toggleAccentColor};">
                                    <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
                                        <input type="checkbox" id="autoSkipIntroToggle" ${currentSettings.autoSkipIntro ? 'checked' : ''} style="width:18px; height:18px; accent-color:${toggleAccentColor}; cursor:pointer;">
                                        <div><div style="font-weight:500;">Automatically Skip Intro</div></div>
                                    </label>
                                </div>
                                <div style="padding: 12px; background: ${presetBoxBackground}; border-radius: 6px; border-left: 3px solid ${toggleAccentColor};">
                                    <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
                                        <input type="checkbox" id="autoSkipOutroToggle" ${currentSettings.autoSkipOutro ? 'checked' : ''} style="width:18px; height:18px; accent-color:${toggleAccentColor}; cursor:pointer;">
                                        <div><div style="font-weight:500;">Automatically Skip Outro</div></div>
                                    </label>
                                </div>
                            </div>
                        </details>
                        <details style="margin-bottom: 16px; border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; background: ${detailsBackground};">
                            <summary style="padding: 16px; font-weight: 600; color: ${primaryAccentColor}; cursor: pointer; user-select: none; font-family: inherit;">📝 Subtitle Settings</summary>
                            <div style="padding: 0 16px 16px 16px;">
                                <div style="margin-bottom: 16px;"><div style="font-weight: 600; margin-bottom: 8px;">Style</div><div id="subtitle-style-presets-container" style="display: grid; grid-template-columns: repeat(auto-fit, minmax(70px, 1fr)); gap: 8px;">${generatePresetHTML(subtitlePresets, 'style')}</div></div>
                                <div style="margin-bottom: 16px;"><div style="font-weight: 600; margin-bottom: 8px;">Size</div><div id="font-size-presets-container" style="display: grid; grid-template-columns: repeat(auto-fit, minmax(70px, 1fr)); gap: 8px;">${generatePresetHTML(fontSizePresets, 'font-size')}</div></div>
                                <div style="margin-bottom: 16px;"><div style="font-weight: 600; margin-bottom: 8px;">Font</div><div id="font-family-presets-container" style="display: grid; grid-template-columns: repeat(auto-fit, minmax(70px, 1fr)); gap: 8px;">${generatePresetHTML(fontFamilyPresets, 'font-family')}</div></div>
                            </div>
                        </details>
                        <details style="margin-bottom: 16px; border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; background: ${detailsBackground};">
                            <summary style="padding: 16px; font-weight: 600; color: ${primaryAccentColor}; cursor: pointer; user-select: none; font-family: inherit;">🎲 Random Button Settings</summary>
                            <div style="padding: 0 16px 16px 16px;">
                                <div style="margin-bottom:16px; padding:12px; background:${presetBoxBackground}; border-radius:6px; border-left:3px solid ${toggleAccentColor};">
                                    <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;"><input type="checkbox" id="randomButtonToggle" ${currentSettings.randomButtonEnabled ? 'checked' : ''} style="width:18px; height:18px; accent-color:${toggleAccentColor}; cursor:pointer;"><div><div style="font-weight:500;">Enable Random Button</div><div style="font-size:12px; color:rgba(255,255,255,0.6); margin-top:2px;">Show random button in header</div></div></label>
                                    <br>
                                    <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;"><input type="checkbox" id="randomUnwatchedOnly" ${currentSettings.randomUnwatchedOnly ? 'checked' : ''} style="width:18px; height:18px; accent-color:${toggleAccentColor}; cursor:pointer;"><div><div style="font-weight:500;">Unwatched Only</div><div style="font-size:12px; color:rgba(255,255,255,0.6); margin-top:2px;">Only select from unwatched items</div></div></label>
                                </div>
                                <div style="font-weight:500; margin-bottom:8px;">Item Types</div>
                                <div style="display:flex; gap:16px; padding:12px; background:${presetBoxBackground}; border-radius:6px; border-left:3px solid ${toggleAccentColor};">
                                    <label style="display: flex; align-items: center; gap: 8px; cursor: pointer;"><input type="checkbox" id="randomIncludeMovies" ${currentSettings.randomIncludeMovies ? 'checked' : ''} style="width:18px; height:18px; accent-color:${toggleAccentColor}; cursor:pointer;"><span>Movies</span></label>
                                    <label style="display: flex; align-items: center; gap: 8px; cursor: pointer;"><input type="checkbox" id="randomIncludeShows" ${currentSettings.randomIncludeShows ? 'checked' : ''} style="width:18px; height:18px; accent-color:${toggleAccentColor}; cursor:pointer;"><span>Shows</span></label>
                                </div>
                            </div>
                        </details>
                        <details style="margin-bottom: 16px; border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; background: ${detailsBackground};">
                            <summary style="padding: 16px; font-weight: 600; color: ${primaryAccentColor}; cursor: pointer; user-select: none; font-family: inherit;">🖥️ UI Settings</summary>
                            <div style="padding: 0 16px 16px 16px;">
                                <div style="margin-bottom: 16px; padding: 12px; background: ${presetBoxBackground}; border-radius: 6px; border-left: 3px solid ${toggleAccentColor};">
                                    <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
                                        <input type="checkbox" id="showFileSizesToggle" ${currentSettings.showFileSizes ? 'checked' : ''} style="width:18px; height:18px; accent-color:${toggleAccentColor}; cursor:pointer;">
                                        <div><div style="font-weight:500;">Show File Sizes</div><div style="font-size:12px; color:rgba(255,255,255,0.6); margin-top:2px;">Display total file size on item detail pages.</div></div>
                                    </label>
                                </div>
                                <div style="margin-bottom: 16px; padding: 12px; background: ${presetBoxBackground}; border-radius: 6px; border-left: 3px solid ${toggleAccentColor};">
                                    <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
                                        <input type="checkbox" id="showAudioLanguagesToggle" ${currentSettings.showAudioLanguages ? 'checked' : ''} style="width:18px; height:18px; accent-color:${toggleAccentColor}; cursor:pointer;">
                                        <div><div style="font-weight:500;">Show Audio Languages</div><div style="font-size:12px; color:rgba(255,255,255,0.6); margin-top:2px;">Display available audio languages on detail pages.</div></div>
                                    </label>
                                </div>
                                <div style="padding: 12px; background: ${presetBoxBackground}; border-radius: 6px; border-left: 3px solid ${toggleAccentColor};">
                                    <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
                                        <input type="checkbox" id="removeContinueWatchingToggle" ${currentSettings.removeContinueWatchingEnabled ? 'checked' : ''} style="width:18px; height:18px; accent-color:${toggleAccentColor}; cursor:pointer;">
                                        <div><div style="font-weight:500;">Add Remove from Continue Watching Button</div><div style="font-size:12px; color:rgba(255,255,255,0.6); margin-top:2px;">Add option to remove items from Continue Watching section</div><div style="font-size:12px; font-weight: bold; color:rgba(255, 55, 55, 1); margin-top:2px;">⚠️ This is as destructive action, it removes the watch progress of the item for the user</div></div>
                                    </label>
                                </div>

                            </div>
                        </details>
                    </div>
                </div>
                <div class="panel-footer" style="padding: 16px 20px; border-top: 1px solid rgba(255,255,255,0.1); background: ${headerFooterBg}; display: flex; justify-content: space-between; align-items: center;">
                    <div class="close-helptext" style="font-size:12px; color:rgba(255,255,255,0.5);">Press <kbd style="background:${kbdBackground}; padding:2px 4px; border-radius:3px;">?</kbd> or <kbd style="background:${kbdBackground}; padding:2px 4px; border-radius:3px;">Esc</kbd> to close</div>
                    ${logoUrl ? `<img src="${logoUrl}" class="footer-logo" alt="Theme Logo" style="height: 40px;">` : ''}
                    <div class="footer-buttons" style="display:flex; gap:12px; align-items:center;">
                        <button id="releaseNotesBtn" style="font-family:inherit; background:${releaseNotesBg}; color:${releaseNotesTextColor}; border:${checkUpdatesBorder}; padding:4px 8px; border-radius:6px; font-size:12px; font-weight:500; cursor:pointer; transition:all 0.2s; display:flex; align-items:center; gap:6px;" onmouseover="this.style.background='${primaryAccentColor}'" onmouseout="this.style.background='${releaseNotesBg}'">📋 Release Notes</button>
                        <a href="https://github.com/${GITHUB_REPO}/" target="_blank" style="color:${primaryAccentColor}; text-decoration:none; display:flex; align-items:center; gap:6px; font-size:12px; padding:4px 8px; border-radius:4px; background:${githubButtonBg}; transition:background 0.2s;" onmouseover="this.style.background='rgba(102, 179, 255, 0.2)'" onmouseout="this.style.background='${githubButtonBg}'"><svg height="12" viewBox="0 0 24 24" width="12" fill="currentColor"><path d="M12 1C5.923 1 1 5.923 1 12c0 4.867 3.149 8.979 7.521 10.436.55.096.756-.233.756-.522 0-.262-.013-1.128-.013-2.049-2.764.509-3.479-.674-3.699-1.292-.124-.317-.66-1.293-1.127-1.554-.385-.207-.936-.715-.014-.729.866-.014 1.485.797 1.691 1.128.99 1.663 2.571 1.196 3.204.907.096-.715.385-1.196.701-1.471-2.448-.275-5.005-1.224-5.005-5.432 0-1.196.426-2.186 1.128-2.956-.111-.275-.496-1.402.11-2.915 0 0 .921-.288 3.024 1.128a10.193 10.193 0 0 1 2.75-.371c.936 0 1.871.123 2.75.371 2.104-1.43 3.025-1.128 3.025-1.128.605 1.513.221 2.64.111 2.915.701.77 1.127 1.747 1.127 2.956 0 4.222-2.571 5.157-5.019 5.432.399.344.743 1.004.743 2.035 0 1.471-.014 2.654-.014 3.025 0 .289.206.632.756.522C19.851 20.979 23 16.854 23 12c0-6.077-4.922-11-11-11Z"></path></svg> Contribute</a>
                    </div>
                </div>
                <button id="closeSettingsPanel" style="position:absolute; top:24px; right:24px; background:rgba(255,255,255,0.1); border:none; color:#fff; font-size:16px; cursor:pointer; width:28px; height:28px; border-radius:50%; display:flex; align-items:center; justify-content:center; transition:background 0.2s;" onmouseover="this.style.background='rgba(255,255,255,0.2)'" onmouseout="this.style.background='rgba(255,255,255,0.1)'">×</button>
            `;

            document.body.appendChild(help);
            const shortcutKeys = help.querySelectorAll('.shortcut-key');
            shortcutKeys.forEach(keyElement => {
                 const getOriginalKey = () => activeShortcuts[keyElement.dataset.action];

                keyElement.addEventListener('click', () => keyElement.focus());

                keyElement.addEventListener('focus', () => {
                    keyElement.textContent = 'Listening...';
                    keyElement.style.borderColor = primaryAccentColor;
                    keyElement.style.width = '100px';
                });

                keyElement.addEventListener('blur', () => {
                    keyElement.textContent = getOriginalKey();
                    keyElement.style.borderColor = 'transparent';
                    keyElement.style.width = 'auto';
                });

                keyElement.addEventListener('keydown', (e) => {
                    e.preventDefault();
                    e.stopPropagation();

                    const labelWrapper = keyElement.nextElementSibling;

                    if (e.key === 'Backspace') {
                        const action = keyElement.dataset.action;

                        // Load, modify, and save the user's custom shortcuts
                        const userShortcuts = userShortcutManager.load();
                        delete userShortcuts[action];
                        userShortcutManager.save(userShortcuts);

                        // Find the original server default key from the plugin's configuration
                        const defaultConfig = pluginConfig.Shortcuts.find(s => s.Name === action);
                        const defaultKey = defaultConfig ? defaultConfig.Key : '';

                        // Update the active shortcuts in memory and what's shown on screen
                        activeShortcuts[action] = defaultKey;
                        keyElement.textContent = defaultKey;
                        const indicator = labelWrapper.querySelector('.modified-indicator');
                        if (indicator) {
                            indicator.remove();
                        }
                        keyElement.blur(); // Exit the "Listening..." mode
                        return;
                    }

                    if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) {
                        return; // Don't allow setting only a modifier key
                    }

                    const combo = (e.ctrlKey ? 'Ctrl+' : '') +
                                (e.altKey ? 'Alt+' : '') +
                                (e.shiftKey ? 'Shift+' : '') +
                                (e.key.match(/^[a-zA-Z]$/) ? e.key.toUpperCase() : e.key);

                    const action = keyElement.dataset.action;
                    const existingAction = Object.keys(activeShortcuts).find(name => activeShortcuts[name] === combo);
                    if (existingAction && existingAction !== action) {
                        keyElement.style.background = 'rgb(255 0 0 / 60%)';
                        keyElement.classList.add('shake-error');
                        setTimeout(() => {
                            keyElement.classList.remove('shake-error');
                            if (document.activeElement === keyElement) {
                                keyElement.style.background = kbdBackground;
                            }
                        }, 500);
                        // Reject the new keybinding and stop the function
                        return;
                    }
                    // Save the new shortcut
                    const userShortcuts = userShortcutManager.load();
                    userShortcuts[action] = combo;
                    userShortcutManager.save(userShortcuts);

                    // Update active shortcuts
                    activeShortcuts[action] = combo;

                    // Update the UI and exit edit mode
                    keyElement.textContent = combo;
                    if (labelWrapper && !labelWrapper.querySelector('.modified-indicator')) {
                        const indicator = document.createElement('span');
                        indicator.className = 'modified-indicator';
                        indicator.title = 'Modified by user';
                        indicator.style.cssText = `color:${primaryAccentColor}; font-size: 20px; line-height: 1;`;
                        indicator.textContent = '•';
                        labelWrapper.prepend(indicator);
                    }
                    keyElement.blur(); // Triggers the blur event to clean up styles
                });
            });
            resetAutoCloseTimer();

            // --- Remember last opened tab ---
            const tabButtons = help.querySelectorAll('.tab-button');
            const tabContents = help.querySelectorAll('.tab-content');

            // Set initial tab based on saved settings
            const lastTab = currentSettings.lastOpenedTab || 'shortcuts';
            tabButtons.forEach(btn => btn.classList.remove('active'));
            tabContents.forEach(content => content.classList.remove('active'));
            help.querySelector(`.tab-button[data-tab="${lastTab}"]`).classList.add('active');
            help.querySelector(`#${lastTab}-content`).classList.add('active');

            tabButtons.forEach(button => {
                button.addEventListener('click', () => {
                    const tab = button.dataset.tab;
                    tabButtons.forEach(btn => btn.classList.remove('active'));
                    button.classList.add('active');
                    tabContents.forEach(content => {
                        content.classList.remove('active');
                        if (content.id === `${tab}-content`) {
                            content.classList.add('active');
                        }
                    });
                    currentSettings.lastOpenedTab = tab;
                    saveSettings(currentSettings);
                    resetAutoCloseTimer();
                });
            });


            // Autoscroll when details sections open
            const allDetails = help.querySelectorAll('details');
            allDetails.forEach((details, index) => {
                details.addEventListener('toggle', () => {
                    if (details.open) {
                        setTimeout(() => {
                            details.scrollIntoView({ behavior: 'smooth', block: index === 0 ? 'center' : 'nearest' });
                        }, 150);
                    }
                    resetAutoCloseTimer();
                });
            });

            // --- Event Handlers for Settings Panel ---
            const closeHelp = (ev) => {
                if ((ev.type === 'keydown' && (ev.key === 'Escape' || ev.key === '?')) || (ev.type === 'click' && ev.target.id === 'closeSettingsPanel')) {
                    ev.stopPropagation();
                    if (autoCloseTimer) clearTimeout(autoCloseTimer);
                    help.remove();
                    document.removeEventListener('keydown', closeHelp);
                    document.removeEventListener('mousemove', handleMouseMove);
                    document.removeEventListener('mouseup', handleMouseUp);
                    document.addEventListener('keydown', keyListener);
                }
            };

            document.addEventListener('keydown', closeHelp);
            document.getElementById('closeSettingsPanel').addEventListener('click', closeHelp);
            document.removeEventListener('keydown', keyListener);

            // --- Variable declarations and event listeners ---
            const autoPauseToggle = document.getElementById('autoPauseToggle');
            const autoResumeToggle = document.getElementById('autoResumeToggle');
            const autoSkipIntroToggle = document.getElementById('autoSkipIntroToggle');
            const autoSkipOutroToggle = document.getElementById('autoSkipOutroToggle');
            const randomButtonToggle = document.getElementById('randomButtonToggle');
            const randomUnwatchedOnly = document.getElementById('randomUnwatchedOnly');
            const randomIncludeMovies = document.getElementById('randomIncludeMovies');
            const randomIncludeShows = document.getElementById('randomIncludeShows');
            const showFileSizesToggle = document.getElementById('showFileSizesToggle');
            const showAudioLanguagesToggle = document.getElementById('showAudioLanguagesToggle');
            const removeContinueWatchingToggle = document.getElementById('removeContinueWatchingToggle');

            autoPauseToggle.addEventListener('change', (e) => { currentSettings.autoPauseEnabled = e.target.checked; saveSettings(currentSettings); toast(`⏸️ Auto-Pause ${e.target.checked ? 'Enabled' : 'Disabled'}`); resetAutoCloseTimer(); });
            autoResumeToggle.addEventListener('change', (e) => { currentSettings.autoResumeEnabled = e.target.checked; saveSettings(currentSettings); toast(`▶️ Auto-Resume ${e.target.checked ? 'Enabled' : 'Disabled'}`); resetAutoCloseTimer(); });
            autoSkipIntroToggle.addEventListener('change', (e) => { currentSettings.autoSkipIntro = e.target.checked; saveSettings(currentSettings); toast(`↪️ Auto-Skip Intro ${e.target.checked ? 'Enabled' : 'Disabled'}`); resetAutoCloseTimer(); });
            autoSkipOutroToggle.addEventListener('change', (e) => { currentSettings.autoSkipOutro = e.target.checked; saveSettings(currentSettings); toast(`↪️ Auto-Skip Outro ${e.target.checked ? 'Enabled' : 'Disabled'}`); resetAutoCloseTimer(); });
            randomButtonToggle.addEventListener('change', (e) => { currentSettings.randomButtonEnabled = e.target.checked; saveSettings(currentSettings); toast(`🎲 Random Button ${e.target.checked ? 'Enabled' : 'Disabled'}`); addRandomButton(); resetAutoCloseTimer(); });
            randomUnwatchedOnly.addEventListener('change', (e) => { currentSettings.randomUnwatchedOnly = e.target.checked; saveSettings(currentSettings); toast(`🎲 Unwatched Only ${e.target.checked ? 'Enabled' : 'Disabled'}`); const unwatchedFilterButton = document.getElementById('unwatchedFilterButton'); if (unwatchedFilterButton) { unwatchedFilterButton.style.color = currentSettings.randomUnwatchedOnly ? 'var(--primary-accent-color, #00A4DC)' : 'inherit'; } resetAutoCloseTimer(); });
            randomIncludeMovies.addEventListener('change', (e) => { if (!e.target.checked && !randomIncludeShows.checked) { e.target.checked = true; toast('⚠️ At least one item type must be selected'); return; } currentSettings.randomIncludeMovies = e.target.checked; saveSettings(currentSettings); toast(`🎬 Movies ${e.target.checked ? 'included in' : 'excluded from'} random selection`); resetAutoCloseTimer(); });
            randomIncludeShows.addEventListener('change', (e) => { if (!e.target.checked && !randomIncludeMovies.checked) { e.target.checked = true; toast('⚠️ At least one item type must be selected'); return; } currentSettings.randomIncludeShows = e.target.checked; saveSettings(currentSettings); toast(`🍿 Shows ${e.target.checked ? 'included in' : 'excluded from'} random selection`); resetAutoCloseTimer(); });
            document.getElementById('releaseNotesBtn').addEventListener('click', async () => {
                await showReleaseNotesNotification();
                resetAutoCloseTimer();
            });
            showFileSizesToggle.addEventListener('change', (e) => {
                currentSettings.showFileSizes = e.target.checked;
                saveSettings(currentSettings);
                toast(`📄 File Size Display ${e.target.checked ? 'Enabled' : 'Disabled'}`);
                if (!e.target.checked) {
                    document.querySelectorAll('.mediaInfoItem-fileSize').forEach(el => el.remove());
                }
                resetAutoCloseTimer();
            });
            showAudioLanguagesToggle.addEventListener('change', (e) => {
                currentSettings.showAudioLanguages = e.target.checked;
                saveSettings(currentSettings);
                toast(`🗣️ Audio Language Display ${e.target.checked ? 'Enabled' : 'Disabled'}`);
                if (!e.target.checked) {
                    document.querySelectorAll('.mediaInfoItem-audioLanguage').forEach(el => el.remove());
                } else {
                    runLanguageCheck();
                }
                resetAutoCloseTimer();
            });
            removeContinueWatchingToggle.addEventListener('change', (e) => {
                currentSettings.removeContinueWatchingEnabled = e.target.checked;
                saveSettings(currentSettings);
                toast(`👁️ Remove Continue Watching ${e.target.checked ? 'Enabled' : 'Disabled'}`);
                resetAutoCloseTimer();
            });

            const setupPresetHandlers = (containerId, presets, type) => {
                const container = document.getElementById(containerId);
                if (!container) return;

                container.addEventListener('click', (e) => {
                    const presetBox = e.target.closest(`.${type}-preset`);
                    if (!presetBox) return;

                    const presetIndex = parseInt(presetBox.dataset.presetIndex, 10);
                    const selectedPreset = presets[presetIndex];

                    if (selectedPreset) {
                        if (type === 'style') {
                            currentSettings.selectedStylePresetIndex = presetIndex;
                            const fontSizeIndex = currentSettings.selectedFontSizePresetIndex ?? 2;
                            const fontFamilyIndex = currentSettings.selectedFontFamilyPresetIndex ?? 0;
                            const fontSize = fontSizePresets[fontSizeIndex].size;
                            const fontFamily = fontFamilyPresets[fontFamilyIndex].family;
                            applySubtitleStyles(selectedPreset.textColor, selectedPreset.bgColor, fontSize, fontFamily);
                            toast(`🎨 Subtitle Style: ${selectedPreset.name}`);
                        } else if (type === 'font-size') {
                            currentSettings.selectedFontSizePresetIndex = presetIndex;
                            const styleIndex = currentSettings.selectedStylePresetIndex ?? 0;
                            const fontFamilyIndex = currentSettings.selectedFontFamilyPresetIndex ?? 0;
                            const stylePreset = subtitlePresets[styleIndex];
                            const fontFamily = fontFamilyPresets[fontFamilyIndex].family;
                            applySubtitleStyles(stylePreset.textColor, stylePreset.bgColor, selectedPreset.size, fontFamily);
                            toast(`📏 Subtitle Size: ${selectedPreset.name}`);
                        } else if (type === 'font-family') {
                            currentSettings.selectedFontFamilyPresetIndex = presetIndex;
                            const styleIndex = currentSettings.selectedStylePresetIndex ?? 0;
                            const fontSizeIndex = currentSettings.selectedFontSizePresetIndex ?? 2;
                            const stylePreset = subtitlePresets[styleIndex];
                            const fontSize = fontSizePresets[fontSizeIndex].size;
                            applySubtitleStyles(stylePreset.textColor, stylePreset.bgColor, fontSize, selectedPreset.family);
                            toast(`🔤 Subtitle Font: ${selectedPreset.name}`);
                        }

                        saveSettings(currentSettings);
                        container.querySelectorAll('.preset-box').forEach(box => {
                            box.style.border = '2px solid transparent';
                        });
                        presetBox.style.border = `2px solid ${primaryAccentColor}`;
                        resetAutoCloseTimer();
                    }
                });

                let currentIndex;
                if (type === 'style') {
                    currentIndex = currentSettings.selectedStylePresetIndex ?? 0;
                } else if (type === 'font-size') {
                    currentIndex = currentSettings.selectedFontSizePresetIndex ?? 2;
                } else if (type === 'font-family') {
                    currentIndex = currentSettings.selectedFontFamilyPresetIndex ?? 0;
                }

                const activeBox = container.querySelector(`[data-preset-index="${currentIndex}"]`);
                if (activeBox) {
                    activeBox.style.border = `2px solid ${primaryAccentColor}`;
                }
            };

            setupPresetHandlers('subtitle-style-presets-container', subtitlePresets, 'style');
            setupPresetHandlers('font-size-presets-container', fontSizePresets, 'font-size');
            setupPresetHandlers('font-family-presets-container', fontFamilyPresets, 'font-family');
        };
        const onUserButtonLongPress = () => {
            const userButton = document.querySelector('.headerUserButton');

            if (!userButton || userButton.dataset.longPressEnhanced) {
                return;
            }

            let pressTimer = null;

            const startPress = (e) => {
                if (e.button && e.button !== 0) return; // Ignore non-left clicks
                userButton.classList.add('long-press-active');
                pressTimer = setTimeout(() => {
                    userButton.classList.remove('long-press-active');
                    showEnhancedPanel();
                    pressTimer = null; // Prevent click event after long press
                }, 750);
            };

            const cancelPress = () => {
                userButton.classList.remove('long-press-active');
                clearTimeout(pressTimer);
            };

            const handleClick = (e) => {
                if (!pressTimer) { // If timer is null, it means long press was triggered
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
            console.log('🪼 Jellyfin Enhanced: Long press event added to user button.');
        };
        /*
         * --------------------------------------------------------------------------------
        * KEYBOARD SHORTCUT SYSTEM
        * - Listens for keyboard shortcuts to trigger various actions.
        * --------------------------------------------------------------------------------
        */

        // Special listener for holding 'Shift+B' to clear all bookmarks.
        document.addEventListener('keydown', (e) => {
            if (e.key === 'B' && e.shiftKey && !isVideoPage()) {
                if (!shiftBTimer && !shiftBTriggered) {
                    shiftBTimer = setTimeout(() => {
                        if (!shiftBTriggered) {
                            localStorage.removeItem('jellyfinEnhancedBookmarks');
                            toast('🗑️ All Bookmarks Cleared');
                            shiftBTriggered = true;
                        }
                    }, CONFIG.CLEAR_BOOKMARKS_DELAY);
                }
            }
        });
        document.addEventListener('keyup', (e) => {
            if (e.key === 'B') {
                if (shiftBTimer) clearTimeout(shiftBTimer);
                shiftBTimer = null;
                setTimeout(() => { shiftBTriggered = false; }, 100);
            }
        });

       // The main key listener for all other shortcuts.
        const keyListener = (e) => {
            // Ignore shortcuts if typing in an input field.
            if (['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;

            const key = e.key;
            // Construct the key combination string (e.g., "Shift+B", "A")
            const combo = (e.shiftKey ? 'Shift+' : '') +
                        (e.ctrlKey ? 'Ctrl+' : '') +
                        (e.altKey ? 'Alt+' : '') +
                        (key.match(/^[a-zA-Z]$/) ? key.toUpperCase() : key);

            const video = getVideo();

            // --- Global Shortcuts ---
            if (combo === activeShortcuts.OpenSearch) {
                e.preventDefault();
                document.querySelector('button.headerSearchButton')?.click();
                setTimeout(() => document.querySelector('input[type="search"]')?.focus(), 100);
                toast('🔍 Search');
            } else if (combo === activeShortcuts.GoToHome) {
                e.preventDefault();
                location.href = '/web/#/home.html';
                toast('🏠 Home');
            } else if (combo === activeShortcuts.GoToDashboard) {
                e.preventDefault();
                location.href = '/web/#/dashboard';
                toast('📊 Dashboard');
            } else if (combo === activeShortcuts.QuickConnect) {
                e.preventDefault();
                location.href = '/web/#/quickconnect';
                toast('🔗 Quick Connect');
            } else if (key === '?') {
                e.preventDefault();
                e.stopPropagation();
                showEnhancedPanel();
            } else if (combo === activeShortcuts.PlayRandomItem && !isVideoPage()) {
                e.preventDefault();
                document.getElementById('randomItemButton')?.click();
            }

            // --- Player-Only Shortcuts ---
            if (!isVideoPage()) return;

            switch (combo) {
                case activeShortcuts.BookmarkCurrentTime: {
                    e.preventDefault();
                    e.stopPropagation();
                    if (!video) return;
                    const videoId = document.title?.replace(/^Playing:\s*/, '').trim() || 'unknown';
                    const bookmarks = JSON.parse(localStorage.getItem('jellyfinEnhancedBookmarks') || '{}');
                    bookmarks[videoId] = video.currentTime;
                    localStorage.setItem('jellyfinEnhancedBookmarks', JSON.stringify(bookmarks));
                    const h_set = Math.floor(video.currentTime / 3600);
                    const m_set = Math.floor((video.currentTime % 3600) / 60);
                    const s_set = Math.floor(video.currentTime % 60);
                    toast(`📍 Bookmarked at ${h_set > 0 ? `${h_set}:` : ''}${m_set.toString().padStart(h_set > 0 ? 2 : 1, '0')}:${s_set.toString().padStart(2, '0')}`);
                    break;
                }
                case activeShortcuts.GoToSavedBookmark: {
                    e.preventDefault();
                    e.stopPropagation();
                    if (!video) return;
                    const videoId_get = document.title?.replace(/^Playing:\s*/, '').trim() || 'unknown';
                    const bookmarks_get = JSON.parse(localStorage.getItem('jellyfinEnhancedBookmarks') || '{}');
                    const bookmarkTime = bookmarks_get[videoId_get];
                    if (bookmarkTime !== undefined) {
                        video.currentTime = bookmarkTime;
                        const h_get = Math.floor(bookmarkTime / 3600);
                        const m_get = Math.floor((bookmarkTime % 3600) / 60);
                        const s_get = Math.floor(bookmarkTime % 60);
                        toast(`📍 Returned to bookmark at ${h_get > 0 ? `${h_get}:` : ''}${m_get.toString().padStart(h_get > 0 ? 2 : 1, '0')}:${s_get.toString().padStart(2, '0')}`);
                    } else {
                        toast('❌ No Bookmarks Found!');
                    }
                    break;
                }
                case activeShortcuts.CycleAspectRatio: e.preventDefault(); e.stopPropagation(); openSettings(cycleAspect); break;
                case activeShortcuts.ShowPlaybackInfo: e.preventDefault(); e.stopPropagation(); openSettings(() => document.querySelector('.actionSheetContent button[data-id="stats"]')?.click()); break;
                case activeShortcuts.SubtitleMenu: e.preventDefault(); e.stopPropagation(); document.querySelector('button.btnSubtitles')?.click(); break;
                case activeShortcuts.CycleSubtitleTracks: e.preventDefault(); e.stopPropagation(); cycleSubtitleTrack(); break;
                case activeShortcuts.CycleAudioTracks: e.preventDefault(); e.stopPropagation(); cycleAudioTrack(); break;
                case activeShortcuts.ResetPlaybackSpeed: e.preventDefault(); e.stopPropagation(); resetPlaybackSpeed(); break;
                case activeShortcuts.IncreasePlaybackSpeed: e.preventDefault(); e.stopPropagation(); adjustPlaybackSpeed('increase'); break;
                case activeShortcuts.DecreasePlaybackSpeed: e.preventDefault(); e.stopPropagation(); adjustPlaybackSpeed('decrease'); break;
            }

            // Handle number keys for jumping
            if (key.match(/^[0-9]$/)) {
                jumpToPercentage(parseInt(key) * 10);
            }
        };

        // --- SCRIPT INITIALIZATION ---
        // Check if we need to clear local storage
        const serverClearTimestamp = pluginConfig.ClearLocalStorageTimestamp || 0;
        const localClearedTimestamp = parseInt(localStorage.getItem('jellyfinEnhancedLastCleared') || '0', 10);

        if (serverClearTimestamp > localClearedTimestamp) {
            localStorage.removeItem('jellyfinEnhancedSettings');
            localStorage.setItem('jellyfinEnhancedLastCleared', serverClearTimestamp.toString());

            setTimeout(() => {
                console.log(`🪼 Jellyfin Enhanced: Local storage cleared by admin request.`);
                toast('⚙️ All settings have been reset by the server admin.', 5000); //Show toast for 5 seconds
            }, 2000); // Delay of 2 seconds to allow any initial UI to load
        }
        injectRandomButtonStyles();
        addPluginMenuButton();
        onUserButtonLongPress();

        // Initialize remove continue watching functionality
        addContextMenuListener();
        observeActionSheets();

        const observer = new MutationObserver(() => {
            addRandomButton();
            runFileSizeCheck();
            runLanguageCheck();
        });
        observer.observe(document.body, { childList: true, subtree: true });
        addRandomButton();
        runFileSizeCheck();
        runLanguageCheck();
        document.addEventListener('keydown', keyListener);

        /* --- Auto-Pause/Resume on Tab Visibility Change --- */
        document.addEventListener('visibilitychange', () => {
            const video = getVideo();
            if (!video) return;
            if (document.hidden && !video.paused && currentSettings.autoPauseEnabled) {
                video.pause();
                video.dataset.wasPlayingBeforeHidden = 'true';
            } else if (!document.hidden && video.paused && video.dataset.wasPlayingBeforeHidden === 'true' && currentSettings.autoResumeEnabled) {
                video.play();
                delete video.dataset.wasPlayingBeforeHidden;
            }
        });
    }

    // --- JELLYFIN ELSEWHERE SCRIPT ---
    function initializeElsewhereScript() {
        // Configuration from plugin settings
        const TMDB_API_KEY = pluginConfig.TMDB_API_KEY || '';
        const DEFAULT_REGION = pluginConfig.DEFAULT_REGION || 'US';
        const DEFAULT_PROVIDERS = pluginConfig.DEFAULT_PROVIDERS ? pluginConfig.DEFAULT_PROVIDERS.replace(/'/g, '').replace(/\n/g, ',').split(',').map(s => s.trim()).filter(s => s) : [];
        const IGNORE_PROVIDERS = pluginConfig.IGNORE_PROVIDERS ? pluginConfig.IGNORE_PROVIDERS.replace(/'/g, '').replace(/\n/g, ',').split(',').map(s => s.trim()).filter(s => s) : [];

        // Skip initialization if no API key is configured
        if (!TMDB_API_KEY) {
            console.log('🪼 Jellyfin Enhanced: 🎬 Jellyfin Elsewhere: No TMDB API key configured, skipping initialization');
            return;
        }

        let userRegion = DEFAULT_REGION;
        let userRegions = []; // Multiple regions for search
        let userServices = []; // Empty by default - will show all services from settings region
        let availableRegions = {};
        let availableProviders = [];

        console.log('🪼 Jellyfin Enhanced: 🎬 Jellyfin Elsewhere starting...');

        // Load regions and providers from GitHub repo
        function loadRegionsAndProviders() {
            fetch(`https://raw.githubusercontent.com/n00bcodr/Jellyfin-Elsewhere/refs/heads/main/resources/regions.txt`)
                .then(response => response.ok ? response.text() : Promise.reject())
                .then(text => {
                    const lines = text.trim().split('\n');
                    lines.forEach(line => {
                        if (line.startsWith('#')) return;
                        const [code, name] = line.split('\t');
                        if (code && name) {
                            availableRegions[code] = name;
                        }
                    });
                })
                .catch(() => {
                    // Fallback to hardcoded regions
                    availableRegions = {
                        'US': 'United States', 'GB': 'United Kingdom', 'IN': 'India', 'CA': 'Canada',
                        'DE': 'Germany', 'FR': 'France', 'JP': 'Japan', 'AU': 'Australia',
                        'BR': 'Brazil', 'MX': 'Mexico', 'IE': 'Ireland', 'IT': 'Italy',
                        'ES': 'Spain', 'NL': 'Netherlands', 'SE': 'Sweden', 'NO': 'Norway',
                        'DK': 'Denmark', 'FI': 'Finland'
                    };
                });

                 // Load providers
            fetch(`https://raw.githubusercontent.com/n00bcodr/Jellyfin-Elsewhere/refs/heads/main/resources/providers.txt`)
                .then(response => response.ok ? response.text() : Promise.reject())
                .then(text => {
                    availableProviders = text.trim().split('\n')
                        .filter(line => !line.startsWith('#') && line.trim() !== '');
                })
                .catch(() => {
                    availableProviders = [
                        // Fallback to hardcoded providers
                        'Netflix', 'Amazon Prime Video', 'Disney Plus', 'HBO Max',
                        'Hulu', 'Apple TV Plus', 'Paramount Plus', 'Peacock',
                        'JioCinema', 'Disney+ Hotstar', 'ZEE5', 'SonyLIV'
                    ];
                });
        }

        function createMaterialIcon(iconName, size = '18px') {
            const icon = document.createElement('span');
            icon.className = 'material-icons';
            icon.textContent = iconName;
            icon.style.fontSize = size;
            icon.style.lineHeight = '1';
            return icon;
        }

        function createAutocompleteInput(placeholder, options, selectedValues, onSelect) {
            const container = document.createElement('div');
            container.style.cssText = 'position: relative; margin-bottom: 6px;';

            let debounceTimer;

            const input = document.createElement('input');
            input.type = 'text';
            input.placeholder = placeholder;
            input.style.cssText = `
                width: 100%;
                padding: 10px;
                border: 1px solid #444;
                border-radius: 6px;
                box-sizing: border-box;
                background: #2a2a2a;
                color: #fff;
                font-size: 14px;
            `;

            const dropdown = document.createElement('div');
            dropdown.style.cssText = `
                position: absolute;
                top: 100%;
                left: 0;
                right: 0;
                background: #1a1a1a;
                border: 1px solid #444;
                border-top: none;
                border-radius: 6px;
                max-height: 200px;
                overflow-y: auto;
                display: none;
                z-index: 1000;
            `;

            const selectedContainer = document.createElement('div');
            selectedContainer.style.cssText = `
                display: flex;
                flex-wrap: wrap;
                gap: 6px;
                margin-top: 6px;
            `;

            let selectedIndex = -1;
            let filteredOptions = [];

            function updateSelected() {
                selectedContainer.innerHTML = '';
                selectedValues.forEach(value => {
                    const tag = document.createElement('span');
                    tag.className = 'selected-tag';
                    tag.style.cssText = `
                        background: #0078d4;
                        color: white;
                        padding: 4px 10px;
                        border-radius: 16px;
                        font-size: 12px;
                        display: inline-flex;
                        align-items: center;
                        gap: 6px;
                    `;
                    tag.textContent = value;

                    const remove = document.createElement('span');
                    remove.textContent = '×';
                    remove.style.cssText = 'cursor: pointer; font-weight: bold; font-size: 14px;';
                    remove.onclick = () => {
                        const index = selectedValues.indexOf(value);
                        if (index > -1) {
                            selectedValues.splice(index, 1);
                            updateSelected();
                        }
                    };
                    tag.appendChild(remove);
                    selectedContainer.appendChild(tag);
                });
            }

            function showDropdown(options) {
                dropdown.innerHTML = '';
                dropdown.style.display = 'block';
                filteredOptions = options;
                selectedIndex = -1;

                options.forEach((option, index) => {
                    const item = document.createElement('div');
                    item.textContent = option;
                    item.style.cssText = `
                        padding: 10px;
                        cursor: pointer;
                        border-bottom: 1px solid #333;
                        color: #fff;
                        font-size: 14px;
                    `;
                    item.dataset.index = index;

                    item.onmouseenter = () => {
                        clearSelection();
                        item.style.background = '#333';
                        selectedIndex = index;
                    };

                    item.onmouseleave = () => {
                        item.style.background = '#1a1a1a';
                    };

                    item.onclick = () => selectOption(option);
                    dropdown.appendChild(item);
                });
            }

            function clearSelection() {
                dropdown.querySelectorAll('div').forEach(item => {
                    item.style.background = '#1a1a1a';
                });
            }

            function updateSelection() {
                clearSelection();
                if (selectedIndex >= 0 && selectedIndex < filteredOptions.length) {
                    const item = dropdown.querySelector(`[data-index="${selectedIndex}"]`);
                    if (item) {
                        item.style.background = '#333';
                        item.scrollIntoView({ block: 'nearest' });
                    }
                }
            }

            function selectOption(option) {
                if (!selectedValues.includes(option)) {
                    selectedValues.push(option);
                    updateSelected();
                    onSelect(selectedValues);
                }
                input.value = '';
                dropdown.style.display = 'none';
                selectedIndex = -1;
            }

            input.oninput = () => {
                clearTimeout(debounceTimer);
                debounceTimer = setTimeout(() => {
                    const value = input.value.toLowerCase();
                    if (value.length === 0) {
                        dropdown.style.display = 'none';
                        return;
                    }
                    const filtered = options.filter(option =>
                        option.toLowerCase().includes(value) && !selectedValues.includes(option)
                    );
                    showDropdown(filtered);
                }, 300);
            };

            input.onkeydown = (e) => {
                if (dropdown.style.display === 'none') return;

                switch (e.key) {
                    case 'ArrowDown':
                        e.preventDefault();
                        selectedIndex = Math.min(selectedIndex + 1, filteredOptions.length - 1);
                        updateSelection();
                        break;
                    case 'ArrowUp':
                        e.preventDefault();
                        selectedIndex = Math.max(selectedIndex - 1, -1);
                        updateSelection();
                        break;
                    case 'Enter':
                        e.preventDefault();
                        if (selectedIndex >= 0 && selectedIndex < filteredOptions.length) {
                            selectOption(filteredOptions[selectedIndex]);
                        }
                        break;
                    case 'Escape':
                        dropdown.style.display = 'none';
                        selectedIndex = -1;
                        break;
                }
            };

            input.onblur = (e) => {
                // Delay hiding to allow clicks on dropdown items
                setTimeout(() => {
                    if (!dropdown.contains(document.activeElement)) {
                        dropdown.style.display = 'none';
                    }
                }, 200);
            };

            container.appendChild(input);
            container.appendChild(dropdown);
            container.appendChild(selectedContainer);

            updateSelected();
            return container;
        }
        // Create settings modal
        function createSettingsModal() {
            const modal = document.createElement('div');
            modal.id = 'streaming-settings-modal';
            modal.style.cssText = `
                position: fixed;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                background: rgba(0,0,0,0.85);
                display: none;
                z-index: 10000;
                align-items: center;
                justify-content: center;
            `;

            const content = document.createElement('div');
            content.style.cssText = `
                background: #181818;
                padding: 20px;
                border-radius: 8px;
                max-width: 500px;
                width: 90%;
                max-height: 80vh;
                overflow-y: auto;
                color: #fff;
                border: 1px solid #333;
                box-shadow: 0 8px 32px rgba(0,0,0,0.5);
            `;

            content.innerHTML = `
                <h3 style="margin-top: 0; margin-bottom: 16px; color: #fff; font-size: 18px; font-weight: bolder;">Search Settings</h3>

                <div style="margin-bottom: 16px;">
                    <label style="display: block; margin-bottom: 6px; font-weight: 600; color: #ccc;">Default Search Country</label>
                    <select id="region-select" style="width: 100%; padding: 12px; border: 1px solid #444; border-radius: 6px; background: #2a2a2a; color: #fff; font-size: 14px;">
                        ${Object.entries(availableRegions).map(([code, name]) =>
                            `<option value="${code}" ${code === userRegion ? 'selected' : ''}>${name}</option>`
                        ).join('')}
                    </select>
                </div>

                <div style="margin-bottom: 16px;">
                    <label style="display: block; margin-bottom: 5px; font-weight: 600; color: #ccc;">Search Other Countries (leave empty to use default)</label>
                    <div id="regions-autocomplete"></div>
                </div>

               <div style="margin-bottom: 16px;">
                    <label style="display: block; margin-bottom: 6px; font-weight: 600; color: #ccc;">Providers (leave empty to show all available)</label>
                    <div id="services-autocomplete"></div>
                </div>

                <div style="display: flex; gap: 12px; justify-content: flex-end;">
                    <button id="cancel-settings" style="padding: 10px 18px; border: 1px solid #444; background: #2a2a2a; color: #fff; border-radius: 6px; cursor: pointer; font-size: 14px;">Cancel</button>
                    <button id="save-settings" style="padding: 10px 18px; border: none; background: #0078d4; color: white; border-radius: 6px; cursor: pointer; font-size: 14px;">Save</button>
                </div>
            `;

            modal.appendChild(content);
            document.body.appendChild(modal);

            // Add autocomplete for regions
            const regionsContainer = content.querySelector('#regions-autocomplete');
            const regionOptions = Object.entries(availableRegions).map(([code, name]) => `${name} (${code})`);
            const regionsAutocomplete = createAutocompleteInput(
                'Type to add countries...',
                regionOptions,
                userRegions.map(code => `${availableRegions[code] || code} (${code})`),
                (selected) => {}
            );
            regionsContainer.appendChild(regionsAutocomplete);

            // Add autocomplete for services
            const servicesContainer = content.querySelector('#services-autocomplete');
            const servicesAutocomplete = createAutocompleteInput(
                'Type to add providers...',
                availableProviders,
                userServices.slice(),
                (selected) => {}
            );
            servicesContainer.appendChild(servicesAutocomplete);

            document.getElementById('cancel-settings').onclick = () => {
                modal.style.display = 'none';
            };

            document.getElementById('save-settings').onclick = () => {
                userRegion = document.getElementById('region-select').value;

                // Get selected regions from autocomplete
                const selectedRegions = [];
                regionsContainer.querySelectorAll('.selected-tag').forEach(tag => {
                    const text = tag.textContent.replace('×', '').trim();
                    const match = text.match(/\(([A-Z]{2})\)$/);
                    if (match) {
                        selectedRegions.push(match[1]);
                    }
                });
                userRegions = selectedRegions;

                // Get selected services from autocomplete
                const selectedServices = [];
                servicesContainer.querySelectorAll('.selected-tag').forEach(tag => {
                    selectedServices.push(tag.textContent.replace('×', '').trim());
                });
                userServices = selectedServices;

                modal.style.display = 'none';
                localStorage.setItem('streaming-settings', JSON.stringify({
                    region: userRegion,
                    regions: userRegions,
                    services: userServices
                }));
            };

            // Close on backdrop click
            modal.onclick = (e) => {
                if (e.target === modal) {
                    modal.style.display = 'none';
                }
            };
        }

        // Load saved settings
        function loadSettings() {
            const saved = localStorage.getItem('streaming-settings');
            if (saved) {
                try {
                    const settings = JSON.parse(saved);
                    userRegion = settings.region || DEFAULT_REGION;
                    userRegions = settings.regions || [];
                    userServices = settings.services || [];
                } catch (e) {
                    console.log('🪼 Jellyfin Enhanced: 🎬 Jellyfin Elsewhere: Error loading settings:', e);
                }
            }
        }

        function createServiceBadge(service, tmdbId, mediaType) {
            const badge = document.createElement('div');
            badge.style.cssText = `
                display: inline-flex;
                align-items: center;
                padding: 6px 10px;
                margin: 3px 5px 3px 0;
                border-radius: 8px;
                font-size: 13px;
                font-weight: 500;
                color: #fff;
                white-space: nowrap;
                transition: all 500ms ease;
                background: rgba(255, 255, 255, 0.1);
                border: 1px solid rgba(255, 255, 255, 0.2);
                backdrop-filter: blur(10px);
            `;

            const logo = document.createElement('img');
            logo.src = `https://image.tmdb.org/t/p/w92${service.logo_path}`;
            logo.alt = service.provider_name;
            logo.style.cssText = `
                width: 20px;
                height: 20px;
                margin-right: 8px;
                object-fit: contain;
                border-radius: 4px;
            `;

            logo.onerror = () => logo.style.display = 'none';
            badge.appendChild(logo);

            const text = document.createElement('span');
            text.textContent = service.provider_name;
            badge.appendChild(text);

            // Hover effects
            badge.onmouseenter = () => {
                badge.style.transform = 'translateY(-2px)';
                badge.style.background = 'rgba(255, 255, 255, 0.2)';
                badge.style.boxShadow = '0 4px 12px rgba(0, 0, 0, 0.3)';
            };

            badge.onmouseleave = () => {
                badge.style.transform = 'translateY(0)';
                badge.style.background = 'rgba(255, 255, 255, 0.1)';
                badge.style.boxShadow = 'none';
            };

            return badge;
        }

        // Fetch streaming data
        function fetchStreamingData(tmdbId, mediaType, callback) {
            if (!TMDB_API_KEY) {
                callback('Please configure your TMDB API Key in the plugin settings');
                return;
            }

            const url = `https://api.themoviedb.org/3/${mediaType}/${tmdbId}/watch/providers?api_key=${TMDB_API_KEY}`;

            fetch(url)
                .then(response => {
                    if (response.ok) {
                        return response.json();
                    } else {
                        throw new Error(`API Error: ${response.status}`);
                    }
                })
                .then(data => callback(null, data))
                .catch(error => {
                    let errorMessage;
                    const errorMessageText = error.message || '';

                    // Check 1: Network error (browser couldn't connect)
                    if (error instanceof TypeError && errorMessageText === 'Failed to fetch') {
                        errorMessage = 'TMDB API is unreachable.';

                    // Check 2: Invalid API Key error
                    } else if (errorMessageText.includes('401')) {
                        errorMessage = 'Invalid TMDB API Key.';

                    // Check 3: Item not found
                    } else if (errorMessageText.includes('404')) {
                        errorMessage = 'The requested item could not be found on TMDB.';

                    // Check 4: Rate limit error
                    } else if (errorMessageText.includes('429')) {
                        errorMessage = 'Too many requests. Please wait a moment and try again.';

                    // Check 5: TMDB server-side issues (e.g., 500, 502, 503, 504)
                    } else if (errorMessageText.startsWith('API Error: 5')) {
                        errorMessage = 'The TMDB service is temporarily unavailable. Please try again later.';

                    // Fallback: All other errors
                    } else {
                        errorMessage = errorMessageText || 'An unknown error occurred';
                    }

                    callback(errorMessage);
                });
        }

        // Process streaming data for default region (auto-load)
        function processDefaultRegionData(data, tmdbId, mediaType) {
            const regionData = data.results[DEFAULT_REGION];

            const container = document.createElement('div');
            container.style.cssText = `
                margin: 10px 0;
                padding: 12px;
                background: rgba(0, 0, 0, 0.2);
                border-radius: 8px;
                border: 1px solid rgba(255, 255, 255, 0.1);
                backdrop-filter: blur(10px);
                position: relative;
            `;

            // Create header with title and controls
            const header = document.createElement('div');
            header.style.cssText = `
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-bottom: 10px;
            `;

            // Create clickable title that links to JustWatch
            const title = document.createElement('a');

            // Check if services are available in default region
            const hasServices = regionData && regionData.flatrate && regionData.flatrate.length > 0;

            if (hasServices) {
                title.textContent = `Also available in ${availableRegions[DEFAULT_REGION] || DEFAULT_REGION} on:`;
            } else {
                title.textContent = `Not available on any streaming services in ${availableRegions[DEFAULT_REGION] || DEFAULT_REGION}`;
            }

            title.style.cssText = `
                font-weight: 600;
                font-size: 14px;
                text-decoration: none;
                cursor: pointer;
                color: #fff;
                flex: 1;
            `;

            // Add JustWatch link if available
            if (regionData && regionData.link) {
                title.href = regionData.link;
                title.target = '_blank';
                title.title = 'View on JustWatch';
            }

             // Create controls container
            const controls = document.createElement('div');
            controls.style.cssText = `
                display: flex;
                gap: 8px;
                align-items: center;
            `;

            // Search button with Material Icon
            const searchButton = document.createElement('button');
            const searchIcon = createMaterialIcon('search', '16px');
            searchButton.appendChild(searchIcon);
            searchButton.appendChild(document.createTextNode(''));

            searchButton.style.cssText = `
                display: flex;
                align-items: center;
                gap: 6px;
                background: rgba(255, 255, 255, 0.1);
                color: #fff;
                border: 1px solid rgba(255, 255, 255, 0.2);
                padding: 6px 12px;
                border-radius: 4px;
                font-size: 12px;
                font-weight: 500;
                cursor: pointer;
                transition: all 500ms ease;
            `;

            searchButton.onmouseenter = () => {
                searchButton.style.background = 'rgba(255, 255, 255, 0.2)';
            };

            searchButton.onmouseleave = () => {
                searchButton.style.background = 'rgba(255, 255, 255, 0.1)';
            };

            // Settings button with Material Icon
            const settingsButton = document.createElement('button');
            const settingsIcon = createMaterialIcon('settings', '16px');
            settingsButton.appendChild(settingsIcon);

            settingsButton.title = 'Settings';
            settingsButton.style.cssText = `
                display: flex;
                align-items: center;
                justify-content: center;
                background: rgba(255, 255, 255, 0.1);
                color: #fff;
                border: 1px solid rgba(255, 255, 255, 0.2);
                padding: 6px;
                border-radius: 4px;
                cursor: pointer;
                transition: all 500ms ease;
                width: 28px;
                height: 28px;
            `;

            settingsButton.onmouseenter = () => {
                settingsButton.style.background = 'rgba(255, 255, 255, 0.2)';
            };

            settingsButton.onmouseleave = () => {
                settingsButton.style.background = 'rgba(255, 255, 255, 0.1)';
            };

            settingsButton.onclick = () => {
                const modal = document.getElementById('streaming-settings-modal');
                if (modal) {
                    modal.style.display = 'flex';
                }
            };

            controls.appendChild(searchButton);
            controls.appendChild(settingsButton);
            header.appendChild(title);
            header.appendChild(controls);
            container.appendChild(header);

            // Only show services if they exist
            if (hasServices) {
                // Filter services based on DEFAULT_PROVIDERS
                let services = regionData.flatrate;
                if (DEFAULT_PROVIDERS.length > 0) {
                    services = services.filter(service =>
                        DEFAULT_PROVIDERS.includes(service.provider_name)
                    );
                }

                // Apply ignore list using regular expressions
                if (IGNORE_PROVIDERS.length > 0) {
                    try {
                        // 'i' for case-insensitive
                        const ignorePatterns = IGNORE_PROVIDERS.map(pattern => new RegExp(pattern, 'i'));
                        services = services.filter(service =>
                            !ignorePatterns.some(regex => regex.test(service.provider_name))
                        );
                    } catch (e) {
                        console.error('🪼 Jellyfin Enhanced: 🎬 Jellyfin Elsewhere: Invalid regex in IGNORE_PROVIDERS.', e);
                    }
                }

                if (services.length === 0) {
                    const noServices = document.createElement('div');
                    noServices.textContent = DEFAULT_PROVIDERS.length > 0
                        ? 'No configured services available'
                        : 'Not available on any streaming services';
                    noServices.style.cssText = 'color: #999; font-size: 13px; margin-bottom: 12px;';
                    container.appendChild(noServices);
                } else {
                    const servicesContainer = document.createElement('div');
                    servicesContainer.style.cssText = 'display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 12px;';

                    services.forEach(service => {
                        servicesContainer.appendChild(createServiceBadge(service, tmdbId, mediaType));
                    });

                    container.appendChild(servicesContainer);
                }
            }

            // Create manual result container for search results
            const resultContainer = document.createElement('div');
            resultContainer.id = 'streaming-result-container';
            container.appendChild(resultContainer);

            // Add click handler for manual lookup (multiple regions)
            searchButton.onclick = () => {
                searchButton.disabled = true;
                searchButton.innerHTML = '';
                const loadingIcon = createMaterialIcon('refresh', '16px');
                loadingIcon.style.animation = 'spin 1s linear infinite';
                searchButton.appendChild(loadingIcon);
                searchButton.appendChild(document.createTextNode(' Searching...'));
                searchButton.style.opacity = '0.7';
                resultContainer.innerHTML = '';

                // Add spinning animation
                const style = document.createElement('style');
                style.textContent = `
                    @keyframes spin {
                        0% { transform: rotate(0deg); }
                        100% { transform: rotate(360deg); }
                    }
                `;
                if (!document.querySelector('style[data-jellyfin-elsewhere]')) {
                    style.setAttribute('data-jellyfin-elsewhere', 'true');
                    document.head.appendChild(style);
                }

                fetchStreamingData(tmdbId, mediaType, (error, data) => {
                    searchButton.disabled = false;
                    searchButton.innerHTML = '';
                    const searchIcon = createMaterialIcon('search', '16px');
                    searchButton.appendChild(searchIcon);
                    searchButton.appendChild(document.createTextNode(''));
                    searchButton.style.opacity = '1';

                    if (error) {
                        resultContainer.innerHTML = `<div style="color: #ff6b6b; font-size: 13px; margin-top: 8px;">Error: ${error}</div>`;
                        return;
                    }

                    // Show results for multiple regions
                    const regionsToSearch = userRegions.length > 0 ? userRegions : [userRegion];

                    let hasAnyResults = false;
                    const unavailableRegions = [];

                    regionsToSearch.forEach((region, index) => {
                        const regionData = data.results[region];
                        const hasServices = regionData && regionData.flatrate && regionData.flatrate.length > 0;

                        if (hasServices) {
                            // Filter services based on user preferences
                            let services = regionData.flatrate;
                            if (userServices.length > 0) {
                                services = services.filter(service =>
                                    userServices.includes(service.provider_name)
                                );
                            }

                            if (services.length > 0) {
                                hasAnyResults = true;
                                const regionResult = processRegionData(data, tmdbId, mediaType, region, true);
                                if (regionResult) {
                                    if (index > 0 || unavailableRegions.length > 0) {
                                        regionResult.style.marginTop = '6px';
                                    }
                                    resultContainer.appendChild(regionResult);
                                }
                            } else {
                                unavailableRegions.push(region);
                            }
                        } else {
                            unavailableRegions.push(region);
                        }
                    });

                    // Show unavailable regions first if there are any
                    if (unavailableRegions.length > 0) {
                        const unavailableContainer = createUnavailableRegionsDisplay(unavailableRegions);
                        resultContainer.insertBefore(unavailableContainer, resultContainer.firstChild);
                    }

                    // If no results found anywhere, show a general message
                    if (!hasAnyResults && unavailableRegions.length === 0) {
                        const noServices = document.createElement('div');
                        noServices.style.cssText = 'color: #6c757d; font-size: 13px; margin-top: 8px;';
                        noServices.textContent = `No streaming services available in selected regions`;
                        resultContainer.appendChild(noServices);
                    }
                });
            };

            return container;
        }

        // Create display for unavailable regions
        function createUnavailableRegionsDisplay(unavailableRegions) {
            const container = document.createElement('div');
            container.style.cssText = `
                margin: 0 0 6px 0;
                padding: 12px;
                border-radius: 8px;
                border: 1px solid rgba(139, 19, 19, 0.6);
                background: rgba(139, 19, 19, 0.3);
                backdrop-filter: blur(10px);
                position: relative;
            `;

            // Create header with title and close button
            const header = document.createElement('div');
            header.style.cssText = `
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-bottom: 0;
            `;

            const title = document.createElement('div');
            const regionNames = unavailableRegions.map(region => availableRegions[region] || region);
            const regionText = regionNames.length === 1 ? regionNames[0] :
                              regionNames.length === 2 ? regionNames.join(' and ') :
                              regionNames.slice(0, -1).join(', ') + ' and ' + regionNames[regionNames.length - 1];

            title.textContent = `Not available on any streaming services in ${regionText}`;
            title.style.cssText = `
                font-weight: 600;
                font-size: 14px;
                color: rgb(255, 20, 20);
                flex: 1;
            `;

            // Create close button
            const closeButton = document.createElement('button');
            const closeIcon = createMaterialIcon('close', '16px');
            closeButton.appendChild(closeIcon);
            closeButton.title = 'Close';
            closeButton.style.cssText = `
                display: flex;
                align-items: center;
                justify-content: center;
                background: rgba(255, 255, 255, 0.1);
                color: #fff;
                border: 1px solid rgba(255, 255, 255, 0.2);
                padding: 6px;
                border-radius: 4px;
                cursor: pointer;
                transition: all 500ms ease;
                width: 28px;
                height: 28px;
            `;

            closeButton.onmouseenter = () => {
                closeButton.style.background = 'rgba(255, 0, 0, 0.2)';
                closeButton.style.borderColor = 'rgba(255, 0, 0, 0.3)';
            };

            closeButton.onmouseleave = () => {
                closeButton.style.background = 'rgba(255, 255, 255, 0.1)';
                closeButton.style.borderColor = 'rgba(255, 255, 255, 0.2)';
            };

            closeButton.onclick = () => {
                container.remove();
            };

            header.appendChild(title);
            header.appendChild(closeButton);
            container.appendChild(header);

            return container;
        }

        // Process streaming data for a specific region
        function processRegionData(data, tmdbId, mediaType, region, showAvailable = false) {
            const regionData = data.results[region];
            if (!regionData || !regionData.flatrate) {
                return null;
            }

            // Filter services based on user preferences
            const services = regionData.flatrate.filter(service =>
                userServices.length === 0 || userServices.includes(service.provider_name)
            );

            // Don't show container if no services match filters
            if (services.length === 0) {
                return null;
            }

            const container = document.createElement('div');
            container.style.cssText = `
                margin: 10px 0 0 0;
                padding: 12px;
                background: rgba(0, 0, 0, 0.3);
                border-radius: 8px;
                border: 1px solid rgba(255, 255, 255, 0.1);
                backdrop-filter: blur(10px);
                position: relative;
            `;

            // Create header with title and close button
            const header = document.createElement('div');
            header.style.cssText = `
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-bottom: 10px;
            `;

            // Create clickable title that links to JustWatch
            const title = document.createElement('a');
            title.textContent = `Available in ${availableRegions[region] || region} on:`;
            title.style.cssText = `
                font-weight: 600;
                font-size: 14px;
                text-decoration: none;
                cursor: pointer;
                color: #fff;
                flex: 1;
            `;

            // Add JustWatch link if available and enabled
            if (regionData.link) {
                title.href = regionData.link;
                title.target = '_blank';
                title.title = 'View on JustWatch';
            }

            // Create close button
            const closeButton = document.createElement('button');
            const closeIcon = createMaterialIcon('close', '16px');
            closeButton.appendChild(closeIcon);
            closeButton.title = 'Close';
            closeButton.style.cssText = `
                display: flex;
                align-items: center;
                justify-content: center;
                background: rgba(255, 255, 255, 0.1);
                color: #fff;
                border: 1px solid rgba(255, 255, 255, 0.2);
                padding: 6px;
                border-radius: 4px;
                cursor: pointer;
                transition: all 500ms ease;
                width: 28px;
                height: 28px;
            `;

            closeButton.onmouseenter = () => {
                closeButton.style.background = 'rgba(255, 0, 0, 0.2)';
                closeButton.style.borderColor = 'rgba(255, 0, 0, 0.3)';
            };

            closeButton.onmouseleave = () => {
                closeButton.style.background = 'rgba(255, 255, 255, 0.1)';
                closeButton.style.borderColor = 'rgba(255, 255, 255, 0.2)';
            };

            closeButton.onclick = () => {
                container.remove();
            };

            header.appendChild(title);
            header.appendChild(closeButton);
            container.appendChild(header);

            const servicesContainer = document.createElement('div');
            servicesContainer.style.cssText = 'display: flex; flex-wrap: wrap; gap: 3px;';

            services.forEach(service => {
                servicesContainer.appendChild(createServiceBadge(service, tmdbId, mediaType));
            });

            container.appendChild(servicesContainer);

            return container;
        }

        // Auto-load streaming data on page load (default region only)
        function autoLoadStreamingData(tmdbId, mediaType, container) {
            fetchStreamingData(tmdbId, mediaType, (error, data) => {
                if (error) {
                    const errorDiv = document.createElement('div');
                    errorDiv.style.cssText = 'font-size: 13px; margin-top: 8px; color: #ff6b6b;';
                    errorDiv.textContent = `Error: ${error}`;
                    container.appendChild(errorDiv);
                    return;
                }

                // Show default region results automatically
                const defaultResult = processDefaultRegionData(data, tmdbId, mediaType);
                if (defaultResult) {
                    container.appendChild(defaultResult);
                }
            });
        }

        // Add buttons to detail pages
        function addStreamingLookup() {
            const detailSections = document.querySelectorAll('.detailSectionContent');

            detailSections.forEach(section => {
                // Skip if already processed
                if (section.querySelector('.streaming-lookup-container')) return;

                // Look for TMDB link to get ID and media type
                const tmdbLinks = section.querySelectorAll('a[href*="themoviedb.org"]');
                if (tmdbLinks.length === 0) return;

                const tmdbLink = tmdbLinks[0];
                const match = tmdbLink.href.match(/themoviedb\.org\/(movie|tv)\/(\d+)/);
                if (!match) return;

                const mediaType = match[1];
                const tmdbId = match[2];

                // Create container
                const container = document.createElement('div');
                container.className = 'streaming-lookup-container';
                container.style.cssText = 'margin: 16px 0;';

                // Auto-load streaming data for default region
                autoLoadStreamingData(tmdbId, mediaType, container);

                // Insert after external links or at the end
                const externalLinks = section.querySelector('.itemExternalLinks');
                if (externalLinks) {
                    externalLinks.parentNode.insertBefore(container, externalLinks.nextSibling);
                } else {
                    section.appendChild(container);
                }
            });
        }

        // Initialize
        loadRegionsAndProviders();
        loadSettings();

        // Wait for regions and providers to load before creating modal
        setTimeout(() => {
            createSettingsModal();
        }, 2000);

        // Scan for pages periodically
        setInterval(() => {
            addStreamingLookup();
        }, 2000);

        // Initial scan
        setTimeout(addStreamingLookup, 1000);

        console.log('🪼 Jellyfin Enhanced: 🎬 Jellyfin Elsewhere loaded!');
    }
    function initializeJellyseerrScript() {
        // New check to ensure Jellyseerr is enabled and configured before proceeding
        if (!pluginConfig.JellyseerrEnabled) {
            console.log('🪼 Jellyfin Enhanced: 🔎 Jellyseerr integration is disabled in the plugin settings.');
            return;
        }
            (function () {
                'use strict';
                console.log('🪼 Jellyfin Enhanced: 🔎 Jellyseerr Loaded.');

                let lastProcessedQuery = null;
                let debounceTimeout = null;

                // 1. STYLES - Replace GM_addStyle with vanilla JS
                function addStyles() {
                    const styleId = 'jellyseerr-styles';
                    if (document.getElementById(styleId)) return; // Already added

                    const style = document.createElement('style');
                    style.id = styleId;
                    style.textContent = `
                        .jellyseerr-section {
                            margin-bottom: 2em;
                        }
                        .jellyseerr-card {
                            border-radius: 0.25em;
                            overflow: hidden;
                            display: flex;
                            flex-direction: column;
                            box-shadow: none !important;
                        }
                        .jellyseerr-request-button {
                            margin-top: 0.5em !important;
                            width: 100%;
                            display: flex;
                            justify-content: center;
                            align-items: center;
                        }
                        .jellyseerr-rating {
                            display: flex;
                            align-items: center;
                            gap: 0.3em;
                            color: #bdbdbd;
                        }
                        .jellyseerr-rating .material-icons {
                            font-size: 1.2em;
                            color: #ffc107;
                        }
                        .jellyseerr-icon {
                            width: 30px;
                            height: 50px;
                            filter: drop-shadow(0 0 3px rgba(0,0,0,.7));
                        }
                        .button-submit.jellyseerr-button-available {
                            background-color: #52b54b !important;
                            color: white !important;
                            opacity: 1 !important;
                        }
                        .button-submit.jellyseerr-button-pending {
                            background-color: #683ab797 !important; /* Blue for Pending/Processing */
                            color: white !important;
                            opacity: 1 !important;
                            display: flex;
                            align-items: center;
                            justify-content: center;
                        }
                        .button-submit.jellyseerr-button-requested {
                            background-color: #673ab7 !important; /* Purple for Requested */
                            color: white !important;
                            opacity: 1 !important;
                        }
                        .jellyseerr-meta {
                            display: flex;
                            justify-content: center;
                            align-items: center;
                            gap: 1.5em;
                            padding: 0 0.75em;
                        }
                        @keyframes jellyseerr-spin {
                            0% { transform: rotate(0deg); }
                            100% { transform: rotate(360deg); }
                        }
                        .jellyseerr-loading-spinner {
                            display: inline-block;
                            width: 20px;
                            height: 20px;
                            border: 3px solid rgba(255, 255, 255, 0.3);
                            border-radius: 50%;
                            border-top-color: #fff;
                            animation: jellyseerr-spin 1s ease-in-out infinite;
                            margin-left: 10px;
                            vertical-align: middle;
                        }
                        .jellyseerr-button-spinner {
                            width: 1.5vh;
                            height: 1.5vh;
                            border: 3px solid rgba(255, 255, 255, 0.3); /* The lighter circle part */
                            border-top-color: #fff; /* The solid part of the circle */
                            border-radius: 50%;
                            display: inline-block;
                            margin-left: 8px;
                            animation: jellyseerr-spin 1s linear infinite;
                        }
                    `;
                    document.head.appendChild(style);
                }

                // 2. MAIN OBSERVER
                function initializeObserver() {
                    const observer = new MutationObserver(() => {
                        const isSearchPage = window.location.hash.includes('/search.html');
                        const currentQuery = isSearchPage ? new URLSearchParams(window.location.hash.split('?')[1]).get('query') : null;

                        if (isSearchPage && currentQuery) {
                            clearTimeout(debounceTimeout);
                            debounceTimeout = setTimeout(() => {
                                const latestQuery = new URLSearchParams(window.location.hash.split('?')[1]).get('query');
                                if (latestQuery === lastProcessedQuery) return;

                                lastProcessedQuery = latestQuery;
                                console.log(`[JELLYSEERR] Debounced search for "${latestQuery}", initiating.`);

                                const oldSection = document.querySelector('.jellyseerr-section');
                                if (oldSection) {
                                    oldSection.remove();
                                }

                                runJellyseerrSearch(latestQuery);
                            }, 750);
                        } else if (!isSearchPage) {
                            lastProcessedQuery = null;
                            clearTimeout(debounceTimeout);
                        }
                    });

                    console.log('[JELLYSEERR] Starting observer on document.body.');
                    observer.observe(document.body, { childList: true, subtree: true });
                }

                // 3. TRIGGER FUNCTION
                function runJellyseerrSearch(query) {
                    let searchResultsContainer = document.querySelector('#searchPage .searchResults') ||
                                            document.querySelector('#searchPage [class*="searchResults"]') ||
                                            document.querySelector('#searchPage .padded-top.padded-bottom-page');

                    if (!searchResultsContainer && !document.querySelector('#searchPage')) {
                        console.error('[JELLYSEERR] Could not find or create a container to inject results into.');
                        lastProcessedQuery = null;
                        return;
                    }

                    console.log(`[JELLYSEERR] Fetching from Jellyseerr for query: "${query}".`);
                    fetchFromJellyseerr(query, searchResultsContainer);
                }

                // IMPROVED INJECTION LOGIC
                function intelligentlyInjectResults(sectionToInject, container) {
                    console.log('[JELLYSEERR] Waiting for Jellyfin results to stabilize...');
                    let lastMutationTime = Date.now();
                    let stabilityCheckInterval = null;
                    let maxWaitTime = 10000;
                    let startTime = Date.now();

                    const observer = new MutationObserver(() => {
                        lastMutationTime = Date.now();
                        console.log('[JELLYSEERR] Container mutation detected, resetting stability timer.');
                    });

                    const observeTarget = container || document.querySelector('#searchPage');
                    if (observeTarget) {
                        observer.observe(observeTarget, { childList: true, subtree: true });
                    }

                    stabilityCheckInterval = setInterval(() => {
                        const spinners = document.querySelectorAll('.mdlSpinnerActive, .loading, .spinner, [class*="loading"], [class*="spinner"]');
                        const activeSpinner = Array.from(spinners).find(el => el.offsetParent !== null);
                        const noResultsMessage = document.querySelector('#searchPage .noItemsMessage');
                        const timeSinceLastMutation = Date.now() - lastMutationTime;
                        const totalWaitTime = Date.now() - startTime;

                        console.log(`[JELLYSEERR] Stability check - Spinner: ${!!activeSpinner}, Time since mutation: ${timeSinceLastMutation}ms, Total wait: ${totalWaitTime}ms`);

                        if ((!activeSpinner && timeSinceLastMutation > 1000) || noResultsMessage || totalWaitTime > maxWaitTime) {
                            clearInterval(stabilityCheckInterval);
                            observer.disconnect();

                            if (noResultsMessage) {
                                console.log('[JELLYSEERR] Jellyfin returned no results. Injecting Jellyseerr section.');
                                const searchPage = document.querySelector('#searchPage');
                                if (searchPage) {
                                    searchPage.insertBefore(sectionToInject, noResultsMessage);
                                }
                                return;
                            }

                            if (totalWaitTime > maxWaitTime) {
                                console.log('[JELLYSEERR] Timeout reached, proceeding with injection.');
                            }

                            console.log('[JELLYSEERR] Jellyfin results have stabilized. Analyzing final layout...');

                            const searchPage = document.querySelector('#searchPage');
                            if (!searchPage) {
                                console.error('[JELLYSEERR] Could not find search page for injection.');
                                return;
                            }

                            const allSections = Array.from(searchPage.querySelectorAll('.verticalSection:not(.jellyseerr-section)'));
                            console.log(`[JELLYSEERR] Found ${allSections.length} existing sections`);

                            const finalSections = allSections.map(el => ({
                                element: el,
                                title: el.querySelector('.sectionTitle, h2')?.textContent.trim() || ''
                            }));

                            finalSections.forEach(section => {
                                console.log(`[JELLYSEERR] Found section: "${section.title}"`);
                            });

                            if (finalSections.length === 0) {
                                console.log('[JELLYSEERR] No Jellyfin sections found after stabilization. Using fallback.');
                                let injectionPoint = searchPage.querySelector('.searchResults, [class*="searchResults"], .padded-top.padded-bottom-page');
                                if (!injectionPoint) {
                                    injectionPoint = document.createElement('div');
                                    injectionPoint.className = 'searchResults padded-top padded-bottom-page';
                                    searchPage.appendChild(injectionPoint);
                                }
                                injectionPoint.appendChild(sectionToInject);
                                return;
                            }

                            const peopleSection = finalSections.find(s => s.title.toLowerCase().includes('people'));
                            const episodesSection = finalSections.find(s => s.title.toLowerCase().includes('episodes'));
                            const showsSection = finalSections.find(s => s.title.toLowerCase().includes('shows') || s.title.toLowerCase().includes('series'));
                            const moviesSection = finalSections.find(s => s.title.toLowerCase().includes('movies') || s.title.toLowerCase().includes('films'));

                            if (peopleSection) {
                                console.log('[JELLYSEERR] Injecting before People section.');
                                peopleSection.element.parentElement.insertBefore(sectionToInject, peopleSection.element);
                            } else if (episodesSection) {
                                console.log('[JELLYSEERR] Injecting after Episodes section.');
                                const nextSibling = episodesSection.element.nextElementSibling;
                                if (nextSibling) {
                                    episodesSection.element.parentElement.insertBefore(sectionToInject, nextSibling);
                                } else {
                                    episodesSection.element.parentElement.appendChild(sectionToInject);
                                }
                            } else if (showsSection) {
                                console.log('[JELLYSEERR] Injecting after Shows section.');
                                const nextSibling = showsSection.element.nextElementSibling;
                                if (nextSibling) {
                                    showsSection.element.parentElement.insertBefore(sectionToInject, nextSibling);
                                } else {
                                    showsSection.element.parentElement.appendChild(sectionToInject);
                                }
                            } else if (moviesSection) {
                                console.log('[JELLYSEERR] Injecting after Movies section.');
                                const nextSibling = moviesSection.element.nextElementSibling;
                                if (nextSibling) {
                                    moviesSection.element.parentElement.insertBefore(sectionToInject, nextSibling);
                                } else {
                                    moviesSection.element.parentElement.appendChild(sectionToInject);
                                }
                            } else {
                                console.log('[JELLYSEERR] Fallback: Appending to the search results container.');
                                let fallbackContainer = searchPage.querySelector('.searchResults, [class*="searchResults"], .padded-top.padded-bottom-page');
                                if (!fallbackContainer) {
                                    fallbackContainer = document.createElement('div');
                                    fallbackContainer.className = 'searchResults padded-top padded-bottom-page';
                                    searchPage.appendChild(fallbackContainer);
                                }
                                fallbackContainer.appendChild(sectionToInject);
                            }
                        }
                    }, 200);
                }

                // 4. API - Fetch search results
                async function fetchFromJellyseerr(query, container) {
                    const requestUrl = `${ApiClient.serverAddress()}/JellyfinEnhanced/jellyseerr/search?query=${encodeURIComponent(query)}`;
                    console.log(`[JELLYSEERR] Making GET request to proxy: ${requestUrl}`);

                    const placeholder = createJellyseerrSection(true);
                    if (container) {
                        container.appendChild(placeholder);
                    } else {
                        const searchPage = document.querySelector('#searchPage');
                        if (searchPage) {
                            searchPage.appendChild(placeholder);
                        } else {
                            console.error('[JELLYSEERR] Could not find a container to inject placeholder into.');
                            return;
                        }
                    }

                    try {
                        const data = await ApiClient.ajax({
                            type: 'GET',
                            url: requestUrl,
                            dataType: 'json'
                        });

                        placeholder.remove();
                        if (data.results && data.results.length > 0) {
                            console.log(`[JELLYSEERR] Received ${data.results.length} results from proxy.`);
                            const jellyseerrSection = createJellyseerrSection(false, data.results);
                            const noResultsMessage = document.querySelector('#searchPage .noItemsMessage');
                            if (noResultsMessage) {
                                noResultsMessage.style.display = 'none';
                            }
                            intelligentlyInjectResults(jellyseerrSection, container);
                        } else {
                            console.log('[JELLYSEERR] Jellyseerr (via proxy) returned no results.');
                        }
                    } catch (error) {
                        placeholder.remove();
                        console.error('[JELLYSEERR] Error fetching from proxy:', error);
                    }
                }

                // 5. UI - Create the entire Jellyseerr section
                function createJellyseerrSection(isLoading, results = []) {
                    const section = document.createElement('div');
                    section.className = 'verticalSection emby-scroller-container jellyseerr-section';

                    const title = document.createElement('h2');
                    title.className = 'sectionTitle sectionTitle-cards focuscontainer-x padded-left padded-right';
                    title.textContent = 'Discover on Jellyseerr';

                    if (isLoading) {
                        const spinner = document.createElement('div');
                        spinner.className = 'jellyseerr-loading-spinner';
                        title.appendChild(spinner);
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
                    itemsContainer.style.whiteSpace = 'nowrap';

                    if (!isLoading) {
                        results.forEach(item => {
                            const card = createJellyseerrCard(item);
                            itemsContainer.appendChild(card);
                        });
                    }

                    scrollerContainer.appendChild(itemsContainer);
                    section.appendChild(scrollerContainer);
                    return section;
                }

                // 6. UI - Create a single result card
                function createJellyseerrCard(item) {
                    const year = item.releaseDate ? item.releaseDate.substring(0, 4) : (item.firstAirDate ? item.firstAirDate.substring(0, 4) : 'N/A');
                    const posterUrl = item.posterPath ? `https://image.tmdb.org/t/p/w400${item.posterPath}` : '';
                    const rating = item.voteAverage ? item.voteAverage.toFixed(1) : 'N/A';
                    const titleText = item.title || item.name;
                    const tmdbUrl = `https://www.themoviedb.org/${item.mediaType}/${item.id}`;

                    const card = document.createElement('div');
                    card.className = 'card overflowPortraitCard card-hoverable jellyseerr-card';

                    card.innerHTML = `
                        <div class="cardBox cardBox-bottompadded">
                            <div class="cardScalable">
                                <div class="cardPadder cardPadder-overflowPortrait"></div>
                                <div class="cardImageContainer coveredImage cardContent" style="background-image: url('${posterUrl}');">
                                    <div class="cardIndicators">
                                        <div class="indicator">
                                            <img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/jellyseerr.svg" class="jellyseerr-icon" alt="From Jellyseerr"/>
                                        </div>
                                    </div>
                                </div>
                            </div>
                            <div class="cardText cardTextCentered cardText-first">
                                <a href="${tmdbUrl}" target="_blank" style="color: inherit; text-decoration: none;" title="View on TMDB">
                                    <bdi>${titleText}</bdi>
                                </a>
                            </div>
                            <div class="cardText cardText-secondary jellyseerr-meta">
                                <bdi>${year}</bdi>
                                <div class="jellyseerr-rating">
                                    <span class="material-icons">star</span>
                                    <span>${rating}</span>
                                </div>
                            </div>
                            <div class="cardFooter" style="padding: 0.5em 1em 1em;">
                                <button is="emby-button" type="button" class="jellyseerr-request-button emby-button" data-tmdb-id="${item.id}" data-media-type="${item.mediaType}"></button>
                            </div>
                        </div>
                    `;

                    const button = card.querySelector('.jellyseerr-request-button');
                    const status = item.mediaInfo ? item.mediaInfo.status : 1;

                    switch (status) {
                        case 2: // PENDING_APPROVAL
                        case 3: // PROCESSING
                            button.textContent = status === 2 ? 'Pending' : 'Processing';
                            button.disabled = true;
                            button.classList.add('button-submit');
                            button.classList.add('jellyseerr-button-pending');
                            button.innerHTML += '<span class="jellyseerr-button-spinner"></span>';
                            break;
                        case 4: // PARTIALLY_AVAILABLE
                        case 5: // AVAILABLE
                            button.textContent = 'Available';
                            button.disabled = true;
                            button.classList.add('jellyseerr-button-available');
                            button.classList.add('button-submit');
                            break;
                        default: // UNKNOWN or other statuses
                            button.textContent = 'Request';
                            button.disabled = false;
                            button.classList.add('button-submit');
                            button.classList.add('jellyseerr-button-requested');
                            break;
                    }

                    return card;
                }

                // 7. ACTION - Handle request button clicks
                document.body.addEventListener('click', function(event) {
                    const button = event.target.closest('.jellyseerr-request-button');
                    if (button && !button.disabled) {
                        const mediaType = button.dataset.mediaType;
                        const tmdbId = button.dataset.tmdbId;
                        requestMedia(tmdbId, mediaType, button);
                    }
                });

                // 8. API - Send the request to Jellyseerr
                async function requestMedia(tmdbId, mediaType, button) {
                    const jellyfinUserId = ApiClient.getCurrentUserId();
                    if (!jellyfinUserId) {
                        console.error('[JELLYSEERR] Could not get Jellyfin user ID. Aborting request.');
                        button.textContent = 'Login Error';
                        return;
                    }


                    button.disabled = true;
                    button.textContent = 'Requesting...';
                    button.classList.add('jellyseerr-button-requested');
                    button.classList.add('button-submit');

                    let requestBody = {
                        mediaType: mediaType,
                        mediaId: parseInt(tmdbId),
                        jellyfinUserId: jellyfinUserId
                    };
                    if (mediaType === 'tv') { requestBody.seasons = "all"; }

                    const requestUrl = `${ApiClient.serverAddress()}/JellyfinEnhanced/jellyseerr/request`;
                    console.log(`[JELLYSEERR] Making POST request to proxy: ${requestUrl}`);

                    try {
                        await ApiClient.ajax({
                            type: 'POST',
                            url: requestUrl,
                            data: JSON.stringify(requestBody),
                            contentType: 'application/json'
                        });

                        button.textContent = 'Requested ✔';
                        button.classList.add('jellyseerr-button-requested');
                        button.classList.remove('button-submit');

                    } catch (error) {
                        button.disabled = false; // Re-enable on error
                        console.error('[JELLYSEERR] Request Failed via proxy:', error);

                        // Attempt to parse a more specific error message from Jellyseerr
                        try {
                            const errorMessage = (error.xhr && error.xhr.responseText) ? error.xhr.responseText : "Error";
                            button.textContent = errorMessage.includes("already been requested") ? 'Already Requested' : 'Error';
                        } catch (e) {
                            button.textContent = 'Request Failed';
                        }

                        button.classList.remove('button-submit');
                    }
                }
                addStyles();
                initializeObserver();
            })();
    }
    // Initialize the script
    waitForApiClientAndLoadConfig();

})();