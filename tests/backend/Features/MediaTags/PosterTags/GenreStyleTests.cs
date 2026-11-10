using System.Text.Json;
using System.Text.Json.Nodes;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.MediaTags.PosterTags;
using Jellyfin.Plugin.JellyfinEnhanced.Features.MediaTags.PosterTags.Rendering;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.MediaTags.PosterTags.Rendering;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.MediaTags.PosterTags.Resolution;
using SkiaSharp;
using Xunit.Abstractions;
namespace JE.Tests.Features.MediaTags;

/// <summary>
/// Per-genre Tag Styles: the genre labels come from js/tags/genre-icons.json (the table genretags.js is generated
/// from), every alias resolves to its canonical genre, documents keep loading as before, and web and native draw the
/// colours tests/fixtures/genre-styles.json states.
/// </summary>
public class GenreStyleTests(ITestOutputHelper output)
{
    private static readonly JsonNode Fixture = ReadFixture();
    private static readonly JsonNode Table = ReadTable();

    private static JsonNode ReadFixture()
    {
        using var stream = typeof(GenreStyleTests).Assembly.GetManifestResourceStream("GenreStyles.json")!;
        return JsonNode.Parse(stream)!;
    }

    private static JsonNode ReadTable()
    {
        using var stream = typeof(GenreIcons).Assembly.GetManifestResourceStream("Jellyfin.Plugin.JellyfinEnhanced.js.tags.genre-icons.json")!;
        return JsonNode.Parse(stream)!;
    }

    private static TagStyleSet FixtureSet() => TagStyleSet.Parse(Fixture["document"]!.ToJsonString());

    [Fact]
    public void The_genre_labels_are_the_shared_tables_canonical_genres_then_other()
    {
        var labels = TagStyleCatalog.Labels(TagStyleKeys.Genre);
        var expected = Table["labels"]!.AsObject().Select(p => (p.Key, (string)p.Value!)).Append(("other", "Other")).ToList();
        Assert.Equal(expected, labels.Select(l => (l.Key, l.Name)).ToList());
        Assert.Equal(26, labels.Count);
        Assert.Equal(GenreIcons.DefaultIcon, (string)Table["defaultIcon"]!);
        Assert.Equal(labels.Count, labels.Select(l => TagStyleCatalog.GenreIcon(l.Key)).Distinct().Count());
        Assert.Equal(GenreIcons.DefaultIcon, TagStyleCatalog.GenreIcon("other"));
        Assert.Null(TagStyleCatalog.GenreIcon("sci-fi"));
        foreach (var (key, _) in labels)
        {
            Assert.True(TagStyleCatalog.IsLabel(TagStyleKeys.Genre, key), key);
            Assert.Equal(key, GenreIcons.LabelOfIcon(TagStyleCatalog.GenreIcon(key)!));
        }

        Assert.False(TagStyleCatalog.IsLabel(TagStyleKeys.Genre, "genre"), "the old single label is no label any more");
        Assert.False(TagStyleCatalog.IsLabel(TagStyleKeys.Genre, "sci-fi"), "aliases are not labels");
        Assert.False(TagStyleCatalog.IsLabel(TagStyleKeys.Genre, TagStyleKeys.AnyLabel));
    }

    [Fact]
    public void Every_name_of_the_table_in_every_language_resolves_to_the_label_of_its_glyph()
    {
        var count = 0;
        foreach (var (language, names) in Table["names"]!.AsObject())
        {
            foreach (var (name, icon) in names!.AsObject())
            {
                count++;
                var label = TagStyleCatalog.GenreKey(name);
                // Both sides look the lowercased name up, so the mixed-case Russian key never matches (kept for parity).
                if (name != name.ToLowerInvariant())
                {
                    Assert.Equal("other", label);
                    continue;
                }

                Assert.True((string)icon! == TagStyleCatalog.GenreIcon(label), $"{language} {name}");
                Assert.Equal(label, TagStyleCatalog.GenreKey(name.ToUpperInvariant()));
            }
        }

        Assert.Equal(155, count);
        Assert.Equal("science fiction", TagStyleCatalog.GenreKey("Sci-Fi"));
        Assert.Equal("comedy", TagStyleCatalog.GenreKey("Comédie"));
        Assert.Equal("horror", TagStyleCatalog.GenreKey("Ужасы"));
        foreach (var odd in new[] { "Unknown Genre", "", "Default", "constructor", "__proto__", "toString", "other", "genre" })
        {
            Assert.Equal("other", TagStyleCatalog.GenreKey(odd));
        }
    }

    [Fact]
    public void The_fixture_genres_resolve_to_their_label_glyph_and_drawn_colours()
    {
        var set = FixtureSet();
        foreach (var c in Fixture["cases"]!.AsArray())
        {
            var genre = (string)c!["genre"]!;
            Assert.Equal((string)c["label"]!, TagStyleCatalog.GenreKey(genre));
            Assert.Equal((string)c["icon"]!, GenreIcons.IconFor(genre));
            var label = GenreIcons.LabelOfIcon(GenreIcons.IconFor(genre));
            var drawn = set.Resolve(TagStyleKeys.Genre, label).Over(TagStylePalettes.Builtin(TagStyleKeys.Genre, label));
            var expected = c["drawn"]!;
            Assert.Equal(new TagColors((string)expected["background"]!, (string)expected["border"]!, (string)expected["text"]!), drawn);
        }
    }

    [Fact]
    public void The_web_model_lists_every_genre_chip_then_each_genre_with_its_own_colours()
    {
        var model = JsonNode.Parse(JsonSerializer.Serialize(FixtureSet().ToWebModel()))!;
        Assert.True(JsonNode.DeepEquals(Fixture["web"], model["genre"]), model["genre"]!.ToJsonString());
        Assert.Equal(new[] { "*", "animation", "comedy", "horror", "other" }, model["genre"]!.AsObject().Select(p => p.Key));

        // No genre colours: no genre entries at all (the old model had null here).
        Assert.Empty(JsonNode.Parse(JsonSerializer.Serialize(TagStyleSet.Empty.ToWebModel()))!["genre"]!.AsObject());
        // A preset alone colours every genre through "*".
        var glass = JsonNode.Parse(JsonSerializer.Serialize(TagStyleSet.Parse(string.Empty, "glass").ToWebModel()))!["genre"]!.AsObject();
        Assert.Equal("*", Assert.Single(glass).Key);
    }

    [Fact]
    public void Documents_without_colours_of_a_single_genre_hand_out_only_the_every_genre_entry()
    {
        // The web suite checks these models still draw 832dffb7's stylesheet byte for byte, genre names included.
        foreach (var entry in Fixture["legacy"]!.AsArray())
        {
            var name = (string)entry!["name"]!;
            var model = JsonNode.Parse(JsonSerializer.Serialize(TagStyleSet.Parse((string)entry["document"]!).ToWebModel()))!;
            Assert.Equal((string)entry["preset"]!, (string)model["preset"]!);
            Assert.True(JsonNode.DeepEquals(entry["genre"], model["genre"]), $"{name}: {model["genre"]!.ToJsonString()}");
            Assert.Equal("*", Assert.Single(model["genre"]!.AsObject()).Key);
        }

        Assert.Equal(9, Fixture["legacy"]!.AsArray().Count);
    }

    [Fact]
    public void A_document_with_the_old_single_genre_label_reads_it_as_the_group_and_draws_the_same()
    {
        // As the per-label editor saved it before each genre had its own label.
        const string old = "{\"v\":2,\"preset\":\"glass\",\"groups\":{\"genre\":{\"border\":\"#00ff00\",\"text\":\"#0000ff\"}},\"labels\":{\"genre:genre\":{\"background\":\"#ff0000\",\"text\":\"#ffffff\"},\"rating:critic\":{\"text\":\"#000000\"}}}";
        var parsed = TagStyleSet.Parse(old, "glass");
        Assert.True(TagStyleSet.TryValidate(old, "glass", out var saved, out var error), error);
        foreach (var set in new[] { parsed, saved, TagStyleSet.Parse(saved.Serialize(), "glass") })
        {
            Assert.False(set.Labels.ContainsKey("genre:genre"));
            Assert.Equal(new TagColors("rgba(255, 0, 0, 1)", "rgba(0, 255, 0, 1)", "rgba(255, 255, 255, 1)"), set.Groups["genre"]);
            foreach (var (label, _) in TagStyleCatalog.Labels(TagStyleKeys.Genre))
            {
                // Label over group: exactly what every genre chip drew from the old label.
                Assert.Equal(new TagColors("rgba(255, 0, 0, 1)", "rgba(0, 255, 0, 1)", "rgba(255, 255, 255, 1)"), set.Resolve("genre", label));
            }

            Assert.Equal("rgba(0, 0, 0, 1)", set.Resolve("rating", "critic").Text);
        }

        Assert.DoesNotContain("genre:genre", saved.Serialize());
        // The old label alone, with no group colours.
        var alone = TagStyleSet.Parse("{\"v\":2,\"labels\":{\"genre:genre\":{\"border\":\"#123456\"}}}");
        Assert.Equal(new TagColors(null, "rgba(18, 52, 86, 1)", null), alone.Groups["genre"]);
        // Still checked like any colour.
        Assert.False(TagStyleSet.TryValidate("{\"v\":2,\"labels\":{\"genre:genre\":{\"background\":\"red;}\"}}}", null, out _, out error));
        Assert.Contains("not a colour", error);
    }

    [Fact]
    public void A_version_1_genre_colour_becomes_the_genre_group()
    {
        const string v1 = "{\"genre\":{\"background\":\"#111111\"},\"quality\":{\"4K\":{\"background\":\"#ff0000\"}}}";
        Assert.True(TagStyleSet.TryValidate(v1, null, out var set, out var error), error);
        Assert.Equal(new TagColors("rgba(17, 17, 17, 1)", "rgba(255, 255, 255, 0.2)", "rgba(224, 224, 224, 1)"), set.Groups["genre"]);
        Assert.DoesNotContain(set.Labels.Keys, k => k.StartsWith("genre:", StringComparison.Ordinal));
        Assert.Equal(set.Groups["genre"], set.Resolve("genre", "horror"));
        Assert.Equal(set.Groups["genre"], TagStyleSet.Parse(v1).Resolve("genre", "other"));
    }

    [Fact]
    public void Documents_without_genre_labels_load_unchanged_and_unknown_genre_labels_are_refused()
    {
        const string plain = "{\"v\":2,\"preset\":\"outline\",\"groups\":{\"genre\":{\"text\":\"rgba(1, 2, 3, 1)\"}},\"labels\":{\"quality:4K\":{\"background\":\"rgba(255, 0, 0, 1)\"}}}";
        Assert.True(TagStyleSet.TryValidate(plain, "outline", out var set, out var error), error);
        Assert.Equal(plain, set.Serialize());
        Assert.Equal(TagStyleSet.Parse(plain, "outline").Hash, set.Hash);

        foreach (var key in new[] { "genre:sci-fi", "genre:nope", "genre:*", "genre:Horror", "genre:" })
        {
            var doc = $"{{\"v\":2,\"labels\":{{\"{key}\":{{\"text\":\"#ffffff\"}}}}}}";
            Assert.False(TagStyleSet.TryValidate(doc, null, out _, out error), key);
            Assert.Contains("unknown label", error);
            Assert.True(TagStyleSet.Parse(doc).IsEmpty, key);
        }

        Assert.True(TagStyleSet.TryValidate("{\"v\":2,\"labels\":{\"genre:science fiction\":{\"text\":\"#ffffff\"},\"genre:game-show\":{\"border\":\"#000000\"}}}", null, out var named, out error), error);
        Assert.Equal(2, named.Labels.Count);
    }

    [Fact]
    public void Every_label_of_every_fixed_group_with_three_fields_fits_the_document_cap()
    {
        // The longest colour the normaliser writes, on every field of every label (custom labels are the
        // administrator's own and share the same cap).
        const string longest = "rgba(255, 255, 255, 0.502)";
        var all = new TagColors(longest, longest, longest);
        var labels = new JsonObject();
        var groups = new JsonObject();
        foreach (var group in TagStyleKeys.Groups)
        {
            groups[group] = Stored(group);
            foreach (var (key, _) in TagStyleCatalog.Labels(group)) labels[group + ":" + key] = Stored(group);
        }

        JsonObject Stored(string group) => TagStyleKeys.FieldApplies(group, "background")
            ? new JsonObject { ["background"] = all.Background, ["border"] = all.Border, ["text"] = all.Text }
            : new JsonObject { ["border"] = all.Border };

        var doc = new JsonObject { ["v"] = 2, ["preset"] = "default", ["groups"] = groups, ["labels"] = labels }.ToJsonString();
        Assert.True(TagStyleSet.TryValidate(doc, null, out var set, out var error), error);
        var stored = set.Serialize();
        var genreOnly = string.Join(",", TagStyleCatalog.Labels(TagStyleKeys.Genre).Select(l => $"\"genre:{l.Key}\":{Stored("genre").ToJsonString()}"));
        output.WriteLine($"Every fixed label and group with three fields: {stored.Length} of {TagStyleSet.MaxDocumentLength} characters, {set.Labels.Count} labels; the {TagStyleCatalog.Labels(TagStyleKeys.Genre).Count} genre labels take {genreOnly.Length}.");
        Assert.True(stored.Length < TagStyleSet.MaxDocumentLength, $"{stored.Length} characters ({genreOnly.Length} for the genre labels)");
        Assert.True(set.Labels.Count < 400, $"{set.Labels.Count} labels");
    }

    [Fact]
    public void Native_posters_draw_each_genre_in_its_own_colours_and_redraw_when_one_changes()
    {
        var set = FixtureSet();
        foreach (var c in Fixture["cases"]!.AsArray())
        {
            var expected = c!["drawn"]!;
            Assert.True(CssColor.TryParse((string)expected["background"]!, out var background));
            var fill = Over(background, SKColors.Black);
            Assert.True(Count(GenrePixels((string)c["genre"]!, set), fill) > 20, $"{c["genre"]}: no {fill} circle");
        }

        // Two genres of one poster in different colours.
        var both = GenrePixels(new[] { "Horror", "Comedy" }, set);
        Assert.True(Count(both, new SKColor(198, 40, 40)) > 20);
        Assert.True(Count(both, new SKColor(255, 209, 102)) > 20);

        // The tile cache keys on the resolved colours: a changed genre colour draws new pixels, as an uncached render does.
        using var cached = new PosterTagRenderer(1L << 20);
        using var uncached = new PosterTagRenderer(0);
        SKColor[]? previous = null;
        foreach (var colour in new[] { "#c62828", "#1e88e5", "#c62828" })
        {
            var styles = TagStyleSet.Parse($"{{\"v\":2,\"labels\":{{\"genre:horror\":{{\"background\":\"{colour}\"}}}}}}");
            using var actual = Render(cached, new[] { "Horror" }, styles);
            using var expected = Render(uncached, new[] { "Horror" }, styles);
            Assert.Equal(expected.Pixels, actual.Pixels);
            if (previous is not null) Assert.False(previous.SequenceEqual(actual.Pixels));
            previous = actual.Pixels;
        }

        Assert.Equal(2, cached.TileCacheCount);
    }

    [Fact]
    public void Native_settings_digest_changes_with_a_genre_label_colour()
    {
        string Digest(string overrides) => PosterTagSettings.Create(null, new PluginConfiguration
        {
            TagStylesEnabled = true,
            TagStyleTarget = "both",
            TagStyleOverrides = overrides,
        }).Digest;
        Assert.NotEqual(Digest("{\"v\":2,\"labels\":{\"genre:horror\":{\"background\":\"#ff0000\"}}}"), Digest("{\"v\":2,\"labels\":{\"genre:horror\":{\"background\":\"#0000ff\"}}}"));
        Assert.NotEqual(Digest("{\"v\":2,\"labels\":{\"genre:horror\":{\"background\":\"#ff0000\"}}}"), Digest("{\"v\":2,\"labels\":{\"genre:comedy\":{\"background\":\"#ff0000\"}}}"));
    }

    private static SKColor Over(SKColor top, SKColor under)
    {
        double a = top.Alpha / 255.0;
        byte Mix(byte t, byte u) => (byte)Math.Round((t * a) + (u * (1 - a)));
        return new SKColor(Mix(top.Red, under.Red), Mix(top.Green, under.Green), Mix(top.Blue, under.Blue));
    }

    private static int Count(SKColor[] pixels, SKColor colour) =>
        pixels.Count(p => Math.Abs(p.Red - colour.Red) <= 2 && Math.Abs(p.Green - colour.Green) <= 2 && Math.Abs(p.Blue - colour.Blue) <= 2);

    private static SKColor[] GenrePixels(string genre, TagStyleSet styles) => GenrePixels(new[] { genre }, styles);

    private static SKColor[] GenrePixels(string[] genres, TagStyleSet styles)
    {
        using var renderer = new PosterTagRenderer();
        using var drawn = Render(renderer, genres, styles);
        return drawn.Pixels;
    }

    private static SKBitmap Render(PosterTagRenderer renderer, string[] genres, TagStyleSet styles)
    {
        var tags = new List<PosterTagGroupLayout> { new(PosterTagGroup.Genre, PosterTagCorner.TopRight, GenreIcons.Resolve(genres)!) };
        using var source = new SKBitmap(180, 270);
        source.Erase(SKColors.Black);
        return renderer.Render(source, new PosterTagLayout(tags, false, false, styles))!;
    }
}
