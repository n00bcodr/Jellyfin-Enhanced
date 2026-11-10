using System.Reflection;
using System.Runtime.CompilerServices;
using System.Text.RegularExpressions;
using MediaBrowser.Model.Tasks;
using Xunit.Abstractions;

namespace JE.Tests.Architecture;

// Guardrail §7.3 (artifacts/restructure-plan/backend.md), FAILING from S3: a file under Features/<F>/ must declare
// namespace …Features.<F>[.*], and no .cs file may live in the retired folders.
//
// Exemptions (backend.md §7.8, CHANGELOG S8-d and S9-d), and no others: Jellyfin keys a scheduled task's saved
// triggers and last result by the MD5 of the task type's full name, so the IScheduledTask types keep their legacy
// namespaces while their files live in Features/<F>/:
//   - a file in Features/<F>/Tasks/ that declares only namespace …ScheduledTasks;
//   - Features/Platform/Services/StartupService.cs, namespace …Services (the "Jellyfin Enhanced Startup" task).
// The exemption cannot hide a non-task type: every type an exempt file declares must be an IScheduledTask (or nested
// in one), and namespace …ScheduledTasks holds nothing else (both checked by reflection below).
//
// Round 13: the same rule covers the layers. A file under Shared/<Area>/ declares …Shared.<Area>[.*] and a file under
// Infrastructure/<Area>/ declares …Infrastructure.<Area>[.*]. Round 13 renamed the 17 files Phase 1 had moved with
// their legacy namespaces (…Helpers, …Services, …Model.Arr, …Extensions, …EventHandlers). LayerExemptions is empty:
// no Shared/ or Infrastructure/ type is a scheduled task or startup task, and none has its full type name persisted or
// reflected (no logger category, serializer type name, Jellyfin task id or configuration key uses it;
// PluginConfiguration's XML names ArrInstance elements by property and type name, without the namespace).
public partial class FolderNamespaceTests(ITestOutputHelper output)
{
    public static readonly string[] RetiredFolders = ["Services", "Helpers", "Model", "ScheduledTasks", "EventHandlers", "Controllers", "Extensions"];

    public const string TaskNamespace = Arch.PluginNamespace + ".ScheduledTasks";
    public const string StartupNamespace = Arch.PluginNamespace + ".Services";
    public const string StartupFile = "Features/Platform/Services/StartupService.cs";
    public const string StartupType = StartupNamespace + ".StartupService";

    [GeneratedRegex(@"^\s*namespace\s+([\w.]+)", RegexOptions.Multiline)]
    private static partial Regex NamespaceDeclaration();

    [GeneratedRegex(@"\b(?:class|record|struct|interface|enum)\s+([A-Z]\w*)")]
    private static partial Regex TypeDeclaration();

    private static bool IsExempt(string path, IReadOnlyList<string> declared)
    {
        if (declared.Count == 0) return false;
        var parts = path.Split('/');
        if (parts.Length == 4 && parts[2] == "Tasks" && declared.All(ns => ns == TaskNamespace)) return true;
        return path == StartupFile && declared.All(ns => ns == StartupNamespace);
    }

    [Fact]
    public void FeatureFilesDeclareTheirFolderNamespace()
    {
        var files = FileSizeTests.SourceFiles().Select(f => f.Path).ToList();
        var mismatches = new List<string>();
        var exempt = new List<string>();
        foreach (var path in files.Where(p => p.StartsWith("Features/", StringComparison.Ordinal)))
        {
            var feature = path.Split('/')[1];
            var expected = $"{Arch.PluginNamespace}.Features.{feature}";
            var declared = NamespaceDeclaration().Matches(File.ReadAllText(Path.Combine(Arch.PluginSource, path))).Select(m => m.Groups[1].Value).ToList();
            if (declared.Count > 0 && declared.All(ns => ns == expected || ns.StartsWith(expected + ".", StringComparison.Ordinal))) continue;
            var text = $"{path}: namespace {(declared.Count == 0 ? "(none)" : string.Join(", ", declared))}, expected {expected}[.*]";
            if (IsExempt(path, declared)) exempt.Add(text);
            else mismatches.Add(text);
        }
        output.WriteLine($"files under Features/: {files.Count(p => p.StartsWith("Features/", StringComparison.Ordinal))}; exempt scheduled-task files: {exempt.Count}; mismatches: {mismatches.Count}");
        foreach (var line in exempt) output.WriteLine("exempt (§7.8): " + line);
        Assert.True(mismatches.Count == 0, "Folder/namespace mismatches (backend.md §7.3):\n" + string.Join("\n", mismatches));
    }

    // Files under Shared/ or Infrastructure/ allowed to keep another namespace, with the reason. Empty (see above).
    public static readonly IReadOnlyDictionary<string, string> LayerExemptions = new Dictionary<string, string>(StringComparer.Ordinal);

    [Fact]
    public void LayerFilesDeclareTheirFolderNamespace()
    {
        var files = FileSizeTests.SourceFiles().Select(f => f.Path)
            .Where(p => p.StartsWith("Shared/", StringComparison.Ordinal) || p.StartsWith("Infrastructure/", StringComparison.Ordinal)).ToList();
        var mismatches = new List<string>();
        foreach (var path in files)
        {
            var parts = path.Split('/');
            var expected = parts.Length > 2 ? $"{Arch.PluginNamespace}.{parts[0]}.{parts[1]}" : $"{Arch.PluginNamespace}.{parts[0]}";
            var declared = NamespaceDeclaration().Matches(File.ReadAllText(Path.Combine(Arch.PluginSource, path))).Select(m => m.Groups[1].Value).ToList();
            if (declared.Count > 0 && declared.All(ns => ns == expected || ns.StartsWith(expected + ".", StringComparison.Ordinal))) continue;
            if (LayerExemptions.ContainsKey(path)) continue;
            mismatches.Add($"{path}: namespace {(declared.Count == 0 ? "(none)" : string.Join(", ", declared))}, expected {expected}[.*]");
        }
        foreach (var stale in LayerExemptions.Keys.Where(k => !files.Contains(k))) mismatches.Add($"{stale}: exempt but not a Shared/ or Infrastructure/ file");
        output.WriteLine($"files under Shared/ and Infrastructure/: {files.Count}; exemptions: {LayerExemptions.Count}; mismatches: {mismatches.Count}");
        Assert.True(mismatches.Count == 0, "Folder/namespace mismatches in Shared/ or Infrastructure/ (round 13):\n" + string.Join("\n", mismatches));
    }

    [Fact]
    public void ExemptFilesDeclareOnlyScheduledTasks()
    {
        var types = Arch.PluginTypes().Where(t => t.GetCustomAttribute<CompilerGeneratedAttribute>() == null).ToList();
        var bad = new List<string>();
        var checkedFiles = 0;
        foreach (var path in FileSizeTests.SourceFiles().Select(f => f.Path).Where(p => p.StartsWith("Features/", StringComparison.Ordinal)))
        {
            var text = File.ReadAllText(Path.Combine(Arch.PluginSource, path));
            var declared = NamespaceDeclaration().Matches(text).Select(m => m.Groups[1].Value).ToList();
            if (!IsExempt(path, declared)) continue;
            checkedFiles++;
            var ns = declared[0];
            foreach (var name in TypeDeclaration().Matches(text).Select(m => m.Groups[1].Value).Distinct())
            {
                var matches = types.Where(t => t.Name == name && Arch.Outermost(t).Namespace == ns).ToList();
                if (matches.Count == 0) bad.Add($"{path}: declares {name}, not found in {ns}");
                bad.AddRange(matches.Where(t => !typeof(IScheduledTask).IsAssignableFrom(Arch.Outermost(t)))
                    .Select(t => $"{path}: {t.FullName} is not an IScheduledTask (or nested in one)"));
            }
        }
        var taskNamespace = types.Where(t => t.DeclaringType == null && t.Namespace == TaskNamespace).ToList();
        bad.AddRange(taskNamespace.Where(t => !typeof(IScheduledTask).IsAssignableFrom(t)).Select(t => $"{t.FullName}: in {TaskNamespace} but not an IScheduledTask"));
        var startup = types.SingleOrDefault(t => t.FullName == StartupType);
        if (startup == null || !typeof(IScheduledTask).IsAssignableFrom(startup)) bad.Add($"{StartupType}: missing or not an IScheduledTask");
        output.WriteLine($"exempt files checked: {checkedFiles}; {TaskNamespace}: {taskNamespace.Count} types");
        Assert.True(bad.Count == 0, string.Join("\n", bad));
        Assert.Equal(taskNamespace.Count + 1, checkedFiles);
    }

    [Fact]
    public void RetiredFoldersStayEmpty()
    {
        var files = FileSizeTests.SourceFiles().Select(f => f.Path).ToList();
        var found = files.Where(p => RetiredFolders.Any(f => p.StartsWith(f + "/", StringComparison.Ordinal))).ToList();
        output.WriteLine("retired folders: " + string.Join(", ", RetiredFolders.Select(f => $"{f}/ {(Directory.Exists(Path.Combine(Arch.PluginSource, f)) ? "exists" : "absent")}")));
        Assert.True(found.Count == 0, "Files in retired folders (backend.md §7.3):\n" + string.Join("\n", found));
        Assert.NotEmpty(files);
    }
}
