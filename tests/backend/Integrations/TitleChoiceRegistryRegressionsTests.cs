using System.Text.Json.Nodes;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr;

namespace JE.Tests;

public partial class IntegrationArrAddChoicesTests
{
    private static string? RegistryRefusal(IntegrationRequestLedgerTests.Rig rig, RequestJob job)
    {
        var registry = typeof(RequestLedger).GetProperty("Choices")!.GetValue(rig.Ledger)!;
        return (string?)registry.GetType().GetMethod("Check", new[] { typeof(RequestJob) })!.Invoke(registry, new object[] { job });
    }
    private static void LegacyRegistry(IntegrationRequestLedgerTests.Rig rig)
        => rig.Db.Write((c, t) =>
        {
            using var cmd = c.CreateCommand(); cmd.Transaction = t;
            cmd.CommandText = "UPDATE jobs SET title_choice_id=NULL,title_choice_revision=0; DROP TABLE title_choices";
            return cmd.ExecuteNonQuery();
        });

    // A test of the durable design contract, with no new-member calls before the base assertion.
    // These cases must fail on the old production assembly because it has no independent owner.
    private static void IndependentOwner(IntegrationRequestLedgerTests.Rig rig, Guid owner, long revision)
    {
        var table = rig.Db.Read(c => { using var cmd = c.CreateCommand(); cmd.CommandText = "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='title_choices'"; return Convert.ToInt32(cmd.ExecuteScalar()); });
        Assert.True(table == 1, "A title choice must have a durable owner outside per-job authorization.");
        var record = rig.Db.Read(c => { using var cmd = c.CreateCommand(); cmd.CommandText = "SELECT value FROM title_choices"; return JsonNode.Parse((string)cmd.ExecuteScalar()!)!; });
        Assert.Equal(owner, Guid.Parse((string)record["Owner"]!));
        Assert.Equal(revision, (long)record["Revision"]!);
        var jobs = rig.Db.Read(c => { using var cmd = c.CreateCommand(); cmd.CommandText = "SELECT COUNT(*) FROM jobs WHERE state IN ('queued','retry','maybe_sent') AND (title_choice_id IS NULL OR title_choice_revision<>$v)"; cmd.Parameters.AddWithValue("$v", revision); return Convert.ToInt32(cmd.ExecuteScalar()); });
        Assert.Equal(0, jobs);
    }

    [Theory]
    [InlineData(true, "second-admin")]
    [InlineData(false, "second-admin")]
    [InlineData(true, "held-resume")]
    [InlineData(false, "held-resume")]
    [InlineData(true, "stale-sheet")]
    [InlineData(false, "stale-sheet")]
    [InlineData(false, "disjoint")]
    [InlineData(true, "identical")]
    [InlineData(false, "identical")]
    public async Task RegistryOwnsRoundTwoThroughFourLifecycles(bool movie, string journey)
    {
        using var lab = new IntegrationRequestBackendsTests.Lab(defaults: false);
        using var rig = Requests(lab);
        var host = Title(lab, movie);
        var other = rig.Add("Admin");
        var third = rig.Add("Admin");
        var first = Outcome(await Controller(lab, rig).Add(Sheet(lab, movie, 4), default));
        var owner = rig.Admin; var revision = 1L; var profile = 4;
        if (journey == "second-admin" || journey == "disjoint")
        {
            var second = Sheet(lab, movie, 5, id: "different");
            if (journey == "disjoint") second.Seasons = new[] { 2 };
            var refused = Outcome(await Controller(lab, rig, other).Add(second, default));
            Assert.Equal((409, "choice_conflict"), (refused.HttpStatus, refused.Reason));
            Assert.Equal((owner, revision), (refused.Choice!.Owner, refused.Choice.Version));
        }
        else if (journey == "identical")
        {
            var repeat = Outcome(await Controller(lab, rig, other).Add(Sheet(lab, movie, 4, id: "same"), default));
            Assert.InRange(repeat.HttpStatus, 200, 201);
        }
        else
        {
            var replacement = Sheet(lab, movie, 5, id: "replacement"); replacement.OverrideChoiceVersion = 1;
            Assert.InRange(Outcome(await Controller(lab, rig, other).Add(replacement, default)).HttpStatus, 200, 201);
            owner = other; revision = 2; profile = 5;
            if (journey == "held-resume")
            {
                var job = Assert.Single(rig.Ledger.ForWant(first.RequestId!), j => j.State == "queued");
                Assert.True(rig.Ledger.Claim(job, rig.Db.Generation, rig.Now));
                Assert.True(rig.Ledger.Complete(job, rig.Db.Generation, RequestBackendResult.Uncertain(job.WantId) with { Parked = true }, rig.Now));
                Assert.Equal(200, (await rig.Service.ApproveAsync(job.WantId, rig.Admin, null, default)).HttpStatus);
                rig.Reopen(); await rig.Runner(lab.Direct).TickAsync(default);
            }
            var stale = Sheet(lab, movie, 4, id: "stale"); stale.OverrideChoiceVersion = 1;
            Assert.Equal("choice_conflict", Outcome(await Controller(lab, rig, third).Add(stale, default)).Reason);
        }
        rig.Reopen();
        IndependentOwner(rig, owner, revision);
        rig.Now = rig.Now.AddHours(1);
        await rig.Runner(lab.Direct).TickAsync(default);
        Added(host, movie, profile);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task RegistryFreezesTitleWideTagsAndSeriesSettings(bool movie)
    {
        using var lab = new IntegrationRequestBackendsTests.Lab(defaults: false);
        var host = Title(lab, movie);
        host.Tags[12] = "original"; host.Tags[13] = "changed";
        var defaults = new JsonObject { ["Tags"] = new JsonArray(12), ["SeriesType"] = "anime", ["MinimumAvailability"] = "announced" };
        lab.Edit(movie ? "Radarr" : "Sonarr", row => row["Defaults"] = defaults);
        using var rig = Requests(lab);
        var first = Outcome(await Controller(lab, rig).Add(Sheet(lab, movie, 4), default));
        Assert.Equal(201, first.HttpStatus);
        lab.Edit(movie ? "Radarr" : "Sonarr", row => row["Defaults"] = new JsonObject { ["Tags"] = new JsonArray(13), ["SeriesType"] = "daily", ["MinimumAvailability"] = "released" });
        rig.Reopen();
        await rig.Runner(lab.Direct).TickAsync(default);
        var body = JsonNode.Parse(Assert.Single(host.Writes, w => w.Method == "POST" && w.Path == (movie ? "/api/v3/movie" : "/api/v3/series")).Body)!;
        Assert.Contains(12, body["tags"]!.AsArray().Select(x => (int)x!));
        Assert.DoesNotContain(13, body["tags"]!.AsArray().Select(x => (int)x!));
        Assert.Equal(movie ? "announced" : "anime", (string)body[movie ? "minimumAvailability" : "seriesType"]!);
        IndependentOwner(rig, rig.Admin, 1);
        var sent = Assert.Single(rig.Ledger.ForWant(first.RequestId!));
        var settings = (Jellyfin.Plugin.JellyfinEnhanced.Model.Arr.ArrInstanceDefaults)typeof(RequestJob).GetProperty("TitleChoiceSettings")!.GetValue(sent)!;
        settings.Tags.Add(999);
        Assert.Equal("choice_conflict", RegistryRefusal(rig, sent));
    }

    [Fact]
    public async Task RegistryRefusesDispatchOfAnObsoleteRevisionWithTypedReason()
    {
        using var lab = new IntegrationRequestBackendsTests.Lab(defaults: false);
        using var rig = Requests(lab);
        var host = Title(lab, true);
        var other = rig.Add("Admin");
        var first = Outcome(await Controller(lab, rig).Add(Sheet(lab, true, 4), default));
        var job = Assert.Single(rig.Ledger.ForWant(first.RequestId!));
        IndependentOwner(rig, rig.Admin, 1);
        rig.Db.Write((c, t) => { using var cmd = c.CreateCommand(); cmd.Transaction = t; cmd.CommandText = "UPDATE jobs SET title_choice_revision=0 WHERE id=$id"; cmd.Parameters.AddWithValue("$id", job.Id); return cmd.ExecuteNonQuery(); });
        await rig.Runner(lab.Direct).TickAsync(default);
        var held = rig.Ledger.Job(job.Id)!;
        Assert.Equal(("parked", "choice_conflict"), (held.State, held.Reason));
        Assert.Empty(host.Writes);
    }

    [Fact]
    public async Task RegistryOwnershipSurvivesAuthorizationCacheTampering()
    {
        using var lab = new IntegrationRequestBackendsTests.Lab(defaults: false);
        using var rig = Requests(lab);
        var host = Title(lab, true);
        var third = rig.Add("Admin");
        var first = Outcome(await Controller(lab, rig).Add(Sheet(lab, true, 4), default));
        rig.Db.Write((c, t) => { using var cmd = c.CreateCommand(); cmd.Transaction = t; cmd.CommandText = "UPDATE jobs SET authorization_context=json_remove(authorization_context,'$.ChoiceOwner','$.ChoiceVersion')"; return cmd.ExecuteNonQuery(); });
        rig.Reopen();
        var refused = Outcome(await Controller(lab, rig, third).Add(Sheet(lab, true, 5, id: "corrupt-cache"), default));
        Assert.Equal("choice_conflict", refused.Reason);
        Assert.Equal((rig.Admin, 1L), (refused.Choice!.Owner, refused.Choice.Version));
        IndependentOwner(rig, rig.Admin, 1);
        await rig.Runner(lab.Direct).TickAsync(default);
        Added(host, true, 4);
    }

    [Theory]
    [InlineData(true, false)]
    [InlineData(false, false)]
    [InlineData(true, true)]
    [InlineData(false, true)]
    public async Task RegistryMigratesLegacyConflictsOnceAndAuditsDiscardedHistory(bool movie, bool heldLegacy)
    {
        using var lab = new IntegrationRequestBackendsTests.Lab(defaults: false);
        using var rig = Requests(lab);
        Title(lab, movie);
        var other = rig.Add("Admin");
        var first = Outcome(await Controller(lab, rig).Add(Sheet(lab, movie, 4), default));
        var replacement = Sheet(lab, movie, 5, id: "legacy-newer"); replacement.OverrideChoiceVersion = 1;
        Assert.InRange(Outcome(await Controller(lab, rig, other).Add(replacement, default)).HttpStatus, 200, 201);
        var old = Assert.Single(rig.Ledger.ForWant(first.RequestId!), j => j.State == "cancelled");
        if (heldLegacy)
            rig.Db.Write((c, t) => { using var cmd = c.CreateCommand(); cmd.Transaction = t; cmd.CommandText = "UPDATE jobs SET state='parked',outcome='{\"certainty\":\"Unknown\"}' WHERE id=$id"; cmd.Parameters.AddWithValue("$id", old.Id); return cmd.ExecuteNonQuery(); });
        // The existing production already has two immutable legacy histories. Remove the additive
        // registry only when present: exactly the same old-format job input is used on the base leg.
        var table = rig.Db.Read(c => { using var cmd = c.CreateCommand(); cmd.CommandText = "SELECT COUNT(*) FROM sqlite_master WHERE name='title_choices'"; return Convert.ToInt32(cmd.ExecuteScalar()); });
        if (table == 1) LegacyRegistry(rig);
        rig.Reopen();
        IndependentOwner(rig, other, 2);
        Assert.Equal(old.Input.Canonical, rig.Ledger.Job(old.Id)!.Input.Canonical);
        if (heldLegacy) Assert.Equal("choice_conflict", RegistryRefusal(rig, rig.Ledger.Job(old.Id)!));
        var count = rig.Db.Read(c => { using var cmd = c.CreateCommand(); cmd.CommandText = "SELECT COUNT(*) FROM request_audit WHERE action='choice_migration' AND reason='discarded_legacy_choice'"; return Convert.ToInt32(cmd.ExecuteScalar()); });
        Assert.Equal(1, count);
        rig.Reopen();
        IndependentOwner(rig, other, 2);
        var again = rig.Db.Read(c => { using var cmd = c.CreateCommand(); cmd.CommandText = "SELECT COUNT(*) FROM request_audit WHERE action='choice_migration'"; return Convert.ToInt32(cmd.ExecuteScalar()); });
        Assert.Equal(count, again);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ReviewerCanonicalMergeCannotSilentlyReplaceAnIndependentChoiceOwner(bool implicitCanonical)
    {
        using var lab = new IntegrationRequestBackendsTests.Lab(defaults: false);
        var otherHost = lab.Arr.Add("other-sonarr.test", "Sonarr");
        lab.Arr.Configure(("Radarr", ArrKind.Radarr, "http://radarr.test", "key-radarr"), ("Radarr 4K", ArrKind.Radarr, "http://radarr4k.test", "key-radarr4k"), ("Sonarr", ArrKind.Sonarr, "http://sonarr.test", "key-sonarr"), ("Other Sonarr", ArrKind.Sonarr, "http://other-sonarr.test", "key-other"));
        if (implicitCanonical) lab.Edit("Sonarr", row => row["Defaults"] = IntegrationRequestBackendsTests.Lab.Defaults(4, "/selected"));
        using var rig = Requests(lab);
        var aliases = new TitleAliases(lab.Store, null);
        var service = new RequestService(rig.Ledger, rig.Policy, rig.View, rig.Feed, () => rig.Now, aliases);
        var host = Title(lab, false);
        var secondAdmin = rig.Add("Admin");
        var thirdAdmin = rig.Add("Admin");
        var firstInput = Input(false) with { Key = "tv:tmdb:1731", ProfileId = 4, RootFolder = "/selected", InstanceId = lab.Instance("Sonarr").Id };
        var secondInput = Input(false) with { Seasons = new[] { 2 }, ProfileId = implicitCanonical ? null : 5, RootFolder = implicitCanonical ? null : "/selected", InstanceId = lab.Instance("Sonarr").Id };
        var first = await service.CreateAsync(rig.Admin, new CreateRequest("independent-tmdb", firstInput), default);
        var second = await service.CreateAsync(secondAdmin, new CreateRequest("independent-tvdb", secondInput), default);
        Assert.Equal(201, first.HttpStatus);
        Assert.Equal(201, second.HttpStatus);
        var firstJob = Assert.Single(rig.Ledger.ForWant(first.RequestId!));
        var secondJob = Assert.Single(rig.Ledger.ForWant(second.RequestId!));
        Assert.Equal((rig.Admin, 1L), (firstJob.Authorization.ChoiceOwner, firstJob.Authorization.ChoiceVersion));
        Assert.Equal((secondAdmin, 1L), (secondJob.Authorization.ChoiceOwner, secondJob.Authorization.ChoiceVersion));
        if (implicitCanonical) Assert.Equal((firstJob.Input.ProfileId, firstJob.Input.RootFolder), (secondJob.Input.ProfileId, secondJob.Input.RootFolder));
        // A different configured Sonarr now knows the id relationship. The authorized target remains empty.
        var discovered = IntegrationRequestBackendsTests.Lab.SeriesLookup(75565);
        discovered["id"] = 123;
        discovered["path"] = "/data/other/blakes-7";
        otherHost.Series.Add(discovered);
        Assert.True((await lab.Store.RefreshLibraryNowAsync(lab.Instance("Other Sonarr"), default)).Ok);
        Assert.NotNull(RequestTitleIdentity.Learn(rig.Ledger, rig.Policy, aliases, rig.Feed, firstInput.Key, rig.Now));
        Assert.Empty(host.Series);
        rig.Reopen();
        var jobs = new[] { rig.Ledger.Job(firstJob.Id)!, rig.Ledger.Job(secondJob.Id)! };
        Assert.All(jobs, j => Assert.Equal("queued", j.State));
        var selected = jobs.OrderBy(j => j.Id, StringComparer.Ordinal).First();
        var losing = jobs.Single(j => j.Id != selected.Id);
        var sheet = Sheet(lab, false, implicitCanonical ? 5 : selected.Input.ProfileId, id: "after-identity-merge");
        sheet.Seasons = new[] { 1, 2 };
        var outcome = Outcome(await Controller(lab, rig, thirdAdmin).Add(sheet, default));
        Assert.True(outcome.HttpStatus == 409 && outcome.Reason == "choice_conflict",
            $"After alias reconciliation the unconfirmed third administrator got {outcome.HttpStatus}/{outcome.Reason}.");
        var conflict = Assert.IsType<RequestChoice>(outcome.Choice);
        if (implicitCanonical)
        {
            Assert.Equal((rig.Admin, 1L), (conflict.Owner, conflict.Version));
            IndependentOwner(rig, rig.Admin, 1);
        }
        else Assert.True(conflict.Version > 1);
        var viewer = await rig.Service.CreateAsync(rig.Member, new("viewer-after-alias", Input(false)), default);
        if (!implicitCanonical) Assert.Equal((409, "choice_conflict"), (viewer.HttpStatus, viewer.Reason));
        Assert.Null(viewer.Choice);
        Assert.All(jobs, j => Assert.Equal(implicitCanonical ? null : "choice_conflict", RegistryRefusal(rig, j)));
        var stale = Sheet(lab, false, 5, id: "stale-alias");
        stale.Seasons = new[] { 1, 2 };
        stale.OverrideChoiceVersion = implicitCanonical ? 0 : 1;
        Assert.Equal("choice_conflict", Outcome(await Controller(lab, rig, thirdAdmin).Add(stale, default)).Reason);
        var confirmed = Sheet(lab, false, 5, id: "confirmed-alias");
        confirmed.Seasons = new[] { 1, 2 };
        confirmed.OverrideChoiceVersion = conflict.Version;
        Assert.InRange(Outcome(await Controller(lab, rig, thirdAdmin).Add(confirmed, default)).HttpStatus, 200, 201);
        rig.Reopen();
        var live = new[] { first.RequestId!, second.RequestId! }.SelectMany(rig.Ledger.ForWant).Where(j => j.State == "queued").ToArray();
        Assert.Equal(2, live.Length);
        Assert.All(live, j => { Assert.Equal((thirdAdmin, conflict.Version + 1), (j.Authorization.ChoiceOwner, j.Authorization.ChoiceVersion)); Assert.Null(RegistryRefusal(rig, j)); });
        foreach (var old in jobs) Assert.False(rig.Ledger.Claim(old, rig.Db.Generation, rig.Now));
        await rig.Runner(lab.Direct).TickAsync(default);
        Added(host, false, 5);
        Assert.Equal(new[] { 1, 2 }, Monitored(Assert.Single(host.Series)));
    }
}
