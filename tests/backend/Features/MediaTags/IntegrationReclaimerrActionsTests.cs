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
/// Reclaimerr as the removal tool (upstream da0ea773), against a loopback Reclaimerr: what is read (candidates with the
/// token, scheduled deletions as the service account), which credential each request carries (bearer token, the
/// trusted-proxy user header, never both), the version a movie mark schedules, removal requests and their duplicates,
/// and who may use which route.
/// </summary>
[Collection("Plugin singleton")]
public sealed class IntegrationReclaimerrActionsTests : IDisposable
{
    private readonly ApiPluginFixture _f = new();
    private readonly Mock<ILibraryManager> _library = new();
    private readonly List<BaseItem> _items = new();
    private readonly ILibraryManager? _previousLibrary = BaseItem.LibraryManager;

    public IntegrationReclaimerrActionsTests()
    {
        _library.Setup(l => l.GetItemById(It.IsAny<Guid>())).Returns((Guid id) => _items.SingleOrDefault(i => i.Id == id));
        _library.Setup(l => l.GetItemById<BaseItem>(It.IsAny<Guid>())).Returns((Guid id) => _items.SingleOrDefault(i => i.Id == id));
        _library.Setup(l => l.GetItemList(It.IsAny<InternalItemsQuery>())).Returns(() => _items.Where(i => i is Movie or Series).ToList());
        BaseItem.LibraryManager = _library.Object;
    }

    public void Dispose()
    {
        BaseItem.LibraryManager = _previousLibrary!;
        _f.Dispose();
    }

    /// <summary>One request as the loopback Reclaimerr saw it.</summary>
    private sealed record Seen(string Method, string Path, string Body, string? Bearer, string? User, string? Cookie);

    /// <summary>A loopback Reclaimerr that records every request with its credentials and answers per path.</summary>
    private sealed class Server : IDisposable
    {
        private readonly HttpListener _listener = new();
        private readonly List<Seen> _seen = new();
        public string Url { get; }
        public Func<Seen, (int Status, string Body)> Answer { get; set; } = _ => (404, "{\"detail\":\"Not Found\"}");

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
                        var auth = context.Request.Headers["Authorization"];
                        var seen = new Seen(context.Request.HttpMethod, context.Request.Url!.PathAndQuery, await reader.ReadToEndAsync(),
                            auth != null && auth.StartsWith("Bearer ", StringComparison.Ordinal) ? auth[7..] : null, context.Request.Headers["Remote-User"], context.Request.Headers["Cookie"]);
                        lock (_seen) _seen.Add(seen);
                        var (status, answer) = Answer(seen);
                        context.Response.StatusCode = status;
                        context.Response.ContentType = "application/json";
                        var bytes = Encoding.UTF8.GetBytes(answer);
                        context.Response.ContentLength64 = bytes.Length;
                        await context.Response.OutputStream.WriteAsync(bytes);
                    }
                    catch { /* client gone */ }
                    finally { try { context.Response.Close(); } catch { } }
                }
            });
        }

        public List<Seen> All { get { lock (_seen) return _seen.ToList(); } }
        public List<Seen> Posts => All.Where(s => s.Method == "POST").ToList();
        public void Dispose() => _listener.Close();
    }

    private static IHttpClientFactory Clients()
    {
        var services = new ServiceCollection();
        LeavingSoonService.AddHttpClient(services);
        return services.BuildServiceProvider().GetRequiredService<IHttpClientFactory>();
    }

    private (ReclaimerrActions Actions, LeavingSoonService Leaving, TagCacheService Cache) Services(Server server, string? account = "svc")
    {
        var c = _f.Plugin.Configuration;
        c.TagCacheServerMode = true;
        c.LeavingSoonMaintainerrEnabled = false;
        c.ReclaimerrEnabled = true;
        c.ReclaimerrUrl = server.Url;
        c.ReclaimerrToken = "rcl_secret";
        c.ReclaimerrUsername = account ?? string.Empty;
        c.LeavingSoonMaintainerrActions = true;
        var clients = Clients();
        var leaving = new LeavingSoonService(clients, Path.Combine(_f.Core.Root, "leaving-soon.json"), _library.Object, _f.Core.Logger) { Timeout = TimeSpan.FromSeconds(5) };
        var cache = new TagCacheService(_library.Object, _f.Core.Paths.Object, Mock.Of<ILocalizationManager>(), _f.Core.Logger, new MatroskaLanguageCache(_f.Core.Paths.Object, _f.Core.Logger), leavingSoonService: leaving);
        var actions = new ReclaimerrActions(clients, leaving, cache, _f.Core.Logger) { Timeout = TimeSpan.FromSeconds(5) };
        return (actions, leaving, cache);
    }

    private static string Candidates(params (int Id, long Tmdb, string Scope, string At)[] candidates)
        => JsonSerializer.Serialize(new
        {
            items = candidates.Select(c => new Dictionary<string, object?> { ["id"] = c.Id, ["scope"] = c.Scope, ["tmdb_id"] = c.Tmdb, ["auto_delete_state"] = "eligible", ["auto_delete_eligible_at"] = c.At }).ToArray(),
            total_pages = 1,
        });

    private Movie AddMovie(string name, string tmdb)
    {
        var movie = new Movie { Id = Guid.NewGuid(), Name = name, Path = "/media/" + name + ".mkv" };
        movie.SetProviderId(MetadataProvider.Tmdb, tmdb);
        _items.Add(movie);
        return movie;
    }

    [Fact]
    public async Task Candidates_are_read_with_the_token_and_scheduled_deletions_as_the_service_account_by_name()
    {
        var movie = AddMovie("Film", "550");
        var series = new Series { Id = Guid.NewGuid(), Name = "Show" };
        series.SetProviderId(MetadataProvider.Tmdb, "1399");
        _items.Add(series);
        var soon = DateTimeOffset.UtcNow.AddDays(10).ToString("yyyy-MM-ddTHH:mm:ssZ");
        using var server = new Server();
        server.Answer = s => s.Path switch
        {
            "/api/v1/candidates?per_page=200&page=1" => (200, Candidates((4, 550, "movie", soon))),
            "/api/media/scheduled-deletions" => (200, "[{\"id\":9,\"state\":\"scheduled\",\"scheduled_at\":\"" + soon + "\",\"target\":{\"media_type\":\"series\",\"scope\":\"series\",\"tmdb_id\":1399}}]"),
            _ => (404, "{\"detail\":\"Not Found\"}"),
        };
        var (_, leaving, cache) = Services(server);
        using (cache)
        {
            Assert.True(await leaving.RefreshAsync(_f.Plugin.Configuration, force: true, CancellationToken.None));
            var candidates = Assert.Single(server.All, s => s.Path.StartsWith("/api/v1/candidates", StringComparison.Ordinal));
            Assert.Equal(("rcl_secret", null), (candidates.Bearer, candidates.User));
            var schedules = Assert.Single(server.All, s => s.Path == "/api/media/scheduled-deletions");
            Assert.Equal((null, "svc", null), (schedules.Bearer, schedules.User, schedules.Cookie));
            Assert.Equal(4, leaving.CollectionOf(movie.Id, _f.Plugin.Configuration));
            Assert.Equal(-9, leaving.CollectionOf(series.Id, _f.Plugin.Configuration));
            Assert.Equal(new[] { movie.Id, series.Id }.Order(), leaving.MaintainerrItems(_f.Plugin.Configuration).Select(i => i.ItemId).Order());
            Assert.Equal("reclaimerr", leaving.Status(_f.Plugin.Configuration).Provider);

            // The scheduled deletions failing keeps the last answer instead of dropping every one of them.
            server.Answer = s => s.Path.StartsWith("/api/v1/candidates", StringComparison.Ordinal) ? (200, Candidates((4, 550, "movie", soon))) : (500, "{\"detail\":\"boom\"}");
            await leaving.RefreshAsync(_f.Plugin.Configuration, force: true, CancellationToken.None);
            Assert.Equal(-9, leaving.CollectionOf(series.Id, _f.Plugin.Configuration));
            Assert.Equal("HTTP 500", leaving.Status(_f.Plugin.Configuration).LastError);
        }
    }

    [Fact]
    public async Task Mark_schedules_only_the_picked_version_of_a_movie_kept_twice_and_refuses_when_it_cannot_tell()
    {
        var movie = AddMovie("Jailer 2", "1234139");
        var picked = Guid.NewGuid().ToString("N");
        var versions = "[{\"id\":21,\"service_media_id\":\"" + Guid.NewGuid().ToString("D") + "\",\"path\":\"/other.mkv\"},{\"id\":22,\"service_media_id\":\"" + Guid.Parse(picked).ToString("D") + "\",\"path\":\"/4k.mkv\"}]";
        using var server = new Server();
        var known = true;
        server.Answer = s => s switch
        {
            { Path: "/api/v1/movies?tmdb_id=1234139&per_page=5" } => (200, "{\"items\":[{\"id\":77}]}"),
            { Method: "GET" } when s.Path.StartsWith("/api/media/movies?per_page=50&search=", StringComparison.Ordinal) => (200, "{\"items\":[{\"tmdb_id\":1234139,\"versions\":" + (known ? versions : "[{\"id\":21},{\"id\":22}]") + "}]}"),
            { Method: "POST", Path: "/api/media/schedule-deletion" } => (200, "{}"),
            _ when s.Path.StartsWith("/api/v1/candidates", StringComparison.Ordinal) => (200, Candidates()),
            { Path: "/api/media/scheduled-deletions" } => (200, "[]"),
            { Path: "/api/account/users" } => (200, "[]"),
            { Path: "/api/account/users/media-identities" } => (200, "[]"),
            _ => (404, "{\"detail\":\"Not Found\"}"),
        };
        var (actions, _, cache) = Services(server);
        using (cache)
        {
            // MediaSourceInfo lookups need the media sources; without one picked the item's own id is matched.
            var at = DateTimeOffset.UtcNow.AddDays(12);
            await Assert.ThrowsAsync<MaintainerrActions.ActionException>(() => actions.MarkAsync(movie, _f.Plugin.Configuration, at, null, "Admin", CancellationToken.None));
            Assert.Empty(server.Posts);

            server.Answer = s => s.Path.StartsWith("/api/media/movies?", StringComparison.Ordinal)
                ? (200, "{\"items\":[{\"tmdb_id\":1234139,\"versions\":[{\"id\":21,\"service_media_id\":\"" + movie.Id.ToString("D") + "\"},{\"id\":22,\"service_media_id\":\"x\"}]}]}")
                : s.Path == "/api/v1/movies?tmdb_id=1234139&per_page=5" ? (200, "{\"items\":[{\"id\":77}]}")
                : s.Path == "/api/media/schedule-deletion" ? (200, "{}")
                : s.Path.StartsWith("/api/v1/candidates", StringComparison.Ordinal) ? (200, Candidates())
                : s.Path is "/api/media/scheduled-deletions" or "/api/account/users" or "/api/account/users/media-identities" ? (200, "[]")
                : (404, "{}");
            await actions.MarkAsync(movie, _f.Plugin.Configuration, at, null, "Admin", CancellationToken.None);
            var post = Assert.Single(server.Posts);
            using var body = JsonDocument.Parse(post.Body);
            Assert.Equal(("movie", 77, 21), (body.RootElement.GetProperty("media_type").GetString(), body.RootElement.GetProperty("media_id").GetInt32(), body.RootElement.GetProperty("movie_version_id").GetInt32()));
            Assert.Equal(at.UtcDateTime.ToString("yyyy-MM-dd"), body.RootElement.GetProperty("scheduled_at").GetString()![..10]);
            // The administrator has no link or mapping: the write goes as the service account, never with the token.
            Assert.Equal((null, "svc"), (post.Bearer, post.User));
            Assert.Throws<MaintainerrActions.ActionException>(() => { _ = actions.MarkAsync(movie, _f.Plugin.Configuration, DateTimeOffset.UtcNow.AddDays(-1), null, "Admin", CancellationToken.None).GetAwaiter().GetResult(); });
        }
    }

    [Fact]
    public async Task A_removal_request_carries_the_mapped_user_and_their_note_and_a_waiting_one_is_not_filed_twice()
    {
        var movie = AddMovie("Crash", "1640");
        using var server = new Server();
        var waiting = "[]";
        server.Answer = s => s switch
        {
            { Path: "/api/v1/movies?tmdb_id=1640&per_page=5" } => (200, "{\"items\":[{\"id\":31}]}"),
            { Path: "/api/delete-requests?status_filter=pending" } => (200, waiting),
            { Method: "POST", Path: "/api/delete-requests" } => (201, "{\"id\":5}"),
            _ when s.Path.StartsWith("/api/v1/candidates", StringComparison.Ordinal) => (200, Candidates()),
            { Path: "/api/media/scheduled-deletions" } => (200, "[]"),
            _ => (404, "{\"detail\":\"Not Found\"}"),
        };
        var (actions, _, cache) = Services(server);
        _f.Plugin.Configuration.ReclaimerrUserMap = "Sam = samuel";
        using (cache)
        {
            var (_, existing) = await actions.RequestRemovalAsync(movie, "Sam", " not my taste ", _f.Plugin.Configuration, CancellationToken.None);
            Assert.Null(existing);
            var post = Assert.Single(server.Posts);
            Assert.Equal((null, "samuel"), (post.Bearer, post.User));
            using var body = JsonDocument.Parse(post.Body);
            Assert.Equal("Requested by Sam from Jellyfin: not my taste", body.RootElement.GetProperty("reason").GetString());
            Assert.Equal(31, body.RootElement.GetProperty("media_id").GetInt32());

            waiting = "[{\"id\":5,\"media_id\":31,\"media_type\":\"movie\",\"status\":\"pending\",\"requested_by_username\":\"samuel\",\"reason\":\"Requested by Sam from Jellyfin\"}]";
            var (_, again) = await actions.RequestRemovalAsync(movie, "Sam", null, _f.Plugin.Configuration, CancellationToken.None);
            Assert.Equal("mine", again);
            var (_, other) = await actions.RequestRemovalAsync(movie, "Pat", null, _f.Plugin.Configuration, CancellationToken.None);
            Assert.Equal("other", other);
            Assert.Single(server.Posts);
        }
    }

    private JeMediaTagsController ControllerAs(User user, bool isAdmin, IUserManager users, TagCacheService cache)
    {
        var controller = (JeMediaTagsController)ApiAssetTests.Controller(typeof(JeMediaTagsController), _f.Core, users, _library.Object, cache);
        controller.HttpContext.User = global::JE.Tests.Features.SpoilerGuard.PrivacyPolicyTests.Principal(user.Id, admin: isAdmin);
        return controller;
    }

    private static int[] Ids(IActionResult answer, string list)
    {
        using var doc = JsonDocument.Parse(JsonSerializer.Serialize(Assert.IsType<OkObjectResult>(answer).Value));
        return doc.RootElement.GetProperty(list).EnumerateArray().Select(r => r.GetProperty("id").GetInt32()).ToArray();
    }

    private const string FiledForSamAndPat = "[{\"id\":5,\"media_id\":31,\"media_type\":\"movie\",\"media_title\":\"Crash\",\"status\":\"pending\",\"requested_by_username\":\"svc\",\"reason\":\"Requested by Sam from Jellyfin: not my taste\"},"
        + "{\"id\":6,\"media_id\":32,\"media_type\":\"movie\",\"media_title\":\"Heat\",\"status\":\"pending\",\"requested_by_username\":\"svc\",\"reason\":\"Requested by Pat from Jellyfin\"}]";

    // Upstream 3ada0a4e: My requests is the user's own Reclaimerr list together with what the service account filed in their name.
    [Fact]
    public async Task My_requests_merge_the_own_list_with_the_ones_filed_in_their_name_and_a_refused_own_list_hides_nothing()
    {
        using var server = new Server();
        var own = (Status: 403, Body: "{\"detail\":\"Requests page not allowed\"}");
        server.Answer = s => s switch
        {
            { Path: "/api/delete-requests/my" } => own,
            { Path: "/api/delete-requests" } => (200, FiledForSamAndPat),
            _ => (404, "{\"detail\":\"Not Found\"}"),
        };
        var (actions, leaving, cache) = Services(server);
        _f.Plugin.Configuration.ReclaimerrUserMap = "Sam = samuel";
        _f.Plugin.Configuration.LeavingSoonPageEnabled = true;
        using (cache)
        {
            var sam = new User("Sam", "default", "default") { Id = Guid.NewGuid() };
            var users = new Mock<IUserManager>();
            users.Setup(u => u.GetUserById(sam.Id)).Returns(sam);
            users.Setup(u => u.GetUserByName("Sam")).Returns(sam);
            var asSam = ControllerAs(sam, false, users.Object, cache);

            // Their own list is refused (their Reclaimerr account has no Requests page): the ones filed in their name still show.
            Assert.Equal(new[] { 5 }, Ids(await asSam.GetLeavingSoonList(leaving, actions, CancellationToken.None), "mine"));
            var asked = Assert.Single(server.All, s => s.Path == "/api/delete-requests/my");
            Assert.Equal((null, "samuel"), (asked.Bearer, asked.User));

            // Both lists answer: their own first, then the others filed for them, each request once.
            own = (200, "[{\"id\":7,\"media_id\":33,\"media_type\":\"series\",\"media_title\":\"Lost\",\"status\":\"pending\",\"requested_by_username\":\"samuel\",\"reason\":\"gone\"}]");
            Assert.Equal(new[] { 7, 5 }, Ids(await asSam.GetLeavingSoonList(leaving, actions, CancellationToken.None), "mine"));
            own = (200, "[{\"id\":5,\"media_id\":31,\"media_type\":\"movie\",\"media_title\":\"Crash\",\"status\":\"pending\",\"requested_by_username\":\"samuel\",\"reason\":\"Requested by Sam from Jellyfin: not my taste\"}]");
            Assert.Equal(new[] { 5 }, Ids(await asSam.GetLeavingSoonList(leaving, actions, CancellationToken.None), "mine"));
        }
    }

    // Upstream 3ada0a4e: a request filed straight in Reclaimerr names the Jellyfin user whose name its requester has.
    [Fact]
    public async Task A_request_filed_in_Reclaimerr_itself_is_shown_as_the_Jellyfin_user_of_the_same_name()
    {
        using var server = new Server();
        server.Answer = s => s switch
        {
            { Path: "/api/delete-requests?status_filter=pending" } => (200, "[{\"id\":8,\"media_id\":34,\"media_type\":\"movie\",\"media_title\":\"Up\",\"status\":\"pending\",\"requested_by_username\":\"Pat\",\"reason\":\"please remove\"},"
                + "{\"id\":9,\"media_id\":35,\"media_type\":\"movie\",\"media_title\":\"Cars\",\"status\":\"pending\",\"requested_by_username\":\"svc\",\"reason\":\"Requested by Sam from Jellyfin\"},"
                + "{\"id\":10,\"media_id\":36,\"media_type\":\"movie\",\"media_title\":\"Coco\",\"status\":\"pending\",\"requested_by_username\":\"nobody_here\",\"reason\":null}]"),
            _ => (404, "{\"detail\":\"Not Found\"}"),
        };
        var (actions, leaving, cache) = Services(server);
        _f.Plugin.Configuration.LeavingSoonPageEnabled = true;
        using (cache)
        {
            var admin = new User("admin", "default", "default") { Id = Guid.NewGuid() };
            var pat = new User("Pat", "default", "default") { Id = Guid.NewGuid() };
            var sam = new User("Sam", "default", "default") { Id = Guid.NewGuid() };
            var users = new Mock<IUserManager>();
            users.Setup(u => u.GetUserById(admin.Id)).Returns(admin);
            users.Setup(u => u.GetUserByName("Pat")).Returns(pat);
            users.Setup(u => u.GetUserByName("Sam")).Returns(sam);
            var answer = Assert.IsType<OkObjectResult>(await ControllerAs(admin, true, users.Object, cache).GetLeavingSoonList(leaving, actions, CancellationToken.None));
            using var doc = JsonDocument.Parse(JsonSerializer.Serialize(answer.Value));
            var people = doc.RootElement.GetProperty("requests").EnumerateArray()
                .Select(r => (r.GetProperty("id").GetInt32(), r.GetProperty("jellyfinUser").GetString(), r.GetProperty("jellyfinUserId").GetString())).ToArray();
            Assert.Equal(new (int, string?, string?)[] { (8, "Pat", pat.Id.ToString("N")), (9, "Sam", sam.Id.ToString("N")), (10, null, null) }, people);
        }
    }

    // Upstream 3ada0a4e: one button gives every Jellyfin user without one a Reclaimerr account, mapped to them.
    [Fact]
    public async Task Create_users_gives_each_Jellyfin_user_without_an_account_one_with_the_picked_permissions_and_maps_it()
    {
        using var server = new Server();
        server.Answer = s => s switch
        {
            { Method: "GET", Path: "/api/account/users" } => (200, "{\"items\":[{\"id\":1,\"username\":\"svc\"},{\"id\":2,\"username\":\"pat\"},{\"id\":3,\"username\":\"lee_user\"},{\"id\":4,\"username\":\"Jane_Doe\"}]}"),
            { Method: "GET", Path: "/api/account/users/media-identities" } => (200, "[{\"user_id\":3,\"username\":\"Lee\",\"source_service\":\"jellyfin\"}]"),
            { Method: "POST", Path: "/api/account/users" } when s.Body.Contains("\"Kim_Lee\"", StringComparison.Ordinal) => (400, "{\"detail\":\"Username taken\"}"),
            { Method: "POST", Path: "/api/account/users" } => (201, "{\"id\":10}"),
            _ => (404, "{\"detail\":\"Not Found\"}"),
        };
        var (actions, _, cache) = Services(server);
        var c = _f.Plugin.Configuration;
        c.ReclaimerrUserMap = "Mapped = m";
        using (cache)
        {
            var admin = new User("svcadmin", "default", "default") { Id = Guid.NewGuid() };
            var viewer = new User("viewer", "default", "default") { Id = Guid.NewGuid() };
            var names = new[] { "Sam", "Pat", "Lee", "Mapped", "Jane Doe", "Ana.Maria", "Kim Lee", "Someone with a very long name indeed", "sam" };
            var users = new Mock<IUserManager>();
            users.Setup(u => u.GetUserById(admin.Id)).Returns(admin);
            users.Setup(u => u.GetUserById(viewer.Id)).Returns(viewer);
            users.Setup(u => u.GetUsers()).Returns(names.Select(n => new User(n, "default", "default") { Id = Guid.NewGuid() }).ToList());
            var asAdmin = ControllerAs(admin, true, users.Object, cache);
            var picked = new ReclaimerrCreateUsersRequest { Permissions = new[] { "request", "manage_users", "request" }, Pages = new[] { "requests", "nope" } };

            // Who may not, and what is refused before anything is sent.
            Assert.IsType<ForbidResult>(await ControllerAs(viewer, false, users.Object, cache).CreateReclaimerrUsers(picked, actions, CancellationToken.None));
            var noPage = Assert.IsType<BadRequestObjectResult>(await asAdmin.CreateReclaimerrUsers(new ReclaimerrCreateUsersRequest { Permissions = new[] { "request" }, Pages = new[] { "nope" } }, actions, CancellationToken.None));
            Assert.Contains("Pick at least one page.", JsonSerializer.Serialize(noPage.Value));
            c.ReclaimerrUsername = string.Empty;
            var noAccount = Assert.IsType<BadRequestObjectResult>(await asAdmin.CreateReclaimerrUsers(picked, actions, CancellationToken.None));
            Assert.Contains("Create the service account first.", JsonSerializer.Serialize(noAccount.Value));
            c.ReclaimerrUsername = "svc";
            c.ReclaimerrEnabled = false;
            Assert.IsType<NotFoundResult>(await asAdmin.CreateReclaimerrUsers(picked, actions, CancellationToken.None));
            c.ReclaimerrEnabled = true;
            Assert.Empty(server.All);

            var answer = Assert.IsType<OkObjectResult>(await asAdmin.CreateReclaimerrUsers(picked, actions, CancellationToken.None));
            using var doc = JsonDocument.Parse(JsonSerializer.Serialize(answer.Value));
            var root = doc.RootElement;
            Assert.Equal(new[] { "Sam", "Ana.Maria" }, root.GetProperty("created").EnumerateArray().Select(e => e.GetString()));
            Assert.Equal(3, root.GetProperty("existing").GetInt32());
            var skipped = root.GetProperty("skipped").EnumerateArray().Select(e => e.GetString()!).ToArray();
            Assert.Equal(3, skipped.Length);
            Assert.Equal("Jane Doe: an account named Jane_Doe already exists (map it by hand)", skipped[0]);
            Assert.StartsWith("Kim Lee: ", skipped[1], StringComparison.Ordinal);
            Assert.Equal("Someone with a very long name indeed: Reclaimerr allows at most 32 characters", skipped[2]);
            Assert.Equal("Mapped = m\nSam = Sam_user\nAna.Maria = Ana_Maria", c.ReclaimerrUserMap);
            Assert.Equal(c.ReclaimerrUserMap, root.GetProperty("userMap").GetString());

            // Each new account: a User with only the grantable permissions and pages picked, made through the service account.
            var made = server.Posts.Where(p => p.Path == "/api/account/users").ToList();
            Assert.Equal(3, made.Count);
            var bodies = made.Select(p => JsonDocument.Parse(p.Body).RootElement).ToList();
            Assert.Equal(new[] { "Sam_user", "Ana_Maria", "Kim_Lee" }, bodies.Select(b => b.GetProperty("username").GetString()));
            Assert.All(made, p => Assert.Equal((null, "svc"), (p.Bearer, p.User)));
            Assert.All(bodies, b =>
            {
                Assert.Equal("user", b.GetProperty("role").GetString());
                Assert.Equal(new[] { "request" }, b.GetProperty("permissions").EnumerateArray().Select(e => e.GetString()));
                Assert.Equal(new[] { "requests" }, b.GetProperty("allowed_pages").EnumerateArray().Select(e => e.GetString()));
                Assert.False(b.GetProperty("use_default_page_access").GetBoolean());
                Assert.False(b.GetProperty("require_password_change").GetBoolean());
                Assert.True(b.GetProperty("password").GetString()!.Length >= 24);
            });
            Assert.Equal("Sam", bodies[0].GetProperty("display_name").GetString());
            Assert.NotEqual(bodies[0].GetProperty("password").GetString(), bodies[1].GetProperty("password").GetString());
        }
    }

    [Fact]
    public async Task Only_administrators_act_and_review_while_anyone_who_can_see_an_item_learns_only_whether_they_may_request()
    {
        var movie = AddMovie("Film", "550");
        using var server = new Server();
        server.Answer = s => s.Path.StartsWith("/api/v1/candidates", StringComparison.Ordinal) ? (200, Candidates()) : s.Path == "/api/media/scheduled-deletions" ? (200, "[]") : (404, "{}");
        var (actions, leaving, cache) = Services(server, account: null);
        using (cache)
        {
            var admin = new User("admin", "default", "default") { Id = Guid.NewGuid() };
            var viewer = new User("viewer", "default", "default") { Id = Guid.NewGuid() };
            var users = new Mock<IUserManager>();
            users.Setup(u => u.GetUserById(admin.Id)).Returns(admin);
            users.Setup(u => u.GetUserById(viewer.Id)).Returns(viewer);
            JeMediaTagsController As(User user, bool isAdmin)
            {
                var controller = (JeMediaTagsController)ApiAssetTests.Controller(typeof(JeMediaTagsController), _f.Core, users.Object, _library.Object, cache);
                controller.HttpContext.User = global::JE.Tests.Features.SpoilerGuard.PrivacyPolicyTests.Principal(user.Id, admin: isAdmin);
                return controller;
            }

            var asAdmin = As(admin, true);
            var asViewer = As(viewer, false);
            var state = Assert.IsType<OkObjectResult>(asAdmin.GetReclaimerrItemState(movie.Id, actions));
            Assert.Contains("\"provider\":\"reclaimerr\"", JsonSerializer.Serialize(state.Value));
            // Without a service account there are no requests: a viewer learns nothing about the item.
            Assert.IsType<NotFoundResult>(asViewer.GetReclaimerrItemState(movie.Id, actions));
            Assert.IsType<NotFoundResult>(await asViewer.RequestReclaimerrRemoval(new ReclaimerrItemRequest { ItemId = movie.Id }, actions, CancellationToken.None));
            foreach (var action in new Func<Task<IActionResult>>[]
            {
                () => asViewer.MarkForReclaimerrRemoval(new ReclaimerrItemRequest { ItemId = movie.Id }, actions, CancellationToken.None),
                () => asViewer.KeepFromReclaimerrRemoval(new ReclaimerrItemRequest { ItemId = movie.Id }, actions, CancellationToken.None),
                () => asViewer.PostponeReclaimerrRemoval(new ReclaimerrItemRequest { ItemId = movie.Id, Days = 7 }, actions, CancellationToken.None),
                () => asViewer.ApproveReclaimerrRequest(5, null, actions, CancellationToken.None),
                () => asViewer.DenyReclaimerrRequest(5, null, actions, CancellationToken.None),
                () => asViewer.CreateReclaimerrServiceAccount(new ReclaimerrServiceAccountRequest { AdminUsername = "x" }, Clients(), CancellationToken.None),
            })
            {
                Assert.IsType<ForbidResult>(await action());
            }

            Assert.Empty(server.Posts);
            // The page is off: its list answers 404 for everyone; Maintainerr's routes answer 404 while Reclaimerr is on.
            Assert.IsType<NotFoundResult>(await asAdmin.GetLeavingSoonList(leaving, actions, CancellationToken.None));
            Assert.IsType<NotFoundResult>(asAdmin.GetMaintainerrItemState(movie.Id, new MaintainerrActions(Clients(), _library.Object, leaving, cache, _f.Core.Logger)));
        }
    }
}
