using System.Reflection;
using System.Security.Claims;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Automation;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Abstractions;
using Microsoft.AspNetCore.Mvc.Controllers;
using Microsoft.AspNetCore.Mvc.Filters;
using Microsoft.AspNetCore.Routing;

namespace JE.Tests;

/// <summary>Every test that moves or samples JellyfinUserVersions (one process-wide version every check samples) runs alone.</summary>
[CollectionDefinition("Jellyfin user versions", DisableParallelization = true)]
public sealed class JellyfinUserVersionsCollection
{
}

/// <summary>
/// Runs a controller action through the round-8/9 Jellyfin user bracket (<see cref="JellyfinUserChangeBracket"/>) as MVC
/// does, with a delegate standing in for the action, and reports which versions were unsettled while it ran.
/// </summary>
internal static class JellyfinUserBracketHarness
{
    /// <summary>The filter, as DI makes it.</summary>
    public static JellyfinUserChangeBracket New() => new();

    /// <summary>The executing context for <paramref name="method"/> on <paramref name="controller"/>.</summary>
    public static ActionExecutingContext Context(Type controller, MethodInfo method, string httpMethod, IDictionary<string, object?> args, Guid? signedIn = null)
    {
        var descriptor = new ControllerActionDescriptor
        {
            ActionName = method.Name,
            ControllerName = controller.Name.EndsWith("Controller", StringComparison.Ordinal) ? controller.Name[..^"Controller".Length] : controller.Name,
            ControllerTypeInfo = controller.GetTypeInfo(),
            MethodInfo = method,
        };
        var http = new DefaultHttpContext();
        http.Request.Method = httpMethod;
        if (signedIn is { } person) http.User = new ClaimsPrincipal(new ClaimsIdentity(new[] { new Claim("Jellyfin-UserId", person.ToString()) }, "Custom"));
        return new ActionExecutingContext(new ActionContext(http, new RouteData(), descriptor), new List<IFilterMetadata>(), args, new object());
    }

    /// <summary>The context for a stand-in action (Support/JellyfinUserControllerStandIn.cs).</summary>
    public static ActionExecutingContext Context<TController>(string action, IDictionary<string, object?> args, Guid? signedIn = null)
    {
        var method = typeof(TController).GetMethod(action) ?? throw new ArgumentException(action);
        var verb = method.GetCustomAttributes().OfType<Microsoft.AspNetCore.Mvc.Routing.HttpMethodAttribute>().SelectMany(a => a.HttpMethods).FirstOrDefault() ?? "POST";
        return Context(typeof(TController), method, verb, args, signedIn);
    }

    public static Task<ActionExecutedContext> Done(ActionExecutingContext context)
        => Task.FromResult(new ActionExecutedContext(context, new List<IFilterMetadata>(), new object()) { Result = new NoContentResult() });

    /// <summary>
    /// Runs the action; <paramref name="during"/> runs inside it. Returns which of the people's versions were unsettled
    /// meanwhile: "user" (only <paramref name="person"/>'s), "global" (both), "none", or what else was seen.
    /// </summary>
    public static async Task<string> Observe(ActionExecutingContext context, Guid person, Guid other, Action? during = null)
    {
        bool mine = false, theirs = false;
        await New().OnActionExecutionAsync(context, () =>
        {
            mine = !FactVersion.Settled(JellyfinUserVersions.Sample(person));
            theirs = !FactVersion.Settled(JellyfinUserVersions.Sample(other));
            during?.Invoke();
            return Done(context);
        });
        return (mine, theirs) switch
        {
            (true, false) => "user",
            (true, true) => "global",
            (false, false) => "none",
            _ => "someone else",
        };
    }
}
