using System.Xml.Serialization;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags;
using Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags.Rendering;
using Newtonsoft.Json;

namespace JE.Tests;

/// <summary>The corners layout's edge spacing: settings, validation, digest and the native planner per anchor.</summary>
public class PosterEdgeSpacingTests
{
    private static readonly PosterTagCorner[] Anchors =
    {
        PosterTagCorner.TopLeft, PosterTagCorner.TopCenter, PosterTagCorner.TopRight,
        PosterTagCorner.CenterLeft, PosterTagCorner.Center, PosterTagCorner.CenterRight,
        PosterTagCorner.BottomLeft, PosterTagCorner.BottomCenter, PosterTagCorner.BottomRight,
    };

    [Fact]
    public void Flush_edges_match_browser_at_every_anchor_with_indicators_and_progress()
    {
        using var json = System.Text.Json.JsonDocument.Parse(typeof(PosterEdgeSpacingTests).Assembly.GetManifestResourceStream("FlushEdges.json")!);
        using var renderer = new PosterTagRenderer();
        var anchors = new Dictionary<string, PosterTagCorner> {
            ["tl"] = PosterTagCorner.TopLeft, ["tc"] = PosterTagCorner.TopCenter, ["tr"] = PosterTagCorner.TopRight,
            ["ml"] = PosterTagCorner.CenterLeft, ["c"] = PosterTagCorner.Center, ["mr"] = PosterTagCorner.CenterRight,
            ["bl"] = PosterTagCorner.BottomLeft, ["bc"] = PosterTagCorner.BottomCenter, ["br"] = PosterTagCorner.BottomRight };
        foreach (var row in json.RootElement.EnumerateArray())
        {
            var slot = row.GetProperty("slot").GetString()!;
            var layout = new PosterTagLayout([new(PosterTagGroup.Quality, anchors[slot], [new QualityTag("4K", "resolution")])],
                row.GetProperty("indicator").GetBoolean(), false) { EdgeInset = 0, ProgressBarHeight = row.GetProperty("progress").GetInt32() };
            var plan = renderer.Plan(180, 270, layout);
            var item = Assert.Single(Assert.Single(plan.Groups).Items);
            Assert.Equal(row.GetProperty("edges").GetInt32(), (int)item.FlushEdges);
            if (slot == "tc") Assert.Equal(0, item.Y);
            if (slot == "bc") Assert.Equal(270 - layout.ProgressBarHeight, item.Y + item.Height, 3);
        }
    }

    [Fact]
    public void Flush_top_center_uses_indicator_gap_and_falls_back_only_for_a_wide_first_chip()
    {
        using var renderer = new PosterTagRenderer();
        var layout = new PosterTagLayout([new(PosterTagGroup.Quality, PosterTagCorner.TopCenter,
            [new QualityTag("WWWWWWWWWW", "audioInfo")])], true, false) { EdgeInset = 0 };
        var plan = renderer.Plan(180, 270, layout);
        var item = Assert.Single(Assert.Single(plan.Groups).Items);
        Assert.False(item.Hidden);
        Assert.True(item.Y > 0);
        Assert.False(item.FlushEdges.HasFlag(FlushEdges.Top));
    }

    [Fact]
    public void Flush_mixed_height_rows_align_every_chip_to_the_touching_edge()
    {
        using var renderer = new PosterTagRenderer();
        foreach (var corner in new[] { PosterTagCorner.TopCenter, PosterTagCorner.BottomCenter })
        {
            var layout = new PosterTagLayout([
                new(PosterTagGroup.Quality, corner, [new QualityTag("4K", "resolution")]),
                new(PosterTagGroup.Status, corner, [new StatusTag("added", "Added", "added")])], false, false) { EdgeInset = 0 };
            var items = renderer.Plan(180, 270, layout).Groups.SelectMany(g => g.Items).ToList();
            Assert.Equal(2, items.Count);
            Assert.NotEqual(items[0].Height, items[1].Height);
            foreach (var item in items)
            {
                if (corner == PosterTagCorner.TopCenter) Assert.Equal(0, item.Y);
                else Assert.Equal(270, item.Y + item.Height, 3);
            }
        }
    }

    [Theory]
    [InlineData(null, null)]
    [InlineData("default", "default")]
    [InlineData(" Tight ", "tight")]
    [InlineData("FLUSH", "flush")]
    [InlineData("", "default")]
    [InlineData("wide", "default")]
    public void Edge_spacing_normalizes_unknown_values_to_default_and_keeps_null(string? raw, string? expected)
    {
        Assert.Equal(expected, TagLayoutRules.NormalizeEdgeSpacing(raw));
        var user = new JellyfinEnhancedUserSettings { TagEdgeSpacing = raw };
        TagLayoutRules.Normalize(user);
        Assert.Equal(expected, user.TagEdgeSpacing);
    }

    [Theory]
    [InlineData("default", 6f)]
    [InlineData("tight", 3f)]
    [InlineData("flush", 0f)]
    [InlineData("bogus", 6f)]
    [InlineData(null, 6f)]
    public void Edge_inset_per_value(string? edge, float inset) => Assert.Equal(inset, TagLayoutRules.EdgeInset(edge));

    [Fact]
    public void New_documents_inherit_and_admin_defaults_seed_the_edge()
    {
        Assert.Null(new JellyfinEnhancedUserSettings().TagEdgeSpacing);
        Assert.Equal("default", new PluginConfiguration().TagEdgeSpacing);
        var seeded = new JellyfinEnhancedUserSettings();
        TagLayoutRules.ApplyDefaults(seeded, new PluginConfiguration { TagEdgeSpacing = "Flush" });
        Assert.Equal("flush", seeded.TagEdgeSpacing);
        Assert.Equal(TagLayoutRules.CurrentVersion, seeded.TagLayoutSettingsVersion);
        TagLayoutRules.ApplyDefaults(seeded, new PluginConfiguration { TagEdgeSpacing = "nonsense" });
        Assert.Equal("default", seeded.TagEdgeSpacing);
    }

    [Fact]
    public void Edge_spacing_round_trips_through_the_user_store_and_the_admin_xml()
    {
        var user = new JellyfinEnhancedUserSettings { TagLayoutSettingsVersion = 1, TagEdgeSpacing = "tight" };
        var copy = JsonConvert.DeserializeObject<JellyfinEnhancedUserSettings>(JsonConvert.SerializeObject(user))!;
        Assert.Equal("tight", copy.TagEdgeSpacing);

        var serializer = new XmlSerializer(typeof(PluginConfiguration));
        using var writer = new StringWriter();
        serializer.Serialize(writer, new PluginConfiguration { TagEdgeSpacing = "flush" });
        using var reader = new StringReader(writer.ToString());
        Assert.Equal("flush", ((PluginConfiguration)serializer.Deserialize(reader)!).TagEdgeSpacing);
    }

    [Fact]
    public void Native_settings_take_the_users_edge_else_the_admins_and_legacy_documents_stay_default()
    {
        var admin = new PluginConfiguration { TagEdgeSpacing = "flush" };
        Assert.Equal("flush", PosterTagSettings.FromUserSettings(new JellyfinEnhancedUserSettings { TagLayoutSettingsVersion = 1 }, admin).EdgeSpacing);
        Assert.Equal("tight", PosterTagSettings.FromUserSettings(new JellyfinEnhancedUserSettings { TagLayoutSettingsVersion = 1, TagEdgeSpacing = "tight" }, admin).EdgeSpacing);
        Assert.Equal("default", PosterTagSettings.FromUserSettings(new JellyfinEnhancedUserSettings { TagLayoutSettingsVersion = 1, TagEdgeSpacing = "default" }, admin).EdgeSpacing);
        // A document saved before layouts keeps the inset it always had, whatever the administrator picks.
        var legacy = PosterTagSettings.FromUserSettings(new JellyfinEnhancedUserSettings { TagLayoutSettingsVersion = 0, TagEdgeSpacing = "flush" }, admin);
        Assert.Equal("default", legacy.EdgeSpacing);
        Assert.Equal(6f, legacy.EdgeInset);
    }

    [Fact]
    public void Digest_is_unchanged_at_the_default_and_changes_per_edge()
    {
        var config = new PluginConfiguration();
        PosterTagSettings Digest(string? edge) => PosterTagSettings.FromUserSettings(
            new JellyfinEnhancedUserSettings { TagLayoutSettingsVersion = 1, QualityTagsEnabled = true, TagEdgeSpacing = edge }, config);
        var none = Digest(null).Digest;
        Assert.Equal(none, Digest("default").Digest);
        Assert.NotEqual(none, Digest("tight").Digest);
        Assert.NotEqual(none, Digest("flush").Digest);
        Assert.NotEqual(Digest("tight").Digest, Digest("flush").Digest);
    }

    [Fact]
    public void Resolver_hands_the_inset_to_the_layout()
    {
        var settings = PosterTagSettings.FromUserSettings(
            new JellyfinEnhancedUserSettings { TagLayoutSettingsVersion = 1, RatingTagsEnabled = true, TagEdgeSpacing = "flush" }, new PluginConfiguration());
        var entry = new Jellyfin.Plugin.JellyfinEnhanced.Model.TagCacheEntry { Type = "Movie", CommunityRating = 8.1f };
        var layout = PosterTagResolver.Resolve(entry, settings, new PosterTagItemContext("Movie", false, null, null, null), false);
        Assert.NotNull(layout);
        Assert.Equal(0f, layout!.EdgeInset);
    }

    [Theory]
    [InlineData(6f)]
    [InlineData(3f)]
    [InlineData(0f)]
    public void Native_planner_puts_every_anchor_at_the_edge_inset(float inset)
    {
        using var assets = PosterTagAssets.Load();
        using var text = new PosterTagText(assets.TextTypeface);
        var planner = new PosterTagPlanner(assets, text);
        foreach (var anchor in Anchors)
        foreach (var scale in new[] { "smaller", "default", "largest" })
        foreach (var gap in new[] { "tight", "default", "roomy" })
        {
            var layout = new PosterTagLayout([new(PosterTagGroup.Rating, anchor, [new RatingTag(PosterRatingSource.Community, "8.1", false)])], false, false) { EdgeInset = inset, TagScale = scale, TagGap = gap };
            var plan = planner.Plan(180, 270, layout);
            var chip = Assert.Single(Assert.Single(plan.Groups).Items);
            Assert.False(chip.Hidden);
            bool left = anchor is PosterTagCorner.TopLeft or PosterTagCorner.CenterLeft or PosterTagCorner.BottomLeft;
            bool right = anchor is PosterTagCorner.TopRight or PosterTagCorner.CenterRight or PosterTagCorner.BottomRight;
            bool top = anchor is PosterTagCorner.TopLeft or PosterTagCorner.TopCenter or PosterTagCorner.TopRight;
            bool bottom = anchor is PosterTagCorner.BottomLeft or PosterTagCorner.BottomCenter or PosterTagCorner.BottomRight;
            if (left) Assert.Equal(inset, chip.X, 3);
            if (right) Assert.Equal(plan.CardWidth - inset, chip.X + chip.Width, 3);
            if (top) Assert.Equal(inset, chip.Y, 3);
            if (bottom) Assert.Equal(plan.CardHeight - inset, chip.Y + chip.Height, 3);
            Assert.InRange(chip.X, 0, plan.CardWidth - chip.Width);
            Assert.InRange(chip.Y, 0, plan.CardHeight - chip.Height);
        }
    }

    [Theory]
    [InlineData(6f)]
    [InlineData(0f)]
    public void Indicator_offset_follows_the_inset(float inset)
    {
        using var assets = PosterTagAssets.Load();
        using var text = new PosterTagText(assets.TextTypeface);
        var planner = new PosterTagPlanner(assets, text);
        var layout = new PosterTagLayout([new(PosterTagGroup.Rating, PosterTagCorner.TopRight, [new RatingTag(PosterRatingSource.Community, "8.1", false)])], true, false) { EdgeInset = inset };
        var chip = Assert.Single(Assert.Single(planner.Plan(180, 270, layout).Groups).Items);
        Assert.Equal(inset + 30f, chip.Y, 3);
    }

    [Fact]
    public void Default_inset_plans_exactly_as_before()
    {
        using var assets = PosterTagAssets.Load();
        using var text = new PosterTagText(assets.TextTypeface);
        var planner = new PosterTagPlanner(assets, text);
        foreach (var anchor in Anchors)
        {
            var groups = new List<PosterTagGroupLayout> { new(PosterTagGroup.Rating, anchor, [new RatingTag(PosterRatingSource.Community, "8.1", false)]) };
            var implicitDefault = planner.Plan(300, 450, new PosterTagLayout(groups, false, false)).Describe();
            var explicitDefault = planner.Plan(300, 450, new PosterTagLayout(groups, false, false) { EdgeInset = 6f }).Describe();
            Assert.Equal(implicitDefault, explicitDefault);
        }
    }
    [Theory]
    [InlineData("tight", 3f)]
    [InlineData("flush", 0f)]
    public void Combined_settings_keep_fixed_inset_scaled_indicator_and_distinct_digests(string edge, float inset)
    {
        var config = new PluginConfiguration();
        var user = new JellyfinEnhancedUserSettings { TagLayoutSettingsVersion = 1, TagEdgeSpacing = edge,
            TagScale = "largest", TagGap = "roomy", RatingTagsEnabled = true };
        var settings = PosterTagSettings.FromUserSettings(user, config);
        using var renderer = new PosterTagRenderer();
        var layout = new PosterTagLayout([new(PosterTagGroup.Rating, PosterTagCorner.TopRight,
            [new RatingTag(PosterRatingSource.Community, "8.1", false)])], true, false)
            { EdgeInset = settings.EdgeInset, TagScale = settings.TagScale, TagGap = settings.TagGap };
        var plan = renderer.Plan(180, 270, layout);
        var chip = Assert.Single(Assert.Single(plan.Groups).Items);
        Assert.Equal(inset + 30 * 1.3f, chip.Y, 3);
        Assert.Equal(plan.CardWidth - inset, chip.X + chip.Width, 3);
        user.TagEdgeSpacing = "default";
        var baseline = PosterTagSettings.FromUserSettings(user, config).Digest;
        Assert.NotEqual(baseline, settings.Digest);
        user.TagGap = "tight";
        Assert.NotEqual(baseline, PosterTagSettings.FromUserSettings(user, config).Digest);
        user.TagLayout = "bands";
        user.TagEdgeSpacing = edge;
        var bands = PosterTagResolver.Resolve(new() { Type = "Movie", CommunityRating = 8.1f },
            PosterTagSettings.FromUserSettings(user, config), new("Movie", false, null, null, null), false)!;
        Assert.True(bands.Bands);
        Assert.Equal(6f, bands.EdgeInset); // Bands keeps its own web padding, regardless of Corners spacing.
        var bandPlan = renderer.Plan(180, 270, bands);
        Assert.All(bandPlan.Groups.SelectMany(g => g.Items), item => Assert.InRange(item.X, 6, 174 - item.Width + 0.01f));
    }

}
