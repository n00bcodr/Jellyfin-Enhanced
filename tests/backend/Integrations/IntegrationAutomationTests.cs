using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Controllers;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Automation;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;
using Jellyfin.Plugin.JellyfinEnhanced.Services.AutoRequest;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;

namespace JE.Tests;

/// <summary>
/// Phase 4a, the automation foundation: the switch hierarchy (default off, enforced on workers and routes), recipe modes
/// (Shadow writes nothing but its decision, Ask always waits, Auto only goes ahead for eligible people), kill switches
/// before admission and between queueing and every write, durable atomic budgets (two workers at the last slot,
/// rolling windows, clock skew, uncertain sends across restart and restore, per-instance isolation, fail closed),
/// breakers, server-built origins, durable operations, the one-time migration (Admin/Manager/Member with the old
/// recipes on, across engine on and phase 4 off) and the rollout Shadow override across migration, queued work and
/// every umbrella switch.
/// </summary>
[Collection("Plugin singleton")]
public class IntegrationAutomationTests
{
    internal sealed class Consents : IAutomationConsents
    {
        public Preferences Map { get; } = new();

        /// <summary>Runs as a preference read returns: a change made then is one the read missed.</summary>
        public Action? Reading { get; set; }

        public bool? Preference(Guid user, string recipe)
        {
            var preference = Map.TryGetValue((user, recipe), out var v) ? v : null;
            Reading?.Invoke();
            return preference;
        }

        // Like the settings file's version: odd while a change is made, moved on by each change.
        public long Version(Guid user) => Map.Version;

        internal sealed class Preferences : Dictionary<(Guid, string), bool?>
        {
            private long _version;

            public long Version => Interlocked.Read(ref _version);

            public new bool? this[(Guid, string) key]
            {
                get => base[key];
                set
                {
                    // Like the settings file's version: odd while the change is made, even once it is in place.
                    Interlocked.Increment(ref _version);
                    try { base[key] = value; }
                    finally { Interlocked.Increment(ref _version); }
                }
            }

            public new bool Remove((Guid, string) key)
            {
                Interlocked.Increment(ref _version);
                try { return base.Remove(key); }
                finally { Interlocked.Increment(ref _version); }
            }
        }
    }

    internal sealed class Trust : IAutomationTrust
    {
        public HashSet<Guid> Trusted { get; } = new();
        public bool IsTrusted(Guid user) => Trusted.Contains(user);
    }

    internal sealed class Engine : IDisposable
    {
        public IntegrationRequestLedgerTests.Rig R { get; } = new();
        public PluginConfiguration C => R.Policy.Configuration;
        public AutomationStore Store { get; private set; } = null!;
        public AutomationBudgets Budgets { get; private set; } = null!;
        public AutomationEligibility Eligibility { get; private set; } = null!;
        public AutomationDecider Decider { get; private set; } = null!;
        public AutomationSendGuard Guard { get; private set; } = null!;
        public AutoRequestRecorder Recorder { get; private set; } = null!;
        public Consents Consent { get; } = new();
        /// <summary>The budgets' clock, when a test needs to act while a budget is being read or written.</summary>
        public Func<DateTimeOffset>? BudgetClock { get; set; }
        public Trust Trusted { get; } = new();

        public Engine(bool engine = true)
        {
            // The old recipes' own switches are on, as they are whenever their trigger reaches the recorder.
            C.AutoMovieRequestEnabled = true;
            C.AutoSeasonRequestEnabled = true;
            if (engine) { C.ArrPhase4Enabled = true; C.ArrPhase4AutomationEnabled = true; }
            Build();
        }

        public void Build()
        {
            Store = new(R.Db);
            Budgets = new(R.Db, () => C, () => BudgetClock?.Invoke() ?? R.Now);
            Eligibility = new(Store, Trusted);
            Decider = new(R.Service, Budgets, Eligibility);
            Guard = new(R.Policy, Budgets, Store, Eligibility, () => R.Now, Consent);
            Recorder = new(R.Service, R.View, null, () => R.Now, Decider, Store, Consent);
        }

        public void Reopen() { R.Reopen(); Build(); }

        public void Mode(string recipe, AutomationMode mode, bool killed = false)
        {
            var map = AutomationModes.Read(C).ToDictionary(p => p.Key, p => p.Value);
            map[recipe] = new AutomationRecipeSettings { Mode = AutomationModes.Name(mode), Killed = killed };
            C.ArrAutomationRecipes = AutomationModes.Write(map);
        }

        public RequestOutbox Outbox(IRequestBackend? backend = null) => new(R.Ledger, R.Policy, backend ?? R.Backend, new RequestTitleLocks(), R.Feed, R.Audit, () => R.Now, automation: Guard);

        public long Count(string sql) => R.Db.Read(c => { using var cmd = c.CreateCommand(); cmd.CommandText = sql; return Convert.ToInt64(cmd.ExecuteScalar(), CultureInfo.InvariantCulture); });

        /// <summary>Every row an ask or its send could leave behind, and the request revision.</summary>
        public string Rows() => string.Join(",", new[] { "wants", "acquisitions", "jobs", "reservations", "approvals", "request_audit", "request_events", "request_notices", "request_inputs", "automation_budget" }
            .Select(t => t + "=" + Count("SELECT COUNT(*) FROM " + t))) + ",rev=" + Count("SELECT COALESCE((SELECT CAST(value AS INTEGER) FROM meta WHERE key='request_revision'),0)");

        public Task<AutoRequestOutcome> Auto(Guid user, MutationInput? input = null, string recipe = AutomationRecipes.AutoMovie)
            => Recorder.RecordAsync(recipe, user, input ?? IntegrationRequestLedgerTests.Movie(), CancellationToken.None);

        public void Grant(Guid user) => Store.Commit(new[] { (user, AutomationMigration.LegacySource, (string?)null) }, new Dictionary<string, string>(), R.Now);

        public void Dispose() => R.Dispose();
    }

    private static MutationInput Movie(int id) => IntegrationRequestLedgerTests.Movie(id);

    // ------------------------------------------------------------------ switches

    [Fact]
    public void EveryPhase4SwitchIsOffByDefaultAndTheEngineNeedsEveryParent()
    {
        var fresh = new PluginConfiguration();
        Assert.False(fresh.ArrPhase4Enabled || fresh.ArrPhase4AutomationEnabled || fresh.ArrAutomationShadowOverride || fresh.ArrAutomationKillAll || fresh.ArrAutomationFree);
        Assert.Equal((string.Empty, string.Empty, string.Empty), (fresh.ArrAutomationKilledInstances, fresh.ArrAutomationRecipes, fresh.ArrAutomationMigration));
        Assert.Equal((20, 30, 300, 20, 10), (fresh.ArrAutomationHouseholdAddsPerDay, fresh.ArrAutomationSearchesPerHour, fresh.ArrAutomationSearchesPerDay, fresh.ArrAutomationSeerrPostsPerDay, fresh.ArrAutomationBackfillPerHour));
        // Serialization round trip keeps the defaults (an old saved configuration without the fields reads them as off).
        var xml = new System.Xml.Serialization.XmlSerializer(typeof(PluginConfiguration));
        using var text = new StringWriter();
        xml.Serialize(text, fresh);
        var back = (PluginConfiguration)xml.Deserialize(new StringReader(text.ToString()))!;
        Assert.False(back.ArrPhase4Enabled || back.ArrPhase4AutomationEnabled || back.ArrAutomationShadowOverride || back.ArrAutomationKillAll);
        Assert.Equal(20, back.ArrAutomationHouseholdAddsPerDay);

        for (var bits = 0; bits < 32; bits++)
        {
            var c = new PluginConfiguration
            {
                ArrIntegrationEnabled = (bits & 1) != 0, ArrPhase1Enabled = (bits & 2) != 0, ArrPhase3Enabled = (bits & 4) != 0,
                ArrPhase4Enabled = (bits & 8) != 0, ArrPhase4AutomationEnabled = (bits & 16) != 0,
            };
            Assert.Equal((bits & 11) == 11, AutomationFlags.Phase4(c));
            Assert.Equal(bits == 31, AutomationFlags.Engine(c));
            // Without the engine the existing behaviour applies (no mode), unless the rollout override is on.
            Assert.Equal(bits != 31, AutomationFlags.Control(c, AutomationRecipes.AutoMovie).Legacy);
            c.ArrAutomationShadowOverride = true;
            Assert.Equal(AutomationMode.Shadow, AutomationFlags.Control(c, AutomationRecipes.AutoMovie).Effective);
        }
    }

    [Fact]
    public void ModesReadAsShadowUnlessStoredAndKillsAndTheBackendDecideWhatActs()
    {
        // auto_movie's own switch is on (see AnOldRecipeWhoseOwnSwitchIsOffIsOffUnderTheEngine).
        var c = new PluginConfiguration { ArrIntegrationEnabled = true, ArrPhase1Enabled = true, ArrPhase3Enabled = true, ArrPhase4Enabled = true, ArrPhase4AutomationEnabled = true, ArrRequestBackend = "je", AutoMovieRequestEnabled = true };
        Assert.All(AutomationRecipes.All, r => Assert.Equal(AutomationMode.Shadow, AutomationModes.Mode(c, r)));
        c.ArrAutomationRecipes = "{\"auto_movie\":{\"mode\":\"AUTO\"},\"auto_season\":{\"mode\":\"nonsense\"},\"keep_up\":{\"mode\":\"ask\",\"killed\":true}}";
        Assert.Equal((AutomationMode.Auto, AutomationMode.Shadow, AutomationMode.Ask), (AutomationModes.Mode(c, "auto_movie"), AutomationModes.Mode(c, "auto_season"), AutomationModes.Mode(c, "keep_up")));
        Assert.Equal((AutomationMode.Off, "automation_killed"), (AutomationFlags.Control(c, "keep_up").Effective, AutomationFlags.Control(c, "keep_up").Reason));
        c.ArrAutomationRecipes = "not json";
        Assert.Equal(AutomationMode.Shadow, AutomationModes.Mode(c, "auto_movie"));

        c.ArrAutomationRecipes = AutomationModes.Write(AutomationRecipes.All.ToDictionary(r => r, _ => new AutomationRecipeSettings { Mode = "auto" }));
        Assert.Equal(AutomationMode.Auto, AutomationFlags.Control(c, "release_day").Effective);
        c.ArrAutomationKillAll = true;
        Assert.Equal("automation_killed", AutomationFlags.Control(c, "auto_movie").Reason);
        c.ArrAutomationKillAll = false;
        c.ArrRequestBackend = "seerr";
        Assert.Equal((AutomationMode.Off, "seerr_unsupported"), (AutomationFlags.Control(c, "release_day").Effective, AutomationFlags.Control(c, "release_day").Reason));
        Assert.Equal(AutomationMode.Auto, AutomationFlags.Control(c, "auto_movie").Effective);
        c.ArrRequestBackend = "status_only";
        Assert.Equal("requests_off", AutomationFlags.Control(c, "auto_movie").Reason);
        Assert.Equal(AutomationMode.Auto, AutomationFlags.Control(c, AutomationRecipes.ListSync).Effective);   // membership only
        Assert.True(AutomationFlags.KilledTarget(new PluginConfiguration { ArrAutomationKilledInstances = " abc ,seerr" }, "SEERR"));
        Assert.False(AutomationFlags.KilledTarget(new PluginConfiguration { ArrAutomationKilledInstances = "abcd" }, "abc"));
    }

    // 4a-B-r3-1: under the engine an old recipe whose own switch is off is Off (the status says so), whatever its mode;
    // the recipes that have no such switch aren't affected.
    [Fact]
    public void AnOldRecipeWhoseOwnSwitchIsOffIsOffUnderTheEngine()
    {
        var c = new PluginConfiguration { ArrIntegrationEnabled = true, ArrPhase1Enabled = true, ArrPhase3Enabled = true, ArrRequestBackend = "je", ArrPhase4Enabled = true, ArrPhase4AutomationEnabled = true, AutoSeasonRequestEnabled = true };
        c.ArrAutomationRecipes = AutomationModes.Write(new Dictionary<string, AutomationRecipeSettings>
        {
            [AutomationRecipes.AutoMovie] = new() { Mode = "auto" },
            [AutomationRecipes.AutoSeason] = new() { Mode = "auto" },
            [AutomationRecipes.KeepUp] = new() { Mode = "auto" },
        });
        var movie = AutomationFlags.Control(c, AutomationRecipes.AutoMovie);
        Assert.Equal((AutomationMode.Auto, AutomationMode.Off, "recipe_off"), (movie.Stored, movie.Effective, movie.Reason));
        Assert.Equal(AutomationMode.Auto, AutomationFlags.Control(c, AutomationRecipes.AutoSeason).Effective);
        Assert.Equal(AutomationMode.Auto, AutomationFlags.Control(c, AutomationRecipes.KeepUp).Effective);
        c.AutoMovieRequestEnabled = true;
        c.AutoSeasonRequestEnabled = false;
        Assert.Equal(AutomationMode.Auto, AutomationFlags.Control(c, AutomationRecipes.AutoMovie).Effective);
        Assert.Equal(("recipe_off", AutomationMode.Off), AutomationFlags.Control(c, AutomationRecipes.AutoSeason) is var season ? (season.Reason, season.Effective) : default);
    }

    [Fact]
    public void R4IsNeverScheduledR3OnlyWithAnExplicitPolicyAndR2NeverAutomatically()
    {
        Assert.True(AutomationRiskPolicy.MaySchedule("refresh"));
        Assert.True(AutomationRiskPolicy.MaySchedule("search"));
        Assert.False(AutomationRiskPolicy.MaySchedule("mark_failed"));
        Assert.False(AutomationRiskPolicy.MaySchedule("unmonitor"));
        Assert.True(AutomationRiskPolicy.MaySchedule("unmonitor", explicitReductivePolicy: true));
        foreach (var destructive in new[] { "delete", "delete_files", "remove_with_data", "manual_import", "something_new", null })
        {
            Assert.Equal(AutomationRisk.R4Destructive, AutomationRiskPolicy.Of(destructive));
            Assert.False(AutomationRiskPolicy.MaySchedule(destructive, explicitReductivePolicy: true));
        }
    }

    // ------------------------------------------------------------------ modes

    [Theory]
    [InlineData("Admin", "would_request")]
    [InlineData("Manager", "would_ask")]
    [InlineData("Member", "would_ask")]
    [InlineData("Kid", "would_ask")]
    public async Task ShadowRecordsItsDecisionAndNothingElse(string role, string decision)
    {
        using var e = new Engine();
        e.Mode(AutomationRecipes.AutoMovie, AutomationMode.Shadow);
        var person = role switch { "Admin" => e.R.Admin, "Manager" => e.R.Manager, "Member" => e.R.Member, _ => e.R.Kid };
        var before = e.Rows();
        var outcome = await e.Auto(person);
        Assert.Equal((AutoRequestOutcomeKind.DefinitiveNoop, "shadow_" + decision), (outcome.Kind, outcome.Reason));
        Assert.Equal(before, e.Rows());
        await e.Outbox().TickAsync(default);
        Assert.Equal(0, e.R.Backend.Sends);
        var row = Assert.Single(e.Store.Decisions());
        Assert.Equal(("shadow", decision, AutomationRecipes.AutoMovie, "movie:tmdb:603"), (row.Mode, row.Outcome, row.Recipe, row.TitleKey));
        var detail = JsonDocument.Parse(row.Detail!).RootElement;
        Assert.Equal(decision == "would_request", detail.GetProperty("wouldSend").GetBoolean());
        Assert.Contains(detail.GetProperty("budgets").EnumerateArray(), b => b.GetProperty("category").GetString() == BudgetCategories.HouseholdAdd && b.GetProperty("remaining").GetInt32() == 20);

        // The same trigger again is the same decision (a repeat), never a second one; still nothing written.
        await e.Auto(person);
        Assert.Equal(1, Assert.Single(e.Store.Decisions()).Repeats);
        Assert.Equal(before, e.Rows());
    }

    [Theory]
    [InlineData("Admin")]
    [InlineData("Manager")]
    public async Task AskAlwaysCreatesAPendingApprovalEvenForSomeoneWhoCouldAskDirectly(string role)
    {
        using var e = new Engine();
        e.Mode(AutomationRecipes.AutoMovie, AutomationMode.Ask);
        var person = role == "Admin" ? e.R.Admin : e.R.Manager;
        e.Grant(e.R.Manager);
        var outcome = await e.Auto(person);
        Assert.Equal((AutoRequestOutcomeKind.WantRecorded, "awaiting_approval"), (outcome.Kind, outcome.Reason));
        var want = e.R.Ledger.Find(outcome.WantId!)!;
        Assert.Equal(("pending", "automation", AutomationRecipes.AutoMovie), (want.Status, want.OriginKind, want.OriginSource));
        Assert.Empty(e.R.Ledger.ForWant(want.Id));
        Assert.True(RequestOriginDetail.Read(want.OriginDetail)!.RequireApproval);
        var row = Assert.Single(e.Store.Decisions());
        Assert.Equal(("ask", "asked"), (row.Mode, row.Outcome));
        Assert.Equal("ask_mode", JsonDocument.Parse(row.Detail!).RootElement.GetProperty("approval").GetString());
        // An OK sends it.
        Assert.Equal(200, (await e.R.Service.ApproveAsync(want.Id, e.R.Admin, null, default)).HttpStatus);
        await e.Outbox().TickAsync(default);
        Assert.Equal(1, e.R.Backend.Sends);
    }

    [Fact]
    public async Task AutoGoesAheadOnlyForAdminsTrustedPeopleAndRecordedGrants()
    {
        using var e = new Engine();
        e.Mode(AutomationRecipes.AutoMovie, AutomationMode.Auto);
        var granted = e.R.Add("Manager");
        var trusted = e.R.Add("Manager");
        e.Grant(granted);
        e.Trusted.Trusted.Add(trusted);
        var cases = new (Guid User, string Status)[] { (e.R.Admin, "queued"), (granted, "queued"), (trusted, "queued"), (e.R.Manager, "pending"), (e.R.Member, "pending"), (e.R.Kid, "pending") };
        var id = 700;
        foreach (var (user, status) in cases)
        {
            var outcome = await e.Auto(user, Movie(id++));
            Assert.Equal(AutoRequestOutcomeKind.WantRecorded, outcome.Kind);
            Assert.Equal(status, e.R.Ledger.Find(outcome.WantId!)!.Status);
        }
        var notEligible = e.Store.Decisions().Single(d => d.UserId == e.R.Manager.ToString("N"));
        Assert.Equal(("auto", "asked", "not_eligible"), (notEligible.Mode, notEligible.Outcome, JsonDocument.Parse(notEligible.Detail!).RootElement.GetProperty("approval").GetString()));
        // A grant gives no other privilege: a granted Kid or Watcher is never eligible.
        Assert.False(e.Eligibility.Eligible(Guid.NewGuid(), "Kid"));
    }

    [Fact]
    public async Task OffKilledAndOptedOutCreateNothingAndShadowStillRecordsWhileKilled()
    {
        using var e = new Engine();
        e.Mode(AutomationRecipes.AutoMovie, AutomationMode.Off);
        Assert.Equal("recipe_off", (await e.Auto(e.R.Admin)).Reason);
        Assert.Empty(e.Store.Decisions());

        e.Mode(AutomationRecipes.AutoMovie, AutomationMode.Auto, killed: true);
        Assert.Equal("automation_killed", (await e.Auto(e.R.Admin)).Reason);
        e.Mode(AutomationRecipes.AutoMovie, AutomationMode.Auto);
        e.C.ArrAutomationKillAll = true;
        Assert.Equal("automation_killed", (await e.Auto(e.R.Admin, Movie(604))).Reason);
        Assert.Equal(0, e.Count("SELECT COUNT(*) FROM wants"));
        Assert.All(e.Store.Decisions(), d => Assert.Equal("killed", d.Outcome));

        e.Mode(AutomationRecipes.AutoMovie, AutomationMode.Shadow);
        Assert.StartsWith("shadow_", (await e.Auto(e.R.Admin, Movie(605))).Reason);
        e.C.ArrAutomationKillAll = false;

        // A person's opt-out is honoured; never chosen follows the administrator for the existing recipes, and is "no"
        // for a new recipe.
        e.Mode(AutomationRecipes.AutoMovie, AutomationMode.Auto);
        e.Consent.Map[(e.R.Admin, AutomationRecipes.AutoMovie)] = false;
        Assert.Equal("user_opted_out", (await e.Auto(e.R.Admin, Movie(606))).Reason);
        e.Consent.Map.Remove((e.R.Admin, AutomationRecipes.AutoMovie));
        Assert.Equal(AutoRequestOutcomeKind.WantRecorded, (await e.Auto(e.R.Admin, Movie(606))).Kind);
        e.Mode(AutomationRecipes.KeepUp, AutomationMode.Auto);
        Assert.Equal("user_opted_out", (await e.Auto(e.R.Admin, Movie(607), AutomationRecipes.KeepUp)).Reason);
        e.Consent.Map[(e.R.Admin, AutomationRecipes.KeepUp)] = true;
        Assert.False(AutomationConsent.Allows(e.Consent, e.R.Member, AutomationRecipes.KeepUp));
    }

    [Theory]
    [InlineData("je", "r1")]
    [InlineData("seerr", "seerr")]
    public async Task AKilledTargetCreatesNoRequestReservationOrJobAndShadowStillRecords(string backend, string target)
    {
        using var e = new Engine();
        e.C.ArrRequestBackend = backend;
        e.Mode(AutomationRecipes.AutoMovie, AutomationMode.Auto);
        e.C.ArrAutomationKilledInstances = "other, " + target;
        var rows = e.Rows();
        var killed = await e.Auto(e.R.Admin, Movie(670));
        Assert.Equal((AutoRequestOutcomeKind.DefinitiveNoop, AutomationHolds.Killed), (killed.Kind, killed.Reason));
        Assert.Equal(rows, e.Rows());
        Assert.Equal(("killed", AutomationHolds.Killed), e.Store.Decisions().Single() is var d ? (d.Outcome, d.Reason) : default);

        // Ask mode records no waiting request against a killed target either.
        e.Mode(AutomationRecipes.AutoMovie, AutomationMode.Ask);
        Assert.Equal(AutomationHolds.Killed, (await e.Auto(e.R.Member, Movie(671))).Reason);
        Assert.Equal(rows, e.Rows());

        // Turned on while the ask was being prepared: nothing is recorded.
        e.Mode(AutomationRecipes.AutoMovie, AutomationMode.Auto);
        e.C.ArrAutomationKilledInstances = "other";
        e.R.Policy.Before = (_, _) => { e.C.ArrAutomationKilledInstances = target; return Task.CompletedTask; };
        Assert.Equal(AutomationHolds.Killed, (await e.Auto(e.R.Admin, Movie(672))).Reason);
        Assert.Equal(rows, e.Rows());
        e.R.Policy.Before = null;

        // Shadow still records what it would have done; another target's kill doesn't stop it; people's own asks go on.
        e.Mode(AutomationRecipes.AutoMovie, AutomationMode.Shadow);
        Assert.StartsWith("shadow_", (await e.Auto(e.R.Admin, Movie(673))).Reason);
        Assert.Equal(201, (await e.R.Create(e.R.Admin, Movie(674))).HttpStatus);
        e.Mode(AutomationRecipes.AutoMovie, AutomationMode.Auto);
        e.C.ArrAutomationKilledInstances = "other";
        Assert.Equal(AutoRequestOutcomeKind.WantRecorded, (await e.Auto(e.R.Admin, Movie(675))).Kind);
    }

    // The recorder reads the recipe's mode, then the request service's preparation reads run. A change in between (Auto
    // to Shadow or Ask, the engine turned on, the person opting out) is read again right before the ledger write, and
    // the ask starts over under the current rules instead of being recorded under the old ones.
    [Theory]
    [InlineData("shadow")]
    [InlineData("ask")]
    [InlineData("engine_on")]
    [InlineData("opted_out")]
    [InlineData("flapping")]
    public async Task AChangeWhileARecipesAskIsPreparedIsReadAgainBeforeAnythingIsRecorded(string change)
    {
        using var e = new Engine(engine: change != "engine_on");
        e.Mode(AutomationRecipes.AutoMovie, change == "engine_on" ? AutomationMode.Shadow : AutomationMode.Auto);
        var rows = e.Rows();
        var changed = false;
        e.R.Policy.Before = (_, _) =>
        {
            if (change == "flapping")
            {
                // Changed again during every attempt: bounded, nothing recorded, tried again on the next trigger.
                e.Mode(AutomationRecipes.AutoMovie, changed ? AutomationMode.Auto : AutomationMode.Ask);
                changed = !changed;
                return Task.CompletedTask;
            }
            if (changed) return Task.CompletedTask;
            changed = true;
            if (change == "shadow") e.Mode(AutomationRecipes.AutoMovie, AutomationMode.Shadow);
            else if (change == "ask") e.Mode(AutomationRecipes.AutoMovie, AutomationMode.Ask);
            else if (change == "engine_on") { e.C.ArrPhase4Enabled = true; e.C.ArrPhase4AutomationEnabled = true; }
            else e.Consent.Map[(e.R.Admin, AutomationRecipes.AutoMovie)] = false;
            return Task.CompletedTask;
        };
        var outcome = await e.Auto(e.R.Admin, Movie(680));
        e.R.Policy.Before = null;
        if (change == "flapping")
        {
            Assert.Equal((AutoRequestOutcomeKind.PreparationFailed, AutomationHolds.EngineChanged), (outcome.Kind, outcome.Reason));
            Assert.Equal(rows, e.Rows());
            Assert.Empty(e.Store.Decisions());
            return;
        }
        Assert.True(changed);
        if (change == "ask")
        {
            Assert.Equal(AutoRequestOutcomeKind.WantRecorded, outcome.Kind);
            Assert.Equal("pending", e.R.Ledger.Find(outcome.WantId!)!.Status);
            Assert.Equal(("asked", "ask"), e.Store.Decisions().Single() is var asked ? (asked.Outcome, asked.Mode) : default);
            return;
        }
        Assert.Equal(rows, e.Rows());
        if (change == "opted_out") Assert.Equal((AutoRequestOutcomeKind.DefinitiveNoop, "user_opted_out"), (outcome.Kind, outcome.Reason));
        else
        {
            Assert.StartsWith("shadow_", outcome.Reason, StringComparison.Ordinal);
            Assert.Equal("shadow", e.Store.Decisions().Single().Mode);
        }
    }

    // An old recipe's own enable switch (Auto Movie Request / Auto Season Request), as an administrator saves it.
    internal static void Switch(PluginConfiguration c, string recipe, bool on)
    {
        if (recipe == AutomationRecipes.AutoMovie) c.AutoMovieRequestEnabled = on;
        else c.AutoSeasonRequestEnabled = on;
    }

    private static MutationInput For(string recipe, int id) => recipe == AutomationRecipes.AutoMovie ? Movie(id) : IntegrationRequestLedgerTests.Seasons(id);

    private static string Other(string recipe) => recipe == AutomationRecipes.AutoMovie ? AutomationRecipes.AutoSeason : AutomationRecipes.AutoMovie;

    // 4a-B-r3-1 / 4a-security-r3-1: an old recipe's own enable switch turned off while its ask is prepared (the request
    // service's reads, or Shadow's preview reads) records nothing: no want, approval, reservation, job or decision, in
    // every mode and with the engine off. Already off when the recorder is asked: refused before any read. The other
    // recipe keeps asking, and switched back on it asks as usual.
    [Theory]
    [InlineData(AutomationRecipes.AutoMovie, "auto")]
    [InlineData(AutomationRecipes.AutoMovie, "ask")]
    [InlineData(AutomationRecipes.AutoMovie, "shadow")]
    [InlineData(AutomationRecipes.AutoMovie, "engine_off")]
    [InlineData(AutomationRecipes.AutoSeason, "auto")]
    [InlineData(AutomationRecipes.AutoSeason, "ask")]
    [InlineData(AutomationRecipes.AutoSeason, "shadow")]
    [InlineData(AutomationRecipes.AutoSeason, "engine_off")]
    public async Task AnOldRecipesSwitchTurnedOffWhileItsAskIsPreparedRecordsNothing(string recipe, string mode)
    {
        using var e = new Engine(engine: mode != "engine_off");
        if (mode != "engine_off")
        {
            e.Mode(recipe, AutomationModes.Parse(mode));
            e.Mode(Other(recipe), AutomationModes.Parse(mode));
        }
        var rows = e.Rows();
        var reads = 0;
        e.R.Policy.Before = (_, _) =>
        {
            if (reads++ == 0) Switch(e.C, recipe, false);
            return Task.CompletedTask;
        };
        var outcome = await e.Auto(e.R.Admin, For(recipe, 2), recipe);
        Assert.True(reads > 0);
        Assert.Equal((AutoRequestOutcomeKind.DefinitiveNoop, "disabled"), (outcome.Kind, outcome.Reason));
        Assert.Equal(rows, e.Rows());
        Assert.Empty(e.Store.Decisions());

        // Already off: refused before any read.
        reads = 0;
        Assert.Equal("disabled", (await e.Auto(e.R.Admin, For(recipe, 3), recipe)).Reason);
        Assert.Equal(0, reads);
        Assert.Equal(rows, e.Rows());
        e.R.Policy.Before = null;

        // The other recipe is unaffected; switched back on, this one asks as usual.
        var other = await e.Auto(e.R.Admin, For(Other(recipe), 4), Other(recipe));
        Switch(e.C, recipe, true);
        var again = await e.Auto(e.R.Admin, For(recipe, 2), recipe);
        foreach (var asked in new[] { other, again })
        {
            if (mode == "shadow") Assert.StartsWith("shadow_", asked.Reason, StringComparison.Ordinal);
            else Assert.Equal((AutoRequestOutcomeKind.WantRecorded, mode == "ask" ? "pending" : "queued"), (asked.Kind, e.R.Ledger.Find(asked.WantId!)!.Status));
        }
    }

    // The same sweep for the umbrella switches: phase 3 turned off, or request handling set to Status only, while an
    // automatic ask is prepared records nothing (the ledger write evaluates the policy as it is then; production's
    // RequestPolicy refuses Status only as feature_disabled, which the test policy mirrors here).
    [Theory]
    [InlineData("phase3_off", true)]
    [InlineData("phase3_off", false)]
    [InlineData("status_only", true)]
    [InlineData("status_only", false)]
    public async Task RequestsTurnedOffWhileAnAutomaticAskIsPreparedRecordNothing(string change, bool engine)
    {
        using var e = new Engine(engine);
        if (engine) e.Mode(AutomationRecipes.AutoMovie, AutomationMode.Auto);
        e.R.Policy.Adjust = (_, _, facts) => e.C.ArrRequestBackend is "je" or "seerr" ? facts : facts with { Refusal = "feature_disabled" };
        var rows = e.Rows();
        e.R.Policy.Before = (_, _) =>
        {
            if (change == "phase3_off") e.C.ArrPhase3Enabled = false;
            else e.C.ArrRequestBackend = "status_only";
            return Task.CompletedTask;
        };
        var outcome = await e.Auto(e.R.Admin, Movie(695));
        e.R.Policy.Before = null;
        Assert.NotEqual(AutoRequestOutcomeKind.WantRecorded, outcome.Kind);
        Assert.Null(outcome.WantId);
        Assert.Equal(rows, e.Rows());
    }

    [Fact]
    public async Task WithTheEngineOffTheExistingRecipesBehaveExactlyAsBefore()
    {
        using var e = new Engine(engine: false);
        e.Mode(AutomationRecipes.AutoMovie, AutomationMode.Off);   // stored, never read without the engine
        e.C.ArrAutomationKillAll = true;
        var manager = await e.Auto(e.R.Manager);
        var member = await e.Auto(e.R.Member, Movie(604));
        Assert.Equal("queued", e.R.Ledger.Find(manager.WantId!)!.Status);
        Assert.Equal("pending", e.R.Ledger.Find(member.WantId!)!.Status);
        Assert.Empty(e.Store.Decisions());
        await e.Outbox().TickAsync(default);
        Assert.Equal(1, e.R.Backend.Sends);
        Assert.Equal(0, e.Count("SELECT COUNT(*) FROM automation_budget"));
    }

    [Fact]
    public async Task FreeAutomationCostsNobodysAllowance()
    {
        using var e = new Engine();
        e.Mode(AutomationRecipes.AutoMovie, AutomationMode.Auto);
        e.C.ArrAutomationFree = true;
        var outcome = await e.Auto(e.R.Admin);
        Assert.Equal(0, e.R.Ledger.Find(outcome.WantId!)!.Cost);
        Assert.Equal(0, e.Count("SELECT COALESCE(SUM(cost),0) FROM reservations"));
        Assert.True(RequestOriginDetail.Read(e.R.Ledger.Find(outcome.WantId!)!.OriginDetail)!.Free);
    }

    [Fact]
    public async Task FreeAutomationStaysFreeWhenItIsApprovedOrTakesOverAScopeAndItsGbStillCounts()
    {
        using var e = new Engine();
        e.Mode(AutomationRecipes.AutoMovie, AutomationMode.Ask);
        e.C.ArrAutomationFree = true;
        var asked = await e.Auto(e.R.Admin, Movie(660));
        Assert.Equal("pending", e.R.Ledger.Find(asked.WantId!)!.Status);
        Assert.Equal(200, (await e.R.Service.ApproveAsync(asked.WantId!, e.R.Admin, null, default)).HttpStatus);
        var approved = e.R.Ledger.Find(asked.WantId!)!;
        Assert.Equal(("queued", 0), (approved.Status, approved.Cost));
        Assert.Equal(0, e.Count("SELECT COALESCE(SUM(cost),0) FROM reservations WHERE want_id='" + approved.Id + "'"));

        // Following a Kid's waiting ask, then owning the scope once that ask is declined: still free.
        e.Mode(AutomationRecipes.AutoMovie, AutomationMode.Auto);
        var kid = await e.R.Create(e.R.Kid, Movie(661));
        var follower = await e.Auto(e.R.Member, Movie(661));
        Assert.Equal("pending", e.R.Ledger.Find(follower.WantId!)!.Status);
        Assert.Equal(200, e.R.Service.Close(kid.RequestId!, e.R.Admin, "Not this one").HttpStatus);
        var owner = e.R.Ledger.Find(follower.WantId!)!;
        Assert.NotNull(owner.OwnedInput);
        Assert.Equal(0, owner.Cost);
        Assert.Equal(0, e.Count("SELECT COALESCE(SUM(cost),0) FROM reservations WHERE want_id='" + owner.Id + "'"));
        Assert.Equal(200, (await e.R.Service.ApproveAsync(owner.Id, e.R.Admin, null, default)).HttpStatus);
        Assert.Equal(0, e.R.Ledger.Find(owner.Id)!.Cost);

        // A person's own ask is still charged as before.
        var own = await e.R.Create(e.R.Kid, Movie(662));
        Assert.Equal(200, (await e.R.Service.ApproveAsync(own.RequestId!, e.R.Admin, null, default)).HttpStatus);
        Assert.Equal(1, e.R.Ledger.Find(own.RequestId!)!.Cost);
        string Gb(string id) => e.R.Db.Read(c => { using var cmd = c.CreateCommand(); cmd.CommandText = "SELECT COALESCE(SUM(estimated_gb),0) FROM reservations WHERE want_id='" + id + "'"; return Convert.ToString(cmd.ExecuteScalar(), CultureInfo.InvariantCulture)!; });
        Assert.Equal(Gb(own.RequestId!), Gb(approved.Id));
    }

    // ------------------------------------------------------------------ the no-write seam and origins

    [Fact]
    public async Task APreviewAnswersWhatAnAskWouldDoAndWritesNothing()
    {
        using var e = new Engine();
        var before = e.Rows();
        var preview = await e.R.Service.PreviewAsync(e.R.Member, new CreateRequest("p1", Movie(603)), default);
        Assert.Equal(before, e.Rows());
        Assert.Equal((true, "queued", true, 1), (preview.New, preview.Status, preview.WouldSend, preview.Cost));
        var asked = await e.R.Create(e.R.Member, Movie(603), "p1");
        Assert.Equal(("queued", 1), (e.R.Ledger.Find(asked.RequestId!)!.Status, e.R.Ledger.Find(asked.RequestId!)!.Cost));
        // Now someone else's preview follows the existing request; the same id again is the person's existing one.
        var follow = await e.R.Service.PreviewAsync(e.R.Kid, new CreateRequest("p2", Movie(603)), default);
        Assert.False(follow.WouldSend);
        Assert.False((await e.R.Service.PreviewAsync(e.R.Member, new CreateRequest("p1", Movie(603)), default)).New);
        var invalid = await e.R.Service.PreviewAsync(e.R.Member, new CreateRequest("p3", new MutationInput { Key = "nope" }), default);
        Assert.Equal(400, invalid.Outcome.HttpStatus);
    }

    [Fact]
    public async Task ServerBuiltOriginsAndProvenancePersistWithTheWant()
    {
        using var e = new Engine();
        var op = Guid.NewGuid().ToString("N");
        var origin = RequestOrigin.List("L1", new RequestProvenance(EntryId: "E7", ListRevision: 12, OperationId: op));
        var created = e.R.Ledger.Create(e.R.Admin, new CreateRequest("c1", Movie(610)), e.R.Policy, e.R.Now, origin);
        var want = e.R.Ledger.Find(created.RequestId!)!;
        Assert.Equal(("list", "list:L1", op), (want.OriginKind, want.OriginSource, want.OperationId));
        var detail = RequestOriginDetail.Read(want.OriginDetail)!;
        Assert.Equal(("L1", "E7", 12L, op), (detail.Provenance!.ListId, detail.Provenance.EntryId, detail.Provenance.ListRevision, detail.Provenance.OperationId));
        Assert.False(origin.Automatic);
        Assert.True(RequestOrigin.Sync("L1", new RequestProvenance()).Automatic);
        Assert.Equal(AutomationRecipes.ListSyncRequests, RequestOrigin.Sync("L1", new RequestProvenance()).Recipe);
        Assert.True(RequestOrigin.IsPhase4Only("list", "list:L1"));
        Assert.True(RequestOrigin.IsPhase4Only("automation", AutomationRecipes.KeepUp));
        Assert.False(RequestOrigin.IsPhase4Only("automation", AutomationRecipes.AutoSeason));
        Assert.False(RequestOrigin.IsPhase4Only("interactive", null));
        // A plain ask stores no detail.
        Assert.Null(e.R.Ledger.Find((await e.R.Create(e.R.Member, Movie(611))).RequestId!)!.OriginDetail);
        // Purging the person removes their decisions, grants and operations too.
        e.Grant(e.R.Admin);
        new RequestOperations(e.R.Db).Begin(e.R.Admin, RequestOperations.RequestBatch, "confirm-1", "f", "list:L1", 1, e.R.Now);
        e.R.Ledger.PurgeUser(e.R.Admin);
        Assert.Equal((0L, 0L), (e.Count("SELECT COUNT(*) FROM automation_grants"), e.Count("SELECT COUNT(*) FROM request_operations")));
    }

    [Fact]
    public void OperationsReplayTheSameIdsCapBatchesAndRefuseAChangedConfirmation()
    {
        using var e = new Engine();
        var ops = new RequestOperations(e.R.Db);
        var first = ops.Begin(e.R.Member, RequestOperations.RequestBatch, "press-1", "fp", "list:L1", 3, e.R.Now);
        Assert.NotNull(first.Operation);
        var again = ops.Begin(e.R.Member, RequestOperations.RequestBatch, "press-1", "fp", "list:L1", 3, e.R.Now);
        Assert.Equal((first.Operation!.Id, true), (again.Operation!.Id, again.Replayed));
        Assert.Equal("idempotency_conflict", ops.Begin(e.R.Member, RequestOperations.RequestBatch, "press-1", "other", "list:L1", 3, e.R.Now).Refusal);
        Assert.Equal("batch_too_large", ops.Begin(e.R.Member, RequestOperations.RequestBatch, "press-2", "fp", null, 21, e.R.Now).Refusal);
        Assert.NotNull(ops.Begin(e.R.Member, RequestOperations.RequestBatch, "press-3", "fp", null, 20, e.R.Now).Operation);
        Assert.NotNull(ops.Begin(e.R.Member, "import_handoff", "h-1", "fp", null, 2000, e.R.Now).Operation);
        // After a restart the operation is still there, with the same child ids.
        e.Reopen();
        ops = new RequestOperations(e.R.Db);
        Assert.Equal(first.Operation.Id, ops.Begin(e.R.Member, RequestOperations.RequestBatch, "press-1", "fp", "list:L1", 3, e.R.Now).Operation!.Id);
        var child = RequestOperations.ChildRequestId(first.Operation.Id, e.R.Member, Movie(603), "t");
        Assert.Equal(child, RequestOperations.ChildRequestId(first.Operation.Id, e.R.Member, Movie(603) with { ProfileId = null }, "t"));
        Assert.NotEqual(child, RequestOperations.ChildRequestId(Guid.NewGuid().ToString("N"), e.R.Member, Movie(603), "t"));
        Assert.NotEqual(child, RequestOperations.ChildRequestId(first.Operation.Id, e.R.Kid, Movie(603), "t"));
        Assert.NotEqual(child, RequestOperations.ChildRequestId(first.Operation.Id, e.R.Member, IntegrationRequestLedgerTests.Movie(603, "4k"), "t"));
        Assert.NotEqual(child, RequestOperations.ChildRequestId(first.Operation.Id, e.R.Member, Movie(603), "other-target"));
        Assert.True(child!.Length <= 128);
        var trigger = RequestOperations.TriggerIdentity(AutomationRecipes.ListAcquireAhead, e.R.Member, Movie(603), "t", "session-1:item-9");
        Assert.NotEqual(trigger, RequestOperations.TriggerIdentity(AutomationRecipes.ListAcquireAhead, e.R.Member, Movie(603), "t", "session-2:item-9"));
        Assert.StartsWith("auto:" + AutomationRecipes.ListAcquireAhead + ":", trigger);
        Assert.True(ops.Finish(first.Operation.Id, "completed", e.R.Now));
        Assert.False(ops.Finish(first.Operation.Id, "completed", e.R.Now));
    }

    // ------------------------------------------------------------------ the send guard

    private static async Task<RequestWant> Queued(Engine e, Guid user, int movie, string recipe = AutomationRecipes.AutoMovie)
    {
        var outcome = await e.Auto(user, Movie(movie), recipe);
        var want = e.R.Ledger.Find(outcome.WantId!)!;
        Assert.Equal("queued", want.Status);
        return want;
    }

    [Fact]
    public async Task AKillBeforeTheSendHoldsQueuedAutomaticWorkUntilItIsOffAndNeverTouchesPeoplesOwnAsks()
    {
        using var e = new Engine();
        e.Mode(AutomationRecipes.AutoMovie, AutomationMode.Auto);
        var want = await Queued(e, e.R.Admin, 620);
        var own = await e.R.Create(e.R.Member, Movie(621));
        e.C.ArrAutomationKillAll = true;
        await e.Outbox().TickAsync(default);
        Assert.Equal(1, e.R.Backend.Sends);   // the person's own ask only
        var job = Assert.Single(e.R.Ledger.ForWant(want.Id));
        Assert.Equal(("retry", AutomationHolds.Killed), (job.State, job.Reason));
        Assert.Equal(e.R.Now + TimeSpan.FromMinutes(5), job.NextAttempt);
        Assert.Equal(("queued", AutomationHolds.Killed), (e.R.Ledger.Find(want.Id)!.Status, e.R.Ledger.Find(want.Id)!.Reason));
        e.R.Now += TimeSpan.FromMinutes(6);
        await e.Outbox().TickAsync(default);
        Assert.Equal(1, e.R.Backend.Sends);
        e.C.ArrAutomationKillAll = false;
        e.R.Now += TimeSpan.FromMinutes(6);
        await e.Outbox().TickAsync(default);
        Assert.Equal(2, e.R.Backend.Sends);
        Assert.Equal("sent", e.R.Ledger.Find(want.Id)!.Status);
        Assert.Equal("sent", e.R.Ledger.Find(own.RequestId!)!.Status);
    }

    [Theory]
    [InlineData("instance")]
    [InlineData("recipe")]
    public async Task AnInstanceOrRecipeKillHoldsOnlyItsOwnWork(string scope)
    {
        using var e = new Engine();
        e.Mode(AutomationRecipes.AutoMovie, AutomationMode.Auto);
        e.Mode(AutomationRecipes.AutoSeason, AutomationMode.Auto);
        var movie = await Queued(e, e.R.Admin, 622);
        if (scope == "instance") e.C.ArrAutomationKilledInstances = "other, r1";
        else e.Mode(AutomationRecipes.AutoMovie, AutomationMode.Auto, killed: true);
        await e.Outbox().TickAsync(default);
        Assert.Equal(0, e.R.Backend.Sends);
        Assert.Equal(AutomationHolds.Killed, e.R.Ledger.ForWant(movie.Id).Single().Reason);
        if (scope == "recipe")
        {
            // The other recipe still sends.
            var season = await e.Auto(e.R.Admin, IntegrationRequestLedgerTests.Seasons(2), AutomationRecipes.AutoSeason);
            e.R.Now += TimeSpan.FromSeconds(1);
            await e.Outbox().TickAsync(default);
            Assert.Equal("sent", e.R.Ledger.Find(season.WantId!)!.Status);
        }
    }

    private sealed class TwoWrites : IRequestBackend
    {
        public Action? Between { get; set; }
        public int Writes { get; private set; }
        public Task PrepareAsync(Guid user, MutationInput input, CancellationToken ct) => Task.CompletedTask;
        public RequestBackendBinding Binding(Guid user, MutationInput input) => new();
        public Task<RequestBackendResult> SendAsync(RequestJob job, Func<string?> finalGuard, CancellationToken ct)
        {
            if (finalGuard() is { } refusal) return Task.FromResult(RequestBackendResult.Hold(refusal));
            Writes++;
            Between?.Invoke();
            if (finalGuard() is { } late)
                return Task.FromResult(AutomationHolds.IsWait(late) ? BackendResults.Held(job.WantId, true, late, "held", AutomationHolds.WaitFor(late)) : BackendResults.HoldAfterWrite(job.WantId, late, "held"));
            Writes++;
            return Task.FromResult(new RequestBackendResult(RequestOutcome.Accepted(job.WantId, "looking", 200), Confirmed: true));
        }
        public Task<RequestBackendResult> ReadBackAsync(RequestJob job, CancellationToken ct) => Task.FromResult(RequestBackendResult.Resume(job.WantId));
    }

    [Fact]
    public async Task AKillBetweenTwoWritesStopsTheRestKeepsTheJobUncertainAndResumesWhenItIsOff()
    {
        using var e = new Engine();
        e.Mode(AutomationRecipes.AutoMovie, AutomationMode.Auto);
        var want = await Queued(e, e.R.Admin, 623);
        var backend = new TwoWrites { Between = () => e.C.ArrAutomationKillAll = true };
        await e.Outbox(backend).TickAsync(default);
        Assert.Equal(1, backend.Writes);
        var job = e.R.Ledger.ForWant(want.Id).Single();
        Assert.Equal(("retry", AutomationHolds.Killed, true), (job.State, job.Reason, job.Uncertain));
        // Uncertain: it can't be cancelled or refunded meanwhile.
        Assert.Equal(409, e.R.Service.Close(want.Id, e.R.Admin, null).HttpStatus);
        e.C.ArrAutomationKillAll = false;
        backend.Between = null;
        e.R.Now += TimeSpan.FromMinutes(6);
        await e.Outbox(backend).TickAsync(default);
        Assert.Equal(3, backend.Writes);
        Assert.Equal("sent", e.R.Ledger.Find(want.Id)!.Status);
    }

    [Fact]
    public async Task APersonWhoOptsOutAfterQueueingHasTheirUnsentAutomaticWorkHeldButAnUncertainSendIsStillReadBack()
    {
        using var e = new Engine();
        e.Mode(AutomationRecipes.AutoMovie, AutomationMode.Auto);
        var held = await Queued(e, e.R.Admin, 626);
        var own = await e.R.Create(e.R.Admin, Movie(627));
        // Held by a full budget (or a breaker) at first, then the person opts out of the recipe.
        e.Consent.Map[(e.R.Admin, AutomationRecipes.AutoMovie)] = false;
        await e.Outbox().TickAsync(default);
        Assert.Equal(1, e.R.Backend.Sends);   // their own ask only
        var job = e.R.Ledger.ForWant(held.Id).Single();
        Assert.Equal(("retry", AutomationHolds.UserOptedOut), (job.State, job.Reason));
        Assert.Equal("sent", e.R.Ledger.Find(own.RequestId!)!.Status);

        // Opted out between two writes: the rest waits.
        e.Consent.Map.Remove((e.R.Admin, AutomationRecipes.AutoMovie));
        var split = await Queued(e, e.R.Admin, 628);
        var backend = new TwoWrites { Between = () => e.Consent.Map[(e.R.Admin, AutomationRecipes.AutoMovie)] = false };
        e.R.Now += TimeSpan.FromMinutes(16);
        e.Consent.Map[(e.R.Admin, AutomationRecipes.AutoMovie)] = false;
        await e.Outbox(backend).TickAsync(default);
        Assert.Equal(0, backend.Writes);
        e.Consent.Map.Remove((e.R.Admin, AutomationRecipes.AutoMovie));
        e.R.Now += TimeSpan.FromMinutes(16);
        await e.Outbox(backend).TickAsync(default);
        Assert.Equal(1, backend.Writes);   // the first write of one job, then the opt-out stopped the rest
        Assert.Contains(new[] { held.Id, split.Id }.SelectMany(id => e.R.Ledger.ForWant(id)), j => j.Reason == AutomationHolds.UserOptedOut && j.Uncertain);

        // A send whose answer was lost is still read back while the person is opted out.
        e.Consent.Map.Remove((e.R.Admin, AutomationRecipes.AutoMovie));
        var lost = await Queued(e, e.R.Admin, 629);
        e.R.Backend.Unknown = true;
        e.R.Now += TimeSpan.FromMinutes(16);
        await e.Outbox().TickAsync(default);
        Assert.Equal("maybe_sent", e.R.Ledger.ForWant(lost.Id).Single().State);
        e.Consent.Map[(e.R.Admin, AutomationRecipes.AutoMovie)] = false;
        e.R.Backend.Unknown = false;
        var reads = e.R.Backend.Reads;
        e.R.Now += TimeSpan.FromMinutes(10);
        await e.Outbox().TickAsync(default);
        Assert.True(e.R.Backend.Reads > reads);
        Assert.Equal("succeeded", e.R.Ledger.ForWant(lost.Id).Single().State);

        // Opted back in: the held request goes out.
        e.Consent.Map.Remove((e.R.Admin, AutomationRecipes.AutoMovie));
        e.R.Now += TimeSpan.FromMinutes(16);
        await e.Outbox().TickAsync(default);
        Assert.Equal("sent", e.R.Ledger.Find(held.Id)!.Status);
    }

    // 4a-B-r3-1 / 4a-security-r3-1: an old recipe's own enable switch turned off after its request was queued holds its
    // unsent work, before any transport and between two writes, with the engine on or off, like an opt-out. People's own
    // asks and the other recipe's work still go; a send whose answer was lost is still read back; switched back on, it
    // goes out.
    [Theory]
    [InlineData(AutomationRecipes.AutoMovie, true)]
    [InlineData(AutomationRecipes.AutoMovie, false)]
    [InlineData(AutomationRecipes.AutoSeason, true)]
    [InlineData(AutomationRecipes.AutoSeason, false)]
    public async Task AnOldRecipesSwitchTurnedOffAfterQueueingHoldsItsUnsentWorkButAnUncertainSendIsStillReadBack(string recipe, bool engine)
    {
        using var e = new Engine(engine);
        if (engine)
        {
            e.Mode(AutomationRecipes.AutoMovie, AutomationMode.Auto);
            e.Mode(AutomationRecipes.AutoSeason, AutomationMode.Auto);
        }
        var held = await Queued(e, e.R.Admin, 640, recipe);
        var other = await Queued(e, e.R.Admin, 641, Other(recipe));
        var own = await e.R.Create(e.R.Admin, Movie(642));
        Switch(e.C, recipe, false);
        await e.Outbox().TickAsync(default);
        Assert.Equal(2, e.R.Backend.Sends);   // the other recipe's and the person's own ask
        Assert.Equal("sent", e.R.Ledger.Find(other.Id)!.Status);
        Assert.Equal("sent", e.R.Ledger.Find(own.RequestId!)!.Status);
        var job = e.R.Ledger.ForWant(held.Id).Single();
        Assert.Equal(("retry", AutomationHolds.RecipePaused), (job.State, job.Reason));
        Assert.Equal(e.R.Now + TimeSpan.FromMinutes(15), job.NextAttempt);
        e.R.Now += TimeSpan.FromMinutes(16);
        await e.Outbox().TickAsync(default);
        Assert.Equal(2, e.R.Backend.Sends);

        // Switched back on: it goes out.
        Switch(e.C, recipe, true);
        e.R.Now += TimeSpan.FromMinutes(16);
        await e.Outbox().TickAsync(default);
        Assert.Equal(3, e.R.Backend.Sends);
        Assert.Equal("sent", e.R.Ledger.Find(held.Id)!.Status);

        // Switched off between two writes: the rest waits, the job stays uncertain, and it resumes once it is on.
        var split = await Queued(e, e.R.Admin, 643, recipe);
        var backend = new TwoWrites { Between = () => Switch(e.C, recipe, false) };
        await e.Outbox(backend).TickAsync(default);
        Assert.Equal(1, backend.Writes);
        Assert.Equal(("retry", AutomationHolds.RecipePaused, true), e.R.Ledger.ForWant(split.Id).Single() is var stopped ? (stopped.State, stopped.Reason, stopped.Uncertain) : default);

        // A send whose answer was lost is still read back while the switch is off.
        Switch(e.C, recipe, true);
        var lost = await Queued(e, e.R.Admin, 644, recipe);
        e.R.Backend.Unknown = true;
        await e.Outbox().TickAsync(default);
        Assert.Equal("maybe_sent", e.R.Ledger.ForWant(lost.Id).Single().State);
        Switch(e.C, recipe, false);
        e.R.Backend.Unknown = false;
        var reads = e.R.Backend.Reads;
        var sends = e.R.Backend.Sends;
        e.R.Now += TimeSpan.FromMinutes(10);
        await e.Outbox().TickAsync(default);
        Assert.True(e.R.Backend.Reads > reads);
        Assert.Equal(sends, e.R.Backend.Sends);
        Assert.Equal("succeeded", e.R.Ledger.ForWant(lost.Id).Single().State);

        Switch(e.C, recipe, true);
        backend.Between = null;
        e.R.Now += TimeSpan.FromMinutes(16);
        await e.Outbox(backend).TickAsync(default);
        Assert.Equal(3, backend.Writes);
        Assert.Equal("sent", e.R.Ledger.Find(split.Id)!.Status);
    }

    [Fact]
    public async Task AReadBackOfAnUncertainSendRunsEvenWhileKilledOrShadowed()
    {
        using var e = new Engine();
        e.Mode(AutomationRecipes.AutoMovie, AutomationMode.Auto);
        var want = await Queued(e, e.R.Admin, 624);
        e.R.Backend.Unknown = true;
        await e.Outbox().TickAsync(default);
        Assert.Equal("maybe_sent", e.R.Ledger.ForWant(want.Id).Single().State);
        e.C.ArrAutomationKillAll = true;
        e.C.ArrAutomationShadowOverride = true;
        e.R.Backend.Unknown = false;
        var reads = e.R.Backend.Reads;
        e.R.Now += TimeSpan.FromMinutes(10);
        await e.Outbox().TickAsync(default);
        Assert.True(e.R.Backend.Reads > reads);
        Assert.Equal("succeeded", e.R.Ledger.ForWant(want.Id).Single().State);
        Assert.Equal(1, e.R.Backend.Sends);
    }

    [Fact]
    public async Task AModeChangedAfterQueueingHoldsShadowAndOffAndAsksForAnOkInAsk()
    {
        using var e = new Engine();
        e.Mode(AutomationRecipes.AutoMovie, AutomationMode.Auto);
        var shadowed = await Queued(e, e.R.Admin, 625);
        e.Mode(AutomationRecipes.AutoMovie, AutomationMode.Shadow);
        await e.Outbox().TickAsync(default);
        Assert.Equal(AutomationHolds.RecipePaused, e.R.Ledger.ForWant(shadowed.Id).Single().Reason);
        e.Mode(AutomationRecipes.AutoMovie, AutomationMode.Ask);
        e.R.Now += TimeSpan.FromMinutes(16);
        await e.Outbox().TickAsync(default);
        Assert.Equal(0, e.R.Backend.Sends);
        Assert.Equal(("pending", AutomationHolds.ApprovalRequired), (e.R.Ledger.Find(shadowed.Id)!.Status, e.R.Ledger.Find(shadowed.Id)!.Reason));
        Assert.Equal("parked", e.R.Ledger.ForWant(shadowed.Id).Single().State);
        Assert.Equal(200, (await e.R.Service.ApproveAsync(shadowed.Id, e.R.Admin, null, default)).HttpStatus);
        await e.Outbox().TickAsync(default);
        Assert.Equal(1, e.R.Backend.Sends);
    }

    [Fact]
    public async Task WorkOnlyPhase4CreatesWaitsWhilePhase4IsOffAndDeliberateListAsksIgnoreKills()
    {
        using var e = new Engine();
        e.Mode(AutomationRecipes.ListSyncRequests, AutomationMode.Auto);
        var sync = e.R.Ledger.Create(e.R.Admin, new CreateRequest("s1", Movie(630)), e.R.Policy, e.R.Now, RequestOrigin.Sync("L1", new RequestProvenance(SourceKind: "mdblist", SourceGeneration: "g7")));
        var list = e.R.Ledger.Create(e.R.Admin, new CreateRequest("l1", Movie(631)), e.R.Policy, e.R.Now, RequestOrigin.List("L1", new RequestProvenance(EntryId: "E1")));
        e.C.ArrPhase4Enabled = false;
        await e.Outbox().TickAsync(default);
        Assert.Equal(0, e.R.Backend.Sends);
        Assert.All(new[] { sync.RequestId!, list.RequestId! }, id => Assert.Equal(AutomationHolds.Phase4Off, e.R.Ledger.ForWant(id).Single().Reason));

        // Phase 4 back on: the deliberate list ask goes even with every kill on; the sync ask waits for the kill.
        e.C.ArrPhase4Enabled = true;
        e.C.ArrAutomationKillAll = true;
        e.R.Now += TimeSpan.FromMinutes(16);
        await e.Outbox().TickAsync(default);
        Assert.Equal("sent", e.R.Ledger.Find(list.RequestId!)!.Status);
        Assert.Equal(AutomationHolds.Killed, e.R.Ledger.ForWant(sync.RequestId!).Single().Reason);
        e.C.ArrAutomationKillAll = false;
        e.R.Now += TimeSpan.FromMinutes(6);
        await e.Outbox().TickAsync(default);
        Assert.Equal("sent", e.R.Ledger.Find(sync.RequestId!)!.Status);
    }

    [Fact]
    public async Task APersonRemovedOrDemotedAfterQueueingIsHeldAtSend()
    {
        using var e = new Engine();
        e.Mode(AutomationRecipes.AutoMovie, AutomationMode.Auto);
        var manager = e.R.Add("Manager");
        e.Grant(manager);
        var want = await Queued(e, manager, 632);
        e.R.Policy.People[manager] = e.R.Policy.People[manager] with { Role = "Watcher", CanCreate = false };
        await e.Outbox().TickAsync(default);
        Assert.Equal(0, e.R.Backend.Sends);
        Assert.Equal("parked", e.R.Ledger.ForWant(want.Id).Single().State);
    }

    [Fact]
    public async Task TheShadowOverrideHoldsQueuedLegacyAndNewWorkAcrossMigrationAndEveryUmbrellaSwitch()
    {
        using var e = new Engine(engine: false);
        // The existing recipe queued a Manager's ask before phase 4 (engine off: as before).
        var legacy = await Queued(e, e.R.Manager, 640);
        e.C.ArrAutomationShadowOverride = true;
        foreach (var (phase4, engine) in new[] { (false, false), (true, false), (true, true), (false, true), (false, false) })
        {
            e.C.ArrPhase4Enabled = phase4;
            e.C.ArrPhase4AutomationEnabled = engine;
            e.Mode(AutomationRecipes.AutoMovie, AutomationMode.Auto);
            e.R.Now += TimeSpan.FromMinutes(16);
            await e.Outbox().TickAsync(default);
            Assert.Equal(0, e.R.Backend.Sends);
            Assert.Equal(AutomationHolds.ShadowOverride, e.R.Ledger.ForWant(legacy.Id).Single().Reason);
            // A new automatic ask is a Shadow decision only, whatever the switches say.
            var before = e.Count("SELECT COUNT(*) FROM wants");
            var outcome = await e.Auto(e.R.Admin, Movie(641));
            Assert.StartsWith("shadow_", outcome.Reason);
            Assert.Equal(before, e.Count("SELECT COUNT(*) FROM wants"));
        }

        // The one-time migration runs with the override on and leaves it on.
        e.C.AutoMovieRequestEnabled = true;
        AutomationMigration.Run(e.C, e.Store, fresh: false, () => new[] { e.R.Manager }, e.R.Now, () => { });
        Assert.True(e.C.ArrAutomationShadowOverride);
        await e.Outbox().TickAsync(default);
        Assert.Equal(0, e.R.Backend.Sends);

        // Off again: the held ask goes as it was (the engine is off: the existing behaviour).
        e.C.ArrAutomationShadowOverride = false;
        e.R.Now += TimeSpan.FromMinutes(16);
        await e.Outbox().TickAsync(default);
        Assert.Equal(1, e.R.Backend.Sends);
        Assert.Contains(e.Store.Decisions(), d => d.Detail != null && JsonDocument.Parse(d.Detail).RootElement.TryGetProperty("override", out var o) && o.GetBoolean());
    }

    // ------------------------------------------------------------------ budgets

    private static AutomationBudgets BudgetsOn(AcquireDatabase db, PluginConfiguration config, Func<DateTimeOffset> now) => new(db, () => config, now);

    [Fact]
    public async Task TwoWorkersCompetingForTheLastSlotsAdmitExactlyTheLimit()
    {
        using var e = new Engine();
        e.C.ArrAutomationHouseholdAddsPerDay = 5;
        // Two workers: two database handles on the same file (separate writer gates; SQLite serializes them).
        using var second = new AcquireDatabase(e.R.Db.FilePath);
        Assert.True(second.Available);
        var one = BudgetsOn(e.R.Db, e.C, () => e.R.Now);
        var two = BudgetsOn(second, e.C, () => e.R.Now);
        var tasks = Enumerable.Range(0, 40).Select(i => Task.Run(() => (i % 2 == 0 ? one : two).Admit(BudgetCategories.HouseholdAdd, BudgetCategories.Household, "job:" + i))).ToArray();
        var results = await Task.WhenAll(tasks);
        Assert.Equal(5, results.Count(r => r.Admitted));
        Assert.All(results.Where(r => !r.Admitted), r => Assert.Equal("budget_exhausted", r.Reason));
        Assert.Equal(5, e.Count("SELECT COUNT(*) FROM automation_budget"));
    }

    [Fact]
    public void WindowsRollAtTheHourAndTheDayAndAStampFromTheFutureStillCounts()
    {
        using var e = new Engine();
        e.C.ArrAutomationSearchesPerHour = 2;
        e.C.ArrAutomationSearchesPerDay = 3;
        var start = e.R.Now;
        var b = BudgetsOn(e.R.Db, e.C, () => e.R.Now);
        Assert.True(b.Admit(BudgetCategories.Search, "r1", "a").Admitted);
        e.R.Now = start + TimeSpan.FromMinutes(10);
        Assert.True(b.Admit(BudgetCategories.Search, "r1", "b").Admitted);
        e.R.Now = start + TimeSpan.FromMinutes(59) + TimeSpan.FromSeconds(59);
        var full = b.Admit(BudgetCategories.Search, "r1", "c");
        Assert.Equal(("budget_exhausted", start + TimeSpan.FromHours(1)), (full.Reason, full.RetryAt));
        Assert.Equal(start + TimeSpan.FromHours(1), b.Exhausted(BudgetCategories.Search, "r1")!.NextSlotAt);
        e.R.Now = start + TimeSpan.FromHours(1);
        Assert.True(b.Admit(BudgetCategories.Search, "r1", "c").Admitted);   // the first left the hour (strictly older than an hour)
        e.R.Now = start + TimeSpan.FromMinutes(75);
        var day = b.Admit(BudgetCategories.Search, "r1", "d");
        Assert.Equal(("budget_exhausted", start + TimeSpan.FromDays(1)), (day.Reason, day.RetryAt));
        var usage = b.Usage(BudgetCategories.Search, "r1");
        Assert.Equal((1, 3), (usage[0].Used, usage[1].Used));
        // The clock moves back two hours: what was admitted "later" still counts (a skewed clock never frees slots).
        e.R.Now = start - TimeSpan.FromHours(2);
        Assert.Equal(3, b.Usage(BudgetCategories.Search, "r1")[1].Used);
        Assert.False(b.Admit(BudgetCategories.Search, "r1", "e").Admitted);
        // Each instance has its own windows.
        Assert.True(b.Admit(BudgetCategories.Search, "r2", "a").Admitted);
    }

    [Fact]
    public void AUniqueActionCountsOnceAndAnUncertainOneKeepsCountingAcrossRestartAndRestoreUntilAReadBackSettlesIt()
    {
        using var e = new Engine();
        var b = BudgetsOn(e.R.Db, e.C, () => e.R.Now);
        var first = b.Admit(BudgetCategories.HouseholdAdd, BudgetCategories.Household, "job:j1", "j1", "auto_movie");
        var replay = b.Admit(BudgetCategories.HouseholdAdd, BudgetCategories.Household, "job:j1", "j1", "auto_movie");
        Assert.Equal((first.Id, true), (replay.Id, replay.Replayed));
        b.Settle(first.Id!, BudgetOutcome.MaybeSent);
        var snapshot = e.R.Db.Snapshot()!;
        e.Reopen();
        b = BudgetsOn(e.R.Db, e.C, () => e.R.Now);
        var usage = b.Usage(BudgetCategories.HouseholdAdd, BudgetCategories.Household).Single();
        Assert.Equal((1, 1), (usage.Used, usage.Uncertain));
        // A later definite answer settles it as sent (still counted, no longer uncertain).
        b.Settle(first.Id!, BudgetOutcome.Sent);
        Assert.Equal(0, b.Usage(BudgetCategories.HouseholdAdd, BudgetCategories.Household).Single().Uncertain);
        // Restore the backup taken while it was uncertain: uncertain and counted again.
        e.R.Db.ReplaceWith(snapshot);
        Assert.Equal((1, 1), (b.Usage(BudgetCategories.HouseholdAdd, BudgetCategories.Household).Single().Used, b.Usage(BudgetCategories.HouseholdAdd, BudgetCategories.Household).Single().Uncertain));
        Assert.Equal(1, b.SettleJob("j1", confirmed: false, notThere: true));
        Assert.Equal(0, b.Usage(BudgetCategories.HouseholdAdd, BudgetCategories.Household).Single().Used);
        // A released action may be admitted again (it counts again then).
        Assert.False(b.Admit(BudgetCategories.HouseholdAdd, BudgetCategories.Household, "job:j1", "j1").Replayed);
        Assert.Equal(1, b.Usage(BudgetCategories.HouseholdAdd, BudgetCategories.Household).Single().Used);
    }

    [Fact]
    public void BackfillIsReservedZeroAdmitsNothingAndUnavailableAccountingFailsClosed()
    {
        using var e = new Engine();
        var b = BudgetsOn(e.R.Db, e.C, () => e.R.Now);
        Assert.Equal("not_implemented", b.Admit(BudgetCategories.Backfill, "r1", "x").Reason);
        e.C.ArrAutomationSeerrPostsPerDay = 0;
        Assert.Equal("budget_exhausted", b.Admit(BudgetCategories.SeerrPost, AutomationFlags.SeerrTarget, "x").Reason);
        Assert.Equal("invalid_budget", b.Admit("nope", "r1", "x").Reason);

        var folder = Path.Combine(e.R.Root, "not-a-database");
        Directory.CreateDirectory(folder);
        using var broken = new AcquireDatabase(folder);
        Assert.False(broken.Available);
        var down = BudgetsOn(broken, e.C, () => e.R.Now);
        Assert.Equal("accounting_unavailable", down.Admit(BudgetCategories.HouseholdAdd, BudgetCategories.Household, "x").Reason);
        Assert.True(down.Usage(BudgetCategories.HouseholdAdd, BudgetCategories.Household).Single().Full);
    }

    [Fact]
    public async Task AFullSearchBudgetHoldsQueuedAutomaticWorkUntilItHasRoom()
    {
        using var e = new Engine();
        e.Mode(AutomationRecipes.AutoMovie, AutomationMode.Auto);
        e.C.ArrAutomationSearchesPerHour = 1;
        var b = BudgetsOn(e.R.Db, e.C, () => e.R.Now);
        Assert.True(b.Admit(BudgetCategories.Search, "r1", "earlier").Admitted);
        var want = await Queued(e, e.R.Admin, 650);
        await e.Outbox().TickAsync(default);
        Assert.Equal(0, e.R.Backend.Sends);
        var job = e.R.Ledger.ForWant(want.Id).Single();
        Assert.Equal((AutomationHolds.BudgetExhausted, "retry"), (job.Reason, job.State));
        Assert.Equal(e.R.Now + TimeSpan.FromHours(1) + TimeSpan.FromSeconds(1), job.NextAttempt);
        e.R.Now += TimeSpan.FromHours(1) + TimeSpan.FromSeconds(2);
        await e.Outbox().TickAsync(default);
        Assert.Equal(1, e.R.Backend.Sends);
    }

    [Fact]
    public async Task TheEngineTurnedOnWhileASendIsUnderWayStartsItAgainUnderTheBudgetsInsteadOfSendingUncounted()
    {
        using var e = new Engine(engine: false);
        e.Mode(AutomationRecipes.AutoMovie, AutomationMode.Auto);
        e.C.ArrAutomationSearchesPerHour = 1;
        // Queued by the existing recipe with the engine off: its send starts without a budget admission.
        var want = await Queued(e, e.R.Admin, 655);
        Assert.True(BudgetsOn(e.R.Db, e.C, () => e.R.Now).Admit(BudgetCategories.Search, "r1", "earlier").Admitted);

        // The engine is turned on (Auto, the search budget used up) while the send's prerequisites are being read.
        e.R.Policy.Before = (_, _) => { e.C.ArrPhase4Enabled = true; e.C.ArrPhase4AutomationEnabled = true; return Task.CompletedTask; };
        await e.Outbox().TickAsync(default);
        Assert.Equal(0, e.R.Backend.Sends);
        var job = e.R.Ledger.ForWant(want.Id).Single();
        Assert.Equal(("retry", AutomationHolds.EngineChanged), (job.State, job.Reason));

        // The next attempt starts over under the engine: held by the full budget, sent once there is room.
        e.R.Now = job.NextAttempt;
        await e.Outbox().TickAsync(default);
        Assert.Equal(0, e.R.Backend.Sends);
        Assert.Equal(AutomationHolds.BudgetExhausted, e.R.Ledger.ForWant(want.Id).Single().Reason);
        e.R.Now += TimeSpan.FromHours(1) + TimeSpan.FromSeconds(2);
        await e.Outbox().TickAsync(default);
        Assert.Equal(1, e.R.Backend.Sends);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task TheEngineSwitchedBetweenTwoWritesStopsTheRestUntilTheAttemptStartsAgain(bool on)
    {
        using var e = new Engine(engine: !on);
        e.Mode(AutomationRecipes.AutoMovie, AutomationMode.Auto);
        var want = await Queued(e, e.R.Admin, 656);
        var backend = new TwoWrites { Between = () => { e.C.ArrPhase4Enabled = on; e.C.ArrPhase4AutomationEnabled = on; } };
        await e.Outbox(backend).TickAsync(default);
        Assert.Equal(1, backend.Writes);
        var job = e.R.Ledger.ForWant(want.Id).Single();
        Assert.Equal(("retry", AutomationHolds.EngineChanged, true), (job.State, job.Reason, job.Uncertain));
        backend.Between = null;
        e.R.Now = job.NextAttempt;
        await e.Outbox(backend).TickAsync(default);
        Assert.Equal(3, backend.Writes);
        Assert.Equal("sent", e.R.Ledger.Find(want.Id)!.Status);
    }

    private sealed class Failing : IRequestBackend
    {
        public int Sends { get; set; }
        public bool Fail { get; set; } = true;
        public Task PrepareAsync(Guid user, MutationInput input, CancellationToken ct) => Task.CompletedTask;
        public RequestBackendBinding Binding(Guid user, MutationInput input) => new();
        public Task<RequestBackendResult> SendAsync(RequestJob job, Func<string?> finalGuard, CancellationToken ct)
        {
            if (finalGuard() is { } refusal) return Task.FromResult(RequestBackendResult.Hold(refusal));
            Sends++;
            return Task.FromResult(Fail ? BackendResults.Retry("backend_unavailable", "down") : new RequestBackendResult(RequestOutcome.Accepted(job.WantId, "looking", 200), Confirmed: true));
        }
        public Task<RequestBackendResult> ReadBackAsync(RequestJob job, CancellationToken ct) => Task.FromResult(RequestBackendResult.Uncertain(job.WantId));
    }

    [Fact]
    public async Task FiveFailuresInARowOpenTheTargetsBreakerAndASuccessOrAnAdministratorClosesIt()
    {
        using var e = new Engine();
        e.Mode(AutomationRecipes.AutoMovie, AutomationMode.Auto);
        var want = await Queued(e, e.R.Admin, 660);
        var backend = new Failing();
        for (var i = 0; i < AutomationStore.BreakerThreshold; i++)
        {
            await e.Outbox(backend).TickAsync(default);
            e.R.Now += TimeSpan.FromMinutes(10);
        }
        Assert.Equal(AutomationStore.BreakerThreshold, backend.Sends);
        Assert.True(e.Store.Breaker("r1").Open(e.R.Now));
        await e.Outbox(backend).TickAsync(default);
        Assert.Equal(AutomationStore.BreakerThreshold, backend.Sends);
        Assert.Equal(AutomationHolds.BreakerOpen, e.R.Ledger.ForWant(want.Id).Single().Reason);
        // People's own asks are never held by it.
        var own = await e.R.Create(e.R.Member, Movie(661));
        await e.Outbox(backend).TickAsync(default);
        Assert.Equal(AutomationStore.BreakerThreshold + 1, backend.Sends);

        // "Try again now" closes the breaker and checks the held request again at once (no wait for its old retry time).
        Assert.True(e.Store.Reset("r1", e.R.Now));
        Assert.Equal(e.R.Now, e.R.Ledger.ForWant(want.Id).Single().NextAttempt);
        backend.Fail = false;
        await e.Outbox(backend).TickAsync(default);
        Assert.Equal("sent", e.R.Ledger.Find(want.Id)!.Status);
        Assert.Equal(0, e.Store.Breaker("r1").Failures);
        Assert.NotNull(own.RequestId);
    }

    // ------------------------------------------------------------------ Direct and Seerr admission

    private static (AutomationSendGuard Guard, AutomationBudgets Budgets, IntegrationRequestLedgerTests.Policy Policy, AcquireDatabase Db) Admission(string root)
    {
        var policy = new IntegrationRequestLedgerTests.Policy();
        policy.Configuration.ArrPhase4Enabled = true;
        policy.Configuration.ArrPhase4AutomationEnabled = true;
        Directory.CreateDirectory(root);
        var db = new AcquireDatabase(Path.Combine(root, "budget.db"));
        var budgets = new AutomationBudgets(db, () => policy.Configuration, () => DateTimeOffset.UtcNow);
        var store = new AutomationStore(db);
        return (new AutomationSendGuard(policy, budgets, store, new AutomationEligibility(store, new NoAutomationTrust()), new Consents()), budgets, policy, db);
    }

    private static RequestWant AutomaticWant(RequestJob job) => new(job.WantId, "a", job.Authorization.Requester, "c", "f", job.Input, "queued", "queued_outage", 1, "null",
        DateTimeOffset.UtcNow, DateTimeOffset.UtcNow, OriginKind: "automation", OriginSource: AutomationRecipes.AutoMovie);

    [Fact]
    public async Task ADirectSendCountsTheAddAndTheSearchItStartsAndTheNextAddWaitsAtTheCap()
    {
        using var lab = new IntegrationRequestBackendsTests.Lab();
        var root = Path.Combine(Path.GetTempPath(), "je-4a-direct-" + Guid.NewGuid().ToString("N"));
        var (guard, budgets, policy, db) = Admission(root);
        using (db)
        {
            policy.Configuration.ArrAutomationHouseholdAddsPerDay = 1;
            lab.Radarr.Lookup.Add(IntegrationRequestBackendsTests.Lab.MovieLookup(961));
            lab.Radarr.Lookup.Add(IntegrationRequestBackendsTests.Lab.MovieLookup(962, "Sherlock Jr."));
            var job = lab.Job(Movie(961), "Radarr");
            var sent = await lab.Direct.SendAsync(job, () => null, guard.Admission(job, AutomaticWant(job)), default);
            Assert.True(sent.Confirmed, sent.Outcome.Message);
            var radarr = lab.Instance("Radarr").Id;
            Assert.Equal(1, budgets.Usage(BudgetCategories.HouseholdAdd, BudgetCategories.Household).Single().Used);
            Assert.Equal(1, budgets.Usage(BudgetCategories.Search, radarr)[0].Used);

            var next = lab.Job(Movie(962), "Radarr");
            var held = await lab.Direct.SendAsync(next, () => null, guard.Admission(next, AutomaticWant(next)), default);
            Assert.Equal((AutomationHolds.BudgetExhausted, true), (held.Outcome.Reason, held.Retryable));
            Assert.True(held.VerifiedNotSent);
            Assert.Single(lab.Radarr.Writes, w => w.Method == "POST" && w.Path == "/api/v3/movie");
            // The search budget it would also have used wasn't taken.
            Assert.Equal(1, budgets.Usage(BudgetCategories.Search, radarr)[0].Used);

            // An interactive send (no admission) is never counted.
            var own = lab.Job(Movie(962), "Radarr");
            Assert.True((await lab.Direct.SendAsync(own, () => null, default)).Confirmed);
            Assert.Equal(1, budgets.Usage(BudgetCategories.HouseholdAdd, BudgetCategories.Household).Single().Used);
        }
        Directory.Delete(root, true);
    }

    [Fact]
    public async Task AMovieAlreadyThereNeedsNoAddAndItsSearchIsCounted()
    {
        using var lab = new IntegrationRequestBackendsTests.Lab();
        var root = Path.Combine(Path.GetTempPath(), "je-4a-merge-" + Guid.NewGuid().ToString("N"));
        var (guard, budgets, _, db) = Admission(root);
        using (db)
        {
            lab.Radarr.Movies.Add(FakeArr.Movie(41, 961, "The General", hasFile: false));
            var job = lab.Job(Movie(961), "Radarr");
            var sent = await lab.Direct.SendAsync(job, () => null, guard.Admission(job, AutomaticWant(job)), default);
            Assert.True(sent.Confirmed, sent.Outcome.Message);
            Assert.Equal(0, budgets.Usage(BudgetCategories.HouseholdAdd, BudgetCategories.Household).Single().Used);
            Assert.Equal(1, budgets.Usage(BudgetCategories.Search, lab.Instance("Radarr").Id)[0].Used);
        }
        Directory.Delete(root, true);
    }

    [Fact]
    public async Task ALostAddAnswerStaysCountedUntilTheReadBackSettlesIt()
    {
        using var lab = new IntegrationRequestBackendsTests.Lab();
        var root = Path.Combine(Path.GetTempPath(), "je-4a-lost-" + Guid.NewGuid().ToString("N"));
        var (guard, budgets, _, db) = Admission(root);
        using (db)
        {
            lab.Radarr.Lookup.Add(IntegrationRequestBackendsTests.Lab.MovieLookup(961));
            lab.Radarr.OnWrite = (method, path, _) => method == "POST" && path == "/api/v3/movie" ? IntegrationTransport.Response("{\"message\":\"bad gateway\"}", 502) : null;
            var job = lab.Job(Movie(961), "Radarr");
            var lost = await lab.Direct.SendAsync(job, () => null, guard.Admission(job, AutomaticWant(job)), default);
            Assert.Equal(Jellyfin.Plugin.JellyfinEnhanced.Services.Arr.ArrActionStatus.Unknown, ArrActionStatusOf(lost));
            var usage = budgets.Usage(BudgetCategories.HouseholdAdd, BudgetCategories.Household).Single();
            Assert.Equal((1, 1), (usage.Used, usage.Uncertain));
            // The read-back finds nothing there: released.
            guard.Observe(job, AutomaticWant(job), BackendResults.NotThere("not there"), transportStarted: false, settledByRead: true);
            Assert.Equal(0, budgets.Usage(BudgetCategories.HouseholdAdd, BudgetCategories.Household).Single().Used);
        }
        Directory.Delete(root, true);
    }

    private static Jellyfin.Plugin.JellyfinEnhanced.Services.Arr.ArrActionStatus ArrActionStatusOf(RequestBackendResult result) => result.Outcome.Certainty;

    [Fact]
    public async Task SeerrModeCountsJellyfinEnhancedsPostsOnlyAndHoldsTheNextOneAtTheCap()
    {
        using var lab = new IntegrationRequestBackendsTests.SeerrLab();
        var root = Path.Combine(Path.GetTempPath(), "je-4a-seerr-" + Guid.NewGuid().ToString("N"));
        var (guard, budgets, policy, db) = Admission(root);
        using (db)
        {
            policy.Configuration.ArrAutomationSeerrPostsPerDay = 1;
            await lab.Backend.PrepareAsync(lab.User, Movie(22596), default);
            var job = lab.Job(Movie(22596));
            var sent = await lab.Backend.SendAsync(job, () => null, guard.Admission(job, AutomaticWant(job)), default);
            Assert.True(sent.Confirmed, sent.Outcome.Message);
            Assert.Equal(1, budgets.Usage(BudgetCategories.SeerrPost, AutomationFlags.SeerrTarget).Single().Used);
            var next = lab.Job(Movie(22597));
            var held = await lab.Backend.SendAsync(next, () => null, guard.Admission(next, AutomaticWant(next)), default);
            Assert.Equal(AutomationHolds.BudgetExhausted, held.Outcome.Reason);
            Assert.Single(lab.Seerr.Posts);
            // Seerr handling counts no Sonarr/Radarr budget at all.
            Assert.Equal(0, budgets.Usage(BudgetCategories.HouseholdAdd, BudgetCategories.Household).Single().Used);
            Assert.Contains("kill_after_handoff", AutomationContract.For("seerr").NotGuaranteed);
            Assert.Contains(AutomationRecipes.ReleaseDay, AutomationContract.For("seerr").UnavailableRecipes);
            Assert.Empty(AutomationContract.For("je").NotGuaranteed);
        }
        Directory.Delete(root, true);
    }

    // ------------------------------------------------------------------ migration

    [Fact]
    public void AFreshInstallStoresShadowAndRecordsNoGrant()
    {
        using var e = new Engine();
        var saves = 0;
        var record = AutomationMigration.Run(e.C, e.Store, fresh: true, () => new[] { e.R.Manager }, e.R.Now, () => saves++);
        Assert.Equal(("fresh", 0, 1), (record!.Kind, record.Grants, saves));
        Assert.All(AutomationRecipes.All, r => Assert.Equal(AutomationMode.Shadow, AutomationModes.Mode(e.C, r)));
        Assert.Empty(e.Store.Grants());
        Assert.Equal("none", e.Store.Meta(AutomationMigration.NoticeKey));
    }

    [Theory]
    [InlineData(true, false)]
    [InlineData(false, true)]
    [InlineData(false, false)]
    public void AnUpgradeMapsOnToAutoAndOffToOffAndGrantsManagersOnlyWhenSomethingWasOn(bool season, bool movie)
    {
        using var e = new Engine();
        e.C.AutoSeasonRequestEnabled = season;
        e.C.AutoMovieRequestEnabled = movie;
        var record = AutomationMigration.Run(e.C, e.Store, fresh: false, () => new[] { e.R.Manager }, e.R.Now, () => { });
        Assert.Equal("upgrade", record!.Kind);
        Assert.Equal(season ? AutomationMode.Auto : AutomationMode.Off, AutomationModes.Mode(e.C, AutomationRecipes.AutoSeason));
        Assert.Equal(movie ? AutomationMode.Auto : AutomationMode.Off, AutomationModes.Mode(e.C, AutomationRecipes.AutoMovie));
        Assert.Equal(AutomationMode.Shadow, AutomationModes.Mode(e.C, AutomationRecipes.KeepUp));
        Assert.Equal(season || movie ? 1 : 0, e.Store.Grants().Count);
        Assert.Equal(season || movie ? "pending" : "none", e.Store.Meta(AutomationMigration.NoticeKey));
    }

    [Fact]
    public void TheMigrationRunsOnceAndARestoredHalfIsRepairedNeverRerun()
    {
        using var e = new Engine();
        e.C.AutoMovieRequestEnabled = true;
        Assert.NotNull(AutomationMigration.Run(e.C, e.Store, false, () => new[] { e.R.Manager }, e.R.Now, () => { }));
        var recipes = e.C.ArrAutomationRecipes;
        // Later switches never rerun it.
        e.C.AutoMovieRequestEnabled = false;
        e.C.AutoSeasonRequestEnabled = true;
        Assert.Null(AutomationMigration.Run(e.C, e.Store, false, () => new[] { e.R.Manager, e.R.Member }, e.R.Now, () => { }));
        Assert.Equal(recipes, e.C.ArrAutomationRecipes);
        Assert.Single(e.Store.Grants());

        // A configuration restored from before phase 4 (no record): repaired from acquire.db, not rerun.
        var saved = 0;
        e.C.ArrAutomationMigration = string.Empty;
        e.C.ArrAutomationRecipes = string.Empty;
        Assert.Null(AutomationMigration.Run(e.C, e.Store, false, () => new[] { e.R.Member }, e.R.Now, () => saved++));
        Assert.Equal((recipes, 1), (e.C.ArrAutomationRecipes, saved));
        Assert.Single(e.Store.Grants());

        // An acquire.db restored from before phase 4: its record comes back from the configuration; no new grant.
        e.R.Db.Write((c, t) => RequestLedger.Exec(c, t, "DELETE FROM meta WHERE key LIKE 'automation_%'; DELETE FROM automation_grants"));
        Assert.Null(AutomationMigration.Run(e.C, e.Store, false, () => new[] { e.R.Member }, e.R.Now, () => { }));
        Assert.NotNull(e.Store.Meta(AutomationMigration.MetaKey));
        Assert.Empty(e.Store.Grants());
    }

    [Fact]
    public void WithoutTheDatabaseTheMigrationWaitsWhenGrantsAreDue()
    {
        using var e = new Engine();
        var folder = Path.Combine(e.R.Root, "nodb");
        Directory.CreateDirectory(folder);
        using var broken = new AcquireDatabase(folder);
        var store = new AutomationStore(broken);
        e.C.AutoMovieRequestEnabled = false;   // only the season recipe was on
        e.C.AutoSeasonRequestEnabled = true;
        Assert.Null(AutomationMigration.Run(e.C, store, false, () => new[] { e.R.Manager }, e.R.Now, () => { }));
        Assert.Equal(string.Empty, e.C.ArrAutomationMigration);
        Assert.Equal(AutomationMode.Shadow, AutomationModes.Mode(e.C, AutomationRecipes.AutoSeason));   // not Auto until it ran
        e.C.AutoSeasonRequestEnabled = false;
        Assert.NotNull(AutomationMigration.Run(e.C, store, false, () => new[] { e.R.Manager }, e.R.Now, () => { }));
    }

    [Fact]
    public void ManagersAreThePeopleWhoseHouseholdRoleIsManagerNeverAdministrators()
    {
        var a = Guid.NewGuid(); var b = Guid.NewGuid(); var admin = Guid.NewGuid(); var kid = Guid.NewGuid();
        var config = new PluginConfiguration { ArrRequestDefaultRole = "Member", ArrRequestUsers = JsonSerializer.Serialize(new Dictionary<string, object> { [a.ToString("N")] = new { role = "Manager" }, [admin.ToString("N")] = new { role = "Manager" }, [kid.ToString("N")] = new { role = "Kid" } }) };
        Assert.Equal(new[] { a }, AutomationMigration.Managers(config, new[] { (a, false), (b, false), (admin, true), (kid, false) }));
        config.ArrRequestDefaultRole = "Manager";
        Assert.Equal(new[] { a, b }, AutomationMigration.Managers(config, new[] { (a, false), (b, false), (admin, true), (kid, false) }));
    }

    [Fact]
    public async Task OldRecipesOnThroughUpgradeEngineOnAndPhase4OffKeepAdminAndMigratedManagerSendingAndMemberAsking()
    {
        using var e = new Engine(engine: false);
        e.C.AutoMovieRequestEnabled = true;
        AutomationMigration.Run(e.C, e.Store, fresh: false, () => new[] { e.R.Manager }, e.R.Now, () => { });
        var laterManager = e.R.Add("Manager");
        var id = 800;
        async Task<string> Ask(Guid user) => e.R.Ledger.Find((await e.Auto(user, Movie(id++))).WantId!)!.Status;

        // Engine on (Auto from the migration).
        e.C.ArrPhase4Enabled = true;
        e.C.ArrPhase4AutomationEnabled = true;
        Assert.Equal(("queued", "queued", "pending", "pending"), (await Ask(e.R.Admin), await Ask(e.R.Manager), await Ask(e.R.Member), await Ask(laterManager)));
        // Phase 4 off: the existing behaviour (Managers and Admins straight through, Members wait).
        e.C.ArrPhase4Enabled = false;
        Assert.Equal(("queued", "queued", "pending"), (await Ask(e.R.Admin), await Ask(e.R.Manager), await Ask(e.R.Member)));
        // Grants and the notice are recorded once; nobody's preference was set (null follows the administrator).
        Assert.Equal(e.R.Manager.ToString("N"), Assert.Single(e.Store.Grants()).UserId);
        Assert.Equal("pending", e.Store.Meta(AutomationMigration.NoticeKey));
        Assert.Null(e.Consent.Preference(e.R.Manager, AutomationRecipes.AutoMovie));
        Assert.Null(AutomationMigration.Run(e.C, e.Store, false, () => new[] { e.R.Manager, laterManager }, e.R.Now, () => { }));
        Assert.Single(e.Store.Grants());
        await e.Outbox().TickAsync(default);
        Assert.Equal(4, e.R.Backend.Sends);
    }

    // ------------------------------------------------------------------ status route

    private static (ArrAdminAutomationController Controller, AutomationStatusService Status) Route(Engine e, bool admin, IntegrationRequestBackendsTests.Lab lab)
    {
        var status = new AutomationStatusService(e.Store, e.Budgets, lab.Store, new IntegrationRequestHouseholdTests.FakeDirectory(), () => e.C, () => e.R.Now);
        var controller = new ArrAdminAutomationController(status, e.R.View) { ControllerContext = new() { HttpContext = new DefaultHttpContext() } };
        controller.HttpContext.User = TestCallers.Principal(admin ? e.R.Admin : e.R.Member, admin);
        return (controller, status);
    }

    [Fact]
    public void TheStatusRouteIsForAdministratorsOnlyAndShowsModesBudgetsKillsTheContractAndTheNotice()
    {
        using var lab = new IntegrationRequestBackendsTests.Lab();
        using var e = new Engine();
        var (member, _) = Route(e, false, lab);
        Assert.Equal(403, Assert.IsType<ObjectResult>(member.Status()).StatusCode);
        Assert.Equal(403, Assert.IsType<ObjectResult>(member.ResetBreaker(new AutomationBreakerResetRequest { Target = "r1" })).StatusCode);
        var (admin, status) = Route(e, true, lab);
        e.C.ArrIntegrationEnabled = false;
        Assert.Equal(403, Assert.IsType<ObjectResult>(admin.Status()).StatusCode);
        e.C.ArrIntegrationEnabled = true;

        e.C.AutoMovieRequestEnabled = true;
        AutomationMigration.Run(e.C, e.Store, false, () => new[] { e.R.Manager }, e.R.Now, () => { });
        e.C.ArrAutomationKilledInstances = AutomationFlags.SeerrTarget;
        e.C.ArrAutomationSearchesPerHour = 1;
        var radarr = lab.Instance("Radarr").Id;
        e.Budgets.Admit(BudgetCategories.Search, radarr, "x");
        var body = Assert.IsType<AutomationStatusBody>(Assert.IsType<OkObjectResult>(admin.Status()).Value);
        Assert.True(body.Engine.Effective);
        Assert.Equal("auto", body.Recipes.Single(r => r.Id == AutomationRecipes.AutoMovie).Mode);
        Assert.Contains(body.Targets, t => t.Id == AutomationFlags.SeerrTarget && t.Killed);
        var search = body.Budgets.Single(b => b.Category == BudgetCategories.Search && b.Scope == radarr && b.Window == "1h");
        Assert.Equal((1, 1, "Radarr", e.R.Now + TimeSpan.FromHours(1)), (search.Used, search.Limit, search.ScopeName, search.NextSlotAt));
        Assert.Equal(("pending", 1), (body.Migration!.Notice, body.Migration.Grants.Count));
        Assert.Equal("je", body.Contract.Backend);
        Assert.IsType<OkObjectResult>(admin.DismissNotice());
        Assert.Equal("seen", status.Build().Migration!.Notice);
        Assert.False(status.DismissNotice());
        Assert.Equal(400, Assert.IsType<BadRequestObjectResult>(admin.ResetBreaker(new AutomationBreakerResetRequest { Target = "../x" })).StatusCode);
        Assert.Equal(400, Assert.IsType<BadRequestObjectResult>(admin.Decisions("nope", null)).StatusCode);
        Assert.IsType<OkObjectResult>(admin.Decisions(null, 5));
    }
}
