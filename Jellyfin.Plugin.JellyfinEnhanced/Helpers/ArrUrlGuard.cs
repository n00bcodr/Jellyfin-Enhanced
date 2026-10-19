using System;
using System.Collections.Generic;
using System.Linq;
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

        // Host aliases written into /etc/hosts by the container runtime. Rootless Podman (pasta)
        // maps them to a link-local address (169.254.1.2 by default), so they skip the
        // 169.254.0.0/16 range block — the cloud metadata ranges are still rejected.
        private static readonly HashSet<string> _containerHostAliases = new(StringComparer.OrdinalIgnoreCase)
        {
            "host.containers.internal",
            "host.docker.internal"
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
                // Only the container host aliases may reach 169.254.0.0/16; a literal link-local
                // URL (e.g. http://169.254.1.2/) is blocked like any other metadata-style address.
                return !IsBlockedIp(literalIp, allowLinkLocal: false);
            }

            return null;  // need DNS
        }

        private static bool IsBlockedIp(IPAddress addr, bool allowLinkLocal)
        {
            // Normalise the IPv6 forms that carry an IPv4 address (literal or DNS-resolved) so the
            // IPv4 rules below still apply: IPv4-mapped `::ffff:a.b.c.d`, NAT64 well-known prefix
            // `64:ff9b::a.b.c.d` (RFC 6052) and the deprecated IPv4-compatible `::a.b.c.d`.
            addr = EmbeddedIPv4(addr) ?? addr;
            if (_blockedIPs.Contains(addr)) return true;
            // fe80::/10 is the IPv6 link-local range: same rule as 169.254.0.0/16 below.
            if (addr.AddressFamily == AddressFamily.InterNetworkV6 && addr.IsIPv6LinkLocal) return !allowLinkLocal;
            // 169.254.0.0/16 — AWS metadata + Windows APIPA + ECS metadata + custom probes
            var bytes = addr.GetAddressBytes();
            if (bytes.Length == 4 && bytes[0] == 169 && bytes[1] == 254)
            {
                // 169.254.169.0/24 + 169.254.170.0/24 (IMDS, VPC DNS, ECS / EKS credentials)
                // stay blocked even for container host aliases.
                if (bytes[2] == 169 || bytes[2] == 170) return true;
                return !allowLinkLocal;
            }
            return false;
        }

        private static IPAddress? EmbeddedIPv4(IPAddress addr)
        {
            if (addr.AddressFamily != AddressFamily.InterNetworkV6) return null;
            if (addr.IsIPv4MappedToIPv6) return addr.MapToIPv4();
            var b = addr.GetAddressBytes();
            var nat64 = b[0] == 0x00 && b[1] == 0x64 && b[2] == 0xff && b[3] == 0x9b && b.Skip(4).Take(8).All(x => x == 0);
            // ::a.b.c.d, but not :: and ::1 (unspecified / loopback).
            var compatible = b.Take(12).All(x => x == 0) && (b[12] | b[13] | b[14]) != 0;
            return nat64 || compatible ? new IPAddress(new[] { b[12], b[13], b[14], b[15] }) : null;
        }

        private static bool AreResolvedAddressesAllowed(string host, IPAddress[] addresses)
        {
            var allowLinkLocal = _containerHostAliases.Contains(host);
            foreach (var addr in addresses)
            {
                if (IsBlockedIp(addr, allowLinkLocal))
                    return false;
            }
            return true;
        }

        /// <summary>
        /// The checks that need no DNS: absolute http(s) URL, not a blocked metadata host, and a
        /// literal IP that is not blocked. A hostname passes here; its addresses are checked when the
        /// connection is made (see <see cref="AreAddressesAllowed"/>).
        /// </summary>
        public static bool PassesStaticChecks(string? url) => TrySyncChecks(url, out _) != false;

        /// <summary>
        /// True when every address <paramref name="host"/> resolved to may be contacted. Used at
        /// connect time so the address that is checked is the address that is used (no DNS rebinding).
        /// </summary>
        public static bool AreAddressesAllowed(string host, IPAddress[] addresses)
        {
            var normalized = (host ?? string.Empty).TrimEnd('.').ToLowerInvariant();
            if (_blockedHosts.Contains(normalized)) return false;
            return addresses.Length > 0 && AreResolvedAddressesAllowed(normalized, addresses);
        }

        public static bool IsAllowedUrl(string? url)
        {
            var sync = TrySyncChecks(url, out var host);
            if (sync.HasValue) return sync.Value;

            try
            {
                var addresses = Dns.GetHostAddresses(host);
                if (!AreResolvedAddressesAllowed(host, addresses))
                    return false;
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
                if (!AreResolvedAddressesAllowed(host, addresses))
                    return false;
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
