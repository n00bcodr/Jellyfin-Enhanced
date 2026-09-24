using System;
using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Primitives;
using Microsoft.Net.Http.Headers;

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
    /// the exact upstream URL minus the API key (path + forwarded query, i.e.
    /// AFTER the parental-restriction rewrite) plus a hash of the API key --
    /// never on who asked. That is safe because every caller runs its own
    /// per-user gating (parental restriction) on every request BEFORE looking
    /// anything up here, so a cached body can only ever be handed to a user who
    /// was allowed to fetch that exact upstream URL anyway.
    ///
    /// Only JSON bodies are stored: 2xx for the path's TTL, 404 briefly (a missing
    /// id stays missing). Anything else (401, 429, 5xx, non-JSON) is returned to
    /// the callers already waiting on that upstream call and then forgotten.
    /// Concurrent identical misses share ONE upstream call.
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
        private static readonly TimeSpan NotFoundTtl = TimeSpan.FromMinutes(10);

        // Rough budget for cached bodies (UTF-16 chars * 2, plus a fixed per-entry
        // overhead for the node/record/strings). A watch/providers body is
        // ~5-20 KB, so this holds a few thousand entries; least recently used
        // entries go first when it fills.
        private const long MaxCacheBytes = 24L * 1024 * 1024;
        private const long EntryOverheadBytes = 200;
        // Upstream bodies larger than this fail the request (exception path).
        private const long MaxResponseBytes = 8L * 1024 * 1024;
        private static readonly TimeSpan UpstreamTimeout = TimeSpan.FromSeconds(30);

        private static readonly HashSet<string> QueryRoots = new(StringComparer.OrdinalIgnoreCase)
        {
            "search", "discover", "trending"
        };

        private static readonly HashSet<string> QueryLists = new(StringComparer.OrdinalIgnoreCase)
        {
            "popular", "top_rated", "now_playing", "upcoming", "airing_today", "on_the_air", "latest", "changes"
        };

        /// <summary>
        /// Upstream status and body. <see cref="ETag"/> is a strong validator
        /// (hash of the body), computed once per upstream fetch.
        /// </summary>
        public sealed record TmdbResponse(int StatusCode, string Content, string ETag)
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
        /// and must not contain the API key (it is appended here). apiPath may
        /// itself carry a '?' (Kestrel decodes %3F), so the key is the whole URL.
        /// <paramref name="cancellationToken"/> only stops this caller waiting.
        /// </summary>
        public Task<TmdbResponse> GetAsync(string apiPath, string query, string apiKey, CancellationToken cancellationToken)
        {
            var upstreamUrl = $"https://api.themoviedb.org/3/{apiPath}{query}";
            string key;
            Task<TmdbResponse> shared;
            TaskCompletionSource<TmdbResponse>? owner = null;
            lock (_lock)
            {
                key = GetKeyHash(apiKey) + "|" + upstreamUrl;
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
                var separator = upstreamUrl.Contains('?', StringComparison.Ordinal) ? "&" : "?";
                var requestUri = $"{upstreamUrl}{separator}api_key={Uri.EscapeDataString(apiKey)}";
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
                httpClient.MaxResponseContentBufferSize = MaxResponseBytes;
                using var response = await httpClient.GetAsync(requestUri, timeout.Token).ConfigureAwait(false);
                var content = await response.Content.ReadAsStringAsync(timeout.Token).ConfigureAwait(false);
                var statusCode = (int)response.StatusCode;
                var result = new TmdbResponse(statusCode, content, ComputeETag(content));
                var mediaType = response.Content.Headers.ContentType?.MediaType;
                var isJson = mediaType != null
                    && (mediaType.Equals("application/json", StringComparison.OrdinalIgnoreCase)
                        || mediaType.EndsWith("+json", StringComparison.OrdinalIgnoreCase));
                lock (_lock)
                {
                    _inFlight.Remove(key);
                    if (isJson && result.IsSuccess)
                    {
                        Store(key, result, ttl);
                    }
                    else if (isJson && statusCode == 404)
                    {
                        Store(key, result, NotFoundTtl);
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
            var size = (key.Length + response.Content.Length + response.ETag.Length) * 2L + EntryOverheadBytes;
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
            var q = apiPath.IndexOf('?', StringComparison.Ordinal);
            var segments = (q >= 0 ? apiPath[..q] : apiPath).Split('/', StringSplitOptions.RemoveEmptyEntries);
            return segments.Length == 0 || QueryRoots.Contains(segments[0]) || QueryLists.Contains(segments[^1]);
        }

        internal static TimeSpan GetTtl(string apiPath) => IsQueryPath(apiPath) ? QueryTtl : LookupTtl;

        /// <summary>
        /// True when an If-None-Match header matches <paramref name="etag"/>: "*",
        /// or any listed entity-tag under weak comparison (RFC 9110 13.1.2, GET).
        /// An unparseable header never matches, so the caller just sends the body.
        /// </summary>
        public static bool IfNoneMatchMatches(StringValues ifNoneMatch, string etag)
        {
            if (StringValues.IsNullOrEmpty(ifNoneMatch)
                || !EntityTagHeaderValue.TryParseStrictList(ifNoneMatch, out var tags))
            {
                return false;
            }

            var current = new EntityTagHeaderValue(etag);
            return tags.Any(t => t.Equals(EntityTagHeaderValue.Any) || t.Compare(current, useStrongComparison: false));
        }

        private static string ComputeETag(string content)
            => "\"" + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(content)), 0, 16) + "\"";

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
