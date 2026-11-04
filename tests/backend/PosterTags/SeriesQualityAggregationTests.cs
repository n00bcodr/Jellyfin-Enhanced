using System.Reflection;
using System.Text.Json;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using Jellyfin.Plugin.JellyfinEnhanced.Model;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags;
using Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags.Resolution;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.Globalization;
using Moq;

namespace JE.Tests;

[Collection("Plugin singleton")]
public class SeriesQualityAggregationTests
{
    private static TagStreamData Streams(int height, string codec = "h264", string range = "SDR", string audio = "DTS 5.1") => new()
    {
        Streams = [new() { Type = "Video", Height = height, Codec = codec, VideoRangeType = range },
            new() { Type = "Audio", Language = "eng", DisplayTitle = audio, Channels = audio.EndsWith("7.1", StringComparison.Ordinal) ? 8 : 6 }],
    };
    private static SeriesQualityAggregation.Episode Fact(int height, long? aired, string codec = "h264", string range = "SDR", string audio = "DTS 5.1") =>
        new(Guid.NewGuid().ToString("N"), aired, Streams(height, codec, range, audio));

    [Fact]
    public void NonAudioDetectionRetainsSourceAndFormatSignalsWhileAggregationRanksEachAudioTrack()
    {
        var streams = Streams(2160, "hevc", "Dolby Vision");
        // The video title and file names keep their format signals when audio label detection is skipped;
        // an audio title never speaks for the picture.
        streams.Streams![0].DisplayTitle = "2160p IMAX HEVC";
        streams.Streams.Add(new() { Type = "Audio", Language = "deu", DisplayTitle = "IMAX TRUEHD 7.1", Channels = 8 });
        streams.Sources = [new() { Path = "/movies/film.3d.hsbs.mkv" }];
        var nonAudio = QualityTagRules.DetectNonAudio(streams);
        Assert.Equal(QualityTagRules.Detect(streams, null).Where(label => QualityTagRules.CategoryOf(label) != QualityTagRules.AudioInfo), nonAudio);
        Assert.Contains("IMAX", nonAudio);
        Assert.Contains("3D", nonAudio);
        Assert.DoesNotContain(nonAudio, label => QualityTagRules.CategoryOf(label) == QualityTagRules.AudioInfo);
        var summary = SeriesQualityAggregation.Build([new("first", 1, streams), new("last", 2, streams)], 100);
        Assert.Contains("IMAX", summary.LatestExtras);
        Assert.Contains("3D", summary.LatestExtras);
        Assert.Equal("TRUEHD 7.1", summary.Categories["audioInfo"].Best);
        Assert.Equal("DTS 5.1", summary.AudioByLanguage["en"].Best);
        Assert.Equal("TRUEHD 7.1", summary.AudioByLanguage["de"].Best);
    }

    [Fact]
    public void BestRanksEachCategoryAndLatestUsesAirDateRatherThanAddedOrScanOrder()
    {
        var summary = SeriesQualityAggregation.Build([Fact(2160, 30, "hevc", "Dolby Vision"), Fact(1080, 50, "av1", "SDR", "ATMOS 7.1"), Fact(4320, 200), Fact(720, null)], 100);
        Assert.Equal(4, summary.EpisodeCount);
        Assert.Equal("8K", summary.Categories["resolution"].Best);
        Assert.Equal("1080p", summary.Categories["resolution"].Latest);
        Assert.Equal("Dolby Vision", summary.Categories["dynamicRange"].Best);
        Assert.Null(summary.Categories["dynamicRange"].Latest);
        Assert.Equal("AV1", summary.Categories["videoCodec"].Best);
        Assert.Equal("ATMOS 7.1", summary.Categories["audioInfo"].Best);
        Assert.Equal(200, summary.NextPremiere);
    }

    [Fact]
    public void DistinctValuesStayBoundedAndUnknownMetadataPreventsAgreement()
    {
        var episodes = new[] { 480, 576, 720, 1080, 1440, 2160, 4320 }.Select((height, i) => Fact(height, i)).ToList();
        var summary = SeriesQualityAggregation.Build(episodes, 100);
        Assert.Equal(4, summary.Categories["resolution"].Values.Length);
        Assert.Equal("8K", summary.Categories["resolution"].Best); // best is independent of the bounded set
        Assert.False(summary.Categories["resolution"].AllAgree);
        var unknown = SeriesQualityAggregation.Build([Fact(1080, 1), new("unprobed", 2, null)], 100);
        Assert.Contains((string?)null, unknown.Categories["resolution"].Values);
        Assert.False(unknown.Categories["resolution"].AllAgree);
        Assert.Null(unknown.Categories["resolution"].Latest);
        Assert.Null(SeriesQualityAggregation.Build([Fact(2160, 101)], 100).Categories["resolution"].Latest);
    }

    [Theory]
    [InlineData("representative", "1080p", false)]
    [InlineData("latest", "4K", false)]
    [InlineData("best", "4K", false)]
    [InlineData("shared", null, false)]
    [InlineData("mixed", "4K", true)]
    public void NativePoliciesAndLegacyFallback(string policy, string? resolution, bool marker)
    {
        var summary = SeriesQualityAggregation.Build([Fact(1080, 1), Fact(2160, 2)], 100);
        var entry = new TagCacheEntry { Type = "Series", StreamData = Streams(1080), QualitySummary = summary };
        var config = new PluginConfiguration { SeriesQualityAggregation = policy };
        var settings = PosterTagSettings.FromUserSettings(new JellyfinEnhancedUserSettings { QualityTagsEnabled = true }, config, null);
        var layout = PosterTagResolver.Resolve(entry, settings, new("Series", false, null, null, null), false)!;
        var labels = layout.Groups.SelectMany(group => group.Tags).OfType<QualityTag>().Select(tag => tag.Label).ToArray();
        if (resolution == null) Assert.DoesNotContain(labels, label => label is "1080p" or "4K");
        else Assert.Contains(resolution, labels);
        Assert.Equal(marker, labels.Contains("Mixed"));
        entry.QualitySummary = null;
        Assert.Contains("1080p", SeriesQualityAggregation.Resolve(entry, policy, null));
        entry.QualitySummary = summary;
        entry.Type = "BoxSet";
        Assert.Equal(["1080p", "H264", "DTS 5.1"], SeriesQualityAggregation.Resolve(entry, policy, null));
        Assert.NotEqual(settings.Digest, PosterTagSettings.FromUserSettings(new JellyfinEnhancedUserSettings { QualityTagsEnabled = true, SeriesQualityAggregation = policy == "latest" ? "best" : "latest" }, config, null).Digest);
    }

    [Fact]
    public void PoliciesRetainNamingFactsFromTheAppropriateEpisode()
    {
        var summary = SeriesQualityAggregation.Build([
            new("first", 1, Streams(1080), "WEB", "Criterion"),
            new("latest", 2, Streams(2160), "REMUX", "Extended")], 100);
        var entry = new TagCacheEntry { Type = "Series", StreamData = Streams(1080),
            Source = "WEB", Edition = "Criterion", QualitySummary = summary };
        foreach (var policy in new[] { "representative", "best", "shared", "mixed" })
        {
            var labels = SeriesQualityAggregation.Resolve(entry, policy, null);
            Assert.Contains("WEB", labels);
            Assert.Contains("edition:Criterion", labels);
        }
        var latest = SeriesQualityAggregation.Resolve(entry, "latest", null);
        Assert.Contains("REMUX", latest);
        Assert.Contains("edition:Extended", latest);
        Assert.DoesNotContain("WEB", latest);
    }

    [Fact]
    public void AgreementAudioPreferencesAndEntryValueContractsSurviveRoundTrip()
    {
        var first = Streams(1080);
        first.Streams!.Add(new() { Type = "Audio", Language = "deu", DisplayTitle = "TRUEHD 7.1", Channels = 8 });
        var summary = SeriesQualityAggregation.Build([new("a", 1, first), new("b", 2, first)], 100);
        Assert.All(summary.Categories.Values, category => Assert.True(category.AllAgree));
        Assert.Equal("TRUEHD 7.1", summary.Categories["audioInfo"].Best);
        Assert.Contains("TRUEHD 7.1", SeriesQualityAggregation.Resolve(new() { Type = "Season", QualitySummary = summary }, "shared", "de"));
        Assert.DoesNotContain("Mixed", SeriesQualityAggregation.Resolve(new() { Type = "Series", QualitySummary = summary }, "mixed", null));
        Assert.DoesNotContain("Mixed", SeriesQualityAggregation.Resolve(new() { Type = "Series", QualitySummary = SeriesQualityAggregation.Build([]) }, "mixed", null));
        var entry = new TagCacheEntry { QualitySummary = summary, QualityEpisodeIds = ["a", "b"] };
        Assert.True(TagCacheEntry.ContentEquals(entry, entry.Clone()));
        Assert.True(TagCacheEntry.ContentEquals(entry, JsonSerializer.Deserialize<TagCacheEntry>(JsonSerializer.Serialize(entry))));
        var changed = entry.Clone(); changed.QualitySummary = SeriesQualityAggregation.Build([Fact(2160, 2)]);
        Assert.False(TagCacheEntry.ContentEquals(entry, changed));
        changed = entry.Clone(); changed.QualityEpisodeIds = ["a"];
        Assert.False(TagCacheEntry.ContentEquals(entry, changed));
        Assert.True(TagStyleCatalog.IsLabel("quality", "Mixed"));
    }

    [Fact]
    public void PreviousSchemaIsDiscardedAndCurrentSchemaRestoresSummaries()
    {
        using var f = new ApiPluginFixture(); f.Plugin.Configuration.TagCacheServerMode = true;
        Directory.CreateDirectory(f.Core.ConfigRoot);
        var path = Path.Combine(f.Core.ConfigRoot, "tag-cache.json");
        var items = new Dictionary<string, TagCacheEntry> { [Guid.NewGuid().ToString("N")] = new() { Type = "Series", QualitySummary = SeriesQualityAggregation.Build([Fact(2160, 1)]) } };
        foreach (var schema in new[] { 9, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, TagCacheService.CurrentCacheSchemaVersion })
        {
            File.WriteAllText(path, JsonSerializer.Serialize(new { SchemaVersion = schema, Version = 1, LastModified = 10, Items = items }));
            using var cache = new TagCacheService(Mock.Of<ILibraryManager>(), f.Core.Paths.Object, Mock.Of<ILocalizationManager>(), f.Core.Logger, new MatroskaLanguageCache(f.Core.Paths.Object, f.Core.Logger));
            cache.LoadFromDisk();
            Assert.Equal(schema == TagCacheService.CurrentCacheSchemaVersion ? 1 : 0, cache.Count);
        }
    }

    [Fact]
    public void MissingAudioRegionPrefersGenericTracksBeforeOtherRegions()
    {
        var data = Streams(1080);
        data.Streams!.Add(new() { Type = "Audio", Language = "en-US", DisplayTitle = "ATMOS 7.1", Channels = 8 });
        var summary = SeriesQualityAggregation.Build([new("one", 1, data)], 100);
        var entry = new TagCacheEntry { Type = "Series", QualitySummary = summary };
        Assert.Contains("DTS 5.1", SeriesQualityAggregation.Resolve(entry, "best", "en-GB"));
        Assert.Contains("ATMOS 7.1", SeriesQualityAggregation.Resolve(entry, "best", "en-US"));
        Assert.Contains("ATMOS 7.1", SeriesQualityAggregation.Resolve(entry, "best", "eng"));
    }

    [Fact]
    public void NoPolicyGivesASeriesOrSeasonTheLatestEpisodesVersionCount()
    {
        var streams = new TagStreamData
        {
            Streams = [new() { Type = "Video", SourceId = "a", Height = 1080, Codec = "h264" }, new() { Type = "Video", SourceId = "b", Height = 2160, Codec = "hevc" }],
            Sources = [new() { Id = "a" }, new() { Id = "b" }],
        };
        var summary = SeriesQualityAggregation.Build([new("two-versions", 1, streams)], 100);
        Assert.DoesNotContain(summary.LatestExtras, label => label.StartsWith("versions:", StringComparison.Ordinal));
        var json = System.Text.Json.Nodes.JsonNode.Parse(JsonSerializer.Serialize(summary))!;
        json["LatestExtras"] = new System.Text.Json.Nodes.JsonArray("versions:2"); // a summary stored by an earlier build
        var stored = json.Deserialize<TagQualitySummary>()!;
        Assert.Equal(["versions:2"], stored.LatestExtras);
        foreach (var type in new[] { "Series", "Season" })
        foreach (var policy in new[] { "representative", "latest", "best", "shared", "mixed" })
        {
            var entry = new TagCacheEntry { Type = type, StreamData = streams, QualitySummary = stored };
            Assert.DoesNotContain(SeriesQualityAggregation.Resolve(entry, policy, null), label => label.StartsWith("versions:", StringComparison.Ordinal));
        }
    }

    [Fact]
    public void AggregateVideoCategoriesIncludeEveryAlreadyLoadedMediaVersion()
    {
        var streams = Streams(720);
        streams.Streams!.Add(new() { Type = "Video", Height = 2160, Codec = "hevc", VideoRangeType = "Dolby Vision" });
        var summary = SeriesQualityAggregation.Build([new("versions", 1, streams)], 100);
        Assert.Equal("4K", summary.Categories["resolution"].Best);
        Assert.Equal("Dolby Vision", summary.Categories["dynamicRange"].Best);
        Assert.Equal("HEVC", summary.Categories["videoCodec"].Best);
    }

    [Fact]
    public void AggregatedAudioUsesTheCallerGateForEveryPolicyModeAndLanguageInBothContainers()
    {
        using var fixture = typeof(SeriesQualityAggregationTests).Assembly.GetManifestResourceStream("AudioAggregation.json")!;
        using var cases = JsonDocument.Parse(fixture);
        foreach (var row in cases.RootElement.EnumerateArray())
        {
            var episodes = row.GetProperty("episodes").EnumerateArray().Select(ep => new SeriesQualityAggregation.Episode(
                ep.GetProperty("Id").GetString()!, ep.GetProperty("Aired").GetInt64(), JsonSerializer.Deserialize<TagStreamData>(ep.GetProperty("Streams")))).ToArray();
            var summary = SeriesQualityAggregation.Build(episodes, 100);
            foreach (var expected in row.GetProperty("expected").EnumerateArray())
            foreach (var type in new[] { "Series", "Season" })
            foreach (var density in expected.GetProperty("legacy").GetBoolean() ? new string?[] { null, "full", "compact" } : new[] { "full" })
            {
                var settings = PosterTagSettings.FromUserSettings(new() { QualityTagsEnabled = true, TagLabelDensity = density ?? "full",
                    TagLayoutSettingsVersion = expected.GetProperty("legacy").GetBoolean() ? 0 : 1,
                    SeriesQualityAggregation = expected.GetProperty("policy").GetString()!,
                    QualityAudioDisplayMode = expected.GetProperty("mode").GetString(),
                    QualityTagsPreferredAudioLanguage = expected.GetProperty("preferred").GetString()! }, new(), null);
                var entry = new TagCacheEntry { Type = type, StreamData = episodes[0].Streams, QualitySummary = summary };
                var labels = PosterTagResolver.Resolve(entry, settings, new(type, false, null, null, null), false)?
                    .Groups.SelectMany(group => group.Tags).OfType<QualityTag>().Select(tag => tag.DisplayText ?? tag.Label) ?? [];
                Assert.Equal(expected.GetProperty("labels").EnumerateArray().Select(label => label.GetString()), labels);
            }
            Assert.True(TagQualitySummary.ContentEquals(summary, JsonSerializer.Deserialize<TagQualitySummary>(row.GetProperty("entry").GetProperty("QualitySummary"))), JsonSerializer.Serialize(summary));
        }
    }

    private sealed class Episode : MediaBrowser.Controller.Entities.TV.Episode
    {
        public int StreamHeight { get; set; }
        public int Reads { get; private set; }
        public override List<MediaSourceInfo> GetMediaSources(bool enablePathSubstitution)
        {
            Reads++;
            return [new() { MediaStreams = [new() { Type = MediaStreamType.Video, Height = StreamHeight, Codec = "h264" }] }];
        }
    }

    [Fact]
    public void FullIncrementalBatchAndRestrictedSummariesReuseEpisodeStreamsAndAccessRevision()
    {
        using var f = new ApiPluginFixture(); f.Plugin.Configuration.TagCacheServerMode = true;
        var series = new Series { Id = Guid.NewGuid() };
        var season = new Season { Id = Guid.NewGuid(), SeriesId = series.Id, ParentId = series.Id, IndexNumber = 1 };
        Episode Make(int n, int height) => new() { Id = Guid.NewGuid(), SeriesId = series.Id, SeasonId = season.Id, ParentId = season.Id,
            ParentIndexNumber = 1, IndexNumber = n, PremiereDate = DateTime.UtcNow.AddDays(n - 10), StreamHeight = height };
        var low = Make(1, 1080); var high = Make(2, 2160);
        low.Path = "/private/Show.WEB-DL.{edition-Criterion}.mkv";
        high.Path = "/private/Show.REMUX.{edition-Extended}.mkv";
        BaseItem[] all = [series, season, low, high];
        var user = new User("viewer", "default", "default") { Id = Guid.NewGuid() };
        var hidden = new HashSet<Guid>();
        IEnumerable<BaseItem> Select(InternalItemsQuery q)
        {
            IEnumerable<BaseItem> selected = all.Where(item => q.User == null || !hidden.Contains(item.Id));
            if (q.ItemIds?.Length > 0) selected = selected.Where(item => q.ItemIds.Contains(item.Id));
            else if (q.IncludeItemTypes?.Length > 0) selected = selected.Where(item => q.IncludeItemTypes.Contains(item.GetBaseItemKind()));
            if (q.ParentId != Guid.Empty) selected = selected.OfType<Episode>().Where(ep => q.ParentId == series.Id || ep.SeasonId == q.ParentId);
            return selected.Skip(q.StartIndex ?? 0).Take(q.Limit ?? int.MaxValue);
        }
        var library = new Mock<ILibraryManager>();
        library.Setup(l => l.GetItemIds(It.IsAny<InternalItemsQuery>())).Returns((InternalItemsQuery q) => Select(q).Select(item => item.Id).ToArray());
        library.Setup(l => l.GetItemList(It.IsAny<InternalItemsQuery>())).Returns((InternalItemsQuery q) => Select(q).ToArray());
        library.Setup(l => l.GetItemById<BaseItem>(It.IsAny<Guid>())).Returns((Guid id) => all.SingleOrDefault(item => item.Id == id));
        library.Setup(l => l.GetItemById(It.IsAny<Guid>())).Returns((Guid id) => all.SingleOrDefault(item => item.Id == id));
        using var cache = new TagCacheService(library.Object, f.Core.Paths.Object, Mock.Of<ILocalizationManager>(), f.Core.Logger, new MatroskaLanguageCache(f.Core.Paths.Object, f.Core.Logger));
        cache.BuildFullCache(null, CancellationToken.None);
        Assert.Equal(1, low.Reads); Assert.Equal(1, high.Reads);
        Assert.True(cache.TryGetEntry(series.Id, out var original));
        Assert.Equal("4K", original.QualitySummary!.Categories["resolution"].Best);
        Assert.Equal("WEB", original.Source);
        Assert.Equal("Criterion", original.Edition);
        Assert.Contains("REMUX", original.QualitySummary.LatestExtras);
        hidden.Add(low.Id); cache.InvalidateUserAccess();
        var highOnly = cache.GetCacheForUser(user, out _, out _, out _)[series.Id.ToString("N")];
        Assert.Equal("REMUX", highOnly.Source);
        Assert.Equal("Extended", highOnly.Edition);
        Assert.Equal("WEB", original.Source);
        hidden.Clear(); cache.InvalidateUserAccess();
        var full = cache.GetCacheForUser(user, out _, out _, out var allRevision);
        hidden.Add(high.Id); cache.InvalidateUserAccess();
        var restricted = cache.GetCacheForUser(user, out _, out _, out var restrictedRevision)[series.Id.ToString("N")];
        Assert.NotEqual(allRevision, restrictedRevision);
        Assert.Equal(1, restricted.QualitySummary!.EpisodeCount);
        Assert.Equal("1080p", restricted.QualitySummary.Categories["resolution"].Best);
        Assert.True(restricted.QualitySummary.Categories["resolution"].AllAgree);
        Assert.Equal("4K", original.QualitySummary.Categories["resolution"].Best);
        Assert.Equal("1080p", cache.GetQualitySummaryForUser(series, user)!.Categories["resolution"].Best);
        Assert.Equal(1, high.Reads); // user filtering and batch reuse do not reopen episodes
        high.StreamHeight = 4320;
        cache.EnqueueUpdate(high.Id); cache.EnqueueUpdate(series.Id); cache.EnqueueUpdate(season.Id);
        typeof(TagCacheService).GetMethod("FlushPending", BindingFlags.Instance | BindingFlags.NonPublic)!.Invoke(cache, null);
        foreach (var container in new BaseItem[] { series, season })
        {
            Assert.True(cache.TryGetEntry(container.Id, out var refreshed));
            Assert.Equal("8K", refreshed.QualitySummary!.Categories["resolution"].Best);
        }
        Assert.Equal(1, low.Reads); Assert.Equal(2, high.Reads);
        var snapshot = JsonDocument.Parse(File.ReadAllText(Path.Combine(f.Core.ConfigRoot, "tag-cache.json")));
        Assert.Equal(TagCacheService.CurrentCacheSchemaVersion, snapshot.RootElement.GetProperty("SchemaVersion").GetInt32());
    }

    [Theory]
    [InlineData("best")]
    [InlineData("latest")]
    [InlineData("mixed")]
    public void AnAlternateVersionsVideoSpeaksForTheContainerWhenTheFirstVersionIsUnprobed(string policy)
    {
        TagStreamData Data(bool firstProbed, bool secondProbed, bool reversed = false)
        {
            var sources = new List<TagMediaSource> { new() { Id = "a", Source = "WEB" }, new() { Id = "b", Source = "REMUX" } };
            if (reversed) sources.Reverse();
            var streams = new List<TagMediaStream>();
            if (firstProbed) streams.Add(new() { Type = "Video", SourceId = "a", Width = 1920, Height = 1080, Codec = "h264", VideoRangeType = "SDR" });
            if (secondProbed) streams.Add(new() { Type = "Video", SourceId = "b", Width = 3840, Height = 2160, Codec = "hevc", VideoRangeType = "HDR10" });
            return new TagStreamData { Sources = sources, Streams = streams };
        }
        List<string> Resolved(TagStreamData data, string type = "Series") => SeriesQualityAggregation.Resolve(new TagCacheEntry { Type = type, StreamData = data,
            QualitySummary = SeriesQualityAggregation.Build([new("episode", 1, data)], 100) }, policy, null);
        foreach (var type in new[] { "Series", "Season" })
        {
            // Only the alternate (second) version is probed: its 4K HDR10 HEVC describes the container.
            var alternate = Resolved(Data(false, true), type);
            Assert.Contains("4K", alternate); Assert.Contains("HDR10", alternate); Assert.Contains("HEVC", alternate);
            Assert.DoesNotContain(alternate, label => label.Contains(':', StringComparison.Ordinal) && label.StartsWith("mixed", StringComparison.Ordinal));
            // Listed first, the same probed version reads the same; with nothing probed nothing is invented.
            Assert.Contains("4K", Resolved(Data(false, true, reversed: true), type));
            var none = Resolved(Data(false, false), type);
            Assert.DoesNotContain(none, label => label is "4K" or "1080p" or "HEVC" or "H264" or "HDR10" or "SDR");
            // Both probed: the best of them, as before.
            Assert.Contains("4K", Resolved(Data(true, true), type));
        }
        // A movie card still describes its first version only.
        Assert.DoesNotContain("4K", QualityTagRules.Detect(Data(false, true), null));
    }
}
