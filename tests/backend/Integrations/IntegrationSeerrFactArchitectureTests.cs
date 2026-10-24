using System.Reflection;
using Jellyfin.Plugin.JellyfinEnhanced.Controllers;

namespace JE.Tests;

public class IntegrationSeerrFactArchitectureTests
{
    private const BindingFlags Declared = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static | BindingFlags.DeclaredOnly;
    private static Assembly Plugin => typeof(JellyfinEnhancedController).Assembly;
    private static bool Inside(Type? type, Type owner)
    {
        for (; type != null; type = type.DeclaringType) if (type == owner) return true;
        return false;
    }
    private static bool Contains(Type type, HashSet<Type> forbidden)
        => forbidden.Contains(type) || (type.HasElementType && Contains(type.GetElementType()!, forbidden)) || type.GetGenericArguments().Any(t => Contains(t, forbidden));

    [Fact]
    public void OnlyTheAccessorCanReferenceThePrivateSeerrReadersModelsAndCaches()
    {
        var owner = Plugin.GetType("Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.SeerrFacts");
        Assert.NotNull(owner);
        var raw = Plugin.GetTypes().Where(t => t.Name is "SeerrRequestReadModel" or "SeerrMigrationReader" or "SeerrAskedProofCache" or "SeerrOwnershipReader").ToHashSet();
        Assert.Equal(4, raw.Count);
        Assert.All(raw, type => { Assert.True(type.IsNestedPrivate, type.FullName); Assert.True(Inside(type, owner), type.FullName); });
        // Include all raw readers' nested snapshots/cache records, and all signatures and IL bodies,
        // including compiler-generated lambdas and async state machines. No consumer allowlist.
        var forbidden = Plugin.GetTypes().Where(t => raw.Any(r => Inside(t, r))).ToHashSet();
        var violations = new List<string>();
        foreach (var type in Plugin.GetTypes().Where(t => !Inside(t, owner)))
        {
            foreach (var field in type.GetFields(Declared))
                if (Contains(field.FieldType, forbidden)) violations.Add(type.FullName + "." + field.Name);
            foreach (var method in type.GetMethods(Declared).Cast<MethodBase>().Concat(type.GetConstructors(Declared)))
            {
                if (method.GetParameters().Any(p => Contains(p.ParameterType, forbidden)) || method is MethodInfo info && Contains(info.ReturnType, forbidden)) violations.Add(type.FullName + "." + method.Name + " signature");
                foreach (var reference in PrivacyOutputPathScan.Referenced(method))
                    if (reference.DeclaringType != null && Contains(reference.DeclaringType, forbidden)) violations.Add(type.FullName + "." + method.Name + " -> " + reference);
            }
        }
        Assert.Empty(violations);
        // Escape carriers are recursive: Task/ValueTask, delegates, collections and object/interface boxes.
        // This is a guard against accidental API escape, not against hostile private reflection.
        Assert.Empty(RawEscapes(owner, raw, forbidden));
        // Cache handles may be held by callers, but their raw storage remains private to the owner.
        foreach (var cache in owner.GetNestedTypes(BindingFlags.NonPublic).Where(t => t.Name.StartsWith("Cache`", StringComparison.Ordinal) || t.Name.StartsWith("PreparedCache`", StringComparison.Ordinal)))
            Assert.All(cache.GetFields(Declared), f => Assert.True(f.IsPrivate, cache + "." + f.Name));
    }
    private static bool Carrier(Type type, HashSet<Type> raw, HashSet<Type>? seen = null)
    {
        seen ??= new();
        if (!seen.Add(type)) return false;
        if (type.IsGenericParameter) return true; // A caller can choose an interface/object carrier for T.
        if (raw.Any(type.IsAssignableFrom)) return true;
        if (type.HasElementType && Carrier(type.GetElementType()!, raw, seen)) return true;
        if (type.GetGenericArguments().Any(t => Carrier(t, raw, seen))) return true;
        if (typeof(Delegate).IsAssignableFrom(type) && type.GetMethod("Invoke") is { } invoke && Carrier(invoke.ReturnType, raw, seen)) return true;
        // Plugin-defined boxes (including object/interface members) are carriers too.
        return type.Assembly == raw.First().Assembly && !type.IsPrimitive && !type.IsEnum
            && type.GetFields(Declared).Any(f => Carrier(f.FieldType, raw, seen));
    }

    private static IReadOnlyList<string> RawEscapes(Type owner, HashSet<Type> raw, HashSet<Type> forbidden)
    {
        bool TouchesRaw(MethodBase method, HashSet<MethodBase> seen)
        {
            if (!seen.Add(method)) return false;
            foreach (var reference in PrivacyOutputPathScan.Referenced(method))
            {
                if (reference is FieldInfo field && Contains(field.FieldType, forbidden)
                    || reference.DeclaringType != null && forbidden.Contains(reference.DeclaringType)) return true;
                if (reference is MethodBase called && Inside(called.DeclaringType, owner) && TouchesRaw(called, seen)) return true;
            }
            // Async bodies live in their state machine's MoveNext; lambda bodies are followed above.
            var state = method.GetCustomAttribute<System.Runtime.CompilerServices.AsyncStateMachineAttribute>()?.StateMachineType;
            return state?.GetMethod("MoveNext", Declared) is { } move && TouchesRaw(move, seen);
        }
        return owner.GetMethods(Declared).Where(m => !m.IsPrivate && Carrier(m.ReturnType, raw) && TouchesRaw(m, new()))
            .Select(m => m.Name).ToArray();
    }

    [Fact]
    public void PlantedRawCarriersAreRejectedAndMaterializedValuesRemainAllowed()
    {
        // Compile real IL; the same production guard must catch each planted escape, including generated bodies.
        const string source = """
            using System; using System.Collections.Generic; using System.Threading.Tasks;
            public interface IFacts { }
            public class Box { public object Value = null!; }
            public sealed class Facade {
                private sealed class Raw : IFacts { }
                private readonly Raw _model = new();
                internal IFacts Direct() => _model;
                internal object Object() => _model;
                internal Task<IFacts> Task() => System.Threading.Tasks.Task.FromResult<IFacts>(_model);
                internal async Task<IFacts> Async() { await System.Threading.Tasks.Task.Yield(); return _model; }
                internal ValueTask<IFacts> ValueTask() => new(_model);
                internal Func<IFacts> Delegate() => () => _model;
                internal IReadOnlyList<IFacts> Collection() => new IFacts[] { _model };
                internal Box Carrier() => new Box { Value = _model };
                private object Hidden() => _model;
                internal object Helper() => Hidden();
                internal T Generic<T>() where T : class => (T)(object)_model;
                internal Task<int> SafeScalar() => System.Threading.Tasks.Task.FromResult(_model.GetHashCode());
                internal string SafeDto() => _model.GetType().Name;
                internal Task<IFacts?> SafeEmpty() => System.Threading.Tasks.Task.FromResult<IFacts?>(null);
            }
            """;
        var references = ((string)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")!).Split(Path.PathSeparator)
            .Select(p => Microsoft.CodeAnalysis.MetadataReference.CreateFromFile(p));
        var compilation = Microsoft.CodeAnalysis.CSharp.CSharpCompilation.Create("PlantedSeerrEscape",
            new[] { Microsoft.CodeAnalysis.CSharp.CSharpSyntaxTree.ParseText(source) }, references,
            new Microsoft.CodeAnalysis.CSharp.CSharpCompilationOptions(Microsoft.CodeAnalysis.OutputKind.DynamicallyLinkedLibrary));
        using var bytes = new MemoryStream();
        var emitted = compilation.Emit(bytes);
        Assert.True(emitted.Success, string.Join("\n", emitted.Diagnostics));
        var assembly = Assembly.Load(bytes.ToArray());
        var owner = assembly.GetType("Facade")!;
        var raw = new HashSet<Type> { owner.GetNestedType("Raw", BindingFlags.NonPublic)! };
        Assert.Equal(new[] { "Async", "Carrier", "Collection", "Delegate", "Direct", "Generic", "Helper", "Object", "Task", "ValueTask" },
            RawEscapes(owner, raw, raw).OrderBy(n => n, StringComparer.Ordinal));
    }

}
