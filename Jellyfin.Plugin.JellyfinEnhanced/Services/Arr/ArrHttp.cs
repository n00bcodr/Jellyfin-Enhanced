using System;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Net.Sockets;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Arr
{
    /// <summary>
    /// The one HTTP transport for arr calls: a named <see cref="IHttpClientFactory"/> client whose
    /// handler never follows redirects (the API key must not travel to another host), never uses a
    /// proxy, and resolves + checks the target address itself at connect time, connecting only to the
    /// address it checked, so a DNS answer can't change between the URL guard and the connection.
    /// </summary>
    public static class ArrHttp
    {
        /// <summary>Name of the client registered in <see cref="PluginServiceRegistrator"/>.</summary>
        public const string ClientName = "JellyfinEnhanced.Arr";

        /// <summary>Builds the primary handler for <see cref="ClientName"/>.</summary>
        public static SocketsHttpHandler CreateHandler() => new()
        {
            AllowAutoRedirect = false,
            UseProxy = false,
            UseCookies = false,
            AutomaticDecompression = DecompressionMethods.All,
            ConnectTimeout = TimeSpan.FromSeconds(10),
            PooledConnectionLifetime = TimeSpan.FromMinutes(2),
            ConnectCallback = GuardedConnectAsync,
        };

        /// <summary>
        /// Resolves the host, refuses blocked addresses (cloud metadata, link-local, ...), and
        /// connects to the checked addresses only.
        /// </summary>
        internal static async ValueTask<Stream> GuardedConnectAsync(SocketsHttpConnectionContext context, CancellationToken cancellationToken)
        {
            var host = context.DnsEndPoint.Host;
            var addresses = IPAddress.TryParse(host, out var literal)
                ? new[] { literal }
                : await Dns.GetHostAddressesAsync(host, cancellationToken).ConfigureAwait(false);
            if (!ArrUrlGuard.AreAddressesAllowed(host, addresses))
            {
                throw new ArrBlockedAddressException(host);
            }

            var socket = new Socket(SocketType.Stream, ProtocolType.Tcp) { NoDelay = true };
            try
            {
                await socket.ConnectAsync(addresses, context.DnsEndPoint.Port, cancellationToken).ConfigureAwait(false);
                return new NetworkStream(socket, ownsSocket: true);
            }
            catch
            {
                socket.Dispose();
                throw;
            }
        }
    }

    /// <summary>Raised by the connect guard when a host resolves to a blocked address.</summary>
    public sealed class ArrBlockedAddressException : Exception
    {
        /// <summary>Creates the exception.</summary>
        public ArrBlockedAddressException(string host)
            : base($"The address of {host} is not allowed (cloud metadata or link-local range).")
        {
        }
    }
}
