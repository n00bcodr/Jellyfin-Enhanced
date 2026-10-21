using System.Reflection;
using System.Text.Json;

namespace JE.Tests;

/// <summary>
/// Builds plugin objects the way dependency injection does: by their widest constructor whose parameters the parts given
/// can fill (by type), the rest left at their defaults. A test written before a constructor gains a dependency builds and
/// runs against both shapes (before it, the dependency is simply not there).
/// </summary>
internal static class Wiring
{
    /// <summary>A <typeparamref name="T"/> from <paramref name="parts"/> (see the class remarks).</summary>
    public static T Make<T>(params object?[] parts) => (T)Make(typeof(T), parts)!;

    /// <summary>An instance of the plugin type named <paramref name="typeName"/> (full name), or null when the plugin has no such type.</summary>
    public static object? MakeNamed(string typeName, params object?[] parts)
        => typeof(Jellyfin.Plugin.JellyfinEnhanced.JellyfinEnhanced).Assembly.GetType(typeName) is { } type ? Make(type, parts) : null;

    /// <summary>An instance of <paramref name="type"/> from <paramref name="parts"/>.</summary>
    public static object Make(Type type, params object?[] parts)
    {
        foreach (var ctor in type.GetConstructors(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic).OrderByDescending(c => c.GetParameters().Length))
        {
            var ps = ctor.GetParameters();
            var args = new object?[ps.Length];
            var ok = true;
            for (var i = 0; i < ps.Length && ok; i++)
            {
                var match = parts.FirstOrDefault(p => p != null && ps[i].ParameterType.IsInstanceOfType(p));
                if (match != null) args[i] = match;
                else if (ps[i].HasDefaultValue) args[i] = ps[i].DefaultValue;
                else ok = false;
            }
            if (ok) return ctor.Invoke(args);
        }
        throw new InvalidOperationException($"No constructor of {type.Name} can be filled from the parts given.");
    }

    /// <summary>A value read from JSON with the web defaults (what a controller binds a request body to).</summary>
    public static T Body<T>(string json) => JsonSerializer.Deserialize<T>(json, new JsonSerializerOptions(JsonSerializerDefaults.Web))!;

    /// <summary>A record with one more JSON property set (a property the type may not have yet is dropped by it).</summary>
    public static T With<T>(T value, string property, object? set)
    {
        var node = System.Text.Json.Nodes.JsonNode.Parse(JsonSerializer.Serialize(value))!.AsObject();
        node[property] = set == null ? null : System.Text.Json.Nodes.JsonValue.Create(set);
        return JsonSerializer.Deserialize<T>(node.ToJsonString())!;
    }
}
