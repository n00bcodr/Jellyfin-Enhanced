using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Features.MediaTags;
using Jellyfin.Plugin.JellyfinEnhanced.Features.MediaTags.Models;
using Jellyfin.Plugin.JellyfinEnhanced.Features.MediaTags.Services;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.Globalization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.DependencyInjection;
using Moq;

namespace JE.Tests.Features.MediaTags;

/// <summary>
/// This tree's Reclaimerr routes (the partials of <see cref="JeMediaTagsController"/>) over Reclaimerr 0.6.15's token API
/// (upstream da3d9ee9), against a loopback Reclaimerr: what the Leaving soon list answers (sizes, the requests' failure reason
/// and source for administrators only, standalone visibility), a review read from another Reclaimerr, and who may use the
/// import and the audit. Upstream's own suite, <see cref="IntegrationReclaimerrTests"/>, covers the services.
/// </summary>
[Collection("Plugin singleton")]
public sealed class IntegrationReclaimerrRoutesTests : IDisposable
{
    private readonly ApiPluginFixture _f = new();
    private readonly Mock<ILibraryManager> _library = new();
    private readonly List<BaseItem> _items = new();
    private readonly ILibraryManager? _previousLibrary = BaseItem.LibraryManager;

    public IntegrationReclaimerrRoutesTests()
    {
        _library.Setup(l => l.GetItemById(It.IsAny<Guid>())).Returns((Guid id) => _items.SingleOrDefault(i => i.Id == id));
        _library.Setup(l => l.GetItemById<BaseItem>(It.IsAny<Guid>())).Returns((Guid id) => _items.SingleOrDefault(i => i.Id == id));
        _library.Setup(l => l.GetItemList(It.IsAny<InternalItemsQuery>())).Returns(Array.Empty<BaseItem>());
        BaseItem.LibraryManager = _library.Object;
    }

    public void Dispose()
    {
        BaseItem.LibraryManager = _previousLibrary!;
        _f.Dispose();
    }

    /// <summary>
    /// A series in a library the user may not open: its rating and tags would let them see it (<see cref="BaseItem.IsVisible"/>),
    /// the library does not (<see cref="BaseItem.IsVisibleStandalone"/>).
    /// </summary>
    private sealed class PrivateSeries : Series
    {
        public override bool IsVisibleStandalone(User user) => false;
    }

    /// <summary>A request the loopback Reclaimerr saw.</summary>
    private sealed record Hit(string Method, string Path, string Body, string? Bearer, string? User);

    /// <summary>A loopback Reclaimerr 0.6.15: <see cref="Routes"/> answers by "METHOD path" (query included), else an empty page.</summary>
    private sealed class Reclaimerr : IDisposable
    {
        private readonly HttpListener _listener = new();
        public string Url { get; }
        public List<Hit> Seen { get; } = new();
        public Dictionary<string, (int Status, string Body)> Routes { get; } = new(StringComparer.Ordinal);
        /// <summary>How long the answer to a request is held back (a slow Reclaimerr).</summary>
        public Func<Hit, TimeSpan> Delay { get; set; } = _ => TimeSpan.Zero;

        public Reclaimerr()
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
                    Hit hit;
                    try
                    {
                        using var reader = new StreamReader(context.Request.InputStream);
                        hit = new Hit(context.Request.HttpMethod, context.Request.Url!.PathAndQuery, await reader.ReadToEndAsync(), context.Request.Headers["Authorization"], context.Request.Headers["Remote-User"]);
                        lock (Seen) Seen.Add(hit);
                    }
                    catch
                    {
                        try { context.Response.Close(); } catch { }
                        continue;
                    }

                    var reply = hit.Path == "/openapi.json" ? (200, "{\"openapi\":\"3.1.0\",\"info\":{\"title\":\"reclaimerr API\",\"version\":\"0.6.15\"}}")
                        : Routes.TryGetValue(hit.Method + " " + hit.Path, out var route) ? route : (200, "{\"items\":[],\"total_pages\":1}");
                    var wait = Delay(hit);
                    // A slow answer is held back on its own, so the requests after it are answered meanwhile.
                    if (wait > TimeSpan.Zero) _ = Task.Run(async () => { await Task.Delay(wait); await Respond(context, reply); });
                    else await Respond(context, reply);
                }
            });
        }

        private static async Task Respond(HttpListenerContext context, (int Status, string Body) reply)
        {
            try
            {
                var bytes = Encoding.UTF8.GetBytes(reply.Body);
                context.Response.StatusCode = reply.Status;
                context.Response.ContentType = "application/json";
                context.Response.ContentLength64 = bytes.Length;
                await context.Response.OutputStream.WriteAsync(bytes);
            }
            catch { /* client gone */ }
            finally { try { context.Response.Close(); } catch { } }
        }

        public List<Hit> Posts { get { lock (Seen) return Seen.Where(s => s.Method == "POST").ToList(); } }
        public List<Hit> All { get { lock (Seen) return Seen.ToList(); } }
        public void Dispose() => _listener.Close();
    }

    private const string Pending = "GET /api/v1/delete-requests?status=pending&per_page=200&page=1";
    private const string Approved = "GET /api/v1/delete-requests?status=approved&per_page=200&page=1";
    private const string Grace = "GET /api/v1/delete-requests/approval-options";
    private const string Feed = "GET /api/v1/leaving-soon?per_page=200&page=1";

    private (ReclaimerrActions Actions, LeavingSoonService Leaving, TagCacheService Cache) Services(Reclaimerr server)
    {
        var c = _f.Plugin.Configuration;
        c.TagCacheServerMode = true;
        c.LeavingSoonMaintainerrEnabled = false;
        c.ReclaimerrEnabled = true;
        c.ReclaimerrUrl = server.Url;
        c.ReclaimerrToken = "rcl_secret";
        c.ReclaimerrUserRequests = false;
        c.LeavingSoonMaintainerrActions = true;
        c.LeavingSoonPageEnabled = true;
        var services = new ServiceCollection();
        LeavingSoonService.AddHttpClient(services);
        var clients = services.BuildServiceProvider().GetRequiredService<IHttpClientFactory>();
        var leaving = new LeavingSoonService(clients, Path.Combine(_f.Core.Root, "leaving-soon-" + Guid.NewGuid().ToString("N") + ".json"), _library.Object, _f.Core.Logger) { Timeout = TimeSpan.FromSeconds(5) };
        // No Leaving soon service in the tag cache: an action's queued publish would otherwise write into the fixture's folder
        // while it is deleted (these tests read the facts from the Leaving soon service itself).
        var cache = new TagCacheService(_library.Object, _f.Core.Paths.Object, Mock.Of<ILocalizationManager>(), _f.Core.Logger, new MatroskaLanguageCache(_f.Core.Paths.Object, _f.Core.Logger));
        var actions = new ReclaimerrActions(clients, leaving, cache, _f.Core.Logger) { Timeout = TimeSpan.FromSeconds(5) };
        return (actions, leaving, cache);
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

    private static string Error(IActionResult answer)
    {
        var value = answer switch { ObjectResult o => o.Value, _ => null };
        using var doc = JsonDocument.Parse(JsonSerializer.Serialize(value));
        return doc.RootElement.GetProperty("error").GetString()!;
    }

    private static string Jf(Guid item) => $"{{\"source_service\":\"jellyfin\",\"source_item_id\":\"{item:N}\",\"source_media_id\":null}}";

    private static string Page(params string[] items) => "{\"items\":[" + string.Join(",", items) + "],\"total_pages\":1}";

    private static string Entry(int candidate, Guid item, string scope, long? size, string type = "series")
        => $"{{\"source\":\"candidate\",\"candidate_id\":{candidate},\"scheduled_deletion_id\":null,\"media_type\":\"{type}\",\"scope\":\"{scope}\",\"media_server_items\":[{Jf(item)}],"
            + $"\"size_bytes\":{(size?.ToString() ?? "null")},\"delete_at\":\"{DateTimeOffset.UtcNow.AddDays(10):yyyy-MM-ddTHH:mm:ssZ}\",\"state\":\"eligible\"}}";

    private static string Request(int id, Guid? item = null, Guid? requester = null)
        => $"{{\"id\":{id},\"media_id\":3,\"media_type\":\"series\",\"media_title\":\"T{id}\",\"status\":\"pending\",\"requested_by_username\":\"sam_user\","
            + $"\"media_server_items\":[{(item is { } i ? Jf(i) : string.Empty)}],\"requested_by_media_identities\":[{(requester is { } r ? $"{{\"source_service\":\"jellyfin\",\"source_user_id\":\"{r:N}\"}}" : string.Empty)}]}}";

    private (User Admin, User Viewer, Mock<IUserManager> Users) People()
    {
        var admin = new User("admin", "default", "default") { Id = Guid.NewGuid() };
        var viewer = new User("viewer", "default", "default") { Id = Guid.NewGuid() };
        var users = new Mock<IUserManager>();
        users.Setup(u => u.GetUserById(admin.Id)).Returns(admin);
        users.Setup(u => u.GetUserById(viewer.Id)).Returns(viewer);
        users.Setup(u => u.GetUsers()).Returns(new List<User> { admin, viewer });
        return (admin, viewer, users);
    }

    // Upstream da3d9ee9: what leaving frees is Reclaimerr's own figure from the feed (it alone knows which copy goes), else the
    // library's; one version of a title shows only Reclaimerr's figure. A title in a library the user cannot open is not listed.
    [Fact]
    public async Task The_list_gives_Reclaimerr_sizes_else_the_library_and_leaves_out_a_title_in_a_library_the_user_cannot_open()
    {
        var sized = new Series { Id = Guid.NewGuid(), Name = "Sized" };
        var plain = new Series { Id = Guid.NewGuid(), Name = "Plain" };
        var shut = new PrivateSeries { Id = Guid.NewGuid(), Name = "Shut" };
        _items.AddRange(new BaseItem[] { sized, plain, shut });
        var episodes = new List<BaseItem> { new Episode { Id = Guid.NewGuid(), Size = 1_000 }, new Episode { Id = Guid.NewGuid(), Size = 2_000 } };
        _library.Setup(l => l.GetItemList(It.Is<InternalItemsQuery>(q => q.AncestorIds.Length > 0))).Returns(episodes);
        using var server = new Reclaimerr();
        server.Routes[Feed] = (200, Page(Entry(1, sized.Id, "series", 5_000), Entry(2, plain.Id, "series", null), Entry(3, shut.Id, "series", 7_000)));
        var (actions, leaving, cache) = Services(server);
        using (cache)
        {
            Assert.True(await leaving.RefreshAsync(_f.Plugin.Configuration, force: true, CancellationToken.None));
            var (_, viewer, users) = People();
            var items = Answer(await ControllerAs(viewer, false, users.Object, cache).GetLeavingSoonList(leaving, actions, CancellationToken.None)).GetProperty("items").EnumerateArray().ToArray();
            var sizes = items.ToDictionary(i => i.GetProperty("name").GetString()!, i => i.GetProperty("size").ValueKind == JsonValueKind.Null ? (long?)null : i.GetProperty("size").GetInt64());
            Assert.Equal(new Dictionary<string, long?> { ["Sized"] = 5_000, ["Plain"] = 3_000 }, sizes);
        }
    }

    // Upstream da3d9ee9: an administrator is told why the requests could not be read (Reclaimerr's own reason, or that it did not
    // answer in time), anyone else only that they could not; neither the reason, the grace period nor the list's source reaches
    // a user who is not an administrator, whose list does not ask Reclaimerr for the grace period at all.
    [Fact]
    public async Task Requests_that_cannot_be_read_are_reported_with_the_reason_and_source_to_administrators_only()
    {
        using var server = new Reclaimerr();
        server.Routes[Pending] = (403, "{\"detail\":\"API token requires the delete_requests:read scope\"}");
        server.Routes["GET /api/v1/delete-requests?per_page=200&page=1"] = (403, "{\"detail\":\"API token requires the delete_requests:read scope\"}");
        server.Routes[Grace] = (200, "{\"delete_request_grace_period_days\":14}");
        var (actions, leaving, cache) = Services(server);
        _f.Plugin.Configuration.ReclaimerrUserRequests = true;
        using (cache)
        {
            var (admin, viewer, users) = People();
            var asAdmin = ControllerAs(admin, true, users.Object, cache);
            var refused = Answer(await asAdmin.GetLeavingSoonList(leaving, actions, CancellationToken.None));
            Assert.True(refused.GetProperty("requestsUnavailable").GetBoolean());
            Assert.Equal("API token requires the delete_requests:read scope", refused.GetProperty("requestsError").GetString());
            Assert.Equal(14, refused.GetProperty("graceDays").GetInt32());
            Assert.Equal(ReclaimerrApi.SourceId(_f.Plugin.Configuration), refused.GetProperty("source").GetString());

            int GraceReads() => server.All.Count(h => h.Path == "/api/v1/delete-requests/approval-options");
            var graceReads = GraceReads();
            var asViewer = Answer(await ControllerAs(viewer, false, users.Object, cache).GetLeavingSoonList(leaving, actions, CancellationToken.None));
            Assert.True(asViewer.GetProperty("requestsUnavailable").GetBoolean(), "their own list is read with the same token");
            Assert.Equal(JsonValueKind.Null, asViewer.GetProperty("requestsError").ValueKind);
            Assert.Equal(JsonValueKind.Null, asViewer.GetProperty("graceDays").ValueKind);
            Assert.Equal(JsonValueKind.Null, asViewer.GetProperty("source").ValueKind);
            Assert.Equal(graceReads, GraceReads());

            // A Reclaimerr too slow for the page's budget: unknown, not none, and said so.
            server.Routes.Remove(Pending);
            server.Routes.Remove("GET /api/v1/delete-requests?per_page=200&page=1");
            server.Delay = s => s.Path.StartsWith("/api/v1/delete-requests?status=pending", StringComparison.Ordinal) ? TimeSpan.FromSeconds(3) : TimeSpan.Zero;
            actions.ListBudget = TimeSpan.FromMilliseconds(500);
            var late = Answer(await ControllerAs(admin, true, users.Object, cache).GetLeavingSoonList(leaving, actions, CancellationToken.None));
            Assert.True(late.GetProperty("requestsUnavailable").GetBoolean());
            Assert.Equal("Reclaimerr did not answer in time", late.GetProperty("requestsError").GetString());
            Assert.Empty(late.GetProperty("requests").EnumerateArray());
        }
    }

    // Upstream da3d9ee9: a request card names the item and the person by the ids Reclaimerr gives: the item only when the viewer may
    // open its library, the person only when the requester's Reclaimerr account is linked to a Jellyfin user.
    [Fact]
    public async Task A_request_card_links_an_item_the_viewer_can_open_and_names_the_linked_Jellyfin_requester()
    {
        var open = new Series { Id = Guid.NewGuid(), Name = "Open" };
        var shut = new PrivateSeries { Id = Guid.NewGuid(), Name = "Shut" };
        _items.AddRange(new BaseItem[] { open, shut });
        using var server = new Reclaimerr();
        var (admin, _, users) = People();
        var sam = new User("Sam", "default", "default") { Id = Guid.NewGuid() };
        users.Setup(u => u.GetUserById(sam.Id)).Returns(sam);
        server.Routes[Pending] = (200, Page(Request(1, open.Id, sam.Id), Request(2, shut.Id, Guid.NewGuid()), Request(3)));
        var (actions, leaving, cache) = Services(server);
        using (cache)
        {
            var rows = Answer(await ControllerAs(admin, true, users.Object, cache).GetLeavingSoonList(leaving, actions, CancellationToken.None)).GetProperty("requests").EnumerateArray().ToArray();
            Assert.Equal(new[] { 1, 2, 3 }, rows.Select(r => r.GetProperty("id").GetInt32()));
            Assert.Equal((open.Id.ToString("N"), "Sam", sam.Id.ToString("N")), (rows[0].GetProperty("itemId").GetString(), rows[0].GetProperty("jellyfinUser").GetString(), rows[0].GetProperty("jellyfinUserId").GetString()));
            Assert.Equal(JsonValueKind.Null, rows[1].GetProperty("itemId").ValueKind);
            Assert.Equal(JsonValueKind.Null, rows[1].GetProperty("jellyfinUser").ValueKind);
            Assert.Equal("sam_user", rows[2].GetProperty("requestedBy").GetString());
        }
    }

    // Upstream da3d9ee9: a review carries the list's source; one read from another Reclaimerr address is refused (409) and
    // nothing is sent, and the grace period shown goes along.
    [Fact]
    public async Task A_review_from_a_list_read_at_another_Reclaimerr_is_refused_and_one_from_this_one_is_sent()
    {
        using var server = new Reclaimerr();
        server.Routes[Grace] = (200, "{\"delete_request_grace_period_days\":3}");
        var (actions, _, cache) = Services(server);
        using (cache)
        {
            var (admin, _, users) = People();
            var asAdmin = ControllerAs(admin, true, users.Object, cache);
            var conflict = Assert.IsType<ConflictObjectResult>(await asAdmin.ApproveReclaimerrRequest(7, new ReclaimerrReviewRequest { Source = "0000000000000000" }, actions, CancellationToken.None));
            Assert.Equal("The Reclaimerr address changed since this list was read. Reload it.", Error(conflict));
            Assert.Empty(server.Posts);

            var source = ReclaimerrApi.SourceId(_f.Plugin.Configuration);
            Assert.IsType<BadRequestObjectResult>(await asAdmin.ApproveReclaimerrRequest(7, new ReclaimerrReviewRequest { Source = source, When = "default", GraceDays = 14 }, actions, CancellationToken.None));
            Assert.Empty(server.Posts);
            Assert.IsType<OkObjectResult>(await asAdmin.ApproveReclaimerrRequest(7, new ReclaimerrReviewRequest { Source = source, When = "default", GraceDays = 3, Note = "ok" }, actions, CancellationToken.None));
            var post = Assert.Single(server.Posts);
            Assert.Equal("/api/v1/delete-requests/7/approve", post.Path);
            Assert.Equal("ok (Approved by admin in Jellyfin)", JsonDocument.Parse(post.Body).RootElement.GetProperty("admin_notes").GetString());
            Assert.Equal("Bearer rcl_secret", post.Bearer);
            Assert.IsType<OkObjectResult>(await asAdmin.DenyReclaimerrRequest(8, null, actions, CancellationToken.None));
        }
    }

    // Upstream da3d9ee9: the import and the audit need Reclaimerr on with a URL and token (not the item-menu actions), and answer
    // 400 saying so until then; both are for administrators only.
    [Fact]
    public async Task Import_and_audit_are_for_administrators_and_ask_for_Reclaimerr_to_be_set_up_first()
    {
        using var server = new Reclaimerr();
        server.Routes["GET /api/v1"] = (200, "{\"granted_scopes\":[\"candidates:manage\",\"scheduled_deletions:manage\",\"delete_requests:manage\",\"media:read\",\"users:manage\"]}");
        server.Routes["GET /api/v1/users?limit=1000&offset=0"] = (200, "[]");
        server.Routes["GET /api/v1/users/import-from-media-server/providers"] = (200, "[]");
        var (actions, _, cache) = Services(server);
        var c = _f.Plugin.Configuration;
        using (cache)
        {
            var (admin, viewer, users) = People();
            var asAdmin = ControllerAs(admin, true, users.Object, cache);
            var asViewer = ControllerAs(viewer, false, users.Object, cache);
            var picked = new ReclaimerrImportUsersRequest { Permissions = new[] { "request" }, Pages = new[] { "requests" } };
            Assert.IsType<ForbidResult>(await asViewer.ImportReclaimerrUsers(picked, actions, CancellationToken.None));
            Assert.IsType<ForbidResult>(await asViewer.GetReclaimerrUserAudit(actions, CancellationToken.None));
            Assert.Empty(server.All);

            // The item-menu actions are not needed: with them off, both still run.
            c.LeavingSoonMaintainerrActions = false;
            var audit = Answer(await asAdmin.GetReclaimerrUserAudit(actions, CancellationToken.None));
            Assert.Equal(new[] { "admin", "viewer" }, audit.GetProperty("users").EnumerateArray().Select(u => u.GetProperty("jellyfinUsername").GetString()));
            Assert.Equal("Reclaimerr has no Jellyfin server with this server's users. Add this server in Reclaimerr (Settings, Media servers) first.",
                Error(Assert.IsType<BadRequestObjectResult>(await asAdmin.ImportReclaimerrUsers(picked, actions, CancellationToken.None))));

            // Not set up: refused before anything is sent.
            var seen = server.All.Count;
            const string first = "Turn on Use Reclaimerr and save its URL and API token first.";
            c.ReclaimerrToken = string.Empty;
            Assert.Equal(first, Error(Assert.IsType<BadRequestObjectResult>(await asAdmin.ImportReclaimerrUsers(picked, actions, CancellationToken.None))));
            Assert.Equal(first, Error(Assert.IsType<BadRequestObjectResult>(await asAdmin.GetReclaimerrUserAudit(actions, CancellationToken.None))));
            c.ReclaimerrToken = "rcl_secret";
            c.ReclaimerrEnabled = false;
            Assert.Equal(first, Error(Assert.IsType<BadRequestObjectResult>(await asAdmin.GetReclaimerrUserAudit(actions, CancellationToken.None))));
            Assert.Equal(seen, server.All.Count);
        }
    }

    // Who may do what through the routes: the item actions and the reviews are for administrators; with Let users request removals
    // off a user who is not one learns nothing about an item; Maintainerr's routes answer 404 while Reclaimerr is the tool.
    [Fact]
    public async Task Only_administrators_act_and_review_while_anyone_who_can_open_an_item_learns_only_whether_they_may_request()
    {
        var movie = new Movie { Id = Guid.NewGuid(), Name = "Film", Path = "/media/Film.mkv" };
        _items.Add(movie);
        using var server = new Reclaimerr();
        var (actions, leaving, cache) = Services(server);
        using (cache)
        {
            var (admin, viewer, users) = People();
            var asAdmin = ControllerAs(admin, true, users.Object, cache);
            var asViewer = ControllerAs(viewer, false, users.Object, cache);
            var state = Assert.IsType<OkObjectResult>(asAdmin.GetReclaimerrItemState(movie.Id, actions));
            Assert.Contains("\"provider\":\"reclaimerr\"", JsonSerializer.Serialize(state.Value));
            // Let users request removals is off: a viewer learns nothing about the item and cannot request.
            Assert.IsType<NotFoundResult>(asViewer.GetReclaimerrItemState(movie.Id, actions));
            Assert.IsType<NotFoundResult>(await asViewer.RequestReclaimerrRemoval(new ReclaimerrItemRequest { ItemId = movie.Id }, actions, CancellationToken.None));
            foreach (var action in new Func<Task<IActionResult>>[]
            {
                () => asViewer.MarkForReclaimerrRemoval(new ReclaimerrItemRequest { ItemId = movie.Id }, actions, CancellationToken.None),
                () => asViewer.KeepFromReclaimerrRemoval(new ReclaimerrItemRequest { ItemId = movie.Id }, actions, CancellationToken.None),
                () => asViewer.PostponeReclaimerrRemoval(new ReclaimerrItemRequest { ItemId = movie.Id, Days = 7 }, actions, CancellationToken.None),
                () => asViewer.ApproveReclaimerrRequest(5, null, actions, CancellationToken.None),
                () => asViewer.DenyReclaimerrRequest(5, null, actions, CancellationToken.None),
            })
            {
                Assert.IsType<ForbidResult>(await action());
            }

            Assert.Empty(server.Posts);
            _f.Plugin.Configuration.LeavingSoonPageEnabled = false;
            Assert.IsType<NotFoundResult>(await asAdmin.GetLeavingSoonList(leaving, actions, CancellationToken.None));
            var services = new ServiceCollection();
            LeavingSoonService.AddHttpClient(services);
            Assert.IsType<NotFoundResult>(asAdmin.GetMaintainerrItemState(movie.Id, new MaintainerrActions(services.BuildServiceProvider().GetRequiredService<IHttpClientFactory>(), _library.Object, leaving, cache, _f.Core.Logger)));
        }
    }

    // Upstream 54a6f418: schedule, keep, reschedule, approve and deny also send the acting administrator's linked Reclaimerr name in
    // the user header, beside the token, so Reclaimerr credits the person; only with Let users request removals on, and never when
    // the administrator has no active linked account or the lookup fails (the call then stays the token's). Keep and postpone of a
    // cleanup candidate's timer stay the token's, as upstream.
    [Fact]
    public async Task Admin_actions_name_the_acting_administrators_linked_Reclaimerr_account_only_while_requests_are_on()
    {
        var movie = new Movie { Id = Guid.NewGuid(), Name = "Film" };
        movie.SetProviderId(MetadataProvider.Tmdb, "550");
        var kept = new Series { Id = Guid.NewGuid(), Name = "Kept" };
        var moved = new Series { Id = Guid.NewGuid(), Name = "Moved" };
        _items.AddRange(new BaseItem[] { movie, kept, moved });
        using var server = new Reclaimerr();
        var (admin, _, users) = People();
        var linked = $"[{{\"id\":3,\"username\":\"boss\",\"is_active\":true,\"media_identities\":[{{\"source_service\":\"jellyfin\",\"source_user_id\":\"{admin.Id:N}\"}}]}}]";
        const string Users = "GET /api/v1/users?limit=1000&offset=0";
        server.Routes[Users] = (200, linked);
        server.Routes["GET /api/v1/movies?tmdb_id=550&per_page=5"] = (200, $"{{\"items\":[{{\"id\":31,\"versions\":[{{\"id\":5,\"service_item_id\":\"{movie.Id:N}\",\"service_media_id\":\"{movie.Id:N}\"}}]}}]}}");
        server.Routes[Feed] = (200, Page(Entry(4, kept.Id, "series", null),
            $"{{\"source\":\"manual\",\"candidate_id\":null,\"scheduled_deletion_id\":9,\"media_type\":\"series\",\"scope\":\"series\",\"media_server_items\":[{Jf(moved.Id)}],\"size_bytes\":null,\"delete_at\":\"{DateTimeOffset.UtcNow.AddDays(10):yyyy-MM-ddTHH:mm:ssZ}\",\"state\":\"scheduled\"}}"));
        var (actions, leaving, cache) = Services(server);
        using (cache)
        {
            Assert.True(await leaving.RefreshAsync(_f.Plugin.Configuration, force: true, CancellationToken.None));
            var asAdmin = ControllerAs(admin, true, users.Object, cache);
            async Task<Dictionary<string, string?>> Run()
            {
                lock (server.Seen) server.Seen.Clear();
                Assert.IsType<OkObjectResult>(await asAdmin.MarkForReclaimerrRemoval(new ReclaimerrItemRequest { ItemId = movie.Id }, actions, CancellationToken.None));
                Assert.IsType<OkObjectResult>(await asAdmin.KeepFromReclaimerrRemoval(new ReclaimerrItemRequest { ItemId = kept.Id }, actions, CancellationToken.None));
                Assert.IsType<OkObjectResult>(await asAdmin.PostponeReclaimerrRemoval(new ReclaimerrItemRequest { ItemId = moved.Id, Days = 7 }, actions, CancellationToken.None));
                Assert.IsType<OkObjectResult>(await asAdmin.ApproveReclaimerrRequest(7, null, actions, CancellationToken.None));
                Assert.IsType<OkObjectResult>(await asAdmin.DenyReclaimerrRequest(8, null, actions, CancellationToken.None));
                var posts = server.Posts;
                Assert.All(posts, p => Assert.Equal("Bearer rcl_secret", p.Bearer));
                return posts.ToDictionary(p => p.Path, p => p.User);
            }

            // Requests on and the administrator linked: every one of these names them.
            _f.Plugin.Configuration.ReclaimerrUserRequests = true;
            Assert.Equal(new Dictionary<string, string?>
            {
                ["/api/v1/scheduled-deletions"] = "boss",
                ["/api/v1/candidates/4/protect"] = "boss",
                ["/api/v1/scheduled-deletions/9/reschedule"] = "boss",
                ["/api/v1/delete-requests/7/approve"] = "boss",
                ["/api/v1/delete-requests/8/deny"] = "boss",
            }, await Run());

            // Requests off: no header, and Reclaimerr's accounts are not read for it.
            _f.Plugin.Configuration.ReclaimerrUserRequests = false;
            Assert.All(await Run(), p => Assert.Null(p.Value));
            Assert.DoesNotContain(server.All, h => h.Path.StartsWith("/api/v1/users", StringComparison.Ordinal));

            // Not linked, or the lookup fails: the call is still sent, as the token's.
            _f.Plugin.Configuration.ReclaimerrUserRequests = true;
            server.Routes[Users] = (200, "[]");
            Assert.All(await Run(), p => Assert.Null(p.Value));
            server.Routes[Users] = (500, "{\"detail\":\"boom\"}");
            var failed = await Run();
            Assert.Equal(5, failed.Count);
            Assert.All(failed, p => Assert.Null(p.Value));
        }
    }
}
