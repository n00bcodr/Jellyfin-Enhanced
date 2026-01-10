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
            ShowFileSizes = false;
            RemoveContinueWatchingEnabled = false;
            ShowAudioLanguages = true;
            ShowReviews = false;
            ReviewsExpandedByDefault = false;
            PauseScreenEnabled = true;
            QualityTagsEnabled = false;
            GenreTagsEnabled = false;
            LanguageTagsEnabled = false;
            RatingTagsEnabled = false;
            TagsCacheTtlDays = 30;
            DisableTagsOnSearchPage = false;
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

            // Jellyseerr Search Settings
            JellyseerrEnabled = false;
            JellyseerrShowReportButton = false;
            JellyseerrEnable4KRequests = false;
            JellyseerrShowAdvanced = false;
            JellyseerrShowSimilar = true;
            JellyseerrShowRecommended = true;
            JellyseerrShowNetworkDiscovery = true;
            JellyseerrShowGenreDiscovery = true;
            JellyseerrShowTagDiscovery = true;
            JellyseerrShowPersonDiscovery = true;
            ShowElsewhereOnJellyseerr = false;
            JellyseerrUseMoreInfoModal = false;
            JellyseerrUrls = "";
            JellyseerrApiKey = "";
            JellyseerrUrlMappings = "";
            ShowCollectionsInSearch = true;

            // Arr Links Settings
            ArrLinksEnabled = false;
            SonarrUrl = "";
            RadarrUrl = "";
            BazarrUrl = "";
            ShowArrLinksAsText = false;

            // Arr Tags Sync Settings
            ArrTagsSyncEnabled = false;
            SonarrApiKey = "";
            RadarrApiKey = "";
            ArrTagsPrefix = "JE Arr Tag: ";
            ArrTagsClearOldTags = true;
            ArrTagsShowAsLinks = true;
            ArrTagsLinksFilter = "";
            ArrTagsLinksHideFilter = "";

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

            // Watchlist Settings
            AddRequestedMediaToWatchlist = false;
            SyncJellyseerrWatchlist = false;

            // Bookmarks Settings
            BookmarksEnabled = true;

            // Icon Settings
            UseIcons = true;
            IconStyle = "emoji";
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
        public bool ShowFileSizes { get; set; }
        public bool RemoveContinueWatchingEnabled { get; set; }
        public bool ShowAudioLanguages { get; set; }
        public bool ShowReviews { get; set; }
        public bool ReviewsExpandedByDefault { get; set; }
        public List<Shortcut> Shortcuts { get; set; }
        public bool PauseScreenEnabled { get; set; }
        public bool QualityTagsEnabled { get; set; }
        public bool LanguageTagsEnabled { get; set; }
        public bool RatingTagsEnabled { get; set; }
        public int TagsCacheTtlDays { get; set; }
        public bool DisableTagsOnSearchPage { get; set; }
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

        // Jellyseerr Search Settings
        public bool JellyseerrEnabled { get; set; }
        public bool JellyseerrShowReportButton { get; set; }
        public bool JellyseerrEnable4KRequests { get; set; }
        public bool JellyseerrShowAdvanced { get; set; }
        public bool JellyseerrShowSimilar { get; set; }
        public bool JellyseerrShowRecommended { get; set; }
        public bool JellyseerrShowNetworkDiscovery { get; set; }
        public bool JellyseerrShowGenreDiscovery { get; set; }
        public bool JellyseerrShowTagDiscovery { get; set; }
        public bool JellyseerrShowPersonDiscovery { get; set; }
        public bool JellyseerrExcludeLibraryItems { get; set; } = true;
        public bool ShowElsewhereOnJellyseerr { get; set; }
        public bool JellyseerrUseMoreInfoModal { get; set; } = false;
        public string JellyseerrUrls { get; set; }
        public string JellyseerrApiKey { get; set; }
        public string JellyseerrUrlMappings { get; set; }
        public bool ShowCollectionsInSearch { get; set; }

        // Arr Links Settings
        public bool ArrLinksEnabled { get; set; }
        public string SonarrUrl { get; set; }
        public string RadarrUrl { get; set; }
        public string BazarrUrl { get; set; }
        public bool ShowArrLinksAsText { get; set; }

        // Arr Tags Sync Settings
        public bool ArrTagsSyncEnabled { get; set; }
        public string SonarrApiKey { get; set; }
        public string RadarrApiKey { get; set; }
        public string ArrTagsPrefix { get; set; }
        public bool ArrTagsClearOldTags { get; set; }
        public bool ArrTagsShowAsLinks { get; set; }
        public string ArrTagsLinksFilter { get; set; }
        public string ArrTagsLinksHideFilter { get; set; }

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

        // Watchlist Settings
        public bool AddRequestedMediaToWatchlist { get; set; }
        public bool SyncJellyseerrWatchlist { get; set; }

        // Bookmarks Settings
        public bool BookmarksEnabled { get; set; }

        // Icon Settings
        public bool UseIcons { get; set; }
        public string IconStyle { get; set; }
    }
}