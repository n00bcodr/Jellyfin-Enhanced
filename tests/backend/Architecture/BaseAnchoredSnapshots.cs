using System.Reflection;
using System.Runtime.Loader;
using System.Text;

namespace JE.Tests.Architecture;

// Base-anchored snapshots (lane L-G, artifacts/restructure-plan/step-logs/lane-lg.md). A `*.base.json` expected file is
// written ONLY from a build of the tag `restructure-base` (the tree before step 1), never from the tree under test, so
// a passing test proves the current tree still matches the pre-restructure plugin in that area:
//   JE_ARCH_PLUGIN_DLL=<path>  analyse that Jellyfin.Plugin.JellyfinEnhanced.dll (loaded in its own AssemblyLoadContext;
//                              every dependency still comes from this test project) instead of the referenced plugin.
//   JE_ARCH_WRITE_BASE=1       with JE_ARCH_PLUGIN_DLL only: write the *.base.json files instead of comparing them.
//   JE_ARCH_BASE_LABEL=<text>  the "anchor" recorded in a written file; it must start with "restructure-base".
// Without JE_ARCH_PLUGIN_DLL the tests compare the plugin the test project references (the current tree). With it and
// without JE_ARCH_WRITE_BASE they compare that DLL, so any later tree's build can be checked the same way. The
// "anchor" line is metadata and is not compared. JE_UPDATE_SNAPSHOTS never rewrites these files.
internal static class BaseAnchored
{
    public const string AnchorPrefix = "restructure-base";

    private static readonly string? ExternalPath = Environment.GetEnvironmentVariable("JE_ARCH_PLUGIN_DLL") is { Length: > 0 } p ? Path.GetFullPath(p) : null;

    public static Assembly Subject { get; } = ExternalPath == null ? Arch.Plugin : LoadExternal(ExternalPath);

    public static string SubjectLabel => ExternalPath ?? "referenced plugin (current tree)";

    public static bool Write => Environment.GetEnvironmentVariable("JE_ARCH_WRITE_BASE") == "1";

    private sealed class PluginOnlyContext(string pluginPath) : AssemblyLoadContext("je-arch-subject")
    {
        private readonly string _name = AssemblyName.GetAssemblyName(pluginPath).Name!;

        // Only the plugin itself is loaded from the external build; framework, Jellyfin and NuGet dependencies fall
        // back to the default context, so ControllerBase, IServiceCollection, … are the same types the tests use.
        protected override Assembly? Load(AssemblyName assemblyName)
            => assemblyName.Name == _name ? LoadFromAssemblyPath(pluginPath) : null;
    }

    private static Assembly LoadExternal(string path)
    {
        if (!File.Exists(path)) throw new FileNotFoundException("JE_ARCH_PLUGIN_DLL does not exist", path);
        return new PluginOnlyContext(path).LoadFromAssemblyPath(path);
    }

    public static Type[] Types(Assembly assembly)
    {
        try { return assembly.GetTypes(); }
        catch (ReflectionTypeLoadException e) { return e.Types.Where(t => t != null).ToArray()!; }
    }

    // `body` is the rendered snapshot WITHOUT the anchor line: "{\n" + entries + "}\n".
    public static void Verify(string fileName, string body)
    {
        var path = Path.Combine(Arch.SnapshotDirectory, fileName);
        body = body.ReplaceLineEndings("\n");
        if (Write)
        {
            Assert.True(ExternalPath != null, "JE_ARCH_WRITE_BASE=1 needs JE_ARCH_PLUGIN_DLL: *.base.json files are generated from a restructure-base build only.");
            var label = Environment.GetEnvironmentVariable("JE_ARCH_BASE_LABEL") ?? "";
            Assert.True(label.StartsWith(AnchorPrefix, StringComparison.Ordinal), "JE_ARCH_BASE_LABEL must name the restructure-base build (e.g. \"restructure-base 837635b9\").");
            Assert.StartsWith("{\n", body);
            File.WriteAllText(path, "{\n  \"anchor\": " + System.Text.Json.JsonSerializer.Serialize(label, Arch.Json) + ",\n" + body[2..], new UTF8Encoding(false));
            return;
        }
        Assert.True(File.Exists(path), $"{path} is missing. It is generated from a restructure-base build (see BaseAnchoredSnapshots.cs).");
        var lines = File.ReadAllText(path).ReplaceLineEndings("\n").Split('\n').ToList();
        Assert.True(lines.Count > 1 && lines[1].StartsWith("  \"anchor\": \"" + AnchorPrefix, StringComparison.Ordinal),
            $"{fileName} has no restructure-base anchor line; it must be generated from a restructure-base build.");
        lines.RemoveAt(1);
        Arch.AssertSameLines(string.Join("\n", lines), body,
            $"{fileName} is anchored to restructure-base and is never regenerated from a later tree. Subject: {SubjectLabel}.");
    }
}
