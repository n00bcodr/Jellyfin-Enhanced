using System;
using System.Collections.Concurrent;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Arr
{
    /// <summary>
    /// Hands out one <see cref="ArrClient"/> per registered instance (so its concurrency limit and
    /// status cache are shared by every caller), rebuilt when the instance's URL or key changes.
    /// </summary>
    public sealed class ArrClientFactory
    {
        private readonly IHttpClientFactory _httpClientFactory;
        private readonly ArrInstanceRegistry _registry;
        private readonly ConcurrentDictionary<string, (string Fingerprint, ArrClient Client)> _clients = new(StringComparer.OrdinalIgnoreCase);

        /// <summary>Creates the factory.</summary>
        public ArrClientFactory(IHttpClientFactory httpClientFactory, ArrInstanceRegistry registry)
        {
            _httpClientFactory = httpClientFactory;
            _registry = registry;
        }

        /// <summary>The registry the factory reads.</summary>
        public ArrInstanceRegistry Registry => _registry;

        /// <summary>
        /// The client for a registered instance, or an error when it is unknown, disabled/retired
        /// (unless <paramref name="allowUnusable"/>) or has no stored key.
        /// </summary>
        public ArrResult<ArrClient> For(string instanceId, bool allowUnusable = false)
        {
            var connection = _registry.Get(instanceId);
            if (connection == null) return ArrResult<ArrClient>.Failure(ArrErrorKind.NotConfigured, "No instance with this id.");
            if (!connection.Usable && !allowUnusable) return ArrResult<ArrClient>.Failure(ArrErrorKind.NotConfigured, "This instance is disabled.");
            var key = _registry.ResolveApiKey(connection);
            if (string.IsNullOrEmpty(key)) return ArrResult<ArrClient>.Failure(ArrErrorKind.NotConfigured, "No API key is stored for this instance.");

            var fingerprint = Fingerprint(connection, key);
            var entry = _clients.AddOrUpdate(
                connection.Id,
                _ => (fingerprint, Create(connection, key)),
                (_, existing) => existing.Fingerprint == fingerprint ? existing : (fingerprint, Create(connection, key)));
            return ArrResult<ArrClient>.Success(entry.Client);
        }

        /// <summary>A client for values that are not saved yet (the config page's Test). Not cached.</summary>
        public ArrClient ForUnsaved(ArrKind kind, string url, string apiKey, string? name = null)
            => Create(new ArrConnection { Id = string.Empty, Kind = kind, Url = url ?? string.Empty, Name = name ?? kind.ToString() }, apiKey);

        private ArrClient Create(ArrConnection connection, string key)
            => new(connection, key, () => _httpClientFactory.CreateClient(ArrHttp.ClientName));

        // URL, kind and a hash of the key: a changed key or URL gets a fresh client (and status cache).
        private static string Fingerprint(ArrConnection connection, string key)
        {
            var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(key)), 0, 8);
            return connection.Kind + "|" + connection.Url.Trim().TrimEnd('/') + "|" + hash;
        }
    }
}
