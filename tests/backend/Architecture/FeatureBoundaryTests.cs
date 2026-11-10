using System.Reflection;
using System.Text;
using System.Text.Json;
using Xunit.Abstractions;

namespace JE.Tests.Architecture;

// Guardrail §7.2 (artifacts/restructure-plan/backend.md), FAILING for every feature from S3 (S0–S2 enforced it per
// feature through an "enforced" list in feature-dependencies.json, now retired). Reflection only: for every
// type declared under Features/<A>/, the types it references through constructor/method parameters, return types,
// fields, properties, base types and IL member/type tokens (the Gate B decoder). An edge Features.<A> → Features.<B>
// is a finding unless allow-listed; a controller may reference no other feature at all. One exception for both
// (coordinator decision, step 8; backend.md §7.7): a reference into another feature's own Features/<B>/PublicApi/
// forwarders is allowed, the forwarding-only surface that feature defines for the others. Anything else in
// Features/<B>/ stays a finding.
//
// Types are attributed by the FOLDER of their source file, not by namespace (review G1, round 13; SourceFolders.cs).
// So the scheduled-task types in Features/<F>/Tasks/ (namespace …ScheduledTasks) and StartupService
// (Features/Platform/Services/, namespace …Services) are scanned as members of their folder's feature, and Shared/ or
// Infrastructure/ files with legacy namespaces are inside the M2 ratchet below.
//
// Shared/** and Infrastructure/** (review M2): moving a type out of Features/<A>/ into Shared can launder a
// cross-feature edge (Features.<B> → Shared.X → Features.<A>), and the scan above never looked there. Their references
// into Features/** are therefore RATCHETED: shared-feature-references.baseline.json records, per referencing top-level
// type → referenced Features type, how often it is referenced (each signature slot and each IL token, nested and
// compiler-generated types counted with their outermost type). Both sides are keyed "<folder>/<type name>", so a
// namespace rename does not re-key an edge. A new edge or a higher count fails; a lower count or a vanished edge is a
// note (shrink the file). The baseline was re-measured once by folder in round 13 (namespace-keyed it missed the
// legacy-namespace files) and widens nothing.
public class FeatureBoundaryTests(ITestOutputHelper output)
{
    private const BindingFlags All = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static | BindingFlags.DeclaredOnly;

    // By source folder (review G1): Features/<F>/** -> F.
    internal static string? FeatureOf(Type type) => SourceFolders.FeatureOf(type);

    // A type under Features/<F>/PublicApi/: the surface feature F offers the other features.
    internal static bool IsPublicApi(Type type) => SourceFolders.IsPublicApi(type);

    private static IEnumerable<Type> Expand(Type? type)
    {
        if (type == null) yield break;
        if (type.HasElementType) { foreach (var t in Expand(type.GetElementType())) yield return t; yield break; }
        if (type.IsGenericParameter) yield break;
        yield return type;
        if (type.IsGenericType)
            foreach (var argument in type.GetGenericArguments())
                foreach (var t in Expand(argument)) yield return t;
    }

    internal static IEnumerable<Type> References(Type type)
    {
        var direct = new List<Type?> { type.BaseType };
        direct.AddRange(type.GetInterfaces());
        direct.AddRange(type.GetFields(All).Select(f => f.FieldType));
        direct.AddRange(type.GetProperties(All).Select(p => p.PropertyType));
        foreach (var method in Arch.AllMethods(type))
        {
            direct.AddRange(method.GetParameters().Select(p => p.ParameterType));
            if (method is MethodInfo info) direct.Add(info.ReturnType);
            foreach (var member in Arch.IlReferences(method))
                direct.Add(member as Type ?? member.DeclaringType);
        }
        foreach (var nested in type.GetNestedTypes(BindingFlags.Public | BindingFlags.NonPublic))
            direct.AddRange(nested.GetFields(All).Select(f => f.FieldType));
        return direct.SelectMany(Expand).Distinct();
    }

    // allowType: per referencing type (SourceFolders.Key, "<folder>/<type>"), the other features it may reference.
    // Narrower than an `allow` feature edge; used for the edges review G1 made visible (round 13).
    private sealed record Map(Dictionary<string, string[]> Allow, Dictionary<string, string[]> AllowType);

    private static Map LoadMap()
    {
        using var json = JsonDocument.Parse(File.ReadAllText(Path.Combine(Arch.SnapshotDirectory, "feature-dependencies.json")));
        Assert.False(json.RootElement.TryGetProperty("enforced", out _), "feature-dependencies.json: \"enforced\" is retired; every feature is enforced (S3)");
        var allow = json.RootElement.GetProperty("allow").EnumerateObject()
            .ToDictionary(p => p.Name, p => p.Value.EnumerateArray().Select(e => e.GetString()!).ToArray());
        var allowType = json.RootElement.TryGetProperty("allowType", out var byType)
            ? byType.EnumerateObject().ToDictionary(p => p.Name, p => p.Value.EnumerateArray().Select(e => e.GetString()!).ToArray())
            : new Dictionary<string, string[]>();
        return new Map(allow, allowType);
    }

    [Fact]
    public void FeatureReferencesStayInsideTheAllowList()
    {
        var map = LoadMap();
        var featureTypes = Arch.PluginTypes().Where(t => t.DeclaringType == null && !SourceFolders.IsCompilerGenerated(t) && FeatureOf(t) != null).ToList();
        var findings = new List<(string Feature, string Text)>();
        var edges = new SortedSet<string>(StringComparer.Ordinal);
        var typeEdges = new SortedSet<string>(StringComparer.Ordinal);
        foreach (var type in featureTypes)
        {
            var from = FeatureOf(type)!;
            var isController = Arch.IsControllerType(type);
            foreach (var target in References(type).Where(t => t.Assembly == Arch.Plugin))
            {
                var to = FeatureOf(target);
                if (to == null || to == from) continue;
                var publicApi = IsPublicApi(target);
                edges.Add($"{from} -> {to}{(publicApi ? " (PublicApi)" : "")}");
                var typeAllowed = !isController && map.AllowType.TryGetValue(SourceFolders.Key(type), out var typeTargets) && typeTargets.Contains(to);
                if (typeAllowed) typeEdges.Add($"{SourceFolders.Key(type)} -> {to}");
                var allowed = publicApi || typeAllowed || (!isController && map.Allow.TryGetValue(from, out var targets) && (targets.Contains("*") || targets.Contains(to)));
                if (!allowed) findings.Add((from, $"{type.Name} ({from}{(isController ? ", controller" : "")}) -> {target.Name} ({to})"));
            }
        }
        output.WriteLine($"feature folders: {string.Join(", ", featureTypes.Select(FeatureOf).Distinct().Order(StringComparer.Ordinal))}");
        output.WriteLine($"types under Features/: {featureTypes.Count} (incl. {featureTypes.Count(t => !(t.Namespace ?? "").StartsWith(Arch.PluginNamespace + ".Features.", StringComparison.Ordinal))} outside a Features.* namespace); cross-feature edges: {edges.Count}; findings: {findings.Count}; enforced: every feature");
        foreach (var edge in edges) output.WriteLine("edge: " + edge);
        foreach (var (from, targets) in map.Allow)
            foreach (var to in targets.Where(to => to != "*" && !edges.Contains($"{from} -> {to}")))
                output.WriteLine($"note: allow-list entry {from} -> {to} is unused");
        foreach (var (key, targets) in map.AllowType)
            foreach (var to in targets.Where(to => !typeEdges.Contains($"{key} -> {to}")))
                output.WriteLine($"note: allowType entry {key} -> {to} is unused");
        foreach (var edge in typeEdges) output.WriteLine("allowType edge: " + edge);
        foreach (var finding in findings) output.WriteLine("finding: " + finding.Text);
        Assert.True(findings.Count == 0, "Cross-feature references outside feature-dependencies.json (backend.md §7.2):\n" + string.Join("\n", findings.Select(f => f.Text)));
    }

    public const string SharedBaselineFile = "shared-feature-references.baseline.json";
    // By source folder (review G1): every type declared under Shared/ or Infrastructure/, whatever its namespace.
    internal static bool IsSharedOrInfrastructure(Type type) => SourceFolders.IsSharedOrInfrastructure(type);

    // Every occurrence (not distinct) of a type in the signatures and IL of `type` and its nested types.
    private static IEnumerable<Type> ReferenceOccurrences(Type type)
    {
        var direct = new List<Type?> { type.BaseType };
        direct.AddRange(type.GetInterfaces());
        direct.AddRange(type.GetFields(All).Select(f => f.FieldType));
        direct.AddRange(type.GetProperties(All).Select(p => p.PropertyType));
        const BindingFlags declared = All;
        foreach (var method in type.GetMethods(declared).Cast<MethodBase>().Concat(type.GetConstructors(declared)))
        {
            direct.AddRange(method.GetParameters().Select(p => p.ParameterType));
            if (method is MethodInfo info) direct.Add(info.ReturnType);
            foreach (var member in Arch.IlReferences(method))
                direct.Add(member as Type ?? member.DeclaringType);
        }
        foreach (var t in direct.SelectMany(Expand)) yield return t;
        foreach (var nested in type.GetNestedTypes(BindingFlags.Public | BindingFlags.NonPublic))
            foreach (var t in ReferenceOccurrences(nested)) yield return t;
    }

    internal static SortedDictionary<string, int> SharedFeatureEdges()
    {
        var edges = new SortedDictionary<string, int>(StringComparer.Ordinal);
        foreach (var type in Arch.PluginTypes().Where(t => t.DeclaringType == null && !SourceFolders.IsCompilerGenerated(t) && IsSharedOrInfrastructure(t)))
        {
            foreach (var target in ReferenceOccurrences(type).Where(t => t.Assembly == Arch.Plugin && FeatureOf(t) != null))
            {
                var key = $"{SourceFolders.Key(type)} -> {SourceFolders.Key(target)}";
                edges[key] = edges.GetValueOrDefault(key) + 1;
            }
        }
        return edges;
    }

    internal static string RenderSharedBaseline(SortedDictionary<string, int> edges)
    {
        var text = new StringBuilder("{\n  \"comment\": ");
        text.Append(JsonSerializer.Serialize("FeatureBoundaryTests ratchet (review M2; folder-keyed since round 13, review G1): references from types declared under Shared/ or Infrastructure/ into types declared under Features/, keyed <folder>/<referencing top-level type> -> <folder>/<referenced type>: occurrences. A new edge or a higher count fails; lower counts are a note, so shrink this file when an edge goes away. Never add an edge to make the test pass.", Arch.Json));
        text.Append(",\n  \"edges\": {\n");
        text.Append(string.Join(",\n", edges.Select(e => $"    {JsonSerializer.Serialize(e.Key, Arch.Json)}: {e.Value}")));
        text.Append("\n  }\n}\n");
        return text.ToString();
    }

    [Fact]
    public void SharedAndInfrastructureFeatureReferencesDoNotGrow()
    {
        var edges = SharedFeatureEdges();
        var path = Path.Combine(Arch.SnapshotDirectory, SharedBaselineFile);
        output.WriteLine($"Shared/Infrastructure -> Features edges: {edges.Count}, occurrences: {edges.Values.Sum()}");
        foreach (var edge in edges) output.WriteLine($"edge: {edge.Key}: {edge.Value}");
        if (Arch.UpdateSnapshots)
        {
            File.WriteAllText(path, RenderSharedBaseline(edges), new UTF8Encoding(false));
            return;
        }
        using var json = JsonDocument.Parse(File.ReadAllText(path));
        var baseline = json.RootElement.GetProperty("edges").EnumerateObject().ToDictionary(p => p.Name, p => p.Value.GetInt32(), StringComparer.Ordinal);
        var grown = edges.Where(e => e.Value > baseline.GetValueOrDefault(e.Key))
            .Select(e => baseline.TryGetValue(e.Key, out var was) ? $"{e.Key}: {was} -> {e.Value}" : $"{e.Key}: new ({e.Value})").ToList();
        foreach (var gone in baseline.Where(b => edges.GetValueOrDefault(b.Key) < b.Value))
            output.WriteLine($"note: {gone.Key}: baseline {gone.Value}, now {edges.GetValueOrDefault(gone.Key)} (shrink {SharedBaselineFile})");
        Assert.True(grown.Count == 0, $"Shared/Infrastructure -> Features references grew beyond {SharedBaselineFile}:\n" + string.Join("\n", grown));
    }
    // Review G1: the folder map behind both rules must place every top-level plugin type, each in one folder, and the
    // types whose namespace disagrees with their folder are listed (the §7.8 task/startup exemptions and any legacy
    // Shared/Infrastructure namespaces), so the scan cannot silently drop a type again.
    [Fact]
    public void SourceFoldersPlaceEveryPluginType()
    {
        var types = Arch.PluginTypes().Where(t => t.DeclaringType == null && !SourceFolders.IsCompilerGenerated(t)).ToList();
        var missing = types.Where(t => SourceFolders.FileOf(t) == null).Select(t => t.FullName).ToList();
        var split = types.Select(t => (Type: t, Files: SourceFolders.TypeFiles.TryGetValue((t.IsGenericType ? t.GetGenericTypeDefinition() : t).FullName!, out var f) ? f : null))
            .Where(x => x.Files != null && x.Files.Select(f => Path.GetDirectoryName(f)).Distinct().Count() > 1)
            .Select(x => $"{x.Type.FullName}: {string.Join(", ", x.Files!)}").ToList();
        // Area granularity, as FolderNamespaceTests checks it: Features/<F>/** -> …Features.<F>[.*], Shared/<A>/** ->
        // …Shared.<A>[.*], Infrastructure/<A>/** -> …Infrastructure.<A>[.*]; other folders are not listed.
        static string? AreaNamespace(string file)
        {
            var parts = file.Split('/');
            return parts.Length > 2 && parts[0] is "Features" or "Shared" or "Infrastructure" ? $"{Arch.PluginNamespace}.{parts[0]}.{parts[1]}" : null;
        }
        var mismatched = types.Where(t => SourceFolders.FileOf(t) is { } file && AreaNamespace(file) is { } expected
                && t.Namespace != expected && !(t.Namespace ?? "").StartsWith(expected + ".", StringComparison.Ordinal))
            .Select(t => $"{SourceFolders.FileOf(t)}: {t.FullName}").Order(StringComparer.Ordinal).ToList();
        output.WriteLine($"top-level plugin types: {types.Count}; placed by folder: {types.Count - missing.Count}; namespace differs from folder: {mismatched.Count}");
        foreach (var line in mismatched) output.WriteLine("namespace != folder: " + line);
        var otherLayers = types.Where(t => SourceFolders.FileOf(t) is { } file && !file.StartsWith("Features/", StringComparison.Ordinal) && !IsSharedOrInfrastructure(t))
            .SelectMany(t => ReferenceOccurrences(t).Where(r => r.Assembly == Arch.Plugin && FeatureOf(r) != null).Select(r => $"{SourceFolders.Key(t)} -> {SourceFolders.Key(r)}"))
            .Distinct().Order(StringComparer.Ordinal).ToList();
        output.WriteLine($"not ratcheted (root, Configuration/, Transport/) -> Features edges: {otherLayers.Count}");
        foreach (var edge in otherLayers) output.WriteLine("other-layer edge: " + edge);
        Assert.True(missing.Count == 0, "Types the source-folder scan did not place:\n" + string.Join("\n", missing));
        Assert.True(split.Count == 0, "Types declared in more than one folder:\n" + string.Join("\n", split));
    }
}
