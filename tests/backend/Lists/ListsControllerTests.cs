using System.Net;
using System.Net.Http.Json;
using System.Security.Claims;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Controllers;
using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Controllers;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace JE.Tests;

// The HTTP surface of /JellyfinEnhanced/acquire/lists through real ASP.NET routing/auth: anonymous 401, lists switch
// 404 {code:"disabled"}, viewer 403 on edits, hidden lists 404, input validation 400, the success shapes, durable
// request-id replays and conflicts, and the authoring / swap-in switches.
[Collection("Plugin singleton")]
public class ListsControllerTests
{
    private sealed class HeaderAuthentication(IOptionsMonitor<AuthenticationSchemeOptions> options, ILoggerFactory logger, UrlEncoder encoder)
        : AuthenticationHandler<AuthenticationSchemeOptions>(options, logger, encoder)
    {
        protected override Task<AuthenticateResult> HandleAuthenticateAsync()
        {
            var user = Request.Headers["X-Test-User"].ToString();
            if (user.Length == 0)
            {
                return Task.FromResult(AuthenticateResult.NoResult());
            }

            var role = Request.Headers["X-Test-Role"].ToString();
            var identity = new ClaimsIdentity(new[] { new Claim("Jellyfin-UserId", user), new Claim(ClaimTypes.Role, role.Length > 0 ? role : "User") }, Scheme.Name);
            return Task.FromResult(AuthenticateResult.Success(new AuthenticationTicket(new ClaimsPrincipal(identity), Scheme.Name)));
        }
    }

    private sealed class Activator(Func<Type, ControllerBase> create) : IControllerActivator
    {
        public object Create(ControllerContext context)
        {
            var controller = create(context.ActionDescriptor.ControllerTypeInfo.AsType());
            controller.ControllerContext = context;
            return controller;
        }

        public void Release(ControllerContext context, object controller) { }
    }

    private sealed class Fixture : IDisposable
    {
        private readonly IHost _host;

        public ListsHarness H { get; } = new();
        public User Owner { get; }
        public User Viewer { get; }
        public User Stranger { get; }
        public FakeListHost.FakeList Playlist { get; }
        public FakeListHost.FakeList Private { get; }
        public FakeListHost.FakeList Collection { get; }

        public Fixture()
        {
            Owner = H.NewUser("owner");
            Viewer = H.NewUser("viewer");
            Stranger = H.NewUser("stranger");
            Playlist = H.Host.AddPlaylist(Owner, openAccess: true);
            Private = H.Host.AddPlaylist(Owner);
            Collection = H.Host.AddCollection();
            _host = new HostBuilder().ConfigureWebHost(web => web.UseTestServer().ConfigureServices(services =>
            {
                services.AddLogging();
                services.AddRouting();
                services.AddAuthentication("test").AddScheme<AuthenticationSchemeOptions, HeaderAuthentication>("test", _ => { });
                services.AddAuthorization();
                services.AddControllers().AddApplicationPart(typeof(AcquireListsController).Assembly);
                services.AddSingleton<IControllerActivator>(new Activator(type => type == typeof(AcquireListsController)
                    ? new AcquireListsController(H.Users.Object, H.Access, H.Service, H.Plugin.Core.Logger)
                    : throw new InvalidOperationException("Unexpected controller " + type)));
            }).Configure(app =>
            {
                app.UseRouting();
                app.UseAuthentication();
                app.UseAuthorization();
                app.UseEndpoints(e => e.MapControllers());
            })).Start();
        }

        public HttpClient Client(User? user, bool admin = false)
        {
            var client = _host.GetTestServer().CreateClient();
            if (user != null)
            {
                client.DefaultRequestHeaders.Add("X-Test-User", user.Id.ToString());
                client.DefaultRequestHeaders.Add("X-Test-Role", admin ? "Administrator" : "User");
            }

            return client;
        }

        public HttpClient Ghost()
        {
            var client = _host.GetTestServer().CreateClient();
            client.DefaultRequestHeaders.Add("X-Test-User", Guid.NewGuid().ToString());
            return client;
        }

        public void Dispose()
        {
            _host.Dispose();
            H.Dispose();
        }
    }

    private const string Base = "/JellyfinEnhanced/acquire/lists";

    private static string N(Guid id) => id.ToString("N");

    private static StringContent Json(string json) => new(json, Encoding.UTF8, "application/json");

    private static async Task<JsonElement> Body(HttpResponseMessage response) => JsonDocument.Parse(await response.Content.ReadAsStringAsync()).RootElement;

    private static (string Method, string Path, string? Body)[] Routes(Fixture f)
    {
        var list = N(f.Playlist.Info.Id);
        var ph = new string('a', 32);
        return new (string, string, string?)[]
        {
            ("GET", $"{Base}/{list}", null),
            ("POST", $"{Base}/{list}/items", "{\"placeholders\":[{\"kind\":\"movie\",\"tmdbId\":1,\"title\":\"x\"}]}"),
            ("POST", $"{Base}/{list}/apply", "{\"entries\":[{\"type\":\"placeholder\",\"placeholder\":{\"kind\":\"movie\",\"tmdbId\":1,\"title\":\"x\"}}]}"),
            ("PATCH", $"{Base}/{list}/items/{ph}", "{\"rev\":0,\"note\":\"x\"}"),
            ("DELETE", $"{Base}/{list}/items/{ph}?rev=0", null),
            ("PUT", $"{Base}/{list}/order", "{\"rev\":0,\"order\":[]}"),
            ("GET", $"{Base}/editable", null),
            ("POST", $"{Base}/playlists", "{\"name\":\"x\"}"),
            ("POST", $"{Base}/collections", "{\"name\":\"x\"}"),
            ("PUT", $"{Base}/{list}/swap-in", "{\"rev\":0,\"enabled\":true}"),
        };
    }

    private static Task<HttpResponseMessage> Send(HttpClient client, (string Method, string Path, string? Body) route) =>
        client.SendAsync(new HttpRequestMessage(new HttpMethod(route.Method), route.Path) { Content = route.Body == null ? null : Json(route.Body) });

    [Fact]
    public async Task EveryRouteRequiresAuthentication()
    {
        using var f = new Fixture();
        using var anonymous = f.Client(null);
        foreach (var route in Routes(f))
        {
            using var response = await Send(anonymous, route);
            Assert.True(HttpStatusCode.Unauthorized == response.StatusCode, $"{route.Method} {route.Path} -> {response.StatusCode}");
        }

        Assert.Null(f.H.Store.Load(N(f.Playlist.Info.Id)));
    }

    [Theory]
    [InlineData(nameof(Jellyfin.Plugin.JellyfinEnhanced.Configuration.PluginConfiguration.ArrPhase4ListPlaceholdersEnabled))]
    [InlineData(nameof(Jellyfin.Plugin.JellyfinEnhanced.Configuration.PluginConfiguration.ArrPhase4Enabled))]
    [InlineData(nameof(Jellyfin.Plugin.JellyfinEnhanced.Configuration.PluginConfiguration.ArrPhase3Enabled))]
    [InlineData(nameof(Jellyfin.Plugin.JellyfinEnhanced.Configuration.PluginConfiguration.ArrPhase1Enabled))]
    [InlineData(nameof(Jellyfin.Plugin.JellyfinEnhanced.Configuration.PluginConfiguration.ArrIntegrationEnabled))]
    public async Task EveryRouteIsNotFoundWhileTheFeatureIsOff(string parent)
    {
        // #936 had one master switch; lists now need the whole Requests & downloads chain (any parent off = off).
        using var f = new Fixture();
        typeof(Jellyfin.Plugin.JellyfinEnhanced.Configuration.PluginConfiguration).GetProperty(parent)!.SetValue(f.H.Plugin.Plugin.Configuration, false);
        using var owner = f.Client(f.Owner, admin: true);
        foreach (var route in Routes(f))
        {
            using var response = await Send(owner, route);
            Assert.True(HttpStatusCode.NotFound == response.StatusCode, $"{route.Method} {route.Path} -> {response.StatusCode}");
            Assert.Equal("disabled", (await Body(response)).GetProperty("code").GetString());
        }

        Assert.Empty(f.H.Host.Calls);
        Assert.Empty(f.H.Store.EnumerateListIds());
    }

    [Fact]
    public async Task WithAuthoringOffListsCanBeReadButNotEdited()
    {
        using var f = new Fixture();
        f.H.Plugin.Plugin.Configuration.ArrPhase4ListAuthoringEnabled = false;
        using var owner = f.Client(f.Owner);
        var routes = Routes(f);
        using (var get = await Send(owner, routes[0]))
        {
            Assert.Equal(HttpStatusCode.OK, get.StatusCode);
            var view = await Body(get);
            Assert.True(view.GetProperty("canEdit").GetBoolean());
            Assert.DoesNotContain("edit", view.GetProperty("actions").EnumerateArray().Select(a => a.GetString()));
        }

        foreach (var route in routes.Skip(1).Take(8))
        {
            using var response = await Send(owner, route);
            Assert.True(HttpStatusCode.Forbidden == response.StatusCode, $"{route.Method} {route.Path} -> {response.StatusCode}");
            Assert.Equal("authoring_disabled", (await Body(response)).GetProperty("code").GetString());
        }

        Assert.Null(f.H.Store.Load(N(f.Playlist.Info.Id)));
        Assert.Empty(f.H.Host.Calls);
    }

    [Fact]
    public async Task ViewersCanReadVisibleListsButNotEditThem()
    {
        using var f = new Fixture();
        using var viewer = f.Client(f.Viewer);
        var routes = Routes(f);

        using (var get = await Send(viewer, routes[0]))
        {
            Assert.Equal(HttpStatusCode.OK, get.StatusCode);
            var view = await Body(get);
            Assert.False(view.GetProperty("canEdit").GetBoolean());
            Assert.Equal(N(f.Playlist.Info.Id), view.GetProperty("listId").GetString());
            Assert.Equal("playlist", view.GetProperty("listKind").GetString());
            Assert.Empty(view.GetProperty("actions").EnumerateArray());
            Assert.True(get.Headers.CacheControl!.Private && get.Headers.CacheControl.NoCache);
            Assert.NotNull(get.Headers.ETag);
        }

        foreach (var route in routes.Skip(1).Take(5).Append(routes[9]))
        {
            using var response = await Send(viewer, route);
            Assert.True(HttpStatusCode.Forbidden == response.StatusCode, $"{route.Method} {route.Path} -> {response.StatusCode}");
        }

        using (var create = await Send(viewer, routes[8]))
        {
            Assert.Equal(HttpStatusCode.Forbidden, create.StatusCode);
        }

        Assert.Null(f.H.Store.Load(N(f.Playlist.Info.Id)));
        Assert.Empty(f.H.Host.Calls);
    }

    [Fact]
    public async Task HiddenAndUnknownListsAreNotFoundAndBadIdsAreRejected()
    {
        using var f = new Fixture();
        using var stranger = f.Client(f.Stranger);
        using (var hidden = await stranger.GetAsync($"{Base}/{N(f.Private.Info.Id)}"))
        {
            Assert.Equal(HttpStatusCode.NotFound, hidden.StatusCode);
        }

        using (var hiddenEdit = await stranger.PostAsync($"{Base}/{N(f.Private.Info.Id)}/items", Json("{\"placeholders\":[{\"kind\":\"movie\",\"tmdbId\":1,\"title\":\"x\"}]}")))
        {
            Assert.Equal(HttpStatusCode.NotFound, hiddenEdit.StatusCode);
        }

        using (var unknown = await stranger.GetAsync($"{Base}/{N(Guid.NewGuid())}"))
        {
            Assert.Equal(HttpStatusCode.NotFound, unknown.StatusCode);
        }

        using (var bad = await stranger.GetAsync($"{Base}/not-a-guid"))
        {
            Assert.Equal(HttpStatusCode.BadRequest, bad.StatusCode);
        }

        // An authenticated principal without a Jellyfin user is refused.
        using var ghost = f.Ghost();
        using var ghostResponse = await ghost.GetAsync($"{Base}/editable");
        Assert.Equal(HttpStatusCode.Forbidden, ghostResponse.StatusCode);
    }

    [Theory]
    [InlineData("items", "{\"placeholders\":[]}")]
    [InlineData("items", "{\"placeholders\":[{\"kind\":\"episodes\",\"tmdbId\":1,\"title\":\"x\",\"seasonNumber\":1,\"episodes\":[{\"s\":2,\"e\":1}]}]}")]
    [InlineData("items", "{\"requestId\":\"bad id!\",\"placeholders\":[{\"kind\":\"movie\",\"tmdbId\":1,\"title\":\"x\"}]}")]
    [InlineData("items", "{\"position\":{\"atStart\":true,\"afterToken\":\"p:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"},\"placeholders\":[{\"kind\":\"movie\",\"tmdbId\":1,\"title\":\"x\"}]}")]
    [InlineData("items", "{\"position\":{\"afterToken\":\"<script>\"},\"placeholders\":[{\"kind\":\"movie\",\"tmdbId\":1,\"title\":\"x\"}]}")]
    [InlineData("items", "{\"placeholders\":[{\"kind\":\"movie\",\"tmdbId\":1,\"title\":\"x\",\"edition\":\"8k\"}]}")]
    [InlineData("items", "{\"placeholders\":[{\"kind\":\"custom\",\"title\":\"x\",\"edition\":\"4k\"}]}")]
    [InlineData("apply", "{\"entries\":[{\"type\":\"item\",\"itemId\":\"nope\"}]}")]
    [InlineData("apply", "{\"entries\":[{\"type\":\"folder\"}]}")]
    [InlineData("apply", "{\"entries\":[]}")]
    [InlineData("order", "{\"order\":[]}")]
    [InlineData("order", "{\"rev\":0,\"order\":[\"x:1\"]}")]
    [InlineData("order", "{\"rev\":0,\"order\":[],\"moved\":\"p:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"}")]
    [InlineData("swap-in", "{\"enabled\":true}")]
    [InlineData("swap-in", "{\"rev\":0,\"requestId\":\"bad id!\",\"enabled\":true}")]
    public async Task MalformedInputIsRejectedBeforeAnythingChanges(string route, string body)
    {
        using var f = new Fixture();
        using var owner = f.Client(f.Owner);
        var path = $"{Base}/{N(f.Playlist.Info.Id)}/{route}";
        using var response = route is "order" or "swap-in" ? await owner.PutAsync(path, Json(body)) : await owner.PostAsync(path, Json(body));
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Null(f.H.Store.Load(N(f.Playlist.Info.Id)));
    }

    [Fact]
    public async Task PatchAndDeleteRequireARevAndAValidPlaceholderId()
    {
        using var f = new Fixture();
        using var owner = f.Client(f.Owner);
        var list = N(f.Playlist.Info.Id);
        Assert.Equal(HttpStatusCode.BadRequest, (await owner.PatchAsync($"{Base}/{list}/items/{new string('a', 32)}", Json("{\"note\":\"x\"}"))).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await owner.PatchAsync($"{Base}/{list}/items/{new string('a', 32)}", Json("{\"rev\":0}"))).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await owner.PatchAsync($"{Base}/{list}/items/{new string('a', 32)}", Json("{\"rev\":0,\"note\":\"" + new string('n', 301) + "\"}"))).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await owner.PatchAsync($"{Base}/{list}/items/{new string('a', 32)}", Json("{\"rev\":0,\"link\":{\"kind\":\"custom\",\"title\":\"x\"}}"))).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await owner.PatchAsync($"{Base}/{list}/items/NOTANID", Json("{\"rev\":0,\"note\":\"x\"}"))).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await owner.DeleteAsync($"{Base}/{list}/items/{new string('a', 32)}")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await owner.DeleteAsync($"{Base}/{list}/items/{new string('a', 32)}?rev=0")).StatusCode);
        // Collections have no order: a collection editor gets 400, a non-editor 403.
        Assert.Equal(HttpStatusCode.Forbidden, (await owner.PutAsync($"{Base}/{N(f.Collection.Info.Id)}/order", Json("{\"rev\":0,\"order\":[]}"))).StatusCode);
        using var manager = f.Client(f.H.NewUser("manager", collections: true));
        Assert.Equal(HttpStatusCode.BadRequest, (await manager.PutAsync($"{Base}/{N(f.Collection.Info.Id)}/order", Json("{\"rev\":0,\"order\":[]}"))).StatusCode);
    }

    [Fact]
    public async Task TheOwnerAddsReordersAndReadsBackCamelCaseShapes()
    {
        using var f = new Fixture();
        var a = f.H.Host.AddItem();
        f.Playlist.Raw.Add(new RawEntry(a, true));
        using var owner = f.Client(f.Owner);
        var list = N(f.Playlist.Info.Id);
        const string AddBody = "{\"requestId\":\"r-1\",\"position\":{\"atStart\":true},\"placeholders\":[{\"kind\":\"season\",\"tmdbId\":1399,\"title\":\"GoT\",\"seasonNumber\":1}]}";

        using var add = await owner.PostAsync($"{Base}/{list}/items", Json(AddBody));
        Assert.Equal(HttpStatusCode.OK, add.StatusCode);
        var added = await Body(add);
        var id = added.GetProperty("added")[0].GetString()!;
        var view = added.GetProperty("view");
        Assert.Equal(1, view.GetProperty("rev").GetInt32());
        Assert.Equal(new[] { "p:" + id, ListsHarness.E(a) }, view.GetProperty("order").EnumerateArray().Select(e => e.GetString()));
        var placeholder = view.GetProperty("placeholders")[0];
        Assert.Equal(("season", 1, true), (placeholder.GetProperty("kind").GetString(), placeholder.GetProperty("seasonNumber").GetInt32(), placeholder.GetProperty("addedByMe").GetBoolean()));
        Assert.Equal(("tv:tmdb:1399", "standard"), (placeholder.GetProperty("titleKey").GetString(), placeholder.GetProperty("edition").GetString()));
        Assert.Equal(new[] { "edit", "reorder", "swapIn" }, view.GetProperty("actions").EnumerateArray().Select(e => e.GetString()));

        // The same request id with the same body: replayed from the durable operation, applied once.
        using var replay = await owner.PostAsync($"{Base}/{list}/items", Json(AddBody));
        Assert.Equal(HttpStatusCode.OK, replay.StatusCode);
        var replayed = await Body(replay);
        Assert.Equal(id, replayed.GetProperty("added")[0].GetString());
        Assert.Equal(1, replayed.GetProperty("view").GetProperty("rev").GetInt32());
        Assert.Single(f.H.Store.Load(list)!.Items);

        // The same request id with a different body: refused, nothing applied.
        using var reused = await owner.PostAsync($"{Base}/{list}/items", Json(AddBody.Replace("1399", "1400", StringComparison.Ordinal)));
        Assert.Equal(HttpStatusCode.Conflict, reused.StatusCode);
        Assert.Equal("idempotency_conflict", (await Body(reused)).GetProperty("code").GetString());
        Assert.Single(f.H.Store.Load(list)!.Items);

        using var reorder = await owner.PutAsJsonAsync($"{Base}/{list}/order", new { rev = 1, order = new[] { ListsHarness.E(a), "p:" + id } });
        Assert.Equal(HttpStatusCode.OK, reorder.StatusCode);
        using var conflict = await owner.PutAsJsonAsync($"{Base}/{list}/order", new { rev = 1, order = new[] { "p:" + id, ListsHarness.E(a) } });
        Assert.Equal(HttpStatusCode.Conflict, conflict.StatusCode);
        var conflictBody = await Body(conflict);
        Assert.Equal("rev_conflict", conflictBody.GetProperty("code").GetString());
        Assert.Equal(2, conflictBody.GetProperty("view").GetProperty("rev").GetInt32());

        using var lists = await owner.GetAsync($"{Base}/editable");
        var editable = await Body(lists);
        Assert.Equal(2, editable.GetProperty("playlists").GetArrayLength());
        Assert.False(editable.GetProperty("canManageCollections").GetBoolean());

        using var created = await owner.PostAsync($"{Base}/playlists", Json("{\"name\":\"  DCEU  \",\"entries\":[{\"type\":\"placeholder\",\"placeholder\":{\"kind\":\"custom\",\"title\":\"Clayface\"}}]}"));
        Assert.Equal(HttpStatusCode.OK, created.StatusCode);
        var createdBody = await Body(created);
        Assert.Equal("DCEU", createdBody.GetProperty("name").GetString());
        Assert.Single(createdBody.GetProperty("result").GetProperty("added").EnumerateArray());
    }

    [Fact]
    public async Task AnEditorTurnsSwapInOnAndOffWhenTheAdminSwitchAllowsIt()
    {
        using var f = new Fixture();
        using var owner = f.Client(f.Owner);
        var list = N(f.Playlist.Info.Id);

        using (var on = await owner.PutAsync($"{Base}/{list}/swap-in", Json("{\"requestId\":\"s-1\",\"rev\":0,\"enabled\":true}")))
        {
            Assert.Equal(HttpStatusCode.OK, on.StatusCode);
            var view = await Body(on);
            Assert.True(view.GetProperty("swapIn").GetBoolean());
            Assert.Equal(1, view.GetProperty("rev").GetInt32());
        }

        Assert.Equal(f.Owner.Id.ToString("N"), f.H.Store.Load(list)!.SwapIn!.ByUserId);
        using (var stale = await owner.PutAsync($"{Base}/{list}/swap-in", Json("{\"rev\":0,\"enabled\":false}")))
        {
            Assert.Equal(HttpStatusCode.Conflict, stale.StatusCode);
        }

        using (var off = await owner.PutAsync($"{Base}/{list}/swap-in", Json("{\"rev\":1,\"enabled\":false}")))
        {
            Assert.Equal(HttpStatusCode.OK, off.StatusCode);
            Assert.False((await Body(off)).GetProperty("swapIn").GetBoolean());
        }

        Assert.Null(f.H.Store.Load(list)!.SwapIn);

        // The admin switch off: refused before anything else, and views don't offer it.
        f.H.Plugin.Plugin.Configuration.ArrPhase4ListSwapInEnabled = false;
        using (var refused = await owner.PutAsync($"{Base}/{list}/swap-in", Json("{\"rev\":2,\"enabled\":true}")))
        {
            Assert.Equal(HttpStatusCode.Forbidden, refused.StatusCode);
            Assert.Equal("swap_in_disabled", (await Body(refused)).GetProperty("code").GetString());
        }

        using var get = await owner.GetAsync($"{Base}/{list}");
        Assert.DoesNotContain("swapIn", (await Body(get)).GetProperty("actions").EnumerateArray().Select(a => a.GetString()));
        Assert.Null(f.H.Store.Load(list)!.SwapIn);
    }

    [Fact]
    public async Task ACorruptDocumentAnswers503AndIsLeftAlone()
    {
        using var f = new Fixture();
        var list = N(f.Playlist.Info.Id);
        var dir = Path.Combine(f.H.Plugin.Core.ConfigRoot, ListStore.DirectoryName);
        Directory.CreateDirectory(dir);
        File.WriteAllText(Path.Combine(dir, list + ".json"), "{broken");
        using var owner = f.Client(f.Owner);
        using var response = await owner.GetAsync($"{Base}/{list}");
        Assert.Equal(HttpStatusCode.ServiceUnavailable, response.StatusCode);
        Assert.Equal("store_unavailable", (await Body(response)).GetProperty("code").GetString());
        Assert.Equal("{broken", File.ReadAllText(Path.Combine(dir, list + ".json")));
    }

    [Fact]
    public async Task ASchemaOneDocumentInTheListsFolderIsRefusedAsCorruptAndLeftAlone()
    {
        // Schema 1 (#936) documents are only read by the experimental importer; in lists/ one is never read as a list.
        using var f = new Fixture();
        var list = N(f.Playlist.Info.Id);
        var dir = Path.Combine(f.H.Plugin.Core.ConfigRoot, ListStore.DirectoryName);
        Directory.CreateDirectory(dir);
        var schemaOne = "{\"schema\":1,\"listId\":\"" + list + "\",\"listKind\":\"playlist\",\"rev\":3,\"order\":[],\"items\":[],\"intents\":[]}";
        File.WriteAllText(Path.Combine(dir, list + ".json"), schemaOne);
        using var owner = f.Client(f.Owner);
        using var response = await owner.GetAsync($"{Base}/{list}");
        Assert.Equal(HttpStatusCode.ServiceUnavailable, response.StatusCode);
        using var add = await owner.PostAsync($"{Base}/{list}/items", Json("{\"placeholders\":[{\"kind\":\"movie\",\"tmdbId\":1,\"title\":\"x\"}]}"));
        Assert.Equal(HttpStatusCode.ServiceUnavailable, add.StatusCode);
        Assert.Equal(schemaOne, File.ReadAllText(Path.Combine(dir, list + ".json")));
        Assert.Empty(f.H.Host.Calls);
    }
}
