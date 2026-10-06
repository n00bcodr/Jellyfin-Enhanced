using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Data;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Extensions;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Session;
using MediaBrowser.Model.Session;
using Newtonsoft.Json;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services
{
    public class MaintenanceState
    {
        public bool IsActive { get; set; }
        public string Message { get; set; } = string.Empty;
        /// <summary>Popup text for active sessions (broadcast on enable, re-sent by the playback reminder).</summary>
        public string NotificationMessage { get; set; } = string.Empty;
        /// <summary>"none" | "disable_accounts" | "disable_remote" | "both"</summary>
        public string Action { get; set; } = "disable_accounts";
        /// <summary>"manual" (admin toggle / API) or "schedule" (MaintenanceScheduleService window).</summary>
        public string Source { get; set; } = "manual";
        public DateTime StartedAt { get; set; }
        public DateTime? EndsAt { get; set; }
        /// <summary>Duration the last manual enable asked for (0 = open-ended). Lets a repeat save with the
        /// same duration keep the running clock instead of restarting it.</summary>
        public int RequestedDurationMinutes { get; set; }
        /// <summary>Users whose accounts were disabled by maintenance mode (so we know what to restore).</summary>
        public List<string> AccountDisabledUserIds { get; set; } = new();
        /// <summary>Users whose remote access was disabled by maintenance mode.</summary>
        public List<string> RemoteDisabledUserIds { get; set; } = new();
        /// <summary>The affected-user selection last requested (null/empty = all non-admin users). Compared
        /// against on a re-enable call so a changed Action/selection while already active is actually
        /// re-applied instead of silently ignored.</summary>
        public List<string>? RequestedAffectedUserIds { get; set; }
        /// <summary>Set on the inactive state when an admin ended a scheduled window early: the end of
        /// that occurrence, so the schedule does not reopen it on the next tick.</summary>
        public DateTime? SkippedScheduledWindowEnd { get; set; }
    }

    public class MaintenanceModeService
    {
        public const string DefaultHeader = "Server Maintenance";
        public const string DefaultNotificationText = "Server maintenance is starting. Please finish up and try again later.";

        private readonly IUserManager _userManager;
        private readonly ISessionManager _sessionManager;
        private readonly Logger _logger;
        private readonly string _stateFilePath;
        // Serializes every state change (enable, reconcile, disable + restore). The config page save,
        // the schedule tick and the expiry path can all run at once; without this an overlapping
        // reconcile/restore could record the wrong disabled-user list and leave accounts locked.
        private readonly SemaphoreSlim _gate = new(1, 1);
        // In-memory copy of the state file. public-config (every page load, anonymous) and the
        // playback reminder now read the state, so it must not cost a file read per request.
        private MaintenanceState? _cached;
        // Set while maintenance-state.json exists but cannot be read or parsed. That file may be the
        // only record of whom to restore, so nothing writes over it and enable refuses until an admin
        // repairs or removes it. Cleared by the next successful load.
        private volatile string? _stateLoadError;
        // The failure last reported (message plus file size/time), so a broken file is logged and
        // backed up once rather than on every status read.
        private volatile string? _reportedLoadFailure;

        // A restore that keeps failing leaves users locked out, so the schedule tick keeps retrying it,
        // but with backoff: the first retry runs on the next tick, then the wait doubles from 30 s up
        // to an hour. Tracked in memory only; a restart retries at once. Each failure streak is logged
        // at Error once, later attempts at Warning (per-user detail at Debug).
        private static readonly TimeSpan RestoreRetryBaseDelay = TimeSpan.FromSeconds(30);
        private static readonly TimeSpan RestoreRetryMaxDelay = TimeSpan.FromHours(1);
        private readonly TimeProvider _timeProvider;
        // Consecutive restore attempts that left a user unrestored; changed under _gate.
        private int _restoreFailureStreak;
        // UTC ticks before which the schedule tick skips the pending-restore retry; 0 = retry now.
        private long _restoreRetryNotBeforeTicks;

        // Set when a fail-open checkpoint (or the enable journal) could not be written, so the file is
        // behind the in-memory state. A stale active journal left there would act again after a
        // restart, so the schedule tick keeps rewriting the in-memory state, with the same backoff as
        // restores, until a save lands. Every successful save clears it. Changed under _gate.
        private volatile bool _journalDirty;
        // Consecutive tick rewrites of a dirty journal that failed; changed under _gate.
        private int _journalFailureStreak;
        // UTC ticks before which the schedule tick skips the dirty-journal rewrite; 0 = retry now.
        private long _journalRetryNotBeforeTicks;

        public MaintenanceModeService(IUserManager userManager, ISessionManager sessionManager, IApplicationPaths appPaths, Logger logger)
            : this(userManager, sessionManager, appPaths, logger, TimeProvider.System)
        {
        }

        internal MaintenanceModeService(IUserManager userManager, ISessionManager sessionManager, IApplicationPaths appPaths, Logger logger, TimeProvider timeProvider)
        {
            _timeProvider = timeProvider;
            _userManager = userManager;
            _sessionManager = sessionManager;
            _logger = logger;
            var dir = Path.Combine(appPaths.PluginsPath, "configurations", "Jellyfin.Plugin.JellyfinEnhanced");
            Directory.CreateDirectory(dir);
            _stateFilePath = Path.Combine(dir, "maintenance-state.json");
        }

        public MaintenanceState GetStatus()
        {
            var state = LoadState();
            if (IsExpired(state))
            {
                _ = Task.Run(() => ExpireIfDueAsync());
                return new MaintenanceState { IsActive = false };
            }
            return state;
        }

        private static bool IsExpired(MaintenanceState state)
            => state.IsActive && state.EndsAt.HasValue && DateTime.UtcNow >= state.EndsAt.Value;

        private static bool HasPendingRestores(MaintenanceState state)
            => state.AccountDisabledUserIds.Count > 0 || state.RemoteDisabledUserIds.Count > 0;

        /// <summary>
        /// Same expiry check as <see cref="GetStatus"/>, but awaits the disable so the caller
        /// (the schedule tick) sees the settled state instead of racing the background restore.
        /// </summary>
        public async Task<MaintenanceState> ExpireIfDueAsync()
        {
            if (_journalDirty) await RetryDirtyJournalAsync().ConfigureAwait(false);
            var current = LoadState();
            // A window that ran out always ends; a pending restore waits out its retry backoff.
            var retryDue = _timeProvider.GetUtcNow().UtcTicks >= Interlocked.Read(ref _restoreRetryNotBeforeTicks);
            if (IsExpired(current) || (!current.IsActive && HasPendingRestores(current) && retryDue))
            {
                // Re-checked under the gate: an admin may have re-enabled with a new end time meanwhile.
                await DisableCoreAsync(state => IsExpired(state) || !state.IsActive, "Timed window reached its end or restoration pending", false).ConfigureAwait(false);
            }
            return LoadState();
        }

        /// <param name="action">"none" | "disable_accounts" | "disable_remote" | "both"</param>
        /// <param name="affectedUserIds">Specific user IDs to affect; null or empty = all non-admin users.</param>
        /// <param name="notificationMessage">Popup text kept on the state for the playback reminder.</param>
        public Task EnableAsync(string message, int durationMinutes, string action, List<string>? affectedUserIds, string? notificationMessage = null)
            => EnableCoreAsync(message, notificationMessage, action, affectedUserIds, "manual", durationMinutes, null);

        /// <summary>
        /// Enable (or keep enabled) on behalf of the daily schedule; the window end is absolute rather
        /// than a duration from now, so a tick that runs mid-window still ends at the configured time.
        /// Safe to call every tick: when nothing changed it is a no-op. A manual window always wins:
        /// when one is active (checked under the gate) nothing happens.
        /// </summary>
        /// <returns>True when this call opened a new window (the caller announces it).</returns>
        public Task<bool> EnableScheduledAsync(string message, string? notificationMessage, string action, List<string>? affectedUserIds, DateTime windowEndUtc)
            => EnableCoreAsync(message, notificationMessage, action, affectedUserIds, "schedule", 0, windowEndUtc);

        /// <returns>True when maintenance was inactive before this call and is now active.</returns>
        private async Task<bool> EnableCoreAsync(string message, string? notificationMessage, string action, List<string>? affectedUserIds,
            string source, int durationMinutes, DateTime? fixedEndsAtUtc)
        {
            await _gate.WaitAsync().ConfigureAwait(false);
            try
            {
                var current = LoadState();
                var wasActive = current.IsActive;
                if (source == "schedule")
                {
                    // Manual always wins; an occurrence an admin ended early stays ended.
                    if (wasActive && current.Source != "schedule") return false;
                    if (!wasActive && current.SkippedScheduledWindowEnd == fixedEndsAtUtc) return false;
                }
                await EnableLockedAsync(message, notificationMessage, action, affectedUserIds, source, durationMinutes, fixedEndsAtUtc).ConfigureAwait(false);
                return !wasActive;
            }
            finally
            {
                _gate.Release();
            }
        }

        private async Task EnableLockedAsync(string message, string? notificationMessage, string action, List<string>? affectedUserIds,
            string source, int durationMinutes, DateTime? fixedEndsAtUtc)
        {
            message ??= string.Empty;
            notificationMessage ??= string.Empty;
            action ??= "disable_accounts";

            var currentState = LoadState();
            var loadError = _stateLoadError;
            if (loadError != null)
                throw new InvalidOperationException($"Maintenance state could not be loaded ({loadError}); repair or remove maintenance-state.json before enabling maintenance.");
            if (!currentState.IsActive && HasPendingRestores(currentState))
            {
                await RestoreUsersAsync(currentState, failOpen: false).ConfigureAwait(false);
                LogCarriedRestores(currentState);
            }
            if (currentState.IsActive)
            {
                bool sameAction = currentState.Action == action;
                bool sameTargets = AffectedUserSetsEqual(currentState.RequestedAffectedUserIds, affectedUserIds);
                if (sameAction && sameTargets)
                {
                    // Nothing about who's affected changed - just update message/duration/source.
                    DateTime? newEndsAt;
                    if (fixedEndsAtUtc.HasValue)
                    {
                        newEndsAt = fixedEndsAtUtc;
                    }
                    else if (currentState.Source == "manual" && currentState.RequestedDurationMinutes == durationMinutes)
                    {
                        // Same duration as last time: keep the running clock. The config page
                        // re-sends Enable on every save, and an unrelated setting change must
                        // not silently extend the window.
                        newEndsAt = currentState.EndsAt;
                    }
                    else
                    {
                        newEndsAt = durationMinutes > 0 ? DateTime.UtcNow.AddMinutes(durationMinutes) : null;
                    }

                    bool changed = currentState.Message != message
                        || currentState.NotificationMessage != notificationMessage
                        || currentState.EndsAt != newEndsAt
                        || currentState.Source != source
                        || currentState.RequestedDurationMinutes != durationMinutes;
                    if (!changed) return;

                    currentState.Message = message;
                    currentState.NotificationMessage = notificationMessage;
                    currentState.EndsAt = newEndsAt;
                    currentState.Source = source;
                    currentState.RequestedDurationMinutes = durationMinutes;
                    SaveState(currentState);
                    _logger.Info("[Maintenance] Message/duration updated (already active).");
                    return;
                }

                // Action or affected-user selection changed while already active - a save-only
                // "update the message" shortcut here previously left this permanently stuck at
                // whatever was first applied, silently ignoring every checkbox change afterward.
                // Undo whatever this instance previously applied, then fall through to re-apply
                // fresh against the new action/target below.
                _logger.Info("[Maintenance] Action/targets changed while active - reconciling.");
                // Until restoration completes this is a pending transition, not
                // a fully applied active window. A retry of the old selection
                // must reapply it rather than take the same-target shortcut.
                currentState.IsActive = false;
                SaveState(currentState);
                await RestoreUsersAsync(currentState, failOpen: false).ConfigureAwait(false);
                LogCarriedRestores(currentState);
            }

            bool doAccounts = action == "disable_accounts" || action == "both";
            bool doRemote   = action == "disable_remote"   || action == "both";

            // Build the target user set: all non-admin users, filtered to the selection
            var allNonAdmin = _userManager.GetAllUsers()
                .Where(u => !u.HasPermission(PermissionKind.IsAdministrator))
                .ToList();

            IEnumerable<Jellyfin.Database.Implementations.Entities.User> targetUsers;
            if (affectedUserIds == null || affectedUserIds.Count == 0)
            {
                targetUsers = allNonAdmin;
            }
            else
            {
                var idSet = affectedUserIds
                    .Select(s => Guid.TryParse(s, out var g) ? g : Guid.Empty)
                    .Where(g => g != Guid.Empty)
                    .ToHashSet();
                targetUsers = allNonAdmin.Where(u => idSet.Contains(u.Id));
            }

            // The journal is the still-inactive state. Any restores carried over from an earlier window
            // stay on it, and each user disabled below is added and checkpointed before the next user is
            // touched, so a failure or crash part-way leaves an inactive state listing everyone to restore.
            var accountDisabled = currentState.AccountDisabledUserIds;
            var remoteDisabled  = currentState.RemoteDisabledUserIds;

            // Refuse policy mutations if the restoration journal is already
            // unwritable. Host policy commits and this file cannot share a
            // transaction, but an existing filesystem failure is detectable.
            SaveState(currentState);

            foreach (var user in targetUsers)
            {
                bool accountChanged = false;
                bool remoteChanged = false;
                try
                {
                    var dto = _userManager.GetUserDto(user, string.Empty);
                    if (dto.Policy == null) continue;

                    if (doAccounts && !dto.Policy.IsDisabled)
                    {
                        dto.Policy.IsDisabled = true;
                        accountChanged = true;
                    }

                    if (doRemote && dto.Policy.EnableRemoteAccess)
                    {
                        dto.Policy.EnableRemoteAccess = false;
                        remoteChanged = true;
                    }

                    if (accountChanged || remoteChanged)
                    {
                        await _userManager.UpdatePolicyAsync(user.Id, dto.Policy).ConfigureAwait(false);
                    }
                }
                catch (Exception ex)
                {
                    _logger.Error($"[Maintenance] Failed to update user '{user.Username}': {ex.Message}");
                    continue;
                }

                if (!accountChanged && !remoteChanged) continue;
                // Only restore changes the policy store actually accepted.
                // A failed update must not grant access on a later disable.
                var id = user.Id.ToString();
                if (accountChanged && !accountDisabled.Contains(id)) accountDisabled.Add(id);
                if (remoteChanged && !remoteDisabled.Contains(id)) remoteDisabled.Add(id);
                // A journal write failure stops here: nobody else is locked out without a record, and
                // the in-memory journal still lists this user so the next tick or disable restores them.
                SaveJournal(currentState);
                _logger.Info($"[Maintenance] Updated user '{user.Username}'" +
                    $"{(accountChanged ? " (account disabled)" : "")}" +
                    $"{(remoteChanged ? " (remote disabled)" : "")}");
            }

            var newState = new MaintenanceState
            {
                IsActive = true,
                Message  = message,
                NotificationMessage = notificationMessage,
                Action   = action,
                Source   = source,
                StartedAt = DateTime.UtcNow,
                EndsAt   = fixedEndsAtUtc ?? (durationMinutes > 0 ? DateTime.UtcNow.AddMinutes(durationMinutes) : null),
                RequestedDurationMinutes = durationMinutes,
                AccountDisabledUserIds = accountDisabled,
                RemoteDisabledUserIds  = remoteDisabled,
                RequestedAffectedUserIds = affectedUserIds
            };

            SaveState(newState);
            _logger.Info($"[Maintenance Mode] Enabled. Source={source}, Action={action}, " +
                $"AccountsDisabled={accountDisabled.Count}, RemoteDisabled={remoteDisabled.Count}" +
                (newState.EndsAt.HasValue ? $", EndsAt={newState.EndsAt.Value:u}" : string.Empty));
        }

        /// <param name="includeScheduled">
        /// False when the caller means "manual maintenance off" (the config page toggle while the
        /// schedule is on): a window the schedule started keeps running, otherwise saving any
        /// unrelated setting would end it. True ends a scheduled window too, and the schedule then
        /// skips the rest of that occurrence instead of reopening it on the next tick.
        /// </param>
        public Task DisableAsync(bool includeScheduled = true)
            => DisableCoreAsync(state =>
            {
                if (includeScheduled || state.Source != "schedule") return true;
                _logger.Info("[Maintenance] Active window was started by the schedule - leaving it running (turn the schedule off to end it early).");
                return false;
            }, null, true);

        /// <summary>
        /// Ends the active window only if the schedule started it. The schedule tick decides from a
        /// snapshot, so the source is re-checked under the gate: a manual enable that landed in
        /// between must not be switched off by the schedule.
        /// </summary>
        public Task DisableScheduledWindowAsync(string reason)
            => DisableCoreAsync(state => state.Source == "schedule", reason, false);

        /// <param name="shouldDisable">Evaluated under the gate against the current active state.</param>
        /// <param name="reason">Logged when the disable goes ahead; null for none.</param>
        /// <param name="explicitEnd">An admin ended it (API / config page): a scheduled occurrence ended
        /// this way is remembered so the schedule does not reopen it until the next day.</param>
        private async Task DisableCoreAsync(Func<MaintenanceState, bool> shouldDisable, string? reason, bool explicitEnd)
        {
            await _gate.WaitAsync().ConfigureAwait(false);
            try
            {
                var state = LoadState();
                if (!state.IsActive)
                {
                    if (HasPendingRestores(state))
                        await RestoreUsersAsync(state, failOpen: true).ConfigureAwait(false);
                    _logger.Info("[Maintenance] Already inactive - skipping disable.");
                    return;
                }
                if (!shouldDisable(state)) return;
                if (reason != null) _logger.Info($"[Maintenance] {reason} - disabling.");
                // Persist restoration intent before touching policies. Failed users
                // remain on this inactive state so the next tick/restart retries.
                // An unwritable state file must not keep users locked out: the
                // pending list is then kept in memory and restoration goes ahead.
                state.IsActive = false;
                state.SkippedScheduledWindowEnd = explicitEnd && state.Source == "schedule" ? state.EndsAt : null;
                Checkpoint(state, failOpen: true);

                // A timed manual window that ran out must also clear the admin toggle, or the config
                // page would still show it checked and the next save would re-enable it. Cleared before
                // the restore so public-config stops reporting maintenance as soon as the state flips.
                if (state.Source == "manual")
                {
                    ClearManualConfigFlag();
                }

                await RestoreUsersAsync(state, failOpen: true).ConfigureAwait(false);
                _logger.Info($"[Maintenance Mode] Disabled (was {state.Source}).");
            }
            finally
            {
                _gate.Release();
            }
        }

        private void ClearManualConfigFlag()
        {
            try
            {
                var plugin = JellyfinEnhanced.Instance;
                var cfg = plugin?.Configuration;
                if (plugin == null || cfg == null || !cfg.MaintenanceModeEnabled) return;
                cfg.MaintenanceModeEnabled = false;
                plugin.SaveConfiguration();
                _logger.Info("[Maintenance] Cleared the 'Enable Maintenance Mode' setting.");
            }
            catch (Exception ex)
            {
                _logger.Warning($"[Maintenance] Could not clear the enable setting: {ex.Message}");
            }
        }

        /// <summary>
        /// True when <paramref name="userId"/> falls inside the state's affected-user selection
        /// (null/empty selection = every non-admin user). Admin checks are the caller's job.
        /// </summary>
        public static bool IsUserAffected(MaintenanceState state, Guid userId)
        {
            var selection = state.RequestedAffectedUserIds;
            if (selection == null || selection.Count == 0) return true;
            foreach (var id in selection)
            {
                if (Guid.TryParse(id, out var g) && g == userId) return true;
            }
            return false;
        }

        /// <summary>
        /// Parses the stored MaintenanceModeAffectedUsers setting ("all" or a JSON array of user id
        /// strings) into the shape EnableAsync expects (null = all non-admin users).
        /// </summary>
        public static List<string>? ParseAffectedUsersSetting(string? value)
        {
            if (string.IsNullOrWhiteSpace(value) || value == "all") return null;
            try
            {
                var ids = JsonConvert.DeserializeObject<List<string>>(value);
                return ids == null || ids.Count == 0 ? null : ids;
            }
            catch
            {
                return null;
            }
        }

        // ── Message formatting (countdown tokens) ──────────────────────────────

        /// <summary>"1h 05m" / "12m"; minutes are rounded up so the last minute never reads "0m".</summary>
        public static string FormatCountdown(TimeSpan remaining)
        {
            var totalMinutes = Math.Max(0, (int)Math.Ceiling(remaining.TotalMinutes));
            var h = totalMinutes / 60;
            var m = totalMinutes % 60;
            return h > 0 ? $"{h}h {m:D2}m" : $"{m}m";
        }

        /// <summary>
        /// Replaces {countdown} (time remaining) and {ends_at} (server-local end time) in a message.
        /// With an end time but no {countdown} token the remaining time is appended, so the plain
        /// default messages still tell the user when maintenance ends. Mirrored client-side in
        /// plugin.js (formatMaintenanceText) for the banner.
        /// </summary>
        public static string FormatMessage(string? text, DateTime? endsAtUtc)
        {
            text ??= string.Empty;
            if (!endsAtUtc.HasValue)
            {
                return ReplaceToken(ReplaceToken(text, "{countdown}", string.Empty), "{ends_at}", string.Empty).Trim();
            }
            var countdown = FormatCountdown(endsAtUtc.Value - DateTime.UtcNow);
            var endsAtLocal = endsAtUtc.Value.ToLocalTime().ToString("HH:mm", CultureInfo.InvariantCulture);
            bool hasToken = text.Contains("{countdown}", StringComparison.OrdinalIgnoreCase);
            var result = ReplaceToken(ReplaceToken(text, "{countdown}", countdown), "{ends_at}", endsAtLocal).Trim();
            return hasToken ? result : $"{result} Time remaining: {countdown}.".Trim();
        }

        private static string ReplaceToken(string text, string token, string value)
            => text.Replace(token, value, StringComparison.OrdinalIgnoreCase);

        // ── Session messaging ─────────────────────────────────────────────────

        /// <summary>
        /// Sends the maintenance popup to every signed-in session. Shared by the admin Broadcast
        /// endpoint and the schedule's window-start announcement; tokens are resolved against the
        /// current state's end time.
        /// </summary>
        public async Task<(int Sent, int Skipped, List<string> Errors)> BroadcastAsync(string? header, string text, long timeoutMs, string controllingSessionId)
        {
            var state = LoadState();
            var command = new MessageCommand
            {
                Header = string.IsNullOrWhiteSpace(header) ? DefaultHeader : header,
                Text = FormatMessage(text, state.IsActive ? state.EndsAt : null),
                TimeoutMs = timeoutMs > 0 ? timeoutMs : 30000
            };

            var sent = 0; var skipped = 0; var errors = new List<string>();
            foreach (var session in _sessionManager.Sessions)
            {
                if (string.IsNullOrWhiteSpace(session.UserName) ||
                    string.Equals(session.UserName, "Unknown", StringComparison.OrdinalIgnoreCase))
                { skipped++; continue; }
                try
                {
                    await _sessionManager.SendMessageCommand(controllingSessionId, session.Id, command, CancellationToken.None).ConfigureAwait(false);
                    sent++;
                }
                catch (Exception ex)
                {
                    skipped++;
                    errors.Add($"{session.UserName}: {ex.Message}");
                }
            }
            return (sent, skipped, errors);
        }

        /// <summary>Sends the maintenance popup to one session, with tokens resolved. Used by the playback reminder.</summary>
        public Task SendToSessionAsync(string sessionId, string text, DateTime? endsAtUtc, long timeoutMs)
        {
            var command = new MessageCommand
            {
                Header = DefaultHeader,
                Text = FormatMessage(text, endsAtUtc),
                TimeoutMs = timeoutMs
            };
            return _sessionManager.SendMessageCommand(string.Empty, sessionId, command, CancellationToken.None);
        }

        /// <summary>
        /// Reverts whatever account/remote-access changes a given state recorded as applied.
        /// Used both by DisableAsync (turning maintenance mode off entirely) and by EnableAsync
        /// (reconciling a changed Action/target selection while still active) - callers own
        /// updating IsActive/persisting the resulting state themselves.
        /// </summary>
        /// <param name="failOpen">
        /// True on the disable/expiry path: a journal write failure is logged and restoration carries
        /// on with the pending list kept in memory. False on the enable path, where it aborts the
        /// transition before a new window can be applied.
        /// </param>
        private async Task RestoreUsersAsync(MaintenanceState state, bool failOpen)
        {
            var allIds = state.AccountDisabledUserIds
                .Union(state.RemoteDisabledUserIds)
                .Distinct()
                .ToList();
            var failed = 0;

            var accountSet = new HashSet<string>(state.AccountDisabledUserIds);
            var remoteSet  = new HashSet<string>(state.RemoteDisabledUserIds);

            foreach (var idStr in allIds)
            {
                if (!Guid.TryParse(idStr, out var userId))
                {
                    state.AccountDisabledUserIds.Remove(idStr);
                    state.RemoteDisabledUserIds.Remove(idStr);
                    Checkpoint(state, failOpen);
                    continue;
                }
                try
                {
                    // A deleted user or one without a policy has nothing left to restore;
                    // dropping the entry keeps it from staying pending forever.
                    var user = _userManager.GetUserById(userId);
                    if (user == null)
                    {
                        _logger.Warning($"[Maintenance] User {idStr} no longer exists - dropping it from the restore list.");
                    }
                    else
                    {
                        var dto = _userManager.GetUserDto(user, string.Empty);
                        if (dto.Policy == null)
                        {
                            _logger.Warning($"[Maintenance] User '{user.Username}' has no policy - dropping it from the restore list.");
                        }
                        else
                        {
                            if (accountSet.Contains(idStr)) dto.Policy.IsDisabled = false;
                            if (remoteSet.Contains(idStr))  dto.Policy.EnableRemoteAccess = true;

                            await _userManager.UpdatePolicyAsync(userId, dto.Policy).ConfigureAwait(false);
                            _logger.Info($"[Maintenance] Restored user '{user.Username}'");
                        }
                    }
                }
                catch (Exception ex)
                {
                    failed++;
                    var message = $"[Maintenance] Failed to restore user {idStr}: {ex.Message}";
                    if (_restoreFailureStreak == 0) _logger.Error(message);
                    else _logger.Debug(message);
                    continue;
                }
                // On the enable path persistence failures abort the transition rather
                // than being swallowed as policy failures.
                state.AccountDisabledUserIds.Remove(idStr);
                state.RemoteDisabledUserIds.Remove(idStr);
                Checkpoint(state, failOpen);
            }

            RecordRestoreOutcome(failed);
        }

        /// <summary>
        /// Updates the restore failure streak and the next automatic retry time after a restore pass.
        /// A clean pass resets both; a failing one doubles the wait (none for the first retry, then
        /// 30 s up to an hour) and, after the first failure of the streak, logs one Warning.
        /// </summary>
        /// <param name="failed">Users this pass could not restore.</param>
        private void RecordRestoreOutcome(int failed)
        {
            if (failed == 0)
            {
                _restoreFailureStreak = 0;
                Interlocked.Exchange(ref _restoreRetryNotBeforeTicks, 0);
                return;
            }

            _restoreFailureStreak++;
            var delay = TimeSpan.Zero;
            if (_restoreFailureStreak > 1)
            {
                delay = RetryDelay(_restoreFailureStreak - 2);
                _logger.Warning($"[Maintenance] {failed} user(s) still could not be restored (attempt {_restoreFailureStreak}); " +
                    $"retrying in {delay.TotalMinutes.ToString("0.#", CultureInfo.InvariantCulture)} min.");
            }

            Interlocked.Exchange(ref _restoreRetryNotBeforeTicks, (_timeProvider.GetUtcNow() + delay).UtcTicks);
        }

        /// <summary>The retry wait after <paramref name="doublings"/> doublings of 30 s, capped at an hour.</summary>
        private static TimeSpan RetryDelay(int doublings)
            => TimeSpan.FromTicks(Math.Min(RestoreRetryBaseDelay.Ticks << Math.Min(doublings, 20), RestoreRetryMaxDelay.Ticks));

        /// <summary>
        /// Rewrites the in-memory state after a fail-open checkpoint could not save it, so a stale
        /// journal on disk cannot re-disable or re-restore users after a restart. The first rewrite
        /// runs on the next tick, then the wait doubles from 30 s up to an hour. The original write
        /// failure was already logged at Error, so each failed rewrite logs one Warning.
        /// </summary>
        private async Task RetryDirtyJournalAsync()
        {
            if (_timeProvider.GetUtcNow().UtcTicks < Interlocked.Read(ref _journalRetryNotBeforeTicks)) return;
            await _gate.WaitAsync().ConfigureAwait(false);
            try
            {
                var cached = _cached;
                if (!_journalDirty || cached == null) return;
                try
                {
                    WriteState(cached);
                }
                catch (Exception ex)
                {
                    _journalFailureStreak++;
                    var delay = RetryDelay(_journalFailureStreak - 1);
                    Interlocked.Exchange(ref _journalRetryNotBeforeTicks, (_timeProvider.GetUtcNow() + delay).UtcTicks);
                    _logger.Warning($"[Maintenance] The maintenance state still could not be saved (attempt {_journalFailureStreak}): {ex.Message}; " +
                        $"retrying in {delay.TotalMinutes.ToString("0.#", CultureInfo.InvariantCulture)} min.");
                    return;
                }
                _logger.Info("[Maintenance] Saved the maintenance state that a failed write had left only in memory.");
            }
            finally
            {
                _gate.Release();
            }
        }

        /// <summary>
        /// Restores that still failed stay on the journal and are carried into the window being
        /// opened, so they are retried when it ends instead of blocking every future window.
        /// </summary>
        private void LogCarriedRestores(MaintenanceState state)
        {
            if (!HasPendingRestores(state)) return;
            _logger.Warning($"[Maintenance] {state.AccountDisabledUserIds.Union(state.RemoteDisabledUserIds).Count()} user(s) could not be restored; " +
                "they stay on the restore list and are retried when the new window ends.");
        }

        /// <summary>Order-independent comparison; null/empty both mean "all non-admin users".</summary>
        private static bool AffectedUserSetsEqual(List<string>? a, List<string>? b)
        {
            var setA = new HashSet<string>(a ?? new List<string>());
            var setB = new HashSet<string>(b ?? new List<string>());
            return setA.SetEquals(setB);
        }

        private MaintenanceState LoadState()
        {
            var cached = _cached;
            if (cached != null) return CopyState(cached);
            // Only a missing file means "no maintenance state". An unreadable or corrupt one reads as
            // inactive but is not cached, so the next read retries, and nothing may overwrite it.
            if (File.Exists(_stateFilePath))
            {
                string json;
                try
                {
                    json = File.ReadAllText(_stateFilePath);
                }
                catch (Exception ex)
                {
                    ReportLoadFailure($"could not read maintenance-state.json: {ex.Message}", backup: false);
                    return new MaintenanceState();
                }

                string? parseError = null;
                try
                {
                    cached = JsonConvert.DeserializeObject<MaintenanceState>(json);
                }
                catch (Exception ex)
                {
                    parseError = ex.Message;
                }

                if (cached == null)
                {
                    ReportLoadFailure($"maintenance-state.json is corrupt ({parseError ?? "empty or null"})", backup: true);
                    return new MaintenanceState();
                }
            }
            _stateLoadError = null;
            _reportedLoadFailure = null;
            cached ??= new MaintenanceState();
            cached.AccountDisabledUserIds = (cached.AccountDisabledUserIds ?? new()).Distinct().ToList();
            cached.RemoteDisabledUserIds = (cached.RemoteDisabledUserIds ?? new()).Distinct().ToList();
            _cached = cached;
            return CopyState(cached);
        }

        /// <summary>
        /// Records why the state file could not be loaded (enable refuses while it is set). A given
        /// failure on a given file version is logged, and a corrupt file backed up, only once.
        /// </summary>
        private void ReportLoadFailure(string message, bool backup)
        {
            _stateLoadError = message;
            var key = message;
            try
            {
                var info = new FileInfo(_stateFilePath);
                key += "|" + info.Length.ToString(CultureInfo.InvariantCulture) + "|" + info.LastWriteTimeUtc.Ticks.ToString(CultureInfo.InvariantCulture);
            }
            catch (Exception)
            {
                // The message alone still deduplicates.
            }

            if (key == _reportedLoadFailure) return;
            _reportedLoadFailure = key;
            _logger.Error($"[Maintenance] Failed to load state: {message}. Maintenance cannot be enabled and the file will not be " +
                "overwritten until it is repaired or removed; users it lists as disabled by maintenance are not restored automatically.");
            if (backup) BackupCorruptStateFile();
        }

        /// <summary>Copies a corrupt state file aside for recovery, like the reviews store does. Never throws.</summary>
        private void BackupCorruptStateFile()
        {
            try
            {
                var backupPath = _stateFilePath + ".corrupt-" + DateTime.UtcNow.ToString("yyyyMMddHHmmss", CultureInfo.InvariantCulture);
                if (!File.Exists(backupPath))
                    File.Copy(_stateFilePath, backupPath);
                _logger.Warning($"[Maintenance] Corrupt maintenance-state.json backed up to {backupPath}");
            }
            catch (Exception ex)
            {
                _logger.Error($"[Maintenance] Failed to back up corrupt maintenance-state.json: {ex.Message}");
            }
        }

        // Callers stage mutations privately; a failed disk checkpoint must not
        // silently change the authoritative cached state.
        private static MaintenanceState CopyState(MaintenanceState state) => new()
        {
            IsActive = state.IsActive, Message = state.Message, NotificationMessage = state.NotificationMessage,
            Action = state.Action, Source = state.Source, StartedAt = state.StartedAt, EndsAt = state.EndsAt,
            RequestedDurationMinutes = state.RequestedDurationMinutes,
            AccountDisabledUserIds = new(state.AccountDisabledUserIds),
            RemoteDisabledUserIds = new(state.RemoteDisabledUserIds),
            RequestedAffectedUserIds = state.RequestedAffectedUserIds == null ? null : new(state.RequestedAffectedUserIds),
            SkippedScheduledWindowEnd = state.SkippedScheduledWindowEnd
        };

        /// <summary>
        /// Saves a restore-path checkpoint. With <paramref name="failOpen"/> a write failure is already
        /// logged by <see cref="SaveState"/>, and the in-memory state takes the change anyway so
        /// restoration can continue and be retried.
        /// </summary>
        private void Checkpoint(MaintenanceState state, bool failOpen)
        {
            try
            {
                SaveState(state);
            }
            catch (Exception) when (failOpen)
            {
                _cached = CopyState(state);
                _journalDirty = true;
            }
        }

        /// <summary>
        /// Saves the enable-path journal after a user was disabled. On failure the in-memory state
        /// still records that user for restoration before the error propagates.
        /// </summary>
        private void SaveJournal(MaintenanceState state)
        {
            try
            {
                SaveState(state);
            }
            catch (Exception)
            {
                _cached = CopyState(state);
                _journalDirty = true;
                throw;
            }
        }

        private void SaveState(MaintenanceState state)
        {
            try
            {
                WriteState(state);
            }
            catch (Exception ex)
            {
                _logger.Error($"[Maintenance] Failed to save state: {ex.Message}");
                throw;
            }
        }

        /// <summary>
        /// Atomically replaces the state file and the cache with <paramref name="state"/>, and ends any
        /// dirty-journal retry. Throws without logging; <see cref="SaveState"/> logs for its callers.
        /// </summary>
        private void WriteState(MaintenanceState state)
        {
            var loadError = _stateLoadError;
            if (loadError != null)
            {
                // Writing now would erase the only record of whom to restore.
                throw new InvalidOperationException($"Maintenance state could not be loaded ({loadError}); refusing to overwrite it.");
            }

            var temporaryPath = _stateFilePath + ".tmp." + Guid.NewGuid().ToString("N");
            try
            {
                File.WriteAllText(temporaryPath, JsonConvert.SerializeObject(state, Formatting.Indented));
                File.Move(temporaryPath, _stateFilePath, overwrite: true);
                _cached = CopyState(state);
                _journalDirty = false;
                _journalFailureStreak = 0;
                Interlocked.Exchange(ref _journalRetryNotBeforeTicks, 0);
            }
            finally
            {
                if (File.Exists(temporaryPath)) File.Delete(temporaryPath);
            }
        }
    }
}
