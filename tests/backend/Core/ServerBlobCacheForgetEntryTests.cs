using Jellyfin.Plugin.JellyfinEnhanced.Services.ServerCache;

namespace JE.Tests;

/// <summary>Forgetting one entry of the server-side cache: its own writes and shared reads end, nobody else's.</summary>
public sealed class ServerBlobCacheForgetEntryTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "je-forget-entry-" + Guid.NewGuid().ToString("N"));

    public void Dispose()
    {
        if (Directory.Exists(_root)) Directory.Delete(_root, true);
    }

    private ServerBlobCache Make()
    {
        var cache = new ServerBlobCache(() => new ServerCacheSettings(true, string.Empty, 0, 0), new ServerCacheLocation(_root, Array.Empty<string>()), null)
        { SweepDebounce = TimeSpan.Zero };
        cache.Register(new ServerCacheNamespace("metadata"));
        return cache;
    }

    private static Task<bool> Put(ServerBlobCache cache, string key, long generation)
        => cache.PutAsync("metadata", key, new byte[] { 1, 2, 3 }, "application/json", CancellationToken.None, generation);

    [Fact]
    public async Task ForgettingAnEntryWithNoFileYetRefusesOnlyItsOwnEarlierWrites()
    {
        var cache = Make();
        var before = cache.Generation;
        Assert.False(await cache.ForgetEntryAsync("metadata", "a", CancellationToken.None)); // nothing there yet
        Assert.False(await Put(cache, "a", before));                                        // ... and still fenced
        Assert.True(await Put(cache, "b", before));                                         // another entry is not
        Assert.True(cache.IsCurrent(before));                                                // no global end
        Assert.True(await Put(cache, "a", cache.Generation));                               // a write that starts afterwards lands
        Assert.NotNull(await cache.TryGetAsync("metadata", "a", CancellationToken.None));
    }

    [Fact]
    public async Task AGlobalEndStillRefusesEveryEarlierWrite()
    {
        var cache = Make();
        var before = cache.Generation;
        await cache.ForgetAsync("metadata", "x", CancellationToken.None);
        Assert.False(cache.IsCurrent(before));
        Assert.False(await Put(cache, "b", before));
    }

    [Fact]
    public async Task PastTheBoundForgettingOneEntryEndsEverythingEarlier()
    {
        var cache = Make();
        var before = cache.Generation;
        for (var i = 0; i < ServerBlobCache.MaxForgottenEntries + 1; i++) await cache.ForgetEntryAsync("metadata", "k" + i, CancellationToken.None);
        Assert.False(await Put(cache, "unrelated", before));
        Assert.True(await Put(cache, "unrelated", cache.Generation));
    }

    [Theory]
    [InlineData("forget")]
    [InlineData("clear")]
    public async Task ACallerArrivingAfterForgetOrClearNeverJoinsTheOlderRead(string end)
    {
        var cache = Make();
        Assert.True(await Put(cache, "a", cache.Generation));
        using var entered = new ManualResetEventSlim();
        using var release = new ManualResetEventSlim();
        var first = true;
        cache.Hook = point =>
        {
            if (point != "read" || !first) return;
            first = false;
            entered.Set();
            release.Wait(TimeSpan.FromSeconds(10));
        };
        // The older read is held before it opens the file; the entry is removed meanwhile, and a new caller arrives.
        var older = cache.TryGetAsync("metadata", "a", CancellationToken.None);
        Assert.True(entered.Wait(TimeSpan.FromSeconds(5)));
        if (end == "forget") await cache.ForgetEntryAsync("metadata", "a", CancellationToken.None);
        else await cache.ClearAsync(null, CancellationToken.None);
        var later = cache.TryGetAsync("metadata", "a", CancellationToken.None);
        Assert.Null(await later);
        release.Set();
        await older;
        cache.Hook = null;
    }
}
