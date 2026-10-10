using System.Net;
using System.Net.Http.Json;
using System.Security.Claims;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Controllers;
using Jellyfin.Plugin.JellyfinEnhanced.Services.ListPlaceholders;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Controllers;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace JE.Tests;

// The HTTP surface through real ASP.NET routing/auth: anonymous 401, master switch 404, viewer 403 on edits,
// hidden lists 404, input validation 400, and the success shapes.
[Collection("Plugin singleton")]
public class ListPlaceholdersControllerTests
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
        public ListPlaceholdersHarness H { get; } = new();
        public User Owner { get; }
        public User Viewer { get; }
        public User Stranger { get; }
        public FakeListHost.FakeList Playlist { get; }
        public FakeListHost.FakeList Private { get; }
        public FakeListHost.FakeList Collection { get; }
        public TestServer Server { get; }

        public Fixture()
        {
            Owner = H.NewUser("owner");
            Viewer = H.NewUser("viewer");
            Stranger = H.NewUser("stranger");
            Playlist = H.Host.AddPlaylist(Owner, openAccess: true);
            Private = H.Host.AddPlaylist(Owner);
            Collection = H.Host.AddCollection();
            Server = new TestServer(new WebHostBuilder().ConfigureServices(services =>
            {
                services.AddLogging();
                services.AddRouting();
                services.AddAuthentication("test").AddScheme<AuthenticationSchemeOptions, HeaderAuthentication>("test", _ => { });
                services.AddAuthorization();
                services.AddControllers().AddApplicationPart(typeof(ListPlaceholdersController).Assembly);
                services.AddSingleton<IControllerActivator>(new Activator(type => type == typeof(ListPlaceholdersController)
                    ? new ListPlaceholdersController(H.Users.Object, H.Access, H.Service, H.Sources, H.Plugin.Core.Logger)
                    : throw new InvalidOperationException("Unexpected controller " + type)));
            }).Configure(app =>
            {
                app.UseRouting();
                app.UseAuthentication();
                app.UseAuthorization();
                app.UseEndpoints(e => e.MapControllers());
            }));
        }

        public HttpClient Client(User? user, bool admin = false)
        {
            var client = Server.CreateClient();
            if (user != null)
            {
                client.DefaultRequestHeaders.Add("X-Test-User", user.Id.ToString());
                client.DefaultRequestHeaders.Add("X-Test-Role", admin ? "Administrator" : "User");
            }

            return client;
        }

        public void Dispose()
        {
            Server.Dispose();
            H.Dispose();
        }
    }

    private static string N(Guid id) => id.ToString("N");

    private static StringContent Json(string json) => new(json, Encoding.UTF8, "application/json");

    private static (string Method, string Path, string? Body)[] Routes(Fixture f)
    {
        var list = N(f.Playlist.Info.Id);
        var ph = new string('a', 32);
        return new (string, string, string?)[]
        {
            ("GET", $"/JellyfinEnhanced/list-placeholders/{list}", null),
            ("POST", $"/JellyfinEnhanced/list-placeholders/{list}/items", "{\"placeholders\":[{\"kind\":\"movie\",\"tmdbId\":1,\"title\":\"x\"}]}"),
            ("POST", $"/JellyfinEnhanced/list-placeholders/{list}/apply", "{\"entries\":[{\"type\":\"placeholder\",\"placeholder\":{\"kind\":\"movie\",\"tmdbId\":1,\"title\":\"x\"}}]}"),
            ("PATCH", $"/JellyfinEnhanced/list-placeholders/{list}/items/{ph}", "{\"rev\":0,\"note\":\"x\"}"),
            ("DELETE", $"/JellyfinEnhanced/list-placeholders/{list}/items/{ph}?rev=0", null),
            ("PUT", $"/JellyfinEnhanced/list-placeholders/{list}/order", "{\"rev\":0,\"order\":[]}"),
            ("GET", "/JellyfinEnhanced/list-placeholders/editable-lists", null),
            ("POST", "/JellyfinEnhanced/list-placeholders/playlists", "{\"name\":\"x\"}"),
            ("POST", "/JellyfinEnhanced/list-placeholders/collections", "{\"name\":\"x\"}"),
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

    [Fact]
    public async Task EveryRouteIsNotFoundWhileTheFeatureIsOff()
    {
        using var f = new Fixture();
        f.H.Plugin.Plugin.Configuration.ListPlaceholdersEnabled = false;
        using var owner = f.Client(f.Owner, admin: true);
        foreach (var route in Routes(f))
        {
            using var response = await Send(owner, route);
            Assert.True(HttpStatusCode.NotFound == response.StatusCode, $"{route.Method} {route.Path} -> {response.StatusCode}");
            Assert.Equal("disabled", JsonDocument.Parse(await response.Content.ReadAsStringAsync()).RootElement.GetProperty("message").GetString());
        }

        Assert.Empty(f.H.Host.Calls);
        Assert.Empty(f.H.Store.EnumerateListIds());
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
            var view = JsonDocument.Parse(await get.Content.ReadAsStringAsync()).RootElement;
            Assert.False(view.GetProperty("canEdit").GetBoolean());
            Assert.Equal(N(f.Playlist.Info.Id), view.GetProperty("listId").GetString());
            Assert.Equal("playlist", view.GetProperty("listKind").GetString());
        }

        foreach (var route in routes.Skip(1).Take(5))
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
        using (var hidden = await stranger.GetAsync($"/JellyfinEnhanced/list-placeholders/{N(f.Private.Info.Id)}"))
        {
            Assert.Equal(HttpStatusCode.NotFound, hidden.StatusCode);
        }

        using (var hiddenEdit = await stranger.PostAsync($"/JellyfinEnhanced/list-placeholders/{N(f.Private.Info.Id)}/items", Json("{\"placeholders\":[{\"kind\":\"movie\",\"tmdbId\":1,\"title\":\"x\"}]}")))
        {
            Assert.Equal(HttpStatusCode.NotFound, hiddenEdit.StatusCode);
        }

        using (var unknown = await stranger.GetAsync($"/JellyfinEnhanced/list-placeholders/{N(Guid.NewGuid())}"))
        {
            Assert.Equal(HttpStatusCode.NotFound, unknown.StatusCode);
        }

        using (var bad = await stranger.GetAsync("/JellyfinEnhanced/list-placeholders/not-a-guid"))
        {
            Assert.Equal(HttpStatusCode.BadRequest, bad.StatusCode);
        }

        // An authenticated principal without a Jellyfin user is refused.
        using var ghost = f.Server.CreateClient();
        ghost.DefaultRequestHeaders.Add("X-Test-User", Guid.NewGuid().ToString());
        using var ghostResponse = await ghost.GetAsync("/JellyfinEnhanced/list-placeholders/editable-lists");
        Assert.Equal(HttpStatusCode.Forbidden, ghostResponse.StatusCode);
    }

    [Theory]
    [InlineData("items", "{\"placeholders\":[]}")]
    [InlineData("items", "{\"placeholders\":[{\"kind\":\"episodes\",\"tmdbId\":1,\"title\":\"x\",\"seasonNumber\":1,\"episodes\":[{\"s\":2,\"e\":1}]}]}")]
    [InlineData("items", "{\"requestId\":\"bad id!\",\"placeholders\":[{\"kind\":\"movie\",\"tmdbId\":1,\"title\":\"x\"}]}")]
    [InlineData("items", "{\"position\":{\"atStart\":true,\"afterToken\":\"p:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"},\"placeholders\":[{\"kind\":\"movie\",\"tmdbId\":1,\"title\":\"x\"}]}")]
    [InlineData("items", "{\"position\":{\"afterToken\":\"<script>\"},\"placeholders\":[{\"kind\":\"movie\",\"tmdbId\":1,\"title\":\"x\"}]}")]
    [InlineData("apply", "{\"entries\":[{\"type\":\"item\",\"itemId\":\"nope\"}]}")]
    [InlineData("apply", "{\"entries\":[{\"type\":\"folder\"}]}")]
    [InlineData("apply", "{\"entries\":[]}")]
    [InlineData("order", "{\"order\":[]}")]
    [InlineData("order", "{\"rev\":0,\"order\":[\"x:1\"]}")]
    [InlineData("order", "{\"rev\":0,\"order\":[],\"moved\":\"p:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"}")]
    public async Task MalformedInputIsRejectedBeforeAnythingChanges(string route, string body)
    {
        using var f = new Fixture();
        using var owner = f.Client(f.Owner);
        var path = $"/JellyfinEnhanced/list-placeholders/{N(f.Playlist.Info.Id)}/{route}";
        using var response = route == "order" ? await owner.PutAsync(path, Json(body)) : await owner.PostAsync(path, Json(body));
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Null(f.H.Store.Load(N(f.Playlist.Info.Id)));
    }

    [Fact]
    public async Task PatchAndDeleteRequireARevAndAValidPlaceholderId()
    {
        using var f = new Fixture();
        using var owner = f.Client(f.Owner);
        var list = N(f.Playlist.Info.Id);
        Assert.Equal(HttpStatusCode.BadRequest, (await owner.PatchAsync($"/JellyfinEnhanced/list-placeholders/{list}/items/{new string('a', 32)}", Json("{\"note\":\"x\"}"))).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await owner.PatchAsync($"/JellyfinEnhanced/list-placeholders/{list}/items/{new string('a', 32)}", Json("{\"rev\":0}"))).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await owner.PatchAsync($"/JellyfinEnhanced/list-placeholders/{list}/items/{new string('a', 32)}", Json("{\"rev\":0,\"note\":\"" + new string('n', 301) + "\"}"))).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await owner.PatchAsync($"/JellyfinEnhanced/list-placeholders/{list}/items/{new string('a', 32)}", Json("{\"rev\":0,\"link\":{\"kind\":\"custom\",\"title\":\"x\"}}"))).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await owner.PatchAsync($"/JellyfinEnhanced/list-placeholders/{list}/items/NOTANID", Json("{\"rev\":0,\"note\":\"x\"}"))).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await owner.DeleteAsync($"/JellyfinEnhanced/list-placeholders/{list}/items/{new string('a', 32)}")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await owner.DeleteAsync($"/JellyfinEnhanced/list-placeholders/{list}/items/{new string('a', 32)}?rev=0")).StatusCode);
        // Collections have no order: a collection editor gets 400, a non-editor 403.
        Assert.Equal(HttpStatusCode.Forbidden, (await owner.PutAsync($"/JellyfinEnhanced/list-placeholders/{N(f.Collection.Info.Id)}/order", Json("{\"rev\":0,\"order\":[]}"))).StatusCode);
        using var manager = f.Client(f.H.NewUser("manager", collections: true));
        Assert.Equal(HttpStatusCode.BadRequest, (await manager.PutAsync($"/JellyfinEnhanced/list-placeholders/{N(f.Collection.Info.Id)}/order", Json("{\"rev\":0,\"order\":[]}"))).StatusCode);
    }

    [Fact]
    public async Task TheOwnerAddsReordersAndReadsBackCamelCaseShapes()
    {
        using var f = new Fixture();
        var a = f.H.Host.AddItem();
        f.Playlist.Raw.Add(new RawEntry(a, true));
        using var owner = f.Client(f.Owner);
        var list = N(f.Playlist.Info.Id);

        using var add = await owner.PostAsync($"/JellyfinEnhanced/list-placeholders/{list}/items",
            Json("{\"requestId\":\"r-1\",\"position\":{\"atStart\":true},\"placeholders\":[{\"kind\":\"season\",\"tmdbId\":1399,\"title\":\"GoT\",\"seasonNumber\":1}]}"));
        Assert.Equal(HttpStatusCode.OK, add.StatusCode);
        var added = JsonDocument.Parse(await add.Content.ReadAsStringAsync()).RootElement;
        var id = added.GetProperty("added")[0].GetString()!;
        var view = added.GetProperty("view");
        Assert.Equal(1, view.GetProperty("rev").GetInt32());
        Assert.Equal(new[] { "p:" + id, ListPlaceholdersHarness.E(a) }, view.GetProperty("order").EnumerateArray().Select(e => e.GetString()));
        var placeholder = view.GetProperty("placeholders")[0];
        Assert.Equal(("season", 1, true), (placeholder.GetProperty("kind").GetString(), placeholder.GetProperty("seasonNumber").GetInt32(), placeholder.GetProperty("addedByMe").GetBoolean()));

        using var replay = await owner.PostAsync($"/JellyfinEnhanced/list-placeholders/{list}/items",
            Json("{\"requestId\":\"r-1\",\"position\":{\"atStart\":true},\"placeholders\":[{\"kind\":\"season\",\"tmdbId\":1399,\"title\":\"GoT\",\"seasonNumber\":1}]}"));
        Assert.Equal(HttpStatusCode.OK, replay.StatusCode);
        Assert.Equal(id, JsonDocument.Parse(await replay.Content.ReadAsStringAsync()).RootElement.GetProperty("added")[0].GetString());

        using var reorder = await owner.PutAsJsonAsync($"/JellyfinEnhanced/list-placeholders/{list}/order", new { rev = 1, order = new[] { ListPlaceholdersHarness.E(a), "p:" + id } });
        Assert.Equal(HttpStatusCode.OK, reorder.StatusCode);
        using var conflict = await owner.PutAsJsonAsync($"/JellyfinEnhanced/list-placeholders/{list}/order", new { rev = 1, order = new[] { "p:" + id, ListPlaceholdersHarness.E(a) } });
        Assert.Equal(HttpStatusCode.Conflict, conflict.StatusCode);
        var conflictBody = JsonDocument.Parse(await conflict.Content.ReadAsStringAsync()).RootElement;
        Assert.Equal("rev_conflict", conflictBody.GetProperty("code").GetString());
        Assert.Equal(2, conflictBody.GetProperty("view").GetProperty("rev").GetInt32());

        using var lists = await owner.GetAsync("/JellyfinEnhanced/list-placeholders/editable-lists");
        var editable = JsonDocument.Parse(await lists.Content.ReadAsStringAsync()).RootElement;
        Assert.Equal(2, editable.GetProperty("playlists").GetArrayLength());
        Assert.False(editable.GetProperty("canManageCollections").GetBoolean());

        using var created = await owner.PostAsync("/JellyfinEnhanced/list-placeholders/playlists", Json("{\"name\":\"  DCEU  \",\"entries\":[{\"type\":\"placeholder\",\"placeholder\":{\"kind\":\"custom\",\"title\":\"Clayface\"}}]}"));
        Assert.Equal(HttpStatusCode.OK, created.StatusCode);
        var createdBody = JsonDocument.Parse(await created.Content.ReadAsStringAsync()).RootElement;
        Assert.Equal("DCEU", createdBody.GetProperty("name").GetString());
        Assert.Single(createdBody.GetProperty("result").GetProperty("added").EnumerateArray());
    }

    [Fact]
    public async Task ACorruptDocumentAnswers503AndIsLeftAlone()
    {
        using var f = new Fixture();
        var list = N(f.Playlist.Info.Id);
        var dir = Path.Combine(f.H.Plugin.Core.ConfigRoot, "list-placeholders");
        Directory.CreateDirectory(dir);
        File.WriteAllText(Path.Combine(dir, list + ".json"), "{broken");
        using var owner = f.Client(f.Owner);
        using var response = await owner.GetAsync($"/JellyfinEnhanced/list-placeholders/{list}");
        Assert.Equal(HttpStatusCode.ServiceUnavailable, response.StatusCode);
        Assert.Equal("{broken", File.ReadAllText(Path.Combine(dir, list + ".json")));
    }
}
