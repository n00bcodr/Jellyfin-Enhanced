/**
 * @file Manages plugin configuration, user settings, and shared state.
 */
(function(JE) {
    'use strict';

    // Expose the main plugin configuration loaded by plugin.js
    const pluginConfig = JE.pluginConfig;

    /**
     * Constants derived from the plugin configuration.
     * @type {object}
     */
    JE.CONFIG = {
        TOAST_DURATION: pluginConfig.ToastDuration,
        HELP_PANEL_AUTOCLOSE_DELAY: pluginConfig.HelpPanelAutocloseDelay,
    };

    /**
     * Shared state variables used across different components.
     * @type {object}
     */
    JE.state = {
        activeShortcuts: {},
        currentContextItemId: null,
        isContinueWatchingContext: false,
        skipToastShown: false
    };

    /**
     * Manages loading and saving of user-defined shortcuts from the main settings object.
     */
    JE.userShortcutManager = {
        load: function() {
            return JE.currentSettings.userShortcuts || {};
        },
        save: function(shortcuts) {
            JE.currentSettings.userShortcuts = shortcuts;
            JE.saveSettings(JE.currentSettings);
        }
    };

    /**
     * Merges the default shortcuts from the server with any user-overridden shortcuts.
     * The result is stored in JE.state.activeShortcuts.
     */
    JE.initializeShortcuts = function() {
        const defaultShortcuts = (pluginConfig.Shortcuts || []).reduce((acc, s) => {
            acc[s.Name] = s.Key;
            return acc;
        }, {});
        const userShortcuts = JE.userShortcutManager.load();
        // User shortcuts override the defaults/admin settings
        JE.state.activeShortcuts = { ...defaultShortcuts, ...userShortcuts };
    };

    /**
     * Saves the provided settings object to the server via the API.
     * @param {object} settings The settings object to save.
     */
    JE.saveSettings = async (settings) => {
        try {
            await ApiClient.ajax({
                type: 'POST',
                url: ApiClient.getUrl('/JellyfinEnhanced/preferences'),
                data: JSON.stringify(settings),
                contentType: 'application/json',
                headers: { 'X-Jellyfin-User-Id': ApiClient.getCurrentUserId() }
            });
        } catch (e) {
            console.error('🪼 Jellyfin Enhanced: Failed to save settings:', e);
        }
    };

    /**
     * Loads settings from the server.
     * @returns {Promise<object>} The loaded or default settings.
     */
    JE.loadSettings = async () => {
        try {
            const settings = await ApiClient.ajax({
                type: 'GET',
                url: ApiClient.getUrl('/JellyfinEnhanced/preferences'),
                headers: { 'X-Jellyfin-User-Id': ApiClient.getCurrentUserId() },
                dataType: 'json'
            });

            // If user has no saved settings, return defaults
            if (!settings.jellyfinUserId) {
                return {
                    autoPauseEnabled: pluginConfig.AutoPauseEnabled,
                    autoResumeEnabled: pluginConfig.AutoResumeEnabled,
                    autoPipEnabled: pluginConfig.AutoPipEnabled,
                    autoSkipIntro: pluginConfig.AutoSkipIntro,
                    autoSkipOutro: pluginConfig.AutoSkipOutro,
                    selectedStylePresetIndex: pluginConfig.DefaultSubtitleStyle,
                    selectedFontSizePresetIndex: pluginConfig.DefaultSubtitleSize,
                    selectedFontFamilyPresetIndex: pluginConfig.DefaultSubtitleFont,
                    disableCustomSubtitleStyles: pluginConfig.DisableCustomSubtitleStyles,
                    randomButtonEnabled: pluginConfig.RandomButtonEnabled,
                    randomIncludeMovies: pluginConfig.RandomIncludeMovies,
                    randomIncludeShows: pluginConfig.RandomIncludeShows,
                    randomUnwatchedOnly: pluginConfig.RandomUnwatchedOnly,
                    showFileSizes: pluginConfig.ShowFileSizes,
                    showAudioLanguages: pluginConfig.ShowAudioLanguages,
                    removeContinueWatchingEnabled: pluginConfig.RemoveContinueWatchingEnabled,
                    pauseScreenEnabled: pluginConfig.PauseScreenEnabled,
                    qualityTagsEnabled: pluginConfig.QualityTagsEnabled,
                    genreTagsEnabled: pluginConfig.GenreTagsEnabled,
                    disableAllShortcuts: pluginConfig.DisableAllShortcuts,
                    lastOpenedTab: 'shortcuts',
                    userShortcuts: {},
                    bookmarks: {}
                };
            }
            return settings;
        } catch (e) {
            console.error('🪼 Jellyfin Enhanced: Error loading settings from server:', e);
            // Fallback to default settings on error
            return {
                autoPauseEnabled: true,
                autoResumeEnabled: false,
                autoPipEnabled: false,
                autoSkipIntro: false,
                autoSkipOutro: false,
                selectedStylePresetIndex: 0,
                selectedFontSizePresetIndex: 2,
                selectedFontFamilyPresetIndex: 0,
                disableCustomSubtitleStyles: false,
                randomButtonEnabled: true,
                randomIncludeMovies: true,
                randomIncludeShows: true,
                randomUnwatchedOnly: false,
                showFileSizes: false,
                removeContinueWatchingEnabled: false,
                pauseScreenEnabled: true,
                qualityTagsEnabled: false,
                genreTagsEnabled: false,
                disableAllShortcuts: false,
                lastOpenedTab: 'shortcuts',
                userShortcuts: {},
                bookmarks: {}
            };
        }
    };

})(window.JellyfinEnhanced);