using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Model;
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
    public partial class PluginConfiguration : BasePluginConfiguration
    {
        public PluginConfiguration()
        {
            // Jellyfin Enhanced Settings
            ToastDuration = 1500;
            HelpPanelAutocloseDelay = 15000;
            EnableCustomSplashScreen = false;

            // Request-time injection middleware (script + branding). Enabled
            // by default; the flags are kill-switches for troubleshooting.
            DisableScriptInjectionMiddleware = false;
            DisableBrandingMiddleware = false;

            // Maintenance Mode
            MaintenanceModeEnabled = false;
            MaintenanceModeMessage = "This server is currently undergoing maintenance. Please try again.";
            MaintenanceModeNotificationMessage = "Server undergoing maintenance.";
            MaintenanceModeAction = "disable_accounts";
            MaintenanceModeAffectedUsers = "all";
            MaintenanceModeDurationMinutes = 0;
            MaintenanceModeRemindOnPlayback = false;
            MaintenanceScheduleEnabled = false;
            MaintenanceScheduleStart = "00:00";
            MaintenanceScheduleEnd = "08:00";
            MaintenanceScheduleMessage = "The library is updating; slowdowns are normal. Time remaining: {countdown}";
            MaintenanceScheduleNotificationMessage = "The library is updating; slowdowns are normal.";
            MaintenanceScheduleAction = "none";
            SplashScreenImageUrl = "/web/assets/img/banner-light.png";
            DevMode = false;

            // Jellyfin Elsewhere Settings
            ElsewhereEnabled = true;
            TMDB_API_KEY = "";
            DEFAULT_REGION = "US";
            DEFAULT_PROVIDERS = "";
            IGNORE_PROVIDERS = "";
            ElsewhereSeasonProviders = true;
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
            RandomScopeCurrentContainer = false;
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
            MirrorReviewRatingsToJellyfin = false;
            ShowAwards = false;
            DoesTheDogDieEnabled = false;
            DoesTheDogDieApiKey = "";
            MdblistApiKey = "";
            MdblistRatingsEnabled = false;
            MdblistRatingsShowOnItemDetails = true;
            MdblistRatingsFetchEnabled = false;
            MdblistRatingsAutoSyncEnabled = false;
            MdblistRatingsOverwriteExisting = false;
            MdblistFetchReserve = 400;
            MdblistRatingsSources = "";
            MdblistRatingsShowPercentSymbol = false;
            ShowReleaseDates = false;
            ShowUserRatingOnPosters = false;
            ShowUserRatingDash = true;
            PauseScreenEnabled = true;
            ShowPlaybackRatingBadge = false;
            QualityTagsEnabled = false;
            ShowResolutionTag = true;
            ShowSourceTag = true;
            ShowDynamicRangeTag = true;
            ShowSpecialFormatTag = true;
            ShowVideoCodecTag = true;
            ShowAudioInfoTag = true;
            ResolutionTagOrder = 1;
            SourceTagOrder = 2;
            DynamicRangeTagOrder = 3;
            SpecialFormatTagOrder = 4;
            VideoCodecTagOrder = 5;
            AudioInfoTagOrder = 6;
            GenreTagsEnabled = false;
            LanguageTagsEnabled = false;
            RatingTagsEnabled = false;
            AgeRatingTagsEnabled = false;
            PeopleTagsEnabled = false;
            NativePosterTagsEnabled = false;
            NativePosterTagsWebClientNames = string.Empty;
            TagStyleOverrides = string.Empty;
            TagStyleTarget = "both";
            TagStylePreset = "default";
            TagStyleApplyScope = "all";
            TagsCacheTtlDays = 30;
            DisableTagsOnSearchPage = false;
            TagsHideOnHover = false;
            TagCacheServerMode = true;
            EnableTagsLocalStorageFallback = false;
            QualityTagsPosition = "top-left";
            GenreTagsPosition = "top-right";
            LanguageTagsPosition = "bottom-left";
            LanguageTagsPriority = string.Empty;
            LanguageTagsPriorityStrict = false;
            QualityTagsPreferredAudioLanguage = string.Empty;
            QualityTagsAudioLanguageFromUser = false;
            RatingTagsPosition = "bottom-right";
            RatingTagsOnMovies = true;
            RatingTagsOnSeries = true;
            RatingTagsOnSeasons = true;
            RatingTagsOnEpisodes = true;
            RatingTagsOnContinueWatching = true;
            RatingTagsOnNextUp = true;
            AgeRatingTagsPosition = "bottom-right";
            ShowRatingInPlayer = true;
            DisableAllShortcuts = false;
            DefaultSubtitleStyle = 0;
            DefaultSubtitleSize = 2;
            DefaultSubtitleFont = 0;
            DefaultSubtitleTextEffect = 0;
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
                new Shortcut { Name = "SkipIntroOutro", Key = "O", Label = "Skip Intro/Outro", Category = "Player" },
                new Shortcut { Name = "FrameStepBack", Key = ",", Label = "Step Back One Frame", Category = "Player" },
                new Shortcut { Name = "FrameStepForward", Key = ".", Label = "Step Forward One Frame", Category = "Player" },
                new Shortcut { Name = "JumpToLastPosition", Key = "Z", Label = "Jump to Last Position", Category = "Player" },
                new Shortcut { Name = "JumpToPercentage", Key = "0-9", Label = "Jump to % of video", Category = "Player" }
            };

            // Seerr Search Settings
            JellyseerrEnabled = false;
            JellyseerrShowSearchResults = true;
            JellyseerrShowReportButton = false;
            JellyseerrShowIssueIndicator = false;
            JellyseerrEnable4KRequests = false;
            JellyseerrEnable4KTvRequests = false;
            JellyseerrShowAdvanced = false;
            JellyseerrSingleSeasonRequestOnly = false;
            JellyseerrShowQuotaInfo = true;
            JellyseerrShowSimilar = true;
            JellyseerrShowRecommended = true;
            JellyseerrShowRequestMoreOnSeries = true;
            JellyseerrShowNetworkDiscovery = true;
            JellyseerrShowGenreDiscovery = true;
            JellyseerrShowTagDiscovery = true;
            JellyseerrShowPersonDiscovery = true;
            JellyseerrShowCollectionDiscovery = true;
            JellyseerrShowDetailPageLink = true;
            JellyseerrShowDetailPageLinkAsText = false;
            ShowElsewhereOnJellyseerr = false;
            JellyseerrUseMoreInfoModal = true;
            JellyseerrAvailablePosterLinksToJellyfin = false;
            NativeAbsentDetailsEnabled = false;
            JellyseerrSearchExcludeLibraryItems = false;
            JellyseerrUrls = "";
            JellyseerrApiKey = "";
            JellyseerrUrlMappings = "";
            ShowCollectionsInSearch = true;
            JellyseerrDisableCache = false;
            JellyseerrResponseCacheTtlMinutes = 10;
            JellyseerrUserIdCacheTtlMinutes = 30;
            TriggerSeerrScanOnItemAdded = false;
            SeerrScanDebounceSeconds = 60;

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

            // Requests & downloads (new): master switch for the arr integration, off by default.
            ArrIntegrationEnabled = false;
            // Requests & downloads, phase 1 (status on pages + live updates): off by default.
            ArrPhase1Enabled = false;
            ArrStatusPosterBadges = true;
            ArrStatusLookingHours = 24;
            // D92: series-page summary chips and the admin Sonarr/Radarr line, off by default.
            ArrStatusSeasonSummaryEnabled = false;
            ArrStatusAdminLineEnabled = false;
            // D95: download progress on artwork, on by default (the user asked for it).
            ArrStatusArtworkProgressEnabled = true;
            ArrHouseholdContactName = "";
            ArrWebhookJellyfinUrl = string.Empty;
            ArrRequestsHubEnabled = true;
            ArrManageDrawerEnabled = true;
            ArrSeerrModalStatus = true;
            ArrSeerrRefreshMinutes = 5;

            // Shoko Settings (single-instance, like Jellyseerr — Shoko is one server per household)
            ShokoUrl = "";
            ShokoApiKey = "";
            ShokoUrlMappings = "";
            ShokoShowEpisodes = true;
            ShokoShowSpecials = false;
            ShokoShowCredits = false;
            ShokoShowTrailers = false;
            ShokoShowParodies = false;
            ShokoShowOther = false;

            // Arr Tags Sync Settings
            ArrTagsSyncEnabled = false;
            SonarrApiKey = "";
            RadarrApiKey = "";
            ArrTagsPrefix = DefaultArrTagsPrefix;
            ArrTagsClearOldTags = true;
            ArrTagsShowAsLinks = true;
            ArrTagsLinksFilter = "";
            ArrTagsLinksHideFilter = "";
            ArrTagsSyncFilter = "";

            // Audio Language Tags Sync Settings
            AudioLanguageTagSyncEnabled = false;
            AudioLanguageTagPrefix = "JE Language: ";
            AudioLanguageTagShowAsLinks = true;

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
            SyncJellyfinWatchlistToSeerr = false;
            PreventWatchlistReAddition = true;
            WatchlistMemoryRetentionDays = 365;

            // Bookmarks Settings
            BookmarksEnabled = true;
            BookmarksUsePluginPages = false;
            BookmarksUseCustomTabs = false;
            BookmarksUseNativeTab = false;
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
            ActivityFeedEnabled = false;
            ActivityFeedShowWatched = true;
            ActivityFeedShowFavorited = true;
            ActivityFeedShowReviewed = true;
            ActivityFeedOwnOnlyForNonAdmins = false;
            ActivityFeedShowActiveStreams = true;
            ActivityFeedUsePluginPages = false;
            ActivityFeedUseCustomTabs = false;
            ActivityFeedUseNativeTab = false;
            ActivityFeedAutoCreateCustomTab = false;
            ActivityFeedCustomTabJeOwned = false;

            // Requests Page Settings (Sonarr/Radarr Queue Monitoring)
            DownloadsPageEnabled = false;
            DownloadsUsePluginPages = false;
            DownloadsUseCustomTabs = false;
            DownloadsUseNativeTab = false;
            DownloadsAutoCreateCustomTab = false;
            DownloadsCustomTabJeOwned = false;
            DownloadsPagePollingEnabled = true;
            DownloadsPollIntervalSeconds = 30;
            DownloadsPageShowIssues = false;
            ShowDownloadsInRequests = true;
            DownloadsFilterByUserRequests = true;
            DownloadsShowHistory = true;
            DownloadsHistoryAdminOnly = false;

            // Calendar Page Settings (Sonarr/Radarr Releases)
            CalendarPageEnabled = false;
            CalendarUsePluginPages = false;
            CalendarUseCustomTabs = false;
            CalendarUseNativeTab = false;
            CalendarAutoCreateCustomTab = false;
            CalendarCustomTabJeOwned = false;
            CalendarFirstDayOfWeek = "Monday";
            CalendarTimeFormat = "5pm/5:30pm";
            CalendarHighlightFavorites = false;
            CalendarHighlightWatchedSeries = false;
            CalendarFilterByLibraryAccess = true;
            CalendarShowOnlyRequested = false;
            CalendarForceOnlyRequested = false;

            // Recommendations Page Settings (Jellyseerr discover rows)
            RecommendationsPageEnabled = false;
            RecommendationsUsePluginPages = false;
            RecommendationsUseCustomTabs = false;
            RecommendationsUseNativeTab = false;
            RecommendationsAutoCreateCustomTab = false;
            RecommendationsCustomTabJeOwned = false;

            // Hidden Content Settings
            HiddenContentEnabled = false;
            HiddenContentUsePluginPages = false;
            HiddenContentUseCustomTabs = false;
            HiddenContentUseNativeTab = false;
            HiddenContentAutoCreateCustomTab = false;
            HiddenContentCustomTabJeOwned = false;
            // Admin cross-user view + management; on by default, admins can disable below.
            HiddenContentAdmin = true;

            // Catch Up page: off by default; the activity log is on once the page is enabled.
            CatchUpEnabled = false;
            CatchUpUsePluginPages = false;
            CatchUpUseNativeTab = false;
            CatchUpUseCustomTabs = false;
            CatchUpAutoCreateCustomTab = false;
            CatchUpCustomTabJeOwned = false;
            CatchUpLogEnabled = true;

            // Hidden Content per-user defaults — applied when a user's
            // hidden-content.json is created and via "Apply defaults to all users".
            HiddenContentDefaultEnabled = true;
            HiddenContentDefaultShowHideButtons = true;
            HiddenContentDefaultShowHideConfirmation = true;
            HiddenContentDefaultShowButtonJellyseerr = true;
            HiddenContentDefaultShowButtonLibrary = false;
            HiddenContentDefaultShowButtonDetails = true;
            HiddenContentDefaultShowButtonCast = false;
            HiddenContentDefaultFilterLibrary = true;
            HiddenContentDefaultFilterDiscovery = true;
            HiddenContentDefaultFilterSearch = false;
            HiddenContentDefaultFilterCalendar = true;
            HiddenContentDefaultFilterUpcoming = true;
            HiddenContentDefaultFilterRecommendations = true;
            HiddenContentDefaultFilterRequests = true;
            HiddenContentDefaultFilterNextUp = true;
            HiddenContentDefaultFilterContinueWatching = true;
            HiddenContentDefaultExperimentalHideCollections = false;

            // Spoiler Guard master switch. Defaults must match the property
            // initializers so XML upgrade paths land on the same value.
            SpoilerBlurEnabled = false;
            SpoilerBlurIntensity = 40;

            // Field-strip toggles default ON (strictest posture) and image mode
            // defaults to "hide" when the master switch is on; admins relax
            // individual toggles in the configPage's Spoiler Guard section.
            SpoilerStripOverview = true;
            SpoilerStripTags = true;
            SpoilerStripChapters = true;
            SpoilerStripTaglines = true;
            SpoilerStripRatings = true;
            SpoilerStripPremiereDate = true;
            SpoilerReplaceTitle = true;
            SpoilerStripCast = true;
            SpoilerStripCastMode = "GuestStars";
            SpoilerStripReviews = true;
            SpoilerBlurMode = "hide";
            SpoilerBlurArtwork = false;
            SpoilerAutoEnableOnFirstPlay = false;
            SpoilerAutoEnableOnSeerrRequest = false;
            SpoilerAutoEnableOnLibraryAdd = false;
            // Auto-enable scope defaults to "everything" so existing installs
            // keep today's first-play / Seerr-request behaviour unchanged.
            SpoilerAutoEnableSeries = true;
            SpoilerAutoEnableMovies = true;
            SpoilerAutoEnableLibraryIds = "";
            SpoilerBlurStrictRefresh = false;
            SpoilerKeepMoviePosters = true;
            SpoilerBlurTrickplay = true;
            SpoilerOverviewPlaceholder = "Spoiler Guard activated";

            // Advanced per-category reveals. Off by default so existing
            // installs keep today's uniform strip. Category strip toggles
            // default to the strictest posture except the next-episode
            // title — the whole point of advanced mode (you should be able
            // to see WHAT you're about to watch, and nothing more).
            SpoilerAdvancedMode = false;
            SpoilerNextEpisodeStripTitle = false;
            SpoilerNextEpisodeStripOverview = true;
            SpoilerNextEpisodeStripRatings = true;
            SpoilerNextEpisodeStripImage = true;
            SpoilerCurrentSeasonStripTitle = true;
            SpoilerCurrentSeasonStripOverview = true;
            SpoilerCurrentSeasonStripRatings = true;

            // Usage Statistics (opt-in anonymous analytics). Off by default;
            // sub-categories default on so that when an admin opts in for the
            // first time, everything is shared unless they deliberately narrow
            // it down (see AnalyticsHasBeenConfigured / the config-page cascade).
            AnalyticsEnabled = false;
            AnalyticsShareFeatureFlags = true;
            AnalyticsShareUsageCounts = true;
            AnalyticsShareDataSizes = true;
            AnalyticsHasBeenConfigured = false;
            AnalyticsInstallId = string.Empty;
            AnalyticsInstallSecret = string.Empty;
            AnalyticsReportIntervalDays = 15;
            AnalyticsLastReportedAt = 0;
            AnalyticsLastPayloadJson = string.Empty;
            AnalyticsLastReportedPluginVersion = string.Empty;
            AnalyticsLastReportedJellyfinTarget = string.Empty;
            AnalyticsLastReportedJellyfinVersion = string.Empty;
            AnalyticsForbiddenSinceLastSuccess = 0;
        }

        // Maintenance Mode
        public bool MaintenanceModeEnabled { get; set; }
        /// <summary>Shown as a banner on the login page.</summary>
        public string MaintenanceModeMessage { get; set; } = string.Empty;
        /// <summary>Sent as a native Jellyfin broadcast to all active sessions.</summary>
        public string MaintenanceModeNotificationMessage { get; set; } = string.Empty;
        /// <summary>"none" | "disable_accounts" | "disable_remote" | "both"</summary>
        [AnalyticsInclude]
        public string MaintenanceModeAction { get; set; } = "disable_accounts";
        /// <summary>
        /// "all" or a JSON array of user ID strings. Deliberately NOT
        /// [AnalyticsInclude]: the raw value can hold real Jellyfin user
        /// GUIDs, so analytics shares only a derived "all"/"selected" — see
        /// AnalyticsReportingService.GetStringSettings.
        /// </summary>
        public string MaintenanceModeAffectedUsers { get; set; } = "all";
        /// <summary>Manual mode auto-disables after this many minutes; 0 = until turned off.</summary>
        public int MaintenanceModeDurationMinutes { get; set; }
        /// <summary>Re-send the notification (with time remaining) to affected users on every playback start.</summary>
        public bool MaintenanceModeRemindOnPlayback { get; set; }
        /// <summary>Daily window that turns maintenance mode on/off automatically (MaintenanceScheduleService).</summary>
        public bool MaintenanceScheduleEnabled { get; set; }
        /// <summary>"HH:mm", server local time.</summary>
        public string MaintenanceScheduleStart { get; set; } = "00:00";
        /// <summary>"HH:mm", server local time; earlier than the start means the window crosses midnight.</summary>
        public string MaintenanceScheduleEnd { get; set; } = "08:00";
        /// <summary>Banner message used while a scheduled window is active.</summary>
        public string MaintenanceScheduleMessage { get; set; } = string.Empty;
        /// <summary>Popup sent to active sessions when a scheduled window starts.</summary>
        public string MaintenanceScheduleNotificationMessage { get; set; } = string.Empty;
        /// <summary>"none" | "disable_accounts" | "disable_remote" | "both", applied during the scheduled window.</summary>
        [AnalyticsInclude]
        public string MaintenanceScheduleAction { get; set; } = "none";

        // Jellyfin Enhanced Settings
        /// <summary>
        /// The configuration's generation: every write of the configuration moves it on (JellyfinEnhanced.SaveConfiguration).
        /// It travels with the document Jellyfin's plugin-configuration route hands out and takes back, so a whole
        /// configuration built on an earlier one is told apart and refused (JellyfinEnhanced.UpdateConfiguration). Never
        /// set by a configuration page save.
        /// </summary>
        public long ConfigurationGeneration { get; set; }

        public int ToastDuration { get; set; }
        public int HelpPanelAutocloseDelay { get; set; }
        public bool EnableCustomSplashScreen { get; set; }
        public string SplashScreenImageUrl { get; set; }
        public bool DevMode { get; set; }

        // Kill-switch for the request-time <script> injection middleware
        // (ScriptInjectionStartupFilter). When true, the middleware no-ops and the
        // plugin falls back to the legacy on-disk index.html rewrite. Default false.
        [AnalyticsExclude]
        public bool DisableScriptInjectionMiddleware { get; set; }

        // Kill-switch for the request-time branding-asset middleware
        // (BrandingAssetStartupFilter). When true, custom logo/banner/favicon images
        // are not served and jellyfin-web's stock assets are used. Default false.
        [AnalyticsExclude]
        public bool DisableBrandingMiddleware { get; set; }

        // Jellyfin Elsewhere Settings
        public bool ElsewhereEnabled { get; set; }
        public string TMDB_API_KEY { get; set; }
        public string DEFAULT_REGION { get; set; }
        public string DEFAULT_PROVIDERS { get; set; }
        public string IGNORE_PROVIDERS { get; set; }
        public bool ElsewhereSeasonProviders { get; set; }
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
        public bool RandomScopeCurrentContainer { get; set; }
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
        /// <summary>When a user saves a review with a star rating, also write that
        /// rating to Jellyfin's own per-user rating for the matching library item
        /// (1-5 stars scaled to Jellyfin's 0-10). Off by default: it lets other
        /// tools that read Jellyfin user data (scrobblers, Letterboxd/Trakt syncs)
        /// see ratings given here, at the cost of overwriting a rating set elsewhere.
        /// Deleting a review, or removing its stars, clears the Jellyfin rating only
        /// when it still equals the mirrored value. Only whole movies and series
        /// are touched (season/episode reviews have no reliable TMDB-keyed item).</summary>
        public bool MirrorReviewRatingsToJellyfin { get; set; }
        public bool ShowAwards { get; set; }
        /// <summary>Shows a content-warnings section (DoesTheDogDie votes) on item-details pages.</summary>
        public bool DoesTheDogDieEnabled { get; set; }
        /// <summary>DoesTheDogDie API key. Server-side only, never sent to clients.</summary>
        public string DoesTheDogDieApiKey { get; set; } = string.Empty;
        /// <summary>MDBList API key (mdblist.com). Never exposed to clients;
        /// see GetPublicConfig()'s MdblistEnabled boolean. Used server-side
        /// only, by MdblistService.</summary>
        public string MdblistApiKey { get; set; } = string.Empty;
        /// <summary>Master toggle for the MDBList ratings feature (item-details display + sync task).</summary>
        public bool MdblistRatingsEnabled { get; set; }
        /// <summary>Shows an MDBList ratings row on item-details pages.</summary>
        public bool MdblistRatingsShowOnItemDetails { get; set; } = true;
        /// <summary>Gates MdblistRatingsFetchTask, the task that actually talks to
        /// MDBList and keeps mdblist-ratings.json fresh. Off by default so enabling
        /// the feature only turns on the display (which still lazily fetches
        /// on-demand per item view), not a background library-wide crawl, until
        /// explicitly opted into.</summary>
        public bool MdblistRatingsFetchEnabled { get; set; }
        /// <summary>Gates MdblistRatingsSyncTask writing CommunityRating/CriticRating
        /// back to items from whatever's already cached. This task makes no MDBList
        /// API calls itself, so it's independent of MdblistRatingsFetchEnabled, though
        /// it has nothing to sync from until the fetch task, or an item-details page
        /// view, has populated the cache for a given title.</summary>
        public bool MdblistRatingsAutoSyncEnabled { get; set; }
        /// <summary>Off (default): the sync task only FILLS a CommunityRating/CriticRating
        /// that's currently empty, and skips an item entirely once both are set,
        /// so once populated (by MDBList or any other provider/manual edit), that
        /// item is never revisited. On: every item is reconsidered on every run and
        /// its rating(s) are always set to whatever MDBList currently reports,
        /// replacing an existing value. This is what makes the rating actually
        /// stay current over time, at the cost of losing any provider- or
        /// admin-set value MDBList disagrees with.</summary>
        public bool MdblistRatingsOverwriteExisting { get; set; }
        /// <summary>Source the sync task writes to CommunityRating (0-10).</summary>
        public string MdblistCommunityRatingSource { get; set; } = "tmdb";
        /// <summary>Source the sync task writes to CriticRating (0-100).</summary>
        public string MdblistCriticRatingSource { get; set; } = "tomatoes";
        /// <summary>Used when the main source has no score for a title. Empty = none.</summary>
        public string MdblistCommunityRatingFallbackSource { get; set; } = string.Empty;
        public string MdblistCriticRatingFallbackSource { get; set; } = string.Empty;
        /// <summary>MdblistRatingsFetchTask stops for the day once the account's
        /// LIVE remaining quota (from MDBList's own GET /user endpoint, see
        /// MdblistService.GetAccountStatusAsync) drops to this floor, reserving
        /// the rest for live item-details page lookups so a large fetch run
        /// can't exhaust the whole day's quota.</summary>
        public int MdblistFetchReserve { get; set; } = 400;
        /// <summary>Comma-separated MDBList source keys (tmdb, tomatoes, popcorn,
        /// imdb, trakt, metacritic, metacriticuser, letterboxd, rogerebert,
        /// myanimelist, master) controlling which ratings show on the item-details
        /// row, and in what order. Empty (default) shows every source MDBList has
        /// data for, in the built-in priority order.</summary>
        public string MdblistRatingsSources { get; set; } = string.Empty;
        /// <summary>Appends "%" after each rating badge's number on the item-details row.</summary>
        public bool MdblistRatingsShowPercentSymbol { get; set; }
        public bool ShowReleaseDates { get; set; }
        public bool ShowUserRatingOnPosters { get; set; } = false;
        /// <summary>
        /// When true (default), shows a "—" on poster cards for items the user hasn't rated yet.
        /// When false, the person_heart chip is hidden entirely for unrated items.
        /// </summary>
        public bool ShowUserRatingDash { get; set; } = true;
        public List<Shortcut> Shortcuts { get; set; }
        public bool PauseScreenEnabled { get; set; }
        public bool ShowPlaybackRatingBadge { get; set; }
        public int PauseScreenDelaySeconds { get; set; } = 5;
        public bool QualityTagsEnabled { get; set; }
        public bool ShowResolutionTag { get; set; } = true;
        public bool ShowSourceTag { get; set; } = true;
        public bool ShowDynamicRangeTag { get; set; } = true;
        public bool ShowSpecialFormatTag { get; set; } = true;
        public bool ShowVideoCodecTag { get; set; } = true;
        public bool ShowAudioInfoTag { get; set; } = true;
        public int ResolutionTagOrder { get; set; } = 1;
        public int SourceTagOrder { get; set; } = 2;
        public int DynamicRangeTagOrder { get; set; } = 3;
        public int SpecialFormatTagOrder { get; set; } = 4;
        public int VideoCodecTagOrder { get; set; } = 5;
        public int AudioInfoTagOrder { get; set; } = 6;
        public bool LanguageTagsEnabled { get; set; }
        public bool RatingTagsEnabled { get; set; }
        public bool AgeRatingTagsEnabled { get; set; }
        public bool PeopleTagsEnabled { get; set; }
        /// <summary>Allows experimental poster tags drawn into poster images for native clients that don't run the web overlays.</summary>
        public bool NativePosterTagsEnabled { get; set; }
        /// <summary>
        /// Extra Jellyfin client names (one per line or comma separated) that already run the web overlays and must
        /// get original posters, on top of the built-in web client list. Admin-only; never exposed in public configuration.
        /// Deliberately NOT [AnalyticsInclude] (free text): analytics shares a sanitized
        /// derivation instead, see AnalyticsReportingService.GetStringSettings.
        /// </summary>
        public string NativePosterTagsWebClientNames { get; set; }
        public bool TagStylesEnabled { get; set; }
        public string TagStyleOverrides { get; set; }
        [AnalyticsInclude]
        public string TagStyleTarget { get; set; }
        [AnalyticsInclude]
        public string TagStylePreset { get; set; }
        [AnalyticsInclude]
        public string TagStyleApplyScope { get; set; }
        public int TagsCacheTtlDays { get; set; }
        public bool DisableTagsOnSearchPage { get; set; }
        public bool TagsHideOnHover { get; set; }
        public bool TagCacheServerMode { get; set; }
        // Master switch for the exclusion list below; off means every library is cached.
        public bool TagCacheExcludeLibraries { get; set; } = false;
        // Comma-separated library ids (dashless) the tag cache skips. Empty means none.
        public string TagCacheExcludedLibraryIds { get; set; } = "";
        public bool EnableTagsLocalStorageFallback { get; set; }
        public bool DisableAllShortcuts { get; set; }
        public int DefaultSubtitleStyle { get; set; }
        public int DefaultSubtitleSize { get; set; }
        public int DefaultSubtitleFont { get; set; }
        public int DefaultSubtitleTextEffect { get; set; }
        public bool DisableCustomSubtitleStyles { get; set; }
        [AnalyticsInclude]
        public string QualityTagsPosition { get; set; } = "top-left";
        [AnalyticsInclude]
        public string GenreTagsPosition { get; set; } = "top-right";
        [AnalyticsInclude]
        public string LanguageTagsPosition { get; set; } = "bottom-left";
        /// <summary>
        /// Comma-separated list of language codes (e.g. "en,ja,fr") that should be
        /// prioritized among the flags shown on a poster card. Since only a handful
        /// of flags fit (see maxToShow in languagetags.js), audio tracks matching a
        /// code here are shown first, in the order listed; remaining slots are then
        /// filled with the item's other languages in their original detection order.
        /// Empty (default) preserves the pre-existing unprioritized behavior.
        /// Deliberately NOT [AnalyticsInclude]: this is a free-text box (the
        /// UI invites language names, not just codes), so analytics shares a
        /// normalized codes-only derivation instead — see
        /// AnalyticsReportingService.GetStringSettings.
        /// </summary>
        public string LanguageTagsPriority { get; set; } = string.Empty;
        /// <summary>
        /// When true, only languages matching <see cref="LanguageTagsPriority"/> are
        /// ever shown (a card can end up with fewer than the usual 3 flags, or
        /// none, if it has no matching audio track). When false (default), the
        /// priority list only affects ordering and remaining slots still fill
        /// with the item's other languages. No effect when the priority list
        /// is empty.
        /// </summary>
        public bool LanguageTagsPriorityStrict { get; set; }
        /// <summary>
        /// Language whose audio tracks decide the sound tag (Atmos, DTS, 5.1, ...)
        /// on poster cards, as an ISO 639 code (de, deu, pt-BR). Empty (default)
        /// judges every track, i.e. the best track overall. Users can override it
        /// in their own settings.
        /// </summary>
        public string QualityTagsPreferredAudioLanguage { get; set; } = string.Empty;
        /// <summary>
        /// When on, a user's own Jellyfin audio language preference (Settings →
        /// Playback → Preferred audio language) is used instead of
        /// <see cref="QualityTagsPreferredAudioLanguage"/>; users without one keep
        /// the fixed language.
        /// </summary>
        public bool QualityTagsAudioLanguageFromUser { get; set; }
        [AnalyticsInclude]
        public string RatingTagsPosition { get; set; } = "bottom-right";
        // Where rating tags are allowed to render. The item-type switches gate
        // cards by their Jellyfin type; the two home-row switches additionally
        // gate any card shown in the Continue Watching / Next Up rows. All
        // default to true so existing installs render exactly as before.
        public bool RatingTagsOnMovies { get; set; } = true;
        public bool RatingTagsOnSeries { get; set; } = true;
        public bool RatingTagsOnSeasons { get; set; } = true;
        public bool RatingTagsOnEpisodes { get; set; } = true;
        public bool RatingTagsOnContinueWatching { get; set; } = true;
        public bool RatingTagsOnNextUp { get; set; } = true;
        [AnalyticsInclude]
        public string AgeRatingTagsPosition { get; set; } = "bottom-right";
        public bool ShowRatingInPlayer { get; set; } = true;
        public bool GenreTagsEnabled { get; set; }
        public string DefaultLanguage { get; set; }

        // Seerr Search Settings
        public bool JellyseerrEnabled { get; set; }
        public bool JellyseerrShowSearchResults { get; set; }
        public bool JellyseerrSearchExcludeLibraryItems { get; set; } = false;
        public bool JellyseerrShowReportButton { get; set; }
        public bool JellyseerrShowIssueIndicator { get; set; }
        public bool JellyseerrEnable4KRequests { get; set; }
        public bool JellyseerrEnable4KTvRequests { get; set; }
        public bool JellyseerrShowAdvanced { get; set; }
        public bool JellyseerrSingleSeasonRequestOnly { get; set; }
        public bool JellyseerrShowQuotaInfo { get; set; }
        public bool JellyseerrShowSimilar { get; set; }
        public bool JellyseerrShowRecommended { get; set; }
        public bool JellyseerrShowRequestMoreOnSeries { get; set; }
        public bool JellyseerrShowNetworkDiscovery { get; set; }
        public bool JellyseerrShowGenreDiscovery { get; set; }
        public bool JellyseerrShowTagDiscovery { get; set; }
        public bool JellyseerrShowPersonDiscovery { get; set; }
        public bool JellyseerrShowCollectionDiscovery { get; set; }
        public bool JellyseerrShowDetailPageLink { get; set; }
        public bool JellyseerrShowDetailPageLinkAsText { get; set; }
        public bool JellyseerrExcludeLibraryItems { get; set; } = true;
        public bool JellyseerrExcludeBlocklistedItems { get; set; } = false;
        public bool ShowElsewhereOnJellyseerr { get; set; }
        public bool JellyseerrUseMoreInfoModal { get; set; } = true;
        public bool JellyseerrAvailablePosterLinksToJellyfin { get; set; } = false;
        /// <summary>
        /// Experimental (Jellyfin 12, web): a Seerr title that isn't in the library opens Jellyfin's own
        /// details page (served by JE from Seerr/TMDB data, nothing is added to the library) instead of the
        /// More Info modal. Off by default; the modal stays the fallback.
        /// </summary>
        public bool NativeAbsentDetailsEnabled { get; set; } = false;
        public string JellyseerrUrls { get; set; }
        public string JellyseerrApiKey { get; set; }
        public string JellyseerrUrlMappings { get; set; }

        // On-demand library sync: POST {seerrUrl}/api/v1/settings/jobs/jellyfin-recently-added-scan/run
        // when Jellyfin reports new items, debounced so a bulk import collapses to one call.
        public bool TriggerSeerrScanOnItemAdded { get; set; }
        public int SeerrScanDebounceSeconds { get; set; } = 60;
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

        /// <summary>
        /// Master switch for "Requests &amp; downloads (new)", the reworked Sonarr/Radarr integration.
        /// Off by default; while off, every existing *arr feature behaves exactly as before. Each
        /// later phase adds its own switch under this one.
        /// </summary>
        public bool ArrIntegrationEnabled { get; set; }

        /// <summary>Enable durable requests; also requires the integration and phase 1 switches.</summary>
        public bool ArrPhase3Enabled { get; set; }

        /// <summary>Request authority: seerr (default), je (opt in), or status_only.</summary>
        public string ArrRequestBackend { get; set; } = "seerr";

        /// <summary>Allow 4K movie requests in phase 3, subject to target and user capabilities.</summary>
        public bool ArrRequest4kMoviesEnabled { get; set; }

        /// <summary>Allow 4K series requests in phase 3, subject to target and user capabilities.</summary>
        public bool ArrRequest4kSeriesEnabled { get; set; }

        /// <summary>
        /// A standard (non-4K) request counts as arrived only with a playable copy that isn't 4K. Off (default): any
        /// playable copy satisfies it, a 4K one included. A 4K request always needs a 4K copy.
        /// </summary>
        public bool ArrStandardNeedsNonFourK { get; set; }

        /// <summary>Household preset: ask_first, open_house, or approve_everything.</summary>
        public string ArrRequestPreset { get; set; } = "ask_first";

        /// <summary>Role for users without an override: Watcher, Kid, Member, or Manager.</summary>
        public string ArrRequestDefaultRole { get; set; } = "Watcher";

        /// <summary>Server-owned per-user role, quota and 4K overrides as a JSON object keyed by user id.</summary>
        public string ArrRequestUsers { get; set; } = "{}";

        /// <summary>Server-owned quota and 4K defaults by household role, as a JSON object.</summary>
        public string ArrRequestRoles { get; set; } = "{}";

        /// <summary>Rolling quota limit; zero selects the preset default, negative means unlimited.</summary>
        public int ArrRequestQuotaLimit { get; set; } = 0;

        /// <summary>
        /// Never kept (cleared on every save): the configuration page's read of the settings the server also changes
        /// (the Household tab, a move from Seerr), as a JSON object of field name to value. A field the page posts
        /// unchanged from that read keeps whatever the server holds when the save lands, so an edit made in the gap
        /// between the page's read and its save isn't put back.
        /// </summary>
        public string ArrServerOwnedSeen { get; set; } = string.Empty;

        /// <summary>Quota window in days.</summary>
        public int ArrRequestQuotaWindowDays { get; set; } = 7;

        /// <summary>Total seasons of a series beyond which Members require approval.</summary>
        public int ArrRequestSeriesThreshold { get; set; } = 4;

        /// <summary>Days before a requester can repeat a declined scope.</summary>
        public int ArrRequestDeclineCooldownDays { get; set; } = 7;

        /// <summary>Maximum pending wants per user.</summary>
        public int ArrRequestPendingLimit { get; set; } = 10;

        /// <summary>Optional estimated GB limit per quota window; zero disables it.</summary>
        public double ArrRequestQuotaGb { get; set; } = 0;

        /// <summary>Charge each new season for a future-season want.</summary>
        public bool ArrRequestChargeFutureSeasons { get; set; } = true;

        /// <summary>Days before an unfulfilled request is marked stale.</summary>
        public int ArrRequestStaleDays { get; set; } = 30;

        /// <summary>
        /// Hide the free-text search row (titles not in the library) from Kids in JE request mode; the
        /// search route then refuses them. Discover rows stay, filtered by their parental limits. Off by default.
        /// </summary>
        public bool ArrKidsHideSearch { get; set; }

        /// <summary>Lab-only cleanup route; default off, never shown on the config page.</summary>
        public bool ArrRequestLabEnabled { get; set; }

        // ---- Requests & downloads, phase 4: everywhere and gentle automation (4a foundation) ----

        /// <summary>
        /// Phase 4 of "Requests &amp; downloads (new)": its features each have their own switch under this one. Needs
        /// <see cref="ArrIntegrationEnabled"/> and <see cref="ArrPhase1Enabled"/>. Off by default; while off, phase 3 and
        /// the existing auto-request features behave as before, and work only phase 4 creates is never sent.
        /// </summary>
        public bool ArrPhase4Enabled { get; set; }

        /// <summary>
        /// The automation engine: recipe modes (Off / Shadow / Ask / Auto), budgets, kill switches and the send guard
        /// for automatic requests. Needs <see cref="ArrPhase4Enabled"/> and <see cref="ArrPhase3Enabled"/>. Off by default.
        /// </summary>
        public bool ArrPhase4AutomationEnabled { get; set; }

        /// <summary>
        /// Rollout guard: every automatic request (the existing next-season and next-movie features too, with or
        /// without phase 4, and automatic requests already queued) only records what it would have done, and nothing
        /// automatic is sent. Independent of every other switch here. Off by default.
        /// </summary>
        public bool ArrAutomationShadowOverride { get; set; }

        /// <summary>Kill switch: no automatic request is sent (reading back an earlier uncertain send still runs). Off (not killed) by default.</summary>
        public bool ArrAutomationKillAll { get; set; }

        /// <summary>Per-instance kill switches: comma-separated Sonarr/Radarr instance ids, and <c>seerr</c> for Jellyfin Enhanced's sends to Seerr.</summary>
        public string ArrAutomationKilledInstances { get; set; } = string.Empty;

        /// <summary>
        /// Per-recipe mode and kill switch as a JSON object keyed by recipe id, e.g.
        /// <c>{"auto_season":{"mode":"shadow","killed":false}}</c>. A recipe not listed is in Shadow and not killed.
        /// </summary>
        public string ArrAutomationRecipes { get; set; } = string.Empty;

        /// <summary>Household budget: titles automatic requests may add or start monitoring per rolling 24 hours (Sonarr/Radarr handling).</summary>
        public int ArrAutomationHouseholdAddsPerDay { get; set; } = 20;

        /// <summary>Per-instance budget: automatic searches per rolling hour.</summary>
        public int ArrAutomationSearchesPerHour { get; set; } = 30;

        /// <summary>Per-instance budget: automatic searches per rolling 24 hours.</summary>
        public int ArrAutomationSearchesPerDay { get; set; } = 300;

        /// <summary>Seerr handling: automatic requests Jellyfin Enhanced may send to Seerr per rolling 24 hours (what Seerr then does is Seerr's).</summary>
        public int ArrAutomationSeerrPostsPerDay { get; set; } = 20;

        /// <summary>Reserved for backfill (a later phase): searches per rolling hour. Nothing uses it yet.</summary>
        public int ArrAutomationBackfillPerHour { get; set; } = 10;

        /// <summary>Linked lists: source reads per rolling hour (scheduled and manual together).</summary>
        public int ArrAutomationSourceFetchesPerHour { get; set; } = 60;

        /// <summary>Linked lists: list changes applied per rolling hour.</summary>
        public int ArrAutomationDeltaWorkPerHour { get; set; } = 500;

        /// <summary>Automatic requests cost nobody's allowance (by default they count against the person they are made for).</summary>
        public bool ArrAutomationFree { get; set; }

        /// <summary>Server-owned record of the one-time automation migration (empty until it ran). Never shown or edited on the page.</summary>
        public string ArrAutomationMigration { get; set; } = string.Empty;

        // ---- Phase 4b: household rules, the Trusted role, group quotas, administrator Seerr request options ----

        /// <summary>
        /// Household rules: the Trusted role, and fixed conditions per role (rating, genre, original language, size
        /// estimate, already on a streaming service the household has) that approve, send for a look or refuse a
        /// request. Needs <see cref="ArrPhase4Enabled"/> and <see cref="ArrPhase3Enabled"/>; the conditions apply only
        /// while Jellyfin Enhanced handles requests (Seerr's own rules apply in Seerr mode). Off by default: the presets
        /// decide as before, and nobody is Trusted.
        /// </summary>
        public bool ArrPhase4HouseholdRulesEnabled { get; set; }

        /// <summary>
        /// Group quotas: shared request pools for the household or for roles, on top of each person's own limit. Needs
        /// <see cref="ArrPhase4HouseholdRulesEnabled"/> (and Jellyfin Enhanced handling requests). Off by default.
        /// </summary>
        public bool ArrPhase4GroupQuotasEnabled { get; set; }

        /// <summary>
        /// Administrators may pick Seerr's server, quality profile and root folder (standard or 4K) on a request Jellyfin
        /// Enhanced sends to Seerr. Needs <see cref="ArrPhase4Enabled"/> and <see cref="ArrPhase3Enabled"/>, and the
        /// administrator's Seerr account needs Seerr's advanced-request permission. Off by default.
        /// </summary>
        public bool ArrPhase4SeerrRequestOptionsEnabled { get; set; }

        /// <summary>Server-owned household rule conditions per role (JSON). Edited on the Requests page's Household tab.</summary>
        public string ArrHouseholdRules { get; set; } = string.Empty;

        /// <summary>The household's streaming country (ISO 3166-1, e.g. <c>GB</c>); empty: streaming conditions are inactive.</summary>
        public string ArrHouseholdStreamingCountry { get; set; } = string.Empty;

        /// <summary>Comma-separated TMDB watch-provider ids of the services the household has; empty: streaming conditions are inactive.</summary>
        public string ArrHouseholdStreamingServices { get; set; } = string.Empty;

        /// <summary>Server-owned group quota pools (JSON array, in precedence order). Edited on the Household tab.</summary>
        public string ArrGroupQuotaPools { get; set; } = string.Empty;
        // ---- Phase 4c1: lists (playlist and collection entries for titles not in the library) ----

        /// <summary>
        /// Lists: playlists and collections can hold titles that aren't in the library yet (movies, series, seasons,
        /// episodes, custom entries), in order with the real items. Needs <see cref="ArrPhase4Enabled"/> and
        /// <see cref="ArrPhase3Enabled"/>. Off by default; each list feature below has its own switch.
        /// </summary>
        public bool ArrPhase4ListPlaceholdersEnabled { get; set; }

        /// <summary>Lists: people who can edit a list may add, edit, link, reorder and remove its entries and create lists. Off by default.</summary>
        public bool ArrPhase4ListAuthoringEnabled { get; set; }

        /// <summary>Lists: ask for a list entry (Request) through the household's normal request rules. Off by default.</summary>
        public bool ArrPhase4ListRequestsEnabled { get; set; }

        /// <summary>Lists: "Request all missing" (a preview first, at most 20 titles per confirmation). Needs <see cref="ArrPhase4ListRequestsEnabled"/>. Off by default.</summary>
        public bool ArrPhase4ListRequestAllEnabled { get; set; }

        /// <summary>
        /// Lists: when a title arrives in the library it takes its entry's place in the list (TV episode by episode), on
        /// lists whose editor turned it on and who agreed in their own settings. Off by default.
        /// </summary>
        public bool ArrPhase4ListSwapInEnabled { get; set; }

        /// <summary>Lists: daily maintenance (release dates and episode lists of entries, removed lists, missed arrivals). Off by default.</summary>
        public bool ArrPhase4ListMaintenanceEnabled { get; set; }

        /// <summary>Lists: show where each entry's request stands (the shared request status). Off by default.</summary>
        public bool ArrPhase4ListStatusEnabled { get; set; }

        // ---- Phase 4c3a: list pages (drawing the lists) ----

        /// <summary>
        /// Lists: draw the entries that aren't in the library on playlist pages, in list order between the real rows, and
        /// mark playlists that have them as incomplete on the Playlists page instead of Jellyfin's "played" check (which
        /// Jellyfin gives a playlist with nothing playable in it). Needs <see cref="ArrPhase4ListPlaceholdersEnabled"/>.
        /// Everyone can hide it for themselves. Off by default.
        /// </summary>
        public bool ArrPhase4ListPlaylistUiEnabled { get; set; }

        /// <summary>
        /// Lists: a "Not in your library" section on collection pages with the collection's entries that aren't in the
        /// library, by release date. Needs <see cref="ArrPhase4ListPlaceholdersEnabled"/>. Everyone can hide it for
        /// themselves. Off by default.
        /// </summary>
        public bool ArrPhase4ListCollectionUiEnabled { get; set; }
        // ---- Phase 4e: acquisition badges (web) and per-viewer native poster stamps ----

        /// <summary>
        /// Acquisition badges: one badge per poster card for what changed for the viewer — Upgraded (a better copy
        /// replaced the file), New for you (something they asked for or follow arrived) and 4K (they can open a 4K copy),
        /// after the download ring. Needs <see cref="ArrPhase4Enabled"/>. Off by default; each person may hide them.
        /// </summary>
        public bool ArrPhase4AcquisitionBadgesEnabled { get; set; }

        /// <summary>
        /// Acquisition badges on native apps: the same state drawn into each viewer's own poster images (native poster
        /// tags). Needs <see cref="ArrPhase4AcquisitionBadgesEnabled"/> and <see cref="NativePosterTagsEnabled"/>. Off by
        /// default; each person may turn them off.
        /// </summary>
        public bool ArrPhase4NativeStampsEnabled { get; set; }

        /// <summary>Acquisition badges: days a "New for you" badge lasts unless watched first (1–30, default 7).</summary>
        public int ArrAcquisitionNewDays { get; set; } = 7;

        /// <summary>Acquisition badges: days an "Upgraded" badge lasts unless watched first (1–30, default 7).</summary>
        public int ArrAcquisitionUpgradedDays { get; set; } = 7;
        // ---- Phase 4d: home rows, Home Screen Sections, collection gaps ----

        /// <summary>
        /// Home rows: "Your requests", "Coming soon for you" (requests and follows dated in the next 30 days) and "Just
        /// arrived for you" (arrived in the last 7 days, upgrades left out) on the home screen. Each row hides when empty
        /// and each person can switch each row off. Needs <see cref="ArrPhase4Enabled"/> and <see cref="ArrPhase3Enabled"/>.
        /// Off by default.
        /// </summary>
        public bool ArrPhase4HomeRowsEnabled { get; set; }

        /// <summary>
        /// Home rows as Home Screen Sections: with that plugin installed, the rows are registered as its sections (placed
        /// and switched on in its settings) instead of being added to the home screen, never both. Titles not in the
        /// library need the native pages for them (<see cref="NativeAbsentDetailsEnabled"/>). Needs
        /// <see cref="ArrPhase4HomeRowsEnabled"/>. Off by default.
        /// </summary>
        public bool ArrPhase4HssSectionsEnabled { get; set; }

        /// <summary>
        /// Home rows: an administrator's strip above them ("2 downloading · 1 import blocked · /movies4k 94%") that shows
        /// only when something needs doing. Needs <see cref="ArrPhase4HomeRowsEnabled"/> and <see cref="ArrPhase2Enabled"/>.
        /// Off by default.
        /// </summary>
        public bool ArrPhase4HomeOpsStripEnabled { get; set; }

        /// <summary>
        /// Collection gaps, phase 4 additions: titles a collection's list already holds as entries are left out of
        /// "Get the N missing", and the older Seerr "Missing from" row stays away while the gaps block shows. The
        /// gaps block itself keeps its phase 3 switch. Needs <see cref="ArrPhase4Enabled"/> and
        /// <see cref="ArrPhase3Enabled"/>. Off by default.
        /// </summary>
        public bool ArrPhase4CollectionGapsEnabled { get; set; }

        // ---- Phase 4f: the private Ready playlist and native Ready messages ----

        /// <summary>
        /// Ready playlist: each person who turns it on gets a private playlist of what they asked for or follow that is now
        /// ready to watch, in the exact version they asked for; watched, expired, hidden and no-longer-openable entries
        /// leave it. Needs <see cref="ArrPhase4Enabled"/> and <see cref="ArrPhase3Enabled"/> (not notifications). Off by
        /// default, and off for each person until they turn it on.
        /// </summary>
        public bool ArrPhase4ReadyPlaylistEnabled { get; set; }

        /// <summary>
        /// Native Ready messages: a short on-screen message on a TV or app signed in as the person and not playing anything,
        /// when something they asked for is ready. Needs <see cref="ArrPhase4Enabled"/> and notifications. Off by default,
        /// and off for each person until they turn it on.
        /// </summary>
        public bool ArrPhase4ReadyMessagesEnabled { get; set; }

        /// <summary>Ready playlist: days an entry stays unless watched first (1–90, default 30).</summary>
        public int ArrReadyRetentionDays { get; set; } = 30;
        // ---- Phase 4c2: list import and sources (reviewed previews; nothing here changes a list by itself) ----

        /// <summary>
        /// Lists: import entries from pasted text, a file (CSV, IMDb or Letterboxd export) or a list URL, with a review of
        /// every match first. Needs <see cref="ArrPhase4ListAuthoringEnabled"/>. Off by default.
        /// </summary>
        public bool ArrPhase4ListImportEnabled { get; set; }

        /// <summary>Lists: "From URL" (list sites). Needs <see cref="ArrPhase4ListImportEnabled"/>; each site below has its own switch. Off by default.</summary>
        public bool ArrPhase4ListSourcesEnabled { get; set; }

        /// <summary>From URL: MDBList public lists (no key; also the mirror for Letterboxd, IMDb and Trakt lists). Off by default.</summary>
        public bool ArrPhase4ListMdblistEnabled { get; set; }

        /// <summary>
        /// From URL: administrators may deliberately read an MDBList list through the MDBList API with the server's MDBList
        /// key (private lists; counts against the key's daily quota, which ratings share). Never used as a fallback. Needs
        /// <see cref="ArrPhase4ListMdblistEnabled"/>. Off by default.
        /// </summary>
        public bool ArrPhase4ListMdblistApiEnabled { get; set; }

        /// <summary>From URL: TMDB lists, collections and charts (the TMDB key; collections and trending also through Seerr, labelled). Off by default.</summary>
        public bool ArrPhase4ListTmdbEnabled { get; set; }

        /// <summary>From URL: chronolists.com watch orders (exact TMDB ids, no key). Off by default.</summary>
        public bool ArrPhase4ListChronolistsEnabled { get; set; }

        /// <summary>From URL: Trakt lists, watchlists and charts (needs <see cref="ArrListTraktApiKey"/>). Off by default.</summary>
        public bool ArrPhase4ListTraktEnabled { get; set; }

        /// <summary>
        /// From URL: IMDb lists, watchlists and charts through IMDb's unofficial API. An explicit opt-in: it may stop working
        /// without notice. IMDb CSV exports work without it. Off by default.
        /// </summary>
        public bool ArrPhase4ListImdbEnabled { get; set; }

        /// <summary>
        /// Lists: when Seerr isn't set up, read title details for list entries and import matches from TMDB with the
        /// server's TMDB key (release dates, posters, seasons and episodes). Needs <see cref="ArrPhase4ListPlaceholdersEnabled"/>. Off by default.
        /// </summary>
        public bool ArrPhase4ListJeMetadataEnabled { get; set; }

        /// <summary>The Trakt app's client id (sent as Trakt's <c>trakt-api-key</c>); kept in the secrets store, never sent to browsers.</summary>
        public string ArrListTraktApiKey { get; set; } = string.Empty;

        // ---- end Phase 4c2 ----

        // ---- Requests & downloads, phase 1: status on pages and live updates ----

        /// <summary>
        /// Phase 1 of "Requests &amp; downloads (new)": where each title has got to (status pill and
        /// journey on details pages, poster badges, episode chips and the missing-episodes banner),
        /// kept current by live updates from Sonarr/Radarr (SignalR, webhooks, the change feed).
        /// Only takes effect while <see cref="ArrIntegrationEnabled"/> is on. Off by default.
        /// </summary>
        public bool ArrPhase1Enabled { get; set; }

        /// <summary>Show status badges (download ring, "almost ready", "taking longer") on poster cards. On by default (when phase 1 is on).</summary>
        public bool ArrStatusPosterBadges { get; set; } = true;

        /// <summary>Hours a monitored title may be "Looking for it" before it reads "Still looking". 1-720, default 24.</summary>
        public int ArrStatusLookingHours { get; set; } = 24;

        // ---- D92: series-page summary chips and the admin status line (opt-in) ----

        /// <summary>
        /// Show the ready and missing counts on series and season pages ("Seasons 1, 3 ready", "8 of 10 ready",
        /// "54 missing"). What is on its way (downloading, almost ready, looking, airing) shows either way. Off by default.
        /// </summary>
        public bool ArrStatusSeasonSummaryEnabled { get; set; }

        /// <summary>
        /// Show administrators the Sonarr/Radarr line under the status on details pages (instance, the arr's own words and
        /// the fix, e.g. "Sonarr · Some episodes missing"). The Manage drawer shows it either way. Off by default.
        /// </summary>
        public bool ArrStatusAdminLineEnabled { get; set; }

        // ---- end D92 ----

        // ---- D95: download progress on artwork ----

        /// <summary>
        /// Show the download progress on the artwork of a title on its way: a ring with the percentage on poster cards,
        /// the details-page poster and list placeholders while it downloads, a gently pulsing full ring while it is almost
        /// ready; nothing once it is ready. On by default (D95, an exception to the default-off rule the user asked for).
        /// </summary>
        public bool ArrStatusArtworkProgressEnabled { get; set; } = true;

        // ---- end D95 ----

        /// <summary>What the household calls the person who runs the server ("Dad"); empty uses a neutral word. Shown in family status texts.</summary>
        public string ArrHouseholdContactName { get; set; } = string.Empty;

        /// <summary>
        /// Jellyfin's address as Sonarr/Radarr see it (for example <c>http://jellyfin:8096</c>), used
        /// when setting up their webhooks. Empty: the administrator types it when setting one up.
        /// </summary>
        public string ArrWebhookJellyfinUrl { get; set; } = string.Empty;

        /// <summary>
        /// The "Requests" page (<c>#/requests</c>, sidebar link): everyone's own requests (My requests,
        /// Coming soon, Ready); administrators also get the Downloads and Calendar pages as tabs. Needs
        /// phase 1. On by default (when phase 1 is on).
        /// </summary>
        public bool ArrRequestsHubEnabled { get; set; } = true;

        /// <summary>
        /// The administrator's "Manage" drawer on details pages (and in the Seerr more-info modal):
        /// why a title is where it is, its timeline and copies across instances, Search now and
        /// Open in Sonarr/Radarr. Needs phase 1. On by default (when phase 1 is on).
        /// </summary>
        public bool ArrManageDrawerEnabled { get; set; } = true;

        /// <summary>Show the status pill in the Seerr more-info modal (titles not in the library yet). Needs phase 1. On by default.</summary>
        public bool ArrSeerrModalStatus { get; set; } = true;

        /// <summary>
        /// How often Seerr's request list is read again for the status and the Requests page (minutes,
        /// 1-60, default 5; every 30 seconds while someone has the Requests page open). Requests made
        /// or answered through Jellyfin Enhanced are picked up at once.
        /// </summary>
        public int ArrSeerrRefreshMinutes { get; set; } = 5;

        // ---- Requests & downloads, phase 2: "Tell me" (notifications) and admin essentials (hub
        // Overview / Activity / System / Audit, queue actions, Needs attention, Jellyfin bridge,
        // activity log mirror) ----

        /// <summary>
        /// Phase 2 of "Requests &amp; downloads (new)". Needs <see cref="ArrIntegrationEnabled"/> and
        /// <see cref="ArrPhase1Enabled"/>. Off by default. It brings notifications (when
        /// <see cref="ArrNotificationsEnabled"/> is on) and gives administrators the Overview, Activity,
        /// System and Audit tabs on the Requests page.
        /// </summary>
        public bool ArrPhase2Enabled { get; set; }

        /// <summary>
        /// After Sonarr/Radarr import a file, refresh only the nearest existing Jellyfin folder
        /// (never a TV library's root) so the item appears within seconds instead of waiting for a
        /// library scan. Needs phase 2. On by default (when phase 2 is on).
        /// </summary>
        public bool ArrTargetedRefreshEnabled { get; set; } = true;

        /// <summary>Minutes after an import before a file Jellyfin still doesn't have is listed under Needs attention ("In Sonarr, not in Jellyfin"). 1-1440, default 10.</summary>
        public int ArrLibraryPendingMinutes { get; set; } = 10;

        // ---- Bridge fix (new imports are hydrated before they are Ready)

        /// <summary>
        /// Seconds an imported file must stay unchanged (size and last write, looked at twice) before Jellyfin is asked to
        /// read it, so a copy still being written is never probed. 0-60, default 3; 0 skips the check.
        /// </summary>
        public int ArrBridgeStableSeconds { get; set; } = 3;

        /// <summary>
        /// Minutes a just-imported title waits for its Jellyfin metadata (title, overview, poster, media info) before it is
        /// shown Ready anyway, with "metadata pending" in the logs (a provider that is down or has nothing). 1-120, default 10.
        /// </summary>
        public int ArrBridgeMetadataWaitMinutes { get; set; } = 10;

        // ---- end bridge fix

        /// <summary>A Sonarr/Radarr root folder whose disk has less than this share free (percent) is listed under Needs attention. 1-50, default 10.</summary>
        public int ArrLowDiskPercent { get; set; } = 10;

        /// <summary>
        /// Minutes after Seerr OK'd a request before administrators are told no Sonarr/Radarr has it
        /// (Seerr's own Sonarr/Radarr settings are the usual cause). 1-1440, default 15. Family
        /// members see "Taking longer than usual" only after <see cref="ArrStatusLookingHours"/>.
        /// </summary>
        public int ArrSeerrHandoffGraceMinutes { get; set; } = 15;

        /// <summary>Copy every audited arr action (who, what, outcome) into Jellyfin's own activity log. Needs phase 2. On by default.</summary>
        public bool ArrActivityLogMirror { get; set; } = true;

        /// <summary>
        /// Notifications: "Notify me" on titles, a bell with the inbox, toasts, phone (ntfy) and e-mail
        /// alerts, admin alerts and "Remind". Needs phase 2. On by default (when phase 2 is on).
        /// </summary>
        public bool ArrNotificationsEnabled { get; set; } = true;

        /// <summary>The household's Jellyfin address for links in phone alerts and e-mails (e.g. https://jellyfin.example.com). Empty: no links.</summary>
        public string ArrNotifyHouseholdUrl { get; set; } = string.Empty;

        /// <summary>New episodes of one series are gathered into one message for this many minutes (1-60, default 10).</summary>
        public int ArrNotifyBatchMinutes { get; set; } = 10;

        /// <summary>Administrators are told when an instance has not answered for this many minutes (1-1440, default 10).</summary>
        public int ArrNotifyAdminDownMinutes { get; set; } = 10;

        /// <summary>The daily digest lists downloads that have needed attention for at least this many hours (1-168, default 6).</summary>
        public int ArrNotifyAdminStuckHours { get; set; } = 6;

        /// <summary>Hour of the day (server time, 0-23) the stuck-downloads digest goes out. Default 9.</summary>
        public int ArrNotifyDigestHour { get; set; } = 9;

        /// <summary>Phone alerts through ntfy (the administrator's ntfy server; each user picks a topic).</summary>
        public bool ArrNtfyEnabled { get; set; }

        /// <summary>The ntfy server (e.g. https://ntfy.sh or a self-hosted one). Users can't change it.</summary>
        public string ArrNtfyServerUrl { get; set; } = string.Empty;

        /// <summary>Optional ntfy access token (for servers that require one to publish). Stored outside the configuration; only ever shown masked.</summary>
        public string ArrNtfyToken { get; set; } = string.Empty;

        /// <summary>E-mail alerts through the administrator's SMTP server (users verify their own address).</summary>
        public bool ArrEmailEnabled { get; set; }

        /// <summary>SMTP server host name or address.</summary>
        public string ArrSmtpHost { get; set; } = string.Empty;

        /// <summary>SMTP port (default 587).</summary>
        public int ArrSmtpPort { get; set; } = 587;

        /// <summary>Use STARTTLS (recommended; port 587). Implicit TLS on port 465 is not supported.</summary>
        public bool ArrSmtpStartTls { get; set; } = true;

        /// <summary>SMTP user name (empty: no authentication).</summary>
        public string ArrSmtpUsername { get; set; } = string.Empty;

        /// <summary>SMTP password. Stored outside the configuration; only ever shown masked.</summary>
        public string ArrSmtpPassword { get; set; } = string.Empty;

        /// <summary>The sender address of notification e-mails.</summary>
        public string ArrSmtpFrom { get; set; } = string.Empty;

        /// <summary>The sender name of notification e-mails (default "Jellyfin").</summary>
        public string ArrSmtpFromName { get; set; } = "Jellyfin";

        /// <summary>
        /// Folder the scheduled "Back up Jellyfin Enhanced data" task writes to. Empty: the
        /// <c>backups</c> folder inside JE's data folder.
        /// </summary>
        public string BackupFolder { get; set; } = string.Empty;

        /// <summary>Scheduled backups kept in <see cref="BackupFolder"/> (older ones are removed). 1-100.</summary>
        public int BackupCopiesToKeep { get; set; } = 7;

        /// <summary>Scheduled backups include the stored credentials, encrypted with <see cref="BackupPassphrase"/>. Off by default.</summary>
        public bool BackupIncludeSecrets { get; set; }

        /// <summary>Passphrase for credentials in scheduled backups (a stored credential: placeholder only).</summary>
        public string BackupPassphrase { get; set; } = string.Empty;

        // Shoko Settings — single-instance (URL + API key), like Jellyseerr, not the
        // Sonarr/Radarr instance-list pattern: Shoko is one server per household.
        public string ShokoUrl { get; set; }
        public string ShokoApiKey { get; set; }
        public string ShokoUrlMappings { get; set; }

        // Which AniDB episode types to include on the calendar — Credits/Trailer/Parody/Other
        // default off since they're calendar noise for most users.
        public bool ShokoShowEpisodes { get; set; }
        public bool ShokoShowSpecials { get; set; }
        public bool ShokoShowCredits { get; set; }
        public bool ShokoShowTrailers { get; set; }
        public bool ShokoShowParodies { get; set; }
        public bool ShokoShowOther { get; set; }

        /// <summary>The arr tag prefix used when none is configured (also the configuration page's fallback).</summary>
        public const string DefaultArrTagsPrefix = "JE Arr Tag: ";

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

        // Audio Language Tags Sync Settings
        public bool AudioLanguageTagSyncEnabled { get; set; }
        public string AudioLanguageTagPrefix { get; set; }
        public bool AudioLanguageTagShowAsLinks { get; set; }

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
        public bool SyncJellyfinWatchlistToSeerr { get; set; }
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
        /// Shows Bookmarks as a self-contained tab on the Home page, created and
        /// managed entirely by Jellyfin Enhanced's own injected script (see
        /// js/enhanced/native-tabs.js) -- no external Custom Tabs plugin required.
        /// Recommended on Jellyfin 12's experimental layout (the default there),
        /// where the legacy Custom-Tabs/Plugin-Pages integration points are hidden.
        /// </summary>
        public bool BookmarksUseNativeTab { get; set; }
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
        [AnalyticsExclude]
        public bool BookmarksCustomTabJeOwned { get; set; }

        // Icon Settings
        public bool UseIcons { get; set; }
        [AnalyticsInclude]
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

        // Activity Feed Settings -- server-wide "recent activity" tab (recently
        // watched, favorited, reviewed). Each entry is filtered per-viewer by
        // library access before being shown, same as the tag cache.
        public bool ActivityFeedEnabled { get; set; }
        public bool ActivityFeedShowWatched { get; set; } = true;
        public bool ActivityFeedShowFavorited { get; set; } = true;
        public bool ActivityFeedShowReviewed { get; set; } = true;
        /// <summary>
        /// When true, non-admins only see their own entries in the Activity Feed.
        /// Admins always see everyone.
        /// </summary>
        public bool ActivityFeedOwnOnlyForNonAdmins { get; set; }
        /// <summary>
        /// Shows the Active Streams section on the Activity Feed page. This is
        /// separate from ActiveStreamsEnabled (the header widget toggle) so an
        /// admin can run the section here without the persistent header icon,
        /// or vice versa -- but the underlying live-session data still requires
        /// ActiveStreamsEnabled to be on somewhere, since that's what gates the
        /// active-streams/sessions endpoint itself.
        /// </summary>
        public bool ActivityFeedShowActiveStreams { get; set; } = true;
        public bool ActivityFeedUsePluginPages { get; set; }
        public bool ActivityFeedUseCustomTabs { get; set; }
        /// <summary>
        /// Shows Activity as a self-contained tab on the Home page, created and
        /// managed entirely by Jellyfin Enhanced's own injected script (see
        /// js/enhanced/native-tabs.js) -- no external Custom Tabs plugin required.
        /// Recommended on Jellyfin 12's experimental layout (the default there),
        /// where the legacy Custom-Tabs/Plugin-Pages integration points are hidden.
        /// </summary>
        public bool ActivityFeedUseNativeTab { get; set; }
        public bool ActivityFeedAutoCreateCustomTab { get; set; }
        [AnalyticsExclude]
        public bool ActivityFeedCustomTabJeOwned { get; set; }

        // Requests Page Settings (Sonarr/Radarr Queue Monitoring)
        public bool DownloadsPageEnabled { get; set; }
        public bool DownloadsUsePluginPages { get; set; }
        public bool DownloadsUseCustomTabs { get; set; }
        /// <summary>
        /// Shows Requests as a self-contained tab on the Home page, created and
        /// managed entirely by Jellyfin Enhanced's own injected script (see
        /// js/enhanced/native-tabs.js) -- no external Custom Tabs plugin required.
        /// Recommended on Jellyfin 12's experimental layout (the default there),
        /// where the legacy Custom-Tabs/Plugin-Pages integration points are hidden.
        /// </summary>
        public bool DownloadsUseNativeTab { get; set; }
        public bool DownloadsAutoCreateCustomTab { get; set; }
        [AnalyticsExclude]
        public bool DownloadsCustomTabJeOwned { get; set; }
        public bool DownloadsPagePollingEnabled { get; set; }
        public int DownloadsPollIntervalSeconds { get; set; }
        public bool DownloadsPageShowIssues { get; set; }
        public bool ShowDownloadsInRequests { get; set; }
        public bool DownloadsFilterByUserRequests { get; set; }
        public bool DownloadsShowHistory { get; set; }
        public bool DownloadsHistoryAdminOnly { get; set; }

        // Calendar Page Settings (Sonarr/Radarr Releases)
        public bool CalendarPageEnabled { get; set; }
        public bool CalendarUseCustomTabs { get; set; }
        public bool CalendarUsePluginPages { get; set; }
        /// <summary>
        /// Shows Calendar as a self-contained tab on the Home page, created and
        /// managed entirely by Jellyfin Enhanced's own injected script (see
        /// js/enhanced/native-tabs.js) -- no external Custom Tabs plugin required.
        /// Recommended on Jellyfin 12's experimental layout (the default there),
        /// where the legacy Custom-Tabs/Plugin-Pages integration points are hidden.
        /// </summary>
        public bool CalendarUseNativeTab { get; set; }
        public bool CalendarAutoCreateCustomTab { get; set; }
        [AnalyticsExclude]
        public bool CalendarCustomTabJeOwned { get; set; }
        public string CalendarFirstDayOfWeek { get; set; }
        public string CalendarTimeFormat { get; set; }
        public bool CalendarHighlightFavorites { get; set; }
        public bool CalendarHighlightWatchedSeries { get; set; }
        public bool CalendarFilterByLibraryAccess { get; set; }
        public bool CalendarShowOnlyRequested { get; set; }
        public bool CalendarForceOnlyRequested { get; set; }

        // Recommendations Page Settings (Jellyseerr discover rows)
        public bool RecommendationsPageEnabled { get; set; }
        public bool RecommendationsUsePluginPages { get; set; }
        public bool RecommendationsUseCustomTabs { get; set; }
        public bool RecommendationsUseNativeTab { get; set; }
        public bool RecommendationsAutoCreateCustomTab { get; set; }
        [AnalyticsExclude]
        public bool RecommendationsCustomTabJeOwned { get; set; }

        // Hidden Content Settings
        public bool HiddenContentEnabled { get; set; }
        public bool HiddenContentUsePluginPages { get; set; }
        public bool HiddenContentUseCustomTabs { get; set; }
        /// <summary>
        /// Shows Hidden Content as a self-contained tab on the Home page, created
        /// and managed entirely by Jellyfin Enhanced's own injected script (see
        /// js/enhanced/native-tabs.js) -- no external Custom Tabs plugin required.
        /// Recommended on Jellyfin 12's experimental layout (the default there),
        /// where the legacy Custom-Tabs/Plugin-Pages integration points are hidden.
        /// </summary>
        public bool HiddenContentUseNativeTab { get; set; }
        public bool HiddenContentAutoCreateCustomTab { get; set; }
        [AnalyticsExclude]
        public bool HiddenContentCustomTabJeOwned { get; set; }

        // Admin cross-user hidden-content view + management
        public bool HiddenContentAdmin { get; set; }

        // Catch Up page: a swipeable deck for marking titles watched, dismissed or watchlisted
        public bool CatchUpEnabled { get; set; }
        public bool CatchUpUsePluginPages { get; set; }
        public bool CatchUpUseNativeTab { get; set; }
        public bool CatchUpUseCustomTabs { get; set; }
        public bool CatchUpAutoCreateCustomTab { get; set; }
        [AnalyticsExclude]
        public bool CatchUpCustomTabJeOwned { get; set; }
        // Logs who swiped what. Admins read it on the page.
        public bool CatchUpLogEnabled { get; set; } = true;

        // Hidden Content per-user defaults
        public bool HiddenContentDefaultEnabled { get; set; }
        public bool HiddenContentDefaultShowHideButtons { get; set; }
        public bool HiddenContentDefaultShowHideConfirmation { get; set; }
        public bool HiddenContentDefaultShowButtonJellyseerr { get; set; }
        public bool HiddenContentDefaultShowButtonLibrary { get; set; }
        public bool HiddenContentDefaultShowButtonDetails { get; set; }
        public bool HiddenContentDefaultShowButtonCast { get; set; }
        public bool HiddenContentDefaultFilterLibrary { get; set; }
        public bool HiddenContentDefaultFilterDiscovery { get; set; }
        public bool HiddenContentDefaultFilterSearch { get; set; }
        public bool HiddenContentDefaultFilterCalendar { get; set; }
        public bool HiddenContentDefaultFilterUpcoming { get; set; }
        public bool HiddenContentDefaultFilterRecommendations { get; set; }
        public bool HiddenContentDefaultFilterRequests { get; set; }
        public bool HiddenContentDefaultFilterNextUp { get; set; }
        public bool HiddenContentDefaultFilterContinueWatching { get; set; }
        public bool HiddenContentDefaultExperimentalHideCollections { get; set; }

        // When enabled by admin AND opted-in per-show by a user, an MVC action
        // filter replaces UNWATCHED-episode images with a SkiaSharp Gaussian blur
        // (sigma=Intensity, tile-mode Clamp) on the wire, so every client gets
        // the blurred bytes natively.
        public bool SpoilerBlurEnabled { get; set; } = false;
        // Gaussian sigma passed to Skia. 1 = barely blurred, 100 = heavily
        // blurred. Default 40 hides scene content while keeping silhouettes and
        // dominant colours visible.
        public int SpoilerBlurIntensity { get; set; } = 40;

        // When SpoilerBlurEnabled is on AND the user has the parent series in
        // their spoiler list AND the episode is unwatched, an MVC action filter
        // nulls/replaces these BaseItemDto fields. Each toggle is independent and
        // defaults ON (strictest posture); admins relax them in the configPage.
        // Series descriptions have their own toggle because the Series DTO has no
        // watched state and some users still want the show's high-level premise
        // visible while episode-level plot details remain protected. Null means
        // this is an upgraded config that predates the split; consumers fall back
        // to SpoilerStripOverview so the server's previous behavior is preserved
        // until the admin saves an explicit independent choice.
        public bool? SpoilerStripSeriesOverview { get; set; }
        public bool SpoilerStripOverview { get; set; } = true;
        public bool SpoilerStripTags { get; set; } = true;
        public bool SpoilerStripChapters { get; set; } = true;
        public bool SpoilerStripTaglines { get; set; } = true;
        // Single toggle nulls BOTH community and critic ratings on guarded
        // unwatched episodes — consolidated because either leaks the same
        // "how good is this episode" signal.
        public bool SpoilerStripRatings { get; set; } = true;
        public bool SpoilerStripPremiereDate { get; set; } = true;
        // Episode names become "Season X, Episode Y" instead of leaking spoiler
        // titles. On by default; admins can untick it (some clients show the title
        // in nav tooltips/breadcrumbs, where the change can feel jarring).
        public bool SpoilerReplaceTitle { get; set; } = true;
        // StripCast strips cast on unwatched episodes. StripCastMode: "GuestStars"
        // (only Type=GuestStar removed, regular cast kept — default) or "All"
        // (every People entry). Default GuestStars, since most series leak via
        // guest stars only.
        public bool SpoilerStripCast { get; set; } = true;
        public string SpoilerStripCastMode { get; set; } = "GuestStars";
        // Hide the JE Reviews panel on guarded Series pages — TMDB and
        // user-written reviews routinely leak plot spoilers. Default ON since
        // the spoiler risk dwarfs the UX cost.
        public bool SpoilerStripReviews { get; set; } = true;
        // "hide" (default) substitutes a parent-level placeholder picked by aspect
        // (Series Backdrop for episodes, Series Primary for seasons, Collection
        // Primary for collection-opted movies, flat dark card otherwise), fully
        // hiding episode-specific imagery. "blur" runs the SkiaSharp Gaussian on
        // the original bytes so silhouettes / dominant colours remain visible.
        public string SpoilerBlurMode { get; set; } = "hide";
        // False (default): only Primary/Thumb/Screenshot blur; Backdrop/Art pass
        // through unblurred. True: blur those too. Default scopes blur to the
        // poster surface, where most spoiler risk lives (backdrops are usually
        // less plot-specific than curated poster art).
        public bool SpoilerBlurArtwork { get; set; } = false;
        // On a user's first-ever play of a series' S1E1, auto-adds it to their
        // spoiler list (UserSpoilerBlur.Series). History is checked via
        // IUserDataManager so rewatches don't re-trigger.
        public bool SpoilerAutoEnableOnFirstPlay { get; set; } = false;
        // Each successful Seerr request via JE registers a pending entry
        // (UserSpoilerBlur.PendingTmdb); when the content lands,
        // SpoilerSeerrPendingPromoter moves it into Series/Movies. This toggle
        // controls only the auto-on-request path — manual opt-in from the Seerr
        // more-info modal stays available (gated only by SpoilerBlurEnabled).
        public bool SpoilerAutoEnableOnSeerrRequest { get; set; } = false;
        // When true, every new Series/Movie that lands in the library (any
        // source: scan, Seerr, manual copy) is added to the Spoiler Guard list
        // of every user who can see its library — before anyone presses play.
        // SpoilerLibraryAddAutoEnabler batches the ItemAdded burst of a scan
        // into one file write per user.
        public bool SpoilerAutoEnableOnLibraryAdd { get; set; } = false;
        // Scope shared by all three auto-enable modes (first play, Seerr
        // request, library add): which content types qualify, and an optional
        // library allow-list (comma-separated library ids; empty = every
        // library). The library filter can't apply to a Seerr request (the
        // title isn't in a library yet). Defaults = everything, so existing
        // installs keep their current auto-enable behaviour.
        public bool SpoilerAutoEnableSeries { get; set; } = true;
        public bool SpoilerAutoEnableMovies { get; set; } = true;
        public string SpoilerAutoEnableLibraryIds { get; set; } = "";
        // True: toggling Spoiler Guard also fires a full page reload so DTO-derived
        // text (Overview, titles, ratings) updates immediately. False (default):
        // only the in-place image-URL refresh runs — image bytes flip at once but
        // page text stays stale until the next navigation. Off by default for a
        // smoother refresh (no full-page flash).
        public bool SpoilerBlurStrictRefresh { get; set; } = false;
        // True (default): a listed movie's Primary/Thumb pass unblurred even with
        // the master switch on; its Chapter thumbs, Screenshots, and (if
        // SpoilerBlurArtwork) Backdrop/Art still follow protection. Movie posters
        // are usually curated marketing art, while chapter scene-thumbs (and
        // synopsis/cast) are the real spoiler vector. Off = hide posters too.
        public bool SpoilerKeepMoviePosters { get; set; } = true;
        // True (default): trickplay seek-preview tile sheets of a listed, unwatched
        // episode/movie are protected (sheets that end before the saved resume
        // point still pass through). Off = seek previews always pass through
        // (served no-store). Users can also opt out per-user via
        // SpoilerBlurUserPrefs.HideTrickplay; the admin switch caps it.
        public bool SpoilerBlurTrickplay { get; set; } = true;
        // Advanced per-category reveals. When on, the user's NEXT unwatched
        // regular episode and the rest of its season get their own strip masks
        // below instead of the uniform full strip; every other unwatched
        // episode (later seasons, skipped earlier seasons, specials) keeps the
        // full strip. Category resolution failure of any kind falls back to
        // the full strip.
        public bool SpoilerAdvancedMode { get; set; } = false;
        // Per-category field masks, same "true = strip" polarity as the base
        // toggles above. A category mask can only RELAX a base strip that is
        // already on — it never strips a field whose base toggle (or the
        // user's per-field opt-out) has disabled stripping.
        public bool SpoilerNextEpisodeStripTitle { get; set; } = false;
        public bool SpoilerNextEpisodeStripOverview { get; set; } = true;
        public bool SpoilerNextEpisodeStripRatings { get; set; } = true;
        public bool SpoilerNextEpisodeStripImage { get; set; } = true;
        public bool SpoilerCurrentSeasonStripTitle { get; set; } = true;
        public bool SpoilerCurrentSeasonStripOverview { get; set; } = true;
        public bool SpoilerCurrentSeasonStripRatings { get; set; } = true;
        // Placeholder for stripped Overview so the client doesn't render a
        // "Description" header over blank. Configurable for localisation.
        public string SpoilerOverviewPlaceholder { get; set; } = "Spoiler Guard activated";

        // Usage Statistics: opt-in anonymous analytics reported to the
        // Jellyfin Enhanced community analytics project. See
        // AnalyticsReportingService for exactly what's collected; every
        // category below is independently toggleable and the master switch
        // defaults off. A live "what would be sent" preview on the config
        // page reads the same AnalyticsReportingService.BuildPayload the
        // real report uses, so it can never drift from reality.
        public bool AnalyticsEnabled { get; set; }
        /// <summary>Shares a boolean on/off snapshot of every feature toggle (never URLs/keys/free text).</summary>
        public bool AnalyticsShareFeatureFlags { get; set; } = true;
        /// <summary>Shares per-feature usage counters (e.g. "seerr.request_submitted": 12), reset each period after a successful send.</summary>
        public bool AnalyticsShareUsageCounts { get; set; } = true;
        /// <summary>Shares byte sizes only (never contents) of the plugin's own on-disk data files; see AnalyticsReportingService.GetDataFileSizes for exactly what's included.</summary>
        public bool AnalyticsShareDataSizes { get; set; } = true;
        /// <summary>
        /// Hidden field, no UI. True once the admin has explicitly saved the
        /// master toggle on at least once; used only to decide whether
        /// turning the master ON should cascade the three sub-toggles to ON
        /// (first time) or leave them exactly as the admin last set them
        /// (every time after).
        /// </summary>
        public bool AnalyticsHasBeenConfigured { get; set; }
        /// <summary>Hidden field, no UI. Server-minted (not client-generated) on first opt-in; never derived from anything identifying.</summary>
        public string AnalyticsInstallId { get; set; } = string.Empty;
        /// <summary>Hidden field, no UI. High-entropy secret issued alongside AnalyticsInstallId at registration; required on every report so a guessed/leaked install id alone can't be used to overwrite or impersonate this install.</summary>
        public string AnalyticsInstallSecret { get; set; } = string.Empty;
        /// <summary>Admin-configurable reporting cadence in days. Clamped to 7-30 wherever it's read.</summary>
        public int AnalyticsReportIntervalDays { get; set; } = 15;
        /// <summary>Hidden field, no UI. Unix ms of the last successful report; drives the config page's "Last sent" display and the task's due-check.</summary>
        public long AnalyticsLastReportedAt { get; set; }
        /// <summary>Hidden field, no UI. The exact JSON payload from the last successful report, shown verbatim on the config page.</summary>
        public string AnalyticsLastPayloadJson { get; set; } = string.Empty;
        /// <summary>Hidden field, no UI. Full plugin assembly version at the last successful report; changes bypass the reporting interval.</summary>
        public string AnalyticsLastReportedPluginVersion { get; set; } = string.Empty;
        /// <summary>Hidden field, no UI. Compiled build target at the last successful report; detects same-version build corrections.</summary>
        public string AnalyticsLastReportedJellyfinTarget { get; set; } = string.Empty;
        /// <summary>Hidden field, no UI. Running Jellyfin version at the last successful report; detects host upgrades independently of plugin upgrades.</summary>
        public string AnalyticsLastReportedJellyfinVersion { get; set; } = string.Empty;
        /// <summary>
        /// Hidden field, no UI. Count of report_stats 403 responses since the
        /// last successful report. PERSISTED (not an in-memory field) because
        /// send attempts happen at most daily: an in-memory counter on a
        /// server restarted every day or two would never reach the
        /// re-registration threshold and the install would 403 forever — the
        /// exact stuck state the threshold logic exists to escape.
        /// </summary>
        public int AnalyticsForbiddenSinceLastSuccess { get; set; }

        /// <summary>
        /// The only shape of MaintenanceModeAffectedUsers that may ever leave
        /// the server: the raw value can be a JSON array of real Jellyfin user
        /// GUIDs. Shared by the analytics payload (AnalyticsReportingService.
        /// GetStringSettings) and the anonymous public-config endpoint so the
        /// two can never drift apart or regress to exposing the raw value.
        /// Empty/unset means the default, i.e. "all".
        /// </summary>
        public static string DeriveAffectedUsersShape(string? value) =>
            string.IsNullOrEmpty(value) || value == "all" ? "all" : "selected";

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

            var legacyKey = GetSecret(nameof(SonarrApiKey));
            if (parseResult == InstanceParseResult.ExplicitlyEmpty
                && !string.IsNullOrWhiteSpace(SonarrUrl)
                && !string.IsNullOrWhiteSpace(legacyKey))
            {
                return new List<ArrInstance>
                {
                    new ArrInstance
                    {
                        Name = "Sonarr",
                        Url = SonarrUrl,
                        ApiKey = legacyKey,
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

            var legacyKey = GetSecret(nameof(RadarrApiKey));
            if (parseResult == InstanceParseResult.ExplicitlyEmpty
                && !string.IsNullOrWhiteSpace(RadarrUrl)
                && !string.IsNullOrWhiteSpace(legacyKey))
            {
                return new List<ArrInstance>
                {
                    new ArrInstance
                    {
                        Name = "Radarr",
                        Url = RadarrUrl,
                        ApiKey = legacyKey,
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

        /// <summary>
        /// True when both <see cref="ShokoUrl"/> and <see cref="ShokoApiKey"/> are set. Unlike
        /// Sonarr/Radarr, there is no JSON instance list to corrupt — Shoko is two flat fields.
        /// </summary>
        public bool IsShokoConfigured()
            => !string.IsNullOrWhiteSpace(ShokoUrl) && !string.IsNullOrWhiteSpace(GetShokoApiKey());

        internal enum InstanceParseResult { ExplicitlyEmpty, Parsed, Corrupt }

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
                // Keys are stored as placeholders; resolve each row's real key from the secrets
                // store (a raw key in a not-yet-migrated row passes through unchanged) BEFORE the
                // empty-key filter, so a row whose stored key went missing counts as incomplete.
                var filtered = instances
                    .Where(i => i != null && !string.IsNullOrWhiteSpace(i.Url))
                    .Select(i =>
                    {
                        i.ApiKey = ResolveStoredValue(i.ApiKey, string.IsNullOrEmpty(i.Id) ? null : Services.Secrets.SecretsStore.ArrKeyName(i.Id));
                        return i;
                    })
                    .Where(i => !string.IsNullOrWhiteSpace(i.ApiKey))
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
