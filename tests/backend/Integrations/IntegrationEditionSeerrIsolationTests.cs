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
}
