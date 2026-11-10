using System.Reflection;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc;
using Xunit.Abstractions;

namespace JE.Tests.Architecture;

// Gate B (artifacts/restructure-plan/backend.md §3): Gate A cannot see the admin and current-user checks inside
// action bodies, so this counts, per action method, the IL calls to the auth helpers. A move that keeps bodies
// verbatim keeps the counts; a helper that reads User moved into a service, or a "harmonised" resolver, changes them.
//
// Body of an action = the method, its async/iterator MoveNext, and its lambdas/local functions/closures (with their
// state machines). Plus ONE level of same-type private calls: each distinct non-public method the body calls on the
// controller type or a plugin base class of it (JeControllerBase after S2.0a) adds its own body's helper calls.
// Helpers are matched by method name only, so moving them into JeControllerBase is invisible:
//   IsAdminUser, AuthorizeUserConfigAccess, AuthorizeUserAccess, GetCurrentUserId on any plugin ControllerBase type;
//   UserHelper.GetUserId, UserHelper.GetCurrentUserId; RequestIdentityService.Resolve; and ControllerBase.User reads.
// ONE level misses deeper checks (review M1): AuthReadClosureSnapshotTests follows the full closure per route and
// compares it with restructure-base. This file's per-action counts and snapshot stay as they are.
public class AuthHelperCallSnapshotTests(ITestOutputHelper output)
{
    public const string SnapshotFile = "auth-helper-calls.snapshot.json";

    private static readonly HashSet<string> ControllerHelpers = new(StringComparer.Ordinal)
        { "IsAdminUser", "AuthorizeUserConfigAccess", "AuthorizeUserAccess", "GetCurrentUserId" };

    internal static string? HelperKey(MethodBase method)
    {
        var type = method.DeclaringType;
        if (type == null) return null;
        if (type == typeof(ControllerBase) && method.Name == "get_User") return "User";
        if (Arch.IsControllerType(type) && ControllerHelpers.Contains(method.Name)) return method.Name;
        if (type.Assembly != Arch.Plugin) return null;
        if (type.Name == "UserHelper" && method.Name is "GetUserId" or "GetCurrentUserId") return "UserHelper." + method.Name;
        if (type.Name == "RequestIdentityService" && method.Name == "Resolve") return "RequestIdentityService.Resolve";
        return null;
    }

    private static void CountDirect(IEnumerable<MethodBase> body, SortedDictionary<string, int> counts, ISet<MethodBase>? callees, Type controller)
    {
        foreach (var method in body)
        {
            foreach (var reference in Arch.IlReferences(method).OfType<MethodBase>())
            {
                var key = HelperKey(reference);
                if (key != null)
                {
                    counts[key] = counts.GetValueOrDefault(key) + 1;
                    continue;
                }
                if (callees == null || reference is not MethodInfo callee || callee.IsPublic || callee.Name.Contains('<')) continue;
                var owner = callee.DeclaringType;
                if (owner != null && owner.Assembly == Arch.Plugin && owner.IsAssignableFrom(controller) && Arch.IsControllerType(owner))
                    callees.Add(callee);
            }
        }
    }

    internal static SortedDictionary<string, SortedDictionary<string, int>> Collect()
    {
        var result = new SortedDictionary<string, SortedDictionary<string, int>>(StringComparer.Ordinal);
        foreach (var controller in Arch.Controllers())
        {
            var actions = Arch.Actions(controller);
            var overloaded = actions.GroupBy(a => a.Name).Where(g => g.Count() > 1).Select(g => g.Key).ToHashSet();
            foreach (var action in actions)
            {
                var counts = new SortedDictionary<string, int>(StringComparer.Ordinal);
                var callees = new HashSet<MethodBase>();
                CountDirect(Arch.BodyOf(action), counts, callees, controller);
                foreach (var callee in callees.OfType<MethodInfo>().OrderBy(c => c.Name, StringComparer.Ordinal))
                    CountDirect(Arch.BodyOf(callee), counts, null, controller);
                var key = overloaded.Contains(action.Name)
                    ? $"{action.Name}({string.Join(",", action.GetParameters().Select(p => Arch.Name(p.ParameterType)))})"
                    : action.Name;
                Assert.False(result.ContainsKey(key), $"Two controllers declare the action {key}.");
                result[key] = counts;
            }
        }
        return result;
    }

    internal static string Render(SortedDictionary<string, SortedDictionary<string, int>> calls)
    {
        var lines = calls.Select(pair => $"  {JsonSerializer.Serialize(pair.Key, Arch.Json)}: {JsonSerializer.Serialize(pair.Value, Arch.Json)}");
        return "{\n" + string.Join(",\n", lines) + "\n}\n";
    }

    [Fact]
    public void AuthHelperCallsPerActionMatchTheSnapshot()
    {
        var calls = Collect();
        var totals = calls.Values.SelectMany(c => c).GroupBy(p => p.Key).ToDictionary(g => g.Key, g => g.Sum(p => p.Value));
        output.WriteLine($"actions: {calls.Count}, actions with helper calls: {calls.Count(c => c.Value.Count > 0)}, call sites: {totals.Values.Sum()}");
        foreach (var total in totals.OrderBy(t => t.Key, StringComparer.Ordinal)) output.WriteLine($"  {total.Key}: {total.Value}");
        Arch.VerifySnapshot(SnapshotFile, Render(calls));
    }

    // Every action in the route snapshot has an entry here (and vice versa), so a renamed or dropped action cannot
    // leave Gate B silently smaller.
    [Fact]
    public void EveryRoutedActionIsCounted()
    {
        var routed = RouteAuthSnapshotTests.LoadSnapshot().Select(r => r.Action).ToHashSet(StringComparer.Ordinal);
        var counted = Collect().Keys.Select(k => k.Split('(')[0]).ToHashSet(StringComparer.Ordinal);
        Assert.Equal(routed.OrderBy(a => a, StringComparer.Ordinal), counted.OrderBy(a => a, StringComparer.Ordinal));
    }
}
