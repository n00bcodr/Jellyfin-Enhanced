using System;
using System.Collections.Generic;
using System.Net;
using System.Net.Sockets;
using System.Threading;
using System.Threading.Tasks;

namespace Jellyfin.Plugin.JellyfinEnhanced.Helpers
{
    /// <summary>
    /// Shared best-effort URL guard for outbound requests to user-supplied Sonarr/Radarr URLs.
    /// Blocks non-HTTP schemes, known cloud metadata DNS names, and loopback/unspecified IPs.
    /// Private/LAN IPs are intentionally allowed because arr services run on local networks.
    /// All callers must be admin-gated — this is not a full SSRF control.
    /// </summary>
    public static class ArrUrlGuard
    {
        private static readonly HashSet<string> _blockedHosts = new(StringComparer.OrdinalIgnoreCase)
        {
            "metadata.google.internal",
            "metadata.goog"
        };

        private static readonly HashSet<IPAddress> _blockedIPs = new()
        {
            IPAddress.Parse("169.254.169.254"),
            IPAddress.Parse("100.100.100.200"),
            IPAddress.Parse("169.254.170.2"),
            IPAddress.Parse("fd00:ec2::254"),
            IPAddress.Loopback,
            IPAddress.IPv6Loopback,
            IPAddress.Any,
            IPAddress.IPv6Any
        };

        /// <summary>
        /// Runs the scheme + blocklist + IP-literal checks synchronously. Returns a definitive
        /// `false` for those cases, `true` when the host needs DNS resolution to decide, or `true`
        /// for a valid IP-literal host that isn't blocked. A `null` result means "need async DNS".
        /// </summary>
        private static bool? TrySyncChecks(string? url, out string host)
        {
            host = string.Empty;
            if (string.IsNullOrWhiteSpace(url)) return false;
            if (!Uri.TryCreate(url, UriKind.Absolute, out var uri)) return false;
            if (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps) return false;

            host = uri.Host.TrimEnd('.').ToLowerInvariant();
            if (_blockedHosts.Contains(host)) return false;

            if (IPAddress.TryParse(host, out var literalIp))
                return !_blockedIPs.Contains(literalIp);

            return null;  // need DNS
        }

        /// <summary>
        /// Synchronous guard, kept for non-request-path callers where blocking on DNS is fine
        /// (e.g., config validation). Request-path callers should prefer <see cref="IsAllowedUrlAsync"/>
        /// so the sync DNS call doesn't serialize the fan-out prelude on the request thread.
        /// </summary>
        public static bool IsAllowedUrl(string? url)
        {
            var sync = TrySyncChecks(url, out var host);
            if (sync.HasValue) return sync.Value;

            try
            {
                var addresses = Dns.GetHostAddresses(host);
                foreach (var addr in addresses)
                {
                    if (_blockedIPs.Contains(addr))
                        return false;
                }
            }
            catch (SocketException)
            {
                // DNS resolution failed — let the subsequent HTTP call surface its own error.
                // Hostname alone passed the allow-list; let the request proceed.
            }
            catch (ArgumentException)
            {
                return false;
            }

            return true;
        }

        /// <summary>
        /// Async variant for request-path callers. Uses <see cref="Dns.GetHostAddressesAsync"/>
        /// so the guard check yields the thread instead of blocking — avoids serializing DNS
        /// for N instances across the sync prelude of each Fetch* helper (Codex pass-3 P2).
        /// </summary>
        public static async Task<bool> IsAllowedUrlAsync(string? url, CancellationToken ct = default)
        {
            var sync = TrySyncChecks(url, out var host);
            if (sync.HasValue) return sync.Value;

            try
            {
                var addresses = await Dns.GetHostAddressesAsync(host, ct).ConfigureAwait(false);
                foreach (var addr in addresses)
                {
                    if (_blockedIPs.Contains(addr))
                        return false;
                }
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                throw;
            }
            catch (SocketException)
            {
                // See sync variant — pass-through on resolver errors.
            }
            catch (ArgumentException)
            {
                return false;
            }

            return true;
        }
    }
}
