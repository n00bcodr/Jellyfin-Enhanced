using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Services.NativeDetails;
using Jellyfin.Plugin.JellyfinEnhanced.Services.ServerCache;

namespace JE.Tests;

/// <summary>The raw TMDB cache's disk tier (server-side cache namespace <c>tmdbjson</c>): memory, then disk, then TMDB.</summary>
[Collection("Plugin singleton")]
public sealed class IntegrationTmdbDiskCacheTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "je-tmdb-disk-" + Guid.NewGuid().ToString("N"));
    private readonly Clock _clock = new();
    private ServerCacheSettings _settings = new(true, string.Empty, 0, 0);

    public void Dispose()
    {
        if (Directory.Exists(_root)) Directory.Delete(_root, true);
    }

    internal sealed class Clock : TimeProvider
    {
        public DateTimeOffset Now = new(2026, 10, 27, 12, 0, 0, TimeSpan.Zero);
        public override DateTimeOffset GetUtcNow() => Now;
    }

    private ServerBlobCache Disk() => new(() => _settings, new ServerCacheLocation(_root, Array.Empty<string>()), null, () => _clock.Now.UtcDateTime) { SweepDebounce = TimeSpan.Zero };

    private TmdbResponseCache Cache(IntegrationTransport transport, ServerBlobCache? disk, ViewerMetadataAdmission? admission = null, string? legacy = null)
        => new(transport, _clock, admission, disk, legacy, null);

    private string Folder => Path.Combine(_root, ServerBlobCache.DefaultFolderName, TmdbResponseCache.DiskNamespace);

    private int Files() => Directory.Exists(Folder) ? Directory.EnumerateFiles(Folder, "*.blob", SearchOption.AllDirectories).Count() : 0;

    /// <summary>Disk writes are started after the answer: wait for them (bounded).</summary>
    internal static async Task Until(Func<bool> done)
    {
        for (var i = 0; i < 400 && !done(); i++) await Task.Delay(10);
        Assert.True(done());
    }

    private static IntegrationTransport Tmdb(Func<Uri, string>? body = null, Task? gate = null, int status = 200)
        => new(async (request, ct) =>
        {
            if (gate != null) await gate.WaitAsync(ct);
            var uri = request.RequestUri!;
            return IntegrationTransport.Response(body?.Invoke(uri) ?? JsonSerializer.Serialize(new { id = 1, path = uri.AbsolutePath }), status);
        });

    [Fact]
    public async Task ANewProcessReadsTheAnswerFromDiskWithNoTmdbRequestAndTheOriginalFetchTimeAndETag()
    {
        using var network = Tmdb();
        var first = await Cache(network, Disk()).GetAsync("movie/603", string.Empty, "key", default);
        Assert.Equal(1, network.Calls);
        await Until(() => Files() == 1);

        _clock.Now += TimeSpan.FromHours(1);
        var restarted = Cache(network, Disk());
        var again = await restarted.GetAsync("movie/603", string.Empty, "key", default);
        Assert.Equal(1, network.Calls);
        Assert.Equal(1, restarted.DiskHits);
        Assert.Equal(first.Content, again.Content);
        Assert.Equal(first.ETag, again.ETag);
        Assert.Equal(first.FetchedAtUtc, again.FetchedAtUtc); // a disk hit never renews the fetch time
    }

    [Fact]
    public async Task AnAnswerLeftOutOfTheMemoryCapIsStillReadFromDisk()
    {
        // ~2 MiB counted per entry: fifteen push the first out of the 24 MiB memory.
        var big = new string('x', 1024 * 1024);
        using var network = Tmdb(uri => JsonSerializer.Serialize(new { id = 1, path = uri.AbsolutePath, big }));
        var cache = Cache(network, Disk());
        for (var i = 1; i <= 15; i++) await cache.GetAsync("person/" + i, string.Empty, "key", default);
        await Until(() => Files() == 15);
        Assert.False(cache.TryGetCached("person/1", string.Empty, "key", out _));
        await cache.GetAsync("person/1", string.Empty, "key", default);
        Assert.Equal(15, network.Calls);
        Assert.Equal(1, cache.DiskHits);
    }

    [Fact]
    public async Task ADiskHitTakesNoAdmissionPlaceEvenWhenTheViewersPlacesAreFull()
    {
        using (var seed = Tmdb())
        {
            await Cache(seed, Disk()).GetAsync("movie/603", string.Empty, "key", default);
            await Until(() => Files() == 1);
        }

        var hang = new TaskCompletionSource();
        using var network = Tmdb(gate: hang.Task);
        var admission = new ViewerMetadataAdmission();
        var cache = Cache(network, Disk(), admission);
        var viewer = Guid.NewGuid();
        using var scope = ViewerMetadataAdmission.ForViewer(viewer);
        var held = Enumerable.Range(1, 8).Select(i => cache.GetAsync("movie/" + (900 + i), string.Empty, "key", default)).ToArray();
        await Until(() => admission.Count() == 8);
        // The viewer's eight places are taken: one more distinct read is refused locally ...
        Assert.True((await cache.GetAsync("movie/999", string.Empty, "key", default)).AdmissionBusy);
        // ... while the saved one answers from disk, with no place and no request.
        var saved = await cache.GetAsync("movie/603", string.Empty, "key", default);
        Assert.Equal(200, saved.StatusCode);
        Assert.Equal(1, cache.DiskHits);
        hang.SetResult();
        await Task.WhenAll(held);
        Assert.Equal(8, network.Calls);
    }

    [Fact]
    public async Task ConcurrentMissesOnAnEmptyDiskShareOneTmdbRequest()
    {
        var release = new TaskCompletionSource();
        using var network = Tmdb(gate: release.Task);
        var cache = Cache(network, Disk());
        var readers = Enumerable.Range(0, 12).Select(_ => cache.GetAsync("tv/1399/season/1", string.Empty, "key", default)).ToArray();
        await Until(() => network.Calls == 1);
        release.SetResult();
        await Task.WhenAll(readers);
        Assert.Equal(1, network.Calls);
    }

    [Theory]
    [InlineData("search/movie", "?query=secret%20title")]
    [InlineData("search/multi", "?query=x&include_adult=false")]
    [InlineData("movie/603", "?language=en-US&append_to_response=release_dates,keywords")]
    [InlineData("tv/1399", "?language=en-US&append_to_response=content_ratings")]
    public async Task FreeTextSearchesAndTheEvidenceQueryStayInMemoryOnly(string path, string query)
    {
        using var network = Tmdb();
        var cache = Cache(network, Disk());
        await cache.GetAsync(path, query, "key", default);
        await cache.GetAsync(path, query, "key", default);
        Assert.Equal(1, network.Calls); // memory still holds it
        await cache.GetAsync("movie/1", string.Empty, "key", default);
        await Until(() => Files() == 1); // only the lookup was saved
        await Cache(network, Disk()).GetAsync(path, query, "key", default);
        Assert.Equal(3, network.Calls);
    }

    [Theory]
    [InlineData("search/movie?query=x", false)]
    [InlineData("/search/movie?query=x", false)]
    [InlineData("search//movie?query=x", false)]
    [InlineData("SEARCH/company?query=x", false)]
    [InlineData("./search/movie?query=x", false)]
    [InlineData("movie/../search/movie?query=x", false)]
    [InlineData("search?query=x", false)]
    [InlineData("movie//603", false)]
    [InlineData("movie/603/", false)]
    [InlineData("movie/603%2F..", false)]
    [InlineData("movie/603", true)]
    [InlineData("tv/1399/season/1", true)]
    [InlineData("discover/movie?with_genres=18&page=1", true)]
    [InlineData("person/287/combined_credits", true)]
    public void OnlyACanonicalNonSearchRouteIsEverWrittenToDisk(string resource, bool durable)
        => Assert.Equal(durable, TmdbResponseCache.Durable("https://api.themoviedb.org/3/" + resource));

    [Fact]
    public async Task ExpiryTravelsWithTheRecordAndIsNeverExtended()
    {
        using var network = Tmdb();
        await Cache(network, Disk()).GetAsync("discover/movie", "?with_genres=18&page=1", "key", default);
        await Until(() => Files() == 1);
        _clock.Now += TimeSpan.FromMinutes(30) - TimeSpan.FromSeconds(1);
        await Cache(network, Disk()).GetAsync("discover/movie", "?with_genres=18&page=1", "key", default);
        Assert.Equal(1, network.Calls);
        _clock.Now += TimeSpan.FromSeconds(1); // a query answer's 30 minutes, from its fetch
        await Cache(network, Disk()).GetAsync("discover/movie", "?with_genres=18&page=1", "key", default);
        Assert.Equal(2, network.Calls);
    }

    [Fact]
    public async Task ANotFoundAnswerIsKeptTenMinutesAndFailuresNotAtAll()
    {
        using var missing = Tmdb(status: 404);
        await Cache(missing, Disk()).GetAsync("movie/7", string.Empty, "key", default);
        await Until(() => Files() == 1);
        using var failing = Tmdb(status: 503);
        await Cache(failing, Disk()).GetAsync("movie/8", string.Empty, "key", default);
        await Task.Delay(100);
        Assert.Equal(1, Files());
        _clock.Now += TimeSpan.FromMinutes(9);
        Assert.Equal(404, (await Cache(missing, Disk()).GetAsync("movie/7", string.Empty, "key", default)).StatusCode);
        Assert.Equal(1, missing.Calls);
        _clock.Now += TimeSpan.FromMinutes(1);
        await Cache(missing, Disk()).GetAsync("movie/7", string.Empty, "key", default);
        Assert.Equal(2, missing.Calls);
    }

    [Fact]
    public async Task CredentialsAndQueriesArePartitionedAndRefreshBypassesDisk()
    {
        using var network = Tmdb();
        await Cache(network, Disk()).GetAsync("movie/603", "?language=fr-FR", "key", default);
        await Until(() => Files() == 1);
        var restarted = Cache(network, Disk());
        await restarted.GetAsync("movie/603", "?language=fr-FR", "other", default);
        await restarted.GetAsync("movie/603", "?language=de-DE", "key", default);
        Assert.Equal(3, network.Calls);
        await Cache(network, Disk()).GetAsync("movie/603", "?language=fr-FR", "key", default, refresh: true);
        Assert.Equal(4, network.Calls);
        await Cache(network, Disk()).GetAsync("movie/603", "?language=fr-FR", "key", default);
        Assert.Equal(4, network.Calls);
    }

    [Fact]
    public async Task ForgetRemovesBothTiersAndADelayedFetchCannotPutItBack()
    {
        using var network = Tmdb();
        var cache = Cache(network, Disk());
        await cache.GetAsync("movie/603", string.Empty, "key", default);
        await Until(() => Files() == 1);
        cache.Forget("movie/603", string.Empty, "key");
        await Until(() => Files() == 0);

        // A read already under way when the answer is forgotten (a partial body, say) stores nothing.
        var release = new TaskCompletionSource();
        using var slow = Tmdb(gate: release.Task);
        var other = Cache(slow, Disk());
        var pending = other.GetAsync("movie/604", string.Empty, "key", default);
        await Until(() => slow.Calls == 1);
        other.Forget("movie/604", string.Empty, "key");
        release.SetResult();
        await pending;
        await Task.Delay(100);
        Assert.False(other.TryGetCached("movie/604", string.Empty, "key", out _));
        Assert.Equal(0, Files());
    }

    [Fact]
    public async Task ForgetDuringADiskReadKeepsTheOldRecordOutOfMemory()
    {
        using var network = Tmdb();
        await Cache(network, Disk()).GetAsync("movie/603", string.Empty, "key", default);
        await Until(() => Files() == 1);
        var disk = Disk();
        var cache = Cache(network, disk);
        disk.Hook = point =>
        {
            if (point == "read") cache.Forget("movie/603", string.Empty, "key");
        };
        await cache.GetAsync("movie/603", string.Empty, "key", default);
        disk.Hook = null;
        Assert.Equal(0, cache.DiskHits);
        Assert.Equal(2, network.Calls); // fetched again, not resurrected
    }

    [Fact]
    public async Task AClearWhileTheWriteIsPendingLeavesNothingBehind()
    {
        var release = new TaskCompletionSource();
        using var network = Tmdb(gate: release.Task);
        var disk = Disk();
        var cache = Cache(network, disk);
        var pending = cache.GetAsync("movie/603", string.Empty, "key", default);
        await Until(() => network.Calls == 1);
        await disk.ClearAsync(null, default);
        release.SetResult();
        await pending;
        await Task.Delay(100);
        Assert.Equal(0, Files());
    }

    [Fact]
    public async Task ACorruptedOrForeignRecordIsAMiss()
    {
        using var network = Tmdb();
        await Cache(network, Disk()).GetAsync("movie/603", string.Empty, "key", default);
        await Until(() => Files() == 1);
        var file = Directory.EnumerateFiles(Folder, "*.blob", SearchOption.AllDirectories).Single();
        var bytes = File.ReadAllBytes(file);
        bytes[^3] ^= 0x01; // the body no longer matches its ETag
        File.WriteAllBytes(file, bytes);
        await Cache(network, Disk()).GetAsync("movie/603", string.Empty, "key", default);
        Assert.Equal(2, network.Calls);
    }

    [Fact]
    public async Task ARecordFromTheFutureIsAMiss()
    {
        using var network = Tmdb();
        await Cache(network, Disk()).GetAsync("movie/603", string.Empty, "key", default);
        await Until(() => Files() == 1);
        _clock.Now -= TimeSpan.FromMinutes(5);
        await Cache(network, Disk()).GetAsync("movie/603", string.Empty, "key", default);
        Assert.Equal(2, network.Calls);
    }

    [Fact]
    public async Task AnUnusableFolderFallsBackToTmdb()
    {
        _settings = _settings with { Folder = "relative/not-allowed" };
        using var network = Tmdb();
        var cache = Cache(network, Disk());
        Assert.Equal(200, (await cache.GetAsync("movie/603", string.Empty, "key", default)).StatusCode);
        Assert.Equal(200, (await Cache(network, Disk()).GetAsync("movie/603", string.Empty, "key", default)).StatusCode);
        Assert.Equal(2, network.Calls);
    }

    [Fact]
    public async Task ADetailsBundlesFourSiblingsAfterARestartSendNothing()
    {
        using var network = Tmdb(_ => JsonSerializer.Serialize(new
        {
            id = 603, title = "The Matrix",
            release_dates = new { results = Array.Empty<object>() },
            watch_providers = 0,
            reviews = new { page = 1, results = Array.Empty<object>() },
        }).Replace("\"watch_providers\":0", "\"watch/providers\":{\"results\":{}}", StringComparison.Ordinal));
        var first = Cache(network, Disk());
        await Task.WhenAll(new[] { "movie/603", "movie/603/release_dates", "movie/603/watch/providers", "movie/603/reviews" }
            .Select(p => first.GetAsync(p, string.Empty, "key", default, bundle: true)));
        Assert.Equal(1, network.Calls);
        await Until(() => Files() == 4);
        var restarted = Cache(network, Disk());
        var answers = await Task.WhenAll(new[] { "movie/603", "movie/603/release_dates", "movie/603/watch/providers", "movie/603/reviews" }
            .Select(p => restarted.GetAsync(p, string.Empty, "key", default, bundle: true)));
        Assert.All(answers, a => Assert.Equal(200, a.StatusCode));
        Assert.Equal(1, network.Calls);
    }

    private static string NativeMovie(int id) => "{\"id\":" + id + ",\"title\":\"The Matrix\",\"credits\":{\"cast\":[]},\"release_dates\":{\"results\":[{\"iso_3166_1\":\"US\",\"release_dates\":[]}]},"
        + "\"external_ids\":{\"imdb_id\":\"tt0133093\"},\"videos\":{\"results\":[]},\"keywords\":{\"keywords\":[]},\"watch/providers\":{\"results\":{\"US\":{}}}}";

    [Fact]
    public async Task ANativeDetailsReadSeedsTheGenericExtrasBaseReleaseDatesAndProviders()
    {
        var sent = new List<Uri>();
        using var network = Tmdb(uri =>
        {
            lock (sent) sent.Add(uri);
            return uri.AbsolutePath.EndsWith("/reviews", StringComparison.Ordinal) ? "{\"id\":603,\"page\":1,\"results\":[]}" : NativeMovie(603);
        });
        var cache = Cache(network, null);
        var native = await cache.GetAsync("movie/603", "?append_to_response=" + TmdbNativeShape.MovieAppend, "key", default);
        Assert.Equal(1, network.Calls);
        var title = await cache.GetAsync("movie/603", string.Empty, "key", default, bundle: true);
        var dates = await cache.GetAsync("movie/603/release_dates", string.Empty, "key", default, bundle: true);
        var providers = await cache.GetAsync("movie/603/watch/providers", string.Empty, "key", default, bundle: true);
        Assert.Equal(1, network.Calls);
        using (var doc = JsonDocument.Parse(title.Content))
        {
            Assert.Equal("The Matrix", doc.RootElement.GetProperty("title").GetString());
            Assert.False(doc.RootElement.TryGetProperty("credits", out _));
            Assert.False(doc.RootElement.TryGetProperty("watch/providers", out _));
        }

        Assert.Equal(603, JsonDocument.Parse(dates.Content).RootElement.GetProperty("id").GetInt32());
        Assert.True(JsonDocument.Parse(providers.Content).RootElement.GetProperty("results").TryGetProperty("US", out _));
        Assert.Equal(native.FetchedAtUtc, dates.FetchedAtUtc);
        // Reviews were never part of the native read: their own request, only theirs.
        await cache.GetAsync("movie/603/reviews", string.Empty, "key", default, bundle: true);
        Assert.Equal(2, network.Calls);
        Assert.EndsWith("/3/movie/603/reviews", sent.Last().AbsolutePath, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("?language=fr-FR&append_to_response=credits,release_dates,external_ids,videos,keywords,watch/providers", 603)]
    [InlineData("?append_to_response=credits,release_dates", 603)]
    [InlineData("?append_to_response=credits,release_dates,external_ids,videos,keywords,watch/providers", 604)]
    public async Task OnlyTheExactNativeReadOfThatTitleSeedsAnything(string query, int bodyId)
    {
        using var network = Tmdb(_ => NativeMovie(bodyId));
        var cache = Cache(network, null);
        await cache.GetAsync("movie/603", query, "key", default);
        Assert.False(cache.TryGetCached("movie/603/release_dates", string.Empty, "key", out _));
        Assert.False(cache.TryGetCached("movie/603", string.Empty, "key", out _));
    }

    [Fact]
    public async Task ASeriesNativeReadSeedsItsContentRatingsAndProviders()
    {
        using var network = Tmdb(_ => "{\"id\":1399,\"name\":\"GoT\",\"credits\":{},\"content_ratings\":{\"results\":[{\"iso_3166_1\":\"US\",\"rating\":\"TV-MA\"}]},"
            + "\"external_ids\":{},\"videos\":{\"results\":[]},\"keywords\":{\"results\":[]},\"watch/providers\":{\"results\":{}}}");
        var cache = Cache(network, null);
        await cache.GetAsync("tv/1399", "?append_to_response=" + TmdbNativeShape.SeriesAppend, "key", default);
        var ratings = await cache.GetAsync("tv/1399/content_ratings", string.Empty, "key", default);
        await cache.GetAsync("tv/1399/watch/providers", string.Empty, "key", default, bundle: true);
        Assert.Equal(1, network.Calls);
        Assert.Contains("TV-MA", ratings.Content, StringComparison.Ordinal);
    }

    [Fact]
    public async Task TheLegacySnapshotMovesToDiskWithoutSearchesOrUnknownFetchTimesAndIsRenamed()
    {
        var legacy = Path.Combine(_root, "tmdb-cache.json");
        Directory.CreateDirectory(_root);
        var hash = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes("key")), 0, 8);
        var expires = (_clock.Now + TimeSpan.FromHours(5)).ToUnixTimeMilliseconds();
        var fetched = (_clock.Now - TimeSpan.FromHours(1)).UtcDateTime.Ticks;
        object Entry(string url, long f) => new { K = hash + "|https://api.themoviedb.org/3/" + url, S = 200, C = "{\"id\":1}", E = expires, F = f };
        File.WriteAllText(legacy, JsonSerializer.Serialize(new { V = 1, Entries = new[] { Entry("movie/603", fetched), Entry("search/movie?query=private", fetched), Entry("person/9", 0) } }));
        using var network = Tmdb();
        var cache = Cache(network, Disk(), legacy: legacy);
        await cache.PromoteAsync();
        Assert.Equal(1, Files());
        Assert.False(File.Exists(legacy));
        Assert.True(File.Exists(legacy + ".migrated"));

        var restarted = Cache(network, Disk(), legacy: legacy);
        var movie = await restarted.GetAsync("movie/603", string.Empty, "key", default);
        Assert.Equal(new DateTime(fetched, DateTimeKind.Utc), movie.FetchedAtUtc);
        Assert.Equal(0, network.Calls);
        await restarted.GetAsync("search/movie", "?query=private", "key", default);
        Assert.Equal(1, network.Calls);
    }

    [Fact]
    public async Task AMigrationThatKeepsFailingGivesUpForThisRunAndTheSnapshotIsKeptForTheNextStart()
    {
        var legacy = Path.Combine(_root, "tmdb-cache.json");
        Directory.CreateDirectory(_root);
        var hash = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes("key")), 0, 8);
        File.WriteAllText(legacy, JsonSerializer.Serialize(new { V = 1, Entries = new[] { new { K = hash + "|https://api.themoviedb.org/3/movie/603", S = 200, C = "{\"id\":603}",
            E = (_clock.Now + TimeSpan.FromHours(5)).ToUnixTimeMilliseconds(), F = (_clock.Now - TimeSpan.FromHours(1)).UtcDateTime.Ticks } } }));
        using var network = Tmdb();
        var disk = Disk();
        disk.Hook = point => { if (point == "commit") throw new IOException("refused"); };
        var cache = Cache(network, disk, legacy: legacy);
        for (var i = 0; i < 10; i++) await cache.PromoteAsync();
        disk.Hook = null;
        await cache.PromoteAsync(); // given up: the snapshot isn't retired in this run (memory entries are still saved)
        Assert.True(File.Exists(legacy));
        Assert.False(File.Exists(legacy + ".migrated"));

        var restarted = Cache(network, Disk(), legacy: legacy);
        await restarted.PromoteAsync();
        Assert.Equal(1, Files());
        Assert.False(File.Exists(legacy));
        Assert.True(File.Exists(legacy + ".migrated"));
    }

    [Fact]
    public async Task WithTheServerCacheOffTheLegacySnapshotIsStillWrittenAndWithItOnItIsNot()
    {
        var legacy = Path.Combine(_root, "tmdb-cache.json");
        Directory.CreateDirectory(_root);
        using var network = Tmdb();
        _settings = _settings with { Enabled = false };
        using (var off = Cache(network, Disk(), legacy: legacy)) await off.GetAsync("movie/603", string.Empty, "key", default);
        Assert.True(File.Exists(legacy));
        File.Delete(legacy);
        _settings = _settings with { Enabled = true };
        using (var on = Cache(network, Disk(), legacy: legacy)) await on.GetAsync("movie/604", string.Empty, "key", default);
        await Until(() => Files() == 1);
        Assert.False(File.Exists(legacy));
    }

    [Fact]
    public async Task EntriesFetchedWhileTheCacheWasOffAreSavedWhenItIsSwitchedOn()
    {
        _settings = _settings with { Enabled = false };
        using var network = Tmdb();
        var disk = Disk();
        var cache = Cache(network, disk);
        await cache.GetAsync("movie/603", string.Empty, "key", default);
        _settings = _settings with { Enabled = true };
        await cache.GetAsync("movie/604", string.Empty, "key", default);
        await Until(() => Files() == 2);
        await Cache(network, Disk()).GetAsync("movie/603", string.Empty, "key", default);
        Assert.Equal(2, network.Calls);
    }

    [Fact]
    public async Task CachedOnlyReadsNeverStartARequest()
    {
        using (var seed = Tmdb())
        {
            await Cache(seed, Disk()).GetAsync("movie/603", string.Empty, "key", default);
            await Until(() => Files() == 1);
        }

        using var network = Tmdb();
        var cache = Cache(network, Disk());
        var known = await TmdbResponseCache.CachedOnlyAsync(() => cache.GetAsync("movie/603", string.Empty, "key", default));
        Assert.True(known.Hit);
        Assert.Equal(200, known.Value.StatusCode);
        var unknown = await TmdbResponseCache.CachedOnlyAsync(() => cache.GetAsync("movie/604", string.Empty, "key", default));
        Assert.False(unknown.Hit);
        var refreshed = await TmdbResponseCache.CachedOnlyAsync(() => cache.GetAsync("movie/603", string.Empty, "key", default, refresh: true));
        Assert.False(refreshed.Hit);
        Assert.Equal(0, network.Calls);
    }
}
