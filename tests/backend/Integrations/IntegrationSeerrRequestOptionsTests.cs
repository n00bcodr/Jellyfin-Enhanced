using System.Text;
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

namespace JE.Tests;

/// <summary>
/// Administrator Seerr request options (phase 4b): an administrator picks Seerr's server, quality profile and root
/// folder for a Seerr-mode request through the ledger and outbox. The input keeps old fingerprints; only Jellyfin
/// administrators with Seerr's advanced-request permission may choose, with the switch on; the choice is checked
/// against Seerr's servers when asked, approved and right before the POST (typed holds, never Seerr's defaults); the
/// read-back must show it; Family answers never carry it; and the administrators' route lists the options without
/// any address or key. Production policy, backend router, Seerr backend, ledger and outbox over a synthetic Seerr.
/// </summary>
[Collection("Plugin singleton")]
public class IntegrationSeerrRequestOptionsTests
{
    private const string Title = "movie:tmdb:603";

    internal sealed class Rig : IDisposable
    {
        public IntegrationRequestBackendsTests.SeerrLab Lab { get; } = new();
        public FakeJellyfinView View { get; } = new();
        public StatusViewer Admin { get; }
        public StatusViewer Kid { get; }
        public StatusViewer Manager { get; }
        public AcquireDatabase Db { get; }
        public RequestLedger Ledger { get; }
        public SeerrBackend Seerr { get; }
        public RequestPolicy Policy { get; }
        public RequestService Service { get; }
        public RequestOutbox Outbox { get; }
        public PluginConfiguration Config => Lab.Config;
        public FakeSeerr Fake => Lab.Seerr;

        public Rig(long adminPermissions = 2, long kidPermissions = 32)
        {
            Config.ArrRequestBackend = "seerr";
            Config.ArrPhase4Enabled = true;
            Config.ArrPhase4SeerrRequestOptionsEnabled = true;
            Admin = View.AddUser(true);
            Kid = View.AddUser(false);
            Manager = View.AddUser(false);
            Config.ArrRequestUsers = JsonSerializer.Serialize(new Dictionary<string, object>
            {
                [Kid.UserId.ToString("N")] = new { Role = "Kid" },
                [Manager.UserId.ToString("N")] = new { Role = "Manager" },
            });
            Fake.Users.Add(new JsonObject { ["id"] = 9, ["jellyfinUserId"] = Admin.UserId.ToString("N"), ["permissions"] = adminPermissions, ["displayName"] = "Admin" });
            Fake.Users.Add(new JsonObject { ["id"] = 10, ["jellyfinUserId"] = Kid.UserId.ToString("N"), ["permissions"] = kidPermissions, ["displayName"] = "Kid" });
            Fake.Users.Add(new JsonObject { ["id"] = 11, ["jellyfinUserId"] = Manager.UserId.ToString("N"), ["permissions"] = 32 | 16 | 8192, ["displayName"] = "Manager" });
            Servers(Fake);
            var aliases = new TitleAliases(Lab.Arr.Store, null);
            Db = new AcquireDatabase(Path.Combine(Lab.Arr.Arr.Plugin.Core.Root, "seerr-options.db"));
            Ledger = new RequestLedger(Db);
            Seerr = new SeerrBackend(Fake.Transport, Lab.Model, aliases, () => Config, () => Lab.Now, Ledger.BindSeerrSend);
            var router = new RequestBackendRouter(Lab.Arr.Direct, Seerr, () => Config);
            Policy = new RequestPolicy(View, Lab.Arr.Store, new ArrInstanceLibraries(Lab.Arr.Store, new FakeLibraryAccess()), aliases, null!, Lab.Arr.Arr.Factory, router);
            var audit = new ArrAuditLog(Path.Combine(Lab.Arr.Arr.Plugin.Core.Root, "seerr-options-audit.jsonl"), 100000, 1);
            Service = new RequestService(Ledger, Policy, View, new ArrChangeFeed(), () => Lab.Now, aliases);
            Outbox = new RequestOutbox(Ledger, Policy, router, new RequestTitleLocks(), new ArrChangeFeed(), audit, () => Lab.Now);
        }

        /// <summary>The options stamp of one of Seerr's servers as the administrators' route gives it.</summary>
        public async Task<string> Stamp(int server, bool movie = true)
            => (await Seerr.RequestOptionsAsync(movie, default))!.Single(s => s.Id == server).Options;

        public Task<RequestOutcome> Ask(StatusViewer who, MutationInput input) => Service.CreateAsync(who.UserId, new(Guid.NewGuid().ToString("N"), input), default);

        public AcquireSeerrOptionsController Controller(System.Security.Claims.ClaimsPrincipal caller)
        {
            var controller = new AcquireSeerrOptionsController(Seerr, Policy, View) { ControllerContext = new() { HttpContext = new DefaultHttpContext() } };
            controller.HttpContext.User = caller;
            return controller;
        }

        public void Dispose()
        {
            Db.Dispose();
            Lab.Dispose();
        }
    }

    // Seerr has three Radarr servers (standard default, a second standard one for kids, a 4K one) and one Sonarr. The
    // details carry the address and key Seerr knows them by, which must never leave the plugin.
    private static void Servers(FakeSeerr seerr)
    {
        static JsonObject Server(int id, string name, bool is4k, bool isDefault, int profile, string directory)
            => new() { ["id"] = id, ["name"] = name, ["is4k"] = is4k, ["isDefault"] = isDefault, ["activeProfileId"] = profile, ["activeDirectory"] = directory, ["activeTags"] = new JsonArray() };
        static JsonObject Details(JsonObject server, (int Id, string Name)[] profiles, params string[] roots)
            => new()
            {
                ["server"] = new JsonObject { ["id"] = server["id"]!.DeepClone(), ["name"] = server["name"]!.DeepClone(), ["hostname"] = "radarr-secret-host.lan", ["port"] = 7878, ["apiKey"] = "ARR-SECRET-KEY" },
                ["profiles"] = new JsonArray(profiles.Select(p => (JsonNode)new JsonObject { ["id"] = p.Id, ["name"] = p.Name }).ToArray()),
                ["rootFolders"] = new JsonArray(roots.Select((r, i) => (JsonNode)new JsonObject { ["id"] = i + 1, ["path"] = r, ["freeSpace"] = 1_000_000 }).ToArray()),
                ["tags"] = new JsonArray(),
            };
        var radarr = new[] { Server(0, "Radarr", false, true, 4, "/movies"), Server(1, "Radarr Kids", false, false, 6, "/kids"), Server(2, "Radarr 4K", true, true, 5, "/movies4k") };
        seerr.Services["radarr"] = new JsonArray(radarr.Select(s => (JsonNode)s.DeepClone()).ToArray());
        seerr.ServiceDetails["radarr/0"] = Details(radarr[0], new[] { (4, "HD-1080p"), (5, "Ultra-HD") }, "/movies");
        seerr.ServiceDetails["radarr/1"] = Details(radarr[1], new[] { (4, "HD-1080p"), (6, "Kids") }, "/kids", "/kids-extra");
        seerr.ServiceDetails["radarr/2"] = Details(radarr[2], new[] { (5, "Ultra-HD") }, "/movies4k");
        var sonarr = Server(0, "Sonarr", false, true, 4, "/tv");
        seerr.Services["sonarr"] = new JsonArray(sonarr.DeepClone());
        seerr.ServiceDetails["sonarr/0"] = Details(sonarr, new[] { (4, "HD-1080p") }, "/tv");
    }

    private static MutationInput Choice(string stamp, int server = 1, int profile = 6, string root = "/kids", string variant = "standard", string key = Title)
        => new() { Key = key, Variant = variant, SeerrServerId = server, SeerrProfileId = profile, SeerrRootFolder = root, SeerrOptions = stamp };

    private static JsonObject Radarr(FakeSeerr seerr, int id) => seerr.Services["radarr"].Single(s => (int)s!["id"]! == id)!.AsObject();

    // ------------------------------------------------------------------ the input

    [Fact]
    public void AnInputWithoutSeerrOptionsSerializesAndFingerprintsExactlyAsBefore()
    {
        // The canonical JSON stored for every request before Seerr options existed.
        const string before = "{\"Key\":\"movie:tmdb:603\",\"Scope\":\"movie\",\"Variant\":\"standard\",\"Seasons\":[],\"Episodes\":[],\"InstanceId\":null,\"ProfileId\":null,\"RootFolder\":null}";
        var input = new MutationInput { Key = Title }.Normalize()!;
        Assert.Equal(before, input.Canonical);
        Assert.Equal(MutationInput.Hash(before), input.Fingerprint);
        // A stored row reads back to the same fingerprint, and an arr-routed one keeps its own too.
        Assert.Equal(input.Fingerprint, JsonSerializer.Deserialize<MutationInput>(before)!.Fingerprint);
        var routed = new MutationInput { Key = "tv:tvdb:78874", Scope = "seasons", Seasons = new[] { 2, 1 }, InstanceId = "abc", ProfileId = 4, RootFolder = "/data/tv" }.Normalize()!;
        Assert.Equal("{\"Key\":\"tv:tvdb:78874\",\"Scope\":\"seasons\",\"Variant\":\"standard\",\"Seasons\":[1,2],\"Episodes\":[],\"InstanceId\":\"abc\",\"ProfileId\":4,\"RootFolder\":\"/data/tv\"}", routed.Canonical);
        // With Seerr options the choice is part of the stored input and its fingerprint.
        var chosen = Choice("ABC").Normalize()!;
        Assert.Contains("\"SeerrServerId\":1", chosen.Canonical);
        Assert.Contains("\"SeerrOptions\":\"ABC\"", chosen.Canonical);
        Assert.NotEqual(input.Fingerprint, chosen.Fingerprint);
        Assert.NotEqual(chosen.Fingerprint, (Choice("ABC") with { SeerrRootFolder = "/kids-extra" }).Normalize()!.Fingerprint);
    }

    public static TheoryData<string, bool> Inputs => new()
    {
        { "valid", true },
        { "server 0", true },
        { "windows root", true },
        { "server only", false },
        { "no stamp", false },
        { "no root", false },
        { "negative server", false },
        { "profile 0", false },
        { "relative root", false },
        { "dot-dot root", false },
        { "long root", false },
        { "blank root", false },
        { "long stamp", false },
        { "stamp with space", false },
        { "mixed with arr routing", false },
    };

    [Theory]
    [MemberData(nameof(Inputs))]
    public void SeerrOptionsAreAllOrNothingAndBounded(string shape, bool valid)
    {
        var input = Choice("0123456789ABCDEF");
        input = shape switch
        {
            "server 0" => input with { SeerrServerId = 0 },
            "windows root" => input with { SeerrRootFolder = "D:\\Media\\Movies" },
            "server only" => new MutationInput { Key = Title, SeerrServerId = 1 },
            "no stamp" => input with { SeerrOptions = null },
            "no root" => input with { SeerrRootFolder = null },
            "negative server" => input with { SeerrServerId = -1 },
            "profile 0" => input with { SeerrProfileId = 0 },
            "relative root" => input with { SeerrRootFolder = "media/movies" },
            "dot-dot root" => input with { SeerrRootFolder = "/media/../etc" },
            "long root" => input with { SeerrRootFolder = "/" + new string('a', 1024) },
            "blank root" => input with { SeerrRootFolder = "   " },
            "long stamp" => input with { SeerrOptions = new string('A', 129) },
            "stamp with space" => input with { SeerrOptions = "AB CD" },
            "mixed with arr routing" => input with { ProfileId = 4 },
            _ => input,
        };
        Assert.Equal(valid, input.Normalize() != null);
    }

    // ------------------------------------------------------------------ who may choose

    [Fact]
    public async Task OnlyAJellyfinAdministratorMayChooseSeerrOptionsWhenAskingPreviewingOrApproving()
    {
        using var r = new IntegrationRequestLedgerTests.Rig();
        r.Policy.Configuration.ArrRequestBackend = "seerr";
        var choice = Choice("STAMP");
        foreach (var person in new[] { r.Member, r.Manager, r.Kid })
        {
            Assert.Equal(("admin_required", 403), ((await r.Create(person, choice)).Reason, (await r.Create(person, choice)).HttpStatus));
            Assert.Equal("admin_required", (await r.Service.PreviewAsync(person, new("p", choice), default)).Outcome.Reason);
        }
        // A Manager may approve a Kid's ask, but not choose Seerr options while doing so.
        var ask = await r.Create(r.Kid);
        Assert.Equal("admin_required", (await r.Service.ApproveAsync(ask.RequestId!, r.Manager, new ApproveRequest(choice with { Key = Movie().Key }), default)).Reason);
        Assert.Empty(r.Ledger.Due(r.Now));
        Assert.Equal(0, r.Backend.Sends);
    }

    private static MutationInput Movie() => IntegrationRequestLedgerTests.Movie();

    [Fact]
    public async Task AnAdministratorsValidChoiceIsSentToSeerrAndPersistedOnTheJob()
    {
        using var rig = new Rig();
        var stamp = await rig.Stamp(1);
        var ask = await rig.Ask(rig.Admin, Choice(stamp));
        Assert.True(ask.HttpStatus == 201, ask.Reason + ": " + ask.Message);
        var job = Assert.Single(rig.Ledger.ForWant(ask.RequestId!));
        Assert.Equal((1, 6, "/kids", stamp), (job.Input.SeerrServerId, job.Input.SeerrProfileId, job.Input.SeerrRootFolder, job.Input.SeerrOptions));
        Assert.Equal(job.Input.Fingerprint, job.Fingerprint);
        Assert.Equal(stamp, rig.Ledger.Find(ask.RequestId!)!.Input.SeerrOptions);
        await rig.Outbox.TickAsync(default);
        var (_, user, body) = Assert.Single(rig.Fake.Posts);
        Assert.Equal("9", user);
        Assert.Equal(("movie", 603, false), ((string)body["mediaType"]!, (int)body["mediaId"]!, (bool)body["is4k"]!));
        Assert.Equal((1, 6, "/kids"), ((int)body["serverId"]!, (int)body["profileId"]!, (string)body["rootFolder"]!));
        Assert.Equal("succeeded", Assert.Single(rig.Ledger.ForWant(ask.RequestId!)).State);
        Assert.Equal("sent", rig.Ledger.Find(ask.RequestId!)!.Status);
    }

    [Fact]
    public async Task A4kChoiceGoesToSeerrs4kServerAndASeriesToItsSonarr()
    {
        using var rig = new Rig();
        rig.Config.ArrRequest4kMoviesEnabled = true;
        rig.Fake.Settings["movie4kEnabled"] = true;
        rig.Fake.Settings["enableSpecialEpisodes"] = false;
        rig.Fake.Shows[1731] = new JsonObject { ["id"] = 1731, ["seasons"] = new JsonArray(new JsonObject { ["seasonNumber"] = 1 }) };
        var fourK = await rig.Ask(rig.Admin, Choice(await rig.Stamp(2), server: 2, profile: 5, root: "/movies4k", variant: "4k"));
        Assert.True(fourK.HttpStatus == 201, fourK.Reason);
        var series = await rig.Ask(rig.Admin, new MutationInput { Key = "tv:tmdb:1731", Scope = "seasons", Seasons = new[] { 1 }, SeerrServerId = 0, SeerrProfileId = 4, SeerrRootFolder = "/tv", SeerrOptions = await rig.Stamp(0, movie: false) });
        Assert.True(series.HttpStatus == 201, series.Reason);
        await rig.Outbox.TickAsync(default);
        Assert.Equal(2, rig.Fake.Posts.Count);
        var movie = rig.Fake.Posts.Single(p => (string)p.Body["mediaType"]! == "movie").Body;
        Assert.Equal((true, 2, 5, "/movies4k"), ((bool)movie["is4k"]!, (int)movie["serverId"]!, (int)movie["profileId"]!, (string)movie["rootFolder"]!));
        var tv = rig.Fake.Posts.Single(p => (string)p.Body["mediaType"]! == "tv").Body;
        Assert.Equal((0, 4, "/tv", "1"), ((int)tv["serverId"]!, (int)tv["profileId"]!, (string)tv["rootFolder"]!, string.Join(",", tv["seasons"]!.AsArray().Select(n => (int)n!))));
        Assert.All(rig.Ledger.ForTitle(Title).Concat(rig.Ledger.ForTitle("tv:tmdb:1731")), w => Assert.Equal("sent", w.Status));
    }

    [Theory]
    [InlineData("switch off", "seerr_options_disabled", 403)]
    [InlineData("no advanced permission", "seerr_advanced_required", 403)]
    [InlineData("old stamp", "seerr_options_changed", 409)]
    [InlineData("server gone", "seerr_options_changed", 409)]
    [InlineData("profile of another server", "seerr_options_invalid", 400)]
    [InlineData("folder of another server", "seerr_options_invalid", 400)]
    [InlineData("4k ask on a standard server", "seerr_options_invalid", 400)]
    [InlineData("jellyfin enhanced handles requests", "invalid_defaults", 400)]
    [InlineData("seerr servers unreadable", "backend_unavailable", 503)]
    public async Task AChoiceThatCantBeHonouredNowIsRefusedWithItsReasonAndNothingIsRecorded(string change, string reason, int status)
    {
        using var rig = new Rig(adminPermissions: change == "no advanced permission" ? 32 : 2);
        rig.Config.ArrRequest4kMoviesEnabled = true;
        rig.Fake.Settings["movie4kEnabled"] = true;
        var stamp = await rig.Stamp(1);
        var input = Choice(stamp);
        switch (change)
        {
            case "switch off": rig.Config.ArrPhase4SeerrRequestOptionsEnabled = false; break;
            case "old stamp": input = input with { SeerrOptions = "0123456789ABCDEF" }; break;
            case "server gone": input = input with { SeerrServerId = 7 }; break;
            case "profile of another server": input = input with { SeerrProfileId = 5 }; break;
            case "folder of another server": input = input with { SeerrRootFolder = "/movies" }; break;
            case "4k ask on a standard server": input = input with { Variant = "4k" }; break;
            case "jellyfin enhanced handles requests": rig.Config.ArrRequestBackend = "je"; break;
            case "seerr servers unreadable":
                rig.Lab.Now = rig.Lab.Now.AddMinutes(2);   // what was read has expired
                rig.Fake.BeforeRequest = uri => uri.AbsolutePath.StartsWith("/api/v1/service/", StringComparison.Ordinal)
                    ? Task.FromException(new HttpRequestException(HttpRequestError.ConnectionError, "refused")) : Task.CompletedTask;
                break;
        }
        var ask = await rig.Ask(rig.Admin, input);
        Assert.Equal((reason, status), (ask.Reason, ask.HttpStatus));
        var preview = await rig.Service.PreviewAsync(rig.Admin.UserId, new("preview", input), default);
        Assert.Equal(reason, preview.Outcome.Reason);
        Assert.Empty(rig.Ledger.ForTitle(Title));
        await rig.Outbox.TickAsync(default);
        Assert.Empty(rig.Fake.Posts);
    }

    public static TheoryData<string, string> SendTimeChanges => new()
    {
        { "server renamed", "seerr_options_changed" },
        { "profile removed", "seerr_options_changed" },
        { "folder removed", "seerr_options_changed" },
        { "server becomes 4k", "seerr_options_changed" },
        { "server removed", "seerr_options_changed" },
        { "seerr permission revoked", "seerr_advanced_required" },
        { "switch off", "seerr_options_disabled" },
        { "no longer a jellyfin administrator", "admin_required" },
    };

    [Theory]
    [MemberData(nameof(SendTimeChanges))]
    public async Task AChangeBetweenQueueingAndSendingHoldsTheRequestWithItsReasonAndPostsNothing(string change, string reason)
    {
        using var rig = new Rig();
        var stamp = await rig.Stamp(1);
        var ask = await rig.Ask(rig.Admin, Choice(stamp));
        Assert.Equal(201, ask.HttpStatus);
        // Seerr's servers change within the minute their last read still counts: the send reads them again itself.
        var kids = Radarr(rig.Fake, 1);
        var details = rig.Fake.ServiceDetails["radarr/1"];
        switch (change)
        {
            case "server renamed": kids["name"] = "Radarr Family"; break;
            case "profile removed": details["profiles"] = new JsonArray(new JsonObject { ["id"] = 4, ["name"] = "HD-1080p" }); break;
            case "folder removed": details["rootFolders"] = new JsonArray(new JsonObject { ["id"] = 2, ["path"] = "/kids-extra" }); break;
            case "server becomes 4k": kids["is4k"] = true; break;
            case "server removed": rig.Fake.Services["radarr"].Remove(kids); break;
            case "seerr permission revoked": rig.Fake.Users.Single(u => (int)u["id"]! == 9)["permissions"] = 32; break;
            case "switch off": rig.Config.ArrPhase4SeerrRequestOptionsEnabled = false; break;
            case "no longer a jellyfin administrator": rig.View.Users[rig.Admin.UserId] = new StatusViewer { UserId = rig.Admin.UserId, IsAdmin = false, PolicyRevision = "pU", Handle = rig.View.Users[rig.Admin.UserId].Handle }; break;
        }
        await rig.Outbox.TickAsync(default);
        Assert.Empty(rig.Fake.Posts);
        var job = Assert.Single(rig.Ledger.ForWant(ask.RequestId!));
        Assert.Equal(("parked", reason), (job.State, job.Reason));
        // Held for a person: the next pass doesn't send it either.
        rig.Lab.Now = rig.Lab.Now.AddMinutes(5);
        await rig.Outbox.TickAsync(default);
        Assert.Empty(rig.Fake.Posts);
    }

    [Fact]
    public async Task TheSeerrBackendChecksTheChoiceItselfRightBeforeThePostWhateverTheGuardSaid()
    {
        // The backend alone, with a guard that lets everything through: it still re-reads Seerr and holds.
        using var lab = new IntegrationRequestBackendsTests.SeerrLab(permissions: 2);
        lab.Config.ArrRequestBackend = "seerr";
        lab.Config.ArrPhase4Enabled = true;
        lab.Config.ArrPhase4SeerrRequestOptionsEnabled = true;
        Servers(lab.Seerr);
        var stamp = (await lab.Backend.RequestOptionsAsync(true, default))!.Single(s => s.Id == 1).Options;
        var job = lab.Job(Choice(stamp));
        Radarr(lab.Seerr, 1)["name"] = "Radarr Family";
        var changed = await lab.Backend.SendAsync(job, () => null, default);
        Assert.Equal(("seerr_options_changed", true, true), (changed.Outcome.Reason, changed.Parked, changed.VerifiedNotSent));
        lab.Config.ArrPhase4SeerrRequestOptionsEnabled = false;
        Assert.Equal("seerr_options_disabled", (await lab.Backend.SendAsync(job, () => null, default)).Outcome.Reason);
        lab.Config.ArrPhase4SeerrRequestOptionsEnabled = true;
        Radarr(lab.Seerr, 1)["name"] = "Radarr Kids";
        lab.Seerr.Users.Single(u => (int)u["id"]! == 7)["permissions"] = 32;
        Assert.Equal("seerr_advanced_required", (await lab.Backend.SendAsync(job, () => null, default)).Outcome.Reason);
        Assert.Empty(lab.Seerr.Posts);
        // An arr instance choice still never goes to Seerr.
        var arr = await lab.Backend.SendAsync(lab.Job(new MutationInput { Key = Title, ProfileId = 4 }), () => null, default);
        Assert.Equal("invalid_defaults", arr.Outcome.Reason);
        // Everything as chosen again: sent with the choice and confirmed by a read that shows it.
        lab.Seerr.Users.Single(u => (int)u["id"]! == 7)["permissions"] = 32 | 8192;
        var sent = await lab.Backend.SendAsync(job, () => null, default);
        Assert.True(sent.Confirmed, sent.Outcome.Message);
        Assert.Equal((1, 6, "/kids"), ((int)Assert.Single(lab.Seerr.Posts).Body["serverId"]!, (int)lab.Seerr.Posts[0].Body["profileId"]!, (string)lab.Seerr.Posts[0].Body["rootFolder"]!));
        Assert.True((await lab.Backend.ReadBackAsync(job, default)).Confirmed);
    }

    // Someone else's request already in Seerr, with its server, profile and root folder.
    private static JsonObject Existing(int id, int server, int profile, string root, params int[] seasons)
        => new()
        {
            ["id"] = id, ["status"] = 2, ["is4k"] = false, ["requestedBy"] = new JsonObject { ["id"] = 50 },
            ["serverId"] = server, ["profileId"] = profile, ["rootFolder"] = root,
            ["seasons"] = new JsonArray(seasons.Select(n => (JsonNode)new JsonObject { ["seasonNumber"] = n, ["status"] = 2 }).ToArray()),
        };

    [Theory]
    [InlineData("movie 409", false)]
    [InlineData("movie 409", true)]
    [InlineData("series 202", false)]
    [InlineData("series 202", true)]
    public async Task ASeerrConflictOrNoSeasonsAnswerCountsOnlyWhenTheCoveringRequestHasTheChosenOptions(string answer, bool sameOptions)
    {
        using var lab = new IntegrationRequestBackendsTests.SeerrLab(permissions: 2 | 8192);
        lab.Config.ArrRequestBackend = "seerr";
        lab.Config.ArrPhase4Enabled = true;
        lab.Config.ArrPhase4SeerrRequestOptionsEnabled = true;
        Servers(lab.Seerr);
        MutationInput input;
        if (answer == "movie 409")
        {
            // Someone else asked for it on the default server; the administrator chose the kids' server.
            var other = sameOptions ? Existing(40, 1, 6, "/kids") : Existing(40, 0, 4, "/movies");
            lab.Seerr.Movies[603] = new JsonObject { ["id"] = 603, ["mediaInfo"] = new JsonObject { ["status"] = 2, ["status4k"] = 1, ["requests"] = new JsonArray(other), ["seasons"] = new JsonArray() } };
            input = Choice((await lab.Backend.RequestOptionsAsync(true, default))!.Single(s => s.Id == 1).Options);
        }
        else
        {
            // Season 1 is already requested by someone else, into another root folder than the one chosen.
            var other = sameOptions ? Existing(41, 0, 4, "/tv", 1) : Existing(41, 0, 4, "/tv-anime", 1);
            lab.Seerr.Shows[1731] = new JsonObject { ["id"] = 1731, ["seasons"] = new JsonArray(new JsonObject { ["seasonNumber"] = 1 }), ["mediaInfo"] = new JsonObject { ["status"] = 2, ["status4k"] = 1, ["requests"] = new JsonArray(other), ["seasons"] = new JsonArray() } };
            input = new MutationInput { Key = "tv:tmdb:1731", Scope = "seasons", Seasons = new[] { 1 }, SeerrServerId = 0, SeerrProfileId = 4, SeerrRootFolder = "/tv", SeerrOptions = (await lab.Backend.RequestOptionsAsync(false, default))!.Single(s => s.Id == 0).Options };
        }
        var result = await lab.Backend.SendAsync(lab.Job(input), () => null, default);
        Assert.Single(lab.Seerr.Posts);
        if (sameOptions)
        {
            Assert.True(result.Confirmed, result.Outcome.Message);
            return;
        }
        // Covered, but at another destination than chosen: held for a person with its reason, never a success.
        Assert.False(result.Confirmed);
        Assert.Equal(("seerr_options_changed", true), (result.Outcome.Reason, result.Parked));
        // Seerr created nothing (it answered 409 / 202), so nothing is left uncertain.
        Assert.True(result.VerifiedNotSent, result.Outcome.Message);
    }

    [Fact]
    public async Task ARequestSeerrStoredWithOtherOptionsIsNotAMatchAndIsNeverSentAgain()
    {
        using var rig = new Rig();
        rig.Fake.DropAdvanced = true;
        var ask = await rig.Ask(rig.Admin, Choice(await rig.Stamp(1)));
        await rig.Outbox.TickAsync(default);
        Assert.Single(rig.Fake.Posts);
        var job = Assert.Single(rig.Ledger.ForWant(ask.RequestId!));
        Assert.Equal(("parked", "seerr_options_changed"), (job.State, job.Reason));
        Assert.True(job.Uncertain);
        rig.Lab.Now = rig.Lab.Now.AddMinutes(10);
        await rig.Outbox.TickAsync(default);
        Assert.Single(rig.Fake.Posts);
        Assert.NotEqual("sent", rig.Ledger.Find(ask.RequestId!)!.Status);
    }

    [Fact]
    public async Task AnAdministratorMayChooseOptionsWhenApprovingAndTheAccountItGoesOutAsNeedsSeerrsPermission()
    {
        using var rig = new Rig();
        var ask = await rig.Ask(rig.Kid, new MutationInput { Key = Title });
        Assert.Equal("awaiting_approval", ask.Reason);
        var choice = Choice(await rig.Stamp(1));
        // A Manager approves, but may not choose where it goes.
        Assert.Equal("admin_required", (await rig.Service.ApproveAsync(ask.RequestId!, rig.Manager.UserId, new ApproveRequest(choice), default)).Reason);
        // The request goes out as the Kid's Seerr account, which Seerr doesn't let choose: refused, nothing queued.
        var refused = await rig.Service.ApproveAsync(ask.RequestId!, rig.Admin.UserId, new ApproveRequest(choice), default);
        Assert.Equal(("seerr_advanced_required", 403), (refused.Reason, refused.HttpStatus));
        Assert.Equal("pending", rig.Ledger.Find(ask.RequestId!)!.Status);
        Assert.Empty(rig.Ledger.ForWant(ask.RequestId!));
        // Seerr gives the Kid's account the advanced-request permission: the administrator's choice is approved and sent.
        rig.Fake.Users.Single(u => (int)u["id"]! == 10)["permissions"] = 32 | 8192;
        var approved = await rig.Service.ApproveAsync(ask.RequestId!, rig.Admin.UserId, new ApproveRequest(choice), default);
        Assert.True(approved.HttpStatus == 200, approved.Reason);
        var job = Assert.Single(rig.Ledger.ForWant(ask.RequestId!));
        Assert.True(job.Authorization.Edited);
        Assert.Equal((rig.Admin.UserId, 1), (job.Authorization.Approver, job.Input.SeerrServerId));
        await rig.Outbox.TickAsync(default);
        var post = Assert.Single(rig.Fake.Posts);
        Assert.Equal(("10", 1, "/kids"), (post.ApiUser, (int)post.Body["serverId"]!, (string)post.Body["rootFolder"]!));
        Assert.Equal("succeeded", Assert.Single(rig.Ledger.ForWant(ask.RequestId!)).State);
    }

    [Fact]
    public async Task FamilyAnswersNeverCarryTheSeerrOptions()
    {
        using var rig = new Rig(kidPermissions: 32 | 8192);
        var stamp = await rig.Stamp(1);
        var ask = await rig.Ask(rig.Kid, new MutationInput { Key = Title });
        Assert.Equal(200, (await rig.Service.ApproveAsync(ask.RequestId!, rig.Admin.UserId, new ApproveRequest(Choice(stamp)), default)).HttpStatus);
        var pending = await rig.Ask(rig.Kid, new MutationInput { Key = "movie:tmdb:604" });
        Assert.Equal("awaiting_approval", pending.Reason);
        await rig.Outbox.TickAsync(default);
        Assert.Single(rig.Fake.Posts);
        var projection = new RequestHubProjection(rig.Service, new IntegrationRequestHouseholdTests.FakeDirectory(), null, (_, _, _) => Task.FromResult<HubTitleMeta?>(null), () => rig.Lab.Now);
        var answers = new List<(string Name, string Json)>
        {
            ("Kid mine", Encoding.UTF8.GetString(rig.Service.List(rig.Kid.UserId, false).Json)),
            ("Kid hub mine", Encoding.UTF8.GetString((await projection.MineAsync(rig.Kid, default)).Json)),
            ("Manager approvals", Encoding.UTF8.GetString((await projection.ApprovalsAsync(rig.Manager, default)).Json)),
            ("Manager pending", Encoding.UTF8.GetString(rig.Service.List(rig.Manager.UserId, true).Json)),
        };
        Assert.Contains(Title, answers[0].Json);
        foreach (var (name, json) in answers)
        {
            foreach (var secret in new[] { "SeerrServerId", "SeerrProfileId", "SeerrRootFolder", "SeerrOptions", "serverId", "profileId", "rootFolder", "/kids", stamp })
                Assert.False(json.Contains(secret, StringComparison.OrdinalIgnoreCase), $"{name} carries {secret}: {json}");
        }
    }

    // ------------------------------------------------------------------ the administrators' route

    [Fact]
    public async Task TheRouteListsSeerrsServersForAdministratorsOnlyWithoutAddressesOrKeys()
    {
        using var rig = new Rig();
        static (int Status, string Json, string? Cache) Read(ControllerBase controller, IActionResult result)
            => result switch
            {
                ObjectResult o => (o.StatusCode ?? 200, JsonSerializer.Serialize(o.Value), controller.Response.Headers.CacheControl.ToString()),
                _ => (-1, result.GetType().Name, null),
            };
        async Task<(int Status, string Json, string? Cache)> Call(System.Security.Claims.ClaimsPrincipal caller, string? kind = "movie")
        {
            var controller = rig.Controller(caller);
            return Read(controller, await controller.RequestOptions(kind, default));
        }

        foreach (var caller in new[] { TestCallers.Principal(rig.Kid.UserId, false), TestCallers.Principal(rig.Kid.UserId, true), TestCallers.ApiKey(), TestCallers.Unknown() })
            Assert.Equal((403, "{\"code\":\"admin_required\"}"), ((await Call(caller)).Status, (await Call(caller)).Json));
        var admin = TestCallers.Principal(rig.Admin.UserId, true);
        Assert.Equal((400, "{\"code\":\"invalid_input\"}"), ((await Call(admin, "music")).Status, (await Call(admin, "music")).Json));

        var ok = await Call(admin);
        Assert.Equal((200, "private, no-store"), (ok.Status, ok.Cache));
        using (var doc = JsonDocument.Parse(ok.Json))
        {
            var root = doc.RootElement;
            Assert.True(root.GetProperty("enabled").GetBoolean());
            Assert.True(root.GetProperty("canUse").GetBoolean());
            Assert.Equal(JsonValueKind.Null, root.GetProperty("reason").ValueKind);
            var servers = root.GetProperty("servers").EnumerateArray().ToList();
            Assert.Equal(new[] { 0, 1, 2 }, servers.Select(s => s.GetProperty("id").GetInt32()));
            var kids = servers[1];
            Assert.Equal(("Radarr Kids", false, false, 6, "/kids"), (kids.GetProperty("name").GetString(), kids.GetProperty("is4k").GetBoolean(), kids.GetProperty("isDefault").GetBoolean(),
                kids.GetProperty("defaultProfileId").GetInt32(), kids.GetProperty("defaultRootFolder").GetString()));
            Assert.Equal("4:HD-1080p 6:Kids", string.Join(" ", kids.GetProperty("profiles").EnumerateArray().Select(p => p.GetProperty("id").GetInt32() + ":" + p.GetProperty("name").GetString())));
            Assert.Equal("/kids /kids-extra", string.Join(" ", kids.GetProperty("rootFolders").EnumerateArray().Select(p => p.GetProperty("path").GetString())));
            Assert.Equal(await rig.Stamp(1), kids.GetProperty("options").GetString());
            Assert.True(servers[2].GetProperty("is4k").GetBoolean());
            Assert.Equal(3, servers.Select(s => s.GetProperty("options").GetString()).Distinct().Count());
        }
        foreach (var secret in new[] { "seerr.lan", FakeSeerr.Key, "radarr-secret-host", "ARR-SECRET-KEY", "hostname", "apiKey", "7878" })
            Assert.DoesNotContain(secret, ok.Json, StringComparison.OrdinalIgnoreCase);
        // The stamp is stable while Seerr's facts are, and moves when they change.
        rig.Lab.Now = rig.Lab.Now.AddMinutes(2);
        var again = await rig.Stamp(1);
        Assert.Equal(again, await rig.Stamp(1));
        Radarr(rig.Fake, 1)["name"] = "Radarr Family";
        rig.Lab.Now = rig.Lab.Now.AddMinutes(2);
        Assert.NotEqual(again, await rig.Stamp(1));
        Assert.NotEqual(await rig.Stamp(0), await rig.Stamp(1));

        var series = await Call(admin, "tv");
        Assert.Equal(200, series.Status);
        Assert.Contains("\"name\":\"Sonarr\"", series.Json);

        // The caller's Seerr account lacks the advanced-request permission: nothing listed, and why.
        rig.Fake.Users.Single(u => (int)u["id"]! == 9)["permissions"] = 32;
        var limited = await Call(admin);
        Assert.Equal(200, limited.Status);
        Assert.Contains("\"canUse\":false", limited.Json);
        Assert.Contains("\"reason\":\"seerr_advanced_required\"", limited.Json);
        Assert.Contains("\"servers\":[]", limited.Json);

        // Jellyfin Enhanced handles requests: not offered.
        rig.Config.ArrRequestBackend = "je";
        Assert.Contains("\"enabled\":false", (await Call(admin)).Json);
        // Switch off: refused before anything is read.
        rig.Config.ArrRequestBackend = "seerr";
        rig.Config.ArrPhase4SeerrRequestOptionsEnabled = false;
        var calls = rig.Fake.Calls.Count;
        Assert.Equal((403, "{\"code\":\"seerr_options_disabled\"}"), ((await Call(admin)).Status, (await Call(admin)).Json));
        Assert.Equal(calls, rig.Fake.Calls.Count);
    }
}
