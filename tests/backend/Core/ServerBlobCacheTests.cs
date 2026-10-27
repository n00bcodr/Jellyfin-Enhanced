using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Services.ServerCache;

namespace JE.Tests;

/// <summary>The server-side cache: entries on disk, their age and size limits, the folder rules.</summary>
public sealed class ServerBlobCacheTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "je-server-cache-" + Guid.NewGuid().ToString("N"));
    private readonly string _data;
    private DateTime _now = new(2026, 10, 27, 12, 0, 0, DateTimeKind.Utc);
    private ServerCacheSettings _settings;

    public ServerBlobCacheTests()
    {
        _data = Path.Combine(_root, "plugins", "configurations", "Jellyfin.Plugin.JellyfinEnhanced");
        Directory.CreateDirectory(_data);
        _settings = new ServerCacheSettings(true, string.Empty, 0, 0);
    }

    public void Dispose()
    {
        if (!OperatingSystem.IsWindows() && Directory.Exists(_root))
        {
            foreach (var dir in Directory.EnumerateDirectories(_root, "*", SearchOption.AllDirectories)) File.SetUnixFileMode(dir, (UnixFileMode)0b111_000_000);
        }

        if (Directory.Exists(_root)) Directory.Delete(_root, true);
    }

    private ServerBlobCache Make()
    {
        var cache = new ServerBlobCache(() => _settings, Location(), null, () => _now) { SweepDebounce = TimeSpan.Zero };
        cache.Register(new ServerCacheNamespace("artwork"));
        cache.Register(new ServerCacheNamespace("metadata"));
        return cache;
    }

    private ServerCacheLocation Location() => new(_data, new[] { Path.Combine(_root, "data"), Path.Combine(_root, "log"), Path.Combine(_root, "plugins") });

    private string Folder => Path.Combine(_data, ServerBlobCache.DefaultFolderName);

    private IEnumerable<string> Blobs() => Directory.Exists(Folder) ? Directory.EnumerateFiles(Folder, "*.blob", SearchOption.AllDirectories) : Array.Empty<string>();

    // Sizes count whole 4 KiB blocks: every small test entry is one block.
    private const long Block = 4096;

    private static byte[] Bytes(int length, byte fill) => Enumerable.Repeat(fill, length).ToArray();

    [Fact]
    public async Task AMissIsNullAndAStoredEntryReadsBackWithItsTypeAndFetchTime()
    {
        var cache = Make();
        Assert.Null(await cache.TryGetAsync("artwork", "w500/a.jpg", CancellationToken.None));
        Assert.True(await cache.PutAsync("artwork", "w500/a.jpg", new byte[] { 1, 2, 3 }, "image/jpeg", CancellationToken.None));

        var entry = await cache.TryGetAsync("artwork", "w500/a.jpg", CancellationToken.None);
        Assert.NotNull(entry);
        Assert.Equal(new byte[] { 1, 2, 3 }, entry.Bytes);
        Assert.Equal("image/jpeg", entry.ContentType);
        Assert.Equal(_now, entry.FetchedAt);
        // Another key, or the same key in another namespace, is a different entry.
        Assert.Null(await cache.TryGetAsync("artwork", "w342/a.jpg", CancellationToken.None));
        Assert.Null(await cache.TryGetAsync("metadata", "w500/a.jpg", CancellationToken.None));
        // File names are a hash, never the key.
        var file = Assert.Single(Blobs());
        Assert.Matches("^[0-9a-f]{64}\\.blob$", Path.GetFileName(file));
        Assert.Equal(Path.Combine(Folder, "artwork"), Path.GetDirectoryName(Path.GetDirectoryName(file)));
    }

    [Fact]
    public async Task OffMeansNothingIsReadOrWrittenAndNoFolderIsMade()
    {
        _settings = _settings with { Enabled = false };
        var cache = Make();
        Assert.False(await cache.PutAsync("artwork", "k", new byte[] { 1 }, "image/jpeg", CancellationToken.None));
        Assert.Null(await cache.TryGetAsync("artwork", "k", CancellationToken.None));
        await cache.PendingSweep;
        Assert.False(Directory.Exists(Folder));
        Assert.False(cache.Enabled);

        // Entries written while it was on are not served while it is off, and come back when it is on again.
        _settings = _settings with { Enabled = true };
        Assert.True(await cache.PutAsync("artwork", "k", new byte[] { 1 }, "image/jpeg", CancellationToken.None));
        _settings = _settings with { Enabled = false };
        Assert.Null(await cache.TryGetAsync("artwork", "k", CancellationToken.None));
        _settings = _settings with { Enabled = true };
        Assert.NotNull(await cache.TryGetAsync("artwork", "k", CancellationToken.None));
    }

    [Fact]
    public async Task WritesAreAtomicAndLeaveNoTemporaryFiles()
    {
        var cache = Make();
        await Task.WhenAll(Enumerable.Range(0, 16).Select(i => cache.PutAsync("artwork", "same", Bytes(5000, (byte)i), "image/png", CancellationToken.None)));
        Assert.Single(Blobs());
        Assert.Empty(Directory.EnumerateFiles(Folder, "*.tmp", SearchOption.AllDirectories));
        // Whatever write won, the entry is one whole write.
        var entry = await cache.TryGetAsync("artwork", "same", CancellationToken.None);
        Assert.NotNull(entry);
        Assert.Equal(5000, entry.Bytes.Length);
        Assert.All(entry.Bytes, b => Assert.Equal(entry.Bytes[0], b));

        // Temporary files no write of this process is using (an interrupted write's, whatever their age) count as
        // disk used and go with the next sweep.
        var shard = Path.GetDirectoryName(Assert.Single(Blobs()))!;
        var old = Path.Combine(shard, new string('a', 64) + ".0123456789abcdef.tmp");
        var fresh = Path.Combine(shard, new string('b', 64) + ".0123456789abcdef.tmp");
        File.WriteAllBytes(old, new byte[10]);
        File.WriteAllBytes(fresh, new byte[5000]);
        File.SetLastWriteTimeUtc(old, DateTime.UtcNow.AddHours(-2));
        Assert.Equal(2 * Block + Block + 2 * Block, cache.Usage().Bytes);
        await cache.SweepAsync(full: true, CancellationToken.None);
        Assert.False(File.Exists(old));
        Assert.False(File.Exists(fresh));
        Assert.Equal(2 * Block, cache.Usage().Bytes);
    }

    [Theory]
    [InlineData("truncated")]
    [InlineData("garbage")]
    [InlineData("empty")]
    [InlineData("otherkey")]
    public async Task AFileThatDoesntReadBackIsAMissAndIsRemoved(string damage)
    {
        var cache = Make();
        await cache.PutAsync("artwork", "w500/a.jpg", Bytes(2000, 7), "image/jpeg", CancellationToken.None);
        var file = Assert.Single(Blobs());
        var bytes = File.ReadAllBytes(file);
        switch (damage)
        {
            case "truncated": File.WriteAllBytes(file, bytes[..^10]); break;
            case "garbage": File.WriteAllBytes(file, Bytes(300, 0x41)); break;
            case "empty": File.WriteAllBytes(file, Array.Empty<byte>()); break;
            case "otherkey":
                // An entry of another key under this name (a collision, or a copied file) is never served for it.
                var other = Make();
                await other.PutAsync("artwork", "w500/b.jpg", Bytes(10, 1), "image/jpeg", CancellationToken.None);
                var otherFile = Blobs().Single(f => f != file);
                File.Copy(otherFile, file, overwrite: true);
                break;
        }

        Assert.Null(await cache.TryGetAsync("artwork", "w500/a.jpg", CancellationToken.None));
        Assert.False(File.Exists(file));
        // A fresh write replaces it.
        Assert.True(await cache.PutAsync("artwork", "w500/a.jpg", Bytes(2000, 7), "image/jpeg", CancellationToken.None));
        Assert.NotNull(await cache.TryGetAsync("artwork", "w500/a.jpg", CancellationToken.None));
    }

    [Fact]
    public async Task OverTheSizeCapTheLeastRecentlyUsedEntriesGoDownToNinetyPercent()
    {
        var cache = Make();
        for (var i = 0; i < 5; i++)
        {
            await cache.PutAsync("artwork", "k" + i, Bytes(1000, (byte)i), "image/jpeg", CancellationToken.None);
        }

        var size = Block;
        // Entries were last used k0 (oldest) .. k4 (newest), hours apart; then k0 is read again.
        var files = Enumerable.Range(0, 5).ToDictionary(i => "k" + i, i => Blobs().Single(f => ReadKey(f) == "k" + i));
        for (var i = 0; i < 5; i++) File.SetLastWriteTimeUtc(files["k" + i], _now.AddHours(-10 + i));
        Assert.NotNull(await cache.TryGetAsync("artwork", "k0", CancellationToken.None));
        Assert.Equal(_now, File.GetLastWriteTimeUtc(files["k0"]));

        // A cap of 3.5 entries: down to 3.15, so three stay: the read k0 and the newest k3, k4.
        await cache.PendingSweep;
        _settings = _settings with { MaxBytes = (long)(size * 3.5) };
        Assert.True(cache.Enabled); // the change is noticed and swept at once
        await cache.PendingSweep;
        Assert.True(File.Exists(files["k0"]));
        Assert.False(File.Exists(files["k1"]));
        Assert.False(File.Exists(files["k2"]));
        Assert.True(File.Exists(files["k3"]));
        Assert.True(File.Exists(files["k4"]));
        Assert.Equal(3 * size, cache.Usage().Bytes);
    }

    [Fact]
    public async Task AWriteOverTheCapStartsOneDebouncedSweep()
    {
        var cache = Make();
        await cache.PutAsync("artwork", "first", Bytes(1000, 1), "image/jpeg", CancellationToken.None);
        await cache.PendingSweep;
        var size = Block;
        _settings = _settings with { MaxBytes = size * 2 };
        Assert.True(cache.Enabled);
        await cache.PendingSweep;
        File.SetLastWriteTimeUtc(Blobs().Single(), _now.AddHours(-1));
        await cache.PutAsync("artwork", "second", Bytes(1000, 2), "image/jpeg", CancellationToken.None);
        Assert.True(cache.PendingSweep.IsCompleted); // at the cap, not over it: no sweep
        await cache.PutAsync("artwork", "third", Bytes(1000, 3), "image/jpeg", CancellationToken.None);
        await cache.PendingSweep;
        Assert.Null(await cache.TryGetAsync("artwork", "first", CancellationToken.None));
        Assert.Single(Blobs());
    }

    [Fact]
    public async Task AnEntryPastTheAgeLimitIsAMissAndTheSweepsRemoveIt()
    {
        _settings = _settings with { MaxAgeDays = 30 };
        var cache = Make();
        await cache.PutAsync("artwork", "old", Bytes(10, 1), "image/jpeg", CancellationToken.None);
        _now = _now.AddDays(29);
        await cache.PutAsync("artwork", "recent", Bytes(10, 2), "image/jpeg", CancellationToken.None);
        // Still young enough: served (and touched).
        Assert.NotNull(await cache.TryGetAsync("artwork", "old", CancellationToken.None));
        _now = _now.AddDays(1);
        Assert.Null(await cache.TryGetAsync("artwork", "old", CancellationToken.None));
        Assert.Single(Blobs());

        // An entry used recently but fetched too long ago: only the full sweep (startup, daily) reads its fetch time.
        _now = _now.AddDays(29).AddHours(23);
        var recent = Blobs().Single();
        File.SetLastWriteTimeUtc(recent, _now);
        _now = _now.AddHours(2);
        Assert.Equal(0, await cache.SweepAsync(full: false, CancellationToken.None));
        Assert.Equal(1, await cache.SweepAsync(full: true, CancellationToken.None));
        Assert.Empty(Blobs());

        // Unused since the cutoff: any sweep removes it without reading it.
        await cache.PutAsync("artwork", "idle", Bytes(10, 3), "image/jpeg", CancellationToken.None);
        _now = _now.AddDays(31);
        Assert.Equal(1, await cache.SweepAsync(full: false, CancellationToken.None));
    }

    [Fact]
    public async Task LoweringALimitTakesEffectWithoutAWrite()
    {
        var cache = Make();
        for (var i = 0; i < 4; i++) await cache.PutAsync("artwork", "k" + i, Bytes(1000, 1), "image/jpeg", CancellationToken.None);
        await cache.PendingSweep;
        var size = Block;
        _settings = _settings with { MaxBytes = size * 2 };
        Assert.True(cache.Enabled); // any call notices the change
        await cache.PendingSweep;
        Assert.Single(Blobs()); // 90% of two entries holds one
    }

    [Fact]
    public void UsageIsCamelCaseJson()
    {
        var json = System.Text.Json.JsonSerializer.Serialize(new ServerCacheUsage(true, "/f", null, 1, 4096, 0, 30,
            new[] { new ServerCacheNamespaceUsage("artwork", 1, 4096, 0) }));
        Assert.Equal("{\"enabled\":true,\"folder\":\"/f\",\"folderError\":null,\"files\":1,\"bytes\":4096,\"maxBytes\":0,\"maxAgeDays\":30,\"namespaces\":[{\"name\":\"artwork\",\"files\":1,\"bytes\":4096,\"maxBytes\":0}]}", json);
    }

    [Fact]
    public async Task UsageCountsEveryNamespaceAndClearRemovesOnlyTheStoresOwnFiles()
    {
        var cache = Make();
        await cache.PutAsync("artwork", "a", Bytes(100, 1), "image/jpeg", CancellationToken.None);
        await cache.PutAsync("artwork", "b", Bytes(100, 1), "image/jpeg", CancellationToken.None);
        await cache.PutAsync("metadata", "c", Bytes(50, 1), "application/json", CancellationToken.None);
        var foreign = Path.Combine(Folder, "notes.txt");
        var foreignInNs = Path.Combine(Folder, "artwork", "README");
        File.WriteAllText(foreign, "mine");
        File.WriteAllText(foreignInNs, "mine too");

        var usage = cache.Usage();
        Assert.True(usage.Enabled);
        Assert.Equal(Folder, usage.Folder);
        Assert.Equal(3, usage.Files);
        Assert.Equal(new[] { "artwork", "metadata" }, usage.Namespaces.Select(n => n.Name));
        Assert.Equal(2, usage.Namespaces[0].Files);
        Assert.Equal(usage.Bytes, usage.Namespaces.Sum(n => n.Bytes));

        Assert.Equal(3, await cache.ClearAsync(null, CancellationToken.None));
        Assert.Empty(Blobs());
        Assert.True(File.Exists(foreign));
        Assert.True(File.Exists(foreignInNs));
        Assert.False(Directory.Exists(Path.Combine(Folder, "metadata")));
        Assert.Equal(0, cache.Usage().Bytes);
        // Cleared means gone: the next read is a miss.
        Assert.Null(await cache.TryGetAsync("artwork", "a", CancellationToken.None));
    }

    [Fact]
    public async Task SweepsAndClearNeverFollowALink()
    {
        if (OperatingSystem.IsWindows()) return;
        var cache = Make();
        await cache.PutAsync("artwork", "a", Bytes(100, 1), "image/jpeg", CancellationToken.None);
        var shard = Path.GetDirectoryName(Assert.Single(Blobs()))!;
        var outside = Path.Combine(_root, "outside");
        Directory.CreateDirectory(Path.Combine(outside, "ab"));
        var victim = Path.Combine(outside, "ab", new string('c', 64) + ".blob");
        File.WriteAllBytes(victim, Bytes(10, 1));
        var victimFile = Path.Combine(_root, "victim.blob");
        File.WriteAllBytes(victimFile, Bytes(10, 1));
        // A linked namespace, a linked shard and a linked entry, all named as the store names them.
        Directory.CreateSymbolicLink(Path.Combine(Folder, "linked"), outside);
        Directory.CreateSymbolicLink(Path.Combine(Folder, "artwork", "ff"), Path.Combine(outside, "ab"));
        File.CreateSymbolicLink(Path.Combine(shard, new string('d', 64) + ".blob"), victimFile);

        Assert.Equal(1, cache.Usage().Files); // links are never entries
        _settings = _settings with { MaxBytes = 1, MaxAgeDays = 1 };
        _now = _now.AddDays(5);
        await cache.SweepAsync(full: true, CancellationToken.None);
        await cache.ClearAsync(null, CancellationToken.None);

        Assert.True(File.Exists(victim));
        Assert.True(File.Exists(victimFile));
        Assert.Equal(0, cache.Usage().Files);
        Assert.DoesNotContain(Blobs(), f => File.ResolveLinkTarget(f, false) == null && !f.Contains("linked") && !f.Contains("/ff/"));
    }

    [Fact]
    public async Task TwoReadersOfOneKeyGetTheSameEntry()
    {
        var cache = Make();
        await cache.PutAsync("artwork", "k", Bytes(300_000, 9), "image/webp", CancellationToken.None);
        var reads = await Task.WhenAll(Enumerable.Range(0, 8).Select(_ => cache.TryGetAsync("artwork", "k", CancellationToken.None)));
        Assert.All(reads, r => Assert.Equal(300_000, r!.Bytes.Length));
    }

    [Fact]
    public void FolderRulesRefuseRelativeJellyfinAndRootFolders()
    {
        var location = Location();
        Assert.Null(location.Resolve("", out var full));
        Assert.Equal(Folder, full);
        Assert.Null(location.Resolve("  ", out _));

        Assert.NotNull(location.Resolve("cache/je", out _));
        Assert.NotNull(location.Resolve("./je", out _));
        Assert.NotNull(location.Resolve(Path.Combine(_root, "data"), out _));
        Assert.Contains(Path.Combine(_root, "data") + ")", location.Resolve(Path.Combine(_root, "data", "metadata", "je"), out _));
        Assert.NotNull(location.Resolve(Path.Combine(_root, "log", ".."), out _)); // holds Jellyfin's folders
        Assert.NotNull(location.Resolve(Path.Combine(_root, "plugins", "x"), out _));
        Assert.NotNull(location.Resolve(Path.GetPathRoot(_root), out _));
        Assert.NotNull(location.Resolve(_data, out _)); // the data folder itself
        Assert.NotNull(location.Resolve(_data + "/../../configurations", out _));

        // Inside the plugin's own data folder (itself inside Jellyfin's plugin folder) is fine, and so is a separate disk.
        Assert.Null(location.Resolve(Path.Combine(_data, "elsewhere"), out full));
        Assert.Equal(Path.Combine(_data, "elsewhere"), full);
        Assert.Null(location.Resolve(Path.Combine(_root, "media-cache") + "/", out full));
        Assert.Equal(Path.Combine(_root, "media-cache"), full);
    }

    [Fact]
    public async Task AMissingFolderIsCreatedAndAnUnwritableOneTurnsTheCacheOff()
    {
        var custom = Path.Combine(_root, "custom", "nested");
        _settings = _settings with { Folder = custom };
        var cache = Make();
        Assert.True(await cache.PutAsync("artwork", "k", new byte[] { 1 }, "image/jpeg", CancellationToken.None));
        Assert.True(Directory.Exists(Path.Combine(custom, "artwork")));
        Assert.Equal(custom, cache.Usage().Folder);

        if (OperatingSystem.IsWindows() || Environment.UserName == "root") return;
        var locked = Path.Combine(_root, "locked");
        Directory.CreateDirectory(locked);
        File.SetUnixFileMode(locked, UnixFileMode.UserRead | UnixFileMode.UserExecute);
        Assert.NotNull(Location().Prepare(locked));
        _settings = _settings with { Folder = locked };
        Assert.False(await cache.PutAsync("artwork", "k", new byte[] { 1 }, "image/jpeg", CancellationToken.None));
        Assert.Null(await cache.TryGetAsync("artwork", "k", CancellationToken.None));
        Assert.False(cache.Enabled);
        Assert.NotNull(cache.Usage().FolderError);

        // A refused folder never caches, and says why.
        _settings = _settings with { Folder = "relative/path" };
        Assert.False(await cache.PutAsync("artwork", "k", new byte[] { 1 }, "image/jpeg", CancellationToken.None));
        Assert.Contains("full path", cache.Usage().FolderError);
    }

    [Fact]
    public void SettingsComeFromTheConfigurationInGbAndDaysAndAreClamped()
    {
        var config = new PluginConfiguration();
        var defaults = ServerCacheSettings.From(config);
        Assert.False(defaults.Enabled);
        Assert.Equal(string.Empty, defaults.Folder);
        Assert.Equal(2L * 1024 * 1024 * 1024, defaults.MaxBytes);
        Assert.Equal(30, defaults.MaxAgeDays);

        config.ServerCacheEnabled = true;
        config.ServerCachePath = "  /srv/je-cache ";
        config.ServerCacheMaxSizeGb = 20;
        config.ServerCacheMaxAgeDays = -4;
        var set = ServerCacheSettings.From(config);
        Assert.Equal("/srv/je-cache", set.Folder);
        Assert.Equal(20L * 1024 * 1024 * 1024, set.MaxBytes);
        Assert.Equal(0, set.MaxAgeDays);
        config.ServerCacheMaxSizeGb = 0.5;
        Assert.Equal(512L * 1024 * 1024, ServerCacheSettings.From(config).MaxBytes);
        config.ServerCacheMaxSizeGb = double.NaN;
        Assert.Equal(0, ServerCacheSettings.From(config).MaxBytes);
        Assert.False(ServerCacheSettings.From(null).Enabled);
    }

    [Fact]
    public async Task NamespacesAndKeysAreBounded()
    {
        var cache = Make();
        Assert.False(await cache.PutAsync("../x", "k", new byte[] { 1 }, "image/jpeg", CancellationToken.None));
        Assert.False(await cache.PutAsync("Artwork", "k", new byte[] { 1 }, "image/jpeg", CancellationToken.None));
        Assert.False(await cache.PutAsync("artwork", new string('k', 2000), new byte[] { 1 }, "image/jpeg", CancellationToken.None));
        Assert.Null(await cache.TryGetAsync("../x", "k", CancellationToken.None));
        // A key with path characters is only ever hashed.
        Assert.True(await cache.PutAsync("artwork", "../../../etc/passwd", new byte[] { 1 }, "image/jpeg", CancellationToken.None));
        Assert.All(Blobs(), f => Assert.StartsWith(Path.Combine(Folder, "artwork"), f));
    }

    [Fact]
    public async Task ValidityIsTheEarliestOfTheWritersExpiryTheNamespaceLifetimeTheReadersMaxAgeAndTheAgeLimit()
    {
        var cache = Make();
        cache.Register(new ServerCacheNamespace("feeds", DefaultTtl: TimeSpan.FromDays(1)));
        // No age limit configured never extends the writer's expiry.
        await cache.PutAsync("metadata", "short", Bytes(10, 1), "application/json", CancellationToken.None, expiresAt: _now.AddHours(1));
        // The namespace's lifetime caps a longer expiry.
        await cache.PutAsync("feeds", "long", Bytes(10, 1), "application/json", CancellationToken.None, expiresAt: _now.AddDays(10));
        await cache.PutAsync("metadata", "open", Bytes(10, 1), "application/json", CancellationToken.None);

        _now = _now.AddHours(2);
        Assert.Null(await cache.TryGetAsync("metadata", "short", CancellationToken.None));
        var open = await cache.TryGetAsync("metadata", "open", CancellationToken.None);
        Assert.NotNull(open);
        // A read touches the last access, never the fetch time.
        Assert.Equal(_now.AddHours(-2), open.FetchedAt);
        Assert.Equal(_now.AddHours(-2), (await cache.TryGetAsync("metadata", "open", CancellationToken.None))!.FetchedAt);
        // A stricter reader treats it as a miss but leaves it for others.
        Assert.Null(await cache.TryGetAsync("metadata", "open", CancellationToken.None, maxAge: TimeSpan.FromHours(1)));
        Assert.NotNull(await cache.TryGetAsync("metadata", "open", CancellationToken.None));
        Assert.NotNull(await cache.TryGetAsync("feeds", "long", CancellationToken.None));

        _now = _now.AddDays(1);
        Assert.Null(await cache.TryGetAsync("feeds", "long", CancellationToken.None));
        // The configured age limit caps everything, and a full sweep reads the expiries it can't see in a file's time.
        _settings = _settings with { MaxAgeDays = 1 };
        Assert.Null(await cache.TryGetAsync("metadata", "open", CancellationToken.None));
        Assert.Empty(Blobs());

        // An entry already past its validity is never written.
        Assert.False(await cache.PutAsync("metadata", "stale", Bytes(10, 1), "application/json", CancellationToken.None, fetchedAt: _now.AddDays(-2)));
        Assert.False(await cache.PutAsync("metadata", "gone", Bytes(10, 1), "application/json", CancellationToken.None, expiresAt: _now.AddMinutes(-1)));
    }

    [Fact]
    public async Task AWriteThatStartedBeforeAClearOrASettingsChangeIsRefused()
    {
        var cache = Make();
        var before = cache.Generation;
        await cache.ClearAsync(null, CancellationToken.None);
        Assert.False(await cache.PutAsync("artwork", "late", Bytes(10, 1), "image/jpeg", CancellationToken.None, generation: before));
        Assert.Empty(Blobs());
        Assert.True(await cache.PutAsync("artwork", "fresh", Bytes(10, 1), "image/jpeg", CancellationToken.None, generation: cache.Generation));

        // Clearing one namespace, forgetting one entry, switching off and on or moving the folder also end it.
        foreach (Func<Task> change in new Func<Task>[]
        {
            () => cache.ClearAsync("metadata", CancellationToken.None),
            () => cache.ForgetAsync("artwork", "fresh", CancellationToken.None),
            () => { _settings = _settings with { Enabled = false }; _ = cache.Enabled; _settings = _settings with { Enabled = true }; return Task.CompletedTask; },
            () => { _settings = _settings with { Folder = Path.Combine(_root, "moved") }; return Task.CompletedTask; },
        })
        {
            var started = cache.Generation;
            await change();
            Assert.False(await cache.PutAsync("artwork", "late", Bytes(10, 1), "image/jpeg", CancellationToken.None, generation: started));
        }

        Assert.Null(await cache.TryGetAsync("artwork", "late", CancellationToken.None));
    }

    [Fact]
    public async Task ANamespacesOwnShareEvictsOnlyItsEntries()
    {
        var cache = Make();
        cache.Register(new ServerCacheNamespace("small", MaxBytes: 2 * Block));
        await cache.PutAsync("artwork", "keep", Bytes(10, 1), "image/jpeg", CancellationToken.None);
        for (var i = 0; i < 3; i++)
        {
            _now = _now.AddMinutes(1);
            await cache.PutAsync("small", "s" + i, Bytes(10, 1), "application/json", CancellationToken.None);
            await cache.PendingSweep;
        }

        var usage = cache.Usage();
        Assert.Equal(1, usage.Namespaces.Single(n => n.Name == "artwork").Files);
        var small = usage.Namespaces.Single(n => n.Name == "small");
        Assert.Equal(1, small.Files);
        Assert.Equal(2 * Block, small.MaxBytes);
        Assert.NotNull(await cache.TryGetAsync("small", "s2", CancellationToken.None));
    }

    [Fact]
    public async Task UnregisteredNamespacesAndOversizedFilesAreRefusedBeforeTheyAreRead()
    {
        var cache = Make();
        Assert.False(await cache.PutAsync("unknown", "k", new byte[] { 1 }, "image/jpeg", CancellationToken.None));
        Assert.Null(await cache.TryGetAsync("unknown", "k", CancellationToken.None));
        Assert.Throws<ArgumentException>(() => cache.Register(new ServerCacheNamespace("Bad/Name")));

        cache.Register(new ServerCacheNamespace("tiny", MaxEntryBytes: 100));
        Assert.False(await cache.PutAsync("tiny", "k", Bytes(200, 1), "image/jpeg", CancellationToken.None));
        Assert.True(await cache.PutAsync("tiny", "k", Bytes(50, 1), "image/jpeg", CancellationToken.None));
        // A file grown past the namespace's largest entry is removed unread.
        var file = Blobs().Single(f => f.Contains(Path.Combine(Folder, "tiny")));
        File.WriteAllBytes(file, Bytes(5000, 1));
        Assert.Null(await cache.TryGetAsync("tiny", "k", CancellationToken.None));
        Assert.False(File.Exists(file));
    }

    [Fact]
    public async Task JsonValuesRoundTripAndOneThatDoesntDeserializeIsRemoved()
    {
        var cache = Make();
        Assert.True(await cache.PutJsonAsync("metadata", "movie:603", new Sample("The Matrix", 1999), null, CancellationToken.None, expiresAt: _now.AddDays(7)));
        var read = await cache.TryGetJsonAsync<Sample>("metadata", "movie:603", null, CancellationToken.None);
        Assert.Equal(new Sample("The Matrix", 1999), read!.Value);
        Assert.Equal(_now, read.FetchedAt);
        Assert.Equal(_now.AddDays(7), read.ExpiresAt);

        await cache.PutAsync("metadata", "broken", System.Text.Encoding.UTF8.GetBytes("{not json"), ServerBlobCache.JsonContentType, CancellationToken.None);
        Assert.Null(await cache.TryGetJsonAsync<Sample>("metadata", "broken", null, CancellationToken.None));
        Assert.Null(await cache.TryGetAsync("metadata", "broken", CancellationToken.None));
        Assert.True(await cache.ForgetAsync("metadata", "movie:603", CancellationToken.None));
        Assert.Null(await cache.TryGetJsonAsync<Sample>("metadata", "movie:603", null, CancellationToken.None));
    }

    private sealed record Sample(string Title, int Year);

    private static string ReadKey(string file)
    {
        var bytes = File.ReadAllBytes(file);
        var length = BitConverter.ToUInt16(bytes, 5);
        return System.Text.Encoding.UTF8.GetString(bytes, 7, length);
    }
}
