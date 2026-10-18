using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
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
    /// <param name="Why">Why it is bracketed ("user controller", "reaches IUserManager.UpdatePolicyAsync", "reviewed"); null when it isn't.</param>
    /// <param name="Reaches">The user change or sign-in its code reaches ("IUserManager.UpdatePolicyAsync"), whatever else applies; null: none.</param>
    public sealed record JellyfinUserAction(string Controller, string Action, IReadOnlyList<string> Verbs, JellyfinUserKey Key, string? Why, string? Reaches);

    /// <summary>
    /// 4a review round 9: which controller actions can create, delete, change, lock or authenticate a Jellyfin user, read
    /// from the code of the assembly that defines them (Jellyfin.Api, or a plugin's), so a Jellyfin update that adds or
    /// renames one is bracketed without a change here. DENY BY DEFAULT: an action is bracketed when
    /// <list type="bullet">
    /// <item><description>it is on Jellyfin's user, Quick Connect or start-up controller and isn't GET-only;</description></item>
    /// <item><description>its code (its async state machine, lambdas and every method of its assembly it calls) calls a member of
    /// <see cref="Mutates"/>: everything on IUserManager except its reviewed reads, the session manager's sign-ins, Quick
    /// Connect's authorization, the authentication and password-reset providers, and a write to a user entity;</description></item>
    /// <item><description>or it is on the <see cref="Reviewed"/> list.</description></item>
    /// </list>
    /// The assembly's metadata is read once (System.Reflection.Metadata, no code loaded or run), then each action is a
    /// dictionary lookup. An assembly that can't be read brackets every one of its actions that isn't GET, globally.
    /// JE's own actions are left to the brackets inside them.
    /// </summary>
    public static class JellyfinUserActions
    {
        /// <summary>Jellyfin's controllers whose every non-GET action is bracketed.</summary>
        public static readonly IReadOnlySet<string> UserControllers = new HashSet<string>(StringComparer.Ordinal) { "UserController", "QuickConnectController", "StartupController" };

        /// <summary>Actions bracketed whatever their code shows ("Controller.Action"): none are needed for 12.2 and 10.11, whose
        /// user-changing actions all reach a <see cref="Mutates"/> member; kept for one that only does so through another assembly.</summary>
        public static readonly IReadOnlySet<string> Reviewed = new HashSet<string>(StringComparer.Ordinal);

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

        private static readonly ConcurrentDictionary<string, Lazy<AssemblyActions?>> Assemblies = new(StringComparer.Ordinal);

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
        public static IReadOnlyList<JellyfinUserAction> Scan(string path) => AssemblyActions.Read(path).All();

        private static AssemblyActions? Of(Assembly assembly)
        {
            if (assembly.IsDynamic || string.IsNullOrEmpty(assembly.Location)) return null;
            return Assemblies.GetOrAdd(assembly.Location, path => new Lazy<AssemblyActions?>(() =>
            {
                try
                {
                    return AssemblyActions.Read(path);
                }
                catch (Exception e) when (e is IOException or BadImageFormatException or InvalidOperationException or UnauthorizedAccessException or ArgumentException)
                {
                    return null;
                }
            })).Value;
        }

        // One assembly's methods: what each calls in the assembly, which reach a Mutates member, and each action's verbs.
        private sealed class AssemblyActions
        {
            private static readonly OpCode[] OneByte = new OpCode[0x100];
            private static readonly OpCode[] TwoByte = new OpCode[0x100];

            private readonly Dictionary<int, Method> _methods = new();

            static AssemblyActions()
            {
                foreach (var field in typeof(OpCodes).GetFields(BindingFlags.Public | BindingFlags.Static))
                {
                    if (field.GetValue(null) is not OpCode code) continue;
                    var value = (ushort)code.Value;
                    if (value < 0x100) OneByte[value] = code;
                    else if ((value & 0xff00) == 0xfe00) TwoByte[value & 0xff] = code;
                }
            }

            private sealed class Method
            {
                public required string Type { get; init; }
                public required string Name { get; init; }
                public required bool Action { get; init; }
                public required IReadOnlyList<string> Verbs { get; init; }
                public required bool UserId { get; init; }
                public List<int> Calls { get; } = new();
                public string? Reaches { get; set; }
            }

            public static AssemblyActions Read(string path)
            {
                using var stream = File.OpenRead(path);
                using var pe = new PEReader(stream, PEStreamOptions.PrefetchEntireImage);
                var md = pe.GetMetadataReader();
                var result = new AssemblyActions();
                var types = new Dictionary<string, TypeDefinitionHandle>(StringComparer.Ordinal);
                foreach (var handle in md.TypeDefinitions) types[FullName(md, handle)] = handle;

                foreach (var typeHandle in md.TypeDefinitions)
                {
                    var type = md.GetTypeDefinition(typeHandle);
                    var typeName = FullName(md, typeHandle);
                    var controller = Controller(md, type, types);
                    foreach (var methodHandle in type.GetMethods())
                    {
                        var method = md.GetMethodDefinition(methodHandle);
                        var name = md.GetString(method.Name);
                        var attributes = method.Attributes;
                        var action = controller && (attributes & MethodAttributes.MemberAccessMask) == MethodAttributes.Public && (attributes & MethodAttributes.Static) == 0
                            && (attributes & MethodAttributes.SpecialName) == 0 && !HasAttribute(md, method.GetCustomAttributes(), "NonActionAttribute");
                        var entry = new Method
                        {
                            Type = typeName,
                            Name = name,
                            Action = action,
                            Verbs = action ? Verbs(md, method.GetCustomAttributes()) : Array.Empty<string>(),
                            UserId = method.GetParameters().Select(p => md.GetString(md.GetParameter(p).Name)).Any(p => string.Equals(p, "userId", StringComparison.OrdinalIgnoreCase)),
                        };
                        result._methods[MetadataTokens.GetToken(methodHandle)] = entry;
                        if (method.RelativeVirtualAddress != 0) result.Body(md, pe.GetMethodBody(method.RelativeVirtualAddress), entry, types);
                        // An async method or iterator runs in its state machine's MoveNext.
                        foreach (var machine in StateMachines(md, method.GetCustomAttributes()))
                            if (types.TryGetValue(machine, out var machineType))
                                entry.Calls.AddRange(md.GetTypeDefinition(machineType).GetMethods().Where(m => md.GetString(md.GetMethodDefinition(m).Name) == "MoveNext").Select(m => MetadataTokens.GetToken(m)));
                    }
                }

                result.Propagate();
                return result;
            }

            public JellyfinUserAction? Classify(int token, string controller)
            {
                if (!_methods.TryGetValue(token, out var method)) return null;
                var verbs = method.Verbs.Count == 0 ? new[] { "*" } : method.Verbs;
                var writes = verbs.Any(v => v is not ("GET" or "HEAD"));
                var why = UserControllers.Contains(controller) && writes ? "user controller"
                    : method.Reaches is { } reaches ? "reaches " + reaches
                    : Reviewed.Contains(controller + "." + method.Name) ? "reviewed"
                    : null;
                var key = why == null ? JellyfinUserKey.None : method.UserId ? JellyfinUserKey.User : JellyfinUserKey.Global;
                return new JellyfinUserAction(controller, method.Name, verbs, key, why, method.Reaches);
            }

            public IReadOnlyList<JellyfinUserAction> All()
                => _methods.Where(m => m.Value.Action).Select(m => Classify(m.Key, Simple(m.Value.Type))!).ToList();

            private static string Simple(string type) => type[(Math.Max(type.LastIndexOf('.'), type.LastIndexOf('+')) + 1)..];

            // Reaching a Mutates member, from callee to caller, until nothing changes.
            private void Propagate()
            {
                var callers = new Dictionary<int, List<int>>();
                foreach (var (token, method) in _methods)
                    foreach (var callee in method.Calls)
                    {
                        if (!callers.TryGetValue(callee, out var list)) callers[callee] = list = new List<int>();
                        list.Add(token);
                    }

                var queue = new Queue<int>(_methods.Where(m => m.Value.Reaches != null).Select(m => m.Key));
                while (queue.Count > 0)
                {
                    var token = queue.Dequeue();
                    if (!callers.TryGetValue(token, out var list)) continue;
                    foreach (var caller in list)
                    {
                        var method = _methods[caller];
                        if (method.Reaches != null) continue;
                        method.Reaches = _methods[token].Reaches;
                        queue.Enqueue(caller);
                    }
                }
            }

            // The calls a body makes (call, callvirt, newobj, ldftn, ldvirtftn, jmp): methods of this assembly are followed,
            // others are checked against Mutates.
            private void Body(MetadataReader md, MethodBodyBlock body, Method method, Dictionary<string, TypeDefinitionHandle> types)
            {
                var il = body.GetILReader();
                while (il.RemainingBytes > 0)
                {
                    var first = il.ReadByte();
                    var code = first == 0xfe ? TwoByte[il.ReadByte()] : OneByte[first];
                    switch (code.OperandType)
                    {
                        case OperandType.InlineMethod:
                            Called(md, MetadataTokens.EntityHandle(il.ReadInt32()), method, types);
                            break;
                        case OperandType.InlineNone:
                            break;
                        case OperandType.ShortInlineBrTarget or OperandType.ShortInlineI or OperandType.ShortInlineVar:
                            il.Offset += 1;
                            break;
                        case OperandType.InlineVar:
                            il.Offset += 2;
                            break;
                        case OperandType.InlineI8 or OperandType.InlineR:
                            il.Offset += 8;
                            break;
                        case OperandType.InlineSwitch:
                            // The count, then that many branch targets (read the count first: it moves the offset).
                            var targets = il.ReadInt32();
                            il.Offset += 4 * targets;
                            break;
                        default:
                            il.Offset += 4;
                            break;
                    }
                }
            }

            private void Called(MetadataReader md, EntityHandle handle, Method method, Dictionary<string, TypeDefinitionHandle> types)
            {
                switch (handle.Kind)
                {
                    case HandleKind.MethodDefinition:
                        method.Calls.Add(MetadataTokens.GetToken(handle));
                        break;
                    case HandleKind.MethodSpecification:
                        Called(md, md.GetMethodSpecification((MethodSpecificationHandle)handle).Method, method, types);
                        break;
                    case HandleKind.MemberReference:
                        var member = md.GetMemberReference((MemberReferenceHandle)handle);
                        var name = md.GetString(member.Name);
                        var parent = ParentName(md, member.Parent);
                        // A method of this assembly's generic type, instantiated: every method of that name on it.
                        if (parent != null && types.TryGetValue(parent, out var own))
                            method.Calls.AddRange(md.GetTypeDefinition(own).GetMethods().Where(m => md.GetString(md.GetMethodDefinition(m).Name) == name).Select(m => MetadataTokens.GetToken(m)));
                        else if (parent != null && method.Reaches == null && Mutates(parent, name))
                            method.Reaches = parent[(parent.LastIndexOf('.') + 1)..] + "." + name;
                        break;
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

            // A public class that MVC would treat as a controller: named *Controller, or deriving from ControllerBase.
            private static bool Controller(MetadataReader md, TypeDefinition type, Dictionary<string, TypeDefinitionHandle> types)
            {
                if ((type.Attributes & TypeAttributes.VisibilityMask) != TypeAttributes.Public || (type.Attributes & (TypeAttributes.Abstract | TypeAttributes.Interface)) != 0) return false;
                if (md.GetString(type.Name).EndsWith("Controller", StringComparison.Ordinal)) return true;
                for (var (baseType, depth) = (type.BaseType, 0); !baseType.IsNil && depth < 16; depth++)
                {
                    var name = ParentName(md, baseType);
                    if (name is "Microsoft.AspNetCore.Mvc.ControllerBase" or "Microsoft.AspNetCore.Mvc.Controller") return true;
                    if (name == null || !types.TryGetValue(name, out var own)) return false;
                    baseType = md.GetTypeDefinition(own).BaseType;
                }

                return false;
            }

            private static readonly Dictionary<string, string> VerbAttributes = new(StringComparer.Ordinal)
            {
                ["HttpGetAttribute"] = "GET", ["HttpPostAttribute"] = "POST", ["HttpPutAttribute"] = "PUT", ["HttpDeleteAttribute"] = "DELETE",
                ["HttpPatchAttribute"] = "PATCH", ["HttpHeadAttribute"] = "HEAD", ["HttpOptionsAttribute"] = "OPTIONS", ["AcceptVerbsAttribute"] = "*",
            };

            private static IReadOnlyList<string> Verbs(MetadataReader md, CustomAttributeHandleCollection attributes)
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
