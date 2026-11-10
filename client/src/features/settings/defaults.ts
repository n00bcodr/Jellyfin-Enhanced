import type { SettingsBridge, SettingsDocument } from './host';
import { INHERITED_KEYS, inheritance } from './inheritance';
export function loadSettings(JE: SettingsBridge): SettingsDocument {
        const userSettings = JE.userConfig?.settings || {};
        const pluginDefaults = JE.pluginConfig || {};

        const hardcodedDefaults: SettingsDocument = {
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
            showRuntimeTag: false, runtimeTagOrder: 8, showAspectRatioTag: false, aspectRatioTagOrder: 9, showFrameRateTag: false, frameRateTagOrder: 10, showVersionsTag: false, versionsTagOrder: 11, showLowQualitySourceTag: false,
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
        const pluginDefaultAliases: Record<string, string[]> = {
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
        const getPluginDefault = (key: string) => {
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

        const mergedSettings: SettingsDocument = {};
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
        for (const key of ['tagLayouts', 'tagGroupCaps', 'tagGroupScopes']) {
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
        // Per-kind opacity and size (null = follow the admin's, normalized documents only); core/tag-layout.js
        // validates and clamps every value when it reads them.
        mergedSettings.tagKindLooks = Array.isArray(userSettings.tagKindLooks) ? userSettings.tagKindLooks : null;
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
        const defaults: SettingsDocument = {};
        const inherited = new Set<string>();
        for (const key of INHERITED_KEYS) {
            const fallback = getPluginDefault(key);
            defaults[key] = fallback !== undefined ? fallback : hardcodedDefaults[key];
            if (userSettings[key] === null || userSettings[key] === undefined) inherited.add(key);
        }
        inheritance.set(mergedSettings, { defaults, inherited });
        return mergedSettings;

}
