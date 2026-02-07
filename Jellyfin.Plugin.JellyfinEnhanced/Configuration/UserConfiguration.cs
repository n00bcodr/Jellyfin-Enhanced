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
        public bool ShowHideConfirmation { get; set; } = true;
    }

    public class UserHiddenContent
    {
        public Dictionary<string, HiddenContentItem> Items { get; set; } = new Dictionary<string, HiddenContentItem>();
        public HiddenContentSettings Settings { get; set; } = new HiddenContentSettings();
    }
}
