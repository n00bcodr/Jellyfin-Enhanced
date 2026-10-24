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
public partial class IntegrationArrAddChoicesTests
{
    private static IntegrationRequestLedgerTests.Rig Requests(IntegrationRequestBackendsTests.Lab lab)
    {
        var rig = new IntegrationRequestLedgerTests.Rig();
        rig.Policy.Configuration.SonarrInstances = lab.Config.SonarrInstances;
        rig.Policy.Configuration.RadarrInstances = lab.Config.RadarrInstances;
        rig.Policy.Adjust = (_, input, facts) =>
        {
            var instance = lab.Instance(TitleKey.Parse(input.Key)!.IsMovie ? "Radarr" : "Sonarr");
            return facts with { InstanceId = instance.Id, ConnectionGeneration = lab.Arr.Factory.ConnectionGeneration(instance.Id)! };
        };
        return rig;
    }

    private static ArrAddController Controller(IntegrationRequestBackendsTests.Lab lab, IntegrationRequestLedgerTests.Rig rig, Guid? actor = null)
        => new(new ArrAddService(lab.Store, lab.Arr.Factory, rig.Service, () => lab.Config))
        {
            ControllerContext = new() { HttpContext = new DefaultHttpContext { User = TestCallers.Principal(actor ?? rig.Admin, true) } },
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
    [Theory]
    [InlineData(true, false)]
    [InlineData(false, false)]
    [InlineData(true, true)]
    [InlineData(false, true)]
    public async Task AnotherAdministratorCannotReplaceQueuedOrRetryChoices(bool movie, bool retry)
    {
        using var lab = new IntegrationRequestBackendsTests.Lab(defaults: false);
        using var rig = Requests(lab);
        var host = Title(lab, movie);
        var other = rig.Add("Admin");
        var first = Outcome(await Controller(lab, rig).Add(Sheet(lab, movie, 4), default));
        if (retry)
        {
            host.FailWith = 503;
            await rig.Runner(lab.Direct).TickAsync(default);
            host.FailWith = 0;
        }
        var before = Assert.Single(rig.Ledger.ForWant(first.RequestId!));
        var charge = Charges(rig, first.RequestId!);
        var conflict = Outcome(await Controller(lab, rig, other).Add(Sheet(lab, movie, id: "second-admin"), default));
        Assert.Equal((409, "choice_conflict"), (conflict.HttpStatus, conflict.Reason));
        var after = Assert.Single(rig.Ledger.ForWant(first.RequestId!));
        Assert.Equal((before.Id, before.State, before.Input.Canonical, before.Authorization), (after.Id, after.State, after.Input.Canonical, after.Authorization));
        Assert.Equal(charge, Charges(rig, first.RequestId!));
        var identical = Outcome(await Controller(lab, rig, other).Add(Sheet(lab, movie, 4, id: "same-choice"), default));
        Assert.InRange(identical.HttpStatus, 200, 201);
        rig.Reopen();
        rig.Now = rig.Now.AddHours(1);
        await rig.Runner(lab.Direct).TickAsync(default);
        Added(host, movie, 4);
    }

    [Theory]
    [InlineData(false, false)]
    [InlineData(true, false)]
    [InlineData(false, true)]
    [InlineData(true, true)]
    public async Task DisjointScopesCannotAcknowledgeUnusedSeriesChoices(bool secondAdmin, bool episodes)
    {
        using var lab = new IntegrationRequestBackendsTests.Lab(defaults: false);
        using var rig = Requests(lab);
        var host = Title(lab, false);
        host.EpisodeList[75565] = new[] { (1, 1), (2, 1) };
        var actor = secondAdmin ? rig.Add("Admin") : rig.Admin;
        RequestOutcome first;
        if (episodes)
            first = Outcome(await rig.Controller(rig.Admin).Create(new("episode-first", Input(false) with { Scope = "episodes", Seasons = Array.Empty<int>(), Episodes = new[] { new RequestEpisode(1, 1) }, InstanceId = lab.Instance("Sonarr").Id, ProfileId = 4, RootFolder = "/selected" }), default));
        else first = Outcome(await Controller(lab, rig).Add(Sheet(lab, false, 4), default));
        var charge = Charges(rig, first.RequestId!);
        var second = Sheet(lab, false, id: "disjoint");
        second.Seasons = new[] { 2 };
        var conflict = Outcome(await Controller(lab, rig, actor).Add(second, default));
        Assert.Equal((409, "choice_conflict"), (conflict.HttpStatus, conflict.Reason));
        Assert.Equal(charge, Charges(rig, first.RequestId!));
        Assert.Single(rig.Ledger.ForTitle(Input(false).Key));
        second.ProfileId = 4;
        var accepted = Outcome(await Controller(lab, rig, actor).Add(second, default));
        Assert.InRange(accepted.HttpStatus, 200, 201);
        Assert.Equal(charge, Charges(rig, first.RequestId!));
        var jobs = rig.Ledger.ForTitle(Input(false).Key).SelectMany(w => rig.Ledger.ForWant(w.Id)).ToArray();
        Assert.Equal(2, jobs.Length);
        Assert.All(jobs, j => Assert.Equal(4, j.Input.ProfileId));
        await rig.Runner(lab.Direct).TickAsync(default);
        if (episodes)
        {
            var posted = JsonNode.Parse(Assert.Single(host.Writes, w => w.Method == "POST" && w.Path == "/api/v3/series").Body)!;
            Assert.Equal((4, "/selected"), ((int)posted["qualityProfileId"]!, (string)posted["rootFolderPath"]!));
            Assert.True((bool)host.Episodes.Single(e => (int)e["seasonNumber"]! == 1)["monitored"]!);
            Assert.Contains(2, Monitored(Assert.Single(host.Series)));
        }
        else Added(host, false, 4);
        Assert.All(jobs, j => Assert.Equal("succeeded", rig.Ledger.ForWant(j.WantId).Single().State));
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task AuditMessageExposesChoicesToTheExistingAdminRenderer(bool movie)
    {
        using var lab = new IntegrationRequestBackendsTests.Lab(defaults: false);
        using var rig = Requests(lab);
        Title(lab, movie);
        Outcome(await Controller(lab, rig).Add(Sheet(lab, movie), default));
        await rig.Runner(lab.Direct).TickAsync(default);
        var entry = Assert.Single(rig.Audit.ReadRecent(10), e => e.Action == "request.dispatch");
        Assert.Contains("5 (Ultra-HD)", entry.Message);
        Assert.Contains("/selected", entry.Message);
        Assert.Contains(lab.Instance(movie ? "Radarr" : "Sonarr").Name, entry.Message);
        if (Environment.GetEnvironmentVariable("JE_ARRADD_AUDIT_RECEIPT") is { } path)
            File.WriteAllText(path + (movie ? "-movie.json" : "-series.json"), System.Text.Json.JsonSerializer.Serialize(entry, new System.Text.Json.JsonSerializerOptions(System.Text.Json.JsonSerializerDefaults.Web)));
    }

    [Theory]
    [InlineData(true, false)]
    [InlineData(false, false)]
    [InlineData(false, true)]
    public async Task ExplicitOverrideIsVersionedAuditedAndPreservesEveryScopeCharge(bool movie, bool disjoint)
    {
        using var lab = new IntegrationRequestBackendsTests.Lab(defaults: false);
        using var rig = Requests(lab);
        var host = Title(lab, movie);
        var other = rig.Add("Admin");
        var first = Outcome(await Controller(lab, rig).Add(Sheet(lab, movie, 4), default));
        var original = Assert.Single(rig.Ledger.ForWant(first.RequestId!));
        var charge = Charges(rig, first.RequestId!);
        var second = Sheet(lab, movie, id: "override");
        if (disjoint) second.Seasons = new[] { 2 };
        var refused = Outcome(await Controller(lab, rig, other).Add(second, default));
        var choice = Assert.IsType<RequestChoice>(refused.Choice);
        Assert.Equal((rig.Admin, 1L, (int?)4, "/selected"), (choice.Owner, choice.Version, choice.ProfileId, choice.RootFolder));
        second.OverrideChoiceVersion = choice.Version;
        var accepted = Outcome(await Controller(lab, rig, other).Add(second, default));
        Assert.InRange(accepted.HttpStatus, 200, 201);
        var replacement = Assert.Single(rig.Ledger.ForWant(first.RequestId!), j => j.State == "queued");
        Assert.Equal((other, 2L, (int?)5, "/selected"), (replacement.Authorization.ChoiceOwner, replacement.Authorization.ChoiceVersion, replacement.Input.ProfileId, replacement.Input.RootFolder));
        Assert.Equal(original.Input.Seasons, replacement.Input.Seasons);
        Assert.Equal(original.Input.Episodes, replacement.Input.Episodes);
        Assert.Equal(original.Authorization.Requester, replacement.Authorization.Requester);
        Assert.Equal(charge, Charges(rig, first.RequestId!));
        Assert.False(rig.Ledger.Claim(original, rig.Db.Generation, rig.Now));
        Assert.True(rig.Db.Read(c => { using var cmd = c.CreateCommand(); cmd.CommandText = "SELECT COUNT(*) FROM request_audit WHERE action='choice_override'"; return (long)cmd.ExecuteScalar()! > 0; }));
        var stale = Sheet(lab, movie, 4, id: "stale-override");
        stale.OverrideChoiceVersion = choice.Version;
        Assert.Equal("choice_conflict", Outcome(await Controller(lab, rig).Add(stale, default)).Reason);
        rig.Reopen();
        var jobs = rig.Ledger.ForTitle(Input(movie).Key).SelectMany(w => rig.Ledger.ForWant(w.Id)).Where(j => j.State == "queued").ToArray();
        Assert.Equal(disjoint ? 2 : 1, jobs.Length);
        Assert.All(jobs, j => Assert.Equal((other, 2L, (int?)5), (j.Authorization.ChoiceOwner, j.Authorization.ChoiceVersion, j.Input.ProfileId)));
        await rig.Runner(lab.Direct).TickAsync(default);
        Added(host, movie);
        var audit = Assert.Single(rig.Audit.ReadRecent(20), e => e.Id == replacement.Id);
        Assert.Contains("5 (Ultra-HD)", audit.Message);
        Assert.Contains("/selected", audit.Message);
        Assert.Contains("Choice override version: 2", audit.Message);
        if (disjoint) Assert.Equal(new[] { 1, 2 }, Monitored(Assert.Single(host.Series)));
    }

    [Theory]
    [InlineData(true, "profile")]
    [InlineData(false, "profile")]
    [InlineData(true, "root")]
    [InlineData(false, "root")]
    [InlineData(true, "defaults")]
    [InlineData(false, "defaults")]
    public async Task DispatchRevalidatesInsideTheSheetsFreshCacheAndAuditsRefusals(bool movie, string removal)
    {
        using var lab = new IntegrationRequestBackendsTests.Lab(defaults: false);
        using var rig = Requests(lab);
        var host = Title(lab, movie);
        RequestOutcome accepted;
        if (removal == "defaults")
            accepted = Outcome(await Controller(lab, rig).Add(Sheet(lab, movie, null, null), default));
        else
        {
            accepted = Outcome(await Controller(lab, rig).Add(Sheet(lab, movie), default));
            Assert.NotNull(lab.Store.PeekSystem(Sheet(lab, movie).InstanceId!));
            // Deliberately retain the fresh options snapshot; no test refresh and no clock advance.
            if (removal == "profile") host.Profiles.RemoveAll(p => (int)p["id"]! == 5);
            else host.RootFolders.RemoveAll(r => (string?)r["path"] == "/selected");
        }
        await rig.Runner(lab.Direct).TickAsync(default);
        var job = Assert.Single(rig.Ledger.ForWant(accepted.RequestId!));
        Assert.Equal(("parked", removal == "defaults" ? "invalid_defaults" : "invalid_choice"), (job.State, job.Reason));
        Assert.Empty(host.Writes);
        var audit = Assert.Single(rig.Audit.ReadRecent(10), e => e.Action == "request.dispatch");
        Assert.Contains("Profile:", audit.Message);
        Assert.Contains("Root:", audit.Message);
        if (removal != "defaults")
        {
            Assert.Contains("5 (Ultra-HD)", audit.Message);
            Assert.Contains("/selected", audit.Message);
        }
        else Assert.Contains("missing", audit.Message);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task ConcurrentAdministratorsHaveOneWinnerBeforeDispatch(bool movie)
    {
        using var lab = new IntegrationRequestBackendsTests.Lab(defaults: false);
        using var rig = Requests(lab);
        var host = Title(lab, movie);
        var other = rig.Add("Admin");
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var stopped = 0;
        rig.Policy.Before = async (actor, _) =>
        {
            if (actor == other && Interlocked.Exchange(ref stopped, 1) == 0)
            {
                entered.SetResult();
                await release.Task.WaitAsync(TimeSpan.FromSeconds(10));
            }
        };
        var delayed = Controller(lab, rig, other).Add(Sheet(lab, movie, id: "delayed-admin"), default);
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(10));
        Assert.Equal(201, Outcome(await Controller(lab, rig).Add(Sheet(lab, movie, 4), default)).HttpStatus);
        release.SetResult();
        Assert.Equal("choice_conflict", Outcome(await delayed).Reason);
        await rig.Runner(lab.Direct).TickAsync(default);
        Added(host, movie, 4);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task DisjointChangesCannotOverrideSettingsAfterClaimOrSend(bool sent)
    {
        using var lab = new IntegrationRequestBackendsTests.Lab(defaults: false);
        using var rig = Requests(lab);
        var host = Title(lab, false);
        var first = Outcome(await Controller(lab, rig).Add(Sheet(lab, false, 4), default));
        var job = Assert.Single(rig.Ledger.ForWant(first.RequestId!));
        if (sent) await rig.Runner(lab.Direct).TickAsync(default);
        else Assert.True(rig.Ledger.Claim(job, rig.Db.Generation, rig.Now));
        var second = Sheet(lab, false, id: "late-season");
        second.Seasons = new[] { 2 };
        second.OverrideChoiceVersion = 1;
        Assert.Equal(sent ? "request_changed" : "request_in_flight", Outcome(await Controller(lab, rig).Add(second, default)).Reason);
        Assert.Single(rig.Ledger.ForTitle(Input(false).Key));
        Assert.Equal(4, Assert.Single(rig.Ledger.ForWant(first.RequestId!)).Input.ProfileId);
    }

    [Fact]
    public async Task EditedApprovalCannotBypassTheTitleOwnerForADisjointViewerRequest()
    {
        using var lab = new IntegrationRequestBackendsTests.Lab(defaults: false);
        using var rig = Requests(lab);
        var host = Title(lab, false);
        var other = rig.Add("Admin");
        var secondScope = Input(false) with { Seasons = new[] { 2 } };
        var pending = Outcome(await rig.Controller(rig.Kid).Create(new("viewer-season-two", secondScope), default));
        Assert.Equal("pending", rig.Ledger.Find(pending.RequestId!)!.Status);
        Outcome(await Controller(lab, rig).Add(Sheet(lab, false, 4), default));
        var charge = Charges(rig, pending.RequestId!);
        var edited = secondScope with { InstanceId = lab.Instance("Sonarr").Id, ProfileId = 5, RootFolder = "/selected" };
        var refused = await rig.Service.ApproveAsync(pending.RequestId!, other, new(edited), default);
        Assert.Equal("choice_conflict", refused.Reason);
        Assert.Equal(charge, Charges(rig, pending.RequestId!));
        Assert.Equal("pending", rig.Ledger.Find(pending.RequestId!)!.Status);
        Assert.Empty(rig.Ledger.ForWant(pending.RequestId!));
        await rig.Runner(lab.Direct).TickAsync(default);
        Added(host, false, 4);
    }

    [Fact]
    public async Task FillingAnUnsetFieldKeepsTheOtherExplicitChoice()
    {
        using var lab = new IntegrationRequestBackendsTests.Lab(defaults: false);
        using var rig = Requests(lab);
        var host = Title(lab, true);
        var other = rig.Add("Admin");
        var partial = Input(true) with { InstanceId = lab.Instance("Radarr").Id, ProfileId = 4 };
        var first = Outcome(await rig.Controller(rig.Admin).Create(new("partial-choice", partial), default));
        var charge = Charges(rig, first.RequestId!);
        Assert.Equal(201, Outcome(await Controller(lab, rig, other).Add(Sheet(lab, true, 4), default)).HttpStatus);
        Assert.Equal(charge, Charges(rig, first.RequestId!));
        var job = Assert.Single(rig.Ledger.ForWant(first.RequestId!), j => j.State == "queued");
        Assert.Equal((4, "/selected"), (job.Input.ProfileId, job.Input.RootFolder));
        await rig.Runner(lab.Direct).TickAsync(default);
        Added(host, true, 4);
    }

    [Theory]
    [InlineData("same")]
    [InlineData("other")]
    [InlineData("manager")]
    public async Task UneditedApprovalCannotRestoreAnOlderDisjointChoice(string actorKind)
    {
        using var lab = new IntegrationRequestBackendsTests.Lab(defaults: false);
        using var rig = Requests(lab);
        Title(lab, false);
        var held = Input(false) with { Seasons = new[] { 2 }, InstanceId = lab.Instance("Sonarr").Id, ProfileId = 4, RootFolder = "/selected" };
        var pending = await rig.Service.CreateAsync(rig.Admin, new("held-choice", held), default, new RequestOrigin("interactive") { RequireApproval = true });
        Assert.Equal("pending", rig.Ledger.Find(pending.RequestId!)!.Status);
        var first = Outcome(await Controller(lab, rig).Add(Sheet(lab, false), default));
        var job = Assert.Single(rig.Ledger.ForWant(first.RequestId!));
        var actor = actorKind == "same" ? rig.Admin : actorKind == "other" ? rig.Add("Admin") : rig.Manager;
        var refused = await rig.Service.ApproveAsync(pending.RequestId!, actor, null, default);
        Assert.Equal("choice_conflict", refused.Reason);
        Assert.Equal("pending", rig.Ledger.Find(pending.RequestId!)!.Status);
        Assert.Empty(rig.Ledger.ForWant(pending.RequestId!));
        Assert.Equal(job.Input.Canonical, Assert.Single(rig.Ledger.ForWant(first.RequestId!)).Input.Canonical);
        if (actorKind == "manager") Assert.Null(refused.Choice);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task AutomaticOriginsCannotUseTheSameAdminCorrectionToBypassReconciliation(bool movie)
    {
        using var lab = new IntegrationRequestBackendsTests.Lab(defaults: false);
        using var rig = Requests(lab);
        Title(lab, movie);
        var first = Outcome(await Controller(lab, rig).Add(Sheet(lab, movie), default));
        var job = Assert.Single(rig.Ledger.ForWant(first.RequestId!));
        var changed = Input(movie) with { InstanceId = Sheet(lab, movie).InstanceId, ProfileId = 4, RootFolder = "/selected" };
        var refused = await rig.Service.CreateAsync(rig.Admin, new("automatic-choice", changed), default, new RequestOrigin("automation"));
        Assert.Equal("choice_conflict", refused.Reason);
        Assert.Equal(job.Input.Canonical, Assert.Single(rig.Ledger.ForWant(first.RequestId!)).Input.Canonical);
    }

    [Fact]
    public async Task CancellingNewerWorkDoesNotReviveAnOlderOverrideVersion()
    {
        using var lab = new IntegrationRequestBackendsTests.Lab(defaults: false);
        using var rig = Requests(lab);
        Title(lab, true);
        var other = rig.Add("Admin");
        var first = Outcome(await Controller(lab, rig).Add(Sheet(lab, true, 4), default));
        var changed = Sheet(lab, true, id: "new-owner");
        changed.OverrideChoiceVersion = 1;
        Assert.InRange(Outcome(await Controller(lab, rig, other).Add(changed, default)).HttpStatus, 200, 201);
        Assert.Equal(200, rig.Service.Close(first.RequestId!, rig.Admin, null).HttpStatus);
        var stale = Sheet(lab, true, 4, id: "after-cancellation");
        stale.OverrideChoiceVersion = 1;
        var conflict = Outcome(await Controller(lab, rig).Add(stale, default));
        Assert.Equal("choice_conflict", conflict.Reason);
        Assert.Equal(2, conflict.Choice!.Version);
        stale.OverrideChoiceVersion = 2;
        var accepted = Outcome(await Controller(lab, rig).Add(stale, default));
        Assert.InRange(accepted.HttpStatus, 200, 201);
        Assert.Equal(3, Assert.Single(rig.Ledger.ForWant(accepted.RequestId!)).Authorization.ChoiceVersion);
    }

    [Theory]
    [InlineData(true, true)]
    [InlineData(false, true)]
    [InlineData(true, false)]
    [InlineData(false, false)]
    public async Task HeldResumePreservesChoiceOwnerAndFinalDispatch(bool movie, bool stampOnly)
    {
        using var lab = new IntegrationRequestBackendsTests.Lab(defaults: false);
        using var rig = Requests(lab);
        var host = Title(lab, movie);
        var other = rig.Add("Admin");
        var third = rig.Add("Admin");
        var first = Outcome(await Controller(lab, rig).Add(Sheet(lab, movie, 4), default));
        var replace = Sheet(lab, movie, id: "owner-b");
        replace.OverrideChoiceVersion = 1;
        Assert.InRange(Outcome(await Controller(lab, rig, other).Add(replace, default)).HttpStatus, 200, 201);
        var original = Assert.Single(rig.Ledger.ForWant(first.RequestId!), j => j.State == "queued");
        Assert.Equal((other, 2L), (original.Authorization.ChoiceOwner, original.Authorization.ChoiceVersion));
        var charge = Charges(rig, first.RequestId!);
        Assert.True(rig.Ledger.Claim(original, rig.Db.Generation, rig.Now));
        Assert.True(rig.Ledger.Complete(original, rig.Db.Generation, RequestBackendResult.Uncertain(original.WantId) with { Parked = true }, rig.Now));
        Assert.Equal(200, (await rig.Service.ApproveAsync(original.WantId, rig.Admin, null, default)).HttpStatus);
        rig.Reopen();
        var resumed = Assert.Single(rig.Ledger.ForWant(original.WantId), j => j.State == "maybe_sent");
        Assert.Equal(original.Id, resumed.Id);
        Assert.Equal(original.Authorization.Requester, resumed.Authorization.Requester);
        Assert.Equal(rig.Admin, resumed.Authorization.Approver);
        Assert.Equal(original.Input.Canonical, resumed.Input.Canonical);
        Assert.Equal(charge, Charges(rig, first.RequestId!));
        if (stampOnly)
        {
            Assert.Equal((other, 2L), (resumed.Authorization.ChoiceOwner, resumed.Authorization.ChoiceVersion));
            return;
        }
        // Real direct-backend read-back establishes that nothing landed; the job becomes known-unsent.
        await rig.Runner(lab.Direct).TickAsync(default);
        Assert.Equal("retry", rig.Ledger.ForWant(original.WantId).Single(j => j.Id == original.Id).State);
        var reverted = Outcome(await Controller(lab, rig, third).Add(Sheet(lab, movie, 4, id: "unconfirmed-third-admin"), default));
        rig.Reopen();
        rig.Now = rig.Now.AddHours(1);
        await rig.Runner(lab.Direct).TickAsync(default);
        var write = JsonNode.Parse(Assert.Single(host.Writes, w => w.Method == "POST" && w.Path == (movie ? "/api/v3/movie" : "/api/v3/series")).Body)!;
        Assert.True(reverted.HttpStatus == 409 && reverted.Reason == "choice_conflict",
            $"Unconfirmed third administrator got {reverted.HttpStatus}/{reverted.Reason}; dispatched profile={(int)write["qualityProfileId"]!} (owned profile was 5).");
        Assert.Equal((other, 2L, 5, "/selected"), (reverted.Choice!.Owner, reverted.Choice.Version, reverted.Choice.ProfileId, reverted.Choice.RootFolder));
        Assert.Equal(5, (int)write["qualityProfileId"]!);
        Assert.Equal(charge, Charges(rig, first.RequestId!));
        var audit = Assert.Single(rig.Audit.ReadRecent(20), e => e.Action == "request.dispatch" && e.Message?.Contains("Choice override version: 2") == true);
        Assert.Contains("Choice override version: 2", audit.Message);
    }


    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task HeldResumeRequiresCurrentOverrideVersionAfterKnownUnsentReadBack(bool movie)
    {
        using var lab = new IntegrationRequestBackendsTests.Lab(defaults: false);
        using var rig = Requests(lab);
        var host = Title(lab, movie);
        var owner = rig.Add("Admin");
        var third = rig.Add("Admin");
        var first = Outcome(await Controller(lab, rig).Add(Sheet(lab, movie, 4), default));
        var replacement = Sheet(lab, movie, id: "owned-replacement");
        replacement.OverrideChoiceVersion = 1;
        Assert.InRange(Outcome(await Controller(lab, rig, owner).Add(replacement, default)).HttpStatus, 200, 201);
        var job = Assert.Single(rig.Ledger.ForWant(first.RequestId!), j => j.State == "queued");
        var charge = Charges(rig, job.WantId);
        Assert.True(rig.Ledger.Claim(job, rig.Db.Generation, rig.Now));
        Assert.True(rig.Ledger.Complete(job, rig.Db.Generation, RequestBackendResult.Uncertain(job.WantId) with { Parked = true }, rig.Now));
        Assert.Equal(200, (await rig.Service.ApproveAsync(job.WantId, rig.Admin, null, default)).HttpStatus);
        rig.Reopen();
        await rig.Runner(lab.Direct).TickAsync(default);
        Assert.Equal("retry", rig.Ledger.Job(job.Id)!.State);
        rig.Reopen();
        var stale = Sheet(lab, movie, 4, id: "stale-after-resume");
        stale.OverrideChoiceVersion = 1;
        var refused = Outcome(await Controller(lab, rig, third).Add(stale, default));
        Assert.Equal((409, "choice_conflict"), (refused.HttpStatus, refused.Reason));
        Assert.Equal((owner, 2L), (refused.Choice!.Owner, refused.Choice.Version));
        Assert.Equal(charge, Charges(rig, job.WantId));
        stale.IdempotencyKey = "confirmed-after-resume";
        stale.OverrideChoiceVersion = 2;
        Assert.InRange(Outcome(await Controller(lab, rig, third).Add(stale, default)).HttpStatus, 200, 201);
        rig.Reopen();
        var next = Assert.Single(rig.Ledger.ForWant(job.WantId), j => j.State == "queued");
        Assert.Equal((third, 3L), (next.Authorization.ChoiceOwner, next.Authorization.ChoiceVersion));
        Assert.Equal(charge, Charges(rig, job.WantId));
        Assert.False(rig.Ledger.Claim(job, rig.Db.Generation, rig.Now));
        await rig.Runner(lab.Direct).TickAsync(default);
        Added(host, movie, 4);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task HistoricalChoicePrefersActiveLegacyInferenceOverCancelledVersionOne(bool movie)
    {
        using var lab = new IntegrationRequestBackendsTests.Lab(defaults: false);
        using var rig = Requests(lab);
        Title(lab, movie);
        var owner = rig.Add("Admin");
        var third = rig.Add("Admin");
        var first = Outcome(await Controller(lab, rig).Add(Sheet(lab, movie, 4), default));
        var replacement = Sheet(lab, movie, id: "legacy-owner");
        replacement.OverrideChoiceVersion = 1;
        Assert.InRange(Outcome(await Controller(lab, rig, owner).Add(replacement, default)).HttpStatus, 200, 201);
        var active = Assert.Single(rig.Ledger.ForWant(first.RequestId!), j => j.State == "queued");
        // Old JSON has no choice fields: preserve null/0 in storage and infer approver + version 1.
        rig.Db.Write((c, t) =>
        {
            using var cmd = c.CreateCommand();
            cmd.Transaction = t;
            cmd.CommandText = "UPDATE jobs SET authorization_context=json_remove(authorization_context,'$.ChoiceOwner','$.ChoiceVersion') WHERE id=$id";
            cmd.Parameters.AddWithValue("$id", active.Id);
            return cmd.ExecuteNonQuery();
        });
        LegacyRegistry(rig);
        rig.Reopen();
        var legacy = rig.Ledger.Job(active.Id)!;
        Assert.Equal((owner, 2L), (legacy.Authorization.ChoiceOwner, legacy.Authorization.ChoiceVersion));
        var conflict = Outcome(await Controller(lab, rig, third).Add(Sheet(lab, movie, 4, id: "legacy-conflict"), default));
        Assert.Equal((409, "choice_conflict"), (conflict.HttpStatus, conflict.Reason));
        Assert.Equal((owner, 2L, 5), (conflict.Choice!.Owner, conflict.Choice.Version, conflict.Choice.ProfileId));
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task HeldResumeKeepsLegacyNullStampAndExistingApproverInference(bool movie)
    {
        using var lab = new IntegrationRequestBackendsTests.Lab(defaults: false);
        using var rig = Requests(lab);
        Title(lab, movie);
        var approver = rig.Add("Admin");
        var third = rig.Add("Admin");
        var first = Outcome(await Controller(lab, rig).Add(Sheet(lab, movie), default));
        var job = Assert.Single(rig.Ledger.ForWant(first.RequestId!));
        rig.Db.Write((c, t) =>
        {
            using var cmd = c.CreateCommand();
            cmd.Transaction = t;
            cmd.CommandText = "UPDATE jobs SET authorization_context=json_remove(authorization_context,'$.ChoiceOwner','$.ChoiceVersion') WHERE id=$id";
            cmd.Parameters.AddWithValue("$id", job.Id);
            return cmd.ExecuteNonQuery();
        });
        LegacyRegistry(rig);
        rig.Reopen();
        job = rig.Ledger.Job(job.Id)!;
        Assert.True(rig.Ledger.Claim(job, rig.Db.Generation, rig.Now));
        Assert.True(rig.Ledger.Complete(job, rig.Db.Generation, RequestBackendResult.Uncertain(job.WantId) with { Parked = true }, rig.Now));
        Assert.Equal(200, (await rig.Service.ApproveAsync(job.WantId, approver, null, default)).HttpStatus);
        rig.Reopen();
        var resumed = rig.Ledger.Job(job.Id)!;
        Assert.Equal((approver, (Guid?)rig.Admin, 1L), (resumed.Authorization.Approver, resumed.Authorization.ChoiceOwner, resumed.Authorization.ChoiceVersion));
        await rig.Runner(lab.Direct).TickAsync(default);
        var conflict = Outcome(await Controller(lab, rig, third).Add(Sheet(lab, movie, 4, id: "legacy-resume-conflict"), default));
        Assert.Equal((409, "choice_conflict"), (conflict.HttpStatus, conflict.Reason));
        Assert.Equal((rig.Admin, 1L, 5), (conflict.Choice!.Owner, conflict.Choice.Version, conflict.Choice.ProfileId));
    }
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ChoiceStampSurvivesFieldScopedIdentityRevocation(bool requesterDeleted)
    {
        using var lab = new IntegrationRequestBackendsTests.Lab(defaults: false);
        using var rig = Requests(lab);
        Title(lab, true);
        var owner = rig.Add("Admin");
        var first = Outcome(await Controller(lab, rig).Add(Sheet(lab, true, 4), default));
        var replacement = Sheet(lab, true, id: "before-identity-revocation");
        replacement.OverrideChoiceVersion = 1;
        Assert.InRange(Outcome(await Controller(lab, rig, owner).Add(replacement, default)).HttpStatus, 200, 201);
        var job = Assert.Single(rig.Ledger.ForWant(first.RequestId!), j => j.State == "queued");
        if (requesterDeleted)
        {
            Assert.True(rig.Ledger.Claim(job, rig.Db.Generation, rig.Now));
            rig.Ledger.Recover(rig.Now);
        }
        rig.Ledger.PurgeUser(requesterDeleted ? rig.Admin : owner);
        rig.Reopen();
        var retained = rig.Ledger.Job(job.Id)!;
        Assert.Equal((owner, 2L), (retained.Authorization.ChoiceOwner, retained.Authorization.ChoiceVersion));
        Assert.Equal(job.Input.Canonical, retained.Input.Canonical);
        if (requesterDeleted)
        {
            Assert.NotEqual(rig.Admin, retained.Authorization.Requester);
            Assert.Equal("maybe_sent", retained.State);
        }
        else
        {
            Assert.Null(retained.Authorization.Approver);
            Assert.Equal("parked", retained.State);
        }
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task ChoiceStampSurvivesStartupRecoveryReadBackAndCreateReplay(bool movie)
    {
        using var lab = new IntegrationRequestBackendsTests.Lab(defaults: false);
        using var rig = Requests(lab);
        var host = Title(lab, movie);
        var owner = rig.Add("Admin");
        var first = Outcome(await Controller(lab, rig).Add(Sheet(lab, movie, 4), default));
        var replacement = Sheet(lab, movie, id: "replay-owned-choice");
        replacement.OverrideChoiceVersion = 1;
        Assert.InRange(Outcome(await Controller(lab, rig, owner).Add(replacement, default)).HttpStatus, 200, 201);
        var job = Assert.Single(rig.Ledger.ForWant(first.RequestId!), j => j.State == "queued");
        var charge = Charges(rig, job.WantId);
        Assert.True(rig.Ledger.Claim(job, rig.Db.Generation, rig.Now));
        rig.Reopen();
        rig.Ledger.Recover(rig.Now);
        Assert.Equal("maybe_sent", rig.Ledger.Job(job.Id)!.State);
        await rig.Runner(lab.Direct).TickAsync(default);
        rig.Reopen();
        var retry = rig.Ledger.Job(job.Id)!;
        Assert.Equal(("retry", owner, 2L), (retry.State, retry.Authorization.ChoiceOwner, retry.Authorization.ChoiceVersion));
        var replay = Outcome(await Controller(lab, rig, owner).Add(replacement, default));
        Assert.InRange(replay.HttpStatus, 200, 201);
        Assert.Equal(System.Text.Json.JsonSerializer.Serialize(retry), System.Text.Json.JsonSerializer.Serialize(rig.Ledger.Job(job.Id)));
        Assert.Equal(charge, Charges(rig, job.WantId));
        rig.Now = rig.Now.AddHours(1);
        await rig.Runner(lab.Direct).TickAsync(default);
        Added(host, movie);
    }
}
