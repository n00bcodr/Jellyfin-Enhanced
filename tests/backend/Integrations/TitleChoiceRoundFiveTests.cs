using System.Text.Json.Nodes;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr;

namespace JE.Tests;

public partial class IntegrationArrAddChoicesTests
{
    private static JsonNode RoundFiveRecord(IntegrationRequestLedgerTests.Rig rig)
        => rig.Db.Read(c =>
        {
            using var cmd = c.CreateCommand();
            cmd.CommandText = "SELECT value FROM title_choices";
            return JsonNode.Parse((string)cmd.ExecuteScalar()!)!;
        });

    private static JsonNode[] ChoiceAudit(IntegrationRequestLedgerTests.Rig rig)
        => rig.Db.Read(c =>
        {
            using var cmd = c.CreateCommand();
            cmd.CommandText = "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='title_choice_audit'";
            Assert.True(Convert.ToInt32(cmd.ExecuteScalar()) == 1, "Every choice admission must have a durable atomic actor/revision audit.");
            cmd.CommandText = "SELECT value FROM title_choice_audit ORDER BY rowid";
            using var rows = cmd.ExecuteReader();
            var entries = new List<JsonNode>();
            while (rows.Read()) entries.Add(JsonNode.Parse(rows.GetString(0))!);
            return entries.ToArray();
        });

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task ManagerInheritanceIsNotAnExplicitRoutingEdit(bool movie)
    {
        using var lab = new IntegrationRequestBackendsTests.Lab(defaults: false);
        using var rig = Requests(lab);
        var host = Title(lab, movie);
        var first = Outcome(await Controller(lab, rig).Add(Sheet(lab, movie, 5), default));
        Assert.Equal(200, rig.Ledger.Close(first.RequestId!, rig.Admin, null, rig.Policy, rig.Now).HttpStatus);
        var pending = await rig.Service.CreateAsync(rig.Kid, new("manager-pending", Input(movie)), default);
        Assert.Equal("pending", rig.Ledger.Find(pending.RequestId!)!.Status);
        var before = RoundFiveRecord(rig).ToJsonString();
        var accepted = await rig.Service.CreateAsync(rig.Manager, new("manager-inherit", Input(movie)), default);
        Assert.InRange(accepted.HttpStatus, 200, 201);
        var job = Assert.Single(rig.Ledger.ForWant(pending.RequestId!));
        Assert.Equal((rig.Kid, (Guid?)rig.Manager), (job.Authorization.Requester, job.Authorization.Approver));
        Assert.False(job.Authorization.Edited);
        Assert.Equal(before, RoundFiveRecord(rig).ToJsonString());
        await rig.Runner(lab.Direct).TickAsync(default);
        Added(host, movie, 5);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task RoundFiveImplicitApprovalInheritsTerminalOwnerWithoutInventingRevision(bool overridden)
    {
        using var lab = new IntegrationRequestBackendsTests.Lab(defaults: false);
        using var rig = Requests(lab);
        var host = Title(lab, false);
        var owner = rig.Add("Admin");
        var approver = rig.Add("Admin");
        var stale = Input(false) with { Seasons = new[] { 2 }, InstanceId = lab.Instance("Sonarr").Id, ProfileId = 4, RootFolder = "/selected" };
        var pending = await rig.Service.CreateAsync(rig.Admin, new("r5-stale-pending", stale), default, new RequestOrigin("interactive") { RequireApproval = true });
        Assert.Equal("pending", rig.Ledger.Find(pending.RequestId!)!.Status);
        var sheet = Sheet(lab, false, overridden ? 4 : 5, id: "r5-first-owner");
        var first = Outcome(await Controller(lab, rig, owner).Add(sheet, default));
        Assert.Equal(201, first.HttpStatus);
        if (overridden)
        {
            var replacement = Sheet(lab, false, 5, id: "r5-explicit-override");
            replacement.OverrideChoiceVersion = 1;
            Assert.InRange(Outcome(await Controller(lab, rig, owner).Add(replacement, default)).HttpStatus, 200, 201);
        }
        Assert.Equal(200, rig.Ledger.Close(first.RequestId!, owner, null, rig.Policy, rig.Now).HttpStatus);
        var before = RoundFiveRecord(rig).ToJsonString();
        var inherited = Sheet(lab, false, null, null, id: "r5-no-choice-approval");
        inherited.Seasons = new[] { 2 };
        Assert.Null(inherited.OverrideChoiceVersion);
        var result = Outcome(await Controller(lab, rig, approver).Add(inherited, default));
        Assert.InRange(result.HttpStatus, 200, 201);
        rig.Reopen();
        Assert.Equal(before, RoundFiveRecord(rig).ToJsonString());
        IndependentOwner(rig, owner, overridden ? 2 : 1);
        await rig.Runner(lab.Direct).TickAsync(default);
        Added(host, false, 5);
        Assert.Equal(new[] { 2 }, Monitored(Assert.Single(host.Series)));
        var entries = ChoiceAudit(rig);
        Assert.Equal(overridden ? 2 : 1, entries.Length);
        Assert.All(entries, e => Assert.Equal(owner.ToString("N"), (string)e["userId"]!));
        Assert.Contains("Profile: 5", (string)entries.Last()["message"]!);
    }

    [Theory]
    [InlineData(true, false)]
    [InlineData(false, false)]
    [InlineData(true, true)]
    [InlineData(false, true)]
    public async Task RoundFiveIncompleteRecordRefusesLaterDispatchDefaults(bool movie, bool missingProfile)
    {
        using var lab = new IntegrationRequestBackendsTests.Lab(defaults: false);
        using var rig = Requests(lab);
        var host = Title(lab, movie);
        var partial = Input(movie) with { ProfileId = missingProfile ? null : 4, RootFolder = missingProfile ? "/selected" : null };
        var first = await rig.Service.CreateAsync(rig.Admin, new("r5-partial-choice", partial), default);
        Assert.Equal(201, first.HttpStatus);
        var before = RoundFiveRecord(rig).ToJsonString();
        lab.Edit(movie ? "Radarr" : "Sonarr", row => row["Defaults"] = IntegrationRequestBackendsTests.Lab.Defaults(5, "/selected"));
        rig.Reopen();
        await rig.Runner(lab.Direct).TickAsync(default);
        Assert.Empty(host.Writes);
        var job = Assert.Single(rig.Ledger.ForWant(first.RequestId!));
        Assert.Equal(("parked", "invalid_choice"), (job.State, job.Reason));
        Assert.Equal(before, RoundFiveRecord(rig).ToJsonString());
        Assert.Single(ChoiceAudit(rig));
        // The dispatch audit is about the recorded partial candidate, not the later defaults.
        var audit = rig.Audit.ReadRecent(20).Single(x => x.Action == "request.dispatch");
        Assert.Contains(missingProfile ? "Profile: missing" : "Root: missing", audit.Message);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task RoundFiveApprovalCannotAdoptOrCompleteAnExistingProvisionalRecord(bool edited)
    {
        using var lab = new IntegrationRequestBackendsTests.Lab(defaults: false);
        using var rig = Requests(lab);
        Title(lab, false);
        var first = await rig.Service.CreateAsync(rig.Member, new("r5-empty-provisional", Input(false)), default);
        Assert.Equal(201, first.HttpStatus);
        var secondScope = Input(false) with { Seasons = new[] { 2 } };
        var pending = await rig.Service.CreateAsync(rig.Kid, new("r5-review", secondScope), default);
        var before = RoundFiveRecord(rig).ToJsonString();
        lab.Edit("Sonarr", row => row["Defaults"] = IntegrationRequestBackendsTests.Lab.Defaults(5, "/selected"));
        rig.Policy.Configuration.SonarrInstances = lab.Config.SonarrInstances;
        var input = secondScope with { ProfileId = 5, RootFolder = "/selected" };
        var outcome = await rig.Service.ApproveAsync(pending.RequestId!, rig.Admin, edited ? new(input) : null, default);
        Assert.True(edited ? outcome.Reason == "choice_conflict" : outcome.HttpStatus == 200);
        Assert.Equal(before, RoundFiveRecord(rig).ToJsonString());
        Assert.Single(ChoiceAudit(rig));
        if (!edited)
        {
            var job = Assert.Single(rig.Ledger.ForWant(pending.RequestId!));
            Assert.Null(job.Input.ProfileId);
            Assert.Null(job.Input.RootFolder);
        }
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task RoundFiveAutomaticAdmissionAndReapprovalCannotFillExistingChoice(bool reapprove)
    {
        using var lab = new IntegrationRequestBackendsTests.Lab(defaults: false);
        using var rig = Requests(lab);
        Title(lab, false);
        var first = await rig.Service.CreateAsync(rig.Member, new("r5-original-provisional", Input(false)), default);
        Assert.Equal(201, first.HttpStatus);
        if (reapprove)
        {
            await rig.Runner(lab.Direct).TickAsync(default);
            Assert.Equal("parked", Assert.Single(rig.Ledger.ForWant(first.RequestId!)).State);
        }
        var before = RoundFiveRecord(rig).ToJsonString();
        lab.Edit("Sonarr", row => row["Defaults"] = IntegrationRequestBackendsTests.Lab.Defaults(5, "/selected"));
        rig.Policy.Configuration.SonarrInstances = lab.Config.SonarrInstances;
        var result = reapprove
            ? await rig.Service.ApproveAsync(first.RequestId!, rig.Admin, null, default)
            : await rig.Service.CreateAsync(rig.Admin, new("r5-automatic-next-scope", Input(false) with { Seasons = new[] { 2 } }), default, new RequestOrigin(RequestOrigin.AutomationKind, "next-season"));
        Assert.InRange(result.HttpStatus, 200, 201);
        rig.Reopen();
        Assert.Equal(before, RoundFiveRecord(rig).ToJsonString());
        Assert.Single(ChoiceAudit(rig));
        Assert.All(rig.Ledger.ForWant(result.RequestId!).Where(j => j.State == "queued"), job =>
        {
            Assert.Null(job.Input.ProfileId);
            Assert.Null(job.Input.RootFolder);
        });
    }

    [Fact]
    public async Task RoundFiveResolverCorrectionFencesBothIdsUntilExplicitSplitResolution()
    {
        using var lab = new IntegrationRequestBackendsTests.Lab(defaults: false);
        using var rig = Requests(lab);
        Title(lab, false);
        var aliases = new TitleAliases(lab.Store, null);
        var original = Input(false) with { Key = "tv:tmdb:498", ProfileId = 4, RootFolder = "/selected" };
        var first = await rig.Service.CreateAsync(rig.Admin, new("r5-before-wrong-merge", original), default);
        var row = IntegrationRequestBackendsTests.Lab.SeriesLookup(75565);
        row["id"] = 123;
        row["tmdbId"] = 498;
        lab.Sonarr.Series.Add(row);
        Assert.True((await lab.Store.RefreshLibraryNowAsync(lab.Instance("Sonarr"), default)).Ok);
        RequestTitleIdentity.Learn(rig.Ledger, rig.Policy, aliases, rig.Feed, original.Key, rig.Now);
        var job = Assert.Single(rig.Ledger.ForWant(first.RequestId!));
        Assert.Equal("tv:tvdb:75565", (string)RoundFiveRecord(rig)["Title"]!);
        var mergedRevision = (long)RoundFiveRecord(rig)["Revision"]!;
        lab.Sonarr.Series.Clear();
        row["tmdbId"] = 999;
        lab.Sonarr.Series.Add(row);
        Assert.True((await lab.Store.RefreshLibraryNowAsync(lab.Instance("Sonarr"), default)).Ok);
        RequestTitleIdentity.Learn(rig.Ledger, rig.Policy, aliases, rig.Feed, Input(false).Key, rig.Now);
        rig.Ledger.Unify(RequestTitleIdentity.Keys(aliases, TitleKey.Parse(Input(false).Key)!), rig.Policy, rig.Now);
        rig.Reopen();
        Assert.True((bool)RoundFiveRecord(rig)["Conflicted"]!, "A contradictory provider pair must freeze the learned merged record.");
        var actor = rig.Add("Admin");
        foreach (var title in new[] { original.Key, Input(false).Key, "tv:tmdb:999" })
        {
            var refused = await rig.Service.CreateAsync(actor, new("r5-fenced-" + title, original with { Key = title, Seasons = new[] { 2 } }), default);
            Assert.True(refused.HttpStatus == 409 && refused.Reason == "choice_conflict", $"Fenced identity {title} returned {refused.HttpStatus}/{refused.Reason}.");
            Assert.True(refused.Choice!.Version > mergedRevision);
        }
        Assert.Equal("choice_conflict", RegistryRefusal(rig, rig.Ledger.Job(job.Id)!));
        await rig.Runner(lab.Direct).TickAsync(default);
        Assert.Empty(lab.Sonarr.Writes);
        var fence = RoundFiveRecord(rig);
        var resolution = Sheet(lab, false, 5, id: "r5-resolve-while-ambiguous");
        resolution.OverrideChoiceVersion = (long)fence["Revision"]!;
        Assert.Equal("choice_conflict", Outcome(await Controller(lab, rig, actor).Add(resolution, default)).Reason);
        // There is no safe way to infer which half an already-canonicalized old job meant.
        Assert.Equal(200, rig.Ledger.Close(first.RequestId!, rig.Admin, null, rig.Policy, rig.Now).HttpStatus);
        Assert.InRange(Outcome(await Controller(lab, rig, actor).Add(resolution, default)).HttpStatus, 200, 201);
        rig.Reopen();
        Assert.Equal(original.Key, rig.Ledger.CanonicalKey(original.Key));
        Assert.Equal(Input(false).Key, rig.Ledger.CanonicalKey("tv:tmdb:999"));
        var orphan = await rig.Service.CreateAsync(actor, new("r5-orphan-still-fenced", original), default);
        Assert.Equal("choice_conflict", orphan.Reason);
        Assert.Contains(ChoiceAudit(rig), e => (string)e["action"]! == "request.choice.override.identity_split" && (string)e["userId"]! == actor.ToString("N"));
        Assert.Equal("cancelled", rig.Ledger.Job(job.Id)!.State);
    }

    [Fact]
    public async Task RoundFiveIdentitySplitBeforeFirstJobRequiresExplicitInitialConfirmation()
    {
        using var lab = new IntegrationRequestBackendsTests.Lab(defaults: false);
        using var rig = Requests(lab);
        Title(lab, false);
        rig.Ledger.Unify(new[] { "tv:tmdb:498", "tv:tvdb:75565" }, rig.Policy, rig.Now);
        rig.Ledger.Unify(new[] { "tv:tmdb:999", "tv:tvdb:75565" }, rig.Policy, rig.Now);
        rig.Reopen();
        var sheet = Sheet(lab, false, 5, id: "r5-first-choice-after-split");
        var refused = Outcome(await Controller(lab, rig).Add(sheet, default));
        Assert.Equal((409, "choice_conflict"), (refused.HttpStatus, refused.Reason));
        Assert.Equal(0, refused.Choice!.Version);
        sheet.OverrideChoiceVersion = 0;
        Assert.Equal(201, Outcome(await Controller(lab, rig).Add(sheet, default)).HttpStatus);
        Assert.Equal("tv:tmdb:498", rig.Ledger.CanonicalKey("tv:tmdb:498"));
        Assert.Equal("tv:tvdb:75565", rig.Ledger.CanonicalKey("tv:tmdb:999"));
        Assert.Contains(ChoiceAudit(rig), e => (string)e["action"]! == "request.choice.override.identity_split");
    }

    [Fact]
    public async Task RoundFiveAmbiguousResolverRowsStayFencedUntilACoherentCorrectionIsConfirmed()
    {
        using var lab = new IntegrationRequestBackendsTests.Lab(defaults: false);
        using var rig = Requests(lab);
        var host = Title(lab, false);
        var first = await rig.Service.CreateAsync(rig.Admin, new("r5-ambiguous-original", Input(false) with { Key = "tv:tmdb:498", ProfileId = 4, RootFolder = "/selected" }), default);
        rig.Ledger.Unify(new[] { "tv:tmdb:498", "tv:tvdb:75565" }, rig.Policy, rig.Now);
        rig.Ledger.Unify(new[] { "tv:tmdb:498", "tv:tmdb:999", "tv:tvdb:75565" }, rig.Policy, rig.Now);
        rig.Reopen();
        Assert.True((bool)RoundFiveRecord(rig)["Conflicted"]!, "Ambiguous positive provider evidence must freeze the merged record too.");
        var revision = (long)RoundFiveRecord(rig)["Revision"]!;
        await rig.Runner(lab.Direct).TickAsync(default);
        Assert.Empty(host.Writes);
        Assert.Equal(200, rig.Ledger.Close(first.RequestId!, rig.Admin, null, rig.Policy, rig.Now).HttpStatus);
        var sheet = Sheet(lab, false, 5, id: "r5-ambiguous-confirmation");
        sheet.OverrideChoiceVersion = revision;
        Assert.Equal("choice_conflict", Outcome(await Controller(lab, rig).Add(sheet, default)).Reason);
        rig.Ledger.Unify(new[] { "tv:tvdb:75565", "tv:tmdb:999" }, rig.Policy, rig.Now);
        var corrected = (long)RoundFiveRecord(rig)["Revision"]!;
        Assert.True(corrected > revision);
        rig.Ledger.Unify(new[] { "tv:tmdb:999", "tv:tvdb:75565" }, rig.Policy, rig.Now);
        Assert.Equal(corrected, (long)RoundFiveRecord(rig)["Revision"]!);
        Assert.Equal("choice_conflict", Outcome(await Controller(lab, rig).Add(sheet, default)).Reason);
        sheet.OverrideChoiceVersion = corrected;
        Assert.Equal(201, Outcome(await Controller(lab, rig).Add(sheet, default)).HttpStatus);
        rig.Reopen();
        Assert.Equal("tv:tmdb:498", rig.Ledger.CanonicalKey("tv:tmdb:498"));
        Assert.Equal("tv:tvdb:75565", rig.Ledger.CanonicalKey("tv:tmdb:999"));
        await rig.Runner(lab.Direct).TickAsync(default);
        Added(host, false, 5);
    }
}
