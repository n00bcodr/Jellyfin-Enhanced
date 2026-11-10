using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Features.MediaTags.PosterTags;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.MediaTags.PosterTags;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.MediaTags.PosterTags.Resolution;
using Jellyfin.Plugin.JellyfinEnhanced.Features.MediaTags.PosterTags.Rendering;
using Jellyfin.Plugin.JellyfinEnhanced.Features.MediaTags.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.MediaTags;

namespace JE.Tests.Features.MediaTags;

public class TechnicalChipsTests
{
    private sealed record Fixture(string Name, long? Ticks, TagMediaStream Video, string[] Labels, string[] Compact);
    [Fact]
    public void SharedTechnicalFixturesHaveNativeFullAndCompactParity()
    {
        using var data = typeof(TechnicalChipsTests).Assembly.GetManifestResourceStream("TechnicalQuality.json")!;
        var fixtures = JsonSerializer.Deserialize<Fixture[]>(data, new JsonSerializerOptions { PropertyNameCaseInsensitive = true })!;
        foreach (var row in fixtures)
        {
            var entry = new TagCacheEntry { Type = "Movie", StreamData = new() { RunTimeTicks = row.Ticks, Streams = [row.Video] } };
            foreach (var compact in new[] { false, true })
            {
                var settings = PosterTagSettings.FromSettingsJson(JsonSerializer.Serialize(new {
                    QualityTagsEnabled = true, ShowRuntimeTag = true, ShowAspectRatioTag = true, ShowFrameRateTag = true,
                    ShowResolutionTag = false, ShowVideoCodecTag = false, TagLayoutSettingsVersion = 1,
                    TagLayout = "bands", TagLabelDensity = compact ? "compact" : "full", TagGroupCaps = new { Quality = 0 },
                }), new PluginConfiguration());
                var layout = PosterTagResolver.Resolve(entry, settings, new("Movie", false, null, null, null), false);
                var tags = layout?.Groups.SelectMany(g => g.Tags).OfType<QualityTag>().Select(t => t.DisplayText ?? t.Label).ToArray() ?? [];
                Assert.Equal(compact ? row.Compact : row.Labels, tags);
            }
        }
    }

    [Fact]
    public void TechnicalDefaultsAreOffAndPageOrderValuesAreValidated()
    {
        var config = new PluginConfiguration();
        Assert.False(config.ShowRuntimeTag || config.ShowAspectRatioTag || config.ShowFrameRateTag || config.StatusTagsScenes);
        foreach (var field in new[] { "RuntimeTagOrder", "AspectRatioTagOrder", "FrameRateTagOrder" })
        {
            Assert.True(MediaTagsPageFields.TryNormalize(field, 10, out _, out _));
            Assert.False(MediaTagsPageFields.TryNormalize(field, 0, out _, out _));
            Assert.False(MediaTagsPageFields.TryNormalize(field, 100, out _, out _));
        }
    }

    [Theory]
    [InlineData(true, null, true)]
    [InlineData(false, "English SDH", true)]
    [InlineData(false, "English [CC]", true)]
    [InlineData(false, "CCCP", false)]
    public void HearingImpairedFlagOrWholeTitleTokenDetectsSdh(bool flag, string? title, bool expected) =>
        Assert.Equal(expected, SubtitleAccessibility.IsSdh(flag, title, null));

    [Fact]
    public void NativeSdhCodesAndFlagsDrawTheMarker()
    {
        foreach (var style in new[] { "flags", "codes" })
        {
            var entry = new TagCacheEntry { Type = "Movie", SubtitleLanguages = ["eng"], SdhSubtitleLanguages = ["en"] };
            var settings = PosterTagSettings.FromSettingsJson(JsonSerializer.Serialize(new { LanguageTagsEnabled = true, LanguageTagsShowSubtitles = true, LanguageTagsStyle = style }), new());
            var layout = PosterTagResolver.Resolve(entry, settings, new("Movie", false, null, null, null), false)!;
            Assert.True(Assert.IsType<LanguageTag>(Assert.Single(layout.Groups.Single().Tags)).Sdh);
            using var renderer = new PosterTagRenderer();
            Assert.StartsWith("SDH ", renderer.Plan(240, 360, layout).Groups.Single().Items.Single().Text);
        }
    }

    [Fact]
    public void NewFactsParticipateInCacheCloningAndEquality()
    {
        var entry = new TagCacheEntry { Scenes = new(true, false), SdhSubtitleLanguages = ["en"], StreamData = new() { RunTimeTicks = 1, Streams = [new() { Width = 1920, AspectRatio = "16:9", RealFrameRate = 24, AverageFrameRate = 24, IsInterlaced = false, IsHearingImpaired = true, Title = "SDH" }] } };
        Assert.True(TagCacheEntry.ContentEquals(entry, entry.Clone()));
        var clone = entry.Clone(); clone.Scenes = new(false, true); Assert.False(TagCacheEntry.ContentEquals(entry, clone));
        clone = entry.Clone(); clone.SdhSubtitleLanguages = ["fr"]; Assert.False(TagCacheEntry.ContentEquals(entry, clone));
        Assert.False(TagStreamData.ContentEquals(entry.StreamData, new() { RunTimeTicks = 2, Streams = entry.StreamData.Streams }));
        var stream = entry.StreamData.Streams[0];
        foreach (var property in new[] { "Width", "AspectRatio", "RealFrameRate", "AverageFrameRate", "IsInterlaced", "IsHearingImpaired", "Title" })
        {
            var copy = JsonSerializer.Deserialize<TagMediaStream>(JsonSerializer.Serialize(stream))!;
            typeof(TagMediaStream).GetProperty(property)!.SetValue(copy, null);
            Assert.False(TagMediaStream.ContentEquals(stream, copy));
        }
    }

    [Fact]
    public void KeywordMappingIsExactAndScenesRespectPriorityAndOptIn()
    {
        var facts = StatusTagsScenesService.Map("{\"keywords\":[{\"name\":\"aftercreditsstinger\"},{\"name\":\"duringcreditsstinger\"},{\"name\":\"unrelated\"}]}");
        Assert.Equal(new TagScenes(true, true), facts);
        Assert.Equal(new TagScenes(false, false), StatusTagsScenesService.Map("{\"keywords\":[{\"name\":\"notaftercreditsstinger\"}]}"));
        var entry = new TagCacheEntry { Type = "Movie", Scenes = facts };
        var context = new PosterStatusContext(DateTimeOffset.UtcNow);
        PosterTagSettings Settings(bool scenes) => PosterTagSettings.FromSettingsJson(JsonSerializer.Serialize(new { StatusTagsEnabled = true, StatusTagsScenes = scenes }), new());
        Assert.Null(StatusRules.Resolve(entry, Settings(false), context));
        Assert.Equal("post_credits", StatusRules.Resolve(entry, Settings(true), context)!.Key);
        entry.Scenes = new(false, true);
        Assert.Equal("mid_credits", StatusRules.Resolve(entry, Settings(true), context)!.Key);
        entry.DateCreated = context.Now.ToUnixTimeMilliseconds();
        Assert.Equal("just_added", StatusRules.Resolve(entry, Settings(true), context)!.Key);
    }
}
