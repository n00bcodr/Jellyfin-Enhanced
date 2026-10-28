using System.Linq.Expressions;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using Jellyfin.Plugin.JellyfinEnhanced.Services.ServerCache;

namespace JE.Tests;

/// <summary>
/// The artwork disk-cache review round 3 probes (ACR3-1..4), ported from the reviewer's clone: ownership is proven on the
/// handle each change uses, listings never follow a link at any level, an unreadable folder never publishes a smaller
/// recount, and a leftover temporary file counts towards both caps. Two probes drove private code that no longer
/// exists in that shape (the fourth path open in Prepare, the path-based listing iterator); they keep their
/// interleaving and assertions on the equivalent native call instead (see the comments on each).
/// </summary>
[Collection("Server cache native hooks")]
public sealed class ServerBlobCacheReview3Tests : IDisposable
{
    readonly string root = Path.Combine(Path.GetTempPath(), "acr3-" + Guid.NewGuid().ToString("N"));
    DateTime now = DateTime.UtcNow;
    ServerCacheSettings settings = new(true, "", 0, 0);
    string Own => Path.Combine(root, "plugins", "own");
    string Folder => Path.Combine(Own, "server-cache");
    string Marker => Path.Combine(Folder, ServerCacheLocation.MarkerName);
    ServerCacheLocation Location => new(Own, new[] { Path.Combine(root, "data"), Path.Combine(root, "plugins") }, Path.Combine(root, "cache"));
    ServerBlobCache Make(Func<DateTime>? clock = null) { var c = new ServerBlobCache(() => settings, Location, null, clock ?? (() => now)) { SweepDebounce = TimeSpan.Zero }; c.Register(new("artwork")); return c; }
    static string Hash(string key) => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes("artwork\n" + key)));
    string Blob(string key) => Path.Combine(Folder, "artwork", Hash(key)[..2], Hash(key) + ".blob");
    static Task<bool> Put(ServerBlobCache c, string key = "a", int size = 10) => c.PutAsync("artwork", key, new byte[size], "image/jpeg", CancellationToken.None);
    public void Dispose() { if (Directory.Exists(root)) Directory.Delete(root, true); }

    sealed class NativeWrap : IDisposable
    {
        readonly object lib; readonly FieldInfo field; readonly Delegate original;
        public NativeWrap(string name, Func<object?[], Func<object?>, object?> invoke)
        {
            var t = typeof(ServerBlobCache).Assembly.GetType("Jellyfin.Plugin.JellyfinEnhanced.Services.ServerCache.LinuxFolderAccess")!;
            lib = t.GetField("Lib", BindingFlags.Static | BindingFlags.NonPublic)!.GetValue(null)!;
            field = lib.GetType().GetField(name, BindingFlags.Instance | BindingFlags.NonPublic)!;
            original = (Delegate)field.GetValue(lib)!;
            Func<object?[], object?> call = args => invoke(args, () => original.DynamicInvoke(args));
            var method = field.FieldType.GetMethod("Invoke")!;
            var pars = method.GetParameters().Select(p => Expression.Parameter(p.ParameterType)).ToArray();
            var array = Expression.NewArrayInit(typeof(object), pars.Select(p => Expression.Convert(p, typeof(object))));
            var body = Expression.Convert(Expression.Invoke(Expression.Constant(call), array), method.ReturnType);
            field.SetValue(lib, Expression.Lambda(field.FieldType, body, pars).Compile());
        }
        public void Dispose() => field.SetValue(lib, original);
    }

    string Foreign(string path)
    {
        Directory.CreateDirectory(Path.Combine(path, "artwork", "ab"));
        File.WriteAllText(Path.Combine(path, "unrelated.txt"), "not owned by the store");
        var file = Path.Combine(path, "artwork", "ab", new string('a', 64) + ".blob");
        File.WriteAllText(file, "foreign shaped data");
        return Path.GetRelativePath(path, file);
    }

    [Theory]
    [InlineData("clear")]
    [InlineData("sweep")]
    public async Task PreparedRootReplacedByUnmarkedRealDirectoryMustBeRefused(string operation)
    {
        var c = Make(); Assert.True(await Put(c)); await c.PendingSweep;
        Directory.Move(Folder, Path.Combine(root, "old-cache"));
        var foreign = Foreign(Folder);
        Assert.NotNull(Location.Prepare(Folder));
        if (operation == "clear") await c.ClearAsync(null, CancellationToken.None);
        else await c.SweepAsync(true, CancellationToken.None);
        Assert.True(File.Exists(Path.Combine(Folder, foreign)), "maintenance removed a file from a refused, unmarked replacement folder");
    }

    [Theory]
    [InlineData("wrong")]
    [InlineData("symlink")]
    public async Task PreparedMarkerInvalidationMustRefuseMaintenance(string replacement)
    {
        var c = Make(); Assert.True(await Put(c)); await c.PendingSweep;
        var foreign = Foreign(Folder);
        File.Delete(Marker);
        if (replacement == "wrong") File.WriteAllText(Marker, "not a cache marker");
        else { var ext = Path.Combine(root, "outside-marker"); File.WriteAllText(ext, ServerCacheLocation.MarkerText); File.CreateSymbolicLink(Marker, ext); }
        Assert.NotNull(Location.Prepare(Folder));
        await c.SweepAsync(true, CancellationToken.None);
        Assert.True(File.Exists(Path.Combine(Folder, foreign)), "maintenance ran after the verified marker was lost");
    }

    [Fact]
    public async Task SwapAfterUncachedMaintenanceMarkerGateMustNotDeleteForeignData()
    {
        Directory.CreateDirectory(Folder); File.WriteAllText(Marker, ServerCacheLocation.MarkerText);
        settings = settings with { Enabled = false };
        var armed = false;
        var foreignRoot = Path.Combine(root, "foreign"); var foreign = Foreign(foreignRoot);
        var c = Make(() => { if (armed) { armed = false; Directory.Move(Folder, Path.Combine(root, "old-cache")); Directory.Move(foreignRoot, Folder); } return now; });
        await c.SweepAsync(false, CancellationToken.None); await c.PendingSweep;
        armed = true; await c.SweepAsync(true, CancellationToken.None);
        Assert.False(armed);
        Assert.True(File.Exists(Path.Combine(Folder, foreign)), "a fresh marker gate did not hold the validated directory through the sweep");
    }

    // Port: Prepare no longer reopens the folder by its path for the marker (that reopen was the fourth open of the
    // folder this probe swapped before); the swap now comes immediately before the marker's creation call itself, the
    // same point between the emptiness check and the marker. The assertions are unchanged.
    [Fact]
    public void SwapBetweenEmptyCheckAndMarkerCreationMustRefuseForeignFolder()
    {
        Directory.CreateDirectory(Folder);
        var foreignRoot = Path.Combine(root, "foreign"); Foreign(foreignRoot);
        var swapped = false;
        Assert.True(CacheFolderAccess.Supported);
        string? error;
        using (new NativeWrap("_openAt", (args, next) => {
            if (!swapped && (string)args[1]! == ServerCacheLocation.MarkerName && ((int)args[2]! & 0x40) != 0) { swapped = true; Directory.Move(Folder, Path.Combine(root, "old-empty")); Directory.Move(foreignRoot, Folder); }
            return next();
        })) error = Location.Prepare(Folder);
        Assert.True(swapped, "did not exercise the marker creation reopen");
        Assert.NotNull(error);
        Assert.False(File.Exists(Marker), "Prepare marked the nonempty replacement without checking it");
    }

    [Fact]
    public async Task PreparedRootReplacedBeforeWriteMustNotWriteIntoForeignFolder()
    {
        var c = Make(); Assert.True(c.Enabled); await c.PendingSweep;
        Directory.Move(Folder, Path.Combine(root, "old-cache")); Foreign(Folder);
        Assert.False(await Put(c), "cached preparation accepted a nonempty unmarked replacement");
        Assert.False(File.Exists(Blob("a")));
    }

    [Fact]
    public async Task MarkerLossRefusesRestartedCacheWithoutDeletingItsData()
    {
        var c = Make(); Assert.True(await Put(c)); await c.PendingSweep;
        File.Delete(Marker);
        var restarted = Make(); Assert.False(restarted.Enabled); await restarted.PendingSweep;
        Assert.Contains("other files", restarted.Usage().FolderError);
        Assert.True(File.Exists(Blob("a")));
        Assert.Equal(0, await restarted.ClearAsync(null, CancellationToken.None));
        Assert.Equal(0, await restarted.SweepAsync(true, CancellationToken.None));
        Assert.True(File.Exists(Blob("a")));
    }

    [Fact]
    public async Task UndeletableOrphanMustCountInGlobalEvictionDecision()
    {
        var c = Make(); Assert.True(await Put(c)); await c.PendingSweep;
        var dir = Path.GetDirectoryName(Blob("a"))!;
        var temp = Path.Combine(dir, Hash("a") + ".0123456789abcdef.tmp"); File.WriteAllBytes(temp, new byte[8192]);
        var second = "b"; Assert.NotEqual(Hash("a")[..2], Hash(second)[..2]); Assert.True(await Put(c, second)); await c.PendingSweep;
        var mode = File.GetUnixFileMode(dir); File.SetUnixFileMode(dir, UnixFileMode.UserRead | UnixFileMode.UserExecute);
        try
        {
            settings = settings with { MaxBytes = 3 * 4096 }; c.SettingsChanged(); await c.PendingSweep;
            Assert.True(File.Exists(temp));
            Assert.Equal(c.Usage().Bytes, c.CountedBytes);
            Assert.False(File.Exists(Blob(second)), "an evictable blob survived even though counted temp storage put the cache over cap");
        }
        finally { File.SetUnixFileMode(dir, mode); }
    }

    [Fact]
    public async Task UndeletableOrphanMustCountInNamespaceEvictionDecision()
    {
        var c = Make(); Assert.True(await Put(c)); await c.PendingSweep;
        var dir = Path.GetDirectoryName(Blob("a"))!;
        var temp = Path.Combine(dir, Hash("a") + ".0123456789abcdef.tmp"); File.WriteAllBytes(temp, new byte[8192]);
        Assert.True(await Put(c, "b")); await c.PendingSweep;
        var mode = File.GetUnixFileMode(dir); File.SetUnixFileMode(dir, UnixFileMode.UserRead | UnixFileMode.UserExecute);
        try
        {
            c.Register(new("artwork", MaxBytes: 3 * 4096)); await c.PendingSweep;
            Assert.Equal(c.Usage().Bytes, c.CountedBytes);
            Assert.False(File.Exists(Blob("b")), "namespace eviction omitted surviving temp storage");
        }
        finally { File.SetUnixFileMode(dir, mode); }
    }

    [Theory]
    [InlineData("shard")]
    [InlineData("namespace")]
    public async Task UnreadableEnumerationMustNotPublishZeroUsage(string component)
    {
        var c = Make(); Assert.True(await Put(c)); await c.PendingSweep;
        var dir = component == "shard" ? Path.GetDirectoryName(Blob("a"))! : Path.Combine(Folder, "artwork");
        var mode = File.GetUnixFileMode(dir); File.SetUnixFileMode(dir, UnixFileMode.UserExecute);
        long counted;
        try { await c.SweepAsync(true, CancellationToken.None); counted = c.CountedBytes; }
        finally { File.SetUnixFileMode(dir, mode); }
        Assert.True(File.Exists(Blob("a")));
        Assert.Equal(c.Usage().Bytes, counted);
    }

    [Fact]
    public async Task CancellationAfterARealDeletionKeepsRemainingAccounting()
    {
        var c = Make(); Assert.True(await Put(c)); Assert.True(await Put(c, "b")); await c.PendingSweep;
        Assert.Equal(8192, c.CountedBytes);
        // Make both files corrupt so the first deletion happens before cancellation is observed for the second.
        File.WriteAllText(Blob("a"), "broken"); File.WriteAllText(Blob("b"), "broken");
        using var cancel = new CancellationTokenSource(); var deleted = false;
        using (new NativeWrap("_unlinkAt", (args, next) => {
            var r = next();
            // The delegates are process-wide: background sweeps from an earlier test aren't this probe's deletion.
            var directory = new FileInfo("/proc/self/fd/" + args[0]).LinkTarget;
            if ((int)r! == 0 && ((string)args[1]!).EndsWith(".blob") && directory?.StartsWith(Folder + "/", StringComparison.Ordinal) == true)
            { deleted = true; cancel.Cancel(); }
            return r;
        }))
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => c.SweepAsync(true, cancel.Token));
        Assert.True(deleted); Assert.Equal(4096, c.CountedBytes); Assert.Equal(c.Usage().Bytes, c.CountedBytes);
        await c.SweepAsync(true, CancellationToken.None); Assert.Equal(0, c.CountedBytes);
    }

    [Theory]
    [InlineData(4)] // EINTR
    [InlineData(11)] // EAGAIN
    public async Task TransientNativeReadRefusalIsAMissAndReleasesDescriptors(int errno)
    {
        var c = Make(); Assert.True(await Put(c)); await c.PendingSweep;
        int Count() => Directory.EnumerateFileSystemEntries("/proc/self/fd").Count();
        var before = Count();
        using (new NativeWrap("_openAt", (args, next) => { if ((string)args[1]! == Hash("a") + ".blob") { Marshal.SetLastPInvokeError(errno); return -1; } return next(); }))
        {
            for (var i = 0; i < 100; i++) Assert.Null(await c.TryGetAsync("artwork", "a", CancellationToken.None));
        }
        Assert.True(Count() <= before + 2);
        Assert.NotNull(await c.TryGetAsync("artwork", "a", CancellationToken.None));
    }

    [Fact]
    public async Task ReplacementAfterCorruptBodyReadMustSurviveCleanup()
    {
        using var reached = new ManualResetEventSlim(); using var release = new ManualResetEventSlim(); var gate = 0;
        var c = Make(() => { if (Interlocked.CompareExchange(ref gate, 2, 1) == 1) { reached.Set(); if (!release.Wait(TimeSpan.FromSeconds(15))) throw new TimeoutException(); } return now; });
        Assert.True(await Put(c, size: 800)); await c.PendingSweep;
        // A readable header with a truncated body exercises the non-null write-ID branch.
        using (var f = new FileStream(Blob("a"), FileMode.Open, FileAccess.Write)) f.SetLength(400);
        gate = 1; var read = c.TryGetAsync("artwork", "a", CancellationToken.None);
        try { Assert.True(reached.Wait(TimeSpan.FromSeconds(15))); Assert.True(await Put(c, size: 1000)); } finally { release.Set(); }
        Assert.Null(await read); Assert.Equal(1000, (await c.TryGetAsync("artwork", "a", CancellationToken.None))!.Bytes.Length);
    }

    [Fact]
    public async Task RepeatedSweepsAndClearDoNotRetainDirectoryHandles()
    {
        var c = Make(); Assert.True(await Put(c)); await c.PendingSweep;
        int Count() => Directory.EnumerateFileSystemEntries("/proc/self/fd").Count();
        await c.SweepAsync(true, CancellationToken.None); var before = Count();
        for (var i = 0; i < 100; i++) { await c.SweepAsync(true, CancellationToken.None); await c.ClearAsync("other", CancellationToken.None); c.Usage(); }
        Assert.True(Count() <= before + 2);
    }

    // Port: the listing no longer materialises checked directory paths and iterates them later; each namespace and
    // shard folder is opened from its parent's handle and listed through its own. The probe keeps its interleaving (a
    // later directory is replaced by a link to an external folder while the listing runs, immediately before or after
    // that directory is opened) and its assertion that no external file is counted, now through Usage and a recount.
    [Theory]
    [InlineData("shard", "before")]
    [InlineData("shard", "after")]
    [InlineData("namespace", "before")]
    [InlineData("namespace", "after")]
    public async Task EnumerationMustNotFollowDirectoryLinkSwappedAfterItsCheck(string component, string when)
    {
        var c = Make(); Assert.True(c.Enabled); await c.PendingSweep;
        string first, second;
        if (component == "shard")
        {
            Directory.CreateDirectory(Path.Combine(Folder, "artwork", "aa"));
            Directory.CreateDirectory(Path.Combine(Folder, "artwork", "bb"));
            var dirs = Directory.GetDirectories(Path.Combine(Folder, "artwork")); first = dirs[0]; second = dirs[1];
        }
        else
        {
            Directory.CreateDirectory(Path.Combine(Folder, "artwork", "aa"));
            Directory.CreateDirectory(Path.Combine(Folder, "metadata", "aa"));
            var dirs = Directory.GetDirectories(Folder); first = Path.Combine(dirs[0], "aa"); second = dirs[1];
        }
        File.WriteAllText(Path.Combine(first, new string('a', 64) + ".blob"), "local");
        var outside = Path.Combine(root, "outside");
        var externalShard = component == "namespace" ? Path.Combine(outside, "aa") : outside;
        Directory.CreateDirectory(externalShard);
        File.WriteAllBytes(Path.Combine(externalShard, new string('b', 64) + ".blob"), new byte[8192]);
        var swapped = false;
        void Swap() { swapped = true; Directory.Move(second, Path.Combine(root, "old-directory")); Directory.CreateSymbolicLink(second, outside); }
        ServerCacheUsage usage;
        using (new NativeWrap("_openAt", (args, next) => {
            var mine = !swapped && (string)args[1]! == Path.GetFileName(second);
            if (mine && when == "before") Swap();
            var result = next();
            if (mine && when == "after") Swap();
            return result;
        })) usage = c.Usage();
        Assert.True(swapped, "the listing never reached the swapped directory");
        Assert.True(usage.Bytes < 8192, "production enumeration followed the swapped directory link and sampled the external file");
        await c.SweepAsync(false, CancellationToken.None);
        Assert.True(c.CountedBytes < 8192, "the recount followed the swapped directory link and sampled the external file");
        Assert.True(File.Exists(Path.Combine(externalShard, new string('b', 64) + ".blob")));
    }
}
