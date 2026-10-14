using System;
using System.Collections.Generic;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Jellyfin.Plugin.JellyfinEnhanced.Controllers
{
    /// <summary>
    /// The public config as signed-in callers get it: the anonymous payload's fields, serialized
    /// exactly as they would be on their own, followed by one more field, UserSettingDefaults.
    /// </summary>
    [JsonConverter(typeof(PublicConfigPayloadConverter))]
    internal sealed class PublicConfigPayload
    {
        /// <summary>Initializes a new instance of the <see cref="PublicConfigPayload"/> class.</summary>
        /// <param name="config">The anonymous public config payload.</param>
        /// <param name="userSettingDefaults">The registry's published per-user defaults, by settings.json key.</param>
        public PublicConfigPayload(object config, IReadOnlyDictionary<string, object> userSettingDefaults)
        {
            Config = config;
            UserSettingDefaults = userSettingDefaults;
        }

        /// <summary>Gets the anonymous public config payload.</summary>
        public object Config { get; }

        /// <summary>Gets the published per-user defaults, by settings.json key (PascalCase).</summary>
        public IReadOnlyDictionary<string, object> UserSettingDefaults { get; }
    }

    /// <summary>
    /// Writes a <see cref="PublicConfigPayload"/> as one flat object. The anonymous payload goes through
    /// the caller's serializer options unchanged; the defaults' keys are written as they are (settings.json
    /// keys), whatever dictionary key policy the host uses.
    /// </summary>
    internal sealed class PublicConfigPayloadConverter : JsonConverter<PublicConfigPayload>
    {
        /// <inheritdoc />
        public override PublicConfigPayload Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
            => throw new NotSupportedException("The public config is written only.");

        /// <inheritdoc />
        public override void Write(Utf8JsonWriter writer, PublicConfigPayload value, JsonSerializerOptions options)
        {
            writer.WriteStartObject();
            using (var config = JsonSerializer.SerializeToDocument(value.Config, value.Config.GetType(), options))
            {
                foreach (var property in config.RootElement.EnumerateObject())
                {
                    property.WriteTo(writer);
                }
            }

            writer.WritePropertyName(options.PropertyNamingPolicy?.ConvertName(nameof(PublicConfigPayload.UserSettingDefaults)) ?? nameof(PublicConfigPayload.UserSettingDefaults));
            writer.WriteStartObject();
            foreach (var entry in value.UserSettingDefaults)
            {
                writer.WritePropertyName(entry.Key);
                JsonSerializer.Serialize(writer, entry.Value, entry.Value.GetType(), options);
            }

            writer.WriteEndObject();
            writer.WriteEndObject();
        }
    }
}
