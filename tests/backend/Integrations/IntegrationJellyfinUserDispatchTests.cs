using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Automation;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Users;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;

namespace JE.Tests;

/// <summary>
/// 4a review round 10 (4a-security-r10-2): the classifier (<see cref="JellyfinUserActions"/>) follows a call to where it
/// really goes. Round 9 followed only the methods of the controller's own assembly, by their declared target: a call
/// through an abstract method or an interface reached the declaration (no body), not the implementation, and a delegate
/// field invoked by the action wasn't connected to the method its constructor stored in it. Both probes below disabled a
/// user unbracketed. In Jellyfin itself the controllers (Jellyfin.Api) call interfaces declared in MediaBrowser.Controller
/// and implemented in Emby.Server.Implementations or Jellyfin.Server.Implementations, so dispatch is resolved ACROSS the
/// Jellyfin assemblies, by their metadata (nothing loaded or run). What stays unresolved (an interface nobody in those
/// assemblies implements, a delegate whose target isn't visible) brackets the action globally when it isn't a GET.
/// Each probe is compiled for real (Roslyn), into its own directory with the assemblies it needs.
/// </summary>
public class IntegrationJellyfinUserDispatchTests
{
    private const string Usings = """
        using System;
        using System.Threading.Tasks;
        using MediaBrowser.Controller.Library;
        using MediaBrowser.Model.Users;
        using Microsoft.AspNetCore.Mvc;
        """;

    // The reviewer's two probes, plus the shapes around them: a virtual method's override, an event whose handler changes
    // the user, a delegate stored by a lambda, and the unresolved cases.
    private const string Probes = Usings + """

        public abstract class PolicyChanges { public abstract Task Apply(Guid userId); }
        public sealed class RealChanges(IUserManager users) : PolicyChanges {
          public override Task Apply(Guid userId) => users.UpdatePolicyAsync(userId, new UserPolicy { IsDisabled = true });
        }
        public sealed class MembershipController(PolicyChanges changes) : ControllerBase {
          [HttpPost] public Task Disable(Guid userId) => changes.Apply(userId);
        }
        public sealed class DelegateController : ControllerBase {
          private readonly Func<Guid, UserPolicy, Task> _apply;
          public DelegateController(IUserManager users) { _apply = users.UpdatePolicyAsync; }
          [HttpPost] public Task Disable(Guid userId) => _apply(userId, new UserPolicy { IsDisabled = true });
        }
        public class Notes { public virtual Task Write(Guid userId) => Task.CompletedTask; }
        public sealed class PolicyNotes(IUserManager users) : Notes {
          public override Task Write(Guid userId) => users.UpdatePolicyAsync(userId, new UserPolicy { IsDisabled = true });
        }
        public sealed class VirtualController(Notes notes) : ControllerBase {
          [HttpPost] public Task Disable(Guid userId) => notes.Write(userId);
        }
        public sealed class Signals { public event Func<Guid, Task>? Changed; public Task Raise(Guid userId) => Changed?.Invoke(userId) ?? Task.CompletedTask; }
        public sealed class Listener {
          private readonly IUserManager _users;
          public Listener(Signals signals, IUserManager users) { _users = users; signals.Changed += OnChanged; }
          private Task OnChanged(Guid userId) => _users.UpdatePolicyAsync(userId, new UserPolicy { IsDisabled = true });
        }
        public sealed class EventController(Signals signals) : ControllerBase {
          [HttpPost] public Task Disable(Guid userId) => signals.Raise(userId);
        }
        public sealed class LambdaController : ControllerBase {
          private readonly Func<Guid, Task> _apply;
          public LambdaController(IUserManager users) { _apply = id => users.UpdatePolicyAsync(id, new UserPolicy { IsDisabled = true }); }
          [HttpPost] public Task Disable(Guid userId) => _apply(userId);
        }
        public interface IRemoteChanges { Task Apply(Guid userId); }
        public sealed class UnresolvedController(IRemoteChanges changes) : ControllerBase {
          [HttpPost] public Task Disable(Guid userId) => changes.Apply(userId);
          [HttpGet] public Task Peek(Guid userId) => changes.Apply(userId);
        }
        public sealed class InjectedDelegateController(Func<Guid, Task> apply) : ControllerBase {
          private readonly Func<Guid, Task> _apply = apply;
          [HttpPost] public Task Disable(Guid userId) => _apply(userId);
        }
        public sealed class QuietController(Notes notes) : ControllerBase {
          [HttpPost] public Task Note() => Task.CompletedTask;
          [HttpPost] public Task Disable(Guid userId) => notes.Write(userId);
        }
        """;

    [Theory]
    [InlineData("MembershipController", "Disable")]
    [InlineData("DelegateController", "Disable")]
    [InlineData("VirtualController", "Disable")]
    [InlineData("EventController", "Disable")]
    [InlineData("LambdaController", "Disable")]
    [InlineData("QuietController", "Disable")]
    public void AUserChangeThroughDispatchOrADelegateIsBracketedForThePerson(string controller, string action)
    {
        using var probe = Probe.Build(("DispatchProbe", Probes, Array.Empty<string>()));
        var found = Find(JellyfinUserActions.Scan(probe.Path("DispatchProbe")), controller, action);
        Assert.Equal(JellyfinUserKey.User, found.Key);
        Assert.Equal("IUserManager.UpdatePolicyAsync", found.Reaches);
    }

    // Jellyfin's own layout: the interface in one assembly (MediaBrowser.Controller), the controller in another
    // (Jellyfin.Api), the implementation in a third (Emby.Server.Implementations). Round 9 read the controller's alone.
    [Fact]
    public void AUserChangeInAnotherAssemblysImplementationIsBracketed()
    {
        using var probe = Probe.Build(
            ("ProbeContracts", Usings + "\npublic interface IMembership { Task Disable(Guid userId); }", Array.Empty<string>()),
            ("ProbeApi", Usings + "\npublic sealed class CrossController(IMembership members) : ControllerBase {\n  [HttpPost] public Task Disable(Guid userId) => members.Disable(userId);\n  [HttpPost] public Task Nothing() => Task.CompletedTask;\n}", new[] { "ProbeContracts" }),
            ("ProbeServer", Usings + "\npublic sealed class Membership(IUserManager users) : IMembership {\n  public Task Disable(Guid userId) => users.UpdatePolicyAsync(userId, new UserPolicy { IsDisabled = true });\n}", new[] { "ProbeContracts" }));
        var scanned = JellyfinUserActions.Scan(probe.Path("ProbeApi"));
        var found = Find(scanned, "CrossController", "Disable");
        Assert.Equal(JellyfinUserKey.User, found.Key);
        Assert.Equal("IUserManager.UpdatePolicyAsync", found.Reaches);
        Assert.Equal(JellyfinUserKey.None, Find(scanned, "CrossController", "Nothing").Key);
    }

    // Unresolved (an interface nothing read implements; a delegate handed in from outside): a write is bracketed for
    // everyone, a GET isn't (it would hold automation on every page view).
    [Theory]
    [InlineData("UnresolvedController", "Disable", JellyfinUserKey.Global)]
    [InlineData("UnresolvedController", "Peek", JellyfinUserKey.None)]
    [InlineData("InjectedDelegateController", "Disable", JellyfinUserKey.Global)]
    [InlineData("QuietController", "Note", JellyfinUserKey.None)]
    public void WhatStaysUnresolvedBracketsAWriteForEveryone(string controller, string action, JellyfinUserKey expected)
    {
        using var probe = Probe.Build(("DispatchProbe", Probes, Array.Empty<string>()));
        var found = Find(JellyfinUserActions.Scan(probe.Path("DispatchProbe")), controller, action);
        Assert.Equal(expected, found.Key);
        Assert.Null(found.Reaches);
        if (expected == JellyfinUserKey.Global) Assert.StartsWith("unresolved ", found.Why, StringComparison.Ordinal);
    }

    // 4a review round 11 (4a-security-r11-1): a SEALED override is still an override. C# emits `sealed override` as a
    // virtual method marked final; round 10 read final as "not virtual" and left it out of the base slot's dispatch, so a
    // POST calling a concrete base class's harmless virtual reached nothing (the reviewer's probe: Key None). The same
    // through an abstract base (unresolved: everyone, instead of the person), through an interface whose implementation
    // calls a protected virtual the sealed override replaces, and an interface implemented by a base virtual that a
    // subclass seals.
    private const string SealedProbes = Usings + """

        public class ConcreteChanges { public virtual Task Apply(Guid userId) => Task.CompletedTask; }
        public class SealedChanges(IUserManager users) : ConcreteChanges {
          public sealed override Task Apply(Guid userId) => users.UpdatePolicyAsync(userId, new UserPolicy { IsDisabled = true });
        }
        public sealed class SealedController(ConcreteChanges changes) : ControllerBase {
          [HttpPost] public Task Disable(Guid userId) => changes.Apply(userId);
        }
        public abstract class AbstractChanges { public abstract Task Apply(Guid userId); }
        public class SealedAbstractChanges(IUserManager users) : AbstractChanges {
          public sealed override Task Apply(Guid userId) => users.UpdatePolicyAsync(userId, new UserPolicy { IsDisabled = true });
        }
        public sealed class SealedAbstractController(AbstractChanges changes) : ControllerBase {
          [HttpPost] public Task Disable(Guid userId) => changes.Apply(userId);
        }
        public interface IMembershipChanges { Task Apply(Guid userId); }
        public class MembershipBase : IMembershipChanges {
          public Task Apply(Guid userId) => ApplyCore(userId);
          protected virtual Task ApplyCore(Guid userId) => Task.CompletedTask;
        }
        public class SealedMembership(IUserManager users) : MembershipBase {
          protected sealed override Task ApplyCore(Guid userId) => users.UpdatePolicyAsync(userId, new UserPolicy { IsDisabled = true });
        }
        public sealed class SealedInterfaceController(IMembershipChanges changes) : ControllerBase {
          [HttpPost] public Task Disable(Guid userId) => changes.Apply(userId);
        }
        public interface ISealedChanges { Task Apply(Guid userId); }
        public class SealedBase : ISealedChanges { public virtual Task Apply(Guid userId) => Task.CompletedTask; }
        public class SealedImplementation(IUserManager users) : SealedBase {
          public sealed override Task Apply(Guid userId) => users.UpdatePolicyAsync(userId, new UserPolicy { IsDisabled = true });
        }
        public sealed class SealedDirectInterfaceController(ISealedChanges changes) : ControllerBase {
          [HttpPost] public Task Disable(Guid userId) => changes.Apply(userId);
        }
        public sealed class SealedQuietController(ConcreteChanges changes) : ControllerBase {
          [HttpPost] public Task Note() => Task.CompletedTask;
        }
        """;

    [Theory]
    [InlineData("SealedController", "Disable")]
    [InlineData("SealedAbstractController", "Disable")]
    [InlineData("SealedInterfaceController", "Disable")]
    [InlineData("SealedDirectInterfaceController", "Disable")]
    public void ASealedOverrideIsReachedThroughItsBaseSlot(string controller, string action)
    {
        using var probe = Probe.Build(("SealedProbe", SealedProbes, Array.Empty<string>()));
        var scanned = JellyfinUserActions.Scan(probe.Path("SealedProbe"));
        var found = Find(scanned, controller, action);
        Assert.Equal(JellyfinUserKey.User, found.Key);
        Assert.Equal("IUserManager.UpdatePolicyAsync", found.Reaches);
        Assert.Equal(JellyfinUserKey.None, Find(scanned, "SealedQuietController", "Note").Key);
    }

    // The reviewer's probe, run for real: the compiled controller does disable the person through the sealed override.
    [Fact]
    public async Task TheSealedOverrideProbeReallyDisablesThePerson()
    {
        using var probe = Probe.Build(("SealedProbe", SealedProbes, Array.Empty<string>()));
        var person = Guid.NewGuid();
        var (users, disabled) = Users(person);
        var assembly = probe.Load("SealedProbe");
        var changes = Activator.CreateInstance(assembly.GetType("SealedChanges")!, users)!;
        var controller = Activator.CreateInstance(assembly.GetType("SealedController")!, changes)!;
        await (Task)controller.GetType().GetMethod("Disable")!.Invoke(controller, new object[] { person })!;
        Assert.Equal(1, disabled());
        Assert.NotEqual(JellyfinUserKey.None, Find(JellyfinUserActions.Scan(probe.Path("SealedProbe")), "SealedController", "Disable").Key);
    }

    // 4a review round 12 (4a-security-r12-1): a covariant-return override is an override too. C# emits it as a NEW slot
    // (newslot) plus an explicit `.override` of the base method in its type's MethodImpl table; round 11 left every newslot
    // method out of the base slot's dispatch, so the reviewer's sealed covariant override disabling a user reached nothing
    // (Key None). Sealed and open, through a concrete and an abstract base. A method that only HIDES its base's (`new
    // virtual`, no MethodImpl) is never reached through the base slot, at run time or here: the control.
    private const string CovariantProbes = Usings + """

        public class Receipt { }
        public sealed class PolicyReceipt : Receipt { }
        public class CovariantChanges { public virtual Receipt Apply(Guid userId) => new Receipt(); }
        public class SealedCovariantChanges(IUserManager users) : CovariantChanges {
          public sealed override PolicyReceipt Apply(Guid userId) { _ = users.UpdatePolicyAsync(userId, new UserPolicy { IsDisabled = true }); return new PolicyReceipt(); }
        }
        public sealed class SealedCovariantController(CovariantChanges changes) : ControllerBase {
          [HttpPost] public object Disable(Guid userId) => changes.Apply(userId);
        }
        public class OpenBase { public virtual Receipt Apply(Guid userId) => new Receipt(); }
        public class OpenCovariantChanges(IUserManager users) : OpenBase {
          public override PolicyReceipt Apply(Guid userId) { _ = users.UpdatePolicyAsync(userId, new UserPolicy { IsDisabled = true }); return new PolicyReceipt(); }
        }
        public sealed class OpenCovariantController(OpenBase changes) : ControllerBase {
          [HttpPost] public object Disable(Guid userId) => changes.Apply(userId);
        }
        public abstract class AbstractBase { public abstract Receipt Apply(Guid userId); }
        public class AbstractCovariantChanges(IUserManager users) : AbstractBase {
          public override PolicyReceipt Apply(Guid userId) { _ = users.UpdatePolicyAsync(userId, new UserPolicy { IsDisabled = true }); return new PolicyReceipt(); }
        }
        public sealed class AbstractCovariantController(AbstractBase changes) : ControllerBase {
          [HttpPost] public object Disable(Guid userId) => changes.Apply(userId);
        }
        public class HiddenBase { public virtual Receipt Apply(Guid userId) => new Receipt(); }
        public class HidingChanges(IUserManager users) : HiddenBase {
          public new virtual PolicyReceipt Apply(Guid userId) { _ = users.UpdatePolicyAsync(userId, new UserPolicy { IsDisabled = true }); return new PolicyReceipt(); }
        }
        public sealed class HiddenController(HiddenBase changes) : ControllerBase {
          [HttpPost] public object Disable(Guid userId) => changes.Apply(userId);
        }
        """;

    [Theory]
    [InlineData("SealedCovariantController", "Disable")]
    [InlineData("OpenCovariantController", "Disable")]
    [InlineData("AbstractCovariantController", "Disable")]
    public void ACovariantReturnOverrideIsReachedThroughItsBaseSlot(string controller, string action)
    {
        using var probe = Probe.Build(("CovariantProbe", CovariantProbes, Array.Empty<string>()));
        var found = Find(JellyfinUserActions.Scan(probe.Path("CovariantProbe")), controller, action);
        Assert.Equal(JellyfinUserKey.User, found.Key);
        Assert.Equal("IUserManager.UpdatePolicyAsync", found.Reaches);
    }

    // The control, run for real first: a hiding method isn't what the base slot calls, so the person stays enabled.
    [Fact]
    public void AMethodThatOnlyHidesItsBaseIsNotReachedThroughTheBaseSlot()
    {
        using var probe = Probe.Build(("CovariantProbe", CovariantProbes, Array.Empty<string>()));
        var person = Guid.NewGuid();
        var (users, disabled) = Users(person);
        var assembly = probe.Load("CovariantProbe");
        var changes = Activator.CreateInstance(assembly.GetType("HidingChanges")!, users)!;
        var controller = Activator.CreateInstance(assembly.GetType("HiddenController")!, changes)!;
        controller.GetType().GetMethod("Disable")!.Invoke(controller, new object[] { person });
        Assert.Equal(0, disabled());
        Assert.Equal(JellyfinUserKey.None, Find(JellyfinUserActions.Scan(probe.Path("CovariantProbe")), "HiddenController", "Disable").Key);
    }

    // The reviewer's probe, run for real: the compiled controller does disable the person through the covariant override.
    [Fact]
    public void TheCovariantOverrideProbeReallyDisablesThePerson()
    {
        using var probe = Probe.Build(("CovariantProbe", CovariantProbes, Array.Empty<string>()));
        var person = Guid.NewGuid();
        var (users, disabled) = Users(person);
        var assembly = probe.Load("CovariantProbe");
        var changes = Activator.CreateInstance(assembly.GetType("SealedCovariantChanges")!, users)!;
        var controller = Activator.CreateInstance(assembly.GetType("SealedCovariantController")!, changes)!;
        controller.GetType().GetMethod("Disable")!.Invoke(controller, new object[] { person });
        Assert.Equal(1, disabled());
        Assert.NotEqual(JellyfinUserKey.None, Find(JellyfinUserActions.Scan(probe.Path("CovariantProbe")), "SealedCovariantController", "Disable").Key);
    }

    // 4a review round 13 (4a-security-r13-1): an explicit override is followed whatever its body is called. C# only writes
    // MethodImpl entries whose body keeps the slot's name (covariant returns) or an interface-qualified one; other .NET
    // languages, and any compiler, may map a differently named body to a class slot, a base's base or an interface member.
    // Round 12 matched the body's name, so the reviewer's renamed body (it disables the user when the base slot is called)
    // reached nothing. The bases and controllers are C#; the bodies are emitted with a MethodImpl entry each
    // (PersistedAssemblyBuilder), and the control has a renamed method with no entry, which the base slot never calls.
    private const string ExplicitBases = Usings + """

        public class Result { }
        public class DirectChanges { public virtual Result Apply(Guid userId) => new Result(); }
        public sealed class DirectController(DirectChanges changes) : ControllerBase {
          [HttpPost] public object Disable(Guid userId) => changes.Apply(userId);
        }
        public class TopChanges { public virtual Result Apply(Guid userId) => new Result(); }
        public class MiddleChanges : TopChanges { public override Result Apply(Guid userId) => new Result(); }
        public sealed class DeepController(TopChanges changes) : ControllerBase {
          [HttpPost] public object Disable(Guid userId) => changes.Apply(userId);
        }
        public interface IRenamedChanges { Result Apply(Guid userId); }
        public sealed class InterfaceController(IRenamedChanges changes) : ControllerBase {
          [HttpPost] public object Disable(Guid userId) => changes.Apply(userId);
        }
        public class UnmappedChanges { public virtual Result Apply(Guid userId) => new Result(); }
        public sealed class UnmappedController(UnmappedChanges changes) : ControllerBase {
          [HttpPost] public object Disable(Guid userId) => changes.Apply(userId);
        }
        public abstract class GenericTop<T> { public virtual Result Apply(Guid userId) => new Result(); }
        public abstract class GenericMiddle<T> : GenericTop<T> { public abstract override Result Apply(Guid userId); }
        public sealed class GenericController(GenericTop<int> changes) : ControllerBase {
          [HttpPost] public object Disable(Guid userId) => changes.Apply(userId);
        }
        """;

    // The emitted bodies: (type, base or interface, the slot's declaring type, MethodImpl entry?). The generic one (the
    // behaviour reviewer's shape) maps its body to an abstract middle override of a generic base, instantiated for int,
    // across the two assemblies (a MemberReference whose parent is a type specification).
    private static readonly (string Type, string Base, string Slot, bool Mapped)[] ExplicitBodies =
    {
        ("ActualDirectChanges", "DirectChanges", "DirectChanges", true),
        ("ActualDeepChanges", "MiddleChanges", "TopChanges", true),
        ("ActualInterfaceChanges", "IRenamedChanges", "IRenamedChanges", true),
        ("ActualUnmappedChanges", "UnmappedChanges", "UnmappedChanges", false),
        ("ActualGenericChanges", "GenericMiddle`1", "GenericMiddle`1", true),
    };

    private static Type ProbeType(System.Reflection.Assembly bases, string name)
        => name.Contains('`') ? bases.GetType(name)!.MakeGenericType(typeof(int)) : bases.GetType(name)!;

    // Each body is `ApplyPolicy(Guid)`: users.UpdatePolicyAsync(userId, new UserPolicy { IsDisabled = true }); return new Result().
    private static void EmitExplicitBodies(Probe probe, System.Reflection.Assembly bases)
    {
        var builder = new System.Reflection.Emit.PersistedAssemblyBuilder(new System.Reflection.AssemblyName("ExplicitBodies"), typeof(object).Assembly);
        var module = builder.DefineDynamicModule("ExplicitBodies");
        var result = bases.GetType("Result")!;
        var update = typeof(IUserManager).GetMethod(nameof(IUserManager.UpdatePolicyAsync), new[] { typeof(Guid), typeof(UserPolicy) })!;
        foreach (var (name, baseName, slotName, mapped) in ExplicitBodies)
        {
            var baseType = ProbeType(bases, baseName);
            var type = baseType.IsInterface
                ? module.DefineType(name, System.Reflection.TypeAttributes.Public | System.Reflection.TypeAttributes.Class, typeof(object), new[] { baseType })
                : module.DefineType(name, System.Reflection.TypeAttributes.Public | System.Reflection.TypeAttributes.Class, baseType);
            var users = type.DefineField("_users", typeof(IUserManager), System.Reflection.FieldAttributes.Private);
            var ctor = type.DefineConstructor(System.Reflection.MethodAttributes.Public, System.Reflection.CallingConventions.Standard, new[] { typeof(IUserManager) });
            var il = ctor.GetILGenerator();
            il.Emit(System.Reflection.Emit.OpCodes.Ldarg_0);
            il.Emit(System.Reflection.Emit.OpCodes.Call, (baseType.IsInterface ? typeof(object) : baseType).GetConstructor(System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.NonPublic, Type.EmptyTypes)!);
            il.Emit(System.Reflection.Emit.OpCodes.Ldarg_0);
            il.Emit(System.Reflection.Emit.OpCodes.Ldarg_1);
            il.Emit(System.Reflection.Emit.OpCodes.Stfld, users);
            il.Emit(System.Reflection.Emit.OpCodes.Ret);
            var attributes = System.Reflection.MethodAttributes.Public | System.Reflection.MethodAttributes.Virtual | System.Reflection.MethodAttributes.HideBySig | System.Reflection.MethodAttributes.NewSlot;
            var body = type.DefineMethod("ApplyPolicy", mapped ? attributes | System.Reflection.MethodAttributes.Final : attributes, result, new[] { typeof(Guid) });
            il = body.GetILGenerator();
            il.Emit(System.Reflection.Emit.OpCodes.Ldarg_0);
            il.Emit(System.Reflection.Emit.OpCodes.Ldfld, users);
            il.Emit(System.Reflection.Emit.OpCodes.Ldarg_1);
            il.Emit(System.Reflection.Emit.OpCodes.Newobj, typeof(UserPolicy).GetConstructor(Type.EmptyTypes)!);
            il.Emit(System.Reflection.Emit.OpCodes.Dup);
            il.Emit(System.Reflection.Emit.OpCodes.Ldc_I4_1);
            il.Emit(System.Reflection.Emit.OpCodes.Callvirt, typeof(UserPolicy).GetProperty(nameof(UserPolicy.IsDisabled))!.SetMethod!);
            il.Emit(System.Reflection.Emit.OpCodes.Callvirt, update);
            il.Emit(System.Reflection.Emit.OpCodes.Pop);
            il.Emit(System.Reflection.Emit.OpCodes.Newobj, result.GetConstructor(Type.EmptyTypes)!);
            il.Emit(System.Reflection.Emit.OpCodes.Ret);
            if (mapped) type.DefineMethodOverride(body, ProbeType(bases, slotName).GetMethod("Apply")!);
            type.CreateType();
        }

        builder.Save(probe.Path("ExplicitBodies"));
    }

    private static Probe ExplicitProbe(out System.Reflection.Assembly bases)
    {
        var probe = Probe.Build(("ExplicitBases", ExplicitBases, Array.Empty<string>()));
        bases = probe.Load("ExplicitBases");
        EmitExplicitBodies(probe, bases);
        return probe;
    }

    [Theory]
    [InlineData("DirectController", "Disable")]
    [InlineData("DeepController", "Disable")]
    [InlineData("InterfaceController", "Disable")]
    [InlineData("GenericController", "Disable")]
    public void AnExplicitOverrideIsFollowedWhateverItsBodyIsCalled(string controller, string action)
    {
        using var probe = ExplicitProbe(out _);
        var scanned = JellyfinUserActions.Scan(probe.Path("ExplicitBases"));
        var found = Find(scanned, controller, action);
        Assert.Equal(JellyfinUserKey.User, found.Key);
        Assert.Equal("IUserManager.UpdatePolicyAsync", found.Reaches);
        Assert.Equal(JellyfinUserKey.None, Find(scanned, "UnmappedController", "Disable").Key);
    }

    // Run for real: each mapped body is what its slot calls (the person is disabled); the unmapped one is never called.
    [Theory]
    [InlineData("ActualDirectChanges", "DirectController", 1)]
    [InlineData("ActualDeepChanges", "DeepController", 1)]
    [InlineData("ActualInterfaceChanges", "InterfaceController", 1)]
    [InlineData("ActualUnmappedChanges", "UnmappedController", 0)]
    [InlineData("ActualGenericChanges", "GenericController", 1)]
    public void TheExplicitOverrideProbesReallyDoWhatTheScanSays(string body, string controller, int disables)
    {
        using var probe = ExplicitProbe(out _);
        var context = new System.Runtime.Loader.AssemblyLoadContext("explicit-" + Guid.NewGuid().ToString("N"), isCollectible: true);
        var bases = context.LoadFromStream(new MemoryStream(File.ReadAllBytes(probe.Path("ExplicitBases"))));
        context.Resolving += (_, name) => name.Name == "ExplicitBases" ? bases : null;
        var bodies = context.LoadFromStream(new MemoryStream(File.ReadAllBytes(probe.Path("ExplicitBodies"))));
        var person = Guid.NewGuid();
        var (users, disabled) = Users(person);
        var changes = Activator.CreateInstance(bodies.GetType(body)!, users)!;
        var instance = Activator.CreateInstance(bases.GetType(controller)!, changes)!;
        instance.GetType().GetMethod("Disable")!.Invoke(instance, new object[] { person });
        Assert.Equal(disables, disabled());
        var key = Find(JellyfinUserActions.Scan(probe.Path("ExplicitBases")), controller, "Disable").Key;
        Assert.Equal(disables == 1, key != JellyfinUserKey.None);
    }

    // 4a review round 14 (4a-security-r14-1): a call to an INTERFACE member reaches its implementations whatever the
    // instruction. C# 11 calls a static abstract or static virtual interface member as `constrained. T call I::M`; round 13
    // dispatched only callvirt and ldvirtftn, so the reviewer's generic runner reached the declaration (no body) and the
    // implementation that disables the user was never read (Key None). A plain `call` to a CLASS method stays non-virtual
    // (`base.M()`), as the runtime runs it.
    private const string StaticProbes = Usings + """

        public interface IStaticChanges { static abstract Task Apply(IUserManager users, Guid userId); }
        public sealed class StaticChanges : IStaticChanges {
          public static Task Apply(IUserManager users, Guid userId) => users.UpdatePolicyAsync(userId, new UserPolicy { IsDisabled = true });
        }
        public static class StaticRunner { public static Task Run<T>(IUserManager users, Guid userId) where T : IStaticChanges => T.Apply(users, userId); }
        public sealed class StaticAbstractController(IUserManager users) : ControllerBase {
          [HttpPost] public Task Disable(Guid userId) => StaticRunner.Run<StaticChanges>(users, userId);
        }
        public interface IStaticVirtualChanges { static virtual Task Apply(IUserManager users, Guid userId) => Task.CompletedTask; }
        public sealed class StaticVirtualChanges : IStaticVirtualChanges {
          public static Task Apply(IUserManager users, Guid userId) => users.UpdatePolicyAsync(userId, new UserPolicy { IsDisabled = true });
        }
        public static class StaticVirtualRunner { public static Task Run<T>(IUserManager users, Guid userId) where T : IStaticVirtualChanges => T.Apply(users, userId); }
        public sealed class StaticVirtualController(IUserManager users) : ControllerBase {
          [HttpPost] public Task Disable(Guid userId) => StaticVirtualRunner.Run<StaticVirtualChanges>(users, userId);
        }
        public interface IExplicitStaticChanges { static abstract Task Apply(IUserManager users, Guid userId); }
        public sealed class ExplicitStaticChanges : IExplicitStaticChanges {
          static Task IExplicitStaticChanges.Apply(IUserManager users, Guid userId) => users.UpdatePolicyAsync(userId, new UserPolicy { IsDisabled = true });
        }
        public static class ExplicitStaticRunner { public static Task Run<T>(IUserManager users, Guid userId) where T : IExplicitStaticChanges => T.Apply(users, userId); }
        public sealed class ExplicitStaticController(IUserManager users) : ControllerBase {
          [HttpPost] public Task Disable(Guid userId) => ExplicitStaticRunner.Run<ExplicitStaticChanges>(users, userId);
        }
        public interface IQuietStaticChanges { static abstract Task Apply(IUserManager users, Guid userId); }
        public sealed class QuietStaticChanges : IQuietStaticChanges { public static Task Apply(IUserManager users, Guid userId) => Task.CompletedTask; }
        public static class QuietStaticRunner { public static Task Run<T>(IUserManager users, Guid userId) where T : IQuietStaticChanges => T.Apply(users, userId); }
        public sealed class QuietStaticController(IUserManager users) : ControllerBase {
          [HttpPost] public Task Note(Guid userId) => QuietStaticRunner.Run<QuietStaticChanges>(users, userId);
        }
        public class BaseCallChanges(IUserManager users) { public virtual Task Apply(Guid userId) => Task.CompletedTask; protected IUserManager Users => users; }
        public sealed class BaseCallDerived(IUserManager users) : BaseCallChanges(users) {
          public override Task Apply(Guid userId) => Users.UpdatePolicyAsync(userId, new UserPolicy { IsDisabled = true });
          public Task Quiet(Guid userId) => base.Apply(userId);
        }
        public sealed class BaseCallController(BaseCallDerived changes) : ControllerBase {
          [HttpPost] public Task Note(Guid userId) => changes.Quiet(userId);
        }
        """;

    [Theory]
    [InlineData("StaticAbstractController", "Disable")]
    [InlineData("StaticVirtualController", "Disable")]
    [InlineData("ExplicitStaticController", "Disable")]
    public void AStaticInterfaceMemberIsFollowedToItsImplementations(string controller, string action)
    {
        using var probe = Probe.Build(("StaticProbe", StaticProbes, Array.Empty<string>()));
        var scanned = JellyfinUserActions.Scan(probe.Path("StaticProbe"));
        var found = Find(scanned, controller, action);
        Assert.Equal(JellyfinUserKey.User, found.Key);
        Assert.Equal("IUserManager.UpdatePolicyAsync", found.Reaches);
        Assert.Equal(JellyfinUserKey.None, Find(scanned, "QuietStaticController", "Note").Key);
        // `base.Apply()` is a plain call to a class method: the runtime runs that method only, not the override.
        Assert.Equal(JellyfinUserKey.None, Find(scanned, "BaseCallController", "Note").Key);
    }

    // Run for real: each generic runner really disables the person through the implementation; the controls don't.
    [Theory]
    [InlineData("StaticAbstractController", "Disable", 1)]
    [InlineData("StaticVirtualController", "Disable", 1)]
    [InlineData("ExplicitStaticController", "Disable", 1)]
    [InlineData("QuietStaticController", "Note", 0)]
    public async Task TheStaticInterfaceProbesReallyDoWhatTheScanSays(string controller, string action, int disables)
    {
        using var probe = Probe.Build(("StaticProbe", StaticProbes, Array.Empty<string>()));
        var person = Guid.NewGuid();
        var (users, disabled) = Users(person);
        var assembly = probe.Load("StaticProbe");
        var instance = Activator.CreateInstance(assembly.GetType(controller)!, users)!;
        await (Task)instance.GetType().GetMethod(action)!.Invoke(instance, new object[] { person })!;
        Assert.Equal(disables, disabled());
        var key = Find(JellyfinUserActions.Scan(probe.Path("StaticProbe")), controller, action).Key;
        Assert.Equal(disables == 1, key != JellyfinUserKey.None);
    }

    // The base-call control, run for real: `base.Apply()` from the derived class runs the harmless base method.
    [Fact]
    public async Task ABaseCallRunsOnlyTheBaseMethod()
    {
        using var probe = Probe.Build(("StaticProbe", StaticProbes, Array.Empty<string>()));
        var person = Guid.NewGuid();
        var (users, disabled) = Users(person);
        var assembly = probe.Load("StaticProbe");
        var changes = Activator.CreateInstance(assembly.GetType("BaseCallDerived")!, users)!;
        var instance = Activator.CreateInstance(assembly.GetType("BaseCallController")!, changes)!;
        await (Task)instance.GetType().GetMethod("Note")!.Invoke(instance, new object[] { person })!;
        Assert.Equal(0, disabled());
    }

    // 4a review round 15 (4a-security-r15-1/-2): every way compiled code hands control to other code is followed, the
    // implicit ones included. A function pointer (`delegate*`) stored in a field and invoked with calli is tracked like a
    // stored delegate; an indirect call through a pointer the reading didn't see being made counts as a possible change.
    // The runtime runs a type's static constructor before the type's first use (a static call, a static field, newobj),
    // so a use reaches it. Round 14 followed neither: the reviewer's stored-pointer controller and cold-type controller
    // disabled the person with Key None.
    private const string IndirectProbes = Usings + """

        public static class PolicyCalls {
          public static Task Disable(IUserManager users, Guid userId) => users.UpdatePolicyAsync(userId, new UserPolicy { IsDisabled = true });
          public static Task Quiet(IUserManager users, Guid userId) => Task.CompletedTask;
        }
        public sealed unsafe class StoredPointerController : ControllerBase {
          private readonly IUserManager _users; private readonly delegate* managed<IUserManager, Guid, Task> _apply;
          public StoredPointerController(IUserManager users) { _users = users; _apply = &PolicyCalls.Disable; }
          [HttpPost] public Task Disable(Guid userId) => _apply(_users, userId);
        }
        public sealed unsafe class LocalPointerController(IUserManager users) : ControllerBase {
          [HttpPost] public Task Disable(Guid userId) { delegate* managed<IUserManager, Guid, Task> apply = &PolicyCalls.Disable; return apply(users, userId); }
        }
        public sealed unsafe class QuietPointerController : ControllerBase {
          private readonly IUserManager _users; private readonly delegate* managed<IUserManager, Guid, Task> _apply;
          public QuietPointerController(IUserManager users) { _users = users; _apply = &PolicyCalls.Quiet; }
          [HttpPost] public Task Note(Guid userId) => _apply(_users, userId);
        }
        public static class LazySetup { public static IUserManager? Users; public static Guid Person; }
        public static class LazyCall {
          static LazyCall() { LazySetup.Users?.UpdatePolicyAsync(LazySetup.Person, new UserPolicy { IsDisabled = true }); }
          public static void Touch() { }
        }
        public static class LazyField {
          public static readonly int Value;
          static LazyField() { LazySetup.Users?.UpdatePolicyAsync(LazySetup.Person, new UserPolicy { IsDisabled = true }); Value = 1; }
        }
        public sealed class LazyObject {
          static LazyObject() { LazySetup.Users?.UpdatePolicyAsync(LazySetup.Person, new UserPolicy { IsDisabled = true }); }
        }
        public static class QuietLazy { static QuietLazy() { LazySetup.Person = LazySetup.Person; } public static void Touch() { } }
        public sealed class ColdCallController : ControllerBase { [HttpPost] public void Disable() => LazyCall.Touch(); }
        public sealed class ColdFieldController : ControllerBase { [HttpPost] public int Disable() => LazyField.Value; }
        public sealed class ColdObjectController : ControllerBase { [HttpPost] public object Disable() => new LazyObject(); }
        public sealed class QuietColdController : ControllerBase { [HttpPost] public void Note() => QuietLazy.Touch(); }
        """;

    [Theory]
    [InlineData("StoredPointerController", "Disable")]
    [InlineData("LocalPointerController", "Disable")]
    [InlineData("ColdCallController", "Disable")]
    [InlineData("ColdFieldController", "Disable")]
    [InlineData("ColdObjectController", "Disable")]
    public void FunctionPointersAndTypeInitializersAreFollowed(string controller, string action)
    {
        using var probe = Probe.Build(("IndirectProbe", IndirectProbes, Array.Empty<string>()));
        var found = Find(JellyfinUserActions.Scan(probe.Path("IndirectProbe")), controller, action);
        Assert.NotEqual(JellyfinUserKey.None, found.Key);
        Assert.Equal("IUserManager.UpdatePolicyAsync", found.Reaches);
    }

    // The controls: a harmless static constructor stays unbracketed; ANY indirect call (calli) is bracketed, even one whose
    // pointer happens to be harmless (fail closed: Jellyfin 12.2 and 10.11.11 have none).
    [Fact]
    public void AHarmlessTypeInitializerStaysUnbracketedAndAnyIndirectCallIsBracketed()
    {
        using var probe = Probe.Build(("IndirectProbe", IndirectProbes, Array.Empty<string>()));
        var scanned = JellyfinUserActions.Scan(probe.Path("IndirectProbe"));
        Assert.Equal(JellyfinUserKey.None, Find(scanned, "QuietColdController", "Note").Key);
        var quietPointer = Find(scanned, "QuietPointerController", "Note");
        Assert.NotEqual(JellyfinUserKey.None, quietPointer.Key);
        Assert.Null(quietPointer.Reaches);
    }

    // Run for real: each one disables the person once (the static constructor on the type's first use); the controls don't.
    // Whatever really disables the person is bracketed; the harmless indirect call is bracketed too (fail closed).
    [Theory]
    [InlineData("StoredPointerController", "Disable", true, 1, true)]
    [InlineData("LocalPointerController", "Disable", true, 1, true)]
    [InlineData("QuietPointerController", "Note", true, 0, true)]
    [InlineData("ColdCallController", "Disable", false, 1, true)]
    [InlineData("ColdFieldController", "Disable", false, 1, true)]
    [InlineData("ColdObjectController", "Disable", false, 1, true)]
    [InlineData("QuietColdController", "Note", false, 0, false)]
    public async Task TheIndirectProbesReallyDoWhatTheScanSays(string controller, string action, bool takesUsers, int disables, bool bracketed)
    {
        using var probe = Probe.Build(("IndirectProbe", IndirectProbes, Array.Empty<string>()));
        var person = Guid.NewGuid();
        var (users, disabled) = Users(person);
        var assembly = probe.Load("IndirectProbe");
        var setup = assembly.GetType("LazySetup")!;
        setup.GetField("Users")!.SetValue(null, users);
        setup.GetField("Person")!.SetValue(null, person);
        var instance = takesUsers ? Activator.CreateInstance(assembly.GetType(controller)!, users)! : Activator.CreateInstance(assembly.GetType(controller)!)!;
        var method = instance.GetType().GetMethod(action)!;
        var result = method.Invoke(instance, method.GetParameters().Length == 1 ? new object[] { person } : null);
        if (result is Task task) await task;
        Assert.Equal(disables, disabled());
        var key = Find(JellyfinUserActions.Scan(probe.Path("IndirectProbe")), controller, action).Key;
        Assert.Equal(bracketed, key != JellyfinUserKey.None);
    }

    // 4a review round 16 (4a-security-r16-1/-2): the listed transfers, implemented in full. A static abstract call runs the
    // IMPLEMENTING type's static method, so that type's static constructor runs too (round 15 only added the interface's);
    // and an override 19 levels below the called slot is reached (round 15 cut type graphs at 16 levels, silently).
    private const string BoundaryProbes = Usings + """

        public static class ColdSetup { public static IUserManager? Users; public static Guid Person; }
        public interface IColdChanges { static abstract void Touch(); }
        public sealed class ActualCold : IColdChanges {
          static ActualCold() { ColdSetup.Users?.UpdatePolicyAsync(ColdSetup.Person, new UserPolicy { IsDisabled = true }); }
          public static void Touch() { }
        }
        public sealed class ExplicitCold : IColdChanges {
          static ExplicitCold() { ColdSetup.Users?.UpdatePolicyAsync(ColdSetup.Person, new UserPolicy { IsDisabled = true }); }
          static void IColdChanges.Touch() { }
        }
        public static class ColdRunner { public static void Run<T>() where T : IColdChanges => T.Touch(); }
        public sealed class ColdImplementationController : ControllerBase { [HttpPost] public void Disable() => ColdRunner.Run<ActualCold>(); }
        public sealed class ColdExplicitController : ControllerBase { [HttpPost] public void Disable() => ColdRunner.Run<ExplicitCold>(); }
        public class Deep0(IUserManager users) { protected IUserManager Users => users; public virtual Task Touch(Guid userId) => Task.CompletedTask; }
        public class Deep1(IUserManager users) : Deep0(users) { }
        public class Deep2(IUserManager users) : Deep1(users) { }
        public class Deep3(IUserManager users) : Deep2(users) { }
        public class Deep4(IUserManager users) : Deep3(users) { }
        public class Deep5(IUserManager users) : Deep4(users) { }
        public class Deep6(IUserManager users) : Deep5(users) { }
        public class Deep7(IUserManager users) : Deep6(users) { }
        public class Deep8(IUserManager users) : Deep7(users) { }
        public class Deep9(IUserManager users) : Deep8(users) { }
        public class Deep10(IUserManager users) : Deep9(users) { }
        public class Deep11(IUserManager users) : Deep10(users) { }
        public class Deep12(IUserManager users) : Deep11(users) { }
        public class Deep13(IUserManager users) : Deep12(users) { }
        public class Deep14(IUserManager users) : Deep13(users) { }
        public class Deep15(IUserManager users) : Deep14(users) { }
        public class Deep16(IUserManager users) : Deep15(users) { }
        public class Deep17(IUserManager users) : Deep16(users) { }
        public class Deep18(IUserManager users) : Deep17(users) { }
        public class Deep19(IUserManager users) : Deep18(users) { public override Task Touch(Guid userId) => Users.UpdatePolicyAsync(userId, new UserPolicy { IsDisabled = true }); }
        public sealed class DeepController(Deep0 changes) : ControllerBase { [HttpPost] public Task Disable(Guid userId) => changes.Touch(userId); }
        """;

    [Theory]
    [InlineData("ColdImplementationController", "Disable")]
    [InlineData("ColdExplicitController", "Disable")]
    [InlineData("DeepController", "Disable")]
    public void DispatchedInitializersAndDeepOverridesAreFollowed(string controller, string action)
    {
        using var probe = Probe.Build(("BoundaryProbe", BoundaryProbes, Array.Empty<string>()));
        var found = Find(JellyfinUserActions.Scan(probe.Path("BoundaryProbe")), controller, action);
        Assert.NotEqual(JellyfinUserKey.None, found.Key);
        Assert.Equal("IUserManager.UpdatePolicyAsync", found.Reaches);
    }

    // Run for real: each disables the person once, and the scan brackets it.
    [Theory]
    [InlineData("ColdImplementationController", false)]
    [InlineData("ColdExplicitController", false)]
    [InlineData("DeepController", true)]
    public async Task TheBoundaryProbesReallyDisableThePerson(string controller, bool deep)
    {
        using var probe = Probe.Build(("BoundaryProbe", BoundaryProbes, Array.Empty<string>()));
        var person = Guid.NewGuid();
        var (users, disabled) = Users(person);
        var assembly = probe.Load("BoundaryProbe");
        var setup = assembly.GetType("ColdSetup")!;
        setup.GetField("Users")!.SetValue(null, users);
        setup.GetField("Person")!.SetValue(null, person);
        var instance = deep
            ? Activator.CreateInstance(assembly.GetType(controller)!, Activator.CreateInstance(assembly.GetType("Deep19")!, users))!
            : Activator.CreateInstance(assembly.GetType(controller)!)!;
        var method = instance.GetType().GetMethod("Disable")!;
        var result = method.Invoke(instance, method.GetParameters().Length == 1 ? new object[] { person } : null);
        if (result is Task task) await task;
        Assert.Equal(1, disabled());
        Assert.NotEqual(JellyfinUserKey.None, Find(JellyfinUserActions.Scan(probe.Path("BoundaryProbe")), controller, "Disable").Key);
    }

    // 4a review round 16 (4a-behaviour-r16-2): a module's initializer runs before ANY access to the module, a static field of
    // a type without a static constructor included (round 15 linked it only from the module's own method bodies). Three
    // assemblies: the setup, the module with the initializer and a field-only type, and the controllers reading it.
    private const string ModuleSetupSource = Usings + """

        public static class ModuleSetup { public static IUserManager? Users; public static Guid Person; }
        """;

    private const string ModuleDataSource = Usings + """

        public static class FieldOnly { public static int Value; }
        internal static class ModuleStart {
          [System.Runtime.CompilerServices.ModuleInitializer]
          internal static void Run() { ModuleSetup.Users?.UpdatePolicyAsync(ModuleSetup.Person, new UserPolicy { IsDisabled = true }); }
        }
        """;

    private const string ModuleApiSource = Usings + """

        public sealed class ModuleFieldController : ControllerBase { [HttpPost] public int Disable() => FieldOnly.Value; }
        public sealed class ModuleTokenController : ControllerBase { [HttpPost] public string Disable() => typeof(FieldOnly).Name; }
        public sealed class ModuleQuietController : ControllerBase { [HttpPost] public int Note() => 1; }
        """;

    private static Probe ModuleProbe() => Probe.Build(
        ("ModuleSetup", ModuleSetupSource, Array.Empty<string>()),
        ("ModuleData", ModuleDataSource, new[] { "ModuleSetup" }),
        ("ModuleApi", ModuleApiSource, new[] { "ModuleData" }));

    [Fact]
    public void AModuleInitializerIsReachedByAnyAccessToItsModule()
    {
        using var probe = ModuleProbe();
        var scanned = JellyfinUserActions.Scan(probe.Path("ModuleApi"));
        foreach (var controller in new[] { "ModuleFieldController", "ModuleTokenController" })
        {
            var found = Find(scanned, controller, "Disable");
            Assert.NotEqual(JellyfinUserKey.None, found.Key);
            Assert.Equal("IUserManager.UpdatePolicyAsync", found.Reaches);
        }

        Assert.Equal(JellyfinUserKey.None, Find(scanned, "ModuleQuietController", "Note").Key);
    }

    // Run for real: reading the field loads the module and runs its initializer, which disables the person once.
    [Fact]
    public void TheModuleFieldProbeReallyDisablesThePerson()
    {
        using var probe = ModuleProbe();
        var person = Guid.NewGuid();
        var (users, disabled) = Users(person);
        var context = new System.Runtime.Loader.AssemblyLoadContext("module-" + Guid.NewGuid().ToString("N"), isCollectible: true);
        var loaded = new Dictionary<string, System.Reflection.Assembly>(StringComparer.Ordinal);
        System.Reflection.Assembly Load(string name)
        {
            if (!loaded.TryGetValue(name, out var assembly))
                loaded[name] = assembly = context.LoadFromStream(new MemoryStream(File.ReadAllBytes(probe.Path(name))));
            return assembly;
        }

        context.Resolving += (_, name) => name.Name is "ModuleSetup" or "ModuleData" ? Load(name.Name) : null;
        var setup = Load("ModuleSetup").GetType("ModuleSetup")!;
        setup.GetField("Users")!.SetValue(null, users);
        setup.GetField("Person")!.SetValue(null, person);
        var instance = Activator.CreateInstance(Load("ModuleApi").GetType("ModuleFieldController")!)!;
        instance.GetType().GetMethod("Disable")!.Invoke(instance, null);
        Assert.Equal(1, disabled());
        Assert.NotEqual(JellyfinUserKey.None, Find(JellyfinUserActions.Scan(probe.Path("ModuleApi")), "ModuleFieldController", "Disable").Key);
    }

    // 4a review round 17 (4a-security-r17-1/-2): a virtual call to a slot DECLARED outside the code read runs the code read's
    // implementations (IProgress<T>.Report, IComparer<T>.Compare…), and a delegate kept in a field typed by a generic
    // parameter (`T`) is followed to what the code read stores in it. Round 16 dropped both (Key None). Object-lifecycle
    // slots (IDisposable.Dispose, object.ToString…) are a STATED LIMIT, not followed: a call site can't tell which object
    // it disposes, so following them reached every Dispose in Jellyfin (bracketing playback pings); Jellyfin's own
    // lifecycle members change no user (pinned sets).
    private const string FrameworkSlotProbes = Usings + """

        public sealed class ReportingChanges(IUserManager users) : IProgress<Guid> {
          public void Report(Guid userId) { _ = users.UpdatePolicyAsync(userId, new UserPolicy { IsDisabled = true }); }
        }
        public sealed class ExplicitReportingChanges(IUserManager users) : IObserver<Guid> {
          void IObserver<Guid>.OnNext(Guid userId) { _ = users.UpdatePolicyAsync(userId, new UserPolicy { IsDisabled = true }); }
          void IObserver<Guid>.OnCompleted() { }
          void IObserver<Guid>.OnError(Exception error) { }
        }
        public sealed class DisposingChanges(IUserManager users, Guid person) : IDisposable {
          public void Dispose() { _ = users.UpdatePolicyAsync(person, new UserPolicy { IsDisabled = true }); }
        }
        public sealed class ProgressController(IProgress<Guid> progress) : ControllerBase { [HttpPost] public void Disable(Guid userId) => progress.Report(userId); }
        public sealed class ObserverController(IObserver<Guid> observer) : ControllerBase { [HttpPost] public void Disable(Guid userId) => observer.OnNext(userId); }
        public sealed class DisposeController(IDisposable resource) : ControllerBase { [HttpPost] public void Disable() => resource.Dispose(); }
        public sealed class CloneController(ICloneable value) : ControllerBase { [HttpPost] public object Note() => value.Clone(); }
        public sealed class Slot<T> { private T? _value; public void Store(T value) => _value = value; public T Load() => _value!; }
        public sealed class GenericSlotController(Slot<Action> slot, IUserManager users) : ControllerBase {
          [HttpPost] public void Arm(Guid userId) => slot.Store(() => { _ = users.UpdatePolicyAsync(userId, new UserPolicy { IsDisabled = true }); });
          [HttpPost] public void Fire() => slot.Load()();
        }
        """;

    [Theory]
    [InlineData("ProgressController", "Disable")]
    [InlineData("ObserverController", "Disable")]
    [InlineData("GenericSlotController", "Fire")]
    public void FrameworkSlotsAndGenericFieldsAreFollowed(string controller, string action)
    {
        using var probe = Probe.Build(("FrameworkProbe", FrameworkSlotProbes, Array.Empty<string>()));
        var scanned = JellyfinUserActions.Scan(probe.Path("FrameworkProbe"));
        var found = Find(scanned, controller, action);
        Assert.NotEqual(JellyfinUserKey.None, found.Key);
        Assert.Equal("IUserManager.UpdatePolicyAsync", found.Reaches);
        // A framework slot nothing in the code read fills reaches nothing.
        Assert.Equal(JellyfinUserKey.None, Find(scanned, "CloneController", "Note").Key);
    }

    // The stated limit, pinned so a change to it is deliberate: a lifecycle slot declared outside the code read isn't
    // followed (the probe really disables the person; the scan says None, as Known limits documents).
    [Fact]
    public void ALifecycleSlotDeclaredOutsideTheCodeReadIsAStatedLimit()
    {
        using var probe = Probe.Build(("FrameworkProbe", FrameworkSlotProbes, Array.Empty<string>()));
        Assert.Equal(JellyfinUserKey.None, Find(JellyfinUserActions.Scan(probe.Path("FrameworkProbe")), "DisposeController", "Disable").Key);
    }

    // Run for real: each one disables the person once through the framework slot or the generic field.
    [Theory]
    [InlineData("ProgressController")]
    [InlineData("ObserverController")]
    [InlineData("GenericSlotController")]
    public void TheFrameworkSlotProbesReallyDisableThePerson(string controller)
    {
        using var probe = Probe.Build(("FrameworkProbe", FrameworkSlotProbes, Array.Empty<string>()));
        var person = Guid.NewGuid();
        var (users, disabled) = Users(person);
        var assembly = probe.Load("FrameworkProbe");
        object instance;
        string action;
        if (controller == "GenericSlotController")
        {
            var slot = Activator.CreateInstance(assembly.GetType("Slot`1")!.MakeGenericType(typeof(Action)))!;
            instance = Activator.CreateInstance(assembly.GetType(controller)!, slot, users)!;
            instance.GetType().GetMethod("Arm")!.Invoke(instance, new object[] { person });
            Assert.Equal(0, disabled());
            instance.GetType().GetMethod("Fire")!.Invoke(instance, null);
            action = "Fire";
        }
        else
        {
            var target = controller == "ProgressController" ? "ReportingChanges" : "ExplicitReportingChanges";
            var changes = Activator.CreateInstance(assembly.GetType(target)!, users)!;
            instance = Activator.CreateInstance(assembly.GetType(controller)!, changes)!;
            instance.GetType().GetMethod("Disable")!.Invoke(instance, new object[] { person });
            action = "Disable";
        }

        Assert.Equal(1, disabled());
        Assert.NotEqual(JellyfinUserKey.None, Find(JellyfinUserActions.Scan(probe.Path("FrameworkProbe")), controller, action).Key);
    }

    // Round 17, the enumeration protocol: a foreach over IEnumerable<T> calls GetEnumerator and MoveNext through slots declared
    // outside the code read, so a hand-written enumerator the code read has is followed through them. A compiler-generated
    // state machine isn't: an iterator's code is followed from the method that creates it (the only code that can hand one
    // out), so enumerating a sequence doesn't reach every iterator in Jellyfin (on 12.2 that bracketed backups, display
    // preferences and playback pings through one iterator). Stated limit: a lazy sequence created by one action and
    // enumerated by another counts where it is created (EnumeratedElsewhereController below; the probe really disables).
    private const string EnumerationProbes = Usings + """

        using System.Collections;
        using System.Collections.Generic;
        public sealed class ChangingSequence(IUserManager users, Guid person) : IEnumerable<Guid> {
          public IEnumerator<Guid> GetEnumerator() => new ChangingCursor(users, person);
          IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();
        }
        public sealed class ChangingCursor(IUserManager users, Guid person) : IEnumerator<Guid> {
          private bool _done;
          public Guid Current => person;
          object IEnumerator.Current => person;
          public bool MoveNext() { if (_done) return false; _done = true; _ = users.UpdatePolicyAsync(person, new UserPolicy { IsDisabled = true }); return true; }
          public void Reset() { }
          public void Dispose() { }
        }
        public sealed class SequenceController(IEnumerable<Guid> people) : ControllerBase {
          [HttpPost] public int Count() { var n = 0; foreach (var _ in people) n++; return n; }
        }
        """;

    private const string IteratorProbes = Usings + """

        using System.Collections.Generic;
        public static class Iterators {
          public static IEnumerable<Guid> Disabling(IUserManager users, Guid person) {
            _ = users.UpdatePolicyAsync(person, new UserPolicy { IsDisabled = true });
            yield return person;
          }
        }
        public sealed class IteratorController(IUserManager users) : ControllerBase {
          [HttpPost] public int Disable(Guid userId) { var n = 0; foreach (var _ in Iterators.Disabling(users, userId)) n++; return n; }
        }
        public sealed class EnumeratedElsewhereController(IEnumerable<Guid> people) : ControllerBase {
          [HttpPost] public int Count() { var n = 0; foreach (var _ in people) n++; return n; }
        }
        """;

    [Fact]
    public void AHandWrittenEnumeratorIsFollowedAndAnIteratorFromWhereItIsCreated()
    {
        // Two folders: a scan reads its assembly's folder, and the stated limit needs no hand-written enumerator in it.
        using var enumeration = Probe.Build(("EnumerationProbe", EnumerationProbes, Array.Empty<string>()));
        using var probe = Probe.Build(("IteratorProbe", IteratorProbes, Array.Empty<string>()));
        var sequence = Find(JellyfinUserActions.Scan(enumeration.Path("EnumerationProbe")), "SequenceController", "Count");
        Assert.NotEqual(JellyfinUserKey.None, sequence.Key);
        Assert.Equal("IUserManager.UpdatePolicyAsync", sequence.Reaches);
        var iterators = JellyfinUserActions.Scan(probe.Path("IteratorProbe"));
        var iterator = Find(iterators, "IteratorController", "Disable");
        Assert.NotEqual(JellyfinUserKey.None, iterator.Key);
        Assert.Equal("IUserManager.UpdatePolicyAsync", iterator.Reaches);
        // The stated limit, pinned so a change to it is deliberate: enumerating a sequence another action created.
        Assert.Equal(JellyfinUserKey.None, Find(iterators, "EnumeratedElsewhereController", "Count").Key);
    }

    // Run for real: each one disables the person once, the stated limit's included.
    [Theory]
    [InlineData("SequenceController")]
    [InlineData("IteratorController")]
    [InlineData("EnumeratedElsewhereController")]
    public void TheEnumerationProbesReallyDisableThePerson(string controller)
    {
        using var probe = Probe.Build(("EnumerationProbe", EnumerationProbes, Array.Empty<string>()), ("IteratorProbe", IteratorProbes, Array.Empty<string>()));
        var person = Guid.NewGuid();
        var (users, disabled) = Users(person);
        switch (controller)
        {
            case "SequenceController":
            {
                var assembly = probe.Load("EnumerationProbe");
                var people = Activator.CreateInstance(assembly.GetType("ChangingSequence")!, users, person)!;
                var instance = Activator.CreateInstance(assembly.GetType(controller)!, people)!;
                Assert.Equal(0, disabled());
                Assert.Equal(1, instance.GetType().GetMethod("Count")!.Invoke(instance, null));
                break;
            }
            case "IteratorController":
            {
                var instance = Activator.CreateInstance(probe.Load("IteratorProbe").GetType(controller)!, users)!;
                Assert.Equal(1, instance.GetType().GetMethod("Disable")!.Invoke(instance, new object[] { person }));
                break;
            }
            default:
            {
                var assembly = probe.Load("IteratorProbe");
                var people = assembly.GetType("Iterators")!.GetMethod("Disabling")!.Invoke(null, new object[] { users, person })!;
                Assert.Equal(0, disabled());
                var instance = Activator.CreateInstance(assembly.GetType(controller)!, people)!;
                Assert.Equal(1, instance.GetType().GetMethod("Count")!.Invoke(instance, null));
                break;
            }
        }

        Assert.Equal(1, disabled());
    }

    // 4a review round 17 (4a-behaviour-r17-1): invoking a delegate is an edge of its own, judged by where the delegate came
    // from (its provenance), not only by a delegate FIELD being loaded. Round 16 followed a delegate made in the body or loaded
    // from a field; one handed in as a parameter, kept in a local or returned by a call reached nothing (Key None while the
    // runtime disables the person). Now: a parameter is what the callers hand it, and nothing visible hands it (DI, model
    // binding, a caller outside the code read) makes it an unresolved callback, judged by its delegate type (round 11); a
    // local is what was stored in it; a call's result is what the callee returns (a pass-through returns what its caller
    // handed it); a delegate handed to code outside the code read (Task.Run) may be invoked there; DynamicInvoke and a
    // method group of Invoke run it too; an array element or a cast from object is what was stored in it. The stated limit
    // (pinned below): a generic parameter's field of a type outside the code read (a tuple's item) is followed only to what
    // the code read stores there (round 17's generic `T` limit); treating it as unknown bracketed Jellyfin 12.2's and
    // 10.11.11's CreateBackup for lambdas the action makes itself. The controls: a
    // parameter every caller fills with a harmless lambda, a pass-through of a harmless method, and a GET (round 11: no
    // bracket for callbacks on a GET).
    private const string InvocationProbes = Usings + """

        public static class Quiet { public static Task Nothing() => Task.CompletedTask; }
        public static class Helpers {
          public static Task Run(Func<Task> work) => work();
          public static Func<Task> Same(Func<Task> work) => work;
        }
        public sealed class ParameterCallbackController : ControllerBase {
          [HttpPost] public Task Disable(Guid userId, [FromServices] Func<Task> callback) => callback();
          [HttpGet] public Task Peek(Guid userId, [FromServices] Func<Task> callback) => callback();
        }
        public sealed class ArgumentCallbackController : ControllerBase {
          [HttpPost] public Task Disable(Guid userId, [FromServices] Func<Guid, Task> apply) => apply(userId);
        }
        public sealed class LocalCallbackController : ControllerBase {
          [HttpPost] public Task Disable(Guid userId, [FromServices] Func<Task> callback) {
            Func<Task> next = Quiet.Nothing;
            if (userId != Guid.Empty) next = callback;
            return next();
          }
        }
        public sealed class ForwardedCallbackController : ControllerBase {
          [HttpPost] public Task Disable(Guid userId, [FromServices] Func<Task> callback) => Helpers.Run(callback);
        }
        public sealed class ReturnedCallbackController : ControllerBase {
          [HttpPost] public Task Disable(Guid userId, [FromServices] Func<Task> callback) => Helpers.Same(callback)();
        }
        public sealed class OutsideCallbackController : ControllerBase {
          [HttpPost] public Task Disable(Guid userId, [FromServices] Func<Task> callback) => Task.Run(callback);
        }
        public sealed class DynamicCallbackController : ControllerBase {
          [HttpPost] public Task Disable(Guid userId, [FromServices] Func<Task> callback) => (Task)callback.DynamicInvoke()!;
        }
        public sealed class MethodGroupCallbackController : ControllerBase {
          [HttpPost] public Task Disable(Guid userId, [FromServices] Func<Task> callback) { Func<Task> again = callback.Invoke; return again(); }
        }
        public sealed class ArrayCallbackController : ControllerBase {
          [HttpPost] public Task Disable(Guid userId, [FromServices] Func<Task> callback) { var all = new[] { callback }; return all[0](); }
        }
        public sealed class ObjectCallbackController : ControllerBase {
          [HttpPost] public Task Disable(Guid userId, [FromServices] Func<Task> callback) { object held = callback; return ((Func<Task>)held)(); }
        }
        public sealed class GenericCallbackController : ControllerBase {
          private static T Same<T>(T value) => value;
          [HttpPost] public Task Disable(Guid userId, [FromServices] Func<Task> callback) => Same(callback)();
        }
        public sealed class TupleCallbackController : ControllerBase {
          [HttpPost] public Task Disable(Guid userId, [FromServices] Func<Task> callback) { var pair = (callback, 1); return pair.Item1(); }
        }
        public sealed class ResolvedParameterController : ControllerBase {
          [HttpPost] public Task Note(Guid userId) => Helpers.Run(() => Task.CompletedTask);
        }
        public sealed class ReturnedResolvedController : ControllerBase {
          [HttpPost] public Task Note(Guid userId) => Helpers.Same(Quiet.Nothing)();
        }
        """;

    [Theory]
    [InlineData("ParameterCallbackController", "unresolved callback ")]
    [InlineData("ArgumentCallbackController", "unresolved ")]
    [InlineData("LocalCallbackController", "unresolved callback ")]
    [InlineData("ForwardedCallbackController", "unresolved callback ")]
    [InlineData("ReturnedCallbackController", "unresolved callback ")]
    [InlineData("OutsideCallbackController", "unresolved callback ")]
    [InlineData("DynamicCallbackController", "unresolved callback ")]
    [InlineData("MethodGroupCallbackController", "unresolved callback ")]
    [InlineData("ArrayCallbackController", "unresolved callback ")]
    [InlineData("ObjectCallbackController", "unresolved callback ")]
    [InlineData("GenericCallbackController", "unresolved callback ")]
    public void ADelegateInvokedIsJudgedByWhereItCameFrom(string controller, string why)
    {
        using var probe = Probe.Build(("InvocationProbe", InvocationProbes, Array.Empty<string>()));
        var found = Find(JellyfinUserActions.Scan(probe.Path("InvocationProbe")), controller, "Disable");
        Assert.NotEqual(JellyfinUserKey.None, found.Key);
        Assert.StartsWith(why, found.Why, StringComparison.Ordinal);
        // A Func<Guid, Task> can carry a user id (round 10): everyone's. A Func<Task> carries none (round 11): the person's.
        Assert.Equal(why == "unresolved " ? JellyfinUserKey.Global : JellyfinUserKey.User, found.Key);
    }

    [Theory]
    [InlineData("ParameterCallbackController", "Peek")]
    [InlineData("ResolvedParameterController", "Note")]
    [InlineData("ReturnedResolvedController", "Note")]
    // The stated limit, pinned so a change to it is deliberate (the probe really disables the person; Known limits).
    [InlineData("TupleCallbackController", "Disable")]
    public void ADelegateWhoseSourceIsKnownAndHarmlessOrAGetStaysUnbracketed(string controller, string action)
    {
        using var probe = Probe.Build(("InvocationProbe", InvocationProbes, Array.Empty<string>()));
        Assert.Equal(JellyfinUserKey.None, Find(JellyfinUserActions.Scan(probe.Path("InvocationProbe")), controller, action).Key);
    }

    // Run for real: each one disables the person once with the closure DI hands in (the stated limit's included: the scan
    // says None for it); the controls disable nobody.
    [Theory]
    [InlineData("ParameterCallbackController", "Disable", 1, true)]
    [InlineData("ArgumentCallbackController", "Disable", 1, true)]
    [InlineData("LocalCallbackController", "Disable", 1, true)]
    [InlineData("ForwardedCallbackController", "Disable", 1, true)]
    [InlineData("ReturnedCallbackController", "Disable", 1, true)]
    [InlineData("OutsideCallbackController", "Disable", 1, true)]
    [InlineData("DynamicCallbackController", "Disable", 1, true)]
    [InlineData("MethodGroupCallbackController", "Disable", 1, true)]
    [InlineData("ArrayCallbackController", "Disable", 1, true)]
    [InlineData("ObjectCallbackController", "Disable", 1, true)]
    [InlineData("GenericCallbackController", "Disable", 1, true)]
    [InlineData("TupleCallbackController", "Disable", 1, false)]
    [InlineData("ResolvedParameterController", "Note", 0, false)]
    [InlineData("ReturnedResolvedController", "Note", 0, false)]
    public async Task TheInvocationProbesReallyDoWhatTheScanSays(string controller, string action, int disables, bool bracketed)
    {
        using var probe = Probe.Build(("InvocationProbe", InvocationProbes, Array.Empty<string>()));
        var person = Guid.NewGuid();
        var (users, disabled) = Users(person);
        var instance = Activator.CreateInstance(probe.Load("InvocationProbe").GetType(controller)!)!;
        Func<Task> closure = () => users.UpdatePolicyAsync(person, new UserPolicy { IsDisabled = true });
        Func<Guid, Task> apply = id => users.UpdatePolicyAsync(id, new UserPolicy { IsDisabled = true });
        object[] args = controller switch
        {
            "ArgumentCallbackController" => new object[] { person, apply },
            _ when action == "Disable" => new object[] { person, closure },
            _ => new object[] { person },
        };
        await (Task)instance.GetType().GetMethod(action)!.Invoke(instance, args)!;
        Assert.Equal(disables, disabled());
        Assert.Equal(bracketed, Find(JellyfinUserActions.Scan(probe.Path("InvocationProbe")), controller, action).Key != JellyfinUserKey.None);
    }

    // 4a review round 17 (4a-behaviour-r17-2): a caller-graph cycle keeps "handed in". Round 16's Callers() returned an
    // empty list on meeting a method already on the path, so a group of forwarding methods that no code outside the
    // group calls (here reached by reflection or DI, as in the reviewer's probe) read as "nothing handed": Key None while
    // the runtime disables the person. A cycle contributes only what some path out of it resolves; when no path leaves it
    // to a maker, the delegate is handed in from outside (an unresolved callback). The controls: a cycle whose way out is
    // a maker in the code read resolves to that maker (a harmless one: None; a disabling one: the change), and a cycle
    // entered from an action that passes its own parameter is handed in through that action.
    private const string CycleProbes = Usings + """

        public class CallbackService {
          private readonly Func<Task> _callback;
          public CallbackService(Func<Task> callback) { _callback = callback; }
          public static CallbackService Create(Func<Task> callback, int levels) => levels > 0 ? Create(callback, levels - 1) : new CallbackService(callback);
          public Task Run() => _callback();
        }
        public sealed class RecursiveCallbackController(CallbackService service) : ControllerBase {
          [HttpPost] public Task Disable(Guid userId) => service.Run();
        }
        public class PingPongService {
          private readonly Func<Task> _callback;
          private PingPongService(Func<Task> callback) { _callback = callback; }
          public static PingPongService Ping(Func<Task> callback, int levels) => levels > 0 ? Pong(callback, levels - 1) : new PingPongService(callback);
          public static PingPongService Pong(Func<Task> callback, int levels) => Ping(callback, levels);
          public Task Run() => _callback();
        }
        public sealed class MutualCallbackController(PingPongService service) : ControllerBase {
          [HttpPost] public Task Disable(Guid userId) => service.Run();
        }
        public static class Loops {
          public static Task Loop(Func<Task> callback, int levels) => levels > 0 ? Loop(callback, levels - 1) : callback();
        }
        public sealed class DelegatedLoopController : ControllerBase {
          [HttpPost] public Task Disable(Guid userId, [FromServices] Func<Task> callback) { Func<Func<Task>, int, Task> loop = Loops.Loop; return loop(callback, 3); }
        }
        public class QuietService {
          private readonly Func<Task> _callback;
          private QuietService(Func<Task> callback) { _callback = callback; }
          public static QuietService Create(Func<Task> callback, int levels) => levels > 0 ? Create(callback, levels - 1) : new QuietService(callback);
          public static QuietService Quiet(int levels) => Create(() => Task.CompletedTask, levels);
          public Task Run() => _callback();
        }
        public sealed class QuietCycleController(QuietService service) : ControllerBase {
          [HttpPost] public Task Note(Guid userId) => service.Run();
        }
        public class ArmedService {
          private readonly Func<Task> _callback;
          private ArmedService(Func<Task> callback) { _callback = callback; }
          public static ArmedService Create(Func<Task> callback, int levels) => levels > 0 ? Create(callback, levels - 1) : new ArmedService(callback);
          public static ArmedService Armed(IUserManager users, Guid person, int levels) => Create(() => users.UpdatePolicyAsync(person, new UserPolicy { IsDisabled = true }), levels);
          public Task Run() => _callback();
        }
        public sealed class ArmedCycleController(ArmedService service) : ControllerBase {
          [HttpPost] public Task Disable(Guid userId) => service.Run();
        }
        public class EnteredService {
          private readonly Func<Task> _callback;
          private EnteredService(Func<Task> callback) { _callback = callback; }
          public static EnteredService Create(Func<Task> callback, int levels) => levels > 0 ? Create(callback, levels - 1) : new EnteredService(callback);
          public Task Run() => _callback();
        }
        public sealed class EnteredCycleController : ControllerBase {
          [HttpPost] public Task Disable(Guid userId, [FromServices] Func<Task> callback) => EnteredService.Create(callback, 3).Run();
        }
        """;

    [Theory]
    [InlineData("RecursiveCallbackController", "Disable", "unresolved callback ")]
    [InlineData("MutualCallbackController", "Disable", "unresolved callback ")]
    [InlineData("DelegatedLoopController", "Disable", "unresolved callback ")]
    [InlineData("EnteredCycleController", "Disable", "unresolved callback ")]
    [InlineData("ArmedCycleController", "Disable", "reaches IUserManager.UpdatePolicyAsync")]
    [InlineData("QuietCycleController", "Note", null)]
    public void ACallerCycleKeepsHandedIn(string controller, string action, string? why)
    {
        using var probe = Probe.Build(("CycleProbe", CycleProbes, Array.Empty<string>()));
        var found = Find(JellyfinUserActions.Scan(probe.Path("CycleProbe")), controller, action);
        if (why == null)
        {
            Assert.Equal(JellyfinUserKey.None, found.Key);
            return;
        }

        Assert.StartsWith(why, found.Why, StringComparison.Ordinal);
        Assert.NotEqual(JellyfinUserKey.None, found.Key);
    }

    // Run for real: the reviewer's shape (the service made by reflection, as DI would) and the others disable the person
    // once; the quiet cycle disables nobody.
    [Theory]
    [InlineData("RecursiveCallbackController", "CallbackService", 1)]
    [InlineData("MutualCallbackController", "PingPongService", 1)]
    [InlineData("DelegatedLoopController", null, 1)]
    [InlineData("EnteredCycleController", null, 1)]
    [InlineData("ArmedCycleController", "ArmedService", 1)]
    [InlineData("QuietCycleController", "QuietService", 0)]
    public async Task TheCycleProbesReallyDoWhatTheScanSays(string controller, string? service, int disables)
    {
        using var probe = Probe.Build(("CycleProbe", CycleProbes, Array.Empty<string>()));
        var person = Guid.NewGuid();
        var (users, disabled) = Users(person);
        var assembly = probe.Load("CycleProbe");
        Func<Task> closure = () => users.UpdatePolicyAsync(person, new UserPolicy { IsDisabled = true });
        object instance;
        object[] args;
        if (service == null)
        {
            instance = Activator.CreateInstance(assembly.GetType(controller)!)!;
            args = new object[] { person, closure };
        }
        else
        {
            var type = assembly.GetType(service)!;
            var made = service switch
            {
                "PingPongService" => type.GetMethod("Ping")!.Invoke(null, new object[] { closure, 3 }),
                "QuietService" => type.GetMethod("Quiet")!.Invoke(null, new object[] { 3 }),
                "ArmedService" => type.GetMethod("Armed")!.Invoke(null, new object[] { users, person, 3 }),
                _ => type.GetMethod("Create")!.Invoke(null, new object[] { closure, 3 }),
            };
            instance = Activator.CreateInstance(assembly.GetType(controller)!, made)!;
            args = new object[] { person };
        }

        var action = controller == "QuietCycleController" ? "Note" : "Disable";
        Assert.Equal(0, disabled());
        await (Task)instance.GetType().GetMethod(action)!.Invoke(instance, args)!;
        Assert.Equal(disables, disabled());
        Assert.Equal(disables > 0, Find(JellyfinUserActions.Scan(probe.Path("CycleProbe")), controller, action).Key != JellyfinUserKey.None);
    }

    // 4a review round 18 (D53: composition gaps between rules added in different rounds). The reviewers' probes, as they
    // wrote them: a delegate field stored through an identity helper (Same's body was followed, not its returned delegate),
    // through a local or another object's constructor after an unrelated delegate was made (the old "delegates made before
    // the call" heuristic took the decoy for the argument), a constrained call to a static abstract member .NET declares
    // (IAdditionOperators.op_Addition: framework slots were consulted for callvirt only, and an implicit static
    // implementation has no Virtual flag), a framework slot's implementation whose STATIC CONSTRUCTOR changes the user (a
    // slot node got no initializer edges), and an array filled by a helper (array provenance saw only the invoking body's
    // stores). All were None while the person was disabled. Now: one target resolver (dispatch for callvirt, ldvirtftn
    // and any constrained call or pointer, a slot .NET declares included, static members by name), one "running a method"
    // edge set (body, type initializer, module initializer) on every method node, and one provenance model for every
    // delegate value (a field store is the stored value's provenance, a parameter the argument at each call site, an
    // array that escapes into a call is unknown). The controls: the reviewers' handed-in callbacks (bracketed before and
    // after), and QuietArrayController, a helper filling the array with a harmless lambda: bracketed now (the helper's
    // writes aren't modelled, so its elements are unknown: fail closed, may over-bracket; Known limits).
    private const string Round18SecurityProbes = """
        using System;
        using System.Threading.Tasks;
        using Microsoft.AspNetCore.Mvc;
        using System.Numerics;
        using MediaBrowser.Controller.Library;
        using MediaBrowser.Model.Users;
        public static class Bootstrap { public static IUserManager Users = null!; public static Guid Person; }
        public struct Changes : IAdditionOperators<Changes,Changes,Changes> {
         public static Changes operator +(Changes a, Changes b) { Bootstrap.Users.UpdatePolicyAsync(Bootstrap.Person,new UserPolicy { IsDisabled=true }).GetAwaiter().GetResult(); return default; }
        }
        public static class Arithmetic {
         public static T Add<T>(T a,T b) where T:IAdditionOperators<T,T,T> => a+b;
        }
        public sealed class FrameworkStaticController : ControllerBase {
         [HttpPost] public void Disable(Guid userId) => Arithmetic.Add(default(Changes),default(Changes));
        }
        public struct ColdProgress : IProgress<int> {
         static ColdProgress() { Bootstrap.Users.UpdatePolicyAsync(Bootstrap.Person,new UserPolicy { IsDisabled=true }).GetAwaiter().GetResult(); }
         public void Report(int value) { }
        }
        public sealed class FrameworkInitializerController : ControllerBase {
         [HttpPost] public void Disable(Guid userId) { IProgress<int> progress=default(ColdProgress); progress.Report(0); }
        }
        public sealed class ReturnVisibleFieldController : ControllerBase {
         private readonly Action _callback;
         static Action Same(Action callback) => callback;
         public ReturnVisibleFieldController() { _callback = Same(() => Bootstrap.Users.UpdatePolicyAsync(Bootstrap.Person,new UserPolicy { IsDisabled=true }).GetAwaiter().GetResult()); }
         [HttpPost] public void Disable(Guid userId) => _callback();
        }
        public sealed class ReturnFieldController : ControllerBase {
         private readonly Action _callback;
         static Action Same(Action callback) => callback;
         public ReturnFieldController(Action callback) { _callback = Same(callback); }
         [HttpPost] public void Disable(Guid userId) => _callback();
        }
        public sealed class LocalFieldController : ControllerBase {
         private readonly Action _callback;
         static void Harmless() { }
         public LocalFieldController(Action callback) {
           Action decoy = Harmless;
           Action local = callback;
           _callback = local;
           GC.KeepAlive(decoy);
         }
         [HttpPost] public void Disable(Guid userId) => _callback();
        }
        public sealed class CallerFieldController : ControllerBase {
         private readonly Slot _slot;
         static void Harmless() { }
         public CallerFieldController(Action callback) {
           Action decoy = Harmless;
           _slot = new Slot(callback);
           GC.KeepAlive(decoy);
         }
         [HttpPost] public void Disable(Guid userId) => _slot.Run();
        }
        public sealed class Slot { private readonly Action _callback; public Slot(Action callback) { _callback=callback; } public void Run() => _callback(); }
        public sealed class ControlController : ControllerBase {
         private readonly Action _callback;
         public ControlController(Action callback) { _callback=callback; }
         [HttpPost] public void Disable(Guid userId) => _callback();
        }
        """;

    private const string Round18BehaviourProbes = """
        using System; using System.Threading.Tasks; using Microsoft.AspNetCore.Mvc;
        public class Box {
         readonly Func<Task> _callback;
         public Box(Func<Task> callback) { _callback=callback; }
         public Task Run() => _callback();
        }
        public sealed class FieldMixController : ControllerBase {
         [HttpPost] public Task Disable(Guid userId, [FromServices] Func<Task> callback) {
         Func<Task> harmless = () => Task.CompletedTask; GC.KeepAlive(harmless);
         return new Box(callback).Run();
         }
        }
        public class BoxOnly {
         readonly Func<Task> _callback;
         public BoxOnly(Func<Task> callback) { _callback=callback; }
         public Task Run() => _callback();
        }
        public sealed class FieldOnlyController : ControllerBase {
         [HttpPost] public Task Disable(Guid userId, [FromServices] Func<Task> callback) => new BoxOnly(callback).Run();
        }
        public sealed class ArrayFillController : ControllerBase {
         static void Fill(Func<Task>[] target, Func<Task> cb) { target[0]=cb; }
         [HttpPost] public Task Disable(Guid userId, [FromServices] Func<Task> callback) {
         var target = new Func<Task>[1]; Fill(target, callback); return target[0]();
         }
        }
        public sealed class LocalArrayController : ControllerBase {
         [HttpPost] public Task Disable(Guid userId, [FromServices] Func<Task> callback) {
         var target = new Func<Task>[1]; target[0]=callback; return target[0]();
         }
        }
        public sealed class ParameterController : ControllerBase {
         [HttpPost] public Task Disable(Guid userId, [FromServices] Func<Task> callback) => callback();
        }
        public sealed class QuietArrayController : ControllerBase {
         static void Fill(Func<Task>[] target) { target[0]=()=>Task.CompletedTask; }
         [HttpPost] public Task Disable(Guid userId, [FromServices] Func<Task> callback) {
         var target = new Func<Task>[1]; Fill(target); return target[0]();
         }
        }
        """;

    public static IEnumerable<object[]> Round18Cases()
    {
        foreach (var optimization in new[] { OptimizationLevel.Debug, OptimizationLevel.Release })
        {
            foreach (var controller in new[] { "FrameworkStaticController", "FrameworkInitializerController", "ReturnVisibleFieldController", "ReturnFieldController", "LocalFieldController", "CallerFieldController", "ControlController" })
                yield return new object[] { optimization, "Round18Security", controller, 1 };
            foreach (var controller in new[] { "FieldMixController", "FieldOnlyController", "ArrayFillController", "LocalArrayController", "ParameterController" })
                yield return new object[] { optimization, "Round18Behaviour", controller, 1 };
            yield return new object[] { optimization, "Round18Behaviour", "QuietArrayController", 0 };
        }
    }

    // Scanned and run for real: each one disables the person once (the quiet array control: nobody) and is bracketed (the
    // quiet control too: over-bracketed by design, fail closed).
    [Theory]
    [MemberData(nameof(Round18Cases))]
    public async Task TheRound18ProbesAreBracketedAndReallyDoWhatTheyShould(OptimizationLevel optimization, string assembly, string controller, int disables)
    {
        using var probe = Probe.Build(optimization, (assembly, assembly == "Round18Security" ? Round18SecurityProbes : Round18BehaviourProbes, Array.Empty<string>()));
        var found = Find(JellyfinUserActions.Scan(probe.Path(assembly)), controller, "Disable");
        Assert.True(found.Key == JellyfinUserKey.User, controller + ": " + found.Key + " why=" + found.Why);
        var person = Guid.NewGuid();
        var (users, disabled) = Users(person);
        var loaded = probe.Load(assembly);
        Func<Task> closure = () => users.UpdatePolicyAsync(person, new UserPolicy { IsDisabled = true });
        Action action = () => users.UpdatePolicyAsync(person, new UserPolicy { IsDisabled = true }).GetAwaiter().GetResult();
        object instance;
        object[] args;
        if (assembly == "Round18Security")
        {
            var bootstrap = loaded.GetType("Bootstrap")!;
            bootstrap.GetField("Users")!.SetValue(null, users);
            bootstrap.GetField("Person")!.SetValue(null, person);
            instance = controller is "FrameworkStaticController" or "FrameworkInitializerController" or "ReturnVisibleFieldController"
                ? Activator.CreateInstance(loaded.GetType(controller)!)!
                : Activator.CreateInstance(loaded.GetType(controller)!, action)!;
            args = new object[] { person };
        }
        else
        {
            instance = Activator.CreateInstance(loaded.GetType(controller)!)!;
            args = new object[] { person, closure };
        }

        Assert.Equal(0, disabled());
        if (instance.GetType().GetMethod("Disable")!.Invoke(instance, args) is Task task) await task;
        Assert.Equal(disables, disabled());
    }

    // Round 17: a body whose stack the reading can't follow (here a backward branch carrying a value, which C# never emits
    // and Jellyfin has none of) records only unknowns: the delegate it invokes is an unresolved callback of unknown origin,
    // not the parameter the stack would otherwise show. Emitted directly (Roslyn can't write such IL); only read, never run.
    [Fact]
    public void ABodyTheStackCantFollowFailsClosed()
    {
        using var probe = Probe.Build();
        var assembly = new System.Reflection.Emit.PersistedAssemblyBuilder(new System.Reflection.AssemblyName("BrokenProbe"), typeof(object).Assembly);
        var type = assembly.DefineDynamicModule("BrokenProbe").DefineType("BrokenController", System.Reflection.TypeAttributes.Public | System.Reflection.TypeAttributes.Sealed, typeof(Microsoft.AspNetCore.Mvc.ControllerBase));
        var method = type.DefineMethod("Disable", System.Reflection.MethodAttributes.Public, typeof(Task), new[] { typeof(Guid), typeof(Func<Task>) });
        method.SetCustomAttribute(new System.Reflection.Emit.CustomAttributeBuilder(typeof(Microsoft.AspNetCore.Mvc.HttpPostAttribute).GetConstructor(Type.EmptyTypes)!, Array.Empty<object>()));
        var il = method.GetILGenerator();
        var top = il.DefineLabel();
        il.MarkLabel(top);
        il.Emit(System.Reflection.Emit.OpCodes.Ldarg_2);
        il.Emit(System.Reflection.Emit.OpCodes.Ldc_I4_0);
        il.Emit(System.Reflection.Emit.OpCodes.Brtrue, top);
        il.Emit(System.Reflection.Emit.OpCodes.Callvirt, typeof(Func<Task>).GetMethod("Invoke")!);
        il.Emit(System.Reflection.Emit.OpCodes.Ret);
        type.CreateType();
        assembly.Save(probe.Path("BrokenProbe"));
        var found = Find(JellyfinUserActions.Scan(probe.Path("BrokenProbe")), "BrokenController", "Disable");
        Assert.Equal(JellyfinUserKey.User, found.Key);
        Assert.StartsWith("unresolved callback Func<Task> of unknown origin in BrokenController.Disable", found.Why, StringComparison.Ordinal);
    }

    // 4a review round 11 (4a-security-r11-2): a callback the code read can't resolve is judged by what it can do, not by
    // its signature. A Func<Task> handed in by DI carries no user type, yet its closure can hold IUserManager and a user id
    // (the reviewer's probe disables that user). Round 10 counted an unresolved delegate only when its type could carry a
    // user (Q-4AF10-3): Key None. Now every delegate whose target stays unresolved (nothing in the code read stores it, or
    // it is handed in from outside it), and every unresolved member that hands back a delegate, counts: a write reaching
    // one is bracketed for the request's person (its userId, else the signed-in person; everyone's when there is none),
    // not for everyone, because on 12.2 and 10.11.11 this reaches playback starts, favourites, ratings and user-data saves
    // (Q-4AF11-1). One whose type can carry a user stays everyone's (round 10's InjectedDelegateController above). A
    // delegate the code read does resolve is judged by its target, as before (the controls).
    private const string CallbackProbes = Usings + """

        public sealed class InjectedNoArgumentController(Func<Task> apply) : ControllerBase {
          private readonly Func<Task> _apply = apply;
          [HttpPost] public Task Disable() => _apply();
          [HttpGet] public Task Peek() => _apply();
        }
        public sealed class InjectedPersonController(Func<Task> apply) : ControllerBase {
          private readonly Func<Task> _apply = apply;
          [HttpPost] public Task Disable(Guid userId) => _apply();
        }
        public sealed class LaterController : ControllerBase {
          private readonly Func<Task> _apply;
          public LaterController(Func<Task> apply) { _apply = apply; }
          [HttpPost] public Task Disable() => Run();
          private Task Run() => _apply.Invoke();
        }
        public sealed class Deferred {
          private Func<Task>? _next;
          public void Later(Func<Task> next) => _next = next;
          public Task Run() => _next?.Invoke() ?? Task.CompletedTask;
        }
        public sealed class DeferredController(Deferred deferred, IUserManager users) : ControllerBase {
          [HttpPost] public IActionResult Queue(Guid userId) { deferred.Later(() => users.UpdatePolicyAsync(userId, new UserPolicy { IsDisabled = true })); return Ok(); }
          [HttpPost] public Task Flush() => deferred.Run();
        }
        public sealed class Outside {
          private Func<Task>? _next;
          public void Later(Func<Task> next) => _next = next;
          public Task Run() => _next?.Invoke() ?? Task.CompletedTask;
        }
        public sealed class OutsideController(Outside outside) : ControllerBase {
          [HttpPost] public Task Flush() => outside.Run();
        }
        public interface ICallbacks { Func<Task> Next(); }
        public sealed class FactoryController(ICallbacks callbacks) : ControllerBase {
          [HttpPost] public Task Run() => callbacks.Next()();
        }
        public sealed class Quiet { public static Task Nothing() => Task.CompletedTask; }
        public sealed class ResolvedController : ControllerBase {
          private readonly Func<Task> _apply = Quiet.Nothing;
          [HttpPost] public Task Run() => _apply();
        }
        """;

    [Theory]
    [InlineData("InjectedNoArgumentController", "Disable", JellyfinUserKey.User)]
    [InlineData("InjectedPersonController", "Disable", JellyfinUserKey.User)]
    [InlineData("LaterController", "Disable", JellyfinUserKey.User)]
    [InlineData("OutsideController", "Flush", JellyfinUserKey.User)]
    [InlineData("FactoryController", "Run", JellyfinUserKey.User)]
    [InlineData("InjectedNoArgumentController", "Peek", JellyfinUserKey.None)]
    [InlineData("ResolvedController", "Run", JellyfinUserKey.None)]
    public void AnUnresolvedCallbackIsJudgedByWhatItCanDoNotItsSignature(string controller, string action, JellyfinUserKey expected)
    {
        using var probe = Probe.Build(("CallbackProbe", CallbackProbes, Array.Empty<string>()));
        var found = Find(JellyfinUserActions.Scan(probe.Path("CallbackProbe")), controller, action);
        Assert.Equal(expected, found.Key);
        Assert.Null(found.Reaches);
        if (expected != JellyfinUserKey.None) Assert.StartsWith("unresolved callback ", found.Why, StringComparison.Ordinal);
    }

    // A delegate stored in a field by one action and invoked later by another: resolved to the closure the first made.
    [Fact]
    public void ADelegateStoredForLaterIsFollowedToWhatWasStored()
    {
        using var probe = Probe.Build(("CallbackProbe", CallbackProbes, Array.Empty<string>()));
        var scanned = JellyfinUserActions.Scan(probe.Path("CallbackProbe"));
        Assert.Equal(("IUserManager.UpdatePolicyAsync", JellyfinUserKey.Global), (Find(scanned, "DeferredController", "Flush").Reaches, Find(scanned, "DeferredController", "Flush").Key));
        Assert.Equal(("IUserManager.UpdatePolicyAsync", JellyfinUserKey.User), (Find(scanned, "DeferredController", "Queue").Reaches, Find(scanned, "DeferredController", "Queue").Key));
    }

    // The reviewer's probe, run for real: the parameterless closure DI hands in disables the person it captured.
    [Fact]
    public async Task TheInjectedClosureProbeReallyDisablesThePerson()
    {
        using var probe = Probe.Build(("CallbackProbe", CallbackProbes, Array.Empty<string>()));
        var person = Guid.NewGuid();
        var (users, disabled) = Users(person);
        var assembly = probe.Load("CallbackProbe");
        Func<Task> closure = () => users.UpdatePolicyAsync(person, new UserPolicy { IsDisabled = true });
        var controller = Activator.CreateInstance(assembly.GetType("InjectedNoArgumentController")!, closure)!;
        await (Task)controller.GetType().GetMethod("Disable")!.Invoke(controller, null)!;
        Assert.Equal(1, disabled());
        Assert.NotEqual(JellyfinUserKey.None, Find(JellyfinUserActions.Scan(probe.Path("CallbackProbe")), "InjectedNoArgumentController", "Disable").Key);
    }

    // ------------------------------------------------------------------ round 19: complete ancestry, fixed points

    private const string Round19Bootstrap = """
        using System; using System.IO; using System.Threading; using System.Threading.Tasks; using Microsoft.AspNetCore.Mvc;
        using MediaBrowser.Controller.Library; using MediaBrowser.Model.Users;
        public static class Bootstrap {
         public static IUserManager Users = null!; public static Guid Person;
         public static void Disable() => Users.UpdatePolicyAsync(Person, new UserPolicy { IsDisabled = true }).GetAwaiter().GetResult();
        }
        """;

    // The reviewers' round-19 probes (4a-r19-1: an interface .NET declares implemented through a method a base class has
    // without declaring it; 4a-r19-2: a Stream.Write override behind MemoryStream, called through a Stream and through a
    // MemoryStream; 4a-r19-3: a callback returned through a recursion that rotates its arguments), the shapes next to them
    // (the rotation into a field; a delegate type .NET declares, handed in and invoked; chains 300 deep, past the old
    // bound), and controls. Each in an assembly of its own: a slot .NET declares is one node for all its fills, so one
    // probe's fill would otherwise bracket another's call.
    private static readonly Dictionary<string, string> Round19Probes = new(StringComparer.Ordinal)
    {
        ["InheritedSlotController"] = """
            public class Parent { public void Report(int value) => Bootstrap.Disable(); }
            public class Child : Parent, IProgress<int> { }
            public sealed class InheritedSlotController : ControllerBase { [HttpPost] public void Disable(Guid userId) { IProgress<int> p = new Child(); p.Report(1); } }
            """,
        ["DerivedFrameworkController"] = """
            public sealed class DerivedFrameworkController : ControllerBase {
             sealed class Sink : MemoryStream { readonly Func<Task> _cb; public Sink(Func<Task> cb) { _cb = cb; } public override void Write(byte[] buffer, int offset, int count) { _cb().GetAwaiter().GetResult(); } }
             private Stream _stream = null!;
             [HttpPost] public Task Disable(Guid userId, [FromServices] Func<Task> cb) { _stream = new Sink(cb); _stream.Write(new byte[1], 0, 1); return Task.CompletedTask; }
            }
            """,
        ["NearestFrameworkController"] = """
            public sealed class NearestFrameworkController : ControllerBase {
             sealed class Sink : MemoryStream { readonly Func<Task> _cb; public Sink(Func<Task> cb) { _cb = cb; } public override void Write(byte[] buffer, int offset, int count) { _cb().GetAwaiter().GetResult(); } }
             private MemoryStream _stream = null!;
             [HttpPost] public Task Disable(Guid userId, [FromServices] Func<Task> cb) { _stream = new Sink(cb); _stream.Write(new byte[1], 0, 1); return Task.CompletedTask; }
            }
            """,
        ["RotatingReturnController"] = """
            public sealed class RotatingReturnController : ControllerBase {
             static Func<Task> Rotate(Func<Task> a, Func<Task> b, Func<Task> c, int n) => n == 0 ? a : Rotate(b, c, a, n - 1);
             [HttpPost] public Task Disable(Guid userId, [FromServices] Func<Task> cb) => Rotate(() => Task.CompletedTask, () => Task.CompletedTask, cb, 2)();
            }
            """,
        ["RotatingStoreController"] = """
            public sealed class RotatingStoreController : ControllerBase {
             private Func<Task> _d = null!;
             void Spin(Func<Task> a, Func<Task> b, Func<Task> c, int n) { if (n == 0) _d = a; else Spin(b, c, a, n - 1); }
             [HttpPost] public Task Disable(Guid userId, [FromServices] Func<Task> cb) { Spin(() => Task.CompletedTask, () => Task.CompletedTask, cb, 2); return _d(); }
            }
            """,
        // Two fields stored from one rotating recursion: the parameters form one strongly connected group, found from the
        // first field read (Note's); the second (Disable's) is another member of the group, which must have the group's
        // sources too, not only what its own call sites hand it.
        ["RotatingPairController"] = """
            public sealed class RotatingPairController : ControllerBase {
             private Func<Task> _first = null!, _second = null!;
             void Spin(Func<Task> a, Func<Task> b, Func<Task> c, int n) { if (n == 0) { _first = a; _second = b; } else Spin(b, c, a, n - 1); }
             [HttpPost] public Task Note(Guid userId) => _first();
             [HttpPost] public Task Disable(Guid userId, [FromServices] Func<Task> cb) { Spin(() => Task.CompletedTask, () => Task.CompletedTask, cb, 1); return _second(); }
            }
            """,
        ["TimerCallbackController"] = """
            public sealed class TimerCallbackController : ControllerBase { [HttpPost] public void Disable(Guid userId, [FromServices] TimerCallback cb) => cb(null); }
            """,
        ["DeepHandedController"] = "public sealed class DeepHandedController : ControllerBase { "
            + string.Concat(Enumerable.Range(0, 300).Select(i => $"static Task F{i}(Func<Task> cb) => F{i + 1}(cb); ")) + "static Task F300(Func<Task> cb) => cb(); "
            + "[HttpPost] public Task Disable(Guid userId, [FromServices] Func<Task> cb) => F0(cb); }",
        ["DeepVisibleController"] = "public sealed class DeepVisibleController : ControllerBase { "
            + string.Concat(Enumerable.Range(0, 300).Select(i => $"static Func<Task> G{i}(Func<Task> cb) => G{i + 1}(cb); ")) + "static Func<Task> G300(Func<Task> cb) => cb; "
            + "[HttpPost] public Task Disable(Guid userId) => G0(() => { Bootstrap.Disable(); return Task.CompletedTask; })(); }",
        ["QuietRotateController"] = """
            public sealed class QuietRotateController : ControllerBase {
             static Func<Task> Rotate(Func<Task> a, Func<Task> b, Func<Task> c, int n) => n == 0 ? a : Rotate(b, c, a, n - 1);
             [HttpPost] public Task Note(Guid userId) => Rotate(() => Task.CompletedTask, () => Task.CompletedTask, () => Task.CompletedTask, 2)();
            }
            """,
        ["QuietInheritedController"] = """
            public class QuietParent { public void Report(int value) { } }
            public class QuietChild : QuietParent, IProgress<int> { }
            public sealed class QuietInheritedController : ControllerBase { [HttpPost] public void Note(Guid userId) { IProgress<int> p = new QuietChild(); p.Report(1); } }
            """,
    };

    public static IEnumerable<object[]> Round19Cases()
    {
        foreach (var optimization in new[] { OptimizationLevel.Debug, OptimizationLevel.Release })
        {
            yield return new object[] { optimization, "InheritedSlotController", "Disable", 1, "reaches IUserManager.UpdatePolicyAsync" };
            yield return new object[] { optimization, "DerivedFrameworkController", "Disable", 1, "unresolved callback delegate Sink._cb (handed to DerivedFrameworkController.Disable from outside the code read)" };
            yield return new object[] { optimization, "NearestFrameworkController", "Disable", 1, "unresolved callback delegate Sink._cb (handed to NearestFrameworkController.Disable from outside the code read)" };
            yield return new object[] { optimization, "RotatingReturnController", "Disable", 1, "unresolved callback Func<Task> handed to RotatingReturnController.Disable from outside the code read" };
            yield return new object[] { optimization, "RotatingStoreController", "Disable", 1, "unresolved callback delegate RotatingStoreController._d (handed to RotatingStoreController.Disable from outside the code read)" };
            yield return new object[] { optimization, "RotatingPairController", "Disable", 1, "unresolved callback delegate RotatingPairController._second (handed to RotatingPairController.Disable from outside the code read)" };
            yield return new object[] { optimization, "TimerCallbackController", "Disable", 1, "unresolved callback TimerCallback handed to TimerCallbackController.Disable from outside the code read" };
            // No depth bound: followed to the end, not cut (a cut would read "too deep").
            yield return new object[] { optimization, "DeepHandedController", "Disable", 1, "unresolved callback Func<Task> handed to DeepHandedController.Disable from outside the code read" };
            yield return new object[] { optimization, "DeepVisibleController", "Disable", 1, "reaches IUserManager.UpdatePolicyAsync" };
            yield return new object[] { optimization, "QuietRotateController", "Note", 0, null! };
            yield return new object[] { optimization, "QuietInheritedController", "Note", 0, null! };
        }
    }

    // Scanned and run for real: each disables the person once and is bracketed for the reason given (exactly); the controls
    // disable nobody and aren't bracketed.
    [Theory]
    [MemberData(nameof(Round19Cases))]
    public async Task TheRound19ProbesAreBracketedAndReallyDoWhatTheyShould(OptimizationLevel optimization, string controller, string action, int disables, string? why)
    {
        using var probe = Probe.Build(optimization, (controller, Round19Bootstrap + Round19Probes[controller], Array.Empty<string>()));
        var found = Find(JellyfinUserActions.Scan(probe.Path(controller)), controller, action);
        if (why == null) Assert.True(found.Key == JellyfinUserKey.None, controller + ": " + found.Key + " why=" + found.Why);
        else
        {
            Assert.True(found.Key == JellyfinUserKey.User, controller + ": " + found.Key + " why=" + found.Why);
            Assert.Equal(why, found.Why);
        }

        var person = Guid.NewGuid();
        var (users, disabled) = Users(person);
        var loaded = probe.Load(controller);
        loaded.GetType("Bootstrap")!.GetField("Users")!.SetValue(null, users);
        loaded.GetType("Bootstrap")!.GetField("Person")!.SetValue(null, person);
        var instance = Activator.CreateInstance(loaded.GetType(controller)!)!;
        var method = instance.GetType().GetMethod(action)!;
        var args = method.GetParameters().Select(p => p.ParameterType == typeof(Guid) ? (object)person
            : p.ParameterType == typeof(Func<Task>) ? (Func<Task>)(() => users.UpdatePolicyAsync(person, new UserPolicy { IsDisabled = true }))
            : p.ParameterType == typeof(TimerCallback) ? (TimerCallback)(_ => users.UpdatePolicyAsync(person, new UserPolicy { IsDisabled = true }).GetAwaiter().GetResult())
            : throw new Xunit.Sdk.XunitException("unexpected parameter " + p.ParameterType)).ToArray();
        Assert.Equal(0, disabled());
        if (method.Invoke(instance, args) is Task task) await task;
        Assert.Equal(disables, disabled());
    }

    // Round 19: the ancestry of a type outside the code read is read from its assembly's metadata; when that assembly can't
    // be read, the step fails closed. Here the base Mid (between MemoryStream and the sink overriding Stream.Write) and the
    // delegate type Hook are in an assembly named like .NET's (so it isn't code read, only its metadata): present, the
    // sink's override is reached through Stream.Write and Hook is a delegate; deleted, the sink may fill any slot it has a
    // method for (Stream.Write: bracketed) and Hook may be a delegate (bracketed), each listed as a gap; a type with no such
    // method (the quiet sink, Stream.Flush) stays unbracketed either way.
    [Fact]
    public void AnAncestryStepThatCantBeReadFailsClosed()
    {
        const string Outside = "namespace Gap { public class Mid : System.IO.MemoryStream { } public delegate void Hook(); }";
        var gapProbe = Usings + """
            using Gap;
            public static class Bootstrap {
             public static IUserManager Users = null!; public static Guid Person;
             public static void Disable() => Users.UpdatePolicyAsync(Person, new UserPolicy { IsDisabled = true }).GetAwaiter().GetResult();
            }
            public sealed class Sink : Mid { public override void Write(byte[] buffer, int offset, int count) => Bootstrap.Disable(); }
            public sealed class GapController : ControllerBase { [HttpPost] public void Disable(Guid userId) { System.IO.Stream s = new Sink(); s.Write(new byte[1], 0, 1); } }
            public sealed class HookController : ControllerBase { [HttpPost] public void Disable(Guid userId, [FromServices] Hook hook) => hook(); }
            public sealed class QuietSink : Mid { }
            public sealed class QuietGapController : ControllerBase { [HttpPost] public void Note(Guid userId) { System.IO.Stream s = new QuietSink(); s.Flush(); } }
            """;
        using var probe = Probe.Build(("System.JeAncestry", Outside, Array.Empty<string>()), ("GapProbe", gapProbe, new[] { "System.JeAncestry" }));
        Assert.DoesNotContain(JellyfinUserActions.CodeOf(probe.Path("GapProbe")), f => f.EndsWith("System.JeAncestry.dll", StringComparison.Ordinal));
        var read = JellyfinUserActions.Scan(probe.Path("GapProbe"));
        Assert.Equal("reaches IUserManager.UpdatePolicyAsync", Find(read, "GapController", "Disable").Why);
        Assert.StartsWith("unresolved callback Hook handed to HookController.Disable", Find(read, "HookController", "Disable").Why, StringComparison.Ordinal);
        Assert.Equal(JellyfinUserKey.None, Find(read, "QuietGapController", "Note").Key);
        Assert.DoesNotContain(JellyfinUserActions.AncestryGaps(probe.Path("GapProbe")), g => g.Contains("Gap.", StringComparison.Ordinal));

        // Run for real (the assembly present): the sink's override and the hook each disable the person once.
        var person = Guid.NewGuid();
        var (users, disabled) = Users(person);
        var context = new System.Runtime.Loader.AssemblyLoadContext("gap-" + Guid.NewGuid().ToString("N"), isCollectible: true);
        var outside = context.LoadFromStream(new MemoryStream(File.ReadAllBytes(probe.Path("System.JeAncestry"))));
        var loaded = context.LoadFromStream(new MemoryStream(File.ReadAllBytes(probe.Path("GapProbe"))));
        try
        {
            loaded.GetType("Bootstrap")!.GetField("Users")!.SetValue(null, users);
            loaded.GetType("Bootstrap")!.GetField("Person")!.SetValue(null, person);
            var gap = Activator.CreateInstance(loaded.GetType("GapController")!)!;
            gap.GetType().GetMethod("Disable")!.Invoke(gap, new object[] { person });
            Assert.Equal(1, disabled());
            var hookType = outside.GetType("Gap.Hook")!;
            Action closure = () => users.UpdatePolicyAsync(person, new UserPolicy { IsDisabled = true }).GetAwaiter().GetResult();
            var hook = Delegate.CreateDelegate(hookType, closure.Target, closure.Method);
            var hooked = Activator.CreateInstance(loaded.GetType("HookController")!)!;
            hooked.GetType().GetMethod("Disable")!.Invoke(hooked, new object[] { person, hook });
            Assert.Equal(2, disabled());
            var quiet = Activator.CreateInstance(loaded.GetType("QuietGapController")!)!;
            quiet.GetType().GetMethod("Note")!.Invoke(quiet, new object[] { person });
            Assert.Equal(2, disabled());
        }
        finally
        {
            context.Unload();
        }

        // The assembly gone: fail closed.
        File.Delete(probe.Path("System.JeAncestry"));
        var unread = JellyfinUserActions.Scan(probe.Path("GapProbe"));
        Assert.Equal("reaches IUserManager.UpdatePolicyAsync", Find(unread, "GapController", "Disable").Why);
        Assert.Equal(JellyfinUserKey.User, Find(unread, "HookController", "Disable").Key);
        Assert.Equal(JellyfinUserKey.None, Find(unread, "QuietGapController", "Note").Key);
        var gaps = JellyfinUserActions.AncestryGaps(probe.Path("GapProbe"));
        Assert.Contains("Sink: its base Gap.Mid in System.JeAncestry can't be read", gaps);
        Assert.Contains("Gap.Hook in System.JeAncestry can't be read: it may be a delegate", gaps);
    }

    // A user manager that counts the policy saves disabling the person.
    private static (IUserManager Users, Func<int> Disabled) Users(Guid person)
    {
        var count = 0;
        var users = new Moq.Mock<IUserManager>();
        users.Setup(u => u.UpdatePolicyAsync(Moq.It.IsAny<Guid>(), Moq.It.IsAny<UserPolicy>()))
            .Callback<Guid, UserPolicy>((id, policy) => { if (id == person && policy.IsDisabled) Interlocked.Increment(ref count); })
            .Returns(Task.CompletedTask);
        return (users.Object, () => Volatile.Read(ref count));
    }

    private static JellyfinUserAction Find(IReadOnlyList<JellyfinUserAction> scanned, string controller, string action)
        => scanned.SingleOrDefault(a => a.Controller == controller && a.Action == action)
           ?? throw new Xunit.Sdk.XunitException(controller + "." + action + " not found in: " + string.Join(", ", scanned.Select(a => a.Controller + "." + a.Action)));

    /// <summary>Probe assemblies compiled into a directory of their own (removed afterwards).</summary>
    internal sealed class Probe : IDisposable
    {
        private readonly string _dir = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "je-dispatch-" + Guid.NewGuid().ToString("N"));

        public string Path(string name) => System.IO.Path.Combine(_dir, name + ".dll");

        /// <summary>Loads a compiled probe to run it (its own collectible context; Jellyfin's types from the test's).</summary>
        public System.Reflection.Assembly Load(string name)
        {
            var context = new System.Runtime.Loader.AssemblyLoadContext(name + "-" + Guid.NewGuid().ToString("N"), isCollectible: true);
            using var bytes = new MemoryStream(File.ReadAllBytes(Path(name)));
            return context.LoadFromStream(bytes);
        }

        /// <summary>Compiles each (name, source, references to earlier ones) in order.</summary>
        public static Probe Build(params (string Name, string Source, string[] References)[] assemblies) => Build(OptimizationLevel.Debug, assemblies);

        /// <summary>Compiles each (name, source, references to earlier ones) in order, optimized as asked.</summary>
        public static Probe Build(OptimizationLevel optimization, params (string Name, string Source, string[] References)[] assemblies)
        {
            var probe = new Probe();
            Directory.CreateDirectory(probe._dir);
            var platform = ((string)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")!).Split(System.IO.Path.PathSeparator)
                .Concat(Directory.EnumerateFiles(AppContext.BaseDirectory, "*.dll")).Distinct()
                .Select(p => (MetadataReference)MetadataReference.CreateFromFile(p)).ToList();
            foreach (var (name, source, references) in assemblies)
            {
                var compilation = CSharpCompilation.Create(name, new[] { CSharpSyntaxTree.ParseText(source) },
                    platform.Concat(references.Select(r => MetadataReference.CreateFromFile(probe.Path(r)))),
                    new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary, optimizationLevel: optimization, nullableContextOptions: NullableContextOptions.Enable, allowUnsafe: true));
                using var output = File.Create(probe.Path(name));
                var emitted = compilation.Emit(output);
                if (!emitted.Success) throw new Xunit.Sdk.XunitException(name + ":\n" + string.Join("\n", emitted.Diagnostics.Where(d => d.Severity == DiagnosticSeverity.Error)));
            }

            return probe;
        }

        public void Dispose()
        {
            try { Directory.Delete(_dir, recursive: true); }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
        }
    }
}
