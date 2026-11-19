using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Features.MediaTags;
using Jellyfin.Plugin.JellyfinEnhanced.Features.MediaTags.Models;
using Jellyfin.Plugin.JellyfinEnhanced.Features.MediaTags.Services;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Globalization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.DependencyInjection;
using Moq;

namespace JE.Tests.Features.MediaTags;

/// <summary>
/// Approving a Reclaimerr deletion request with Reclaimerr's grace period, now, or on a day (upstream 1de354c0). An older
/// Reclaimerr ignores <c>scheduled_at</c> and deletes at once, so a day is only sent to one whose OpenAPI names the approve
/// body that takes it; omitting the field keeps the old call exactly. Upstream's tests of the service, then the same through
/// this tree's routes (the page's list and the approve route).
/// </summary>
[Collection("Plugin singleton")]
public sealed class IntegrationReclaimerrApprovalTimingTests : IDisposable
{
    private readonly ApiPluginFixture _f = new();
    private readonly Mock<ILibraryManager> _library = new();
    private readonly ILibraryManager? _previousLibrary = BaseItem.LibraryManager;
    private readonly List<TagCacheService> _caches = new();
    private static readonly DateTimeOffset Fixed = new(2026, 11, 20, 12, 0, 0, TimeSpan.Zero);

    public IntegrationReclaimerrApprovalTimingTests() => BaseItem.LibraryManager = _library.Object;

    public void Dispose()
    {
        foreach (var cache in _caches) cache.Dispose();
        BaseItem.LibraryManager = _previousLibrary!;
        _f.Dispose();
    }

    private sealed class Server : IDisposable
    {
        private readonly HttpListener _listener = new();
        public string Url { get; }
        public List<(string Method, string Path, string Body)> Seen { get; } = new();
        public bool Supports { get; set; }
        public Dictionary<string, string> Extra { get; } = new();

        public Server()
        {
            var probe = new TcpListener(IPAddress.Loopback, 0);
            probe.Start();
            var port = ((IPEndPoint)probe.LocalEndpoint).Port;
            probe.Stop();
            Url = $"http://127.0.0.1:{port}";
            _listener.Prefixes.Add(Url + "/");
            _listener.Start();
            _ = Task.Run(async () =>
            {
                while (true)
                {
                    HttpListenerContext context;
                    try { context = await _listener.GetContextAsync(); } catch { return; }
                    try
                    {
                        using var reader = new StreamReader(context.Request.InputStream);
                        var body = await reader.ReadToEndAsync();
                        var path = context.Request.Url!.PathAndQuery;
                        lock (Seen) Seen.Add((context.Request.HttpMethod, path, body));
                        var answer = Extra.TryGetValue(path, out var extra) ? extra
                            : path == "/openapi.json"
                            ? "{\"components\":{\"schemas\":{\"ReviewDeleteRequest\":{}" + (Supports ? ",\"ApproveDeleteRequest\":{}" : string.Empty) + "}}}"
                            : "{}";
                        var bytes = Encoding.UTF8.GetBytes(answer);
                        context.Response.ContentType = "application/json";
                        context.Response.ContentLength64 = bytes.Length;
                        await context.Response.OutputStream.WriteAsync(bytes);
                    }
                    catch { /* client gone */ }
                    finally { try { context.Response.Close(); } catch { } }
                }
            });
        }

        public List<(string Method, string Path, string Body)> All { get { lock (Seen) return Seen.ToList(); } }
        public List<(string Method, string Path, string Body)> Posts => All.Where(s => s.Method == "POST").ToList();

        public void Dispose() => _listener.Close();
    }

    private (ReclaimerrActions Actions, LeavingSoonService Leaving, TagCacheService Cache) Services(Server server)
    {
        var config = _f.Plugin.Configuration;
        config.ReclaimerrEnabled = true;
        config.LeavingSoonMaintainerrActions = true;
        config.ReclaimerrUrl = server.Url;
        config.ReclaimerrToken = "rcl_token";
        config.ReclaimerrUsername = "jellyfin-enhanced";
        config.ReclaimerrActAsUser = true;
        var services = new ServiceCollection();
        LeavingSoonService.AddHttpClient(services);
        var clients = services.BuildServiceProvider().GetRequiredService<IHttpClientFactory>();
        var leaving = new LeavingSoonService(clients, Path.Combine(_f.Core.Root, "leaving-soon.json"), _library.Object, _f.Core.Logger) { Timeout = TimeSpan.FromSeconds(5) };
        var cache = new TagCacheService(_library.Object, _f.Core.Paths.Object, Mock.Of<ILocalizationManager>(), _f.Core.Logger, new MatroskaLanguageCache(_f.Core.Paths.Object, _f.Core.Logger), leavingSoonService: leaving);
        _caches.Add(cache);
        var actions = new ReclaimerrActions(clients, leaving, cache, _f.Core.Logger) { Timeout = TimeSpan.FromSeconds(5), Now = () => Fixed };
        return (actions, leaving, cache);
    }

    private ReclaimerrActions Actions(Server server) => Services(server).Actions;

    private static JsonElement Body((string Method, string Path, string Body) post) => JsonDocument.Parse(post.Body).RootElement;

    [Fact]
    public async Task Scheduling_is_supported_only_when_the_approve_body_that_takes_a_day_is_in_the_OpenAPI()
    {
        using var server = new Server();
        var actions = Actions(server);
        Assert.False(await actions.SchedulingSupportedAsync(_f.Plugin.Configuration, CancellationToken.None));
        server.Supports = true;
        // Kept for ten minutes, so a new answer is read by a new instance.
        Assert.True(await Actions(server).SchedulingSupportedAsync(_f.Plugin.Configuration, CancellationToken.None));
    }

    // Unlike upstream, the answer is kept per Reclaimerr address: pointing the plugin at another (older) Reclaimerr asks it
    // again instead of sending it a day it would ignore.
    [Fact]
    public async Task The_kept_answer_is_for_one_Reclaimerr_address_so_another_Reclaimerr_is_asked_again()
    {
        using var modern = new Server { Supports = true };
        using var older = new Server();
        var actions = Actions(modern);
        Assert.True(await actions.SchedulingSupportedAsync(_f.Plugin.Configuration, CancellationToken.None));
        _f.Plugin.Configuration.ReclaimerrUrl = older.Url;
        Assert.False(await actions.SchedulingSupportedAsync(_f.Plugin.Configuration, CancellationToken.None));
        await Assert.ThrowsAsync<MaintainerrActions.ActionException>(() => actions.ReviewRequestAsync(7, true, null, null, _f.Plugin.Configuration, CancellationToken.None, ReclaimerrActions.ApprovalTiming.OnDate, Fixed.AddDays(3)));
        Assert.Empty(older.Posts);
    }

    [Fact]
    public async Task Approving_without_a_day_sends_the_old_body_so_an_older_Reclaimerr_behaves_as_before()
    {
        using var server = new Server();
        await Actions(server).ReviewRequestAsync(7, true, "ok", null, _f.Plugin.Configuration, CancellationToken.None);
        var post = Assert.Single(server.Posts);
        Assert.Equal("/api/delete-requests/7/approve", post.Path);
        var body = Body(post);
        Assert.Equal("ok", body.GetProperty("admin_notes").GetString());
        Assert.False(body.TryGetProperty("scheduled_at", out _), "omitting it is what asks for Reclaimerr's grace period");
        Assert.DoesNotContain(server.All, s => s.Path == "/openapi.json");
    }

    [Fact]
    public async Task Approving_now_sends_scheduled_at_null_and_on_a_day_sends_that_moment_in_UTC()
    {
        using var server = new Server { Supports = true };
        var actions = Actions(server);
        await actions.ReviewRequestAsync(7, true, null, null, _f.Plugin.Configuration, CancellationToken.None, ReclaimerrActions.ApprovalTiming.Now);
        var now = Body(server.Posts[0]);
        Assert.True(now.TryGetProperty("scheduled_at", out var nothing));
        Assert.Equal(JsonValueKind.Null, nothing.ValueKind);

        await actions.ReviewRequestAsync(8, true, null, null, _f.Plugin.Configuration, CancellationToken.None, ReclaimerrActions.ApprovalTiming.OnDate, new DateTimeOffset(2026, 12, 10, 18, 30, 0, TimeSpan.FromHours(5.5)));
        var later = server.Posts[1];
        Assert.Equal("/api/delete-requests/8/approve", later.Path);
        Assert.Equal("2026-12-10T13:00:00Z", Body(later).GetProperty("scheduled_at").GetString());
    }

    [Fact]
    public async Task A_day_is_refused_without_calling_approve_when_Reclaimerr_cannot_schedule_or_the_day_is_past_or_missing()
    {
        using var server = new Server { Supports = false };
        var ex = await Assert.ThrowsAsync<MaintainerrActions.ActionException>(() => Actions(server).ReviewRequestAsync(7, true, null, null, _f.Plugin.Configuration, CancellationToken.None, ReclaimerrActions.ApprovalTiming.OnDate, Fixed.AddDays(3)));
        Assert.Contains("cannot schedule", ex.Message);
        await Assert.ThrowsAsync<MaintainerrActions.ActionException>(() => Actions(server).ReviewRequestAsync(7, true, null, null, _f.Plugin.Configuration, CancellationToken.None, ReclaimerrActions.ApprovalTiming.Now));
        Assert.Empty(server.Posts);

        using var modern = new Server { Supports = true };
        var actions = Actions(modern);
        await Assert.ThrowsAsync<MaintainerrActions.ActionException>(() => actions.ReviewRequestAsync(7, true, null, null, _f.Plugin.Configuration, CancellationToken.None, ReclaimerrActions.ApprovalTiming.OnDate, Fixed.AddDays(-1)));
        await Assert.ThrowsAsync<MaintainerrActions.ActionException>(() => actions.ReviewRequestAsync(7, true, null, null, _f.Plugin.Configuration, CancellationToken.None, ReclaimerrActions.ApprovalTiming.OnDate, null));
        Assert.Empty(modern.Posts);
    }

    [Fact]
    public async Task An_approval_reads_the_Leaving_soon_facts_again_at_once_and_a_denial_does_not()
    {
        using var server = new Server { Supports = true };
        var actions = Actions(server);
        await actions.ReviewRequestAsync(8, false, null, null, _f.Plugin.Configuration, CancellationToken.None);
        Assert.DoesNotContain(server.All, s => s.Path.StartsWith("/api/v1/candidates"));
        await actions.ReviewRequestAsync(7, true, null, null, _f.Plugin.Configuration, CancellationToken.None, ReclaimerrActions.ApprovalTiming.OnDate, Fixed.AddDays(5));
        Assert.Contains(server.All, s => s.Path.StartsWith("/api/v1/candidates"));
    }

    [Fact]
    public void The_mapping_reads_both_ways_so_a_Reclaimerr_account_is_found_for_its_Jellyfin_name()
    {
        var config = _f.Plugin.Configuration;
        config.ReclaimerrUserMap = "Sudhakar = Sudhakar\nATM = ATM_user\n  Home =Home_user \nbroken\n=nothing";
        Assert.Equal("ATM", ReclaimerrSession.MappedJellyfinUser(config, "ATM_user"));
        Assert.Equal("ATM", ReclaimerrSession.MappedJellyfinUser(config, "atm_user"));
        Assert.Equal("Home", ReclaimerrSession.MappedJellyfinUser(config, "Home_user"));
        Assert.Null(ReclaimerrSession.MappedJellyfinUser(config, "Nobody"));
        Assert.Equal("ATM_user", ReclaimerrSession.MappedUser(config, "ATM"));
    }

    [Fact]
    public async Task A_Reclaimerr_account_is_named_by_the_mapping_else_by_the_Jellyfin_login_Reclaimerr_linked_to_it()
    {
        using var server = new Server();
        server.Extra["/api/account/users"] = "[{\"id\":18,\"username\":\"Pat_user\"},{\"id\":19,\"username\":\"Sam_user\"}]";
        server.Extra["/api/account/users/media-identities"] = "[{\"source_service\":\"jellyfin\",\"username\":\"Pat\",\"user_id\":18}]";
        var config = _f.Plugin.Configuration;
        config.ReclaimerrUserMap = "ATM = ATM_user";
        var actions = Actions(server);
        Assert.Equal("ATM", await actions.JellyfinNameOfAsync(config, "ATM_user", CancellationToken.None));
        Assert.Empty(server.All);
        Assert.Equal("pat", await actions.JellyfinNameOfAsync(config, "Pat_user", CancellationToken.None));
        Assert.Null(await actions.JellyfinNameOfAsync(config, "Sam_user", CancellationToken.None));
        Assert.Null(await actions.JellyfinNameOfAsync(config, "", CancellationToken.None));
    }

    [Fact]
    public async Task The_grace_period_is_read_from_Reclaimerr_and_unknown_when_it_cannot_be()
    {
        using var server = new Server();
        server.Extra["/api/settings/general"] = "{\"delete_request_grace_period_days\":14}";
        Assert.Equal(14, await Actions(server).GracePeriodDaysAsync(_f.Plugin.Configuration, CancellationToken.None));

        using var older = new Server();
        older.Extra["/api/settings/general"] = "{\"auto_delete_movie_delay_days\":14}";
        Assert.Null(await Actions(older).GracePeriodDaysAsync(_f.Plugin.Configuration, CancellationToken.None));
    }

    [Fact]
    public async Task Denying_never_carries_a_day()
    {
        using var server = new Server { Supports = true };
        await Actions(server).ReviewRequestAsync(7, false, null, null, _f.Plugin.Configuration, CancellationToken.None, ReclaimerrActions.ApprovalTiming.Now);
        var post = Assert.Single(server.Posts);
        Assert.Equal("/api/delete-requests/7/deny", post.Path);
        Assert.False(Body(post).TryGetProperty("scheduled_at", out _));
    }

    private JeMediaTagsController ControllerAs(User user, bool isAdmin, IUserManager users, TagCacheService cache)
    {
        var controller = (JeMediaTagsController)ApiAssetTests.Controller(typeof(JeMediaTagsController), _f.Core, users, _library.Object, cache);
        controller.HttpContext.User = global::JE.Tests.Features.SpoilerGuard.PrivacyPolicyTests.Principal(user.Id, admin: isAdmin);
        return controller;
    }

    private static JsonElement Answer(IActionResult answer)
    {
        using var doc = JsonDocument.Parse(JsonSerializer.Serialize(Assert.IsType<OkObjectResult>(answer).Value));
        return doc.RootElement.Clone();
    }

    // Through the routes: the page learns whether an approval can take a day (administrators only, who are the ones who
    // approve) and Reclaimerr's grace period; a viewer's list asks Reclaimerr neither.
    [Fact]
    public async Task The_list_tells_an_administrator_whether_an_approval_can_take_a_day_and_the_grace_period_and_tells_a_viewer_neither()
    {
        using var server = new Server { Supports = true };
        server.Extra["/api/settings/general"] = "{\"delete_request_grace_period_days\":14}";
        var (actions, leaving, cache) = Services(server);
        _f.Plugin.Configuration.LeavingSoonPageEnabled = true;
        var admin = new User("admin", "default", "default") { Id = Guid.NewGuid() };
        var viewer = new User("viewer", "default", "default") { Id = Guid.NewGuid() };
        var users = new Mock<IUserManager>();
        users.Setup(u => u.GetUserById(admin.Id)).Returns(admin);
        users.Setup(u => u.GetUserById(viewer.Id)).Returns(viewer);

        var asViewer = Answer(await ControllerAs(viewer, false, users.Object, cache).GetLeavingSoonList(leaving, actions, CancellationToken.None));
        Assert.False(asViewer.GetProperty("canSchedule").GetBoolean());
        Assert.Equal(JsonValueKind.Null, asViewer.GetProperty("graceDays").ValueKind);
        Assert.DoesNotContain(server.All, s => s.Path is "/openapi.json" or "/api/settings/general");

        var asAdmin = Answer(await ControllerAs(admin, true, users.Object, cache).GetLeavingSoonList(leaving, actions, CancellationToken.None));
        Assert.True(asAdmin.GetProperty("canSchedule").GetBoolean());
        Assert.Equal(14, asAdmin.GetProperty("graceDays").GetInt32());

        // An older Reclaimerr: no day can be given, and its grace period is not asked for.
        using var older = new Server();
        older.Extra["/api/settings/general"] = "{\"delete_request_grace_period_days\":14}";
        var (oldActions, oldLeaving, oldCache) = Services(older);
        var asAdminOld = Answer(await ControllerAs(admin, true, users.Object, oldCache).GetLeavingSoonList(oldLeaving, oldActions, CancellationToken.None));
        Assert.False(asAdminOld.GetProperty("canSchedule").GetBoolean());
        Assert.Equal(JsonValueKind.Null, asAdminOld.GetProperty("graceDays").ValueKind);
        Assert.DoesNotContain(older.All, s => s.Path == "/api/settings/general");
    }

    // Through the approve route: `when` and `date` reach Reclaimerr as scheduled_at, an older Reclaimerr is sent nothing
    // when a day or "now" was asked for, and no `when` is the old call.
    [Fact]
    public async Task The_approve_route_sends_when_and_date_and_an_older_Reclaimerr_is_sent_nothing_for_a_day()
    {
        using var server = new Server { Supports = true };
        var (actions, _, cache) = Services(server);
        _f.Plugin.Configuration.LeavingSoonPageEnabled = true;
        var admin = new User("Admin", "default", "default") { Id = Guid.NewGuid() };
        var users = new Mock<IUserManager>();
        users.Setup(u => u.GetUserById(admin.Id)).Returns(admin);
        var asAdmin = ControllerAs(admin, true, users.Object, cache);

        Assert.IsType<OkObjectResult>(await asAdmin.ApproveReclaimerrRequest(7, new ReclaimerrReviewRequest { Note = "later", When = "date", Date = Fixed.AddDays(9) }, actions, CancellationToken.None));
        var onDay = Body(server.Posts.Last(p => p.Path == "/api/delete-requests/7/approve"));
        Assert.Equal("2026-11-29T12:00:00Z", onDay.GetProperty("scheduled_at").GetString());
        Assert.StartsWith("later", onDay.GetProperty("admin_notes").GetString());

        Assert.IsType<OkObjectResult>(await asAdmin.ApproveReclaimerrRequest(8, new ReclaimerrReviewRequest { When = "NOW" }, actions, CancellationToken.None));
        Assert.Equal(JsonValueKind.Null, Body(server.Posts.Last(p => p.Path == "/api/delete-requests/8/approve")).GetProperty("scheduled_at").ValueKind);

        Assert.IsType<OkObjectResult>(await asAdmin.ApproveReclaimerrRequest(9, new ReclaimerrReviewRequest { When = "default" }, actions, CancellationToken.None));
        Assert.False(Body(server.Posts.Last(p => p.Path == "/api/delete-requests/9/approve")).TryGetProperty("scheduled_at", out _));

        Assert.IsType<BadRequestObjectResult>(await asAdmin.ApproveReclaimerrRequest(10, new ReclaimerrReviewRequest { When = "date" }, actions, CancellationToken.None));
        Assert.DoesNotContain(server.Posts, p => p.Path == "/api/delete-requests/10/approve");

        using var older = new Server();
        var (oldActions, _, oldCache) = Services(older);
        var oldAdmin = ControllerAs(admin, true, users.Object, oldCache);
        Assert.IsType<BadRequestObjectResult>(await oldAdmin.ApproveReclaimerrRequest(11, new ReclaimerrReviewRequest { When = "date", Date = Fixed.AddDays(9) }, oldActions, CancellationToken.None));
        Assert.IsType<BadRequestObjectResult>(await oldAdmin.ApproveReclaimerrRequest(12, new ReclaimerrReviewRequest { When = "now" }, oldActions, CancellationToken.None));
        Assert.Empty(older.Posts);
        Assert.IsType<OkObjectResult>(await oldAdmin.ApproveReclaimerrRequest(13, null, oldActions, CancellationToken.None));
        Assert.False(Body(Assert.Single(older.Posts)).TryGetProperty("scheduled_at", out _));
    }

    // Through the list: an approved request carries its day and schedule state, one whose schedule failed or is blocked stays
    // on the page, and a request filed in Reclaimerr by an account the mapping names shows that Jellyfin person.
    [Fact]
    public async Task The_list_keeps_a_failed_or_blocked_schedule_carries_the_day_and_names_a_mapped_Reclaimerr_account()
    {
        using var server = new Server();
        server.Extra["/api/delete-requests?status_filter=pending"] = "[{\"id\":1,\"media_id\":9,\"media_type\":\"movie\",\"media_title\":\"Up\",\"status\":\"pending\",\"requested_by_username\":\"ATM_user\",\"reason\":null}]";
        server.Extra["/api/delete-requests?status_filter=approved"] = "[{\"id\":2,\"media_id\":3,\"media_type\":\"movie\",\"media_title\":\"Cars\",\"status\":\"approved\",\"scheduled_at\":\"2026-12-10T08:00:00\",\"schedule_state\":\"blocked\"},"
            + "{\"id\":3,\"media_id\":4,\"media_type\":\"movie\",\"media_title\":\"Coco\",\"status\":\"approved\",\"scheduled_at\":\"2026-12-11T08:00:00\",\"schedule_state\":\"failed\"},"
            + "{\"id\":4,\"media_id\":5,\"media_type\":\"movie\",\"media_title\":\"Heat\",\"status\":\"approved\",\"scheduled_at\":\"2026-12-12T08:00:00\",\"schedule_state\":\"scheduled\"}]";
        var (actions, leaving, cache) = Services(server);
        var config = _f.Plugin.Configuration;
        config.LeavingSoonPageEnabled = true;
        config.ReclaimerrUserMap = "ATM = ATM_user";
        var admin = new User("admin", "default", "default") { Id = Guid.NewGuid() };
        var atm = new User("ATM", "default", "default") { Id = Guid.NewGuid() };
        var users = new Mock<IUserManager>();
        users.Setup(u => u.GetUserById(admin.Id)).Returns(admin);
        users.Setup(u => u.GetUserByName("ATM")).Returns(atm);

        var requests = Answer(await ControllerAs(admin, true, users.Object, cache).GetLeavingSoonList(leaving, actions, CancellationToken.None)).GetProperty("requests").EnumerateArray().ToArray();
        Assert.Equal(new[] { 1, 2, 3 }, requests.Select(r => r.GetProperty("id").GetInt32()).ToArray());
        Assert.Equal(("ATM", atm.Id.ToString("N")), (requests[0].GetProperty("jellyfinUser").GetString(), requests[0].GetProperty("jellyfinUserId").GetString()));
        Assert.Equal(("2026-12-10T08:00:00", "blocked"), (requests[1].GetProperty("scheduledAt").GetString(), requests[1].GetProperty("scheduleState").GetString()));
        Assert.Equal("failed", requests[2].GetProperty("scheduleState").GetString());
    }
}
