using System.Net;
using System.Text.Json;
using System.Text.Json.Nodes;
using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services.ListPlaceholders;

namespace JE.Tests;

// Admin "Add to Radarr/Sonarr" against an in-memory Radarr/Sonarr: request bodies (Radarr movie, Sonarr series with
// every season explicit), the existing-series season/episode monitoring branches, duplicates, lookup mapping and the
// sanitised error mapping.
[Collection("Plugin singleton")]
public class ListPlaceholdersArrTests
{
    private const string Admin = "0123456789abcdef0123456789abcdef";

    private sealed class Fixture : IDisposable
    {
        public ApiPluginFixture Plugin { get; } = new();
        public FakeArr Arr { get; } = new();
        public ListPlaceholderArrService Service { get; }

        public Fixture(bool radarr = true, bool sonarr = true, Func<FakeArr, IHttpClientFactory>? factory = null)
        {
            var config = Plugin.Plugin.Configuration;
            config.ListPlaceholdersEnabled = true;
            config.ListPlaceholdersArrEnabled = true;
            config.RadarrInstances = radarr ? $"[{{\"Name\":\"Radarr 4K\",\"Url\":\"http://127.0.0.1:1\",\"ApiKey\":\"x\",\"Enabled\":false}},{{\"Name\":\"Movies\",\"Url\":\"{FakeArr.RadarrUrl}/\",\"ApiKey\":\"{FakeArr.RadarrKey}\",\"UrlMappings\":\"http://jf.test|http://radarr.test\",\"Enabled\":true}}]" : "[]";
            config.SonarrInstances = sonarr ? $"[{{\"Name\":\"TV\",\"Url\":\"{FakeArr.SonarrUrl}\",\"ApiKey\":\"{FakeArr.SonarrKey}\",\"Enabled\":true}}]" : "[]";
            Service = new ListPlaceholderArrService(factory?.Invoke(Arr) ?? Arr.Transport, new ListPlaceholderStore(Plugin.Core.Paths.Object, Plugin.Core.Logger), Plugin.Core.Logger)
            {
                EpisodePollInterval = TimeSpan.FromMilliseconds(1),
            };
            Arr.RadarrCatalog.Add(FakeArr.Movie(49521, "Man of Steel", 2013, "tt0770828"));
            Arr.AddSeriesToCatalog(391153, 110492, "Peacemaker", "peacemaker", 3, 8, 8);
        }

        public Task<ListOutcome> Add(string json, string user = Admin) =>
            Service.AddAsync(JsonSerializer.Deserialize<ArrAddRequest>(json), user, "admin", CancellationToken.None);

        public void Dispose()
        {
            Arr.Dispose();
            Plugin.Dispose();
        }
    }

    private static ArrAddResultDto Ok(ListOutcome outcome)
    {
        Assert.True(outcome.StatusCode == 200, $"expected 200, got {outcome.StatusCode}: {JsonSerializer.Serialize(outcome.Value)}");
        return Assert.IsType<ArrAddResultDto>(outcome.Value);
    }

    private static ListErrorDto Error(ListOutcome outcome, int status, string code)
    {
        Assert.True(outcome.StatusCode == status, $"expected {status}, got {outcome.StatusCode}: {JsonSerializer.Serialize(outcome.Value)}");
        var error = Assert.IsType<ListErrorDto>(outcome.Value);
        Assert.Equal(code, error.Code);
        return error;
    }

    private const string MovieBody = "{\"mediaType\":\"movie\",\"instance\":0,\"tmdbId\":49521,\"scope\":\"movie\",\"qualityProfileId\":4,\"rootFolderPath\":\"/movies\",\"search\":true,\"minimumAvailability\":\"inCinemas\"}";

    [Fact]
    public async Task RadarrAddSendsAnExplicitServerBuiltBody()
    {
        using var f = new Fixture();
        var result = Ok(await f.Add(MovieBody));

        Assert.Equal("added", result.Result);
        Assert.True(result.Searched);
        Assert.Equal("Man of Steel", result.Title);
        Assert.Equal("/movie/49521", result.ArrPath);
        Assert.Equal("Movies", result.Instance.Name);
        Assert.Equal(FakeArr.RadarrUrl, result.Instance.InstanceUrl);
        Assert.Equal("http://jf.test|http://radarr.test", result.Instance.UrlMappings);

        var post = Assert.Single(f.Arr.Writes("radarr"));
        Assert.Equal("/api/v3/movie", post.Path);
        Assert.Equal(FakeArr.RadarrKey, post.ApiKey);
        var body = post.Json;
        Assert.Equal("Man of Steel", (string)body["title"]!);
        Assert.Equal(49521, (int)body["tmdbId"]!);
        Assert.Equal(2013, (int)body["year"]!);
        Assert.Equal(4, (int)body["qualityProfileId"]!);
        Assert.Equal("/movies", (string)body["rootFolderPath"]!);
        Assert.True((bool)body["monitored"]!);
        Assert.Equal("inCinemas", (string)body["minimumAvailability"]!);
        Assert.Empty((JsonArray)body["tags"]!);
        Assert.True((bool)body["addOptions"]!["searchForMovie"]!);
        Assert.Null(body["addOptions"]!["monitor"]);
        Assert.Equal(new[] { "addOptions", "minimumAvailability", "monitored", "qualityProfileId", "rootFolderPath", "tags", "title", "tmdbId", "year" }, body.Select(p => p.Key).OrderBy(k => k, StringComparer.Ordinal));
        // The disabled "Radarr 4K" instance is never contacted; the lookup used the TMDB id.
        Assert.All(f.Arr.Calls, c => Assert.NotEqual("other", c.Service));
        Assert.Contains(f.Arr.Calls, c => c.Path == "/api/v3/movie/lookup?term=tmdb%3A49521");
    }

    [Fact]
    public async Task RadarrDefaultsToReleasedAndImdbLookupWorksToo()
    {
        using var f = new Fixture();
        Ok(await f.Add("{\"mediaType\":\"movie\",\"instance\":0,\"imdbId\":\"tt0770828\",\"scope\":\"movie\",\"qualityProfileId\":1,\"rootFolderPath\":\"/movies\"}"));

        var body = Assert.Single(f.Arr.Writes("radarr")).Json;
        Assert.Equal("released", (string)body["minimumAvailability"]!);
        Assert.False((bool)body["addOptions"]!["searchForMovie"]!);
        Assert.Contains(f.Arr.Calls, c => c.Path == "/api/v3/movie/lookup?term=imdb%3Att0770828");
    }

    [Fact]
    public async Task AMovieAlreadyInRadarrIsReportedWithoutAnotherAdd()
    {
        using var f = new Fixture();
        Ok(await f.Add(MovieBody));
        var again = Ok(await f.Add(MovieBody));

        Assert.Equal("already_exists", again.Result);
        Assert.False(again.Searched);
        Assert.True(again.Monitored);
        Assert.NotNull(again.ArrId);
        Assert.Single(f.Arr.Writes("radarr"), c => c.Path == "/api/v3/movie");
    }

    [Fact]
    public async Task AMonitoredSeasonWithUnmonitoredEpisodesGetsItsEpisodesMonitored()
    {
        // Sonarr keeps a season flag on while its episodes are unmonitored (episode edits, "existing/missing" add options),
        // and a series PUT with an unchanged flag doesn't touch them: the episodes themselves must be monitored.
        using var f = new Fixture();
        var series = f.Arr.SeedSeries(391153, monitored: true, s => s > 0, (s, e) => s == 2 && e == 1);
        var seriesId = (int)series["id"]!;
        var result = Ok(await f.Add("{\"mediaType\":\"tv\",\"instance\":0,\"tmdbId\":110492,\"scope\":\"season\",\"seasonNumber\":2,\"qualityProfileId\":4,\"rootFolderPath\":\"/tv\",\"search\":true}"));

        Assert.Equal("monitoring_added", result.Result);
        Assert.True(result.Searched);
        var writes = f.Arr.Writes("sonarr");
        Assert.Equal(new[] { "PUT /api/v3/episode/monitor", "POST /api/v3/command" }, writes.Select(w => w.Method + " " + w.Path));
        Assert.Equal(7, ((JsonArray)writes[0].Json["episodeIds"]!).Count);
        Assert.Equal("SeasonSearch", (string)writes[1].Json["name"]!);
        Assert.Equal(Enumerable.Range(1, 8).Select(e => (2, e)), f.Arr.MonitoredEpisodes(seriesId));

        var again = Ok(await f.Add("{\"mediaType\":\"tv\",\"instance\":0,\"tmdbId\":110492,\"scope\":\"season\",\"seasonNumber\":2,\"qualityProfileId\":4,\"rootFolderPath\":\"/tv\",\"search\":true}"));
        Assert.Equal("already_monitored", again.Result);
        Assert.Equal(2, f.Arr.Writes("sonarr").Count);
    }

    [Fact]
    public async Task AMonitoredSeasonOfAnUnmonitoredSeriesSwitchesTheSeriesOnAndMonitorsTheEpisodes()
    {
        using var f = new Fixture();
        var series = f.Arr.SeedSeries(391153, monitored: false, s => s == 2, (s, e) => false);
        var seriesId = (int)series["id"]!;
        var result = Ok(await f.Add("{\"mediaType\":\"tv\",\"instance\":0,\"tmdbId\":110492,\"scope\":\"season\",\"seasonNumber\":2,\"qualityProfileId\":4,\"rootFolderPath\":\"/tv\"}"));

        Assert.Equal("monitoring_added", result.Result);
        Assert.False(result.Searched);
        var writes = f.Arr.Writes("sonarr");
        Assert.Equal(new[] { "POST /api/v3/seasonpass", "PUT /api/v3/episode/monitor" }, writes.Select(w => w.Method + " " + w.Path));
        Assert.Equal(8, ((JsonArray)writes[1].Json["episodeIds"]!).Count);
        Assert.True((bool)f.Arr.SeriesById(seriesId)["monitored"]!);
        Assert.Equal(Enumerable.Range(1, 8).Select(e => (2, e)), f.Arr.MonitoredEpisodes(seriesId));
    }

    [Fact]
    public async Task ASeasonFlagChangeSendsOnlyThatSeasonThroughTheSeasonPass()
    {
        using var f = new Fixture();
        var series = f.Arr.SeedSeries(391153, monitored: false, s => false, (s, e) => s == 1 && e == 3);
        var seriesId = (int)series["id"]!;
        Ok(await f.Add("{\"mediaType\":\"tv\",\"instance\":0,\"tmdbId\":110492,\"scope\":\"season\",\"seasonNumber\":2,\"qualityProfileId\":4,\"rootFolderPath\":\"/tv\"}"));

        var writes = f.Arr.Writes("sonarr");
        Assert.Equal(new[] { "POST /api/v3/seasonpass", "PUT /api/v3/episode/monitor" }, writes.Select(w => w.Method + " " + w.Path));
        // No full series PUT (it would send every season flag JE read back) and no monitoringOptions (episodes untouched).
        Assert.Equal($"{{\"series\":[{{\"id\":{seriesId},\"monitored\":true,\"seasons\":[{{\"seasonNumber\":2,\"monitored\":true}}]}}]}}", writes[0].Body);
        Assert.Equal(8, ((JsonArray)writes[1].Json["episodeIds"]!).Count);
        Assert.True((bool)f.Arr.SeriesById(seriesId)["monitored"]!);
        Assert.Equal(new[] { (1, 3) }.Concat(Enumerable.Range(1, 8).Select(e => (2, e))), f.Arr.MonitoredEpisodes(seriesId));
    }

    [Fact]
    public async Task SwitchingASeriesOnNeverRevertsAConcurrentSeasonChange()
    {
        using var f = new Fixture();
        var series = f.Arr.SeedSeries(391153, monitored: false, s => s == 1, (s, e) => s == 1 && e <= 4);
        var seriesId = (int)series["id"]!;
        // Seerr / an admin monitors S2 after JE read the series but before JE's first write lands.
        var raced = false;
        f.Arr.Override = (service, request) =>
        {
            if (!raced && service == "sonarr" && request.Method == HttpMethod.Put)
            {
                raced = true;
                ((JsonArray)f.Arr.SeriesById(seriesId)["seasons"]!).OfType<JsonObject>().Single(s => (int)s["seasonNumber"]! == 2)["monitored"] = true;
                foreach (var episode in f.Arr.Episodes.Where(e => (int)e["seriesId"]! == seriesId && (int)e["seasonNumber"]! == 2))
                {
                    episode["monitored"] = true;
                }
            }

            return null;
        };
        var result = Ok(await f.Add("{\"mediaType\":\"tv\",\"instance\":0,\"tmdbId\":110492,\"scope\":\"episodes\",\"seasonNumber\":1,\"episodes\":[{\"s\":1,\"e\":6}],\"qualityProfileId\":4,\"rootFolderPath\":\"/tv\"}"));

        Assert.True(raced);
        Assert.Equal("monitoring_added", result.Result);
        Assert.DoesNotContain(f.Arr.Writes("sonarr"), w => w.Path == $"/api/v3/series/{seriesId}");
        var monitored = f.Arr.MonitoredEpisodes(seriesId);
        Assert.Equal(Enumerable.Range(1, 8).Select(e => (2, e)), monitored.Where(m => m.Season == 2));
        Assert.Equal(new[] { 1, 2, 3, 4, 6 }, monitored.Where(m => m.Season == 1).Select(m => m.Episode));
    }

    [Fact]
    public async Task MonitoringASeasonNeverRevertsAConcurrentEditToAnotherSeason()
    {
        using var f = new Fixture();
        var series = f.Arr.SeedSeries(391153, monitored: false, s => false, (s, e) => false);
        var seriesId = (int)series["id"]!;
        // Seerr / an admin monitors S1 (flag + episodes) after JE read the series but before JE's first write lands.
        var raced = false;
        f.Arr.Override = (service, request) =>
        {
            if (!raced && service == "sonarr" && request.Method != HttpMethod.Get)
            {
                raced = true;
                ((JsonArray)f.Arr.SeriesById(seriesId)["seasons"]!).OfType<JsonObject>().Single(s => (int)s["seasonNumber"]! == 1)["monitored"] = true;
                foreach (var episode in f.Arr.Episodes.Where(e => (int)e["seriesId"]! == seriesId && (int)e["seasonNumber"]! == 1))
                {
                    episode["monitored"] = true;
                }
            }

            return null;
        };
        var result = Ok(await f.Add("{\"mediaType\":\"tv\",\"instance\":0,\"tmdbId\":110492,\"scope\":\"season\",\"seasonNumber\":2,\"qualityProfileId\":4,\"rootFolderPath\":\"/tv\"}"));

        Assert.True(raced);
        Assert.Equal("monitoring_added", result.Result);
        Assert.Equal(new[] { (0, false), (1, true), (2, true) }, ((JsonArray)f.Arr.SeriesById(seriesId)["seasons"]!).Select(s => ((int)s!["seasonNumber"]!, (bool)s["monitored"]!)));
        Assert.Equal(Enumerable.Range(1, 8).Select(e => (1, e)).Concat(Enumerable.Range(1, 8).Select(e => (2, e))), f.Arr.MonitoredEpisodes(seriesId));
        Assert.True((bool)f.Arr.SeriesById(seriesId)["monitored"]!);
    }

    private sealed class RecordingFactory(IHttpClientFactory inner) : IHttpClientFactory
    {
        public List<string> Names { get; } = new();

        public HttpClient CreateClient(string name)
        {
            lock (Names)
            {
                Names.Add(name);
            }

            return inner.CreateClient(name);
        }
    }

    [Fact]
    public async Task ArrCallsUseTheNoRedirectClient()
    {
        RecordingFactory? recording = null;
        using var f = new Fixture(factory: arr => recording = new RecordingFactory(arr.Transport));
        Ok(await f.Add(MovieBody));
        await f.Service.GetOptionsAsync(null, CancellationToken.None);
        await f.Service.LookupAsync("tv", "peace", null, CancellationToken.None);

        Assert.NotEmpty(recording!.Names);
        Assert.All(recording.Names, n => Assert.Equal(Jellyfin.Plugin.JellyfinEnhanced.Helpers.Jellyseerr.SeerrHttpHelper.NamedClient, n));
    }

    [Theory]
    [InlineData(301)]
    [InlineData(302)]
    [InlineData(307)]
    [InlineData(308)]
    public async Task ARedirectAnswerIsAClearErrorNotASuccess(int status)
    {
        using var f = new Fixture();
        f.Arr.Override = (_, request) => request.Method == HttpMethod.Post
            ? new HttpResponseMessage((HttpStatusCode)status) { Headers = { Location = new Uri("https://radarr.example.com/api/v3/movie") } }
            : null;
        var error = Error(await f.Add(MovieBody), 502, "arr_redirect");
        Assert.Contains("final address", error.Message, StringComparison.Ordinal);
        Assert.Empty(f.Arr.Commands);

        f.Arr.Override = (_, request) => request.RequestUri!.AbsolutePath == "/api/v3/qualityprofile"
            ? new HttpResponseMessage((HttpStatusCode)status) { Headers = { Location = new Uri("http://169.254.169.254/latest") } }
            : null;
        var options = Assert.IsType<ArrOptionsDto>((await f.Service.GetOptionsAsync("movie", CancellationToken.None)).Value);
        Assert.Equal("arr_redirect", Assert.Single(options.Radarr).Error);
    }

    [Fact]
    public async Task ARealRedirectIsNeverFollowedAndTheApiKeyStaysHome()
    {
        // Real sockets + the plugin's own HttpClient registrations: the default client would replay the POST as a GET
        // to the redirect target (carrying X-Api-Key) and read the target's 200 array as the "added" movie.
        int port;
        using (var probe = new System.Net.Sockets.TcpListener(IPAddress.Loopback, 0))
        {
            probe.Start();
            port = ((IPEndPoint)probe.LocalEndpoint).Port;
            probe.Stop();
        }

        using var listener = new HttpListener();
        listener.Prefixes.Add($"http://127.0.0.1:{port}/");
        listener.Start();
        var hits = new List<string>();
        var server = Task.Run(async () =>
        {
            while (listener.IsListening)
            {
                HttpListenerContext context;
                try
                {
                    context = await listener.GetContextAsync();
                }
                catch (Exception ex) when (ex is HttpListenerException or ObjectDisposedException or InvalidOperationException)
                {
                    return;
                }

                var path = context.Request.Url!.AbsolutePath;
                lock (hits)
                {
                    hits.Add(context.Request.HttpMethod + " " + path + " " + context.Request.Headers["X-Api-Key"]);
                }

                string body;
                if (path == "/api/v3/movie/lookup")
                {
                    body = new JsonArray(FakeArr.Movie(49521, "Man of Steel", 2013)).ToJsonString();
                }
                else if (path == "/api/v3/movie")
                {
                    context.Response.StatusCode = 301;
                    context.Response.RedirectLocation = $"http://127.0.0.1:{port}/elsewhere/movie";
                    body = string.Empty;
                }
                else
                {
                    body = "[]";
                }

                var bytes = System.Text.Encoding.UTF8.GetBytes(body);
                context.Response.ContentType = "application/json";
                await context.Response.OutputStream.WriteAsync(bytes);
                context.Response.Close();
            }
        });

        var services = new Microsoft.Extensions.DependencyInjection.ServiceCollection();
        new Jellyfin.Plugin.JellyfinEnhanced.PluginServiceRegistrator().RegisterServices(services, Moq.Mock.Of<MediaBrowser.Controller.IServerApplicationHost>());
        using var provider = Microsoft.Extensions.DependencyInjection.ServiceCollectionContainerBuilderExtensions.BuildServiceProvider(services);
        var factory = (IHttpClientFactory)provider.GetService(typeof(IHttpClientFactory))!;
        using var f = new Fixture(factory: _ => factory);
        JellyfinEnhancedConfig(f).RadarrInstances = $"[{{\"Name\":\"Movies\",\"Url\":\"http://127.0.0.1:{port}\",\"ApiKey\":\"real-key\",\"Enabled\":true}}]";

        Error(await f.Add(MovieBody), 502, "arr_redirect");
        listener.Stop();
        await server;

        Assert.Equal(new[] { "GET /api/v3/movie/lookup real-key", "POST /api/v3/movie real-key" }, hits);
    }

    [Fact]
    public async Task ASuccessStatusWithAnArrayInsteadOfTheCreatedObjectIsAnInvalidResponse()
    {
        using var f = new Fixture();
        f.Arr.Override = (_, request) => request.Method == HttpMethod.Post ? IntegrationTransport.Response("[{\"id\":1}]", 200) : null;
        Error(await f.Add(MovieBody), 502, "arr_invalid_response");
        Error(await f.Add("{\"mediaType\":\"tv\",\"instance\":0,\"tmdbId\":110492,\"scope\":\"episodes\",\"seasonNumber\":1,\"episodes\":[{\"s\":1,\"e\":1}],\"qualityProfileId\":4,\"rootFolderPath\":\"/tv\"}"), 502, "arr_invalid_response");
    }

    [Fact]
    public async Task InstancesCarryAStableKeyThatAddsCanPin()
    {
        using var f = new Fixture();
        // Two blank-named Radarr instances both show as "Radarr": only the key tells them apart.
        JellyfinEnhancedConfig(f).RadarrInstances = $"[{{\"Name\":\"\",\"Url\":\"http://127.0.0.1:1\",\"ApiKey\":\"x\",\"Enabled\":true}},{{\"Name\":\" \",\"Url\":\"{FakeArr.RadarrUrl}/\",\"ApiKey\":\"{FakeArr.RadarrKey}\",\"Enabled\":true}}]";
        var options = Assert.IsType<ArrOptionsDto>((await f.Service.GetOptionsAsync("movie", CancellationToken.None)).Value);
        Assert.Equal(new[] { "Radarr", "Radarr" }, options.Radarr.Select(i => i.Name));
        Assert.All(options.Radarr, i => Assert.Matches("^[0-9a-f]{16}$", i.Key));
        Assert.NotEqual(options.Radarr[0].Key, options.Radarr[1].Key);
        var again = Assert.IsType<ArrOptionsDto>((await f.Service.GetOptionsAsync(null, CancellationToken.None)).Value);
        Assert.Equal(options.Radarr.Select(i => i.Key), again.Radarr.Select(i => i.Key));
        Assert.NotEqual(again.Radarr[1].Key, Assert.Single(again.Sonarr).Key);

        var body = MovieBody.Replace("\"instance\":0", "\"instance\":1,\"instanceName\":\"Radarr\",\"instanceKey\":\"" + options.Radarr[0].Key + "\"", StringComparison.Ordinal);
        Error(await f.Add(body), 409, "instance_changed");
        Error(await f.Add(MovieBody.Replace("\"instance\":0", "\"instance\":1,\"instanceKey\":\"NOT-HEX\"", StringComparison.Ordinal)), 400, "invalid_body");
        Assert.Empty(f.Arr.Writes("radarr"));
        Ok(await f.Add(MovieBody.Replace("\"instance\":0", "\"instance\":1,\"instanceKey\":\"" + options.Radarr[1].Key + "\"", StringComparison.Ordinal)));
    }

    [Fact]
    public async Task ARadarrDuplicateValidationErrorMeansAlreadyInRadarr()
    {
        using var f = new Fixture();
        // Lookup still says "not added" (raced with another add), the POST answers MovieExistsValidator.
        f.Arr.Override = (service, request) => service == "radarr" && request.Method == HttpMethod.Post && request.RequestUri!.AbsolutePath == "/api/v3/movie"
            ? IntegrationTransport.Response("[{\"propertyName\":\"TmdbId\",\"errorMessage\":\"This movie has already been added\",\"errorCode\":\"MovieExistsValidator\"}]", 400)
            : null;
        var result = Ok(await f.Add(MovieBody));

        Assert.Equal("already_exists", result.Result);
        Assert.Equal("Man of Steel", result.Title);
    }

    [Fact]
    public async Task SonarrSeasonAddListsEverySeasonWithOnlyThatSeasonMonitored()
    {
        using var f = new Fixture();
        var result = Ok(await f.Add("{\"mediaType\":\"tv\",\"instance\":0,\"tmdbId\":110492,\"scope\":\"season\",\"seasonNumber\":2,\"qualityProfileId\":4,\"rootFolderPath\":\"/tv\",\"search\":true}"));

        Assert.Equal("added", result.Result);
        Assert.Equal("/series/peacemaker", result.ArrPath);
        var post = Assert.Single(f.Arr.Writes("sonarr"));
        Assert.Equal("/api/v3/series", post.Path);
        Assert.Equal(FakeArr.SonarrKey, post.ApiKey);
        var body = post.Json;
        Assert.Equal("Peacemaker", (string)body["title"]!);
        Assert.Equal(391153, (int)body["tvdbId"]!);
        Assert.Equal("none", (string)body["monitorNewItems"]!);
        Assert.True((bool)body["monitored"]!);
        Assert.True((bool)body["seasonFolder"]!);
        Assert.Equal("standard", (string)body["seriesType"]!);
        Assert.Equal(new[] { (0, false), (1, false), (2, true) }, ((JsonArray)body["seasons"]!).Select(s => ((int)s!["seasonNumber"]!, (bool)s["monitored"]!)));
        Assert.Null(body["addOptions"]!["monitor"]); // "all"/"none" would override the season flags
        Assert.True((bool)body["addOptions"]!["searchForMissingEpisodes"]!);
        Assert.Null(body["languageProfileId"]);
        Assert.Contains(f.Arr.Calls, c => c.Path == "/api/v3/series/lookup?term=tmdb%3A110492");

        var seriesId = result.ArrId!.Value;
        Assert.Equal(Enumerable.Range(1, 8).Select(e => (2, e)), f.Arr.MonitoredEpisodes(seriesId));
    }

    [Fact]
    public async Task SonarrWholeSeriesMonitorsEveryRegularSeasonAndNewOnes()
    {
        using var f = new Fixture();
        Ok(await f.Add("{\"mediaType\":\"tv\",\"instance\":0,\"tvdbId\":391153,\"scope\":\"series\",\"qualityProfileId\":4,\"rootFolderPath\":\"/tv\",\"seriesType\":\"anime\"}"));

        var body = Assert.Single(f.Arr.Writes("sonarr")).Json;
        Assert.Equal("all", (string)body["monitorNewItems"]!);
        Assert.Equal("anime", (string)body["seriesType"]!);
        Assert.False((bool)body["addOptions"]!["searchForMissingEpisodes"]!);
        Assert.Equal(new[] { (0, false), (1, true), (2, true) }, ((JsonArray)body["seasons"]!).Select(s => ((int)s!["seasonNumber"]!, (bool)s["monitored"]!)));
        Assert.Contains(f.Arr.Calls, c => c.Path == "/api/v3/series/lookup?term=tvdb%3A391153");
    }

    [Fact]
    public async Task SonarrEpisodesOnANewSeriesAddUnmonitoredThenMonitorTheEpisodesOnceTheyExist()
    {
        using var f = new Fixture();
        f.Arr.EpisodePollsBeforeVisible = 2;
        var result = Ok(await f.Add("{\"requestId\":\"ep-1\",\"mediaType\":\"tv\",\"instance\":0,\"tmdbId\":110492,\"scope\":\"episodes\",\"seasonNumber\":1,\"episodes\":[{\"s\":1,\"e\":3},{\"s\":1,\"e\":5},{\"s\":1,\"e\":3},{\"s\":1,\"e\":42}],\"qualityProfileId\":4,\"rootFolderPath\":\"/tv\",\"search\":true}"));

        Assert.Equal("added", result.Result);
        Assert.Equal(2, result.MonitoredEpisodes);
        Assert.Equal(new[] { (1, 42) }, result.MissingEpisodes!.Select(e => (e.S, e.E)));
        Assert.True(result.Searched);

        var writes = f.Arr.Writes("sonarr");
        var post = writes[0].Json;
        Assert.All((JsonArray)post["seasons"]!, s => Assert.False((bool)s!["monitored"]!));
        Assert.Equal(3, ((JsonArray)post["seasons"]!).Count);
        Assert.Equal("none", (string)post["monitorNewItems"]!);
        Assert.False((bool)post["addOptions"]!["searchForMissingEpisodes"]!);
        Assert.Equal("/api/v3/episode/monitor", writes[1].Path);
        Assert.Equal("PUT", writes[1].Method);
        Assert.True((bool)writes[1].Json["monitored"]!);
        Assert.Equal("/api/v3/command", writes[2].Path);
        Assert.Equal("EpisodeSearch", (string)writes[2].Json["name"]!);
        Assert.Equal(((JsonArray)writes[1].Json["episodeIds"]!).Select(n => (int)n!), ((JsonArray)writes[2].Json["episodeIds"]!).Select(n => (int)n!));
        Assert.Equal(new[] { (1, 3), (1, 5) }, f.Arr.MonitoredEpisodes(result.ArrId!.Value));
        // It polled until the async refresh had created the episodes.
        Assert.True(f.Arr.Calls.Count(c => c.Path.StartsWith("/api/v3/episode?", StringComparison.Ordinal)) >= 3);
    }

    [Fact]
    public async Task NewSeriesEpisodesAreMonitoredOnlyAfterSonarrsPostAddStep()
    {
        // Review round 7: Sonarr's post-add step (after its refresh) switches off the episodes of unmonitored seasons;
        // a PUT /episode/monitor sent as soon as the episodes exist is undone by it.
        using var f = new Fixture();
        f.Arr.PostAddReadsBeforeSettled = 2;
        var result = Ok(await f.Add("{\"mediaType\":\"tv\",\"instance\":0,\"tmdbId\":110492,\"scope\":\"episodes\",\"seasonNumber\":1,\"episodes\":[{\"s\":1,\"e\":8},{\"s\":1,\"e\":2}],\"qualityProfileId\":4,\"rootFolderPath\":\"/tv\"}"));

        Assert.Equal("added", result.Result);
        Assert.Equal(2, result.MonitoredEpisodes);
        f.Arr.RunPostAdds();
        Assert.Equal(new[] { (1, 2), (1, 8) }, f.Arr.MonitoredEpisodes(result.ArrId!.Value));
        Assert.Null(f.Arr.SeriesById(result.ArrId.Value)["addOptions"]);
    }

    [Fact]
    public async Task ANewSeriesWhosePostAddStepNeverFinishesIsAPartialAdd()
    {
        using var f = new Fixture();
        f.Arr.PostAddReadsBeforeSettled = 1_000_000;
        f.Service.EpisodePollBudget = TimeSpan.FromMilliseconds(30);
        Error(await f.Add("{\"mediaType\":\"tv\",\"instance\":0,\"tmdbId\":110492,\"scope\":\"episodes\",\"seasonNumber\":1,\"episodes\":[{\"s\":1,\"e\":2}],\"qualityProfileId\":4,\"rootFolderPath\":\"/tv\"}"), 502, "partial_add");
        Assert.Equal(new[] { "POST /api/v3/series" }, f.Arr.Writes("sonarr").Select(w => w.Method + " " + w.Path));
    }

    [Fact]
    public async Task AnExistingSeriesAddedMomentsAgoIsFlaggedAfterSonarrsPostAddStep()
    {
        // Added by someone else just before (the SeriesExistsValidator path lands here too): wait for the post-add step.
        using var f = new Fixture();
        var series = f.Arr.SeedSeries(391153, monitored: true, s => false, (s, e) => false);
        var seriesId = (int)series["id"]!;
        f.Arr.PostAddReadsBeforeSettled = 3;
        f.Arr.MarkJustAdded(seriesId);
        var result = Ok(await f.Add("{\"mediaType\":\"tv\",\"instance\":0,\"tvdbId\":391153,\"scope\":\"episodes\",\"seasonNumber\":1,\"episodes\":[{\"s\":1,\"e\":2}],\"qualityProfileId\":4,\"rootFolderPath\":\"/tv\"}"));

        Assert.Equal("monitoring_added", result.Result);
        Assert.Equal(1, result.MonitoredEpisodes);
        f.Arr.RunPostAdds();
        Assert.Equal(new[] { (1, 2) }, f.Arr.MonitoredEpisodes(seriesId));
    }

    [Fact]
    public async Task ANewSeriesWhoseEpisodesNeverAppearInTimeIsAPartialAddNotACachedSuccess()
    {
        using var f = new Fixture();
        f.Arr.EpisodePollsBeforeVisible = 1_000_000;
        f.Service.EpisodePollBudget = TimeSpan.FromMilliseconds(30);
        const string body = "{\"requestId\":\"slow-ep\",\"mediaType\":\"tv\",\"instance\":0,\"tmdbId\":110492,\"scope\":\"episodes\",\"seasonNumber\":1,\"episodes\":[{\"s\":1,\"e\":3}],\"qualityProfileId\":4,\"rootFolderPath\":\"/tv\",\"search\":true}";

        var error = Error(await f.Add(body), 502, "partial_add");
        Assert.Contains("Finish it in TV", error.Message, StringComparison.Ordinal);
        Assert.Equal(new[] { "POST /api/v3/series" }, f.Arr.Writes("sonarr").Select(w => w.Method + " " + w.Path));
        Assert.True(f.Arr.Calls.Count(c => c.Path.StartsWith("/api/v3/episode?", StringComparison.Ordinal)) >= 2);

        // Sonarr finishes its refresh; the retry (same requestId) isn't replayed and monitors the episode.
        f.Arr.FinishRefreshes();
        var retry = Ok(await f.Add(body));
        Assert.Equal("monitoring_added", retry.Result);
        Assert.Equal(1, retry.MonitoredEpisodes);
        Assert.Equal(new[] { (1, 3) }, f.Arr.MonitoredEpisodes(retry.ArrId!.Value));
        Assert.Single(f.Arr.Writes("sonarr"), w => w.Method == "POST" && w.Path == "/api/v3/series");
    }

    [Fact]
    public async Task ExistingSeriesSeasonScopeMonitorsThatSeasonAndKeepsOtherEpisodeChoices()
    {
        using var f = new Fixture();
        var series = f.Arr.SeedSeries(391153, monitored: true, s => false, (s, e) => s == 1 && e == 3);
        var seriesId = (int)series["id"]!;
        var result = Ok(await f.Add("{\"mediaType\":\"tv\",\"instance\":0,\"tmdbId\":110492,\"scope\":\"season\",\"seasonNumber\":2,\"qualityProfileId\":4,\"rootFolderPath\":\"/tv\",\"search\":true}"));

        Assert.Equal("monitoring_added", result.Result);
        Assert.Equal(seriesId, result.ArrId);
        Assert.True(result.Searched);
        var writes = f.Arr.Writes("sonarr");
        Assert.DoesNotContain(writes, w => w.Path == "/api/v3/series" && w.Method == "POST");
        Assert.DoesNotContain(writes, w => w.Path == $"/api/v3/series/{seriesId}");
        Assert.Equal(new[] { "POST /api/v3/seasonpass", "PUT /api/v3/episode/monitor", "POST /api/v3/command" }, writes.Select(w => w.Method + " " + w.Path));
        Assert.Equal(new[] { (0, false), (1, false), (2, true) }, ((JsonArray)f.Arr.SeriesById(seriesId)["seasons"]!).Select(s => ((int)s!["seasonNumber"]!, (bool)s["monitored"]!)));
        var search = writes.Single(w => w.Path == "/api/v3/command").Json;
        Assert.Equal("SeasonSearch", (string)search["name"]!);
        Assert.Equal(seriesId, (int)search["seriesId"]!);
        Assert.Equal(2, (int)search["seasonNumber"]!);
        Assert.Equal(new[] { (1, 3) }.Concat(Enumerable.Range(1, 8).Select(e => (2, e))), f.Arr.MonitoredEpisodes(seriesId));

        var again = Ok(await f.Add("{\"mediaType\":\"tv\",\"instance\":0,\"tmdbId\":110492,\"scope\":\"season\",\"seasonNumber\":2,\"qualityProfileId\":4,\"rootFolderPath\":\"/tv\",\"search\":true}"));
        Assert.Equal("already_monitored", again.Result);
        Assert.False(again.Searched);
        Assert.Equal(3, f.Arr.Writes("sonarr").Count);
    }

    [Fact]
    public async Task ExistingSeriesEpisodesScopeMonitorsOnlyTheMissingFlags()
    {
        using var f = new Fixture();
        var series = f.Arr.SeedSeries(391153, monitored: true, s => false, (s, e) => s == 1 && e == 2);
        var seriesId = (int)series["id"]!;
        var result = Ok(await f.Add("{\"mediaType\":\"tv\",\"instance\":0,\"tvdbId\":391153,\"scope\":\"episodes\",\"seasonNumber\":1,\"episodes\":[{\"s\":1,\"e\":2},{\"s\":1,\"e\":3},{\"s\":1,\"e\":77}],\"qualityProfileId\":4,\"rootFolderPath\":\"/tv\"}"));

        Assert.Equal("monitoring_added", result.Result);
        Assert.Equal(1, result.MonitoredEpisodes);
        Assert.Equal(new[] { (1, 77) }, result.MissingEpisodes!.Select(e => (e.S, e.E)));
        var put = Assert.Single(f.Arr.Writes("sonarr"));
        Assert.Equal("/api/v3/episode/monitor", put.Path);
        Assert.Single((JsonArray)put.Json["episodeIds"]!);
        Assert.Equal(new[] { (1, 2), (1, 3) }, f.Arr.MonitoredEpisodes(seriesId));
        Assert.Contains(f.Arr.Calls, c => c.Path == $"/api/v3/episode?seriesId={seriesId}&seasonNumber=1");

        var again = Ok(await f.Add("{\"mediaType\":\"tv\",\"instance\":0,\"tvdbId\":391153,\"scope\":\"episodes\",\"seasonNumber\":1,\"episodes\":[{\"s\":1,\"e\":2},{\"s\":1,\"e\":3}],\"qualityProfileId\":4,\"rootFolderPath\":\"/tv\",\"search\":true}"));
        Assert.Equal("already_monitored", again.Result);
        Assert.Equal(0, again.MonitoredEpisodes);
        Assert.Single(f.Arr.Writes("sonarr"));

        Error(await f.Add("{\"mediaType\":\"tv\",\"instance\":0,\"tvdbId\":391153,\"scope\":\"episodes\",\"seasonNumber\":1,\"episodes\":[{\"s\":1,\"e\":50}],\"qualityProfileId\":4,\"rootFolderPath\":\"/tv\"}"), 404, "episodes_not_found");
    }

    [Fact]
    public async Task AnUnmonitoredExistingSeriesIsSwitchedOnBeforeItsEpisodesAreFlagged()
    {
        using var f = new Fixture();
        var series = f.Arr.SeedSeries(391153, monitored: false, s => s == 1, (s, e) => s == 1);
        var seriesId = (int)series["id"]!;
        var result = Ok(await f.Add("{\"mediaType\":\"tv\",\"instance\":0,\"tmdbId\":110492,\"scope\":\"episodes\",\"seasonNumber\":2,\"episodes\":[{\"s\":2,\"e\":4}],\"qualityProfileId\":4,\"rootFolderPath\":\"/tv\"}"));

        Assert.Equal("monitoring_added", result.Result);
        var writes = f.Arr.Writes("sonarr");
        // The series editor switches only series.monitored on: no seasons are sent, so no episode flag can change.
        Assert.Equal(new[] { "PUT /api/v3/series/editor", "PUT /api/v3/episode/monitor" }, writes.Select(w => w.Method + " " + w.Path));
        Assert.Equal(new[] { "monitored", "seriesIds" }, writes[0].Json.Select(p => p.Key).OrderBy(k => k, StringComparer.Ordinal));
        Assert.True((bool)writes[0].Json["monitored"]!);
        Assert.Equal(new[] { seriesId }, ((JsonArray)writes[0].Json["seriesIds"]!).Select(n => (int)n!));
        Assert.Equal(Enumerable.Range(1, 8).Select(e => (1, e)).Append((2, 4)), f.Arr.MonitoredEpisodes(seriesId));
        Assert.True((bool)f.Arr.SeriesById(seriesId)["monitored"]!);
    }

    [Fact]
    public async Task WholeSeriesAlreadyInSonarrChangesNothing()
    {
        using var f = new Fixture();
        f.Arr.SeedSeries(391153, monitored: true, s => s > 0, (s, e) => s > 0);
        var result = Ok(await f.Add("{\"mediaType\":\"tv\",\"instance\":0,\"tmdbId\":110492,\"scope\":\"series\",\"qualityProfileId\":4,\"rootFolderPath\":\"/tv\",\"search\":true}"));

        Assert.Equal("already_exists", result.Result);
        Assert.True(result.Monitored);
        Assert.Empty(f.Arr.Writes("sonarr"));
    }

    [Fact]
    public async Task ASonarrDuplicateRaceFallsBackToMonitoringTheExistingSeries()
    {
        using var f = new Fixture();
        // First lookup: not added. The POST hits SeriesExistsValidator because the series appeared meanwhile.
        var lookups = 0;
        f.Arr.Override = (service, request) =>
        {
            if (service == "sonarr" && request.RequestUri!.AbsolutePath == "/api/v3/series/lookup" && lookups++ == 0)
            {
                return IntegrationTransport.Response(new JsonArray(f.Arr.SonarrCatalog[0].DeepClone()).ToJsonString());
            }

            return null;
        };
        f.Arr.SeedSeries(391153, monitored: true, s => s == 1, (s, e) => s == 1);
        var result = Ok(await f.Add("{\"mediaType\":\"tv\",\"instance\":0,\"tmdbId\":110492,\"scope\":\"season\",\"seasonNumber\":2,\"qualityProfileId\":4,\"rootFolderPath\":\"/tv\"}"));

        Assert.Equal("monitoring_added", result.Result);
        var writes = f.Arr.Writes("sonarr");
        Assert.Equal(new[] { "POST /api/v3/series", "POST /api/v3/seasonpass", "PUT /api/v3/episode/monitor" }, writes.Select(w => w.Method + " " + w.Path));
    }

    [Fact]
    public async Task AnUnknownSeasonIsRefusedBeforeAnythingIsAdded()
    {
        using var f = new Fixture();
        var error = Error(await f.Add("{\"mediaType\":\"tv\",\"instance\":0,\"tmdbId\":110492,\"scope\":\"season\",\"seasonNumber\":5,\"qualityProfileId\":4,\"rootFolderPath\":\"/tv\"}"), 404, "season_not_found");
        Assert.Contains("season 5 of Peacemaker", error.Message, StringComparison.Ordinal);
        Assert.Empty(f.Arr.Writes("sonarr"));
    }

    [Fact]
    public async Task ARetriedRequestIdReplaysTheFirstResultPerUser()
    {
        using var f = new Fixture();
        const string body = "{\"requestId\":\"same-1\",\"mediaType\":\"movie\",\"instance\":0,\"tmdbId\":49521,\"scope\":\"movie\",\"qualityProfileId\":4,\"rootFolderPath\":\"/movies\"}";
        var first = await f.Add(body);
        var replay = await f.Add(body);
        Assert.Equal(200, replay.StatusCode);
        Assert.NotNull(replay.RawJson);
        Assert.Equal("added", JsonNode.Parse(replay.RawJson!)!["result"]!.GetValue<string>());
        Assert.Single(f.Arr.Writes("radarr"));

        // Another admin with the same id is not replayed (their own add runs and finds it present).
        var other = Ok(await f.Add(body, user: "fedcba9876543210fedcba9876543210"));
        Assert.Equal("already_exists", other.Result);
        Assert.Equal("added", Ok(first).Result);
    }

    [Fact]
    public async Task ConcurrentAddsWithTheSameRequestIdAddOnce()
    {
        using var f = new Fixture();
        const string body = "{\"requestId\":\"dbl\",\"mediaType\":\"movie\",\"instance\":0,\"tmdbId\":49521,\"scope\":\"movie\",\"qualityProfileId\":4,\"rootFolderPath\":\"/movies\"}";
        var results = await Task.WhenAll(f.Add(body), f.Add(body), f.Add(body));
        Assert.All(results, r => Assert.Equal(200, r.StatusCode));
        Assert.Single(f.Arr.Writes("radarr"));
    }

    // R6-7: an add queued behind another add to the same instance runs on what is configured once the lock is free: the
    // feature turned off, the instance moved to another URL, or the caller no longer an admin stop it before any call.
    [Theory]
    [InlineData("disabled", 404, "disabled")]
    [InlineData("moved", 409, "instance_changed")]
    [InlineData("demoted", 403, "forbidden")]
    public async Task AnAddQueuedBehindAnotherRunsOnTheSettingsAfterTheWait(string change, int status, string code)
    {
        using var f = new Fixture();
        var holding = new TaskCompletionSource();
        var release = new TaskCompletionSource();
        f.Arr.Delay = async (_, request, _) =>
        {
            if (request.Method == HttpMethod.Post && holding.TrySetResult())
            {
                await release.Task;
            }
        };
        var admin = true;
        var first = f.Add(MovieBody);
        await holding.Task;
        var queued = f.Service.AddAsync(JsonSerializer.Deserialize<ArrAddRequest>(MovieBody.Replace("49521", "49522", StringComparison.Ordinal)), Admin, "admin", CancellationToken.None, () => admin);
        await Task.Delay(50);
        Assert.False(queued.IsCompleted);
        var config = f.Plugin.Plugin.Configuration;
        switch (change)
        {
            case "disabled":
                config.ListPlaceholdersArrEnabled = false;
                break;
            case "moved":
                config.RadarrInstances = config.RadarrInstances.Replace(FakeArr.RadarrUrl, "http://elsewhere.test", StringComparison.Ordinal);
                break;
            default:
                admin = false;
                break;
        }

        release.SetResult();
        Assert.Equal(200, (await first).StatusCode);
        Error(await queued, status, code);
        Assert.DoesNotContain(f.Arr.Calls, c => c.Path.Contains("49522", StringComparison.Ordinal));
        Assert.Single(f.Arr.Writes("radarr"));
    }

    [Theory]
    [InlineData("QualityProfileExistsValidator", 400, "invalid_quality_profile")]
    [InlineData("RootFolderExistsValidator", 400, "invalid_root_folder")]
    [InlineData("SomethingElseValidator", 400, "arr_rejected")]
    public async Task ValidationErrorsAreMapped(string code, int status, string expected)
    {
        using var f = new Fixture();
        f.Arr.Override = (service, request) => request.Method == HttpMethod.Post
            ? IntegrationTransport.Response("[{\"propertyName\":\"X\",\"errorMessage\":\"Field X is wrong\",\"errorCode\":\"" + code + "\"}]", 400)
            : null;
        var error = Error(await f.Add(MovieBody), status, expected);
        if (expected == "arr_rejected")
        {
            Assert.Equal("Movies refused: Field X is wrong", error.Message);
        }
    }

    [Fact]
    public async Task RealProfileAndFolderValidationComesFromTheArr()
    {
        using var f = new Fixture();
        Error(await f.Add(MovieBody.Replace("\"qualityProfileId\":4", "\"qualityProfileId\":99", StringComparison.Ordinal)), 400, "invalid_quality_profile");
        Error(await f.Add(MovieBody.Replace("/movies", "/nope", StringComparison.Ordinal)), 400, "invalid_root_folder");
    }

    [Fact]
    public async Task UpstreamFailuresNeverLeakBodiesOrPassThroughAuthStatuses()
    {
        using var f = new Fixture();
        const string trace = "at NzbDrone.Core.Something() in /src/Secret.cs:line 42";
        f.Arr.Override = (_, _) => IntegrationTransport.Response("{\"message\":\"boom\",\"description\":\"" + trace + "\"}", 500);
        var error = Error(await f.Add(MovieBody), 502, "arr_error");
        Assert.DoesNotContain("Secret.cs", error.Message, StringComparison.Ordinal);
        Assert.DoesNotContain("boom", error.Message, StringComparison.Ordinal);

        f.Arr.Override = (_, _) => IntegrationTransport.Response("{\"type\":\"x\",\"title\":\"One or more validation errors occurred.\",\"errors\":{\"$.x\":[\"" + trace + "\"]}}", 400);
        error = Error(await f.Add(MovieBody), 400, "arr_rejected");
        Assert.DoesNotContain("Secret.cs", error.Message, StringComparison.Ordinal);

        f.Arr.Override = (_, _) => IntegrationTransport.Response(string.Empty, 401);
        Error(await f.Add(MovieBody), 502, "arr_auth_failed");

        f.Arr.Override = (_, _) => IntegrationTransport.Response("not json", 200, "text/html");
        Error(await f.Add(MovieBody), 502, "arr_invalid_response");

        f.Arr.Override = (_, _) => throw new HttpRequestException("connection refused 127.0.0.1:7878");
        error = Error(await f.Add(MovieBody), 502, "arr_unreachable");
        Assert.DoesNotContain("127.0.0.1", error.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ASlowArrTimesOutWithA504()
    {
        // The arr never answers and only stops when the call's token is cancelled: the 504 must come from the 50 ms
        // per-call limit, well before the whole-add budget would end it ("took too long").
        using var f = new Fixture(factory: _ => new IntegrationTransport(async (_, ct) =>
        {
            await Task.Delay(Timeout.Infinite, ct);
            return IntegrationTransport.Response();
        }));
        f.Service.CallTimeout = TimeSpan.FromMilliseconds(50);
        f.Service.AddBudget = TimeSpan.FromSeconds(5);
        var clock = System.Diagnostics.Stopwatch.StartNew();
        var error = Error(await f.Add(MovieBody), 504, "arr_timeout");
        clock.Stop();
        Assert.Contains("didn't answer in time", error.Message, StringComparison.Ordinal);
        Assert.True(clock.Elapsed < TimeSpan.FromSeconds(3), $"took {clock.Elapsed}");
    }

    [Fact]
    public async Task AWrongApiKeyIsReportedPerInstanceInOptions()
    {
        using var f = new Fixture();
        JellyfinEnhancedConfig(f).SonarrInstances = $"[{{\"Name\":\"TV\",\"Url\":\"{FakeArr.SonarrUrl}\",\"ApiKey\":\"wrong\",\"Enabled\":true}}]";
        var outcome = await f.Service.GetOptionsAsync(null, CancellationToken.None);
        var options = Assert.IsType<ArrOptionsDto>(outcome.Value);

        var radarr = Assert.Single(options.Radarr);
        Assert.Equal(0, radarr.Id);
        Assert.Equal("Movies", radarr.Name);
        Assert.Null(radarr.Error);
        Assert.Equal(new[] { (1, "Any"), (4, "HD-1080p") }, radarr.QualityProfiles.Select(p => (p.Id, p.Name)));
        var folder = Assert.Single(radarr.RootFolders);
        Assert.Equal("/movies", folder.Path);
        Assert.Equal(5_000_000_000_000L, folder.FreeSpace);
        var sonarr = Assert.Single(options.Sonarr);
        Assert.Equal("arr_auth_failed", sonarr.Error);
        Assert.Empty(sonarr.QualityProfiles);
        Assert.DoesNotContain("wrong", sonarr.Message!, StringComparison.Ordinal);
        Assert.Equal(new[] { "announced", "inCinemas", "released" }, options.MinimumAvailability);
        Assert.Equal(new[] { "standard", "daily", "anime" }, options.SeriesTypes);

        var movieOnly = Assert.IsType<ArrOptionsDto>((await f.Service.GetOptionsAsync("movie", CancellationToken.None)).Value);
        Assert.Empty(movieOnly.Sonarr);
        Error(await f.Service.GetOptionsAsync("music", CancellationToken.None), 400, "invalid_body");
    }

    [Fact]
    public async Task NothingConfiguredIsA404PerService()
    {
        using var f = new Fixture(radarr: false);
        Error(await f.Service.GetOptionsAsync("movie", CancellationToken.None), 404, "not_configured");
        Error(await f.Add(MovieBody), 404, "not_configured");
        Error(await f.Service.LookupAsync("movie", "matrix", null, CancellationToken.None), 404, "not_configured");
        Assert.Equal(200, (await f.Service.GetOptionsAsync(null, CancellationToken.None)).StatusCode);
        Assert.DoesNotContain(f.Arr.Calls, c => c.Service == "radarr");

        JellyfinEnhancedConfig(f).SonarrInstances = "[{\"Name\":\"TV\",\"Url\":\"http://127.0.0.1:8989\",\"ApiKey\":\"\",\"Enabled\":true}]";
        Error(await f.Service.GetOptionsAsync(null, CancellationToken.None), 404, "not_configured");
    }

    [Fact]
    public async Task InstanceIdsAndNamesAreChecked()
    {
        using var f = new Fixture();
        Error(await f.Add(MovieBody.Replace("\"instance\":0", "\"instance\":1", StringComparison.Ordinal)), 400, "invalid_instance");
        Error(await f.Add(MovieBody.Replace("\"instance\":0", "\"instance\":0,\"instanceName\":\"Radarr 4K\"", StringComparison.Ordinal)), 409, "instance_changed");
        Ok(await f.Add(MovieBody.Replace("\"instance\":0", "\"instance\":0,\"instanceName\":\"Movies\"", StringComparison.Ordinal)));
    }

    [Theory]
    [InlineData("{}")]
    [InlineData("{\"mediaType\":\"music\",\"instance\":0,\"tmdbId\":1,\"scope\":\"movie\",\"qualityProfileId\":4,\"rootFolderPath\":\"/m\"}")]
    [InlineData("{\"mediaType\":\"movie\",\"tmdbId\":1,\"scope\":\"movie\",\"qualityProfileId\":4,\"rootFolderPath\":\"/m\"}")]
    [InlineData("{\"mediaType\":\"movie\",\"instance\":0,\"scope\":\"movie\",\"qualityProfileId\":4,\"rootFolderPath\":\"/m\"}")]
    [InlineData("{\"mediaType\":\"movie\",\"instance\":0,\"tmdbId\":-3,\"scope\":\"movie\",\"qualityProfileId\":4,\"rootFolderPath\":\"/m\"}")]
    [InlineData("{\"mediaType\":\"movie\",\"instance\":0,\"tmdbId\":1,\"tvdbId\":2,\"scope\":\"movie\",\"qualityProfileId\":4,\"rootFolderPath\":\"/m\"}")]
    [InlineData("{\"mediaType\":\"movie\",\"instance\":0,\"imdbId\":\"nm123\",\"scope\":\"movie\",\"qualityProfileId\":4,\"rootFolderPath\":\"/m\"}")]
    [InlineData("{\"mediaType\":\"movie\",\"instance\":0,\"tmdbId\":1,\"scope\":\"series\",\"qualityProfileId\":4,\"rootFolderPath\":\"/m\"}")]
    [InlineData("{\"mediaType\":\"movie\",\"instance\":0,\"tmdbId\":1,\"scope\":\"movie\",\"qualityProfileId\":0,\"rootFolderPath\":\"/m\"}")]
    [InlineData("{\"mediaType\":\"movie\",\"instance\":0,\"tmdbId\":1,\"scope\":\"movie\",\"qualityProfileId\":4,\"rootFolderPath\":\" \"}")]
    [InlineData("{\"mediaType\":\"movie\",\"instance\":0,\"tmdbId\":1,\"scope\":\"movie\",\"qualityProfileId\":4,\"rootFolderPath\":\"/m\\u0000x\"}")]
    [InlineData("{\"mediaType\":\"movie\",\"instance\":0,\"tmdbId\":1,\"scope\":\"movie\",\"qualityProfileId\":4,\"rootFolderPath\":\"/m\",\"minimumAvailability\":\"deleted\"}")]
    [InlineData("{\"mediaType\":\"movie\",\"instance\":0,\"tmdbId\":1,\"scope\":\"movie\",\"qualityProfileId\":4,\"rootFolderPath\":\"/m\",\"seriesType\":\"anime\"}")]
    [InlineData("{\"mediaType\":\"movie\",\"instance\":0,\"tmdbId\":1,\"scope\":\"movie\",\"qualityProfileId\":4,\"rootFolderPath\":\"/m\",\"requestId\":\"bad id!\"}")]
    [InlineData("{\"mediaType\":\"tv\",\"instance\":0,\"tmdbId\":1,\"scope\":\"movie\",\"qualityProfileId\":4,\"rootFolderPath\":\"/t\"}")]
    [InlineData("{\"mediaType\":\"tv\",\"instance\":0,\"tmdbId\":1,\"scope\":\"season\",\"qualityProfileId\":4,\"rootFolderPath\":\"/t\"}")]
    [InlineData("{\"mediaType\":\"tv\",\"instance\":0,\"tmdbId\":1,\"scope\":\"season\",\"seasonNumber\":201,\"qualityProfileId\":4,\"rootFolderPath\":\"/t\"}")]
    [InlineData("{\"mediaType\":\"tv\",\"instance\":0,\"tmdbId\":1,\"scope\":\"series\",\"seasonNumber\":1,\"qualityProfileId\":4,\"rootFolderPath\":\"/t\"}")]
    [InlineData("{\"mediaType\":\"tv\",\"instance\":0,\"tmdbId\":1,\"scope\":\"episodes\",\"seasonNumber\":1,\"qualityProfileId\":4,\"rootFolderPath\":\"/t\"}")]
    [InlineData("{\"mediaType\":\"tv\",\"instance\":0,\"tmdbId\":1,\"scope\":\"episodes\",\"seasonNumber\":1,\"episodes\":[{\"s\":2,\"e\":1}],\"qualityProfileId\":4,\"rootFolderPath\":\"/t\"}")]
    [InlineData("{\"mediaType\":\"tv\",\"instance\":0,\"tmdbId\":1,\"scope\":\"season\",\"seasonNumber\":1,\"episodes\":[{\"s\":1,\"e\":1}],\"qualityProfileId\":4,\"rootFolderPath\":\"/t\"}")]
    [InlineData("{\"mediaType\":\"tv\",\"instance\":0,\"tmdbId\":1,\"scope\":\"series\",\"qualityProfileId\":4,\"rootFolderPath\":\"/t\",\"seriesType\":\"weekly\"}")]
    [InlineData("{\"mediaType\":\"tv\",\"instance\":0,\"tmdbId\":1,\"scope\":\"series\",\"qualityProfileId\":4,\"rootFolderPath\":\"/t\",\"minimumAvailability\":\"bogus\"}")]
    public async Task InvalidBodiesAreRefusedWithoutCallingTheArr(string json)
    {
        using var f = new Fixture();
        Error(await f.Add(json), 400, "invalid_body");
        Assert.Empty(f.Arr.Calls);
    }

    [Fact]
    public async Task TooManyEpisodesAreRefused()
    {
        using var f = new Fixture();
        var episodes = string.Join(",", Enumerable.Range(1, 101).Select(e => "{\"s\":1,\"e\":" + e + "}"));
        Error(await f.Add("{\"mediaType\":\"tv\",\"instance\":0,\"tmdbId\":1,\"scope\":\"episodes\",\"seasonNumber\":1,\"episodes\":[" + episodes + "],\"qualityProfileId\":4,\"rootFolderPath\":\"/t\"}"), 400, "invalid_body");
        Error(await f.Service.AddAsync(null, Admin, "admin", CancellationToken.None), 400, "invalid_body");
    }

    [Fact]
    public async Task LookupMapsToThePlaceholderCandidateShape()
    {
        using var f = new Fixture();
        f.Arr.RadarrCatalog.Add(new JsonObject { ["title"] = "Man of Steel (no TMDB id)", ["year"] = 2000 });
        f.Arr.RadarrCatalog.Add(new JsonObject
        {
            ["title"] = "Man of Steel 2 \u0007",
            ["tmdbId"] = 1,
            ["year"] = 0,
            ["imdbId"] = "bogus",
            ["remotePoster"] = "javascript:alert(1)",
            ["overview"] = new string('x', 1500),
            ["status"] = "<b>bad</b>",
        });
        Ok(await f.Add(MovieBody));

        var movies = Assert.IsType<ArrLookupResultDto>((await f.Service.LookupAsync("movie", "Man of Steel", null, CancellationToken.None)).Value);
        Assert.Equal("radarr", movies.Instance.Service);
        Assert.Equal(2, movies.Results.Count);
        var mos = movies.Results[0];
        Assert.Equal(("movie", 49521, "tt0770828", "Man of Steel", 2013), (mos.MediaType, mos.TmdbId!.Value, mos.ImdbId, mos.Title, mos.Year!.Value));
        Assert.Equal("2013-06-12", mos.ReleaseDate);
        Assert.Equal("/poster49521.jpg", mos.PosterPath);
        Assert.Equal("https://image.tmdb.org/t/p/original/poster49521.jpg", mos.PosterUrl);
        Assert.True(mos.InArr);
        Assert.True(mos.ArrId > 0);
        Assert.True(mos.Monitored);
        Assert.Equal("released", mos.Status);
        var odd = movies.Results[1];
        Assert.Equal("Man of Steel 2", odd.Title);
        Assert.Null(odd.Year);
        Assert.Null(odd.ImdbId);
        Assert.Null(odd.PosterUrl);
        Assert.Null(odd.PosterPath);
        Assert.Null(odd.Status);
        Assert.Equal(1000, odd.Overview!.Length);
        Assert.False(odd.InArr);
        Assert.Null(odd.Monitored);
        Assert.Contains(f.Arr.Calls, c => c.Path == "/api/v3/movie/lookup?term=Man%20of%20Steel");

        var shows = Assert.IsType<ArrLookupResultDto>((await f.Service.LookupAsync("tv", "tmdb:110492", null, CancellationToken.None)).Value);
        var show = Assert.Single(shows.Results);
        Assert.Equal(("tv", 391153, 110492, "peacemaker", "standard"), (show.MediaType, show.TvdbId!.Value, show.TmdbId!.Value, show.TitleSlug, show.SeriesType));
        Assert.Equal("2022-01-13", show.ReleaseDate);
        Assert.Null(show.PosterPath); // TVDB artwork: display URL only
        Assert.StartsWith("https://artworks.thetvdb.com/", show.PosterUrl, StringComparison.Ordinal);
        Assert.Equal(new[] { 0, 1, 2 }, show.Seasons!.Select(s => s.SeasonNumber));
        Assert.False(show.InArr);
    }

    [Fact]
    public async Task LookupCapsResultsAndRefusesBadTerms()
    {
        using var f = new Fixture();
        for (var i = 0; i < 30; i++)
        {
            f.Arr.RadarrCatalog.Add(FakeArr.Movie(1000 + i, "Copy " + i, 2001));
        }

        var many = Assert.IsType<ArrLookupResultDto>((await f.Service.LookupAsync("movie", "copy", 0, CancellationToken.None)).Value);
        Assert.Equal(ListPlaceholderArrService.MaxLookupResults, many.Results.Count);
        Error(await f.Service.LookupAsync("movie", "x", 5, CancellationToken.None), 400, "invalid_instance");
        Error(await f.Service.LookupAsync("book", "x", null, CancellationToken.None), 400, "invalid_body");
        Error(await f.Service.LookupAsync("movie", "  ", null, CancellationToken.None), 400, "invalid_term");
        Error(await f.Service.LookupAsync("movie", "tmdb:abc", null, CancellationToken.None), 400, "invalid_term");
        Error(await f.Service.LookupAsync("movie", new string('a', 201), null, CancellationToken.None), 400, "invalid_term");
    }

    [Theory]
    [InlineData("movie", "tmdb:00123", "tmdb:123")]
    [InlineData("movie", "TMDB: 49521", "tmdb:49521")]
    [InlineData("movie", "imdb:TT0770828", "imdb:tt0770828")]
    [InlineData("tv", "tvdb:391153", "tvdb:391153")]
    [InlineData("tv", "  Mission: Impossible ", "Mission: Impossible")]
    [InlineData("movie", "Star Wars\u0000", "Star Wars")]
    public void TermsAreNormalized(string type, string term, string expected)
    {
        Assert.True(ListPlaceholderArrService.TryNormalizeTerm(term, type, out var normalized, out var error), error);
        Assert.Equal(expected, normalized);
    }

    [Theory]
    [InlineData("movie", "tvdb:1")]
    [InlineData("movie", "tmdb:0")]
    [InlineData("tv", "imdb:nm1")]
    [InlineData("tv", "tvdb:9999999999")]
    public void BadIdTermsAreRefused(string type, string term) =>
        Assert.False(ListPlaceholderArrService.TryNormalizeTerm(term, type, out _, out _));

    [Fact]
    public void TheFeatureNeedsBothSwitches()
    {
        Assert.False(ListPlaceholderArrService.IsEnabled(null));
        Assert.False(ListPlaceholderArrService.IsEnabled(new() { ListPlaceholdersEnabled = true }));
        Assert.False(ListPlaceholderArrService.IsEnabled(new() { ListPlaceholdersArrEnabled = true }));
        Assert.True(ListPlaceholderArrService.IsEnabled(new() { ListPlaceholdersEnabled = true, ListPlaceholdersArrEnabled = true }));
        Assert.False(new Jellyfin.Plugin.JellyfinEnhanced.Configuration.PluginConfiguration().ListPlaceholdersArrEnabled);
    }

    private static Jellyfin.Plugin.JellyfinEnhanced.Configuration.PluginConfiguration JellyfinEnhancedConfig(Fixture f) => f.Plugin.Plugin.Configuration;
}
