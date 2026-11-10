using System.Reflection;
using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Infrastructure.Assets;
using JE.Tests.Architecture;

namespace JE.Tests;

// perf-runtime: the client's bulky text assets are embedded packed (scripts/pack-embedded.mjs, the project's
// JePackedAsset items) and read back through PackedResources. Unpacked they made the plugin DLL 31.7 MB, twice the
// 14,956,032 bytes of the release it replaces.
public class PackedResourcesTests
{
    private static readonly Assembly Plugin = typeof(Jellyfin.Plugin.JellyfinEnhanced.JellyfinEnhanced).Assembly;
    private static readonly string PluginDirectory = Path.Combine(Arch.RepoRoot, "Jellyfin.Plugin.JellyfinEnhanced");

    private static IEnumerable<string> ClientFiles()
        => new[] { "js", "min" }.SelectMany(root => Directory.EnumerateFiles(Path.Combine(PluginDirectory, root), "*", SearchOption.AllDirectories))
            .Select(file => Path.GetRelativePath(PluginDirectory, file).Replace('\\', '/')).OrderBy(path => path, StringComparer.Ordinal);

    private static string ResourceName(string path) => "Jellyfin.Plugin.JellyfinEnhanced." + path.Replace('/', '.');

    [Fact]
    public void EveryClientFileReadsBackByteForByteUnderItsOwnResourceName()
    {
        var files = ClientFiles().ToList();
        Assert.True(files.Count > 500, $"Only {files.Count} files under js/ and min/.");
        foreach (var path in files)
        {
            var name = ResourceName(path);
            Assert.True(PackedResources.Exists(Plugin, name), $"{path} is not an embedded resource.");
            using var stream = PackedResources.Open(Plugin, name)!;
            Assert.True(stream.CanSeek, $"{path}: a file result needs the content length.");
            var expected = File.ReadAllBytes(Path.Combine(PluginDirectory, path));
            Assert.Equal(expected.LongLength, stream.Length);
            var actual = new byte[expected.Length];
            stream.ReadExactly(actual);
            Assert.True(expected.AsSpan().SequenceEqual(actual), $"{path} reads back differently.");
        }
        Assert.Null(PackedResources.Open(Plugin, ResourceName("js/no-such-script.js")));
        Assert.False(PackedResources.Exists(Plugin, ResourceName("js/no-such-script.js")));
    }

    [Fact]
    public void ScriptsMapsTwinsAndLocalesArePackedAndTheEnumeratedFilesAreNot()
    {
        var raw = Plugin.GetManifestResourceNames().ToHashSet(StringComparer.Ordinal);
        foreach (var path in ClientFiles())
        {
            var name = ResourceName(path);
            var sections = path.StartsWith("js/enhanced/admintags/sections/", StringComparison.Ordinal);
            var packed = path.EndsWith(".map", StringComparison.Ordinal)
                || (path.EndsWith(".js", StringComparison.Ordinal) && !sections)
                || (path.StartsWith("js/locales/", StringComparison.Ordinal) && path.EndsWith(".json", StringComparison.Ordinal));
            Assert.True(raw.Contains(packed ? name + PackedResources.PackedSuffix : name), $"{path} should be embedded {(packed ? "packed" : "as it is")}.");
            Assert.False(raw.Contains(packed ? name : name + PackedResources.PackedSuffix), $"{path} is embedded twice.");
        }
        // Readers that enumerate names see each resource once, under the name they read it by.
        var names = PackedResources.Names(Plugin).ToList();
        Assert.Equal(raw.Count, names.Count);
        Assert.Equal(names.Count, names.Distinct(StringComparer.Ordinal).Count());
        Assert.DoesNotContain(names, name => name.EndsWith(PackedResources.PackedSuffix, StringComparison.Ordinal));
        Assert.Contains(ResourceName("js/locales/en.json"), names);
    }

    // A reader that asks the assembly for a resource by its plain name finds nothing once that resource is packed, and
    // most readers treat "nothing" as "no such file": the native tag captions (StatusRules) read js/locales/<lang>.json
    // that way and fell back to showing their keys. So nothing in the plugin but PackedResources asks the assembly.
    [Fact]
    public void OnlyPackedResourcesAsksTheAssemblyForAResource()
    {
        var outputs = new[] { "bin", "obj" }.Select(name => Path.Combine(PluginDirectory, name) + Path.DirectorySeparatorChar).ToArray();
        var sources = Directory.EnumerateFiles(PluginDirectory, "*.cs", SearchOption.AllDirectories)
            .Where(file => !outputs.Any(output => file.StartsWith(output, StringComparison.Ordinal))).ToList();
        Assert.True(sources.Count > 200, $"Only {sources.Count} C# sources under {PluginDirectory}.");
        var direct = sources.Where(file => Path.GetFileName(file) != "PackedResources.cs")
            .SelectMany(file => File.ReadLines(file).Select((text, index) => (file, line: index + 1, text)))
            .Where(found => found.text.Contains("GetManifestResource", StringComparison.Ordinal))
            .Select(found => $"{Path.GetRelativePath(PluginDirectory, found.file).Replace('\\', '/')}:{found.line}")
            .ToList();
        Assert.True(direct.Count == 0, "Read embedded resources through PackedResources (Open, Exists, Names), not from the assembly: " + string.Join(", ", direct));
    }

    // The captions the server draws on native clients' posters come from the packed locales.
    [Fact]
    public void ThePackedLocalesAreWhatTheServerSideCaptionsAreReadFrom()
    {
        using var stream = PackedResources.Open(Plugin, ResourceName("js/locales/en.json"))!;
        using var english = JsonDocument.Parse(stream);
        var expected = english.RootElement.GetProperty("language_tags_dual").GetString();
        Assert.False(string.IsNullOrEmpty(expected));
        Assert.Equal(expected, Jellyfin.Plugin.JellyfinEnhanced.Shared.MediaTags.PosterTags.Resolution.StatusRules.Text("language_tags_dual", System.Globalization.CultureInfo.GetCultureInfo("en")));
    }

    // The size budget (client/assembly-budget.json) is a ratchet like the bundle's: lowering it needs no reason, a
    // history entry that raises it must give one. It would have caught the DLL doubling when the source maps and the
    // minified twins were first embedded. It counts what the assembly embeds, not the DLL file's length: this suite
    // runs with coverage in gate T, and the file on disk is then the instrumented copy (0.65 MB longer), while the
    // resources are the same bytes either way. The DLL is the resources plus about 3 MB of code.
    [Fact]
    public void WhatThePluginAssemblyEmbedsIsWithinTheCheckedInSizeBudget()
    {
        using var json = JsonDocument.Parse(File.ReadAllText(Path.Combine(Arch.RepoRoot, "client", "assembly-budget.json")));
        var limit = json.RootElement.GetProperty("limits").GetProperty("embeddedBytes").GetInt64();
        var history = json.RootElement.GetProperty("history").EnumerateArray().ToArray();
        Assert.NotEmpty(history);
        Assert.Equal(limit, history[^1].GetProperty("limits").GetProperty("embeddedBytes").GetInt64());
        for (var i = 0; i < history.Length; i++)
        {
            var bytes = history[i].GetProperty("limits").GetProperty("embeddedBytes").GetInt64();
            var rises = i == 0 || bytes > history[i - 1].GetProperty("limits").GetProperty("embeddedBytes").GetInt64();
            var reason = history[i].TryGetProperty("reason", out var r) ? r.GetString() ?? "" : "";
            Assert.True(!rises || reason.Trim().Length >= 20, $"history[{i}] sets or raises the budget, so it needs a \"reason\" (at least 20 characters).");
        }

        long embedded = 0;
        foreach (var name in Plugin.GetManifestResourceNames())
        {
            using var stream = Plugin.GetManifestResourceStream(name)!;
            embedded += stream.Length;
        }
        Assert.True(embedded <= limit,
            $"{Path.GetFileName(Plugin.Location)} embeds {embedded:N0} bytes, over the {limit:N0} budget in client/assembly-budget.json. Embed less (or pack it), or raise the budget in a new history entry with a reason.");
    }
}
