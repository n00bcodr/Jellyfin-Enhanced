using System.Reflection;
using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Controllers;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Backends;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;

namespace JE.Tests;

[Collection("Plugin singleton")]
public class IntegrationRequestedTitlesEnvelopeTests
{
    private static async Task<IActionResult> Read(RequestsBackendController controller, DateTimeOffset? from = null, DateTimeOffset? to = null)
    {
        var method = typeof(RequestsBackendController).GetMethod(nameof(RequestsBackendController.RequestedTitles))!;
        // Keep the grouping regression runnable against the original no-window action.
        if (method.GetParameters().Length == 0)
        {
            Assert.Null(from); Assert.Null(to);
            return await (Task<IActionResult>)method.Invoke(controller, null)!;
        }
        return await (Task<IActionResult>)method.Invoke(controller, new object?[] { from, to })!;
    }

    private static JsonElement Body(IActionResult result) => JsonSerializer.SerializeToElement(Assert.IsAssignableFrom<ObjectResult>(result).Value, new JsonSerializerOptions(JsonSerializerDefaults.Web));

    [Fact]
    public async Task SoleRouteGroupsOwnEditionAndScopeFactsWithDurableAliasesAndPartialCompleteness()
    {
        using var r = new IntegrationRequestLedgerTests.Rig();
        using var arr = new FakeArr(); using var store = arr.Store();
        r.Policy.Adjust = (_, _, facts) => facts with { Can4k = true };
        Assert.Equal(201, (await r.Create(input: IntegrationRequestLedgerTests.Movie())).HttpStatus);
        Assert.Equal(201, (await r.Create(input: IntegrationRequestLedgerTests.Movie(603, "4k"))).HttpStatus);
        Assert.Equal(201, (await r.Create(input: IntegrationRequestLedgerTests.Seasons(1))).HttpStatus);
        Assert.Equal(201, (await r.Create(input: new MutationInput { Key = "tv:tmdb:1437", Variant = "4k", Scope = "episodes", Episodes = new[] { new RequestEpisode(2, 3) } })).HttpStatus);
        r.Ledger.Unify(new[] { "tv:tvdb:78874", "tv:tmdb:1437", "tv:imdb:tt0303461" }, r.Policy, r.Now);
        r.Ledger.Unify(new[] { "movie:tmdb:603", "movie:imdb:tt0133093" }, r.Policy, r.Now);
        await r.Create(r.Kid, IntegrationRequestLedgerTests.Movie(604));
        var config = arr.Plugin.Plugin.Configuration;
        config.ArrBackendIsolationVersion = 1; config.ArrRequestBackend = "je";
        config.ArrIntegrationEnabled = config.ArrPhase1Enabled = config.ArrPhase3Enabled = false;
        var projection = new RequestedTitlesProjection(r.Ledger, new TitleAliases(store, null), r.Policy, r.View);
        var controller = new RequestsBackendController(projection, r.View) { ControllerContext = new() { HttpContext = new DefaultHttpContext() } };
        controller.HttpContext.User = TestCallers.Principal(r.Member, false);
        var result = await Read(controller);
        Assert.IsType<OkObjectResult>(result);
        var json = Body(result);
        Assert.True(json.GetProperty("available").GetBoolean()); Assert.True(json.GetProperty("complete").GetBoolean());
        Assert.Equal(JsonValueKind.Null, json.GetProperty("reason").ValueKind);
        var titles = json.GetProperty("titles").EnumerateArray().ToArray();
        Assert.Equal(2, titles.Length);
        var movie = titles.Single(t => t.GetProperty("mediaType").GetString() == "movie");
        Assert.Equal(603, movie.GetProperty("tmdbId").GetInt32());
        Assert.Equal(new[] { "4k", "standard" }, movie.GetProperty("parts").EnumerateArray().Select(p => p.GetProperty("variant").GetString()).OrderBy(x => x));
        Assert.Contains("movie:imdb:tt0133093", movie.GetProperty("aliases").EnumerateArray().Select(a => a.GetString()));
        var tv = titles.Single(t => t.GetProperty("mediaType").GetString() == "tv");
        Assert.Equal("tv:tmdb:1437", tv.GetProperty("key").GetString());
        Assert.Contains("tv:tvdb:78874", tv.GetProperty("aliases").EnumerateArray().Select(a => a.GetString()));
        Assert.Contains("tv:imdb:tt0303461", tv.GetProperty("aliases").EnumerateArray().Select(a => a.GetString()));
        var parts = tv.GetProperty("parts").EnumerateArray().ToArray();
        Assert.Equal(2, parts.Length);
        Assert.Contains(parts, p => p.GetProperty("scope").GetString() == "seasons" && p.GetProperty("seasons")[0].GetInt32() == 1);
        Assert.Contains(parts, p => p.GetProperty("scope").GetString() == "episodes" && p.GetProperty("episodes")[0].GetProperty("season").GetInt32() == 2);
        Assert.All(parts, p => Assert.False(string.IsNullOrEmpty(p.GetProperty("status").GetString())));
        Assert.Equal(201, (await r.Create(input: new MutationInput { Key = "movie:imdb:tt999999998" })).HttpStatus);
        var partial = await Read(controller);
        Assert.Equal(200, Assert.IsType<OkObjectResult>(partial).StatusCode);
        var unavailable = Body(partial);
        Assert.False(unavailable.GetProperty("complete").GetBoolean()); Assert.True(unavailable.GetProperty("retryable").GetBoolean());
        Assert.Equal("identity_unresolved", unavailable.GetProperty("reason").GetString());
        Assert.Equal(2, unavailable.GetProperty("titles").GetArrayLength());
        Assert.Equal("2", controller.Response.Headers.RetryAfter);
    }

    [Fact]
    public async Task OptionalWindowEchoesUtcAndGatesOnlyCalendarWithoutFilteringHistoricalInterests()
    {
        using var r = new IntegrationRequestLedgerTests.Rig();
        using var arr = new FakeArr(); using var store = arr.Store();
        await r.Create();
        var config = arr.Plugin.Plugin.Configuration;
        config.ArrBackendIsolationVersion = 1; config.ArrRequestBackend = "je";
        config.CalendarPageEnabled = true;
        config.ArrIntegrationEnabled = config.ArrPhase1Enabled = config.ArrPhase3Enabled = false;
        var projection = new RequestedTitlesProjection(r.Ledger, new TitleAliases(store, null), r.Policy, r.View);
        var controller = new RequestsBackendController(projection, r.View) { ControllerContext = new() { HttpContext = new DefaultHttpContext() } };
        controller.HttpContext.User = TestCallers.Principal(r.Member, false);
        var from = DateTimeOffset.Parse("2020-01-01T08:00:00+08:00"); var to = from.AddDays(366);
        var json = Body(Assert.IsType<OkObjectResult>(await Read(controller, from, to)));
        Assert.Equal(from.UtcDateTime, json.GetProperty("from").GetDateTimeOffset().UtcDateTime);
        Assert.Equal(TimeSpan.Zero, json.GetProperty("to").GetDateTimeOffset().Offset);
        Assert.Single(json.GetProperty("titles").EnumerateArray());
        foreach (var bounds in new (DateTimeOffset?, DateTimeOffset?)[] { (from, null), ((DateTimeOffset?)null, to), (from, from), (from, from.AddDays(-1)), (from, from.AddDays(367)) })
            Assert.IsType<BadRequestObjectResult>(await Read(controller, bounds.Item1, bounds.Item2));
        config.CalendarPageEnabled = false;
        var disabled = Assert.IsType<ObjectResult>(await Read(controller, from, to));
        Assert.Equal(503, disabled.StatusCode); Assert.Equal("calendar_disabled", Body(disabled).GetProperty("reason").GetString());
        Assert.IsType<OkObjectResult>(await Read(controller));
        controller.HttpContext.User = TestCallers.Principal(Guid.NewGuid(), false);
        Assert.Equal(403, Assert.IsType<ObjectResult>(await Read(controller, from, to)).StatusCode);
    }
}
