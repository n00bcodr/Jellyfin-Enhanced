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
            ShowFileSizes = false;
            RemoveContinueWatchingEnabled = false;
            ShowAudioLanguages = true;
            ShowReviews = false;
            ReviewsExpandedByDefault = false;
            PauseScreenEnabled = true;
            QualityTagsEnabled = false;
            GenreTagsEnabled = false;
            WatchlistEnabled = true;
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
                new Shortcut { Name = "ClearAllBookmarks", Key = "Ctrl+Shift+B", Label = "Clear All Bookmarks", Category = "Global" },
                new Shortcut { Name = "CycleAspectRatio", Key = "A", Label = "Cycle Aspect Ratio", Category = "Player" },
                new Shortcut { Name = "ShowPlaybackInfo", Key = "I", Label = "Show Playback Info", Category = "Player" },
                new Shortcut { Name = "SubtitleMenu", Key = "S", Label = "Subtitle Menu", Category = "Player" },
                new Shortcut { Name = "CycleSubtitleTracks", Key = "C", Label = "Cycle Subtitle Tracks", Category = "Player" },
                new Shortcut { Name = "CycleAudioTracks", Key = "V", Label = "Cycle Audio Tracks", Category = "Player" },
                new Shortcut { Name = "IncreasePlaybackSpeed", Key = "+", Label = "Increase Playback Speed", Category = "Player" },
                new Shortcut { Name = "DecreasePlaybackSpeed", Key = "-", Label = "Decrease Playback Speed", Category = "Player" },
                new Shortcut { Name = "ResetPlaybackSpeed", Key = "R", Label = "Reset Playback Speed", Category = "Player" },
                new Shortcut { Name = "BookmarkCurrentTime", Key = "B", Label = "Bookmark Current Time", Category = "Player" },
                new Shortcut { Name = "GoToSavedBookmark", Key = "Shift+B", Label = "Go to Saved Bookmark", Category = "Player" }
            };

            // Jellyseerr Search Settings
            JellyseerrEnabled = false;
            JellyseerrShowAdvanced = false;
            ShowElsewhereOnJellyseerr = false;
            JellyseerrUseJellyseerrLinks = false;
            JellyseerrUrls = "";
            JellyseerrApiKey = "";

            // Arr Links Settings
            ArrLinksEnabled = false;
            SonarrUrl = "";
            RadarrUrl = "";
            BazarrUrl = "";
            ShowArrLinksAsText = false;

            // commit hash for watchlist feature from kefinTweaks
            KefinTweaksVersion = "master";
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
        public bool ShowFileSizes { get; set; }
        public bool RemoveContinueWatchingEnabled { get; set; }
        public bool ShowAudioLanguages { get; set; }
        public bool ShowReviews { get; set; }
        public bool ReviewsExpandedByDefault { get; set; }
        public List<Shortcut> Shortcuts { get; set; }
        public bool PauseScreenEnabled { get; set; }
        public bool QualityTagsEnabled { get; set; }
        public bool WatchlistEnabled { get; set; }
        public bool DisableAllShortcuts { get; set; }
        public int DefaultSubtitleStyle { get; set; }
        public int DefaultSubtitleSize { get; set; }
        public int DefaultSubtitleFont { get; set; }
        public bool DisableCustomSubtitleStyles { get; set; }

        // Jellyseerr Search Settings
        public bool JellyseerrEnabled { get; set; }
        public bool JellyseerrShowAdvanced { get; set; }
        public bool ShowElsewhereOnJellyseerr { get; set; }
        public bool JellyseerrUseJellyseerrLinks { get; set; }
        public string JellyseerrUrls { get; set; }
        public string JellyseerrApiKey { get; set; }

        // Arr Links Settings
        public bool ArrLinksEnabled { get; set; }
        public string SonarrUrl { get; set; }
        public string RadarrUrl { get; set; }
        public string BazarrUrl { get; set; }
        public bool ShowArrLinksAsText { get; set; }
        public bool GenreTagsEnabled { get; set; }
        public string KefinTweaksVersion { get; set; }
    }
}