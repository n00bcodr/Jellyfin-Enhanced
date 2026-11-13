using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Features.MediaTags;
using Jellyfin.Plugin.JellyfinEnhanced.Features.MediaTags.Models;
using Jellyfin.Plugin.JellyfinEnhanced.Features.MediaTags.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.MediaTags;
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
/// The administrator's Maintainerr actions (upstream 481a10ee): which manual collection an item goes to (library,
/// then the *arr server that holds it, then type), the requests Mark, Keep and Postpone send, the refresh that
/// follows, the collection id kept per member, and the home row's item order.
/// </summary>
[Collection("Plugin singleton")]
public sealed class IntegrationMaintainerrActionsTests : IDisposable
{
    private readonly ApiPluginFixture _f = new();
    private readonly Mock<ILibraryManager> _library = new();
    private readonly List<BaseItem> _items = new();
    private readonly ILibraryManager? _previousLibrary = BaseItem.LibraryManager;
    private static readonly string LibMovies = Guid.NewGuid().ToString("N");
    private static readonly string LibShows = Guid.NewGuid().ToString("N");

    public IntegrationMaintainerrActionsTests()
    {
        _library.Setup(l => l.GetItemById(It.IsAny<Guid>())).Returns((Guid id) => _items.SingleOrDefault(i => i.Id == id));
        _library.Setup(l => l.GetItemById<BaseItem>(It.IsAny<Guid>())).Returns((Guid id) => _items.SingleOrDefault(i => i.Id == id));
        _library.Setup(l => l.GetItemList(It.IsAny<InternalItemsQuery>())).Returns(Array.Empty<BaseItem>());
        // ItemLibraryResolver asks for the item's collection folders: movies and series each live in one library.
        _library.Setup(l => l.GetCollectionFolders(It.IsAny<BaseItem>())).Returns((BaseItem i) => new List<Folder> { new CollectionFolder { Id = Guid.ParseExact(i is Movie ? LibMovies : LibShows, "N") } });
        BaseItem.LibraryManager = _library.Object;
    }

    public void Dispose()
    {
        BaseItem.LibraryManager = _previousLibrary!;
        _f.Dispose();
    }

    /// <summary>A loopback Maintainerr (and *arr) that records every request and answers per path.</summary>
    private sealed class Server : IDisposable
    {
        private readonly HttpListener _listener = new();
        public string Url { get; }
        public List<(string Method, string Path, string Body)> Seen { get; } = new();
        public Func<string, string, string, (int Status, string Body)> Answer { get; set; } = (_, _, _) => (404, "{}");

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
                        var (status, answer) = Answer(context.Request.HttpMethod, path, body);
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

        public List<(string Method, string Path, string Body)> Posts { get { lock (Seen) return Seen.Where(s => s.Method == "POST").ToList(); } }

        public void Dispose() => _listener.Close();
    }

    private static IHttpClientFactory Clients()
    {
        var services = new ServiceCollection();
        LeavingSoonService.AddHttpClient(services);
        return services.BuildServiceProvider().GetRequiredService<IHttpClientFactory>();
    }

    private static string Collections(params (int Id, string Title, string Library, string Type, int? Radarr, int? Sonarr, bool Manual, (string Id, string Added)[] Media)[] collections)
        => JsonSerializer.Serialize(collections.Select(c => new Dictionary<string, object?>
        {
            ["id"] = c.Id, ["title"] = c.Title, ["libraryId"] = c.Library, ["type"] = c.Type, ["isActive"] = true, ["manualCollection"] = c.Manual, ["deleteAfterDays"] = 30,
            ["radarrSettingsId"] = c.Radarr, ["sonarrSettingsId"] = c.Sonarr,
            ["media"] = c.Media.Select(m => new Dictionary<string, object?> { ["mediaServerId"] = m.Id, ["addDate"] = m.Added }).ToArray(),
        }));

    private static MaintainerrCollection C(int id, string title, string library, string type, int? radarr = null, int? sonarr = null, bool manual = true, bool active = true)
        => new(id, title, library, type, active, manual, 30, radarr, sonarr);

    private static Task<MaintainerrMatch> Match(BaseItem item, string? library, IEnumerable<MaintainerrCollection> collections, Func<MaintainerrArrServer, bool?>? holds = null, params MaintainerrArrServer[] servers)
        => MaintainerrActions.MatchAsync(item, library, collections.ToList(), _ => Task.FromResult<IReadOnlyList<MaintainerrArrServer>>(servers), (s, _) => Task.FromResult(holds?.Invoke(s)));

    [Fact]
    public async Task An_item_goes_to_the_one_manual_collection_of_its_type_on_its_library()
    {
        var movie = new Movie { Id = Guid.NewGuid(), Name = "Film" };
        var all = new[] { C(1, "Leaving Soon (Movies)", LibMovies, "movie", radarr: 1), C(2, "Leaving Soon (Shows)", LibShows, "show", sonarr: 1), C(3, "Rule list", LibMovies, "movie", manual: false), C(4, "Old", LibMovies, "movie", active: false) };
        Assert.Equal(1, (await Match(movie, LibMovies, all)).Collection!.Id);
        // Maintainerr may write the library id with dashes.
        Assert.Equal(1, (await Match(movie, LibMovies, new[] { C(1, "M", Guid.ParseExact(LibMovies, "N").ToString(), "movie") })).Collection!.Id);
        Assert.Equal(2, (await Match(new Series { Id = Guid.NewGuid(), Name = "Show" }, LibShows, all)).Collection!.Id);
        // Without a library id of its own, the item's type alone picks when that leaves one.
        Assert.Equal(2, (await Match(new Series { Id = Guid.NewGuid() }, null, all)).Collection!.Id);

        Assert.Contains("Only movies and series", (await Match(new Episode { Id = Guid.NewGuid() }, LibShows, all)).Error);
        Assert.Contains("no active manual collection", (await Match(movie, LibMovies, new[] { C(3, "Rule list", LibMovies, "movie", manual: false) })).Error);
        var noMovies = await Match(movie, LibMovies, new[] { C(2, "Leaving Soon (Shows)", LibShows, "show") });
        Assert.Contains("no manual collection for movies", noMovies.Error);
        Assert.Contains("Leaving Soon (Shows)", noMovies.Error);
        var otherLibrary = await Match(movie, Guid.NewGuid().ToString("N"), all);
        Assert.Contains("on this item's library", otherLibrary.Error);
        Assert.Contains("Leaving Soon (Movies)", otherLibrary.Error);
    }

    [Fact]
    public async Task Two_collections_on_one_library_are_told_apart_by_the_arr_server_that_holds_the_item()
    {
        var movie = new Movie { Id = Guid.NewGuid(), Name = "Film" };
        var two = new[] { C(1, "Leaving Soon (Movies)", LibMovies, "movie", radarr: 1), C(2, "Leaving Soon (Movies4K)", LibMovies, "movie", radarr: 2) };
        var servers = new[] { new MaintainerrArrServer(1, "Radarr", "http://radarr", "k1"), new MaintainerrArrServer(2, "Radarr4K", "http://radarr4k", "k2") };
        Assert.Equal(2, (await Match(movie, LibMovies, two, s => s.Id == 2, servers)).Collection!.Id);
        Assert.Equal(1, (await Match(movie, LibMovies, two, s => s.Id == 1 ? true : null, servers)).Collection!.Id);
        Assert.Contains("more than one Radarr/Sonarr server has it", (await Match(movie, LibMovies, two, _ => true, servers)).Error);
        Assert.Contains("none of their Radarr/Sonarr servers has it", (await Match(movie, LibMovies, two, _ => false, servers)).Error);
        var unknown = await Match(movie, LibMovies, two, _ => null, servers);
        Assert.Contains("could not be asked", unknown.Error);
        Assert.Contains("Leaving Soon (Movies4K)", unknown.Error);
        // A collection whose server Maintainerr no longer lists cannot be chosen, and says so.
        Assert.Contains("could not be asked", (await Match(movie, LibMovies, two, _ => false, servers[0])).Error);
    }

    private (MaintainerrActions Actions, LeavingSoonService Leaving, TagCacheService Cache) Services(Server server)
    {
        _f.Plugin.Configuration.TagCacheServerMode = true;
        _f.Plugin.Configuration.LeavingSoonMaintainerrUrl = server.Url;
        _f.Plugin.Configuration.LeavingSoonMaintainerrApiKey = "secret-key";
        var clients = Clients();
        var leaving = new LeavingSoonService(clients, Path.Combine(_f.Core.Root, "leaving-soon.json"), _library.Object, _f.Core.Logger) { Timeout = TimeSpan.FromSeconds(5) };
        var cache = new TagCacheService(_library.Object, _f.Core.Paths.Object, Mock.Of<ILocalizationManager>(), _f.Core.Logger, new MatroskaLanguageCache(_f.Core.Paths.Object, _f.Core.Logger), leavingSoonService: leaving);
        var actions = new MaintainerrActions(clients, _library.Object, leaving, cache, _f.Core.Logger) { Timeout = TimeSpan.FromSeconds(5) };
        return (actions, leaving, cache);
    }

    [Fact]
    public async Task Mark_adds_the_item_to_the_fitting_collection_with_the_key_and_refreshes_the_facts()
    {
        var movie = new Movie { Id = Guid.NewGuid(), Name = "Film" };
        _items.Add(movie);
        var added = DateTimeOffset.UtcNow.Date.ToString("yyyy-MM-dd HH:mm:ss");
        using var server = new Server();
        var marked = false;
        server.Answer = (method, path, body) =>
        {
            if (path == "/api/collections") return (200, Collections((1, "Leaving Soon (Movies)", LibMovies, "movie", 1, null, true, marked ? new[] { (movie.Id.ToString("N"), added) } : Array.Empty<(string, string)>()), (2, "Leaving Soon (Shows)", LibShows, "show", null, 1, true, Array.Empty<(string, string)>())));
            if (path.StartsWith("/api/collections/media/1/content/")) return (200, marked ? "{\"items\":[{\"mediaServerId\":\"" + movie.Id.ToString("N") + "\",\"addDate\":\"" + added + "\"}],\"totalSize\":1}" : "{\"items\":[],\"totalSize\":0}");
            if (path.Contains("/content/")) return (200, "{\"items\":[],\"totalSize\":0}");
            if (path == "/api/settings/radarr") return (200, "[{\"id\":1,\"serverName\":\"Radarr\",\"url\":\"http://127.0.0.1:1\",\"apiKey\":\"r\"}]");
            if (method == "POST" && path == "/api/collections/media/add") { marked = JsonDocument.Parse(body).RootElement.GetProperty("action").GetInt32() == 0; return (201, "{\"id\":1}"); }
            return (404, "{\"message\":\"nope\"}");
        };
        var (actions, leaving, cache) = Services(server);
        using (cache)
        {
            var state = await actions.MarkAsync(movie, _f.Plugin.Configuration, CancellationToken.None);
            var post = Assert.Single(server.Posts);
            Assert.Equal("/api/collections/media/add", post.Path);
            using var sent = JsonDocument.Parse(post.Body);
            Assert.Equal(0, sent.RootElement.GetProperty("action").GetInt32());
            Assert.Equal(movie.Id.ToString("N"), sent.RootElement.GetProperty("mediaId").GetString());
            Assert.Equal("movie", sent.RootElement.GetProperty("context").GetProperty("type").GetString());
            Assert.Equal(movie.Id.ToString("N"), sent.RootElement.GetProperty("context").GetProperty("id").GetString());
            Assert.Equal(1, sent.RootElement.GetProperty("collectionId").GetInt32());
            // One collection fits the movie's library: no *arr server is asked.
            Assert.DoesNotContain(server.Seen, s => s.Path.StartsWith("/api/settings/") || s.Path.StartsWith("/api/v3/"));

            // The facts were read again at once: the badge and the home row know the new member and its collection.
            Assert.True(state.Marked);
            Assert.Equal(1, state.CollectionId);
            Assert.Equal("Leaving Soon (Movies)", state.CollectionName);
            Assert.NotNull(state.DeleteAt);
            Assert.Equal(1, leaving.CollectionOf(movie.Id, _f.Plugin.Configuration));
            Assert.Equal(movie.Id, Assert.Single(leaving.MaintainerrItems(_f.Plugin.Configuration)).ItemId);

            // Marking again is refused before anything is sent.
            var again = await Assert.ThrowsAsync<MaintainerrActions.ActionException>(() => actions.MarkAsync(movie, _f.Plugin.Configuration, CancellationToken.None));
            Assert.Contains("already marked", again.Message);
            Assert.Single(server.Posts);

            // Keep removes it from the collection it is in (action 1), then reads again.
            marked = false;
            var kept = await actions.UnmarkAsync(movie, _f.Plugin.Configuration, CancellationToken.None);
            var removal = server.Posts.Last();
            using var removed = JsonDocument.Parse(removal.Body);
            Assert.Equal(1, removed.RootElement.GetProperty("action").GetInt32());
            Assert.Equal(1, removed.RootElement.GetProperty("collectionId").GetInt32());
            Assert.False(kept.Marked);
            Assert.Null(leaving.CollectionOf(movie.Id, _f.Plugin.Configuration));
            var notMarked = await Assert.ThrowsAsync<MaintainerrActions.ActionException>(() => actions.UnmarkAsync(movie, _f.Plugin.Configuration, CancellationToken.None));
            Assert.Contains("not marked", notMarked.Message);
        }
    }

    [Fact]
    public async Task Postpone_sends_the_days_or_none_for_a_reset_and_refuses_bad_counts_and_unmarked_items()
    {
        var series = new Series { Id = Guid.NewGuid(), Name = "Show" };
        _items.Add(series);
        using var server = new Server();
        server.Answer = (method, path, body) =>
        {
            if (path == "/api/collections") return (200, Collections((2, "Leaving Soon (Shows)", LibShows, "show", null, 1, true, new[] { (series.Id.ToString("N"), "2026-11-01 00:00:00") })));
            if (path.Contains("/content/")) return (200, "{\"items\":[{\"mediaServerId\":\"" + series.Id.ToString("N") + "\",\"addDate\":\"2026-11-01 00:00:00\"}],\"totalSize\":1}");
            if (method == "POST" && path == "/api/collections/media/postpone") return (200, "{\"collectionId\":2}");
            return (404, "{\"message\":\"nope\"}");
        };
        var (actions, leaving, cache) = Services(server);
        using (cache)
        {
            var state = await actions.PostponeAsync(series, 14, _f.Plugin.Configuration, CancellationToken.None);
            Assert.True(state.Marked);
            using var withDays = JsonDocument.Parse(server.Posts.Last().Body);
            Assert.Equal(14, withDays.RootElement.GetProperty("days").GetInt32());
            Assert.Equal(2, withDays.RootElement.GetProperty("collectionId").GetInt32());
            Assert.Equal(series.Id.ToString("N"), withDays.RootElement.GetProperty("mediaId").GetString());

            await actions.PostponeAsync(series, null, _f.Plugin.Configuration, CancellationToken.None);
            using var reset = JsonDocument.Parse(server.Posts.Last().Body);
            Assert.False(reset.RootElement.TryGetProperty("days", out _));

            await Assert.ThrowsAsync<MaintainerrActions.ActionException>(() => actions.PostponeAsync(series, 0, _f.Plugin.Configuration, CancellationToken.None));
            await Assert.ThrowsAsync<MaintainerrActions.ActionException>(() => actions.PostponeAsync(series, 3651, _f.Plugin.Configuration, CancellationToken.None));
            var other = new Movie { Id = Guid.NewGuid(), Name = "Unlisted" };
            _items.Add(other);
            Assert.Contains("not marked", (await Assert.ThrowsAsync<MaintainerrActions.ActionException>(() => actions.PostponeAsync(other, 7, _f.Plugin.Configuration, CancellationToken.None))).Message);
            Assert.Equal(2, server.Posts.Count);
            Assert.All(server.Seen, s => Assert.True(s.Path.StartsWith("/api/")));
        }
    }

    [Fact]
    public async Task A_refused_or_failed_Maintainerr_answer_is_reported_by_its_reason_without_the_address()
    {
        var movie = new Movie { Id = Guid.NewGuid(), Name = "Film" };
        _items.Add(movie);
        using var server = new Server();
        server.Answer = (method, path, body) =>
        {
            if (path == "/api/collections") return (200, Collections((1, "Leaving Soon (Movies)", LibMovies, "movie", 1, null, true, Array.Empty<(string, string)>())));
            if (path.Contains("/content/")) return (200, "{\"items\":[],\"totalSize\":0}");
            if (method == "POST") return (400, "{\"message\":\"This item cannot be applied to the selected collection\",\"statusCode\":400}");
            return (404, "{}");
        };
        var (actions, _, cache) = Services(server);
        using (cache)
        {
            var ex = await Assert.ThrowsAsync<MaintainerrHttp.MaintainerrException>(() => actions.MarkAsync(movie, _f.Plugin.Configuration, CancellationToken.None));
            Assert.Equal("This item cannot be applied to the selected collection", MaintainerrHttp.Describe(ex));
            Assert.DoesNotContain(server.Url, MaintainerrHttp.Describe(ex));
            Assert.Equal("HTTP 500", MaintainerrHttp.Describe(new MaintainerrHttp.MaintainerrException(500, null)));
        }
    }

    [Fact]
    public void Collections_are_read_with_the_fields_the_resolver_needs()
    {
        var json = "[{\"id\":7,\"title\":\"Leaving Soon (Regional)\",\"libraryId\":\"b925f3517169c65bba6374115cc0fe95\",\"type\":\"movie\",\"isActive\":true,\"manualCollection\":true,\"deleteAfterDays\":30,\"radarrSettingsId\":1,\"sonarrSettingsId\":null,\"media\":[]},{\"id\":10,\"title\":\"Shows\",\"libraryId\":\"a6\",\"type\":2,\"isActive\":false,\"manualCollection\":false,\"sonarrSettingsId\":1},{\"nonsense\":true}]";
        var parsed = MaintainerrActions.ParseCollections(JsonDocument.Parse(json).RootElement);
        Assert.Equal(2, parsed.Count);
        Assert.Equal(new MaintainerrCollection(7, "Leaving Soon (Regional)", "b925f3517169c65bba6374115cc0fe95", "movie", true, true, 30, 1, null), parsed[0]);
        Assert.Equal(new MaintainerrCollection(10, "Shows", "a6", "show", false, false, null, null, 1), parsed[1]);
        Assert.Equal(parsed, MaintainerrActions.ParseCollections(JsonDocument.Parse("{\"data\":" + json + "}").RootElement));
        Assert.Throws<JsonException>(() => MaintainerrActions.ParseCollections(JsonDocument.Parse("{\"error\":1}").RootElement));
    }

    [Fact]
    public void The_home_row_lists_visible_movies_and_series_soonest_first_once_each_within_the_limit()
    {
        var series = new Series { Id = Guid.NewGuid(), Name = "Show" };
        var season = new Season { Id = Guid.NewGuid(), Name = "S1", SeriesId = series.Id };
        var episode = new Episode { Id = Guid.NewGuid(), Name = "Pilot", SeriesId = series.Id, SeasonId = season.Id };
        var soon = new Movie { Id = Guid.NewGuid(), Name = "Soon" };
        var later = new Movie { Id = Guid.NewGuid(), Name = "Later" };
        var undated = new Movie { Id = Guid.NewGuid(), Name = "Undated" };
        var gone = Guid.NewGuid();
        _items.AddRange(new BaseItem[] { series, season, episode, soon, later, undated });
        var hidden = new Movie { Id = Guid.NewGuid(), Name = "Hidden" };
        var broken = new Movie { Id = Guid.NewGuid(), Name = "Broken" };
        _items.AddRange(new[] { hidden, broken });
        var members = new List<(Guid, long?)> { (later.Id, 20L), (undated.Id, null), (episode.Id, 5L), (soon.Id, 1L), (season.Id, 7L), (gone, 2L), (hidden.Id, 3L), (broken.Id, 4L) };
        bool Visible(BaseItem item) => item == broken ? throw new InvalidOperationException("no live tv manager") : item != hidden;
        var ordered = LeavingSoonSectionResults.Order(members, id => _items.SingleOrDefault(i => i.Id == id), Visible);
        Assert.Equal(new[] { "Soon", "Show", "Later", "Undated" }, ordered.Select(i => i.Name));

        var many = Enumerable.Range(0, LeavingSoonHomeSection.Limit + 5).Select(i => new Movie { Id = Guid.NewGuid(), Name = "M" + i }).ToList();
        _items.AddRange(many);
        Assert.Equal(LeavingSoonHomeSection.Limit, LeavingSoonSectionResults.Order(many.Select(m => (m.Id, (long?)1L)).ToList(), id => _items.SingleOrDefault(i => i.Id == id), _ => true).Count);
    }

    [Fact]
    public void The_row_and_the_actions_need_their_switch_and_a_Maintainerr_url()
    {
        var config = new PluginConfiguration { LeavingSoonMaintainerrUrl = "http://maintainerr:6246" };
        Assert.True(LeavingSoonHomeSection.Wanted(config));
        Assert.True(MaintainerrActions.Enabled(config));
        Assert.False(LeavingSoonHomeSection.Wanted(new PluginConfiguration { LeavingSoonMaintainerrUrl = "http://maintainerr:6246", LeavingSoonHomeRow = false }));
        Assert.False(MaintainerrActions.Enabled(new PluginConfiguration { LeavingSoonMaintainerrUrl = "http://maintainerr:6246", LeavingSoonMaintainerrActions = false }));
        Assert.False(LeavingSoonHomeSection.Wanted(new PluginConfiguration { LeavingSoonCollections = "Leaving Soon" }));
        Assert.False(MaintainerrActions.Enabled(null));
        Assert.Matches("^[A-Za-z][A-Za-z0-9_-]*$", LeavingSoonHomeSection.SectionId);
        // The home row's state comes from LeavingSoonHomeSection through LeavingSoonService (here it says what it found).
        var leaving = new LeavingSoonService(Clients(), Path.Combine(_f.Core.Root, "none.json"), null, _f.Core.Logger);
        Assert.Equal("unknown", leaving.Status(config).HomeRow);
        leaving.HomeRowStatus = "hss-missing";
        var status = leaving.Status(config);
        Assert.True(status.Actions);
        Assert.Equal("hss-missing", status.HomeRow);
        // Not wanted is "off", whatever the row's service last found.
        Assert.Equal("off", leaving.Status(new PluginConfiguration()).HomeRow);
        Assert.Equal("off", leaving.Status(new PluginConfiguration { LeavingSoonMaintainerrUrl = "http://maintainerr:6246", LeavingSoonHomeRow = false }).HomeRow);
        Assert.False(leaving.Status(new PluginConfiguration { LeavingSoonMaintainerrUrl = "http://maintainerr:6246", LeavingSoonMaintainerrActions = false }).Actions);
    }
    [Fact]
    public async Task The_routes_answer_administrators_only_and_nothing_while_the_actions_are_off()
    {
        var movie = new Movie { Id = Guid.NewGuid(), Name = "Film" };
        _items.Add(movie);
        using var server = new Server();
        server.Answer = (method, path, body) => path == "/api/collections"
            ? (200, Collections((1, "Leaving Soon (Movies)", LibMovies, "movie", 1, null, true, Array.Empty<(string, string)>())))
            : path.Contains("/content/") ? (200, "{\"items\":[],\"totalSize\":0}") : (201, "{}");
        var (actions, _, cache) = Services(server);
        using (cache)
        {
            var admin = new User("admin", "default", "default") { Id = Guid.NewGuid() };
            var viewer = new User("viewer", "default", "default") { Id = Guid.NewGuid() };
            var users = new Mock<IUserManager>();
            users.Setup(u => u.GetUserById(admin.Id)).Returns(admin);
            users.Setup(u => u.GetUserById(viewer.Id)).Returns(viewer);
            var controller = (JeMediaTagsController)ApiAssetTests.Controller(typeof(JeMediaTagsController), _f.Core, users.Object, _library.Object, cache);
            var body = new MaintainerrActionRequest { ItemId = movie.Id };

            // A non-administrator is refused before anything is read or sent.
            controller.HttpContext.User = global::JE.Tests.Features.SpoilerGuard.PrivacyPolicyTests.Principal(viewer.Id);
            Assert.IsType<ForbidResult>(controller.GetMaintainerrItemState(movie.Id, actions));
            Assert.IsType<ForbidResult>(await controller.MarkForMaintainerrRemoval(body, actions, CancellationToken.None));
            Assert.IsType<ForbidResult>(await controller.KeepFromMaintainerrRemoval(body, actions, CancellationToken.None));
            Assert.IsType<ForbidResult>(await controller.PostponeMaintainerrRemoval(new MaintainerrActionRequest { ItemId = movie.Id, Days = 7 }, actions, CancellationToken.None));
            Assert.Empty(server.Seen);

            controller.HttpContext.User = global::JE.Tests.Features.SpoilerGuard.PrivacyPolicyTests.Principal(admin.Id, admin: true);
            var state = Assert.IsType<OkObjectResult>(controller.GetMaintainerrItemState(movie.Id, actions)).Value as MaintainerrItemState;
            Assert.False(state!.Marked);
            Assert.True(state.Supported);
            Assert.IsType<NotFoundResult>(controller.GetMaintainerrItemState(Guid.NewGuid(), actions));
            Assert.IsType<BadRequestObjectResult>(await controller.MarkForMaintainerrRemoval(new MaintainerrActionRequest(), actions, CancellationToken.None));
            Assert.IsType<OkObjectResult>(await controller.MarkForMaintainerrRemoval(body, actions, CancellationToken.None));
            Assert.Single(server.Posts);

            // Switched off (or no Maintainerr URL): every route answers 404 and nothing reaches Maintainerr.
            _f.Plugin.Configuration.LeavingSoonMaintainerrActions = false;
            var seen = server.Seen.Count;
            Assert.IsType<NotFoundResult>(controller.GetMaintainerrItemState(movie.Id, actions));
            Assert.IsType<NotFoundResult>(await controller.KeepFromMaintainerrRemoval(body, actions, CancellationToken.None));
            _f.Plugin.Configuration.LeavingSoonMaintainerrActions = true;
            _f.Plugin.Configuration.LeavingSoonMaintainerrUrl = string.Empty;
            Assert.IsType<NotFoundResult>(await controller.PostponeMaintainerrRemoval(new MaintainerrActionRequest { ItemId = movie.Id, Days = 7 }, actions, CancellationToken.None));
            Assert.Equal(seen, server.Seen.Count);
        }
    }

    [Fact]
    public async Task A_failed_Maintainerr_answers_502_with_its_reason_and_a_refusal_400()
    {
        var movie = new Movie { Id = Guid.NewGuid(), Name = "Film" };
        _items.Add(movie);
        using var server = new Server();
        server.Answer = (method, path, body) => path == "/api/collections"
            ? (200, Collections((2, "Leaving Soon (Shows)", LibShows, "show", null, 1, true, Array.Empty<(string, string)>())))
            : path.Contains("/content/") ? (200, "{\"items\":[],\"totalSize\":0}") : (500, "{\"message\":\"database is locked\"}");
        var (actions, _, cache) = Services(server);
        using (cache)
        {
            var admin = new User("admin", "default", "default") { Id = Guid.NewGuid() };
            var users = new Mock<IUserManager>();
            users.Setup(u => u.GetUserById(admin.Id)).Returns(admin);
            var controller = (JeMediaTagsController)ApiAssetTests.Controller(typeof(JeMediaTagsController), _f.Core, users.Object, _library.Object, cache);
            controller.HttpContext.User = global::JE.Tests.Features.SpoilerGuard.PrivacyPolicyTests.Principal(admin.Id, admin: true);
            // No manual collection for movies: a refusal with the reason, nothing sent.
            var refused = Assert.IsType<BadRequestObjectResult>(await controller.MarkForMaintainerrRemoval(new MaintainerrActionRequest { ItemId = movie.Id }, actions, CancellationToken.None));
            Assert.Contains("no manual collection for movies", JsonSerializer.Serialize(refused.Value));
            Assert.Empty(server.Posts);

            server.Answer = (method, path, body) => path == "/api/collections"
                ? (200, Collections((1, "Leaving Soon (Movies)", LibMovies, "movie", 1, null, true, Array.Empty<(string, string)>())))
                : path.Contains("/content/") ? (200, "{\"items\":[],\"totalSize\":0}") : (500, "{\"message\":\"database is locked\"}");
            var failed = Assert.IsType<ObjectResult>(await controller.MarkForMaintainerrRemoval(new MaintainerrActionRequest { ItemId = movie.Id }, actions, CancellationToken.None));
            Assert.Equal(502, failed.StatusCode);
            var text = JsonSerializer.Serialize(failed.Value);
            Assert.Contains("Maintainerr: database is locked", text);
            Assert.DoesNotContain(server.Url, text);
            Assert.DoesNotContain("secret-key", text);
        }
    }
}
