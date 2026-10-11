using System;
using System.Collections.Generic;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace Jellyfin.Plugin.JellyfinEnhanced.Configuration
{
    /// <summary>
    /// The optional "_je" block of settings.json: per-key provenance. A key in neither list is
    /// Existing (a value from before tracking began, or written by an older JE), so a file without
    /// the block reads as all-Existing. Persisted by Newtonsoft only: System.Text.Json (the GET
    /// response, model binding) never sees it, and every write route takes it from disk.
    /// </summary>
    public sealed class UserSettingsMeta
    {
        /// <summary>The schema version this code writes.</summary>
        public const int CurrentSchema = 2;

        /// <summary>Gets or sets the schema version of the block.</summary>
        public int Schema { get; set; } = CurrentSchema;

        /// <summary>Gets or sets the keys that use the current admin default (the stored value is a cache).</summary>
        public List<string> Following { get; set; } = new();

        /// <summary>Gets or sets the keys whose value was set through the key-level write paths.</summary>
        public List<string> Chosen { get; set; } = new();

        /// <summary>Gets or sets the Chosen keys an administrator wrote on the user's behalf.</summary>
        public List<string> ChangedByAdmin { get; set; } = new();

        /// <summary>Gets or sets the admin bulk operation that last changed each key (for undo).</summary>
        public Dictionary<string, string> Ops { get; set; } = new();

        /// <summary>Gets or sets when the block was last changed (UTC).</summary>
        public DateTime? Updated { get; set; }
    }

    /// <summary>
    /// Reads "_je" without ever failing the settings document it sits in: anything that is not an
    /// object, or does not deserialize, reads as no block (all keys Existing) instead of making the
    /// whole file malformed and quarantined. Writing uses the default serializer.
    /// </summary>
    internal sealed class TolerantUserSettingsMetaConverter : JsonConverter
    {
        public override bool CanWrite => false;

        public override bool CanConvert(Type objectType) => objectType == typeof(UserSettingsMeta);

        public override object? ReadJson(JsonReader reader, Type objectType, object? existingValue, JsonSerializer serializer)
        {
            if (JToken.Load(reader) is not JObject block)
            {
                return null;
            }

            try
            {
                return block.ToObject<UserSettingsMeta>();
            }
            catch (Exception ex) when (ex is JsonException || ex is ArgumentException || ex is FormatException || ex is InvalidCastException || ex is OverflowException)
            {
                return null;
            }
        }

        public override void WriteJson(JsonWriter writer, object? value, JsonSerializer serializer)
            => throw new NotSupportedException();
    }
}
