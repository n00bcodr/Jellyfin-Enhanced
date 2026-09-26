using System;
using System.Collections.Generic;
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
    }

    public class MaintenanceModeService
    {
        public const string DefaultHeader = "Server Maintenance";
        public const string DefaultNotificationText = "Server maintenance is starting. Please finish up and try again later.";

        private readonly IUserManager _userManager;
        private readonly ISessionManager _sessionManager;
        private readonly Logger _logger;
        private readonly string _stateFilePath;
        private readonly object _lock = new();
        // In-memory copy of the state file. public-config (every page load, anonymous) and the
        // playback reminder now read the state, so it must not cost a file read per request.
        private MaintenanceState? _cached;

        public MaintenanceModeService(IUserManager userManager, ISessionManager sessionManager, IApplicationPaths appPaths, Logger logger)
        {
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
            if (state.IsActive && state.EndsAt.HasValue && DateTime.UtcNow >= state.EndsAt.Value)
            {
                _ = Task.Run(() => DisableAsync());
                return new MaintenanceState { IsActive = false };
            }
            return state;
        }

        /// <summary>
        /// Same expiry check as <see cref="GetStatus"/>, but awaits the disable so the caller
        /// (the schedule tick) sees the settled state instead of racing the background restore.
        /// </summary>
        public async Task<MaintenanceState> ExpireIfDueAsync()
        {
            var state = LoadState();
            if (state.IsActive && state.EndsAt.HasValue && DateTime.UtcNow >= state.EndsAt.Value)
            {
                _logger.Info("[Maintenance] Timed window reached its end - disabling.");
                await DisableAsync().ConfigureAwait(false);
                return LoadState();
            }
            return state;
        }

        /// <param name="action">"none" | "disable_accounts" | "disable_remote" | "both"</param>
        /// <param name="affectedUserIds">Specific user IDs to affect; null or empty = all non-admin users.</param>
        /// <param name="notificationMessage">Popup text kept on the state for the playback reminder.</param>
        public Task EnableAsync(string message, int durationMinutes, string action, List<string>? affectedUserIds, string? notificationMessage = null)
            => EnableCoreAsync(message, notificationMessage, action, affectedUserIds, "manual", durationMinutes, null);

        /// <summary>
        /// Enable (or keep enabled) on behalf of the daily schedule; the window end is absolute rather
        /// than a duration from now, so a tick that runs mid-window still ends at the configured time.
        /// Safe to call every tick: when nothing changed it is a no-op.
        /// </summary>
        public Task EnableScheduledAsync(string message, string? notificationMessage, string action, List<string>? affectedUserIds, DateTime windowEndUtc)
            => EnableCoreAsync(message, notificationMessage, action, affectedUserIds, "schedule", 0, windowEndUtc);

        private async Task EnableCoreAsync(string message, string? notificationMessage, string action, List<string>? affectedUserIds,
            string source, int durationMinutes, DateTime? fixedEndsAtUtc)
        {
            message ??= string.Empty;
            notificationMessage ??= string.Empty;
            action ??= "disable_accounts";

            var currentState = LoadState();
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
                await RestoreUsersAsync(currentState).ConfigureAwait(false);
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

            var accountDisabled = new List<string>();
            var remoteDisabled  = new List<string>();

            foreach (var user in targetUsers)
            {
                try
                {
                    var dto = _userManager.GetUserDto(user, string.Empty);
                    if (dto.Policy == null) continue;

                    bool changed = false;

                    if (doAccounts && !dto.Policy.IsDisabled)
                    {
                        dto.Policy.IsDisabled = true;
                        accountDisabled.Add(user.Id.ToString());
                        changed = true;
                    }

                    if (doRemote && dto.Policy.EnableRemoteAccess)
                    {
                        dto.Policy.EnableRemoteAccess = false;
                        remoteDisabled.Add(user.Id.ToString());
                        changed = true;
                    }

                    if (changed)
                    {
                        await _userManager.UpdatePolicyAsync(user.Id, dto.Policy).ConfigureAwait(false);
                        _logger.Info($"[Maintenance] Updated user '{user.Username}'" +
                            $"{(doAccounts && accountDisabled.Contains(user.Id.ToString()) ? " (account disabled)" : "")}" +
                            $"{(doRemote  && remoteDisabled.Contains(user.Id.ToString())  ? " (remote disabled)"  : "")}");
                    }
                }
                catch (Exception ex)
                {
                    _logger.Error($"[Maintenance] Failed to update user '{user.Username}': {ex.Message}");
                }
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
        /// False when the caller means "manual maintenance off" (the config page toggle): a window
        /// the schedule started keeps running, otherwise saving any unrelated setting would end it.
        /// Turning the schedule off, or the window reaching its end, still disables it.
        /// </param>
        public async Task DisableAsync(bool includeScheduled = true)
        {
            MaintenanceState state;
            lock (_lock)
            {
                state = LoadState();
                if (!state.IsActive)
                {
                    _logger.Info("[Maintenance] Already inactive - skipping disable.");
                    return;
                }
                if (!includeScheduled && state.Source == "schedule")
                {
                    _logger.Info("[Maintenance] Active window was started by the schedule - leaving it running (turn the schedule off to end it early).");
                    return;
                }
                // Mark inactive immediately so concurrent calls short-circuit
                SaveState(new MaintenanceState { IsActive = false });
            }

            await RestoreUsersAsync(state).ConfigureAwait(false);
            _logger.Info($"[Maintenance Mode] Disabled (was {state.Source}).");

            // A timed manual window that ran out must also clear the admin toggle, or the config page
            // would still show it checked and the next save would re-enable it.
            if (state.Source == "manual")
            {
                ClearManualConfigFlag();
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
            var endsAtLocal = endsAtUtc.Value.ToLocalTime().ToString("HH:mm");
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
        private async Task RestoreUsersAsync(MaintenanceState state)
        {
            var allIds = state.AccountDisabledUserIds
                .Union(state.RemoteDisabledUserIds)
                .Distinct()
                .ToList();

            var accountSet = new HashSet<string>(state.AccountDisabledUserIds);
            var remoteSet  = new HashSet<string>(state.RemoteDisabledUserIds);

            foreach (var idStr in allIds)
            {
                if (!Guid.TryParse(idStr, out var userId)) continue;
                try
                {
                    var user = _userManager.GetUserById(userId);
                    if (user == null) continue;

                    var dto = _userManager.GetUserDto(user, string.Empty);
                    if (dto.Policy == null) continue;

                    if (accountSet.Contains(idStr)) dto.Policy.IsDisabled = false;
                    if (remoteSet.Contains(idStr))  dto.Policy.EnableRemoteAccess = true;

                    await _userManager.UpdatePolicyAsync(userId, dto.Policy).ConfigureAwait(false);
                    _logger.Info($"[Maintenance] Restored user '{user.Username}'");
                }
                catch (Exception ex)
                {
                    _logger.Error($"[Maintenance] Failed to restore user {idStr}: {ex.Message}");
                }
            }
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
            if (cached != null) return cached;
            try
            {
                if (File.Exists(_stateFilePath))
                {
                    var json = File.ReadAllText(_stateFilePath);
                    cached = JsonConvert.DeserializeObject<MaintenanceState>(json);
                }
            }
            catch (Exception ex)
            {
                _logger.Error($"[Maintenance] Failed to load state: {ex.Message}");
            }
            cached ??= new MaintenanceState();
            _cached = cached;
            return cached;
        }

        private void SaveState(MaintenanceState state)
        {
            _cached = state;
            try
            {
                File.WriteAllText(_stateFilePath, JsonConvert.SerializeObject(state, Formatting.Indented));
            }
            catch (Exception ex)
            {
                _logger.Error($"[Maintenance] Failed to save state: {ex.Message}");
            }
        }
    }
}
