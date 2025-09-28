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
     * Manages loading and saving of user-defined shortcuts from localStorage.
     */
    JE.userShortcutManager = {
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
     * Saves the provided settings object to localStorage.
     * @param {object} settings The settings object to save.
     */
    JE.saveSettings = (settings) => {
        try {
            localStorage.setItem('jellyfinEnhancedSettings', JSON.stringify(settings));
        } catch (e) {
            console.error('🪼 Jellyfin Enhanced: Failed to save settings:', e);
        }
    };

    /**
     * Loads settings from localStorage, falling back to plugin defaults if not found.
     * @returns {object} The loaded or default settings.
     */
    JE.loadSettings = () => {
        try {
            const settings = JSON.parse(localStorage.getItem('jellyfinEnhancedSettings'));
            // Return saved settings or a default configuration.
            return settings || {
                autoPauseEnabled: pluginConfig.AutoPauseEnabled,
                autoResumeEnabled: pluginConfig.AutoResumeEnabled,
                autoPipEnabled: pluginConfig.AutoPipEnabled,
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
                pauseScreenEnabled: pluginConfig.PauseScreenEnabled,
                qualityTagsEnabled: pluginConfig.QualityTagsEnabled,
                genreTagsEnabled: pluginConfig.GenreTagsEnabled,
                disableAllShortcuts: pluginConfig.DisableAllShortcuts,
                lastOpenedTab: 'shortcuts'
            };
        } catch (e) {
            console.error('🪼 Jellyfin Enhanced: Error loading settings:', e);
            // Fallback to default settings on error.
            return {
                autoPauseEnabled: true,
                autoResumeEnabled: false,
                autoPipEnabled: false,
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
                pauseScreenEnabled: true,
                qualityTagsEnabled: false,
                genreTagsEnabled: false,
                disableAllShortcuts: false,
                lastOpenedTab: 'shortcuts'
            };
        }
    };

    // --- Initial Load ---
    // Load initial settings and shortcuts into the global JE object upon script execution.
    JE.currentSettings = JE.loadSettings();
    JE.initializeShortcuts();

})(window.JellyfinEnhanced);