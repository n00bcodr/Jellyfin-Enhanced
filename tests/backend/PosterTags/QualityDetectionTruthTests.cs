using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Model;
using Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags;
using Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags.Resolution;

namespace JE.Tests;

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
