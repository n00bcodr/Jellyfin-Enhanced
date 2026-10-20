using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
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

        // One presence warning per person, file and error kind per hour: an unreadable folder is checked on every request.
        private static readonly TimeSpan PresenceWarnInterval = TimeSpan.FromHours(1);
        private static readonly ConcurrentDictionary<string, DateTime> _presenceWarnedAt = new();
        // The versions of each person's settings.json (normalized id) and of every person's at once (a restore, a quarantine,
        // the start-up migration): see SettingsVersion. Per-user files the automatic-write check doesn't read are put in
        // place inside a bracket nobody samples.
        private static readonly FactVersions _settingsVersions = new FactVersions();
        private static readonly FactVersion _allSettingsVersion = new FactVersion();
        private static readonly FactVersion _otherFiles = new FactVersion();

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
            try { _allSettingsVersion.Mutate(MigrateCaseVariantUserDirs); }
            catch (Exception ex) { _logger.Error($"Per-user dir case-variant migration failed: {ex}"); }
        }

        /// <summary>
        /// Raised after a per-user file was written by <see cref="SaveUserConfiguration"/>, with the
        /// normalized (N-format, lowercase) user id and the file name. Handlers must be cheap and must not
        /// throw; they run on the saving thread.
        /// </summary>
        public event Action<string, string>? UserConfigurationSaved;

        /// <summary>Raised after the shared reviews.json was written (review added, edited or deleted).</summary>
        public event Action? ReviewsChanged;

        public object GetUserFileLock(string userId, string fileName)
        {
            var normalized = (userId ?? string.Empty).Replace("-", "").ToLowerInvariant();
            var key = normalized + "|" + (fileName ?? string.Empty);
            return _userFileLocks.GetOrAdd(key, _ => new object());
        }

        /// <summary>A person's own settings (<see cref="JellyfinEnhancedUserSettings"/>).</summary>
        public const string SettingsFileName = "settings.json";

        /// <summary>
        /// The lock every writer of a person's settings.json holds while it reads, decides and saves
        /// (<see cref="GetUserFileLock"/> of <see cref="SettingsFileName"/>).
        /// </summary>
        public object UserSettingsLock(string userId) => GetUserFileLock(userId, SettingsFileName);

        /// <summary>
        /// The version of the person's settings.json (a <see cref="FactVersion"/> sample): odd from before their file is put in
        /// place, or their folder removed, until after (each writer holds <see cref="UserSettingsLock"/>), and likewise
        /// while every person's files change at once (a restore, a corrupt file quarantined, the start-up migration).
        /// A reader that takes it before reading the file and finds it settled and the same later knows that what it read
        /// is still what is stored. Memory only, never waits, never takes the lock. (The sum of the person's version and
        /// every person's: each change moves it up from a settled sample, so a settled sum that is the same twice means
        /// neither moved.)
        /// </summary>
        public static long SettingsVersion(string userId) => _settingsVersions.Sample(Normalized(userId)) + _allSettingsVersion.Sample();

        /// <summary>The version every person's settings.json moves with at once (a JE backup restore writes them).</summary>
        public static FactVersion AllSettingsVersion => _allSettingsVersion;

        private static string Normalized(string? userId) => (userId ?? string.Empty).Replace("-", "").ToLowerInvariant();

        // The bracket a per-user file is put in place inside: the person's settings version for settings.json.
        private static FactVersion VersionOf(string userId, string fileName)
            => string.Equals(fileName, SettingsFileName, StringComparison.OrdinalIgnoreCase) ? _settingsVersions.For(Normalized(userId)) : _otherFiles;

        /// <summary>Tests: runs at the start of every <see cref="SaveUserConfiguration"/> (normalized user id, file name).</summary>
        internal Action<string, string>? Saving { get; set; }

        /// <summary>Tests: runs as <see cref="SaveUserConfiguration"/> has put the file in place (readers see it), before it returns.</summary>
        internal Action<string, string>? Moved { get; set; }

        /// <summary>One of a person's own consents in their settings.json (what JE may request or do on their behalf).</summary>
        /// <param name="Field">The settings field (and the consent operation's field name).</param>
        /// <param name="Get">Reads it.</param>
        /// <param name="Set">Writes it.</param>
        /// <param name="FollowsAdministrator">Null is a choice ("follow the administrator"), not only "never chosen".</param>
        public sealed record PersonalConsent(string Field, Func<JellyfinEnhancedUserSettings, bool?> Get, Action<JellyfinEnhancedUserSettings, bool?> Set, bool FollowsAdministrator);

        /// <summary>
        /// Every personal consent (Phase 4). Only the person's own consent operation (<see cref="SetPersonalConsent"/>) sets
        /// or clears one: every whole-document save (the person's own, an administrator's) and every reset keeps them as
        /// stored (<see cref="KeepPersonalConsents"/>).
        /// </summary>
        public static readonly IReadOnlyList<PersonalConsent> PersonalConsents = new[]
        {
            // Phase 4a: requests on the person's behalf (null follows the administrator's recipe setting).
            new PersonalConsent(nameof(JellyfinEnhancedUserSettings.AutoSeasonRequests), s => s.AutoSeasonRequests, (s, v) => s.AutoSeasonRequests = v, true),
            new PersonalConsent(nameof(JellyfinEnhancedUserSettings.AutoMovieRequests), s => s.AutoMovieRequests, (s, v) => s.AutoMovieRequests = v, true),
            // Phase 4c1: list swap-in (null and false: no).
            new PersonalConsent(nameof(JellyfinEnhancedUserSettings.ListSwapIn), s => s.ListSwapIn, (s, v) => s.ListSwapIn = v, false),
        };

        /// <summary>
        /// Copies every personal consent (<see cref="PersonalConsents"/>) from <paramref name="stored"/> (null: no file yet)
        /// into <paramref name="settings"/>: a whole document never carries consent intent.
        /// </summary>
        public static void KeepPersonalConsents(JellyfinEnhancedUserSettings settings, JellyfinEnhancedUserSettings? stored)
        {
            foreach (var consent in PersonalConsents)
            {
                consent.Set(settings, stored == null ? null : consent.Get(stored));
            }
        }

        /// <summary>The consents as the settings routes answer them (field name → stored value).</summary>
        public static Dictionary<string, bool?> ConsentsOf(JellyfinEnhancedUserSettings settings)
            => PersonalConsents.ToDictionary(c => c.Field, c => c.Get(settings), StringComparer.Ordinal);

        /// <summary>
        /// The display-language gate (stage 1 fix round 3): every writer that puts a person's settings.json in place stores its
        /// <c>DisplayLanguage</c> as <see cref="LanguageTags.Sanitize"/> leaves it, whatever else it writes. Typed writers
        /// (a save, the first-read seed, a reset, the consent operation), document writers (an administrator's display change)
        /// and any read-modify-write pass it in <see cref="SaveUserConfiguration"/>; a JE backup restore and the start-up
        /// folder migration, which put files in place themselves, pass it through <see cref="GateSettingsFile"/>. Changes the
        /// document in place (the property in any case; a JSON null stays, it reads as Auto) and returns whether it did.
        /// </summary>
        public static bool GateSettingsDocument(JObject document)
        {
            var changed = false;
            foreach (var property in document.Properties()
                .Where(p => string.Equals(p.Name, nameof(JellyfinEnhancedUserSettings.DisplayLanguage), StringComparison.OrdinalIgnoreCase)).ToList())
            {
                if (property.Value.Type == JTokenType.Null) continue;
                var stored = property.Value.Type == JTokenType.String ? (string?)property.Value : null;
                var gated = LanguageTags.Sanitize(stored);
                if (stored == gated) continue;
                property.Value = gated;
                changed = true;
            }

            return changed;
        }

        /// <summary>What <see cref="GateSettingsBytes"/> did with a settings.json document.</summary>
        public enum SettingsGateOutcome
        {
            /// <summary>Its display language passes (or it has none, or it is a JSON null): the same bytes.</summary>
            Unchanged,

            /// <summary>Only the value of its own DisplayLanguage key(s) was replaced; every other byte is the same.</summary>
            Edited,

            /// <summary>
            /// The gate can't read it (not UTF-8, not one JSON object, syntax the reader refuses, deeper than it reads): it must
            /// not be put in place as it is.
            /// </summary>
            Unreadable,
        }

        private static readonly byte[] Utf8Bom = { 0xEF, 0xBB, 0xBF };

        /// <summary>
        /// The display-language gate for a settings.json document JE puts in place without writing it itself (a JE backup
        /// restore, the start-up folder migration). Lossless: the document is never re-serialized; the value of each of its
        /// own DisplayLanguage keys (the top level only, any case or escaped spelling, duplicates each) is replaced at its token
        /// offsets by <see cref="LanguageTags.Sanitize"/>'s answer, so every other byte stays (numbers of any size or precision,
        /// a byte-order mark, comments, escapes, whitespace). A JSON null stays (it reads as Auto); any other non-string value is
        /// replaced by Auto. Fails closed: a document it can't read is <see cref="SettingsGateOutcome.Unreadable"/>, and the
        /// caller must not put it in place as it is.
        /// </summary>
        /// <param name="bytes">The document.</param>
        /// <param name="gated">The document to put in place: <paramref name="bytes"/> unless edited; unusable when unreadable.</param>
        /// <returns>What the gate did.</returns>
        public static SettingsGateOutcome GateSettingsBytes(byte[] bytes, out byte[] gated)
        {
            gated = bytes;
            // Invalid UTF-8 anywhere (UTF-16 included) would be read with replacement characters: not the document as written.
            if (!System.Text.Unicode.Utf8.IsValid(bytes)) return SettingsGateOutcome.Unreadable;
            var offset = bytes.AsSpan().StartsWith(Utf8Bom) ? Utf8Bom.Length : 0;
            var edits = new List<(int Start, int End, string Value)>();
            try
            {
                var reader = new System.Text.Json.Utf8JsonReader(bytes.AsSpan(offset), new System.Text.Json.JsonReaderOptions
                {
                    // What JE's own reader (Newtonsoft) also accepts, and nothing it would read differently.
                    CommentHandling = System.Text.Json.JsonCommentHandling.Skip,
                    AllowTrailingCommas = true,
                });
                if (!reader.Read() || reader.TokenType != System.Text.Json.JsonTokenType.StartObject) return SettingsGateOutcome.Unreadable;
                while (reader.Read() && reader.TokenType == System.Text.Json.JsonTokenType.PropertyName)
                {
                    var name = reader.GetString();
                    reader.Read();
                    var start = (int)reader.TokenStartIndex;
                    string? value = null;
                    var type = reader.TokenType;
                    if (type == System.Text.Json.JsonTokenType.String) value = reader.GetString();
                    else if (type is System.Text.Json.JsonTokenType.StartObject or System.Text.Json.JsonTokenType.StartArray) reader.Skip();
                    var end = (int)reader.BytesConsumed;
                    if (!string.Equals(name, nameof(JellyfinEnhancedUserSettings.DisplayLanguage), StringComparison.OrdinalIgnoreCase)
                        || type == System.Text.Json.JsonTokenType.Null) continue;
                    var sanitized = LanguageTags.Sanitize(value);
                    if (type == System.Text.Json.JsonTokenType.String && string.Equals(value, sanitized, StringComparison.Ordinal)) continue;
                    edits.Add((offset + start, offset + end, sanitized));
                }

                // The object's end, then nothing but whitespace or comments (a second value throws).
                if (reader.TokenType != System.Text.Json.JsonTokenType.EndObject || reader.CurrentDepth != 0 || reader.Read())
                {
                    return SettingsGateOutcome.Unreadable;
                }
            }
            catch (Exception ex) when (ex is System.Text.Json.JsonException or InvalidOperationException)
            {
                return SettingsGateOutcome.Unreadable;
            }

            if (edits.Count == 0) return SettingsGateOutcome.Unchanged;
            var output = new MemoryStream(bytes.Length);
            var position = 0;
            foreach (var (start, end, value) in edits)
            {
                output.Write(bytes, position, start - position);
                // A sanitized tag is ASCII letters, digits and hyphens: nothing to escape.
                output.Write(System.Text.Encoding.UTF8.GetBytes("\"" + value + "\""));
                position = end;
            }

            output.Write(bytes, position, bytes.Length - position);
            gated = output.ToArray();
            return SettingsGateOutcome.Edited;
        }

        /// <summary>
        /// Puts a settings.json file that was placed without <see cref="SaveUserConfiguration"/> (the start-up folder migration)
        /// through the gate, rewriting it atomically only when it changes. The caller holds the bracket it was placed in.
        /// </summary>
        private void GateSettingsFile(string path)
        {
            try
            {
                if (!File.Exists(path)) return;
                var outcome = GateSettingsBytes(File.ReadAllBytes(path), out var gated);
                if (outcome == SettingsGateOutcome.Unreadable)
                {
                    // Not new data: the person's own file, now under the canonical folder. It is kept as it was: every reader
                    // hands out its language gated, and a writer either refuses a file it can't read or rewrites it through the
                    // document gate.
                    _logger.Warning($"Could not read '{path}' to check its display language; kept as it was.");
                    return;
                }

                if (outcome == SettingsGateOutcome.Unchanged) return;
                var temp = path + ".tmp." + Guid.NewGuid().ToString("N");
                File.WriteAllBytes(temp, gated);
                File.Move(temp, path, overwrite: true);
                _logger.Info($"Stored the display language of '{path}' as the shared language policy accepts it.");
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                _logger.Warning($"Could not check the display language of '{path}': {ex.Message}");
            }
        }

        /// <summary>
        /// Replaces a person's settings.json with <paramref name="settings"/>, atomically under <see cref="UserSettingsLock"/>:
        /// the stored settings are read (strictly: a corrupt file is never overwritten), every personal consent is kept from
        /// them whoever saves (<see cref="KeepPersonalConsents"/>), the display language is a supported tag or Auto
        /// (<see cref="LanguageTags.Sanitize"/>), and the file is written when anything differs.
        /// </summary>
        /// <returns>Whether the file was written, and what changed ("Name: old → new").</returns>
        public (bool Saved, IReadOnlyList<string> Changes) SaveUserSettings(string userId, JellyfinEnhancedUserSettings settings)
        {
            lock (UserSettingsLock(userId))
            {
                var existing = GetUserConfigurationStrict<JellyfinEnhancedUserSettings>(userId, SettingsFileName);
                KeepPersonalConsents(settings, existing);
                // A display language JE stores is a tag of a shipped bundle, else Auto: never "undefined", "null", a malformed
                // value or a language without a bundle the client would mirror into Jellyfin's shared language key (dashcrash
                // §7). The same gate as SaveUserConfiguration's, applied here too so the comparison and the answer see it.
                settings.DisplayLanguage = LanguageTags.Sanitize(settings.DisplayLanguage);

                var existingJson = System.Text.Json.JsonSerializer.Serialize(existing);
                var newJson = System.Text.Json.JsonSerializer.Serialize(settings);
                if (existingJson == newJson)
                {
                    return (false, Array.Empty<string>());
                }

                var changes = new List<string>();
                var existingDoc = System.Text.Json.JsonDocument.Parse(existingJson).RootElement;
                var newDoc = System.Text.Json.JsonDocument.Parse(newJson).RootElement;
                foreach (var prop in newDoc.EnumerateObject())
                {
                    if (!existingDoc.TryGetProperty(prop.Name, out var oldVal) || oldVal.ToString() != prop.Value.ToString())
                    {
                        changes.Add($"{prop.Name}: {(existingDoc.TryGetProperty(prop.Name, out var ov) ? ov.ToString() : "—")} → {prop.Value}");
                    }
                }

                SaveUserConfiguration(userId, SettingsFileName, settings);
                return (true, changes);
            }
        }

        /// <summary>
        /// Sets one explicitly named personal consent (<see cref="PersonalConsents"/>) under the same lock as whole-document
        /// saves and resets. Unknown fields, and null for a consent where null is no choice, are rejected inside the lock; no
        /// other settings are taken from the caller. The controller must authorize the person themselves before calling this.
        /// </summary>
        public JellyfinEnhancedUserSettings SetPersonalConsent(string userId, string field, bool? value)
        {
            lock (UserSettingsLock(userId))
            {
                var consent = PersonalConsents.FirstOrDefault(c => string.Equals(c.Field, field, StringComparison.Ordinal))
                    ?? throw new ArgumentException("Unknown personal consent field.", nameof(field));
                if (value == null && !consent.FollowsAdministrator)
                {
                    throw new ArgumentException("This consent needs a yes or no.", nameof(value));
                }

                var settings = GetUserConfigurationStrict<JellyfinEnhancedUserSettings>(userId, SettingsFileName);
                consent.Set(settings, value);
                // The stored document passes the display-language gate (SaveUserConfiguration); the answer says what it stored.
                settings.DisplayLanguage = LanguageTags.Sanitize(settings.DisplayLanguage);
                SaveUserConfiguration(userId, SettingsFileName, settings);
                return settings;
            }
        }

        /// <summary>
        /// Applies field changes to a person's settings.json under <see cref="UserSettingsLock"/>: the stored document (or,
        /// when they have none yet, <paramref name="seed"/>'s defaults, as the first read would store) gets the named fields
        /// (property names in any case) and keeps every other one as stored, so another tab's or device's change of another
        /// field since this client's read stays. Consents change only through <see cref="SetPersonalConsent"/>: a consent
        /// named here is left as stored, like an unknown field. The display language passes the gate. Throws
        /// <see cref="UserDocumentPatchException"/> for a value of the wrong type (nothing saved).
        /// </summary>
        /// <returns>The settings as stored afterwards, and what changed ("Name: old → new").</returns>
        public (JellyfinEnhancedUserSettings Settings, IReadOnlyList<string> Changes) PatchUserSettings(string userId, IReadOnlyDictionary<string, System.Text.Json.JsonElement>? set, Func<JellyfinEnhancedUserSettings> seed)
        {
            lock (UserSettingsLock(userId))
            {
                var exists = UserConfigurationExists(userId, SettingsFileName);
                var existing = exists ? GetUserConfigurationStrict<JellyfinEnhancedUserSettings>(userId, SettingsFileName) : seed();
                var consents = PersonalConsents.Select(c => c.Field).ToHashSet(StringComparer.Ordinal);
                var updated = ApplyFieldChanges(existing, set, consents);
                KeepPersonalConsents(updated, existing);
                updated.DisplayLanguage = LanguageTags.Sanitize(updated.DisplayLanguage);

                var existingJson = System.Text.Json.JsonSerializer.Serialize(existing);
                var newJson = System.Text.Json.JsonSerializer.Serialize(updated);
                var changes = new List<string>();
                if (exists && existingJson == newJson) return (updated, changes);
                var existingDoc = System.Text.Json.JsonDocument.Parse(existingJson).RootElement;
                foreach (var prop in System.Text.Json.JsonDocument.Parse(newJson).RootElement.EnumerateObject())
                {
                    if (!existingDoc.TryGetProperty(prop.Name, out var oldVal) || oldVal.ToString() != prop.Value.ToString())
                    {
                        changes.Add($"{prop.Name}: {(existingDoc.TryGetProperty(prop.Name, out var ov) ? ov.ToString() : "—")} → {prop.Value}");
                    }
                }

                SaveUserConfiguration(userId, SettingsFileName, updated);
                return (updated, changes);
            }
        }

        /// <summary>
        /// A copy of <paramref name="current"/> with the named fields set (property names in any case); unknown fields and
        /// <paramref name="excluded"/> ones are left as they are. Throws <see cref="UserDocumentPatchException"/> for a value of
        /// the wrong type.
        /// </summary>
        public static T ApplyFieldChanges<T>(T current, IReadOnlyDictionary<string, System.Text.Json.JsonElement>? set, ISet<string>? excluded = null) where T : class, new()
        {
            var document = JObject.FromObject(current);
            foreach (var (name, value) in set ?? new Dictionary<string, System.Text.Json.JsonElement>())
            {
                var property = typeof(T).GetProperty(name, System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.IgnoreCase);
                if (property == null || property.GetSetMethod() == null || (excluded?.Contains(property.Name) ?? false)) continue;
                document[property.Name] = JToken.Parse(value.GetRawText());
            }

            try
            {
                return document.ToObject<T>() ?? new T();
            }
            catch (Exception ex) when (ex is JsonException or FormatException or InvalidCastException or ArgumentException or OverflowException)
            {
                throw new UserDocumentPatchException($"A changed field of {typeof(T).Name} can't be read: {ex.Message}");
            }
        }

        /// <summary>Writes a person's first settings.json (<paramref name="defaults"/>) when they have none yet, under <see cref="UserSettingsLock"/>.</summary>
        /// <returns>Whether it was written (false: they have settings already).</returns>
        public bool SeedUserSettings(string userId, JellyfinEnhancedUserSettings defaults)
        {
            lock (UserSettingsLock(userId))
            {
                if (UserConfigurationExists(userId, SettingsFileName))
                {
                    return false;
                }

                SaveUserConfiguration(userId, SettingsFileName, defaults);
                return true;
            }
        }

        /// <summary>
        /// Resets a person's settings.json to <paramref name="defaults"/> (not changed: each person gets a copy), under
        /// <see cref="UserSettingsLock"/>, keeping their consents (<see cref="KeepPersonalConsents"/>).
        /// </summary>
        public void ResetUserSettings(string userId, JellyfinEnhancedUserSettings defaults)
        {
            lock (UserSettingsLock(userId))
            {
                var stored = UserConfigurationExists(userId, SettingsFileName) ? GetUserConfiguration<JellyfinEnhancedUserSettings>(userId, SettingsFileName) : null;
                var reset = JToken.FromObject(defaults).ToObject<JellyfinEnhancedUserSettings>() ?? new JellyfinEnhancedUserSettings();
                KeepPersonalConsents(reset, stored);
                SaveUserConfiguration(userId, SettingsFileName, reset);
            }
        }

        /// <summary>Reads an existing settings document without making a directory, seeding defaults or quarantining data.
        /// Null means absent; inaccessible or corrupt files must be reported as unavailable by the caller.</summary>
        public string? ReadExistingSettingsDocument(Guid userId)
        {
            if (userId == Guid.Empty) throw new ArgumentException("A person is required.", nameof(userId));
            if (!Directory.Exists(_configBaseDir)) throw new IOException("The personal settings store is unavailable.");
            var path = Path.Combine(_configBaseDir, userId.ToString("N"), SettingsFileName);
            try { return File.ReadAllText(path); }
            catch (FileNotFoundException) { return null; }
            catch (DirectoryNotFoundException) { return null; }
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

        /// <summary>
        /// Whether a person's file is there: true, false only when its absence is confirmed, and null when the file or
        /// its folder can't be inspected (access denied, I/O error). File.Exists answers false for all three, which a
        /// privacy check must not read as "no settings".
        /// </summary>
        public bool? UserConfigurationPresence(string userId, string fileName)
        {
            try
            {
                using var stream = new FileStream(ResolveUserFile(userId, fileName), FileMode.Open, FileAccess.Read,
                    FileShare.ReadWrite | FileShare.Delete);
                return true;
            }
            catch (FileNotFoundException)
            {
                return false;
            }
            catch (DirectoryNotFoundException)
            {
                return false;
            }
            catch (Exception ex)
            {
                var now = DateTime.UtcNow;
                var key = $"{userId}|{fileName}|{ex.GetType().Name}";
                if (_presenceWarnedAt.AddOrUpdate(key, now, (_, last) => (now - last) >= PresenceWarnInterval ? now : last) == now)
                {
                    _logger.Warning($"Can't inspect '{fileName}' of user '{userId}': {ex.Message}");
                }
                return null;
            }
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

                    var settings = JsonConvert.DeserializeObject<T>(json, new JsonSerializerSettings
                    {
                        // Silently skip JSON null values rather than throwing when the target
                        // C# property is a non-nullable type (e.g. bool). This handles the case
                        // where a field was previously bool? (stored as null on disk) and has
                        // since been changed to bool — without this the deserialization throws,
                        // GetUserConfiguration returns new T(), and the first subsequent save
                        // overwrites the user's real data with defaults.
                        NullValueHandling = NullValueHandling.Ignore
                    });

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
        // quarantineCorrupt: false = throw without moving the file aside (read-only callers such as dry runs).
        public T GetUserConfigurationStrict<T>(string userId, string fileName, bool quarantineCorrupt = true) where T : new()
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
                if (quarantineCorrupt) BackupCorruptFile(configPath);
                throw;
            }

            if (string.IsNullOrWhiteSpace(json)
                || string.Equals(json.Trim(), "null", StringComparison.Ordinal))
            {
                _logger.Error($"'{fileName}' for user '{userId}' exists but is empty or literal-null; refusing to overwrite.");
                if (quarantineCorrupt) BackupCorruptFile(configPath);
                throw new InvalidDataException($"'{fileName}' is empty or literal null; refusing to overwrite.");
            }

            try
            {
                // Same null-skipping policy as the lenient GetUserConfiguration above:
                // a stored JSON null for a field that has since become non-nullable
                // (bool? -> bool migrations) is schema drift, not corruption. Without
                // this the strict path would back the file up as .corrupt-* and 503,
                // losing the user's real data — the exact failure the lenient reader
                // was fixed to avoid. The empty/"null"-literal checks above still
                // treat genuinely unusable files as corruption.
                var parsed = JsonConvert.DeserializeObject<T>(json, new JsonSerializerSettings
                {
                    NullValueHandling = NullValueHandling.Ignore
                });
                if (parsed == null)
                {
                    _logger.Error($"'{fileName}' for user '{userId}' deserialized to null; refusing to overwrite.");
                    if (quarantineCorrupt) BackupCorruptFile(configPath);
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
                if (quarantineCorrupt) BackupCorruptFile(configPath);
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
                Saving?.Invoke(userId.Replace("-", "").ToLowerInvariant(), fileName);
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

                if (string.Equals(fileName, SettingsFileName, StringComparison.OrdinalIgnoreCase) && token is JObject settingsDocument)
                {
                    GateSettingsDocument(settingsDocument);
                }

                var jsonToSave = JsonConvert.SerializeObject(token, Formatting.Indented);

                File.WriteAllText(tempPath, jsonToSave);
                // In place inside the version's bracket: settings.json is what the automatic-write check reads consents from.
                VersionOf(userId, fileName).Mutate(() =>
                {
                    File.Move(tempPath, configPath, overwrite: true);
                    Moved?.Invoke(Normalized(userId), fileName);
                });
                if (string.Equals(fileName, Jellyfin.Plugin.JellyfinEnhanced.Services.SpoilerBlurImageFilter.SpoilerBlurFileName, StringComparison.OrdinalIgnoreCase))
                {
                    Jellyfin.Plugin.JellyfinEnhanced.Services.SpoilerUserResolver.InvalidateUser(userId);
                }

                RaiseUserConfigurationSaved(userId, fileName);
            }
            catch (Exception ex)
            {
                _logger.Error($"Failed to save user configuration for user '{userId}' to file '{fileName}'. Exception: {ex.Message}");
                try { if (!string.IsNullOrEmpty(tempPath) && File.Exists(tempPath)) File.Delete(tempPath); }
                catch (Exception cleanupEx) { _logger.Warning($"Failed to clean up stale .tmp for '{fileName}': {cleanupEx.Message}"); }
                throw;
            }
        }

        // Swallows subscriber exceptions so a misbehaving handler can never turn
        // a successful save into a reported (and rethrown) save failure.
        private void RaiseUserConfigurationSaved(string userId, string fileName)
        {
            var handler = UserConfigurationSaved;
            if (handler == null) return;
            try
            {
                handler((userId ?? string.Empty).Replace("-", "").ToLowerInvariant(), fileName);
            }
            catch (Exception ex)
            {
                _logger.Warning($"User configuration save hook failed for '{fileName}': {ex.Message}");
            }
        }

        private void RaiseReviewsChanged()
        {
            try
            {
                ReviewsChanged?.Invoke();
            }
            catch (Exception ex)
            {
                _logger.Warning($"Reviews change hook failed: {ex.Message}");
            }
        }

        /// <summary>
        /// Raw text of a per-user file: null only when the file does not exist; <see cref="string.Empty"/>
        /// when it exists but is empty, whitespace or unreadable (so callers can tell "no file yet" from "a
        /// file that yields nothing", which the typed reads treat differently). For callers that apply their
        /// own per-key defaults and must see which keys the file actually contains (typed reads fill absent
        /// keys with C# initializer values). Never throws.
        /// </summary>
        public string? TryReadUserConfigurationText(string userId, string fileName)
        {
            string configPath;
            try
            {
                configPath = ResolveUserFile(userId, fileName);
                if (!File.Exists(configPath)) return null;
            }
            catch (Exception ex)
            {
                // Cannot even resolve/stat the file: treat as present but unreadable.
                _logger.Warning($"Could not read '{fileName}' for user '{userId}': {ex.Message}");
                return string.Empty;
            }

            try
            {
                var text = File.ReadAllText(configPath);
                return string.IsNullOrWhiteSpace(text) ? string.Empty : text;
            }
            catch (Exception ex)
            {
                _logger.Warning($"Could not read '{fileName}' for user '{userId}': {ex.Message}");
                return string.Empty;
            }
        }

        private void BackupCorruptFile(string filePath)
        {
            try
            {
                // MOVE (quarantine), not copy: the strict read that triggers this
                // sits on hot read paths (e.g. the tag-cache strip runs on every
                // poll). If the corrupt original stayed in place, every read would
                // re-throw 503 AND drop another .corrupt-* file — a permanent loop
                // that also makes the client's "reset to defaults" message a lie.
                // Moving it out of the way means the next read finds no file and
                // returns defaults, so the store self-heals after exactly one
                // backup. Unique suffix so multiple quarantines never collide.
                var backupPath = filePath + ".corrupt-"
                    + DateTime.UtcNow.ToString("yyyyMMddHHmmssfff")
                    + "-" + Guid.NewGuid().ToString("N").Substring(0, 8);
                _allSettingsVersion.Mutate(() => File.Move(filePath, backupPath));
                _logger.Warning($"Corrupt config quarantined to {backupPath} (store will reset to defaults on next read)");
            }
            catch (Exception ex)
            {
                _logger.Error($"Failed to quarantine corrupt config '{filePath}': {ex.Message}");
                // Last resort: if the move failed, delete the unreadable file so
                // the 503-per-request loop still breaks. The content is already
                // unparseable, and the failure is logged above for forensics.
                try { _allSettingsVersion.Mutate(() => File.Delete(filePath)); }
                catch (Exception delEx)
                {
                    _logger.Error($"Also failed to delete corrupt config '{filePath}': {delEx.Message}");
                }
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
        /// A folder name that is a person's: the canonical id (32 lower-case hex digits) or another spelling of it that the
        /// start-up migration puts in place under the canonical name (upper case, hyphens).
        /// </summary>
        public static bool IsPersonFolderName(string name)
            => GuidShapeRe.IsMatch(name) && CanonicalGuidRe.IsMatch(name.Replace("-", string.Empty).ToLowerInvariant());

        /// <summary>
        /// Scans <c>_configBaseDir</c> for case-variant or hyphenated user
        /// folders and merges each into its canonical lowercase 32-hex
        /// sibling. Idempotent; conflict files are kept (newer wins, older
        /// backed up to <c>{file}.pre-case-merge-{ts}</c>) and the source
        /// folder is renamed to <c>{name}.migrated-{ts}</c> for forensic
        /// recovery rather than deleted outright.
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
            // Folders whose settings.json this migration put in place: they pass the display-language gate afterwards.
            var placed = new HashSet<string>(StringComparer.Ordinal);
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
                    placed.Add(dstDir);
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

            foreach (var dir in placed)
            {
                GateSettingsFile(Path.Combine(dir, SettingsFileName));
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
        /// Removes a deleted Jellyfin user's own folder (their settings, hidden content, bookmarks, Spoiler Guard
        /// state). Only that user's canonical folder is touched; shared files (reviews, activity) stay as they are.
        /// </summary>
        /// <param name="userId">The deleted user.</param>
        /// <returns>True when a folder was removed.</returns>
        public bool DeleteUserData(Guid userId)
        {
            if (userId == Guid.Empty) return false;
            var userDir = Path.Combine(_configBaseDir, userId.ToString("N"));
            try
            {
                if (!Directory.Exists(userDir)) return false;
                _settingsVersions.For(userId.ToString("N")).Mutate(() => Directory.Delete(userDir, recursive: true));
                return true;
            }
            catch (Exception ex)
            {
                _logger.Warning($"Could not remove the settings of deleted user {userId:N}: {ex.Message}");
                return false;
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
                // Missing/null collections and null rows are corruption, not an
                // empty store. Do not let a subsequent write erase evidence.
                var parsed = new AllReviewsStore { Reviews = null! };
                JsonConvert.PopulateObject(json, parsed, new JsonSerializerSettings { CheckAdditionalContent = true });
                if (parsed.Reviews == null || parsed.Reviews.Values.Any(review => review == null))
                {
                    if (throwOnCorruption)
                    {
                        _logger.Error("reviews.json contains an invalid review store; refusing to write over it.");
                        BackupCorruptFileUnlocked(filePath);
                        throw new InvalidDataException("reviews.json contains an invalid review store.");
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
        /// Returns the rating the review had before this call (null for a new
        /// review or one that had no rating).
        /// </summary>
        public double? UpsertReview(string userIdN, string mediaType, string tmdbId,
                                    string content, double? rating, string nowIso)
        {
            double? previousRating = null;
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
                    previousRating = existing.Rating;
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

            RaiseReviewsChanged();
            return previousRating;
        }

        /// <summary>
        /// Atomically deletes a review identified by userIdN + mediaType + tmdbId.
        /// Returns true if a review was removed, false if no matching review existed.
        /// removedRating is the deleted review's rating (null if it had none).
        /// </summary>
        public bool DeleteReview(string userIdN, string mediaType, string tmdbId, out double? removedRating)
        {
            removedRating = null;
            lock (_reviewsFileLock)
            {
                // Same reasoning as UpsertReview — refuse to rewrite a
                // corrupt file.
                var store = ReadStoreUnlocked(throwOnCorruption: true);
                var key = $"{userIdN}:{mediaType}:{tmdbId}";
                if (!store.Reviews.Remove(key, out var removed)) return false;
                WriteStoreUnlocked(store);
                removedRating = removed.Rating;
            }

            RaiseReviewsChanged();
            return true;
        }

        // ─── Shared activity file (Activity Feed) ──────────────────────────────

        private static readonly object _activityFileLock = new object();
        private static readonly JsonSerializerSettings _activityReadSettings = new JsonSerializerSettings { CheckAdditionalContent = true };

        // Bounds activity.json's growth on a busy, long-running server -- the
        // Activity Feed only ever shows the newest handful anyway, so entries
        // beyond this are pure dead weight.
        private const int MaxActivityEntries = 500;

        private string ActivityFilePath => Path.Combine(_configBaseDir, "activity.json");

        private AllActivityStore ReadActivityStoreUnlocked(bool throwOnCorruption = false)
        {
            var filePath = ActivityFilePath;
            if (!File.Exists(filePath)) return new AllActivityStore();

            try
            {
                var json = File.ReadAllText(filePath);
                if (string.IsNullOrWhiteSpace(json))
                    throw new InvalidDataException("activity.json is empty.");
                // Populate with no default dictionary so a missing Entries
                // property is rejected instead of silently becoming empty.
                var store = new AllActivityStore { Entries = null! };
                JsonConvert.PopulateObject(json, store, _activityReadSettings);
                if (store.Entries == null || store.Entries.Values.Any(entry => entry == null))
                    throw new InvalidDataException("activity.json contains an invalid activity store.");
                return store;
            }
            catch (Exception ex)
            {
                _logger.Error($"Failed to read shared activity.json: {ex.Message}");
                // Keep the original file intact for recovery. A failed read
                // must never turn the next event into a destructive reset.
                if (throwOnCorruption) throw;
                return new AllActivityStore();
            }
        }

        private void WriteActivityStoreUnlocked(AllActivityStore store)
        {
            var temporaryPath = ActivityFilePath + "." + Guid.NewGuid().ToString("N") + ".tmp";
            try
            {
                // Prune oldest-first once over the cap, same trim point every
                // write so the file can't creep up unbounded between prunes.
                if (store.Entries.Count > MaxActivityEntries)
                {
                    var toDrop = store.Entries
                        .OrderBy(kvp => kvp.Value.OccurredAt, StringComparer.Ordinal)
                        .Take(store.Entries.Count - MaxActivityEntries)
                        .Select(kvp => kvp.Key)
                        .ToList();
                    foreach (var key in toDrop) store.Entries.Remove(key);
                }

                var json = JsonConvert.SerializeObject(store, Formatting.Indented);
                // The temporary file is on the same filesystem as the store.
                // Readers see either complete version if writing is interrupted.
                using (var stream = new FileStream(temporaryPath, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                {
                    using (var writer = new StreamWriter(stream, new System.Text.UTF8Encoding(false), 4096, leaveOpen: true))
                    {
                        writer.Write(json);
                    }
                    stream.Flush(flushToDisk: true);
                }
                File.Move(temporaryPath, ActivityFilePath, overwrite: true);
            }
            catch (Exception ex)
            {
                _logger.Error($"Failed to save shared activity.json: {ex.Message}");
                throw;
            }
            finally
            {
                try { File.Delete(temporaryPath); }
                catch (IOException ex) { _logger.Warning($"Failed to clean up temporary activity file: {ex.Message}"); }
                catch (UnauthorizedAccessException ex) { _logger.Warning($"Failed to clean up temporary activity file: {ex.Message}"); }
            }
        }

        /// Reads the server-wide activity store from the shared activity.json file.
        public AllActivityStore GetAllActivity()
        {
            lock (_activityFileLock)
            {
                return ReadActivityStoreUnlocked();
            }
        }

        /// <summary>
        /// Records a watched/favorited activity entry for a user+item.
        /// Re-watching updates OccurredAt. Favorites keep their original
        /// timestamp until removed, so unrelated user-data saves cannot
        /// invent a new favorite event. Re-favoriting after removal resurfaces it.
        /// </summary>
        public void RecordActivity(string userIdN, string itemIdN, string activityType, string nowIso, bool completed = false, double progress = 0)
        {
            lock (_activityFileLock)
            {
                var store = ReadActivityStoreUnlocked(throwOnCorruption: true);
                var key = $"{userIdN}:{itemIdN}:{activityType}";
                // Completed and Progress never downgrade: a later partial
                // re-watch of something already finished (or watched
                // further) once shouldn't erase that.
                store.Entries.TryGetValue(key, out var existing);
                if (existing != null && activityType == Services.ActivityService.ActivityTypeFavorited) return;
                var wasCompleted = existing?.Completed == true;
                var priorProgress = existing?.Progress ?? 0;
                store.Entries[key] = new ActivityEntry
                {
                    UserId = userIdN,
                    ItemId = itemIdN,
                    ActivityType = activityType,
                    OccurredAt = nowIso,
                    Completed = completed || wasCompleted,
                    Progress = Math.Max(priorProgress, progress)
                };
                WriteActivityStoreUnlocked(store);
            }
        }

        /// <summary>
        /// Removes an activity entry (e.g. on unfavorite, so the feed doesn't
        /// keep showing something the user un-did). No-op if it isn't there.
        /// </summary>
        public void RemoveActivity(string userIdN, string itemIdN, string activityType)
        {
            lock (_activityFileLock)
            {
                var store = ReadActivityStoreUnlocked(throwOnCorruption: true);
                var key = $"{userIdN}:{itemIdN}:{activityType}";
                if (!store.Entries.Remove(key)) return;
                WriteActivityStoreUnlocked(store);
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

        /// Records a processed watchlist item for a user unless the same TMDB id and media
        /// type is already recorded. Runs under the per-user file lock, so the scheduled
        /// sync, a manual sync and the watchlist monitor cannot drop each other's entries.
        /// Returns true when the item was added; a failed write is logged, not thrown, so
        /// one user's unreadable file never stops a sync or monitor pass.
        public bool MarkWatchlistItemProcessed(Guid userId, int tmdbId, string mediaType, string source)
        {
            try
            {
                return RmwUserConfiguration<ProcessedWatchlistItems>(userId.ToString(), "processed-watchlist-items.json", items =>
                {
                    if (items.Items.Any(p => p.TmdbId == tmdbId && p.MediaType == mediaType))
                    {
                        return 0;
                    }

                    items.Items.Add(new ProcessedWatchlistItem
                    {
                        TmdbId = tmdbId,
                        MediaType = mediaType,
                        ProcessedAt = System.DateTime.UtcNow,
                        Source = source
                    });
                    return 1;
                }) > 0;
            }
            catch (Exception ex)
            {
                _logger.Error($"Error recording processed watchlist item {mediaType}:{tmdbId} for user {userId}: {ex.Message}");
                return false;
            }
        }

        /// Cleans up old processed watchlist items (older than specified days).
        public void CleanupOldProcessedWatchlistItems(Guid userId, int daysToKeep = 365)
        {
            try
            {
                var cutoffDate = System.DateTime.UtcNow.AddDays(-daysToKeep);
                var removed = RmwUserConfiguration<ProcessedWatchlistItems>(userId.ToString(), "processed-watchlist-items.json", items =>
                {
                    var originalCount = items.Items.Count;
                    items.Items = items.Items.Where(item => item.ProcessedAt > cutoffDate).ToList();
                    return originalCount - items.Items.Count;
                });

                if (removed > 0)
                {
                    _logger.Info($"Cleaned up {removed} old processed watchlist items for user {userId}");
                }
            }
            catch (Exception ex)
            {
                _logger.Error($"Error cleaning up processed watchlist items for user {userId}: {ex.Message}");
            }
        }
    }

    /// <summary>A per-user document patch with a value of the wrong type.</summary>
    public sealed class UserDocumentPatchException : Exception
    {
        /// <summary>Creates the exception.</summary>
        public UserDocumentPatchException(string message) : base(message)
        {
        }
    }
}
