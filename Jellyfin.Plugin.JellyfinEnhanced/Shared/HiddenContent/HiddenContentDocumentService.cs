using System;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.Library;

namespace Jellyfin.Plugin.JellyfinEnhanced.Shared.HiddenContent
{
    /// <summary>
    /// Reads a user's hidden-content.json, seeding it from the plugin defaults on first access. Moved verbatim from the
    /// controller in restructure S2.9; GET hidden-content.json (HiddenContent) and /bootstrap (Platform) both use it.
    /// It never reads the request's user: callers pass the id they authorized.
    /// </summary>
    public class HiddenContentDocumentService
    {
        private readonly UserConfigurationManager _userConfigurationManager;
        private readonly Logger _logger;
        private readonly UserDisplayResolver _userDisplayResolver;

        public HiddenContentDocumentService(UserConfigurationManager userConfigurationManager, Logger logger, UserDisplayResolver userDisplayResolver)
        {
            _userConfigurationManager = userConfigurationManager;
            _logger = logger;
            _userDisplayResolver = userDisplayResolver;
        }

        /// <summary>
        /// Loads (seeding defaults on first access) the user's hidden-content.json
        /// document. Shared by the hidden-content.json endpoint and /bootstrap.
        /// Throws, and leaves the file as it is, when the stored list cannot be read or parsed:
        /// the client saves the whole list, so an empty stand-in would replace it.
        /// </summary>
        public UserHiddenContent LoadUserHiddenContentDocument(string authorizedUserId)
        {
            // First-time init: seed Settings from admin defaults under RMW so a parallel CW hide can't clobber it.
            var defaultConfig = JellyfinEnhanced.Instance?.Configuration;
            if (defaultConfig != null
                && !_userConfigurationManager.UserConfigurationExists(authorizedUserId, "hidden-content.json"))
            {
                try
                {
                    _userConfigurationManager.RmwUserConfiguration<UserHiddenContent>(
                        authorizedUserId, "hidden-content.json", hc =>
                        {
                            // Re-check inside the lock: another writer may have created the file in the meantime.
                            if (hc.Items.Count > 0) return 0;
                            hc.Settings = HiddenContentDefaults.BuildHcDefaultSettings(defaultConfig);
                            _logger.Info($"Seeded default hidden-content.json for new user {_userDisplayResolver.ResolveUserDisplay(authorizedUserId)} from plugin configuration.");
                            return 1;
                        });
                }
                catch (Exception ex)
                {
                    _logger.Warning($"Failed to seed hidden-content.json for {_userDisplayResolver.ResolveUserDisplay(authorizedUserId)}: {ex.Message}");
                }
            }

            return _userConfigurationManager.GetUserConfigurationStrict<UserHiddenContent>(authorizedUserId, "hidden-content.json", quarantineCorrupt: false);
        }
    }
}
