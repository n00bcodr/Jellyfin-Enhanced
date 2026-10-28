using System.Collections;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists;
using Jellyfin.Plugin.JellyfinEnhanced.Services.ServerCache;

namespace JE.Tests;

[Collection("Plugin singleton")]
/// <summary>Review round 2 of the cache consumers (CCR2-1..4 and the round-1 variants): its probes, kept as regressions.</summary>
public sealed class IntegrationTmdbCacheReviewR2Tests : IDisposable
{
    private readonly string root = Path.Combine(Path.GetTempPath(), "je-ccr2-" + Guid.NewGuid().ToString("N"));
    private readonly IntegrationTmdbDiskCacheTests.Clock clock = new() { Now = DateTimeOffset.UtcNow };
    private ServerCacheSettings settings = new(true, string.Empty, 0, 0);
    private ServerBlobCache Disk() => new(() => settings, new ServerCacheLocation(root, Array.Empty<string>()), null, () => clock.Now.UtcDateTime) { SweepDebounce = TimeSpan.Zero };
    private int Files() => Directory.Exists(root) ? Directory.EnumerateFiles(root, "*.blob", SearchOption.AllDirectories).Count() : 0;
    private TmdbResponseCache Raw(IntegrationTransport net, ServerBlobCache disk, string? legacy = null) => new(net, clock, null, disk, legacy, null);
    private static IntegrationTransport Net() => new((_, _) => Task.FromResult(IntegrationTransport.Response("{\"id\":603}")));
    private static Task<bool> Put(ServerBlobCache disk, string key, long generation) => disk.PutAsync("metadata", key, new byte[] { 1, 2, 3 }, "application/json", default, generation);
    private static Task Drain(ServerBlobCache disk) => IntegrationTmdbDiskCacheTests.Until(() => (int)typeof(ServerBlobCache).GetField("_pendingIo", BindingFlags.NonPublic | BindingFlags.Instance)!.GetValue(disk)! == 0);
    public void Dispose() { if (Directory.Exists(root)) Directory.Delete(root, true); }

    [Fact]
    public async Task Exact4096FenceThenOverflowPreservesAndEndsTheRightGenerations()
    {
        var disk = Disk();
        disk.Register(new ServerCacheNamespace("metadata"));
        var before = disk.Generation;
        for (var i = 0; i < 4096; i++) await disk.ForgetEntryAsync("metadata", "entry-" + i, default);
        var fences = (IDictionary)typeof(ServerBlobCache).GetField("_forgotten", BindingFlags.NonPublic | BindingFlags.Instance)!.GetValue(disk)!;
        Assert.Equal(4096, fences.Count);
        Assert.True(disk.IsCurrent(before));
        Assert.True(await Put(disk, "unrelated", before));
        Assert.False(await Put(disk, "entry-0", before));
        Assert.False(await Put(disk, "entry-4095", before));
        var atBound = disk.Generation;
        await disk.ForgetEntryAsync("metadata", "overflow", default);
        Assert.False(disk.IsCurrent(atBound));
        Assert.False(await Put(disk, "unrelated", before));
        Assert.False(await Put(disk, "unrelated", atBound));
        Assert.False(await Put(disk, "overflow", atBound));
        Assert.True(await Put(disk, "overflow", disk.Generation));
        Assert.True(fences.Count <= 4096);
    }

    [Fact]
    public async Task ForgetAWhileBIsReadingKeepsBsSharedFlightAndAnswer()
    {
        using var net = Net();
        using (var seed = Raw(net, Disk()))
        {
            await seed.GetAsync("movie/603", "", "key", default);
            await seed.GetAsync("movie/604", "", "key", default);
            await IntegrationTmdbDiskCacheTests.Until(() => Files() == 2);
        }
        var disk = Disk();
        using var raw = Raw(net, disk);
        using var entered = new ManualResetEventSlim();
        using var release = new ManualResetEventSlim();
        var reads = 0;
        disk.Hook = point => { if (point == "read") { Interlocked.Increment(ref reads); entered.Set(); if (!release.Wait(TimeSpan.FromSeconds(10))) throw new TimeoutException(); } };
        var first = raw.HydrateAsync("movie/604", "", "key", default);
        Assert.True(entered.Wait(TimeSpan.FromSeconds(5)));
        Task<bool>? second = null;
        try
        {
            raw.Forget("movie/603", "", "key");
            second = raw.HydrateAsync("movie/604", "", "key", default);
            Assert.False(second.IsCompleted);
            var flights = (IDictionary)typeof(ServerBlobCache).GetField("_reads", BindingFlags.NonPublic | BindingFlags.Instance)!.GetValue(disk)!;
            Assert.Single(flights.Values.Cast<object>());
        }
        finally { release.Set(); }
        Assert.True(await first);
        Assert.True(await second!);
        Assert.Equal(1, reads);
        Assert.False(raw.TryGetCached("movie/603", "", "key", out _));
        Assert.True(raw.TryGetCached("movie/604", "", "key", out _));
        Assert.Equal(2, net.Calls);
        await Drain(disk);
    }

    [Theory]
    [InlineData("search/movie?query=%E6%97%A5%E6%9C%AC", false)]
    [InlineData("/search/movie?query=%E6%97%A5%E6%9C%AC", false)]
    [InlineData("movie/%EF%BC%8E%EF%BC%8E/search/movie", false)]
    [InlineData("%73earch/movie?query=%E6%97%A5%E6%9C%AC", false)]
    [InlineData("movie/603?language=ja-JP&region=%E6%97%A5%E6%9C%AC", true)]
    public void CanonicalRouteClassificationWithPercentEncodedUnicode(string resource, bool expected)
        => Assert.Equal(expected, TmdbResponseCache.Durable("https://api.themoviedb.org/3/" + resource));

    [Fact]
    public async Task PercentEncodedUnicodeQueryVariantsKeepTheirExactDiskKeys()
    {
        using var net = Net();
        var firstQuery = "?language=ja-JP&region=%E6%97%A5%E6%9C%AC";
        var secondQuery = "?language=ja-JP&region=%E4%B8%AD%E5%9B%BD";
        var disk = Disk();
        using (var raw = Raw(net, disk))
        {
            await raw.GetAsync("movie/603", firstQuery, "key", default);
            await raw.GetAsync("movie/603", secondQuery, "key", default);
            await Drain(disk);
            Assert.Equal(2, Files());
        }
        using var restarted = Raw(net, Disk());
        Assert.True(await restarted.HydrateAsync("movie/603", firstQuery, "key", default));
        Assert.True(await restarted.HydrateAsync("movie/603", secondQuery, "key", default));
        Assert.Equal(2, net.Calls);
    }

    private string Legacy(params (int Id, string Body, int Status, double Hours)[] records)
    {
        Directory.CreateDirectory(root);
        var path = Path.Combine(root, "tmdb-cache.json");
        var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes("key")), 0, 8);
        File.WriteAllText(path, JsonSerializer.Serialize(new { V = 1, Entries = records.Select(e => new { K = hash + "|https://api.themoviedb.org/3/movie/" + e.Id, S = e.Status, C = e.Body, E = (clock.Now + TimeSpan.FromHours(e.Hours)).ToUnixTimeMilliseconds(), F = clock.Now.UtcTicks }) }));
        return path;
    }

    [Fact]
    public async Task ExactlyOneUnsaveableMigrationEntryNeverRetiresBeforeASuccessfulRetry()
    {
        var legacy = Legacy((603, "{\"id\":603}", 200, 6));
        using var net = Net();
        var disk = Disk();
        disk.Hook = point => { if (point == "commit") throw new IOException("persistent commit refusal"); };
        using var raw = Raw(net, disk, legacy);
        for (var i = 0; i < 3; i++)
        {
            await raw.PromoteAsync();
            Assert.True(File.Exists(legacy));
            Assert.False(File.Exists(legacy + ".migrated"));
            Assert.Equal(0, Files());
        }
        disk.Hook = null;
        await raw.PromoteAsync();
        Assert.Equal(1, Files());
        Assert.False(File.Exists(legacy));
        Assert.True(File.Exists(legacy + ".migrated"));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task CancelledFirstPosterCallerLeavesTheJoinerAndInlineOwnerIntact(bool withDisk)
    {
        using var plugin = new ApiPluginFixture();
        plugin.Plugin.Configuration.TMDB_API_KEY = "key";
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var net = new IntegrationTransport(async (_, ct) => { await release.Task.WaitAsync(ct); return IntegrationTransport.Response("{\"id\":603,\"poster_path\":\"/a.jpg\"}"); });
        var disk = Disk();
        var service = new ListMetadataService(net, plugin.Core.Logger, withDisk ? new ListPosterFactCache(disk) : null);
        var placeholder = new Placeholder { Id = Guid.NewGuid().ToString("N"), Kind = PlaceholderKinds.Movie, MediaType = "movie", TmdbId = 603, Title = "Movie" };
        using var cts = new CancellationTokenSource();
        var first = service.ReadTmdbPosterAsync(placeholder, cts.Token);
        await IntegrationTmdbDiskCacheTests.Until(() => net.Calls == 1);
        cts.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => first);
        var second = service.ReadTmdbPosterAsync(placeholder, default);
        Assert.False(second.IsCompleted);
        release.SetResult();
        Assert.Equal(("/a.jpg", true), await second.WaitAsync(TimeSpan.FromSeconds(10)));
        Assert.Equal(("/a.jpg", true), await service.ReadTmdbPosterAsync(placeholder, default));
        Assert.Equal(1, net.Calls);
        var flights = (IDictionary)service.GetType().GetField("_posterReads", BindingFlags.NonPublic | BindingFlags.Instance)!.GetValue(service)!;
        Assert.Empty(flights);
        if (withDisk) await Drain(disk);
    }

    [Fact]
    public async Task LegacyRecordsClaimingTooLongATtlMustBeSkippedInMemoryToo()
    {
        var legacy = Legacy((603, "{\"id\":603,\"stale\":true}", 200, 48));
        using var net = Net();
        using var raw = Raw(net, Disk(), legacy);
        var loaded = raw.TryGetCached("movie/603", "", "key", out _);
        await raw.PromoteAsync();
        clock.Now += TimeSpan.FromHours(7);
        await raw.GetAsync("movie/603", "", "key", default);
        Assert.False(loaded, "Overlong TTL loaded into memory; sends after seven hours=" + net.Calls);
    }

    [Fact]
    public async Task OversizedUtf8LegacyRecordIsSkippedAndDoesNotBlockTheOneValidMigration()
    {
        // Less than 8 MiB of UTF-16 chars, more than 8 MiB on the wire; a real bounded TMDB read could not produce it.
        var tooBig = "{\"id\":603,\"text\":\"" + new string('\u65e5', 3 * 1024 * 1024) + "\"}";
        Assert.True(tooBig.Length < BoundedBody.MaxBytes);
        Assert.True(Encoding.UTF8.GetByteCount(tooBig) > BoundedBody.MaxBytes);
        var legacy = Legacy((603, tooBig, 200, 6), (604, "{\"id\":604}", 200, 6));
        using var net = Net();
        using var raw = Raw(net, Disk(), legacy);
        var loaded = raw.TryGetCached("movie/603", "", "key", out _);
        Assert.True(raw.TryGetCached("movie/604", "", "key", out _));
        await raw.PromoteAsync();
        Assert.Equal(1, Files());
        Assert.False(loaded, "Oversized record loaded; valid blobs=" + Files() + "; active snapshot=" + File.Exists(legacy));
        Assert.False(File.Exists(legacy));
    }
    [Fact]
    public async Task MigrationCannotCountAStartedButUncommittedSaveAsCompleted()
    {
        var legacy = Legacy((603, "{\"id\":603}", 200, 6));
        using var net = Net();
        var disk = Disk();
        using var raw = Raw(net, disk, legacy);
        disk.Hook = point => { if (point == "commit") throw new IOException("delayed save fails after retirement"); };
        var io = (SemaphoreSlim)typeof(ServerBlobCache).GetField("_io", BindingFlags.NonPublic | BindingFlags.Instance)!.GetValue(disk)!;
        // Saturate the real store I/O semaphore: a legitimate refresh can finish and publish memory, while its disk save is pending.
        var held = 0;
        while (io.Wait(0)) held++;
        Assert.True(held > 0);
        Task<TmdbResponseCache.TmdbResponse>? refresh = null;
        var retiredWhilePending = false;
        try
        {
            var cacheLock = typeof(TmdbResponseCache).GetField("_lock", BindingFlags.NonPublic | BindingFlags.Instance)!.GetValue(raw)!;
            lock (cacheLock)
            {
                refresh = raw.GetAsync("movie/603", "", "key", default, refresh: true);
                Assert.True(refresh.IsCompletedSuccessfully);
            }
            await refresh;
            await IntegrationTmdbDiskCacheTests.Until(() => (int)typeof(TmdbResponseCache).GetField("_promoting", BindingFlags.NonPublic | BindingFlags.Instance)!.GetValue(raw)! == 0);
            await raw.PromoteAsync();
            retiredWhilePending = !File.Exists(legacy);
            Assert.Equal(0, Files());
        }
        finally
        {
            for (var i = 0; i < held; i++) io.Release();
            if (refresh != null) await refresh;
            await Drain(disk);
        }
        Assert.Equal(0, Files());
        Assert.False(retiredWhilePending, "Legacy snapshot retired before the sole replacement disk write had committed; that save then failed, blobs=" + Files());
    }

    [Fact]
    public async Task CancelledDistinctPosterMissesCannotLeaveAnUnboundedRetainedQueue()
    {
        using var plugin = new ApiPluginFixture();
        plugin.Plugin.Configuration.TMDB_API_KEY = "key";
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var net = new IntegrationTransport(async (request, ct) =>
        {
            await release.Task.WaitAsync(ct);
            var id = int.Parse(request.RequestUri!.AbsolutePath.Split('/').Last());
            return IntegrationTransport.Response(JsonSerializer.Serialize(new { id, poster_path = "/a.jpg" }));
        });
        var service = new ListMetadataService(net, plugin.Core.Logger);
        using var cts = new CancellationTokenSource();
        var reads = Enumerable.Range(1, 4097).Select(id => service.ReadTmdbPosterAsync(new Placeholder
            { Id = "p" + id, Kind = PlaceholderKinds.Movie, MediaType = "movie", TmdbId = id, Title = "Movie" }, cts.Token)).ToArray();
        Assert.Equal(4, net.Calls);
        cts.Cancel();
        await Task.WhenAll(reads.Select(async read => { try { await read; } catch (OperationCanceledException) { } }));
        var flights = (IDictionary)service.GetType().GetField("_posterReads", BindingFlags.NonPublic | BindingFlags.Instance)!.GetValue(service)!;
        var retained = flights.Count;
        // Always release and drain the fake work before reporting the retained-state failure.
        var tasks = flights.Values.Cast<Task>().ToArray();
        release.SetResult();
        await Task.WhenAll(tasks).WaitAsync(TimeSpan.FromSeconds(30));
        Assert.Empty(flights);
        Assert.True(retained <= 4000, "After every caller cancelled: retained poster flights=" + retained + "; total orphan sends=" + net.Calls);
    }

    [Theory]
    [InlineData("disable")]
    [InlineData("folder")]
    public async Task SettingsChangeDetachesTheOldStoreRead(string change)
    {
        var disk = Disk();
        disk.Register(new ServerCacheNamespace("metadata"));
        Assert.True(await Put(disk, "a", disk.Generation));
        using var entered = new ManualResetEventSlim();
        using var release = new ManualResetEventSlim();
        var calls = 0;
        disk.Hook = point => { if (point == "read" && Interlocked.Increment(ref calls) == 1) { entered.Set(); if (!release.Wait(TimeSpan.FromSeconds(10))) throw new TimeoutException(); } };
        var old = disk.TryGetAsync("metadata", "a", default);
        Assert.True(entered.Wait(TimeSpan.FromSeconds(5)));
        try
        {
            settings = change == "disable" ? settings with { Enabled = false } : settings with { Folder = Path.Combine(root, "different") };
            disk.SettingsChanged();
            if (change == "disable") { settings = settings with { Enabled = true }; disk.SettingsChanged(); }
            var next = disk.TryGetAsync("metadata", "a", default);
            await next.WaitAsync(TimeSpan.FromSeconds(5));
            Assert.Equal(2, calls);
        }
        finally { release.Set(); await old; await Drain(disk); }
    }

}
