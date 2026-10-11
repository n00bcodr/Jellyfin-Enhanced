using Jellyfin.Plugin.JellyfinEnhanced.Services.ListPlaceholders.Import;

namespace JE.Tests;

// SeerrImportLookup over HTTP (E3/E4): request shape, sanitized cache of NON-EMPTY results only, shared in-flight calls,
// per-instance cache keys, not-found vs transient.
[Collection("Plugin singleton")]
public class ListPlaceholdersImportLookupTests
{
    private sealed class Fixture : IDisposable
    {
        public ApiPluginFixture Plugin { get; } = new();
        public List<string> Calls { get; } = new();
        public Func<HttpRequestMessage, Task<HttpResponseMessage>> Reply { get; set; } = _ => Task.FromResult(IntegrationTransport.Response("{\"results\":[]}"));
        public IntegrationTransport Transport { get; }
        public SeerrImportLookup Lookup { get; }
        public ImportCallContext Context { get; } = new("test", false);

        public Fixture()
        {
            Plugin.Plugin.Configuration.JellyseerrEnabled = true;
            Plugin.Plugin.Configuration.JellyseerrUrls = "http://seerr.test";
            Plugin.Plugin.Configuration.JellyseerrApiKey = "import-key";
            Transport = new IntegrationTransport(async (request, _) =>
            {
                Assert.Equal("import-key", Assert.Single(request.Headers.GetValues("X-Api-Key")));
                Assert.False(request.Headers.Contains("X-Api-User"));
                lock (Calls)
                {
                    Calls.Add(request.RequestUri!.Host + request.RequestUri.PathAndQuery);
                }

                return await Reply(request);
            });
            Lookup = new SeerrImportLookup(Transport, new SeerrCallLimiter(4, TimeSpan.Zero, TimeProvider.System), Plugin.Core.Logger);
        }

        public void Dispose()
        {
            Transport.Dispose();
            Plugin.Dispose();
        }
    }

    private const string ManOfSteel = "{\"page\":1,\"results\":[{\"id\":49521,\"mediaType\":\"movie\",\"title\":\"Man of Steel\",\"originalTitle\":\"Man of Steel\",\"releaseDate\":\"2013-06-12\",\"posterPath\":\"/pgqgaUx1cJb5oYQQ5v0tNARCeBp.jpg\",\"overview\":\"A child is sent to Earth.\",\"popularity\":36.3,\"voteCount\":16680},"
        + "{\"id\":73968,\"mediaType\":\"person\",\"name\":\"Henry Cavill\"},"
        + "{\"id\":1,\"mediaType\":\"movie\",\"title\":\"Adult\",\"adult\":true},"
        + "{\"id\":2,\"mediaType\":\"tv\",\"name\":\"Bad poster\",\"firstAirDate\":\"\",\"posterPath\":\"https://evil.test/x.jpg\"}]}";

    [Fact]
    public async Task SearchesAreEncodedSanitizedAndOnlyNonEmptyResultsAreCached()
    {
        using var f = new Fixture();
        f.Reply = request => Task.FromResult(IntegrationTransport.Response(request.RequestUri!.Query.Contains("steel", StringComparison.Ordinal) ? ManOfSteel : "{\"results\":[]}"));

        var hits = await f.Lookup.SearchAsync("Man  of Steel", f.Context, CancellationToken.None);
        Assert.Equal(LookupStatus.Ok, hits.Status);
        Assert.Equal(2, hits.Value!.Count); // person and adult rows dropped
        var movie = hits.Value[0];
        Assert.Equal(("movie", 49521, "Man of Steel", 2013, "/pgqgaUx1cJb5oYQQ5v0tNARCeBp.jpg", 16680), (movie.MediaType, movie.TmdbId, movie.Title, movie.Year, movie.PosterPath, movie.VoteCount));
        Assert.Null(hits.Value[1].PosterPath); // not a TMDB path
        Assert.Null(hits.Value[1].ReleaseDate); // "" = undated

        await f.Lookup.SearchAsync("man of steel", f.Context, CancellationToken.None);
        Assert.Single(f.Calls); // normalized query, cached
        Assert.Equal("seerr.test/api/v1/search?query=man%20of%20steel&page=1", f.Calls[0]);

        await f.Lookup.SearchAsync("tmdb:1924", f.Context, CancellationToken.None);
        await f.Lookup.SearchAsync("tmdb:1924", f.Context, CancellationToken.None);
        Assert.Equal(new[] { "seerr.test/api/v1/search?query=tmdb%3A1924&page=1", "seerr.test/api/v1/search?query=tmdb%3A1924&page=1" }, f.Calls.Skip(1));
        Assert.Equal(3, f.Context.Calls); // empty results are never cached (Seerr hides TMDB errors as empty)
    }

    [Fact]
    public async Task ErrorsAreTransientAndNeverCachedWhileMissingSeasonsAreNotFound()
    {
        using var f = new Fixture();
        var fail = true;
        f.Reply = request =>
        {
            var path = request.RequestUri!.AbsolutePath;
            if (path.EndsWith("/season/9", StringComparison.Ordinal))
            {
                return Task.FromResult(IntegrationTransport.Response("{\"message\":\"Unable to retrieve season.\"}", 500));
            }

            if (path == "/api/v1/tv/110492")
            {
                return Task.FromResult(fail
                    ? IntegrationTransport.Response("{\"message\":\"Unable to retrieve series.\"}", 500)
                    : IntegrationTransport.Response("{\"id\":110492,\"name\":\"Peacemaker\",\"firstAirDate\":\"2022-01-13\",\"inProduction\":false,\"status\":\"Ended\",\"externalIds\":{\"imdbId\":\"tt13146488\",\"tvdbId\":391153},"
                        + "\"seasons\":[{\"seasonNumber\":0,\"episodeCount\":3,\"airDate\":\"2022-11-21\",\"name\":\"Specials\"},{\"seasonNumber\":1,\"episodeCount\":8,\"airDate\":\"2022-01-13\",\"name\":\"Season 1\"},{\"seasonNumber\":2,\"episodeCount\":1,\"airDate\":null,\"name\":\"Season 2\"}]}"));
            }

            if (path == "/api/v1/tv/110492/season/1")
            {
                return Task.FromResult(IntegrationTransport.Response("{\"episodes\":[{\"episodeNumber\":1,\"seasonNumber\":1,\"name\":\"A Whole New Whirled\",\"airDate\":\"2022-01-13\"}]}"));
            }

            return Task.FromResult(IntegrationTransport.Response("{\"message\":\"nope\"}", 404));
        };

        Assert.Equal(LookupStatus.Transient, (await f.Lookup.GetDetailsAsync("tv", 110492, f.Context, CancellationToken.None)).Status);
        fail = false;
        var details = await f.Lookup.GetDetailsAsync("tv", 110492, f.Context, CancellationToken.None);
        Assert.Equal(LookupStatus.Ok, details.Status);
        Assert.Equal(("tt13146488", 391153, false), (details.Value!.ImdbId, details.Value.TvdbId, details.Value.InProduction));
        Assert.Equal(new[] { 0, 1, 2 }, details.Value.Seasons.Select(s => s.SeasonNumber));
        Assert.Null(details.Value.Seasons[2].AirDate);
        await f.Lookup.GetDetailsAsync("tv", 110492, f.Context, CancellationToken.None);
        Assert.Equal(2, f.Calls.Count(c => c.EndsWith("/tv/110492", StringComparison.Ordinal))); // failure not cached, success cached

        // Seerr's season 500 also stands for a TMDB failure: retried, not a missing season (a 404 is).
        Assert.Equal(LookupStatus.Transient, (await f.Lookup.GetSeasonAsync(110492, 9, f.Context, CancellationToken.None)).Status);
        Assert.Equal(LookupStatus.NotFound, (await f.Lookup.GetSeasonAsync(110492, 7, f.Context, CancellationToken.None)).Status);
        var season = await f.Lookup.GetSeasonAsync(110492, 1, f.Context, CancellationToken.None);
        Assert.Equal(("A Whole New Whirled", "2022-01-13"), (season.Value![0].Title, season.Value[0].AirDate));
        Assert.Equal(LookupStatus.NotFound, (await f.Lookup.GetDetailsAsync("movie", 5, f.Context, CancellationToken.None)).Status);
        Assert.Equal(LookupStatus.NotFound, (await f.Lookup.GetDetailsAsync("person", 5, f.Context, CancellationToken.None)).Status);
    }

    [Fact]
    public async Task ConcurrentIdenticalLookupsShareOneCallAndAWaiterGivingUpDoesntCancelIt()
    {
        using var f = new Fixture();
        var release = new TaskCompletionSource();
        f.Reply = async _ =>
        {
            await release.Task;
            return IntegrationTransport.Response(ManOfSteel);
        };

        using var impatient = new CancellationTokenSource();
        var first = f.Lookup.SearchAsync("Man of Steel", f.Context, impatient.Token);
        var second = f.Lookup.SearchAsync("Man of Steel", new ImportCallContext("other", false), CancellationToken.None);
        impatient.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => first);
        release.SetResult();
        Assert.Equal(2, (await second).Value!.Count);
        Assert.Single(f.Calls);
        Assert.Equal(1, f.Context.Calls); // the caller that started it is charged
    }

    [Fact]
    public async Task ACacheIsPerSeerrInstance()
    {
        using var f = new Fixture();
        f.Reply = _ => Task.FromResult(IntegrationTransport.Response(ManOfSteel));
        await f.Lookup.SearchAsync("Man of Steel", f.Context, CancellationToken.None);
        f.Plugin.Plugin.Configuration.JellyseerrUrls = "http://seerr-b.test";
        await f.Lookup.SearchAsync("Man of Steel", f.Context, CancellationToken.None);
        Assert.Equal(new[] { "seerr.test", "seerr-b.test" }, f.Calls.Select(c => c.Split('/')[0]));

        f.Plugin.Plugin.Configuration.JellyseerrEnabled = false;
        Assert.False(f.Lookup.IsConfigured);
        Assert.Equal(LookupStatus.Transient, (await f.Lookup.SearchAsync("Man of Steel", f.Context, CancellationToken.None)).Status);
        Assert.False(f.Lookup.CanFindImdbEpisodes);
    }

    [Fact]
    public async Task AQueuedLookupIsDroppedWhenEveryWaiterGivesUpButAnAdmittedOneFinishesForTheCache()
    {
        using var f = new Fixture();
        var release = new TaskCompletionSource();
        f.Reply = async request =>
        {
            if (request.RequestUri!.Query.Contains("blocker", StringComparison.Ordinal))
            {
                await release.Task;
            }

            return IntegrationTransport.Response(ManOfSteel);
        };
        var lookup = new SeerrImportLookup(f.Transport, new SeerrCallLimiter(1, TimeSpan.Zero, TimeProvider.System), f.Plugin.Core.Logger);

        // The only slot: admitted, then its only waiter gives up — it still finishes and is cached.
        using var blockerWaiter = new CancellationTokenSource();
        var blocker = lookup.SearchAsync("blocker", f.Context, blockerWaiter.Token);
        for (var i = 0; i < 200 && !f.Calls.Any(c => c.Contains("blocker", StringComparison.Ordinal)); i++)
        {
            await Task.Delay(10);
        }

        // Two callers wait for the same queued lookup; both give up (aborted request / deadline).
        using var a = new CancellationTokenSource();
        using var b = new CancellationTokenSource();
        var first = lookup.SearchAsync("queued", f.Context, a.Token);
        var second = lookup.SearchAsync("queued", new ImportCallContext("other", false), b.Token);
        a.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => first);
        b.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => second);
        blockerWaiter.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => blocker);

        release.SetResult();
        await Task.Delay(200);
        Assert.DoesNotContain(f.Calls, c => c.Contains("queued", StringComparison.Ordinal)); // never sent
        Assert.Equal(LookupStatus.Ok, (await lookup.SearchAsync("blocker", f.Context, CancellationToken.None)).Status);
        Assert.Single(f.Calls, c => c.Contains("blocker", StringComparison.Ordinal)); // finished and cached

        // A later caller starts a fresh lookup.
        Assert.Equal(LookupStatus.Ok, (await lookup.SearchAsync("queued", f.Context, CancellationToken.None)).Status);
        Assert.Single(f.Calls, c => c.Contains("queued", StringComparison.Ordinal));
    }
}
