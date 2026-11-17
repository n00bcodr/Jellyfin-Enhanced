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
