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
        // { itemId, surface: 'continuewatching'|'nextup'|null, ts } captured on a menu trigger.
        removeContext: null,
        pauseScreenClickTimer: null
    };

    /**
     * Saves user settings to the server.
     * Skips the POST if the data is identical to the last value saved this session
     * (prevents redundant writes). The first save per session for a given file is
     * always allowed through since the cache starts empty.
     */
    // Per-file cache of the last JSON string successfully sent to the server.
    const _lastSavedJson = {};

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

            // Convert data back to PascalCase for server C# deserialization
            let dataToSave = settings;
            if ((fileName === 'bookmark.json' || fileName === 'settings.json') && typeof window.JellyfinEnhanced?.toPascalCase === 'function') {
                dataToSave = window.JellyfinEnhanced.toPascalCase(settings);
            }

            const serialized = JSON.stringify(dataToSave);
            const cacheKey = `${userId}:${fileName}`;

            // Skip the POST if nothing has changed since the last save this session.
            if (_lastSavedJson[cacheKey] === serialized) {
                return; // no-op — identical to last save
            }

            await ApiClient.ajax({
                type: 'POST',
                url: ApiClient.getUrl(`/JellyfinEnhanced/user-settings/${userId}/${fileName}`),
                data: serialized,
                contentType: 'application/json'
            });

            // Update the cache on success so subsequent identical saves are skipped
            _lastSavedJson[cacheKey] = serialized;
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
            customSubtitleTextColor: '#FFFFFFFF', customSubtitleBgColor: '#00000000',
            usingCustomColors: false,
            disableCustomSubtitleStyles: false,
            subtitleVerticalPosition: 95, subtitleHorizontalPosition: 50,
            randomButtonEnabled: true,
            randomIncludeMovies: true, randomIncludeShows: true, randomUnwatchedOnly: false,
            showWatchProgress: false, showFileSizes: false, showAudioLanguages: true, removeContinueWatchingEnabled: false,
            watchProgressMode: 'percentage',
            watchProgressTimeFormat: 'hours',
            pauseScreenEnabled: true,
            pauseScreenDelaySeconds: 5,
            qualityTagsEnabled: false, genreTagsEnabled: false, languageTagsEnabled: false, ratingTagsEnabled: false, peopleTagsEnabled: false, tagsHideOnHover: false,
            showResolutionTag: true, showSourceTag: true, showDynamicRangeTag: true, showSpecialFormatTag: true, showVideoCodecTag: true, showAudioInfoTag: true,
            resolutionTagOrder: 1, sourceTagOrder: 2, dynamicRangeTagOrder: 3, specialFormatTagOrder: 4, videoCodecTagOrder: 5, audioInfoTagOrder: 6,
            qualityTagsPosition: 'top-left', genreTagsPosition: 'top-right', languageTagsPosition: 'bottom-left', ratingTagsPosition: 'bottom-right',
            showRatingInPlayer: true,
            reviewsExpandedByDefault: false,
            displayLanguage: '',
            calendarDisplayMode: 'list',
            calendarDefaultViewMode: 'agenda',
            disableAllShortcuts: false, longPress2xEnabled: false, lastOpenedTab: 'shortcuts'
        };

        // Aliases mapping camelCase client settings keys to potential server plugin default keys
        const pluginDefaultAliases = {
            selectedStylePresetIndex: ['DefaultSubtitleStyle', 'SelectedStylePresetIndex'],
            selectedFontSizePresetIndex: ['DefaultSubtitleSize', 'SelectedFontSizePresetIndex'],
            selectedFontFamilyPresetIndex: ['DefaultSubtitleFont', 'SelectedFontFamilyPresetIndex'],
            displayLanguage: ['DefaultLanguage', 'DisplayLanguage'],
            watchProgressMode: ['WatchProgressDefaultMode', 'WatchProgressMode'],
            watchProgressTimeFormat: ['WatchProgressTimeFormat'],
            pauseScreenDelaySeconds: ['PauseScreenDelaySeconds']
        };

        /**
         * Resolves a default value from pluginDefaults for a given camelCase key.
         */
        const getPluginDefault = (key) => {
            const aliases = pluginDefaultAliases[key] || [];
            const candidates = [
                key,
                key.charAt(0).toUpperCase() + key.slice(1),
                ...aliases
            ];

            for (const candidate of candidates) {
                const value = pluginDefaults[candidate];
                if (value !== null && value !== undefined) {
                    return value;
                }
            }

            return undefined;
        };

        const mergedSettings = {};
        // Seed with all keys from the stored user settings so that any field not
        // listed in hardcodedDefaults (e.g. fields added in newer plugin versions,
        // or fields the frontend doesn't actively manage) is preserved as-is and
        // not silently dropped when currentSettings is written back to the server.
        for (const key in userSettings) {
            mergedSettings[key] = userSettings[key];
        }
        for (const key in hardcodedDefaults) {
            if (Object.prototype.hasOwnProperty.call(userSettings, key) && userSettings[key] !== null && userSettings[key] !== undefined) {
                // Detect corrupted values (empty arrays or unexpected objects)
                if (typeof userSettings[key] === 'object' && Array.isArray(userSettings[key]) && userSettings[key].length === 0) {
                    const fallback = getPluginDefault(key);
                    mergedSettings[key] = fallback !== undefined ? fallback : hardcodedDefaults[key];
                } else if (typeof userSettings[key] === 'object' && userSettings[key] !== null && !Array.isArray(userSettings[key])) {
                    const fallback = getPluginDefault(key);
                    mergedSettings[key] = fallback !== undefined ? fallback : hardcodedDefaults[key];
                } else {
                    mergedSettings[key] = userSettings[key];
                }
            } else {
                const pluginVal = getPluginDefault(key);
                if (pluginVal !== undefined) {
                    mergedSettings[key] = pluginVal;
                } else {
                    mergedSettings[key] = hardcodedDefaults[key];
                }
            }
        }

        mergedSettings.displayLanguage = Object.prototype.hasOwnProperty.call(userSettings, 'displayLanguage')
            && userSettings.displayLanguage !== null && userSettings.displayLanguage !== undefined
            ? userSettings.displayLanguage
            : (getPluginDefault('displayLanguage') || '');
        mergedSettings.lastOpenedTab = userSettings.lastOpenedTab || 'shortcuts';

        // Admin default → per-user default (handled by getPluginDefault above; preserved for backwards compatibility)
        if (!Object.prototype.hasOwnProperty.call(userSettings, 'removeContinueWatchingEnabled')
            && pluginDefaults.RemoveContinueWatchingEnabled === true) {
            mergedSettings.removeContinueWatchingEnabled = true;
        }

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
