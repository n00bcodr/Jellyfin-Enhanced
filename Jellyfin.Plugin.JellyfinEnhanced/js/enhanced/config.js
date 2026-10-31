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
    // (smaller) snapshot can land last and drop the newer change. Settings document
    // snapshots and failure rollbacks also run inside this chain, so a queued
    // write sees the previous outcome before it reads the shared document.
    const _saveChain = {};

    /**
     * Nullable personal settings the server resolves as user ?? administrator
     * (Services/PosterTags/PosterTagSettings.cs) that loadSettings shows
     * resolved. Every other nullable personal field is kept null in
     * currentSettings by loadSettings itself.
     */
    const INHERITED_KEYS = [
        'showEditionTag', 'editionTagOrder', 'showLowQualitySourceTag',
        'resolutionTagOrder', 'sourceTagOrder', 'dynamicRangeTagOrder', 'specialFormatTagOrder',
        'videoCodecTagOrder', 'audioInfoTagOrder', 'seriesQualityAggregation',
        'showRuntimeTag', 'showAspectRatioTag', 'showFrameRateTag',
        'runtimeTagOrder', 'aspectRatioTagOrder', 'frameRateTagOrder',
        'qualityAudioDisplayMode', 'qualityVideoCodecDisplayMode', 'qualityHdrDisplayMode', 'qualityMinimumResolution', 'qualityHideSdr'
    ];
    // Per loaded settings object: the value each INHERITED_KEYS field shows when
    // it is not set, and which fields follow the administrator. Following is a
    // state, not a value comparison: a field unset at load follows until the user
    // changes it in any way (even to the administrator's own value), and only an
    // explicit "server default" action (setSettingInherited(..., true)) makes it
    // follow again. A following field is saved as null, so a save never pins
    // today's administrator default.
    const _inheritance = new WeakMap();
    /** The fields that follow the administrator while unset (read-only). */
    JE.inheritedSettingKeys = Object.freeze(INHERITED_KEYS.slice());

    /**
     * Whether a field of a loaded settings object follows the administrator
     * (saved as null) rather than holding the user's own choice. A value
     * written without setSettingInherited (any other value than the default)
     * counts as the user's.
     * @param {object} settings A document from loadSettings (JE.currentSettings).
     * @param {string} key camelCase settings key.
     * @returns {boolean}
     */
    JE.isSettingInherited = (settings, key) => {
        const state = _inheritance.get(settings);
        return !!state && state.inherited.has(key) && settings[key] === state.defaults[key];
    };

    /**
     * Make a field follow the administrator again (shown resolved, saved as
     * null) or mark it as the user's own choice (saved as it is, even when it
     * equals the default). Every control that changes one of these fields
     * marks it as the user's before saving; only a "server default" or reset
     * action passes true.
     * @param {object} settings A document from loadSettings (JE.currentSettings).
     * @param {string} key camelCase settings key.
     * @param {boolean} inherit
     * @returns {boolean} Whether the field is one loadSettings resolves (false: the caller stores null itself).
     */
    JE.setSettingInherited = (settings, key, inherit) => {
        const state = _inheritance.get(settings);
        if (!state || !INHERITED_KEYS.includes(key)) return false;
        if (inherit) {
            state.inherited.add(key);
            settings[key] = state.defaults[key];
        } else {
            state.inherited.delete(key);
        }
        return true;
    };

    /**
     * The administrator's value a field shows while it follows the
     * administrator (what "server default" means for it).
     * @param {object} settings A document from loadSettings (JE.currentSettings).
     * @param {string} key camelCase settings key.
     * @returns {*} undefined for a field loadSettings does not resolve.
     */
    JE.inheritedSettingDefault = (settings, key) => _inheritance.get(settings)?.defaults[key];

    /**
     * The document as saved: fields that follow the administrator go back to
     * null. One that a caller changed without marking it (it no longer shows
     * the default) has become the user's and stays so.
     * @param {object} settings
     * @param {object} source The object being serialized (settings or a copy of it).
     * @returns {object}
     */
    const withInheritance = (settings, source) => {
        const state = _inheritance.get(settings);
        if (!state) return source;
        let out = source;
        for (const key of [...state.inherited]) {
            if (settings[key] !== state.defaults[key]) {
                state.inherited.delete(key);
                continue;
            }
            if (out === source) out = { ...source };
            out[key] = null;
        }
        return out;
    };

    /**
     * Saves user settings to the server.
     * Skips the POST if the data is identical to the last value saved this session
     * (prevents redundant writes). The first save per session for a given file is
     * always allowed through since the cache starts empty.
     * Failures are logged and swallowed unless the caller opts in to them.
     * settings.json is read when its queued save starts, after the previous save
     * and its onError callback finish. Other files retain call-time snapshots.
     * @param {string} fileName Per-user settings file, e.g. 'settings.json'.
     * @param {object} settings The whole document to save.
     * @param {{throwOnError?: boolean, beforeSave?: () => void, onError?: (error: Error) => void | Promise<void>}} [options]
     *   throwOnError: reject without logging. beforeSave: apply an edit at its queue
     *   turn, before serialization. onError: restore an optimistic edit
     *   before the next queued save reads the document.
     * @returns {Promise<void>}
     */
    JE.saveUserSettings = async (fileName, settings, options = {}) => {
        const isCurrentSettings = settings === JE.currentSettings;
        const throwOnError = options?.throwOnError === true;
        /** Finish failure handling before releasing this document's save queue. */
        const handleError = async e => {
            await options.onError?.(e);
            if (throwOnError) throw e;
            console.error(`🪼 Jellyfin Enhanced: Failed to save ${fileName}:`, e);
        };
        try {
            if (typeof ApiClient === 'undefined' || !ApiClient.getCurrentUserId) {
                throw new Error('ApiClient not available');
            }
            const userId = ApiClient.getCurrentUserId();
            if (!userId) {
                throw new Error('User ID not available');
            }

            /** Build a document only after earlier saves and rollbacks have finished. */
            const serialize = () => {
                // Capture browser date context at this save's turn, after queued changes/rollbacks.
                let source = settings;
                if (fileName === 'settings.json' && isCurrentSettings && settings.statusTagsEnabled
                    && typeof JE.getStatusDateContext === 'function') {
                    const context = JE.getStatusDateContext();
                    source = { ...settings, nativePosterDateLocale: context.locale, nativePosterTimeZone: context.timeZone };
                }
                // Convert data back to PascalCase for server C# deserialization
                let dataToSave = source;
                // currentSettings carries the resolved native-poster value (on). Leave it
                // unset on disk until the user explicitly switches it in the panel.
                if (fileName === 'settings.json' && isCurrentSettings
                    && JE.userConfig?.settings?.useNativePosterTags == null) {
                    dataToSave = { ...source, useNativePosterTags: null };
                }
                if (fileName === 'settings.json') dataToSave = withInheritance(settings, dataToSave);
                if ((fileName === 'bookmark.json' || fileName === 'settings.json') && typeof window.JellyfinEnhanced?.toPascalCase === 'function') {
                    dataToSave = window.JellyfinEnhanced.toPascalCase(dataToSave);
                }
                return JSON.stringify(dataToSave);
            };
            const snapshot = fileName === 'settings.json' ? null : serialize();
            const cacheKey = `${userId}:${fileName}`;

            const post = async () => {
                options.beforeSave?.();
                const serialized = fileName === 'settings.json' ? serialize() : snapshot;
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
            const save = (_saveChain[cacheKey] || Promise.resolve()).then(post).catch(handleError);
            _saveChain[cacheKey] = save.catch(() => {});
            return save;
        } catch (e) {
            return handleError(e);
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
            qualityTagsEnabled: false, genreTagsEnabled: false, languageTagsEnabled: false, ratingTagsEnabled: false, ageRatingTagsEnabled: false, statusTagsEnabled: false, logoTagsEnabled: false, awardsTagsEnabled: false, awardsTagsPosition: 'top-left', peopleTagsEnabled: false, tagsHideOnHover: false,
            showResolutionTag: true, showSourceTag: true, showDynamicRangeTag: true, showSpecialFormatTag: true, showVideoCodecTag: true, showAudioInfoTag: true,
            // Source and edition preferences.
            showEditionTag: true, editionTagOrder: 7,
            showRuntimeTag: false, runtimeTagOrder: 8, showAspectRatioTag: false, aspectRatioTagOrder: 9, showFrameRateTag: false, frameRateTagOrder: 10, showLowQualitySourceTag: false,
            resolutionTagOrder: 1, sourceTagOrder: 2, dynamicRangeTagOrder: 3, specialFormatTagOrder: 4, videoCodecTagOrder: 5, audioInfoTagOrder: 6,
            qualityTagsPosition: 'top-left', genreTagsPosition: 'top-right', languageTagsPosition: 'bottom-left', ratingTagsPosition: 'bottom-right', ageRatingTagsPosition: 'bottom-right', logoTagsPosition: 'bottom-left', statusTagsPosition: 'top-right',
            ratingTagsOnMovies: true, ratingTagsOnSeries: true, ratingTagsOnSeasons: true, ratingTagsOnEpisodes: true, ratingTagsOnContinueWatching: true, ratingTagsOnNextUp: true, ratingTagsShowCommunity: true, ratingTagsShowCritic: true,
            statusTagsJustAdded: true, statusTagsNewRelease: true, statusTagsTrending: true,
            statusTagsSchedule: true, statusTagsMilestones: true, statusTagsSeriesStatus: false, statusTagsScenes: false,
            statusTagsLeaving: false, statusTagsDirectPlay: false,
            // Custom tag group (the administrator's tag/collection rules, tags/customtags.js).
            customTagsEnabled: false, customTagsPosition: 'top-left',
            // Language Tags display (normalized in tags/languagetags.js).
            languageTagsShowAudio: true, languageTagsShowSubtitles: false, languageTagsStyle: 'flags', languageTagsCountBadge: 'off',
            // Poster tag layout scalars (0 = a document from before layouts; see core/tag-layout.js).
            tagLayout: 'corners', tagLabelDensity: 'full', tagLayoutSettingsVersion: 0,
            tagScale: 'default', tagGap: 'default',
            qualityAudioDisplayMode: 'highest', qualityVideoCodecDisplayMode: 'highest', qualityHdrDisplayMode: 'highest',
            qualityMinimumResolution: 'off', qualityHideSdr: false,
            qualityTagsPreferredAudioLanguage: '',
            // Series/season quality aggregation policy.
            seriesQualityAggregation: 'representative',
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

        // Personal language policy: retain null inheritance and intentional empty arrays.
        // Do not resolve admin values here, or an unrelated save would pin today's policy.
        mergedSettings.languageTagsPriority = JE.core?.mediaLanguage?.priorityList(userSettings.languageTagsPriority) ?? null;
        mergedSettings.languageTagsPriorityStrict = typeof userSettings.languageTagsPriorityStrict === 'boolean'
            ? userSettings.languageTagsPriorityStrict : null;

        // Source scores: retain legacy includes for old documents and preserve an intentional empty list.
        mergedSettings.ratingTagsSources = JE.ratingSources?.normalizeSources(userSettings.ratingTagsSources) ?? null;
        mergedSettings.ratingTagsMinScore = JE.ratingSources?.settings(userSettings, JE.pluginConfig).minimum ?? 0;
        mergedSettings.ratingTagsColorByScore = JE.ratingSources?.settings(userSettings, JE.pluginConfig).color ?? false;

        // Structured layout settings: the loop above treats object values as
        // corrupt, so these are carried over explicitly. A missing or malformed
        // value is null, meaning "inherit" — core/tag-layout.js resolves it
        // (user → admin default → built-in) without writing the derived
        // value back, so a legacy document stays legacy until the user saves
        // a layout setting.
        for (const key of ['tagLayouts', 'tagGroupCaps']) {
            const value = userSettings[key];
            mergedSettings[key] = value && typeof value === 'object' && !Array.isArray(value) ? value : null;
        }

        // Corners edge spacing: null follows the admin's default (normalized
        // documents; core/tag-layout.js reads it), so no plugin default is pinned.
        mergedSettings.tagEdgeSpacing = typeof userSettings.tagEdgeSpacing === 'string' && userSettings.tagEdgeSpacing ? userSettings.tagEdgeSpacing : null;

        // Tag Styles preset: null follows the admin's preset, so it never falls
        // back to the plugin default (that would pin the admin's current choice).
        mergedSettings.tagStylePreset = typeof userSettings.tagStylePreset === 'string' && userSettings.tagStylePreset ? userSettings.tagStylePreset : null;
        mergedSettings.tagGroupOrder = Array.isArray(userSettings.tagGroupOrder) ? userSettings.tagGroupOrder : null;
        // Tag look rules (null = inherit the admin's default rules) and per-item
        // locks; core/tag-look.js normalises both when it reads them.
        mergedSettings.tagLookRules = Array.isArray(userSettings.tagLookRules) ? userSettings.tagLookRules : null;
        mergedSettings.tagLayoutLocks = userSettings.tagLayoutLocks && typeof userSettings.tagLayoutLocks === 'object'
            && !Array.isArray(userSettings.tagLayoutLocks) ? userSettings.tagLayoutLocks : null;
        // Per-shape tag looks (null = inherit the admin's, normalized documents
        // only); core/tag-layout.js normalises the value when it reads it.
        mergedSettings.tagScale = userSettings.tagScale ?? null;
        mergedSettings.tagGap = userSettings.tagGap ?? null;
        mergedSettings.tagShapeOverrides = userSettings.tagShapeOverrides && typeof userSettings.tagShapeOverrides === 'object'
            && !Array.isArray(userSettings.tagShapeOverrides) ? userSettings.tagShapeOverrides : null;

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

        // Language presentation enums are normalized on both load and server save.
        mergedSettings.languageTagsStyle = String(mergedSettings.languageTagsStyle).trim().toLowerCase() === 'codes' ? 'codes' : 'flags';
        const languageBadge = String(mergedSettings.languageTagsCountBadge).trim().toLowerCase();
        mergedSettings.languageTagsCountBadge = ['only', 'both'].includes(languageBadge) ? languageBadge : 'off';

        // Fields that follow the administrator while unset: shown resolved,
        // saved as null until the user changes them (see saveUserSettings).
        const defaults = {};
        const inherited = new Set();
        for (const key of INHERITED_KEYS) {
            const fallback = getPluginDefault(key);
            defaults[key] = fallback !== undefined ? fallback : hardcodedDefaults[key];
            if (userSettings[key] === null || userSettings[key] === undefined) inherited.add(key);
        }
        _inheritance.set(mergedSettings, { defaults, inherited });
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
