using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Jellyfin.Plugin.SpoilerGuard.Configuration
{
    /// <summary>
    /// The look one card shape gets instead of the default: any value left
    /// null inherits the default look's (layout, density, the slot profile for
    /// the layout, the caps).
    /// </summary>
    public class TagShapeLook
    {
        /// <summary>Layout for cards of this shape; null keeps the default layout.</summary>
        public string? Layout { get; set; }

        /// <summary>Label density for cards of this shape; null keeps the default density.</summary>
        public string? Density { get; set; }

        /// <summary>Tag size for this shape; null inherits the default look.</summary>
        public string? TagScale { get; set; }

        /// <summary>Tag spacing for this shape; null inherits the default look.</summary>
        public string? TagGap { get; set; }

        /// <summary>Slot overrides over the profile of the resolved layout; null keeps the profile.</summary>
        [JsonConverter(typeof(TagShapeSlotsConverter))]
        public List<TagLayoutGroupSlot>? Slots { get; set; }

        /// <summary>Chip limits over the default caps; a null cap keeps the default one.</summary>
        public TagGroupCaps? Caps { get; set; }
    }

    /// <summary>
    /// Accept shape slot maps as well as the established layout slot array.
    /// Writes arrays so group ids remain values through client key conversion;
    /// the XML configuration continues to use the ordinary typed list.
    /// </summary>
    public sealed class TagShapeSlotsConverter : JsonConverter<List<TagLayoutGroupSlot>>
    {
        /// <inheritdoc />
        public override List<TagLayoutGroupSlot>? Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
        {
            using var document = JsonDocument.ParseValue(ref reader);
            var root = document.RootElement;
            var result = new List<TagLayoutGroupSlot>();
            if (root.ValueKind == JsonValueKind.Object)
            {
                foreach (var property in root.EnumerateObject())
                {
                    if (property.Value.ValueKind == JsonValueKind.String)
                    {
                        result.Add(new TagLayoutGroupSlot { Group = property.Name, Slot = property.Value.GetString()! });
                    }
                }
            }
            else if (root.ValueKind == JsonValueKind.Array)
            {
                foreach (var entry in root.EnumerateArray())
                {
                    if (entry.ValueKind != JsonValueKind.Object) continue;
                    string? group = null, slot = null;
                    foreach (var property in entry.EnumerateObject())
                    {
                        if (property.Value.ValueKind != JsonValueKind.String) continue;
                        if (property.Name.Equals("group", StringComparison.OrdinalIgnoreCase)) group = property.Value.GetString();
                        if (property.Name.Equals("slot", StringComparison.OrdinalIgnoreCase)) slot = property.Value.GetString();
                    }

                    if (group != null && slot != null) result.Add(new TagLayoutGroupSlot { Group = group, Slot = slot });
                }
            }

            return result.Count == 0 ? null : result;
        }

        /// <inheritdoc />
        public override void Write(Utf8JsonWriter writer, List<TagLayoutGroupSlot> value, JsonSerializerOptions options)
        {
            writer.WriteStartArray();
            foreach (var entry in value) JsonSerializer.Serialize(writer, entry, options);
            writer.WriteEndArray();
        }
    }

    /// <summary>
    /// Per-shape looks: landscape cards (episode thumbnails, backdrop cards)
    /// and large list rows. Portrait posters (and square cards) always use the
    /// default look. A null shape inherits the default look.
    /// </summary>
    public class TagShapeOverrides
    {
        /// <summary>Look of landscape cards (episode thumbnails, backdrop cards); null = the default look.</summary>
        public TagShapeLook? Landscape { get; set; }

        /// <summary>Look of large list rows (a season's episode list); null = the default look.</summary>
        public TagShapeLook? List { get; set; }
    }

    /// <summary>
    /// Validation of the per-shape tag looks shared by the per-user document,
    /// the administrator defaults and the shape looks a rule or lock carries.
    /// Like the other layout settings, invalid values are dropped one by one,
    /// never the whole document.
    /// </summary>
    public static class TagShapeRules
    {
        /// <summary>Shapes that can have their own look (portrait is the default look).</summary>
        public static readonly IReadOnlyList<string> Shapes = new[] { "landscape", "list" };

        private static readonly string[] Densities = { "full", "compact" };

        /// <summary>Every slot of every layout: what a look without its own layout may name.</summary>
        private static readonly HashSet<string> AnySlot = new HashSet<string>(TagLayoutRules.LayoutSlots.Values.SelectMany(s => s), StringComparer.Ordinal);

        /// <summary>
        /// One shape look normalized: an unknown layout or density becomes null
        /// (inherit), slots are checked against the look's layout (any layout's
        /// slots when it has none; the client re-checks against the layout the
        /// card resolves to), caps are clamped to 0..<see cref="TagLayoutRules.MaxCap"/>.
        /// Null in, null out; a look with nothing left stays (an override that
        /// shows the default look until it is edited).
        /// </summary>
        public static TagShapeLook? NormalizeLook(TagShapeLook? look)
        {
            if (look == null) return null;
            var layoutRaw = (look.Layout ?? string.Empty).Trim().ToLowerInvariant();
            var layout = TagLayoutRules.LayoutSlots.ContainsKey(layoutRaw) ? layoutRaw : null;
            var densityRaw = (look.Density ?? string.Empty).Trim().ToLowerInvariant();
            return new TagShapeLook
            {
                Layout = layout,
                Density = Densities.Contains(densityRaw) ? densityRaw : null,
                TagScale = TagLayoutRules.ReadScale(look.TagScale),
                TagGap = TagLayoutRules.ReadGap(look.TagGap),
                Slots = NormalizeSlots(layout, look.Slots),
                Caps = TagLayoutRules.NormalizeCaps(look.Caps),
            };
        }

        /// <summary>
        /// Slots with unknown groups, repeats (first wins) and slots invalid for
        /// the layout removed (any layout's slots when the layout is null; dots
        /// stay quality's); null when none is left.
        /// </summary>
        private static List<TagLayoutGroupSlot>? NormalizeSlots(string? layout, List<TagLayoutGroupSlot>? slots)
        {
            if (slots == null) return null;
            if (layout != null)
            {
                return TagLayoutRules.NormalizeProfile(layout, new TagLayoutProfile { Groups = slots })?.Groups;
            }

            var seen = new HashSet<string>(StringComparer.Ordinal);
            var result = new List<TagLayoutGroupSlot>();
            foreach (var entry in slots)
            {
                var group = TagLayoutRules.NormalizeGroup(entry?.Group);
                var slot = (entry?.Slot ?? string.Empty).Trim().ToLowerInvariant();
                if (group == null || !AnySlot.Contains(slot) || seen.Contains(group)) continue;
                if (slot == "dots" && group != "quality") continue;
                seen.Add(group);
                result.Add(new TagLayoutGroupSlot { Group = group, Slot = slot });
            }

            return result.Count == 0 ? null : result;
        }

        /// <summary>
        /// Per-shape looks normalized. Null in, null out (a user document
        /// without its own value inherits the administrator's); an object whose
        /// shapes are both null stays an object, so a user who switched the
        /// administrator's shape looks off keeps them off.
        /// </summary>
        public static TagShapeOverrides? Normalize(TagShapeOverrides? overrides)
        {
            if (overrides == null) return null;
            return new TagShapeOverrides
            {
                Landscape = NormalizeLook(overrides.Landscape),
                List = NormalizeLook(overrides.List),
            };
        }

        /// <summary>
        /// The administrator's shape looks normalized for publishing and seeding;
        /// null when no shape has a look (the same as none).
        /// </summary>
        public static TagShapeOverrides? NormalizeDefaults(TagShapeOverrides? overrides)
        {
            var result = Normalize(overrides);
            return result?.Landscape == null && result?.List == null ? null : result;
        }

        /// <summary>Normalize the shape looks of a user document in place.</summary>
        public static void Normalize(SpoilerGuardUserSettings settings)
        {
            ArgumentNullException.ThrowIfNull(settings);
            settings.TagShapeOverrides = Normalize(settings.TagShapeOverrides);
        }

        /// <summary>
        /// Copy the administrator's shape looks onto a new (or reset) user
        /// document, which <see cref="TagLayoutRules.ApplyDefaults"/> makes a
        /// normalized one; null when the administrator set none.
        /// </summary>
        public static void ApplyDefaults(SpoilerGuardUserSettings settings, PluginConfiguration config)
        {
            ArgumentNullException.ThrowIfNull(settings);
            ArgumentNullException.ThrowIfNull(config);
            settings.TagShapeOverrides = NormalizeDefaults(config.TagShapeOverrides);
        }
    }
}
