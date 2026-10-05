using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Model;
using Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags;
using Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags.Rendering;
using SkiaSharp;

namespace JE.Tests;

public class PosterRegressionTests
{
    private static PosterTagSettings Settings(string json = "{}") => PosterTagSettings.FromSettingsJson(json, new PluginConfiguration());
    private static PosterTagItemContext Context(string type = "Movie", bool played = false) => new(type, played, null, null, null);

    [Theory]
    [InlineData("", false)]
    [InlineData("null", false)]
    [InlineData("[]", false)]
    [InlineData("{broken", false)]
    [InlineData("{qualityTagsEnabled:true}", true)]
    [InlineData("{QualityTagsEnabled:true, qualityTagsEnabled:false}", false)]
    public void Settings_use_server_lenient_read_and_defaults(string json, bool quality) => Assert.Equal(quality, Settings(json).QualityTagsEnabled);

    [Fact]
    public void Missing_settings_inherit_admin_but_existing_empty_file_uses_user_defaults()
    {
        var config = new PluginConfiguration { QualityTagsEnabled = true };
        Assert.True(PosterTagSettings.FromSettingsJson(null, config).QualityTagsEnabled);
        Assert.False(PosterTagSettings.FromSettingsJson("", config).QualityTagsEnabled);
    }

    [Theory]
    [InlineData("none", null, false)]
    [InlineData("auto", "jpn", true)]
    [InlineData("fra", "fra", false)]
    [InlineData("", "jpn", true)]
    public void Audio_preference_precedence(string choice, string? expected, bool followsUser)
    {
        var settings = PosterTagSettings.FromUserSettings(new UserSettings { QualityTagsPreferredAudioLanguage = choice }, new PluginConfiguration { QualityTagsAudioLanguageFromUser = true, QualityTagsPreferredAudioLanguage = "eng" }, "jpn");
        Assert.Equal(expected, settings.PreferredAudioLanguage);
        Assert.Equal(followsUser, settings.UsesJellyfinAudioPreference);
    }

    [Fact]
    public void Digest_changes_only_when_effective_rendering_changes()
    {
        Assert.Equal(Settings("{qualityTagsEnabled:false,showResolutionTag:true}").Digest, Settings("{qualityTagsEnabled:false,showResolutionTag:false}").Digest);
        Assert.NotEqual(Settings("{qualityTagsEnabled:true,showResolutionTag:true}").Digest, Settings("{qualityTagsEnabled:true,showResolutionTag:false}").Digest);
        Assert.Equal(Settings("{qualityTagsEnabled:true,genreTagsEnabled:true}").Digest, Settings("{genreTagsEnabled:true,qualityTagsEnabled:true}").Digest);
    }

    [Theory]
    [InlineData(true, null, true)]
    [InlineData(false, 1, true)]
    [InlineData(false, 0, false)]
    [InlineData(false, -1, false)]
    public void Played_indicator_boundary(bool played, int? count, bool expected) => Assert.Equal(expected, PosterTagResolver.ShowsPlayedIndicator(new("Series", played, count, null, null)));

    [Fact]
    public void Disabled_and_empty_metadata_produce_no_tags()
    {
        Assert.Null(PosterTagResolver.Resolve(new() { Genres = ["Drama"] }, Settings(), Context(), false));
        Assert.Null(PosterTagResolver.Resolve(new(), Settings("{qualityTagsEnabled:true,genreTagsEnabled:true,languageTagsEnabled:true,ratingTagsEnabled:true,ageRatingTagsEnabled:true}"), Context(), false));
    }

    [Theory]
    [InlineData(2160, "4K")]
    [InlineData(1080, "1080p")]
    [InlineData(720, "720p")]
    [InlineData(480, "480p")]
    public void Quality_detects_stream_height(int height, string expected)
    {
        var entry = new TagCacheEntry { StreamData = new() { Streams = [new() { Type = "Video", Height = height, Codec = "h264" }] } };
        var result = PosterTagResolver.Resolve(entry, Settings("{qualityTagsEnabled:true}"), Context(), false)!;
        Assert.Contains(result.Groups.SelectMany(g => g.Tags), t => t is QualityTag q && q.Label == expected);
        Assert.Contains(result.Groups.SelectMany(g => g.Tags), t => t is QualityTag q && q.Label == "H264");
        var filtered = PosterTagResolver.Resolve(entry, Settings("{qualityTagsEnabled:true,showResolutionTag:false}"), Context(), false)!;
        Assert.DoesNotContain(filtered.Groups.SelectMany(g => g.Tags), t => t is QualityTag q && q.Category == "resolution");
    }

    [Fact]
    public void Rating_scope_and_top_right_offset_follow_viewer_context()
    {
        var entry = new TagCacheEntry { Type = "Movie", CommunityRating = 8.4f, Genres = ["Drama"] };
        var settings = Settings("{ratingTagsEnabled:true,ratingTagsOnMovies:false,genreTagsEnabled:true}");
        var result = PosterTagResolver.Resolve(entry, settings, Context(played: true), true)!;
        Assert.DoesNotContain(result.Groups, g => g.Group == PosterTagGroup.Rating);
        Assert.True(result.TopRightOffset);
        Assert.True(result.Landscape);
        Assert.False(PosterTagResolver.Resolve(entry, settings, Context(), false)!.TopRightOffset);
    }

    [Fact]
    public void Language_flags_deduplicate_and_mark_partial_audio()
    {
        var result = PosterTagResolver.Resolve(new() { AudioLanguages = ["eng", "eng", "jpn"], PartialAudioLanguages = ["jpn"] }, Settings("{languageTagsEnabled:true}"), Context(), false)!;
        var tags = result.Groups.SelectMany(g => g.Tags).Cast<LanguageTag>().ToArray();
        Assert.Equal(2, tags.Length);
        Assert.Contains(tags, t => t.FlagCode == "jp" && t.Partial);
        Assert.Contains(tags, t => t.FlagCode == "gb" && !t.Partial);
    }

    private static PosterTagLayout Layout(PosterTagCorner corner = PosterTagCorner.TopLeft) => new([new(PosterTagGroup.Quality, corner, [new QualityTag("4K", "resolution")])], false, false);
    private static SKBitmap Poster() { var b = new SKBitmap(180, 270); b.Erase(SKColors.Navy); return b; }

    [Fact]
    public void Renderer_changes_tag_corner_preserves_source_and_center()
    {
        using var renderer = new PosterTagRenderer();
        using var source = Poster();
        using var output = renderer.Render(source, Layout());
        Assert.NotNull(output);
        Assert.Equal(source.Width, output.Width);
        Assert.Equal(source.Height, output.Height);
        Assert.Equal(SKColors.Navy, source.GetPixel(8, 8));
        Assert.Equal(SKColors.Navy, output.GetPixel(90, 135));
        Assert.Contains(Enumerable.Range(0, 40).SelectMany(y => Enumerable.Range(0, 60).Select(x => output.GetPixel(x,y))), p => p != SKColors.Navy);
        Assert.All(Enumerable.Range(150, 30).SelectMany(x => Enumerable.Range(200, 70).Select(y => output.GetPixel(x,y))), p => Assert.Equal(SKColors.Navy, p));
    }

    [Theory]
    [InlineData(SKEncodedImageFormat.Png, "image/png")]
    [InlineData(SKEncodedImageFormat.Jpeg, "image/jpeg")]
    [InlineData(SKEncodedImageFormat.Webp, "image/webp")]
    public void Encoded_output_retains_format_and_dimensions(SKEncodedImageFormat format, string mime)
    {
        using var renderer = new PosterTagRenderer();
        using var source = Poster();
        using var image = SKImage.FromBitmap(source);
        using var encoded = image.Encode(format, 95);
        var bytes = renderer.RenderEncoded(encoded.ToArray(), mime, 95, Layout());
        Assert.NotNull(bytes);
        using var data = SKData.CreateCopy(bytes);
        using var codec = SKCodec.Create(data);
        Assert.Equal(format, codec.EncodedFormat);
        Assert.Equal(180, codec.Info.Width);
        Assert.Equal(270, codec.Info.Height);
    }

    [Fact]
    public void Renderer_fails_open_for_empty_corrupt_unsupported_or_disposed_input()
    {
        using var renderer = new PosterTagRenderer();
        using var source = Poster();
        Assert.Null(renderer.Render(source, new([], false, false)));
        Assert.Null(renderer.RenderEncoded([1, 2, 3], "image/png", 90, Layout()));
        Assert.Null(renderer.RenderEncoded([1, 2, 3], "image/gif", 90, Layout()));
        renderer.Dispose();
        renderer.Dispose();
        Assert.Null(renderer.Render(source, Layout()));
    }

    [Fact]
    public async Task Concurrent_cached_renders_equal_sequential_outputs()
    {
        using var renderer = new PosterTagRenderer();
        byte[] Render(PosterTagCorner corner) { using var source = Poster(); using var rendered = renderer.Render(source, Layout(corner)); using var image = SKImage.FromBitmap(rendered!); using var encoded = image.Encode(SKEncodedImageFormat.Png, 100); return encoded.ToArray(); }
        var corners = Enum.GetValues<PosterTagCorner>();
        var expected = corners.ToDictionary(c => c, Render);
        await Task.WhenAll(Enumerable.Range(0, 32).Select(i => Task.Run(() => Assert.Equal(expected[corners[i % 4]], Render(corners[i % 4])))));
    }
    [Fact]
    public void Cache_budget_eviction_and_disabling_preserve_pixels()
    {
        using var cached = new PosterTagRenderer(1024);
        using var uncached = new PosterTagRenderer(0);
        using var source = Poster();
        foreach (var corner in Enum.GetValues<PosterTagCorner>())
        {
            using var first = cached.Render(source, Layout(corner));
            using var second = uncached.Render(source, Layout(corner));
            Assert.Equal(first!.Pixels, second!.Pixels);
            Assert.InRange(cached.TileCacheBytes, 0, 1024);
            Assert.Equal(0, uncached.TileCacheCount);
        }
        cached.ClearTileCache();
        Assert.Equal(0, cached.TileCacheCount);
        Assert.Equal(0, cached.TileCacheBytes);
    }

    [Theory]
    [InlineData(PosterTagCorner.TopLeft)]
    [InlineData(PosterTagCorner.TopRight)]
    [InlineData(PosterTagCorner.BottomLeft)]
    [InlineData(PosterTagCorner.BottomRight)]
    public void Shared_corner_groups_stack_without_overlap(PosterTagCorner corner)
    {
        using var renderer = new PosterTagRenderer();
        var layout = new PosterTagLayout([
            new(PosterTagGroup.Quality, corner, [new QualityTag("4K", "resolution")]),
            new(PosterTagGroup.AgeRating, corner, [new AgeRatingTag("PG-13", "PG-13")])], false, false);
        var plan = renderer.Plan(180, 270, layout);
        Assert.Equal(2, plan.Groups.Count);
        var first = plan.Groups[0]; var second = plan.Groups[1];
        Assert.True(first.Y + first.Height <= second.Y || second.Y + second.Height <= first.Y);
        Assert.All(plan.Groups, group => {
            Assert.InRange(group.X, 0, plan.CardWidth - group.Width);
            Assert.InRange(group.Y, 0, plan.CardHeight - group.Height);
        });
        var offset = renderer.Plan(180, 270, layout with { TopRightOffset = true });
        if (corner == PosterTagCorner.TopRight) Assert.True(offset.Groups[0].Y > first.Y);
        else Assert.Equal(first.Y, offset.Groups[0].Y);
    }

    [Theory]
    [InlineData("en-baku1926-scouse", "English (Baku)")]
    [InlineData("en-pinyin-baku1926", "English (Baku)")]
    [InlineData("prs-baku1926", "Dari (Unified Turkic Latin Alphabet)")]
    [InlineData("sh-baku1926", "Serbian (Latin, Unified Turkic Latin Alphabet)")]
    [InlineData("cnr-baku1926-scouse", "Montenegrin (BAKU1926_SCOUSE)")]
    public void Language_name_variant_aliases_match_browser_display_names(string code, string expected)
    {
        Assert.Equal(expected, Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags.Resolution.LanguageNames.Of(code));
    }

}
