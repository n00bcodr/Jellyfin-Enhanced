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
            var normalizedUserId = userId?.Replace("-", "") ?? "";
            var userDir = Path.Combine(_configBaseDir, normalizedUserId);
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

        /// Gets all user IDs that have configuration directories.
        public string[] GetAllUserIds()
        {
            try
            {
                if (!Directory.Exists(_configBaseDir))
                {
                    return Array.Empty<string>();
                }

                var userDirs = Directory.GetDirectories(_configBaseDir);
                var userIds = new string[userDirs.Length];

                for (int i = 0; i < userDirs.Length; i++)
                {
                    userIds[i] = Path.GetFileName(userDirs[i]);
                }

                return userIds;
            }
            catch (Exception ex)
            {
                _logger.Error($"Failed to get all user IDs: {ex.Message}");
                return Array.Empty<string>();
            }
        }

        /// Gets processed watchlist items for a user.
        public ProcessedWatchlistItems GetProcessedWatchlistItems(Guid userId)
        {
            return GetUserConfiguration<ProcessedWatchlistItems>(userId.ToString(), "processed-watchlist-items.json");
        }

        /// Saves processed watchlist items for a user.
        public void SaveProcessedWatchlistItems(Guid userId, ProcessedWatchlistItems items)
        {
            SaveUserConfiguration(userId.ToString(), "processed-watchlist-items.json", items);
        }

        /// Cleans up old processed watchlist items (older than specified days).
        public void CleanupOldProcessedWatchlistItems(Guid userId, int daysToKeep = 365)
        {
            try
            {
                var items = GetProcessedWatchlistItems(userId);
                var cutoffDate = System.DateTime.UtcNow.AddDays(-daysToKeep);

                var originalCount = items.Items.Count;
                var itemsToKeep = items.Items.Where(item => item.ProcessedAt > cutoffDate).ToList();

                if (itemsToKeep.Count != originalCount)
                {
                    items.Items = itemsToKeep;
                    SaveProcessedWatchlistItems(userId, items);
                    _logger.Info($"Cleaned up {originalCount - itemsToKeep.Count} old processed watchlist items for user {userId}");
                }
            }
            catch (Exception ex)
            {
                _logger.Error($"Error cleaning up processed watchlist items for user {userId}: {ex.Message}");
            }
        }
    }
}
