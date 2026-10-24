using System.Text.Json.Nodes;
using Jellyfin.Plugin.JellyfinEnhanced.Controllers;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;

namespace JE.Tests;

/// <summary>Manage Add must carry its choices through shared approval and durable dispatch.</summary>
[Collection("Plugin singleton")]
public class IntegrationArrAddChoicesTests
{
    private static IntegrationRequestLedgerTests.Rig Requests(IntegrationRequestBackendsTests.Lab lab)
    {
        var rig = new IntegrationRequestLedgerTests.Rig();
        rig.Policy.Adjust = (_, input, facts) =>
        {
            var instance = lab.Instance(TitleKey.Parse(input.Key)!.IsMovie ? "Radarr" : "Sonarr");
            return facts with { InstanceId = instance.Id, ConnectionGeneration = lab.Arr.Factory.ConnectionGeneration(instance.Id)! };
        };
        return rig;
    }

    private static ArrAddController Controller(IntegrationRequestBackendsTests.Lab lab, IntegrationRequestLedgerTests.Rig rig)
        => new(new ArrAddService(lab.Store, lab.Arr.Factory, rig.Service, () => lab.Config))
        {
            ControllerContext = new() { HttpContext = new DefaultHttpContext { User = TestCallers.Principal(rig.Admin, true) } },
        };

    private static RequestOutcome Outcome(IActionResult result)
        => Assert.IsType<RequestOutcome>(Assert.IsType<ObjectResult>(result).Value);

    private static MutationInput Input(bool movie)
        => movie ? new() { Key = "movie:tmdb:961" } : new() { Key = "tv:tvdb:75565", Scope = "seasons", Seasons = new[] { 1 } };

    private static FakeArr.Host Title(IntegrationRequestBackendsTests.Lab lab, bool movie)
    {
        var host = movie ? lab.Radarr : lab.Sonarr;
        host.Lookup.Add(movie ? IntegrationRequestBackendsTests.Lab.MovieLookup(961) : IntegrationRequestBackendsTests.Lab.SeriesLookup(75565));
        host.RootFolders.Add(new JsonObject { ["path"] = "/selected", ["freeSpace"] = 1_000_000_000_000L, ["accessible"] = true });
        return host;
    }

    private static ManageAddRequest Sheet(IntegrationRequestBackendsTests.Lab lab, bool movie, int? profile = 5, string? root = "/selected", string id = "sheet-choices")
        => new()
        {
            InstanceId = lab.Instance(movie ? "Radarr" : "Sonarr").Id,
            Key = Input(movie).Key,
            Seasons = Input(movie).Seasons,
            ProfileId = profile,
            RootFolder = root,
            IdempotencyKey = id,
        };

    private static void Added(FakeArr.Host host, bool movie, int profile = 5, string root = "/selected")
    {
        var write = Assert.Single(host.Writes, w => w.Method == "POST" && w.Path == (movie ? "/api/v3/movie" : "/api/v3/series"));
        var body = JsonNode.Parse(write.Body)!;
        Assert.Equal(profile, (int)body["qualityProfileId"]!);
        Assert.Equal(root, (string)body["rootFolderPath"]!);
        Assert.True((bool)body["monitored"]!);
        Assert.True((bool)body["addOptions"]![movie ? "searchForMovie" : "searchForMissingEpisodes"]!);
    }

    private static IEnumerable<int> Monitored(JsonNode series)
        => series["seasons"]!.AsArray().Where(s => (bool)s!["monitored"]!).Select(s => (int)s!["seasonNumber"]!).OrderBy(s => s);

    private static string Charges(IntegrationRequestLedgerTests.Rig rig, string want)
        => rig.Db.Read(c =>
        {
            using var command = c.CreateCommand();
            command.CommandText = "SELECT json_group_array(json_object('id',id,'user',user_id,'cost',cost,'gb',estimated_gb,'state',state,'at',charged_at,'sequence',charge_seq,'scope',scope,'episodes',episode_count,'pool',pool_id)) FROM reservations WHERE want_id=$id";
            command.Parameters.AddWithValue("$id", want);
            return (string)command.ExecuteScalar()!;
        });

    [Theory]
    [InlineData(true, "direct")]
    [InlineData(false, "direct")]
    [InlineData(true, "shared")]
    [InlineData(false, "shared")]
    [InlineData(true, "sharedHeld")]
    [InlineData(false, "sharedHeld")]
    [InlineData(true, "approve")]
    [InlineData(false, "approve")]
    public async Task ControllerAddWithoutDefaultsSendsExplicitChoicesThroughApproval(bool movie, string path)
    {
        using var lab = new IntegrationRequestBackendsTests.Lab(defaults: false);
        using var rig = Requests(lab);
        var host = Title(lab, movie);
        RequestOutcome? pending = null;
        if (path != "direct")
        {
            pending = Outcome(await rig.Controller(rig.Kid).Create(new("viewer", Input(movie)), default));
            Assert.Equal("pending", rig.Ledger.Find(pending.RequestId!)!.Status);
            if (path == "sharedHeld")
            {
                Assert.Equal(200, Outcome(await rig.Controller(rig.Admin).Approve(pending.RequestId!, null, default)).HttpStatus);
                await rig.Runner(lab.Direct).TickAsync(default);
                Assert.Equal(("parked", "invalid_defaults"), (Assert.Single(rig.Ledger.ForWant(pending.RequestId!)).State, Assert.Single(rig.Ledger.ForWant(pending.RequestId!)).Reason));
            }
        }
        var sheet = Sheet(lab, movie);
        var result = path == "approve"
            ? Outcome(await rig.Controller(rig.Admin).Approve(pending!.RequestId!, new(Input(movie) with { InstanceId = sheet.InstanceId, ProfileId = sheet.ProfileId, RootFolder = sheet.RootFolder }), default))
            : Outcome(await Controller(lab, rig).Add(sheet, default));
        Assert.InRange(result.HttpStatus, 200, 201);
        var owner = pending?.RequestId ?? result.RequestId!;
        var job = Assert.Single(rig.Ledger.ForWant(owner), j => j.State == "queued");
        Assert.Equal((sheet.InstanceId, 5, "/selected"), (job.Input.InstanceId, job.Input.ProfileId, job.Input.RootFolder));
        Assert.Equal((5, "/selected"), (rig.Ledger.Find(owner)!.Input.ProfileId, rig.Ledger.Find(owner)!.Input.RootFolder));
        if (pending != null) Assert.Equal(rig.Kid, job.Authorization.Requester);
        await rig.Runner(lab.Direct).TickAsync(default);
        Added(host, movie);
        if (!movie) Assert.Equal(new[] { 1 }, Monitored(Assert.Single(host.Series)));
        Assert.Equal("sent", rig.Ledger.Find(owner)!.Status);
        if (path != "approve")
        {
            Assert.Equal(200, Outcome(await Controller(lab, rig).Add(sheet, default)).HttpStatus);
            await rig.Runner(lab.Direct).TickAsync(default);
            Added(host, movie); // the same sheet never adds or searches twice
        }
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task ControllerSharedAddKeepsChoicesOnOutboxRetryAfterDatabaseReopen(bool movie)
    {
        using var lab = new IntegrationRequestBackendsTests.Lab(defaults: false);
        using var rig = Requests(lab);
        var host = Title(lab, movie);
        var pending = Outcome(await rig.Controller(rig.Kid).Create(new("viewer", Input(movie)), default));
        Assert.InRange(Outcome(await Controller(lab, rig).Add(Sheet(lab, movie), default)).HttpStatus, 200, 201);
        var job = Assert.Single(rig.Ledger.ForWant(pending.RequestId!));
        host.FailWith = 503;
        await rig.Runner(lab.Direct).TickAsync(default);
        Assert.Equal("retry", Assert.Single(rig.Ledger.ForWant(pending.RequestId!)).State);
        Assert.Empty(host.Writes);
        rig.Reopen();
        host.FailWith = 0;
        lab.Edit(movie ? "Radarr" : "Sonarr", row => row["Defaults"] = IntegrationRequestBackendsTests.Lab.Defaults(4, movie ? "/data/movies" : "/data/tv"));
        rig.Now = rig.Now.AddMinutes(10);
        await rig.Runner(lab.Direct).TickAsync(default);
        var sent = Assert.Single(rig.Ledger.ForWant(pending.RequestId!));
        Assert.Equal((job.Id, "succeeded", 5, "/selected"), (sent.Id, sent.State, sent.Input.ProfileId, sent.Input.RootFolder));
        Added(host, movie);
    }

    [Theory]
    [InlineData(true, true)]
    [InlineData(false, true)]
    [InlineData(true, false)]
    [InlineData(false, false)]
    public async Task ControllerRefusesExplicitChoicesAbsentFromLiveProfilesOrRoots(bool movie, bool badProfile)
    {
        using var lab = new IntegrationRequestBackendsTests.Lab(defaults: false);
        using var rig = Requests(lab);
        var host = Title(lab, movie);
        var result = Outcome(await Controller(lab, rig).Add(Sheet(lab, movie, badProfile ? 42 : 5, badProfile ? "/selected" : "/missing"), default));
        Assert.Equal((400, "denied", "invalid_choice"), (result.HttpStatus, result.Outcome, result.Reason));
        Assert.Contains(badProfile ? "quality profile" : "root folder", result.Message);
        Assert.False(string.IsNullOrWhiteSpace(result.Message));
        Assert.Empty(rig.Ledger.ForTitle(Input(movie).Key));
        Assert.Empty(host.Writes);
    }

    [Theory]
    [InlineData(true, false)]
    [InlineData(false, false)]
    [InlineData(true, true)]
    [InlineData(false, true)]
    public async Task ControllerUsesInstanceDefaultsWhenSheetHasNoChoices(bool movie, bool shared)
    {
        using var lab = new IntegrationRequestBackendsTests.Lab();
        using var rig = Requests(lab);
        var host = Title(lab, movie);
        if (shared) Outcome(await rig.Controller(rig.Kid).Create(new("viewer", Input(movie)), default));
        Assert.Equal(201, Outcome(await Controller(lab, rig).Add(Sheet(lab, movie, null, null), default)).HttpStatus);
        await rig.Runner(lab.Direct).TickAsync(default);
        Added(host, movie, 4, movie ? "/data/movies" : "/data/tv");
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task OutboxRevalidatesPersistedChoicesAgainstTheCurrentInstance(bool movie)
    {
        using var lab = new IntegrationRequestBackendsTests.Lab(defaults: false);
        using var rig = Requests(lab);
        var host = Title(lab, movie);
        var result = Outcome(await Controller(lab, rig).Add(Sheet(lab, movie), default));
        Assert.Equal(201, result.HttpStatus);
        host.Profiles.RemoveAll(p => (int)p["id"]! == 5);
        await lab.Store.RefreshForEventAsync(Sheet(lab, movie).InstanceId!, ArrSnapshotKind.System, force: true);
        await rig.Runner(lab.Direct).TickAsync(default);
        var held = Assert.Single(rig.Ledger.ForWant(result.RequestId!));
        Assert.Equal(("parked", "invalid_choice", 5, "/selected"), (held.State, held.Reason, held.Input.ProfileId, held.Input.RootFolder));
        Assert.Empty(host.Writes);
    }

    [Fact]
    public async Task SharedApprovalCopiesChoicesWithoutExpandingTheViewersScope()
    {
        using var lab = new IntegrationRequestBackendsTests.Lab(defaults: false);
        using var rig = Requests(lab);
        var host = Title(lab, false);
        var pending = Outcome(await rig.Controller(rig.Kid).Create(new("viewer", Input(false)), default));
        MutationInput? prepared = null;
        rig.Policy.Before = (user, input) =>
        {
            if (user == rig.Kid) prepared = input;
            return Task.CompletedTask;
        };
        var choices = Sheet(lab, false);
        var result = Outcome(await Controller(lab, rig).Add(new ManageAddRequest
        {
            InstanceId = choices.InstanceId, Key = choices.Key, ProfileId = choices.ProfileId,
            RootFolder = choices.RootFolder, Seasons = new[] { 1, 2 }, IdempotencyKey = choices.IdempotencyKey,
        }, default));
        Assert.Equal(201, result.HttpStatus);
        var approved = rig.Ledger.Find(pending.RequestId!)!;
        Assert.Equal(new[] { 1 }, approved.Input.Seasons);
        Assert.Equal(1, approved.Cost);
        Assert.Equal((5, "/selected"), (prepared!.ProfileId, prepared.RootFolder));
        Assert.Equal(new[] { 1 }, prepared.Seasons);
        Assert.Equal(new[] { 2 }, Assert.Single(rig.Ledger.ForWant(result.RequestId!)).Input.Seasons);
        await rig.Runner(lab.Direct).TickAsync(default);
        Added(host, false);
        // Either independently owned season may dispatch first. The final read-back must include both,
        // while the viewer's durable input and charge above still cover only their original season.
        Assert.Equal(new[] { 1, 2 }, Monitored(Assert.Single(host.Series)));
        Assert.All(rig.Ledger.ForWant(pending.RequestId!).Concat(rig.Ledger.ForWant(result.RequestId!)), j => Assert.Equal("succeeded", j.State));
    }

    [Theory]
    [InlineData(true, true)]
    [InlineData(false, true)]
    [InlineData(true, false)]
    [InlineData(false, false)]
    public async Task ConcurrentApprovalAndManageAddUseSheetChoicesInEitherOrdering(bool movie, bool approvalFirst)
    {
        using var lab = new IntegrationRequestBackendsTests.Lab(defaults: false);
        using var rig = Requests(lab);
        var host = Title(lab, movie);
        var pending = Outcome(await rig.Controller(rig.Kid).Create(new("viewer", Input(movie)), default));
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var blocked = 0;
        rig.Policy.Before = async (user, input) =>
        {
            if (user == rig.Admin && (approvalFirst ? input.ProfileId == 5 : input.ProfileId == null) && Interlocked.Exchange(ref blocked, 1) == 0)
            {
                entered.SetResult();
                await release.Task.WaitAsync(TimeSpan.FromSeconds(10));
            }
        };
        var delayed = approvalFirst
            ? Controller(lab, rig).Add(Sheet(lab, movie), default)
            : rig.Controller(rig.Admin).Approve(pending.RequestId!, null, default);
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(10));
        var first = approvalFirst
            ? Outcome(await rig.Controller(rig.Admin).Approve(pending.RequestId!, null, default))
            : Outcome(await Controller(lab, rig).Add(Sheet(lab, movie), default));
        release.SetResult();
        var second = Outcome(await delayed);
        Assert.InRange(first.HttpStatus, 200, 201);
        // A delayed approval may observe that Add already approved the request.
        Assert.Equal(approvalFirst ? 201 : 409, second.HttpStatus);
        rig.Reopen();
        var job = Assert.Single(rig.Ledger.ForWant(pending.RequestId!), j => j.State == "queued");
        Assert.Equal((5, "/selected", rig.Kid), (job.Input.ProfileId, job.Input.RootFolder, job.Authorization.Requester));
        Assert.Equal(1, rig.Ledger.Find(pending.RequestId!)!.Cost);
        await rig.Runner(lab.Direct).TickAsync(default);
        Added(host, movie);
        Assert.Equal("sent", rig.Ledger.Find(pending.RequestId!)!.Status);
    }

    [Theory]
    [InlineData(true, false)]
    [InlineData(false, false)]
    [InlineData(true, true)]
    [InlineData(false, true)]
    public async Task TwoAddsReconcileTheOwningJobIncludingKnownUnsentRetry(bool movie, bool retryBetween)
    {
        using var lab = new IntegrationRequestBackendsTests.Lab(defaults: false);
        using var rig = Requests(lab);
        var host = Title(lab, movie);
        var first = Outcome(await Controller(lab, rig).Add(Sheet(lab, movie, 4), default));
        var stale = Assert.Single(rig.Ledger.ForWant(first.RequestId!));
        if (retryBetween)
        {
            host.FailWith = 503;
            await rig.Runner(lab.Direct).TickAsync(default);
            Assert.Equal("retry", Assert.Single(rig.Ledger.ForWant(first.RequestId!)).State);
            host.FailWith = 0;
        }
        var second = Outcome(await Controller(lab, rig).Add(Sheet(lab, movie, id: "second-sheet"), default));
        Assert.Equal(200, second.HttpStatus);
        var job = Assert.Single(rig.Ledger.ForWant(first.RequestId!), j => j.State == "queued");
        Assert.Equal((5, "/selected"), (job.Input.ProfileId, job.Input.RootFolder));
        // A previously read outbox snapshot must not claim/send the old input after reconciliation.
        Assert.False(rig.Ledger.Claim(stale, rig.Db.Generation, rig.Now));
        await rig.Runner(lab.Direct).TickAsync(default);
        Added(host, movie);
        Assert.Equal(1, rig.Ledger.Find(first.RequestId!)!.Cost);
    }

    [Theory]
    [InlineData(true, false)]
    [InlineData(false, false)]
    [InlineData(true, true)]
    [InlineData(false, true)]
    public async Task ChangedSheetChoicesCannotEditClaimedOrSentWork(bool movie, bool sent)
    {
        using var lab = new IntegrationRequestBackendsTests.Lab(defaults: false);
        using var rig = Requests(lab);
        var host = Title(lab, movie);
        var first = Outcome(await Controller(lab, rig).Add(Sheet(lab, movie, 4), default));
        var original = Assert.Single(rig.Ledger.ForWant(first.RequestId!));
        if (sent) await rig.Runner(lab.Direct).TickAsync(default);
        else Assert.True(rig.Ledger.Claim(original, rig.Db.Generation, rig.Now));
        var second = Outcome(await Controller(lab, rig).Add(Sheet(lab, movie, id: "changed-sheet"), default));
        Assert.Equal(409, second.HttpStatus);
        Assert.Equal(sent ? "request_changed" : "request_in_flight", second.Reason);
        Assert.Contains("choices", second.Message);
        Assert.Equal(4, Assert.Single(rig.Ledger.ForWant(first.RequestId!)).Input.ProfileId);
        if (sent) Added(host, movie, 4);
        else Assert.Empty(host.Writes);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task DispatchAuditIncludesOnlyNamedExplicitAddChoices(bool movie)
    {
        using var lab = new IntegrationRequestBackendsTests.Lab(defaults: false);
        using var rig = Requests(lab);
        Title(lab, movie);
        Outcome(await Controller(lab, rig).Add(Sheet(lab, movie), default));
        await rig.Runner(lab.Direct).TickAsync(default);
        var entry = Assert.Single(rig.Audit.ReadRecent(10), e => e.Action == "request.dispatch");
        Assert.NotNull(entry.Details);
        Assert.Equal("5", entry.Details["qualityProfileId"]);
        Assert.Equal("Ultra-HD", entry.Details["qualityProfileName"]);
        Assert.Equal("/selected", entry.Details["rootFolder"]);
        Assert.Equal("/selected", entry.Details["rootFolderName"]);
        Assert.Equal(lab.Instance(movie ? "Radarr" : "Sonarr").Name, entry.Details["instanceName"]);
        Assert.Equal(5, entry.Details.Count);
    }

    [Theory]
    [InlineData(true, false, false)]
    [InlineData(false, false, false)]
    [InlineData(true, true, false)]
    [InlineData(false, true, false)]
    [InlineData(true, false, true)]
    [InlineData(false, false, true)]
    [InlineData(true, true, true)]
    [InlineData(false, true, true)]
    public async Task SharedQueuedOrRetryOwnerUsesChoicesOverAbsentOrDifferentDefaults(bool movie, bool retry, bool defaults)
    {
        using var lab = new IntegrationRequestBackendsTests.Lab(defaults);
        using var rig = Requests(lab);
        var host = Title(lab, movie);
        var owner = Outcome(await rig.Controller(rig.Member).Create(new("member-owner", Input(movie)), default));
        Assert.Equal("queued", rig.Ledger.Find(owner.RequestId!)!.Status);
        var charge = Charges(rig, owner.RequestId!);
        if (retry)
        {
            host.FailWith = 503;
            await rig.Runner(lab.Direct).TickAsync(default);
            Assert.Equal("retry", Assert.Single(rig.Ledger.ForWant(owner.RequestId!)).State);
            host.FailWith = 0;
        }
        rig.Now = rig.Now.AddMinutes(1);
        var result = Outcome(await Controller(lab, rig).Add(Sheet(lab, movie), default));
        Assert.Equal(201, result.HttpStatus);
        Assert.Empty(rig.Ledger.ForWant(result.RequestId!));
        Assert.Equal(charge, Charges(rig, owner.RequestId!));
        rig.Reopen();
        var job = Assert.Single(rig.Ledger.ForWant(owner.RequestId!), j => j.State == "queued");
        Assert.Equal((rig.Member, 5, "/selected"), (job.Authorization.Requester, job.Input.ProfileId, job.Input.RootFolder));
        Assert.Equal((1, rig.Member), (rig.Ledger.Find(owner.RequestId!)!.Cost, rig.Ledger.Find(owner.RequestId!)!.UserId));
        await rig.Runner(lab.Direct).TickAsync(default);
        Added(host, movie);
        if (!movie) Assert.Equal(new[] { 1 }, Monitored(Assert.Single(host.Series)));
        Assert.Equal("sent", rig.Ledger.Find(owner.RequestId!)!.Status);
    }
}
