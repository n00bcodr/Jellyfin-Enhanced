using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc.Controllers;
using Microsoft.AspNetCore.Mvc.Infrastructure;
using Microsoft.AspNetCore.Routing;
using Microsoft.AspNetCore.Routing.Patterns;
using Microsoft.Extensions.DependencyInjection;
using Xunit.Abstractions;

namespace JE.Tests.Architecture;

// Gate A (artifacts/restructure-plan/backend.md §3): every plugin route as ASP.NET routing sees it, with its verb,
// template, effective auth, action method name, [ApiController] behaviour and parameter binding sources. The
// controller type is left out on purpose, so moving an action between controllers leaves the snapshot unchanged;
// the action (method) name stays in, so method names must be kept.
public class RouteAuthSnapshotTests(ITestOutputHelper output)
{
    public const string SnapshotFile = "route-auth.snapshot.json";
    public const int ExpectedRoutes = 202;
    public const int ExpectedAnonymous = 12;

    public sealed record RouteEntry(string Verb, string Route, bool RequiresAuth, string Auth, string Action, bool ApiBehavior, string[] Parameters);

    private static readonly JsonSerializerOptions Options = new(Arch.Json) { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    internal static List<RouteEntry> Collect()
    {
        using var fixture = new CoreFixture();
        using var server = JE.Tests.ApiRoutingTests.Server(fixture);
        var endpoints = server.Services.GetRequiredService<EndpointDataSource>().Endpoints;
        var entries = new List<RouteEntry>();
        foreach (var endpoint in endpoints.OfType<RouteEndpoint>())
        {
            var action = endpoint.Metadata.GetMetadata<ControllerActionDescriptor>();
            if (action == null || action.ControllerTypeInfo.Assembly != Arch.Plugin) continue;
            var authorize = endpoint.Metadata.GetOrderedMetadata<IAuthorizeData>();
            var requiresAuth = authorize.Any() && endpoint.Metadata.GetMetadata<IAllowAnonymous>() == null;
            var auth = string.Join(";", authorize.Select(a => $"policy={a.Policy ?? ""},roles={a.Roles ?? ""},schemes={a.AuthenticationSchemes ?? ""}")
                .Where(a => a != "policy=,roles=,schemes=").Distinct().OrderBy(a => a, StringComparer.Ordinal));
            var verbs = endpoint.Metadata.GetMetadata<IHttpMethodMetadata>()?.HttpMethods ?? [];
            var parameters = action.Parameters.Select(p => $"{p.Name}:{p.BindingInfo?.BindingSource?.Id ?? "none"}").ToArray();
            entries.Add(new RouteEntry(string.Join(",", verbs.OrderBy(v => v, StringComparer.Ordinal)), endpoint.RoutePattern.RawText ?? "",
                requiresAuth, auth, action.MethodInfo.Name, endpoint.Metadata.GetMetadata<Microsoft.AspNetCore.Mvc.Infrastructure.IApiBehaviorMetadata>() != null, parameters));
        }
        return entries.OrderBy(e => e.Route, StringComparer.Ordinal).ThenBy(e => e.Verb, StringComparer.Ordinal)
            .ThenBy(e => e.Action, StringComparer.Ordinal).ToList();
    }

    internal static string Render(IEnumerable<RouteEntry> entries)
    {
        var lines = entries.Select(e => "  " + JsonSerializer.Serialize(e, Options)).ToList();
        return "[\n" + string.Join(",\n", lines) + "\n]\n";
    }

    public static List<RouteEntry> LoadSnapshot()
        => JsonSerializer.Deserialize<List<RouteEntry>>(File.ReadAllText(Path.Combine(Arch.SnapshotDirectory, SnapshotFile)), Options)!;

    // A concrete request path for a route template: each parameter gets "1", a catch-all gets "x/y". Gate C asserts the
    // request routes back to the same action, so a sample that another template would capture fails loudly.
    public static string SamplePath(string template)
    {
        var pattern = RoutePatternFactory.Parse(template);
        var path = new StringBuilder();
        foreach (var segment in pattern.PathSegments)
        {
            if (path.Length > 0) path.Append('/');
            foreach (var part in segment.Parts)
            {
                path.Append(part switch
                {
                    RoutePatternLiteralPart literal => literal.Content,
                    RoutePatternSeparatorPart separator => separator.Content,
                    RoutePatternParameterPart { IsCatchAll: true } => "x/y",
                    RoutePatternParameterPart => "1",
                    _ => throw new InvalidOperationException(template),
                });
            }
        }
        return path.ToString();
    }

    [Fact]
    public void RouteVerbAuthAndBindingMatchTheSnapshot()
    {
        var entries = Collect();
        output.WriteLine($"routes: {entries.Count}, anonymous: {entries.Count(e => !e.RequiresAuth)}");
        foreach (var anonymous in entries.Where(e => !e.RequiresAuth)) output.WriteLine($"anonymous: {anonymous.Verb} {anonymous.Route} ({anonymous.Action})");
        Arch.VerifySnapshot(SnapshotFile, Render(entries));
    }

    // The snapshot itself must keep the step-1 shape (PLAN.md Definition of done): 202 routes, 12 anonymous, no
    // policies or roles, [ApiController] everywhere, and no duplicate (verb, template).
    [Fact]
    public void SnapshotHasTheStepOneShape()
    {
        var entries = LoadSnapshot();
        Assert.Equal(ExpectedRoutes, entries.Count);
        Assert.Equal(ExpectedAnonymous, entries.Count(e => !e.RequiresAuth));
        Assert.All(entries, e => Assert.Equal("", e.Auth));
        Assert.All(entries, e => Assert.True(e.ApiBehavior, e.Route));
        Assert.Empty(entries.GroupBy(e => (e.Verb, e.Route)).Where(g => g.Count() > 1).Select(g => g.Key));
    }
}
