#pragma warning disable ASPDEPR004, ASPDEPR008
using System.Reflection;
using Jellyfin.Plugin.JellyfinEnhanced;
using Jellyfin.Plugin.JellyfinEnhanced.Controllers;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Services.NativeDetails;
using MediaBrowser.Controller;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Controllers;
using Microsoft.AspNetCore.Mvc.Filters;
using Microsoft.AspNetCore.Mvc.Infrastructure;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Options;
using Moq;
using Xunit.Abstractions;

namespace JE.Tests;

public class IntegrationHttpPublicationArchitectureTests(ITestOutputHelper output)
{
    // No plugin actions are excluded: assets, configuration and acknowledgements enter conservatively too.
    // Native actions are the facade's shared allowlist (not a second method/route list owned by this test).
    private static readonly IReadOnlyDictionary<string, string> NonTitleExclusions = new Dictionary<string, string>();

    private static void Audit(IEnumerable<ControllerActionDescriptor> actions, MvcOptions options)
    {
        var owners = options.Filters.OfType<PrivacyCommitFilter>().ToArray();
        Assert.Single(owners);
        Assert.IsAssignableFrom<IAlwaysRunResultFilter>(owners[0]);
        Assert.True(owners[0].Order < Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists.LegacyCollageBody.Order, "HTTP owner must enclose downstream body projections");
        foreach (var action in actions)
        {
            var route = action.AttributeRouteInfo?.Template ?? action.ControllerName + "." + action.ActionName;
            Assert.True(PrivacyResponseGuard.Owns(action) || NonTitleExclusions.ContainsKey(route), "Unowned title route: " + route);
        }
    }

    private static TestServer Host(bool planted = false) => new(new WebHostBuilder().ConfigureServices(services =>
    {
        var mvc = services.AddControllers().AddApplicationPart(typeof(JellyfinEnhancedController).Assembly);
        if (planted) mvc.AddApplicationPart(typeof(R4UnownedTitleController).Assembly);
        // Use production registration, so removing or changing the global owner breaks this test.
        new PluginServiceRegistrator().RegisterServices(services, Mock.Of<IServerApplicationHost>());
        // This is an action-descriptor host, not a running Jellyfin installation.
        services.RemoveAll<IStartupFilter>();
        services.RemoveAll<Microsoft.Extensions.Hosting.IHostedService>();
    }).Configure(_ => { }));

    [Fact]
    public async Task EveryPluginActionAndNativeFacadeRouteHasTheHttpCommitOwner()
    {
        using var host = Host();
        var plugin = host.Services.GetRequiredService<IActionDescriptorCollectionProvider>().ActionDescriptors.Items
            .OfType<ControllerActionDescriptor>().Where(a => a.ControllerTypeInfo.Assembly == typeof(JellyfinEnhancedController).Assembly).ToArray();
        Assert.NotEmpty(plugin);
        var native = NativeDetailsAllowlist.Routes.Where(r => r.Answer != FacadeAnswer.PassThrough).Select(r => new ControllerActionDescriptor
        {
            ControllerName = r.Controller, ActionName = r.Action, ControllerTypeInfo = typeof(IntegrationHttpPublicationArchitectureTests).GetTypeInfo(),
        }).ToArray();
        var options = host.Services.GetRequiredService<IOptions<MvcOptions>>().Value;
        Audit(plugin.Concat(native), options);
        using var admissionServices = new ServiceCollection().BuildServiceProvider();
        foreach (var descriptor in plugin.Concat(native))
        {
            var http = new Microsoft.AspNetCore.Http.DefaultHttpContext { RequestServices = admissionServices };
            // POST deliberately: no read-verb escape, even for actions normally reached with GET.
            http.Request.Method = "POST";
            var action = new ActionContext(http, new Microsoft.AspNetCore.Routing.RouteData(), descriptor);
            var resource = new ResourceExecutingContext(action, new List<IFilterMetadata>(), new List<Microsoft.AspNetCore.Mvc.ModelBinding.IValueProviderFactory>());
            await options.Filters.OfType<PrivacyCommitFilter>().Single().OnResourceExecutionAsync(resource, () =>
            {
                Assert.NotNull(PrivacyResponseGuard.Find(http));
                return Task.FromResult(new ResourceExecutedContext(action, new List<IFilterMetadata>()));
            });
        }
        Assert.Contains(plugin, a => a.ControllerName == "AcquireDiscover");
        Assert.Contains(plugin, a => a.ControllerName == "AcquireListImport" && a.ActionName == "Resolve");
        Assert.Contains(plugin, a => a.ControllerName == "AcquireListImport" && a.ActionName == "FetchSource");
        Assert.Contains(native, a => a.ControllerName == "Image" && a.ActionName == "GetItemImage");
        Assert.Contains(native, a => a.ControllerName == "UserLibrary" && a.ActionName == "GetItem");
        Assert.Contains(native, a => a.ControllerName == "TvShows" && a.ActionName == "GetEpisodes");
        output.WriteLine($"Plugin MVC actions: {plugin.Length}; native facade actions: {native.Length}; exclusions: {NonTitleExclusions.Count}");
    }

    [Fact]
    public void PlantedUnownedTitleRouteFailsTheSameArchitectureAssertion()
    {
        using var host = Host(planted: true);
        var planted = host.Services.GetRequiredService<IActionDescriptorCollectionProvider>().ActionDescriptors.Items
            .OfType<ControllerActionDescriptor>().Single(a => a.ControllerTypeInfo == typeof(R4UnownedTitleController));
        var error = Assert.Throws<Xunit.Sdk.TrueException>(() => Audit(new[] { planted }, host.Services.GetRequiredService<IOptions<MvcOptions>>().Value));
        Assert.Contains("Unowned title route: r4-planted/title", error.Message);
    }
}
#pragma warning restore ASPDEPR004, ASPDEPR008


[ApiController]
[Route("r4-planted/title")]
public sealed class R4UnownedTitleController : ControllerBase
{
    [HttpGet]
    public IActionResult Read() => new ObjectResult(new { title = "planted title" });
}
