using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Globalization;
using System.Net.Http;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services
{
    /// <summary>
    /// The plugin's way into Reclaimerr (<see cref="MinimumVersionText"/> or newer). Everything goes through its token API
    /// (<c>/api/v1</c>, the bearer token), except filing a deletion request for a user: Reclaimerr only takes that from the
    /// user themself, so <see cref="SendAsUserAsync"/> signs in as them through Reclaimerr's trusted-proxy sign-in. Every call
    /// first checks the version (<see cref="EnsureSupportedAsync"/>), because an older Reclaimerr lacks these endpoints. Each
    /// request goes through <see cref="MaintainerrHttp"/> (address guard, no redirects, timeout, size cap).
    /// </summary>
    internal static class ReclaimerrApi
    {
        /// <summary>The oldest Reclaimerr the plugin works with: the first with the leaving-soon feed, delete requests, scheduled
        /// deletions, users and media server ids in its token API, and its real version in <c>/openapi.json</c>.</summary>
        internal static readonly Version MinimumVersion = new(0, 6, 15);

        /// <summary><see cref="MinimumVersion"/> as people read it.</summary>
        internal const string MinimumVersionText = "0.6.15";

        /// <summary>Largest page Reclaimerr's lists give.</summary>
        internal const int PageSize = 200;

        private static readonly ConcurrentDictionary<string, (DateTimeOffset At, Version? Found, string? Reported)> Versions = new(StringComparer.Ordinal);

        /// <summary>
        /// A whole version text: an optional <c>v</c>, major.minor.patch with an optional pre-release tag (<c>-dev.1</c>, <c>-dev1</c>,
        /// <c>dev1</c>, <c>.dev1</c>, <c>-rc.2</c>) and build tag (<c>+abc</c>), or major.minor with an optional <c>-</c> tag. Nothing may follow.
        /// </summary>
        private static readonly System.Text.RegularExpressions.Regex VersionPattern = new(@"^\s*[vV]?(\d{1,9})\.(\d{1,9})(?:\.(\d{1,9})(?:-[0-9A-Za-z][0-9A-Za-z.-]*|\.?[A-Za-z][0-9A-Za-z.-]*)?|(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?)(?:\+[0-9A-Za-z.-]+)?\s*$", System.Text.RegularExpressions.RegexOptions.CultureInvariant);
        private static readonly TimeSpan SupportedTtl = TimeSpan.FromMinutes(10);
        private static readonly TimeSpan UnsupportedTtl = TimeSpan.FromMinutes(1);

        /// <summary>The clock (tests move it).</summary>
        internal static Func<DateTimeOffset> Now { get; set; } = () => DateTimeOffset.UtcNow;

        /// <summary>The configured address without a trailing slash.</summary>
        internal static string BaseUrl(PluginConfiguration config) => (config.ReclaimerrUrl ?? string.Empty).Trim().TrimEnd('/');

        /// <summary>Whether users can file removal requests: as themselves, through Reclaimerr's trusted-proxy sign-in.</summary>
        internal static bool RequestsAsUser(PluginConfiguration? config)
            => config != null && config.ReclaimerrUserRequests && !string.IsNullOrWhiteSpace(config.ReclaimerrUserHeader);

        /// <summary>
        /// The release a version text names, or null when the whole text is not a version. A development build counts as the release it leads up to,
        /// because Reclaimerr's development builds of a release already carry its endpoints: <c>0.6.15</c>, <c>v0.6.15</c>,
        /// <c>0.6.15-dev.1</c>, <c>0.6.15-dev1</c>, <c>0.6.15dev1</c> and <c>0.6.15.dev1</c> are all 0.6.15, and <c>0.6.16-dev</c> is 0.6.16.
        /// </summary>
        internal static Version? ParseVersion(string? text)
        {
            if (string.IsNullOrWhiteSpace(text)) return null;
            var match = VersionPattern.Match(text);
            if (!match.Success) return null;
            static int Part(System.Text.RegularExpressions.Group g) => g.Success ? int.Parse(g.Value, NumberStyles.None, CultureInfo.InvariantCulture) : 0;
            return new Version(Part(match.Groups[1]), Part(match.Groups[2]), Part(match.Groups[3]));
        }

        /// <summary>Forget what is known about a Reclaimerr's version (tests, or after a changed address).</summary>
        internal static void ForgetVersions() => Versions.Clear();

        /// <summary>
        /// Throw <see cref="VersionException"/> unless the Reclaimerr at the configured address is <see cref="MinimumVersionText"/>
        /// or newer, read from its public <c>/openapi.json</c> (<c>info.version</c>; every release before 0.6.15 says 0.6.1 there).
        /// A supported answer is kept for ten minutes and a refusal for one, so an upgrade is seen quickly. A failed read throws
        /// the read's own error and is not kept.
        /// </summary>
        internal static async Task EnsureSupportedAsync(IHttpClientFactory http, PluginConfiguration config, TimeSpan timeout, Action<Uri, Uri?>? onRedirect, CancellationToken token)
        {
            var key = BaseUrl(config);
            if (Versions.TryGetValue(key, out var known) && Now() - known.At < (Supported(known.Found) ? SupportedTtl : UnsupportedTtl))
            {
                if (Supported(known.Found)) return;
                throw new VersionException(known.Reported);
            }

            string? reported = null;
            using (var doc = await MaintainerrHttp.SendAsync(http, config, HttpMethod.Get, key + "/openapi.json", null, timeout, onRedirect, token).ConfigureAwait(false))
            {
                if (doc.RootElement.ValueKind == JsonValueKind.Object && doc.RootElement.TryGetProperty("info", out var info) && info.ValueKind == JsonValueKind.Object
                    && info.TryGetProperty("version", out var version) && version.ValueKind == JsonValueKind.String) reported = version.GetString()?.Trim();
            }

            var found = ParseVersion(reported);
            Versions[key] = (Now(), found, reported);
            if (!Supported(found)) throw new VersionException(reported);
        }

        private static bool Supported(Version? found) => found != null && found >= MinimumVersion;

        /// <summary>One call to the token API (<paramref name="path"/> starts <c>/api/v1</c>), after the version check.</summary>
        internal static async Task<JsonDocument> TokenAsync(IHttpClientFactory http, PluginConfiguration config, HttpMethod method, string path, object? body, TimeSpan timeout, Action<Uri, Uri?>? onRedirect, CancellationToken token)
        {
            await EnsureSupportedAsync(http, config, timeout, onRedirect, token).ConfigureAwait(false);
            return await MaintainerrHttp.SendAsync(http, config, method, BaseUrl(config) + path, body == null ? null : JsonSerializer.Serialize(body), timeout, onRedirect, token).ConfigureAwait(false);
        }

        /// <summary>
        /// Every entry of a paged token-API list (<c>{items, total_pages}</c>), <see cref="PageSize"/> at a time, at most
        /// <paramref name="maxPages"/> pages, and whether that was all of it. An answer that is not such a list throws.
        /// </summary>
        internal static async Task<(List<JsonElement> Items, bool Complete)> ListPagesAsync(IHttpClientFactory http, PluginConfiguration config, string path, int maxPages, TimeSpan timeout, Action<Uri, Uri?>? onRedirect, CancellationToken token)
        {
            var all = new List<JsonElement>();
            var join = path.Contains('?', StringComparison.Ordinal) ? '&' : '?';
            for (var page = 1; page <= maxPages; page++)
            {
                using var doc = await TokenAsync(http, config, HttpMethod.Get, path + join + "per_page=" + PageSize.ToString(CultureInfo.InvariantCulture) + "&page=" + page.ToString(CultureInfo.InvariantCulture), null, timeout, onRedirect, token).ConfigureAwait(false);
                var root = doc.RootElement;
                if (root.ValueKind != JsonValueKind.Object || !root.TryGetProperty("items", out var items) || items.ValueKind != JsonValueKind.Array) throw new FormatException("Not a Reclaimerr list.");
                foreach (var item in items.EnumerateArray()) all.Add(item.Clone());
                var pages = root.TryGetProperty("total_pages", out var total) && total.TryGetInt32(out var count) ? count : page;
                if (items.GetArrayLength() == 0 || page >= pages) return (all, true);
            }

            return (all, false);
        }

        /// <summary>A short fingerprint of the Reclaimerr in use (its address), so an answer read from one is never acted on at another.</summary>
        internal static string SourceId(PluginConfiguration config)
            => Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(BaseUrl(config).ToLowerInvariant())))[..16].ToLowerInvariant();

        /// <summary>
        /// One request to Reclaimerr as <paramref name="reclaimerrUser"/> through its trusted-proxy sign-in: no bearer token, only
        /// the user header. Reclaimerr answers 401 when the feature is off, this address is not trusted or the user does not exist.
        /// </summary>
        internal static async Task<JsonDocument> SendAsUserAsync(IHttpClientFactory http, PluginConfiguration config, string reclaimerrUser, HttpMethod method, string path, object? body, TimeSpan timeout, CancellationToken token)
        {
            await EnsureSupportedAsync(http, config, timeout, null, token).ConfigureAwait(false);
            return await MaintainerrHttp.SendAsync(http, config, method, BaseUrl(config) + path, body == null ? null : JsonSerializer.Serialize(body), timeout, null, token, (config.ReclaimerrUserHeader.Trim(), reclaimerrUser)).ConfigureAwait(false);
        }

        /// <summary>The Jellyfin ids among Reclaimerr's linked identities or media server items (<c>source_service</c> jellyfin), parsed.</summary>
        internal static List<Guid> JellyfinIds(JsonElement list, string idName)
        {
            var ids = new List<Guid>();
            if (list.ValueKind != JsonValueKind.Array) return ids;
            foreach (var entry in list.EnumerateArray())
            {
                if (entry.ValueKind != JsonValueKind.Object) continue;
                if (!entry.TryGetProperty("source_service", out var service) || service.ValueKind != JsonValueKind.String || !string.Equals(service.GetString(), "jellyfin", StringComparison.OrdinalIgnoreCase)) continue;
                if (entry.TryGetProperty(idName, out var id) && id.ValueKind == JsonValueKind.String && Guid.TryParse(id.GetString(), out var guid) && guid != Guid.Empty && !ids.Contains(guid)) ids.Add(guid);
            }

            return ids;
        }

        /// <summary>This Reclaimerr is older than <see cref="MinimumVersionText"/> (or does not say which it is).</summary>
        internal sealed class VersionException : Exception
        {
            /// <param name="reported">The version text Reclaimerr gave (clipped), or null when it gave none.</param>
            public VersionException(string? reported)
                : base(string.IsNullOrWhiteSpace(reported) || ParseVersion(reported) == null
                    ? $"Reclaimerr did not say which version it is; Jellyfin Enhanced needs {MinimumVersionText} or newer"
                    : $"This Reclaimerr is older than {MinimumVersionText} (it reports {(reported.Length <= 40 ? reported : reported[..40])}); Jellyfin Enhanced needs {MinimumVersionText} or newer")
            {
            }
        }
    }
}
