using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using System.Reflection.PortableExecutable;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Automation;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Users;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;

namespace JE.Tests;

/// <summary>
/// 4a review round 18 (D53): the classifier's composition, tested as a GENERATED CROSS-PRODUCT instead of hand-picked
/// probes. Rounds 10–17 each added a rule (call-site kinds, initializers, framework slots, delegate provenance) and the
/// round-18 findings were all places where one rule didn't apply inside another (a constrained call to a slot .NET
/// declares, a slot target's static constructor, a delegate field stored through a helper, an array filled by a helper).
/// Each cell below is one combination of
/// <list type="bullet">
/// <item><description>how control is transferred: call, callvirt, constrained call, ldftn/ldvirtftn (a method pointer made
/// and invoked), a delegate's Invoke (the delegate's target is the method), newobj;</description></item>
/// <item><description>what kind of method runs: a method of the code read, an override, an explicit interface
/// implementation, an implementation of a slot .NET declares (IProgress&lt;int&gt;.Report), a static abstract member
/// declared in the code read, a static abstract member .NET declares (IParsable&lt;T&gt;.Parse);</description></item>
/// <item><description>where its user change is: its body, its type's static constructor, its module's initializer;</description></item>
/// <item><description>where the delegate that runs it comes from: none (the action transfers directly), a field (set
/// directly, through an identity helper, through a local after an unrelated delegate was made, through another object's
/// constructor after an unrelated delegate was made), a parameter, a local, a return value, an array filled in place, an
/// array filled by a helper, a cast through object, a collection.</description></item>
/// </list>
/// The FULL product of the combinations C# can write (<see cref="FormOf"/> says which transfer can reach which kind of
/// method; a delegate's Invoke has no "none" source), not pairwise. Every cell is compiled for real (Release), its IL is
/// checked to contain the transfer it stands for, it is scanned, and it is RUN: a fresh load of its assemblies, the
/// controller built and the action invoked, which disables the person exactly once (for a change in the body: none while
/// the controller is built). The expected key comes from the table: <see cref="JellyfinUserKey.User"/> (the action has a
/// userId; an unresolved callback is the request's person too), None for the stated-limit cells (none at present).
/// Three groups, one per place of the change, each scanned once: a slot .NET declares is one node for every
/// implementation the code read has, so cells sharing it must share where their change is, or one cell's body change
/// would hide another's missed initializer.
/// </summary>
public class IntegrationJellyfinUserMatrixTests : IClassFixture<IntegrationJellyfinUserMatrixTests.Matrix>
{
    /// <summary>How control reaches the method.</summary>
    public enum Transfer { Call, Callvirt, Constrained, Pointer, Invoke, Newobj }

    /// <summary>What kind of method runs. Round 19: derived from the resolution rules (ECMA-335 II.10.3, II.12.2) the
    /// classifier implements, each over the complete ancestry: a type's own method, MethodImpl (explicit), a base's override,
    /// an interface implemented through a method INHERITED from a base that doesn't declare it (same assembly, across
    /// assemblies, a slot .NET declares), a slot .NET declares reached through a FRAMEWORK INTERMEDIATE base (MemoryStream
    /// between Stream and the override), an abstract chain through a framework type (a code-read abstract re-declaration of
    /// TextWriter.Write), an interface RE-IMPLEMENTED by a derived type (code read, .NET), generic VARIANCE (code read,
    /// .NET), a default interface method, static abstract members (code read, .NET).</summary>
    public enum Target
    {
        Method, Override, Explicit, FrameworkSlot, StaticAbstract, FrameworkStaticAbstract,
        Inherited, InheritedAcrossAssemblies, FrameworkInherited, FrameworkIntermediate, FrameworkAbstractChain, Reimplementation, FrameworkReimplementation,
        Variance, FrameworkVariance, DefaultImplementation,
    }

    /// <summary>Where the method's user change is.</summary>
    public enum Effect { Body, TypeInitializer, ModuleInitializer }

    /// <summary>Where the delegate that runs it comes from. Round 19: the recursion shapes too (each a monotone fixed point
    /// in the classifier, never cut): returned through self recursion, mutual recursion, an argument rotation (3-cycle
    /// permutation), a chain deeper than two; stored in a field from a parameter that rotates through recursive calls, and
    /// through a chain deeper than two.</summary>
    public enum Source
    {
        Direct, Field, FieldThroughIdentity, FieldAfterDecoy, FieldThroughConstructor, Parameter, Local, Returned, ArrayInPlace, ArrayByHelper, ObjectCast, Collection,
        Recursive, Mutual, Rotation, RotationStored, DeepReturned, DeepStored,
    }

    // The round-18 table (kept whole: 810 visible cells, 22 handed in).
    private static readonly HashSet<Target> Round18Targets = new() { Target.Method, Target.Override, Target.Explicit, Target.FrameworkSlot, Target.StaticAbstract, Target.FrameworkStaticAbstract };

    private static readonly HashSet<Source> Round18Sources = Enum.GetValues<Source>().Where(s => s <= Source.Collection).ToHashSet();

    /// <summary>Where a delegate handed in from outside the code read enters: the controller's constructor (dependency
    /// injection) or the action ([FromServices]).</summary>
    public enum Entry { Constructor, Action }

    /// <summary>One cell of the matrix: a visible delegate (or none), or (Entry set) one handed in from outside.</summary>
    public sealed record Cell(int Id, Transfer Transfer, Target Target, Effect Effect, Source Source, Entry? Entry = null)
    {
        public string Name => "Cell" + Id;

        public string Controller => Name + "Controller";

        public string Group => Entry == null ? Effect.ToString() : "HandedIn";

        public override string ToString() => Entry == null ? $"{Name} {Transfer}/{Target}/{Effect}/{Source}" : $"{Name} handed in/{Entry}/{Source}";
    }

    // The stated-limit cells ("Transfer/Target/Effect/Source"), pinned as None (the runtime still disables the person).
    private static readonly HashSet<string> StatedLimits = new(StringComparer.Ordinal);

    private readonly Matrix _matrix;

    public IntegrationJellyfinUserMatrixTests(Matrix matrix) => _matrix = matrix;

    public static IEnumerable<object[]> Cells() => Matrix.All.Where(c => c.Entry == null).Select(c => new object[] { c.Id, c.Transfer, c.Target, c.Effect, c.Source });

    public static IEnumerable<object[]> HandedInCells() => Matrix.All.Where(c => c.Entry != null).Select(c => new object[] { c.Id, c.Entry!.Value, c.Source });

    [Theory]
    [MemberData(nameof(Cells))]
    public void EveryCellIsBracketedAndReallyDisablesThePersonOnce(int id, Transfer transfer, Target target, Effect effect, Source source)
    {
        var cell = Matrix.All[id];
        Assert.Equal((transfer, target, effect, source), (cell.Transfer, cell.Target, cell.Effect, cell.Source));
        var evidence = FormOf(transfer, target)!.Evidence;
        Assert.True(_matrix.Exercises(cell, evidence), cell + ": its IL has no " + evidence);
        var action = _matrix.Scanned(cell);
        var expected = StatedLimits.Contains($"{transfer}/{target}/{effect}/{source}") ? JellyfinUserKey.None : JellyfinUserKey.User;
        Assert.True(expected == action.Key, $"{cell}: scan {action.Key} (expected {expected}) why={action.Why} via={string.Join(" > ", action.Via ?? Array.Empty<string>())}");
        // Precisely: a visible delegate is followed to the change itself, except where the table says its path is opaque
        // (an array a helper fills, a collection: unknown, an unresolved callback, fail closed).
        if (expected != JellyfinUserKey.None)
        {
            var why = source is Source.ArrayByHelper or Source.Collection ? "unresolved callback " : "reaches IUserManager.UpdatePolicyAsync";
            Assert.True(action.Why?.StartsWith(why, StringComparison.Ordinal) == true, $"{cell}: why={action.Why} (expected {why}…)");
        }

        var (construction, total) = _matrix.Run(cell);
        Assert.True(total == 1, $"{cell}: the run disabled the person {total} times");
        if (effect == Effect.Body) Assert.True(construction == 0, $"{cell}: building the controller disabled the person");
    }

    // A delegate handed in from outside the code read (the closure the run hands in disables the person): whatever path it
    // takes to its invocation, the reading can't see its target, so the action is bracketed for the request's person
    // (an unresolved callback, round 11).
    [Theory]
    [MemberData(nameof(HandedInCells))]
    public void EveryHandedInCellIsAnUnresolvedCallbackAndReallyDisablesThePersonOnce(int id, Entry entry, Source source)
    {
        var cell = Matrix.All[id];
        Assert.Equal((entry, source), (cell.Entry, cell.Source));
        var action = _matrix.Scanned(cell);
        Assert.True(action.Key == JellyfinUserKey.User, $"{cell}: scan {action.Key} why={action.Why}");
        Assert.StartsWith("unresolved callback ", action.Why, StringComparison.Ordinal);
        var (construction, total) = _matrix.Run(cell);
        Assert.Equal((0, 1), (construction, total));
    }

    // The table is the full product of what C# can write: every transfer/kind pair FormOf allows, with every place of the
    // change and every source (a delegate's Invoke has no "none" source: that is the method pointer row).
    [Fact]
    public void TheMatrixIsTheFullProductOfTheTable()
    {
        var pairs = Enum.GetValues<Transfer>().SelectMany(t => Enum.GetValues<Target>().Where(k => FormOf(t, k) != null).Select(k => (t, k))).ToList();
        var expected = pairs.Sum(p => Enum.GetValues<Effect>().Length * Enum.GetValues<Source>().Count(s => s != Source.Direct || p.t != Transfer.Invoke));
        Assert.Equal(expected, Matrix.All.Count(c => c.Entry == null));
        Assert.Equal(Enum.GetValues<Entry>().Length * (Enum.GetValues<Source>().Length - 1), Matrix.All.Count(c => c.Entry != null));
        Assert.Equal(Matrix.All.Count, Matrix.All.Select(c => (c.Transfer, c.Target, c.Effect, c.Source, c.Entry)).Distinct().Count());
        // Each transfer reaches at least one kind; each kind is reached by at least two transfers.
        Assert.All(Enum.GetValues<Transfer>(), t => Assert.Contains(pairs, p => p.t == t));
        Assert.All(Enum.GetValues<Target>(), k => Assert.True(pairs.Count(p => p.k == k) >= 2, k + " is reached by fewer than two transfers"));
    }

    // Round 19: the round-18 cells are all still here (the same 23 transfer/kind pairs, three places, the twelve sources).
    [Fact]
    public void TheRound18CellsAreKept()
    {
        Assert.Equal(810, Matrix.All.Count(c => c.Entry == null && Round18Targets.Contains(c.Target) && Round18Sources.Contains(c.Source)));
        Assert.Equal(22, Matrix.All.Count(c => c.Entry != null && Round18Sources.Contains(c.Source)));
        Assert.Equal(23, Enum.GetValues<Transfer>().Sum(t => Round18Targets.Count(k => FormOf(t, k) != null)));
    }

    // ------------------------------------------------------------------ the table

    /// <summary>
    /// How a cell is written: declarations for the base assembly (interfaces, base classes), the target assembly (the type
    /// whose method runs, named Target: {CCTOR} and {BODY} are where its change goes) and the cell assembly (helpers); the
    /// statement that transfers control (null for a delegate's Invoke), or the delegate whose target is the method (its
    /// type, the expression making it, the arguments it is invoked with); the IL that proves the transfer is there.
    /// </summary>
    public sealed record Form(string Base, string Targets, string Helpers, string? Run, string Evidence, string DelegateType = "Action", string? Group = null, string Arguments = "()");

    private const string StaticTarget = "public static class Target { {CCTOR} public static void Run() { {BODY} } }";
    private const string ShapeBase = "public class Shape { public virtual void Run() { } }";
    private const string Override = "public sealed class Target : Shape { {CCTOR} public override void Run() { {BODY} } }";
    private const string Face = "public interface IFace { void Run(); }";
    private const string ExplicitTarget = "public struct Target : IFace { {CCTOR} void IFace.Run() { {BODY} } }";
    private const string ProgressTarget = "public struct Target : IProgress<int> { {CCTOR} public void Report(int value) { {BODY} } }";
    private const string StaticFace = "public interface IStatic { static abstract void Run(); }";
    private const string StaticTargetImpl = "public struct Target : IStatic { {CCTOR} public static void Run() { {BODY} } }";
    private const string ParsableTarget = "public struct Target : IParsable<Target> { {CCTOR} public static Target Parse(string s, IFormatProvider? provider) { {BODY} return default; } public static bool TryParse(string? s, IFormatProvider? provider, out Target result) { result = default; return false; } }";

    // Round 19: the resolution rules' kinds. Target is always the type whose method runs (its {CCTOR} and {BODY}).
    private const string InheritedTarget = "public class Target { {CCTOR} public void Run() { {BODY} } } public sealed class Child : Target, IFace { }";
    private const string AcrossBase = "public interface IFace { void Run(); } public class Target { {CCTOR} public void Run() { {BODY} } }";
    private const string AcrossChild = "public sealed class Child : Target, IFace { }";
    private const string FormatTarget = "public class Target { {CCTOR} public object? GetFormat(Type? formatType) { {BODY} return null; } } public sealed class Child : Target, IFormatProvider { }";
    private const string StreamTarget = "public sealed class Target : System.IO.MemoryStream { {CCTOR} public override void Write(byte[] buffer, int offset, int count) { {BODY} } }";
    private const string WriterTarget = "public abstract class Mid : System.IO.TextWriter { public abstract override void Write(char value); } public sealed class Target : Mid { {CCTOR} public override System.Text.Encoding Encoding => System.Text.Encoding.UTF8; public override void Write(char value) { {BODY} } }";
    private const string ReimplementedTarget = "public class Plain : IFace { public void Run() { } } public sealed class Target : Plain, IFace { {CCTOR} void IFace.Run() { {BODY} } }";
    private const string ComparableTarget = "public class Plain : IComparable<int> { public int CompareTo(int other) => 0; } public sealed class Target : Plain, IComparable<int> { {CCTOR} int IComparable<int>.CompareTo(int other) { {BODY} return 0; } }";
    private const string InFace = "public interface IIn<in T> { void Run(T value); }";
    private const string VariantTarget = "public sealed class Target : IIn<object> { {CCTOR} public void Run(object value) { {BODY} } }";
    private const string ComparerTarget = "public sealed class Target : IComparer<object> { {CCTOR} public int Compare(object? x, object? y) { {BODY} return 0; } }";
    private const string DefaultTarget = "public interface Target : IFace { {CCTOR} void IFace.Run() { {BODY} } } public sealed class Child : Target { }";
    private const string CallFace = "public static class Helpers { public static void Call<T>(T t) where T : IFace => t.Run(); }";

    // Which transfer can reach which kind of method in C#; null: it can't (a plain call reaches an override only as a base
    // call, an explicit implementation or a slot only through dispatch, a static abstract member only constrained; newobj
    // runs a constructor; C# calls an override through a class-constrained type parameter as box + callvirt, never
    // constrained).
    public static Form? FormOf(Transfer transfer, Target target) => (transfer, target) switch
    {
        (Transfer.Call, Target.Method) => new("", StaticTarget, "", "Target.Run();", "call Target::Run"),
        (Transfer.Callvirt, Target.Method) => new("", "public sealed class Target { {CCTOR} public void Run() { {BODY} } }", "", "var t = new Target(); t.Run();", "callvirt Target::Run"),
        (Transfer.Pointer, Target.Method) => new("", StaticTarget, "", "Action g = Target.Run; g();", "ldftn Target::Run"),
        (Transfer.Invoke, Target.Method) => new("", StaticTarget, "", null, "ldftn Target::Run", Group: "new Action(Target.Run)"),
        (Transfer.Newobj, Target.Method) => new("", "public sealed class Target { {CCTOR} public Target() { {BODY} } }", "", "_ = new Target();", "newobj Target::.ctor"),

        (Transfer.Call, Target.Override) => new(ShapeBase, "public class Target : Shape { {CCTOR} public override void Run() { {BODY} } } public sealed class Leaf : Target { public override void Run() { } public void Up() => base.Run(); }", "", "new Leaf().Up();", "call Target::Run"),
        (Transfer.Callvirt, Target.Override) => new(ShapeBase, Override, "", "Shape s = new Target(); s.Run();", "callvirt Shape::Run"),
        (Transfer.Pointer, Target.Override) => new(ShapeBase, Override, "", "Shape s = new Target(); Action g = s.Run; g();", "ldvirtftn Shape::Run"),
        (Transfer.Invoke, Target.Override) => new(ShapeBase, Override, "", null, "ldvirtftn Shape::Run", Group: "new Action(((Shape)new Target()).Run)"),

        (Transfer.Callvirt, Target.Explicit) => new(Face, ExplicitTarget, "", "IFace f = new Target(); f.Run();", "callvirt IFace::Run"),
        (Transfer.Constrained, Target.Explicit) => new(Face, ExplicitTarget, "public static class Helpers { public static void Call<T>(T t) where T : IFace => t.Run(); }", "Helpers.Call(new Target());", "constrained."),
        (Transfer.Pointer, Target.Explicit) => new(Face, ExplicitTarget, "", "IFace f = new Target(); Action g = f.Run; g();", "ldvirtftn IFace::Run"),
        (Transfer.Invoke, Target.Explicit) => new(Face, ExplicitTarget, "", null, "ldvirtftn IFace::Run", Group: "new Action(((IFace)new Target()).Run)"),

        (Transfer.Callvirt, Target.FrameworkSlot) => new("", ProgressTarget, "", "IProgress<int> p = new Target(); p.Report(0);", "callvirt IProgress`1::Report"),
        (Transfer.Constrained, Target.FrameworkSlot) => new("", ProgressTarget, "public static class Helpers { public static void Call<T>(T t) where T : IProgress<int> => t.Report(0); }", "Helpers.Call(new Target());", "constrained."),
        (Transfer.Pointer, Target.FrameworkSlot) => new("", ProgressTarget, "", "IProgress<int> p = new Target(); Action<int> g = p.Report; g(0);", "ldvirtftn IProgress`1::Report"),
        (Transfer.Invoke, Target.FrameworkSlot) => new("", ProgressTarget, "", null, "ldvirtftn IProgress`1::Report", "Action<int>", "new Action<int>(((IProgress<int>)new Target()).Report)", "(0)"),

        (Transfer.Constrained, Target.StaticAbstract) => new(StaticFace, StaticTargetImpl, "public static class Helpers { public static void Call<T>() where T : IStatic => T.Run(); }", "Helpers.Call<Target>();", "constrained."),
        (Transfer.Pointer, Target.StaticAbstract) => new(StaticFace, StaticTargetImpl, "public static class Helpers { public static void Point<T>() where T : IStatic { Action g = T.Run; g(); } }", "Helpers.Point<Target>();", "ldftn IStatic::Run"),
        (Transfer.Invoke, Target.StaticAbstract) => new(StaticFace, StaticTargetImpl, "public static class Helpers { public static Action Group<T>() where T : IStatic => T.Run; }", null, "ldftn IStatic::Run", Group: "Helpers.Group<Target>()"),

        (Transfer.Constrained, Target.FrameworkStaticAbstract) => new("", ParsableTarget, "public static class Helpers { public static T Call<T>() where T : IParsable<T> => T.Parse(\"\", null); }", "Helpers.Call<Target>();", "constrained."),
        (Transfer.Pointer, Target.FrameworkStaticAbstract) => new("", ParsableTarget, "public static class Helpers { public static void Point<T>() where T : IParsable<T> { Func<string, IFormatProvider?, T> g = T.Parse; g(\"\", null); } }", "Helpers.Point<Target>();", "ldftn IParsable`1::Parse"),
        (Transfer.Invoke, Target.FrameworkStaticAbstract) => new("", ParsableTarget, "public static class Helpers { public static Func<string, IFormatProvider?, T> Group<T>() where T : IParsable<T> => T.Parse; }", null, "ldftn IParsable`1::Parse", "Func<string, IFormatProvider?, Target>", "Helpers.Group<Target>()", "(\"\", null)"),

        // Round 19 (4a-r19-1): an interface slot filled by a method a base class has without declaring the interface (C#
        // marks the base's method virtual in the same assembly; across assemblies it writes a stub in the derived type).
        (Transfer.Callvirt, Target.Inherited) => new(Face, InheritedTarget, "", "IFace f = new Child(); f.Run();", "callvirt IFace::Run"),
        (Transfer.Constrained, Target.Inherited) => new(Face, InheritedTarget, CallFace, "Helpers.Call(new Child());", "constrained."),
        (Transfer.Pointer, Target.Inherited) => new(Face, InheritedTarget, "", "IFace f = new Child(); Action g = f.Run; g();", "ldvirtftn IFace::Run"),
        (Transfer.Invoke, Target.Inherited) => new(Face, InheritedTarget, "", null, "ldvirtftn IFace::Run", Group: "new Action(((IFace)new Child()).Run)"),

        (Transfer.Callvirt, Target.InheritedAcrossAssemblies) => new(AcrossBase, AcrossChild, "", "IFace f = new Child(); f.Run();", "callvirt IFace::Run"),
        (Transfer.Constrained, Target.InheritedAcrossAssemblies) => new(AcrossBase, AcrossChild, CallFace, "Helpers.Call(new Child());", "constrained."),
        (Transfer.Pointer, Target.InheritedAcrossAssemblies) => new(AcrossBase, AcrossChild, "", "IFace f = new Child(); Action g = f.Run; g();", "ldvirtftn IFace::Run"),
        (Transfer.Invoke, Target.InheritedAcrossAssemblies) => new(AcrossBase, AcrossChild, "", null, "ldvirtftn IFace::Run", Group: "new Action(((IFace)new Child()).Run)"),

        (Transfer.Callvirt, Target.FrameworkInherited) => new("", FormatTarget, "", "IFormatProvider p = new Child(); p.GetFormat(null);", "callvirt IFormatProvider::GetFormat"),
        (Transfer.Constrained, Target.FrameworkInherited) => new("", FormatTarget, "public static class Helpers { public static void Call<T>(T t) where T : IFormatProvider { t.GetFormat(null); } }", "Helpers.Call(new Child());", "constrained."),
        (Transfer.Pointer, Target.FrameworkInherited) => new("", FormatTarget, "", "IFormatProvider p = new Child(); Func<Type?, object?> g = p.GetFormat; g(null);", "ldvirtftn IFormatProvider::GetFormat"),
        (Transfer.Invoke, Target.FrameworkInherited) => new("", FormatTarget, "", null, "ldvirtftn IFormatProvider::GetFormat", "Func<Type?, object?>", "new Func<Type?, object?>(((IFormatProvider)new Child()).GetFormat)", "(null)"),

        // Round 19 (4a-r19-2): a slot .NET declares (Stream.Write) overridden behind a framework intermediate base
        // (MemoryStream). Constrained: C# calls a class-constrained type parameter's override as box + callvirt.
        (Transfer.Callvirt, Target.FrameworkIntermediate) => new("", StreamTarget, "", "System.IO.Stream s = new Target(); s.Write(new byte[1], 0, 1);", "callvirt Stream::Write"),
        (Transfer.Pointer, Target.FrameworkIntermediate) => new("", StreamTarget, "", "System.IO.Stream s = new Target(); Action<byte[], int, int> g = s.Write; g(new byte[1], 0, 1);", "ldvirtftn Stream::Write"),
        (Transfer.Invoke, Target.FrameworkIntermediate) => new("", StreamTarget, "", null, "ldvirtftn Stream::Write", "Action<byte[], int, int>", "new Action<byte[], int, int>(((System.IO.Stream)new Target()).Write)", "(new byte[1], 0, 1)"),

        // An abstract chain through a framework type: TextWriter.Write(char) re-declared abstract in the code read.
        (Transfer.Callvirt, Target.FrameworkAbstractChain) => new("", WriterTarget, "", "System.IO.TextWriter w = new Target(); w.Write('x');", "callvirt TextWriter::Write"),
        (Transfer.Pointer, Target.FrameworkAbstractChain) => new("", WriterTarget, "", "System.IO.TextWriter w = new Target(); Action<char> g = w.Write; g('x');", "ldvirtftn TextWriter::Write"),
        (Transfer.Invoke, Target.FrameworkAbstractChain) => new("", WriterTarget, "", null, "ldvirtftn TextWriter::Write", "Action<char>", "new Action<char>(((System.IO.TextWriter)new Target()).Write)", "('x')"),

        // An interface re-implemented by a derived type (its base implements it too).
        (Transfer.Callvirt, Target.Reimplementation) => new(Face, ReimplementedTarget, "", "IFace f = new Target(); f.Run();", "callvirt IFace::Run"),
        (Transfer.Constrained, Target.Reimplementation) => new(Face, ReimplementedTarget, CallFace, "Helpers.Call(new Target());", "constrained."),
        (Transfer.Pointer, Target.Reimplementation) => new(Face, ReimplementedTarget, "", "IFace f = new Target(); Action g = f.Run; g();", "ldvirtftn IFace::Run"),
        (Transfer.Invoke, Target.Reimplementation) => new(Face, ReimplementedTarget, "", null, "ldvirtftn IFace::Run", Group: "new Action(((IFace)new Target()).Run)"),

        (Transfer.Callvirt, Target.FrameworkReimplementation) => new("", ComparableTarget, "", "IComparable<int> c = new Target(); c.CompareTo(0);", "callvirt IComparable`1::CompareTo"),
        (Transfer.Constrained, Target.FrameworkReimplementation) => new("", ComparableTarget, "public static class Helpers { public static void Call<T>(T t) where T : IComparable<int> { t.CompareTo(0); } }", "Helpers.Call(new Target());", "constrained."),
        (Transfer.Pointer, Target.FrameworkReimplementation) => new("", ComparableTarget, "", "IComparable<int> c = new Target(); Func<int, int> g = c.CompareTo; g(0);", "ldvirtftn IComparable`1::CompareTo"),
        (Transfer.Invoke, Target.FrameworkReimplementation) => new("", ComparableTarget, "", null, "ldvirtftn IComparable`1::CompareTo", "Func<int, int>", "new Func<int, int>(((IComparable<int>)new Target()).CompareTo)", "(0)"),

        // Generic variance: an implementation for object called through the interface for string (contravariance).
        (Transfer.Callvirt, Target.Variance) => new(InFace, VariantTarget, "", "IIn<string> f = new Target(); f.Run(\"\");", "callvirt IIn`1::Run"),
        (Transfer.Constrained, Target.Variance) => new(InFace, VariantTarget, "public static class Helpers { public static void Call<T>(T t) where T : IIn<string> => t.Run(\"\"); }", "Helpers.Call(new Target());", "constrained."),
        (Transfer.Pointer, Target.Variance) => new(InFace, VariantTarget, "", "IIn<string> f = new Target(); Action<string> g = f.Run; g(\"\");", "ldvirtftn IIn`1::Run"),
        (Transfer.Invoke, Target.Variance) => new(InFace, VariantTarget, "", null, "ldvirtftn IIn`1::Run", "Action<string>", "new Action<string>(((IIn<string>)new Target()).Run)", "(\"\")"),

        (Transfer.Callvirt, Target.FrameworkVariance) => new("", ComparerTarget, "", "IComparer<string> c = new Target(); c.Compare(\"\", \"\");", "callvirt IComparer`1::Compare"),
        (Transfer.Constrained, Target.FrameworkVariance) => new("", ComparerTarget, "public static class Helpers { public static void Call<T>(T t) where T : IComparer<string> { t.Compare(\"\", \"\"); } }", "Helpers.Call(new Target());", "constrained."),
        (Transfer.Pointer, Target.FrameworkVariance) => new("", ComparerTarget, "", "IComparer<string> c = new Target(); Func<string?, string?, int> g = c.Compare; g(\"\", \"\");", "ldvirtftn IComparer`1::Compare"),
        (Transfer.Invoke, Target.FrameworkVariance) => new("", ComparerTarget, "", null, "ldvirtftn IComparer`1::Compare", "Func<string?, string?, int>", "new Func<string?, string?, int>(((IComparer<string>)new Target()).Compare)", "(\"\", \"\")"),

        // A default interface method (the most specific implementation, in another interface).
        (Transfer.Callvirt, Target.DefaultImplementation) => new(Face, DefaultTarget, "", "IFace f = new Child(); f.Run();", "callvirt IFace::Run"),
        (Transfer.Constrained, Target.DefaultImplementation) => new(Face, DefaultTarget, CallFace, "Helpers.Call(new Child());", "constrained."),
        (Transfer.Pointer, Target.DefaultImplementation) => new(Face, DefaultTarget, "", "IFace f = new Child(); Action g = f.Run; g();", "ldvirtftn IFace::Run"),
        (Transfer.Invoke, Target.DefaultImplementation) => new(Face, DefaultTarget, "", null, "ldvirtftn IFace::Run", Group: "new Action(((IFace)new Child()).Run)"),
        _ => null,
    };

    // The controller of a cell. Direct: the action transfers control itself. Otherwise the delegate D (the method's own for
    // a delegate's Invoke, else a lambda running the transfer) is made by the controller's constructor, not the action, and
    // reaches the field the action invokes by the cell's source: so the reading must follow the stored value's provenance
    // (the maker isn't on the action's path). A delegate handed in takes the same paths from the constructor, or (entering
    // through the action) the action's own: into a field, through a helper's parameter, a returned value, an array, a
    // cast, a collection, then invoked.
    private static string ControllerOf(Cell cell, Form? form)
    {
        var d = form?.DelegateType ?? "Action";
        var make = cell.Entry != null ? "cb" : form!.Group ?? "new Action(() => { " + form.Run + " })";
        var call = form?.Arguments ?? "()";
        var c = cell.Controller;
        var action = cell.Entry == Entry.Action ? "[HttpPost] public void Disable(Guid userId, [FromServices] Action cb)" : "[HttpPost] public void Disable(Guid userId)";
        var ctor = cell.Entry == Entry.Constructor ? $"public {c}(Action cb)" : $"public {c}()";
        // Only what the source uses: a helper nobody calls whose parameter reaches the field would make it "handed in".
        var field = $"private {d} _d = null!;";
        const string Harmless = "private static void Harmless() { }";
        var same = $"private static {d} Same({d} d) => d;";
        var pass = $"private static {d} Pass({d} d) {{ {d} x = d; return x; }}";
        var fill = $"private static void Fill({d}[] all, {d} d) {{ all[0] = d; }}";
        var holder = $"public sealed class Holder {{ private readonly {d} _d; public Holder({d} d) {{ _d = d; }} public void Run() {{ _d{call}; }} }}";
        // Round 19: the recursion shapes (null decoys: the rotation must carry the delegate round to come out).
        var pick = $"private static {d} Pick({d} d, int n) => n == 0 ? d : Pick(d, n - 1);";
        var mutual = $"private static {d} A({d} d, int n) => n == 0 ? d : B(d, n - 1); private static {d} B({d} d, int n) => A(d, n);";
        var rotate = $"private static {d} Rotate({d} a, {d} b, {d} c, int n) => n == 0 ? a : Rotate(b, c, a, n - 1);";
        var spin = $"private void Spin({d} a, {d} b, {d} c, int n) {{ if (n == 0) _d = a; else Spin(b, c, a, n - 1); }}";
        var deepReturned = $"private static {d} D0({d} d) => D1(d); private static {d} D1({d} d) => D2(d); private static {d} D2({d} d) => D3(d); private static {d} D3({d} d) => d;";
        var deepStored = $"private void S0({d} d) => S1(d); private void S1({d} d) => S2(d); private void S2({d} d) => S3(d); private void S3({d} d) {{ _d = d; }}";
        if (cell.Source == Source.Direct) return form!.Helpers + $" public sealed class {c} : ControllerBase {{ {action} {{ {form.Run} }} }}";
        string members, body, outside = string.Empty;
        if (cell.Entry == Entry.Action)
        {
            (members, body) = cell.Source switch
            {
                Source.Field => (field, $"_d = cb; _d{call};"),
                Source.FieldThroughIdentity => (same, $"Same(cb){call};"),
                Source.FieldAfterDecoy => (Harmless, $"Action decoy = Harmless; {d} local = cb; GC.KeepAlive(decoy); local{call};"),
                Source.FieldThroughConstructor => (string.Empty, "new Holder(cb).Run();"),
                Source.Parameter => ($"private static void Run({d} d) {{ d{call}; }}", "Run(cb);"),
                Source.Local => (string.Empty, $"{d} local = cb; GC.KeepAlive(local); local{call};"),
                Source.Returned => (pass, $"Pass(cb){call};"),
                Source.ArrayInPlace => (string.Empty, $"var all = new {d}[1]; all[0] = cb; all[0]{call};"),
                Source.ArrayByHelper => (fill, $"var all = new {d}[1]; Fill(all, cb); all[0]{call};"),
                Source.ObjectCast => (string.Empty, $"object held = cb; (({d})held){call};"),
                Source.Collection => (string.Empty, $"new System.Collections.Generic.List<{d}> {{ cb }}[0]{call};"),
                Source.Recursive => (pick, $"Pick(cb, 2){call};"),
                Source.Mutual => (mutual, $"A(cb, 2){call};"),
                Source.Rotation => (rotate, $"Rotate(null!, null!, cb, 2){call};"),
                Source.RotationStored => (field + spin, $"Spin(null!, null!, cb, 2); _d{call};"),
                Source.DeepReturned => (deepReturned, $"D0(cb){call};"),
                Source.DeepStored => (field + deepStored, $"S0(cb); _d{call};"),
                _ => throw new ArgumentOutOfRangeException(nameof(cell)),
            };
            if (cell.Source == Source.FieldThroughConstructor) outside = holder;
            return (form?.Helpers ?? string.Empty) + " " + outside + $" public sealed class {c} : ControllerBase {{ {members} {action} {{ {body} }} }}";
        }

        string into;
        (members, into) = cell.Source switch
        {
            Source.Field => (field, $"_d = {make};"),
            Source.FieldThroughIdentity => (field + same, $"_d = Same({make});"),
            Source.FieldAfterDecoy => (field + Harmless, $"Action decoy = Harmless; {d} local = {make}; _d = local; GC.KeepAlive(decoy);"),
            Source.FieldThroughConstructor => ("private readonly Holder _holder;" + Harmless, $"Action decoy = Harmless; _holder = new Holder({make}); GC.KeepAlive(decoy);"),
            Source.Parameter => (field + Harmless + $"private void Store({d} d) {{ _d = d; }}", $"Action decoy = Harmless; Store({make}); GC.KeepAlive(decoy);"),
            Source.Local => (field, $"{d} local = {make}; GC.KeepAlive(local); _d = local;"),
            Source.Returned => cell.Entry == null ? (field + $"private static {d} Make() {{ {d} d = {make}; return d; }}", "_d = Make();") : (field + pass, $"_d = Pass({make});"),
            Source.ArrayInPlace => (field, $"var all = new {d}[1]; all[0] = {make}; _d = all[0];"),
            Source.ArrayByHelper => (field + fill, $"var all = new {d}[1]; Fill(all, {make}); _d = all[0];"),
            Source.ObjectCast => (field, $"object held = {make}; _d = ({d})held;"),
            Source.Collection => (field, $"var list = new System.Collections.Generic.List<{d}> {{ {make} }}; _d = list[0];"),
            Source.Recursive => (field + pick, $"_d = Pick({make}, 2);"),
            Source.Mutual => (field + mutual, $"_d = A({make}, 2);"),
            Source.Rotation => (field + rotate, $"_d = Rotate(null!, null!, {make}, 2);"),
            Source.RotationStored => (field + spin, $"Spin(null!, null!, {make}, 2);"),
            Source.DeepReturned => (field + deepReturned, $"_d = D0({make});"),
            Source.DeepStored => (field + deepStored, $"S0({make});"),
            _ => throw new ArgumentOutOfRangeException(nameof(cell)),
        };
        if (cell.Source == Source.FieldThroughConstructor) outside = holder;
        var invoke = cell.Source == Source.FieldThroughConstructor ? "_holder.Run();" : $"_d{call};";
        return (form?.Helpers ?? string.Empty) + " " + outside + $" public sealed class {c} : ControllerBase {{ {members} {ctor} {{ {into} }} {action} {{ {invoke} }} }}";
    }

    // ------------------------------------------------------------------ building, scanning and running the cells

    /// <summary>The cells, compiled once per place of the change (three folders), each folder scanned once.</summary>
    public sealed class Matrix : IDisposable
    {
        private const string Usings = """
            using System;
            using System.Collections.Generic;
            using System.Threading.Tasks;
            using MediaBrowser.Controller.Library;
            using MediaBrowser.Model.Users;
            using Microsoft.AspNetCore.Mvc;
            using Matrix;
            """;

        private static int _runs;

        private readonly Dictionary<string, Lazy<Group>> _groups;

        public Matrix() => _groups = All.GroupBy(c => c.Group).ToDictionary(g => g.Key, g => new Lazy<Group>(() => Group.Build(g.First().Entry == null ? g.First().Effect : null, g.ToList())));

        /// <summary>Every cell of the table, by id.</summary>
        public static IReadOnlyList<Cell> All { get; } = Generate();

        private static List<Cell> Generate()
        {
            var cells = new List<Cell>();
            foreach (var transfer in Enum.GetValues<Transfer>())
                foreach (var target in Enum.GetValues<Target>())
                {
                    if (FormOf(transfer, target) == null) continue;
                    foreach (var effect in Enum.GetValues<Effect>())
                        foreach (var source in Enum.GetValues<Source>())
                            if (source != Source.Direct || transfer != Transfer.Invoke) cells.Add(new Cell(cells.Count, transfer, target, effect, source));
                }

            foreach (var entry in Enum.GetValues<Entry>())
                foreach (var source in Enum.GetValues<Source>().Where(s => s != Source.Direct))
                    cells.Add(new Cell(cells.Count, default, default, default, source, entry));
            return cells;
        }

        public JellyfinUserAction Scanned(Cell cell)
            => _groups[cell.Group].Value.Actions.TryGetValue(cell.Controller, out var action) ? action : throw new Xunit.Sdk.XunitException(cell + " wasn't scanned");

        public bool Exercises(Cell cell, string evidence)
            => _groups[cell.Group].Value.Il.TryGetValue(cell.Name, out var il) && il.Any(i => i == evidence || (evidence == "constrained." && i == evidence));

        /// <summary>Runs the cell in a fresh load of its assemblies: (disables while the controller is built, in all).</summary>
        public (int Construction, int Total) Run(Cell cell)
        {
            var group = _groups[cell.Group].Value;
            var person = Guid.NewGuid();
            var count = 0;
            var users = new Moq.Mock<IUserManager>();
            users.Setup(u => u.UpdatePolicyAsync(Moq.It.IsAny<Guid>(), Moq.It.IsAny<UserPolicy>()))
                .Callback<Guid, UserPolicy>((id, policy) => { if (id == person && policy.IsDisabled) Interlocked.Increment(ref count); })
                .Returns(Task.CompletedTask);
            var context = new System.Runtime.Loader.AssemblyLoadContext("matrix-" + cell.Id + "-" + Guid.NewGuid().ToString("N"), isCollectible: true);
            var loaded = new Dictionary<string, System.Reflection.Assembly>(StringComparer.Ordinal);
            System.Reflection.Assembly Load(string name)
            {
                if (!loaded.TryGetValue(name, out var assembly)) loaded[name] = assembly = context.LoadFromStream(new MemoryStream(group.Images[name]));
                return assembly;
            }

            context.Resolving += (_, name) => name.Name != null && group.Images.ContainsKey(name.Name) ? Load(name.Name) : null;
            try
            {
                var bootstrap = Load("MatrixBase").GetType("Matrix.Bootstrap")!;
                bootstrap.GetField("Users")!.SetValue(null, users.Object);
                bootstrap.GetField("Person")!.SetValue(null, person);
                var type = Load("MatrixCells").GetType(cell.Name + "." + cell.Controller)!;
                // The closure a delegate handed in stands for (dependency injection, [FromServices]).
                Action closure = () => users.Object.UpdatePolicyAsync(person, new UserPolicy { IsDisabled = true }).GetAwaiter().GetResult();
                var instance = (cell.Entry == Entry.Constructor ? Activator.CreateInstance(type, closure) : Activator.CreateInstance(type))!;
                var construction = Volatile.Read(ref count);
                type.GetMethod("Disable")!.Invoke(instance, cell.Entry == Entry.Action ? new object[] { person, closure } : new object[] { person });
                return (construction, Volatile.Read(ref count));
            }
            finally
            {
                context.Unload();
                if (Interlocked.Increment(ref _runs) % 64 == 0) GC.Collect();
            }
        }

        public void Dispose()
        {
            foreach (var group in _groups.Values.Where(g => g.IsValueCreated)) group.Value.Dispose();
        }

        private sealed class Group : IDisposable
        {
            private static readonly Lazy<List<MetadataReference>> Platform = new(() => ((string)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")!).Split(Path.PathSeparator)
                .Concat(Directory.EnumerateFiles(AppContext.BaseDirectory, "*.dll")).Distinct(StringComparer.Ordinal)
                .Select(p => (MetadataReference)MetadataReference.CreateFromFile(p)).ToList());

            private readonly string _dir = Path.Combine(Path.GetTempPath(), "je-matrix-" + Guid.NewGuid().ToString("N"));

            public Dictionary<string, byte[]> Images { get; } = new(StringComparer.Ordinal);

            public Dictionary<string, JellyfinUserAction> Actions { get; } = new(StringComparer.Ordinal);

            // By cell: each instruction that transfers control ("callvirt IFace::Run", "constrained.").
            public Dictionary<string, List<string>> Il { get; } = new(StringComparer.Ordinal);

            // effect null: the handed-in cells (no target of their own).
            public static Group Build(Effect? effect, IReadOnlyList<Cell> cells)
            {
                var group = new Group();
                Directory.CreateDirectory(group._dir);
                var forms = cells.ToDictionary(c => c, c => c.Entry == null ? FormOf(c.Transfer, c.Target) : null);
                string Place(string declarations) => declarations
                    .Replace("{BODY}", effect == Effect.Body ? "Bootstrap.Disable();" : string.Empty, StringComparison.Ordinal)
                    .Replace("{CCTOR}", effect == Effect.TypeInitializer ? "static Target() { Bootstrap.Disable(); }" : string.Empty, StringComparison.Ordinal);
                var bases = Usings + """

                    namespace Matrix {
                      public static class Bootstrap {
                        public static IUserManager? Users;
                        public static Guid Person;
                        public static void Disable() => Users?.UpdatePolicyAsync(Person, new UserPolicy { IsDisabled = true }).GetAwaiter().GetResult();
                      }
                    }
                    """ + string.Concat(cells.Select(c => $"\nnamespace {c.Name} {{ {Place(forms[c]?.Base ?? string.Empty)} }}"));
                var targets = Usings + string.Concat(cells.Select(c => $"\nnamespace {c.Name} {{ {Place(forms[c]?.Targets ?? string.Empty)} }}"))
                    + (effect == Effect.ModuleInitializer ? "\nnamespace Matrix { internal static class ModuleStart { [System.Runtime.CompilerServices.ModuleInitializer] internal static void Run() => Bootstrap.Disable(); } }" : string.Empty);
                var controllers = Usings + string.Concat(cells.Select(c => $"\nnamespace {c.Name} {{ {ControllerOf(c, forms[c])} }}"));
                group.Compile("MatrixBase", bases);
                group.Compile("MatrixTargets", targets, "MatrixBase");
                group.Compile("MatrixCells", controllers, "MatrixBase", "MatrixTargets");
                foreach (var action in JellyfinUserActions.Scan(Path.Combine(group._dir, "MatrixCells.dll"))) group.Actions[action.Controller] = action;
                return group;
            }

            private void Compile(string name, string source, params string[] references)
            {
                var compilation = CSharpCompilation.Create(name, new[] { CSharpSyntaxTree.ParseText(source) },
                    Platform.Value.Concat(references.Select(r => MetadataReference.CreateFromImage(Images[r]))),
                    new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary, optimizationLevel: OptimizationLevel.Release, nullableContextOptions: NullableContextOptions.Enable));
                using var output = new MemoryStream();
                var emitted = compilation.Emit(output);
                if (!emitted.Success) throw new Xunit.Sdk.XunitException(name + ":\n" + string.Join("\n", emitted.Diagnostics.Where(d => d.Severity == DiagnosticSeverity.Error).Take(20)));
                Images[name] = output.ToArray();
                File.WriteAllBytes(Path.Combine(_dir, name + ".dll"), Images[name]);
                Read(Images[name]);
            }

            // The transfers in each cell's IL (every method of every type of its namespace, nested ones included).
            private void Read(byte[] image)
            {
                using var pe = new PEReader(new MemoryStream(image));
                var md = pe.GetMetadataReader();
                foreach (var handle in md.TypeDefinitions)
                {
                    var top = handle;
                    while (!md.GetTypeDefinition(top).GetDeclaringType().IsNil) top = md.GetTypeDefinition(top).GetDeclaringType();
                    var space = md.GetString(md.GetTypeDefinition(top).Namespace);
                    if (!space.StartsWith("Cell", StringComparison.Ordinal)) continue;
                    if (!Il.TryGetValue(space, out var found)) Il[space] = found = new List<string>();
                    foreach (var methodHandle in md.GetTypeDefinition(handle).GetMethods())
                    {
                        var method = md.GetMethodDefinition(methodHandle);
                        if (method.RelativeVirtualAddress == 0) continue;
                        var il = pe.GetMethodBody(method.RelativeVirtualAddress).GetILReader();
                        while (il.RemainingBytes > 0)
                        {
                            var first = il.ReadByte();
                            var code = first == 0xfe ? TwoByte[il.ReadByte()] : OneByte[first];
                            switch (code.OperandType)
                            {
                                case System.Reflection.Emit.OperandType.InlineMethod:
                                    found.Add(code.Name + " " + MemberName(md, MetadataTokens.EntityHandle(il.ReadInt32())));
                                    break;
                                case System.Reflection.Emit.OperandType.InlineNone:
                                    break;
                                case System.Reflection.Emit.OperandType.ShortInlineBrTarget or System.Reflection.Emit.OperandType.ShortInlineI or System.Reflection.Emit.OperandType.ShortInlineVar:
                                    il.Offset += 1;
                                    break;
                                case System.Reflection.Emit.OperandType.InlineVar:
                                    il.Offset += 2;
                                    break;
                                case System.Reflection.Emit.OperandType.InlineI8 or System.Reflection.Emit.OperandType.InlineR:
                                    il.Offset += 8;
                                    break;
                                case System.Reflection.Emit.OperandType.InlineSwitch:
                                    il.Offset += 4 * il.ReadInt32();
                                    break;
                                default:
                                    il.Offset += 4;
                                    if (code.Value == System.Reflection.Emit.OpCodes.Constrained.Value) found.Add("constrained.");
                                    break;
                            }
                        }
                    }
                }
            }

            private static string MemberName(MetadataReader md, EntityHandle handle)
            {
                switch (handle.Kind)
                {
                    case HandleKind.MethodSpecification:
                        return MemberName(md, md.GetMethodSpecification((MethodSpecificationHandle)handle).Method);
                    case HandleKind.MethodDefinition:
                    {
                        var method = md.GetMethodDefinition((MethodDefinitionHandle)handle);
                        return md.GetString(md.GetTypeDefinition(method.GetDeclaringType()).Name) + "::" + md.GetString(method.Name);
                    }
                    case HandleKind.MemberReference:
                    {
                        var member = md.GetMemberReference((MemberReferenceHandle)handle);
                        var parent = member.Parent;
                        if (parent.Kind == HandleKind.TypeSpecification)
                        {
                            var blob = md.GetBlobReader(md.GetTypeSpecification((TypeSpecificationHandle)parent).Signature);
                            if (blob.ReadSignatureTypeCode() == SignatureTypeCode.GenericTypeInstance)
                            {
                                blob.ReadSignatureTypeCode();
                                parent = blob.ReadTypeHandle();
                            }
                        }

                        var type = parent.Kind switch
                        {
                            HandleKind.TypeReference => md.GetString(md.GetTypeReference((TypeReferenceHandle)parent).Name),
                            HandleKind.TypeDefinition => md.GetString(md.GetTypeDefinition((TypeDefinitionHandle)parent).Name),
                            _ => "?",
                        };
                        return type + "::" + md.GetString(member.Name);
                    }
                    default:
                        return "?";
                }
            }

            private static readonly System.Reflection.Emit.OpCode[] OneByte = new System.Reflection.Emit.OpCode[0x100];
            private static readonly System.Reflection.Emit.OpCode[] TwoByte = new System.Reflection.Emit.OpCode[0x100];

            static Group()
            {
                foreach (var field in typeof(System.Reflection.Emit.OpCodes).GetFields(System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Static))
                {
                    if (field.GetValue(null) is not System.Reflection.Emit.OpCode code) continue;
                    var value = (ushort)code.Value;
                    if (value < 0x100) OneByte[value] = code;
                    else if ((value & 0xff00) == 0xfe00) TwoByte[value & 0xff] = code;
                }
            }

            public void Dispose()
            {
                try { Directory.Delete(_dir, recursive: true); }
                catch (IOException) { }
                catch (UnauthorizedAccessException) { }
            }
        }
    }
}
