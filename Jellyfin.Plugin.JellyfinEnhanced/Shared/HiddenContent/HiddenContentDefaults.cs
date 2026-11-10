using Jellyfin.Plugin.JellyfinEnhanced.Configuration;

namespace Jellyfin.Plugin.JellyfinEnhanced.Shared.HiddenContent
{
    /// <summary>
    /// A user's starting Hidden Content settings, from the plugin's HiddenContentDefault* settings. Moved verbatim from
    /// JellyfinEnhancedController (restructure S2.8). Shared, not HiddenContent's own: Settings' reset-all-users-settings
    /// uses it too, and a controller may not reference another feature (backend.md §7).
    /// </summary>
    public static class HiddenContentDefaults
    {
        public static HiddenContentSettings BuildHcDefaultSettings(PluginConfiguration src)
        {
            return new HiddenContentSettings
            {
                Enabled = src.HiddenContentDefaultEnabled,
                ShowHideButtons = src.HiddenContentDefaultShowHideButtons,
                ShowHideConfirmation = src.HiddenContentDefaultShowHideConfirmation,
                ShowButtonJellyseerr = src.HiddenContentDefaultShowButtonJellyseerr,
                ShowButtonLibrary = src.HiddenContentDefaultShowButtonLibrary,
                ShowButtonDetails = src.HiddenContentDefaultShowButtonDetails,
                ShowButtonCast = src.HiddenContentDefaultShowButtonCast,
                FilterLibrary = src.HiddenContentDefaultFilterLibrary,
                FilterDiscovery = src.HiddenContentDefaultFilterDiscovery,
                FilterSearch = src.HiddenContentDefaultFilterSearch,
                FilterCalendar = src.HiddenContentDefaultFilterCalendar,
                FilterUpcoming = src.HiddenContentDefaultFilterUpcoming,
                FilterRecommendations = src.HiddenContentDefaultFilterRecommendations,
                FilterRequests = src.HiddenContentDefaultFilterRequests,
                FilterNextUp = src.HiddenContentDefaultFilterNextUp,
                FilterContinueWatching = src.HiddenContentDefaultFilterContinueWatching,
                ExperimentalHideCollections = src.HiddenContentDefaultExperimentalHideCollections,
            };
        }
    }
}
