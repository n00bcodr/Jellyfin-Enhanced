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

    // Per-file cache of the last JSON string successfully sent to the server.
    const _lastSavedJson = {};
    // Per-file chain of in-flight saves. Every control posts the whole object,
    // so two quick changes must reach the server in call order or the earlier
    // (smaller) snapshot can land last and drop the newer change.
    const _saveChain = {};
    // Whether the "settings could not be loaded" warning was already logged this page load.
    let _warnedSettingsUnavailable = false;
    // When the last "couldn't save" toast was shown; a burst of failed saves shows one.
    let _lastSaveFailedToastAt = 0;
    const SAVE_FAILED_TOAST_INTERVAL_MS = 3000;
    // English text for a locale file that does not have the key yet (JE.t returns the key on a miss).
    const SAVE_FAILED_FALLBACK = "Couldn't save your settings. Check your connection, then try again.";

    /**
     * Shows the translated "couldn't save" message, at most once per SAVE_FAILED_TOAST_INTERVAL_MS:
     * inside the settings panel while it is open (a toast would sit under it), else as a toast.
     */
    function toastSaveFailed() {
        const now = Date.now();
        if (now - _lastSaveFailedToastAt < SAVE_FAILED_TOAST_INTERVAL_MS) return;
        _lastSaveFailedToastAt = now;
        const translated = typeof JE.t === 'function' ? JE.t('toast_settings_save_failed') : '';
        const message = translated && translated !== 'toast_settings_save_failed' ? translated : SAVE_FAILED_FALLBACK;
        if (JE.internals?.enhancedUi?.showPanelSaveError?.(message)) return;
        if (typeof JE.toast === 'function') JE.toast(message);
    }

    /**
     * Saves user settings to the server.
     * Skips the POST if the data is identical to the last value saved this session
     * (prevents redundant writes). The first save per session for a given file is
     * always allowed through since the cache starts empty.
     * Never saves settings.json while the stored document failed to load
     * (JE.userConfig.settingsStatus 'unavailable') or is still loading after a
     * user switch ('loading'): the in-memory values are then fallback defaults
     * and would overwrite the user's real preferences.
     * Failures are logged and swallowed unless the caller opts in to them.
     * @param {string} fileName Per-user settings file, e.g. 'settings.json'.
     * @param {object} settings The whole document to save.
     * @param {{throwOnError?: boolean, notifyOnError?: boolean}} [options] throwOnError: reject
     *   (without logging) when nothing was saved, so a caller can roll back its own optimistic
     *   change. notifyOnError: when the server request fails, also show a "couldn't save" toast
     *   (the control is not reverted; the next refresh shows the stored value). Refusals while
     *   the settings are loading or unavailable are not toasted: the panel shows those itself.
     * @returns {Promise<void>}
     */
    JE.saveUserSettings = async (fileName, settings, options = {}) => {
        const throwOnError = options?.throwOnError === true;
        const notifyOnError = options?.notifyOnError === true;
        if (fileName === 'settings.json' && JE.userConfig?.settingsStatus === 'loading') {
            if (throwOnError) throw new Error('Settings are still loading; not saving');
            return;
        }
        if (fileName === 'settings.json' && JE.userConfig?.settingsStatus === 'unavailable') {
            if (throwOnError) throw new Error('Settings could not be loaded; not saving');
            if (!_warnedSettingsUnavailable) {
                _warnedSettingsUnavailable = true;
                console.warn('🪼 Jellyfin Enhanced: Your settings could not be loaded, so changes are not saved until they load.');
            }
            return;
        }
        if (typeof ApiClient === 'undefined' || !ApiClient.getCurrentUserId) {
            if (throwOnError) throw new Error('ApiClient not available');
            console.error("🪼 Jellyfin Enhanced: ApiClient not available");
            return;
        }
        try {
            const userId = ApiClient.getCurrentUserId();
            if (!userId) {
                if (throwOnError) throw new Error('User ID not available');
                console.error("🪼 Jellyfin Enhanced: User ID not available");
                return;
            }

            // Convert data back to PascalCase for server C# deserialization
            let dataToSave = settings;
            // currentSettings carries the resolved native-poster value (on). Leave it
            // unset on disk until the user explicitly switches it in the panel.
            if (fileName === 'settings.json' && settings === JE.currentSettings
                && JE.userConfig?.settings?.useNativePosterTags == null) {
                dataToSave = { ...settings, useNativePosterTags: null };
            }
            if ((fileName === 'bookmark.json' || fileName === 'settings.json') && typeof window.JellyfinEnhanced?.toPascalCase === 'function') {
                dataToSave = window.JellyfinEnhanced.toPascalCase(dataToSave);
            }

            const serialized = JSON.stringify(dataToSave);
            const cacheKey = `${userId}:${fileName}`;

            const post = async () => {
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
            };
            const save = (_saveChain[cacheKey] || Promise.resolve()).then(post);
            _saveChain[cacheKey] = save.catch(() => {});
            await save;
        } catch (e) {
            if (notifyOnError) toastSaveFailed();
            if (throwOnError) throw e;
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
            selectedStylePresetIndex: 0, selectedFontSizePresetIndex: 2, selectedFontFamilyPresetIndex: 0, selectedTextEffectPresetIndex: 0,
            customSubtitleTextColor: '#FFFFFFFF', customSubtitleBgColor: '#00000000',
            usingCustomColors: false,
            disableCustomSubtitleStyles: false,
            subtitleVerticalPosition: 95, subtitleHorizontalPosition: 50,
            randomButtonEnabled: true,
            randomIncludeMovies: true, randomIncludeShows: true, randomUnwatchedOnly: false,
            randomScopeCurrentContainer: false, randomSourceId: '',
            showWatchProgress: false, showFileSizes: false, showAudioLanguages: true, removeContinueWatchingEnabled: false,
            watchProgressMode: 'percentage',
            watchProgressTimeFormat: 'hours',
            pauseScreenEnabled: true,
            pauseScreenDelaySeconds: 5,
            useNativePosterTags: true,
            qualityTagsEnabled: false, genreTagsEnabled: false, languageTagsEnabled: false, ratingTagsEnabled: false, ageRatingTagsEnabled: false, peopleTagsEnabled: false, tagsHideOnHover: false,
            showResolutionTag: true, showSourceTag: true, showDynamicRangeTag: true, showSpecialFormatTag: true, showVideoCodecTag: true, showAudioInfoTag: true,
            resolutionTagOrder: 1, sourceTagOrder: 2, dynamicRangeTagOrder: 3, specialFormatTagOrder: 4, videoCodecTagOrder: 5, audioInfoTagOrder: 6,
            qualityTagsPosition: 'top-left', genreTagsPosition: 'top-right', languageTagsPosition: 'bottom-left', ratingTagsPosition: 'bottom-right', ageRatingTagsPosition: 'bottom-right',
            ratingTagsOnMovies: true, ratingTagsOnSeries: true, ratingTagsOnSeasons: true, ratingTagsOnEpisodes: true, ratingTagsOnContinueWatching: true, ratingTagsOnNextUp: true,
            qualityTagsPreferredAudioLanguage: '',
            showRatingInPlayer: true,
            reviewsExpandedByDefault: false,
            displayLanguage: '',
            calendarDisplayMode: 'list',
            calendarDefaultViewMode: 'agenda',
            disableAllShortcuts: false, longPress2xEnabled: false, lastOpenedTab: 'shortcuts'
        };

        // Per-user defaults the server builds from its settings registry (the values a new user is
        // seeded with, by settings.json key), sent to signed-in users in the public config. When the
        // block is there it is the only source of admin defaults for the keys below.
        const userSettingDefaults = pluginDefaults.UserSettingDefaults
            && typeof pluginDefaults.UserSettingDefaults === 'object'
            && !Array.isArray(pluginDefaults.UserSettingDefaults)
            ? pluginDefaults.UserSettingDefaults
            : null;

        // Public-config fields read by name instead, even with the block: the block leaves out the
        // free-form display language, and disableAllShortcuts is a client-only key (no registry entry).
        const plainAdminFields = {
            displayLanguage: 'DefaultLanguage',
            disableAllShortcuts: 'DisableAllShortcuts'
        };

        // Admin fields whose name differs from the client key. Only used without the block: a newer
        // bundle talking to a server from before UserSettingDefaults (for example after a rollback).
        const legacyPluginDefaultAliases = {
            selectedStylePresetIndex: 'DefaultSubtitleStyle',
            selectedFontSizePresetIndex: 'DefaultSubtitleSize',
            selectedFontFamilyPresetIndex: 'DefaultSubtitleFont',
            selectedTextEffectPresetIndex: 'DefaultSubtitleTextEffect',
            displayLanguage: 'DefaultLanguage',
            watchProgressMode: 'WatchProgressDefaultMode'
        };

        /**
         * Resolves the admin default for a camelCase settings key: UserSettingDefaults when the
         * server sends it, else the same-named or aliased public-config field.
         * @param {string} key camelCase settings key.
         * @returns {*} The default, or undefined when there is none (hardcodedDefaults applies).
         */
        const getPluginDefault = (key) => {
            const pascalKey = key.charAt(0).toUpperCase() + key.slice(1);
            let candidates;
            if (!userSettingDefaults) {
                candidates = [key, pascalKey];
                if (legacyPluginDefaultAliases[key]) candidates.push(legacyPluginDefaultAliases[key]);
            } else if (Object.prototype.hasOwnProperty.call(plainAdminFields, key)) {
                candidates = [plainAdminFields[key]];
            } else {
                const value = Object.prototype.hasOwnProperty.call(userSettingDefaults, pascalKey) ? userSettingDefaults[pascalKey] : undefined;
                return value !== null && value !== undefined ? value : undefined;
            }

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

    /** Shortcut combo for a keydown, e.g. "Ctrl+Shift+A". Shift is dropped for shifted symbols ("+", not "Shift++"). */
    JE.keyCombo = function(e) {
        const key = e.key;
        const isLetter = /^[a-zA-Z]$/.test(key);
        const isShiftedSymbol = key.length === 1 && key !== ' ' && !isLetter;
        return (e.metaKey ? 'Meta+' : '') +
               (e.ctrlKey ? 'Ctrl+' : '') +
               (e.altKey ? 'Alt+' : '') +
               (e.shiftKey && !isShiftedSymbol ? 'Shift+' : '') +
               (isLetter ? key.toUpperCase() : key);
    };

    /** Converts bindings saved before the fix ("Shift++") to the current format. */
    JE.normalizeShortcutKey = function(key) {
        if (typeof key !== 'string') return key;
        return key.replace(/Shift\+([^A-Za-z0-9\s,./;'\[\]\\=`-])$/, '$1');
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
        Object.keys(JE.state.activeShortcuts).forEach(function(name) {
            JE.state.activeShortcuts[name] = JE.normalizeShortcutKey(JE.state.activeShortcuts[name]);
        });
    };

})(window.JellyfinEnhanced);
