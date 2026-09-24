using System;
using System.Collections.Generic;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services
{
    /// <summary>
    /// In-memory cache for raw TMDB API responses (the /tmdb/{**apiPath}
    /// passthrough and the person lookup behind cast-card tags). Seerr cards and
    /// the detail page ask for the same watch/providers, reviews, person, etc.
    /// over and over; without this every one of them was a fresh call to
    /// api.themoviedb.org.
    ///
    /// Account isolation: entries hold only public TMDB data and are keyed on
    /// what is actually sent upstream (path + forwarded query, i.e. AFTER the
    /// parental-restriction rewrite) plus a hash of the API key -- never on who
    /// asked. That is safe because every caller runs its own per-user gating
    /// (parental restriction) on every request BEFORE looking anything up here,
    /// so a cached body can only ever be handed to a user who was allowed to
    /// fetch that exact upstream URL anyway.
    ///
    /// Only 2xx bodies are stored. Concurrent identical misses share ONE upstream
    /// call (non-2xx results are shared only with requests already waiting on it).
    /// That call runs on its own timeout, not on any caller's abort token, so one
    /// browser giving up doesn't fail the others; each caller stops waiting on
    /// its own token.
    /// </summary>
    public sealed class TmdbResponseCache
    {
        // Lists/queries (search, discover, trending, popular, ...) drift through the
        // day, so they stay short. Per-resource lookups (movie/tv/person details,
        // watch/providers, reviews, genres, keywords, companies) change rarely.
        private static readonly TimeSpan QueryTtl = TimeSpan.FromMinutes(30);
        private static readonly TimeSpan LookupTtl = TimeSpan.FromHours(6);

        // Rough budget for cached bodies (UTF-16 chars * 2). A watch/providers body
        // is ~5-20 KB, so this holds a few thousand entries; least recently used
        // entries go first when it fills.
        private const long MaxCacheBytes = 24L * 1024 * 1024;
        private static readonly TimeSpan UpstreamTimeout = TimeSpan.FromSeconds(30);

        private static readonly HashSet<string> QueryRoots = new(StringComparer.OrdinalIgnoreCase)
        {
            "search", "discover", "trending"
        };

        private static readonly HashSet<string> QueryLists = new(StringComparer.OrdinalIgnoreCase)
        {
            "popular", "top_rated", "now_playing", "upcoming", "airing_today", "on_the_air", "latest", "changes"
        };

        /// <summary>Upstream status and body. Only a 2xx result is ever cached.</summary>
        public sealed record TmdbResponse(int StatusCode, string Content)
        {
            public bool IsSuccess => StatusCode >= 200 && StatusCode <= 299;
        }

        private sealed record Entry(string Key, TmdbResponse Response, DateTimeOffset ExpiresAt, long Size);

        private readonly IHttpClientFactory _httpClientFactory;
        private readonly TimeProvider _timeProvider;
        private readonly object _lock = new();
        // Most recently used at the front; the dictionary points into the list.
        private readonly LinkedList<Entry> _lru = new();
        private readonly Dictionary<string, LinkedListNode<Entry>> _entries = new(StringComparer.Ordinal);
        private readonly Dictionary<string, Task<TmdbResponse>> _inFlight = new(StringComparer.Ordinal);
        private long _totalBytes;
        private string? _hashedApiKey;
        private string _apiKeyHash = string.Empty;

        public TmdbResponseCache(IHttpClientFactory httpClientFactory)
            : this(httpClientFactory, TimeProvider.System)
        {
        }

        internal TmdbResponseCache(IHttpClientFactory httpClientFactory, TimeProvider timeProvider)
        {
            _httpClientFactory = httpClientFactory;
            _timeProvider = timeProvider;
        }

        /// <summary>
        /// Returns the TMDB response for <c>https://api.themoviedb.org/3/{apiPath}{query}</c>,
        /// from cache when fresh. <paramref name="query"/> is "" or starts with '?'
        /// and must not contain the API key (it is appended here).
        /// <paramref name="cancellationToken"/> only stops this caller waiting.
        /// </summary>
        public Task<TmdbResponse> GetAsync(string apiPath, string query, string apiKey, CancellationToken cancellationToken)
        {
            string key;
            Task<TmdbResponse> shared;
            TaskCompletionSource<TmdbResponse>? owner = null;
            lock (_lock)
            {
                key = GetKeyHash(apiKey) + "|" + apiPath + query;
                if (_entries.TryGetValue(key, out var node))
                {
                    if (node.Value.ExpiresAt > _timeProvider.GetUtcNow())
                    {
                        _lru.Remove(node);
                        _lru.AddFirst(node);
                        return Task.FromResult(node.Value.Response);
                    }
                    RemoveNode(node);
                }

                if (_inFlight.TryGetValue(key, out var pending))
                {
                    shared = pending;
                }
                else
                {
                    owner = new TaskCompletionSource<TmdbResponse>(TaskCreationOptions.RunContinuationsAsynchronously);
                    shared = owner.Task;
                    _inFlight[key] = shared;
                }
            }

            if (owner != null)
            {
                var separator = query.Length > 0 ? "&" : "?";
                var requestUri = $"https://api.themoviedb.org/3/{apiPath}{query}{separator}api_key={apiKey}";
                _ = FetchAsync(key, requestUri, GetTtl(apiPath), owner);
            }

            return shared.WaitAsync(cancellationToken);
        }

        private async Task FetchAsync(string key, string requestUri, TimeSpan ttl, TaskCompletionSource<TmdbResponse> owner)
        {
            try
            {
                using var timeout = new CancellationTokenSource(UpstreamTimeout);
                var httpClient = _httpClientFactory.CreateClient();
                using var response = await httpClient.GetAsync(requestUri, timeout.Token).ConfigureAwait(false);
                var content = await response.Content.ReadAsStringAsync(timeout.Token).ConfigureAwait(false);
                var result = new TmdbResponse((int)response.StatusCode, content);
                lock (_lock)
                {
                    _inFlight.Remove(key);
                    if (result.IsSuccess)
                    {
                        Store(key, result, ttl);
                    }
                }
                owner.TrySetResult(result);
            }
            catch (Exception ex)
            {
                lock (_lock)
                {
                    _inFlight.Remove(key);
                }
                owner.TrySetException(ex);
                // Observed here so a failure nobody is still waiting for doesn't
                // surface later as an UnobservedTaskException.
                _ = owner.Task.Exception;
            }
        }

        // Caller holds _lock.
        private void Store(string key, TmdbResponse response, TimeSpan ttl)
        {
            var size = (key.Length + response.Content.Length) * 2L;
            if (size > MaxCacheBytes)
            {
                return;
            }

            if (_entries.TryGetValue(key, out var existing))
            {
                RemoveNode(existing);
            }

            var node = _lru.AddFirst(new Entry(key, response, _timeProvider.GetUtcNow() + ttl, size));
            _entries[key] = node;
            _totalBytes += size;

            while (_totalBytes > MaxCacheBytes && _lru.Last != null)
            {
                RemoveNode(_lru.Last);
            }
        }

        // Caller holds _lock.
        private void RemoveNode(LinkedListNode<Entry> node)
        {
            _lru.Remove(node);
            _entries.Remove(node.Value.Key);
            _totalBytes -= node.Value.Size;
        }

        /// <summary>True for list/query endpoints (search, discover, trending, popular, ...), false for single-resource lookups.</summary>
        internal static bool IsQueryPath(string apiPath)
        {
            var segments = apiPath.Split('/', StringSplitOptions.RemoveEmptyEntries);
            return segments.Length == 0 || QueryRoots.Contains(segments[0]) || QueryLists.Contains(segments[^1]);
        }

        internal static TimeSpan GetTtl(string apiPath) => IsQueryPath(apiPath) ? QueryTtl : LookupTtl;

        /// <summary>
        /// Browser cache lifetime for a successful response. The browser replays it
        /// without asking the server, so parental gating is skipped for that window
        /// (e.g. if an admin tightens a logged-in user's rating limit); it is capped
        /// at the 30 minutes JE's in-memory client cache already holds responses.
        /// </summary>
        public static int GetBrowserMaxAgeSeconds(string apiPath) => IsQueryPath(apiPath) ? 600 : 1800;

        // Short, non-reversible tag for the API key so a key change misses every
        // old entry. Caller holds _lock.
        private string GetKeyHash(string apiKey)
        {
            if (!string.Equals(_hashedApiKey, apiKey, StringComparison.Ordinal))
            {
                _apiKeyHash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(apiKey)), 0, 8);
                _hashedApiKey = apiKey;
            }
            return _apiKeyHash;
        }
    }
}
