using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Arr.Live
{
    /// <summary>
    /// Works out which titles changed between two values of a snapshot, as title keys. Pure
    /// functions; the diffs treat a first load (nothing before) as a baseline, and
    /// <see cref="FirstLoad"/> lists what a first load holds.
    /// <list type="bullet">
    /// <item><description>Queue: a row appeared or went, or its state, status, messages or whole
    /// percent of progress moved.</description></item>
    /// <item><description>Library: a title was added, removed, or a fact its status depends on
    /// changed (monitored, has file, size, episode counts, profile, path).</description></item>
    /// <item><description>History: new events (grabbed, imported, failed, deleted, renamed) since the
    /// previous read.</description></item>
    /// <item><description>Episodes of a series: has a file, monitored, air date or last search
    /// changed, or an episode appeared or went.</description></item>
    /// </list>
    /// </summary>
    public static class ArrChangeDetector
    {
        // A history read can return a record dated a little before the newest one already held.
        private static readonly TimeSpan HistorySkew = TimeSpan.FromMinutes(1);

        /// <summary>
        /// Title keys whose queue rows changed, plus those of <paramref name="departed"/> (rows an
        /// earlier paged read missed that this read confirmed gone).
        /// </summary>
        public static IReadOnlyCollection<string> Queue(ArrKind kind, ArrQueueSnapshot? before, ArrQueueSnapshot after, ArrLibrarySnapshot? library, IEnumerable<ArrQueueEntry>? departed = null)
        {
            if (before == null) return Array.Empty<string>();
            var a = QueueFingerprints(kind, before, library);
            var b = QueueFingerprints(kind, after, library);
            var changed = new HashSet<string>(StringComparer.Ordinal);
            // Rows an earlier paged read missed, confirmed gone by this read: neither side holds them.
            foreach (var r in departed ?? Array.Empty<ArrQueueEntry>())
            {
                if (LeafKey(kind, r.TmdbId, r.TvdbId, r.MovieId, r.SeriesId, r.SeasonNumber, r.EpisodeNumber, library) is { } leaf) changed.Add(leaf);
            }
            foreach (var (leaf, print) in b)
            {
                if (!a.TryGetValue(leaf, out var old) || !string.Equals(old, print, StringComparison.Ordinal)) changed.Add(leaf);
            }
            foreach (var leaf in a.Keys)
            {
                if (!b.ContainsKey(leaf)) changed.Add(leaf);
            }
            return Expand(changed);
        }

        /// <summary>
        /// Title keys whose library entry changed. <paramref name="onlyIds"/> limits the comparison
        /// to those arr ids (a live patch); null compares everything.
        /// </summary>
        public static IReadOnlyCollection<string> Library(ArrLibrarySnapshot? before, ArrLibrarySnapshot after, IReadOnlyCollection<int>? onlyIds = null)
        {
            if (before == null) return Array.Empty<string>();
            var keys = new HashSet<string>(StringComparer.Ordinal);
            if (onlyIds != null)
            {
                foreach (var id in onlyIds)
                {
                    CompareMovie(before.MovieById(id), after.MovieById(id), keys);
                    CompareSeries(before.SeriesById(id), after.SeriesById(id), keys);
                }
                return keys;
            }

            foreach (var m in after.Movies) CompareMovie(before.MovieById(m.Id), m, keys);
            foreach (var m in before.Movies)
            {
                if (after.MovieById(m.Id) == null) CompareMovie(m, null, keys);
            }
            foreach (var s in after.Series) CompareSeries(before.SeriesById(s.Id), s, keys);
            foreach (var s in before.Series)
            {
                if (after.SeriesById(s.Id) == null) CompareSeries(s, null, keys);
            }
            return keys;
        }

        /// <summary>
        /// Title keys of history events newer than the previous read, and the arr ids of titles whose
        /// files changed (imported, deleted, renamed) so their library entry can be re-read.
        /// </summary>
        public static (IReadOnlyCollection<string> Keys, IReadOnlyCollection<int> FileChangedIds) History(ArrKind kind, ArrHistorySnapshot? before, ArrHistorySnapshot after, ArrLibrarySnapshot? library)
        {
            if (before == null) return (Array.Empty<string>(), Array.Empty<int>());
            var known = new HashSet<int>(before.Records.Select(r => r.Id));
            var since = before.Watermark is DateTime w ? w - HistorySkew : DateTime.MinValue;
            var leaves = new HashSet<string>(StringComparer.Ordinal);
            var reread = new HashSet<int>();
            foreach (var r in after.Records)
            {
                if (known.Contains(r.Id) || (r.Date is DateTime d && d < since)) continue;
                if (LeafKey(kind, r.TmdbId, r.TvdbId, r.MovieId, r.SeriesId, r.SeasonNumber, r.EpisodeNumber, library) is { } leaf) leaves.Add(leaf);
                var titleId = kind == ArrKind.Radarr ? r.MovieId : r.SeriesId;
                if (titleId is > 0 and var id && ChangesFiles(r.EventType)) reread.Add(id);
            }
            return (Expand(leaves), reread);
        }

        /// <summary>
        /// Title keys of a series' episodes whose facts changed between two reads (has a file,
        /// monitored, air date, last search), plus their season and series. Episodes that appeared
        /// or went count too. Needs the series in the library index (for its TVDB id).
        /// </summary>
        public static IReadOnlyCollection<string> Episodes(ArrEpisodesSnapshot? before, ArrEpisodesSnapshot after, ArrLibrarySnapshot? library)
        {
            if (before == null || library?.SeriesById(after.SeriesId)?.TvdbId is not (> 0 and var tvdb)) return Array.Empty<string>();
            var leaves = new HashSet<string>(StringComparer.Ordinal);
            foreach (var e in after.Episodes)
            {
                var old = before.Find(e.SeasonNumber, e.EpisodeNumber);
                if (old == null || old.HasFile != e.HasFile || old.Monitored != e.Monitored || old.AirDateUtc != e.AirDateUtc || old.LastSearchTime != e.LastSearchTime)
                    leaves.Add(ArrTitleKey.Episode(tvdb, e.SeasonNumber, e.EpisodeNumber));
            }
            foreach (var e in before.Episodes)
            {
                if (after.Find(e.SeasonNumber, e.EpisodeNumber) == null) leaves.Add(ArrTitleKey.Episode(tvdb, e.SeasonNumber, e.EpisodeNumber));
            }
            return Expand(leaves);
        }

        /// <summary>
        /// The keys a snapshot's first load holds: every title of a library, the titles with queue
        /// rows or history events (with their seasons and episodes), a series whose episodes were
        /// read. Null when that is more than one feed read may carry (announce a reset instead);
        /// empty for snapshots the statuses don't use.
        /// </summary>
        public static IReadOnlyCollection<string>? FirstLoad(ArrKind kind, ArrSnapshotKind snapshot, object after, ArrLibrarySnapshot? library)
        {
            var leaves = new HashSet<string>(StringComparer.Ordinal);
            switch (after)
            {
                case ArrLibrarySnapshot lib when snapshot == ArrSnapshotKind.Library:
                    foreach (var m in lib.Movies) if (m.TmdbId is > 0 and var t) leaves.Add(ArrTitleKey.Movie(t));
                    foreach (var s in lib.Series) if (s.TvdbId is > 0 and var v) leaves.Add(ArrTitleKey.Series(v));
                    break;
                case ArrQueueSnapshot queue when snapshot == ArrSnapshotKind.Queue:
                    foreach (var r in queue.Records)
                        if (LeafKey(kind, r.TmdbId, r.TvdbId, r.MovieId, r.SeriesId, r.SeasonNumber, r.EpisodeNumber, library) is { } leaf) leaves.Add(leaf);
                    break;
                case ArrHistorySnapshot history when snapshot == ArrSnapshotKind.History:
                    foreach (var r in history.Records)
                        if (LeafKey(kind, r.TmdbId, r.TvdbId, r.MovieId, r.SeriesId, r.SeasonNumber, r.EpisodeNumber, library) is { } leaf) leaves.Add(leaf);
                    break;
                case ArrEpisodesSnapshot episodes when snapshot == ArrSnapshotKind.Episodes:
                    // Its season and episode surfaces follow the series key.
                    if (library?.SeriesById(episodes.SeriesId)?.TvdbId is > 0 and var tvdb) leaves.Add(ArrTitleKey.Series(tvdb));
                    break;
                default:
                    return Array.Empty<string>();
            }
            var keys = Expand(leaves);
            return keys.Count > ArrChangeFeed.MaxKeysPerRead ? null : keys;
        }

        /// <summary>True for history events after which the title's files (and so its library entry) changed.</summary>
        internal static bool ChangesFiles(string? eventType)
            => !string.IsNullOrEmpty(eventType)
               && (eventType.EndsWith("Imported", StringComparison.OrdinalIgnoreCase)
                   || eventType.EndsWith("Deleted", StringComparison.OrdinalIgnoreCase)
                   || eventType.EndsWith("Renamed", StringComparison.OrdinalIgnoreCase));

        /// <summary>The most specific key for a row: a movie, or a series/season/episode.</summary>
        internal static string? LeafKey(ArrKind kind, int? tmdbId, int? tvdbId, int? movieId, int? seriesId, int? season, int? episode, ArrLibrarySnapshot? library)
        {
            if (kind == ArrKind.Radarr)
            {
                var tmdb = tmdbId is > 0 ? tmdbId : (movieId is int mid ? library?.MovieById(mid)?.TmdbId : null);
                return tmdb is > 0 and var t ? ArrTitleKey.Movie(t) : null;
            }
            var tvdb = tvdbId is > 0 ? tvdbId : (seriesId is int sid ? library?.SeriesById(sid)?.TvdbId : null);
            if (tvdb is not (> 0 and var v)) return null;
            if (season is int s && s >= 0)
                return episode is int e && e >= 0 ? ArrTitleKey.Episode(v, s, e) : ArrTitleKey.Season(v, s);
            return ArrTitleKey.Series(v);
        }

        /// <summary>Leaf keys plus their season and series keys.</summary>
        internal static IReadOnlyCollection<string> Expand(IEnumerable<string> leaves)
        {
            var all = new HashSet<string>(StringComparer.Ordinal);
            foreach (var leaf in leaves)
            {
                if (!ArrTitleKey.TryParse(leaf, out var type, out var id, out var season, out var episode)) continue;
                if (type == "movie") all.Add(leaf);
                else foreach (var k in ArrTitleKey.WithParents(id, season, episode)) all.Add(k);
            }
            return all;
        }

        private static Dictionary<string, string> QueueFingerprints(ArrKind kind, ArrQueueSnapshot queue, ArrLibrarySnapshot? library)
        {
            var rows = new Dictionary<string, List<(int Id, string Print)>>(StringComparer.Ordinal);
            foreach (var r in queue.Records)
            {
                if (LeafKey(kind, r.TmdbId, r.TvdbId, r.MovieId, r.SeriesId, r.SeasonNumber, r.EpisodeNumber, library) is not { } leaf) continue;
                if (!rows.TryGetValue(leaf, out var list)) rows[leaf] = list = new List<(int, string)>();
                list.Add((r.Id, RowPrint(r)));
            }
            return rows.ToDictionary(
                kv => kv.Key,
                kv => string.Join(";", kv.Value.OrderBy(x => x.Id).Select(x => x.Print)),
                StringComparer.Ordinal);
        }

        // What the status shows about a row: progress in whole percent, never the ever-changing
        // seconds left, so a quiet download doesn't wake every browser on each queue read.
        private static string RowPrint(ArrQueueEntry r)
        {
            var percent = r.Size is > 0 && r.SizeLeft is double left
                ? Math.Clamp((int)Math.Floor((r.Size.Value - left) / r.Size.Value * 100), 0, 100)
                : -1;
            return string.Join(
                "|",
                r.Id.ToString(CultureInfo.InvariantCulture),
                r.DownloadId ?? string.Empty,
                r.Status ?? string.Empty,
                r.TrackedDownloadState ?? string.Empty,
                r.TrackedDownloadStatus ?? string.Empty,
                percent.ToString(CultureInfo.InvariantCulture),
                r.ErrorMessage ?? string.Empty,
                string.Join("/", r.StatusMessages));
        }

        private static void CompareMovie(ArrMovieEntry? a, ArrMovieEntry? b, HashSet<string> keys)
        {
            if (a == null && b == null) return;
            if (a != null && b != null && ArrLibraryFacts.Same(a, b)) return;
            foreach (var tmdb in new[] { a?.TmdbId, b?.TmdbId })
            {
                if (tmdb is > 0 and var t) keys.Add(ArrTitleKey.Movie(t));
            }
        }

        private static void CompareSeries(ArrSeriesEntry? a, ArrSeriesEntry? b, HashSet<string> keys)
        {
            if (a == null && b == null) return;
            if (a != null && b != null && ArrLibraryFacts.Same(a, b)) return;
            foreach (var tvdb in new[] { a?.TvdbId, b?.TvdbId })
            {
                if (tvdb is > 0 and var t) keys.Add(ArrTitleKey.Series(t));
            }
        }
    }
}
