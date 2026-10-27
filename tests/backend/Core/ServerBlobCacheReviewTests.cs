using System.Security.Cryptography;
using System.Text;
using Jellyfin.Plugin.JellyfinEnhanced.Services.ServerCache;

namespace JE.Tests;

/// <summary>
/// Regressions for the artwork disk-cache review (ACR-1 to ACR-8), ported from its probes: confinement across links
/// and a replaced folder (anchored and checked-path access alike), Forget and Clear against a commit, a reader never
/// removing a replacement, counts kept through a sweep, a lowered age limit, payload limits on read, bounded and shared
/// disk reads, temporary files counted and swept, and the dedicated folder in Jellyfin's cache folder.
/// </summary>
public sealed class ServerBlobCacheReviewTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "je-acr-" + Guid.NewGuid().ToString("N"));
    private DateTime _now = DateTime.UtcNow;
    private ServerCacheSettings _settings = new(true, "", 0, 0);

    private string Own => Path.Combine(_root, "plugins", "own");

    private string Folder => Path.Combine(Own, "server-cache");

    private ServerCacheLocation Location => new(Own, new[] { Path.Combine(_root, "data"), Path.Combine(_root, "plugins"), Path.Combine(_root, "cache", "temp") }, Path.Combine(_root, "cache"));

    private ServerBlobCache Make(Func<DateTime>? clock = null, bool anchored = true)
    {
        var result = new ServerBlobCache(() => _settings, Location, null, clock ?? (() => _now), anchored) { SweepDebounce = TimeSpan.Zero };
        result.Register(new("artwork"));
        return result;
    }

    private static string Hash(string key) => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes("artwork\n" + key)));

    private string Blob(string key) => Path.Combine(Folder, "artwork", Hash(key)[..2], Hash(key) + ".blob");

    private static Task<bool> Put(ServerBlobCache c, string key = "a", int length = 10) => c.PutAsync("artwork", key, new byte[length], "image/jpeg", CancellationToken.None);

    public void Dispose()
    {
        if (Directory.Exists(_root)) Directory.Delete(_root, true);
    }

    [Fact]
    public void LinuxUsesAnchoredAccess()
    {
        if (!OperatingSystem.IsLinux()) return;
        var c = Make();
        Assert.True(c.Enabled);
        Assert.True(c.Anchored);
        Assert.False(Make(anchored: false).Anchored);
    }

    [Fact]
    public void DockerPathsAndADedicatedFolderInJellyfinsCacheFolder()
    {
        var loc = new ServerCacheLocation("/config/plugins/configurations/Jellyfin.Plugin.JellyfinEnhanced",
            new[] { "/config", "/config/data", "/config/plugins", "/cache/temp", "/cache/images" }, "/cache");
        Assert.Null(loc.Resolve("", out var folder));
        Assert.Equal("/config/plugins/configurations/Jellyfin.Plugin.JellyfinEnhanced/server-cache", folder);
        // A dedicated folder in the cache folder is the recommended place for a large cache ...
        Assert.Null(loc.Resolve("/cache/je-server-cache", out folder));
        Assert.Equal("/cache/je-server-cache", folder);
        Assert.Null(loc.Resolve("/cache/jellyfin-enhanced/artwork-store", out _));
        // ... but never the cache folder itself, nor Jellyfin's own folders in it.
        Assert.Contains("inside it", loc.Resolve("/cache", out _));
        Assert.NotNull(loc.Resolve("/cache/temp", out _));
        Assert.NotNull(loc.Resolve("/cache/temp/je", out _));
        Assert.NotNull(loc.Resolve("/cache/images/je", out _));
        Assert.NotNull(loc.Resolve("/cache/transcodes", out _));
        Assert.NotNull(loc.Resolve("/config/je", out _));
        // Without a cache folder given (the earlier rule), it stays refused.
        Assert.NotNull(new ServerCacheLocation("/config/plugins/configurations/Jellyfin.Plugin.JellyfinEnhanced", new[] { "/config", "/cache" }).Resolve("/cache/je-server-cache", out _));
    }

    [Fact]
    public void AFolderInTheCacheFolderMustBeDedicated()
    {
        var cache = Path.Combine(_root, "cache");
        var loc = Location;
        var shared = Path.Combine(cache, "shared");
        Directory.CreateDirectory(shared);
        File.WriteAllText(Path.Combine(shared, "someone-elses.bin"), "x");
        Assert.Null(loc.Resolve(shared, out var full));
        Assert.Contains("other files", loc.Prepare(full));

        // New, empty, or already the cache's: prepared and marked.
        var mine = Path.Combine(cache, "jellyfin-enhanced");
        Assert.Null(loc.Resolve(mine, out full));
        Assert.Null(loc.Prepare(full));
        Assert.True(File.Exists(Path.Combine(mine, ServerCacheLocation.MarkerName)));
        File.Delete(Path.Combine(mine, ServerCacheLocation.MarkerName));
        Directory.CreateDirectory(Path.Combine(mine, "artwork", "ab"));
        Assert.Null(loc.Prepare(full)); // only the cache's own folders: still its
        Assert.True(File.Exists(Path.Combine(mine, ServerCacheLocation.MarkerName)));
    }

    [Fact]
    public async Task TheStoreRunsInADedicatedCacheFolderAndKeepsItsMarkerFresh()
    {
        var mine = Path.Combine(_root, "cache", "jellyfin-enhanced");
        _settings = _settings with { Folder = mine };
        var c = Make();
        Assert.True(await Put(c));
        var marker = Path.Combine(mine, ServerCacheLocation.MarkerName);
        File.SetLastWriteTimeUtc(marker, _now.AddDays(-40));
        await c.SweepAsync(full: true, CancellationToken.None);
        Assert.True(File.GetLastWriteTimeUtc(marker) > _now.AddDays(-1));
        Assert.NotNull(await c.TryGetAsync("artwork", "a", CancellationToken.None));
    }

    [Fact]
    public void ConfiguredAliasToForbiddenDirectoryMustBeRejected()
    {
        if (OperatingSystem.IsWindows()) return;
        var forbidden = Path.Combine(_root, "data");
        Directory.CreateDirectory(forbidden);
        var alias = Path.Combine(_root, "alias");
        Directory.CreateSymbolicLink(alias, forbidden);
        Assert.NotNull(Location.Resolve(alias, out _));
        Assert.NotNull(Location.Resolve(Path.Combine(alias, "inside"), out _));
        // A link to an allowed place resolves to that place, which is what the cache uses.
        var elsewhere = Path.Combine(_root, "disk", "je");
        Directory.CreateDirectory(elsewhere);
        var nice = Path.Combine(_root, "nice");
        Directory.CreateSymbolicLink(nice, elsewhere);
        Assert.Null(Location.Resolve(nice, out var full));
        Assert.Equal(elsewhere, full);
    }

    [Fact]
    public async Task TheDefaultFolderReplacedByALinkIntoJellyfinsFolderIsRefused()
    {
        if (OperatingSystem.IsWindows()) return;
        var forbidden = Path.Combine(_root, "data");
        Directory.CreateDirectory(forbidden);
        Directory.CreateDirectory(Own);
        Directory.CreateSymbolicLink(Folder, forbidden);
        var c = Make();
        Assert.False(await Put(c));
        Assert.Empty(Directory.EnumerateFileSystemEntries(forbidden));
        Assert.NotNull(c.Usage().FolderError);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task ReadMustNotFollowLinkedNamespace(bool anchored)
    {
        if (OperatingSystem.IsWindows()) return;
        var c = Make(anchored: anchored);
        Assert.True(await Put(c));
        await c.PendingSweep;
        var outside = Path.Combine(_root, "outside");
        Directory.Move(Path.Combine(Folder, "artwork"), outside);
        Directory.CreateSymbolicLink(Path.Combine(Folder, "artwork"), outside);
        Assert.Null(await c.TryGetAsync("artwork", "a", CancellationToken.None));
        Assert.True(File.Exists(Path.Combine(outside, Hash("a")[..2], Hash("a") + ".blob")));
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task ReadMustNotFollowALinkedShardOrEntry(bool anchored)
    {
        if (OperatingSystem.IsWindows()) return;
        var c = Make(anchored: anchored);
        Assert.True(await Put(c));
        Assert.True(await Put(c, "b"));
        await c.PendingSweep;
        var outside = Path.Combine(_root, "outside");
        Directory.CreateDirectory(outside);
        // "a": its shard is a link; "b": its file is a link to a valid entry kept elsewhere.
        var shardA = Path.GetDirectoryName(Blob("a"))!;
        Directory.Move(shardA, Path.Combine(outside, "shard"));
        Directory.CreateSymbolicLink(shardA, Path.Combine(outside, "shard"));
        File.Move(Blob("b"), Path.Combine(outside, "b.blob"));
        File.CreateSymbolicLink(Blob("b"), Path.Combine(outside, "b.blob"));
        Assert.Null(await c.TryGetAsync("artwork", "a", CancellationToken.None));
        Assert.Null(await c.TryGetAsync("artwork", "b", CancellationToken.None));
        Assert.True(File.Exists(Path.Combine(outside, "b.blob")));
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task ForgetMustNotDeleteThroughLinkedNamespace(bool anchored)
    {
        if (OperatingSystem.IsWindows()) return;
        var c = Make(anchored: anchored);
        Assert.True(await Put(c));
        await c.PendingSweep;
        var outside = Path.Combine(_root, "outside");
        Directory.Move(Path.Combine(Folder, "artwork"), outside);
        Directory.CreateSymbolicLink(Path.Combine(Folder, "artwork"), outside);
        Assert.False(await c.ForgetAsync("artwork", "a", CancellationToken.None));
        Assert.True(File.Exists(Path.Combine(outside, Hash("a")[..2], Hash("a") + ".blob")));
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task ClearAndSweepMustRejectRootThatBecameSymlink(bool anchored)
    {
        if (OperatingSystem.IsWindows()) return;
        var c = Make(anchored: anchored);
        Assert.True(await Put(c));
        await c.PendingSweep;
        var outside = Path.Combine(_root, "outside");
        Directory.Move(Folder, outside);
        Directory.CreateSymbolicLink(Folder, outside);
        await c.ClearAsync(null, CancellationToken.None);
        _settings = _settings with { MaxBytes = 1, MaxAgeDays = 1 };
        _now = _now.AddDays(5);
        await c.SweepAsync(full: true, CancellationToken.None);
        Assert.True(File.Exists(Path.Combine(outside, "artwork", Hash("a")[..2], Hash("a") + ".blob")));
        Assert.Null(await c.TryGetAsync("artwork", "a", CancellationToken.None));
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task RefusedLinkedNamespaceMustNotCreateShardOutside(bool anchored)
    {
        if (OperatingSystem.IsWindows()) return;
        var c = Make(anchored: anchored);
        Assert.True(c.Enabled);
        await c.PendingSweep;
        var outside = Path.Combine(_root, "outside");
        Directory.CreateDirectory(outside);
        Directory.CreateSymbolicLink(Path.Combine(Folder, "artwork"), outside);
        Assert.False(await Put(c));
        Assert.Empty(Directory.EnumerateFileSystemEntries(outside));
    }

    [Fact]
    public async Task ForgetIsOrderedAgainstACommitInProgress()
    {
        var c = Make();
        Task<bool>? forget = null;
        c.Hook = point =>
        {
            if (point != "commit" || forget != null) return;
            // Forget starts while the write is inside its commit: it must wait for it, then remove what it wrote.
            forget = Task.Run(() => c.ForgetAsync("artwork", "a", CancellationToken.None));
            Thread.Sleep(300);
        };
        Assert.True(await Put(c));
        Assert.NotNull(forget);
        await forget;
        c.Hook = null;
        Assert.Null(await c.TryGetAsync("artwork", "a", CancellationToken.None));
        Assert.False(File.Exists(Blob("a")));
    }

    [Fact]
    public async Task ExpiredReaderMustNotDeleteConcurrentFreshReplacement()
    {
        using var reached = new ManualResetEventSlim();
        using var release = new ManualResetEventSlim();
        var gate = 0;
        var c = Make(() =>
        {
            if (Interlocked.CompareExchange(ref gate, 2, 1) == 1)
            {
                reached.Set();
                if (!release.Wait(TimeSpan.FromSeconds(10))) throw new TimeoutException();
            }

            return _now;
        });
        Assert.True(await Put(c));
        await c.PendingSweep;
        _now = _now.AddDays(20);
        _settings = _settings with { MaxAgeDays = 30 };
        c.SettingsChanged();
        await c.PendingSweep;
        // Expire through the per-entry writer expiry without a settings-triggered sweep.
        Assert.True(await c.PutAsync("artwork", "a", new byte[10], "image/jpeg", CancellationToken.None, expiresAt: _now.AddHours(1)));
        _now = _now.AddHours(2);
        gate = 1;
        var reader = Task.Run(() => c.TryGetAsync("artwork", "a", CancellationToken.None));
        try
        {
            Assert.True(reached.Wait(TimeSpan.FromSeconds(10)));
            Assert.True(await Put(c));
        }
        finally
        {
            release.Set();
        }

        Assert.Null(await reader);
        Assert.NotNull(await c.TryGetAsync("artwork", "a", CancellationToken.None));
    }

    [Fact]
    public async Task AWriteCommittedWhileASweepCountsIsKeptInTheTotals()
    {
        var c = Make();
        Assert.True(await Put(c, "first"));
        await c.PendingSweep;
        c.Hook = point =>
        {
            if (point == "counted") Assert.True(Put(c, "during").GetAwaiter().GetResult());
        };
        await c.SweepAsync(full: false, CancellationToken.None);
        c.Hook = null;
        Assert.Equal(2 * 4096, c.CountedBytes);
        Assert.Equal(c.Usage().Bytes, c.CountedBytes);

        // So a cap of two entries is enforced on the third write, not missed.
        _settings = _settings with { MaxBytes = 2 * 4096 };
        c.SettingsChanged();
        await c.PendingSweep;
        _now = _now.AddMinutes(1);
        Assert.True(await Put(c, "third"));
        await c.PendingSweep;
        Assert.True(c.Usage().Bytes <= 2 * 4096);
    }

    [Fact]
    public async Task LoweredAgeMustSweepRecentlyTouchedOldEntries()
    {
        var c = Make();
        Assert.True(await Put(c));
        await c.PendingSweep;
        _now = _now.AddDays(20);
        Assert.NotNull(await c.TryGetAsync("artwork", "a", CancellationToken.None));
        _settings = _settings with { MaxAgeDays = 1 };
        c.SettingsChanged();
        await c.PendingSweep;
        Assert.False(File.Exists(Blob("a")));
    }

    [Fact]
    public async Task ALoweredNamespaceCapIsSweptAtOnce()
    {
        var c = Make();
        for (var i = 0; i < 4; i++)
        {
            _now = _now.AddMinutes(1);
            Assert.True(await Put(c, "k" + i));
        }

        await c.PendingSweep;
        c.Register(new("artwork", MaxBytes: 2 * 4096));
        await c.PendingSweep;
        Assert.Equal(1, c.Usage().Files);
    }

    [Fact]
    public async Task NamespacePayloadLimitMustBeCheckedOnRead()
    {
        var c = Make();
        Assert.True(await Put(c, length: 500));
        await c.PendingSweep;
        c.Register(new("artwork", MaxEntryBytes: 100));
        Assert.Null(await c.TryGetAsync("artwork", "a", CancellationToken.None));
    }

    [Fact]
    public async Task DiskReadsAreBoundedAndOneEntryIsReadOnceForEveryWaitingCaller()
    {
        var c = Make();
        for (var i = 0; i < 3; i++) Assert.True(await Put(c, "k" + i));
        await c.PendingSweep;
        // The held reads each block a pool thread: make room for them so the bound, not thread injection, is measured.
        ThreadPool.GetMinThreads(out var workers, out var ports);
        ThreadPool.SetMinThreads(Math.Max(workers, ServerBlobCache.MaxPendingIo + 32), ports);
        using var release = new ManualResetEventSlim();
        var started = 0;
        c.Hook = point =>
        {
            if (point != "read") return;
            Interlocked.Increment(ref started);
            release.Wait(TimeSpan.FromSeconds(10));
        };
        // Ten callers of one entry share one read.
        var same = Enumerable.Range(0, 10).Select(_ => c.TryGetAsync("artwork", "k0", CancellationToken.None)).ToList();
        // Distinct entries beyond the bound are misses at once instead of waiting without limit.
        var many = Enumerable.Range(0, ServerBlobCache.MaxPendingIo + 20).Select(i => c.TryGetAsync("artwork", "other" + i, CancellationToken.None)).ToList();
        var refused = many.Count(t => t.IsCompleted && t.Result == null);
        Assert.True(refused >= 20, $"{refused} refused");
        // A write over the bound is skipped (its bytes aren't kept waiting).
        Assert.False(await Put(c, "late"));
        for (var i = 0; i < 500 && Volatile.Read(ref started) < ServerBlobCache.MaxPendingIo; i++) await Task.Delay(20);
        Assert.Equal(ServerBlobCache.MaxPendingIo, Volatile.Read(ref started));
        release.Set();
        Assert.All(await Task.WhenAll(same), e => Assert.NotNull(e));
        await Task.WhenAll(many);
        c.Hook = null;
        ThreadPool.SetMinThreads(workers, ports);
        Assert.True(await Put(c, "late"));
    }

    [Fact]
    public async Task TemporaryFilesMustContributeToDiskUsage()
    {
        var c = Make();
        Assert.True(await Put(c));
        await c.PendingSweep;
        var path = Blob("a");
        var temp = Path.Combine(Path.GetDirectoryName(path)!, Hash("a") + ".0123456789abcdef.tmp");
        File.WriteAllBytes(temp, new byte[8192]);
        Assert.Equal(12288, c.Usage().Bytes);
    }

    [Fact]
    public async Task AnInterruptedWritesTemporaryFileIsRemovedAtStartup()
    {
        var shard = Path.Combine(Folder, "artwork", "ab");
        Directory.CreateDirectory(shard);
        var orphan = Path.Combine(shard, new string('a', 64) + ".0123456789abcdef.tmp");
        File.WriteAllBytes(orphan, new byte[100]);
        var c = Make();
        Assert.True(c.Enabled); // first use: the startup sweep
        await c.PendingSweep;
        Assert.False(File.Exists(orphan));
    }

    [Fact]
    public async Task AWriteUnderWayCountsTowardTheCapAndItsTemporaryFileIsNotSwept()
    {
        var c = Make();
        await c.PendingSweep;
        long during = 0;
        var tempsDuring = 0;
        c.Hook = point =>
        {
            if (point != "commit") return;
            during = c.CountedBytes;
            c.SweepAsync(full: true, CancellationToken.None).GetAwaiter().GetResult();
            tempsDuring = Directory.EnumerateFiles(Folder, "*.tmp", SearchOption.AllDirectories).Count();
        };
        Assert.True(await Put(c, "a", 5000));
        c.Hook = null;
        Assert.Equal(2 * 4096, during);
        Assert.Equal(1, tempsDuring);
        Assert.Equal(2 * 4096, c.CountedBytes);
        Assert.NotNull(await c.TryGetAsync("artwork", "a", CancellationToken.None));
    }
}
