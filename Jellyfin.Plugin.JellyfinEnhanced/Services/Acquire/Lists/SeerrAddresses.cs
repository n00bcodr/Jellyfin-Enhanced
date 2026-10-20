using System;
using System.Linq;
using System.Security.Cryptography;
using System.Text;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists
{
    /// <summary>
    /// The configured Seerr address list as EVERY Seerr-backed read of the lists area takes it (review round 8, 4c2-R8-4: the
    /// list-source fallback used only the first address while the docs promise the next one is tried): one address per line,
    /// trimmed, without a trailing slash, blank lines and repeats left out, in the configured order. Each reader tries them in
    /// that order (through its own gate and limiter); its cache identity is <see cref="Identity"/>, the whole list with the
    /// key's fingerprint, so an answer read through one set of addresses is never reused for another.
    /// </summary>
    internal static class SeerrAddresses
    {
        /// <summary>Seerr is on, with at least one address and an API key.</summary>
        /// <param name="urls">The addresses, in order.</param>
        /// <param name="apiKey">The API key.</param>
        /// <returns>Whether Seerr can be read.</returns>
        public static bool TryGet(out string[] urls, out string apiKey)
        {
            var config = JellyfinEnhanced.Instance?.Configuration;
            urls = Array.Empty<string>();
            apiKey = string.Empty;
            if (config == null || !config.JellyseerrEnabled || string.IsNullOrWhiteSpace(config.JellyseerrUrls) || string.IsNullOrWhiteSpace(config.GetJellyseerrApiKey()))
            {
                return false;
            }

            urls = Parse(config.JellyseerrUrls);
            apiKey = config.GetJellyseerrApiKey();
            return urls.Length > 0;
        }

        /// <summary>The address list of a configured value.</summary>
        /// <param name="value">The configured addresses (one per line).</param>
        /// <returns>The addresses, in order.</returns>
        public static string[] Parse(string? value) =>
            (value ?? string.Empty)
                .Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries)
                .Select(u => u.Trim().TrimEnd('/'))
                .Where(u => u.Length > 0)
                .Distinct(StringComparer.Ordinal)
                .ToArray();

        /// <summary>The cache identity of an address list and key: every address, in order, and the key's fingerprint (never the key).</summary>
        /// <param name="urls">The addresses.</param>
        /// <param name="apiKey">The API key.</param>
        /// <returns>The identity.</returns>
        public static string Identity(string[] urls, string apiKey) =>
            string.Join('\n', urls) + "|" + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(apiKey)), 0, 8);
    }
}
