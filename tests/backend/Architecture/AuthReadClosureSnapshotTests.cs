using System.Reflection;
using System.Runtime.CompilerServices;
using System.Text.Json;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.ApplicationModels;
using Microsoft.AspNetCore.Mvc.Routing;
using Xunit.Abstractions;

namespace JE.Tests.Architecture;

// Gate B, transitive (review M1; backend.md §3 "Transitive attribution"). AuthHelperCallSnapshotTests follows only
// ONE level of same-type private calls, so a check two calls deep (GetPublicConfig → BuildPublicConfig →
// VisibleItemLooks, which reads User and GetCurrentUserId on an anonymous route) could be deleted unnoticed. This
// follows the FULL closure from every routed action, with a visited set (so recursion and shared helpers end):
//   - the method's async/iterator state machine (StateMachineAttribute → MoveNext);
//   - any plugin method declared on a compiler-generated type, or named like one (lambdas, closures, local functions);
//   - any plugin method declared on the action's controller type or a plugin base class of it (JeControllerBase),
//     whatever its visibility, static or not;
//   - any static plugin method (UserHelper-style helpers, Shared/** statics, PublicApi forwarders).
// Instance methods of other plugin types (services) are not followed: request identity must not be read there
// (ServicesDoNotReadUserTests). The auth-relevant reads below are leaves (counted, not followed).
//
// Snapshot: per ROUTE ("VERB template", the Gate A key, independent of controller and file), the number of read sites
// of each kind summed over the distinct methods of the closure. The expected file is generated from a
// restructure-base build (BaseAnchoredSnapshots.cs), so it proves steps 1–8 kept every route's auth reads.
public class AuthReadClosureSnapshotTests(ITestOutputHelper output)
{
    public const string SnapshotFile = "auth-reads-by-route.base.json";

    private static readonly HashSet<string> ControllerHelpers = new(StringComparer.Ordinal)
        { "IsAdminUser", "GetCurrentUserId" };

    // Auth-relevant reads: ControllerBase.User, HttpContext.User, the controller helpers IsAdminUser, GetCurrentUserId
    // and AuthorizeUser* (on any plugin ControllerBase type, so the move into JeControllerBase is invisible), every
    // UserHelper method, and RequestIdentityService.Resolve.
    internal static string? ReadKey(MethodBase method, Assembly plugin)
    {
        var type = method.DeclaringType;
        if (type == null) return null;
        if (method.Name == "get_User" && (type == typeof(ControllerBase) || type == typeof(HttpContext)))
            return type == typeof(ControllerBase) ? "User" : "HttpContext.User";
        if (type.Assembly != plugin) return null;
        if (typeof(ControllerBase).IsAssignableFrom(type)
            && (ControllerHelpers.Contains(method.Name) || method.Name.StartsWith("AuthorizeUser", StringComparison.Ordinal)))
            return method.Name;
        if (type.Name == "UserHelper") return "UserHelper." + method.Name;
        if (type.Name == "RequestIdentityService" && method.Name == "Resolve") return "RequestIdentityService.Resolve";
        return null;
    }

    private static bool IsCompilerGenerated(Type? type)
    {
        for (; type != null; type = type.DeclaringType)
            if (type.Name.Contains('<') || type.IsDefined(typeof(CompilerGeneratedAttribute), false)) return true;
        return false;
    }

    // The method definition (open generic type and method), so each method of the closure is visited once.
    private static MethodBase Canonical(MethodBase method)
    {
        try { return method.Module.ResolveMethod(method.MetadataToken) ?? method; }
        catch (Exception) { return method; }
    }

    private static bool Follow(MethodBase callee, Type controller, Assembly plugin)
    {
        var owner = callee.DeclaringType;
        if (owner == null || owner.Assembly != plugin) return false;
        if (IsCompilerGenerated(owner) || callee.Name.Contains('<')) return true;
        if (callee is ConstructorInfo) return false;
        var definition = owner.IsGenericType ? owner.GetGenericTypeDefinition() : owner;
        if (typeof(ControllerBase).IsAssignableFrom(definition) && definition.IsAssignableFrom(controller)) return true;
        return callee.IsStatic;
    }

    internal sealed record RoutedAction(string Key, Type Controller, MethodInfo Action);

    // "VERB template" for every [Http*] attribute of every action, combined with the controller's [Route] templates
    // the way MVC does (AttributeRouteModel.CombineTemplates). RoutesMatchGateA proves it equals Gate A's endpoint list.
    internal static List<RoutedAction> RoutedActions(Assembly plugin)
    {
        var result = new List<RoutedAction>();
        var controllers = BaseAnchored.Types(plugin)
            .Where(t => t.IsClass && !t.IsAbstract && typeof(ControllerBase).IsAssignableFrom(t));
        foreach (var controller in controllers)
        {
            var prefixes = controller.GetCustomAttributes<RouteAttribute>(true).Select(r => r.Template).ToList();
            if (prefixes.Count == 0) prefixes.Add("");
            foreach (var action in controller.GetMethods(BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly))
            {
                foreach (var http in action.GetCustomAttributes<HttpMethodAttribute>(true))
                {
                    var verbs = string.Join(",", http.HttpMethods.OrderBy(v => v, StringComparer.Ordinal));
                    foreach (var prefix in prefixes)
                        result.Add(new RoutedAction($"{verbs} {AttributeRouteModel.CombineTemplates(prefix, http.Template)}", controller, action));
                }
            }
        }
        return result;
    }

    internal static SortedDictionary<string, SortedDictionary<string, int>> Collect(Assembly plugin)
    {
        var references = new Dictionary<MethodBase, MethodBase[]>();
        MethodBase[] ReferencesOf(MethodBase method)
        {
            if (!references.TryGetValue(method, out var list))
                references[method] = list = Arch.IlReferences(method).OfType<MethodBase>().ToArray();
            return list;
        }

        var result = new SortedDictionary<string, SortedDictionary<string, int>>(StringComparer.Ordinal);
        foreach (var routed in RoutedActions(plugin))
        {
            var counts = new SortedDictionary<string, int>(StringComparer.Ordinal);
            var visited = new HashSet<MethodBase>();
            var pending = new Stack<MethodBase>();
            pending.Push(Canonical(routed.Action));
            while (pending.Count > 0)
            {
                var method = pending.Pop();
                if (!visited.Add(method)) continue;
                var machine = method.GetCustomAttribute<StateMachineAttribute>()?.StateMachineType;
                var moveNext = machine?.GetMethod("MoveNext", BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public);
                if (moveNext != null) pending.Push(Canonical(moveNext));
                foreach (var callee in ReferencesOf(method))
                {
                    var key = ReadKey(callee, plugin);
                    if (key != null) counts[key] = counts.GetValueOrDefault(key) + 1;
                    else if (Follow(callee, routed.Controller, plugin)) pending.Push(Canonical(callee));
                }
            }
            Assert.False(result.ContainsKey(routed.Key), $"Two actions are routed as {routed.Key}.");
            result[routed.Key] = counts;
        }
        return result;
    }

    internal static string Render(SortedDictionary<string, SortedDictionary<string, int>> reads)
    {
        var lines = reads.Select(pair => $"    {JsonSerializer.Serialize(pair.Key, Arch.Json)}: {JsonSerializer.Serialize(pair.Value, Arch.Json)}");
        return "{\n  \"routes\": {\n" + string.Join(",\n", lines) + "\n  }\n}\n";
    }

    [Fact]
    public void TransitiveAuthReadsPerRouteMatchRestructureBase()
    {
        var reads = Collect(BaseAnchored.Subject);
        var totals = reads.Values.SelectMany(c => c).GroupBy(p => p.Key).ToDictionary(g => g.Key, g => g.Sum(p => p.Value));
        output.WriteLine($"subject: {BaseAnchored.SubjectLabel}");
        output.WriteLine("controllers: " + string.Join(", ", RoutedActions(BaseAnchored.Subject).Select(r => r.Controller.Name).Distinct().Order(StringComparer.Ordinal)));
        output.WriteLine($"routes: {reads.Count}, routes with auth reads: {reads.Count(r => r.Value.Count > 0)}, read sites: {totals.Values.Sum()}");
        foreach (var total in totals.OrderBy(t => t.Key, StringComparer.Ordinal)) output.WriteLine($"  {total.Key}: {total.Value}");
        BaseAnchored.Verify(SnapshotFile, Render(reads));
    }

    // The route keys are Gate A's endpoints exactly (same verbs and templates), so no route escapes this gate.
    [Fact]
    public void RoutesMatchGateA()
    {
        var gateA = RouteAuthSnapshotTests.LoadSnapshot().Select(r => $"{r.Verb} {r.Route}").Order(StringComparer.Ordinal).ToList();
        var keys = RoutedActions(BaseAnchored.Subject).Select(r => r.Key).Order(StringComparer.Ordinal).ToList();
        Assert.Equal(gateA, keys);
    }
}
