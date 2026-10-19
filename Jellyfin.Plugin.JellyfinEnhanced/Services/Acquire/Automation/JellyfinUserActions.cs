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
    /// those assemblies have (round 17: a slot .NET declares too), a delegate field to what its stores (a constructor's, an
    /// initializer's) put in it, an event to the handlers subscribed to it, and (round 17) a delegate invoked to what its
    /// provenance shows: a parameter to what the callers hand it, a call's result to what the callee returns, a local or an
    /// array element to what was stored in it, one handed to code outside the code read as run there; provenance the reading
    /// can't establish (handed in from outside, a collection's value, an array other code filled, an unknown) is an
    /// unresolved callback (fail closed). Round 18: each rule lives in one place and applies in every combination: one
    /// target resolver for every transfer (Targets), one "running a method" edge set on every method node (Running: body,
    /// type initializer, module initializer), one provenance model for every delegate value (Flow → Sources: invoked,
    /// stored in a field, handed to a method, returned), tested as a generated cross-product (IntegrationJellyfinUserMatrixTests).
    /// Round 19: the model's inputs are complete. One fill rule for every slot (SlotFills: ECMA-335 interface and virtual
    /// method resolution) over each type's COMPLETE ancestry (LineageOf: the bases and interfaces outside the code read are
    /// read from their assemblies' metadata, found by the assembly a reference names, never loaded); a step that can't be
    /// read fails closed. Every recursive provenance is a monotone fixed point (Summaries: what a method returns as a
    /// function of its arguments; Up: the parameters callers feed, solved as strongly connected groups), never cut by a
    /// depth or a step budget;</description></item>
    /// <item><description>it isn't a GET and its code reaches a call that can't be followed whose contract can carry a user (an
    /// interface nothing read implements): it is bracketed for everyone (a GET isn't: it would hold automation on every
    /// page view);</description></item>
    /// <item><description>it isn't a GET and its code reaches a callback that can't be followed (round 11: a delegate nothing in the
    /// code read stores or that is handed in from outside it, or an unresolved member handing one back), whatever its
    /// type: it is bracketed for the request's person (its userId argument, else the signed-in person), everyone's when
    /// there is none. Not for everyone: on 12.2 and 10.11.11 that would hold every automatic check during playback
    /// starts, favourites, ratings and user-data saves (Q-4AF11-1);</description></item>
    /// <item><description>or it is on the <see cref="Reviewed"/> list.</description></item>
    /// </list>
    /// The code read is the controller's assembly, with the Jellyfin server assemblies (Jellyfin.*, MediaBrowser.*, Emby.*)
    /// of its folder when that is Jellyfin's, else every assembly of its folder and Jellyfin's. It is read once (in the
    /// background for Jellyfin.Api), then each action is a dictionary lookup. An assembly that can't be read brackets every
    /// one of its actions that isn't GET, globally. JE's own actions are left to the brackets inside them.
    /// <para>
    /// Known limits (docs/arr/arr-features.md, "Known limits"): this is static analysis of the metadata. It can't see
    /// reflection, dynamic code (code generated at run time, a service resolved by name from a service locator), code
    /// outside the assemblies read (another plugin's, another process) or (round 19, Q-4AFIX19-1) a method of theirs that
    /// .NET's code calls back on an object handed to it (a stream's Write in a copy); a change made there is covered by Jellyfin's
    /// user events after it commits (JellyfinUserChangeVersion). Stated limits (round 17, each pinned by a test): lifecycle
    /// slots declared outside the code read (Dispose, DisposeAsync, Finalize, ToString, Equals, GetHashCode, GetType) aren't
    /// followed into implementations; a compiler-generated state machine is followed from the method that creates it (a
    /// lazy sequence created by one action and enumerated by another counts where it is created); a generic parameter's
    /// field (`T`) is followed to what the code read stores in it, not counted as handed in from outside. It may
    /// over-bracket (round 18): an array handed to other code (which may write it) has unknown elements; (round 19) a type
    /// whose ancestry can't be read whole may fill any slot it has a method for, and a type that can't be read may be a
    /// delegate (AncestryGaps lists them; none for Jellyfin 12.2 and 10.11.11 with their own files).
    /// </para>
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
        public static readonly IReadOnlyDictionary<string, string> NotAuthority = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            // Round 17 (reviewed in 12.2 and 10.11.11, Jellyfin.Database.Implementations PessimisticLockBehavior.DbLock):
            // Dispose runs the Action DbLock's own EnterWrite/EnterRead factories gave it (ExitWriteLock / ExitReadLock of
            // the database lock) or nothing (the shared no-lock instance). It changes no user; following it through every
            // `using` of a database lock would bracket ordinary actions (playback pings, display preferences) for nothing.
            ["DbLock.Dispose"] = "releases the database read/write lock",
        };

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
        // Round 17: object-lifecycle members (disposal, finalization, identity and text) change no user on any of the types
        // below; a virtual call to such a slot declared outside the code read (IDisposable, object) reaches them on every
        // implementation, so without this every `using` would count as a user change.
        private static readonly HashSet<string> LifecycleMembers = new(StringComparer.Ordinal)
        {
            "Dispose", "DisposeAsync", "Finalize", "ToString", "Equals", "GetHashCode", "GetType",
        };

        public static bool Mutates(string type, string member) => !LifecycleMembers.Contains(member) && type switch
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
        /// contract carries no user and hands back no code to run (code outside it that is handed none): recorded for review
        /// (tests and diagnostics). Unresolved delegates always count (round 11).
        /// </summary>
        /// <param name="path">The controller assembly.</param>
        public static IReadOnlyList<string> Uncounted(string path) => CodeSet.Read(path).Contained;

        /// <summary>
        /// Everything the code of <paramref name="member"/> ("Type.Member", the declaring type's simple name) reaches in the
        /// code read with the assembly at <paramref name="path"/>: the user changes, reviewed person changes, counted
        /// unresolved calls and ("callback …") unresolved callbacks (tests: a reviewed member is held to what it was reviewed for).
        /// </summary>
        /// <param name="path">The controller assembly.</param>
        /// <param name="member">The member.</param>
        public static IReadOnlyList<string> ReachedFrom(string path, string member) => CodeSet.Read(path, member).Reached;

        /// <summary>
        /// Round 19: the ancestry steps the reading of the assembly at <paramref name="path"/> couldn't read (a base, an
        /// interface or a type outside the code read whose assembly isn't found or doesn't define it), for review: each makes
        /// its types possible fills of any slot, and a type that can't be read a possible delegate (fail closed).
        /// </summary>
        /// <param name="path">The controller assembly.</param>
        public static IReadOnlyList<string> AncestryGaps(string path) => CodeSet.Read(path).Gaps;

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

            /// <summary>The ancestry steps that couldn't be read (each brackets as a possible fill of any slot).</summary>
            public IReadOnlyList<string> Gaps { get; private set; } = Array.Empty<string>();

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
                    if (node.Type < 0 && (node.Reaches ?? node.PersonReaches ?? node.Unresolved ?? (node.Callback is { } callback ? "callback " + callback : null)) is { } what) reached.Add(what);
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
                _loads.Clear();
                _fieldNodes.Clear();
                _fieldTypes.Clear();
                _modules.Clear();
                _implementers = null;
                _derived = null;
                _explicit.Clear();
                _moduleInitializers.Clear();
                _frameworkSlots.Clear();
                _stateMachines.Clear();
                _shapes.Clear();
                _capableFields.Clear();
                _sites.Clear();
                _sitesOf.Clear();
                _returns.Clear();
                _invokes.Clear();
                _upDone.Clear();
                _summaries.Clear();
                _readers.Clear();
                _refs.Clear();
                _lineages.Clear();
                _unreadable.Clear();
                _assemblyFiles = null;
                _declared.Clear();
                _outsides.Clear();
                foreach (var (key, weak) in Outsides)
                    if (!weak.TryGetTarget(out _)) Outsides.TryRemove(key, out _);
                _incomplete = null;
                _slotFills.Clear();
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
                // A callback nothing could follow (round 11): the request's person, everyone's when there is none (the
                // bracket's own fallback). Any other call nothing could follow: the person it touches isn't known.
                if (why.StartsWith("unresolved callback ", StringComparison.Ordinal)) return JellyfinUserKey.User;
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

            // Round 19: the folders an assembly outside the code read is looked for in first (the code read's: Jellyfin's
            // own holds its third-party libraries), before the runtime's (AssemblyFile).
            private static IEnumerable<string> Folders(string path)
            {
                var folder = Path.GetDirectoryName(Path.GetFullPath(path));
                if (!string.IsNullOrEmpty(folder)) yield return folder;
                var jellyfin = Path.GetDirectoryName(typeof(MediaBrowser.Controller.Library.IUserManager).Assembly.Location);
                if (!string.IsNullOrEmpty(jellyfin) && !string.Equals(jellyfin, folder, StringComparison.Ordinal)) yield return jellyfin;
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
                public bool Interface { get; init; }

                // Round 19: the base type and the interfaces the type itself lists, each with the assembly a reference names
                // (to read it when it is outside the code read). An interface, System.Object and <Module> have no base.
                public TypeRef? Base { get; init; }
                public List<TypeRef> Interfaces { get; } = new();
                public List<int> Methods { get; } = new();
                public HashSet<string> Events { get; } = new(StringComparer.Ordinal);
                public int Module { get; init; } = -1;

                // Round 19: a type outside the code read, read for its ancestry only (no method nodes): the assembly file it
                // is defined in (Declares reads its methods' names and parameter counts when asked).
                public bool External { get; init; }
                public string? File { get; init; }
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
                public bool Static { get; init; }
                public List<int> Calls { get; } = new();
                public string? Reaches { get; set; }
                public string? PersonReaches { get; set; }
                public string? Unresolved { get; set; }
                public string? Callback { get; set; }
                public int Via { get; set; } = -1;
                public int PersonVia { get; set; } = -1;
                public int UnresolvedVia { get; set; } = -1;
                public int CallbackVia { get; set; } = -1;

                // Round 17: it has IL (abstract, extern and runtime-implemented methods have none).
                public bool HasBody { get; init; }
            }

            private readonly List<TypeInfo> _types = new();
            private readonly Dictionary<string, List<int>> _typesByName = new(StringComparer.Ordinal);
            private readonly List<Node> _nodes = new();
            private readonly Dictionary<(int Module, int Token), int> _nodeOf = new();
            private readonly Dictionary<string, int> _terminals = new(StringComparer.Ordinal);
            private readonly Dictionary<string, int> _unresolved = new(StringComparer.Ordinal);
            // Round 18: every store of a delegate field, with the stored value's provenance in the storing method.
            private readonly Dictionary<string, List<(int Node, Prov Value)>> _stores = new(StringComparer.Ordinal);
            private readonly List<(int Node, string Field)> _loads = new();
            private readonly Dictionary<string, int> _fieldNodes = new(StringComparer.Ordinal);
            private readonly SortedSet<string> _contained = new(StringComparer.Ordinal);
            private readonly List<Module> _modules = new();
            private readonly Dictionary<string, string> _fieldTypes = new(StringComparer.Ordinal);
            private int _empty = -1;
            private Dictionary<string, List<int>>? _implementers;
            private Dictionary<string, List<int>>? _derived;

            // Round 19: the complete ancestry of every type (LineageOf). The types outside the code read are read from their
            // assemblies' metadata, found by the assembly a reference names (_refs: each name the code read references, and
            // where) in the code read's folders, then the runtime's (AssemblyFile); _readTypes: the code read's own types
            // (they come first in _types). A step that can't be read is a gap: the type's ancestry is incomplete, and it may
            // fill any slot (_incomplete, fail closed).
            private readonly Dictionary<string, string> _refs = new(StringComparer.Ordinal);
            private readonly Dictionary<int, Lineage> _lineages = new();
            private readonly HashSet<string> _unreadable = new(StringComparer.Ordinal);
            private readonly SortedSet<string> _gaps = new(StringComparer.Ordinal);
            private readonly List<string> _folders = new();
            private Dictionary<string, string>? _assemblyFiles;
            private readonly Dictionary<string, HashSet<(string Name, int Params)>?> _declared = new(StringComparer.Ordinal);
            private List<int>? _incomplete;
            private int _readTypes;

            // Round 19: each slot's fills (SlotFills), once.
            private readonly Dictionary<(string Type, string Method, int Params, bool Static), List<int>> _slotFills = new();

            // Explicit overrides: a slot (declaring type, method, parameter count, as a call names it) → the bodies a
            // MethodImpl entry maps to it.
            private readonly Dictionary<(string Type, string Method, int Params), List<int>> _explicit = new();

            // Each module's initializer (`<Module>`'s .cctor): the runtime runs it before any of the module's code.
            private readonly Dictionary<int, int> _moduleInitializers = new();

            // Round 17: shared nodes for virtual slots declared outside the code read (null: nothing read fills it).
            private readonly Dictionary<(string Type, string Method, int Params, bool Static), int?> _frameworkSlots = new();

            // The compiler-generated state machines: the types the code read's [*StateMachine] attributes name.
            private readonly HashSet<string> _stateMachines = new(StringComparer.Ordinal);

            // Round 17: delegate invocation by provenance (see Invocations): each method or call's shape; the call sites a
            // delegate can go into or come out of, and each method's sites; what each method returns; every invocation.
            private readonly Dictionary<(int Module, int Token), Shape> _shapes = new();
            private readonly Dictionary<(int Module, int Token), bool> _capableFields = new();
            private readonly List<Site> _sites = new();
            private readonly Dictionary<int, List<int>> _sitesOf = new();
            private readonly Dictionary<int, Prov> _returns = new();
            private readonly List<(int Node, Prov Receiver, string Type)> _invokes = new();
            private readonly Dictionary<(int Node, int Arg), Src> _upDone = new();

            // Round 19: what each method returns as a function of its arguments, to a fixed point (Summaries); who reads
            // whose (to iterate); the delegate fields whose node is made but not yet filled.
            private readonly Dictionary<int, Summary> _summaries = new();
            private readonly Dictionary<int, HashSet<int>> _readers = new();
            private readonly Queue<string> _pendingFields = new();

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
                    set._folders.AddRange(Folders(path));
                    for (var m = 0; m < modules.Count; m++) set.Index(modules[m], m);
                    set._readTypes = set._types.Count;
                    set.Running();
                    for (var m = 0; m < modules.Count; m++) set.Bodies(modules[m], m);
                    set.Delegates();
                    set.Propagate();
                    set.Actions(modules[0]);
                    set.Contained = set._contained.ToList();
                    set.Gaps = set._gaps.ToList();
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
                var self = AssemblyName(md);
                // Round 19: where each type the module names but doesn't define is (the assembly its reference names).
                foreach (var reference in md.TypeReferences)
                    if (Scope(md, reference) is { } assembly) _refs.TryAdd(FullName(md, reference), assembly);
                foreach (var handle in md.TypeDefinitions)
                {
                    var type = md.GetTypeDefinition(handle);
                    var info = new TypeInfo { Name = FullName(md, handle), Interface = (type.Attributes & TypeAttributes.Interface) != 0, Module = m, Base = type.BaseType.IsNil ? null : Locate(md, type.BaseType, self) };
                    foreach (var implementation in type.GetInterfaceImplementations()) info.Interfaces.Add(Locate(md, md.GetInterfaceImplementation(implementation).Interface, self));
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
                            // Round 11: virtual whether or not it is final. A sealed override is a virtual method marked
                            // final: it can't be overridden again, but it fills its base's slot, so a call through that slot
                            // reaches it.
                            Virtual = (method.Attributes & MethodAttributes.Virtual) != 0,
                            Abstract = (method.Attributes & MethodAttributes.Abstract) != 0,
                            NewSlot = (method.Attributes & MethodAttributes.NewSlot) != 0,
                            Static = (method.Attributes & MethodAttributes.Static) != 0,
                            HasBody = method.RelativeVirtualAddress != 0,
                        };
                        foreach (var machine in StateMachines(md, method.GetCustomAttributes())) _stateMachines.Add(machine);
                        _nodeOf[(m, MetadataTokens.GetToken(methodHandle))] = _nodes.Count;
                        info.Methods.Add(_nodes.Count);
                        _nodes.Add(node);
                    }

                    if (info.Name == "<Module>")
                        foreach (var n in info.Methods)
                            if (_nodes[n].Method == ".cctor") _moduleInitializers[m] = n;

                    // Rounds 12–13: an explicit override. A type's MethodImpl table maps a body to the slot it fills (an
                    // `.override`), whatever the body is called: C# uses it for covariant returns and explicit interface
                    // implementations, other .NET languages for any override under any name. Each entry becomes an edge
                    // from that slot to the body, which Dispatch follows.
                    foreach (var implHandle in type.GetMethodImplementations())
                    {
                        var impl = md.GetMethodImplementation(implHandle);
                        if (impl.MethodBody.Kind != HandleKind.MethodDefinition
                            || !_nodeOf.TryGetValue((m, MetadataTokens.GetToken(impl.MethodBody)), out var body)
                            || Declaration(md, impl.MethodDeclaration) is not { } slot) continue;
                        if (!_explicit.TryGetValue(slot, out var bodies)) _explicit[slot] = bodies = new List<int>();
                        bodies.Add(body);
                    }
                }
            }

            // Round 18: running a method runs its declaring type's static constructor and its module's initializer first (the
            // runtime runs each once, before the first use; an edge on every use over-approximates). ONE edge set on the
            // method node itself, so every way of reaching a method (a call, an override or implementation it dispatches to,
            // a slot .NET declares, a delegate or method pointer to it, a field holding one) reaches them the same way.
            private void Running()
            {
                for (var n = 0; n < _nodes.Count; n++)
                {
                    var node = _nodes[n];
                    if (node.Type < 0) continue;
                    foreach (var i in _types[node.Type].Methods)
                        if (i != n && _nodes[i].Method == ".cctor") node.Calls.Add(i);
                    if (_moduleInitializers.TryGetValue(node.Module, out var initializer) && initializer != n) node.Calls.Add(initializer);
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
                // Round 17: where every value on the stack came from (Flow), for every delegate value the body invokes, stores,
                // hands on or returns. Round 18: the one provenance model (the old "what was pushed last" and "what the body
                // made before the call" heuristics are gone).
                var flow = new Flow(body);
                var self = ShapeOf(md, m, MetadataTokens.MethodDefinitionHandle(_nodes[node].Token));
                // A `constrained.` prefix applies to the next instruction (a call, callvirt or method pointer): it dispatches.
                var constrained = false;
                while (il.RemainingBytes > 0)
                {
                    var start = il.Offset;
                    flow.Arrive(start);
                    var first = il.ReadByte();
                    var code = first == 0xfe ? TwoByte[il.ReadByte()] : OneByte[first];
                    var value = code.Value;
                    var prefixed = constrained;
                    constrained = false;
                    // Whether the case below applied the instruction's stack effect (otherwise its pops and pushes, unknown).
                    var stacked = true;
                    switch (code.OperandType)
                    {
                        case OperandType.InlineMethod:
                        {
                            var handle = MetadataTokens.EntityHandle(il.ReadInt32());
                            var dispatch = value == OpCodes.Callvirt.Value || value == OpCodes.Ldvirtftn.Value || prefixed;
                            var targets = Targets(md, m, handle, dispatch);
                            _nodes[node].Calls.AddRange(targets);
                            // Round 15: an access to a type by name (a static call, newobj, a method pointer naming it) runs its
                            // static constructor and its module's initializer; what the call RUNS gets them from Running().
                            if (MethodOwner(md, m, handle) is { } owner) _nodes[node].Calls.AddRange(TypeInitializers(owner).Concat(ModuleInitializers(owner)).Where(i => i != node));
                            Call(flow, node, value, ShapeOf(md, m, handle), targets);
                            break;
                        }
                        case OperandType.InlineField:
                        {
                            var handle = MetadataTokens.EntityHandle(il.ReadInt32());
                            if (value == OpCodes.Ldsfld.Value || value == OpCodes.Stsfld.Value || value == OpCodes.Ldsflda.Value)
                                _nodes[node].Calls.AddRange(TypeInitializers(FieldOwner(md, handle)).Where(i => i != node));
                            // Round 16: the runtime runs a module's initializer before any access to its types, methods or
                            // data, a field included.
                            _nodes[node].Calls.AddRange(ModuleInitializers(FieldOwner(md, handle)).Where(i => i != node));
                            var field = DelegateField(md, handle);
                            // A delegate field's value is what the field can hold (its field node: what the code read stores
                            // there, a generic parameter's field `T` included: the stated limit of FieldNode); a field whose
                            // type can't hold a delegate holds none; anything else (an object field) is unknown.
                            Value Loaded() => field != null ? Value.FieldOf(field) : !CapableField(md, m, handle) ? Value.None : Value.Unknown;
                            if (value == OpCodes.Ldfld.Value || value == OpCodes.Ldsfld.Value)
                            {
                                if (value == OpCodes.Ldfld.Value) flow.Pop();
                                flow.Push(Loaded());
                                if (field != null) _loads.Add((node, field));
                            }
                            else if (value == OpCodes.Stfld.Value || value == OpCodes.Stsfld.Value)
                            {
                                // The stored value's provenance (resolved when the body is read), whatever it is.
                                var stored = flow.Pop();
                                if (value == OpCodes.Stfld.Value) flow.Pop();
                                flow.Escapes.Add(stored);
                                if (field != null) flow.Stores.Add((field, stored));
                            }
                            else
                            {
                                // An address (ldflda, ldsflda): a delegate field's is followed (what is written through it is
                                // stored there; what is read is its value); anything else, unknown.
                                if (value == OpCodes.Ldflda.Value) flow.Pop();
                                flow.Push(field != null ? flow.Address(field) : Value.Unknown);
                                if (field != null) _loads.Add((node, field));
                            }

                            break;
                        }
                        case OperandType.InlineNone:
                            if (value is >= 0x02 and <= 0x05) flow.Push(Value.Arg(value - 0x02));
                            else if (value is >= 0x06 and <= 0x09) flow.Push(Value.Local(value - 0x06));
                            else if (value is >= 0x0a and <= 0x0d) flow.Store(flow.Locals, value - 0x0a, flow.Pop());
                            else if (value == OpCodes.Ldnull.Value) flow.Push(Value.None);
                            else if (value == OpCodes.Dup.Value) flow.Push(flow.Peek());
                            else if (value == OpCodes.Ret.Value)
                            {
                                if (!self.Void)
                                {
                                    var returned = flow.Pop();
                                    flow.Escapes.Add(returned);
                                    if (self.CapableReturn) flow.Returns.Add(returned);
                                }
                            }
                            else if (value == OpCodes.Ldelem_Ref.Value) flow.LoadElement();
                            else if (value == OpCodes.Stelem_Ref.Value) flow.StoreElement();
                            else if (value == OpCodes.Ldind_Ref.Value) flow.Push(flow.Pop().Through());
                            else if (value == OpCodes.Stind_Ref.Value) flow.StoreIndirect();
                            else stacked = false;
                            break;
                        case OperandType.ShortInlineVar:
                        case OperandType.InlineVar:
                        {
                            var index = code.OperandType == OperandType.ShortInlineVar ? il.ReadByte() : il.ReadUInt16();
                            if (value == OpCodes.Ldarg_S.Value || value == OpCodes.Ldarg.Value) flow.Push(Value.Arg(index));
                            else if (value == OpCodes.Ldloc_S.Value || value == OpCodes.Ldloc.Value) flow.Push(Value.Local(index));
                            else if (value == OpCodes.Starg_S.Value || value == OpCodes.Starg.Value) flow.Store(flow.Args, index, flow.Pop());
                            else if (value == OpCodes.Stloc_S.Value || value == OpCodes.Stloc.Value) flow.Store(flow.Locals, index, flow.Pop());
                            else
                            {
                                // An address taken (ldarga, ldloca): anything can be written through it, and what it holds
                                // (an array) escapes.
                                var argument = value == OpCodes.Ldarga_S.Value || value == OpCodes.Ldarga.Value;
                                flow.Escapes.Add(argument ? Value.Arg(index) : Value.Local(index));
                                flow.Store(argument ? flow.Args : flow.Locals, index, Value.Unknown);
                                flow.Push(Value.Unknown);
                            }

                            break;
                        }
                        case OperandType.InlineType:
                        {
                            // Round 16: a type token is an access to the type's module (its initializer runs first).
                            var handle = MetadataTokens.EntityHandle(il.ReadInt32());
                            _nodes[node].Calls.AddRange(ModuleInitializers(ParentName(md, handle)).Where(i => i != node));
                            // castclass, isinst, box, unbox.any: the same value.
                            if (value == OpCodes.Castclass.Value || value == OpCodes.Isinst.Value || value == OpCodes.Unbox_Any.Value || value == OpCodes.Box.Value) flow.Push(flow.Pop());
                            else if (value == OpCodes.Newarr.Value)
                            {
                                flow.Pop();
                                flow.Push(Value.Array(start));
                            }
                            else if (value == OpCodes.Ldelem.Value) flow.LoadElement();
                            else if (value == OpCodes.Stelem.Value) flow.StoreElement();
                            else if (value == OpCodes.Ldobj.Value) flow.Push(flow.Pop().Through());
                            else if (value == OpCodes.Stobj.Value) flow.StoreIndirect();
                            else
                            {
                                if (value == OpCodes.Constrained.Value) constrained = true;
                                stacked = false;
                            }

                            break;
                        }
                        case OperandType.InlineTok:
                        {
                            // ldtoken: a type, method or field of a module (its initializer runs first).
                            var handle = MetadataTokens.EntityHandle(il.ReadInt32());
                            var owner = handle.Kind switch
                            {
                                HandleKind.MethodDefinition or HandleKind.MethodSpecification => MethodOwner(md, m, handle),
                                HandleKind.FieldDefinition => FieldOwner(md, handle),
                                HandleKind.MemberReference => ParentName(md, md.GetMemberReference((MemberReferenceHandle)handle).Parent),
                                _ => ParentName(md, handle),
                            };
                            _nodes[node].Calls.AddRange(ModuleInitializers(owner).Where(i => i != node));
                            stacked = false;
                            break;
                        }
                        case OperandType.ShortInlineBrTarget:
                        case OperandType.InlineBrTarget:
                        {
                            var delta = code.OperandType == OperandType.ShortInlineBrTarget ? il.ReadSByte() : il.ReadInt32();
                            // leave empties the stack; any other branch pops its operands first.
                            if (value == OpCodes.Leave.Value || value == OpCodes.Leave_S.Value) flow.Clear();
                            else flow.Generic(code);
                            flow.Branch(start, il.Offset + delta);
                            break;
                        }
                        case OperandType.ShortInlineI:
                            il.Offset += 1;
                            stacked = false;
                            break;
                        case OperandType.InlineI8 or OperandType.InlineR:
                            il.Offset += 8;
                            stacked = false;
                            break;
                        case OperandType.InlineSig:
                        {
                            var handle = MetadataTokens.EntityHandle(il.ReadInt32());
                            // Round 15: an indirect call (calli) always counts as a possible change, judged by its
                            // signature like an unresolved callback: the pointer can come from anywhere (a temporary, a
                            // parameter, a return value). The pointers the reading saw being made (ldftn, a tracked
                            // pointer field) are followed too, so what they reach is still reported. Jellyfin 12.2 and
                            // 10.11.11 have no calli.
                            var signature = handle.Kind == HandleKind.StandaloneSignature ? md.GetStandaloneSignature((StandaloneSignatureHandle)handle).DecodeMethodSignature(Names.Instance, null) : (MethodSignature<string>?)null;
                            if (value == OpCodes.Calli.Value)
                            {
                                var contract = signature is { } s && UserContract(MethodTypes(md, s), null);
                                _nodes[node].Calls.Add(Unresolved("indirect call in " + _nodes[node].Name + " (a pointer the reading didn't see being made)", true, callback: !contract));
                            }

                            if (signature is { } sig)
                            {
                                flow.Pop();
                                // The arguments go to code the reading can't see: an array among them escapes.
                                for (var i = sig.ParameterTypes.Length + (sig.Header.IsInstance && !sig.Header.HasExplicitThis ? 1 : 0); i > 0; i--) flow.Escapes.Add(flow.Pop());
                                if (sig.ReturnType != "System.Void") flow.Push(Value.Unknown);
                            }
                            else flow.Break();

                            break;
                        }
                        case OperandType.InlineSwitch:
                        {
                            // The count, then that many branch targets (read the count first: it moves the offset).
                            var count = il.ReadInt32();
                            var deltas = new int[count];
                            for (var i = 0; i < count; i++) deltas[i] = il.ReadInt32();
                            flow.Pop();
                            foreach (var delta in deltas) flow.Branch(start, il.Offset + delta);
                            break;
                        }
                        default:
                            il.Offset += 4;
                            // A string is no delegate.
                            if (value == OpCodes.Ldstr.Value) flow.Push(Value.None);
                            else stacked = false;
                            break;
                    }

                    if (!stacked) flow.Generic(code);
                    // After an unconditional transfer the next instruction's stack is a branch's snapshot, or empty.
                    if (code.FlowControl is FlowControl.Branch or FlowControl.Return or FlowControl.Throw || value == OpCodes.Jmp.Value) flow.End();
                }

                Settle(flow, node, self);
            }

            // Round 17: a call's stack effect, and what it does with delegates. A delegate's Invoke (BeginInvoke,
            // DynamicInvoke) runs its receiver; a call leaving the code read may run the delegates it is handed (Task.Run,
            // a framework callback); a call into the code read hands its arguments to the callee's parameters, and its
            // result is what the callee returns (a site, recorded where a delegate can go in or come out). Round 18: a method
            // pointer is the methods the resolver returned for it (a delegate made from it, the same); every argument escapes
            // (an array handed to a call can be written there), except a delegate field's address handed to code outside
            // the code read (Interlocked.CompareExchange, Volatile.Write: an event's add and remove), which stores the other
            // arguments in the field and returns its value or theirs.
            private void Call(Flow flow, int node, short value, Shape shape, List<int> targets)
            {
                if (value == OpCodes.Ldftn.Value || value == OpCodes.Ldvirtftn.Value)
                {
                    // A pointer to a delegate's Invoke (`new Action(callback.Invoke)`) runs that delegate when invoked.
                    var receiver = value == OpCodes.Ldvirtftn.Value ? flow.Pop() : shape.Invoke != null ? flow.Peek() : null;
                    if (shape.Invoke != null && receiver != null) flow.Invokes.Add((receiver, shape.Invoke));
                    flow.Push(Value.Pointer(targets));
                    return;
                }

                if (value == OpCodes.Jmp.Value)
                {
                    // jmp: the callee runs with this method's own arguments.
                    var own = new Value[Math.Max(shape.Pops, 0)];
                    for (var i = 0; i < own.Length; i++) own[i] = Value.Arg(i);
                    Record(flow, node, shape, targets, own);
                    return;
                }

                if (shape.Pops < 0)
                {
                    flow.Break();
                    return;
                }

                Value[] args;
                if (value == OpCodes.Newobj.Value)
                {
                    // The new object is the constructor's `this` (argument 0), not popped.
                    args = new Value[shape.Params + 1];
                    for (var i = shape.Params; i >= 1; i--) args[i] = flow.Pop();
                    args[0] = Value.None;
                }
                else
                {
                    args = new Value[shape.Pops];
                    for (var i = args.Length - 1; i >= 0; i--) args[i] = flow.Pop();
                }

                // Leaving the code read: nothing read, or only members without IL (extern, runtime-implemented).
                var outside = targets.All(t => _nodes[t].Type >= 0 && !_nodes[t].HasBody && !_nodes[t].Abstract);
                var addresses = outside ? args.Where(a => a.Kind == ValueKind.Address).Select(a => a.Name!).ToList() : null;
                foreach (var a in args)
                    if (addresses is not { Count: > 0 } || a.Kind != ValueKind.Address) flow.Escapes.Add(a);
                foreach (var field in addresses ?? Enumerable.Empty<string>())
                    foreach (var a in args)
                        if (a.Kind != ValueKind.Address) flow.Stores.Add((field, a));
                if (shape.Invoke != null && args.Length > 0) flow.Invokes.Add((args[0], shape.Invoke));
                else if (outside && shape.Delegates != null && !ReviewedRead(shape.Parent, shape.Name))
                    for (var i = 0; i < args.Length && i < shape.Delegates.Length; i++)
                        if (shape.Delegates[i] is { } type) flow.Invokes.Add((args[i], type));
                var site = Record(flow, node, shape, targets, args);
                if (value == OpCodes.Newobj.Value)
                    // A delegate made from a method pointer is the pointer's methods; a new object of any other type isn't a
                    // delegate.
                    flow.Push(!shape.DelegateCtor ? Value.None : args[^1].Kind == ValueKind.Pointer ? args[^1] : Value.Unknown);
                else if (!shape.Void)
                    flow.Push(shape.Combine ? Value.Union(args[0], args[^1])
                        : !shape.CapableReturn ? Value.None
                        : addresses is { Count: > 0 } ? args.Select(a => a.Kind == ValueKind.Address ? a.Through() : a).Aggregate(Value.Union)
                        : site >= 0 ? Value.Result(site) : Value.Unknown);
            }

            private int Record(Flow flow, int node, Shape shape, List<int> targets, Value[] args)
            {
                if (shape.Capable == null && !shape.CapableReturn) return -1;
                var id = _sites.Count;
                _sites.Add(new Site(node, targets));
                foreach (var t in targets.Distinct())
                {
                    if (!_sitesOf.TryGetValue(t, out var list)) _sitesOf[t] = list = new List<int>();
                    list.Add(id);
                }

                var given = new Value?[args.Length];
                for (var i = 0; i < args.Length; i++)
                    if (shape.Capable != null && i < shape.Capable.Length && shape.Capable[i]) given[i] = args[i];
                flow.Sites.Add((id, given));
                return id;
            }

            // Round 17: the body read, what it recorded becomes provenance (locals, arguments written to and array elements
            // resolved within the body). A body the stack couldn't follow records only unknowns (fail closed). Round 18:
            // its delegate-field stores too, each with the stored value's provenance, and an unknown store for every
            // delegate field whose address escaped to code that may write anything through it.
            private void Settle(Flow flow, int node, Shape self)
            {
                if (flow.Invokes.Count == 0 && flow.Sites.Count == 0 && flow.Stores.Count == 0 && flow.Addressed.Count == 0 && !self.CapableReturn) return;
                var within = flow.Broken ? null : flow.Within();
                Prov Of(Value v) => within == null ? Prov.Untracked : within.Of(v);
                foreach (var (receiver, type) in flow.Invokes) _invokes.Add((node, Of(receiver), type));
                foreach (var (site, given) in flow.Sites) _sites[site].Args = given.Select(g => g == null ? null : Of(g)).ToArray();
                foreach (var (field, stored) in flow.Stores) Store(field, node, Of(stored));
                foreach (var (address, stored) in flow.Indirect)
                    foreach (var field in Of(address).Addresses ?? Enumerable.Empty<string>())
                        Store(field, node, Of(stored));
                foreach (var field in within?.EscapedAddresses ?? flow.Addressed)
                    Store(field, node, Prov.Untracked);
                if (self.CapableReturn)
                {
                    var returns = new Prov();
                    foreach (var r in flow.Returns) returns.Add(Of(r));
                    if (flow.Broken) returns.Unknown = true;
                    _returns[node] = returns;
                }
            }

            private void Store(string field, int node, Prov stored)
            {
                if (!_stores.TryGetValue(field, out var stores)) _stores[field] = stores = new List<(int, Prov)>();
                stores.Add((node, stored));
            }

            // Round 18: THE target resolver. Every transfer the IL loop reads asks it which methods may run: a call, callvirt,
            // newobj, jmp, a method pointer (ldftn, ldvirtftn: what a delegate made from it runs), with or without a
            // `constrained.` prefix; a delegate's own Invoke is judged by the delegate's provenance, whose methods were
            // resolved here where the pointer was made. The nodes: the method, and with dispatch every implementation or
            // override (an override of a code-read slot, an implementation of an interface member, static ones included,
            // and the fills of a slot .NET declares, see FrameworkSlot); a Mutates member's terminal; nothing for a reviewed
            // read or a call outside the code read (the framework's); an unresolved node for a Jellyfin member nothing read
            // declares or implements. Dispatch: callvirt, ldvirtftn, any constrained call or pointer (C# 11 calls a static
            // abstract member as `constrained. T call I::M`, an interface member on a type parameter as `constrained. T
            // callvirt`), and any call or pointer whose target is an interface member the code read declares (Follow).
            // Running what it returns is the method nodes' own edge set (Running): body, type initializer, module initializer.
            private List<int> Targets(MetadataReader md, int m, EntityHandle handle, bool dispatch)
            {
                switch (handle.Kind)
                {
                    case HandleKind.MethodSpecification:
                        return Targets(md, m, md.GetMethodSpecification((MethodSpecificationHandle)handle).Method, dispatch);
                    case HandleKind.MethodDefinition:
                    {
                        var target = _nodeOf[(m, MetadataTokens.GetToken(handle))];
                        return Follow(_types[_nodes[target].Type].Name, _nodes[target].Method, _nodes[target].Params, new List<int> { target }, dispatch);
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
                        {
                            // Round 17: a dispatched call to a slot declared outside the code read (a framework interface or
                            // base class) still runs the implementations and overrides the code read has: one shared slot
                            // node per declaration reaches them. Round 18: for every dispatching transfer (a constrained call
                            // included), and a static slot (a static abstract member .NET declares) by its static fills.
                            if (dispatch && FrameworkSlot(parent, called, count, !md.GetBlobReader(member.Signature).ReadSignatureHeader().IsInstance) is { } slotNode) return new List<int> { slotNode };
                            if (!JellyfinType(parent)) return found;
                            var signature = member.DecodeMethodSignature(Names.Instance, null);
                            var contract = UserContract(MethodTypes(md, signature), null);
                            return new List<int> { Unresolved(Simple(parent) + "." + called + " (not in the code read)", contract || HandsBackCallback(signature), callback: !contract) };
                        }

                        return Follow(parent, called, count, found, dispatch);
                    }
                    default:
                        return new List<int>();
                }
            }

            private static bool JellyfinType(string type) => type.StartsWith("MediaBrowser.", StringComparison.Ordinal) || type.StartsWith("Jellyfin.", StringComparison.Ordinal) || type.StartsWith("Emby.", StringComparison.Ordinal);

            // A resolved call: a Mutates member ends there (reached), a reviewed read ends there (nothing), anything else is
            // followed, through dispatch where the runtime may run another method: a virtual call (callvirt, ldvirtftn), and
            // any call or method pointer to an INTERFACE member, static ones included (C# 11 calls a static abstract or
            // static virtual member as `constrained. T call I::M`). A plain call to a class method runs that method only
            // (`base.M()`).
            private List<int> Follow(string type, string name, int count, List<int> found, bool dispatch)
            {
                if (Mutates(type, name)) return new List<int> { Terminal(Simple(type) + "." + name) };
                if (PersonScoped.ContainsKey(Simple(type) + "." + name)) return new List<int> { Terminal(Simple(type) + "." + name, person: true) };
                if (ReviewedRead(type, name)) return new List<int>();
                var targets = new List<int>(found);
                foreach (var target in found.ToList())
                    if (dispatch || (_nodes[target].Type >= 0 && _types[_nodes[target].Type].Interface))
                        targets.AddRange(Dispatch(target));
                return targets;
            }

            // A method of a type by name and parameter count, on the type or the nearest base declaring it (round 19: over its
            // complete ancestry; a base outside the code read that declares it ends the search: the runtime runs that one).
            private List<int> Resolve(string type, string name, int count)
            {
                // A type outside the code read: none of its methods is the code read's.
                var t = TypeId(type, null);
                if (t < 0 || _types[t].External) return new List<int>();
                foreach (var c in LineageOf(t).Bases.Prepend(t))
                {
                    if (_types[c].External)
                    {
                        if (Declares(c, name, count)) break;
                        continue;
                    }

                    var found = _typesByName[_types[c].Name].Where(i => !_types[i].External).SelectMany(i => _types[i].Methods).Where(n => _nodes[n].Method == name && _nodes[n].Params == count).ToList();
                    if (found.Count > 0) return found;
                }

                return new List<int>();
            }

            // Where a dispatched call of target can go: the fills of its slot (SlotFills), whatever they reach (Mapped). An
            // abstract or interface member nothing fills is unresolved.
            private IEnumerable<int> Dispatch(int target)
            {
                var node = _nodes[target];
                if (node.Type < 0) return Array.Empty<int>();
                var type = _types[node.Type];
                if (!type.Interface && !node.Virtual) return Array.Empty<int>();
                var fills = SlotFills(type.Name, node.Method, node.Params, node.Static).Where(n => n != target).ToList();
                if (fills.Count == 0 && (node.Abstract || type.Interface))
                {
                    var contract = UserContract(node);
                    return new[] { Unresolved(node.Name + " (nothing read implements it)", contract || HandsBackCallback(node), callback: !contract) };
                }

                return Mapped(fills);
            }

            // A fill reached by dispatch counts as a call of it: a Mutates member is reached (its terminal), a reviewed change
            // to the request's person likewise, a reviewed read is nothing; anything else is followed.
            private List<int> Mapped(IEnumerable<int> fills)
            {
                var mapped = new List<int>();
                foreach (var n in fills)
                {
                    var type = _types[_nodes[n].Type].Name;
                    var method = _nodes[n].Method;
                    if (Mutates(type, method)) mapped.Add(Terminal(Simple(type) + "." + method));
                    else if (PersonScoped.ContainsKey(Simple(type) + "." + method)) mapped.Add(Terminal(Simple(type) + "." + method, person: true));
                    else if (!ReviewedRead(type, method)) mapped.Add(n);
                }

                return mapped.Distinct().ToList();
            }

            // Round 19 (4a-r19-1, 4a-r19-2): THE fill rule, for every slot, declared in the code read or outside it (a virtual
            // or abstract member of a class, an interface member, static ones included). ECMA-335 II.10.3 and II.12.2 over
            // each type's COMPLETE ancestry (LineageOf: bases and interfaces outside the code read included, read from their
            // metadata): a type fills an interface slot it implements (directly, through a base class or an interface's
            // bases) with its own method of that name and parameter count, else the nearest base's (an implementation
            // inherited from a class that doesn't itself declare the interface); a class's virtual slot is filled by every
            // descendant's override (not a new slot), framework intermediate bases included (a sink deriving from
            // MemoryStream overrides Stream.Write); and any type's MethodImpl entry naming the slot fills it whatever its
            // name. Every fill fills its own slot in turn (overrides of overrides, an override of an inherited
            // implementation, an explicit entry naming it), each slot once. An instance slot is filled by virtual methods, a
            // static slot by static ones. Generic arguments aren't read, so variance (an IProgress<object> called as an
            // IProgress<string>) is covered. A type whose ancestry can't be read whole may fill any slot (fail closed). A
            // compiler-generated state machine is no fill (see FrameworkSlot). Abstract fills aren't returned (nothing
            // runs there), but their slots are followed.
            private List<int> SlotFills(string type, string method, int count, bool isStatic)
            {
                var key = (type, method, count, isStatic);
                if (_slotFills.TryGetValue(key, out var cached)) return cached;
                var fills = new List<int>();
                var seen = new HashSet<int>();
                var slots = new HashSet<(string, string, int, bool)> { key };
                var queue = new Queue<(string Type, string Method, int Params, bool Static)>();
                queue.Enqueue(key);
                while (queue.Count > 0)
                {
                    var slot = queue.Dequeue();
                    foreach (var n in DirectFills(slot.Type, slot.Method, slot.Params, slot.Static))
                    {
                        if (!seen.Add(n) || _stateMachines.Contains(_types[_nodes[n].Type].Name)) continue;
                        if (!_nodes[n].Abstract) fills.Add(n);
                        var own = (_types[_nodes[n].Type].Name, _nodes[n].Method, _nodes[n].Params, _nodes[n].Static);
                        if (slots.Add(own)) queue.Enqueue(own);
                    }
                }

                return _slotFills[key] = fills;
            }

            // The methods that fill one slot directly (SlotFills follows them on).
            private IEnumerable<int> DirectFills(string type, string method, int count, bool isStatic)
            {
                // An interface slot, a class's, or (its type can't be read) both.
                var kind = IsInterface(type);
                if (kind != false)
                {
                    foreach (var t in Implementers(type))
                    {
                        var own = Matching(t, method, count, isStatic).ToList();
                        // Implemented through a base class's method (that class need not declare the interface).
                        if (own.Count == 0) own = Inherited(t, method, count, isStatic);
                        foreach (var n in own) yield return n;
                    }
                }

                if (kind != true)
                {
                    foreach (var t in Derived(type))
                        foreach (var n in Matching(t, method, count, isStatic))
                            if (!_nodes[n].NewSlot) yield return n;
                }

                if (_explicit.TryGetValue((type, method, count), out var bodies))
                    foreach (var n in bodies) yield return n;
            }

            // A type's own methods that can fill a slot by name (an explicit C# implementation's name ends with it).
            private IEnumerable<int> Matching(int t, string method, int count, bool isStatic)
                => _types[t].Methods.Where(n => _nodes[n].Params == count && _nodes[n].Static == isStatic && (isStatic || _nodes[n].Virtual)
                    && (_nodes[n].Method == method || _nodes[n].Method.EndsWith("." + method, StringComparison.Ordinal)));

            // The nearest base's fill (in the code read; one outside it that declares the method ends the search: the
            // runtime runs that one).
            private List<int> Inherited(int t, string method, int count, bool isStatic)
            {
                foreach (var b in LineageOf(t).Bases)
                {
                    if (_types[b].External)
                    {
                        if (Declares(b, method, count)) break;
                        continue;
                    }

                    var found = Matching(b, method, count, isStatic).ToList();
                    if (found.Count > 0) return found;
                }

                return new List<int>();
            }

            // The code read's types implementing an interface (through their complete ancestry), and those whose ancestry
            // can't be read whole (fail closed).
            private List<int> Implementers(string name)
            {
                if (_implementers == null)
                {
                    _implementers = new Dictionary<string, List<int>>(StringComparer.Ordinal);
                    for (var t = 0; t < _readTypes; t++)
                    {
                        if (_types[t].Interface) continue;
                        foreach (var i in LineageOf(t).Interfaces)
                        {
                            if (!_implementers.TryGetValue(_types[i].Name, out var list)) _implementers[_types[i].Name] = list = new List<int>();
                            if (!list.Contains(t)) list.Add(t);
                        }
                    }
                }

                var found = _implementers.TryGetValue(name, out var listed) ? listed : new List<int>();
                return found.Concat(Incomplete().Where(t => !_types[t].Interface)).Distinct().ToList();
            }

            // The code read's types deriving from a class (through their complete ancestry), and those whose ancestry can't
            // be read whole (fail closed).
            private List<int> Derived(string name)
            {
                if (_derived == null)
                {
                    _derived = new Dictionary<string, List<int>>(StringComparer.Ordinal);
                    for (var t = 0; t < _readTypes; t++)
                        foreach (var b in LineageOf(t).Bases)
                        {
                            if (!_derived.TryGetValue(_types[b].Name, out var list)) _derived[_types[b].Name] = list = new List<int>();
                            list.Add(t);
                        }
                }

                var found = _derived.TryGetValue(name, out var listed) ? listed : new List<int>();
                return found.Concat(Incomplete()).Distinct().ToList();
            }

            private List<int> Incomplete()
                => _incomplete ??= Enumerable.Range(0, _readTypes).Where(t => LineageOf(t).Incomplete).ToList();

            // A Mutates member reached (or a reviewed change to the request's own person, PersonScoped).
            private int Terminal(string reaches, bool person = false)
            {
                if (_terminals.TryGetValue(reaches, out var node)) return node;
                _terminals[reaches] = _nodes.Count;
                _nodes.Add(person ? new Node { Name = reaches, PersonReaches = reaches } : new Node { Name = reaches, Reaches = reaches });
                return _nodes.Count - 1;
            }

            // A call that can't be followed. A delegate whose target stays unresolved always counts (round 11: what a
            // callback does isn't in its type). Any other call counts (its callers are unresolved) when its contract can
            // carry a user: a parameter or result type that is a user, a user id, or the user, session or sign-in services
            // (see UserContract), or when it hands back a delegate (a callback the code read can't see into). One whose
            // contract can't (a provider's name, a media item's delete) runs code outside the code read that is handed no
            // user and gives back no code to run: it is recorded for review, and not followed. A callback (callback: a
            // delegate, or what hands one back, with no user in its contract) touches someone the code read can't name:
            // its action is bracketed for the request's person, everyone's only when there is none (Q-4AF11-1); a call
            // whose contract carries a user, for everyone.
            private int Unresolved(string what, bool couldReach = true, bool callback = false)
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
                _nodes.Add(callback ? new Node { Name = what, Callback = what } : new Node { Name = what, Unresolved = what });
                return _nodes.Count - 1;
            }

            // Each delegate field loaded: a node standing for what it can hold, then every delegate invocation (Invocations).
            // Round 19: what each method returns is summarized first, to a fixed point (Summaries); the field nodes are filled
            // from a work list (a field fed by another makes that one's node), never cut by a depth.
            private void Delegates()
            {
                Summaries();
                foreach (var (node, field) in _loads) _nodes[node].Calls.Add(FieldNode(field));
                while (_pendingFields.Count > 0) FieldEdges(_pendingFields.Dequeue());
                Invocations();
            }

            private int FieldNode(string field)
            {
                if (_fieldNodes.TryGetValue(field, out var existing)) return existing;
                var id = _nodes.Count;
                _fieldNodes[field] = id;
                var (owner, name) = (field.Split("::")[0], field.Split("::")[1]);
                _nodes.Add(new Node { Name = "delegate " + Simple(owner) + "." + name });
                _pendingFields.Enqueue(field);
                return id;
            }

            // Round 18: what a delegate field can hold is what its stores put there, each by the stored value's provenance
            // (Sources: the same model as an invocation's): the methods a delegate made from a pointer runs, the delegate
            // fields it was loaded from, a parameter's value at each call site (in that caller, argument by argument), what
            // a call returns. Where the provenance is lost (handed in from outside the code read, an unknown, a container
            // that escaped) the field holds an unresolved callback: the methods that read it run it, not the one that stored
            // it. Unresolved too: a field nothing in the code read stores.
            private void FieldEdges(string field)
            {
                var id = _fieldNodes[field];
                var stores = _stores.GetValueOrDefault(field);
                // Round 11: a delegate whose target stays unresolved counts whatever its type (Q-4AF11-1): a Func<Task> carries
                // no user, but the closure behind it can hold the user manager and a user id. One whose type can carry a
                // user stays a call for everyone (round 10).
                var fieldType = _fieldTypes.GetValueOrDefault(field, string.Empty);
                var callback = !UserContract(new[] { fieldType }, null);
                // Round 17: a field typed by a generic parameter (`T`) holds a delegate only in some constructed uses
                // (ValueTuple items, anonymous types and event arguments are `T` fields too): it is followed to the delegates
                // the code read is seen storing in it, and what is lost on the way (stored from outside the code read, or
                // a value of another type) isn't counted (a stated limit; Jellyfin's user events cover it).
                var generic = fieldType.StartsWith("!", StringComparison.Ordinal);
                if (!generic && (stores == null || stores.Count == 0)) _nodes[id].Calls.Add(Unresolved(_nodes[id].Name + " (nothing in the code read stores it)", callback: callback));
                foreach (var (storer, stored) in stores ?? new List<(int, Prov)>())
                {
                    var sources = Sources(stored, storer);
                    foreach (var n in sources.Nodes ?? Enumerable.Empty<int>()) _nodes[id].Calls.Add(n);
                    foreach (var f in sources.Fields ?? Enumerable.Empty<string>())
                        if (f != field) _nodes[id].Calls.Add(FieldNode(f));
                    if (!generic)
                        foreach (var (_, where) in sources.Lost ?? Enumerable.Empty<(int, string)>())
                            _nodes[id].Calls.Add(Unresolved(_nodes[id].Name + " (" + where + ")", callback: callback));
                }
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

                queue = new Queue<int>(Enumerable.Range(0, _nodes.Count).Where(n => _nodes[n].Callback != null));
                while (queue.Count > 0)
                {
                    var n = queue.Dequeue();
                    foreach (var caller in callers[n] ?? Enumerable.Empty<int>())
                    {
                        if (_nodes[caller].Callback != null) continue;
                        _nodes[caller].Callback = _nodes[n].Callback;
                        _nodes[caller].CallbackVia = n;
                        queue.Enqueue(caller);
                    }
                }
            }

            // The calls from node to what it reaches: 0 a user change, 1 a reviewed change to the request's person, 2 a call
            // that couldn't be followed, 3 a callback that couldn't.
            private List<string> CallPath(int node, int kind)
            {
                var path = new List<string>();
                for (var (n, depth) = (node, 0); n >= 0 && depth < 64; depth++)
                {
                    path.Add(_nodes[n].Name);
                    n = kind switch { 0 => _nodes[n].Via, 1 => _nodes[n].PersonVia, 2 => _nodes[n].UnresolvedVia, _ => _nodes[n].CallbackVia };
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
                    if (!Controller(md, typeHandle)) continue;
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
                        // couldn't be followed: everyone, for a write; only a callback that couldn't (round 11): the
                        // request's person, everyone when there is none.
                        var reaches = node.Reaches ?? node.PersonReaches;
                        var unresolved = reaches == null && node.Unresolved != null ? "unresolved " + node.Unresolved
                            : reaches == null && node.Callback != null ? "unresolved callback " + node.Callback
                            : null;
                        var key = node.Reaches == null && node.PersonReaches != null || userId ? JellyfinUserKey.User : JellyfinUserKey.Global;
                        var action = new JellyfinUserAction(controller, node.Method, verbs.Count == 0 ? new[] { "*" } : verbs, key, unresolved, reaches,
                            node.Reaches != null ? CallPath(id, 0) : node.PersonReaches != null ? CallPath(id, 1) : node.Unresolved != null ? CallPath(id, 2) : node.Callback != null ? CallPath(id, 3) : null);
                        _actions[token] = action with { Key = KeyFor(action, controller), Why = WhyFor(action, controller) };
                    }
                }
            }

            // A public class that MVC would treat as a controller: named *Controller, or deriving from ControllerBase.
            private bool Controller(MetadataReader md, TypeDefinitionHandle handle)
            {
                var type = md.GetTypeDefinition(handle);
                if ((type.Attributes & TypeAttributes.VisibilityMask) != TypeAttributes.Public || (type.Attributes & (TypeAttributes.Abstract | TypeAttributes.Interface)) != 0) return false;
                if (md.GetString(type.Name).EndsWith("Controller", StringComparison.Ordinal)) return true;
                // Round 19: its complete ancestry (an intermediate base outside the code read included). One that can't be
                // read isn't counted: MVC's actions the reading has no entry for are bracketed when they aren't GETs (KeyOf).
                var t = _typesByName.TryGetValue(FullName(md, handle), out var ids) ? ids.FirstOrDefault(i => _types[i].Module == 0, -1) : -1;
                return t >= 0 && LineageOf(t).Bases.Any(b => _types[b].Name is "Microsoft.AspNetCore.Mvc.ControllerBase" or "Microsoft.AspNetCore.Mvc.Controller");
            }

            // ------------------------------------------------------------------ delegate provenance (rounds 17–18)

            // What a value on the stack (or in a local, an argument written to, an array's element) can be, as far as
            // delegates go: unknown; none (null, a number, a string, anything whose type can't hold a delegate); a method
            // pointer or a delegate made from one (the methods the target resolver returned); a delegate field's value; a
            // delegate field's address; the method's own argument; a local; what a call returned (its site); a fresh array
            // (its allocation) or one of its elements; or either of two.
            private enum ValueKind { Unknown, None, Pointer, Field, Address, Arg, Local, Result, Array, Element, Union }

            private sealed class Value
            {
                public static readonly Value Unknown = new(ValueKind.Unknown, 0), None = new(ValueKind.None, 0);
                private static readonly Value[] Args = Enumerable.Range(0, 32).Select(i => new Value(ValueKind.Arg, i)).ToArray();
                private static readonly Value[] Locals = Enumerable.Range(0, 64).Select(i => new Value(ValueKind.Local, i)).ToArray();

                private Value(ValueKind kind, int index) => (Kind, Index) = (kind, index);

                public ValueKind Kind { get; }

                public int Index { get; }

                public Value? A { get; private init; }

                public Value? B { get; private init; }

                // A pointer's methods.
                public IReadOnlyList<int>? Nodes { get; private init; }

                // A field's or an address's delegate field ("Type::Name").
                public string? Name { get; private init; }

                public static Value Arg(int i) => i < Args.Length ? Args[i] : new Value(ValueKind.Arg, i);

                public static Value Local(int i) => i < Locals.Length ? Locals[i] : new Value(ValueKind.Local, i);

                public static Value Result(int site) => new(ValueKind.Result, site);

                public static Value Pointer(IReadOnlyList<int> nodes) => new(ValueKind.Pointer, 0) { Nodes = nodes };

                public static Value FieldOf(string field) => new(ValueKind.Field, 0) { Name = field };

                public static Value AddressOf(string field) => new(ValueKind.Address, 0) { Name = field };

                public static Value Array(int allocation) => new(ValueKind.Array, allocation);

                public static Value Element(Value array) => new(ValueKind.Element, 0) { A = array };

                // Both kept (an unknown included): an array among them can still escape.
                public static Value Union(Value a, Value b) => ReferenceEquals(a, b) ? a : new Value(ValueKind.Union, 0) { A = a, B = b };

                // What is read through an address (ldind.ref, ldobj): a delegate field's address gives its value; any other,
                // unknown.
                public Value Through() => Kind == ValueKind.Address ? FieldOf(Name!) : Unknown;
            }

            // Provenance resolved within a body: unknown, none, the methods (pointers), delegate fields, fresh arrays and
            // delegate-field addresses it can be, the arguments it came from, the call sites whose results it is.
            private sealed class Prov
            {
                public static readonly Prov Untracked = new() { Unknown = true };

                public bool Unknown { get; set; }

                public bool None { get; set; }

                public HashSet<int>? Methods { get; private set; }

                public HashSet<string>? Fields { get; private set; }

                public HashSet<int>? Arrays { get; private set; }

                public HashSet<string>? Addresses { get; private set; }

                public HashSet<int>? Args { get; private set; }

                public HashSet<int>? Results { get; private set; }

                public int Size => (Unknown ? 1 : 0) + (None ? 1 : 0) + (Methods?.Count ?? 0) + (Fields?.Count ?? 0) + (Arrays?.Count ?? 0) + (Addresses?.Count ?? 0) + (Args?.Count ?? 0) + (Results?.Count ?? 0);

                // Something other than the body's own fresh arrays (an array of that is one the reading can't see into).
                public bool Foreign => Unknown || None || Methods != null || Fields != null || Addresses != null || Args != null || Results != null;

                public void AddMethods(IEnumerable<int> nodes) => (Methods ??= new HashSet<int>()).UnionWith(nodes);

                public void AddField(string field) => (Fields ??= new HashSet<string>(StringComparer.Ordinal)).Add(field);

                public void AddArray(int allocation) => (Arrays ??= new HashSet<int>()).Add(allocation);

                public void AddAddress(string field) => (Addresses ??= new HashSet<string>(StringComparer.Ordinal)).Add(field);

                public void AddArg(int i) => (Args ??= new HashSet<int>()).Add(i);

                public void AddResult(int site) => (Results ??= new HashSet<int>()).Add(site);

                public void Add(Prov other)
                {
                    if (ReferenceEquals(other, this)) return;
                    Unknown |= other.Unknown;
                    None |= other.None;
                    if (other.Methods != null) AddMethods(other.Methods);
                    if (other.Fields != null) foreach (var f in other.Fields) AddField(f);
                    if (other.Arrays != null) foreach (var a in other.Arrays) AddArray(a);
                    if (other.Addresses != null) foreach (var a in other.Addresses) AddAddress(a);
                    if (other.Args != null) foreach (var a in other.Args) AddArg(a);
                    if (other.Results != null) foreach (var r in other.Results) AddResult(r);
                }
            }

            // A call site where a delegate can go in (a parameter that can hold one) or come out (a result that can): its
            // caller, where it goes, and (once the caller's body is settled) what it hands each such parameter.
            private sealed class Site
            {
                public Site(int caller, List<int> targets) => (Caller, Targets) = (caller, targets);

                public int Caller { get; }

                public List<int> Targets { get; }

                public Prov?[]? Args { get; set; }
            }

            // A method or call as the stack sees it: what it pops and pushes, whether it runs a delegate, and which of its
            // arguments (`this` first) and result can hold a delegate.
            private sealed class Shape
            {
                public string Parent { get; init; } = string.Empty;

                public string Name { get; init; } = string.Empty;

                public int Params { get; init; }

                public int Pops { get; init; }

                public bool Void { get; init; } = true;

                // A delegate's Invoke, BeginInvoke or DynamicInvoke: the delegate's type.
                public string? Invoke { get; init; }

                public bool DelegateCtor { get; init; }

                // Delegate.Combine or Remove: the result is (part of) its arguments.
                public bool Combine { get; init; }

                public bool[]? Capable { get; init; }

                public bool CapableReturn { get; init; }

                // By argument: the delegate type handed (code outside the code read may run it).
                public string?[]? Delegates { get; init; }
            }

            private Shape ShapeOf(MetadataReader md, int m, EntityHandle handle)
            {
                if (handle.Kind == HandleKind.MethodSpecification) return ShapeOf(md, m, md.GetMethodSpecification((MethodSpecificationHandle)handle).Method);
                var key = (m, MetadataTokens.GetToken(handle));
                if (_shapes.TryGetValue(key, out var shape)) return shape;
                MethodSignature<string> signature;
                string parent, instance, name;
                switch (handle.Kind)
                {
                    case HandleKind.MethodDefinition:
                    {
                        var method = md.GetMethodDefinition((MethodDefinitionHandle)handle);
                        signature = method.DecodeSignature(Names.Instance, null);
                        parent = instance = FullName(md, method.GetDeclaringType());
                        name = md.GetString(method.Name);
                        break;
                    }
                    case HandleKind.MemberReference when md.GetMemberReference((MemberReferenceHandle)handle) is { } member && member.GetKind() == MemberReferenceKind.Method:
                        signature = member.DecodeMethodSignature(Names.Instance, null);
                        parent = ParentName(md, member.Parent) ?? string.Empty;
                        instance = member.Parent.Kind == HandleKind.TypeSpecification ? md.GetTypeSpecification((TypeSpecificationHandle)member.Parent).DecodeSignature(Names.Instance, null) : parent;
                        name = md.GetString(member.Name);
                        break;
                    default:
                        // Not a method the stack can size: the body can't be followed (fail closed).
                        return _shapes[key] = new Shape { Pops = -1 };
                }

                var instanceCall = signature.Header.IsInstance && !signature.Header.HasExplicitThis;
                var types = (instanceCall ? new[] { parent } : Array.Empty<string>()).Concat(signature.ParameterTypes).ToArray();
                var capable = types.Select((t, i) => !(instanceCall && i == 0) && Capable(t)).ToArray();
                var system = parent is "System.Delegate" or "System.MulticastDelegate";
                var isDelegate = !system && DelegateType(parent);
                string?[]? delegates = system || isDelegate ? null : types.Select((t, i) => !(instanceCall && i == 0) && Delegate(t) ? t : null).ToArray();
                return _shapes[key] = new Shape
                {
                    Parent = parent,
                    Name = name,
                    Params = signature.ParameterTypes.Length,
                    Pops = types.Length,
                    Void = signature.ReturnType == "System.Void",
                    Invoke = (isDelegate && name is "Invoke" or "BeginInvoke") || (system && name == "DynamicInvoke") ? instance : null,
                    DelegateCtor = isDelegate && name == ".ctor",
                    Combine = system && (name is "Combine" or "Remove") && signature.ParameterTypes.Length == 2,
                    Capable = capable.Any(c => c) ? capable : null,
                    CapableReturn = Capable(signature.ReturnType),
                    Delegates = delegates != null && delegates.Any(d => d != null) ? delegates : null,
                };
            }

            private bool CapableField(MetadataReader md, int m, EntityHandle handle)
            {
                var key = (m, MetadataTokens.GetToken(handle));
                if (_capableFields.TryGetValue(key, out var capable)) return capable;
                var type = handle.Kind switch
                {
                    HandleKind.FieldDefinition => md.GetFieldDefinition((FieldDefinitionHandle)handle).DecodeSignature(Names.Instance, null),
                    HandleKind.MemberReference => md.GetMemberReference((MemberReferenceHandle)handle).DecodeFieldSignature(Names.Instance, null),
                    _ => "System.Object",
                };
                return _capableFields[key] = Capable(type);
            }

            // Whether a value of this type can be a delegate: a delegate type, or a type every delegate is (object, Delegate,
            // ICloneable, ISerializable), or a generic parameter.
            private bool Capable(string type)
            {
                if (type.EndsWith('&') || type.EndsWith("[]", StringComparison.Ordinal) || type.EndsWith('*')) return false;
                if (type.StartsWith('!')) return true;
                return type is "System.Object" or "System.ICloneable" or "System.Runtime.Serialization.ISerializable" || Delegate(type);
            }

            private bool Delegate(string type)
            {
                if (type.EndsWith('&') || type.EndsWith("[]", StringComparison.Ordinal) || type.EndsWith('*') || type.StartsWith('!')) return false;
                var head = type.Split('<')[0];
                return DelegateType(head);
            }

            // One body's abstract evaluation stack (provenance only), read in a single forward pass: a snapshot at each
            // forward branch's target, merged where paths meet; an exception handler starts with one unknown (the
            // exception), a finally or fault with none; after an unconditional transfer the stack is the next instruction's
            // snapshot, or empty (ECMA-335 III.1.7.5). Anything inconsistent (a pop of an empty stack, heights that disagree,
            // values carried round a backward branch, a call the stack can't size) breaks the body: everything it records is
            // then unknown (fail closed). Round 18: it records the delegate-field stores, the array element stores (by
            // array), stores through addresses, and every value that ESCAPES (handed to a call, stored in a field or another
            // array, returned, its address taken): an array that escapes may be written where the reading doesn't follow, so
            // its elements are unknown.
            private sealed class Flow
            {
                // The opcodes that pop a value without letting it escape (a test, a comparison, an array access or length).
                private static readonly HashSet<short> Inert = new HashSet<short>
                {
                    OpCodes.Pop.Value, OpCodes.Ldlen.Value, OpCodes.Ceq.Value, OpCodes.Cgt.Value, OpCodes.Cgt_Un.Value, OpCodes.Clt.Value, OpCodes.Clt_Un.Value,
                }.Concat(Enumerable.Range(OpCodes.Ldelem_I1.Value, OpCodes.Stelem_Ref.Value - OpCodes.Ldelem_I1.Value + 1).Select(v => (short)v)).ToHashSet();

                // The stack height each instruction was read with, plus one (0: not read yet), by offset.
                private readonly int[] _heights;
                private Dictionary<int, List<Value>>? _snapshots;
                private List<Value> _stack = new();
                private bool _fallsThrough = true;

                public Flow(MethodBodyBlock body)
                {
                    _heights = new int[body.Size + 1];
                    foreach (var region in body.ExceptionRegions)
                    {
                        _snapshots ??= new Dictionary<int, List<Value>>();
                        _snapshots[region.HandlerOffset] = region.Kind is ExceptionRegionKind.Catch or ExceptionRegionKind.Filter ? new List<Value> { Value.Unknown } : new List<Value>();
                        if (region.Kind == ExceptionRegionKind.Filter) _snapshots[region.FilterOffset] = new List<Value> { Value.Unknown };
                    }
                }

                public bool Broken { get; private set; }

                public Dictionary<int, List<Value>> Locals { get; } = new();

                public Dictionary<int, List<Value>> Args { get; } = new();

                public List<(Value Array, Value Element)> Elements { get; } = new();

                public List<(string Field, Value Value)> Stores { get; } = new();

                public List<(Value Address, Value Value)> Indirect { get; } = new();

                public List<Value> Escapes { get; } = new();

                // The delegate fields whose address the body took.
                public HashSet<string> Addressed { get; } = new(StringComparer.Ordinal);

                public List<(Value Receiver, string Type)> Invokes { get; } = new();

                public List<(int Site, Value?[] Args)> Sites { get; } = new();

                public List<Value> Returns { get; } = new();

                public void Arrive(int offset)
                {
                    if (_snapshots != null && _snapshots.TryGetValue(offset, out var snapshot))
                    {
                        if (!_fallsThrough) _stack = snapshot.ToList();
                        else if (snapshot.Count != _stack.Count) Broken = true;
                        else for (var i = 0; i < _stack.Count; i++) _stack[i] = Value.Union(_stack[i], snapshot[i]);
                    }
                    else if (!_fallsThrough) _stack = new List<Value>();

                    _fallsThrough = true;
                    if (offset < _heights.Length) _heights[offset] = _stack.Count + 1;
                    else Broken = true;
                }

                public void End() => _fallsThrough = false;

                public void Break() => Broken = true;

                public void Clear() => _stack.Clear();

                public void Push(Value value) => _stack.Add(value);

                public Value Address(string field)
                {
                    Addressed.Add(field);
                    return Value.AddressOf(field);
                }

                public Value Peek()
                {
                    if (_stack.Count > 0) return _stack[^1];
                    Broken = true;
                    return Value.Unknown;
                }

                public Value Pop()
                {
                    var top = Peek();
                    if (_stack.Count > 0) _stack.RemoveAt(_stack.Count - 1);
                    return top;
                }

                public void Store(Dictionary<int, List<Value>> slots, int index, Value value)
                {
                    if (!slots.TryGetValue(index, out var stored)) slots[index] = stored = new List<Value>();
                    stored.Add(value);
                }

                // ldelem: the index, then the array.
                public void LoadElement()
                {
                    Pop();
                    Push(Value.Element(Pop()));
                }

                // stelem: the value, the index, the array.
                public void StoreElement()
                {
                    var element = Pop();
                    Pop();
                    Elements.Add((Pop(), element));
                }

                // stind.ref, stobj: the value, then the address.
                public void StoreIndirect()
                {
                    var stored = Pop();
                    Indirect.Add((Pop(), stored));
                    Escapes.Add(stored);
                }

                // A branch: a forward target takes a snapshot (merged with others); a backward one must meet the height it
                // was read with, and carry nothing (its values would need a second pass).
                public void Branch(int from, int target)
                {
                    if (target <= from)
                    {
                        if (target < 0 || _heights[target] != _stack.Count + 1 || _stack.Count > 0) Broken = true;
                        return;
                    }

                    _snapshots ??= new Dictionary<int, List<Value>>();
                    if (!_snapshots.TryGetValue(target, out var snapshot)) _snapshots[target] = _stack.ToList();
                    else if (snapshot.Count != _stack.Count) Broken = true;
                    else for (var i = 0; i < snapshot.Count; i++) snapshot[i] = Value.Union(snapshot[i], _stack[i]);
                }

                // An instruction with no effect on delegates: its pops (which escape, but for a test, a comparison or an
                // array access), then its pushes (a number is no delegate; anything else is unknown).
                public void Generic(OpCode code)
                {
                    var pops = code.StackBehaviourPop switch
                    {
                        StackBehaviour.Pop0 => 0,
                        StackBehaviour.Pop1 or StackBehaviour.Popi or StackBehaviour.Popref => 1,
                        StackBehaviour.Pop1_pop1 or StackBehaviour.Popi_pop1 or StackBehaviour.Popi_popi or StackBehaviour.Popi_popi8 or StackBehaviour.Popi_popr4
                            or StackBehaviour.Popi_popr8 or StackBehaviour.Popref_pop1 or StackBehaviour.Popref_popi => 2,
                        StackBehaviour.Popi_popi_popi or StackBehaviour.Popref_popi_popi or StackBehaviour.Popref_popi_popi8 or StackBehaviour.Popref_popi_popr4
                            or StackBehaviour.Popref_popi_popr8 or StackBehaviour.Popref_popi_popref or StackBehaviour.Popref_popi_pop1 => 3,
                        _ => -1,
                    };
                    if (pops < 0) Broken = true;
                    var inert = code.FlowControl == FlowControl.Cond_Branch || Inert.Contains(code.Value);
                    for (var i = 0; i < pops; i++)
                    {
                        var popped = Pop();
                        if (!inert) Escapes.Add(popped);
                    }

                    switch (code.StackBehaviourPush)
                    {
                        case StackBehaviour.Push0:
                            break;
                        case StackBehaviour.Pushi or StackBehaviour.Pushi8 or StackBehaviour.Pushr4 or StackBehaviour.Pushr8:
                            Push(Value.None);
                            break;
                        case StackBehaviour.Push1 or StackBehaviour.Pushref:
                            Push(Value.Unknown);
                            break;
                        default:
                            Broken = true;
                            break;
                    }
                }

                // What locals, arguments written to and array elements can hold, and which arrays and field addresses
                // escaped, to a fixed point (they feed each other).
                public Within Within()
                {
                    var within = new Within();
                    foreach (var i in Locals.Keys) within.LocalProv[i] = new Prov();
                    foreach (var i in Args.Keys) within.ArgProv[i] = new Prov();
                    bool changed;
                    do
                    {
                        changed = false;
                        foreach (var (i, stored) in Locals) foreach (var v in stored) changed |= within.Into(within.LocalProv[i], v);
                        foreach (var (i, stored) in Args) foreach (var v in stored) changed |= within.Into(within.ArgProv[i], v);
                        foreach (var (array, element) in Elements)
                        {
                            var into = within.Of(array);
                            // Stored in an array the body didn't make (or may not have): the value escapes with it.
                            if (into.Foreign) changed |= within.Escape(element);
                            foreach (var a in into.Arrays ?? Enumerable.Empty<int>()) changed |= within.Into(within.ElementOf(a), element);
                        }

                        foreach (var v in Escapes) changed |= within.Escape(v);
                        // An array kept in an array that escaped escapes too.
                        foreach (var a in within.Escaped.ToList())
                            foreach (var inner in within.ElementOf(a).Arrays?.ToList() ?? new List<int>())
                                changed |= within.Escaped.Add(inner);
                    }
                    while (changed);
                    return within;
                }
            }

            private sealed class Within
            {
                public Dictionary<int, Prov> LocalProv { get; } = new();

                public Dictionary<int, Prov> ArgProv { get; } = new();

                // By allocation: what the body stored in that array.
                public Dictionary<int, Prov> ElementProv { get; } = new();

                public HashSet<int> Escaped { get; } = new();

                public HashSet<string> EscapedAddresses { get; } = new(StringComparer.Ordinal);

                public Prov ElementOf(int allocation) => ElementProv.TryGetValue(allocation, out var prov) ? prov : ElementProv[allocation] = new Prov();

                // A value escaped: its arrays and delegate-field addresses; true when that grew.
                public bool Escape(Value value)
                {
                    var prov = Of(value);
                    var changed = false;
                    foreach (var a in prov.Arrays ?? Enumerable.Empty<int>()) changed |= Escaped.Add(a);
                    foreach (var f in prov.Addresses ?? Enumerable.Empty<string>()) changed |= EscapedAddresses.Add(f);
                    return changed;
                }

                public Prov Of(Value value)
                {
                    var prov = new Prov();
                    Into(prov, value);
                    return prov;
                }

                // Adds what value can be to prov; true when prov grew.
                public bool Into(Prov prov, Value value) => Into(prov, value, null);

                private bool Into(Prov prov, Value value, HashSet<Value>? seen)
                {
                    var before = prov.Size;
                    switch (value.Kind)
                    {
                        case ValueKind.Unknown:
                            prov.Unknown = true;
                            break;
                        case ValueKind.None:
                            prov.None = true;
                            break;
                        case ValueKind.Pointer:
                            if (value.Nodes!.Count == 0) prov.None = true;
                            else prov.AddMethods(value.Nodes);
                            break;
                        case ValueKind.Field:
                            prov.AddField(value.Name!);
                            break;
                        case ValueKind.Address:
                            prov.AddAddress(value.Name!);
                            break;
                        case ValueKind.Array:
                            prov.AddArray(value.Index);
                            break;
                        case ValueKind.Arg:
                            prov.AddArg(value.Index);
                            if (ArgProv.TryGetValue(value.Index, out var written)) prov.Add(written);
                            break;
                        case ValueKind.Local:
                            // A local nothing stores (read before any store; the runtime zeroes it): null.
                            if (LocalProv.TryGetValue(value.Index, out var local)) prov.Add(local);
                            else prov.None = true;
                            break;
                        case ValueKind.Result:
                            prov.AddResult(value.Index);
                            break;
                        case ValueKind.Element:
                        {
                            // An element of an array the body made and kept to itself: what the body stored in it; of any
                            // other (an argument, a field's, a call's result, one that escaped): unknown.
                            var array = Of(value.A!);
                            if (array.Foreign) prov.Unknown = true;
                            foreach (var a in array.Arrays ?? Enumerable.Empty<int>())
                                if (Escaped.Contains(a)) prov.Unknown = true;
                                else prov.Add(ElementOf(a));
                            break;
                        }
                        case ValueKind.Union:
                            seen ??= new HashSet<Value>(ReferenceEqualityComparer.Instance);
                            if (!seen.Add(value)) break;
                            Into(prov, value.A!, seen);
                            Into(prov, value.B!, seen);
                            break;
                    }

                    return prov.Size > before;
                }
            }

            // Where a delegate value can come from, resolved across methods: the methods it may run (a pointer's, or a
            // synthetic node: an unresolved call it came out of), the delegate fields it was loaded from, and where its
            // provenance is lost (the method, and why). Found: anything was seen at all (none included).
            private sealed class Src
            {
                public bool Found { get; set; }

                public HashSet<int>? Nodes { get; private set; }

                public HashSet<string>? Fields { get; private set; }

                public HashSet<(int Node, string Where)>? Lost { get; private set; }

                public void AddNodes(IEnumerable<int> nodes)
                {
                    Found = true;
                    (Nodes ??= new HashSet<int>()).UnionWith(nodes);
                }

                public void AddField(string field)
                {
                    Found = true;
                    (Fields ??= new HashSet<string>(StringComparer.Ordinal)).Add(field);
                }

                public void Lose(int node, string where)
                {
                    Found = true;
                    (Lost ??= new HashSet<(int, string)>()).Add((node, where));
                }

                public void Add(Src other) => Merge(other);

                // Adds other's sources; true when anything was new.
                public bool Merge(Src other)
                {
                    if (ReferenceEquals(other, this)) return false;
                    var grew = other.Found && !Found;
                    Found |= other.Found;
                    if (other.Nodes != null) foreach (var n in other.Nodes) grew |= (Nodes ??= new HashSet<int>()).Add(n);
                    if (other.Fields != null) foreach (var f in other.Fields) grew |= (Fields ??= new HashSet<string>(StringComparer.Ordinal)).Add(f);
                    if (other.Lost != null) foreach (var l in other.Lost) grew |= (Lost ??= new HashSet<(int, string)>()).Add(l);
                    return grew;
                }
            }

            // Round 19: what a method returns, as a function of its arguments: what it returns whatever they are (Src, its
            // losses attributed where the summary is used), and which of its own arguments it may return.
            private sealed class Summary
            {
                public Src Src { get; } = new();

                public HashSet<int> Args { get; } = new();
            }

            // Round 18: every delegate invocation read, judged by where its delegate came from (Sources, the same model as a
            // delegate field's stores). What the reading made or loaded from a delegate field is followed already (its edge
            // is where it was made or loaded, so the reading stays as precise per action as before); where the provenance is
            // lost (handed in from outside the code read, an unknown, an escaped container), an unresolved callback judged by
            // the delegate's type (round 11), at the method where it is lost: the one handed it from outside, or the one
            // holding the unknown.
            private void Invocations()
            {
                foreach (var (node, receiver, type) in _invokes)
                    foreach (var (at, where) in Sources(receiver, node).Lost ?? Enumerable.Empty<(int, string)>())
                        Attach(at, type, where);
            }

            // The sources of a value's provenance in the method that holds it (a store's or an invocation's): what it is in
            // that method (Walk), and for each of the method's own arguments it may be, what the callers hand it (Up).
            private Src Sources(Prov prov, int node)
            {
                var (sources, args) = Walk(prov, node, node, -1);
                foreach (var i in args) sources.Add(Up(node, i));
                return sources;
            }

            // Round 19 (4a-r19-3): what a provenance in method m can be, across methods, as a monotone union (no cut, no depth
            // bound, no edge dropped): the methods (pointers), delegate fields and losses it reaches (losses attributed to
            // `at`; a summary keeps them unattributed, at -1), and which of m's own arguments it may be. What a call returns is
            // its target's Summary, with the target's arguments bound to that site's (each (site, argument) once: the union
            // is the same however often it is reached). reader: the method whose summary this is (it reads the targets').
            private (Src Sources, HashSet<int> Args) Walk(Prov prov, int m, int at, int reader)
            {
                var sources = new Src();
                var args = new HashSet<int>();
                var seen = new HashSet<Prov>(ReferenceEqualityComparer.Instance);
                var bound = new HashSet<(int Site, int Arg)>();
                var stack = new Stack<Prov>();
                stack.Push(prov);
                while (stack.Count > 0)
                {
                    var p = stack.Pop();
                    if (!seen.Add(p)) continue;
                    if (p.None || p.Arrays != null || p.Addresses != null) sources.Found = true;
                    if (p.Methods != null) sources.AddNodes(p.Methods);
                    if (p.Fields != null) foreach (var f in p.Fields) sources.AddField(f);
                    if (p.Unknown) sources.Lose(at, "of unknown origin in " + _nodes[m].Name);
                    if (p.Args != null) args.UnionWith(p.Args);
                    foreach (var s in p.Results ?? Enumerable.Empty<int>())
                    {
                        var site = _sites[s];
                        if (site.Targets.Count == 0)
                        {
                            sources.Lose(at, "returned from outside the code read in " + _nodes[m].Name);
                            continue;
                        }

                        foreach (var t in site.Targets.Distinct())
                        {
                            var target = _nodes[t];
                            if (target.Type < 0)
                            {
                                // A user change or an unresolved call: what it hands back is that node (reached already by the
                                // call; a field holding it reaches it too). A shared slot's result isn't followed.
                                if (target.Reaches != null || target.PersonReaches != null || target.Unresolved != null || target.Callback != null) sources.AddNodes(new[] { t });
                                else sources.Lose(at, "returned by " + target.Name);
                                continue;
                            }

                            // An abstract target's implementations are targets too.
                            if (target.Abstract) continue;
                            if (_summaries.TryGetValue(t, out var summary))
                            {
                                if (reader >= 0)
                                {
                                    if (!_readers.TryGetValue(t, out var readers)) _readers[t] = readers = new HashSet<int>();
                                    readers.Add(reader);
                                }

                                if (summary.Src.Found) sources.Found = true;
                                if (summary.Src.Nodes != null) sources.AddNodes(summary.Src.Nodes);
                                if (summary.Src.Fields != null) foreach (var f in summary.Src.Fields) sources.AddField(f);
                                if (summary.Src.Lost != null) foreach (var (_, where) in summary.Src.Lost) sources.Lose(at, where);
                                foreach (var j in summary.Args)
                                    if (bound.Add((s, j))) stack.Push(Given(site, j));
                            }
                            else if (target.HasBody) sources.Found = true;
                            else sources.Lose(at, "of unknown origin in " + target.Name);
                        }
                    }
                }

                return (sources, args);
            }

            // Round 19: every method's Summary, to the least fixed point: each starts empty, a method whose summary grew
            // re-reads its readers (Walk records them), until nothing changes (sets only grow; finite, so it ends). A
            // recursive return, one through a cycle of methods and one rotating its arguments are all followed to the end.
            private void Summaries()
            {
                foreach (var t in _returns.Keys) _summaries[t] = new Summary();
                var queue = new Queue<int>(_returns.Keys);
                var queued = new HashSet<int>(_returns.Keys);
                while (queue.Count > 0)
                {
                    var t = queue.Dequeue();
                    queued.Remove(t);
                    var (sources, args) = Walk(_returns[t], t, -1, t);
                    var summary = _summaries[t];
                    var grew = summary.Src.Merge(sources);
                    foreach (var a in args) grew |= summary.Args.Add(a);
                    if (grew && _readers.TryGetValue(t, out var readers))
                        foreach (var r in readers)
                            if (queued.Add(r)) queue.Enqueue(r);
                }
            }

            private static Prov Given(Site site, int arg) => site.Args is { } args && arg < args.Length && args[arg] is { } given ? given : Prov.Untracked;

            // What the callers hand a method's argument: each call site's value, read in its caller, argument by argument
            // (4a-r18-1: never "what the caller made before the call"). No caller in the code read: handed in from outside
            // (lost at the method). Round 19: a union system over (method, argument), solved whole: the parameters that feed
            // each other form a strongly connected group (Tarjan, iterative: no depth bound), all with the same sources (the
            // union of every member's and of what feeds the group); when nothing outside the group feeds it, it was handed in
            // from outside the code read (4a-behaviour-r17-2).
            private Src Up(int node, int arg)
            {
                var root = (node, arg);
                if (_upDone.TryGetValue(root, out var done)) return done;
                var index = new Dictionary<(int, int), int>();
                var low = new Dictionary<(int, int), int>();
                var local = new Dictionary<(int, int), (Src Sources, List<(int, int)> Feeds)>();
                var group = new Stack<(int, int)>();
                var open = new HashSet<(int, int)>();
                var work = new Stack<((int Node, int Arg) Key, int Next)>();
                void Enter((int Node, int Arg) key)
                {
                    low[key] = index.Count;
                    index[key] = index.Count;
                    group.Push(key);
                    open.Add(key);
                    local[key] = Callers(key.Node, key.Arg);
                    work.Push((key, 0));
                }

                Enter(root);
                while (work.Count > 0)
                {
                    var (key, next) = work.Pop();
                    var feeds = local[key].Feeds;
                    if (next < feeds.Count)
                    {
                        work.Push((key, next + 1));
                        var feed = feeds[next];
                        if (_upDone.ContainsKey(feed)) continue;
                        if (!index.ContainsKey(feed)) Enter(feed);
                        else if (open.Contains(feed)) low[key] = Math.Min(low[key], index[feed]);
                        continue;
                    }

                    if (low[key] == index[key])
                    {
                        var members = new List<(int, int)>();
                        (int, int) member;
                        do
                        {
                            member = group.Pop();
                            open.Remove(member);
                            members.Add(member);
                        }
                        while (member != key);
                        var all = new Src();
                        foreach (var m in members)
                        {
                            all.Add(local[m].Sources);
                            foreach (var feed in local[m].Feeds)
                                if (_upDone.TryGetValue(feed, out var fed)) all.Add(fed);
                        }

                        if (!all.Found) all.Lose(key.Node, "handed to " + _nodes[key.Node].Name + " from outside the code read (its callers are a cycle no code read enters)");
                        foreach (var m in members) _upDone[m] = all;
                    }

                    if (work.Count > 0)
                    {
                        var parent = work.Peek().Key;
                        low[parent] = Math.Min(low[parent], low[key]);
                    }
                }

                return _upDone[root];
            }

            // One parameter's own sources: what each call site hands it, read in the caller (Walk), and the caller's arguments
            // that value may be (which feed it: Up solves them together).
            private (Src Sources, List<(int, int)> Feeds) Callers(int node, int arg)
            {
                var sources = new Src();
                var feeds = new List<(int, int)>();
                if (!_sitesOf.TryGetValue(node, out var sites) || sites.Count == 0)
                {
                    sources.Lose(node, "handed to " + _nodes[node].Name + " from outside the code read");
                    return (sources, feeds);
                }

                foreach (var s in sites)
                {
                    var site = _sites[s];
                    var (found, args) = Walk(Given(site, arg), site.Caller, site.Caller, -1);
                    sources.Add(found);
                    foreach (var a in args) feeds.Add((site.Caller, a));
                }

                return (sources, feeds);
            }

            // An unresolved callback at the method where the delegate's provenance is lost, judged by the delegate's type.
            private void Attach(int node, string type, string where)
            {
                var callback = !UserContract(new[] { type }, null);
                _nodes[node].Calls.Add(Unresolved(ShortType(type) + " " + where, callback: callback));
            }

            private static string ShortType(string type)
                => System.Text.RegularExpressions.Regex.Replace(System.Text.RegularExpressions.Regex.Replace(Unescape(type), @"[A-Za-z_][A-Za-z0-9_]*\.", string.Empty), @"`\d+", string.Empty);

            // A name from a signature (Names) as the metadata writes it.
            private static string Unescape(string name) => name.Replace('\u2039', '<').Replace('\u203a', '>');

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

            // Round 11: whether a member outside the code read hands back code to run: its result (a Task's included) or a
            // by-reference parameter is a delegate.
            private bool HandsBackCallback(MethodSignature<string> signature)
                => CarriesDelegate(signature.ReturnType) || signature.ParameterTypes.Any(t => t.EndsWith('&') && CarriesDelegate(t));

            private bool HandsBackCallback(Node node)
                => node.Module >= 0 && HandsBackCallback(_modules[node.Module].Md.GetMethodDefinition(MetadataTokens.MethodDefinitionHandle(node.Token)).DecodeSignature(Names.Instance, null));

            private bool CarriesDelegate(string type)
                => type.Split(new[] { '<', '>', ',', '[', ']', '&', '*', ' ' }, StringSplitOptions.RemoveEmptyEntries).Any(DelegateType);

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

                // Round 19: a compiler-generated name's angle brackets (`<>c`, `<>f__AnonymousDelegate0`) are escaped, so the
                // signature's own brackets (generic arguments) are the only ones a split on them sees (Unescape restores them).
                public string GetTypeFromDefinition(MetadataReader reader, TypeDefinitionHandle handle, byte rawTypeKind) => Escape(FullName(reader, handle));

                public string GetTypeFromReference(MetadataReader reader, TypeReferenceHandle handle, byte rawTypeKind) => Escape(FullName(reader, handle));

                private static string Escape(string name) => name.Replace('<', '\u2039').Replace('>', '\u203a');

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

                // Round 15: a function pointer (`delegate*`) is stored and invoked (calli) like a delegate. Round 17: so is a
                // field typed by a generic parameter (`T`): it can hold a delegate in a constructed use.
                if (code is not (SignatureTypeCode.FunctionPointer or SignatureTypeCode.GenericTypeParameter or SignatureTypeCode.GenericMethodParameter))
                {
                    if (code == SignatureTypeCode.GenericTypeInstance) code = blob.ReadSignatureTypeCode();
                    if (code is not (SignatureTypeCode.TypeHandle or (SignatureTypeCode)0x12 or (SignatureTypeCode)0x11)) return null;
                    var typeName = ParentName(md, blob.ReadTypeHandle());
                    if (typeName == null || !DelegateType(typeName)) return null;
                }
                var key = owner + "::" + name;
                if (!_fieldTypes.ContainsKey(key))
                    _fieldTypes[key] = handle.Kind == HandleKind.FieldDefinition
                        ? md.GetFieldDefinition((FieldDefinitionHandle)handle).DecodeSignature(Names.Instance, null)
                        : md.GetMemberReference((MemberReferenceHandle)handle).DecodeFieldSignature(Names.Instance, null);
                return key;
            }

            // Round 19: a delegate type is one whose base is System.MulticastDelegate (ECMA-335 II.14.6), wherever it is
            // defined: the code read's, or .NET's and a library's read from their metadata (TimerCallback, RequestDelegate).
            // One that can't be read may be a delegate (fail closed). A primitive (a signature's own code) is none.
            private bool DelegateType(string name)
            {
                name = Unescape(name);
                if (name.StartsWith("System.Func`", StringComparison.Ordinal) || name.StartsWith("System.Action", StringComparison.Ordinal)
                    || name is "System.Predicate`1" or "System.Comparison`1" or "System.Converter`2" or "System.EventHandler" or "System.EventHandler`1" or "System.Delegate" or "System.MulticastDelegate")
                    return true;
                if (Primitives.Contains(name) || name.StartsWith('!')) return false;
                if (_typesByName.TryGetValue(name, out var ids)) return ids.Any(t => _types[t].Base?.Name is "System.MulticastDelegate");
                var t = TypeId(name, null);
                if (t >= 0) return _types[t].Base?.Name is "System.MulticastDelegate";
                _gaps.Add(name + " in " + (_refs.GetValueOrDefault(name) ?? "an assembly it doesn't name") + " can't be read: it may be a delegate");
                return true;
            }

            // The names a signature gives its primitive types (Names.GetPrimitiveType), and a function pointer's.
            private static readonly HashSet<string> Primitives = Enum.GetNames<PrimitiveTypeCode>().Select(n => "System." + n).Append("fnptr").ToHashSet(StringComparer.Ordinal);

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

            // Round 17: the shared node for a virtual slot declared outside the code read: it reaches every method of the code
            // read that fills it. Null when nothing read fills it. Round 19: the fills are the one fill rule's (SlotFills:
            // the complete ancestry, an inherited implementation, a framework intermediate base, static slots by static
            // methods), reached as a call of them would be (Mapped).
            private int? FrameworkSlot(string type, string method, int count, bool isStatic)
            {
                // A stated limit: object-lifecycle slots (disposal, finalization, ToString/Equals/GetHashCode) declared
                // outside the code read aren't followed into implementations. A call site can't tell WHICH object it
                // disposes, so the slot would reach every Dispose in Jellyfin and their event chains, bracketing ordinary
                // actions (playback pings, display preferences) for nothing; Jellyfin's own lifecycle members change no user
                // (reviewed in 12.2 and 10.11.11; pinned sets). Jellyfin's user events cover a plugin that would.
                if (LifecycleMembers.Contains(method)) return null;
                if (_frameworkSlots.TryGetValue((type, method, count, isStatic), out var cached)) return cached;
                // A compiler-generated state machine (the type an async method's or iterator's [*StateMachine] attribute
                // names) is no fill: its code is followed from the method that creates it, the only code that can hand one
                // out, so a hand-written enumerator is followed through IEnumerator.MoveNext and the state machines of
                // Jellyfin's iterators aren't (each foreach would otherwise reach every one of them). Stated limit: a lazy
                // sequence created by one action and enumerated by another counts where it is created.
                var fills = Mapped(SlotFills(type, method, count, isStatic));
                if (fills.Count == 0)
                {
                    _frameworkSlots[(type, method, count, isStatic)] = null;
                    return null;
                }

                var id = _nodes.Count;
                _nodes.Add(new Node { Name = "slot " + Simple(type) + "." + method });
                _frameworkSlots[(type, method, count, isStatic)] = id;
                _nodes[id].Calls.AddRange(fills);
                return id;
            }

            // ------------------------------------------------------------------ the complete ancestry (round 19)

            // A type as a reference names it: its full name and the assembly (simple name) it is in.
            private readonly record struct TypeRef(string Name, string? Assembly);

            // A type's complete ancestry: its base classes (nearest first) and every interface it implements (its own, its
            // bases', their base interfaces), whether or not the code read defines them; Incomplete: a step couldn't be read.
            private sealed class Lineage
            {
                public List<int> Bases { get; } = new();

                public List<int> Interfaces { get; } = new();

                public bool Incomplete { get; set; }
            }

            private Lineage LineageOf(int t)
            {
                if (_lineages.TryGetValue(t, out var cached)) return cached;
                var lineage = new Lineage();
                _lineages[t] = lineage;
                var visited = new HashSet<int> { t };
                for (var current = t; _types[current].Base is { } b;)
                {
                    var next = TypeId(b.Name, b.Assembly);
                    if (next < 0)
                    {
                        lineage.Incomplete = true;
                        _gaps.Add(_types[current].Name + ": its base " + Unread(b));
                        break;
                    }

                    // A cycle is malformed metadata: the chain read so far.
                    if (!visited.Add(next)) break;
                    lineage.Bases.Add(next);
                    current = next;
                }

                var seen = new HashSet<int>();
                var queue = new Queue<int>(lineage.Bases.Prepend(t));
                while (queue.Count > 0)
                {
                    var current = queue.Dequeue();
                    foreach (var i in _types[current].Interfaces)
                    {
                        var id = TypeId(i.Name, i.Assembly);
                        if (id < 0)
                        {
                            lineage.Incomplete = true;
                            _gaps.Add(_types[current].Name + ": its interface " + Unread(i));
                        }
                        else if (seen.Add(id))
                        {
                            lineage.Interfaces.Add(id);
                            queue.Enqueue(id);
                        }
                    }
                }

                return lineage;
            }

            private static string Unread(TypeRef type) => (type.Name.Length == 0 ? "(a type it can't name)" : type.Name) + " in " + (type.Assembly ?? "an assembly it doesn't name") + " can't be read";

            // Whether a type is an interface; null when it can't be read.
            private bool? IsInterface(string name)
            {
                var t = TypeId(name, null);
                return t < 0 ? null : _types[t].Interface;
            }

            // A type by name: the code read's, else (round 19) read from the metadata of the assembly that defines it, found
            // by the assembly its reference names (and the type forwarders on the way); -1 when it can't be read.
            private int TypeId(string name, string? assembly)
            {
                if (_typesByName.TryGetValue(name, out var ids)) return ids[0];
                if (name.Length == 0 || _unreadable.Contains(name)) return -1;
                assembly ??= _refs.GetValueOrDefault(name);
                var hops = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                while (assembly != null && hops.Add(assembly) && AssemblyFile(assembly) is { } file && ReadOutside(file) is { } outside)
                {
                    if (outside.Types.TryGetValue(name, out var shape))
                    {
                        var info = new TypeInfo { Name = name, Interface = shape.Interface, Base = shape.Base, External = true, File = file };
                        info.Interfaces.AddRange(shape.Interfaces);
                        _typesByName[name] = new List<int> { _types.Count };
                        _types.Add(info);
                        return _types.Count - 1;
                    }

                    assembly = outside.Forwarded.GetValueOrDefault(name);
                }

                _unreadable.Add(name);
                return -1;
            }

            // An assembly's file by simple name: the code read's folders first (Jellyfin's holds its libraries), then the
            // runtime's (the trusted platform assemblies, the runtime's folder).
            private string? AssemblyFile(string name)
            {
                if (_assemblyFiles == null)
                {
                    _assemblyFiles = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
                    foreach (var folder in _folders.Where(Directory.Exists))
                        foreach (var file in Directory.EnumerateFiles(folder, "*.dll").OrderBy(f => f, StringComparer.Ordinal))
                            _assemblyFiles.TryAdd(Path.GetFileNameWithoutExtension(file), file);
                    foreach (var file in (AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string ?? string.Empty).Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries))
                        _assemblyFiles.TryAdd(Path.GetFileNameWithoutExtension(file), file);
                    var runtime = System.Runtime.InteropServices.RuntimeEnvironment.GetRuntimeDirectory();
                    if (Directory.Exists(runtime))
                        foreach (var file in Directory.EnumerateFiles(runtime, "*.dll").OrderBy(f => f, StringComparer.Ordinal))
                            _assemblyFiles.TryAdd(Path.GetFileNameWithoutExtension(file), file);
                }

                return _assemblyFiles.GetValueOrDefault(name);
            }

            // Whether a type outside the code read declares a method (name, parameter count): read from its assembly's
            // metadata when asked (rare: a base outside the code read met while looking for a method up a chain), once per
            // type per reading. One that can't be read declares it (the search ends: nothing of the code read is assumed).
            private bool Declares(int t, string name, int count)
            {
                var type = _types[t];
                if (!_declared.TryGetValue(type.Name, out var methods))
                {
                    methods = null;
                    try
                    {
                        using var pe = new PEReader(System.IO.File.OpenRead(type.File!));
                        var md = pe.GetMetadataReader();
                        // Every type of that file at once (the next one asked is likely there too).
                        foreach (var handle in md.TypeDefinitions)
                        {
                            var declared = new HashSet<(string, int)>();
                            foreach (var m in md.GetTypeDefinition(handle).GetMethods())
                            {
                                var method = md.GetMethodDefinition(m);
                                declared.Add((md.GetString(method.Name), ParamCount(md, method.Signature)));
                            }

                            var other = FullName(md, handle);
                            if (_typesByName.TryGetValue(other, out var ids) && _types[ids[0]].External && _types[ids[0]].File == type.File) _declared.TryAdd(other, declared);
                            if (other == type.Name) methods = declared;
                        }
                    }
                    catch (Exception e) when (e is BadImageFormatException or IOException or UnauthorizedAccessException or InvalidOperationException or ArgumentException)
                    {
                        methods = null;
                    }

                    _declared[type.Name] = methods;
                }

                return methods == null || methods.Contains((name, count));
            }

            // What an assembly outside the code read says about its types' ancestry, METADATA ONLY: each type's kind, base
            // type and interfaces, and the types it forwards. Never a body, never loaded. Shared by the readings running or
            // close together (keyed by the file's path, size and time), held only by them (a weak reference: Jellyfin reads
            // its controllers once, and keeps none of this afterwards); no methods (Declares reads those when asked).
            private sealed record OutsideType(bool Interface, TypeRef? Base, TypeRef[] Interfaces);

            private sealed class Outside
            {
                public Dictionary<string, OutsideType> Types { get; } = new(StringComparer.Ordinal);

                public Dictionary<string, string> Forwarded { get; } = new(StringComparer.Ordinal);
            }

            private static readonly ConcurrentDictionary<(string Path, long Length, DateTime Written), WeakReference<Outside>> Outsides = new();

            // The assemblies outside the code read this reading uses (it holds them while it runs).
            private readonly Dictionary<string, Outside?> _outsides = new(StringComparer.Ordinal);

            private Outside? ReadOutside(string path)
            {
                if (_outsides.TryGetValue(path, out var held)) return held;
                FileInfo info;
                try
                {
                    info = new FileInfo(path);
                    if (!info.Exists) return null;
                }
                catch (Exception e) when (e is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException)
                {
                    return null;
                }

                var key = (info.FullName, info.Length, info.LastWriteTimeUtc);
                if (!Outsides.TryGetValue(key, out var weak) || !weak.TryGetTarget(out var outside))
                {
                    outside = ReadOutsideNow(info.FullName);
                    if (outside != null) Outsides[key] = new WeakReference<Outside>(outside);
                }

                return _outsides[path] = outside;
            }

            private static Outside? ReadOutsideNow(string path)
            {
                try
                {
                    using var pe = new PEReader(File.OpenRead(path));
                    if (!pe.HasMetadata) return null;
                    var md = pe.GetMetadataReader();
                    var self = AssemblyName(md) ?? Path.GetFileNameWithoutExtension(path);
                    var outside = new Outside();
                    foreach (var handle in md.TypeDefinitions)
                    {
                        var type = md.GetTypeDefinition(handle);
                        var interfaces = type.GetInterfaceImplementations().Select(i => Locate(md, md.GetInterfaceImplementation(i).Interface, self)).ToArray();
                        outside.Types.TryAdd(FullName(md, handle), new OutsideType((type.Attributes & TypeAttributes.Interface) != 0, type.BaseType.IsNil ? null : Locate(md, type.BaseType, self), interfaces));
                    }

                    foreach (var handle in md.ExportedTypes)
                    {
                        var exported = md.GetExportedType(handle);
                        var implementation = exported.Implementation;
                        while (implementation.Kind == HandleKind.ExportedType) implementation = md.GetExportedType((ExportedTypeHandle)implementation).Implementation;
                        if (implementation.Kind == HandleKind.AssemblyReference)
                            outside.Forwarded.TryAdd(ExportedName(md, exported), md.GetString(md.GetAssemblyReference((AssemblyReferenceHandle)implementation).Name));
                    }

                    return outside;
                }
                catch (Exception e) when (e is BadImageFormatException or IOException or UnauthorizedAccessException or InvalidOperationException or ArgumentException)
                {
                    return null;
                }
            }

            private static string ExportedName(MetadataReader md, ExportedType exported)
            {
                var name = md.GetString(exported.Name);
                if (exported.Implementation.Kind == HandleKind.ExportedType) return ExportedName(md, md.GetExportedType((ExportedTypeHandle)exported.Implementation)) + "+" + name;
                var space = md.GetString(exported.Namespace);
                return space.Length == 0 ? name : space + "." + name;
            }

            private static string? AssemblyName(MetadataReader md) => md.IsAssembly ? md.GetString(md.GetAssemblyDefinition().Name) : null;

            // A base or interface as a reference: its name and assembly (a type the module defines: the module's own; a
            // generic instantiation: its generic type's). An empty name when it can't be named (an unreadable step).
            private static TypeRef Locate(MetadataReader md, EntityHandle handle, string? self)
            {
                switch (handle.Kind)
                {
                    case HandleKind.TypeDefinition:
                        return new TypeRef(FullName(md, (TypeDefinitionHandle)handle), self);
                    case HandleKind.TypeReference:
                        return new TypeRef(FullName(md, (TypeReferenceHandle)handle), Scope(md, (TypeReferenceHandle)handle) ?? self);
                    case HandleKind.TypeSpecification:
                    {
                        var blob = md.GetBlobReader(md.GetTypeSpecification((TypeSpecificationHandle)handle).Signature);
                        if (blob.ReadSignatureTypeCode() != SignatureTypeCode.GenericTypeInstance) break;
                        blob.ReadSignatureTypeCode();
                        return Locate(md, blob.ReadTypeHandle(), self);
                    }
                }

                return new TypeRef(string.Empty, self);
            }

            // The assembly a type reference names (through its declaring types' references); null: the module itself.
            private static string? Scope(MetadataReader md, TypeReferenceHandle handle)
            {
                var scope = md.GetTypeReference(handle).ResolutionScope;
                while (scope.Kind == HandleKind.TypeReference) scope = md.GetTypeReference((TypeReferenceHandle)scope).ResolutionScope;
                return scope.Kind == HandleKind.AssemblyReference ? md.GetString(md.GetAssemblyReference((AssemblyReferenceHandle)scope).Name) : null;
            }

            // A type's static constructors in the code read (the runtime runs one before the type's first use).
            private IEnumerable<int> TypeInitializers(string? type)
            {
                if (type == null || !_typesByName.TryGetValue(type, out var ids)) yield break;
                foreach (var t in ids)
                    foreach (var n in _types[t].Methods)
                        if (_nodes[n].Method == ".cctor") yield return n;
            }

            // The initializers of the modules that define a type (the runtime runs one before any access to the module).
            private IEnumerable<int> ModuleInitializers(string? type)
            {
                if (type == null || !_typesByName.TryGetValue(type, out var ids)) yield break;
                foreach (var id in ids.Select(t => _types[t].Module).Distinct())
                    if (_moduleInitializers.TryGetValue(id, out var init)) yield return init;
            }

            // The type a called method or method pointer belongs to.
            private string? MethodOwner(MetadataReader md, int m, EntityHandle handle) => handle.Kind switch
            {
                HandleKind.MethodSpecification => MethodOwner(md, m, md.GetMethodSpecification((MethodSpecificationHandle)handle).Method),
                HandleKind.MethodDefinition => _nodeOf.TryGetValue((m, MetadataTokens.GetToken(handle)), out var n) && _nodes[n].Type >= 0 ? _types[_nodes[n].Type].Name : null,
                HandleKind.MemberReference => ParentName(md, md.GetMemberReference((MemberReferenceHandle)handle).Parent),
                _ => null,
            };

            // The type a static field belongs to.
            private static string? FieldOwner(MetadataReader md, EntityHandle handle) => handle.Kind switch
            {
                HandleKind.FieldDefinition => FullName(md, md.GetFieldDefinition((FieldDefinitionHandle)handle).GetDeclaringType()),
                HandleKind.MemberReference => ParentName(md, md.GetMemberReference((MemberReferenceHandle)handle).Parent),
                _ => null,
            };

            // The slot a MethodImpl entry names: its declaring type, name and parameter count, as a call to it names them.
            private static (string Type, string Method, int Params)? Declaration(MetadataReader md, EntityHandle declaration)
            {
                switch (declaration.Kind)
                {
                    case HandleKind.MethodDefinition:
                        var definition = md.GetMethodDefinition((MethodDefinitionHandle)declaration);
                        return (FullName(md, definition.GetDeclaringType()), md.GetString(definition.Name), ParamCount(md, definition.Signature));
                    case HandleKind.MemberReference:
                        var member = md.GetMemberReference((MemberReferenceHandle)declaration);
                        return ParentName(md, member.Parent) is { } parent ? (parent, md.GetString(member.Name), ParamCount(md, member.Signature)) : null;
                    default:
                        return null;
                }
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
