using Jellyfin.Plugin.JellyfinEnhanced.Features.MediaTags.PosterTags;
using Jellyfin.Plugin.JellyfinEnhanced.Features.SpoilerGuard.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.SpoilerGuard;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Abstractions;
using Microsoft.AspNetCore.Mvc.Filters;
using Microsoft.AspNetCore.Mvc.ModelBinding;
using Microsoft.AspNetCore.Routing;
using Moq;

namespace JE.Tests.Features.SpoilerGuard;

// The web client writes its bare user id into je-spoiler-uid, which no longer picks a user out of a shared address:
// an authenticated response gives that browser the value the server signed for the token's user instead.
[Collection("Plugin singleton")]
public class SpoilerIdentityCookieTests
{
    private static async Task<string> SetCookieAfter(SpoilerIdentityService markers, Guid user, string? cookie)
    {
        var filter = new SpoilerIdentityTagFilter(markers, null!, new NativePosterTagStamper(new NativeClientPolicy(), null!, null!, null!, markers, null!, null!, null!, null!));
        var http = new DefaultHttpContext { User = PrivacyPolicyTests.Principal(user) };
        if (cookie != null) http.Request.Headers.Cookie = "je-spoiler-uid=" + cookie;
        var context = new ActionContext(http, new RouteData(), new ActionDescriptor(), new ModelStateDictionary());
        await filter.OnActionExecutionAsync(new ActionExecutingContext(context, [], new Dictionary<string, object?>(), new object()),
            () => Task.FromResult(new ActionExecutedContext(context, [], new object()) { Result = new OkResult() }));
        return http.Response.Headers.SetCookie.ToString();
    }

    [Fact]
    public async Task ABrowserSendingABareOrForeignValueGetsItsUsersSignedCookie()
    {
        using var plugin = new ApiPluginFixture();
        plugin.Plugin.Configuration.SpoilerBlurEnabled = true;
        var markers = new SpoilerIdentityService(Mock.Of<IUserManager>(), plugin.Core.Logger, plugin.Core.Paths.Object);
        var alice = Guid.NewGuid();
        var bob = Guid.NewGuid();

        var issued = await SetCookieAfter(markers, alice, alice.ToString("N"));
        Assert.StartsWith("je-spoiler-uid=" + markers.MintCookie(alice) + ";", issued);
        Assert.Contains("path=/", issued);
        Assert.True(markers.TryReadCookie(markers.MintCookie(alice), out var named) && named == alice);

        // Another user's signed value (an account switch the page missed) is replaced as well.
        Assert.StartsWith("je-spoiler-uid=" + markers.MintCookie(alice) + ";", await SetCookieAfter(markers, alice, markers.MintCookie(bob)));
        // The user's own signed value is left alone; a client that sends no cookie (native apps) gets none.
        Assert.Equal(string.Empty, await SetCookieAfter(markers, alice, markers.MintCookie(alice)));
        Assert.Equal(string.Empty, await SetCookieAfter(markers, alice, null));

        // With Spoiler Guard off nothing is issued.
        plugin.Plugin.Configuration.SpoilerBlurEnabled = false;
        Assert.Equal(string.Empty, await SetCookieAfter(markers, alice, alice.ToString("N")));
    }

    [Fact]
    public void OnlyTheExactSignedValueReadsAsItsUser()
    {
        using var plugin = new ApiPluginFixture();
        var markers = new SpoilerIdentityService(Mock.Of<IUserManager>(), plugin.Core.Logger, plugin.Core.Paths.Object);
        var alice = Guid.NewGuid();
        var signed = markers.MintCookie(alice);
        Assert.Matches("^[0-9a-f]{32}\\.[0-9a-f]{32}$", signed);
        Assert.True(markers.TryReadCookie(signed.ToUpperInvariant(), out var named));
        Assert.Equal(alice, named);
        foreach (var forged in new[] { alice.ToString("N"), alice.ToString(), alice.ToString("N") + ".", signed[..^1] + (signed[^1] == '0' ? '1' : '0'),
                     signed + "0", Guid.NewGuid().ToString("N") + signed[32..], Guid.Empty.ToString("N") + signed[32..], "", "." })
        {
            Assert.False(markers.TryReadCookie(forged, out var none), forged);
            Assert.Equal(Guid.Empty, none);
        }
    }
}
