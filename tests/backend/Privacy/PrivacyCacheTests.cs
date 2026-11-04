using System.Collections.Concurrent;
using System.Text.Json;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Model;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Globalization;
using Moq;
using Xunit;

namespace JellyfinEnhanced.Tests;

[Collection("Plugin singleton")]
public class PrivacyCacheTests
{
    [Fact]
    public void PendingChangesCoalesceLastIntentIgnoreEmptyAndDrainOnce()
    {
        var pending = new TagCachePendingChanges(); var first = Guid.NewGuid(); var second = Guid.NewGuid();
        pending.Record(Guid.Empty, true);
        for (var i = 0; i < 1000; i++) pending.Record(first, false);
        pending.Record(first, true); pending.Record(second, true); pending.Record(second, false);
        Assert.Equal(2, pending.Count);
        var drained = pending.Drain().ToDictionary(x => x.Id, x => x.Removed);
        Assert.True(drained[first]); Assert.False(drained[second]); Assert.True(pending.IsEmpty); Assert.Empty(pending.Drain());
        pending.Record(first, false); Assert.Equal((first, false), Assert.Single(pending.Drain()));
        // A requeued update never overrides a change recorded after the drain.
        pending.Record(first, true); pending.Requeue(first); pending.Requeue(second);
        drained = pending.Drain().ToDictionary(x => x.Id, x => x.Removed);
        Assert.True(drained[first]); Assert.False(drained[second]);
    }

    [Fact]
    public async Task ConcurrentRecordingAndDrainingDoesNotLoseDistinctItems()
    {
        var pending = new TagCachePendingChanges(); var ids = Enumerable.Range(0, 2000).Select(_ => Guid.NewGuid()).ToArray();
        var received = new ConcurrentDictionary<Guid, byte>();
        var producer = Task.Run(() => Parallel.ForEach(ids, id => pending.Record(id, true)));
        while (!producer.IsCompleted) { foreach (var change in pending.Drain()) { Assert.True(change.Removed); Assert.True(received.TryAdd(change.Id, 0)); } await Task.Yield(); }
        await producer;
        foreach (var change in pending.Drain()) Assert.True(received.TryAdd(change.Id, 0));
        Assert.Equal(ids.Order(), received.Keys.Order());
    }

    [Theory]
    [InlineData(0, 2)] [InlineData(8, 2)] [InlineData(9, 1)] [InlineData(10, 0)] [InlineData(20, 0)]
    public void ContinuousUpdatesCannotPostponeFlushBeyondDeadline(int elapsed, int delay)
    {
        var start = new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc);
        Assert.Equal(TimeSpan.FromSeconds(delay), TagCacheService.ComputeFlushDelay(start.Ticks, start.AddSeconds(elapsed), TimeSpan.FromSeconds(2), TimeSpan.FromSeconds(10)));
        Assert.Equal(TimeSpan.FromSeconds(2), TagCacheService.ComputeFlushDelay(0, start, TimeSpan.FromSeconds(2), TimeSpan.FromSeconds(10)));
    }

    [Fact]
    public void BatchFailureDoesNotPreventOtherChangesAndNoopsDoNotClaimMutation()
    {
        using var f = new JE.Tests.ApiPluginFixture(); using var cache = Create(f, new Mock<ILibraryManager>());
        var broken = Guid.NewGuid(); var updated = Guid.NewGuid(); var deleted = Guid.NewGuid(); var calls = new List<Guid>();
        Assert.True(cache.ApplyBatch([(broken, false), (updated, false), (deleted, true)], id => { calls.Add(id); if (id == broken) throw new IOException("failed lookup"); return true; }, id => { calls.Add(id); return false; }));
        Assert.Equal(new[] { broken, updated, deleted }, calls);
        Assert.False(cache.ApplyBatch([(updated, false), (deleted, true)], _ => false, _ => false));
    }

    [Fact]
    public void AccessSetsAreUserScopedCachedAndInvalidatedWithRevisionIndependentOfDelta()
    {
        using var f = new JE.Tests.ApiPluginFixture(); f.Plugin.Configuration.TagCacheServerMode = true;
        var alice = new User("alice", "default", "default") { Id = Guid.NewGuid() }; var bob = new User("bob", "default", "default") { Id = Guid.NewGuid() };
        var first = Guid.NewGuid(); var second = Guid.NewGuid(); var accessible = new[] { first }; var calls = 0;
        var library = new Mock<ILibraryManager>();
        library.Setup(x => x.GetItemIds(It.IsAny<InternalItemsQuery>())).Returns((InternalItemsQuery query) => { calls++; return query.User == alice ? accessible : new[] { second }; });
        Seed(f, new() { [first.ToString("N")] = Entry(100), [second.ToString("N")] = Entry(200) });
        using var cache = Create(f, library); cache.LoadFromDisk();
        Assert.Equal(new[] { first.ToString("N") }, cache.GetCacheForUser(alice, out var version, out var stamp, out var revision).Keys);
        Assert.Equal(7, version); Assert.Equal(200, stamp);
        Assert.Equal(new[] { second.ToString("N") }, cache.GetCacheForUser(bob, out _, out _, out var bobRevision).Keys); Assert.NotEqual(revision, bobRevision);
        Assert.Empty(cache.GetCacheForUser(alice, out _, out _, out var deltaRevision, since: 100)); Assert.Equal(revision, deltaRevision); Assert.Equal(2, calls);
        accessible = [first, second]; cache.InvalidateUserAccess();
        Assert.Equal(2, cache.GetCacheForUser(alice, out _, out _, out var fullRevision).Count); Assert.Equal("all", fullRevision); Assert.NotEqual(revision, fullRevision); Assert.Equal(3, calls);
        Assert.Single(cache.GetCacheForUser(alice, out _, out _, since: 100));
        Assert.Equal(2, cache.GetCacheForUser(alice, out _, out _, since: 200, alsoInclude: (_, _) => true).Count);
    }

    [Fact]
    public void SubtitleEntriesFollowAccessFilteringAndItsRevisionForFullLoadsAndDeltas()
    {
        using var f = new JE.Tests.ApiPluginFixture(); f.Plugin.Configuration.TagCacheServerMode = true;
        var user = new User("viewer", "default", "default") { Id = Guid.NewGuid() };
        var first = Guid.NewGuid(); var second = Guid.NewGuid(); var allowed = new[] { first };
        var library = new Mock<ILibraryManager>();
        library.Setup(x => x.GetItemIds(It.IsAny<InternalItemsQuery>())).Returns(() => allowed);
        var a = Entry(100); a.SubtitleLanguages = ["en"];
        var b = Entry(200); b.SubtitleLanguages = ["ja"];
        Seed(f, new() { [first.ToString("N")] = a, [second.ToString("N")] = b });
        using var cache = Create(f, library); cache.LoadFromDisk();
        var initial = cache.GetCacheForUser(user, out _, out _, out var revision);
        Assert.Equal(new[] { "en" }, Assert.Single(initial).Value.SubtitleLanguages);
        Assert.Empty(cache.GetCacheForUser(user, out _, out _, out var deltaRevision, since: 100));
        Assert.Equal(revision, deltaRevision);
        allowed = [first, second]; cache.InvalidateUserAccess();
        var expanded = cache.GetCacheForUser(user, out _, out _, out var changed);
        Assert.NotEqual(revision, changed);
        Assert.Equal(new[] { "ja" }, expanded[second.ToString("N")].SubtitleLanguages);
    }

    [Fact]
    public void LatestEpisodeDateIsDroppedForUsersWhoCannotSeeTheEpisodeItCameFrom()
    {
        using var f = new JE.Tests.ApiPluginFixture(); f.Plugin.Configuration.TagCacheServerMode = true;
        var alice = new User("alice", "default", "default") { Id = Guid.NewGuid() }; var bob = new User("bob", "default", "default") { Id = Guid.NewGuid() };
        var series = Guid.NewGuid(); var newest = Guid.NewGuid(); var (seriesKey, newestKey) = (series.ToString("N"), newest.ToString("N"));
        var library = new Mock<ILibraryManager>();
        // Bob can see the series but not its newest episode (e.g. a parental rating or blocked tag).
        library.Setup(x => x.GetItemIds(It.IsAny<InternalItemsQuery>())).Returns((InternalItemsQuery query) => query.User == alice ? new[] { series, newest } : new[] { series });
        Seed(f, new()
        {
            [seriesKey] = new() { Type = "Series", DateCreated = 100, LatestEpisodeAdded = 500, LatestEpisodeId = newestKey, LastUpdated = 100 },
            [newestKey] = new() { Type = "Episode", SeriesId = seriesKey, DateCreated = 500, LastUpdated = 100 },
        });
        using var cache = Create(f, library); cache.LoadFromDisk();

        Assert.Equal(500, cache.GetCacheForUser(alice, out _, out _, out var aliceRevision)[seriesKey].LatestEpisodeAdded); Assert.Equal("all", aliceRevision);
        var bobItems = cache.GetCacheForUser(bob, out _, out _, out var bobRevision);
        Assert.False(bobItems.ContainsKey(newestKey)); Assert.Null(bobItems[seriesKey].LatestEpisodeAdded); Assert.Null(bobItems[seriesKey].LatestEpisodeId);
        Assert.Equal(100, bobItems[seriesKey].DateCreated); Assert.NotEqual("all", bobRevision);
        Assert.Null(cache.GetCacheForUser(bob, out _, out _, since: 50)[seriesKey].LatestEpisodeAdded); // a delta filters the same way
        Assert.True(cache.TryGetEntry(series, out var shared)); Assert.Equal(500, shared.LatestEpisodeAdded); Assert.Equal(newestKey, shared.LatestEpisodeId);

        var copy = shared.Clone(); Assert.Equal(newestKey, copy.LatestEpisodeId); Assert.True(TagCacheEntry.ContentEquals(shared, copy));
        copy.LatestEpisodeId = seriesKey; Assert.False(TagCacheEntry.ContentEquals(shared, copy));
    }

    [Fact]
    public void RestartPreservesSnapshotAndQueuedRemovalReachesDeltasAcrossShutdown()
    {
        using var f = new JE.Tests.ApiPluginFixture(); f.Plugin.Configuration.TagCacheServerMode = true;
        var first = Guid.NewGuid(); var second = Guid.NewGuid(); var library = new Mock<ILibraryManager>();
        var viewer = new User("viewer", "default", "default") { Id = Guid.NewGuid() };
        library.Setup(x => x.GetItemIds(It.IsAny<InternalItemsQuery>())).Returns(new[] { first, second });
        Seed(f, new() { [first.ToString("N")] = Entry(100), [second.ToString("N")] = Entry(200) });
        using (var cache = Create(f, library)) { cache.LoadFromDisk(); Assert.Equal(2, cache.Count); cache.EnqueueRemoval(first); }
        using var restarted = Create(f, library); restarted.LoadFromDisk();
        // The removal is a delta, not a new generation, and its tombstone survives the restart.
        Assert.Equal(1, restarted.Count); Assert.Equal(7, restarted.Version); Assert.False(restarted.TryGetEntry(first, out _)); Assert.True(restarted.TryGetEntry(second, out var entry)); Assert.Equal(200, entry.LastUpdated);
        Assert.Empty(restarted.GetCacheForUser(viewer, out _, out var cursor, out _, out var removed, 200, null));
        Assert.Equal(new[] { first.ToString("N") }, removed);
        restarted.GetCacheForUser(viewer, out _, out _, out _, out removed, cursor, null);
        Assert.Empty(removed);
        Assert.False(File.Exists(SnapshotPath(f) + ".tmp"));
    }

    [Fact]
    public void RemovalsReachDeltasWithoutAVersionChangeUntilTheLogOverflows()
    {
        using var f = new JE.Tests.ApiPluginFixture(); f.Plugin.Configuration.TagCacheServerMode = true;
        var ids = Enumerable.Range(0, TagCacheService.MaxTombstones + 2).Select(_ => Guid.NewGuid()).ToArray();
        var library = new Mock<ILibraryManager>(); library.Setup(x => x.GetItemIds(It.IsAny<InternalItemsQuery>())).Returns(ids);
        var viewer = new User("viewer", "default", "default") { Id = Guid.NewGuid() };
        Seed(f, ids.ToDictionary(id => id.ToString("N"), _ => Entry(100)));
        using var cache = Create(f, library); cache.LoadFromDisk();
        Assert.Equal(ids.Length, cache.GetCacheForUser(viewer, out var version, out var cursor, out _, out var removed, null, null).Count);
        Assert.Empty(removed);

        // As the flush does: apply the batch, then advance the cursor.
        Assert.True(cache.ApplyBatch([(ids[0], true), (ids[1], true)], _ => false, cache.RemoveEntry));
        cache.TouchLastModified();
        var delta = cache.GetCacheForUser(viewer, out var after, out var next, out _, out removed, cursor, null);
        Assert.Equal(version, after);
        Assert.Empty(delta);
        Assert.Equal(new[] { ids[0].ToString("N"), ids[1].ToString("N") }.Order(), removed.Order());
        Assert.True(next >= cursor);
        // At the returned cursor the same removals are not sent again; a removal that
        // never happened (an id not in the cache) is no removal at all.
        cache.GetCacheForUser(viewer, out _, out _, out _, out removed, next, null);
        Assert.Empty(removed);
        Assert.False(cache.RemoveEntry(Guid.NewGuid()));

        // Past the bounded log, one version change makes clients reload instead.
        foreach (var id in ids.Skip(2)) cache.RemoveEntry(id);
        Assert.Equal(version + 1, cache.Version);
    }

    [Fact]
    public void DisableReleasesMemoryWithoutOverwritingPersistedSnapshotAndReloadRestores()
    {
        using var f = new JE.Tests.ApiPluginFixture(); f.Plugin.Configuration.TagCacheServerMode = true;
        var item = Guid.NewGuid(); Seed(f, new() { [item.ToString("N")] = Entry(100) }); var library = new Mock<ILibraryManager>();
        using var cache = Create(f, library); cache.LoadFromDisk(); var original = File.ReadAllText(SnapshotPath(f));
        f.Plugin.Configuration.TagCacheServerMode = false; cache.OnServerModeDisabled(); cache.SaveToDisk();
        Assert.Equal(0, cache.Count); Assert.False(cache.TryGetEntry(item, out _)); Assert.Equal(original, File.ReadAllText(SnapshotPath(f)));
        Assert.Empty(cache.GetCacheForUser(new User("test", "default", "default"), out _, out _)); library.Verify(x => x.GetItemIds(It.IsAny<InternalItemsQuery>()), Times.Never);
        f.Plugin.Configuration.TagCacheServerMode = true; cache.LoadFromDisk(); Assert.True(cache.TryGetEntry(item, out _));
    }

    [Theory]
    [InlineData("{")] [InlineData("null")] [InlineData("{\"SchemaVersion\":6,\"Items\":{\"old\":{}}}")]
    public void CorruptAndOldSnapshotsRemainUnpublishedAndAreNotOverwritten(string content)
    {
        using var f = new JE.Tests.ApiPluginFixture(); f.Plugin.Configuration.TagCacheServerMode = true;
        Directory.CreateDirectory(f.Core.ConfigRoot); File.WriteAllText(SnapshotPath(f), content);
        using var cache = Create(f, new Mock<ILibraryManager>()); cache.LoadFromDisk(); cache.SaveToDisk();
        Assert.Equal(0, cache.Count); Assert.Equal(content, File.ReadAllText(SnapshotPath(f)));
    }

    [Fact]
    public void FailedAndCancelledFullBuildsKeepPublishedSnapshotAndSuccessfulBuildReplacesIt()
    {
        using var f = new JE.Tests.ApiPluginFixture(); f.Plugin.Configuration.TagCacheServerMode = true;
        var originalId = Guid.NewGuid(); Seed(f, new() { [originalId.ToString("N")] = Entry(100) });
        var library = new Mock<ILibraryManager>(); using var cache = Create(f, library); cache.LoadFromDisk();
        var snapshot = File.ReadAllText(SnapshotPath(f));
        using var cancelled = new CancellationTokenSource(); cancelled.Cancel();
        Assert.ThrowsAny<OperationCanceledException>(() => cache.BuildFullCache(null, cancelled.Token));
        Assert.True(cache.TryGetEntry(originalId, out _)); Assert.Equal(7, cache.Version);
        library.Setup(x => x.GetItemIds(It.IsAny<InternalItemsQuery>())).Returns(new[] { Guid.NewGuid() });
        library.Setup(x => x.GetItemList(It.IsAny<InternalItemsQuery>())).Throws(new IOException("hydration failed"));
        Assert.Throws<IOException>(() => cache.BuildFullCache(null, CancellationToken.None));
        Assert.True(cache.TryGetEntry(originalId, out _)); Assert.Equal(snapshot, File.ReadAllText(SnapshotPath(f)));
        library.Setup(x => x.GetItemIds(It.IsAny<InternalItemsQuery>())).Returns(Array.Empty<Guid>());
        cache.BuildFullCache(null, CancellationToken.None);
        Assert.Equal(0, cache.Count); Assert.Equal(8, cache.Version); Assert.True(cache.LastModified > 200);
        using var restarted = Create(f, library); restarted.LoadFromDisk(); Assert.Equal(0, restarted.Count); Assert.Equal(8, restarted.Version);
    }

    private static TagCacheService Create(JE.Tests.ApiPluginFixture f, Mock<ILibraryManager> library) => new(library.Object, f.Core.Paths.Object, Mock.Of<ILocalizationManager>(), f.Core.Logger, new Jellyfin.Plugin.JellyfinEnhanced.Helpers.MatroskaLanguageCache(f.Core.Paths.Object, f.Core.Logger));
    private static TagCacheEntry Entry(long updated) => new() { Type = "Movie", Genres = ["Drama"], LastUpdated = updated };
    private static string SnapshotPath(JE.Tests.ApiPluginFixture f) => Path.Combine(f.Core.ConfigRoot, "tag-cache.json");
    private static void Seed(JE.Tests.ApiPluginFixture f, Dictionary<string, TagCacheEntry> items)
    {
        Directory.CreateDirectory(f.Core.ConfigRoot);
        // Current-schema fixture exercises the persisted contract consumed across process restarts.
        File.WriteAllText(SnapshotPath(f), JsonSerializer.Serialize(new { SchemaVersion = TagCacheService.CurrentCacheSchemaVersion, Version = 7, LastModified = 200, LastReconciledUtcTicks = new DateTime(2026, 1, 1).Ticks, Items = items }));
    }
}
