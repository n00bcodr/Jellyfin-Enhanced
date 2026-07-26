using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Jellyfin.Data;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Extensions;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Controller.Library;
using Newtonsoft.Json;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services
{
    public class MaintenanceState
    {
        public bool IsActive { get; set; }
        public string Message { get; set; } = string.Empty;
        /// <summary>"none" | "disable_accounts" | "disable_remote" | "both"</summary>
        public string Action { get; set; } = "disable_accounts";
        public DateTime StartedAt { get; set; }
        public DateTime? EndsAt { get; set; }
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
        private readonly IUserManager _userManager;
        private readonly Logger _logger;
        private readonly string _stateFilePath;
        private readonly object _lock = new();

        public MaintenanceModeService(IUserManager userManager, IApplicationPaths appPaths, Logger logger)
        {
            _userManager = userManager;
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

        /// <param name="action">"none" | "disable_accounts" | "disable_remote" | "both"</param>
        /// <param name="affectedUserIds">Specific user IDs to affect; null or empty = all non-admin users.</param>
        public async Task EnableAsync(string message, int durationMinutes, string action, List<string>? affectedUserIds)
        {
            var currentState = LoadState();
            if (currentState.IsActive)
            {
                bool sameAction = currentState.Action == action;
                bool sameTargets = AffectedUserSetsEqual(currentState.RequestedAffectedUserIds, affectedUserIds);
                if (sameAction && sameTargets)
                {
                    // Nothing about who's affected changed - just update message/duration.
                    currentState.Message = message ?? string.Empty;
                    currentState.EndsAt = durationMinutes > 0 ? DateTime.UtcNow.AddMinutes(durationMinutes) : null;
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
                Message  = message ?? string.Empty,
                Action   = action ?? "disable_accounts",
                StartedAt = DateTime.UtcNow,
                EndsAt   = durationMinutes > 0 ? DateTime.UtcNow.AddMinutes(durationMinutes) : null,
                AccountDisabledUserIds = accountDisabled,
                RemoteDisabledUserIds  = remoteDisabled,
                RequestedAffectedUserIds = affectedUserIds
            };

            SaveState(newState);
            _logger.Info($"[Maintenance Mode] Enabled. Action={action}, " +
                $"AccountsDisabled={accountDisabled.Count}, RemoteDisabled={remoteDisabled.Count}");
        }

        public async Task DisableAsync()
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
                // Mark inactive immediately so concurrent calls short-circuit
                SaveState(new MaintenanceState { IsActive = false });
            }

            await RestoreUsersAsync(state).ConfigureAwait(false);
            _logger.Info("[Maintenance Mode] Disabled.");
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
            try
            {
                if (!File.Exists(_stateFilePath)) return new MaintenanceState();
                var json = File.ReadAllText(_stateFilePath);
                return JsonConvert.DeserializeObject<MaintenanceState>(json) ?? new MaintenanceState();
            }
            catch (Exception ex)
            {
                _logger.Error($"[Maintenance] Failed to load state: {ex.Message}");
                return new MaintenanceState();
            }
        }

        private void SaveState(MaintenanceState state)
        {
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
