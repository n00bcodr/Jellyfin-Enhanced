using System.Reflection;
using System.Reflection.Emit;
using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc;

namespace JE.Tests.Architecture;

// Shared plumbing for the restructure gates (artifacts/restructure-plan/backend.md §3, §7): where the repo and the
// checked-in snapshots live, how snapshots are compared or (only with JE_UPDATE_SNAPSHOTS=1) rewritten, which types
// are the plugin's controllers and actions, and a small IL reader for call/field/type tokens.
internal static class Arch
{
    public static readonly Assembly Plugin = typeof(Jellyfin.Plugin.JellyfinEnhanced.JellyfinEnhanced).Assembly;
    public const string PluginNamespace = "Jellyfin.Plugin.JellyfinEnhanced";

    public static string RepoRoot { get; } = FindRepoRoot();
    public static string PluginSource => Path.Combine(RepoRoot, "Jellyfin.Plugin.JellyfinEnhanced");
    public static string SnapshotDirectory => Path.Combine(RepoRoot, "tests", "backend", "Architecture");

    private static string FindRepoRoot()
    {
        for (var dir = new DirectoryInfo(AppContext.BaseDirectory); dir != null; dir = dir.Parent)
        {
            if (File.Exists(Path.Combine(dir.FullName, "Jellyfin.Plugin.JellyfinEnhanced", "JellyfinEnhanced.csproj"))
                && Directory.Exists(Path.Combine(dir.FullName, "tests", "backend")))
                return dir.FullName;
        }
        throw new InvalidOperationException("Repository root not found above " + AppContext.BaseDirectory);
    }

    public static bool UpdateSnapshots => Environment.GetEnvironmentVariable("JE_UPDATE_SNAPSHOTS") == "1";

    public static readonly JsonSerializerOptions Json = new()
    {
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        WriteIndented = false,
    };

    // One JSON value per line inside a JSON array, so a snapshot diff names the changed entries.
    public static string JsonLines<T>(IEnumerable<T> items)
    {
        var lines = items.Select(item => "  " + JsonSerializer.Serialize(item, Json)).ToList();
        return lines.Count == 0 ? "[]\n" : "[\n" + string.Join(",\n", lines) + "\n]\n";
    }

    // Compares `actual` with the checked-in snapshot. JE_UPDATE_SNAPSHOTS=1 rewrites the file instead; refactor
    // steps never set it (PLAN.md gate BE), and a PR that changes a snapshot must say why.
    public static void VerifySnapshot(string fileName, string actual)
    {
        var path = Path.Combine(SnapshotDirectory, fileName);
        actual = actual.ReplaceLineEndings("\n");
        if (UpdateSnapshots)
        {
            File.WriteAllText(path, actual, new UTF8Encoding(false));
            return;
        }
        Assert.True(File.Exists(path), $"Snapshot {path} is missing. It is generated once with JE_UPDATE_SNAPSHOTS=1.");
        AssertSameLines(File.ReadAllText(path).ReplaceLineEndings("\n"), actual,
            $"{fileName} differs from the checked-in snapshot. Snapshots are never regenerated to pass a refactor step.");
    }

    // Fails with the removed (-) and added (+) lines, at most 40 of each, when the two texts differ.
    public static void AssertSameLines(string expected, string actual, string headline)
    {
        if (expected == actual) return;
        var expectedLines = expected.Split('\n');
        var actualLines = actual.Split('\n');
        var removed = Multiset(expectedLines).Except(Multiset(actualLines)).Take(40).ToList();
        var added = Multiset(actualLines).Except(Multiset(expectedLines)).Take(40).ToList();
        var message = new StringBuilder(headline + "\n");
        foreach (var line in removed) message.Append("- ").AppendLine(line.Line);
        foreach (var line in added) message.Append("+ ").AppendLine(line.Line);
        if (removed.Count == 0 && added.Count == 0) message.AppendLine("(same lines, different order)");
        Assert.Fail(message.ToString());
    }

    private static IEnumerable<(string Line, int Occurrence)> Multiset(IEnumerable<string> lines)
        => lines.GroupBy(line => line).SelectMany(group => group.Select((line, i) => (line, i)));

    public static Type[] PluginTypes()
    {
        try { return Plugin.GetTypes(); }
        catch (ReflectionTypeLoadException e) { return e.Types.Where(t => t != null).ToArray()!; }
    }

    public static bool IsControllerType(Type type) => typeof(ControllerBase).IsAssignableFrom(type) && type.Assembly == Plugin;

    public static Type[] Controllers() => PluginTypes().Where(t => t.IsClass && !t.IsAbstract && IsControllerType(t))
        .OrderBy(t => t.FullName, StringComparer.Ordinal).ToArray();

    public static MethodInfo[] Actions(Type controller) => controller
        .GetMethods(BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly)
        .Where(m => m.GetCustomAttributes<Microsoft.AspNetCore.Mvc.Routing.HttpMethodAttribute>(true).Any())
        .ToArray();

    // The outermost type: a compiler-generated closure or state machine belongs to the type that declares it.
    public static Type Outermost(Type type)
    {
        while (type.DeclaringType != null) type = type.DeclaringType;
        return type;
    }

    // Namespace-insensitive type name: `Name` with generic arguments, recursively (IEventConsumer<PlaybackStartEventArgs>).
    public static string Name(Type type)
    {
        if (type.IsArray) return Name(type.GetElementType()!) + "[]";
        if (type.IsByRef) return Name(type.GetElementType()!) + "&";
        if (!type.IsGenericType) return type.Name;
        var name = type.Name;
        var tick = name.IndexOf('`');
        if (tick >= 0) name = name[..tick];
        return name + "<" + string.Join(",", type.GetGenericArguments().Select(a => a.IsGenericParameter ? "" : Name(a))) + ">";
    }

    // The method plus the compiler-generated code that holds its body: its async/iterator state machine's MoveNext,
    // and every lambda, local function or closure method named `<{method}>…` (with their own state machines).
    public static IEnumerable<MethodBase> BodyOf(MethodInfo method)
    {
        var seen = new HashSet<MethodBase>();
        var pending = new Stack<MethodBase>();
        pending.Push(method);
        var marker = "<" + method.Name + ">";
        foreach (var generated in AllMethods(Outermost(method.DeclaringType!)).Where(m => m.Name.Contains(marker, StringComparison.Ordinal)))
            pending.Push(generated);
        while (pending.Count > 0)
        {
            var current = pending.Pop();
            if (!seen.Add(current)) continue;
            yield return current;
            var machine = current.GetCustomAttribute<StateMachineAttribute>()?.StateMachineType;
            var moveNext = machine?.GetMethod("MoveNext", BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public);
            if (moveNext != null) pending.Push(moveNext);
        }
    }

    // Every method and constructor declared on a type and its nested types (closures, state machines).
    public static IEnumerable<MethodBase> AllMethods(Type type)
    {
        const BindingFlags all = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static | BindingFlags.DeclaredOnly;
        foreach (var m in type.GetMethods(all)) yield return m;
        foreach (var c in type.GetConstructors(all)) yield return c;
        foreach (var nested in type.GetNestedTypes(BindingFlags.Public | BindingFlags.NonPublic))
            foreach (var m in AllMethods(nested)) yield return m;
    }

    private static readonly OpCode[] OneByte = new OpCode[0x100];
    private static readonly OpCode[] TwoByte = new OpCode[0x100];

    static Arch()
    {
        foreach (var field in typeof(OpCodes).GetFields(BindingFlags.Public | BindingFlags.Static))
        {
            if (field.GetValue(null) is not OpCode op) continue;
            var value = (ushort)op.Value;
            if (value < 0x100) OneByte[value] = op;
            else if ((value & 0xff00) == 0xfe00) TwoByte[value & 0xff] = op;
        }
    }

    // Every method, field or type token in the method's IL (call, callvirt, newobj, ldftn, ldfld, box, castclass, …),
    // resolved with Module.ResolveMember. Tokens that do not resolve are skipped.
    public static IEnumerable<MemberInfo> IlReferences(MethodBase method)
    {
        byte[]? il;
        try { il = method.GetMethodBody()?.GetILAsByteArray(); }
        catch (Exception) { yield break; }
        if (il == null) yield break;
        var typeArgs = method.DeclaringType is { IsGenericType: true } t ? t.GetGenericArguments() : null;
        var methodArgs = method is MethodInfo { IsGenericMethod: true } mi ? mi.GetGenericArguments() : null;
        var i = 0;
        while (i < il.Length)
        {
            var code = il[i++];
            var op = code == 0xfe ? TwoByte[il[i++]] : OneByte[code];
            int size;
            switch (op.OperandType)
            {
                case OperandType.InlineNone: size = 0; break;
                case OperandType.ShortInlineBrTarget:
                case OperandType.ShortInlineI:
                case OperandType.ShortInlineVar: size = 1; break;
                case OperandType.InlineVar: size = 2; break;
                case OperandType.InlineI8:
                case OperandType.InlineR: size = 8; break;
                case OperandType.InlineSwitch: size = 4 + 4 * BitConverter.ToInt32(il, i); break;
                default: size = 4; break;
            }
            if (op.OperandType is OperandType.InlineMethod or OperandType.InlineField or OperandType.InlineType or OperandType.InlineTok)
            {
                MemberInfo? member = null;
                try { member = method.Module.ResolveMember(BitConverter.ToInt32(il, i), typeArgs, methodArgs); }
                catch (Exception) { }
                if (member != null) yield return member;
            }
            i += size;
        }
    }
}
