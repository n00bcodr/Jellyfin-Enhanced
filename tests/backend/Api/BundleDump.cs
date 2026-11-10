using System.Net;
using System.Text.Encodings.Web;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Controllers;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Plugin = Jellyfin.Plugin.JellyfinEnhanced.JellyfinEnhanced;

namespace JE.Tests;

// The in-process plugin API used by BundleDump and BundleServingTests: built like ApiRoutingTests.Server, but activates
// whichever controller type owns the route (only the logger is supplied), so it keeps working when the action moves.
internal static class BundleServer
{
    private sealed class AnyControllerActivator(ApiPluginFixture fixture) : IControllerActivator
    {
        public object Create(ControllerContext context)
        {
            var constructor = context.ActionDescriptor.ControllerTypeInfo.GetConstructors().OrderByDescending(c => c.GetParameters().Length).First();
            var controller = (ControllerBase)constructor.Invoke(constructor.GetParameters()
                .Select(p => p.ParameterType == typeof(Jellyfin.Plugin.JellyfinEnhanced.Logger) ? fixture.Core.Logger : null).ToArray());
            controller.ControllerContext = context;
            return controller;
        }
        public void Release(ControllerContext context, object controller) { }
    }

    private sealed class NoAuthentication(IOptionsMonitor<AuthenticationSchemeOptions> options, ILoggerFactory logger, UrlEncoder encoder)
        : AuthenticationHandler<AuthenticationSchemeOptions>(options, logger, encoder)
    {
        protected override Task<AuthenticateResult> HandleAuthenticateAsync() => Task.FromResult(AuthenticateResult.NoResult());
    }

    public static TestServer Create(ApiPluginFixture fixture) => new(new WebHostBuilder().ConfigureServices(services =>
    {
        services.AddLogging();
        services.AddRouting();
        services.AddAuthentication("test").AddScheme<AuthenticationSchemeOptions, NoAuthentication>("test", _ => { });
        services.AddAuthorization();
        services.AddControllers().AddApplicationPart(typeof(Plugin).Assembly);
        services.AddSingleton<IControllerActivator>(new AnyControllerActivator(fixture));
    }).Configure(app =>
    {
        app.UseRouting();
        app.UseAuthentication();
        app.UseAuthorization();
        app.UseEndpoints(e => e.MapControllers());
    }));
}

// Opt-in harness for `scripts/restructure-gates.sh bundle <out.js>` and `size` (restructure plan, HOST bundle check;
// canopy K1 size gate): writes the raw bytes of the in-process GET /JellyfinEnhanced/bundle.js to $JE_BUNDLE_OUT.
// Without that variable it does nothing, so the normal suite is unaffected.
[Collection("Plugin singleton")]
public class BundleDump
{
    [Fact]
    public async Task WritesServedBundleWhenRequested()
    {
        var output = Environment.GetEnvironmentVariable("JE_BUNDLE_OUT");
        if (string.IsNullOrEmpty(output)) return;
        using var fixture = new ApiPluginFixture();
        using var server = BundleServer.Create(fixture);
        using var client = server.CreateClient();
        // No Accept-Encoding: the identity bytes (canopy K1 serves br/gzip only when asked).
        using var response = await client.GetAsync("/JellyfinEnhanced/bundle.js");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("application/javascript", response.Content.Headers.ContentType!.MediaType);
        Assert.Empty(response.Content.Headers.ContentEncoding);
        var body = await response.Content.ReadAsByteArrayAsync();
        Assert.NotEmpty(body);
        await File.WriteAllBytesAsync(output, body);
    }
}
