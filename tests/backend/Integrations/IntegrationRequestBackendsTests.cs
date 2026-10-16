using System.Net.Http;
using System.Text.Json;
using System.Text.Json.Nodes;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr.Live;

namespace JE.Tests;

/// <summary>
/// Phase 3b: the two request executors. DirectArrBackend against a synthetic Sonarr/Radarr (per-scope
/// add and field-scoped monitoring tables, 4K routing, add defaults checked against the system
/// snapshot, lookup id matching, "already added" merges, maybe-sent reconciliation, connection
/// generation) and SeerrBackend against a synthetic Seerr shaped like the lab Seerr's real answers
/// (409 duplicate, 202 "No seasons available", quota and permission refusals, three-state partial
/// requests, 4K capability, read-back by requester).
/// </summary>
[Collection("Plugin singleton")]
public class IntegrationRequestBackendsTests
{
    internal sealed class Lab : IDisposable
    {
        public FakeArr Arr { get; } = new();
        public FakeArr.Host Radarr { get; }
        public FakeArr.Host Radarr4k { get; }
        public FakeArr.Host Sonarr { get; }
        public ArrStateStore Store { get; }
        public DirectArrBackend Direct { get; }
        public PluginConfiguration Config => Arr.Plugin.Plugin.Configuration;

        public Lab(bool defaults = true)
        {
            Radarr = Arr.Add("radarr.test", "Radarr");
            Radarr4k = Arr.Add("radarr4k.test", "Radarr");
            Sonarr = Arr.Add("sonarr.test", "Sonarr");
            foreach (var (host, root) in new[] { (Radarr, "/data/movies"), (Radarr4k, "/data/movies4k"), (Sonarr, "/data/tv") })
            {
                host.Profiles.Add(new JsonObject { ["id"] = 4, ["name"] = "HD-1080p" });
                host.Profiles.Add(new JsonObject { ["id"] = 5, ["name"] = "Ultra-HD" });
                host.RootFolders.Add(new JsonObject { ["path"] = root, ["freeSpace"] = 1_000_000_000_000L, ["accessible"] = true });
                host.Tags[90] = DirectArrBackend.AttributionTag;   // already there (a test without it removes it)
            }
            Arr.Configure(("Radarr", ArrKind.Radarr, "http://radarr.test", "key-radarr"), ("Radarr 4K", ArrKind.Radarr, "http://radarr4k.test", "key-radarr4k"), ("Sonarr", ArrKind.Sonarr, "http://sonarr.test", "key-sonarr"));
            Config.ArrIntegrationEnabled = true;
            Config.ArrPhase1Enabled = true;
            Config.ArrPhase3Enabled = true;
            Config.ArrRequestBackend = "je";
            Edit("Radarr 4K", row => row["Role"] = "4k");
            if (defaults)
            {
                Edit("Radarr", row => row["Defaults"] = Defaults(4, "/data/movies"));
                Edit("Radarr 4K", row => row["Defaults"] = Defaults(5, "/data/movies4k"));
                Edit("Sonarr", row => row["Defaults"] = Defaults(4, "/data/tv"));
            }
            Store = Arr.Store();
            Direct = new DirectArrBackend(Arr.Factory, Store, null, (_, _) => Task.CompletedTask);
        }

        public static JsonObject Defaults(int profile, string root, params int[] tags)
            => new() { ["QualityProfileId"] = profile, ["RootFolderPath"] = root, ["Tags"] = new JsonArray(tags.Select(t => (JsonNode)t).ToArray()) };

        /// <summary>Changes one stored instance row (by name), like a config-page save that keeps the key.</summary>
        public void Edit(string name, Action<JsonObject> change)
        {
            foreach (var radarr in new[] { true, false })
            {
                var json = radarr ? Config.RadarrInstances : Config.SonarrInstances;
                var rows = JsonNode.Parse(json)!.AsArray();
                var row = rows.FirstOrDefault(r => (string?)r!["Name"] == name);
                if (row == null) continue;
                change(row.AsObject());
                if (radarr) Config.RadarrInstances = rows.ToJsonString();
                else Config.SonarrInstances = rows.ToJsonString();
            }
        }

        public ArrConnection Instance(string name) => Arr.Instance(name);

        public RequestJob Job(MutationInput input, string instance, string? generation = null, int? seerrUser = null, string backend = "je", string? source = null)
        {
            var normalized = input.Normalize()!;
            var id = Instance(instance).Id;
            return new RequestJob(Guid.NewGuid().ToString("N"), Guid.NewGuid().ToString("N"), normalized,
                new RequestAuthorization(Guid.NewGuid(), null, "request", normalized.Scope, normalized.Variant, backend, backend == "je" ? id : string.Empty,
                    backend == "je" ? generation ?? Arr.Factory.ConnectionGeneration(id)! : string.Empty, "rev", source, seerrUser),
                "sending", 1, DateTimeOffset.UtcNow, "queued_outage", "request:x", normalized.Fingerprint);
        }

        public static JsonObject MovieLookup(int tmdb, string title = "The General") => new() { ["title"] = title, ["year"] = 1926, ["tmdbId"] = tmdb, ["imdbId"] = "tt0017925", ["titleSlug"] = "the-general", ["images"] = new JsonArray() };

        public static JsonObject SeriesLookup(int tvdb, string title = "Blake's 7", int seasons = 4)
            => new()
            {
                ["title"] = title, ["year"] = 1978, ["tvdbId"] = tvdb, ["tmdbId"] = 1731, ["titleSlug"] = "blakes-7", ["images"] = new JsonArray(),
                ["seasons"] = new JsonArray(Enumerable.Range(0, seasons + 1).Select(s => (JsonNode)new JsonObject { ["seasonNumber"] = s, ["monitored"] = true }).ToArray()),
            };

        public void Dispose() => Arr.Dispose();
    }

    private static MutationInput Movie(int tmdb = 961, string variant = "standard") => new() { Key = "movie:tmdb:" + tmdb, Variant = variant };
    private static MutationInput Series(string scope, int[]? seasons = null, RequestEpisode[]? episodes = null, int tvdb = 75565)
        => new() { Key = "tv:tvdb:" + tvdb, Scope = scope, Seasons = seasons ?? Array.Empty<int>(), Episodes = episodes ?? Array.Empty<RequestEpisode>() };
    private static string? Pass() => null;
    private static JsonObject Body(FakeArr.Host host, string method, string path) => JsonNode.Parse(host.Writes.Single(w => w.Method == method && w.Path == path).Body)!.AsObject();
    private static int[] Ids(JsonNode? array) => array!.AsArray().Select(n => (int)n!).OrderBy(n => n).ToArray();

    // ------------------------------------------------------------------ movies

    [Fact]
    public async Task ANewMovieIsAddedWithTheCheckedDefaultsMonitoredAndSearchedThenReadBack()
    {
        using var lab = new Lab();
        lab.Radarr.Lookup.Add(Lab.MovieLookup(961));
        var result = await lab.Direct.SendAsync(lab.Job(Movie(), "Radarr"), Pass, default);
        Assert.True(result.Confirmed, result.Outcome.Message);
        Assert.Equal(("accepted", "looking"), (result.Outcome.Outcome, result.Outcome.Reason));
        var add = Body(lab.Radarr, "POST", "/api/v3/movie");
        Assert.Equal(961, (int)add["tmdbId"]!);
        Assert.Equal(4, (int)add["qualityProfileId"]!);
        Assert.Equal("/data/movies", (string)add["rootFolderPath"]!);
        Assert.True((bool)add["monitored"]!);
        Assert.Equal("released", (string)add["minimumAvailability"]!);
        Assert.True((bool)add["addOptions"]!["searchForMovie"]!);
        Assert.False(add.ContainsKey("id"));
        Assert.Equal(new[] { 90 }, add["tags"]!.AsArray().Select(t => (int)t!).ToArray());   // the attribution tag
        Assert.Single(lab.Radarr.Writes);
        Assert.Empty(lab.Radarr4k.Writes);
    }

    [Fact]
    public async Task TheAttributionTagIsCreatedOnAnInstanceWithoutItAndAFailedCreateDoesNotStopTheAdd()
    {
        using var lab = new Lab();
        lab.Sonarr.Tags.Clear();
        lab.Sonarr.Tags[3] = "kids";
        lab.Sonarr.Lookup.Add(Lab.SeriesLookup(75565, seasons: 2));
        var result = await lab.Direct.SendAsync(lab.Job(Series("seasons", new[] { 1 }), "Sonarr"), Pass, default);
        Assert.True(result.Confirmed, result.Outcome.Message);
        Assert.Equal("POST /api/v3/tag", lab.Sonarr.Writes.Select(w => w.Method + " " + w.Path).First());
        Assert.Equal("je-requested", lab.Sonarr.Tags[4]);
        Assert.Equal(new[] { 4 }, Body(lab.Sonarr, "POST", "/api/v3/series")["tags"]!.AsArray().Select(t => (int)t!).ToArray());

        // Radarr refuses to create it: the movie is still added, untagged.
        lab.Radarr.Tags.Clear();
        lab.Radarr.OnWrite = (method, path, _) => path == "/api/v3/tag" ? IntegrationTransport.Response("{\"message\":\"nope\"}", 400) : null;
        lab.Radarr.Lookup.Add(Lab.MovieLookup(961));
        var movie = await lab.Direct.SendAsync(lab.Job(Movie(), "Radarr"), Pass, default);
        Assert.True(movie.Confirmed, movie.Outcome.Message);
        Assert.Empty(Body(lab.Radarr, "POST", "/api/v3/movie")["tags"]!.AsArray());

        // Seen live: the arr creates it but the answer is lost on the way back. One more read finds it.
        lab.Radarr4k.Tags.Clear();
        lab.Radarr4k.OnWrite = (method, path, _) =>
        {
            if (path != "/api/v3/tag") return null;
            lab.Radarr4k.Tags[12] = DirectArrBackend.AttributionTag;
            return IntegrationTransport.Response("{\"message\":\"bad gateway\"}", 502);
        };
        lab.Radarr4k.Lookup.Add(Lab.MovieLookup(962));
        var lost = await lab.Direct.SendAsync(lab.Job(Movie(962, "4k"), "Radarr 4K"), Pass, default);
        Assert.True(lost.Confirmed, lost.Outcome.Message);
        Assert.Equal(new[] { 12 }, Body(lab.Radarr4k, "POST", "/api/v3/movie")["tags"]!.AsArray().Select(t => (int)t!).ToArray());
    }

    [Fact]
    public async Task A4kRequestGoesOnlyToThe4kInstanceAndNeverFallsBackToTheStandardOne()
    {
        using var lab = new Lab();
        lab.Radarr.Lookup.Add(Lab.MovieLookup(961));
        lab.Radarr4k.Lookup.Add(Lab.MovieLookup(961));
        var fourK = await lab.Direct.SendAsync(lab.Job(Movie(variant: "4k"), "Radarr 4K"), Pass, default);
        Assert.True(fourK.Confirmed, fourK.Outcome.Message);
        Assert.Equal(5, (int)Body(lab.Radarr4k, "POST", "/api/v3/movie")["qualityProfileId"]!);
        Assert.Equal("/data/movies4k", (string)Body(lab.Radarr4k, "POST", "/api/v3/movie")["rootFolderPath"]!);
        Assert.Empty(lab.Radarr.Writes);
        // A 4K job bound to the standard instance (or a standard job bound to the 4K one) is held, with no call at all.
        var calls = lab.Arr.Calls.Count;
        var crossed = await lab.Direct.SendAsync(lab.Job(Movie(variant: "4k"), "Radarr"), Pass, default);
        Assert.True(crossed.Parked);
        Assert.Equal("instance_changed", crossed.Outcome.Reason);
        var wrongWay = await lab.Direct.SendAsync(lab.Job(Movie(), "Radarr 4K"), Pass, default);
        Assert.Equal("instance_changed", wrongWay.Outcome.Reason);
        Assert.Equal(calls, lab.Arr.Calls.Count);
        Assert.Empty(lab.Radarr.Writes);
    }

    [Fact]
    public async Task AlreadyAddedByAnotherWriterIsAMergeThatOnlyMonitorsAndSearches()
    {
        using var lab = new Lab();
        lab.Radarr.Lookup.Add(Lab.MovieLookup(961));
        // Another writer adds the movie (unmonitored) between JE's read and its POST.
        lab.Radarr.OnWrite = (method, path, _) =>
        {
            if (method == "POST" && path == "/api/v3/movie" && lab.Radarr.Movies.Count == 0)
                lab.Radarr.Movies.Add(new JsonObject { ["id"] = 77, ["tmdbId"] = 961, ["title"] = "The General", ["monitored"] = false, ["hasFile"] = false });
            return null;
        };
        var result = await lab.Direct.SendAsync(lab.Job(Movie(), "Radarr"), Pass, default);
        Assert.True(result.Confirmed, result.Outcome.Message);
        Assert.Equal("merged", result.Outcome.Outcome);
        Assert.Equal(new[] { 77 }, Ids(Body(lab.Radarr, "PUT", "/api/v3/movie/editor")["movieIds"]));
        Assert.Contains(lab.Radarr.Writes, w => w.Path == "/api/v3/command" && w.Body.Contains("MoviesSearch", StringComparison.Ordinal) && w.Body.Contains("77", StringComparison.Ordinal));
        Assert.Single(lab.Radarr.Movies);
    }

    [Fact]
    public async Task AnExistingMovieIsChangedWithFieldScopedEditsOnlyAndAFiledOneNeedsNoWrite()
    {
        using var lab = new Lab();
        lab.Radarr.Movies.Add(new JsonObject { ["id"] = 12, ["tmdbId"] = 961, ["title"] = "The General", ["monitored"] = false, ["hasFile"] = false, ["qualityProfileId"] = 9 });
        var result = await lab.Direct.SendAsync(lab.Job(Movie(), "Radarr"), Pass, default);
        Assert.True(result.Confirmed);
        Assert.Equal("merged", result.Outcome.Outcome);
        Assert.Equal(new[] { "PUT /api/v3/movie/editor", "POST /api/v3/command" }, lab.Radarr.Writes.Select(w => w.Method + " " + w.Path));
        Assert.Equal(9, (int)lab.Radarr.Movies[0]["qualityProfileId"]!);   // nothing else about the movie changed
        lab.Radarr.Writes.Clear();
        lab.Radarr.Movies[0]["hasFile"] = true;
        var again = await lab.Direct.SendAsync(lab.Job(Movie(), "Radarr"), Pass, default);
        Assert.True(again.Confirmed);
        Assert.Empty(lab.Radarr.Writes);
    }

    [Theory]
    [InlineData("movie")]
    [InlineData("series-other-id")]
    [InlineData("series-no-tvdb")]
    public async Task ALookupRowCountsOnlyWhenItCarriesTheRequestedIdAboveZero(string shape)
    {
        using var lab = new Lab();
        RequestJob job;
        // The arrs' lookup is a metadata search: it can answer with other titles than the one asked for.
        lab.Radarr.LookupIgnoresTerm = true;
        lab.Sonarr.LookupIgnoresTerm = true;
        if (shape == "movie")
        {
            lab.Radarr.Lookup.Add(Lab.MovieLookup(999));
            lab.Radarr.Lookup.Add(Lab.MovieLookup(0));
            job = lab.Job(Movie(961), "Radarr");
        }
        else
        {
            var row = Lab.SeriesLookup(shape == "series-other-id" ? 11111 : 0);
            row["tmdbId"] = shape == "series-other-id" ? 4444 : 1731;
            lab.Sonarr.Lookup.Add(row);
            job = lab.Job(shape == "series-other-id" ? Series("seasons", new[] { 1 }) : new MutationInput { Key = "tv:tmdb:1731", Scope = "seasons", Seasons = new[] { 1 } }, "Sonarr");
        }
        var result = await lab.Direct.SendAsync(job, Pass, default);
        Assert.True(result.Parked);
        Assert.Equal("title_not_found", result.Outcome.Reason);
        Assert.Empty(lab.Radarr.Writes);
        Assert.Empty(lab.Sonarr.Writes);
    }

    // ------------------------------------------------------------------ series: per-scope tables

    // An existing series with other monitoring: S1 and its episodes monitored, S2 not, S3 not but S3E1 monitored.
    private static void ExistingSeries(Lab lab, int tvdb = 75565)
    {
        lab.Sonarr.Series.Add(new JsonObject
        {
            ["id"] = 30, ["tvdbId"] = tvdb, ["title"] = "Blake's 7", ["monitored"] = true, ["monitorNewItems"] = "none", ["qualityProfileId"] = 2,
            ["seasons"] = new JsonArray(
                new JsonObject { ["seasonNumber"] = 0, ["monitored"] = false },
                new JsonObject { ["seasonNumber"] = 1, ["monitored"] = true },
                new JsonObject { ["seasonNumber"] = 2, ["monitored"] = false },
                new JsonObject { ["seasonNumber"] = 3, ["monitored"] = false },
                new JsonObject { ["seasonNumber"] = 4, ["monitored"] = false }),
        });
        var id = 3000;
        foreach (var season in new[] { 1, 2, 3, 4 })
            foreach (var episode in new[] { 1, 2, 3 })
                lab.Sonarr.Episodes.Add(new JsonObject { ["id"] = ++id, ["seriesId"] = 30, ["seasonNumber"] = season, ["episodeNumber"] = episode, ["monitored"] = season == 1 || (season == 3 && episode == 1), ["hasFile"] = false });
    }

    private static int EpisodeId(Lab lab, int season, int episode) => (int)lab.Sonarr.Episodes.Single(e => (int)e["seasonNumber"]! == season && (int)e["episodeNumber"]! == episode)["id"]!;
    private static string Monitored(Lab lab) => string.Join(" ", lab.Sonarr.Episodes.Where(e => (bool)e["monitored"]!).Select(e => $"S{(int)e["seasonNumber"]!}E{(int)e["episodeNumber"]!}"));
    private static string SeasonFlags(Lab lab) => string.Join(" ", lab.Sonarr.Series[0]["seasons"]!.AsArray().Select(s => $"{(int)s!["seasonNumber"]!}:{((bool)s["monitored"]! ? 1 : 0)}"));

    [Theory]
    [InlineData("seasons", "2", "", "POST /api/v3/seasonpass|PUT /api/v3/episode/monitor|POST /api/v3/command", "S1E1 S1E2 S1E3 S2E1 S2E2 S2E3 S3E1", "0:0 1:1 2:1 3:0 4:0", "none")]
    [InlineData("episodes", "", "3x2,3x3", "PUT /api/v3/episode/monitor|POST /api/v3/command", "S1E1 S1E2 S1E3 S3E1 S3E2 S3E3", "0:0 1:1 2:0 3:0 4:0", "none")]
    [InlineData("future", "3", "", "PUT /api/v3/series/editor|POST /api/v3/seasonpass|PUT /api/v3/episode/monitor|POST /api/v3/command", "S1E1 S1E2 S1E3 S3E1 S3E2 S3E3", "0:0 1:1 2:0 3:1 4:0", "all")]
    [InlineData("next_season", "4", "", "POST /api/v3/seasonpass|PUT /api/v3/episode/monitor|POST /api/v3/command", "S1E1 S1E2 S1E3 S3E1 S4E1 S4E2 S4E3", "0:0 1:1 2:0 3:0 4:1", "none")]
    public async Task AnExistingSeriesGetsOnlyTheAskedScopeMonitoredAndOtherMonitoringStays(string scope, string seasons, string episodes, string writes, string monitored, string flags, string newItems)
    {
        using var lab = new Lab();
        ExistingSeries(lab);
        var input = Series(scope,
            seasons.Length == 0 ? null : seasons.Split(',').Select(int.Parse).ToArray(),
            episodes.Length == 0 ? null : episodes.Split(',').Select(e => new RequestEpisode(int.Parse(e.Split('x')[0]), int.Parse(e.Split('x')[1]))).ToArray());
        var result = await lab.Direct.SendAsync(lab.Job(input, "Sonarr"), Pass, default);
        Assert.True(result.Confirmed, result.Outcome.Message);
        Assert.Equal("merged", result.Outcome.Outcome);
        Assert.Equal(writes, string.Join("|", lab.Sonarr.Writes.Select(w => w.Method + " " + w.Path)));
        Assert.Equal(monitored, Monitored(lab));
        Assert.Equal(flags, SeasonFlags(lab));
        Assert.Equal(newItems, (string)lab.Sonarr.Series[0]["monitorNewItems"]!);
        Assert.Equal(2, (int)lab.Sonarr.Series[0]["qualityProfileId"]!);
        Assert.DoesNotContain(lab.Sonarr.Writes, w => w.Method == "PUT" && w.Path.StartsWith("/api/v3/series/3", StringComparison.Ordinal));
        if (scope != "episodes")
        {
            // seasonpass lists only the asked season.
            var pass = Body(lab.Sonarr, "POST", "/api/v3/seasonpass")["series"]![0]!;
            Assert.Equal(new[] { int.Parse(seasons) }, pass["seasons"]!.AsArray().Select(s => (int)s!["seasonNumber"]!).ToArray());
            Assert.Contains(lab.Sonarr.Writes, w => w.Body.Contains("SeasonSearch", StringComparison.Ordinal) && w.Body.Contains($"\"seasonNumber\":{seasons}", StringComparison.Ordinal));
        }
        else
        {
            Assert.Equal(new[] { EpisodeId(lab, 3, 2), EpisodeId(lab, 3, 3) }, Ids(Body(lab.Sonarr, "PUT", "/api/v3/episode/monitor")["episodeIds"]));
            var search = JsonNode.Parse(lab.Sonarr.Writes.Single(w => w.Path == "/api/v3/command").Body)!;
            Assert.Equal("EpisodeSearch", (string)search["name"]!);
            Assert.Equal(new[] { EpisodeId(lab, 3, 2), EpisodeId(lab, 3, 3) }, Ids(search["episodeIds"]));
        }
    }

    [Theory]
    [InlineData("seasons", "1", "", "0:0 1:1 2:0 3:0 4:0", "none", true)]
    [InlineData("future", "2", "", "0:0 1:0 2:1 3:0 4:0", "all", true)]
    [InlineData("next_season", "4", "", "0:0 1:0 2:0 3:0 4:1", "none", true)]
    [InlineData("episodes", "", "1x2", "0:0 1:0 2:0 3:0 4:0", "none", false)]
    public async Task ANewSeriesIsAddedWithExactlyTheAskedSeasonsAndNoMonitoringPreset(string scope, string seasons, string episodes, string flags, string newItems, bool sonarrSearches)
    {
        using var lab = new Lab();
        lab.Sonarr.Lookup.Add(Lab.SeriesLookup(75565));
        lab.Sonarr.EpisodeList[75565] = new[] { (1, 1), (1, 2), (2, 1), (4, 1) };
        var input = Series(scope,
            seasons.Length == 0 ? null : seasons.Split(',').Select(int.Parse).ToArray(),
            episodes.Length == 0 ? null : episodes.Split(',').Select(e => new RequestEpisode(int.Parse(e.Split('x')[0]), int.Parse(e.Split('x')[1]))).ToArray());
        var result = await lab.Direct.SendAsync(lab.Job(input, "Sonarr"), Pass, default);
        Assert.True(result.Confirmed, result.Outcome.Message);
        Assert.Equal("accepted", result.Outcome.Outcome);
        var add = Body(lab.Sonarr, "POST", "/api/v3/series");
        Assert.Equal(flags, string.Join(" ", add["seasons"]!.AsArray().Select(s => $"{(int)s!["seasonNumber"]!}:{((bool)s["monitored"]! ? 1 : 0)}")));
        Assert.Equal(newItems, (string)add["monitorNewItems"]!);
        Assert.Equal("skip", (string)add["addOptions"]!["monitor"]!);
        Assert.Equal(sonarrSearches, (bool)add["addOptions"]!["searchForMissingEpisodes"]!);
        Assert.True((bool)add["monitored"]!);
        Assert.Equal(("/data/tv", 4, "standard"), ((string)add["rootFolderPath"]!, (int)add["qualityProfileId"]!, (string)add["seriesType"]!));
        if (scope == "episodes")
        {
            Assert.Equal(new[] { EpisodeId(lab, 1, 2) }, Ids(Body(lab.Sonarr, "PUT", "/api/v3/episode/monitor")["episodeIds"]));
            Assert.Contains(lab.Sonarr.Writes, w => w.Path == "/api/v3/command" && w.Body.Contains("EpisodeSearch", StringComparison.Ordinal));
            Assert.Equal("S1E2", Monitored(lab));
        }
        else
        {
            Assert.Single(lab.Sonarr.Writes);   // Sonarr searches the monitored seasons itself after the add
        }
    }

    [Fact]
    public async Task ASeasonTheArrDoesNotListYetWaitsAndIsCheckedAgainLaterAfterARefreshNeverHeld()
    {
        using var lab = new Lab();
        ExistingSeries(lab);
        var result = await lab.Direct.SendAsync(lab.Job(Series("next_season", new[] { 5 }), "Sonarr"), Pass, default);
        Assert.False(result.Parked);
        Assert.True(result.Retryable && result.Outcome.Certainty != ArrActionStatus.Unknown);
        Assert.Equal(("not_aired", DirectArrBackend.NotListedWait), (result.Outcome.Reason, result.RetryAfter!.Value));
        // The series the arr has is refreshed so the next check sees a newly added season; nothing else is written.
        var refresh = Assert.Single(lab.Sonarr.Writes);
        Assert.Equal("/api/v3/command", refresh.Path);
        Assert.Contains("RefreshSeries", refresh.Body, StringComparison.Ordinal);
        lab.Sonarr.Writes.Clear();
        // A series the arr doesn't have yet: nothing to refresh, nothing written.
        lab.Sonarr.Lookup.Add(Lab.SeriesLookup(80000, "Other", 1));
        var episodes = await lab.Direct.SendAsync(lab.Job(Series("episodes", episodes: new[] { new RequestEpisode(2, 1) }, tvdb: 80000), "Sonarr"), Pass, default);
        Assert.Equal(("not_aired", false, true), (episodes.Outcome.Reason, episodes.Parked, episodes.Retryable));
        Assert.Empty(lab.Sonarr.Writes);
        // The guard refuses: not even the refresh goes out.
        var refused = await lab.Direct.SendAsync(lab.Job(Series("next_season", new[] { 5 }), "Sonarr"), () => "request_changed", default);
        Assert.Empty(lab.Sonarr.Writes);
        Assert.True(refused.Parked);
    }

    // ------------------------------------------------------------------ add defaults

    [Fact]
    public async Task MissingOrUnknownDefaultsAreRefusedBeforeAnyWrite()
    {
        using var lab = new Lab(defaults: false);
        lab.Radarr.Lookup.Add(Lab.MovieLookup(961));
        var none = await lab.Direct.SendAsync(lab.Job(Movie(), "Radarr"), Pass, default);
        Assert.True(none.Parked);
        Assert.Equal("invalid_defaults", none.Outcome.Reason);
        lab.Edit("Radarr", row => row["Defaults"] = Lab.Defaults(42, "/data/movies"));
        var profile = await lab.Direct.SendAsync(lab.Job(Movie(), "Radarr"), Pass, default);
        Assert.Equal("invalid_defaults", profile.Outcome.Reason);
        Assert.Contains("quality profile", profile.Outcome.Message, StringComparison.Ordinal);
        lab.Edit("Radarr", row => row["Defaults"] = Lab.Defaults(4, "/somewhere/else"));
        var folder = await lab.Direct.SendAsync(lab.Job(Movie(), "Radarr"), Pass, default);
        Assert.Equal("invalid_defaults", folder.Outcome.Reason);
        lab.Edit("Radarr", row => row["Defaults"] = Lab.Defaults(4, "/data/movies", 7));
        var tag = await lab.Direct.SendAsync(lab.Job(Movie(), "Radarr"), Pass, default);
        Assert.Equal("invalid_defaults", tag.Outcome.Reason);
        Assert.Empty(lab.Radarr.Writes);
        // With the tag present the same defaults pass, and the tag goes with the add.
        lab.Radarr.Tags.Remove(90);
        lab.Radarr.Tags[7] = "je-requested";   // the default tag is the attribution tag itself: listed once
        var ok = await lab.Direct.SendAsync(lab.Job(Movie(), "Radarr"), Pass, default);
        Assert.True(ok.Confirmed, ok.Outcome.Message);
        Assert.Equal(new[] { 7 }, Ids(Body(lab.Radarr, "POST", "/api/v3/movie")["tags"]));
    }

    [Fact]
    public async Task AStaleOrFailedSystemSnapshotRefusesTheDefaultsAndWritesNothing()
    {
        using (var coldLab = new Lab())
        {
            // Never loaded and the read fails: no snapshot.
            coldLab.Radarr.Lookup.Add(Lab.MovieLookup(961));
            coldLab.Radarr.Before = (path, _) => path == "/api/v3/qualityprofile" ? throw new HttpRequestException(HttpRequestError.ConnectionError, "refused") : Task.CompletedTask;
            var cold = await coldLab.Direct.SendAsync(coldLab.Job(Movie(), "Radarr"), Pass, default);
            Assert.True(cold.Retryable);
            Assert.True(cold.VerifiedNotSent);
            Assert.Equal("backend_unavailable", cold.Outcome.Reason);
            Assert.Empty(coldLab.Radarr.Writes);
        }
        using var lab = new Lab();
        lab.Radarr.Lookup.Add(Lab.MovieLookup(961));
        // Loaded once, then older than its freshness target with the refresh failing: stale.
        Assert.NotNull((await lab.Store.GetSystemAsync(lab.Instance("Radarr"), default)).Value);
        lab.Radarr.Before = (path, _) => path == "/api/v3/qualityprofile" ? throw new HttpRequestException(HttpRequestError.ConnectionError, "refused") : Task.CompletedTask;
        lab.Arr.Now = lab.Arr.Now.AddMinutes(20);
        var stale = await lab.Direct.SendAsync(lab.Job(Movie(), "Radarr"), Pass, default);
        Assert.Equal("backend_unavailable", stale.Outcome.Reason);
        Assert.Empty(lab.Radarr.Writes);
        var check = ArrAddRules.Check(lab.Instance("Radarr"), await lab.Store.GetSystemAsync(lab.Instance("Radarr"), default), null);
        Assert.Equal("defaults_unverified", check.Reason);
    }

    // ------------------------------------------------------------------ maybe sent, guard, generation

    [Fact]
    public async Task ALostAnswerIsMaybeSentAndAFreshReadSettlesIt()
    {
        using var lab = new Lab();
        lab.Radarr.Lookup.Add(Lab.MovieLookup(961));
        lab.Radarr.AfterWrite = (method, path) =>
        {
            if (path == "/api/v3/movie") throw new HttpRequestException(HttpRequestError.ResponseEnded, "dropped");
        };
        var job = lab.Job(Movie(), "Radarr");
        var sent = await lab.Direct.SendAsync(job, Pass, default);
        Assert.Equal(ArrActionStatus.Unknown, sent.Outcome.Certainty);
        Assert.False(sent.Confirmed);
        // The movie is there, but whether its search started can't be read back: the request resumes (it can't be
        // cancelled or refunded meanwhile), and the resumed send adds nothing again; it searches, then confirms.
        var back = await lab.Direct.ReadBackAsync(job, default);
        Assert.True(back.Resumes);
        Assert.False(back.VerifiedNotSent);
        Assert.Equal(ArrActionStatus.Unknown, back.Outcome.Certainty);
        var resumed = await lab.Direct.SendAsync(job with { Uncertain = true }, Pass, default);
        Assert.True(resumed.Confirmed, resumed.Outcome.Message);
        Assert.Single(lab.Radarr.Writes, w => w.Path == "/api/v3/movie");
        Assert.Single(lab.Radarr.Writes, w => w.Path == "/api/v3/command" && w.Body.Contains("MoviesSearch", StringComparison.Ordinal));
        // A movie that never landed reads back as verified not sent, so sending again is safe.
        var other = lab.Job(Movie(962), "Radarr");
        var notThere = await lab.Direct.ReadBackAsync(other, default);
        Assert.True(notThere.VerifiedNotSent);
        Assert.True(notThere.Retryable);
        Assert.False(notThere.Confirmed);
    }

    [Fact]
    public async Task TheGuardRunsBeforeAnyCallAndAgainBeforeTheFirstWrite()
    {
        using var lab = new Lab();
        lab.Radarr.Lookup.Add(Lab.MovieLookup(961));
        var calls = lab.Arr.Calls.Count;
        var refused = await lab.Direct.SendAsync(lab.Job(Movie(), "Radarr"), () => "authorization_changed", default);
        Assert.True(refused.Parked);
        Assert.Equal(calls, lab.Arr.Calls.Count);
        var checks = 0;
        var late = await lab.Direct.SendAsync(lab.Job(Movie(), "Radarr"), () => ++checks == 2 ? "identity_changed" : null, default);
        Assert.Equal("identity_changed", late.Outcome.Reason);
        Assert.Equal(2, checks);
        Assert.Empty(lab.Radarr.Writes);
    }

    [Fact]
    public async Task AChangedConnectionGenerationParksTheJobAndReadBackNeverUsesTheNewConnection()
    {
        using var lab = new Lab();
        lab.Radarr.Lookup.Add(Lab.MovieLookup(961));
        var job = lab.Job(Movie(), "Radarr");
        lab.Edit("Radarr", row => row["Url"] = "http://radarr.test:7879");
        var calls = lab.Arr.Calls.Count;
        var result = await lab.Direct.SendAsync(job, Pass, default);
        Assert.True(result.Parked);
        Assert.Equal("instance_changed", result.Outcome.Reason);
        var back = await lab.Direct.ReadBackAsync(job, default);
        Assert.Equal(ArrActionStatus.Unknown, back.Outcome.Certainty);
        Assert.Equal("instance_changed", back.Outcome.Reason);
        Assert.Equal(calls, lab.Arr.Calls.Count);
        Assert.Empty(lab.Radarr.Writes);
    }

    // ------------------------------------------------------------------ through the ledger and the outbox

    private static (IntegrationRequestLedgerTests.Rig Rig, Lab Lab) Ledger(Lab lab)
    {
        var r = new IntegrationRequestLedgerTests.Rig();
        // The rig's people now point at the lab's instances and their real connection generations.
        r.Policy.Adjust = (user, input, facts) =>
        {
            var key = TitleKey.Parse(input.Key)!;
            var name = key.IsMovie ? input.Variant == "4k" ? "Radarr 4K" : "Radarr" : "Sonarr";
            var instance = lab.Instance(name);
            return facts with { InstanceId = instance.Id, ConnectionGeneration = lab.Arr.Factory.ConnectionGeneration(instance.Id) ?? string.Empty };
        };
        return (r, lab);
    }

    [Fact]
    public async Task OutboxSendsThroughTheExecutorAndATimeoutMidPostIsReconciledWithoutASecondAdd()
    {
        using var lab = new Lab();
        var (r, _) = Ledger(lab);
        using var rig = r;
        lab.Radarr.Lookup.Add(Lab.MovieLookup(961));
        lab.Radarr.Lookup.Add(Lab.MovieLookup(962, "Sherlock Jr."));
        var dropped = 0;
        lab.Radarr.AfterWrite = (_, path) =>
        {
            if (path == "/api/v3/movie" && dropped++ == 0) throw new HttpRequestException(HttpRequestError.ResponseEnded, "dropped");
        };
        var ask = await rig.Create(rig.Admin, Movie(961));
        Assert.Equal("queued_outage", ask.Reason);
        await rig.Runner(lab.Direct).TickAsync(default);
        // The add landed but its answer was lost: the read-back finds it, and the search is sent on the next pass.
        var resuming = rig.Ledger.ForWant(ask.RequestId!).Single();
        Assert.Equal(("retry", true), (resuming.State, resuming.Uncertain));
        rig.Now = rig.Now.AddMinutes(1);
        await rig.Runner(lab.Direct).TickAsync(default);
        var want = rig.Ledger.Find(ask.RequestId!)!;
        Assert.Equal(("sent", "looking"), (want.Status, want.Reason));
        Assert.Single(lab.Radarr.Writes, w => w.Path == "/api/v3/movie");
        Assert.Single(lab.Radarr.Writes, w => w.Path == "/api/v3/command");
        Assert.Single(rig.Ledger.ForWant(want.Id), j => j.State == "succeeded");

        // An add that never landed: the answer is lost, the read-back proves nothing is there, the job retries.
        lab.Radarr.OnWrite = (method, path, _) => method == "POST" && path == "/api/v3/movie" && lab.Radarr.Movies.All(m => (int)m["tmdbId"]! != 962) && lab.Radarr.Writes.Count(w => w.Path == path) == 2
            ? throw new HttpRequestException(HttpRequestError.ResponseEnded, "dropped before Radarr stored it")
            : null;
        var second = await rig.Create(rig.Admin, Movie(962));
        await rig.Runner(lab.Direct).TickAsync(default);
        var job = rig.Ledger.ForWant(second.RequestId!).Single();
        Assert.Equal("retry", job.State);
        Assert.Equal(2, lab.Radarr.Writes.Count(w => w.Path == "/api/v3/movie"));
        rig.Now = rig.Now.AddMinutes(10);
        await rig.Runner(lab.Direct).TickAsync(default);
        Assert.Equal("succeeded", rig.Ledger.ForWant(second.RequestId!).Single().State);
        Assert.Equal(3, lab.Radarr.Writes.Count(w => w.Path == "/api/v3/movie"));
        Assert.Equal(2, lab.Radarr.Movies.Count);
    }

    [Fact]
    public async Task KeepGettingNewEpisodesChargesItsOwnerOnceForEachNewSeasonSonarrStarts()
    {
        using var lab = new Lab();
        var (r, _) = Ledger(lab);
        using var rig = r;
        lab.Sonarr.Lookup.Add(Lab.SeriesLookup(75565));
        lab.Sonarr.EpisodeList[75565] = new[] { (4, 1), (4, 2) };
        // A member asks to keep getting new episodes from season 4 (1 now); Jellyfin Enhanced sends it to Sonarr.
        var ask = await rig.Create(rig.Member, Series("future", new[] { 4 }));
        Assert.Equal("queued_outage", ask.Reason);
        await rig.Runner(lab.Direct).TickAsync(default);
        Assert.Equal("sent", rig.Ledger.Find(ask.RequestId!)!.Status);
        var series = lab.Sonarr.Series.Single();
        Assert.Equal("all", (string)series["monitorNewItems"]!);
        // Someone else asking for the same follows for free.
        var follower = rig.Add("Member");
        Assert.Equal("merged", (await rig.Create(follower, Series("future", new[] { 4 }))).Outcome);
        int Used(Guid who) => rig.Service.Quota(who).Used;
        Assert.Equal((1, 0), (Used(rig.Member), Used(follower)));

        // The charger follows the store's library reads (what the reconciler's refreshes and live patches raise).
        var charges = new FutureSeasonCharges(lab.Store, rig.Ledger, rig.Policy, lab.Arr.Factory, rig.Feed, null, null, () => rig.Now);
        var started = new List<Task>();
        charges.Started = started.Add;
        charges.Subscribe();
        async Task Read()
        {
            started.Clear();
            Assert.True((await lab.Store.RefreshLibraryNowAsync(lab.Instance("Sonarr"), default)).Ok);
            Assert.NotEmpty(started);
            await Task.WhenAll(started.ToArray());
        }
        JsonObject Season(int number, int aired) => new() { ["seasonNumber"] = number, ["monitored"] = true, ["statistics"] = new JsonObject { ["episodeCount"] = aired, ["episodeFileCount"] = 0, ["totalEpisodeCount"] = 8 } };
        await Read();
        Assert.Equal(1, Used(rig.Member));

        // Sonarr picks season 5 up (monitorNewItems): announced only, nothing yet; once it starts, 1 for its owner, once.
        series["seasons"]!.AsArray().Add(Season(5, 0));
        await Read();
        Assert.Equal(1, Used(rig.Member));
        series["seasons"]!.AsArray()[^1] = Season(5, 1);
        await Read();
        await Read();
        Assert.Equal((2, 0), (Used(rig.Member), Used(follower)));
        Assert.Contains(rig.Ledger.ForTitle("tv:tvdb:75565"), w => w.Id == ask.RequestId && w.Status == "sent");

        // A season someone else asked for themselves is theirs to pay for (here a request Seerr was already fetching
        // when it moved), not the Keep-getting owner's.
        var target = rig.Ledger.Find(ask.RequestId!)!.TargetKey;
        Assert.Equal(1, rig.Ledger.ImportSeerr("src", "digest", new[] { new ImportCandidate(follower, 7, Series("seasons", new[] { 6 }), false, rig.Now.AddDays(-1)) },
            new Dictionary<string, int>(), rig.Admin, "seerr", _ => target, rig.Now, TimeSpan.FromDays(14)).Imported);
        series["seasons"]!.AsArray().Add(Season(6, 2));
        await Read();
        Assert.Equal(2, Used(rig.Member));

        // Switched off: nothing more is charged.
        rig.Policy.Configuration.ArrRequestChargeFutureSeasons = false;
        series["seasons"]!.AsArray().Add(Season(7, 1));
        started.Clear();
        Assert.True((await lab.Store.RefreshLibraryNowAsync(lab.Instance("Sonarr"), default)).Ok);
        await Task.WhenAll(started.ToArray());
        Assert.Equal(2, Used(rig.Member));
        rig.Policy.Configuration.ArrRequestChargeFutureSeasons = true;
        // A new connection (address or key changed) isn't where the request went: nothing is charged there.
        lab.Edit("Sonarr", row => row["Url"] = "http://sonarr.test:8989");
        Assert.Equal(0, charges.Charge(lab.Instance("Sonarr"), lab.Store.PeekLibrary(lab.Instance("Sonarr").Id)!));
        Assert.Equal(2, Used(rig.Member));
    }

    [Fact]
    public async Task AJobLeftSendingByARestartIsReadBackFirstAndNotSentAgain()
    {
        using var lab = new Lab();
        var (r, _) = Ledger(lab);
        using var rig = r;
        lab.Radarr.Lookup.Add(Lab.MovieLookup(961));
        var ask = await rig.Create(rig.Admin, Movie(961));
        var job = rig.Ledger.Due(rig.Now).Single();
        Assert.True(rig.Ledger.Claim(job, rig.Db.Generation, rig.Now));
        // The process died after Radarr stored the movie but before the outcome was written.
        lab.Radarr.Movies.Add(new JsonObject { ["id"] = 70, ["tmdbId"] = 961, ["title"] = "The General", ["monitored"] = true, ["hasFile"] = false });
        rig.Ledger.Recover(rig.Now);
        Assert.Equal("maybe_sent", rig.Ledger.ForWant(ask.RequestId!).Single().State);
        await rig.Runner(lab.Direct).TickAsync(default);
        // Read first, nothing written: the movie is there, but whether its search started can't be read back.
        var resuming = rig.Ledger.ForWant(ask.RequestId!).Single();
        Assert.Equal(("retry", true), (resuming.State, resuming.Uncertain));
        Assert.Empty(lab.Radarr.Writes);
        Assert.Equal("request_in_flight", rig.Service.Close(ask.RequestId!, rig.Admin, null).Reason);
        // The resumed send never adds it again; it only searches.
        rig.Now = rig.Now.AddMinutes(1);
        await rig.Runner(lab.Direct).TickAsync(default);
        Assert.Equal("succeeded", rig.Ledger.ForWant(ask.RequestId!).Single().State);
        Assert.Equal("POST /api/v3/command", string.Join("|", lab.Radarr.Writes.Select(w => w.Method + " " + w.Path)));
    }

    [Fact]
    public async Task AConnectionGenerationChangeAfterApprovalParksTheQueuedJob()
    {
        using var lab = new Lab();
        var (r, _) = Ledger(lab);
        using var rig = r;
        lab.Radarr.Lookup.Add(Lab.MovieLookup(961));
        var ask = await rig.Create(rig.Kid, Movie(961));
        Assert.Equal("awaiting_approval", ask.Reason);
        Assert.Equal(200, (await rig.Service.ApproveAsync(ask.RequestId!, rig.Admin, null, default)).HttpStatus);
        lab.Edit("Radarr", row => row["Url"] = "http://radarr.test:7879");
        await rig.Runner(lab.Direct).TickAsync(default);
        var job = rig.Ledger.ForWant(ask.RequestId!).Single();
        Assert.Equal(("parked", "instance_changed"), (job.State, job.Reason));
        Assert.Equal("pending", rig.Ledger.Find(ask.RequestId!)!.Status);
        Assert.Empty(lab.Radarr.Writes);
    }


    // ------------------------------------------------------------------ review round 1 (executor)

    [Theory]
    [InlineData("/api/v3/series", "POST /api/v3/series")]
    [InlineData("/api/v3/episode/monitor", "POST /api/v3/series|PUT /api/v3/episode/monitor")]
    public async Task AuthorityLostAfterAWriteStopsEveryLaterWriteAndSearch(string revokedAfter, string writes)
    {
        using var lab = new Lab();
        lab.Sonarr.Lookup.Add(Lab.SeriesLookup(75565));
        lab.Sonarr.EpisodeList[75565] = new[] { (1, 1), (1, 2), (1, 3) };
        // Cancelled, demoted or shut out while the new series' episode list fills in (or right after the monitoring).
        string? Guard() => lab.Sonarr.Writes.Any(w => w.Path == revokedAfter) ? "authorization_changed" : null;
        var result = await lab.Direct.SendAsync(lab.Job(Series("episodes", episodes: new[] { new RequestEpisode(1, 2), new RequestEpisode(1, 3) }), "Sonarr"), Guard, default);
        Assert.True(result.Parked);
        Assert.Equal(("authorization_changed", ArrActionStatus.Unknown), (result.Outcome.Reason, result.Outcome.Certainty));
        Assert.False(result.VerifiedNotSent);
        Assert.Equal(writes, string.Join("|", lab.Sonarr.Writes.Select(w => w.Method + " " + w.Path)));
    }

    [Fact]
    public async Task APartlyAppliedChangeReadsBackAsUnfinishedNeverAsNotSent()
    {
        using var lab = new Lab();
        var (r, _) = Ledger(lab);
        using var rig = r;
        ExistingSeries(lab);
        // The season flag lands, the episode monitoring fails.
        lab.Sonarr.OnWrite = (_, path, _) => path == "/api/v3/episode/monitor" ? IntegrationTransport.Response("{\"message\":\"boom\"}", 500) : null;
        var ask = await rig.Create(rig.Admin, Series("seasons", new[] { 2 }));
        await rig.Runner(lab.Direct).TickAsync(default);
        Assert.Equal("0:0 1:1 2:1 3:0 4:0", SeasonFlags(lab));
        var job = rig.Ledger.ForWant(ask.RequestId!).Single();
        Assert.Equal(("retry", true), (job.State, job.Uncertain));
        // Part of it is in Sonarr: it can't be cancelled or refunded as if nothing had been sent.
        Assert.Equal("request_in_flight", rig.Service.Close(ask.RequestId!, rig.Admin, null).Reason);
        // The next attempt finishes the missing part and searches.
        lab.Sonarr.OnWrite = null;
        rig.Now = rig.Now.AddMinutes(1);
        await rig.Runner(lab.Direct).TickAsync(default);
        Assert.Equal("succeeded", rig.Ledger.ForWant(ask.RequestId!).Single().State);
        Assert.Equal("S1E1 S1E2 S1E3 S2E1 S2E2 S2E3 S3E1", Monitored(lab));
        Assert.Contains(lab.Sonarr.Writes, w => w.Path == "/api/v3/command" && w.Body.Contains("SeasonSearch", StringComparison.Ordinal));

        // A new series whose asked episode isn't listed in time: the add is there, so it resumes, never "not sent".
        lab.Sonarr.Lookup.Add(Lab.SeriesLookup(80000, "Other", 1));
        lab.Sonarr.EpisodeList[80000] = new[] { (1, 1) };
        var slow = lab.Job(Series("episodes", episodes: new[] { new RequestEpisode(1, 2) }, tvdb: 80000), "Sonarr");
        var sent = await lab.Direct.SendAsync(slow, Pass, default);
        Assert.True(sent.Resumes);
        var back = await lab.Direct.ReadBackAsync(slow, default);
        Assert.True(back.Resumes);
        Assert.False(back.VerifiedNotSent);
        // Still not listed on the resumed attempt: held for a person (never an endless loop), certainty still unknown.
        var still = await lab.Direct.SendAsync(slow with { Uncertain = true }, Pass, default);
        Assert.True(still.Parked);
        Assert.Equal(("not_aired", ArrActionStatus.Unknown), (still.Outcome.Reason, still.Outcome.Certainty));
    }

    [Fact]
    public async Task TheSearchIsPartOfTheRequestALostOrFailedSearchIsSentAgainNotReportedDone()
    {
        using var lab = new Lab();
        ExistingSeries(lab);
        // The episode monitoring is applied but its answer is lost: the run stops before the search.
        lab.Sonarr.AfterWrite = (_, path) =>
        {
            if (path == "/api/v3/episode/monitor") throw new HttpRequestException(HttpRequestError.ResponseEnded, "dropped");
        };
        var job = lab.Job(Series("seasons", new[] { 2 }), "Sonarr");
        var sent = await lab.Direct.SendAsync(job, Pass, default);
        Assert.Equal(ArrActionStatus.Unknown, sent.Outcome.Certainty);
        Assert.DoesNotContain(lab.Sonarr.Writes, w => w.Path == "/api/v3/command");
        // Everything asked for reads back, but no search went out: not done.
        var back = await lab.Direct.ReadBackAsync(job, default);
        Assert.False(back.Confirmed);
        Assert.True(back.Resumes);
        // A search the arr refuses isn't done either.
        lab.Sonarr.AfterWrite = null;
        lab.Sonarr.CommandFailWith = 500;
        var refused = await lab.Direct.SendAsync(job with { Uncertain = true }, Pass, default);
        Assert.False(refused.Confirmed);
        Assert.True(refused.Resumes);
        lab.Sonarr.CommandFailWith = 0;
        var done = await lab.Direct.SendAsync(job with { Uncertain = true }, Pass, default);
        Assert.True(done.Confirmed, done.Outcome.Message);
        Assert.Contains(lab.Sonarr.Writes, w => w.Path == "/api/v3/command" && w.Body.Contains("SeasonSearch", StringComparison.Ordinal) && w.Body.Contains("\"seasonNumber\":2", StringComparison.Ordinal));
    }

    [Fact]
    public async Task AMergeNeedsNoAddDefaultsOrSystemSnapshot()
    {
        using var lab = new Lab(defaults: false);
        ExistingSeries(lab);
        lab.Radarr.Movies.Add(new JsonObject { ["id"] = 70, ["tmdbId"] = 961, ["title"] = "The General", ["monitored"] = false, ["hasFile"] = false });
        foreach (var host in new[] { lab.Radarr, lab.Sonarr })
            host.Before = (path, _) => path == "/api/v3/qualityprofile" ? throw new HttpRequestException(HttpRequestError.ConnectionError, "refused") : Task.CompletedTask;
        var series = await lab.Direct.SendAsync(lab.Job(Series("seasons", new[] { 2 }), "Sonarr"), Pass, default);
        Assert.True(series.Confirmed, series.Outcome.Message);
        var movie = await lab.Direct.SendAsync(lab.Job(Movie(961), "Radarr"), Pass, default);
        Assert.True(movie.Confirmed, movie.Outcome.Message);
        Assert.Equal("merged", movie.Outcome.Outcome);
    }

    // ------------------------------------------------------------------ routing in the production policy

    [Fact]
    public void ThePolicyRoutesEachEditionToItsRoleDefaultAndNeverPicksAnotherRole()
    {
        using var lab = new Lab();
        lab.Arr.Add("anime.test", "Radarr");
        var rows = JsonNode.Parse(lab.Config.RadarrInstances)!.AsArray();
        rows.Insert(0, new JsonObject { ["Id"] = "00000000-0000-0000-0000-000000000001", ["Name"] = "Other", ["Url"] = "http://anime.test", ["ApiKey"] = "k", ["Enabled"] = true, ["Role"] = "custom" });
        lab.Config.RadarrInstances = rows.ToJsonString();
        var view = new FakeJellyfinView();
        var admin = view.AddUser(true);
        var aliases = new TitleAliases(lab.Store, null);
        var policy = new RequestPolicy(view, lab.Store, new ArrInstanceLibraries(lab.Store, new FakeLibraryAccess()), aliases, null!, lab.Arr.Factory, new UnavailableRequestBackend());
        Assert.Equal(lab.Instance("Radarr").Id, policy.Evaluate(admin.UserId, Movie()).InstanceId);
        lab.Config.ArrRequest4kMoviesEnabled = true;
        var fourK = policy.Evaluate(admin.UserId, Movie(variant: "4k"));
        Assert.Equal(lab.Instance("Radarr 4K").Id, fourK.InstanceId);
        Assert.True(fourK.Can4k);
        Assert.True(policy.Has4kTarget(true));
        // Without a 4K instance, 4K has no target at all (it never falls back to the standard instance).
        lab.Edit("Radarr 4K", row => row["Enabled"] = false);
        var none = policy.Evaluate(admin.UserId, Movie(variant: "4k"));
        Assert.Equal(string.Empty, none.InstanceId);
        Assert.False(none.Can4k);
        Assert.False(policy.Has4kTarget(true));
        // Seerr mode: Seerr picks its own server, so a request isn't tied to an arr's connection.
        Assert.NotEqual(string.Empty, policy.Evaluate(admin.UserId, Movie()).ConnectionGeneration);
        var jeMode = policy.Evaluate(admin.UserId, Movie());
        lab.Config.ArrRequestBackend = "seerr";
        var seerr = policy.Evaluate(admin.UserId, Movie());
        Assert.Equal((string.Empty, string.Empty), (seerr.InstanceId, seerr.ConnectionGeneration));
        // ...but the target a JE-mode request would go to is still known (a move from Seerr links its requests there).
        Assert.Equal((jeMode.InstanceId, jeMode.ConnectionGeneration), policy.JeTarget(admin.UserId, Movie()));
        Assert.Equal(lab.Instance("Radarr").Id, ((IRequestPolicy)policy).JeTarget(admin.UserId, Movie()).InstanceId);
    }

    [Fact]
    public void TheAllowanceIsEachPersonsOwnLimitAndManagersAndAdminsHaveNone()
    {
        using var lab = new Lab();
        var view = new FakeJellyfinView();
        var admin = view.AddUser(true);
        var member = view.AddUser(false);
        var other = view.AddUser(false);
        var manager = view.AddUser(false);
        lab.Config.ArrRequestDefaultRole = "Member";
        lab.Config.ArrRequestQuotaLimit = 7;
        lab.Config.ArrRequestRoles = "{\"Member\":{\"QuotaLimit\":5},\"Manager\":{\"QuotaLimit\":4}}";
        lab.Config.ArrRequestUsers = JsonSerializer.Serialize(new Dictionary<string, object>
        {
            [member.UserId.ToString("N")] = new { QuotaLimit = 3 },
            [manager.UserId.ToString("N")] = new { Role = "Manager", QuotaLimit = 2 },
            [admin.UserId.ToString("N")] = new { QuotaLimit = 2 },
        });
        var policy = new RequestPolicy(view, lab.Store, new ArrInstanceLibraries(lab.Store, new FakeLibraryAccess()), new TitleAliases(lab.Store, null), null!, lab.Arr.Factory, new UnavailableRequestBackend());
        using var rig = new IntegrationRequestLedgerTests.Rig();
        var service = new RequestService(rig.Ledger, policy, view, rig.Feed, () => rig.Now);
        // What the allowance (and so the collection picker's and the request sheet's cost lines) says: the person's own
        // limit (their override, else their role's, else the household's), and none for a Manager or an Admin, whose
        // asks never wait for an OK because of it.
        Assert.Equal((int?)3, service.Quota(member.UserId).Limit);
        Assert.Equal((int?)5, service.Quota(other.UserId).Limit);
        Assert.Equal(((int?)null, (int?)null), (service.Quota(manager.UserId).Limit, service.Quota(manager.UserId).Remaining));
        Assert.Equal(((int?)null, (int?)null), (service.Quota(admin.UserId).Limit, service.Quota(admin.UserId).Remaining));
        lab.Config.ArrRequestRoles = "{}";
        Assert.Equal((int?)7, service.Quota(other.UserId).Limit);
    }

    // ------------------------------------------------------------------ Seerr

    internal sealed class SeerrLab : IDisposable
    {
        public FakeSeerr Seerr { get; } = new();
        public Lab Arr { get; } = new();
        public SeerrRequestReadModel Model { get; }
        public SeerrBackend Backend { get; }
        public Guid User { get; } = Guid.NewGuid();
        public PluginConfiguration Config => Arr.Config;
        public DateTimeOffset Now { get; set; } = new(2026, 10, 14, 12, 0, 0, TimeSpan.Zero);

        public SeerrLab(long permissions = 32)
        {
            Config.ArrRequestBackend = "seerr";
            Config.JellyseerrEnabled = true;
            Config.JellyseerrUrls = FakeSeerr.Url;
            Config.JellyseerrApiKey = FakeSeerr.Key;
            Seerr.Users.Add(new JsonObject { ["id"] = 7, ["jellyfinUserId"] = User.ToString("N"), ["permissions"] = permissions, ["displayName"] = "Emma" });
            Seerr.Users.Add(new JsonObject { ["id"] = 8, ["jellyfinUserId"] = Guid.NewGuid().ToString("N"), ["permissions"] = 32, ["displayName"] = "Sam" });
            Model = new SeerrRequestReadModel(Seerr.Transport, null, null, () => Config, () => Now);
            Backend = new SeerrBackend(Seerr.Transport, Model, null, () => Config, () => Now);
        }

        public string Source => Model.SourceOf(Config)!;

        public RequestJob Job(MutationInput input, int? user = 7)
        {
            var job = Arr.Job(input, "Radarr", seerrUser: user, backend: "seerr", source: Source);
            // Asked by the person Seerr account 7 is linked to.
            return job with { Authorization = job.Authorization with { Requester = User } };
        }

        public void Dispose()
        {
            Model.Dispose();
            Seerr.Dispose();
            Arr.Dispose();
        }
    }

    private static MutationInput Show(params int[] seasons) => new() { Key = "tv:tmdb:1731", Scope = "seasons", Seasons = seasons };

    private static void SeerrShow(FakeSeerr seerr, int tmdb = 1731, int seasons = 2, params (int Id, int User, int Status, int[] Seasons)[] requests)
        => seerr.Shows[tmdb] = new JsonObject
        {
            ["id"] = tmdb,
            ["seasons"] = new JsonArray(Enumerable.Range(0, seasons + 1).Select(s => (JsonNode)new JsonObject { ["seasonNumber"] = s }).ToArray()),
            ["mediaInfo"] = new JsonObject
            {
                ["status"] = 2, ["status4k"] = 1, ["seasons"] = new JsonArray(),
                ["requests"] = new JsonArray(requests.Select(r => (JsonNode)new JsonObject
                {
                    ["id"] = r.Id, ["status"] = r.Status, ["is4k"] = false, ["type"] = "tv", ["requestedBy"] = new JsonObject { ["id"] = r.User },
                    ["seasons"] = new JsonArray(r.Seasons.Select(n => (JsonNode)new JsonObject { ["seasonNumber"] = n }).ToArray()),
                }).ToArray()),
            },
        };

    [Fact]
    public async Task SeerrRequestsAreSentAsThePersonWithIs4kExplicitAndConfirmedByTheirOwnRequest()
    {
        using var lab = new SeerrLab();
        await lab.Backend.PrepareAsync(lab.User, Movie(), default);
        var binding = lab.Backend.Binding(lab.User, Movie());
        Assert.Equal((lab.Source, 7, true, false, false), (binding.Source, binding.UserId, binding.CanRequest, binding.Can4k, binding.CanManage));
        Assert.True(binding.Quota!.Available);
        var result = await lab.Backend.SendAsync(lab.Job(Movie(22596)), Pass, default);
        Assert.True(result.Confirmed, result.Outcome.Message);
        Assert.Equal(("accepted", "awaiting_approval", 201), (result.Outcome.Outcome, result.Outcome.Reason, result.Outcome.HttpStatus));
        var (host, user, body) = Assert.Single(lab.Seerr.Posts);
        Assert.Equal(("seerr.lan", "7"), (host, user));
        Assert.Equal("movie", (string)body["mediaType"]!);
        Assert.Equal(22596, (int)body["mediaId"]!);
        Assert.True(body.ContainsKey("is4k"));
        Assert.False((bool)body["is4k"]!);
    }

    [Fact]
    public async Task A409CountsOnlyWithAJsonBodyAndAMatchingFreshRead()
    {
        using var lab = new SeerrLab();
        // Sam asked first: Seerr answers Emma's request with its real duplicate answer.
        lab.Seerr.Movies[22596] = new JsonObject { ["id"] = 22596, ["mediaInfo"] = new JsonObject { ["status"] = 2, ["status4k"] = 1, ["requests"] = new JsonArray(new JsonObject { ["id"] = 5, ["status"] = 1, ["is4k"] = false, ["requestedBy"] = new JsonObject { ["id"] = 8 } }) } };
        var merged = await lab.Backend.SendAsync(lab.Job(Movie(22596)), Pass, default);
        Assert.True(merged.Confirmed);
        Assert.Equal("already_requested", merged.Outcome.Outcome);
        // A 409 that isn't Seerr's JSON, or one that no fresh read backs up, isn't success.
        lab.Seerr.OnPost = _ => IntegrationTransport.Response("<html>conflict</html>", 409, "text/html");
        var html = await lab.Backend.SendAsync(lab.Job(Movie(22596)), Pass, default);
        Assert.False(html.Confirmed);
        Assert.Equal("seerr_conflict", html.Outcome.Reason);
        lab.Seerr.OnPost = _ => IntegrationTransport.Response("{\"message\":\"Request for this media already exists.\"}", 409);
        var unbacked = await lab.Backend.SendAsync(lab.Job(Movie(603)), Pass, default);
        Assert.False(unbacked.Confirmed);
        Assert.Equal("seerr_conflict", unbacked.Outcome.Reason);
        Assert.True(unbacked.VerifiedNotSent);
    }

    [Fact]
    public async Task A202NoSeasonsCountsOnlyWhenAFreshReadShowsTheSeasonsRequested()
    {
        using var lab = new SeerrLab();
        SeerrShow(lab.Seerr, requests: (11, 8, 2, new[] { 1 }));
        var covered = await lab.Backend.SendAsync(lab.Job(Show(1)), Pass, default);
        Assert.True(covered.Confirmed, covered.Outcome.Message);
        Assert.Equal("nothing_to_request", covered.Outcome.Outcome);
        Assert.Equal("looking", covered.Outcome.Reason);
        lab.Seerr.OnPost = _ => IntegrationTransport.Response("{\"message\":\"No seasons available to request\"}", 202);
        var unbacked = await lab.Backend.SendAsync(lab.Job(Show(2)), Pass, default);
        Assert.False(unbacked.Confirmed);
        Assert.Equal("seerr_conflict", unbacked.Outcome.Reason);
    }

    [Fact]
    public async Task AMaybeSentPostIsNeverRepeatedAgainstAnotherSeerrAddressAndIsSettledByARead()
    {
        using var lab = new SeerrLab();
        lab.Config.JellyseerrUrls = FakeSeerr.Url + "\nhttp://seerr-backup.lan:5055";
        lab.Seerr.AfterPost = () => throw new HttpRequestException(HttpRequestError.ResponseEnded, "dropped");
        var job = lab.Job(Movie(22596));
        var sent = await lab.Backend.SendAsync(job, Pass, default);
        Assert.Equal(ArrActionStatus.Unknown, sent.Outcome.Certainty);
        Assert.Equal("seerr.lan", Assert.Single(lab.Seerr.Posts).Host);
        var back = await lab.Backend.ReadBackAsync(job, default);
        Assert.True(back.Confirmed);
        // Someone else's request is not ours: a maybe-sent job of Emma's reads back as not sent.
        lab.Seerr.AfterPost = null;
        lab.Seerr.Movies[603] = new JsonObject { ["id"] = 603, ["mediaInfo"] = new JsonObject { ["status"] = 2, ["requests"] = new JsonArray(new JsonObject { ["id"] = 6, ["status"] = 1, ["is4k"] = false, ["requestedBy"] = new JsonObject { ["id"] = 8 } }) } };
        var theirs = await lab.Backend.ReadBackAsync(lab.Job(Movie(603)), default);
        Assert.True(theirs.VerifiedNotSent);
        Assert.False(theirs.Confirmed);
        Assert.Single(lab.Seerr.Posts);
    }

    [Theory]
    [InlineData("true", "1", "1")]
    [InlineData("false", "1", "")]
    [InlineData("\"yes\"", "1", "")]
    [InlineData("missing", "1", "")]
    [InlineData("false", "1,2", "1,2")]
    [InlineData("missing", "0,1,2", "1,2")]
    [InlineData("true", "0,2", "2")]
    public async Task SeerrPartialRequestsAreThreeStateAndTheSentSeasonsStayInsideTheConfirmedScope(string partial, string asked, string sent)
    {
        using var lab = new SeerrLab();
        if (partial == "missing") lab.Seerr.Settings.Remove("partialRequestsEnabled");
        else lab.Seerr.Settings["partialRequestsEnabled"] = JsonNode.Parse(partial);
        lab.Seerr.Settings.Remove("enableSpecialEpisodes");
        SeerrShow(lab.Seerr);
        var askedSeasons = asked.Split(',').Select(int.Parse).ToArray();
        var result = await lab.Backend.SendAsync(lab.Job(Show(askedSeasons)), Pass, default);
        if (sent.Length == 0)
        {
            Assert.True(result.Parked);
            Assert.Equal("seerr_whole_series_only", result.Outcome.Reason);
            Assert.Empty(lab.Seerr.Posts);
            return;
        }
        Assert.True(result.Confirmed, result.Outcome.Message);
        var body = Assert.Single(lab.Seerr.Posts).Body;
        var seasons = body["seasons"]!.AsArray().Select(n => (int)n!).ToArray();
        Assert.Equal(sent.Split(',').Select(int.Parse).ToArray(), seasons);
        Assert.All(seasons, s => Assert.Contains(s, askedSeasons));
    }

    [Theory]
    [InlineData(32L, true, false, false)]
    [InlineData(32L | 2048L, true, true, false)]
    [InlineData(32L | 1024L, true, true, true)]
    [InlineData(2L, true, true, true)]
    [InlineData(32L | 2048L, false, false, false)]
    public async Task SeerrFourKCapabilityComesFromSeerrSettingsAndTheUsersOwnBits(long permissions, bool fourKSetUp, bool movie4k, bool series4k)
    {
        using var lab = new SeerrLab(permissions);
        lab.Seerr.Settings["movie4kEnabled"] = fourKSetUp;
        lab.Seerr.Settings["series4kEnabled"] = fourKSetUp;
        await lab.Backend.PrepareAsync(lab.User, Movie(), default);
        var movie = lab.Backend.Binding(lab.User, Movie());
        var series = lab.Backend.Binding(lab.User, Show(1));
        Assert.Equal(movie4k, movie.FourKEnabled && movie.Can4k);
        Assert.Equal(series4k, series.FourKEnabled && series.Can4k);
        var config = new PluginConfiguration { ArrIntegrationEnabled = true, ArrPhase1Enabled = true, ArrPhase3Enabled = true, ArrRequest4kMoviesEnabled = true, ArrRequest4kSeriesEnabled = true };
        Assert.Equal(movie4k, RequestPolicy.Can4k(config, true, "seerr", true, false, movie.FourKEnabled, movie.Can4k));
    }

    [Fact]
    public async Task SeerrQuotaAndRefusalsAreReadFromSeerrAndHeldWithTheirReason()
    {
        using var lab = new SeerrLab();
        lab.Seerr.Quotas[7] = new JsonObject { ["movie"] = new JsonObject { ["days"] = 7, ["limit"] = 3, ["used"] = 2, ["remaining"] = 1, ["restricted"] = false }, ["tv"] = new JsonObject { ["used"] = 4, ["restricted"] = false } };
        await lab.Backend.PrepareAsync(lab.User, Movie(), default);
        var movie = lab.Backend.Binding(lab.User, Movie()).Quota!;
        Assert.Equal((2, (int?)3, (int?)1, true), (movie.Used, movie.Limit, movie.Remaining, movie.Available));
        var tv = lab.Backend.Binding(lab.User, Show(1));
        Assert.Equal((4, (int?)null), (tv.Quota!.Used, tv.Quota.Limit));
        Assert.Equal(7, tv.QuotaWindowDays);
        lab.Seerr.OnPost = _ => IntegrationTransport.Response("{\"message\":\"Movie Quota exceeded.\"}", 403);
        var quota = await lab.Backend.SendAsync(lab.Job(Movie(22596)), Pass, default);
        Assert.Equal(("quota_exceeded", 429, true), (quota.Outcome.Reason, quota.Outcome.HttpStatus, quota.Parked));
        lab.Seerr.OnPost = _ => IntegrationTransport.Response("{\"message\":\"You do not have permission to make 4K movie requests.\"}", 403);
        var fourK = await lab.Backend.SendAsync(lab.Job(Movie(22596, "4k")), Pass, default);
        Assert.Equal("requests_4k_required", fourK.Outcome.Reason);
        Assert.True(fourK.VerifiedNotSent);
    }

    [Fact]
    public async Task SeerrsNextQuotaSlotIsWorkedOutEvenWhenTheRequestListDoesNotHoldExactlyWhatSeerrCounts()
    {
        using var lab = new SeerrLab();
        lab.Config.ArrIntegrationEnabled = true;
        lab.Config.ArrPhase1Enabled = true;
        var now = lab.Now.UtcDateTime;
        lab.Seerr.Quotas[7] = new JsonObject { ["movie"] = new JsonObject { ["days"] = 7, ["limit"] = 2, ["used"] = 2, ["remaining"] = 0, ["restricted"] = true } };
        // The request list holds one of Emma's movie requests (three days old); Seerr counts two: the other was made since
        // the list was last read. The latest the slot frees up: when the one held leaves the window.
        lab.Seerr.Requests.Add(FakeSeerr.Request(1, "movie", 603, 2, lab.User, now.AddDays(-3)));
        Assert.True(await lab.Model.RefreshAsync(default));
        await lab.Backend.PrepareAsync(lab.User, Movie(), default);
        var fewer = lab.Backend.Binding(lab.User, Movie()).Quota!;
        Assert.Equal((2, (int?)0), (fewer.Used, fewer.Remaining));
        Assert.Equal(lab.Now.AddDays(4), fewer.NextSlotAt);
        // The list holds three; Seerr counts two (one it no longer counts): the oldest is taken as the one not counted.
        lab.Seerr.Requests.Add(FakeSeerr.Request(2, "movie", 604, 2, lab.User, now.AddDays(-6)));
        lab.Seerr.Requests.Add(FakeSeerr.Request(3, "movie", 605, 1, lab.User, now.AddDays(-1)));
        Assert.True(await lab.Model.RefreshAsync(default));
        lab.Now = lab.Now.AddMinutes(11);
        await lab.Backend.PrepareAsync(lab.User, Movie(), default);
        Assert.Equal(lab.Now.AddDays(4).AddMinutes(-11), lab.Backend.Binding(lab.User, Movie()).Quota!.NextSlotAt);
        // Exactly what Seerr counts: as before.
        lab.Seerr.Requests.RemoveAt(lab.Seerr.Requests.Count - 1);
        Assert.True(await lab.Model.RefreshAsync(default));
        lab.Now = lab.Now.AddMinutes(11);
        await lab.Backend.PrepareAsync(lab.User, Movie(), default);
        Assert.Equal(lab.Now.AddDays(1).AddMinutes(-22), lab.Backend.Binding(lab.User, Movie()).Quota!.NextSlotAt);
    }

    [Fact]
    public async Task ASeerrThatDoesNotAnswerLeavesTheIdentityAsItWasNeverGuessed()
    {
        using var lab = new SeerrLab();
        lab.Seerr.FailWith = 503;
        await lab.Backend.PrepareAsync(lab.User, Movie(), default);
        var unknown = lab.Backend.Binding(lab.User, Movie());
        Assert.Equal((lab.Source, (int?)null, false, false), (unknown.Source, unknown.UserId, unknown.CanRequest, unknown.Can4k));
        Assert.Null(unknown.Quota);
        lab.Seerr.FailWith = 0;
        await lab.Backend.PrepareAsync(lab.User, Movie(), default);
        Assert.Equal(7, lab.Backend.Binding(lab.User, Movie()).UserId);
        // A later read that fails keeps the known account instead of forgetting it.
        lab.Now = lab.Now.AddMinutes(1);
        lab.Seerr.FailWith = 503;
        await lab.Backend.PrepareAsync(lab.User, Movie(), default);
        var kept = lab.Backend.Binding(lab.User, Movie());
        Assert.Equal((7, true), (kept.UserId, kept.CanRequest));
        // Facts older than the preparation window grant nothing.
        lab.Now = lab.Now.AddMinutes(11);
        Assert.Null(lab.Backend.Binding(lab.User, Movie()).UserId);
    }

    [Fact]
    public async Task SeerrModeRefusesSingleEpisodesBeforeRecordingAnythingAndApprovingALegacyOneIsRefusedToo()
    {
        using var rig = new IntegrationRequestLedgerTests.Rig();
        var episodes = new MutationInput { Key = "tv:tvdb:78874", Scope = "episodes", Episodes = new[] { new RequestEpisode(2, 3) } };
        // Asked in Jellyfin Enhanced mode by a Kid: waits for an OK. Then the household switches to Seerr.
        var legacy = await rig.Create(rig.Kid, episodes);
        Assert.Equal("awaiting_approval", legacy.Reason);
        rig.Policy.Configuration.ArrRequestBackend = "seerr";
        foreach (var who in new[] { rig.Member, rig.Kid, rig.Admin })
        {
            var refused = await rig.Create(who, episodes with { Episodes = new[] { new RequestEpisode(1, 1) } });
            Assert.Equal((409, "seerr_whole_season_only", "blocked"), (refused.HttpStatus, refused.Reason, refused.Outcome));
            Assert.Null(refused.RequestId);
        }
        Assert.Single(rig.Ledger.ForTitle("tv:tvdb:78874"));
        Assert.Empty(rig.Ledger.Due(rig.Now));
        var approve = await rig.Service.ApproveAsync(legacy.RequestId!, rig.Admin, null, default);
        Assert.Equal((409, "seerr_whole_season_only"), (approve.HttpStatus, approve.Reason));
        Assert.Equal("pending", rig.Ledger.Find(legacy.RequestId!)!.Status);
        Assert.Empty(rig.Ledger.Due(rig.Now));
        // The season is what's asked for instead, and it is recorded.
        var season = await rig.Create(rig.Member, IntegrationRequestLedgerTests.Seasons(2));
        Assert.Equal(201, season.HttpStatus);
        // Jellyfin Enhanced mode keeps single episodes.
        rig.Policy.Configuration.ArrRequestBackend = "je";
        Assert.Equal(201, (await rig.Create(rig.Member, episodes)).HttpStatus);
    }

    [Theory]
    [InlineData(true, false)]
    [InlineData(false, true)]
    public async Task SeerrsPartialRequestSettingTellsTheControlsWhetherOnlyTheWholeSeriesCanBeAsked(bool partial, bool wholeSeries)
    {
        using var lab = new SeerrLab();
        lab.Seerr.Settings["partialRequestsEnabled"] = partial;
        await lab.Backend.PrepareAsync(lab.User, Show(1), default);
        Assert.Equal(wholeSeries, lab.Backend.Binding(lab.User, Show(1)).SeerrWholeSeries);
        // Not a real on/off: only the whole series is sent, so the controls offer only that.
        lab.Seerr.Settings["partialRequestsEnabled"] = "yes";
        lab.Now = lab.Now.AddHours(1);
        await lab.Backend.PrepareAsync(lab.User, Show(1), default);
        Assert.True(lab.Backend.Binding(lab.User, Show(1)).SeerrWholeSeries);
        using var rig = new IntegrationRequestLedgerTests.Rig();
        rig.Policy.Configuration.ArrRequestBackend = "seerr";
        rig.Policy.Adjust = (_, _, facts) => facts with { SeerrWholeSeries = wholeSeries };
        Assert.Equal(wholeSeries, rig.Service.Me(rig.Member).SeerrWholeSeries);
        rig.Policy.Configuration.ArrRequestBackend = "je";
        Assert.False(rig.Service.Me(rig.Member).SeerrWholeSeries);
    }

    [Fact]
    public async Task SeerrHoldsWhatItCannotTakeWithoutSendingAnything()
    {
        using var lab = new SeerrLab();
        var episodes = await lab.Backend.SendAsync(lab.Job(new MutationInput { Key = "tv:tmdb:1731", Scope = "episodes", Episodes = new[] { new RequestEpisode(1, 2) } }), Pass, default);
        Assert.Equal("seerr_whole_season_only", episodes.Outcome.Reason);
        var routed = await lab.Backend.SendAsync(lab.Job(Movie() with { RootFolder = "/data/movies" }), Pass, default);
        Assert.Equal("invalid_defaults", routed.Outcome.Reason);
        var job = lab.Job(Movie(22596));
        lab.Config.JellyseerrApiKey = "ROTATED-KEY-0123456789abcdef";
        var rotated = await lab.Backend.SendAsync(job, Pass, default);
        Assert.Equal("identity_changed", rotated.Outcome.Reason);
        Assert.All(new[] { episodes, routed, rotated }, r => Assert.True(r.Parked));
        Assert.Empty(lab.Seerr.Posts);
    }

    [Fact]
    public async Task AnUnknownSeerrAccountAtSendWaitsInsteadOfParking()
    {
        using var lab = new SeerrLab();
        var r = new IntegrationRequestLedgerTests.Rig();
        using var rig = r;
        rig.Policy.Configuration.ArrRequestBackend = "seerr";
        var source = lab.Source;
        rig.Policy.Adjust = (_, _, facts) => facts with { SeerrSource = source, SeerrUser = 7, BackendQuota = new QuotaProjection(0, null, null, null, 0) };
        var ask = await rig.Create(rig.Admin, Movie(22596));
        Assert.Equal("queued_outage", ask.Reason);
        // Seerr stops answering who the person is: the job waits (retry), it isn't parked as a changed identity.
        rig.Policy.Adjust = (_, _, facts) => facts with { SeerrSource = source, SeerrUser = null, BackendQuota = null };
        await rig.Runner(lab.Backend).TickAsync(default);
        var job = rig.Ledger.ForWant(ask.RequestId!).Single();
        Assert.Equal(("retry", "backend_unavailable"), (job.State, job.Reason));
        // A different, known account is a changed identity.
        rig.Policy.Adjust = (_, _, facts) => facts with { SeerrSource = source, SeerrUser = 8, BackendQuota = new QuotaProjection(0, null, null, null, 0) };
        rig.Now = rig.Now.AddMinutes(10);
        await rig.Runner(lab.Backend).TickAsync(default);
        Assert.Equal(("parked", "identity_changed"), (rig.Ledger.ForWant(ask.RequestId!).Single().State, rig.Ledger.ForWant(ask.RequestId!).Single().Reason));
        Assert.Empty(lab.Seerr.Posts);
    }


    [Fact]
    public async Task APersonWithNoSeerrAccountIsHeldWithThatReasonCheckedHourlyWithOneAuditRowAndSentOnceLinked()
    {
        using var lab = new SeerrLab();
        using var rig = new IntegrationRequestLedgerTests.Rig();
        rig.Policy.Configuration.ArrRequestBackend = "seerr";
        var source = lab.Source;
        var woken = 0;
        var backend = new SeerrBackend(lab.Seerr.Transport, lab.Model, null, () => lab.Config, () => rig.Now, rig.Ledger.BindSeerrSend, user => woken += rig.Ledger.WakeUnlinked(user, rig.Now));
        // The policy's Seerr facts are the backend's, prepared before every check (as in production).
        rig.Policy.Before = (user, input) => backend.PrepareAsync(user, input, default);
        rig.Policy.Adjust = (user, input, facts) =>
        {
            var b = backend.Binding(user, input);
            return facts with { SeerrSource = source, SeerrUser = b.UserId, SeerrUnlinked = b.SeerrUnlinked, BackendQuota = b.Quota };
        };
        // Seerr answers, and no Seerr account is linked to the person (not "Seerr didn't answer").
        await backend.PrepareAsync(rig.Admin, Movie(22596), default);
        var unlinked = backend.Binding(rig.Admin, Movie(22596));
        Assert.Equal(((int?)null, true), (unlinked.UserId, unlinked.SeerrUnlinked));
        var ask = await rig.Create(rig.Admin, Movie(22596));
        Assert.Equal("queued_outage", ask.Reason);
        var asked = rig.Now;
        await rig.Runner(backend).TickAsync(default);
        var job = rig.Ledger.ForWant(ask.RequestId!).Single();
        Assert.Equal(("retry", "seerr_user_unlinked", 1), (job.State, job.Reason, job.Attempts));
        Assert.Equal(asked + RequestOutbox.UnlinkedRecheck, job.NextAttempt);
        // Held for a person, with a reason that says what is wrong (shown as stuck on the approval card).
        var want = rig.Ledger.Find(ask.RequestId!)!;
        Assert.Equal(("pending", "seerr_user_unlinked"), (want.Status, want.Reason));
        Assert.Contains(want.Reason, RequestHubProjection.StuckReasons);
        // Not hammered: no check before the hour is up; each later check still finds no account and records nothing new.
        for (var i = 0; i < 6; i++)
        {
            rig.Now = rig.Now.AddMinutes(30);
            await rig.Runner(backend).TickAsync(default);
        }
        job = rig.Ledger.ForWant(ask.RequestId!).Single();
        Assert.Equal(("retry", "seerr_user_unlinked", 4), (job.State, job.Reason, job.Attempts));
        var rows = rig.Ledger.Database.Read(c =>
        {
            using var cmd = RequestLedger.Cmd(c, null, "SELECT COUNT(*) FROM request_audit WHERE want_id=$w AND action='dispatch'", ("$w", ask.RequestId));
            return Convert.ToInt32(cmd.ExecuteScalar());
        });
        Assert.Equal(1, rows);
        Assert.Single(rig.Audit.ReadRecent(100), e => e.Action == "request.dispatch");
        Assert.Empty(lab.Seerr.Posts);
        Assert.Equal(0, woken);
        // Seerr links an account to them (an import, or an admin links it): the next read of who they are wakes the
        // same job at once, and it goes out once, as that account.
        lab.Seerr.Users.Add(new JsonObject { ["id"] = 9, ["jellyfinUserId"] = rig.Admin.ToString("N"), ["permissions"] = 2, ["displayName"] = "Admin" });
        rig.Now = rig.Now.AddMinutes(2);
        await backend.PrepareAsync(rig.Admin, Movie(22596), default);
        Assert.Equal(1, woken);
        Assert.Contains(rig.Ledger.Due(rig.Now), j => j.Id == job.Id);
        await rig.Runner(backend).TickAsync(default);
        await rig.Runner(backend).TickAsync(default);
        Assert.Equal("succeeded", rig.Ledger.ForWant(ask.RequestId!).Single().State);
        Assert.Equal("sent", rig.Ledger.Find(ask.RequestId!)!.Status);
        Assert.Equal("9", Assert.Single(lab.Seerr.Posts).ApiUser);
    }

    [Fact]
    public async Task SeerrsLastRead4kServerSettingSaysWhetherA4kCopyCanBeTaken()
    {
        using var lab = new SeerrLab();
        // Not read yet: unknown (nothing is concluded).
        Assert.Null(lab.Backend.FourKServer(true));
        lab.Seerr.Settings["movie4kEnabled"] = false;
        lab.Seerr.Settings["series4kEnabled"] = true;
        await lab.Backend.PrepareAsync(lab.User, Movie(), default);
        Assert.Equal(((bool?)false, (bool?)true), (lab.Backend.FourKServer(true), lab.Backend.FourKServer(false)));
        var router = new RequestBackendRouter(null!, lab.Backend, () => lab.Config);
        Assert.False(router.FourKServer(true));
        // Read long ago: unknown again.
        lab.Now = lab.Now.AddHours(2);
        Assert.Null(lab.Backend.FourKServer(true));
    }

    // ------------------------------------------------------------------ review round 1 (Seerr)

    [Fact]
    public async Task TheAccountIsConfirmedRightBeforeThePostAndAnUnconfirmedOrRelinkedOneSendsNothing()
    {
        using var lab = new SeerrLab();
        await lab.Backend.PrepareAsync(lab.User, Movie(), default);
        // Reading the account fails while posting would still work: nothing is sent, the job waits.
        lab.Seerr.BeforeRequest = uri => uri.AbsolutePath == "/api/v1/user/7" ? throw new HttpRequestException(HttpRequestError.ConnectionError, "refused") : Task.CompletedTask;
        var unconfirmed = await lab.Backend.SendAsync(lab.Job(Movie(22596)), Pass, default);
        Assert.Equal(("backend_unavailable", true, true), (unconfirmed.Outcome.Reason, unconfirmed.Retryable, unconfirmed.VerifiedNotSent));
        // A refresh that fails keeps the cached account for policy decisions...
        await lab.Backend.PrepareAsync(lab.User, Movie(), default);
        Assert.Equal(7, lab.Backend.Binding(lab.User, Movie()).UserId);
        // ...but account 7 now belongs to someone else: held as a changed identity, never posted as them.
        lab.Seerr.BeforeRequest = null;
        lab.Seerr.Users[0]["jellyfinUserId"] = Guid.NewGuid().ToString("N");
        var relinked = await lab.Backend.SendAsync(lab.Job(Movie(22596)), Pass, default);
        Assert.Equal(("identity_changed", true), (relinked.Outcome.Reason, relinked.Parked));
        Assert.Null(lab.Backend.Binding(lab.User, Movie()).UserId);
        // An account that no longer exists is held the same way.
        lab.Seerr.Users.RemoveAt(0);
        var gone = await lab.Backend.SendAsync(lab.Job(Movie(22596)), Pass, default);
        Assert.Equal(("identity_changed", true), (gone.Outcome.Reason, gone.Parked));
        Assert.Empty(lab.Seerr.Posts);
    }

    [Fact]
    public async Task A201ForTheSeasonsNobodyElseHadIsConfirmedAndReadsBackConfirmed()
    {
        using var lab = new SeerrLab();
        // Sam already asked for S1; Emma asks for S1 and S2. Seerr creates Emma's request for S2 only.
        SeerrShow(lab.Seerr, requests: (11, 8, 2, new[] { 1 }));
        var job = lab.Job(Show(1, 2));
        var result = await lab.Backend.SendAsync(job, Pass, default);
        Assert.True(result.Confirmed, result.Outcome.Message);
        Assert.Equal(("accepted", "awaiting_approval"), (result.Outcome.Outcome, result.Outcome.Reason));
        Assert.Equal(new[] { 1, 2 }, Assert.Single(lab.Seerr.Posts).Body["seasons"]!.AsArray().Select(n => (int)n!).ToArray());
        var back = await lab.Backend.ReadBackAsync(job, default);
        Assert.True(back.Confirmed, back.Outcome.Message);
        // Without a request of Emma's for any asked season, Sam's alone doesn't confirm hers.
        SeerrShow(lab.Seerr, requests: (11, 8, 2, new[] { 1, 2 }));
        var theirs = await lab.Backend.ReadBackAsync(job, default);
        Assert.True(theirs.VerifiedNotSent);
    }

    private sealed class LostBody : HttpContent
    {
        public LostBody() => Headers.ContentType = new System.Net.Http.Headers.MediaTypeHeaderValue("application/json");
        protected override Task SerializeToStreamAsync(Stream stream, System.Net.TransportContext? context) => throw new IOException("connection reset");
        protected override Task<Stream> CreateContentReadStreamAsync() => throw new IOException("connection reset");
        protected override bool TryComputeLength(out long length)
        {
            length = 0;
            return false;
        }
    }

    [Fact]
    public async Task A2xxWhoseBodyIsLostIsMaybeSentAndSettledByAFreshRead()
    {
        using var lab = new SeerrLab();
        // Seerr stores the request and sends 201, then the connection drops while the body streams.
        lab.Seerr.Movies[22596] = new JsonObject { ["id"] = 22596, ["mediaInfo"] = new JsonObject { ["status"] = 2, ["status4k"] = 1, ["requests"] = new JsonArray() } };
        lab.Seerr.OnPost = _ =>
        {
            lab.Seerr.Movies[22596]["mediaInfo"]!["requests"]!.AsArray().Add(new JsonObject { ["id"] = 31, ["status"] = 1, ["is4k"] = false, ["requestedBy"] = new JsonObject { ["id"] = 7 } });
            return new HttpResponseMessage(System.Net.HttpStatusCode.Created) { Content = new LostBody() };
        };
        var job = lab.Job(Movie(22596));
        var sent = await lab.Backend.SendAsync(job, Pass, default);
        Assert.Equal(ArrActionStatus.Unknown, sent.Outcome.Certainty);
        Assert.False(sent.VerifiedNotSent);
        var back = await lab.Backend.ReadBackAsync(job, default);
        Assert.True(back.Confirmed, back.Outcome.Message);
    }

    [Fact]
    public async Task ASpecialsRequestIsReadBackWithTheSeasonsThatWereSent()
    {
        using var lab = new SeerrLab();
        lab.Seerr.Settings["enableSpecialEpisodes"] = true;
        SeerrShow(lab.Seerr);
        lab.Seerr.AfterPost = () => throw new HttpRequestException(HttpRequestError.ResponseEnded, "dropped");
        var job = lab.Job(Show(0));
        var sent = await lab.Backend.SendAsync(job, Pass, default);
        Assert.Equal(ArrActionStatus.Unknown, sent.Outcome.Certainty);
        Assert.Equal(new[] { 0 }, Assert.Single(lab.Seerr.Posts).Body["seasons"]!.AsArray().Select(n => (int)n!).ToArray());
        var back = await lab.Backend.ReadBackAsync(job, default);
        Assert.True(back.Confirmed, back.Outcome.Message);
    }

    [Fact]
    public async Task ARequestApprovedBeforeSeerrKnewThePersonIsSentAsTheirAccountOnceKnown()
    {
        using var lab = new SeerrLab();
        var r = new IntegrationRequestLedgerTests.Rig();
        using var rig = r;
        rig.Policy.Configuration.ArrRequestBackend = "seerr";
        var source = lab.Source;
        lab.Seerr.Users.Add(new JsonObject { ["id"] = 9, ["jellyfinUserId"] = rig.Admin.ToString("N"), ["permissions"] = 2, ["displayName"] = "Admin" });
        // Seerr didn't say who the person is when they asked.
        rig.Policy.Adjust = (_, _, facts) => facts with { SeerrSource = source, SeerrUser = null, BackendQuota = new QuotaProjection(0, null, null, null, 0) };
        var ask = await rig.Create(rig.Admin, Movie(22596));
        Assert.Equal("queued_outage", ask.Reason);
        Assert.Null(rig.Ledger.ForWant(ask.RequestId!).Single().Authorization.SeerrUser);
        // Seerr answers again: the person's account is 9, and the request goes out as 9 (checked again with its rights).
        await lab.Backend.PrepareAsync(rig.Admin, Movie(22596), default);
        rig.Policy.Adjust = (_, _, facts) => facts with { SeerrSource = source, SeerrUser = 9, BackendQuota = new QuotaProjection(0, null, null, null, 0) };
        await rig.Runner(lab.Backend).TickAsync(default);
        Assert.Equal("succeeded", rig.Ledger.ForWant(ask.RequestId!).Single().State);
        Assert.Equal("9", Assert.Single(lab.Seerr.Posts).ApiUser);
    }

    [Fact]
    public async Task AnArrConnectionChangeDoesNotHoldASeerrModeRequest()
    {
        using var r = new IntegrationRequestLedgerTests.Rig();
        r.Policy.Configuration.ArrRequestBackend = "seerr";
        RequestPolicyFacts Seerr(RequestPolicyFacts facts) => facts with { SeerrSource = "seerr|key", SeerrUser = 7, BackendQuota = new QuotaProjection(0, null, null, null, 0) };
        r.Policy.Adjust = (_, _, facts) => Seerr(facts);
        var ask = await r.Create(r.Admin, Movie(22596));
        Assert.Equal("queued_outage", ask.Reason);
        // Radarr's address or key changes after approval: the Seerr-mode job still goes to Seerr.
        r.Policy.Adjust = (_, _, facts) => Seerr(facts) with { ConnectionGeneration = "g2" };
        await r.Runner().TickAsync(default);
        Assert.Equal("succeeded", r.Ledger.ForWant(ask.RequestId!).Single().State);
        Assert.Equal(1, r.Backend.Sends);
    }

    // ------------------------------------------------------------------ review round 2

    [Fact]
    public async Task AJobHeldAfterAPartialWriteResumesWhenApprovedAndFinishesWithoutASecondAdd()
    {
        using var lab = new Lab();
        var (r, _) = Ledger(lab);
        using var rig = r;
        lab.Sonarr.Lookup.Add(Lab.SeriesLookup(75565));
        lab.Sonarr.EpisodeList[75565] = new[] { (1, 1), (1, 2), (1, 3) };
        var member = rig.Policy.People[rig.Member];
        // The Member is demoted while the new series' episode list fills in: the series is in Sonarr, nothing else.
        lab.Sonarr.AfterWrite = (_, path) =>
        {
            if (path == "/api/v3/series") rig.Policy.People[rig.Member] = member with { Role = "Watcher", CanCreate = false };
        };
        var ask = await rig.Create(rig.Member, Series("episodes", episodes: new[] { new RequestEpisode(1, 2), new RequestEpisode(1, 3) }));
        Assert.Equal("queued_outage", ask.Reason);
        var used = rig.Service.Quota(rig.Member).Used;
        await rig.Runner(lab.Direct).TickAsync(default);
        var held = Assert.Single(rig.Ledger.ForWant(ask.RequestId!));
        Assert.Equal(("parked", "authorization_changed", true), (held.State, held.Reason, held.Uncertain));
        Assert.Equal("pending", rig.Ledger.Find(ask.RequestId!)!.Status);
        Assert.Equal("POST /api/v3/series", string.Join("|", lab.Sonarr.Writes.Select(w => w.Method + " " + w.Path)));
        // Part of it is upstream, so it can't be cancelled as unsent.
        Assert.Equal("request_in_flight", rig.Service.Close(ask.RequestId!, rig.Member, null).Reason);
        // The role is back and an approver resumes the same job: same scope and reservation, still uncertain.
        lab.Sonarr.AfterWrite = null;
        rig.Policy.People[rig.Member] = member;
        Assert.Equal(200, (await rig.Service.ApproveAsync(ask.RequestId!, rig.Admin, null, default)).HttpStatus);
        var resumed = Assert.Single(rig.Ledger.ForWant(ask.RequestId!));
        Assert.Equal((held.Id, "maybe_sent", true, (Guid?)rig.Admin), (resumed.Id, resumed.State, resumed.Uncertain, resumed.Authorization.Approver));
        Assert.Equal("request_in_flight", rig.Service.Close(ask.RequestId!, rig.Member, null).Reason);
        Assert.Equal(used, rig.Service.Quota(rig.Member).Used);
        // As after a restart, a fresh read comes first (the series is there: unfinished, nothing written)...
        await rig.Runner(lab.Direct).TickAsync(default);
        Assert.Equal(("retry", true), (Assert.Single(rig.Ledger.ForWant(ask.RequestId!)).State, Assert.Single(rig.Ledger.ForWant(ask.RequestId!)).Uncertain));
        Assert.Single(lab.Sonarr.Writes);
        // ...then a guarded send writes only what is missing: the episodes' monitoring and their search.
        rig.Now = rig.Now.AddMinutes(1);
        await rig.Runner(lab.Direct).TickAsync(default);
        Assert.Equal("succeeded", Assert.Single(rig.Ledger.ForWant(ask.RequestId!)).State);
        Assert.Equal("sent", rig.Ledger.Find(ask.RequestId!)!.Status);
        Assert.Equal("POST /api/v3/series|PUT /api/v3/episode/monitor|POST /api/v3/command", string.Join("|", lab.Sonarr.Writes.Select(w => w.Method + " " + w.Path)));
        Assert.Contains("EpisodeSearch", lab.Sonarr.Writes[^1].Body, StringComparison.Ordinal);
        Assert.Equal("S1E2 S1E3", Monitored(lab));
        Assert.Equal(used, rig.Service.Quota(rig.Member).Used);
    }

    [Fact]
    public async Task AuthorityIsCheckedAgainAfterWaitingForAConnectionSlotRightBeforeAWriteLeaves()
    {
        using var lab = new Lab();
        lab.Radarr.Lookup.Add(Lab.MovieLookup(961));
        lab.Radarr.Movies.Add(new JsonObject { ["id"] = 70, ["tmdbId"] = 961, ["title"] = "The General", ["monitored"] = false, ["hasFile"] = false });
        var client = lab.Arr.Factory.For(lab.Instance("Radarr").Id).Value!;
        var release = new TaskCompletionSource();
        var read = false;
        lab.Radarr.Before = (path, ct) =>
        {
            if (path == "/api/v3/movie") read = true;
            return path == "/api/v3/health" ? release.Task.WaitAsync(ct) : Task.CompletedTask;
        };
        var slow = new List<Task>();
        var demoted = false;
        string? Guard()
        {
            if (read && slow.Count == 0)
            {
                // Right before the monitoring write: slow calls take every connection slot of the instance's client,
                // and the person is demoted while the write waits for one.
                for (var i = 0; i < ArrClient.MaxConcurrency; i++) slow.Add(client.GetAsync<JsonElement>("health"));
                demoted = true;
                return null;
            }
            return demoted ? "authorization_changed" : null;
        }
        var sending = lab.Direct.SendAsync(lab.Job(Movie(961), "Radarr"), Guard, default);
        await Task.Delay(100);
        Assert.False(sending.IsCompleted);
        release.SetResult();
        var result = await sending;
        await Task.WhenAll(slow);
        Assert.Equal(("authorization_changed", true, true), (result.Outcome.Reason, result.Parked, result.VerifiedNotSent));
        Assert.Empty(lab.Radarr.Writes);
    }

    [Fact]
    public async Task AReadBackFindingThePersonsRequestWithoutEverySeasonCoveredResumesNeverReportsNotSent()
    {
        using var lab = new SeerrLab();
        // Sam has asked for S1; Emma asks for S1 and S2. Seerr creates her request for S2, and the answer is lost.
        SeerrShow(lab.Seerr, requests: (11, 8, 1, new[] { 1 }));
        lab.Seerr.AfterPost = () => throw new HttpRequestException(HttpRequestError.ResponseEnded, "dropped");
        var job = lab.Job(Show(1, 2));
        var sent = await lab.Backend.SendAsync(job, Pass, default);
        Assert.Equal(ArrActionStatus.Unknown, sent.Outcome.Certainty);
        // Before the read-back an admin declines Sam's request: S1 is no longer covered, but Emma's S2 request is there.
        lab.Seerr.Shows[1731]["mediaInfo"]!["requests"]![0]!["status"] = 3;
        var back = await lab.Backend.ReadBackAsync(job, default);
        Assert.True(back.Resumes, back.Outcome.Message);
        Assert.False(back.VerifiedNotSent);
        Assert.Equal(ArrActionStatus.Unknown, back.Outcome.Certainty);
        // The resumed send asks again as Emma; Seerr takes S1 only, and the request is confirmed.
        lab.Seerr.AfterPost = null;
        var again = await lab.Backend.SendAsync(job, Pass, default);
        Assert.True(again.Confirmed, again.Outcome.Message);
        Assert.Equal(2, lab.Seerr.Posts.Count);
        var created = lab.Seerr.Shows[1731]["mediaInfo"]!["requests"]!.AsArray().Last()!;
        Assert.Equal((7, "1"), ((int)created["requestedBy"]!["id"]!, string.Join(",", created["seasons"]!.AsArray().Select(n => (int)n!["seasonNumber"]!))));
    }

    // A ledger whose admin is Seerr account 9, and a Seerr backend that records each send on the ledger job.
    private static (IntegrationRequestLedgerTests.Rig Rig, SeerrBackend Backend) SeerrLedger(SeerrLab lab, int? account = 9)
    {
        var rig = new IntegrationRequestLedgerTests.Rig();
        rig.Policy.Configuration.ArrRequestBackend = "seerr";
        var source = lab.Source;
        lab.Seerr.Users.Add(new JsonObject { ["id"] = 9, ["jellyfinUserId"] = rig.Admin.ToString("N"), ["permissions"] = 2, ["displayName"] = "Admin" });
        rig.Policy.Adjust = (_, _, facts) => facts with { SeerrSource = source, SeerrUser = account, BackendQuota = new QuotaProjection(0, null, null, null, 0) };
        return (rig, new SeerrBackend(lab.Seerr.Transport, lab.Model, null, () => lab.Config, () => lab.Now, rig.Ledger.BindSeerrSend));
    }

    [Theory]
    [InlineData(false, "1")]
    [InlineData(true, "0,1")]
    public async Task AReadBackChecksTheSeasonsThatWentOutWhenSeerrsSpecialsSettingChangesMeanwhile(bool specialsAtSend, string sentSeasons)
    {
        using var lab = new SeerrLab();
        var (r, backend) = SeerrLedger(lab);
        using var rig = r;
        lab.Seerr.Settings["enableSpecialEpisodes"] = specialsAtSend;
        SeerrShow(lab.Seerr);
        // Seerr stores the request, an admin flips its specials setting, and the answer is lost.
        lab.Seerr.AfterPost = () =>
        {
            lab.Seerr.Settings["enableSpecialEpisodes"] = !specialsAtSend;
            throw new HttpRequestException(HttpRequestError.ResponseEnded, "dropped");
        };
        var ask = await rig.Create(rig.Admin, Show(0, 1));
        Assert.Equal("queued_outage", ask.Reason);
        await rig.Runner(backend).TickAsync(default);
        var job = Assert.Single(rig.Ledger.ForWant(ask.RequestId!));
        Assert.Equal("succeeded", job.State);
        Assert.Equal(sentSeasons, string.Join(",", Assert.Single(lab.Seerr.Posts).Body["seasons"]!.AsArray().Select(n => (int)n!)));
        Assert.Equal(sentSeasons, string.Join(",", job.Authorization.SeerrSeasons!));
    }

    [Fact]
    public async Task TheAccountARequestWentOutAsIsRecordedBeforeThePostAndReadBackAfterARestartLooksForIt()
    {
        using var lab = new SeerrLab();
        // Approved while Seerr didn't say who the person is.
        var (r, backend) = SeerrLedger(lab, account: null);
        using var rig = r;
        var ask = await rig.Create(rig.Admin, Movie(22596));
        Assert.Null(Assert.Single(rig.Ledger.ForWant(ask.RequestId!)).Authorization.SeerrUser);
        // Seerr knows the person now (account 9): the request goes out as 9. Right after Seerr stores it, account 9 is
        // relinked to someone else and the person to account 10, the cached identity expires, and the process stops
        // before the outcome is written.
        await backend.PrepareAsync(rig.Admin, Movie(22596), default);
        lab.Seerr.AfterPost = () =>
        {
            lab.Seerr.Users.Single(u => (int)u["id"]! == 9)["jellyfinUserId"] = Guid.NewGuid().ToString("N");
            lab.Seerr.Users.Add(new JsonObject { ["id"] = 10, ["jellyfinUserId"] = rig.Admin.ToString("N"), ["permissions"] = 2, ["displayName"] = "Admin" });
            lab.Now = lab.Now.AddMinutes(11);
            throw new HttpRequestException(HttpRequestError.ResponseEnded, "dropped");
        };
        var job = rig.Ledger.Due(rig.Now).Single();
        Assert.True(rig.Ledger.Claim(job, rig.Db.Generation, rig.Now));
        var sent = await backend.SendAsync(job, Pass, default);
        Assert.Equal(ArrActionStatus.Unknown, sent.Outcome.Certainty);
        Assert.Equal("9", Assert.Single(lab.Seerr.Posts).ApiUser);
        var bound = Assert.Single(rig.Ledger.ForWant(ask.RequestId!)).Authorization;
        Assert.Equal((9, 0), (bound.SeerrUser, bound.SeerrSeasons!.Length));
        // After the restart the read-back looks for account 9's request (the one that went out), not account 10's.
        rig.Ledger.Recover(rig.Now);
        await rig.Runner(backend).TickAsync(default);
        Assert.Equal("succeeded", Assert.Single(rig.Ledger.ForWant(ask.RequestId!)).State);
        Assert.Single(lab.Seerr.Posts);
    }

    [Fact]
    public async Task TheAccountCheckAndTheConfirmingReadsUseTheAddressThePostGoesTo()
    {
        using var lab = new SeerrLab();
        lab.Config.JellyseerrUrls = FakeSeerr.Url + "\nhttp://seerr-copy.lan:5055";
        static Task Refused() => Task.FromException(new HttpRequestException(HttpRequestError.ConnectionError, "refused"));
        // The address the POST goes to can't answer the account check; another address could: nothing is sent.
        lab.Seerr.BeforeRequest = uri => uri.Host == "seerr.lan" && uri.AbsolutePath == "/api/v1/user/7" ? Refused() : Task.CompletedTask;
        var job = lab.Job(Movie(22596));
        var unconfirmed = await lab.Backend.SendAsync(job, Pass, default);
        Assert.Equal(("backend_unavailable", true), (unconfirmed.Outcome.Reason, unconfirmed.VerifiedNotSent));
        Assert.Empty(lab.Seerr.Posts);
        // Sent there with the answer lost: while that address can't be read, the request stays unconfirmed (another
        // address's answer isn't taken for it).
        lab.Seerr.BeforeRequest = null;
        lab.Seerr.AfterPost = () => throw new HttpRequestException(HttpRequestError.ResponseEnded, "dropped");
        var sent = await lab.Backend.SendAsync(job, Pass, default);
        Assert.Equal(("seerr.lan", ArrActionStatus.Unknown), (Assert.Single(lab.Seerr.Posts).Host, sent.Outcome.Certainty));
        lab.Seerr.BeforeRequest = uri => uri.Host == "seerr.lan" && uri.AbsolutePath == "/api/v1/movie/22596" ? Refused() : Task.CompletedTask;
        var back = await lab.Backend.ReadBackAsync(job, default);
        Assert.Equal((false, false, "service_down"), (back.Confirmed, back.VerifiedNotSent, back.Outcome.Reason));
        lab.Seerr.BeforeRequest = null;
        Assert.True((await lab.Backend.ReadBackAsync(job, default)).Confirmed);
    }

    // ------------------------------------------------------------------ router and admin add

    [Fact]
    public async Task TheRouterSendsEachJobToTheBackendItWasAuthorisedFor()
    {
        using var lab = new SeerrLab();
        lab.Arr.Radarr.Lookup.Add(Lab.MovieLookup(961));
        var router = new RequestBackendRouter(lab.Arr.Direct, lab.Backend, () => lab.Config);
        // Seerr mode now, but a job authorised in Jellyfin Enhanced mode still goes to Radarr.
        var direct = await router.SendAsync(lab.Arr.Job(Movie(961), "Radarr"), Pass, default);
        Assert.True(direct.Confirmed, direct.Outcome.Message);
        Assert.Empty(lab.Seerr.Posts);
        var seerr = await router.SendAsync(lab.Job(Movie(22596)), Pass, default);
        Assert.True(seerr.Confirmed, seerr.Outcome.Message);
        Assert.Single(lab.Seerr.Posts);
        var unknown = await router.SendAsync(lab.Arr.Job(Movie(961), "Radarr", backend: "status_only"), Pass, default);
        Assert.Equal("configuration_changed", unknown.Outcome.Reason);
        lab.Config.ArrRequestBackend = "status_only";
        Assert.Null(router.Binding(lab.User, Movie()).UserId);
    }

    // ------------------------------------------------------------------ Seerr mode: following new seasons

    // A series in Seerr with six seasons: 1–2 aired long ago, 3–5 started this autumn, 6 not out yet. Sam (account 8)
    // asked for season 4, and Seerr declined Sam's season 5.
    private static void FollowedShow(FakeSeerr seerr)
    {
        static JsonObject Season(int n, string? aired, int episodes = 8) => new() { ["seasonNumber"] = n, ["episodeCount"] = episodes, ["airDate"] = aired };
        seerr.Shows[1731] = new JsonObject
        {
            ["id"] = 1731,
            ["seasons"] = new JsonArray(Season(0, "2019-01-01", 2), Season(1, "2020-01-01"), Season(2, "2022-01-01"), Season(3, "2026-09-01"), Season(4, "2026-09-20"), Season(5, "2026-10-01"), Season(6, "2027-03-01"), Season(7, null, 0)),
            ["mediaInfo"] = new JsonObject
            {
                ["status"] = 2, ["status4k"] = 1, ["seasons"] = new JsonArray(),
                ["requests"] = new JsonArray(
                    new JsonObject { ["id"] = 501, ["status"] = 2, ["is4k"] = false, ["type"] = "tv", ["requestedBy"] = new JsonObject { ["id"] = 8 }, ["seasons"] = new JsonArray(new JsonObject { ["seasonNumber"] = 4 }) },
                    new JsonObject { ["id"] = 502, ["status"] = 3, ["is4k"] = false, ["type"] = "tv", ["requestedBy"] = new JsonObject { ["id"] = 8 }, ["seasons"] = new JsonArray(new JsonObject { ["seasonNumber"] = 5 }) }),
            },
        };
    }

    private static int FollowCharges(IntegrationRequestLedgerTests.Rig rig, string wantId) => rig.Db.Read(c =>
    {
        using var cmd = RequestLedger.Cmd(c, null, "SELECT COUNT(*) FROM reservations WHERE want_id=$w AND scope LIKE 's%' AND state='charged'", ("$w", wantId));
        return Convert.ToInt32(cmd.ExecuteScalar(), System.Globalization.CultureInfo.InvariantCulture);
    });

    [Fact]
    public async Task InSeerrModeKeepGettingAsksSeerrOnceForEachNewStartedSeasonNobodyHasAndChargesItsOwnerOnce()
    {
        using var lab = new SeerrLab();
        var (r, backend) = SeerrLedger(lab);
        using var rig = r;
        var source = lab.Source;
        lab.Seerr.Users.Add(new JsonObject { ["id"] = 12, ["jellyfinUserId"] = rig.Member.ToString("N"), ["permissions"] = 32, ["displayName"] = "Member" });
        // As in production, Seerr-mode facts carry no instance or connection (Seerr picks its own server).
        rig.Policy.Adjust = (user, _, facts) => facts with { InstanceId = string.Empty, ConnectionGeneration = string.Empty, SeerrSource = source, SeerrUser = user == rig.Member ? 12 : 9, BackendQuota = new QuotaProjection(0, null, null, null, 0) };
        rig.Now = lab.Now;
        FollowedShow(lab.Seerr);
        // The Member asks to keep getting new episodes from season 2; it goes to Seerr as their account (season 2 only).
        var ask = await rig.Create(rig.Member, new MutationInput { Key = "tv:tmdb:1731", Scope = "future", Seasons = new[] { 2 } });
        Assert.Equal("queued_outage", ask.Reason);
        await rig.Runner(backend).TickAsync(default);
        Assert.Equal("sent", rig.Ledger.Find(ask.RequestId!)!.Status);
        Assert.Equal("2", string.Join(",", Assert.Single(lab.Seerr.Posts).Body["seasons"]!.AsArray().Select(n => (int)n!)));
        // Someone else asking for the same follows it for free; a Kid's keep-getting that waits for an OK isn't followed.
        var follower = rig.Add("Member");
        Assert.Equal("merged", (await rig.Create(follower, new MutationInput { Key = "tv:tmdb:1731", Scope = "future", Seasons = new[] { 2 } })).Outcome);
        var kid = await rig.Create(rig.Kid, new MutationInput { Key = "tv:tmdb:1732", Scope = "future", Seasons = new[] { 1 } });
        Assert.Equal("awaiting_approval", kid.Reason);

        // The check: season 3 started and nobody has it (one request, as the owner, charged once); 4 is Sam's, 5 Seerr
        // declined, 6 hasn't started, 7 is only announced.
        var signal = new RequestOutboxSignal();
        var follow = new FutureSeasonCharges(lab.Arr.Store, rig.Ledger, rig.Policy, lab.Arr.Arr.Factory, rig.Feed, null, null, () => rig.Now, backend, lab.Model, signal);
        Assert.Equal(1, await follow.FollowSeerrAsync(default));
        var jobs = rig.Ledger.ForWant(ask.RequestId!);
        var season3 = Assert.Single(jobs, j => j.State == "queued");
        Assert.Equal(("seasons", "3", rig.Member), (season3.Input.Scope, string.Join(",", season3.Input.Seasons), season3.Authorization.Requester));
        Assert.Equal(1, FollowCharges(rig, ask.RequestId!));
        Assert.Empty(rig.Ledger.ForTitle("tv:tmdb:1732").SelectMany(w => rig.Ledger.ForWant(w.Id)));
        // Checked again (or after a restart) before it went out: nothing more.
        Assert.Equal(0, await follow.FollowSeerrAsync(default));
        rig.Reopen();
        var again = new FutureSeasonCharges(lab.Arr.Store, rig.Ledger, rig.Policy, lab.Arr.Arr.Factory, rig.Feed, null, null, () => rig.Now, backend, lab.Model, signal);
        Assert.Equal(0, await again.FollowSeerrAsync(default));
        // It goes out as the Member's account, for season 3 only; the request stays sent.
        backend = new SeerrBackend(lab.Seerr.Transport, lab.Model, null, () => lab.Config, () => lab.Now, rig.Ledger.BindSeerrSend);
        await rig.Runner(backend).TickAsync(default);
        var (_, user, body) = lab.Seerr.Posts.Last();
        Assert.Equal(("12", "3"), (user, string.Join(",", body["seasons"]!.AsArray().Select(n => (int)n!))));
        Assert.Equal("sent", rig.Ledger.Find(ask.RequestId!)!.Status);
        Assert.Equal(0, await again.FollowSeerrAsync(default));
        Assert.Equal(2, lab.Seerr.Posts.Count);
        Assert.Equal(1, FollowCharges(rig, ask.RequestId!));
        // Charging future seasons off: season 6 starts and is still asked for, without a charge.
        rig.Policy.Configuration.ArrRequestChargeFutureSeasons = false;
        lab.Seerr.Shows[1731]["seasons"]!.AsArray()[6]!["airDate"] = "2026-10-10";
        Assert.Equal(1, await again.FollowSeerrAsync(default));
        Assert.Equal(1, FollowCharges(rig, ask.RequestId!));
        // Jellyfin Enhanced mode: nothing is asked of Seerr.
        rig.Policy.Configuration.ArrRequestBackend = "je";
        lab.Seerr.Shows[1731]["seasons"]!.AsArray()[7]!["airDate"] = "2026-10-11";
        lab.Seerr.Shows[1731]["seasons"]!.AsArray()[7]!["episodeCount"] = 3;
        Assert.Equal(0, await again.FollowSeerrAsync(default));
        // As a hosted service the check waits a few minutes after start; stopping ends it at once.
        await again.StartAsync(default);
        var stop = again.StopAsync(default);
        Assert.Same(stop, await Task.WhenAny(stop, Task.Delay(5000)));
    }

    [Fact]
    public async Task InSeerrModeAFollowedSeasonSeerrRefusesIsHeldAndApprovingTheRequestSendsItAgainWithoutASecondCharge()
    {
        using var lab = new SeerrLab();
        var (r, backend) = SeerrLedger(lab);
        using var rig = r;
        var source = lab.Source;
        rig.Policy.Adjust = (_, _, facts) => facts with { InstanceId = string.Empty, ConnectionGeneration = string.Empty, SeerrSource = source, SeerrUser = 9, BackendQuota = new QuotaProjection(0, null, null, null, 0) };
        rig.Now = lab.Now;
        FollowedShow(lab.Seerr);
        // The administrator's keep-getting for the 4K copy: Sam's standard season 4 and declined season 5 aren't the 4K copy's.
        var ask = await rig.Create(rig.Admin, new MutationInput { Key = "tv:tmdb:1731", Scope = "future", Seasons = new[] { 2 }, Variant = "4k" });
        await rig.Runner(backend).TickAsync(default);
        Assert.Equal("sent", rig.Ledger.Find(ask.RequestId!)!.Status);
        var follow = new FutureSeasonCharges(lab.Arr.Store, rig.Ledger, rig.Policy, lab.Arr.Arr.Factory, rig.Feed, null, null, () => rig.Now, backend, lab.Model);
        Assert.Equal(3, await follow.FollowSeerrAsync(default));
        Assert.Equal(new[] { "3", "4", "5" }, rig.Ledger.ForWant(ask.RequestId!).Where(j => j.State == "queued").Select(j => string.Join(",", j.Input.Seasons)).Order().ToArray());
        Assert.All(rig.Ledger.ForWant(ask.RequestId!).Where(j => j.State == "queued"), j => Assert.Equal("4k", j.Input.Variant));

        // Seerr refuses (over its quota): held with that reason, and the request waits for an OK.
        lab.Seerr.OnPost = b => (int)b["seasons"]![0]! == 3 ? IntegrationTransport.Response("{\"message\":\"Series Quota exceeded.\"}", 403) : null;
        rig.Now = rig.Now.AddMinutes(1);
        await rig.Runner(backend).TickAsync(default);
        var parked = Assert.Single(rig.Ledger.ForWant(ask.RequestId!), j => j.State == "parked");
        Assert.Equal(("3", "quota_exceeded"), (string.Join(",", parked.Input.Seasons), parked.Reason));
        var held = rig.Ledger.Find(ask.RequestId!)!;
        Assert.Equal("pending", held.Status);
        // Nothing is asked again behind the hold.
        Assert.Equal(0, await follow.FollowSeerrAsync(default));
        Assert.Equal(3, FollowCharges(rig, ask.RequestId!));

        // Seerr's limit of 4 with 4 used: approving can't make it fit. With 3 used (seasons 2, 4 and 5, which went out and
        // aren't counted again here) season 3 fits.
        QuotaProjection? seerrQuota = new(4, 4, 0, null, 0);
        rig.Policy.Adjust = (_, _, facts) => facts with { InstanceId = string.Empty, ConnectionGeneration = string.Empty, SeerrSource = source, SeerrUser = 9, BackendQuota = seerrQuota };
        var refused = await rig.Service.ApproveAsync(ask.RequestId!, rig.Admin, null, default);
        Assert.Equal((429, "over_quota", "pending"), (refused.HttpStatus, refused.Reason, rig.Ledger.Find(ask.RequestId!)!.Status));
        seerrQuota = new(3, 4, 1, null, 0);
        // Approving sends season 3 again (only it), with the same charge.
        lab.Seerr.OnPost = null;
        Assert.Equal(200, (await rig.Service.ApproveAsync(ask.RequestId!, rig.Admin, null, default)).HttpStatus);
        var resent = Assert.Single(rig.Ledger.ForWant(ask.RequestId!), j => j.State == "queued");
        Assert.Equal("3", string.Join(",", resent.Input.Seasons));
        Assert.Equal("cancelled", rig.Ledger.Job(parked.Id)!.State);
        Assert.Equal(3, FollowCharges(rig, ask.RequestId!));
        rig.Now = rig.Now.AddMinutes(1);
        var posts = lab.Seerr.Posts.Count;
        await rig.Runner(backend).TickAsync(default);
        Assert.Equal(posts + 1, lab.Seerr.Posts.Count);
        Assert.Equal("sent", rig.Ledger.Find(ask.RequestId!)!.Status);
        Assert.Equal(0, await follow.FollowSeerrAsync(default));

        // Season 6 starts and Seerr's answer can't be taken for success: it waits for an OK; once approved and sent, the
        // request is sent again (the failed attempt doesn't keep it waiting).
        lab.Seerr.Shows[1731]["seasons"]!.AsArray()[6]!["airDate"] = "2026-10-10";
        Assert.Equal(1, await follow.FollowSeerrAsync(default));
        lab.Seerr.OnPost = _ => IntegrationTransport.Response("<html>conflict</html>", 409, "text/html");
        rig.Now = rig.Now.AddMinutes(1);
        await rig.Runner(backend).TickAsync(default);
        var stuck = Assert.Single(rig.Ledger.ForWant(ask.RequestId!), j => j.Input.Seasons.SequenceEqual(new[] { 6 }));
        Assert.Contains(stuck.State, new[] { "failed", "parked" });
        Assert.Equal("pending", rig.Ledger.Find(ask.RequestId!)!.Status);
        lab.Seerr.OnPost = null;
        Assert.Equal(200, (await rig.Service.ApproveAsync(ask.RequestId!, rig.Admin, null, default)).HttpStatus);
        rig.Now = rig.Now.AddMinutes(1);
        await rig.Runner(backend).TickAsync(default);
        Assert.Contains(rig.Ledger.ForWant(ask.RequestId!), j => j.Input.Seasons.SequenceEqual(new[] { 6 }) && j.State == "succeeded");
        Assert.Equal("sent", rig.Ledger.Find(ask.RequestId!)!.Status);
        Assert.Equal(4, FollowCharges(rig, ask.RequestId!));
    }

    private static ArrAddService AddService(Lab lab, IntegrationRequestLedgerTests.Rig rig)
        => new(lab.Store, lab.Arr.Factory, rig.Service, () => lab.Config);

    [Fact]
    public async Task AddOptionsComeFromACurrentSnapshotAndSayWhyADirectAddIsNotOffered()
    {
        using var lab = new Lab();
        var (r, _) = Ledger(lab);
        using var rig = r;
        lab.Sonarr.Lookup.Add(Lab.SeriesLookup(75565));
        var add = AddService(lab, rig);
        var options = await add.OptionsAsync(lab.Instance("Sonarr").Id, TitleKey.Parse("tv:tvdb:75565"), default);
        Assert.NotNull(options);
        Assert.True(options!.Direct, options.Message);
        Assert.Equal(new[] { 4, 5 }, options.Profiles.Select(p => p.Id));
        Assert.Equal("/data/tv", Assert.Single(options.RootFolders).Path);
        Assert.True(options.DefaultsValid);
        var title = JsonSerializer.SerializeToNode(options.Title)!;
        Assert.False((bool)title["inArr"]!);
        Assert.Equal(5, title["seasons"]!.AsArray().Count);
        // Seerr mode, phase 3 off, the wrong kind of instance, 4K switched off, an unknown title.
        lab.Config.ArrRequestBackend = "seerr";
        Assert.Equal("seerr_mode", (await add.OptionsAsync(lab.Instance("Sonarr").Id, null, default))!.Reason);
        lab.Config.ArrRequestBackend = "je";
        lab.Config.ArrPhase3Enabled = false;
        var off = (await add.OptionsAsync(lab.Instance("Sonarr").Id, null, default))!;
        Assert.Equal("phase_off", off.Reason);
        Assert.NotEmpty(off.Profiles);   // the instance's add defaults can still be chosen on the settings page
        lab.Config.ArrPhase3Enabled = true;
        Assert.Equal("kind_mismatch", (await add.OptionsAsync(lab.Instance("Radarr").Id, TitleKey.Parse("tv:tvdb:75565"), default))!.Reason);
        Assert.Equal("fourk_off", (await add.OptionsAsync(lab.Instance("Radarr 4K").Id, TitleKey.Parse("movie:tmdb:961"), default))!.Reason);
        Assert.Equal("title_not_found", (await add.OptionsAsync(lab.Instance("Radarr").Id, TitleKey.Parse("movie:tmdb:961"), default))!.Reason);
        Assert.Null(await add.OptionsAsync("00000000-0000-0000-0000-00000000dead", null, default));
        Assert.Empty(lab.Sonarr.Writes);
    }

    [Fact]
    public async Task AnAdminAddIsARoutedRequestThatTheOutboxSendsToThatInstance()
    {
        using var lab = new Lab();
        var (r, _) = Ledger(lab);
        using var rig = r;
        lab.Config.ArrRequest4kMoviesEnabled = true;
        lab.Radarr4k.Lookup.Add(Lab.MovieLookup(961));
        var add = AddService(lab, rig);
        var instance = lab.Instance("Radarr 4K");
        var outcome = await add.AddAsync(rig.Admin, new ManageAddRequest { InstanceId = instance.Id, Key = "movie:tmdb:961", IdempotencyKey = "sheet-1" }, default);
        Assert.Equal((201, "queued_outage"), (outcome.HttpStatus, outcome.Reason));
        var want = rig.Ledger.Find(outcome.RequestId!)!;
        Assert.Equal(("4k", instance.Id, "je-add-sheet-1"), (want.Input.Variant, want.Input.InstanceId, want.ClientRequestId));
        // The same sheet tapped again is the same request.
        var replay = await add.AddAsync(rig.Admin, new ManageAddRequest { InstanceId = instance.Id, Key = "movie:tmdb:961", IdempotencyKey = "sheet-1" }, default);
        Assert.Equal((200, outcome.RequestId), (replay.HttpStatus, replay.RequestId));
        await rig.Runner(lab.Direct).TickAsync(default);
        Assert.Equal("sent", rig.Ledger.Find(outcome.RequestId!)!.Status);
        Assert.Single(lab.Radarr4k.Writes, w => w.Path == "/api/v3/movie");
        Assert.Empty(lab.Radarr.Writes);
        // Overrides are checked against the snapshot before anything is recorded; bad input is refused.
        var badProfile = await add.AddAsync(rig.Admin, new ManageAddRequest { InstanceId = instance.Id, Key = "movie:tmdb:962", ProfileId = 42, IdempotencyKey = "sheet-2" }, default);
        Assert.Equal((400, "invalid_defaults"), (badProfile.HttpStatus, badProfile.Reason));
        Assert.Equal(400, (await add.AddAsync(rig.Admin, new ManageAddRequest { InstanceId = lab.Instance("Sonarr").Id, Key = "tv:tvdb:75565", IdempotencyKey = "sheet-3" }, default)).HttpStatus);
        Assert.Equal(400, (await add.AddAsync(rig.Admin, new ManageAddRequest { InstanceId = instance.Id, Key = "tv:tvdb:75565", Seasons = new[] { 1 }, IdempotencyKey = "sheet-4" }, default)).HttpStatus);
        Assert.Equal(400, (await add.AddAsync(rig.Admin, new ManageAddRequest { InstanceId = instance.Id, Key = "movie:tmdb:962" }, default)).HttpStatus);
        lab.Config.ArrRequestBackend = "seerr";
        var off = await add.AddAsync(rig.Admin, new ManageAddRequest { InstanceId = instance.Id, Key = "movie:tmdb:962", IdempotencyKey = "sheet-5" }, default);
        Assert.Equal((409, "direct_add_unavailable"), (off.HttpStatus, off.Reason));
        Assert.Null(rig.Ledger.ForTitle("movie:tmdb:962").FirstOrDefault());
    }
}
