using Xunit.Abstractions;

namespace JE.Tests.Architecture;

// Guardrail §7.1 (artifacts/restructure-plan/backend.md), FAILING from S3: any *.cs under Features/** or Shared/** over
// 1,500 lines, and any Je*Controller*.cs over 1,200 lines, fails. Generated *.g.cs files are exempt. Over-cap
// controllers are split into partials Je<Feature>Controller.<Area>.cs (§7.9) and never allow-listed.
//
// AllowList holds the offenders that existed when S3 turned the gate on, each with its line count then. It may only
// shrink: an allow-listed file fails when it grows past its recorded count, and a file back under the limit is a note
// asking for its entry to be removed (lower the count when the file shrinks). Never add an entry.
public class FileSizeTests(ITestOutputHelper output)
{
    public const int FeatureFileLimit = 1500;
    public const int ControllerFileLimit = 1200;

    // §7.1 names TagCacheService.cs (4,123 at the plan's count) as the first allow-list entry; the other files it
    // listed (PosterTagSettings, SpoilerFieldStripFilter, SpoilerBlurImageFilter, SeerrParentalFilter,
    // PosterTagRenderer) are under 1,500 lines today and need no entry.
    public static readonly IReadOnlyDictionary<string, int> AllowList = new Dictionary<string, int>(StringComparer.Ordinal)
    {
        ["Features/MediaTags/Services/TagCache/TagCacheService.cs"] = 4084,
    };

    internal static IEnumerable<(string Path, int Lines)> SourceFiles()
    {
        var root = Arch.PluginSource;
        return Directory.EnumerateFiles(root, "*.cs", SearchOption.AllDirectories)
            .Select(f => Path.GetRelativePath(root, f).Replace('\\', '/'))
            .Where(f => !f.StartsWith("bin/", StringComparison.Ordinal) && !f.StartsWith("obj/", StringComparison.Ordinal))
            .Order(StringComparer.Ordinal)
            .Select(f => (f, File.ReadLines(Path.Combine(root, f)).Count()));
    }

    internal static int? LimitFor(string path)
    {
        if (path.EndsWith(".g.cs", StringComparison.Ordinal)) return null;
        var name = Path.GetFileName(path);
        if (name.StartsWith("Je", StringComparison.Ordinal) && name.Contains("Controller", StringComparison.Ordinal)) return ControllerFileLimit;
        return path.StartsWith("Features/", StringComparison.Ordinal) || path.StartsWith("Shared/", StringComparison.Ordinal) ? FeatureFileLimit : null;
    }

    [Fact]
    public void FilesStayUnderTheSizeLimits()
    {
        var files = SourceFiles().ToList();
        var lines = files.ToDictionary(f => f.Path, f => f.Lines, StringComparer.Ordinal);
        var failures = new List<string>();
        foreach (var (path, count) in files)
        {
            if (LimitFor(path) is not int limit || count <= limit) continue;
            if (AllowList.TryGetValue(path, out var cap) && limit == FeatureFileLimit)
            {
                if (count > cap) failures.Add($"{path}: {count} lines, allow-listed at {cap} (an allow-listed file may not grow)");
                else output.WriteLine($"allow-listed: {path} {count} (cap {cap})");
                continue;
            }
            failures.Add($"{path}: {count} lines, limit {limit}{(limit == ControllerFileLimit ? " (split into partials, backend.md §7.9)" : "")}");
        }
        foreach (var (path, cap) in AllowList)
        {
            if (!lines.TryGetValue(path, out var count)) output.WriteLine($"note: allow-listed {path} no longer exists; remove its entry");
            else if (count <= FeatureFileLimit) output.WriteLine($"note: allow-listed {path} is {count} lines, under the limit; remove its entry");
            else if (count < cap) output.WriteLine($"note: allow-listed {path} shrank to {count} (cap {cap}); lower its entry");
        }
        foreach (var file in files.Where(f => !f.Path.EndsWith(".g.cs", StringComparison.Ordinal) && f.Lines > FeatureFileLimit && LimitFor(f.Path) == null))
            output.WriteLine($"outside the guardrail's scope, over {FeatureFileLimit}: {file.Path} {file.Lines}");
        output.WriteLine($"plugin .cs files: {files.Count}; failures: {failures.Count}");
        Assert.NotEmpty(files);
        Assert.True(failures.Count == 0, "Files over the backend.md §7.1 size limits:\n" + string.Join("\n", failures));
    }

    [Fact]
    public void AllowListOnlyNamesFeatureOrSharedFiles()
    {
        foreach (var path in AllowList.Keys)
            Assert.True(LimitFor(path) == FeatureFileLimit, $"{path}: only Features/** or Shared/** files (never a controller) may be allow-listed");
    }
}
