using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Model;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags.Resolution;

namespace JE.Tests;

public class UpstreamQualityTests
{
    [Theory]
    [InlineData(1920, 800, "1080p")]
    [InlineData(2560, 1080, "1440p")]
    [InlineData(3840, 1600, "4K")]
    [InlineData(7680, 2160, "8K")]
    [InlineData(1280, 544, "720p")]
    [InlineData(0, 800, "720p")]
    public void CroppedVideoUsesWidthWhenNoAuthoritativeResolutionTitleExists(int width, int height, string expected)
    {
        var video = new TagMediaStream { Type = "Video", Width = width, Height = height };
        Assert.Equal(expected, QualityTagRules.DetectResolution(video));
        Assert.Contains(expected, QualityTagRules.Detect(new() { Streams = [video] }, null));
        video.DisplayTitle = "720p";
        Assert.Equal("720p", QualityTagRules.DetectResolution(video));
    }

    private static TagStreamData Merged()
    {
        var data = new TagStreamData
        {
            Streams = [new() { Type = "Video", SourceId = "first", Width = 1920, Height = 800, Codec = "h264" },
                new() { Type = "Audio", SourceId = "first", Language = "eng", DisplayTitle = "DTS 5.1", Channels = 6 },
                new() { Type = "Video", SourceId = "second", Width = 3840, Height = 1600, Codec = "hevc", VideoRangeType = "HDR10" },
                new() { Type = "Audio", SourceId = "second", Language = "deu", DisplayTitle = "ATMOS 7.1", Channels = 8 }],
            Sources = [new() { Id = "first", Source = "WEB", Path = "Film.mkv", RunTimeTicks = 60L * 60 * 10_000_000 },
                new() { Id = "second", Source = "REMUX", Edition = "Extended", Path = "Film.IMAX.mkv", RunTimeTicks = 120L * 60 * 10_000_000 }],
        };
        data.DistinctQualities = QualityTagRules.DetectDistinct(data.Streams);
        return data;
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void OneVersionDrivesHighestAllNamingAndTechnicalFactsWithoutChangingSharedData(bool cached)
    {
        var data = Merged(); if (!cached) data.DistinctQualities = null;
        var before = JsonSerializer.Serialize(data);
        Assert.Equal(["H264"], QualityTagRules.DistinctValues(data, "videoCodec", null));
        Assert.Equal(["DTS 5.1"], QualityTagRules.DistinctValues(data, "audioInfo", "deu"));
        var selected = QualityTagRules.SelectSource(data, "second")!;
        var labels = QualityTagRules.Detect(selected, "eng");
        Assert.Contains("4K", labels); Assert.Contains("REMUX", labels); Assert.Contains("edition:Extended", labels);
        Assert.Contains("runtime:2h 00m", labels); Assert.Contains("IMAX", labels);
        Assert.Equal(["HEVC"], QualityTagRules.DistinctValues(selected, "videoCodec", null));
        Assert.Equal(["ATMOS 7.1"], QualityTagRules.DistinctValues(selected, "audioInfo", "eng"));
        Assert.Equal(before, JsonSerializer.Serialize(data));
        Assert.Equal(["H264"], QualityTagRules.DistinctValues(QualityTagRules.SelectSource(data, "removed"), "videoCodec", null));
    }

    [Fact]
    public void VersionIdentityAndSourceFactsRoundTripAndParticipateInIncrementalEquality()
    {
        var entry = new TagCacheEntry { Type = "Movie", StreamData = Merged() };
        var json = JsonSerializer.Serialize(entry);
        var copy = JsonSerializer.Deserialize<TagCacheEntry>(json)!;
        Assert.True(TagCacheEntry.ContentEquals(entry, copy));
        Assert.Equal("first", copy.StreamData!.Streams![0].SourceId);
        Assert.All(copy.StreamData.DistinctQualities!, quality => Assert.NotNull(quality.SourceId));
        copy.StreamData.Streams[0].SourceId = "second";
        Assert.False(TagCacheEntry.ContentEquals(entry, copy));
        foreach (var field in new[] { "Id", "Source", "Edition", "RunTimeTicks" })
        {
            copy = JsonSerializer.Deserialize<TagCacheEntry>(json)!;
            typeof(TagMediaSource).GetProperty(field)!.SetValue(copy.StreamData!.Sources![1], null);
            Assert.False(TagCacheEntry.ContentEquals(entry, copy));
        }
    }

    [Fact]
    public void ContainerPoliciesStillCompareAllEpisodeVersionsAndTheirFullSets()
    {
        var data = Merged();
        var summary = SeriesQualityAggregation.Build([new("first", 1, data), new("last", 2, data)], 100);
        var codec = summary.Categories["videoCodec"];
        Assert.Equal(["HEVC", "H264"], codec.All);
        Assert.Equal(codec.All, codec.Shared); Assert.Equal(codec.All, codec.LatestAll);
        Assert.True(codec.AllSetsAgree);
    }
}
