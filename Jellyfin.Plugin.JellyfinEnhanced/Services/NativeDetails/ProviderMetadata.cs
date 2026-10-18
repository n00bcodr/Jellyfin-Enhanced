using System.Text.Json;
using System.Text.RegularExpressions;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.NativeDetails;

/// <summary>Cross-version safe reads of public provider metadata; no native routing or synthetic writes.</summary>
internal static class ProviderMetadata
{
    private static readonly Regex Path = new("^/[A-Za-z0-9_.-]{1,80}$", RegexOptions.CultureInvariant);
    internal static bool SafeArtwork(string? path) => path != null && Path.IsMatch(path);
    internal static JsonElement Obj(JsonElement row, string name) => row.ValueKind == JsonValueKind.Object && row.TryGetProperty(name, out var value) ? value : default;
    internal static string? Str(JsonElement row, string name) => Obj(row, name) is { ValueKind: JsonValueKind.String } value ? value.GetString() : null;
    internal static int? Int(JsonElement row, string name) => Obj(row, name) is { ValueKind: JsonValueKind.Number } value && value.TryGetInt32(out var number) ? number : null;
}
