using System;
using System.Collections.Generic;
using System.Net;
using System.Net.Sockets;
using System.Threading;
using System.Threading.Tasks;

namespace Jellyfin.Plugin.JellyfinEnhanced.Helpers
{
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
            IPAddress.Any,
            IPAddress.IPv6Any
        };

        private static bool? TrySyncChecks(string? url, out string host)
        {
            host = string.Empty;
            if (string.IsNullOrWhiteSpace(url)) return false;
            if (!Uri.TryCreate(url, UriKind.Absolute, out var uri)) return false;
            if (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps) return false;

            host = uri.Host.TrimEnd('.').ToLowerInvariant();
            if (string.IsNullOrEmpty(host)) return false;
            if (_blockedHosts.Contains(host)) return false;

            if (IPAddress.TryParse(host, out var literalIp))
            {
                // normalize IPv6-mapped IPv4 so the block
                // list still catches `[::ffff:169.254.169.254]`.
                if (literalIp.IsIPv4MappedToIPv6)
                {
                    literalIp = literalIp.MapToIPv4();
                }
                return !IsBlockedIp(literalIp);
            }

            return null;  // need DNS
        }

        private static bool IsBlockedIp(IPAddress addr)
        {
            if (_blockedIPs.Contains(addr)) return true;
            // 169.254.0.0/16 — AWS metadata + Windows APIPA + ECS metadata + custom probes
            var bytes = addr.GetAddressBytes();
            if (bytes.Length == 4 && bytes[0] == 169 && bytes[1] == 254) return true;
            return false;
        }

        public static bool IsAllowedUrl(string? url)
        {
            var sync = TrySyncChecks(url, out var host);
            if (sync.HasValue) return sync.Value;

            try
            {
                var addresses = Dns.GetHostAddresses(host);
                foreach (var addr in addresses)
                {
                    if (IsBlockedIp(addr))
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

        public static async Task<bool> IsAllowedUrlAsync(string? url, CancellationToken ct = default)
        {
            var sync = TrySyncChecks(url, out var host);
            if (sync.HasValue) return sync.Value;

            try
            {
                var addresses = await Dns.GetHostAddressesAsync(host, ct).ConfigureAwait(false);
                foreach (var addr in addresses)
                {
                    if (IsBlockedIp(addr))
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
