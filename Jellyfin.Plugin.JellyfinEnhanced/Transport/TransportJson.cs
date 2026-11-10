using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.JellyfinEnhanced.Transport;

/// <summary>Generated contracts have explicit nulls and property spelling, independent of host omission defaults.</summary>
internal static class TransportJson
{
    private static readonly JsonSerializerOptions Options = CreateOptions();

    private static JsonSerializerOptions CreateOptions()
    {
        // Keep Jellyfin's converters for opaque prefetched host payloads, but pin
        // the structural rules reflected by the authoritative contract generator.
        var options = new JsonSerializerOptions(Jellyfin.Extensions.Json.JsonDefaults.Options)
        {
            DefaultIgnoreCondition = JsonIgnoreCondition.Never,
            PropertyNamingPolicy = null,
            DictionaryKeyPolicy = null
        };
        options.MakeReadOnly(populateMissingResolver: true);
        return options;
    }

    internal static JsonResult Create(object value) => new(value, Options);
}
