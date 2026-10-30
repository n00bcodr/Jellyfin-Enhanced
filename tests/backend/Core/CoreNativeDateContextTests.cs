using System.Security.Claims;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Session;
using Microsoft.AspNetCore.Mvc;
using Moq;

namespace JE.Tests;

[Collection("Plugin singleton")]
public class CoreNativeDateContextTests
{
    [Theory]
    [InlineData("bad/", "bad/")]
    [InlineData("auto", "Not/AZone")]
    [InlineData("not-a-real-locale", "../etc/passwd")]
    [InlineData("en_US", "Australia//Perth")]
    [InlineData("en--US", "")]
    [InlineData("zz-ZZ", "Mars/Olympus")]
    [InlineData("", " ")]
    [InlineData(null, null)]
    public void Save_endpoint_drops_malformed_or_unknown_context(string? locale, string? zone) => SaveAndCheck(locale, zone, null, null);

    [Fact]
    public void Save_endpoint_drops_oversize_context() => SaveAndCheck(new string('x', 4100), new string('x', 4100), null, null);

    [Theory]
    [InlineData(" en-us ", " Australia/Perth ", "en-US", "Australia/Perth")]
    [InlineData("fa", "Asia/Tehran", "fa", "Asia/Tehran")]
    [InlineData("zh-cn", "Asia/Shanghai", "zh-CN", "Asia/Shanghai")]
    [InlineData("zh-hk", "Asia/Hong_Kong", "zh-HK", "Asia/Hong_Kong")]
    [InlineData("sr-latn-rs", "UTC", "sr-Latn-RS", "UTC")]
    [InlineData("es-419", "Etc/GMT+3", "es-419", "Etc/GMT+3")]
    [InlineData("en-GB", "W. Australia Standard Time", "en-GB", "Australia/Perth")]
    public void Save_endpoint_canonicalizes_valid_cultures_and_IANA_or_Windows_zones(string locale, string zone, string expectedLocale, string expectedZone)
        => SaveAndCheck(locale, zone, expectedLocale, expectedZone);

    private static void SaveAndCheck(string? locale, string? zone, string? expectedLocale, string? expectedZone)
    {
        using var fixture = new ApiPluginFixture();
        var userId = Guid.NewGuid().ToString("N");
        var maintenance = new MaintenanceModeService(Mock.Of<IUserManager>(), Mock.Of<ISessionManager>(), fixture.Core.Paths.Object, fixture.Core.Logger);
        var controller = ApiAssetTests.Controller(fixture.Core, maintenance, fixture.Core.Manager);
        controller.HttpContext.User = new ClaimsPrincipal(new ClaimsIdentity([new Claim("Jellyfin-UserId", userId)], "test"));
        fixture.Core.Manager.SaveUserConfiguration(userId, "settings.json", new JellyfinEnhancedUserSettings { LastOpenedTab = "previous-tab" });
        var posted = System.Text.Json.JsonSerializer.Deserialize<JellyfinEnhancedUserSettings>(System.Text.Json.JsonSerializer.Serialize(new { NativePosterDateLocale = locale, NativePosterTimeZone = zone }))!;
        Assert.IsType<OkObjectResult>(controller.SaveUserSettingsSettings(userId, posted));
        var saved = fixture.Core.Manager.GetUserConfiguration<JellyfinEnhancedUserSettings>(userId, "settings.json");
        Assert.Equal(expectedLocale, saved.NativePosterDateLocale);
        Assert.Equal(expectedZone, saved.NativePosterTimeZone);
        var disk = File.ReadAllText(Path.Combine(fixture.Core.ConfigRoot, userId, "settings.json"));
        Assert.DoesNotContain(new string('x', 100), disk);
    }

    [Theory]
    [InlineData("bad/", "bad/", null, null)]
    [InlineData("not-a-real-locale", "../etc/passwd", null, null)]
    [InlineData(" DE-de ", "W. Australia Standard Time", "de-DE", "Australia/Perth")]
    public void Tampered_documents_are_validated_on_both_strict_and_lenient_load(string locale, string zone, string? expectedLocale, string? expectedZone)
    {
        using var fixture = new CoreFixture();
        const string user = "abcdefabcdefabcdefabcdefabcdefab";
        fixture.Write(user, System.Text.Json.JsonSerializer.Serialize(new { NativePosterDateLocale = locale, NativePosterTimeZone = zone }));
        foreach (var loaded in new[] { fixture.Manager.GetUserConfiguration<JellyfinEnhancedUserSettings>(user, "settings.json"), fixture.Manager.GetUserConfigurationStrict<JellyfinEnhancedUserSettings>(user, "settings.json") })
        {
            Assert.Equal(expectedLocale, loaded.NativePosterDateLocale);
            Assert.Equal(expectedZone, loaded.NativePosterTimeZone);
        }
        fixture.Write(user, System.Text.Json.JsonSerializer.Serialize(new { NativePosterDateLocale = new string('x', 4100), NativePosterTimeZone = new string('x', 4100) }));
        Assert.Null(fixture.Manager.GetUserConfiguration<JellyfinEnhancedUserSettings>(user, "settings.json").NativePosterDateLocale);
        Assert.Null(fixture.Manager.GetUserConfigurationStrict<JellyfinEnhancedUserSettings>(user, "settings.json").NativePosterTimeZone);
    }
}
