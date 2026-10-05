using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using MediaBrowser.Common.Configuration;
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
    ///
    /// Upstream calls go over HTTP/2 (one connection multiplexes a cast's worth
    /// of person lookups instead of a TLS handshake per parallel request) and
    /// at most <see cref="MaxUpstreamConcurrency"/> run at once, whoever asks,
    /// which keeps a burst well inside TMDB's ~50 requests/s.
    ///
    /// Details-page bundles: a movie or series page asks for the title itself,
    /// its release dates, watch providers and reviews within a few milliseconds
    /// of each other. When none of those is cached, the first request fetches
    /// them all in one upstream call (TMDB's append_to_response), the response
    /// is split into the same per-resource entries a direct lookup would have
    /// produced, and the sibling requests join that call instead of starting
    /// their own. See <see cref="GetAsync"/>'s bundle parameter.
    ///
    /// Entries are also written to disk (debounced) and reloaded at startup,
    /// so a server restart does not put every details page back on the cold
    /// path; expiry times travel with the entries.
    /// </summary>
    public sealed class TmdbResponseCache : IDisposable
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
        // TMDB's soft limit is about 50 requests/s; a lookup takes ~0.3 s once
        // the connection is warm, so 20 in flight is comfortably below it.
        private const int MaxUpstreamConcurrency = 20;

        // Disk persistence: written shortly after the first change and at most
        // every SaveMaxWait while changes keep coming (same pattern as the
        // awards cache), plus once on dispose.
        private const int DiskSchemaVersion = 1;
        private static readonly TimeSpan SaveDebounce = TimeSpan.FromSeconds(30);
        private static readonly TimeSpan SaveMaxWait = TimeSpan.FromMinutes(5);

        private static readonly HashSet<string> QueryRoots = new(StringComparer.OrdinalIgnoreCase)
        {
            "search", "discover", "trending"
        };

        private static readonly HashSet<string> QueryLists = new(StringComparer.OrdinalIgnoreCase)
        {
            "popular", "top_rated", "now_playing", "upcoming", "airing_today", "on_the_air", "latest", "changes"
        };

        // A title lookup or one of the sub-resources the details page fetches
        // alongside it. Group 3 is empty for the title itself.
        private static readonly Regex BundleMemberPattern = new(
            @"^(movie|tv)/([0-9]{1,9})(?:/(release_dates|watch/providers|reviews))?$",
            RegexOptions.Compiled | RegexOptions.CultureInvariant);
        private static readonly string[] MovieBundleMembers = { "release_dates", "watch/providers", "reviews" };
        private static readonly string[] TvBundleMembers = { "watch/providers", "reviews" };

        /// <summary>
        /// Upstream status and body. <see cref="ETag"/> is a strong validator
        /// (hash of the body), computed once per upstream fetch.
        /// </summary>
        public sealed record TmdbResponse(int StatusCode, string Content, string ETag)
        {
            public bool IsSuccess => StatusCode >= 200 && StatusCode <= 299;
        }

        private sealed record Entry(string Key, TmdbResponse Response, DateTimeOffset ExpiresAt, long Size);

        /// <summary>One resource of a details-page bundle: its own cache key and the waiters for it.</summary>
        private sealed record BundleMember(string Name, string Key, TaskCompletionSource<TmdbResponse> Owner);

        /// <summary>What <see cref="GetAsync"/> resolved from a path: "movie"/"tv", the id, and the sub-resource (null for the title).</summary>
        internal readonly record struct BundleTarget(string MediaType, string Id, string? Member)
        {
            public string TitlePath => MediaType + "/" + Id;

            public string CanonicalPath => Member == null ? TitlePath : TitlePath + "/" + Member;
        }

        private sealed class DiskEntry
        {
            public string K { get; set; } = string.Empty;
            public int S { get; set; }
            public string C { get; set; } = string.Empty;
            public long E { get; set; }
        }

        private sealed class DiskFormat
        {
            public int V { get; set; }
            public List<DiskEntry> Entries { get; set; } = new();
        }

        private readonly IHttpClientFactory _httpClientFactory;
        private readonly TimeProvider _timeProvider;
        private readonly Logger? _logger;
        private readonly string? _diskPath;
        private readonly object _lock = new();
        // Most recently used at the front; the dictionary points into the list.
        private readonly LinkedList<Entry> _lru = new();
        private readonly Dictionary<string, LinkedListNode<Entry>> _entries = new(StringComparer.Ordinal);
        private readonly Dictionary<string, Task<TmdbResponse>> _inFlight = new(StringComparer.Ordinal);
        private readonly SemaphoreSlim _upstreamSlots = new(MaxUpstreamConcurrency);
        private long _totalBytes;
        private string? _hashedApiKey;
        private string _apiKeyHash = string.Empty;

        private readonly object _saveLock = new();
        private volatile bool _dirty;
        private long _firstDirtyTicks;
        private Timer? _debounceSaveTimer;
        private volatile bool _disposed;

        public TmdbResponseCache(IHttpClientFactory httpClientFactory, IApplicationPaths applicationPaths, Logger logger)
            : this(httpClientFactory, TimeProvider.System)
        {
            _logger = logger;
            _diskPath = Path.Combine(applicationPaths.PluginsPath, "configurations", "Jellyfin.Plugin.JellyfinEnhanced", "tmdb-cache.json");
            LoadFromDisk();
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
        /// With <paramref name="bundle"/>, a cold title lookup or one of its
        /// details-page sub-resources fetches the whole set in one upstream call
        /// (see the class remarks); callers that only ever want one resource
        /// for many titles (the watch-providers batch) leave it off.
        /// </summary>
        public Task<TmdbResponse> GetAsync(string apiPath, string query, string apiKey, CancellationToken cancellationToken, bool bundle = false)
        {
            BundleTarget? target = bundle ? ResolveBundleTarget(apiPath, query) : null;
            if (target.HasValue)
            {
                // The canonical form (no query) is what the bundle stores, so a
                // request with the default parameters spelled out finds it.
                apiPath = target.Value.CanonicalPath;
                query = string.Empty;
            }

            var upstreamUrl = UpstreamUrl(apiPath, query);
            string key;
            Task<TmdbResponse> shared;
            TaskCompletionSource<TmdbResponse>? owner = null;
            List<BundleMember>? bundleMembers = null;
            lock (_lock)
            {
                var keyPrefix = GetKeyHash(apiKey) + "|";
                key = keyPrefix + upstreamUrl;
                if (TryGetFreshLocked(key, out var cached))
                {
                    return Task.FromResult(cached);
                }

                if (_inFlight.TryGetValue(key, out var pending))
                {
                    shared = pending;
                }
                else if (target.HasValue && !AnyBundleMemberCachedLocked(keyPrefix, target.Value))
                {
                    // Cold title: one upstream call for the title and every
                    // sub-resource; each gets its own in-flight entry so the
                    // sibling requests (arriving next) join instead of fetching.
                    bundleMembers = new List<BundleMember>();
                    foreach (var member in BundleMemberNames(target.Value.MediaType))
                    {
                        var memberKey = keyPrefix + UpstreamUrl(member == null ? target.Value.TitlePath : target.Value.TitlePath + "/" + member, string.Empty);
                        if (_inFlight.ContainsKey(memberKey))
                        {
                            // A standalone fetch of this one is already running.
                            continue;
                        }

                        var memberOwner = new TaskCompletionSource<TmdbResponse>(TaskCreationOptions.RunContinuationsAsynchronously);
                        _inFlight[memberKey] = memberOwner.Task;
                        bundleMembers.Add(new BundleMember(member ?? string.Empty, memberKey, memberOwner));
                    }

                    if (!_inFlight.TryGetValue(key, out var bundled))
                    {
                        // Unreachable while ResolveBundleTarget only accepts
                        // members of the type; never leave the registrations
                        // above orphaned if that ever changes.
                        foreach (var registered in bundleMembers)
                        {
                            _inFlight.Remove(registered.Key);
                            registered.Owner.TrySetCanceled();
                        }

                        bundleMembers = null;
                        owner = new TaskCompletionSource<TmdbResponse>(TaskCreationOptions.RunContinuationsAsynchronously);
                        bundled = owner.Task;
                        _inFlight[key] = bundled;
                    }

                    shared = bundled;
                }
                else
                {
                    owner = new TaskCompletionSource<TmdbResponse>(TaskCreationOptions.RunContinuationsAsynchronously);
                    shared = owner.Task;
                    _inFlight[key] = shared;
                }
            }

            if (bundleMembers != null)
            {
                var bundleUrl = UpstreamUrl(target!.Value.TitlePath, "?append_to_response=" + string.Join(",", BundleMemberNames(target.Value.MediaType).Where(m => m != null)));
                _ = FetchBundleAsync(target.Value, bundleMembers, AppendApiKey(bundleUrl, apiKey), apiKey);
            }
            else if (owner != null)
            {
                _ = FetchAsync(key, AppendApiKey(upstreamUrl, apiKey), GetTtl(apiPath), owner);
            }

            return shared.WaitAsync(cancellationToken);
        }

        private static string UpstreamUrl(string apiPath, string query) => $"https://api.themoviedb.org/3/{apiPath}{query}";

        private static string AppendApiKey(string upstreamUrl, string apiKey)
        {
            var separator = upstreamUrl.Contains('?', StringComparison.Ordinal) ? "&" : "?";
            return $"{upstreamUrl}{separator}api_key={Uri.EscapeDataString(apiKey)}";
        }

        /// <summary>The title (null) followed by the sub-resources bundled with it for this media type.</summary>
        private static IEnumerable<string?> BundleMemberNames(string mediaType)
        {
            yield return null;
            foreach (var member in mediaType == "movie" ? MovieBundleMembers : TvBundleMembers)
            {
                yield return member;
            }
        }

        /// <summary>
        /// Recognises a title lookup or one of its bundled sub-resources with
        /// default parameters (nothing, or for reviews the defaults TMDB applies
        /// anyway: language=en-US, page=1). Anything else is not bundled.
        /// </summary>
        internal static BundleTarget? ResolveBundleTarget(string apiPath, string query)
        {
            var match = BundleMemberPattern.Match(apiPath);
            if (!match.Success)
            {
                return null;
            }

            var member = match.Groups[3].Success ? match.Groups[3].Value : null;
            if (!string.IsNullOrEmpty(query))
            {
                if (member != "reviews")
                {
                    return null;
                }

                foreach (var pair in query.TrimStart('?').Split('&', StringSplitOptions.RemoveEmptyEntries))
                {
                    if (!string.Equals(pair, "language=en-US", StringComparison.Ordinal)
                        && !string.Equals(pair, "page=1", StringComparison.Ordinal))
                    {
                        return null;
                    }
                }
            }

            // Only a member bundled for this media type (TV has no release_dates
            // member): anything else must take the plain single-resource path,
            // or GetAsync would register the siblings without the requested key.
            var mediaType = match.Groups[1].Value;
            if (member != null && Array.IndexOf(mediaType == "movie" ? MovieBundleMembers : TvBundleMembers, member) < 0)
            {
                return null;
            }

            return new BundleTarget(mediaType, match.Groups[2].Value, member);
        }

        // Caller holds _lock.
        private bool AnyBundleMemberCachedLocked(string keyPrefix, BundleTarget target)
        {
            foreach (var member in BundleMemberNames(target.MediaType))
            {
                var memberKey = keyPrefix + UpstreamUrl(member == null ? target.TitlePath : target.TitlePath + "/" + member, string.Empty);
                if (TryGetFreshLocked(memberKey, out _))
                {
                    return true;
                }
            }

            return false;
        }

        // Caller holds _lock. Touches the entry (most recently used) on a hit.
        private bool TryGetFreshLocked(string key, out TmdbResponse response)
        {
            if (_entries.TryGetValue(key, out var node))
            {
                if (node.Value.ExpiresAt > _timeProvider.GetUtcNow())
                {
                    _lru.Remove(node);
                    _lru.AddFirst(node);
                    response = node.Value.Response;
                    return true;
                }

                RemoveNode(node);
            }

            response = null!;
            return false;
        }

        private async Task FetchAsync(string key, string requestUri, TimeSpan ttl, TaskCompletionSource<TmdbResponse> owner)
        {
            // Awaited through WhenAny, which never throws, so every outcome of the
            // upstream call (a response, any failure, the upstream timeout) reaches
            // the one completion below: the key leaves the in-flight map and every
            // waiter is released. Only a generic catch clause could promise that.
            var upstream = FetchUpstreamAsync(requestUri);
            await Task.WhenAny(upstream).ConfigureAwait(false);
            lock (_lock)
            {
                _inFlight.Remove(key);
                if (upstream.IsCompletedSuccessfully)
                {
                    var (result, isJson) = upstream.Result;
                    StoreOutcomeLocked(key, result, isJson, ttl);
                }
            }

            Complete(owner, upstream);
        }

        /// <summary>
        /// One append_to_response call for a title and its sub-resources. A
        /// successful body is split into per-resource entries (each shaped like
        /// its standalone endpoint's response) and every member's waiters are
        /// released; a 404 is stored for all of them; any other outcome reaches
        /// the waiters exactly as a standalone call's would.
        /// </summary>
        private async Task FetchBundleAsync(BundleTarget target, List<BundleMember> members, string requestUri, string apiKey)
        {
            var upstream = FetchUpstreamAsync(requestUri);
            await Task.WhenAny(upstream).ConfigureAwait(false);

            Dictionary<string, TmdbResponse>? split = null;
            if (upstream.IsCompletedSuccessfully && upstream.Result.IsJson && upstream.Result.Response.IsSuccess)
            {
                try
                {
                    split = SplitBundle(target, upstream.Result.Response.Content);
                }
                catch (Exception ex) when (ex is JsonException or FormatException or InvalidOperationException or OverflowException)
                {
                    // Not the shape we expected: fall through, every member is
                    // fetched on its own below. Anything escaping here would
                    // leave every registered member's waiters hanging.
                    split = null;
                }
            }

            // A 2xx we could not split is fetched per member instead; any other
            // outcome (404, 429, 5xx, non-JSON, failure, timeout) is handed to
            // every member's waiters exactly as a standalone call's would be.
            var unsplittable = split == null && upstream.IsCompletedSuccessfully && upstream.Result.IsJson && upstream.Result.Response.IsSuccess;
            var refetch = new HashSet<BundleMember>();
            lock (_lock)
            {
                foreach (var member in members)
                {
                    // Only our own registration is removed; a later standalone
                    // fetch that replaced it (after a refetch below) keeps its slot.
                    if (_inFlight.TryGetValue(member.Key, out var registered) && ReferenceEquals(registered, member.Owner.Task))
                    {
                        _inFlight.Remove(member.Key);
                    }

                    if (split != null && split.TryGetValue(member.Name, out var part))
                    {
                        StoreOutcomeLocked(member.Key, part, true, LookupTtl);
                    }
                    else if (split != null || unsplittable)
                    {
                        // TMDB did not append this one (or the body was not the
                        // expected shape): fetch it directly.
                        _inFlight[member.Key] = member.Owner.Task;
                        refetch.Add(member);
                    }
                    else if (upstream.IsCompletedSuccessfully)
                    {
                        // A JSON 404 (the title does not exist) is kept briefly
                        // for every member; other statuses stay uncached.
                        StoreOutcomeLocked(member.Key, upstream.Result.Response, upstream.Result.IsJson, LookupTtl);
                    }
                }
            }

            foreach (var member in members)
            {
                if (refetch.Contains(member))
                {
                    var memberPath = member.Name.Length == 0 ? target.TitlePath : target.TitlePath + "/" + member.Name;
                    _ = FetchAsync(member.Key, AppendApiKey(UpstreamUrl(memberPath, string.Empty), apiKey), LookupTtl, member.Owner);
                }
                else if (split != null && split.TryGetValue(member.Name, out var part))
                {
                    member.Owner.TrySetResult(part);
                }
                else
                {
                    Complete(member.Owner, upstream);
                }
            }
        }

        /// <summary>
        /// Splits an append_to_response body into the standalone shape of each
        /// resource: the title without the appended properties, and each
        /// sub-resource with the title's id in front (as its own endpoint returns
        /// it). Members TMDB left out are simply absent from the result.
        /// </summary>
        internal static Dictionary<string, TmdbResponse> SplitBundle(BundleTarget target, string bundleBody)
        {
            var parts = new Dictionary<string, TmdbResponse>(StringComparer.Ordinal);
            using var document = JsonDocument.Parse(bundleBody);
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object)
            {
                throw new JsonException("TMDB bundle body is not an object.");
            }

            var memberNames = new HashSet<string>(BundleMemberNames(target.MediaType).Where(m => m != null)!, StringComparer.Ordinal);
            var buffer = new MemoryStream();
            using (var writer = new Utf8JsonWriter(buffer))
            {
                writer.WriteStartObject();
                foreach (var property in root.EnumerateObject())
                {
                    if (!memberNames.Contains(property.Name))
                    {
                        property.WriteTo(writer);
                    }
                }

                writer.WriteEndObject();
            }

            parts[string.Empty] = ToResponse(buffer);

            var id = root.TryGetProperty("id", out var idElement) && idElement.ValueKind == JsonValueKind.Number
                ? idElement.GetInt64()
                : long.Parse(target.Id, CultureInfo.InvariantCulture);
            foreach (var member in memberNames)
            {
                if (!root.TryGetProperty(member, out var element) || element.ValueKind != JsonValueKind.Object)
                {
                    continue;
                }

                buffer.SetLength(0);
                using (var writer = new Utf8JsonWriter(buffer))
                {
                    writer.WriteStartObject();
                    writer.WriteNumber("id", id);
                    foreach (var property in element.EnumerateObject())
                    {
                        if (property.Name != "id")
                        {
                            property.WriteTo(writer);
                        }
                    }

                    writer.WriteEndObject();
                }

                parts[member] = ToResponse(buffer);
            }

            return parts;
        }

        private static TmdbResponse ToResponse(MemoryStream utf8)
        {
            var content = Encoding.UTF8.GetString(utf8.GetBuffer(), 0, (int)utf8.Length);
            return new TmdbResponse(200, content, ComputeETag(content));
        }

        private static void Complete(TaskCompletionSource<TmdbResponse> owner, Task<(TmdbResponse Response, bool IsJson)> upstream)
        {
            if (upstream.IsCompletedSuccessfully)
            {
                owner.TrySetResult(upstream.Result.Response);
            }
            else if (upstream.IsCanceled)
            {
                // The upstream timeout: waiters get a TaskCanceledException.
                owner.TrySetCanceled();
            }
            else
            {
                owner.TrySetException(upstream.Exception!.InnerExceptions);
                // Observed here so a failure nobody is still waiting for doesn't
                // surface later as an UnobservedTaskException.
                _ = owner.Task.Exception;
            }
        }

        // Caller holds _lock. 2xx JSON is kept for the TTL, a JSON 404 briefly.
        private void StoreOutcomeLocked(string key, TmdbResponse result, bool isJson, TimeSpan ttl)
        {
            if (isJson && result.IsSuccess)
            {
                Store(key, result, ttl);
            }
            else if (isJson && result.StatusCode == 404)
            {
                Store(key, result, NotFoundTtl);
            }
        }

        /// <summary>One upstream call: the response with its ETag, and whether the body is JSON.</summary>
        private async Task<(TmdbResponse Response, bool IsJson)> FetchUpstreamAsync(string requestUri)
        {
            using var timeout = new CancellationTokenSource(UpstreamTimeout);
            await _upstreamSlots.WaitAsync(timeout.Token).ConfigureAwait(false);
            try
            {
                var httpClient = _httpClientFactory.CreateClient();
                httpClient.MaxResponseContentBufferSize = MaxResponseBytes;
                using var request = new HttpRequestMessage(HttpMethod.Get, requestUri)
                {
                    // TMDB speaks HTTP/2; parallel lookups then share one
                    // connection instead of each opening (and handshaking) its own.
                    Version = HttpVersion.Version20,
                    VersionPolicy = HttpVersionPolicy.RequestVersionOrLower
                };
                using var response = await httpClient.SendAsync(request, timeout.Token).ConfigureAwait(false);
                var content = await response.Content.ReadAsStringAsync(timeout.Token).ConfigureAwait(false);
                var mediaType = response.Content.Headers.ContentType?.MediaType;
                var isJson = mediaType != null
                    && (mediaType.Equals("application/json", StringComparison.OrdinalIgnoreCase)
                        || mediaType.EndsWith("+json", StringComparison.OrdinalIgnoreCase));
                return (new TmdbResponse((int)response.StatusCode, content, ComputeETag(content)), isJson);
            }
            finally
            {
                _upstreamSlots.Release();
            }
        }

        // Caller holds _lock.
        private void Store(string key, TmdbResponse response, TimeSpan ttl)
        {
            StoreLocked(key, response, _timeProvider.GetUtcNow() + ttl);
            ScheduleDebouncedSave();
        }

        // Caller holds _lock.
        private void StoreLocked(string key, TmdbResponse response, DateTimeOffset expiresAt)
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

            var node = _lru.AddFirst(new Entry(key, response, expiresAt, size));
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

        /// <summary>Strong ETag for a response body (truncated SHA-256 of its UTF-8 bytes).</summary>
        internal static string ComputeETag(string content)
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

        // ---- disk persistence -------------------------------------------------

        private void LoadFromDisk()
        {
            if (_diskPath == null || !File.Exists(_diskPath))
            {
                return;
            }

            try
            {
                DiskFormat? data;
                using (var stream = File.OpenRead(_diskPath))
                {
                    data = JsonSerializer.Deserialize<DiskFormat>(stream);
                }

                if (data == null || data.V != DiskSchemaVersion || data.Entries == null)
                {
                    return;
                }

                var now = _timeProvider.GetUtcNow();
                var loaded = 0;
                lock (_lock)
                {
                    // Written most recently used first; adding at the back keeps
                    // that order and lets the size cap drop the oldest.
                    foreach (var entry in data.Entries)
                    {
                        // Cache files are disposable input: ignore corrupt records rather
                        // than preventing plugin startup or losing later valid entries.
                        if (entry == null || entry.C == null
                            || entry.E < DateTimeOffset.MinValue.ToUnixTimeMilliseconds()
                            || entry.E > DateTimeOffset.MaxValue.ToUnixTimeMilliseconds())
                        {
                            continue;
                        }

                        var expiresAt = DateTimeOffset.FromUnixTimeMilliseconds(entry.E);
                        if (expiresAt <= now || string.IsNullOrEmpty(entry.K) || _entries.ContainsKey(entry.K))
                        {
                            continue;
                        }

                        var response = new TmdbResponse(entry.S, entry.C, ComputeETag(entry.C));
                        var size = (entry.K.Length + entry.C.Length + response.ETag.Length) * 2L + EntryOverheadBytes;
                        if (_totalBytes + size > MaxCacheBytes)
                        {
                            break;
                        }

                        _entries[entry.K] = _lru.AddLast(new Entry(entry.K, response, expiresAt, size));
                        _totalBytes += size;
                        loaded++;
                    }
                }

                _logger?.Info($"[TMDB cache] Loaded {loaded} entries from disk");
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException)
            {
                _logger?.Warning($"[TMDB cache] Failed to load cache from disk: {ex.Message}");
            }
        }

        private void SaveToDisk()
        {
            if (_diskPath == null)
            {
                return;
            }

            lock (_saveLock)
            {
                _dirty = false;
                Interlocked.Exchange(ref _firstDirtyTicks, 0);

                try
                {
                    var now = _timeProvider.GetUtcNow();
                    var data = new DiskFormat { V = DiskSchemaVersion };
                    lock (_lock)
                    {
                        foreach (var entry in _lru)
                        {
                            if (entry.ExpiresAt > now)
                            {
                                data.Entries.Add(new DiskEntry { K = entry.Key, S = entry.Response.StatusCode, C = entry.Response.Content, E = entry.ExpiresAt.ToUnixTimeMilliseconds() });
                            }
                        }
                    }

                    var dir = Path.GetDirectoryName(_diskPath);
                    if (dir != null) Directory.CreateDirectory(dir);

                    var tempPath = _diskPath + ".tmp";
                    using (var stream = File.Create(tempPath))
                    {
                        JsonSerializer.Serialize(stream, data);
                    }
                    File.Move(tempPath, _diskPath, overwrite: true);
                }
                catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
                {
                    _dirty = true; // retry on the next debounce cycle / Dispose
                    _logger?.Warning($"[TMDB cache] Failed to save cache to disk: {ex.Message}");
                }
            }
        }

        private void ScheduleDebouncedSave()
        {
            if (_diskPath == null)
            {
                return;
            }

            _dirty = true;
            Interlocked.CompareExchange(ref _firstDirtyTicks, DateTime.UtcNow.Ticks, 0);
            if (_disposed)
            {
                return;
            }

            var due = ComputeDelay(Interlocked.Read(ref _firstDirtyTicks));
            var existing = _debounceSaveTimer;
            if (existing != null)
            {
                try
                {
                    existing.Change(due, Timeout.InfiniteTimeSpan);
                    return;
                }
                catch (ObjectDisposedException) { }
            }

            var timer = new Timer(_ =>
            {
                if (_dirty && !_disposed) SaveToDisk();
            }, null, due, Timeout.InfiniteTimeSpan);
            var old = Interlocked.Exchange(ref _debounceSaveTimer, timer);
            if (old != null && !ReferenceEquals(old, timer)) old.Dispose();
        }

        private static TimeSpan ComputeDelay(long firstDirtyTicks)
        {
            if (firstDirtyTicks == 0) return SaveDebounce;
            var elapsed = DateTime.UtcNow - new DateTime(firstDirtyTicks, DateTimeKind.Utc);
            var remainingCap = SaveMaxWait - elapsed;
            if (remainingCap < TimeSpan.Zero) return TimeSpan.Zero;
            return remainingCap < SaveDebounce ? remainingCap : SaveDebounce;
        }

        public void Dispose()
        {
            _disposed = true;
            var timer = Interlocked.Exchange(ref _debounceSaveTimer, null);
            timer?.Dispose();
            if (_dirty) SaveToDisk();
        }
    }
}
