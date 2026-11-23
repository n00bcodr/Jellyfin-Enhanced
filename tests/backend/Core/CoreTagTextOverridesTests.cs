using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using Jellyfin.Plugin.JellyfinEnhanced.Model;
using Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags;

namespace JE.Tests;

/// <summary>
/// Tag text (#1063, TagTextOverrides): the administrator sets the words a Tag Styles label's chips show. Native
/// posters apply it to quality (whole chip text), status and awards chips; unknown labels, groups without plain
/// text and overlong or empty texts are refused or dropped; a configuration without overrides keeps its digest.
/// </summary>
public class CoreTagTextOverridesTests
{
    // A real status tile (the web style key the Colours list shows).
    private static readonly string StatusKey = TagStyleKeys.StatusLabels[0].Key;

    private static JellyfinEnhancedUserSettings User() => new()
    {
        TagLayoutSettingsVersion = 1, QualityTagsEnabled = true, AwardsTagsEnabled = true, StatusTagsEnabled = true,
    };

    private static PosterTagSettings Settings(string? overrides)
        => PosterTagSettings.FromUserSettings(User(), new PluginConfiguration { TagTextOverrides = overrides, AwardsTagsEnabled = true });

    [Fact]
    public void KeepsCatalogLabelsOfTextGroupsOnly()
    {
        var json = "{\"status\":{\"" + StatusKey + "\":\"  End of Season \",\"nope\":\"x\",\"" + TagStyleKeys.StatusLabels[1].Key + "\":\"\"},\"genre\":{\"drama\":\"Dramatic\"},\"rating\":{\"imdb\":\"x\"},\"quality\":{\"4K\":\"UHD\"}}";
        var parsed = TagTextRules.Parse(json);
        Assert.Equal("End of Season", parsed["status"][StatusKey]);
        Assert.False(parsed["status"].ContainsKey("nope"));
        Assert.False(parsed["status"].ContainsKey(TagStyleKeys.StatusLabels[1].Key));
        Assert.Equal("Dramatic", parsed["genre"]["drama"]);
        Assert.False(parsed.ContainsKey("rating"));
        Assert.Equal("UHD", parsed["quality"]["4K"]);
    }

    [Theory]
    [InlineData(null, true)]
    [InlineData("", true)]
    [InlineData("[]", false)]
    [InlineData("{\"rating\":{\"imdb\":\"x\"}}", false)]
    [InlineData("{\"status\":{\"nope\":\"x\"}}", false)]
    [InlineData("not json", false)]
    public void ValidatesTheDocumentThePageSends(string? json, bool accepted)
        => Assert.Equal(accepted, TagTextRules.TryValidate(json, out _));

    [Fact]
    public void AcceptsAKnownLabelAndRefusesAnOverlongText()
    {
        Assert.True(TagTextRules.TryValidate("{\"status\":{\"" + StatusKey + "\":\"ok\"}}", out _));
        Assert.False(TagTextRules.TryValidate("{\"status\":{\"" + StatusKey + "\":\"this text is much longer than thirty two characters\"}}", out _));
    }

    [Fact]
    public void NormalizesToACanonicalDocumentOrNull()
    {
        Assert.Null(TagTextRules.Normalize("{\"status\":{\"" + StatusKey + "\":\"\"}}"));
        Assert.Equal(TagTextRules.Normalize("{\"status\":{\"" + StatusKey + "\":\"B\"},\"genre\":{\"drama\":\"A\"}}"),
            TagTextRules.Normalize("{\"genre\":{\"drama\":\"A\"},\"status\":{\"" + StatusKey + "\":\"B\"}}"));
    }

    [Fact]
    public void PageFieldAcceptsAndRefusesLikeTheRules()
    {
        var doc = "{\"status\":{\"" + StatusKey + "\":\"B\"}}";
        Assert.True(MediaTagsPageFields.TryNormalize("TagTextOverrides", doc, out var normalized, out _));
        Assert.Equal(doc, normalized);
        Assert.False(MediaTagsPageFields.TryNormalize("TagTextOverrides", "{\"rating\":{\"imdb\":\"x\"}}", out _, out _));
    }

    [Fact]
    public void QualityChipTakesTheTextWholeAndOthersKeepTheirOwn()
    {
        var entry = new TagCacheEntry
        {
            Type = "Movie",
            StreamData = new TagStreamData { Streams = [new() { Type = "Video", Codec = "hevc", Width = 3840, Height = 2160 }, new() { Type = "Audio", Codec = "eac3", Channels = 6 }] },
        };
        var settings = Settings("{\"quality\":{\"4K\":\"UHD\"}}");
        var layout = PosterTagResolver.Resolve(entry, settings, new("Movie", false, null, null, null), false);
        var chips = layout!.Groups.First(g => g.Group == PosterTagGroup.Quality).Tags.OfType<QualityTag>().ToList();
        Assert.Contains(chips, c => c.DisplayText == "UHD" && c.Label == "4K");
        Assert.DoesNotContain(chips.Where(c => c.Label != "4K"), c => c.DisplayText == "UHD");
        var plain = PosterTagResolver.Resolve(entry, Settings(null), new("Movie", false, null, null, null), false)!.Groups.First(g => g.Group == PosterTagGroup.Quality).Tags.OfType<QualityTag>();
        Assert.All(plain, c => Assert.NotEqual("UHD", c.DisplayText));
    }

    [Fact]
    public void DigestChangesOnlyWhenAShownGroupHasOverrides()
    {
        var none = Settings(null).Digest;
        // Genre chips draw no text natively, but the group is shown: its overrides still enter the digest.
        Assert.NotEqual(none, Settings("{\"quality\":{\"4K\":\"UHD\"}}").Digest);
        Assert.NotEqual(Settings("{\"quality\":{\"4K\":\"UHD\"}}").Digest, Settings("{\"quality\":{\"4K\":\"2160\"}}").Digest);
    }

    [Fact]
    public void WebAndNativeLookUpTheSameCatalogKeys()
    {
        var set = TagTextSet.For("{\"awards\":{\"oscar\":\"Winner\"}}");
        Assert.Equal("Winner", set.Of("awards", "oscar"));
        Assert.Null(set.Of("awards", "emmy"));
        Assert.Null(TagTextSet.Empty.Of("awards", "oscar"));
    }
}
