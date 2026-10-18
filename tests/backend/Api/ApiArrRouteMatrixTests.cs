using System.Reflection;
using System.Security.Claims;
using System.Text.Json;
using Jellyfin.Data;
using Jellyfin.Plugin.JellyfinEnhanced.Controllers;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Notify;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr.Live;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Backup;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Routing;
using Moq;

namespace JE.Tests;

/// <summary>
/// Who may call each arr, acquire, notify and JE backup route (the checked-in table
/// <c>Api/ArrRoutes.json</c>, which tests/host/run.py runs against real Jellyfin servers too):
/// the table lists exactly the routes there are; every route signs in except the webhook;
/// every administrators' route of the "Requests &amp; downloads" controllers refuses a member, an
/// API key and a user Jellyfin doesn't know; every per-user route refuses an API key and an unknown
/// user (403 <c>user_required</c>) and stores or sends nothing for them.
/// </summary>
[Collection("Plugin singleton")]
public class ApiArrRouteMatrixTests
{
    private static readonly string[] Prefixes = { "arr/", "acquire/", "admin/backup", "admin/secrets" };

    internal sealed record Row(string Method, string Route, string Access);

    internal static IReadOnlyList<Row> Table()
    {
        using var doc = JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Api", "ArrRoutes.json")));
        return doc.RootElement.GetProperty("routes").EnumerateArray()
            .Select(r => new Row(r.GetProperty("method").GetString()!, r.GetProperty("route").GetString()!, r.GetProperty("access").GetString()!))
            .ToList();
    }

    /// <summary>Every action of the plugin under the table's prefixes, one entry per HTTP method attribute.</summary>
    internal static IReadOnlyList<(string Method, string Route, MethodInfo Action)> Actions()
        => typeof(ArrAdminController).Assembly.GetTypes()
            .Where(t => typeof(ControllerBase).IsAssignableFrom(t) && !t.IsAbstract)
            .SelectMany(t => t.GetMethods(BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly))
            .SelectMany(m => m.GetCustomAttributes<HttpMethodAttribute>().SelectMany(a => a.HttpMethods.Select(h => (Method: h, Route: a.Template ?? string.Empty, Action: m))))
            .Where(x => Prefixes.Any(p => x.Route.StartsWith(p, StringComparison.Ordinal)))
            .ToList();

    [Fact]
    public void TheTableListsEveryRouteAndOnlyRoutesThatExist()
    {
        var table = Table();
        var actual = Actions().Select(a => a.Method + " " + a.Route).ToHashSet(StringComparer.Ordinal);
        var listed = table.Select(r => r.Method + " " + r.Route).ToList();
        Assert.Equal(listed.Count, listed.Distinct(StringComparer.Ordinal).Count());
        Assert.Empty(actual.Except(listed));      // a new route must be added to the table
        Assert.Empty(listed.Except(actual));      // a removed or renamed route must leave it
        Assert.All(table, r => Assert.Contains(r.Access, new[] { "anonymous-secret", "user", "admin", "legacy-user", "legacy-admin" }));
    }

    [Fact]
    public void EveryRouteDocumentsHouseholdRolesAndEditionCapability()
    {
        using var table = JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Api", "ArrRoutes.json")));
        foreach (var row in table.RootElement.GetProperty("routes").EnumerateArray())
            foreach (var column in new[] { "Member", "Manager", "Kid", "requests.4k", "capability" })
                Assert.False(string.IsNullOrWhiteSpace(row.GetProperty(column).GetString()));
    }

    [Fact]
    public void EveryRouteSignsInExceptTheSecretCheckedWebhook()
    {
        var access = Table().ToDictionary(r => r.Method + " " + r.Route, r => r.Access, StringComparer.Ordinal);
        foreach (var (method, route, action) in Actions())
        {
            var anonymous = action.GetCustomAttribute<AllowAnonymousAttribute>() != null;
            Assert.True(access[method + " " + route] == "anonymous-secret" ? anonymous : !anonymous && action.GetCustomAttribute<AuthorizeAttribute>() != null, route);
        }
    }

    // ------------------------------------------------------------------ callers

    /// <summary>Every "Requests &amp; downloads" controller over one notifications rig (also used by the body-cap tests).</summary>
    internal sealed class Rig : IDisposable
    {
        public IntegrationNotificationsTests.Rig N { get; }
        public TestCallers Callers { get; } = new();
        public ArrAuditLog Audit { get; }
        public ArrActionRunner Runner { get; }
        public ArrManageService Manage { get; }
        public ArrQueueActionService Queue { get; }
        public RequestsHubService Hub { get; }
        public ArrLiveRouter Router { get; }
        public ArrWebhookReceiver Receiver { get; }
        public ArrWebhookProvisioner Provisioner { get; }
        public ArrLiveService Live { get; }
        public JeBackupService Backup { get; }
        private readonly string _backupRoot;

        public Rig(IntegrationNotificationsTests.Rig n)
        {
            N = n;
            var c = n.Config;
            c.ArrNotificationsEnabled = true;
            c.DownloadsPageEnabled = true;
            c.CalendarPageEnabled = true;
            Callers.Register(n.Admin.UserId, admin: true, "admin");
            Callers.Register(n.Emma.UserId, admin: false, "emma");
            Audit = new ArrAuditLog(Path.Combine(n.Arr.Plugin.Core.Root, ArrAuditLog.FileName), 1024 * 1024, 2);
            Runner = new ArrActionRunner(Audit, new ArrConfirmationTokens());
            Manage = new ArrManageService(n.Status, n.Arr.Factory, Runner, Audit, n.Requests, null, n.Feed, () => n.Config, (_, _) => Task.CompletedTask);
            Queue = new ArrQueueActionService(n.Store, n.Arr.Factory, Runner, Audit, n.Feed);
            Hub = new RequestsHubService(n.Status, n.Requests, () => n.Config);
            Router = new ArrLiveRouter(n.Store, n.Arr.Plugin.Core.Logger, TimeSpan.FromMilliseconds(10));
            Receiver = new ArrWebhookReceiver(n.Arr.Registry, () => n.Arr.Plugin.Plugin.Secrets, Router, null);
            Provisioner = new ArrWebhookProvisioner(n.Arr.Factory, Runner, Receiver);
            var tracker = new ArrChangeTracker(n.Store, n.Feed, Router, null, null, () => n.Config);
            Live = new ArrLiveService(n.Store, Router, tracker, null, () => n.Config, (_, _, _) => throw new ArrLiveConnectException("not in tests"), null, null);
            _backupRoot = Path.Combine(n.Arr.Plugin.Core.Root, "backup-matrix");
            Directory.CreateDirectory(_backupRoot);
            File.WriteAllText(Path.Combine(_backupRoot, "config.xml"), "<PluginConfiguration />");
            Backup = new JeBackupService(_backupRoot, Path.Combine(_backupRoot, "config.xml"), () => n.Arr.Plugin.Plugin.Secrets, n.Arr.Plugin.Core.Logger);
        }

        /// <summary>A fresh controller of every "Requests &amp; downloads" kind for one caller.</summary>
        public IEnumerable<ControllerBase> Controllers(ClaimsPrincipal caller)
        {
            var users = Callers.Users.Object;
            var logger = N.Arr.Plugin.Core.Logger;
            var all = new ControllerBase[]
            {
                new ArrAdminController(N.Arr.Factory, Audit, users, logger),
                new ArrStateController(N.Store, users),
                new ArrStatusController(N.Status),
                new AcquireRequestsController(new ServicesForRequests(N).Service),
                new AcquireDiscoverController(IntegrationRequestDiscoverTests.Offline(new ServicesForRequests(N).Service)),
                Household(new ServicesForRequests(N).Service),
                new AcquireCollectionsController(new ServicesForRequests(N).Service, null),
                new AcquireMigrationController(new ServicesForRequests(N).Migration, N.View),
                new RequestsHubController(Hub, Manage),
                new ArrAdminHubController(N.Hub, Queue, N.Bridge, Runner, N.Status, Manage),
                new NotifyController(N.Service, N.Dispatcher, new NtfySender(N.Ntfy), new EmailSender(N.Mail), N.Users) { Config = () => N.Config, Now = () => N.Arr.Now },
                new ArrLiveController(N.Feed, new ArrFeedLimits(), new ApiArrRoutesTests.KeyAudience(), Receiver, Provisioner, Live, Router, N.Store, Audit, users, logger, N.Requests) { Config = () => N.Config },
                new JeBackupController(Backup, users, logger),
                new ArrAddController(new Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests.ArrAddService(N.Store, N.Arr.Factory, new ServicesForRequests(N).Service, () => N.Config)),
                new ArrAdminAutomationController(new Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Automation.AutomationStatusService(
                    new Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Automation.AutomationStore(N.Db),
                    new Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Automation.AutomationBudgets(N.Db, () => N.Config, () => N.Arr.Now),
                    N.Store, new IntegrationRequestHouseholdTests.FakeDirectory(), () => N.Config, () => N.Arr.Now), N.View),
            };
            foreach (var controller in all)
            {
                controller.ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext() };
                controller.HttpContext.User = caller;
                yield return controller;
            }
        }

        /// <summary>The household routes over an empty directory and an offline TMDB (no title data).</summary>
        private AcquireHouseholdController Household(Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests.RequestService service)
        {
            var projection = new Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests.RequestHubProjection(service, new IntegrationRequestHouseholdTests.FakeDirectory(), null,
                (_, _, _) => Task.FromResult<Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests.HubTitleMeta?>(null), () => N.Arr.Now);
            return new AcquireHouseholdController(projection, new Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests.HouseholdService(projection, N.Feed, _ => { }));
        }

        private sealed class ServicesForRequests
        {
            public Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests.RequestService Service { get; }
            public Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests.SeerrMigration Migration { get; }
            public ServicesForRequests(IntegrationNotificationsTests.Rig n)
            {
                var policy = new IntegrationRequestLedgerTests.Policy();
                foreach (var viewer in new[] { n.Admin, n.Emma })
                    policy.People[viewer.UserId] = new(viewer.UserId, viewer.IsAdmin ? "Admin" : "Member", true, viewer.IsAdmin, viewer.IsAdmin, true, "p", "je", "", "", 7, 7, 0, "null");
                var ledger = new Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests.RequestLedger(n.Db);
                Service = new(ledger, policy, n.View, n.Feed, () => n.Arr.Now);
                // Seerr reads go to an address that never answers; no route here may reach it for a non-admin.
                var seerr = new IntegrationTransport((_, _) => Task.FromResult(IntegrationTransport.Response("{}", 404)));
                Migration = new(new Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests.SeerrMigrationReader(seerr), ledger, policy, n.View, null, n.Feed,
                    () => n.Config, () => { }, () => n.Arr.Now);
            }
        }

        public void Dispose()
        {
            N.Dispose();
        }
    }

    private sealed record Reply(int Status, string Body);

    private static async Task<Reply> Call(ControllerBase controller, MethodInfo action)
    {
        var args = action.GetParameters().Select(p =>
            p.ParameterType == typeof(CancellationToken) ? CancellationToken.None
            : p.HasDefaultValue ? p.DefaultValue
            : p.ParameterType.IsValueType && Nullable.GetUnderlyingType(p.ParameterType) == null ? Activator.CreateInstance(p.ParameterType)
            : null).ToArray();
        var raw = action.Invoke(controller, args);
        var result = raw is Task<IActionResult> task ? await task : (IActionResult)raw!;
        return result switch
        {
            ForbidResult => new Reply(403, string.Empty),
            ObjectResult o => new Reply(o.StatusCode ?? 200, JsonSerializer.Serialize(o.Value)),
            StatusCodeResult code => new Reply(code.StatusCode, string.Empty),
            FileContentResult => new Reply(200, string.Empty),
            FileStreamResult => new Reply(200, string.Empty),
            _ => new Reply(-1, result.GetType().Name),
        };
    }

    /// <summary>Every action of the controllers as one caller, with empty arguments (null bodies), by table row.</summary>
    private static async Task<List<(Row Row, Reply Reply)>> CallAll(Rig rig, ClaimsPrincipal caller, params string[] accesses)
    {
        var table = Table().ToDictionary(r => r.Method + " " + r.Route, StringComparer.Ordinal);
        var replies = new List<(Row, Reply)>();
        foreach (var controller in rig.Controllers(caller))
        {
            foreach (var action in controller.GetType().GetMethods(BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly))
            {
                foreach (var attribute in action.GetCustomAttributes<HttpMethodAttribute>())
                {
                    var row = table[attribute.HttpMethods.Single() + " " + attribute.Template];
                    if (!accesses.Contains(row.Access)) continue;
                    replies.Add((row, await Call(rig.Controllers(caller).Single(c => c.GetType() == controller.GetType()), action)));
                }
            }
        }
        return replies;
    }

    [Fact]
    public async Task MembersApiKeysAndUnknownUsersAreRefusedOnEveryAdministratorsRoute()
    {
        using var rig = new Rig(await IntegrationNotificationsTests.Started());
        var auditBefore = rig.Audit.ReadRecent(500).Count(e => e.Outcome != "denied");
        var arrCalls = rig.N.Arr.Calls.Count;
        foreach (var (name, caller) in new[] { ("member", TestCallers.Principal(rig.N.Emma.UserId, admin: false)), ("API key", TestCallers.ApiKey()), ("unknown user", TestCallers.Unknown()) })
        {
            var replies = await CallAll(rig, caller, "admin");
            Assert.True(replies.Count >= 25, $"{name}: only {replies.Count} admin routes called");
            foreach (var (row, reply) in replies)
                Assert.True(reply.Status == 403, $"{name} {row.Method} {row.Route}: {reply.Status} {reply.Body}");
        }
        Assert.Equal(arrCalls, rig.N.Arr.Calls.Count);                       // nothing read from an arr
        Assert.Equal(auditBefore, rig.Audit.ReadRecent(500).Count(e => e.Outcome != "denied"));   // nothing done

        // The administrator gets through (the refusals above are the caller, not the arguments).
        var admin = await CallAll(rig, TestCallers.Principal(rig.N.Admin.UserId, admin: true), "admin");
        Assert.Contains(admin, r => r.Row.Route == "arr/admin/state" && r.Reply.Status == 200);
        Assert.Contains(admin, r => r.Row.Route == "arr/admin/hub/overview" && r.Reply.Status == 200);
        Assert.Contains(admin, r => r.Row.Route == "arr/admin/notify" && r.Row.Method == "GET" && r.Reply.Status == 200);
        Assert.Contains(admin, r => r.Row.Route == "arr/admin/instances" && r.Reply.Status == 200);
    }

    [Fact]
    public async Task ApiKeysAndUnknownUsersAreNoPersonOnPerUserRoutesAndNothingIsStoredOrSent()
    {
        using var rig = new Rig(await IntegrationNotificationsTests.Started());
        var pushes = rig.N.Pushes.Count;
        var mails = rig.N.Mail.Sent.Count;
        var unknown = TestCallers.Unknown();
        foreach (var (name, caller) in new[] { ("API key", TestCallers.ApiKey()), ("unknown user", unknown) })
        {
            var replies = await CallAll(rig, caller, "user");
            Assert.True(replies.Count >= 15, $"{name}: only {replies.Count} user routes called");
            foreach (var (row, reply) in replies)
                Assert.True(reply.Status == 403 && reply.Body.Contains("user_required", StringComparison.Ordinal), $"{name} {row.Method} {row.Route}: {reply.Status} {reply.Body}");
        }
        var stored = rig.N.NotifyStore.AllPrefs();
        Assert.False(stored.ContainsKey(Guid.Empty));
        Assert.False(stored.ContainsKey(Guid.Parse(UserHelper.GetCurrentUserId(unknown)!.Value.ToString())));
        Assert.Empty(rig.N.Service.FollowsOf(Guid.Empty).Follows);
        Assert.Equal((pushes, mails), (rig.N.Pushes.Count, rig.N.Mail.Sent.Count));

        // A member gets past the caller check (the refusals above are the caller, not the arguments).
        var member = await CallAll(rig, TestCallers.Principal(rig.N.Emma.UserId, admin: false), "user");
        Assert.Contains(member, r => r.Row.Route == "acquire/notify/inbox" && r.Reply.Status == 200);
        Assert.DoesNotContain(member, r => r.Reply.Body.Contains("user_required", StringComparison.Ordinal));
    }

    [Fact]
    public void TheCallerResolverCountsOnlyKnownPeople()
    {
        var callers = new TestCallers();
        var admin = callers.Register(Guid.NewGuid(), admin: true);
        var member = callers.Register(Guid.NewGuid(), admin: false);
        var users = callers.Users.Object;

        Assert.True(ArrCaller.IsApiKey(TestCallers.ApiKey()));
        Assert.Null(ArrCaller.PersonId(TestCallers.ApiKey()));
        // An API key is never a person, whatever user id it carries.
        var keyWithUser = new ClaimsPrincipal(new ClaimsIdentity([new Claim("Jellyfin-UserId", admin.Id.ToString()), new Claim(ClaimTypes.Role, "Administrator"), new Claim("Jellyfin-IsApiKey", "true")], "test"));
        Assert.Null(ArrCaller.PersonId(keyWithUser));
        Assert.False(ArrCaller.IsAdmin(keyWithUser, users));
        Assert.Null(ArrCaller.Human(TestCallers.ApiKey(), users));
        Assert.False(ArrCaller.IsAdmin(TestCallers.ApiKey(), users));               // the role claim alone isn't enough
        Assert.Null(ArrCaller.PersonId(TestCallers.Principal(Guid.Empty, admin: true)));
        Assert.False(ArrCaller.IsAdmin(TestCallers.Unknown(), users));
        Assert.True(ArrCaller.IsAdmin(TestCallers.Principal(admin.Id, admin: true), users));
        Assert.False(ArrCaller.IsAdmin(TestCallers.Principal(member.Id, admin: true), users));   // a forged role claim on a member
        Assert.Equal(member.Id, ArrCaller.Human(TestCallers.Principal(member.Id, admin: false), users)!.Id);

        // The status view and the notification users never ask Jellyfin for the empty GUID (12.2 throws).
        var view = new ArrJellyfinView(new Mock<ILibraryManager>().Object, users);
        Assert.Null(view.Viewer(Guid.Empty));
        Assert.Null(ArrCaller.Human(TestCallers.ApiKey(), view));
        Assert.True(ArrCaller.Admin(TestCallers.Principal(admin.Id, admin: false), view)!.IsAdmin);
        var notifyUsers = new JellyfinNotifyUsers(users, new Mock<ILibraryManager>().Object);
        Assert.False(notifyUsers.Exists(Guid.Empty));
        Assert.False(notifyUsers.IsActive(Guid.Empty));
        Assert.Null(notifyUsers.Name(Guid.Empty));
        // Disabling an account revokes route access and delivery eligibility, but keeps it from
        // being mistaken for a deleted user by housekeeping.
        admin.SetPermission(Jellyfin.Database.Implementations.Enums.PermissionKind.IsDisabled, true);
        var principal = TestCallers.Principal(admin.Id, admin: true);
        Assert.Null(ArrCaller.Human(principal, users));
        Assert.False(ArrCaller.IsAdmin(principal, users));
        Assert.Null(ArrCaller.Human(principal, view));
        Assert.Null(ArrCaller.Admin(principal, view));
        Assert.True(notifyUsers.Exists(admin.Id));
        Assert.False(notifyUsers.IsActive(admin.Id));
        callers.Users.Setup(m => m.GetUserById(admin.Id)).Throws(new InvalidOperationException("user lookup failed"));
        Assert.Null(ArrCaller.Human(principal, users));
        Assert.Null(ArrCaller.Human(principal, view));
        Assert.Throws<InvalidOperationException>(() => notifyUsers.Exists(admin.Id)); // no orphan purge on a lookup failure
    }

    [Fact]
    public async Task HousekeepingRemovesRowsAnOlderVersionStoredForTheEmptyGuid()
    {
        using var rig = await IntegrationNotificationsTests.Started();
        var callers = new TestCallers();
        callers.Register(rig.Emma.UserId, admin: false);
        var prefs = rig.NotifyStore.Prefs(Guid.Empty);
        prefs.NtfyTopic = "je-topic-zero";
        rig.NotifyStore.SavePrefs(Guid.Empty, prefs, rig.Arr.Now);
        rig.NotifyStore.SavePrefs(rig.Emma.UserId, rig.NotifyStore.Prefs(rig.Emma.UserId), rig.Arr.Now);
        var users = new JellyfinNotifyUsers(callers.Users.Object, new Mock<ILibraryManager>().Object);

        Assert.True(rig.NotifyStore.Purge(rig.Arr.Now, users.Exists) > 0);    // threw on the empty GUID before
        Assert.False(rig.NotifyStore.AllPrefs().ContainsKey(Guid.Empty));
        Assert.True(rig.NotifyStore.AllPrefs().ContainsKey(rig.Emma.UserId));
    }
}
