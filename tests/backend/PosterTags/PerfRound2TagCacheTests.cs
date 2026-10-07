using System.Text.Json;
using Jellyfin.Data.Enums;
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

[Collection("Plugin singleton")]
public class PerfRound2TagCacheTests
{
    private sealed class Episode : MediaBrowser.Controller.Entities.TV.Episode
    {
        public List<MediaSourceInfo> Sources { get; init; } = [];
        public override List<MediaSourceInfo> GetMediaSources(bool enablePathSubstitution) => Sources;
    }

    [Theory]
    [InlineData(false, false)]
    [InlineData(true, false)]
    [InlineData(false, true)]
    [InlineData(true, true)]
    public void FullBuildAndOnDemandAgreeOnRegularRepresentativeAndLanguageUnion(bool directSeriesParent, bool unprobedFirst)
    {
        using var f = new ApiPluginFixture();
        f.Plugin.Configuration.TagCacheServerMode = true;
        var series = new Series { Id = Guid.NewGuid(), Name = "Series", OfficialRating = "TV-14" };
        var season = new Season { Id = Guid.NewGuid(), ParentId = series.Id, SeriesId = series.Id, IndexNumber = 1, Name = "Season" };
        var specialSeason = new Season { Id = Guid.NewGuid(), ParentId = series.Id, SeriesId = series.Id, IndexNumber = 0, Name = "Specials" };
        Episode Make(int n, int seasonNumber, string lang, bool usable = true) => new()
        {
            Id = Guid.NewGuid(), Name = "Episode " + n, IndexNumber = n, ParentIndexNumber = seasonNumber,
            PremiereDate = new DateTime(2025, 1, n), SeriesId = series.Id,
            ParentId = directSeriesParent ? series.Id : seasonNumber == 0 ? specialSeason.Id : season.Id,
            SeasonId = seasonNumber == 0 ? specialSeason.Id : season.Id,
            Genres = [seasonNumber == 0 ? "Special genre" : "Drama"],
            Sources = usable ? [new() { MediaStreams = [new() { Type = MediaStreamType.Audio, Language = lang }, new() { Type = MediaStreamType.Video, Height = seasonNumber == 0 ? 720 : 1080 }] }] : []
        };
        var episodes = new List<Episode> { Make(1, 0, "fra"), Make(2, 1, "eng", !unprobedFirst), Make(3, 1, "deu") };
        var all = new BaseItem[] { series, season, specialSeason }.Concat(episodes).ToArray();
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
        using var cache = new TagCacheService(library.Object, f.Core.Paths.Object, Mock.Of<ILocalizationManager>(), f.Core.Logger);
        cache.BuildFullCache(null, CancellationToken.None);
        Assert.Equal(all.Length, cache.Count);
        foreach (var container in new BaseItem[] { series, season, specialSeason })
        {
            var expected = cache.BuildEntryOnDemand(container);
            Assert.NotNull(expected);
            Assert.True(cache.TryGetEntry(container.Id, out var actual));
            Assert.Equal(expected.AudioLanguages, actual.AudioLanguages);
            Assert.Equal(expected.PartialAudioLanguages, actual.PartialAudioLanguages);
            Assert.Equal(expected.Genres, actual.Genres);
            Assert.Equal(expected.StreamData?.ItemName, actual.StreamData?.ItemName);
            Assert.Equal(expected.StreamData?.Streams?.Select(s => s.Height), actual.StreamData?.Streams?.Select(s => s.Height));
        }
        Assert.True(cache.TryGetEntry(series.Id, out var builtSeries));
        Assert.Equal(unprobedFirst ? "Episode 3" : "Episode 2", builtSeries.StreamData?.ItemName);
        Assert.Equal(unprobedFirst ? new[] { "fra", "deu" } : new[] { "fra", "eng", "deu" }, builtSeries.AudioLanguages);
        Assert.Equal(new[] { "Drama" }, builtSeries.Genres);
    }

    [Fact]
    public void QueuedRebuildOfAnUnchangedItemDoesNotTouchTheCache()
    {
        // Library scans raise ItemUpdated for items whose tag data did not change; the
        // rebuild must keep the stored entry (and its LastUpdated, which deltas key on)
        // instead of reporting a change that re-saves the whole cache.
        using var f = new ApiPluginFixture();
        f.Plugin.Configuration.TagCacheServerMode = true;
        var episode = new Episode
        {
            Id = Guid.NewGuid(), Name = "Episode", IndexNumber = 1, ParentIndexNumber = 1, SeriesId = Guid.NewGuid(), Genres = ["Drama"], CommunityRating = 8,
            Sources = [new() { MediaStreams = [new() { Type = MediaStreamType.Audio, Language = "eng" }, new() { Type = MediaStreamType.Video, Height = 1080 }] }]
        };
        var library = new Mock<ILibraryManager>();
        library.Setup(l => l.GetItemById<BaseItem>(episode.Id)).Returns(episode);
        var snapshot = Path.Combine(f.Core.ConfigRoot, "tag-cache.json");
        Directory.CreateDirectory(f.Core.ConfigRoot);
        File.WriteAllText(snapshot, JsonSerializer.Serialize(new { SchemaVersion = 7, Version = 7, LastModified = 200, LastReconciledUtcTicks = new DateTime(2026, 1, 1).Ticks, Items = new Dictionary<string, TagCacheEntry>() }));

        // Shutdown applies the queued update synchronously: the first rebuild adds the entry...
        using (var cache = new TagCacheService(library.Object, f.Core.Paths.Object, Mock.Of<ILocalizationManager>(), f.Core.Logger))
        {
            cache.LoadFromDisk();
            cache.EnqueueUpdate(episode.Id);
        }
        var afterFirst = File.ReadAllText(snapshot);
        using (var restarted = new TagCacheService(library.Object, f.Core.Paths.Object, Mock.Of<ILocalizationManager>(), f.Core.Logger))
        {
            restarted.LoadFromDisk();
            Assert.True(restarted.TryGetEntry(episode.Id, out var added));
            Assert.Equal(["Drama"], added.Genres!);
            Assert.True(restarted.LastModified > 200);
            // ...and the second, with nothing changed, mutates nothing.
            var (version, modified) = (restarted.Version, restarted.LastModified);
            restarted.EnqueueUpdate(episode.Id);
            restarted.Dispose();
            Assert.Equal((version, modified), (restarted.Version, restarted.LastModified));
            Assert.True(restarted.TryGetEntry(episode.Id, out var kept));
            Assert.Same(added, kept);
        }
        Assert.Equal(afterFirst, File.ReadAllText(snapshot));
    }
}
