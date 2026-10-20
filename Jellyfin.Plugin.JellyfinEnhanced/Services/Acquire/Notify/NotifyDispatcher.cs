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
    /// administrators to see. Every alert, here and where it is made (<see cref="NotificationService"/>), is decided by
    /// one final gate, <see cref="Final"/> (4f round 9): synchronous, handed only the alert's identifiers, it reads at that
    /// moment everything the decision depends on (the configuration and its master switch, the recipient's preferences and
    /// quiet hours, the recipient, the request as it is now, the title's visibility and their Hidden Content), and each
    /// action is taken from its verdict with no await in between (the network send itself excepted). A user's quiet hours
    /// hold their deliveries until the hours end; a user who is gone or disabled, an administrators' alert for someone who is
    /// no longer one or switched those alerts off, a kind of alert the user switched off, a channel switched off (by the
    /// administrator or the user), a request that moved on and a title the user can no longer open or hid end the delivery as
    /// "suppressed" (final, not a failure, never retried). Notifications switched off as a whole leave what is queued pending
    /// until they are back, even a delivery being prepared at that moment. A restore of the database while a delivery is on
    /// its way leaves the restored rows alone.
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
        private readonly Requests.RequestLedger? _ledger;
        private readonly Requests.IRequestPolicy? _policy;
        private readonly Ready.ReadyNativeChannel? _native;
        private readonly SeerrRequestReadModel? _requests;
        private readonly Logger? _logger;
        private readonly Func<PluginConfiguration?> _config;
        private readonly Func<DateTimeOffset> _now;
        private readonly SemaphoreSlim _wake = new(0, int.MaxValue);
        private readonly SemaphoreSlim _run = new(1, 1);
        private CancellationTokenSource? _loop;
        private Task? _loopTask;

        /// <summary>The dispatcher (DI).</summary>
        public NotifyDispatcher(NotifyStore store, NtfySender ntfy, EmailSender email, INotifyUsers users, IArrJellyfinView view, TitleAliases aliases, Logger logger, Requests.RequestLedger ledger, Requests.IRequestPolicy policy, Ready.ReadyNativeChannel native, SeerrRequestReadModel requests)
            : this(store, ntfy, email, logger, null, null, users, view, aliases, ledger, policy, native, requests)
        {
        }

        /// <summary>
        /// A dispatcher with explicit configuration and clock (tests). With <paramref name="ledger"/>, an OK of a request
        /// held (quiet hours, retries) isn't sent once it isn't OK'd any more (back to waiting, declined, cancelled, removed); with
        /// <paramref name="policy"/>, an ask waiting for an OK isn't sent to an administrator who can no longer see its title.
        /// With <paramref name="native"/>, native Ready messages (phase 4f) go out; without it they end as suppressed. With
        /// <paramref name="requests"/>, a Seerr request's decline or ask isn't told once Seerr's list shows it moved on.
        /// </summary>
        internal NotifyDispatcher(NotifyStore store, NtfySender ntfy, EmailSender email, Logger? logger, Func<PluginConfiguration?>? config, Func<DateTimeOffset>? now, INotifyUsers? users = null, IArrJellyfinView? view = null, TitleAliases? aliases = null, Requests.RequestLedger? ledger = null, Requests.IRequestPolicy? policy = null, Ready.ReadyNativeChannel? native = null, SeerrRequestReadModel? requests = null)
        {
            _native = native;
            _requests = requests;
            _ledger = ledger;
            _policy = policy;
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

        /// <summary>The event key prefix of "your request was OK'd" (followed by the request id).</summary>
        internal const string ApprovedEventPrefix = "req-ok|";

        /// <summary>The event key prefix of "your request was declined" in Jellyfin Enhanced mode (followed by the request id).</summary>
        internal const string DeclinedEventPrefix = "req-no|";

        /// <summary>
        /// The request-policy input an outcome alert (declined, OK'd) is judged by (4f round 7: every dimension the policy needs,
        /// end to end): for a Jellyfin Enhanced request (its event key names it), the request as the ledger holds it now (edition,
        /// part of the series, and the instance and folder an administrator routed it to), as the requester's Requests page
        /// judges its card; otherwise (a Seerr request, or a request since removed) the title, the edition (<c>variant</c>) and the
        /// seasons the alert itself carries. Null when the ledger can't be read now (wait, never "visible" or "hidden").
        /// </summary>
        internal Requests.MutationInput? OutcomeInput(TitleKey key, string? eventKey, IReadOnlyDictionary<string, string> payload)
            => OutcomeRequest(key, eventKey, payload)?.Input;

        /// <summary>
        /// <see cref="OutcomeInput"/> with the stored request's persisted target: a ledger request is judged where it actually
        /// goes (the arr instance its target names when it has no routing of its own, and the Seerr source it was made for),
        /// as every other check of a stored request is (<see cref="Requests.IRequestPolicy.Evaluate(Guid, Requests.MutationInput, string)"/>),
        /// never where a new request would go now. No target for a Seerr request or a removed one (the alert's own facts).
        /// </summary>
        internal (Requests.MutationInput Input, string? Target)? OutcomeRequest(TitleKey key, string? eventKey, IReadOnlyDictionary<string, string> payload)
        {
            var prefix = eventKey == null ? null : eventKey.StartsWith(ApprovedEventPrefix, StringComparison.Ordinal) ? ApprovedEventPrefix
                : eventKey.StartsWith(DeclinedEventPrefix, StringComparison.Ordinal) ? DeclinedEventPrefix : null;
            if (_ledger != null && prefix != null)
            {
                if (!_ledger.Database.Available) return null;
                if (_ledger.Find(eventKey![prefix.Length..]) is { } want) return (Requests.RequestDestination.Of(want.Input, want.TargetKey), want.TargetKey);
            }
            var seasons = payload.TryGetValue("seasons", out var list)
                ? list.Split(',', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries).Select(x => int.TryParse(x, NumberStyles.None, CultureInfo.InvariantCulture, out var n) ? n : -1).Where(n => n >= 0).ToArray()
                : Array.Empty<int>();
            return (NotificationService.AskInput(key.Title, seasons, payload.TryGetValue("variant", out var variant) && variant == "4k"), null);
        }

        // Before a send of an outcome alert: the rating facts its policy input needs are loaded (bounded by the policy; a failed
        // lookup leaves them unverified, and the decision then waits). Never a decision: each delivery is decided by the final
        // gate after it (a single send right after its own; a summary's members after all of theirs).
        private async Task PrepareOutcomeAsync(DueDelivery delivery, CancellationToken cancellationToken)
        {
            if (_policy == null || delivery.Kind is not (NotifyKind.Declined or NotifyKind.Approved) || TitleKey.Parse(delivery.TitleKey) is not { } key) return;
            if (QuietHours.EndsAt(_store.Prefs(delivery.UserId), _now()) != null) return;
            if (OutcomeInput(key, delivery.EventKey, Payload(delivery.Payload)) is { } input)
                await _policy.PrepareVisibilityAsync(delivery.UserId, input, cancellationToken).ConfigureAwait(false);
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
                    if (await _wake.WaitAsync(TimeSpan.FromSeconds(5), token).ConfigureAwait(false))
                    {
                        // Let a burst settle (a backlog is queued one notification at a time) so it can go out as one
                        // summary per person and channel: until nothing new for the settle time, at most a few rounds.
                        var started = DateTimeOffset.UtcNow;
                        while (DateTimeOffset.UtcNow - started < SettleLimit && await _wake.WaitAsync(SettleWindow, token).ConfigureAwait(false))
                        {
                        }
                    }
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
                    // A backlog released at once (notifications switched back on, quiet hours over) for one person on
                    // one channel goes out as one summary instead of a burst of pushes or e-mails.
                    foreach (var group in due.GroupBy(d => (d.UserId, d.Channel)))
                    {
                        cancellationToken.ThrowIfCancellationRequested();
                        var list = group.ToList();
                        // Each delivery is decided by the final gate after its own last await: switched off as a whole meanwhile,
                        // it and the rest stay pending (sent when notifications are back on).
                        (int Attempted, bool Off) done;
                        if (group.Key.Channel == NotifyChannel.DisplayMessage)
                        {
                            // Native Ready messages (phase 4f) have their own path: never held, never retried, one at a time.
                            done = await DeliverDisplayAsync(list, cancellationToken).ConfigureAwait(false);
                        }
                        else if (list.Count >= SummaryAt)
                        {
                            done = await DeliverSummaryAsync(list, cancellationToken).ConfigureAwait(false);
                        }
                        else
                        {
                            done = (0, false);
                            foreach (var delivery in list)
                            {
                                cancellationToken.ThrowIfCancellationRequested();
                                if (await DeliverAsync(delivery, cancellationToken).ConfigureAwait(false) == NotifyEffect.Leave)
                                {
                                    done = (done.Attempted, true);
                                    break;
                                }
                                done = (done.Attempted + 1, false);
                            }
                        }
                        attempted += done.Attempted;
                        if (done.Off) return attempted;
                    }
                }
                return attempted;
            }
            finally
            {
                _run.Release();
            }
        }

        /// <summary>How long a woken round waits for the next new notification before delivering (tests shorten it).</summary>
        internal TimeSpan SettleWindow { get; set; } = TimeSpan.FromSeconds(2);

        /// <summary>The longest a woken round waits for a burst to settle.</summary>
        internal TimeSpan SettleLimit { get; set; } = TimeSpan.FromSeconds(15);

        /// <summary>How many alerts due at once for one person on one channel go out as one summary.</summary>
        internal const int SummaryAt = 4;

        // ================================================================== the final gate (4f round 9)

        // What the final gate reads, all at once, when it is called: the configuration, the recipient's preferences and the
        // clock. A ref struct: the compiler won't let it live across an await, so nothing a decision reads can be carried
        // from before one into it.
        private readonly ref struct GateRead
        {
            public GateRead(PluginConfiguration config, NotifyPrefs prefs, DateTimeOffset now)
            {
                Config = config;
                Prefs = prefs;
                Now = now;
            }

            public PluginConfiguration Config { get; }

            public NotifyPrefs Prefs { get; }

            public DateTimeOffset Now { get; }
        }

        /// <summary>
        /// THE final gate (4f round 9): whether an alert may be told now, and how. Synchronous, and handed nothing but the
        /// alert's identifiers: it reads, at the moment it is called, everything the decision depends on — the configuration
        /// (<c>_config()</c>: the master switch, the phase, channel and native-message switches, the household address), the
        /// recipient's preferences (the kind of alert, their channels, quiet hours, hidden titles), the recipient (gone,
        /// disabled, still an administrator), the request as the request ledger or Seerr's list holds it now (still OK'd,
        /// still declined, still waiting for an OK), the title's visibility to them (library access, parental limits, the
        /// request policy) and their Hidden Content. For a delivery (<see cref="NotifyAlert.Channel"/>): send it, wait (quiet
        /// hours; evidence that can't be read now, at most a day) or refuse it; for the notification itself (no channel):
        /// make it with its deliveries, wait for the evidence, or refuse it. Off when notifications are switched off as a
        /// whole: nothing may be done. Every action on an alert — a send and its settling, a summary's count, a bell row and
        /// its deliveries, a wait queued, retried or dropped, a notice or batch consumed — is taken from its verdict with no
        /// await in between (the network send itself excepted); the source scan (tests: NotifyGateWalk) holds every caller to it.
        /// </summary>
        internal NotifyFinal Final(NotifyAlert alert)
        {
            var config = _config();
            var now = _now();
            if (!NotifyFlags.Enabled(config) || !_store.Available) return NotifyFinal.Off(alert, now);
            var read = new GateRead(config!, _store.Prefs(alert.User), now);
            return alert.Channel switch
            {
                null => Tell(in read, alert),
                NotifyChannel.DisplayMessage => Display(in read, alert),
                _ => Outbound(in read, alert),
            };
        }

        // A phone or e-mail delivery: held by quiet hours, no longer for the recipient (refused), waiting for evidence, or ready
        // with its message and link. Held back by quiet hours, a batch window or retries: whether the recipient may still get
        // it is decided now, not when it was queued.
        private NotifyFinal Outbound(in GateRead read, NotifyAlert alert)
        {
            if (QuietHours.EndsAt(read.Prefs, read.Now) is { } end) return NotifyFinal.Wait(alert, read.Now, "The recipient's quiet hours.", end);
            var payload = new Dictionary<string, string>(alert.Payload);
            var verdict = Suppression(in read, alert, payload, outbound: true, out var itemId);
            // The recipient's Hidden Content (or the request, or the title's rating) can't be read now: nothing is sent until it
            // can (looked at again shortly), for a day at most.
            if (verdict.Wait && read.Now - alert.Queued <= WaitAtMost) return NotifyFinal.Wait(alert, read.Now, verdict.Why, read.Now + WaitFor);
            if (verdict.Why is { } reason) return NotifyFinal.Refuse(alert, read.Now, verdict.Wait ? reason + " (for a day; not sent)" : reason);
            // A channel switched off since the alert was queued (by the administrator or the user): nothing to retry, so not a
            // failure either.
            if (ChannelOff(in read, alert.Channel!) is { } off) return NotifyFinal.Refuse(alert, read.Now, off);
            return NotifyFinal.Send(alert, read.Now, payload, itemId, NotifyTexts.Render(alert.Kind, payload, read.Prefs.HideTitles),
                ExternalLink(read.Config, itemId, alert.Kind), ExternalLink(read.Config, null, null), read.Config, read.Prefs);
        }

        // A native Ready message: never held (quiet hours, unreadable evidence, a stale one end it), rendered from the person's
        // settings as they are now.
        private NotifyFinal Display(in GateRead read, NotifyAlert alert)
        {
            var payload = new Dictionary<string, string>(alert.Payload);
            if (DisplayReason(in read, alert, payload) is { } why) return NotifyFinal.Refuse(alert, read.Now, why);
            return NotifyFinal.Send(alert, read.Now, payload, alert.ItemId, NotifyTexts.Render(alert.Kind, payload, read.Prefs.HideTitles), null, null, read.Config, read.Prefs);
        }

        // The notification itself (its bell row): too old to be told, refused or waiting as for a delivery (administrators'
        // phone-and-e-mail switch aside: it decides only their deliveries), else made with a delivery for each channel the
        // person has on now, held until their quiet hours end. A batch of new episodes: each episode is held to the catch-up
        // limit by its own arrival (4f round 10); the batch is told with the fresh ones, and refused when none is left.
        private NotifyFinal Tell(in GateRead read, NotifyAlert alert)
        {
            const string TooOld = "It happened too long ago to be told now.";
            if (alert.Since is { } since && read.Now - since > NotificationService.ArrivalFreshFor) return NotifyFinal.Refuse(alert, read.Now, TooOld);
            var payload = new Dictionary<string, string>(alert.Payload);
            if (alert.Kind == NotifyKind.Episodes)
            {
                switch (FreshEpisodes(read.Now, payload))
                {
                    case null:
                        return NotifyFinal.Refuse(alert, read.Now, TooOld);
                    case Guid only when only != Guid.Empty:
                        alert = alert with { ItemId = only.ToString("N", CultureInfo.InvariantCulture) };
                        break;
                }
            }

            var verdict = Suppression(in read, alert, payload, outbound: false, out var itemId);
            if (verdict.Wait) return NotifyFinal.Wait(alert, read.Now, verdict.Why, read.Now + WaitFor);
            if (verdict.Why is { } why) return NotifyFinal.Refuse(alert, read.Now, why);
            return NotifyFinal.Tell(alert, read.Now, payload, itemId, Deliveries(in read, alert.Kind));
        }

        // A batch's episodes held to the catch-up limit by their own arrivals (an episode with none: by the batch's): those past it
        // are dropped from the payload and its count, seasons and wording set from what is left. Null when none is left; the one
        // episode left when the batch was narrowed to it; else Guid.Empty.
        private static Guid? FreshEpisodes(DateTimeOffset now, Dictionary<string, string> payload)
        {
            if (!payload.TryGetValue("episodeItems", out var json)) return Guid.Empty;
            List<NotifyEpisode>? all;
            try { all = JsonSerializer.Deserialize<List<NotifyEpisode>>(json, PayloadJson); }
            catch (JsonException) { return Guid.Empty; }
            if (all is not { Count: > 0 }) return Guid.Empty;
            var fresh = all.Where(e => e.At is not { } at || now - at <= NotificationService.ArrivalFreshFor).ToList();
            if (fresh.Count == 0) return null;
            if (fresh.Count == all.Count) return Guid.Empty;
            payload["episodeItems"] = JsonSerializer.Serialize(fresh, PayloadJson);
            payload["count"] = fresh.Count.ToString(CultureInfo.InvariantCulture);
            payload["seasons"] = string.Join(", ", fresh.Select(e => e.Season).Distinct().OrderBy(x => x));
            if (fresh.Count == 1)
            {
                payload["mode"] = "single";
                payload["season"] = fresh[0].Season.ToString(CultureInfo.InvariantCulture);
                payload["episode"] = fresh[0].Episode.ToString(CultureInfo.InvariantCulture);
                return fresh[0].ItemId;
            }

            // Fewer than the batch: never "the whole season".
            payload["mode"] = "many";
            payload.Remove("season");
            payload.Remove("episode");
            return Guid.Empty;
        }

        // A new notification's deliveries, from the person's settings and the channels as they are now.
        private static IReadOnlyList<(string Channel, DateTimeOffset At)> Deliveries(in GateRead read, string kind)
        {
            var prefs = read.Prefs;
            var deliveries = new List<(string, DateTimeOffset)>();
            var external = !NotifyKind.IsAdminKind(kind) || prefs.AdminAlerts;
            var at = QuietHours.EndsAt(prefs, read.Now) ?? read.Now;
            if (external && prefs.Ntfy && NotifyEndpoints.IsTopic(prefs.NtfyTopic) && NotifyEndpoints.NtfyReady(read.Config)) deliveries.Add((NotifyChannel.Ntfy, at));
            if (external && prefs.Email && !string.IsNullOrEmpty(prefs.EmailAddress) && NotifyEndpoints.EmailReady(read.Config)) deliveries.Add((NotifyChannel.Email, at));
            // Phase 4f: a native on-screen message for what became ready (and a test), with the person's own consent. Due
            // now: quiet hours, a busy or missing session end it at delivery instead of holding it.
            if (kind is NotifyKind.Ready or NotifyKind.Episodes or NotifyKind.Test && prefs.NativeReadyMessages && Ready.ReadyFlags.Messages(read.Config)) deliveries.Add((NotifyChannel.DisplayMessage, read.Now));
            return deliveries;
        }

        // A delivery's verdict acted on right after the gate, by the one table (4f round 10): Leave, nothing is done (it stays
        // pending); Postpone, held until the verdict's time; Suppress, ended; Act, the caller sends it. Returns the effect.
        private NotifyEffect Act(DueDelivery delivery, NotifyFinal final)
        {
            switch (final.Effect)
            {
                case NotifyEffect.Leave:
                    return NotifyEffect.Leave;
                case NotifyEffect.Postpone:
                    _store.Postpone(delivery.Id, final.Until!.Value, delivery.Generation);
                    return NotifyEffect.Postpone;
                case NotifyEffect.Suppress:
                    _store.Suppress(delivery.Id, final.Why!, delivery.Generation);
                    return NotifyEffect.Suppress;
                case NotifyEffect.Act:
                    return NotifyEffect.Act;
            }

            throw new InvalidOperationException("Unknown effect.");
        }

        /// <summary>How long a delivery (or an episode batch) waits before its recipient's unreadable Hidden Content is read again.</summary>
        internal static readonly TimeSpan WaitFor = TimeSpan.FromMinutes(5);

        /// <summary>The longest a delivery or an episode batch waits for readable Hidden Content; then it is never sent.</summary>
        internal static readonly TimeSpan WaitAtMost = TimeSpan.FromHours(24);

        // The network send of a verdict to send: on the transport the gate read (its server and token, the person's topic or
        // address).
        private async Task<(bool Ok, string? Error)> SendAsync(NotifyFinal plan, NotifyMessage message, string? link, string kind, CancellationToken cancellationToken)
        {
            // Every channel by name: a channel this code doesn't know is never sent as an e-mail.
            switch (plan.Alert.Channel)
            {
                case NotifyChannel.Ntfy:
                {
                    var result = await _ntfy.SendAsync(plan.Config!.ArrNtfyServerUrl, plan.Config.GetSecret(nameof(PluginConfiguration.ArrNtfyToken)), plan.Prefs!.NtfyTopic!, message, link, Tags(kind), Priority(kind), cancellationToken).ConfigureAwait(false);
                    return (result.Ok, result.Error);
                }

                case NotifyChannel.Email:
                {
                    var result = await _email.SendAsync(plan.Config!, plan.Prefs!.EmailAddress!, message, link, SettingsLink(plan.Config), cancellationToken).ConfigureAwait(false);
                    return (result.Ok, result.Error);
                }

                default:
                    return (false, "Unknown channel.");
            }
        }

        // ------------------------------------------------------------------ native Ready messages (phase 4f)

        /// <summary>
        /// Native Ready messages due for one person: each is decided by the final gate now (the switches, their consent, quiet
        /// hours, freshness, still theirs to see, Hidden Content, no earlier attempt), then one message (a summary for several)
        /// goes to one idle session of theirs, read again right before the send. At that last moment, with no await before the
        /// send, every one of them is decided by the gate again and the text is rendered from the person's settings as they are
        /// then (hidden titles, a title they hid meanwhile, a kind they turned off): render last. Each verdict, at the first look
        /// and in the claim, is acted on by the one table (4f round 10): notifications switched off (even during the session's
        /// re-read right before the claim) leave every one of them pending, unclaimed, to go once they are back on; a refusal
        /// suppresses it. Busy, unsupported, no session or anything else on the session's side ends them as suppressed: never
        /// held for later and never retried. Returns how many were attempted, and whether notifications were switched off.
        /// </summary>
        private async Task<(int Attempted, bool Off)> DeliverDisplayAsync(IReadOnlyList<DueDelivery> deliveries, CancellationToken cancellationToken)
        {
            var ready = new List<DueDelivery>();
            foreach (var delivery in deliveries)
            {
                var final = Final(NotifyAlert.Of(delivery));
                switch (Act(delivery, final))
                {
                    case NotifyEffect.Leave:
                        return (0, true);
                    case NotifyEffect.Act:
                        ready.Add(delivery);
                        break;
                    case NotifyEffect.Postpone:
                    case NotifyEffect.Suppress:
                        // Acted on by the table already.
                        break;
                }
            }
            if (ready.Count == 0 || _native == null) return (deliveries.Count, false);
            var user = ready[0].UserId;
            var generation = ready[0].Generation;
            // What the claim did by the table: notifications switched off (nothing claimed, all left pending), and the deliveries
            // it postponed or suppressed itself.
            var off = false;
            var decided = new HashSet<long>();
            // Right before the send: every delivery decided again and the message rendered from the settings as they are now.
            (NotifyMessage Message, IReadOnlyList<long> Ids)? Claim()
            {
                var going = new List<long>();
                NotifyMessage? single = null;
                foreach (var delivery in ready)
                {
                    var final = Final(NotifyAlert.Of(delivery) with { Claimed = true });
                    switch (Act(delivery, final))
                    {
                        case NotifyEffect.Leave:
                            // Switched off: nothing is claimed or sent, and none of them is ended.
                            off = true;
                            return null;
                        case NotifyEffect.Act:
                            going.Add(delivery.Id);
                            single = final.Message;
                            break;
                        case NotifyEffect.Postpone:
                        case NotifyEffect.Suppress:
                            decided.Add(delivery.Id);
                            break;
                    }
                }
                if (going.Count == 0) return null;
                return (going.Count == 1 ? single! : NotifyTexts.Summary(going.Count), going);
            }
            var (result, sent) = await _native.SendAsync(user, generation, Claim, cancellationToken).ConfigureAwait(false);
            var claimed = sent.ToHashSet();
            foreach (var delivery in ready)
            {
                if (claimed.Contains(delivery.Id) && result.Accepted)
                {
                    Interlocked.Increment(ref _sent);
                    _store.Finish(delivery.Id, true, null, null, _now(), delivery.Generation);
                }
                else if (claimed.Contains(delivery.Id) && result.Unknown)
                {
                    _store.Suppress(delivery.Id, "Native message: the send started but its outcome is unknown (" + result.Reason + "); not sent again.", delivery.Generation);
                }
                else if (!off && !decided.Contains(delivery.Id))
                {
                    // The session's side (gone, changed, busy, a claim the database refused): never held, never retried.
                    _store.Suppress(delivery.Id, "Native message not sent: " + result.Reason + ".", delivery.Generation);
                }
            }
            return (deliveries.Count, off);
        }

        // Why a native message must not go out (now), or null: no native channel, an earlier attempt (first look only), stale,
        // the switches, the person's consent, quiet hours, the kind, the recipient, their access and Hidden Content (Suppression,
        // which also narrows an episodes payload to what they may be told about).
        private string? DisplayReason(in GateRead read, NotifyAlert alert, Dictionary<string, string> payload)
        {
            if (_native == null) return "Native messages aren't available on this server.";
            if (!alert.Claimed && _native.Attempted(alert.Delivery)) return "Native message: an earlier attempt's outcome is unknown; not sent again.";
            if (read.Now - alert.Queued > Ready.ReadyNativeChannel.FreshFor) return "Native message is stale (it waited while notifications were off).";
            if (!Ready.ReadyFlags.Messages(read.Config)) return "Native Ready messages are switched off.";
            if (!read.Prefs.NativeReadyMessages) return "The recipient turned native messages off.";
            if (QuietHours.EndsAt(read.Prefs, read.Now) != null) return "The recipient's quiet hours (native messages are never held).";
            // Never held: Hidden Content that can't be read now ends it too.
            return Suppression(in read, alert, payload, outbound: true, out _).Why;
        }

        // Records one delivery's outcome: sent, or failed with the next retry (none after the last).
        private void Settle(DueDelivery delivery, bool ok, string? error)
        {
            if (ok)
            {
                Interlocked.Increment(ref _sent);
                if (!_store.Finish(delivery.Id, true, null, null, _now(), delivery.Generation)) _logger?.Info($"Notifications: delivery {delivery.Id} was sent while the database was restored; the restored rows are left as they are.");
                return;
            }
            Interlocked.Increment(ref _failed);
            var attempt = delivery.Attempts + 1;
            DateTimeOffset? retry = attempt <= Backoff.Length ? _now() + Backoff[attempt - 1] : null;
            _store.Finish(delivery.Id, false, error, retry, _now(), delivery.Generation);
            _logger?.Warning($"Notifications: {delivery.Channel} delivery {delivery.Id} failed (attempt {attempt}){(retry.HasValue ? ", will retry" : ", giving up")}: {error}");
        }

        // One delivery: its awaited preparation, then the final gate, then its action by the table (the send and its settling).
        private async Task<NotifyEffect> DeliverAsync(DueDelivery delivery, CancellationToken cancellationToken)
        {
            await PrepareOutcomeAsync(delivery, cancellationToken).ConfigureAwait(false);
            var final = Final(NotifyAlert.Of(delivery));
            var effect = Act(delivery, final);
            if (effect != NotifyEffect.Act) return effect;
            var (ok, error) = await SendAsync(final, final.Message!, final.Link, delivery.Kind, cancellationToken).ConfigureAwait(false);
            Settle(delivery, ok, error);
            return NotifyEffect.Act;
        }

        /// <summary>
        /// Several alerts due at once for one person on one channel (4f round 8: prepare, then decide, then send). Every
        /// member's awaited preparation runs first; then the final gate decides each member, with no await between those
        /// decisions and the send (quiet hours, still theirs to be told, channel on: a member refused is suppressed, one that
        /// can't be decided now waits, neither is ever settled as sent); then one summary of the members it let go when
        /// <see cref="SummaryAt"/> or more are left (each settled with its outcome), else those one by one, each prepared and
        /// decided by the gate again right before its own send. Notifications switched off meanwhile: none is acted on, all
        /// stay pending. Returns how many were attempted, and whether notifications were switched off.
        /// </summary>
        private async Task<(int Attempted, bool Off)> DeliverSummaryAsync(IReadOnlyList<DueDelivery> deliveries, CancellationToken cancellationToken)
        {
            foreach (var delivery in deliveries)
            {
                cancellationToken.ThrowIfCancellationRequested();
                await PrepareOutcomeAsync(delivery, cancellationToken).ConfigureAwait(false);
            }

            var going = new List<DueDelivery>();
            NotifyFinal? first = null;
            foreach (var delivery in deliveries)
            {
                var final = Final(NotifyAlert.Of(delivery));
                switch (Act(delivery, final))
                {
                    case NotifyEffect.Leave:
                        return (0, true);
                    case NotifyEffect.Act:
                        going.Add(delivery);
                        first ??= final;
                        break;
                    case NotifyEffect.Postpone:
                    case NotifyEffect.Suppress:
                        // Acted on by the table already.
                        break;
                }
            }

            if (going.Count < SummaryAt)
            {
                // One by one, each decided again right before its own send (from the settings and Hidden Content as they are
                // then: a send takes a while, and what the person hid or changed meanwhile counts).
                foreach (var delivery in going)
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    if (await DeliverAsync(delivery, cancellationToken).ConfigureAwait(false) == NotifyEffect.Leave) return (deliveries.Count, true);
                }

                return (deliveries.Count, false);
            }

            var result = await SendAsync(first!, NotifyTexts.Summary(going.Count), first!.Home, NotifyKind.Ready, cancellationToken).ConfigureAwait(false);
            foreach (var delivery in going) Settle(delivery, result.Ok, result.Error);
            return (deliveries.Count, false);
        }

        /// <summary>
        /// Why the alert must not be told any more (or must wait), or nothing, as the final gate reads it: the recipient switched
        /// this kind of alert off (Ready, new episodes, declined, OK'd); the request it is about moved on (<see cref="Request"/>);
        /// the recipient is gone or disabled; an administrators' alert (paths, instance names, household requests) for someone
        /// who is no longer an administrator, or (a delivery, <paramref name="outbound"/>) switched those alerts to phone and
        /// e-mail off; an ask waiting for an OK (or a reminder) whose title the administrator can no longer see; a Ready or
        /// new-episodes alert, or a request's outcome (declined, approved), the recipient may not be told about now
        /// (<see cref="AlertCheck.Decide"/>: a title they can no longer open or have hidden, an episodes payload narrowed to what
        /// is left; Hidden Content or the title's copies that can't be read now: wait).
        /// </summary>
        private AlertVerdict Suppression(in GateRead read, NotifyAlert alert, Dictionary<string, string> payload, bool outbound, out string? itemId)
        {
            itemId = alert.ItemId;
            var prefs = read.Prefs;
            var kindOff = alert.Kind switch
            {
                NotifyKind.Ready => !prefs.Ready,
                NotifyKind.Episodes => !prefs.Episodes,
                NotifyKind.Declined => !prefs.Declined,
                NotifyKind.Approved => !prefs.Approved,
                _ => false,
            };
            if (kindOff) return new AlertVerdict("The recipient switched these alerts off.");
            if (Request(alert) is { Why: not null } moved) return moved;
            if (_users == null) return default;
            if (!_users.IsActive(alert.User)) return new AlertVerdict("The recipient no longer exists or is disabled.");
            if (NotifyKind.IsAdminKind(alert.Kind))
            {
                if (!_users.Admins().Contains(alert.User)) return new AlertVerdict("The recipient is no longer an administrator.");
                if (alert.Kind is NotifyKind.Approval or NotifyKind.Remind && !NotificationService.MaySeeAsk(_policy, alert.User, alert.TitleKey, payload, _ledger, alert.EventKey))
                    return new AlertVerdict("The recipient can no longer see this title.");
                return !outbound || prefs.AdminAlerts ? default : new AlertVerdict("The recipient switched administrators' alerts to phone and e-mail off.");
            }
            if (_view == null || alert.Kind is not (NotifyKind.Ready or NotifyKind.Episodes or NotifyKind.Declined or NotifyKind.Approved)) return default;
            if (_view.Viewer(alert.User) is not { } viewer) return new AlertVerdict("The recipient no longer exists or is disabled.");
            return Check(alert.User, viewer).Decide(alert.Kind, alert.TitleKey, payload, ref itemId, alert.EventKey);
        }

        /// <summary>The event key prefix of a Jellyfin Enhanced ask waiting for an OK (followed by the request id).</summary>
        internal const string AskEventPrefix = "approval|je|";

        /// <summary>
        /// The request an alert is about, as it is now, by the alert's event key (4f round 9: the ledger's state is one of the
        /// gate's inputs): an OK of a Jellyfin Enhanced request that isn't OK'd any more (back to waiting, declined, cancelled,
        /// removed), a decline of one that isn't declined any more, an ask that no longer waits for an OK; a Seerr request whose
        /// decline or ask Seerr's list no longer shows as such (or that belongs to another Seerr server). The ledger or Seerr's
        /// list not readable now: wait. An alert about no request: nothing to say.
        /// </summary>
        private AlertVerdict Request(NotifyAlert alert)
        {
            const string Unreadable = "The request can't be read now.";
            if (alert.EventKey is not { } key) return default;
            var je = key.StartsWith(ApprovedEventPrefix, StringComparison.Ordinal) ? ApprovedEventPrefix
                : key.StartsWith(DeclinedEventPrefix, StringComparison.Ordinal) ? DeclinedEventPrefix
                : key.StartsWith(AskEventPrefix, StringComparison.Ordinal) ? AskEventPrefix : null;
            if (je != null)
            {
                if (_ledger == null) return default;
                if (!_ledger.Database.Available) return new AlertVerdict(Unreadable, true);
                var want = _ledger.Find(key[je.Length..]);
                if (je == ApprovedEventPrefix)
                    return want is { Status: "queued" or "sent" or "stale" or "fulfilled" } ? default : new AlertVerdict(NoLongerOkd(want?.Status, want?.Reason));
                if (je == DeclinedEventPrefix) return want is { Status: "declined" } ? default : new AlertVerdict("The request isn't declined any more.");
                return want is { Status: "pending", Reason: "awaiting_approval" or "over_quota" } ? default : new AlertVerdict("The request isn't waiting for an OK any more.");
            }

            // Seerr's own requests: "declined|<server>|<id>" told to the requester, "approval|<server>|<id>" to administrators.
            var parts = key.Split('|');
            if (_requests == null || parts.Length != 3 || !(alert.Kind == NotifyKind.Declined && parts[0] == "declined" || alert.Kind == NotifyKind.Approval && parts[0] == "approval")) return default;
            if (!_requests.Active || !_requests.Loaded) return new AlertVerdict(Unreadable, true);
            var (source, all, floor) = _requests.Current;
            if (source == null) return new AlertVerdict(Unreadable, true);
            var server = source.Length > 8 ? source[..8] : source;
            if (parts[1] != server || !int.TryParse(parts[2], NumberStyles.None, CultureInfo.InvariantCulture, out var id)) return new AlertVerdict("The request belongs to another Seerr server.");
            var wanted = alert.Kind == NotifyKind.Declined ? SeerrRequestStatus.Declined : SeerrRequestStatus.Pending;
            if (all.FirstOrDefault(r => r.Id == id) is { } request)
                return request.Status == wanted ? default : new AlertVerdict(alert.Kind == NotifyKind.Declined ? "The request isn't declined any more." : "The request isn't waiting for an OK any more.");
            // Below the list's floor a request not held is unknown, not gone.
            return floor is int below && id < below ? new AlertVerdict(Unreadable, true) : new AlertVerdict("The request was removed.");
        }

        /// <summary>
        /// Why an OK'd request's "OK'd" alert isn't sent any more, as the request is now (4f round 6, Q-4FFIX5-4): back to
        /// waiting (it couldn't go to Sonarr or Radarr: no instance, its add defaults no longer valid, ...), declined, cancelled
        /// or gone.
        /// </summary>
        internal static string NoLongerOkd(string? status, string? reason) => status switch
        {
            null => "The request was removed since it was OK'd.",
            "pending" => "The request is waiting again since it was OK'd: it couldn't be sent to Sonarr or Radarr"
                         + (string.IsNullOrEmpty(reason) ? "." : " (" + reason + ")."),
            "declined" => "The request was declined since it was OK'd.",
            "cancelled" => "The request was cancelled since it was OK'd.",
            _ => "The request isn't OK'd any more (" + status + ").",
        };

        /// <summary>
        /// The one decision whether a recipient may be told about a Ready or new-episodes alert, or their request's outcome, now
        /// (D46, D53), for the alert's producer, every send (TV message, ntfy, e-mail, a summary's parts) and every bell read.
        /// Reads the recipient's Hidden Content once (through the Ready channel's reader; without it nothing counts as hidden).
        /// </summary>
        internal AlertCheck Check(Guid user, StatusViewer viewer) => new(this, user, viewer);

        /// <summary>A verdict on one alert: <see cref="Why"/> null to tell it; <see cref="Wait"/> when the recipient's Hidden Content (or the title's copies) can't be read now.</summary>
        /// <param name="Why">Why the alert may not be told now, or null.</param>
        /// <param name="Wait">True when only unreadable Hidden Content stops it: never sent, looked at again later.</param>
        internal readonly record struct AlertVerdict(string? Why, bool Wait = false);

        /// <summary>
        /// Whether one recipient may be told about alerts now, decided for the whole title from the current state: they can
        /// open it (the item, or for a batch each episode), and their Hidden Content, read once and given every physical copy
        /// of the title, hides neither the title (a title-level rule on any copy) nor the item, its version or its series. Rules
        /// that can't be read are never "nothing hidden".
        /// </summary>
        internal sealed class AlertCheck
        {
            private readonly NotifyDispatcher _owner;
            private readonly Guid _user;
            private readonly StatusViewer _viewer;
            private readonly Dictionary<string, Func<Guid, bool>> _titles = new(StringComparer.Ordinal);
            private bool _read;
            private Ready.ReadyHides? _rules;

            internal AlertCheck(NotifyDispatcher owner, Guid user, StatusViewer viewer)
            {
                _owner = owner;
                _user = user;
                _viewer = viewer;
            }

            /// <summary>
            /// The recipient's Hidden Content as a check of items of one title (true: hidden), for the whole title (every
            /// physical copy of it, complete); null when their rules, or the title's copies, can't be read now.
            /// </summary>
            public Func<Guid, bool>? Hides(string? titleKey)
            {
                if (!_read)
                {
                    _rules = _owner._native == null ? Ready.ReadyHides.None : _owner._native.Rules(_user);
                    _read = true;
                }
                if (_rules is not { } rules) return null;
                if (_owner._native == null) return _ => false;
                var key = titleKey ?? string.Empty;
                if (_titles.TryGetValue(key, out var check)) return check;
                if (_owner._native.TitleCheck(_viewer, rules, titleKey) is not { } made) return null;
                _titles[key] = made;
                return made;
            }

            /// <summary>
            /// The one outcome-alert policy (4f round 6): whether the requester may be told now that their request for a title was
            /// declined or OK'd, from the title's current visibility to them. A title in the library (any physical copy, every
            /// copy read, complete): they can open one of its copies now (library access and parental limits, as Jellyfin decides
            /// it for them). A title not in the library: the request policy's visibility (the libraries it would land in, parental
            /// limits on its rating; <see cref="Requests.IRequestPolicy.Evaluate"/>, the rule the Requests page's cards follow).
            /// Either way their Hidden Content hides neither the title (any key, any copy) nor anything of it. Copies or rules that
            /// can't be read now: wait (never "visible"). The request policy is asked with the alert's whole input
            /// (<see cref="OutcomeInput"/>: edition, part, routing), and a rating not verified yet for a parental limit is evidence
            /// to prepare (wait), never a refusal (4f round 7). Used at production, at every send and on every bell read.
            /// </summary>
            public AlertVerdict Outcome(string? titleKey, IReadOnlyDictionary<string, string> payload, string? eventKey)
            {
                const string Unreadable = "The recipient's Hidden Content or the title's copies can't be read now.";
                if (TitleKey.Parse(titleKey) is { } key && _owner._view is { } view)
                {
                    var aliases = _owner._aliases?.Of(key) ?? (IReadOnlyList<TitleKey>)Array.Empty<TitleKey>();
                    if (view.TitleCopyIds(key.Title, aliases) is not { } copies) return new AlertVerdict(Unreadable, true);
                    if (copies.Count > 0)
                    {
                        // In the library: the recipient's current access to it (libraries, parental limits), copy by copy.
                        if (!copies.Any(copy => view.Resolve(copy, _viewer) != null)) return new AlertVerdict("The recipient can no longer open this title.");
                    }
                    else if (_owner._policy is { } policy)
                    {
                        // Not in the library: what the request policy lets them see of a title nobody has yet, for the request as
                        // it is (its edition and its stored target decide the instance, and so the libraries, it lands in).
                        if (_owner.OutcomeRequest(key, eventKey, payload) is not { } request) return new AlertVerdict("The request can't be read now.", true);
                        var facts = request.Target is { } target ? policy.Evaluate(_user, request.Input, target) : policy.Evaluate(_user, request.Input);
                        if (!facts.Visible)
                        {
                            return facts.VisibilityUnknown
                                ? new AlertVerdict("The title's rating isn't verified yet for the recipient's parental limits.", true)
                                : new AlertVerdict("The recipient may not see this title (library access or parental limits).");
                        }
                    }
                }

                if (Hides(titleKey) is not { } hidden) return new AlertVerdict(Unreadable, true);
                return hidden(Guid.Empty) ? new AlertVerdict("The recipient hid this title (Hidden Content).") : default;
            }

            /// <summary>
            /// Whether an alert about a title may be told now (other kinds: yes). Ready and new-episodes alerts: the recipient
            /// can open it and hasn't hidden it; a batch of new episodes (its <c>episodeItems</c>) is narrowed in
            /// <paramref name="payload"/> to the episodes the recipient can open and hasn't hidden, its count, seasons and wording
            /// set again from what is left: one left is that episode (and <paramref name="itemId"/> becomes it), fewer than the
            /// batch is never "the whole season". A request's outcome told to the requester (declined, approved): <see cref="Outcome"/>.
            /// Synchronous.
            /// </summary>
            public AlertVerdict Decide(string kind, string? titleKey, Dictionary<string, string> payload, ref string? itemId, string? eventKey = null)
            {
                if (kind is NotifyKind.Declined or NotifyKind.Approved) return Outcome(titleKey, payload, eventKey);
                if (kind is not (NotifyKind.Ready or NotifyKind.Episodes) || _owner._view is not { } view) return default;
                List<NotifyEpisode>? episodes = null;
                List<NotifyEpisode>? open = null;
                var item = Guid.Empty;
                if (kind == NotifyKind.Episodes && payload.TryGetValue("episodeItems", out var json))
                {
                    try { episodes = JsonSerializer.Deserialize<List<NotifyEpisode>>(json, PayloadJson); }
                    catch (JsonException) { episodes = null; }
                    open = episodes?.Where(e => e.ItemId != Guid.Empty && view.Resolve(e.ItemId, _viewer) != null).ToList();
                    if (open is not { Count: > 0 }) return new AlertVerdict("The recipient can no longer open these episodes.");
                }
                else if (Guid.TryParse(itemId, out item) && item != Guid.Empty)
                {
                    if (view.Resolve(item, _viewer) == null) return new AlertVerdict("The recipient can no longer open this title.");
                }
                else if (TitleKey.Parse(titleKey) is not { } key || !view.Copies(key, _viewer, _owner._aliases?.Of(key)).Any(c => c.Visible))
                {
                    return new AlertVerdict("The recipient can no longer open this title.");
                }

                if (Hides(titleKey) is not { } hidden) return new AlertVerdict("The recipient's Hidden Content or the title's copies can't be read now.", true);
                if (open == null) return hidden(item) ? new AlertVerdict("The recipient hid this title (Hidden Content).") : default;
                var visible = open.Where(e => !hidden(e.ItemId))
                    .DistinctBy(e => (e.Season, e.Episode)).OrderBy(e => e.Season).ThenBy(e => e.Episode).ToList();
                if (visible.Count == 0) return new AlertVerdict("The recipient hid these episodes (Hidden Content).");
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
                    // Not every episode of the batch is still visible: don't announce it as a complete season.
                    payload["mode"] = "many";
                    payload.Remove("season");
                    payload.Remove("episode");
                }
                return default;
            }
        }

        /// <summary>Why a channel can't carry the delivery now (switched off or not set up, by the administrator or the user), or null.</summary>
        private static string? ChannelOff(in GateRead read, string channel)
        {
            var config = read.Config;
            var prefs = read.Prefs;
            return channel switch
            {
                NotifyChannel.Ntfy when !NotifyEndpoints.NtfyReady(config) => "Phone alerts (ntfy) are switched off or have no server.",
                NotifyChannel.Ntfy when !prefs.Ntfy || !NotifyEndpoints.IsTopic(prefs.NtfyTopic) => "The user turned phone alerts off or has no topic.",
                NotifyChannel.Ntfy => null,
                NotifyChannel.Email when !NotifyEndpoints.EmailReady(config) => "E-mail alerts are switched off or have no mail server.",
                NotifyChannel.Email when !prefs.Email || string.IsNullOrEmpty(prefs.EmailAddress) => "The user turned e-mail off or has no verified address.",
                NotifyChannel.Email => null,
                _ => "Unknown channel.",
            };
        }

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
            NotifyKind.Approved => new[] { "white_check_mark" },
            NotifyKind.Approval => new[] { "raising_hand" },
            NotifyKind.InstanceDown or NotifyKind.LowDisk or NotifyKind.StuckDigest or NotifyKind.Attention => new[] { "warning" },
            NotifyKind.Remind => new[] { "bell" },
            _ => new[] { "jellyfish" },
        };

        private static int Priority(string kind) => kind is NotifyKind.InstanceDown or NotifyKind.Approval or NotifyKind.Remind ? 4 : 3;
    }
}
