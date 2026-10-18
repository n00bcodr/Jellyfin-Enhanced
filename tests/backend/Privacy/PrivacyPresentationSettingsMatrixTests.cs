using System.Text.Json.Nodes;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Services;

namespace JE.Tests;

/// <summary>Frozen, bounded provider/JE field-path oracles; independent of runtime schema declarations.</summary>
public class PrivacyPresentationSettingsMatrixTests
{
    private static readonly JsonNode Matrix = ReadMatrix();
    private static JsonNode ReadMatrix()
    {
        using var stream = typeof(PrivacyPresentationSettingsMatrixTests).Assembly.GetManifestResourceStream("JE.Tests.ProviderContracts.SettingsMatrix")!;
        using var reader = new StreamReader(stream);
        return JsonNode.Parse(reader.ReadToEnd())!;
    }

    public static IEnumerable<object[]> Cells()
    {
        foreach (var sample in Matrix["samples"]!.AsArray())
        foreach (var kind in new[] { "movie", "tv" })
        foreach (var setting in Matrix["settings"]!.AsArray())
        foreach (var guarded in new[] { false, true })
        foreach (var master in new[] { false, true })
        foreach (var enabled in new[] { false, true })
            yield return new object[] { sample!["name"]!.ToString(), kind, setting!.ToString(), guarded, master, enabled };
    }

    [Theory]
    [MemberData(nameof(Cells))]
    public void EachSettingChangesExactlyItsOwnCapturedFields(string name, string kind, string setting, bool guarded, bool master, bool enabled)
    {
        var sample = Matrix["samples"]!.AsArray().Single(s => s!["name"]!.ToString() == name)!;
        var variant = sample["variants"]![kind]!;
        var raw = variant["body"]!;
        var config = new PluginConfiguration { SpoilerBlurEnabled = master, SpoilerKeepMoviePosters = true, SpoilerStripCastMode = "All" };
        foreach (var flag in Matrix["settings"]!.AsArray())
            typeof(PluginConfiguration).GetProperty(flag!.ToString())!.SetValue(config, flag.ToString() == "SpoilerKeepMoviePosters");
        typeof(PluginConfiguration).GetProperty(setting)!.SetValue(config, enabled);
        var state = new UserSpoilerBlur();
        var fields = Fields(raw);
        if (guarded)
        {
            state.ProviderTitles[$"{kind}:tmdb:42"] = new();
            foreach (var pair in fields.Where(p => p.Key.EndsWith("/id", StringComparison.Ordinal) || p.Key.EndsWith("/tmdbId", StringComparison.Ordinal)))
                if (int.TryParse(pair.Value, out var id) && id > 0) state.ProviderTitles[$"{kind}:tmdb:{id}"] = new();
            foreach (var pair in fields)
                if (pair.Value.Trim('"').Split(':') is { Length: >= 3 } parts && parts[1] == "tmdb")
                    state.ProviderTitles[$"{kind}:tmdb:{parts[2]}"] = new();
        }
        var resource = sample["resource"]!.ToString();
        if (sample["provider"] is { } provider)
            resource = ProviderPresentationSchema.ProviderResource(provider.ToString());
        var title = resource is "person" or "collection" or "named" or "named-lookup" or "named-search" or "person-search" ? null : $"{kind}:tmdb:42";
        var actual = JsonNode.Parse(new TitlePresentationPolicy(HiddenContentPolicy.Build(null), new SpoilerPresentationContext(state, config))
            .Project(raw.ToJsonString(), "discovery", title, resource, kind, sample["scope"]?.ToString(), resource == "calendar" ? 0 : 8, resource == "calendar" ? 0 : 6));
        var expected = raw.DeepClone();
        if (guarded && master)
        {
            var removals = new List<string>(variant["always"]!.AsArray().Select(p => p!.ToString()));
            foreach (var pair in variant["remove"]!.AsObject())
            {
                var on = pair.Key == "SpoilerKeepMoviePosters:false" ? !config.SpoilerKeepMoviePosters
                    : (bool)typeof(PluginConfiguration).GetProperty(pair.Key)!.GetValue(config)!;
                if (on) removals.AddRange(pair.Value!.AsArray().Select(p => p!.ToString()));
            }
            foreach (var path in removals.OrderBy(p => p.Length))
            {
                // Providers represent a suppressed collection as either absent or an empty array.
                if (At(actual, path) is JsonArray { Count: 0 }) Remove(ref actual, path);
                Remove(ref expected, path);
            }
            foreach (var group in variant["replace"]!.AsObject())
            {
                if (group.Key != "always" && !(bool)typeof(PluginConfiguration).GetProperty(group.Key)!.GetValue(config)!) continue;
                foreach (var pair in group.Value!.AsObject()) Set(expected, pair.Key, pair.Value?.DeepClone());
            }
        }
        StripNavigationAdditions(actual, raw);
        var before = Fields(expected);
        var after = Fields(actual);
        Assert.True(before.Keys.Order().SequenceEqual(after.Keys.Order()),
            $"{name}/{kind}/{setting}={enabled}, guard={guarded}, master={master}: lost [{string.Join(',', before.Keys.Except(after.Keys).Take(20))}], extra [{string.Join(',', after.Keys.Except(before.Keys).Take(20))}]");
        foreach (var pair in before) Assert.Equal(pair.Value, after[pair.Key]);
    }

    private static JsonNode? At(JsonNode? node, string path)
    {
        foreach (var part in path.Split('/', StringSplitOptions.RemoveEmptyEntries))
            node = node is JsonArray array ? int.TryParse(part, out var i) && i < array.Count ? array[i] : null : node is JsonObject obj ? obj[part] : null;
        return node;
    }

    private static void Remove(ref JsonNode? node, string path)
    {
        if (path == "") { node = null; return; }
        var at = path.LastIndexOf('/');
        if (At(node, path[..at]) is JsonObject parent) parent.Remove(path[(at + 1)..]);
    }

    private static void Set(JsonNode? node, string path, JsonNode? value)
    {
        var at = path.LastIndexOf('/');
        if (At(node, path[..at]) is JsonObject parent) parent[path[(at + 1)..]] = value;
    }

    private static void StripNavigationAdditions(JsonNode? node, JsonNode? original)
    {
        if (node is JsonObject obj)
        {
            obj.Remove("jeSpoiler");
            foreach (var field in new[] { "year", "contentRatings" }) if (original is JsonObject input && !input.ContainsKey(field)) obj.Remove(field);
            foreach (var pair in obj.ToArray()) StripNavigationAdditions(pair.Value, original is JsonObject raw ? raw[pair.Key] : null);
        }
        else if (node is JsonArray array)
            for (var i = 0; i < array.Count; i++) StripNavigationAdditions(array[i], original is JsonArray raw && i < raw.Count ? raw[i] : null);
    }

    private static Dictionary<string, string> Fields(JsonNode? node)
    {
        var result = new Dictionary<string, string>();
        void Walk(JsonNode? value, string path, int depth)
        {
            Assert.True(depth <= 20 && result.Count < 2000, "Matrix fixtures must stay bounded.");
            result[path] = value is JsonObject ? "object" : value is JsonArray ? "array" : value?.ToJsonString() ?? "null";
            if (value is JsonObject obj) foreach (var pair in obj) Walk(pair.Value, path + "/" + pair.Key, depth + 1);
            else if (value is JsonArray rows)
            {
                Assert.True(rows.Count <= 4, "Capture at most four representative rows per array.");
                for (var i = 0; i < rows.Count; i++) Walk(rows[i], path + "/" + i, depth + 1);
            }
        }
        Walk(node, "", 0);
        return result;
    }
}
