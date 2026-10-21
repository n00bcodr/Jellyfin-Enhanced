using System.Text.Json;
using System.Text.RegularExpressions;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Automation;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;
using Jellyfin.Plugin.JellyfinEnhanced.Services.AutoRequest;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Session;
using Microsoft.Extensions.Logging.Abstractions;
using Moq;

namespace JE.Tests;

/// <summary>
/// The existing auto-features on the request ledger (C59, C87): playback handlers only hand off to a
/// bounded, coalescing queue (source scan); the trigger gate is single-flight with a cooldown only after a
/// definitive outcome; outcomes are typed, so a TMDB or Seerr failure is never "nothing to do"; with phase 3
/// on, auto movie and auto season record wants under policy (a Member's automatic ask waits for an OK) and
/// every outcome reaches the automation log.
/// </summary>
[Collection("Plugin singleton")]
public class IntegrationAutoRequestLedgerTests
{
    internal sealed class Auto : IDisposable
    {
        public ApiPluginFixture F { get; } = new();
        public IntegrationRequestLedgerTests.Rig R { get; } = new();
        public Mock<IUserManager> Users { get; } = new();
        public AutoRequestRecorder Recorder { get; }
        public List<string> Urls { get; } = new();
        public Func<HttpRequestMessage, HttpResponseMessage?>? Answer { get; set; }
        public IntegrationTransport Transport { get; }
        public Auto(bool seerr = false)
        {
            var c = F.Plugin.Configuration;
            c.ArrIntegrationEnabled = true; c.ArrPhase1Enabled = true; c.ArrPhase3Enabled = true; c.ArrRequestBackend = "je";
            c.AutoMovieRequestEnabled = true; c.AutoSeasonRequestEnabled = true; c.TMDB_API_KEY = "test-tmdb"; c.AutoMovieRequestCheckReleaseDate = true;
            c.AutoSeasonRequestThresholdValue = 2;
            // The request service reads its own configuration (the same live object in production).
            R.Policy.Configuration.AutoMovieRequestEnabled = true; R.Policy.Configuration.AutoSeasonRequestEnabled = true;
            if (seerr) { c.JellyseerrEnabled = true; c.JellyseerrUrls = "http://seerr.test"; c.JellyseerrApiKey = "test-seerr"; }
            Recorder = new AutoRequestRecorder(R.Service, R.View, null, () => R.Now);
            Transport = new IntegrationTransport((request, _) =>
            {
                lock (Urls) Urls.Add(request.Method + " " + request.RequestUri!.AbsolutePath);
                return Task.FromResult(Answer?.Invoke(request) ?? IntegrationTransport.Response("{}", 404));
            });
        }
        public Guid Person(string role)
        {
            var id = R.Add(role);
            Users.Setup(u => u.GetUserById(id)).Returns(new User(role.ToLowerInvariant(), "default", "default") { Id = id });
            return id;
        }
        public AutoMovieRequestService Movies(bool recorder = true) => new(Transport, F.Core.Logger, Users.Object, null!, recorder ? Recorder : null);
        public long Count(string sql) => R.Db.Read(c => { using var cmd = c.CreateCommand(); cmd.CommandText = sql; return Convert.ToInt64(cmd.ExecuteScalar(), System.Globalization.CultureInfo.InvariantCulture); });
        public void Dispose() { Transport.Dispose(); R.Dispose(); F.Dispose(); }
    }

    internal static HttpResponseMessage? Collection(HttpRequestMessage request, int tmdbStatus = 200)
        => request.RequestUri!.AbsolutePath switch
        {
            "/3/movie/123" => IntegrationTransport.Response("{\"belongs_to_collection\":{\"id\":9,\"name\":\"Saga\"}}", tmdbStatus),
            "/3/collection/9" => IntegrationTransport.Response(JsonSerializer.Serialize(new { parts = new object[] { new { id = 124, title = "Second", release_date = "2001-01-01" }, new { id = 123, title = "First", release_date = "2000-01-01" } } })),
            _ => null,
        };

    internal static Movie Watched() => new() { Id = Guid.NewGuid(), Name = "First", ProviderIds = new() { ["Tmdb"] = "123" }, RunTimeTicks = TimeSpan.FromMinutes(100).Ticks };

    [Theory]
    [InlineData("Member", "awaiting_approval", "pending", 0)]
    [InlineData("Kid", "awaiting_approval", "pending", 0)]
    [InlineData("Manager", "queued_outage", "queued", 1)]
    [InlineData("Admin", "queued_outage", "queued", 1)]
    public async Task WithPhaseThreeTheNextMovieBecomesAWantUnderPolicyAndAMembersAutomaticAskWaits(string role, string reason, string status, int jobs)
    {
        using var a = new Auto();
        a.Answer = r => Collection(r);
        var person = a.Person(role);
        var outcome = await a.Movies().CheckMovieForCollectionRequestAsync(Watched(), person);
        Assert.Equal((AutoRequestOutcomeKind.WantRecorded, reason, "movie:tmdb:124"), (outcome.Kind, outcome.Reason, outcome.TitleKey));
        var want = Assert.Single(a.R.Ledger.ForTitle("movie:tmdb:124"));
        Assert.Equal((person, status, outcome.WantId), (want.UserId, want.Status, want.Id));
        Assert.Equal(jobs, a.R.Ledger.ForWant(want.Id).Count);
        Assert.Equal(1, a.Count("SELECT COUNT(*) FROM wants WHERE origin_kind='automation' AND origin_source_id='auto_movie'"));
        Assert.DoesNotContain(a.Urls, u => u.Contains("/api/v1/", StringComparison.Ordinal));   // no Seerr at all in JE mode without Seerr

        // The same trigger again replays the first ask (no second want, no second charge).
        var again = await a.Movies().CheckMovieForCollectionRequestAsync(Watched(), person);
        Assert.Equal((AutoRequestOutcomeKind.WantRecorded, outcome.WantId), (again.Kind, again.WantId));
        Assert.Single(a.R.Ledger.ForTitle("movie:tmdb:124"));
    }

    [Fact]
    public async Task PolicyRefusalsLibraryCopiesAndDeclinedAsksAreDefinitiveNoops()
    {
        using var a = new Auto();
        a.Answer = r => Collection(r);
        var watcher = a.Person("Watcher");
        var refused = await a.Movies().CheckMovieForCollectionRequestAsync(Watched(), watcher);
        Assert.Equal((AutoRequestOutcomeKind.DefinitiveNoop, "requests_create_required"), (refused.Kind, refused.Reason));

        var member = a.Person("Member");
        var asked = await a.Movies().CheckMovieForCollectionRequestAsync(Watched(), member);
        Assert.Equal(200, a.R.Service.Close(asked.WantId!, a.R.Admin, "Not this one").HttpStatus);
        var declined = await a.Movies().CheckMovieForCollectionRequestAsync(Watched(), member);
        Assert.Equal((AutoRequestOutcomeKind.DefinitiveNoop, "previously_declined"), (declined.Kind, declined.Reason));

        var other = a.Person("Member");
        a.R.View.AddCopy(TitleKey.Parse("movie:tmdb:124")!, new JfCopy { ItemId = Guid.NewGuid(), Visible = true });
        var there = await a.Movies().CheckMovieForCollectionRequestAsync(Watched(), other);
        Assert.Equal((AutoRequestOutcomeKind.DefinitiveNoop, "already_available"), (there.Kind, there.Reason));

        a.F.Plugin.Configuration.ArrRequestBackend = "status_only";
        Assert.Equal("requests_off", (await a.Movies().CheckMovieForCollectionRequestAsync(Watched(), other)).Reason);
    }

    [Theory]
    [InlineData(500, AutoRequestOutcomeKind.PreparationFailed, "tmdb_unavailable")]
    [InlineData(404, AutoRequestOutcomeKind.DefinitiveNoop, "not_in_collection")]
    public async Task ATmdbFailureIsNeverNotInACollection(int status, AutoRequestOutcomeKind kind, string reason)
    {
        using var a = new Auto(seerr: true);
        a.F.Plugin.Configuration.ArrPhase3Enabled = false;   // the legacy Seerr path gets typed outcomes too
        a.Answer = r => Collection(r, status);
        var member = a.Person("Member");
        var outcome = await a.Movies(recorder: false).CheckMovieForCollectionRequestAsync(Watched(), member);
        Assert.Equal((kind, reason), (outcome.Kind, outcome.Reason));
        Assert.DoesNotContain(a.Urls, u => u.Contains("/api/v1/", StringComparison.Ordinal));

        a.Answer = r => r.RequestUri!.AbsolutePath == "/3/movie/123" ? IntegrationTransport.Response("{\"id\":123}") : null;
        Assert.Equal((AutoRequestOutcomeKind.DefinitiveNoop, "not_in_collection"), (await a.Movies(false).CheckMovieForCollectionRequestAsync(Watched(), member)) is var none ? (none.Kind, none.Reason) : default);

        // Seerr's collection can't be read: a failure, retried soon, not "last in the collection".
        a.Answer = r => r.RequestUri!.AbsolutePath == "/3/movie/123" ? Collection(r) : IntegrationTransport.Response("{\"message\":\"down\"}", 503);
        Assert.Equal((AutoRequestOutcomeKind.PreparationFailed, "seerr_unavailable"), (await a.Movies(false).CheckMovieForCollectionRequestAsync(Watched(), member)) is var down ? (down.Kind, down.Reason) : default);
    }

    [Theory]
    [InlineData(2)]   // pending in Seerr (a moved request stays pending there forever)
    [InlineData(3)]   // processing in Seerr
    public async Task OnTheLedgerSeerrsRequestedStatusDoesNotHideTheNextMovie(int seerrStatus)
    {
        using var a = new Auto(seerr: true);
        var status = seerrStatus;
        a.Answer = r => r.RequestUri!.AbsolutePath == "/api/v1/collection/9"
            ? IntegrationTransport.Response(JsonSerializer.Serialize(new { parts = new object[] { new { id = 123, title = "First", releaseDate = "2000-01-01" },
                new { id = 124, title = "Second", releaseDate = "2001-01-01", mediaInfo = new { status } } } }))
            : Collection(r);
        var member = a.Person("Member");
        var outcome = await a.Movies().CheckMovieForCollectionRequestAsync(Watched(), member);
        Assert.Equal((AutoRequestOutcomeKind.WantRecorded, "awaiting_approval", "movie:tmdb:124"), (outcome.Kind, outcome.Reason, outcome.TitleKey));
        Assert.Contains("GET /api/v1/collection/9", a.Urls);

        // Available in Seerr is still nothing to ask for.
        status = 5;
        var there = await a.Movies().CheckMovieForCollectionRequestAsync(Watched(), a.Person("Member"));
        Assert.Equal((AutoRequestOutcomeKind.DefinitiveNoop, "already_available"), (there.Kind, there.Reason));

        // Phase 3 off: Seerr's status still means someone already asked (the legacy path is unchanged).
        status = seerrStatus;
        a.F.Plugin.Configuration.ArrPhase3Enabled = false;
        var legacy = await a.Movies(recorder: false).CheckMovieForCollectionRequestAsync(Watched(), a.Person("Member"));
        Assert.Equal((AutoRequestOutcomeKind.DefinitiveNoop, "already_requested"), (legacy.Kind, legacy.Reason));
        Assert.Single(a.R.Ledger.ForTitle("movie:tmdb:124"));
    }

    [Fact]
    public async Task TheRolloutShadowOverrideStopsTheDirectSeerrPathWithPhaseThreeOffAndSendsNothing()
    {
        using var a = new Auto(seerr: true);
        a.Answer = r => r.RequestUri!.AbsolutePath == "/api/v1/collection/9"
            ? IntegrationTransport.Response(JsonSerializer.Serialize(new { parts = new object[] { new { id = 123, title = "First", releaseDate = "2000-01-01" }, new { id = 124, title = "Second", releaseDate = "2001-01-01" } } }))
            : r.Method == HttpMethod.Post && r.RequestUri.AbsolutePath == "/api/v1/request" ? IntegrationTransport.Response("{\"id\":1}", 201)
            : Collection(r);
        a.F.Plugin.Configuration.ArrPhase3Enabled = false;
        a.F.Plugin.Configuration.ArrAutomationShadowOverride = true;
        var member = a.Person("Member");
        var held = await a.Movies().CheckMovieForCollectionRequestAsync(Watched(), member);
        Assert.Equal((AutoRequestOutcomeKind.DefinitiveNoop, "shadow_override", "movie:tmdb:124"), (held.Kind, held.Reason, held.TitleKey));
        Assert.DoesNotContain(a.Urls, u => u == "POST /api/v1/request");
        Assert.Empty(a.R.Ledger.ForTitle("movie:tmdb:124"));

        // Override off: the existing direct Seerr request goes out as before.
        a.F.Plugin.Configuration.ArrAutomationShadowOverride = false;
        var other = a.Person("Member");
        var answer = a.Answer;
        a.Answer = r => r.RequestUri!.AbsolutePath == "/api/v1/user"
            ? IntegrationTransport.Response(JsonSerializer.Serialize(new { results = new object[] { new { id = 5, jellyfinUserId = other.ToString("N") } } }))
            : answer(r);
        var sent = await a.Movies().CheckMovieForCollectionRequestAsync(Watched(), other);
        Assert.Contains(a.Urls, u => u == "POST /api/v1/request");
        Assert.Equal(AutoRequestOutcomeKind.WantRecorded, sent.Kind);
    }

    // An administrator's save: Jellyfin replaces the configuration object, so a reference taken earlier goes stale.
    private static void SaveOverride(ApiPluginFixture f, bool on) => Save(f, c => c.ArrAutomationShadowOverride = on);

    internal static void Save(ApiPluginFixture f, Action<Jellyfin.Plugin.JellyfinEnhanced.Configuration.PluginConfiguration> change)
    {
        var copy = (Jellyfin.Plugin.JellyfinEnhanced.Configuration.PluginConfiguration)typeof(object).GetMethod("MemberwiseClone", System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic)!.Invoke(f.Plugin.Configuration, null)!;
        change(copy);
        f.Plugin.UpdateConfiguration(copy);
    }

    internal static HttpResponseMessage? SeerrShow(HttpRequestMessage request)
        => request.RequestUri!.AbsolutePath == "/api/v1/tv/42"
            ? IntegrationTransport.Response(JsonSerializer.Serialize(new { numberOfSeasons = 2, seasons = new object[] { new { seasonNumber = 1, episodeCount = 10, status = 5 }, new { seasonNumber = 2, episodeCount = 10, status = 1 } } }))
            : null;

    [Theory]
    [InlineData("movie", "lookup")]
    [InlineData("movie", "retry")]
    [InlineData("season", "lookup")]
    [InlineData("season", "retry")]
    public async Task TheRolloutShadowOverrideSavedWhileADirectSeerrSendWaitsStopsEveryPostIncludingTheNextUrl(string recipe, string when)
    {
        using var a = new Auto(seerr: true);
        a.F.Plugin.Configuration.ArrPhase3Enabled = false;
        a.F.Plugin.Configuration.JellyseerrUrls = "http://seerr.test,http://seerr2.test";
        var person = a.Person("Member");
        var posts = 0;
        a.Answer = r =>
        {
            var path = r.RequestUri!.AbsolutePath;
            if (path == "/api/v1/user")
            {
                // Saved on while the send is reading Seerr's accounts (after the override was checked).
                if (when == "lookup") SaveOverride(a.F, true);
                return IntegrationTransport.Response(JsonSerializer.Serialize(new { results = new object[] { new { id = 5, jellyfinUserId = person.ToString("N") } } }));
            }
            if (r.Method == HttpMethod.Post && path == "/api/v1/request")
            {
                posts++;
                // Saved on while the first Seerr URL's POST fails: the next URL is not tried.
                SaveOverride(a.F, true);
                return IntegrationTransport.Response("{\"message\":\"down\"}", 503);
            }
            if (path == "/api/v1/collection/9")
                return IntegrationTransport.Response(JsonSerializer.Serialize(new { parts = new object[] { new { id = 123, title = "First", releaseDate = "2000-01-01" }, new { id = 124, title = "Second", releaseDate = "2001-01-01" } } }));
            return SeerrShow(r) ?? Collection(r);
        };
        AutoRequestOutcome outcome;
        if (recipe == "movie") outcome = await a.Movies(recorder: false).CheckMovieForCollectionRequestAsync(Watched(), person);
        else
        {
            var (series, episode, library) = Show(9);
            var previous = BaseItem.LibraryManager;
            BaseItem.LibraryManager = library.Object;
            try { outcome = await new AutoSeasonRequestService(a.Transport, a.F.Core.Logger, a.Users.Object, null!, library.Object, a.Recorder).CheckEpisodeCompletionAsync(episode, person); }
            finally { BaseItem.LibraryManager = previous; }
        }
        Assert.Contains(a.Urls, u => u == "GET /api/v1/user");
        Assert.Equal(when == "lookup" ? 0 : 1, posts);
        Assert.Equal((AutoRequestOutcomeKind.DefinitiveNoop, "shadow_override"), (outcome.Kind, outcome.Reason));
        Assert.True(a.F.Plugin.Configuration.ArrAutomationShadowOverride);
    }

    // The recorder as the plugin builds it: modes, kills, consent and budgets decide once the engine applies.
    private static AutoRequestRecorder EngineRecorder(Auto a)
    {
        var store = new AutomationStore(a.R.Db);
        var budgets = new AutomationBudgets(a.R.Db, () => a.R.Policy.Configuration, () => a.R.Now);
        var eligibility = new AutomationEligibility(store, new IntegrationAutomationTests.Trust());
        return new AutoRequestRecorder(a.R.Service, a.R.View, null, () => a.R.Now, new AutomationDecider(a.R.Service, budgets, eligibility), store, new IntegrationAutomationTests.Consents());
    }

    private static void EngineOn(Jellyfin.Plugin.JellyfinEnhanced.Configuration.PluginConfiguration c, AutomationMode mode)
    {
        c.ArrPhase4Enabled = true;
        c.ArrPhase4AutomationEnabled = true;
        c.ArrAutomationRecipes = AutomationModes.Write(new Dictionary<string, AutomationRecipeSettings>
        {
            [AutomationRecipes.AutoMovie] = new() { Mode = AutomationModes.Name(mode) },
            [AutomationRecipes.AutoSeason] = new() { Mode = AutomationModes.Name(mode) },
        });
    }

    // 4a-security-r2-1: an old recipe running its direct Seerr path (phase 3 off, the engine's other switches and the
    // recipe's mode stored) while an administrator turns phase 3 on, during the account lookup or between two Seerr
    // addresses. The engine applies from then on: the attempt stops and starts again through the ledger under the
    // current rules (Shadow records only, Ask waits for an OK), and nothing is POSTed. Switching the recipe or Seerr off
    // stops it the same way.
    [Theory]
    [InlineData("movie", "lookup", "shadow")]
    [InlineData("movie", "retry", "shadow")]
    [InlineData("movie", "lookup", "ask")]
    [InlineData("movie", "retry", "off")]
    [InlineData("season", "lookup", "shadow")]
    [InlineData("season", "retry", "shadow")]
    [InlineData("season", "retry", "ask")]
    [InlineData("season", "lookup", "off")]
    public async Task TurningPhaseThreeOnWhileADirectSeerrSendWaitsSendsItThroughTheEngineInsteadOfPosting(string recipe, string when, string change)
    {
        using var a = new Auto(seerr: true);
        a.F.Plugin.Configuration.ArrPhase3Enabled = false;
        a.F.Plugin.Configuration.JellyseerrUrls = "http://seerr.test,http://seerr2.test";
        var mode = change == "ask" ? AutomationMode.Ask : AutomationMode.Shadow;
        EngineOn(a.F.Plugin.Configuration, mode);
        EngineOn(a.R.Policy.Configuration, mode);
        var recorder = EngineRecorder(a);
        var person = a.Person("Admin");
        var posts = 0;
        var saved = false;
        void Change()
        {
            if (saved) return;
            saved = true;
            Save(a.F, c =>
            {
                if (change == "off") { c.AutoMovieRequestEnabled = false; c.AutoSeasonRequestEnabled = false; }
                else c.ArrPhase3Enabled = true;
            });
        }
        a.Answer = r =>
        {
            var path = r.RequestUri!.AbsolutePath;
            if (path == "/api/v1/user")
            {
                if (when == "lookup") Change();
                return IntegrationTransport.Response(JsonSerializer.Serialize(new { results = new object[] { new { id = 5, jellyfinUserId = person.ToString("N") } } }));
            }
            if (r.Method == HttpMethod.Post && path == "/api/v1/request")
            {
                posts++;
                Change();
                return IntegrationTransport.Response("{\"message\":\"down\"}", 503);
            }
            if (path == "/api/v1/collection/9")
                return IntegrationTransport.Response(JsonSerializer.Serialize(new { parts = new object[] { new { id = 123, title = "First", releaseDate = "2000-01-01" }, new { id = 124, title = "Second", releaseDate = "2001-01-01" } } }));
            return SeerrShow(r) ?? Collection(r);
        };
        AutoRequestOutcome outcome;
        if (recipe == "movie") outcome = await new AutoMovieRequestService(a.Transport, a.F.Core.Logger, a.Users.Object, null!, recorder).CheckMovieForCollectionRequestAsync(Watched(), person);
        else
        {
            var (series, episode, library) = Show(9);
            var previous = BaseItem.LibraryManager;
            BaseItem.LibraryManager = library.Object;
            try { outcome = await new AutoSeasonRequestService(a.Transport, a.F.Core.Logger, a.Users.Object, null!, library.Object, recorder).CheckEpisodeCompletionAsync(episode, person); }
            finally { BaseItem.LibraryManager = previous; }
        }
        Assert.True(saved);
        Assert.Equal(when == "lookup" ? 0 : 1, posts);
        var key = recipe == "movie" ? "movie:tmdb:124" : "tv:tvdb:4242";
        var wants = a.R.Ledger.ForTitle(key).ToList();
        var decisions = a.Count("SELECT COUNT(*) FROM automation_decisions");
        switch (change)
        {
            case "shadow":
                // Recorded as a Shadow decision under the engine; no want, approval or job.
                Assert.Equal(AutoRequestOutcomeKind.DefinitiveNoop, outcome.Kind);
                Assert.StartsWith("shadow_", outcome.Reason, StringComparison.Ordinal);
                Assert.Empty(wants);
                Assert.Equal(1, decisions);
                break;
            case "ask":
                // An Admin's ask, which the old path would have sent at once, waits for an OK.
                Assert.Equal(AutoRequestOutcomeKind.WantRecorded, outcome.Kind);
                Assert.Equal("pending", Assert.Single(wants).Status);
                Assert.Equal(0, a.Count("SELECT COUNT(*) FROM jobs"));
                break;
            default:
                Assert.Equal((AutoRequestOutcomeKind.DefinitiveNoop, "disabled"), (outcome.Kind, outcome.Reason));
                Assert.Empty(wants);
                break;
        }
    }

    // 4a-B-r3-1 / 4a-security-r3-1: the old recipe's own enable switch turned off during its metadata lookups (TMDB's
    // collection or the series details) is read again before anything is recorded: with phase 3 on, by the recorder
    // (under the engine in Auto, or without it); with phase 3 off and the rollout Shadow override on, before the direct
    // Seerr path would record its Shadow decision. Nothing is recorded (no want, job or decision) and nothing is POSTed.
    [Theory]
    [InlineData("movie", "engine")]
    [InlineData("movie", "ledger")]
    [InlineData("movie", "direct_override")]
    [InlineData("season", "engine")]
    [InlineData("season", "ledger")]
    [InlineData("season", "direct_override")]
    public async Task AnOldRecipeSwitchedOffDuringItsLookupsRecordsNothing(string recipe, string path)
    {
        var direct = path == "direct_override";
        using var a = new Auto(seerr: direct);
        if (path == "engine")
        {
            EngineOn(a.F.Plugin.Configuration, AutomationMode.Auto);
            EngineOn(a.R.Policy.Configuration, AutomationMode.Auto);
        }
        if (direct)
        {
            a.F.Plugin.Configuration.ArrPhase3Enabled = false;
            a.F.Plugin.Configuration.ArrAutomationShadowOverride = true;
        }
        var recorder = path == "ledger" ? a.Recorder : EngineRecorder(a);
        var person = a.Person("Admin");
        var saved = false;
        a.Answer = r =>
        {
            var at = r.RequestUri!.AbsolutePath;
            if (!saved && at is "/3/movie/123" or "/3/tv/42" or "/api/v1/tv/42")
            {
                saved = true;
                Save(a.F, c => { c.AutoMovieRequestEnabled = false; c.AutoSeasonRequestEnabled = false; });
                IntegrationAutomationTests.Switch(a.R.Policy.Configuration, recipe == "movie" ? AutomationRecipes.AutoMovie : AutomationRecipes.AutoSeason, false);
            }
            if (at == "/api/v1/user")
                return IntegrationTransport.Response(JsonSerializer.Serialize(new { results = new object[] { new { id = 5, jellyfinUserId = person.ToString("N") } } }));
            if (at == "/api/v1/collection/9")
                return IntegrationTransport.Response(JsonSerializer.Serialize(new { parts = new object[] { new { id = 123, title = "First", releaseDate = "2000-01-01" }, new { id = 124, title = "Second", releaseDate = "2001-01-01" } } }));
            if (r.Method == HttpMethod.Post && at == "/api/v1/request") return IntegrationTransport.Response("{\"id\":1}", 201);
            return recipe == "movie" ? Collection(r) : SeerrShow(r) ?? TmdbShow(r);
        };
        AutoRequestOutcome outcome;
        if (recipe == "movie") outcome = await new AutoMovieRequestService(a.Transport, a.F.Core.Logger, a.Users.Object, null!, recorder).CheckMovieForCollectionRequestAsync(Watched(), person);
        else
        {
            var (_, episode, library) = Show(9);
            var previous = BaseItem.LibraryManager;
            BaseItem.LibraryManager = library.Object;
            try { outcome = await new AutoSeasonRequestService(a.Transport, a.F.Core.Logger, a.Users.Object, null!, library.Object, recorder).CheckEpisodeCompletionAsync(episode, person); }
            finally { BaseItem.LibraryManager = previous; }
        }
        Assert.True(saved);
        Assert.Equal((AutoRequestOutcomeKind.DefinitiveNoop, "disabled"), (outcome.Kind, outcome.Reason));
        Assert.Empty(a.R.Ledger.ForTitle(recipe == "movie" ? "movie:tmdb:124" : "tv:tvdb:4242"));
        Assert.Equal(0, a.Count("SELECT COUNT(*) FROM wants") + a.Count("SELECT COUNT(*) FROM jobs") + a.Count("SELECT COUNT(*) FROM automation_decisions"));
        Assert.DoesNotContain(a.Urls, u => u == "POST /api/v1/request");
    }

    internal static (Series Series, Episode Episode, Mock<ILibraryManager> Library) Show(int episode)
    {
        var series = new Series { Id = Guid.NewGuid(), Name = "Show", ProviderIds = new() { ["Tmdb"] = "42", ["Tvdb"] = "4242" } };
        var item = new Episode { Id = Guid.NewGuid(), Name = "Ep", SeriesId = series.Id, ParentIndexNumber = 1, IndexNumber = episode, RunTimeTicks = TimeSpan.FromMinutes(40).Ticks };
        var library = new Mock<ILibraryManager>();
        library.Setup(l => l.GetItemById(series.Id)).Returns(series);
        return (series, item, library);
    }

    private static HttpResponseMessage? TmdbShow(HttpRequestMessage request, int status = 200, bool seasonOne = true)
    {
        if (request.RequestUri!.AbsolutePath != "/3/tv/42") return null;
        var seasons = new List<object>();
        if (seasonOne) seasons.Add(new { season_number = 1, episode_count = 10 });
        seasons.Add(new { season_number = 2, episode_count = 10 });
        return IntegrationTransport.Response(JsonSerializer.Serialize(new { number_of_seasons = 2, seasons }), status);
    }

    [Fact]
    public async Task WithPhaseThreeTheNextSeasonBecomesAWantFromTmdbAndJellyfinWithoutSeerr()
    {
        using var a = new Auto();
        var (series, episode, library) = Show(9);
        var previous = BaseItem.LibraryManager;
        BaseItem.LibraryManager = library.Object;
        try
        {
            a.Answer = r => TmdbShow(r);
            var member = a.Person("Member");
            var service = new AutoSeasonRequestService(a.Transport, a.F.Core.Logger, a.Users.Object, null!, library.Object, a.Recorder);
            var outcome = await service.CheckEpisodeCompletionAsync(episode, member);
            Assert.Equal((AutoRequestOutcomeKind.WantRecorded, "awaiting_approval", "tv:tvdb:4242"), (outcome.Kind, outcome.Reason, outcome.TitleKey));
            var want = Assert.Single(a.R.Ledger.ForTitle("tv:tvdb:4242"));
            Assert.Equal(("seasons", "pending"), (want.Input.Scope, want.Status));
            Assert.Equal(new[] { 2 }, want.Input.Seasons);
            Assert.DoesNotContain(a.Urls, u => u.Contains("/api/v1/", StringComparison.Ordinal));

            // Season 2 already fully in the person's library: nothing to ask for.
            var other = a.Person("Member");
            var copy = Guid.NewGuid();
            a.R.View.AddCopy(TitleKey.Parse("tv:tvdb:4242")!, new JfCopy { ItemId = copy, Visible = true });
            for (var e = 1; e <= 10; e++) a.R.View.AddEpisode(copy, new JfEpisode { ItemId = Guid.NewGuid(), Season = 2, Episode = e });
            var there = await service.CheckEpisodeCompletionAsync(episode, other);
            Assert.Equal((AutoRequestOutcomeKind.DefinitiveNoop, "already_available"), (there.Kind, there.Reason));

            // Threshold not met yet (episode 3 of 10).
            var (_, early, _) = Show(3);
            early.SeriesId = series.Id;
            Assert.Equal("threshold_not_met", (await service.CheckEpisodeCompletionAsync(early, other)).Reason);

            // TMDB down: a failure (short retry), not "season unknown"; a season TMDB doesn't list: definitive.
            a.Answer = r => TmdbShow(r, 500);
            var fresh = new AutoSeasonRequestService(a.Transport, a.F.Core.Logger, a.Users.Object, null!, library.Object, a.Recorder);
            Assert.Equal((AutoRequestOutcomeKind.PreparationFailed, "details_unavailable"), (await fresh.CheckEpisodeCompletionAsync(episode, other)) is var down ? (down.Kind, down.Reason) : default);
            a.Answer = r => TmdbShow(r, seasonOne: false);
            var unknown = new AutoSeasonRequestService(a.Transport, a.F.Core.Logger, a.Users.Object, null!, library.Object, a.Recorder);
            Assert.Equal((AutoRequestOutcomeKind.DefinitiveNoop, "season_unknown"), (await unknown.CheckEpisodeCompletionAsync(episode, other)) is var gone ? (gone.Kind, gone.Reason) : default);
        }
        finally { BaseItem.LibraryManager = previous; }
    }

    private static PlaybackProgressEventArgs Progress(BaseItem item, Guid user, TimeSpan at)
        => new() { Item = item, PlaybackPositionTicks = at.Ticks, Session = new SessionInfo(Mock.Of<ISessionManager>(), NullLogger.Instance) { UserId = user, UserName = "viewer" } };

    private static async Task Until(Func<bool> condition)
    {
        for (var i = 0; i < 250 && !condition(); i++) await Task.Delay(20);
        Assert.True(condition());
    }

    [Fact]
    public async Task PlaybackEventsReachTheRecipeThroughTheGateAndEveryOutcomeIsLogged()
    {
        using var a = new Auto();
        var now = new DateTimeOffset(2026, 10, 14, 12, 0, 0, TimeSpan.Zero);
        var gate = new PlaybackTriggerGate(TimeSpan.FromHours(1), TimeSpan.FromMinutes(2), TimeSpan.FromMinutes(30), 100, () => now);
        var tmdbStatus = 500;
        a.Answer = r => Collection(r, tmdbStatus);
        var member = a.Person("Member");
        var sessions = new Mock<ISessionManager>();
        using var monitor = new AutoMovieRequestMonitor(sessions.Object, a.Movies(), a.F.Core.Logger, a.Recorder, gate);
        monitor.Initialize();
        var movie = Watched();
        a.F.Plugin.Configuration.AutoMovieRequestTriggerType = "OnMinutesWatched";
        a.F.Plugin.Configuration.AutoMovieRequestMinutesWatched = 20;

        sessions.Raise(s => s.PlaybackProgress += null, Progress(movie, member, TimeSpan.FromMinutes(5)));   // too early: no trigger
        sessions.Raise(s => s.PlaybackProgress += null, Progress(movie, member, TimeSpan.FromMinutes(25)));
        await Until(() => a.R.Ledger.AutomationLog().Count == 1);
        var failed = a.R.Ledger.AutomationLog().Single();
        Assert.Equal(("auto_movie", "preparation_failed", "tmdb_unavailable"), (failed.Recipe, failed.Outcome, failed.Reason));

        // A failure only backs off briefly; the cooldown starts after a definitive answer.
        Assert.True(gate.IsQuiet($"movie|{member:N}|{movie.Id:N}"));
        now = now.AddMinutes(3);
        tmdbStatus = 200;
        sessions.Raise(s => s.PlaybackProgress += null, Progress(movie, member, TimeSpan.FromMinutes(26)));
        await Until(() => a.R.Ledger.AutomationLog().Count == 2);
        var recorded = a.R.Ledger.AutomationLog().First();
        Assert.Equal(("want_recorded", "awaiting_approval", "movie:tmdb:124"), (recorded.Outcome, recorded.Reason, recorded.TitleKey));
        Assert.Equal(member.ToString("N"), recorded.UserId);
        var calls = a.Urls.Count;
        now = now.AddMinutes(59);
        sessions.Raise(s => s.PlaybackProgress += null, Progress(movie, member, TimeSpan.FromMinutes(27)));
        // Barrier, not a sleep: disposing the monitor closes the queue and waits for its worker to finish every
        // trigger it admitted, so a trigger the cooldown let through would have been looked up and logged by now.
        monitor.Dispose();
        Assert.Equal(calls, a.Urls.Count);                    // cooling down: nothing was looked up again
        Assert.Equal(2, a.R.Ledger.AutomationLog().Count);    // ...nor processed at all

        // The person is deleted: their automation log goes with them.
        a.R.Ledger.PurgeUser(member);
        Assert.Empty(a.R.Ledger.AutomationLog());
    }

    [Fact]
    public async Task TurningAutoMovieAndSeasonRequestsOnAppliesWithoutARestart()
    {
        using var a = new Auto();
        a.Answer = r => Collection(r, 200);
        a.F.Plugin.Configuration.AutoMovieRequestEnabled = false;
        a.F.Plugin.Configuration.AutoSeasonRequestEnabled = false;
        var member = a.Person("Member");
        var sessions = new Mock<ISessionManager>();
        var gate = new PlaybackTriggerGate(TimeSpan.FromHours(1), TimeSpan.FromMinutes(2), TimeSpan.FromMinutes(30), 100, () => DateTimeOffset.UtcNow);
        using var movies = new AutoMovieRequestMonitor(sessions.Object, a.Movies(), a.F.Core.Logger, a.Recorder, gate);
        using var seasons = new AutoSeasonRequestMonitor(sessions.Object, new AutoSeasonRequestService(a.Transport, a.F.Core.Logger, a.Users.Object, null!, Mock.Of<ILibraryManager>(), a.Recorder), a.F.Core.Logger, a.Recorder, gate);
        // Started while off (the server's start-up): they still listen, and act once turned on.
        movies.Initialize();
        seasons.Initialize();
        sessions.VerifyAdd(s => s.PlaybackProgress += It.IsAny<EventHandler<PlaybackProgressEventArgs>>(), Times.Exactly(2));
        sessions.VerifyAdd(s => s.PlaybackStopped += It.IsAny<EventHandler<PlaybackStopEventArgs>>(), Times.Once());
        var movie = Watched();
        a.F.Plugin.Configuration.AutoMovieRequestTriggerType = "OnMinutesWatched";
        a.F.Plugin.Configuration.AutoMovieRequestMinutesWatched = 20;
        sessions.Raise(s => s.PlaybackProgress += null, Progress(movie, member, TimeSpan.FromMinutes(25)));
        await Task.Delay(100);
        Assert.Empty(a.R.Ledger.AutomationLog());          // off: nothing

        a.F.Plugin.Configuration.AutoMovieRequestEnabled = true;
        sessions.Raise(s => s.PlaybackProgress += null, Progress(movie, member, TimeSpan.FromMinutes(26)));
        await Until(() => a.R.Ledger.AutomationLog().Count == 1);
        Assert.Equal("auto_movie", a.R.Ledger.AutomationLog().Single().Recipe);
        // Initialising again doesn't subscribe twice.
        movies.Initialize();
        sessions.VerifyAdd(s => s.PlaybackProgress += It.IsAny<EventHandler<PlaybackProgressEventArgs>>(), Times.Exactly(2));
    }

    [Fact]
    public void TheGateIsSingleFlightCoolsDownOnlyAfterDefinitiveOutcomesAndStaysBounded()
    {
        var now = DateTimeOffset.UnixEpoch;
        var gate = new PlaybackTriggerGate(TimeSpan.FromHours(1), TimeSpan.FromMinutes(2), TimeSpan.FromMinutes(10), 8, () => now);
        Assert.True(gate.TryBegin("k"));
        Assert.False(gate.TryBegin("k"));                     // single flight
        Assert.True(gate.IsQuiet("k"));
        gate.Complete("k", AutoRequestOutcome.Failed("tmdb_unavailable"));
        Assert.True(gate.IsQuiet("k"));
        now = now.AddMinutes(2).AddSeconds(1);
        Assert.True(gate.TryBegin("k"));                      // a failure backs off 2 minutes
        gate.Complete("k", AutoRequestOutcome.Failed("tmdb_unavailable"));
        now = now.AddMinutes(3);
        Assert.False(gate.TryBegin("k"));                     // then 4
        now = now.AddMinutes(1).AddSeconds(1);
        Assert.True(gate.TryBegin("k"));
        gate.Complete("k", AutoRequestOutcome.Failed("x")); now = now.AddMinutes(8).AddSeconds(1); Assert.True(gate.TryBegin("k"));
        gate.Complete("k", AutoRequestOutcome.Failed("x")); now = now.AddMinutes(10).AddSeconds(1); Assert.True(gate.TryBegin("k"));   // capped at 10
        gate.Complete("k", AutoRequestOutcome.Noop("not_in_collection"));
        now = now.AddMinutes(59);
        Assert.False(gate.TryBegin("k"));                     // definitive: an hour
        now = now.AddMinutes(2);
        Assert.True(gate.TryBegin("k"));
        gate.Complete("k", AutoRequestOutcome.Cancelled());
        Assert.False(gate.IsQuiet("k"));                      // a cancel forgets the key
        Assert.True(gate.TryBegin("k"));
        gate.Complete("k", AutoRequestOutcome.Recorded("queued_outage"));
        Assert.True(gate.IsQuiet("k"));

        // Bounded: idle keys are evicted, keys with work in flight never are.
        Assert.True(gate.TryBegin("busy"));
        for (var i = 0; i < 40; i++) { Assert.True(gate.TryBegin("x" + i)); gate.Complete("x" + i, AutoRequestOutcome.Noop("n")); }
        Assert.True(gate.Count <= 8);
        Assert.False(gate.TryBegin("busy"));
        Assert.True(gate.IsQuiet("x39"));
    }

    [Fact]
    public async Task TheQueueIsBoundedAndCountsWhatItRefuses()
    {
        var logs = new List<string>();
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var queue = new PlaybackTriggerChannel(4, async (t, _) => { entered.TrySetResult(); await release.Task; }, logs.Add);
        Assert.True(queue.TryWrite(new PlaybackTrigger("running", Guid.NewGuid(), null, new Movie())));
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        var accepted = Enumerable.Range(0, 10).Count(i => queue.TryWrite(new PlaybackTrigger("k" + i, Guid.NewGuid(), null, new Movie())));
        Assert.Equal(4, accepted);
        Assert.Equal(6, queue.Dropped);
        Assert.Equal(4, queue.Waiting);
        Assert.Single(logs);                                  // one line per burst of refusals
        Assert.Contains("4 triggers are already waiting", logs[0], StringComparison.Ordinal);
        release.SetResult();
    }

    private static string ThisFile([System.Runtime.CompilerServices.CallerFilePath] string path = "") => path;

    // The repository: above the build output, the working directory, or (build output elsewhere) this source file.
    internal static string Root([System.Runtime.CompilerServices.CallerFilePath] string here = "")
    {
        // From this source file: an output folder outside the repository (--artifacts-path) has it neither as
        // an ancestor nor as the test host's working directory.
        var root = new DirectoryInfo(Path.GetDirectoryName(ThisFile())!);
        while (root != null && !Directory.Exists(Path.Combine(root.FullName, "Jellyfin.Plugin.JellyfinEnhanced", "Services"))) root = root.Parent;
        root ??= string.IsNullOrEmpty(here) ? null : new FileInfo(here).Directory;
        while (root != null && !Directory.Exists(Path.Combine(root.FullName, "Jellyfin.Plugin.JellyfinEnhanced", "Services"))) root = root.Parent;
        Assert.NotNull(root);
        return root!.FullName;
    }

    internal static string Body(string source, string signature)
    {
        var start = source.IndexOf(signature, StringComparison.Ordinal);
        Assert.True(start >= 0, signature);
        var open = source.IndexOf('{', start);
        var depth = 0;
        for (var i = open; i < source.Length; i++)
        {
            if (source[i] == '{') depth++;
            else if (source[i] == '}' && --depth == 0) return source[open..(i + 1)];
        }
        throw new InvalidOperationException("unbalanced " + signature);
    }

    [Theory]
    [InlineData("AutoMovieRequestMonitor.cs", "private void OnPlaybackProgress(object? sender, PlaybackProgressEventArgs e)", "internal static PlaybackTrigger? Trigger(")]
    [InlineData("AutoSeasonRequestMonitor.cs", "private void OnPlaybackProgress(object? sender, PlaybackProgressEventArgs e)", "internal static PlaybackTrigger? StartedTrigger(")]
    [InlineData("AutoSeasonRequestMonitor.cs", "private void OnPlaybackStopped(object? sender, PlaybackStopEventArgs e)", "internal static PlaybackTrigger? StoppedTrigger(")]
    public void PlaybackHandlersOnlyHandOffInConstantTime(string file, string handler, string trigger)
    {
        var source = File.ReadAllText(Path.Combine(Root(), "Jellyfin.Plugin.JellyfinEnhanced", "Services", file));
        foreach (var body in new[] { Body(source, handler), Body(source, trigger) })
        {
            foreach (var banned in new[] { "await", "async", "Task.Run", ".Result", ".Wait(", "Http", "Async(", "_autoMovieRequestService", "_autoSeasonRequestService", "_logger", "lock (", "Thread.Sleep", "foreach", "while (" })
                Assert.DoesNotContain(banned, body, StringComparison.Ordinal);
        }
        Assert.Contains("_triggers.TryWrite(", Body(source, handler), StringComparison.Ordinal);
        Assert.Contains("_gate.IsQuiet(", Body(source, handler), StringComparison.Ordinal);
        Assert.DoesNotMatch(new Regex(@"\basync\s+void\b"), source);
        Assert.DoesNotContain("PlaybackWorkQueue", source, StringComparison.Ordinal);
    }
}
