using System.Collections;
using System.Diagnostics;
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
/// <summary>Review round 3 of the cache consumers (CCR3-1 and the CCR2 variants): its probes, kept as regressions.</summary>
public sealed class IntegrationTmdbCacheReviewR3Tests : IDisposable
{
    private readonly string root = Path.Combine(Path.GetTempPath(), "je-ccr3-" + Guid.NewGuid().ToString("N"));
    private readonly IntegrationTmdbDiskCacheTests.Clock clock = new() { Now = DateTimeOffset.UtcNow };
    private ServerCacheSettings settings = new(true, string.Empty, 0, 0);
    private ServerBlobCache Disk(Func<ServerCacheSettings>? read = null) => new(read ?? (() => settings), new ServerCacheLocation(root, Array.Empty<string>()), null, () => clock.Now.UtcDateTime);
    private TmdbResponseCache Raw(IntegrationTransport net, ServerBlobCache disk, string path) => new(net, clock, null, disk, path, null);
    private static IntegrationTransport Net() => new((_, _) => Task.FromResult(IntegrationTransport.Response("{\"id\":603,\"newer\":true}")));
    private int Files() => Directory.Exists(root) ? Directory.EnumerateFiles(root, "*.blob", SearchOption.AllDirectories).Count() : 0;
    private static Task Drain(ServerBlobCache disk) => IntegrationTmdbDiskCacheTests.Until(() => (int)Field(disk, "_pendingIo") == 0);
    private static object Field(object owner, string name) => owner.GetType().GetField(name, BindingFlags.NonPublic | BindingFlags.Instance)!.GetValue(owner)!;
    private string Legacy(string route = "movie/603", int status = 200, long? fetched = null)
    {
        Directory.CreateDirectory(root);
        var path = Path.Combine(root, "tmdb-cache.json");
        var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes("key")), 0, 8);
        var record = new Dictionary<string, object> { ["K"] = hash + "|https://api.themoviedb.org/3/" + route, ["S"] = status,
            ["C"] = "{\"id\":603,\"old\":true}", ["E"] = (clock.Now + TimeSpan.FromHours(48)).ToUnixTimeMilliseconds() };
        if (fetched.HasValue) record["F"] = fetched.Value;
        File.WriteAllText(path, JsonSerializer.Serialize(new { V = 1, Entries = new[] { record } }));
        return path;
    }
    private string KnownLegacy()
    {
        var path = Legacy(fetched: clock.Now.UtcTicks);
        var text = File.ReadAllText(path).Replace((clock.Now + TimeSpan.FromHours(48)).ToUnixTimeMilliseconds().ToString(), (clock.Now + TimeSpan.FromHours(6)).ToUnixTimeMilliseconds().ToString());
        File.WriteAllText(path, text);
        return path;
    }
    public void Dispose() { if (Directory.Exists(root)) Directory.Delete(root, true); }

    [Fact]
    public async Task OneSnapshotRecordMayBeReplacedByACommittedNewerAnswer()
    {
        var path = KnownLegacy();
        using var net = Net();
        var disk = Disk();
        using var raw = Raw(net, disk, path);
        // Isolate the replacement branch: no automatic migration may save/retire the old record first.
        typeof(TmdbResponseCache).GetField("_nextDiskCheck", BindingFlags.NonPublic | BindingFlags.Instance)!.SetValue(raw, long.MaxValue);
        typeof(TmdbResponseCache).GetField("_diskOn", BindingFlags.NonPublic | BindingFlags.Instance)!.SetValue(raw, 1);
        var newer = await raw.GetAsync("movie/603", "", "key", default, refresh: true);
        await Drain(disk);
        Assert.Equal(0, (int)Field(raw, "_promoting"));
        var original = Assert.Single(((IEnumerable)Field(raw, "_legacy")).Cast<object>());
        Assert.Equal(0, (int)original.GetType().GetField("Saved")!.GetValue(original)!);
        Assert.True(File.Exists(path));
        Assert.False(File.Exists(path + ".migrated"));
        Assert.Equal(1, Files()); // exclusively the newer answer's completed save
        await raw.PromoteAsync();
        Assert.True(File.Exists(path + ".migrated"));
        Assert.False(File.Exists(path));
        Assert.Equal(1, Files());
        var restartedDisk = Disk();
        using var restarted = Raw(net, restartedDisk, path);
        Assert.True(await restarted.HydrateAsync("movie/603", "", "key", default));
        Assert.True(restarted.TryGetCached("movie/603", "", "key", out var saved));
        Assert.Equal(newer, saved);
        Assert.Contains("newer", saved.Content);
        Assert.Equal(1, net.Calls);
        await Drain(restartedDisk);
        await restartedDisk.PendingSweep;
    }

    [Fact]
    public async Task EleventhAttemptMaySaveMemoryButCannotRetireTheSnapshotUntilRestart()
    {
        var path = KnownLegacy();
        using var net = Net();
        var disk = Disk();
        var commits = 0;
        disk.Hook = point => { if (point == "commit") { commits++; throw new IOException("refused"); } };
        using var raw = Raw(net, disk, path);
        for (var i = 0; i < 10; i++) { clock.Now += TimeSpan.FromMinutes(1); await raw.PromoteAsync(); }
        Assert.Equal(10, commits);
        Assert.Equal(10, (int)Field(raw, "_migrationAttempts"));
        Assert.True(File.Exists(path));
        disk.Hook = point => { if (point == "commit") commits++; };
        clock.Now += TimeSpan.FromMinutes(1);
        await raw.PromoteAsync();
        Assert.Equal(11, commits);
        Assert.Equal(1, Files());
        Assert.True(File.Exists(path));
        Assert.False(File.Exists(path + ".migrated"));
        var nextDisk = Disk();
        using var restarted = Raw(net, nextDisk, path);
        await restarted.PromoteAsync();
        Assert.False(File.Exists(path));
        Assert.True(File.Exists(path + ".migrated"));
        Assert.Equal(0, net.Calls);
        await nextDisk.PendingSweep;
    }

    [Theory]
    [InlineData("movie/603", 200, 360)]
    [InlineData("search/movie?query=x", 200, 30)]
    [InlineData("movie/603", 404, 10)]
    public async Task MissingFetchTimeIsClampedToTheConsumerTtl(string route, int status, int minutes)
    {
        var path = Legacy(route, status); // deliberately omits F
        using var net = Net();
        var disk = Disk();
        using var raw = Raw(net, disk, path);
        var bits = route.Split('?', 2);
        var query = bits.Length == 2 ? "?" + bits[1] : "";
        Assert.True(raw.TryGetCached(bits[0], query, "key", out var response));
        Assert.Equal(DateTime.MinValue, response.FetchedAtUtc);
        clock.Now += TimeSpan.FromMinutes(minutes) - TimeSpan.FromMilliseconds(1);
        Assert.True(raw.TryGetCached(bits[0], query, "key", out _));
        clock.Now += TimeSpan.FromMilliseconds(2);
        Assert.False(raw.TryGetCached(bits[0], query, "key", out _));
        await raw.PromoteAsync();
        Assert.Equal(0, Files());
        await disk.PendingSweep;
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task MemoryHitMustNotWaitForStoreFolderPreparation(bool periodic)
    {
        var path = KnownLegacy();
        settings = settings with { Enabled = false };
        var observed = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var armed = false;
        var disk = Disk(() => { if (armed) observed.TrySetResult(); return settings; });
        using var net = Net();
        using var raw = Raw(net, disk, path);
        await disk.PendingSweep;
        if (periodic)
        {
            await raw.GetAsync("movie/603", "", "key", default);
            clock.Now += TimeSpan.FromSeconds(31);
        }
        using var held = new ManualResetEventSlim();
        using var release = new ManualResetEventSlim();
        var holder = new Thread(() => { lock (Field(disk, "_prepareLock")) { held.Set(); release.Wait(TimeSpan.FromSeconds(10)); } });
        holder.Start();
        Assert.True(held.Wait(TimeSpan.FromSeconds(3)));
        Task<TmdbResponseCache.TmdbResponse>? request = null;
        var blocked = false;
        var rawLockFree = false;
        var watch = Stopwatch.StartNew();
        try
        {
            settings = settings with { Enabled = true };
            armed = true;
            request = Task.Run(() => raw.GetAsync("movie/603", "", "key", default));
            await Task.WhenAny(observed.Task, request).WaitAsync(TimeSpan.FromSeconds(3));
            await Task.Delay(250);
            blocked = !request.IsCompleted;
            var rawLock = Field(raw, "_lock");
            rawLockFree = Monitor.TryEnter(rawLock, 100);
            if (rawLockFree) Monitor.Exit(rawLock);
        }
        finally
        {
            release.Set();
            holder.Join();
            if (request != null) await request.WaitAsync(TimeSpan.FromSeconds(5));
            await IntegrationTmdbDiskCacheTests.Until(() => (int)Field(raw, "_promoting") == 0);
            await Drain(disk);
            await disk.PendingSweep;
        }
        Assert.True(rawLockFree, "The raw memory lock must stay free during store preparation");
        Assert.False(blocked, $"Memory hit blocked on folder preparation (periodic={periodic}, elapsed={watch.ElapsedMilliseconds}ms, raw lock free={rawLockFree})");
        Assert.Equal(0, net.Calls);
    }

    [Fact]
    public async Task MemoryHitsCheckSettingsAtMostEveryThirtySeconds()
    {
        var path = KnownLegacy();
        settings = settings with { Enabled = false };
        var checks = 0;
        var disk = Disk(() => { Interlocked.Increment(ref checks); return settings; });
        using var net = Net();
        using var raw = Raw(net, disk, path);
        await disk.PendingSweep;
        var initial = checks;
        await raw.GetAsync("movie/603", "", "key", default);
        Assert.Equal(initial + 1, checks);
        for (var i = 0; i < 1000; i++) await raw.GetAsync("movie/603", "", "key", default);
        Assert.Equal(initial + 1, checks);
        clock.Now += TimeSpan.FromSeconds(29);
        await raw.GetAsync("movie/603", "", "key", default);
        Assert.Equal(initial + 1, checks);
        clock.Now += TimeSpan.FromSeconds(1);
        await raw.GetAsync("movie/603", "", "key", default);
        Assert.Equal(initial + 2, checks);
        Assert.Equal(0, net.Calls);
    }

    private static Placeholder Movie() => new() { Id = "p603", Kind = PlaceholderKinds.Movie, MediaType = "movie", TmdbId = 603, Title = "Movie" };
    private static IDictionary Flights(ListMetadataService service) => (IDictionary)Field(service, "_posterReads");

    [Fact]
    public async Task SixtyFifthWaiterCancelsOnlyItsOwnRead()
    {
        using var plugin = new ApiPluginFixture();
        plugin.Plugin.Configuration.TMDB_API_KEY = "key";
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var cancelled = 0;
        using var net = new IntegrationTransport(async (_, ct) =>
        {
            try { await release.Task.WaitAsync(ct); }
            catch (OperationCanceledException) { Interlocked.Increment(ref cancelled); throw; }
            return IntegrationTransport.Response("{\"id\":603,\"poster_path\":\"/a.jpg\"}");
        });
        var service = new ListMetadataService(net, plugin.Core.Logger);
        var group = Enumerable.Range(0, 64).Select(_ => service.ReadTmdbPosterAsync(Movie(), default)).ToArray();
        using var cts = new CancellationTokenSource();
        var overflow = service.ReadTmdbPosterAsync(Movie(), cts.Token);
        Assert.Equal(2, net.Calls);
        var shared = Assert.Single(Flights(service).Values.Cast<Task>());
        var flight = shared.AsyncState!;
        Assert.Equal(64, (int)flight.GetType().GetProperty("Waiters")!.GetValue(flight)!);
        cts.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => overflow);
        Assert.Equal(1, cancelled);
        Assert.False(shared.IsCompleted);
        Assert.Single(Flights(service));
        release.SetResult();
        Assert.All(await Task.WhenAll(group).WaitAsync(TimeSpan.FromSeconds(10)), x => Assert.Equal(("/a.jpg", true), x));
        Assert.Equal(2, net.Calls);
        Assert.Empty(Flights(service));
    }

    [Fact]
    public async Task LastCallerLeavingASlotHoldingReadLetsItFinishWithoutOrphanQueue()
    {
        using var plugin = new ApiPluginFixture();
        plugin.Plugin.Configuration.TMDB_API_KEY = "key";
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var cancelled = 0;
        using var net = new IntegrationTransport(async (_, ct) =>
        {
            try { await release.Task.WaitAsync(ct); }
            catch (OperationCanceledException) { Interlocked.Increment(ref cancelled); throw; }
            return IntegrationTransport.Response("{\"id\":603,\"poster_path\":\"/a.jpg\"}");
        });
        var service = new ListMetadataService(net, plugin.Core.Logger);
        using var cts = new CancellationTokenSource();
        var first = service.ReadTmdbPosterAsync(Movie(), cts.Token);
        Assert.Equal(1, net.Calls);
        var shared = Assert.Single(Flights(service).Values.Cast<Task>());
        cts.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => first);
        Assert.Single(Flights(service));
        Assert.False(shared.IsCompleted);
        Assert.Equal(0, cancelled);
        release.SetResult();
        await shared.WaitAsync(TimeSpan.FromSeconds(10));
        Assert.Empty(Flights(service));
        Assert.Equal(1, net.Calls);
        Assert.Equal(0, cancelled);
    }
}
