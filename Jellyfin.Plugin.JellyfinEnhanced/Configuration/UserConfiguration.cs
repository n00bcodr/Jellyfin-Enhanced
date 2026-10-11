using System;
using System.Collections.Generic;
using System.Text.Json.Serialization;

namespace Jellyfin.Plugin.JellyfinEnhanced.Configuration
{
    /// <summary>
    /// A user's settings.json. Every property is a registry key declared with [UserSetting]
    /// (admin default, lock, validation; see <see cref="UserSettingsRegistry"/>) or is listed
    /// in <see cref="UserSettingsRegistry.NotRegistered"/>.
    /// </summary>
    public class UserSettings
    {
        [UserSetting(nameof(PluginConfiguration.AutoPauseEnabled), Lockable = true)]
        public bool AutoPauseEnabled { get; set; }
        [UserSetting(nameof(PluginConfiguration.AutoResumeEnabled), Lockable = true)]
        public bool AutoResumeEnabled { get; set; }
        [UserSetting(nameof(PluginConfiguration.AutoPipEnabled), Lockable = true)]
        public bool AutoPipEnabled { get; set; }
        [UserSetting(nameof(PluginConfiguration.LongPress2xEnabled), Lockable = true)]
        public bool LongPress2xEnabled { get; set; }
        [UserSetting(nameof(PluginConfiguration.PauseScreenEnabled), Lockable = true)]
        public bool PauseScreenEnabled { get; set; }
        [UserSetting(nameof(PluginConfiguration.PauseScreenDelaySeconds), Min = 1, Max = 60)] // no admin control yet, so not Lockable
        public int PauseScreenDelaySeconds { get; set; } = 5;
        [UserSetting(nameof(PluginConfiguration.AutoSkipIntro), Lockable = true)]
        public bool AutoSkipIntro { get; set; }
        [UserSetting(nameof(PluginConfiguration.AutoSkipOutro), Lockable = true)]
        public bool AutoSkipOutro { get; set; }
        [UserSetting(nameof(PluginConfiguration.DisableCustomSubtitleStyles), Lockable = true)]
        public bool DisableCustomSubtitleStyles { get; set; }
        [UserSetting(nameof(PluginConfiguration.DefaultSubtitleStyle), Lockable = true, AdminControlId = nameof(PluginConfiguration.DefaultSubtitleStyle), Min = 0, Max = 5)]
        public int SelectedStylePresetIndex { get; set; }
        [UserSetting(nameof(PluginConfiguration.DefaultSubtitleSize), Lockable = true, AdminControlId = nameof(PluginConfiguration.DefaultSubtitleSize), Min = 0, Max = 5)]
        public int SelectedFontSizePresetIndex { get; set; }
        [UserSetting(nameof(PluginConfiguration.DefaultSubtitleFont), Lockable = true, AdminControlId = nameof(PluginConfiguration.DefaultSubtitleFont), Min = 0, Max = 4)]
        public int SelectedFontFamilyPresetIndex { get; set; }
        [UserSetting(nameof(PluginConfiguration.DefaultSubtitleTextEffect), Lockable = true, AdminControlId = nameof(PluginConfiguration.DefaultSubtitleTextEffect), Min = 0, Max = 4)]
        public int SelectedTextEffectPresetIndex { get; set; }
        [UserSetting(Inheritable = false, Continuous = true, Pattern = UserSettingsRegistry.ColourPattern)]
        public string CustomSubtitleTextColor { get; set; } = "#FFFFFFFF";
        [UserSetting(Inheritable = false, Continuous = true, Pattern = UserSettingsRegistry.ColourPattern)]
        public string CustomSubtitleBgColor { get; set; } = "#00000000";
        [UserSetting(Inheritable = false)]
        public bool UsingCustomColors { get; set; }
        [UserSetting(Inheritable = false, Continuous = true, Min = 0, Max = 100)]
        public int SubtitleVerticalPosition { get; set; } = 85;
        [UserSetting(Inheritable = false, Continuous = true, Min = 0, Max = 100)]
        public int SubtitleHorizontalPosition { get; set; } = 50;
        [UserSetting(nameof(PluginConfiguration.RandomButtonEnabled), Lockable = true)]
        public bool RandomButtonEnabled { get; set; }
        [UserSetting(nameof(PluginConfiguration.RandomUnwatchedOnly), Lockable = true)]
        public bool RandomUnwatchedOnly { get; set; }
        [UserSetting(nameof(PluginConfiguration.RandomIncludeMovies), Lockable = true)]
        public bool RandomIncludeMovies { get; set; }
        [UserSetting(nameof(PluginConfiguration.RandomIncludeShows), Lockable = true)]
        public bool RandomIncludeShows { get; set; }
        [UserSetting(nameof(PluginConfiguration.RandomScopeCurrentContainer), Lockable = true)]
        public bool RandomScopeCurrentContainer { get; set; }
        [UserSetting(Inheritable = false, MaxLength = 64)]
        public string RandomSourceId { get; set; } = "";
        [UserSetting(nameof(PluginConfiguration.ShowWatchProgress), Lockable = true)]
        public bool ShowWatchProgress { get; set; }
        [UserSetting(nameof(PluginConfiguration.WatchProgressDefaultMode), Lockable = true, Incidental = true, BlankAdminUsesInitializer = true,
            Choices = new[] { "percentage", "time", "remaining" })]
        public string WatchProgressMode { get; set; } = "percentage";
        [UserSetting(nameof(PluginConfiguration.WatchProgressTimeFormat), Lockable = true, BlankAdminUsesInitializer = true, Choices = new[] { "hours", "full" })]
        public string WatchProgressTimeFormat { get; set; } = "hours";
        [UserSetting(nameof(PluginConfiguration.ShowFileSizes), Lockable = true)]
        public bool ShowFileSizes { get; set; }
        [UserSetting(nameof(PluginConfiguration.ShowAudioLanguages), Lockable = true)]
        public bool ShowAudioLanguages { get; set; }
        /// <summary>Native poster tags preference; null (never chosen) and true are on, false is off.</summary>
        [UserSetting(Inheritable = false, Reach = SettingReach.Server, GateBy = nameof(PluginConfiguration.NativePosterTagsEnabled))]
        public bool? UseNativePosterTags { get; set; }
        [UserSetting(nameof(PluginConfiguration.QualityTagsEnabled), Lockable = true, Reach = SettingReach.Both)]
        public bool QualityTagsEnabled { get; set; }
        [UserSetting(nameof(PluginConfiguration.ShowResolutionTag), Lockable = true, Reach = SettingReach.Both)]
        public bool ShowResolutionTag { get; set; } = true;
        [UserSetting(nameof(PluginConfiguration.ShowSourceTag), Lockable = true, Reach = SettingReach.Both)]
        public bool ShowSourceTag { get; set; } = true;
        [UserSetting(nameof(PluginConfiguration.ShowDynamicRangeTag), Lockable = true, Reach = SettingReach.Both)]
        public bool ShowDynamicRangeTag { get; set; } = true;
        [UserSetting(nameof(PluginConfiguration.ShowSpecialFormatTag), Lockable = true, Reach = SettingReach.Both)]
        public bool ShowSpecialFormatTag { get; set; } = true;
        [UserSetting(nameof(PluginConfiguration.ShowVideoCodecTag), Lockable = true, Reach = SettingReach.Both)]
        public bool ShowVideoCodecTag { get; set; } = true;
        [UserSetting(nameof(PluginConfiguration.ShowAudioInfoTag), Lockable = true, Reach = SettingReach.Both)]
        public bool ShowAudioInfoTag { get; set; } = true;
        [UserSetting(nameof(PluginConfiguration.ResolutionTagOrder), Lockable = true, Reach = SettingReach.Both, NullInheritsAdmin = true,
            AdminRowKey = nameof(PluginConfiguration.ResolutionTagOrder), Min = 1, Max = 6)]
        public int? ResolutionTagOrder { get; set; }
        [UserSetting(nameof(PluginConfiguration.SourceTagOrder), Lockable = true, Reach = SettingReach.Both, NullInheritsAdmin = true,
            AdminRowKey = nameof(PluginConfiguration.SourceTagOrder), Min = 1, Max = 6)]
        public int? SourceTagOrder { get; set; }
        [UserSetting(nameof(PluginConfiguration.DynamicRangeTagOrder), Lockable = true, Reach = SettingReach.Both, NullInheritsAdmin = true,
            AdminRowKey = nameof(PluginConfiguration.DynamicRangeTagOrder), Min = 1, Max = 6)]
        public int? DynamicRangeTagOrder { get; set; }
        [UserSetting(nameof(PluginConfiguration.SpecialFormatTagOrder), Lockable = true, Reach = SettingReach.Both, NullInheritsAdmin = true,
            AdminRowKey = nameof(PluginConfiguration.SpecialFormatTagOrder), Min = 1, Max = 6)]
        public int? SpecialFormatTagOrder { get; set; }
        [UserSetting(nameof(PluginConfiguration.VideoCodecTagOrder), Lockable = true, Reach = SettingReach.Both, NullInheritsAdmin = true,
            AdminRowKey = nameof(PluginConfiguration.VideoCodecTagOrder), Min = 1, Max = 6)]
        public int? VideoCodecTagOrder { get; set; }
        [UserSetting(nameof(PluginConfiguration.AudioInfoTagOrder), Lockable = true, Reach = SettingReach.Both, NullInheritsAdmin = true,
            AdminRowKey = nameof(PluginConfiguration.AudioInfoTagOrder), Min = 1, Max = 6)]
        public int? AudioInfoTagOrder { get; set; }
        [UserSetting(nameof(PluginConfiguration.GenreTagsEnabled), Lockable = true, Reach = SettingReach.Both)]
        public bool GenreTagsEnabled { get; set; }
        [UserSetting(nameof(PluginConfiguration.LanguageTagsEnabled), Lockable = true, Reach = SettingReach.Both)]
        public bool LanguageTagsEnabled { get; set; }
        [UserSetting(nameof(PluginConfiguration.RatingTagsEnabled), Lockable = true, Reach = SettingReach.Both)]
        public bool RatingTagsEnabled { get; set; }
        [UserSetting(nameof(PluginConfiguration.AgeRatingTagsEnabled), Lockable = true, Reach = SettingReach.Both)]
        public bool AgeRatingTagsEnabled { get; set; }
        [UserSetting(nameof(PluginConfiguration.PeopleTagsEnabled), Lockable = true)]
        public bool PeopleTagsEnabled { get; set; }
        [UserSetting(nameof(PluginConfiguration.TagsHideOnHover), Lockable = true)]
        public bool TagsHideOnHover { get; set; }
        [UserSetting(nameof(PluginConfiguration.QualityTagsPosition), Lockable = true, Reach = SettingReach.Both, EmptyInheritsAdmin = true,
            Choices = new[] { "", "top-left", "top-right", "bottom-left", "bottom-right" })]
        public string QualityTagsPosition { get; set; } = "top-left";
        // Audio language the sound tag is judged by: "" = server default,
        // "auto" = the user's Jellyfin audio language, "none" = no preference,
        // otherwise an ISO 639 code.
        [UserSetting(nameof(PluginConfiguration.QualityTagsPreferredAudioLanguage), Lockable = true, Reach = SettingReach.Both, EmptyInheritsAdmin = true,
            DefaultIsSentinel = true, MaxLength = 64)]
        public string QualityTagsPreferredAudioLanguage { get; set; } = string.Empty;
        [UserSetting(nameof(PluginConfiguration.GenreTagsPosition), Lockable = true, Reach = SettingReach.Both, EmptyInheritsAdmin = true,
            Choices = new[] { "", "top-left", "top-right", "bottom-left", "bottom-right" })]
        public string GenreTagsPosition { get; set; } = "top-right";
        [UserSetting(nameof(PluginConfiguration.LanguageTagsPosition), Lockable = true, Reach = SettingReach.Both, EmptyInheritsAdmin = true,
            Choices = new[] { "", "top-left", "top-right", "bottom-left", "bottom-right" })]
        public string LanguageTagsPosition { get; set; } = "bottom-left";
        [UserSetting(nameof(PluginConfiguration.RatingTagsPosition), Lockable = true, Reach = SettingReach.Both, EmptyInheritsAdmin = true,
            Choices = new[] { "", "top-left", "top-right", "bottom-left", "bottom-right" })]
        public string RatingTagsPosition { get; set; } = "bottom-right";
        [UserSetting(nameof(PluginConfiguration.RatingTagsOnMovies), Lockable = true, Reach = SettingReach.Both)]
        public bool RatingTagsOnMovies { get; set; } = true;
        [UserSetting(nameof(PluginConfiguration.RatingTagsOnSeries), Lockable = true, Reach = SettingReach.Both)]
        public bool RatingTagsOnSeries { get; set; } = true;
        [UserSetting(nameof(PluginConfiguration.RatingTagsOnSeasons), Lockable = true, Reach = SettingReach.Both)]
        public bool RatingTagsOnSeasons { get; set; } = true;
        [UserSetting(nameof(PluginConfiguration.RatingTagsOnEpisodes), Lockable = true, Reach = SettingReach.Both)]
        public bool RatingTagsOnEpisodes { get; set; } = true;
        [UserSetting(nameof(PluginConfiguration.RatingTagsOnContinueWatching), Lockable = true, Reach = SettingReach.Both)]
        public bool RatingTagsOnContinueWatching { get; set; } = true;
        [UserSetting(nameof(PluginConfiguration.RatingTagsOnNextUp), Lockable = true, Reach = SettingReach.Both)]
        public bool RatingTagsOnNextUp { get; set; } = true;
        [UserSetting(nameof(PluginConfiguration.AgeRatingTagsPosition), Lockable = true, Reach = SettingReach.Both, EmptyInheritsAdmin = true,
            Choices = new[] { "", "top-left", "top-right", "bottom-left", "bottom-right" })]
        public string AgeRatingTagsPosition { get; set; } = "bottom-right";
        [UserSetting(nameof(PluginConfiguration.ShowRatingInPlayer), Lockable = true)]
        public bool ShowRatingInPlayer { get; set; } = true;
        [UserSetting(nameof(PluginConfiguration.RemoveContinueWatchingEnabled), Lockable = true)]
        public bool RemoveContinueWatchingEnabled { get; set; }
        // Device-local panel state, not a registry key (UserSettingsRegistry.NotRegistered).
        public string LastOpenedTab { get; set; } = string.Empty;
        [UserSetting(nameof(PluginConfiguration.ReviewsExpandedByDefault), Lockable = true, Incidental = true)]
        public bool ReviewsExpandedByDefault { get; set; }
        [UserSetting(nameof(PluginConfiguration.DefaultLanguage), Lockable = true, AdminControlId = nameof(PluginConfiguration.DefaultLanguage), MaxLength = 64)]
        public string DisplayLanguage { get; set; } = string.Empty;
        [UserSetting(Inheritable = false, Choices = new[] { "list", "backdrop", "cards" })]
        public string CalendarDisplayMode { get; set; } = "list";
        [UserSetting(Inheritable = false, Choices = new[] { "agenda", "month", "week", "day" })]
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
        // Advanced per-category reveals (admin default: SpoilerAdvancedMode).
        // Unlike the per-field opt-outs above, `false` here is the STRICTER
        // choice: it opts this user out of the category reveals entirely,
        // restoring the uniform full strip. null = inherit the admin mode;
        // true is recorded but never enables the mode when the admin has it
        // off (the admin switch still gates everything).
        public bool? UseAdvancedCategories { get; set; }
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
        public int? SeasonNumber { get; set; }
        public int? EpisodeNumber { get; set; }
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
        public bool SeasonProviders { get; set; } = true;
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
        /// <summary>Optional rating, 1–5 in 0.5 increments.</summary>
        public double? Rating { get; set; }
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

    /// <summary>
    /// A single "recently watched" or "recently favorited" activity record for
    /// the Activity Feed. One entry per (user, item, type). Re-watching bumps
    /// OccurredAt; favorites keep their timestamp until removed and re-added.
    /// </summary>
    public class ActivityEntry
    {
        /// <summary>Jellyfin user ID in N format (no dashes).</summary>
        public string UserId { get; set; } = string.Empty;
        /// <summary>Jellyfin item ID in N format (no dashes).</summary>
        public string ItemId { get; set; } = string.Empty;
        /// <summary>"Watched" or "Favorited".</summary>
        public string ActivityType { get; set; } = string.Empty;
        public string OccurredAt { get; set; } = string.Empty;
        /// <summary>
        /// Watched-only: whether this watch was ever played to completion.
        /// A "Watched" entry is first recorded once playback crosses the
        /// threshold in ActivityPlaybackConsumer (started, not necessarily
        /// finished); a later full watch upgrades this to true. Never
        /// downgraded once set -- a partial re-watch after finishing once
        /// shouldn't erase that it was completed.
        /// </summary>
        public bool Completed { get; set; }
        /// <summary>
        /// Watched-only: highest fraction (0.0-1.0) of the item's runtime
        /// ever observed played, across all sessions -- never downgraded, so
        /// a partial re-watch after a deeper watch doesn't roll this back.
        /// </summary>
        public double Progress { get; set; }
    }

    /// <summary>
    /// Server-wide store of watched/favorited activity, keyed by
    /// "{userIdN}:{itemIdN}:{activityType}". Stored in a single shared file
    /// (activity.json) at the plugin config root. Reviews are NOT duplicated
    /// here -- the Activity Feed reads those live from AllReviewsStore.
    /// </summary>
    public class AllActivityStore
    {
        public Dictionary<string, ActivityEntry> Entries { get; set; } = new Dictionary<string, ActivityEntry>();
    }
}
