using System.Reflection;
using System.Reflection.Emit;
using System.Runtime.Loader;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Automation;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Users;
using Microsoft.AspNetCore.Mvc.Controllers;
using Microsoft.AspNetCore.Mvc.Infrastructure;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.Extensions.DependencyInjection;

namespace JE.Tests;

/// <summary>
/// 4a review round 21 (D53: exact identity, open-world inputs, MVC's own action discovery). The five round-21 findings were
/// approximations of identity (a method matched by name and parameter count, a type by its name alone, the ancestry of a
/// type outside the code read without its MethodImpl table) and closed-world assumptions (the callers the code read shows
/// are all callers; an action is a method its controller declares). Each probe below is compiled for real, scanned, and
/// RUN: the person is disabled exactly as the scan says. The last tests build a real ASP.NET Core MVC application model
/// (for probe assemblies and for Jellyfin's own Jellyfin.Api, 12.2 or 10.11.11 by the build's line) and hold the
/// classifier's actions to MVC's: the same controllers, the same actions (inherited ones included), each with its entry.
/// </summary>
[Collection("Jellyfin user versions")]
public class IntegrationJellyfinUserIdentityTests
{
    private const string Bootstrap = """
        using System; using System.IO; using System.Threading.Tasks; using Microsoft.AspNetCore.Mvc;
        using MediaBrowser.Controller.Library; using MediaBrowser.Model.Users;
        public static class Bootstrap {
         public static IUserManager Users = null!; public static Guid Person;
         public static void Disable() => Users.UpdatePolicyAsync(Person, new UserPolicy { IsDisabled = true }).GetAwaiter().GetResult();
        }
        """;

    // ------------------------------------------------------------------ 4a-r21-1: a method's identity is its signature

    // An interface slot filled by a method inherited from a base, with a nearer base declaring a method of the same name and
    // parameter count that doesn't match (another parameter type, a generic method, a by-reference parameter): the search
    // goes on to the matching one, as the runtime's does. The reviewer's probe (a handed-in callback) is kept as written.
    private static readonly Dictionary<string, string> Shadows = new(StringComparer.Ordinal)
    {
        ["ByType"] = "public virtual void Report(string value) { }",
        ["ByArity"] = "public virtual void Report<T>(int value) { }",
        ["ByRef"] = "public virtual void Report(ref int value) { }",
    };

    private static string ShadowProbe(string shadow, bool quiet) => Bootstrap + $$"""
        public class Grandparent { public virtual void Report(int value) { {{(quiet ? string.Empty : "Bootstrap.Disable();")}} } }
        public class Parent : Grandparent { {{shadow}} }
        public sealed class Child : Parent, IProgress<int> { }
        public static class Calls { public static void Call<T>(T t) where T : IProgress<int> => t.Report(1); }
        public sealed class ShadowController : ControllerBase {
         [HttpPost] public void Disable(Guid userId) { IProgress<int> p = new Child(); p.Report(1); }
         [HttpPost] public void DisablePointer(Guid userId) { IProgress<int> p = new Child(); Action<int> d = p.Report; d(1); }
         [HttpPost] public void DisableConstrained(Guid userId) => Calls.Call(new Child());
        }
        """;

    public static IEnumerable<object[]> ShadowCases()
        => Shadows.Keys.SelectMany(s => new[] { "Disable", "DisablePointer", "DisableConstrained" }.SelectMany(a => new[] { new object[] { s, a, false }, new object[] { s, a, true } }));

    [Theory]
    [MemberData(nameof(ShadowCases))]
    public async Task AnOverloadThatDoesntMatchDoesntEndTheSearchForTheInheritedFill(string shadow, string action, bool quiet)
    {
        using var lab = new Lab();
        lab.Compile("ShadowProbe", ShadowProbe(Shadows[shadow], quiet));
        var found = Find(JellyfinUserActions.Scan(lab.Path("ShadowProbe")), "ShadowController", action);
        Assert.True((quiet ? JellyfinUserKey.None : JellyfinUserKey.User) == found.Key, shadow + "." + action + ": " + found.Key + " why=" + found.Why);
        if (!quiet) Assert.Equal("reaches IUserManager.UpdatePolicyAsync", found.Why);
        Assert.Equal(quiet ? 0 : 1, await lab.Run("ShadowProbe", "ShadowController", action));
    }

    [Fact]
    public async Task TheReviewersShadowedOverloadProbeIsBracketed()
    {
        const string Source = """
            using System; using System.Threading.Tasks; using Microsoft.AspNetCore.Mvc;
            public class Grandparent {
             readonly Func<Task> _cb; public Grandparent(Func<Task> cb) { _cb=cb; }
             public virtual void Report(int i) { _cb().GetAwaiter().GetResult(); }
            }
            public class Parent : Grandparent {
             public Parent(Func<Task> cb):base(cb) {}
             public virtual void Report(string s) { }
            }
            public sealed class Child : Parent, IProgress<int> { public Child(Func<Task> cb):base(cb) {} }
            public sealed class CollisionController : ControllerBase {
             [HttpPost] public Task Disable(Guid userId,[FromServices] Func<Task> cb) { IProgress<int> p=new Child(cb);p.Report(1);return Task.CompletedTask; }
             [HttpPost] public Task DisablePointer(Guid userId,[FromServices] Func<Task> cb) { IProgress<int> p=new Child(cb); Action<int> d=p.Report; d(1);return Task.CompletedTask; }
             static void Call<T>(T p) where T:IProgress<int> => p.Report(1);
             [HttpPost] public Task DisableConstrained(Guid userId,[FromServices] Func<Task> cb) { Call(new Child(cb));return Task.CompletedTask; }
            }
            """;
        using var lab = new Lab();
        lab.Compile("CollisionProbe", Source, OptimizationLevel.Release);
        foreach (var action in new[] { "Disable", "DisablePointer", "DisableConstrained" })
        {
            var found = Find(JellyfinUserActions.Scan(lab.Path("CollisionProbe")), "CollisionController", action);
            Assert.True(found.Key == JellyfinUserKey.User, action + ": " + found.Key + " why=" + found.Why);
            Assert.StartsWith("unresolved callback delegate Grandparent._cb", found.Why, StringComparison.Ordinal);
            Assert.Equal(1, await lab.Run("CollisionProbe", "CollisionController", action));
        }
    }

    // ------------------------------------------------------------------ 4a-r21-2: a type's identity is its assembly and name

    // Two assemblies define Shared.Mid: one plain, one deriving from MemoryStream. A sink deriving from the second overrides
    // Stream.Write; another type derives from the first. Each type's ancestry is its own assembly's Mid (the reviewer's
    // probe: both assemblies outside the code read, read from metadata; and both in the code read).
    private const string TwinPlain = "namespace Shared { public class Mid { } }";
    private const string TwinStream = "namespace Shared { public class Mid : System.IO.MemoryStream { } }";

    private const string TwinProbe = """
        extern alias TwinA; extern alias TwinB;
        using System; using System.Threading.Tasks; using Microsoft.AspNetCore.Mvc;
        public class Plain : TwinA::Shared.Mid { }
        public sealed class Sink : TwinB::Shared.Mid {
         private readonly Func<Task> _cb;
         public Sink(Func<Task> cb) { _cb = cb; }
         public override void Write(byte[] b, int o, int n) { _cb().GetAwaiter().GetResult(); }
        }
        public sealed class IdentityController : ControllerBase {
         [HttpPost] public Task Disable(Guid userId, [FromServices] Func<Task> cb) { new Sink(cb).Write(new byte[1], 0, 1); return Task.CompletedTask; }
        }
        """;

    [Theory]
    [InlineData("System.JeTwinA", "System.JeTwinB")]
    [InlineData("JeTwinA", "JeTwinB")]
    public async Task TwoTypesWithOneNameInTwoAssembliesKeepTheirOwnAncestry(string plain, string stream)
    {
        using var lab = new Lab();
        lab.Compile(plain, TwinPlain);
        lab.Compile(stream, TwinStream);
        lab.Compile("TwinProbe", TwinProbe, OptimizationLevel.Release, (plain, "TwinA"), (stream, "TwinB"));
        Assert.Equal(!plain.StartsWith("System.", StringComparison.Ordinal), JellyfinUserActions.CodeOf(lab.Path("TwinProbe")).Any(f => f.EndsWith(plain + ".dll", StringComparison.Ordinal)));
        var found = Find(JellyfinUserActions.Scan(lab.Path("TwinProbe")), "IdentityController", "Disable");
        Assert.True(found.Key == JellyfinUserKey.User, found.Key + " why=" + found.Why);
        Assert.StartsWith("unresolved callback delegate Sink._cb", found.Why, StringComparison.Ordinal);
        Assert.Empty(JellyfinUserActions.AncestryGaps(lab.Path("TwinProbe")));
        Assert.Equal(1, await lab.Run("TwinProbe", "IdentityController", "Disable"));
    }

    // ------------------------------------------------------------------ 4a-r21-3: the slot metadata of types outside the code read

    // A covariant override chain through types outside the code read (C# writes each covariant override as a new slot with a
    // MethodImpl to the one it overrides): Root.Make → Parent.Make (outside) → Child.Make (code read), called through Root;
    // and an interface implemented outside the code read by a MethodImpl under another name (IHook.Run → Parent.Hook),
    // overridden in the code read. Both base assemblies are named like .NET's: only their metadata is read.
    private const string CovariantBase = "namespace Cov { public class R0 {} public class R1 : R0 {} public class R2 : R1 {} public class Root { public virtual R0 Make() => new R0(); } public class Parent : Root { public override R1 Make() => new R1(); } }";

    [Theory]
    [InlineData("Covariant")]
    [InlineData("InterfaceImpl")]
    public async Task AnOverrideChainThroughMethodImplsOutsideTheCodeReadIsFollowed(string kind)
    {
        using var lab = new Lab();
        string source;
        if (kind == "Covariant")
        {
            lab.Compile("System.JeCovariant", CovariantBase);
            source = Bootstrap + """
                public class Child : Cov.Parent { public override Cov.R2 Make() { Bootstrap.Disable(); return new Cov.R2(); } }
                public class ChainController : ControllerBase {
                 [HttpPost] public void Disable(Guid userId) => ((Cov.Root)new Child()).Make();
                 [HttpPost] public void DisablePointer(Guid userId) { Func<Cov.R0> make = ((Cov.Root)new Child()).Make; make(); }
                }
                """;
            lab.Compile("ChainProbe", source, OptimizationLevel.Release, ("System.JeCovariant", null));
        }
        else
        {
            lab.Emit("System.JeSlots", HookAssembly);
            source = Bootstrap + """
                public class Child : Slots.Parent { public override void Hook() => Bootstrap.Disable(); }
                public static class Calls { public static void Call<T>(T t) where T : Slots.IHook => t.Run(); }
                public class ChainController : ControllerBase {
                 [HttpPost] public void Disable(Guid userId) => ((Slots.IHook)new Child()).Run();
                 [HttpPost] public void DisablePointer(Guid userId) { Action run = ((Slots.IHook)new Child()).Run; run(); }
                 [HttpPost] public void DisableConstrained(Guid userId) => Calls.Call(new Child());
                }
                """;
            lab.Compile("ChainProbe", source, OptimizationLevel.Release, ("System.JeSlots", null));
        }

        Assert.DoesNotContain(JellyfinUserActions.CodeOf(lab.Path("ChainProbe")), f => Path.GetFileName(f).StartsWith("System.Je", StringComparison.Ordinal));
        foreach (var action in JellyfinUserActions.Scan(lab.Path("ChainProbe")).Where(a => a.Controller == "ChainController"))
        {
            Assert.True(action.Key == JellyfinUserKey.User, kind + "." + action.Action + ": " + action.Key + " why=" + action.Why);
            Assert.Equal("reaches IUserManager.UpdatePolicyAsync", action.Why);
            Assert.Equal(1, await lab.Run("ChainProbe", "ChainController", action.Action));
        }
    }

    // An assembly (named as its file) with interface Slots.IHook { void Run(); } and class Slots.Parent : IHook { public virtual
    // void Hook() { } } whose `.override IHook::Run` is Hook (C# can't name an implementation differently from its slot;
    // other languages can).
    internal static void HookAssembly(string path)
    {
        var name = Path.GetFileNameWithoutExtension(path);
        var builder = new PersistedAssemblyBuilder(new AssemblyName(name), typeof(object).Assembly);
        var module = builder.DefineDynamicModule(name);
        var face = module.DefineType("Slots.IHook", TypeAttributes.Public | TypeAttributes.Interface | TypeAttributes.Abstract);
        var run = face.DefineMethod("Run", MethodAttributes.Public | MethodAttributes.Abstract | MethodAttributes.Virtual | MethodAttributes.NewSlot | MethodAttributes.HideBySig, typeof(void), Type.EmptyTypes);
        var parent = module.DefineType("Slots.Parent", TypeAttributes.Public | TypeAttributes.Class, typeof(object));
        parent.AddInterfaceImplementation(face);
        parent.DefineDefaultConstructor(MethodAttributes.Public);
        var hook = parent.DefineMethod("Hook", MethodAttributes.Public | MethodAttributes.Virtual | MethodAttributes.NewSlot | MethodAttributes.HideBySig, typeof(void), Type.EmptyTypes);
        hook.GetILGenerator().Emit(OpCodes.Ret);
        parent.DefineMethodOverride(hook, run);
        face.CreateType();
        parent.CreateType();
        builder.Save(path);
    }

    // ------------------------------------------------------------------ 4a-r21-4: callers outside the code read

    // A method code outside the code read can call (a public constructor dependency injection uses, a public or protected
    // member of a visible type, a virtual method, a method a delegate is made from) has what the code read hands it AND
    // whatever its outside callers hand it: an internal caller never narrows it. The reviewer's probe: a controller built by
    // DI with an Action, which an unused factory also builds with a harmless lambda. Controls: the DI-only controller, a
    // private helper every caller fills with a harmless lambda (unbracketed), and a public helper with the same harmless
    // caller (bracketed: an outside caller may hand it anything).
    private const string OpenWorldProbe = Bootstrap + """
        public class MixedController : ControllerBase {
         private readonly Action _change;
         public MixedController(Action change) { _change = change; }
         public static MixedController Quiet() => new MixedController(() => { });
         [HttpPost] public void Disable(Guid userId) => _change();
        }
        public class InjectedController : ControllerBase {
         private readonly Action _change;
         public InjectedController(Action change) { _change = change; }
         [HttpPost] public void Disable(Guid userId) => _change();
        }
        public class MixedActionController : ControllerBase {
         [HttpPost] public void Disable(Guid userId, [FromServices] Action cb) => cb();
         [NonAction] public void Quiet() => Disable(Guid.Empty, () => { });
        }
        public static class Work { public static void Run(Action work) => work(); }
        public class PublicHelperController : ControllerBase { [HttpPost] public void Note(Guid userId) => Work.Run(() => { }); }
        public class PrivateHelperController : ControllerBase {
         private static void Run(Action work) => work();
         [HttpPost] public void Note(Guid userId) => Run(() => { });
        }
        """;

    [Theory]
    [InlineData("MixedController", "Disable", "unresolved callback delegate MixedController._change", 1)]
    [InlineData("InjectedController", "Disable", "unresolved callback delegate InjectedController._change", 1)]
    [InlineData("MixedActionController", "Disable", "unresolved callback Action handed to MixedActionController.Disable from outside the code read", 1)]
    [InlineData("PublicHelperController", "Note", "unresolved callback Action handed to Work.Run from outside the code read", 0)]
    [InlineData("PrivateHelperController", "Note", null, 0)]
    public async Task AnInternalCallerNeverNarrowsWhatOutsideCallersHandIn(string controller, string action, string? why, int disables)
    {
        using var lab = new Lab();
        lab.Compile("OpenWorldProbe", OpenWorldProbe, OptimizationLevel.Release);
        var found = Find(JellyfinUserActions.Scan(lab.Path("OpenWorldProbe")), controller, action);
        if (why == null) Assert.True(found.Key == JellyfinUserKey.None, controller + ": " + found.Key + " why=" + found.Why);
        else
        {
            Assert.True(found.Key == JellyfinUserKey.User, controller + ": " + found.Key + " why=" + found.Why);
            Assert.StartsWith(why, found.Why, StringComparison.Ordinal);
        }

        Assert.Equal(disables, await lab.Run("OpenWorldProbe", controller, action));
    }

    // ------------------------------------------------------------------ 4a-r21-5: MVC's actions, inherited ones included

    // An action declared in an abstract base (the reviewer's probe: a GET whose code changes the person), in a base in another
    // assembly of the code read, and in a base outside the code read (its body can't be read: fail closed, everyone's for a
    // write). Each is classified under the controller MVC finds it on, and KeyOf answers for the MethodInfo MVC hands it.
    private const string InheritedBases = """
        using System; using Microsoft.AspNetCore.Mvc;
        using MediaBrowser.Controller.Library; using MediaBrowser.Model.Users;
        public static class BaseBootstrap {
         public static IUserManager Users = null!; public static Guid Person;
         public static void Disable() => Users.UpdatePolicyAsync(Person, new UserPolicy { IsDisabled = true }).GetAwaiter().GetResult();
        }
        public abstract class SharedBase : ControllerBase { [HttpPost] public void Disable(Guid userId) => BaseBootstrap.Disable(); }
        """;

    private const string InheritedOutside = "using System; using Microsoft.AspNetCore.Mvc; public abstract class OutsideBase : ControllerBase { [HttpPost] public void Remote(Guid userId) { } }";

    private const string InheritedProbe = Bootstrap + """
        public abstract class BaseController : ControllerBase { [HttpGet] public void Disable(Guid userId) => Bootstrap.Disable(); }
        public class TestController : BaseController { }
        public class OtherModuleController : SharedBase { }
        public class OutsideController : OutsideBase { }
        """;

    [Theory]
    [InlineData("TestController", "Disable", "GET", JellyfinUserKey.User, "reaches IUserManager.UpdatePolicyAsync")]
    [InlineData("OtherModuleController", "Disable", "POST", JellyfinUserKey.User, "reaches IUserManager.UpdatePolicyAsync")]
    [InlineData("OutsideController", "Remote", "POST", JellyfinUserKey.Global, "unresolved OutsideBase.Remote (an action declared outside the code read)")]
    public void AnInheritedActionIsClassifiedUnderTheControllerMvcFindsItOn(string controller, string action, string verb, JellyfinUserKey expected, string why)
    {
        using var lab = new Lab();
        lab.Compile("JeBases", InheritedBases);
        lab.Compile("System.JeOutsideBase", InheritedOutside);
        lab.Compile("InheritedProbe", InheritedProbe, OptimizationLevel.Debug, ("JeBases", null), ("System.JeOutsideBase", null));
        var found = Find(JellyfinUserActions.Scan(lab.Path("InheritedProbe")), controller, action);
        Assert.True(found.Key == expected, controller + ": " + found.Key + " why=" + found.Why);
        Assert.Equal(why, found.Why);
        using var loaded = lab.Context();
        var mvc = MvcActions(loaded.Load("InheritedProbe")).Single(a => a.ControllerTypeInfo.Name == controller && a.MethodInfo.Name == action);
        Assert.Equal(expected, JellyfinUserActions.KeyOf(mvc.MethodInfo, controller, verb));
    }

    [Fact]
    public async Task TheReviewersInheritedActionReallyDisablesThePerson()
    {
        using var lab = new Lab();
        lab.Compile("JeBases", InheritedBases);
        lab.Compile("System.JeOutsideBase", InheritedOutside);
        lab.Compile("InheritedProbe", InheritedProbe, OptimizationLevel.Debug, ("JeBases", null), ("System.JeOutsideBase", null));
        Assert.Equal(1, await lab.Run("InheritedProbe", "TestController", "Disable"));
    }

    // ------------------------------------------------------------------ MVC's own action discovery, verified against MVC

    // The shapes MVC's rules distinguish: inherited actions (from an abstract base, another module, a closed generic base),
    // overrides (only the most derived), hidden methods (both), [NonAction] inherited through an override, object's and
    // IDisposable's members, a POCO controller, [Controller] / [NonController] inherited, a lower-case suffix, nested,
    // internal, abstract and open generic types (not controllers), static, generic and protected methods (not actions).
    private const string MvcShapes = """
        using System; using Microsoft.AspNetCore.Mvc;
        namespace Shapes {
        public abstract class BaseCtl : ControllerBase { [HttpPost] public void Inherited() {} public virtual void Virt() {} public abstract void Abs(); public void M() {} public void M(int x) {} [NonAction] public virtual void NA() {} public static void S() {} public void G<T>() {} protected void P() {} }
        public class HideController : BaseCtl { public new void M() {} public override void Virt() {} public override void Abs() {} public override void NA() {} public override string ToString() => ""; public void Dispose() {} public new string GetHashCode() => ""; }
        public class DispController : ControllerBase, IDisposable { public void Dispose() {} public void Other() {} }
        public class DispNewController : DispController { public new void Dispose() {} }
        public class DispVirtualController : ControllerBase, IDisposable { public virtual void Dispose() {} }
        public class DispOverrideController : DispVirtualController { public override void Dispose() {} }
        public class lowercontroller : ControllerBase { public void Act() {} }
        public class Poco { public void Act() {} }
        public class PocoController { public void Act() {} }
        [NonController] public class NoController : ControllerBase { public void Act() {} }
        public class NoChildController : NoController { public void Act2() {} }
        public class GenController<T> : ControllerBase { public void Act() {} public void Typed(T value) {} }
        public class ClosedController : GenController<int> { }
        public class Outer { public class NestedController : ControllerBase { public void Act() {} } }
        internal class InternalController : ControllerBase { public void Act() {} }
        [Controller] public class Attributed { public void Act() {} }
        public class AttributedChild : Attributed { public void Act2() {} }
        public class CtlController : Controller { public void Act() {} }
        public abstract class AbstractController : ControllerBase { public void Act() {} }
        public class SharedChildController : SharedBase { public void Own() {} }
        public class OutsideChildController : OutsideBase { }
        }
        """;

    [Fact]
    public void TheActionsAreMvcsOwnForProbeShapes()
    {
        using var lab = new Lab();
        lab.Compile("JeBases", InheritedBases);
        lab.Compile("System.JeOutsideBase", InheritedOutside);
        lab.Compile("MvcShapes", MvcShapes, OptimizationLevel.Debug, ("JeBases", null), ("System.JeOutsideBase", null));
        using var loaded = lab.Context();
        var assembly = loaded.Load("MvcShapes");
        AssertSameActions(lab.Path("MvcShapes"), MvcActions(assembly), assembly);
    }

    // Jellyfin's own Jellyfin.Api (the pinned 12.2 on the Jellyfin 12 build, 10.11.11 on the 10.11 one), loaded for real
    // (its folder's assemblies, the shared framework's from the host), its application model built by MVC.
    [Fact]
    public void TheActionsAreMvcsOwnForJellyfin()
    {
        using var api = JellyfinApiAssembly.Load();
        using var loaded = new JellyfinContext(Path.GetDirectoryName(api.Path)!);
        var assembly = loaded.LoadFromAssemblyPath(api.Path);
        var actions = MvcActions(assembly);
        Assert.True(actions.Count > 300, "MVC found " + actions.Count + " actions in Jellyfin " + api.Version);
        AssertSameActions(api.Path, actions, assembly);
    }

    private static void AssertSameActions(string path, IReadOnlyList<ControllerActionDescriptor> mvc, Assembly assembly)
    {
        static string Id(string controller, string? module, int token) => controller + " " + module + ":" + token.ToString("x8");
        var tokenProperty = typeof(JellyfinUserAction).GetProperty("Token");
        var moduleProperty = typeof(JellyfinUserAction).GetProperty("Module");
        Assert.True(tokenProperty != null && moduleProperty != null, "JellyfinUserAction carries no method identity (Module, Token)");
        var scanned = JellyfinUserActions.Scan(path).Select(a => Id(a.Controller, (string?)moduleProperty!.GetValue(a), (int)tokenProperty!.GetValue(a)!)).ToList();
        Assert.Equal(scanned.Count, scanned.Distinct().Count());
        // MVC makes one descriptor per route (an action with two routes is two): its actions are the distinct methods.
        var expected = mvc.Select(a => Id(a.ControllerTypeInfo.Name, a.MethodInfo.Module.Assembly.GetName().Name, a.MethodInfo.MetadataToken)).Distinct().ToList();
        var names = mvc.GroupBy(a => Id(a.ControllerTypeInfo.Name, a.MethodInfo.Module.Assembly.GetName().Name, a.MethodInfo.MetadataToken)).ToDictionary(g => g.Key, g => g.First().ControllerTypeInfo.Name + "." + g.First().MethodInfo.Name);
        var missing = expected.Except(scanned).Select(id => "MVC has " + names[id] + " (" + id + "), the scan doesn't").ToList();
        var extra = scanned.Except(expected).Select(id => "the scan has " + id + ", MVC doesn't").ToList();
        Assert.True(missing.Count + extra.Count == 0, string.Join("\n", missing.Concat(extra)));
        Assert.Equal(expected.Count, scanned.Count);
        // Every MVC action has its own entry: KeyOf never falls back to the unreadable-assembly answer for one of them.
        foreach (var action in mvc)
            _ = JellyfinUserActions.KeyOf(action.MethodInfo, action.ControllerTypeInfo.Name, "POST");
    }

    // The controller actions a real MVC application model has for one assembly.
    private static List<ControllerActionDescriptor> MvcActions(Assembly assembly)
    {
        var services = new ServiceCollection();
        services.AddLogging();
        services.AddControllers().AddApplicationPart(assembly);
        using var provider = services.BuildServiceProvider();
        return provider.GetRequiredService<IActionDescriptorCollectionProvider>().ActionDescriptors.Items.OfType<ControllerActionDescriptor>()
            .Where(a => a.ControllerTypeInfo.Assembly == assembly).ToList();
    }

    // Jellyfin's assemblies from its folder; the shared framework's (ASP.NET Core's above all, so MVC sees its own
    // ControllerBase) from the host.
    private sealed class JellyfinContext : AssemblyLoadContext, IDisposable
    {
        private static readonly HashSet<string> Shared = ((string)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")!).Split(Path.PathSeparator)
            .Where(p => p.Contains(Path.DirectorySeparatorChar + "shared" + Path.DirectorySeparatorChar, StringComparison.Ordinal))
            .Select(Path.GetFileNameWithoutExtension).ToHashSet(StringComparer.OrdinalIgnoreCase)!;

        private readonly string _folder;

        public JellyfinContext(string folder) : base("jellyfin-mvc-" + Guid.NewGuid().ToString("N"), isCollectible: true) => _folder = folder;

        protected override Assembly? Load(AssemblyName name)
        {
            if (name.Name == null || Shared.Contains(name.Name)) return null;
            var file = Path.Combine(_folder, name.Name + ".dll");
            return File.Exists(file) ? LoadFromAssemblyPath(file) : null;
        }

        public void Dispose() => Unload();
    }

    // ------------------------------------------------------------------ helpers

    private static JellyfinUserAction Find(IReadOnlyList<JellyfinUserAction> scanned, string controller, string action)
        => scanned.SingleOrDefault(a => a.Controller == controller && a.Action == action)
           ?? throw new Xunit.Sdk.XunitException(controller + "." + action + " not found in: " + string.Join(", ", scanned.Select(a => a.Controller + "." + a.Action)));

    /// <summary>Probe assemblies compiled (or emitted) into a folder of their own, scanned there, and run in a fresh load.</summary>
    internal sealed class Lab : IDisposable
    {
        private static readonly Lazy<List<MetadataReference>> Platform = new(() => ((string)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")!).Split(System.IO.Path.PathSeparator)
            .Concat(Directory.EnumerateFiles(AppContext.BaseDirectory, "*.dll")).Distinct(StringComparer.Ordinal)
            .Select(p => (MetadataReference)MetadataReference.CreateFromFile(p)).ToList());

        private readonly string _dir = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "je-identity-" + Guid.NewGuid().ToString("N"));

        public Lab() => Directory.CreateDirectory(_dir);

        public string Path(string name) => System.IO.Path.Combine(_dir, name + ".dll");

        public void Compile(string name, string source) => Compile(name, source, OptimizationLevel.Debug);

        /// <summary>Compiles source, referencing the platform and earlier assemblies of the lab (each with an extern alias or none).</summary>
        public void Compile(string name, string source, OptimizationLevel optimization, params (string Name, string? Alias)[] references)
        {
            var compilation = CSharpCompilation.Create(name, new[] { CSharpSyntaxTree.ParseText(source) },
                Platform.Value.Concat(references.Select(r => r.Alias == null ? MetadataReference.CreateFromFile(Path(r.Name)) : MetadataReference.CreateFromFile(Path(r.Name)).WithAliases(new[] { r.Alias }))),
                new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary, optimizationLevel: optimization, nullableContextOptions: NullableContextOptions.Enable));
            using var output = File.Create(Path(name));
            var emitted = compilation.Emit(output);
            if (!emitted.Success) throw new Xunit.Sdk.XunitException(name + ":\n" + string.Join("\n", emitted.Diagnostics.Where(d => d.Severity == DiagnosticSeverity.Error)));
        }

        /// <summary>An assembly written by code (what C# can't express).</summary>
        public void Emit(string name, Action<string> write) => write(Path(name));

        /// <summary>A fresh collectible load of the lab's assemblies (Jellyfin's and the platform's from the host).</summary>
        public Loaded Context() => new(this);

        /// <summary>Builds the controller (an Action or Func&lt;Task&gt; it asks for: the closure DI would hand it) and runs the
        /// action (its userId: the person; an Action or Func&lt;Task&gt;: the closure): how many times the person was disabled.</summary>
        public async Task<int> Run(string assembly, string controller, string action)
        {
            var person = Guid.NewGuid();
            var count = 0;
            var users = new Moq.Mock<IUserManager>();
            users.Setup(u => u.UpdatePolicyAsync(Moq.It.IsAny<Guid>(), Moq.It.IsAny<UserPolicy>()))
                .Callback<Guid, UserPolicy>((id, policy) => { if (id == person && policy.IsDisabled) Interlocked.Increment(ref count); })
                .Returns(Task.CompletedTask);
            Action closure = () => users.Object.UpdatePolicyAsync(person, new UserPolicy { IsDisabled = true }).GetAwaiter().GetResult();
            Func<Task> asyncClosure = () => users.Object.UpdatePolicyAsync(person, new UserPolicy { IsDisabled = true });
            object Argument(Type type) => type == typeof(Guid) ? person : type == typeof(Action) ? closure : type == typeof(Func<Task>) ? asyncClosure
                : throw new Xunit.Sdk.XunitException("unexpected parameter " + type);
            using var loaded = Context();
            var probe = loaded.Load(assembly);
            foreach (var file in Directory.EnumerateFiles(_dir, "*.dll")) loaded.Load(System.IO.Path.GetFileNameWithoutExtension(file));
            foreach (var bootstrap in loaded.All.Select(a => a.GetType("Bootstrap") ?? a.GetType("BaseBootstrap")).Where(t => t != null))
            {
                bootstrap!.GetField("Users")!.SetValue(null, users.Object);
                bootstrap.GetField("Person")!.SetValue(null, person);
            }

            var type = probe.GetType(controller)!;
            var constructor = type.GetConstructors().OrderByDescending(c => c.GetParameters().Length).First();
            var instance = constructor.Invoke(constructor.GetParameters().Select(p => Argument(p.ParameterType)).ToArray());
            Assert.Equal(0, Volatile.Read(ref count));
            var method = type.GetMethod(action)!;
            if (method.Invoke(instance, method.GetParameters().Select(p => Argument(p.ParameterType)).ToArray()) is Task task) await task;
            return Volatile.Read(ref count);
        }

        public void Dispose()
        {
            try { Directory.Delete(_dir, recursive: true); }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
        }

        /// <summary>A collectible load context resolving the lab's assemblies by name.</summary>
        internal sealed class Loaded : IDisposable
        {
            private readonly Lab _lab;
            private readonly AssemblyLoadContext _context = new("je-identity-" + Guid.NewGuid().ToString("N"), isCollectible: true);
            private readonly Dictionary<string, Assembly> _loaded = new(StringComparer.Ordinal);

            public Loaded(Lab lab)
            {
                _lab = lab;
                _context.Resolving += (_, name) => name.Name != null && File.Exists(_lab.Path(name.Name)) ? Load(name.Name) : null;
            }

            public IEnumerable<Assembly> All => _loaded.Values.ToList();

            public Assembly Load(string name)
            {
                // From its file: KeyOf reads an assembly where it was loaded from, as the filter does.
                if (!_loaded.TryGetValue(name, out var assembly)) _loaded[name] = assembly = _context.LoadFromAssemblyPath(_lab.Path(name));

                return assembly;
            }

            public void Dispose() => _context.Unload();
        }
    }
}
