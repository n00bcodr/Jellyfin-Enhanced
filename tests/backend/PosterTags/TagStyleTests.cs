using System.Text.Json;
using System.Text.Json.Nodes;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags;
using Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags.Rendering;
using SkiaSharp;
namespace JE.Tests;

public class TagStyleTests
{
    // Version 1, as the old editor saved it: per-section maps, "color" for the text.
    private const string V1 = "{\"quality\":{\"4K\":{\"background\":\"#ff0000\",\"color\":\"rgba(0,0,255,0.5)\"},\"X\":{\"background\":\"url(x)\"}},\"age\":{\"13\":{\"border\":\"#00ff00\"}},\"rating\":{\"community\":{\"background\":\"#123456\"}}}";

    // The same without the entries only a lenient read skips (an unknown label, a value that is not a colour).
    private const string V1Valid = "{\"quality\":{\"4K\":{\"background\":\"#ff0000\",\"color\":\"rgba(0,0,255,0.5)\"}},\"age\":{\"13\":{\"border\":\"#00ff00\"}},\"rating\":{\"community\":{\"background\":\"#123456\"}}}";

    private const string V2 = "{\"v\":2,\"preset\":\"glass\",\"groups\":{\"quality\":{\"background\":\"#ff0000\"},\"status\":{\"text\":\"#00ff00\"}},\"labels\":{\"quality:4K\":{\"text\":\"#0000ff\"},\"language:flag\":{\"border\":\"#ffffff\"}}}";

    [Fact]
    public void Version_1_documents_migrate_to_the_colours_they_drew_under_the_default_preset()
    {
        var set = TagStyleSet.Parse(V1, "outline");
        Assert.Equal("default", set.Preset); // the saved name only remembered the old dropdown
        Assert.Empty(set.Groups);
        // Each stored label is materialised: stored fields, else the built-in colour it was drawn with.
        Assert.Equal(new TagColors("rgba(255, 0, 0, 1)", "rgba(255, 255, 255, 0.149)", "rgba(0, 0, 255, 0.502)"), set.Labels["quality:4K"]);
        Assert.False(set.Labels.ContainsKey("quality:X"));
        var board = TagStylePalettes.Builtin("ageRating", "13");
        Assert.Equal(board with { Border = "rgba(0, 255, 0, 1)" }, set.Labels["ageRating:13"]);
        // Rating chips never drew a border: none is materialised.
        Assert.Equal(new TagColors("rgba(18, 52, 86, 1)", null, "rgba(255, 193, 7, 1)"), set.Labels["rating:community"]);
        Assert.NotEmpty(set.Hash);

        // Version 1 never styled the user review chip.
        Assert.Empty(TagStyleSet.Parse("{\"rating\":{\"userReview\":{\"color\":\"#ffffff\"}}}").Labels);

        Assert.Equal("default", TagStyleSet.Parse(V1, "custom").Preset);
        Assert.True(TagStyleSet.Parse("not json").IsEmpty);
        Assert.True(TagStyleSet.Parse("").IsEmpty);
        Assert.False(TagStyleSet.Parse("", "glass").IsEmpty);
    }

    [Theory]
    [InlineData("glass")]
    [InlineData("outline")]
    [InlineData("mono")]
    [InlineData("light")]
    [InlineData("custom")]
    public void A_version_1_preset_document_draws_every_chip_exactly_as_before_the_migration(string savedPreset)
    {
        // As the old editor saved Glass applied to the Quality tab only, after a few edits on other tabs:
        // only the differences from the built-ins (Glass kept every text colour, so none is stored).
        var quality = new JsonObject();
        foreach (var (label, background, _) in TagStyleCatalog.Quality)
        {
            Assert.True(CssColor.TryParse(background, out var bg));
            bool dark = (0.299 * bg.Red) + (0.587 * bg.Green) + (0.114 * bg.Blue) < 40;
            quality[label] = new JsonObject
            {
                ["background"] = $"rgba({bg.Red}, {bg.Green}, {bg.Blue}, {(dark ? "0.3" : "0.4")})",
                ["border"] = "rgba(255, 255, 255, 0.4)",
            };
        }

        var v1 = new JsonObject
        {
            ["quality"] = quality,
            ["age"] = new JsonObject { ["9"] = new JsonObject { ["background"] = "#2e7d32" } },
            ["rating"] = new JsonObject { ["community"] = new JsonObject { ["background"] = "rgba(0, 0, 0, 0.5)" }, ["critic"] = new JsonObject { ["color"] = "#ff0000" } },
            ["genre"] = new JsonObject { ["border"] = "#ffffff" },
        }.ToJsonString();

        // The old web and native paths: the stored field, else the built-in colour; rating chips had no
        // border, and status chips and flags were never styled.
        TagColors Legacy(string group, string label)
        {
            var builtin = TagStylePalettes.Builtin(group, label);
            var section = group switch { "quality" => "quality", "ageRating" => "age", "rating" => "rating", "genre" => "genre", _ => null };
            var node = section is null ? null : JsonNode.Parse(v1)![section];
            var stored = group == "genre" ? node : node?[label];
            string? Field(string key) => stored?[key] is { } v ? TagStylePalettes.NormaliseColour((string)v!) : null;
            return new TagColors(
                Field("background") ?? builtin.Background,
                group == "rating" ? builtin.Border : Field("border") ?? builtin.Border,
                Field("color") ?? builtin.Text);
        }

        var parsed = TagStyleSet.Parse(v1, savedPreset);
        Assert.True(TagStyleSet.TryValidate(v1, savedPreset, out var saved, out var error), error);
        var reloaded = TagStyleSet.Parse(saved.Serialize(), saved.Preset);
        foreach (var set in new[] { parsed, saved, reloaded })
        {
            Assert.Equal("default", set.Preset);
            foreach (var group in TagStyleKeys.Groups)
            {
                // "*" stands for the quality and age chips outside the catalog.
                var outside = group is "quality" or "ageRating" ? new[] { (TagStyleKeys.AnyLabel, "*") } : [];
                foreach (var (label, _) in TagStyleCatalog.Labels(group).Concat(outside))
                {
                    var drawn = set.Resolve(group, label).Over(TagStylePalettes.Builtin(group, label));
                    var expected = group == "language" ? Legacy(group, label) with { Background = drawn.Background, Text = drawn.Text } : Legacy(group, label);
                    Assert.True(expected == drawn, $"{savedPreset} {group}:{label}: expected {expected}, drew {drawn}");
                }
            }
        }

        // The preset tab touched only quality chips: other groups keep their built-in colours.
        Assert.True(parsed.Resolve("status", "trending").IsEmpty);
        Assert.True(parsed.Resolve("language", "flag").IsEmpty);
        Assert.True(parsed.Resolve("ageRating", "7").IsEmpty);
        Assert.True(parsed.Resolve("rating", "userReview").IsEmpty);
    }

    [Fact]
    public void Version_2_documents_round_trip_and_the_stored_preset_wins()
    {
        var set = TagStyleSet.Parse(V2);
        Assert.Equal("glass", set.Preset);
        Assert.Equal("rgba(255, 0, 0, 1)", set.Groups["quality"].Background);
        Assert.Equal("rgba(255, 255, 255, 1)", set.Labels["language:flag"].Border);
        Assert.Equal("mono", TagStyleSet.Parse(V2, "mono").Preset);

        var again = TagStyleSet.Parse(set.Serialize(), set.Preset);
        Assert.Equal(set.Hash, again.Hash);
        Assert.Equal(string.Empty, TagStyleSet.Parse("", "glass").Serialize());
    }

    [Fact]
    public void A_chip_resolves_preset_then_group_then_label_field_by_field()
    {
        var set = TagStyleSet.Parse(V2);
        var fourK = set.Resolve("quality", "4K");
        Assert.Equal("rgba(255, 0, 0, 1)", fourK.Background); // group
        Assert.Equal("rgba(0, 0, 255, 1)", fourK.Text); // label
        Assert.Equal("rgba(255, 255, 255, 0.349)", fourK.Border); // glass

        var hdr = set.Resolve("quality", "HDR");
        Assert.Equal("rgba(255, 0, 0, 1)", hdr.Background);
        Assert.Equal("rgba(255, 255, 255, 1)", hdr.Text); // glass white

        // Composite labels follow their base; labels outside the catalog take the group's "*".
        Assert.Equal(set.Resolve("quality", "ATMOS"), set.ResolveQuality("ATMOS 7.1"));
        Assert.Equal(set.Resolve("quality", "*"), set.ResolveQuality("2.0"));
        Assert.Equal("rgba(0, 255, 0, 1)", set.Resolve("status", "trending").Text); // group beats glass gold

        // The default preset with no overrides changes nothing at all.
        Assert.True(TagStyleSet.Empty.Resolve("rating", "community").IsEmpty);
        Assert.True(TagStyleSet.Empty.ResolveQuality("4K").IsEmpty);
    }

    [Theory]
    [InlineData("glass", "rating", "community", "rgba(255, 255, 255, 0.16)", "rgba(255, 255, 255, 0.35)", "rgba(255, 209, 102, 1)")]
    [InlineData("glass", "rating", "critic", "rgba(255, 255, 255, 0.16)", "rgba(255, 255, 255, 0.35)", "rgba(255, 138, 138, 1)")]
    [InlineData("glass", "status", "trending", "rgba(255, 255, 255, 0.16)", "rgba(255, 255, 255, 0.35)", "rgba(255, 209, 102, 1)")]
    [InlineData("glass", "genre", "genre", "rgba(255, 255, 255, 0.16)", "rgba(255, 255, 255, 0.35)", "rgba(255, 255, 255, 1)")]
    [InlineData("outline", "quality", "4K", "rgba(0, 0, 0, 0.35)", "rgba(30, 136, 229, 1)", "rgba(30, 136, 229, 1)")]
    [InlineData("outline", "quality", "HDR10", "rgba(0, 0, 0, 0.35)", "rgba(239, 108, 0, 1)", "rgba(239, 108, 0, 1)")]
    [InlineData("outline", "quality", "ATMOS", "rgba(0, 0, 0, 0.35)", "rgba(46, 125, 50, 1)", "rgba(46, 125, 50, 1)")]
    [InlineData("outline", "quality", "HEVC", "rgba(0, 0, 0, 0.35)", "rgba(84, 110, 122, 1)", "rgba(84, 110, 122, 1)")]
    [InlineData("outline", "rating", "community", "rgba(0, 0, 0, 0.35)", "rgba(255, 209, 102, 1)", "rgba(255, 209, 102, 1)")]
    [InlineData("outline", "rating", "critic", "rgba(0, 0, 0, 0.35)", "rgba(255, 107, 107, 1)", "rgba(255, 107, 107, 1)")]
    [InlineData("outline", "ageRating", "7", "rgba(0, 0, 0, 0.35)", "rgba(128, 0, 0, 1)", "rgba(128, 0, 0, 1)")]
    [InlineData("outline", "ageRating", "0", "rgba(0, 0, 0, 0.35)", "rgba(66, 66, 66, 1)", "rgba(66, 66, 66, 1)")]
    [InlineData("outline", "status", "added", "rgba(0, 0, 0, 0.35)", "rgba(255, 255, 255, 0.6)", "rgba(255, 255, 255, 1)")]
    [InlineData("dark", "quality", "4K", "rgba(0, 0, 0, 0.82)", "rgba(0, 0, 0, 0)", "rgba(255, 255, 255, 1)")]
    [InlineData("dark", "rating", "community", "rgba(0, 0, 0, 0.82)", null, "rgba(255, 209, 102, 1)")]
    [InlineData("dark", "rating", "critic", "rgba(0, 0, 0, 0.82)", null, "rgba(255, 138, 138, 1)")]
    [InlineData("light", "quality", "4K", "rgba(255, 255, 255, 0.92)", "rgba(0, 0, 0, 0)", "rgba(17, 17, 17, 1)")]
    [InlineData("light", "rating", "community", "rgba(255, 255, 255, 0.92)", null, "rgba(184, 134, 11, 1)")]
    [InlineData("light", "rating", "critic", "rgba(255, 255, 255, 0.92)", null, "rgba(198, 40, 40, 1)")]
    [InlineData("light", "ageRating", "4", "rgba(255, 255, 255, 0.92)", "rgba(0, 0, 0, 0)", "rgba(46, 125, 50, 1)")]
    [InlineData("mono", "status", "newMovie", "rgba(20, 20, 20, 0.75)", "rgba(255, 255, 255, 0.2)", "rgba(224, 224, 224, 1)")]
    [InlineData("mono", "rating", "userReview", "rgba(20, 20, 20, 0.75)", "rgba(255, 255, 255, 0.2)", "rgba(224, 224, 224, 1)")]
    [InlineData("mono", "language", "flag", null, "rgba(255, 255, 255, 0.2)", null)]
    [InlineData("outline", "language", "flag", null, "rgba(255, 255, 255, 0.6)", null)]
    [InlineData("dark", "language", "flag", null, null, null)]
    public void Each_preset_gives_each_chip_kind_its_palette(string preset, string group, string label, string? background, string? border, string? text)
    {
        // Alpha is stored as a byte, so 0.35 reads back as 0.349: compare with the brief's values normalised.
        var c = TagStylePalettes.Preset(preset, group, label);
        var n = TagStylePalettes.NormaliseColour;
        Assert.Equal(new TagColors(n(background), n(border), n(text)), c);
        Assert.Equal(c, TagStyleSet.Parse(string.Empty, preset).Resolve(group, label));
    }

    [Fact]
    public void The_default_preset_keeps_every_built_in_colour_and_every_palette_is_well_formed()
    {
        foreach (var group in TagStyleKeys.Groups)
        {
            foreach (var (label, _) in TagStyleCatalog.Labels(group))
            {
                Assert.True(TagStylePalettes.Preset("default", group, label).IsEmpty, $"{group}:{label}");
                foreach (var preset in TagStyleKeys.Presets)
                {
                    var concrete = TagStylePalettes.Concrete(preset, group, label);
                    Assert.All(new[] { concrete.Background, concrete.Border, concrete.Text }, v => Assert.StartsWith("rgba(", v));
                    var palette = TagStylePalettes.Preset(preset, group, label);
                    if (group == "language")
                    {
                        Assert.Null(palette.Background);
                        Assert.Null(palette.Text);
                    }
                }
            }
        }

        Assert.Equal(new TagColors("rgba(0, 0, 0, 0.851)", "rgba(0, 0, 0, 0)", "rgba(255, 193, 7, 1)"), TagStylePalettes.Builtin("rating", "community"));
        Assert.Equal("rgba(255, 0, 0, 1)", TagStylePalettes.Builtin("ageRating", "14").Background); // "red" in the colour sheet
        Assert.Equal(5, TagStyleCatalog.Labels("status").Count);
        Assert.Equal("PG-13", TagStyleCatalog.AgeGroups.Single(a => a.Id == "9").Sample);
    }

    [Theory]
    [InlineData("#ffffff", "#000000", 21.0, "aa")]
    [InlineData("#000000", "#000000", 1.0, "low")]
    [InlineData("#767676", "#ffffff", 4.54, "aa")]
    [InlineData("#949494", "#ffffff", 3.03, "large")]
    [InlineData("#ffffff", "rgba(255, 255, 255, 0)", 15.13, "aa")] // a clear background shows the #262626 poster
    [InlineData("#ffffff", "rgba(255, 255, 255, 0.92)", 1.16, "low")]
    public void Contrast_composites_over_the_dark_poster_and_grades_like_wcag(string text, string background, double expected, string level)
    {
        var ratio = TagStylePalettes.Contrast(text, background);
        Assert.NotNull(ratio);
        Assert.Equal(expected, ratio!.Value, 2);
        Assert.Equal(level, TagStylePalettes.ContrastLevel(ratio.Value));
        Assert.Null(TagStylePalettes.Contrast("url(x)", "#000"));
    }

    [Theory]
    [InlineData("{\"v\":2,\"extra\":{}}", "unknown key")]
    [InlineData("{\"v\":3}", "version")]
    [InlineData("{\"v\":2,\"preset\":\"neon\"}", "unknown preset")]
    [InlineData("{\"v\":2,\"groups\":{\"people\":{\"text\":\"#fff\"}}}", "unknown group")]
    [InlineData("{\"v\":2,\"labels\":{\"quality:8K-ULTRA\":{\"text\":\"#fff\"}}}", "unknown label")]
    [InlineData("{\"v\":2,\"labels\":{\"status:soon\":{\"text\":\"#fff\"}}}", "unknown label")]
    [InlineData("{\"v\":2,\"labels\":{\"4K\":{\"text\":\"#fff\"}}}", "unknown label")]
    [InlineData("{\"v\":2,\"groups\":{\"quality\":{\"text\":\"red;}body{display:none\"}}}", "not a colour")]
    [InlineData("{\"v\":2,\"groups\":{\"quality\":{\"text\":5}}}", "not a colour")]
    [InlineData("{\"v\":2,\"groups\":{\"quality\":{\"shadow\":\"#fff\"}}}", "does not apply")]
    [InlineData("{\"v\":2,\"groups\":{\"language\":{\"background\":\"#fff\"}}}", "does not apply")]
    [InlineData("[1]", "not a JSON object")]
    [InlineData("{\"v\":2", "not valid JSON")]
    public void Validation_rejects_unknown_keys_bad_colours_and_fields_that_do_not_apply(string json, string reason)
    {
        Assert.False(TagStyleSet.TryValidate(json, "default", out _, out var error));
        Assert.Contains(reason, error);
    }

    [Fact]
    public void Validation_caps_the_document_size_and_converts_version_1()
    {
        var huge = "{\"v\":2,\"labels\":{" + string.Join(",", Enumerable.Range(0, 3000).Select(i => $"\"quality:4K{i}\":{{}}")) + "}}";
        Assert.True(huge.Length > TagStyleSet.MaxDocumentLength);
        Assert.False(TagStyleSet.TryValidate(huge, "default", out _, out var error));
        Assert.Contains("larger", error);
        Assert.False(TagStyleSet.TryValidate("", "neon", out _, out _));

        Assert.True(TagStyleSet.TryValidate(V1Valid, "glass", out var converted, out _));
        Assert.Equal("default", converted.Preset);
        var stored = JsonNode.Parse(converted.Serialize())!;
        Assert.Equal(2, (int)stored["v"]!);
        Assert.Equal("rgba(0, 0, 255, 0.502)", (string)stored["labels"]!["quality:4K"]!["text"]!);

        Assert.True(TagStyleSet.TryValidate(V2, "glass", out var valid, out _));
        Assert.Equal(TagStyleSet.Parse(V2, "glass").Hash, valid.Hash);
        Assert.True(TagStyleSet.TryValidate("", "custom", out var cleared, out _));
        Assert.True(cleared.IsEmpty);
    }

    [Fact]
    public void Web_model_lists_resolved_chips_for_every_group_and_expands_age_boards()
    {
        var web = JsonSerializer.Serialize(TagStyleSet.Parse(V1).ToWebModel());
        Assert.Contains("\"PG\"", web);
        Assert.Contains("rgba(0, 255, 0, 1)", web);

        var model = JsonNode.Parse(JsonSerializer.Serialize(TagStyleSet.Parse(V2).ToWebModel()))!;
        Assert.Equal("glass", (string)model["preset"]!);
        Assert.Equal("rgba(0, 0, 255, 1)", (string)model["quality"]!["4K"]!["color"]!);
        Assert.Equal("rgba(255, 0, 0, 1)", (string)model["quality"]!["*"]!["background"]!);
        Assert.Equal("rgba(0, 255, 0, 1)", (string)model["status"]!["trending"]!["color"]!);
        Assert.Equal("rgba(255, 255, 255, 1)", (string)model["language"]!["border"]!);
        Assert.Null(model["language"]!["background"]);
        Assert.Equal(TagStyleCatalog.AgeGroups.Count, model["age"]!.AsArray().Count);

        var empty = JsonNode.Parse(JsonSerializer.Serialize(TagStyleSet.Empty.ToWebModel()))!;
        Assert.Empty(empty["quality"]!.AsObject());
        Assert.Empty(empty["age"]!.AsArray());
        Assert.Null(empty["genre"]);
    }

    [Fact]
    public void Native_settings_digest_and_pixels_follow_the_overrides_only_when_the_target_includes_native()
    {
        PosterTagSettings For(string target, bool enabled = true) => PosterTagSettings.Create(null, new PluginConfiguration { TagStylesEnabled = enabled, TagStyleOverrides = V1, TagStyleTarget = target });
        Assert.True(For("web").Styles.IsEmpty);
        Assert.True(For("both", enabled: false).Styles.IsEmpty);
        Assert.False(For("native").Styles.IsEmpty);
        Assert.NotEqual(For("web").Digest, For("both").Digest);
        Assert.Equal(For("native").Digest, For("both").Digest);

        var plain = QualityPixel(null);
        var styled = QualityPixel(TagStyleSet.Parse(V1));
        Assert.NotEqual(plain, styled);
        Assert.True(styled.Red > 200 && styled.Green < 60, $"expected the red override, got {styled}");
    }

    [Fact]
    public void A_group_override_and_a_preset_reach_native_pixels()
    {
        var group = TagStyleSet.Parse("{\"v\":2,\"groups\":{\"quality\":{\"background\":\"#00ff00\"}}}");
        var green = QualityPixel(group);
        Assert.True(green.Green > 200 && green.Red < 60, $"expected the green group override, got {green}");

        var light = QualityPixel(TagStyleSet.Parse(string.Empty, "light"));
        Assert.True(light.Red > 200 && light.Green > 200 && light.Blue > 200, $"expected the light preset's white chip, got {light}");
        Assert.Equal(QualityPixel(null), QualityPixel(TagStyleSet.Empty));
    }

    [Fact]
    public void Digest_changes_with_the_preset_a_group_or_a_label()
    {
        string Digest(string overrides, string preset) => PosterTagSettings.Create(null, new PluginConfiguration
        {
            TagStylesEnabled = true,
            TagStyleTarget = "both",
            TagStyleOverrides = overrides,
            TagStylePreset = preset,
        }).Digest;

        var baseline = Digest(string.Empty, "default");
        Assert.Equal(PosterTagSettings.Create(null, new PluginConfiguration()).Digest, baseline);
        var preset = Digest(string.Empty, "glass");
        var group = Digest("{\"v\":2,\"groups\":{\"genre\":{\"text\":\"#fff\"}}}", "glass");
        var label = Digest("{\"v\":2,\"groups\":{\"genre\":{\"text\":\"#fff\"}},\"labels\":{\"rating:critic\":{\"text\":\"#000\"}}}", "glass");
        Assert.Equal(4, new[] { baseline, preset, group, label }.Distinct().Count());
    }

    [Fact]
    public void A_users_own_preset_applies_only_while_the_admin_allows_it()
    {
        PosterTagSettings For(bool allowed, string? userPreset)
        {
            var user = new JsonObject { ["tagStylePreset"] = userPreset };
            return PosterTagSettings.Create(user, new PluginConfiguration
            {
                TagStylesEnabled = true,
                TagStyleTarget = "native",
                TagStylePreset = "glass",
                TagStyleOverrides = "{\"v\":2,\"labels\":{\"rating:critic\":{\"text\":\"#000000\"}}}",
                TagStylesAllowUserPreset = allowed,
            });
        }

        Assert.Equal("glass", For(false, "light").Styles.Preset);
        Assert.Equal("light", For(true, "light").Styles.Preset);
        Assert.Equal("glass", For(true, null).Styles.Preset);
        Assert.Equal("glass", For(true, "neon").Styles.Preset);
        Assert.Equal("rgba(0, 0, 0, 1)", For(true, "light").Styles.Resolve("rating", "critic").Text); // admin label on top
        Assert.NotEqual(For(true, "light").Digest, For(true, null).Digest);
        Assert.Equal(For(false, "light").Digest, For(false, null).Digest);

        var set = TagStyleSet.Parse(string.Empty, "glass");
        Assert.Same(set, set.ForUser("mono", allowed: false));
        Assert.Equal("mono", set.ForUser("MONO", allowed: true).Preset);
    }

    private static SKColor QualityPixel(TagStyleSet? styles)
    {
        using var renderer = new PosterTagRenderer();
        var tags = new List<PosterTagGroupLayout> { new(PosterTagGroup.Quality, PosterTagCorner.TopLeft, [new QualityTag("4K", "resolution")]) };
        using var source = new SKBitmap(180, 270);
        source.Erase(SKColors.Black);
        using var drawn = renderer.Render(source, new PosterTagLayout(tags, false, false, styles))!;
        return drawn.GetPixel(14, 14);
    }
}
