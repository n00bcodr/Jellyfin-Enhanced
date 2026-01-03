// /js/enhanced/config.js
/**
 * @file Manages plugin configuration, user settings, and shared state.
 */
(function(JE) {
    'use strict';

    /**
     * Constants derived from the plugin configuration.
     * @type {object}
     */
    JE.CONFIG = {
        // Use getters so values always reflect the latest pluginConfig even if assigned later
        get TOAST_DURATION() { return (JE.pluginConfig && JE.pluginConfig.ToastDuration) || 1500; },
        get HELP_PANEL_AUTOCLOSE_DELAY() { return (JE.pluginConfig && JE.pluginConfig.HelpPanelAutocloseDelay) || 15000; }
    };

    /**
     * Shared state variables used across different components.
     * @type {object}
     */
    JE.state = JE.state || {
        activeShortcuts: {},
        currentContextItemId: null,
        isContinueWatchingContext: false,
        skipToastShown: false,
        pauseScreenClickTimer: null
    };

    /**
     * Saves user settings to the server.
     */
    JE.saveUserSettings = async (fileName, settings) => {
        if (typeof ApiClient === 'undefined' || !ApiClient.getCurrentUserId) {
            console.error("🪼 Jellyfin Enhanced: ApiClient not available");
            return;
        }
        try {
            const userId = ApiClient.getCurrentUserId();
            if (!userId) {
                console.error("🪼 Jellyfin Enhanced: User ID not available");
                return;
            }

            // Convert bookmark data back to PascalCase for server
            let dataToSave = settings;
            if (fileName === 'bookmark.json' && typeof window.JellyfinEnhanced?.toPascalCase === 'function') {
                dataToSave = window.JellyfinEnhanced.toPascalCase(settings);
            }

            await ApiClient.ajax({
                type: 'POST',
                url: ApiClient.getUrl(`/JellyfinEnhanced/user-settings/${userId}/${fileName}`),
                data: JSON.stringify(dataToSave),
                contentType: 'application/json'
            });
        } catch (e) {
            console.error(`🪼 Jellyfin Enhanced: Failed to save ${fileName}:`, e);
        }
    };

    /**
     * Loads and merges settings from user config, plugin defaults, and hardcoded fallbacks.
     */
    JE.loadSettings = () => {
        const userSettings = JE.userConfig?.settings || {};
        const pluginDefaults = JE.pluginConfig || {};

        const hardcodedDefaults = {
            autoPauseEnabled: true, autoResumeEnabled: false, autoPipEnabled: false,
            autoSkipIntro: false, autoSkipOutro: false,
            selectedStylePresetIndex: 0, selectedFontSizePresetIndex: 2, selectedFontFamilyPresetIndex: 0,
            disableCustomSubtitleStyles: false, randomButtonEnabled: true,
            randomIncludeMovies: true, randomIncludeShows: true, randomUnwatchedOnly: false,
            showWatchProgress: false, showFileSizes: false, showAudioLanguages: true, removeContinueWatchingEnabled: false,
            pauseScreenEnabled: true,
            qualityTagsEnabled: false, genreTagsEnabled: false, languageTagsEnabled: false, ratingTagsEnabled: false,
            qualityTagsPosition: 'top-left', genreTagsPosition: 'top-right', languageTagsPosition: 'bottom-left', ratingTagsPosition: 'bottom-right',
            showRatingInPlayer: true,
            reviewsExpandedByDefault: false,
            disableAllShortcuts: false, longPress2xEnabled: false, lastOpenedTab: 'shortcuts'
        };

        const mergedSettings = {};
        for (const key in hardcodedDefaults) {
            if (userSettings.hasOwnProperty(key) && userSettings[key] !== null && userSettings[key] !== undefined) {
                // Detect corrupted values (empty arrays or unexpected objects)
                if (typeof userSettings[key] === 'object' && Array.isArray(userSettings[key]) && userSettings[key].length === 0) {
                    mergedSettings[key] = pluginDefaults[key] ?? hardcodedDefaults[key];
                } else if (typeof userSettings[key] === 'object' && userSettings[key] !== null && !Array.isArray(userSettings[key])) {
                    mergedSettings[key] = pluginDefaults[key] ?? hardcodedDefaults[key];
                } else {
                    mergedSettings[key] = userSettings[key];
                }
            } else if (pluginDefaults.hasOwnProperty(key) && pluginDefaults[key] !== null && pluginDefaults[key] !== undefined) {
                mergedSettings[key] = pluginDefaults[key];
            } else {
                mergedSettings[key] = hardcodedDefaults[key];
            }
        }

        mergedSettings.lastOpenedTab = userSettings.lastOpenedTab || 'shortcuts';
        return mergedSettings;
    };

    /**
     * Initializes keyboard shortcut mappings from plugin and user configurations.
     */
    JE.initializeShortcuts = function() {
        const pluginDefaults = JE.pluginConfig || {};
        const userShortcutsConfig = JE.userConfig?.shortcuts || {};

        const defaultShortcuts = Array.isArray(pluginDefaults.Shortcuts)
            ? pluginDefaults.Shortcuts.reduce((acc, s) => {
                if (s && s.Name && s.Key !== undefined) acc[s.Name] = s.Key;
                return acc;
              }, {})
            : {};

        const userShortcuts = Array.isArray(userShortcutsConfig.Shortcuts)
            ? userShortcutsConfig.Shortcuts.reduce((acc, s) => {
                if (s && s.Name && s.Key !== undefined) acc[s.Name] = s.Key;
                return acc;
              }, {})
            : {};

        JE.state.activeShortcuts = JE.state.activeShortcuts || {};
        Object.assign(JE.state.activeShortcuts, defaultShortcuts, userShortcuts);
    };

})(window.JellyfinEnhanced);