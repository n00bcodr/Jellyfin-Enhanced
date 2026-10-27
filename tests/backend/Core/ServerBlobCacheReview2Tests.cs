using System.Buffers.Binary;
using System.Linq.Expressions;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Jellyfin.Plugin.JellyfinEnhanced.Services.ServerCache;

namespace JE.Tests;

/// <summary>The probes that wrap the store's bound libc calls run alone.</summary>
[CollectionDefinition("Server cache native hooks", DisableParallelization = true)]
public sealed class ServerCacheNativeHooksCollection { }

/// <summary>
/// Regressions for the artwork disk-cache re-review (ACR2-1 to ACR2-6), ported from its variant probes: swaps right before
/// an anchored open, the marker and folder preparation kept confined, corrupt readers and JSON cleanup never removing a
/// replacement, a cancelled sweep keeping its totals, an undeletable orphan staying counted, the dedicated-folder check,
/// bounded I/O, header limits, a tightened age while a sweep runs, and descriptor hygiene.
/// </summary>
[Collection("Server cache native hooks")]
public sealed class ServerBlobCacheReview2Tests : IDisposable
{
    readonly string root = Path.Combine(Path.GetTempPath(), "je-acr2-" + Guid.NewGuid().ToString("N"));
    DateTime now = DateTime.UtcNow;
    ServerCacheSettings settings = new(true, "", 0, 0);
    string Own => Path.Combine(root, "plugins", "own");
    string Folder => Path.Combine(Own, "server-cache");
    ServerCacheLocation Location => new(Own, new[] { Path.Combine(root, "data"), Path.Combine(root, "plugins") }, Path.Combine(root, "cache"));
    ServerBlobCache Make(Func<DateTime>? clock = null) { var c = new ServerBlobCache(() => settings, Location, null, clock ?? (() => now)) { SweepDebounce = TimeSpan.Zero }; c.Register(new("artwork")); return c; }
    static string Hash(string key) => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes("artwork\n" + key)));
    string Blob(string key) => Path.Combine(Folder, "artwork", Hash(key)[..2], Hash(key) + ".blob");
    static Task<bool> Put(ServerBlobCache c, string key = "a", int size = 10) => c.PutAsync("artwork", key, new byte[size], "image/jpeg", CancellationToken.None);
    public void Dispose() { if (Directory.Exists(root)) Directory.Delete(root, true); }

    // Wrap the already-bound libc delegate. The callback swaps a path immediately before the real syscall;
    // all production validation and flags are otherwise unchanged. Restore even on failure.
    sealed class NativeWrap : IDisposable
    {
        readonly object lib; readonly FieldInfo field; readonly Delegate original;
        public NativeWrap(string name, Action<object?[]> before)
        {
            var t = typeof(ServerBlobCache).Assembly.GetType("Jellyfin.Plugin.JellyfinEnhanced.Services.ServerCache.LinuxFolderAccess")!;
            lib = t.GetField("Lib", BindingFlags.Static | BindingFlags.NonPublic)!.GetValue(null)!;
            field = lib.GetType().GetField(name, BindingFlags.Instance | BindingFlags.NonPublic)!;
            original = (Delegate)field.GetValue(lib)!;
            Func<object?[], object?> invoke = args => { before(args); return original.DynamicInvoke(args); };
            var method = field.FieldType.GetMethod("Invoke")!;
            var pars = method.GetParameters().Select(p => Expression.Parameter(p.ParameterType)).ToArray();
            var array = Expression.NewArrayInit(typeof(object), pars.Select(p => Expression.Convert(p, typeof(object))));
            var body = Expression.Convert(Expression.Invoke(Expression.Constant(invoke), array), method.ReturnType);
            field.SetValue(lib, Expression.Lambda(field.FieldType, body, pars).Compile());
        }
        public void Dispose() => field.SetValue(lib, original);
    }

    [Theory]
    [InlineData("root")]
    [InlineData("namespace")]
    [InlineData("shard")]
    [InlineData("entry")]
    public async Task LinuxSwapImmediatelyBeforeOpenIsRefused(string component)
    {
        var c = Make(); Assert.True(await Put(c)); await c.PendingSweep; Assert.True(c.Anchored);
        var source = component switch { "root" => Folder, "namespace" => Path.Combine(Folder, "artwork"), "shard" => Path.GetDirectoryName(Blob("a"))!, _ => Blob("a") };
        var outside = Path.Combine(root, "outside");
        var swapped = false;
        using (new NativeWrap(component == "root" ? "_open" : "_openAt", args => {
            var path = (string)args[component == "root" ? 0 : 1]!;
            if (swapped || path != (component == "root" ? Folder : Path.GetFileName(source))) return;
            swapped = true;
            if (component == "entry") { File.Move(source, outside); File.CreateSymbolicLink(source, outside); }
            else { Directory.Move(source, outside); Directory.CreateSymbolicLink(source, outside); }
        })) { Assert.Null(await c.TryGetAsync("artwork", "a", CancellationToken.None)); }
        Assert.True(swapped);
    }

    [Fact]
    public async Task MarkerSwapDuringIntactMustNotTouchExternalFile()
    {
        var c = Make(); Assert.True(await Put(c)); await c.PendingSweep;
        var marker = Path.Combine(Folder, ServerCacheLocation.MarkerName);
        var external = Path.Combine(root, "external"); File.WriteAllText(external, "private");
        var old = now.AddDays(-60); File.SetLastWriteTimeUtc(external, old);
        var armed = false; var swapped = false;
        c.Hook = point => { if (point == "counted") armed = true; };
        using (new NativeWrap("_open", args => {
            if (!armed || swapped || (string)args[0]! != Folder) return;
            swapped = true; File.Delete(marker); File.CreateSymbolicLink(marker, external);
        })) await c.SweepAsync(true, CancellationToken.None);
        c.Hook = null; Assert.True(swapped); Assert.Equal(old, File.GetLastWriteTimeUtc(external));
    }


    [Fact]
    public async Task RootSwapAfterMarkerIntactMustNotTouchExternalMarker()
    {
        var c = Make(); Assert.True(await Put(c)); await c.PendingSweep;
        var external = Path.Combine(root, "outside"); Directory.CreateDirectory(external);
        var marker = Path.Combine(external, ServerCacheLocation.MarkerName); File.WriteAllText(marker, "not this cache");
        var old = now.AddDays(-60); File.SetLastWriteTimeUtc(marker, old);
        var armed = false; var swapped = false;
        c.Hook = point => { if (point == "counted") armed = true; };
        using (new NativeWrap("_close", args => {
            if (!armed || swapped) return;
            var opened = new FileInfo("/proc/self/fd/" + args[0]).LinkTarget;
            if (opened != Folder) return;
            swapped = true; Directory.Move(Folder, Path.Combine(root, "original")); Directory.CreateSymbolicLink(Folder, external);
        })) await c.SweepAsync(true, CancellationToken.None);
        c.Hook = null; Assert.True(swapped); Assert.Equal(old, File.GetLastWriteTimeUtc(marker));
    }

    [Fact]
    public void PrepareMustRevalidateAResolvedFolderBeforeCreatingFiles()
    {
        var forbidden = Path.Combine(root, "data"); Directory.CreateDirectory(forbidden);
        Directory.CreateDirectory(Folder); var loc = Location;
        Assert.Null(loc.Resolve("", out var full));
        Directory.Move(Folder, Path.Combine(root, "old")); Directory.CreateSymbolicLink(Folder, forbidden);
        var error = loc.Prepare(full); Assert.Empty(Directory.EnumerateFileSystemEntries(forbidden)); Assert.NotNull(error);
    }


    [Fact]
    public void NonemptyForeignFolderMustNotBecomeDedicatedByItsDirectoryName()
    {
        var shared = Path.Combine(root, "cache", "shared");
        Directory.CreateDirectory(Path.Combine(shared, "documents"));
        File.WriteAllText(Path.Combine(shared, "documents", "notes.txt"), "someone else's data");
        var loc = Location; Assert.Null(loc.Resolve(shared, out var full));
        Assert.NotNull(loc.Prepare(full));
        Assert.False(File.Exists(Path.Combine(shared, ServerCacheLocation.MarkerName)));
    }


    [Fact]
    public async Task SweepMustNotDeleteFromAForeignFolderThatPrepareRefuses()
    {
        var shared = Path.Combine(root, "cache", "shared"); var shard = Path.Combine(shared, "artwork", "ab"); Directory.CreateDirectory(shard);
        File.WriteAllText(Path.Combine(shared, "unrelated.bin"), "foreign");
        var foreign = Path.Combine(shard, new string('a', 64) + ".blob"); File.WriteAllText(foreign, "someone else's file");
        var loc = Location; Assert.Null(loc.Resolve(shared, out var full)); Assert.NotNull(loc.Prepare(full));
        settings = settings with { Enabled = false, Folder = shared };
        var c = Make(); await c.SweepAsync(true, CancellationToken.None); await c.PendingSweep;
        Assert.True(File.Exists(foreign));
    }

    [Fact]
    public void SymlinkMarkerMustNotClaimANonemptyForeignFolder()
    {
        var shared = Path.Combine(root, "cache", "shared"); Directory.CreateDirectory(shared);
        File.WriteAllText(Path.Combine(shared, "unrelated.bin"), "foreign");
        var outside = Path.Combine(root, "external"); File.WriteAllText(outside, "not a cache marker");
        File.CreateSymbolicLink(Path.Combine(shared, ServerCacheLocation.MarkerName), outside);
        var loc = Location; Assert.Null(loc.Resolve(shared, out var full)); Assert.NotNull(loc.Prepare(full));
    }

    [Fact]
    public async Task CorruptReaderMustNotDeleteSameSizeSameTimeReplacement()
    {
        using var reached = new ManualResetEventSlim(); using var release = new ManualResetEventSlim(); var gate = 0;
        var c = Make(() => { if (Interlocked.CompareExchange(ref gate, 2, 1) == 1) { reached.Set(); if (!release.Wait(TimeSpan.FromSeconds(10))) throw new TimeoutException(); } return now; });
        Assert.True(await Put(c)); await c.PendingSweep;
        var bytes = File.ReadAllBytes(Blob("a")); bytes[0] = 0; File.WriteAllBytes(Blob("a"), bytes); File.SetLastWriteTimeUtc(Blob("a"), now);
        gate = 1; var reader = c.TryGetAsync("artwork", "a", CancellationToken.None);
        try { Assert.True(reached.Wait(TimeSpan.FromSeconds(10))); Assert.True(await Put(c)); } finally { release.Set(); }
        Assert.Null(await reader); Assert.NotNull(await c.TryGetAsync("artwork", "a", CancellationToken.None));
    }

    sealed class ReplacingConverter(Action replace) : JsonConverter<int>
    {
        public override int Read(ref Utf8JsonReader r, Type t, JsonSerializerOptions o) { replace(); throw new JsonException("old invalid value"); }
        public override void Write(Utf8JsonWriter w, int v, JsonSerializerOptions o) => w.WriteNumberValue(v);
    }
    [Fact]
    public async Task JsonCorruptionMustNotForgetAReplacementCommittedDuringDecode()
    {
        var c = Make(); Assert.True(await c.PutJsonAsync("artwork", "a", "invalid int", null, CancellationToken.None)); await c.PendingSweep;
        var options = new JsonSerializerOptions();
        options.Converters.Add(new ReplacingConverter(() => Assert.True(c.PutJsonAsync("artwork", "a", 7, null, CancellationToken.None).GetAwaiter().GetResult())));
        Assert.Null(await c.TryGetJsonAsync<int>("artwork", "a", options, CancellationToken.None));
        Assert.NotNull(await c.TryGetJsonAsync<int>("artwork", "a", null, CancellationToken.None));
    }

    [Fact]
    public async Task CancelledSweepMustNotDiscardUncountedEntries()
    {
        using var cancel = new CancellationTokenSource(); var armed = false;
        var c = Make(() => { if (armed) { armed = false; cancel.Cancel(); } return now; });
        Assert.True(await Put(c)); await c.PendingSweep; Assert.Equal(4096, c.CountedBytes);
        armed = true;
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => c.SweepAsync(true, cancel.Token));
        Assert.Equal(c.Usage().Bytes, c.CountedBytes);
    }

    [Fact]
    public async Task OrphanThatCannotBeRemovedMustRemainInCapacityAccounting()
    {
        if (OperatingSystem.IsWindows()) return;
        var c = Make(); Assert.True(await Put(c)); await c.PendingSweep;
        var dir = Path.GetDirectoryName(Blob("a"))!; var temp = Path.Combine(dir, Hash("a") + ".0123456789abcdef.tmp"); File.WriteAllBytes(temp, new byte[8192]);
        var mode = File.GetUnixFileMode(dir); File.SetUnixFileMode(dir, UnixFileMode.UserRead | UnixFileMode.UserExecute);
        try { await c.SweepAsync(false, CancellationToken.None); Assert.True(File.Exists(temp)); Assert.Equal(c.Usage().Bytes, c.CountedBytes); }
        finally { File.SetUnixFileMode(dir, mode); }
    }

    [Fact]
    public async Task ForgetMustFenceAnAlreadyQueuedWrite()
    {
        var c = Make(); Assert.True(c.Enabled); await c.PendingSweep;
        var sem = (SemaphoreSlim)typeof(ServerBlobCache).GetField("_io", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(c)!;
        for (int i = 0; i < ServerBlobCache.MaxConcurrentIo; i++) await sem.WaitAsync();
        var write = Put(c);
        try { await c.ForgetAsync("artwork", "a", CancellationToken.None); } finally { sem.Release(ServerBlobCache.MaxConcurrentIo); }
        Assert.False(await write); Assert.False(File.Exists(Blob("a")));
    }

    [Fact]
    public async Task ExactlyThe65thDiskOperationIsRefusedAndCapacityRecovers()
    {
        var c = Make(); Assert.True(c.Enabled); await c.PendingSweep;
        var sem = (SemaphoreSlim)typeof(ServerBlobCache).GetField("_io", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(c)!;
        for (int i = 0; i < ServerBlobCache.MaxConcurrentIo; i++) await sem.WaitAsync();
        var writes = Enumerable.Range(0, ServerBlobCache.MaxPendingIo).Select(i => Put(c, "w" + i)).ToArray();
        try { Assert.All(writes, t => Assert.False(t.IsCompleted)); Assert.Null(await c.TryGetAsync("artwork", "65th", CancellationToken.None)); Assert.False(await Put(c, "65th")); }
        finally { sem.Release(ServerBlobCache.MaxConcurrentIo); }
        Assert.All(await Task.WhenAll(writes), v => Assert.True(v)); Assert.True(await Put(c, "recovered"));
    }

    [Theory]
    [InlineData("key")]
    [InlineData("type")]
    [InlineData("body")]
    public async Task OversizeHeaderFieldsAndBodyAreMisses(string field)
    {
        var c = Make(); Assert.True(await Put(c)); await c.PendingSweep;
        var bytes = File.ReadAllBytes(Blob("a"));
        if (field == "key") BinaryPrimitives.WriteUInt16LittleEndian(bytes.AsSpan(5), ushort.MaxValue);
        if (field == "type") bytes[8] = 255;
        if (field == "body") BinaryPrimitives.WriteInt32LittleEndian(bytes.AsSpan(8 + 1 + "image/jpeg".Length + 24), int.MaxValue);
        File.WriteAllBytes(Blob("a"), bytes);
        Assert.Null(await c.TryGetAsync("artwork", "a", CancellationToken.None));
    }

    [Fact]
    public async Task TightenedAgeWhileReadIsHotAndSweepQueuedUsesFetchedTime()
    {
        var c = Make(); Assert.True(await Put(c)); await c.PendingSweep;
        now = now.AddDays(20); Assert.NotNull(await c.TryGetAsync("artwork", "a", CancellationToken.None));
        var once = false;
        c.Hook = point => { if (point != "counted" || once) return; once = true; settings = settings with { MaxAgeDays = 1 }; c.SettingsChanged(); };
        // Start a scheduled pass so the tighter request must be carried into its next iteration.
        settings = settings with { MaxBytes = 100000 }; c.SettingsChanged(); await c.PendingSweep; c.Hook = null;
        Assert.False(File.Exists(Blob("a")));
    }

    [Fact]
    public async Task FreshAndOldOrphansAreSweptButTheMarkerSurvives()
    {
        var c = Make(); Assert.True(await Put(c)); await c.PendingSweep;
        var dir = Path.GetDirectoryName(Blob("a"))!;
        var files = new[] { Path.Combine(dir, Hash("a") + ".0123456789abcdef.tmp"), Path.Combine(dir, Hash("a") + ".fedcba9876543210.tmp") };
        foreach (var file in files) File.WriteAllBytes(file, new byte[5000]); File.SetLastWriteTimeUtc(files[0], now.AddDays(-20));
        Assert.Equal(5 * 4096, c.Usage().Bytes); await c.SweepAsync(true, CancellationToken.None);
        Assert.All(files, file => Assert.False(File.Exists(file))); Assert.Equal(4096, c.CountedBytes); Assert.True(File.Exists(Path.Combine(Folder, ServerCacheLocation.MarkerName)));
    }


    [Fact]
    public void RemoveEmptyOnANonemptyDirectoryLeaksNoDescriptors()
    {
        Directory.CreateDirectory(Path.Combine(Folder, "artwork", "ab"));
        File.WriteAllText(Path.Combine(Folder, "artwork", "ab", "foreign.txt"), "keep");
        var access = CacheFolderAccess.For(Folder)!;
        int Count() => Directory.EnumerateFileSystemEntries("/proc/self/fd").Count();
        access.RemoveEmpty("artwork", "ab"); GC.Collect(); GC.WaitForPendingFinalizers();
        var before = Count();
        for (int i = 0; i < 200; i++) access.RemoveEmpty("artwork", "ab");
        var after = Count();
        GC.Collect(); GC.WaitForPendingFinalizers();
        Assert.True(after <= before + 2, $"descriptors before={before} after={after}");
    }

    [Fact]
    public async Task LinuxRepeatedSuccessFailureAndFifoOpensDoNotLeakDescriptors()
    {
        var c = Make(); Assert.True(await Put(c)); await c.PendingSweep;
        var access = CacheFolderAccess.For(Folder)!; var hash = Hash("a");
        var fifo = Path.Combine(Path.GetDirectoryName(Blob("a"))!, "fifo");
        Assert.Equal(0, MkFifo(fifo, 384));
        int Count() => Directory.EnumerateFileSystemEntries("/proc/self/fd").Count();
        for (int i = 0; i < 10; i++) { using var h = access.OpenRead("artwork", hash[..2], hash + ".blob"); }
        var before = Count();
        for (int i = 0; i < 1000; i++) { using var good = access.OpenRead("artwork", hash[..2], hash + ".blob"); using var bad = access.OpenRead("missing", "ab", "none"); using var pipe = access.OpenRead("artwork", hash[..2], "fifo"); Assert.Null(pipe); }
        Assert.True(Count() <= before + 2);
    }
    [System.Runtime.InteropServices.DllImport("libc", EntryPoint = "mkfifo", SetLastError = true)]
    static extern int MkFifo(string path, uint mode);
}
