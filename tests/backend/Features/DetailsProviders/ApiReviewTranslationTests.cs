using System.Text.Json;
using Microsoft.AspNetCore.Mvc;
using Jellyfin.Plugin.JellyfinEnhanced.Features.DetailsProviders.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Features.DetailsProviders;

namespace JE.Tests.Features.DetailsProviders;

[Collection("Plugin singleton")]
public class ApiReviewTranslationTests
{
    private static async Task<(ObjectResult Result, JeDetailsProvidersController Controller)> Translate(int status, string? retryAfter)
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
        var controller = (JeDetailsProvidersController)ApiAssetTests.Controller(typeof(JeDetailsProvidersController), f.Core, new ReviewTranslationService(transport, f.Core.Logger));
        var result = await controller.TranslateReview(new JeDetailsProvidersController.TranslateRequest { Text = "Hello", Target = "de" }, default);
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

    // The route is open to every signed-in account and spends the administrator's key, so each client
    // gets a bounded share: requests and characters per window, answered as a rate limit with the wait.
    [Fact]
    public async Task EachClientHasABoundedTranslationBudget()
    {
        using var f = new ApiPluginFixture();
        f.Plugin.Configuration.ReviewTranslationEnabled = true;
        f.Plugin.Configuration.ReviewTranslationUrl = "http://127.0.0.1:5000/";
        var forwarded = 0;
        using var transport = new IntegrationTransport(async (request, _) =>
        {
            Interlocked.Increment(ref forwarded);
            var pieces = JsonDocument.Parse(await request.Content!.ReadAsStringAsync()).RootElement.GetProperty("q").GetArrayLength();
            return IntegrationTransport.Response(JsonSerializer.Serialize(new { translatedText = Enumerable.Repeat("Hallo", pieces) }));
        });
        var service = new ReviewTranslationService(transport, f.Core.Logger);
        async Task<ObjectResult> Send(string address, int length, int n)
        {
            var controller = (JeDetailsProvidersController)ApiAssetTests.Controller(typeof(JeDetailsProvidersController), f.Core, service);
            controller.HttpContext.Connection.RemoteIpAddress = System.Net.IPAddress.Parse(address);
            var text = $"Review {n} " + new string('x', length);
            return Assert.IsAssignableFrom<ObjectResult>(await controller.TranslateReview(new JeDetailsProvidersController.TranslateRequest { Text = text[..length], Target = "de" }, default));
        }

        // 60 translations and 100,000 characters per client in 10 minutes.
        for (var n = 0; n < 60; n++)
        {
            Assert.Equal(200, (await Send("192.0.2.10", 100, n)).StatusCode);
        }

        var limited = await Send("192.0.2.10", 100, -1);
        Assert.Equal(429, limited.StatusCode);
        Assert.Equal("translation_rate_limited", Body(limited).GetProperty("code").GetString());
        Assert.InRange(Body(limited).GetProperty("retryAfterSeconds").GetInt32(), 1, 600);
        Assert.Equal(60, forwarded);

        for (var n = 0; n < 5; n++)
        {
            Assert.Equal(200, (await Send("192.0.2.11", ReviewTranslationService.MaxTextLength, n)).StatusCode);
        }

        Assert.Equal(429, (await Send("192.0.2.11", ReviewTranslationService.MaxTextLength, -1)).StatusCode);
        Assert.Equal(200, (await Send("192.0.2.12", 100, 0)).StatusCode);
    }

    // Behind a reverse proxy Jellyfin was not told about, every request comes from the proxy's address: the share
    // belongs to the signed-in account, so one account spending its own leaves the others theirs.
    [Fact]
    public async Task EachSignedInAccountHasItsOwnTranslationBudgetOnASharedAddress()
    {
        using var f = new ApiPluginFixture();
        f.Plugin.Configuration.ReviewTranslationEnabled = true;
        f.Plugin.Configuration.ReviewTranslationUrl = "http://127.0.0.1:5000/";
        using var transport = new IntegrationTransport(async (request, _) =>
        {
            var pieces = JsonDocument.Parse(await request.Content!.ReadAsStringAsync()).RootElement.GetProperty("q").GetArrayLength();
            return IntegrationTransport.Response(JsonSerializer.Serialize(new { translatedText = Enumerable.Repeat("Hallo", pieces) }));
        });
        var service = new ReviewTranslationService(transport, f.Core.Logger);
        var alice = Guid.NewGuid();
        var bob = Guid.NewGuid();
        async Task<int?> Send(Guid user, string address, int n)
        {
            var controller = (JeDetailsProvidersController)ApiAssetTests.Controller(typeof(JeDetailsProvidersController), f.Core, service);
            controller.HttpContext.Connection.RemoteIpAddress = System.Net.IPAddress.Parse(address);
            controller.HttpContext.User = new System.Security.Claims.ClaimsPrincipal(new System.Security.Claims.ClaimsIdentity([
                new System.Security.Claims.Claim("Jellyfin-UserId", user.ToString()), new System.Security.Claims.Claim(System.Security.Claims.ClaimTypes.Role, "User")], "test"));
            var result = await controller.TranslateReview(new JeDetailsProvidersController.TranslateRequest { Text = $"Review {n}", Target = "de" }, default);
            return Assert.IsAssignableFrom<ObjectResult>(result).StatusCode;
        }

        for (var n = 0; n < ReviewTranslationService.ClientRequestsPerWindow; n++)
        {
            Assert.Equal(200, await Send(alice, "192.0.2.20", n));
        }

        Assert.Equal(429, await Send(alice, "192.0.2.20", -1));
        // Another account on the same address still has its whole share...
        Assert.Equal(200, await Send(bob, "192.0.2.20", 0));
        // ...and the spent share follows its account to another address.
        Assert.Equal(429, await Send(alice, "192.0.2.21", -2));
    }
}
