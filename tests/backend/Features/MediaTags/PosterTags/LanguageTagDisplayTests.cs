using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Features.MediaTags.PosterTags;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.MediaTags.PosterTags;
using SkiaSharp;
using Jellyfin.Plugin.JellyfinEnhanced.Features.MediaTags.PosterTags.Rendering;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.MediaTags.PosterTags.Rendering;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.MediaTags.PosterTags.Resolution;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.MediaTags;

namespace JE.Tests.Features.MediaTags;

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

    [Theory]
    [InlineData("eng", "eng")]
    [InlineData("pt-BR", "pt-br")]
    [InlineData("zxx", "zxx")]
    [InlineData("qu", "qu")]
    [InlineData("que", "que")]
    [InlineData("qub", "qub")]
    [InlineData("und", null)]
    [InlineData("UND", null)]
    [InlineData("root", null)]
    [InlineData("mul", null)]
    [InlineData("mis", null)]
    [InlineData("qaa", null)]
    [InlineData("qtz", null)]
    [InlineData("qaa-FR", null)]
    [InlineData("", null)]
    public void LanguagelessCodesAreNotLanguages(string input, string? expected)
    {
        // Quechua (qu/que) and its varieties outside qaa–qtz remain languages; no dialogue (zxx) keeps its symbol.
        Assert.Equal(expected, Jellyfin.Plugin.JellyfinEnhanced.Features.MediaTags.Services.TagCacheService.NormalizeStreamLanguage(input));
    }

    [Theory]
    [InlineData("cmn-Hant", "tw")]
    [InlineData("cmn-Hans", "cn")]
    [InlineData("zh-yue", "hk")]
    [InlineData("yue", "hk")]
    [InlineData("mao", "nz")]
    [InlineData("mi", "nz")]
    [InlineData("arz", "eg")]
    [InlineData("ckb", "iq")]
    [InlineData("zh-Hant", "tw")]
    [InlineData("gre", "gr")]
    [InlineData("cze", "cz")]
    [InlineData("slo", "sk")]
    [InlineData("alb", "al")]
    [InlineData("mac", "mk")]
    [InlineData("ice", "is")]
    [InlineData("arm", "am")]
    [InlineData("geo", "ge")]
    [InlineData("ger", "de")]
    [InlineData("chi", "cn")]
    public void BibliographicCodesShowTheirLanguagesFlag(string code, string flag)
    {
        var entry = new TagCacheEntry { Type = "Movie", AudioLanguages = [code] };
        var tags = Resolve(entry)!.Groups.Single().Tags.Cast<LanguageTag>().ToArray();
        Assert.Equal(flag, Assert.Single(tags).FlagCode);
    }

    [Theory]
    [InlineData("gre", "Griechisch", "gr")]
    [InlineData("cze", "Tchèque", "cz")]
    [InlineData("ice", "Islandés", "is")]
    [InlineData("arm", "Armeens", "am")]
    public void ABibliographicCodeFindsItsFlagWhateverLanguageItsNameIsIn(string code, string name, string flag)
        => Assert.Equal(flag, LanguageFlagRules.ResolveFlag(code, name));

    [Fact]
    public void FlagsStyleKeepsLanguagesWithoutAFlagAsCodeChips()
    {
        var entry = new TagCacheEntry { Type = "Movie", AudioLanguages = ["eng", "epo", "cym", "bos", "khm"], SubtitleLanguages = ["epo"] };
        var tags = Resolve(entry, ",\"LanguageTagsShowSubtitles\":true,\"TagGroupCaps\":{\"language\":0},\"TagLayoutSettingsVersion\":1")!.Groups.Single().Tags.Cast<LanguageTag>().ToArray();
        // Bosnian and Khmer have their flags; Esperanto and Welsh have none and fall back to codes.
        Assert.Equal(new[] { "gb", "", "", "ba", "kh", "" }, tags.Select(t => t.FlagCode));
        Assert.Equal(new[] { null, "EO", "CY", null, null, "EO" }, tags.Select(t => t.Code));
        Assert.Equal("eo", tags[1].StyleLabel);
        Assert.True(tags[5].Subtitle);
    }

    [Theory]
    [InlineData("tl", "TL")]
    [InlineData("tgl", "TL")]
    [InlineData("nb", "NB")]
    [InlineData("nob", "NB")]
    [InlineData("nn", "NN")]
    [InlineData("nno", "NN")]
    [InlineData("fil", "FIL")]
    [InlineData("srd", "SC")]
    [InlineData("cmn", "CMN")]
    public void IsoDisplayCodesRemainIndependentOfAudioEquivalence(string input, string expected)
    {
        var entry = new TagCacheEntry { Type = "Movie", AudioLanguages = [input], SubtitleLanguages = [input] };
        var tags = Resolve(entry, ",\"LanguageTagsStyle\":\"codes\",\"LanguageTagsShowSubtitles\":true")!.Groups.Single().Tags.Cast<LanguageTag>().ToArray();
        Assert.Equal(new[] { expected, expected }, tags.Select(t => t.Code));
        Assert.True(tags[1].Subtitle);
    }

    [Theory]
    [InlineData("tgl", "tl", "fil", "TL")]
    [InlineData("nob", "nno", "nor", "NB")]
    public void AudioEquivalenceStillDeduplicatesAndCountsOnce(string a, string b, string c, string expected)
    {
        var entry = new TagCacheEntry { Type = "Movie", AudioLanguages = [a, b, c] };
        var tag = Assert.IsType<LanguageTag>(Assert.Single(Resolve(entry, ",\"LanguageTagsStyle\":\"codes\",\"LanguageTagsCountBadge\":\"both\"")!.Groups.Single().Tags));
        Assert.Equal(expected, tag.Code);
        Assert.Null(tag.CountBadge);
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

    private static PosterTagLayout Isolated(LanguageTag tag) => new(
        [new(PosterTagGroup.Language, PosterTagCorner.TopLeft, [tag])], false, false);

    /// <summary>Read an interior rectangle in the isolated tile, excluding its border and shadow.</summary>
    private static SKColor[] Pixels(SKBitmap image, SKRect rect) =>
        (from y in Enumerable.Range((int)Math.Ceiling(rect.Top), Math.Max(0, (int)Math.Floor(rect.Bottom) - (int)Math.Ceiling(rect.Top)))
         from x in Enumerable.Range((int)Math.Ceiling(rect.Left), Math.Max(0, (int)Math.Floor(rect.Right) - (int)Math.Ceiling(rect.Left)))
         select image.GetPixel(x, y)).ToArray();

    [Theory]
    [InlineData("EN")]
    [InlineData("NB")]
    [InlineData("NN")]
    [InlineData("TL")]
    [InlineData("Dual")]
    [InlineData("Multi")]
    public void IsolatedNativeChipPlansAndPaintsItsText(string text)
    {
        var badge = text is "Dual" or "Multi";
        var layout = Isolated(new LanguageTag("gb", "English", false) { Code = badge ? null : text, CountBadge = badge ? text : null });
        using var renderer = new PosterTagRenderer();
        var plan = renderer.Plan(180, 270, layout);
        var group = Assert.Single(plan.Groups);
        var item = Assert.Single(group.Items);
        Assert.Equal(PosterTagTileKind.LanguageChip, item.Kind);
        Assert.Equal(text, item.Text);
        Assert.NotNull(item.TextLayout);
        Assert.Equal(0, item.IconWidth);
        using var source = new SKBitmap(180, 270);
        source.Erase(SKColors.Transparent);
        using var output = renderer.Render(source, layout)!;
        var interior = Pixels(output, SKRect.Create(group.X + item.X + 4, group.Y + item.Y + 3, item.Width - 8, item.Height - 6));
        // A box or its border alone cannot satisfy the interior text assertion.
        Assert.True(interior.Count(c => c.Red > 220 && c.Green > 220 && c.Blue > 220 && c.Alpha > 200) > 8);
        using var other = renderer.Render(source, Isolated(new LanguageTag("gb", "English", false) { Code = "ZZ" }))!;
        Assert.False(output.Bytes.SequenceEqual(other.Bytes));
    }

    [Fact]
    public void IsolatedSubtitleFlagPaintsBothCcTextAndTheSelectedFlag()
    {
        using var renderer = new PosterTagRenderer();
        var layout = Isolated(new LanguageTag("fr", "French", false) { Subtitle = true });
        var plan = renderer.Plan(180, 270, layout);
        var group = Assert.Single(plan.Groups);
        var item = Assert.Single(group.Items);
        Assert.Equal("CC ", item.Text);
        Assert.True(item.IconWidth > 0);
        Assert.StartsWith("fr|False|", item.Style);
        using var source = new SKBitmap(180, 270);
        source.Erase(SKColors.Transparent);
        using var output = renderer.Render(source, layout)!;
        var text = Pixels(output, SKRect.Create(group.X + item.X + 4, group.Y + item.Y + 3, item.Width - item.IconWidth - 9, item.Height - 6));
        Assert.True(text.Count(c => c.Red > 220 && c.Green > 220 && c.Blue > 220 && c.Alpha > 200) > 8);
        var flag = Pixels(output, SKRect.Create(group.X + item.X + item.Width - item.IconWidth - 1 - PosterTagCss.Lu(plan.Css.QualityPaddingH), group.Y + item.Y + 1 + PosterTagCss.Lu(plan.Css.QualityPaddingV), item.IconWidth, item.IconHeight));
        Assert.Contains(flag, c => c.Blue > 120 && c.Red < 80 && c.Alpha > 240);
        Assert.Contains(flag, c => c.Red > 180 && c.Blue < 120 && c.Alpha > 240);
        using var differentFlag = renderer.Render(source, Isolated(new LanguageTag("jp", "Japanese", false) { Subtitle = true }))!;
        Assert.False(output.Bytes.SequenceEqual(differentFlag.Bytes));
    }

    [Fact]
    public void IsolatedPartialCodeIsDimmedAndHasADashedOutline()
    {
        using var renderer = new PosterTagRenderer();
        var full = Isolated(new LanguageTag("gb", "English", false) { Code = "EN" });
        var partial = Isolated(new LanguageTag("gb", "English", true) { Code = "EN" });
        var group = Assert.Single(renderer.Plan(180, 270, full).Groups);
        var item = Assert.Single(group.Items);
        using var source = new SKBitmap(180, 270);
        source.Erase(SKColors.Transparent);
        using var fullImage = renderer.Render(source, full)!;
        using var partialImage = renderer.Render(source, partial)!;
        var body = SKRect.Create(group.X + item.X + 3, group.Y + item.Y + 3, item.Width - 6, item.Height - 6);
        var fullPixels = Pixels(fullImage, body);
        var partialPixels = Pixels(partialImage, body);
        Assert.True(partialPixels.Average(c => c.Alpha) < fullPixels.Average(c => c.Alpha) * 0.7);
        var top = Pixels(partialImage, SKRect.Create(group.X + item.X + 4, group.Y + item.Y, item.Width - 8, 1));
        // Alternating bright dashes and dimmer gaps, beyond the rounded corners.
        Assert.True(top.Max(c => c.Alpha) - top.Min(c => c.Alpha) > 30);
        Assert.False(fullImage.Bytes.SequenceEqual(partialImage.Bytes));
    }

    [Fact]
    public void LanguageDisplaySettingsChangeTheDigest()
    {
        var config = new PluginConfiguration();
        var baseline = PosterTagSettings.FromSettingsJson("{\"LanguageTagsEnabled\":true}", config).Digest;
        foreach (var setting in new[] { "\"LanguageTagsStyle\":\"codes\"", "\"LanguageTagsShowSubtitles\":true", "\"LanguageTagsShowAudio\":false", "\"LanguageTagsCountBadge\":\"both\"" })
            Assert.NotEqual(baseline, PosterTagSettings.FromSettingsJson("{\"LanguageTagsEnabled\":true," + setting + "}", config).Digest);
    }

    [Fact]
    public void CodesPostersResolvedBeforeIsoDisplayCodesCannotReuseTheirDigestOrToken()
    {
        // Resolver version 6 drew Codes through the audio-equivalence canonicaliser (tgl -> FIL, nob/nno -> NO,
        // cmn -> ZH). The ISO display-code fix changed those pixels for unchanged settings and data, so the
        // digest (and with it every composite cache key and signed image token) must differ from the
        // version-6 value recorded for this exact Codes document.
        const string version6CodesDigest = "77b4c98fd8cb85e5";
        var config = new PluginConfiguration();
        var codes = PosterTagSettings.FromSettingsJson("{\"LanguageTagsEnabled\":true,\"LanguageTagsStyle\":\"codes\"}", config);
        Assert.NotEqual("6", PosterTagSettings.ResolverVersion);
        Assert.NotEqual(version6CodesDigest, codes.Digest);
        Assert.Equal("TL", LanguageFlagRules.ShortCode("tgl"));

        var directory = Path.Combine(Path.GetTempPath(), "je-poster-tests-" + Guid.NewGuid().ToString("N"));
        try
        {
            var tokens = PosterTagVariantToken.CreateForPath(Path.Combine(directory, "secret"), _ => { });
            var user = Guid.Parse("11111111-1111-1111-1111-111111111111");
            var item = Guid.Parse("22222222-2222-2222-2222-222222222222");
            var old = tokens.Mint(user, item, version6CodesDigest, PosterTagComposer.PixelVersion, PosterTagVariantFlags.None, "abcdef");
            Assert.False(tokens.Verify(old, user, item, codes.Digest, PosterTagComposer.PixelVersion, out _));
            var current = tokens.Mint(user, item, codes.Digest, PosterTagComposer.PixelVersion, PosterTagVariantFlags.None, "abcdef");
            Assert.True(tokens.Verify(current, user, item, codes.Digest, PosterTagComposer.PixelVersion, out _));
        }
        finally
        {
            if (Directory.Exists(directory)) Directory.Delete(directory, true);
        }
    }

    [Fact]
    public void TagStylesCatalogAcceptsSubtitleAndBadgeLabels()
    {
        Assert.True(TagStyleCatalog.IsLabel("language", "subtitles"));
        Assert.True(TagStyleCatalog.IsLabel("language", "countBadge"));
        Assert.True(TagStyleSet.TryValidate("{\"v\":2,\"labels\":{\"language:subtitles\":{\"border\":\"#112233\"},\"language:countBadge\":{\"border\":\"#334455\"}}}", "default", out _, out _));
    }
}
