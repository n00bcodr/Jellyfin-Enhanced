using System.Text.Json;
using Jellyfin.Data.Enums;
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
/// SubtitleLanguages in the server tag cache (schema v14): one entry per
/// language for a movie or episode, and for a Series/Season the union over
/// its episodes, the same from the full build's memo as from an on-demand build.
/// </summary>
[Collection("Plugin singleton")]
public class TagCacheSubtitleLanguagesTests
{
    // Jellyfin derives an item's kind from its class name, so the doubles keep it.
    internal sealed class Episode : MediaBrowser.Controller.Entities.TV.Episode
    {
        public List<MediaSourceInfo> Sources { get; init; } = [];
        public override List<MediaSourceInfo> GetMediaSources(bool enablePathSubstitution) => Sources;
    }

    /// <summary>A movie with fixed media sources (also used by the tag-data response tests).</summary>
    internal sealed class Movie : MediaBrowser.Controller.Entities.Movies.Movie
    {
        public List<MediaSourceInfo> Sources { get; init; } = [];
        public override List<MediaSourceInfo> GetMediaSources(bool enablePathSubstitution) => Sources;
    }

    private static MediaStream Sub(string? language, bool forced = false, bool hearingImpaired = false, bool external = false) =>
        new() { Type = MediaStreamType.Subtitle, Language = language, IsForced = forced, IsHearingImpaired = hearingImpaired, IsExternal = external };

    private static Mock<ILibraryManager> Library(BaseItem[] all, Guid seriesId)
    {
        var library = new Mock<ILibraryManager>();
        IEnumerable<BaseItem> Select(InternalItemsQuery q)
        {
            IEnumerable<BaseItem> selected = all;
            if (q.ItemIds?.Length > 0) selected = selected.Where(i => q.ItemIds.Contains(i.Id));
            else if (q.IncludeItemTypes?.Length > 0) selected = selected.Where(i => q.IncludeItemTypes.Contains(i.GetBaseItemKind()));
            if (q.ParentId != Guid.Empty) selected = selected.OfType<Episode>().Where(e => q.ParentId == seriesId || e.SeasonId == q.ParentId);
            return selected.Skip(q.StartIndex ?? 0).Take(q.Limit ?? int.MaxValue);
        }
        library.Setup(l => l.GetItemIds(It.IsAny<InternalItemsQuery>())).Returns((InternalItemsQuery q) => Select(q).Select(i => i.Id).ToArray());
        library.Setup(l => l.GetItemList(It.IsAny<InternalItemsQuery>())).Returns((InternalItemsQuery q) => Select(q).ToArray());
        library.Setup(l => l.GetItemById(It.IsAny<Guid>())).Returns((Guid id) => all.SingleOrDefault(i => i.Id == id));
        library.Setup(l => l.GetItemById<BaseItem>(It.IsAny<Guid>())).Returns((Guid id) => all.SingleOrDefault(i => i.Id == id));
        return library;
    }

    [Fact]
    public void ForcedAndSdhTracksCountOnceAndContainersTakeTheEpisodeUnion()
    {
        using var f = new ApiPluginFixture();
        f.Plugin.Configuration.TagCacheServerMode = true;
        var series = new Series { Id = Guid.NewGuid(), Name = "Series" };
        var season = new Season { Id = Guid.NewGuid(), ParentId = series.Id, SeriesId = series.Id, IndexNumber = 1, Name = "Season" };
        Episode Make(int n, params MediaStream[] subtitles) => new()
        {
            Id = Guid.NewGuid(), Name = "Episode " + n, IndexNumber = n, ParentIndexNumber = 1, PremiereDate = new DateTime(2025, 1, n),
            SeriesId = series.Id, ParentId = season.Id, SeasonId = season.Id, Genres = ["Drama"],
            Sources = [new() { MediaStreams = [new() { Type = MediaStreamType.Audio, Language = "jpn" }, new() { Type = MediaStreamType.Video, Height = 1080 }, .. subtitles] }],
        };
        var episodes = new[]
        {
            Make(1, Sub("eng", forced: true), Sub("eng", hearingImpaired: true), Sub("ENG"), Sub("und"), Sub(null)),
            Make(2, Sub("fre", external: true), Sub("eng")),
            // No audio/video streams: not a tag source, so its subtitles add nothing.
            new Episode
            {
                Id = Guid.NewGuid(), Name = "Stub", IndexNumber = 3, ParentIndexNumber = 1, SeriesId = series.Id, ParentId = season.Id, SeasonId = season.Id,
                Sources = [new() { MediaStreams = [Sub("ger")] }],
            },
        };
        var all = new BaseItem[] { series, season }.Concat(episodes).ToArray();
        var library = Library(all, series.Id);
        using var cache = new TagCacheService(library.Object, f.Core.Paths.Object, Mock.Of<ILocalizationManager>(), f.Core.Logger, new MatroskaLanguageCache(f.Core.Paths.Object, f.Core.Logger));
        cache.BuildFullCache(null, CancellationToken.None);

        Assert.True(cache.TryGetEntry(episodes[0].Id, out var first));
        Assert.Equal(new[] { "eng" }, first.SubtitleLanguages);
        Assert.Equal(new[] { "jpn" }, first.AudioLanguages);
        // Accessibility metadata is retained without duplicating language chips.
        Assert.Contains(first.StreamData!.Streams!, s => s.Type == "Subtitle" && s.IsHearingImpaired == true);
        Assert.Equal(new[] { "eng" }, first.SdhSubtitleLanguages);
        Assert.True(cache.TryGetEntry(episodes[1].Id, out var second));
        Assert.Equal(new[] { "fre", "eng" }, second.SubtitleLanguages);

        foreach (var container in new BaseItem[] { series, season })
        {
            Assert.True(cache.TryGetEntry(container.Id, out var built));
            Assert.Equal(new[] { "eng", "fre" }, built.SubtitleLanguages);
            // The full build's memo and an on-demand build (which reads every episode itself) agree.
            Assert.Equal(built.SubtitleLanguages, cache.BuildEntryOnDemand(container)!.SubtitleLanguages);
            Assert.Equal(new[] { "eng" }, built.SdhSubtitleLanguages);
            Assert.Equal(built.SdhSubtitleLanguages, cache.BuildEntryOnDemand(container)!.SdhSubtitleLanguages);
        }
    }

    [Fact]
    public void ForcedOnlySubtitlesAndCommentaryOrDescriptionAudioAreNotLanguageOptions()
    {
        using var f = new ApiPluginFixture();
        f.Plugin.Configuration.TagCacheServerMode = true;
        var series = new Series { Id = Guid.NewGuid(), Name = "Series" };
        var season = new Season { Id = Guid.NewGuid(), ParentId = series.Id, SeriesId = series.Id, IndexNumber = 1, Name = "Season" };
        MediaStream Audio(string language, string? title = null) => new() { Type = MediaStreamType.Audio, Language = language, Title = title };
        Episode Make(int n, params MediaStream[] streams) => new()
        {
            Id = Guid.NewGuid(), Name = "Episode " + n, IndexNumber = n, ParentIndexNumber = 1, PremiereDate = new DateTime(2025, 1, n),
            SeriesId = series.Id, ParentId = season.Id, SeasonId = season.Id,
            Sources = [new() { MediaStreams = [new() { Type = MediaStreamType.Video, Height = 1080 }, .. streams] }],
        };
        var episodes = new[]
        {
            // Japanese film: an English commentary is not an English dub; English forced signs are not English subtitles.
            Make(1, Audio("jpn"), Audio("eng", "Commentary by the director"), Sub("eng", forced: true), Sub("fre")),
            // Audio description (AD) is not a dub either; a full English track next to forced English still counts.
            Make(2, Audio("jpn"), Audio("deu", "Deutsch AD"), Audio("spa", "Audio Description"), Sub("eng", forced: true), Sub("eng")),
            // An "Ad" in a title is not the AD abbreviation.
            Make(3, Audio("jpn"), Audio("ita", "Ad-free mix")),
        };
        var all = new BaseItem[] { series, season }.Concat(episodes).ToArray();
        var library = Library(all, series.Id);
        using var cache = new TagCacheService(library.Object, f.Core.Paths.Object, Mock.Of<ILocalizationManager>(), f.Core.Logger, new MatroskaLanguageCache(f.Core.Paths.Object, f.Core.Logger));
        cache.BuildFullCache(null, CancellationToken.None);

        Assert.True(cache.TryGetEntry(episodes[0].Id, out var first));
        Assert.Equal(new[] { "jpn" }, first.AudioLanguages);
        Assert.Equal(new[] { "fre" }, first.SubtitleLanguages);
        Assert.True(cache.TryGetEntry(episodes[1].Id, out var second));
        Assert.Equal(new[] { "jpn" }, second.AudioLanguages);
        Assert.Equal(new[] { "eng" }, second.SubtitleLanguages);
        Assert.True(cache.TryGetEntry(episodes[2].Id, out var third));
        Assert.Equal(new[] { "jpn", "ita" }, third.AudioLanguages);
        foreach (var container in new BaseItem[] { series, season })
        {
            Assert.True(cache.TryGetEntry(container.Id, out var built));
            Assert.Equal(new[] { "ita", "jpn" }, built.AudioLanguages!.Order(StringComparer.Ordinal));
            Assert.Equal(new[] { "eng", "fre" }, built.SubtitleLanguages!.Order(StringComparer.Ordinal));
            Assert.Equal(built.AudioLanguages, cache.BuildEntryOnDemand(container)!.AudioLanguages);
        }
    }

    [Theory]
    [InlineData("nb", "no")]
    [InlineData("nob", "no")]
    [InlineData("nn", "no")]
    [InlineData("nno", "no")]
    [InlineData("yue", "hk")]
    [InlineData("gsw", "ch")]
    [InlineData("ga", "ie")]
    [InlineData("gle", "ie")]
    public void NorwegianCantoneseSwissGermanAndIrishHaveFlags(string code, string flag)
        => Assert.Equal(flag, Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags.Resolution.LanguageFlagRules.ResolveFlag(code, string.Empty));

    [Theory]
    [InlineData("Commentary by director", null, true)]
    [InlineData(null, "English - Director's Commentary - AC3 - Stereo", true)]
    [InlineData("English (AD)", null, true)]
    [InlineData("Descriptive Audio", null, true)]
    [InlineData("Audio Description", null, true)]
    [InlineData("Described Video", null, true)]
    [InlineData("Ad-free", null, false)]
    [InlineData("Headphones mix", null, false)]
    [InlineData(null, "English - Dolby Digital - 5.1 - Default", false)]
    public void SecondaryAudioRolesComeFromTheTrackTitle(string? title, string? displayTitle, bool secondary)
        => Assert.Equal(secondary, TrackRoles.IsSecondaryAudio(title, displayTitle));

    /// <summary>The shared title table (tests/fixtures/track-roles.json, also run against mediaLanguage.isSecondaryAudio).</summary>
    [Fact]
    public void SecondaryAudioRolesMatchTheSharedTitleTable()
    {
        using var stream = typeof(TagCacheSubtitleLanguagesTests).Assembly.GetManifestResourceStream("TrackRoles.json")!;
        using var document = JsonDocument.Parse(stream);
        foreach (var row in document.RootElement.GetProperty("cases").EnumerateArray())
        {
            var title = row.GetProperty("title").GetString();
            var displayTitle = row.GetProperty("displayTitle").GetString();
            Assert.True(row.GetProperty("secondary").GetBoolean() == TrackRoles.IsSecondaryAudio(title, displayTitle), title ?? displayTitle);
        }
    }

    [Fact]
    public void SubtitleLanguagesTakePartInContentEqualityAndClones()
    {
        var a = new TagCacheEntry { Type = "Movie", SubtitleLanguages = ["eng"] };
        var b = a.Clone();
        Assert.Equal(a.SubtitleLanguages, b.SubtitleLanguages);
        Assert.True(TagCacheEntry.ContentEquals(a, b));
        b.SubtitleLanguages = ["eng", "fre"];
        Assert.False(TagCacheEntry.ContentEquals(a, b));
    }

    [Fact]
    public void OlderSnapshotsAreDiscardedAndTheCurrentSchemaIsKept()
    {
        using var f = new ApiPluginFixture();
        f.Plugin.Configuration.TagCacheServerMode = true;
        Directory.CreateDirectory(f.Core.ConfigRoot);
        var items = new Dictionary<string, TagCacheEntry> { [Guid.NewGuid().ToString("N")] = new() { Type = "Movie", SubtitleLanguages = ["eng"], LastUpdated = 100 } };
        var path = Path.Combine(f.Core.ConfigRoot, "tag-cache.json");
        var library = new Mock<ILibraryManager>();
        TagCacheService Create() => new(library.Object, f.Core.Paths.Object, Mock.Of<ILocalizationManager>(), f.Core.Logger, new MatroskaLanguageCache(f.Core.Paths.Object, f.Core.Logger));

        // A v16 cache has no Custom tag matches (and a v15 one no subtitle languages): it must rebuild.
        File.WriteAllText(path, JsonSerializer.Serialize(new { SchemaVersion = 16, Version = 7, LastModified = 200, Items = items }));
        using (var old = Create())
        {
            old.LoadFromDisk();
            Assert.Equal(0, old.Count);
        }

        File.WriteAllText(path, JsonSerializer.Serialize(new { SchemaVersion = TagCacheService.CurrentCacheSchemaVersion, Version = 7, LastModified = 200, Items = items }));
        using var current = Create();
        current.LoadFromDisk();
        Assert.Equal(1, current.Count);
        Assert.True(current.TryGetEntry(Guid.Parse(items.Keys.Single()), out var loaded));
        Assert.Equal(new[] { "eng" }, loaded.SubtitleLanguages);
    }

    [Fact]
    public void NormalizeStreamLanguageDropsUntaggedTracks()
    {
        Assert.Equal("pt-br", TagCacheService.NormalizeStreamLanguage("pt-BR"));
        Assert.Null(TagCacheService.NormalizeStreamLanguage("und"));
        Assert.Null(TagCacheService.NormalizeStreamLanguage("ROOT"));
        Assert.Null(TagCacheService.NormalizeStreamLanguage(""));
        Assert.Null(TagCacheService.NormalizeStreamLanguage(null));
    }
}
