using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Jellyfin.Plugin.JellyfinEnhanced.Helpers.Jellyseerr
{
    /// <summary>
    /// Strips release details from the download rows Seerr embeds in its media answers
    /// (<c>downloadStatus</c> / <c>downloadStatus4k</c> on details, lists, collections and requests) before
    /// they reach someone who isn't an administrator. Seerr copies each row from Sonarr/Radarr's queue,
    /// release name, download id and arr ids included. A non-admin gets only what the progress popover and the
    /// season list need: a status from a fixed list, size and size left, a sanity-checked completion time, the
    /// season and episode numbers, and an opaque group token (rows of one download share it). The arr link
    /// Seerr keeps on the same media object (<c>serviceUrl</c>, built from the Sonarr/Radarr address, and the
    /// arr's own ids and slug) is removed too (§4.11: no arr addresses or ids for non-admins). Applied per
    /// caller on the way out, so the shared response cache keeps Seerr's own body. A body that can't be read
    /// fails closed.
    /// </summary>
    public static class SeerrDownloadStatusProjector
    {
        private static readonly string[] Properties = { "downloadStatus", "downloadStatus4k" };

        // Seerr's link from a media object to its Sonarr/Radarr entry (and the arr's address inside serviceUrl).
        private static readonly HashSet<string> ArrLink = new(StringComparer.Ordinal)
        {
            "serviceUrl", "serviceUrl4k", "serviceId", "serviceId4k", "externalServiceId", "externalServiceId4k",
            "externalServiceSlug", "externalServiceSlug4k",
        };

        // Substrings that mark a body worth parsing (case-insensitive): download rows or an arr link.
        private static readonly string[] Markers = { "ownloadStatus", "erviceUrl", "erviceId", "xternalService" };

        private static readonly HashSet<string> Statuses = new(StringComparer.OrdinalIgnoreCase)
        {
            "queued", "paused", "downloading", "completed", "delay", "warning", "failed",
        };

        /// <summary>
        /// Projects every download row in <paramref name="body"/> and drops every arr link. False when the body
        /// isn't JSON (the caller must not pass it on). A body without either is returned unchanged without parsing.
        /// </summary>
        /// <param name="body">Seerr's JSON body.</param>
        /// <param name="now">Clock for the completion-time check.</param>
        /// <param name="projected">The body to send.</param>
        public static bool TryProject(string body, DateTimeOffset now, out string projected)
        {
            projected = body;
            if (string.IsNullOrEmpty(body)) return true;
            // An escaped property name (downloadStatus) is the same property to a JSON reader.
            if (Array.TrueForAll(Markers, m => body.IndexOf(m, StringComparison.OrdinalIgnoreCase) < 0) && body.IndexOf("\\u", StringComparison.Ordinal) < 0) return true;
            try
            {
                var root = JsonNode.Parse(body);
                if (root == null) return false;
                var groups = new Dictionary<string, string>(StringComparer.Ordinal);
                if (!Project(root, now, groups)) return true;
                projected = root.ToJsonString();
                return true;
            }
            catch (JsonException)
            {
                return false;
            }
            catch (InvalidOperationException)
            {
                return false;
            }
        }

        // Rewrites download rows and drops arr links below the node; true when anything was rewritten.
        private static bool Project(JsonNode node, DateTimeOffset now, Dictionary<string, string> groups)
        {
            var changed = false;
            if (node is JsonArray array)
            {
                foreach (var item in array)
                {
                    if (item != null) changed |= Project(item, now, groups);
                }
                return changed;
            }
            if (node is not JsonObject value) return false;
            List<(string Name, JsonArray Rows)>? replacements = null;
            List<string>? removals = null;
            foreach (var (name, child) in value)
            {
                if (ArrLink.Contains(name))
                {
                    (removals ??= new()).Add(name);
                    continue;
                }
                if (Array.IndexOf(Properties, name) >= 0)
                {
                    var rows = new JsonArray();
                    if (child is JsonArray raw)
                    {
                        foreach (var row in raw)
                        {
                            if (row is JsonObject download) rows.Add(Row(download, now, groups));
                        }
                    }
                    // A null or malformed relation keeps the array contract with no rows.
                    (replacements ??= new()).Add((name, rows));
                    continue;
                }
                if (child != null) changed |= Project(child, now, groups);
            }
            if (removals != null)
            {
                foreach (var name in removals) value.Remove(name);
                changed = true;
            }
            if (replacements == null) return changed;
            foreach (var (name, rows) in replacements) value[name] = rows;
            return true;
        }

        private static JsonObject Row(JsonObject download, DateTimeOffset now, Dictionary<string, string> groups)
        {
            var status = Text(download["status"]);
            var row = new JsonObject { ["status"] = status != null && Statuses.Contains(status) ? status.ToLowerInvariant() : "unknown" };
            if (Number(download["size"]) is double size) row["size"] = size;
            if (Number(download["sizeLeft"]) is double left) row["sizeLeft"] = left;
            // Only a plausible completion time: not long past, not absurdly far ahead.
            if (Text(download["estimatedCompletionTime"]) is { } eta &&
                DateTimeOffset.TryParse(eta, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var at) &&
                at > now.AddDays(-1) && at < now.AddDays(365))
                row["estimatedCompletionTime"] = at.UtcDateTime.ToString("yyyy-MM-ddTHH:mm:ss.fffZ", CultureInfo.InvariantCulture);
            if (download["episode"] is JsonObject episode)
            {
                var numbers = new JsonObject();
                if (Number(episode["seasonNumber"]) is double season && season >= 0) numbers["seasonNumber"] = (int)season;
                if (Number(episode["episodeNumber"]) is double number && number >= 0) numbers["episodeNumber"] = (int)number;
                if (numbers.Count > 0) row["episode"] = numbers;
            }
            // Rows of one download (a season pack) share a token that means nothing outside this answer.
            var id = Text(download["downloadId"]) ?? Text(download["externalId"]) ?? Number(download["externalId"])?.ToString(CultureInfo.InvariantCulture);
            if (id != null)
            {
                if (!groups.TryGetValue(id, out var token)) groups[id] = token = "g" + (groups.Count + 1).ToString(CultureInfo.InvariantCulture);
                row["group"] = token;
            }
            return row;
        }

        private static string? Text(JsonNode? node)
            => node is JsonValue value && value.TryGetValue<string>(out var text) ? text : null;

        private static double? Number(JsonNode? node)
        {
            if (node is not JsonValue value) return null;
            if (value.TryGetValue<double>(out var number) && double.IsFinite(number) && number >= 0) return number;
            if (value.TryGetValue<long>(out var whole) && whole >= 0) return whole;
            return null;
        }
    }
}
