using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
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
    /// it read, JE's whole configuration through Jellyfin's plugin-configuration route, a maintenance command replaying its
    /// snapshot), refuses the write, and sends that page's session Jellyfin's own message (a dialog the page shows whatever JE
    /// build it runs), so the change it didn't save is never lost silently. Later builds also learn it themselves (see
    /// <c>js/core/api-client.js</c>). Only signed-in sessions are told (an API key has no page).
    /// Delivery: every notice is held for its device first (at most one per device, the newest; at most 500 devices, for
    /// half an hour) and leaves only when Jellyfin's send of it COMPLETED successfully (the host's handoff to the page's
    /// connected controller: that, not a person reading it, is what the host can confirm). A send that throws, faults or is
    /// cancelled keeps it held: the next deliverable moment (a controller connecting, the session starting, another refused
    /// write) tries again, one send at a time per device, never in a loop. A send is made only to a session of the same
    /// device and person with a connected controller (Jellyfin's web socket), checked when it is made. Only a successful
    /// delivery counts towards the once-in-a-few-minutes limit per device; an older send completing never removes a newer
    /// notice held after it.
    /// </summary>
    public static class ClientReloadNotice
    {
        /// <summary>The dialog's title.</summary>
        public const string Header = "Jellyfin Enhanced was updated";

        /// <summary>A refused save of a person's own settings.</summary>
        public const string SettingsText = "This page runs an earlier version of Jellyfin Enhanced, so your last change was not saved. Reload the page, then make the change again.";

        /// <summary>A refused save of JE's configuration.</summary>
        public const string ConfigurationText = "This Jellyfin Enhanced settings page is from an earlier version, so it was not saved. Reload the page, then make your changes again.";

        /// <summary>A refused maintenance command of an earlier configuration page (its settings were saved; the server applies them).</summary>
        public const string EffectsText = "This Jellyfin Enhanced settings page is from an earlier version. Your settings were saved and are being applied by the server; reload the page to see how maintenance mode stands.";

        private static readonly TimeSpan Interval = TimeSpan.FromMinutes(2);
        private static readonly TimeSpan PendingFor = TimeSpan.FromMinutes(30);
        private const int MaxPending = 500;
        // The last successful delivery per device (the limit counts only those).
        private static readonly ConcurrentDictionary<string, DateTime> _told = new(StringComparer.Ordinal);

        /// <summary>A notice held for a device until a send of it completes: its person, text, when, and its own id.</summary>
        private sealed record Held(Guid User, string Text, DateTime At, long Id);

        // The notice held per device (the newest), and the id of the one whose send is out per device.
        private static readonly ConcurrentDictionary<string, Held> _pending = new(StringComparer.Ordinal);
        private static readonly ConcurrentDictionary<string, long> _inFlight = new(StringComparer.Ordinal);
        private static long _ids;
        private static readonly System.Runtime.CompilerServices.ConditionalWeakTable<ISessionManager, object> _watched = new();

        /// <summary>Tests: how long after a controller connects a held notice is sent (its connection settles first).</summary>
        internal static TimeSpan DeliveryDelay { get; set; } = TimeSpan.FromSeconds(2);

        /// <summary>The caller is a signed-in session (an app or a page with a device), not an API key.</summary>
        public static bool FromSession(ClaimsPrincipal? user)
        {
            if (user == null || string.IsNullOrEmpty(user.FindFirst("Jellyfin-DeviceId")?.Value)) return false;
            return !(bool.TryParse(user.FindFirst("Jellyfin-IsApiKey")?.Value, out var apiKey) && apiKey);
        }

        /// <summary>
        /// Holds the reload dialog for the caller's device (not when one was delivered to it in the last few minutes) and
        /// starts its send now when the device's session has a connected controller.
        /// </summary>
        /// <returns>Whether a send was started now. Its completion is not awaited: until it completes successfully the notice
        /// stays held (a failed send is tried again at the next deliverable moment).</returns>
        public static bool Send(ISessionManager? sessions, ClaimsPrincipal? user, string text, Logger? logger)
        {
            if (sessions == null || !FromSession(user)) return false;
            var device = user!.FindFirst("Jellyfin-DeviceId")!.Value;
            Guid.TryParse(user.FindFirst("Jellyfin-UserId")?.Value, out var userId);
            var now = DateTime.UtcNow;
            if (_told.TryGetValue(device, out var last) && now - last < Interval) return false;

            foreach (var (key, value) in _pending)
            {
                if (now - value.At > PendingFor) _pending.TryRemove(key, out _);
            }
            if (_pending.Count >= MaxPending && !_pending.ContainsKey(device)) return false;
            _pending[device] = new Held(userId, text, now, Interlocked.Increment(ref _ids));
            Watch(sessions, logger);

            try
            {
                return Connected(sessions, device, userId) is { } session && TryDeliver(sessions, session, logger);
            }
            catch (Exception ex)
            {
                logger?.Warning($"Reload notice: could not list sessions: {ex.Message}");
                return false;
            }
        }

        /// <summary>The device's session for the person, only while it has a connected controller (else null).</summary>
        private static SessionInfo? Connected(ISessionManager sessions, string device, Guid userId)
            => sessions.Sessions.FirstOrDefault(s => string.Equals(s.DeviceId, device, StringComparison.Ordinal)
                && (userId == Guid.Empty || s.UserId == userId) && HasConnectedController(s));

        private static bool HasConnectedController(SessionInfo session)
        {
            try
            {
                return session.SessionControllers.Any(controller => controller.IsSessionActive);
            }
            catch (Exception)
            {
                return false;
            }
        }

        // Watches the session manager once for a session starting or a controller connecting (a deliverable moment).
        private static void Watch(ISessionManager sessions, Logger? logger)
        {
            lock (_watched)
            {
                if (_watched.TryGetValue(sessions, out _)) return;
                _watched.Add(sessions, new object());
                sessions.SessionStarted += (_, e) => Changed(sessions, e?.SessionInfo, logger);
                sessions.SessionControllerConnected += (_, e) => Changed(sessions, e?.SessionInfo, logger);
            }
        }

        // A session started or a controller connected: the notice held for its device (and person) is sent once its
        // connection settled, while it is still held, still that person's and still connected.
        private static void Changed(ISessionManager sessions, SessionInfo? session, Logger? logger)
        {
            if (session?.DeviceId == null || !_pending.TryGetValue(session.DeviceId, out var held)) return;
            if (DateTime.UtcNow - held.At > PendingFor)
            {
                _pending.TryRemove(new KeyValuePair<string, Held>(session.DeviceId, held));
                return;
            }
            if ((held.User != Guid.Empty && session.UserId != held.User) || !HasConnectedController(session)) return;
            _ = Task.Delay(DeliveryDelay).ContinueWith(_ => TryDeliver(sessions, session, logger), TaskScheduler.Default);
        }

        // Starts the send of the notice held for the session's device, unless one is out already or it isn't deliverable to
        // this session (another person, no connected controller, delivered within the limit). Only a send that completes
        // successfully removes that notice (never a newer one held since) and counts towards the limit.
        private static bool TryDeliver(ISessionManager sessions, SessionInfo session, Logger? logger)
        {
            var device = session.DeviceId ?? string.Empty;
            if (!_pending.TryGetValue(device, out var held)) return false;
            if ((held.User != Guid.Empty && session.UserId != held.User) || !HasConnectedController(session)) return false;
            if (_told.TryGetValue(device, out var last) && DateTime.UtcNow - last < Interval)
            {
                // Told within the limit (another notice's send completed): nothing more is sent now.
                _pending.TryRemove(new KeyValuePair<string, Held>(device, held));
                return false;
            }
            if (!_inFlight.TryAdd(device, held.Id)) return false;
            var command = new MessageCommand { Header = Header, Text = held.Text };
            Task sent;
            try
            {
                sent = sessions.SendMessageCommand(string.Empty, session.Id, command, CancellationToken.None) ?? Task.CompletedTask;
            }
            catch (Exception ex)
            {
                _inFlight.TryRemove(new KeyValuePair<string, long>(device, held.Id));
                logger?.Warning($"Reload notice: could not message the session (it stays held for the next connection): {ex.Message}");
                return false;
            }
            sent.ContinueWith(t =>
            {
                if (t.IsCompletedSuccessfully)
                {
                    _told[device] = DateTime.UtcNow;
                    _pending.TryRemove(new KeyValuePair<string, Held>(device, held));
                    logger?.Info($"Told a page of an earlier Jellyfin Enhanced build (device {device}) to reload: its write was refused.");
                }
                else
                {
                    logger?.Warning($"Reload notice: could not message the session (it stays held for the next connection): {(t.IsCanceled ? "cancelled" : t.Exception?.GetBaseException().Message)}");
                }
                _inFlight.TryRemove(new KeyValuePair<string, long>(device, held.Id));
            }, CancellationToken.None, TaskContinuationOptions.ExecuteSynchronously, TaskScheduler.Default);
            return true;
        }
    }
}
