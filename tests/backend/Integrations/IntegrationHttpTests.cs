using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers.Jellyseerr;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Model;

namespace JE.Tests;

public class IntegrationSeerrTests
{
    [Fact]
    public async Task RequestCarriesIdentityAndJsonWithoutPuttingSecretsInUrl()
    {
        using var request = SeerrHttpHelper.BuildRequest(HttpMethod.Post, "http://127.0.0.1/api/v1/request", "secret", "27", "{\"mediaId\":12}");
        Assert.Equal("secret", Assert.Single(request.Headers.GetValues("X-Api-Key")));
        Assert.Equal("27", Assert.Single(request.Headers.GetValues("X-Api-User")));
        Assert.Equal("application/json", request.Content!.Headers.ContentType!.MediaType);
        Assert.Equal("{\"mediaId\":12}", await request.Content.ReadAsStringAsync());
        Assert.DoesNotContain("secret", request.RequestUri!.ToString());
        Assert.NotEmpty(request.Headers.UserAgent);
    }

    [Theory]
    [InlineData(200, "application/json", null)]
    [InlineData(200, "application/problem+json", null)]
    [InlineData(200, "text/html", SeerrErrorCode.HtmlResponse)]
    [InlineData(401, "application/json", SeerrErrorCode.Unauthorized)]
    [InlineData(403, "application/json", SeerrErrorCode.Forbidden)]
    [InlineData(429, "application/json", SeerrErrorCode.UpstreamError)]
    [InlineData(500, "application/json", SeerrErrorCode.UpstreamError)]
    [InlineData(520, "text/html", SeerrErrorCode.Cloudflare5xx)]
    [InlineData(530, "application/json", SeerrErrorCode.Cloudflare5xx)]
    public async Task ResponseClassificationAndPublicErrorsDoNotDiscloseUpstream(int status, string type, SeerrErrorCode? expected)
    {
        using var response = IntegrationTransport.Response("{}", status, type);
        response.Headers.Add("cf-ray", "private-ray");
        var (json, error) = await SeerrHttpHelper.ReadResponseAsync(response, "https://private.internal:5055");
        if (expected == null) { Assert.Equal("{}", json); Assert.Null(error); return; }
        Assert.Null(json);
        Assert.Equal(expected, error!.Code);
        Assert.Equal(status, error.HttpStatus);
        Assert.Equal("private-ray", error.CfRay);
        var publicJson = JsonSerializer.Serialize(error.ToResponseShape());
        Assert.DoesNotContain("private.internal", publicJson);
        Assert.DoesNotContain("private-ray", publicJson);
        Assert.Contains("private.internal", JsonSerializer.Serialize(error.ToAdminResponseShape()));
    }

    [Fact]
    public async Task RedirectIsRejectedBeforeLoginPageParsing()
    {
        using var response = IntegrationTransport.Response("<html>login</html>", 302, "text/html");
        response.Headers.Location = new Uri("https://login.invalid");
        var result = await SeerrHttpHelper.ReadResponseAsync(response, "http://127.0.0.1");
        Assert.Equal(SeerrErrorCode.UpstreamRedirect, result.Error!.Code);
        Assert.Null(result.Json);
    }

    [Theory]
    [InlineData("{")]
    [InlineData("<html>login</html>")]
    [InlineData("[]")]
    public void InvalidProviderPayloadProducesSafeParseError(string json)
    {
        var result = SeerrHttpHelper.TryDeserialize<Dictionary<string, int>>(json, "https://private.internal");
        Assert.Null(result.Result);
        Assert.Equal(SeerrErrorCode.ParseError, result.Error!.Code);
        Assert.DoesNotContain("private.internal", JsonSerializer.Serialize(result.Error.ToResponseShape()));
    }
}
