using System;
using System.Collections.Generic;
using System.Linq;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;

namespace Jellyfin.Plugin.JellyfinEnhanced.Shared.MediaTags
{
    /// <summary>
    /// The Leaving soon source settings: whether one is configured, and what the admin page accepts. Static and pure;
    /// extracted verbatim from <c>LeavingSoonService</c> (round 13, backend.md §7.7) because the poster settings and the
    /// admin page field rules in <c>Shared/</c> need them, and <c>LeavingSoonService</c> is MediaTags' stateful service.
    /// </summary>
    public static class LeavingSoonSources
    {
        /// <summary>Most collection names the fallback list takes.</summary>
        public const int MaxCollectionNames = 20;
        /// <summary>Longest collection name the fallback list takes.</summary>
        public const int MaxCollectionNameLength = 200;

        /// <summary>Whether a source is set: a usable Maintainerr URL or at least one collection name.</summary>
        public static bool Configured(PluginConfiguration? config)
            => config != null && (IsMaintainerrUrl(config.LeavingSoonMaintainerrUrl) || CollectionNames(config.LeavingSoonCollections).Count > 0);

        /// <summary>An absolute http(s) base URL without credentials, query or fragment (empty is not one).</summary>
        public static bool IsMaintainerrUrl(string? url)
        {
            if (string.IsNullOrWhiteSpace(url) || url.Length > 512) return false;
            if (!Uri.TryCreate(url.Trim(), UriKind.Absolute, out var uri)) return false;
            return (uri.Scheme == Uri.UriSchemeHttp || uri.Scheme == Uri.UriSchemeHttps)
                && string.IsNullOrEmpty(uri.UserInfo) && string.IsNullOrEmpty(uri.Query) && string.IsNullOrEmpty(uri.Fragment)
                && !string.IsNullOrEmpty(uri.Host);
        }

        /// <summary>The fallback collection names: one per line or comma separated, trimmed, distinct (case-insensitive), bounded.</summary>
        public static IReadOnlyList<string> CollectionNames(string? text)
        {
            if (string.IsNullOrWhiteSpace(text)) return Array.Empty<string>();
            return text.Split(new[] { '\n', '\r', ',' }, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                .Where(n => n.Length is > 0 and <= MaxCollectionNameLength)
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .Take(MaxCollectionNames)
                .ToArray();
        }

        /// <summary>
        /// Whether administrators' Maintainerr actions (mark, keep, postpone from the item menu) are on: their switch and
        /// a Maintainerr URL.
        /// </summary>
        public static bool MaintainerrActionsEnabled(PluginConfiguration? config)
            => config != null && config.LeavingSoonMaintainerrActions && IsMaintainerrUrl(config.LeavingSoonMaintainerrUrl);

        /// <summary>Whether the Leaving soon Home Screen Sections row is wanted: its switch and a Maintainerr URL.</summary>
        public static bool HomeRowWanted(PluginConfiguration? config)
            => config != null && config.LeavingSoonHomeRow && IsMaintainerrUrl(config.LeavingSoonMaintainerrUrl);

        /// <summary>
        /// Check the source fields of a configuration a save brings (the Services tab's Maintainerr card, an API
        /// call or a restored backup) against their contracts and store them trimmed: a Maintainerr address that
        /// is not an <c>http(s)</c> address without credentials, query or fragment, a key with characters outside
        /// printable ASCII or spaces, or a collection list over its bounds keeps the stored value
        /// (<paramref name="current"/>, or empty); the refresh hours are clamped to 1 to 168. Returns what was
        /// refused (names only, never the values, so a key cannot reach a log).
        /// </summary>
        public static IReadOnlyList<string> NormalizeSource(PluginConfiguration incoming, PluginConfiguration? current)
        {
            var problems = new List<string>();
            var url = (incoming.LeavingSoonMaintainerrUrl ?? string.Empty).Trim();
            if (url.Length == 0 || IsMaintainerrUrl(url)) incoming.LeavingSoonMaintainerrUrl = url;
            else { incoming.LeavingSoonMaintainerrUrl = current?.LeavingSoonMaintainerrUrl ?? string.Empty; problems.Add("Maintainerr URL is not an http(s) address without credentials, query or fragment"); }

            var key = (incoming.LeavingSoonMaintainerrApiKey ?? string.Empty).Trim();
            if (key.Length <= 256 && key.All(c => c > ' ' && c < '\u007f')) incoming.LeavingSoonMaintainerrApiKey = key;
            else { incoming.LeavingSoonMaintainerrApiKey = current?.LeavingSoonMaintainerrApiKey ?? string.Empty; problems.Add("Maintainerr API key is not printable ASCII without spaces (256 characters at most)"); }

            var names = incoming.LeavingSoonCollections ?? string.Empty;
            if (IsCollectionList(names) && names.Length <= 4096) incoming.LeavingSoonCollections = names.Trim();
            else { incoming.LeavingSoonCollections = current?.LeavingSoonCollections ?? string.Empty; problems.Add($"Leaving collections are over {MaxCollectionNames} names of {MaxCollectionNameLength} characters"); }

            incoming.LeavingSoonRefreshHours = Math.Clamp(incoming.LeavingSoonRefreshHours, 1, 168);
            return problems;
        }

        /// <summary>Whether a fallback list is acceptable as typed: every name within bounds and at most <see cref="MaxCollectionNames"/>.</summary>
        public static bool IsCollectionList(string? text)
        {
            if (text == null) return false;
            var names = text.Split(new[] { '\n', '\r', ',' }, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                .Where(n => n.Length > 0).ToArray();
            return names.All(n => n.Length <= MaxCollectionNameLength) && names.Distinct(StringComparer.OrdinalIgnoreCase).Count() <= MaxCollectionNames;
        }
    }
}
