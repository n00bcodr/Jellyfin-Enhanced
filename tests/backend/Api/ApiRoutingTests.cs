using System.Net;
using System.Security.Claims;
using System.Text.Encodings.Web;
using Jellyfin.Plugin.JellyfinEnhanced.Controllers;
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

// Actual ASP.NET routing, authentication/authorization and MVC result execution;
// Jellyfin services unrelated to public asset endpoints are deliberately absent.
public class ApiRoutingTests
{
    private sealed class AssetActivator(CoreFixture fixture) : IControllerActivator
    {
        public object Create(ControllerContext context)
        {
            var controller = ApiAssetTests.Controller(fixture);
            controller.ControllerContext = context;
            return controller;
        }
        public void Release(ControllerContext context, object controller) { }
    }
    private sealed class AnonymousAuthentication(IOptionsMonitor<AuthenticationSchemeOptions> options, ILoggerFactory logger, UrlEncoder encoder)
        : AuthenticationHandler<AuthenticationSchemeOptions>(options, logger, encoder)
    {
        protected override Task<AuthenticateResult> HandleAuthenticateAsync() => Task.FromResult(AuthenticateResult.NoResult());
    }
    private static TestServer Server(CoreFixture fixture)
    {
        return new TestServer(new WebHostBuilder().ConfigureServices(services =>
        {
            services.AddLogging();
            services.AddRouting();
            services.AddAuthentication("test").AddScheme<AuthenticationSchemeOptions, AnonymousAuthentication>("test", _ => { });
            services.AddAuthorization();
            services.AddControllers().AddApplicationPart(typeof(JellyfinEnhancedController).Assembly);
            services.AddSingleton<IControllerActivator>(new AssetActivator(fixture));
        }).Configure(app =>
        {
            app.UseRouting();
            app.UseAuthentication();
            app.UseAuthorization();
            app.UseEndpoints(e => e.MapControllers());
        }));
    }

    [Theory]
    [InlineData("script", "application/javascript")]
    [InlineData("js/component-scripts.json", "application/json")]
    [InlineData("Configuration/configPage.css", "text/css")]
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
    [InlineData("private-config")]
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
