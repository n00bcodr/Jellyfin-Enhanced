using System;

namespace Jellyfin.Plugin.JellyfinEnhanced.Configuration
{
    /// <summary>The same initial personal settings for first access, administrative display initialization and reset.
    /// Personal consent fields remain unset; callers preserving an existing file retain its consents under its lock.</summary>
    public static class UserSettingsDefaults
    {
        /// <summary>Builds the configured defaults in memory without creating a directory or settings file.</summary>
        public static JellyfinEnhancedUserSettings Create(PluginConfiguration config)
        {
            ArgumentNullException.ThrowIfNull(config);
            return new JellyfinEnhancedUserSettings
            {
                AutoPauseEnabled = config.AutoPauseEnabled,
                AutoResumeEnabled = config.AutoResumeEnabled,
                AutoPipEnabled = config.AutoPipEnabled,
                LongPress2xEnabled = config.LongPress2xEnabled,
                PauseScreenEnabled = config.PauseScreenEnabled,
                PauseScreenDelaySeconds = config.PauseScreenDelaySeconds,
                AutoSkipIntro = config.AutoSkipIntro,
                AutoSkipOutro = config.AutoSkipOutro,
                DisableCustomSubtitleStyles = config.DisableCustomSubtitleStyles,
                SelectedStylePresetIndex = config.DefaultSubtitleStyle,
                SelectedFontSizePresetIndex = config.DefaultSubtitleSize,
                SelectedFontFamilyPresetIndex = config.DefaultSubtitleFont,
                SelectedTextEffectPresetIndex = config.DefaultSubtitleTextEffect,
                RandomButtonEnabled = config.RandomButtonEnabled,
                RandomUnwatchedOnly = config.RandomUnwatchedOnly,
                RandomIncludeMovies = config.RandomIncludeMovies,
                RandomIncludeShows = config.RandomIncludeShows,
                RandomScopeCurrentContainer = config.RandomScopeCurrentContainer,
                ShowWatchProgress = config.ShowWatchProgress,
                WatchProgressMode = string.IsNullOrWhiteSpace(config.WatchProgressDefaultMode) ? "percentage" : config.WatchProgressDefaultMode,
                WatchProgressTimeFormat = string.IsNullOrWhiteSpace(config.WatchProgressTimeFormat) ? "hours" : config.WatchProgressTimeFormat,
                ShowFileSizes = config.ShowFileSizes,
                ShowAudioLanguages = config.ShowAudioLanguages,
                UseNativePosterTags = null, // Not chosen yet: on while the administrator allows native poster tags.
                QualityTagsEnabled = config.QualityTagsEnabled,
                ShowResolutionTag = config.ShowResolutionTag,
                ShowSourceTag = config.ShowSourceTag,
                ShowDynamicRangeTag = config.ShowDynamicRangeTag,
                ShowSpecialFormatTag = config.ShowSpecialFormatTag,
                ShowVideoCodecTag = config.ShowVideoCodecTag,
                ShowAudioInfoTag = config.ShowAudioInfoTag,
                ResolutionTagOrder = config.ResolutionTagOrder,
                SourceTagOrder = config.SourceTagOrder,
                DynamicRangeTagOrder = config.DynamicRangeTagOrder,
                SpecialFormatTagOrder = config.SpecialFormatTagOrder,
                VideoCodecTagOrder = config.VideoCodecTagOrder,
                AudioInfoTagOrder = config.AudioInfoTagOrder,
                GenreTagsEnabled = config.GenreTagsEnabled,
                LanguageTagsEnabled = config.LanguageTagsEnabled,
                RatingTagsEnabled = config.RatingTagsEnabled,
                AgeRatingTagsEnabled = config.AgeRatingTagsEnabled,
                PeopleTagsEnabled = config.PeopleTagsEnabled,
                TagsHideOnHover = config.TagsHideOnHover,
                QualityTagsPosition = config.QualityTagsPosition,
                GenreTagsPosition = config.GenreTagsPosition,
                LanguageTagsPosition = config.LanguageTagsPosition,
                RatingTagsPosition = config.RatingTagsPosition,
                RatingTagsOnMovies = config.RatingTagsOnMovies,
                RatingTagsOnSeries = config.RatingTagsOnSeries,
                RatingTagsOnSeasons = config.RatingTagsOnSeasons,
                RatingTagsOnEpisodes = config.RatingTagsOnEpisodes,
                RatingTagsOnContinueWatching = config.RatingTagsOnContinueWatching,
                RatingTagsOnNextUp = config.RatingTagsOnNextUp,
                AgeRatingTagsPosition = config.AgeRatingTagsPosition,
                ShowRatingInPlayer = config.ShowRatingInPlayer,
                RemoveContinueWatchingEnabled = config.RemoveContinueWatchingEnabled,
                ReviewsExpandedByDefault = config.ReviewsExpandedByDefault,
                // Only a supported language tag; anything else is Auto (dashcrash §7).
                DisplayLanguage = Helpers.LanguageTags.Sanitize(config.DefaultLanguage),
                CalendarDisplayMode = "list",
                CalendarDefaultViewMode = "agenda",
                LastOpenedTab = "shortcuts"
            };
        }
    }
}
