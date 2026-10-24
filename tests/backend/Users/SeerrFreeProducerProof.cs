using System.Reflection;
using System.Runtime.CompilerServices;
namespace JE.Tests;

/// <summary>Compiled producer proof shared by registry exemptions and planted state-machine controls.</summary>
internal static class SeerrFreeProducerProof
{
    internal const BindingFlags Declared = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static | BindingFlags.DeclaredOnly;
    internal static IReadOnlyList<string> Violations(IEnumerable<MethodBase> producers, Func<Type?, bool> forbidden)
    {
        var roots = producers.ToArray();
        if (roots.Length == 0) return ["No compiled producer roots"];
        var assembly = roots[0].DeclaringType!.Assembly;
        if (assembly == PrivacyOutputPathScan.Plugin && forbidden == (Func<Type?, bool>)Seerr)
        {
            var graph = Production.Value;
            return roots.Select(m => graph.GetValueOrDefault((m.Module, m.MetadataToken))).OfType<string>().Distinct().ToArray();
        }
        var callbacks = CallbackAssignments(assembly);
        var pending = new Stack<(MethodBase Method, string Path)>(roots.Select(m => (m, m.DeclaringType!.FullName + "." + m.Name)));
        var seen = new HashSet<(Module, int)>();
        var violations = new List<string>();
        while (pending.TryPop(out var item))
        {
            var method = item.Method;
            if (!seen.Add((method.Module, method.MetadataToken))) continue;
            if (forbidden(method.DeclaringType)) { violations.Add(item.Path); continue; }
            foreach (var reference in PrivacyOutputPathScan.Referenced(method))
            {
                if (forbidden(reference.DeclaringType) || reference is FieldInfo field && ForbiddenType(field.FieldType, forbidden))
                { violations.Add(item.Path + " -> " + reference.DeclaringType?.FullName + "." + reference.Name); continue; }
                if (reference is FieldInfo callback && callbacks.TryGetValue((callback.Module, callback.MetadataToken), out var assignments))
                    foreach (var assignment in assignments)
                        pending.Push((assignment, item.Path + " -> stored callback " + callback.Name + " -> " + assignment.Name));
                if (reference is MethodBase called && called.DeclaringType?.Assembly == assembly)
                {
                    pending.Push((called, item.Path + " -> " + called.DeclaringType.Name + "." + called.Name));
                    if (called.DeclaringType.IsInterface && called is MethodInfo contract)
                    {
                        foreach (var implementation in assembly.GetTypes().Where(t => !t.IsInterface && !t.ContainsGenericParameters && called.DeclaringType.IsAssignableFrom(t)))
                        {
                            var map = implementation.GetInterfaceMap(called.DeclaringType);
                            for (var i = 0; i < map.InterfaceMethods.Length; i++)
                                if (map.InterfaceMethods[i].MetadataToken == contract.MetadataToken)
                                    pending.Push((map.TargetMethods[i], item.Path + " -> " + implementation.FullName + "." + called.Name));
                        }
                    }
                }
            }
            foreach (var state in method.GetCustomAttributes<StateMachineAttribute>())
                if (state.StateMachineType.GetMethod("MoveNext", Declared) is { } move)
                    pending.Push((move, item.Path + " -> " + state.GetType().Name + ".MoveNext"));
        }
        return violations;
    }
    private static Dictionary<(Module, int), HashSet<(Module, int)>> _producerCallers = new();
    private static Dictionary<(Module, int), MethodBase> _producerMethods = new();
    internal static IReadOnlyList<MethodBase> Producers(IEnumerable<MethodBase> roots)
    {
        var all = roots.ToArray();
        if (all.Length == 0 || all[0].DeclaringType?.Assembly != PrivacyOutputPathScan.Plugin) return all;
        _ = Production.Value;
        var seen = new HashSet<(Module, int)>(all.Select(m => (m.Module, m.MetadataToken)));
        var queue = new Queue<(Module, int)>(seen);
        while (queue.TryDequeue(out var key))
            if (_producerCallers.TryGetValue(key, out var callers))
                foreach (var caller in callers) if (seen.Add(caller)) queue.Enqueue(caller);
        return seen.Select(k => _producerMethods.GetValueOrDefault(k)).OfType<MethodBase>().ToArray();
    }
    private static Type? ComputationOwner(Type? type)
    {
        while (type?.DeclaringType != null && type.IsDefined(typeof(CompilerGeneratedAttribute), false)) type = type.DeclaringType;
        return type;
    }
    private static readonly Lazy<Dictionary<(Module, int), string>> Production = new(BuildProductionProof);
    private static Dictionary<(Module, int), string> BuildProductionProof()
    {
        var assembly = PrivacyOutputPathScan.Plugin;
        var types = assembly.GetTypes();
        var methods = types.SelectMany(t => t.GetMethods(Declared).Cast<MethodBase>().Concat(t.GetConstructors(Declared))).ToArray();
        var reverse = new Dictionary<(Module, int), HashSet<(Module, int)>>();
        var producers = new Dictionary<(Module, int), HashSet<(Module, int)>>();
        var bad = new Dictionary<(Module, int), string>();
        var dispatch = new Dictionary<(Module, int), MethodBase[]>();
        var callbacks = CallbackAssignments(assembly);
        void Edge(MethodBase from, MethodBase to)
        {
            if (to.DeclaringType?.Assembly != assembly) return;
            var key = (to.Module, to.MetadataToken);
            if (!reverse.TryGetValue(key, out var parents)) reverse[key] = parents = new();
            parents.Add((from.Module, from.MetadataToken));
            if (ComputationOwner(from.DeclaringType) == ComputationOwner(to.DeclaringType))
            {
                if (!producers.TryGetValue(key, out var callers)) producers[key] = callers = new();
                callers.Add((from.Module, from.MetadataToken));
            }
        }
        foreach (var method in methods)
        {
            var key = (method.Module, method.MetadataToken);
            if (Seerr(method.DeclaringType)) bad.TryAdd(key, method.DeclaringType!.FullName + "." + method.Name);
            foreach (var reference in PrivacyOutputPathScan.Referenced(method))
            {
                if (Seerr(reference.DeclaringType) || reference is FieldInfo field && ForbiddenType(field.FieldType, Seerr))
                    bad.TryAdd(key, method.DeclaringType!.FullName + "." + method.Name + " -> " + reference.DeclaringType?.FullName + "." + reference.Name);
                if (reference is FieldInfo callback && callbacks.TryGetValue((callback.Module, callback.MetadataToken), out var assignments))
                    foreach (var assignment in assignments) Edge(method, assignment);
                if (reference is not MethodBase called || called.DeclaringType?.Assembly != assembly) continue;
                Edge(method, called);
                if (called.DeclaringType.IsInterface && called is MethodInfo contract)
                {
                    var callKey = (called.Module, called.MetadataToken);
                    if (!dispatch.TryGetValue(callKey, out var targets))
                    {
                        var found = new List<MethodBase>();
                        foreach (var implementation in types.Where(t => !t.IsInterface && !t.ContainsGenericParameters && called.DeclaringType.IsAssignableFrom(t)))
                        {
                            var map = implementation.GetInterfaceMap(called.DeclaringType);
                            for (var i = 0; i < map.InterfaceMethods.Length; i++)
                                if (map.InterfaceMethods[i].MetadataToken == contract.MetadataToken) found.Add(map.TargetMethods[i]);
                        }
                        dispatch[callKey] = targets = found.ToArray();
                    }
                    foreach (var target in targets) Edge(method, target);
                }
            }
            foreach (var state in method.GetCustomAttributes<StateMachineAttribute>())
                if (state.StateMachineType.GetMethod("MoveNext", Declared) is { } move) Edge(method, move);
        }
        var queue = new Queue<(Module, int)>(bad.Keys);
        var names = methods.GroupBy(m => (m.Module, m.MetadataToken)).ToDictionary(g => g.Key, g => g.First().DeclaringType!.FullName + "." + g.First().Name);
        while (queue.TryDequeue(out var key))
        {
            if (!reverse.TryGetValue(key, out var parents)) continue;
            foreach (var parent in parents)
                if (bad.TryAdd(parent, names.GetValueOrDefault(parent, "producer") + " -> " + bad[key])) queue.Enqueue(parent);
        }
        _producerCallers = producers;
        _producerMethods = methods.GroupBy(m => (m.Module, m.MetadataToken)).ToDictionary(g => g.Key, g => g.First());
        return bad;
    }

    // Delegate Invoke has no direct call edge to a stored target. Include targets from every
    // assignment (constructors/type initializers included), delegate factories and copied callback
    // fields, following compiler-generated lambda caches to their own initializers. Do not treat
    // unrelated instance-constructor work as computation of a field's callback.
    private static Dictionary<(Module, int), MethodBase[]> CallbackAssignments(Assembly assembly)
    {
        var definitions = new Dictionary<(Module, int), HashSet<MemberInfo>>();
        var methods = assembly.GetTypes().SelectMany(t => t.GetMethods(Declared).Cast<MethodBase>().Concat(t.GetConstructors(Declared)));
        foreach (var method in methods)
        {
            var stores = PrivacyOutputPathScan.Referenced(method, fieldStoresOnly: true).OfType<FieldInfo>()
                .Where(f => typeof(Delegate).IsAssignableFrom(f.FieldType)).ToArray();
            if (stores.Length == 0) continue;
            var targets = PrivacyOutputPathScan.Referenced(method, fieldStoresOnly: false, callbackTargetsOnly: true).ToArray();
            foreach (var field in stores)
            {
                var id = (field.Module, field.MetadataToken);
                if (!definitions.TryGetValue(id, out var found)) definitions[id] = found = new();
                found.UnionWith(targets);
                // Loading a static callback also runs its type initializer. Its side effects are
                // reachable even when they are separate from the callback-producing expression.
                if (field.IsStatic && field.DeclaringType?.TypeInitializer is { } initializer) found.Add(initializer);
            }
        }
        var result = new Dictionary<(Module, int), MethodBase[]>();
        foreach (var field in definitions.Keys)
        {
            var seen = new HashSet<(Module, int)>();
            var pending = new Stack<(Module, int)>(); pending.Push(field);
            var targets = new HashSet<MethodBase>();
            while (pending.TryPop(out var id))
            {
                if (!seen.Add(id) || !definitions.TryGetValue(id, out var references)) continue;
                foreach (var reference in references)
                {
                    if (reference is MethodBase target) targets.Add(target);
                    else if (reference is FieldInfo copied) pending.Push((copied.Module, copied.MetadataToken));
                }
            }
            result[field] = targets.ToArray();
        }
        return result;
    }

    private static bool ForbiddenType(Type type, Func<Type?, bool> forbidden)
        => forbidden(type) || type.HasElementType && ForbiddenType(type.GetElementType()!, forbidden)
            || type.GetGenericArguments().Any(t => ForbiddenType(t, forbidden));
    internal static bool Seerr(Type? type)
    {
        for (var t = type; t != null; t = t.DeclaringType)
            if (t.Name == "SeerrFacts" || t.Name is "SeerrRequestReadModel" or "SeerrMigrationReader" or "SeerrAskedProofCache" or "SeerrOwnershipReader" or "SeerrRequestRecord" or "SeerrTitleMeta" or "SeerrReadModelState" or "SeerrHttpHelper" or "JellyseerrUserImportHelper") return true;
        return type?.Namespace?.Contains(".Model.Jellyseerr", StringComparison.Ordinal) == true;
    }
}
