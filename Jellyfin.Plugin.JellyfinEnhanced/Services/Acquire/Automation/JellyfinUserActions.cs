using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Reflection.Emit;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using System.Reflection.PortableExecutable;
using System.Threading.Tasks;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Automation
{
    /// <summary>Which Jellyfin user version an action runs inside (<see cref="JellyfinUserChangeBracket"/>).</summary>
    public enum JellyfinUserKey
    {
        /// <summary>The action can't change or authenticate a user: no bracket.</summary>
        None,

        /// <summary>The person the action is about: its <c>userId</c> argument, else the signed-in person (Jellyfin's default).</summary>
        User,

        /// <summary>The person isn't known before the action runs (a sign-in by name, a new user, the start-up wizard): every person's.</summary>
        Global,
    }

    /// <summary>One controller action, as <see cref="JellyfinUserActions"/> classified it.</summary>
    /// <param name="Controller">The controller's type name (no namespace).</param>
    /// <param name="Action">The action's method name.</param>
    /// <param name="Verbs">Its HTTP methods ("*": any).</param>
    /// <param name="Key">The bracket it runs inside.</param>
    /// <param name="Why">Why it is bracketed ("user controller", "reaches IUserManager.UpdatePolicyAsync", "unresolved IFoo.Bar", "reviewed"); null when it isn't.</param>
    /// <param name="Reaches">The user change or sign-in its code reaches ("IUserManager.UpdatePolicyAsync"), whatever else applies; null: none.</param>
    /// <param name="Via">The calls from the action to what it reaches (or, unresolved, to what couldn't be followed), for review; null: neither.</param>
    public sealed record JellyfinUserAction(string Controller, string Action, IReadOnlyList<string> Verbs, JellyfinUserKey Key, string? Why, string? Reaches, IReadOnlyList<string>? Via = null);

    /// <summary>
    /// 4a review rounds 9 and 10: which controller actions can create, delete, change, lock or authenticate a Jellyfin user,
    /// read from the code (System.Reflection.Metadata: nothing is loaded or run), so a Jellyfin update that adds or renames
    /// one is bracketed without a change here. DENY BY DEFAULT: an action is bracketed when
    /// <list type="bullet">
    /// <item><description>it is on Jellyfin's user, Quick Connect or start-up controller and isn't GET-only;</description></item>
    /// <item><description>its code reaches a member of <see cref="Mutates"/> (everything on IUserManager except its reviewed reads,
    /// the session manager's sign-ins, Quick Connect's authorization, the authentication and password-reset providers, and
    /// a write to a user entity), following its async state machine, its lambdas, and every call ACROSS the Jellyfin server
    /// assemblies (round 10): a call through an interface or a virtual method goes to every implementation or override
    /// those assemblies have, a delegate field to what its stores (a constructor's, an initializer's) put in it, an event
    /// to the handlers subscribed to it;</description></item>
    /// <item><description>it isn't a GET and its code reaches a call that can't be followed (an interface nothing read implements,
    /// a delegate stored from outside the code read): it is bracketed for everyone (a GET isn't: it would hold automation
    /// on every page view);</description></item>
    /// <item><description>or it is on the <see cref="Reviewed"/> list.</description></item>
    /// </list>
    /// The code read is the controller's assembly, with the Jellyfin server assemblies (Jellyfin.*, MediaBrowser.*, Emby.*)
    /// of its folder when that is Jellyfin's, else every assembly of its folder and Jellyfin's. It is read once (in the
    /// background for Jellyfin.Api), then each action is a dictionary lookup. An assembly that can't be read brackets every
    /// one of its actions that isn't GET, globally. JE's own actions are left to the brackets inside them.
    /// </summary>
    public static class JellyfinUserActions
    {
        /// <summary>Jellyfin's controllers whose every non-GET action is bracketed.</summary>
        public static readonly IReadOnlySet<string> UserControllers = new HashSet<string>(StringComparer.Ordinal) { "UserController", "QuickConnectController", "StartupController" };

        /// <summary>Actions bracketed whatever their code shows ("Controller.Action"): none are needed for 12.2 and 10.11, whose
        /// user-changing actions all reach a <see cref="Mutates"/> member; kept for one whose change the code can't show.</summary>
        public static readonly IReadOnlySet<string> Reviewed = new HashSet<string>(StringComparer.Ordinal);

        /// <summary>
        /// Members followed into that change a user's record but no authority the automatic-write check reads ("Type.Member",
        /// the declaring type's simple name), each reviewed in the 12.2 and 10.11.11 sources. A call of one isn't followed.
        /// </summary>
        public static readonly IReadOnlyDictionary<string, string> NotAuthority = new Dictionary<string, string>(StringComparer.Ordinal);

        /// <summary>
        /// Members whose user change is only ever to the person the request is for: its <c>userId</c> argument, else the
        /// signed-in person (the bracket's own key), whatever the action ("Type.Member", the declaring type's simple name).
        /// An action reaching a user change only through one of these is bracketed for that person, not for everyone.
        /// Each is reviewed in the 12.2 and 10.11.11 sources, and IntegrationJellyfinUserDispatchTests holds what its code
        /// reaches to the reviewed change.
        /// </summary>
        public static readonly IReadOnlyDictionary<string, string> PersonScoped = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            // GetSession(…, userId) reads the user of userId, else of the signed-in person, and hands it to
            // ISessionManager.LogSessionActivity, which saves that user whole (IUserManager.UpdateUserAsync, at most once a
            // minute) with its LastActivityDate moved. 12.2 and 10.11 copy every value and permission of the object handed
            // in, so the save can write back what was read at the start of the request: a change, bracketed for that person.
            ["RequestHelpers.GetSession"] = "IUserManager.UpdateUserAsync (LogSessionActivity's activity-date save of the request's person)",
        };

        // IUserManager's members that only read (everything else on it changes or authenticates a user).
        private static readonly HashSet<string> UserManagerReads = new(StringComparer.Ordinal)
        {
            "GetUsers", "GetUsersIds", "GetUserById", "GetFirstUser", "GetUserByName", "GetUserDto", "GetAuthenticationProviders",
            "GetPasswordResetProviders", "add_OnUserUpdated", "remove_OnUserUpdated", "get_Users", "get_UsersIds",
        };

        // Quick Connect's members that touch no user: whether it is on, a new code, a code's state.
        private static readonly HashSet<string> QuickConnectReads = new(StringComparer.Ordinal) { "get_IsEnabled", "TryConnect", "CheckRequestStatus" };

        // A user entity's members that only read.
        private static readonly HashSet<string> UserEntityReads = new(StringComparer.Ordinal) { "HasPermission", "GetPreference", "GetPreferenceValues", "GetPreferenceValue", "IsParentalScheduleAllowed", "IsFolderGrouped" };

        private static readonly ConcurrentDictionary<string, Lazy<CodeSet?>> Assemblies = new(StringComparer.Ordinal);

        /// <summary>
        /// Whether a call of <paramref name="member"/> on <paramref name="type"/> (full name, generic arity included) can create,
        /// delete, change, lock or authenticate a user. Also what JE's own code must call inside a
        /// <see cref="JellyfinUserVersions"/> bracket.
        /// </summary>
        /// <param name="type">The declaring type's full name.</param>
        /// <param name="member">The member's metadata name (<c>set_X</c> for a property setter).</param>
        public static bool Mutates(string type, string member) => type switch
        {
            "MediaBrowser.Controller.Library.IUserManager" or "Jellyfin.Server.Implementations.Users.UserManager" => !UserManagerReads.Contains(member) && !member.StartsWith("get_", StringComparison.Ordinal),
            "MediaBrowser.Controller.Session.ISessionManager" or "Emby.Server.Implementations.Session.SessionManager" => member.StartsWith("Authenticate", StringComparison.Ordinal),
            "MediaBrowser.Controller.QuickConnect.IQuickConnect" or "Emby.Server.Implementations.QuickConnect.QuickConnectManager" => !QuickConnectReads.Contains(member),
            "MediaBrowser.Controller.Authentication.IAuthenticationProvider" or "MediaBrowser.Controller.Authentication.IPasswordResetProvider" => true,
            "Jellyfin.Database.Implementations.Entities.User" or "Jellyfin.Data.Entities.User" => !UserEntityReads.Contains(member) && !member.StartsWith("get_", StringComparison.Ordinal) && member != ".ctor",
            "Jellyfin.Database.Implementations.Entities.Permission" or "Jellyfin.Data.Entities.Permission" => member.StartsWith("set_", StringComparison.Ordinal),
            _ => false,
        };

        // A member of the types Mutates classifies whole that it doesn't count (their reviewed reads), or one reviewed as
        // touching no authority: not followed any further.
        private static bool ReviewedRead(string type, string member) => type switch
        {
            "MediaBrowser.Controller.Library.IUserManager" or "Jellyfin.Server.Implementations.Users.UserManager" => true,
            "MediaBrowser.Controller.QuickConnect.IQuickConnect" or "Emby.Server.Implementations.QuickConnect.QuickConnectManager" => true,
            "MediaBrowser.Controller.Authentication.IAuthenticationProvider" or "MediaBrowser.Controller.Authentication.IPasswordResetProvider" => true,
            "Jellyfin.Database.Implementations.Entities.User" or "Jellyfin.Data.Entities.User" => true,
            "Jellyfin.Database.Implementations.Entities.Permission" or "Jellyfin.Data.Entities.Permission" => true,
            _ => NotAuthority.ContainsKey(Simple(type) + "." + member),
        };

        private static string Simple(string type) => type[(Math.Max(type.LastIndexOf('.'), type.LastIndexOf('+')) + 1)..];

        /// <summary>
        /// The bracket the action of <paramref name="method"/> on <paramref name="controller"/> runs inside. The first call for
        /// an assembly reads it (see <see cref="Warm"/>); an assembly that can't be read brackets every request that isn't a
        /// GET, globally.
        /// </summary>
        /// <param name="method">The action's method.</param>
        /// <param name="controller">The controller's type name.</param>
        /// <param name="requestMethod">The request's HTTP method (for an assembly that can't be read).</param>
        public static JellyfinUserKey KeyOf(MethodInfo method, string controller, string requestMethod)
        {
            // JE's own actions bracket their user changes themselves, keyed by the user (maintenance mode's policy writes;
            // IntegrationAutomationBracketScanTests holds every one to it), so their requests aren't bracketed again: a
            // page's bootstrap, which can end an expired maintenance window, would otherwise move everyone's version.
            if (method.Module.Assembly == typeof(JellyfinUserActions).Assembly) return JellyfinUserKey.None;
            var actions = method.Module.Assembly is { } assembly ? Of(assembly) : null;
            if (actions?.Classify(method.MetadataToken, controller) is { } action) return action.Key;
            return string.Equals(requestMethod, "GET", StringComparison.OrdinalIgnoreCase) || string.Equals(requestMethod, "HEAD", StringComparison.OrdinalIgnoreCase)
                ? JellyfinUserKey.None
                : JellyfinUserKey.Global;
        }

        /// <summary>Reads the controller assemblies loaded now in the background, so no request waits for it (a no-op once read).</summary>
        public static void Warm()
        {
            _ = Task.Run(() =>
            {
                foreach (var assembly in AppDomain.CurrentDomain.GetAssemblies().Where(a => a.GetName().Name == "Jellyfin.Api"))
                    Of(assembly);
            });
        }

        /// <summary>Every controller action of the assembly at <paramref name="path"/>, classified (tests and diagnostics).</summary>
        /// <param name="path">The assembly file.</param>
        public static IReadOnlyList<JellyfinUserAction> Scan(string path) => CodeSet.Read(path).All();

        /// <summary>
        /// The calls the code read with the assembly at <paramref name="path"/> can't follow and doesn't count, because their
        /// contract carries no user (code outside it that is handed none): recorded for review (tests and diagnostics).
        /// </summary>
        /// <param name="path">The controller assembly.</param>
        public static IReadOnlyList<string> Uncounted(string path) => CodeSet.Read(path).Contained;

        /// <summary>
        /// Everything the code of <paramref name="member"/> ("Type.Member", the declaring type's simple name) reaches in the
        /// code read with the assembly at <paramref name="path"/>: the user changes, reviewed person changes and counted
        /// unresolved calls (tests: a reviewed member is held to what it was reviewed for).
        /// </summary>
        /// <param name="path">The controller assembly.</param>
        /// <param name="member">The member.</param>
        public static IReadOnlyList<string> ReachedFrom(string path, string member) => CodeSet.Read(path, member).Reached;

        /// <summary>The assembly files read with the one at <paramref name="path"/> (it comes first).</summary>
        /// <param name="path">The controller assembly.</param>
        public static IReadOnlyList<string> CodeOf(string path) => CodeSet.Files(path);

        private static CodeSet? Of(Assembly assembly)
        {
            if (assembly.IsDynamic || string.IsNullOrEmpty(assembly.Location)) return null;
            return Assemblies.GetOrAdd(assembly.Location, path => new Lazy<CodeSet?>(() =>
            {
                try
                {
                    return CodeSet.Read(path);
                }
                catch (Exception e) when (e is IOException or BadImageFormatException or InvalidOperationException or UnauthorizedAccessException or ArgumentException)
                {
                    return null;
                }
            })).Value;
        }

        // The code of a controller assembly and the assemblies read with it: every method, what it calls (across them, with
        // dispatch resolved), whether it reaches a Mutates member or a call that can't be followed, and the controller
        // assembly's actions, classified. Only the actions are kept once read.
        private sealed class CodeSet
        {
            private const int MaxDepth = 16;
            private static readonly OpCode[] OneByte = new OpCode[0x100];
            private static readonly OpCode[] TwoByte = new OpCode[0x100];

            private readonly Dictionary<int, JellyfinUserAction> _actions = new();

            static CodeSet()
            {
                foreach (var field in typeof(OpCodes).GetFields(BindingFlags.Public | BindingFlags.Static))
                {
                    if (field.GetValue(null) is not OpCode code) continue;
                    var value = (ushort)code.Value;
                    if (value < 0x100) OneByte[value] = code;
                    else if ((value & 0xff00) == 0xfe00) TwoByte[value & 0xff] = code;
                }
            }

            public JellyfinUserAction? Classify(int token, string controller)
                => _actions.TryGetValue(token, out var action) ? action with { Controller = controller, Key = KeyFor(action, controller), Why = WhyFor(action, controller) } : null;

            public IReadOnlyList<JellyfinUserAction> All() => _actions.Values.ToList();

            /// <summary>The calls nothing read could follow whose contract can carry no user (recorded for review).</summary>
            public IReadOnlyList<string> Contained { get; private set; } = Array.Empty<string>();

            /// <summary>What the member asked for reaches (see <see cref="Read(string, string?)"/>).</summary>
            public IReadOnlyList<string> Reached { get; private set; } = Array.Empty<string>();

            // Everything a member's code reaches, by the calls (not through the member's own PersonScoped stop).
            private List<string> From(string member)
            {
                var seen = new HashSet<int>();
                var queue = new Queue<int>(Enumerable.Range(0, _nodes.Count).Where(n => _nodes[n].Type >= 0 && _nodes[n].Name == member));
                var reached = new SortedSet<string>(StringComparer.Ordinal);
                while (queue.Count > 0)
                {
                    var n = queue.Dequeue();
                    if (!seen.Add(n)) continue;
                    var node = _nodes[n];
                    if (node.Type < 0 && (node.Reaches ?? node.PersonReaches ?? node.Unresolved) is { } what) reached.Add(what);
                    foreach (var callee in node.Calls) queue.Enqueue(callee);
                }

                return reached.ToList();
            }

            // Once classified, only the actions are kept (the reading is done once per assembly).
            private void Drop()
            {
                _types.Clear();
                _typesByName.Clear();
                _nodes.Clear();
                _nodeOf.Clear();
                _stores.Clear();
                _callSites.Clear();
                _made.Clear();
                _loads.Clear();
                _fieldNodes.Clear();
                _fieldTypes.Clear();
                _modules.Clear();
                _implementers = null;
                _derived = null;
            }

            private static bool Writes(JellyfinUserAction action) => action.Verbs.Any(v => v is not ("GET" or "HEAD"));

            private static string? WhyFor(JellyfinUserAction action, string controller)
                => UserControllers.Contains(controller) && Writes(action) ? "user controller"
                    : action.Reaches is { } reaches ? "reaches " + reaches + (PersonScoped.TryGetValue(reaches, out var change) ? ": " + change : string.Empty)
                    : Reviewed.Contains(controller + "." + action.Action) ? "reviewed"
                    : action.Why is { } unresolved && Writes(action) ? unresolved
                    : null;

            private static JellyfinUserKey KeyFor(JellyfinUserAction action, string controller)
            {
                var why = WhyFor(action, controller);
                if (why == null) return JellyfinUserKey.None;
                // A call nothing could follow: the person it touches isn't known.
                if (why.StartsWith("unresolved ", StringComparison.Ordinal)) return JellyfinUserKey.Global;
                return action.Key == JellyfinUserKey.User ? JellyfinUserKey.User : JellyfinUserKey.Global;
            }

            // ------------------------------------------------------------------ which files

            private static bool ServerName(string name)
                => (name.StartsWith("Jellyfin.", StringComparison.OrdinalIgnoreCase) || name.StartsWith("MediaBrowser.", StringComparison.OrdinalIgnoreCase) || name.StartsWith("Emby.", StringComparison.OrdinalIgnoreCase)
                    || string.Equals(name, "jellyfin", StringComparison.OrdinalIgnoreCase))
                   && !name.StartsWith("Jellyfin.Plugin.", StringComparison.OrdinalIgnoreCase);

            private static bool Framework(string name)
                => name.StartsWith("System.", StringComparison.OrdinalIgnoreCase) || name.StartsWith("Microsoft.", StringComparison.OrdinalIgnoreCase)
                   || name is "netstandard" or "mscorlib" or "WindowsBase";

            // The controller assembly; then its folder's Jellyfin server assemblies when that is Jellyfin's folder (it holds
            // MediaBrowser.Controller), else every assembly of its folder but the framework's and the Jellyfin server
            // assemblies of the folder Jellyfin runs from. One file per assembly name, the first found.
            internal static IReadOnlyList<string> Files(string path)
            {
                var full = Path.GetFullPath(path);
                var files = new List<string> { full };
                var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { Path.GetFileNameWithoutExtension(full) };
                var folder = Path.GetDirectoryName(full);
                void Add(string? directory, Func<string, bool> wanted)
                {
                    if (string.IsNullOrEmpty(directory) || !Directory.Exists(directory)) return;
                    foreach (var file in Directory.EnumerateFiles(directory, "*.dll").OrderBy(f => f, StringComparer.Ordinal))
                    {
                        var name = Path.GetFileNameWithoutExtension(file);
                        if (wanted(name) && names.Add(name)) files.Add(file);
                    }
                }

                var own = typeof(JellyfinUserActions).Assembly.GetName().Name ?? string.Empty;
                if (folder != null && File.Exists(Path.Combine(folder, "MediaBrowser.Controller.dll")))
                {
                    Add(folder, ServerName);
                    return files;
                }

                Add(folder, name => !Framework(name) && !string.Equals(name, own, StringComparison.OrdinalIgnoreCase));
                Add(Path.GetDirectoryName(typeof(MediaBrowser.Controller.Library.IUserManager).Assembly.Location), ServerName);
                return files;
            }

            // ------------------------------------------------------------------ the model

            private sealed class Module
            {
                public required MetadataReader Md { get; init; }
                public required PEReader Pe { get; init; }
            }

            private sealed class TypeInfo
            {
                public required string Name { get; init; }
                public string? Base { get; set; }
                public bool Interface { get; init; }
                public List<string> Interfaces { get; } = new();
                public List<int> Methods { get; } = new();
                public HashSet<string> Events { get; } = new(StringComparer.Ordinal);
            }

            private sealed class Node
            {
                public string Name { get; init; } = string.Empty;
                public string Method { get; init; } = string.Empty;
                public int Params { get; init; }
                public int Type { get; init; } = -1;
                public int Module { get; init; } = -1;
                public int Token { get; init; }
                public bool Virtual { get; init; }
                public bool Abstract { get; init; }
                public bool NewSlot { get; init; }
                public List<int> Calls { get; } = new();
                public string? Reaches { get; set; }
                public string? PersonReaches { get; set; }
                public string? Unresolved { get; set; }
                public int Via { get; set; } = -1;
                public int PersonVia { get; set; } = -1;
                public int UnresolvedVia { get; set; } = -1;
            }

            // A value a delegate can come from: a method (a node) or another delegate field.
            private readonly record struct Ref(int Node, string? Field);

            // Where a stored delegate came from: what the body made (the methods or fields), or the method's own parameter
            // (then: what each caller made before the call).
            private sealed record Source(int Node, List<Ref> Made, bool Parameter);

            // What the previous instruction left on the stack, as far as delegates go.
            private enum Pushed { Other, Argument, Pointer, Delegate, Field, Call }

            private readonly List<TypeInfo> _types = new();
            private readonly Dictionary<string, List<int>> _typesByName = new(StringComparer.Ordinal);
            private readonly List<Node> _nodes = new();
            private readonly Dictionary<(int Module, int Token), int> _nodeOf = new();
            private readonly Dictionary<string, int> _terminals = new(StringComparer.Ordinal);
            private readonly Dictionary<string, int> _unresolved = new(StringComparer.Ordinal);
            private readonly Dictionary<string, List<Source>> _stores = new(StringComparer.Ordinal);
            private readonly Dictionary<int, List<(int Caller, int Made)>> _callSites = new();
            private readonly Dictionary<int, List<Ref>> _made = new();
            private readonly List<(int Node, string Field)> _loads = new();
            private readonly Dictionary<string, int> _fieldNodes = new(StringComparer.Ordinal);
            private readonly SortedSet<string> _contained = new(StringComparer.Ordinal);
            private readonly List<Module> _modules = new();
            private readonly Dictionary<string, string> _fieldTypes = new(StringComparer.Ordinal);
            private int _empty = -1;
            private Dictionary<string, List<int>>? _implementers;
            private Dictionary<string, List<int>>? _derived;

            public static CodeSet Read(string path) => Read(path, null);

            // With member: also everything that member's own code reaches (a Mutates member, a reviewed person's change, a
            // counted unresolved call), before the graph is dropped.
            public static CodeSet Read(string path, string? member)
            {
                var set = new CodeSet();
                var modules = new List<Module>();
                try
                {
                    foreach (var file in Files(path))
                    {
                        try
                        {
                            var pe = new PEReader(new MemoryStream(File.ReadAllBytes(file)), PEStreamOptions.PrefetchEntireImage);
                            if (!pe.HasMetadata) { pe.Dispose(); continue; }
                            modules.Add(new Module { Pe = pe, Md = pe.GetMetadataReader() });
                        }
                        catch (BadImageFormatException) when (modules.Count > 0)
                        {
                            // A native library in the folder: not code to read (the controller's own assembly must be).
                        }
                    }

                    set._modules.AddRange(modules);
                    for (var m = 0; m < modules.Count; m++) set.Index(modules[m], m);
                    for (var m = 0; m < modules.Count; m++) set.Bodies(modules[m], m);
                    set.Delegates();
                    set.Propagate();
                    set.Actions(modules[0]);
                    set.Contained = set._contained.ToList();
                    if (member != null) set.Reached = set.From(member);
                    set.Drop();
                }
                finally
                {
                    foreach (var module in modules) module.Pe.Dispose();
                }

                return set;
            }

            // Every type and method, by name.
            private void Index(Module module, int m)
            {
                var md = module.Md;
                foreach (var handle in md.TypeDefinitions)
                {
                    var type = md.GetTypeDefinition(handle);
                    var info = new TypeInfo { Name = FullName(md, handle), Interface = (type.Attributes & TypeAttributes.Interface) != 0 };
                    info.Base = type.BaseType.IsNil ? null : ParentName(md, type.BaseType);
                    foreach (var implementation in type.GetInterfaceImplementations())
                        if (ParentName(md, md.GetInterfaceImplementation(implementation).Interface) is { } name) info.Interfaces.Add(name);
                    foreach (var e in type.GetEvents()) info.Events.Add(md.GetString(md.GetEventDefinition(e).Name));
                    var id = _types.Count;
                    _types.Add(info);
                    if (!_typesByName.TryGetValue(info.Name, out var same)) _typesByName[info.Name] = same = new List<int>();
                    same.Add(id);
                    foreach (var methodHandle in type.GetMethods())
                    {
                        var method = md.GetMethodDefinition(methodHandle);
                        var name = md.GetString(method.Name);
                        var node = new Node
                        {
                            Name = Simple(info.Name) + "." + name,
                            Method = name,
                            Params = ParamCount(md, method.Signature),
                            Type = id,
                            Module = m,
                            Token = MetadataTokens.GetToken(methodHandle),
                            Virtual = (method.Attributes & MethodAttributes.Virtual) != 0 && (method.Attributes & MethodAttributes.Final) == 0,
                            Abstract = (method.Attributes & MethodAttributes.Abstract) != 0,
                            NewSlot = (method.Attributes & MethodAttributes.NewSlot) != 0,
                        };
                        _nodeOf[(m, MetadataTokens.GetToken(methodHandle))] = _nodes.Count;
                        info.Methods.Add(_nodes.Count);
                        _nodes.Add(node);
                    }
                }
            }

            // Every body: its calls, the delegates it creates, stores and loads, and the events it subscribes to.
            private void Bodies(Module module, int m)
            {
                var md = module.Md;
                foreach (var typeHandle in md.TypeDefinitions)
                {
                    foreach (var methodHandle in md.GetTypeDefinition(typeHandle).GetMethods())
                    {
                        var method = md.GetMethodDefinition(methodHandle);
                        var node = _nodeOf[(m, MetadataTokens.GetToken(methodHandle))];
                        // An async method or iterator runs in its state machine's MoveNext.
                        foreach (var machine in StateMachines(md, method.GetCustomAttributes()))
                            if (_typesByName.TryGetValue(machine, out var machines))
                                foreach (var t in machines)
                                    _nodes[node].Calls.AddRange(_types[t].Methods.Where(n => _nodes[n].Method == "MoveNext"));
                        if (method.RelativeVirtualAddress != 0) Body(md, m, module.Pe.GetMethodBody(method.RelativeVirtualAddress), node);
                    }
                }
            }

            private void Body(MetadataReader md, int m, MethodBodyBlock body, int node)
            {
                var il = body.GetILReader();
                // Every delegate the body made (a method pointer) or loaded from a delegate field, in order: what a call made
                // after them can be handed (a prefix of it).
                var made = new List<Ref>();
                // What the last instruction left on the stack (a dup or a cast keeps it): where a stored delegate comes from.
                var (pushed, from) = (Pushed.Other, new List<Ref>());
                while (il.RemainingBytes > 0)
                {
                    var first = il.ReadByte();
                    var code = first == 0xfe ? TwoByte[il.ReadByte()] : OneByte[first];
                    var value = code.Value;
                    switch (code.OperandType)
                    {
                        case OperandType.InlineMethod:
                        {
                            var handle = MetadataTokens.EntityHandle(il.ReadInt32());
                            var virtualCall = value == OpCodes.Callvirt.Value || value == OpCodes.Ldvirtftn.Value;
                            var pointer = value == OpCodes.Ldftn.Value || value == OpCodes.Ldvirtftn.Value;
                            var targets = Targets(md, m, handle, virtualCall);
                            _nodes[node].Calls.AddRange(targets);
                            if (pointer)
                            {
                                made.AddRange(targets.Select(t => new Ref(t, null)));
                                (pushed, from) = (Pushed.Pointer, targets.Select(t => new Ref(t, null)).ToList());
                            }
                            else if (value == OpCodes.Newobj.Value && pushed == Pushed.Pointer)
                            {
                                // A delegate made from the pointer just loaded.
                                pushed = Pushed.Delegate;
                            }
                            else
                            {
                                foreach (var target in targets)
                                {
                                    if (!_callSites.TryGetValue(target, out var sites)) _callSites[target] = sites = new List<(int, int)>();
                                    sites.Add((node, made.Count));
                                }

                                // A delegate a call returns (a factory's): what the call reaches.
                                (pushed, from) = (Pushed.Call, targets.Select(t => new Ref(t, null)).ToList());
                            }

                            break;
                        }
                        case OperandType.InlineField:
                        {
                            var handle = MetadataTokens.EntityHandle(il.ReadInt32());
                            if (DelegateField(md, handle) is not { } field)
                            {
                                pushed = Pushed.Other;
                                break;
                            }

                            if (value == OpCodes.Stfld.Value || value == OpCodes.Stsfld.Value)
                            {
                                Store(field, node, pushed, from, made);
                                // A dup before the store leaves the same delegate for the next one.
                            }
                            else if (value == OpCodes.Ldflda.Value || value == OpCodes.Ldsflda.Value)
                            {
                                // Its address handed on (an event's add and remove: Interlocked.CompareExchange of the
                                // parameter combined in): it can be stored with what the method was handed.
                                Store(field, node, Pushed.Argument, new List<Ref>(), made);
                                _loads.Add((node, field));
                                pushed = Pushed.Other;
                            }
                            else
                            {
                                _loads.Add((node, field));
                                made.Add(new Ref(-1, field));
                                (pushed, from) = (Pushed.Field, new List<Ref> { new(-1, field) });
                            }

                            break;
                        }
                        case OperandType.InlineNone:
                            if (value is 0x02 or 0x03 or 0x04 or 0x05) pushed = Pushed.Argument;
                            else if (value != OpCodes.Dup.Value) pushed = Pushed.Other;
                            break;
                        case OperandType.ShortInlineVar:
                            pushed = value == OpCodes.Ldarg_S.Value ? Pushed.Argument : Pushed.Other;
                            il.Offset += 1;
                            break;
                        case OperandType.InlineVar:
                            pushed = value == OpCodes.Ldarg.Value ? Pushed.Argument : Pushed.Other;
                            il.Offset += 2;
                            break;
                        case OperandType.InlineType:
                            // castclass, isinst: the same delegate.
                            if (value != OpCodes.Castclass.Value && value != OpCodes.Isinst.Value) pushed = Pushed.Other;
                            il.Offset += 4;
                            break;
                        case OperandType.ShortInlineBrTarget or OperandType.ShortInlineI:
                            pushed = Pushed.Other;
                            il.Offset += 1;
                            break;
                        case OperandType.InlineI8 or OperandType.InlineR:
                            pushed = Pushed.Other;
                            il.Offset += 8;
                            break;
                        case OperandType.InlineSwitch:
                            // The count, then that many branch targets (read the count first: it moves the offset).
                            var count = il.ReadInt32();
                            il.Offset += 4 * count;
                            pushed = Pushed.Other;
                            break;
                        default:
                            pushed = Pushed.Other;
                            il.Offset += 4;
                            break;
                    }
                }

                if (made.Count > 0) _made[node] = made;
            }

            // A store of a delegate field: from the pointer or field just loaded, from the method's parameter, or (anything
            // else) from whatever the body made so far.
            private void Store(string field, int node, Pushed pushed, List<Ref> from, List<Ref> made)
            {
                if (!_stores.TryGetValue(field, out var sources)) _stores[field] = sources = new List<Source>();
                sources.Add(pushed switch
                {
                    Pushed.Pointer or Pushed.Delegate or Pushed.Field or Pushed.Call when from.Count > 0 => new Source(node, from.ToList(), false),
                    Pushed.Argument => new Source(node, new List<Ref>(), true),
                    _ => new Source(node, made.ToList(), made.Count == 0),
                });
            }

            // The nodes a call (or a method pointer) goes to: the method, and with virtual dispatch every implementation or
            // override; a Mutates member's terminal; nothing for a reviewed read or a call outside the code read (the
            // framework's); an unresolved node for a Jellyfin member nothing read declares or implements.
            private List<int> Targets(MetadataReader md, int m, EntityHandle handle, bool virtualCall)
            {
                switch (handle.Kind)
                {
                    case HandleKind.MethodSpecification:
                        return Targets(md, m, md.GetMethodSpecification((MethodSpecificationHandle)handle).Method, virtualCall);
                    case HandleKind.MethodDefinition:
                    {
                        var target = _nodeOf[(m, MetadataTokens.GetToken(handle))];
                        return Follow(_types[_nodes[target].Type].Name, _nodes[target].Method, _nodes[target].Params, new List<int> { target }, virtualCall);
                    }
                    case HandleKind.MemberReference:
                    {
                        var member = md.GetMemberReference((MemberReferenceHandle)handle);
                        if (member.GetKind() != MemberReferenceKind.Method) return new List<int>();
                        var called = md.GetString(member.Name);
                        var parent = ParentName(md, member.Parent);
                        if (parent == null) return new List<int>();
                        var count = ParamCount(md, member.Signature);
                        var found = Resolve(parent, called, count);
                        if (found.Count == 0 && !Mutates(parent, called) && !ReviewedRead(parent, called))
                            return JellyfinType(parent) ? new List<int> { Unresolved(Simple(parent) + "." + called + " (not in the code read)", UserContract(MethodTypes(md, member.DecodeMethodSignature(Names.Instance, null)), null)) } : found;
                        return Follow(parent, called, count, found, virtualCall);
                    }
                    default:
                        return new List<int>();
                }
            }

            private static bool JellyfinType(string type) => type.StartsWith("MediaBrowser.", StringComparison.Ordinal) || type.StartsWith("Jellyfin.", StringComparison.Ordinal) || type.StartsWith("Emby.", StringComparison.Ordinal);

            // A resolved call: a Mutates member ends there (reached), a reviewed read ends there (nothing), anything else is
            // followed, through dispatch for a virtual call.
            private List<int> Follow(string type, string name, int count, List<int> found, bool virtualCall)
            {
                if (Mutates(type, name)) return new List<int> { Terminal(Simple(type) + "." + name) };
                if (PersonScoped.ContainsKey(Simple(type) + "." + name)) return new List<int> { Terminal(Simple(type) + "." + name, person: true) };
                if (ReviewedRead(type, name)) return new List<int>();
                var targets = new List<int>(found);
                if (virtualCall)
                    foreach (var target in found.ToList())
                        targets.AddRange(Dispatch(target));
                return targets;
            }

            // A method of a type by name and parameter count, on the type or the nearest base declaring it.
            private List<int> Resolve(string type, string name, int count)
            {
                var name0 = type;
                for (var depth = 0; depth < MaxDepth && name0 != null && _typesByName.TryGetValue(name0, out var ids); depth++)
                {
                    var found = ids.SelectMany(t => _types[t].Methods).Where(n => _nodes[n].Method == name && _nodes[n].Params == count).ToList();
                    if (found.Count > 0) return found;
                    name0 = _types[ids[0]].Base;
                }

                return new List<int>();
            }

            // Where a virtual call of target can go: every implementation of an interface method, every override of a
            // virtual one (in the code read). An abstract or interface member nothing implements is unresolved.
            private IEnumerable<int> Dispatch(int target)
            {
                var node = _nodes[target];
                if (node.Type < 0) yield break;
                var type = _types[node.Type];
                if (!type.Interface && !node.Virtual) yield break;
                var found = 0;
                var candidates = type.Interface ? Implementers(type.Name) : Derived(type.Name);
                foreach (var t in candidates)
                    foreach (var n in _types[t].Methods)
                    {
                        var other = _nodes[n];
                        if (other.Params != node.Params || other.Abstract) continue;
                        var matches = other.Method == node.Method || other.Method.EndsWith("." + node.Method, StringComparison.Ordinal);
                        if (!matches || (!type.Interface && (!other.Virtual && !other.Abstract || other.NewSlot))) continue;
                        found++;
                        yield return n;
                    }

                // Implemented through a base type's method of that name (an interface member inherited, not redeclared).
                if (type.Interface)
                    foreach (var t in candidates)
                        if (!_types[t].Methods.Any(n => _nodes[n].Params == node.Params && (_nodes[n].Method == node.Method || _nodes[n].Method.EndsWith("." + node.Method, StringComparison.Ordinal))))
                            foreach (var n in Resolve(_types[t].Base ?? string.Empty, node.Method, node.Params))
                            {
                                found++;
                                yield return n;
                            }

                if (found == 0 && (node.Abstract || type.Interface)) yield return Unresolved(node.Name + " (nothing read implements it)", UserContract(node));
            }

            private List<int> Implementers(string name)
            {
                if (_implementers == null)
                {
                    _implementers = new Dictionary<string, List<int>>(StringComparer.Ordinal);
                    for (var t = 0; t < _types.Count; t++)
                    {
                        if (_types[t].Interface) continue;
                        foreach (var i in AllInterfaces(t, 0))
                        {
                            if (!_implementers.TryGetValue(i, out var list)) _implementers[i] = list = new List<int>();
                            if (!list.Contains(t)) list.Add(t);
                        }
                    }
                }

                return _implementers.TryGetValue(name, out var found) ? found : new List<int>();
            }

            private IEnumerable<string> AllInterfaces(int t, int depth)
            {
                if (depth > MaxDepth) yield break;
                foreach (var i in _types[t].Interfaces)
                {
                    yield return i;
                    if (_typesByName.TryGetValue(i, out var ids))
                        foreach (var inherited in ids.SelectMany(id => AllInterfaces(id, depth + 1))) yield return inherited;
                }

                if (_types[t].Base is { } b && _typesByName.TryGetValue(b, out var bases))
                    foreach (var inherited in bases.SelectMany(id => AllInterfaces(id, depth + 1))) yield return inherited;
            }

            private List<int> Derived(string name)
            {
                if (_derived == null)
                {
                    _derived = new Dictionary<string, List<int>>(StringComparer.Ordinal);
                    for (var t = 0; t < _types.Count; t++)
                    {
                        var b = _types[t].Base;
                        for (var depth = 0; depth < MaxDepth && b != null; depth++)
                        {
                            if (!_derived.TryGetValue(b, out var list)) _derived[b] = list = new List<int>();
                            list.Add(t);
                            b = _typesByName.TryGetValue(b, out var ids) ? _types[ids[0]].Base : null;
                        }
                    }
                }

                return _derived.TryGetValue(name, out var found) ? found : new List<int>();
            }

            // A Mutates member reached (or a reviewed change to the request's own person, PersonScoped).
            private int Terminal(string reaches, bool person = false)
            {
                if (_terminals.TryGetValue(reaches, out var node)) return node;
                _terminals[reaches] = _nodes.Count;
                _nodes.Add(person ? new Node { Name = reaches, PersonReaches = reaches } : new Node { Name = reaches, Reaches = reaches });
                return _nodes.Count - 1;
            }

            // A call that can't be followed. It counts (its callers are unresolved) when its contract can carry a user: a
            // parameter, result or delegate type that is a user, a user id, or the user, session or sign-in services (see
            // UserContract). One whose contract can't (a provider's name, a media item's delete, a configuration or timer
            // event) runs code outside the code read that is handed no user: it is recorded for review, and not followed.
            private int Unresolved(string what, bool couldReach = true)
            {
                if (!couldReach)
                {
                    _contained.Add(what);
                    if (_empty < 0)
                    {
                        _empty = _nodes.Count;
                        _nodes.Add(new Node { Name = "(nothing)" });
                    }

                    return _empty;
                }

                if (_unresolved.TryGetValue(what, out var node)) return node;
                _unresolved[what] = _nodes.Count;
                _nodes.Add(new Node { Name = what, Unresolved = what });
                return _nodes.Count - 1;
            }

            // Each delegate field loaded: a node standing for what it can hold. Each store's source: the pointer or field it
            // was made from, what the storing body had made, or, stored from the method's parameter (a constructor's, a
            // property setter's, an event's add, a closure or state machine capturing it), what each caller had made before
            // the call (followed up while a caller passes its own parameter on). Unresolved: a field nothing stores, or a
            // parameter no caller in the code read hands anything (a delegate from outside it: dependency injection).
            private void Delegates()
            {
                foreach (var (node, field) in _loads) _nodes[node].Calls.Add(FieldNode(field, 0));
            }

            private int FieldNode(string field, int depth)
            {
                if (_fieldNodes.TryGetValue(field, out var existing)) return existing;
                var id = _nodes.Count;
                _fieldNodes[field] = id;
                var (owner, name) = (field.Split("::")[0], field.Split("::")[1]);
                _nodes.Add(new Node { Name = "delegate " + Simple(owner) + "." + name });
                var sources = _stores.GetValueOrDefault(field);
                var contract = UserContract(new[] { _fieldTypes.GetValueOrDefault(field, string.Empty) }, null);
                if (sources == null || sources.Count == 0) _nodes[id].Calls.Add(Unresolved(_nodes[id].Name + " (nothing in the code read stores it)", contract));
                foreach (var source in sources ?? new List<Source>())
                {
                    var refs = source.Parameter ? Callers(source.Node, depth, new HashSet<int>()) : source.Made;
                    if (refs == null) _nodes[id].Calls.Add(Unresolved(_nodes[id].Name + " (handed in from outside the code read)", contract));
                    foreach (var r in refs ?? new List<Ref>())
                        _nodes[id].Calls.Add(r.Field is { } f ? (depth > MaxDepth ? Unresolved(_nodes[id].Name + " (too deep)") : FieldNode(f, depth + 1)) : r.Node);
                }

                return id;
            }

            // What the callers of a method made before calling it (a parameter's possible delegates); null when a call chain
            // leaves the code read (no caller).
            private List<Ref>? Callers(int node, int depth, HashSet<int> seen)
            {
                if (depth > MaxDepth || !seen.Add(node)) return new List<Ref>();
                if (!_callSites.TryGetValue(node, out var sites) || sites.Count == 0) return null;
                var refs = new List<Ref>();
                foreach (var (caller, count) in sites)
                {
                    if (count > 0 && _made.TryGetValue(caller, out var made)) refs.AddRange(made.Take(count));
                    else if (Callers(caller, depth + 1, seen) is { } further) refs.AddRange(further);
                    else return null;
                }

                return refs;
            }

            // From each Mutates member (and each unresolved call) back to every caller, until nothing changes.
            private void Propagate()
            {
                var callers = new List<int>?[_nodes.Count];
                for (var n = 0; n < _nodes.Count; n++)
                    foreach (var callee in _nodes[n].Calls)
                        (callers[callee] ??= new List<int>()).Add(n);
                var queue = new Queue<int>(Enumerable.Range(0, _nodes.Count).Where(n => _nodes[n].Reaches != null));
                while (queue.Count > 0)
                {
                    var n = queue.Dequeue();
                    foreach (var caller in callers[n] ?? Enumerable.Empty<int>())
                    {
                        if (_nodes[caller].Reaches != null) continue;
                        _nodes[caller].Reaches = _nodes[n].Reaches;
                        _nodes[caller].Via = n;
                        queue.Enqueue(caller);
                    }
                }

                queue = new Queue<int>(Enumerable.Range(0, _nodes.Count).Where(n => _nodes[n].PersonReaches != null));
                while (queue.Count > 0)
                {
                    var n = queue.Dequeue();
                    foreach (var caller in callers[n] ?? Enumerable.Empty<int>())
                    {
                        if (_nodes[caller].PersonReaches != null) continue;
                        _nodes[caller].PersonReaches = _nodes[n].PersonReaches;
                        _nodes[caller].PersonVia = n;
                        queue.Enqueue(caller);
                    }
                }

                queue = new Queue<int>(Enumerable.Range(0, _nodes.Count).Where(n => _nodes[n].Unresolved != null));
                while (queue.Count > 0)
                {
                    var n = queue.Dequeue();
                    foreach (var caller in callers[n] ?? Enumerable.Empty<int>())
                    {
                        if (_nodes[caller].Unresolved != null) continue;
                        _nodes[caller].Unresolved = _nodes[n].Unresolved;
                        _nodes[caller].UnresolvedVia = n;
                        queue.Enqueue(caller);
                    }
                }
            }

            // The calls from node to what it reaches: 0 a user change, 1 a reviewed change to the request's person, 2 a call
            // that couldn't be followed.
            private List<string> CallPath(int node, int kind)
            {
                var path = new List<string>();
                for (var (n, depth) = (node, 0); n >= 0 && depth < 64; depth++)
                {
                    path.Add(_nodes[n].Name);
                    n = kind switch { 0 => _nodes[n].Via, 1 => _nodes[n].PersonVia, _ => _nodes[n].UnresolvedVia };
                }

                return path;
            }

            // The controller assembly's actions, classified (the controller rule and the review list apply at the lookup).
            private void Actions(Module module)
            {
                var md = module.Md;
                foreach (var typeHandle in md.TypeDefinitions)
                {
                    var type = md.GetTypeDefinition(typeHandle);
                    if (!Controller(md, type)) continue;
                    var controller = Simple(FullName(md, typeHandle));
                    foreach (var methodHandle in type.GetMethods())
                    {
                        var method = md.GetMethodDefinition(methodHandle);
                        var attributes = method.Attributes;
                        if ((attributes & MethodAttributes.MemberAccessMask) != MethodAttributes.Public || (attributes & MethodAttributes.Static) != 0
                            || (attributes & MethodAttributes.SpecialName) != 0 || HasAttribute(md, method.GetCustomAttributes(), "NonActionAttribute")) continue;
                        var token = MetadataTokens.GetToken(methodHandle);
                        var node = _nodes[_nodeOf[(0, token)]];
                        var verbs = Verbs(md, method.GetCustomAttributes());
                        var userId = method.GetParameters().Select(p => md.GetString(md.GetParameter(p).Name)).Any(p => string.Equals(p, "userId", StringComparison.OrdinalIgnoreCase));
                        var id = _nodeOf[(0, token)];
                        // A change to anyone: the person of its userId argument, else everyone. Only a reviewed change to the
                        // request's own person: that person (userId, else the signed-in person). Neither, but a call that
                        // couldn't be followed: everyone, for a write.
                        var reaches = node.Reaches ?? node.PersonReaches;
                        var unresolved = reaches == null && node.Unresolved != null ? "unresolved " + node.Unresolved : null;
                        var key = node.Reaches == null && node.PersonReaches != null || userId ? JellyfinUserKey.User : JellyfinUserKey.Global;
                        var action = new JellyfinUserAction(controller, node.Method, verbs.Count == 0 ? new[] { "*" } : verbs, key, unresolved, reaches,
                            node.Reaches != null ? CallPath(id, 0) : node.PersonReaches != null ? CallPath(id, 1) : unresolved != null ? CallPath(id, 2) : null);
                        _actions[token] = action with { Key = KeyFor(action, controller), Why = WhyFor(action, controller) };
                    }
                }
            }

            // A public class that MVC would treat as a controller: named *Controller, or deriving from ControllerBase.
            private bool Controller(MetadataReader md, TypeDefinition type)
            {
                if ((type.Attributes & TypeAttributes.VisibilityMask) != TypeAttributes.Public || (type.Attributes & (TypeAttributes.Abstract | TypeAttributes.Interface)) != 0) return false;
                if (md.GetString(type.Name).EndsWith("Controller", StringComparison.Ordinal)) return true;
                var name = type.BaseType.IsNil ? null : ParentName(md, type.BaseType);
                for (var depth = 0; depth < MaxDepth && name != null; depth++)
                {
                    if (name is "Microsoft.AspNetCore.Mvc.ControllerBase" or "Microsoft.AspNetCore.Mvc.Controller") return true;
                    name = _typesByName.TryGetValue(name, out var ids) ? _types[ids[0]].Base : null;
                }

                return false;
            }

            // ------------------------------------------------------------------ what a call's contract can carry

            // The types that are a user or carry authority over one: the user entity and its permissions, a user's policy,
            // configuration and DTO, the user, sign-in, password-reset and Quick Connect services, and Jellyfin's user events.
            private static readonly HashSet<string> UserTypes = new(StringComparer.Ordinal)
            {
                "Jellyfin.Database.Implementations.Entities.User", "Jellyfin.Data.Entities.User", "Jellyfin.Database.Implementations.Entities.Permission", "Jellyfin.Data.Entities.Permission",
                "MediaBrowser.Model.Users.UserPolicy", "MediaBrowser.Model.Configuration.UserConfiguration", "MediaBrowser.Model.Dto.UserDto",
                "MediaBrowser.Controller.Library.IUserManager", "MediaBrowser.Controller.QuickConnect.IQuickConnect",
                "MediaBrowser.Controller.Authentication.IAuthenticationProvider", "MediaBrowser.Controller.Authentication.IPasswordResetProvider",
                "MediaBrowser.Controller.Authentication.AuthenticationRequest", "MediaBrowser.Controller.Authentication.AuthenticationResult",
            };

            private static readonly string[] UserNamespaces = { "Jellyfin.Data.Events.Users.", "MediaBrowser.Model.Users." };

            // Whether types (a signature's, with their generic arguments) can carry a user: one of the user types, or a Guid
            // that is a user id (its parameter name says so; unnamed, any Guid counts).
            private static bool UserContract(IEnumerable<string> types, IReadOnlyList<string?>? names)
            {
                var index = 0;
                foreach (var type in types)
                {
                    var name = names != null && index < names.Count ? names[index] : null;
                    index++;
                    foreach (var part in type.Split(new[] { '<', '>', ',', '[', ']', '&', '*', ' ' }, StringSplitOptions.RemoveEmptyEntries))
                    {
                        if (UserTypes.Contains(part) || UserNamespaces.Any(n => part.StartsWith(n, StringComparison.Ordinal))) return true;
                        if (part == "System.Guid" && (name == null || name.Contains("user", StringComparison.OrdinalIgnoreCase))) return true;
                    }
                }

                return false;
            }

            // A method of the code read: its declaring type, its result and parameters, with their names.
            private bool UserContract(Node node)
            {
                if (node.Module < 0) return true;
                var md = _modules[node.Module].Md;
                var method = md.GetMethodDefinition(MetadataTokens.MethodDefinitionHandle(node.Token));
                var signature = method.DecodeSignature(Names.Instance, null);
                var names = new string?[signature.ParameterTypes.Length];
                foreach (var p in method.GetParameters())
                {
                    var parameter = md.GetParameter(p);
                    if (parameter.SequenceNumber > 0 && parameter.SequenceNumber <= names.Length) names[parameter.SequenceNumber - 1] = md.GetString(parameter.Name);
                }

                return UserContract(new[] { _types[node.Type].Name }, null) || UserContract(new[] { signature.ReturnType }, null) || UserContract(signature.ParameterTypes, names);
            }

            private static IEnumerable<string> MethodTypes(MetadataReader md, MethodSignature<string> signature) => signature.ParameterTypes.Prepend(signature.ReturnType);

            // Type names from signatures (generic arguments included).
            private sealed class Names : ISignatureTypeProvider<string, object?>
            {
                public static readonly Names Instance = new();

                public string GetArrayType(string elementType, ArrayShape shape) => elementType + "[]";

                public string GetByReferenceType(string elementType) => elementType + "&";

                public string GetFunctionPointerType(MethodSignature<string> signature) => "fnptr";

                public string GetGenericInstantiation(string genericType, ImmutableArray<string> typeArguments) => genericType + "<" + string.Join(",", typeArguments) + ">";

                public string GetGenericMethodParameter(object? genericContext, int index) => "!!" + index;

                public string GetGenericTypeParameter(object? genericContext, int index) => "!" + index;

                public string GetModifiedType(string modifier, string unmodifiedType, bool isRequired) => unmodifiedType;

                public string GetPinnedType(string elementType) => elementType;

                public string GetPointerType(string elementType) => elementType + "*";

                public string GetPrimitiveType(PrimitiveTypeCode typeCode) => "System." + typeCode;

                public string GetSZArrayType(string elementType) => elementType + "[]";

                public string GetTypeFromDefinition(MetadataReader reader, TypeDefinitionHandle handle, byte rawTypeKind) => FullName(reader, handle);

                public string GetTypeFromReference(MetadataReader reader, TypeReferenceHandle handle, byte rawTypeKind) => FullName(reader, handle);

                public string GetTypeFromSpecification(MetadataReader reader, object? genericContext, TypeSpecificationHandle handle, byte rawTypeKind)
                    => reader.GetTypeSpecification(handle).DecodeSignature(this, genericContext);
            }

            // ------------------------------------------------------------------ metadata helpers

            private static int ParamCount(MetadataReader md, BlobHandle signature)
            {
                var blob = md.GetBlobReader(signature);
                var header = blob.ReadSignatureHeader();
                if (header.Kind != SignatureKind.Method && header.Kind != SignatureKind.Property) return 0;
                if (header.IsGeneric) blob.ReadCompressedInteger();
                return blob.ReadCompressedInteger();
            }

            // A field of a delegate type ("Type::Name"), or null.
            private string? DelegateField(MetadataReader md, EntityHandle handle)
            {
                string? owner;
                string name;
                BlobHandle signature;
                switch (handle.Kind)
                {
                    case HandleKind.FieldDefinition:
                        var field = md.GetFieldDefinition((FieldDefinitionHandle)handle);
                        owner = FullName(md, field.GetDeclaringType());
                        name = md.GetString(field.Name);
                        signature = field.Signature;
                        break;
                    case HandleKind.MemberReference:
                        var member = md.GetMemberReference((MemberReferenceHandle)handle);
                        if (member.GetKind() != MemberReferenceKind.Field) return null;
                        owner = ParentName(md, member.Parent);
                        name = md.GetString(member.Name);
                        signature = member.Signature;
                        break;
                    default:
                        return null;
                }

                if (owner == null) return null;
                var blob = md.GetBlobReader(signature);
                if (blob.ReadSignatureHeader().Kind != SignatureKind.Field) return null;
                var code = blob.ReadSignatureTypeCode();
                while (code is SignatureTypeCode.RequiredModifier or SignatureTypeCode.OptionalModifier)
                {
                    blob.ReadTypeHandle();
                    code = blob.ReadSignatureTypeCode();
                }

                if (code == SignatureTypeCode.GenericTypeInstance) code = blob.ReadSignatureTypeCode();
                if (code is not (SignatureTypeCode.TypeHandle or (SignatureTypeCode)0x12 or (SignatureTypeCode)0x11)) return null;
                var typeName = ParentName(md, blob.ReadTypeHandle());
                if (typeName == null || !DelegateType(typeName)) return null;
                var key = owner + "::" + name;
                if (!_fieldTypes.ContainsKey(key))
                    _fieldTypes[key] = handle.Kind == HandleKind.FieldDefinition
                        ? md.GetFieldDefinition((FieldDefinitionHandle)handle).DecodeSignature(Names.Instance, null)
                        : md.GetMemberReference((MemberReferenceHandle)handle).DecodeFieldSignature(Names.Instance, null);
                return key;
            }

            private bool DelegateType(string name)
            {
                if (name.StartsWith("System.Func`", StringComparison.Ordinal) || name.StartsWith("System.Action", StringComparison.Ordinal)
                    || name is "System.Predicate`1" or "System.Comparison`1" or "System.Converter`2" or "System.EventHandler" or "System.EventHandler`1" or "System.Delegate" or "System.MulticastDelegate")
                    return true;
                return _typesByName.TryGetValue(name, out var ids) && ids.Any(t => _types[t].Base is "System.MulticastDelegate");
            }

            private static readonly Dictionary<string, string> VerbAttributes = new(StringComparer.Ordinal)
            {
                ["HttpGetAttribute"] = "GET", ["HttpPostAttribute"] = "POST", ["HttpPutAttribute"] = "PUT", ["HttpDeleteAttribute"] = "DELETE",
                ["HttpPatchAttribute"] = "PATCH", ["HttpHeadAttribute"] = "HEAD", ["HttpOptionsAttribute"] = "OPTIONS", ["AcceptVerbsAttribute"] = "*",
            };

            private static List<string> Verbs(MetadataReader md, CustomAttributeHandleCollection attributes)
            {
                var verbs = new SortedSet<string>(StringComparer.Ordinal);
                foreach (var handle in attributes)
                    if (VerbAttributes.TryGetValue(AttributeName(md, md.GetCustomAttribute(handle)) ?? string.Empty, out var verb)) verbs.Add(verb);
                return verbs.ToList();
            }

            private static bool HasAttribute(MetadataReader md, CustomAttributeHandleCollection attributes, string name)
                => attributes.Any(a => AttributeName(md, md.GetCustomAttribute(a)) == name);

            // The state machine types named by [AsyncStateMachine], [IteratorStateMachine] or [AsyncIteratorStateMachine].
            private static IEnumerable<string> StateMachines(MetadataReader md, CustomAttributeHandleCollection attributes)
            {
                foreach (var handle in attributes)
                {
                    var attribute = md.GetCustomAttribute(handle);
                    if (AttributeName(md, attribute) is not ("AsyncStateMachineAttribute" or "IteratorStateMachineAttribute" or "AsyncIteratorStateMachineAttribute")) continue;
                    var blob = md.GetBlobReader(attribute.Value);
                    if (blob.Length < 3 || blob.ReadUInt16() != 1) continue;
                    // A serialized System.Type: its assembly-qualified name, ours unqualified.
                    if (blob.ReadSerializedString() is { } type) yield return type.Split(',')[0].Trim();
                }
            }

            private static string? AttributeName(MetadataReader md, CustomAttribute attribute)
            {
                EntityHandle type = attribute.Constructor.Kind switch
                {
                    HandleKind.MemberReference => md.GetMemberReference((MemberReferenceHandle)attribute.Constructor).Parent,
                    HandleKind.MethodDefinition => md.GetMethodDefinition((MethodDefinitionHandle)attribute.Constructor).GetDeclaringType(),
                    _ => default,
                };
                return type.Kind switch
                {
                    HandleKind.TypeReference => md.GetString(md.GetTypeReference((TypeReferenceHandle)type).Name),
                    HandleKind.TypeDefinition => md.GetString(md.GetTypeDefinition((TypeDefinitionHandle)type).Name),
                    _ => null,
                };
            }

            private static string? ParentName(MetadataReader md, EntityHandle parent) => parent.Kind switch
            {
                HandleKind.TypeReference => FullName(md, (TypeReferenceHandle)parent),
                HandleKind.TypeDefinition => FullName(md, (TypeDefinitionHandle)parent),
                HandleKind.TypeSpecification => GenericName(md, md.GetTypeSpecification((TypeSpecificationHandle)parent).Signature),
                _ => null,
            };

            // The generic type a type specification instantiates (GENERICINST CLASS|VALUETYPE TypeDefOrRef ...).
            private static string? GenericName(MetadataReader md, BlobHandle signature)
            {
                var blob = md.GetBlobReader(signature);
                if (blob.ReadSignatureTypeCode() != SignatureTypeCode.GenericTypeInstance) return null;
                blob.ReadSignatureTypeCode();
                var type = blob.ReadTypeHandle();
                return type.Kind switch
                {
                    HandleKind.TypeReference => FullName(md, (TypeReferenceHandle)type),
                    HandleKind.TypeDefinition => FullName(md, (TypeDefinitionHandle)type),
                    _ => null,
                };
            }

            // Full names as reflection writes them: Namespace.Type, nested types with '+'.
            private static string FullName(MetadataReader md, TypeDefinitionHandle handle)
            {
                var type = md.GetTypeDefinition(handle);
                var name = md.GetString(type.Name);
                var declaring = type.GetDeclaringType();
                if (!declaring.IsNil) return FullName(md, declaring) + "+" + name;
                var space = md.GetString(type.Namespace);
                return space.Length == 0 ? name : space + "." + name;
            }

            private static string FullName(MetadataReader md, TypeReferenceHandle handle)
            {
                var type = md.GetTypeReference(handle);
                var name = md.GetString(type.Name);
                if (type.ResolutionScope.Kind == HandleKind.TypeReference) return FullName(md, (TypeReferenceHandle)type.ResolutionScope) + "+" + name;
                var space = md.GetString(type.Namespace);
                return space.Length == 0 ? name : space + "." + name;
            }
        }
    }
}
