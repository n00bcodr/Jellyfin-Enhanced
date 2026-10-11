using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.Json.Serialization;
using Jellyfin.Plugin.JellyfinEnhanced.Model.Arr;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Arr
{
    /// <summary>
    /// The response shapes of the existing Downloads, history, calendar and link routes, built from
    /// <see cref="ArrStateStore"/> snapshots. Field names and values match what those routes
    /// returned when they read the arrs directly, so the existing pages work unchanged.
    /// </summary>
    internal static class ArrLegacyViews
    {
        /// <summary>The Downloads page queue rows of one instance (all of them; the old route stopped at 1000).</summary>
        public static IEnumerable<ArrLegacyQueueItem> QueueItems(ArrConnection instance, ArrQueueSnapshot queue)
        {
            var sonarr = instance.Kind == ArrKind.Sonarr;
            foreach (var r in queue.Records)
            {
                yield return new ArrLegacyQueueItem
                {
                    Id = r.Id.ToString(CultureInfo.InvariantCulture),
                    Source = sonarr ? nameof(ArrType.Sonarr) : nameof(ArrType.Radarr),
                    InstanceName = instance.Name,
                    Title = r.Title ?? "Unknown",
                    Subtitle = sonarr ? EpisodeLabel(r.SeasonNumber, r.EpisodeNumber, r.EpisodeTitle) : r.Year?.ToString(CultureInfo.InvariantCulture),
                    SeasonNumber = sonarr ? r.SeasonNumber : null,
                    EpisodeNumber = sonarr ? r.EpisodeNumber : null,
                    Status = ResolveQueueStatus(r.Status, r.TrackedDownloadState, r.TrackedDownloadStatus),
                    Progress = CalculateProgress(r.Size, r.SizeLeft),
                    TotalSize = (long?)r.Size,
                    SizeRemaining = (long?)r.SizeLeft,
                    TimeRemaining = r.TimeLeft,
                    PosterUrl = r.PosterUrl,
                    TmdbId = r.TmdbId,
                };
            }
        }

        /// <summary>
        /// Imported/failed history items of one instance, newest first. Sonarr records sharing a
        /// download id (one season pack) are grouped into one item, as before.
        /// </summary>
        public static List<ArrLegacyHistoryItem> HistoryItems(ArrConnection instance, ArrHistorySnapshot history)
        {
            var items = new List<ArrLegacyHistoryItem>();
            if (instance.Kind == ArrKind.Radarr)
            {
                foreach (var r in history.Records)
                {
                    var eventType = MapHistoryEventType(r.EventType);
                    if (eventType == null) continue;
                    items.Add(new ArrLegacyHistoryItem
                    {
                        Source = nameof(ArrType.Radarr),
                        InstanceName = instance.Name,
                        Title = r.Title ?? "Unknown",
                        Subtitle = r.Year?.ToString(CultureInfo.InvariantCulture),
                        EventType = eventType,
                        Date = r.Date,
                        PosterUrl = r.PosterUrl,
                        TmdbId = r.TmdbId,
                    });
                }
                return items;
            }

            var entries = history.Records
                .Select(r => (Record: r, EventType: MapHistoryEventType(r.EventType)))
                .Where(e => e.EventType != null)
                .ToList();
            var groups = entries
                .Select((e, idx) => new { Entry = e, Key = string.IsNullOrEmpty(e.Record.DownloadId) ? "__single_" + idx.ToString(CultureInfo.InvariantCulture) : e.Record.DownloadId! })
                .GroupBy(x => x.Key, x => x.Entry);
            foreach (var group in groups)
            {
                var list = group.ToList();
                var first = list[0].Record;
                if (list.Count == 1)
                {
                    items.Add(new ArrLegacyHistoryItem
                    {
                        Source = nameof(ArrType.Sonarr),
                        InstanceName = instance.Name,
                        Title = first.Title ?? "Unknown",
                        Subtitle = EpisodeLabel(first.SeasonNumber, first.EpisodeNumber, first.EpisodeTitle),
                        EventType = list[0].EventType!,
                        Date = first.Date,
                        PosterUrl = first.PosterUrl,
                        TmdbId = first.TmdbId,
                    });
                    continue;
                }

                var imported = list.Count(e => e.EventType == "imported");
                var failed = list.Count(e => e.EventType == "failed");
                var episodes = list.Where(e => e.Record.EpisodeNumber.HasValue).Select(e => e.Record.EpisodeNumber!.Value).OrderBy(n => n).ToList();
                var date = list.Where(e => e.Record.Date.HasValue).Select(e => e.Record.Date!.Value).DefaultIfEmpty(DateTime.MinValue).Max();
                items.Add(new ArrLegacyHistoryItem
                {
                    Source = nameof(ArrType.Sonarr),
                    InstanceName = instance.Name,
                    Title = first.Title ?? "Unknown",
                    Subtitle = episodes.Count > 0
                        ? $"S{D2(first.SeasonNumber)} · E{D2(episodes[0])}-E{D2(episodes[^1])}"
                        : $"S{D2(first.SeasonNumber)}",
                    EventType = imported > 0 && failed > 0 ? "partial" : (failed > 0 ? "failed" : "imported"),
                    Date = date,
                    PosterUrl = first.PosterUrl,
                    TmdbId = first.TmdbId,
                    EpisodeCount = list.Count,
                    ImportedCount = imported,
                    FailedCount = failed,
                });
            }
            return items;
        }

        /// <summary>The <c>arr/movie-instances</c> match for one Radarr instance, or null.</summary>
        public static object? MovieMatch(ArrConnection instance, ArrMovieEntry? movie)
        {
            if (movie == null) return null;
            return new
            {
                instanceName = instance.Name,
                instanceUrl = instance.Url,
                urlMappings = instance.UrlMappings,
                hasFile = movie.HasFile,
                sizeOnDisk = movie.SizeOnDisk,
                rootFolderPath = GetRootFolderFromPath(movie.Path),
            };
        }

        /// <summary>The <c>arr/series-slugs</c> match for one Sonarr instance, or null (also when it has no slug).</summary>
        public static object? SeriesMatch(ArrConnection instance, ArrSeriesEntry? series)
        {
            // No slug = no usable link (a /series/null link otherwise); same guard as before.
            if (series == null || string.IsNullOrEmpty(series.TitleSlug)) return null;
            return new
            {
                instanceName = instance.Name,
                instanceUrl = instance.Url,
                titleSlug = series.TitleSlug,
                urlMappings = instance.UrlMappings,
                episodeFileCount = series.EpisodeFileCount,
                episodeCount = series.EpisodeCount,
                percentOfEpisodes = series.PercentOfEpisodes,
                sizeOnDisk = series.SizeOnDisk,
                rootFolderPath = GetRootFolderFromPath(series.Path),
            };
        }

        /// <summary>Calendar events of one instance inside [start, end] (new objects per call: the route mutates them).</summary>
        public static IEnumerable<ArrItem> CalendarItems(ArrConnection instance, ArrCalendarSnapshot calendar, DateTime start, DateTime end)
        {
            foreach (var e in calendar.Entries)
            {
                if (instance.Kind == ArrKind.Sonarr)
                {
                    if (e.AirDateUtc is not DateTime air || air < start || air > end) continue;
                    yield return new ArrItem
                    {
                        Id = e.Id.ToString(CultureInfo.InvariantCulture),
                        Source = nameof(ArrType.Sonarr),
                        InstanceName = instance.Name,
                        Type = "Series",
                        Title = e.Title,
                        Subtitle = $"S{D2(e.SeasonNumber)}E{D2(e.EpisodeNumber)} - {e.EpisodeTitle}",
                        ReleaseDate = air.ToUniversalTime().ToString("o", CultureInfo.InvariantCulture),
                        ReleaseType = "Episode",
                        HasFile = e.HasFile,
                        Monitored = e.Monitored,
                        SeriesId = e.SeriesId,
                        SeasonNumber = e.SeasonNumber,
                        EpisodeNumber = e.EpisodeNumber,
                        EpisodeTitle = e.EpisodeTitle,
                        Overview = e.Overview,
                        TvdbId = e.TvdbId,
                        ImdbId = e.ImdbId,
                        TmdbId = e.TmdbId,
                        PosterUrl = e.PosterUrl,
                        BackdropUrl = e.BackdropUrl,
                        EpisodeTvdbId = e.EpisodeTvdbId,
                        EpisodeImdbId = e.EpisodeImdbId,
                        RootFolderPath = GetRootFolderFromPath(e.Path),
                    };
                    continue;
                }

                foreach (var (type, date) in e.Releases)
                {
                    var releaseUtc = date.ToUniversalTime();
                    if (releaseUtc < start || releaseUtc > end) continue;
                    yield return new ArrItem
                    {
                        Id = e.Id.ToString(CultureInfo.InvariantCulture) + "-" + type,
                        Source = nameof(ArrType.Radarr),
                        InstanceName = instance.Name,
                        Type = "Movie",
                        Title = e.Title,
                        Subtitle = e.Year,
                        ReleaseDate = releaseUtc.ToString("o", CultureInfo.InvariantCulture),
                        ReleaseType = type,
                        HasFile = e.HasFile,
                        Monitored = e.Monitored,
                        PosterUrl = e.PosterUrl,
                        BackdropUrl = e.BackdropUrl,
                        TmdbId = e.TmdbId,
                        ImdbId = e.ImdbId,
                        RootFolderPath = GetRootFolderFromPath(e.Path),
                    };
                }
            }
        }

        /// <summary>
        /// The per-instance error entry of the existing routes: a short reason for everyone (no
        /// URLs or upstream text), plus the admin-facing message for admins.
        /// </summary>
        public static object InstanceError(ArrConnection instance, ArrError error, bool isAdmin, bool withSource = true)
        {
            var source = instance.Kind == ArrKind.Sonarr ? nameof(ArrType.Sonarr) : nameof(ArrType.Radarr);
            var reason = ShortReason(error);
            if (withSource)
            {
                return isAdmin
                    ? new { instanceName = instance.Name, source, reason, detail = error.Message }
                    : (object)new { instanceName = instance.Name, source, reason };
            }
            return isAdmin
                ? new { instanceName = instance.Name, reason, detail = error.Message }
                : (object)new { instanceName = instance.Name, reason };
        }

        /// <summary>A short, stable reason in the vocabulary the pages already show.</summary>
        public static string ShortReason(ArrError error) => error.Kind switch
        {
            ArrErrorKind.Unreachable or ArrErrorKind.ConnectionLost => "network error",
            ArrErrorKind.Timeout => "timeout",
            ArrErrorKind.Unauthorized => error.HttpStatus > 0 ? $"authentication failed ({error.HttpStatus})" : "authentication failed",
            ArrErrorKind.BlockedUrl => "URL rejected by SSRF guard",
            ArrErrorKind.Redirect => "redirect not followed (use the instance's direct address)",
            ArrErrorKind.WrongApp => "wrong app at this URL",
            ArrErrorKind.UnsupportedVersion => "unsupported version",
            ArrErrorKind.InvalidResponse or ArrErrorKind.TooLarge => "invalid response",
            ArrErrorKind.NotConfigured => "no API key stored",
            ArrErrorKind.Internal => "internal error",
            _ => error.HttpStatus > 0 ? $"HTTP {error.HttpStatus}" : "error",
        };

        /// <summary>Download progress in percent (one decimal).</summary>
        public static double CalculateProgress(double? size, double? sizeleft)
        {
            if (size == null || size == 0) return 0;
            if (sizeleft == null) return 100;
            return Math.Round((1 - (sizeleft.Value / size.Value)) * 100, 1);
        }

        /// <summary>
        /// The queue "status" field only describes the transfer, not the import: once the transfer
        /// finishes it sticks at "completed" even while the arr is still importing (or waiting for
        /// manual intervention). trackedDownloadState/Status carry that, so the page sees
        /// "importing"/"warning"/"failed" instead of a frozen "completed".
        /// </summary>
        public static string ResolveQueueStatus(string? status, string? trackedDownloadState, string? trackedDownloadStatus)
        {
            if (string.Equals(trackedDownloadStatus, "warning", StringComparison.OrdinalIgnoreCase))
                return "warning";

            switch (trackedDownloadState?.ToLowerInvariant())
            {
                case "importpending":
                case "importing":
                    return "importing";
                case "failedpending":
                case "failed":
                    return "failed";
            }

            return status ?? "Unknown";
        }

        /// <summary>
        /// Only the two terminal, user-relevant history events are shown; everything else (grabbed,
        /// renamed, deleted, ignored, ...) is noise for a "recently downloaded" list.
        /// </summary>
        public static string? MapHistoryEventType(string? eventType) => eventType?.ToLowerInvariant() switch
        {
            "downloadfolderimported" => "imported",
            "downloadfailed" => "failed",
            _ => null,
        };

        /// <summary>The parent folder of a title folder (the arr root folder), used for library-access checks.</summary>
        public static string? GetRootFolderFromPath(string? path)
        {
            if (string.IsNullOrWhiteSpace(path))
                return null;

            var trimmed = path.TrimEnd('/');
            var lastSlash = trimmed.LastIndexOf('/');
            if (lastSlash <= 0)
                return trimmed;

            return trimmed.Substring(0, lastSlash);
        }

        private static string EpisodeLabel(int? season, int? episode, string? title) => $"S{D2(season)}E{D2(episode)} - {title}";

        private static string D2(int? n) => n.HasValue ? n.Value.ToString("D2", CultureInfo.InvariantCulture) : string.Empty;
    }

    /// <summary>One row of <c>arr/queue</c> (existing response shape).</summary>
    public sealed class ArrLegacyQueueItem
    {
        /// <summary>Queue row id.</summary>
        [JsonPropertyName("id")]
        public string? Id { get; init; }

        /// <summary>Sonarr or Radarr.</summary>
        [JsonPropertyName("source")]
        public string Source { get; init; } = string.Empty;

        /// <summary>Instance name.</summary>
        [JsonPropertyName("instanceName")]
        public string InstanceName { get; init; } = string.Empty;

        /// <summary>Title.</summary>
        [JsonPropertyName("title")]
        public string Title { get; init; } = string.Empty;

        /// <summary>Episode label or year.</summary>
        [JsonPropertyName("subtitle")]
        public string? Subtitle { get; init; }

        /// <summary>Season.</summary>
        [JsonPropertyName("seasonNumber")]
        public int? SeasonNumber { get; init; }

        /// <summary>Episode.</summary>
        [JsonPropertyName("episodeNumber")]
        public int? EpisodeNumber { get; init; }

        /// <summary>Simplified status.</summary>
        [JsonPropertyName("status")]
        public string Status { get; init; } = string.Empty;

        /// <summary>Percent.</summary>
        [JsonPropertyName("progress")]
        public double Progress { get; init; }

        /// <summary>Bytes.</summary>
        [JsonPropertyName("totalSize")]
        public long? TotalSize { get; init; }

        /// <summary>Bytes left.</summary>
        [JsonPropertyName("sizeRemaining")]
        public long? SizeRemaining { get; init; }

        /// <summary>hh:mm:ss.</summary>
        [JsonPropertyName("timeRemaining")]
        public string? TimeRemaining { get; init; }

        /// <summary>Poster.</summary>
        [JsonPropertyName("posterUrl")]
        public string? PosterUrl { get; init; }

        /// <summary>TMDB id.</summary>
        [JsonPropertyName("tmdbId")]
        public int? TmdbId { get; init; }
    }

    /// <summary>One item of <c>arr/history</c> (existing response shape).</summary>
    public sealed class ArrLegacyHistoryItem
    {
        /// <summary>Sonarr or Radarr.</summary>
        [JsonPropertyName("source")]
        public string Source { get; init; } = string.Empty;

        /// <summary>Instance name.</summary>
        [JsonPropertyName("instanceName")]
        public string InstanceName { get; init; } = string.Empty;

        /// <summary>Title.</summary>
        [JsonPropertyName("title")]
        public string Title { get; init; } = string.Empty;

        /// <summary>Episode label or year.</summary>
        [JsonPropertyName("subtitle")]
        public string? Subtitle { get; init; }

        /// <summary>imported / failed / partial.</summary>
        [JsonPropertyName("eventType")]
        public string EventType { get; init; } = string.Empty;

        /// <summary>When.</summary>
        [JsonPropertyName("date")]
        public DateTime? Date { get; init; }

        /// <summary>Poster.</summary>
        [JsonPropertyName("posterUrl")]
        public string? PosterUrl { get; init; }

        /// <summary>TMDB id.</summary>
        [JsonPropertyName("tmdbId")]
        public int? TmdbId { get; init; }

        /// <summary>Episodes in a grouped season pack.</summary>
        [JsonPropertyName("episodeCount")]
        [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
        public int? EpisodeCount { get; init; }

        /// <summary>Imported episodes in a grouped pack.</summary>
        [JsonPropertyName("importedCount")]
        [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
        public int? ImportedCount { get; init; }

        /// <summary>Failed episodes in a grouped pack.</summary>
        [JsonPropertyName("failedCount")]
        [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
        public int? FailedCount { get; init; }
    }
}
