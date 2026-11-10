using System.Text.Json;
using System.Text.Json.Nodes;
using System.Xml.Serialization;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Features.MediaTags.PosterTags.Rendering;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.MediaTags;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.MediaTags.PosterTags;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.Settings;
using Jellyfin.Plugin.JellyfinEnhanced.Transport;
using Newtonsoft.Json.Linq;
using SkiaSharp;

namespace JE.Tests.Features.MediaTags;

/// <summary>
/// Per-tag-kind opacity and size (the Media Tags request "let me set the transparency and the size of each tag
/// independently"): TagKindLooks on the administrator's configuration (defaults) and on each user's document (their
/// own values, per kind and per value), validated and clamped on every way in, carried by export and import, and
/// drawn on native posters. 100/100 is today's look.
/// </summary>
public class CoreTagKindLooksTests
{
    private static TagKindLook Look(string kind, int? opacity = null, int? scale = null) => new() { Kind = kind, Opacity = opacity, Scale = scale };

    private static string Describe(List<TagKindLook>? looks) => looks == null ? "null"
        : string.Join(",", looks.Select(l => $"{l.Kind}:{l.Opacity?.ToString() ?? "-"}:{l.Scale?.ToString() ?? "-"}"));

    [Fact]
    public void ValuesAreClampedAndOnlyWellFormedKindsAreKept()
    {
        Assert.Equal((10, 100, 50, 200), (TagLayoutRules.MinKindOpacity, TagLayoutRules.MaxKindOpacity, TagLayoutRules.MinKindScale, TagLayoutRules.MaxKindScale));
        var normalized = TagLayoutRules.NormalizeKindLooks(new List<TagKindLook>
        {
            Look("resolution", 0, 900),
            Look(" genre ", 250, 10),
            Look("resolution", 70),          // a second entry for a kind: the first wins
            Look("status"),                  // nothing set: dropped
            Look("x\"] { color: red } [y", 50),
            Look(string.Empty, 50),
            Look("audio", 55, 135),
            null!,
        });
        Assert.Equal("resolution:10:200,genre:100:50,audio:55:135", Describe(normalized));
        Assert.Null(TagLayoutRules.NormalizeKindLooks(new List<TagKindLook> { Look("status") }));
        Assert.Null(TagLayoutRules.NormalizeKindLooks(null));
        // Bounded: never more entries than there could be kinds.
        var many = Enumerable.Range(0, 500).Select(i => Look($"kind{i}", 50)).ToList();
        Assert.Equal(TagLayoutRules.MaxKindLooks, TagLayoutRules.NormalizeKindLooks(many)!.Count);
    }

    [Fact]
    public void AUsersOwnValueWinsPerKindAndPerValueOverTheAdministratorsDefaults()
    {
        var config = new PluginConfiguration { TagKindLooks = new List<TagKindLook> { Look("resolution", 60, 150), Look("genre", scale: 120) } };
        var user = new JellyfinEnhancedUserSettings { TagLayoutSettingsVersion = 1, TagKindLooks = new List<TagKindLook> { Look("resolution", opacity: 90), Look("audio", 40) } };
        var looks = TagLayoutRules.EffectiveKindLooks(user, config);
        Assert.Equal(new TagKindLookValue(90, 150), looks["resolution"]);
        Assert.Equal(new TagKindLookValue(100, 120), looks["genre"]);
        Assert.Equal(new TagKindLookValue(40, 100), looks["audio"]);
        Assert.False(looks.ContainsKey("videoCodec"));
        // An explicit 100 is the user's own choice, so the administrator's value no longer applies.
        user.TagKindLooks = new List<TagKindLook> { Look("resolution", 100, 100) };
        Assert.False(TagLayoutRules.EffectiveKindLooks(user, config).ContainsKey("resolution"));
        // A document saved before layouts keeps the look it always had.
        Assert.Empty(TagLayoutRules.EffectiveKindLooks(new JellyfinEnhancedUserSettings { TagKindLooks = user.TagKindLooks }, config));
        // Nothing set anywhere: nothing changes.
        Assert.Empty(TagLayoutRules.EffectiveKindLooks(new JellyfinEnhancedUserSettings { TagLayoutSettingsVersion = 1 }, new PluginConfiguration()));
    }

    [Fact]
    public void StoredDocumentsRoundTripAndNewUsersStartFromTheAdministratorsValues()
    {
        var config = new PluginConfiguration { TagKindLooks = new List<TagKindLook> { Look("resolution", 60, 150), Look("language", 40) } };
        using var writer = new StringWriter();
        new XmlSerializer(typeof(PluginConfiguration)).Serialize(writer, config);
        using var reader = new StringReader(writer.ToString());
        var restored = (PluginConfiguration)new XmlSerializer(typeof(PluginConfiguration)).Deserialize(reader)!;
        Assert.Equal("resolution:60:150,language:40:-", Describe(restored.TagKindLooks));

        var seeded = new JellyfinEnhancedUserSettings();
        TagLayoutRules.ApplyDefaults(seeded, restored);
        Assert.Equal("resolution:60:150,language:40:-", Describe(seeded.TagKindLooks));

        // The client saves camel-cased JSON; the stored document reads back the same values.
        var json = """{"tagLayoutSettingsVersion":1,"tagKindLooks":[{"kind":"resolution","opacity":5,"scale":160},{"kind":"genre","scale":80}]}""";
        var user = JsonSerializer.Deserialize<JellyfinEnhancedUserSettings>(json, new JsonSerializerOptions(JsonSerializerDefaults.Web))!;
        TagLayoutRules.Normalize(user);
        Assert.Equal("resolution:10:160,genre:-:80", Describe(user.TagKindLooks));
        var again = JsonSerializer.Deserialize<JellyfinEnhancedUserSettings>(JsonSerializer.Serialize(user))!;
        Assert.Equal(Describe(user.TagKindLooks), Describe(again.TagKindLooks));
    }

    [Fact]
    public void TheSettingsDocumentSaveStoresThemMatchedByKind()
    {
        // The hub saves through the revisioned settings document (POST user-settings/{id}/settings-document).
        const string user = "abcdefabcdefabcdefabcdefabcdef01";
        using var f = new JE.Tests.CoreFixture();
        // A stored entry may carry a member this version does not know: it stays with its kind, wherever the kind moves.
        f.Write(user, "{\"TagLayoutSettingsVersion\":1,\"TagKindLooks\":[{\"Kind\":\"audio\",\"Opacity\":40,\"Future\":1},{\"Kind\":\"resolution\",\"Scale\":150}]}");
        var service = new SettingsDocumentService(f.Manager);
        var loaded = service.Read(user, () => new JellyfinEnhancedUserSettings(), false);
        Assert.Equal("audio:40:-,resolution:-:150", Describe(loaded.Settings.TagKindLooks));

        loaded.Settings.TagKindLooks = new List<TagKindLook> { Look("resolution", 100, 180), Look("audio", 50, 70), Look("language", 50, 70) };
        Assert.True(service.TrySave(user, new RevisionedSettingsRequest { Revision = loaded.Revision, Settings = loaded.Settings }, false, out var saved));
        Assert.Equal("resolution:100:180,audio:50:70,language:50:70", Describe(saved!.Settings.TagKindLooks));
        var raw = (JObject)f.Manager.ReadUserConfigurationDocument(user, "settings.json").Document!;
        var audio = raw["TagKindLooks"]!.Children<JObject>().Single(e => (string?)e["Kind"] == "audio");
        Assert.Equal(1, (int)audio["Future"]!);
        Assert.Null(raw["TagKindLooks"]!.Children<JObject>().Single(e => (string?)e["Kind"] == "resolution")["Future"]);
    }

    [Fact]
    public void TheAdministratorPageOwnsTheFieldAndItsPatchRefusesValuesOutOfRange()
    {
        Assert.Contains("TagKindLooks", MediaTagsPageFields.Allowed);
        Assert.True(MediaTagsPageFields.TryNormalize("TagKindLooks", null, out var none, out _));
        Assert.Null(none);
        Assert.True(MediaTagsPageFields.TryNormalize("TagKindLooks", new List<TagKindLook> { Look("resolution", 50, 150), Look("audio", scale: 80) }, out var ok, out var error), error);
        Assert.Equal("resolution:50:150,audio:-:80", Describe((List<TagKindLook>?)ok));
        foreach (var bad in new[] { Look("resolution", 5), Look("resolution", scale: 300), Look("x y", 50) })
        {
            Assert.False(MediaTagsPageFields.TryNormalize("TagKindLooks", new List<TagKindLook> { bad }, out _, out error), Describe(new List<TagKindLook> { bad }));
            Assert.NotNull(error);
        }
        Assert.False(MediaTagsPageFields.TryNormalize("TagKindLooks", new List<TagKindLook> { Look("genre", 50), Look("genre", 60) }, out _, out _));

        // The JSON the page sends (PascalCase, as it writes every object), through the patch's own reader.
        var property = typeof(PluginConfiguration).GetProperty(nameof(PluginConfiguration.TagKindLooks))!;
        Assert.True(PluginConfigurationPatch.TryRead(property, JsonDocument.Parse("""[{"Kind":"resolution","Opacity":50,"Scale":150},{"Kind":"audio","Scale":80}]""").RootElement, out var read, out error), error);
        Assert.Equal("resolution:50:150,audio:-:80", Describe((List<TagKindLook>?)read));
        // Anything else is refused, never stored as an empty or out-of-range entry.
        Assert.False(PluginConfigurationPatch.TryRead(property, JsonDocument.Parse("""[{"kind":"resolution","opacity":50}]""").RootElement, out _, out _));
        Assert.False(PluginConfigurationPatch.TryRead(property, JsonDocument.Parse("""[{"Kind":"resolution","Scale":1000}]""").RootElement, out _, out _));
    }

    [Fact]
    public void ExportAndImportCarryTheValuesAndRefuseInvalidOnes()
    {
        var source = new JellyfinEnhancedUserSettings
        {
            TagLayoutSettingsVersion = 1,
            TagKindLooks = new List<TagKindLook> { Look("resolution", 100, 150), Look("audio", 50, 80), Look("language", 50, 80) },
        };
        Assert.Contains("TagKindLooks", MediaTagsPortable.UserFields);
        var exported = MediaTagsPortable.ExportUser(source);
        var settings = exported["settings"]!.AsObject();
        Assert.Equal(3, settings["TagKindLooks"]!.AsArray().Count);

        var preview = MediaTagsPortable.PreviewUser(JsonDocument.Parse(exported.ToJsonString()).RootElement.Clone(), new JellyfinEnhancedUserSettings { TagLayoutSettingsVersion = 1 });
        Assert.Empty(preview.Skipped);
        var change = Assert.Single(preview.Changes, c => c.Field == "TagKindLooks");
        Assert.True(JsonNode.DeepEquals(settings["TagKindLooks"], change.To));

        // Out of range or malformed: reported, never applied.
        settings["TagKindLooks"] = JsonNode.Parse("""[{"Kind":"resolution","Opacity":0}]""");
        var invalid = MediaTagsPortable.PreviewUser(JsonDocument.Parse(exported.ToJsonString()).RootElement.Clone(), new JellyfinEnhancedUserSettings());
        var skipped = Assert.Single(invalid.Skipped, s => s.Field == "TagKindLooks");
        Assert.Equal("invalid", skipped.Reason);
        Assert.DoesNotContain(invalid.Changes, c => c.Field == "TagKindLooks");
    }

    [Fact]
    public void NativePostersGetTheSameValuesWithLegacyDocumentsKeepingTheirLook()
    {
        var config = new PluginConfiguration { TagKindLooks = new List<TagKindLook> { Look("resolution", 60, 150) } };
        var legacy = PosterTagSettings.FromSettingsJson("{qualityTagsEnabled:true}", config);
        var inherited = PosterTagSettings.FromSettingsJson("{qualityTagsEnabled:true,tagLayoutSettingsVersion:1}", config);
        var own = PosterTagSettings.FromSettingsJson("{qualityTagsEnabled:true,tagLayoutSettingsVersion:1,tagKindLooks:[{kind:'resolution',opacity:100,scale:120}]}", config);
        var plain = PosterTagSettings.FromSettingsJson("{qualityTagsEnabled:true,tagLayoutSettingsVersion:1}", new PluginConfiguration());
        Assert.Empty(legacy.KindLooks);
        Assert.Equal(new TagKindLookValue(60, 150), inherited.KindLooks["resolution"]);
        Assert.Equal(new TagKindLookValue(100, 120), own.KindLooks["resolution"]);
        Assert.Empty(plain.KindLooks);
        // Cached posters are told apart, and nobody's existing token changes until a value is set.
        Assert.NotEqual(inherited.Digest, own.Digest);
        Assert.NotEqual(plain.Digest, inherited.Digest);
        Assert.Equal(PosterTagSettings.FromSettingsJson("{qualityTagsEnabled:true,tagLayoutSettingsVersion:1,tagKindLooks:[{kind:'resolution',opacity:100,scale:100}]}", new PluginConfiguration()).Digest, plain.Digest);
    }

    [Fact]
    public void NativeDefaultsArePixelIdenticalAndOneKindChangesAlone()
    {
        using var source = new SKBitmap(360, 540);
        source.Erase(SKColors.DarkSlateBlue);
        using var renderer = new PosterTagRenderer();
        using var cold = new PosterTagRenderer(0);
        using var baseline = renderer.Render(source, Layout());
        var everyKindAtDefault = new[] { "resolution", "videoCodec", "audio", "rating", "language", "awards" }.ToDictionary(k => k, _ => new TagKindLookValue(100, 100));
        using var explicitDefaults = renderer.Render(source, Layout() with { KindLooks = everyKindAtDefault });
        Assert.Equal(baseline!.Pixels, explicitDefaults!.Pixels);

        // Resolution at 150% and audio at 50% opacity: only those chips change.
        var looks = new Dictionary<string, TagKindLookValue> { ["resolution"] = new(100, 150), ["audio"] = new(50, 100) };
        var before = renderer.Plan(360, 540, Layout());
        var after = renderer.Plan(360, 540, Layout() with { KindLooks = looks });
        PlannedItem Item(PosterTagPlan plan, string label) => plan.Groups.SelectMany(g => g.Items).Single(i => i.Tag is QualityTag q && q.Label == label);
        Assert.Equal(before.Css.QualityFontSize * 1.5f, Item(after, "4K").Css.QualityFontSize, 3);
        Assert.True(Item(after, "4K").Height > Item(before, "4K").Height);
        Assert.Equal(1f, Item(after, "4K").Opacity);
        Assert.Equal(Item(before, "HEVC").Css.QualityFontSize, Item(after, "HEVC").Css.QualityFontSize);
        Assert.Equal(Item(before, "HEVC").Width, Item(after, "HEVC").Width);
        Assert.Equal(1f, Item(after, "HEVC").Opacity);
        Assert.Equal(Item(before, "ATMOS").Width, Item(after, "ATMOS").Width);
        Assert.Equal(0.5f, Item(after, "ATMOS").Opacity);
        // Other groups keep their metrics and stacking (the global size and gap are unchanged).
        var rating = after.Groups.Single(g => g.Group == PosterTagGroup.Rating);
        Assert.Equal(before.Groups.Single(g => g.Group == PosterTagGroup.Rating).Items[0].Width, rating.Items[0].Width);
        Assert.Equal(before.Groups.Single(g => g.Group == PosterTagGroup.Quality).Gap, after.Groups.Single(g => g.Group == PosterTagGroup.Quality).Gap);
        // Chips of one stack never overlap, whatever their sizes, and stay on the poster.
        foreach (var group in after.Groups)
        {
            for (var i = 1; i < group.Items.Count; i++) Assert.True(group.Items[i].Y >= group.Items[i - 1].Y + group.Items[i - 1].Height, $"{group.Group} item {i}");
            Assert.All(group.Items, item => Assert.True(item.X >= 0 && item.Y >= 0 && item.X + item.Width <= after.CardWidth + 0.01f && item.Y + item.Height <= after.CardHeight + 0.01f));
        }

        using var styled = renderer.Render(source, Layout() with { KindLooks = looks });
        using var coldStyled = cold.Render(source, Layout() with { KindLooks = looks });
        Assert.Equal(coldStyled!.Pixels, styled!.Pixels);
        Assert.False(baseline.Pixels.SequenceEqual(styled.Pixels));
    }

    [Fact]
    public void NativeOpacityLetsThePosterShowThrough()
    {
        using var source = new SKBitmap(360, 540);
        source.Erase(SKColors.White);
        using var renderer = new PosterTagRenderer();
        var only = new PosterTagLayout([new(PosterTagGroup.Quality, PosterTagCorner.TopLeft, [new QualityTag("4K", "resolution")])], false, false);
        var plan = renderer.Plan(360, 540, only);
        var chip = plan.Groups[0].Items[0];
        int cx = (int)((chip.X + chip.Width / 2) * plan.Scale), cy = (int)((chip.Y + 2) * plan.Scale);
        using var solid = renderer.Render(source, only);
        using var half = renderer.Render(source, only with { KindLooks = new Dictionary<string, TagKindLookValue> { ["resolution"] = new(50, 100) } });
        var a = solid!.GetPixel(cx, cy);
        var b = half!.GetPixel(cx, cy);
        // Halfway between the chip's colour and the white poster.
        Assert.InRange(b.Red, (a.Red + 255) / 2 - 3, (a.Red + 255) / 2 + 3);
        Assert.InRange(b.Green, (a.Green + 255) / 2 - 3, (a.Green + 255) / 2 + 3);
        Assert.InRange(b.Blue, (a.Blue + 255) / 2 - 3, (a.Blue + 255) / 2 + 3);
    }

    private static PosterTagLayout Layout() => new([
        new(PosterTagGroup.Quality, PosterTagCorner.TopLeft, [new QualityTag("4K", "resolution"), new QualityTag("HEVC", "videoCodec"), new QualityTag("ATMOS", "audioInfo")]),
        new(PosterTagGroup.Rating, PosterTagCorner.BottomRight, [new RatingTag(PosterRatingSource.Community, "8.1", true)]),
        new(PosterTagGroup.Language, PosterTagCorner.BottomLeft, [new LanguageTag("gb", "English", false)]),
        new(PosterTagGroup.Awards, PosterTagCorner.TopRight, [new AwardTag("imdbTop250", "Top 250")]),
    ], false, false);
}
