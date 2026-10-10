using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services.ListPlaceholders;

namespace JE.Tests;

// The per-list JSON store: atomic persistence, strict reads, rev, cap, reverse index and request replay.
public class ListPlaceholdersStoreTests
{
    private const string List1 = "0123456789abcdef0123456789abcdef";
    private const string List2 = "fedcba9876543210fedcba9876543210";

    private static string Dir(CoreFixture fixture) => Path.Combine(fixture.ConfigRoot, "list-placeholders");

    private static Placeholder Movie(string id, int tmdb, string? imdb = null) =>
        new() { Id = id, Kind = PlaceholderKinds.Movie, MediaType = "movie", TmdbId = tmdb, ImdbId = imdb, Title = "M" + tmdb };

    [Fact]
    public async Task SaveWritesAtomicallyBumpsRevAndSurvivesARestart()
    {
        using var fixture = new CoreFixture();
        var store = new ListPlaceholderStore(fixture.Paths.Object, fixture.Logger);
        Assert.Null(store.Load(List1));

        using (await store.LockAsync(List1))
        {
            var doc = store.LoadForUpdate(List1, ListKinds.Playlist);
            doc.Items.Add(Movie("a1", 10));
            doc.Order.Add("p:a1");
            Assert.Equal(1, store.Save(doc).Rev);
            var again = store.LoadForUpdate(List1, ListKinds.Playlist);
            again.Items.Add(Movie("a2", 11));
            Assert.Equal(2, store.Save(again).Rev);
        }

        Assert.Equal(new[] { List1 + ".json" }, Directory.GetFiles(Dir(fixture)).Select(Path.GetFileName));
        var restarted = new ListPlaceholderStore(fixture.Paths.Object, fixture.Logger);
        var loaded = restarted.Load(List1)!;
        Assert.Equal(2, loaded.Rev);
        Assert.Equal(new[] { "a1", "a2" }, loaded.Items.Select(i => i.Id));
        Assert.Equal(new[] { "p:a1" }, loaded.Order);
        Assert.NotNull(loaded.UpdatedAt);
    }

    [Fact]
    public void AColdReadNeverPublishesARevisionOlderThanAConcurrentSaveOrDelete()
    {
        using var fixture = new CoreFixture();
        var writer = new ListPlaceholderStore(fixture.Paths.Object, fixture.Logger);
        var seed = writer.LoadForUpdate(List1, ListKinds.Playlist);
        seed.Items.Add(Movie("a1", 10));
        writer.Save(seed);

        // Cold cache (as after a restart): a lock-free GET reads rev 1 from disk; before it publishes, a locked
        // mutation saves rev 2. The GET must not put rev 1 back into the cache.
        var store = new ListPlaceholderStore(fixture.Paths.Object, fixture.Logger);
        var raced = false;
        store.AfterColdReadForTest = _ =>
        {
            if (raced)
            {
                return;
            }

            raced = true;
            var doc = store.LoadForUpdate(List1, ListKinds.Playlist);
            doc.Items[0].Note = "patched";
            store.Save(doc);
        };
        Assert.Equal(2, store.Load(List1)!.Rev);
        Assert.True(raced);
        Assert.Equal(2, store.Load(List1)!.Rev);
        Assert.Equal("patched", store.LoadForUpdate(List1, ListKinds.Playlist).Items.Single().Note);

        // Same for a delete racing a cold read: the list stays absent.
        var cold = new ListPlaceholderStore(fixture.Paths.Object, fixture.Logger);
        var deleted = false;
        cold.AfterColdReadForTest = id =>
        {
            if (!deleted)
            {
                deleted = true;
                cold.Delete(id);
            }
        };
        Assert.Null(cold.Load(List1));
        Assert.True(deleted);
        Assert.Null(cold.Load(List1));
    }

    [Fact]
    public void LoadForUpdateReturnsAPrivateCopy()
    {
        using var fixture = new CoreFixture();
        var store = new ListPlaceholderStore(fixture.Paths.Object, fixture.Logger);
        var doc = store.LoadForUpdate(List1, ListKinds.Collection);
        doc.Items.Add(Movie("a1", 10));
        store.Save(doc);
        var copy = store.LoadForUpdate(List1, ListKinds.Collection);
        copy.Items.Clear();
        copy.Rev = 99;
        Assert.Single(store.Load(List1)!.Items);
        Assert.Equal(1, store.Load(List1)!.Rev);
    }

    [Theory]
    [InlineData("")]
    [InlineData("null")]
    [InlineData("{not json")]
    [InlineData("{\"listId\":\"fedcba9876543210fedcba9876543210\",\"listKind\":\"playlist\"}")]
    [InlineData("{\"listId\":\"0123456789abcdef0123456789abcdef\",\"listKind\":\"folder\"}")]
    [InlineData("{\"listId\":\"0123456789abcdef0123456789abcdef\",\"listKind\":\"playlist\",\"items\":[{\"id\":\"x\"},{\"id\":\"x\"}]}")]
    [InlineData("{\"listId\":\"0123456789abcdef0123456789abcdef\",\"listKind\":\"playlist\",\"items\":null}")]
    public void CorruptDocumentsAreKeptAndRefused(string content)
    {
        using var fixture = new CoreFixture();
        Directory.CreateDirectory(Dir(fixture));
        var path = Path.Combine(Dir(fixture), List1 + ".json");
        File.WriteAllText(path, content);
        var store = new ListPlaceholderStore(fixture.Paths.Object, fixture.Logger);
        Assert.Throws<InvalidDataException>(() => store.Load(List1));
        Assert.Throws<InvalidDataException>(() => store.LoadForUpdate(List1, ListKinds.Playlist));
        Assert.Equal(content, File.ReadAllText(path));
        Assert.Single(Directory.GetFiles(Dir(fixture), List1 + ".json.corrupt-*"));
    }

    [Fact]
    public void InvalidIdsNeverReachTheFileSystem()
    {
        using var fixture = new CoreFixture();
        var store = new ListPlaceholderStore(fixture.Paths.Object, fixture.Logger);
        Assert.Throws<ArgumentException>(() => store.Load("../../etc/passwd"));
        Assert.Throws<ArgumentException>(() => store.Load("0123456789ABCDEF0123456789ABCDEF"));
        Assert.Throws<ArgumentException>(() => store.Save(new ListDoc { ListId = "x" }));
        Assert.True(ListPlaceholderStore.IsValidRequestId("abc-DEF_123"));
        Assert.False(ListPlaceholderStore.IsValidRequestId("a b"));
        Assert.False(ListPlaceholderStore.IsValidRequestId(new string('a', 65)));
    }

    [Fact]
    public void TheCapIsEnforcedOnSave()
    {
        using var fixture = new CoreFixture();
        var store = new ListPlaceholderStore(fixture.Paths.Object, fixture.Logger);
        var doc = store.LoadForUpdate(List1, ListKinds.Collection);
        doc.Items.AddRange(Enumerable.Range(0, ListPlaceholderStore.MaxPlaceholders + 1).Select(i => Movie("m" + i, i + 1)));
        Assert.Throws<InvalidOperationException>(() => store.Save(doc));
        Assert.Null(store.Load(List1));
        Assert.False(Directory.Exists(Dir(fixture)) && Directory.GetFiles(Dir(fixture)).Length > 0);
    }

    [Fact]
    public void DeleteAndEnumerate()
    {
        using var fixture = new CoreFixture();
        var store = new ListPlaceholderStore(fixture.Paths.Object, fixture.Logger);
        store.Save(new ListDoc { ListId = List1, ListKind = ListKinds.Playlist });
        store.Save(new ListDoc { ListId = List2, ListKind = ListKinds.Collection });
        File.WriteAllText(Path.Combine(Dir(fixture), "notes.json"), "{}");
        Assert.Equal(new[] { List1, List2 }, store.EnumerateListIds().OrderBy(x => x));
        Assert.True(store.Delete(List1));
        Assert.False(store.Delete(List1));
        Assert.Null(store.Load(List1));
        Assert.Equal(new[] { List2 }, store.EnumerateListIds());
    }

    [Fact]
    public void ReverseIndexFollowsSavesAndDeletesAndRebuildsFromDisk()
    {
        using var fixture = new CoreFixture();
        var store = new ListPlaceholderStore(fixture.Paths.Object, fixture.Logger);
        Assert.False(store.HasAnyPlaceholders());

        var one = store.LoadForUpdate(List1, ListKinds.Playlist);
        one.Items.Add(Movie("m1", 550, "tt0137523"));
        one.Items.Add(new Placeholder { Id = "s1", Kind = PlaceholderKinds.Season, MediaType = "tv", TmdbId = 1399, TvdbId = 121361, SeasonNumber = 1, Title = "GoT" });
        one.Items.Add(new Placeholder { Id = "c1", Kind = PlaceholderKinds.Custom, MediaType = "movie", Title = "Custom" });
        store.Save(one);
        var two = store.LoadForUpdate(List2, ListKinds.Collection);
        two.Items.Add(Movie("m2", 550));
        store.Save(two);

        Assert.True(store.HasAnyPlaceholders());
        Assert.Equal(new[] { (List1, "m1"), (List2, "m2") }, store.FindByTmdb("movie", 550).Select(r => (r.ListId, r.PlaceholderId)).OrderBy(r => r.ListId));
        Assert.Empty(store.FindByTmdb("tv", 550));
        Assert.Equal("s1", Assert.Single(store.FindByTvdb(121361)).PlaceholderId);
        Assert.Equal("s1", Assert.Single(store.FindByTmdb("tv", 1399)).PlaceholderId);
        Assert.Equal("m1", Assert.Single(store.FindByImdb("TT0137523")).PlaceholderId);

        var edit = store.LoadForUpdate(List1, ListKinds.Playlist);
        edit.Items.RemoveAll(i => i.Id == "m1");
        store.Save(edit);
        Assert.Equal(List2, Assert.Single(store.FindByTmdb("movie", 550)).ListId);
        Assert.Empty(store.FindByImdb("tt0137523"));

        var fresh = new ListPlaceholderStore(fixture.Paths.Object, fixture.Logger);
        Assert.Equal("s1", Assert.Single(fresh.FindByTmdb("tv", 1399)).PlaceholderId);
        store.Delete(List2);
        Assert.Empty(store.FindByTmdb("movie", 550));
        store.Delete(List1);
        Assert.False(store.HasAnyPlaceholders());
    }

    [Fact]
    public void ReplaysAreScopedPerListAndUser()
    {
        using var fixture = new CoreFixture();
        var store = new ListPlaceholderStore(fixture.Paths.Object, fixture.Logger);
        store.RememberReplay(List1, "req-1", "user-a", 200, "{\"ok\":1}");
        Assert.True(store.TryGetReplay(List1, "req-1", "user-a", out var record));
        Assert.Equal((200, "{\"ok\":1}"), (record.StatusCode, record.Body));
        Assert.InRange(record.ExpiresAtUtc - DateTime.UtcNow, TimeSpan.FromMinutes(9), TimeSpan.FromMinutes(10.1));
        Assert.False(store.TryGetReplay(List1, "req-1", "user-b", out _));
        Assert.False(store.TryGetReplay(List2, "req-1", "user-a", out _));
        Assert.False(store.TryGetReplay(List1, "req-2", "user-a", out _));
    }

    [Fact]
    public void TheReplayCacheStaysBounded()
    {
        using var fixture = new CoreFixture();
        var store = new ListPlaceholderStore(fixture.Paths.Object, fixture.Logger);
        for (var i = 0; i < 5200; i++)
        {
            store.RememberReplay(List1, "r" + i, "u", 200, "{}");
        }

        Assert.True(store.TryGetReplay(List1, "r5199", "u", out _));
        Assert.False(store.TryGetReplay(List1, "r0", "u", out _));
    }

    [Fact]
    public async Task TheListLockSerialisesWriters()
    {
        using var fixture = new CoreFixture();
        var store = new ListPlaceholderStore(fixture.Paths.Object, fixture.Logger);
        var first = await store.LockAsync(List1);
        var second = store.LockAsync(List1);
        var other = store.LockAsync(List2);
        Assert.True(other.IsCompleted);
        Assert.False(second.IsCompleted);
        first.Dispose();
        first.Dispose(); // idempotent
        (await second).Dispose();
        (await other).Dispose();
        using var cts = new CancellationTokenSource();
        var held = await store.LockAsync(List1);
        var waiting = store.LockAsync(List1, cts.Token);
        cts.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => waiting);
        held.Dispose();
    }
}
