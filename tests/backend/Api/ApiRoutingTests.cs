using System.Net;
using System.Text.Json;
using System.Security.Claims;
using System.Text.Encodings.Web;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using JE.Tests.Architecture;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Controllers;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace JE.Tests;

// Actual ASP.NET routing, authentication/authorization and MVC result execution;
// Jellyfin services unrelated to public asset endpoints are deliberately absent.
public class ApiRoutingTests
{
    // Builds whichever plugin controller the matched action belongs to (ControllerTypeInfo), so routing keeps
    // working when actions move out of JellyfinEnhancedController. Counts activations for the private-route gate.
    internal sealed class AssetActivator(CoreFixture fixture) : IControllerActivator
    {
        private int activations;
        public int Activations => Volatile.Read(ref activations);
        public object Create(ControllerContext context)
        {
            Interlocked.Increment(ref activations);
            var controller = ApiAssetTests.Controller(context.ActionDescriptor.ControllerTypeInfo.AsType(), fixture);
            controller.ControllerContext = context;
            return controller;
        }
        public void Release(ControllerContext context, object controller) { }
    }
    private sealed class AnonymousAuthentication(IOptionsMonitor<AuthenticationSchemeOptions> options, ILoggerFactory logger, UrlEncoder encoder)
        : AuthenticationHandler<AuthenticationSchemeOptions>(options, logger, encoder)
    {
        protected override Task<AuthenticateResult> HandleAuthenticateAsync()
        {
            var role = Request.Headers["X-Test-Role"].ToString();
            if (role is not ("Administrator" or "User")) return Task.FromResult(AuthenticateResult.NoResult());
            var principal = new ClaimsPrincipal(new ClaimsIdentity([new Claim(ClaimTypes.Role, role)], Scheme.Name));
            return Task.FromResult(AuthenticateResult.Success(new AuthenticationTicket(principal, Scheme.Name)));
        }
    }
    internal const string MatchedActionHeader = "X-Test-Matched-Action";
    internal const string ActionExceptionHeader = "X-Test-Action-Exception";
    internal static TestServer Server(CoreFixture fixture) => Server(fixture, new AssetActivator(fixture), observe: false);
    // observe: report the routed action's method name in a response header, and turn an exception thrown by the
    // action (host services are absent) into a 500 with its type in a header, so a request reached the action
    // without the exception escaping the TestServer.
    private static TestServer Server(CoreFixture fixture, AssetActivator activator, bool observe)
    {
        return new TestServer(new WebHostBuilder().ConfigureServices(services =>
        {
            services.AddLogging();
            services.AddRouting();
            services.AddAuthentication("test").AddScheme<AuthenticationSchemeOptions, AnonymousAuthentication>("test", _ => { });
            services.AddAuthorization();
            services.AddControllers().AddApplicationPart(typeof(Jellyfin.Plugin.JellyfinEnhanced.JellyfinEnhanced).Assembly);
            services.AddSingleton<IControllerActivator>(activator);
        }).Configure(app =>
        {
            app.UseRouting();
            if (observe)
            {
                app.Use(async (context, next) =>
                {
                    var action = context.GetEndpoint()?.Metadata.GetMetadata<ControllerActionDescriptor>();
                    if (action != null) context.Response.Headers[MatchedActionHeader] = action.MethodInfo.Name;
                    try { await next(); }
                    catch (Exception e) when (!context.Response.HasStarted)
                    {
                        context.Response.StatusCode = StatusCodes.Status500InternalServerError;
                        context.Response.Headers[ActionExceptionHeader] = e.GetType().Name;
                    }
                });
            }
            app.UseAuthentication();
            app.UseAuthorization();
            app.UseEndpoints(e => e.MapControllers());
        }));
    }

    // Every route in tests/backend/Architecture/route-auth.snapshot.json, with its sample request path.
    public static TheoryData<string, string, string> SnapshotRoutes(bool requiresAuth)
    {
        var data = new TheoryData<string, string, string>();
        foreach (var route in RouteAuthSnapshotTests.LoadSnapshot().Where(r => r.RequiresAuth == requiresAuth))
            data.Add(route.Verb, RouteAuthSnapshotTests.SamplePath(route.Route), route.Action);
        return data;
    }
    public static TheoryData<string, string, string> AnonymousSnapshotRoutes() => SnapshotRoutes(false);
    public static TheoryData<string, string, string> PrivateSnapshotRoutes() => SnapshotRoutes(true);

    private static async Task<HttpResponseMessage> SendAnonymous(TestServer server, string verb, string path)
    {
        using var client = server.CreateClient();
        using var request = new HttpRequestMessage(new HttpMethod(verb), "/" + path);
        if (verb is "POST" or "PUT" or "PATCH") request.Content = new StringContent("{}", System.Text.Encoding.UTF8, "application/json");
        return await client.SendAsync(request);
    }

    // Gate C (backend.md §3): every anonymous snapshot route routes to its own action and runs it without
    // authentication. Dynamic routes are checked for "not 401", not for a mime type; the sample values are not real.
    [Theory]
    [MemberData(nameof(AnonymousSnapshotRoutes))]
    public async Task EveryAnonymousSnapshotRouteExecutesWithoutAuthentication(string verb, string path, string action)
    {
        using var fixture = new CoreFixture();
        var activator = new AssetActivator(fixture);
        using var server = Server(fixture, activator, observe: true);
        using var response = await SendAnonymous(server, verb, path);
        Assert.Equal(action, response.Headers.TryGetValues(MatchedActionHeader, out var matched) ? matched.Single() : null);
        Assert.NotEqual(HttpStatusCode.Unauthorized, response.StatusCode);
        Assert.NotEqual(HttpStatusCode.Forbidden, response.StatusCode);
        Assert.True(activator.Activations > 0, $"{verb} {path} did not reach the controller ({(int)response.StatusCode}).");
    }

    // Gate C: every [Authorize] snapshot route routes to its own action (no shadowing by the catch-all {viewName}
    // or another template) and challenges an anonymous request before any controller is constructed.
    [Theory]
    [MemberData(nameof(PrivateSnapshotRoutes))]
    public async Task EveryPrivateSnapshotRouteChallengesBeforeControllerActivation(string verb, string path, string action)
    {
        using var fixture = new CoreFixture();
        var activator = new AssetActivator(fixture);
        using var server = Server(fixture, activator, observe: true);
        using var response = await SendAnonymous(server, verb, path);
        Assert.Equal(action, response.Headers.TryGetValues(MatchedActionHeader, out var matched) ? matched.Single() : null);
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
        Assert.Equal(0, activator.Activations);
    }

    [Theory]
    [InlineData("script", "application/javascript")]
    [InlineData("js/component-scripts.json", "application/json")]
    [InlineData("Configuration/jeAdmin.css", "text/css")]
    [InlineData("Configuration/jeAdmin.js", "application/javascript")]
    [InlineData("locales/de-DE.json", "application/json")]
    [InlineData("fonts/materialsymbolsrounded-subset.woff2", "font/woff2")]
    public async Task PublicAssetsRouteAndExecuteWithoutAuthentication(string route, string mime)
    {
        using var fixture = new CoreFixture();
        using var server = Server(fixture);
        using var client = server.CreateClient();
        using var response = await client.GetAsync("/JellyfinEnhanced/" + route);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal(mime, response.Content.Headers.ContentType!.MediaType);
        Assert.NotEmpty(await response.Content.ReadAsByteArrayAsync());
    }

    [Theory]
    [InlineData("Administrator")]
    [InlineData("User")]
    public async Task AuthenticatedTagStyleCatalogReturnsUniqueLabelsAndEveryPalette(string role)
    {
        using var fixture = new CoreFixture();
        using var server = Server(fixture);
        using var client = server.CreateClient();
        client.DefaultRequestHeaders.Add("X-Test-Role", role);
        using var response = await client.GetAsync("/JellyfinEnhanced/tag-styles/catalog");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        using var body = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        var quality = body.RootElement.GetProperty("quality").EnumerateArray().Select(value => value.GetProperty("label").GetString()).ToArray();
        Assert.Equal(quality.Length, quality.Distinct(StringComparer.Ordinal).Count());
        Assert.Single(quality, label => label == "Mixed");
        foreach (var palette in body.RootElement.GetProperty("palettes").EnumerateObject())
            Assert.True(palette.Value.TryGetProperty("quality:Mixed", out _));
    }

    [Theory]
    [InlineData("private-config")]
    [InlineData("tag-styles/catalog")]
    [InlineData("host-compat")]
    [InlineData("jellyfin-urls")]
    [InlineData("jellyseerr/status")]
    [InlineData("jellyseerr/permission-audit")]
    [InlineData("jellyseerr/quota")]
    [InlineData("tmdb/movie/1")]
    public async Task PrivateRoutesChallengeBeforeControllerUsesHostServices(string route)
    {
        using var fixture = new CoreFixture();
        using var server = Server(fixture);
        using var client = server.CreateClient();
        using var response = await client.GetAsync("/JellyfinEnhanced/" + route);
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Theory]
    [InlineData("unknown-route/unknown-child")]
    [InlineData("js/missing.js")]
    [InlineData("fonts/missing.woff2")]
    [InlineData("locales/zz-ZZ.json")]
    public async Task UnknownRoutesAndAssetsReturn404(string route)
    {
        using var fixture = new CoreFixture();
        using var server = Server(fixture);
        using var client = server.CreateClient();
        using var response = await client.GetAsync("/JellyfinEnhanced/" + route);
        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    [Fact]
    public async Task AssetPostReturnsMethodNotAllowed()
    {
        using var fixture = new CoreFixture();
        using var server = Server(fixture);
        using var client = server.CreateClient();
        using var response = await client.PostAsync("/JellyfinEnhanced/script", null);
        Assert.Equal(HttpStatusCode.MethodNotAllowed, response.StatusCode);
    }
}
