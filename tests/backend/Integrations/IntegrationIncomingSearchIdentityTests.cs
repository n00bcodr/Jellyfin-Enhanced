using System.Text.Json.Nodes;
using Jellyfin.Plugin.JellyfinEnhanced.Controllers;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;
using P = JE.Tests.IntegrationEditionPressTests;

namespace JE.Tests;

[Collection("Plugin singleton")]
public class IntegrationIncomingSearchIdentityTests
{
    [Theory]
    [InlineData("mode")]
    [InlineData("whole")]
    [InlineData("seasons")]
    [InlineData("instance")]
    [InlineData("instance_sentinel")]
    [InlineData("copy")]
    [InlineData("variant")]
    [InlineData("page")]
    [InlineData("episodes")]
    public async Task AChangedIncomingFieldNeverReplaysAHouseholdSearch(string field)
    {
        using var p = new P.PressRig(false);
        var (intent, _) = await IntegrationEditionPressIdentityTests.FiftyOneMissing(p);
        const string key = "tv:tvdb:78874:s1";
        var first = await p.Search.SearchAsync(p.Rig.Member, key, "incoming", default, intent);
        Assert.Equal("searched", first.Outcome.Reason);
        var changed = field switch
        {
            "mode" => intent with { Mode = "get" },
            "whole" => intent with { Whole = !intent.Whole },
            "seasons" => intent with { Seasons = new[] { 1 } },
            "instance" => intent with { Instance = "another" },
            "instance_sentinel" => intent with { Instance = "-" },
            "copy" => intent with { Copy = "4k" },
            "variant" => intent with { Variant = "4k" },
            "page" => intent with { Item = Guid.NewGuid().ToString("N") },
            _ => intent with { Episodes = intent.Episodes!.Skip(1).ToArray() },
        };
        var retry = await p.Search.SearchAsync(p.Rig.Member, key, "incoming", default, changed);
        Assert.Equal(409, retry.Outcome.HttpStatus); Assert.Equal(PressChecks.Conflict, retry.Outcome.Reason);
        p.Policy.Before = (_, _) => throw new InvalidOperationException("An exact receipt must not externally revalidate.");
        var exact = await p.Search.SearchAsync(p.Rig.Member, key, "incoming", default, intent);
        Assert.Equal("searched", exact.Outcome.Reason);
        Assert.Single(p.Rig.Sonarr.Writes, w => w.Path == "/api/v3/command");
    }
    [Theory]
    [InlineData("mode")]
    [InlineData("routing")]
    [InlineData("legacy_episodes")]
    public async Task AnAdminSearchComparesItsWholeIncomingRequestBeforeItsProof(string field)
    {
        using var p = new P.PressRig(false);
        var (_, _, body) = await IntegrationEditionPressIdentityTests.FourKSearch(p, "admin-incoming");
        if (field == "legacy_episodes")
        {
            body.Remove("expect"); body["key"] = "tv:tvdb:78874:s1"; body["episodes"] = new JsonArray(2);
        }
        var original = body.ToJsonString();
        var (first, receipt) = P.Read(await p.Hub(p.Rig.Admin).Search(Wiring.Body<ManageSearchRequest>(original), default));
        Assert.Equal(200, first);
        if (field == "mode") body["expect"]!["mode"] = "get";
        else if (field == "routing") body["instanceId"] = "another";
        else body["episodes"] = new JsonArray(3);
        var (status, answer) = P.Read(await p.Hub(p.Rig.Admin).Search(Wiring.Body<ManageSearchRequest>(body.ToJsonString()), default));
        Assert.Equal(409, status); Assert.Equal(PressChecks.Conflict, P.Code(answer));
        p.Rig.Sonarr4k!.FailWith = 503;
        var (retry, replay) = P.Read(await p.Hub(p.Rig.Admin).Search(Wiring.Body<ManageSearchRequest>(original), default));
        Assert.Equal(200, retry); Assert.Equal(receipt.GetProperty("auditId").GetString(), replay.GetProperty("auditId").GetString());
        Assert.Single(p.Rig.Sonarr4k.Writes, w => w.Path == "/api/v3/command");
    }

}
