using System;
using System.Collections.Concurrent;
using System.Linq;
using System.Security.Claims;
using System.Threading;
using System.Threading.Tasks;
using MediaBrowser.Controller.Session;
using MediaBrowser.Model.Session;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services
{
    /// <summary>
    /// Tells a page that runs an earlier JE build to reload. A page loaded before JE was updated keeps its scripts until it is
    /// reloaded; the server recognizes it by a write only such a page makes (a whole per-user document without the revision
    /// it read, JE's whole configuration through Jellyfin's plugin-configuration route), refuses the write, and sends that
    /// page's session Jellyfin's own message (a dialog the page shows whatever JE build it runs), so the change it didn't
    /// save is never lost silently. Later builds also learn it themselves (the build named in every JE answer, see
    /// <c>js/core/api-client.js</c>). Only signed-in sessions are told (an API key has no page); once a few minutes per device.
    /// A page whose session isn't connected right now (Jellyfin 10.11's web client reconnects only when the tab is shown
    /// again after the server restarted) is told as soon as its session starts again (within half an hour).
    /// </summary>
    public static class ClientReloadNotice
    {
        /// <summary>The dialog's title.</summary>
        public const string Header = "Jellyfin Enhanced was updated";

        /// <summary>A refused save of a person's own settings.</summary>
        public const string SettingsText = "This page runs an earlier version of Jellyfin Enhanced, so your last change was not saved. Reload the page, then make the change again.";

        /// <summary>A refused save of JE's configuration.</summary>
        public const string ConfigurationText = "This Jellyfin Enhanced settings page is from an earlier version, so it was not saved. Reload the page, then make your changes again.";

        private static readonly TimeSpan Interval = TimeSpan.FromMinutes(2);
        private static readonly TimeSpan PendingFor = TimeSpan.FromMinutes(30);
        private const int MaxPending = 500;
        private static readonly ConcurrentDictionary<string, DateTime> _told = new(StringComparer.Ordinal);
        // Devices refused while their session wasn't there: (person, text, when).
        private static readonly ConcurrentDictionary<string, (Guid User, string Text, DateTime At)> _pending = new(StringComparer.Ordinal);
        private static readonly System.Runtime.CompilerServices.ConditionalWeakTable<ISessionManager, object> _watched = new();

        /// <summary>Tests: how long after a session starts its parked notice is sent (its connection settles first).</summary>
        internal static TimeSpan DeliveryDelay { get; set; } = TimeSpan.FromSeconds(2);

        /// <summary>The caller is a signed-in session (an app or a page with a device), not an API key.</summary>
        public static bool FromSession(ClaimsPrincipal? user)
        {
            if (user == null || string.IsNullOrEmpty(user.FindFirst("Jellyfin-DeviceId")?.Value)) return false;
            return !(bool.TryParse(user.FindFirst("Jellyfin-IsApiKey")?.Value, out var apiKey) && apiKey);
        }

        /// <summary>
        /// Sends the caller's session the reload dialog (not more than once in a few minutes per device).
        /// </summary>
        /// <returns>Whether a message was sent.</returns>
        public static bool Send(ISessionManager? sessions, ClaimsPrincipal? user, string text, Logger? logger)
        {
            if (sessions == null || !FromSession(user)) return false;
            var device = user!.FindFirst("Jellyfin-DeviceId")!.Value;
            Guid.TryParse(user.FindFirst("Jellyfin-UserId")?.Value, out var userId);
            SessionInfo? session;
            try
            {
                session = sessions.Sessions.FirstOrDefault(s => string.Equals(s.DeviceId, device, StringComparison.Ordinal) && (userId == Guid.Empty || s.UserId == userId));
            }
            catch (Exception ex)
            {
                logger?.Warning($"Reload notice: could not list sessions: {ex.Message}");
                return false;
            }

            if (session == null)
            {
                Park(sessions, device, userId, text, logger);
                return false;
            }

            return Deliver(sessions, session, text, logger);
        }

        // Keeps the notice for the device's next session (bounded), watching the session manager for it.
        private static void Park(ISessionManager sessions, string device, Guid userId, string text, Logger? logger)
        {
            var now = DateTime.UtcNow;
            foreach (var (key, value) in _pending)
            {
                if (now - value.At > PendingFor) _pending.TryRemove(key, out _);
            }

            if (_pending.Count >= MaxPending && !_pending.ContainsKey(device)) return;
            _pending[device] = (userId, text, now);
            lock (_watched)
            {
                if (_watched.TryGetValue(sessions, out _)) return;
                _watched.Add(sessions, new object());
                sessions.SessionStarted += (_, e) => Started(sessions, e?.SessionInfo, logger);
            }
        }

        // A session started: a notice parked for its device (and person) is sent once it is connected.
        private static void Started(ISessionManager sessions, SessionInfo? session, Logger? logger)
        {
            if (session?.DeviceId == null || !_pending.TryGetValue(session.DeviceId, out var parked)) return;
            if (DateTime.UtcNow - parked.At > PendingFor || (parked.User != Guid.Empty && session.UserId != parked.User)) return;
            if (!_pending.TryRemove(session.DeviceId, out _)) return;
            _ = Task.Delay(DeliveryDelay).ContinueWith(_ => Deliver(sessions, session, parked.Text, logger), TaskScheduler.Default);
        }

        private static bool Deliver(ISessionManager sessions, SessionInfo session, string text, Logger? logger)
        {
            var device = session.DeviceId ?? string.Empty;
            var now = DateTime.UtcNow;
            if (_told.AddOrUpdate(device, now, (_, last) => now - last >= Interval ? now : last) != now) return false;
            var command = new MessageCommand { Header = Header, Text = text };
            Task sent;
            try
            {
                sent = sessions.SendMessageCommand(string.Empty, session.Id, command, CancellationToken.None);
            }
            catch (Exception ex)
            {
                logger?.Warning($"Reload notice: could not message the session: {ex.Message}");
                return false;
            }

            sent.ContinueWith(t => logger?.Warning($"Reload notice: could not message the session: {t.Exception?.GetBaseException().Message}"), CancellationToken.None, TaskContinuationOptions.OnlyOnFaulted, TaskScheduler.Default);
            logger?.Info($"Told a page of an earlier Jellyfin Enhanced build (device {device}) to reload: its write was refused.");
            return true;
        }
    }
}
