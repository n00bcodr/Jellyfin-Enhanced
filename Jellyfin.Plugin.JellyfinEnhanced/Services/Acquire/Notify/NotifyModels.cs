using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text.Json.Serialization;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Notify
{
    /// <summary>The switches behind notifications ("Requests &amp; downloads", phase 2).</summary>
    public static class NotifyFlags
    {
        /// <summary>Master switch, phase 1, phase 2 and the notifications switch are all on.</summary>
        public static bool Enabled(PluginConfiguration? c)
            => c is { ArrIntegrationEnabled: true, ArrPhase1Enabled: true, ArrPhase2Enabled: true, ArrNotificationsEnabled: true };
    }

    /// <summary>What a notification is about.</summary>
    public static class NotifyKind
    {
        /// <summary>Your request (or a title you follow) is ready to watch.</summary>
        public const string Ready = "ready";

        /// <summary>New episodes of a series you follow or asked for (batched).</summary>
        public const string Episodes = "episodes";

        /// <summary>Your request was declined.</summary>
        public const string Declined = "declined";

        /// <summary>Admin: a new request waits for an OK.</summary>
        public const string Approval = "approval";

        /// <summary>Admin: an instance has been unreachable for a while.</summary>
        public const string InstanceDown = "instance_down";

        /// <summary>Admin: an instance answers again.</summary>
        public const string InstanceUp = "instance_up";

        /// <summary>Admin: a root folder is low on space.</summary>
        public const string LowDisk = "low_disk";

        /// <summary>Admin: downloads that need attention for a long time (daily digest).</summary>
        public const string StuckDigest = "stuck_digest";

        /// <summary>Admin: someone in the household asked you to look at a stuck title.</summary>
        public const string Remind = "remind";

        /// <summary>
        /// Admin: a Needs attention row that wants someone now (the admin tools' list): a download the
        /// arr can't import without a manual import, or a request Seerr OK'd that no Sonarr/Radarr has.
        /// The payload's <c>code</c> says which.
        /// </summary>
        public const string Attention = "attention";

        /// <summary>A test message the user (or an admin) sent.</summary>
        public const string Test = "test";

        /// <summary>Kinds only administrators receive.</summary>
        public static bool IsAdminKind(string kind)
            => kind is Approval or InstanceDown or InstanceUp or LowDisk or StuckDigest or Remind or Attention;

        /// <summary>All the kinds only administrators receive.</summary>
        public static readonly IReadOnlyList<string> AdminKinds = new[] { Approval, InstanceDown, InstanceUp, LowDisk, StuckDigest, Remind, Attention };
    }

    /// <summary>Outbound channels (the in-app inbox needs no delivery).</summary>
    public static class NotifyChannel
    {
        /// <summary>ntfy push to the user's topic on the administrator's ntfy server.</summary>
        public const string Ntfy = "ntfy";

        /// <summary>E-mail through the administrator's SMTP server to the user's verified address.</summary>
        public const string Email = "email";
    }

    /// <summary>
    /// One user's notification settings (the "Requests &amp; alerts" panel). Stored server-side in
    /// the Requests &amp; downloads database, never in the user-editable settings files.
    /// </summary>
    public sealed class NotifyPrefs
    {
        /// <summary>Show a toast on open pages when something arrives (never during playback).</summary>
        public bool Toasts { get; set; } = true;

        /// <summary>Tell me when my requests or the titles I follow are ready.</summary>
        public bool Ready { get; set; } = true;

        /// <summary>Tell me about new episodes of series I follow or asked for.</summary>
        public bool Episodes { get; set; } = true;

        /// <summary>Tell me when a request of mine is declined.</summary>
        public bool Declined { get; set; } = true;

        /// <summary>Administrators: send admin alerts (approvals, outages, low disk, stuck digest, reminders) to my phone/e-mail too.</summary>
        public bool AdminAlerts { get; set; } = true;

        /// <summary>Follow what I request automatically.</summary>
        public bool AutoFollowRequests { get; set; } = true;

        /// <summary>Phone alerts through ntfy.</summary>
        public bool Ntfy { get; set; }

        /// <summary>The user's ntfy topic (on the administrator's server).</summary>
        public string? NtfyTopic { get; set; }

        /// <summary>The topic was set by an administrator.</summary>
        public bool NtfyTopicByAdmin { get; set; }

        /// <summary>E-mail alerts.</summary>
        public bool Email { get; set; }

        /// <summary>The user's verified e-mail address (only ever set after the code check).</summary>
        public string? EmailAddress { get; set; }

        /// <summary>Phone and e-mail texts don't name the title ("Something you follow is ready").</summary>
        public bool HideTitles { get; set; }

        /// <summary>Hold phone and e-mail alerts during quiet hours (sent when they end).</summary>
        public bool QuietHours { get; set; }

        /// <summary>Quiet hours start (HH:mm, the user's local time).</summary>
        public string QuietFrom { get; set; } = "22:00";

        /// <summary>Quiet hours end (HH:mm).</summary>
        public string QuietTo { get; set; } = "07:00";

        /// <summary>The user's time zone (IANA name from their browser).</summary>
        public string? TimeZone { get; set; }

        /// <summary>The browser's UTC offset in minutes when the zone name is unknown to the server.</summary>
        public int? UtcOffsetMinutes { get; set; }

        /// <summary>A copy.</summary>
        public NotifyPrefs Clone() => (NotifyPrefs)MemberwiseClone();
    }

    /// <summary>One follow (or a mute of an automatic follow).</summary>
    /// <param name="UserId">Jellyfin user.</param>
    /// <param name="Key">Title key (movie, series or season).</param>
    /// <param name="Kind"><c>title</c> (a movie), <c>episodes</c> (every new episode of a series) or <c>season</c>.</param>
    /// <param name="Muted">True: "don't tell me" for a title followed automatically (an own request).</param>
    /// <param name="CreatedAt">When.</param>
    public sealed record FollowRow(Guid UserId, string Key, string Kind, bool Muted, DateTimeOffset CreatedAt);

    /// <summary>A notification in a user's inbox.</summary>
    public sealed class InboxItem
    {
        /// <summary>Id (grows with time).</summary>
        [JsonPropertyName("id")] public long Id { get; init; }

        /// <summary>What it is about (<see cref="NotifyKind"/>).</summary>
        [JsonPropertyName("kind")] public string Kind { get; init; } = string.Empty;

        /// <summary>The title key, when it is about a title.</summary>
        [JsonPropertyName("key")] public string? Key { get; init; }

        /// <summary>The Jellyfin item to open or play, when there is one the user can open.</summary>
        [JsonPropertyName("itemId")] public string? ItemId { get; init; }

        /// <summary>When (UTC).</summary>
        [JsonPropertyName("createdAt")] public DateTimeOffset CreatedAt { get; init; }

        /// <summary>Read.</summary>
        [JsonPropertyName("read")] public bool Read { get; init; }

        /// <summary>Text parameters (title, year, poster path, counts, …), already filtered for the recipient.</summary>
        [JsonPropertyName("params")] public IReadOnlyDictionary<string, string> Params { get; init; } = new Dictionary<string, string>();

        /// <summary>Where it leads inside Jellyfin (a details page, or the Requests page).</summary>
        [JsonPropertyName("link")] public string? Link { get; init; }
    }

    /// <summary>A delivery that is due.</summary>
    /// <remarks><paramref name="Generation"/>: the database generation the row was read under (a restore makes its id meaningless).</remarks>
    internal sealed record DueDelivery(long Id, long NotificationId, Guid UserId, string Channel, int Attempts, string Kind, string? TitleKey, string? ItemId, string Payload, DateTimeOffset CreatedAt, long Generation = 0);

    /// <summary>An episode number and its visible file at batch flush, rechecked at delivery.</summary>
    internal sealed record NotifyEpisode(Guid ItemId, int Season, int Episode);

    /// <summary>A failed delivery as administrators see it.</summary>
    public sealed class DeliveryFailure
    {
        /// <summary>Recipient.</summary>
        [JsonPropertyName("userId")] public string UserId { get; init; } = string.Empty;

        /// <summary>Recipient name.</summary>
        [JsonPropertyName("user")] public string? User { get; init; }

        /// <summary>Channel.</summary>
        [JsonPropertyName("channel")] public string Channel { get; init; } = string.Empty;

        /// <summary>Notification kind.</summary>
        [JsonPropertyName("kind")] public string Kind { get; init; } = string.Empty;

        /// <summary>Attempts made.</summary>
        [JsonPropertyName("attempts")] public int Attempts { get; init; }

        /// <summary>The last error (no secrets).</summary>
        [JsonPropertyName("error")] public string? Error { get; init; }

        /// <summary>Gave up (no more retries).</summary>
        [JsonPropertyName("final")] public bool Final { get; init; }

        /// <summary>When it was queued.</summary>
        [JsonPropertyName("at")] public DateTimeOffset At { get; init; }
    }

    /// <summary>Small helpers for stored values.</summary>
    internal static class NotifyValues
    {
        public static long Ms(DateTimeOffset at) => at.ToUnixTimeMilliseconds();

        public static DateTimeOffset At(long ms) => DateTimeOffset.FromUnixTimeMilliseconds(ms);

        public static string Id(Guid user) => user.ToString("N", CultureInfo.InvariantCulture);
    }
}
