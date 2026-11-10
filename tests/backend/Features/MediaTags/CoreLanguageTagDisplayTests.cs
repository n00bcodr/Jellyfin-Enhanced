using System.Security.Claims;
using System.Text.Json;
using System.Xml.Serialization;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Session;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Moq;
using Jellyfin.Plugin.JellyfinEnhanced.Features.Admin.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Features.Settings;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.Maintenance;

namespace JE.Tests.Features.MediaTags;

/// <summary>
/// The Language Tags display settings (LanguageTagsShowAudio/ShowSubtitles,
/// LanguageTagsStyle, LanguageTagsCountBadge): defaults that keep today's look,
/// normalization on save, admin defaults seeded into new and reset users, and
/// the public configuration.
/// </summary>
[Collection("Plugin singleton")]
public class CoreLanguageTagDisplayTests
{
    [Fact]
    public void DefaultsKeepAudioFlagsWithoutSubtitlesOrBadge()
    {
        var user = new JellyfinEnhancedUserSettings();
        Assert.True(user.LanguageTagsShowAudio);
        Assert.False(user.LanguageTagsShowSubtitles);
        Assert.Equal("flags", user.LanguageTagsStyle);
        Assert.Equal("off", user.LanguageTagsCountBadge);
        var admin = new PluginConfiguration();
        Assert.True(admin.LanguageTagsShowAudio);
        Assert.False(admin.LanguageTagsShowSubtitles);
        Assert.Equal("flags", admin.LanguageTagsStyle);
        Assert.Equal("off", admin.LanguageTagsCountBadge);
    }

    [Theory]
    [InlineData("codes", "codes")]
    [InlineData(" CODES ", "codes")]
    [InlineData("flags", "flags")]
    [InlineData("emoji", "flags")]
    [InlineData(null, "flags")]
    public void StyleNormalizesToAKnownValue(string? posted, string expected) =>
        Assert.Equal(expected, LanguageTagDisplay.NormalizeStyle(posted));

    [Theory]
    [InlineData("only", "only")]
    [InlineData("Both", "both")]
    [InlineData("off", "off")]
    [InlineData("always", "off")]
    [InlineData(null, "off")]
    public void CountBadgeNormalizesToAKnownValue(string? posted, string expected) =>
        Assert.Equal(expected, LanguageTagDisplay.NormalizeCountBadge(posted));

    [Fact]
    public void LegacyDocumentsLoadWithTodaysLookAndPostedValuesAreNormalized()
    {
        using var f = new CoreFixture();
        const string user = "abcdefabcdefabcdefabcdefabcdefab";
        f.Write(user, "{\"LanguageTagsEnabled\":true}");
        var loaded = f.Manager.GetUserConfiguration<JellyfinEnhancedUserSettings>(user, "settings.json");
        Assert.True(loaded.LanguageTagsShowAudio);
        Assert.False(loaded.LanguageTagsShowSubtitles);
        Assert.Equal("flags", loaded.LanguageTagsStyle);
        Assert.Equal("off", loaded.LanguageTagsCountBadge);

        // The client posts camelCase keys; model binding is case-insensitive.
        const string posted = "{\"languageTagsShowAudio\":false,\"languageTagsShowSubtitles\":true,\"languageTagsStyle\":\"Codes\",\"languageTagsCountBadge\":\"sometimes\"}";
        var bound = JsonSerializer.Deserialize<JellyfinEnhancedUserSettings>(posted, new JsonSerializerOptions(JsonSerializerDefaults.Web))!;
        LanguageTagDisplay.Normalize(bound);
        Assert.False(bound.LanguageTagsShowAudio);
        Assert.True(bound.LanguageTagsShowSubtitles);
        Assert.Equal("codes", bound.LanguageTagsStyle);
        Assert.Equal("off", bound.LanguageTagsCountBadge);
    }

    [Fact]
    public void AdminDefaultsRoundTripThroughThePluginConfigurationXml()
    {
        var config = new PluginConfiguration { LanguageTagsShowAudio = false, LanguageTagsShowSubtitles = true, LanguageTagsStyle = "codes", LanguageTagsCountBadge = "both" };
        var serializer = new XmlSerializer(typeof(PluginConfiguration));
        using var stream = new MemoryStream();
        serializer.Serialize(stream, config);
        stream.Position = 0;
        var loaded = (PluginConfiguration)serializer.Deserialize(stream)!;
        Assert.False(loaded.LanguageTagsShowAudio);
        Assert.True(loaded.LanguageTagsShowSubtitles);
        Assert.Equal("codes", loaded.LanguageTagsStyle);
        Assert.Equal("both", loaded.LanguageTagsCountBadge);
    }

    [Fact]
    public void NewAndResetUsersStartFromTheAdminDefaults()
    {
        using var fixture = new ApiPluginFixture();
        var config = fixture.Plugin.Configuration;
        config.LanguageTagsShowAudio = false;
        config.LanguageTagsShowSubtitles = true;
        config.LanguageTagsStyle = "CODES";
        config.LanguageTagsCountBadge = "only";
        var maintenance = new MaintenanceModeService(Mock.Of<IUserManager>(), Mock.Of<ISessionManager>(), fixture.Core.Paths.Object, fixture.Core.Logger);
        var controller = (JeSettingsController)ApiAssetTests.Controller(typeof(JeSettingsController), fixture.Core, maintenance, fixture.Core.Manager);
        var userId = Guid.NewGuid();
        controller.ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext { User = global::JE.Tests.Features.SpoilerGuard.PrivacyPolicyTests.Principal(userId) } };

        // First read seeds settings.json from the admin defaults.
        Assert.IsType<OkObjectResult>(controller.GetUserSettingsSettings(userId.ToString("N")));
        var seeded = fixture.Core.Manager.GetUserConfiguration<JellyfinEnhancedUserSettings>(userId.ToString("N"), "settings.json");
        Assert.False(seeded.LanguageTagsShowAudio);
        Assert.True(seeded.LanguageTagsShowSubtitles);
        Assert.Equal("codes", seeded.LanguageTagsStyle);
        Assert.Equal("only", seeded.LanguageTagsCountBadge);

        // "Apply defaults to all users" writes the (changed) admin defaults again.
        seeded.LanguageTagsStyle = "flags";
        fixture.Core.Manager.SaveUserConfiguration(userId.ToString("N"), "settings.json", seeded);
        config.LanguageTagsCountBadge = "both";
        controller.ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext { User = global::JE.Tests.Features.SpoilerGuard.PrivacyPolicyTests.Principal(Guid.NewGuid(), admin: true) } };
        Assert.IsType<OkObjectResult>(controller.ResetAllUsersSettings());
        var reset = fixture.Core.Manager.GetUserConfiguration<JellyfinEnhancedUserSettings>(userId.ToString("N"), "settings.json");
        Assert.Equal("codes", reset.LanguageTagsStyle);
        Assert.Equal("both", reset.LanguageTagsCountBadge);
        Assert.True(reset.LanguageTagsShowSubtitles);
    }

    [Fact]
    public void PublicConfigExposesNormalizedLanguageDisplayDefaults()
    {
        using var fixture = new ApiPluginFixture();
        fixture.Plugin.Configuration.LanguageTagsShowSubtitles = true;
        fixture.Plugin.Configuration.LanguageTagsStyle = "Codes";
        fixture.Plugin.Configuration.LanguageTagsCountBadge = "nonsense";
        var maintenance = new MaintenanceModeService(Mock.Of<IUserManager>(), Mock.Of<ISessionManager>(), fixture.Core.Paths.Object, fixture.Core.Logger);
        var controller = ApiAssetTests.Controller(fixture.Core, maintenance);
        controller.HttpContext.User = new ClaimsPrincipal(new ClaimsIdentity([new Claim(ClaimTypes.Role, "User")], "test"));
        using var document = JsonDocument.Parse(JsonSerializer.Serialize(Assert.IsType<JsonResult>(controller.GetPublicConfig()).Value));
        var root = document.RootElement;
        Assert.True(root.GetProperty("LanguageTagsShowAudio").GetBoolean());
        Assert.True(root.GetProperty("LanguageTagsShowSubtitles").GetBoolean());
        Assert.Equal("codes", root.GetProperty("LanguageTagsStyle").GetString());
        Assert.Equal("off", root.GetProperty("LanguageTagsCountBadge").GetString());
    }
}
