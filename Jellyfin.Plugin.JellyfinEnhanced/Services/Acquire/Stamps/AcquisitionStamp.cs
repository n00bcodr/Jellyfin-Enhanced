using System;
using System.Collections.Generic;
using System.Linq;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Automation;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Stamps
{
    /// <summary>
    /// What one poster says about acquisition for one viewer (phase 4e). A fixed set of values, never a progress figure:
    /// native posters carry it in their variant token, so it must change only when its meaning does. The numbers are part
    /// of poster data hashes and never change.
    /// </summary>
    public enum AcquisitionStamp
    {
        /// <summary>Nothing to say.</summary>
        None = 0,

        /// <summary>Something the viewer asked for or follows arrived (first arrival), not watched yet.</summary>
        NewForYou = 1,

        /// <summary>The viewer can open a 4K copy of this title, season or episode.</summary>
        FourK = 2,

        /// <summary>A better copy replaced the file or arrived alongside it, and the viewer has not played it since.</summary>
        Upgraded = 3,
    }

    /// <summary>The fact kinds the stamp store keeps.</summary>
    public static class AcquisitionStampKinds
    {
        /// <summary>A person's own first arrival.</summary>
        public const string New = "new";

        /// <summary>A confirmed replacement (everyone who can open the copy).</summary>
        public const string Upgraded = "upgraded";
    }

    /// <summary>
    /// The effective acquisition badge switches (D29): admin switches default off, per-person display preferences
    /// null = follow the administrator, false = off. Routes, the feeder and the poster pipeline check these at execution.
    /// </summary>
    public static class AcquisitionStampFlags
    {
        /// <summary>Shortest lifetime, in days.</summary>
        public const int MinDays = 1;

        /// <summary>Longest lifetime, in days (also how long facts are kept).</summary>
        public const int MaxDays = 30;

        /// <summary>Acquisition badges are on (Requests &amp; downloads, phase 1, phase 4 and the badge switch).</summary>
        /// <param name="config">Configuration (null: off).</param>
        /// <returns>Whether badges are on.</returns>
        public static bool Badges(PluginConfiguration? config) => AutomationFlags.Phase4(config) && config!.ArrPhase4AcquisitionBadgesEnabled;

        /// <summary>Native stamps are on: badges, the native-stamp switch and native poster tags.</summary>
        /// <param name="config">Configuration (null: off).</param>
        /// <returns>Whether native stamps are on.</returns>
        public static bool NativeStamps(PluginConfiguration? config) => Badges(config) && config!.ArrPhase4NativeStampsEnabled && config.NativePosterTagsEnabled;

        /// <summary>A display preference: null follows the administrator, false opts out.</summary>
        /// <param name="admin">The administrator's effective switch.</param>
        /// <param name="preference">The person's preference.</param>
        /// <returns>Whether it shows for the person.</returns>
        public static bool Display(bool admin, bool? preference) => admin && preference != false;

        /// <summary>How long a "New for you" stamp lasts.</summary>
        /// <param name="config">Configuration.</param>
        /// <returns>The lifetime.</returns>
        public static TimeSpan NewLifetime(PluginConfiguration? config) => TimeSpan.FromDays(Math.Clamp(config?.ArrAcquisitionNewDays ?? 7, MinDays, MaxDays));

        /// <summary>How long an "Upgraded" stamp lasts.</summary>
        /// <param name="config">Configuration.</param>
        /// <returns>The lifetime.</returns>
        public static TimeSpan UpgradedLifetime(PluginConfiguration? config) => TimeSpan.FromDays(Math.Clamp(config?.ArrAcquisitionUpgradedDays ?? 7, MinDays, MaxDays));

        /// <summary>The web route's word for a stamp (null for none).</summary>
        /// <param name="stamp">Stamp.</param>
        /// <returns>upgraded, new, fourK or null.</returns>
        public static string? WireName(AcquisitionStamp stamp) => stamp switch
        {
            AcquisitionStamp.Upgraded => "upgraded",
            AcquisitionStamp.NewForYou => "new",
            AcquisitionStamp.FourK => "fourK",
            _ => null,
        };
    }

    /// <summary>
    /// The copy policy shared with lists (Q-4C1-4) and the Ready playlist: which Jellyfin copy is a 4K edition.
    /// </summary>
    public static class AcquisitionCopyPolicy
    {
        /// <summary>A copy is 4K when its video is at least this wide.</summary>
        public const int FourKWidth = 3200;

        /// <summary>... or at least this high.</summary>
        public const int FourKHeight = 2000;

        /// <summary>Whether a video of this size is a 4K copy.</summary>
        /// <param name="width">Width in pixels (0 = unknown).</param>
        /// <param name="height">Height in pixels (0 = unknown).</param>
        /// <returns>True for 4K.</returns>
        public static bool IsFourK(int width, int height) => width >= FourKWidth || height >= FourKHeight;

        /// <summary>
        /// Whether Jellyfin has read a copy's dimensions. A copy it hasn't read yet has no edition: never standard (a
        /// first 4K file is announced before it is probed), and classified only when the probe arrives.
        /// </summary>
        /// <param name="width">Width in pixels (0 = unknown).</param>
        /// <param name="height">Height in pixels (0 = unknown).</param>
        /// <returns>True once read.</returns>
        public static bool Known(int width, int height) => EditionAvailability.DimensionsKnown(width, height);
    }

    /// <summary>A playable library source, including its own identity and arrival.</summary>
    /// <param name="Id">Jellyfin media-source id (can change during grouping).</param>
    /// <param name="Path">Source path.</param>
    /// <param name="Width">Video width.</param>
    /// <param name="Height">Video height.</param>
    /// <param name="Arrived">When Jellyfin added this source (UTC).</param>
    public sealed record StampSource(string Id, string? Path, int Width, int Height, DateTime Arrived)
    {
        /// <summary>The file identity stays the same when Jellyfin renumbers a grouped source.</summary>
        public string Identity => string.IsNullOrEmpty(Path) ? Id : Path;
    }

    /// <summary>One library item as the stamp code needs it (Movie, Episode, Season or Series).</summary>
    public sealed record StampItem
    {
        /// <summary>Item id.</summary>
        public Guid Id { get; init; }

        /// <summary>movie, episode, season or series.</summary>
        public string Kind { get; init; } = "movie";

        /// <summary>Every usable title key of the movie or series (for episodes and seasons: their series').</summary>
        public IReadOnlyList<TitleKey> Keys { get; init; } = Array.Empty<TitleKey>();

        /// <summary>Series item (episodes and seasons).</summary>
        public Guid? SeriesId { get; init; }

        /// <summary>Season item (episodes).</summary>
        public Guid? SeasonId { get; init; }

        /// <summary>Season number (seasons and episodes).</summary>
        public int? Season { get; init; }

        /// <summary>Episode number (episodes).</summary>
        public int? Episode { get; init; }

        /// <summary>Last episode number of a multi-episode file.</summary>
        public int? EpisodeEnd { get; init; }

        /// <summary>Video width (0 = unknown).</summary>
        public int Width { get; init; }

        /// <summary>Video height (0 = unknown).</summary>
        public int Height { get; init; }

        /// <summary>When Jellyfin added it (UTC).</summary>
        public DateTime DateCreated { get; init; }

        /// <summary>A virtual (missing) item, which never arrives.</summary>
        public bool Virtual { get; init; }

        /// <summary>File path (movies and episodes).</summary>
        public string? Path { get; init; }

        /// <summary>Playable media sources, each with its own arrival; empty for legacy single-source facts.</summary>
        public IReadOnlyList<StampSource> Sources { get; init; } = Array.Empty<StampSource>();

        /// <summary>True for a 4K copy.</summary>
        public bool FourK => Sources.Count > 0
            ? Sources.Any(s => AcquisitionCopyPolicy.IsFourK(s.Width, s.Height))
            : AcquisitionCopyPolicy.IsFourK(Width, Height);

        /// <summary>
        /// The edition is known: a 4K source, or every source's dimensions read (<see cref="AcquisitionCopyPolicy.Known"/>).
        /// Until then the copy is neither standard nor 4K for any edition fact.
        /// </summary>
        public bool EditionKnown => FourK || (Sources.Count > 0
            ? Sources.All(s => AcquisitionCopyPolicy.Known(s.Width, s.Height))
            : AcquisitionCopyPolicy.Known(Width, Height));

        /// <summary>Identity while judging one source (null for legacy item facts).</summary>
        public string? SourceId { get; init; }

        /// <summary>One view per source, retaining the card's item id and episode scope.</summary>
        /// <returns>Source views (or this single-source item).</returns>
        public IEnumerable<StampItem> SourceItems()
        {
            if (Sources.Count == 0) { yield return this; yield break; }
            foreach (var source in Sources)
            {
                yield return this with { SourceId = source.Identity, Path = source.Path, Width = source.Width, Height = source.Height,
                    DateCreated = source.Arrived, Sources = Array.Empty<StampSource>() };
            }
        }

        /// <summary>A movie or an episode (what arrives).</summary>
        public bool IsVideo => Kind is "movie" or "episode";
    }

    /// <summary>A person's interest in a title, for "New for you".</summary>
    /// <param name="UserId">The person.</param>
    /// <param name="Since">When they asked or followed.</param>
    /// <param name="FourKOnly">They asked for the 4K edition (only a 4K copy counts).</param>
    /// <param name="AllSeasons">Series: every season (a follow, a whole-series ask or "keep getting new episodes").</param>
    /// <param name="Seasons">Series: the seasons asked for.</param>
    /// <param name="Episodes">Series: single episodes asked for.</param>
    /// <param name="Source">request, seerr or follow.</param>
    public sealed record StampInterest(Guid UserId, DateTime Since, bool FourKOnly, bool AllSeasons, IReadOnlyCollection<int> Seasons, IReadOnlyCollection<(int Season, int Episode)> Episodes, string Source)
    {
        /// <summary>Whether the interest covers an episode (or a movie when both numbers are null).</summary>
        /// <param name="season">Season number.</param>
        /// <param name="episode">Episode number.</param>
        /// <param name="episodeEnd">Last episode of a multi-episode file.</param>
        /// <returns>True when covered.</returns>
        public bool Covers(int? season, int? episode, int? episodeEnd = null)
        {
            if (season is not int s) return true;
            if (AllSeasons) return s > 0;
            if (Seasons.Contains(s)) return true;
            if (episode is not int e) return false;
            var last = episodeEnd is int end && end >= e ? end : e;
            foreach (var (es, ee) in Episodes)
            {
                if (es == s && ee >= e && ee <= last) return true;
            }

            return false;
        }
    }

    /// <summary>An arr import that replaced a file (the arr deleted the old one for "Upgrade").</summary>
    /// <param name="Source">"instance:historyId", unique per import.</param>
    /// <param name="Path">The imported file as Jellyfin sees it (path mappings applied).</param>
    /// <param name="At">When the arr imported it (UTC).</param>
    public sealed record StampUpgradeImport(string Source, string Path, DateTime At);

    /// <summary>The library facts the stamp code reads (Jellyfin in production, fakes in tests). No network I/O.</summary>
    public interface IStampLibrary
    {
        /// <summary>A Movie, Episode, Season or Series by id (no user check), or null.</summary>
        /// <param name="id">Item id.</param>
        /// <returns>The item.</returns>
        StampItem? Item(Guid id);

        /// <summary>Whether the person may open the item (library access and parental limits).</summary>
        /// <param name="userId">Person.</param>
        /// <param name="itemId">Item.</param>
        /// <returns>True when they can.</returns>
        bool CanOpen(Guid userId, Guid itemId);

        /// <summary>The person's played mark and last playback of an item, or null when unknown.</summary>
        /// <param name="userId">Person.</param>
        /// <param name="itemId">Item.</param>
        /// <returns>(played, last played UTC).</returns>
        (bool Played, DateTime? LastPlayed)? UserData(Guid userId, Guid itemId);

        /// <summary>Every movie and episode file that is a 4K copy.</summary>
        /// <returns>Items.</returns>
        IReadOnlyList<StampItem> FourKVideos();

        /// <summary>Movies and episodes (not virtual) Jellyfin added at or after <paramref name="since"/>.</summary>
        /// <param name="since">UTC.</param>
        /// <returns>Items.</returns>
        IReadOnlyList<StampItem> AddedSince(DateTime since);

        /// <summary>Other copies of the same movie, or of the same episode numbers in any copy of its series.</summary>
        /// <param name="item">A movie or an episode.</param>
        /// <returns>Copies, the item itself excluded.</returns>
        IReadOnlyList<StampItem> OtherCopies(StampItem item);

        /// <summary>The movie or episode Jellyfin has at exactly this path.</summary>
        /// <param name="path">File path as Jellyfin sees it.</param>
        /// <returns>Item id or null.</returns>
        Guid? ItemAtPath(string path);

        /// <summary>A movie or an episode was added.</summary>
        event Action<StampItem>? Added;

        /// <summary>A movie or an episode changed (media info, path).</summary>
        event Action<StampItem>? Updated;

        /// <summary>A movie or an episode was removed (the item as it was).</summary>
        event Action<StampItem>? Removed;
    }

    /// <summary>Who asked for or follows a title (read from the request ledger, Seerr's requests and follows).</summary>
    public interface IStampInterests
    {
        /// <summary>Every interest in a title known by any of these keys (aliases included).</summary>
        /// <param name="keys">The title's keys.</param>
        /// <returns>Interests.</returns>
        IReadOnlyList<StampInterest> For(IReadOnlyList<TitleKey> keys);
    }

    /// <summary>Upgrade imports from the arrs' history snapshots in memory (never an arr call).</summary>
    public interface IStampUpgrades
    {
        /// <summary>Upgrade imports at or after <paramref name="since"/>.</summary>
        /// <param name="since">UTC.</param>
        /// <returns>Imports.</returns>
        IReadOnlyList<StampUpgradeImport> Since(DateTime since);
    }
}
