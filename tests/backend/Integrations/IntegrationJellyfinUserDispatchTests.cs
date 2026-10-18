using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Automation;
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

    private static JellyfinUserAction Find(IReadOnlyList<JellyfinUserAction> scanned, string controller, string action)
        => scanned.SingleOrDefault(a => a.Controller == controller && a.Action == action)
           ?? throw new Xunit.Sdk.XunitException(controller + "." + action + " not found in: " + string.Join(", ", scanned.Select(a => a.Controller + "." + a.Action)));

    /// <summary>Probe assemblies compiled into a directory of their own (removed afterwards).</summary>
    internal sealed class Probe : IDisposable
    {
        private readonly string _dir = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "je-dispatch-" + Guid.NewGuid().ToString("N"));

        public string Path(string name) => System.IO.Path.Combine(_dir, name + ".dll");

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
