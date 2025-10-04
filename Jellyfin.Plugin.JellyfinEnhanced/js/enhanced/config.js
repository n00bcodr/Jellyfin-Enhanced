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
     * Performs a one-time migration of settings from localStorage to the server,
     * preventing race conditions from multiple devices.
     */
    async function migrateLocalStorageToServer() {
        // This flag ensures the migration logic only runs once per device.
        if (localStorage.getItem('jellyfinEnhancedMigrated_v2')) {
            return;
        }

        console.log('🪼 Jellyfin Enhanced: Checking if migration is needed...');

        // 1. Check if settings already exist on the server.
        let serverSettings;
        try {
            serverSettings = await ApiClient.ajax({
                type: 'GET',
                url: ApiClient.getUrl('/JellyfinEnhanced/preferences'),
                headers: { 'X-Jellyfin-User-Id': ApiClient.getCurrentUserId() },
                dataType: 'json'
            });
        } catch (e) {
            console.error("🪼 Jellyfin Enhanced: Could not contact server for migration check. Aborting migration.", e);
            return; // Can't proceed without server confirmation.
        }

        // 2. If settings exist on the server, another device has already migrated.
        if (serverSettings && serverSettings.jellyfinUserId) {
            console.log('🪼 Jellyfin Enhanced: Server already has settings. Migration not needed on this device.');
            // Clean up this device's local storage and mark as migrated.
            localStorage.removeItem('jellyfinEnhancedSettings');
            localStorage.removeItem('jellyfinEnhancedUserShortcuts');
            localStorage.removeItem('jellyfinEnhancedBookmarks');
            localStorage.setItem('jellyfinEnhancedMigrated_v2', 'true');
            return;
        }

        // 3. If no server settings exist, this is the first device. Proceed with migration.
        console.log('🪼 Jellyfin Enhanced: No server settings found. Starting migration of local settings...');

        const oldSettings = JSON.parse(localStorage.getItem('jellyfinEnhancedSettings') || '{}');
        const oldShortcuts = JSON.parse(localStorage.getItem('jellyfinEnhancedUserShortcuts') || '{}');
        const oldBookmarks = JSON.parse(localStorage.getItem('jellyfinEnhancedBookmarks') || '{}');

        // If there's nothing to migrate, just mark as done.
        if (Object.keys(oldSettings).length === 0 && Object.keys(oldShortcuts).length === 0 && Object.keys(oldBookmarks).length === 0) {
            localStorage.setItem('jellyfinEnhancedMigrated_v2', 'true');
            console.log('🪼 Jellyfin Enhanced: No local settings found to migrate.');
            return;
        }

        const migratedSettings = {
            ...oldSettings,
            userShortcuts: oldShortcuts,
            bookmarks: oldBookmarks
        };

        try {
            await JE.saveSettings(migratedSettings);
            console.log('🪼 Jellyfin Enhanced: Successfully migrated settings to the server.');

            // Clean up old localStorage items after successful migration.
            localStorage.removeItem('jellyfinEnhancedSettings');
            localStorage.removeItem('jellyfinEnhancedUserShortcuts');
            localStorage.removeItem('jellyfinEnhancedBookmarks');
            localStorage.setItem('jellyfinEnhancedMigrated_v2', 'true');
        } catch (error) {
            console.error('🪼 Jellyfin Enhanced: Migration upload failed. Settings will remain local for this session.', error);
        }
    }


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
     * Loads settings from the server, migrating from localStorage if necessary.
     * @returns {Promise<object>} The loaded or default settings.
     */
    JE.loadSettings = async () => {
        await migrateLocalStorageToServer();

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
