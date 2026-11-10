using System.Text.Json;
using Xunit.Abstractions;

namespace JE.Tests.Architecture;

// Feature-map parity, backend side (PLAN.md "Canonical feature list"; backend.md §7.4, §7.5). docs/feature-map.json
// is the one map of each feature's client folder, backend Features/ folder, controller and test folders; the frontend
// side is tests/frontend/architecture/feature-map.test.mjs. Here: the map's `backend` column is exactly the set of
// folders under Jellyfin.Plugin.JellyfinEnhanced/Features (no kebab-to-Pascal rule), each folder holds at most one
// controller type and it is the row's `controller` (partials Je<Feature>Controller.<Area>.cs allowed), and the
// backend test folders the map names exist, with no unmapped tests/backend/Features/* folder.
public class FeatureMapParityTests(ITestOutputHelper output)
{
    private const string BackendRoot = "Jellyfin.Plugin.JellyfinEnhanced/Features";

    private sealed record Row(string Name, string? Backend, string? Controller, string? ServedBy, string[] BackendTests);

    private static (string Root, List<Row> Rows) LoadMap()
    {
        using var json = JsonDocument.Parse(File.ReadAllText(Path.Combine(Arch.RepoRoot, "docs", "feature-map.json")));
        static string? Str(JsonElement row, string name) => row.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
        var rows = json.RootElement.GetProperty("features").EnumerateArray().Select(row => new Row(
            Str(row, "name")!,
            Str(row, "backend"),
            Str(row, "controller"),
            Str(row, "backendServedBy"),
            row.GetProperty("tests").GetProperty("backend").EnumerateArray().Select(e => e.GetString()!).ToArray())).ToList();
        return (json.RootElement.GetProperty("backendRoot").GetString()!, rows);
    }

    private static string[] FeatureFolders() => Directory.EnumerateDirectories(Path.Combine(Arch.RepoRoot, BackendRoot))
        .Select(Path.GetFileName).Select(n => n!).Order(StringComparer.Ordinal).ToArray();

    [Fact]
    public void BackendFoldersMatchTheMap()
    {
        var (root, rows) = LoadMap();
        Assert.Equal(BackendRoot, root);
        var mapped = rows.Where(r => r.Backend != null).Select(r => r.Backend!).Order(StringComparer.Ordinal).ToArray();
        var folders = FeatureFolders();
        output.WriteLine($"map rows: {rows.Count}; backend folders in the map: {string.Join(", ", mapped)}");
        output.WriteLine($"folders under {BackendRoot}: {string.Join(", ", folders)}");
        Assert.True(mapped.Distinct(StringComparer.Ordinal).Count() == mapped.Length, "two map rows name the same backend folder");
        var missing = mapped.Except(folders, StringComparer.Ordinal).ToList();
        var unmapped = folders.Except(mapped, StringComparer.Ordinal).ToList();
        Assert.True(missing.Count == 0, $"docs/feature-map.json names backend folders that do not exist under {BackendRoot}: {string.Join(", ", missing)}");
        Assert.True(unmapped.Count == 0, $"{BackendRoot} has folders with no docs/feature-map.json row: {string.Join(", ", unmapped)}");
        Assert.DoesNotContain("AdminTags", folders);
        foreach (var row in rows.Where(r => r.Backend == null))
            Assert.True(row.Controller == null && (row.ServedBy == null || mapped.Contains(row.ServedBy)),
                $"{row.Name}: a row without a backend folder has no controller, and its backendServedBy (if any) is a mapped folder");
        foreach (var row in rows.Where(r => r.Backend != null))
            Assert.True(row.ServedBy == null, $"{row.Name}: backendServedBy is only for rows without a backend folder");
    }

    [Fact]
    public void EachFeatureHasAtMostOneControllerAndItIsTheMappedOne()
    {
        var (_, rows) = LoadMap();
        var controllers = Arch.Controllers();
        var problems = new List<string>();
        foreach (var row in rows.Where(r => r.Backend != null))
        {
            var ns = $"{Arch.PluginNamespace}.Features.{row.Backend}";
            var inFeature = controllers.Where(c => c.Namespace == ns || c.Namespace!.StartsWith(ns + ".", StringComparison.Ordinal))
                .Select(c => c.Name).Order(StringComparer.Ordinal).ToArray();
            var expected = row.Controller == null ? Array.Empty<string>() : [row.Controller];
            if (!inFeature.SequenceEqual(expected))
                problems.Add($"{row.Backend}: controllers [{string.Join(", ", inFeature)}], map says [{string.Join(", ", expected)}]");
            if (row.Controller != null && row.Controller != $"Je{row.Backend}Controller")
                problems.Add($"{row.Backend}: controller {row.Controller} is not Je{row.Backend}Controller (backend.md §7.4)");

            var dir = Path.Combine(Arch.RepoRoot, BackendRoot, row.Backend!);
            var files = Directory.EnumerateFiles(dir, "Je*Controller*.cs", SearchOption.AllDirectories)
                .Select(f => Path.GetRelativePath(dir, f).Replace('\\', '/')).Order(StringComparer.Ordinal).ToList();
            foreach (var file in files)
            {
                var ok = row.Controller != null && (file == row.Controller + ".cs"
                    || (file.StartsWith(row.Controller + ".", StringComparison.Ordinal) && file.Count(c => c == '.') == 2 && !file.Contains('/')));
                if (!ok) problems.Add($"{row.Backend}: {file} is not {row.Controller ?? "(no controller)"}.cs or a partial {row.Controller}.<Area>.cs at the folder root");
            }
            output.WriteLine($"{row.Backend}: {string.Join(", ", files)}");
        }
        var outside = controllers.Where(c => FeatureBoundaryTests.FeatureOf(c) == null).Select(c => c.FullName).ToList();
        if (outside.Count > 0) problems.Add("controllers outside Features.*: " + string.Join(", ", outside));
        Assert.True(problems.Count == 0, string.Join("\n", problems));
    }

    [Fact]
    public void BackendTestFoldersMatchTheMap()
    {
        var (_, rows) = LoadMap();
        var named = rows.SelectMany(r => r.BackendTests).ToList();
        var problems = named.Where(p => !p.StartsWith("tests/backend/", StringComparison.Ordinal) || !Directory.Exists(Path.Combine(Arch.RepoRoot, p)))
            .Select(p => $"{p}: not an existing folder under tests/backend").ToList();
        var featureTests = Path.Combine(Arch.RepoRoot, "tests", "backend", "Features");
        var unmapped = Directory.EnumerateDirectories(featureTests).Select(d => "tests/backend/Features/" + Path.GetFileName(d))
            .Where(d => !named.Contains(d)).ToList();
        problems.AddRange(unmapped.Select(d => $"{d}: no docs/feature-map.json row names it"));
        foreach (var row in rows)
            foreach (var path in row.BackendTests.Where(p => p.StartsWith("tests/backend/Features/", StringComparison.Ordinal)))
                if (path != "tests/backend/Features/" + row.Backend)
                    problems.Add($"{row.Name}: {path} is not tests/backend/Features/{row.Backend}");
        output.WriteLine("backend test folders: " + string.Join(", ", named));
        Assert.True(problems.Count == 0, string.Join("\n", problems));
    }
}
