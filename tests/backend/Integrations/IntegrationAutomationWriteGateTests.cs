using System.Text.Json;
using System.Text.Json.Nodes;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Automation;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;
using Jellyfin.Plugin.JellyfinEnhanced.Services.AutoRequest;
using MediaBrowser.Controller.Entities;

namespace JE.Tests;

/// <summary>
/// Since review round 6 (D41) the guarantee is the transport check (AutomationTransportHandler): every automatic write is
/// checked against the gate inside the HTTP transport, synchronously, as it is handed on. The tables here run every write
/// site against it (<see cref="EveryGateFlippedAsTheWriteReachesTheTransportStopsThatWrite"/>,
/// <see cref="EveryAutomaticWriteReachesTheTransportCheckAsAutomaticWork"/>; IntegrationAutomationTransportTests covers the
/// clients and a person's own requests). The write sites' own gate calls and the walk of the code (WriteGateWalk, the
/// source tests at the end) stay as defence in depth; they are no longer what the guarantee rests on.
///
/// 4a review round 4 (the fourth "gate read before an await, not re-read before the write"): every automatic outbound
/// write passes one write gate immediately before it leaves. The table below runs every write site (each Sonarr/Radarr
/// write and search of the Direct backend, the Seerr backend's POST, and the old recipes' direct Seerr POST at the first
/// and the next address) and flips every gate during the awaited step just before that write: the write must not go,
/// and the job is held with that gate's reason. Where a gate doesn't apply to a site the cell says why, and where it can
/// be flipped there anyway the write still goes (the gate doesn't over-block the feature-off path).
/// </summary>
[Collection("Plugin singleton")]
public class IntegrationAutomationWriteGateTests
{
    // ------------------------------------------------------------------ the table

    /// <summary>The automatic write sites.</summary>
    public static readonly string[] Sites =
    {
        "direct_tag_create", "direct_movie_add", "direct_movie_monitor", "direct_movie_search",
        "direct_series_add", "direct_series_editor", "direct_seasonpass", "direct_episode_monitor", "direct_episode_search", "direct_season_search", "direct_refresh_series", "direct_refresh_episodes",
        "seerr_post",
        "legacy_movie_post", "legacy_movie_next_url", "legacy_season_post", "legacy_season_next_url",
    };

    /// <summary>A change to one gate made during the awaited step before a write; <c>Gate</c> is the gate it flips.</summary>
    public sealed record Flip(string Id, string Gate, string Reason);

    /// <summary>Every flip, with the gate it belongs to and the hold reason an outbox job then carries.</summary>
    public static readonly Flip[] Flips =
    {
        new("legacy_switch_off", "legacy_switch", AutomationHolds.RecipePaused),
        new("shadow_override_on", "shadow_override", AutomationHolds.ShadowOverride),
        new("integration_off", "requests", "configuration_changed"),
        new("phase1_off", "requests", "configuration_changed"),
        new("phase3_toggled", "requests", "configuration_changed"),
        new("backend_changed", "requests", "configuration_changed"),
        new("seerr_off", "requests", "configuration_changed"),
        new("phase4_off", "phase4", AutomationHolds.Phase4Off),
        new("engine_off", "engine_changed", AutomationHolds.EngineChanged),
        new("engine_on", "engine_changed", AutomationHolds.EngineChanged),
        new("kill_all", "kill_all", AutomationHolds.Killed),
        new("kill_recipe", "kill_recipe", AutomationHolds.Killed),
        new("kill_target", "kill_target", AutomationHolds.Killed),
        new("mode_shadow", "recipe_mode", AutomationHolds.RecipePaused),
        new("mode_off", "recipe_mode", AutomationHolds.RecipePaused),
        new("opt_out", "consent", AutomationHolds.UserOptedOut),
        new("mode_ask", "approval", AutomationHolds.ApprovalRequired),
        new("trust_revoked", "approval", AutomationHolds.ApprovalRequired),
        new("breaker_open", "breaker", AutomationHolds.BreakerOpen),
        new("low_disk", "low_disk", AutomationHolds.LowDisk),
        new("disk_guard_on", "disk_unknown", AutomationHolds.DiskUnknown),
        new("budget_zero", "budget", AutomationHolds.BudgetExhausted),
    };

    private static bool Direct(string site) => site.StartsWith("direct_", StringComparison.Ordinal);
    private static bool Legacy(string site) => site.StartsWith("legacy_", StringComparison.Ordinal);
    private static bool MovieSite(string site) => site is "direct_tag_create" or "direct_movie_add" or "direct_movie_monitor" or "direct_movie_search" or "seerr_post" or "legacy_movie_post" or "legacy_movie_next_url";

    /// <summary>
    /// Why a flip doesn't apply to a site (null: it does, and the write must not go). A non-applicable cell is still run
    /// when the flip can be made there (<see cref="Runnable"/>): the write then goes as before.
    /// </summary>
    internal static string? NotApplicable(string site, string flip)
    {
        if (Legacy(site))
        {
            return flip switch
            {
                "legacy_switch_off" or "shadow_override_on" or "phase3_toggled" or "seerr_off" => null,
                "integration_off" or "phase1_off" or "backend_changed" => "the old recipes' direct Seerr path predates the integration and its request backend (phase 3 off)",
                "phase4_off" => "only work phase 4 creates waits for phase 4; the old recipes don't",
                "engine_off" or "engine_on" => "the engine needs phase 3; with phase 3 off it can't be in effect (phase 3 on restarts the check: phase3_toggled)",
                _ => "an engine-only gate: the engine can't be in effect while the old recipes use their direct Seerr path (phase 3 off)",
            };
        }
        return (site, flip) switch
        {
            (_, "seerr_off") when site != "seerr_post" => "Sonarr/Radarr handling doesn't use Seerr",
            ("seerr_post", "disk_guard_on") => "Seerr handling: Seerr picks the server and folder, so there is no destination whose facts could be unknown (the low-disk guard still measures the default drive)",
            ("direct_tag_create" or "direct_refresh_series" or "direct_refresh_episodes", "budget_zero") => "not budgeted: creating the attribution tag or refreshing a series' metadata adds, monitors and searches nothing",
            _ => null,
        };
    }

    /// <summary>Cells whose flip can't be made on the site at all (nothing to change there): listed, not run.</summary>
    internal static bool Runnable(string site, string flip)
        => !(Legacy(site) && flip is "opt_out" or "trust_revoked" or "breaker_open" or "low_disk" or "disk_guard_on" or "budget_zero" or "phase4_off");

    public static IEnumerable<object[]> Cells()
        => from site in Sites from flip in Flips where Runnable(site, flip.Id) select new object[] { site, flip.Id };

    [Theory]
    [MemberData(nameof(Cells))]
    public Task EveryGateFlippedDuringTheStepBeforeAnAutomaticWriteStopsThatWrite(string site, string flipId)
        => FlipBeforeTheWriteAsync(site, flipId, lastMoment: false);

    /// <summary>
    /// 4a review round 6 (D41): the same table, each flip made at the last moment, as the write reaches the transport
    /// check (the outbox's, the backend's and the old recipe's own gate calls have all answered by then). Only the
    /// transport check can stop these writes.
    /// </summary>
    [Theory]
    [MemberData(nameof(Cells))]
    public Task EveryGateFlippedAsTheWriteReachesTheTransportStopsThatWrite(string site, string flipId)
        => FlipBeforeTheWriteAsync(site, flipId, lastMoment: true);

    private static async Task FlipBeforeTheWriteAsync(string site, string flipId, bool lastMoment)
    {
        var flip = Flips.Single(f => f.Id == flipId);
        var blocks = NotApplicable(site, flipId) == null;
        if (Legacy(site))
        {
            var (posts, outcome) = await LegacyAsync(site, flipId, lastMoment);
            var first = site.EndsWith("_post", StringComparison.Ordinal);
            // The first address: no POST when blocked; the next address: only the first address's (failed) POST.
            Assert.Equal(blocks ? (first ? 0 : 1) : (first ? 1 : 2), posts);
            // Held: the override records a Shadow decision, a switched-off recipe or Seerr sends nothing, phase 3 on restarts
            // the check through the ledger (asserted in LegacyAsync).
            if (blocks && flipId != "phase3_toggled")
                Assert.Equal((AutoRequestOutcomeKind.DefinitiveNoop, flipId == "shadow_override_on" ? "shadow_override" : "disabled"), (outcome.Kind, outcome.Reason));
            return;
        }
        var (wrote, reason, flipped) = await OutboxAsync(site, flipId, lastMoment: lastMoment);
        Assert.True(flipped, "the flip ran during the step before the write");
        Assert.Equal(!blocks, wrote);
        if (blocks) Assert.Equal(flip.Reason, reason);
    }

    public static IEnumerable<object[]> SiteCases() => Sites.Select(s => new object[] { s });

    /// <summary>
    /// 4a review round 6 (D41): every automatic write site's write reaches the transport check as automatic work, and so
    /// does every other write of that flow (one the check didn't see as automatic fails here).
    /// </summary>
    [Theory]
    [MemberData(nameof(SiteCases))]
    public async Task EveryAutomaticWriteReachesTheTransportCheckAsAutomaticWork(string site)
    {
        if (Legacy(site))
        {
            var (posts, _) = await LegacyAsync(site, "none", lastMoment: true);
            Assert.Equal(site.EndsWith("_post", StringComparison.Ordinal) ? 1 : 2, posts);
            return;
        }
        var (wrote, _, reached) = await OutboxAsync(site, "none", lastMoment: true);
        Assert.True(reached, "the site's write reached the transport");
        Assert.True(wrote);
    }

    // ------------------------------------------------------------------ outbox sites (Direct and Seerr backends)

    private static JsonObject Unmonitored(JsonObject movie) { movie["monitored"] = false; return movie; }

    // An existing series: S1 and its episodes monitored, S2 not, S3 not but S3E1 monitored.
    private static void ExistingSeries(IntegrationRequestBackendsTests.Lab lab)
    {
        lab.Sonarr.Series.Add(new JsonObject
        {
            ["id"] = 30, ["tvdbId"] = 75565, ["title"] = "Blake's 7", ["monitored"] = true, ["monitorNewItems"] = "none", ["qualityProfileId"] = 2,
            ["seasons"] = new JsonArray(
                new JsonObject { ["seasonNumber"] = 0, ["monitored"] = false },
                new JsonObject { ["seasonNumber"] = 1, ["monitored"] = true },
                new JsonObject { ["seasonNumber"] = 2, ["monitored"] = false },
                new JsonObject { ["seasonNumber"] = 3, ["monitored"] = false },
                new JsonObject { ["seasonNumber"] = 4, ["monitored"] = false }),
        });
        var id = 3000;
        foreach (var season in new[] { 1, 2, 3, 4 })
            foreach (var episode in new[] { 1, 2, 3 })
                lab.Sonarr.Episodes.Add(new JsonObject { ["id"] = ++id, ["seriesId"] = 30, ["seasonNumber"] = season, ["episodeNumber"] = episode, ["monitored"] = season == 1 || (season == 3 && episode == 1), ["hasFile"] = false });
    }

    private static MutationInput Series(string scope, int[]? seasons = null, params RequestEpisode[] episodes)
        => new() { Key = "tv:tvdb:75565", Scope = scope, Seasons = seasons ?? Array.Empty<int>(), Episodes = episodes };

    // The fixture, the input, the read the flip happens during (host and path) and the write that must then not go.
    private static (MutationInput Input, FakeArr.Host Host, string During, Func<(string Method, string Path, string Body), bool> Write) Fixture(IntegrationRequestBackendsTests.Lab lab, string site)
    {
        static Func<(string Method, string Path, string Body), bool> Is(string method, string path, string? contains = null)
            => w => w.Method == method && w.Path == path && (contains == null || w.Body.Contains(contains, StringComparison.Ordinal));
        switch (site)
        {
            case "direct_tag_create":
                lab.Radarr.Tags.Clear();
                lab.Radarr.Lookup.Add(IntegrationRequestBackendsTests.Lab.MovieLookup(961));
                return (IntegrationRequestLedgerTests.Movie(961), lab.Radarr, "/api/v3/tag", Is("POST", "/api/v3/tag"));
            case "direct_movie_add":
                lab.Radarr.Lookup.Add(IntegrationRequestBackendsTests.Lab.MovieLookup(961));
                return (IntegrationRequestLedgerTests.Movie(961), lab.Radarr, "/api/v3/tag", Is("POST", "/api/v3/movie"));
            case "direct_movie_monitor":
                lab.Radarr.Movies.Add(Unmonitored(FakeArr.Movie(41, 961, "The General", hasFile: false)));
                return (IntegrationRequestLedgerTests.Movie(961), lab.Radarr, "/api/v3/movie", Is("PUT", "/api/v3/movie/editor"));
            case "direct_movie_search":
                lab.Radarr.Movies.Add(FakeArr.Movie(41, 961, "The General", hasFile: false));
                return (IntegrationRequestLedgerTests.Movie(961), lab.Radarr, "/api/v3/movie", Is("POST", "/api/v3/command", "MoviesSearch"));
            case "direct_series_add":
                lab.Sonarr.Lookup.Add(IntegrationRequestBackendsTests.Lab.SeriesLookup(75565, seasons: 2));
                lab.Sonarr.EpisodeList[75565] = new[] { (1, 1), (1, 2) };
                return (Series("seasons", new[] { 1 }), lab.Sonarr, "/api/v3/tag", Is("POST", "/api/v3/series"));
            case "direct_series_editor":
                ExistingSeries(lab);
                return (Series("future", new[] { 3 }), lab.Sonarr, "/api/v3/series", Is("PUT", "/api/v3/series/editor"));
            case "direct_seasonpass":
                ExistingSeries(lab);
                return (Series("seasons", new[] { 2 }), lab.Sonarr, "/api/v3/series", Is("POST", "/api/v3/seasonpass"));
            case "direct_episode_monitor":
                ExistingSeries(lab);
                return (Series("episodes", null, new RequestEpisode(3, 2)), lab.Sonarr, "/api/v3/episode", Is("PUT", "/api/v3/episode/monitor"));
            case "direct_episode_search":
                ExistingSeries(lab);
                return (Series("episodes", null, new RequestEpisode(1, 1)), lab.Sonarr, "/api/v3/episode", Is("POST", "/api/v3/command", "EpisodeSearch"));
            case "direct_season_search":
                ExistingSeries(lab);
                return (Series("seasons", new[] { 1 }), lab.Sonarr, "/api/v3/episode", Is("POST", "/api/v3/command", "SeasonSearch"));
            case "direct_refresh_series":
                // A season Sonarr doesn't list yet: the series is refreshed.
                ExistingSeries(lab);
                return (Series("seasons", new[] { 5 }), lab.Sonarr, "/api/v3/series", Is("POST", "/api/v3/command", "RefreshSeries"));
            case "direct_refresh_episodes":
                // An episode Sonarr doesn't list yet (its season is listed): the series is refreshed.
                ExistingSeries(lab);
                return (Series("episodes", null, new RequestEpisode(4, 9)), lab.Sonarr, "/api/v3/episode", Is("POST", "/api/v3/command", "RefreshSeries"));
            default:
                throw new ArgumentOutOfRangeException(nameof(site), site, null);
        }
    }

    // ------------------------------------------------------------------ flipped while the write is admitted (round 5)

    /// <summary>The sites whose write is admitted against a budget right before it leaves: a Radarr add and search, a
    /// Sonarr add and monitor, and the Seerr POST.</summary>
    public static readonly string[] AdmittedSites = { "direct_movie_add", "direct_movie_search", "direct_series_add", "direct_seasonpass", "seerr_post" };

    /// <summary>Flips this table doesn't make, and why.</summary>
    internal static readonly Dictionary<string, string> NotWhileAdmitted = new(StringComparer.Ordinal)
    {
        ["engine_on"] = "queued with the engine off, the job isn't admitted against a budget: there is no admission to flip it in",
    };

    public static IEnumerable<object[]> AdmissionCells()
        => from site in AdmittedSites from flip in Flips where !NotWhileAdmitted.ContainsKey(flip.Id) select new object[] { site, flip.Id };

    /// <summary>
    /// 4a review round 5: the per-write budget admission sits between the gate and the send, and it waits for the
    /// database (one writer at a time, none during a restore). Each gate is flipped inside that admission (after the gate
    /// answered): the write must not go, and the job holds that gate's reason. Before the fix only the first gate was
    /// asked, so these writes went out.
    /// </summary>
    [Theory]
    [MemberData(nameof(AdmissionCells))]
    public async Task EveryGateFlippedWhileTheWriteIsAdmittedStopsThatWrite(string site, string flipId)
    {
        var flip = Flips.Single(f => f.Id == flipId);
        var blocks = NotApplicable(site, flipId) == null;
        var (wrote, reason, flipped) = await OutboxAsync(site, flipId, whileAdmitted: true);
        Assert.True(flipped, "the flip ran inside the write's admission");
        Assert.Equal(!blocks, wrote);
        if (blocks) Assert.Equal(flip.Reason, reason);
    }

    private static async Task<(bool Wrote, string? Reason, bool Flipped)> OutboxAsync(string site, string flipId, bool whileAdmitted = false, bool lastMoment = false)
    {
        var seerr = site == "seerr_post";
        using var seerrLab = seerr ? new IntegrationRequestBackendsTests.SeerrLab() : null;
        using var arrLab = seerr ? null : new IntegrationRequestBackendsTests.Lab();
        var lab = seerrLab?.Arr ?? arrLab!;
        // engine_on: queued by an old recipe with the engine off (an administrator's, which goes without an OK then).
        using var e = new IntegrationAutomationTests.Engine(engine: flipId != "engine_on");
        var c = e.C;
        var movie = MovieSite(site);
        var recipe = flipId == "phase4_off" ? AutomationRecipes.KeepUp : movie ? AutomationRecipes.AutoMovie : AutomationRecipes.AutoSeason;
        // Otherwise a Trusted Manager: eligible for Auto, so revoking the trust can be flipped too.
        var user = flipId == "engine_on" ? e.R.Admin : e.R.Manager;
        e.Trusted.Trusted.Add(e.R.Manager);
        e.Mode(recipe, AutomationMode.Auto);
        if (recipe == AutomationRecipes.KeepUp) e.Consent.Map[(user, recipe)] = true;
        // A send that starts with the disk guard off and the destination's disk facts not read yet (cold after a restart).
        if (flipId == "disk_guard_on") { c.ArrLowDiskPercent = 0; e.R.Policy.DiskFacts = false; }

        MutationInput input;
        Func<bool> wrote;
        var target = string.Empty;
        var flipped = false;
        void Once(Action flip) { if (flipped) return; flipped = true; flip(); }
        Action flipNow = () => Apply(flipId, e, recipe, user, () => target);
        if (seerr)
        {
            c.ArrRequestBackend = "seerr";
            // The live configuration is the backend's own in production: Seerr on, with its address and key.
            c.JellyseerrEnabled = true;
            c.JellyseerrUrls = FakeSeerr.Url;
            c.JellyseerrApiKey = FakeSeerr.Key;
            seerrLab!.Seerr.Users.Add(new JsonObject { ["id"] = 9, ["jellyfinUserId"] = user.ToString("N"), ["permissions"] = 2, ["displayName"] = "Person" });
            var source = seerrLab.Source;
            e.R.Policy.Adjust = (_, _, facts) => facts.Backend == "seerr" ? facts with { SeerrSource = source, SeerrUser = 9, BackendQuota = new QuotaProjection(0, null, null, null, 0) } : facts;
            input = IntegrationRequestLedgerTests.Movie(22596);
            target = AutomationFlags.SeerrTarget;
            // The account check right before the POST is the last awaited step.
            if (!whileAdmitted && !lastMoment) seerrLab.Seerr.BeforeRequest = uri => { if (uri.AbsolutePath == "/api/v1/user/9") Once(flipNow); return Task.CompletedTask; };
            if (lastMoment) seerrLab.Seerr.Transport.BeforeGate = request => { if (request.Method == HttpMethod.Post && request.RequestUri!.AbsolutePath == "/api/v1/request") Once(flipNow); };
            wrote = () => seerrLab.Seerr.Posts.Count > 0;
        }
        else
        {
            var fixture = Fixture(lab, site);
            input = fixture.Input;
            var instance = lab.Instance(movie ? "Radarr" : "Sonarr").Id;
            var generation = lab.Arr.Factory.ConnectionGeneration(instance)!;
            target = instance;
            e.R.Policy.Adjust = (_, _, facts) => facts with { InstanceId = instance, ConnectionGeneration = generation };
            if (!whileAdmitted && !lastMoment) fixture.Host.Before = (path, _) => { if (path == fixture.During) Once(flipNow); return Task.CompletedTask; };
            if (lastMoment) lab.Arr.Transport.BeforeGate = request =>
            {
                var body = request.Content?.ReadAsStringAsync().GetAwaiter().GetResult() ?? "";
                if (fixture.Write((request.Method.Method, request.RequestUri!.AbsolutePath, body))) Once(flipNow);
            };
            wrote = () => fixture.Host.Writes.Any(fixture.Write);
        }

        var asked = await e.Auto(user, input, recipe);
        // As the first admission of a write starts (after the gate answered), before it waits for the database writer: the
        // admission reads the limits once it has the writer, so a budget lowered here applies (4a-security-r6-1). A flip
        // writes the database itself (the breaker), so it can't run under the writer.
        if (whileAdmitted) e.Budgets.BeforeAdmission = () => Once(flipNow);
        Assert.NotNull(asked.WantId);
        var want = e.R.Ledger.Find(asked.WantId!)!;
        Assert.Equal("queued", want.Status);
        await e.Outbox(seerr ? seerrLab!.Backend : lab.Direct).TickAsync(default);
        var job = e.R.Ledger.ForWant(want.Id).Single();
        // Every write of the flow (the site's included) reached the transport check as automatic work.
        var writes = (seerr ? seerrLab!.Seerr.Transport : lab.Arr.Transport).Writes;
        if (lastMoment) Assert.NotEmpty(writes);
        Assert.All(writes, w => Assert.True(w.Checked, w.Method + " " + w.Path + " left without the transport check"));
        return (wrote(), job.Reason, flipped);
    }

    // Makes one flip on the outbox's live configuration and state.
    private static void Apply(string flipId, IntegrationAutomationTests.Engine e, string recipe, Guid user, Func<string> target)
    {
        var c = e.C;
        switch (flipId)
        {
            case "none": break;
            case "legacy_switch_off": c.AutoMovieRequestEnabled = false; c.AutoSeasonRequestEnabled = false; break;
            case "shadow_override_on": c.ArrAutomationShadowOverride = true; break;
            case "integration_off": c.ArrIntegrationEnabled = false; break;
            case "phase1_off": c.ArrPhase1Enabled = false; break;
            case "phase3_toggled": c.ArrPhase3Enabled = false; break;
            case "backend_changed": c.ArrRequestBackend = c.ArrRequestBackend == "seerr" ? "je" : "seerr"; break;
            case "seerr_off": c.JellyseerrEnabled = false; break;
            case "phase4_off": c.ArrPhase4Enabled = false; break;
            case "engine_off": c.ArrPhase4AutomationEnabled = false; break;
            case "engine_on": c.ArrPhase4Enabled = true; c.ArrPhase4AutomationEnabled = true; break;
            case "kill_all": c.ArrAutomationKillAll = true; break;
            case "kill_recipe": e.Mode(recipe, AutomationMode.Auto, killed: true); break;
            case "kill_target": c.ArrAutomationKilledInstances = "other," + target(); break;
            case "mode_shadow": e.Mode(recipe, AutomationMode.Shadow); break;
            case "mode_off": e.Mode(recipe, AutomationMode.Off); break;
            case "opt_out": e.Consent.Map[(user, recipe)] = false; break;
            case "mode_ask": e.Mode(recipe, AutomationMode.Ask); break;
            case "trust_revoked": e.Trusted.Trusted.Remove(user); break;
            case "breaker_open":
                for (var i = 0; i < AutomationStore.BreakerThreshold; i++) e.Store.Failure(target(), "backend_unavailable", e.R.Now);
                break;
            case "low_disk": e.R.Policy.Pause = new RequestDiskFacts(target(), "Arr", "/data", 1, 100, 10); break;
            case "disk_guard_on": c.ArrLowDiskPercent = 10; break;
            case "budget_zero": c.ArrAutomationHouseholdAddsPerDay = 0; c.ArrAutomationSearchesPerHour = 0; c.ArrAutomationSeerrPostsPerDay = 0; break;
            default: throw new ArgumentOutOfRangeException(nameof(flipId), flipId, null);
        }
    }

    // ------------------------------------------------------------------ the old recipes' direct Seerr POST (phase 3 off)

    private static async Task<(int Posts, AutoRequestOutcome Outcome)> LegacyAsync(string site, string flipId, bool lastMoment = false)
    {
        using var a = new IntegrationAutoRequestLedgerTests.Auto(seerr: true);
        a.F.Plugin.Configuration.ArrPhase3Enabled = false;
        a.F.Plugin.Configuration.JellyseerrUrls = "http://seerr.test,http://seerr2.test";
        var movie = MovieSite(site);
        var nextUrl = site.EndsWith("_next_url", StringComparison.Ordinal);
        var person = a.Person("Admin");
        var posts = 0;
        var flipped = false;
        void Flip()
        {
            if (flipped) return;
            flipped = true;
            IntegrationAutoRequestLedgerTests.Save(a.F, c =>
            {
                switch (flipId)
                {
                    case "none": break;
                    case "legacy_switch_off": c.AutoMovieRequestEnabled = false; c.AutoSeasonRequestEnabled = false; break;
                    case "shadow_override_on": c.ArrAutomationShadowOverride = true; break;
                    case "integration_off": c.ArrIntegrationEnabled = false; break;
                    case "phase1_off": c.ArrPhase1Enabled = false; break;
                    case "phase3_toggled": c.ArrPhase3Enabled = true; break;
                    case "backend_changed": c.ArrRequestBackend = "seerr"; break;
                    case "seerr_off": c.JellyseerrEnabled = false; break;
                    case "engine_off": c.ArrPhase4AutomationEnabled = false; break;
                    case "engine_on": c.ArrPhase4Enabled = true; c.ArrPhase4AutomationEnabled = true; break;
                    case "kill_all": c.ArrAutomationKillAll = true; break;
                    case "kill_recipe":
                    case "mode_shadow":
                    case "mode_off":
                    case "mode_ask":
                        var mode = flipId switch { "mode_shadow" => "shadow", "mode_off" => "off", "mode_ask" => "ask", _ => "auto" };
                        c.ArrAutomationRecipes = JsonSerializer.Serialize(new Dictionary<string, object> { [movie ? AutomationRecipes.AutoMovie : AutomationRecipes.AutoSeason] = new { mode, killed = flipId == "kill_recipe" } });
                        break;
                    case "kill_target": c.ArrAutomationKilledInstances = AutomationFlags.SeerrTarget; break;
                    default: throw new ArgumentOutOfRangeException(nameof(flipId), flipId, null);
                }
            });
        }
        if (lastMoment) a.Transport.BeforeGate = request =>
        {
            if (request.Method == HttpMethod.Post && request.RequestUri!.AbsolutePath == "/api/v1/request" && (!nextUrl || posts == 1)) Flip();
        };
        a.Answer = r =>
        {
            var path = r.RequestUri!.AbsolutePath;
            if (path == "/api/v1/user")
            {
                // The account lookup: the last awaited step before the first address's POST.
                if (!nextUrl && !lastMoment) Flip();
                return IntegrationTransport.Response(JsonSerializer.Serialize(new { results = new object[] { new { id = 5, jellyfinUserId = person.ToString("N") } } }));
            }
            if (r.Method == HttpMethod.Post && path == "/api/v1/request")
            {
                posts++;
                if (!nextUrl) return IntegrationTransport.Response("{\"id\":1}", 201);
                // The first address's POST fails: the last awaited step before the next address's.
                if (posts == 1) { if (!lastMoment) Flip(); return IntegrationTransport.Response("{\"message\":\"down\"}", 503); }
                return IntegrationTransport.Response("{\"id\":1}", 201);
            }
            if (path == "/api/v1/collection/9")
                return IntegrationTransport.Response(JsonSerializer.Serialize(new { parts = new object[] { new { id = 123, title = "First", releaseDate = "2000-01-01" }, new { id = 124, title = "Second", releaseDate = "2001-01-01" } } }));
            return IntegrationAutoRequestLedgerTests.SeerrShow(r) ?? IntegrationAutoRequestLedgerTests.Collection(r);
        };
        AutoRequestOutcome outcome;
        if (movie) outcome = await a.Movies().CheckMovieForCollectionRequestAsync(IntegrationAutoRequestLedgerTests.Watched(), person);
        else
        {
            var (_, episode, library) = IntegrationAutoRequestLedgerTests.Show(9);
            var previous = BaseItem.LibraryManager;
            BaseItem.LibraryManager = library.Object;
            try { outcome = await new AutoSeasonRequestService(a.Transport, a.F.Core.Logger, a.Users.Object, null!, library.Object, a.Recorder).CheckEpisodeCompletionAsync(episode, person); }
            finally { BaseItem.LibraryManager = previous; }
        }
        Assert.True(flipped, "the flip ran during the step before the POST");
        if (flipId == "phase3_toggled")
        {
            // Phase 3 on: the check started again through the ledger instead of POSTing.
            Assert.Single(a.R.Ledger.ForTitle(movie ? "movie:tmdb:124" : "tv:tvdb:4242"));
        }
        // Every write of the check reached the transport check as the recipe's.
        if (lastMoment) Assert.NotEmpty(a.Transport.Writes);
        Assert.All(a.Transport.Writes, w => Assert.True(w.Checked, w.Method + " " + w.Path + " left without the transport check"));
        return (posts, outcome);
    }

    // ------------------------------------------------------------------ the recorder's snapshot

    /// <summary>A change to one setting a recorded intent depends on; <c>Field</c> is the snapshot field it changes.</summary>
    public sealed record SnapshotFlip(string Id, params string[] Fields);

    /// <summary>Every snapshot flip, with the snapshot fields it changes (Effective and Why follow from the others).</summary>
    public static readonly SnapshotFlip[] SnapshotFlips =
    {
        new("engine_off", "Engine", "Mode", "Effective", "Why"),
        new("mode_ask", "Mode", "Effective"),
        new("mode_shadow", "Mode", "Effective"),
        new("mode_off", "Mode", "Effective", "Why"),
        new("legacy_switch_off", "SwitchedOn", "Effective", "Why"),
        new("kill_all", "KilledAll", "Effective", "Why"),
        new("kill_recipe", "KilledRecipe", "Effective", "Why"),
        new("kill_target", "KilledTarget"),
        new("opt_out", "Consented"),
        new("free_on", "Free"),
        new("shadow_override_on", "ShadowOverride", "Effective", "Why"),
        new("trust_revoked", "Eligibility"),
        new("grant_added", "Eligibility"),
        new("backend_changed", "Backend", "Target"),
        new("target_changed", "Target"),
    };

    public static IEnumerable<object[]> SnapshotCells()
        => from start in new[] { "auto", "shadow" } from flip in SnapshotFlips select new object[] { start, flip.Id };

    /// <summary>
    /// A setting changed while the request service (Auto, Ask) or the Shadow preview reads what it needs gives exactly what
    /// the recipe records when the setting was already changed before it began: the recorder compares its whole snapshot
    /// right before the ledger write and before a Shadow decision is saved, and starts over on any difference.
    /// </summary>
    [Theory]
    [MemberData(nameof(SnapshotCells))]
    public async Task EverySettingARecordedIntentDependsOnChangedDuringPreparationIsRecordedAsIfItHadBeenSetBefore(string start, string flipId)
    {
        var during = await RecordAsync(start, flipId, "during");
        var before = await RecordAsync(start, flipId, "before");
        Assert.Equal(before, during);
        // On the Auto path every field changes what is recorded (the row tests something).
        if (start == "auto") Assert.NotEqual(await RecordAsync(start, flipId, "never"), before);
    }

    // when: the flip is made during the preparation reads, before the recipe runs, or never (the same start without it).
    private static async Task<string> RecordAsync(string start, string flipId, string when)
    {
        using var e = new IntegrationAutomationTests.Engine();
        var recipe = AutomationRecipes.AutoMovie;
        e.Mode(recipe, start == "shadow" ? AutomationMode.Shadow : AutomationMode.Auto);
        // A Trusted Manager (eligible for Auto); for grant_added, a Manager who isn't eligible yet.
        var user = e.R.Manager;
        if (flipId != "grant_added") e.Trusted.Trusted.Add(user);
        var seerrFacts = (Func<RequestPolicyFacts, RequestPolicyFacts>)(facts => facts.Backend == "seerr" ? facts with { SeerrSource = "seerr-src", SeerrUser = 7, BackendQuota = new QuotaProjection(0, null, null, null, 0) } : facts);
        e.R.Policy.Adjust = (_, _, facts) => seerrFacts(facts);
        void Flip()
        {
            var c = e.C;
            switch (flipId)
            {
                case "engine_off": c.ArrPhase4AutomationEnabled = false; break;
                case "mode_ask": e.Mode(recipe, AutomationMode.Ask); break;
                case "mode_shadow": e.Mode(recipe, AutomationMode.Shadow); break;
                case "mode_off": e.Mode(recipe, AutomationMode.Off); break;
                case "legacy_switch_off": c.AutoMovieRequestEnabled = false; break;
                case "kill_all": c.ArrAutomationKillAll = true; break;
                case "kill_recipe": e.Mode(recipe, start == "shadow" ? AutomationMode.Shadow : AutomationMode.Auto, killed: true); break;
                case "kill_target": c.ArrAutomationKilledInstances = "r1"; break;
                case "opt_out": e.Consent.Map[(user, recipe)] = false; break;
                case "free_on": c.ArrAutomationFree = true; break;
                case "shadow_override_on": c.ArrAutomationShadowOverride = true; break;
                case "trust_revoked": e.Trusted.Trusted.Remove(user); break;
                case "grant_added": e.Grant(user); break;
                case "backend_changed": c.ArrRequestBackend = "seerr"; c.JellyseerrEnabled = true; break;
                case "target_changed": e.R.Policy.People[user] = e.R.Policy.People[user] with { InstanceId = "r2", ConnectionGeneration = "g2" }; break;
                default: throw new ArgumentOutOfRangeException(nameof(flipId), flipId, null);
            }
        }
        if (when == "during")
        {
            // The request service's (or the Shadow preview's) preparation reads: the first awaited step after the recorder decided.
            var flipped = false;
            e.R.Policy.Before = (_, _) => { if (!flipped) { flipped = true; Flip(); } return Task.CompletedTask; };
        }
        else if (when == "before") Flip();
        await e.Auto(user, IntegrationRequestLedgerTests.Movie(880), recipe);
        return Recorded(e);
    }

    // What the ask left behind, without ids or times.
    private static string Recorded(IntegrationAutomationTests.Engine e)
        => string.Join("\n", new[]
        {
            "SELECT status, reason, cost, origin_kind, origin_source_id, origin_detail FROM wants",
            "SELECT cost, estimated_gb, state, scope FROM reservations",
            "SELECT action, instance_id, connection_generation, state, reason, json_extract(authorization_context,'$.Backend') FROM jobs",
            "SELECT action, reason FROM approvals",
            "SELECT recipe, mode, outcome, reason, backend, detail FROM automation_decisions",
        }.Select(sql => sql.Split(' ')[^1] + ": " + string.Join(" | ", e.R.Db.Read(c =>
        {
            using var cmd = c.CreateCommand();
            cmd.CommandText = sql + " ORDER BY 1, 2";
            using var reader = cmd.ExecuteReader();
            var rows = new List<string>();
            while (reader.Read()) rows.Add(string.Join(",", Enumerable.Range(0, reader.FieldCount).Select(i => reader.IsDBNull(i) ? "null" : Convert.ToString(reader.GetValue(i), System.Globalization.CultureInfo.InvariantCulture))));
            return rows;
        }))));

    // ------------------------------------------------------------------ the tables cover every gate, site and field

    [Fact]
    public void TheTablesCoverEveryGateEveryWriteSiteAndEverySnapshotField()
    {
        // Every gate has a flip in the table, except seerr_unsupported: a job's backend and recipe never change after it
        // is queued (a backend switch is the requests gate), so it can't be flipped; it has its own case below.
        Assert.Equal(AutomationWriteGate.Gates.Where(g => g != "seerr_unsupported").OrderBy(g => g), Flips.Select(f => f.Gate).Distinct().OrderBy(g => g));
        // Every (site, flip) cell is run, or says why the flip can't be made there.
        foreach (var site in Sites)
            foreach (var flip in Flips.Where(f => !Runnable(site, f.Id)))
                Assert.NotNull(NotApplicable(site, flip.Id));
        // Every field of the recorder's snapshot is changed by a row of its table.
        var fields = typeof(AutomationRecordSnapshot).GetConstructors().Single().GetParameters().Select(p => p.Name!).OrderBy(n => n);
        Assert.Equal(fields, SnapshotFlips.SelectMany(f => f.Fields).Distinct().OrderBy(n => n));
    }

    [Fact]
    public void ARecipeThatNeedsSonarrOrRadarrIsParkedOnSeerrAtEveryWrite()
    {
        using var e = new IntegrationAutomationTests.Engine();
        e.Mode(AutomationRecipes.ReleaseDay, AutomationMode.Auto);
        var write = new AutomationWrite { Path = AutomationWritePath.Queued, Recipe = AutomationRecipes.ReleaseDay, Automatic = true, Phase4Only = true, Requester = e.R.Admin, Backend = "seerr", Target = AutomationFlags.SeerrTarget, Input = IntegrationRequestLedgerTests.Movie(5), BudgetedAtStart = true };
        e.C.ArrRequestBackend = "seerr";
        e.C.JellyseerrEnabled = true;
        e.C.JellyseerrUrls = FakeSeerr.Url;
        e.C.JellyseerrApiKey = FakeSeerr.Key;
        e.Consent.Map[(e.R.Admin, AutomationRecipes.ReleaseDay)] = true;
        var hold = e.Guard.Gate.Check(write);
        Assert.Equal((AutomationHolds.SeerrUnsupported, true), (hold?.Reason, hold?.Park));
        Assert.Null(e.Guard.Gate.CheckOne("seerr_unsupported", write with { Backend = "je" }));
    }

    // ------------------------------------------------------------------ source: nothing writes around the gate

    private static string Source(string relative) => File.ReadAllText(Path.Combine(IntegrationAutoRequestLedgerTests.Root(), "Jellyfin.Plugin.JellyfinEnhanced", relative));

    private static readonly System.Text.RegularExpressions.Regex WriteMarker = new(@"HttpMethod\.(Post|Put|Delete|Patch)\b|\.(PostAsync|PutAsync|DeleteAsync|PatchAsync|PostAsJsonAsync|PutAsJsonAsync)\(");

    // The rule each automatic write site's file follows, by type: found by reflection over the plugin (every request
    // backend, and every class holding the recorder, the write gate or the send guard). A new one must be added here.
    private static readonly Dictionary<string, (string File, string Rule)> WriteSites = new(StringComparer.Ordinal)
    {
        ["DirectArrBackend"] = ("Services/Acquire/Requests/DirectArrBackend.cs", "funnel"),
        ["SeerrBackend"] = ("Services/Acquire/Requests/SeerrBackend.cs", "seerr"),
        ["AutoMovieRequestService"] = ("Services/AutoMovieRequestService.cs", "legacy"),
        ["AutoSeasonRequestService"] = ("Services/AutoSeasonRequestService.cs", "legacy"),
        ["RequestBackendRouter"] = ("Services/Acquire/Requests/RequestBackends.cs", "none"),
        ["UnavailableRequestBackend"] = ("Services/Acquire/Requests/RequestOutbox.cs", "none"),
        ["AutomationTransportContext"] = ("Services/Acquire/Automation/AutomationTransportHandler.cs", "none"),
        ["RequestOutbox"] = ("Services/Acquire/Requests/RequestOutbox.cs", "none"),
        ["AutoMovieRequestMonitor"] = ("Services/AutoMovieRequestMonitor.cs", "none"),
        ["AutoSeasonRequestMonitor"] = ("Services/AutoSeasonRequestMonitor.cs", "none"),
    };

    // Which table site each write marker is (the text that tells it apart on its line).
    private static readonly (string File, string Marker, string Site)[] SiteMarkers =
    {
        ("DirectArrBackend", "\"tag\"", "direct_tag_create"),
        ("DirectArrBackend", "\"movie\", body", "direct_movie_add"),
        ("DirectArrBackend", "\"movie/editor\"", "direct_movie_monitor"),
        ("DirectArrBackend", "\"MoviesSearch\"", "direct_movie_search"),
        ("DirectArrBackend", "\"series\", body", "direct_series_add"),
        ("DirectArrBackend", "\"series/editor\"", "direct_series_editor"),
        ("DirectArrBackend", "\"seasonpass\"", "direct_seasonpass"),
        ("DirectArrBackend", "\"episode/monitor\"", "direct_episode_monitor"),
        ("DirectArrBackend", "\"EpisodeSearch\"", "direct_episode_search"),
        ("DirectArrBackend", "\"SeasonSearch\"", "direct_season_search"),
        ("DirectArrBackend", "[\"seriesId\"] = listedId", "direct_refresh_series"),
        ("DirectArrBackend", "[\"seriesId\"] = seriesId", "direct_refresh_episodes"),
        ("SeerrBackend", "\"/api/v1/request\"", "seerr_post"),
        ("AutoMovieRequestService", "requestUri", "legacy_movie_post"),
        ("AutoSeasonRequestService", "requestUri", "legacy_season_post"),
    };

    // The gate each rule's writes are walked from (WriteGateWalk: syntax and symbols, from the gate down to the HTTP send).
    private static readonly Dictionary<string, string> RuleGates = new(StringComparer.Ordinal) { ["seerr"] = "finalGuard()", ["legacy"] = "DirectStop()" };

    /// <summary>
    /// Every walk from a gate to what it guards, with no wait on the way: the 17 write sites (the Direct funnel walks the
    /// client from its <c>proceed</c> to the send, and <c>Proceed</c> from the gate to its return) and the two recorded
    /// intents.
    /// </summary>
    internal static List<string> Walks(WriteGateWalk walk)
    {
        var problems = new List<string>();
        // Direct (sites 1–12): after the connection-slot wait the client asks proceed(), then sends through SendOnceAsync.
        // A write leaves the retry loop before its back-off (only a GET is idempotent).
        problems.AddRange(walk.GateToSend("Services/Arr/ArrClient.cs", "SendOnceAsync<T>(method, url", "proceed()", writeExit: "!idempotent"));
        // Proceed: the outbox guard (the gate), then the per-write admission, then back to the send.
        problems.AddRange(walk.GateToReturn("Services/Acquire/Requests/DirectArrBackend.cs", "if ((refusal = run.Guard()) != null) return false;", "run.Guard()"));
        // Seerr (13), and the old recipes' POST at every address (14–17).
        problems.AddRange(walk.GateToSend("Services/Acquire/Requests/SeerrBackend.cs", "HttpMethod.Post, url + \"/api/v1/request\"", "finalGuard()"));
        problems.AddRange(walk.GateToSend("Services/AutoMovieRequestService.cs", "HttpMethod.Post, requestUri", "DirectStop()"));
        problems.AddRange(walk.GateToSend("Services/AutoSeasonRequestService.cs", "HttpMethod.Post, requestUri", "DirectStop()"));
        // The record side: the caller's recheck right before the ledger write, and the recorder's before a Shadow decision.
        problems.AddRange(walk.GateToCall("Services/Acquire/Requests/RequestService.cs", "_ledger.Create(", "recheck?.Invoke()"));
        problems.AddRange(walk.GateToCall("Services/AutoRequest/AutoRequestRecorder.cs", "_store.Record(decision, _now())", "Changed()"));
        return problems;
    }

    [Fact]
    public void EveryAutomaticWriteSitePassesTheWriteGateWithNoAwaitInBetween()
    {
        var plugin = typeof(AutomationWriteGate).Assembly;
        var found = plugin.GetTypes().Where(t => t.IsClass && !t.IsAbstract && !t.Name.Contains('<', StringComparison.Ordinal) && (
            typeof(IRequestBackend).IsAssignableFrom(t) ||
            t.GetFields(System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Public)
                .Any(f => f.FieldType == typeof(AutoRequestRecorder) || f.FieldType == typeof(AutomationWriteGate) || f.FieldType == typeof(AutomationSendGuard))))
            .Select(t => t.Name).Where(n => n is not "AutomationSendGuard" and not "AutomationWriteGate").Distinct().ToList();
        foreach (var name in found)
            Assert.True(WriteSites.ContainsKey(name), name + " can make automatic writes: route them through AutomationWriteGate and add it (and its writes) to this test's tables");
        // And the list holds nothing stale.
        Assert.Equal(WriteSites.Keys.OrderBy(n => n), found.OrderBy(n => n));

        // The walk follows symbols, so the plugin it reads must compile.
        var walk = WriteGateWalk.Plugin;
        Clean(walk.Errors());
        var seen = new List<string>();
        var waits = new List<string>();
        foreach (var (type, (file, rule)) in WriteSites)
        {
            var source = Source(file);
            var markers = WriteMarker.Matches(source).Select(m => m.Index).ToList();
            if (rule == "none") { Assert.True(markers.Count == 0 || type == "UnavailableRequestBackend" || type == "RequestOutbox", type + " writes"); continue; }
            foreach (var index in markers)
            {
                var line = source[(source.LastIndexOf('\n', index) + 1)..source.IndexOf('\n', index)];
                var site = SiteMarkers.Where(m => m.File == type && (line.Contains(m.Marker, StringComparison.Ordinal) || source[index..Math.Min(source.Length, index + 120)].Contains(m.Marker, StringComparison.Ordinal))).Select(m => m.Site).ToList();
                Assert.True(site.Count == 1, type + ": a write the table doesn't know: " + line.Trim());
                Assert.Contains(site[0], Sites);
                seen.Add(site[0]);
                switch (rule)
                {
                    case "funnel":
                        // Every Direct write and search goes through WriteAsync, whose Proceed asks the gate after the
                        // connection-slot wait, right before the call leaves.
                        Assert.Contains("WriteAsync<", line, StringComparison.Ordinal);
                        break;
                    case "seerr":
                        waits.AddRange(walk.GateToSend(file, index, RuleGates[rule]));
                        // The gate, the per-write admission (and the bind), then the gate again right before the POST.
                        var last = source.LastIndexOf("finalGuard()", index, StringComparison.Ordinal);
                        Assert.Contains("admission?.Admit(", source[source.LastIndexOf("finalGuard()", last - 1, StringComparison.Ordinal)..last], StringComparison.Ordinal);
                        break;
                    case "legacy":
                        waits.AddRange(walk.GateToSend(file, index, RuleGates[rule]));
                        Assert.Contains("private string? DirectStop() => _gate.Check(AutomationWrite.LegacySeerr(Recipe, _recorder != null))?.Reason;", source, StringComparison.Ordinal);
                        break;
                }
            }
        }
        // Every write site of the table was found in the source, and only once.
        Assert.Equal(SiteMarkers.Select(m => m.Site).OrderBy(x => x), seen.OrderBy(x => x));

        // The Direct funnel: the gate (the outbox's guard) first, then the per-write admission, inside the client's checked
        // send; the client asks it after waiting for a connection slot and sends a write once (never retried).
        var direct = Source("Services/Acquire/Requests/DirectArrBackend.cs");
        var proceed = IntegrationAutoRequestLedgerTests.Body(direct, "bool Proceed()");
        Assert.True(proceed.IndexOf("run.Guard()", StringComparison.Ordinal) is >= 0 and var g && g < proceed.IndexOf("run.Admission.Admit(", StringComparison.Ordinal));
        // And again after the admission (it waits for the database), right before the call leaves.
        Assert.True(proceed.LastIndexOf("run.Guard()", StringComparison.Ordinal) > proceed.LastIndexOf("run.Admission.Admit(", StringComparison.Ordinal));
        Assert.Contains("SendCheckedAsync<T>(method, path, body, Proceed, run.Ct)", direct, StringComparison.Ordinal);
        Assert.Single(System.Text.RegularExpressions.Regex.Matches(direct, @"SendCheckedAsync|\.SendAsync<"));
        var client = IntegrationAutoRequestLedgerTests.Body(Source("Services/Arr/ArrClient.cs"), "private async Task<ArrResult<T>> SendCoreAsync<T>(");
        Assert.Contains("var idempotent = method == HttpMethod.Get;", client, StringComparison.Ordinal);
        // From each gate to its send (or recorded intent), nothing on the way waits: see WriteGateWalk.
        waits.AddRange(Walks(walk));
        Clean(waits);

        // The outbox: the gate before any transport and inside the guard every backend asks right before each write.
        var outbox = Source("Services/Acquire/Requests/RequestOutbox.cs");
        Assert.Contains("_automation?.Hold(job, want);", outbox, StringComparison.Ordinal);
        Assert.Contains("_automation?.Hold(job, want, budgetedAtStart: admission != null)", IntegrationAutoRequestLedgerTests.Body(outbox, "string? Guard()"), StringComparison.Ordinal);
        Assert.Contains("=> Gate.Check(AutomationWrite.ForJob(job, want, budgetedAtStart));", Source("Services/Acquire/Automation/AutomationAdmission.cs"), StringComparison.Ordinal);

        // No write site keeps its own subset of the gates.
        foreach (var file in new[] { "Services/Acquire/Requests/DirectArrBackend.cs", "Services/Acquire/Requests/SeerrBackend.cs", "Services/Acquire/Requests/RequestOutbox.cs", "Services/AutoMovieRequestService.cs", "Services/AutoSeasonRequestService.cs" })
        {
            var source = Source(file);
            foreach (var subset in new[] { "AutomationFlags.ShadowOverride(", "AutomationFlags.Kill", "AutomationModes.", "AutomationConsent.", "AutomationRecipes.SwitchedOn(", ".DiskKnown(", ".TitlePause(", ".Breaker(", "AutomationFlags.Engine(" })
                Assert.DoesNotContain(subset, source, StringComparison.Ordinal);
        }
    }

    [Fact]
    public void EveryRecordedIntentIsComparedAgainstTheWholeSnapshotWithNoAwaitInBetween()
    {
        // The ledger write: the caller's recheck right before it (no wait in between: Walks, above).
        var walk = WriteGateWalk.Plugin;
        Clean(walk.GateToCall("Services/Acquire/Requests/RequestService.cs", "_ledger.Create(", "recheck?.Invoke()"));
        // The recorder: its recheck compares the whole snapshot, and a Shadow decision is saved only after it.
        var recorder = Source("Services/AutoRequest/AutoRequestRecorder.cs");
        var once = IntegrationAutoRequestLedgerTests.Body(recorder, "private async Task<AutoRequestOutcome?> RecordOnceAsync(");
        Assert.Contains("string? Changed() => Snapshot(_requests.Policy.Configuration, recipe, user, input) != snapshot", once, StringComparison.Ordinal);
        Assert.Equal(2, System.Text.RegularExpressions.Regex.Matches(once, @"CreateAsync\([^;]*Changed\)").Count);
        Clean(walk.GateToCall("Services/AutoRequest/AutoRequestRecorder.cs", "_store.Record(decision, _now())", "Changed()"));
    }

    // ------------------------------------------------------------------ the walk catches every bypass (4a review round 5)

    private const string ArrFile = "Services/Arr/ArrClient.cs";
    private const string SeerrFile = "Services/Acquire/Requests/SeerrBackend.cs";

    // Each case plants a wait between a gate and what it guards in a copy of the plugin's source (each change replaces
    // text that is there once; the copy must still compile), and the walks must report it. Round 5 found two that line
    // and substring matching let through: an await on the write's own line, and one inside ArrClient.SendOnceAsync.
    private static readonly Dictionary<string, (string File, (string Text, string Planted)[] Changes, string Reported)> Bypasses = new(StringComparer.Ordinal)
    {
        // (a) On the write's own line, or in its arguments.
        ["seerr_await_on_the_write_line"] = (SeerrFile, new[] { ("raw = await RawAsync(HttpMethod.Post", "await Task.Yield(); raw = await RawAsync(HttpMethod.Post") }, "an await at SeerrBackend.cs"),
        ["seerr_await_in_the_write_arguments"] = (SeerrFile, new[] { ("seerrUser, body, WriteTimeout", "seerrUser, await Task.FromResult(body).ConfigureAwait(false), WriteTimeout") }, "an await at SeerrBackend.cs"),
        ["arr_await_on_the_send_line"] = (ArrFile, new[] { ("var outcome = await SendOnceAsync<T>(method, url", "await Task.Yield(); var outcome = await SendOnceAsync<T>(method, url") }, "an await at ArrClient.cs"),
        ["legacy_movie_await_on_the_write_line"] = ("Services/AutoMovieRequestService.cs", new[] { ("HttpMethod.Post, requestUri, apiKey", "HttpMethod.Post, requestUri, await Task.FromResult(apiKey)") }, "an await at AutoMovieRequestService.cs"),
        ["legacy_season_await_on_the_write_line"] = ("Services/AutoSeasonRequestService.cs", new[] { ("jellyseerrUserId, jsonContent);", "jellyseerrUserId, jsonContent); await Task.Yield();") }, "an await at AutoSeasonRequestService.cs"),
        ["record_await_on_the_ledger_line"] = ("Services/Acquire/Requests/RequestService.cs", new[] { ("var outcome = _ledger.Create(", "await Task.Yield(); var outcome = _ledger.Create(") }, "an await at RequestService.cs"),
        ["record_await_on_the_decision_line"] = ("Services/AutoRequest/AutoRequestRecorder.cs", new[] { ("_store.Record(decision, _now());", "await Task.Yield(); _store.Record(decision, _now());") }, "an await at AutoRequestRecorder.cs"),
        // (b) Hidden in the transport helpers and what they call before the HTTP send.
        ["arr_await_in_SendOnceAsync"] = (ArrFile, new[] { ("ArrCallCounter.Current.Value?.Increment();", "ArrCallCounter.Current.Value?.Increment(); await Task.Yield();") }, "an await at ArrClient.cs"),
        ["arr_blocking_wait_in_the_call_counter"] = ("Services/Arr/ArrCallAttribution.cs", new[] { ("internal void Increment() => Interlocked.Increment(ref _calls);", "internal void Increment() { Thread.Sleep(1); Interlocked.Increment(ref _calls); }") }, "a blocking wait (Thread.Sleep)"),
        ["seerr_await_in_RawAsync"] = (SeerrFile, new[] { ("var client = SeerrHttpHelper.CreateClient(_http);", "await Task.Yield(); var client = SeerrHttpHelper.CreateClient(_http);") }, "an await at SeerrBackend.cs"),
        ["seerr_blocking_wait_in_BuildRequest"] = ("Helpers/Jellyseerr/SeerrHttpHelper.cs", new[] { ("var req = new HttpRequestMessage(method, url);", "Thread.Sleep(1); var req = new HttpRequestMessage(method, url);") }, "SeerrHttpHelper.BuildRequest"),
        ["direct_blocking_wait_after_the_gate_in_Proceed"] = ("Services/Acquire/Requests/DirectArrBackend.cs", new[] { ("if ((refusal = run.Guard()) != null) return false;", "if ((refusal = run.Guard()) != null) return false; Thread.Sleep(1);") }, "a blocking wait (Thread.Sleep)"),
        // (c) Round 6 (4a-B-r6-1, the five of 4a-security-r6-2, and the client factory's own lambda): waits reached
        // through a delegate field in a helper, an explicit interface implementation, an async helper only started (its
        // synchronous start runs), a blocking collection, and the HTTP client factory (assigned in the client, or passed to
        // it by the factory). The transport check is the guarantee since round 6; the walk is defence in depth.
        ["blocking_delegate_field_in_helper"] = ("Services/Arr/ArrCallAttribution.cs", new[] { ("internal void Increment() => Interlocked.Increment(ref _calls);", "private static readonly Action Pause = () => Thread.Sleep(1); internal void Increment() { Pause(); Interlocked.Increment(ref _calls); }") }, "a call through a delegate the walk can't follow (Pause)"),
        ["blocking_explicit_interface_implementation"] = ("Services/Arr/ArrCallAttribution.cs", new[] { ("public sealed class ArrCallCounter", "internal interface IPause { void Pause(); } public sealed class ArrCallCounter : IPause"), ("internal void Increment() => Interlocked.Increment(ref _calls);", "void IPause.Pause() => Thread.Sleep(1); internal void Increment() { ((IPause)this).Pause(); Interlocked.Increment(ref _calls); }") }, "a blocking wait (Thread.Sleep)"),
        ["unawaited_async_helper_synchronous_prefix"] = ("Services/Arr/ArrCallAttribution.cs", new[] { ("internal void Increment() => Interlocked.Increment(ref _calls);", "private static async Task Pause() { Thread.Sleep(1); await Task.Yield(); } internal void Increment() { _ = Pause(); Interlocked.Increment(ref _calls); }") }, "a blocking wait (Thread.Sleep)"),
        ["blocking_collection_timeout"] = ("Services/Arr/ArrCallAttribution.cs", new[] { ("internal void Increment() => Interlocked.Increment(ref _calls);", "internal void Increment() { using var queue = new System.Collections.Concurrent.BlockingCollection<int>(); queue.TryTake(out _, 1); Interlocked.Increment(ref _calls); }") }, "a blocking wait (BlockingCollection.TryTake)"),
        ["blocking_http_factory_lambda_assignment"] = (ArrFile, new[] { ("_http = http;", "_http = () => { Thread.Sleep(1); return http(); };") }, "a blocking wait (Thread.Sleep)"),
        ["blocking_http_factory_assignment"] = (ArrFile, new[] { ("_http = http;", "_http = Pause; HttpClient Pause() { Thread.Sleep(1); return http(); }") }, "a blocking wait (Thread.Sleep)"),
        ["blocking_wait_in_the_client_factory"] = ("Services/Arr/ArrClientFactory.cs", new[] { ("() => _httpClientFactory.CreateClient(ArrHttp.ClientName)", "() => { Thread.Sleep(1); return _httpClientFactory.CreateClient(ArrHttp.ClientName); }") }, "factory passed at ArrClientFactory.cs"),
        // The per-write admission (it waits for the database) after the last gate, as before round 5's fix.
        ["seerr_admission_after_the_last_gate"] = (SeerrFile, new[] { ("raw = await RawAsync(HttpMethod.Post", "admission?.Admit(SendWriteKind.Post, \"post\"); raw = await RawAsync(HttpMethod.Post") }, "a blocking wait (SemaphoreSlim.Wait)"),
        ["direct_admission_after_the_last_gate"] = ("Services/Acquire/Requests/DirectArrBackend.cs", new[] { ("if ((refusal = run.Guard()) == null) return true;", "if ((refusal = run.Guard()) == null) { run.Admission.Admit(SendWriteKind.Search, \"again\"); return true; }") }, "a blocking wait (SemaphoreSlim.Wait)"),
        // A call the walk can't see into (the bind is a database write).
        ["seerr_delegate_after_the_last_gate"] = (SeerrFile, new[] { ("raw = await RawAsync(HttpMethod.Post", "_bind?.Invoke(job.Id, seerrUser, seasons); raw = await RawAsync(HttpMethod.Post") }, "a call through a delegate the walk can't follow (_bind)"),
        // The gate moved, made conditional or dropped, and a write sent again after the retry back-off.
        ["arr_gate_before_the_slot_wait"] = (ArrFile, new[] { ("if (proceed != null && !proceed())", "if (proceed != null && false)"), ("await _gate.WaitAsync(cancellationToken).ConfigureAwait(false);", "if (proceed != null && !proceed()) return ArrResult<T>.Failure(ArrErrorKind.NotConfigured, \"stopped\"); await _gate.WaitAsync(cancellationToken).ConfigureAwait(false);") }, "an await at ArrClient.cs"),
        ["arr_write_retried_after_the_back_off"] = (ArrFile, new[] { ("if (outcome.Result.Ok || !idempotent || ", "if (outcome.Result.Ok || ") }, "the loop sends the write again"),
        ["seerr_gate_in_a_branch"] = (SeerrFile, new[] { ("if (finalGuard() is { } last)", "if (ct.CanBeCanceled) if (finalGuard() is { } last)") }, "doesn't always run before the write"),
        ["seerr_gate_short_circuited"] = (SeerrFile, new[] { ("if (finalGuard() is { } last)", "if (ct.CanBeCanceled && finalGuard() is { } last)") }, "doesn't always run before the write"),
        ["seerr_last_gate_removed"] = (SeerrFile, new[] { ("if (finalGuard() is { } last)", "if (job.Id == null)"), ("return Refused(job, last);", "return Refused(job, \"none\");") }, "a blocking wait (SemaphoreSlim.Wait)"),
        ["direct_last_gate_removed"] = ("Services/Acquire/Requests/DirectArrBackend.cs", new[] { ("if ((refusal = run.Guard()) == null) return true;", "if (refusal == null) return true;") }, "a blocking wait (SemaphoreSlim.Wait)"),
    };

    // None, or every one in the failure message, one per line (Assert.Empty shows a cut-down list).
    private static void Clean(List<string> problems)
    {
        if (problems.Count > 0) throw new Xunit.Sdk.XunitException(string.Join("\n", problems));
    }

    public static IEnumerable<object[]> BypassCases() => Bypasses.Keys.Select(k => new object[] { k });

    [Theory]
    [MemberData(nameof(BypassCases))]
    public void TheWriteGateWalkReportsEveryWaitPlantedBetweenAGateAndItsWrite(string bypass)
    {
        var (file, changes, reported) = Bypasses[bypass];
        var planted = WriteGateWalk.Plugin.With(file, source =>
        {
            foreach (var (text, replacement) in changes)
            {
                var at = source.IndexOf(text, StringComparison.Ordinal);
                Assert.True(at >= 0 && source.IndexOf(text, at + 1, StringComparison.Ordinal) < 0, bypass + ": \"" + text + "\" must be there once");
                source = source[..at] + replacement + source[(at + text.Length)..];
            }

            return source;
        });
        Clean(planted.Errors(file));
        var problems = Walks(planted);
        Assert.Contains(problems, p => p.Contains(reported, StringComparison.Ordinal));
    }
}
