using System.Text.Json;
using System.Text.Json.Nodes;
using Jellyfin.Data;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Controllers;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr;
using P = JE.Tests.IntegrationEditionPressTests;
using M = JE.Tests.IntegrationEditionMaskedTests;

namespace JE.Tests;

/// <summary>
/// A press discovers who holds the title now (D53, edition round 22): ownership, paths, ids and holder membership are read
/// fresh from the instances the press can depend on, never from a library index held in memory (a moved series, a newly
/// holding instance); then the viewer's eligible copies decide which instances it depends on, so a copy the viewer can't
/// open never refuses (or reveals) anything, while an eligible holder or the destination that can't be read still does.
/// </summary>
[Collection("Plugin singleton")]
public class IntegrationEditionEligibleDependenciesTests
{
    private static readonly TitleKey Firefly = TitleKey.Parse("tv:tvdb:78874")!;

    private static JsonObject Ask(Guid page, JsonElement? copy, int ep, string id) => new()
    {
        ["clientRequestId"] = id,
        ["input"] = new JsonObject { ["key"] = Firefly.ToString(), ["scope"] = "episodes", ["variant"] = "standard", ["episodes"] = new JsonArray(new JsonObject { ["season"] = 1, ["episode"] = ep }) },
        ["expect"] = P.Intent(page, "get", new[] { ep }, copy, "standard"),
    };

    /// <summary>Adds a standard-role (or <paramref name="role"/>) Sonarr on <paramref name="host"/>, configured like the rig's standard one.</summary>
    private static (FakeArr.Host Host, string Id) AddSonarr(P.PressRig p, string name, string host, string role = "standard", JsonArray? linked = null, JsonArray? mappings = null)
    {
        var rows = JsonNode.Parse(p.Config.SonarrInstances)!.AsArray();
        var row = (JsonObject)rows.First(x => (string?)x!["Name"] == "SonarrZ")!.DeepClone();
        var id = Guid.NewGuid().ToString("N");
        row["Id"] = id; row["Name"] = name; row["Url"] = "http://" + host + ":8989"; row["IsDefault"] = false; row["ApiKey"] = "synthetic-test-fixture"; row["Role"] = role;
        if (linked != null) row["LinkedLibraryIds"] = linked;
        if (mappings != null) row["PathMappings"] = mappings;
        rows.Add(row);
        p.Config.SonarrInstances = rows.ToJsonString();
        return (p.Rig.Arr.Add(host, "Sonarr"), id);
    }

    // library index still says the old folder; the press reads where the series is now and refuses.
    [Fact]
    public async Task ASearchNeverValidatesOwnershipFromAHeldSeriesPath()
    {
        using var p = new P.PressRig(seerr: false);
        var page = await p.Page(p.Rig.Admin, p.FourKPage);
        var copy = P.CopyOf(page);
        var instance = copy!.Value.GetProperty("instanceId").GetString()!;
        var body = new JsonObject
        {
            ["instanceId"] = instance, ["key"] = Firefly.WithEpisode(1, 2).ToString(), ["idempotencyKey"] = "moved-path",
            ["expect"] = P.Intent(p.FourKPage, "search", new[] { 2 }, copy, "4k", instance: instance),
        };
        p.Rig.Sonarr4k!.Series[0]["path"] = p.Rig.Sonarr.Series[0]["path"]!.DeepClone();
        var (status, answer) = P.Read(await p.Hub(p.Rig.Admin).Search(Wiring.Body<ManageSearchRequest>(body.ToJsonString()), default));
        var writes = p.Rig.Sonarr4k.Writes.Count(w => w.Path == "/api/v3/command");
        // Control: once the actual current path is in memory too, the same intent refuses the same way.
        await p.Rig.Store.RefreshLibraryNowAsync(p.Rig.Arr.Instance("Sonarr4kZ"), default);
        body["idempotencyKey"] = "after-path-refresh";
        var (fresh, freshBody) = P.Read(await p.Hub(p.Rig.Admin).Search(Wiring.Body<ManageSearchRequest>(body.ToJsonString()), default));
        Assert.Equal(409, fresh);
        Assert.True(status == 409 && writes == 0, $"Held ownership ran {writes} command(s) against a moved series: {status} {answer}; after library refresh: {fresh} {freshBody}");
    }

    // downloading E4. Its fresh queue is read at the press, which refuses (E4 is no longer missing with nothing under way).
    [Fact]
    public async Task ANewlyHoldingSameEditionInstanceIsReadAtThePress()
    {
        using var p = new P.PressRig(seerr: false);
        p.Rig.Sonarr.Episodes.Add(M.Aired(104, 4));
        p.Rig.Sonarr4k!.Episodes.Add(M.Aired(104, 4));
        var (late, lateId) = AddSonarr(p, "SonarrLate", "sonarr-late.invalid");
        Assert.True(p.Rig.Arr.Instance("SonarrLate").Usable);
        var page = await p.Page(p.Rig.Member, p.StandardPage);
        Assert.NotNull(p.Rig.Store.PeekLibrary(lateId));
        var series = (JsonObject)p.Rig.Sonarr.Series[0].DeepClone();
        series["id"] = 77; series["path"] = "/data/late/Firefly";
        late.Series.Add(series); late.Episodes.Add(M.Aired(104, 4));
        var q = FakeArr.SonarrQueueRow(104, "late-grab", 1, 4, "Firefly", 78874); q["seriesId"] = 77; late.Queue.Add(q);
        var before = p.Rig.Arr.CallCount("sonarr-late.invalid", "/queue");
        var (status, answer) = P.Read(await p.Asks(p.Rig.Member).Create(Wiring.Body<CreateRequest>(Ask(p.StandardPage, null, 4, "new-holder").ToJsonString()), default));
        var reads = p.Rig.Arr.CallCount("sonarr-late.invalid", "/queue") - before;
        Assert.True(status == 409, $"New holder ignored; fresh queue reads={reads}; {status} {answer}");
        Assert.Empty(p.Ledger.ForTitle(Firefly.ToString()));
    }

    /// <summary>
    /// The member's healthy standard copy (library "TV") and a standard copy in a library they can't open ("Adults"), held by
    /// a Sonarr of its own linked to that library (<paramref name="privateLinkedToOpen"/>: linked to "TV" instead, so the
    /// member may use what it holds).
    /// </summary>
    private static async Task<(int Code, JsonElement Body)> PrivateHolderPress(bool down, bool privateLinkedToOpen = false, string role = "standard", bool previouslyAsked = false)
    {
        using var p = new P.PressRig(seerr: false);
        var libraries = new FakeLibraryAccess();
        var open = libraries.AddLibrary("TV", "tvshows", "/media/tv", "/media/tv4k");
        var closed = libraries.AddLibrary("Adults", "tvshows", "/media/private");
        ((User)p.Rig.Member.Handle!).SetPreference(PreferenceKind.BlockedMediaFolders, new[] { closed.Id });
        var rows = JsonNode.Parse(p.Config.SonarrInstances)!.AsArray();
        foreach (var row in rows) row!["LinkedLibraryIds"] = new JsonArray(open.Id);
        p.Config.SonarrInstances = rows.ToJsonString();
        var (privateSonarr, id) = AddSonarr(p, "Private standard", "private-standard.invalid", role,
            new JsonArray(privateLinkedToOpen ? open.Id : closed.Id), new JsonArray(new JsonObject { ["ArrPath"] = "/data/private", ["JellyfinPath"] = "/media/private" }));
        var series = (JsonObject)p.Rig.Sonarr.Series[0].DeepClone(); series["path"] = "/data/private/Firefly"; privateSonarr.Series.Add(series);
        Assert.Contains(p.Rig.Store.Instances(ArrKind.Sonarr), i => i.Id == id);
        var privateCopy = Guid.NewGuid();
        p.Rig.View.AddCopy(Firefly, new JfCopy { ItemId = privateCopy, Path = "/media/private/Firefly", LibraryId = closed.Id, LibraryName = closed.Name }, p.Rig.Admin.UserId);
        using var seerr = new FakeSeerr();
        var readModel = new SeerrFacts(seerr.Transport, null, null, () => p.Config, () => p.Rig.Arr.Now);
        var requestFacts = new LedgerRequestFacts(p.Ledger, readModel, new TitleAliases(p.Rig.Store, readModel), () => p.Rig.Arr.Now);
        if (previouslyAsked)
        {
            var first = await p.Requests.CreateAsync(p.Rig.Member.UserId, new CreateRequest("older-own-ask", new MutationInput { Key = Firefly.ToString(), Scope = "episodes", Episodes = new[] { new RequestEpisode(1,5) } }), default);
            Assert.True(first.HttpStatus is 200 or 201, $"earlier ask: {first.HttpStatus}/{first.Reason}");
            Assert.True(requestFacts.AskedBy(Firefly, p.Rig.Member.UserId));
        }
        var status = Wiring.Make<ArrStatusService>(p.Rig.Store, p.Rig.View, requestFacts, new ArrInstanceLibraries(p.Rig.Store, libraries),
            (Func<Jellyfin.Plugin.JellyfinEnhanced.Configuration.PluginConfiguration?>)(() => p.Config), (Func<DateTimeOffset>)(() => p.Rig.Arr.Now));
        await status.ForItemAsync(p.Rig.Member, p.StandardPage, default);
        var page = Assert.Single(M.Items(await status.ForItemAsync(p.Rig.Member, p.StandardPage, default)));
        var copy = P.CopyOf(page);
        Assert.True(copy!.Value.GetProperty("ask").GetBoolean(), page.ToString());
        Assert.False(p.Rig.View.Copies(Firefly, p.Rig.Member).Seen.Single(c => c.ItemId == privateCopy).Visible);
        if (down) privateSonarr.FailWith = 503;
        var input = new MutationInput { Key = Firefly.ToString(), Scope = "episodes", Episodes = new[] { new RequestEpisode(1, 3) } };
        var expect = Wiring.Body<PressIntent>(P.Intent(p.StandardPage, "get", new[] { 3 }, copy, "standard").ToJsonString());
        var controller = p.Controller(Wiring.Make<AcquireRequestsController>(p.Requests, status), p.Rig.Member);
        return P.Read(await controller.Create(new CreateRequest("inaccessible-instance", input) { Expect = expect }, default));
    }

    // change anything the member's press does, so the healthy copy's Get it goes through (the up cell is the control) and
    // says nothing about the hidden copy.
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task AnInaccessibleSameEditionCopyCannotRefuseTheHealthyCopysPress(bool down)
    {
        var (code, result) = await PrivateHolderPress(down);
        Assert.True(code is 200 or 201, $"private copy down={down}: {code} {result}");
        Assert.DoesNotContain("Private", result.ToString(), StringComparison.Ordinal);
    }

    // The same Sonarr linked to the member's own library (it may hold a copy they can use), or labelled anime (its holdings
    // can't be told apart by label): it can't be read, so the press is unverified, not accepted on a guess.
    [Theory]
    [InlineData("standard")]
    [InlineData("anime")]
    public async Task AnEligibleHolderThatCannotBeReadLeavesThePressUnverified(string role)
    {
        var (code, result) = await PrivateHolderPress(down: true, privateLinkedToOpen: true, role: role);
        Assert.True(code == 409 && P.Code(result) == PressChecks.Unverified, $"{role}: {code} {result}");
    }
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task APreviousAskDoesNotMakeTheInaccessibleHolderADependency(bool previouslyAsked)
    {
        var (code, result) = await PrivateHolderPress(down: true, previouslyAsked: previouslyAsked);
        Assert.True(code is 200 or 201, $"previouslyAsked={previouslyAsked}: {code} {result}");
    }
}
