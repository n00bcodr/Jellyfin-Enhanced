using System.Collections.Concurrent;
using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Secrets;

namespace JE.Tests;

/// <summary>
/// A synthetic Sonarr/Radarr API behind <see cref="IntegrationTransport"/> (by host name), with
/// paged queue/history, history/since, calendar, library, tags and system routes, call counting
/// per host and path, and switchable failures. Plus the plugin wiring (instance rows, registry,
/// client factory, store) the arr-state tests share.
/// </summary>
internal sealed class FakeArr : IDisposable
{
    public sealed class Host
    {
        public string App { get; set; } = "Radarr";
        public List<JsonObject> Movies { get; } = new();
        public List<JsonObject> Series { get; } = new();
        public List<JsonObject> Queue { get; } = new();
        public List<JsonObject> History { get; } = new();
        public List<JsonObject> Calendar { get; } = new();
        /// <summary>Episodes answered by <c>/episode?seriesId=</c> (filtered by their <c>seriesId</c>).</summary>
        public List<JsonObject> Episodes { get; } = new();
        public Dictionary<int, string> Tags { get; } = new();
        /// <summary>Non-zero: every call answers with this HTTP status.</summary>
        public int FailWith { get; set; }
        /// <summary>Non-null: every call answers with a redirect to this URL.</summary>
        public string? RedirectTo { get; set; }
        /// <summary>Non-null: awaited (with the call's cancellation token) before a call to this path is answered.</summary>
        public Func<string, CancellationToken, Task>? Before { get; set; }
        /// <summary>Non-null: called (under the host's lock) before a page of a paged list is cut, with the path and page number — mutate the list here to move rows between pages mid-read.</summary>
        public Action<string, int>? BeforePage { get; set; }
        /// <summary>The paged answer's totalRecords from the path and real count; null reports the real count.</summary>
        public Func<string, int, int>? ReportedTotal { get; set; }
        /// <summary>Connect → notifications (webhooks) the arr holds, with ids.</summary>
        public List<JsonObject> Notifications { get; } = new();
        /// <summary>Called when a notification is created or changed, or tested (the arr would send its Test event here); return an error message to fail the save.</summary>
        public Func<JsonObject, string?>? OnNotificationTest { get; set; }
        /// <summary>Request bodies of writes, by method and path.</summary>
        public List<(string Method, string Path, string Body)> Writes { get; } = new();
        /// <summary>Non-zero: <c>POST /command</c> answers with this HTTP status (other calls as usual).</summary>
        public int CommandFailWith { get; set; }
        /// <summary>Non-zero: <c>GET /queue/details</c> answers with this HTTP status (other calls as usual).</summary>
        public int DetailsFailWith { get; set; }
        /// <summary>What <c>GET /command/{id}</c> answers for commands posted to <c>/command</c>.</summary>
        public string CommandStatus { get; set; } = "completed";
        /// <summary>The message of those commands.</summary>
        public string? CommandMessage { get; set; } = "Completed";
        /// <summary><c>/health</c> rows.</summary>
        public List<JsonObject> Health { get; } = new();
        /// <summary><c>/diskspace</c> rows (path, freeSpace, totalSpace).</summary>
        public List<JsonObject> DiskSpace { get; } = new();
        /// <summary><c>/rootfolder</c> rows (path, freeSpace, accessible).</summary>
        public List<JsonObject> RootFolders { get; } = new();
    }

    public ApiPluginFixture Plugin { get; } = new();
    public ConcurrentDictionary<string, Host> Hosts { get; } = new(StringComparer.OrdinalIgnoreCase);
    public ConcurrentQueue<string> Calls { get; } = new();
    public IntegrationTransport Transport { get; }
    public ArrInstanceRegistry Registry { get; } = new();
    public ArrClientFactory Factory { get; }
    public DateTimeOffset Now { get; set; } = new(2026, 10, 12, 12, 0, 0, TimeSpan.Zero);
    private readonly List<ArrStateStore> stores = new();

    public FakeArr()
    {
        Transport = new IntegrationTransport(async (request, ct) =>
        {
            if (Hosts.TryGetValue(request.RequestUri!.Host, out var host) && host.Before is { } before) await before(request.RequestUri.AbsolutePath, ct);
            return Answer(request);
        });
        Factory = new ArrClientFactory(Transport, Registry);
    }

    public int CallCount(string? host = null, string? pathPart = null)
        => Calls.Count(c => (host == null || c.StartsWith(host + "/", StringComparison.OrdinalIgnoreCase)) && (pathPart == null || c.Contains(pathPart, StringComparison.Ordinal)));

    /// <summary>Adds instance rows (name, kind, url, key) to the configuration and migrates them (ids, keys to the store).</summary>
    public void Configure(params (string Name, ArrKind Kind, string Url, string Key)[] rows)
    {
        var config = Plugin.Plugin.Configuration;
        config.SonarrInstances = JsonSerializer.Serialize(rows.Where(r => r.Kind == ArrKind.Sonarr).Select(r => new { r.Name, r.Url, ApiKey = r.Key, Enabled = true }));
        config.RadarrInstances = JsonSerializer.Serialize(rows.Where(r => r.Kind == ArrKind.Radarr).Select(r => new { r.Name, r.Url, ApiKey = r.Key, Enabled = true }));
        SecretsMigration.MigrateStored(config, Plugin.Plugin.Secrets);
    }

    public ArrConnection Instance(string name) => Registry.All().Single(c => c.Name == name);

    /// <summary>A store over this fake with the test clock; <paramref name="cacheDirectory"/> null disables the warm start.</summary>
    public ArrStateStore Store(string? cacheDirectory = null)
    {
        var store = new ArrStateStore(Factory, cacheDirectory, Plugin.Core.Logger, () => Now, () => Plugin.Plugin.Configuration);
        stores.Add(store);
        return store;
    }

    public Host Add(string host, string app)
    {
        var h = new Host { App = app };
        Hosts[host] = h;
        return h;
    }

    public static JsonObject Movie(int id, int tmdb, string title, bool hasFile = true, int[]? tags = null, string? path = null, string? digital = null)
        => new()
        {
            ["id"] = id, ["tmdbId"] = tmdb, ["imdbId"] = "tt" + tmdb, ["title"] = title, ["year"] = 2010, ["hasFile"] = hasFile, ["monitored"] = true,
            ["sizeOnDisk"] = 1000L * id, ["path"] = path ?? $"/data/movies/{title} ({tmdb})", ["qualityProfileId"] = 1,
            ["tags"] = new JsonArray((tags ?? Array.Empty<int>()).Select(t => (JsonNode)t).ToArray()),
            ["digitalRelease"] = digital,
            ["images"] = new JsonArray(new JsonObject { ["coverType"] = "poster", ["remoteUrl"] = $"https://img/{tmdb}.jpg" }),
        };

    public static JsonObject SeriesRow(int id, int tvdb, string title, int? tmdb = null, string? imdb = null, int[]? tags = null, string? slug = null)
        => new()
        {
            ["id"] = id, ["tvdbId"] = tvdb, ["tmdbId"] = tmdb, ["imdbId"] = imdb, ["title"] = title, ["titleSlug"] = slug ?? title.ToLowerInvariant().Replace(' ', '-'),
            ["monitored"] = true, ["path"] = $"/data/tv/{title}", ["qualityProfileId"] = 1,
            ["tags"] = new JsonArray((tags ?? Array.Empty<int>()).Select(t => (JsonNode)t).ToArray()),
            ["statistics"] = new JsonObject { ["episodeFileCount"] = 3, ["episodeCount"] = 6, ["percentOfEpisodes"] = 50.0, ["sizeOnDisk"] = 3000L },
            ["images"] = new JsonArray(new JsonObject { ["coverType"] = "poster", ["remoteUrl"] = $"https://img/tv{tvdb}.jpg" }),
        };

    public static JsonObject SonarrQueueRow(int id, string downloadId, int season, int episode, string series = "Show", int tvdb = 100, int? tmdb = 200)
        => new()
        {
            ["id"] = id, ["downloadId"] = downloadId, ["title"] = $"{series}.S{season:00}E{episode:00}.1080p-GRP", ["status"] = "downloading",
            ["trackedDownloadState"] = "downloading", ["trackedDownloadStatus"] = "ok", ["size"] = 1000.0, ["sizeleft"] = 250.0, ["timeleft"] = "00:01:00",
            ["seriesId"] = 1, ["episodeId"] = id,
            ["series"] = new JsonObject { ["id"] = 1, ["title"] = series, ["tvdbId"] = tvdb, ["tmdbId"] = tmdb, ["images"] = new JsonArray() },
            ["episode"] = new JsonObject { ["id"] = id, ["seasonNumber"] = season, ["episodeNumber"] = episode, ["title"] = $"Episode {episode}" },
        };

    public static JsonObject RadarrQueueRow(int id, int tmdb, string title, string state = "downloading", string status = "ok")
        => new()
        {
            ["id"] = id, ["downloadId"] = "dl" + id, ["title"] = title + ".2010.1080p-GRP", ["status"] = "downloading",
            ["trackedDownloadState"] = state, ["trackedDownloadStatus"] = status, ["size"] = 2000.0, ["sizeleft"] = 1000.0, ["timeleft"] = "00:02:00",
            ["movieId"] = id, ["movie"] = new JsonObject { ["id"] = id, ["title"] = title, ["year"] = 2010, ["tmdbId"] = tmdb, ["images"] = new JsonArray() },
            ["statusMessages"] = new JsonArray(new JsonObject { ["title"] = "x", ["messages"] = new JsonArray("Sample") }),
        };

    public static JsonObject HistoryRow(int id, string eventType, DateTime date, string? downloadId = null, int tmdb = 1, string title = "Movie", int? season = null, int? episode = null)
    {
        var row = new JsonObject
        {
            ["id"] = id, ["eventType"] = eventType, ["date"] = date.ToUniversalTime().ToString("o", CultureInfo.InvariantCulture), ["downloadId"] = downloadId,
        };
        if (season.HasValue)
        {
            row["series"] = new JsonObject { ["id"] = 1, ["title"] = title, ["tvdbId"] = 100, ["tmdbId"] = tmdb, ["images"] = new JsonArray() };
            row["episode"] = new JsonObject { ["id"] = id, ["seasonNumber"] = season, ["episodeNumber"] = episode, ["title"] = "Ep " + episode };
        }
        else
        {
            row["movie"] = new JsonObject { ["id"] = id, ["title"] = title, ["year"] = 2010, ["tmdbId"] = tmdb, ["images"] = new JsonArray() };
        }
        return row;
    }

    public static JsonObject Episode(int id, string airUtc, string series = "Show", int tvdb = 100, int season = 1, int episode = 1)
        => new()
        {
            ["id"] = id, ["seriesId"] = 1, ["tvdbId"] = 9000 + id, ["seasonNumber"] = season, ["episodeNumber"] = episode, ["title"] = "Ep " + episode,
            ["airDateUtc"] = airUtc, ["hasFile"] = false, ["monitored"] = true,
            ["series"] = new JsonObject { ["title"] = series, ["tvdbId"] = tvdb, ["imdbId"] = "tt" + tvdb, ["tmdbId"] = tvdb + 1, ["path"] = "/data/tv/" + series, ["images"] = new JsonArray() },
        };

    private HttpResponseMessage Answer(HttpRequestMessage request)
    {
        var uri = request.RequestUri!;
        var path = uri.AbsolutePath;
        Calls.Enqueue(uri.Host + path + uri.Query);
        if (!Hosts.TryGetValue(uri.Host, out var host)) return IntegrationTransport.Response("{}", 404);
        if (host.RedirectTo != null)
        {
            var redirect = IntegrationTransport.Response("", 302);
            redirect.Headers.Location = new Uri(host.RedirectTo);
            return redirect;
        }
        if (host.FailWith != 0) return IntegrationTransport.Response("{\"message\":\"boom\"}", host.FailWith);

        var query = System.Web.HttpUtility.ParseQueryString(uri.Query);
        string Json(object o) => JsonSerializer.Serialize(o);
        lock (host)
        {
            if (path.StartsWith("/api/v3/notification", StringComparison.Ordinal)) return Notification(host, request, path);
            if (path == "/api/v3/command" && request.Method == HttpMethod.Post)
            {
                var body = request.Content?.ReadAsStringAsync().GetAwaiter().GetResult() ?? string.Empty;
                host.Writes.Add(("POST", path, body));
                if (host.CommandFailWith != 0) return IntegrationTransport.Response("{\"message\":\"command refused\"}", host.CommandFailWith);
                var command = JsonNode.Parse(body)!.AsObject();
                command["id"] = 900 + host.Writes.Count;
                command["status"] = "queued";
                return IntegrationTransport.Response(command.ToJsonString(), 201);
            }
            if (path.StartsWith("/api/v3/command/", StringComparison.Ordinal) && int.TryParse(path["/api/v3/command/".Length..], out var commandId))
                return IntegrationTransport.Response(new JsonObject { ["id"] = commandId, ["status"] = host.CommandStatus, ["message"] = host.CommandMessage }.ToJsonString());
            if (request.Method == HttpMethod.Get && TitleById(host, path) is { } title) return title;
            // Queue removal (DELETE /queue/{id} and /queue/bulk {ids}): recorded with the query, rows dropped.
            if (request.Method == HttpMethod.Delete && path.StartsWith("/api/v3/queue", StringComparison.Ordinal))
            {
                var body = request.Content?.ReadAsStringAsync().GetAwaiter().GetResult() ?? string.Empty;
                host.Writes.Add(("DELETE", path + uri.Query, body));
                var ids = path == "/api/v3/queue/bulk"
                    ? JsonNode.Parse(body)!["ids"]!.AsArray().Select(n => (int)n!).ToList()
                    : new List<int> { int.Parse(path["/api/v3/queue/".Length..], CultureInfo.InvariantCulture) };
                if (!host.Queue.Any(q => ids.Contains((int)q["id"]!))) return IntegrationTransport.Response("{\"message\":\"NotFound\"}", 404);
                host.Queue.RemoveAll(q => ids.Contains((int)q["id"]!));
                return IntegrationTransport.Response("{}");
            }
            if (path == "/api/v3/queue/details" && host.DetailsFailWith != 0)
                return IntegrationTransport.Response("{\"message\":\"boom\"}", host.DetailsFailWith);
            if (path == "/api/v3/queue/details")
                return IntegrationTransport.Response(new JsonArray(host.Queue.Select(q => q.DeepClone()).ToArray()).ToJsonString());
            switch (path)
            {
                case "/api/v3/system/status":
                    return IntegrationTransport.Response(Json(new { appName = host.App, version = host.App == "Sonarr" ? "4.0.20.3014" : "6.0.4.10291" }));
                case "/api/v3/tag":
                    return IntegrationTransport.Response(Json(host.Tags.Select(t => new { id = t.Key, label = t.Value })));
                case "/api/v3/movie":
                    return IntegrationTransport.Response(new JsonArray(host.Movies.Select(m => m.DeepClone()).ToArray()).ToJsonString());
                case "/api/v3/series":
                    return IntegrationTransport.Response(new JsonArray(host.Series.Select(m => m.DeepClone()).ToArray()).ToJsonString());
                case "/api/v3/queue":
                    host.BeforePage?.Invoke(path, PageNumber(query));
                    return Page(host, path, host.Queue, query);
                case "/api/v3/history":
                    host.BeforePage?.Invoke(path, PageNumber(query));
                    return Page(host, path, host.History.OrderByDescending(h => (string)h["date"]!).ToList(), query);
                case "/api/v3/history/since":
                {
                    var since = DateTime.Parse(query["date"]!, CultureInfo.InvariantCulture, DateTimeStyles.AdjustToUniversal);
                    // Like the arrs: strictly after "date".
                    var rows = host.History.Where(h => DateTime.Parse((string)h["date"]!, CultureInfo.InvariantCulture, DateTimeStyles.AdjustToUniversal) > since);
                    return IntegrationTransport.Response(new JsonArray(rows.Select(r => r.DeepClone()).ToArray()).ToJsonString());
                }
                case "/api/v3/episode":
                {
                    var seriesId = int.Parse(query["seriesId"] ?? "0", CultureInfo.InvariantCulture);
                    var rows = host.Episodes.Where(e => (int?)e["seriesId"] == seriesId);
                    return IntegrationTransport.Response(new JsonArray(rows.Select(r => r.DeepClone()).ToArray()).ToJsonString());
                }
                case "/api/v3/calendar":
                    return IntegrationTransport.Response(new JsonArray(host.Calendar.Select(r => r.DeepClone()).ToArray()).ToJsonString());
                case "/api/v3/health":
                    return IntegrationTransport.Response(new JsonArray(host.Health.Select(r => r.DeepClone()).ToArray()).ToJsonString());
                case "/api/v3/diskspace":
                    return IntegrationTransport.Response(new JsonArray(host.DiskSpace.Select(r => r.DeepClone()).ToArray()).ToJsonString());
                case "/api/v3/rootfolder":
                    return IntegrationTransport.Response(new JsonArray(host.RootFolders.Select(r => r.DeepClone()).ToArray()).ToJsonString());
                case "/api/v3/qualityprofile":
                    return IntegrationTransport.Response("[]");
                default:
                    return IntegrationTransport.Response("{}", 404);
            }
        }
    }

    // GET /api/v3/movie/{id} and /api/v3/series/{id}: one title, or 404.
    private static HttpResponseMessage? TitleById(Host host, string path)
    {
        foreach (var (prefix, list) in new[] { ("/api/v3/movie/", host.Movies), ("/api/v3/series/", host.Series) })
        {
            if (!path.StartsWith(prefix, StringComparison.Ordinal) || !int.TryParse(path[prefix.Length..], out var id)) continue;
            var row = list.FirstOrDefault(m => (int)m["id"]! == id);
            return row == null ? IntegrationTransport.Response("{\"message\":\"NotFound\"}", 404) : IntegrationTransport.Response(row.ToJsonString());
        }
        return null;
    }

    // Connect → notifications: list, schema (Webhook only), create (tests first), update, delete, test.
    private static HttpResponseMessage Notification(Host host, HttpRequestMessage request, string path)
    {
        var body = request.Content?.ReadAsStringAsync().GetAwaiter().GetResult() ?? string.Empty;
        if (request.Method != HttpMethod.Get) host.Writes.Add((request.Method.Method, path, body));
        string? Tested(JsonObject n) => host.OnNotificationTest?.Invoke(n);
        HttpResponseMessage Rejected(string message) => IntegrationTransport.Response(
            new JsonArray(new JsonObject { ["propertyName"] = "Url", ["errorMessage"] = message }).ToJsonString(), 400);
        if (path == "/api/v3/notification/schema")
        {
            var events = host.App == "Sonarr"
                ? new[] { "Grab", "Download", "Upgrade", "ImportComplete", "Rename", "SeriesAdd", "SeriesDelete", "EpisodeFileDelete", "EpisodeFileDeleteForUpgrade", "HealthIssue", "HealthRestored", "ApplicationUpdate", "ManualInteractionRequired" }
                : new[] { "Grab", "Download", "Upgrade", "Rename", "MovieAdded", "MovieDelete", "MovieFileDelete", "MovieFileDeleteForUpgrade", "HealthIssue", "HealthRestored", "ApplicationUpdate", "ManualInteractionRequired" };
            var template = new JsonObject { ["name"] = "", ["implementation"] = "Webhook", ["implementationName"] = "Webhook", ["configContract"] = "WebhookSettings", ["tags"] = new JsonArray(), ["includeHealthWarnings"] = false };
            foreach (var e in events) { template["on" + e] = false; template["supportsOn" + e] = true; }
            template["fields"] = new JsonArray(
                new JsonObject { ["order"] = 0, ["name"] = "url", ["type"] = "url" },
                new JsonObject { ["order"] = 1, ["name"] = "method", ["value"] = 1, ["type"] = "select" },
                new JsonObject { ["order"] = 2, ["name"] = "username", ["type"] = "textbox" },
                new JsonObject { ["order"] = 3, ["name"] = "password", ["type"] = "password" },
                new JsonObject { ["order"] = 4, ["name"] = "headers", ["value"] = new JsonArray(), ["type"] = "keyValueList" });
            return IntegrationTransport.Response(new JsonArray(template, new JsonObject { ["implementation"] = "Discord", ["name"] = "" }).ToJsonString());
        }
        if (path == "/api/v3/notification" && request.Method == HttpMethod.Get)
            return IntegrationTransport.Response(new JsonArray(host.Notifications.Select(n => n.DeepClone()).ToArray()).ToJsonString());
        if (path == "/api/v3/notification/test" && request.Method == HttpMethod.Post)
        {
            var error = Tested(JsonNode.Parse(body)!.AsObject());
            return error == null ? IntegrationTransport.Response("{}") : Rejected(error);
        }
        if (path == "/api/v3/notification" && request.Method == HttpMethod.Post)
        {
            var created = JsonNode.Parse(body)!.AsObject();
            if (Tested(created) is { } error) return Rejected(error);
            created["id"] = host.Notifications.Count == 0 ? 1 : host.Notifications.Max(n => (int)n["id"]!) + 1;
            host.Notifications.Add(created);
            return IntegrationTransport.Response(created.ToJsonString(), 201);
        }
        if (int.TryParse(path["/api/v3/notification/".Length..], out var id))
        {
            var index = host.Notifications.FindIndex(n => (int)n["id"]! == id);
            if (index < 0) return IntegrationTransport.Response("{\"message\":\"NotFound\"}", 404);
            if (request.Method == HttpMethod.Delete) { host.Notifications.RemoveAt(index); return IntegrationTransport.Response("{}"); }
            if (request.Method == HttpMethod.Put)
            {
                var updated = JsonNode.Parse(body)!.AsObject();
                if (updated.ToJsonString() != host.Notifications[index].ToJsonString() && Tested(updated) is { } error) return Rejected(error);
                host.Notifications[index] = updated;
                return IntegrationTransport.Response(updated.ToJsonString(), 202);
            }
            return IntegrationTransport.Response(host.Notifications[index].ToJsonString());
        }
        return IntegrationTransport.Response("{}", 404);
    }

    private static int PageNumber(System.Collections.Specialized.NameValueCollection query) => int.Parse(query["page"] ?? "1", CultureInfo.InvariantCulture);

    // Like Sonarr's and Radarr's queue paging: a page past the end is answered with page
    // max(total / size, 1) (integer division), not with an empty page.
    private static HttpResponseMessage Page(Host host, string path, List<JsonObject> all, System.Collections.Specialized.NameValueCollection query)
    {
        var page = PageNumber(query);
        var size = int.Parse(query["pageSize"] ?? "10", CultureInfo.InvariantCulture);
        var records = all.Skip((page - 1) * size).Take(size).Select(r => r.DeepClone()).ToArray();
        if (records.Length == 0 && page > 1)
        {
            page = Math.Max(all.Count / size, 1);
            records = all.Skip((page - 1) * size).Take(size).Select(r => r.DeepClone()).ToArray();
        }
        return IntegrationTransport.Response(new JsonObject
        {
            ["page"] = page, ["pageSize"] = size, ["totalRecords"] = host.ReportedTotal?.Invoke(path, all.Count) ?? all.Count, ["records"] = new JsonArray(records),
        }.ToJsonString());
    }

    public void Dispose()
    {
        foreach (var s in stores) s.Dispose();
        Transport.Dispose();
        Plugin.Dispose();
    }
}
