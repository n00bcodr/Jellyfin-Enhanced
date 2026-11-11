using System.Security.Claims;
using Jellyfin.Plugin.JellyfinEnhanced.Features.Seerr;
using Microsoft.AspNetCore.Mvc;

namespace JE.Tests.Features.Seerr;

/// <summary>
/// GET tmdb/validate checks a TMDB key the administrator typed. A key in the query string lands in Jellyfin's
/// request log and any proxy's; the route also takes it in the X-Arr-ApiKey header, as its sibling validate routes do.
/// </summary>
[Collection("Plugin singleton")]
public class ApiTmdbValidateTests
{
    private static async Task<(IActionResult Result, List<Uri> Sent)> Validate(string? query, string? header, bool admin = true)
    {
        using var plugin = new ApiPluginFixture();
        var sent = new List<Uri>();
        using var transport = new IntegrationTransport((request, _) =>
        {
            sent.Add(request.RequestUri!);
            return Task.FromResult(IntegrationTransport.Response("{}", request.RequestUri!.Query.Contains("api_key=good", StringComparison.Ordinal) ? 200 : 401));
        });
        var controller = (JeSeerrController)ApiAssetTests.Controller(typeof(JeSeerrController), plugin.Core, transport);
        controller.HttpContext.User = new ClaimsPrincipal(new ClaimsIdentity([
            new Claim("Jellyfin-UserId", Guid.NewGuid().ToString()), new Claim(ClaimTypes.Role, admin ? "Administrator" : "User")], "test"));
        if (header != null) controller.HttpContext.Request.Headers["X-Arr-ApiKey"] = header;
        return (await controller.ValidateTmdb(query), sent);
    }

    [Fact]
    public async Task AKeyInTheHeaderIsValidatedLikeOneInTheQuery()
    {
        var (fromHeader, sent) = await Validate(null, "good");
        Assert.Equal(200, Assert.IsAssignableFrom<ObjectResult>(fromHeader).StatusCode);
        Assert.Single(sent);
        Assert.Equal(401, Assert.IsAssignableFrom<ObjectResult>((await Validate(null, "bad")).Result).StatusCode);

        // The query string keeps working.
        Assert.Equal(200, Assert.IsAssignableFrom<ObjectResult>((await Validate("good", null)).Result).StatusCode);
        // Neither: refused before anything is sent; still administrators only.
        var (missing, none) = await Validate(null, null);
        Assert.Equal(400, Assert.IsAssignableFrom<ObjectResult>(missing).StatusCode);
        Assert.Empty(none);
        var (forbidden, notSent) = await Validate(null, "good", admin: false);
        Assert.IsType<ForbidResult>(forbidden);
        Assert.Empty(notSent);
    }
}
