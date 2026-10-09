using System.Security.Claims;
using Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags;

namespace JE.Tests;

[Collection("Plugin singleton")]
public class HistoryNativeClientTests
{
    // Independent examples: iterating production's exclusion list cannot detect
    // a missing client, which is exactly the regression reported in #905.
    [Theory]
    [InlineData("Jellium Desktop", false)]
    [InlineData("jellium desktop", false)]
    [InlineData("  Jellium Desktop  ", false)]
    [InlineData("Jellyfin Web", false)]
    [InlineData("Jellyfin Media Player", false)]
    [InlineData("Jellyfin Desktop", false)]
    [InlineData("Jellyfin for WebOS", false)]
    [InlineData("Jellyfin for Android", false)]
    [InlineData("Jellyfin for Android TV", true)]
    [InlineData("Jellium Desktop TV", true)]
    [InlineData("Swiftfin", true)]
    [InlineData("", false)]
    public void ReportedDesktopShellMustNotReceiveNativeTags(string client, bool expected)
    {
        using var fixture = new ApiPluginFixture();
        fixture.Plugin.Configuration.NativePosterTagsWebClientNames = "";
        var principal = new ClaimsPrincipal(new ClaimsIdentity(
            [new Claim("Jellyfin-Client", client)], "test"));
        Assert.Equal(expected, new NativeClientPolicy().IsNativeClient(principal));
    }

    [Fact]
    public void ChangingCustomShellExclusionsPreservesBuiltInDesktopExclusion()
    {
        using var fixture = new ApiPluginFixture();
        var policy = new NativeClientPolicy();
        ClaimsPrincipal Client(string name) => new(new ClaimsIdentity(
            [new Claim("Jellyfin-Client", name)], "test"));
        fixture.Plugin.Configuration.NativePosterTagsWebClientNames = "Custom Shell";
        Assert.False(policy.IsNativeClient(Client("Custom Shell")));
        Assert.False(policy.IsNativeClient(Client("Jellium Desktop")));
        fixture.Plugin.Configuration.NativePosterTagsWebClientNames = "Other Shell";
        Assert.True(policy.IsNativeClient(Client("Custom Shell")));
        Assert.False(policy.IsNativeClient(Client("Other Shell")));
        Assert.False(policy.IsNativeClient(Client("Jellium Desktop")));
    }
}
