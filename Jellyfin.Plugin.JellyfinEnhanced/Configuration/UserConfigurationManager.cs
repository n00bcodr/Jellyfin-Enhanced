using System;
using System.Collections.Concurrent;
using System.IO;
using System.Text.RegularExpressions;
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

        // Static so the Singleton ResponseFilter and the Scoped IEventConsumer share one pool.
        private static readonly ConcurrentDictionary<string, object> _userFileLocks = new ConcurrentDictionary<string, object>();

        public UserConfigurationManager(IApplicationPaths appPaths, Logger logger)
        {
            _configBaseDir = Path.Combine(appPaths.PluginsPath, "configurations", "Jellyfin.Plugin.JellyfinEnhanced");
            Directory.CreateDirectory(_configBaseDir);
            _logger = logger;

            // One-shot migration: pre-fix callers normalized user IDs case-sensitively
            // (only stripped hyphens), so the same logical user could land in
            // {abcd...}, {ABCD...}, AND {abcd-...} folders. Different request paths
            // hit different folders, so per-user settings appeared to "drift" — see
            // PR #573 thread. Idempotent; cheap when there's nothing to migrate.
            try { MigrateCaseVariantUserDirs(); }
            catch (Exception ex) { _logger.Error($"Per-user dir case-variant migration failed: {ex}"); }
        }

        public object GetUserFileLock(string userId, string fileName)
        {
            var normalized = (userId ?? string.Empty).Replace("-", "").ToLowerInvariant();
            var key = normalized + "|" + (fileName ?? string.Empty);
            return _userFileLocks.GetOrAdd(key, _ => new object());
        }

        private string GetUserConfigDir(string userId)
        {
            var normalizedUserId = (userId ?? string.Empty).Replace("-", "").ToLowerInvariant();
            var userDir = Path.Combine(_configBaseDir, normalizedUserId);

            // Refuse paths outside _configBaseDir in case a future caller forwards untrusted input.
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

        // Lenient read; returns new T() on missing/empty/unparseable. Write path should use GetUserConfigurationStrict.
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

        // Strict read for RMW: existing empty/null/garbage is corruption; backs up to .corrupt-{ts} and throws.
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

        // Locked read-modify-write: holds GetUserFileLock, strict-reads, mutates, and saves when the mutator returns > 0.
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

        // Atomic save via temp file + File.Move(overwrite). RMW callers must hold GetUserFileLock.
        public void SaveUserConfiguration(string userId, string fileName, object config)
        {
            string configPath = string.Empty;
            string tempPath = string.Empty;
            try
            {
                configPath = ResolveUserFile(userId, fileName);
                // Per-call random suffix avoids collisions between concurrent non-RMW writers on a shared .tmp.
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

        private void BackupCorruptFile(string filePath)
        {
            try
            {
                // Millisecond resolution so two corruption events in the same UTC second get distinct backups.
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

        // ─── Case-variant directory migration ────────────────────────────────────
        // Until this fix, GetUserConfigDir / GetUserFileLock only stripped hyphens
        // from the user ID without lowering case. Three call patterns existed:
        //   • Guid.ToString("N")   → 32 hex, lowercase  ← canonical
        //   • Guid.ToString()      → 36 hex, hyphenated lowercase
        //   • {userId} from URL    → whatever case the client sent, sometimes UPPER
        // Each landed in a separate physical folder for one user GUID. Settings
        // written under one casing were invisible when read under another.

        private static readonly Regex CanonicalGuidRe = new Regex("^[0-9a-f]{32}$", RegexOptions.Compiled);
        private static readonly Regex GuidShapeRe    = new Regex("^[0-9a-fA-F-]{32,36}$", RegexOptions.Compiled);

        /// <summary>
        /// Scans <c>_configBaseDir</c> for case-variant or hyphenated user
        /// folders and merges each into its canonical lowercase 32-hex
        /// sibling. Idempotent; conflict files are kept (newer wins, older
        /// backed up to <c>{file}.pre-case-merge-{ts}</c>) and the source
        /// folder is renamed to <c>{name}.migrated-{ts}</c> for forensic
        /// recovery rather than deleted outright.
        /// </summary>
        /// <summary>
        /// Per-instance unique suffix so multiple migration steps in the same
        /// millisecond produce distinct backup / .migrated- names. Combined
        /// with a millisecond timestamp this is collision-free in practice.
        /// </summary>
        private static string MigrationSuffix() =>
            DateTime.UtcNow.ToString("yyyyMMddHHmmssfff") + "-" + Guid.NewGuid().ToString("N").Substring(0, 8);

        private void MigrateCaseVariantUserDirs()
        {
            if (!Directory.Exists(_configBaseDir)) return;

            var allDirs = Directory.GetDirectories(_configBaseDir);
            var migrated = 0;
            var renamed  = 0;
            var failed   = 0;

            foreach (var srcDir in allDirs)
            {
                string srcName;
                try { srcName = Path.GetFileName(srcDir); }
                catch { continue; }

                if (string.IsNullOrEmpty(srcName)) continue;
                // Already canonical — skip.
                if (CanonicalGuidRe.IsMatch(srcName)) continue;
                // Shape gate FIRST so 'foo.migrated-...', 'reviews.json',
                // future top-level dirs, etc. never reach the strip+lower step.
                if (!GuidShapeRe.IsMatch(srcName)) continue;

                var stripped = srcName.Replace("-", "").ToLowerInvariant();
                if (!CanonicalGuidRe.IsMatch(stripped)) continue;

                var dstDir = Path.Combine(_configBaseDir, stripped);

                try
                {
                    if (!Directory.Exists(dstDir))
                    {
                        Directory.Move(srcDir, dstDir);
                        renamed++;
                        _logger.Info($"Migrated user dir '{srcName}' -> '{stripped}'");
                        continue;
                    }

                    // Case-insensitive filesystem (Windows NTFS, default macOS APFS):
                    // src and dst can resolve to the SAME physical directory even
                    // though their string names differ. Don't try to merge — the
                    // merge logic would Directory.Move the only data dir to .migrated-
                    // and the canonical dir would vanish. Instead do a two-step
                    // case-only rename: src -> src.tmp -> dst.
                    var srcFull = Path.GetFullPath(srcDir);
                    var dstFull = Path.GetFullPath(dstDir);
                    if (string.Equals(srcFull, dstFull, StringComparison.OrdinalIgnoreCase)
                        && !string.Equals(srcFull, dstFull, StringComparison.Ordinal))
                    {
                        var tmp = srcDir + ".case-rename-" + MigrationSuffix();
                        Directory.Move(srcDir, tmp);
                        Directory.Move(tmp, dstDir);
                        renamed++;
                        _logger.Info($"Case-only rename on case-insensitive FS: '{srcName}' -> '{stripped}'");
                        continue;
                    }

                    // Both exist as distinct dirs — merge per-file, newer mtime wins,
                    // older backed up. Each per-file step uses its own try/catch so
                    // one bad file doesn't abort the whole dir's merge.
                    var srcFiles = Directory.GetFiles(srcDir);
                    foreach (var srcFile in srcFiles)
                    {
                        var fileName = Path.GetFileName(srcFile);
                        var dstFile  = Path.Combine(dstDir, fileName);

                        try
                        {
                            if (!File.Exists(dstFile))
                            {
                                File.Copy(srcFile, dstFile);
                                continue;
                            }

                            var srcMtime = File.GetLastWriteTimeUtc(srcFile);
                            var dstMtime = File.GetLastWriteTimeUtc(dstFile);
                            if (srcMtime > dstMtime)
                            {
                                // ms-resolution + GUID suffix prevents collisions
                                // when two case-variants of the same canonical GUID
                                // both have a newer file in the same millisecond.
                                var backup = dstFile + ".pre-case-merge-" + MigrationSuffix();
                                File.Copy(dstFile, backup);
                                File.Copy(srcFile, dstFile, overwrite: true);
                                _logger.Info($"Merged '{fileName}' from '{srcName}' (newer) into '{stripped}'");
                            }
                            else
                            {
                                // Source data is dropped from the canonical dir but
                                // preserved under '{srcName}.migrated-{ts}'. Warning
                                // severity so the admin can spot it in logs.
                                _logger.Warning($"Kept '{fileName}' from canonical '{stripped}' (newer than '{srcName}'); source-side copy preserved in '.migrated-' sibling");
                            }
                        }
                        catch (Exception fileEx)
                        {
                            _logger.Error($"Failed to migrate file '{fileName}' in '{srcName}': {fileEx.Message}");
                        }
                    }

                    // Rename source rather than delete so forensic recovery is possible.
                    var migratedName = srcDir + ".migrated-" + MigrationSuffix();
                    Directory.Move(srcDir, migratedName);
                    migrated++;
                    _logger.Info($"Merged user dir '{srcName}' into canonical '{stripped}', source preserved at '{Path.GetFileName(migratedName)}'");
                }
                catch (Exception ex)
                {
                    failed++;
                    _logger.Error($"Failed to migrate user dir '{srcName}': {ex}");
                }
            }

            if (renamed + migrated + failed > 0)
            {
                if (failed > 0)
                {
                    _logger.Warning($"User-dir case migration done with errors: {renamed} renamed, {migrated} merged, {failed} failed (source dirs left intact).");
                }
                else
                {
                    _logger.Info($"User-dir case migration done: {renamed} renamed, {migrated} merged.");
                }
            }
        }

        /// <summary>
        /// Gets all canonical user IDs that have configuration directories.
        /// Filters out non-user folders (e.g., <c>.migrated-{ts}</c> forensic
        /// backups, <c>.case-rename-{ts}</c> in-flight rename artifacts)
        /// so admin operations like "Reset to defaults" only iterate real
        /// users.
        /// </summary>
        public string[] GetAllUserIds()
        {
            try
            {
                if (!Directory.Exists(_configBaseDir))
                {
                    return Array.Empty<string>();
                }

                var userDirs = Directory.GetDirectories(_configBaseDir);
                var userIds = new System.Collections.Generic.List<string>(userDirs.Length);

                foreach (var dir in userDirs)
                {
                    var name = Path.GetFileName(dir);
                    if (string.IsNullOrEmpty(name)) continue;
                    // Only canonical 32-hex lowercase directories are real users.
                    // Anything else (.migrated-*, .case-rename-*, future top-level
                    // dirs) is filtered out so callers like the Reset-to-defaults
                    // admin endpoint don't iterate it and re-create stale layout.
                    if (!CanonicalGuidRe.IsMatch(name)) continue;
                    userIds.Add(name);
                }

                return userIds.ToArray();
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
