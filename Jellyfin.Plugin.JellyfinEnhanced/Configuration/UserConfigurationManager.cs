using System;
using System.IO;
using MediaBrowser.Common.Configuration;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace Jellyfin.Plugin.JellyfinEnhanced.Configuration
{
    /// Manages per-user configuration files stored on the server.
    public class UserConfigurationManager
    {
        private readonly string _configBaseDir;
        private readonly Logger _logger;

        public UserConfigurationManager(IApplicationPaths appPaths, Logger logger)
        {
            _configBaseDir = Path.Combine(appPaths.PluginsPath, "configurations", "Jellyfin.Plugin.JellyfinEnhanced");
            Directory.CreateDirectory(_configBaseDir);
            _logger = logger;
        }

        private string GetUserConfigDir(string userId)
        {
            var userDir = Path.Combine(_configBaseDir, userId);
            Directory.CreateDirectory(userDir);
            return userDir;
        }

        public bool UserConfigurationExists(string userId, string fileName)
        {
            try
            {
                var configPath = Path.Combine(GetUserConfigDir(userId), fileName);
                return File.Exists(configPath);
            }
            catch (Exception ex)
            {
                _logger.Warning($"Error checking existence for '{fileName}' of user '{userId}': {ex.Message}");
                return false;
            }
        }

        /// Loads user configuration from a JSON file.
        public T GetUserConfiguration<T>(string userId, string fileName) where T : new()
        {
            var configPath = Path.Combine(GetUserConfigDir(userId), fileName);

            if (File.Exists(configPath))
            {
                try
                {
                    var json = File.ReadAllText(configPath);
                    if (string.IsNullOrWhiteSpace(json))
                    {
                        _logger.Warning($"Configuration file '{fileName}' for user '{userId}' is empty. Returning default.");
                        return new T();
                    }

                    var settings = JsonConvert.DeserializeObject<T>(json);

                    if (settings == null)
                    {
                        _logger.Warning($"Deserialization of {fileName} resulted in null. Returning default.");
                        return new T();
                    }

                    return settings;
                }
                catch (Exception ex)
                {
                    _logger.Error($"Error deserializing '{fileName}' for user '{userId}': {ex.Message}. Returning default configuration.");
                    return new T();
                }
            }

            return new T();
        }

        /// Saves user configuration to a JSON file.
        public void SaveUserConfiguration(string userId, string fileName, object config)
        {
            try
            {
                var configPath = Path.Combine(GetUserConfigDir(userId), fileName);

                JToken token;
                if (config is System.Text.Json.JsonElement jsonElement)
                {
                    var rawJson = jsonElement.GetRawText();
                    token = JToken.Parse(rawJson);
                }
                else
                {
                    token = JToken.FromObject(config);
                }

                var jsonToSave = JsonConvert.SerializeObject(token, Formatting.Indented);
                File.WriteAllText(configPath, jsonToSave);
            }
            catch (Exception ex)
            {
                _logger.Error($"Failed to save user configuration for user '{userId}' to file '{fileName}'. Exception: {ex.Message}");
                throw;
            }
        }
    }
}
