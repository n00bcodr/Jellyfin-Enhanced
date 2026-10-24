using System.Text.Json.Nodes;
using Jellyfin.Plugin.JellyfinEnhanced.Controllers;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;
using P = JE.Tests.IntegrationEditionPressTests;
using M = JE.Tests.IntegrationEditionMaskedTests;
namespace JE.Tests;
[Collection("Plugin singleton")]
public class IntegrationEditionSeerrIsolationTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task AnUnrelatedSonarrCannotRefuseAnOrdinarySeerrAsk(bool down)
    {
        using var p = new P.PressRig(seerr: true);
        p.Rig.Sonarr.Episodes.Add(M.Aired(104,4));
        p.Rig.Sonarr4k!.Episodes.Add(M.Aired(104,4));
        var rows = JsonNode.Parse(p.Config.SonarrInstances)!.AsArray();
        var row = (JsonObject)rows.First(x => (string?)x!["Name"] == "SonarrZ")!.DeepClone();
        var id = Guid.NewGuid().ToString("N");
        row["Id"] = id; row["Name"] = "Unrelated Sonarr"; row["Url"] = "http://unrelated.invalid:8989"; row["IsDefault"] = false; row["ApiKey"] = "synthetic-only";
        rows.Add(row); p.Config.SonarrInstances = rows.ToJsonString();
        var unrelated = p.Rig.Arr.Add("unrelated.invalid", "Sonarr");
        await p.Page(p.Rig.Member,p.StandardPage);
        Assert.Empty(p.Rig.Store.PeekLibrary(id)!.Series);
        if(down) unrelated.FailWith = 503;
        var body = new JsonObject {
            ["clientRequestId"] = "ordinary-seerr",
            ["input"] = new JsonObject { ["key"] = "tv:tvdb:78874", ["scope"] = "seasons", ["variant"] = "standard", ["seasons"] = new JsonArray(1), ["episodes"] = new JsonArray() },
            ["expect"] = P.Intent(p.StandardPage,"get",new[]{4},null,"standard",seasons:new[]{1})
        };
        var result = P.Read(await p.Asks(p.Rig.Member).Create(Wiring.Body<CreateRequest>(body.ToJsonString()),default));
        Assert.True(result.Status is 200 or 201,$"unrelated down={down}; {result.Status} {result.Body}");
    }
    [Theory]
    [InlineData("no_instances")]
    [InlineData("je_download")]
    [InlineData("cold_down")]
    public async Task OrdinarySeerrPressHasNoJeFactsOrConnectionPrerequisites(string change)
    {
        using var p = new P.PressRig(seerr: true);
        p.Rig.Sonarr.Episodes.Add(M.Aired(104, 4)); p.Rig.Sonarr4k!.Episodes.Add(M.Aired(104, 4));
        await p.Page(p.Rig.Member, p.StandardPage);
        if (change == "no_instances") p.Config.SonarrInstances = "[]";
        if (change == "je_download")
        {
            var row = FakeArr.SonarrQueueRow(104, "je-only", 1, 4, "Firefly", 78874); row["seriesId"] = 1; p.Rig.Sonarr.Queue.Add(row);
            await p.Rig.Store.ReadQueueNowAsync(p.Rig.Arr.Instance("SonarrZ"), default);
        }
        if (change == "cold_down") p.Rig.Sonarr.FailWith = p.Rig.Sonarr4k.FailWith = 503;
        var before = p.Rig.Arr.CallCount("sonarr.lan") + p.Rig.Arr.CallCount("sonarr4k.lan");
        var body = new JsonObject {
            ["clientRequestId"] = "ordinary-independent",
            ["input"] = new JsonObject { ["key"] = "tv:tvdb:78874", ["scope"] = "seasons", ["variant"] = "standard", ["seasons"] = new JsonArray(1) },
            ["expect"] = P.Intent(p.StandardPage, "get", new[] { 4 }, null, "standard", seasons: new[] { 1 })
        };
        var result = P.Read(await p.Asks(p.Rig.Member).Create(Wiring.Body<CreateRequest>(body.ToJsonString()), default));
        Assert.True(result.Status is 200 or 201, result.Body.ToString());
        Assert.Equal(before, p.Rig.Arr.CallCount("sonarr.lan") + p.Rig.Arr.CallCount("sonarr4k.lan"));
        Assert.Null(p.Db.Read(c => { using var cmd = c.CreateCommand(); cmd.CommandText = "SELECT binding FROM retry_owners WHERE retry_key='ordinary-independent'"; return cmd.ExecuteScalar() is DBNull ? null : cmd.ExecuteScalar(); }));
    }

    [Theory]
    [InlineData("standard")]
    [InlineData("4k")]
    public async Task OrdinarySeerrFormsKeepTheirEditionWithoutAnyJeInstances(string edition)
    {
        using var p = new P.PressRig(seerr: true);
        p.Config.SonarrInstances = "[]";
        var result = await p.Requests.CreateAsync(p.Rig.Member.UserId, new CreateRequest("ordinary-form", new MutationInput
            { Key = "tv:tvdb:78874", Scope = "seasons", Seasons = new[] { 1 }, Variant = edition }), default);
        Assert.True(result.HttpStatus is 200 or 201);
        var job = Assert.Single(p.Ledger.ForWant(result.RequestId!));
        Assert.Equal(edition, job.Input.Variant); Assert.Equal("seerr", job.Authorization.Backend);
        Assert.Equal("", job.Authorization.InstanceId);
    }

}
