using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests
{
    /// <summary>
    /// The settings the server changes by itself as well as the configuration page (the Household tab: roles, quotas,
    /// house rules, default role; a move from Seerr or its rollback: request handling), and how a page save treats them.
    /// </summary>
    internal static class ServerOwnedSettings
    {
        private static readonly (string Field, Func<PluginConfiguration, string> Read, Action<PluginConfiguration, PluginConfiguration> Keep)[] Fields =
        {
            (nameof(PluginConfiguration.ArrRequestBackend), c => c.ArrRequestBackend ?? string.Empty, (to, from) => to.ArrRequestBackend = from.ArrRequestBackend),
            (nameof(PluginConfiguration.ArrRequestPreset), c => c.ArrRequestPreset ?? string.Empty, (to, from) => to.ArrRequestPreset = from.ArrRequestPreset),
            (nameof(PluginConfiguration.ArrRequestDefaultRole), c => c.ArrRequestDefaultRole ?? string.Empty, (to, from) => to.ArrRequestDefaultRole = from.ArrRequestDefaultRole),
            (nameof(PluginConfiguration.ArrRequestRoles), c => c.ArrRequestRoles ?? string.Empty, (to, from) => to.ArrRequestRoles = from.ArrRequestRoles),
            (nameof(PluginConfiguration.ArrRequestUsers), c => c.ArrRequestUsers ?? string.Empty, (to, from) => to.ArrRequestUsers = from.ArrRequestUsers),
            (nameof(PluginConfiguration.ArrRequestQuotaLimit), c => c.ArrRequestQuotaLimit.ToString(CultureInfo.InvariantCulture), (to, from) => to.ArrRequestQuotaLimit = from.ArrRequestQuotaLimit),
            // Phase 4b: household rules and group pools are edited on the Household tab.
            (nameof(PluginConfiguration.ArrHouseholdRules), c => c.ArrHouseholdRules ?? string.Empty, (to, from) => to.ArrHouseholdRules = from.ArrHouseholdRules),
            (nameof(PluginConfiguration.ArrHouseholdStreamingCountry), c => c.ArrHouseholdStreamingCountry ?? string.Empty, (to, from) => to.ArrHouseholdStreamingCountry = from.ArrHouseholdStreamingCountry),
            (nameof(PluginConfiguration.ArrHouseholdStreamingServices), c => c.ArrHouseholdStreamingServices ?? string.Empty, (to, from) => to.ArrHouseholdStreamingServices = from.ArrHouseholdStreamingServices),
            (nameof(PluginConfiguration.ArrGroupQuotaPools), c => c.ArrGroupQuotaPools ?? string.Empty, (to, from) => to.ArrGroupQuotaPools = from.ArrGroupQuotaPools),
        };

        /// <summary>
        /// Applies a configuration page's save to these settings, under the lock the server's own writes take: a field
        /// the page posts exactly as its read before the save had it (<see cref="PluginConfiguration.ArrServerOwnedSeen"/>)
        /// wasn't changed on the page, so it keeps the value the server holds now (a Household edit or a move that landed
        /// between that read and this save stays). A field the page changed, every field of a save without that read (an
        /// API client, an older page) and every other setting are saved as posted. The read is never kept.
        /// </summary>
        /// <param name="incoming">The configuration being saved.</param>
        /// <param name="current">The configuration the server holds now.</param>
        /// <returns>The fields that kept the server's value.</returns>
        internal static IReadOnlyList<string> Merge(PluginConfiguration incoming, PluginConfiguration current)
        {
            var kept = new List<string>();
            var seen = Read(incoming.ArrServerOwnedSeen);
            incoming.ArrServerOwnedSeen = string.Empty;
            if (seen == null) return kept;
            foreach (var (field, read, keep) in Fields)
            {
                if (!seen.TryGetValue(field, out var was) || !string.Equals(read(incoming), was, StringComparison.Ordinal)) continue;
                if (string.Equals(read(current), was, StringComparison.Ordinal)) continue;
                keep(incoming, current);
                kept.Add(field);
            }

            return kept;
        }

        private static Dictionary<string, string>? Read(string? json)
        {
            if (string.IsNullOrWhiteSpace(json) || json.Length > 1_000_000) return null;
            try
            {
                using var doc = JsonDocument.Parse(json);
                if (doc.RootElement.ValueKind != JsonValueKind.Object) return null;
                var map = new Dictionary<string, string>(StringComparer.Ordinal);
                foreach (var p in doc.RootElement.EnumerateObject())
                {
                    if (p.Value.ValueKind == JsonValueKind.String) map[p.Name] = p.Value.GetString() ?? string.Empty;
                }

                return map;
            }
            catch (JsonException)
            {
                return null;
            }
        }
    }
}
