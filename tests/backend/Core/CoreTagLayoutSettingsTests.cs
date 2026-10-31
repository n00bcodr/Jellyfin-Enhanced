using Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags;
using System.Security.Claims;
using System.Text.Json;
using System.Xml.Serialization;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Session;
using Microsoft.AspNetCore.Mvc;
using Moq;

namespace JE.Tests;

[Collection("Plugin singleton")]
public class CoreTagLayoutSettingsTests
{
    private const string User = "abcdefabcdefabcdefabcdefabcdefab";

    private static TagLayoutProfile Profile(params (string Group, string Slot)[] entries) =>
        new() { Groups = entries.Select(e => new TagLayoutGroupSlot { Group = e.Group, Slot = e.Slot }).ToList() };

    [Fact]
    public void SingleChipCapsPreserveStoredValuesAndOnlyLimitPresentation()
    {
        var caps = TagLayoutRules.NormalizeCaps(new TagGroupCaps { Status = 9, AgeRating = 0, Logos = 10, Quality = 8 })!;
        Assert.Equal(9, caps.Status);
        Assert.Equal(0, caps.AgeRating);
        Assert.Equal(10, caps.Logos);
        Assert.Equal(8, caps.Quality);
        Assert.Equal(10, TagLayoutRules.NormalizeCaps(new TagGroupCaps { Logos = 10 })!.Logos);
        foreach (var max in new[] { 1, 2 })
        {
            var settings = PosterTagSettings.FromUserSettings(new() { TagLayoutSettingsVersion = 1,
                TagGroupCaps = new() { Status = 9, AgeRating = 9, Logos = 9 } }, new() { LogoTagsMaxLogos = max }, null);
            Assert.Equal(1, settings.CapOf(PosterTagGroup.Status));
            Assert.Equal(1, settings.CapOf(PosterTagGroup.AgeRating));
            Assert.Equal(max == 1 ? 1 : 9, settings.CapOf(PosterTagGroup.Logos));
        }
    }

    [Fact]
    public void NewDocumentsAreLegacyCornersWithInheritedLayoutValues()
    {
        var user = new JellyfinEnhancedUserSettings();
        Assert.Equal("corners", user.TagLayout);
        Assert.Equal(0, user.TagLayoutSettingsVersion);
        Assert.Null(user.TagLayouts);
        Assert.Null(user.TagGroupOrder);
        Assert.Null(user.TagGroupCaps);
        Assert.Equal("full", user.TagLabelDensity);
        var admin = new PluginConfiguration();
        Assert.Equal("corners", admin.TagLayout);
        Assert.Null(admin.TagLayouts);
        Assert.Null(admin.TagGroupOrder);
        Assert.Null(admin.TagGroupCaps);
        Assert.Equal("full", admin.TagLabelDensity);
    }

    [Fact]
    public void LegacyFileWithoutLayoutKeysLoadsAsVersionZero()
    {
        using var f = new CoreFixture();
        f.Write(User, "{\"QualityTagsEnabled\":true,\"QualityTagsPosition\":\"bottom-right\",\"GenreTagsPosition\":\"top-left\"}");
        var loaded = f.Manager.GetUserConfiguration<JellyfinEnhancedUserSettings>(User, "settings.json");
        Assert.Equal(0, loaded.TagLayoutSettingsVersion);
        Assert.Equal("corners", loaded.TagLayout);
        Assert.Null(loaded.TagLayouts);
        Assert.Equal("bottom-right", loaded.QualityTagsPosition);
        Assert.Equal("top-left", loaded.GenreTagsPosition);
    }

    [Fact]
    public void NormalizeRepairsLayoutDensityVersionGroupsSlotsOrderAndCaps()
    {
        var user = new JellyfinEnhancedUserSettings
        {
            TagLayout = " BANDS ",
            TagLabelDensity = "tiny",
            TagLayoutSettingsVersion = 7,
            TagLayouts = new TagLayoutProfiles
            {
                Corners = Profile(("agerating", "BR"), ("quality", "middle"), ("genre", "tl"), ("genre", "tr"), ("library", "tl")),
                Minimal = Profile(("rating", "dots"), ("quality", "dots"), ("status", "off")),
                Caption = Profile(("status", "top")),
            },
            TagGroupOrder = new List<string> { "genre", "AGERATING", "genre", "people", "status" },
            TagGroupCaps = new TagGroupCaps { Genre = 99, Language = -2, Status = 1 },
        };

        TagLayoutRules.Normalize(user);

        Assert.Equal("bands", user.TagLayout);
        Assert.Equal("full", user.TagLabelDensity);
        Assert.Equal(1, user.TagLayoutSettingsVersion);
        var corners = user.TagLayouts!.Corners!.Groups.Select(g => (g.Group, g.Slot)).ToList();
        Assert.Equal(new[] { ("ageRating", "br"), ("genre", "tl") }, corners);
        var minimal = user.TagLayouts.Minimal!.Groups.Select(g => (g.Group, g.Slot)).ToList();
        Assert.Equal(new[] { ("quality", "dots"), ("status", "off") }, minimal);
        Assert.Null(user.TagLayouts.Caption);
        Assert.Null(user.TagLayouts.Bands);
        Assert.Equal(new[] { "genre", "ageRating", "status" }, user.TagGroupOrder);
        Assert.Equal(10, user.TagGroupCaps!.Genre);
        Assert.Equal(0, user.TagGroupCaps.Language);
        Assert.Equal(1, user.TagGroupCaps.Status);
        Assert.Null(user.TagGroupCaps.Quality);
    }

    [Fact]
    public void NormalizeDropsEmptyStructuresAndNegativeVersions()
    {
        var user = new JellyfinEnhancedUserSettings
        {
            TagLayoutSettingsVersion = -3,
            TagLayouts = new TagLayoutProfiles { Bands = Profile(("unknown", "top")) },
            TagGroupOrder = new List<string> { "nope" },
            TagGroupCaps = new TagGroupCaps(),
        };
        TagLayoutRules.Normalize(user);
        Assert.Equal(0, user.TagLayoutSettingsVersion);
        Assert.Null(user.TagLayouts);
        Assert.Null(user.TagGroupOrder);
        Assert.Null(user.TagGroupCaps);
    }

    [Fact]
    public void AdminDefaultsSeedANormalizedVersionOneDocument()
    {
        var admin = new PluginConfiguration
        {
            TagLayout = "summary",
            TagLabelDensity = "compact",
            TagLayouts = new TagLayoutProfiles { Summary = Profile(("genre", "pill"), ("quality", "bogus")) },
            TagGroupOrder = new List<string> { "quality", "status" },
            TagGroupCaps = new TagGroupCaps { Genre = 2 },
        };
        var user = new JellyfinEnhancedUserSettings();
        TagLayoutRules.ApplyDefaults(user, admin);
        Assert.Equal(1, user.TagLayoutSettingsVersion);
        Assert.Equal("summary", user.TagLayout);
        Assert.Equal("compact", user.TagLabelDensity);
        Assert.Equal("genre", Assert.Single(user.TagLayouts!.Summary!.Groups).Group);
        Assert.Equal(new[] { "quality", "status" }, user.TagGroupOrder);
        Assert.Equal(2, user.TagGroupCaps!.Genre);

        var untouched = new JellyfinEnhancedUserSettings();
        TagLayoutRules.ApplyDefaults(untouched, new PluginConfiguration());
        Assert.Equal(1, untouched.TagLayoutSettingsVersion);
        Assert.Equal("corners", untouched.TagLayout);
        Assert.Null(untouched.TagLayouts);
    }

    [Fact]
    public void LayoutDocumentSurvivesTheUserStoreAndTheApiSerializer()
    {
        using var f = new CoreFixture();
        var user = new JellyfinEnhancedUserSettings
        {
            TagLayout = "caption",
            TagLayoutSettingsVersion = 1,
            TagLayouts = new TagLayoutProfiles { Caption = Profile(("status", "poster"), ("quality", "caption")) },
            TagGroupOrder = new List<string> { "quality", "status" },
            TagGroupCaps = new TagGroupCaps { Language = 2 },
            TagLabelDensity = "compact",
        };
        f.Manager.SaveUserConfiguration(User, "settings.json", user);
        var loaded = f.Manager.GetUserConfiguration<JellyfinEnhancedUserSettings>(User, "settings.json");
        Assert.Equal("caption", loaded.TagLayout);
        Assert.Equal(("status", "poster"), (loaded.TagLayouts!.Caption!.Groups[0].Group, loaded.TagLayouts.Caption.Groups[0].Slot));
        Assert.Equal(2, loaded.TagGroupCaps!.Language);

        // The client posts camelCase keys inside arrays (its key converter does not
        // recurse into them); model binding is case-insensitive.
        const string posted = "{\"TagLayout\":\"minimal\",\"TagLayouts\":{\"Minimal\":{\"Groups\":[{\"group\":\"quality\",\"slot\":\"dots\"}]}},\"TagGroupOrder\":[\"rating\"]}";
        var bound = JsonSerializer.Deserialize<JellyfinEnhancedUserSettings>(posted, new JsonSerializerOptions(JsonSerializerDefaults.Web))!;
        TagLayoutRules.Normalize(bound);
        Assert.Equal("minimal", bound.TagLayout);
        Assert.Equal("dots", bound.TagLayouts!.Minimal!.Groups.Single().Slot);
        Assert.Equal(new[] { "rating" }, bound.TagGroupOrder);
    }

    [Fact]
    public void AdminDefaultsRoundTripThroughThePluginConfigurationXml()
    {
        var config = new PluginConfiguration
        {
            TagLayout = "bands",
            TagLayouts = new TagLayoutProfiles { Bands = Profile(("status", "top"), ("quality", "bottom")) },
            TagGroupOrder = new List<string> { "quality", "rating" },
            TagGroupCaps = new TagGroupCaps { Genre = 4, Status = 1 },
            TagLabelDensity = "compact",
        };
        var serializer = new XmlSerializer(typeof(PluginConfiguration));
        using var stream = new MemoryStream();
        serializer.Serialize(stream, config);
        stream.Position = 0;
        var loaded = (PluginConfiguration)serializer.Deserialize(stream)!;
        Assert.Equal("bands", loaded.TagLayout);
        Assert.Equal(new[] { ("status", "top"), ("quality", "bottom") }, loaded.TagLayouts!.Bands!.Groups.Select(g => (g.Group, g.Slot)));
        Assert.Null(loaded.TagLayouts.Corners);
        Assert.Equal(new[] { "quality", "rating" }, loaded.TagGroupOrder);
        Assert.Equal(4, loaded.TagGroupCaps!.Genre);
        Assert.Null(loaded.TagGroupCaps.Quality);
        Assert.Equal("compact", loaded.TagLabelDensity);

        stream.SetLength(0);
        serializer.Serialize(stream, new PluginConfiguration());
        stream.Position = 0;
        var defaults = (PluginConfiguration)serializer.Deserialize(stream)!;
        Assert.Null(defaults.TagLayouts);
        // XmlSerializer reads an absent list back as an empty one; it must still mean "inherit".
        Assert.Null(TagLayoutRules.NormalizeOrder(defaults.TagGroupOrder));
        Assert.Null(defaults.TagGroupCaps);
    }

    [Fact]
    public void PublicConfigExposesNormalizedLayoutDefaults()
    {
        using var fixture = new ApiPluginFixture();
        fixture.Plugin.Configuration.TagLayout = "Weird";
        fixture.Plugin.Configuration.TagLabelDensity = "compact";
        fixture.Plugin.Configuration.TagGroupOrder = new List<string> { "genre", "genre" };
        fixture.Plugin.Configuration.TagGroupCaps = new TagGroupCaps { Rating = 40 };
        var maintenance = new MaintenanceModeService(Mock.Of<IUserManager>(), Mock.Of<ISessionManager>(), fixture.Core.Paths.Object, fixture.Core.Logger);
        var controller = ApiAssetTests.Controller(fixture.Core, maintenance);
        controller.HttpContext.User = new ClaimsPrincipal(new ClaimsIdentity([new Claim(ClaimTypes.Role, "User")], "test"));
        using var document = JsonDocument.Parse(JsonSerializer.Serialize(Assert.IsType<JsonResult>(controller.GetPublicConfig()).Value));
        var root = document.RootElement;
        Assert.Equal("corners", root.GetProperty("TagLayout").GetString());
        Assert.Equal("compact", root.GetProperty("TagLabelDensity").GetString());
        Assert.Equal(JsonValueKind.Null, root.GetProperty("TagLayouts").ValueKind);
        Assert.Equal(new[] { "genre" }, root.GetProperty("TagGroupOrder").EnumerateArray().Select(e => e.GetString()));
        Assert.Equal(10, root.GetProperty("TagGroupCaps").GetProperty("Rating").GetInt32());
    }
}
