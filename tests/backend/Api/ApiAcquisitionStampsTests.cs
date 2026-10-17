using System.Security.Claims;
using System.Text.Json;
using System.Text.RegularExpressions;
using Jellyfin.Plugin.JellyfinEnhanced.Controllers;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Stamps;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;

namespace JE.Tests;

/// <summary>
/// Phase 4e: <c>GET acquire/stamps</c>, the web's acquisition badges. A person first, then the switch; ids checked and
/// capped; a person who turned badges off gets an empty list; items the caller can't open are left out; private and
/// revalidated with an ETag.
/// </summary>
public class ApiAcquisitionStampsTests
{
    private static readonly DateTime T0 = StampWorld.T0;

    private sealed class Preferences : IAcquisitionBadgePreferences
    {
        public Dictionary<Guid, bool?> Web { get; } = new();

        public bool? WebBadges(Guid user) => Web.TryGetValue(user, out var value) ? value : null;
    }

    private sealed class Rig : IDisposable
    {
        public StampWorld W { get; } = new();
        public FakeJellyfinView View { get; } = new();
        public Preferences Prefs { get; } = new();
        public Guid Person { get; }

        public Rig()
        {
            Person = View.AddUser(admin: false).UserId;
        }

        public AcquisitionStampsController Controller(ClaimsPrincipal caller, string? ifNoneMatch = null)
        {
            var controller = new AcquisitionStampsController(W.Resolver, W.Library, View, Prefs) { Config = () => W.Config };
            controller.ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext { User = caller } };
            if (ifNoneMatch != null) controller.Request.Headers["If-None-Match"] = ifNoneMatch;
            return controller;
        }

        public ClaimsPrincipal Me => TestCallers.Principal(Person, admin: false);

        public void Dispose() => W.Dispose();
    }

    private static string Code(IActionResult result) => JsonSerializer.Serialize(((ObjectResult)result).Value);

    private static JsonElement Body(IActionResult result)
    {
        var file = Assert.IsType<FileContentResult>(result);
        Assert.StartsWith("application/json", file.ContentType, StringComparison.Ordinal);
        return JsonDocument.Parse(file.FileContents).RootElement.Clone();
    }

    [Fact]
    public void ApiKeysAndUnknownUsersAreNoPersonEvenBeforeTheSwitchIsChecked()
    {
        using var rig = new Rig();
        foreach (var on in new[] { false, true })
        {
            rig.W.Config.ArrPhase4AcquisitionBadgesEnabled = on;
            foreach (var caller in new[] { TestCallers.ApiKey(), TestCallers.Unknown() })
            {
                var result = rig.Controller(caller).GetStamps(Guid.NewGuid().ToString("N"));
                Assert.Equal(403, ((ObjectResult)result).StatusCode);
                Assert.Contains("user_required", Code(result), StringComparison.Ordinal);
            }
        }
    }

    [Fact]
    public void APersonIsRefusedWhileTheSwitchIsOff()
    {
        using var rig = new Rig();
        rig.W.Config.ArrPhase4AcquisitionBadgesEnabled = false;
        var result = rig.Controller(rig.Me).GetStamps(Guid.NewGuid().ToString("N"));
        Assert.Equal(403, ((ObjectResult)result).StatusCode);
        Assert.Contains("feature_disabled", Code(result), StringComparison.Ordinal);

        rig.W.Config = StampWorld.On();
        rig.W.Config.ArrPhase4Enabled = false;
        Assert.Contains("feature_disabled", Code(rig.Controller(rig.Me).GetStamps(null)), StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("not-a-guid")]
    [InlineData("00000000000000000000000000000000")]
    [InlineData("0123456789abcdef0123456789abcdef,x")]
    public void AnInvalidIdIsABadRequest(string ids)
    {
        using var rig = new Rig();
        var result = rig.Controller(rig.Me).GetStamps(ids);
        Assert.Equal(400, ((ObjectResult)result).StatusCode);
        Assert.Contains("invalid_id", Code(result), StringComparison.Ordinal);
    }

    [Fact]
    public void AtMostAHundredDistinctIdsAreAccepted()
    {
        using var rig = new Rig();
        var hundred = Enumerable.Range(0, 100).Select(_ => Guid.NewGuid().ToString("N")).ToList();
        Assert.IsType<FileContentResult>(rig.Controller(rig.Me).GetStamps(string.Join(",", hundred)));
        Assert.IsType<FileContentResult>(rig.Controller(rig.Me).GetStamps(string.Join(",", hundred.Append(hundred[0]))));   // a repeat isn't another id

        var result = rig.Controller(rig.Me).GetStamps(string.Join(",", hundred.Append(Guid.NewGuid().ToString("N"))));
        Assert.Equal(400, ((ObjectResult)result).StatusCode);
        Assert.Contains("too_many", Code(result), StringComparison.Ordinal);
    }

    [Fact]
    public void TheAnswerNamesEachStampedItemTheCallerCanOpenAndNothingElse()
    {
        using var rig = new Rig();
        var w = rig.W;
        var asked = w.AddMovie(StampWorld.Movie(1), T0);
        var upgraded = w.AddMovie(StampWorld.Movie(2), T0.AddDays(-30));
        var standard = w.AddMovie(StampWorld.Movie(3), T0.AddDays(-30));
        w.AddMovie(StampWorld.Movie(3), T0.AddDays(-20), fourK: true);
        var plain = w.AddMovie(StampWorld.Movie(4), T0.AddDays(-30));
        var hidden = w.AddMovie(StampWorld.Movie(5), T0.AddDays(-30));
        w.Store.AddNew(rig.Person, asked, T0, "request");
        w.Store.AddUpgraded(upgraded, T0, "radarr:1");
        w.Store.AddUpgraded(hidden, T0, "radarr:2");
        w.Library.Deny(rig.Person, hidden.Id);
        w.Now = T0.AddHours(1);

        var ids = string.Join(",", new[] { upgraded, asked, standard, plain, hidden }.Select(i => i.Id.ToString("D").ToUpperInvariant())) + "," + Guid.NewGuid();
        var body = Body(rig.Controller(rig.Me).GetStamps(ids));

        Assert.Equal(JsonValueKind.Object, body.ValueKind);
        Assert.Equal(new[] { "items" }, body.EnumerateObject().Select(p => p.Name));
        var items = body.GetProperty("items").EnumerateArray().ToList();
        Assert.All(items, i =>
        {
            Assert.Equal(new[] { "itemId", "stamp" }, i.EnumerateObject().Select(p => p.Name));
            Assert.Matches(new Regex("^[0-9a-f]{32}$"), i.GetProperty("itemId").GetString());
        });
        Assert.Equal(
            new[] { (upgraded.Id.ToString("N"), "upgraded"), (asked.Id.ToString("N"), "new"), (standard.Id.ToString("N"), "fourK") },
            items.Select(i => (i.GetProperty("itemId").GetString()!, i.GetProperty("stamp").GetString()!)));

        // Someone else sees the household's upgrade and the 4K copy, never another person's New.
        var other = rig.View.AddUser(admin: false).UserId;
        var theirs = Body(rig.Controller(TestCallers.Principal(other, admin: false)).GetStamps(ids)).GetProperty("items").EnumerateArray()
            .Select(i => i.GetProperty("stamp").GetString()).ToList();
        Assert.Equal(new[] { "upgraded", "fourK", "upgraded" }, theirs);
    }

    [Fact]
    public void APersonWhoTurnedBadgesOffGetsAnEmptyList()
    {
        using var rig = new Rig();
        var upgraded = rig.W.AddMovie(StampWorld.Movie(2), T0.AddDays(-30));
        rig.W.Store.AddUpgraded(upgraded, T0, "radarr:1");
        rig.W.Now = T0.AddHours(1);

        rig.Prefs.Web[rig.Person] = true;
        Assert.Single(Body(rig.Controller(rig.Me).GetStamps(upgraded.Id.ToString("N"))).GetProperty("items").EnumerateArray());
        rig.Prefs.Web[rig.Person] = false;
        var result = rig.Controller(rig.Me).GetStamps(upgraded.Id.ToString("N"));
        Assert.Empty(Body(result).GetProperty("items").EnumerateArray());
    }

    [Fact]
    public void TheAnswerIsPrivateRevalidatedAndAnswersNotModifiedForTheSameETag()
    {
        using var rig = new Rig();
        var upgraded = rig.W.AddMovie(StampWorld.Movie(2), T0.AddDays(-30));
        rig.W.Store.AddUpgraded(upgraded, T0, "radarr:1");
        rig.W.Now = T0.AddHours(1);
        var ids = upgraded.Id.ToString("N");

        var controller = rig.Controller(rig.Me);
        Body(controller.GetStamps(ids));
        Assert.Equal("private, no-cache", controller.Response.Headers.CacheControl.ToString());
        var etag = controller.Response.Headers.ETag.ToString();
        Assert.Matches(new Regex("^\"[0-9a-f]{24}\"$"), etag);

        var again = rig.Controller(rig.Me, ifNoneMatch: etag);
        var notModified = again.GetStamps(ids);
        Assert.Equal(304, Assert.IsAssignableFrom<StatusCodeResult>(notModified).StatusCode);
        Assert.Equal(etag, again.Response.Headers.ETag.ToString());

        // The answer changes (the stamp expired): a new ETag, and the old one no longer matches.
        rig.W.Now = T0.AddDays(8);
        var changed = rig.Controller(rig.Me, ifNoneMatch: etag);
        Assert.Empty(Body(changed.GetStamps(ids)).GetProperty("items").EnumerateArray());
        Assert.NotEqual(etag, changed.Response.Headers.ETag.ToString());
    }
}
