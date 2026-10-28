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
        /// <summary>The episodes of one Sonarr series (read on demand, a few series kept).</summary>
        Episodes,
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

        /// <summary>Radarr's release status (tba, announced, inCinemas, released, deleted).</summary>
        public string? Status { get; init; }

        /// <summary>Radarr considers the movie available (its minimum availability has been reached).</summary>
        public bool IsAvailable { get; init; } = true;

        /// <summary>Minimum availability (announced, inCinemas, released).</summary>
        public string? MinimumAvailability { get; init; }

        /// <summary>Cinema release (UTC).</summary>
        public DateTime? InCinemas { get; init; }

        /// <summary>Digital release (UTC).</summary>
        public DateTime? DigitalRelease { get; init; }

        /// <summary>Physical release (UTC).</summary>
        public DateTime? PhysicalRelease { get; init; }

        /// <summary>When the movie was added to Radarr (UTC).</summary>
        public DateTime? Added { get; init; }

        /// <summary>When Radarr last searched for it (UTC), if it says.</summary>
        public DateTime? LastSearchTime { get; init; }
    }

    /// <summary>One season of a Sonarr series (statistics as Sonarr reports them).</summary>
    public sealed class ArrSeasonEntry
    {
        /// <summary>Season number (0 = specials).</summary>
        public int SeasonNumber { get; init; }

        /// <summary>Monitored in Sonarr.</summary>
        public bool Monitored { get; init; }

        /// <summary>Episode files on disk.</summary>
        public int EpisodeFileCount { get; init; }

        /// <summary>Monitored episodes that have aired (or have a file).</summary>
        public int EpisodeCount { get; init; }

        /// <summary>Every episode Sonarr knows in the season.</summary>
        public int TotalEpisodeCount { get; init; }

        /// <summary>Next episode air time (UTC).</summary>
        public DateTime? NextAiring { get; init; }
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

        /// <summary>Sonarr's series status (continuing, ended, upcoming, deleted).</summary>
        public string? Status { get; init; }

        /// <summary>Next episode air time (UTC).</summary>
        public DateTime? NextAiring { get; init; }

        /// <summary>When the series was added to Sonarr (UTC).</summary>
        public DateTime? Added { get; init; }

        /// <summary>Seasons with their statistics.</summary>
        public IReadOnlyList<ArrSeasonEntry> Seasons { get; init; } = Array.Empty<ArrSeasonEntry>();
    }

    /// <summary>One episode of a Sonarr series (slim).</summary>
    public sealed class ArrEpisodeEntry
    {
        /// <summary>Sonarr episode id.</summary>
        public int Id { get; init; }

        /// <summary>Season number.</summary>
        public int SeasonNumber { get; init; }

        /// <summary>Episode number.</summary>
        public int EpisodeNumber { get; init; }

        /// <summary>Episode title as Sonarr lists it (what the season-page identity check matches TMDB's to), if any.</summary>
        public string? Title { get; init; }

        /// <summary>Air time (UTC), if known.</summary>
        public DateTime? AirDateUtc { get; init; }

        /// <summary>
        /// The air date is a calendar day only (Sonarr had no air time, so <see cref="AirDateUtc"/> is
        /// its local air date read as midnight UTC): shown as that day wherever the viewer is.
        /// </summary>
        public bool AirDateIsDay { get; init; }

        /// <summary>Has a file.</summary>
        public bool HasFile { get; init; }

        /// <summary>Monitored.</summary>
        public bool Monitored { get; init; }

        /// <summary>When Sonarr last searched for it (UTC), if it says.</summary>
        public DateTime? LastSearchTime { get; init; }
    }

    /// <summary>The episodes of one Sonarr series.</summary>
    public sealed class ArrEpisodesSnapshot
    {
        private readonly Dictionary<(int, int), ArrEpisodeEntry> _byNumber = new();

        /// <summary>Builds the snapshot and its (season, episode) index (first wins on duplicates).</summary>
        public ArrEpisodesSnapshot(int seriesId, IReadOnlyList<ArrEpisodeEntry> episodes)
        {
            SeriesId = seriesId;
            Episodes = episodes;
            foreach (var e in episodes) _byNumber.TryAdd((e.SeasonNumber, e.EpisodeNumber), e);
        }

        /// <summary>Sonarr series id.</summary>
        public int SeriesId { get; }

        /// <summary>Every episode.</summary>
        public IReadOnlyList<ArrEpisodeEntry> Episodes { get; }

        /// <summary>The episode with this season and episode number, or null.</summary>
        public ArrEpisodeEntry? Find(int season, int episode) => _byNumber.TryGetValue((season, episode), out var e) ? e : null;
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
        private readonly Dictionary<string, ArrMovieEntry> _moviesByImdb = new(StringComparer.OrdinalIgnoreCase);
        private readonly Dictionary<int, ArrMovieEntry> _moviesById = new();
        private readonly Dictionary<int, ArrSeriesEntry> _seriesById = new();

        /// <summary>Builds the snapshot and its indexes. The first title wins on a duplicate id.</summary>
        public ArrLibrarySnapshot(IReadOnlyList<ArrMovieEntry> movies, IReadOnlyList<ArrSeriesEntry> series, IReadOnlyDictionary<int, string> tags)
        {
            Movies = movies;
            Series = series;
            Tags = tags;
            foreach (var m in movies)
            {
                if (m.TmdbId is > 0 and var tmdb) _moviesByTmdb.TryAdd(tmdb, m);
                if (!string.IsNullOrWhiteSpace(m.ImdbId)) _moviesByImdb.TryAdd(m.ImdbId.Trim(), m);
                _moviesById.TryAdd(m.Id, m);
            }
            foreach (var s in series)
            {
                _seriesById.TryAdd(s.Id, s);
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

        /// <summary>The movie with this IMDb id, or null.</summary>
        public ArrMovieEntry? MovieByImdb(string? imdbId)
            => !string.IsNullOrWhiteSpace(imdbId) && _moviesByImdb.TryGetValue(imdbId.Trim(), out var m) ? m : null;

        /// <summary>The movie with this Radarr id, or null.</summary>
        public ArrMovieEntry? MovieById(int id) => _moviesById.TryGetValue(id, out var m) ? m : null;

        /// <summary>The series with this Sonarr id, or null.</summary>
        public ArrSeriesEntry? SeriesById(int id) => _seriesById.TryGetValue(id, out var s) ? s : null;

        /// <summary>The series with this TVDB id, or null.</summary>
        public ArrSeriesEntry? SeriesByTvdb(int tvdbId) => _seriesByTvdb.TryGetValue(tvdbId, out var s) ? s : null;

        /// <summary>The series with this TMDB id, or null.</summary>
        public ArrSeriesEntry? SeriesByTmdb(int tmdbId) => _seriesByTmdb.TryGetValue(tmdbId, out var s) ? s : null;

        /// <summary>The series with this IMDb id, or null.</summary>
        public ArrSeriesEntry? SeriesByImdb(string? imdbId)
            => !string.IsNullOrWhiteSpace(imdbId) && _seriesByImdb.TryGetValue(imdbId.Trim(), out var s) ? s : null;

        /// <summary>
        /// A copy with titles added or replaced (by arr id) and removed (by arr id); the tag labels
        /// stay. Returns this snapshot when nothing would change.
        /// </summary>
        public ArrLibrarySnapshot With(IReadOnlyCollection<ArrMovieEntry> movies, IReadOnlyCollection<ArrSeriesEntry> series, IReadOnlyCollection<int> removedIds)
        {
            var changed = removedIds.Any(id => _moviesById.ContainsKey(id) || _seriesById.ContainsKey(id))
                || movies.Any(m => !_moviesById.TryGetValue(m.Id, out var old) || !ArrLibraryFacts.Same(old, m))
                || series.Any(x => !_seriesById.TryGetValue(x.Id, out var old) || !ArrLibraryFacts.Same(old, x));
            if (!changed) return this;

            var removed = new HashSet<int>(removedIds);
            var movieUpserts = movies.GroupBy(m => m.Id).ToDictionary(g => g.Key, g => g.Last());
            var seriesUpserts = series.GroupBy(x => x.Id).ToDictionary(g => g.Key, g => g.Last());
            var nextMovies = new List<ArrMovieEntry>(Movies.Count + movieUpserts.Count);
            foreach (var m in Movies)
            {
                if (removed.Contains(m.Id)) continue;
                nextMovies.Add(movieUpserts.Remove(m.Id, out var replacement) ? replacement : m);
            }
            nextMovies.AddRange(movieUpserts.Values.Where(m => !removed.Contains(m.Id)));
            var nextSeries = new List<ArrSeriesEntry>(Series.Count + seriesUpserts.Count);
            foreach (var x in Series)
            {
                if (removed.Contains(x.Id)) continue;
                nextSeries.Add(seriesUpserts.Remove(x.Id, out var replacement) ? replacement : x);
            }
            nextSeries.AddRange(seriesUpserts.Values.Where(x => !removed.Contains(x.Id)));
            return new ArrLibrarySnapshot(nextMovies, nextSeries, Tags);
        }

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

    /// <summary>Compares library entries on the facts a title's status depends on.</summary>
    public static class ArrLibraryFacts
    {
        /// <summary>True when two movie entries agree on everything the store keeps.</summary>
        public static bool Same(ArrMovieEntry a, ArrMovieEntry b)
            => a.Id == b.Id && a.TmdbId == b.TmdbId && a.Monitored == b.Monitored && a.HasFile == b.HasFile
               && a.SizeOnDisk == b.SizeOnDisk && a.QualityProfileId == b.QualityProfileId
               && string.Equals(a.Path, b.Path, StringComparison.Ordinal) && string.Equals(a.Title, b.Title, StringComparison.Ordinal)
               && a.Year == b.Year && string.Equals(a.ImdbId, b.ImdbId, StringComparison.Ordinal) && a.Tags.SequenceEqual(b.Tags)
               && string.Equals(a.Status, b.Status, StringComparison.Ordinal) && a.IsAvailable == b.IsAvailable
               && string.Equals(a.MinimumAvailability, b.MinimumAvailability, StringComparison.Ordinal)
               && a.InCinemas == b.InCinemas && a.DigitalRelease == b.DigitalRelease && a.PhysicalRelease == b.PhysicalRelease
               && a.Added == b.Added && a.LastSearchTime == b.LastSearchTime;

        /// <summary>True when two series entries agree on everything the store keeps.</summary>
        public static bool Same(ArrSeriesEntry a, ArrSeriesEntry b)
            => a.Id == b.Id && a.TvdbId == b.TvdbId && a.TmdbId == b.TmdbId && a.Monitored == b.Monitored
               && a.EpisodeFileCount == b.EpisodeFileCount && a.EpisodeCount == b.EpisodeCount
               && a.PercentOfEpisodes.Equals(b.PercentOfEpisodes) && a.SizeOnDisk == b.SizeOnDisk
               && a.QualityProfileId == b.QualityProfileId && string.Equals(a.Path, b.Path, StringComparison.Ordinal)
               && string.Equals(a.Title, b.Title, StringComparison.Ordinal) && string.Equals(a.TitleSlug, b.TitleSlug, StringComparison.Ordinal)
               && string.Equals(a.ImdbId, b.ImdbId, StringComparison.Ordinal) && a.Tags.SequenceEqual(b.Tags)
               && string.Equals(a.Status, b.Status, StringComparison.Ordinal) && a.NextAiring == b.NextAiring && a.Added == b.Added
               && a.Seasons.Count == b.Seasons.Count && a.Seasons.Zip(b.Seasons).All(p => Same(p.First, p.Second));

        /// <summary>True when two season entries agree (number, monitored, statistics, next airing).</summary>
        public static bool Same(ArrSeasonEntry a, ArrSeasonEntry b)
            => a.SeasonNumber == b.SeasonNumber && a.Monitored == b.Monitored && a.EpisodeFileCount == b.EpisodeFileCount
               && a.EpisodeCount == b.EpisodeCount && a.TotalEpisodeCount == b.TotalEpisodeCount && a.NextAiring == b.NextAiring;
    }

    /// <summary>One queue row (slim). Status messages are capped (5 × 200 characters).</summary>
    public sealed class ArrQueueEntry
    {
        /// <summary>The title's arr folder, kept only for server-side library access decisions.</summary>
        [System.Text.Json.Serialization.JsonIgnore]
        public string? TitlePath { get; init; }
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

        /// <summary>Download client name (admin only).</summary>
        public string? DownloadClient { get; init; }

        /// <summary>Quality name, e.g. "Bluray-1080p" (admin only).</summary>
        public string? Quality { get; init; }

        /// <summary>Custom format score (admin only).</summary>
        public int? CustomFormatScore { get; init; }

        /// <summary>When the arr added the row (the grab), UTC.</summary>
        public DateTime? Added { get; init; }
    }

    /// <summary>The whole queue of one instance.</summary>
    public sealed class ArrQueueSnapshot
    {
        /// <summary>Rows in the arr's order.</summary>
        public IReadOnlyList<ArrQueueEntry> Records { get; init; } = Array.Empty<ArrQueueEntry>();

        /// <summary>The arr's <c>totalRecords</c>.</summary>
        public int TotalRecords { get; init; }

        /// <summary>
        /// True when the read took more than one page. Rows can move between pages unseen even when
        /// the distinct rows match totalRecords (one leaves before a page boundary while another
        /// joins after it), so a paged read does not prove that a row it lacks has left, nor that a
        /// download's rows are all in it.
        /// </summary>
        public bool Paged { get; init; }

        /// <summary>True when the row cap stopped the read early.</summary>
        public bool Truncated { get; init; }

        /// <summary>
        /// True when rows moved between pages during two reads in a row, so fewer distinct rows came
        /// back than the arr reported: every row held is real, but some may be missing. It never
        /// replaces a recent complete read, and no row is taken for a download that left the queue
        /// because of it.
        /// </summary>
        public bool Incomplete { get; init; }
    }

    /// <summary>One history record (slim).</summary>
    public sealed class ArrHistoryEntry
    {
        /// <summary>The title's arr folder, kept only for server-side library access decisions.</summary>
        [System.Text.Json.Serialization.JsonIgnore]
        public string? TitlePath { get; init; }
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

        /// <summary>Release name the event was about (admin only).</summary>
        public string? SourceTitle { get; init; }

        /// <summary>Quality name.</summary>
        public string? Quality { get; init; }

        /// <summary>For imports: where the arr put the file, in the arr's view of the disk (admin only).</summary>
        public string? ImportedPath { get; init; }

        /// <summary>For failures: the arr's message (admin only).</summary>
        public string? Message { get; init; }

        /// <summary>
        /// For deleted files: why the arr deleted it ("Upgrade" when a better copy replaced it, "Manual", ...). Kept
        /// server-side only (acquisition badges confirm upgrades with it).
        /// </summary>
        [System.Text.Json.Serialization.JsonIgnore]
        public string? Reason { get; init; }
    }

    /// <summary>Recent history of one instance, newest first, with the catch-up watermark.</summary>
    public sealed class ArrHistorySnapshot
    {
        /// <summary>Records, newest first (bounded ring).</summary>
        public IReadOnlyList<ArrHistoryEntry> Records { get; init; } = Array.Empty<ArrHistoryEntry>();

        /// <summary>Date of the newest record; the next <c>history/since</c> read starts here.</summary>
        public DateTime? Watermark { get; init; }

        /// <summary>The last complete full read, or the first attempt until one completes; see <see cref="FullReadDue"/>.</summary>
        public DateTimeOffset FullReadAt { get; init; }

        /// <summary>The full read stayed short and must be retried on the next history poll.</summary>
        public bool FullReadDue { get; init; }

        /// <summary>
        /// How many records the arr's whole history holds, as far as JE knows: its <c>totalRecords</c>
        /// at the latest full read plus the records added since (never fewer than the ring holds);
        /// null until a full read reported it.
        /// </summary>
        public int? ArrTotal { get; init; }
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

        /// <summary>Sonarr had no air time for the episode: <see cref="AirDateUtc"/> is its air day (midnight UTC).</summary>
        public bool AirDateIsDay { get; init; }

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

        /// <summary>Scheduled tasks (empty when the instance could not list them).</summary>
        public IReadOnlyList<ArrTaskEntry> Tasks { get; init; } = Array.Empty<ArrTaskEntry>();
    }

    /// <summary>One scheduled task of an instance (<c>/system/task</c>).</summary>
    public sealed class ArrTaskEntry
    {
        /// <summary>Display name ("RSS Sync").</summary>
        public string Name { get; init; } = string.Empty;

        /// <summary>Command name ("RssSync").</summary>
        public string? TaskName { get; init; }

        /// <summary>Interval in minutes.</summary>
        public int Interval { get; init; }

        /// <summary>When it last ran (UTC).</summary>
        public DateTime? LastExecution { get; init; }

        /// <summary>When it runs next (UTC).</summary>
        public DateTime? NextExecution { get; init; }

        /// <summary>How long the last run took ("00:00:01.2345").</summary>
        public string? LastDuration { get; init; }
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

        /// <summary>
        /// Queue and history only: the value held is older than the longest it may be served and
        /// no read since has worked (the instance is down, or still hasn't answered). It is kept
        /// (<see cref="Value"/>), but says nothing about now: what is downloading is unknown.
        /// </summary>
        public bool Expired { get; init; }

        /// <summary>
        /// The client (the connection) the value was read through: a press's facts are proven on one connection, and what it
        /// sends goes through that same client (<see cref="ArrClientFactory.Bound(ArrClient, bool)"/>). Server-only.
        /// </summary>
        internal ArrClient? ReadBy { get; set; }
    }

    /// <summary>An instance's snapshots as a background reader got them (<see cref="ArrStateStore.ReadInBackgroundAsync"/>).</summary>
    /// <param name="Library">The library index.</param>
    /// <param name="Queue">The download queue.</param>
    /// <param name="History">Recent history.</param>
    /// <param name="System">Health, disks, root folders and tasks.</param>
    public sealed record ArrBackgroundRead(
        ArrSnapshotRead<ArrLibrarySnapshot> Library,
        ArrSnapshotRead<ArrQueueSnapshot> Queue,
        ArrSnapshotRead<ArrHistorySnapshot> History,
        ArrSnapshotRead<ArrSystemSnapshot> System);

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

        public string? Status { get; set; }

        public bool? IsAvailable { get; set; }

        public string? MinimumAvailability { get; set; }

        public string? Added { get; set; }

        public string? LastSearchTime { get; set; }

        public JsonElement Releases { get; set; }

        public List<ArrWireImage>? Images { get; set; }
    }

    internal sealed class ArrWireStatistics
    {
        public int? EpisodeFileCount { get; set; }

        public int? EpisodeCount { get; set; }

        public int? TotalEpisodeCount { get; set; }

        public string? NextAiring { get; set; }

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

        public string? Status { get; set; }

        public string? NextAiring { get; set; }

        public string? Added { get; set; }

        public List<ArrWireSeason>? Seasons { get; set; }
    }

    internal sealed class ArrWireSeason
    {
        public int SeasonNumber { get; set; }

        public bool? Monitored { get; set; }

        public ArrWireStatistics? Statistics { get; set; }
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

        public string? LastSearchTime { get; set; }

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

        public string? DownloadClient { get; set; }

        public ArrWireQualityModel? Quality { get; set; }

        public int? CustomFormatScore { get; set; }

        public int? SeasonNumber { get; set; }

        public string? Added { get; set; }
    }

    internal sealed class ArrWireQualityModel
    {
        public ArrWireQuality? Quality { get; set; }
    }

    internal sealed class ArrWireQuality
    {
        public string? Name { get; set; }
    }

    internal sealed class ArrWireHistoryRecord
    {
        public int Id { get; set; }

        public string? SourceTitle { get; set; }

        public ArrWireQualityModel? Quality { get; set; }

        public Dictionary<string, JsonElement>? Data { get; set; }

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

    internal sealed class ArrWireTask
    {
        public string? Name { get; set; }

        public string? TaskName { get; set; }

        public int? Interval { get; set; }

        public string? LastExecution { get; set; }

        public string? NextExecution { get; set; }

        public string? LastDuration { get; set; }
    }

    internal sealed class ArrWireProfile
    {
        public int Id { get; set; }

        public string? Name { get; set; }
    }
}
