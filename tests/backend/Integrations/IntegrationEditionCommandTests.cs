using System.Text.Json;
using System.Text.Json.Nodes;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Controllers;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Globalization;
using Moq;
using P = JE.Tests.IntegrationEditionPressTests;

namespace JE.Tests;

/// <summary>
/// Edition round 21 (D53): the check of a season page's press RETURNS the command that runs, and only that command runs, is
/// recorded and is fingerprinted. An administrator's Search runs the Sonarr ids of the episode list read at the check; a
/// request field that routes elsewhere than the checked destination is refused before anything is recorded; a retry key
/// replays only the identical press (the same key with another press is a conflict). Fresh means complete evidence from the
/// instances the press depends on: an incomplete queue read never proves "nothing is downloading", and an outage of an
/// instance of the other edition never refuses a press.
/// </summary>
[Collection("Plugin singleton")]
public class IntegrationEditionCommandTests
{
    private static readonly TitleKey Firefly = TitleKey.Parse("tv:tvdb:78874")!;

    private static int Commands(FakeArr.Host host) => host.Writes.Count(w => w.Path == "/api/v3/command");

    private static ManageSearchRequest AdminSearch(P.PressRig p, JsonElement? copy, string instance, int episode, string retry)
        => Wiring.Body<ManageSearchRequest>(new JsonObject
        {
            ["instanceId"] = instance, ["key"] = Firefly.WithEpisode(1, episode).ToString(), ["idempotencyKey"] = retry,
            ["expect"] = P.Intent(p.FourKPage, "search", new[] { episode }, copy, "4k", instance: instance),
        }.ToJsonString());

    private static JsonObject AskBody(Guid page, JsonElement? copy, string variant, int episode, string id)
        => new()
        {
            ["clientRequestId"] = id,
            ["input"] = new JsonObject
            {
                ["key"] = Firefly.ToString(), ["scope"] = "episodes", ["variant"] = variant,
                ["episodes"] = new JsonArray(new JsonObject { ["season"] = 1, ["episode"] = episode }),
            },
            ["expect"] = P.Intent(page, "get", new[] { episode }, copy, variant),
        };

    // ------------------------------------------------------------------ the command is what the check returned

    [Fact]
    public async Task AnAdministratorsSearchRunsTheEpisodeIdsOfTheEpisodeListReadAtTheCheck()
    {
        using var p = new P.PressRig(seerr: false);
        var page = await p.Page(p.Rig.Admin, p.FourKPage);
        var copy = P.CopyOf(page);
        var instance = copy!.Value.GetProperty("instanceId").GetString()!;
        // The page was drawn with E2 as Sonarr id 102 (in memory). A metadata refresh then renumbers that row to E4 and gives
        // E2 a new id: the search must name E2's id as Sonarr has it at the check, never the id remembered before it.
        var old = p.Rig.Sonarr4k!.Episodes.Single(e => (int)e["id"]! == 102);
        old["episodeNumber"] = 4;
        var renumbered = (JsonObject)old.DeepClone();
        renumbered["id"] = 202;
        renumbered["episodeNumber"] = 2;
        p.Rig.Sonarr4k.Episodes.Add(renumbered);
        var (status, answer) = P.Read(await p.Hub(p.Rig.Admin).Search(AdminSearch(p, copy, instance, 2, "renumbered-before-press"), default));
        Assert.Equal(200, status);
        var command = JsonNode.Parse(Assert.Single(p.Rig.Sonarr4k.Writes, w => w.Path == "/api/v3/command").Body)!;
        Assert.True(command["episodeIds"]!.AsArray().Select(n => (int)n!).SequenceEqual(new[] { 202 }), $"E2 is id 202 now (102 is E4): {command}; {answer}");
    }

    public static TheoryData<string> RoutingFields() => new() { "another instance", "a root folder", "a quality profile" };

    [Theory]
    [MemberData(nameof(RoutingFields))]
    public async Task AnAskWhoseInputRoutesElsewhereThanTheCheckedDestinationIsRefusedAndNothingIsRecorded(string field)
    {
        using var p = new P.PressRig(seerr: false);
        var library = new FakeLibraryAccess();
        var root = library.AddLibrary("TV", "tvshows", "/media/tv", "/media/tv4k");
        var rows = JsonNode.Parse(p.Config.SonarrInstances)!.AsArray();
        var alternate = (JsonObject)rows.First(x => (string?)x!["Name"] == "SonarrZ")!.DeepClone();
        var alternateId = Guid.NewGuid().ToString("N");
        alternate["Id"] = alternateId;
        alternate["Name"] = "Another standard Sonarr";
        alternate["Url"] = "http://sonarr-another.invalid:8989";
        alternate["LinkedLibraryIds"] = new JsonArray(root.Id);
        rows.Add(alternate);
        p.Config.SonarrInstances = rows.ToJsonString();
        p.Rig.Arr.Add("sonarr-another.invalid", "Sonarr");
        var page = await p.Page(p.Rig.Admin, p.StandardPage);
        var copy = P.CopyOf(page);
        Assert.True(copy!.Value.GetProperty("ask").GetBoolean());
        // The production request policy (an administrator may route an ordinary ask), so the routing field is honoured unless
        // the press refuses it.
        var users = new Mock<IUserManager>();
        users.Setup(u => u.GetUserById(p.Rig.Admin.UserId)).Returns((User)p.Rig.Admin.Handle!);
        var server = new Mock<IServerConfigurationManager>();
        server.SetupGet(s => s.Configuration).Returns(new ServerConfiguration());
        var parental = new SeerrParentalFilter(p.Rig.Arr.Transport, users.Object, new Mock<ILocalizationManager>().Object, server.Object, p.Rig.Arr.Plugin.Core.Logger);
        var policy = new RequestPolicy(p.Rig.View, p.Rig.Store, new ArrInstanceLibraries(p.Rig.Store, library),
            new TitleAliases(p.Rig.Store, null), parental, p.Rig.Arr.Factory, new UnavailableRequestBackend());
        var service = new RequestService(p.Ledger, policy, p.Rig.View, p.Feed, () => p.Rig.Arr.Now);
        var controller = p.Controller(Wiring.Make<AcquireRequestsController>(service, p.Search, p.Status), p.Rig.Admin);
        var body = AskBody(p.StandardPage, copy, "standard", 3, "ask-routes-elsewhere");
        var input = (JsonObject)body["input"]!;
        switch (field)
        {
            case "another instance": input["instanceId"] = alternateId; break;
            case "a root folder": input["rootFolder"] = "/media/tv4k"; break;
            default: input["profileId"] = 4; break;
        }
        var (status, answer) = P.Read(await controller.Create(Wiring.Body<CreateRequest>(body.ToJsonString()), default));
        var want = p.Ledger.ForTitle(Firefly.ToString()).FirstOrDefault();
        var target = want == null ? null : p.Ledger.ForWant(want.Id).FirstOrDefault()?.Authorization.InstanceId;
        Assert.True(status == 409 && P.Code(answer) == PressChecks.Changed, $"{field}: checked the default Sonarr, recorded target {target}: {status} {answer}");
        Assert.Empty(p.Ledger.ForTitle(Firefly.ToString()));
    }

    // ------------------------------------------------------------------ a retry key replays only the identical press

    [Fact]
    public async Task AnAdministratorsRetryKeyReusedForAnotherEpisodeIsAConflictNotTheFirstReceipt()
    {
        using var p = new P.PressRig(seerr: false);
        var page = await p.Page(p.Rig.Admin, p.FourKPage);
        var copy = P.CopyOf(page);
        var instance = copy!.Value.GetProperty("instanceId").GetString()!;
        var (first, _) = P.Read(await p.Hub(p.Rig.Admin).Search(AdminSearch(p, copy, instance, 2, "admin-key-reused"), default));
        Assert.Equal(200, first);
        // The same key for E4 (a title-wide press, no copy) is another press: refused, never E2's receipt, nothing runs.
        var (second, answer) = P.Read(await p.Hub(p.Rig.Admin).Search(AdminSearch(p, null, instance, 4, "admin-key-reused"), default));
        Assert.True(second == 409, $"E2's key reused for E4: {second} {answer}");
        Assert.Equal(1, Commands(p.Rig.Sonarr4k!));
        // The identical press still replays (before any check).
        var (again, replayed) = P.Read(await p.Hub(p.Rig.Admin).Search(AdminSearch(p, copy, instance, 2, "admin-key-reused"), default));
        Assert.True(again == 200 && replayed.GetProperty("replayed").GetBoolean(), $"{again} {replayed}");
        Assert.Equal(1, Commands(p.Rig.Sonarr4k!));
    }

    [Fact]
    public async Task AnAdministratorsRetryKeyIsTheirOwn()
    {
        using var p = new P.PressRig(seerr: false);
        var page = await p.Page(p.Rig.Admin, p.FourKPage);
        var copy = P.CopyOf(page);
        var instance = copy!.Value.GetProperty("instanceId").GetString()!;
        var body = AdminSearch(p, copy, instance, 2, "another-admins-key");
        Assert.Equal(200, P.Read(await p.Hub(p.Rig.Admin).Search(body, default)).Status);
        var other = p.Rig.View.AddUser(admin: true);
        var (status, answer) = P.Read(await p.Hub(other).Search(body, default));
        Assert.Equal(200, status);
        Assert.False(answer.GetProperty("replayed").GetBoolean());
        Assert.Equal(2, Commands(p.Rig.Sonarr4k!));
    }

    [Fact]
    public async Task AHouseholdRetryKeyReusedForAnotherEpisodeIsAConflictNotTheFirstReceipt()
    {
        using var p = new P.PressRig(seerr: false);
        var input = new MutationInput { Key = Firefly.ToString(), Scope = "episodes", Episodes = new[] { new RequestEpisode(1, 3) } };
        Assert.True((await p.Requests.CreateAsync(p.Rig.Member.UserId, new("household-sent", input), default)).HttpStatus is 200 or 201);
        await new RequestOutbox(p.Ledger, p.Policy, new IntegrationRequestLedgerTests.Backend(), new RequestTitleLocks(), p.Feed,
            new ArrAuditLog(Path.Combine(p.Rig.Arr.Plugin.Core.Root, "command-outbox.jsonl"), 100000, 1), () => p.Rig.Arr.Now).TickAsync(default);
        p.Rig.Sonarr.Episodes.Single(e => (int)e["id"]! == 103)["monitored"] = true;
        p.Rig.Arr.Now = p.Rig.Arr.Now.AddDays(3);
        await p.Rig.Store.RefreshLibraryNowAsync(p.Rig.Arr.Instance("SonarrZ"), default);
        var page = await p.Page(p.Rig.Member, p.StandardPage);
        var body = new JsonObject
        {
            ["key"] = Firefly.WithEpisode(1, 3).ToString(), ["idempotencyKey"] = "household-key-reused",
            ["expect"] = P.Intent(p.StandardPage, "search", new[] { 3 }, P.CopyOf(page), "standard"),
        };
        var (first, receipt) = P.Read(await p.Asks(p.Rig.Member).Search(Wiring.Body<RequestSearchBody>(body.ToJsonString()), default));
        Assert.True(first == 200 && P.Code(receipt) == "searched", $"{first} {receipt}");
        body["key"] = Firefly.WithEpisode(1, 4).ToString();
        body["expect"] = P.Intent(p.StandardPage, "search", new[] { 4 }, null, "standard");
        var (second, answer) = P.Read(await p.Asks(p.Rig.Member).Search(Wiring.Body<RequestSearchBody>(body.ToJsonString()), default));
        Assert.True(second == 409, $"E3's key reused for E4: {second} {answer}");
        Assert.Equal(1, Commands(p.Rig.Sonarr));
    }

    [Fact]
    public async Task AnAskRetryKeyReusedFromAnotherPageOrCopyIsAConflict()
    {
        using var p = new P.PressRig(seerr: false);
        var page = await p.Page(p.Rig.Member, p.FourKPage);
        var body = AskBody(p.FourKPage, P.CopyOf(page), "4k", 2, "ask-key-reused");
        var (first, _) = P.Read(await p.Asks(p.Rig.Member).Create(Wiring.Body<CreateRequest>(body.ToJsonString()), default));
        Assert.True(first is 200 or 201);
        // The same input under the same key, now presented as another page's title-wide control: not the original press.
        body["expect"] = P.Intent(p.StandardPage, "get", new[] { 2 }, null, "4k");
        var (second, answer) = P.Read(await p.Asks(p.Rig.Member).Create(Wiring.Body<CreateRequest>(body.ToJsonString()), default));
        Assert.True(second == 409 && P.Code(answer) == "idempotency_conflict", $"same key and input, another press: {second} {answer}");
        Assert.Single(p.Ledger.ForTitle(Firefly.ToString()));
    }

    // ------------------------------------------------------------------ fresh = complete evidence from the press's own dependencies

    [Fact]
    public async Task AnIncompleteQueueReadAtTheCheckLeavesThePressUnverified()
    {
        using var p = new P.PressRig(seerr: false);
        var page = await p.Page(p.Rig.Member, p.FourKPage);
        // Sonarr 4K has just started downloading E2, but its queue now reads short (rows moved between pages): the held
        // complete (empty) queue is kept for display, and is no evidence at the check.
        var row = FakeArr.SonarrQueueRow(102, "new-grab", 1, 2, "Firefly", 78874);
        row["seriesId"] = p.Rig.Sonarr4k!.Series[0]["id"]!.DeepClone();
        p.Rig.Sonarr4k.Queue.Add(row);
        p.Rig.Sonarr4k.ReportedTotal = (path, total) => path.EndsWith("/queue", StringComparison.Ordinal) ? 1000 : total;
        var body = AskBody(p.FourKPage, P.CopyOf(page), "4k", 2, "partial-queue");
        var (status, answer) = P.Read(await p.Asks(p.Rig.Member).Create(Wiring.Body<CreateRequest>(body.ToJsonString()), default));
        Assert.True(status == 409 && P.Code(answer) == PressChecks.Unverified, $"incomplete queue at the check: {status} {answer}");
        Assert.Empty(p.Ledger.ForTitle(Firefly.ToString()));
    }

    [Fact]
    public async Task AQueueReadRunningBeforeThePressIsWaitedForAndThenReadAgain()
    {
        using var p = new P.PressRig(seerr: false);
        var page = await p.Page(p.Rig.Member, p.FourKPage);
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var reads = 0;
        p.Rig.Sonarr4k!.Before = async (path, ct) =>
        {
            if (!path.EndsWith("/queue", StringComparison.Ordinal)) return;
            if (Interlocked.Increment(ref reads) == 1)
            {
                started.TrySetResult();
                await release.Task.WaitAsync(ct);
            }
            else if (p.Rig.Sonarr4k.Queue.Count == 0)
            {
                var row = FakeArr.SonarrQueueRow(102, "after-prior-read", 1, 2, "Firefly", 78874);
                row["seriesId"] = p.Rig.Sonarr4k.Series[0]["id"]!.DeepClone();
                p.Rig.Sonarr4k.Queue.Add(row);
            }
        };
        var prior = p.Rig.Store.RefreshForEventAsync(p.Rig.Arr.Instance("Sonarr4kZ").Id, ArrSnapshotKind.Queue, force: true);
        await started.Task.WaitAsync(TimeSpan.FromSeconds(5));
        var intent = Wiring.Body<PressIntent>(P.Intent(p.FourKPage, "get", new[] { 2 }, P.CopyOf(page), "4k").ToJsonString());
        var input = new MutationInput { Key = Firefly.ToString(), Scope = "episodes", Variant = "4k", Episodes = new[] { new RequestEpisode(1, 2) } };
        var pressing = p.Status.PressAsync(p.Rig.Member, intent, PressChecks.Ask, input, null, default);
        release.TrySetResult();
        await prior;
        var proof = await pressing;
        Assert.True(reads >= 2);
        Assert.Equal(PressChecks.Changed, proof.Refusal);
    }

    public static TheoryData<string, string> Outages() => new()
    {
        { "4k", "standard" },  // a healthy 4K ask while the standard Sonarr answers 503
        { "standard", "4k" },  // a healthy standard ask while Sonarr 4K answers 503
    };

    [Theory]
    [MemberData(nameof(Outages))]
    public async Task AnOutageOfTheOtherEditionsSonarrNeverRefusesAPress(string edition, string down)
    {
        using var p = new P.PressRig(seerr: false);
        var fourK = edition == "4k";
        var pageId = fourK ? p.FourKPage : p.StandardPage;
        var page = await p.Page(p.Rig.Member, pageId);
        var body = AskBody(pageId, P.CopyOf(page), edition, fourK ? 2 : 3, "outage-elsewhere-" + edition);
        (down == "standard" ? p.Rig.Sonarr : p.Rig.Sonarr4k!).FailWith = 503;
        var (status, answer) = P.Read(await p.Asks(p.Rig.Member).Create(Wiring.Body<CreateRequest>(body.ToJsonString()), default));
        Assert.True(status is 200 or 201, $"{edition} ask with the {down} Sonarr down: {status} {answer}");
    }

    [Fact]
    public async Task AnOutageOfThePresssOwnDestinationStillLeavesItUnverified()
    {
        using var p = new P.PressRig(seerr: false);
        var page = await p.Page(p.Rig.Member, p.FourKPage);
        var body = AskBody(p.FourKPage, P.CopyOf(page), "4k", 2, "outage-own");
        p.Rig.Sonarr4k!.FailWith = 503;
        var (status, answer) = P.Read(await p.Asks(p.Rig.Member).Create(Wiring.Body<CreateRequest>(body.ToJsonString()), default));
        Assert.True(status == 409 && P.Code(answer) == PressChecks.Unverified, $"{status} {answer}");
        Assert.Empty(p.Ledger.ForTitle(Firefly.ToString()));
    }
}
