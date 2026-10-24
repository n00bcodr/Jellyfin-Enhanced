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
                _ => (fingerprint, Create(connection, key, fingerprint)),
                (_, existing) => existing.Fingerprint == fingerprint ? existing : (fingerprint, Create(connection, key, fingerprint)));
            return ArrResult<ArrClient>.Success(entry.Client);
        }

        /// <summary>
        /// The client a caller checked something on, while it still is the instance's connection (D53, edition round 22: a
        /// checked command never moves to another server): the same kind, URL and key as when the check read through it, and
        /// the instance still usable (unless <paramref name="allowUnusable"/>). After a save that points the instance elsewhere
        /// (or changes its key) this refuses: nothing checked there is sent to the replacement, and nothing read from it can
        /// prove what the checked one did. The check and the client come from one registry read, so there is no window between
        /// comparing the generation and acquiring the client.
        /// </summary>
        /// <param name="checkedClient">The client the caller's facts were read through.</param>
        /// <param name="allowUnusable">Accept a disabled or retired instance (read-backs of what already went out).</param>
        /// <returns>That client, or a not-configured error (nothing was sent).</returns>
        internal ArrResult<ArrClient> Bound(ArrClient checkedClient, bool allowUnusable = false)
        {
            var now = For(checkedClient.Connection.Id, allowUnusable);
            if (!now.Ok) return now;
            return string.Equals(now.Value!.Generation, checkedClient.Generation, StringComparison.Ordinal) && checkedClient.Generation.Length > 0
                ? ArrResult<ArrClient>.Success(checkedClient)
                : ArrResult<ArrClient>.Failure(ArrErrorKind.NotConfigured, ConnectionChanged);
        }

        /// <summary>
        /// The instance's current client only while its connection is still <paramref name="generation"/> (a durable job's
        /// recorded connection, see <see cref="ConnectionGeneration"/>), from one registry read.
        /// </summary>
        internal ArrResult<ArrClient> Bound(string instanceId, string? generation, bool allowUnusable = false)
        {
            var now = For(instanceId, allowUnusable);
            if (!now.Ok) return now;
            return generation != null && string.Equals(now.Value!.Generation, generation, StringComparison.Ordinal)
                ? now
                : ArrResult<ArrClient>.Failure(ArrErrorKind.NotConfigured, ConnectionChanged);
        }

        /// <summary>
        /// An opaque tag of a client's connection (a hash of its generation), for binding a confirmation to the connection it
        /// was issued on; it says nothing about the URL or key.
        /// </summary>
        internal static string Tag(ArrClient client)
            => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes("je-connection|" + client.Generation)), 0, 8).ToLowerInvariant();

        /// <summary>The message of a connection that changed after a check (nothing was sent).</summary>
        internal const string ConnectionChanged = "The instance's connection changed since this was checked, so nothing was sent.";

        /// <summary>A client for values that are not saved yet (the config page's Test). Not cached.</summary>
        public ArrClient ForUnsaved(ArrKind kind, string url, string apiKey, string? name = null)
            => Create(new ArrConnection { Id = string.Empty, Kind = kind, Url = url ?? string.Empty, Name = name ?? kind.ToString() }, apiKey);

        /// <summary>Connection identity for durable jobs; display-name changes do not change it.</summary>
        public string? ConnectionGeneration(string instanceId)
        {
            var instance = _registry.Get(instanceId);
            return instance == null ? null : Fingerprint(instance, _registry.ResolveApiKey(instance));
        }

        private ArrClient Create(ArrConnection connection, string key, string generation = "")
            => new(connection, key, () => _httpClientFactory.CreateClient(ArrHttp.ClientName)) { Generation = generation };

        // URL, kind and a hash of the key: a changed key or URL gets a fresh client (and status cache).
        private static string Fingerprint(ArrConnection connection, string key)
        {
            var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(key)), 0, 8);
            return connection.Kind + "|" + connection.Url.Trim().TrimEnd('/') + "|" + hash;
        }
    }
}
