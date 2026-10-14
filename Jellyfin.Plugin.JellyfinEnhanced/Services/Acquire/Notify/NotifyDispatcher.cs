using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Microsoft.Extensions.Hosting;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Notify
{
    /// <summary>
    /// Delivers notifications to phones (ntfy) and e-mail. Deliveries are rows in the database
    /// created with their notification, so nothing is lost across a restart; each is tried until it
    /// is sent, with backoff (30 s, 2 min, 10 min, 30 min, 2 h, 6 h), then marked failed for
    /// administrators to see. A user's quiet hours hold their deliveries until the hours end
    /// (checked again at send time, so a change of quiet hours applies to what is queued). At send
    /// time the recipient and the settings are checked again too (each delivery reads the
    /// configuration afresh): a user who is gone or disabled, an administrators' alert for someone
    /// who is no longer one or switched those alerts off, a kind of alert the user switched off, a
    /// channel switched off (by the administrator or the user) and a title the user can no longer
    /// open end the delivery as "suppressed" (final, not a failure, never retried). Notifications
    /// switched off as a whole leave what is queued pending until they are back. A restore of the
    /// database while a delivery is on its way leaves the restored rows alone.
    /// </summary>
    public sealed class NotifyDispatcher : IHostedService, IDisposable
    {
        /// <summary>Waits before each retry; after the last one the delivery is given up.</summary>
        internal static readonly TimeSpan[] Backoff =
        {
            TimeSpan.FromSeconds(30), TimeSpan.FromMinutes(2), TimeSpan.FromMinutes(10), TimeSpan.FromMinutes(30), TimeSpan.FromHours(2), TimeSpan.FromHours(6),
        };

        private const int BatchSize = 20;
        private static readonly JsonSerializerOptions PayloadJson = new();

        private readonly NotifyStore _store;
        private readonly NtfySender _ntfy;
        private readonly EmailSender _email;
        private readonly INotifyUsers? _users;
        private readonly IArrJellyfinView? _view;
        private readonly TitleAliases? _aliases;
        private readonly Logger? _logger;
        private readonly Func<PluginConfiguration?> _config;
        private readonly Func<DateTimeOffset> _now;
        private readonly SemaphoreSlim _wake = new(0, int.MaxValue);
        private readonly SemaphoreSlim _run = new(1, 1);
        private CancellationTokenSource? _loop;
        private Task? _loopTask;

        /// <summary>The dispatcher (DI).</summary>
        public NotifyDispatcher(NotifyStore store, NtfySender ntfy, EmailSender email, INotifyUsers users, IArrJellyfinView view, TitleAliases aliases, Logger logger)
            : this(store, ntfy, email, logger, null, null, users, view, aliases)
        {
        }

        /// <summary>A dispatcher with explicit configuration and clock (tests).</summary>
        internal NotifyDispatcher(NotifyStore store, NtfySender ntfy, EmailSender email, Logger? logger, Func<PluginConfiguration?>? config, Func<DateTimeOffset>? now, INotifyUsers? users = null, IArrJellyfinView? view = null, TitleAliases? aliases = null)
        {
            _view = view;
            _aliases = aliases;
            _store = store;
            _ntfy = ntfy;
            _email = email;
            _users = users;
            _logger = logger;
            _config = config ?? (() => JellyfinEnhanced.Instance?.Configuration);
            _now = now ?? (() => DateTimeOffset.UtcNow);
        }

        private long _sent;
        private long _failed;

        /// <summary>Deliveries sent since start (diagnostics).</summary>
        public long SentCount => Interlocked.Read(ref _sent);

        /// <summary>Delivery attempts that failed since start (diagnostics).</summary>
        public long FailedCount => Interlocked.Read(ref _failed);

        /// <summary>Something new was queued: deliver now.</summary>
        public void Wake()
        {
            if (_wake.CurrentCount < 4) _wake.Release();
        }

        /// <inheritdoc />
        public Task StartAsync(CancellationToken cancellationToken)
        {
            _loop = new CancellationTokenSource();
            var token = _loop.Token;
            _loopTask = Task.Run(() => LoopAsync(token), CancellationToken.None);
            return Task.CompletedTask;
        }

        /// <inheritdoc />
        /// <remarks>
        /// Waits for the send in progress to end (no new one starts), or until Jellyfin stops waiting:
        /// a delivery interrupted mid-send is tried again after the restart (at least once).
        /// </remarks>
        public async Task StopAsync(CancellationToken cancellationToken)
        {
            try
            {
                _loop?.Cancel();
            }
            catch (ObjectDisposedException)
            {
            }
            if (_loopTask is not { } loop) return;
            try
            {
                await loop.WaitAsync(cancellationToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                // Jellyfin stopped waiting.
            }
        }

        /// <inheritdoc />
        /// <remarks>Safe to call more than once (registered as itself and as a hosted service).</remarks>
        public void Dispose()
        {
            var loop = Interlocked.Exchange(ref _loop, null);
            if (loop == null) return;
            try
            {
                loop.Cancel();
            }
            catch (ObjectDisposedException)
            {
            }
            loop.Dispose();
        }

        private async Task LoopAsync(CancellationToken token)
        {
            while (!token.IsCancellationRequested)
            {
                try
                {
                    // Wake on a new delivery, else look every few seconds (retries and quiet hours come due on their own).
                    await _wake.WaitAsync(TimeSpan.FromSeconds(5), token).ConfigureAwait(false);
                    await RunOnceAsync(token).ConfigureAwait(false);
                }
                catch (OperationCanceledException) when (token.IsCancellationRequested)
                {
                    return;
                }
                catch (Exception ex)
                {
                    _logger?.Warning($"Notifications: delivery round failed ({ex.GetType().Name}: {ex.Message}).");
                }
            }
        }

        /// <summary>Sends every delivery that is due; returns how many were attempted (tests step it).</summary>
        internal async Task<int> RunOnceAsync(CancellationToken cancellationToken)
        {
            if (!NotifyFlags.Enabled(_config()) || !_store.Available) return 0;
            await _run.WaitAsync(cancellationToken).ConfigureAwait(false);
            try
            {
                var attempted = 0;
                for (var round = 0; round < 10; round++)
                {
                    var due = _store.Due(_now(), BatchSize);
                    if (due.Count == 0) break;
                    foreach (var delivery in due)
                    {
                        cancellationToken.ThrowIfCancellationRequested();
                        // The settings as they are now, for each delivery: switched off as a whole, the
                        // rest stay pending (sent when notifications are back on).
                        var config = _config();
                        if (!NotifyFlags.Enabled(config)) return attempted;
                        await DeliverAsync(config!, delivery, cancellationToken).ConfigureAwait(false);
                        attempted++;
                    }
                }
                return attempted;
            }
            finally
            {
                _run.Release();
            }
        }

        private async Task DeliverAsync(PluginConfiguration config, DueDelivery delivery, CancellationToken cancellationToken)
        {
            var now = _now();
            var prefs = _store.Prefs(delivery.UserId);
            if (QuietHours.EndsAt(prefs, now) is { } end)
            {
                _store.Postpone(delivery.Id, end, delivery.Generation);
                return;
            }
            // Held back by quiet hours, a batch window or retries: whether the recipient may still get it
            // is decided now, not when it was queued.
            var payload = new Dictionary<string, string>(Payload(delivery.Payload));
            if (Suppression(delivery, prefs, payload, out var itemId) is { } reason)
            {
                _store.Suppress(delivery.Id, reason, delivery.Generation);
                return;
            }
            // A channel switched off since the alert was queued (by the administrator or the user):
            // nothing to retry, so not a failure either.
            if (ChannelOff(config, delivery.Channel, prefs) is { } off)
            {
                _store.Suppress(delivery.Id, off, delivery.Generation);
                return;
            }
            var message = NotifyTexts.Render(delivery.Kind, payload, prefs.HideTitles);
            var link = ExternalLink(config, itemId, delivery.Kind);
            var result = delivery.Channel == NotifyChannel.Ntfy
                ? await _ntfy.SendAsync(config.ArrNtfyServerUrl, config.GetSecret(nameof(PluginConfiguration.ArrNtfyToken)), prefs.NtfyTopic!, message, link, Tags(delivery.Kind), Priority(delivery.Kind), cancellationToken).ConfigureAwait(false)
                : await _email.SendAsync(config, prefs.EmailAddress!, message, link, SettingsLink(config), cancellationToken).ConfigureAwait(false);
            if (result.Ok)
            {
                Interlocked.Increment(ref _sent);
                if (!_store.Finish(delivery.Id, true, null, null, _now(), delivery.Generation)) _logger?.Info($"Notifications: delivery {delivery.Id} was sent while the database was restored; the restored rows are left as they are.");
                return;
            }
            Interlocked.Increment(ref _failed);
            var attempt = delivery.Attempts + 1;
            DateTimeOffset? retry = attempt <= Backoff.Length ? _now() + Backoff[attempt - 1] : null;
            _store.Finish(delivery.Id, false, result.Error, retry, _now(), delivery.Generation);
            _logger?.Warning($"Notifications: {delivery.Channel} delivery {delivery.Id} failed (attempt {attempt}){(retry.HasValue ? ", will retry" : ", giving up")}: {result.Error}");
        }

        /// <summary>
        /// Why the delivery must not go out any more, or null: the recipient switched this kind of
        /// alert off (Ready, new episodes, declined); the recipient is gone or disabled; an
        /// administrators' alert (paths, instance names, household requests) for someone who is no
        /// longer an administrator or switched those alerts off; a Ready or new-episodes alert for a
        /// title the recipient can no longer open (library access or parental limits changed).
        /// </summary>
        private string? Suppression(DueDelivery delivery, NotifyPrefs prefs, Dictionary<string, string> payload, out string? itemId)
        {
            itemId = delivery.ItemId;
            var kindOff = delivery.Kind switch
            {
                NotifyKind.Ready => !prefs.Ready,
                NotifyKind.Episodes => !prefs.Episodes,
                NotifyKind.Declined => !prefs.Declined,
                _ => false,
            };
            if (kindOff) return "The recipient switched these alerts off.";
            if (_users == null) return null;
            if (!_users.IsActive(delivery.UserId)) return "The recipient no longer exists or is disabled.";
            if (NotifyKind.IsAdminKind(delivery.Kind))
            {
                if (!_users.Admins().Contains(delivery.UserId)) return "The recipient is no longer an administrator.";
                return prefs.AdminAlerts ? null : "The recipient switched administrators' alerts to phone and e-mail off.";
            }
            if (_view == null || delivery.Kind is not (NotifyKind.Ready or NotifyKind.Episodes)) return null;
            if (_view.Viewer(delivery.UserId) is not { } viewer) return "The recipient no longer exists or is disabled.";
            // Older notifications have no episodeItems and retain their parent-item check. New
            // batches carry each number's actual file, including combined files and the variant.
            if (delivery.Kind == NotifyKind.Episodes && payload.TryGetValue("episodeItems", out var json))
            {
                List<NotifyEpisode>? episodes;
                try { episodes = JsonSerializer.Deserialize<List<NotifyEpisode>>(json, PayloadJson); }
                catch (JsonException) { episodes = null; }
                var visible = episodes?.Where(e => e.ItemId != Guid.Empty && _view.Resolve(e.ItemId, viewer) != null)
                    .DistinctBy(e => (e.Season, e.Episode)).OrderBy(e => e.Season).ThenBy(e => e.Episode).ToList();
                if (visible is not { Count: > 0 }) return "The recipient can no longer open these episodes.";
                var seasons = visible.Select(e => e.Season).Distinct().ToList();
                payload["count"] = visible.Count.ToString(CultureInfo.InvariantCulture);
                payload["seasons"] = string.Join(", ", seasons);
                if (visible.Count == 1)
                {
                    payload["mode"] = "single";
                    payload["season"] = visible[0].Season.ToString(CultureInfo.InvariantCulture);
                    payload["episode"] = visible[0].Episode.ToString(CultureInfo.InvariantCulture);
                    itemId = visible[0].ItemId.ToString("N", CultureInfo.InvariantCulture);
                }
                else if (visible.Count != episodes!.Count)
                {
                    // The whole season is no longer visible: don't announce it as complete.
                    payload["mode"] = "many";
                    payload.Remove("season");
                    payload.Remove("episode");
                }
            }
            if (Guid.TryParse(delivery.ItemId, out var item) && item != Guid.Empty)
            {
                return _view.Resolve(item, viewer) == null ? "The recipient can no longer open this title." : null;
            }
            var key = TitleKey.Parse(delivery.TitleKey);
            return key != null && _view.Copies(key, viewer, _aliases?.Of(key)).Any(c => c.Visible) ? null : "The recipient can no longer open this title.";
        }

        /// <summary>Why a channel can't carry the delivery now (switched off or not set up, by the administrator or the user), or null.</summary>
        private static string? ChannelOff(PluginConfiguration config, string channel, NotifyPrefs prefs) => channel switch
        {
            NotifyChannel.Ntfy when !NotifyEndpoints.NtfyReady(config) => "Phone alerts (ntfy) are switched off or have no server.",
            NotifyChannel.Ntfy when !prefs.Ntfy || !NotifyEndpoints.IsTopic(prefs.NtfyTopic) => "The user turned phone alerts off or has no topic.",
            NotifyChannel.Ntfy => null,
            NotifyChannel.Email when !NotifyEndpoints.EmailReady(config) => "E-mail alerts are switched off or have no mail server.",
            NotifyChannel.Email when !prefs.Email || string.IsNullOrEmpty(prefs.EmailAddress) => "The user turned e-mail off or has no verified address.",
            NotifyChannel.Email => null,
            _ => "Unknown channel.",
        };

        /// <summary>
        /// The deep link for pushes and e-mails: the item's details page, else the Requests page (the
        /// administrators' tab an admin alert is about); null without a household address.
        /// </summary>
        internal static string? ExternalLink(PluginConfiguration? config, string? itemId, string? kind = null)
        {
            var root = NotifyEndpoints.HouseholdUrl(config);
            if (root == null) return null;
            return root + "/web/" + InAppLink(itemId, kind);
        }

        /// <summary>
        /// The in-app link (a hash route): the item's details page, else the Requests page — for
        /// administrators' alerts about the arrs the tab that shows them (Overview with Needs
        /// attention, or System for an instance or its disks).
        /// </summary>
        public static string InAppLink(string? itemId, string? kind = null)
        {
            if (!string.IsNullOrEmpty(itemId) && Guid.TryParse(itemId, out var id)) return "#/details?id=" + id.ToString("N");
            return kind switch
            {
                NotifyKind.Attention or NotifyKind.StuckDigest => "#/requests?tab=overview",
                NotifyKind.InstanceDown or NotifyKind.InstanceUp or NotifyKind.LowDisk => "#/requests?tab=system",
                _ => "#/requests",
            };
        }

        /// <summary>The link to the user's "Requests &amp; alerts" settings (e-mail unsubscribe), or null.</summary>
        internal static string? SettingsLink(PluginConfiguration? config)
        {
            var root = NotifyEndpoints.HouseholdUrl(config);
            return root == null ? null : root + "/web/#/home?je=alerts";
        }

        internal static IReadOnlyDictionary<string, string> Payload(string json)
        {
            try
            {
                return JsonSerializer.Deserialize<Dictionary<string, string>>(json, PayloadJson) ?? new Dictionary<string, string>();
            }
            catch (JsonException)
            {
                return new Dictionary<string, string>();
            }
        }

        private static string[] Tags(string kind) => kind switch
        {
            NotifyKind.Ready or NotifyKind.Episodes => new[] { "tv" },
            NotifyKind.Declined => new[] { "no_entry_sign" },
            NotifyKind.Approval => new[] { "raising_hand" },
            NotifyKind.InstanceDown or NotifyKind.LowDisk or NotifyKind.StuckDigest or NotifyKind.Attention => new[] { "warning" },
            NotifyKind.Remind => new[] { "bell" },
            _ => new[] { "jellyfish" },
        };

        private static int Priority(string kind) => kind is NotifyKind.InstanceDown or NotifyKind.Approval or NotifyKind.Remind ? 4 : 3;
    }
}
