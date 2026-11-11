using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text;
using System.Text.RegularExpressions;
using MediaBrowser.Common.Configuration;
using Newtonsoft.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Features.Admin.Models;

namespace Jellyfin.Plugin.JellyfinEnhanced.Features.Admin.Services
{
    /// <summary>
    /// Auto-detects newly added config-page settings by diffing the embedded
    /// configPage.html's control ids, plus the ids the Media Tags tab's
    /// section modules declare (js/enhanced/admintags/sections/*.js), against
    /// the last ACKNOWLEDGED baseline,
    /// powering the config page's "What's New" banner/badges with no
    /// per-release maintenance required.
    ///
    /// Runs on every startup (see StartupService.CheckForNewSettings). The
    /// baseline only advances on Dismiss() or first run, never on a plain
    /// startup, so settings from several undismissed versions in a row all
    /// stay reported until acknowledged.
    ///
    /// Two files live in the shared plugin config dir (same convention as
    /// UserConfigurationManager's reviews.json/activity.json):
    ///   - config-schema-snapshot.json: every setting id as of the last
    ///     acknowledgment. Only overwritten by Dismiss() or first run.
    ///   - whats-new.json: the current diff against that baseline, each id
    ///     tagged with the version it was first detected in. Rewritten every
    ///     startup; deleted once there's nothing pending.
    /// </summary>
    /// <summary>Where a setting lives on the configuration page's Media Tags tab: one of its own tabs, and on Groups its group.</summary>
    /// <param name="Tab">The tab id (<c>&amp;tab=</c>).</param>
    /// <param name="Group">The group id (<c>&amp;group=</c>), or null.</param>
    public sealed record MediaTagsLocation(string Tab, string? Group);

    public class WhatsNewService
    {
        private const string EmbeddedConfigPageResource = "Jellyfin.Plugin.JellyfinEnhanced.Configuration.configPage.html";
        private const string EmbeddedSeedResource = "Jellyfin.Plugin.JellyfinEnhanced.Configuration.whats-new-seed.json";

        // The Media Tags tab's section modules (the configuration page's #media-tags
        // tab builds its controls from them): embedded under this resource prefix.
        private const string MediaTagsSectionPrefix = "Jellyfin.Plugin.JellyfinEnhanced.js.enhanced.admintags.sections.";

        // A section module's one-line field declaration: { id: '<control id>', key: '<Property>', …
        private static readonly Regex SectionFieldIdRegex = new Regex(
            "^\\s*\\{ id: '(\\w+)', key: '\\w+'",
            RegexOptions.Multiline | RegexOptions.Compiled);

        // A section's tab, and its Groups-tab group: `tab: 'layout',` / `group: { id: 'quality', …`.
        private static readonly Regex SectionTabRegex = new Regex(
            "^\\s*tab: '(\\w+)'",
            RegexOptions.Multiline | RegexOptions.Compiled);

        private static readonly Regex SectionGroupRegex = new Regex(
            "^\\s*group: \\{\\s*id: '(\\w+)'",
            RegexOptions.Multiline | RegexOptions.Compiled);

        // `const NAME = [ … ];` before the sections, and a section's `fields: NAME`.
        private static readonly Regex SectionConstantRegex = new Regex(
            "const (\\w+) = \\[(.*?)\\n\\s*\\];",
            RegexOptions.Singleline | RegexOptions.Compiled);

        private static readonly Regex SectionFieldsConstantRegex = new Regex(
            "^\\s*fields: (\\w+),",
            RegexOptions.Multiline | RegexOptions.Compiled);

        /// <summary>The older Media Tags page's name (its <c>#/configurationpage?name=</c>, now forwarded to the Media Tags tab).</summary>
        public const string MediaTagsPageName = "JellyfinEnhancedMediaTags";

        // Matches id="..." anywhere inside an <input>/<select>/<textarea>/<button>
        // tag, regardless of attribute order -- [^>]* is a plain negated
        // character class, which already matches across newlines without
        // needing RegexOptions.Singleline. Buttons are included alongside
        // settings so a new one-time action (e.g. "Import from Seerr") is
        // flagged the same way a new config field would be.
        private static readonly Regex SettingIdRegex = new Regex(
            "<(?:input|select|textarea|button)\\b[^>]*\\bid=\"([^\"]+)\"",
            RegexOptions.IgnoreCase | RegexOptions.Compiled);

        // Fields rendered from jeAdmin.js's schema (id: '...') instead of configPage.html markup.
        private const string EmbeddedAdminSectionPrefix = "Jellyfin.Plugin.JellyfinEnhanced.Configuration.admin.";
        private static readonly Regex SchemaIdRegex = new Regex(
            @"\bid:\s*'([^']+)'(?=[^{}]*\btype:\s*'(?:toggle|text|password|number|textarea|select|position|button)')"
            + @"|\btype:\s*'(?:toggle|text|password|number|textarea|select|position|button)'[^{}]*?\bid:\s*'([^']+)'"
            + @"|\b(?:tog|sel|pos|T)\('([^']+)'",
            RegexOptions.Compiled);

        private readonly Logger _logger;
        private readonly string _configBaseDir;

        public WhatsNewService(IApplicationPaths appPaths, Logger logger)
        {
            _logger = logger;
            _configBaseDir = Path.Combine(appPaths.PluginsPath, "configurations", "Jellyfin.Plugin.JellyfinEnhanced");
            Directory.CreateDirectory(_configBaseDir);
        }

        private string SnapshotFilePath => Path.Combine(_configBaseDir, "config-schema-snapshot.json");
        private string WhatsNewFilePath => Path.Combine(_configBaseDir, "whats-new.json");

        /// <summary>
        /// Extracts the current set of setting ids and diffs against the last
        /// ACKNOWLEDGED baseline (not the last startup -- see class remarks).
        /// Safe, and intended, to call on every startup: it always rewrites
        /// whats-new.json to match current reality, and deletes it once
        /// there's nothing pending.
        /// </summary>
        public void CheckForNewSettings()
        {
            try
            {
                var currentVersion = JellyfinEnhanced.Instance?.Version?.ToString();
                if (string.IsNullOrEmpty(currentVersion))
                {
                    _logger.Warning("[WhatsNew] Plugin version unavailable; skipping new-settings check.");
                    return;
                }

                var currentIds = ExtractSettingIds();
                if (currentIds.Count == 0)
                {
                    _logger.Warning("[WhatsNew] No setting ids found in embedded configPage.html; skipping (likely a resource-read failure).");
                    return;
                }

                var baseline = ReadSnapshot();

                if (baseline == null)
                {
                    // First run: no baseline to diff against. A fresh install
                    // gets nothing flagged as new; an existing install
                    // upgrading into the first version with this feature
                    // falls back to the embedded seed baseline instead, so
                    // that release's own new settings still get reported.
                    // Distinguished by whether this server already has other
                    // plugin data on disk.
                    var looksLikeExistingInstall = Directory.Exists(_configBaseDir)
                        && Directory.EnumerateFileSystemEntries(_configBaseDir).Any();
                    baseline = (looksLikeExistingInstall ? ReadSeed() : null)
                        ?? new ConfigSchemaSnapshot { PluginVersion = currentVersion, SettingIds = currentIds };

                    WriteSnapshot(baseline);
                }

                var newIds = currentIds.Except(baseline.SettingIds, StringComparer.Ordinal).ToList();

                // Fully caught up: nothing to report.
                if (newIds.Count == 0 && baseline.PluginVersion == currentVersion)
                {
                    ClearWhatsNew();
                    return;
                }

                if (newIds.Count > 0)
                {
                    _logger.Info($"[WhatsNew] {newIds.Count} new setting(s) pending in {currentVersion} (vs. last-acknowledged baseline {baseline.PluginVersion}): {string.Join(", ", newIds)}");
                }
                else
                {
                    _logger.Info($"[WhatsNew] {currentVersion} has no new settings vs. last-acknowledged baseline {baseline.PluginVersion}.");
                }

                // Merge, don't overwrite: an id already recorded keeps its
                // originally-detected version instead of getting relabeled
                // with currentVersion on a later, unrelated startup.
                var previouslyRecorded = GetState()?.NewSettings ?? new Dictionary<string, string>(StringComparer.Ordinal);
                var newSettings = new Dictionary<string, string>(StringComparer.Ordinal);
                foreach (var id in newIds)
                {
                    newSettings[id] = previouslyRecorded.TryGetValue(id, out var firstSeenVersion) ? firstSeenVersion : currentVersion;
                }

                WriteWhatsNew(new WhatsNewState { PluginVersion = currentVersion, NewSettings = newSettings });
            }
            catch (Exception ex)
            {
                // Never let a what's-new detection bug block plugin startup.
                _logger.Error($"[WhatsNew] Check failed: {ex.Message}");
            }
        }

        /// <summary>Current what's-new state, or null if there's nothing pending.</summary>
        public WhatsNewState? GetState()
        {
            try
            {
                if (!File.Exists(WhatsNewFilePath)) return null;
                var json = File.ReadAllText(WhatsNewFilePath);
                if (string.IsNullOrWhiteSpace(json)) return null;
                return JsonConvert.DeserializeObject<WhatsNewState>(json);
            }
            catch (Exception ex)
            {
                _logger.Error($"[WhatsNew] Failed to read whats-new.json: {ex.Message}");
                return null;
            }
        }

        /// <summary>
        /// Acknowledges everything currently pending: advances the baseline
        /// to the full current setting-id set (so future diffs start fresh
        /// from here) and clears whats-new.json.
        /// </summary>
        public void Dismiss()
        {
            try
            {
                var currentVersion = JellyfinEnhanced.Instance?.Version?.ToString();
                var currentIds = ExtractSettingIds();
                if (!string.IsNullOrEmpty(currentVersion) && currentIds.Count > 0)
                {
                    WriteSnapshot(new ConfigSchemaSnapshot { PluginVersion = currentVersion, SettingIds = currentIds });
                }
                ClearWhatsNew();
            }
            catch (Exception ex)
            {
                _logger.Error($"[WhatsNew] Failed to dismiss: {ex.Message}");
            }
        }

        private List<string> ExtractSettingIds()
        {
            var assembly = GetType().Assembly;
            using var stream = Infrastructure.Assets.PackedResources.Open(assembly, EmbeddedConfigPageResource);
            if (stream == null)
            {
                _logger.Warning($"[WhatsNew] Embedded resource not found: {EmbeddedConfigPageResource}");
                return new List<string>();
            }

            using var reader = new StreamReader(stream);
            var html = reader.ReadToEnd();

            // The Media Tags settings keep their old ids on the Media Tags tab,
            // declared in its section modules (the tab draws them when opened).
            var sectionIds = ReadSectionModules()
                .SelectMany(text => SectionFieldIdRegex.Matches(text).Select(m => m.Groups[1].Value))
                .ToList();

            // Distinct + ordered: the same id should never repeat within one
            // page, but dedupe defensively rather than let a duplicate skew
            // the diff.
            var schemaIds = new List<string>();
            foreach (var name in Infrastructure.Assets.PackedResources.Names(assembly)
                .Where(n => n.StartsWith(EmbeddedAdminSectionPrefix, StringComparison.Ordinal) && n.EndsWith(".js", StringComparison.Ordinal)))
            {
                using var schema = Infrastructure.Assets.PackedResources.Open(assembly, name);
                if (schema == null) continue;
                using var schemaReader = new StreamReader(schema);
                schemaIds.AddRange(SchemaIdRegex.Matches(schemaReader.ReadToEnd())
                    .Select(m => m.Groups[1].Success ? m.Groups[1].Value : (m.Groups[2].Success ? m.Groups[2].Value : m.Groups[3].Value)));
            }

            return SettingIdRegex.Matches(html)
                .Select(m => m.Groups[1].Value)
                .Concat(schemaIds)
                .Concat(sectionIds)
                .Distinct(StringComparer.Ordinal)
                .ToList();
        }

        /// <summary>
        /// Where each setting the Media Tags tab declares lives on that tab (its own tab, and its group on
        /// Groups), so What's New can open it there: the tab draws its controls only once it is opened.
        /// </summary>
        /// <returns>Setting id → location.</returns>
        public IReadOnlyDictionary<string, MediaTagsLocation> GetMediaTagsLocations()
        {
            var locations = new Dictionary<string, MediaTagsLocation>(StringComparer.Ordinal);
            foreach (var text in ReadSectionModules())
            {
                foreach (var (id, location) in ParseSectionModule(text))
                {
                    locations.TryAdd(id, location);
                }
            }

            return locations;
        }

        /// <summary>
        /// The settings one section module declares, with their tab and group: each
        /// <c>registerSection({ … })</c> names its tab (and, on the Groups tab, its group) before its fields.
        /// </summary>
        /// <param name="text">The module's source.</param>
        /// <returns>Setting id → location, in declaration order.</returns>
        public static IEnumerable<KeyValuePair<string, MediaTagsLocation>> ParseSectionModule(string text)
        {
            var parts = text.Split("registerSection(");
            // Fields declared in a constant before the sections (`const FAMILY_FIELDS = [ … ];`) belong to the
            // section whose `fields:` names it; any other declared before the sections, to the first section.
            var constants = SectionConstantRegex.Matches(parts[0]).ToDictionary(
                m => m.Groups[1].Value,
                m => SectionFieldIdRegex.Matches(m.Groups[2].Value).Select(f => f.Groups[1].Value).ToList(),
                StringComparer.Ordinal);
            var located = new HashSet<string>(StringComparer.Ordinal);
            MediaTagsLocation? first = null;
            foreach (var section in parts.Skip(1))
            {
                var tab = SectionTabRegex.Match(section);
                if (!tab.Success) continue;
                var group = SectionGroupRegex.Match(section);
                var location = new MediaTagsLocation(tab.Groups[1].Value, group.Success ? group.Groups[1].Value : null);
                first ??= location;
                var named = SectionFieldsConstantRegex.Match(section);
                var ids = SectionFieldIdRegex.Matches(section).Select(m => m.Groups[1].Value)
                    .Concat(named.Success && constants.TryGetValue(named.Groups[1].Value, out var shared) ? shared : Enumerable.Empty<string>());
                foreach (var id in ids)
                {
                    if (located.Add(id)) yield return new KeyValuePair<string, MediaTagsLocation>(id, location);
                }
            }

            if (first == null) yield break;
            foreach (Match field in SectionFieldIdRegex.Matches(parts[0]))
            {
                if (located.Add(field.Groups[1].Value)) yield return new KeyValuePair<string, MediaTagsLocation>(field.Groups[1].Value, first);
            }
        }

        // The Media Tags section modules' sources, in resource-name order.
        private IEnumerable<string> ReadSectionModules()
        {
            var assembly = GetType().Assembly;
            foreach (var name in Infrastructure.Assets.PackedResources.Names(assembly)
                .Where(n => n.StartsWith(MediaTagsSectionPrefix, StringComparison.Ordinal) && n.EndsWith(".js", StringComparison.Ordinal))
                .OrderBy(n => n, StringComparer.Ordinal))
            {
                using var stream = Infrastructure.Assets.PackedResources.Open(assembly, name);
                if (stream == null) continue;
                using var reader = new StreamReader(stream);
                yield return reader.ReadToEnd();
            }
        }

        /// <summary>The setting ids from the last real release before this feature existed. See CheckForNewSettings for when this is used.</summary>
        private ConfigSchemaSnapshot? ReadSeed()
        {
            try
            {
                var assembly = GetType().Assembly;
                using var stream = Infrastructure.Assets.PackedResources.Open(assembly, EmbeddedSeedResource);
                if (stream == null)
                {
                    _logger.Warning($"[WhatsNew] Embedded seed resource not found: {EmbeddedSeedResource}");
                    return null;
                }
                using var reader = new StreamReader(stream);
                return JsonConvert.DeserializeObject<ConfigSchemaSnapshot>(reader.ReadToEnd());
            }
            catch (Exception ex)
            {
                _logger.Error($"[WhatsNew] Failed to read seed snapshot: {ex.Message}");
                return null;
            }
        }

        private ConfigSchemaSnapshot? ReadSnapshot()
        {
            try
            {
                if (!File.Exists(SnapshotFilePath)) return null;
                var json = File.ReadAllText(SnapshotFilePath);
                if (string.IsNullOrWhiteSpace(json)) return null;
                return JsonConvert.DeserializeObject<ConfigSchemaSnapshot>(json);
            }
            catch (Exception ex)
            {
                _logger.Error($"[WhatsNew] Failed to read config-schema-snapshot.json: {ex.Message}");
                return null;
            }
        }

        private void WriteSnapshot(ConfigSchemaSnapshot snapshot)
        {
            try
            {
                // A temporary file moved into place: an interrupted write leaves the previous file whole.
                UserConfigurationManager.WriteUserDocument(SnapshotFilePath, Encoding.UTF8.GetBytes(JsonConvert.SerializeObject(snapshot, Formatting.Indented)));
            }
            catch (Exception ex)
            {
                _logger.Error($"[WhatsNew] Failed to write config-schema-snapshot.json: {ex.Message}");
            }
        }

        private void WriteWhatsNew(WhatsNewState state)
        {
            try
            {
                // A temporary file moved into place: an interrupted write leaves the previous file whole.
                UserConfigurationManager.WriteUserDocument(WhatsNewFilePath, Encoding.UTF8.GetBytes(JsonConvert.SerializeObject(state, Formatting.Indented)));
            }
            catch (Exception ex)
            {
                _logger.Error($"[WhatsNew] Failed to write whats-new.json: {ex.Message}");
            }
        }

        private void ClearWhatsNew()
        {
            try
            {
                if (File.Exists(WhatsNewFilePath))
                {
                    File.Delete(WhatsNewFilePath);
                }
            }
            catch (Exception ex)
            {
                _logger.Error($"[WhatsNew] Failed to clear whats-new.json: {ex.Message}");
            }
        }
    }
}
