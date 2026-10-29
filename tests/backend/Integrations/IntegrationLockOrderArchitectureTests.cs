using System.Reflection;
using System.Reflection.Emit;
using System.Runtime.CompilerServices;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Backends;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists;

namespace JE.Tests;

/// <summary>
/// I4R-1: one lock order. The configuration lock (<c>JellyfinEnhanced.AnalyticsCredentialLock</c>) is outer and
/// <see cref="EffectiveRequestsBackend"/>'s monitor inner: configuration writers, their change listeners and
/// <c>SeerrMigration.SettleHandover</c> read the backend while holding the configuration lock, so nothing that runs while
/// the backend monitor is held may wait for the configuration lock. The scan reads the plugin's IL: the backend's own
/// <c>lock (_gate)</c> blocks, every <c>SeerrFacts.CacheMutation()</c>/<c>LockFacts()</c> block and every callback handed
/// to an API that runs it under the monitor, then follows the plugin methods they can call (interface implementations,
/// async state machines and lambdas included) to a blocking acquisition of the configuration lock.
/// <c>ListMetadataEpoch.Publish</c> is the one method that takes the configuration lock with the monitor possibly held:
/// it takes it before the monitor, and only tries (never waits) when its caller already holds the monitor.
/// </summary>
public class IntegrationLockOrderArchitectureTests
{
    private const BindingFlags Declared = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static | BindingFlags.DeclaredOnly;
    private static readonly Dictionary<short, OpCode> Ops = typeof(OpCodes).GetFields(BindingFlags.Public | BindingFlags.Static)
        .Select(f => (OpCode)f.GetValue(null)!).ToDictionary(o => o.Value);
    private static Assembly Plugin => typeof(EffectiveRequestsBackend).Assembly;
    private static readonly FieldInfo Configuration = typeof(Jellyfin.Plugin.JellyfinEnhanced.JellyfinEnhanced).GetField("AnalyticsCredentialLock", BindingFlags.NonPublic | BindingFlags.Static)!;
    private static readonly FieldInfo Gate = typeof(EffectiveRequestsBackend).GetField("_gate", BindingFlags.NonPublic | BindingFlags.Instance)!;
    // The list lifecycle lock precedes the configuration lock (ListMetadataEpoch: "Lifecycle precedes this lock").
    private static readonly FieldInfo Lifecycle = typeof(ListContinuation).GetField("Lifecycle", BindingFlags.NonPublic | BindingFlags.Static)!;

    private sealed record Op(int Offset, OpCode Code, MemberInfo? Member);

    private static readonly System.Collections.Concurrent.ConcurrentDictionary<MethodBase, List<Op>> Bodies = new();
    private static List<Op> Read(MethodBase method) => Bodies.GetOrAdd(method, Decode);

    private static List<Op> Decode(MethodBase method)
    {
        var ops = new List<Op>();
        byte[]? il;
        try { il = method.GetMethodBody()?.GetILAsByteArray(); }
        catch (Exception) { return ops; }
        if (il == null) return ops;
        var typeArgs = method.DeclaringType is { IsGenericType: true } t ? t.GetGenericArguments() : null;
        var methodArgs = method is MethodInfo { IsGenericMethod: true } m ? m.GetGenericArguments() : null;
        for (var i = 0; i < il.Length;)
        {
            var offset = i;
            OpCode op;
            if (il[i] == 0xFE) { op = Ops[unchecked((short)(0xFE00 | il[i + 1]))]; i += 2; }
            else { op = Ops[il[i]]; i += 1; }
            MemberInfo? member = null;
            if (op.OperandType is OperandType.InlineMethod or OperandType.InlineField or OperandType.InlineTok)
            {
                try { member = method.Module.ResolveMember(BitConverter.ToInt32(il, i), typeArgs, methodArgs); }
                catch (Exception) { member = null; }
            }
            i += op.OperandType switch
            {
                OperandType.InlineNone => 0,
                OperandType.ShortInlineBrTarget or OperandType.ShortInlineI or OperandType.ShortInlineVar => 1,
                OperandType.InlineVar => 2,
                OperandType.InlineI8 or OperandType.InlineR => 8,
                OperandType.InlineSwitch => 4 + 4 * BitConverter.ToInt32(il, i),
                _ => 4,
            };
            ops.Add(new Op(offset, op, member));
        }
        return ops;
    }

    // The plugin, and this assembly for the planted inversion below.
    private static bool Scanned(Module module) => module == Plugin.ManifestModule || module == typeof(IntegrationLockOrderArchitectureTests).Module;

    private static IEnumerable<Type> Types()
    {
        try { return Plugin.GetTypes(); }
        catch (ReflectionTypeLoadException ex) { return ex.Types.OfType<Type>(); }
    }

    private static IEnumerable<MethodBase> Methods(Type type) => type.GetMethods(Declared).Cast<MethodBase>().Concat(type.GetConstructors(Declared));

    // The declared method (generic definitions, not instantiations), so that bodies and identities are shared.
    private static MethodBase Definition(MethodBase method)
    {
        if (method is MethodInfo { IsGenericMethod: true, IsGenericMethodDefinition: false } generic) method = generic.GetGenericMethodDefinition();
        if (method.DeclaringType is { IsGenericType: true, IsGenericTypeDefinition: false })
        {
            try { return method.Module.ResolveMethod(method.MetadataToken)!; }
            catch (Exception) { return method; }
        }
        return method;
    }

    private static string Describe(MethodBase method) => (method.DeclaringType?.FullName ?? "?").Replace("Jellyfin.Plugin.JellyfinEnhanced.", "", StringComparison.Ordinal) + "." + method.Name;

    private static bool IsCall(Op op) => op.Code == OpCodes.Call || op.Code == OpCodes.Callvirt || op.Code == OpCodes.Newobj;

    // APIs that run the delegate they are given while the backend monitor is held.
    private static readonly HashSet<MethodBase> RunsUnderGate = new MethodBase[]
    {
        typeof(EffectiveRequestsBackend).GetMethod("CommitEffective", Declared)!,
        typeof(EffectiveRequestsBackend).GetMethod("CommitSeerr", Declared)!,
        typeof(EffectiveRequestsBackend).GetMethod("CommitFacts", Declared)!,
        typeof(EffectiveRequestsBackend).GetMethod("PublishSeerr", Declared)!,
        typeof(EffectiveRequestsBackend).GetMethod("ReadSeerrCached", Declared)!,
        typeof(SeerrFacts).GetMethod("PublishSeerr", Declared)!,
        typeof(SeerrFacts).GetMethod("ReadSeerrCached", Declared)!,
        typeof(SeerrFacts).GetNestedType("Access", BindingFlags.NonPublic)!.GetMethod("Publish", Declared)!,
        typeof(SeerrFacts).GetNestedType("Access", BindingFlags.NonPublic)!.GetMethod("Cached", Declared)!,
        typeof(SeerrFacts).GetNestedType("Publication", BindingFlags.NonPublic | BindingFlags.Public)!.GetMethod("Publish", Declared)!,
    }.ToHashSet();

    // Calls that return a held backend monitor, released by the using block that follows.
    private static readonly HashSet<MethodBase> HoldsGate = new MethodBase[]
    {
        typeof(EffectiveRequestsBackend).GetMethod("LockFacts", Declared)!,
        typeof(SeerrFacts).GetMethod("CacheMutation", Declared)!,
    }.ToHashSet();

    private static readonly MethodBase ListPublish = typeof(ListMetadataEpoch).GetMethod("Publish", Declared)!;

    // What the root runs under besides the backend monitor: the configuration lock (ListMetadataEpoch.Publish's
    // callbacks, when Publish proves it holds it for every callback) and the lifecycle lock (held at the call site).
    private sealed record Root(MethodBase Method, string Why, bool ConfigurationHeld = false, bool LifecycleHeld = false);

    // The protected try blocks of lock (field) statements in a method body.
    private static List<(int Start, int End)> LockRegions(List<Op> ops, IList<ExceptionHandlingClause> clauses, FieldInfo field)
    {
        var regions = new List<(int, int)>();
        for (var i = 0; i < ops.Count; i++)
        {
            if (ops[i].Member is not MethodInfo { Name: "Enter", DeclaringType.FullName: "System.Threading.Monitor" }) continue;
            if (ops.Take(i).LastOrDefault(o => o.Member is FieldInfo)?.Member is not FieldInfo held || held != field) continue;
            var clause = clauses.Where(c => c.Flags == ExceptionHandlingClauseOptions.Finally && c.TryOffset <= ops[i].Offset && ops[i].Offset < c.TryOffset + c.TryLength).OrderBy(c => c.TryLength).FirstOrDefault();
            if (clause != null) regions.Add((ops[i].Offset, clause.TryOffset + clause.TryLength));
        }
        return regions;
    }

    // Everything that runs while some method holds the backend monitor: the callees and lambdas of its locked regions,
    // and the callbacks it hands to an API that invokes them under the monitor.
    private static List<Root> GateRoots(IEnumerable<Type> types)
    {
        var roots = new List<Root>();
        foreach (var type in types)
        foreach (var method in Methods(type))
        {
            var ops = Read(method);
            if (ops.Count == 0) continue;
            var clauses = method.GetMethodBody()?.ExceptionHandlingClauses ?? (IList<ExceptionHandlingClause>)Array.Empty<ExceptionHandlingClause>();
            void Region(int start, int end, string why)
            {
                foreach (var op in ops.Where(o => o.Offset >= start && o.Offset < end && o.Member is MethodBase))
                    if (op.Member is MethodBase callee && (IsCall(op) || op.Code == OpCodes.Ldftn || op.Code == OpCodes.Ldvirtftn) && Scanned(callee.Module))
                        roots.Add(new Root(Definition(callee), why + " in " + Describe(method)));
            }
            // lock (_gate): the protected try block that encloses Monitor.Enter, after a load of the monitor field.
            foreach (var (start, end) in LockRegions(ops, clauses, Gate)) Region(start, end, "lock (_gate)");
            var lifecycle = LockRegions(ops, clauses, Lifecycle);
            for (var i = 0; i < ops.Count; i++)
            {
                var op = ops[i];
                // using (CacheMutation()) / using (LockFacts()): the try block of the using that follows the call.
                if (IsCall(op) && op.Member is MethodBase acquired && HoldsGate.Contains(Definition(acquired)))
                {
                    var clause = clauses.Where(c => c.Flags == ExceptionHandlingClauseOptions.Finally && c.TryOffset > op.Offset).OrderBy(c => c.TryOffset).FirstOrDefault();
                    if (clause != null) Region(clause.TryOffset, clause.TryOffset + clause.TryLength, "using (" + acquired.Name + "())");
                }
                // Callback(s) built since the previous plugin call and handed to an API that runs them under the monitor.
                // ListMetadataEpoch.Publish's effect and refusal run under it too (CommitEffective, or a caller's monitor),
                // and with the configuration lock only when Publish's own structure proves it for every callback.
                if (IsCall(op) && op.Member is MethodBase api && (RunsUnderGate.Contains(Definition(api)) || Definition(api) == ListPublish))
                {
                    var publish = Definition(api) == ListPublish;
                    var configurationHeld = publish && PublishRunsCallbacksUnderConfiguration()
                        || method == ListPublish && PublishRunsCallbacksUnderConfiguration();
                    var lifecycleHeld = lifecycle.Any(r => r.Start <= op.Offset && op.Offset < r.End);
                    for (var j = i - 1; j >= 0; j--)
                    {
                        var arg = ops[j];
                        if (IsCall(arg) && arg.Member is MethodBase previous && Scanned(previous.Module)) break;
                        if ((arg.Code == OpCodes.Ldftn || arg.Code == OpCodes.Ldvirtftn) && arg.Member is MethodBase callback && Scanned(callback.Module))
                            roots.Add(new Root(Definition(callback), "callback of " + (publish ? "ListMetadataEpoch.Publish" : api.Name) + " in " + Describe(method), configurationHeld, lifecycleHeld));
                    }
                }
            }
        }
        return roots;
    }

    private static Dictionary<MethodBase, List<MethodBase>> Implementations()
    {
        var map = new Dictionary<MethodBase, List<MethodBase>>();
        foreach (var type in Types().Where(t => t is { IsInterface: false } && !t.ContainsGenericParameters || t is { IsGenericTypeDefinition: true, IsInterface: false }))
        foreach (var contract in type.GetInterfaces().Where(i => i.Assembly == Plugin))
        {
            InterfaceMapping mapping;
            try { mapping = type.GetInterfaceMap(contract); }
            catch (Exception) { continue; }
            for (var k = 0; k < mapping.InterfaceMethods.Length; k++)
            {
                var key = Definition(mapping.InterfaceMethods[k]);
                if (!map.TryGetValue(key, out var list)) map[key] = list = new List<MethodBase>();
                list.Add(Definition(mapping.TargetMethods[k]));
            }
        }
        return map;
    }

    private static IEnumerable<MethodBase> Callees(MethodBase method, Dictionary<MethodBase, List<MethodBase>> implementations)
    {
        foreach (var op in Read(method))
        {
            if (op.Member is not MethodBase callee || !Scanned(callee.Module) || !(IsCall(op) || op.Code == OpCodes.Ldftn || op.Code == OpCodes.Ldvirtftn)) continue;
            var target = Definition(callee);
            yield return target;
            if (implementations.TryGetValue(target, out var impls)) foreach (var impl in impls) yield return impl;
        }
        if (method.GetCustomAttribute<StateMachineAttribute>() is { } machine)
        {
            var move = machine.StateMachineType.GetMethod("MoveNext", Declared);
            if (move != null) yield return move;
        }
    }

    // A blocking acquisition of an outer lock the root doesn't already hold (the configuration lock or the lifecycle lock).
    private static string? TakesOuterLock(MethodBase method, Root root)
    {
        foreach (var op in Read(method))
        {
            if (op.Code != OpCodes.Ldsfld || op.Member is not FieldInfo field) continue;
            if (field == Configuration && !root.ConfigurationHeld) return "configuration lock";
            if (field == Lifecycle && !root.LifecycleHeld) return "lifecycle lock";
        }
        return null;
    }

    private static bool IsInvoke(Op op) => op.Code == OpCodes.Callvirt && op.Member is MethodInfo { Name: "Invoke" } invoke && typeof(Delegate).IsAssignableFrom(invoke.DeclaringType);

    // Publish takes the configuration lock before CommitEffective, and its nested branch (the caller already holds the
    // backend monitor) only tries it and, when it is busy, throws before any delegate or plugin code runs: so every
    // callback (effect and refusal, in CommitEffective's lambda or the catch) runs with the configuration lock held.
    private static bool PublishRunsCallbacksUnderConfiguration()
    {
        var ops = Read(ListPublish);
        int Find(Func<Op, bool> match, int from = 0) { for (var i = from; i < ops.Count; i++) if (match(ops[i])) return i; return -1; }
        var commit = Find(o => IsCall(o) && o.Member is MethodBase m && Definition(m) == typeof(EffectiveRequestsBackend).GetMethod("CommitEffective", Declared));
        var configuration = Find(o => o.Code == OpCodes.Ldsfld && o.Member is FieldInfo field && field == Configuration);
        var nested = Find(o => o.Member is MethodInfo { Name: "get_HoldsGate" });
        var tries = Find(o => o.Member is MethodInfo { Name: "TryEnter", DeclaringType.FullName: "System.Threading.Monitor" });
        var enters = Find(o => o.Member is MethodInfo { Name: "Enter", DeclaringType.FullName: "System.Threading.Monitor" });
        var refusal = Find(o => o.Code == OpCodes.Throw, Math.Max(tries, 0));
        if (commit < 0 || configuration < 0 || nested < 0 || tries < nested || enters < 0 || refusal < 0) return false;
        // Configuration first; the busy branch ends in a throw before the blocking Enter and CommitEffective.
        if (!(configuration < commit && refusal < enters && enters < commit)) return false;
        if (ops.Skip(nested).Take(refusal - nested).Any(o => IsInvoke(o) || IsCall(o) && o.Member is MethodBase m && Scanned(m.Module) && m.Name != "get_HoldsGate" && m.DeclaringType != typeof(BackendDisabledException))) return false;
        if (ops[refusal - 1].Code != OpCodes.Newobj || (ops[refusal - 1].Member as MethodBase)?.DeclaringType != typeof(BackendDisabledException)) return false;
        // No delegate runs before the configuration lock is entered.
        return ops.Take(enters).All(o => !IsInvoke(o) && o.Code != OpCodes.Ldftn);
    }

    private static List<string> Violations(IEnumerable<Type> types, out List<Root> roots)
    {
        roots = GateRoots(types);
        var implementations = Implementations();
        var violations = new List<string>();
        foreach (var root in roots)
        {
            var seen = new HashSet<MethodBase>();
            var queue = new Queue<(MethodBase Method, string Path)>();
            queue.Enqueue((root.Method, root.Why + " -> " + Describe(root.Method)));
            while (queue.Count > 0)
            {
                var (method, path) = queue.Dequeue();
                // Publish's own acquisition never waits under the monitor; its callbacks are roots of their own.
                if (method == ListPublish || !seen.Add(method)) continue;
                if (TakesOuterLock(method, root) is { } outer) { violations.Add(outer + ": " + path); continue; }
                foreach (var callee in Callees(method, implementations))
                    if (!seen.Contains(callee)) queue.Enqueue((callee, path + " -> " + Describe(callee)));
            }
        }
        return violations;
    }

    [Fact]
    public void NothingRunUnderTheBackendMonitorWaitsForTheConfigurationLock()
    {
        Assert.NotNull(Configuration);
        Assert.NotNull(Gate);
        var violations = Violations(Types(), out var roots);
        Assert.True(violations.Count == 0, "outer lock taken under the backend monitor:\n" + string.Join("\n", violations));
        // The scan must see the shapes it guards: the backend's own blocks, the cache-mutation blocks and the callbacks.
        Assert.Contains(roots, r => r.Why.StartsWith("lock (_gate)", StringComparison.Ordinal));
        Assert.Contains(roots, r => r.Why.StartsWith("using (CacheMutation())", StringComparison.Ordinal));
        Assert.Contains(roots, r => r.Why.StartsWith("callback of PublishSeerr in Controllers.JellyfinEnhancedController", StringComparison.Ordinal));
        Assert.Contains(roots, r => r.Why.StartsWith("callback of CommitEffective in Services.Acquire.Lists.ListMetadataEpoch.Publish", StringComparison.Ordinal) && r.ConfigurationHeld);
        // The list continuation's effect and refusal (LOR-1) are followed, under the lifecycle lock Write holds.
        Assert.Equal(2, roots.Count(r => r.Why.StartsWith("callback of ListMetadataEpoch.Publish in Services.Acquire.Lists.ListContinuation.Write", StringComparison.Ordinal) && r.ConfigurationHeld && r.LifecycleHeld));
        // A floor, so a scan that stopped recognising them fails instead of passing on nothing (179 roots on 2026-10-29).
        Assert.True(roots.Count(r => r.Why.StartsWith("lock (_gate)", StringComparison.Ordinal)) >= 20 && roots.Count(r => r.Why.StartsWith("using (", StringComparison.Ordinal)) >= 20
            && roots.Count(r => r.Why.StartsWith("callback of ", StringComparison.Ordinal)) >= 40, "the scan found too few regions under the backend monitor");
    }

    [Fact]
    public void APlantedInversionFails()
    {
        var violations = Violations(new[] { typeof(PlantedInversion) }, out _);
        Assert.Contains(violations, v => v.StartsWith("configuration lock: callback of CommitEffective in JE.Tests.PlantedInversion.Publication", StringComparison.Ordinal) && v.EndsWith("PlantedInversion.Save", StringComparison.Ordinal));
        Assert.Contains(violations, v => v.StartsWith("configuration lock: using (CacheMutation()) in JE.Tests.PlantedInversion.Mutation", StringComparison.Ordinal) && v.EndsWith("PlantedInversion.Save", StringComparison.Ordinal));
        Assert.Contains(violations, v => v.Contains("callback of PublishSeerr in JE.Tests.PlantedInversion.Facts", StringComparison.Ordinal) && v.Contains("ListMetadataEpoch.Capture", StringComparison.Ordinal));
        // A list publication's refusal callback that waits for the lifecycle lock, and a cache-mutation block that does.
        Assert.Contains(violations, v => v.StartsWith("lifecycle lock: callback of ListMetadataEpoch.Publish in JE.Tests.PlantedInversion.Refusal", StringComparison.Ordinal) && v.EndsWith("PlantedInversion.Lifecycled", StringComparison.Ordinal));
        Assert.Contains(violations, v => v.StartsWith("lifecycle lock: using (CacheMutation()) in JE.Tests.PlantedInversion.Retire", StringComparison.Ordinal));
        // Re-entering the configuration lock from a Publish callback is not one (Publish holds it for every callback).
        Assert.DoesNotContain(violations, v => v.Contains("PlantedInversion.Reentrant", StringComparison.Ordinal));
        Assert.Equal(5, violations.Count);
    }

    [Fact]
    public void ListPublicationTakesTheConfigurationLockBeforeTheBackendMonitor()
    {
        // Before the monitor; and with the monitor already held it only tries, refusing by a throw before any callback.
        Assert.True(PublishRunsCallbacksUnderConfiguration(), "ListMetadataEpoch.Publish must take the configuration lock before CommitEffective, and run no callback without it");
    }
}

// Inversions the scan must catch: under the monitor, a direct and a two-hop wait for the configuration lock, and waits
// for the lifecycle lock (outer to the configuration lock); Reentrant is the allowed control.
internal static class PlantedInversion
{
    private static int Lifecycled() { lock (ListContinuation.Lifecycle) return 1; }
    internal static int Refusal() => ListMetadataEpoch.Capture().Publish(() => 1, () => Lifecycled());
    internal static void Retire() { using (SeerrFacts.CacheMutation()) Lifecycled(); }
    internal static int Reentrant() => ListMetadataEpoch.Capture().Publish(() => Save(), () => 0);
    private static int Save() { lock (Jellyfin.Plugin.JellyfinEnhanced.JellyfinEnhanced.AnalyticsCredentialLock) return 1; }
    private static int Indirect() => Save();
    internal static int Publication() => EffectiveRequestsBackend.Shared.CommitEffective(0, () => Indirect());
    internal static int Mutation() { using (SeerrFacts.CacheMutation()) return Indirect(); }
    internal static bool Facts() => SeerrFacts.PublishSeerr(0, () => ListMetadataEpoch.Capture().IsCurrent);
}
