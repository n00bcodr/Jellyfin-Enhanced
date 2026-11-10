using Jellyfin.Plugin.JellyfinEnhanced.Configuration;

namespace Jellyfin.Plugin.JellyfinEnhanced.Shared.Settings
{
    /// <summary>
    /// The settings a user starts with, seeded from the plugin configuration. Moved verbatim from
    /// JellyfinEnhancedController (restructure S2.0a); it reads only the plugin configuration, no request state.
    /// </summary>
    public static class SettingsDefaults
    {
        public static JellyfinEnhancedUserSettings Create()
        {
            var defaultConfig = JellyfinEnhanced.Instance?.Configuration;
            if (defaultConfig == null) return new JellyfinEnhancedUserSettings();
            var defaultUserSettings = new JellyfinEnhancedUserSettings
            {
                AutoPauseEnabled = defaultConfig.AutoPauseEnabled,
                AutoResumeEnabled = defaultConfig.AutoResumeEnabled,
                AutoPipEnabled = defaultConfig.AutoPipEnabled,
                LongPress2xEnabled = defaultConfig.LongPress2xEnabled,
                PauseScreenEnabled = defaultConfig.PauseScreenEnabled,
                PauseScreenDelaySeconds = defaultConfig.PauseScreenDelaySeconds,
                AutoSkipIntro = defaultConfig.AutoSkipIntro,
                AutoSkipOutro = defaultConfig.AutoSkipOutro,
                DisableCustomSubtitleStyles = defaultConfig.DisableCustomSubtitleStyles,
                SelectedStylePresetIndex = defaultConfig.DefaultSubtitleStyle,
                SelectedFontSizePresetIndex = defaultConfig.DefaultSubtitleSize,
                SelectedFontFamilyPresetIndex = defaultConfig.DefaultSubtitleFont,
                SelectedTextEffectPresetIndex = defaultConfig.DefaultSubtitleTextEffect,
                RandomButtonEnabled = defaultConfig.RandomButtonEnabled,
                RandomUnwatchedOnly = defaultConfig.RandomUnwatchedOnly,
                RandomIncludeMovies = defaultConfig.RandomIncludeMovies,
                RandomIncludeShows = defaultConfig.RandomIncludeShows,
                RandomScopeCurrentContainer = defaultConfig.RandomScopeCurrentContainer,
                ShowWatchProgress = defaultConfig.ShowWatchProgress,
                WatchProgressMode = string.IsNullOrWhiteSpace(defaultConfig.WatchProgressDefaultMode) ? "percentage" : defaultConfig.WatchProgressDefaultMode,
                WatchProgressTimeFormat = string.IsNullOrWhiteSpace(defaultConfig.WatchProgressTimeFormat) ? "hours" : defaultConfig.WatchProgressTimeFormat,
                ShowFileSizes = defaultConfig.ShowFileSizes,
                ShowAudioLanguages = defaultConfig.ShowAudioLanguages,
                UseNativePosterTags = null, // Not chosen yet: on while the administrator allows native poster tags.
                QualityTagsEnabled = defaultConfig.QualityTagsEnabled,
                ShowResolutionTag = defaultConfig.ShowResolutionTag,
                ShowSourceTag = defaultConfig.ShowSourceTag,
                // Source and edition defaults.
                ShowEditionTag = defaultConfig.ShowEditionTag,
                ShowRuntimeTag = defaultConfig.ShowRuntimeTag,
                ShowVersionsTag = defaultConfig.ShowVersionsTag,
                ShowAspectRatioTag = defaultConfig.ShowAspectRatioTag,
                ShowFrameRateTag = defaultConfig.ShowFrameRateTag,
                EditionTagOrder = defaultConfig.EditionTagOrder,
                RuntimeTagOrder = defaultConfig.RuntimeTagOrder,
                VersionsTagOrder = defaultConfig.VersionsTagOrder,
                AspectRatioTagOrder = defaultConfig.AspectRatioTagOrder,
                FrameRateTagOrder = defaultConfig.FrameRateTagOrder,
                ShowLowQualitySourceTag = defaultConfig.ShowLowQualitySourceTag,
                ShowDynamicRangeTag = defaultConfig.ShowDynamicRangeTag,
                ShowSpecialFormatTag = defaultConfig.ShowSpecialFormatTag,
                ShowVideoCodecTag = defaultConfig.ShowVideoCodecTag,
                ShowAudioInfoTag = defaultConfig.ShowAudioInfoTag,
                ResolutionTagOrder = defaultConfig.ResolutionTagOrder,
                SourceTagOrder = defaultConfig.SourceTagOrder,
                DynamicRangeTagOrder = defaultConfig.DynamicRangeTagOrder,
                SpecialFormatTagOrder = defaultConfig.SpecialFormatTagOrder,
                VideoCodecTagOrder = defaultConfig.VideoCodecTagOrder,
                AudioInfoTagOrder = defaultConfig.AudioInfoTagOrder,
                GenreTagsEnabled = defaultConfig.GenreTagsEnabled,
                LanguageTagsEnabled = defaultConfig.LanguageTagsEnabled,
                RatingTagsEnabled = defaultConfig.RatingTagsEnabled,
                AgeRatingTagsEnabled = defaultConfig.AgeRatingTagsEnabled,
                LogoTagsEnabled = defaultConfig.LogoTagsEnabled,
                StatusTagsEnabled = defaultConfig.StatusTagsEnabled,
                AwardsTagsEnabled = defaultConfig.AwardsTagsEnabled,
                AwardsTagsPosition = defaultConfig.AwardsTagsPosition,
                CustomTagsEnabled = defaultConfig.CustomTagsEnabled,
                PeopleTagsEnabled = defaultConfig.PeopleTagsEnabled,
                TagsHideOnHover = defaultConfig.TagsHideOnHover,
                QualityTagsPosition = defaultConfig.QualityTagsPosition,
                // Series/season quality aggregation default.
                SeriesQualityAggregation = Jellyfin.Plugin.JellyfinEnhanced.Shared.MediaTags.SeriesQualityAggregation.Normalize(defaultConfig.SeriesQualityAggregation),
                QualityHideSdr = defaultConfig.QualityHideSdr,
                QualityMinimumResolution = QualityDisplayRules.Minimum(defaultConfig.QualityMinimumResolution),
                QualityHdrDisplayMode = QualityDisplayRules.Mode(defaultConfig.QualityHdrDisplayMode),
                QualityVideoCodecDisplayMode = QualityDisplayRules.Mode(defaultConfig.QualityVideoCodecDisplayMode),
                QualityAudioDisplayMode = QualityDisplayRules.Mode(defaultConfig.QualityAudioDisplayMode),
                GenreTagsPosition = defaultConfig.GenreTagsPosition,
                LanguageTagsPosition = defaultConfig.LanguageTagsPosition,
                RatingTagsPosition = defaultConfig.RatingTagsPosition,
                RatingTagsOnMovies = true, // follows the administrator (TagLayoutRules.RatingScope)
                RatingTagsOnSeries = true, // follows the administrator (TagLayoutRules.RatingScope)
                RatingTagsOnSeasons = true, // follows the administrator (TagLayoutRules.RatingScope)
                RatingTagsOnEpisodes = true, // follows the administrator (TagLayoutRules.RatingScope)
                RatingTagsOnContinueWatching = true, // follows the administrator (TagLayoutRules.RatingScope)
                RatingTagsOnNextUp = true, // follows the administrator (TagLayoutRules.RatingScope)
                RatingTagsShowCommunity = defaultConfig.RatingTagsShowCommunity,
                RatingTagsShowCritic = defaultConfig.RatingTagsShowCritic,
                // Multi-source rating defaults (copy the ordered array).
                RatingTagsSources = RatingSourceSettings.Defaults(defaultConfig).ToArray(),
                RatingTagsMinScore = RatingSourceSettings.NormalizeMinimum(defaultConfig.RatingTagsMinScore),
                RatingTagsColorByScore = defaultConfig.RatingTagsColorByScore,
                AgeRatingTagsPosition = defaultConfig.AgeRatingTagsPosition,
                LogoTagsPosition = defaultConfig.LogoTagsPosition,
                StatusTagsPosition = defaultConfig.StatusTagsPosition,
                CustomTagsPosition = defaultConfig.CustomTagsPosition,
                StatusTagsJustAdded = defaultConfig.StatusTagsJustAdded,
                StatusTagsNewRelease = defaultConfig.StatusTagsNewRelease,
                StatusTagsTrending = defaultConfig.StatusTagsTrending,
                // Tag Styles preset: null follows the admin's preset.
                TagStylePreset = null,
                StatusTagsSchedule = defaultConfig.StatusTagsSchedule,
                StatusTagsMilestones = defaultConfig.StatusTagsMilestones,
                StatusTagsSeriesStatus = defaultConfig.StatusTagsSeriesStatus,
                StatusTagsScenes = defaultConfig.StatusTagsScenes,
                StatusTagsLeaving = defaultConfig.StatusTagsLeaving,
                StatusTagsDirectPlay = defaultConfig.StatusTagsDirectPlay,
                ShowRatingInPlayer = defaultConfig.ShowRatingInPlayer,
                RemoveContinueWatchingEnabled = defaultConfig.RemoveContinueWatchingEnabled,
                ReviewsExpandedByDefault = defaultConfig.ReviewsExpandedByDefault,
                DisplayLanguage = defaultConfig.DefaultLanguage,
                CalendarDisplayMode = "list",
                CalendarDefaultViewMode = "agenda",
                LastOpenedTab = "shortcuts"
            };
            TagLayoutRules.ApplyDefaults(defaultUserSettings, defaultConfig);
            TagLookValidation.ApplyDefaults(defaultUserSettings, defaultConfig);
            LanguageTagDisplay.ApplyDefaults(defaultUserSettings, defaultConfig);
            TagShapeRules.ApplyDefaults(defaultUserSettings, defaultConfig);

            return defaultUserSettings;
        }
    }
}
