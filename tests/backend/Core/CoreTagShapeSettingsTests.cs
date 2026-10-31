using System.Security.Claims;
using System.Text.Json;
using System.Xml.Serialization;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Session;
using Microsoft.AspNetCore.Mvc;
using Moq;

namespace JE.Tests;

[Collection("Plugin singleton")]
public class CoreTagShapeSettingsTests
{
    private static List<TagLayoutGroupSlot> Slots(params (string Group, string Slot)[] entries) =>
        entries.Select(e => new TagLayoutGroupSlot { Group = e.Group, Slot = e.Slot }).ToList();

    /// <summary>The "Use recommended" episode thumbnail look the hub writes.</summary>
    private static TagShapeLook Landscape() => new()
    {
        Layout = "bands",
        Density = "compact",
        Slots = Slots(("status", "top"), ("ageRating", "top"), ("quality", "bottom"), ("rating", "bottom"), ("language", "off"), ("genre", "off")),
    };

    [Fact]
    public void NewDocumentsAndAdminDefaultsInheritTheDefaultLookOnEveryShape()
    {
        Assert.Null(new JellyfinEnhancedUserSettings().TagShapeOverrides);
        Assert.Null(new PluginConfiguration().TagShapeOverrides);
        var user = new JellyfinEnhancedUserSettings();
        TagShapeRules.Normalize(user);
        Assert.Null(user.TagShapeOverrides);
    }

    [Fact]
    public void ShapeLooksDropUnknownLayoutsDensitiesGroupsAndSlotsAndClampCaps()
    {
        var normalized = TagShapeRules.Normalize(new TagShapeOverrides
        {
            Landscape = new TagShapeLook
            {
                Layout = " BANDS ",
                Density = "Compact",
                Slots = Slots(("agerating", "TOP"), ("quality", "tl"), ("mood", "top"), ("ageRating", "bottom"), ("genre", "dots")),
                Caps = new TagGroupCaps { Quality = 40, Genre = -3 },
            },
            List = new TagShapeLook { Layout = "grid", Density = "tiny", Slots = Slots(("quality", "tl"), ("rating", "dots"), ("rating", "br"), ("status", "nowhere")) },
        })!;
        var landscape = normalized.Landscape!;
        Assert.Equal(("bands", "compact"), (landscape.Layout, landscape.Density));
        Assert.Equal(new[] { ("ageRating", "top") }, landscape.Slots!.Select(s => (s.Group, s.Slot)));
        Assert.Equal((10, 0), (landscape.Caps!.Quality, landscape.Caps.Genre));
        Assert.Null(landscape.Caps.Rating);

        // An unknown layout means "keep the default layout": its slots are then
        // checked against every layout (the client re-checks against the layout
        // the card resolves to); dots stay quality's.
        var list = normalized.List!;
        Assert.Null(list.Layout);
        Assert.Null(list.Density);
        Assert.Equal(new[] { ("quality", "tl"), ("rating", "br") }, list.Slots!.Select(s => (s.Group, s.Slot)));
        Assert.Null(list.Caps);

        Assert.Null(TagShapeRules.Normalize((TagShapeOverrides?)null));
        Assert.Null(TagShapeRules.NormalizeLook(null));
    }

    [Fact]
    public void SwitchedOffShapesStayAnObjectForUsersButCollapseToNoneForTheAdminDefault()
    {
        // A user who switched the administrator's shape looks off keeps them off:
        // the object stays, so the client does not inherit the admin's again.
        var off = TagShapeRules.Normalize(new TagShapeOverrides())!;
        Assert.Null(off.Landscape);
        Assert.Null(off.List);
        Assert.Null(TagShapeRules.NormalizeDefaults(new TagShapeOverrides()));
        // A look with nothing left still marks the shape as overridden.
        Assert.NotNull(TagShapeRules.Normalize(new TagShapeOverrides { List = new TagShapeLook { Layout = "grid" } })!.List);
    }

    [Fact]
    public void PostedDocumentBindsTheClientKeyCasesAndSurvivesTheUserStore()
    {
        // The client converts object keys to PascalCase but never array items.
        const string posted = "{\"TagLayoutSettingsVersion\":1,\"TagShapeOverrides\":{\"Landscape\":{\"Layout\":\"bands\",\"Density\":\"compact\",\"Slots\":[{\"group\":\"status\",\"slot\":\"top\"}],\"Caps\":{\"Quality\":2}},\"List\":null}}";
        var bound = JsonSerializer.Deserialize<JellyfinEnhancedUserSettings>(posted, new JsonSerializerOptions(JsonSerializerDefaults.Web))!;
        TagShapeRules.Normalize(bound);
        Assert.Equal("bands", bound.TagShapeOverrides!.Landscape!.Layout);
        Assert.Equal(("status", "top"), (bound.TagShapeOverrides.Landscape.Slots!.Single().Group, bound.TagShapeOverrides.Landscape.Slots!.Single().Slot));
        Assert.Null(bound.TagShapeOverrides.List);

        using var f = new CoreFixture();
        const string user = "abcdefabcdefabcdefabcdefabcdefab";
        f.Manager.SaveUserConfiguration(user, "settings.json", bound);
        var loaded = f.Manager.GetUserConfiguration<JellyfinEnhancedUserSettings>(user, "settings.json");
        Assert.Equal(2, loaded.TagShapeOverrides!.Landscape!.Caps!.Quality);
        Assert.Null(loaded.TagShapeOverrides.List);
    }

    [Fact]
    public void ShapeSlotMapsBindAndNormalizeAlongsideTheExistingArrayWireForm()
    {
        const string posted = """
            {"TagShapeOverrides":{"Landscape":{"Layout":"bands","Slots":{"status":"top","quality":"bottom","ageRating":"top","unknown":"top","rating":"tl"}},"Portrait":{"Layout":"minimal"}}}
            """;
        var bound = JsonSerializer.Deserialize<JellyfinEnhancedUserSettings>(posted, new JsonSerializerOptions(JsonSerializerDefaults.Web))!;
        TagShapeRules.Normalize(bound);
        var slots = bound.TagShapeOverrides!.Landscape!.Slots!;
        Assert.Equal(new[] { ("status", "top"), ("quality", "bottom"), ("ageRating", "top") }, slots.Select(s => (s.Group, s.Slot)));
        using var saved = JsonDocument.Parse(JsonSerializer.Serialize(bound));
        Assert.Equal(JsonValueKind.Array, saved.RootElement.GetProperty("TagShapeOverrides").GetProperty("Landscape").GetProperty("Slots").ValueKind);
        Assert.Null(bound.TagShapeOverrides.List);
    }

    [Fact]
    public void AdminDefaultsRoundTripTheXmlAndSeedNewUsers()
    {
        var config = new PluginConfiguration { TagShapeOverrides = new TagShapeOverrides { Landscape = Landscape(), List = new TagShapeLook { Layout = "nope" } } };
        var serializer = new XmlSerializer(typeof(PluginConfiguration));
        using var stream = new MemoryStream();
        serializer.Serialize(stream, config);
        stream.Position = 0;
        var loaded = (PluginConfiguration)serializer.Deserialize(stream)!;
        Assert.Equal("bands", loaded.TagShapeOverrides!.Landscape!.Layout);
        Assert.Equal(6, loaded.TagShapeOverrides.Landscape.Slots!.Count);

        var seeded = new JellyfinEnhancedUserSettings();
        TagShapeRules.ApplyDefaults(seeded, loaded);
        Assert.Equal("compact", seeded.TagShapeOverrides!.Landscape!.Density);
        Assert.Null(seeded.TagShapeOverrides.List!.Layout); // the unknown layout inherits

        var none = new JellyfinEnhancedUserSettings { TagShapeOverrides = new TagShapeOverrides { List = Landscape() } };
        TagShapeRules.ApplyDefaults(none, new PluginConfiguration());
        Assert.Null(none.TagShapeOverrides);

        stream.SetLength(0);
        serializer.Serialize(stream, new PluginConfiguration());
        stream.Position = 0;
        Assert.Null(((PluginConfiguration)serializer.Deserialize(stream)!).TagShapeOverrides);
    }

    [Fact]
    public void RulesAndLocksKeepNormalizedShapeLooks()
    {
        var rules = TagLookValidation.NormalizeRules(new[]
        {
            new TagLookRule
            {
                Id = "kids", Layout = "caption", When = [new() { Field = "type", Value = "Episode" }],
                Shapes = new TagShapeOverrides { Landscape = new TagShapeLook { Layout = "minimal", Slots = Slots(("quality", "dots"), ("genre", "dots")) } },
            },
            new TagLookRule { Id = "empty", Layout = "bands", When = [new() { Field = "type", Value = "Movie" }], Shapes = new TagShapeOverrides() },
        })!;
        Assert.Equal(new[] { ("quality", "dots") }, rules[0].Shapes!.Landscape!.Slots!.Select(s => (s.Group, s.Slot)));
        Assert.Null(rules[1].Shapes);

        var locks = TagLookValidation.NormalizeLocks(new Dictionary<string, TagLayoutLock?>
        {
            ["abcdefabcdefabcdefabcdefabcdefab"] = new() { Layout = "corners", LockedAt = 1, Shapes = new TagShapeOverrides { List = new TagShapeLook { Density = "compact", Caps = new TagGroupCaps { Status = 99 } } } },
        })!;
        Assert.Equal(1, locks["abcdefabcdefabcdefabcdefabcdefab"].Shapes!.List!.Caps!.Status);
    }

    private static Jellyfin.Plugin.JellyfinEnhanced.Controllers.JellyfinEnhancedController Controller(ApiPluginFixture fixture, Claim claim)
    {
        var maintenance = new MaintenanceModeService(Mock.Of<IUserManager>(), Mock.Of<ISessionManager>(), fixture.Core.Paths.Object, fixture.Core.Logger);
        var controller = ApiAssetTests.Controller(fixture.Core, maintenance, fixture.Core.Manager);
        controller.HttpContext.User = new ClaimsPrincipal(new ClaimsIdentity([claim], "test"));
        return controller;
    }

    [Fact]
    public void PublicConfigPublishesTheNormalizedAdminShapeLooks()
    {
        using var fixture = new ApiPluginFixture();
        var controller = Controller(fixture, new Claim(ClaimTypes.Role, "User"));
        fixture.Plugin.Configuration.TagShapeOverrides = new TagShapeOverrides { Landscape = new TagShapeLook { Layout = "Bands", Caps = new TagGroupCaps { Genre = 50 } } };
        using (var document = JsonDocument.Parse(JsonSerializer.Serialize(Assert.IsType<JsonResult>(controller.GetPublicConfig()).Value)))
        {
            var shapes = document.RootElement.GetProperty("TagShapeOverrides");
            Assert.Equal("bands", shapes.GetProperty("Landscape").GetProperty("Layout").GetString());
            Assert.Equal(10, shapes.GetProperty("Landscape").GetProperty("Caps").GetProperty("Genre").GetInt32());
            Assert.Equal(JsonValueKind.Null, shapes.GetProperty("List").ValueKind);
        }

        fixture.Plugin.Configuration.TagShapeOverrides = new TagShapeOverrides();
        using var none = JsonDocument.Parse(JsonSerializer.Serialize(Assert.IsType<JsonResult>(controller.GetPublicConfig()).Value));
        Assert.Equal(JsonValueKind.Null, none.RootElement.GetProperty("TagShapeOverrides").ValueKind);
    }

    [Fact]
    public void SeedingSavingAndResetAllCarryTheShapeLooks()
    {
        using var fixture = new ApiPluginFixture();
        fixture.Plugin.Configuration.TagShapeOverrides = new TagShapeOverrides { Landscape = Landscape() };
        var userId = Guid.NewGuid();
        var user = Controller(fixture, new Claim("Jellyfin-UserId", userId.ToString()));

        // A new user's document is seeded from the admin's defaults.
        Assert.IsType<OkObjectResult>(user.GetUserSettingsSettings(userId.ToString("N")));
        var seeded = fixture.Core.Manager.GetUserConfiguration<JellyfinEnhancedUserSettings>(userId.ToString("N"), "settings.json");
        Assert.Equal("bands", seeded.TagShapeOverrides!.Landscape!.Layout);
        Assert.Equal(1, seeded.TagLayoutSettingsVersion);

        // Saving validates the posted value.
        seeded.TagShapeOverrides = new TagShapeOverrides { List = new TagShapeLook { Layout = "corners", Slots = Slots(("quality", "top")), Caps = new TagGroupCaps { Quality = 22 } } };
        Assert.IsType<OkObjectResult>(user.SaveUserSettingsSettings(userId.ToString("N"), seeded));
        var saved = fixture.Core.Manager.GetUserConfiguration<JellyfinEnhancedUserSettings>(userId.ToString("N"), "settings.json");
        Assert.Null(saved.TagShapeOverrides!.Landscape);
        Assert.Null(saved.TagShapeOverrides.List!.Slots); // "top" is not a corners slot
        Assert.Equal(10, saved.TagShapeOverrides.List.Caps!.Quality);

        // "Apply defaults to all users" copies the admin's shape looks again.
        var admin = Controller(fixture, new Claim(ClaimTypes.Role, "Administrator"));
        Assert.IsType<OkObjectResult>(admin.ResetAllUsersSettings());
        var reset = fixture.Core.Manager.GetUserConfiguration<JellyfinEnhancedUserSettings>(userId.ToString("N"), "settings.json");
        Assert.Equal("bands", reset.TagShapeOverrides!.Landscape!.Layout);
        Assert.Null(reset.TagShapeOverrides.List);
    }

    [Theory]
    [InlineData("tl")]
    [InlineData("tc")]
    [InlineData("tr")]
    [InlineData("ml")]
    [InlineData("c")]
    [InlineData("mr")]
    [InlineData("bl")]
    [InlineData("bc")]
    [InlineData("br")]
    public void AllNineAnchorsSurviveShapeRuleAndLockNormalizationAndWireRoundTrip(string slot)
    {
        TagShapeOverrides Shapes() => new() { Landscape = new() { Layout = "corners", Slots = Slots(("quality", slot)) }, List = new() { Layout = "corners", Slots = Slots(("rating", slot)) } };
        const string id = "abcdefabcdefabcdefabcdefabcdefab";
        var user = new JellyfinEnhancedUserSettings
        {
            TagLayoutSettingsVersion = 1, TagShapeOverrides = Shapes(),
            TagLookRules = [new() { Id = "episode", Layout = "bands", When = [new() { Field = "type", Value = "Episode" }], Shapes = Shapes() }],
            TagLayoutLocks = new() { [id] = new() { Layout = "summary", LockedAt = 1, Shapes = Shapes() } },
        };
        TagShapeRules.Normalize(user);
        TagLookValidation.Normalize(user);
        var copy = JsonSerializer.Deserialize<JellyfinEnhancedUserSettings>(JsonSerializer.Serialize(user))!;
        foreach (var shapes in new[] { copy.TagShapeOverrides!, copy.TagLookRules![0].Shapes!, copy.TagLayoutLocks![id]!.Shapes! })
        {
            Assert.Equal(slot, Assert.Single(shapes.Landscape!.Slots!).Slot);
            Assert.Equal(slot, Assert.Single(shapes.List!.Slots!).Slot);
        }
    }

    [Fact]
    public void NativePosterTagsIgnoreShapeLooks()
    {
        // Native Poster Tags draw on poster images only, so a shape look never
        // changes what they resolve (nor their settings digest).
        var config = new PluginConfiguration();
        const string plain = "{\"QualityTagsEnabled\":true,\"TagLayoutSettingsVersion\":1,\"TagLayout\":\"corners\"}";
        const string withShapes = "{\"QualityTagsEnabled\":true,\"TagLayoutSettingsVersion\":1,\"TagLayout\":\"corners\","
            + "\"TagShapeOverrides\":{\"Landscape\":{\"Layout\":\"bands\",\"Density\":\"compact\",\"Slots\":[{\"group\":\"quality\",\"slot\":\"off\"}],\"Caps\":{\"Quality\":1}},\"List\":{\"Layout\":\"corners\"}}}";
        var before = PosterTagSettings.FromSettingsJson(plain, config);
        var after = PosterTagSettings.FromSettingsJson(withShapes, config);
        Assert.Equal(before.Digest, after.Digest);

        config.TagShapeOverrides = new TagShapeOverrides { Landscape = Landscape() };
        Assert.Equal(before.Digest, PosterTagSettings.FromSettingsJson(plain, config).Digest);
    }
}
