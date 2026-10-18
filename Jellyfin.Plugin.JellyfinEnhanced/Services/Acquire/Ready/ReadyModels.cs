using System;
using System.Collections.Generic;
using System.Globalization;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Automation;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Notify;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Ready
{
    /// <summary>The switches behind the Ready playlist and native Ready messages ("Requests &amp; downloads", phase 4f).</summary>
    public static class ReadyFlags
    {
        /// <summary>
        /// The private Ready playlist is in effect: the master switch, phase 1, phase 4, phase 3 and its own switch. Not
        /// notifications (a person can have the playlist with notifications off) and not Native Poster Tags.
        /// </summary>
        public static bool Playlist(PluginConfiguration? c)
            => AutomationFlags.Phase4(c) && c!.ArrPhase3Enabled && c.ArrPhase4ReadyPlaylistEnabled;

        /// <summary>
        /// Native Ready messages are in effect: notifications (master, phase 1, phase 2 and the notifications switch), phase
        /// 4 and its own switch. Not the playlist, phase 3 or Native Poster Tags.
        /// </summary>
        public static bool Messages(PluginConfiguration? c)
            => NotifyFlags.Enabled(c) && AutomationFlags.Phase4(c) && c!.ArrPhase4ReadyMessagesEnabled;

        /// <summary>Days an entry stays in the Ready playlist unless watched first (1–90, default 30).</summary>
        public static int RetentionDays(PluginConfiguration? c) => Math.Clamp(c?.ArrReadyRetentionDays ?? 30, 1, 90);
    }

    /// <summary>Where a person's Ready playlist stands (<c>ready_playlists.state</c>).</summary>
    public static class ReadyState
    {
        /// <summary>Never opted in, or opted out (an existing playlist is kept as it is).</summary>
        public const string Off = "off";

        /// <summary>Opted in; Jellyfin Enhanced keeps the playlist up to date.</summary>
        public const string Active = "active";

        /// <summary>The person deleted the playlist in Jellyfin: not made again until they turn it on again.</summary>
        public const string Deleted = "deleted";

        /// <summary>The person removed it from their Jellyfin Enhanced settings: not made again until they turn it on again.</summary>
        public const string Removed = "removed";

        /// <summary>A JE backup was restored: nothing changes until the person turns it on again (D47).</summary>
        public const string Renew = "renew";

        /// <summary>The playlist was shared, made public or changed owner: no more updates until it is private again.</summary>
        public const string Privacy = "privacy";

        /// <summary>True for a state that needs the person to turn the playlist on again.</summary>
        public static bool NeedsRenewal(string state) => state is Deleted or Removed or Renew;
    }

    /// <summary>What happened to one Ready entry (<c>ready_entries.disposition</c>).</summary>
    public static class ReadyDisposition
    {
        /// <summary>In the playlist (or waiting for its version to be insertable).</summary>
        public const string Ready = "ready";

        /// <summary>Watched: never put back for this interest.</summary>
        public const string Watched = "watched";

        /// <summary>Its time ran out: never put back for this interest.</summary>
        public const string Expired = "expired";

        /// <summary>True for a terminal disposition (only a new interest brings the content back).</summary>
        public static bool Terminal(string disposition) => disposition is Watched or Expired;
    }

    /// <summary>Where an interest comes from.</summary>
    public static class ReadyInterestKind
    {
        /// <summary>A request in Jellyfin Enhanced's request ledger (a list or import want included).</summary>
        public const string Request = "request";

        /// <summary>A Seerr request linked to the person.</summary>
        public const string Seerr = "seerr";

        /// <summary>An explicit follow (Notify me).</summary>
        public const string Follow = "follow";
    }

    /// <summary>
    /// One personal interest a Ready entry can come from: whose, which title and scope, which edition (a generic follow
    /// takes any copy, standard first), and since when. Standard and 4K interests stay separate.
    /// </summary>
    /// <param name="Id">Stable id (<c>w:</c> want, <c>s:</c> Seerr request, <c>f:</c> follow).</param>
    /// <param name="UserId">The person.</param>
    /// <param name="Kind"><see cref="ReadyInterestKind"/>.</param>
    /// <param name="Title">Movie or series key (no season/episode).</param>
    /// <param name="FourK">A 4K request (needs a 4K source).</param>
    /// <param name="AnyEdition">A generic follow: any copy, a known standard one first, then 4K.</param>
    /// <param name="WholeTitle">The whole movie or series.</param>
    /// <param name="Seasons">Whole seasons asked for or followed.</param>
    /// <param name="Episodes">Exact episodes.</param>
    /// <param name="Since">When the interest began (UTC): content that arrived before it isn't "ready" for it.</param>
    public sealed record ReadyInterest(string Id, Guid UserId, string Kind, TitleKey Title, bool FourK, bool AnyEdition, bool WholeTitle,
        IReadOnlyList<int> Seasons, IReadOnlyList<(int Season, int Episode)> Episodes, DateTime Since)
    {
        /// <summary>The edition the interest asks for (wire/storage name).</summary>
        public string EditionName => AnyEdition ? "any" : FourK ? "4k" : "standard";
    }

    /// <summary>
    /// One selected entry: the interest it is for, the content coordinate (a movie, or an episode), the exact version to
    /// insert (<see cref="PlayableItemId"/>, never a series, season or placeholder) and when it became ready.
    /// </summary>
    /// <param name="Interest">The interest.</param>
    /// <param name="Part"><c>m</c> for a movie, <c>s{S}e{E}</c> for an episode.</param>
    /// <param name="LogicalItemId">The movie or episode item.</param>
    /// <param name="SeriesId">The episode's physical series item (null for a movie).</param>
    /// <param name="PlayableItemId">The exact version item.</param>
    /// <param name="Season">Season (episodes).</param>
    /// <param name="Episode">Episode (episodes).</param>
    /// <param name="ReadyAt">When it became ready for this interest (UTC).</param>
    public sealed record ReadyCandidate(ReadyInterest Interest, string Part, Guid LogicalItemId, Guid? SeriesId, Guid PlayableItemId, int? Season, int? Episode, DateTime ReadyAt)
    {
        /// <summary>The content coordinate of a movie or an episode.</summary>
        public static string PartOf(int? season, int? episode)
            => season is int s && episode is int e ? "s" + s.ToString(CultureInfo.InvariantCulture) + "e" + e.ToString(CultureInfo.InvariantCulture) : "m";
    }

    /// <summary>A stored Ready entry (<c>ready_entries</c>).</summary>
    /// <param name="Interest">Interest id.</param>
    /// <param name="Part">Content coordinate.</param>
    /// <param name="TitleKey">Title key.</param>
    /// <param name="Edition">Edition name.</param>
    /// <param name="LogicalItemId">Movie or episode item.</param>
    /// <param name="SeriesId">Physical series (episodes).</param>
    /// <param name="PlayableItemId">The version last chosen (null while none qualifies).</param>
    /// <param name="ReadyAt">First time it was ready (UTC ms), kept across upgrades.</param>
    /// <param name="ExpiresAt">When it leaves (UTC ms).</param>
    /// <param name="Disposition"><see cref="ReadyDisposition"/>.</param>
    public sealed record ReadyEntryRow(string Interest, string Part, string TitleKey, string Edition, Guid LogicalItemId, Guid? SeriesId, Guid? PlayableItemId, long ReadyAt, long ExpiresAt, string Disposition);

    /// <summary>A person's Ready playlist binding and consent (<c>ready_playlists</c>), for one server.</summary>
    public sealed record ReadyBinding
    {
        /// <summary>The Jellyfin server the binding belongs to (its SystemId).</summary>
        public string ServerId { get; init; } = string.Empty;

        /// <summary>The owner.</summary>
        public Guid UserId { get; init; }

        /// <summary>The person opted in (and hasn't opted out since).</summary>
        public bool OptedIn { get; init; }

        /// <summary>Moves on with every opt-in: a deletion or restore of an earlier epoch never holds back a renewed one.</summary>
        public long Epoch { get; init; }

        /// <summary><see cref="ReadyState"/>.</summary>
        public string State { get; init; } = ReadyState.Off;

        /// <summary>The managed playlist (null before it is made).</summary>
        public Guid? PlaylistId { get; init; }

        /// <summary>The create marker: the playlist's own folder carries it from the create write on.</summary>
        public string? Marker { get; init; }

        /// <summary>The membership change in progress (JSON), or null.</summary>
        public string? PendingOperation { get; init; }

        /// <summary>The membership last read back and confirmed (playable item ids, in order).</summary>
        public IReadOnlyList<Guid> Confirmed { get; init; } = Array.Empty<Guid>();

        /// <summary>When the membership was last confirmed (UTC ms).</summary>
        public long? ConfirmedAt { get; init; }

        /// <summary>When the playlist was first seen missing (UTC ms), while not yet confirmed deleted.</summary>
        public long? MissingSince { get; init; }

        /// <summary>How many reads in a row found it missing.</summary>
        public int MissingCount { get; init; }

        /// <summary>Why it is in its state (a short code), or null.</summary>
        public string? Reason { get; init; }

        /// <summary>Moves on with every change of the row.</summary>
        public long Revision { get; init; }
    }

    /// <summary>A Jellyfin playlist as Ready sees it.</summary>
    /// <param name="Id">Playlist id.</param>
    /// <param name="OwnerId">Owner.</param>
    /// <param name="OpenAccess">Public.</param>
    /// <param name="ShareCount">How many people it is shared with.</param>
    /// <param name="FolderName">The playlist's folder name (it carries the create marker; renames keep it).</param>
    /// <param name="Name">Its display name.</param>
    public sealed record ReadyPlaylistInfo(Guid Id, Guid OwnerId, bool OpenAccess, int ShareCount, string FolderName, string Name)
    {
        /// <summary>True when the folder carries <paramref name="marker"/>.</summary>
        public bool HasMarker(string? marker) => !string.IsNullOrEmpty(marker) && FolderName.Contains(marker, StringComparison.OrdinalIgnoreCase);

        /// <summary>True when it is owned by <paramref name="owner"/>, not public and shared with nobody.</summary>
        public bool PrivateTo(Guid owner) => OwnerId == owner && !OpenAccess && ShareCount == 0;
    }
}
