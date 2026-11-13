using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags;

namespace Jellyfin.Plugin.JellyfinEnhanced.Helpers
{
    /// <summary>
    /// Portable Media Tags settings: the versioned documents a user or an administrator exports and imports, and
    /// the presets built from them.
    /// <list type="bullet">
    /// <item>A user document (<c>{"v":1,"kind":"je-media-tags-user","settings":{…}}</c>) holds the personal Media
    /// Tags fields of <see cref="UserFields"/>, PascalCase as <c>settings.json</c> stores them.</item>
    /// <item>A preset is a user document with <c>kind: je-media-tags-preset</c>, an <c>id</c>, a <c>name</c> and a
    /// <c>description</c>; its <c>settings</c> may name only some of the fields.</item>
    /// <item>An administrator document (<c>kind: je-media-tags-admin</c>) holds every field the Media Tags tab writes
    /// (<see cref="MediaTagsPageFields.Allowed"/>) except signals and secrets, in the configuration API's shape.</item>
    /// </list>
    /// Imports are checked field by field with the validators the save paths use (<see cref="TryNormalizeUser"/> for
    /// users, <see cref="PluginConfigurationPatch.TryRead"/> for administrators): an unknown, secret or invalid field
    /// is reported and skipped, never applied.
    /// Versioning: <see cref="Version"/> grows only when a field is renamed, removed or changes meaning; new fields
    /// are added without a new version (older servers report them as unknown). A document from a newer version is
    /// refused; one from an older version is read through that version's migration before it is checked.
    /// </summary>
    public static class MediaTagsPortable
    {
        /// <summary>The document version this server writes and the newest it reads.</summary>
        public const int Version = 1;

        /// <summary>A user's exported settings.</summary>
        public const string UserKind = "je-media-tags-user";

        /// <summary>A preset: a user document with an id, a name and a description.</summary>
        public const string PresetKind = "je-media-tags-preset";

        /// <summary>The server-wide Media Tags settings.</summary>
        public const string AdminKind = "je-media-tags-admin";

        /// <summary>Presets one user may save.</summary>
        public const int MaxUserPresets = 10;

        /// <summary>Presets an administrator may offer.</summary>
        public const int MaxOfferedPresets = 20;

        /// <summary>
        /// The largest offered-presets text (<see cref="PluginConfiguration.TagOfferedPresets"/>) in UTF-8 bytes, for
        /// the text as sent and for its canonical stored form, so a stored value always reads back and re-imports.
        /// </summary>
        public const int MaxOfferedPresetsBytes = 80 * 1024;

        /// <summary>The longest preset name.</summary>
        public const int MaxNameLength = 60;

        /// <summary>The longest preset description.</summary>
        public const int MaxDescriptionLength = 240;

        /// <summary>The largest document the import endpoints read.</summary>
        public const int MaxDocumentBytes = 64 * 1024;

        /// <summary>The per-user file the saved presets live in.</summary>
        public const string UserPresetsFile = "media-tag-presets.json";

        // Built-in presets are embedded under this resource prefix (Assets/TagPresets/*.json).
        private const string BuiltInPrefix = "Jellyfin.Plugin.JellyfinEnhanced.Assets.TagPresets.";

        /// <summary>
        /// The personal Media Tags fields a user document carries, in export order: group switches and their
        /// includes, positions, status families, the layout (profiles, order, caps, density, size, gap, edge, card
        /// shapes), language priority and the colour preset. Rules and locks are left out: they name this server's
        /// libraries and items.
        /// </summary>
        public static readonly IReadOnlyList<string> UserFields = new[]
        {
            "QualityTagsEnabled", "GenreTagsEnabled", "LanguageTagsEnabled", "RatingTagsEnabled", "AgeRatingTagsEnabled",
            "StatusTagsEnabled", "AwardsTagsEnabled", "LogoTagsEnabled", "CustomTagsEnabled", "PeopleTagsEnabled",
            "TagsHideOnHover", "UseNativePosterTags",
            "ShowResolutionTag", "ShowSourceTag", "ShowEditionTag", "ShowLowQualitySourceTag", "ShowDynamicRangeTag",
            "ShowSpecialFormatTag", "ShowVideoCodecTag", "ShowAudioInfoTag",
            "ShowRuntimeTag", "ShowAspectRatioTag", "ShowFrameRateTag", "ShowVersionsTag",
            "RuntimeTagOrder", "AspectRatioTagOrder", "FrameRateTagOrder", "VersionsTagOrder",
            "QualityAudioDisplayMode", "QualityVideoCodecDisplayMode", "QualityHdrDisplayMode", "QualityMinimumResolution", "QualityHideSdr",
            "ResolutionTagOrder", "SourceTagOrder", "DynamicRangeTagOrder", "SpecialFormatTagOrder", "VideoCodecTagOrder",
            "AudioInfoTagOrder", "EditionTagOrder", "QualityTagsPreferredAudioLanguage", "SeriesQualityAggregation",
            "RatingTagsOnMovies", "RatingTagsOnSeries", "RatingTagsOnSeasons", "RatingTagsOnEpisodes",
            "RatingTagsOnContinueWatching", "RatingTagsOnNextUp", "RatingTagsShowCommunity", "RatingTagsShowCritic",
            "RatingTagsSources", "RatingTagsMinScore", "RatingTagsColorByScore",
            "LanguageTagsShowAudio", "LanguageTagsShowSubtitles", "LanguageTagsStyle", "LanguageTagsCountBadge",
            "LanguageTagsPriority", "LanguageTagsPriorityStrict",
            "StatusTagsJustAdded", "StatusTagsNewRelease", "StatusTagsTrending", "StatusTagsSchedule",
            "StatusTagsMilestones", "StatusTagsSeriesStatus", "StatusTagsScenes", "StatusTagsLeaving", "StatusTagsDirectPlay",
            "QualityTagsPosition", "GenreTagsPosition", "LanguageTagsPosition", "RatingTagsPosition",
            "AgeRatingTagsPosition", "StatusTagsPosition", "AwardsTagsPosition", "LogoTagsPosition", "CustomTagsPosition",
            "TagLayout", "TagLayoutSettingsVersion", "TagLayouts", "TagGroupOrder", "TagGroupCaps", "TagGroupScopes", "TagLabelDensity",
            "TagScale", "TagGap", "TagEdgeSpacing", "TagShapeOverrides",
            "TagStylePreset",
        };

        /// <summary>Page fields that are actions, not settings: never exported or imported.</summary>
        public static readonly IReadOnlySet<string> AdminSignals = new HashSet<string>(StringComparer.Ordinal) { "ClearLocalStorageTimestamp" };

        /// <summary>
        /// Every credential field of <see cref="PluginConfiguration"/>, spelled as declared: API keys, the custom
        /// rule key, the analytics secret and the Sonarr/Radarr instance lists (each instance carries its API key).
        /// An import naming any credential (the Maintainerr key included) reports it as a secret and never reads it.
        /// </summary>
        public static readonly IReadOnlySet<string> Secrets = new HashSet<string>(StringComparer.Ordinal)
        {
            "TMDB_API_KEY", "MdblistApiKey", "DoesTheDogDieApiKey", "ReviewTranslationApiKey", "JellyseerrApiKey",
            "ShokoApiKey", "SonarrApiKey", "RadarrApiKey", "SonarrInstances", "RadarrInstances", "CustomTagRuleKey",
            "AnalyticsInstallSecret", "LeavingSoonMaintainerrApiKey",
        };

        private static readonly Regex PresetIdRegex = new Regex("^[a-z0-9][a-z0-9-]{0,39}$", RegexOptions.Compiled);

        // Reading: nested objects may be spelled in any case (the client camel-cases them); writing: as declared.
        private static readonly JsonSerializerOptions ReadOptions = new JsonSerializerOptions { PropertyNameCaseInsensitive = true };
        private static readonly JsonSerializerOptions WriteOptions = new JsonSerializerOptions();

        private static readonly IReadOnlyDictionary<string, PropertyInfo> UserProperties = UserFields.ToDictionary(
            f => f,
            f => typeof(JellyfinEnhancedUserSettings).GetProperty(f, BindingFlags.Public | BindingFlags.Instance)
                ?? throw new InvalidOperationException($"JellyfinEnhancedUserSettings has no {f}"),
            StringComparer.Ordinal);

        private static readonly Lazy<IReadOnlyList<JsonObject>> Embedded = new Lazy<IReadOnlyList<JsonObject>>(ReadBuiltIns);

        /// <summary>One field an import would change.</summary>
        public sealed class Change
        {
            /// <summary>Gets the field.</summary>
            public string Field { get; init; } = string.Empty;

            /// <summary>Gets the value now.</summary>
            public JsonNode? From { get; init; }

            /// <summary>Gets the value after the import.</summary>
            public JsonNode? To { get; init; }
        }

        /// <summary>One field an import leaves alone, and why.</summary>
        public sealed class Skip
        {
            /// <summary>Gets the field as the document names it.</summary>
            public string Field { get; init; } = string.Empty;

            /// <summary>Gets the reason: unknown, secret, signal or invalid.</summary>
            public string Reason { get; init; } = string.Empty;

            /// <summary>Gets what the validator said about an invalid value, or null.</summary>
            public string? Detail { get; init; }
        }

        /// <summary>What an import would do.</summary>
        public sealed class Preview
        {
            /// <summary>Gets why the whole document was refused (not-object, kind, version, newer, settings), or null.</summary>
            public string? Error { get; init; }

            /// <summary>Gets the document's kind.</summary>
            public string Kind { get; init; } = string.Empty;

            /// <summary>Gets the document's version.</summary>
            public int V { get; init; }

            /// <summary>Gets a preset's name, or null.</summary>
            public string? Name { get; init; }

            /// <summary>Gets a preset's description, or null.</summary>
            public string? Description { get; init; }

            /// <summary>Gets every accepted field with its normalised value (the import applies the changed ones).</summary>
            public JsonObject Imported { get; init; } = new JsonObject();

            /// <summary>Gets the fields whose value would change.</summary>
            public List<Change> Changes { get; init; } = new List<Change>();

            /// <summary>Gets the fields left alone.</summary>
            public List<Skip> Skipped { get; init; } = new List<Skip>();
        }

        /// <summary>A user's saved presets (<see cref="UserPresetsFile"/>).</summary>
        public sealed class UserPresetStore
        {
            /// <summary>Gets or sets the presets, oldest first.</summary>
            public List<StoredPreset> Presets { get; set; } = new List<StoredPreset>();
        }

        /// <summary>One saved preset; <see cref="Settings"/> is the settings object as JSON text.</summary>
        public sealed class StoredPreset
        {
            /// <summary>Gets or sets the id.</summary>
            public string Id { get; set; } = string.Empty;

            /// <summary>Gets or sets the name.</summary>
            public string Name { get; set; } = string.Empty;

            /// <summary>Gets or sets the description.</summary>
            public string Description { get; set; } = string.Empty;

            /// <summary>Gets or sets the settings object (JSON text).</summary>
            public string Settings { get; set; } = "{}";
        }

        // ── Users ──────────────────────────────────────────────────────────

        /// <summary>
        /// Normalises a whole user document as the settings save path does (layouts, caps, rating sources, language
        /// display and priority, Tag Styles preset, rules and locks, card shapes).
        /// </summary>
        /// <param name="settings">The document, normalised in place.</param>
        /// <param name="error">Why the document cannot be saved (only the language priority refuses), or null.</param>
        /// <returns>True when the document can be saved.</returns>
        public static bool TryNormalizeUser(JellyfinEnhancedUserSettings settings, out string? error)
        {
            ArgumentNullException.ThrowIfNull(settings);
            error = null;
            if (!LanguageTagPriority.TryNormalize(settings.LanguageTagsPriority, out var languagePriority))
            {
                error = "Language priorities require at most 12 ISO 639-1/639-2 language codes.";
                return false;
            }

            settings.LanguageTagsPriority = languagePriority;
            // Unknown layouts, groups and slots are normalized away and caps
            // clamped, so a stale client cannot store an unusable layout.
            RatingSourceSettings.Normalize(settings);
            TagLayoutRules.Normalize(settings);
            if (settings.QualityAudioDisplayMode != null) settings.QualityAudioDisplayMode = QualityDisplayRules.Mode(settings.QualityAudioDisplayMode);
            if (settings.QualityVideoCodecDisplayMode != null) settings.QualityVideoCodecDisplayMode = QualityDisplayRules.Mode(settings.QualityVideoCodecDisplayMode);
            if (settings.QualityHdrDisplayMode != null) settings.QualityHdrDisplayMode = QualityDisplayRules.Mode(settings.QualityHdrDisplayMode);
            if (settings.QualityMinimumResolution != null) settings.QualityMinimumResolution = QualityDisplayRules.Minimum(settings.QualityMinimumResolution);
            if (settings.SeriesQualityAggregation != null)
                settings.SeriesQualityAggregation = Services.SeriesQualityAggregation.Normalize(settings.SeriesQualityAggregation);
            // Unknown language tag styles / badge modes fall back to flags / off.
            LanguageTagDisplay.Normalize(settings);
            // An unknown Tag Styles preset follows the admin's instead.
            settings.TagStylePreset = TagStyleKeys.KnownPreset(settings.TagStylePreset);
            // Rules and locks: invalid entries are dropped one by one (ids
            // validated, limits applied), never the whole document.
            TagLookValidation.Normalize(settings);
            // Per-shape looks: unknown layouts and slots dropped, caps clamped.
            TagShapeRules.Normalize(settings);
            return true;
        }

        /// <summary>The Media Tags fields of a user document, as a settings object.</summary>
        /// <param name="settings">The document.</param>
        /// <returns>Field → value, in <see cref="UserFields"/> order.</returns>
        public static JsonObject UserSettingsObject(JellyfinEnhancedUserSettings settings)
        {
            ArgumentNullException.ThrowIfNull(settings);
            var result = new JsonObject();
            foreach (var field in UserFields) result[field] = UserValue(settings, field);
            return result;
        }

        /// <summary>A user's export: <c>{"v":1,"kind":"je-media-tags-user","settings":{…}}</c>.</summary>
        /// <param name="settings">The user's stored document.</param>
        /// <returns>The document.</returns>
        public static JsonObject ExportUser(JellyfinEnhancedUserSettings settings)
        {
            var baseline = Normalized(settings);
            return new JsonObject { ["v"] = Version, ["kind"] = UserKind, ["settings"] = UserSettingsObject(baseline) };
        }

        /// <summary>
        /// What importing a user document or a preset would change in <paramref name="current"/>. Nothing is saved:
        /// the client applies the changed fields through the normal settings save, which normalises them again.
        /// </summary>
        /// <param name="document">The posted document.</param>
        /// <param name="current">The user's stored document.</param>
        /// <returns>The preview.</returns>
        public static Preview PreviewUser(JsonElement document, JellyfinEnhancedUserSettings current)
        {
            var header = ReadHeader(document, new[] { UserKind, PresetKind });
            if (header.Error != null) return header;
            var baseline = Normalized(current);
            var accepted = ReadUserSettings(document.GetProperty("settings"), out var skipped);
            var result = Clone(baseline);
            foreach (var (field, value) in accepted) UserProperties[field].SetValue(result, value);
            TryNormalizeUser(result, out _);
            var imported = new JsonObject();
            var changes = new List<Change>();
            foreach (var field in UserFields)
            {
                if (!accepted.ContainsKey(field)) continue;
                var to = UserValue(result, field);
                imported[field] = to?.DeepClone();
                var from = UserValue(baseline, field);
                if (!JsonNode.DeepEquals(from, to)) changes.Add(new Change { Field = field, From = from, To = to });
            }

            return new Preview { Kind = header.Kind, V = header.V, Name = header.Name, Description = header.Description, Imported = imported, Changes = changes, Skipped = skipped };
        }

        /// <summary>
        /// Reads a preset (or a user document saved as one): its name, description and the accepted settings.
        /// Unknown and invalid fields are dropped and reported.
        /// </summary>
        /// <param name="document">The posted document.</param>
        /// <param name="name">A name to use when the document has none (a user document), or null to require one.</param>
        /// <param name="preset">The preset document, with only the accepted settings.</param>
        /// <param name="skipped">The fields dropped.</param>
        /// <param name="error">Why the preset was refused (not-object, kind, version, newer, settings, name, description, empty), or null.</param>
        /// <returns>True when the preset is usable.</returns>
        public static bool TryReadPreset(JsonElement document, string? name, out JsonObject preset, out List<Skip> skipped, out string? error)
        {
            preset = new JsonObject();
            skipped = new List<Skip>();
            var header = ReadHeader(document, new[] { UserKind, PresetKind });
            error = header.Error;
            if (error != null) return false;
            var presetName = (header.Name ?? name ?? string.Empty).Trim();
            var description = (header.Description ?? string.Empty).Trim();
            if (presetName.Length == 0 || presetName.Length > MaxNameLength || presetName.Any(char.IsControl))
            {
                error = "name";
                return false;
            }

            if (description.Length > MaxDescriptionLength || description.Any(c => char.IsControl(c) && c != '\n'))
            {
                error = "description";
                return false;
            }

            var accepted = ReadUserSettings(document.GetProperty("settings"), out skipped);
            if (accepted.Count == 0)
            {
                error = "empty";
                return false;
            }

            var settings = new JsonObject();
            foreach (var field in UserFields)
            {
                if (accepted.TryGetValue(field, out var value)) settings[field] = ToJson(value, UserProperties[field].PropertyType);
            }

            var id = document.TryGetProperty("id", out var idElement) && idElement.ValueKind == JsonValueKind.String ? idElement.GetString() : null;
            preset = new JsonObject
            {
                ["v"] = Version,
                ["kind"] = PresetKind,
                ["id"] = id != null && PresetIdRegex.IsMatch(id) ? id : null,
                ["name"] = presetName,
                ["description"] = description,
                ["settings"] = settings,
            };
            return true;
        }

        /// <summary>
        /// Checks the offered presets field (<see cref="PluginConfiguration.TagOfferedPresets"/>): a JSON array of at most
        /// <see cref="MaxOfferedPresets"/> presets with distinct ids, each valid as a whole (no unknown or invalid field),
        /// whose canonical text (the presets normalised and serialised as stored) is at most
        /// <see cref="MaxOfferedPresetsBytes"/> UTF-8 bytes. Normalising can lengthen a preset (escaped text, filled-in
        /// layout profiles), so the canonical text is measured, not only the text as sent.
        /// </summary>
        /// <param name="text">The field's value.</param>
        /// <param name="normalized">The canonical text to store (empty for none).</param>
        /// <param name="error">Why it was refused, or null.</param>
        /// <returns>True when accepted.</returns>
        public static bool TryNormalizeOfferedPresets(string? text, out string normalized, out string? error)
        {
            normalized = string.Empty;
            error = null;
            if (string.IsNullOrWhiteSpace(text)) return true;
            if (Encoding.UTF8.GetByteCount(text) > MaxOfferedPresetsBytes)
            {
                error = $"larger than {MaxOfferedPresetsBytes} bytes";
                return false;
            }

            JsonDocument parsed;
            try
            {
                parsed = JsonDocument.Parse(text);
            }
            catch (JsonException)
            {
                error = "must be a JSON array of presets";
                return false;
            }

            using (parsed)
            {
                if (parsed.RootElement.ValueKind != JsonValueKind.Array)
                {
                    error = "must be a JSON array of presets";
                    return false;
                }

                if (parsed.RootElement.GetArrayLength() > MaxOfferedPresets)
                {
                    error = $"at most {MaxOfferedPresets} presets";
                    return false;
                }

                var list = new JsonArray();
                var ids = new HashSet<string>(StringComparer.Ordinal);
                foreach (var element in parsed.RootElement.EnumerateArray())
                {
                    if (!TryReadPreset(element, null, out var preset, out var skipped, out var problem))
                    {
                        error = $"a preset is not valid ({problem})";
                        return false;
                    }

                    if (skipped.Count > 0)
                    {
                        error = $"preset '{preset["name"]}' has unknown or invalid settings: {string.Join(", ", skipped.Select(s => s.Field))}";
                        return false;
                    }

                    var id = (string?)preset["id"];
                    if (id == null || !ids.Add(id))
                    {
                        error = "every preset needs a distinct id of lower-case letters, digits and hyphens";
                        return false;
                    }

                    list.Add(preset);
                }

                var canonical = list.Count == 0 ? string.Empty : list.ToJsonString();
                var bytes = Encoding.UTF8.GetByteCount(canonical);
                if (bytes > MaxOfferedPresetsBytes)
                {
                    error = $"larger than {MaxOfferedPresetsBytes} bytes once normalised ({bytes} bytes); offer fewer or shorter presets";
                    return false;
                }

                normalized = canonical;
                return true;
            }
        }

        /// <summary>The offered presets, or none when the stored text is empty or unreadable.</summary>
        /// <param name="config">The configuration.</param>
        /// <returns>The presets.</returns>
        public static IReadOnlyList<JsonObject> OfferedPresets(PluginConfiguration config)
        {
            if (!TryNormalizeOfferedPresets(config?.TagOfferedPresets, out var text, out _) || text.Length == 0) return Array.Empty<JsonObject>();
            return JsonNode.Parse(text)!.AsArray().Select(n => n!.AsObject()).ToList();
        }

        /// <summary>The built-in presets shipped with the plugin (Assets/TagPresets/*.json), in file name order.</summary>
        public static IReadOnlyList<JsonObject> BuiltInPresets => Embedded.Value;

        /// <summary>A stored preset as a preset document.</summary>
        /// <param name="stored">The stored preset.</param>
        /// <returns>The document.</returns>
        public static JsonObject ToDocument(StoredPreset stored)
        {
            ArgumentNullException.ThrowIfNull(stored);
            JsonNode? settings;
            try
            {
                settings = JsonNode.Parse(stored.Settings);
            }
            catch (JsonException)
            {
                settings = null;
            }

            return new JsonObject
            {
                ["v"] = Version,
                ["kind"] = PresetKind,
                ["id"] = stored.Id,
                ["name"] = stored.Name,
                ["description"] = stored.Description,
                ["settings"] = settings as JsonObject ?? new JsonObject(),
            };
        }

        // ── Administrators ─────────────────────────────────────────────────

        /// <summary>The fields an administrator document carries: the page's fields less signals and secrets, sorted.</summary>
        /// <param name="allowed">The page's fields (<see cref="MediaTagsPageFields.Allowed"/>).</param>
        /// <returns>The fields.</returns>
        public static IReadOnlyList<string> AdminFields(IReadOnlySet<string> allowed)
            => allowed.Where(f => !AdminSignals.Contains(f) && !IsSecret(f) && AdminProperty(f) != null).OrderBy(f => f, StringComparer.Ordinal).ToList();

        /// <summary>The server-wide export: <c>{"v":1,"kind":"je-media-tags-admin","settings":{…}}</c>.</summary>
        /// <param name="config">The configuration.</param>
        /// <param name="allowed">The page's fields.</param>
        /// <returns>The document.</returns>
        public static JsonObject ExportAdmin(PluginConfiguration config, IReadOnlySet<string> allowed)
        {
            ArgumentNullException.ThrowIfNull(config);
            var settings = new JsonObject();
            foreach (var field in AdminFields(allowed))
            {
                var property = AdminProperty(field)!;
                settings[field] = PluginConfigurationPatch.ToJson(property.GetValue(config), property.PropertyType);
            }

            return new JsonObject { ["v"] = Version, ["kind"] = AdminKind, ["settings"] = settings };
        }

        /// <summary>
        /// What importing an administrator document would change. Each field is read and checked as the field patch
        /// reads it; the client applies the changed ones through that patch, with the values it read as expected.
        /// </summary>
        /// <param name="document">The posted document.</param>
        /// <param name="config">The configuration now.</param>
        /// <param name="allowed">The page's fields.</param>
        /// <returns>The preview.</returns>
        public static Preview PreviewAdmin(JsonElement document, PluginConfiguration config, IReadOnlySet<string> allowed)
        {
            ArgumentNullException.ThrowIfNull(config);
            // A personal export is accepted too: an administrator can make their own settings the server's defaults. Its fields
            // go through the same checks, and the ones the page does not own are listed and skipped.
            var header = ReadHeader(document, new[] { AdminKind, UserKind });
            if (header.Error != null) return header;
            var fields = new HashSet<string>(AdminFields(allowed), StringComparer.Ordinal);
            var imported = new JsonObject();
            var changes = new List<Change>();
            var skipped = new List<Skip>();
            foreach (var entry in document.GetProperty("settings").EnumerateObject())
            {
                var field = entry.Name;
                if (IsSecret(field)) { skipped.Add(new Skip { Field = field, Reason = "secret" }); continue; }
                if (AdminSignals.Contains(field)) { skipped.Add(new Skip { Field = field, Reason = "signal" }); continue; }
                if (!fields.Contains(field)) { skipped.Add(new Skip { Field = field, Reason = "unknown" }); continue; }
                var property = AdminProperty(field)!;
                if (!PluginConfigurationPatch.TryRead(property, entry.Value, out var normalized, out var problem))
                {
                    skipped.Add(new Skip { Field = field, Reason = "invalid", Detail = problem ?? "not the setting's type" });
                    continue;
                }

                var to = PluginConfigurationPatch.ToJson(normalized, property.PropertyType);
                imported[field] = to?.DeepClone();
                var from = PluginConfigurationPatch.ToJson(property.GetValue(config), property.PropertyType);
                if (!JsonNode.DeepEquals(from, to)) changes.Add(new Change { Field = field, From = from, To = to });
            }

            changes.Sort((a, b) => string.CompareOrdinal(a.Field, b.Field));
            return new Preview { Kind = header.Kind, V = header.V, Imported = imported, Changes = changes, Skipped = skipped };
        }

        /// <summary>
        /// Whether a field is a secret: one of <see cref="Secrets"/>, or any other API key, token, password or secret
        /// in any case and with or without separators (<c>TMDB_API_KEY</c>, <c>api-key</c>, <c>AuthToken</c>).
        /// </summary>
        /// <param name="field">The field name.</param>
        /// <returns>True for a secret.</returns>
        public static bool IsSecret(string field)
        {
            if (Secrets.Contains(field)) return true;
            var name = field.Replace("_", string.Empty, StringComparison.Ordinal).Replace("-", string.Empty, StringComparison.Ordinal);
            return name.EndsWith("ApiKey", StringComparison.OrdinalIgnoreCase)
                || name.EndsWith("Token", StringComparison.OrdinalIgnoreCase)
                || name.Contains("Password", StringComparison.OrdinalIgnoreCase)
                || name.Contains("Secret", StringComparison.OrdinalIgnoreCase);
        }

        // ── Helpers ────────────────────────────────────────────────────────

        // The document's envelope: an object, a kind this endpoint reads, a version it understands and a settings object.
        private static Preview ReadHeader(JsonElement document, string[] kinds)
        {
            if (document.ValueKind != JsonValueKind.Object) return new Preview { Error = "not-object" };
            var kind = document.TryGetProperty("kind", out var k) && k.ValueKind == JsonValueKind.String ? k.GetString() ?? string.Empty : string.Empty;
            if (!kinds.Contains(kind, StringComparer.Ordinal)) return new Preview { Error = "kind", Kind = kind };
            if (!document.TryGetProperty("v", out var v) || v.ValueKind != JsonValueKind.Number || !v.TryGetInt32(out var version) || version < 1)
                return new Preview { Error = "version", Kind = kind };
            if (version > Version) return new Preview { Error = "newer", Kind = kind, V = version };
            if (!document.TryGetProperty("settings", out var settings) || settings.ValueKind != JsonValueKind.Object)
                return new Preview { Error = "settings", Kind = kind, V = version };
            static string? Text(JsonElement doc, string name) => doc.TryGetProperty(name, out var p) && p.ValueKind == JsonValueKind.String ? p.GetString() : null;
            return new Preview { Kind = kind, V = version, Name = Text(document, "name"), Description = Text(document, "description") };
        }

        // Each field of a settings object, checked on its own: known, of the property's type, accepted by the
        // administrator field contract where the page has the same field, and left exactly as given by the save
        // path's normalisation. Anything else is reported and skipped.
        private static Dictionary<string, object?> ReadUserSettings(JsonElement settings, out List<Skip> skipped)
        {
            skipped = new List<Skip>();
            var accepted = new Dictionary<string, object?>(StringComparer.Ordinal);
            var blank = new JellyfinEnhancedUserSettings();
            foreach (var entry in settings.EnumerateObject())
            {
                var field = entry.Name;
                if (IsSecret(field)) { skipped.Add(new Skip { Field = field, Reason = "secret" }); continue; }
                if (!UserProperties.TryGetValue(field, out var property) || accepted.ContainsKey(field))
                {
                    skipped.Add(new Skip { Field = field, Reason = "unknown" });
                    continue;
                }

                object? value;
                try
                {
                    value = entry.Value.Deserialize(property.PropertyType, ReadOptions);
                }
                catch (Exception ex) when (ex is JsonException or NotSupportedException or ArgumentException or InvalidOperationException)
                {
                    skipped.Add(new Skip { Field = field, Reason = "invalid", Detail = "not the setting's type" });
                    continue;
                }

                if (!AdminContract(field, value, out var problem))
                {
                    skipped.Add(new Skip { Field = field, Reason = "invalid", Detail = problem });
                    continue;
                }

                var trial = Clone(blank);
                property.SetValue(trial, value);
                if (!TryNormalizeUser(trial, out problem))
                {
                    skipped.Add(new Skip { Field = field, Reason = "invalid", Detail = problem });
                    continue;
                }

                if (!JsonNode.DeepEquals(ToJson(property.GetValue(trial), property.PropertyType), ToJson(value, property.PropertyType)))
                {
                    skipped.Add(new Skip { Field = field, Reason = "invalid", Detail = "not a value this setting takes" });
                    continue;
                }

                accepted[field] = value;
            }

            return accepted;
        }

        // The administrator's contract for the same field (positions, orders, ranges, known values), when the
        // configuration has a field of that name and type. Null keeps its meaning (follow the administrator).
        private static bool AdminContract(string field, object? value, out string? error)
        {
            error = null;
            if (value == null || field is "TagStylePreset" or "TagLayouts" or "TagShapeOverrides" or "TagGroupScopes") return true;
            var property = AdminProperty(field);
            if (property == null) return true;
            var type = Nullable.GetUnderlyingType(property.PropertyType) ?? property.PropertyType;
            if (type != value.GetType() && !type.IsInstanceOfType(value)) return true;
            return MediaTagsPageFields.TryNormalize(field, value, out _, out error);
        }

        private static PropertyInfo? AdminProperty(string field)
        {
            var property = typeof(PluginConfiguration).GetProperty(field, BindingFlags.Public | BindingFlags.Instance);
            return property != null && property.GetSetMethod() != null && property.GetIndexParameters().Length == 0 ? property : null;
        }

        private static JsonNode? UserValue(JellyfinEnhancedUserSettings settings, string field)
        {
            var property = UserProperties[field];
            return ToJson(property.GetValue(settings), property.PropertyType);
        }

        private static JsonNode? ToJson(object? value, Type type) => JsonSerializer.SerializeToNode(value, type, WriteOptions);

        private static JellyfinEnhancedUserSettings Clone(JellyfinEnhancedUserSettings settings)
            => JsonSerializer.Deserialize<JellyfinEnhancedUserSettings>(JsonSerializer.Serialize(settings, WriteOptions), WriteOptions) ?? new JellyfinEnhancedUserSettings();

        // The stored document as the save path would write it (a stored document normally already is).
        private static JellyfinEnhancedUserSettings Normalized(JellyfinEnhancedUserSettings? settings)
        {
            var copy = Clone(settings ?? new JellyfinEnhancedUserSettings());
            TryNormalizeUser(copy, out _);
            return copy;
        }

        private static IReadOnlyList<JsonObject> ReadBuiltIns()
        {
            var assembly = typeof(MediaTagsPortable).Assembly;
            var result = new List<JsonObject>();
            foreach (var name in assembly.GetManifestResourceNames()
                .Where(n => n.StartsWith(BuiltInPrefix, StringComparison.Ordinal) && n.EndsWith(".json", StringComparison.Ordinal))
                .OrderBy(n => n, StringComparer.Ordinal))
            {
                using var stream = assembly.GetManifestResourceStream(name);
                if (stream == null) continue;
                using var reader = new StreamReader(stream);
                using var document = JsonDocument.Parse(reader.ReadToEnd());
                if (TryReadPreset(document.RootElement, null, out var preset, out _, out _)) result.Add(preset);
            }

            return result;
        }
    }
}
