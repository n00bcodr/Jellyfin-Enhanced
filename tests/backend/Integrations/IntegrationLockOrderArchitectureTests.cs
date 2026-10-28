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

    private sealed record Root(MethodBase Method, string Why);

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
            for (var i = 0; i < ops.Count; i++)
            {
                var op = ops[i];
                // lock (_gate): the protected try block that encloses Monitor.Enter, after a load of the monitor field.
                if (op.Member is MethodInfo { Name: "Enter", DeclaringType.FullName: "System.Threading.Monitor" } && ops.Take(i).LastOrDefault(o => o.Member is FieldInfo)?.Member is FieldInfo held && held == Gate)
                {
                    var clause = clauses.Where(c => c.Flags == ExceptionHandlingClauseOptions.Finally && c.TryOffset <= op.Offset && op.Offset < c.TryOffset + c.TryLength).OrderBy(c => c.TryLength).FirstOrDefault();
                    if (clause != null) Region(op.Offset, clause.TryOffset + clause.TryLength, "lock (_gate)");
                }
                // using (CacheMutation()) / using (LockFacts()): the try block of the using that follows the call.
                if (IsCall(op) && op.Member is MethodBase acquired && HoldsGate.Contains(Definition(acquired)))
                {
                    var clause = clauses.Where(c => c.Flags == ExceptionHandlingClauseOptions.Finally && c.TryOffset > op.Offset).OrderBy(c => c.TryOffset).FirstOrDefault();
                    if (clause != null) Region(clause.TryOffset, clause.TryOffset + clause.TryLength, "using (" + acquired.Name + "())");
                }
                // Callback(s) built since the previous plugin call and handed to an API that runs them under the monitor.
                if (IsCall(op) && op.Member is MethodBase api && RunsUnderGate.Contains(Definition(api)))
                {
                    for (var j = i - 1; j >= 0; j--)
                    {
                        var arg = ops[j];
                        if (IsCall(arg) && arg.Member is MethodBase previous && Scanned(previous.Module)) break;
                        if ((arg.Code == OpCodes.Ldftn || arg.Code == OpCodes.Ldvirtftn) && arg.Member is MethodBase callback && Scanned(callback.Module))
                            roots.Add(new Root(Definition(callback), "callback of " + api.Name + " in " + Describe(method)));
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

    // A blocking acquisition: a load of the configuration lock that is not Publish's own (which never waits under the monitor).
    private static bool TakesConfiguration(MethodBase method)
        => method != ListPublish && Read(method).Any(o => o.Code == OpCodes.Ldsfld && o.Member is FieldInfo field && field == Configuration);

    // Publish's own callback runs with the configuration lock already held, when Publish takes it before the monitor.
    private static bool PublishTakesConfigurationFirst()
    {
        var ops = Read(ListPublish);
        var configuration = ops.FindIndex(o => o.Code == OpCodes.Ldsfld && o.Member is FieldInfo field && field == Configuration);
        var commit = ops.FindIndex(o => IsCall(o) && o.Member is MethodBase m && Definition(m) == typeof(EffectiveRequestsBackend).GetMethod("CommitEffective", Declared));
        return configuration >= 0 && commit > configuration;
    }

    private static List<string> Violations(IEnumerable<Type> types, out List<Root> roots)
    {
        roots = GateRoots(types);
        var implementations = Implementations();
        var violations = new List<string>();
        var exempt = PublishTakesConfigurationFirst();
        foreach (var root in roots)
        {
            var seen = new HashSet<MethodBase>();
            if (exempt && root.Why.StartsWith("callback of CommitEffective in Services.Acquire.Lists.ListMetadataEpoch.Publish", StringComparison.Ordinal)) continue;
            var queue = new Queue<(MethodBase Method, string Path)>();
            queue.Enqueue((root.Method, root.Why + " -> " + Describe(root.Method)));
            while (queue.Count > 0)
            {
                var (method, path) = queue.Dequeue();
                if (method == ListPublish && exempt || !seen.Add(method)) continue;
                if (TakesConfiguration(method)) { violations.Add(path); continue; }
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
        // The scan must see the shapes it guards: the backend's own blocks, the cache-mutation blocks and the callbacks.
        Assert.Contains(roots, r => r.Why.StartsWith("lock (_gate)", StringComparison.Ordinal));
        Assert.Contains(roots, r => r.Why.StartsWith("using (CacheMutation())", StringComparison.Ordinal));
        Assert.Contains(roots, r => r.Why.StartsWith("callback of PublishSeerr in Controllers.JellyfinEnhancedController", StringComparison.Ordinal));
        Assert.Contains(roots, r => r.Why.StartsWith("callback of CommitEffective in Services.Acquire.Lists.ListMetadataEpoch.Publish", StringComparison.Ordinal));
        // A floor, so a scan that stopped recognising them fails instead of passing on nothing (179 roots on 2026-10-29).
        Assert.True(roots.Count(r => r.Why.StartsWith("lock (_gate)", StringComparison.Ordinal)) >= 20 && roots.Count(r => r.Why.StartsWith("using (", StringComparison.Ordinal)) >= 20
            && roots.Count(r => r.Why.StartsWith("callback of ", StringComparison.Ordinal)) >= 40, "the scan found too few regions under the backend monitor");
        Assert.True(violations.Count == 0, "configuration lock taken under the backend monitor:\n" + string.Join("\n", violations));
    }

    [Fact]
    public void APlantedInversionFails()
    {
        var violations = Violations(new[] { typeof(PlantedInversion) }, out _);
        Assert.Contains(violations, v => v.StartsWith("callback of CommitEffective in JE.Tests.PlantedInversion.Publication", StringComparison.Ordinal) && v.EndsWith("PlantedInversion.Save", StringComparison.Ordinal));
        Assert.Contains(violations, v => v.StartsWith("using (CacheMutation()) in JE.Tests.PlantedInversion.Mutation", StringComparison.Ordinal) && v.EndsWith("PlantedInversion.Save", StringComparison.Ordinal));
        Assert.Contains(violations, v => v.StartsWith("callback of PublishSeerr in JE.Tests.PlantedInversion.Facts", StringComparison.Ordinal) && v.Contains("ListMetadataEpoch.Capture", StringComparison.Ordinal));
        Assert.Equal(3, violations.Count);
    }

    [Fact]
    public void ListPublicationTakesTheConfigurationLockBeforeTheBackendMonitor()
    {
        Assert.True(PublishTakesConfigurationFirst(), "ListMetadataEpoch.Publish must take the configuration lock before CommitEffective");
        var ops = Read(ListPublish);
        // It never waits for the lock while its caller holds the monitor: it asks whether the monitor is held and tries.
        Assert.Contains(ops, o => o.Member is MethodInfo { Name: "get_HoldsGate" });
        Assert.Contains(ops, o => o.Member is MethodInfo { Name: "TryEnter", DeclaringType.FullName: "System.Threading.Monitor" });
    }
}

// Inversions the scan must catch: under the monitor, a direct and a two-hop wait for the configuration lock.
internal static class PlantedInversion
{
    private static int Save() { lock (Jellyfin.Plugin.JellyfinEnhanced.JellyfinEnhanced.AnalyticsCredentialLock) return 1; }
    private static int Indirect() => Save();
    internal static int Publication() => EffectiveRequestsBackend.Shared.CommitEffective(0, () => Indirect());
    internal static int Mutation() { using (SeerrFacts.CacheMutation()) return Indirect(); }
    internal static bool Facts() => SeerrFacts.PublishSeerr(0, () => ListMetadataEpoch.Capture().IsCurrent);
}
