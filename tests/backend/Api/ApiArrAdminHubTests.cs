using System.Reflection;
using System.Security.Claims;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Controllers;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr.Live;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Routing;
using Microsoft.Extensions.Logging;

namespace JE.Tests;

/// <summary>
/// The administrator's tabs and actions (Requests &amp; downloads, phase 2): every <c>arr/admin</c>
/// route carries [Authorize] and every new one answers 403 to anyone but an administrator (and is
/// off with phase 2 off); the Overview's Needs attention from the arrs' own facts; queue actions
/// through the audited runner (remove keeping the data with blocklist / search again, a season
/// pack as one download, search again, retry import); remove-with-data only with a fresh token
/// bound to the administrator and the download; an audit row for every action and refusal; Scan
/// now; the activity log mirror; and the hub's admin block switching the tabs on.
/// </summary>
[Collection("Plugin singleton")]
public class ApiArrAdminHubTests
{
    private sealed class Rig : IDisposable
    {
        public FakeArr Arr { get; } = new();
        public FakeArr.Host Radarr { get; }
        public FakeArr.Host Sonarr { get; }
        public FakeSeerr Seerr { get; } = new();
        public ArrStateStore Store { get; }
        public FakeJellyfinView View { get; } = new();
        public FakeLibraryAccess Library { get; } = new();
        public SeerrRequestReadModel Requests { get; }
        public ArrStatusService Status { get; }
        public RequestsHubService Hub { get; }
        public ArrManageService Manage { get; }
        public ArrAuditLog Audit { get; }
        public ArrActionRunner Runner { get; }
        public JellyfinBridge Bridge { get; }
        public ArrAdminHubService Admin { get; }
        public ArrQueueActionService Queue { get; }
        public ArrChangeFeed Feed { get; } = new();
        public StatusViewer AdminUser { get; }
        public StatusViewer OtherAdmin { get; }
        public StatusViewer Member { get; }

        public Rig()
        {
            Radarr = Arr.Add("radarr.lan", "Radarr");
            Sonarr = Arr.Add("sonarr.lan", "Sonarr");
            Arr.Configure(("RadarrMainZ", ArrKind.Radarr, "http://radarr.lan:7878", "RADARR-KEY-0123456789"), ("SonarrZ", ArrKind.Sonarr, "http://sonarr.lan:8989", "SONARR-KEY-0123456789"));
            var c = Arr.Plugin.Plugin.Configuration;
            c.ArrIntegrationEnabled = true;
            c.ArrPhase1Enabled = true;
            c.ArrPhase2Enabled = true;
            c.JellyseerrEnabled = true;
            c.JellyseerrUrls = FakeSeerr.Url;
            c.JellyseerrApiKey = FakeSeerr.Key;
            c.RadarrInstances = IntegrationArrBridgeTestsAccess.WithMapping(c.RadarrInstances, "/data/movies", "/media/movies");

            Radarr.Movies.Add(FakeArr.Movie(1, 438631, "Dune", hasFile: false, path: "/data/movies/Dune (2021)"));
            Radarr.Movies.Add(FakeArr.Movie(2, 45745, "Sintel", hasFile: false));
            var blocked = FakeArr.RadarrQueueRow(1, 438631, "Dune", state: "importBlocked", status: "warning");
            blocked["status"] = "completed";
            blocked["statusMessages"] = new JsonArray(new JsonObject { ["title"] = "x", ["messages"] = new JsonArray("Manual Import required.") });
            Radarr.Queue.Add(blocked);
            Radarr.Queue.Add(FakeArr.RadarrQueueRow(2, 45745, "Sintel"));
            Radarr.Health.Add(new JsonObject { ["source"] = "IndexerRssCheck", ["type"] = "error", ["message"] = "No indexers available with RSS sync enabled" });
            Radarr.DiskSpace.Add(new JsonObject { ["path"] = "/data", ["freeSpace"] = 50L, ["totalSpace"] = 1000L });
            Radarr.RootFolders.Add(new JsonObject { ["path"] = "/data/movies", ["freeSpace"] = 50L, ["accessible"] = true });
            Sonarr.Series.Add(FakeArr.SeriesRow(1, 391153, "Peacemaker"));
            foreach (var e in new[] { 1, 2, 3 }) Sonarr.Queue.Add(FakeArr.SonarrQueueRow(10 + e, "pack", 2, e, "Peacemaker", 391153));

            Store = Arr.Store();
            Requests = new SeerrRequestReadModel(Seerr.Transport, Feed, null, () => Arr.Plugin.Plugin.Configuration, () => Arr.Now);
            Status = new ArrStatusService(Store, View, Requests, () => Arr.Plugin.Plugin.Configuration, () => Arr.Now, Feed);
            Hub = new RequestsHubService(Status, Requests, () => Arr.Plugin.Plugin.Configuration);
            Audit = new ArrAuditLog(Path.Combine(Arr.Plugin.Core.Root, ArrAuditLog.FileName), 1024 * 1024, 2);
            Runner = new ArrActionRunner(Audit, new ArrConfirmationTokens());
            Manage = new ArrManageService(Status, Arr.Factory, Runner, Audit, Requests, null, Feed, () => Arr.Plugin.Plugin.Configuration, (_, _) => Task.CompletedTask);
            Library.AddLibrary("Movies", "movies", "/media/movies");
            Bridge = new JellyfinBridge(Store, Library, null, () => Arr.Plugin.Plugin.Configuration, () => Arr.Now, null);
            Admin = new ArrAdminHubService(Store, Bridge, Requests, null, null, () => Arr.Plugin.Plugin.Configuration, () => Arr.Now);
            Queue = new ArrQueueActionService(Store, Arr.Factory, Runner, Audit, Feed);
            AdminUser = View.AddUser(admin: true);
            OtherAdmin = View.AddUser(admin: true);
            Member = View.AddUser(admin: false);
            // Seerr OK'd Inception an hour ago; no Radarr has it.
            Seerr.Requests.Add(FakeSeerr.Request(1, "movie", 27205, 2, Member.UserId, Arr.Now.UtcDateTime.AddHours(-2), Arr.Now.UtcDateTime.AddHours(-1), userName: "Emma"));
            Seerr.Movies[27205] = new JsonObject { ["title"] = "Inception", ["releaseDate"] = "2010-07-15" };
        }

        public ArrAdminHubController Controller(StatusViewer? viewer)
        {
            var controller = new ArrAdminHubController(Admin, Queue, Bridge, Runner, Status, Manage) { ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext() } };
            controller.HttpContext.User = viewer == null
                ? new ClaimsPrincipal(new ClaimsIdentity(Array.Empty<Claim>(), "test"))
                : new ClaimsPrincipal(new ClaimsIdentity([new Claim("Jellyfin-UserId", viewer.UserId.ToString()), new Claim(ClaimTypes.Role, viewer.IsAdmin ? "Administrator" : "User")], "test"));
            return controller;
        }

        public ArrConnection Instance(string name) => Arr.Instance(name);

        public async Task Warm()
        {
            Assert.True(await Requests.RefreshAsync(default));
            foreach (var i in new[] { "RadarrMainZ", "SonarrZ" })
            {
                var c = Instance(i);
                await Store.GetLibraryAsync(c, default);
                await Store.GetQueueAsync(c, default);
                await Store.GetSystemAsync(c, default);
                await Store.GetHistoryAsync(c, default);
            }
        }

        public void Dispose()
        {
            Bridge.Dispose();
            Requests.Dispose();
            Seerr.Dispose();
            Arr.Dispose();
        }
    }

    private sealed record Reply(int Status, string Body);

    private static async Task<Reply> Send(Func<Task<IActionResult>> call)
    {
        var result = await call();
        return result switch
        {
            FileContentResult file => new Reply(200, Encoding.UTF8.GetString(file.FileContents)),
            ObjectResult obj => new Reply(obj.StatusCode ?? 200, JsonSerializer.Serialize(obj.Value)),
            StatusCodeResult code => new Reply(code.StatusCode, string.Empty),
            ForbidResult => new Reply(403, string.Empty),
            _ => throw new InvalidOperationException(result.GetType().Name),
        };
    }

    private static JsonElement Json(Reply r) => JsonDocument.Parse(r.Body).RootElement;

    private static Task<Reply> Act(Rig rig, StatusViewer viewer, string instance, string downloadId, string action, bool blocklist = false, bool search = false, string? token = null, string? key = null)
    {
        var c = rig.Controller(viewer);
        return Send(() => c.QueueActionRun(new QueueActionRequest
        {
            InstanceId = rig.Instance(instance).Id, DownloadId = downloadId, Action = action, Blocklist = blocklist, SearchAgain = search,
            IdempotencyKey = key ?? Guid.NewGuid().ToString("N"), ConfirmationToken = token,
        }, default));
    }

    [Fact]
    public void EveryArrAdminRouteRequiresSignInAndTheNewOnesCheckForAnAdministratorFirst()
    {
        var routes = typeof(ArrAdminHubController).Assembly.GetTypes()
            .Where(t => typeof(ControllerBase).IsAssignableFrom(t))
            .SelectMany(t => t.GetMethods(BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly))
            .SelectMany(m => m.GetCustomAttributes<HttpMethodAttribute>().Select(a => (Method: m, a.Template)))
            .Where(x => x.Template != null && x.Template.StartsWith("arr/admin", StringComparison.Ordinal))
            .ToList();
        Assert.True(routes.Count >= 20, $"found {routes.Count}");
        foreach (var (method, template) in routes)
            Assert.True(method.GetCustomAttribute<AuthorizeAttribute>() != null, $"{template} has no [Authorize]");
        var mine = routes.Where(r => r.Method.DeclaringType == typeof(ArrAdminHubController)).Select(r => r.Template).OrderBy(t => t).ToArray();
        Assert.Equal(new[] { "arr/admin/bridge/scan", "arr/admin/hub/activity", "arr/admin/hub/overview", "arr/admin/hub/search", "arr/admin/hub/system", "arr/admin/queue/action", "arr/admin/queue/confirm" }, mine);
    }

    /// <summary>Calls every action of the controller with empty arguments (null bodies) as <paramref name="viewer"/>.</summary>
    private static async Task<List<(string Name, Reply Reply)>> CallAll(Rig rig, StatusViewer? viewer)
    {
        var replies = new List<(string, Reply)>();
        foreach (var m in typeof(ArrAdminHubController).GetMethods(BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly).Where(m => m.GetCustomAttributes<HttpMethodAttribute>().Any()))
        {
            var c = rig.Controller(viewer);
            var args = m.GetParameters().Select(p => p.ParameterType == typeof(CancellationToken) ? (object)CancellationToken.None : null).ToArray();
            replies.Add((m.Name, await Send(() => (Task<IActionResult>)m.Invoke(c, args)!)));
        }
        return replies;
    }

    [Fact]
    public async Task NonAdministratorsGet403OnEveryNewRouteAndNothingIsReadOrWritten()
    {
        using var rig = new Rig();
        var calls = rig.Arr.Calls.Count;
        foreach (var viewer in new[] { rig.Member, (StatusViewer?)null })
        {
            foreach (var (name, reply) in await CallAll(rig, viewer))
            {
                Assert.True(reply.Status == 403 && reply.Body == string.Empty, $"{name}: {reply.Status} {reply.Body}");
            }
        }
        Assert.Equal(calls, rig.Arr.Calls.Count);
        // The member's calls to the four action routes are audited as denied (the reads are not);
        // nobody signed in leaves no line (Jellyfin's [Authorize] stops them before the route).
        var denied = rig.Audit.ReadRecent(20);
        Assert.Equal(new[] { "route:arr/admin/bridge/scan", "route:arr/admin/hub/search", "route:arr/admin/queue/action", "route:arr/admin/queue/confirm" }, denied.Select(a => a.Target).OrderBy(t => t, StringComparer.Ordinal));
        Assert.All(denied, a => Assert.Equal(("denied", "denied", rig.Member.UserId.ToString("N")), (a.Action, a.Outcome, a.UserId)));
        // A member with the right-looking body is refused too (within the minute: no second line).
        Assert.Equal(403, (await Act(rig, rig.Member, "RadarrMainZ", "dl1", "remove_with_data", token: "x")).Status);
        Assert.Equal(4, rig.Audit.ReadRecent(20).Count);
        Assert.Equal(calls, rig.Arr.Calls.Count);

        // Administrators with phase 2 off: 403 feature_disabled.
        rig.Arr.Plugin.Plugin.Configuration.ArrPhase2Enabled = false;
        foreach (var (name, reply) in await CallAll(rig, rig.AdminUser))
        {
            Assert.True(reply.Status == 403 && reply.Body.Contains("feature_disabled", StringComparison.Ordinal), $"{name}: {reply.Status} {reply.Body}");
        }
    }

    [Fact]
    public async Task TheOverviewListsWhatTheArrsAndSeerrStateWithFixes()
    {
        using var rig = new Rig();
        await rig.Warm();
        var c = rig.Controller(rig.AdminUser);
        var overview = Json(await Send(() => c.GetOverview(default)));
        var items = overview.GetProperty("needsAttention").EnumerateArray().Select(i => (Code: i.GetProperty("code").GetString()!, Title: i.TryGetProperty("title", out var t) ? t.GetString() : null)).ToList();
        Assert.Contains((AttentionCode.ImportBlocked, "Dune"), items);
        Assert.Contains((AttentionCode.Health, "IndexerRssCheck"), items);
        Assert.Contains((AttentionCode.LowDisk, "/data/movies"), items);
        Assert.Contains((AttentionCode.ApprovedNotInArr, "Inception"), items);
        // The healthy Sintel download and the healthy season pack are not rows.
        Assert.DoesNotContain(items, i => i.Title == "Sintel" || i.Title == "Peacemaker");
        var radarr = overview.GetProperty("instances").EnumerateArray().Single(i => i.GetProperty("name").GetString() == "RadarrMainZ");
        Assert.Equal((2, 1, "error"), (radarr.GetProperty("queue").GetInt32(), radarr.GetProperty("queueAttention").GetInt32(), radarr.GetProperty("health").GetString()));
        Assert.Equal(95, radarr.GetProperty("disks")[0].GetProperty("usedPercent").GetInt32());
        Assert.Equal(3, overview.GetProperty("downloading").GetInt32());

        var activity = Json(await Send(() => c.GetActivity(default)));
        var pack = activity.GetProperty("queue").EnumerateArray().Single(g => g.GetProperty("downloadId").GetString() == "pack");
        Assert.Equal(("S02E01–E03", 3), (pack.GetProperty("scope").GetString(), pack.GetProperty("episodes").GetInt32()));
        var system = Json(await Send(() => c.GetSystem(default)));
        Assert.Equal(2, system.GetProperty("instances").GetArrayLength());
        Assert.True(system.GetProperty("bridge").GetProperty("targetedRefresh").GetBoolean());
    }

    [Fact]
    public async Task OkdButNotInAnyArrIsNotClaimedFromALibraryIndexWhoseLatestReadFailed()
    {
        using var rig = new Rig();
        await rig.Warm();
        static bool Handoff(JsonElement overview) => overview.GetProperty("needsAttention").EnumerateArray().Any(i => i.GetProperty("code").GetString() == AttentionCode.ApprovedNotInArr);
        async Task<string> Code()
        {
            var c = new ArrStatusController(rig.Status) { ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext() } };
            c.HttpContext.User = new ClaimsPrincipal(new ClaimsIdentity([new Claim("Jellyfin-UserId", rig.AdminUser.UserId.ToString())], "test"));
            return Json(await Send(() => c.GetStatuses(null, "movie:tmdb:27205", default))).GetProperty("items")[0].GetProperty("reason").GetProperty("code").GetString()!;
        }
        Assert.True(Handoff(Json(await Send(() => rig.Controller(rig.AdminUser).GetOverview(default)))));
        Assert.Equal(StatusReasonCode.ApprovedNotInArr, await Code());

        // Radarr stops answering: the index in memory is from before and may miss what Seerr sent it since.
        rig.Radarr.FailWith = 503;
        Assert.False((await rig.Store.RefreshLibraryNowAsync(rig.Instance("RadarrMainZ"), default)).Ok);
        Assert.False(Handoff(Json(await Send(() => rig.Controller(rig.AdminUser).GetOverview(default)))));
        Assert.Equal(StatusReasonCode.Approved, await Code());
    }

    [Fact]
    public async Task TheArrsTaskListIsReadOnlyWhilePhaseTwoIsOn()
    {
        using var rig = new Rig();
        var radarr = rig.Instance("RadarrMainZ");
        // Phase 2 off: the system snapshot is read as before (no extra call for the System tab's task list).
        rig.Arr.Plugin.Plugin.Configuration.ArrPhase2Enabled = false;
        Assert.NotNull((await rig.Store.GetSystemAsync(radarr, default)).Value);
        Assert.Equal(0, rig.Arr.CallCount("radarr.lan", "system/task"));
        rig.Arr.Plugin.Plugin.Configuration.ArrPhase2Enabled = true;
        await rig.Store.RefreshForEventAsync(radarr.Id, ArrSnapshotKind.System, force: true);
        Assert.Equal(1, rig.Arr.CallCount("radarr.lan", "system/task"));
    }

    [Fact]
    public async Task ASearchNowRefusedBeforeAnyArrCallIsAuditedToo()
    {
        using var rig = new Rig();
        await rig.Warm();
        var c = rig.Controller(rig.AdminUser);
        var radarr = rig.Instance("RadarrMainZ").Id;
        var calls = rig.Arr.Calls.Count;
        // A title the instance doesn't have (deleted in Radarr's UI since), and the wrong kind of instance.
        var missing = Json(await Send(() => c.Search(new ManageSearchRequest { InstanceId = radarr, Key = "movie:tmdb:27205", IdempotencyKey = "h1" }, default)));
        Assert.Equal("Rejected", missing.GetProperty("status").GetString());
        var wrong = Json(await Send(() => c.Search(new ManageSearchRequest { InstanceId = rig.Instance("SonarrZ").Id, Key = "movie:tmdb:438631", IdempotencyKey = "h2" }, default)));
        Assert.Equal("Rejected", wrong.GetProperty("status").GetString());
        Assert.Equal(calls, rig.Arr.Calls.Count);
        Assert.Equal(new[] { ("movie.search", "rejected", "wrong_instance"), ("movie.search", "rejected", "not_in_arr") }, rig.Audit.ReadRecent(2).Select(a => (a.Action, a.Outcome, a.Error ?? "")));
        Assert.Equal("key:movie:tmdb:27205", rig.Audit.ReadRecent(2).Last().Target);
    }

    [Fact]
    public async Task TheAdminTabsFollowAnAdminOnlyFeedKeyBumpedByArrReadsAndAuditedActions()
    {
        using var rig = new Rig();
        await rig.Warm();
        var ops = new ArrAdminOpsFeed(rig.Store, rig.Audit, rig.Feed, () => rig.Arr.Plugin.Plugin.Configuration) { Debounce = TimeSpan.FromMilliseconds(20) };
        ops.Subscribe();
        try
        {
            static async Task Until(Func<bool> check)
            {
                var end = DateTime.UtcNow.AddSeconds(3);
                while (!check() && DateTime.UtcNow < end) await Task.Delay(10);
            }
            // An audited action, then a queue read: each announced (debounced).
            await Act(rig, rig.AdminUser, "SonarrZ", "pack", "search");
            await Until(() => rig.Feed.Revision(ArrTitleKey.AdminOps) > 0);
            var first = rig.Feed.Revision(ArrTitleKey.AdminOps);
            Assert.True(first > 0);
            await Task.Delay(60);
            first = rig.Feed.Revision(ArrTitleKey.AdminOps);
            await rig.Store.RefreshForEventAsync(rig.Instance("RadarrMainZ").Id, ArrSnapshotKind.Queue, force: true);
            await Until(() => rig.Feed.Revision(ArrTitleKey.AdminOps) > first);
            Assert.True(rig.Feed.Revision(ArrTitleKey.AdminOps) > first);

            // Phase 2 off: nothing announced.
            rig.Arr.Plugin.Plugin.Configuration.ArrPhase2Enabled = false;
            await Task.Delay(60);
            var off = rig.Feed.Revision(ArrTitleKey.AdminOps);
            await rig.Store.RefreshForEventAsync(rig.Instance("RadarrMainZ").Id, ArrSnapshotKind.Queue, force: true);
            await Task.Delay(150);
            Assert.Equal(off, rig.Feed.Revision(ArrTitleKey.AdminOps));
        }
        finally
        {
            await ops.StopAsync(default);
        }

        // Only administrators hear about it; a client may ask for it (a feed key).
        Assert.True(ArrTitleKey.IsFeedKey(ArrTitleKey.AdminOps));
        var audience = new ArrFeedAudience(new Moq.Mock<MediaBrowser.Controller.Library.ILibraryManager>().Object, new Moq.Mock<MediaBrowser.Controller.Library.IUserManager>().Object, rig.Store);
        var change = new List<ArrFeedChange> { new(ArrTitleKey.AdminOps, 7, null) };
        Assert.Empty(audience.Visible(rig.Member.UserId, false, change));
        Assert.Equal(new[] { ArrTitleKey.AdminOps }, audience.Visible(rig.AdminUser.UserId, true, change));
    }

    [Fact]
    public async Task TheManageDrawerGetsTheTitlesWholeDownloadsWithTheirActionsWithPhaseTwoOn()
    {
        using var rig = new Rig();
        await rig.Warm();
        rig.Arr.Plugin.Plugin.Configuration.ArrManageDrawerEnabled = true;
        // Opened on one episode of the pack: the whole download (all three episodes) with its actions.
        var key = TitleKey.Parse("tv:tvdb:391153:s2:e2")!;
        var drawer = await rig.Manage.OverviewAsync(rig.AdminUser, key, null, default);
        var sonarr = drawer.Instances.Single(i => i.Name == "SonarrZ");
        var pack = Assert.Single(sonarr.Downloads);
        Assert.Equal(("pack", 3), (pack.DownloadId, pack.Episodes));
        Assert.Contains("remove", pack.Actions);
        Assert.Contains("search", pack.Actions);
        var radarr = (await rig.Manage.OverviewAsync(rig.AdminUser, TitleKey.Parse("movie:tmdb:438631")!, null, default)).Instances.Single(i => i.Name == "RadarrMainZ");
        Assert.Equal(new[] { "dl1" }, radarr.Downloads.Select(d => d.DownloadId));
        // Phase 2 off: the drawer is as in phase 1 (no downloads block).
        rig.Arr.Plugin.Plugin.Configuration.ArrPhase2Enabled = false;
        Assert.Empty((await rig.Manage.OverviewAsync(rig.AdminUser, key, null, default)).Instances.Single(i => i.Name == "SonarrZ").Downloads);
    }

    [Fact]
    public async Task RemovingKeepsTheDataByDefaultBlocklistsAndSearchesAgainAndIsAudited()
    {
        using var rig = new Rig();
        await rig.Warm();
        var reply = Json(await Act(rig, rig.AdminUser, "RadarrMainZ", "dl2", "remove", blocklist: true, search: true));
        Assert.Equal(("Succeeded", true, "Removed from the queue."), (reply.GetProperty("status").GetString(), reply.GetProperty("confirmed").GetBoolean(), reply.GetProperty("readBack").GetString()));
        var write = Assert.Single(rig.Radarr.Writes);
        Assert.Equal(("DELETE", "/api/v3/queue/2?removeFromClient=false&blocklist=true&skipRedownload=false"), (write.Method, write.Path));
        var audit = rig.Audit.ReadRecent(5).Single();
        Assert.Equal(("queue.remove", "succeeded", 2, "download:dl2"), (audit.Action, audit.Outcome, audit.Tier, audit.Target));
        Assert.Equal(("Sintel (2010)", "yes", "yes", "no"), (audit.Details!["title"], audit.Details["blocklist"], audit.Details["searchAgain"], audit.Details["deleteData"]));

        // Without a blocklist, "search again" is the arr's search command after the removal.
        await rig.Store.RefreshForEventAsync(rig.Instance("RadarrMainZ").Id, ArrSnapshotKind.Queue, true);
        rig.Radarr.Queue.Add(FakeArr.RadarrQueueRow(2, 45745, "Sintel"));
        await rig.Store.RefreshForEventAsync(rig.Instance("RadarrMainZ").Id, ArrSnapshotKind.Queue, true);
        await Act(rig, rig.AdminUser, "RadarrMainZ", "dl2", "remove", blocklist: false, search: true);
        Assert.Equal("/api/v3/queue/2?removeFromClient=false&blocklist=false&skipRedownload=true", rig.Radarr.Writes[1].Path);
        Assert.Contains("MoviesSearch", rig.Radarr.Writes[2].Body, StringComparison.Ordinal);
    }

    // A Sonarr queue of 501 rows whose last row moves to the front while page 2 is read (both reads
    // come back one row short), with an 8-episode pack in rows 494-501: the cold snapshot holds 7 of it.
    private static void ShortQueueWithAPack(Rig rig)
    {
        rig.Sonarr.Queue.Clear();
        for (var i = 1; i <= 493; i++) rig.Sonarr.Queue.Add(FakeArr.SonarrQueueRow(1000 + i, "dl" + i, 1, i));
        for (var e = 1; e <= 8; e++) rig.Sonarr.Queue.Add(FakeArr.SonarrQueueRow(1493 + e, "bigpack", 3, e, "Peacemaker", 391153));
        rig.Sonarr.BeforePage = (path, page) =>
        {
            if (path != "/api/v3/queue" || page != 2) return;
            var last = rig.Sonarr.Queue[^1];
            rig.Sonarr.Queue.RemoveAt(rig.Sonarr.Queue.Count - 1);
            rig.Sonarr.Queue.Insert(0, last);
        };
    }

    [Fact]
    public async Task AColdPersistentlyShortQueueStillConfirmsAndRemovesTheWholePack()
    {
        using var rig = new Rig();
        ShortQueueWithAPack(rig);
        var tv = rig.Instance("SonarrZ");
        var snapshot = (await rig.Store.GetQueueAsync(tv, default)).Value!;
        Assert.True(snapshot.Incomplete);
        Assert.Equal(7, snapshot.Records.Count(r => r.DownloadId == "bigpack"));

        // The confirmation names all 8 episodes (read again in one unpaged read), not the 7 held.
        var c = rig.Controller(rig.AdminUser);
        var confirm = Json(await Send(() => c.Confirm(new QueueConfirmRequest { InstanceId = tv.Id, DownloadId = "bigpack" }, default)));
        var download = confirm.GetProperty("download");
        Assert.Equal((8, 8, "S03E01–E08"), (download.GetProperty("episodes").GetInt32(), download.GetProperty("ids").GetArrayLength(), download.GetProperty("scope").GetString()));
        Assert.Contains(rig.Arr.Calls, call => call.StartsWith("sonarr.lan/api/v3/queue/details", StringComparison.Ordinal) && call.Contains("seriesId=", StringComparison.Ordinal));

        // The removal acts on every row of the download.
        var done = Json(await Act(rig, rig.AdminUser, "SonarrZ", "bigpack", "remove_with_data", token: confirm.GetProperty("token").GetString()));
        Assert.Equal("Succeeded", done.GetProperty("status").GetString());
        var write = Assert.Single(rig.Sonarr.Writes);
        Assert.Equal("/api/v3/queue/bulk?removeFromClient=true&blocklist=false&skipRedownload=true", write.Path);
        Assert.Equal(Enumerable.Range(1494, 8), JsonNode.Parse(write.Body)!["ids"]!.AsArray().Select(n => (int)n!).OrderBy(i => i));
        Assert.Equal("8", rig.Audit.ReadRecent(1).Single().Details!["rows"]);
    }

    /// <summary>A paged snapshot missing one pack row still confirms, searches and removes all eight.</summary>
    [Fact]
    public async Task APackWithARowMissedByAPagedReadIsConfirmedSearchedAndRemovedWhole()
    {
        using var rig = new Rig();
        rig.Sonarr.Queue.Clear();
        for (var i = 1; i <= 493; i++) rig.Sonarr.Queue.Add(FakeArr.SonarrQueueRow(1000 + i, "dl" + i, 1, i));
        for (var e = 1; e <= 8; e++) rig.Sonarr.Queue.Add(FakeArr.SonarrQueueRow(1493 + e, "bigpack", 3, e, "Peacemaker", 391153));
        for (var i = 502; i <= 1001; i++) rig.Sonarr.Queue.Add(FakeArr.SonarrQueueRow(1000 + i, "dl" + i, 1, i));
        var moved = false;
        rig.Sonarr.BeforePage = (path, page) =>
        {
            if (path != "/api/v3/queue" || page != 2 || moved) return;
            moved = true;
            rig.Sonarr.Queue.RemoveAt(0);
            rig.Sonarr.Queue.Add(FakeArr.SonarrQueueRow(2002, "dl1002", 1, 1002));
        };
        var tv = rig.Instance("SonarrZ");
        var snapshot = (await rig.Store.GetQueueAsync(tv, default)).Value!;
        Assert.False(snapshot.Incomplete);
        Assert.False(snapshot.Truncated);
        Assert.True(snapshot.Paged);
        Assert.Equal(1001, snapshot.TotalRecords);
        Assert.Equal(1001, snapshot.Records.Count);
        Assert.Equal(7, snapshot.Records.Count(r => r.DownloadId == "bigpack"));

        var c = rig.Controller(rig.AdminUser);
        var confirm = Json(await Send(() => c.Confirm(new QueueConfirmRequest { InstanceId = tv.Id, DownloadId = "bigpack" }, default)));
        var download = confirm.GetProperty("download");
        Assert.Equal((8, 8, "S03E01–E08"), (download.GetProperty("episodes").GetInt32(), download.GetProperty("ids").GetArrayLength(), download.GetProperty("scope").GetString()));
        Assert.Contains(rig.Arr.Calls, call => call.StartsWith("sonarr.lan/api/v3/queue/details", StringComparison.Ordinal) && call.Contains("seriesId=", StringComparison.Ordinal));

        var search = Json(await Act(rig, rig.AdminUser, "SonarrZ", "bigpack", "search"));
        Assert.Equal("Succeeded", search.GetProperty("status").GetString());
        var command = JsonNode.Parse(Assert.Single(rig.Sonarr.Writes).Body)!;
        Assert.Equal("EpisodeSearch", (string?)command["name"]);
        Assert.Equal(Enumerable.Range(1494, 8), command["episodeIds"]!.AsArray().Select(n => (int)n!).OrderBy(i => i));

        var done = Json(await Act(rig, rig.AdminUser, "SonarrZ", "bigpack", "remove_with_data", token: confirm.GetProperty("token").GetString()));
        Assert.Equal("Succeeded", done.GetProperty("status").GetString());
        var write = rig.Sonarr.Writes.Last();
        Assert.Equal("/api/v3/queue/bulk?removeFromClient=true&blocklist=false&skipRedownload=true", write.Path);
        Assert.Equal(Enumerable.Range(1494, 8), JsonNode.Parse(write.Body)!["ids"]!.AsArray().Select(n => (int)n!).OrderBy(i => i));
        Assert.Equal("8", rig.Audit.ReadRecent(1).Single().Details!["rows"]);
    }

    [Fact]
    public async Task APackStraddlingTheQueueRowCapIsConfirmedWithEveryEpisode()
    {
        using var rig = new Rig();
        var cap = ArrStateLoaders.QueueMaxRecords;
        rig.Sonarr.Queue.Clear();
        for (var i = 1; i <= cap - 6; i++) rig.Sonarr.Queue.Add(FakeArr.SonarrQueueRow(i, "dl" + i, 1, 1));
        for (var e = 1; e <= 8; e++) rig.Sonarr.Queue.Add(FakeArr.SonarrQueueRow(cap - 6 + e, "bigpack", 3, e, "Peacemaker", 391153));
        var tv = rig.Instance("SonarrZ");
        var snapshot = (await rig.Store.GetQueueAsync(tv, default)).Value!;
        Assert.True(snapshot.Truncated);
        Assert.Equal(6, snapshot.Records.Count(r => r.DownloadId == "bigpack"));

        var (confirmation, changing) = await rig.Queue.ConfirmAsync(rig.AdminUser, tv.Id, "bigpack", default);
        Assert.False(changing);
        Assert.Equal((8, 8), (confirmation!.Download.Episodes, confirmation.Download.Ids.Count));
    }

    [Fact]
    public async Task AShortQueueWhoseRowsCantBeReadAgainRefusesTheConfirmationAndTheActions()
    {
        using var rig = new Rig();
        ShortQueueWithAPack(rig);
        var tv = rig.Instance("SonarrZ");
        Assert.True((await rig.Store.GetQueueAsync(tv, default)).Value!.Incomplete);
        rig.Sonarr.DetailsFailWith = 400;

        var c = rig.Controller(rig.AdminUser);
        var confirm = await Send(() => c.Confirm(new QueueConfirmRequest { InstanceId = tv.Id, DownloadId = "bigpack" }, default));
        Assert.Equal(409, confirm.Status);
        Assert.Equal("queue_changing", Json(confirm).GetProperty("code").GetString());
        var removed = Json(await Act(rig, rig.AdminUser, "SonarrZ", "bigpack", "remove"));
        Assert.Equal("Rejected", removed.GetProperty("status").GetString());
        Assert.Equal(("queue.remove", "queue_changing"), rig.Audit.ReadRecent(1).Select(a => (a.Action, a.Error)).Single());
        Assert.Empty(rig.Sonarr.Writes);

        // A complete paged read still needs an unpaged read of the download's rows.
        rig.Sonarr.BeforePage = null;
        rig.Sonarr.DetailsFailWith = 0;
        await rig.Store.RefreshForEventAsync(tv.Id, ArrSnapshotKind.Queue, true);
        Assert.False(rig.Store.PeekQueue(tv.Id)!.Incomplete);
        Assert.True(rig.Store.PeekQueue(tv.Id)!.Paged);
        var details = rig.Arr.CallCount("sonarr.lan", "queue/details");
        Assert.Equal(8, (await rig.Queue.FindAsync(tv.Id, "bigpack", default))!.Episodes);
        Assert.Equal(details + 1, rig.Arr.CallCount("sonarr.lan", "queue/details"));

        // Once the queue fits in one page, the snapshot supplies every row without another read.
        rig.Sonarr.Queue.RemoveAll(r => (int)r["id"]! <= 1100);
        await rig.Store.RefreshForEventAsync(tv.Id, ArrSnapshotKind.Queue, true);
        Assert.False(rig.Store.PeekQueue(tv.Id)!.Paged);
        Assert.False(rig.Store.PeekQueue(tv.Id)!.Incomplete);
        details = rig.Arr.CallCount("sonarr.lan", "queue/details");
        Assert.Equal(8, (await rig.Queue.FindAsync(tv.Id, "bigpack", default))!.Episodes);
        Assert.Equal(details, rig.Arr.CallCount("sonarr.lan", "queue/details"));
    }

    [Fact]
    public async Task ARetryOfASucceededRemovalWithTheSameKeyGetsItsOutcomeBackNotARefusal()
    {
        using var rig = new Rig();
        await rig.Warm();
        var key = Guid.NewGuid().ToString("N");
        var first = Json(await Act(rig, rig.AdminUser, "RadarrMainZ", "dl2", "remove", key: key));
        Assert.Equal("Succeeded", first.GetProperty("status").GetString());
        // The answer was lost; the queue has been read again since (the download is gone) when the
        // client retries the same click.
        await rig.Store.RefreshForEventAsync(rig.Instance("RadarrMainZ").Id, ArrSnapshotKind.Queue, true);
        Assert.Null(await rig.Queue.FindAsync(rig.Instance("RadarrMainZ").Id, "dl2", default));
        var again = Json(await Act(rig, rig.AdminUser, "RadarrMainZ", "dl2", "remove", key: key));
        Assert.Equal(("Succeeded", true, first.GetProperty("auditId").GetString()), (again.GetProperty("status").GetString(), again.GetProperty("replayed").GetBoolean(), again.GetProperty("auditId").GetString()));
        Assert.Single(rig.Radarr.Writes);
        Assert.Single(rig.Audit.ReadRecent(5));
        // A new click (new key) is checked against the queue as before.
        Assert.Equal("Rejected", Json(await Act(rig, rig.AdminUser, "RadarrMainZ", "dl2", "remove")).GetProperty("status").GetString());
    }

    [Fact]
    public async Task AdminAnswersAreNeverStoredByASharedCache()
    {
        using var rig = new Rig();
        await rig.Warm();
        var c = rig.Controller(rig.AdminUser);
        foreach (var (name, call) in new (string, Func<Task<IActionResult>>)[]
        {
            ("overview", () => c.GetOverview(default)), ("activity", () => c.GetActivity(default)), ("system", () => c.GetSystem(default)),
            ("action", () => c.QueueActionRun(new QueueActionRequest { InstanceId = rig.Instance("RadarrMainZ").Id, DownloadId = "dl1", Action = "search", IdempotencyKey = "k1" }, default)),
            ("confirm", () => c.Confirm(new QueueConfirmRequest { InstanceId = rig.Instance("RadarrMainZ").Id, DownloadId = "dl1" }, default)),
        })
        {
            Assert.True((await Send(call)).Status == 200, name);
        }
        // The header comes from the controller's result filter, on every answer (the real pipeline: ApiArrBodyLimitTests).
        Assert.NotNull(typeof(ArrAdminHubController).GetCustomAttribute<Jellyfin.Plugin.JellyfinEnhanced.Helpers.PrivateResponseAttribute>());
    }

    [Fact]
    public async Task ARemovalWhoseNewSearchCouldNotBeStartedSaysSoEverywhere()
    {
        using var rig = new Rig();
        await rig.Warm();
        // The DELETE works; the search command after it is refused.
        rig.Radarr.CommandFailWith = 500;
        var reply = Json(await Act(rig, rig.AdminUser, "RadarrMainZ", "dl2", "remove", blocklist: false, search: true));
        Assert.Equal("Succeeded", reply.GetProperty("status").GetString());
        var readBack = reply.GetProperty("readBack").GetString()!;
        Assert.StartsWith("Removed from the queue; the new search could not be started: ", readBack, StringComparison.Ordinal);
        var audit = rig.Audit.ReadRecent(5).Single();
        Assert.Equal(("succeeded", "failed"), (audit.Outcome, audit.Details!["search"]));
        Assert.Equal(readBack, audit.ReadBack);
        // Jellyfin's activity log line carries it, as a warning.
        var activity = ArrActivityMirror.ToActivity(audit);
        Assert.Contains("the new search could not be started", activity.ShortOverview, StringComparison.Ordinal);
        Assert.Equal(LogLevel.Warning, activity.LogSeverity);
    }

    [Fact]
    public async Task ASeasonPackIsRemovedAsOneDownloadAndSearchedByItsEpisodes()
    {
        using var rig = new Rig();
        await rig.Warm();
        var search = Json(await Act(rig, rig.AdminUser, "SonarrZ", "pack", "search"));
        Assert.Equal("Succeeded", search.GetProperty("status").GetString());
        var command = JsonNode.Parse(rig.Sonarr.Writes.Single().Body)!;
        Assert.Equal("EpisodeSearch", (string?)command["name"]);
        Assert.Equal(new[] { 11, 12, 13 }, command["episodeIds"]!.AsArray().Select(n => (int)n!).OrderBy(n => n));
        await Act(rig, rig.AdminUser, "SonarrZ", "pack", "remove");
        var write = rig.Sonarr.Writes.Last();
        Assert.Equal("/api/v3/queue/bulk?removeFromClient=false&blocklist=false&skipRedownload=true", write.Path);
        Assert.Equal(new[] { 11, 12, 13 }, JsonNode.Parse(write.Body)!["ids"]!.AsArray().Select(n => (int)n!).OrderBy(n => n));
        Assert.Empty(rig.Sonarr.Queue);
    }

    [Fact]
    public async Task RemoveWithDataNeedsAFreshTokenForThisAdministratorAndThisDownload()
    {
        using var rig = new Rig();
        await rig.Warm();
        // No token: refused before any call, audited.
        var none = Json(await Act(rig, rig.AdminUser, "RadarrMainZ", "dl2", "remove_with_data"));
        Assert.Equal("Rejected", none.GetProperty("status").GetString());
        Assert.Empty(rig.Radarr.Writes);
        Assert.Equal(("queue.remove_with_data", "rejected", "confirmation_required", 3), rig.Audit.ReadRecent(1).Select(a => (a.Action, a.Outcome, a.Error, a.Tier)).Single());

        // Step one: what it covers and a token. Members can't get one.
        var c = rig.Controller(rig.AdminUser);
        var confirm = Json(await Send(() => c.Confirm(new QueueConfirmRequest { InstanceId = rig.Instance("RadarrMainZ").Id, DownloadId = "dl2" }, default)));
        var token = confirm.GetProperty("token").GetString()!;
        Assert.Equal(("Sintel", "dl2"), (confirm.GetProperty("download").GetProperty("title").GetString(), confirm.GetProperty("download").GetProperty("downloadId").GetString()));
        Assert.Equal(403, (await Send(() => rig.Controller(rig.Member).Confirm(new QueueConfirmRequest { InstanceId = rig.Instance("RadarrMainZ").Id, DownloadId = "dl2" }, default))).Status);
        Assert.Equal(404, (await Send(() => c.Confirm(new QueueConfirmRequest { InstanceId = rig.Instance("RadarrMainZ").Id, DownloadId = "nope" }, default))).Status);

        // Another administrator can't use it (and it is spent).
        Assert.Equal("Rejected", Json(await Act(rig, rig.OtherAdmin, "RadarrMainZ", "dl2", "remove_with_data", token: token)).GetProperty("status").GetString());
        Assert.Equal("confirmation_mismatch", rig.Audit.ReadRecent(1).Single().Error);
        Assert.Equal("Rejected", Json(await Act(rig, rig.AdminUser, "RadarrMainZ", "dl2", "remove_with_data", token: token)).GetProperty("status").GetString());
        Assert.Equal("confirmation_invalid_or_expired", rig.Audit.ReadRecent(1).Single().Error);
        // A token for another download doesn't work either.
        var other = Json(await Send(() => c.Confirm(new QueueConfirmRequest { InstanceId = rig.Instance("RadarrMainZ").Id, DownloadId = "dl1" }, default))).GetProperty("token").GetString();
        Assert.Equal("Rejected", Json(await Act(rig, rig.AdminUser, "RadarrMainZ", "dl2", "remove_with_data", token: other)).GetProperty("status").GetString());
        Assert.Empty(rig.Radarr.Writes);

        // A fresh token for this download: removed with the client's data.
        token = Json(await Send(() => c.Confirm(new QueueConfirmRequest { InstanceId = rig.Instance("RadarrMainZ").Id, DownloadId = "dl2" }, default))).GetProperty("token").GetString()!;
        var done = Json(await Act(rig, rig.AdminUser, "RadarrMainZ", "dl2", "remove_with_data", blocklist: true, token: token));
        Assert.Equal("Succeeded", done.GetProperty("status").GetString());
        Assert.Equal("/api/v3/queue/2?removeFromClient=true&blocklist=true&skipRedownload=true", Assert.Single(rig.Radarr.Writes).Path);
        var audit = rig.Audit.ReadRecent(1).Single();
        Assert.Equal(("queue.remove_with_data", "succeeded", 3, "yes"), (audit.Action, audit.Outcome, audit.Tier, audit.Details!["deleteData"]));
        // Every attempt left a line: 1 missing + 2 bad tokens + 1 other-download + 1 done.
        Assert.Equal(5, rig.Audit.ReadRecent(50).Count(a => a.Action == "queue.remove_with_data"));
    }

    [Fact]
    public async Task AnExpiredPartialQueueIsRefusedBeforeItsDetailsAreReadOrATokenIsIssued()
    {
        using var rig = new Rig();
        ShortQueueWithAPack(rig);
        await rig.Warm();
        var tv = rig.Instance("SonarrZ");
        Assert.True((await rig.Store.GetQueueAsync(tv, default)).Value!.Incomplete);
        rig.Arr.Now += TimeSpan.FromMinutes(11);
        rig.Sonarr.FailWith = 503;
        await rig.Store.RefreshForEventAsync(tv.Id, ArrSnapshotKind.Queue, force: true);
        Assert.True((await rig.Store.GetQueueAsync(tv, default)).Expired);
        var details = rig.Arr.CallCount("sonarr.lan", "/api/v3/queue/details");
        Assert.Null(await rig.Queue.FindAsync(tv.Id, "bigpack", default));
        var (confirmation, changing) = await rig.Queue.ConfirmAsync(rig.AdminUser, tv.Id, "bigpack", default);
        Assert.Null(confirmation);
        Assert.False(changing);
        var refused = Json(await Act(rig, rig.AdminUser, "SonarrZ", "bigpack", "remove"));
        Assert.Equal("Rejected", refused.GetProperty("status").GetString());
        Assert.Equal("queue_unreadable", Assert.Single(rig.Audit.ReadRecent(1)).Error);
        Assert.Equal(details, rig.Arr.CallCount("sonarr.lan", "/api/v3/queue/details"));
        Assert.Empty(rig.Sonarr.Writes);
    }

    [Fact]
    public async Task NoQueueActionRunsOnADownloadFromAQueueThatCantBeRead()
    {
        using var rig = new Rig();
        await rig.Warm();
        var radarr = rig.Instance("RadarrMainZ");
        var c = rig.Controller(rig.AdminUser);
        // Radarr's queue stops answering for longer than its serving limit (10 minutes).
        rig.Radarr.FailWith = 503;
        rig.Arr.Now = rig.Arr.Now.AddMinutes(11);
        for (var i = 0; i < 300 && !(await rig.Store.GetQueueAsync(radarr, default)).Expired; i++) await Task.Delay(10);
        Assert.True((await rig.Store.GetQueueAsync(radarr, default)).Expired);
        // The Sintel download read 11 minutes ago: refused before any call, audited; no Tier-3 token.
        var refused = Json(await Act(rig, rig.AdminUser, "RadarrMainZ", "dl2", "remove"));
        Assert.Equal("Rejected", refused.GetProperty("status").GetString());
        Assert.Equal(("queue.remove", "rejected", "queue_unreadable"), rig.Audit.ReadRecent(1).Select(a => (a.Action, a.Outcome, a.Error)).Single());
        Assert.Equal(404, (await Send(() => c.Confirm(new QueueConfirmRequest { InstanceId = radarr.Id, DownloadId = "dl2" }, default))).Status);
        Assert.Equal(0, rig.Arr.CallCount("radarr.lan", "queue/2"));
        // The Activity tab lists what was last read, with no actions on it.
        var activity = Json(await Send(() => c.GetActivity(default)));
        var sintel = activity.GetProperty("queue").EnumerateArray().Single(g => g.GetProperty("downloadId").GetString() == "dl2");
        Assert.Equal(0, sintel.GetProperty("actions").GetArrayLength());
        Assert.Contains(activity.GetProperty("queue").EnumerateArray(), g => g.GetProperty("instanceId").GetString() == rig.Instance("SonarrZ").Id && g.GetProperty("actions").GetArrayLength() > 0);

        // Readable again: offered and run.
        rig.Radarr.FailWith = 0;
        await rig.Store.RefreshForEventAsync(radarr.Id, ArrSnapshotKind.Queue, force: true);
        Assert.Equal("Succeeded", Json(await Act(rig, rig.AdminUser, "RadarrMainZ", "dl2", "remove")).GetProperty("status").GetString());
    }

    [Fact]
    public async Task EveryActionAndRefusalLeavesAnAuditRowAndRetryImportUsesTheArrsCommand()
    {
        using var rig = new Rig();
        await rig.Warm();
        // Retry import isn't offered for a blocked import (the arr says it needs a person): refused, audited.
        var refused = Json(await Act(rig, rig.AdminUser, "RadarrMainZ", "dl1", "retry_import"));
        Assert.Equal("Rejected", refused.GetProperty("status").GetString());
        Assert.Equal(("queue.retry_import", "rejected", "not_available"), rig.Audit.ReadRecent(1).Select(a => (a.Action, a.Outcome, a.Error)).Single());
        Assert.Equal("Rejected", Json(await Act(rig, rig.AdminUser, "RadarrMainZ", "gone", "remove")).GetProperty("status").GetString());
        Assert.Equal(("queue.remove", "not_in_queue"), rig.Audit.ReadRecent(1).Select(a => (a.Action, a.Error)).Single());

        // An import the arr is waiting on: retry is its own RefreshMonitoredDownloads command.
        var pending = FakeArr.RadarrQueueRow(3, 45745, "Sintel", state: "importPending", status: "warning");
        rig.Radarr.Queue.Add(pending);
        await rig.Store.RefreshForEventAsync(rig.Instance("RadarrMainZ").Id, ArrSnapshotKind.Queue, true);
        var retried = Json(await Act(rig, rig.AdminUser, "RadarrMainZ", "dl3", "retry_import"));
        Assert.Equal(("Succeeded", "Finished."), (retried.GetProperty("status").GetString(), retried.GetProperty("readBack").GetString()));
        Assert.Equal("RefreshMonitoredDownloads", (string?)JsonNode.Parse(rig.Radarr.Writes.Single().Body)!["name"]);

        // Search for a title no longer in the queue (a failed download): the audited Search now.
        var c = rig.Controller(rig.AdminUser);
        var search = Json(await Send(() => c.Search(new ManageSearchRequest { InstanceId = rig.Instance("RadarrMainZ").Id, Key = "movie:tmdb:438631", IdempotencyKey = "k1" }, default)));
        Assert.Equal("Succeeded", search.GetProperty("status").GetString());
        Assert.Equal(400, (await Send(() => c.Search(new ManageSearchRequest { InstanceId = rig.Instance("RadarrMainZ").Id, Key = "nonsense", IdempotencyKey = "k2" }, default))).Status);

        var actions = rig.Audit.ReadRecent(50).Select(a => a.Action).ToList();
        Assert.Contains("queue.retry_import", actions);
        Assert.Contains("queue.remove", actions);
        Assert.Contains("movie.search", actions);
        Assert.All(rig.Audit.ReadRecent(50), a => Assert.Equal(rig.AdminUser.UserId.ToString("N"), a.UserId));
    }

    [Fact]
    public async Task ScanNowIsAuditedRefusesPathsOutsideJellyfinAndValidatesItsInput()
    {
        using var rig = new Rig();
        await rig.Warm();
        rig.Library.AddFile("/media/movies/Dune (2021)/Dune.mkv", indexed: false, kind: "movie");
        var c = rig.Controller(rig.AdminUser);
        var id = rig.Instance("RadarrMainZ").Id;
        var ok = Json(await Send(() => c.Scan(new BridgeScanRequest { InstanceId = id, Path = "/data/movies/Dune (2021)/Dune.mkv", IdempotencyKey = "s1" }, default)));
        Assert.Equal(("Succeeded", "refreshed"), (ok.GetProperty("status").GetString(), ok.GetProperty("scan").GetProperty("outcome").GetString()));
        Assert.Single(rig.Library.Refreshes);
        var outside = Json(await Send(() => c.Scan(new BridgeScanRequest { InstanceId = id, Path = "/srv/secret/x.mkv", IdempotencyKey = "s2" }, default)));
        Assert.Equal("Failed", outside.GetProperty("status").GetString());
        Assert.Equal(new[] { ("jellyfin.scan", "failed"), ("jellyfin.scan", "succeeded") }, rig.Audit.ReadRecent(2).Select(a => (a.Action, a.Outcome)));
        // Traversal in any spelling (backslashes, a trailing ".." with spaces, "." segments) is refused before it is mapped.
        foreach (var bad in new[] { "relative/path", "/data/../etc/passwd", "", new string('a', 2000), "/data/movies\\..\\..\\etc\\passwd", "/data/movies/.. ", "/data/movies/ ../x.mkv", "/data/./movies/x.mkv", "C:\\data\\..\\x" })
            Assert.Equal(400, (await Send(() => c.Scan(new BridgeScanRequest { InstanceId = id, Path = bad, IdempotencyKey = "s3" }, default))).Status);
        Assert.Equal(404, (await Send(() => c.Scan(new BridgeScanRequest { InstanceId = "unknown", Path = "/data/movies/x.mkv", IdempotencyKey = "s4" }, default))).Status);
        Assert.Equal(2, rig.Audit.ReadRecent(10).Count(a => a.Action == "jellyfin.scan"));
        Assert.Equal("/data/movies/Dune (2021)/Dune.mkv", ArrAdminHubController.ScanPath("  /data\\movies\\Dune (2021)\\Dune.mkv "));
    }

    [Fact]
    public async Task ActionsAreMirroredIntoJellyfinsActivityLogWhileTheSettingIsOn()
    {
        using var rig = new Rig();
        await rig.Warm();
        var written = new List<ActivityLog>();
        var mirror = new ArrActivityMirror(rig.Audit, log => { lock (written) written.Add(log); return Task.CompletedTask; }, () => rig.Arr.Plugin.Plugin.Configuration, null);
        mirror.Subscribe();
        mirror.Subscribe();
        await Act(rig, rig.AdminUser, "RadarrMainZ", "dl2", "remove", blocklist: true);
        for (var i = 0; i < 100 && written.Count == 0; i++) await Task.Delay(10);
        var log = Assert.Single(written);
        Assert.Equal(ArrActivityMirror.ActivityType, log.Type);
        Assert.Equal(rig.AdminUser.UserId, log.UserId);
        Assert.Contains("Remove from queue", log.Name, StringComparison.Ordinal);
        Assert.Contains("Sintel (2010)", log.Name, StringComparison.Ordinal);
        Assert.Contains("RadarrMainZ", log.Name, StringComparison.Ordinal);
        Assert.Equal(LogLevel.Information, log.LogSeverity);
        Assert.DoesNotContain("KEY", log.Overview ?? string.Empty, StringComparison.Ordinal);

        rig.Arr.Plugin.Plugin.Configuration.ArrActivityLogMirror = false;
        await Act(rig, rig.AdminUser, "SonarrZ", "pack", "search");
        await Task.Delay(100);
        Assert.Single(written);
        Assert.Equal(LogLevel.Warning, ArrActivityMirror.ToActivity(new ArrAuditEntry { Action = "queue.remove_with_data", Outcome = "rejected", Target = "download:x", UserId = Guid.Empty.ToString("N") }).LogSeverity);
        await mirror.StopAsync(default);
    }

    [Fact]
    public async Task AStatusTurnsToOkdButNotInAnyArrAsSoonAsTheGracePassesNotAtTheNextCacheBucket()
    {
        using var rig = new Rig();
        // OK'd 10 minutes ago; grace 15 minutes.
        rig.Seerr.Requests.Clear();
        rig.Seerr.Requests.Add(FakeSeerr.Request(1, "movie", 27205, 2, rig.Member.UserId, rig.Arr.Now.UtcDateTime.AddMinutes(-20), rig.Arr.Now.UtcDateTime.AddMinutes(-10), userName: "Emma"));
        await rig.Warm();
        async Task<string> Code(StatusViewer v)
        {
            var c = new ArrStatusController(rig.Status) { ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext() } };
            c.HttpContext.User = new ClaimsPrincipal(new ClaimsIdentity([new Claim("Jellyfin-UserId", v.UserId.ToString())], "test"));
            var reply = await Send(() => c.GetStatuses(null, "movie:tmdb:27205", default));
            return Json(reply).GetProperty("items")[0].GetProperty("reason").GetProperty("code").GetString()!;
        }
        Assert.Equal(StatusReasonCode.Approved, await Code(rig.AdminUser));
        // Six minutes later (the same ten-minute time bucket): the grace has passed for the admin.
        rig.Arr.Now = rig.Arr.Now.AddMinutes(6);
        Assert.Equal(StatusReasonCode.ApprovedNotInArr, await Code(rig.AdminUser));
        Assert.Equal(StatusReasonCode.Approved, await Code(rig.Member));
        var overview = Json(await Send(() => rig.Controller(rig.AdminUser).GetOverview(default)));
        Assert.Contains(overview.GetProperty("needsAttention").EnumerateArray(), i => i.GetProperty("code").GetString() == AttentionCode.ApprovedNotInArr && i.GetProperty("message").GetString() == "Emma");
    }

    [Fact]
    public async Task AQueueThatKeepsChangingWhileItIsReadIsNoInstanceDown()
    {
        using var rig = new Rig();
        // More than one page of Sonarr queue, and every read sees the last row jump to the front
        // between page 1 and page 2 (imports and grabs reorder a queue sorted by time left).
        // 501 rows: page 2 holds one row, so the moved row leaves page 2 holding only a repeat.
        for (var i = 100; i < 598; i++) rig.Sonarr.Queue.Add(FakeArr.SonarrQueueRow(i, "dl" + i, 1, i, "Peacemaker", 391153));
        await rig.Warm();
        rig.Sonarr.BeforePage = (path, page) =>
        {
            if (path != "/api/v3/queue" || page != 2) return;
            var last = rig.Sonarr.Queue[^1];
            rig.Sonarr.Queue.RemoveAt(rig.Sonarr.Queue.Count - 1);
            rig.Sonarr.Queue.Insert(0, last);
        };
        var sonarr = rig.Instance("SonarrZ");
        async Task RefreshQueue()
        {
            rig.Store.RequestRefresh(sonarr.Id, ArrSnapshotKind.Queue);
            rig.Arr.Now += TimeSpan.FromSeconds(3);
            await Task.WhenAll(rig.Store.Tick());
            for (var i = 0; i < 200 && rig.Store.Describe().Instances.Any(x => x.Snapshots.Any(s => s.Refreshing)); i++) await Task.Delay(10);
        }
        static bool Down(JsonElement overview) => overview.GetProperty("needsAttention").EnumerateArray().Any(i => i.GetProperty("code").GetString() == AttentionCode.InstanceDown);

        // Kept over the changing read, then (once that is old) the changing read itself: never "can't be read".
        foreach (var wait in new[] { TimeSpan.FromMinutes(1), ArrStateStore.QueueKeepHeld })
        {
            rig.Arr.Now += wait;
            await RefreshQueue();
            var read = await rig.Store.GetQueueAsync(sonarr, default);
            Assert.Null(read.Error);
            Assert.Equal(wait == ArrStateStore.QueueKeepHeld, read.Value!.Incomplete);
            Assert.False(Down(Json(await Send(() => rig.Controller(rig.AdminUser).GetOverview(default)))));
        }
        Assert.True(rig.Store.PeekQueue(sonarr.Id)!.Incomplete);
    }

    [Fact]
    public async Task TheRequestsPageSwitchesTheAdminTabsOnForAdministratorsOnly()
    {
        using var rig = new Rig();
        await rig.Warm();
        async Task<JsonElement> HubFor(StatusViewer v)
        {
            var c = new RequestsHubController(rig.Hub, rig.Manage) { ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext() } };
            c.HttpContext.User = new ClaimsPrincipal(new ClaimsIdentity([new Claim("Jellyfin-UserId", v.UserId.ToString())], "test"));
            return Json(await Send(() => c.GetHub(default)));
        }
        Assert.True((await HubFor(rig.AdminUser)).GetProperty("admin").GetProperty("hub").GetBoolean());
        Assert.False((await HubFor(rig.Member)).TryGetProperty("admin", out _));
        rig.Arr.Plugin.Plugin.Configuration.ArrPhase2Enabled = false;
        Assert.False((await HubFor(rig.AdminUser)).GetProperty("admin").GetProperty("hub").GetBoolean());
    }
}

/// <summary>Shared helper: adds a path mapping to every instance row of a JSON list.</summary>
internal static class IntegrationArrBridgeTestsAccess
{
    public static string WithMapping(string json, string arr, string jf)
    {
        var rows = JsonNode.Parse(json)!.AsArray();
        foreach (var row in rows) row!["PathMappings"] = new JsonArray(new JsonObject { ["ArrPath"] = arr, ["JellyfinPath"] = jf });
        return rows.ToJsonString();
    }
}
