using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Features.MediaTags.PosterTags;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.MediaTags.PosterTags;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.MediaTags.PosterTags.Resolution;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.MediaTags;

namespace JE.Tests.Features.MediaTags;

/// <summary>
/// Independent expected labels (tests/fixtures/quality-detection-truth.json), asserted on the native
/// resolver from raw streams and from cached per-track facts; the web suite asserts the same table.
/// </summary>
[Collection("Plugin singleton")]
public class QualityDetectionTruthTests
{
    public static TheoryData<string> Cases()
    {
        var data = new TheoryData<string>();
        foreach (var row in Truth().RootElement.GetProperty("cases").EnumerateArray()) data.Add(row.GetProperty("name").GetString()!);
        return data;
    }

    private static JsonDocument Truth()
    {
        using var stream = typeof(QualityDetectionTruthTests).Assembly.GetManifestResourceStream("QualityDetectionTruth.json")!;
        return JsonDocument.Parse(stream);
    }

    private static string[] Labels(List<TagMediaStream> streams, bool cached, int version, string mode)
    {
        var data = new TagStreamData { Streams = streams, DistinctQualities = cached ? QualityTagRules.DetectDistinct(streams) : null };
        var settings = PosterTagSettings.FromUserSettings(new()
        {
            QualityTagsEnabled = true, TagLayoutSettingsVersion = version, QualityTagsPreferredAudioLanguage = "none",
            QualityAudioDisplayMode = mode, QualityVideoCodecDisplayMode = mode, QualityHdrDisplayMode = mode,
        }, new(), null);
        var entry = new TagCacheEntry { Type = "Movie", StreamData = data };
        return PosterTagResolver.Resolve(entry, settings, new("Movie", false, null, null, null), false)?.Groups
            .SelectMany(group => group.Tags).OfType<QualityTag>().Select(tag => tag.Label).ToArray() ?? [];
    }

    [Theory]
    [MemberData(nameof(Cases))]
    public void NativeLabelsMatchTheExpectedTruth(string name)
    {
        using var truth = Truth();
        var row = truth.RootElement.GetProperty("cases").EnumerateArray().Single(r => r.GetProperty("name").GetString() == name);
        List<TagMediaStream> Streams() => JsonSerializer.Deserialize<List<TagMediaStream>>(row.GetProperty("streams"))!;
        string[] Expected(string key) => row.GetProperty(key).EnumerateArray().Select(v => v.GetString()!).ToArray();
        foreach (var cached in new[] { false, true })
        {
            Assert.Equal(Expected("highest"), Labels(Streams(), cached, 1, "highest"));
            Assert.Equal(Expected("all"), Labels(Streams(), cached, 1, "all"));
            if (row.TryGetProperty("legacy", out _)) Assert.Equal(Expected("legacy"), Labels(Streams(), cached, 0, "highest"));
        }
    }
}

/// <summary>The Versions chip (a count of an item's versions) on native posters.</summary>
[Collection("Plugin singleton")]
public class QualityVersionsChipTests
{
    private static TagCacheEntry Entry(string type, int versions) => new()
    {
        Type = type,
        StreamData = new()
        {
            Streams = Enumerable.Range(0, versions).Select(i => new TagMediaStream { Type = "Video", Height = 1080, Codec = "h264", SourceId = "v" + i }).ToList(),
            Sources = Enumerable.Range(0, versions).Select(i => new TagMediaSource { Id = "v" + i }).ToList(),
        },
    };

    private static QualityTag[] Tags(TagCacheEntry entry, bool on, string density = "full") => PosterTagResolver.Resolve(entry,
        PosterTagSettings.FromUserSettings(new() { QualityTagsEnabled = true, TagLayoutSettingsVersion = 1, TagLabelDensity = density, ShowVersionsTag = on }, new(), null),
        new(entry.Type ?? "Movie", false, null, null, null), false)?.Groups.SelectMany(g => g.Tags).OfType<QualityTag>().ToArray() ?? [];

    [Fact]
    public void ItemsWithSeveralVersionsCountThemAndContainersNever()
    {
        var chip = Assert.Single(Tags(Entry("Movie", 3), on: true), t => t.Category == QualityTagRules.Versions);
        Assert.Equal(("3", "3 versions"), (chip.Label, chip.DisplayText));
        Assert.Equal("×2", Assert.Single(Tags(Entry("Episode", 2), on: true, "compact"), t => t.Category == QualityTagRules.Versions).DisplayText);
        Assert.DoesNotContain(Tags(Entry("Movie", 1), on: true), t => t.Category == QualityTagRules.Versions);
        Assert.DoesNotContain(Tags(Entry("Series", 2), on: true), t => t.Category == QualityTagRules.Versions);
        Assert.DoesNotContain(Tags(Entry("Movie", 2), on: false), t => t.Category == QualityTagRules.Versions);
        // Off by default, and an off chip leaves the poster digest (and every existing poster URL) unchanged.
        Assert.Equal(PosterTagSettings.FromUserSettings(new() { QualityTagsEnabled = true }, new(), null).Digest,
            PosterTagSettings.FromUserSettings(new() { QualityTagsEnabled = true, ShowVersionsTag = false }, new(), null).Digest);
    }
}
