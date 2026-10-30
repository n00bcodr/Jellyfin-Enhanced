using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Model;
using Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags;
using SkiaSharp;

namespace JE.Tests;

public class LanguageTagDisplayTests
{
    private static PosterTagLayout? Resolve(TagCacheEntry entry, string extra = "") => PosterTagResolver.Resolve(entry,
        PosterTagSettings.FromSettingsJson("{\"LanguageTagsEnabled\":true" + extra + "}", new PluginConfiguration()),
        new PosterTagItemContext(entry.Type!, false, null, null, null), false);

    [Theory]
    [InlineData(0, null)]
    [InlineData(1, null)]
    [InlineData(2, "Dual")]
    [InlineData(3, "Multi")]
    public void BadgeThresholdCountsLanguagesBeforeTheCap(int count, string? badge)
    {
        var entry = new TagCacheEntry { Type = "Movie", AudioLanguages = new[] { "en", "ja", "fr" }.Take(count).ToArray() };
        var layout = Resolve(entry, ",\"LanguageTagsCountBadge\":\"both\"");
        Assert.Equal(badge, layout?.Groups.SelectMany(g => g.Tags).OfType<LanguageTag>().FirstOrDefault()?.CountBadge);
    }

    [Fact]
    public void CodesDedupeAliasesAndPreservePartialCoverageAndSubtitleOrder()
    {
        var entry = new TagCacheEntry { Type = "Series", AudioLanguages = ["eng", "en", "jpn"], PartialAudioLanguages = ["jpn"], SubtitleLanguages = ["fre", "fra"] };
        var tags = Resolve(entry, ",\"LanguageTagsShowSubtitles\":true,\"LanguageTagsStyle\":\"codes\"")!.Groups.Single().Tags.Cast<LanguageTag>().ToArray();
        Assert.Equal(new[] { "EN", "JA", "FR" }, tags.Select(t => t.Code));
        Assert.True(tags[1].Partial);
        Assert.True(tags[2].Subtitle);
    }

    [Fact]
    public void BadgeOnlyKeepsSubtitlesAndUsesCombinedCap()
    {
        var entry = new TagCacheEntry { Type = "Movie", AudioLanguages = ["hi", "ta", "te"], SubtitleLanguages = ["en", "ja", "fr"] };
        var tags = Resolve(entry, ",\"LanguageTagsShowSubtitles\":true,\"LanguageTagsCountBadge\":\"only\"")!.Groups.Single().Tags.Cast<LanguageTag>().ToArray();
        Assert.Equal(3, tags.Length);
        Assert.Equal("Multi", tags[0].CountBadge);
        Assert.All(tags.Skip(1), tag => Assert.True(tag.Subtitle));
    }

    [Fact]
    public void NativeTilesDrawCodesSubtitleFlagsAndBadgeAndChangeTheDigest()
    {
        var entry = new TagCacheEntry { Type = "Movie", AudioLanguages = ["en", "ja"], SubtitleLanguages = ["fr"] };
        using var source = new SKBitmap(300, 450);
        source.Erase(SKColors.DarkBlue);
        using var renderer = new Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags.Rendering.PosterTagRenderer();
        foreach (var style in new[] { "flags", "codes" })
        {
            var layout = Resolve(entry, ",\"LanguageTagsShowSubtitles\":true,\"LanguageTagsCountBadge\":\"only\",\"LanguageTagsStyle\":\"" + style + "\"")!;
            using var output = renderer.Render(source, layout);
            Assert.NotNull(output);
            Assert.False(source.Bytes.SequenceEqual(output!.Bytes));
        }
        var config = new PluginConfiguration();
        var baseline = PosterTagSettings.FromSettingsJson("{\"LanguageTagsEnabled\":true}", config).Digest;
        foreach (var setting in new[] { "\"LanguageTagsStyle\":\"codes\"", "\"LanguageTagsShowSubtitles\":true", "\"LanguageTagsShowAudio\":false", "\"LanguageTagsCountBadge\":\"both\"" })
            Assert.NotEqual(baseline, PosterTagSettings.FromSettingsJson("{\"LanguageTagsEnabled\":true," + setting + "}", config).Digest);
    }

    [Fact]
    public void TagStylesCatalogAcceptsSubtitleAndBadgeLabels()
    {
        Assert.True(TagStyleCatalog.IsLabel("language", "subtitles"));
        Assert.True(TagStyleCatalog.IsLabel("language", "countBadge"));
        Assert.True(TagStyleSet.TryValidate("{\"v\":2,\"labels\":{\"language:subtitles\":{\"border\":\"#112233\"},\"language:countBadge\":{\"border\":\"#334455\"}}}", "default", out _, out _));
    }
}
