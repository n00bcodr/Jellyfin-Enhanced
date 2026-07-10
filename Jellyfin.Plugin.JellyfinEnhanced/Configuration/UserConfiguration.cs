using System;
using System.Collections.Generic;
using System.Text.Json.Serialization;

namespace Jellyfin.Plugin.JellyfinEnhanced.Configuration
{
    public class UserSettings
    {
        public bool AutoPauseEnabled { get; set; }
        public bool AutoResumeEnabled { get; set; }
        public bool AutoPipEnabled { get; set; }
        public bool LongPress2xEnabled { get; set; }
        public bool PauseScreenEnabled { get; set; }
        public int PauseScreenDelaySeconds { get; set; } = 5;
        public bool AutoSkipIntro { get; set; }
        public bool AutoSkipOutro { get; set; }
        public bool DisableCustomSubtitleStyles { get; set; }
        public int SelectedStylePresetIndex { get; set; }
        public int SelectedFontSizePresetIndex { get; set; }
        public int SelectedFontFamilyPresetIndex { get; set; }
        public string CustomSubtitleTextColor { get; set; } = "#FFFFFFFF";
        public string CustomSubtitleBgColor { get; set; } = "#00000000";
        public bool UsingCustomColors { get; set; }
        public int SubtitleVerticalPosition { get; set; } = 85;
        public int SubtitleHorizontalPosition { get; set; } = 50;
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
        public bool ShowResolutionTag { get; set; } = true;
        public bool ShowSourceTag { get; set; } = true;
        public bool ShowDynamicRangeTag { get; set; } = true;
        public bool ShowSpecialFormatTag { get; set; } = true;
        public bool ShowVideoCodecTag { get; set; } = true;
        public bool ShowAudioInfoTag { get; set; } = true;
        public int? ResolutionTagOrder { get; set; }
        public int? SourceTagOrder { get; set; }
        public int? DynamicRangeTagOrder { get; set; }
        public int? SpecialFormatTagOrder { get; set; }
        public int? VideoCodecTagOrder { get; set; }
        public int? AudioInfoTagOrder { get; set; }
        public bool GenreTagsEnabled { get; set; }
        public bool LanguageTagsEnabled { get; set; }
        public bool RatingTagsEnabled { get; set; }
        public bool PeopleTagsEnabled { get; set; }
        public bool TagsHideOnHover { get; set; }
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

    // Per-user Spoiler Guard state. Stored in spoilerblur.json alongside
    // bookmarks.json / hidden-content.json. Each entry marks a series the user
    // has opted into Spoiler Guard for; the image filter blurs every UNWATCHED
    // episode of that series (both already-aired-but-not-watched, and unaired).
    public class SpoilerBlurSeriesEntry
    {
        public string SeriesId { get; set; } = string.Empty;
        // Display name captured at enable time so the management UI doesn't
        // need a separate library lookup per row. Updated opportunistically.
        public string SeriesName { get; set; } = string.Empty;
        // ISO 8601 timestamp.
        public string EnabledAt { get; set; } = string.Empty;
    }

    // Per-movie Spoiler Guard entry. Distinct from SpoilerBlurSeriesEntry
    // so the storage shape is explicit and the management UI can render
    // movies + series in separate sections without type-sniffing.
    public class SpoilerBlurMovieEntry
    {
        public string MovieId { get; set; } = string.Empty;
        public string MovieName { get; set; } = string.Empty;
        public string EnabledAt { get; set; } = string.Empty;
    }

    // Per-collection Spoiler Guard entry. Toggling Spoiler Guard on a collection
    // (BoxSet) is a SHORTCUT: it does NOT blur/strip the collection itself (its
    // name + art is the entry point the user clicked, like a Series). Instead
    // every member movie (via BoxSet LinkedChildren) is treated as directly
    // opted-in, so its Primary art blurs until Played and its DTO strips. A movie
    // can be in `Movies` directly AND inherited via a collection — the image/strip
    // pipelines OR these together (IsMovieInSpoilerScope).
    public class SpoilerBlurCollectionEntry
    {
        public string CollectionId { get; set; } = string.Empty;
        public string CollectionName { get; set; } = string.Empty;
        public string EnabledAt { get; set; } = string.Empty;
    }

    // Pre-acquisition spoiler intent: user subscribed to Spoiler Guard for a
    // TMDB id not (yet) in the library. Two sources: (a) auto-add on a Seerr
    // request via JE's /jellyseerr/request, gated by SpoilerAutoEnableOnSeerrRequest;
    // (b) manual add from the Seerr more-info modal, gated only by SpoilerBlurEnabled
    // (so a user can register intent even when another user already requested the
    // title and the Request button is disabled). Keyed "tv:{tmdbId}" or
    // "movie:{tmdbId}". On ItemAdded, SpoilerSeerrPendingPromoter matches by
    // ProviderIds.Tmdb, promotes it into Series/Movies, and removes this row.
    public class SpoilerBlurPendingEntry
    {
        public string MediaType { get; set; } = string.Empty;
        public string TmdbId { get; set; } = string.Empty;
        public string DisplayName { get; set; } = string.Empty;
        public string RequestedAt { get; set; } = string.Empty;
    }

    // Per-user opt-outs from individual admin strip categories. Each field
    // is nullable bool with semantics: null = inherit admin policy,
    // false = override to "don't hide this for me". true is recorded but
    // never enables a strip the admin disabled — the admin cap still wins.
    public class SpoilerBlurUserPrefs
    {
        public bool? HideSeriesDescriptions { get; set; }
        public bool? HideEpisodeDescriptions { get; set; }
        public bool? HideTags { get; set; }
        public bool? HideChapterNames { get; set; }
        public bool? HideTaglines { get; set; }
        // Single opt-out covering both community and critic ratings.
        public bool? HideRatings { get; set; }
        public bool? HideAirDate { get; set; }
        public bool? ReplaceEpisodeTitles { get; set; }
        public bool? HideCast { get; set; }
        public bool? HideReviews { get; set; }
        // Persist the in-dialog "Don't ask again for 15 minutes" snooze as a
        // permanent user choice instead of a session timer.
        public bool SkipDisableConfirm { get; set; }
    }

    public class UserSpoilerBlur
    {
        // Keyed by series ID in N format (no dashes), case-insensitive — matches
        // UserHiddenContent. The setter re-wraps incoming dictionaries with
        // StringComparer.OrdinalIgnoreCase because System.Text.Json deserialization
        // silently drops the comparer (it builds a default-comparer Dictionary and
        // assigns to the setter), breaking case-insensitive lookups on any STJ read
        // path. Newtonsoft preserves the comparer, but we don't rely on that.
        private Dictionary<string, SpoilerBlurSeriesEntry> _series
            = new(StringComparer.OrdinalIgnoreCase);
        public Dictionary<string, SpoilerBlurSeriesEntry> Series
        {
            get => _series;
            set => _series = value == null
                ? new Dictionary<string, SpoilerBlurSeriesEntry>(StringComparer.OrdinalIgnoreCase)
                : new Dictionary<string, SpoilerBlurSeriesEntry>(value, StringComparer.OrdinalIgnoreCase);
        }

        // Movies opted into Spoiler Guard. Keyed like Series (N-format GUID,
        // case-insensitive). Files written before movie support deserialize with
        // an empty dict.
        private Dictionary<string, SpoilerBlurMovieEntry> _movies
            = new(StringComparer.OrdinalIgnoreCase);
        public Dictionary<string, SpoilerBlurMovieEntry> Movies
        {
            get => _movies;
            set => _movies = value == null
                ? new Dictionary<string, SpoilerBlurMovieEntry>(StringComparer.OrdinalIgnoreCase)
                : new Dictionary<string, SpoilerBlurMovieEntry>(value, StringComparer.OrdinalIgnoreCase);
        }

        // Collections (BoxSet) the user has opted into Spoiler Guard for.
        // Same N-format key, case-insensitive comparer.
        private Dictionary<string, SpoilerBlurCollectionEntry> _collections
            = new(StringComparer.OrdinalIgnoreCase);
        public Dictionary<string, SpoilerBlurCollectionEntry> Collections
        {
            get => _collections;
            set => _collections = value == null
                ? new Dictionary<string, SpoilerBlurCollectionEntry>(StringComparer.OrdinalIgnoreCase)
                : new Dictionary<string, SpoilerBlurCollectionEntry>(value, StringComparer.OrdinalIgnoreCase);
        }

        // Pre-acquisition pending entries keyed "tv:{tmdbId}" or
        // "movie:{tmdbId}". Promoted to Series/Movies by
        // SpoilerSeerrPendingPromoter on ItemAdded.
        private Dictionary<string, SpoilerBlurPendingEntry> _pendingTmdb
            = new(StringComparer.OrdinalIgnoreCase);
        public Dictionary<string, SpoilerBlurPendingEntry> PendingTmdb
        {
            get => _pendingTmdb;
            set => _pendingTmdb = value == null
                ? new Dictionary<string, SpoilerBlurPendingEntry>(StringComparer.OrdinalIgnoreCase)
                : new Dictionary<string, SpoilerBlurPendingEntry>(value, StringComparer.OrdinalIgnoreCase);
        }

        // Per-user override of admin strip policy. A fresh user state has an
        // empty Prefs object (all nullable bools = null), so unmigrated
        // spoilerblur.json files continue to honor admin policy unchanged.
        public SpoilerBlurUserPrefs Prefs { get; set; } = new SpoilerBlurUserPrefs();
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
        public bool ShowHideButtons { get; set; } = true;
        public bool ShowHideConfirmation { get; set; } = true;
        public bool ShowButtonJellyseerr { get; set; } = true;
        public bool ShowButtonLibrary { get; set; } = false;
        public bool ShowButtonDetails { get; set; } = true;
        public bool ShowButtonCast { get; set; } = false;
        public bool ExperimentalHideCollections { get; set; } = false;
    }

    public class UserHiddenContent
    {
        public Dictionary<string, HiddenContentItem> Items { get; set; } = new Dictionary<string, HiddenContentItem>();
        public HiddenContentSettings Settings { get; set; } = new HiddenContentSettings();
    }

    /// <summary>
    /// A single user-written review for a TMDB item.
    /// </summary>
    public class UserReview
    {
        /// <summary>Jellyfin user ID in N format (no dashes).</summary>
        public string UserId { get; set; } = string.Empty;
        public string TmdbId { get; set; } = string.Empty;
        /// <summary>"movie" or "tv"</summary>
        public string MediaType { get; set; } = string.Empty;
        public string Content { get; set; } = string.Empty;
        /// <summary>Optional rating, 1–5 (whole numbers only).</summary>
        public int? Rating { get; set; }
        public string CreatedAt { get; set; } = string.Empty;
        public string UpdatedAt { get; set; } = string.Empty;
    }

    /// <summary>
    /// Server-wide store of all user reviews, keyed by "{userIdN}:{mediaType}:{tmdbId}".
    /// Stored in a single shared file (reviews.json) at the plugin config root.
    /// </summary>
    public class AllReviewsStore
    {
        public Dictionary<string, UserReview> Reviews { get; set; } = new Dictionary<string, UserReview>();
    }
}
