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

        /// <summary>Gets or sets the operation that had replaced the section before this one, if any.</summary>
        public string? BeforeOp { get; set; }

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

        private static readonly DocumentSection<UserHiddenContent, HiddenContentSettings> HiddenContentSection = new(
            HiddenContentDocument, HiddenContentFile, true, hc => hc.Settings ?? new HiddenContentSettings(), (hc, value) => hc.Settings = value, hc => hc.SettingsOp, (hc, op) => hc.SettingsOp = op);

        private static readonly DocumentSection<UserSpoilerBlur, SpoilerBlurUserPrefs> SpoilerSection = new(
            SpoilerGuardDocument, SpoilerFile, false, sb => sb.Prefs ?? new SpoilerBlurUserPrefs(), (sb, value) => sb.Prefs = value, sb => sb.PrefsOp, (sb, op) => sb.PrefsOp = op);

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
        /// changed anything writes an undo record under <paramref name="operationId"/>; when that record
        /// cannot be saved the changes stay and <c>UndoUnavailable</c> says they cannot be undone.
        /// </summary>
        /// <param name="config">The saved plugin configuration.</param>
        /// <param name="keys">The selected registry keys.</param>
        /// <param name="mode">The mode.</param>
        /// <param name="users">The users to apply to.</param>
        /// <param name="dryRun">True to preview: nothing is written, moved or quarantined.</param>
        /// <param name="operationId">The operation id stamped on every change.</param>
        /// <param name="utcNow">The time of the run.</param>
        /// <param name="resetPanelTab">Also reset the panel tab, as the old reset did (legacy reset-all only).</param>
        /// <returns>One outcome per user, in the order given; whether an undo record was written; and
        /// whether a real run changed something but its undo record could not be saved.</returns>
        public (List<UserSettingsOutcome> Outcomes, bool Recorded, bool UndoUnavailable) Run(PluginConfiguration config, IReadOnlyList<UserSettingDescriptor> keys, UserSettingsApplyMode mode, IEnumerable<UserSettingsTarget> users, bool dryRun, string operationId, DateTime utcNow, bool resetPanelTab = false)
        {
            ArgumentNullException.ThrowIfNull(config);
            var outcomes = new List<UserSettingsOutcome>();
            if (dryRun)
            {
                foreach (var user in users) outcomes.Add(RunForUser(config, keys, mode, user, dryRun: true, operationId, utcNow, resetPanelTab));
                return (outcomes, false, false);
            }

            lock (RunGate)
            {
                foreach (var user in users) outcomes.Add(RunForUser(config, keys, mode, user, dryRun: false, operationId, utcNow, resetPanelTab));
                var changed = outcomes.Where(o => o.Changes.Count > 0 || o.DocumentChanges.Count > 0).ToList();
                if (changed.Count == 0)
                {
                    return (outcomes, false, false);
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
                    return (outcomes, true, false);
                }
                catch (Exception ex)
                {
                    _logger.Error($"Could not save the undo record for user settings operation {operationId}; its changes to {changed.Count} users cannot be undone: {ex.Message}");
                    return (outcomes, false, true);
                }
            }
        }

        private UserSettingsOutcome RunForUser(PluginConfiguration config, IReadOnlyList<UserSettingDescriptor> keys, UserSettingsApplyMode mode, UserSettingsTarget user, bool dryRun, string operationId, DateTime utcNow, bool resetPanelTab)
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
                    PlanSettings(outcome, config, keys, mode, operationId, utcNow, resetPanelTab);
                }
                else
                {
                    lock (_manager.GetUserFileLock(user.Id, SettingsFile))
                    {
                        var document = PlanSettings(outcome, config, keys, mode, operationId, utcNow, resetPanelTab);
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
                ResetDocument(outcome, HiddenContentSection, _hiddenContentDefaults(config), dryRun, operationId);
                ResetDocument(outcome, SpoilerSection, new SpoilerBlurUserPrefs(), dryRun, operationId);
            }

            return outcome;
        }

        /// <summary>
        /// Reads settings.json without quarantine (the caller holds the file lock for a real run) and
        /// applies the operation to it. Returns the document to save, or null when nothing changed or
        /// it could not be read (the outcome says why).
        /// </summary>
        private UserSettings? PlanSettings(UserSettingsOutcome outcome, PluginConfiguration config, IReadOnlyList<UserSettingDescriptor> keys, UserSettingsApplyMode mode, string operationId, DateTime utcNow, bool resetPanelTab)
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

            var plan = UserSettingsBulk.Apply(document!, config, keys, mode, operationId, utcNow, resetPanelTab);
            outcome.Changes.AddRange(plan.Changes);
            outcome.Kept.AddRange(plan.Kept);
            if (plan.Changes.Count > 0) outcome.Settings = UserSettingsOutcome.Changed;
            return plan.Changed ? document : null;
        }

        /// <summary>
        /// Overwrite's reset of one settings section in another per-user document (hidden-content
        /// Settings, Spoiler Guard Prefs). A preview reads without quarantine; a real run uses the
        /// locked strict read-modify-write the old reset used (a malformed file is moved aside, as before)
        /// and stamps the replaced section with the operation id, which undo requires.
        /// </summary>
        private void ResetDocument<TDocument, TSection>(UserSettingsOutcome outcome, DocumentSection<TDocument, TSection> section, TSection target, bool dryRun, string operationId)
            where TDocument : class, new()
            where TSection : class
        {
            var targetToken = JToken.FromObject(target);
            if (dryRun)
            {
                var status = _manager.PeekUserConfiguration<TDocument>(outcome.User.Id, section.File, 0, out var current, out _);
                outcome.Documents[section.Name] = status switch
                {
                    UserDocumentPeekStatus.Missing when !section.CreateIfMissing => UserSettingsOutcome.None,
                    UserDocumentPeekStatus.Missing => JToken.DeepEquals(JToken.FromObject(section.Read(new TDocument())), targetToken) ? UserSettingsOutcome.Unchanged : UserSettingsOutcome.Changed,
                    UserDocumentPeekStatus.Loaded => JToken.DeepEquals(JToken.FromObject(section.Read(current!)), targetToken) ? UserSettingsOutcome.Unchanged : UserSettingsOutcome.Changed,
                    UserDocumentPeekStatus.Corrupt => UserSettingsOutcome.Corrupt,
                    _ => UserSettingsOutcome.Unavailable,
                };
                return;
            }

            if (!section.CreateIfMissing && !_manager.UserConfigurationExists(outcome.User.Id, section.File))
            {
                outcome.Documents[section.Name] = UserSettingsOutcome.None;
                return;
            }

            try
            {
                JToken? before = null;
                string? beforeOp = null;
                var changed = _manager.RmwUserConfiguration<TDocument>(outcome.User.Id, section.File, current =>
                {
                    before = JToken.FromObject(section.Read(current));
                    beforeOp = section.GetStamp(current);
                    if (JToken.DeepEquals(before, targetToken))
                    {
                        return 0;
                    }

                    section.Write(current, targetToken.ToObject<TSection>()!);
                    section.SetStamp(current, operationId);
                    return 1;
                });
                outcome.Documents[section.Name] = changed > 0 ? UserSettingsOutcome.Changed : UserSettingsOutcome.Unchanged;
                if (changed > 0)
                {
                    outcome.DocumentChanges.Add(new UserDocumentChange { File = section.File, Before = before, BeforeOp = beforeOp, After = targetToken });
                }
            }
            catch (Exception ex)
            {
                _logger.Warning($"User settings operation {operationId}: {section.File} for {Describe(outcome.User)} was not reset: {ex.Message}");
                outcome.Documents[section.Name] = Reason(ex);
            }
        }

        /// <summary>
        /// The undo stamp a whole-document save of hidden-content.json or spoilerblur.json keeps: the
        /// stored stamp while the incoming section is the stored one (the save changed something
        /// else, such as hidden items), none once the section changes. A client's own value never counts.
        /// </summary>
        /// <typeparam name="TSection">The section type.</typeparam>
        /// <param name="stored">The stored section.</param>
        /// <param name="storedStamp">The stored stamp.</param>
        /// <param name="incoming">The section being saved.</param>
        /// <returns>The stamp to save.</returns>
        public static string? CarryStamp<TSection>(TSection? stored, string? storedStamp, TSection? incoming)
            where TSection : class, new()
        {
            if (storedStamp == null) return null;
            return JToken.DeepEquals(JToken.FromObject(stored ?? new TSection()), JToken.FromObject(incoming ?? new TSection())) ? storedStamp : null;
        }

        /// <summary>
        /// Undoes an operation (compare-and-swap, see <see cref="UserSettingsBulk.Undo"/>; a replaced
        /// document section is restored only while it still holds what the operation wrote and carries
        /// its stamp) and marks its record undone. When a file could not be read or written for a
        /// passing reason (<see cref="CanRetry"/>), the record keeps just those parts and stays open, so
        /// the undo can be run again for them. The record is read inside the run gate, so two undo
        /// requests for one operation cannot both run.
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
                var pending = new List<UserSettingsOperationUser>();
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
                            UndoDocument(outcome, change, HiddenContentSection, record.Id);
                        }
                        else if (change?.File == SpoilerFile)
                        {
                            UndoDocument(outcome, change, SpoilerSection, record.Id);
                        }
                    }

                    // What could not be read or written for a passing reason stays to be undone on a retry
                    // (safe: undo is compare-and-swap); a corrupt or missing file is final.
                    var retry = new UserSettingsOperationUser { UserId = user.UserId };
                    if (outcome.Failed.TryGetValue(SettingsFile, out var settingsFailure) && CanRetry(settingsFailure))
                    {
                        retry.Settings = user.Settings ?? new List<UserSettingsKeyChange>();
                    }

                    retry.Documents = (user.Documents ?? new List<UserDocumentChange>())
                        .Where(change => change?.File != null && outcome.Failed.TryGetValue(change.File, out var failure) && CanRetry(failure))
                        .ToList();
                    if (retry.Settings.Count > 0 || retry.Documents.Count > 0)
                    {
                        pending.Add(retry);
                    }
                }

                if (pending.Count > 0)
                {
                    record.Users = pending;
                }
                else
                {
                    record.Undone = utcNow;
                }

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

        /// <summary>
        /// Restores a replaced section only while it still carries the operation's stamp and holds what
        /// the operation wrote; the stamp it had before comes back with it.
        /// </summary>
        private void UndoDocument<TDocument, TSection>(UserSettingsUndoOutcome outcome, UserDocumentChange change, DocumentSection<TDocument, TSection> section, string operationId)
            where TDocument : class, new()
            where TSection : class
        {
            if (!_manager.UserConfigurationExists(outcome.User.Id, change.File))
            {
                outcome.Kept.Add(section.Name);
                return;
            }

            try
            {
                var restored = _manager.RmwUserConfiguration<TDocument>(outcome.User.Id, change.File, current =>
                {
                    if (change.After == null || change.Before == null
                        || !string.Equals(section.GetStamp(current), operationId, StringComparison.Ordinal)
                        || !JToken.DeepEquals(JToken.FromObject(section.Read(current)), change.After))
                    {
                        return 0;
                    }

                    section.Write(current, change.Before.ToObject<TSection>()!);
                    section.SetStamp(current, change.BeforeOp);
                    return 1;
                });
                (restored > 0 ? outcome.Restored : outcome.Kept).Add(section.Name);
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

        /// <summary>Whether an undo failure may pass on a retry (the file could not be read or written now).</summary>
        /// <param name="reason">The failure reason.</param>
        /// <returns>True for unavailable or an unexpected error.</returns>
        public static bool CanRetry(string reason) => reason == UserSettingsOutcome.Unavailable || reason == UserSettingsOutcome.Error;

        private static string Describe(UserSettingsTarget user) => user.Name == null ? user.Id : $"{user.Name} ({user.Id})";

        /// <summary>A settings section an Overwrite replaces in another per-user document, with its undo stamp.</summary>
        /// <param name="Name">The document name in outcomes.</param>
        /// <param name="File">The per-user file.</param>
        /// <param name="CreateIfMissing">Whether a reset creates the file.</param>
        /// <param name="Read">Reads the section.</param>
        /// <param name="Write">Replaces the section.</param>
        /// <param name="GetStamp">Reads the operation stamp.</param>
        /// <param name="SetStamp">Writes the operation stamp.</param>
        private sealed record DocumentSection<TDocument, TSection>(string Name, string File, bool CreateIfMissing, Func<TDocument, TSection> Read, Action<TDocument, TSection> Write, Func<TDocument, string?> GetStamp, Action<TDocument, string?> SetStamp);
    }
}
