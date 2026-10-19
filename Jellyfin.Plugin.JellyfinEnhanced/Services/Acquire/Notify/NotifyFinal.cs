using System;
using System.Collections.Generic;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Notify
{
    /// <summary>
    /// An alert as the final gate (<see cref="NotifyDispatcher.Final"/>) is asked about it: its identifiers only (who, what kind,
    /// which title and item, which event, what it says). Never a configuration, preferences or evidence read by the caller:
    /// the gate reads all of that itself when it is called (4f round 9).
    /// </summary>
    /// <param name="User">The recipient.</param>
    /// <param name="Kind">The kind of alert (<see cref="NotifyKind"/>).</param>
    /// <param name="TitleKey">The title it is about, or null.</param>
    /// <param name="ItemId">The Jellyfin item it links to, or null.</param>
    /// <param name="EventKey">The event (once per person and event; it names the request an outcome or an ask is about).</param>
    /// <param name="Payload">What it says (the gate narrows a copy of it to what the person may be told).</param>
    internal sealed record NotifyAlert(Guid User, string Kind, string? TitleKey, string? ItemId, string? EventKey, IReadOnlyDictionary<string, string> Payload)
    {
        /// <summary>The channel a delivery goes out on; null for the notification itself (its bell row and its deliveries).</summary>
        public string? Channel { get; init; }

        /// <summary>A delivery's id (a native message: an earlier attempt's outcome unknown means never again).</summary>
        public long Delivery { get; init; }

        /// <summary>When the delivery was queued (how long it may wait for evidence; a native message's freshness).</summary>
        public DateTimeOffset Queued { get; init; }

        /// <summary>When what it tells happened (the notice, the arrival): longer ago than the catch-up limit is never told. Null: no limit.</summary>
        public DateTimeOffset? Since { get; init; }

        /// <summary>A native message looked at inside its claim, right before the host send (its own attempt is claimed by then).</summary>
        public bool Claimed { get; init; }

        /// <summary>A delivery as the gate is asked about it.</summary>
        internal static NotifyAlert Of(DueDelivery delivery)
            => new(delivery.UserId, delivery.Kind, delivery.TitleKey, delivery.ItemId, delivery.EventKey, NotifyDispatcher.Payload(delivery.Payload))
            {
                Channel = delivery.Channel,
                Delivery = delivery.Id,
                Queued = delivery.CreatedAt,
            };
    }

    /// <summary>What the final gate decided.</summary>
    internal enum NotifyVerdict
    {
        /// <summary>Notifications are switched off as a whole: nothing may be done; everything stays as it is until they are back.</summary>
        Off,

        /// <summary>It may be told now (the plan says how).</summary>
        Send,

        /// <summary>Not now: quiet hours, or evidence that can't be read now (looked at again at <see cref="NotifyFinal.Until"/>).</summary>
        Wait,

        /// <summary>Never (for this alert): the recipient may not be told (<see cref="NotifyFinal.Why"/>).</summary>
        Refuse,
    }

    /// <summary>
    /// The final gate's verdict on one alert (4f round 9), with everything the action needs: what it says (narrowed), its link,
    /// and for a send the configuration and preferences the gate read (the transport: server, topic, address). Made only by
    /// the gate; used right away, with no await before the action (the network send itself excepted).
    /// </summary>
    internal sealed class NotifyFinal
    {
        private NotifyFinal(NotifyVerdict verdict, NotifyAlert alert, DateTimeOffset at, string? why, DateTimeOffset? until)
        {
            Verdict = verdict;
            Alert = alert;
            At = at;
            Why = why;
            Until = until;
        }

        /// <summary>The verdict.</summary>
        public NotifyVerdict Verdict { get; }

        /// <summary>The alert it is about.</summary>
        public NotifyAlert Alert { get; }

        /// <summary>When it was decided (the gate's clock).</summary>
        public DateTimeOffset At { get; }

        /// <summary>Why it may not be told (now), or null.</summary>
        public string? Why { get; }

        /// <summary>When to look again (quiet hours' end, or the next look at the evidence), for <see cref="NotifyVerdict.Wait"/>.</summary>
        public DateTimeOffset? Until { get; }

        /// <summary>True when it may be told now.</summary>
        public bool Sends => Verdict == NotifyVerdict.Send;

        /// <summary>What it says, narrowed to what the recipient may be told (an episodes batch to the episodes left).</summary>
        public IReadOnlyDictionary<string, string> Payload { get; private init; } = new Dictionary<string, string>();

        /// <summary>The item it links to (one episode left of a batch: that episode).</summary>
        public string? ItemId { get; private init; }

        /// <summary>A send: the message, rendered from the recipient's settings as the gate read them.</summary>
        public NotifyMessage? Message { get; private init; }

        /// <summary>A send: the deep link for this alert, and the household's link for a summary of several.</summary>
        public string? Link { get; private init; }

        /// <summary>A send: the link a summary of several alerts goes to (the bell's page).</summary>
        public string? Home { get; private init; }

        /// <summary>The notification itself: the deliveries it gets, each with when it is due.</summary>
        public IReadOnlyList<(string Channel, DateTimeOffset At)> Deliveries { get; private init; } = Array.Empty<(string, DateTimeOffset)>();

        /// <summary>A send: the configuration the gate read (the server, its token, the mail server).</summary>
        internal PluginConfiguration? Config { get; private init; }

        /// <summary>A send: the recipient's preferences the gate read (their topic and address).</summary>
        internal NotifyPrefs? Prefs { get; private init; }

        internal static NotifyFinal Off(NotifyAlert alert, DateTimeOffset at) => new(NotifyVerdict.Off, alert, at, "Notifications are switched off.", null);

        internal static NotifyFinal Wait(NotifyAlert alert, DateTimeOffset at, string? why, DateTimeOffset until) => new(NotifyVerdict.Wait, alert, at, why, until);

        internal static NotifyFinal Refuse(NotifyAlert alert, DateTimeOffset at, string why) => new(NotifyVerdict.Refuse, alert, at, why, null);

        /// <summary>A delivery may go out now, with its message and link, on the transport the gate read.</summary>
        internal static NotifyFinal Send(NotifyAlert alert, DateTimeOffset at, IReadOnlyDictionary<string, string> payload, string? itemId, NotifyMessage message, string? link, string? home, PluginConfiguration config, NotifyPrefs prefs)
            => new(NotifyVerdict.Send, alert, at, null, null) { Payload = payload, ItemId = itemId, Message = message, Link = link, Home = home, Config = config, Prefs = prefs };

        /// <summary>The notification may be made now, with its deliveries.</summary>
        internal static NotifyFinal Tell(NotifyAlert alert, DateTimeOffset at, IReadOnlyDictionary<string, string> payload, string? itemId, IReadOnlyList<(string Channel, DateTimeOffset At)> deliveries)
            => new(NotifyVerdict.Send, alert, at, null, null) { Payload = payload, ItemId = itemId, Deliveries = deliveries };
    }
}
