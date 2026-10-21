using System.Text.Json;
using System.Text.Json.Nodes;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Controllers;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr.Live;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Rig = JE.Tests.IntegrationEditionAvailabilityTests.Rig;
using M = JE.Tests.IntegrationEditionMaskedTests;
using L = JE.Tests.IntegrationRequestLedgerTests;

namespace JE.Tests;

/// <summary>
/// Edition round 19, part A (D53: the server decides every press; exact destination identity). A season page's control
/// carries what it was drawn to do (its mode, the exact episodes and seasons, the copy it acts for, the edition and where
/// the request lands); the server works all of it out again, fresh, right before anything is recorded or sent (the viewer,
/// the copy binding and its mask, the destination, Seerr's own servers and partial-request setting read again), and refuses
/// any difference with a typed conflict that the page turns into a redraw and a message. Enumerated episodes are searched
/// as exactly those episodes.
/// </summary>
[Collection("Plugin singleton")]
public class IntegrationEditionPressTests
{
    private static readonly TitleKey Firefly = TitleKey.Parse("tv:tvdb:78874")!;

    /// <summary>
    /// One library with both Firefly folders (both Sonarrs link it): the 4K folder lacks E2, which the standard folder plays
    /// (the 4K page's "Missing in 4K" E2); the standard folder lacks E3, which the 4K folder plays (the standard page's
    /// "Missing in standard" E3). JE mode or Seerr mode (Seerr's servers: rig Sonarr is its standard default, rig Sonarr 4K its
    /// 4K default), with a ledger, the request service, the household Search and the administrator's Search behind their routes.
    /// </summary>
    internal sealed class PressRig : IDisposable
    {
        public Rig Rig { get; }
        public FakeSeerr? Seerr { get; }
        public ArrStatusService Status { get; }
        public L.Policy Policy { get; } = new();
        public AcquireDatabase Db { get; }
        public RequestLedger Ledger { get; }
        public RequestService Requests { get; }
        public ArrManageService Manage { get; }
        public RequestSearchService Search { get; }
        public ArrChangeFeed Feed { get; } = new();
        public PluginConfiguration Config => Rig.Arr.Plugin.Plugin.Configuration;
        public Guid FourKPage { get; }
        public Guid StandardPage { get; }
        private readonly FakeSeerr _hubSeerr = new();
        private readonly string _root = Path.Combine(Path.GetTempPath(), "je-press-" + Guid.NewGuid().ToString("N"));

        public PressRig(bool seerr, long seerrPermissions = 32 | 1024)
        {
            Rig = M.OneLibrary(grouped: false);
            Rig.Sonarr.Episodes.Add(M.Aired(103, 3));
            Rig.Sonarr4k!.Episodes.Add(M.Aired(103, 3));
            Rig.View.AddEpisodeFile(Rig.UhdCopy, Firefly, 1, 3, 3840, 2160, Rig.Now.AddDays(-1));
            Rig.Sonarr4k.Episodes.Single(e => (int)e["id"]! == 103)["hasFile"] = true;
            Config.ArrPhase3Enabled = true;
            Config.ArrManageDrawerEnabled = true;
            Config.ArrRequestBackend = seerr ? "seerr" : "je";
            Policy.Configuration.ArrRequestBackend = Config.ArrRequestBackend;
            Policy.Configuration.ArrManageDrawerEnabled = true;
            SeerrBackend? backend = null;
            if (seerr)
            {
                Config.JellyseerrEnabled = true;
                Config.JellyseerrUrls = FakeSeerr.Url;
                Config.JellyseerrApiKey = FakeSeerr.Key;
                Seerr = new FakeSeerr();
                Seerr.Users.Add(new JsonObject { ["id"] = 7, ["jellyfinUserId"] = Rig.Member.UserId.ToString("N"), ["permissions"] = seerrPermissions, ["displayName"] = "Emma" });
                Seerr.Settings["series4kEnabled"] = true;
                Seerr.SonarrServers = new JsonArray(FakeSeerr.Server(0, "sonarr.lan", 8989, is4k: false, isDefault: true), FakeSeerr.Server(1, "sonarr4k.lan", 8989, is4k: true, isDefault: true));
                var model = new SeerrRequestReadModel(Seerr.Transport, null, null, () => Config, () => Rig.Arr.Now);
                backend = new SeerrBackend(Seerr.Transport, model, null, () => Config, () => Rig.Arr.Now);
            }
            Func<PluginConfiguration?> config = () => Config;
            Func<DateTimeOffset> now = () => Rig.Arr.Now;
            Status = backend == null
                ? Wiring.Make<ArrStatusService>(Rig.Store, Rig.View, new NoRequestFacts(), config, now)
                : Wiring.Make<ArrStatusService>(Rig.Store, Rig.View, new NoRequestFacts(), config, now, backend);
            var sonarr = Rig.Arr.Instance("SonarrZ").Id;
            foreach (var (who, role) in new[] { (Rig.Member, "Member"), (Rig.Admin, "Admin") })
            {
                Policy.People[who.UserId] = new RequestPolicyFacts(who.UserId, role, true, role == "Admin", true, true, "p1", Config.ArrRequestBackend, seerr ? string.Empty : sonarr, seerr ? string.Empty : "g1",
                    7, 7, 0, "{}", SeerrSource: seerr ? "seerr|src" : null, SeerrUser: seerr ? 7 : null);
            }
            Directory.CreateDirectory(_root);
            Db = new AcquireDatabase(Path.Combine(_root, "acquire.db"));
            Ledger = new RequestLedger(Db);
            Requests = new RequestService(Ledger, Policy, Rig.View, Feed, now);
            var audit = new ArrAuditLog(Path.Combine(_root, "audit.jsonl"), 100000, 1);
            Manage = new ArrManageService(Status, Rig.Arr.Factory, new ArrActionRunner(audit, new ArrConfirmationTokens()), audit, new NoRequestFacts(), null, Feed, config, (_, _) => Task.CompletedTask);
            Search = new RequestSearchService(Requests, Manage, now);
            FourKPage = M.SeasonPage(Rig, Rig.UhdCopy);
            StandardPage = M.SeasonPage(Rig, Rig.HdCopy);
        }

        /// <summary>The season page as the viewer's browser reads it (the second read: the arr facts are in memory then).</summary>
        public async Task<JsonElement> Page(StatusViewer viewer, Guid id)
        {
            await Status.ForItemAsync(viewer, id, default);
            await Task.Delay(20);
            return Assert.Single(M.Items(await Status.ForItemAsync(viewer, id, default)));
        }

        public T Controller<T>(T controller, StatusViewer viewer) where T : ControllerBase
        {
            controller.ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext() };
            controller.HttpContext.User = TestCallers.Principal(viewer.UserId, viewer.IsAdmin);
            return controller;
        }

        public AcquireRequestsController Asks(StatusViewer viewer) => Controller(Wiring.Make<AcquireRequestsController>(Requests, Search, Status), viewer);

        public RequestsHubController Hub(StatusViewer viewer)
        {
            var hub = new RequestsHubService(Status, new SeerrRequestReadModel((Seerr ?? _hubSeerr).Transport, null, null, () => Config, () => Rig.Arr.Now), () => Config);
            return Controller(Wiring.Make<RequestsHubController>(hub, Manage), viewer);
        }

        public void Dispose()
        {
            Db.Dispose();
            Seerr?.Dispose();
            _hubSeerr.Dispose();
            Rig.Dispose();
            try { Directory.Delete(_root, true); } catch (IOException) { }
        }
    }

    /// <summary>What a control was drawn to do, as the page sends it with the press (see the client's press protocol).</summary>
    internal static JsonObject Intent(Guid page, string mode, int[] episodes, JsonElement? copy, string variant, string? instance = null, bool whole = false, int[]? seasons = null)
    {
        var bound = copy is { } c && c.ValueKind == JsonValueKind.Object;
        return new JsonObject
        {
            ["item"] = page.ToString("N"),
            ["mode"] = mode,
            ["episodes"] = new JsonArray(episodes.Select(e => (JsonNode)e).ToArray()),
            ["copy"] = bound ? copy!.Value.GetProperty("role").GetString() : null,
            ["variant"] = variant,
            ["dest"] = bound && copy!.Value.TryGetProperty("dest", out var dest) && dest.ValueKind == JsonValueKind.String ? dest.GetString() : null,
            ["instance"] = instance,
            ["whole"] = whole,
            ["seasons"] = seasons == null ? null : new JsonArray(seasons.Select(s => (JsonNode)s).ToArray()),
        };
    }

    internal static JsonElement? CopyOf(JsonElement season) => season.TryGetProperty("copy", out var copy) ? copy : null;

    /// <summary>An action result's HTTP status and its body as JSON.</summary>
    internal static (int Status, JsonElement Body) Read(IActionResult result)
    {
        var (status, value) = result switch
        {
            ObjectResult o => (o.StatusCode ?? 200, o.Value),
            _ => (500, (object?)null),
        };
        return (status, JsonSerializer.SerializeToElement(value));
    }

    internal static string? Code(JsonElement body)
        => body.TryGetProperty("reason", out var r) && r.ValueKind == JsonValueKind.String ? r.GetString()
            : body.TryGetProperty("code", out var c) && c.ValueKind == JsonValueKind.String ? c.GetString() : null;

    private static int Commands(FakeArr.Host host) => host.Writes.Count(w => w.Path == "/api/v3/command");

    /// <summary>The episode a control was drawn for now plays in its copy (it arrived after the page was drawn).</summary>
    private static void Arrives(PressRig p, Guid copy, int episode, bool fourK)
    {
        p.Rig.View.AddEpisodeFile(copy, Firefly, 1, episode, fourK ? 3840 : 1920, fourK ? 2160 : 1080, p.Rig.Now);
        p.Rig.View.Rev++;
    }

    // ------------------------------------------------------------------ ED-R17-1 / ED-R17-6: an ask goes only where it was drawn to go

    [Theory]
    [InlineData("unchanged")]      // control: it asks for exactly what it says ("Get Season 1" in 4K for the 4K copy)
    [InlineData("whole series")]   // ED-R17-1: Seerr took partial requests when drawn and takes the whole series only now
    [InlineData("4K default moved")] // ED-R17-6: Seerr's 4K default server moved to another Sonarr after the page was drawn
    [InlineData("arrived")]        // the episode the control was for plays in that copy now: there is nothing to ask for
    public async Task ASeerrAskTheSeasonPageWouldNoLongerDrawIsRefusedAndNothingIsRecorded(string change)
    {
        using var p = new PressRig(seerr: true);
        var page = await p.Page(p.Rig.Member, p.FourKPage);
        var copy = CopyOf(page);
        Assert.True(copy is { } k && k.GetProperty("role").GetString() == "4k" && k.GetProperty("ask").GetBoolean(), $"drawn binding {copy}");
        switch (change)
        {
            case "whole series": p.Seerr!.Settings["partialRequestsEnabled"] = false; break;
            case "4K default moved":
                p.Seerr!.SonarrServers = new JsonArray(FakeSeerr.Server(0, "sonarr.lan", 8989, false, true), FakeSeerr.Server(1, "sonarr4k.lan", 8989, true, false), FakeSeerr.Server(2, "sonarr4k-b.lan", 8989, true, true));
                break;
            case "arrived": Arrives(p, p.Rig.UhdCopy, 2, fourK: true); break;
        }
        var body = new JsonObject
        {
            ["clientRequestId"] = Guid.NewGuid().ToString("N"),
            ["input"] = new JsonObject { ["key"] = Firefly.ToString(), ["scope"] = "seasons", ["variant"] = "4k", ["seasons"] = new JsonArray(1), ["episodes"] = new JsonArray() },
            ["expect"] = Intent(p.FourKPage, "get", new[] { 2 }, copy, "4k", seasons: new[] { 1 }),
        };
        var (status, answer) = Read(await p.Asks(p.Rig.Member).Create(Wiring.Body<CreateRequest>(body.ToJsonString()), default));
        if (change == "unchanged")
        {
            Assert.True(status is 201 or 200, $"{status} {answer}");
            Assert.Single(p.Ledger.ForTitle(Firefly.ToString()));
            return;
        }
        Assert.True(status == 409 && Code(answer) == "press_changed", $"{change}: {status} {answer}");
        Assert.Empty(p.Ledger.ForTitle(Firefly.ToString()));
    }

    /// <summary>The routes a season page's press goes to, each with the control it was drawn as.</summary>
    public static TheoryData<string, bool> Routes() => new()
    {
        { "ask", false }, { "ask", true },
        { "household search", false }, { "household search", true },
        { "admin search", false }, { "admin search", true },
    };

    [Theory]
    [MemberData(nameof(Routes))]
    public async Task EveryPressRouteRefusesWhatTheSeasonPageWouldNoLongerDraw(string route, bool stale)
    {
        using var p = new PressRig(seerr: false);
        var viewer = route == "admin search" ? p.Rig.Admin : p.Rig.Member;
        // The ask and the administrator's Search act for the 4K copy's E2; a household Search for the standard copy's E3.
        var household = route == "household search";
        var pageId = household ? p.StandardPage : p.FourKPage;
        var episode = household ? 3 : 2;
        var page = await p.Page(viewer, pageId);
        var copy = CopyOf(page);
        Assert.True(copy is { } k && k.GetProperty("role").GetString() == (household ? "standard" : "4k"), $"drawn binding {copy}");
        if (stale) Arrives(p, household ? p.Rig.HdCopy : p.Rig.UhdCopy, episode, fourK: !household);
        var commands = Commands(p.Rig.Sonarr) + Commands(p.Rig.Sonarr4k!);
        IActionResult result;
        switch (route)
        {
            case "ask":
            {
                var body = new JsonObject
                {
                    ["clientRequestId"] = Guid.NewGuid().ToString("N"),
                    ["input"] = new JsonObject { ["key"] = Firefly.ToString(), ["scope"] = "episodes", ["variant"] = "4k", ["seasons"] = new JsonArray(), ["episodes"] = new JsonArray(new JsonObject { ["season"] = 1, ["episode"] = 2 }) },
                    ["expect"] = Intent(pageId, "get", new[] { 2 }, copy, "4k"),
                };
                result = await p.Asks(viewer).Create(Wiring.Body<CreateRequest>(body.ToJsonString()), default);
                break;
            }
            case "household search":
            {
                var body = new JsonObject { ["key"] = Firefly.WithEpisode(1, 3).ToString(), ["idempotencyKey"] = Guid.NewGuid().ToString("N"), ["expect"] = Intent(pageId, "search", new[] { 3 }, copy, "standard") };
                result = await p.Asks(viewer).Search(Wiring.Body<RequestSearchBody>(body.ToJsonString()), default);
                break;
            }
            default:
            {
                var instance = copy!.Value.GetProperty("instanceId").GetString();
                var body = new JsonObject
                {
                    ["instanceId"] = instance, ["key"] = Firefly.WithEpisode(1, 2).ToString(), ["idempotencyKey"] = Guid.NewGuid().ToString("N"),
                    ["expect"] = Intent(pageId, "search", new[] { 2 }, copy, "4k", instance: instance),
                };
                result = await p.Hub(viewer).Search(Wiring.Body<ManageSearchRequest>(body.ToJsonString()), default);
                break;
            }
        }
        var (status, answer) = Read(result);
        if (!stale)
        {
            Assert.True(Code(answer) != "press_changed" && status < 500, $"{route}, unchanged: {status} {answer}");
            return;
        }
        Assert.True(status == 409 && Code(answer) == "press_changed", $"{route}, stale: {status} {answer}");
        Assert.Empty(p.Ledger.ForTitle(Firefly.ToString()));
        Assert.Equal(commands, Commands(p.Rig.Sonarr) + Commands(p.Rig.Sonarr4k!));
    }

    // ------------------------------------------------------------------ ED-AX-4: a household Search never reuses candidates chosen before an await

    [Fact]
    public async Task AHouseholdSeasonSearchNeverSearchesACopyTheViewerLostWhileThePolicyWasPrepared()
    {
        using var rig = new IntegrationEditionAvailabilityTests.Rig(IntegrationEditionAvailabilityTests.Layout.SeparateLibraries, IntegrationEditionAvailabilityTests.Has.Uhd, false);
        var policy = new L.Policy();
        var instance = rig.Arr.Instance("SonarrZ").Id;
        policy.People[rig.Member.UserId] = new(rig.Member.UserId, "Member", true, false, false, true, "r1", "je", instance, "generation", 7, 7, 0, "null");
        var root = Path.Combine(rig.Arr.Plugin.Core.Root, "household-revoke-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        using var db = new AcquireDatabase(Path.Combine(root, "acquire.db"));
        var ledger = new RequestLedger(db);
        var feed = new ArrChangeFeed();
        var requests = new RequestService(ledger, policy, rig.View, feed, () => rig.Arr.Now);
        var audit = new ArrAuditLog(Path.Combine(root, "audit.jsonl"), 100000, 1);
        var manage = new ArrManageService(rig.Service, rig.Arr.Factory, new ArrActionRunner(audit, new ArrConfirmationTokens()), audit, new NoRequestFacts(), null, feed, () => rig.Arr.Plugin.Plugin.Configuration, (_, _) => Task.CompletedTask);
        var input = new MutationInput { Key = Firefly.ToString(), Scope = "seasons", Seasons = new[] { 1 } };
        Assert.Equal(201, (await requests.CreateAsync(rig.Member.UserId, new("household-ask", input), default)).HttpStatus);
        await new RequestOutbox(ledger, policy, new L.Backend(), new RequestTitleLocks(), feed, audit, () => rig.Arr.Now).TickAsync(default);
        Assert.Equal("sent", Assert.Single(ledger.ForTitle(Firefly.ToString())).Status);
        // The facts are warm, so the candidates would be ready at once.
        await rig.Service.SearchableEpisodesAsync(rig.Member, Firefly.WithSeason(1), 50, null, default);
        await Task.Delay(30);
        Assert.NotEmpty(await rig.Service.SearchableEpisodesAsync(rig.Member, Firefly.WithSeason(1), 50, null, default));
        // While the policy's facts are prepared, the viewer loses the copy those candidates belong to.
        StatusViewer? changed = null;
        policy.Before = async (_, _) => { await Task.Yield(); changed ??= rig.View.Revoke(rig.Member, parental: true, hide: rig.HdCopy); };
        var search = new RequestSearchService(requests, manage, () => rig.Arr.Now);
        var reply = await search.SearchAsync(rig.Member, Firefly.WithSeason(1).ToString(), "household-after-revoke", default);
        Assert.Empty(await rig.Service.SearchableEpisodesAsync(changed!, Firefly.WithSeason(1), 50, null, default));
        Assert.True(reply.Outcome.Reason != "searched", $"{reply.Outcome.HttpStatus} {reply.Outcome.Reason}");
        Assert.DoesNotContain(rig.Sonarr.Writes, w => w.Path == "/api/v3/command");
        try { Directory.Delete(root, true); } catch (IOException) { }
    }

    // ------------------------------------------------------------------ ED-AX-7: enumerated episodes are searched as exactly those episodes

    [Fact]
    public async Task AnAdministratorsSearchForSomeEpisodesOfASeasonSearchesExactlyThoseEpisodes()
    {
        using var p = new PressRig(seerr: false);
        p.Rig.Sonarr4k!.Episodes.Add(M.Aired(104, 4));
        var page = await p.Page(p.Rig.Admin, p.FourKPage);
        var copy = CopyOf(page);
        var instance = copy!.Value.GetProperty("instanceId").GetString();
        var body = new JsonObject
        {
            ["instanceId"] = instance, ["key"] = Firefly.WithSeason(1).ToString(), ["idempotencyKey"] = Guid.NewGuid().ToString("N"),
            ["episodes"] = new JsonArray(2, 4),
            ["expect"] = Intent(p.FourKPage, "search", new[] { 2, 4 }, copy, "4k", instance: instance),
        };
        var (status, answer) = Read(await p.Hub(p.Rig.Admin).Search(Wiring.Body<ManageSearchRequest>(body.ToJsonString()), default));
        Assert.True(status == 200, $"{status} {answer}");
        var command = JsonNode.Parse(Assert.Single(p.Rig.Sonarr4k.Writes, w => w.Path == "/api/v3/command").Body)!;
        Assert.Equal("EpisodeSearch", (string?)command["name"]);
        Assert.Equal(new[] { 102, 104 }, command["episodeIds"]!.AsArray().Select(n => (int)n!).OrderBy(n => n).ToArray());
    }

    // ------------------------------------------------------------------ ED-R17-6: the Seerr transport sends only to the server the ask was proven for

    [Theory]
    [InlineData("default kept", 32 | 4096, true, false)]   // control: Seerr's 4K default is still the proven server; no server named
    [InlineData("default moved", 32 | 4096, false, false)] // ED-R17-6: it moved to another Sonarr; nothing is sent
    [InlineData("default moved, may choose", 32 | 4096 | 8192, true, true)] // an account Seerr lets choose: sent to the proven server by name
    [InlineData("server gone", 32 | 4096 | 8192, false, false)] // the proven server isn't one of Seerr's any more: nothing is sent
    public async Task ASeerrSendGoesOnlyToTheServerTheAskWasProvenFor(string seerrSide, long permissions, bool sent, bool named)
    {
        using var lab = new IntegrationRequestBackendsTests.SeerrLab(permissions);
        lab.Seerr.Settings["series4kEnabled"] = true;
        lab.Seerr.Shows[1731] = new JsonObject { ["id"] = 1731, ["seasons"] = new JsonArray(new JsonObject { ["seasonNumber"] = 1 }), ["mediaInfo"] = new JsonObject { ["status"] = 1, ["status4k"] = 1, ["seasons"] = new JsonArray(), ["requests"] = new JsonArray() } };
        var std = FakeSeerr.Server(0, "sonarr.lan", 8989, false, true);
        lab.Seerr.SonarrServers = seerrSide switch
        {
            "default kept" => new JsonArray(std, FakeSeerr.Server(1, "sonarr4k.lan", 8989, true, true), FakeSeerr.Server(2, "sonarr4k-b.lan", 8989, true, false)),
            "server gone" => new JsonArray(std, FakeSeerr.Server(2, "sonarr4k-b.lan", 8989, true, true)),
            _ => new JsonArray(std, FakeSeerr.Server(1, "sonarr4k.lan", 8989, true, false), FakeSeerr.Server(2, "sonarr4k-b.lan", 8989, true, true)),
        };
        var job = lab.Job(new MutationInput { Key = "tv:tmdb:1731", Scope = "seasons", Seasons = new[] { 1 }, Variant = "4k" });
        // Proven at the press: Seerr's server 1 (rig Sonarr 4K) is the copy's.
        job = job with { Authorization = Wiring.With(job.Authorization, "SeerrServer", 1) };
        var result = await lab.Backend.SendAsync(job, () => null, default);
        if (!sent)
        {
            Assert.Empty(lab.Seerr.Posts);
            Assert.Equal("destination_changed", result.Outcome.Reason);
            return;
        }
        var (_, _, posted) = Assert.Single(lab.Seerr.Posts);
        Assert.True((bool)posted["is4k"]!);
        if (named) Assert.Equal(1, (int?)posted["serverId"]);
        else Assert.False(posted.ContainsKey("serverId"), posted.ToJsonString());
    }

    // ------------------------------------------------------------------ ED-R17-7: exact destination identity

    [Theory]
    [InlineData("http://Sonarr.LAN:8989/sonarr", "http://sonarr.lan:8989/sonarr", true)]   // host: case-insensitive
    [InlineData("HTTP://sonarr.lan:8989", "http://sonarr.lan:8989", true)]                 // scheme: case-insensitive
    [InlineData("http://sonarr.lan", "http://sonarr.lan:80", true)]                         // the default port, written or not
    [InlineData("https://sonarr.lan:443/s", "https://sonarr.lan/s", true)]
    [InlineData("http://sonarr.lan:8989/sonarr/", "http://sonarr.lan:8989/sonarr", true)]  // a trailing slash
    [InlineData("http://sonarr.lan:8989/", "http://sonarr.lan:8989", true)]
    [InlineData("http://sonarr.lan:8989/sonarr//", "http://sonarr.lan:8989/sonarr", true)]
    [InlineData("http://sonarr.lan:8989/Sonarr", "http://sonarr.lan:8989/sonarr", false)]  // ED-R17-7: a base path is case-sensitive
    [InlineData("http://sonarr.lan:8989/sonarr4k", "http://sonarr.lan:8989/sonarr", false)]
    [InlineData("http://sonarr.lan:8989", "https://sonarr.lan:8989", false)]                // another scheme
    [InlineData("http://sonarr.lan:8989", "http://sonarr.lan:8990", false)]                 // another port
    [InlineData("http://sonarr.lan:80", "https://sonarr.lan:443", false)]                   // each one's default port, but another scheme
    [InlineData("http://sonarr.lan:8989", "http://sonarr-b.lan:8989", false)]               // another host
    [InlineData("not a url", "http://sonarr.lan:8989", false)]
    public void TwoArrAddressesAreOneServerOnlyWhenSchemeHostPortAndBasePathAllMatch(string a, string b, bool same)
    {
        Assert.Equal(same, ArrStatusService.SameAddress(a, b));
        Assert.Equal(same, ArrStatusService.SameAddress(b, a));
    }
}
