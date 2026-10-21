using System.Reflection;
using System.Reflection.Emit;
using System.Runtime.CompilerServices;
using Jellyfin.Plugin.JellyfinEnhanced.Services;

namespace JE.Tests;

/// <summary>
/// The output paths of protected items, DERIVED from the plugin's own IL rather than listed: every method that asks a
/// privacy verdict (Spoiler Guard's scope, Hidden Content, the delivery gate's policy read, the tag strip's policy) is a
/// root, and everything it calls inside the plugin (lambdas, local functions, async and iterator bodies, interface
/// implementations) is on its output path. A read of an item-derived text member (a library item's, a DTO's, a media
/// stream's or source's, a tag-cache entry's names, overviews, paths, genres, ratings, languages, stream titles…) on such
/// a path must happen inside the construction table's owner (PrivacyValues and PrivacyValueHost); anywhere else it is a
/// site the table does not see.
/// </summary>
internal static class PrivacyOutputPathScan
{
    private static readonly Dictionary<short, OpCode> _ops = typeof(OpCodes).GetFields(BindingFlags.Public | BindingFlags.Static)
        .Select(f => (OpCode)f.GetValue(null)!).ToDictionary(o => o.Value);

    public static Assembly Plugin => typeof(PrivacyValues).Assembly;

    /// <summary>The members one method body references (calls, loads of functions and fields, tokens).</summary>
    public static IEnumerable<MemberInfo> Referenced(MethodBase method)
    {
        MethodBody? body;
        try { body = method.GetMethodBody(); }
        catch (Exception) { yield break; }
        if (body == null) yield break;
        var il = body.GetILAsByteArray() ?? [];
        var typeArgs = method.DeclaringType is { IsGenericType: true } t ? t.GetGenericArguments() : null;
        var methodArgs = method is MethodInfo { IsGenericMethod: true } m ? m.GetGenericArguments() : null;
        for (var i = 0; i < il.Length;)
        {
            OpCode op;
            if (il[i] == 0xFE) { op = _ops[unchecked((short)(0xFE00 | il[i + 1]))]; i += 2; }
            else { op = _ops[il[i]]; i += 1; }
            var size = op.OperandType switch
            {
                OperandType.InlineNone => 0,
                OperandType.ShortInlineBrTarget or OperandType.ShortInlineI or OperandType.ShortInlineVar => 1,
                OperandType.InlineVar => 2,
                OperandType.InlineI8 or OperandType.InlineR => 8,
                OperandType.InlineSwitch => 4 + 4 * BitConverter.ToInt32(il, i),
                _ => 4,
            };
            if (op.OperandType is OperandType.InlineMethod or OperandType.InlineField or OperandType.InlineTok)
            {
                MemberInfo? member = null;
                try { member = method.Module.ResolveMember(BitConverter.ToInt32(il, i), typeArgs, methodArgs); }
                catch (Exception) { member = null; }
                if (member != null) yield return member;
            }
            i += size;
        }
    }

    private static IEnumerable<Type> AllTypes(Assembly assembly)
    {
        try { return assembly.GetTypes(); }
        catch (ReflectionTypeLoadException ex) { return ex.Types.OfType<Type>(); }
    }

    private const BindingFlags Declared = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static | BindingFlags.DeclaredOnly;

    private static IEnumerable<MethodBase> Methods(Type type)
        => type.GetMethods(Declared).Cast<MethodBase>().Concat(type.GetConstructors(Declared));

    /// <summary>
    /// Spoiler Guard's item verdicts: asking one makes the asking method an output path of a protected item (the policy that
    /// REBUILDS an item's text). Hidden Content removes an item instead (its stubs and rows are the table's), and JE's own
    /// JSON feeds are projected field by field by their schema (ProviderPresentationSchema) with the policy read at emit.
    /// </summary>
    public static readonly HashSet<MethodBase> Verdicts = new MethodBase[0]
        .Concat(typeof(SpoilerUserResolver).GetMethods(Declared).Where(m => m.Name == nameof(SpoilerUserResolver.InSpoilerScope)))
        .Concat(typeof(SpoilerFieldStripFilter).GetMethods(Declared).Where(m => m.Name == "Protects"))
        .Concat(typeof(SpoilerTagDataStripper).GetMethods(Declared).Where(m => m.Name is nameof(SpoilerTagDataStripper.CreatePolicy) or nameof(SpoilerTagDataStripper.GetGuardedKind)
            or nameof(SpoilerTagDataStripper.IsGuarded) or nameof(SpoilerTagDataStripper.GetTagDataStub) or "ExtraGuarded"))
        .ToHashSet();

    /// <summary>
    /// Where the walk stops: the owner (what it reads is its input, and what it emits is a construction), and the shared tag
    /// cache's builder (viewer-independent entries that reach a protected viewer only through the stripper's constructions).
    /// </summary>
    public static bool Stops(Type? type)
    {
        if (IsOwner(type)) return true;
        for (var t = type; t != null; t = t.DeclaringType)
        {
            if (t == typeof(TagCacheService)) return true;
            // Acquisition stamps (phase 4a): read a source's path and dates only to decide one fixed stamp value; no item text.
            if (t.Namespace == "Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Stamps") return true;
        }
        return false;
    }

    /// <summary>Types whose text members carry an item's own metadata.</summary>
    private static readonly Type[] _carriers =
    [
        typeof(MediaBrowser.Controller.Entities.BaseItem), typeof(MediaBrowser.Model.Dto.BaseItemDto), typeof(MediaBrowser.Model.Dto.MediaSourceInfo),
        typeof(MediaBrowser.Model.Entities.MediaStream), typeof(MediaBrowser.Model.Entities.MediaAttachment), typeof(MediaBrowser.Model.Dto.BaseItemPerson),
        typeof(MediaBrowser.Controller.Entities.PersonInfo), typeof(MediaBrowser.Model.Search.SearchHint), typeof(MediaBrowser.Model.Activity.ActivityLogEntry),
        typeof(MediaBrowser.Model.LiveTv.BaseTimerInfoDto), typeof(MediaBrowser.Model.Dto.ImageInfo), typeof(MediaBrowser.Model.Entities.ChapterInfo),
        typeof(Jellyfin.Plugin.JellyfinEnhanced.Model.TagCacheEntry), typeof(Jellyfin.Plugin.JellyfinEnhanced.Model.TagStreamData),
        typeof(Jellyfin.Plugin.JellyfinEnhanced.Model.TagMediaStream), typeof(Jellyfin.Plugin.JellyfinEnhanced.Model.TagMediaSource),
    ];

    private static bool IsText(Type type)
        => type == typeof(string) || type != typeof(string) && typeof(IEnumerable<string>).IsAssignableFrom(type);

    /// <summary>
    /// Members that identify rather than describe: ids, keys and kinds the verdicts are decided from (an id is rebuilt from
    /// its parsed value wherever it is emitted), never an item's own text.
    /// </summary>
    private static bool Identifies(string member)
    {
        var name = member.StartsWith("get_", StringComparison.Ordinal) ? member[4..] : member;
        return name.EndsWith("Id", StringComparison.Ordinal) || name.EndsWith("Ids", StringComparison.Ordinal) || name.EndsWith("Key", StringComparison.Ordinal)
            || name.EndsWith("ImageTag", StringComparison.Ordinal) || name.EndsWith("ImageTags", StringComparison.Ordinal) || name is "Type" or "MediaType";
    }

    /// <summary>Whether a referenced member reads an item-derived text.</summary>
    public static bool ReadsItemText(MemberInfo member)
    {
        var (owner, type, name) = member switch
        {
            MethodInfo m when !m.IsStatic && m.ReturnType != typeof(void) => (m.DeclaringType, m.ReturnType, m.Name),
            FieldInfo f when !f.IsStatic => (f.DeclaringType, f.FieldType, f.Name),
            _ => (null, typeof(void), ""),
        };
        if (owner == null || !IsText(type) || Identifies(name) || name is "ToString" or "GetType") return false;
        return _carriers.Any(c => c.IsAssignableFrom(owner));
    }

    /// <summary>A carrier's own members (accessors, Clone, equality) copy or compare a value; they emit nothing.</summary>
    private static bool IsCarrier(Type? type) => type != null && _carriers.Any(c => c.IsAssignableFrom(type));

    /// <summary>The construction table's owner (its nested closures included).</summary>
    public static bool IsOwner(Type? type)
    {
        for (var t = type; t != null; t = t.DeclaringType)
            if (t == typeof(PrivacyValues) || t == typeof(PrivacyValueHost)) return true;
        return false;
    }

    /// <summary>A method on an output path, a read it makes, and the root it was reached from.</summary>
    public sealed record Site(MethodBase Method, MemberInfo Read, MethodBase Root)
    {
        public string Where => Describe(Method);
        public string What => Read.DeclaringType?.Name + "." + Read.Name;
        public override string ToString() => Where + " reads " + What + " (from " + Describe(Root) + ")";
    }

    public static string Describe(MethodBase method) => (method.DeclaringType?.FullName ?? "?").Replace("Jellyfin.Plugin.JellyfinEnhanced.", "", StringComparison.Ordinal) + "." + method.Name;

    /// <summary>Every root: a plugin method whose body asks a verdict (the verdicts themselves are decisions, not output).</summary>
    public static List<MethodBase> Roots(Assembly? assembly = null)
    {
        var roots = new List<MethodBase>();
        foreach (var type in AllTypes(assembly ?? Plugin))
            foreach (var method in Methods(type))
                if (!Verdicts.Contains(method) && Referenced(method).OfType<MethodBase>().Any(c => Verdicts.Contains(Normalize(c))))
                    roots.Add(method);
        return roots;
    }

    private static MethodBase Normalize(MethodBase method)
    {
        if (method is MethodInfo { IsGenericMethod: true, IsGenericMethodDefinition: false } generic) method = generic.GetGenericMethodDefinition();
        if (method.DeclaringType is { IsGenericType: true, IsGenericTypeDefinition: false } declaring)
        {
            try { method = MethodBase.GetMethodFromHandle(method.MethodHandle, declaring.GetGenericTypeDefinition().TypeHandle) ?? method; }
            catch (Exception) { }
        }
        return method;
    }

    private static readonly Lazy<Dictionary<MethodInfo, List<MethodInfo>>> _implementations = new(() =>
    {
        var map = new Dictionary<MethodInfo, List<MethodInfo>>();
        foreach (var type in AllTypes(Plugin).Where(t => t.IsClass))
        {
            foreach (var face in type.GetInterfaces().Where(i => !i.IsGenericType || !i.ContainsGenericParameters))
            {
                InterfaceMapping mapping;
                try { mapping = type.GetInterfaceMap(face); }
                catch (Exception) { continue; }
                for (var i = 0; i < mapping.InterfaceMethods.Length; i++)
                    (map.TryGetValue(mapping.InterfaceMethods[i], out var list) ? list : map[mapping.InterfaceMethods[i]] = new()).Add(mapping.TargetMethods[i]);
            }
            foreach (var method in type.GetMethods(Declared).Where(m => m.IsVirtual && m.GetBaseDefinition() != m))
                (map.TryGetValue(method.GetBaseDefinition(), out var list) ? list : map[method.GetBaseDefinition()] = new()).Add(method);
        }
        return map;
    });

    /// <summary>Walks the output paths from every root; the item-text reads outside the owner.</summary>
    public static List<Site> Sites(IEnumerable<MethodBase>? roots = null, Assembly? assembly = null)
    {
        var scanned = assembly ?? Plugin;
        var sites = new List<Site>();
        var seen = new HashSet<MethodBase>();
        foreach (var root in roots ?? Roots(scanned))
        {
            var queue = new Queue<MethodBase>();
            queue.Enqueue(root);
            while (queue.Count > 0)
            {
                var method = Normalize(queue.Dequeue());
                if (!seen.Add(method) || method.Module.Assembly != scanned || Stops(method.DeclaringType) || IsCarrier(method.DeclaringType)) continue;
                // An async or iterator method's body is its state machine's MoveNext.
                foreach (var machine in method.GetCustomAttributes<StateMachineAttribute>())
                    if (machine.StateMachineType.GetMethod("MoveNext", Declared) is { } next) queue.Enqueue(next);
                foreach (var member in Referenced(method))
                {
                    if (ReadsItemText(member) && !IsOwner(method.DeclaringType)) sites.Add(new Site(method, member, root));
                    if (member is not MethodBase callee || Verdicts.Contains(Normalize(callee))) continue;
                    if (callee.Module.Assembly == scanned) queue.Enqueue(callee);
                    // A plugin interface or virtual method reaches its plugin implementations (not every Equals or Dispose).
                    if (callee is MethodInfo info && info.DeclaringType?.Assembly == Plugin && _implementations.Value.TryGetValue(info, out var targets))
                        foreach (var target in targets) queue.Enqueue(target);
                }
            }
        }
        return sites;
    }
}
