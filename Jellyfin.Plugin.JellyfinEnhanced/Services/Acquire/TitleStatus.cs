using System;
using System.Collections.Generic;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire
{
    /// <summary>
    /// The stops of the one status language every surface uses. The first seven are the journey
    /// (Asked → OK'd → Not out yet → Looking → Downloading → Almost ready → Ready); <see cref="NotHere"/>
    /// and <see cref="None"/> are not journey stops.
    /// </summary>
    public static class StatusStage
    {
        /// <summary>Someone asked for it (a request waits for an OK).</summary>
        public const string Asked = "asked";

        /// <summary>The request was OK'd; nothing has happened in the arr yet.</summary>
        public const string Approved = "approved";

        /// <summary>Not released yet (or not aired).</summary>
        public const string NotOut = "notOut";

        /// <summary>Wanted and available; no copy found yet.</summary>
        public const string Looking = "looking";

        /// <summary>A copy is downloading (or waiting in line in the download client).</summary>
        public const string Downloading = "downloading";

        /// <summary>Downloaded; being imported, or imported and not yet in Jellyfin.</summary>
        public const string AlmostReady = "almostReady";

        /// <summary>A playable Jellyfin item this user can open.</summary>
        public const string Ready = "ready";

        /// <summary>Not in the library and nothing is fetching it.</summary>
        public const string NotHere = "notHere";

        /// <summary>Nothing known (no arr has the title, or the arrs could not be read).</summary>
        public const string None = "none";

        /// <summary>The journey stops in order.</summary>
        public static readonly IReadOnlyList<string> Journey = new[] { Asked, Approved, NotOut, Looking, Downloading, AlmostReady, Ready };

        /// <summary>Position of a stop in the journey (-1 for non-journey stages).</summary>
        public static int Rank(string stage)
        {
            for (var i = 0; i < Journey.Count; i++)
            {
                if (Journey[i] == stage) return i;
            }
            return -1;
        }
    }

    /// <summary>Reason codes behind every status. Family and admin texts are looked up by code (and parameters) on the client.</summary>
    public static class StatusReasonCode
    {
        /// <summary>Asked; waiting for an OK.</summary>
        public const string AwaitingApproval = "awaiting_approval";
        /// <summary>OK'd; nothing in the arr yet.</summary>
        public const string Approved = "approved";
        /// <summary>The request was declined.</summary>
        public const string Declined = "declined";
        /// <summary>Not released yet.</summary>
        public const string NotReleased = "not_released";
        /// <summary>In cinemas; not out at home yet.</summary>
        public const string InCinemas = "in_cinemas";
        /// <summary>The episode has not aired.</summary>
        public const string NotAired = "not_aired";
        /// <summary>Wanted and available; no copy found yet.</summary>
        public const string Looking = "looking";
        /// <summary>Still looking after the looking threshold.</summary>
        public const string NoReleaseYet = "no_release_yet";
        /// <summary>Waiting in line in the download client.</summary>
        public const string Queued = "queued";
        /// <summary>Held by a delay profile.</summary>
        public const string DelayHeld = "delay_held";
        /// <summary>Downloading.</summary>
        public const string Downloading = "downloading";
        /// <summary>The arr warns about the download.</summary>
        public const string Stalled = "stalled";
        /// <summary>The download client can't be reached: no progress is known (family: "taking longer than usual").</summary>
        public const string ClientUnavailable = "client_unavailable";
        /// <summary>The download failed; the arr looks for another copy.</summary>
        public const string Failed = "failed";
        /// <summary>Downloaded; the arr is importing it.</summary>
        public const string Importing = "importing";
        /// <summary>Downloaded; the arr cannot import it without help.</summary>
        public const string ImportBlocked = "import_blocked";
        /// <summary>Imported by the arr; not in Jellyfin yet.</summary>
        public const string LibraryPending = "library_pending";
        /// <summary>In Jellyfin, in a library this user cannot open.</summary>
        public const string NotVisibleToUser = "not_visible_to_user";
        /// <summary>Playable in Jellyfin.</summary>
        public const string Ready = "ready";
        /// <summary>Playable; a better copy is on its way.</summary>
        public const string Upgrading = "upgrading";
        /// <summary>Known to the arr but not being fetched.</summary>
        public const string Unmonitored = "unmonitored";
        /// <summary>No arr instance has the title.</summary>
        public const string NotInArr = "not_in_arr";
        /// <summary>The arr holding the title cannot be read.</summary>
        public const string ServiceDown = "service_down";
        /// <summary>Some episodes are here, some are not.</summary>
        public const string Partial = "partial";
        /// <summary>
        /// Seerr OK'd the request a while ago, yet no Sonarr/Radarr instance holds the title (Seerr's
        /// own Sonarr/Radarr settings are the usual cause). Administrators see it after a short grace
        /// period; family members only after the "still looking" hours, as "Taking longer than usual".
        /// </summary>
        public const string ApprovedNotInArr = "approved_not_in_arr";
    }

    /// <summary>Admin fix hints (what would resolve the reason). Phase 1 shows them as text only.</summary>
    public static class StatusFix
    {
        /// <summary>Search now.</summary>
        public const string SearchNow = "search_now";
        /// <summary>Change the minimum availability.</summary>
        public const string ChangeMinAvailability = "change_min_availability";
        /// <summary>Grab the held release now.</summary>
        public const string GrabNow = "grab_now";
        /// <summary>Remove the download (keep data), blocklist it and search again.</summary>
        public const string RemoveAndSearch = "remove_blocklist_search";
        /// <summary>Search again.</summary>
        public const string Research = "research";
        /// <summary>Import it manually in the arr.</summary>
        public const string ManualImport = "manual_import";
        /// <summary>Scan the Jellyfin library.</summary>
        public const string ScanNow = "scan_now";
        /// <summary>Give the user access to the library (or put the copy elsewhere).</summary>
        public const string GrantAccess = "grant_access";
        /// <summary>Monitor it and search.</summary>
        public const string MonitorAndSearch = "monitor_and_search";
        /// <summary>Check the instance (System / health).</summary>
        public const string Health = "health";
        /// <summary>Check the download client (is it running, can the arr reach it).</summary>
        public const string CheckClient = "check_client";
    }

    /// <summary>A reason code and its parameters (dates as ISO 8601 UTC, numbers as text). Family-safe values only.</summary>
    public sealed class StatusReason
    {
        /// <summary>Reason code (<see cref="StatusReasonCode"/>).</summary>
        public string Code { get; init; } = StatusReasonCode.Ready;

        /// <summary>Parameters for the text (date, pct, eta, hours, count, ...), or null.</summary>
        public IReadOnlyDictionary<string, string>? Params { get; init; }
    }

    /// <summary>Download progress.</summary>
    public sealed class StatusProgress
    {
        /// <summary>Percent done (0-100).</summary>
        public int Percent { get; init; }

        /// <summary>Seconds left, when the arr knows.</summary>
        public long? EtaSeconds { get; init; }
    }

    /// <summary>One dot of the journey strip.</summary>
    public sealed class JourneyStop
    {
        /// <summary>The stop (<see cref="StatusStage"/>).</summary>
        public string Stage { get; init; } = string.Empty;

        /// <summary>When it was reached, if known.</summary>
        public DateTime? At { get; init; }

        /// <summary>done, current or next.</summary>
        public string State { get; init; } = "done";

        /// <summary>For "asked": true when the viewer asked; false when someone else in the household did.</summary>
        public bool? ByYou { get; init; }
    }

    /// <summary>Counts for a series or season.</summary>
    public sealed class StatusSummary
    {
        /// <summary>Episodes that have aired (or have a file).</summary>
        public int Aired { get; init; }

        /// <summary>Episodes this user can play.</summary>
        public int Ready { get; init; }

        /// <summary>Episodes downloading or waiting in line.</summary>
        public int Downloading { get; init; }

        /// <summary>Episodes downloaded and on their way into Jellyfin.</summary>
        public int AlmostReady { get; init; }

        /// <summary>Aired episodes that are wanted (monitored) and not here or on their way yet.</summary>
        public int Missing { get; init; }

        /// <summary>Episodes with a problem.</summary>
        public int Attention { get; init; }

        /// <summary>Next air time (UTC).</summary>
        public DateTime? NextAir { get; init; }

        /// <summary>
        /// <see cref="NextAir"/> is a calendar day (Sonarr gave only the air date), not an instant.
        /// Server-side only: the statuses carry it as <c>nextDay</c>.
        /// </summary>
        [System.Text.Json.Serialization.JsonIgnore]
        public bool NextAirIsDay { get; init; }

        /// <summary>
        /// Of <see cref="Missing"/>, the episodes whose downloads can't be checked now (their
        /// instance's queue or history expired); the client shows them as taking longer, not missing.
        /// </summary>
        public int Unknown { get; init; }

        /// <summary>Season of the next episode.</summary>
        public int? NextSeason { get; init; }

        /// <summary>Number of the next episode.</summary>
        public int? NextEpisode { get; init; }

        /// <summary>Series only: season numbers whose aired episodes are all ready.</summary>
        public IReadOnlyList<int>? ReadySeasons { get; init; }
    }

    /// <summary>Per-season state on a series page (season card badges).</summary>
    public sealed class SeasonStatus
    {
        /// <summary>Season number.</summary>
        public int Season { get; init; }

        /// <summary>Jellyfin season item id, when the user can see one.</summary>
        public string? ItemId { get; init; }

        /// <summary>Stage of the season.</summary>
        public string Stage { get; init; } = StatusStage.None;

        /// <summary>Counts.</summary>
        public StatusSummary Summary { get; init; } = new();
    }

    /// <summary>One episode on a season page.</summary>
    public sealed class EpisodeStatus
    {
        /// <summary>Title key of the episode.</summary>
        public string Key { get; init; } = string.Empty;

        /// <summary>Season number.</summary>
        public int Season { get; init; }

        /// <summary>Episode number.</summary>
        public int Episode { get; init; }

        /// <summary>Jellyfin episode item id when this user has a row for it (real, or virtual when they show missing episodes).</summary>
        public string? ItemId { get; init; }

        /// <summary>True when the episode has a row on the season page for this user; false: it belongs in the banner.</summary>
        public bool Row { get; init; }

        /// <summary>Stage.</summary>
        public string Stage { get; init; } = StatusStage.None;

        /// <summary>Reason.</summary>
        public StatusReason Reason { get; init; } = new();

        /// <summary>Needs attention.</summary>
        public bool Attention { get; init; }

        /// <summary>Download progress.</summary>
        public StatusProgress? Progress { get; init; }

        /// <summary>Air time (UTC).</summary>
        public DateTime? AirDate { get; init; }
    }

    /// <summary>Admin view of one copy (instance) of a title.</summary>
    public sealed class AdminVariant
    {
        /// <summary>Instance name.</summary>
        public string Instance { get; init; } = string.Empty;

        /// <summary>Instance id.</summary>
        public string InstanceId { get; init; } = string.Empty;

        /// <summary>Sonarr or Radarr.</summary>
        public string Kind { get; init; } = string.Empty;

        /// <summary>Instance role (standard, 4k, anime, custom).</summary>
        public string Role { get; init; } = string.Empty;

        /// <summary>Stage of this copy.</summary>
        public string Stage { get; init; } = StatusStage.None;

        /// <summary>Reason of this copy.</summary>
        public StatusReason Reason { get; init; } = new();

        /// <summary>Needs attention.</summary>
        public bool Attention { get; init; }

        /// <summary>Progress.</summary>
        public StatusProgress? Progress { get; init; }

        /// <summary>Monitored in the arr.</summary>
        public bool? Monitored { get; init; }

        /// <summary>The arr has a file.</summary>
        public bool? HasFile { get; init; }

        /// <summary>Minimum availability (Radarr).</summary>
        public string? MinimumAvailability { get; init; }

        /// <summary>Jellyfin library the copy is in, if found.</summary>
        public string? Library { get; init; }

        /// <summary>Jellyfin item id of the copy, if found.</summary>
        public string? ItemId { get; init; }

        /// <summary>The copy's Jellyfin item is visible to the viewer.</summary>
        public bool? VisibleToViewer { get; init; }

        /// <summary>The arr's own words (status messages, error message), capped.</summary>
        public IReadOnlyList<string>? Messages { get; init; }

        /// <summary>Queue state as the arr names it (downloading, importBlocked, ...).</summary>
        public string? ArrState { get; init; }

        /// <summary>Download client name.</summary>
        public string? Client { get; init; }

        /// <summary>Quality name.</summary>
        public string? Quality { get; init; }

        /// <summary>Custom format score.</summary>
        public int? CustomFormatScore { get; init; }

        /// <summary>The title's folder in the arr's view.</summary>
        public string? Path { get; init; }

        /// <summary>Since when the copy is in this state (queue row added, import time, ...).</summary>
        public DateTime? Since { get; init; }

        /// <summary>What would fix it (<see cref="StatusFix"/>).</summary>
        public string? Fix { get; init; }

        /// <summary>Season/episode this copy's attention line is about (series pages).</summary>
        public string? Scope { get; init; }

        /// <summary>When the arr last searched for this copy (UTC; movies and episodes still being looked for), if it says.</summary>
        public DateTime? LastSearch { get; init; }
    }

    /// <summary>Admin-only part of a status: every copy across instances and why each is where it is.</summary>
    public sealed class AdminStatus
    {
        /// <summary>One entry per instance holding the title (series pages: one per problem episode too).</summary>
        public IReadOnlyList<AdminVariant> Variants { get; init; } = Array.Empty<AdminVariant>();

        /// <summary>Instances that could not be read (name and error kind).</summary>
        public IReadOnlyList<string>? Unreadable { get; init; }

        /// <summary>
        /// When Seerr OK'd a request that no Sonarr/Radarr holds yet, once the grace period has passed
        /// (<see cref="StatusReasonCode.ApprovedNotInArr"/>); null otherwise.
        /// </summary>
        public DateTime? ApprovedNotInArrSince { get; init; }

        /// <summary>True when <see cref="ApprovedNotInArrSince"/> is about a 4K request no 4K Radarr/Sonarr holds (null otherwise).</summary>
        public bool? ApprovedNotIn4k { get; init; }
    }

    /// <summary>
    /// The status of one title (movie, series, season or episode) for one viewer. Family members get
    /// the stage, a reason code with family-safe parameters, dates and counts; admins also get
    /// <see cref="Admin"/>. Nothing in the family shape names an instance, path, URL, client or release.
    /// </summary>
    public sealed class TitleStatus
    {
        /// <summary>Title key (<see cref="TitleKey"/>), the id the change feed refers to.</summary>
        public string Key { get; init; } = string.Empty;

        /// <summary>
        /// The key the change feed announces this title under, when it differs from <see cref="Key"/>:
        /// a title Jellyfin knows only by its IMDb id (or a series by TMDB/IMDb) is announced under
        /// the TMDB movie / TVDB series id of its arr copy. Absent otherwise.
        /// </summary>
        public string? LiveKey { get; set; }

        /// <summary>The Jellyfin item this status was asked for, if any.</summary>
        public string? ItemId { get; init; }

        /// <summary>movie, series, season or episode.</summary>
        public string Kind { get; init; } = string.Empty;

        /// <summary>Where it has got to (<see cref="StatusStage"/>).</summary>
        public string Stage { get; init; } = StatusStage.None;

        /// <summary>Why.</summary>
        public StatusReason Reason { get; init; } = new();

        /// <summary>Taking longer than it should (stalled, failed, import blocked).</summary>
        public bool Attention { get; init; }

        /// <summary>Nothing worth showing to family (e.g. ready for a long time).</summary>
        public bool Quiet { get; init; }

        /// <summary>Download progress (downloading only).</summary>
        public StatusProgress? Progress { get; init; }

        /// <summary>Release, air or "expected" date, when there is one.</summary>
        public DateTime? NextDate { get; init; }

        /// <summary>
        /// <see cref="NextDate"/> as a calendar day ("yyyy-MM-dd") when it is a date without a time (a
        /// release date, an air date with no time): shown as that day in every time zone. Null otherwise.
        /// </summary>
        public string? NextDay { get; init; }

        /// <summary>Journey strip (details pages only).</summary>
        public IReadOnlyList<JourneyStop>? Journey { get; init; }

        /// <summary>Counts (series and seasons).</summary>
        public StatusSummary? Summary { get; init; }

        /// <summary>Per season (series details only).</summary>
        public IReadOnlyList<SeasonStatus>? Seasons { get; init; }

        /// <summary>Per episode (season details only).</summary>
        public IReadOnlyList<EpisodeStatus>? Episodes { get; init; }

        /// <summary>Server-side actions this viewer may take (none in phase 1).</summary>
        public IReadOnlyList<string> Actions { get; init; } = Array.Empty<string>();

        /// <summary>Admin-only detail; never present for other users.</summary>
        public AdminStatus? Admin { get; init; }
    }

    /// <summary>The response of the status routes.</summary>
    public sealed class StatusResponse
    {
        /// <summary>What the household calls the server owner (family texts), or empty.</summary>
        public string Contact { get; init; } = string.Empty;

        /// <summary>Hours after which "Looking" reads "Still looking".</summary>
        public int LookingHours { get; init; }

        /// <summary>One entry per requested id or key the viewer may see (others are left out).</summary>
        public IReadOnlyList<TitleStatus> Items { get; init; } = Array.Empty<TitleStatus>();
    }
}
