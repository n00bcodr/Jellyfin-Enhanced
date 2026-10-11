using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Arr
{
    /// <summary>The snapshots <see cref="ArrStateStore"/> keeps per instance.</summary>
    [JsonConverter(typeof(JsonStringEnumConverter))]
    public enum ArrSnapshotKind
    {
        /// <summary>Every movie (Radarr) or series (Sonarr) with provider ids, plus the tag labels.</summary>
        Library,
        /// <summary>The download queue (all pages).</summary>
        Queue,
        /// <summary>A bounded ring of recent history, kept current with <c>history/since</c>.</summary>
        History,
        /// <summary>Calendar entries for a window around today.</summary>
        Calendar,
        /// <summary>System status, health, disk space, root folders and quality profiles.</summary>
        System,
    }

    /// <summary>One movie in a Radarr library snapshot (slim: only what JE reads).</summary>
    public sealed class ArrMovieEntry
    {
        /// <summary>Radarr id.</summary>
        public int Id { get; init; }

        /// <summary>TMDB id.</summary>
        public int? TmdbId { get; init; }

        /// <summary>IMDb id.</summary>
        public string? ImdbId { get; init; }

        /// <summary>Title.</summary>
        public string Title { get; init; } = string.Empty;

        /// <summary>Year.</summary>
        public int? Year { get; init; }

        /// <summary>Monitored in Radarr.</summary>
        public bool Monitored { get; init; }

        /// <summary>Has a movie file.</summary>
        public bool HasFile { get; init; }

        /// <summary>Bytes on disk.</summary>
        public long SizeOnDisk { get; init; }

        /// <summary>Folder in the arr's view of the file system (admin only).</summary>
        public string? Path { get; init; }

        /// <summary>Quality profile id.</summary>
        public int QualityProfileId { get; init; }

        /// <summary>Tag ids.</summary>
        public int[] Tags { get; init; } = Array.Empty<int>();
    }

    /// <summary>One series in a Sonarr library snapshot (slim).</summary>
    public sealed class ArrSeriesEntry
    {
        /// <summary>Sonarr id.</summary>
        public int Id { get; init; }

        /// <summary>TVDB id.</summary>
        public int? TvdbId { get; init; }

        /// <summary>TMDB id.</summary>
        public int? TmdbId { get; init; }

        /// <summary>IMDb id.</summary>
        public string? ImdbId { get; init; }

        /// <summary>Title.</summary>
        public string Title { get; init; } = string.Empty;

        /// <summary>URL slug used by Sonarr's web UI.</summary>
        public string? TitleSlug { get; init; }

        /// <summary>Monitored in Sonarr.</summary>
        public bool Monitored { get; init; }

        /// <summary>Folder in the arr's view of the file system (admin only).</summary>
        public string? Path { get; init; }

        /// <summary>Quality profile id.</summary>
        public int QualityProfileId { get; init; }

        /// <summary>Tag ids.</summary>
        public int[] Tags { get; init; } = Array.Empty<int>();

        /// <summary>Episode files on disk.</summary>
        public int EpisodeFileCount { get; init; }

        /// <summary>Monitored aired episodes.</summary>
        public int EpisodeCount { get; init; }

        /// <summary>Sonarr's percentage of episodes on disk.</summary>
        public double PercentOfEpisodes { get; init; }

        /// <summary>Bytes on disk.</summary>
        public long SizeOnDisk { get; init; }
    }

    /// <summary>
    /// A Radarr or Sonarr library: every title with its provider ids, indexed for O(1) lookups,
    /// plus the instance's tag labels.
    /// </summary>
    public sealed class ArrLibrarySnapshot
    {
        private readonly Dictionary<int, ArrMovieEntry> _moviesByTmdb = new();
        private readonly Dictionary<int, ArrSeriesEntry> _seriesByTvdb = new();
        private readonly Dictionary<int, ArrSeriesEntry> _seriesByTmdb = new();
        private readonly Dictionary<string, ArrSeriesEntry> _seriesByImdb = new(StringComparer.OrdinalIgnoreCase);

        /// <summary>Builds the snapshot and its indexes. The first title wins on a duplicate id.</summary>
        public ArrLibrarySnapshot(IReadOnlyList<ArrMovieEntry> movies, IReadOnlyList<ArrSeriesEntry> series, IReadOnlyDictionary<int, string> tags)
        {
            Movies = movies;
            Series = series;
            Tags = tags;
            foreach (var m in movies)
            {
                if (m.TmdbId is > 0 and var tmdb) _moviesByTmdb.TryAdd(tmdb, m);
            }
            foreach (var s in series)
            {
                if (s.TvdbId is > 0 and var tvdb) _seriesByTvdb.TryAdd(tvdb, s);
                if (s.TmdbId is > 0 and var tmdb) _seriesByTmdb.TryAdd(tmdb, s);
                if (!string.IsNullOrWhiteSpace(s.ImdbId)) _seriesByImdb.TryAdd(s.ImdbId.Trim(), s);
            }
        }

        /// <summary>Movies (Radarr; empty for Sonarr).</summary>
        public IReadOnlyList<ArrMovieEntry> Movies { get; }

        /// <summary>Series (Sonarr; empty for Radarr).</summary>
        public IReadOnlyList<ArrSeriesEntry> Series { get; }

        /// <summary>Tag id → label.</summary>
        public IReadOnlyDictionary<int, string> Tags { get; }

        /// <summary>The movie with this TMDB id, or null.</summary>
        public ArrMovieEntry? MovieByTmdb(int tmdbId) => _moviesByTmdb.TryGetValue(tmdbId, out var m) ? m : null;

        /// <summary>The series with this TVDB id, or null.</summary>
        public ArrSeriesEntry? SeriesByTvdb(int tvdbId) => _seriesByTvdb.TryGetValue(tvdbId, out var s) ? s : null;

        /// <summary>The series with this TMDB id, or null.</summary>
        public ArrSeriesEntry? SeriesByTmdb(int tmdbId) => _seriesByTmdb.TryGetValue(tmdbId, out var s) ? s : null;

        /// <summary>The series with this IMDb id, or null.</summary>
        public ArrSeriesEntry? SeriesByImdb(string? imdbId)
            => !string.IsNullOrWhiteSpace(imdbId) && _seriesByImdb.TryGetValue(imdbId.Trim(), out var s) ? s : null;

        /// <summary>Labels for tag ids (unknown ids are skipped).</summary>
        public List<string> Labels(IEnumerable<int> tagIds)
        {
            var labels = new List<string>();
            foreach (var id in tagIds)
            {
                if (Tags.TryGetValue(id, out var label) && !string.IsNullOrEmpty(label)) labels.Add(label);
            }
            return labels;
        }
    }

    /// <summary>One queue row (slim). Status messages are capped (5 × 200 characters).</summary>
    public sealed class ArrQueueEntry
    {
        /// <summary>Queue row id.</summary>
        public int Id { get; init; }

        /// <summary>Download client id; one download (a season pack) has several rows.</summary>
        public string? DownloadId { get; init; }

        /// <summary>Transfer status (queued, downloading, paused, completed, ...).</summary>
        public string? Status { get; init; }

        /// <summary>Import state (downloading, importPending, importing, failedPending, ...).</summary>
        public string? TrackedDownloadState { get; init; }

        /// <summary>ok / warning / error.</summary>
        public string? TrackedDownloadStatus { get; init; }

        /// <summary>The arr's messages for this row (capped).</summary>
        public IReadOnlyList<string> StatusMessages { get; init; } = Array.Empty<string>();

        /// <summary>Error message, if any (capped).</summary>
        public string? ErrorMessage { get; init; }

        /// <summary>Total bytes.</summary>
        public double? Size { get; init; }

        /// <summary>Bytes left.</summary>
        public double? SizeLeft { get; init; }

        /// <summary>Time left as the arr formats it (hh:mm:ss).</summary>
        public string? TimeLeft { get; init; }

        /// <summary>Estimated completion.</summary>
        public DateTime? EstimatedCompletionTime { get; init; }

        /// <summary>usenet / torrent.</summary>
        public string? Protocol { get; init; }

        /// <summary>Release title (admin only).</summary>
        public string? ReleaseTitle { get; init; }

        /// <summary>Radarr movie id.</summary>
        public int? MovieId { get; init; }

        /// <summary>Sonarr series id.</summary>
        public int? SeriesId { get; init; }

        /// <summary>Sonarr episode id.</summary>
        public int? EpisodeId { get; init; }

        /// <summary>Movie or series title.</summary>
        public string? Title { get; init; }

        /// <summary>Movie year.</summary>
        public int? Year { get; init; }

        /// <summary>TMDB id of the movie or series.</summary>
        public int? TmdbId { get; init; }

        /// <summary>TVDB id of the series.</summary>
        public int? TvdbId { get; init; }

        /// <summary>Poster URL.</summary>
        public string? PosterUrl { get; init; }

        /// <summary>Season number.</summary>
        public int? SeasonNumber { get; init; }

        /// <summary>Episode number.</summary>
        public int? EpisodeNumber { get; init; }

        /// <summary>Episode title.</summary>
        public string? EpisodeTitle { get; init; }
    }

    /// <summary>The whole queue of one instance.</summary>
    public sealed class ArrQueueSnapshot
    {
        /// <summary>Rows in the arr's order.</summary>
        public IReadOnlyList<ArrQueueEntry> Records { get; init; } = Array.Empty<ArrQueueEntry>();

        /// <summary>The arr's <c>totalRecords</c>.</summary>
        public int TotalRecords { get; init; }

        /// <summary>True when the row cap stopped the read early.</summary>
        public bool Truncated { get; init; }
    }

    /// <summary>One history record (slim).</summary>
    public sealed class ArrHistoryEntry
    {
        /// <summary>History record id.</summary>
        public int Id { get; init; }

        /// <summary>The arr's event type (grabbed, downloadFolderImported, downloadFailed, ...).</summary>
        public string? EventType { get; init; }

        /// <summary>When it happened (UTC).</summary>
        public DateTime? Date { get; init; }

        /// <summary>Download client id.</summary>
        public string? DownloadId { get; init; }

        /// <summary>Movie or series title.</summary>
        public string? Title { get; init; }

        /// <summary>Movie year.</summary>
        public int? Year { get; init; }

        /// <summary>TMDB id of the movie or series.</summary>
        public int? TmdbId { get; init; }

        /// <summary>TVDB id of the series.</summary>
        public int? TvdbId { get; init; }

        /// <summary>Radarr movie id.</summary>
        public int? MovieId { get; init; }

        /// <summary>Sonarr series id.</summary>
        public int? SeriesId { get; init; }

        /// <summary>Sonarr episode id.</summary>
        public int? EpisodeId { get; init; }

        /// <summary>Poster URL.</summary>
        public string? PosterUrl { get; init; }

        /// <summary>Season number.</summary>
        public int? SeasonNumber { get; init; }

        /// <summary>Episode number.</summary>
        public int? EpisodeNumber { get; init; }

        /// <summary>Episode title.</summary>
        public string? EpisodeTitle { get; init; }
    }

    /// <summary>Recent history of one instance, newest first, with the catch-up watermark.</summary>
    public sealed class ArrHistorySnapshot
    {
        /// <summary>Records, newest first (bounded ring).</summary>
        public IReadOnlyList<ArrHistoryEntry> Records { get; init; } = Array.Empty<ArrHistoryEntry>();

        /// <summary>Date of the newest record; the next <c>history/since</c> read starts here.</summary>
        public DateTime? Watermark { get; init; }

        /// <summary>When the last full (non-incremental) read happened.</summary>
        public DateTimeOffset FullReadAt { get; init; }
    }

    /// <summary>One calendar entry: a Sonarr episode or a Radarr movie with its release dates.</summary>
    public sealed class ArrCalendarEntry
    {
        /// <summary>Arr id (episode id or movie id).</summary>
        public int Id { get; init; }

        /// <summary>Movie title or series title.</summary>
        public string Title { get; init; } = string.Empty;

        /// <summary>Movie year (Radarr).</summary>
        public string? Year { get; init; }

        /// <summary>Episode air time (Sonarr, UTC).</summary>
        public DateTime? AirDateUtc { get; init; }

        /// <summary>Release dates by type (CinemaRelease / PhysicalRelease / DigitalRelease), Radarr, UTC.</summary>
        public IReadOnlyDictionary<string, DateTime> Releases { get; init; } = new Dictionary<string, DateTime>();

        /// <summary>Has a file.</summary>
        public bool HasFile { get; init; }

        /// <summary>Monitored.</summary>
        public bool Monitored { get; init; }

        /// <summary>Sonarr series id.</summary>
        public int? SeriesId { get; init; }

        /// <summary>Season number.</summary>
        public int? SeasonNumber { get; init; }

        /// <summary>Episode number.</summary>
        public int? EpisodeNumber { get; init; }

        /// <summary>Episode title.</summary>
        public string? EpisodeTitle { get; init; }

        /// <summary>Episode overview.</summary>
        public string? Overview { get; init; }

        /// <summary>TVDB id of the series.</summary>
        public int? TvdbId { get; init; }

        /// <summary>IMDb id of the movie or series.</summary>
        public string? ImdbId { get; init; }

        /// <summary>TMDB id of the movie or series.</summary>
        public int? TmdbId { get; init; }

        /// <summary>Episode TVDB id.</summary>
        public int? EpisodeTvdbId { get; init; }

        /// <summary>Episode IMDb id.</summary>
        public string? EpisodeImdbId { get; init; }

        /// <summary>Poster URL.</summary>
        public string? PosterUrl { get; init; }

        /// <summary>Backdrop URL.</summary>
        public string? BackdropUrl { get; init; }

        /// <summary>Folder of the movie or series (server-side access checks only).</summary>
        public string? Path { get; init; }
    }

    /// <summary>Calendar entries of one instance for a window around today.</summary>
    public sealed class ArrCalendarSnapshot
    {
        /// <summary>Window start (UTC, inclusive).</summary>
        public DateTime WindowStart { get; init; }

        /// <summary>Window end (UTC, inclusive).</summary>
        public DateTime WindowEnd { get; init; }

        /// <summary>The entries.</summary>
        public IReadOnlyList<ArrCalendarEntry> Entries { get; init; } = Array.Empty<ArrCalendarEntry>();

        /// <summary>True when [start, end] lies inside the window.</summary>
        public bool Covers(DateTime start, DateTime end) => start >= WindowStart && end <= WindowEnd;
    }

    /// <summary>One <c>/health</c> check.</summary>
    public sealed class ArrHealthEntry
    {
        /// <summary>Check name.</summary>
        public string? Source { get; init; }

        /// <summary>ok / notice / warning / error.</summary>
        public string? Type { get; init; }

        /// <summary>Message (capped).</summary>
        public string? Message { get; init; }
    }

    /// <summary>One <c>/diskspace</c> or <c>/rootfolder</c> entry.</summary>
    public sealed class ArrDiskEntry
    {
        /// <summary>Path (admin only).</summary>
        public string? Path { get; init; }

        /// <summary>Free bytes.</summary>
        public long? FreeSpace { get; init; }

        /// <summary>Total bytes (disk space entries only).</summary>
        public long? TotalSpace { get; init; }

        /// <summary>Accessible (root folders only).</summary>
        public bool? Accessible { get; init; }
    }

    /// <summary>A quality profile (id and name only).</summary>
    public sealed class ArrProfileEntry
    {
        /// <summary>Id.</summary>
        public int Id { get; init; }

        /// <summary>Name.</summary>
        public string Name { get; init; } = string.Empty;
    }

    /// <summary>System facts of one instance.</summary>
    public sealed class ArrSystemSnapshot
    {
        /// <summary>App name.</summary>
        public string? AppName { get; init; }

        /// <summary>Version.</summary>
        public string? Version { get; init; }

        /// <summary>Health checks.</summary>
        public IReadOnlyList<ArrHealthEntry> Health { get; init; } = Array.Empty<ArrHealthEntry>();

        /// <summary>Disk space per mount.</summary>
        public IReadOnlyList<ArrDiskEntry> DiskSpace { get; init; } = Array.Empty<ArrDiskEntry>();

        /// <summary>Root folders.</summary>
        public IReadOnlyList<ArrDiskEntry> RootFolders { get; init; } = Array.Empty<ArrDiskEntry>();

        /// <summary>Quality profiles.</summary>
        public IReadOnlyList<ArrProfileEntry> QualityProfiles { get; init; } = Array.Empty<ArrProfileEntry>();
    }

    /// <summary>The result of reading a snapshot from the store.</summary>
    /// <typeparam name="T">Snapshot type.</typeparam>
    public sealed class ArrSnapshotRead<T>
        where T : class
    {
        /// <summary>The snapshot, or null when none could be loaded.</summary>
        public T? Value { get; init; }

        /// <summary>The latest refresh error when it failed after <see cref="Value"/> was loaded (or nothing loaded).</summary>
        public ArrError? Error { get; init; }

        /// <summary>When <see cref="Value"/> was read from the arr.</summary>
        public DateTimeOffset? LoadedAt { get; init; }

        /// <summary>True when the value is older than its freshness target (a refresh is on its way).</summary>
        public bool Stale { get; init; }
    }

    /// <summary>Lenient date parsing shared by the snapshot loaders (invariant culture, UTC).</summary>
    internal static class ArrDates
    {
        /// <summary>Parses an arr date string ("2026-10-10", "2026-10-10T12:00:00Z") as UTC; null when absent or invalid.</summary>
        public static DateTime? Parse(string? value)
        {
            if (string.IsNullOrWhiteSpace(value)) return null;
            if (DateTime.TryParse(value, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out var parsed))
            {
                return parsed;
            }
            return null;
        }
    }

    // ---------------- wire shapes (only the fields JE reads; System.Text.Json skips the rest) ----------------

    internal sealed class ArrWireImage
    {
        public string? CoverType { get; set; }

        public string? RemoteUrl { get; set; }

        public string? Url { get; set; }

        public static string? Poster(List<ArrWireImage>? images)
            => images?.FirstOrDefault(i => i.CoverType == "poster") is { } p ? p.RemoteUrl ?? p.Url : null;
    }

    internal sealed class ArrWireTag
    {
        public int Id { get; set; }

        public string? Label { get; set; }
    }

    internal sealed class ArrWireMovie
    {
        public int Id { get; set; }

        public string? Title { get; set; }

        public string? OriginalTitle { get; set; }

        public int? Year { get; set; }

        public int? TmdbId { get; set; }

        public string? ImdbId { get; set; }

        public bool? Monitored { get; set; }

        public bool? HasFile { get; set; }

        public long? SizeOnDisk { get; set; }

        public string? Path { get; set; }

        public int? QualityProfileId { get; set; }

        public List<int>? Tags { get; set; }

        public string? InCinemas { get; set; }

        public string? PhysicalRelease { get; set; }

        public string? DigitalRelease { get; set; }

        public JsonElement Releases { get; set; }

        public List<ArrWireImage>? Images { get; set; }
    }

    internal sealed class ArrWireStatistics
    {
        public int? EpisodeFileCount { get; set; }

        public int? EpisodeCount { get; set; }

        public double? PercentOfEpisodes { get; set; }

        public long? SizeOnDisk { get; set; }
    }

    internal sealed class ArrWireSeries
    {
        public int Id { get; set; }

        public string? Title { get; set; }

        public string? TitleSlug { get; set; }

        public int? TvdbId { get; set; }

        public int? TmdbId { get; set; }

        public string? ImdbId { get; set; }

        public bool? Monitored { get; set; }

        public string? Path { get; set; }

        public int? QualityProfileId { get; set; }

        public List<int>? Tags { get; set; }

        public ArrWireStatistics? Statistics { get; set; }

        public List<ArrWireImage>? Images { get; set; }
    }

    internal sealed class ArrWireEpisode
    {
        public int Id { get; set; }

        public int? SeriesId { get; set; }

        public int? TvdbId { get; set; }

        public string? ImdbId { get; set; }

        public int? SeasonNumber { get; set; }

        public int? EpisodeNumber { get; set; }

        public string? Title { get; set; }

        public string? Overview { get; set; }

        public string? AirDate { get; set; }

        public string? AirDateUtc { get; set; }

        public bool? HasFile { get; set; }

        public bool? Monitored { get; set; }

        public ArrWireSeries? Series { get; set; }
    }

    internal sealed class ArrWireStatusMessage
    {
        public string? Title { get; set; }

        public List<string>? Messages { get; set; }
    }

    internal sealed class ArrWireQueueRecord
    {
        public int Id { get; set; }

        public string? DownloadId { get; set; }

        public string? Title { get; set; }

        public string? Status { get; set; }

        public string? TrackedDownloadState { get; set; }

        public string? TrackedDownloadStatus { get; set; }

        public List<ArrWireStatusMessage>? StatusMessages { get; set; }

        public string? ErrorMessage { get; set; }

        public double? Size { get; set; }

        public double? Sizeleft { get; set; }

        public string? Timeleft { get; set; }

        public DateTime? EstimatedCompletionTime { get; set; }

        public string? Protocol { get; set; }

        public int? MovieId { get; set; }

        public int? SeriesId { get; set; }

        public int? EpisodeId { get; set; }

        public ArrWireMovie? Movie { get; set; }

        public ArrWireSeries? Series { get; set; }

        public ArrWireEpisode? Episode { get; set; }
    }

    internal sealed class ArrWireHistoryRecord
    {
        public int Id { get; set; }

        public string? EventType { get; set; }

        public DateTime? Date { get; set; }

        public string? DownloadId { get; set; }

        public int? MovieId { get; set; }

        public int? SeriesId { get; set; }

        public int? EpisodeId { get; set; }

        public ArrWireMovie? Movie { get; set; }

        public ArrWireSeries? Series { get; set; }

        public ArrWireEpisode? Episode { get; set; }
    }

    internal sealed class ArrWireHealth
    {
        public string? Source { get; set; }

        public string? Type { get; set; }

        public string? Message { get; set; }
    }

    internal sealed class ArrWireDisk
    {
        public string? Path { get; set; }

        public long? FreeSpace { get; set; }

        public long? TotalSpace { get; set; }

        public bool? Accessible { get; set; }
    }

    internal sealed class ArrWireProfile
    {
        public int Id { get; set; }

        public string? Name { get; set; }
    }
}
