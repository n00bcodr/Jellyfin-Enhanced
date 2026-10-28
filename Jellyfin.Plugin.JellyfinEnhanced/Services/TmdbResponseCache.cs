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
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists;
using Jellyfin.Plugin.JellyfinEnhanced.Services.ServerCache;
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
    /// path; expiry times travel with the entries. With the server-side cache on,
    /// that disk copy is the cache's <c>tmdbjson</c> namespace instead (see the
    /// disk tier below), which holds far more than memory.
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
        // Upstream bodies larger than BoundedBody.MaxBytes (8 MiB) fail the request (exception path).
        /// <summary>How long one upstream call may take (its own timeout: no caller's token ever stops it).</summary>
        internal static readonly TimeSpan UpstreamTimeout = TimeSpan.FromSeconds(30);
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
            /// <summary>Underlying fetch time; unknown for legacy disk records. Cache hits never renew it.</summary>
            public DateTime FetchedAtUtc { get; init; }

            /// <summary>Local admission refusal, distinct from an upstream status/body.</summary>
            public bool AdmissionBusy { get; init; }
            public bool IsSuccess => StatusCode >= 200 && StatusCode <= 299;
        }

        private sealed record Entry(string Key, TmdbResponse Response, DateTimeOffset ExpiresAt, long Size)
        {
            /// <summary>The server-side cache copy: <see cref="SavedNone"/>, <see cref="SavedPending"/> (a write started) or <see cref="SavedOnDisk"/> (committed).</summary>
            public int Saved;

            /// <summary>The server-side cache's generation sampled before the answer was read (its fetch, or the snapshot load).</summary>
            public long DiskGeneration;
        }

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
            public long F { get; set; }
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

        public TmdbResponseCache(IHttpClientFactory httpClientFactory, IApplicationPaths applicationPaths, Logger logger, NativeDetails.ViewerMetadataAdmission? admission = null,
            ServerCache.ServerBlobCache? disk = null)
            : this(httpClientFactory, TimeProvider.System, admission, disk,
                Path.Combine(applicationPaths.PluginsPath, "configurations", "Jellyfin.Plugin.JellyfinEnhanced", "tmdb-cache.json"), logger)
        {
        }

        internal TmdbResponseCache(IHttpClientFactory httpClientFactory, TimeProvider timeProvider, NativeDetails.ViewerMetadataAdmission? admission = null,
            ServerCache.ServerBlobCache? disk = null)
            : this(httpClientFactory, timeProvider, admission, disk, null, null)
        {
        }

        /// <summary>Creates the cache with its legacy snapshot file (null: none) and server-side cache (tests).</summary>
        internal TmdbResponseCache(IHttpClientFactory httpClientFactory, TimeProvider timeProvider, NativeDetails.ViewerMetadataAdmission? admission,
            ServerCache.ServerBlobCache? disk, string? legacyPath, Logger? logger)
        {
            MetadataAdmission = admission ?? new NativeDetails.ViewerMetadataAdmission();
            _httpClientFactory = httpClientFactory;
            _timeProvider = timeProvider;
            _logger = logger;
            _disk = disk;
            _disk?.Register(new ServerCache.ServerCacheNamespace(DiskNamespace, DiskMaxBytes, LookupTtl, DiskMaxEntryBytes));
            _diskPath = legacyPath;
            LoadFromDisk();
        }

        internal NativeDetails.ViewerMetadataAdmission MetadataAdmission { get; }

        /// <summary>
        /// Enrich a cast chunk under one viewer place. Cache hits need no admission; overlapping
        /// chunks join the raw per-person flight. Eight workers bound raw work and the live
        /// admission still serializes actual sends through response-body disposal.
        /// A null answer is local pending, never an upstream failure or a cached refusal.
        /// </summary>
        internal Task<IReadOnlyDictionary<int, TmdbResponse>?> GetPeopleAsync(IEnumerable<int> people, string apiKey,
            Guid viewer, CancellationToken ct)
        {
            var ids = people.Where(id => id > 0).Distinct().OrderBy(id => id).ToArray();
            if (ids.Length > 100) throw new ArgumentOutOfRangeException(nameof(people));
            (bool Hit, IReadOnlyDictionary<int, TmdbResponse>? Value) Cached()
            {
                var answers = new Dictionary<int, TmdbResponse>();
                foreach (var id in ids)
                {
                    if (!TryGetCached("person/" + id.ToString(CultureInfo.InvariantCulture), string.Empty, apiKey, out var answer))
                        return (false, null);
                    answers.Add(id, answer);
                }
                return (true, answers);
            }

            var identity = "people:" + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(apiKey)))
                + ":" + string.Join(",", ids);
            if (_disk != null && !Cached().Hit && DiskReady()) return PeopleAfterDiskAsync(ids, apiKey, () => ReadPeople(ids, apiKey, viewer, identity, Cached, ct), ct);
            return ReadPeople(ids, apiKey, viewer, identity, Cached, ct);
        }

        /// <summary>The cast chunk's admitted read (<see cref="GetPeopleAsync"/>), after any saved people were loaded from disk.</summary>
        private Task<IReadOnlyDictionary<int, TmdbResponse>?> ReadPeople(int[] ids, string apiKey, Guid viewer, string identity,
            Func<(bool Hit, IReadOnlyDictionary<int, TmdbResponse>? Value)> cached, CancellationToken ct)
        {
            return MetadataAdmission.Read<IReadOnlyDictionary<int, TmdbResponse>?>(identity, viewer, cached,
                async () =>
                {
                    var answers = new System.Collections.Concurrent.ConcurrentDictionary<int, TmdbResponse>();
                    await Parallel.ForEachAsync(ids, new ParallelOptions { MaxDegreeOfParallelism = 8 }, async (id, _) =>
                    {
                        answers[id] = await GetAsync("person/" + id.ToString(CultureInfo.InvariantCulture), string.Empty,
                            apiKey, CancellationToken.None).ConfigureAwait(false);
                    }).ConfigureAwait(false);
                    return answers;
                }, null, ct);
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
        /// With <paramref name="refresh"/> (Phase 4c2, list sources), a cached copy is never returned: the
        /// response comes from upstream (joining a call already in flight) and is stored as usual, for callers
        /// that must see the current data (a linked TMDB list, which the 6 h lookup TTL would hide).
        /// </summary>
        public Task<TmdbResponse> GetAsync(string apiPath, string query, string apiKey, CancellationToken cancellationToken, bool bundle = false, bool refresh = false)
        {
            CheckDiskNow();
            // A caller only asking what is already known (CachedOnlyAsync) never starts a read.
            if (CachedOnly.Value is { } probe) return CachedOnlyGetAsync(probe, apiPath, query, apiKey, bundle, refresh, cancellationToken);
            // What is saved on disk is loaded before any admission or upstream place is asked for.
            if (!refresh && DiskCandidates(apiPath, query, apiKey, bundle) is { } keys && DiskReady())
                return GetAfterDiskAsync(keys, apiPath, query, apiKey, bundle, cancellationToken);
            return GetCore(apiPath, query, apiKey, cancellationToken, bundle, refresh);
        }

        /// <summary><see cref="GetAsync"/> once anything saved on disk is in memory: memory, a running read, then an admitted fetch.</summary>
        private Task<TmdbResponse> GetCore(string apiPath, string query, string apiKey, CancellationToken cancellationToken, bool bundle, bool refresh)
        {
            // Public cached facts and existing owned reads cost no new place, for every owner.
            var joinTarget = bundle ? ResolveBundleTarget(apiPath, query) : null;
            if (!refresh && Joined(apiKey, UpstreamUrl(joinTarget?.CanonicalPath ?? apiPath,
                joinTarget.HasValue ? string.Empty : query), out var joined))
                return joined.WaitAsync(cancellationToken);

            // Raw collection/season readers retain the effective viewer before their delegate runs.
            // Native/evidence reads already have an owner: their nested raw task remains under it.
            if (Services.MetadataAdmission.Current == null && NativeDetails.ViewerMetadataAdmission.EffectiveViewer is { } viewer)
            {
                string identity;
                lock (_lock) identity = "raw:" + GetKeyHash(apiKey) + "|" + UpstreamUrl(apiPath, query);
                return MetadataAdmission.Read(identity, viewer,
                    () =>
                    {
                        TmdbResponse value = null!;
                        var cachedTarget = bundle ? ResolveBundleTarget(apiPath, query) : null;
                        var hit = !refresh && TryGetCached(cachedTarget?.CanonicalPath ?? apiPath,
                            cachedTarget.HasValue ? string.Empty : query, apiKey, out value);
                        return (hit, value!);
                    },
                    () => GetCore(apiPath, query, apiKey, CancellationToken.None, bundle, refresh),
                    new TmdbResponse(503, "{}", string.Empty) { AdmissionBusy = true }, cancellationToken);
            }

            if (Services.MetadataAdmission.Current == null)
            {
                if (JellyfinEnhanced.Instance?.Configuration is { } config && NativeDetails.NativeDetailsPolicy.JeBackend(config))
                    return Task.FromResult(new TmdbResponse(503, "{}", string.Empty));
                return AutonomousMetadataAdmission.RunAsync(AutonomousMetadataOwner.Legacy,
                    () => GetCore(apiPath, query, apiKey, CancellationToken.None, bundle, refresh), cancellationToken).WaitAsync(cancellationToken);
            }

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
            long fence;
            lock (_lock)
            {
                var keyPrefix = GetKeyHash(apiKey) + "|";
                key = keyPrefix + upstreamUrl;
                fence = _fenceClock;
                if (!refresh && TryGetFreshLocked(key, out var cached))
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

            Services.MetadataAdmission.Required.Retain(shared);
            if (bundleMembers != null || owner != null) NativeDetails.MetadataTaskProbe.External(apiPath);
            // Captured before the upstream read starts: a disk Clear or Forget after it refuses saving its answer.
            var diskGeneration = bundleMembers != null || owner != null ? DiskGeneration() : 0;

            if (bundleMembers != null)
            {
                var bundleUrl = UpstreamUrl(target!.Value.TitlePath, "?append_to_response=" + string.Join(",", BundleMemberNames(target.Value.MediaType).Where(m => m != null)));
                _ = FetchBundleAsync(target.Value, bundleMembers, AppendApiKey(bundleUrl, apiKey), apiKey, diskGeneration, fence);
            }
            else if (owner != null)
            {
                _ = FetchAsync(key, AppendApiKey(upstreamUrl, apiKey), GetTtl(apiPath), owner, null, diskGeneration, fence);
            }

            return shared.WaitAsync(cancellationToken);
        }

        /// <summary>
        /// Phase 4c2 (list imports, review round 7, 4c2-R7-5): <see cref="GetAsync"/> for a caller that paces its upstream
        /// calls with a limiter. A fresh cached answer, or an upstream call for the same URL already in flight, is joined
        /// without an admission. Otherwise one admission is taken with <paramref name="admit"/> (cancelling while it waits
        /// takes none), and the upstream call it starts OWNS it: the lease is released only when that call has ended
        /// (answered, failed, or its own <see cref="UpstreamTimeout"/>), never when a caller stops waiting. A caller that finds
        /// the answer cached or in flight once admitted gives the lease back at once.
        /// </summary>
        /// <param name="apiPath">TMDB path.</param>
        /// <param name="query">"" or a query starting with '?', without the key.</param>
        /// <param name="apiKey">The key the request carries.</param>
        /// <param name="admit">Takes one admission (a lease, disposed by the upstream call when it ends).</param>
        /// <param name="cancellationToken">Stops this caller waiting (for its admission or the answer).</param>
        /// <returns>The response.</returns>
        public async Task<TmdbResponse> GetAdmittedAsync(string apiPath, string query, string apiKey, Func<CancellationToken, Task<IDisposable>> admit, CancellationToken cancellationToken)
        {
            var upstreamUrl = UpstreamUrl(apiPath, query);
            if (Joined(apiKey, upstreamUrl, out var joined)
                || (await HydrateAsync(apiPath, query, apiKey, cancellationToken).ConfigureAwait(false) && Joined(apiKey, upstreamUrl, out joined)))
            {
                return await joined.WaitAsync(cancellationToken).ConfigureAwait(false);
            }

            if (Services.MetadataAdmission.Current == null)
                return await AutonomousMetadataAdmission.RunAsync(AutonomousMetadataOwner.ListImport,
                    () => GetAdmittedAsync(apiPath, query, apiKey, admit, cancellationToken), cancellationToken).WaitAsync(cancellationToken).ConfigureAwait(false);

            var lease = await admit(cancellationToken).ConfigureAwait(false);
            Task<TmdbResponse> shared;
            TaskCompletionSource<TmdbResponse>? owner = null;
            string key;
            var diskGeneration = DiskGeneration();
            long fence;
            lock (_lock)
            {
                key = GetKeyHash(apiKey) + "|" + upstreamUrl;
                fence = _fenceClock;
                if (TryGetFreshLocked(key, out var cached))
                {
                    shared = Task.FromResult(cached);
                }
                else if (_inFlight.TryGetValue(key, out var pending))
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

            Services.MetadataAdmission.Required.Retain(shared);
            if (owner == null)
            {
                lease.Dispose(); // answered meanwhile: no request of ours
            }
            else
            {
                NativeDetails.MetadataTaskProbe.External(apiPath);
                _ = FetchAsync(key, AppendApiKey(upstreamUrl, apiKey), GetTtl(apiPath), owner, lease, diskGeneration, fence);
            }

            return await shared.WaitAsync(cancellationToken).ConfigureAwait(false);
        }

        /// <summary>
        /// Public list reconciliation has an explicit autonomous owner when it runs in the background.
        /// Interactive list reads retain their authenticated effective viewer and existing admission.
        /// Fresh public facts and pending reads remain free, including joins to a forced refresh.
        /// </summary>
        internal Task<TmdbResponse> GetListMetadataAsync(string apiPath, string query, string apiKey, CancellationToken ct, bool refresh)
        {
            if (Joined(apiKey, UpstreamUrl(apiPath, query), out var joined, skipCache: refresh))
                return joined.WaitAsync(ct);
            if (!refresh && DiskCandidates(apiPath, query, apiKey, false) != null && DiskReady())
                return ListMetadataAfterDiskAsync(apiPath, query, apiKey, ct);
            return ListMetadataCore(apiPath, query, apiKey, ct, refresh);
        }

        /// <summary><see cref="GetListMetadataAsync"/> after anything saved on disk was loaded (a refresh never reads it).</summary>
        private Task<TmdbResponse> ListMetadataCore(string apiPath, string query, string apiKey, CancellationToken ct, bool refresh)
        {
            if (Joined(apiKey, UpstreamUrl(apiPath, query), out var joined, skipCache: refresh))
                return joined.WaitAsync(ct);
            if (Services.MetadataAdmission.Current != null || NativeDetails.ViewerMetadataAdmission.EffectiveViewer != null)
                return GetAsync(apiPath, query, apiKey, ct, refresh: refresh);
            return AutonomousMetadataAdmission.RunAsync(AutonomousMetadataOwner.ListImport,
                () => GetAsync(apiPath, query, apiKey, CancellationToken.None, refresh: refresh), ct).WaitAsync(ct);
        }

        // A fresh cached answer or the upstream call in flight for this URL, if there is one.
        private bool Joined(string apiKey, string upstreamUrl, out Task<TmdbResponse> joined, bool skipCache = false)
        {
            lock (_lock)
            {
                var key = GetKeyHash(apiKey) + "|" + upstreamUrl;
                if (!skipCache && TryGetFreshLocked(key, out var cached))
                {
                    joined = Task.FromResult(cached);
                    return true;
                }

                if (_inFlight.TryGetValue(key, out var pending))
                {
                    joined = pending;
                    return true;
                }
            }

            joined = null!;
            return false;
        }

        /// <summary>
        /// Phase 4c2 (list imports): the fresh cached answer for <c>{apiPath}{query}</c>, without any upstream call (false
        /// when there is none), so a caller that paces its own upstream calls takes a turn only for a real one.
        /// </summary>
        /// <param name="apiPath">TMDB path.</param>
        /// <param name="query">"" or a query starting with '?', without the key.</param>
        /// <param name="apiKey">The key the answer was read with.</param>
        /// <param name="response">The cached answer.</param>
        /// <returns>True when a fresh answer is cached.</returns>
        public bool TryGetCached(string apiPath, string query, string apiKey, out TmdbResponse response)
        {
            lock (_lock)
            {
                return TryGetFreshLocked(GetKeyHash(apiKey) + "|" + UpstreamUrl(apiPath, query), out response);
            }
        }

        // Current public season resources already seen for this title are part of a series reconciliation too.
        // This is a read-only snapshot: it never renews freshness or publishes provider authority.
        internal IReadOnlyList<int> CachedTvSeasons(int tmdbId, string apiKey)
        {
            lock (_lock)
            {
                var prefix = GetKeyHash(apiKey) + "|https://api.themoviedb.org/3/tv/" + tmdbId.ToString(CultureInfo.InvariantCulture) + "/season/";
                return _entries.Values.Select(n => n.Value)
                    .Where(e => e.Response.IsSuccess && e.ExpiresAt > _timeProvider.GetUtcNow() && e.Key.StartsWith(prefix, StringComparison.Ordinal))
                    .Select(e => e.Key[prefix.Length..].Split('?')[0])
                    .Select(v => int.TryParse(v, NumberStyles.None, CultureInfo.InvariantCulture, out var n) ? n : -1)
                    .Where(n => n >= 0).Distinct().OrderBy(n => n).ToArray();
            }
        }

        /// <summary>
        /// Phase 4c2 (list imports): drops the cached answer for <c>{apiPath}{query}</c>, for a caller that found it
        /// unusable (malformed, or not a whole answer), so the next read asks TMDB again instead of keeping it for the TTL.
        /// </summary>
        /// <param name="apiPath">TMDB path.</param>
        /// <param name="query">"" or a query starting with '?', without the key.</param>
        /// <param name="apiKey">The key the answer was read with.</param>
        public void Forget(string apiPath, string query, string apiKey)
        {
            string keyHash;
            lock (_lock)
            {
                keyHash = GetKeyHash(apiKey);
                var key = keyHash + "|" + UpstreamUrl(apiPath, query);
                // A read of this key already under way (upstream or from disk) must not put the forgotten answer back.
                FenceLocked(key);
                if (_entries.TryGetValue(key, out var node))
                {
                    RemoveNode(node);
                    ScheduleDebouncedSave();
                }
            }

            ForgetOnDisk(keyHash, UpstreamUrl(apiPath, query));
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

        private async Task FetchAsync(string key, string requestUri, TimeSpan ttl, TaskCompletionSource<TmdbResponse> owner, IDisposable? lease = null,
            long diskGeneration = 0, long fence = long.MaxValue)
        {
            // Awaited through WhenAny, which never throws, so every outcome of the
            // upstream call (a response, any failure, the upstream timeout) reaches
            // the one completion below: the key leaves the in-flight map and every
            // waiter is released. Only a generic catch clause could promise that.
            var upstream = FetchUpstreamAsync(requestUri);
            await Task.WhenAny(upstream).ConfigureAwait(false);
            lease?.Dispose(); // the admission this call owned (GetAdmittedAsync) ends with it
            List<Entry>? save = null;
            lock (_lock)
            {
                _inFlight.Remove(key);
                if (upstream.IsCompletedSuccessfully && !FencedLocked(key, fence))
                {
                    var (result, isJson) = upstream.Result;
                    save = new List<Entry>();
                    if (StoreOutcomeLocked(key, result, isJson, ttl) is { } stored) save.Add(stored);
                    if (isJson && result.IsSuccess) SeedNativeAppendLocked(key, result, save, fence);
                    foreach (var entry in save) entry.DiskGeneration = diskGeneration;
                }

                PruneFencesLocked();
            }

            if (save != null) SaveEntries(save);
            Complete(owner, upstream);
        }

        /// <summary>
        /// One append_to_response call for a title and its sub-resources. A
        /// successful body is split into per-resource entries (each shaped like
        /// its standalone endpoint's response) and every member's waiters are
        /// released; a 404 is stored for all of them; any other outcome reaches
        /// the waiters exactly as a standalone call's would.
        /// </summary>
        private async Task FetchBundleAsync(BundleTarget target, List<BundleMember> members, string requestUri, string apiKey, long diskGeneration, long fence)
        {
            var upstream = FetchUpstreamAsync(requestUri);
            await Task.WhenAny(upstream).ConfigureAwait(false);

            Dictionary<string, TmdbResponse>? split = null;
            if (upstream.IsCompletedSuccessfully && upstream.Result.IsJson && upstream.Result.Response.IsSuccess)
            {
                try
                {
                    split = SplitBundle(target, upstream.Result.Response.Content);
                    foreach (var name in split.Keys.ToArray())
                    {
                        split[name] = split[name] with { FetchedAtUtc = upstream.Result.Response.FetchedAtUtc };
                    }
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
            var save = new List<Entry>();
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
                        if (!FencedLocked(member.Key, fence) && StoreOutcomeLocked(member.Key, part, true, LookupTtl) is { } stored) save.Add(stored);
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
                        if (!FencedLocked(member.Key, fence) && StoreOutcomeLocked(member.Key, upstream.Result.Response, upstream.Result.IsJson, LookupTtl) is { } stored)
                            save.Add(stored);
                    }
                }

                foreach (var entry in save) entry.DiskGeneration = diskGeneration;
                PruneFencesLocked();
            }

            SaveEntries(save);

            var fallbackAnswers = new Dictionary<BundleMember, TaskCompletionSource<TmdbResponse>>();
            foreach (var member in members)
            {
                if (refetch.Contains(member))
                {
                    var memberPath = member.Name.Length == 0 ? target.TitlePath : target.TitlePath + "/" + member.Name;
                    var fallback = new TaskCompletionSource<TmdbResponse>(TaskCreationOptions.RunContinuationsAsynchronously);
                    fallbackAnswers.Add(member, fallback);
                    await FetchAsync(member.Key, AppendApiKey(UpstreamUrl(memberPath, string.Empty), apiKey), LookupTtl, fallback, null, diskGeneration, fence);
                }
            }

            foreach (var member in members)
            {
                if (fallbackAnswers.TryGetValue(member, out var fallback))
                {
                    try { member.Owner.TrySetResult(await fallback.Task.ConfigureAwait(false)); }
                    catch (OperationCanceledException) { member.Owner.TrySetCanceled(); }
                    catch (Exception ex) { member.Owner.TrySetException(ex); _ = member.Owner.Task.Exception; }
                    continue;
                }
                if (split != null && split.TryGetValue(member.Name, out var part))
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

        // Caller holds _lock. 2xx JSON is kept for the TTL, a JSON 404 briefly. Returns the stored entry (null: none).
        private Entry? StoreOutcomeLocked(string key, TmdbResponse result, bool isJson, TimeSpan ttl)
        {
            if (isJson && result.IsSuccess)
            {
                return Store(key, result, ttl);
            }

            if (isJson && result.StatusCode == 404)
            {
                return Store(key, result, NotFoundTtl);
            }

            return null;
        }

        /// <summary>One upstream call: the response with its ETag, and whether the body is JSON.</summary>
        private async Task<(TmdbResponse Response, bool IsJson)> FetchUpstreamAsync(string requestUri)
        {
            using var timeout = new CancellationTokenSource(UpstreamTimeout);
            await _upstreamSlots.WaitAsync(timeout.Token).ConfigureAwait(false);
            try
            {
                using var response = await TmdbTransport.GetAsync(_httpClientFactory, requestUri,
                    Services.MetadataAdmission.Required, timeout.Token, http2: true).ConfigureAwait(false);
                var content = await BoundedBody.ReadAsync(response, timeout.Token).ConfigureAwait(false);
                var mediaType = response.Content.Headers.ContentType?.MediaType;
                var isJson = mediaType != null
                    && (mediaType.Equals("application/json", StringComparison.OrdinalIgnoreCase)
                        || mediaType.EndsWith("+json", StringComparison.OrdinalIgnoreCase));
                return (new TmdbResponse((int)response.StatusCode, content, ComputeETag(content)) { FetchedAtUtc = _timeProvider.GetUtcNow().UtcDateTime }, isJson);
            }
            finally
            {
                _upstreamSlots.Release();
            }
        }

        // Caller holds _lock.
        private Entry? Store(string key, TmdbResponse response, TimeSpan ttl)
        {
            var stored = StoreLocked(key, response, _timeProvider.GetUtcNow() + ttl);
            ScheduleDebouncedSave();
            return stored;
        }

        // Caller holds _lock.
        private Entry? StoreLocked(string key, TmdbResponse response, DateTimeOffset expiresAt)
        {
            var size = (key.Length + response.Content.Length + response.ETag.Length) * 2L + EntryOverheadBytes;
            if (size > MaxCacheBytes)
            {
                return null;
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

            return node.Value;
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
                // Sampled before the snapshot is read: a Clear of the server-side cache after it refuses saving these entries there.
                var diskGeneration = DiskGeneration();
                // A snapshot that is there is migrated (and retired) even when nothing in it can be used.
                _legacy = new List<Entry>();
                if (new FileInfo(_diskPath).Length > MaxSnapshotBytes)
                {
                    _logger?.Warning("[TMDB cache] The saved cache file is too large; it was not loaded");
                    return;
                }

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
                        if (expiresAt <= now || string.IsNullOrEmpty(entry.K) || _entries.ContainsKey(entry.K) || !StorableSnapshotEntry(entry))
                        {
                            continue;
                        }

                        var response = new TmdbResponse(entry.S, entry.C, ComputeETag(entry.C))
                        {
                            FetchedAtUtc = entry.F > 0 && entry.F <= now.UtcDateTime.Ticks ? new DateTime(entry.F, DateTimeKind.Utc) : DateTime.MinValue,
                        };
                        // Never valid longer than its own TTL, in memory as on disk: from its fetch when that is known (a
                        // record claiming more is skipped), else at most a TTL from now.
                        var ttl = SnapshotTtl(entry.K, entry.S);
                        if (response.FetchedAtUtc > DateTime.MinValue)
                        {
                            if (!WithinTtl(UrlOf(entry.K), response, expiresAt)) continue;
                        }
                        else if (expiresAt > now + ttl)
                        {
                            expiresAt = now + ttl;
                        }

                        var size = (entry.K.Length + entry.C.Length + response.ETag.Length) * 2L + EntryOverheadBytes;
                        if (_totalBytes + size > MaxCacheBytes)
                        {
                            break;
                        }

                        var loadedEntry = new Entry(entry.K, response, expiresAt, size) { DiskGeneration = diskGeneration };
                        _entries[entry.K] = _lru.AddLast(loadedEntry);
                        if (response.FetchedAtUtc > DateTime.MinValue && Durable(UrlOf(entry.K))) _legacy.Add(loadedEntry);
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

        /// <summary>
        /// A snapshot record the cache itself could have stored: a JSON 2xx or 404 whose body is valid JSON. Anything else
        /// (an edited or damaged file) is skipped, so it is never served nor given a checksum on the server-side cache.
        /// </summary>
        private static bool StorableSnapshotEntry(DiskEntry entry)
        {
            // The bound a TMDB read has: its UTF-8 body, not its characters.
            if (!(entry.S is >= 200 and <= 299 or 404) || !entry.K.Contains('|', StringComparison.Ordinal)
                || !UrlOf(entry.K).StartsWith(UpstreamPrefix, StringComparison.Ordinal) || Encoding.UTF8.GetByteCount(entry.C) > BoundedBody.MaxBytes) return false;
            try
            {
                using var _ = JsonDocument.Parse(entry.C);
                return true;
            }
            catch (JsonException)
            {
                return false;
            }
        }

        private static TimeSpan SnapshotTtl(string key, int status) => status == 404 ? NotFoundTtl : GetTtl(UrlOf(key)[UpstreamPrefix.Length..]);

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
                // The server-side cache is then the one disk copy (entries are written there as they are fetched).
                if (DiskReady()) return;

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
                                data.Entries.Add(new DiskEntry { K = entry.Key, S = entry.Response.StatusCode, C = entry.Response.Content, E = entry.ExpiresAt.ToUnixTimeMilliseconds(), F = entry.Response.FetchedAtUtc.Ticks });
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

                    // Decided again at the commit, in step with the move into the server-side cache: a save that began
                    // while the cache was off never puts the snapshot back once the cache is on (and the file retired).
                    lock (_legacyFileLock)
                    {
                        if (DiskReady())
                        {
                            File.Delete(tempPath);
                            return;
                        }

                        File.Move(tempPath, _diskPath, overwrite: true);
                    }
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

        // ---- server-side cache (disk tier) ------------------------------------
        // The disk tier of the raw TMDB cache: with the server-side cache on, every public JSON answer (2xx for its TTL,
        // a JSON 404 for its ten minutes) is also kept in the cache's <c>tmdbjson</c> namespace, so an answer that left the
        // 24 MiB memory, or a restart, is read back from disk instead of TMDB. A disk read comes before any admission or
        // upstream place is asked for, and never renews an answer: its fetch time and expiry travel with it. Free-text
        // searches (<c>search/*</c>) stay in memory only, and the parental evidence query is left to its own facts
        // namespace. Keys are hashes of the key hash and the exact URL (never the API key); a record names its key and
        // resource and is checked against both, its status, type, times and body ETag before it is used.

        /// <summary>The server-side cache namespace of raw TMDB answers.</summary>
        internal const string DiskNamespace = "tmdbjson";

        private const int DiskSchema = 2;
        private const long DiskMaxBytes = 256L * 1024 * 1024;
        private const int DiskMaxEntryBytes = BoundedBody.MaxBytes + 64 * 1024;
        private const int MaxHeaderBytes = 4096;
        private const int MaxFences = 4096;
        private const string UpstreamPrefix = "https://api.themoviedb.org/3/";

        private static readonly AsyncLocal<CachedOnlyProbe?> CachedOnly = new();
        private static readonly char[] NonCanonical = { '%', '\\', ';', '#', ' ' };
        private const long MaxSnapshotBytes = 64L * 1024 * 1024;

        // The parental evidence query (TitleParentalEvidenceProvider): its facts have their own namespace.
        private static readonly HashSet<string> EvidenceQueries = new(StringComparer.Ordinal)
        {
            "?language=en-US&append_to_response=release_dates", "?language=en-US&append_to_response=release_dates,keywords",
            "?language=en-US&append_to_response=content_ratings", "?language=en-US&append_to_response=content_ratings,keywords",
        };

        private static readonly Regex NativeAppendPattern = new(
            @"^https://api\.themoviedb\.org/3/(movie|tv)/([0-9]{1,9})\?append_to_response=([a-z_/,]+)$",
            RegexOptions.Compiled | RegexOptions.CultureInvariant);

        private readonly ServerBlobCache? _disk;
        // Keys forgotten while a read of theirs may be under way, with the fence clock at the time (bounded).
        private readonly Dictionary<string, long> _fences = new(StringComparer.Ordinal);
        private long _fenceClock;
        private long _fenceFloor;
        private int _activeReads;
        private int _diskHits;
        private int _diskOn;
        private int _promoting;
        private long _promoteAgainAt;
        private long _nextDiskCheck;
        private static readonly TimeSpan DiskCheckEvery = TimeSpan.FromSeconds(30);
        // The valid, migratable records of the legacy snapshot, until it is retired (or migration gives up).
        private List<Entry>? _legacy;
        private int _migrationAttempts;
        private const int MaxMigrationAttempts = 10;
        private const int SavedNone = 0;
        private const int SavedPending = 1;
        private const int SavedOnDisk = 2;
        private readonly object _legacyFileLock = new();

        /// <summary>Answers read back from disk into memory (tests, diagnostics).</summary>
        internal int DiskHits => Volatile.Read(ref _diskHits);

        /// <summary>
        /// Runs <paramref name="read"/> answering only from what is already known (memory or disk): a read that would
        /// need TMDB gets a local "busy" answer instead and the probe reports a miss. Hit is true only when every read
        /// was answered that way, so an owner can skip its admission for answers that cost no upstream place.
        /// </summary>
        /// <typeparam name="T">The owner's answer.</typeparam>
        /// <param name="read">The owner's read, calling <see cref="GetAsync"/>.</param>
        /// <returns>Whether everything was known, and the answer.</returns>
        internal static async Task<(bool Hit, T Value)> CachedOnlyAsync<T>(Func<Task<T>> read)
        {
            var probe = new CachedOnlyProbe();
            CachedOnly.Value = probe;
            try
            {
                var value = await read().ConfigureAwait(false);
                return (!probe.Missed, value);
            }
            catch (Exception ex) when (ex is not OutOfMemoryException)
            {
                return (false, default!);
            }
        }

        /// <summary>Whether a read under <see cref="CachedOnlyAsync{T}"/> needed TMDB.</summary>
        private sealed class CachedOnlyProbe
        {
            public bool Missed;
        }

        /// <summary>
        /// Loads the answer for <c>{apiPath}{query}</c> from disk into memory when it is there and still valid; true
        /// when memory holds a fresh answer afterwards. Never asks TMDB; false when the cache is off.
        /// </summary>
        internal Task<bool> HydrateAsync(string apiPath, string query, string apiKey, CancellationToken ct)
        {
            var url = UpstreamUrl(apiPath, query);
            if (_disk == null || !Durable(url) || !DiskReady()) return Task.FromResult(false);
            string hash;
            lock (_lock) hash = GetKeyHash(apiKey);
            return HydrateKeyAsync(hash, url, ct);
        }

        private async Task<TmdbResponse> CachedOnlyGetAsync(CachedOnlyProbe probe, string apiPath, string query, string apiKey, bool bundle, bool refresh, CancellationToken ct)
        {
            if (!refresh)
            {
                var target = bundle ? ResolveBundleTarget(apiPath, query) : null;
                var path = target?.CanonicalPath ?? apiPath;
                var q = target.HasValue ? string.Empty : query;
                if (TryGetCached(path, q, apiKey, out var hit)
                    || (await HydrateAsync(path, q, apiKey, ct).ConfigureAwait(false) && TryGetCached(path, q, apiKey, out hit)))
                {
                    return hit;
                }
            }

            probe.Missed = true;
            return new TmdbResponse(503, "{}", string.Empty) { AdmissionBusy = true };
        }

        private async Task<TmdbResponse> GetAfterDiskAsync(List<(string Hash, string Url)> keys, string apiPath, string query, string apiKey, bool bundle, CancellationToken ct)
        {
            // A bundle's members are read together, so a cold title whose siblings are saved fetches only what is missing.
            await Task.WhenAll(keys.Select(k => HydrateKeyAsync(k.Hash, k.Url, ct))).ConfigureAwait(false);
            return await GetCore(apiPath, query, apiKey, ct, bundle, refresh: false).ConfigureAwait(false);
        }

        private async Task<TmdbResponse> ListMetadataAfterDiskAsync(string apiPath, string query, string apiKey, CancellationToken ct)
        {
            await HydrateAsync(apiPath, query, apiKey, ct).ConfigureAwait(false);
            return await ListMetadataCore(apiPath, query, apiKey, ct, refresh: false).ConfigureAwait(false);
        }

        private async Task<IReadOnlyDictionary<int, TmdbResponse>?> PeopleAfterDiskAsync(int[] ids, string apiKey,
            Func<Task<IReadOnlyDictionary<int, TmdbResponse>?>> then, CancellationToken ct)
        {
            await Parallel.ForEachAsync(ids, new ParallelOptions { MaxDegreeOfParallelism = 16, CancellationToken = ct },
                async (id, token) => await HydrateAsync("person/" + id.ToString(CultureInfo.InvariantCulture), string.Empty, apiKey, token).ConfigureAwait(false))
                .ConfigureAwait(false);
            return await then().ConfigureAwait(false);
        }

        /// <summary>The disk entries worth reading before a request (null: memory has it, a read runs, or it is never on disk).</summary>
        private List<(string Hash, string Url)>? DiskCandidates(string apiPath, string query, string apiKey, bool bundle)
        {
            if (_disk == null) return null;
            var target = bundle ? ResolveBundleTarget(apiPath, query) : null;
            var url = UpstreamUrl(target?.CanonicalPath ?? apiPath, target.HasValue ? string.Empty : query);
            if (!Durable(url)) return null;
            var now = _timeProvider.GetUtcNow();
            lock (_lock)
            {
                var hash = GetKeyHash(apiKey);
                bool Known(string u) => (_entries.TryGetValue(hash + "|" + u, out var node) && node.Value.ExpiresAt > now) || _inFlight.ContainsKey(hash + "|" + u);
                if (Known(url)) return null;
                var keys = new List<(string Hash, string Url)> { (hash, url) };
                if (target is { } t)
                {
                    foreach (var member in BundleMemberNames(t.MediaType))
                    {
                        var memberUrl = UpstreamUrl(member == null ? t.TitlePath : t.TitlePath + "/" + member, string.Empty);
                        if (memberUrl != url && !Known(memberUrl)) keys.Add((hash, memberUrl));
                    }
                }

                return keys;
            }
        }

        /// <summary>One entry from disk into memory, unless it was forgotten meanwhile; true when memory holds it fresh.</summary>
        private async Task<bool> HydrateKeyAsync(string keyHash, string upstreamUrl, CancellationToken ct)
        {
            var key = keyHash + "|" + upstreamUrl;
            long fence;
            lock (_lock)
            {
                if (TryGetFreshLocked(key, out _)) return true;
                if (_inFlight.ContainsKey(key)) return false;
                fence = _fenceClock;
                _activeReads++;
            }

            var loaded = false;
            try
            {
                var entry = await _disk!.TryGetAsync(DiskNamespace, DiskKey(keyHash, upstreamUrl), ct).ConfigureAwait(false);
                if (entry != null && Decode(entry, keyHash, upstreamUrl) is { } record)
                {
                    lock (_lock)
                    {
                        if (!FencedLocked(key, fence))
                        {
                            if (TryGetFreshLocked(key, out _))
                            {
                                loaded = true;
                            }
                            else if (StoreLocked(key, record.Response, record.ExpiresAt) is { } stored)
                            {
                                // Already on disk; no renewed lifetime (the record's own expiry).
                                stored.Saved = SavedOnDisk;
                                loaded = true;
                                _diskHits++;
                            }
                        }
                    }
                }
            }
            finally
            {
                lock (_lock)
                {
                    _activeReads--;
                    PruneFencesLocked();
                }
            }

            return loaded;
        }

        /// <summary>
        /// True while the server-side cache is on and usable; the first time it is, saves what memory already holds (and
        /// again a minute after a save that couldn't finish).
        /// </summary>
        private bool DiskReady()
        {
            if (_disk == null) return false;
            var on = _disk.Enabled;
            if (!on) Volatile.Write(ref _diskOn, 0);
            else if (Interlocked.Exchange(ref _diskOn, 1) == 0 || PromotionDue()) _ = Task.Run(PromoteAsync);
            return on;
        }

        /// <summary>
        /// Looks at the server-side cache on the first request and then at most every <see cref="DiskCheckEvery"/> (memory
        /// hits too), so switching it on, the snapshot loaded at startup, or a save due again are all noticed while every
        /// answer still comes from memory.
        /// </summary>
        private void CheckDiskNow()
        {
            if (_disk == null) return;
            var now = _timeProvider.GetUtcNow().UtcTicks;
            var next = Interlocked.Read(ref _nextDiskCheck);
            if (now < next || Interlocked.CompareExchange(ref _nextDiskCheck, now + DiskCheckEvery.Ticks, next) != next) return;
            DiskReady();
        }

        private bool PromotionDue()
        {
            var at = Interlocked.Read(ref _promoteAgainAt);
            return at != 0 && _timeProvider.GetUtcNow().UtcTicks >= at && Interlocked.CompareExchange(ref _promoteAgainAt, 0, at) == at;
        }

        private long DiskGeneration() => _disk?.Generation ?? 0;

        /// <summary>
        /// Saves the fresh entries memory holds that aren't on disk yet (those fetched while the cache was off, and the
        /// legacy snapshot's entries loaded at startup, with their original fetch time and expiry), each under the
        /// generation sampled before it was read, so a Clear or a folder change since refuses it. Entries of unknown fetch
        /// time, free-text searches and records claiming longer than their TTL are left out. A write refused while its
        /// generation still holds (the disk busy or full, a failed write) stays to be saved and is tried again a minute
        /// later. The legacy snapshot is migrated all or nothing: it is renamed (<c>.migrated</c>, kept for a rollback by
        /// hand, never loaded again) only when every valid record it held is committed on disk (its own write, or a
        /// newer answer for the same request) or was dropped by a Clear; a write still under way doesn't count. After
        /// <see cref="MaxMigrationAttempts"/> incomplete attempts the snapshot is left alone for this run (logged once).
        /// </summary>
        internal async Task PromoteAsync()
        {
            if (Interlocked.Exchange(ref _promoting, 1) == 1) return;
            try
            {
                var now = _timeProvider.GetUtcNow();
                List<Entry> pending;
                lock (_lock)
                {
                    pending = _lru.Where(e => Volatile.Read(ref e.Saved) == SavedNone && e.ExpiresAt > now && e.Response.FetchedAtUtc > DateTime.MinValue
                        && Durable(UrlOf(e.Key)) && WithinTtl(UrlOf(e.Key), e.Response, e.ExpiresAt)).ToList();
                }

                var failed = 0;
                foreach (var entry in pending)
                {
                    if (await SaveOnceAsync(entry).ConfigureAwait(false) == false) failed++;
                }

                var legacyDone = await MigrateLegacyAsync(now).ConfigureAwait(false);
                if (failed == 0 && legacyDone)
                {
                    Interlocked.Exchange(ref _promoteAgainAt, 0);
                }
                else
                {
                    Interlocked.Exchange(ref _promoteAgainAt, (_timeProvider.GetUtcNow() + TimeSpan.FromMinutes(1)).UtcTicks);
                }
            }
            catch (Exception ex) when (ex is not OutOfMemoryException)
            {
                _logger?.Warning($"[TMDB cache] Saving to the server-side cache failed: {ex.GetType().Name}");
            }
            finally
            {
                Volatile.Write(ref _promoting, 0);
            }
        }

        /// <summary>
        /// Saves an entry unless a write of it was started already: true when it is on disk (now or before), false when a
        /// write of it failed or is still under way (to be tried again), null when a Clear or folder change dropped it.
        /// </summary>
        private async Task<bool?> SaveOnceAsync(Entry entry)
        {
            if (Interlocked.CompareExchange(ref entry.Saved, SavedPending, SavedNone) != SavedNone)
            {
                if (Volatile.Read(ref entry.Saved) == SavedOnDisk) return true;
                return _disk!.IsCurrent(entry.DiskGeneration) ? false : null;
            }

            if (await WriteAsync(entry).ConfigureAwait(false)) return true;
            if (!_disk!.IsCurrent(entry.DiskGeneration)) return null;
            Volatile.Write(ref entry.Saved, SavedNone);
            return false;
        }

        /// <summary>The legacy snapshot's migration (see <see cref="PromoteAsync"/>); true when nothing of it is left to do.</summary>
        private async Task<bool> MigrateLegacyAsync(DateTimeOffset now)
        {
            var legacy = _legacy;
            if (legacy == null || _disk?.Enabled != true) return true;
            var complete = true;
            foreach (var record in legacy)
            {
                if (record.ExpiresAt <= now) continue;
                Entry? current;
                lock (_lock) current = _entries.TryGetValue(record.Key, out var node) && node.Value.ExpiresAt > now ? node.Value : null;
                if (current != null)
                {
                    // The answer memory holds for the request (the record itself, or a newer one) was given its save above:
                    // only a committed one counts (a write under way or refused leaves the snapshot in place).
                    if (Volatile.Read(ref current.Saved) != SavedOnDisk && _disk!.IsCurrent(current.DiskGeneration)) complete = false;
                }
                else if (await SaveOnceAsync(record).ConfigureAwait(false) == false)
                {
                    // Memory let the record go: it is saved from the snapshot itself.
                    complete = false;
                }
            }

            if (complete)
            {
                RetireLegacyFile();
                _legacy = null;
                return true;
            }

            if (++_migrationAttempts >= MaxMigrationAttempts)
            {
                _logger?.Warning($"[TMDB cache] Could not move the saved cache to the server-side cache after {MaxMigrationAttempts} attempts; the old file is kept and loaded again at the next start");
                _legacy = null;
                return true;
            }

            return false;
        }

        private void RetireLegacyFile()
        {
            if (_diskPath == null) return;
            try
            {
                // In step with a snapshot save's commit (which checks the cache again under the same lock).
                lock (_legacyFileLock)
                {
                    if (!File.Exists(_diskPath)) return;
                    File.Move(_diskPath, _diskPath + ".migrated", overwrite: true);
                }

                _logger?.Info("[TMDB cache] Moved to the server-side cache; the old snapshot was renamed tmdb-cache.json.migrated");
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                _logger?.Warning($"[TMDB cache] Could not rename the old snapshot: {ex.Message}");
            }
        }

        /// <summary>Starts the disk writes of entries just stored (each under the generation sampled before its fetch).</summary>
        private void SaveEntries(List<Entry> entries)
        {
            if (entries.Count == 0 || !DiskReady()) return;
            foreach (var entry in entries)
            {
                if (entry.Response.FetchedAtUtc > DateTime.MinValue && Durable(UrlOf(entry.Key))) _ = SaveOnceAsync(entry);
            }
        }

        /// <summary>Never valid for longer than its own TTL from its fetch (the disk reader refuses such a record).</summary>
        private static bool WithinTtl(string upstreamUrl, TmdbResponse response, DateTimeOffset expiresAt)
        {
            var ttl = response.StatusCode == 404 ? NotFoundTtl : GetTtl(upstreamUrl[UpstreamPrefix.Length..]);
            return expiresAt <= new DateTimeOffset(response.FetchedAtUtc) + ttl + TimeSpan.FromMinutes(1);
        }

        private async Task<bool> WriteAsync(Entry entry)
        {
            try
            {
                var bar = entry.Key.IndexOf('|', StringComparison.Ordinal);
                var keyHash = entry.Key[..bar];
                var url = entry.Key[(bar + 1)..];
                var bytes = Encode(entry, DiskDigest(keyHash, url), url);
                var stored = await _disk!.PutAsync(DiskNamespace, DiskKey(keyHash, url), bytes, ServerBlobCache.JsonContentType, CancellationToken.None,
                    entry.DiskGeneration, entry.ExpiresAt.UtcDateTime, entry.Response.FetchedAtUtc).ConfigureAwait(false);
                if (stored) Volatile.Write(ref entry.Saved, SavedOnDisk);
                return stored;
            }
            catch (Exception ex) when (ex is not OutOfMemoryException)
            {
                return false;
            }
        }

        /// <summary>Removes the disk copy of a forgotten answer (a disk read under way is fenced by the caller).</summary>
        private void ForgetOnDisk(string keyHash, string upstreamUrl)
        {
            if (_disk == null || !Durable(upstreamUrl)) return;
            _ = _disk.ForgetEntryAsync(DiskNamespace, DiskKey(keyHash, upstreamUrl), CancellationToken.None);
            // A disk read that began before the file was removed (after the first fence) can't put it back now.
            lock (_lock)
            {
                var key = keyHash + "|" + upstreamUrl;
                FenceLocked(key);
                if (_entries.TryGetValue(key, out var node)) RemoveNode(node);
            }
        }

        // Caller holds _lock.
        private void FenceLocked(string key)
        {
            if (_fences.Count >= MaxFences)
            {
                // Bounded: everything that started before now counts as fenced.
                _fences.Clear();
                _fenceFloor = _fenceClock + 1;
            }

            _fences[key] = ++_fenceClock;
        }

        // Caller holds _lock. True when a read that started at fence clock <paramref name="started"/> was overtaken by a Forget.
        private bool FencedLocked(string key, long started)
            => started < _fenceFloor || (_fences.TryGetValue(key, out var at) && at > started);

        // Caller holds _lock. With no read of any key under way, no old fence can matter any more.
        private void PruneFencesLocked()
        {
            if (_activeReads <= 0 && _inFlight.Count == 0) _fences.Clear();
        }

        /// <summary>
        /// The profiler's overlap (perf-details-open FIX BRIEF item 2): a successful native details read
        /// (<c>movie|tv/{id}?append_to_response=</c> the native set, no language) already holds the generic proxy's base
        /// title, watch providers and the movie's release dates or the series' content ratings, in their standalone shape
        /// once split. Those are stored under their own keys with the read's fetch time and expiry (never "now"), unless
        /// a fresh copy or a read of them already exists, so the generic extras don't fetch them again. Reviews and
        /// anything else stay their own reads. A body that isn't this title (its id) seeds nothing. Caller holds _lock.
        /// </summary>
        private void SeedNativeAppendLocked(string key, TmdbResponse response, List<Entry> save, long fence)
        {
            var bar = key.IndexOf('|', StringComparison.Ordinal);
            var match = NativeAppendPattern.Match(key[(bar + 1)..]);
            if (!match.Success || !_entries.TryGetValue(key, out var source)) return;
            var kind = match.Groups[1].Value;
            var expected = kind == "movie" ? NativeDetails.TmdbNativeShape.MovieAppend : NativeDetails.TmdbNativeShape.SeriesAppend;
            if (!string.Equals(match.Groups[3].Value, expected, StringComparison.Ordinal)) return;
            var id = long.Parse(match.Groups[2].Value, CultureInfo.InvariantCulture);
            var members = kind == "movie" ? new[] { "release_dates", "watch/providers" } : new[] { "content_ratings", "watch/providers" };
            Dictionary<string, TmdbResponse> parts;
            try
            {
                parts = SplitAppended(response.Content, expected.Split(','), members, id);
            }
            catch (Exception ex) when (ex is JsonException or FormatException or InvalidOperationException or OverflowException)
            {
                return;
            }

            var prefix = key[..(bar + 1)];
            var titlePath = kind + "/" + match.Groups[2].Value;
            var now = _timeProvider.GetUtcNow();
            foreach (var (name, part) in parts)
            {
                var memberKey = prefix + UpstreamUrl(name.Length == 0 ? titlePath : titlePath + "/" + name, string.Empty);
                // A destination forgotten since the native read began is not refilled from it.
                if ((_entries.TryGetValue(memberKey, out var existing) && existing.Value.ExpiresAt > now) || _inFlight.ContainsKey(memberKey)
                    || FencedLocked(memberKey, fence)) continue;
                if (StoreLocked(memberKey, part with { FetchedAtUtc = response.FetchedAtUtc }, source.Value.ExpiresAt) is { } stored) save.Add(stored);
            }
        }

        /// <summary>
        /// Splits an append_to_response body: the title without every appended property, and each of
        /// <paramref name="members"/> in its standalone shape (the title's id first). Null when the body isn't title
        /// <paramref name="id"/>; a member TMDB left out (or not an object) is absent.
        /// </summary>
        internal static Dictionary<string, TmdbResponse> SplitAppended(string body, IReadOnlyCollection<string> appended, IReadOnlyCollection<string> members, long id)
        {
            var parts = new Dictionary<string, TmdbResponse>(StringComparer.Ordinal);
            using var document = JsonDocument.Parse(body);
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object || !root.TryGetProperty("id", out var idElement)
                || idElement.ValueKind != JsonValueKind.Number || !idElement.TryGetInt64(out var actual) || actual != id)
            {
                return parts;
            }

            var names = new HashSet<string>(appended, StringComparer.Ordinal);
            var buffer = new MemoryStream();
            using (var writer = new Utf8JsonWriter(buffer))
            {
                writer.WriteStartObject();
                foreach (var property in root.EnumerateObject())
                {
                    if (!names.Contains(property.Name)) property.WriteTo(writer);
                }

                writer.WriteEndObject();
            }

            parts[string.Empty] = ToResponse(buffer);
            foreach (var member in members)
            {
                if (!root.TryGetProperty(member, out var element) || element.ValueKind != JsonValueKind.Object) continue;
                buffer.SetLength(0);
                using (var writer = new Utf8JsonWriter(buffer))
                {
                    writer.WriteStartObject();
                    writer.WriteNumber("id", id);
                    foreach (var property in element.EnumerateObject())
                    {
                        if (property.Name != "id") property.WriteTo(writer);
                    }

                    writer.WriteEndObject();
                }

                parts[member] = ToResponse(buffer);
            }

            return parts;
        }

        /// <summary>Whether an answer may be kept on disk: not a free-text search, not the parental evidence query.</summary>
        internal static bool Durable(string upstreamUrl)
        {
            if (!upstreamUrl.StartsWith(UpstreamPrefix, StringComparison.Ordinal)) return false;
            var resource = upstreamUrl[UpstreamPrefix.Length..];
            var q = resource.IndexOf('?', StringComparison.Ordinal);
            var path = q >= 0 ? resource[..q] : resource;
            // Only a canonical route is ever written: a spelling the proxy also accepts (a leading or doubled slash, a dot
            // segment, an escape) stays in memory, so no spelling of a search can reach the disk.
            if (path.Length == 0 || path.IndexOfAny(NonCanonical) >= 0) return false;
            var segments = path.Split('/');
            if (segments.Any(segment => segment.Length == 0 || segment == "." || segment == "..")) return false;
            if (segments[0].Equals("search", StringComparison.OrdinalIgnoreCase)) return false;
            return q < 0 || !EvidenceQueries.Contains(resource[q..]);
        }

        private static string UrlOf(string key) => key[(key.IndexOf('|', StringComparison.Ordinal) + 1)..];

        /// <summary>The digest naming an answer: SHA-256 of the versioned, length-delimited service, key hash and URL.</summary>
        private static string DiskDigest(string keyHash, string upstreamUrl)
        {
            var text = new StringBuilder();
            foreach (var part in new[] { "tmdb-api-3", "v" + DiskSchema.ToString(CultureInfo.InvariantCulture), keyHash, upstreamUrl })
                text.Append(part.Length.ToString(CultureInfo.InvariantCulture)).Append(':').Append(part);
            return Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(text.ToString())));
        }

        private static string DiskKey(string keyHash, string upstreamUrl) => "tmdbjson/" + DiskSchema.ToString(CultureInfo.InvariantCulture) + "/" + DiskDigest(keyHash, upstreamUrl);

        /// <summary>A record: one header line (JSON: schema, digest, resource, status, type, ETag, fetched, expires), then the body.</summary>
        private static byte[] Encode(Entry entry, string digest, string upstreamUrl)
        {
            var header = new MemoryStream();
            using (var writer = new Utf8JsonWriter(header))
            {
                writer.WriteStartObject();
                writer.WriteNumber("v", DiskSchema);
                writer.WriteString("d", digest);
                writer.WriteString("r", upstreamUrl[UpstreamPrefix.Length..]);
                writer.WriteNumber("s", entry.Response.StatusCode);
                writer.WriteString("t", ServerBlobCache.JsonContentType);
                writer.WriteString("e", entry.Response.ETag);
                writer.WriteNumber("f", entry.Response.FetchedAtUtc.Ticks);
                writer.WriteNumber("x", entry.ExpiresAt.UtcTicks);
                writer.WriteEndObject();
            }

            var body = Encoding.UTF8.GetBytes(entry.Response.Content);
            var bytes = new byte[header.Length + 1 + body.Length];
            header.GetBuffer().AsSpan(0, (int)header.Length).CopyTo(bytes);
            bytes[header.Length] = (byte)'\n';
            body.CopyTo(bytes, header.Length + 1);
            return bytes;
        }

        /// <summary>A record read back, if it is this key's, a stored outcome, within its TTL and intact (its ETag).</summary>
        private (TmdbResponse Response, DateTimeOffset ExpiresAt)? Decode(ServerCacheEntry entry, string keyHash, string upstreamUrl)
        {
            try
            {
                if (entry.ContentType != ServerBlobCache.JsonContentType) return null;
                var newline = Array.IndexOf(entry.Bytes, (byte)'\n', 0, Math.Min(entry.Bytes.Length, MaxHeaderBytes));
                if (newline <= 0) return null;
                using var header = JsonDocument.Parse(entry.Bytes.AsMemory(0, newline));
                var h = header.RootElement;
                var resource = upstreamUrl[UpstreamPrefix.Length..];
                if (h.ValueKind != JsonValueKind.Object
                    || !h.TryGetProperty("v", out var v) || !v.TryGetInt32(out var schema) || schema != DiskSchema
                    || h.GetProperty("d").GetString() != DiskDigest(keyHash, upstreamUrl)
                    || h.GetProperty("r").GetString() != resource
                    || h.GetProperty("t").GetString() != ServerBlobCache.JsonContentType) return null;
                var status = h.GetProperty("s").GetInt32();
                var fetched = h.GetProperty("f").GetInt64();
                var expires = h.GetProperty("x").GetInt64();
                if (!(status is >= 200 and <= 299 or 404) || fetched <= 0 || expires <= fetched || expires > DateTime.MaxValue.Ticks) return null;
                var fetchedAt = new DateTime(fetched, DateTimeKind.Utc);
                var expiresAt = new DateTimeOffset(expires, TimeSpan.Zero);
                var now = _timeProvider.GetUtcNow();
                // Not from the future, still valid, and never valid for longer than this answer's own TTL.
                var ttl = status == 404 ? NotFoundTtl : GetTtl(resource);
                if (fetchedAt > now.UtcDateTime.AddMinutes(1) || expiresAt <= now || expiresAt > new DateTimeOffset(fetchedAt) + ttl + TimeSpan.FromMinutes(1)) return null;
                var content = Encoding.UTF8.GetString(entry.Bytes, newline + 1, entry.Bytes.Length - newline - 1);
                var etag = ComputeETag(content);
                if (h.GetProperty("e").GetString() != etag) return null;
                return (new TmdbResponse(status, content, etag) { FetchedAtUtc = fetchedAt }, expiresAt);
            }
            catch (Exception ex) when (ex is JsonException or InvalidOperationException or KeyNotFoundException or FormatException or ArgumentException)
            {
                return null;
            }
        }
    }
}
