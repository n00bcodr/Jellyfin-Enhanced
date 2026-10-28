using System.Text.Json;
using System.Text.Json.Nodes;
using Jellyfin.Plugin.JellyfinEnhanced.Controllers;
using Jellyfin.Plugin.JellyfinEnhanced.Model.Jellyseerr;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr.Live;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;

namespace JE.Tests;

/// <summary>
/// The Seerr to JE authority transfer (C58): a complete-or-nothing read separate from the capped read
/// model (3,250 rows), refusals on a mid-read failure, total drift, a changed digest and requesting still on
/// in Seerr; imports link only (no job, no charge, no "new request" notice); a double commit, a crash inside
/// the import and a crash before the switch each end with every request imported once; the source id
/// survives a key rotation but not an address change; rollback by batch keeps wants touched since.
/// </summary>
[Collection("Plugin singleton")]
public class IntegrationSeerrMigrationTests
{
    private const long Request = (long)JellyseerrPermission.REQUEST;
    private const long Admin = (long)JellyseerrPermission.ADMIN;

    // ---- UX3R-2 (review round 1): a disabled Seerr is never read from or moved, whatever calls the API ----

    [Theory]
    [InlineData("switched_off")]
    [InlineData("isolated_je")]
    public async Task UX3ReviewDisabledSeerrMustNotImport(string off)
    {
        using var plugin = new ApiPluginFixture();
        using var m = new Mig();
        m.Add(1, "movie", m.R.Member);
        var c = m.R.Policy.Configuration;
        if (off == "switched_off") c.JellyseerrEnabled = false;
        else { c.ArrRequestBackend = "je"; c.ArrBackendIsolationVersion = 1; }
        var backend = c.ArrRequestBackend;
        plugin.Plugin.Configuration.JellyseerrEnabled = c.JellyseerrEnabled;
        plugin.Plugin.Configuration.JellyseerrUrls = c.JellyseerrUrls;
        plugin.Plugin.Configuration.JellyseerrApiKey = c.JellyseerrApiKey;
        plugin.Plugin.Configuration.ArrRequestBackend = c.ArrRequestBackend;
        plugin.Plugin.Configuration.ArrBackendIsolationVersion = off == "switched_off" ? 1 : c.ArrBackendIsolationVersion;
        Assert.False(Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Backends.EffectiveRequestsBackend.SeerrUsable(c));
        var preview = await m.Service.PreviewAsync(CancellationToken.None);
        var commit = await m.Service.CommitAsync(m.R.Admin, preview.Digest, false, CancellationToken.None);
        Assert.True(m.Seerr.Calls.Count == 0 && m.Count("SELECT COUNT(*) FROM wants") == 0,
            $"disabled Seerr: preview HTTP {preview.HttpStatus}, commit HTTP {commit.HttpStatus}, upstream calls {m.Seerr.Calls.Count}, imported wants {m.Count("SELECT COUNT(*) FROM wants")}, backend {c.ArrRequestBackend}");
        Assert.Equal((409, "seerr_off"), (preview.HttpStatus, preview.Reason));
        Assert.Equal((409, "seerr_off"), (commit.HttpStatus, commit.Reason));
        Assert.Equal(backend, c.ArrRequestBackend);
    }

    [Fact]
    public async Task UX3ReviewSeerrSwitchedOffBetweenReadAndWriteMovesNothing()
    {
        using var m = new Mig();
        m.Add(1, "movie", m.R.Member);
        var preview = await m.Service.PreviewAsync(CancellationToken.None);
        Assert.Equal(200, preview.HttpStatus);
        // The administrator turns Seerr off while the move reads it: the gate before the writes refuses.
        m.Seerr.BeforePage = _ => m.R.Policy.Configuration.JellyseerrEnabled = false;
        var commit = await m.Service.CommitAsync(m.R.Admin, preview.Digest, false, CancellationToken.None);
        Assert.Equal((409, "seerr_off"), (commit.HttpStatus, commit.Reason));
        Assert.Equal(0, m.Count("SELECT COUNT(*) FROM wants"));
        Assert.Equal("seerr", m.R.Policy.Configuration.ArrRequestBackend);
    }

    // ---- UX3R2-2 (review round 2), the reviewer's probes: Seerr turned off during a move (also by a real PATCH) moves nothing ----
    [Theory]
    [InlineData("before_write")]
    [InlineData("before_switch")]
    [InlineData("unchanged_on")]
    public async Task UX3R2MigrationSwitchOffRace(string stage)
    {
        using var m = new Mig();
        m.Add(1, "movie", m.R.Member);
        var c = m.R.Policy.Configuration;
        bool armed = false;
        var service = new SeerrMigration(new SeerrFacts(m.Seerr.Transport), m.R.Ledger, m.R.Policy, m.R.View, null, m.R.Feed,
            () => c, () => {}, () => { if (armed && stage == "before_write") c.JellyseerrEnabled = false; return m.R.Now; });
        var preview = await service.PreviewAsync(CancellationToken.None);
        armed = true;
        if (stage == "before_switch") service.BeforeSwitch = () => c.JellyseerrEnabled = false;
        var reply = await service.CommitAsync(m.R.Admin, preview.Digest, false, CancellationToken.None);
        if (stage == "unchanged_on")
        {
            Assert.Equal((200, 1, "je"), (reply.HttpStatus, reply.Imported, c.ArrRequestBackend));
            return;
        }
        Assert.True(reply.HttpStatus == 409 && m.Count("SELECT COUNT(*) FROM wants") == 0 && c.ArrRequestBackend == "seerr",
            $"stage={stage}, HTTP={reply.HttpStatus}, reason={reply.Reason}, wants={m.Count("SELECT COUNT(*) FROM wants")}, backend={c.ArrRequestBackend}, enabled={c.JellyseerrEnabled}");
    }



    [Theory]
    [InlineData(0, "before_write")]
    [InlineData(1, "before_write")]
    [InlineData(0, "before_switch")]
    [InlineData(1, "before_switch")]
    public async Task UX3R2MigrationRealConfigurationPatchBeforeSwitchMustRefuse(int isolationVersion, string stage)
    {
        using var plugin = new ApiPluginFixture();
        using var m = new Mig();
        m.Add(1, "movie", m.R.Member);
        m.R.Policy.Configuration.ArrBackendIsolationVersion = isolationVersion;
        plugin.Plugin.UpdateConfiguration(m.R.Policy.Configuration);
        void Off() => plugin.Plugin.PatchConfiguration(new Jellyfin.Plugin.JellyfinEnhanced.Configuration.ConfigurationPatch
        {
            Set = new() { ["JellyseerrEnabled"] = JsonSerializer.SerializeToElement(false) }
        });
        bool armed = false;
        var service = new SeerrMigration(new SeerrFacts(m.Seerr.Transport), m.R.Ledger, m.R.Policy, m.R.View, null, m.R.Feed,
            () => plugin.Plugin.Configuration, () => plugin.Plugin.SaveConfiguration(), () =>
            {
                if (armed && stage == "before_write") { armed = false; Off(); }
                return m.R.Now;
            });
        var preview = await service.PreviewAsync(CancellationToken.None);
        Assert.Equal(200, preview.HttpStatus);
        armed = true;
        if (stage == "before_switch") service.BeforeSwitch = Off;
        var reply = await service.CommitAsync(m.R.Admin, preview.Digest, false, CancellationToken.None);
        Assert.True(reply.HttpStatus == 409 && m.Count("SELECT COUNT(*) FROM wants") == 0 && plugin.Plugin.Configuration.ArrRequestBackend == "seerr",
            $"stage={stage}, HTTP={reply.HttpStatus}, reason={reply.Reason}, wants={m.Count("SELECT COUNT(*) FROM wants")}, backend={plugin.Plugin.Configuration.ArrRequestBackend}, enabled={plugin.Plugin.Configuration.JellyseerrEnabled}");
    }

    // ---- UX3R3-1 (review round 3), the reviewer's probes: a move's requests are invisible and inert until its handover ----
    [Theory]
    [InlineData(0, false)]
    [InlineData(1, false)]
    [InlineData(0, true)]
    [InlineData(1, true)]
    public async Task UX3R3RefusedHandoverDoesNotExposeOrRetainProvisionalWants(int isolation, bool cancel)
    {
        using var plugin = new ApiPluginFixture();
        using var m = new Mig();
        m.Add(1, "movie", m.R.Member);
        m.R.Policy.Configuration.ArrBackendIsolationVersion = isolation;
        plugin.Plugin.UpdateConfiguration(m.R.Policy.Configuration);
        var service = new SeerrMigration(new SeerrFacts(m.Seerr.Transport), m.R.Ledger, m.R.Policy, m.R.View, null, m.R.Feed,
            () => plugin.Plugin.Configuration, () => plugin.Plugin.SaveConfiguration(), () => m.R.Now);
        var preview = await service.PreviewAsync(CancellationToken.None);
        int visible = -1;
        int closeStatus = -1;
        service.BeforeSwitch = () =>
        {
            plugin.Plugin.PatchConfiguration(new Jellyfin.Plugin.JellyfinEnhanced.Configuration.ConfigurationPatch
            { Set = new() { ["JellyseerrEnabled"] = JsonSerializer.SerializeToElement(false) } });
            using var body = JsonDocument.Parse(m.R.Service.List(m.R.Member, false).Json);
            visible = body.RootElement.GetProperty("items").GetArrayLength();
            if (cancel)
            {
                // UX3R4-3: the id from storage (the filtered list is empty), so the cancel really runs.
                var id = m.R.Db.Read(c => { using var q = c.CreateCommand(); q.CommandText = "SELECT id FROM wants LIMIT 1"; return (string)q.ExecuteScalar()!; });
                closeStatus = m.R.Service.Close(id, m.R.Member, null).HttpStatus;
            }
        };
        var reply = await service.CommitAsync(m.R.Admin, preview.Digest, false, CancellationToken.None);
        var retained = m.Count("SELECT COUNT(*) FROM wants");
        var kept = m.Count("SELECT COALESCE(SUM(kept),0) FROM import_batches");
        if (cancel) Assert.Equal(404, closeStatus);
        Assert.True(reply.HttpStatus == 409 && reply.Reason == "seerr_off" && visible == 0 && retained == 0,
            $"isolation={isolation}, cancel={cancel}, HTTP={reply.HttpStatus}, reason={reply.Reason}, mid_list_items={visible}, close_HTTP={closeStatus}, retained={retained}, batch_kept={kept}, backend={plugin.Plugin.Configuration.ArrRequestBackend}");
    }

    [Fact]
    public async Task UX3R3RefusedSecondPassCannotLeaveAnApprovedWantAndJob()
    {
        using var plugin = new ApiPluginFixture();
        using var m = new Mig();
        m.R.Policy.Configuration.ArrRequestBackend = "je";
        m.Add(1, "movie", m.R.Member);
        plugin.Plugin.UpdateConfiguration(m.R.Policy.Configuration);
        var service = new SeerrMigration(new SeerrFacts(m.Seerr.Transport), m.R.Ledger, m.R.Policy, m.R.View, null, m.R.Feed,
            () => plugin.Plugin.Configuration, () => plugin.Plugin.SaveConfiguration(), () => m.R.Now);
        var preview = await service.PreviewAsync(CancellationToken.None);
        int approval = -1;
        service.BeforeSwitch = () =>
        {
            plugin.Plugin.PatchConfiguration(new Jellyfin.Plugin.JellyfinEnhanced.Configuration.ConfigurationPatch
            { Set = new() { ["JellyseerrEnabled"] = JsonSerializer.SerializeToElement(false) } });
            // UX3R4-3: the id from storage (the filtered list is empty), so the approval really runs.
            var id = m.R.Db.Read(c => { using var q = c.CreateCommand(); q.CommandText = "SELECT id FROM wants LIMIT 1"; return (string)q.ExecuteScalar()!; });
            approval = m.R.Service.ApproveAsync(id, m.R.Admin, null, CancellationToken.None).GetAwaiter().GetResult().HttpStatus;
        };
        var reply = await service.CommitAsync(m.R.Admin, preview.Digest, false, CancellationToken.None);
        Assert.Equal(404, approval);
        Assert.Equal(0, m.Count("SELECT COUNT(*) FROM approvals"));
        Assert.True(reply.HttpStatus == 409 && m.Count("SELECT COUNT(*) FROM wants") == 0 && m.Count("SELECT COUNT(*) FROM jobs") == 0,
            $"HTTP={reply.HttpStatus}, reason={reply.Reason}, approval_HTTP={approval}, wants={m.Count("SELECT COUNT(*) FROM wants")}, jobs={m.Count("SELECT COUNT(*) FROM jobs")}, backend={plugin.Plugin.Configuration.ArrRequestBackend}");
    }

    [Fact]
    public async Task UX3R3StagedMoveIsInvisibleUntilItsHandoverCommitsThenEveryReaderSeesIt()
    {
        using var plugin = new ApiPluginFixture();
        using var m = new Mig();
        m.Add(1, "movie", m.R.Member);
        plugin.Plugin.UpdateConfiguration(m.R.Policy.Configuration);
        var service = new SeerrMigration(new SeerrFacts(m.Seerr.Transport), m.R.Ledger, m.R.Policy, m.R.View, null, m.R.Feed,
            () => plugin.Plugin.Configuration, () => plugin.Plugin.SaveConfiguration(), () => m.R.Now);
        var preview = await service.PreviewAsync(CancellationToken.None);
        (int Mine, int Admin, int Title, int Batches) during = default;
        service.BeforeSwitch = () =>
        {
            using var mine = JsonDocument.Parse(m.R.Service.List(m.R.Member, false).Json);
            during = (mine.RootElement.GetProperty("items").GetArrayLength(), m.R.Ledger.List(m.R.Admin, true).Count,
                m.R.Ledger.ForTitle("movie:tmdb:1001").Count, m.R.Ledger.ImportBatches().Count);
        };
        var reply = await service.CommitAsync(m.R.Admin, preview.Digest, false, CancellationToken.None);
        Assert.Equal((0, 0, 0, 0), during);
        Assert.Equal((200, 1, "je"), (reply.HttpStatus, reply.Imported, plugin.Plugin.Configuration.ArrRequestBackend));
        using var after = JsonDocument.Parse(m.R.Service.List(m.R.Member, false).Json);
        Assert.Equal(1, after.RootElement.GetProperty("items").GetArrayLength());
        Assert.Equal(1, m.R.Ledger.ForTitle("movie:tmdb:1001").Count);
        Assert.Equal(1, m.Count("SELECT COUNT(*) FROM import_batches WHERE state='committed'"));
    }

    [Fact]
    public async Task UX3R3AMoveRunAsTheRouteRunsItCommitsItsBatchAfterTheHandover()
    {
        // The HTTP route runs a move inside a request publication whose facts belong to the request handling it started
        // with; after the handover that generation is gone, so settling the staged batch must not join it (found live:
        // the batch stayed staged and the move was refused).
        using var plugin = new ApiPluginFixture();
        using var m = new Mig();
        m.Add(1, "movie", m.R.Member);
        plugin.Plugin.UpdateConfiguration(m.R.Policy.Configuration);
        var service = new SeerrMigration(new SeerrFacts(m.Seerr.Transport), m.R.Ledger, m.R.Policy, m.R.View, null, m.R.Feed,
            () => plugin.Plugin.Configuration, () => plugin.Plugin.SaveConfiguration(), () => m.R.Now);
        var preview = await service.PreviewAsync(CancellationToken.None);
        SeerrMigrationReply reply;
        using (SeerrFacts.BeginPublication())
            reply = await service.CommitAsync(m.R.Admin, preview.Digest, false, CancellationToken.None);
        Assert.Equal((200, "migrated", "je"), (reply.HttpStatus, reply.Reason, plugin.Plugin.Configuration.ArrRequestBackend));
        Assert.Single(m.R.Ledger.List(m.R.Admin, true));
        Assert.Equal(0, m.Count("SELECT COUNT(*) FROM import_batches WHERE state='staged'"));
    }

    [Theory]
    [InlineData("seerr")]
    [InlineData("je")]
    public async Task UX3R3AStagedBatchACrashLeftIsSettledBeforeTheNextCheck(string backendNow)
    {
        using var m = new Mig();
        m.Add(1, "movie", m.R.Member);
        var preview = await m.Service.PreviewAsync(CancellationToken.None);
        var source = m.R.Ledger.OriginSource(SeerrFacts.AddressFingerprint(m.R.Policy.Configuration));
        var plan = SeerrMigration.Plan(await new SeerrFacts(m.Seerr.Transport).ReadAsync(m.R.Policy.Configuration, CancellationToken.None), _ => true, k => k, new HashSet<int>());
        // The process died between a move's staged import and its handover (backendNow: whether the handover was saved).
        var staged = m.R.Ledger.ImportSeerr(source, preview.Digest!, plan.Items, plan.Skipped, m.R.Admin, "seerr", _ => "[\"je\",\"r1\",\"g1\",null]", m.R.Now, SeerrMigration.RollbackWindow, staged: true);
        Assert.Equal(1, staged.Imported);
        Assert.Empty(m.R.Ledger.List(m.R.Admin, true));
        m.R.Policy.Configuration.ArrRequestBackend = backendNow;
        await m.Service.PreviewAsync(CancellationToken.None);
        // Round 5: a move that didn't finish its handover in-process is refused, whatever request handling is now.
        Assert.Empty(m.R.Ledger.List(m.R.Admin, true));
        Assert.Equal("rolled_back", m.R.Db.Read(c => { using var cmd = c.CreateCommand(); cmd.CommandText = "SELECT state FROM import_batches"; return (string)cmd.ExecuteScalar()!; }));
    }


    // ---- UX3R4 (review round 4), the reviewer's probes. Ids come from storage, never from the filtered reader. ----
    private static string RawWant(Mig m) => m.R.Db.Read(c => { using var q = c.CreateCommand(); q.CommandText = "SELECT id FROM wants LIMIT 1"; return (string)q.ExecuteScalar()!; });
    private static async Task<ImportResult> StageR4(Mig m, string previous = "seerr")
    {
        m.Add(1, "movie", m.R.Member);
        var read = await new SeerrFacts(m.Seerr.Transport).ReadAsync(m.R.Policy.Configuration, CancellationToken.None);
        var plan = SeerrMigration.Plan(read, _ => true, k => k, new HashSet<int>());
        return m.R.Ledger.ImportSeerr(m.R.Ledger.OriginSource(SeerrFacts.AddressFingerprint(m.R.Policy.Configuration)), read.Digest!, plan.Items, plan.Skipped,
            m.R.Admin, previous, _ => "[\"je\",\"r1\",\"g1\",null]", m.R.Now, SeerrMigration.RollbackWindow, staged: true);
    }

    [Theory]
    [InlineData(0, "approve", "seerr")]
    [InlineData(0, "approve", "je")]
    [InlineData(1, "approve", "seerr")]
    [InlineData(0, "cancel", "seerr")]
    [InlineData(0, "cancel", "je")]
    [InlineData(1, "cancel", "seerr")]
    public async Task UX3R4StagedActionsByIdAreRefused(int isolation, string action, string backend)
    {
        using var plugin = new ApiPluginFixture();
        using var m = new Mig();
        m.R.Policy.Configuration.ArrRequestBackend = backend;
        m.R.Policy.Configuration.ArrBackendIsolationVersion = isolation;
        plugin.Plugin.UpdateConfiguration(m.R.Policy.Configuration);
        m.Add(1, "movie", m.R.Member);
        var service = new SeerrMigration(new SeerrFacts(m.Seerr.Transport), m.R.Ledger, m.R.Policy, m.R.View, null, m.R.Feed,
            () => plugin.Plugin.Configuration, () => plugin.Plugin.SaveConfiguration(), () => m.R.Now);
        var preview = await service.PreviewAsync(default);
        int ran = 0, status = -1;
        service.BeforeSwitch = () => {
            var id = RawWant(m);
            status = action == "approve" ? m.R.Service.ApproveAsync(id, m.R.Admin, null, default).GetAwaiter().GetResult().HttpStatus
                : m.R.Service.Close(id, m.R.Member, null).HttpStatus;
            ran++;
            plugin.Plugin.PatchConfiguration(new Jellyfin.Plugin.JellyfinEnhanced.Configuration.ConfigurationPatch
                { Set = new() { ["JellyseerrEnabled"] = JsonSerializer.SerializeToElement(false) } });
        };
        var reply = await service.CommitAsync(m.R.Admin, preview.Digest, false, default);
        Assert.Equal(1, ran);
        Assert.Equal(404, status);
        Assert.Equal((409, "seerr_off"), (reply.HttpStatus, reply.Reason));
        Assert.Equal(0, m.Count("SELECT COUNT(*) FROM wants"));
        Assert.Equal(0, m.Count("SELECT COUNT(*) FROM jobs"));
        Assert.Equal(0, m.Count("SELECT COUNT(*) FROM approvals"));
        Assert.Equal(0, m.Count("SELECT COUNT(*) FROM request_notices"));
    }

    [Fact]
    public async Task UX3R4StagedDispatchNotificationAndQuotaAreInert()
    {
        using var m = new Mig();
        var batch = await StageR4(m);
        var id = RawWant(m);
        Assert.False(m.R.Ledger.Fulfil(id, m.R.Now));
        Assert.Empty(m.R.Ledger.Unfulfilled(100));
        Assert.Empty(m.R.Ledger.RequestedTitles());
        Assert.Empty(m.R.Ledger.TitleKeys());
        Assert.Empty(m.R.Ledger.Notices(100));
        Assert.Empty(m.R.Ledger.Due(m.R.Now));
        Assert.Empty(m.R.Ledger.ForWant(id));
        Assert.Empty(m.R.Ledger.Dispatches("movie:tmdb:1001"));
        await m.R.Runner().TickAsync(default);
        Assert.Equal(0, m.R.Backend.Sends);
        Assert.Equal(0, m.R.Backend.Reads);
        Assert.Equal(0, m.Count("SELECT COUNT(*) FROM reservations WHERE state='charged'"));
        Assert.Equal(0, m.Count("SELECT COUNT(*) FROM request_notices"));
        Assert.Equal(0, m.Count("SELECT COUNT(*) FROM notifications"));
        Assert.True(m.R.Ledger.DiscardStagedImport(batch.BatchId!, m.R.Now));
        Assert.Equal(0, m.Count("SELECT COUNT(*) FROM reservations"));
        Assert.Equal(0, m.Count("SELECT COUNT(*) FROM request_inputs"));
        Assert.Equal(0, m.Count("SELECT COUNT(*) FROM acquisitions"));
    }

    [Fact]
    public async Task UX3R4OverlappingMovesAndPreviewCannotSettleEachOther()
    {
        using var m = new Mig();
        m.Add(1, "movie", m.R.Member);
        var preview = await m.Service.PreviewAsync(default);
        SeerrMigrationReply? other = null, check = null;
        int ran = 0;
        m.Service.BeforeSwitch = () => {
            other = m.Service.CommitAsync(m.R.Admin, preview.Digest, false, default).GetAwaiter().GetResult();
            check = m.Service.PreviewAsync(default).GetAwaiter().GetResult();
            Assert.Empty(m.R.Ledger.List(m.R.Admin, true));
            ran++;
        };
        var reply = await m.Service.CommitAsync(m.R.Admin, preview.Digest, false, default);
        Assert.Equal(1, ran);
        Assert.Equal("migration_busy", other!.Reason);
        Assert.Equal("migration_busy", check!.Reason);
        Assert.Equal("migrated", reply.Reason);
        Assert.Equal(1, m.Count("SELECT COUNT(*) FROM import_batches"));
        Assert.Single(m.R.Ledger.List(m.R.Admin, true));
    }

    [Fact]
    public async Task UX3R4CrashBeforeHandoverThenIndependentJeSelectionMustNotPublishBatch()
    {
        using var plugin = new ApiPluginFixture();
        using var m = new Mig();
        plugin.Plugin.UpdateConfiguration(m.R.Policy.Configuration);
        var staged = await StageR4(m);
        // Durable state of a process lost before Switch. Reopen the database and rebuild migration.
        m.R.Reopen(); m.Rebuild();
        Assert.Empty(m.R.Ledger.List(m.R.Admin, true));
        // Later an administrator selects JE independently, without resuming/confirming this move.
        plugin.Plugin.PatchConfiguration(new Jellyfin.Plugin.JellyfinEnhanced.Configuration.ConfigurationPatch
            { Set = new() { ["ArrRequestBackend"] = JsonSerializer.SerializeToElement("je") } });
        var service = new SeerrMigration(new SeerrFacts(m.Seerr.Transport), m.R.Ledger, m.R.Policy, m.R.View, null, m.R.Feed,
            () => plugin.Plugin.Configuration, () => plugin.Plugin.SaveConfiguration(), () => m.R.Now);
        var check = await service.PreviewAsync(default);
        Assert.Equal("preview", check.Reason);
        Assert.True(m.R.Ledger.List(m.R.Admin, true).Count == 0,
            $"A preview published {m.R.Ledger.List(m.R.Admin, true).Count} old provisional wants after an unrelated JE selection; committed_batches={m.Count("SELECT COUNT(*) FROM import_batches WHERE state='committed'")}, pending={check.Pending}");
    }

    [Fact]
    public async Task UX3R4MoveFinishesSettlementAfterHostedStopAndRequestCancellation()
    {
        using var m = new Mig();
        m.Add(1, "movie", m.R.Member);
        using var facts = new SeerrFacts(m.Seerr.Transport);
        using var request = new CancellationTokenSource();
        var service = new SeerrMigration(facts, m.R.Ledger, m.R.Policy, m.R.View, null, m.R.Feed,
            () => m.R.Policy.Configuration, () => { }, () => m.R.Now);
        var preview = await service.PreviewAsync(default);
        int stopped = 0;
        service.BeforeSwitch = () => {
            request.Cancel();
            facts.StopAsync(default).GetAwaiter().GetResult();
            m.R.Db.Dispose();
            stopped++;
        };
        var reply = await service.CommitAsync(m.R.Admin, preview.Digest, false, request.Token);
        Assert.Equal(1, stopped);
        Assert.True(request.IsCancellationRequested);
        Assert.Equal("migrated", reply.Reason);
        Assert.Equal(0, m.Count("SELECT COUNT(*) FROM import_batches WHERE state='staged'"));
        Assert.Single(m.R.Ledger.List(m.R.Admin, true));
    }

    [Theory]
    [InlineData("status_only", true, false)]
    [InlineData("seerr", false, false)]
    [InlineData("je", false, true)]
    public async Task UX3R4LaterSwitchOffBeforeSettleDoesNotCommit(string backend, bool seerrEnabled, bool expectedCommit)
    {
        using var m = new Mig();
        var staged = await StageR4(m);
        m.R.Policy.Configuration.ArrRequestBackend = backend;
        m.R.Policy.Configuration.JellyseerrEnabled = seerrEnabled;
        var settle = typeof(SeerrMigration).GetMethod("SettleHandover", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance)!;
        var committed = (bool)settle.Invoke(m.Service, new object[] { staged.BatchId!, true, m.R.Now })!;
        Assert.Equal(expectedCommit, committed);
        Assert.Equal(expectedCommit ? 1 : 0, m.R.Ledger.List(m.R.Admin, true).Count);
    }


    [Theory]
    [InlineData(1, true)]
    [InlineData(0, false)]
    public async Task UX3R4CrashAfterSavedHandoverIsRolledBackEvenWhenSeerrIsNowOff(int isolation, bool enabled)
    {
        // Round 5 rule (coordinator): a move that didn't finish its handover in-process is refused, even when its
        // request-handling save landed; the leftover is rolled back locally (no Seerr call) and shows as rolled back.
        using var plugin = new ApiPluginFixture();
        using var m = new Mig();
        plugin.Plugin.UpdateConfiguration(m.R.Policy.Configuration);
        await StageR4(m);
        plugin.Plugin.PatchConfiguration(new Jellyfin.Plugin.JellyfinEnhanced.Configuration.ConfigurationPatch
            { Set = new() {
                ["ArrRequestBackend"] = JsonSerializer.SerializeToElement("je"),
                ["ArrBackendIsolationVersion"] = JsonSerializer.SerializeToElement(isolation),
                ["JellyseerrEnabled"] = JsonSerializer.SerializeToElement(enabled)
            } });
        m.R.Reopen();
        var service = new SeerrMigration(new SeerrFacts(m.Seerr.Transport), m.R.Ledger, m.R.Policy, m.R.View, null, m.R.Feed,
            () => plugin.Plugin.Configuration, () => plugin.Plugin.SaveConfiguration(), () => m.R.Now);
        m.Seerr.Calls.Clear();
        var check = await service.PreviewAsync(default);
        Assert.Empty(m.Seerr.Calls);
        Assert.Empty(m.R.Ledger.List(m.R.Admin, true));
        Assert.Equal(0, m.Count("SELECT COUNT(*) FROM import_batches WHERE state='staged'"));
        Assert.Equal(0, m.Count("SELECT COUNT(*) FROM wants"));
        Assert.Equal("rolled_back", Assert.Single(m.R.Ledger.ImportBatches()).State);   // what Status lists
        Assert.Equal("seerr_off", check.Reason);
    }

    [Fact]
    public async Task UX3R4RetryKeepsConfigurationLockAndWaitsForDetachedWork()
    {
        using var m = new Mig();
        var staged = await StageR4(m);
        m.R.Policy.Configuration.ArrRequestBackend = "je";
        using var attempt = new ManualResetEventSlim();
        using var resume = new ManualResetEventSlim();
        using var changing = new ManualResetEventSlim();
        int tries = 0, sequence = 0, commitOrder = 0, switchOrder = 0;
        var detached = typeof(SeerrMigration).GetMethod("Detached", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Static)!.MakeGenericMethod(typeof(bool));
        var caller = Task.Run(() => {
            lock (Jellyfin.Plugin.JellyfinEnhanced.JellyfinEnhanced.AnalyticsCredentialLock)
                return (bool)detached.Invoke(null, new object[] { (Func<bool>)(() => {
                    if (Interlocked.Increment(ref tries) == 1) {
                        attempt.Set();
                        if (!resume.Wait(TimeSpan.FromSeconds(5))) throw new TimeoutException();
                        throw new Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Backends.BackendDisabledException("configuration_changed");
                    }
                    var committed = m.R.Ledger.CommitStagedImport(staged.BatchId!, m.R.Now);
                    commitOrder = Interlocked.Increment(ref sequence);
                    return committed;
                }) })!;
        });
        Assert.True(attempt.Wait(TimeSpan.FromSeconds(5)));
        var switcher = Task.Run(() => {
            changing.Set();
            lock (Jellyfin.Plugin.JellyfinEnhanced.JellyfinEnhanced.AnalyticsCredentialLock) {
                m.R.Policy.Configuration.ArrRequestBackend = "status_only";
                switchOrder = Interlocked.Increment(ref sequence);
            }
        });
        try {
            Assert.True(changing.Wait(TimeSpan.FromSeconds(5)));
            Assert.False(caller.IsCompleted);
            Assert.False(switcher.IsCompleted);
        } finally { resume.Set(); }
        Assert.True(await caller.WaitAsync(TimeSpan.FromSeconds(5)));
        await switcher.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal(2, tries);
        Assert.True(commitOrder < switchOrder);
        Assert.Equal("status_only", m.R.Policy.Configuration.ArrRequestBackend);
    }


    // ---- I4R-1: one lock order, the configuration lock outer and the backend monitor inner ----

    private static System.Reflection.MethodInfo Settle => typeof(SeerrMigration).GetMethod("SettleHandover", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance)!;

    // Both threads must finish. An inverted order leaves each waiting on the other's monitor with no timeout, so a
    // failure interrupts them (their locks unwind) instead of leaving the configuration lock held for later tests.
    private static void BothFinish(Thread settlement, Thread publication, Func<Exception?> error)
    {
        var settled = settlement.Join(TimeSpan.FromSeconds(10));
        var published = publication.Join(TimeSpan.FromSeconds(10));
        if (!settled) settlement.Interrupt();
        if (!published) publication.Interrupt();
        Assert.True(settled && published, $"settlement finished={settled}, list publication finished={published}: lock-order deadlock");
        Assert.Null(error());
    }

    private static void BlockedOnAMonitor(Thread thread)
    {
        var deadline = Environment.TickCount64 + 10_000;
        while ((thread.ThreadState & ThreadState.WaitSleepJoin) == 0 && Environment.TickCount64 < deadline) Thread.Yield();
        Assert.True((thread.ThreadState & ThreadState.WaitSleepJoin) != 0, "the list publication never waited");
    }

    [Fact]
    public async Task I4R1ListPublicationWaitingForSettlementsConfigurationLockStillLetsSettlementFinish()
    {
        // A list metadata read publishing (ListMetadataEpoch.Publish) while a move settles under the configuration lock:
        // the publication waits for that lock without holding the backend monitor the settlement reads next.
        using var m = new Mig();
        var staged = await StageR4(m);
        m.R.Policy.Configuration.ArrRequestBackend = "je";
        var epoch = Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists.ListMetadataEpoch.Capture();
        using var configurationHeld = new ManualResetEventSlim();
        Exception? error = null;
        bool? committed = null, published = null;
        var publication = new Thread(() => { try { published = epoch.Publish(() => true, () => false); } catch (Exception ex) { error = ex; } }) { IsBackground = true };
        var settlement = new Thread(() =>
        {
            try
            {
                lock (Jellyfin.Plugin.JellyfinEnhanced.JellyfinEnhanced.AnalyticsCredentialLock)
                {
                    configurationHeld.Set();
                    BlockedOnAMonitor(publication);
                    committed = (bool)Settle.Invoke(m.Service, new object[] { staged.BatchId!, true, m.R.Now })!;
                }
            }
            catch (Exception ex) { error = ex; }
        }) { IsBackground = true };
        settlement.Start();
        Assert.True(configurationHeld.Wait(TimeSpan.FromSeconds(10)));
        publication.Start();
        BothFinish(settlement, publication, () => error);
        Assert.True(committed);
        Assert.NotNull(published);
        Assert.Single(m.R.Ledger.List(m.R.Admin, true));
    }

    [Fact]
    public async Task I4R1ListPublicationInsideTheBackendMonitorNeverWaitsForTheConfigurationLock()
    {
        // The review's probe: settlement holds the configuration lock, a list publication runs with the backend monitor
        // already held (a nested facts publication). The publication is refused instead of waiting, so neither stalls.
        using var m = new Mig();
        var staged = await StageR4(m);
        m.R.Policy.Configuration.ArrRequestBackend = "je";
        var epoch = Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists.ListMetadataEpoch.Capture();
        using var configurationHeld = new ManualResetEventSlim();
        using var backendHeld = new ManualResetEventSlim();
        Exception? error = null;
        bool? committed = null, published = null;
        var settlement = new Thread(() =>
        {
            try
            {
                lock (Jellyfin.Plugin.JellyfinEnhanced.JellyfinEnhanced.AnalyticsCredentialLock)
                {
                    configurationHeld.Set();
                    if (!backendHeld.Wait(TimeSpan.FromSeconds(10))) throw new TimeoutException();
                    committed = (bool)Settle.Invoke(m.Service, new object[] { staged.BatchId!, true, m.R.Now })!;
                }
            }
            catch (Exception ex) { error = ex; }
        }) { IsBackground = true };
        var publication = new Thread(() =>
        {
            try
            {
                if (!configurationHeld.Wait(TimeSpan.FromSeconds(10))) throw new TimeoutException();
                using (Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Backends.EffectiveRequestsBackend.Shared.LockFacts())
                {
                    backendHeld.Set();
                    published = epoch.Publish(() => true, () => false);
                }
            }
            catch (Exception ex) { error = ex; }
        }) { IsBackground = true };
        settlement.Start();
        publication.Start();
        BothFinish(settlement, publication, () => error);
        Assert.True(committed);
        Assert.False(published);
        Assert.Single(m.R.Ledger.List(m.R.Admin, true));
    }

    [Theory]
    [InlineData(false, true)]
    [InlineData(true, true)]
    [InlineData(false, false)]
    [InlineData(true, false)]
    public void UX3R4AliasReconciliationPreservesStagedTitleIdentity(bool existingCanonical, bool staged)
    {
        using var m = new Mig();
        m.R.Policy.Configuration.ArrRequestBackend = "je";
        var target = "[\"je\",\"r1\",\"g1\",null]";
        ImportResult Import(string source, string inputKey, int request, bool staged) => m.R.Ledger.ImportSeerr(source, "digest",
            new[] { new ImportCandidate(m.R.Member, request, new MutationInput { Key = inputKey, Scope = "seasons", Seasons = new[] { 1 } }, false, m.R.Now) },
            new Dictionary<string, int>(), m.R.Admin, "seerr", _ => target, m.R.Now, SeerrMigration.RollbackWindow, staged: staged);
        if (existingCanonical) Import("visible-source", "tv:tvdb:5001", 2, false);
        var stage = Import("staged-source", "tv:tmdb:1001", 1, staged);
        var id = m.R.Db.Read(c => { using var q = c.CreateCommand(); q.CommandText = "SELECT id FROM wants WHERE origin_source_id='staged-source'"; return (string)q.ExecuteScalar()!; });
        // Independent JE/arr evidence learns the TVDB id while the move is staged.
        m.R.Ledger.UnifyJeAliases(new[] { "tv:tmdb:1001", "tv:tvdb:5001" }, m.R.Policy, m.R.Now);
        if (staged) Assert.Null(m.R.Ledger.Find(id)); else Assert.NotNull(m.R.Ledger.Find(id));
        Assert.Empty(m.R.Ledger.ForWant(id));
        if (staged) Assert.True(m.R.Ledger.CommitStagedImport(stage.BatchId!, m.R.Now));
        var want = m.R.Ledger.Find(id)!;
        var titleRows = m.R.Ledger.ForTitle("tv:tvdb:5001");
        var ask = m.R.Ledger.Create(m.R.Member, new CreateRequest("after-alias", new MutationInput { Key = "tv:tvdb:5001", Scope = "seasons", Seasons = new[] { 1 } }), m.R.Policy, m.R.Now);
        Assert.True(want.Input.Key == "tv:tvdb:5001" && titleRows.Any(w => w.Id == id),
            $"staged={staged}, existingCanonical={existingCanonical}, committed_input={want.Input.Key}, canonical_lookup_count={titleRows.Count(w => w.Id == id)}, resolved_old_alias={m.R.Ledger.CanonicalKey("tv:tmdb:1001")}, later_ask_HTTP={ask.HttpStatus}, outgoing_jobs={m.Count("SELECT COUNT(*) FROM jobs")}");
    }

    // ---- Round 5 (UX3R4-3 guard, coordinator): a move left mid-handover by a crash, then a restart (the outbox's startup
    // recovery and the next check), then the real approve, cancel, dispatch and notice paths against its want's id from
    // storage: each is refused exactly, and nothing is approved, sent, charged or noticed. ----

    private static async Task<(Mig M, string Id, RequestOutbox Runner)> RestartAfterSavedHandover()
    {
        var m = new Mig();
        await StageR4(m);
        var id = RawWant(m);
        m.R.Policy.Configuration.ArrRequestBackend = "je";   // the handover's save landed; the process died before settling
        m.R.Reopen(); m.Rebuild();
        m.R.Ledger.Recover(m.R.Now);                          // what RequestOutbox runs at startup
        await m.Service.PreviewAsync(default);                // the next check
        return (m, id, m.R.Runner());
    }

    [Fact]
    public async Task UX3R5RestartRefusesApprovingAStagedLeftover()
    {
        var (m, id, _) = await RestartAfterSavedHandover();
        using var _m = m;
        var outcome = await m.R.Service.ApproveAsync(id, m.R.Admin, null, default);
        Assert.Equal((404, "not_found"), (outcome.HttpStatus, outcome.Reason));
        Assert.Equal(0, m.Count("SELECT COUNT(*) FROM approvals"));
        Assert.Equal(0, m.Count("SELECT COUNT(*) FROM jobs"));
        Assert.Equal(0, m.Count("SELECT COUNT(*) FROM wants"));
    }

    [Fact]
    public async Task UX3R5RestartRefusesCancellingAStagedLeftover()
    {
        var (m, id, _) = await RestartAfterSavedHandover();
        using var _m = m;
        var outcome = m.R.Service.Close(id, m.R.Member, null);
        Assert.Equal((404, "not_found"), (outcome.HttpStatus, outcome.Reason));
        Assert.Equal(0, m.Count("SELECT COUNT(*) FROM wants"));
    }

    [Fact]
    public async Task UX3R5RestartDispatchesNothingForAStagedLeftover()
    {
        var (m, id, runner) = await RestartAfterSavedHandover();
        using var _m = m;
        // Even an administrator's approval attempt (refused) and an outbox pass send nothing for it.
        await m.R.Service.ApproveAsync(id, m.R.Admin, null, default);
        await runner.TickAsync(default);
        Assert.Equal((0, 0), (m.R.Backend.Sends, m.R.Backend.Reads));
        Assert.Empty(m.R.Ledger.ForWant(id));
        Assert.Equal(0, m.Count("SELECT COUNT(*) FROM jobs"));
        Assert.Equal(0, m.Count("SELECT COUNT(*) FROM reservations WHERE state='charged'"));
    }

    [Fact]
    public async Task UX3R5RestartWritesNoNoticeForAStagedLeftover()
    {
        var (m, id, runner) = await RestartAfterSavedHandover();
        using var _m = m;
        await m.R.Service.ApproveAsync(id, m.R.Admin, null, default);
        m.R.Service.Close(id, m.R.Member, null);
        await runner.TickAsync(default);
        Assert.Empty(m.R.Ledger.Notices(100));
        Assert.Equal(0, m.Count("SELECT COUNT(*) FROM request_notices"));
        Assert.Equal(0, m.Count("SELECT COUNT(*) FROM notifications"));
    }

    private sealed class Mig : IDisposable
    {
        public IntegrationRequestLedgerTests.Rig R { get; } = new();
        public FakeSeerr Seerr { get; } = new();
        public SeerrMigration Service { get; private set; }
        public int Saves { get; private set; }
        public Action? SaveHook { get; set; }
        public Mig()
        {
            var c = R.Policy.Configuration;
            c.ArrRequestBackend = "seerr";
            c.JellyseerrEnabled = true;
            c.JellyseerrUrls = FakeSeerr.Url;
            c.JellyseerrApiKey = FakeSeerr.Key;
            Seerr.MainSettings = new JsonObject { ["defaultPermissions"] = 0 };
            Seerr.Users.Add(new JsonObject { ["id"] = 1, ["permissions"] = Admin });
            Seerr.Users.Add(new JsonObject { ["id"] = 2, ["permissions"] = 0 });
            Service = Build();
        }
        public SeerrMigration Build() => new(new SeerrFacts(Seerr.Transport), R.Ledger, R.Policy, R.View, null, R.Feed,
            () => R.Policy.Configuration, () => { SaveHook?.Invoke(); Saves++; }, () => R.Now);
        public void Rebuild() => Service = Build();
        public JsonObject Add(int id, string type, Guid user, int status = 1, int mediaStatus = 2, bool is4k = false, int[]? seasons = null, int? tmdb = null)
        {
            var row = FakeSeerr.Request(id, type, tmdb ?? 1000 + id, status, user, new DateTime(2026, 9, 1, 0, 0, 0, DateTimeKind.Utc).AddMinutes(id), tvdb: type == "tv" ? 5000 + id : null, is4k: is4k,
                seasons: type == "tv" ? seasons ?? new[] { 1 } : null, mediaStatus: mediaStatus);
            if (is4k) row["media"]!["status4k"] = mediaStatus;
            lock (Seerr.Requests) Seerr.Requests.Add(row);
            return row;
        }
        public async Task<SeerrMigrationReply> Commit(string? digest = null, bool confirm = false)
            => await Service.CommitAsync(R.Admin, digest ?? (await Service.PreviewAsync(CancellationToken.None)).Digest, confirm, CancellationToken.None);
        public long Count(string sql) => R.Db.Read(c => { using var cmd = c.CreateCommand(); cmd.CommandText = sql; return Convert.ToInt64(cmd.ExecuteScalar(), System.Globalization.CultureInfo.InvariantCulture); });
        public void Dispose() { Seerr.Dispose(); R.Dispose(); }
    }

    [Theory]
    [InlineData(false)] [InlineData(true)]
    public async Task R5MigrationSwitchAndFailedSaveRollbackShareTheEvidenceWriter(bool failSave)
    {
        using var m = new Mig();
        using var token = EvidenceRevision.TryAcquire(() => true);
        Assert.NotNull(token);
        m.SaveHook = () => { if (failSave) throw new IOException("save failed"); };
        var writer = Task.Run(() => (bool)typeof(SeerrMigration).GetMethod("Switch", System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic)!
            .Invoke(m.Service, new object?[] { "je", null })!);
        try
        {
            Assert.True(SpinWait.SpinUntil(() => EvidenceRevision.Advancing, 1000));
            Assert.Equal("seerr", m.R.Policy.Configuration.ArrRequestBackend);
            Assert.False(writer.IsCompleted);
        }
        finally { token!.Dispose(); }
        Assert.Equal(!failSave, await writer.WaitAsync(TimeSpan.FromSeconds(5)));
        Assert.Equal(failSave ? "seerr" : "je", m.R.Policy.Configuration.ArrRequestBackend);
        Assert.False(EvidenceRevision.Advancing);
    }

    /// <summary>
    /// What one person's lists say after a move: the Household row (as an administrator reads it), GET
    /// acquire/requests/mine and GET acquire/requests?view=mine.
    /// </summary>
    private static async Task<(JsonElement Person, JsonElement[] Mine, JsonElement[] List)> Lists(Mig m, Guid user)
    {
        var directory = new IntegrationRequestHouseholdTests.FakeDirectory();
        directory.People[user] = new HouseholdPerson { Id = user, Name = "Asker" };
        directory.People[m.R.Admin] = new HouseholdPerson { Id = m.R.Admin, Name = "Admin", IsAdmin = true };
        var hub = new RequestHubProjection(m.R.Service, directory, null, (media, id, ct) => Task.FromResult<HubTitleMeta?>(null), () => m.R.Now);
        var household = new HouseholdService(hub, m.R.Feed, _ => { });
        static JsonElement Read(StatusBody body) => JsonDocument.Parse(body.Json).RootElement.Clone();
        var people = Read(await household.ReadAsync(new StatusViewer { UserId = m.R.Admin, IsAdmin = true }, CancellationToken.None)).GetProperty("people");
        var person = people.EnumerateArray().Single(p => p.GetProperty("name").GetString() == "Asker");
        var mine = Read(await hub.MineAsync(new StatusViewer { UserId = user }, CancellationToken.None)).GetProperty("items").EnumerateArray().ToArray();
        var list = Read(m.R.Service.List(user, false)).GetProperty("items").EnumerateArray().ToArray();
        return (person, mine, list);
    }

    [Fact]
    public async Task ThreeThousandTwoHundredFiftyRequestsAreReadCompletelyAndImportedWithoutJobsChargesOrNotices()
    {
        using var m = new Mig();
        var users = Enumerable.Range(0, 5).Select(_ => m.R.Add("Member")).ToArray();
        var expectedPending = 0; var expectedProcessing = 0;
        for (var id = 1; id <= 3250; id++)
        {
            var user = users[id % users.Length];
            switch (id % 10)
            {
                case 0: m.Add(id, "movie", user, status: 3); break;                                   // declined
                case 1: m.Add(id, "movie", user, status: 5, mediaStatus: 5); break;                   // completed
                case 2: m.Add(id, "movie", user, status: 2, mediaStatus: 5); break;                   // available
                case 3: m.Add(id, "movie", Guid.NewGuid(), status: 1); break;                         // unmapped person
                case 4: m.Add(id, "tv", user, status: 2, mediaStatus: 3, seasons: new[] { 1, 2 }); expectedProcessing++; break;
                case 5: m.Add(id, "movie", user, status: 2, mediaStatus: 3, is4k: true); expectedProcessing++; break;
                case 6: m.Add(id, "movie", user, status: 4); expectedPending++; break;               // failed: needs a new OK
                default: m.Add(id, id % 2 == 0 ? "movie" : "tv", user, status: 1); expectedPending++; break;
            }
        }
        var preview = await m.Service.PreviewAsync(CancellationToken.None);
        Assert.True(preview.Complete, preview.IncompleteReason);
        Assert.Equal(3250, preview.Total);
        Assert.Equal((expectedPending, expectedProcessing), (preview.Pending, preview.Processing));
        Assert.Equal(new Dictionary<string, int> { ["declined"] = 325, ["completed"] = 325, ["available"] = 325, ["unmapped_user"] = 325 }.OrderBy(p => p.Key), preview.Skipped.OrderBy(p => p.Key));
        Assert.Equal("disabled", preview.SeerrRequesting);
        Assert.Equal(0, m.Count("SELECT COUNT(*) FROM wants"));       // the dry run writes nothing
        Assert.Empty(m.Seerr.Writes);

        var commit = await m.Service.CommitAsync(m.R.Admin, preview.Digest, false, CancellationToken.None);
        Assert.Equal(200, commit.HttpStatus);
        Assert.Equal(expectedPending + expectedProcessing, commit.Imported);
        Assert.Equal("je", m.R.Policy.Configuration.ArrRequestBackend);
        Assert.Equal(1, m.Saves);
        Assert.Equal(expectedPending, m.Count("SELECT COUNT(*) FROM wants WHERE status='pending' AND reason='awaiting_approval'"));
        Assert.Equal(expectedProcessing, m.Count("SELECT COUNT(*) FROM wants WHERE status='sent' AND reason='looking'"));
        Assert.Equal(commit.Imported, m.Count("SELECT COUNT(*) FROM wants WHERE origin_kind='seerr_import' AND origin_source_id IS NOT NULL AND origin_request_id IS NOT NULL AND import_batch_id='" + commit.BatchId + "'"));
        Assert.Equal(0, m.Count("SELECT COUNT(*) FROM jobs"));
        Assert.Equal(0, m.Count("SELECT COUNT(*) FROM reservations WHERE state='charged' OR cost<>0"));
        Assert.Equal(0, m.Count("SELECT COUNT(*) FROM wants WHERE cost<>0"));
        Assert.Equal(0, m.Count("SELECT COUNT(*) FROM request_notices"));
        Assert.Equal(expectedPending, m.R.Ledger.List(m.R.Admin, true).Count);  // imported asks wait in Approvals
        Assert.Empty(m.R.Ledger.Due(m.R.Now));
        Assert.Empty(m.Seerr.Writes);                                         // JE never wrote to Seerr
        Assert.Equal(2, m.Seerr.CallCount("take=1&skip=0&sort=added"));       // one final drift check per read
    }

    [Fact]
    public async Task AMidReadFailureOrTotalDriftImportsNothingAndKeepsSeerrInCharge()
    {
        using var m = new Mig();
        var user = m.R.Add("Member");
        for (var id = 1; id <= 450; id++) m.Add(id, "movie", user);
        var good = await m.Service.PreviewAsync(CancellationToken.None);
        Assert.True(good.Complete);

        m.Seerr.BeforePage = skip => { if (skip == 300) m.Seerr.FailWith = 500; };
        var failed = await m.Service.PreviewAsync(CancellationToken.None);
        Assert.False(failed.Complete); Assert.Equal("page_failed", failed.IncompleteReason); Assert.Null(failed.Digest);
        var commit = await m.Service.CommitAsync(m.R.Admin, good.Digest, true, CancellationToken.None);
        Assert.Equal((409, "seerr_read_incomplete"), (commit.HttpStatus, commit.Reason));

        // Seerr's total moves while the pages are read: a request added between pages.
        m.Seerr.FailWith = 0;
        var added = false;
        m.Seerr.BeforePage = skip => { if (skip == 200 && !added) { added = true; m.Add(9000, "movie", user); } };
        var drift = await m.Service.PreviewAsync(CancellationToken.None);
        Assert.Equal("total_changed", drift.IncompleteReason);
        // A request removed after the last page: the final check sees the total move.
        m.Seerr.BeforePage = null;
        var start = await m.Service.PreviewAsync(CancellationToken.None);
        Assert.True(start.Complete);
        m.Seerr.BeforeRequest = uri => { if (uri.Query.Contains("take=1&skip=0&sort=added", StringComparison.Ordinal)) lock (m.Seerr.Requests) m.Seerr.Requests.RemoveAt(0); return Task.CompletedTask; };
        Assert.Equal("total_changed", (await m.Service.PreviewAsync(CancellationToken.None)).IncompleteReason);
        m.Seerr.BeforeRequest = null;

        // Something changed in Seerr between the dry run and the commit.
        var before = await m.Service.PreviewAsync(CancellationToken.None);
        lock (m.Seerr.Requests) m.Seerr.Requests[0]["status"] = 2;
        var changed = await m.Service.CommitAsync(m.R.Admin, before.Digest, false, CancellationToken.None);
        Assert.Equal((409, "seerr_changed"), (changed.HttpStatus, changed.Reason));
        Assert.Equal(0, m.Count("SELECT COUNT(*) FROM wants"));
        Assert.Equal(0, m.Count("SELECT COUNT(*) FROM import_batches"));
        Assert.Equal("seerr", m.R.Policy.Configuration.ArrRequestBackend);
        Assert.Equal(0, m.Saves);
    }

    [Fact]
    public async Task RequestingStillOnInSeerrRefusesAndAnUncheckableSeerrNeedsConfirmation()
    {
        using var m = new Mig();
        var user = m.R.Add("Member");
        m.Add(1, "movie", user);
        m.Seerr.Users[1]["permissions"] = Request;
        var preview = await m.Service.PreviewAsync(CancellationToken.None);
        Assert.Equal(("enabled", 1, 1), (preview.SeerrRequesting, preview.RequestingUsers, preview.SeerrAdmins));
        var refused = await m.Service.CommitAsync(m.R.Admin, preview.Digest, true, CancellationToken.None);
        Assert.Equal((409, "seerr_requests_enabled"), (refused.HttpStatus, refused.Reason));   // confirmation can't override a verified "enabled"

        m.Seerr.Users[1]["permissions"] = 0;
        m.Seerr.MainSettings!["defaultPermissions"] = Request;
        Assert.Equal((true, "enabled"), ((await m.Service.PreviewAsync(CancellationToken.None)).DefaultAllowsRequests, (await m.Service.PreviewAsync(CancellationToken.None)).SeerrRequesting));

        m.Seerr.MainSettings = null;   // settings unreadable: unknown
        var unknown = await m.Service.PreviewAsync(CancellationToken.None);
        Assert.Equal("unknown", unknown.SeerrRequesting);
        Assert.Equal((409, "seerr_requests_unknown"), ((await m.Service.CommitAsync(m.R.Admin, unknown.Digest, false, CancellationToken.None)) is var r ? (r.HttpStatus, r.Reason) : default));
        Assert.Equal(0, m.Count("SELECT COUNT(*) FROM wants"));
        var confirmed = await m.Service.CommitAsync(m.R.Admin, unknown.Digest, true, CancellationToken.None);
        Assert.Equal((200, 1), (confirmed.HttpStatus, confirmed.Imported));
    }

    [Fact]
    public async Task DoubleCommitCrashInsideTheImportAndCrashBeforeTheSwitchEachImportEveryRequestOnce()
    {
        using var m = new Mig();
        var user = m.R.Add("Member");
        for (var id = 1; id <= 12; id++) m.Add(id, id % 3 == 0 ? "tv" : "movie", user, status: id % 2 == 0 ? 2 : 1, mediaStatus: 3);
        // A crash inside the import transaction: nothing of it remains.
        var calls = 0;
        m.R.Ledger.Fault = stage => { if (stage == "import" && ++calls == 7) throw new IOException("crash"); };
        await Assert.ThrowsAsync<IOException>(() => m.Commit());
        Assert.Equal(0, m.Count("SELECT COUNT(*) FROM wants"));
        Assert.Equal(0, m.Count("SELECT COUNT(*) FROM import_batches"));
        Assert.Equal("seerr", m.R.Policy.Configuration.ArrRequestBackend);
        m.R.Ledger.Fault = null;

        // The process dies after the import committed but before the switch: a re-run only switches.
        var preview = await m.Service.PreviewAsync(CancellationToken.None);
        var source = m.R.Ledger.OriginSource(SeerrFacts.AddressFingerprint(m.R.Policy.Configuration));
        var plan = SeerrMigration.Plan(await new SeerrFacts(m.Seerr.Transport).ReadAsync(m.R.Policy.Configuration, CancellationToken.None), _ => true, k => k, new HashSet<int>());
        var crashed = m.R.Ledger.ImportSeerr(source, preview.Digest!, plan.Items, plan.Skipped, m.R.Admin, "seerr", _ => "[\"je\",\"r1\",\"g1\",null]", m.R.Now, SeerrMigration.RollbackWindow);
        Assert.Equal(12, crashed.Imported);
        m.R.Reopen(); m.Rebuild();
        var rerun = await m.Commit();
        Assert.Equal((200, 0, 12), (rerun.HttpStatus, rerun.Imported, rerun.Skipped["already_imported"]));
        Assert.Null(rerun.BatchId);
        Assert.Equal("je", m.R.Policy.Configuration.ArrRequestBackend);
        Assert.Equal(12, m.Count("SELECT COUNT(*) FROM wants"));

        // A double commit (and the commit after) imports nothing twice.
        var again = await m.Commit();
        Assert.Equal((200, 0), (again.HttpStatus, again.Imported));
        Assert.Equal(12, m.Count("SELECT COUNT(*) FROM wants"));
        Assert.Equal(1, m.Count("SELECT COUNT(*) FROM import_batches"));

        // A failed switch rolls its own batch back: Seerr stays in charge with nothing half moved.
        m.R.Policy.Configuration.ArrRequestBackend = "seerr";
        m.Add(50, "movie", user);
        m.SaveHook = () => throw new IOException("disk full");
        var failed = await m.Commit();
        Assert.Equal((503, "switch_failed"), (failed.HttpStatus, failed.Reason));
        Assert.Equal("seerr", m.R.Policy.Configuration.ArrRequestBackend);
        Assert.Equal(12, m.Count("SELECT COUNT(*) FROM wants"));
    }

    [Fact]
    public async Task ParallelCommitsAreSingleFlight()
    {
        using var m = new Mig();
        var user = m.R.Add("Member");
        m.Add(1, "movie", user);
        var digest = (await m.Service.PreviewAsync(CancellationToken.None)).Digest;
        var hold = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        m.Seerr.Hold = async () => { entered.TrySetResult(); await hold.Task; };
        var first = m.Service.CommitAsync(m.R.Admin, digest, false, CancellationToken.None);
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        var second = await m.Service.CommitAsync(m.R.Admin, digest, false, CancellationToken.None);
        Assert.Equal((409, "migration_busy"), (second.HttpStatus, second.Reason));
        Assert.Equal((409, "migration_busy"), m.Service.Rollback(Guid.NewGuid().ToString("N")) is var b ? (b.HttpStatus, b.Reason) : default);
        m.Seerr.Hold = null; hold.SetResult();
        Assert.Equal(1, (await first).Imported);
    }

    [Fact]
    public async Task TheSourceIdSurvivesAKeyRotationButNotAnAddressChange()
    {
        using var m = new Mig();
        var user = m.R.Add("Member");
        var other = m.R.Add("Member");
        m.Add(1, "movie", user, tmdb: 77);
        m.Add(2, "tv", user, seasons: new[] { 3 });
        Assert.Equal(2, (await m.Commit()).Imported);
        var source = m.R.Ledger.FindOriginSource(SeerrFacts.AddressFingerprint(m.R.Policy.Configuration));
        Assert.NotNull(source);

        // Same Seerr, new key (and a reordered, slash-terminated address list): the same source, nothing imported twice.
        m.R.Policy.Configuration.JellyseerrApiKey = "ROTATED-KEY";
        m.R.Policy.Configuration.JellyseerrUrls = FakeSeerr.Url + "/";
        m.R.Policy.Configuration.ArrRequestBackend = "seerr";
        var rotated = await m.Commit();
        Assert.Equal((200, 0, 2), (rotated.HttpStatus, rotated.Imported, rotated.Skipped["already_imported"]));
        Assert.Equal(source, m.R.Ledger.FindOriginSource(SeerrFacts.AddressFingerprint(m.R.Policy.Configuration)));

        // Another Seerr reusing the same request ids: a new source, so its rows are not mistaken for the old
        // ones; an ask the person already has in JE is not duplicated, a new one is imported.
        m.R.Policy.Configuration.JellyseerrUrls = "http://other-seerr.lan:5055";
        m.R.Policy.Configuration.ArrRequestBackend = "seerr";
        lock (m.Seerr.Requests) m.Seerr.Requests.Clear();
        m.Add(1, "movie", user, tmdb: 77);         // same person, same title: already in JE
        m.Add(2, "movie", other, tmdb: 88);        // same id 2, a different request
        var moved = await m.Commit();
        Assert.Equal((200, 1), (moved.HttpStatus, moved.Imported));
        Assert.Equal(1, moved.Skipped["already_in_je"]);
        var newSource = m.R.Ledger.FindOriginSource(SeerrFacts.AddressFingerprint(m.R.Policy.Configuration));
        Assert.NotEqual(source, newSource);
        Assert.Equal(1, m.Count("SELECT COUNT(*) FROM wants WHERE origin_source_id='" + newSource + "' AND origin_request_id='2' AND title_key='movie:tmdb:88'"));
        Assert.Equal(1, m.Count("SELECT COUNT(*) FROM wants WHERE origin_source_id='" + source + "' AND origin_request_id='2' AND title_key LIKE 'tv:%'"));
    }

    [Fact]
    public async Task RollbackAfterAnApprovalKeepsTheTouchedWantAndReturnsToSeerr()
    {
        using var m = new Mig();
        var kid = m.R.Add("Kid");
        var member = m.R.Add("Member");
        m.Add(1, "movie", kid);                                   // pending
        m.Add(2, "movie", member, tmdb: 4242);                    // pending
        m.Add(3, "tv", member, status: 2, mediaStatus: 3);        // processing
        var commit = await m.Commit();
        Assert.Equal(3, commit.Imported);
        var approved = m.R.Ledger.List(m.R.Admin, true).Single(w => w.UserId == kid);
        Assert.Equal(200, (await m.R.Service.ApproveAsync(approved.Id, m.R.Admin, null, CancellationToken.None)).HttpStatus);
        Assert.Single(m.R.Ledger.ForWant(approved.Id));            // the approval created a job

        // Another person asks for the same title in JE after the import: the imported want is kept as theirs.
        var followerAsk = await m.R.Create(m.R.Manager, IntegrationRequestLedgerTests.Movie(4242));
        Assert.True(followerAsk.HttpStatus < 300);

        var status = m.Service.Status();
        Assert.Contains(status.Batches!, b => JsonSerializer.Serialize(b).Contains("\"canRollBack\":true", StringComparison.Ordinal));
        var rollback = m.Service.Rollback(commit.BatchId);
        Assert.Equal(200, rollback.HttpStatus);
        Assert.Equal("seerr", m.R.Policy.Configuration.ArrRequestBackend);
        Assert.True(rollback.Kept >= 1);
        Assert.Equal(3, rollback.Removed + rollback.Kept);
        Assert.NotNull(m.R.Ledger.Find(approved.Id));               // approved since: kept, with its job
        Assert.Single(m.R.Ledger.ForWant(approved.Id));
        Assert.Equal(0, m.Count("SELECT COUNT(*) FROM wants WHERE origin_request_id='3'"));   // untouched: removed
        Assert.Equal(1, m.Count("SELECT COUNT(*) FROM import_batches WHERE state='rolled_back'"));

        Assert.Equal((409, "already_rolled_back"), m.Service.Rollback(commit.BatchId) is var again ? (again.HttpStatus, again.Reason) : default);
        Assert.Equal((404, "not_found"), m.Service.Rollback(Guid.NewGuid().ToString("N")) is var missing ? (missing.HttpStatus, missing.Reason) : default);
        Assert.Equal((400, "invalid_id"), m.Service.Rollback("../x") is var bad ? (bad.HttpStatus, bad.Reason) : default);
    }

    [Fact]
    public async Task ThePreviewCountsWaitingAsksFromPeopleWhoCantAskInJe()
    {
        using var m = new Mig();
        var watcher = m.R.Add("Watcher");
        var member = m.R.Add("Member");
        m.Add(1, "movie", watcher);
        m.Add(2, "movie", member);
        m.Add(3, "movie", watcher, status: 2, mediaStatus: 3);   // processing: no approval needed
        var preview = await m.Service.PreviewAsync(CancellationToken.None);
        Assert.Equal((2, 1, 1), (preview.Pending, preview.Processing, preview.PendingWithoutRole));
    }

    [Fact]
    public async Task RollbackIsRefusedAfterFourteenDaysAndStaleMarkingIsNotATouch()
    {
        using var m = new Mig();
        var member = m.R.Add("Member");
        m.Add(1, "movie", member, status: 2, mediaStatus: 3);
        var commit = await m.Commit();
        m.R.Ledger.Retain(m.R.Now.AddDays(1), 30);                  // an old Seerr request is stale at once
        Assert.Equal("stale", m.R.Ledger.ForTitle("movie:tmdb:1001").Single().Status);
        m.R.Now = m.R.Now.AddDays(15);
        var expired = m.Service.Rollback(commit.BatchId);
        Assert.Equal((409, "rollback_expired"), (expired.HttpStatus, expired.Reason));
        m.R.Now = m.R.Now.AddDays(-14);
        var rolled = m.Service.Rollback(commit.BatchId);
        Assert.Equal((200, 1, 0), (rolled.HttpStatus, rolled.Removed, rolled.Kept));
    }

    [Theory]
    [InlineData(false, false, true)]   // phase 3 off
    [InlineData(true, true, false)]    // status only
    public async Task TheMigrationNeedsPhaseThreeAndARequestBackend(bool phase3, bool statusOnly, bool expectDisabled)
    {
        using var m = new Mig();
        m.R.Policy.Configuration.ArrPhase3Enabled = phase3;
        if (statusOnly) m.R.Policy.Configuration.ArrRequestBackend = "status_only";
        var preview = await m.Service.PreviewAsync(CancellationToken.None);
        Assert.Equal(expectDisabled ? (403, "feature_disabled") : (409, "backend_status_only"), (preview.HttpStatus, preview.Reason));
        Assert.Empty(m.Seerr.Calls);
    }

    [Fact]
    public async Task OnlyAdministratorsReachTheMigrationRoutesAndAnswersCarryNoAddressOrKey()
    {
        using var m = new Mig();
        var member = m.R.Add("Member");
        m.Add(1, "movie", member);
        IActionResult Call(Guid? user, System.Security.Claims.ClaimsPrincipal? principal, Func<AcquireMigrationController, IActionResult> action)
        {
            var controller = new AcquireMigrationController(m.Service, m.R.View) { ControllerContext = new() { HttpContext = new DefaultHttpContext() } };
            controller.HttpContext.User = principal ?? TestCallers.Principal(user!.Value, user == m.R.Admin);
            return action(controller);
        }
        foreach (var caller in new[] { TestCallers.Principal(member, false), TestCallers.Principal(member, true), TestCallers.ApiKey(), TestCallers.Unknown() })
        {
            foreach (var reply in new[] { Call(null, caller, c => c.Status()), Call(null, caller, c => c.Preview(CancellationToken.None).Result),
                Call(null, caller, c => c.Commit(new("x"), CancellationToken.None).Result), Call(null, caller, c => c.Rollback(new(Guid.NewGuid().ToString("N")))) })
                Assert.Equal(403, Assert.IsType<ObjectResult>(reply).StatusCode);
        }
        Assert.Empty(m.Seerr.Calls);
        var preview = Assert.IsType<ObjectResult>(Call(m.R.Admin, null, c => c.Preview(CancellationToken.None).Result));
        Assert.Equal(200, preview.StatusCode);
        var body = JsonSerializer.Serialize(preview.Value);
        Assert.DoesNotContain(FakeSeerr.Key, body, StringComparison.Ordinal);
        Assert.DoesNotContain("seerr.lan", body, StringComparison.Ordinal);
        var digest = ((SeerrMigrationReply)preview.Value!).Digest;
        var commit = Assert.IsType<ObjectResult>(Call(m.R.Admin, null, c => c.Commit(new(digest), CancellationToken.None).Result));
        Assert.Equal(200, commit.StatusCode);
        var stale = Assert.IsType<ObjectResult>(Call(m.R.Admin, null, c => c.Commit(new("0000"), CancellationToken.None).Result));
        Assert.Equal(409, stale.StatusCode);
        Assert.Equal("seerr_changed", Assert.IsType<RequestOutcome>(stale.Value).Reason);
    }

    // Review round 1 regressions.

    [Fact]
    public async Task ARequestStillProcessingInSeerrCoversLaterAsksAndApprovalsWithoutASecondAdd()
    {
        using var m = new Mig();
        var alice = m.R.Add("Member");
        var carol = m.R.Add("Member");
        var bob = m.R.Add("Member");
        m.Add(1, "movie", alice, status: 2, mediaStatus: 3, tmdb: 600);   // approved in Seerr, downloading
        m.Add(2, "movie", carol, tmdb: 600);                                // pending in Seerr
        Assert.Equal(2, (await m.Commit()).Imported);

        // Bob asks for the title Seerr is already fetching: he joins it, nothing is sent or charged.
        var asked = await m.R.Create(bob, IntegrationRequestLedgerTests.Movie(600));
        Assert.Equal((200, "merged", "looking"), (asked.HttpStatus, asked.Outcome, asked.Reason));
        Assert.Equal("sent", m.R.Ledger.Find(asked.RequestId!)!.Status);
        // Approving Carol's moved ask doesn't send a second add either.
        var carolsWant = m.R.Ledger.List(m.R.Admin, true).Single(w => w.UserId == carol);
        var approved = await m.R.Service.ApproveAsync(carolsWant.Id, m.R.Admin, null, CancellationToken.None);
        Assert.Equal((200, "looking"), (approved.HttpStatus, approved.Reason));
        Assert.Equal("sent", m.R.Ledger.Find(carolsWant.Id)!.Status);
        Assert.Equal(0, m.Count("SELECT COUNT(*) FROM jobs"));
        Assert.Equal(0, m.Count("SELECT COALESCE(SUM(cost),0) FROM reservations WHERE state='charged'"));
        Assert.Empty(m.R.Ledger.Due(m.R.Now));
        // Seerr already sent Alice's: cancelling it in JE can't take it back.
        var alicesWant = m.R.Ledger.ForTitle("movie:tmdb:600").Single(w => w.UserId == alice);
        Assert.Equal((409, "request_in_flight"), m.R.Service.Close(alicesWant.Id, alice, null) is var cancel ? (cancel.HttpStatus, cancel.Reason) : default);
    }

    [Fact]
    public async Task MovedRequestsAreLinkedOnTheTargetJellyfinEnhancedSendsToEvenThoughSeerrHandledRequestsDuringTheMove()
    {
        using var m = new Mig();
        // As in production: while Seerr handles requests, a person's request facts name no Sonarr/Radarr.
        m.R.Policy.Adjust = (_, _, facts) => facts.Backend == "seerr" ? facts with { InstanceId = string.Empty, ConnectionGeneration = string.Empty } : facts;
        var alice = m.R.Add("Member");
        var bob = m.R.Add("Member");
        m.Add(1, "movie", alice, status: 2, mediaStatus: 3, tmdb: 600);   // approved in Seerr, downloading
        Assert.Equal(1, (await m.Commit()).Imported);
        Assert.Equal("je", m.R.Policy.Configuration.ArrRequestBackend);
        var link = m.R.Ledger.ForTitle("movie:tmdb:600").Single();
        Assert.Equal(RequestLedger.TargetKey(new RequestAuthorization(alice, null, "request", "movie", "standard", "je", "r1", "g1", "x")), link.TargetKey);
        // Asks after the switch join what Seerr is already fetching: no job, no charge, no second add.
        var asked = await m.R.Create(bob, IntegrationRequestLedgerTests.Movie(600));
        Assert.Equal((200, "merged", "looking"), (asked.HttpStatus, asked.Outcome, asked.Reason));
        var again = await m.R.Create(alice, IntegrationRequestLedgerTests.Movie(600));
        Assert.Equal((200, "looking"), (again.HttpStatus, again.Reason));
        Assert.Equal(0, m.Count("SELECT COUNT(*) FROM jobs"));
        Assert.Equal(0, m.Count("SELECT COALESCE(SUM(cost),0) FROM reservations WHERE state='charged'"));
    }

    [Fact]
    public async Task ProofThatPeopleCanStillAskInSeerrSurvivesALaterFailedRead()
    {
        using var m = new Mig();
        var user = m.R.Add("Member");
        m.Add(1, "movie", user);
        // The defaults let new people ask, then the user list can't be read: still "enabled", not "unknown".
        m.Seerr.MainSettings!["defaultPermissions"] = Request;
        m.Seerr.BeforeRequest = uri => { m.Seerr.FailWith = uri.AbsolutePath == "/api/v1/user" ? 503 : 0; return Task.CompletedTask; };
        var preview = await m.Service.PreviewAsync(CancellationToken.None);
        Assert.Equal((true, "enabled", true), (preview.Complete, preview.SeerrRequesting, preview.DefaultAllowsRequests));
        Assert.Equal((409, "seerr_requests_enabled"), (await m.Service.CommitAsync(m.R.Admin, preview.Digest, true, CancellationToken.None)) is var r1 ? (r1.HttpStatus, r1.Reason) : default);

        // A person who can ask is on the first page of users, the second page fails.
        m.Seerr.MainSettings!["defaultPermissions"] = 0;
        for (var id = 3; id < 160; id++) m.Seerr.Users.Add(new JsonObject { ["id"] = id, ["permissions"] = id == 5 ? Request : 0 });
        m.Seerr.BeforeRequest = uri => { m.Seerr.FailWith = uri.AbsolutePath == "/api/v1/user" && uri.Query.Contains("skip=100", StringComparison.Ordinal) ? 503 : 0; return Task.CompletedTask; };
        var partial = await m.Service.PreviewAsync(CancellationToken.None);
        Assert.Equal(("enabled", 1), (partial.SeerrRequesting, partial.RequestingUsers));
        Assert.Equal((409, "seerr_requests_enabled"), (await m.Service.CommitAsync(m.R.Admin, partial.Digest, true, CancellationToken.None)) is var r2 ? (r2.HttpStatus, r2.Reason) : default);

        // No proof either way: only then may the administrator confirm.
        m.Seerr.Users[4]["permissions"] = 0;   // user 5
        var unknown = await m.Service.PreviewAsync(CancellationToken.None);
        Assert.Equal("unknown", unknown.SeerrRequesting);
        Assert.Equal(0, m.Count("SELECT COUNT(*) FROM wants"));
        Assert.Equal("seerr", m.R.Policy.Configuration.ArrRequestBackend);
    }

    [Fact]
    public async Task ARollbackWhoseSwitchOrRemovalFailsChangesNothingOrFinishesWhenRetried()
    {
        using var m = new Mig();
        var user = m.R.Add("Member");
        m.Add(1, "movie", user);
        m.Add(2, "movie", user, status: 2, mediaStatus: 3);
        var commit = await m.Commit();
        Assert.Equal(("je", 2), (m.R.Policy.Configuration.ArrRequestBackend, commit.Imported));

        // The switch back can't be saved: nothing is removed, the batch stays and can be rolled back later.
        m.SaveHook = () => throw new IOException("disk full");
        var unsaved = m.Service.Rollback(commit.BatchId);
        Assert.Equal((503, "switch_failed", "je"), (unsaved.HttpStatus, unsaved.Reason, m.R.Policy.Configuration.ArrRequestBackend));
        Assert.Equal(2, m.Count("SELECT COUNT(*) FROM wants"));
        Assert.Equal(1, m.Count("SELECT COUNT(*) FROM import_batches WHERE state='committed'"));

        // Saved, then the removal fails: request handling is back to Seerr and a retry finishes the rollback.
        m.SaveHook = null;
        m.R.Ledger.Fault = stage => { if (stage == "rollback") throw new IOException("crash"); };
        var half = m.Service.Rollback(commit.BatchId);
        Assert.Equal((503, "rollback_failed", "seerr"), (half.HttpStatus, half.Reason, m.R.Policy.Configuration.ArrRequestBackend));
        Assert.Equal(2, m.Count("SELECT COUNT(*) FROM wants"));
        Assert.Equal(1, m.Count("SELECT COUNT(*) FROM import_batches WHERE state='committed'"));
        m.R.Ledger.Fault = null;
        var retried = m.Service.Rollback(commit.BatchId);
        Assert.Equal((200, 2, "seerr"), (retried.HttpStatus, retried.Removed, retried.Backend));
        Assert.Equal(0, m.Count("SELECT COUNT(*) FROM wants"));
    }

    [Fact]
    public async Task RollingBackALaterMoveMadeWhileJeHandlesRequestsKeepsJe()
    {
        using var m = new Mig();
        var user = m.R.Add("Member");
        m.Add(1, "movie", user);
        var first = await m.Commit();
        Assert.Equal("je", m.R.Policy.Configuration.ArrRequestBackend);
        m.Add(2, "movie", user, tmdb: 4243);   // a Seerr admin asked in Seerr after the move
        var second = await m.Commit();
        Assert.Equal(1, second.Imported);
        Assert.Contains("stays Jellyfin Enhanced", second.Message, StringComparison.Ordinal);
        var listed = m.Service.Status().Batches!.Select(b => JsonSerializer.Serialize(b)).ToArray();   // newest first
        Assert.Contains("\"returnsTo\":\"je\"", listed[0], StringComparison.Ordinal);
        Assert.Contains("\"returnsTo\":\"seerr\"", listed[1], StringComparison.Ordinal);
        Assert.Equal(1, m.Count("SELECT COUNT(*) FROM import_batches WHERE previous_backend='je' AND id='" + second.BatchId + "'"));

        var later = m.Service.Rollback(second.BatchId);
        Assert.Equal((200, 1, "je"), (later.HttpStatus, later.Removed, m.R.Policy.Configuration.ArrRequestBackend));
        Assert.Contains("stays Jellyfin Enhanced", later.Message, StringComparison.Ordinal);
        Assert.Equal(1, m.Count("SELECT COUNT(*) FROM wants"));           // the first move's want is still there
        var earlier = m.Service.Rollback(first.BatchId);
        Assert.Equal((200, "seerr"), (earlier.HttpStatus, m.R.Policy.Configuration.ArrRequestBackend));
    }

    [Fact]
    public async Task ARequestChangedInSeerrAfterItsPageWasReadMakesTheReadIncomplete()
    {
        using var m = new Mig();
        var user = m.R.Add("Member");
        for (var id = 1; id <= 450; id++) m.Add(id, "movie", user);
        Assert.True((await m.Service.PreviewAsync(CancellationToken.None)).Complete);
        // While page 3 is read: request 450 (page 1, already read) is approved, then request 10 (page 5,
        // not read yet) changes too, so 450 is no longer the most recent change.
        var changed = false;
        m.Seerr.BeforePage = skip =>
        {
            if (skip != 200 || changed) return;
            changed = true;
            lock (m.Seerr.Requests)
            {
                var read = m.Seerr.Requests.Single(r => (int)r["id"]! == 450);
                read["status"] = 2;
                read["updatedAt"] = new DateTime(2026, 10, 1, 0, 0, 0, DateTimeKind.Utc).ToString("o", System.Globalization.CultureInfo.InvariantCulture);
                m.Seerr.Requests.Single(r => (int)r["id"]! == 10)["updatedAt"] = new DateTime(2026, 10, 1, 0, 0, 1, DateTimeKind.Utc).ToString("o", System.Globalization.CultureInfo.InvariantCulture);
            }
        };
        var read = await m.Service.PreviewAsync(CancellationToken.None);
        Assert.Equal((false, "row_changed"), (read.Complete, read.IncompleteReason));
        // Read again with nothing changing meanwhile: complete, with the approval in it.
        var again = await m.Service.PreviewAsync(CancellationToken.None);
        Assert.True(again.Complete, again.IncompleteReason);
        Assert.Equal((449, 1), (again.Pending, again.Processing));
    }

    [Fact]
    public async Task TheSwitchLandsOnTheConfigurationAConfigPageSaveInstalledDuringTheMove()
    {
        using var m = new Mig();
        var user = m.R.Add("Member");
        m.Add(1, "movie", user);
        var live = m.R.Policy.Configuration;
        var service = new SeerrMigration(new SeerrFacts(m.Seerr.Transport), m.R.Ledger, m.R.Policy, m.R.View, null, m.R.Feed, () => live, () => { }, () => m.R.Now);
        var digest = (await service.PreviewAsync(CancellationToken.None)).Digest;
        var saved = new Jellyfin.Plugin.JellyfinEnhanced.Configuration.PluginConfiguration
        {
            ArrIntegrationEnabled = true, ArrPhase1Enabled = true, ArrPhase3Enabled = true, ArrRequestBackend = "seerr",
            JellyseerrEnabled = true, JellyseerrUrls = FakeSeerr.Url, JellyseerrApiKey = FakeSeerr.Key,
        };
        // A config-page save replaces the configuration object while the move reads Seerr.
        m.Seerr.Hold = () => { live = saved; return Task.CompletedTask; };
        var commit = await service.CommitAsync(m.R.Admin, digest, false, CancellationToken.None);
        Assert.Equal((200, 1), (commit.HttpStatus, commit.Imported));
        Assert.Equal("je", saved.ArrRequestBackend);
    }

    private sealed class EndlessStream(long length) : Stream
    {
        public long Served;
        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => false;
        public override long Length => throw new NotSupportedException();
        public override long Position { get => Served; set => throw new NotSupportedException(); }
        public override int Read(byte[] buffer, int offset, int count)
        {
            var n = (int)Math.Min(count, length - Served);
            Array.Fill(buffer, (byte)' ', offset, n);
            Served += n;
            return n;
        }
        public override void Flush() { }
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task AnOversizedSeerrAnswerIsAFailedReadAndIsNotBufferedWhole(bool announcesLength)
    {
        const long size = 64L * 1024 * 1024;
        var stream = new EndlessStream(size);
        using var transport = new IntegrationTransport((_, _) =>
        {
            var content = new StreamContent(stream);
            content.Headers.ContentType = new System.Net.Http.Headers.MediaTypeHeaderValue("application/json");
            if (announcesLength) content.Headers.ContentLength = size;
            return Task.FromResult(new HttpResponseMessage(System.Net.HttpStatusCode.OK) { Content = content });
        });
        var config = new Jellyfin.Plugin.JellyfinEnhanced.Configuration.PluginConfiguration { JellyseerrEnabled = true, JellyseerrUrls = FakeSeerr.Url, JellyseerrApiKey = FakeSeerr.Key };
        var read = await new SeerrFacts(transport).ReadAsync(config, CancellationToken.None);
        Assert.False(read.Complete);
        Assert.InRange(stream.Served, 0, SeerrFacts.MaxResponseBytes + 128 * 1024);
        if (announcesLength) Assert.Equal(0, stream.Served);
    }

    [Fact]
    public async Task TheOutboxHoldsItsSeerrSendsWhileAMoveRuns()
    {
        using var m = new Mig();   // Seerr request handling
        var created = await m.R.Create(m.R.Admin, IntegrationRequestLedgerTests.Movie(777));
        Assert.True(created.HttpStatus < 300, created.Reason);
        Assert.Single(m.R.Ledger.Due(m.R.Now));
        var fence = new SeerrRequestWriteFence();
        var runner = new RequestOutbox(m.R.Ledger, m.R.Policy, m.R.Backend, new RequestTitleLocks(), m.R.Feed, m.R.Audit, () => m.R.Now, null, fence);
        using (var move = await fence.BeginMoveAsync(TimeSpan.FromSeconds(1), CancellationToken.None))
        {
            Assert.NotNull(move);
            await runner.TickAsync(CancellationToken.None);
            // Not even claimed: still queued and due, picked up once the move is over.
            Assert.Equal("queued", Assert.Single(m.R.Ledger.ForWant(created.RequestId!)).State);
            Assert.Single(m.R.Ledger.Due(m.R.Now));
        }
        await runner.TickAsync(CancellationToken.None);
        // Worked on after the move (the test backend binding has no Seerr allowance, so it waits to retry).
        Assert.Equal("retry", Assert.Single(m.R.Ledger.ForWant(created.RequestId!)).State);
    }

    [Fact]
    public async Task ASeasonStillProcessingInSeerrCountsAsSentWhenALaterAskForMoreSeasonsGoesOut()
    {
        using var m = new Mig();
        var alice = m.R.Add("Member");
        var bob = m.R.Add("Member");
        var carol = m.R.Add("Member");
        m.Add(1, "tv", alice, status: 2, mediaStatus: 3, seasons: new[] { 1 });   // approved in Seerr, downloading
        Assert.Equal(1, (await m.Commit()).Imported);
        var both = new MutationInput { Key = Assert.Single(m.R.Ledger.List(alice, false)).Input.Key, Scope = "seasons", Seasons = new[] { 1, 2 } };

        // Bob asks for seasons 1 and 2: only season 2 goes out. Carol asks for both too and joins.
        var bobs = await m.R.Create(bob, both);
        Assert.True(bobs.HttpStatus < 300, bobs.Reason);
        Assert.Equal(new[] { 2 }, Assert.Single(m.R.Ledger.ForWant(bobs.RequestId!)).Input.Seasons);
        var carols = await m.R.Create(carol, both);
        Assert.True(carols.HttpStatus < 300, carols.Reason);
        Assert.Empty(m.R.Ledger.ForWant(carols.RequestId!));

        // Season 2 is sent: both asks are sent (season 1 was Seerr's), nothing is left queued with no job to finish it.
        await m.R.Runner().TickAsync(CancellationToken.None);
        Assert.Equal(1, m.R.Backend.Sends);
        Assert.Equal(("sent", "sent"), (m.R.Ledger.Find(bobs.RequestId!)!.Status, m.R.Ledger.Find(carols.RequestId!)!.Status));
        Assert.Equal(0, m.Count("SELECT COUNT(*) FROM wants WHERE status='queued'"));
        Assert.Empty(m.R.Ledger.Due(m.R.Now));
    }

    [Theory]
    [InlineData("seerr")]
    [InlineData("je")]
    public async Task AnAskStillWaitingInJeDoesNotHideThatSeerrIsAlreadyProcessingTheTitle(string handling)
    {
        using var m = new Mig();
        m.R.Policy.Configuration.ArrRequestBackend = handling;
        var kid = m.R.Add("Kid");
        var waiting = await m.R.Create(kid, IntegrationRequestLedgerTests.Movie(610));
        Assert.Equal("pending", m.R.Ledger.Find(waiting.RequestId!)!.Status);
        m.Add(1, "movie", kid, status: 2, mediaStatus: 3, tmdb: 610);     // also approved in Seerr's own UI, downloading
        var commit = await m.Commit();
        Assert.Equal((200, 1), (commit.HttpStatus, commit.Imported));    // linked, not skipped as "already asked"

        // Two rows in the ledger, one title on every list: the waiting ask leads and only it can be cancelled.
        var link = m.R.Ledger.ForTitle("movie:tmdb:610").Single(w => w.OriginKind == RequestOrigin.SeerrImportKind);
        var (person, mine, list) = await Lists(m, kid);
        Assert.Equal((1, 1), (person.GetProperty("active").GetInt32(), person.GetProperty("waiting").GetInt32()));
        Assert.Equal((waiting.RequestId, "pending"), (Assert.Single(person.GetProperty("requests").EnumerateArray()).GetProperty("id").GetString(), person.GetProperty("requests")[0].GetProperty("status").GetString()));
        var row = Assert.Single(mine);
        Assert.Equal(("pending", true), (row.GetProperty("status").GetString(), row.GetProperty("canCancel").GetBoolean()));
        Assert.Equal(new[] { waiting.RequestId }, row.GetProperty("cancelIds").EnumerateArray().Select(e => e.GetString()).ToArray());
        var listed = Assert.Single(list);
        Assert.Equal("pending", listed.GetProperty("status").GetString());
        Assert.Equal(new[] { waiting.RequestId, link.Id }, listed.GetProperty("members").EnumerateArray().Select(e => e.GetProperty("id").GetString()).ToArray());

        // Approving the waiting ask sends nothing and charges nothing: Seerr already sent the title.
        var approved = await m.R.Service.ApproveAsync(waiting.RequestId!, m.R.Admin, null, CancellationToken.None);
        Assert.Equal((200, "looking"), (approved.HttpStatus, approved.Reason));
        Assert.Equal("sent", m.R.Ledger.Find(waiting.RequestId!)!.Status);
        Assert.Equal(0, m.Count("SELECT COUNT(*) FROM jobs"));
        Assert.Equal(0, m.Count("SELECT COALESCE(SUM(cost),0) FROM reservations WHERE state='charged'"));
    }

    [Fact]
    public async Task AnAskJeSentToSeerrBeforeTheMoveStillLinksOrWaitsForAnOkInJe()
    {
        using var m = new Mig();   // Seerr request handling
        var alice = m.R.Add("Member");
        var dave = m.R.Add("Member");
        var bob = m.R.Add("Member");
        async Task<string> SentToSeerr(Guid user, int tmdb)
        {
            var asked = await m.R.Create(user, IntegrationRequestLedgerTests.Movie(tmdb));
            Assert.True(asked.HttpStatus < 300, asked.Reason);
            var job = Assert.Single(m.R.Ledger.ForWant(asked.RequestId!));
            Assert.True(m.R.Ledger.Claim(job, m.R.Db.Generation, m.R.Now));
            Assert.True(m.R.Ledger.Complete(job, m.R.Db.Generation, new RequestBackendResult(RequestOutcome.Accepted(asked.RequestId!, "looking", 200), Confirmed: true), m.R.Now));
            Assert.Equal("sent", m.R.Ledger.Find(asked.RequestId!)!.Status);
            return asked.RequestId!;
        }
        await SentToSeerr(alice, 620);
        await SentToSeerr(dave, 630);
        m.Add(1, "movie", alice, status: 2, mediaStatus: 3, tmdb: 620);   // Seerr approved Alice's and is fetching it
        m.Add(2, "movie", dave, tmdb: 630);                                // Dave's still waits for an OK in Seerr
        var commit = await m.Commit();
        Assert.Equal((200, 2), (commit.HttpStatus, commit.Imported));
        Assert.Equal("je", m.R.Policy.Configuration.ArrRequestBackend);
        var link = m.R.Ledger.ForTitle("movie:tmdb:620").Single(w => w.UserId == alice && w.OriginKind == RequestOrigin.SeerrImportKind);
        Assert.Equal("sent", link.Status);
        // Dave's waiting ask now waits in JE's Approvals.
        Assert.Contains(m.R.Ledger.List(m.R.Admin, true), w => w.UserId == dave && w.Input.Key == "movie:tmdb:630");
        // Alice's ask and the link to Seerr's request are one title on her lists, and on the Household tab.
        Assert.Equal(2, m.R.Ledger.List(alice, false).Count(w => w.Input.Key == "movie:tmdb:620"));
        var (person, mine, list) = await Lists(m, alice);
        Assert.Equal((1, 0), (person.GetProperty("active").GetInt32(), person.GetProperty("waiting").GetInt32()));
        Assert.Single(person.GetProperty("requests").EnumerateArray());
        Assert.Equal(("sent", false), (Assert.Single(mine).GetProperty("status").GetString(), mine[0].GetProperty("canCancel").GetBoolean()));
        Assert.Equal(2, Assert.Single(list).GetProperty("members").GetArrayLength());

        // Bob joins what Seerr is fetching: nothing sent, nothing charged. Alice asking again is the same ask.
        var bobs = await m.R.Create(bob, IntegrationRequestLedgerTests.Movie(620));
        Assert.Equal((200, "merged", "looking"), (bobs.HttpStatus, bobs.Outcome, bobs.Reason));
        Assert.Equal(0, m.R.Ledger.Find(bobs.RequestId!)!.Cost);
        var again = await m.R.Create(alice, IntegrationRequestLedgerTests.Movie(620));
        Assert.Equal((200, link.Id), (again.HttpStatus, again.RequestId));
        Assert.Equal(2, m.Count("SELECT COUNT(*) FROM jobs"));            // only the two sent to Seerr before the move
        Assert.Empty(m.R.Ledger.Due(m.R.Now));
    }

    [Fact]
    public async Task AMoveRefusesWhenTheSeerrAddressChangesBeforeTheSwitch()
    {
        using var m = new Mig();
        var user = m.R.Add("Member");
        m.Add(1, "movie", user);
        var live = m.R.Policy.Configuration;
        var service = new SeerrMigration(new SeerrFacts(m.Seerr.Transport), m.R.Ledger, m.R.Policy, m.R.View, null, m.R.Feed, () => live, () => { }, () => m.R.Now);
        var digest = (await service.PreviewAsync(CancellationToken.None)).Digest;
        var saved = new Jellyfin.Plugin.JellyfinEnhanced.Configuration.PluginConfiguration
        {
            ArrIntegrationEnabled = true, ArrPhase1Enabled = true, ArrPhase3Enabled = true, ArrRequestBackend = "seerr",
            JellyseerrEnabled = true, JellyseerrUrls = "http://other-seerr.lan:5055", JellyseerrApiKey = FakeSeerr.Key,
        };
        // A config-page save points JE at another Seerr while the move reads the first one.
        m.Seerr.Hold = () => { live = saved; return Task.CompletedTask; };
        var commit = await service.CommitAsync(m.R.Admin, digest, false, CancellationToken.None);
        Assert.Equal((409, "seerr_changed"), (commit.HttpStatus, commit.Reason));
        Assert.Equal("seerr", saved.ArrRequestBackend);
        Assert.Equal(0, m.Count("SELECT COUNT(*) FROM wants"));
        Assert.Equal(0, m.Count("SELECT COUNT(*) FROM import_batches"));   // refused before importing anything

        // Changed after the import, just before the switch: the batch is undone and request handling stays.
        m.Seerr.Hold = null;
        live = m.R.Policy.Configuration;
        service.BeforeSwitch = () => live.JellyseerrUrls = "http://other-seerr.lan:5055";
        var late = await service.CommitAsync(m.R.Admin, digest, false, CancellationToken.None);
        Assert.Equal((409, "seerr_changed"), (late.HttpStatus, late.Reason));
        Assert.Equal("seerr", live.ArrRequestBackend);
        Assert.Equal(0, m.Count("SELECT COUNT(*) FROM wants"));
        Assert.Equal(1, m.Count("SELECT COUNT(*) FROM import_batches WHERE state='rolled_back'"));
    }
}
