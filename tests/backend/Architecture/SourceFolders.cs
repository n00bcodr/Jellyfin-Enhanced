using System.Runtime.CompilerServices;
using System.Text;
using System.Text.RegularExpressions;

namespace JE.Tests.Architecture;

// Review G1 (round 13): the boundary gates attribute a type to a feature or layer by the FOLDER of the file that declares
// it, not by its namespace. Namespaces can disagree with folders: the scheduled-task types keep …ScheduledTasks and
// StartupService keeps …Services (backend.md §7.8), and Shared/ and Infrastructure/ files carried legacy namespaces
// from Phase 1. A namespace-keyed scan skipped all of them.
//
// The map is built by scanning the plugin's .cs files (comments and string/char literals blanked first) for namespace
// declarations and the type declarations directly inside them. Every top-level, non-compiler-generated plugin type must
// be found in exactly one folder (CoverEveryPluginType), so a type the scanner cannot place fails the gate instead of
// silently leaving the scan.
internal static partial class SourceFolders
{
    // Comments, then raw/verbatim/regular strings and char literals, leftmost first.
    [GeneratedRegex(@"//[^\n]*|/\*.*?\*/|"""""".*?""""""|(?:@\$?|\$@)""(?:""""|[^""])*""|""(?:\\.|[^""\\\n])*""|'(?:\\.|[^'\\\n])+'", RegexOptions.Singleline)]
    private static partial Regex Noise();

    [GeneratedRegex(@"\bnamespace\s+(?<ns>[\w.]+)\s*(?<end>[;{])|\b(?:class|struct|interface|enum|record)\s+(?:(?:class|struct)\s+)?(?<name>[A-Za-z_]\w*)\s*(?<generic><[^<>{};()]*(?:<[^<>{};()]*>[^<>{};()]*)*>)?|(?<open>\{)|(?<close>\})")]
    private static partial Regex Token();

    private static readonly Lazy<Dictionary<string, SortedSet<string>>> Map = new(Build);

    // Top-level type full name (reflection form, generic arity as `N) -> repo-relative source paths under the plugin.
    public static IReadOnlyDictionary<string, SortedSet<string>> TypeFiles => Map.Value;

    private static string Blank(Match m) => Regex.Replace(m.Value, @"[^\n]", " ");

    internal static IEnumerable<(string Namespace, string Name)> TopLevelTypes(string source)
    {
        var text = Noise().Replace(source, Blank);
        var depth = 0;
        var scopes = new Stack<(string Namespace, int Depth)>();
        string? fileScoped = null;
        foreach (Match m in Token().Matches(text))
        {
            if (m.Groups["open"].Success)
            {
                depth++;
            }
            else if (m.Groups["close"].Success)
            {
                if (scopes.Count > 0 && scopes.Peek().Depth == depth) scopes.Pop();
                depth--;
            }
            else if (m.Groups["ns"].Success)
            {
                if (m.Groups["end"].Value == ";")
                {
                    fileScoped = m.Groups["ns"].Value;
                    continue;
                }
                // Block namespace: the token consumed its opening brace.
                depth++;
                var outer = scopes.Count > 0 ? scopes.Peek().Namespace + "." : fileScoped != null ? fileScoped + "." : "";
                scopes.Push((outer + m.Groups["ns"].Value, depth));
            }
            else if (m.Groups["name"].Success)
            {
                var (ns, nsDepth) = scopes.Count > 0 ? scopes.Peek() : (fileScoped ?? "", 0);
                if (depth != nsDepth) continue;
                var name = m.Groups["name"].Value;
                if (m.Groups["generic"].Success)
                {
                    var arguments = m.Groups["generic"].Value[1..^1];
                    var arity = 1;
                    var nesting = 0;
                    foreach (var c in arguments)
                    {
                        if (c == '<') nesting++;
                        else if (c == '>') nesting--;
                        else if (c == ',' && nesting == 0) arity++;
                    }
                    name += "`" + arity;
                }
                yield return (ns, name);
            }
        }
    }

    private static Dictionary<string, SortedSet<string>> Build()
    {
        var map = new Dictionary<string, SortedSet<string>>(StringComparer.Ordinal);
        foreach (var (path, _) in FileSizeTests.SourceFiles())
        {
            var source = File.ReadAllText(Path.Combine(Arch.PluginSource, path), Encoding.UTF8);
            foreach (var (ns, name) in TopLevelTypes(source))
            {
                var full = ns.Length == 0 ? name : ns + "." + name;
                if (!map.TryGetValue(full, out var files)) map[full] = files = new SortedSet<string>(StringComparer.Ordinal);
                files.Add(path);
            }
        }
        return map;
    }

    // The source file of the outermost type of `type` (generic definitions resolved); null for compiler-generated
    // top-level types (anonymous types, <PrivateImplementationDetails>, generated regex helpers) and non-plugin types.
    public static string? FileOf(Type type)
    {
        if (type.Assembly != Arch.Plugin) return null;
        var outer = Arch.Outermost(type);
        if (outer.IsGenericType) outer = outer.GetGenericTypeDefinition();
        if (outer.FullName is not { } full || !TypeFiles.TryGetValue(full, out var files)) return null;
        return files.Min;
    }

    // "Features/<F>/…/" etc.: the folder of the outermost type's file, without the file name.
    public static string? FolderOf(Type type) => FileOf(type) is { } file ? Path.GetDirectoryName(file)!.Replace('\\', '/') : null;

    // The feature a type belongs to by folder: Features/<F>/** -> F.
    public static string? FeatureOf(Type type)
    {
        var file = FileOf(type);
        if (file == null || !file.StartsWith("Features/", StringComparison.Ordinal)) return null;
        return file.Split('/')[1];
    }

    // Features/<F>/PublicApi/**: the forwarding surface feature F offers the others (backend.md §7.7).
    public static bool IsPublicApi(Type type)
    {
        var file = FileOf(type);
        if (file == null || !file.StartsWith("Features/", StringComparison.Ordinal)) return false;
        var parts = file.Split('/');
        return parts.Length > 3 && parts[2] == "PublicApi";
    }

    // Shared/** or Infrastructure/** by folder (the M2 ratchet's subject).
    public static bool IsSharedOrInfrastructure(Type type)
        => FileOf(type) is { } file && (file.StartsWith("Shared/", StringComparison.Ordinal) || file.StartsWith("Infrastructure/", StringComparison.Ordinal));

    // Namespace-independent key: "<folder>/<type name>", nested types as Outer+Inner (generic arity kept).
    public static string Key(Type type)
    {
        var definition = type.IsGenericType ? type.GetGenericTypeDefinition() : type;
        var name = definition.Name;
        for (var t = definition.DeclaringType; t != null; t = t.DeclaringType) name = t.Name + "+" + name;
        return FolderOf(type) is { Length: > 0 } folder ? $"{folder}/{name}" : name;
    }

    // Compiler-generated, or injected by coverlet when gate T collects coverage (namespace
    // Coverlet.Core.Instrumentation.Tracker; ServiceFactorySnapshotTests skips it the same way).
    public static bool IsCompilerGenerated(Type type)
        => type.Name.Contains('<') || type.GetCustomAttributes(typeof(CompilerGeneratedAttribute), false).Length > 0
            || (type.Namespace?.StartsWith("Coverlet", StringComparison.Ordinal) ?? false);
}
