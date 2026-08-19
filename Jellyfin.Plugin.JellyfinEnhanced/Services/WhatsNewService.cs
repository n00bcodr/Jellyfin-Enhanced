using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text.RegularExpressions;
using Jellyfin.Plugin.JellyfinEnhanced.Model;
using MediaBrowser.Common.Configuration;
using Newtonsoft.Json;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services
{
    /// <summary>
    /// Auto-detects newly added config-page settings by diffing the embedded
    /// configPage.html's control ids against the last ACKNOWLEDGED baseline,
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
    public class WhatsNewService
    {
        private const string EmbeddedConfigPageResource = "Jellyfin.Plugin.JellyfinEnhanced.Configuration.configPage.html";
        private const string EmbeddedSeedResource = "Jellyfin.Plugin.JellyfinEnhanced.Configuration.whats-new-seed.json";

        // Matches id="..." anywhere inside an <input>/<select>/<textarea>/<button>
        // tag, regardless of attribute order -- [^>]* is a plain negated
        // character class, which already matches across newlines without
        // needing RegexOptions.Singleline. Buttons are included alongside
        // settings so a new one-time action (e.g. "Import from Seerr") is
        // flagged the same way a new config field would be.
        private static readonly Regex SettingIdRegex = new Regex(
            "<(?:input|select|textarea|button)\\b[^>]*\\bid=\"([^\"]+)\"",
            RegexOptions.IgnoreCase | RegexOptions.Compiled);

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
            using var stream = assembly.GetManifestResourceStream(EmbeddedConfigPageResource);
            if (stream == null)
            {
                _logger.Warning($"[WhatsNew] Embedded resource not found: {EmbeddedConfigPageResource}");
                return new List<string>();
            }

            using var reader = new StreamReader(stream);
            var html = reader.ReadToEnd();

            // Distinct + ordered: the same id should never repeat within one
            // page, but dedupe defensively rather than let a duplicate skew
            // the diff.
            return SettingIdRegex.Matches(html)
                .Select(m => m.Groups[1].Value)
                .Distinct(StringComparer.Ordinal)
                .ToList();
        }

        /// <summary>The setting ids from the last real release before this feature existed. See CheckForNewSettings for when this is used.</summary>
        private ConfigSchemaSnapshot? ReadSeed()
        {
            try
            {
                var assembly = GetType().Assembly;
                using var stream = assembly.GetManifestResourceStream(EmbeddedSeedResource);
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
                File.WriteAllText(SnapshotFilePath, JsonConvert.SerializeObject(snapshot, Formatting.Indented));
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
                File.WriteAllText(WhatsNewFilePath, JsonConvert.SerializeObject(state, Formatting.Indented));
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
