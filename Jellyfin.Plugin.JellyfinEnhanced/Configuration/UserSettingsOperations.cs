using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace Jellyfin.Plugin.JellyfinEnhanced.Configuration
{
    /// <summary>One user an admin bulk operation or overview looks at.</summary>
    /// <param name="Id">The canonical (lowercase, dashless) user id.</param>
    /// <param name="Name">The Jellyfin user name; null for a directory with no live user (or when users could not be listed).</param>
    /// <param name="Live">Whether a Jellyfin user with this id exists.</param>
    /// <param name="HasDirectory">Whether the user has a Jellyfin Enhanced settings directory.</param>
    public sealed record UserSettingsTarget(string Id, string? Name, bool Live, bool HasDirectory);

    /// <summary>The users an admin bulk operation can reach: live Jellyfin users plus settings directories.</summary>
    public sealed class UserSettingsPopulation
    {
        /// <summary>Gets the users: live users by name, then directories with no live user by id.</summary>
        public List<UserSettingsTarget> Users { get; } = new();

        /// <summary>Gets or sets a value indicating whether the live Jellyfin users could be listed.</summary>
        public bool LiveListed { get; set; }

        /// <summary>Gets or sets a value indicating whether the settings directories could be listed.</summary>
        public bool DirectoriesListed { get; set; }
    }

    /// <summary>A whole document section an Overwrite replaced (hidden-content Settings, Spoiler Guard Prefs).</summary>
    public sealed class UserDocumentChange
    {
        /// <summary>Gets or sets the per-user file.</summary>
        public string File { get; set; } = string.Empty;

        /// <summary>Gets or sets the section before.</summary>
        public JToken? Before { get; set; }

        /// <summary>Gets or sets the section the operation wrote.</summary>
        public JToken? After { get; set; }
    }

    /// <summary>What a bulk operation did (or would do) for one user.</summary>
    public sealed class UserSettingsOutcome
    {
        /// <summary>Outcome: the document changed.</summary>
        public const string Changed = "changed";

        /// <summary>Outcome: nothing to change.</summary>
        public const string Unchanged = "unchanged";

        /// <summary>Outcome: the user has no such file ("hasn't used Jellyfin Enhanced yet" for settings.json).</summary>
        public const string None = "none";

        /// <summary>Outcome: the file is empty or unparseable and was left untouched (or quarantined by the strict reader).</summary>
        public const string Corrupt = "corrupt";

        /// <summary>Outcome: settings.json is larger than any document JE writes; left untouched.</summary>
        public const string Oversized = "oversized";

        /// <summary>Outcome: the file could not be read or written.</summary>
        public const string Unavailable = "unavailable";

        /// <summary>Outcome: an unexpected error (see the server log).</summary>
        public const string Error = "error";

        internal UserSettingsOutcome(UserSettingsTarget user) => User = user;

        /// <summary>Gets the user.</summary>
        public UserSettingsTarget User { get; }

        /// <summary>Gets or sets the settings.json outcome.</summary>
        public string Settings { get; set; } = None;

        /// <summary>Gets the changed keys, with their before and after state.</summary>
        public List<UserSettingsKeyChange> Changes { get; } = new();

        /// <summary>Gets the selected keys that kept the user's own value.</summary>
        public List<string> Kept { get; } = new();

        /// <summary>Gets the outcome per other document (Overwrite only): "HiddenContent", "SpoilerGuard".</summary>
        public Dictionary<string, string> Documents { get; } = new(StringComparer.Ordinal);

        /// <summary>Gets the document sections an Overwrite replaced.</summary>
        public List<UserDocumentChange> DocumentChanges { get; } = new();
    }

    /// <summary>The undo record of one "Apply defaults to users" run, stored in &lt;config&gt;/_operations/&lt;id&gt;.json.</summary>
    public sealed class UserSettingsOperationRecord
    {
        /// <summary>Gets or sets the operation id.</summary>
        public string Id { get; set; } = string.Empty;

        /// <summary>Gets or sets when it ran (UTC).</summary>
        public DateTime Created { get; set; }

        /// <summary>Gets or sets the mode.</summary>
        public string Mode { get; set; } = string.Empty;

        /// <summary>Gets or sets the selected keys.</summary>
        public List<string> Keys { get; set; } = new();

        /// <summary>Gets or sets when it was undone (UTC); null while it can be undone.</summary>
        public DateTime? Undone { get; set; }

        /// <summary>Gets or sets what changed per user.</summary>
        public List<UserSettingsOperationUser> Users { get; set; } = new();
    }

    /// <summary>One user's part of an undo record.</summary>
    public sealed class UserSettingsOperationUser
    {
        /// <summary>Gets or sets the canonical user id.</summary>
        public string UserId { get; set; } = string.Empty;

        /// <summary>Gets or sets the settings.json keys the run changed.</summary>
        public List<UserSettingsKeyChange> Settings { get; set; } = new();

        /// <summary>Gets or sets the document sections the run replaced.</summary>
        public List<UserDocumentChange> Documents { get; set; } = new();
    }

    /// <summary>What undoing an operation did for one user.</summary>
    public sealed class UserSettingsUndoOutcome
    {
        internal UserSettingsUndoOutcome(UserSettingsTarget user) => User = user;

        /// <summary>Gets the user.</summary>
        public UserSettingsTarget User { get; }

        /// <summary>Gets the keys and documents restored.</summary>
        public List<string> Restored { get; } = new();

        /// <summary>Gets the keys and documents changed since the operation, kept as they are.</summary>
        public List<string> Kept { get; } = new();

        /// <summary>Gets the documents that could not be read or written, with the reason.</summary>
        public Dictionary<string, string> Failed { get; } = new(StringComparer.Ordinal);
    }

    /// <summary>
    /// "Apply defaults to users" (design 4.4) across users and documents: the engine behind the
    /// admin apply and undo routes and the legacy reset-all route. Previews read without ever
    /// quarantining or writing (settings.json files over 256 KB are skipped) and run the same
    /// per-document code as a real run (<see cref="UserSettingsBulk"/>), so a dry run reports what
    /// the run does. Real runs re-read every document inside its per-file lock and decide there.
    /// One run or undo at a time per process.
    /// </summary>
    public sealed class UserSettingsOperations
    {
        /// <summary>Largest settings.json an operation or overview reads (a whole document is about 3 KB; writes are capped at 64 KB).</summary>
        public const long SettingsSizeLimit = 256 * 1024;

        /// <summary>How many undo records are kept (open question 9: the last 20).</summary>
        public const int KeepRecords = 20;

        /// <summary>Document name for hidden-content Settings in outcomes.</summary>
        public const string HiddenContentDocument = "HiddenContent";

        /// <summary>Document name for Spoiler Guard Prefs in outcomes.</summary>
        public const string SpoilerGuardDocument = "SpoilerGuard";

        private const string SettingsFile = "settings.json";
        private const string HiddenContentFile = "hidden-content.json";
        private const string SpoilerFile = Services.SpoilerBlurImageFilter.SpoilerBlurFileName;

        private static readonly object RunGate = new();

        private readonly UserConfigurationManager _manager;
        private readonly Logger _logger;
        private readonly Func<IReadOnlyDictionary<string, string>?> _liveUsers;
        private readonly Func<PluginConfiguration, HiddenContentSettings> _hiddenContentDefaults;

        /// <summary>Initializes a new instance of the <see cref="UserSettingsOperations"/> class.</summary>
        /// <param name="manager">The per-user file store.</param>
        /// <param name="logger">The plugin logger.</param>
        /// <param name="liveUsers">Live Jellyfin user names by canonical id (the GetAllUsers shim); null when they cannot be listed.</param>
        /// <param name="hiddenContentDefaults">The hidden-content Settings a reset writes for the admin defaults.</param>
        public UserSettingsOperations(UserConfigurationManager manager, Logger logger, Func<IReadOnlyDictionary<string, string>?> liveUsers, Func<PluginConfiguration, HiddenContentSettings> hiddenContentDefaults)
        {
            _manager = manager;
            _logger = logger;
            _liveUsers = liveUsers;
            _hiddenContentDefaults = hiddenContentDefaults;
        }

        /// <summary>
        /// Every user a bulk operation can reach: live Jellyfin users (through the GetAllUsers shim) and
        /// canonical settings directories (the #159 walk), so a failure of either source still leaves
        /// the other. A directory with no live user is an orphan (only when users could be listed).
        /// </summary>
        /// <returns>The users and which sources answered.</returns>
        public UserSettingsPopulation ListUsers()
        {
            var population = new UserSettingsPopulation();
            var live = _liveUsers();
            population.LiveListed = live != null;
            population.DirectoriesListed = _manager.TryGetAllUserIds(out var directories);
            var withDirectory = new HashSet<string>(directories, StringComparer.Ordinal);
            var ids = new HashSet<string>(withDirectory, StringComparer.Ordinal);
            if (live != null) ids.UnionWith(live.Keys);
            foreach (var id in ids)
            {
                string? name = null;
                var isLive = live != null && live.TryGetValue(id, out name);
                population.Users.Add(new UserSettingsTarget(id, name, isLive, withDirectory.Contains(id)));
            }

            population.Users.Sort((a, b) =>
            {
                var byLive = (a.Name == null ? 1 : 0) - (b.Name == null ? 1 : 0);
                if (byLive != 0) return byLive;
                var byName = string.Compare(a.Name, b.Name, StringComparison.OrdinalIgnoreCase);
                return byName != 0 ? byName : string.CompareOrdinal(a.Id, b.Id);
            });
            return population;
        }

        /// <summary>
        /// Runs (or previews) one operation for the given users. A user with no settings directory has
        /// nothing to change (reported as no settings: they get the current defaults when they first use
        /// Jellyfin Enhanced). Overwrite also replaces hidden-content Settings and existing Spoiler Guard
        /// Prefs, as the old reset did; items, lists and bookmarks are never touched. A real run that
        /// changed anything writes an undo record under <paramref name="operationId"/>.
        /// </summary>
        /// <param name="config">The saved plugin configuration.</param>
        /// <param name="keys">The selected registry keys.</param>
        /// <param name="mode">The mode.</param>
        /// <param name="users">The users to apply to.</param>
        /// <param name="dryRun">True to preview: nothing is written, moved or quarantined.</param>
        /// <param name="operationId">The operation id stamped on every change.</param>
        /// <param name="utcNow">The time of the run.</param>
        /// <returns>One outcome per user, in the order given, and whether an undo record was written.</returns>
        public (List<UserSettingsOutcome> Outcomes, bool Recorded) Run(PluginConfiguration config, IReadOnlyList<UserSettingDescriptor> keys, UserSettingsApplyMode mode, IEnumerable<UserSettingsTarget> users, bool dryRun, string operationId, DateTime utcNow)
        {
            ArgumentNullException.ThrowIfNull(config);
            var outcomes = new List<UserSettingsOutcome>();
            if (dryRun)
            {
                foreach (var user in users) outcomes.Add(RunForUser(config, keys, mode, user, dryRun: true, operationId, utcNow));
                return (outcomes, false);
            }

            lock (RunGate)
            {
                foreach (var user in users) outcomes.Add(RunForUser(config, keys, mode, user, dryRun: false, operationId, utcNow));
                var changed = outcomes.Where(o => o.Changes.Count > 0 || o.DocumentChanges.Count > 0).ToList();
                if (changed.Count == 0)
                {
                    return (outcomes, false);
                }

                var record = new UserSettingsOperationRecord
                {
                    Id = operationId,
                    Created = utcNow,
                    Mode = mode.ToString(),
                    Keys = keys.Select(k => k.Key).ToList(),
                    Users = changed.Select(o => new UserSettingsOperationUser { UserId = o.User.Id, Settings = o.Changes, Documents = o.DocumentChanges }).ToList(),
                };
                try
                {
                    _manager.SaveOperationRecord(operationId, record, KeepRecords);
                    return (outcomes, true);
                }
                catch (Exception ex)
                {
                    _logger.Error($"Could not save the undo record for user settings operation {operationId}: {ex.Message}");
                    return (outcomes, false);
                }
            }
        }

        private UserSettingsOutcome RunForUser(PluginConfiguration config, IReadOnlyList<UserSettingDescriptor> keys, UserSettingsApplyMode mode, UserSettingsTarget user, bool dryRun, string operationId, DateTime utcNow)
        {
            var outcome = new UserSettingsOutcome(user);
            if (!user.HasDirectory)
            {
                return outcome;
            }

            try
            {
                if (dryRun)
                {
                    PlanSettings(outcome, config, keys, mode, operationId, utcNow);
                }
                else
                {
                    lock (_manager.GetUserFileLock(user.Id, SettingsFile))
                    {
                        var document = PlanSettings(outcome, config, keys, mode, operationId, utcNow);
                        if (document != null)
                        {
                            _manager.SaveUserConfiguration(user.Id, SettingsFile, document);
                        }
                    }
                }
            }
            catch (Exception ex)
            {
                _logger.Warning($"User settings operation {operationId}: settings.json for {Describe(user)} was not changed: {ex.Message}");
                outcome.Settings = Reason(ex);
                outcome.Changes.Clear();
                outcome.Kept.Clear();
            }

            if (mode == UserSettingsApplyMode.Overwrite)
            {
                ResetDocument<UserHiddenContent, HiddenContentSettings>(outcome, HiddenContentDocument, HiddenContentFile, createIfMissing: true,
                    hc => hc.Settings ?? new HiddenContentSettings(), (hc, value) => hc.Settings = value, _hiddenContentDefaults(config), dryRun, operationId);
                ResetDocument<UserSpoilerBlur, SpoilerBlurUserPrefs>(outcome, SpoilerGuardDocument, SpoilerFile, createIfMissing: false,
                    sb => sb.Prefs ?? new SpoilerBlurUserPrefs(), (sb, value) => sb.Prefs = value, new SpoilerBlurUserPrefs(), dryRun, operationId);
            }

            return outcome;
        }

        /// <summary>
        /// Reads settings.json without quarantine (the caller holds the file lock for a real run) and
        /// applies the operation to it. Returns the document to save, or null when nothing changed or
        /// it could not be read (the outcome says why).
        /// </summary>
        private UserSettings? PlanSettings(UserSettingsOutcome outcome, PluginConfiguration config, IReadOnlyList<UserSettingDescriptor> keys, UserSettingsApplyMode mode, string operationId, DateTime utcNow)
        {
            var status = _manager.PeekUserConfiguration<UserSettings>(outcome.User.Id, SettingsFile, SettingsSizeLimit, out var document, out _);
            outcome.Settings = status switch
            {
                UserDocumentPeekStatus.Missing => UserSettingsOutcome.None,
                UserDocumentPeekStatus.Corrupt => UserSettingsOutcome.Corrupt,
                UserDocumentPeekStatus.Oversized => UserSettingsOutcome.Oversized,
                UserDocumentPeekStatus.Unavailable => UserSettingsOutcome.Unavailable,
                _ => UserSettingsOutcome.Unchanged,
            };
            if (status != UserDocumentPeekStatus.Loaded)
            {
                return null;
            }

            var plan = UserSettingsBulk.Apply(document!, config, keys, mode, operationId, utcNow);
            outcome.Changes.AddRange(plan.Changes);
            outcome.Kept.AddRange(plan.Kept);
            if (plan.Changes.Count > 0) outcome.Settings = UserSettingsOutcome.Changed;
            return plan.Changed ? document : null;
        }

        /// <summary>
        /// Overwrite's reset of one settings section in another per-user document (hidden-content
        /// Settings, Spoiler Guard Prefs). A preview reads without quarantine; a real run uses the
        /// locked strict read-modify-write the old reset used (a malformed file is moved aside, as before).
        /// </summary>
        private void ResetDocument<TDocument, TSection>(UserSettingsOutcome outcome, string document, string file, bool createIfMissing, Func<TDocument, TSection> read, Action<TDocument, TSection> write, TSection target, bool dryRun, string operationId)
            where TDocument : class, new()
            where TSection : class
        {
            var targetToken = JToken.FromObject(target);
            if (dryRun)
            {
                var status = _manager.PeekUserConfiguration<TDocument>(outcome.User.Id, file, 0, out var current, out _);
                outcome.Documents[document] = status switch
                {
                    UserDocumentPeekStatus.Missing when !createIfMissing => UserSettingsOutcome.None,
                    UserDocumentPeekStatus.Missing => JToken.DeepEquals(JToken.FromObject(read(new TDocument())), targetToken) ? UserSettingsOutcome.Unchanged : UserSettingsOutcome.Changed,
                    UserDocumentPeekStatus.Loaded => JToken.DeepEquals(JToken.FromObject(read(current!)), targetToken) ? UserSettingsOutcome.Unchanged : UserSettingsOutcome.Changed,
                    UserDocumentPeekStatus.Corrupt => UserSettingsOutcome.Corrupt,
                    _ => UserSettingsOutcome.Unavailable,
                };
                return;
            }

            if (!createIfMissing && !_manager.UserConfigurationExists(outcome.User.Id, file))
            {
                outcome.Documents[document] = UserSettingsOutcome.None;
                return;
            }

            try
            {
                JToken? before = null;
                var changed = _manager.RmwUserConfiguration<TDocument>(outcome.User.Id, file, current =>
                {
                    before = JToken.FromObject(read(current));
                    if (JToken.DeepEquals(before, targetToken))
                    {
                        return 0;
                    }

                    write(current, targetToken.ToObject<TSection>()!);
                    return 1;
                });
                outcome.Documents[document] = changed > 0 ? UserSettingsOutcome.Changed : UserSettingsOutcome.Unchanged;
                if (changed > 0)
                {
                    outcome.DocumentChanges.Add(new UserDocumentChange { File = file, Before = before, After = targetToken });
                }
            }
            catch (Exception ex)
            {
                _logger.Warning($"User settings operation {operationId}: {file} for {Describe(outcome.User)} was not reset: {ex.Message}");
                outcome.Documents[document] = Reason(ex);
            }
        }

        /// <summary>
        /// Undoes an operation (compare-and-swap, see <see cref="UserSettingsBulk.Undo"/>; a replaced
        /// document section is restored only while it still holds what the operation wrote) and marks
        /// its record undone. The record is read inside the run gate, so two undo requests for one
        /// operation cannot both run.
        /// </summary>
        /// <param name="operationId">A valid operation id.</param>
        /// <param name="config">The plugin configuration, or null when it is not loaded.</param>
        /// <param name="names">Live user names by canonical id (may be empty).</param>
        /// <param name="utcNow">The time of the undo.</param>
        /// <param name="outcomes">One outcome per user in the record when it ran.</param>
        /// <returns>Null when it ran; "not-found" or "already-undone" otherwise.</returns>
        public string? Undo(string operationId, PluginConfiguration? config, IReadOnlyDictionary<string, string> names, DateTime utcNow, out List<UserSettingsUndoOutcome> outcomes)
        {
            outcomes = new List<UserSettingsUndoOutcome>();
            lock (RunGate)
            {
                var record = ReadRecord(operationId);
                if (record == null)
                {
                    return "not-found";
                }

                if (record.Undone != null)
                {
                    return "already-undone";
                }

                foreach (var user in record.Users ?? new List<UserSettingsOperationUser>())
                {
                    if (user?.UserId == null || !System.Text.RegularExpressions.Regex.IsMatch(user.UserId, "^[0-9a-f]{32}$"))
                    {
                        continue;
                    }

                    var target = new UserSettingsTarget(user.UserId, names.TryGetValue(user.UserId, out var name) ? name : null, names.ContainsKey(user.UserId), true);
                    var outcome = new UserSettingsUndoOutcome(target);
                    outcomes.Add(outcome);
                    if (user.Settings != null && user.Settings.Count > 0)
                    {
                        UndoSettings(outcome, user.Settings, record.Id, config, utcNow);
                    }

                    foreach (var change in user.Documents ?? new List<UserDocumentChange>())
                    {
                        if (change?.File == HiddenContentFile)
                        {
                            UndoDocument<UserHiddenContent, HiddenContentSettings>(outcome, change, HiddenContentDocument, hc => hc.Settings ?? new HiddenContentSettings(), (hc, value) => hc.Settings = value, record.Id);
                        }
                        else if (change?.File == SpoilerFile)
                        {
                            UndoDocument<UserSpoilerBlur, SpoilerBlurUserPrefs>(outcome, change, SpoilerGuardDocument, sb => sb.Prefs ?? new SpoilerBlurUserPrefs(), (sb, value) => sb.Prefs = value, record.Id);
                        }
                    }
                }

                record.Undone = utcNow;
                _manager.SaveOperationRecord(record.Id, record, 0);
            }

            return null;
        }

        private void UndoSettings(UserSettingsUndoOutcome outcome, List<UserSettingsKeyChange> changes, string operationId, PluginConfiguration? config, DateTime utcNow)
        {
            try
            {
                lock (_manager.GetUserFileLock(outcome.User.Id, SettingsFile))
                {
                    var status = _manager.PeekUserConfiguration<UserSettings>(outcome.User.Id, SettingsFile, SettingsSizeLimit, out var document, out _);
                    if (status != UserDocumentPeekStatus.Loaded)
                    {
                        outcome.Failed[SettingsFile] = status == UserDocumentPeekStatus.Missing ? UserSettingsOutcome.None
                            : status == UserDocumentPeekStatus.Corrupt ? UserSettingsOutcome.Corrupt
                            : status == UserDocumentPeekStatus.Oversized ? UserSettingsOutcome.Oversized
                            : UserSettingsOutcome.Unavailable;
                        return;
                    }

                    var restored = new List<string>();
                    var kept = new List<string>();
                    if (UserSettingsBulk.Undo(document!, config, changes, operationId, utcNow, restored, kept))
                    {
                        _manager.SaveUserConfiguration(outcome.User.Id, SettingsFile, document!);
                    }

                    outcome.Restored.AddRange(restored);
                    outcome.Kept.AddRange(kept);
                }
            }
            catch (Exception ex)
            {
                _logger.Warning($"Undo of user settings operation {operationId}: settings.json for {Describe(outcome.User)} was not restored: {ex.Message}");
                outcome.Restored.Clear();
                outcome.Failed[SettingsFile] = Reason(ex);
            }
        }

        private void UndoDocument<TDocument, TSection>(UserSettingsUndoOutcome outcome, UserDocumentChange change, string document, Func<TDocument, TSection> read, Action<TDocument, TSection> write, string operationId)
            where TDocument : class, new()
            where TSection : class
        {
            if (!_manager.UserConfigurationExists(outcome.User.Id, change.File))
            {
                outcome.Kept.Add(document);
                return;
            }

            try
            {
                var restored = _manager.RmwUserConfiguration<TDocument>(outcome.User.Id, change.File, current =>
                {
                    if (change.After == null || change.Before == null || !JToken.DeepEquals(JToken.FromObject(read(current)), change.After))
                    {
                        return 0;
                    }

                    write(current, change.Before.ToObject<TSection>()!);
                    return 1;
                });
                (restored > 0 ? outcome.Restored : outcome.Kept).Add(document);
            }
            catch (Exception ex)
            {
                _logger.Warning($"Undo of user settings operation {operationId}: {change.File} for {Describe(outcome.User)} was not restored: {ex.Message}");
                outcome.Failed[change.File] = Reason(ex);
            }
        }

        /// <summary>Reads an undo record; null when there is none with that id or it cannot be parsed.</summary>
        /// <param name="operationId">A valid operation id.</param>
        /// <returns>The record, or null.</returns>
        public UserSettingsOperationRecord? ReadRecord(string operationId)
        {
            var text = _manager.ReadOperationRecord(operationId);
            if (text == null) return null;
            try
            {
                var record = JsonConvert.DeserializeObject<UserSettingsOperationRecord>(text);
                return record != null && string.Equals(record.Id, operationId, StringComparison.Ordinal) ? record : null;
            }
            catch (JsonException ex)
            {
                _logger.Warning($"Undo record {operationId} could not be read: {ex.Message}");
                return null;
            }
        }

        /// <summary>The coarse reason for a failed read or write (the exception text stays in the log).</summary>
        /// <param name="ex">The exception.</param>
        /// <returns>corrupt, unavailable or error.</returns>
        public static string Reason(Exception ex) => ex is InvalidDataException || ex is JsonException
            ? UserSettingsOutcome.Corrupt
            : ex is IOException || ex is UnauthorizedAccessException ? UserSettingsOutcome.Unavailable : UserSettingsOutcome.Error;

        private static string Describe(UserSettingsTarget user) => user.Name == null ? user.Id : $"{user.Name} ({user.Id})";
    }
}
