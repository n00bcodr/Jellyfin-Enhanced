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
        public static Probe Build(params (string Name, string Source, string[] References)[] assemblies)
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
                    new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary, nullableContextOptions: NullableContextOptions.Enable, allowUnsafe: true));
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
