using System;
using System.Collections.Concurrent;
using System.Net;
using System.Net.Http;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.MediaTags;

namespace Jellyfin.Plugin.JellyfinEnhanced.Features.MediaTags.Services
{
    /// <summary>
    /// The plugin's login to Reclaimerr, for what the token API cannot do (scheduled deletions, deletion
    /// requests). A service account signs in with <c>POST /api/auth/login</c>; the session cookie it gets is kept
    /// in memory only (never logged, never returned), and a 401 signs in once more. Every request goes through
    /// <see cref="MaintainerrHttp"/> (address guard, no redirects, timeout, size cap). Upstream da0ea773's
    /// <c>Services/ReclaimerrSession.cs</c>, in this feature's namespace.
    /// </summary>
    internal static class ReclaimerrSession
    {
        private static readonly ConcurrentDictionary<string, string> Cookies = new(StringComparer.Ordinal);

        /// <summary>
        /// Whether a service account is configured: a username. Its password is only for Reclaimerr's local login; with the
        /// trusted-proxy sign-in (<see cref="ActsAsUser"/>) the account signs in by name alone, which keeps working when
        /// Reclaimerr has local login switched off.
        /// </summary>
        internal static bool HasAccount(PluginConfiguration? config) => LeavingSoonSources.HasReclaimerrAccount(config);

        private static readonly ConcurrentDictionary<string, DateTimeOffset> HeaderRejectedUntil = new(StringComparer.Ordinal);
        private static readonly TimeSpan HeaderRetry = TimeSpan.FromMinutes(5);

        private static string Key(PluginConfiguration config) => config.ReclaimerrUrl.Trim().TrimEnd('/') + "\n" + config.ReclaimerrUsername.Trim();

        /// <summary>
        /// The Reclaimerr username for a Jellyfin user: the configured mapping (<c>Jellyfin name = Reclaimerr name</c>, one per
        /// line, case-insensitive on the Jellyfin side), else the same name.
        /// </summary>
        internal static string UserFor(PluginConfiguration config, string jellyfinUser) => MappedUser(config, jellyfinUser) ?? jellyfinUser;

        /// <summary>The Reclaimerr username the mapping lists for a Jellyfin user, or null when it does not list them.</summary>
        internal static string? MappedUser(PluginConfiguration config, string jellyfinUser)
        {
            foreach (var line in (config.ReclaimerrUserMap ?? string.Empty).Split(new[] { '\n', '\r' }, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
            {
                var cut = line.IndexOf('=');
                if (cut <= 0) continue;
                if (string.Equals(line[..cut].Trim(), jellyfinUser, StringComparison.OrdinalIgnoreCase) && line[(cut + 1)..].Trim() is { Length: > 0 } mapped) return mapped;
            }

            return null;
        }

        /// <summary>Whether acting as the Jellyfin user is on.</summary>
        internal static bool ActsAsUser(PluginConfiguration? config) => config != null && config.ReclaimerrActAsUser && !string.IsNullOrWhiteSpace(config.ReclaimerrUserHeader);

        /// <summary>
        /// One request to Reclaimerr as <paramref name="reclaimerrUser"/> through its trusted-proxy sign-in: no bearer token and
        /// no cookie, only the user header. Reclaimerr answers 401 when the feature is off, this address is not trusted or the
        /// user does not exist, and the caller then falls back to the service account.
        /// </summary>
        internal static Task<JsonDocument> SendAsUserAsync(IHttpClientFactory http, PluginConfiguration config, string reclaimerrUser, HttpMethod method, string path, string? body, TimeSpan timeout, Action<Uri, Uri?>? onRedirect, CancellationToken token)
            => MaintainerrHttp.SendAsync(http, config, method, config.ReclaimerrUrl.Trim().TrimEnd('/') + path, body, timeout, onRedirect, token, null, null, (config.ReclaimerrUserHeader.Trim(), reclaimerrUser));

        /// <summary>Forget the cookie (a changed account or address).</summary>
        internal static void Forget(PluginConfiguration config) { Cookies.TryRemove(Key(config), out _); HeaderRejectedUntil.TryRemove(Key(config), out _); }

        /// <summary>
        /// Send <paramref name="method"/> to <paramref name="path"/> on Reclaimerr as the service account and parse
        /// the JSON answer; signs in first when no session is held and once more after a 401.
        /// </summary>
        internal static async Task<JsonDocument> SendAsync(IHttpClientFactory http, PluginConfiguration config, HttpMethod method, string path, string? body, TimeSpan timeout, Action<Uri, Uri?>? onRedirect, CancellationToken token)
        {
            if (!HasAccount(config)) throw new InvalidOperationException("No Reclaimerr service account is set.");
            var baseUrl = config.ReclaimerrUrl.Trim().TrimEnd('/');
            // First by name through the trusted-proxy sign-in (no password, works with local login off); when Reclaimerr does not
            // accept that (the feature is off, this address is not trusted) fall back to the local login below, and do not
            // try the name again for five minutes.
            if (ActsAsUser(config) && !(HeaderRejectedUntil.TryGetValue(Key(config), out var until) && until > DateTimeOffset.UtcNow))
            {
                try
                {
                    return await SendAsUserAsync(http, config, config.ReclaimerrUsername.Trim(), method, path, body, timeout, onRedirect, token).ConfigureAwait(false);
                }
                catch (MaintainerrHttp.MaintainerrException e) when (e.Status == (int)HttpStatusCode.Unauthorized)
                {
                    HeaderRejectedUntil[Key(config)] = DateTimeOffset.UtcNow + HeaderRetry;
                }
            }

            if (string.IsNullOrEmpty(config.ReclaimerrPassword)) throw new MaintainerrHttp.MaintainerrException((int)HttpStatusCode.Unauthorized, "Reclaimerr did not accept the service account by name (its trusted-proxy sign-in is off or this address is not trusted) and no password is set.");
            for (var attempt = 0; ; attempt++)
            {
                if (!Cookies.TryGetValue(Key(config), out var cookie)) cookie = await LoginAsync(http, config, baseUrl, timeout, onRedirect, token).ConfigureAwait(false);
                try
                {
                    return await MaintainerrHttp.SendAsync(http, config, method, baseUrl + path, body, timeout, onRedirect, token, cookie).ConfigureAwait(false);
                }
                catch (MaintainerrHttp.MaintainerrException e) when (e.Status == (int)HttpStatusCode.Unauthorized && attempt == 0)
                {
                    Cookies.TryRemove(Key(config), out _);
                }
            }
        }

        /// <summary>
        /// Create the plugin's own Reclaimerr admin account, signing in once as an administrator whose password is
        /// used for this call only (never stored or logged). The new account gets a random password.
        /// </summary>
        internal static async Task<(string Username, string Password)> CreateServiceAccountAsync(IHttpClientFactory http, PluginConfiguration config, string adminUsername, string adminPassword, TimeSpan timeout, CancellationToken token)
        {
            var baseUrl = config.ReclaimerrUrl.Trim().TrimEnd('/');
            const string username = "jellyfin-enhanced";
            var password = Convert.ToBase64String(System.Security.Cryptography.RandomNumberGenerator.GetBytes(24)).Replace('+', '-').Replace('/', '_');
            var body = JsonSerializer.Serialize(new { username, password, display_name = "Jellyfin Enhanced", role = "admin", permissions = Array.Empty<string>(), require_password_change = false });
            if (string.IsNullOrEmpty(adminPassword))
            {
                // No password given: act as that Reclaimerr administrator by name (trusted-proxy sign-in), which works with local login off.
                using (await SendAsUserAsync(http, config, adminUsername.Trim(), HttpMethod.Post, "/api/account/users", body, timeout, null, token).ConfigureAwait(false)) { }
                return (username, password);
            }

            string? cookie = null;
            using (await MaintainerrHttp.SendAsync(http, config, HttpMethod.Post, baseUrl + "/api/auth/login", JsonSerializer.Serialize(new { username = adminUsername.Trim(), password = adminPassword }), timeout, null, token, cookie: string.Empty, onSetCookie: c => cookie = c).ConfigureAwait(false)) { }
            if (cookie == null) throw new InvalidOperationException("Reclaimerr did not return a session.");
            using (await MaintainerrHttp.SendAsync(http, config, HttpMethod.Post, baseUrl + "/api/account/users", body, timeout, null, token, cookie).ConfigureAwait(false)) { }
            return (username, password);
        }

        private static async Task<string> LoginAsync(IHttpClientFactory http, PluginConfiguration config, string baseUrl, TimeSpan timeout, Action<Uri, Uri?>? onRedirect, CancellationToken token)
        {
            string? cookie = null;
            var body = JsonSerializer.Serialize(new { username = config.ReclaimerrUsername.Trim(), password = config.ReclaimerrPassword });
            using var _ = await MaintainerrHttp.SendAsync(http, config, HttpMethod.Post, baseUrl + "/api/auth/login", body, timeout, onRedirect, token, cookie: string.Empty, onSetCookie: c => cookie = c).ConfigureAwait(false);
            if (cookie == null) throw new InvalidOperationException("Reclaimerr did not return a session.");
            Cookies[Key(config)] = cookie;
            return cookie;
        }
    }
}
