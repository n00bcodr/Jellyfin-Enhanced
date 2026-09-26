using System;
using System.Collections.Concurrent;
using System.Threading.Tasks;
using Jellyfin.Data;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Extensions;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using MediaBrowser.Controller.Events;
using MediaBrowser.Controller.Library;

namespace Jellyfin.Plugin.JellyfinEnhanced.EventHandlers
{
    /// <summary>
    /// Maintenance Mode reminder: while maintenance is active and MaintenanceModeRemindOnPlayback is
    /// on, re-sends the active-session notification (with the time remaining) to an affected
    /// non-admin user each time they start playback, on any client type. Meant for the "warn but
    /// don't lock out" setups (action = none / remote only); a user whose account is disabled never
    /// reaches playback in the first place. Throttled per session so an episode autoplay chain or a
    /// client that re-reports playback does not spam popups.
    /// </summary>
    public sealed class MaintenancePlaybackReminderConsumer : IEventConsumer<PlaybackStartEventArgs>
    {
        private static readonly TimeSpan Cooldown = TimeSpan.FromMinutes(5);
        private const long PopupTimeoutMs = 15000;

        // Static: the consumer is scoped (one instance per event), the throttle must outlive it.
        private static readonly ConcurrentDictionary<string, DateTime> _lastSentBySession = new(StringComparer.Ordinal);

        private readonly MaintenanceModeService _maintenance;
        private readonly IUserManager _userManager;
        private readonly Logger _logger;

        public MaintenancePlaybackReminderConsumer(MaintenanceModeService maintenance, IUserManager userManager, Logger logger)
        {
            _maintenance = maintenance;
            _userManager = userManager;
            _logger = logger;
        }

        public async Task OnEvent(PlaybackStartEventArgs eventArgs)
        {
            try
            {
                if (JellyfinEnhanced.Instance?.Configuration?.MaintenanceModeRemindOnPlayback != true) return;

                var session = eventArgs?.Session;
                if (session == null || string.IsNullOrEmpty(session.Id) || session.UserId == Guid.Empty) return;

                var state = _maintenance.GetStatus();
                if (!state.IsActive) return;

                var user = _userManager.GetUserById(session.UserId);
                if (user == null || user.HasPermission(PermissionKind.IsAdministrator)) return;
                if (!MaintenanceModeService.IsUserAffected(state, session.UserId)) return;

                var now = DateTime.UtcNow;
                if (_lastSentBySession.TryGetValue(session.Id, out var last) && now - last < Cooldown) return;
                _lastSentBySession[session.Id] = now;
                foreach (var kvp in _lastSentBySession)
                {
                    if (now - kvp.Value > Cooldown) _lastSentBySession.TryRemove(kvp.Key, out _);
                }

                var text = !string.IsNullOrWhiteSpace(state.NotificationMessage) ? state.NotificationMessage
                    : !string.IsNullOrWhiteSpace(state.Message) ? state.Message
                    : MaintenanceModeService.DefaultNotificationText;

                await _maintenance.SendToSessionAsync(session.Id, text, state.EndsAt, PopupTimeoutMs).ConfigureAwait(false);
                _logger.Info($"[Maintenance] Playback reminder sent to '{session.UserName}' ({session.Client}).");
            }
            catch (Exception ex)
            {
                _logger.Warning($"[Maintenance] Playback reminder failed: {ex.Message}");
            }
        }
    }
}
