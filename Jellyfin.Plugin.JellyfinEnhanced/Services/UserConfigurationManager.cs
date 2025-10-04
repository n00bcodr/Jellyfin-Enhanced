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
            var configDir = Path.Combine(appPaths.PluginConfigurationsPath, "Jellyfin.Plugin.JellyfinEnhanced");
            Directory.CreateDirectory(configDir);
            _configPath = Path.Combine(configDir, "user_preferences.json");
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