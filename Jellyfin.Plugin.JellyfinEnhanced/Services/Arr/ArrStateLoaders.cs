using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Arr
{
    /// <summary>
    /// Reads each snapshot from an arr and projects it to the slim shapes the store keeps. Every
    /// load first checks <c>system/status</c> (cached by the client for 10 minutes) so a URL that
    /// answers with the wrong app is reported as <see cref="ArrErrorKind.WrongApp"/> instead of
    /// being parsed as if it were the right one.
    /// </summary>
    internal static class ArrStateLoaders
    {
        /// <summary>History records read on a full (non-incremental) load.</summary>
        internal const int HistoryFullRead = 1000;

        /// <summary>History records kept per instance.</summary>
        internal const int HistoryRingSize = 2000;

        /// <summary>Queue rows read per instance at most.</summary>
        internal const int QueueMaxRecords = 20_000;

        /// <summary>Calendar window kept in memory: from at least this many days before today (and the whole previous month)...</summary>
        internal const int CalendarDaysBack = 35;

        /// <summary>...to this many days after today.</summary>
        internal const int CalendarDaysAhead = 100;

        private const int MaxStatusMessages = 5;
        private const int MaxMessageLength = 200;
        // A full re-read drops records the arr deleted (with a deleted title) and brings back older
        // imports that a burst of other events pushed out of the ring.
        private static readonly TimeSpan HistoryFullResync = TimeSpan.FromHours(1);

        /// <summary>Null when the URL answers as the expected app; the error otherwise.</summary>
        internal static async Task<ArrError?> CheckAppAsync(ArrClient client, CancellationToken ct)
        {
            var status = await client.GetSystemStatusAsync(false, ct).ConfigureAwait(false);
            return status.Ok ? null : status.Error;
        }

        /// <summary>Every movie or series plus the tag labels.</summary>
        internal static async Task<ArrResult<ArrLibrarySnapshot>> LoadLibraryAsync(ArrClient client, CancellationToken ct)
        {
            if (await CheckAppAsync(client, ct).ConfigureAwait(false) is { } wrong) return ArrResult<ArrLibrarySnapshot>.Failure(wrong);

            var tagsResult = await client.GetAsync<List<ArrWireTag>>("tag", null, ArrCallClass.Read, ct).ConfigureAwait(false);
            if (!tagsResult.Ok) return ArrResult<ArrLibrarySnapshot>.Failure(tagsResult.Error!);
            var tags = new Dictionary<int, string>();
            foreach (var t in tagsResult.Value!)
            {
                if (!string.IsNullOrEmpty(t.Label)) tags[t.Id] = t.Label!;
            }

            if (client.Connection.Kind == ArrKind.Radarr)
            {
                var movies = await client.GetAsync<List<ArrWireMovie>>("movie", null, ArrCallClass.List, ct).ConfigureAwait(false);
                if (!movies.Ok) return ArrResult<ArrLibrarySnapshot>.Failure(movies.Error!);
                return ArrResult<ArrLibrarySnapshot>.Success(new ArrLibrarySnapshot(movies.Value!.Select(ToMovie).ToList(), Array.Empty<ArrSeriesEntry>(), tags));
            }

            var series = await client.GetAsync<List<ArrWireSeries>>("series", null, ArrCallClass.List, ct).ConfigureAwait(false);
            if (!series.Ok) return ArrResult<ArrLibrarySnapshot>.Failure(series.Error!);
            return ArrResult<ArrLibrarySnapshot>.Success(new ArrLibrarySnapshot(Array.Empty<ArrMovieEntry>(), series.Value!.Select(ToSeries).ToList(), tags));
        }

        /// <summary>Every episode of one Sonarr series.</summary>
        internal static async Task<ArrResult<ArrEpisodesSnapshot>> LoadEpisodesAsync(ArrClient client, int seriesId, CancellationToken ct)
        {
            if (await CheckAppAsync(client, ct).ConfigureAwait(false) is { } wrong) return ArrResult<ArrEpisodesSnapshot>.Failure(wrong);
            var episodes = await client.GetAsync<List<ArrWireEpisode>>("episode",
                Query(("seriesId", seriesId.ToString(CultureInfo.InvariantCulture))), ArrCallClass.List, ct).ConfigureAwait(false);
            if (!episodes.Ok) return ArrResult<ArrEpisodesSnapshot>.Failure(episodes.Error!);
            var list = episodes.Value!
                .Where(e => e.SeasonNumber.HasValue && e.EpisodeNumber.HasValue)
                .Select(e => new ArrEpisodeEntry
                {
                    Id = e.Id,
                    SeasonNumber = e.SeasonNumber!.Value,
                    EpisodeNumber = e.EpisodeNumber!.Value,
                    AirDateUtc = ArrDates.Parse(e.AirDateUtc ?? e.AirDate),
                    AirDateIsDay = string.IsNullOrWhiteSpace(e.AirDateUtc) && !string.IsNullOrWhiteSpace(e.AirDate),
                    HasFile = e.HasFile ?? false,
                    Monitored = e.Monitored ?? false,
                    LastSearchTime = ArrDates.Parse(e.LastSearchTime),
                })
                .ToList();
            return ArrResult<ArrEpisodesSnapshot>.Success(new ArrEpisodesSnapshot(seriesId, list));
        }

        /// <summary>
        /// The whole queue, every page (the old routes stopped at 1000 rows), counted by row id. Rows
        /// move between pages while they are read (both arrs sort by the changing time left): when
        /// fewer distinct rows came back than the arr reported, the queue is read once more; when
        /// that is short too, the read is published marked <see cref="ArrQueueSnapshot.Incomplete"/>.
        /// That is not a failure (the arr answered): the slot keeps a recent complete snapshot over
        /// it, and no row that was merely missed is taken for a download that left the queue.
        /// </summary>
        internal static async Task<ArrResult<ArrQueueSnapshot>> LoadQueueAsync(ArrClient client, CancellationToken ct)
        {
            if (await CheckAppAsync(client, ct).ConfigureAwait(false) is { } wrong) return ArrResult<ArrQueueSnapshot>.Failure(wrong);

            var query = client.Connection.Kind == ArrKind.Sonarr
                ? Query(("includeEpisode", "true"), ("includeSeries", "true"), ("sortKey", "timeleft"), ("sortDirection", "ascending"))
                : Query(("includeMovie", "true"));
            ArrPagedList<ArrWireQueueRecord>? read = null;
            for (var attempt = 0; attempt < 2 && (read == null || read.Short); attempt++)
            {
                var pages = await client.GetAllPagesAsync<ArrWireQueueRecord>("queue", query, pageSize: 500, maxRecords: QueueMaxRecords, cancellationToken: ct, idOf: r => r.Id).ConfigureAwait(false);
                if (!pages.Ok) return ArrResult<ArrQueueSnapshot>.Failure(pages.Error!);
                read = pages.Value!;
            }
            var rows = read!.Records.Select(ToQueueEntry).ToList();
            return ArrResult<ArrQueueSnapshot>.Success(new ArrQueueSnapshot { Records = rows, TotalRecords = read.TotalRecords, Paged = read.Pages > 1, Truncated = read.Truncated, Incomplete = read.Short });
        }

        /// <summary>
        /// The queue in one unpaged read (<c>queue/details</c>), for when every row of one download
        /// must be known and the paged snapshot may be missing some: rows can't move between pages
        /// of a read that has none. Narrowed to one movie or series when it is known.
        /// </summary>
        internal static async Task<ArrResult<List<ArrQueueEntry>>> LoadQueueDetailsAsync(ArrClient client, int? arrId, CancellationToken ct)
        {
            var sonarr = client.Connection.Kind == ArrKind.Sonarr;
            var pairs = new List<(string Key, string Value)>(sonarr ? new[] { ("includeEpisode", "true"), ("includeSeries", "true") } : new[] { ("includeMovie", "true") });
            if (arrId is int id) pairs.Add((sonarr ? "seriesId" : "movieId", id.ToString(CultureInfo.InvariantCulture)));
            var read = await client.GetAsync<List<ArrWireQueueRecord>>("queue/details", Query(pairs.ToArray()), ArrCallClass.List, ct).ConfigureAwait(false);
            if (!read.Ok) return ArrResult<List<ArrQueueEntry>>.Failure(read.Error!);
            return ArrResult<List<ArrQueueEntry>>.Success((read.Value ?? new List<ArrWireQueueRecord>()).Select(ToQueueEntry).ToList());
        }

        /// <summary>
        /// History: a full read of the newest <see cref="HistoryFullRead"/> records the first time
        /// (and once an hour), otherwise only what happened since the watermark (<c>history/since</c>),
        /// merged into the ring by record id.
        /// </summary>
        internal static async Task<ArrResult<ArrHistorySnapshot>> LoadHistoryAsync(ArrClient client, ArrHistorySnapshot? previous, DateTimeOffset now, CancellationToken ct)
        {
            if (await CheckAppAsync(client, ct).ConfigureAwait(false) is { } wrong) return ArrResult<ArrHistorySnapshot>.Failure(wrong);

            var include = client.Connection.Kind == ArrKind.Sonarr
                ? new[] { ("includeSeries", "true"), ("includeEpisode", "true") }
                : new[] { ("includeMovie", "true") };

            var incremental = previous != null
                && previous.Watermark is DateTime mark
                && now - previous.FullReadAt < HistoryFullResync
                && now.UtcDateTime - mark < TimeSpan.FromDays(7);
            if (!incremental)
            {
                var query = Query(include.Concat(new[] { ("sortKey", "date"), ("sortDirection", "descending") }).ToArray());
                var pages = await client.GetAllPagesAsync<ArrWireHistoryRecord>("history", query, pageSize: 250, maxRecords: HistoryFullRead, cancellationToken: ct, idOf: r => r.Id).ConfigureAwait(false);
                if (!pages.Ok) return ArrResult<ArrHistorySnapshot>.Failure(pages.Error!);
                return ArrResult<ArrHistorySnapshot>.Success(BuildHistory(pages.Value!.Records.Select(ToHistoryEntry), null, now));
            }

            // The arrs answer only records strictly after "date", and their dates have whole seconds:
            // a record written in the same second as the newest one already read (a season's
            // episodes imported together) would never be read. Ask from a second earlier; records
            // already held are merged by id.
            var since = previous!.Watermark!.Value.ToUniversalTime().AddSeconds(-1).ToString("o", CultureInfo.InvariantCulture);
            var sinceQuery = Query(include.Prepend(("date", since)).ToArray());
            var fresh = await client.GetAsync<List<ArrWireHistoryRecord>>("history/since", sinceQuery, ArrCallClass.List, ct).ConfigureAwait(false);
            if (!fresh.Ok) return ArrResult<ArrHistorySnapshot>.Failure(fresh.Error!);
            return ArrResult<ArrHistorySnapshot>.Success(BuildHistory(fresh.Value!.Select(ToHistoryEntry), previous, previous.FullReadAt));
        }

        /// <summary>Merges new records into the ring (dedup by id, newest first, capped).</summary>
        internal static ArrHistorySnapshot BuildHistory(IEnumerable<ArrHistoryEntry> incoming, ArrHistorySnapshot? previous, DateTimeOffset fullReadAt)
        {
            var byId = new Dictionary<int, ArrHistoryEntry>();
            foreach (var r in incoming) byId[r.Id] = r;
            if (previous != null)
            {
                foreach (var r in previous.Records) byId.TryAdd(r.Id, r);
            }
            var records = byId.Values
                .OrderByDescending(r => r.Date ?? DateTime.MinValue)
                .ThenByDescending(r => r.Id)
                .Take(HistoryRingSize)
                .ToList();
            var watermark = records.Where(r => r.Date.HasValue).Select(r => r.Date!.Value).DefaultIfEmpty().Max();
            return new ArrHistorySnapshot
            {
                Records = records,
                Watermark = records.Any(r => r.Date.HasValue) ? watermark : previous?.Watermark,
                FullReadAt = fullReadAt,
            };
        }

        /// <summary>The calendar between two dates (unmonitored entries included, as the old route did).</summary>
        internal static async Task<ArrResult<ArrCalendarSnapshot>> LoadCalendarAsync(ArrClient client, DateTime start, DateTime end, CancellationToken ct)
        {
            if (await CheckAppAsync(client, ct).ConfigureAwait(false) is { } wrong) return ArrResult<ArrCalendarSnapshot>.Failure(wrong);

            var startIso = start.ToUniversalTime().ToString("o", CultureInfo.InvariantCulture);
            var endIso = end.ToUniversalTime().ToString("o", CultureInfo.InvariantCulture);
            if (client.Connection.Kind == ArrKind.Sonarr)
            {
                var episodes = await client.GetAsync<List<ArrWireEpisode>>("calendar",
                    Query(("includeSeries", "true"), ("unmonitored", "true"), ("start", startIso), ("end", endIso)), ArrCallClass.List, ct).ConfigureAwait(false);
                if (!episodes.Ok) return ArrResult<ArrCalendarSnapshot>.Failure(episodes.Error!);
                var entries = episodes.Value!.Select(ToEpisodeEntry).Where(e => e != null).Select(e => e!).ToList();
                return ArrResult<ArrCalendarSnapshot>.Success(new ArrCalendarSnapshot { WindowStart = start, WindowEnd = end, Entries = entries });
            }

            var movies = await client.GetAsync<List<ArrWireMovie>>("calendar",
                Query(("unmonitored", "true"), ("start", startIso), ("end", endIso)), ArrCallClass.List, ct).ConfigureAwait(false);
            if (!movies.Ok) return ArrResult<ArrCalendarSnapshot>.Failure(movies.Error!);
            var movieEntries = movies.Value!.Select(ToMovieCalendarEntry).Where(e => e != null).Select(e => e!).ToList();
            return ArrResult<ArrCalendarSnapshot>.Success(new ArrCalendarSnapshot { WindowStart = start, WindowEnd = end, Entries = movieEntries });
        }

        /// <summary>
        /// The calendar window kept in memory for a given moment: from today − 35 d or the day before
        /// the first of last month, whichever is earlier (so the Calendar page's "previous month" is
        /// served from memory in every time zone), to today + 100 d.
        /// </summary>
        internal static (DateTime Start, DateTime End) CalendarWindow(DateTimeOffset now)
        {
            var today = now.UtcDateTime.Date;
            var previousMonth = new DateTime(today.Year, today.Month, 1, 0, 0, 0, DateTimeKind.Utc).AddMonths(-1).AddDays(-1);
            var start = today.AddDays(-CalendarDaysBack);
            if (previousMonth < start) start = previousMonth;
            return (DateTime.SpecifyKind(start, DateTimeKind.Utc),
                    DateTime.SpecifyKind(today.AddDays(CalendarDaysAhead + 1).AddTicks(-1), DateTimeKind.Utc));
        }

        /// <summary>
        /// Status, health, disk space, root folders and quality profiles; also the scheduled tasks
        /// when <paramref name="includeTasks"/> (only the phase-2 System tab shows them).
        /// </summary>
        internal static async Task<ArrResult<ArrSystemSnapshot>> LoadSystemAsync(ArrClient client, bool includeTasks, CancellationToken ct)
        {
            var status = await client.GetSystemStatusAsync(true, ct).ConfigureAwait(false);
            if (!status.Ok) return ArrResult<ArrSystemSnapshot>.Failure(status.Error!);

            var health = await client.GetAsync<List<ArrWireHealth>>("health", null, ArrCallClass.Status, ct).ConfigureAwait(false);
            if (!health.Ok) return ArrResult<ArrSystemSnapshot>.Failure(health.Error!);
            var disk = await client.GetAsync<List<ArrWireDisk>>("diskspace", null, ArrCallClass.Status, ct).ConfigureAwait(false);
            if (!disk.Ok) return ArrResult<ArrSystemSnapshot>.Failure(disk.Error!);
            var roots = await client.GetAsync<List<ArrWireDisk>>("rootfolder", null, ArrCallClass.Read, ct).ConfigureAwait(false);
            if (!roots.Ok) return ArrResult<ArrSystemSnapshot>.Failure(roots.Error!);
            var profiles = await client.GetAsync<List<ArrWireProfile>>("qualityprofile", null, ArrCallClass.Read, ct).ConfigureAwait(false);
            if (!profiles.Ok) return ArrResult<ArrSystemSnapshot>.Failure(profiles.Error!);
            // The task list is extra (System tab); an instance that can't list it still has a system snapshot.
            ArrResult<List<ArrWireTask>>? tasks = includeTasks ? await client.GetAsync<List<ArrWireTask>>("system/task", null, ArrCallClass.Status, ct).ConfigureAwait(false) : null;

            return ArrResult<ArrSystemSnapshot>.Success(new ArrSystemSnapshot
            {
                AppName = status.Value.Status.AppName,
                Version = status.Value.Status.Version,
                Health = health.Value!.Select(h => new ArrHealthEntry { Source = h.Source, Type = h.Type, Message = Clip(h.Message) }).ToList(),
                DiskSpace = disk.Value!.Select(d => new ArrDiskEntry { Path = d.Path, FreeSpace = d.FreeSpace, TotalSpace = d.TotalSpace }).ToList(),
                RootFolders = roots.Value!.Select(d => new ArrDiskEntry { Path = d.Path, FreeSpace = d.FreeSpace, Accessible = d.Accessible }).ToList(),
                QualityProfiles = profiles.Value!.Select(p => new ArrProfileEntry { Id = p.Id, Name = p.Name ?? string.Empty }).ToList(),
                Tasks = tasks is { Ok: true } read
                    ? read.Value!.Where(t => !string.IsNullOrWhiteSpace(t.Name)).Take(50).Select(t => new ArrTaskEntry
                    {
                        Name = Clip(t.Name)!,
                        TaskName = Clip(t.TaskName),
                        Interval = t.Interval ?? 0,
                        LastExecution = ArrDates.Parse(t.LastExecution),
                        NextExecution = ArrDates.Parse(t.NextExecution),
                        LastDuration = Clip(t.LastDuration),
                    }).ToList()
                    : new List<ArrTaskEntry>(),
            });
        }

        // ---------------- projections ----------------

        internal static ArrMovieEntry ToMovie(ArrWireMovie m) => new()
        {
            Id = m.Id,
            TmdbId = ArrIds.Positive(m.TmdbId),
            ImdbId = string.IsNullOrWhiteSpace(m.ImdbId) ? null : m.ImdbId,
            Title = m.Title ?? m.OriginalTitle ?? string.Empty,
            Year = m.Year,
            Monitored = m.Monitored ?? false,
            HasFile = m.HasFile ?? false,
            SizeOnDisk = m.SizeOnDisk ?? 0,
            Path = m.Path,
            QualityProfileId = m.QualityProfileId ?? 0,
            Tags = m.Tags?.ToArray() ?? Array.Empty<int>(),
            Status = Intern(m.Status),
            IsAvailable = m.IsAvailable ?? true,
            MinimumAvailability = Intern(m.MinimumAvailability),
            InCinemas = ArrDates.Parse(m.InCinemas),
            DigitalRelease = ArrDates.Parse(m.DigitalRelease),
            PhysicalRelease = ArrDates.Parse(m.PhysicalRelease),
            Added = ArrDates.Parse(m.Added),
            LastSearchTime = ArrDates.Parse(m.LastSearchTime),
        };

        internal static ArrSeriesEntry ToSeries(ArrWireSeries s) => new()
        {
            Id = s.Id,
            TvdbId = ArrIds.Positive(s.TvdbId),
            TmdbId = ArrIds.Positive(s.TmdbId),
            ImdbId = string.IsNullOrWhiteSpace(s.ImdbId) ? null : s.ImdbId,
            Title = s.Title ?? string.Empty,
            TitleSlug = s.TitleSlug,
            Monitored = s.Monitored ?? false,
            Path = s.Path,
            QualityProfileId = s.QualityProfileId ?? 0,
            Tags = s.Tags?.ToArray() ?? Array.Empty<int>(),
            EpisodeFileCount = s.Statistics?.EpisodeFileCount ?? 0,
            EpisodeCount = s.Statistics?.EpisodeCount ?? 0,
            PercentOfEpisodes = s.Statistics?.PercentOfEpisodes ?? 0,
            SizeOnDisk = s.Statistics?.SizeOnDisk ?? 0,
            Status = Intern(s.Status),
            NextAiring = ArrDates.Parse(s.NextAiring),
            Added = ArrDates.Parse(s.Added),
            Seasons = (s.Seasons ?? new List<ArrWireSeason>()).Select(season => new ArrSeasonEntry
            {
                SeasonNumber = season.SeasonNumber,
                Monitored = season.Monitored ?? false,
                EpisodeFileCount = season.Statistics?.EpisodeFileCount ?? 0,
                EpisodeCount = season.Statistics?.EpisodeCount ?? 0,
                TotalEpisodeCount = season.Statistics?.TotalEpisodeCount ?? 0,
                NextAiring = ArrDates.Parse(season.Statistics?.NextAiring),
            }).ToArray(),
        };

        /// <summary>
        /// A movie entry from a resource a live event carried, keeping the previous entry's value
        /// for every field the resource left out (a partial resource must not reset facts).
        /// </summary>
        internal static ArrMovieEntry MergeMovie(ArrMovieEntry? old, ArrWireMovie m) => new()
        {
            Id = m.Id,
            TmdbId = ArrIds.Positive(m.TmdbId) ?? old?.TmdbId,
            ImdbId = string.IsNullOrWhiteSpace(m.ImdbId) ? old?.ImdbId : m.ImdbId,
            Title = m.Title ?? m.OriginalTitle ?? old?.Title ?? string.Empty,
            Year = m.Year ?? old?.Year,
            Monitored = m.Monitored ?? old?.Monitored ?? false,
            HasFile = m.HasFile ?? old?.HasFile ?? false,
            SizeOnDisk = m.SizeOnDisk ?? old?.SizeOnDisk ?? 0,
            Path = m.Path ?? old?.Path,
            QualityProfileId = m.QualityProfileId ?? old?.QualityProfileId ?? 0,
            Tags = m.Tags?.ToArray() ?? old?.Tags ?? Array.Empty<int>(),
            Status = m.Status != null ? Intern(m.Status) : old?.Status,
            IsAvailable = m.IsAvailable ?? old?.IsAvailable ?? true,
            MinimumAvailability = m.MinimumAvailability != null ? Intern(m.MinimumAvailability) : old?.MinimumAvailability,
            InCinemas = ArrDates.Parse(m.InCinemas) ?? old?.InCinemas,
            DigitalRelease = ArrDates.Parse(m.DigitalRelease) ?? old?.DigitalRelease,
            PhysicalRelease = ArrDates.Parse(m.PhysicalRelease) ?? old?.PhysicalRelease,
            Added = ArrDates.Parse(m.Added) ?? old?.Added,
            LastSearchTime = ArrDates.Parse(m.LastSearchTime) ?? old?.LastSearchTime,
        };

        /// <summary>A series entry from a live resource; statistics the resource lacks are kept.</summary>
        internal static ArrSeriesEntry MergeSeries(ArrSeriesEntry? old, ArrWireSeries s) => new()
        {
            Id = s.Id,
            TvdbId = ArrIds.Positive(s.TvdbId) ?? old?.TvdbId,
            TmdbId = ArrIds.Positive(s.TmdbId) ?? old?.TmdbId,
            ImdbId = string.IsNullOrWhiteSpace(s.ImdbId) ? old?.ImdbId : s.ImdbId,
            Title = s.Title ?? old?.Title ?? string.Empty,
            TitleSlug = s.TitleSlug ?? old?.TitleSlug,
            Monitored = s.Monitored ?? old?.Monitored ?? false,
            Path = s.Path ?? old?.Path,
            QualityProfileId = s.QualityProfileId ?? old?.QualityProfileId ?? 0,
            Tags = s.Tags?.ToArray() ?? old?.Tags ?? Array.Empty<int>(),
            EpisodeFileCount = s.Statistics?.EpisodeFileCount ?? old?.EpisodeFileCount ?? 0,
            EpisodeCount = s.Statistics?.EpisodeCount ?? old?.EpisodeCount ?? 0,
            PercentOfEpisodes = s.Statistics?.PercentOfEpisodes ?? old?.PercentOfEpisodes ?? 0,
            SizeOnDisk = s.Statistics?.SizeOnDisk ?? old?.SizeOnDisk ?? 0,
            Status = s.Status != null ? Intern(s.Status) : old?.Status,
            NextAiring = ArrDates.Parse(s.NextAiring) ?? (s.Statistics != null ? null : old?.NextAiring),
            Added = ArrDates.Parse(s.Added) ?? old?.Added,
            Seasons = s.Seasons != null ? ToSeries(s).Seasons : old?.Seasons ?? Array.Empty<ArrSeasonEntry>(),
        };

        internal static ArrQueueEntry ToQueueEntry(ArrWireQueueRecord r)
        {
            var messages = new List<string>();
            foreach (var sm in r.StatusMessages ?? new List<ArrWireStatusMessage>())
            {
                foreach (var m in sm.Messages ?? new List<string>())
                {
                    if (messages.Count >= MaxStatusMessages) break;
                    if (!string.IsNullOrWhiteSpace(m)) messages.Add(Clip(m)!);
                }
            }
            return new ArrQueueEntry
            {
                Id = r.Id,
                DownloadId = r.DownloadId,
                Status = Intern(r.Status),
                TrackedDownloadState = Intern(r.TrackedDownloadState),
                TrackedDownloadStatus = Intern(r.TrackedDownloadStatus),
                StatusMessages = messages,
                ErrorMessage = Clip(r.ErrorMessage),
                Size = r.Size,
                SizeLeft = r.Sizeleft,
                TimeLeft = r.Timeleft,
                EstimatedCompletionTime = r.EstimatedCompletionTime,
                Protocol = Intern(r.Protocol),
                ReleaseTitle = r.Title,
                MovieId = r.MovieId ?? r.Movie?.Id,
                SeriesId = r.SeriesId ?? r.Series?.Id,
                EpisodeId = r.EpisodeId ?? r.Episode?.Id,
                Title = r.Series?.Title ?? r.Movie?.Title,
                Year = r.Movie?.Year,
                TmdbId = ArrIds.Positive(r.Series?.TmdbId ?? r.Movie?.TmdbId),
                TvdbId = ArrIds.Positive(r.Series?.TvdbId),
                PosterUrl = ArrWireImage.Poster(r.Series?.Images ?? r.Movie?.Images),
                SeasonNumber = r.Episode?.SeasonNumber ?? r.SeasonNumber,
                EpisodeNumber = r.Episode?.EpisodeNumber,
                EpisodeTitle = r.Episode?.Title,
                DownloadClient = Clip(r.DownloadClient),
                Quality = Intern(r.Quality?.Quality?.Name),
                CustomFormatScore = r.CustomFormatScore,
                Added = ArrDates.Parse(r.Added),
            };
        }

        internal static ArrHistoryEntry ToHistoryEntry(ArrWireHistoryRecord r) => new()
        {
            Id = r.Id,
            EventType = Intern(r.EventType),
            Date = r.Date is DateTime d ? (d.Kind == DateTimeKind.Unspecified ? DateTime.SpecifyKind(d, DateTimeKind.Utc) : d.ToUniversalTime()) : null,
            DownloadId = r.DownloadId,
            Title = r.Series?.Title ?? r.Movie?.Title,
            Year = r.Movie?.Year,
            TmdbId = ArrIds.Positive(r.Series?.TmdbId ?? r.Movie?.TmdbId),
            TvdbId = ArrIds.Positive(r.Series?.TvdbId),
            MovieId = r.MovieId ?? r.Movie?.Id,
            SeriesId = r.SeriesId ?? r.Series?.Id,
            EpisodeId = r.EpisodeId ?? r.Episode?.Id,
            PosterUrl = ArrWireImage.Poster(r.Series?.Images ?? r.Movie?.Images),
            SeasonNumber = r.Episode?.SeasonNumber,
            EpisodeNumber = r.Episode?.EpisodeNumber,
            EpisodeTitle = r.Episode?.Title,
            SourceTitle = Clip(r.SourceTitle),
            Quality = Intern(r.Quality?.Quality?.Name),
            ImportedPath = DataString(r.Data, "importedPath"),
            Message = Clip(DataString(r.Data, "message")),
        };

        /// <summary>A string value of a history record's <c>data</c> map (capped), or null.</summary>
        private static string? DataString(Dictionary<string, JsonElement>? data, string name)
        {
            if (data == null || !data.TryGetValue(name, out var value) || value.ValueKind != JsonValueKind.String) return null;
            var text = value.GetString();
            return string.IsNullOrWhiteSpace(text) || text.Length > 1024 ? null : text;
        }

        internal static ArrCalendarEntry? ToEpisodeEntry(ArrWireEpisode e)
        {
            var air = ArrDates.Parse(e.AirDateUtc ?? e.AirDate);
            if (!air.HasValue) return null;
            string? poster = null, backdrop = null;
            foreach (var img in e.Series?.Images ?? new List<ArrWireImage>())
            {
                var url = img.RemoteUrl ?? img.Url;
                if (string.IsNullOrWhiteSpace(url)) continue;
                if (backdrop == null && (img.CoverType == "fanart" || img.CoverType == "banner")) backdrop = url;
                else if (poster == null && img.CoverType == "poster") poster = url;
            }
            return new ArrCalendarEntry
            {
                Id = e.Id,
                Title = e.Series?.Title ?? "Unknown Series",
                AirDateUtc = air,
                AirDateIsDay = string.IsNullOrWhiteSpace(e.AirDateUtc) && !string.IsNullOrWhiteSpace(e.AirDate),
                HasFile = e.HasFile ?? false,
                Monitored = e.Monitored ?? false,
                SeriesId = e.SeriesId,
                SeasonNumber = e.SeasonNumber ?? 0,
                EpisodeNumber = e.EpisodeNumber ?? 0,
                EpisodeTitle = e.Title ?? "Unknown Episode",
                Overview = e.Overview,
                TvdbId = ArrIds.Positive(e.Series?.TvdbId),
                ImdbId = e.Series?.ImdbId,
                TmdbId = ArrIds.Positive(e.Series?.TmdbId),
                EpisodeTvdbId = ArrIds.Positive(e.TvdbId),
                EpisodeImdbId = e.ImdbId,
                PosterUrl = poster,
                BackdropUrl = backdrop,
                Path = e.Series?.Path,
            };
        }

        internal static ArrCalendarEntry? ToMovieCalendarEntry(ArrWireMovie m)
        {
            var releases = new Dictionary<string, DateTime>(StringComparer.OrdinalIgnoreCase);
            void Add(string type, string? value)
            {
                var parsed = ArrDates.Parse(value);
                if (!parsed.HasValue) return;
                if (!releases.TryGetValue(type, out var existing) || parsed.Value < existing) releases[type] = parsed.Value;
            }

            Add("CinemaRelease", m.InCinemas);
            Add("PhysicalRelease", m.PhysicalRelease);
            Add("DigitalRelease", m.DigitalRelease);
            if (m.Releases.ValueKind == JsonValueKind.Array)
            {
                foreach (var release in m.Releases.EnumerateArray())
                {
                    if (release.ValueKind != JsonValueKind.Object) continue;
                    var date = Text(release, "releaseDate") ?? Text(release, "date");
                    var type = Text(release, "type")?.ToLowerInvariant();
                    var physical = release.TryGetProperty("isPhysical", out var p) && p.ValueKind == JsonValueKind.True;
                    if (physical) Add("PhysicalRelease", date);
                    else if (type == "digital") Add("DigitalRelease", date);
                    else if (type is "theatrical" or "cinema" or "theater") Add("CinemaRelease", date);
                }
            }
            if (releases.Count == 0) return null;

            string? poster = null, backdrop = null;
            foreach (var img in m.Images ?? new List<ArrWireImage>())
            {
                var url = img.RemoteUrl ?? img.Url;
                if (string.IsNullOrWhiteSpace(url)) continue;
                if (poster == null && img.CoverType == "poster") { poster = url; continue; }
                if (backdrop == null && (img.CoverType == "fanart" || img.CoverType == "backdrop")) backdrop = url;
            }
            return new ArrCalendarEntry
            {
                Id = m.Id,
                Title = m.Title ?? m.OriginalTitle ?? "Unknown",
                Year = m.Year?.ToString(CultureInfo.InvariantCulture),
                Releases = releases,
                HasFile = m.HasFile ?? false,
                Monitored = m.Monitored ?? false,
                TmdbId = ArrIds.Positive(m.TmdbId),
                ImdbId = m.ImdbId,
                PosterUrl = poster,
                BackdropUrl = backdrop,
                Path = m.Path,
            };
        }

        private static string? Text(JsonElement e, string name)
        {
            if (!e.TryGetProperty(name, out var v)) return null;
            return v.ValueKind switch
            {
                JsonValueKind.String => v.GetString(),
                JsonValueKind.Number => v.GetRawText(),
                _ => null,
            };
        }

        private static string? Clip(string? s) => string.IsNullOrEmpty(s) || s.Length <= MaxMessageLength ? s : s.Substring(0, MaxMessageLength) + "…";

        // Status/state/protocol/event names come from a small fixed vocabulary and repeat on every row:
        // one copy each keeps big queues small. (Free text such as messages is never interned.)
        private static string? Intern(string? s) => s == null ? null : string.Intern(s);

        private static IEnumerable<KeyValuePair<string, string?>> Query(params (string Key, string Value)[] pairs)
            => pairs.Select(p => new KeyValuePair<string, string?>(p.Key, p.Value)).ToList();
    }
}
