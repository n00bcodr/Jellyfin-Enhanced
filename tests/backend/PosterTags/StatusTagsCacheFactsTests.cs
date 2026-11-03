using System.Text.Json;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using Jellyfin.Plugin.JellyfinEnhanced.Model;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.Globalization;
using Moq;

namespace JE.Tests;

/// <summary>
/// The Status Tags schedule and milestone facts on Series/Season/Episode
/// entries: built over the container's episodes the same way by the full build
/// and an on-demand rebuild, and dropped per user when an episode they came
/// from is hidden.
/// </summary>
[Collection("Plugin singleton")]
public class StatusTagsCacheFactsTests
{
    private sealed class Episode : MediaBrowser.Controller.Entities.TV.Episode
    {
        public override List<MediaSourceInfo> GetMediaSources(bool enablePathSubstitution) =>
            [new() { MediaStreams = [new() { Type = MediaStreamType.Video, Height = 1080 }] }];
    }

    private static long Ms(DateTime value) => new DateTimeOffset(DateTime.SpecifyKind(value, DateTimeKind.Utc)).ToUnixTimeMilliseconds();

    [Theory]
    [InlineData("add")]
    [InlineData("remove")]
    [InlineData("hide")]
    public void IncrementalEpisodeChangesRefreshEverySibling(string change)
    {
        using var f = new ApiPluginFixture();
        f.Plugin.Configuration.TagCacheServerMode = true;
        var series = new Series { Id = Guid.NewGuid() };
        var season = new Season { Id = Guid.NewGuid(), SeriesId = series.Id, ParentId = series.Id, IndexNumber = 1 };
        Episode Make(int number) => new() { Id = Guid.NewGuid(), SeriesId = series.Id, SeasonId = season.Id,
            ParentId = season.Id, ParentIndexNumber = 1, IndexNumber = number, DateCreated = DateTime.UtcNow.AddDays(-1) };
        var e5 = Make(5);
        var e6 = Make(6);
        var all = new List<BaseItem> { series, season, e5 };
        if (change == "remove") all.Add(e6);
        var user = new User("viewer", "default", "default") { Id = Guid.NewGuid() };
        var library = new Mock<ILibraryManager>();
        IEnumerable<BaseItem> Select(InternalItemsQuery q)
        {
            IEnumerable<BaseItem> selected = all;
            if (q.User != null && change == "hide") selected = selected.Where(i => i.Id != e6.Id);
            if (q.ItemIds?.Length > 0) selected = selected.Where(i => q.ItemIds.Contains(i.Id));
            else if (q.IncludeItemTypes?.Length > 0) selected = selected.Where(i => q.IncludeItemTypes.Contains(i.GetBaseItemKind()));
            if (q.ParentId != Guid.Empty) selected = selected.Where(i => i is Episode e && (q.ParentId == series.Id || e.SeasonId == q.ParentId));
            return selected.Skip(q.StartIndex ?? 0).Take(q.Limit ?? int.MaxValue);
        }
        library.Setup(l => l.GetItemIds(It.IsAny<InternalItemsQuery>())).Returns((InternalItemsQuery q) => Select(q).Select(i => i.Id).ToArray());
        library.Setup(l => l.GetItemList(It.IsAny<InternalItemsQuery>())).Returns((InternalItemsQuery q) => Select(q).ToArray());
        library.Setup(l => l.GetItemById<BaseItem>(It.IsAny<Guid>())).Returns((Guid id) => all.SingleOrDefault(i => i.Id == id));
        library.Setup(l => l.GetItemById(It.IsAny<Guid>())).Returns((Guid id) => all.SingleOrDefault(i => i.Id == id));
        using var cache = new TagCacheService(library.Object, f.Core.Paths.Object, Mock.Of<ILocalizationManager>(), f.Core.Logger, new MatroskaLanguageCache(f.Core.Paths.Object, f.Core.Logger));
        cache.BuildFullCache(null, CancellationToken.None);
        if (change == "remove") { all.Remove(e6); cache.EnqueueRemoval(e6.Id); }
        else { all.Add(e6); cache.EnqueueUpdate(e6.Id); }
        cache.EnqueueUpdate(season.Id);
        cache.EnqueueUpdate(series.Id);
        typeof(TagCacheService).GetMethod("FlushPending", System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic)!.Invoke(cache, null);
        Assert.True(cache.TryGetEntry(e5.Id, out var entry));
        Assert.Equal(change == "remove", entry.EpisodeIndex!.IsLast);
        Assert.Equal(all.OfType<Episode>().Select(e => e.Id.ToString("N")).Order(StringComparer.Ordinal), entry.StatusEpisodeIds);
        if (change == "hide")
        {
            var filtered = cache.GetCacheForUser(user, out _, out _, out var revision)[e5.Id.ToString("N")];
            Assert.Null(filtered.EpisodeIndex);
            var native = cache.FilterStatusForUser(entry, user);
            Assert.Null(native.EpisodeIndex);
            Assert.NotNull(entry.EpisodeIndex); // native filtering cannot mutate the shared cache
            Assert.Null(entry.QualityEpisodeIds); // status visibility cannot depend on quality contributors
            Assert.NotEqual("all", revision);
        }
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void ThreeHundredSiblingsShareContributorsAcrossUnchangedRefreshes(bool reloadSnapshot)
    {
        using var f = new ApiPluginFixture();
        f.Plugin.Configuration.TagCacheServerMode = true;
        var series = new Series { Id = Guid.NewGuid() };
        var season = new Season { Id = Guid.NewGuid(), SeriesId = series.Id, ParentId = series.Id, IndexNumber = 1 };
        var episodes = Enumerable.Range(1, 300).Select(n => new Episode { Id = Guid.NewGuid(),
            SeriesId = series.Id, SeasonId = season.Id, ParentId = season.Id, ParentIndexNumber = 1,
            IndexNumber = n, DateCreated = DateTime.UtcNow.AddDays(-1) }).ToArray();
        var all = new BaseItem[] { series, season }.Concat(episodes).ToArray();
        IEnumerable<BaseItem> Select(InternalItemsQuery q)
        {
            IEnumerable<BaseItem> selected = all;
            if (q.ItemIds?.Length > 0) selected = selected.Where(i => q.ItemIds.Contains(i.Id));
            else if (q.IncludeItemTypes?.Length > 0) selected = selected.Where(i => q.IncludeItemTypes.Contains(i.GetBaseItemKind()));
            if (q.ParentId != Guid.Empty) selected = selected.OfType<Episode>().Where(e => q.ParentId == series.Id || q.ParentId == e.SeasonId);
            return selected.Skip(q.StartIndex ?? 0).Take(q.Limit ?? int.MaxValue);
        }
        var library = new Mock<ILibraryManager>();
        library.Setup(l => l.GetItemIds(It.IsAny<InternalItemsQuery>())).Returns((InternalItemsQuery q) => Select(q).Select(i => i.Id).ToArray());
        library.Setup(l => l.GetItemList(It.IsAny<InternalItemsQuery>())).Returns((InternalItemsQuery q) => Select(q).ToArray());
        library.Setup(l => l.GetItemById<BaseItem>(It.IsAny<Guid>())).Returns((Guid id) => all.SingleOrDefault(i => i.Id == id));
        library.Setup(l => l.GetItemById(It.IsAny<Guid>())).Returns((Guid id) => all.SingleOrDefault(i => i.Id == id));
        using var cache = new TagCacheService(library.Object, f.Core.Paths.Object, Mock.Of<ILocalizationManager>(), f.Core.Logger, new MatroskaLanguageCache(f.Core.Paths.Object, f.Core.Logger));
        cache.BuildFullCache(null, CancellationToken.None);
        if (reloadSnapshot) cache.LoadFromDisk();
        Assert.True(cache.TryGetEntry(episodes[0].Id, out var first));
        var sources = first.StatusEpisodeIds;
        var unchangedStamp = first.LastUpdated;
        // Renumber the last episode without changing the contributor set. Both
        // the episode rebuild and sibling refresh must reuse the canonical list.
        episodes[^1].IndexNumber = 301;
        cache.EnqueueUpdate(episodes[^1].Id);
        cache.EnqueueUpdate(season.Id);
        var timer = System.Diagnostics.Stopwatch.StartNew();
        typeof(TagCacheService).GetMethod("FlushPending", System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic)!.Invoke(cache, null);
        timer.Stop();
        Assert.True(timer.Elapsed < TimeSpan.FromMilliseconds(500), $"300 sibling refresh took {timer.Elapsed.TotalMilliseconds:F0} ms");
        foreach (var episode in episodes)
        {
            Assert.True(cache.TryGetEntry(episode.Id, out var entry));
            Assert.Same(sources, entry.StatusEpisodeIds);
        }
        Assert.True(cache.TryGetEntry(episodes[0].Id, out var unchanged));
        Assert.Equal(unchangedStamp, unchanged.LastUpdated);
        Assert.True(cache.TryGetEntry(episodes[^1].Id, out var last));
        Assert.Equal(301, last.EpisodeIndex!.Episode);
        Assert.True(last.EpisodeIndex.IsLast);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void SnapshotLoadAgesFutureEpisodesWithoutMetadataChanges(bool legacySnapshot)
    {
        using var f = new ApiPluginFixture();
        f.Plugin.Configuration.TagCacheServerMode = true;
        var series = new Series { Id = Guid.NewGuid() };
        var season = new Season { Id = Guid.NewGuid(), SeriesId = series.Id, IndexNumber = 2 };
        var episode = new Episode { Id = Guid.NewGuid(), SeriesId = series.Id, SeasonId = season.Id,
            ParentIndexNumber = 2, IndexNumber = 1, PremiereDate = DateTime.UtcNow.AddHours(-1), DateCreated = DateTime.UtcNow.AddDays(-2) };
        var all = new BaseItem[] { series, season, episode };
        var library = new Mock<ILibraryManager>();
        library.Setup(x => x.GetItemById<BaseItem>(It.IsAny<Guid>())).Returns((Guid id) => all.SingleOrDefault(i => i.Id == id));
        library.Setup(x => x.GetItemList(It.IsAny<InternalItemsQuery>())).Returns(new BaseItem[] { episode });
        // Yesterday this episode was still scheduled for tomorrow. No item has been saved since.
        var entries = all.ToDictionary(i => i.Id.ToString("N"), i => new TagCacheEntry { Type = i.GetBaseItemKind().ToString() });
        foreach (var container in new BaseItem[] { series, season })
        {
            var facts = new StatusTagsEpisodeFacts(container is Season, 2);
            typeof(StatusTagsEpisodeFacts).GetField("_now", System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic)!.SetValue(facts, DateTime.UtcNow.AddDays(-1));
            facts.Note(episode.Id, episode.DateCreated, episode.PremiereDate, 2, 1);
            facts.ApplyTo(entries[container.Id.ToString("N")]);
            Assert.Null(facts.LatestAired);
        }
        // Snapshots without the optional boundary have the episode dates but no boundary field.
        var cachedEpisode = entries[episode.Id.ToString("N")];
        cachedEpisode.PremiereDate = Ms(episode.PremiereDate!.Value);
        cachedEpisode.SeriesId = series.Id.ToString("N");
        cachedEpisode.SeasonNumber = 2;
        var cachedSeason = entries[season.Id.ToString("N")];
        cachedSeason.SeriesId = series.Id.ToString("N");
        cachedSeason.SeasonNumber = 2;
        var snapshot = JsonSerializer.SerializeToNode(new
        {
            SchemaVersion = TagCacheService.CurrentCacheSchemaVersion, Version = 7, LastModified = 200, LastReconciledUtcTicks = DateTime.UtcNow.AddDays(-1).Ticks, Items = entries,
        })!;
        if (legacySnapshot)
            foreach (var (_, entry) in snapshot["Items"]!.AsObject()) entry!.AsObject().Remove("NextEpisodePremiere");
        Directory.CreateDirectory(f.Core.ConfigRoot);
        File.WriteAllText(Path.Combine(f.Core.ConfigRoot, "tag-cache.json"), snapshot.ToJsonString());
        using var cache = new TagCacheService(library.Object, f.Core.Paths.Object, Mock.Of<ILocalizationManager>(), f.Core.Logger, new MatroskaLanguageCache(f.Core.Paths.Object, f.Core.Logger));
        cache.LoadFromDisk();
        foreach (var container in new BaseItem[] { series, season })
        {
            Assert.True(cache.TryGetEntry(container.Id, out var entry));
            Assert.Equal(Ms(episode.PremiereDate.Value), entry.LatestEpisodeAired);
            Assert.Equal(1, entry.LatestEpisodeIndex!.Episode);
            Assert.Equal(2, entry.SeasonPremiere!.Season);
            Assert.Null(entry.GetType().GetProperty("NextEpisodePremiere")?.GetValue(entry));
        }
    }

    [Fact]
    public void SeriesSeasonAndEpisodeEntriesCarryTheFactsTheBadgesRead()
    {
        using var f = new ApiPluginFixture();
        f.Plugin.Configuration.TagCacheServerMode = true;
        var series = new Series { Id = Guid.NewGuid(), Name = "Show", Status = SeriesStatus.Ended };
        var season1 = new Season { Id = Guid.NewGuid(), ParentId = series.Id, SeriesId = series.Id, IndexNumber = 1, Name = "Season 1" };
        var season2 = new Season { Id = Guid.NewGuid(), ParentId = series.Id, SeriesId = series.Id, IndexNumber = 2, Name = "Season 2" };
        var specials = new Season { Id = Guid.NewGuid(), ParentId = series.Id, SeriesId = series.Id, IndexNumber = 0, Name = "Specials" };
        Episode Make(Season season, int number, DateTime aired, DateTime added) => new()
        {
            Id = Guid.NewGuid(), Name = $"S{season.IndexNumber}E{number}", IndexNumber = number, ParentIndexNumber = season.IndexNumber,
            PremiereDate = aired, DateCreated = added, SeriesId = series.Id, ParentId = season.Id, SeasonId = season.Id, Genres = ["Drama"],
        };
        var s1e1 = Make(season1, 1, new DateTime(2025, 1, 1), new DateTime(2025, 1, 2));
        var s1e2 = Make(season1, 2, new DateTime(2025, 1, 8), new DateTime(2025, 1, 9));
        var s2e1 = Make(season2, 1, new DateTime(2026, 10, 1), new DateTime(2026, 10, 2, 10, 0, 0));
        var s2e2 = Make(season2, 2, new DateTime(2026, 10, 8), new DateTime(2026, 10, 2, 11, 0, 0));
        // A special that aired (and was added) last: never a new season or the newest episode of the series.
        var special = Make(specials, 1, new DateTime(2026, 10, 20), new DateTime(2026, 10, 21));
        var episodes = new List<Episode> { s1e1, s1e2, s2e1, s2e2, special };
        var all = new BaseItem[] { series, season1, season2, specials }.Concat(episodes).ToArray();
        var library = new Mock<ILibraryManager>();
        IEnumerable<BaseItem> Select(InternalItemsQuery q)
        {
            IEnumerable<BaseItem> selected = all;
            if (q.ItemIds?.Length > 0) selected = selected.Where(i => q.ItemIds.Contains(i.Id));
            else if (q.IncludeItemTypes?.Length > 0) selected = selected.Where(i => q.IncludeItemTypes.Contains(i.GetBaseItemKind()));
            if (q.ParentId != Guid.Empty) selected = selected.OfType<Episode>().Where(e => q.ParentId == series.Id || e.SeasonId == q.ParentId);
            return selected.Skip(q.StartIndex ?? 0).Take(q.Limit ?? int.MaxValue);
        }
        library.Setup(l => l.GetItemIds(It.IsAny<InternalItemsQuery>())).Returns((InternalItemsQuery q) => Select(q).Select(i => i.Id).ToArray());
        library.Setup(l => l.GetItemList(It.IsAny<InternalItemsQuery>())).Returns((InternalItemsQuery q) => Select(q).ToArray());
        library.Setup(l => l.GetItemById(It.IsAny<Guid>())).Returns((Guid id) => all.SingleOrDefault(i => i.Id == id));
        library.Setup(l => l.GetItemById<BaseItem>(It.IsAny<Guid>())).Returns((Guid id) => all.SingleOrDefault(i => i.Id == id));
        using var cache = new TagCacheService(library.Object, f.Core.Paths.Object, Mock.Of<ILocalizationManager>(), f.Core.Logger, new MatroskaLanguageCache(f.Core.Paths.Object, f.Core.Logger));
        cache.BuildFullCache(null, CancellationToken.None);

        Assert.True(cache.TryGetEntry(series.Id, out var builtSeries));
        Assert.Equal("Ended", builtSeries.Status);
        Assert.Equal(Ms(new DateTime(2026, 10, 8)), builtSeries.LatestEpisodeAired);
        Assert.Equal(new TagEpisodeIndex { Season = 2, Episode = 2, IsLast = true }, builtSeries.LatestEpisodeIndex);
        Assert.Equal(new TagSeasonPremiere { Season = 2, Aired = Ms(new DateTime(2026, 10, 1)) }, builtSeries.SeasonPremiere);
        Assert.Null(builtSeries.SeasonAddedSpan); // seasons only
        Assert.Equal(episodes.Select(e => e.Id.ToString("N")).Order(StringComparer.Ordinal), builtSeries.StatusEpisodeIds);
        Assert.Equal(Ms(new DateTime(2026, 10, 21)), builtSeries.LatestEpisodeAdded); // unchanged: every episode counts for New Episode

        Assert.True(cache.TryGetEntry(season2.Id, out var builtSeason));
        Assert.Null(builtSeason.Status);
        Assert.Equal(new TagEpisodeIndex { Season = 2, Episode = 2, IsLast = true }, builtSeason.LatestEpisodeIndex);
        Assert.Equal(new TagSeasonPremiere { Season = 2, Aired = Ms(new DateTime(2026, 10, 1)) }, builtSeason.SeasonPremiere);
        Assert.Equal(new TagAddedSpan { First = Ms(new DateTime(2026, 10, 2, 10, 0, 0)), Last = Ms(new DateTime(2026, 10, 2, 11, 0, 0)), Count = 2 }, builtSeason.SeasonAddedSpan);

        // A Specials season counts its own episodes.
        Assert.True(cache.TryGetEntry(specials.Id, out var builtSpecials));
        Assert.Equal(new TagEpisodeIndex { Season = 0, Episode = 1, IsLast = true }, builtSpecials.LatestEpisodeIndex);

        Assert.True(cache.TryGetEntry(s2e2.Id, out var builtEpisode));
        Assert.Equal(Ms(new DateTime(2026, 10, 8)), builtEpisode.PremiereDate);
        Assert.Equal(2, builtEpisode.SeasonNumber);
        Assert.Equal(2, builtEpisode.EpisodeNumber);
        Assert.Null(builtEpisode.LatestEpisodeIndex);
        Assert.Equal(new TagEpisodeIndex { Season = 2, Episode = 2, IsLast = true }, builtEpisode.EpisodeIndex);

        // The incremental path (one container rebuilt on its own) builds the same facts.
        foreach (var container in new BaseItem[] { series, season1, season2, specials })
        {
            var expected = cache.BuildEntryOnDemand(container);
            Assert.True(cache.TryGetEntry(container.Id, out var actual));
            Assert.True(SameFacts(expected!, actual), container.Name);
        }
    }

    [Fact]
    public void MissingEpisodeOneAndFutureEpisodesCannotSupplyAnAiredPremiere()
    {
        var facts = new StatusTagsEpisodeFacts(false, null);
        facts.Note(Guid.NewGuid(), DateTime.UtcNow, DateTime.UtcNow.AddDays(-1), 2, 2);
        facts.Note(Guid.NewGuid(), DateTime.UtcNow, DateTime.UtcNow.AddDays(1), 3, 1);
        Assert.Null(facts.SeasonPremiere);
        Assert.Equal(2, facts.LatestIndex!.Episode);
        Assert.Equal(2, facts.LatestIndex.Season);
    }

    [Fact]
    public void EveryEpisodeContributesToTheSeasonSpanAndItsAccessSources()
    {
        var facts = new StatusTagsEpisodeFacts(true, 2);
        var ids = Enumerable.Range(1, 3).Select(_ => Guid.NewGuid()).ToArray();
        for (var i = 0; i < ids.Length; i++) facts.Note(ids[i], new DateTime(2026, 10, 20 + i), new DateTime(2026, 1, 1 + i), 2, i + 1);
        Assert.Equal(3, facts.AddedSpan!.Count);
        Assert.Equal(ids.Select(id => id.ToString("N")).Order(StringComparer.Ordinal), facts.SourceIds);
        facts.Note(Guid.NewGuid(), default, null, 2, 4);
        Assert.Null(facts.AddedSpan); // A missing date cannot establish that all were recently added.
        Assert.False(facts.LatestIndex!.IsLast);
    }

    private static bool SameFacts(TagCacheEntry a, TagCacheEntry b) =>
        a.Status == b.Status && a.LatestEpisodeAired == b.LatestEpisodeAired && a.LatestEpisodeIndex == b.LatestEpisodeIndex
        && a.SeasonPremiere == b.SeasonPremiere && a.SeasonAddedSpan == b.SeasonAddedSpan
        && (a.StatusEpisodeIds ?? []).SequenceEqual(b.StatusEpisodeIds ?? []);

    [Fact]
    public void FactsSurviveTheDiskSnapshotAndCountInContentEqualsAndClone()
    {
        var entry = new TagCacheEntry
        {
            Type = "Season", Status = "Continuing", NextEpisodePremiere = 20, LatestEpisodeAired = 10, LatestEpisodeIndex = new() { Season = 1, Episode = 2 },
            SeasonPremiere = new() { Season = 1, Aired = 5 }, SeasonAddedSpan = new() { First = 1, Last = 2, Count = 3 }, StatusEpisodeIds = ["a", "b"],
        };
        var roundTripped = JsonSerializer.Deserialize<TagCacheEntry>(JsonSerializer.Serialize(entry))!;
        Assert.True(TagCacheEntry.ContentEquals(entry, roundTripped));
        Assert.True(TagCacheEntry.ContentEquals(entry, entry.Clone()));
        foreach (var change in new Action<TagCacheEntry>[]
        {
            e => e.EpisodeIndex = new() { Season = 1, Episode = 2, IsLast = true },
            e => e.Status = "Ended",
            e => e.NextEpisodePremiere = 21,
            e => e.LatestEpisodeAired = 11,
            e => e.LatestEpisodeIndex = new() { Season = 1, Episode = 3 },
            e => e.SeasonPremiere = new() { Season = 2, Aired = 5 },
            e => e.SeasonAddedSpan = new() { First = 1, Last = 2, Count = 4 },
            e => e.StatusEpisodeIds = ["a"],
        })
        {
            var copy = entry.Clone();
            change(copy);
            Assert.False(TagCacheEntry.ContentEquals(entry, copy));
        }
    }

    [Fact]
    public void FactsAreDroppedTogetherForUsersWhoCannotSeeAnEpisodeTheyCameFrom()
    {
        using var f = new ApiPluginFixture();
        f.Plugin.Configuration.TagCacheServerMode = true;
        var alice = new User("alice", "default", "default") { Id = Guid.NewGuid() };
        var bob = new User("bob", "default", "default") { Id = Guid.NewGuid() };
        var (season, premiere, newest) = (Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid());
        var (seasonKey, premiereKey, newestKey) = (season.ToString("N"), premiere.ToString("N"), newest.ToString("N"));
        var library = new Mock<ILibraryManager>();
        // Bob can see the season and its newest episode, but not its first one.
        library.Setup(x => x.GetItemIds(It.IsAny<InternalItemsQuery>())).Returns((InternalItemsQuery query) =>
            query.User == alice ? new[] { season, premiere, newest } : new[] { season, newest });
        Directory.CreateDirectory(f.Core.ConfigRoot);
        File.WriteAllText(Path.Combine(f.Core.ConfigRoot, "tag-cache.json"), JsonSerializer.Serialize(new
        {
            SchemaVersion = TagCacheService.CurrentCacheSchemaVersion, Version = 7, LastModified = 200, LastReconciledUtcTicks = new DateTime(2026, 1, 1).Ticks,
            Items = new Dictionary<string, TagCacheEntry>
            {
                [seasonKey] = new()
                {
                    Type = "Season", DateCreated = 100, LatestEpisodeAdded = 500, LatestEpisodeId = newestKey, LastUpdated = 100,
                    LatestEpisodeAired = 400, LatestEpisodeIndex = new() { Season = 2, Episode = 2 }, SeasonPremiere = new() { Season = 2, Aired = 300 },
                    SeasonAddedSpan = new() { First = 450, Last = 500, Count = 2 }, StatusEpisodeIds = [premiereKey, newestKey],
                },
                [premiereKey] = new() { Type = "Episode", DateCreated = 450, LastUpdated = 100 },
                [newestKey] = new() { Type = "Episode", DateCreated = 500, LastUpdated = 100 },
            },
        }));
        using var cache = new TagCacheService(library.Object, f.Core.Paths.Object, Mock.Of<ILocalizationManager>(), f.Core.Logger, new MatroskaLanguageCache(f.Core.Paths.Object, f.Core.Logger));
        cache.LoadFromDisk();

        var aliceEntry = cache.GetCacheForUser(alice, out _, out _)[seasonKey];
        Assert.Equal(400, aliceEntry.LatestEpisodeAired);
        Assert.Equal(new TagAddedSpan { First = 450, Last = 500, Count = 2 }, aliceEntry.SeasonAddedSpan);

        var bobItems = cache.GetCacheForUser(bob, out _, out _, out var bobRevision);
        var bobEntry = bobItems[seasonKey];
        Assert.Null(bobEntry.LatestEpisodeAired);
        Assert.Null(bobEntry.LatestEpisodeIndex);
        Assert.Null(bobEntry.SeasonPremiere);
        Assert.Null(bobEntry.SeasonAddedSpan);
        Assert.Null(bobEntry.StatusEpisodeIds);
        Assert.Equal(500, bobEntry.LatestEpisodeAdded); // its own episode is visible: kept
        Assert.NotEqual("all", bobRevision); // the hidden episode is part of the filter revision
        Assert.Null(cache.GetCacheForUser(bob, out _, out _, since: 50)[seasonKey].SeasonPremiere); // a delta filters the same way

        Assert.True(cache.TryGetEntry(season, out var shared)); // the shared entry is untouched
        Assert.Equal(new TagSeasonPremiere { Season = 2, Aired = 300 }, shared.SeasonPremiere);
    }

    /// <summary>The /tag-data facts as the full walk over every episode computed them (the reference).</summary>
    private static (long? LatestAdded, StatusTagsEpisodeFacts Facts) FullWalk(BaseItem container, IEnumerable<Episode> episodes, DateTime now)
    {
        var season = container as Season;
        var facts = new StatusTagsEpisodeFacts(season != null, season?.IndexNumber, now);
        DateTime? latest = null;
        foreach (var ep in episodes.Where(e => e.SeasonId == container.Id || e.SeriesId == container.Id))
        {
            facts.Note(ep.Id, ep.DateCreated, ep.PremiereDate, ep.ParentIndexNumber, ep.IndexNumber);
            if (ep.DateCreated != default && (latest == null || ep.DateCreated > latest)) latest = ep.DateCreated;
        }

        return (TagCacheService.ToUnixMilliseconds(latest), facts);
    }

    private static string Facts((long? LatestAdded, StatusTagsEpisodeFacts Facts) f) => JsonSerializer.Serialize(new
    {
        f.LatestAdded, f.Facts.LatestAired, f.Facts.LatestIndex, f.Facts.SeasonPremiere, f.Facts.AddedSpan,
    });

    private static Func<InternalItemsQuery> EpisodesOf(BaseItem container) => () => new InternalItemsQuery
    {
        ParentId = container.Id, IncludeItemTypes = [BaseItemKind.Episode], Recursive = true, IsVirtualItem = false,
    };

    /// <summary>A long-running series with specials, unnumbered and undated episodes, ties and future episodes.</summary>
    private static (Series Series, Season[] Seasons, Episode[] Episodes) MessySeries(int seed, int seasons, int perSeason)
    {
        var random = new Random(seed);
        var series = new Series { Id = Guid.NewGuid(), Name = "Long runner" };
        var seasonItems = Enumerable.Range(0, seasons + 1).Select(n => new Season { Id = Guid.NewGuid(), IndexNumber = n, SeriesId = series.Id }).ToArray();
        var start = new DateTime(2000, 1, 1, 0, 0, 0, DateTimeKind.Utc);
        var episodes = new List<Episode>();
        foreach (var season in seasonItems)
        {
            var count = season.IndexNumber == 0 ? 5 : perSeason;
            for (var e = 1; e <= count; e++)
            {
                var aired = start.AddDays((season.IndexNumber!.Value == 0 ? random.Next(0, 9500) : season.IndexNumber.Value * 365) + e * 7);
                episodes.Add(new Episode
                {
                    Id = Guid.NewGuid(), Name = $"S{season.IndexNumber}E{e}", SeasonId = season.Id, SeriesId = series.Id,
                    ParentIndexNumber = random.Next(40) == 0 ? null : season.IndexNumber,
                    IndexNumber = random.Next(50) == 0 ? null : e,
                    PremiereDate = random.Next(30) == 0 ? null : random.Next(40) == 0 ? default(DateTime) : aired,
                    DateCreated = random.Next(60) == 0 ? default : aired.AddDays(random.Next(0, 3)),
                });
            }
        }

        // Ties on the newest air date, and a few episodes not aired yet.
        var newest = episodes.Where(e => e.ParentIndexNumber > 0 && e.PremiereDate > start).MaxBy(e => e.PremiereDate)!;
        episodes.Add(new Episode { Id = Guid.NewGuid(), SeasonId = newest.SeasonId, SeriesId = series.Id, ParentIndexNumber = newest.ParentIndexNumber, IndexNumber = (newest.IndexNumber ?? 0) + 1, PremiereDate = newest.PremiereDate, DateCreated = newest.DateCreated });
        episodes.Add(new Episode { Id = Guid.NewGuid(), SeasonId = seasonItems[^1].Id, SeriesId = series.Id, ParentIndexNumber = seasons, IndexNumber = perSeason + 1, PremiereDate = new DateTime(2099, 1, 1), DateCreated = new DateTime(2026, 1, 1) });
        return (series, seasonItems, episodes.ToArray());
    }

    [Theory]
    [InlineData(1)]
    [InlineData(2)]
    [InlineData(3)]
    [InlineData(4)]
    [InlineData(5)]
    [InlineData(6)]
    public void BoundedTagDataFactsMatchTheFullWalkWithoutReadingEveryEpisode(int seed)
    {
        var now = new DateTime(2026, 11, 3, 0, 0, 0, DateTimeKind.Utc);
        var (series, seasons, episodes) = MessySeries(seed, seasons: 12, perSeason: 30);
        var fake = new EpisodeQueryFake(episodes);
        var library = new Mock<ILibraryManager>();
        library.Setup(l => l.GetItemList(It.IsAny<InternalItemsQuery>())).Returns((InternalItemsQuery q) => fake.List(q));
        library.Setup(l => l.GetItemIds(It.IsAny<InternalItemsQuery>())).Returns((InternalItemsQuery q) => fake.Ids(q));
        foreach (var container in seasons.Cast<BaseItem>().Prepend(series))
        {
            var before = fake.Materialised;
            Assert.Equal(Facts(FullWalk(container, episodes, now)), Facts(StatusTagsEpisodeLookup.Load(library.Object, container, EpisodesOf(container), now)));
            Assert.InRange(fake.Materialised - before, 1, 40);
        }
    }
}
