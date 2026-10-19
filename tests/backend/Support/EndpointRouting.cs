#pragma warning disable ASPDEPR004, ASPDEPR008 // The shared routing fixture exercises the legacy host API on both targets.
using Jellyfin.Plugin.JellyfinEnhanced.Controllers;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Abstractions;
using Microsoft.AspNetCore.Mvc.Controllers;
using Microsoft.AspNetCore.Routing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;

namespace JE.Tests;

/// <summary>
/// ASP.NET's own endpoint matching over JE's real controllers: a request path resolves to the action descriptor and
/// route values the host would bind, so filters are exercised with genuine endpoint metadata. Nothing is executed.
/// </summary>
internal static class EndpointRouting
{
    private static readonly Lazy<TestServer> Server = new(() => new TestServer(new WebHostBuilder().ConfigureServices(services =>
    {
        services.AddRouting();
        services.AddControllers().AddApplicationPart(typeof(JellyfinEnhancedController).Assembly);
    }).Configure(app =>
    {
        app.UseRouting();
        // Matching only: the endpoint is never executed, so no controller or Jellyfin service is constructed.
        app.Use((HttpContext _, RequestDelegate _) => Task.CompletedTask);
        app.UseEndpoints(endpoints => endpoints.MapControllers());
    })));

    /// <summary>Every controller action endpoint JE registers, as the host's routing sees them.</summary>
    public static IEnumerable<ControllerActionDescriptor> Actions()
        => Server.Value.Services.GetRequiredService<EndpointDataSource>().Endpoints
            .Select(e => e.Metadata.GetMetadata<ControllerActionDescriptor>()).OfType<ControllerActionDescriptor>();

    /// <summary>The matched endpoint for <paramref name="pathAndQuery"/>; an unmatched path keeps an empty descriptor.</summary>
    public static ActionContext Resolve(string pathAndQuery, Guid user, string method = "GET")
    {
        var at = pathAndQuery.IndexOf('?');
        var path = at < 0 ? pathAndQuery : pathAndQuery[..at];
        var query = at < 0 ? string.Empty : pathAndQuery[at..];
        var matched = Server.Value.SendAsync(c => { c.Request.Method = method; c.Request.Path = path; c.Request.QueryString = new QueryString(query); })
            .GetAwaiter().GetResult();
        var http = new DefaultHttpContext();
        http.Request.Method = method;
        http.Request.Path = path;
        http.Request.QueryString = new QueryString(query);
        http.User = TestCallers.Principal(user, false);
        var values = new RouteValueDictionary(matched.Request.RouteValues);
        http.Request.RouteValues = values;
        var descriptor = matched.GetEndpoint()?.Metadata.GetMetadata<ControllerActionDescriptor>();
        return new ActionContext(http, new RouteData(values), (ActionDescriptor?)descriptor ?? new ActionDescriptor());
    }

    /// <summary>Binds an existing request (its request caches and headers kept) to the endpoint its path matches.</summary>
    public static ActionContext Bind(HttpContext http)
    {
        var resolved = Resolve(http.Request.Path + http.Request.QueryString, Guid.Empty, http.Request.Method);
        http.Request.RouteValues = resolved.HttpContext.Request.RouteValues;
        return new ActionContext(http, resolved.RouteData, resolved.ActionDescriptor);
    }
}
