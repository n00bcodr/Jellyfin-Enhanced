using System.Collections;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Services.NativeDetails;
using Jellyfin.Plugin.JellyfinEnhanced.Services.ServerCache;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.Globalization;
using Moq;

namespace JE.Tests;

[Collection("Plugin singleton")]
/// <summary>Review round 1 of the cache consumers (CCR-1..11): its probes, kept as regressions.</summary>
public sealed class IntegrationTmdbCacheReviewTests : IDisposable
{
    private readonly string root = Path.Combine(Path.GetTempPath(), "je-ccr-" + Guid.NewGuid().ToString("N"));
    private readonly IntegrationTmdbDiskCacheTests.Clock clock = new() { Now = DateTimeOffset.UtcNow };
    private ServerCacheSettings settings = new(true, string.Empty, 0, 0);
    private ServerBlobCache Disk(Func<DateTime>? now = null) => new(() => settings, new ServerCacheLocation(root, Array.Empty<string>()), null, now ?? (() => clock.Now.UtcDateTime)) { SweepDebounce = TimeSpan.Zero };
    private int Files() => Directory.Exists(root) ? Directory.EnumerateFiles(root, "*.blob", SearchOption.AllDirectories).Count() : 0;
    private TmdbResponseCache Cache(IntegrationTransport net, ServerBlobCache disk, string? legacy = null) => new(net, clock, null, disk, legacy, null);
    private static IntegrationTransport Net(Task? hold = null) => new(async (_, ct) =>
    {
        if (hold != null) await hold.WaitAsync(ct);
        return IntegrationTransport.Response("{\"id\":603,\"title\":\"A\",\"release_dates\":{\"results\":[]},\"watch/providers\":{\"results\":{}}}");
    });
    public void Dispose() { if (Directory.Exists(root)) Directory.Delete(root, true); }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task PromotionMustRetainThePreInputGenerationAcrossClear(bool initiallyOn)
    {
        settings = settings with { Enabled = initiallyOn };
        using var net = Net();
        var disk = Disk();
        using var cache = Cache(net, disk);
        await cache.GetAsync("movie/603", "", "key", default);
        if (initiallyOn) await IntegrationTmdbDiskCacheTests.Until(() => Files() == 1);
        await disk.ClearAsync(null, default);
        settings = settings with { Enabled = true };
        await cache.PromoteAsync();
        Assert.Equal(0, Files());
        Assert.True(cache.TryGetCached("movie/603", "", "key", out _));
    }

    [Theory]
    [InlineData("movie/603")]
    [InlineData("movie/603/release_dates")]
    [InlineData("movie/603/watch/providers")]
    public async Task ForgetOfASeededResourceMustFenceTheOlderNativeRead(string forgotten)
    {
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var net = Net(release.Task);
        var disk = Disk();
        using var cache = Cache(net, disk);
        var read = cache.GetAsync("movie/603", "?append_to_response=" + TmdbNativeShape.MovieAppend, "key", default);
        await IntegrationTmdbDiskCacheTests.Until(() => net.Calls == 1);
        cache.Forget(forgotten, "", "key");
        release.SetResult();
        await read;
        Assert.False(cache.TryGetCached(forgotten, "", "key", out _));
    }

    private string Legacy()
    {
        Directory.CreateDirectory(root);
        var path = Path.Combine(root, "tmdb-cache.json");
        var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes("key")), 0, 8);
        File.WriteAllText(path, JsonSerializer.Serialize(new { V = 1, Entries = new[] { new { K = hash + "|https://api.themoviedb.org/3/movie/603", S = 200, C = "{\"id\":603}", E = (clock.Now + TimeSpan.FromHours(6)).ToUnixTimeMilliseconds(), F = clock.Now.UtcTicks } } }));
        return path;
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ARefusedMigrationEntryMustBeRetriedBeforeTheLegacyFileIsRetired(bool partialImport)
    {
        var legacy = Legacy();
        if (partialImport)
        {
            var json = System.Text.Json.Nodes.JsonNode.Parse(File.ReadAllText(legacy))!;
            var second = json["Entries"]![0]!.DeepClone();
            second["K"] = second["K"]!.GetValue<string>().Replace("movie/603", "person/604", StringComparison.Ordinal);
            second["C"] = "{\"id\":604}";
            json["Entries"]!.AsArray().Add(second);
            File.WriteAllText(legacy, json.ToJsonString());
        }
        settings = settings with { MaxBytes = partialImport ? 0 : 1 };
        using var net = Net();
        var disk = Disk();
        var commits = 0;
        if (partialImport) disk.Hook = point => { if (point == "commit" && Interlocked.Increment(ref commits) == 2) throw new IOException("one refused migration commit"); };
        using var cache = Cache(net, disk, legacy);
        await cache.PromoteAsync();
        Assert.True(File.Exists(legacy));
        Assert.Equal(partialImport ? 1 : 0, Files());
        disk.Hook = null;
        settings = settings with { MaxBytes = 0 };
        disk.SettingsChanged();
        await disk.PendingSweep;
        await cache.PromoteAsync();
        Assert.Equal(partialImport ? 2 : 1, Files());
        Assert.False(File.Exists(legacy));
    }

    [Fact]
    public async Task AReadJoiningAnOlderStoreFlightAfterForgetMustNotAdoptTheOldBytes()
    {
        using var net = Net();
        using (var seed = Cache(net, Disk())) await seed.GetAsync("movie/603", "", "key", default);
        await IntegrationTmdbDiskCacheTests.Until(() => Files() == 1);
        using var entered = new ManualResetEventSlim();
        using var release = new ManualResetEventSlim();
        var armed = 0;
        var readThread = -1;
        var disk = Disk(() =>
        {
            if (Environment.CurrentManagedThreadId == Volatile.Read(ref readThread) && Interlocked.CompareExchange(ref armed, 2, 1) == 1)
            {
                entered.Set();
                if (!release.Wait(TimeSpan.FromSeconds(10))) throw new TimeoutException();
            }
            return clock.Now.UtcDateTime;
        });
        using var cache = Cache(net, disk);
        disk.Hook = point => { if (point == "read") { readThread = Environment.CurrentManagedThreadId; Volatile.Write(ref armed, 1); } };
        var first = cache.HydrateAsync("movie/603", "", "key", default);
        Assert.True(entered.Wait(TimeSpan.FromSeconds(5)));
        Task<bool>? second = null;
        try
        {
            cache.Forget("movie/603", "", "key");
            second = cache.HydrateAsync("movie/603", "", "key", default);
            Assert.False(second.IsCompleted);
        }
        finally { release.Set(); }
        Assert.False(await first);
        Assert.False(await second!);
        Assert.False(cache.TryGetCached("movie/603", "", "key", out _));
    }

    [Fact]
    public async Task RawEvidenceAdoptionMustKeepItsOriginalVerificationTimeInMemory()
    {
        using var plugin = new ApiPluginFixture();
        plugin.Plugin.Configuration.ArrRequestBackend = "je";
        plugin.Plugin.Configuration.TMDB_API_KEY = "key";
        var kid = FakeListHost.MakeUser("Kid");
        kid.MaxParentalRatingScore = 10;
        var users = new Mock<IUserManager>(); users.Setup(m => m.GetUserById(kid.Id)).Returns(kid);
        var localization = new Mock<ILocalizationManager>(); localization.Setup(m => m.GetRatingScore("G", It.IsAny<string>())).Returns(new ParentalRatingScore(1, null));
        var server = new Mock<IServerConfigurationManager>(); server.SetupGet(m => m.Configuration).Returns(new ServerConfiguration { MetadataCountryCode = "US" });
        clock.Now = DateTimeOffset.UtcNow - TimeSpan.FromHours(5);
        using var net = new IntegrationTransport((_, _) => Task.FromResult(IntegrationTransport.Response(IntegrationParentalEvidenceTests.Movie(603))));
        var disk = Disk();
        using var raw = Cache(net, disk);
        using (ViewerMetadataAdmission.ForViewer(kid.Id))
            await raw.GetAsync("movie/603", "?language=en-US&append_to_response=release_dates", "key", default);
        var fetched = clock.Now.UtcDateTime;
        clock.Now = DateTimeOffset.UtcNow;
        var gate = new SeerrParentalFilter(net, users.Object, localization.Object, server.Object, plugin.Core.Logger,
            new TitleParentalEvidenceProvider(net, raw, null, new TmdbParentalFactCache(disk)));
        Assert.True(await gate.MaySeeAbsentAsync("movie", 603, kid.Id.ToString("N"), default));
        Assert.Equal(1, net.Calls);
        await IntegrationTmdbDiskCacheTests.Until(() => Files() == 1);
        var entries = (IDictionary)typeof(SeerrParentalFilter).GetField("_certCache", BindingFlags.NonPublic | BindingFlags.Instance)!.GetValue(gate)!;
        var tuple = Assert.Single(entries.Values.Cast<object>());
        var cachedAt = (DateTime)tuple.GetType().GetField("Item3")!.GetValue(tuple)!;
        Assert.Equal(fetched, cachedAt);
    }

    [Fact]
    public async Task ForgetOfAbsentFactsMustFenceAnAlreadyStartedWriter()
    {
        using var entered = new ManualResetEventSlim();
        using var release = new ManualResetEventSlim();
        var writerThread = -1;
        var armed = 1;
        var disk = new ServerBlobCache(() =>
        {
            if (Environment.CurrentManagedThreadId == Volatile.Read(ref writerThread) && Interlocked.Exchange(ref armed, 0) == 1)
            {
                entered.Set();
                if (!release.Wait(TimeSpan.FromSeconds(10))) throw new TimeoutException();
            }
            return settings;
        }, new ServerCacheLocation(root, Array.Empty<string>()), null);
        var facts = new TmdbParentalFactCache(disk);
        var evidence = new TitleParentalEvidence("G", "US", Array.Empty<string>(), Array.Empty<string>(), false)
        { ReadAtUtc = DateTime.UtcNow, FactsGeneration = facts.Generation };
        var write = Task.Run(() => { writerThread = Environment.CurrentManagedThreadId; return facts.WriteAsync("je:scope", "movie", 603, "US", evidence, true, TimeSpan.FromHours(24)); });
        Assert.True(entered.Wait(TimeSpan.FromSeconds(5)));
        try { await facts.ForgetAsync("je:scope", "movie", 603, "US"); }
        finally { release.Set(); }
        Assert.False(await write);
        Assert.Null(await facts.ReadAsync("je:scope", "movie", 603, "US", true, default));
    }

    [Fact]
    public async Task AnOffCacheSnapshotSaveMustNotRecreateTheLegacyFileAfterMigration()
    {
        var legacy = Legacy();
        settings = settings with { Enabled = false };
        using var entered = new ManualResetEventSlim();
        using var release = new ManualResetEventSlim();
        var saveThread = -1;
        var armed = 1;
        var disk = new ServerBlobCache(() =>
        {
            var captured = settings;
            if (Environment.CurrentManagedThreadId == Volatile.Read(ref saveThread) && Interlocked.Exchange(ref armed, 0) == 1)
            {
                entered.Set();
                if (!release.Wait(TimeSpan.FromSeconds(10))) throw new TimeoutException();
            }
            return captured;
        }, new ServerCacheLocation(root, Array.Empty<string>()), null);
        using var net = Net();
        using var cache = Cache(net, disk, legacy);
        await cache.GetAsync("search/movie", "?query=private", "key", default);
        var save = Task.Run(() =>
        {
            saveThread = Environment.CurrentManagedThreadId;
            typeof(TmdbResponseCache).GetMethod("SaveToDisk", BindingFlags.NonPublic | BindingFlags.Instance)!.Invoke(cache, null);
        });
        Assert.True(entered.Wait(TimeSpan.FromSeconds(5)));
        try
        {
            settings = settings with { Enabled = true };
            await cache.PromoteAsync();
            Assert.True(File.Exists(legacy + ".migrated"));
        }
        finally { release.Set(); }
        await save;
        Assert.False(File.Exists(legacy));
    }

    [Fact]
    public async Task A6RawMemoryHitsAreFreeAndEightyColdFeedsStillAdmitOnlyEight()
    {
        using var plugin = new ApiPluginFixture();
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var hold = false;
        using var net = new IntegrationTransport(async (_, ct) =>
        {
            if (hold) await release.Task.WaitAsync(ct);
            return IntegrationTransport.Response("{\"id\":1,\"cast\":[],\"crew\":[]}");
        });
        var admission = new ViewerMetadataAdmission();
        using var raw = new TmdbResponseCache(net, clock, admission);
        for (var id = 1; id <= 80; id++) await raw.GetAsync("person/" + id + "/combined_credits", "", "key", default);
        var source = new TmdbNativeDetailsSource(raw, null, plugin.Core.Logger, () => "key", () => DateTime.UtcNow, admission);
        var viewer = Guid.NewGuid();
        var hits = await Task.WhenAll(Enumerable.Range(1, 80).Select(id => source.PersonCreditsAsync(id, viewer, default)));
        Assert.All(hits, answer => Assert.True(answer.Data.HasValue));
        Assert.Equal(80, net.Calls);
        Assert.Equal(0, admission.Count());
        hold = true;
        var cold = Enumerable.Range(100, 80).Select(id => source.PersonCreditsAsync(id, viewer, default)).ToArray();
        try
        {
            Assert.Equal(8, admission.Count());
            Assert.Equal(88, net.Calls);
            Assert.Equal(72, cold.Count(t => t.IsCompletedSuccessfully && t.Result.Busy));
        }
        finally { release.TrySetResult(); await Task.WhenAll(cold).WaitAsync(TimeSpan.FromSeconds(10)); }
    }

    [Fact]
    public async Task PosterDiskHydrationMustRespectTheExistingFourThousandEntryMemoryBound()
    {
        using var plugin = new ApiPluginFixture();
        plugin.Plugin.Configuration.TMDB_API_KEY = "key";
        var disk = Disk();
        var facts = new Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists.ListPosterFactCache(disk);
        var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes("key")), 0, 8);
        Assert.True(await facts.WriteAsync(hash, "movie/603", new Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists.AnswerRequest(603, "movie"), "/a.jpg", DateTime.UtcNow, facts.Generation));
        using var net = Net();
        var service = new Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists.ListMetadataService(net, plugin.Core.Logger, facts);
        var cache = (System.Collections.Concurrent.ConcurrentDictionary<string, (string? Poster, DateTime At)>)service.GetType()
            .GetProperty("_tmdbPostersFacts", BindingFlags.NonPublic | BindingFlags.Instance)!.GetValue(service)!;
        for (var i = 0; i < 4000; i++) cache["existing:" + i] = ("/old.jpg", DateTime.UtcNow);
        var placeholder = new Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders.Placeholder
        { Id = Guid.NewGuid().ToString("N"), Kind = Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders.PlaceholderKinds.Movie, MediaType = "movie", TmdbId = 603, Title = "Movie" };
        Assert.Equal(("/a.jpg", true), await service.ReadTmdbPosterAsync(placeholder, default));
        Assert.Equal(0, net.Calls);
        Assert.True(cache.Count <= 4000, "Memory poster entries: " + cache.Count);
    }

    [Fact]
    public async Task ACorruptLegacyBodyMustNotBecomeAValidDurableJsonAnswer()
    {
        var legacy = Legacy();
        var json = System.Text.Json.Nodes.JsonNode.Parse(File.ReadAllText(legacy))!;
        json["Entries"]![0]!["C"] = "not-json";
        File.WriteAllText(legacy, json.ToJsonString());
        using var net = Net();
        using (var cache = Cache(net, Disk(), legacy)) await cache.PromoteAsync();
        using var restarted = Cache(net, Disk(), legacy);
        var response = await restarted.GetAsync("movie/603", "", "key", default);
        Assert.Equal(1, net.Calls);
        Assert.StartsWith("{", response.Content);
    }

    [Fact]
    public async Task SeededGenericFieldsMatchIndependentReadsAndKeepQueryVariantsSeparate()
    {
        var baseBody = "{\"id\":603,\"title\":\"A\"}";
        var memberBody = "{\"id\":603,\"results\":[]}";
        using var net = new IntegrationTransport((request, _) =>
        {
            var uri = request.RequestUri!;
            var body = uri.Query.Contains("append_to_response=", StringComparison.Ordinal)
                ? "{\"id\":603,\"title\":\"A\",\"credits\":{},\"external_ids\":{},\"videos\":{},\"keywords\":{},\"release_dates\":{\"results\":[]},\"watch/providers\":{\"results\":[]}}"
                : uri.AbsolutePath.EndsWith("/603", StringComparison.Ordinal) ? baseBody : memberBody;
            return Task.FromResult(IntegrationTransport.Response(body));
        });
        using var seeded = new TmdbResponseCache(net, clock);
        await seeded.GetAsync("movie/603", "?append_to_response=" + TmdbNativeShape.MovieAppend, "key", default);
        foreach (var path in new[] { "movie/603", "movie/603/release_dates", "movie/603/watch/providers" })
        {
            var actual = await seeded.GetAsync(path, "", "key", default);
            using var independent = new TmdbResponseCache(net, clock);
            var expected = await independent.GetAsync(path, "", "key", default);
            Assert.Equal(expected.Content, actual.Content);
            Assert.Equal(expected.ETag, actual.ETag);
        }
        Assert.Equal(4, net.Calls);
        await seeded.GetAsync("movie/603", "?language=fr-FR", "key", default, bundle: true);
        await seeded.GetAsync("movie/603/release_dates", "?page=2", "key", default, bundle: true);
        await seeded.GetAsync("movie/603/reviews", "", "key", default, bundle: true);
        Assert.Equal(7, net.Calls);
    }

    [Fact]
    public async Task ConcurrentPosterMissesMustCoalesceBeforeTheirUpstreamRead()
    {
        using var plugin = new ApiPluginFixture();
        plugin.Plugin.Configuration.TMDB_API_KEY = "key";
        using var readEntered = new ManualResetEventSlim();
        using var readRelease = new ManualResetEventSlim();
        var networkRelease = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var disk = Disk();
        disk.Hook = point =>
        {
            if (point == "read")
            {
                readEntered.Set();
                if (!readRelease.Wait(TimeSpan.FromSeconds(10))) throw new TimeoutException();
            }
        };
        using var net = new IntegrationTransport(async (_, ct) =>
        {
            await networkRelease.Task.WaitAsync(ct);
            return IntegrationTransport.Response("{\"id\":603,\"poster_path\":\"/a.jpg\"}");
        });
        var service = new Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists.ListMetadataService(net, plugin.Core.Logger,
            new Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists.ListPosterFactCache(disk));
        var placeholder = new Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders.Placeholder
        { Id = Guid.NewGuid().ToString("N"), Kind = Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders.PlaceholderKinds.Movie, MediaType = "movie", TmdbId = 603, Title = "Movie" };
        var reads = Enumerable.Range(1, 12).Select(_ => service.ReadTmdbPosterAsync(placeholder, default)).ToArray();
        Assert.True(readEntered.Wait(TimeSpan.FromSeconds(5)));
        readRelease.Set();
        try { await IntegrationTmdbDiskCacheTests.Until(() => net.Calls >= 1); }
        finally { networkRelease.TrySetResult(); }
        var answers = await Task.WhenAll(reads).WaitAsync(TimeSpan.FromSeconds(10));
        await IntegrationTmdbDiskCacheTests.Until(() => (int)typeof(ServerBlobCache).GetField("_pendingIo", BindingFlags.NonPublic | BindingFlags.Instance)!.GetValue(disk)! == 0);
        Assert.All(answers, answer => Assert.Equal(("/a.jpg", true), answer));
        Assert.Equal(1, net.Calls);
    }

    [Theory]
    [InlineData("/search/movie")]
    [InlineData("/search/company")]
    public async Task SupportedLeadingSlashSearchPathsMustNeverBeWrittenToDisk(string path)
    {
        Assert.True(ProviderPresentationSchema.SupportsTmdbPath(path));
        Assert.True(TmdbAppendProjection.IsSupported(path, new Microsoft.AspNetCore.Http.QueryCollection()));
        using var net = Net();
        var disk = Disk();
        using var cache = Cache(net, disk);
        await cache.GetAsync(path, "?query=private", "key", default);
        await IntegrationTmdbDiskCacheTests.Until(() => (int)typeof(ServerBlobCache).GetField("_pendingIo", BindingFlags.NonPublic | BindingFlags.Instance)!.GetValue(disk)! == 0);
        Assert.Equal(0, Files());
    }
}
