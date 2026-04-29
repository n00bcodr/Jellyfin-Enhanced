using System;
using System.Collections.Concurrent;
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

        /// <summary>
        /// Per-(user, file) lock pool used to serialize RMW writers. MUST remain
        /// <c>static</c> — the singleton-vs-scoped DI lifetimes of callers
        /// (ResponseFilter is Singleton, IEventConsumer is Scoped) rely on a
        /// process-wide pool to actually serialize across them.
        /// </summary>
        private static readonly ConcurrentDictionary<string, object> _userFileLocks = new ConcurrentDictionary<string, object>();

        public UserConfigurationManager(IApplicationPaths appPaths, Logger logger)
        {
            _configBaseDir = Path.Combine(appPaths.PluginsPath, "configurations", "Jellyfin.Plugin.JellyfinEnhanced");
            Directory.CreateDirectory(_configBaseDir);
            _logger = logger;
        }

        /// <summary>Returns the per-(user, file) lock writers must hold across an RMW.</summary>
        public object GetUserFileLock(string userId, string fileName)
        {
            var normalized = userId?.Replace("-", "") ?? string.Empty;
            var key = normalized + "|" + (fileName ?? string.Empty);
            return _userFileLocks.GetOrAdd(key, _ => new object());
        }

        private string GetUserConfigDir(string userId)
        {
            var normalizedUserId = userId?.Replace("-", "") ?? string.Empty;
            var userDir = Path.Combine(_configBaseDir, normalizedUserId);

            // Defense-in-depth: every current caller passes a Guid-derived id,
            // so the resolved path is always under _configBaseDir. Refuse
            // anything outside it so a future caller that accidentally
            // forwards untrusted input can't traverse out of the per-user
            // configurations tree.
            var fullBase = Path.GetFullPath(_configBaseDir + Path.DirectorySeparatorChar);
            var fullUser = Path.GetFullPath(userDir);
            if (!fullUser.StartsWith(fullBase, StringComparison.Ordinal))
            {
                throw new InvalidOperationException(
                    $"Refusing user-config path outside base directory: '{userId}'");
            }

            Directory.CreateDirectory(userDir);
            return userDir;
        }

        /// <summary>Resolves a per-user file path safely. Refuses absolute paths, path separators, dot-segment filenames, or invalid filename chars in <paramref name="fileName"/> so a future caller that forwards untrusted input can't traverse out of the user's directory via Path.Combine's drop-earlier-args behavior.</summary>
        private string ResolveUserFile(string userId, string fileName)
        {
            if (string.IsNullOrWhiteSpace(fileName)
                || fileName == "." || fileName == ".."
                || fileName.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0
                || fileName.Contains('/') || fileName.Contains('\\')
                || Path.IsPathRooted(fileName))
            {
                throw new ArgumentException($"Invalid user-config filename: '{fileName}'", nameof(fileName));
            }
            return Path.Combine(GetUserConfigDir(userId), fileName);
        }

        public bool UserConfigurationExists(string userId, string fileName)
        {
            try
            {
                var configPath = ResolveUserFile(userId, fileName);
                return File.Exists(configPath);
            }
            catch (Exception ex)
            {
                _logger.Warning($"Error checking existence for '{fileName}' of user '{userId}': {ex.Message}");
                return false;
            }
        }

        /// <summary>Lenient read; returns <c>new T()</c> on missing/empty/unparseable. Use <see cref="GetUserConfigurationStrict{T}"/> on the write path.</summary>
        public T GetUserConfiguration<T>(string userId, string fileName) where T : new()
        {
            var configPath = ResolveUserFile(userId, fileName);

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

        /// <summary>Strict read for RMW; treats existing empty/null/garbage as corruption, backs up to <c>.corrupt-{ts}</c>, and throws.</summary>
        /// <exception cref="InvalidDataException">File exists but is unreadable or empty.</exception>
        public T GetUserConfigurationStrict<T>(string userId, string fileName) where T : new()
        {
            var configPath = ResolveUserFile(userId, fileName);
            if (!File.Exists(configPath)) return new T();

            string json;
            try
            {
                json = File.ReadAllText(configPath);
            }
            catch (Exception ex)
            {
                _logger.Error($"Failed to read '{fileName}' for user '{userId}': {ex.Message}");
                BackupCorruptFile(configPath);
                throw;
            }

            if (string.IsNullOrWhiteSpace(json)
                || string.Equals(json.Trim(), "null", StringComparison.Ordinal))
            {
                _logger.Error($"'{fileName}' for user '{userId}' exists but is empty or literal-null; refusing to overwrite.");
                BackupCorruptFile(configPath);
                throw new InvalidDataException($"'{fileName}' is empty or literal null; refusing to overwrite.");
            }

            try
            {
                var parsed = JsonConvert.DeserializeObject<T>(json);
                if (parsed == null)
                {
                    _logger.Error($"'{fileName}' for user '{userId}' deserialized to null; refusing to overwrite.");
                    BackupCorruptFile(configPath);
                    throw new InvalidDataException($"'{fileName}' deserialized to null.");
                }
                return parsed;
            }
            catch (InvalidDataException)
            {
                throw;
            }
            catch (Exception ex)
            {
                _logger.Error($"Failed to parse '{fileName}' for user '{userId}': {ex.Message}");
                BackupCorruptFile(configPath);
                throw;
            }
        }

        /// <summary>Locked read-modify-write: <see cref="GetUserFileLock"/> + strict-read + <paramref name="mutate"/> + save when the mutator returns &gt; 0.</summary>
        /// <returns>The mutator's result (0 = no save).</returns>
        public int RmwUserConfiguration<T>(string userId, string fileName, Func<T, int> mutate) where T : class, new()
        {
            lock (GetUserFileLock(userId, fileName))
            {
                var config = GetUserConfigurationStrict<T>(userId, fileName);
                var changed = mutate(config);
                if (changed > 0)
                {
                    SaveUserConfiguration(userId, fileName, config);
                }
                return changed;
            }
        }

        /// <summary>Atomic save via temp file + <see cref="File.Move(string,string,bool)"/>. RMW callers must hold <see cref="GetUserFileLock"/>.</summary>
        public void SaveUserConfiguration(string userId, string fileName, object config)
        {
            string configPath = string.Empty;
            string tempPath = string.Empty;
            try
            {
                configPath = ResolveUserFile(userId, fileName);
                // Per-call random suffix so two non-RMW writers (e.g. concurrent
                // bookmark.json saves bypassing the lock) don't collide on a
                // single shared `.tmp` and File.Move into a missing source.
                tempPath = configPath + ".tmp." + Guid.NewGuid().ToString("N");

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

                File.WriteAllText(tempPath, jsonToSave);
                File.Move(tempPath, configPath, overwrite: true);
            }
            catch (Exception ex)
            {
                _logger.Error($"Failed to save user configuration for user '{userId}' to file '{fileName}'. Exception: {ex.Message}");
                try { if (!string.IsNullOrEmpty(tempPath) && File.Exists(tempPath)) File.Delete(tempPath); }
                catch (Exception cleanupEx) { _logger.Warning($"Failed to clean up stale .tmp for '{fileName}': {cleanupEx.Message}"); }
                throw;
            }
        }

        /// <summary>Copies a corrupt file to <c>{path}.corrupt-{yyyyMMddHHmmssfff}</c> for forensic recovery; skip-and-log on collision.</summary>
        private void BackupCorruptFile(string filePath)
        {
            try
            {
                // Millisecond resolution so two corruption events in the same
                // UTC second still get distinct backups; if a collision still
                // happens, branch the log instead of silently lying about a
                // backup that didn't run.
                var backupPath = filePath + ".corrupt-" + DateTime.UtcNow.ToString("yyyyMMddHHmmssfff");
                if (File.Exists(backupPath))
                {
                    _logger.Warning($"Corrupt config backup already exists at {backupPath} — skipping new copy.");
                    return;
                }
                File.Copy(filePath, backupPath);
                _logger.Warning($"Corrupt config backed up to {backupPath}");
            }
            catch (Exception ex)
            {
                _logger.Error($"Failed to back up corrupt config: {ex.Message}");
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

        // ─── Shared reviews file ─────────────────────────────────────────────────

        private static readonly object _reviewsFileLock = new object();

        private string ReviewsFilePath => Path.Combine(_configBaseDir, "reviews.json");

        /// <summary>
        /// Reads the reviews store. Caller MUST hold _reviewsFileLock.
        /// </summary>
        /// <param name="throwOnCorruption">
        /// When true (the write path), a parse or I/O failure on an
        /// EXISTING file throws instead of returning an empty store. This
        /// is critical: if a transient read failure on `reviews.json`
        /// silently returned empty, the very next `WriteStoreUnlocked`
        /// would overwrite every server review with `{ "Reviews": {} }`,
        /// turning a transient glitch into permanent data loss. A missing
        /// file is still treated as "empty" because that is the first-ever
        /// write case.
        /// </param>
        private AllReviewsStore ReadStoreUnlocked(bool throwOnCorruption = false)
        {
            var filePath = ReviewsFilePath;
            // A truly missing file is the legitimate first-write case and
            // is always treated as empty, even on the write path.
            if (!File.Exists(filePath)) return new AllReviewsStore();

            string json;
            try
            {
                json = File.ReadAllText(filePath);
            }
            catch (Exception ex)
            {
                _logger.Error($"Failed to read shared reviews.json: {ex.Message}");
                if (throwOnCorruption)
                {
                    BackupCorruptFileUnlocked(filePath);
                    throw;
                }
                return new AllReviewsStore();
            }

            // On the WRITE path: an existing file that is empty, whitespace,
            // or literal JSON `null` is suspicious — it's the exact shape a
            // previous crashed/interrupted write would leave behind, and
            // returning empty here would let the next UpsertReview overwrite
            // the file with a one-review store, losing every other review.
            // Treat those states as corruption and throw so the admin finds out.
            if (throwOnCorruption)
            {
                if (string.IsNullOrWhiteSpace(json) ||
                    string.Equals(json.Trim(), "null", StringComparison.Ordinal))
                {
                    _logger.Error($"reviews.json exists but is empty or literal-null; refusing to write over it. Length={json?.Length ?? 0}");
                    BackupCorruptFileUnlocked(filePath);
                    throw new InvalidDataException("reviews.json is empty or literal null; refusing to overwrite.");
                }
            }
            else
            {
                // Read-only callers accept empty/null as "no reviews".
                if (string.IsNullOrWhiteSpace(json)) return new AllReviewsStore();
            }

            try
            {
                var parsed = JsonConvert.DeserializeObject<AllReviewsStore>(json);
                if (parsed == null)
                {
                    if (throwOnCorruption)
                    {
                        _logger.Error("reviews.json deserialized to null; refusing to write over it.");
                        BackupCorruptFileUnlocked(filePath);
                        throw new InvalidDataException("reviews.json deserialized to null.");
                    }
                    return new AllReviewsStore();
                }
                return parsed;
            }
            catch (InvalidDataException)
            {
                throw;
            }
            catch (Exception ex)
            {
                _logger.Error($"Failed to parse shared reviews.json: {ex.Message}");
                if (throwOnCorruption)
                {
                    BackupCorruptFileUnlocked(filePath);
                    throw;
                }
                return new AllReviewsStore();
            }
        }

        /// <summary>
        /// Preserves a corrupt reviews.json for forensic recovery. Caller
        /// MUST hold _reviewsFileLock. Never throws — backup failure is
        /// logged separately but doesn't mask the original error.
        /// </summary>
        private void BackupCorruptFileUnlocked(string filePath)
        {
            try
            {
                var backupPath = filePath + ".corrupt-" + DateTime.UtcNow.ToString("yyyyMMddHHmmss");
                if (!File.Exists(backupPath))
                    File.Copy(filePath, backupPath);
                _logger.Warning($"Corrupt reviews.json backed up to {backupPath}");
            }
            catch (Exception backupEx)
            {
                _logger.Error($"Failed to back up corrupt reviews.json: {backupEx.Message}");
            }
        }

        /// <summary>
        /// Writes the reviews store. Caller MUST hold _reviewsFileLock.
        /// Logs the specific failure context before rethrowing so the
        /// server log distinguishes "disk write failed" from generic
        /// controller-level errors.
        /// </summary>
        private void WriteStoreUnlocked(AllReviewsStore store)
        {
            try
            {
                var json = JsonConvert.SerializeObject(store, Formatting.Indented);
                File.WriteAllText(ReviewsFilePath, json);
            }
            catch (Exception ex)
            {
                _logger.Error($"Failed to save shared reviews.json: {ex.Message}");
                throw;
            }
        }

        /// Reads the server-wide reviews store from the shared reviews.json file.
        public AllReviewsStore GetAllReviews()
        {
            lock (_reviewsFileLock)
            {
                return ReadStoreUnlocked();
            }
        }

        /// <summary>
        /// Atomically creates or updates a user's review for a specific item.
        /// The read-modify-write happens inside a single critical section so
        /// concurrent upserts from different users cannot cause lost updates.
        /// </summary>
        public void UpsertReview(string userIdN, string mediaType, string tmdbId,
                                 string content, int? rating, string nowIso)
        {
            lock (_reviewsFileLock)
            {
                // Use throwOnCorruption so we NEVER overwrite an unreadable
                // reviews.json with a fresh single-review store — that would
                // silently wipe every other user's review on a transient
                // read failure.
                var store = ReadStoreUnlocked(throwOnCorruption: true);
                var key = $"{userIdN}:{mediaType}:{tmdbId}";

                if (store.Reviews.TryGetValue(key, out var existing))
                {
                    existing.Content = content;
                    existing.Rating = rating;
                    existing.UpdatedAt = nowIso;
                }
                else
                {
                    store.Reviews[key] = new UserReview
                    {
                        UserId = userIdN,
                        TmdbId = tmdbId,
                        MediaType = mediaType,
                        Content = content,
                        Rating = rating,
                        CreatedAt = nowIso,
                        UpdatedAt = nowIso
                    };
                }

                WriteStoreUnlocked(store);
            }
        }

        /// <summary>
        /// Atomically deletes a review identified by userIdN + mediaType + tmdbId.
        /// Returns true if a review was removed, false if no matching review existed.
        /// </summary>
        public bool DeleteReview(string userIdN, string mediaType, string tmdbId)
        {
            lock (_reviewsFileLock)
            {
                // Same reasoning as UpsertReview — refuse to rewrite a
                // corrupt file.
                var store = ReadStoreUnlocked(throwOnCorruption: true);
                var key = $"{userIdN}:{mediaType}:{tmdbId}";
                if (!store.Reviews.Remove(key)) return false;
                WriteStoreUnlocked(store);
                return true;
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
