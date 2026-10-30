using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Session;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Moq;

namespace JE.Tests;

[Collection("Plugin singleton")]
public class CoreLanguageTagPriorityTests
{
    [Theory]
    [InlineData(" ENG ", "en")]
    [InlineData("fre", "fr")]
    [InlineData("fra", "fr")]
    [InlineData("deu", "de")]
    [InlineData("ger", "de")]
    [InlineData("tgl", "fil")]
    [InlineData("tl", "fil")]
    [InlineData("nob", "no")]
    [InlineData("nno", "no")]
    [InlineData("ast", "ast")]
    [InlineData("zxx", "zxx")]
    [InlineData("pt-BR", null)]
    [InlineData("English", null)]
    [InlineData("xx", null)]
    [InlineData("xxx", null)]
    [InlineData("pob", null)]
    [InlineData("und", null)]
    [InlineData("mul", null)]
    [InlineData("__proto__", null)]
    [InlineData(null, null)]
    public void AcceptsAssignedIsoCodesAndUsesExistingAudioEquivalence(string? raw, string? expected) =>
        Assert.Equal(expected, LanguageTagPriority.NormalizeCode(raw));

    [Fact]
    public void NullAndEmptyRemainDistinctAndFirstEquivalentCodeWins()
    {
        Assert.True(LanguageTagPriority.TryNormalize(null, out var inherited));
        Assert.Null(inherited);
        Assert.True(LanguageTagPriority.TryNormalize([], out var empty));
        Assert.Empty(empty!);
        Assert.True(LanguageTagPriority.TryNormalize(["jpn", "eng", "en", "ger", "deu", "tl", "fil", "nob", "nn"], out var codes));
        Assert.Equal(new[] { "ja", "en", "de", "fil", "no" }, codes);
        Assert.False(LanguageTagPriority.TryNormalize(Enumerable.Repeat("en", 13).ToArray(), out _));
        Assert.False(LanguageTagPriority.TryNormalize(["en", null!], out _));
    }

    [Fact]
    public void SaveValidatesRoundTripsAndRejectsBadListsWithoutOverwritingOtherSettings()
    {
        using var f = new ApiPluginFixture();
        var maintenance = new MaintenanceModeService(Mock.Of<IUserManager>(), Mock.Of<ISessionManager>(), f.Core.Paths.Object, f.Core.Logger);
        var controller = ApiAssetTests.Controller(f.Core, maintenance, f.Core.Manager);
        var user = Guid.NewGuid();
        controller.ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext { User = global::JellyfinEnhanced.Tests.PrivacyPolicyTests.Principal(user) } };
        var bound = JsonSerializer.Deserialize<JellyfinEnhancedUserSettings>("{\"languageTagsPriority\":[\"jpn\",\"eng\",\"en\"],\"languageTagsPriorityStrict\":false}", new JsonSerializerOptions(JsonSerializerDefaults.Web))!;
        Assert.IsType<OkObjectResult>(controller.SaveUserSettingsSettings(user.ToString("N"), bound));
        var saved = f.Core.Manager.GetUserConfiguration<JellyfinEnhancedUserSettings>(user.ToString("N"), "settings.json");
        Assert.Equal(new[] { "ja", "en" }, saved.LanguageTagsPriority);
        Assert.False(saved.LanguageTagsPriorityStrict);
        foreach (var invalid in new[] { new[] { "Japanese" }, new[] { "ja-JP" }, new[] { "xyz" }, Enumerable.Repeat("en", 13).ToArray(), new[] { "en", null! } })
        {
            Assert.IsType<BadRequestObjectResult>(controller.SaveUserSettingsSettings(user.ToString("N"), new JellyfinEnhancedUserSettings { LanguageTagsPriority = invalid, LanguageTagsEnabled = true }));
            var unchanged = f.Core.Manager.GetUserConfiguration<JellyfinEnhancedUserSettings>(user.ToString("N"), "settings.json");
            Assert.Equal(saved.LanguageTagsPriority, unchanged.LanguageTagsPriority);
            Assert.False(unchanged.LanguageTagsEnabled);
        }
        Assert.IsType<ForbidResult>(controller.SaveUserSettingsSettings(Guid.NewGuid().ToString("N"), bound));
        Assert.IsType<OkObjectResult>(controller.SaveUserSettingsSettings(user.ToString("N"), new JellyfinEnhancedUserSettings { LanguageTagsPriority = [] }));
        Assert.Empty(f.Core.Manager.GetUserConfiguration<JellyfinEnhancedUserSettings>(user.ToString("N"), "settings.json").LanguageTagsPriority!);
        Assert.IsType<OkObjectResult>(controller.SaveUserSettingsSettings(user.ToString("N"), new JellyfinEnhancedUserSettings()));
        var follow = f.Core.Manager.GetUserConfiguration<JellyfinEnhancedUserSettings>(user.ToString("N"), "settings.json");
        Assert.Null(follow.LanguageTagsPriority);
        Assert.Null(follow.LanguageTagsPriorityStrict);
    }

    [Fact]
    public void SeedingAndResetKeepLiveInheritanceRatherThanCopyingTheAdminPolicy()
    {
        var config = new PluginConfiguration { LanguageTagsPriority = "Japanese", LanguageTagsPriorityStrict = true };
        var user = new JellyfinEnhancedUserSettings { LanguageTagsPriority = ["en"], LanguageTagsPriorityStrict = false };
        LanguageTagDisplay.ApplyDefaults(user, config);
        Assert.Null(user.LanguageTagsPriority);
        Assert.Null(user.LanguageTagsPriorityStrict);
    }
}
