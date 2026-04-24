using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Model.Arr;
using MediaBrowser.Model.Plugins;

namespace Jellyfin.Plugin.JellyfinEnhanced.Configuration
{
    public class Shortcut
    {
        public string Name { get; set; } = string.Empty;
        public string Key { get; set; } = string.Empty;
        public string Label { get; set; } = string.Empty;
        public string Category { get; set; } = string.Empty;
    }
    public class PluginConfiguration : BasePluginConfiguration
    {
        public PluginConfiguration()
        {
            // Jellyfin Enhanced Settings
            ToastDuration = 1500;
            HelpPanelAutocloseDelay = 15000;
            EnableCustomSplashScreen = false;
            SplashScreenImageUrl = "/web/assets/img/banner-light.png";

            // Jellyfin Elsewhere Settings
            ElsewhereEnabled = true;
            TMDB_API_KEY = "";
            DEFAULT_REGION = "US";
            DEFAULT_PROVIDERS = "";
            IGNORE_PROVIDERS = "";
            ElsewhereCustomBrandingText = "";
            ElsewhereCustomBrandingImageUrl = "";

            ClearLocalStorageTimestamp = 0;
            ClearTranslationCacheTimestamp = 0;

            // Default User Settings
            AutoPauseEnabled = true;
            AutoResumeEnabled = false;
            AutoPipEnabled = false;
            AutoSkipIntro = false;
            AutoSkipOutro = false;
            LongPress2xEnabled = false;
            RandomButtonEnabled = true;
            RandomIncludeMovies = true;
            RandomIncludeShows = true;
            RandomUnwatchedOnly = false;
            ShowWatchProgress = false;
            WatchProgressDefaultMode = "percentage";
            WatchProgressTimeFormat = "hours";
            ShowFileSizes = false;
            RemoveContinueWatchingEnabled = false;
            ShowAudioLanguages = true;
            ShowReviews = false;
            ShowUserReviews = false;
            ReviewsExpandedByDefault = false;
            HideReviewsFromHiddenUsers = true;
            HideReviewsFromDisabledUsers = true;
            PauseScreenEnabled = true;
            QualityTagsEnabled = false;
            GenreTagsEnabled = false;
            LanguageTagsEnabled = false;
            RatingTagsEnabled = false;
            PeopleTagsEnabled = false;
            TagsCacheTtlDays = 30;
            DisableTagsOnSearchPage = false;
            TagsHideOnHover = false;
            TagCacheServerMode = true;
            EnableTagsLocalStorageFallback = false;
            QualityTagsPosition = "top-left";
            GenreTagsPosition = "top-right";
            LanguageTagsPosition = "bottom-left";
            RatingTagsPosition = "bottom-right";
            ShowRatingInPlayer = true;
            DisableAllShortcuts = false;
            DefaultSubtitleStyle = 0;
            DefaultSubtitleSize = 2;
            DefaultSubtitleFont = 0;
            DisableCustomSubtitleStyles = false;
            DefaultLanguage = string.Empty;
            Shortcuts = new List<Shortcut>
            {
                new Shortcut { Name = "OpenSearch", Key = "/", Label = "Open Search", Category = "Global" },
                new Shortcut { Name = "GoToHome", Key = "Shift+H", Label = "Go to Home", Category = "Global" },
                new Shortcut { Name = "GoToDashboard", Key = "D", Label = "Go to Dashboard", Category = "Global" },
                new Shortcut { Name = "QuickConnect", Key = "Q", Label = "Quick Connect", Category = "Global" },
                new Shortcut { Name = "PlayRandomItem", Key = "R", Label = "Play Random Item", Category = "Global" },
                new Shortcut { Name = "CycleAspectRatio", Key = "A", Label = "Cycle Aspect Ratio", Category = "Player" },
                new Shortcut { Name = "ShowPlaybackInfo", Key = "I", Label = "Show Playback Info", Category = "Player" },
                new Shortcut { Name = "SubtitleMenu", Key = "S", Label = "Subtitle Menu", Category = "Player" },
                new Shortcut { Name = "CycleSubtitleTracks", Key = "C", Label = "Cycle Subtitle Tracks", Category = "Player" },
                new Shortcut { Name = "CycleAudioTracks", Key = "V", Label = "Cycle Audio Tracks", Category = "Player" },
                new Shortcut { Name = "IncreasePlaybackSpeed", Key = "+", Label = "Increase Playback Speed", Category = "Player" },
                new Shortcut { Name = "DecreasePlaybackSpeed", Key = "-", Label = "Decrease Playback Speed", Category = "Player" },
                new Shortcut { Name = "ResetPlaybackSpeed", Key = "R", Label = "Reset Playback Speed", Category = "Player" },
                new Shortcut { Name = "BookmarkCurrentTime", Key = "B", Label = "Bookmark Current Time", Category = "Player" },
                new Shortcut { Name = "OpenEpisodePreview", Key = "P", Label = "Open Episode Preview", Category = "Player" },
                new Shortcut { Name = "SkipIntroOutro", Key = "O", Label = "Skip Intro/Outro", Category = "Player" }
            };

            // Seerr Search Settings
            JellyseerrEnabled = false;
            JellyseerrShowSearchResults = true;
            JellyseerrShowReportButton = false;
            JellyseerrShowIssueIndicator = false;
            JellyseerrEnable4KRequests = false;
            JellyseerrEnable4KTvRequests = false;
            JellyseerrShowAdvanced = false;
            JellyseerrShowSimilar = true;
            JellyseerrShowRecommended = true;
            JellyseerrShowRequestMoreOnSeries = true;
            JellyseerrShowNetworkDiscovery = true;
            JellyseerrShowGenreDiscovery = true;
            JellyseerrShowTagDiscovery = true;
            JellyseerrShowPersonDiscovery = true;
            JellyseerrShowCollectionDiscovery = true;
            ShowElsewhereOnJellyseerr = false;
            JellyseerrUseMoreInfoModal = false;
            JellyseerrUrls = "";
            JellyseerrApiKey = "";
            JellyseerrUrlMappings = "";
            ShowCollectionsInSearch = true;
            JellyseerrDisableCache = false;
            JellyseerrResponseCacheTtlMinutes = 10;
            JellyseerrUserIdCacheTtlMinutes = 30;

            // Arr Links Settings
            ArrLinksEnabled = false;
            SonarrUrl = "";
            RadarrUrl = "";
            BazarrUrl = "";
            ShowArrLinksAsText = false;
            ArrLinksShowStatusSingle = false;
            SonarrUrlMappings = "";
            RadarrUrlMappings = "";
            BazarrUrlMappings = "";

            // Multi-Instance Sonarr/Radarr Support
            SonarrInstances = "[]";
            RadarrInstances = "[]";

            // Arr Tags Sync Settings
            ArrTagsSyncEnabled = false;
            SonarrApiKey = "";
            RadarrApiKey = "";
            ArrTagsPrefix = "JE Arr Tag: ";
            ArrTagsClearOldTags = true;
            ArrTagsShowAsLinks = true;
            ArrTagsLinksFilter = "";
            ArrTagsLinksHideFilter = "";
            ArrTagsSyncFilter = "";

            // Letterboxd Settings
            LetterboxdEnabled = false;
            ShowLetterboxdLinkAsText = false;

            // Metadata Icons (Druidblack)
            MetadataIconsEnabled = false;

            // Auto Season Request Settings
            AutoSeasonRequestEnabled = false;
            AutoSeasonRequestThresholdValue = 2; // Number of episodes remaining to trigger request
            AutoSeasonRequestRequireAllWatched = false; // Require all episodes in current season to be watched

            // Auto Movie Request Settings
            AutoMovieRequestEnabled = false;
            AutoMovieRequestTriggerType = "OnMinutesWatched"; // "OnStart", "OnMinutesWatched", or "Both"
            AutoMovieRequestMinutesWatched = 20; // Minutes to watch before triggering request
            AutoMovieRequestCheckReleaseDate = true; // Only request if movie is already released
            AutoMovieRequestQualityMode = "default"; // "default", "original", or "custom"
            AutoMovieRequestCustomServerId = -1; // Radarr server ID for "custom" mode (-1 = not set)
            AutoMovieRequestCustomProfileId = 0; // Quality profile ID for "custom" mode
            AutoMovieRequestCustomRootFolder = ""; // Root folder path for "custom" mode
            AutoMovieRequestFallbackOn4k = true; // When original mode finds a 4K profile, fall back to default instead

            // Watchlist Settings
            AddRequestedMediaToWatchlist = false;
            SyncJellyseerrWatchlist = false;
            PreventWatchlistReAddition = true;
            WatchlistMemoryRetentionDays = 365;

            // Bookmarks Settings
            BookmarksEnabled = true;
            BookmarksUsePluginPages = false;
            BookmarksUseCustomTabs = false;
            BookmarksAutoCreateCustomTab = false;
            BookmarksCustomTabJeOwned = false;

            // Icon Settings
            UseIcons = true;
            IconStyle = "emoji";

            // Extras Settings
            ColoredRatingsEnabled = false;
            ThemeSelectorEnabled = false;
            ColoredActivityIconsEnabled = false;
            PluginIconsEnabled = false;
            EnableLoginImage = false;
            CustomPluginLinks = "";
            ActiveStreamsEnabled = false;
            ActiveStreamsAllUsers = false;

            // Requests Page Settings (Sonarr/Radarr Queue Monitoring)
            DownloadsPageEnabled = false;
            DownloadsUsePluginPages = false;
            DownloadsUseCustomTabs = false;
            DownloadsAutoCreateCustomTab = false;
            DownloadsCustomTabJeOwned = false;
            DownloadsPagePollingEnabled = true;
            DownloadsPollIntervalSeconds = 30;
            DownloadsPageShowIssues = false;
            ShowDownloadsInRequests = true;
            DownloadsFilterByUserRequests = true;

            // Calendar Page Settings (Sonarr/Radarr Releases)
            CalendarPageEnabled = false;
            CalendarUsePluginPages = false;
            CalendarUseCustomTabs = false;
            CalendarAutoCreateCustomTab = false;
            CalendarCustomTabJeOwned = false;
            CalendarFirstDayOfWeek = "Monday";
            CalendarTimeFormat = "5pm/5:30pm";
            CalendarHighlightFavorites = false;
            CalendarHighlightWatchedSeries = false;
            CalendarFilterByLibraryAccess = true;
            CalendarShowOnlyRequested = false;
            CalendarForceOnlyRequested = false;

            // Hidden Content Settings
            HiddenContentEnabled = false;
            HiddenContentUsePluginPages = false;
            HiddenContentUseCustomTabs = false;
            HiddenContentAutoCreateCustomTab = false;
            HiddenContentCustomTabJeOwned = false;
        }

        // Jellyfin Enhanced Settings
        public int ToastDuration { get; set; }
        public int HelpPanelAutocloseDelay { get; set; }
        public bool EnableCustomSplashScreen { get; set; }
        public string SplashScreenImageUrl { get; set; }


        // Jellyfin Elsewhere Settings
        public bool ElsewhereEnabled { get; set; }
        public string TMDB_API_KEY { get; set; }
        public string DEFAULT_REGION { get; set; }
        public string DEFAULT_PROVIDERS { get; set; }
        public string IGNORE_PROVIDERS { get; set; }
        public string ElsewhereCustomBrandingText { get; set; }
        public string ElsewhereCustomBrandingImageUrl { get; set; }
        public long ClearLocalStorageTimestamp { get; set; }
        public long ClearTranslationCacheTimestamp { get; set; }

        // Default User Settings
        public bool AutoPauseEnabled { get; set; }
        public bool AutoResumeEnabled { get; set; }
        public bool AutoPipEnabled { get; set; }
        public bool AutoSkipIntro { get; set; }
        public bool AutoSkipOutro { get; set; }
        public bool LongPress2xEnabled { get; set; }
        public bool RandomButtonEnabled { get; set; }
        public bool RandomIncludeMovies { get; set; }
        public bool RandomIncludeShows { get; set; }
        public bool RandomUnwatchedOnly { get; set; }
        public bool ShowWatchProgress { get; set; }
        public string WatchProgressDefaultMode { get; set; }
        public string WatchProgressTimeFormat { get; set; }
        public bool ShowFileSizes { get; set; }
        public bool RemoveContinueWatchingEnabled { get; set; }
        public bool ShowAudioLanguages { get; set; }
        public bool ShowReviews { get; set; }
        public bool ShowUserReviews { get; set; }
        public bool ReviewsExpandedByDefault { get; set; }
        public bool HideReviewsFromHiddenUsers { get; set; } = true;
        public bool HideReviewsFromDisabledUsers { get; set; } = true;
        public List<Shortcut> Shortcuts { get; set; }
        public bool PauseScreenEnabled { get; set; }
        public int PauseScreenDelaySeconds { get; set; } = 5;
        public bool QualityTagsEnabled { get; set; }
        public bool LanguageTagsEnabled { get; set; }
        public bool RatingTagsEnabled { get; set; }
        public bool PeopleTagsEnabled { get; set; }
        public int TagsCacheTtlDays { get; set; }
        public bool DisableTagsOnSearchPage { get; set; }
        public bool TagsHideOnHover { get; set; }
        public bool TagCacheServerMode { get; set; }
        public bool EnableTagsLocalStorageFallback { get; set; }
        public bool DisableAllShortcuts { get; set; }
        public int DefaultSubtitleStyle { get; set; }
        public int DefaultSubtitleSize { get; set; }
        public int DefaultSubtitleFont { get; set; }
        public bool DisableCustomSubtitleStyles { get; set; }
        public string QualityTagsPosition { get; set; } = "top-left";
        public string GenreTagsPosition { get; set; } = "top-right";
        public string LanguageTagsPosition { get; set; } = "bottom-left";
        public string RatingTagsPosition { get; set; } = "bottom-right";
        public bool ShowRatingInPlayer { get; set; } = true;
        public bool GenreTagsEnabled { get; set; }
        public string DefaultLanguage { get; set; }

        // Seerr Search Settings
        public bool JellyseerrEnabled { get; set; }
        public bool JellyseerrShowSearchResults { get; set; }
        public bool JellyseerrShowReportButton { get; set; }
        public bool JellyseerrShowIssueIndicator { get; set; }
        public bool JellyseerrEnable4KRequests { get; set; }
        public bool JellyseerrEnable4KTvRequests { get; set; }
        public bool JellyseerrShowAdvanced { get; set; }
        public bool JellyseerrShowSimilar { get; set; }
        public bool JellyseerrShowRecommended { get; set; }
        public bool JellyseerrShowRequestMoreOnSeries { get; set; }
        public bool JellyseerrShowNetworkDiscovery { get; set; }
        public bool JellyseerrShowGenreDiscovery { get; set; }
        public bool JellyseerrShowTagDiscovery { get; set; }
        public bool JellyseerrShowPersonDiscovery { get; set; }
        public bool JellyseerrShowCollectionDiscovery { get; set; }
        public bool JellyseerrExcludeLibraryItems { get; set; } = true;
        public bool JellyseerrExcludeBlocklistedItems { get; set; } = false;
        public bool ShowElsewhereOnJellyseerr { get; set; }
        public bool JellyseerrUseMoreInfoModal { get; set; } = false;
        public string JellyseerrUrls { get; set; }
        public string JellyseerrApiKey { get; set; }
        public string JellyseerrUrlMappings { get; set; }
        public bool ShowCollectionsInSearch { get; set; }
        public bool JellyseerrDisableCache { get; set; }
        public int JellyseerrResponseCacheTtlMinutes { get; set; }
        public int JellyseerrUserIdCacheTtlMinutes { get; set; }

        // Arr Links Settings
        public bool ArrLinksEnabled { get; set; }
        public string SonarrUrl { get; set; }
        public string RadarrUrl { get; set; }
        public string BazarrUrl { get; set; }
        public bool ShowArrLinksAsText { get; set; }
        /// <summary>
        /// When true, single-instance arr links show the status color border + episode count badge
        /// (same as multi-instance dropdowns). When false (default), single-instance links render
        /// as a plain icon/text so the Jellyfin detail page isn't cluttered with status pills when
        /// only one Sonarr/Radarr is configured. Multi-instance dropdowns always show status
        /// regardless of this flag since distinguishing instances is the whole point there.
        /// </summary>
        public bool ArrLinksShowStatusSingle { get; set; }
        public string SonarrUrlMappings { get; set; }
        public string RadarrUrlMappings { get; set; }
        public string BazarrUrlMappings { get; set; }

        // Multi-Instance Sonarr/Radarr Support (JSON arrays of ArrInstance)
        public string SonarrInstances { get; set; } = "[]";
        public string RadarrInstances { get; set; } = "[]";

        // Arr Tags Sync Settings
        public bool ArrTagsSyncEnabled { get; set; }
        public string SonarrApiKey { get; set; }
        public string RadarrApiKey { get; set; }
        public string ArrTagsPrefix { get; set; }
        public bool ArrTagsClearOldTags { get; set; }
        public bool ArrTagsShowAsLinks { get; set; }
        public string ArrTagsLinksFilter { get; set; }
        public string ArrTagsLinksHideFilter { get; set; }
        public string ArrTagsSyncFilter { get; set; }

        // Letterboxd Settings
        public bool LetterboxdEnabled { get; set; }
        public bool ShowLetterboxdLinkAsText { get; set; }

        // Metadata Icons (Druidblack)
        public bool MetadataIconsEnabled { get; set; }

        // Auto Season Request Settings
        public bool AutoSeasonRequestEnabled { get; set; }
        public int AutoSeasonRequestThresholdValue { get; set; }
        public bool AutoSeasonRequestRequireAllWatched { get; set; }

        // Auto Movie Request Settings
        public bool AutoMovieRequestEnabled { get; set; }
        public string AutoMovieRequestTriggerType { get; set; } // "OnStart", "OnMinutesWatched", or "Both"
        public int AutoMovieRequestMinutesWatched { get; set; } // Minutes to watch before triggering request
        public bool AutoMovieRequestCheckReleaseDate { get; set; } // Only request if movie is already released
        public string AutoMovieRequestQualityMode { get; set; } // "default", "original", or "custom"
        public int AutoMovieRequestCustomServerId { get; set; } // Radarr server ID for "custom" mode
        public int AutoMovieRequestCustomProfileId { get; set; } // Quality profile ID for "custom" mode
        public string AutoMovieRequestCustomRootFolder { get; set; } // Root folder path for "custom" mode
        public bool AutoMovieRequestFallbackOn4k { get; set; } // When original mode finds a 4K profile, fall back to default

        // Watchlist Settings
        public bool AddRequestedMediaToWatchlist { get; set; }
        public bool SyncJellyseerrWatchlist { get; set; }
        public bool PreventWatchlistReAddition { get; set; }
        public int WatchlistMemoryRetentionDays { get; set; }

        // User Import Settings
        public bool JellyseerrAutoImportUsers { get; set; }
        public string JellyseerrImportBlockedUsers { get; set; } = string.Empty;

        // Bookmarks Settings
        public bool BookmarksEnabled { get; set; }
        public bool BookmarksUsePluginPages { get; set; }
        public bool BookmarksUseCustomTabs { get; set; }
        /// <summary>
        /// When true (and the Custom Tabs plugin is detected with a recognized
        /// config schema), Jellyfin Enhanced will manage the corresponding
        /// Custom Tabs entry: creating it when <see cref="BookmarksUseCustomTabs"/>
        /// is enabled and removing it when disabled. The toggle in the UI is
        /// only shown when both conditions hold; it is silently ignored otherwise.
        /// </summary>
        public bool BookmarksAutoCreateCustomTab { get; set; }

        /// <summary>
        /// True if Jellyfin Enhanced created the corresponding Custom Tabs entry
        /// (set when sync ADDs an entry; cleared when sync REMOVES one). Sync uses
        /// this flag to ensure it never deletes a Custom Tabs entry the admin
        /// created manually. Hidden field — no UI; managed entirely by saveConfig.
        /// </summary>
        public bool BookmarksCustomTabJeOwned { get; set; }

        // Icon Settings
        public bool UseIcons { get; set; }
        public string IconStyle { get; set; }

        // Extras Settings
        public bool ColoredRatingsEnabled { get; set; }
        public bool ThemeSelectorEnabled { get; set; }
        public bool ColoredActivityIconsEnabled { get; set; }
        public bool PluginIconsEnabled { get; set; }
        public bool EnableLoginImage { get; set; }
        public string CustomPluginLinks { get; set; }
        public bool ActiveStreamsEnabled { get; set; }
        public bool ActiveStreamsAllUsers { get; set; }

        // Requests Page Settings (Sonarr/Radarr Queue Monitoring)
        public bool DownloadsPageEnabled { get; set; }
        public bool DownloadsUsePluginPages { get; set; }
        public bool DownloadsUseCustomTabs { get; set; }
        public bool DownloadsAutoCreateCustomTab { get; set; }
        public bool DownloadsCustomTabJeOwned { get; set; }
        public bool DownloadsPagePollingEnabled { get; set; }
        public int DownloadsPollIntervalSeconds { get; set; }
        public bool DownloadsPageShowIssues { get; set; }
        public bool ShowDownloadsInRequests { get; set; }
        public bool DownloadsFilterByUserRequests { get; set; }

        // Calendar Page Settings (Sonarr/Radarr Releases)
        public bool CalendarPageEnabled { get; set; }
        public bool CalendarUseCustomTabs { get; set; }
        public bool CalendarUsePluginPages { get; set; }
        public bool CalendarAutoCreateCustomTab { get; set; }
        public bool CalendarCustomTabJeOwned { get; set; }
        public string CalendarFirstDayOfWeek { get; set; }
        public string CalendarTimeFormat { get; set; }
        public bool CalendarHighlightFavorites { get; set; }
        public bool CalendarHighlightWatchedSeries { get; set; }
        public bool CalendarFilterByLibraryAccess { get; set; }
        public bool CalendarShowOnlyRequested { get; set; }
        public bool CalendarForceOnlyRequested { get; set; }

        // Hidden Content Settings
        public bool HiddenContentEnabled { get; set; }
        public bool HiddenContentUsePluginPages { get; set; }
        public bool HiddenContentUseCustomTabs { get; set; }
        public bool HiddenContentAutoCreateCustomTab { get; set; }
        public bool HiddenContentCustomTabJeOwned { get; set; }

        /// <summary>
        /// Returns configured Sonarr instances, falling back to legacy single-instance fields for migration.
        /// Legacy fallback runs ONLY when the stored JSON is explicitly empty; if it is corrupt (unparseable),
        /// returns an empty list without synthesizing an instance from legacy fields — the caller should
        /// surface this via <see cref="SonarrInstancesCorrupt"/> and refuse to overwrite on save.
        /// </summary>
        public List<ArrInstance> GetSonarrInstances()
        {
            var parsed = TryDeserializeInstances(SonarrInstances, out var parseResult);
            if (parsed.Count > 0)
                return parsed;

            if (parseResult == InstanceParseResult.ExplicitlyEmpty
                && !string.IsNullOrWhiteSpace(SonarrUrl)
                && !string.IsNullOrWhiteSpace(SonarrApiKey))
            {
                return new List<ArrInstance>
                {
                    new ArrInstance
                    {
                        Name = "Sonarr",
                        Url = SonarrUrl,
                        ApiKey = SonarrApiKey,
                        UrlMappings = SonarrUrlMappings ?? ""
                    }
                };
            }

            return parsed;
        }

        /// <summary>
        /// Returns configured Radarr instances, falling back to legacy single-instance fields for migration.
        /// Same corruption-aware semantics as <see cref="GetSonarrInstances"/>.
        /// </summary>
        public List<ArrInstance> GetRadarrInstances()
        {
            var parsed = TryDeserializeInstances(RadarrInstances, out var parseResult);
            if (parsed.Count > 0)
                return parsed;

            if (parseResult == InstanceParseResult.ExplicitlyEmpty
                && !string.IsNullOrWhiteSpace(RadarrUrl)
                && !string.IsNullOrWhiteSpace(RadarrApiKey))
            {
                return new List<ArrInstance>
                {
                    new ArrInstance
                    {
                        Name = "Radarr",
                        Url = RadarrUrl,
                        ApiKey = RadarrApiKey,
                        UrlMappings = RadarrUrlMappings ?? ""
                    }
                };
            }

            return parsed;
        }

        /// <summary>
        /// Subset of <see cref="GetSonarrInstances"/> limited to instances the admin has not
        /// toggled off. Fan-out callers (controller endpoints, scheduled tag sync) should use
        /// this so disabled instances are skipped without being removed from the stored config.
        /// </summary>
        public List<ArrInstance> GetEnabledSonarrInstances()
            => GetSonarrInstances().Where(i => i.Enabled).ToList();

        /// <summary>Enabled-only subset of <see cref="GetRadarrInstances"/>; see Sonarr variant.</summary>
        public List<ArrInstance> GetEnabledRadarrInstances()
            => GetRadarrInstances().Where(i => i.Enabled).ToList();

        /// <summary>True when <see cref="SonarrInstances"/> contains JSON that could not be parsed.</summary>
        public bool IsSonarrInstancesCorrupt()
        {
            _ = TryDeserializeInstances(SonarrInstances, out var r);
            return r == InstanceParseResult.Corrupt;
        }

        /// <summary>True when <see cref="RadarrInstances"/> contains JSON that could not be parsed.</summary>
        public bool IsRadarrInstancesCorrupt()
        {
            _ = TryDeserializeInstances(RadarrInstances, out var r);
            return r == InstanceParseResult.Corrupt;
        }

        private enum InstanceParseResult { ExplicitlyEmpty, Parsed, Corrupt }

        private static List<ArrInstance> TryDeserializeInstances(string? json, out InstanceParseResult result)
        {
            if (string.IsNullOrWhiteSpace(json))
            {
                result = InstanceParseResult.ExplicitlyEmpty;
                return new List<ArrInstance>();
            }

            // Note: do NOT short-circuit on `json.StartsWith("[]")` — a value like `[]junk`
            // or `[]\n{...}` is corrupt JSON but would pass that check and silently downgrade
            // to ExplicitlyEmpty, re-enabling the legacy fallback. Always run it through the
            // real parser and classify as Corrupt on any JsonException.

            try
            {
                var instances = JsonSerializer.Deserialize<List<ArrInstance>>(json) ?? new List<ArrInstance>();
                // Drop null entries AND entries with empty URL or API key. System.Text.Json happily
                // accepts `[null]` as a one-element list containing null (verified empirically);
                // without this guard the predicate below dereferences the null and throws NRE,
                // which would bypass this classifier entirely and 500 every caller. If the stored
                // array was itself empty OR every entry got dropped, treat as ExplicitlyEmpty so
                // the legacy SonarrUrl/SonarrApiKey fallback still runs — otherwise an admin with
                // only an invalid row would silently lose the migration path.
                var filtered = instances
                    .Where(i => i != null
                        && !string.IsNullOrWhiteSpace(i.Url)
                        && !string.IsNullOrWhiteSpace(i.ApiKey))
                    .ToList();
                result = filtered.Count == 0 ? InstanceParseResult.ExplicitlyEmpty : InstanceParseResult.Parsed;
                return filtered;
            }
            catch (JsonException)
            {
                result = InstanceParseResult.Corrupt;
                return new List<ArrInstance>();
            }
        }
    }
}
