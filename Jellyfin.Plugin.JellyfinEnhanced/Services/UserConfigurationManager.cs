using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using MediaBrowser.Common.Configuration;
using Newtonsoft.Json;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services
{
    public class UserConfigurationManager
    {
        private readonly string _configPath;
        private List<UserConfiguration> _userConfigs = new List<UserConfiguration>();

        public UserConfigurationManager(IApplicationPaths appPaths)
        {
            // Get the base path for all installed plugins (e.g., /var/lib/jellyfin/plugins)
            var basePluginsPath = appPaths.PluginsPath;

            // Manually construct the path exactly as you want it
            var customConfigDir = Path.Combine(basePluginsPath, "configurations", "Jellyfin.Plugin.JellyfinEnhanced");

            // Create the directory structure if it doesn't exist
            Directory.CreateDirectory(customConfigDir);

            // Set the final path for the user_preferences.json file
            _configPath = Path.Combine(customConfigDir, "user_preferences.json");

            LoadConfigurations();
        }

        private void LoadConfigurations()
        {
            if (File.Exists(_configPath))
            {
                var json = File.ReadAllText(_configPath);
                _userConfigs = JsonConvert.DeserializeObject<List<UserConfiguration>>(json) ?? new List<UserConfiguration>();
            }
            else
            {
                _userConfigs = new List<UserConfiguration>();
            }
        }

        private void SaveConfigurations()
        {
            var json = JsonConvert.SerializeObject(_userConfigs, Formatting.Indented);
            File.WriteAllText(_configPath, json);
        }

        public UserConfiguration GetUserConfiguration(string jellyfinUserId)
        {
            return _userConfigs.FirstOrDefault(c => c.JellyfinUserId == jellyfinUserId) ?? new UserConfiguration { JellyfinUserId = jellyfinUserId };
        }

        public void SaveUserConfiguration(UserConfiguration config)
        {
            var existingConfig = _userConfigs.FirstOrDefault(c => c.JellyfinUserId == config.JellyfinUserId);
            if (existingConfig != null)
            {
                _userConfigs.Remove(existingConfig);
            }
            _userConfigs.Add(config);
            SaveConfigurations();
        }

        public void ClearUserConfiguration(string jellyfinUserId)
        {
            _userConfigs.RemoveAll(c => c.JellyfinUserId == jellyfinUserId);
            SaveConfigurations();
        }
    }
}