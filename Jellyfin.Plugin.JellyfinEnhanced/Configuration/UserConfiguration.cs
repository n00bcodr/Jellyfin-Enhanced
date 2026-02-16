using System.Collections.Generic;

namespace Jellyfin.Plugin.JellyfinEnhanced.Configuration
{
    public class UserSettings
    {
        public bool AutoPauseEnabled { get; set; }
        public bool AutoResumeEnabled { get; set; }
        public bool AutoPipEnabled { get; set; }
        public bool LongPress2xEnabled { get; set; }
        public bool PauseScreenEnabled { get; set; }
        public bool AutoSkipIntro { get; set; }
        public bool AutoSkipOutro { get; set; }
        public bool DisableCustomSubtitleStyles { get; set; }
        public int SelectedStylePresetIndex { get; set; }
        public int SelectedFontSizePresetIndex { get; set; }
        public int SelectedFontFamilyPresetIndex { get; set; }
        public string CustomSubtitleTextColor { get; set; } = "#FFFFFFFF";
        public string CustomSubtitleBgColor { get; set; } = "#00000000";
        public bool UsingCustomColors { get; set; }
        public bool RandomButtonEnabled { get; set; }
        public bool RandomUnwatchedOnly { get; set; }
        public bool RandomIncludeMovies { get; set; }
        public bool RandomIncludeShows { get; set; }
        public bool ShowWatchProgress { get; set; }
        public string WatchProgressMode { get; set; } = "percentage";
        public string WatchProgressTimeFormat { get; set; } = "hours";
        public bool ShowFileSizes { get; set; }
        public bool ShowAudioLanguages { get; set; }
        public bool QualityTagsEnabled { get; set; }
        public bool GenreTagsEnabled { get; set; }
        public bool LanguageTagsEnabled { get; set; }
        public bool RatingTagsEnabled { get; set; }
        public bool PeopleTagsEnabled { get; set; }
        public string QualityTagsPosition { get; set; } = "top-left";
        public string GenreTagsPosition { get; set; } = "top-right";
        public string LanguageTagsPosition { get; set; } = "bottom-left";
        public string RatingTagsPosition { get; set; } = "bottom-right";
        public bool ShowRatingInPlayer { get; set; } = true;
        public bool RemoveContinueWatchingEnabled { get; set; }
        public string LastOpenedTab { get; set; } = string.Empty;
        public bool ReviewsExpandedByDefault { get; set; }
        public string DisplayLanguage { get; set; } = string.Empty;
        public string CalendarDisplayMode { get; set; } = "list";
        public string CalendarDefaultViewMode { get; set; } = "agenda";
    }

    public class UserShortcuts
    {
        public List<Shortcut> Shortcuts { get; set; } = new List<Shortcut>();
    }

    public class BookmarkItem
    {
        public string ItemId { get; set; } = string.Empty;
        public string TmdbId { get; set; } = string.Empty;
        public string TvdbId { get; set; } = string.Empty;
        public string MediaType { get; set; } = string.Empty;
        public string Name { get; set; } = string.Empty;
        public double Timestamp { get; set; }
        public string Label { get; set; } = string.Empty;
        public string CreatedAt { get; set; } = string.Empty;
        public string UpdatedAt { get; set; } = string.Empty;
        public string SyncedFrom { get; set; } = string.Empty;
    }

    public class UserBookmark
    {
        public Dictionary<string, BookmarkItem> Bookmarks { get; set; } = new Dictionary<string, BookmarkItem>();
    }

    public class ElsewhereSettings
    {
        public string Region { get; set; } = string.Empty;
        public List<string> Regions { get; set; } = new List<string>();
        public List<string> Services { get; set; } = new List<string>();
    }

    public class PendingWatchlistItem
    {
        public int TmdbId { get; set; }
        public string MediaType { get; set; } = string.Empty; // "movie" or "tv"
        public System.DateTime RequestedAt { get; set; }
    }

    public class PendingWatchlistItems
    {
        public List<PendingWatchlistItem> Items { get; set; } = new List<PendingWatchlistItem>();
    }

    public class ProcessedWatchlistItem
    {
        public int TmdbId { get; set; }
        public string MediaType { get; set; } = string.Empty; // "movie" or "tv"
        public System.DateTime ProcessedAt { get; set; }
        /// <summary>
        /// Indicates how this item was processed:
        /// - "sync": Item was added to watchlist during a scheduled sync task
        /// - "monitor": Item was added automatically when media arrived in library
        /// - "existing": Item was already in watchlist when plugin checked it
        /// </summary>
        public string Source { get; set; } = string.Empty;
    }

    public class ProcessedWatchlistItems
    {
        public List<ProcessedWatchlistItem> Items { get; set; } = new List<ProcessedWatchlistItem>();
    }

    public class HiddenContentItem
    {
        public string ItemId { get; set; } = string.Empty;
        public string Name { get; set; } = string.Empty;
        public string Type { get; set; } = string.Empty;
        public string TmdbId { get; set; } = string.Empty;
        public string HiddenAt { get; set; } = string.Empty;
        public string PosterPath { get; set; } = string.Empty;
        public string SeriesId { get; set; } = string.Empty;
        public string SeriesName { get; set; } = string.Empty;
        public int? SeasonNumber { get; set; }
        public int? EpisodeNumber { get; set; }
        public string HideScope { get; set; } = "global";
    }

    public class HiddenContentSettings
    {
        public bool Enabled { get; set; } = true;
        public bool FilterLibrary { get; set; } = true;
        public bool FilterDiscovery { get; set; } = true;
        public bool FilterUpcoming { get; set; } = true;
        public bool FilterCalendar { get; set; } = true;
        public bool FilterSearch { get; set; } = false;
        public bool FilterRecommendations { get; set; } = true;
        public bool FilterRequests { get; set; } = true;
        public bool FilterNextUp { get; set; } = true;
        public bool FilterContinueWatching { get; set; } = true;
        public bool ShowHideConfirmation { get; set; } = true;
        public bool ShowButtonJellyseerr { get; set; } = true;
        public bool ShowButtonLibrary { get; set; } = false;
        public bool ShowButtonDetails { get; set; } = true;
    }

    public class UserHiddenContent
    {
        public Dictionary<string, HiddenContentItem> Items { get; set; } = new Dictionary<string, HiddenContentItem>();
        public HiddenContentSettings Settings { get; set; } = new HiddenContentSettings();
    }

    public class SpoilerModeRule
    {
        public string ItemId { get; set; } = string.Empty;
        public string ItemName { get; set; } = string.Empty;
        public string ItemType { get; set; } = string.Empty;
        public bool Enabled { get; set; }
        public string Preset { get; set; } = "balanced";
        public string? BoundaryOverride { get; set; }
        public string EnabledAt { get; set; } = string.Empty;
    }

    public class SpoilerModeSettings
    {
        public string Preset { get; set; } = "balanced";
        public string WatchedThreshold { get; set; } = "played";
        public string BoundaryRule { get; set; } = "showOnlyWatched";
        public string ArtworkPolicy { get; set; } = "blur";
        public bool ProtectHome { get; set; } = true;
        public bool ProtectSearch { get; set; } = true;
        public bool ProtectOverlay { get; set; } = true;
        public bool ProtectCalendar { get; set; } = true;
        public bool ProtectRecentlyAdded { get; set; } = true;
        public bool HideRuntime { get; set; }
        public bool HideAirDate { get; set; }
        public bool HideGuestStars { get; set; }
        public int RevealDuration { get; set; } = 10;
        public bool ShowSeriesOverview { get; set; }
    }

    public class UserSpoilerMode
    {
        public Dictionary<string, SpoilerModeRule> Rules { get; set; } = new Dictionary<string, SpoilerModeRule>();
        public SpoilerModeSettings Settings { get; set; } = new SpoilerModeSettings();
        public List<string> TagAutoEnable { get; set; } = new List<string>();
        public bool AutoEnableOnFirstPlay { get; set; }
    }
}
