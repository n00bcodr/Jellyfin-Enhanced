using System.Net;
using System.Security.Claims;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json.Nodes;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Controllers;
using Jellyfin.Plugin.JellyfinEnhanced.Services.ListPlaceholders;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Controllers;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Moq;

namespace JE.Tests;

// The admin arr routes through real ASP.NET routing/auth: anonymous 401, either switch off 404, non-admin 403 (also
// with the role claim spoofed as a plain user), admin success, and that routes don't collide with /{listId}.
[Collection("Plugin singleton")]
public class ListPlaceholdersArrControllerTests
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

            var identity = new ClaimsIdentity(new[] { new Claim("Jellyfin-UserId", user), new Claim(ClaimTypes.Role, "User") }, Scheme.Name);
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
        public ApiPluginFixture Plugin { get; } = new();
        public FakeArr Arr { get; } = new();
        public Mock<IUserManager> Users { get; } = new();
        public User Admin { get; }
        public User Viewer { get; }
        public TestServer Server { get; }

        public Fixture()
        {
            var config = Plugin.Plugin.Configuration;
            config.ListPlaceholdersEnabled = true;
            config.ListPlaceholdersArrEnabled = true;
            config.RadarrInstances = $"[{{\"Name\":\"Movies\",\"Url\":\"{FakeArr.RadarrUrl}\",\"ApiKey\":\"{FakeArr.RadarrKey}\",\"Enabled\":true}}]";
            config.SonarrInstances = $"[{{\"Name\":\"TV\",\"Url\":\"{FakeArr.SonarrUrl}\",\"ApiKey\":\"{FakeArr.SonarrKey}\",\"Enabled\":true}}]";
            Arr.RadarrCatalog.Add(FakeArr.Movie(49521, "Man of Steel", 2013));
            Admin = FakeListHost.MakeUser("admin", admin: true, collections: false);
            Viewer = FakeListHost.MakeUser("viewer", admin: false, collections: true);
            Users.Setup(u => u.GetUserById(Admin.Id)).Returns(Admin);
            Users.Setup(u => u.GetUserById(Viewer.Id)).Returns(Viewer);
            var service = new ListPlaceholderArrService(Arr.Transport, new ListPlaceholderStore(Plugin.Core.Paths.Object, Plugin.Core.Logger), Plugin.Core.Logger);
            Server = new TestServer(new WebHostBuilder().ConfigureServices(services =>
            {
                services.AddLogging();
                services.AddRouting();
                services.AddAuthentication("test").AddScheme<AuthenticationSchemeOptions, HeaderAuthentication>("test", _ => { });
                services.AddAuthorization();
                services.AddControllers().AddApplicationPart(typeof(ListPlaceholdersArrController).Assembly);
                services.AddSingleton<IControllerActivator>(new Activator(type => type == typeof(ListPlaceholdersArrController)
                    ? new ListPlaceholdersArrController(Users.Object, service, Plugin.Core.Logger)
                    : throw new InvalidOperationException("Unexpected controller " + type)));
            }).Configure(app =>
            {
                app.UseRouting();
                app.UseAuthentication();
                app.UseAuthorization();
                app.UseEndpoints(e => e.MapControllers());
            }));
        }

        public HttpClient Client(User? user)
        {
            var client = Server.CreateClient();
            if (user != null)
            {
                client.DefaultRequestHeaders.Add("X-Test-User", user.Id.ToString());
            }

            return client;
        }

        public void Dispose()
        {
            Server.Dispose();
            Arr.Dispose();
            Plugin.Dispose();
        }
    }

    private const string AddBody = "{\"mediaType\":\"movie\",\"instance\":0,\"tmdbId\":49521,\"scope\":\"movie\",\"qualityProfileId\":4,\"rootFolderPath\":\"/movies\"}";

    private static readonly (string Method, string Path, string? Body)[] Routes =
    {
        ("GET", "/JellyfinEnhanced/list-placeholders/arr/options", null),
        ("GET", "/JellyfinEnhanced/list-placeholders/arr/lookup?type=movie&term=tmdb:49521", null),
        ("POST", "/JellyfinEnhanced/list-placeholders/arr/add", AddBody),
    };

    private static Task<HttpResponseMessage> Send(HttpClient client, (string Method, string Path, string? Body) route) =>
        client.SendAsync(new HttpRequestMessage(new HttpMethod(route.Method), route.Path)
        {
            Content = route.Body == null ? null : new StringContent(route.Body, Encoding.UTF8, "application/json"),
        });

    [Fact]
    public async Task AnonymousCallersGet401()
    {
        using var f = new Fixture();
        foreach (var route in Routes)
        {
            Assert.Equal(HttpStatusCode.Unauthorized, (await Send(f.Client(null), route)).StatusCode);
        }

        Assert.Empty(f.Arr.Calls);
    }

    [Theory]
    [InlineData(false, true)]
    [InlineData(true, false)]
    public async Task EitherSwitchOffMeans404ForEveryone(bool master, bool arr)
    {
        using var f = new Fixture();
        f.Plugin.Plugin.Configuration.ListPlaceholdersEnabled = master;
        f.Plugin.Plugin.Configuration.ListPlaceholdersArrEnabled = arr;
        foreach (var user in new[] { f.Admin, f.Viewer })
        {
            foreach (var route in Routes)
            {
                var response = await Send(f.Client(user), route);
                Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
                Assert.Equal("disabled", JsonNode.Parse(await response.Content.ReadAsStringAsync())!["message"]!.GetValue<string>());
            }
        }

        Assert.Empty(f.Arr.Calls);
    }

    [Fact]
    public async Task NonAdminsGet403AndNoArrCall()
    {
        using var f = new Fixture();
        foreach (var route in Routes)
        {
            var response = await Send(f.Client(f.Viewer), route);
            Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
            Assert.Equal("forbidden", JsonNode.Parse(await response.Content.ReadAsStringAsync())!["code"]!.GetValue<string>());
        }

        Assert.Empty(f.Arr.Calls);
    }

    [Fact]
    public async Task AdminsUseEveryRoute()
    {
        using var f = new Fixture();
        var client = f.Client(f.Admin);

        var options = JsonNode.Parse(await (await Send(client, Routes[0])).Content.ReadAsStringAsync())!;
        Assert.Equal("Movies", options["radarr"]![0]!["name"]!.GetValue<string>());
        Assert.Equal("TV", options["sonarr"]![0]!["name"]!.GetValue<string>());

        var lookup = await Send(client, Routes[1]);
        Assert.Equal(HttpStatusCode.OK, lookup.StatusCode);
        Assert.Equal(49521, JsonNode.Parse(await lookup.Content.ReadAsStringAsync())!["results"]![0]!["tmdbId"]!.GetValue<int>());

        var add = await Send(client, Routes[2]);
        Assert.Equal(HttpStatusCode.OK, add.StatusCode);
        var result = JsonNode.Parse(await add.Content.ReadAsStringAsync())!;
        Assert.Equal("added", result["result"]!.GetValue<string>());
        Assert.Equal("/movie/49521", result["arrPath"]!.GetValue<string>());
        Assert.Single(f.Arr.RadarrMovies);

        var bad = await Send(client, ("POST", "/JellyfinEnhanced/list-placeholders/arr/add", "{\"mediaType\":\"movie\"}"));
        Assert.Equal(HttpStatusCode.BadRequest, bad.StatusCode);
        Assert.Equal("invalid_body", JsonNode.Parse(await bad.Content.ReadAsStringAsync())!["code"]!.GetValue<string>());
    }

    [Fact]
    public async Task UpstreamAuthFailuresNeverBecomeA401ForTheBrowser()
    {
        using var f = new Fixture();
        f.Arr.Override = (_, _) => IntegrationTransport.Response(string.Empty, 401);
        var response = await Send(f.Client(f.Admin), Routes[2]);
        Assert.Equal(HttpStatusCode.BadGateway, response.StatusCode);
        Assert.Equal("arr_auth_failed", JsonNode.Parse(await response.Content.ReadAsStringAsync())!["code"]!.GetValue<string>());
    }

    [Fact]
    public async Task AnUnexpectedServiceErrorIsA500WithoutDetails()
    {
        using var f = new Fixture();
        f.Arr.Override = (_, _) => throw new ArgumentException("secret detail");
        var response = await Send(f.Client(f.Admin), Routes[0]);
        Assert.Equal(HttpStatusCode.InternalServerError, response.StatusCode);
        var body = await response.Content.ReadAsStringAsync();
        Assert.Contains("arr_failed", body, StringComparison.Ordinal);
        Assert.DoesNotContain("secret detail", body, StringComparison.Ordinal);
    }
}
