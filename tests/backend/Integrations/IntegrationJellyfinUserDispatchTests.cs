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
                    new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary, nullableContextOptions: NullableContextOptions.Enable));
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
