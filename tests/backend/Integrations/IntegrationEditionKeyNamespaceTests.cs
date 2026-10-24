using System.Text.Json;
using System.Text.Json.Nodes;
using Jellyfin.Plugin.JellyfinEnhanced.Controllers;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr;
using P = JE.Tests.IntegrationEditionPressTests;

namespace JE.Tests;

/// <summary>
/// One retry namespace per person (D53, edition round 22): an ask, an administrator's add and every audited arr action share the
/// person's key, told apart by what they are (their identity), never by a key prefix or a store of their own; and the bound
/// client acquisition durable jobs use refuses a connection other than the one recorded, from one registry read.
/// </summary>
[Collection("Plugin singleton")]
public class IntegrationEditionKeyNamespaceTests
{
    private static readonly TitleKey Firefly = TitleKey.Parse("tv:tvdb:78874")!;

    /// <summary>The production wiring: each side refuses a key the other holds.</summary>
    private static void Wire(P.PressRig p)
    {
    }

    private static async Task<JsonObject> FourKSearch(P.PressRig p, string key)
    {
        var page = await p.Page(p.Rig.Admin, p.FourKPage);
        var copy = P.CopyOf(page);
        var instance = copy!.Value.GetProperty("instanceId").GetString()!;
        return new JsonObject
        {
            ["instanceId"] = instance, ["key"] = Firefly.WithEpisode(1, 2).ToString(), ["idempotencyKey"] = key,
            ["expect"] = P.Intent(p.FourKPage, "search", new[] { 2 }, copy, "4k", instance: instance),
        };
    }

    [Fact]
    public async Task AnAsksKeyCannotRunASearchAndASearchsKeyCannotRecordAnAsk()
    {
        using var p = new P.PressRig(seerr: false);
        Wire(p);
        // An ask under "k1", then an administrator's Search under the same key: nothing runs.
        var ask = await p.Requests.CreateAsync(p.Rig.Admin.UserId, new CreateRequest("k1", new MutationInput { Key = Firefly.ToString(), Scope = "episodes", Episodes = new[] { new RequestEpisode(1, 3) } }), default);
        Assert.True(ask.HttpStatus is 200 or 201, JsonSerializer.Serialize(ask));
        var (status, answer) = P.Read(await p.Hub(p.Rig.Admin).Search(Wiring.Body<ManageSearchRequest>((await FourKSearch(p, "k1")).ToJsonString()), default));
        Assert.True(status == 409 && P.Code(answer) == PressChecks.Conflict, $"{status} {answer}");
        Assert.DoesNotContain(p.Rig.Sonarr4k!.Writes, w => w.Path == "/api/v3/command");
        // A Search under "k2", then an ask under it: nothing is recorded.
        Assert.Equal(200, P.Read(await p.Hub(p.Rig.Admin).Search(Wiring.Body<ManageSearchRequest>((await FourKSearch(p, "k2")).ToJsonString()), default)).Status);
        var second = await p.Requests.CreateAsync(p.Rig.Admin.UserId, new CreateRequest("k2", new MutationInput { Key = Firefly.ToString(), Scope = "episodes", Episodes = new[] { new RequestEpisode(1, 4) } }), default);
        Assert.True(second.HttpStatus == 409 && second.Reason == PressChecks.Conflict, JsonSerializer.Serialize(second));
        Assert.Single(p.Ledger.ForTitle(Firefly.ToString()));
    }

    // An administrator's add and an ask under the same key are two requests (the add's operation is part of what the key
    // remembers): the second is a conflict, never the first's receipt.
    [Fact]
    public async Task AnAddAndAnAskUnderOneKeyConflict()
    {
        using var p = new P.PressRig(seerr: false);
        var input = new MutationInput { Key = Firefly.ToString(), Scope = "episodes", Episodes = new[] { new RequestEpisode(1, 3) } };
        var add = await p.Requests.CreateAsync(p.Rig.Admin.UserId, new CreateRequest("sheet-9", input) { Operation = "add" }, default);
        Assert.True(add.HttpStatus is 200 or 201, JsonSerializer.Serialize(add));
        var ask = await p.Requests.CreateAsync(p.Rig.Admin.UserId, new CreateRequest("sheet-9", input), default);
        Assert.True(ask.HttpStatus == 409 && ask.Reason == PressChecks.Conflict, JsonSerializer.Serialize(ask));
        var again = await p.Requests.CreateAsync(p.Rig.Admin.UserId, new CreateRequest("sheet-9", input) { Operation = "add" }, default);
        Assert.True(again.HttpStatus == 200 && again.RequestId == add.RequestId, JsonSerializer.Serialize(again));
    }

    // The durable jobs' acquisition: the instance's client only while its connection is the one recorded, checked and acquired
    // from one registry read; after a save it refuses (nothing is sent to the replacement), and a key change refuses too.
    [Theory]
    [InlineData("url")]
    [InlineData("key")]
    [InlineData("name")]
    public void ABoundAcquisitionRefusesAConnectionOtherThanTheRecordedOne(string change)
    {
        using var p = new P.PressRig(seerr: false);
        var factory = p.Rig.Arr.Factory;
        var instance = p.Rig.Arr.Instance("SonarrZ").Id;
        var recorded = factory.ConnectionGeneration(instance)!;
        var before = factory.For(instance).Value!;
        Assert.Same(before, factory.Bound(instance, recorded).Value);
        var rows = JsonNode.Parse(p.Config.SonarrInstances)!.AsArray();
        var row = rows.First(x => string.Equals((string?)x!["Id"], instance, StringComparison.OrdinalIgnoreCase))!;
        switch (change)
        {
            case "url": row["Url"] = "http://elsewhere.invalid:8989"; break;
            case "key": row["ApiKey"] = "another-synthetic-key"; break;
            default: row["Name"] = "Renamed"; break;
        }
        p.Config.SonarrInstances = rows.ToJsonString();
        var bound = factory.Bound(instance, recorded);
        var checkedClient = factory.Bound(before);
        if (change == "name")
        {
            Assert.True(bound.Ok && checkedClient.Ok, "a rename keeps the connection");
            return;
        }
        Assert.False(bound.Ok);
        Assert.False(checkedClient.Ok);
        Assert.Equal(ArrClientFactory.ConnectionChanged, bound.Error!.Message);
    }
}
