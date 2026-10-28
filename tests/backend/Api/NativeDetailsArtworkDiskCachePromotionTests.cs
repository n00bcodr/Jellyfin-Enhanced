#if JF12
using System.Collections.Concurrent;
using System.Net;
using System.Reflection;
using Jellyfin.Plugin.JellyfinEnhanced.Services.NativeDetails;
using Jellyfin.Plugin.JellyfinEnhanced.Services.ServerCache;

namespace JE.Tests;

/// <summary>The artwork promotion probes hold the store's I/O permits and pause its settings reader, so they run alone.</summary>
[CollectionDefinition("Server cache artwork promotion", DisableParallelization = true)]
public sealed class ServerCacheArtworkPromotionCollection { }

/// <summary>
/// Regressions for the artwork delta review (ACR4-1), ported from its probes: an image's save from memory carries the
/// generation from before its fetch, so a Clear, Forget, switch-off or folder change in between, before its first save
/// or before a later promotion, keeps it off the disk for good; saves skipped for an ordinary reason (cap, busy disk)
/// are still tried again, once, under the original namespace, key and fetch time.
/// </summary>
[Collection("Server cache artwork promotion")]
public sealed class NativeDetailsArtworkDiskCachePromotionTests : IDisposable
{
    readonly string root = Path.Combine(Path.GetTempPath(), "je-acr4-" + Guid.NewGuid().ToString("N"));
    ServerCacheSettings settings = new(false, "", 0, 0);
    DateTime now = DateTime.UtcNow.AddHours(2);
    const string PathA = "/poster.jpg";
    const string KeyA = "w500/poster.jpg";
    int sends;
    Action? settingsRead;
    static readonly byte[] Jpeg = { 0xff, 0xd8, 0xff, 0xe0, 1, 2, 3 };
    ServerBlobCache Disk()
        => new(() => { settingsRead?.Invoke(); return settings; }, new ServerCacheLocation(root, Array.Empty<string>()), null, () => now) { SweepDebounce = TimeSpan.Zero };
    IntegrationTransport Network(Task? gate = null) => new(async (_, _) => {
        Interlocked.Increment(ref sends);
        if (gate != null) await gate;
        var response = new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(Jpeg) };
        response.Content.Headers.ContentType = new("image/jpeg");
        return response;
    });
    static SemaphoreSlim Io(ServerBlobCache disk) => (SemaphoreSlim)typeof(ServerBlobCache).GetField("_io", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(disk)!;
    static ConcurrentDictionary<string, (byte[] Bytes, string ContentType, DateTime At, bool OnDisk, long Generation)> Memory(NativeDetailsArtwork artwork)
        => (ConcurrentDictionary<string, (byte[] Bytes, string ContentType, DateTime At, bool OnDisk, long Generation)>)typeof(NativeDetailsArtwork).GetField("_bytes", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(artwork)!;
    static Task<(byte[] Bytes, string ContentType)?> Fetch(NativeDetailsArtwork a) => a.FetchAsync(PathA, "w500", Guid.NewGuid(), CancellationToken.None);
    public void Dispose() { if (Directory.Exists(root)) Directory.Delete(root, true); }

    [Theory]
    [InlineData("clear")]
    [InlineData("forget")]
    [InlineData("folder")]
    public async Task InvalidationAfterTheMemoryClaimButBeforePutCapturesItsGenerationMustFenceTheSave(string action)
    {
        var disk = Disk(); using var network = Network();
        var artwork = new NativeDetailsArtwork(network, null, null, disk);
        Assert.NotNull(await Fetch(artwork));
        settings = settings with { Enabled = true }; disk.SettingsChanged();
        Assert.True(disk.Enabled); await disk.PendingSweep;
        using var entered = new ManualResetEventSlim();
        using var release = new ManualResetEventSlim();
        int first = 0;
        settingsRead = () => {
            if (Interlocked.Exchange(ref first, 1) != 0) return;
            entered.Set();
            if (!release.Wait(TimeSpan.FromSeconds(10))) throw new TimeoutException();
        };
        var save = Task.Run(() => Fetch(artwork));
        try
        {
            Assert.True(entered.Wait(TimeSpan.FromSeconds(10))); // PersistAsync claimed the old memory entry; PutAsync is at Current()
            if (action == "clear") await disk.ClearAsync(null, CancellationToken.None);
            else if (action == "forget") await disk.ForgetAsync("artwork", KeyA, CancellationToken.None);
            else { settings = settings with { Folder = Path.Combine(root, "moved") }; disk.SettingsChanged(); }
        }
        finally { release.Set(); }
        Assert.NotNull(await save.WaitAsync(TimeSpan.FromSeconds(10)));
        settingsRead = null;
        await disk.PendingSweep;
        Assert.Equal(1, sends);
        Assert.Equal(0, disk.Usage().Files);
    }

    [Theory]
    [InlineData("clear")]
    [InlineData("forget")]
    [InlineData("disable")]
    [InlineData("folder")]
    public async Task InvalidatedMemorySaveMustStayInvalidatedOnTheNextMemoryHit(string action)
    {
        var disk = Disk(); using var network = Network();
        var artwork = new NativeDetailsArtwork(network, null, null, disk);
        Assert.NotNull(await Fetch(artwork));
        settings = settings with { Enabled = true }; disk.SettingsChanged();
        Assert.True(disk.Enabled); await disk.PendingSweep;
        var oldFolder = disk.Usage().Folder;
        var io = Io(disk);
        for (int i = 0; i < ServerBlobCache.MaxConcurrentIo; i++) await io.WaitAsync();
        Task<(byte[] Bytes, string ContentType)?> write;
        try
        {
            write = Fetch(artwork);
            Assert.False(write.IsCompleted); // real PutAsync is queued behind the bounded I/O semaphore
            switch (action)
            {
                case "clear": await disk.ClearAsync(null, CancellationToken.None); break;
                case "forget": await disk.ForgetAsync("artwork", KeyA, CancellationToken.None); break;
                case "disable": settings = settings with { Enabled = false }; disk.SettingsChanged(); break;
                case "folder": settings = settings with { Folder = Path.Combine(root, "new-cache") }; disk.SettingsChanged(); break;
            }
        }
        finally { io.Release(ServerBlobCache.MaxConcurrentIo); }
        Assert.NotNull(await write.WaitAsync(TimeSpan.FromSeconds(10)));
        await disk.PendingSweep;
        Assert.Empty(Directory.EnumerateFiles(oldFolder, "*.blob", SearchOption.AllDirectories));
        Assert.Equal(0, disk.Usage().Files); // first commit correctly honours generation
        if (action == "disable") { settings = settings with { Enabled = true }; disk.SettingsChanged(); await disk.PendingSweep; }
        Assert.NotNull(await Fetch(artwork)); // retry must not bypass the invalidation
        await disk.PendingSweep;
        Assert.Equal(1, sends);
        Assert.Equal(0, disk.Usage().Files);
    }

    [Theory]
    [InlineData("clear")]
    [InlineData("forget")]
    public async Task UpstreamResultInvalidatedBeforeItsFirstSaveMustNotBeResurrectedFromMemory(string action)
    {
        settings = settings with { Enabled = true };
        var disk = Disk(); Assert.True(disk.Enabled); await disk.PendingSweep;
        var gate = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var network = Network(gate.Task);
        var artwork = new NativeDetailsArtwork(network, null, null, disk);
        var fetch = Fetch(artwork);
        for (var i = 0; i < 500 && Volatile.Read(ref sends) == 0; i++) await Task.Delay(10);
        Assert.Equal(1, sends);
        if (action == "clear") await disk.ClearAsync(null, CancellationToken.None);
        else await disk.ForgetAsync("artwork", KeyA, CancellationToken.None);
        gate.SetResult(); Assert.NotNull(await fetch);
        Assert.Equal(0, disk.Usage().Files);
        Assert.NotNull(await Fetch(artwork));
        Assert.Equal(1, sends);
        Assert.Equal(0, disk.Usage().Files);
    }

    [Fact]
    public async Task ConcurrentMemoryHitsSaveOnceUnderTheOriginalNamespaceKeyAndFetchTime()
    {
        var disk = Disk(); using var network = Network();
        var artwork = new NativeDetailsArtwork(network, null, null, disk);
        Assert.NotNull(await Fetch(artwork));
        var fetched = Memory(artwork)[KeyA].At;
        settings = settings with { Enabled = true, MaxAgeDays = 1 }; disk.SettingsChanged();
        Assert.True(disk.Enabled); await disk.PendingSweep;
        int commits = 0;
        disk.Hook = point => { if (point == "commit") Interlocked.Increment(ref commits); };
        var io = Io(disk);
        for (int i = 0; i < ServerBlobCache.MaxConcurrentIo; i++) await io.WaitAsync();
        Task<(byte[] Bytes, string ContentType)?>[] hits;
        try { hits = Enumerable.Range(0, 32).Select(_ => Fetch(artwork)).ToArray(); }
        finally { io.Release(ServerBlobCache.MaxConcurrentIo); }
        Assert.All(await Task.WhenAll(hits), x => Assert.NotNull(x));
        Assert.Equal(1, commits); Assert.Equal(1, sends);
        var entry = await disk.TryGetAsync("artwork", KeyA, CancellationToken.None);
        Assert.NotNull(entry); Assert.Equal(fetched, entry.FetchedAt); Assert.Equal(Jpeg, entry.Bytes);
        disk.Register(new("metadata"));
        Assert.Null(await disk.TryGetAsync("metadata", KeyA, CancellationToken.None));
        Assert.Null(await disk.TryGetAsync("artwork", "w342/poster.jpg", CancellationToken.None));
        Assert.Equal(1, disk.Usage().Files);
        now = fetched.AddDays(1).AddSeconds(1);
        await disk.SweepAsync(true, CancellationToken.None);
        Assert.Equal(0, disk.Usage().Files); // original fetch is old, save time (+2h) is not
    }

    [Fact]
    public async Task MemorySaveRespectsTheCapAndCanRetryAfterItIsRaised()
    {
        var disk = Disk(); using var network = Network();
        var artwork = new NativeDetailsArtwork(network, null, null, disk);
        Assert.NotNull(await Fetch(artwork));
        settings = settings with { Enabled = true, MaxBytes = 4095 }; disk.SettingsChanged();
        Assert.NotNull(await Fetch(artwork)); Assert.Equal(0, disk.Usage().Bytes);
        settings = settings with { MaxBytes = 4096 }; disk.SettingsChanged(); await disk.PendingSweep;
        Assert.NotNull(await Fetch(artwork)); await disk.PendingSweep;
        Assert.Equal(4096, disk.Usage().Bytes); Assert.Equal(1, sends);
    }

    [Fact]
    public async Task MemorySaveBeyondThePendingIoLimitIsSkippedAndRetriedLater()
    {
        var disk = Disk(); using var network = Network();
        var artwork = new NativeDetailsArtwork(network, null, null, disk);
        Assert.NotNull(await Fetch(artwork));
        settings = settings with { Enabled = true }; disk.SettingsChanged();
        Assert.True(disk.Enabled); await disk.PendingSweep;
        var io = Io(disk);
        for (int i = 0; i < ServerBlobCache.MaxConcurrentIo; i++) await io.WaitAsync();
        Task<bool>[] writes;
        try
        {
            writes = Enumerable.Range(0, ServerBlobCache.MaxPendingIo).Select(i => disk.PutAsync("artwork", "occupy" + i, Jpeg, "image/jpeg", CancellationToken.None)).ToArray();
            Assert.All(writes, x => Assert.False(x.IsCompleted));
            Assert.NotNull(await Fetch(artwork).WaitAsync(TimeSpan.FromSeconds(5)));
            Assert.False(Memory(artwork)[KeyA].OnDisk);
        }
        finally { io.Release(ServerBlobCache.MaxConcurrentIo); }
        Assert.All(await Task.WhenAll(writes), Assert.True);
        Assert.NotNull(await Fetch(artwork));
        Assert.NotNull(await disk.TryGetAsync("artwork", KeyA, CancellationToken.None));
        Assert.Equal(1, sends);
    }
}
#endif
