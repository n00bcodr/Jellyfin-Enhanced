using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Controllers;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Microsoft.AspNetCore.Mvc;

namespace JE.Tests;

[Collection("Plugin singleton")]
public class ApiReviewTranslationTests
{
    private static async Task<(ObjectResult Result, JellyfinEnhancedController Controller)> Translate(int status, string? retryAfter)
    {
        using var f = new ApiPluginFixture();
        f.Plugin.Configuration.ReviewTranslationEnabled = true;
        f.Plugin.Configuration.ReviewTranslationUrl = "http://127.0.0.1:5000/";
        using var transport = new IntegrationTransport((_, _) =>
        {
            var response = IntegrationTransport.Response("{\"error\":\"Slowdown\"}", status);
            if (retryAfter != null) response.Headers.Add("Retry-After", retryAfter);
            return Task.FromResult(response);
        });
        var controller = ApiAssetTests.Controller(f.Core, new ReviewTranslationService(transport, f.Core.Logger));
        var result = await controller.TranslateReview(new JellyfinEnhancedController.TranslateRequest { Text = "Hello", Target = "de" }, default);
        return (Assert.IsAssignableFrom<ObjectResult>(result), controller);
    }

    private static JsonElement Body(ObjectResult result) => JsonSerializer.SerializeToElement(result.Value);

    [Fact]
    public async Task RateLimitIsPassedOnAs429WithTheWait()
    {
        var (result, controller) = await Translate(429, "42");
        Assert.Equal(429, result.StatusCode);
        Assert.Equal("42", controller.Response.Headers.RetryAfter.ToString());
        var body = Body(result);
        Assert.Equal("translation_rate_limited", body.GetProperty("code").GetString());
        Assert.Equal(42, body.GetProperty("retryAfterSeconds").GetInt32());
    }

    [Fact]
    public async Task RateLimitWithoutAWaitHasNoRetryAfter()
    {
        var (result, controller) = await Translate(429, null);
        Assert.Equal(429, result.StatusCode);
        Assert.False(controller.Response.Headers.ContainsKey("Retry-After"));
        Assert.Equal(JsonValueKind.Null, Body(result).GetProperty("retryAfterSeconds").ValueKind);
    }

    [Fact]
    public async Task RefusalIsA502WithItsOwnCodeAndOtherFailuresAreUnchanged()
    {
        var (refused, _) = await Translate(403, null);
        Assert.Equal(502, refused.StatusCode);
        Assert.Equal("translation_refused", Body(refused).GetProperty("code").GetString());

        var (failed, _) = await Translate(500, null);
        Assert.Equal(502, failed.StatusCode);
        Assert.Equal("Failed to translate the review.", failed.Value);
    }
}
