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
    /// .NET), a default interface method, static abstract members (code read, .NET).
    /// Round 21 (D53: exact identity): an inherited fill behind a nearer overload of the same name and parameter count that
    /// doesn't match (another parameter type, a generic method, a by-reference parameter; and for a slot .NET declares),
    /// a base named like a type of another assembly (both in the code read, both outside it), and slot chains through
    /// MethodImpls outside the code read (a covariant override chain; an interface implemented under another name).</summary>
    public enum Target
    {
        Method, Override, Explicit, FrameworkSlot, StaticAbstract, FrameworkStaticAbstract,
        Inherited, InheritedAcrossAssemblies, FrameworkInherited, FrameworkIntermediate, FrameworkAbstractChain, Reimplementation, FrameworkReimplementation,
        Variance, FrameworkVariance, DefaultImplementation,
        ShadowByType, ShadowByArity, ShadowByRef, FrameworkShadow, DuplicateRead, DuplicateOutside, ExternalCovariant, ExternalInterfaceImpl,
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

    // The round-19 table (kept whole: 3,246 visible cells, 34 handed in).
    private static readonly HashSet<Target> Round19Targets = Enum.GetValues<Target>().Where(t => t <= Target.DefaultImplementation).ToHashSet();

    private static readonly HashSet<Entry> Round18Entries = new() { Entry.Constructor, Entry.Action };

    private static readonly HashSet<Source> Round18Sources = Enum.GetValues<Source>().Where(s => s <= Source.Collection).ToHashSet();

    /// <summary>Where a delegate handed in from outside the code read enters: the controller's constructor (dependency
    /// injection) or the action ([FromServices]). Round 21 (open-world inputs): the same, with an internal caller too that
    /// hands it a harmless delegate (a factory building the controller; a [NonAction] method calling the action), which
    /// must not narrow what outside callers hand in.</summary>
    public enum Entry { Constructor, Action, ConstructorMixed, ActionMixed }

    /// <summary>Round 21 (MVC's own action discovery): where the action a cell's controller has is declared: an abstract
    /// base controller in the same assembly, or one in another assembly of the code read.</summary>
    public enum Place { AbstractBase, OtherModule }

    /// <summary>One cell of the matrix: a visible delegate (or none), or (Entry set) one handed in from outside, or (Place
    /// set) a direct transfer in an action the controller inherits.</summary>
    public sealed record Cell(int Id, Transfer Transfer, Target Target, Effect Effect, Source Source, Entry? Entry = null, Place? Place = null)
    {
        public string Name => "Cell" + Id;

        public string Controller => Name + "Controller";

        public string Group => Place != null ? "Inherited" : Entry == null ? Effect.ToString() : "HandedIn";

        public override string ToString() => Place != null ? $"{Name} inherited/{Place}/{Transfer}/{Target}" : Entry == null ? $"{Name} {Transfer}/{Target}/{Effect}/{Source}" : $"{Name} handed in/{Entry}/{Source}";
    }

    // The stated-limit cells ("Transfer/Target/Effect/Source"), pinned as None (the runtime still disables the person).
    private static readonly HashSet<string> StatedLimits = new(StringComparer.Ordinal);

    private readonly Matrix _matrix;

    public IntegrationJellyfinUserMatrixTests(Matrix matrix) => _matrix = matrix;

    public static IEnumerable<object[]> Cells() => Matrix.All.Where(c => c.Entry == null && c.Place == null).Select(c => new object[] { c.Id, c.Transfer, c.Target, c.Effect, c.Source });

    public static IEnumerable<object[]> InheritedCells() => Matrix.All.Where(c => c.Place != null).Select(c => new object[] { c.Id, c.Transfer, c.Target, c.Place!.Value });

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

    // Round 21 (4a-r21-5): an action a controller inherits (declared in an abstract base, or in a base in another assembly of
    // the code read) is MVC's action of that controller: it has its own entry, classified like any other, and KeyOf answers
    // for the MethodInfo MVC hands the filter (the base's method, reflected on the controller).
    [Theory]
    [MemberData(nameof(InheritedCells))]
    public void EveryInheritedActionIsBracketedUnderItsControllerAndReallyDisablesThePersonOnce(int id, Transfer transfer, Target target, Place place)
    {
        var cell = Matrix.All[id];
        Assert.Equal((transfer, target, place), (cell.Transfer, cell.Target, cell.Place));
        var evidence = FormOf(transfer, target)!.Evidence;
        Assert.True(_matrix.Exercises(cell, evidence), cell + ": its IL has no " + evidence);
        var action = _matrix.Scanned(cell);
        Assert.True(action.Key == JellyfinUserKey.User, $"{cell}: scan {action.Key} why={action.Why} via={string.Join(" > ", action.Via ?? Array.Empty<string>())}");
        Assert.Equal("reaches IUserManager.UpdatePolicyAsync", action.Why);
        Assert.Equal(JellyfinUserKey.User, _matrix.KeyThroughMvc(cell));
        var (construction, total) = _matrix.Run(cell);
        Assert.Equal((0, 1), (construction, total));
    }

    // Round 21: every group's actions are the ones a real MVC application model finds in its controllers' assembly (the same
    // controllers, the same methods: declared, inherited, overridden), each with its own entry.
    [Theory]
    [InlineData("Body")]
    [InlineData("TypeInitializer")]
    [InlineData("ModuleInitializer")]
    [InlineData("HandedIn")]
    [InlineData("Inherited")]
    public void EveryGroupsActionsAreMvcsOwn(string group) => _matrix.AssertMvcsActions(group);

    // The table is the full product of what C# can write: every transfer/kind pair FormOf allows, with every place of the
    // change and every source (a delegate's Invoke has no "none" source: that is the method pointer row).
    [Fact]
    public void TheMatrixIsTheFullProductOfTheTable()
    {
        var pairs = Enum.GetValues<Transfer>().SelectMany(t => Enum.GetValues<Target>().Where(k => FormOf(t, k) != null).Select(k => (t, k))).ToList();
        var expected = pairs.Sum(p => Enum.GetValues<Effect>().Length * Enum.GetValues<Source>().Count(s => s != Source.Direct || p.t != Transfer.Invoke));
        Assert.Equal(expected, Matrix.All.Count(c => c.Entry == null && c.Place == null));
        Assert.Equal(Enum.GetValues<Entry>().Length * (Enum.GetValues<Source>().Length - 1), Matrix.All.Count(c => c.Entry != null));
        Assert.Equal(pairs.Count(p => p.t != Transfer.Invoke) * Enum.GetValues<Place>().Length, Matrix.All.Count(c => c.Place != null));
        Assert.Equal(Matrix.All.Count, Matrix.All.Select(c => (c.Transfer, c.Target, c.Effect, c.Source, c.Entry, c.Place)).Distinct().Count());
        // Each transfer reaches at least one kind; each kind is reached by at least two transfers.
        Assert.All(Enum.GetValues<Transfer>(), t => Assert.Contains(pairs, p => p.t == t));
        Assert.All(Enum.GetValues<Target>(), k => Assert.True(pairs.Count(p => p.k == k) >= 2, k + " is reached by fewer than two transfers"));
    }

    // Round 19: the round-18 cells are all still here (the same 23 transfer/kind pairs, three places, the twelve sources).
    [Fact]
    public void TheRound18CellsAreKept()
    {
        Assert.Equal(810, Matrix.All.Count(c => c.Entry == null && c.Place == null && Round18Targets.Contains(c.Target) && Round18Sources.Contains(c.Source)));
        Assert.Equal(22, Matrix.All.Count(c => c.Entry is { } e && Round18Entries.Contains(e) && Round18Sources.Contains(c.Source)));
        Assert.Equal(23, Enum.GetValues<Transfer>().Sum(t => Round18Targets.Count(k => FormOf(t, k) != null)));
    }

    // Round 21: the round-19 cells are all still here (the 61 transfer/kind pairs, three places, the eighteen sources; the
    // two entries).
    [Fact]
    public void TheRound19CellsAreKept()
    {
        Assert.Equal(3246, Matrix.All.Count(c => c.Entry == null && c.Place == null && Round19Targets.Contains(c.Target)));
        Assert.Equal(34, Matrix.All.Count(c => c.Entry is { } e && Round18Entries.Contains(e)));
        Assert.Equal(61, Enum.GetValues<Transfer>().Sum(t => Round19Targets.Count(k => FormOf(t, k) != null)));
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

    // Round 21: the identity kinds. A shadow: Mid declares a Run of the same name and parameter count that isn't the slot's.
    private const string RunFace = "public interface IRun { void Run(int value); }";
    private const string CallRun = "public static class Helpers { public static void Call<T>(T t) where T : IRun => t.Run(0); }";
    private static string ShadowTarget(string shadow) => "public class Target { {CCTOR} public virtual void Run(int value) { {BODY} } } public class Mid : Target { " + shadow + " } public sealed class Child : Mid, IRun { }";
    private const string ObserverTarget = "public class Target { {CCTOR} public virtual void OnNext(int value) { {BODY} } public virtual void OnError(Exception error) { } public virtual void OnCompleted() { } } public class Mid : Target { public virtual void OnNext(string value) { } } public sealed class Child : Mid, IObserver<int> { }";
    // Two code-read assemblies define CellN.Twin (MatrixBase's plain, MatrixTargets' a MemoryStream).
    private const string TwinRead = "public sealed class Target : Twin { {CCTOR} public override void SetLength(long value) { {BODY} } }";
    // Twins.Mid in two assemblies outside the code read (System.MatrixTwinA plain, System.MatrixTwinB a MemoryStream).
    private const string TwinOutside = "public sealed class Target : Twins.Mid { {CCTOR} public override void Flush() { {BODY} } }";
    private const string CovariantTarget = "public sealed class Target : Cov.Parent { {CCTOR} public override Cov.R2 Make() { {BODY} return new Cov.R2(); } }";
    private const string HookTarget = "public sealed class Target : Slots.Parent { {CCTOR} public override void Hook() { {BODY} } }";

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

        // Round 21 (4a-r21-1): the inherited fill is found past a nearer method of the same name and parameter count that
        // isn't the slot's (the runtime compares whole signatures).
        (Transfer.Callvirt, Target.ShadowByType or Target.ShadowByArity or Target.ShadowByRef) => new(RunFace, ShadowTarget(Shadow(target)), "", "IRun f = new Child(); f.Run(0);", "callvirt IRun::Run"),
        (Transfer.Constrained, Target.ShadowByType or Target.ShadowByArity or Target.ShadowByRef) => new(RunFace, ShadowTarget(Shadow(target)), CallRun, "Helpers.Call(new Child());", "constrained."),
        (Transfer.Pointer, Target.ShadowByType or Target.ShadowByArity or Target.ShadowByRef) => new(RunFace, ShadowTarget(Shadow(target)), "", "IRun f = new Child(); Action<int> g = f.Run; g(0);", "ldvirtftn IRun::Run"),
        (Transfer.Invoke, Target.ShadowByType or Target.ShadowByArity or Target.ShadowByRef) => new(RunFace, ShadowTarget(Shadow(target)), "", null, "ldvirtftn IRun::Run", "Action<int>", "new Action<int>(((IRun)new Child()).Run)", "(0)"),

        (Transfer.Callvirt, Target.FrameworkShadow) => new("", ObserverTarget, "", "IObserver<int> o = new Child(); o.OnNext(0);", "callvirt IObserver`1::OnNext"),
        (Transfer.Constrained, Target.FrameworkShadow) => new("", ObserverTarget, "public static class Helpers { public static void Call<T>(T t) where T : IObserver<int> => t.OnNext(0); }", "Helpers.Call(new Child());", "constrained."),
        (Transfer.Pointer, Target.FrameworkShadow) => new("", ObserverTarget, "", "IObserver<int> o = new Child(); Action<int> g = o.OnNext; g(0);", "ldvirtftn IObserver`1::OnNext"),
        (Transfer.Invoke, Target.FrameworkShadow) => new("", ObserverTarget, "", null, "ldvirtftn IObserver`1::OnNext", "Action<int>", "new Action<int>(((IObserver<int>)new Child()).OnNext)", "(0)"),

        // Round 21 (4a-r21-2): a base whose full name another assembly defines too is its own assembly's (code read; outside).
        (Transfer.Callvirt, Target.DuplicateRead) => new("public class Twin { }", "public class Twin : System.IO.MemoryStream { } " + TwinRead, "", "System.IO.Stream s = new Target(); s.SetLength(0);", "callvirt Stream::SetLength"),
        (Transfer.Pointer, Target.DuplicateRead) => new("public class Twin { }", "public class Twin : System.IO.MemoryStream { } " + TwinRead, "", "System.IO.Stream s = new Target(); Action<long> g = s.SetLength; g(0);", "ldvirtftn Stream::SetLength"),
        (Transfer.Invoke, Target.DuplicateRead) => new("public class Twin { }", "public class Twin : System.IO.MemoryStream { } " + TwinRead, "", null, "ldvirtftn Stream::SetLength", "Action<long>", "new Action<long>(((System.IO.Stream)new Target()).SetLength)", "(0)"),
        (Transfer.Callvirt, Target.DuplicateOutside) => new("", TwinOutside, "", "System.IO.Stream s = new Target(); s.Flush();", "callvirt Stream::Flush"),
        (Transfer.Pointer, Target.DuplicateOutside) => new("", TwinOutside, "", "System.IO.Stream s = new Target(); Action g = s.Flush; g();", "ldvirtftn Stream::Flush"),
        (Transfer.Invoke, Target.DuplicateOutside) => new("", TwinOutside, "", null, "ldvirtftn Stream::Flush", Group: "new Action(((System.IO.Stream)new Target()).Flush)"),

        // Round 21 (4a-r21-3): slot chains through MethodImpls outside the code read.
        (Transfer.Callvirt, Target.ExternalCovariant) => new("", CovariantTarget, "", "Cov.Root r = new Target(); r.Make();", "callvirt Root::Make"),
        (Transfer.Pointer, Target.ExternalCovariant) => new("", CovariantTarget, "", "Cov.Root r = new Target(); Func<Cov.R0> g = r.Make; g();", "ldvirtftn Root::Make"),
        (Transfer.Invoke, Target.ExternalCovariant) => new("", CovariantTarget, "", null, "ldvirtftn Root::Make", "Func<Cov.R0>", "new Func<Cov.R0>(((Cov.Root)new Target()).Make)"),
        (Transfer.Callvirt, Target.ExternalInterfaceImpl) => new("", HookTarget, "", "Slots.IHook h = new Target(); h.Run();", "callvirt IHook::Run"),
        (Transfer.Constrained, Target.ExternalInterfaceImpl) => new("", HookTarget, "public static class Helpers { public static void Call<T>(T t) where T : Slots.IHook => t.Run(); }", "Helpers.Call(new Target());", "constrained."),
        (Transfer.Pointer, Target.ExternalInterfaceImpl) => new("", HookTarget, "", "Slots.IHook h = new Target(); Action g = h.Run; g();", "ldvirtftn IHook::Run"),
        (Transfer.Invoke, Target.ExternalInterfaceImpl) => new("", HookTarget, "", null, "ldvirtftn IHook::Run", Group: "new Action(((Slots.IHook)new Target()).Run)"),
        _ => null,
    };

    private static string Shadow(Target target) => target switch
    {
        Target.ShadowByType => "public virtual void Run(string value) { }",
        Target.ShadowByArity => "public virtual void Run<T>(int value) { }",
        _ => "public virtual void Run(ref int value) { }",
    };

    // The shared assemblies outside the code read (named like .NET's: only their metadata is read).
    private const string CovariantBase = "namespace Cov { public class R0 {} public class R1 : R0 {} public class R2 : R1 {} public class Root { public virtual R0 Make() => new R0(); } public class Parent : Root { public override R1 Make() => new R1(); } }";

    // Round 21: an inherited action's controller. AbstractBase: the base (with the transfer) and the controller, here;
    // OtherModule: the base in MatrixActions (BaseOf), only the controller here.
    private static string InheritedOf(Cell cell, Form form)
        => cell.Place == Place.AbstractBase ? BaseOf(cell, form) + $" public sealed class {cell.Controller} : {cell.Controller}Base {{ }}"
            : $"public sealed class {cell.Controller} : {cell.Controller}Base {{ }}";

    private static string BaseOf(Cell cell, Form form)
        => form.Helpers + $" public abstract class {cell.Controller}Base : ControllerBase {{ [HttpPost] public void Disable(Guid userId) {{ {form.Run} }} }}";

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
        var inAction = cell.Entry is Entry.Action or Entry.ActionMixed;
        var inConstructor = cell.Entry is Entry.Constructor or Entry.ConstructorMixed;
        var action = inAction ? "[HttpPost] public void Disable(Guid userId, [FromServices] Action cb)" : "[HttpPost] public void Disable(Guid userId)";
        var ctor = inConstructor ? $"public {c}(Action cb)" : $"public {c}()";
        // Round 21: the internal caller handing in a harmless delegate (it must not narrow what outside callers hand in).
        var quiet = cell.Entry == Entry.ConstructorMixed ? $" public static {c} Quiet() => new {c}(() => {{ }});"
            : cell.Entry == Entry.ActionMixed ? " [NonAction] public void Quiet() => Disable(Guid.Empty, () => { });"
            : string.Empty;
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
        if (cell.Place != null) return InheritedOf(cell, form!);
        if (cell.Source == Source.Direct) return form!.Helpers + $" public sealed class {c} : ControllerBase {{ {action} {{ {form.Run} }} }}";
        string members, body, outside = string.Empty;
        if (inAction)
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
            return (form?.Helpers ?? string.Empty) + " " + outside + $" public sealed class {c} : ControllerBase {{ {members} {action} {{ {body} }}{quiet} }}";
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
        return (form?.Helpers ?? string.Empty) + " " + outside + $" public sealed class {c} : ControllerBase {{ {members} {ctor} {{ {into} }} {action} {{ {invoke} }}{quiet} }}";
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

        /// <summary>The bracket KeyOf gives the cell's action as a real MVC application model hands it to the filter.</summary>
        public JellyfinUserKey KeyThroughMvc(Cell cell)
            => _groups[cell.Group].Value.WithMvc(actions =>
            {
                var action = actions.Single(a => a.ControllerTypeInfo.Name == cell.Controller && a.MethodInfo.Name == "Disable");
                return JellyfinUserActions.KeyOf(action.MethodInfo, action.ControllerTypeInfo.Name, "POST");
            });

        /// <summary>The group's scanned actions are the ones MVC finds (by controller and method identity).</summary>
        public void AssertMvcsActions(string name)
        {
            var group = _groups[name].Value;
            var tokenProperty = typeof(JellyfinUserAction).GetProperty("Token");
            var moduleProperty = typeof(JellyfinUserAction).GetProperty("Module");
            Assert.True(tokenProperty != null && moduleProperty != null, "JellyfinUserAction carries no method identity (Module, Token)");
            var scanned = group.All.Select(a => a.Controller + " " + moduleProperty!.GetValue(a) + ":" + ((int)tokenProperty!.GetValue(a)!).ToString("x8")).OrderBy(a => a, StringComparer.Ordinal).ToList();
            var mvc = group.WithMvc(actions => actions.Select(a => a.ControllerTypeInfo.Name + " " + a.MethodInfo.Module.Assembly.GetName().Name + ":" + a.MethodInfo.MetadataToken.ToString("x8")).Distinct().OrderBy(a => a, StringComparer.Ordinal).ToList());
            var problems = mvc.Except(scanned).Select(a => "MVC has " + a + ", the scan doesn't").Concat(scanned.Except(mvc).Select(a => "the scan has " + a + ", MVC doesn't")).Take(40).ToList();
            Assert.True(problems.Count == 0, string.Join("\n", problems));
            Assert.Equal(mvc.Count, scanned.Count);
        }

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

            // Round 21: every direct transfer/kind pair in an action the controller inherits, from each place.
            foreach (var transfer in Enum.GetValues<Transfer>().Where(t => t != Transfer.Invoke))
                foreach (var target in Enum.GetValues<Target>().Where(k => FormOf(transfer, k) != null))
                    foreach (var place in Enum.GetValues<Place>())
                        cells.Add(new Cell(cells.Count, transfer, target, Effect.Body, Source.Direct, null, place));
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

            Func<System.Runtime.Loader.AssemblyLoadContext, System.Reflection.AssemblyName, System.Reflection.Assembly?> resolve =
                (_, name) => name.Name != null && group.Images.ContainsKey(name.Name) ? Load(name.Name) : null;
            context.Resolving += resolve;
            try
            {
                var bootstrap = Load("MatrixBase").GetType("Matrix.Bootstrap")!;
                bootstrap.GetField("Users")!.SetValue(null, users.Object);
                bootstrap.GetField("Person")!.SetValue(null, person);
                var type = Load("MatrixCells").GetType(cell.Name + "." + cell.Controller)!;
                // The closure a delegate handed in stands for (dependency injection, [FromServices]).
                Action closure = () => users.Object.UpdatePolicyAsync(person, new UserPolicy { IsDisabled = true }).GetAwaiter().GetResult();
                var instance = (cell.Entry is Entry.Constructor or Entry.ConstructorMixed ? Activator.CreateInstance(type, closure) : Activator.CreateInstance(type))!;
                var construction = Volatile.Read(ref count);
                type.GetMethod("Disable")!.Invoke(instance, cell.Entry is Entry.Action or Entry.ActionMixed ? new object[] { person, closure } : new object[] { person });
                return (construction, Volatile.Read(ref count));
            }
            finally
            {
                // A context whose Resolving handler is still subscribed is never collected (measured: every one of ~5000
                // cells stayed loaded, ~1.1 MB of executable memory each, until the test host ran out of memory).
                context.Resolving -= resolve;
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

            // Every action the scan found in the controllers' assembly.
            public IReadOnlyList<JellyfinUserAction> All { get; private set; } = Array.Empty<JellyfinUserAction>();

            // Round 21: the group's assemblies loaded from their files and a real MVC application model of its controllers.
            private System.Runtime.Loader.AssemblyLoadContext? _mvcContext;
            private List<Microsoft.AspNetCore.Mvc.Controllers.ControllerActionDescriptor>? _mvc;

            // By cell: each instruction that transfers control ("callvirt IFace::Run", "constrained.").
            public Dictionary<string, List<string>> Il { get; } = new(StringComparer.Ordinal);

            // effect null: the handed-in cells (no target of their own).
            public static Group Build(Effect? effect, IReadOnlyList<Cell> cells)
            {
                var group = new Group();
                Directory.CreateDirectory(group._dir);
                var forms = cells.ToDictionary(c => c, c => c.Entry == null ? FormOf(c.Transfer, c.Target) : null);
                string Placed(string declarations) => declarations
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
                    """ + string.Concat(cells.Select(c => $"\nnamespace {c.Name} {{ {Placed(forms[c]?.Base ?? string.Empty)} }}"));
                var targets = Usings + string.Concat(cells.Select(c => $"\nnamespace {c.Name} {{ {Placed(forms[c]?.Targets ?? string.Empty)} }}"))
                    + (effect == Effect.ModuleInitializer ? "\nnamespace Matrix { internal static class ModuleStart { [System.Runtime.CompilerServices.ModuleInitializer] internal static void Run() => Bootstrap.Disable(); } }" : string.Empty);
                // Round 21: a type deriving from System.MatrixTwinA's Twins.Mid in the controllers' assembly (read first), so the
                // other Twins.Mid (System.MatrixTwinB's, which DuplicateOutside's targets derive from) is met after it.
                var controllers = "extern alias TwinA;\n" + Usings + "\nnamespace Matrix { public class PlainTwin : TwinA::Twins.Mid { } }"
                    + string.Concat(cells.Select(c => $"\nnamespace {c.Name} {{ {ControllerOf(c, forms[c])} }}"));
                // Round 21: the assemblies outside the code read some kinds derive from (named like .NET's: only their metadata
                // is read): Twins.Mid twice, a covariant override chain, an interface implemented under another name.
                group.Compile("System.MatrixTwinA", "namespace Twins { public class Mid { } }");
                group.Compile("System.MatrixTwinB", "namespace Twins { public class Mid : System.IO.MemoryStream { } }");
                group.Compile("System.MatrixCovariant", CovariantBase);
                group.Emit("System.MatrixSlots", IntegrationJellyfinUserIdentityTests.HookAssembly);
                var outside = new[] { "System.MatrixTwinB", "System.MatrixCovariant", "System.MatrixSlots" };
                group.Compile("MatrixBase", bases);
                group.Compile("MatrixTargets", targets, outside.Prepend("MatrixBase").ToArray());
                var references = new List<string> { "MatrixBase", "MatrixTargets" };
                if (cells.Any(c => c.Place == Place.OtherModule))
                {
                    group.Compile("MatrixActions", Usings + string.Concat(cells.Where(c => c.Place == Place.OtherModule).Select(c => $"\nnamespace {c.Name} {{ {BaseOf(c, forms[c]!)} }}")), references.Concat(outside).ToArray());
                    references.Add("MatrixActions");
                }

                group.Compile("MatrixCells", controllers, references.Concat(outside).Select(r => (r, (string?)null)).Append(("System.MatrixTwinA", "TwinA")));
                group.All = JellyfinUserActions.Scan(Path.Combine(group._dir, "MatrixCells.dll"));
                foreach (var action in group.All) group.Actions[action.Controller] = action;
                return group;
            }

            /// <summary>Runs f on the controller actions a real MVC application model finds in MatrixCells (loaded from its file,
            /// so KeyOf reads it as the filter would).</summary>
            public T WithMvc<T>(Func<List<Microsoft.AspNetCore.Mvc.Controllers.ControllerActionDescriptor>, T> f)
            {
                lock (Images)
                {
                    if (_mvc == null)
                    {
                        _mvcContext = new System.Runtime.Loader.AssemblyLoadContext("matrix-mvc-" + Guid.NewGuid().ToString("N"), isCollectible: true);
                        var context = _mvcContext;
                        context.Resolving += (_, name) => name.Name != null && Images.ContainsKey(name.Name) ? context.LoadFromAssemblyPath(Path.Combine(_dir, name.Name + ".dll")) : null;
                        var cells = context.LoadFromAssemblyPath(Path.Combine(_dir, "MatrixCells.dll"));
                        var services = new Microsoft.Extensions.DependencyInjection.ServiceCollection();
                        Microsoft.Extensions.DependencyInjection.LoggingServiceCollectionExtensions.AddLogging(services);
                        Microsoft.Extensions.DependencyInjection.MvcCoreMvcBuilderExtensions.AddApplicationPart(Microsoft.Extensions.DependencyInjection.MvcServiceCollectionExtensions.AddControllers(services), cells);
                        using var provider = Microsoft.Extensions.DependencyInjection.ServiceCollectionContainerBuilderExtensions.BuildServiceProvider(services);
                        _mvc = Microsoft.Extensions.DependencyInjection.ServiceProviderServiceExtensions.GetRequiredService<Microsoft.AspNetCore.Mvc.Infrastructure.IActionDescriptorCollectionProvider>(provider)
                            .ActionDescriptors.Items.OfType<Microsoft.AspNetCore.Mvc.Controllers.ControllerActionDescriptor>().Where(a => a.ControllerTypeInfo.Assembly == cells).ToList();
                    }

                    return f(_mvc);
                }
            }

            private void Compile(string name, string source, params string[] references) => Compile(name, source, references.Select(r => (r, (string?)null)));

            private void Compile(string name, string source, IEnumerable<(string Name, string? Alias)> references)
            {
                var compilation = CSharpCompilation.Create(name, new[] { CSharpSyntaxTree.ParseText(source) },
                    Platform.Value.Concat(references.Select(r => r.Alias == null ? MetadataReference.CreateFromImage(Images[r.Name]) : MetadataReference.CreateFromImage(Images[r.Name]).WithAliases(new[] { r.Alias }))),
                    new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary, optimizationLevel: OptimizationLevel.Release, nullableContextOptions: NullableContextOptions.Enable));
                using var output = new MemoryStream();
                var emitted = compilation.Emit(output);
                if (!emitted.Success) throw new Xunit.Sdk.XunitException(name + ":\n" + string.Join("\n", emitted.Diagnostics.Where(d => d.Severity == DiagnosticSeverity.Error).Take(20)));
                Images[name] = output.ToArray();
                File.WriteAllBytes(Path.Combine(_dir, name + ".dll"), Images[name]);
                Read(Images[name]);
            }

            // An assembly written by code (what C# can't express).
            private void Emit(string name, Action<string> write)
            {
                write(Path.Combine(_dir, name + ".dll"));
                Images[name] = File.ReadAllBytes(Path.Combine(_dir, name + ".dll"));
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
                _mvc = null;
                _mvcContext?.Unload();
                try { Directory.Delete(_dir, recursive: true); }
                catch (IOException) { }
                catch (UnauthorizedAccessException) { }
            }
        }
    }
}
