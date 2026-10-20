using System.Reflection;
using System.Reflection.Emit;
using System.Runtime.CompilerServices;
using Jellyfin.Plugin.JellyfinEnhanced.Services;

namespace JE.Tests;

/// <summary>
/// The emitters of protected answers, DERIVED from the plugin's IL rather than listed: every method the host calls to
/// produce an answer (a controller action, an MVC filter's callback, a WebSocket listener's data) whose call graph reads a
/// viewer's privacy policy (Hidden Content, Spoiler Guard, the presentation gate's read) emits a protected answer. Each one
/// must reach the one delivery gate (Services.PrivacyDelivery) itself, or hand its answer to the final presentation gate
/// (a JE route the gate classifies; an action or resource filter that only produces object answers, which the always-run
/// result filter projects at delivery). Every method that calls the gate makes no blocking call (a policy read, a library,
/// user-data, user, media-source or session lookup, a wait, an await, a file read, or a plugin method reaching one) after
/// its last gate call: the gate is the answer's last step (a rebuild re-reads at the top of its next attempt).
/// </summary>
internal static class PrivacyDeliveryScan
{
    private static readonly Dictionary<short, OpCode> _ops = typeof(OpCodes).GetFields(BindingFlags.Public | BindingFlags.Static)
        .Select(f => (OpCode)f.GetValue(null)!).ToDictionary(o => o.Value);

    private const BindingFlags Declared = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static | BindingFlags.DeclaredOnly;

    /// <summary>The gate type (resolved by name: the scan also runs against a build without it).</summary>
    public static Type? GateType => PrivacyOutputPathScan.Plugin.GetType("Jellyfin.Plugin.JellyfinEnhanced.Services.PrivacyDelivery");

    /// <summary>A viewer's privacy policy read: what makes an answer protected.</summary>
    public static bool ReadsPolicy(MethodBase method)
    {
        var type = method.DeclaringType;
        return type == typeof(TitlePresentationGate) && method.Name == nameof(TitlePresentationGate.Read)
            || type == typeof(HiddenContentPolicy) && method.Name == nameof(HiddenContentPolicy.Load)
            || type == typeof(SpoilerTagDataStripper) && method.Name == nameof(SpoilerTagDataStripper.CreatePolicy)
            || type == typeof(SpoilerUserResolver) && method.Name.StartsWith("LoadUserState", StringComparison.Ordinal)
            || type == typeof(SpoilerPresentation) && method.Name == nameof(SpoilerPresentation.Load);
    }

    /// <summary>The gate a scan checks against (the plugin's, or a planted stand-in).</summary>
    [ThreadStatic] private static Type? _gate;

    private static bool IsGate(MethodBase method) => (_gate ?? GateType) is { } gate && method.DeclaringType == gate && method.Name is "Deliver" or "DeliverAsync" or "Current";

    /// <summary>
    /// Emitters whose answer names no title, with the reason (reviewed exclusions; everything else must reach a gate).
    /// </summary>
    public static readonly Dictionary<string, string> Exclusions = new(StringComparer.Ordinal)
    {
        ["Controllers.JellyfinEnhancedController.GetTmdbMovieGenres"] = "TMDB's movie genre vocabulary (genre ids and names); no title",
        ["Controllers.JellyfinEnhancedController.GetTmdbTvGenres"] = "TMDB's series genre vocabulary (genre ids and names); no title",
        ["Controllers.NativeDetailsFeedsController.Keywords"] = "TMDB keywords matching a typed tag (keyword ids and names); no title",
    };

    /// <summary>Host lookups and waits: a step that blocks while the viewer's inputs can change.</summary>
    private static readonly Type[] _hostLookups =
    [
        typeof(MediaBrowser.Controller.Library.ILibraryManager), typeof(MediaBrowser.Controller.Library.IUserDataManager),
        typeof(MediaBrowser.Controller.Library.IUserManager), typeof(MediaBrowser.Controller.Library.IMediaSourceManager),
        typeof(MediaBrowser.Controller.Session.ISessionManager), typeof(MediaBrowser.Controller.Persistence.IItemRepository),
    ];

    private static bool BlocksDirectly(MethodBase method)
    {
        var type = method.DeclaringType;
        if (type == null) return false;
        if (ReadsPolicy(method)) return true;
        if (_hostLookups.Any(h => h.IsAssignableFrom(type)) && type.Assembly != PrivacyOutputPathScan.Plugin) return true;
        if (type == typeof(SemaphoreSlim) && method.Name.StartsWith("Wait", StringComparison.Ordinal)) return true;
        if (type == typeof(Monitor) && method.Name is "Enter" or "TryEnter" or "Wait") return true;
        if (type == typeof(Thread) && method.Name == "Sleep" || type == typeof(Task) && method.Name is "Delay" or "Wait") return true;
        if (type == typeof(File) && method.Name.StartsWith("Read", StringComparison.Ordinal)) return true;
        return method.Name == "GetAwaiter";
    }

    /// <summary>The members one method body references, with their IL offsets.</summary>
    public static IEnumerable<(int Offset, MemberInfo Member)> Referenced(MethodBase method)
    {
        MethodBody? body;
        try { body = method.GetMethodBody(); }
        catch (Exception) { yield break; }
        if (body == null) yield break;
        var il = body.GetILAsByteArray() ?? [];
        var typeArgs = method.DeclaringType is { IsGenericType: true } t ? t.GetGenericArguments() : null;
        var methodArgs = method is MethodInfo { IsGenericMethod: true } m ? m.GetGenericArguments() : null;
        for (var i = 0; i < il.Length;)
        {
            var at = i;
            OpCode op;
            if (il[i] == 0xFE) { op = _ops[unchecked((short)(0xFE00 | il[i + 1]))]; i += 2; }
            else { op = _ops[il[i]]; i += 1; }
            var size = op.OperandType switch
            {
                OperandType.InlineNone => 0,
                OperandType.ShortInlineBrTarget or OperandType.ShortInlineI or OperandType.ShortInlineVar => 1,
                OperandType.InlineVar => 2,
                OperandType.InlineI8 or OperandType.InlineR => 8,
                OperandType.InlineSwitch => 4 + 4 * BitConverter.ToInt32(il, i),
                _ => 4,
            };
            if (op.OperandType is OperandType.InlineMethod or OperandType.InlineField or OperandType.InlineTok)
            {
                MemberInfo? member = null;
                try { member = method.Module.ResolveMember(BitConverter.ToInt32(il, i), typeArgs, methodArgs); }
                catch (Exception) { member = null; }
                if (member != null) yield return (at, member);
            }
            i += size;
        }
    }

    private static MethodBase Normalize(MethodBase method)
    {
        if (method is MethodInfo { IsGenericMethod: true, IsGenericMethodDefinition: false } generic) method = generic.GetGenericMethodDefinition();
        if (method.DeclaringType is { IsGenericType: true, IsGenericTypeDefinition: false } declaring)
        {
            try { method = MethodBase.GetMethodFromHandle(method.MethodHandle, declaring.GetGenericTypeDefinition().TypeHandle) ?? method; }
            catch (Exception) { }
        }
        return method;
    }

    /// <summary>A method's body and its async/iterator state machine's.</summary>
    private static IEnumerable<MethodBase> Bodies(MethodBase method)
    {
        yield return method;
        foreach (var machine in method.GetCustomAttributes<StateMachineAttribute>())
            if (machine.StateMachineType.GetMethod("MoveNext", Declared) is { } next) yield return next;
    }

    private static IEnumerable<Type> AllTypes(Assembly assembly)
    {
        try { return assembly.GetTypes(); }
        catch (ReflectionTypeLoadException ex) { return ex.Types.OfType<Type>(); }
    }

    /// <summary>Every plugin method reachable from <paramref name="root"/> (calls, lambdas, state machines, plugin implementations).</summary>
    private static HashSet<MethodBase> Reach(MethodBase root, Assembly scanned, Func<MethodBase, bool>? stop = null)
    {
        var reached = new HashSet<MethodBase>();
        var walked = new HashSet<MethodBase>();
        var queue = new Queue<MethodBase>();
        queue.Enqueue(root);
        while (queue.Count > 0)
        {
            var method = Normalize(queue.Dequeue());
            reached.Add(method);
            if (method.Module.Assembly != scanned && method.Module.Assembly != PrivacyOutputPathScan.Plugin || !walked.Add(method) || stop?.Invoke(method) == true) continue;
            foreach (var body in Bodies(method))
                foreach (var (_, member) in Referenced(body))
                    if (member is MethodBase callee)
                    {
                        reached.Add(Normalize(callee));
                        if (callee.Module.Assembly == scanned || callee.Module.Assembly == PrivacyOutputPathScan.Plugin) queue.Enqueue(callee);
                        if (callee is MethodInfo info && Implementations.TryGetValue(Normalize(info), out var targets))
                            foreach (var target in targets) queue.Enqueue(target);
                    }
        }
        return reached;
    }

    private static readonly Lazy<Dictionary<MethodBase, List<MethodInfo>>> _implementations = new(() =>
    {
        var map = new Dictionary<MethodBase, List<MethodInfo>>();
        foreach (var type in AllTypes(PrivacyOutputPathScan.Plugin).Where(t => t.IsClass))
        {
            foreach (var face in type.GetInterfaces().Where(i => !i.ContainsGenericParameters && i.Assembly == PrivacyOutputPathScan.Plugin))
            {
                InterfaceMapping mapping;
                try { mapping = type.GetInterfaceMap(face); }
                catch (Exception) { continue; }
                for (var i = 0; i < mapping.InterfaceMethods.Length; i++)
                    (map.TryGetValue(mapping.InterfaceMethods[i], out var list) ? list : map[mapping.InterfaceMethods[i]] = new()).Add(mapping.TargetMethods[i]);
            }
        }
        return map;
    });

    private static Dictionary<MethodBase, List<MethodInfo>> Implementations => _implementations.Value;

    private static readonly Dictionary<(MethodBase, Type?), bool> _blocks = new();

    /// <summary>Whether a method blocks: a host lookup, a wait, an await or a file read in it or in a plugin method it reaches.</summary>
    private static bool Blocks(MethodBase method, Assembly scanned)
    {
        if (BlocksDirectly(method)) return true;
        if (method.Module.Assembly != scanned && method.Module.Assembly != PrivacyOutputPathScan.Plugin) return false;
        lock (_blocks)
            if (_blocks.TryGetValue((method, _gate), out var known)) return known;
        // The plugin's logger writes what happened; it reads no input of the answer.
        var blocks = Reach(method, scanned, m => IsGate(m) || m.DeclaringType == typeof(Jellyfin.Plugin.JellyfinEnhanced.Logger)).Any(BlocksDirectly);
        lock (_blocks) _blocks[(method, _gate)] = blocks;
        return blocks;
    }

    /// <summary>The host's callbacks into the plugin that produce an HTTP or WebSocket answer.</summary>
    public static List<MethodBase> Entries(Assembly assembly)
    {
        var entries = new List<MethodBase>();
        foreach (var type in AllTypes(assembly).Where(t => t.IsClass && !t.IsAbstract))
        {
            if (typeof(Microsoft.AspNetCore.Mvc.ControllerBase).IsAssignableFrom(type))
                entries.AddRange(type.GetMethods(BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly)
                    .Where(m => m.GetCustomAttributes<Microsoft.AspNetCore.Mvc.Routing.HttpMethodAttribute>().Any()));
            if (typeof(Microsoft.AspNetCore.Mvc.Filters.IFilterMetadata).IsAssignableFrom(type))
                entries.AddRange(type.GetMethods(Declared).Where(m => m.Name is "OnResultExecuting" or "OnResultExecutionAsync" or "OnActionExecuting" or "OnActionExecuted"
                    or "OnActionExecutionAsync" or "OnResourceExecuting" or "OnResourceExecuted" or "OnResourceExecutionAsync"));
            for (var b = type.BaseType; b != null; b = b.BaseType)
                if (b.IsGenericType && b.GetGenericTypeDefinition().FullName?.StartsWith("MediaBrowser.Controller.Net.BasePeriodicWebSocketListener", StringComparison.Ordinal) == true)
                    entries.AddRange(type.GetMethods(Declared).Where(m => m.Name.StartsWith("GetDataToSend", StringComparison.Ordinal)));
        }
        return entries;
    }

    /// <summary>An emitter of protected answers and how its answer reaches the gate (null: it does not).</summary>
    public sealed record Emitter(MethodBase Method, string? Covered)
    {
        public string Name => PrivacyOutputPathScan.Describe(Method);
    }

    public sealed record Result(Type? Gate, List<Emitter> Emitters, List<string> LateSteps);

    private static readonly MethodInfo? _route = typeof(TitlePresentationResultFilter).GetMethod("Route", BindingFlags.NonPublic | BindingFlags.Static);

    /// <summary>Whether the final presentation gate classifies a JE action's route (projects its JSON at delivery).</summary>
    private static bool FinalGateProjects(MethodInfo action)
    {
        var template = action.GetCustomAttributes<Microsoft.AspNetCore.Mvc.Routing.HttpMethodAttribute>().Select(a => a.Template).FirstOrDefault(t => t != null);
        var prefix = action.DeclaringType?.GetCustomAttribute<Microsoft.AspNetCore.Mvc.RouteAttribute>()?.Template;
        if (template == null || _route == null) return false;
        var full = template.StartsWith('/') || template.StartsWith('~') ? template.TrimStart('~', '/') : (prefix == null ? template : prefix.TrimEnd('/') + "/" + template);
        var http = new Microsoft.AspNetCore.Http.DefaultHttpContext();
        var descriptor = new Microsoft.AspNetCore.Mvc.Controllers.ControllerActionDescriptor
        {
            ControllerTypeInfo = action.DeclaringType!.GetTypeInfo(), MethodInfo = action, ActionName = action.Name,
            AttributeRouteInfo = new Microsoft.AspNetCore.Mvc.Routing.AttributeRouteInfo { Template = full },
        };
        // A parameter segment is bound to a representative value of its kind (the route's family is a literal).
        var values = new Microsoft.AspNetCore.Routing.RouteValueDictionary();
        foreach (var part in full.Split('/').Where(p => p.StartsWith('{')))
        {
            var name = part.Trim('{', '}', '*').Split(':', '=', '?')[0];
            values[name] = name.Contains("type", StringComparison.OrdinalIgnoreCase) ? "movie" : "1";
        }
        var context = new Microsoft.AspNetCore.Mvc.ActionContext(http, new Microsoft.AspNetCore.Routing.RouteData(values), descriptor);
        return _route.Invoke(null, [context]) != null;
    }

    /// <summary>A filter that only ever produces object answers (the always-run result filter projects them at delivery).</summary>
    private static bool ProducesOnlyObjects(MethodBase entry, Assembly scanned)
    {
        foreach (var method in Reach(entry, scanned, IsGate))
            foreach (var body in Bodies(method))
                foreach (var (_, member) in Referenced(body))
                {
                    if (member is ConstructorInfo { DeclaringType: { } made } && (typeof(Microsoft.AspNetCore.Mvc.FileResult).IsAssignableFrom(made)
                        || typeof(Microsoft.AspNetCore.Mvc.ContentResult).IsAssignableFrom(made))) return false;
                    if (member is MethodInfo { DeclaringType: { } owner } call && owner == typeof(Microsoft.AspNetCore.Http.HttpResponse) && call.Name == "get_Body") return false;
                }
        return true;
    }

    public static Result Run(IEnumerable<MethodBase>? entries = null, Assembly? assembly = null, Type? gate = null)
    {
        _gate = gate;
        try { return Scan(entries, assembly); }
        finally { _gate = null; }
    }

    private static Result Scan(IEnumerable<MethodBase>? entries, Assembly? assembly)
    {
        var scanned = assembly ?? PrivacyOutputPathScan.Plugin;
        var emitters = new List<Emitter>();
        foreach (var entry in entries ?? Entries(scanned))
        {
            var reached = Reach(entry, scanned);
            if (!reached.Any(ReadsPolicy)) continue;
            string? covered = reached.Any(IsGate) ? "gate"
                : Exclusions.TryGetValue(PrivacyOutputPathScan.Describe(entry), out var reason) ? "excluded: " + reason
                : entry is MethodInfo action && typeof(Microsoft.AspNetCore.Mvc.ControllerBase).IsAssignableFrom(action.DeclaringType) && FinalGateProjects(action) ? "final gate (route)"
                : entry.Name is "OnActionExecuting" or "OnActionExecuted" or "OnActionExecutionAsync" or "OnResourceExecuting" or "OnResourceExecuted" or "OnResourceExecutionAsync"
                    && ProducesOnlyObjects(entry, scanned) ? "final gate (object answers)"
                : null;
            emitters.Add(new Emitter(entry, covered));
        }

        // The gate is the last step: no blocking call after the last gate call in any method that calls it.
        var late = new List<string>();
        if ((_gate ?? GateType) != null)
            foreach (var type in AllTypes(scanned))
                foreach (var method in type.GetMethods(Declared).Cast<MethodBase>().Concat(type.GetConstructors(Declared)))
                {
                    var refs = Referenced(method).ToList();
                    var gates = refs.Where(r => r.Member is MethodBase m && IsGate(Normalize(m))).Select(r => r.Offset).ToList();
                    if (gates.Count == 0) continue;
                    var last = gates.Max();
                    // An async method awaits the gate's own task right after calling it.
                    var awaitedGate = false;
                    foreach (var (offset, member) in refs.Where(r => r.Offset > last).OrderBy(r => r.Offset))
                    {
                        if (member is not MethodBase callee) continue;
                        if (!awaitedGate && callee.Name == "GetAwaiter") { awaitedGate = true; continue; }
                        if (Blocks(Normalize(callee), scanned)) late.Add(PrivacyOutputPathScan.Describe(method) + " calls " + callee.DeclaringType?.Name + "." + callee.Name + " after the gate");
                    }
                }
        return new Result(GateType, emitters, late);
    }
}
