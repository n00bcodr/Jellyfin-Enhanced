using System.Collections;
using System.Reflection;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using Jellyfin.Plugin.JellyfinEnhanced.Model;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Globalization;
using Moq;

namespace JE.Tests;

[Collection("Plugin singleton")]
public class NativeScenesInvalidationTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task UnchangedScenesRefreshPublishesNoIdsAndPreservesEveryNativeSnapshot(bool bulkCache)
    {
        using var h = new Harness(bulkCache);
        await h.SeedAsync();
        var before = h.Memos();
        h.Clock.Now = h.Clock.Now.AddDays(1);
        await h.RefreshAsync(h.A, h.B);
        Assert.Equal(4, h.Transport.Calls); // a real daily provider check, not a skipped warm
        h.AssertUnchanged(before);

        // A settings pass and an already-fresh gathered pass are also no-ops.
        h.Cache.OnScenesSettingsChanged();
        await h.Cache.ScenesWorkQueue.WaitAsync(TimeSpan.FromSeconds(5));
        await h.RefreshAsync(h.A);
        h.AssertUnchanged(before);
        Assert.Equal(4, h.Transport.Calls);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task FailedScenesRefreshPublishesNoIdsAndPreservesUnrelatedNativeSnapshots(bool bulkCache)
    {
        using var h = new Harness(bulkCache);
        await h.SeedAsync();
        var before = h.Memos();
        h.Fail = true;
        h.Clock.Now = h.Clock.Now.AddDays(1);
        await h.RefreshAsync(h.B); // A has confirmed facts but is unrelated to this failure.
        Assert.Equal(3, h.Transport.Calls);
        Assert.Equal(new TagScenes(true, false), h.Cache.GetScenes(h.A));
        h.AssertUnchanged(before);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ChangedScenesTitleInvalidatesOnlyItsNativeSnapshotAndDependentSeasonsAndEpisodes(bool bulkCache)
    {
        using var h = new Harness(bulkCache);
        await h.SeedAsync();
        var before = h.Memos();
        h.Changed = true;
        h.Clock.Now = h.Clock.Now.AddDays(1);
        await h.RefreshAsync(h.A);
        Assert.Equal(new[] { h.A.Id }, Assert.Single(h.Publications));
        foreach (var id in new[] { h.A.Id, h.SeasonId, h.EpisodeId }) Assert.False(h.Memo.Contains(id));
        Assert.Same(before[h.B.Id], h.Memo[h.B.Id]);
        Assert.Same(before[h.OtherEpisodeId], h.Memo[h.OtherEpisodeId]);
        var rebuilt = await h.BuildAsync(h.A);
        Assert.Equal(new TagScenes(false, true), rebuilt.Scenes);
        if (bulkCache) Assert.Equal(rebuilt.Scenes, h.Entries[h.A.Id.ToString("N")].Scenes);
    }

    [Theory]
    [InlineData("disable")]
    [InlineData("enable")]
    [InlineData("provider")]
    public async Task ScenesSettingsChangesInvalidateChangedFactsWithoutABulkCache(string change)
    {
        using var h = new Harness(false);
        if (change == "enable") h.Fixture.Plugin.Configuration.StatusTagsScenes = false;
        await h.SeedAsync();
        var before = h.Memos();
        var config = h.Fixture.Plugin.Configuration;
        if (change == "provider") { config.TMDB_API_KEY = "other-key"; h.Changed = true; }
        else config.StatusTagsScenes = change == "enable";
        h.Cache.OnScenesSettingsChanged();
        await h.Cache.ScenesWorkQueue.WaitAsync(TimeSpan.FromSeconds(5));
        var ids = Assert.Single(h.Publications);
        Assert.Contains(h.A.Id, ids);
        Assert.False(h.Memo.Contains(h.A.Id));
        if (change == "provider")
        {
            Assert.Single(ids);
            Assert.Same(before[h.B.Id], h.Memo[h.B.Id]);
        }
        else
        {
            Assert.Equal(2, ids.Length);
            Assert.Contains(h.B.Id, ids);
            Assert.False(h.Memo.Contains(h.B.Id));
        }
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ScenesDisabledRetainsZeroProjectionsAfterManyReadsAndTenThousandNativeBuilds(bool statusEnabled)
    {
        using var h = new Harness(false);
        h.Fixture.Plugin.Configuration.StatusTagsEnabled = statusEnabled;
        h.Fixture.Plugin.Configuration.StatusTagsScenes = false;
        for (var i = 0; i < 20_000; i++) Assert.Null(h.Cache.GetScenes(NewMovie()));
        Assert.Equal(0, h.ReadProjectionCount);
        for (var i = 0; i < 10_000; i++) Assert.Null((await h.BuildAsync(NewMovie())).Scenes);
        Assert.Equal(0, h.ReadProjectionCount);
        Assert.InRange(h.Memo.Count, 1, 4096);
        Assert.Equal(0, h.Transport.Calls);
    }

    [Fact]
    public async Task EnabledScenesBaselinesStayWithLiveSnapshotsAcrossTenThousandBuildsAndItemDeletion()
    {
        using var h = new Harness(false);
        await h.SeedAsync();
        for (var i = 0; i < 20_000; i++) Assert.Equal(new TagScenes(true, false), h.Cache.GetScenes(NewMovie()));
        Assert.Equal(0, h.ReadProjectionCount);
        for (var i = 0; i < 10_000; i++)
        {
            Assert.Equal(new TagScenes(true, false), (await h.BuildAsync(NewMovie())).Scenes);
            Assert.InRange(h.Memo.Count, 1, 4096);
            Assert.True(h.ReadProjectionCount <= h.Memo.Count);
        }
        Assert.False(h.Memo.Contains(h.A.Id)); // its baseline went out with the oldest quarter
        Assert.Equal(0, h.ReadProjectionCount); // no separate read-history retention
        var last = NewMovie();
        await h.BuildAsync(last);
        Assert.True(h.Memo.Contains(last.Id));
        h.Library.Raise(x => x.ItemRemoved += null, h.Library.Object, new ItemChangeEventArgs { Item = last });
        Assert.False(h.Memo.Contains(last.Id));
        Assert.Equal(0, h.ReadProjectionCount);
        await h.RefreshAsync(last);
        Assert.Empty(h.Publications); // a deleted snapshot is no longer a dependent
    }

    [Fact]
    public async Task RefreshAfterEvictionRebuildsChangedTitleAndInvalidatesItsReplacementSnapshot()
    {
        using var h = new Harness(false);
        await h.SeedAsync();
        for (var i = 0; i < 4096; i++) await h.BuildAsync(NewMovie());
        Assert.False(h.Memo.Contains(h.A.Id));
        h.Changed = true;
        h.Clock.Now = h.Clock.Now.AddDays(1);
        await h.RefreshAsync(h.A);
        Assert.Equal(new TagScenes(false, true), (await h.BuildAsync(h.A)).Scenes);
        h.Publications.Clear();
        h.Changed = false;
        h.Clock.Now = h.Clock.Now.AddDays(1);
        await h.RefreshAsync(h.A);
        Assert.Contains(h.A.Id, Assert.Single(h.Publications));
        Assert.False(h.Memo.Contains(h.A.Id));
        Assert.Equal(new TagScenes(true, false), (await h.BuildAsync(h.A)).Scenes);
    }

    [Fact]
    public async Task ColdEnabledSnapshotInvalidatesWhenUnknownScenesBecomeConfirmed()
    {
        using var h = new Harness(false);
        h.Cache.ScenesRefreshDelay = TimeSpan.FromHours(1);
        Assert.Null((await h.BuildAsync(h.A)).Scenes);
        Assert.True(h.Memo.Contains(h.A.Id));
        await h.WarmAsync();
        // Publish directly: the deliberately parked read queue must not block this assertion.
        typeof(TagCacheService).GetMethod("RefreshScenes", BindingFlags.Instance | BindingFlags.NonPublic)!.Invoke(h.Cache, null);
        Assert.Contains(h.A.Id, Assert.Single(h.Publications));
        Assert.False(h.Memo.Contains(h.A.Id));
        Assert.Equal(new TagScenes(true, false), (await h.BuildAsync(h.A)).Scenes);
    }

    [Fact]
    public async Task RefreshDuringNativeBuildDoesNotPublishAnUntrackedStaleScenesSnapshot()
    {
        using var h = new Harness(false);
        await h.WarmAsync();
        using var started = new ManualResetEventSlim();
        using var release = new ManualResetEventSlim();
        h.A.ReadSources = () =>
        {
            started.Set();
            Assert.True(release.Wait(TimeSpan.FromSeconds(10)));
        };
        var build = h.BuildAsync(h.A);
        try
        {
            Assert.True(started.Wait(TimeSpan.FromSeconds(10)));
            h.Changed = true;
            h.Clock.Now = h.Clock.Now.AddDays(1);
            await h.RefreshAsync(h.A);
            Assert.Empty(h.Publications); // no live memo existed when the refresh ran
        }
        finally { release.Set(); }
        Assert.Equal(new TagScenes(true, false), (await build).Scenes);
        Assert.False(h.Memo.Contains(h.A.Id));
        h.A.ReadSources = null;
        Assert.Equal(new TagScenes(false, true), (await h.BuildAsync(h.A)).Scenes);
        Assert.True(h.Memo.Contains(h.A.Id));
    }

    private static Movie NewMovie() => new()
    {
        Id = Guid.NewGuid(), Name = "Synthetic", ProviderIds = new(StringComparer.OrdinalIgnoreCase) { ["Tmdb"] = "7" }
    };

    private sealed class Clock : TimeProvider
    {
        internal DateTimeOffset Now = DateTimeOffset.Parse("2026-10-30T12:00:00Z");
        public override DateTimeOffset GetUtcNow() => Now;
    }

    // GetBaseItemKind uses the class name; no actual file/stream access is needed.
    private sealed class Movie : MediaBrowser.Controller.Entities.Movies.Movie
    {
        internal Action? ReadSources;
        public override List<MediaBrowser.Model.Dto.MediaSourceInfo> GetMediaSources(bool enablePathSubstitution)
        {
            ReadSources?.Invoke();
            return [];
        }
    }

    private sealed class Harness : IDisposable
    {
        internal readonly ApiPluginFixture Fixture = new();
        internal readonly Clock Clock = new();
        internal readonly Movie A = new() { Id = Guid.NewGuid(), Name = "A", ProviderIds = new(StringComparer.OrdinalIgnoreCase) { ["Tmdb"] = "7" } };
        internal readonly Movie B = new() { Id = Guid.NewGuid(), Name = "B", ProviderIds = new(StringComparer.OrdinalIgnoreCase) { ["Tmdb"] = "8" } };
        internal readonly Guid SeasonId = Guid.NewGuid(), EpisodeId = Guid.NewGuid(), OtherEpisodeId = Guid.NewGuid();
        internal readonly Mock<ILibraryManager> Library = new();
        internal readonly TagCacheService Cache;
        internal readonly PosterTagDataProvider Native;
        internal readonly IntegrationTransport Transport;
        internal readonly List<Guid[]> Publications = [];
        internal bool Fail, Changed;
        private readonly TmdbResponseCache _responses;
        private readonly StatusTagsScenesService _scenes;
        private readonly bool _bulkCache;
        internal IDictionary Memo => (IDictionary)Field(Native, "_memo");
        internal System.Collections.Concurrent.ConcurrentDictionary<string, TagCacheEntry> Entries =>
            (System.Collections.Concurrent.ConcurrentDictionary<string, TagCacheEntry>)Field(Cache, "_cache");
        // Count any separate per-read baseline map as well as checking the actual memo.
        // A removed map contributes zero; this also detects the historical retention regression.
        internal int ReadProjectionCount => typeof(TagCacheService)
            .GetField("_scenesProjections", BindingFlags.Instance | BindingFlags.NonPublic)?.GetValue(Cache) is IDictionary projections
                ? projections.Count : 0;
        private long Generation => (long)Field(Native, "_memoGeneration");
        private long _generation, _version;

        internal Harness(bool bulkCache)
        {
            _bulkCache = bulkCache;
            var config = Fixture.Plugin.Configuration;
            config.TagCacheServerMode = bulkCache;
            config.StatusTagsEnabled = config.StatusTagsScenes = true;
            config.TMDB_API_KEY = "key";
            Transport = new IntegrationTransport((request, _) => Task.FromResult(Fail
                ? IntegrationTransport.Response("{}", 503)
                : IntegrationTransport.Response(Changed && request.RequestUri!.AbsolutePath == "/3/movie/7/keywords"
                    ? "{\"keywords\":[{\"name\":\"duringcreditsstinger\"}]}"
                    : "{\"keywords\":[{\"name\":\"aftercreditsstinger\"}]}")));
            _responses = new TmdbResponseCache(Transport, Clock);
            _scenes = new StatusTagsScenesService(_responses, Fixture.Core.Logger, Clock) { RequestInterval = TimeSpan.Zero };
            var library = Library;
            library.Setup(x => x.GetItemById(A.Id)).Returns(A);
            library.Setup(x => x.GetItemById(B.Id)).Returns(B);
            library.Setup(x => x.GetItemList(It.IsAny<InternalItemsQuery>())).Returns([A, B]);
            Cache = new TagCacheService(library.Object, Fixture.Core.Paths.Object, Mock.Of<ILocalizationManager>(), Fixture.Core.Logger,
                new MatroskaLanguageCache(Fixture.Core.Paths.Object, Fixture.Core.Logger), scenesService: _scenes) { ScenesRefreshDelay = TimeSpan.Zero };
            Native = new PosterTagDataProvider(Cache, library.Object, null!, null!, null!, Fixture.Core.Logger);
            Cache.ScenesRefreshed += ids => Publications.Add(ids.Order().ToArray());
        }

        internal Task WarmAsync() => _scenes.WarmAsync("key", ["7", "8"], default);

        internal async Task SeedAsync()
        {
            await WarmAsync();
            var a = await BuildAsync(A);
            var b = await BuildAsync(B);
            if (_bulkCache)
            {
                Entries[A.Id.ToString("N")] = a;
                Entries[B.Id.ToString("N")] = b;
                typeof(TagCacheService).GetField("_cacheReleased", BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(Cache, false);
            }
            // Movies have no real children; synthetic dependencies exercise the shared owner invalidator.
            AddMemo(SeasonId, "Season", A.Id);
            AddMemo(EpisodeId, "Episode", A.Id);
            AddMemo(OtherEpisodeId, "Episode", B.Id);
            _generation = Generation;
            _version = Cache.Version;
        }

        internal async Task<TagCacheEntry> BuildAsync(BaseItem item) => Assert.IsType<TagCacheEntry>((await (Task<(TagCacheEntry? Entry, string CustomTags)>)
            typeof(PosterTagDataProvider).GetMethod("BuildAsync", BindingFlags.Instance | BindingFlags.NonPublic)!.Invoke(Native, [item])!).Entry);

        private void AddMemo(Guid id, string type, Guid owner)
        {
            var memoType = typeof(PosterTagDataProvider).GetNestedType("MemoEntry", BindingFlags.NonPublic)!;
            Memo[id] = Activator.CreateInstance(memoType, new TagCacheEntry { Type = type, SeriesId = owner.ToString("N") }, DateTime.UtcNow, Cache.CustomTagMatchFingerprint)!;
        }

        internal async Task RefreshAsync(params BaseItem[] items)
        {
            Cache.QueueScenesRefresh(items);
            await Cache.ScenesWorkQueue.WaitAsync(TimeSpan.FromSeconds(5));
        }

        internal Dictionary<Guid, object> Memos() => Memo.Keys.Cast<Guid>().ToDictionary(id => id, id => Memo[id]!);

        internal void AssertUnchanged(Dictionary<Guid, object> before)
        {
            Assert.Empty(Publications);
            Assert.Equal(_generation, Generation);
            Assert.Equal(_version, Cache.Version);
            Assert.Equal(before.Count, Memo.Count);
            foreach (var pair in before) Assert.Same(pair.Value, Memo[pair.Key]);
        }

        private static object Field(object owner, string name) => owner.GetType().GetField(name, BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(owner)!;

        public void Dispose()
        {
            Native.Dispose();
            Cache.Dispose();
            _responses.Dispose();
            Transport.Dispose();
            Fixture.Dispose();
        }
    }
}
