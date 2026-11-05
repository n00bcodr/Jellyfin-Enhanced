using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags;

namespace Jellyfin.Plugin.JellyfinEnhanced.Helpers
{
    /// <summary>
    /// The configuration fields the Media Tags settings page owns, which its field patch
    /// (<see cref="PluginConfigurationPatch"/>) may write: every field its section modules
    /// (js/enhanced/admintags/sections/*.js) declare, an ordered field's <c>orderKey</c>, and the fields a
    /// section's own editors write (<c>writes: ['Field', …]</c>). The page collects the same list from the same
    /// declarations (<c>JE.adminTags.pageFields</c>); everything else, API keys included, stays with the main
    /// configuration page.
    /// </summary>
    public static class MediaTagsPageFields
    {
        // The section modules are embedded under this resource prefix (WhatsNewService reads them too).
        private const string SectionPrefix = "Jellyfin.Plugin.JellyfinEnhanced.js.enhanced.admintags.sections.";

        // A one-line field declaration: { id: '<control id>', key: '<Field>', …, orderKey: '<Field>' …
        private static readonly Regex FieldRegex = new Regex(
            "^\\s*\\{ id: '\\w+', key: '(\\w+)'(?:.*?orderKey: '(\\w+)')?",
            RegexOptions.Multiline | RegexOptions.Compiled);

        // A section's own writes: `writes: ['TagLayouts', 'TagGroupOrder'],`.
        private static readonly Regex WritesRegex = new Regex(
            "^\\s*writes: \\[([^\\]]*)\\]",
            RegexOptions.Multiline | RegexOptions.Compiled);

        private static readonly Regex QuotedRegex = new Regex("'(\\w+)'", RegexOptions.Compiled);

        private static readonly Lazy<IReadOnlySet<string>> Embedded = new Lazy<IReadOnlySet<string>>(() => Parse(ReadSectionModules()));

        /// <summary>Gets the fields the page owns, read from the embedded section modules.</summary>
        public static IReadOnlySet<string> Allowed => Embedded.Value;

        /// <summary>The fields some section modules declare.</summary>
        /// <param name="modules">The modules' sources.</param>
        /// <returns>The field names.</returns>
        public static IReadOnlySet<string> Parse(IEnumerable<string> modules)
        {
            var fields = new HashSet<string>(StringComparer.Ordinal);
            foreach (var text in modules)
            {
                foreach (Match field in FieldRegex.Matches(text))
                {
                    fields.Add(field.Groups[1].Value);
                    if (field.Groups[2].Success) fields.Add(field.Groups[2].Value);
                }

                foreach (Match writes in WritesRegex.Matches(text))
                {
                    foreach (Match name in QuotedRegex.Matches(writes.Groups[1].Value)) fields.Add(name.Groups[1].Value);
                }
            }

            return fields;
        }

        /// <summary>The longest text a field without its own limit takes.</summary>
        public const int MaxText = 1024;

        // Day windows and the cache lifetime: what the page's number inputs allow (the save path clamps the windows too).
        private const int MinDays = 1;
        private const int MaxDays = 365;

        // A quality tag's place in its list.
        private const int MaxTagOrder = 99;

        private static readonly Dictionary<string, int> TextLimits = new Dictionary<string, int>(StringComparer.Ordinal)
        {
            ["TagStyleOverrides"] = TagStyleSet.MaxDocumentLength,
            ["NativePosterTagsWebClientNames"] = 4096,
            ["TagCacheExcludedLibraryIds"] = 8192,
            ["LanguageTagsPriority"] = 256,
            ["QualityTagsPreferredAudioLanguage"] = 32,
            // Characters never outnumber UTF-8 bytes: the byte cap (on the canonical text too) is the real limit.
            ["TagOfferedPresets"] = MediaTagsPortable.MaxOfferedPresetsBytes,
            ["LeavingSoonMaintainerrUrl"] = 512,
            ["LeavingSoonMaintainerrApiKey"] = 256,
            ["LeavingSoonCollections"] = 4096,
        };

        private static readonly string[] StyleTargets = { "web", "native", "both" };

        /// <summary>
        /// Checks one value the page sends against the field's contract, with the same normalisers the server
        /// applies when it reads, seeds or saves the field, and gives the value to store (canonical spelling,
        /// normalised documents). A value those normalisers would replace, rather than only respell, is refused.
        /// </summary>
        /// <param name="field">The field (one of <see cref="Allowed"/>).</param>
        /// <param name="value">The value, already read as the property's type.</param>
        /// <param name="normalized">The value to store.</param>
        /// <param name="error">Why the value was refused.</param>
        /// <returns>True when the value is accepted.</returns>
        public static bool TryNormalize(string field, object? value, out object? normalized, out string? error)
        {
            normalized = value;
            error = null;
            if (value is string text && text.Length > (TextLimits.TryGetValue(field, out var limit) ? limit : MaxText))
            {
                error = $"longer than {(TextLimits.TryGetValue(field, out var max) ? max : MaxText)} characters";
                return false;
            }

            switch (field)
            {
                case "TagLayout":
                    return OneOf(value as string, TagLayoutRules.NormalizeLayout, TagLayoutRules.LayoutSlots.Keys, out normalized, out error);
                case "TagScale":
                    return OneOf(value as string, TagLayoutRules.NormalizeScale, new[] { "smaller", "default", "larger", "largest" }, out normalized, out error);
                case "TagGap":
                    return OneOf(value as string, TagLayoutRules.NormalizeGap, new[] { "tight", "default", "roomy" }, out normalized, out error);
                case "TagEdgeSpacing":
                    return OneOf(value as string, v => TagLayoutRules.NormalizeEdgeSpacing(v) ?? "default", TagLayoutRules.EdgeSpacings.Keys, out normalized, out error);
                case "LogoTagsMovieMode":
                    return OneOf(value as string, LogoTagRules.MovieMode, new[] { "provider", "studio", "off" }, out normalized, out error);
                case "LogoTagsSeriesMode":
                    return OneOf(value as string, LogoTagRules.SeriesMode, new[] { "network", "provider", "off" }, out normalized, out error);
                case "LogoTagsMaxLogos":
                    return InRange((int)value!, 1, LogoTagRules.MaxLogos, out error);
                case "LogoTagsRegion":
                    var region = (value as string)?.Trim().ToUpperInvariant();
                    normalized = region;
                    if (region != null && (region.Length == 0 || WatchProvidersBatch.IsValidRegion(region))) return true;
                    error = "must be empty or a valid two-letter region";
                    return false;
                case "AwardsTagsRefreshHours":
                case "LeavingSoonRefreshHours":
                    return InRange((int)value!, 1, 168, out error);
                case "LeavingSoonMaintainerrUrl":
                    var url = (value as string)?.Trim();
                    normalized = url;
                    if (url != null && (url.Length == 0 || LeavingSoonService.IsMaintainerrUrl(url))) return true;
                    error = "must be empty or an http(s) address without credentials, query or fragment";
                    return false;
                case "LeavingSoonMaintainerrApiKey":
                    var key = (value as string)?.Trim();
                    normalized = key;
                    if (key != null && key.All(c => c > ' ' && c < '\u007f')) return true;
                    error = "must be printable ASCII without spaces";
                    return false;
                case "LeavingSoonCollections":
                    var names = value as string;
                    normalized = names?.Trim();
                    if (LeavingSoonService.IsCollectionList(names)) return true;
                    error = $"must be at most {LeavingSoonService.MaxCollectionNames} names of at most {LeavingSoonService.MaxCollectionNameLength} characters";
                    return false;
                case "AwardsTagsImdbList":
                case "AwardsTagsLetterboxdList":
                    var list = (value as string)?.Trim();
                    normalized = list;
                    if (AwardTagsService.IsListId(list)) return true;
                    error = "must be a numeric list id or owner/slug";
                    return false;
                case "CustomTagRules":
                    var custom = (List<CustomTagRule>?)value;
                    var clean = CustomTagRuleSet.Normalize(custom);
                    normalized = clean;
                    if (custom != null && custom.Count <= CustomTagRuleSet.MaxRules && clean.Count == custom.Count
                        && custom.All(r => r != null && r.Value != null && r.Value.Length <= CustomTagRuleSet.MaxValueLength
                            && r.Label != null && r.Label.Length <= CustomTagRuleSet.MaxLabelLength
                            && (string.IsNullOrWhiteSpace(r.Icon) || CustomTagRuleSet.Icons.Contains(r.Icon.Trim().ToLowerInvariant())))) return true;
                    error = "must contain at most 20 complete distinct rules with valid match, value, label and icon";
                    return false;
                case "TagLabelDensity":
                    return OneOf(value as string, TagLayoutRules.NormalizeDensity, new[] { "full", "compact" }, out normalized, out error);
                case "LanguageTagsStyle":
                    return OneOf(value as string, LanguageTagDisplay.NormalizeStyle, new[] { LanguageTagDisplay.StyleFlags, LanguageTagDisplay.StyleCodes }, out normalized, out error);
                case "LanguageTagsCountBadge":
                    return OneOf(value as string, LanguageTagDisplay.NormalizeCountBadge, new[] { LanguageTagDisplay.BadgeOff, LanguageTagDisplay.BadgeOnly, LanguageTagDisplay.BadgeWithChips }, out normalized, out error);
                case "QualityAudioDisplayMode":
                    return OneOf(value as string, v => new[] { "highest", "all" }.Contains(v?.Trim().ToLowerInvariant()) ? QualityDisplayRules.Mode(v) : string.Empty, new[] { "highest", "all" }, out normalized, out error);
                case "QualityVideoCodecDisplayMode":
                    return OneOf(value as string, v => new[] { "highest", "all" }.Contains(v?.Trim().ToLowerInvariant()) ? QualityDisplayRules.Mode(v) : string.Empty, new[] { "highest", "all" }, out normalized, out error);
                case "QualityHdrDisplayMode":
                    return OneOf(value as string, v => new[] { "highest", "all" }.Contains(v?.Trim().ToLowerInvariant()) ? QualityDisplayRules.Mode(v) : string.Empty, new[] { "highest", "all" }, out normalized, out error);
                case "QualityMinimumResolution":
                    return OneOf(value as string, v => new[] { "off", "720p", "1080p", "4k" }.Contains(v?.Trim().ToLowerInvariant()) ? QualityDisplayRules.Minimum(v) : string.Empty, new[] { "off", "720p", "1080p", "4k" }, out normalized, out error);
                case "SeriesQualityAggregation":
                    return OneOf(value as string, SeriesQualityAggregation.Normalize, new[] { "representative", "latest", "best", "shared", "mixed" }, out normalized, out error);
                case "TagStyleTarget":
                    return OneOf(value as string, v => StyleTargets.FirstOrDefault(t => t == v?.Trim().ToLowerInvariant()) ?? string.Empty, StyleTargets, out normalized, out error);
                case "QualityTagsPosition":
                case "GenreTagsPosition":
                case "LanguageTagsPosition":
                case "RatingTagsPosition":
                case "AgeRatingTagsPosition":
                case "StatusTagsPosition":
                case "AwardsTagsPosition":
                case "LogoTagsPosition":
                case "CustomTagsPosition":
                    var positions = PosterTagSettings.CornerSlotPositions.Values.ToArray();
                    return OneOf(value as string, v => positions.FirstOrDefault(p => p == v?.Trim().ToLowerInvariant()) ?? string.Empty, positions, out normalized, out error);
                case "StatusTagsJustAddedDays":
                case "StatusTagsNewReleaseDays":
                case "TagsCacheTtlDays":
                    return InRange((int)value!, MinDays, MaxDays, out error);
                case "ResolutionTagOrder":
                case "SourceTagOrder":
                case "DynamicRangeTagOrder":
                case "SpecialFormatTagOrder":
                case "VideoCodecTagOrder":
                case "AudioInfoTagOrder":
                case "EditionTagOrder":
                case "RuntimeTagOrder":
                case "AspectRatioTagOrder":
                case "FrameRateTagOrder":
                case "VersionsTagOrder":

                    return InRange((int)value!, 1, MaxTagOrder, out error);
                case "ShowRuntimeTag":
                case "ShowAspectRatioTag":
                case "ShowFrameRateTag":
                case "ShowVersionsTag":
                case "StatusTagsScenes":
                    if (value is bool) return true;
                    error = "must be a boolean";
                    return false;
                case "ClearLocalStorageTimestamp":
                    if ((long)value! >= 0) return true;
                    error = "must not be negative";
                    return false;
                case "RatingTagsMinScore":
                    var minimum = (double)value!;
                    if (double.IsFinite(minimum) && minimum is >= 0 and <= 10) return true;
                    error = "must be between 0 and 10";
                    return false;
                case "RatingTagsSources":
                    var sources = (string[]?)value;
                    if (sources == null || RatingSourceSettings.NormalizeSources(sources)!.Length == sources.Length) return true;
                    error = $"must name distinct sources of {string.Join(", ", RatingSourceSettings.SourceIds)}";
                    return false;
                case "TagStyleOverrides":
                    if (TagStyleSet.TryValidate(value as string, null, out _, out error)) return true;
                    return false;
                case "TagStylePreset":
                    // The administrator's preset has no empty "follow" value (only a user's document has one).
                    if (string.IsNullOrWhiteSpace(value as string))
                    {
                        error = $"must be one of {string.Join(", ", TagStyleKeys.Presets)}";
                        return false;
                    }

                    if (TagStyleSet.TryValidate(null, value as string, out var styles, out error))
                    {
                        normalized = styles.Preset;
                        return true;
                    }

                    return false;
                case "TagCacheExcludedLibraryIds":
                    var ids = ((string?)value ?? string.Empty).Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
                    if (ids.All(id => TagLookValidation.NormalizeItemId(id) != null)) return true;
                    error = "must be library ids separated by commas";
                    return false;
                case "TagGroupOrder":
                    var order = (List<string>?)value;
                    // No order: the stored configuration reads a cleared order back as an empty list.
                    if (order is { Count: 0 }) return true;
                    normalized = TagLayoutRules.NormalizeOrder(order);
                    if (order == null || (normalized as List<string>)?.Count == order.Count) return true;
                    error = $"must name distinct groups of {string.Join(", ", TagLayoutRules.DefaultGroupOrder)}";
                    return false;
                case "TagGroupCaps":
                    var caps = (TagGroupCaps?)value;
                    normalized = TagLayoutRules.NormalizeCaps(caps);
                    if (caps == null || SameCaps(caps, normalized as TagGroupCaps)) return true;
                    error = $"caps must be between 0 and {TagLayoutRules.MaxCap}";
                    return false;
                case "TagLayouts":
                    normalized = TagLayoutRules.NormalizeProfiles((TagLayoutProfiles?)value);
                    return true;
                case "TagGroupScopes":
                    normalized = TagLayoutRules.NormalizeScopes((TagGroupScopes?)value);
                    return true;
                case "TagShapeOverrides":
                    normalized = TagShapeRules.Normalize((TagShapeOverrides?)value);
                    return true;
                case "TagOfferedPresets":
                    if (!MediaTagsPortable.TryNormalizeOfferedPresets(value as string, out var offered, out error)) return false;
                    normalized = offered;
                    return true;
                case "TagLookRules":
                    var rules = (List<TagLookRule>?)value;
                    if (rules != null && rules.Count > TagLookValidation.MaxRules)
                    {
                        error = $"more than {TagLookValidation.MaxRules} rules";
                        return false;
                    }

                    normalized = TagLookValidation.NormalizeRules(rules);
                    if (rules == null || (normalized as List<TagLookRule>)?.Count == rules.Count) return true;
                    error = "every rule needs a known layout and density and at least one valid condition";
                    return false;
                case "TagLookItemOverrides":
                    var overrides = (List<TagLookItemOverride>?)value;
                    if (overrides != null && overrides.Count > TagLookValidation.MaxItemOverrides)
                    {
                        error = $"more than {TagLookValidation.MaxItemOverrides} item looks";
                        return false;
                    }

                    // An empty list is stored as none.
                    normalized = TagLookValidation.NormalizeItemOverrides(overrides);
                    if (overrides == null || (normalized as List<TagLookItemOverride>)?.Count == overrides.Count
                        || (overrides.Count == 0 && normalized == null)) return true;
                    error = "every item look needs an item id, a known layout and density, and an id used once";
                    return false;
            }

            if (value == null)
            {
                error = "must not be null";
                return false;
            }

            return true;
        }

        // An enum-like text: accepted when it is one of the known values and the normaliser only respells it (case,
        // spaces), stored as it spells it. Membership is checked too: some normalisers answer "" for a value they do
        // not know, which an empty or blank value would otherwise match.
        private static bool OneOf(string? value, Func<string?, string> normalize, IEnumerable<string> known, out object? normalized, out string? error)
        {
            var canonical = normalize(value);
            normalized = canonical;
            error = null;
            if (value != null && known.Contains(canonical, StringComparer.Ordinal)
                && string.Equals(canonical, value.Trim(), StringComparison.OrdinalIgnoreCase)) return true;
            error = $"must be one of {string.Join(", ", known)}";
            return false;
        }

        private static bool InRange(int value, int min, int max, out string? error)
        {
            error = value >= min && value <= max ? null : $"must be between {min} and {max}";
            return error == null;
        }

        private static bool SameCaps(TagGroupCaps a, TagGroupCaps? b)
            => a.Quality == b?.Quality && a.Genre == b?.Genre && a.Language == b?.Language
                && a.Rating == b?.Rating && a.AgeRating == b?.AgeRating && a.Status == b?.Status
                && a.Awards == b?.Awards && a.Logos == b?.Logos && a.Custom == b?.Custom;

        private static IEnumerable<string> ReadSectionModules()
        {
            var assembly = typeof(MediaTagsPageFields).Assembly;
            foreach (var name in assembly.GetManifestResourceNames()
                .Where(n => n.StartsWith(SectionPrefix, StringComparison.Ordinal) && n.EndsWith(".js", StringComparison.Ordinal)))
            {
                using var stream = assembly.GetManifestResourceStream(name);
                if (stream == null) continue;
                using var reader = new StreamReader(stream);
                yield return reader.ReadToEnd();
            }
        }
    }
}
