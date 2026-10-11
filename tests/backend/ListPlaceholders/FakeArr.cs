using System.Globalization;
using System.Text.Json.Nodes;

namespace JE.Tests;

/// <summary>
/// A small in-memory Radarr (127.0.0.1:7878) + Sonarr (127.0.0.1:8989) speaking the v3 API shapes JE uses, with the
/// behaviours measured against Radarr 6.0.4 / Sonarr 4.0.20 (research/arr.md): lookups merge the library row
/// (<c>id</c> when added), duplicate adds answer FluentValidation 400s, seasons missing from a series POST default to
/// monitored, episodes only appear after the async refresh, a season flag CHANGED by a series PUT re-flags that season's
/// episodes (an unchanged flag leaves them alone), the series editor only touches the fields it is sent, the season pass
/// changes only the listed season flags of the stored series (no episode flags).
/// Every request is recorded with its body and API key.
/// </summary>
internal sealed class FakeArr : IDisposable
{
    public const string RadarrUrl = "http://127.0.0.1:7878";
    public const string SonarrUrl = "http://127.0.0.1:8989";
    public const string RadarrKey = "radarr-key";
    public const string SonarrKey = "sonarr-key";

    public sealed record Call(string Service, string Method, string Path, string? Body, string? ApiKey)
    {
        public JsonObject Json => (JsonObject)JsonNode.Parse(Body!)!;
    }

    public List<Call> Calls { get; } = new();
    public IntegrationTransport Transport { get; }

    /// <summary>Return a response to short-circuit a request (or null to let the fake answer).</summary>
    public Func<string, HttpRequestMessage, HttpResponseMessage?>? Override { get; set; }

    /// <summary>Awaited before each request is answered, with the request's token (a slow or hanging arr).</summary>
    public Func<string, HttpRequestMessage, CancellationToken, Task>? Delay { get; set; }

    public List<JsonObject> RadarrCatalog { get; } = new();
    public List<JsonObject> RadarrMovies { get; } = new();
    public List<JsonObject> SonarrCatalog { get; } = new();
    public List<JsonObject> SonarrSeries { get; } = new();
    public List<JsonObject> Episodes { get; } = new();
    public List<JsonObject> Commands { get; } = new();

    /// <summary>Episodes per (tvdbId, season) created when a series is added.</summary>
    public Dictionary<(int Tvdb, int Season), int> EpisodeCounts { get; } = new();

    /// <summary>How many GET /episode calls after an add still see no episodes (Sonarr's async refresh).</summary>
    public int EpisodePollsBeforeVisible { get; set; } = 1;

    private readonly Dictionary<int, int> _pollsLeft = new();

    /// <summary>
    /// How many reads of a newly added series (GET /episode once its episodes are visible, GET /series/{id}) pass
    /// before Sonarr's post-add step runs (0 = done by the first such read). That step (SeriesScannedHandler, monitor
    /// unset) switches off every episode of an unmonitored season and then clears <c>addOptions</c>.
    /// </summary>
    public int PostAddReadsBeforeSettled { get; set; }

    private readonly Dictionary<int, int> _postAddLeft = new();

    /// <summary>Runs every pending post-add step now (Sonarr finishing its add after JE returned).</summary>
    public void RunPostAdds()
    {
        lock (this)
        {
            foreach (var id in _postAddLeft.Keys.ToList())
            {
                PostAdd(id);
            }
        }
    }

    /// <summary>Marks a seeded series as added moments ago: its post-add step is still pending.</summary>
    public void MarkJustAdded(int seriesId)
    {
        lock (this)
        {
            SeriesById(seriesId)["addOptions"] = new JsonObject { ["searchForMissingEpisodes"] = false };
            _postAddLeft[seriesId] = PostAddReadsBeforeSettled;
        }
    }

    // Sonarr's post-add step with addOptions.monitor unset (LegacySetEpisodeMonitoredStatus): the episodes of every
    // unmonitored season are switched off, then addOptions is cleared.
    private void PostAdd(int seriesId)
    {
        _postAddLeft.Remove(seriesId);
        var series = SonarrSeries.FirstOrDefault(s => (int)s["id"]! == seriesId);
        if (series == null)
        {
            return;
        }

        var monitor = (string?)(series["addOptions"] as JsonObject)?["monitor"];
        if (monitor is null or "unknown")
        {
            foreach (var season in ((JsonArray)series["seasons"]!).OfType<JsonObject>().Where(s => !(bool)s["monitored"]!))
            {
                foreach (var episode in Episodes.Where(e => (int)e["seriesId"]! == seriesId && (int)e["seasonNumber"]! == (int)season["seasonNumber"]!))
                {
                    episode["monitored"] = false;
                }
            }
        }

        series.Remove("addOptions");
    }

    // A read of a series whose post-add step is pending: runs it once enough reads passed.
    private void PostAddRead(int seriesId)
    {
        if (_postAddLeft.TryGetValue(seriesId, out var left))
        {
            if (left <= 0)
            {
                PostAdd(seriesId);
            }
            else
            {
                _postAddLeft[seriesId] = left - 1;
            }
        }
    }

    /// <summary>Ends every pending async refresh: the added series' episodes are visible from now on.</summary>
    public void FinishRefreshes()
    {
        lock (this)
        {
            _pollsLeft.Clear();
        }
    }
    private int _nextId = 100;

    public FakeArr()
    {
        Transport = new IntegrationTransport(async (request, ct) =>
        {
            var body = request.Content == null ? null : await request.Content.ReadAsStringAsync();
            var service = request.RequestUri!.Port == 7878 ? "radarr" : request.RequestUri.Port == 8989 ? "sonarr" : "other";
            request.Headers.TryGetValues("X-Api-Key", out var keys);
            var key = keys?.FirstOrDefault();
            lock (Calls)
            {
                Calls.Add(new Call(service, request.Method.Method, request.RequestUri.PathAndQuery, body, key));
            }

            if (Delay != null)
            {
                await Delay(service, request, ct);
            }

            var overridden = Override?.Invoke(service, request);
            if (overridden != null)
            {
                return overridden;
            }

            if (key != (service == "radarr" ? RadarrKey : SonarrKey))
            {
                return IntegrationTransport.Response(string.Empty, 401);
            }

            lock (this)
            {
                return service == "radarr" ? Radarr(request, body) : Sonarr(request, body);
            }
        });
    }

    public static JsonObject Movie(int tmdbId, string title, int year, string? imdb = null) => new()
    {
        ["title"] = title,
        ["tmdbId"] = tmdbId,
        ["imdbId"] = imdb,
        ["year"] = year,
        ["status"] = "released",
        ["overview"] = title + " overview",
        ["inCinemas"] = year.ToString(CultureInfo.InvariantCulture) + "-06-12T00:00:00Z",
        ["remotePoster"] = "https://image.tmdb.org/t/p/original/poster" + tmdbId.ToString(CultureInfo.InvariantCulture) + ".jpg",
        ["monitored"] = false,
        ["qualityProfileId"] = 0,
    };

    public JsonObject AddSeriesToCatalog(int tvdbId, int tmdbId, string title, string slug, params int[] episodesPerSeason)
    {
        var seasons = new JsonArray();
        for (var s = 0; s < episodesPerSeason.Length; s++)
        {
            seasons.Add(new JsonObject { ["seasonNumber"] = s, ["monitored"] = s > 0 });
            EpisodeCounts[(tvdbId, s)] = episodesPerSeason[s];
        }

        var series = new JsonObject
        {
            ["title"] = title,
            ["tvdbId"] = tvdbId,
            ["tmdbId"] = tmdbId,
            ["imdbId"] = "tt" + (1000000 + tvdbId).ToString(CultureInfo.InvariantCulture),
            ["year"] = 2022,
            ["titleSlug"] = slug,
            ["seriesType"] = "standard",
            ["status"] = "ended",
            ["firstAired"] = "2022-01-13T00:00:00Z",
            ["remotePoster"] = "https://artworks.thetvdb.com/banners/posters/" + tvdbId.ToString(CultureInfo.InvariantCulture) + ".jpg",
            ["monitored"] = true,
            ["monitorNewItems"] = "all",
            ["seasons"] = seasons,
        };
        SonarrCatalog.Add(series);
        return series;
    }

    /// <summary>Puts a series straight into the Sonarr "library" (as if added earlier), episodes visible.</summary>
    public JsonObject SeedSeries(int tvdbId, bool monitored, Func<int, bool> seasonMonitored, Func<int, int, bool> episodeMonitored)
    {
        var catalog = SonarrCatalog.Single(s => (int)s["tvdbId"]! == tvdbId);
        var id = _nextId++;
        var seasons = new JsonArray();
        foreach (var season in ((JsonArray)catalog["seasons"]!).OfType<JsonObject>())
        {
            var number = (int)season["seasonNumber"]!;
            seasons.Add(new JsonObject { ["seasonNumber"] = number, ["monitored"] = seasonMonitored(number) });
            for (var e = 1; e <= EpisodeCounts[(tvdbId, number)]; e++)
            {
                Episodes.Add(NewEpisode(id, number, e, episodeMonitored(number, e)));
            }
        }

        var series = (JsonObject)catalog.DeepClone();
        series["id"] = id;
        series["monitored"] = monitored;
        series["seasons"] = seasons;
        series["path"] = "/tv/" + catalog["title"];
        SonarrSeries.Add(series);
        return series;
    }

    public JsonObject SeriesById(int id) => SonarrSeries.Single(s => (int)s["id"]! == id);

    public List<(int Season, int Episode)> MonitoredEpisodes(int seriesId) =>
        Episodes.Where(e => (int)e["seriesId"]! == seriesId && (bool)e["monitored"]!).Select(e => ((int)e["seasonNumber"]!, (int)e["episodeNumber"]!)).OrderBy(x => x).ToList();

    public List<Call> Writes(string service) => Calls.Where(c => c.Service == service && c.Method != "GET").ToList();

    public void Dispose() => Transport.Dispose();

    private static HttpResponseMessage Json(JsonNode node, int status = 200) => IntegrationTransport.Response(node.ToJsonString(), status);

    private static HttpResponseMessage Validation(string property, string code, string message) =>
        Json(new JsonArray(new JsonObject { ["propertyName"] = property, ["errorMessage"] = message, ["errorCode"] = code, ["severity"] = "error" }), 400);

    private static Dictionary<string, string> Query(HttpRequestMessage request) =>
        request.RequestUri!.Query.TrimStart('?').Split('&', StringSplitOptions.RemoveEmptyEntries)
            .Select(p => p.Split('=', 2))
            .ToDictionary(p => p[0], p => Uri.UnescapeDataString(p.Length > 1 ? p[1] : string.Empty));

    private HttpResponseMessage Radarr(HttpRequestMessage request, string? body)
    {
        var path = request.RequestUri!.AbsolutePath;
        switch (request.Method.Method, path)
        {
            case ("GET", "/api/v3/qualityprofile"):
                return Json(new JsonArray(new JsonObject { ["id"] = 1, ["name"] = "Any" }, new JsonObject { ["id"] = 4, ["name"] = "HD-1080p" }));
            case ("GET", "/api/v3/rootfolder"):
                return Json(new JsonArray(new JsonObject { ["id"] = 1, ["path"] = "/movies", ["freeSpace"] = 5_000_000_000_000L, ["accessible"] = true }));
            case ("GET", "/api/v3/movie/lookup"):
            {
                var term = Query(request)["term"];
                var hits = RadarrCatalog.Where(m => Matches(m, term)).Select(m =>
                {
                    var copy = (JsonObject)m.DeepClone();
                    var added = RadarrMovies.FirstOrDefault(x => (int?)x["tmdbId"] == (int?)m["tmdbId"]);
                    if (added != null)
                    {
                        copy["id"] = (int)added["id"]!;
                        copy["monitored"] = (bool)added["monitored"]!;
                    }

                    return (JsonNode)copy;
                });
                return Json(new JsonArray(hits.ToArray()));
            }

            case ("POST", "/api/v3/movie"):
            {
                var movie = (JsonObject)JsonNode.Parse(body!)!;
                if (RadarrMovies.Any(m => (int)m["tmdbId"]! == (int)movie["tmdbId"]!))
                {
                    return Validation("TmdbId", "MovieExistsValidator", "This movie has already been added");
                }

                if ((int)movie["qualityProfileId"]! is not (1 or 4))
                {
                    return Validation("QualityProfileId", "QualityProfileExistsValidator", "Quality Profile does not exist");
                }

                if ((string)movie["rootFolderPath"]! != "/movies")
                {
                    return Validation("RootFolderPath", "RootFolderExistsValidator", "Root folder '" + movie["rootFolderPath"] + "' does not exist");
                }

                movie["id"] = _nextId++;
                RadarrMovies.Add(movie);
                return Json(movie, 201);
            }

            case ("POST", "/api/v3/command"):
                Commands.Add((JsonObject)JsonNode.Parse(body!)!);
                return Json(new JsonObject { ["id"] = _nextId++, ["status"] = "queued" }, 201);
        }

        return Json(new JsonObject { ["message"] = "NotFound", ["description"] = "at Radarr.Http.Something() in /src/Radarr.cs:line 1" }, 404);
    }

    private HttpResponseMessage Sonarr(HttpRequestMessage request, string? body)
    {
        var path = request.RequestUri!.AbsolutePath;
        var method = request.Method.Method;
        if (method == "GET" && path == "/api/v3/qualityprofile")
        {
            return Json(new JsonArray(new JsonObject { ["id"] = 1, ["name"] = "Any" }, new JsonObject { ["id"] = 4, ["name"] = "HD-1080p" }));
        }

        if (method == "GET" && path == "/api/v3/rootfolder")
        {
            return Json(new JsonArray(new JsonObject { ["id"] = 1, ["path"] = "/tv", ["freeSpace"] = 5_000_000_000_000L, ["accessible"] = true }));
        }

        if (method == "GET" && path == "/api/v3/series/lookup")
        {
            var term = Query(request)["term"];
            var hits = SonarrCatalog.Where(s => Matches(s, term)).Select(s =>
            {
                var added = SonarrSeries.FirstOrDefault(x => (int)x["tvdbId"]! == (int)s["tvdbId"]!);
                var copy = (JsonObject)(added ?? s).DeepClone();
                return (JsonNode)copy;
            });
            return Json(new JsonArray(hits.ToArray()));
        }

        if (method == "POST" && path == "/api/v3/series")
        {
            var series = (JsonObject)JsonNode.Parse(body!)!;
            var tvdbId = (int)series["tvdbId"]!;
            if (SonarrSeries.Any(s => (int)s["tvdbId"]! == tvdbId))
            {
                return Validation("TvdbId", "SeriesExistsValidator", "This series has already been added");
            }

            if (series["title"] == null)
            {
                return Validation("Title", "NotEmptyValidator", "'Title' must not be empty.");
            }

            var catalog = SonarrCatalog.Single(s => (int)s["tvdbId"]! == tvdbId);
            var id = _nextId++;
            var sent = ((JsonArray?)series["seasons"])?.OfType<JsonObject>().ToDictionary(s => (int)s["seasonNumber"]!, s => (bool)s["monitored"]!) ?? new Dictionary<int, bool>();
            var seasons = new JsonArray();
            foreach (var season in ((JsonArray)catalog["seasons"]!).OfType<JsonObject>())
            {
                var number = (int)season["seasonNumber"]!;
                // Sonarr: a season missing from the POST falls back to the metadata default (monitored).
                var monitored = sent.TryGetValue(number, out var flag) ? flag : true;
                seasons.Add(new JsonObject { ["seasonNumber"] = number, ["monitored"] = monitored });
                for (var e = 1; e <= EpisodeCounts[(tvdbId, number)]; e++)
                {
                    Episodes.Add(NewEpisode(id, number, e, monitored));
                }
            }

            series["id"] = id;
            series["seasons"] = seasons;
            series["titleSlug"] = catalog["titleSlug"]!.DeepClone();
            SonarrSeries.Add(series);
            _pollsLeft[id] = EpisodePollsBeforeVisible;
            _postAddLeft[id] = PostAddReadsBeforeSettled;
            return Json(series, 201);
        }

        if (method == "PUT" && path == "/api/v3/series/editor")
        {
            // Series editor: applies only the fields sent (here: monitored); seasons and episode flags stay as stored.
            var update = (JsonObject)JsonNode.Parse(body!)!;
            var updated = new JsonArray();
            foreach (var id in ((JsonArray)update["seriesIds"]!).Select(n => (int)n!))
            {
                var target = SonarrSeries.Single(s => (int)s["id"]! == id);
                if (update["monitored"] is JsonValue monitored)
                {
                    target["monitored"] = monitored.GetValue<bool>();
                }

                updated.Add(target.DeepClone());
            }

            return Json(updated, 202);
        }

        if (method == "POST" && path == "/api/v3/seasonpass")
        {
            // Season pass (measured on Sonarr 4.0.20): reads the STORED series and applies only the series flag and the
            // listed seasons' flags. Without monitoringOptions no episode flag changes; with "skip" nothing is saved.
            var update = (JsonObject)JsonNode.Parse(body!)!;
            if (update["monitoringOptions"] is JsonObject options && (string?)options["monitor"] == "skip")
            {
                return Json(new JsonObject(), 202);
            }

            foreach (var item in ((JsonArray)update["series"]!).OfType<JsonObject>())
            {
                var target = SonarrSeries.Single(s => (int)s["id"]! == (int)item["id"]!);
                if (item["monitored"] is JsonValue monitored)
                {
                    target["monitored"] = monitored.GetValue<bool>();
                }

                foreach (var sent in (item["seasons"] as JsonArray ?? new JsonArray()).OfType<JsonObject>())
                {
                    var stored = ((JsonArray)target["seasons"]!).OfType<JsonObject>().FirstOrDefault(s => (int)s["seasonNumber"]! == (int)sent["seasonNumber"]!);
                    if (stored != null)
                    {
                        stored["monitored"] = (bool)sent["monitored"]!;
                    }
                }
            }

            return Json(new JsonObject(), 202);
        }

        if (path.StartsWith("/api/v3/series/", StringComparison.Ordinal) && int.TryParse(path["/api/v3/series/".Length..], out var seriesId))
        {
            var existing = SonarrSeries.FirstOrDefault(s => (int)s["id"]! == seriesId);
            if (existing == null)
            {
                return Json(new JsonObject { ["message"] = "Series with ID " + seriesId + " does not exist", ["description"] = "at NzbDrone.Core.Tv.SeriesService.GetSeries() in /src/x.cs:line 9" }, 404);
            }

            if (method == "GET")
            {
                PostAddRead(seriesId);
                var copy = (JsonObject)existing.DeepClone();
                copy["statistics"] = new JsonObject { ["episodeCount"] = 1 };
                foreach (var season in ((JsonArray)copy["seasons"]!).OfType<JsonObject>())
                {
                    season["statistics"] = new JsonObject { ["episodeCount"] = 1 };
                }

                return Json(copy);
            }

            if (method == "PUT")
            {
                var update = (JsonObject)JsonNode.Parse(body!)!;
                foreach (var season in ((JsonArray)update["seasons"]!).OfType<JsonObject>())
                {
                    var number = (int)season["seasonNumber"]!;
                    var before = ((JsonArray)existing["seasons"]!).OfType<JsonObject>().Single(s => (int)s["seasonNumber"]! == number);
                    var wasMonitored = (bool)before["monitored"]!;
                    var nowMonitored = (bool)season["monitored"]!;
                    if (wasMonitored != nowMonitored)
                    {
                        foreach (var episode in Episodes.Where(e => (int)e["seriesId"]! == seriesId && (int)e["seasonNumber"]! == number))
                        {
                            episode["monitored"] = nowMonitored;
                        }
                    }

                    before["monitored"] = nowMonitored;
                }

                existing["monitored"] = (bool)update["monitored"]!;
                return Json(existing, 202);
            }
        }

        if (method == "GET" && path == "/api/v3/episode")
        {
            var query = Query(request);
            var id = int.Parse(query["seriesId"], CultureInfo.InvariantCulture);
            if (_pollsLeft.TryGetValue(id, out var left) && left > 0)
            {
                _pollsLeft[id] = left - 1;
                return Json(new JsonArray());
            }

            PostAddRead(id);

            var episodes = Episodes.Where(e => (int)e["seriesId"]! == id
                && (!query.TryGetValue("seasonNumber", out var season) || (int)e["seasonNumber"]! == int.Parse(season, CultureInfo.InvariantCulture)));
            return Json(new JsonArray(episodes.Select(e => (JsonNode)e.DeepClone()).ToArray()));
        }

        if (method == "PUT" && path == "/api/v3/episode/monitor")
        {
            var update = (JsonObject)JsonNode.Parse(body!)!;
            var ids = ((JsonArray)update["episodeIds"]!).Select(n => (int)n!).ToList();
            var updated = new JsonArray();
            foreach (var id in ids)
            {
                var episode = Episodes.FirstOrDefault(e => (int)e["id"]! == id);
                if (episode == null)
                {
                    return Json(new JsonObject { ["message"] = "Episode with ID " + id + " does not exist" }, 404);
                }

                episode["monitored"] = (bool)update["monitored"]!;
                updated.Add(episode.DeepClone());
            }

            return Json(updated, 202);
        }

        if (method == "POST" && path == "/api/v3/command")
        {
            Commands.Add((JsonObject)JsonNode.Parse(body!)!);
            return Json(new JsonObject { ["id"] = _nextId++, ["status"] = "queued" }, 201);
        }

        return Json(new JsonObject { ["message"] = "NotFound" }, 404);
    }

    private JsonObject NewEpisode(int seriesId, int season, int number, bool monitored) => new()
    {
        ["id"] = _nextId++,
        ["seriesId"] = seriesId,
        ["seasonNumber"] = season,
        ["episodeNumber"] = number,
        ["monitored"] = monitored,
        ["hasFile"] = false,
    };

    private static bool Matches(JsonObject item, string term)
    {
        var lower = term.ToLowerInvariant();
        if (lower.StartsWith("tmdb:", StringComparison.Ordinal))
        {
            return item["tmdbId"]?.ToString() == lower[5..];
        }

        if (lower.StartsWith("tvdb:", StringComparison.Ordinal))
        {
            return item["tvdbId"]?.ToString() == lower[5..];
        }

        if (lower.StartsWith("imdb:", StringComparison.Ordinal))
        {
            return (string?)item["imdbId"] == lower[5..];
        }

        return ((string)item["title"]!).Contains(term, StringComparison.OrdinalIgnoreCase);
    }
}
