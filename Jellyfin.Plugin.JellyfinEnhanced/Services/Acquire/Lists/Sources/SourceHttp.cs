using System;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Net.Sockets;
using System.Threading;
using System.Threading.Tasks;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists.Sources
{
    /// <summary>
    /// The transport of list-source reads (MDBList, TMDB, Trakt, IMDb, Chronolists; review round 1, 4C2-SEC-03/04): a
    /// named <see cref="IHttpClientFactory"/> client whose handler never follows a redirect (a 3xx is a typed failure of
    /// the fetcher), keeps no cookies, and resolves and checks the provider host itself at connect time: it connects only
    /// to the addresses it checked, and only when every one of them is a public unicast address (never loopback, private,
    /// link-local, unique-local, CGNAT, multicast, documentation or unspecified), so split or poisoned DNS can't point a
    /// pinned provider host at the server's own network. A configured HTTP proxy (the system's, as for every other
    /// Jellyfin request) keeps working: the connection to the proxy itself isn't address-checked (it's the administrator's
    /// own setting and may be on the LAN); the proxy then reaches the pinned host, still without redirects.
    /// </summary>
    public static class SourceHttp
    {
        /// <summary>Name of the client registered in <see cref="PluginServiceRegistrator"/>.</summary>
        public const string ClientName = "JellyfinEnhanced.ListSources";

        /// <summary>Builds the primary handler for <see cref="ClientName"/>.</summary>
        /// <returns>The handler.</returns>
        public static SocketsHttpHandler CreateHandler() => CreateHandler(null, null);

        /// <summary>Builds the handler with a test resolver and proxy.</summary>
        /// <param name="resolve">Host → addresses (null: DNS).</param>
        /// <param name="proxy">Proxy (null: the system proxy, like Jellyfin's own clients).</param>
        /// <returns>The handler.</returns>
        internal static SocketsHttpHandler CreateHandler(Func<string, CancellationToken, ValueTask<IPAddress[]>>? resolve, IWebProxy? proxy)
        {
            var handler = new SocketsHttpHandler
            {
                AllowAutoRedirect = false,
                UseCookies = false,
                AutomaticDecompression = DecompressionMethods.All,
                ConnectTimeout = TimeSpan.FromSeconds(10),
                PooledConnectionLifetime = TimeSpan.FromMinutes(2),
            };
            if (proxy != null)
            {
                handler.Proxy = proxy;
            }

            handler.ConnectCallback = (context, cancellationToken) => ConnectAsync(context, handler.UseProxy ? handler.Proxy ?? HttpClient.DefaultProxy : null, resolve, cancellationToken);
            return handler;
        }

        /// <summary>
        /// True for an address a list source may be reached at: global unicast only (IPv4 outside the special ranges;
        /// IPv6 in 2000::/3, with NAT64 and 6to4 judged by the IPv4 address they carry).
        /// </summary>
        /// <param name="address">Address.</param>
        /// <returns>True when public.</returns>
        public static bool IsPublic(IPAddress address)
        {
            ArgumentNullException.ThrowIfNull(address);
            if (address.IsIPv4MappedToIPv6)
            {
                address = address.MapToIPv4();
            }

            var b = address.GetAddressBytes();
            if (address.AddressFamily == AddressFamily.InterNetwork)
            {
                return !(b[0] == 0 // "this network"
                    || b[0] == 10
                    || b[0] == 127
                    || (b[0] == 100 && b[1] >= 64 && b[1] <= 127) // CGNAT
                    || (b[0] == 169 && b[1] == 254) // link-local (cloud metadata)
                    || (b[0] == 172 && b[1] >= 16 && b[1] <= 31)
                    || (b[0] == 192 && b[1] == 168)
                    || (b[0] == 192 && b[1] == 0 && (b[2] == 0 || b[2] == 2)) // IETF assignments, TEST-NET-1
                    || (b[0] == 198 && (b[1] == 18 || b[1] == 19)) // benchmarking
                    || (b[0] == 198 && b[1] == 51 && b[2] == 100) // TEST-NET-2
                    || (b[0] == 203 && b[1] == 0 && b[2] == 113) // TEST-NET-3
                    || b[0] >= 224); // multicast, reserved, broadcast
            }

            if (address.AddressFamily != AddressFamily.InterNetworkV6
                || address.IsIPv6LinkLocal || address.IsIPv6SiteLocal || address.IsIPv6Multicast || address.IsIPv6UniqueLocal)
            {
                return false;
            }

            if (b[0] == 0x00 && b[1] == 0x64 && b[2] == 0xff && b[3] == 0x9b && b.Skip(4).Take(8).All(x => x == 0))
            {
                return IsPublic(new IPAddress(b.AsSpan(12, 4))); // NAT64 64:ff9b::/96
            }

            if (b[0] == 0x20 && b[1] == 0x02)
            {
                return IsPublic(new IPAddress(b.AsSpan(2, 4))); // 6to4 2002::/16
            }

            if (b[0] == 0x20 && b[1] == 0x01 && b[2] == 0x0d && b[3] == 0xb8)
            {
                return false; // documentation 2001:db8::/32
            }

            return (b[0] & 0xE0) == 0x20; // global unicast 2000::/3 (::, ::1 and IPv4-compatible fall outside)
        }

        private static async ValueTask<Stream> ConnectAsync(SocketsHttpConnectionContext context, IWebProxy? proxy, Func<string, CancellationToken, ValueTask<IPAddress[]>>? resolve, CancellationToken cancellationToken)
        {
            var host = context.DnsEndPoint.Host;
            var port = context.DnsEndPoint.Port;
            var addresses = IPAddress.TryParse(host, out var literal)
                ? new[] { literal }
                : resolve != null ? await resolve(host, cancellationToken).ConfigureAwait(false) : await Dns.GetHostAddressesAsync(host, cancellationToken).ConfigureAwait(false);
            if (!ToProxy(context, proxy) && (addresses.Length == 0 || !addresses.All(IsPublic)))
            {
                throw new SourceAddressBlockedException(host);
            }

            var socket = new Socket(SocketType.Stream, ProtocolType.Tcp) { NoDelay = true };
            try
            {
                await socket.ConnectAsync(addresses, port, cancellationToken).ConfigureAwait(false);
                return new NetworkStream(socket, ownsSocket: true);
            }
            catch
            {
                socket.Dispose();
                throw;
            }
        }

        // True when this connection goes to the proxy configured for the request's target (not to the target itself).
        private static bool ToProxy(SocketsHttpConnectionContext context, IWebProxy? proxy)
        {
            var target = context.InitialRequestMessage.RequestUri;
            if (proxy == null || target == null || proxy.IsBypassed(target))
            {
                return false;
            }

            var via = proxy.GetProxy(target);
            return via != null && via != target
                && string.Equals(via.IdnHost, context.DnsEndPoint.Host, StringComparison.OrdinalIgnoreCase)
                && via.Port == context.DnsEndPoint.Port;
        }
    }

    /// <summary>Raised by the source transport's connect guard when a provider host resolves to a non-public address.</summary>
    public sealed class SourceAddressBlockedException : IOException
    {
        /// <summary>Creates the exception.</summary>
        /// <param name="host">The host.</param>
        public SourceAddressBlockedException(string host)
            : base($"{host} resolved to an address list sources may not use (loopback, private, link-local or another non-public range).")
        {
        }
    }
}
