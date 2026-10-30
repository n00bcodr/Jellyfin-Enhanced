using System.Reflection;
using System.Reflection.Emit;
using System.Runtime.Loader;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;

namespace JE.Tests;

/// <summary>
/// A module instrumented the way coverlet instruments the plugin, for IntegrationLockOrderArchitectureTests: the tracker
/// type it adds (Coverlet.Core.Instrumentation.Tracker.&lt;assembly name&gt;_&lt;guid&gt;, a static class with HitsArray and
/// RecordHit(int)) and bodies that call it, plus tracker-like types and calls that are not probes. C# can't name such a
/// type, so the module is emitted (PersistedAssemblyBuilder), saved and loaded; its bodies are only read, never run.
/// </summary>
internal static class CoverageProbeFixture
{
    private const string Name = "CoverageProbes";
    private const string TrackerNamespace = "Coverlet.Core.Instrumentation.Tracker";

    /// <summary>The tracker, as coverlet adds it.</summary>
    internal const string Tracker = TrackerNamespace + "." + Name + "_6f1c2a4e-3b7d-4e59-9a80-1d2c3b4a5f60";

    /// <summary>Named like the tracker, without the hit counters.</summary>
    internal const string Uncounted = TrackerNamespace + "." + Name + "_0b9e8d7c-6a5f-4e3d-8c2b-1a0f9e8d7c6b";

    /// <summary>The tracker's shape, named for another assembly.</summary>
    internal const string Foreign = TrackerNamespace + ".OtherAssembly_4d3c2b1a-0f9e-4d8c-b7a6-5f4e3d2c1b0a";

    private static readonly Assembly Built = Build();

    internal static Module Module => Built.ManifestModule;

    internal static Type[] Types => Built.GetTypes();

    internal static MethodBase Planted(string name) => Built.GetType("JE.CoverageProbes.Planted")!.GetMethod(name, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static)!;

    private static Assembly Build()
    {
        var builder = new PersistedAssemblyBuilder(new AssemblyName(Name), typeof(object).Assembly);
        var module = builder.DefineDynamicModule(Name);
        var configuration = typeof(Jellyfin.Plugin.JellyfinEnhanced.JellyfinEnhanced).GetField("ConfigurationLock", BindingFlags.NonPublic | BindingFlags.Static)!;
        var enter = typeof(Monitor).GetMethod(nameof(Monitor.Enter), new[] { typeof(object) })!;
        var exit = typeof(Monitor).GetMethod(nameof(Monitor.Exit), new[] { typeof(object) })!;
        void Lock(ILGenerator il)
        {
            il.Emit(OpCodes.Ldsfld, configuration);
            il.Emit(OpCodes.Call, enter);
            il.Emit(OpCodes.Ldsfld, configuration);
            il.Emit(OpCodes.Call, exit);
        }

        MethodBuilder Static(TypeBuilder type, string name, Type returns, Type[] parameters, Action<ILGenerator> body)
        {
            var method = type.DefineMethod(name, MethodAttributes.Public | MethodAttributes.Static | MethodAttributes.HideBySig, returns, parameters);
            var il = method.GetILGenerator();
            body(il);
            il.Emit(OpCodes.Ret);
            return method;
        }

        // A static class with the tracker's counters (or not), and its RecordHit(int): empty like coverlet's, or waiting.
        TypeBuilder TrackerType(string fullName, bool counters, bool waits, out MethodBuilder recordHit, out FieldBuilder? hits)
        {
            var type = module.DefineType(fullName, TypeAttributes.Public | TypeAttributes.Abstract | TypeAttributes.Sealed | TypeAttributes.BeforeFieldInit);
            hits = counters ? type.DefineField("HitsArray", typeof(int[]), FieldAttributes.Public | FieldAttributes.Static) : null;
            recordHit = Static(type, "RecordHit", typeof(void), new[] { typeof(int) }, il => { if (waits) Lock(il); });
            return type;
        }

        var tracker = TrackerType(Tracker, counters: true, waits: false, out var probe, out var counters);
        var acquire = Static(tracker, "Acquire", typeof(void), new[] { typeof(int) }, Lock);
        var twoArguments = Static(tracker, "RecordHit", typeof(void), new[] { typeof(int), typeof(int) }, Lock);
        var uncounted = TrackerType(Uncounted, counters: false, waits: true, out var uncountedHit, out _);
        var foreign = TrackerType(Foreign, counters: true, waits: true, out var foreignHit, out _);

        var planted = module.DefineType("JE.CoverageProbes.Planted", TypeAttributes.Public | TypeAttributes.Abstract | TypeAttributes.Sealed);
        var save = Static(planted, "Save", typeof(int), Type.EmptyTypes, il => { Lock(il); il.Emit(OpCodes.Ldc_I4_1); });
        Static(planted, "Plain", typeof(int), Type.EmptyTypes, il => il.Emit(OpCodes.Call, save));
        // Hit indexes as coverlet writes them: ldc.i4, and the short forms its macro optimisation leaves for small ones.
        var probed = Static(planted, "Probed", typeof(int), Type.EmptyTypes, il =>
        {
            il.Emit(OpCodes.Ldc_I4, 1000);
            il.Emit(OpCodes.Call, probe);
            il.Emit(OpCodes.Ldc_I4_S, (sbyte)100);
            il.Emit(OpCodes.Call, probe);
            il.Emit(OpCodes.Ldc_I4_3);
            il.Emit(OpCodes.Call, probe);
            il.Emit(OpCodes.Call, save);
        });

        // using (SeerrFacts.CacheMutation()) { body }
        var cacheMutation = typeof(SeerrFacts).GetMethod("CacheMutation", BindingFlags.NonPublic | BindingFlags.Static)!;
        var dispose = typeof(IDisposable).GetMethod(nameof(IDisposable.Dispose))!;
        void UnderMonitor(string name, Action<ILGenerator> body) => Static(planted, name, typeof(void), Type.EmptyTypes, il =>
        {
            var held = il.DeclareLocal(cacheMutation.ReturnType);
            il.Emit(OpCodes.Call, cacheMutation);
            il.Emit(OpCodes.Stloc, held);
            il.BeginExceptionBlock();
            body(il);
            il.BeginFinallyBlock();
            il.Emit(OpCodes.Ldloc, held);
            il.Emit(OpCodes.Callvirt, dispose);
            il.EndExceptionBlock();
        });

        void Call(ILGenerator il, MethodInfo method, params int[] hits)
        {
            foreach (var hit in hits) il.Emit(OpCodes.Ldc_I4, hit);
            il.Emit(OpCodes.Call, method);
        }

        UnderMonitor("Mutation", il =>
        {
            Call(il, probe, 1001);
            il.Emit(OpCodes.Call, probed);
            il.Emit(OpCodes.Pop);
        });
        UnderMonitor("WithoutHitCounters", il => Call(il, uncountedHit, 7));
        UnderMonitor("AnotherAssemblysTracker", il => Call(il, foreignHit, 7));
        UnderMonitor("AnotherTrackerMethod", il => Call(il, acquire, 7));
        UnderMonitor("AnotherSignature", il => Call(il, twoArguments, 7, 8));
        // The real probe, its index loaded from a field instead of a constant.
        UnderMonitor("Unconstant", il =>
        {
            il.Emit(OpCodes.Ldsfld, counters!);
            il.Emit(OpCodes.Ldlen);
            il.Emit(OpCodes.Conv_I4);
            il.Emit(OpCodes.Call, probe);
        });

        tracker.CreateType();
        uncounted.CreateType();
        foreign.CreateType();
        planted.CreateType();
        var image = new MemoryStream();
        builder.Save(image);
        image.Position = 0;
        return new AssemblyLoadContext(Name).LoadFromStream(image);
    }
}
