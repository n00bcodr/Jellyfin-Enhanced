using System.Reflection;
using System.Reflection.Emit;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Secrets;
using Xunit.Abstractions;
using MediaBrowser.Model.Configuration;

namespace JE.Tests;

/// <summary>Inventories input stores from production IL, including compiler-generated callbacks, rather than source names.</summary>
public class IntegrationEvidenceWriterArchitectureTests(ITestOutputHelper output)
{
    private const BindingFlags All = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static | BindingFlags.Instance | BindingFlags.DeclaredOnly;
    private static readonly Dictionary<short, OpCode> Codes = typeof(OpCodes).GetFields(BindingFlags.Public | BindingFlags.Static)
        .Select(f => (OpCode)f.GetValue(null)!).ToDictionary(c => c.Value);
    private static readonly HashSet<string> Inputs = new(StringComparer.Ordinal)
        { nameof(PluginConfiguration.TMDB_API_KEY), nameof(PluginConfiguration.JellyseerrApiKey), nameof(PluginConfiguration.ArrRequestBackend), nameof(PluginConfiguration.JellyseerrEnabled), nameof(PluginConfiguration.JellyseerrUrls) };

    private sealed record Instruction(OpCode Op, MemberInfo? Member);
    private static Instruction[] Read(MethodBase method)
    {
        var il = method.GetMethodBody()?.GetILAsByteArray() ?? [];
        var result = new List<Instruction>();
        for (var i = 0; i < il.Length;)
        {
            var op = il[i] == 0xfe ? Codes[(short)(0xfe00 | il[i + 1])] : Codes[il[i]];
            i += op.Size;
            var size = op.OperandType switch
            {
                OperandType.InlineNone => 0,
                OperandType.ShortInlineBrTarget or OperandType.ShortInlineI or OperandType.ShortInlineVar => 1,
                OperandType.InlineVar => 2,
                OperandType.InlineI8 or OperandType.InlineR => 8,
                OperandType.InlineSwitch => 4 + 4 * BitConverter.ToInt32(il, i),
                _ => 4,
            };
            MemberInfo? member = null;
            if (op.OperandType is OperandType.InlineMethod or OperandType.InlineField or OperandType.InlineTok)
                member = method.Module.ResolveMember(BitConverter.ToInt32(il, i), method.DeclaringType?.GetGenericArguments(), method.IsGenericMethod ? method.GetGenericArguments() : null);
            result.Add(new(op, member));
            i += size;
        }
        return result.ToArray();
    }

    private static bool InputStore(Instruction instruction)
    {
        if (instruction.Member is MethodInfo { Name: "SetValue", DeclaringType: var reflected } && reflected == typeof(PropertyInfo)) return true;
        if (instruction.Member is MethodInfo { Name: "set_MetadataCountryCode", DeclaringType: var country } && country == typeof(ServerConfiguration)) return true;
        if (instruction.Member is MethodInfo setter && setter.DeclaringType == typeof(PluginConfiguration) && setter.Name.StartsWith("set_"))
            return Inputs.Contains(setter.Name[4..]);
        if (instruction.Op != OpCodes.Stfld && instruction.Op != OpCodes.Stsfld && instruction.Op != OpCodes.Ldflda && instruction.Op != OpCodes.Ldsflda) return false;
        return instruction.Member is FieldInfo f && ((f.DeclaringType == typeof(SecretsStore) && f.Name == "_values")
            || (f.DeclaringType == typeof(PluginConfiguration) && Inputs.Any(n => f.Name == "<" + n + ">k__BackingField")));
    }

    private static (string[] Failures, string[] Inventory) Audit(params Assembly[] assemblies)
    {
        var methods = assemblies.SelectMany(a => a.GetTypes()).SelectMany(t => t.GetMethods(All).Cast<MethodBase>().Concat(t.GetConstructors(All))).ToArray();
        var bodies = methods.ToDictionary(m => m, Read);
        var incoming = methods.ToDictionary(m => m, _ => new List<(MethodBase Caller, int Offset)>());
        var protectedLoads = new HashSet<(MethodBase Caller, int Offset)>();
        // A forwarding Action wrapper is a boundary only while its IL actually forwards to Advance.
        var boundaries = bodies.Where(pair => pair.Key.GetParameters().Any(p => p.ParameterType == typeof(Action))
            && pair.Value.Any(x => x.Member is MethodBase { Name: "Advance", DeclaringType: var owner } && owner == typeof(EvidenceRevision))
            && !pair.Value.Any(x => x.Member is MethodBase { Name: "Invoke", DeclaringType: var action } && action == typeof(Action)))
            .Select(pair => pair.Key).ToHashSet();
        foreach (var (caller, body) in bodies)
        {
            for (var i = 0; i < body.Length; i++)
            {
                if (body[i].Member is not MethodBase callee) continue;
                if (incoming.TryGetValue(callee, out var callers)) callers.Add((caller, i));
                if (callee.DeclaringType == typeof(EvidenceRevision) && callee.Name == "Advance"
                    || boundaries.Contains(callee))
                {
                    // The Action argument is an emitted function pointer, also for local functions/cached static lambdas.
                    for (var offset = i - 1; offset >= Math.Max(0, i - 12); offset--)
                    {
                        if (body[offset].Op != OpCodes.Ldftn && body[offset].Op != OpCodes.Ldvirtftn) continue;
                        protectedLoads.Add((caller, offset));
                        break;
                    }
                }
            }
        }
        bool Protected(MethodBase method, HashSet<MethodBase> path)
        {
            if (!path.Add(method)) return false; // a call cycle alone proves no writer boundary
            if (!incoming.TryGetValue(method, out var parents) || parents.Count == 0) return false;
            return parents.All(p => protectedLoads.Contains(p) || Protected(p.Caller, new(path)));
        }
        var failures = new List<string>();
        var inventory = new List<string>();
        foreach (var (method, body) in bodies)
        {
            // Auto-setter bodies are storage implementations: every caller of the setter is audited instead.
            if (method.DeclaringType == typeof(PluginConfiguration) && method.Name.StartsWith("set_") && Inputs.Contains(method.Name[4..])) continue;
            foreach (var store in body.Where(InputStore).Where(store => store.Member?.DeclaringType != typeof(PropertyInfo)
                || (method.DeclaringType != typeof(PrivacyValues) && method.DeclaringType != typeof(PrivacyAnswerGraph))))
            {
                var identity = method.DeclaringType!.FullName + "." + method.Name + " -> " + store.Member!.Name;
                inventory.Add(identity);
                var construction = method.IsConstructor && (method.DeclaringType == typeof(PluginConfiguration) || method.DeclaringType == typeof(SecretsStore));
                if (!construction && !(method.DeclaringType == typeof(EvidenceRevision) && method.Name == "AssignUnrelatedValue") && !Protected(method, new())) failures.Add(identity);
            }
        }
        return (failures.ToArray(), inventory.ToArray());
    }

    [Fact]
    public void EveryEvidenceInputStoreIsConstructedOrOwnedByAdvance()
    {
        var audit = Audit(typeof(PrivacyResponseGuard).Assembly);
        output.WriteLine("Evidence input IL stores: {0}", audit.Inventory.Length);
        foreach (var entry in audit.Inventory.Order()) output.WriteLine(entry);
        Assert.NotEmpty(audit.Inventory);
        Assert.Empty(audit.Failures);
    }

    [Theory]
    [InlineData("TMDB_API_KEY")] [InlineData("JellyseerrApiKey")] [InlineData("ArrRequestBackend")] [InlineData("JellyseerrEnabled")] [InlineData("JellyseerrUrls")]
    public void UnrelatedReflectionLeafCannotAssignAnyEvidenceInput(string name)
    {
        var assign = typeof(EvidenceRevision).GetMethod("AssignUnrelatedValue", BindingFlags.NonPublic | BindingFlags.Static)!;
        var property = typeof(PluginConfiguration).GetProperty(name)!;
        var value = property.PropertyType == typeof(bool) ? (object)true : "changed";
        var failure = Assert.Throws<TargetInvocationException>(() => assign.Invoke(null, [new PluginConfiguration(), property, value]));
        Assert.IsType<InvalidOperationException>(failure.InnerException);
    }

    [Fact]
    public void APlantedWriterOutsideAdvanceFailsTheSameArchitectureAssertion()
    {
        var assembly = AssemblyBuilder.DefineDynamicAssembly(new AssemblyName("PlantedEvidenceWriter"), AssemblyBuilderAccess.Run);
        var type = assembly.DefineDynamicModule("writer").DefineType("UnownedWriter", TypeAttributes.Public);
        var method = type.DefineMethod("ChangeBackend", MethodAttributes.Public | MethodAttributes.Static, typeof(void), [typeof(PluginConfiguration)]);
        var il = method.GetILGenerator();
        il.Emit(OpCodes.Ldarg_0); il.Emit(OpCodes.Ldstr, "je");
        il.Emit(OpCodes.Callvirt, typeof(PluginConfiguration).GetProperty(nameof(PluginConfiguration.ArrRequestBackend))!.SetMethod!);
        il.Emit(OpCodes.Ret);
        type.CreateType();
        var audit = Audit(typeof(PrivacyResponseGuard).Assembly, assembly);
        Assert.Contains(audit.Failures, f => f.Contains("UnownedWriter.ChangeBackend"));
        Assert.ThrowsAny<Xunit.Sdk.XunitException>(() => Assert.Empty(audit.Failures));
    }
}
