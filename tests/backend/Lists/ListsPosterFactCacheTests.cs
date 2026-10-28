using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists;
using Jellyfin.Plugin.JellyfinEnhanced.Services.ServerCache;

namespace JE.Tests;

/// <summary>List placeholders' validated TMDB poster facts in the server-side cache (namespace <c>tmdbposter</c>).</summary>
[Collection("Plugin singleton")]
public sealed class ListsPosterFactCacheTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "je-poster-facts-" + Guid.NewGuid().ToString("N"));
    private DateTime _now = DateTime.UtcNow;

    public void Dispose()
    {
        if (Directory.Exists(_root)) Directory.Delete(_root, true);
    }

    private string Folder => Path.Combine(_root, ServerBlobCache.DefaultFolderName, ListPosterFactCache.Namespace);

    private int Facts() => Directory.Exists(Folder) ? Directory.EnumerateFiles(Folder, "*.blob", SearchOption.AllDirectories).Count() : 0;

    private ServerBlobCache Disk() => new(() => new ServerCacheSettings(true, string.Empty, 0, 0), new ServerCacheLocation(_root, Array.Empty<string>()), null, () => _now)
    { SweepDebounce = TimeSpan.Zero };

    /// <summary>One process: a new metadata service over a new store on the shared folder.</summary>
    private ListMetadataService Process(ApiPluginFixture plugin, IntegrationTransport transport, ServerBlobCache? disk = null)
        => new(transport, plugin.Core.Logger, new ListPosterFactCache(disk ?? Disk(), () => _now));

    private static ApiPluginFixture Plugin()
    {
        var plugin = new ApiPluginFixture();
        plugin.Plugin.Configuration.TMDB_API_KEY = "test-tmdb";
        return plugin;
    }

    private static Placeholder Movie(int tmdb) => new() { Id = Guid.NewGuid().ToString("N"), Kind = PlaceholderKinds.Movie, MediaType = "movie", TmdbId = tmdb, Title = "Movie" };

    private static Placeholder Season(int tmdb, int season) => new() { Id = Guid.NewGuid().ToString("N"), Kind = PlaceholderKinds.Season, MediaType = "tv", TmdbId = tmdb, Title = "Show", SeasonNumber = season };

    /// <summary>TMDB by path: a body (status 200) or a status with TMDB's own error object.</summary>
    private static IntegrationTransport Tmdb(Dictionary<string, (int Status, string Body)> answers, List<string> sent)
        => new((request, _) =>
        {
            var path = request.RequestUri!.AbsolutePath["/3/".Length..];
            lock (sent) sent.Add(path);
            var (status, body) = answers.TryGetValue(path, out var a) ? a : (404, "{\"status_code\":34,\"status_message\":\"The resource you requested could not be found.\",\"success\":false}");
            return Task.FromResult(IntegrationTransport.Response(body, status));
        });

    private static string MovieBody(int id, string? poster) => "{\"id\":" + id + ",\"poster_path\":" + (poster == null ? "null" : "\"" + poster + "\"") + "}";

    private static string SeasonBody(int show, int season, string? poster)
        => "{\"id\":9" + season + ",\"season_number\":" + season + ",\"poster_path\":" + (poster == null ? "null" : "\"" + poster + "\"") + ",\"episodes\":[{\"show_id\":" + show + "}]}";

    [Fact]
    public async Task MovieShowAndSeasonPostersAreReadFromDiskAfterARestartWithNoTmdbRequest()
    {
        using var plugin = Plugin();
        var sent = new List<string>();
        using var network = Tmdb(new()
        {
            ["movie/10"] = (200, MovieBody(10, "/m.jpg")),
            ["tv/1412"] = (200, MovieBody(1412, "/show.jpg")),
            ["tv/1412/season/2"] = (200, SeasonBody(1412, 2, "/s2.jpg")),
        }, sent);
        var first = Process(plugin, network);
        Assert.Equal(("/m.jpg", true), await first.ReadTmdbPosterAsync(Movie(10), default));
        Assert.Equal(("/s2.jpg", true), await first.ReadTmdbPosterAsync(Season(1412, 2), default));
        Assert.Equal("/show.jpg", (await first.ReadTmdbPosterAsync(new Placeholder { Id = "x", Kind = PlaceholderKinds.Series, MediaType = "tv", TmdbId = 1412, Title = "Show" }, default)).Poster);
        await IntegrationTmdbDiskCacheTests.Until(() => Facts() == 3);
        Assert.Equal(3, sent.Count);

        var restarted = Process(plugin, network);
        Assert.Equal(("/m.jpg", true), await restarted.ReadTmdbPosterAsync(Movie(10), default));
        Assert.Equal(("/s2.jpg", true), await restarted.ReadTmdbPosterAsync(Season(1412, 2), default));
        Assert.Equal("/s2.jpg", await restarted.FetchTmdbPosterAsync(Season(1412, 2), default));
        Assert.Equal(3, sent.Count);
    }

    [Fact]
    public async Task ADiskHitTakesNoPosterSlot()
    {
        using var plugin = Plugin();
        var sent = new List<string>();
        using (var seed = Tmdb(new() { ["movie/10"] = (200, MovieBody(10, "/m.jpg")) }, sent))
        {
            await Process(plugin, seed).ReadTmdbPosterAsync(Movie(10), default);
            await IntegrationTmdbDiskCacheTests.Until(() => Facts() == 1);
        }

        // Every one of the four poster slots is held by a read TMDB never answers.
        var hang = new TaskCompletionSource<HttpResponseMessage>();
        using var hanging = new IntegrationTransport((_, ct) => hang.Task.WaitAsync(ct));
        var service = Process(plugin, hanging);
        using var cts = new CancellationTokenSource();
        var held = Enumerable.Range(20, 4).Select(i => service.ReadTmdbPosterAsync(Movie(i), cts.Token)).ToArray();
        await IntegrationTmdbDiskCacheTests.Until(() => hanging.Calls == 4);
        var saved = service.ReadTmdbPosterAsync(Movie(10), default);
        Assert.Same(saved, await Task.WhenAny(saved, Task.Delay(5000)));
        Assert.Equal(("/m.jpg", true), await saved);
        Assert.Equal(4, hanging.Calls);
        cts.Cancel();
        await Task.WhenAll(held.Select(t => t.ContinueWith(_ => { })));
    }

    [Fact]
    public async Task AVerifiedNoPosterIsSavedAndStillLeadsToTheShowsPoster()
    {
        using var plugin = Plugin();
        var sent = new List<string>();
        using var network = Tmdb(new()
        {
            ["tv/1412"] = (200, MovieBody(1412, "/show.jpg")),
            ["tv/1412/season/3"] = (200, SeasonBody(1412, 3, null)),
        }, sent);
        Assert.Equal(("/show.jpg", true), await Process(plugin, network).ReadTmdbPosterAsync(Season(1412, 3), default));
        await IntegrationTmdbDiskCacheTests.Until(() => Facts() == 2);
        Assert.Equal(("/show.jpg", true), await Process(plugin, network).ReadTmdbPosterAsync(Season(1412, 3), default));
        Assert.Equal(2, sent.Count);
    }

    [Theory]
    [InlineData(503, "{}")]
    [InlineData(429, "{}")]
    [InlineData(404, "<html>proxy</html>")]
    [InlineData(200, "{\"id\":91,\"season_number\":4,\"episodes\":[{\"show_id\":1412}]}")]
    [InlineData(200, "{\"id\":91,\"season_number\":5,\"poster_path\":\"/x.jpg\",\"episodes\":[{\"show_id\":1412}]}")]
    [InlineData(200, "{\"id\":91,\"season_number\":4,\"poster_path\":\"/x.jpg\",\"episodes\":[{\"show_id\":7}]}")]
    public async Task ATransientOrUnboundSeasonAnswerIsNeverSavedNorBorrowsTheShowsPoster(int status, string body)
    {
        using var plugin = Plugin();
        var sent = new List<string>();
        using var network = Tmdb(new()
        {
            ["tv/1412"] = (200, MovieBody(1412, "/show.jpg")),
            ["tv/1412/season/4"] = (status, body),
        }, sent);
        Assert.Equal(((string?)null, false), await Process(plugin, network).ReadTmdbPosterAsync(Season(1412, 4), default));
        await Task.Delay(150);
        Assert.Equal(0, Facts());
        Assert.DoesNotContain("tv/1412", sent);
        Assert.Equal(((string?)null, false), await Process(plugin, network).ReadTmdbPosterAsync(Season(1412, 4), default));
        Assert.Equal(2, sent.Count);
    }

    [Fact]
    public async Task ARealTmdbNotFoundIsNotSavedAndTheShowFallbackIsRecomputed()
    {
        using var plugin = Plugin();
        var sent = new List<string>();
        using var network = Tmdb(new() { ["tv/1412"] = (200, MovieBody(1412, "/show.jpg")) }, sent);
        Assert.Equal(("/show.jpg", true), await Process(plugin, network).ReadTmdbPosterAsync(Season(1412, 9), default));
        await IntegrationTmdbDiskCacheTests.Until(() => Facts() == 1); // the show only; the season's 404 isn't a fact
        Assert.Equal(("/show.jpg", true), await Process(plugin, network).ReadTmdbPosterAsync(Season(1412, 9), default));
        Assert.Equal(new[] { "tv/1412/season/9", "tv/1412", "tv/1412/season/9" }, sent);
    }

    [Fact]
    public async Task CredentialsAreSeparateAndTheReadTimeIsNeverRenewed()
    {
        using var plugin = Plugin();
        var sent = new List<string>();
        using var network = Tmdb(new() { ["movie/10"] = (200, MovieBody(10, "/m.jpg")) }, sent);
        await Process(plugin, network).ReadTmdbPosterAsync(Movie(10), default);
        await IntegrationTmdbDiskCacheTests.Until(() => Facts() == 1);
        plugin.Plugin.Configuration.TMDB_API_KEY = "other";
        await Process(plugin, network).ReadTmdbPosterAsync(Movie(10), default);
        Assert.Equal(2, sent.Count);
        plugin.Plugin.Configuration.TMDB_API_KEY = "test-tmdb";
        _now += TimeSpan.FromHours(11);
        await Process(plugin, network).ReadTmdbPosterAsync(Movie(10), default); // read back (and into memory) ...
        _now += TimeSpan.FromHours(1);
        await Process(plugin, network).ReadTmdbPosterAsync(Movie(10), default); // ... still 12 h from the first read
        Assert.Equal(3, sent.Count);
    }

    [Fact]
    public async Task AClearWhileThePosterReadIsUnderWayLeavesNothingBehind()
    {
        using var plugin = Plugin();
        var release = new TaskCompletionSource();
        using var network = new IntegrationTransport(async (_, ct) =>
        {
            await release.Task.WaitAsync(ct);
            return IntegrationTransport.Response(MovieBody(10, "/m.jpg"));
        });
        var disk = Disk();
        var service = Process(plugin, network, disk);
        var read = service.ReadTmdbPosterAsync(Movie(10), default);
        await IntegrationTmdbDiskCacheTests.Until(() => network.Calls == 1);
        await disk.ClearAsync(null, default);
        release.SetResult();
        Assert.Equal(("/m.jpg", true), await read);
        await Task.Delay(150);
        Assert.Equal(0, Facts());
    }

    [Fact]
    public async Task ARecordOfAnotherResourceIsRefused()
    {
        using var plugin = Plugin();
        var sent = new List<string>();
        using var network = Tmdb(new() { ["movie/10"] = (200, MovieBody(10, "/m.jpg")), ["movie/11"] = (200, MovieBody(11, "/n.jpg")) }, sent);
        await Process(plugin, network).ReadTmdbPosterAsync(Movie(10), default);
        await IntegrationTmdbDiskCacheTests.Until(() => Facts() == 1);
        var file = Directory.EnumerateFiles(Folder, "*.blob", SearchOption.AllDirectories).Single();
        var bytes = File.ReadAllBytes(file);
        var text = System.Text.Encoding.Latin1.GetString(bytes).Replace("\"id\":10,", "\"id\":11,", StringComparison.Ordinal);
        File.WriteAllBytes(file, System.Text.Encoding.Latin1.GetBytes(text));
        Assert.Equal(("/m.jpg", true), await Process(plugin, network).ReadTmdbPosterAsync(Movie(10), default));
        Assert.Equal(2, sent.Count);
    }
}
