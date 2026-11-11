using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using MediaBrowser.Common.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Features.MediaTags.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.Mdblist;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.MediaTags;

namespace Jellyfin.Plugin.JellyfinEnhanced.Features.DetailsProviders.Services
{
    /// <summary>
    /// Looks up ratings (TMDB score, Rotten Tomatoes critic/audience, IMDb,
    /// Trakt, Metacritic, etc.) for a title by TMDB id from the MDBList API,
    /// and caches the result to disk. The admin's MDBList API key never
    /// leaves the server; clients only ever see the parsed rating entries
    /// via JeDetailsProvidersController's mdblist-ratings endpoint.
    ///
    /// Persistence mirrors WikidataAwardsService: an in-memory dictionary is
    /// the source of truth, mutations are debounced to one atomic (temp file
    /// + rename) write instead of a write per lookup, populated lazily on
    /// request rather than built up-front for the whole library.
    /// </summary>
    public class MdblistService : IDisposable
    {
        private const string ApiBase = "https://api.mdblist.com";

        private static readonly TimeSpan RequestTimeout = TimeSpan.FromSeconds(15);
        // GetMediaBatchAsync's request body/response can be much larger than
        // any other call this service makes, so it gets more room than the
        // default before treating a slow response as a failure.
        private static readonly TimeSpan BatchRequestTimeout = TimeSpan.FromSeconds(90);
        // A "found" title's ratings drift slowly but rarely disappear, so
        // re-check occasionally rather than freezing at first-fetch accuracy.
        private static readonly TimeSpan PositiveTtl = TimeSpan.FromDays(7);
        private static readonly TimeSpan NegativeTtl = TimeSpan.FromDays(3);
        // For a CONFIRMED "no match" answer only. An unconfirmed (failed)
        // lookup retries much sooner. See MdblistCacheEntry.Confirmed.
        private static readonly TimeSpan RetryTtl = TimeSpan.FromHours(1);
        private static readonly TimeSpan SaveDebounce = TimeSpan.FromSeconds(10);
        private static readonly TimeSpan SaveMaxWait = TimeSpan.FromMinutes(2);
        private const int CurrentSchemaVersion = 2;
        // Titles kept in memory and in mdblist-ratings.json. Well above a library's movies and series:
        // the library-wide fetch, the ratings sync and the rating tags all read this cache.
        internal const int MaxCacheEntries = 50000;

        private readonly IHttpClientFactory _httpClientFactory;
        private readonly IApplicationPaths _applicationPaths;
        private readonly Logger _logger;

        private readonly ConcurrentDictionary<string, MdblistCacheEntry> _cache = new();
        private readonly ConcurrentDictionary<string, SemaphoreSlim> _inFlight = new();
        private readonly object _saveLock = new();
        private volatile bool _dirty;
        private long _firstDirtyTicks;
        private Timer? _debounceSaveTimer;
        private volatile bool _disposed;

        // Live account/quota status from MDBList's own GET /user endpoint, the
        // authoritative source for remaining requests rather than a
        // locally-tracked counter that would drift after a plugin/server
        // restart. Refreshed on AccountStatusTtl; querying /user doesn't
        // itself count against the rate limit.
        private static readonly TimeSpan AccountStatusTtl = TimeSpan.FromMinutes(3);
        // Stop making real calls once this few (or fewer) remain, regardless
        // of any caller-supplied reserve, as a hard floor against ever
        // actually hitting 0 and getting 429s.
        public const int SafetyMargin = 5;
        private readonly object _accountStatusLock = new();
        private MdblistAccountStatus? _accountStatus;
        // Requests counted locally so far, and the /user queries started and
        // last published, all under _accountStatusLock. A /user answer is
        // reconciled against the requests spent since it was started, so a
        // slow response can't hand back quota that has already been used.
        private long _quotaSpent;
        private long _accountStatusQueries;
        private long _accountStatusPublishedQuery;

        /// <summary>
        /// Lookups that spend quota one account may start per <see cref="UserLookupWindow"/> through the
        /// item-details route. Every signed-in account may use it and the administrator's MDBList quota pays,
        /// so one caller cannot use up the day's quota; answers already cached cost nothing.
        /// </summary>
        public const int UserLookupsPerWindow = 100;

        /// <inheritdoc cref="UserLookupsPerWindow"/>
        public static readonly TimeSpan UserLookupWindow = TimeSpan.FromHours(24);

        private readonly Dictionary<string, (DateTime Start, int Lookups)> _userLookups = new();

        public MdblistService(IHttpClientFactory httpClientFactory, IApplicationPaths applicationPaths, Logger logger)
        {
            _httpClientFactory = httpClientFactory;
            _applicationPaths = applicationPaths;
            _logger = logger;
            LoadFromDisk();
        }

        private string CacheFilePath =>
            Path.Combine(_applicationPaths.PluginsPath, "configurations", "Jellyfin.Plugin.JellyfinEnhanced", "mdblist-ratings.json");

        private static string CacheKey(string mediaType, string tmdbId) => $"{mediaType}-{tmdbId}";

        /// <summary>
        /// Returns the cached ratings entry for this title, fetching from
        /// MDBList on a cache miss (or an expired entry). Concurrent callers
        /// for the SAME title share one in-flight fetch instead of firing
        /// duplicate MDBList requests.
        /// </summary>
        public async Task<MdblistCacheEntry> GetRatingsAsync(string mediaType, string tmdbId, CancellationToken cancellationToken)
        {
            var key = CacheKey(mediaType, tmdbId);

            if (_cache.TryGetValue(key, out var cached) && !IsExpired(cached))
            {
                return cached;
            }

            var gate = _inFlight.GetOrAdd(key, _ => new SemaphoreSlim(1, 1));
            await gate.WaitAsync(cancellationToken).ConfigureAwait(false);
            try
            {
                if (_cache.TryGetValue(key, out cached) && !IsExpired(cached))
                {
                    return cached;
                }

                var fetched = await FetchFromMdblistAsync(mediaType, tmdbId, cancellationToken).ConfigureAwait(false);
                // A caller that gave up must not publish anything: the cache is
                // shared with the tag-rating warmers and every other viewer.
                cancellationToken.ThrowIfCancellationRequested();
                fetched = KeepLastGood(cached, fetched);
                _cache[key] = fetched;
                // Expired entries without ratings go at once; past the cap, the oldest. Expired ratings
                // stay: a failed refresh keeps them (KeepLastGood) and rating tags show them meanwhile.
                foreach (var entry in _cache.Where(e => !e.Value.Found && IsExpired(e.Value)).ToList()) _cache.TryRemove(entry);
                foreach (var entry in _cache.OrderBy(e => e.Value.FetchedAtUnixMs).Take(_cache.Count - MaxCacheEntries).ToList()) _cache.TryRemove(entry);
                ScheduleDebouncedSave();
                return fetched;
            }
            finally
            {
                gate.Release();
                if (gate.CurrentCount == 1)
                {
                    _inFlight.TryRemove(key, out _);
                }
            }
        }

        private static bool IsExpired(MdblistCacheEntry entry)
        {
            if (entry.RetryAfterUnixMs is { } retryAfter) return DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() >= retryAfter;
            var age = DateTimeOffset.UtcNow - DateTimeOffset.FromUnixTimeMilliseconds(entry.FetchedAtUnixMs);
            if (entry.Found) return age > PositiveTtl;
            return age > (entry.Confirmed ? NegativeTtl : RetryTtl);
        }

        /// <summary>
        /// The entry to store after a lookup: the fresh answer, except that a failed lookup (not a
        /// confirmed answer) for a title that has ratings keeps those ratings and their age, and
        /// only schedules the next attempt (RetryTtl), so a provider outage never erases scores.
        /// </summary>
        internal static MdblistCacheEntry KeepLastGood(MdblistCacheEntry? previous, MdblistCacheEntry fresh)
        {
            if (fresh.Confirmed || previous is not { Found: true }) return fresh;
            return new MdblistCacheEntry
            {
                Found = true,
                Confirmed = previous.Confirmed,
                Ratings = previous.Ratings,
                Ids = previous.Ids,
                FetchedAtUnixMs = previous.FetchedAtUnixMs,
                RetryAfterUnixMs = fresh.FetchedAtUnixMs + (long)RetryTtl.TotalMilliseconds,
            };
        }

        /// <summary>Cache-only read, no network call: whatever's currently on disk/in
        /// memory for this title, or null if it's never been fetched at all. Used by
        /// MdblistRatingsSyncTask, which only ever writes Jellyfin's own
        /// CommunityRating/CriticRating from whatever MdblistRatingsFetchTask has
        /// already populated; it never calls MDBList itself.</summary>
        public MdblistCacheEntry? GetCachedEntry(string mediaType, string tmdbId) =>
            _cache.TryGetValue(CacheKey(mediaType, tmdbId), out var entry) ? entry : null;

        /// <summary>
        /// When this title's cached answer stops being current (Unix ms): its retry time after a failed
        /// refresh, else its fetch time plus the found, confirmed-missing or failure lifetime, the moment
        /// <see cref="NeedsFetch"/> turns true. Null when nothing is cached for it.
        /// </summary>
        public long? RefreshAtUnixMs(string mediaType, string tmdbId)
        {
            if (!_cache.TryGetValue(CacheKey(mediaType, tmdbId), out var entry)) return null;
            if (entry.RetryAfterUnixMs is { } retryAfter) return retryAfter;
            var ttl = entry.Found ? PositiveTtl : entry.Confirmed ? NegativeTtl : RetryTtl;
            return entry.FetchedAtUnixMs + (long)ttl.TotalMilliseconds;
        }

        /// <summary>Counts one quota-spending lookup for <paramref name="user"/>; false when its share for the
        /// current <see cref="UserLookupWindow"/> is used up.</summary>
        public bool TryUseUserLookup(string user)
        {
            var now = DateTime.UtcNow;
            lock (_userLookups)
            {
                if (!_userLookups.TryGetValue(user, out var used) || now - used.Start >= UserLookupWindow)
                {
                    used = (now, 0);
                }

                if (used.Lookups >= UserLookupsPerWindow)
                {
                    return false;
                }

                _userLookups[user] = (used.Start, used.Lookups + 1);
                return true;
            }
        }

        /// <summary>True when this title has no cached entry yet, or its cached entry
        /// is stale enough to be worth a real MDBList lookup (see IsExpired). Used by
        /// MdblistRatingsFetchTask to build its candidate list, purely about cache
        /// freshness rather than MdblistRatingsSyncTask's Jellyfin-field
        /// candidates, so a frequent re-run mostly costs nothing once the
        /// library's cache is warm.</summary>
        public bool NeedsFetch(string mediaType, string tmdbId)
        {
            var key = CacheKey(mediaType, tmdbId);
            return !_cache.TryGetValue(key, out var entry) || IsExpired(entry);
        }

        /// <summary>TMDB's score, converted to Jellyfin's native 0-10 CommunityRating
        /// range, or null if MDBList has none. MDBList's own "tmdb" source is already
        /// normalized to the same ~0-100 scale as its other sources (a real TMDB
        /// vote_average of 5.8 comes back as value/score 58), so dividing by 10
        /// converts it back to what TMDB/OMDb providers themselves write into
        /// CommunityRating.</summary>
        public static double? GetCommunityRating(MdblistCacheEntry entry, string? source = null)
        {
            var score = GetSourceScore(entry, string.IsNullOrWhiteSpace(source) ? "tmdb" : source.Trim().ToLowerInvariant());
            return score.HasValue ? score.Value / 10.0 : (double?)null;
        }

        /// <summary>Critic score (0-100) from the given source (default RT), or null.</summary>
        public static double? GetCriticRating(MdblistCacheEntry entry, string? source = null) =>
            GetSourceScore(entry, string.IsNullOrWhiteSpace(source) ? "tomatoes" : source.Trim().ToLowerInvariant());

        private static double? GetSourceScore(MdblistCacheEntry entry, string source)
        {
            if (entry?.Ratings == null) return null;
            var match = entry.Ratings.FirstOrDefault(r => r.Source == source);
            // Prefer Score (what MDBList itself displays, already scaled to
            // the source's native range) and fall back to the raw Value.
            // Value is on the source's own scale (IMDb /10), so only tmdb/tomatoes may fall back to it.
            return source is "tmdb" or "tomatoes" ? match?.Score ?? match?.Value : match?.Score;
        }

        /// <summary>Cached remaining-quota count (no network call), or null if
        /// account status has never been successfully fetched yet. Callers that
        /// need a fresh read (e.g. a task about to start iterating the library)
        /// should call GetAccountStatusAsync first so this reflects current data.</summary>
        public int? RemainingQuota()
        {
            lock (_accountStatusLock)
            {
                return _accountStatus?.RateLimitRemaining;
            }
        }

        /// <summary>
        /// Fetches (or returns the cached, still-fresh) account status from
        /// MDBList's GET /user endpoint: plan, daily limit, remaining
        /// requests, and reset time. This call itself doesn't count against
        /// the rate limit, so it's safe to refresh liberally (e.g. every time
        /// the config page is opened). Returns null if no API key is
        /// available or the request fails.
        /// </summary>
        /// <param name="apiKeyOverride">Test an arbitrary (e.g. unsaved) key
        /// instead of the saved config's; always fetched fresh and never
        /// cached/stored, so it can't pollute the real quota tracking with a
        /// key that isn't actually the one in use.</param>
        public Task<MdblistAccountStatus?> GetAccountStatusAsync(CancellationToken cancellationToken, bool forceRefresh = false, string? apiKeyOverride = null) =>
            GetAccountStatusCoreAsync(cancellationToken, forceRefresh, apiKeyOverride, quotaGateHeld: false);

        /// <summary>GetAccountStatusAsync for callers that may already hold
        /// _backgroundQuotaGate (quotaGateHeld), which the publication of a
        /// fresh status otherwise takes so it can't land between a background
        /// batch's reserve check and its decrement.</summary>
        private async Task<MdblistAccountStatus?> GetAccountStatusCoreAsync(CancellationToken cancellationToken, bool forceRefresh, string? apiKeyOverride, bool quotaGateHeld)
        {
            var testingOverride = !string.IsNullOrWhiteSpace(apiKeyOverride);

            if (!forceRefresh && !testingOverride)
            {
                lock (_accountStatusLock)
                {
                    if (_accountStatus != null &&
                        DateTimeOffset.UtcNow - DateTimeOffset.FromUnixTimeMilliseconds(_accountStatus.FetchedAtUnixMs) < AccountStatusTtl)
                    {
                        return _accountStatus;
                    }
                }
            }

            var apiKey = testingOverride ? apiKeyOverride : JellyfinEnhanced.Instance?.Configuration?.MdblistApiKey;
            if (string.IsNullOrWhiteSpace(apiKey)) return null;

            long query, spentAtStart;
            lock (_accountStatusLock)
            {
                query = ++_accountStatusQueries;
                spentAtStart = _quotaSpent;
            }

            try
            {
                var client = _httpClientFactory.CreateClient();
                client.Timeout = RequestTimeout;

                var url = $"{ApiBase}/user?apikey={Uri.EscapeDataString(apiKey)}";
                using var response = await client.GetAsync(url, cancellationToken).ConfigureAwait(false);
                if (!response.IsSuccessStatusCode)
                {
                    _logger.Warning($"[MDBList] Account status query failed ({(int)response.StatusCode})");
                    return null;
                }

                await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken).ConfigureAwait(false);
                using var doc = await JsonDocument.ParseAsync(stream, cancellationToken: cancellationToken).ConfigureAwait(false);
                var root = doc.RootElement;

                var status = new MdblistAccountStatus
                {
                    Plan = root.TryGetProperty("plan", out var planEl) && planEl.ValueKind == JsonValueKind.String ? (planEl.GetString() ?? string.Empty) : string.Empty,
                    IsSupporter = root.TryGetProperty("is_supporter", out var supEl) && supEl.ValueKind == JsonValueKind.True,
                    RateLimit = GetNullableInt(root, "rate_limit") ?? 0,
                    RateLimitRemaining = GetNullableInt(root, "rate_limit_remaining") ?? 0,
                    RateLimitResetUnixSeconds = GetNullableLong(root, "rate_limit_reset") ?? 0,
                    FetchedAtUnixMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                };

                if (testingOverride) return status;

                if (!quotaGateHeld) await _backgroundQuotaGate.WaitAsync(cancellationToken).ConfigureAwait(false);
                try
                {
                    lock (_accountStatusLock)
                    {
                        // A query older than the one already published is
                        // superseded; otherwise take off whatever was spent
                        // locally after it was sent, which its answer may not
                        // include yet.
                        if (query < _accountStatusPublishedQuery && _accountStatus != null) return _accountStatus;
                        status.RateLimitRemaining = (int)Math.Max(0, status.RateLimitRemaining - (_quotaSpent - spentAtStart));
                        _accountStatus = status;
                        _accountStatusPublishedQuery = query;
                        return status;
                    }
                }
                finally
                {
                    if (!quotaGateHeld) _backgroundQuotaGate.Release();
                }
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception ex)
            {
                _logger.Warning($"[MDBList] Failed to fetch account status: {ex.GetType().Name}");
                return null;
            }
        }

        private void RecordQuotaSpent()
        {
            lock (_accountStatusLock)
            {
                _quotaSpent++;
                if (_accountStatus != null)
                {
                    _accountStatus.RateLimitRemaining = Math.Max(0, _accountStatus.RateLimitRemaining - 1);
                }
            }
        }

        private async Task<MdblistCacheEntry> FetchFromMdblistAsync(string mediaType, string tmdbId, CancellationToken cancellationToken)
        {
            var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            var apiKey = JellyfinEnhanced.Instance?.Configuration?.MdblistApiKey;
            if (string.IsNullOrWhiteSpace(apiKey))
            {
                return new MdblistCacheEntry { Found = false, Confirmed = false, FetchedAtUnixMs = now };
            }

            // Fail OPEN if account status is unknown (e.g. the one /user probe
            // itself failed); a defensive check layered on top of the real
            // request, not a hard requirement to proceed.
            var status = await GetAccountStatusAsync(cancellationToken).ConfigureAwait(false);
            if (status != null && status.RateLimitRemaining <= SafetyMargin)
            {
                // Not a real "MDBList has no data" answer, so Confirmed=false
                // retries on the short RetryTtl instead of being trusted as a
                // negative result for NegativeTtl's much longer window.
                _logger.Warning($"[MDBList] Only {status.RateLimitRemaining} requests remaining today, skipping lookup for {mediaType}:{tmdbId}");
                return new MdblistCacheEntry { Found = false, Confirmed = false, FetchedAtUnixMs = now };
            }

            try
            {
                var mdblistType = mediaType == "tv" ? "show" : "movie";
                var client = _httpClientFactory.CreateClient();
                client.Timeout = RequestTimeout;

                var url = $"{ApiBase}/tmdb/{mdblistType}/{tmdbId}?apikey={Uri.EscapeDataString(apiKey)}";
                using var response = await client.GetAsync(url, cancellationToken).ConfigureAwait(false);

                // The request was made either way, so reflect that in the cached
                // status immediately: a burst of back-to-back calls within the
                // same AccountStatusTtl window should still throttle correctly
                // rather than all reading the same stale "remaining" value.
                RecordQuotaSpent();

                if (!response.IsSuccessStatusCode)
                {
                    _logger.Warning($"[MDBList] Query failed ({(int)response.StatusCode}) for {mediaType}:{tmdbId}");
                    return new MdblistCacheEntry { Found = false, Confirmed = false, FetchedAtUnixMs = now };
                }

                await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken).ConfigureAwait(false);
                using var doc = await JsonDocument.ParseAsync(stream, cancellationToken: cancellationToken).ConfigureAwait(false);

                return ParseResponse(doc, now);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception ex)
            {
                // Network hiccup, timeout, malformed response: never let a
                // ratings lookup fail the item-details page. Cache as a
                // short-lived miss (RetryTtl, not NegativeTtl) so the same
                // title isn't retried on every view but isn't trusted as a
                // confirmed "no data" either.
                _logger.Warning($"[MDBList] Failed to fetch ratings for {mediaType}:{tmdbId}: {ex.GetType().Name}");
                return new MdblistCacheEntry { Found = false, Confirmed = false, FetchedAtUnixMs = now };
            }
        }

        /// <summary>
        /// Batch media lookup: one MDBList request resolves however many ids
        /// are passed in, by TMDB id, in the same shape ParseResponse parses
        /// for the single-item endpoint (every rating source, votes,
        /// per-source urls, and cross-provider ids). Reached only through
        /// GetMediaBatchWithinReserveAsync, which MdblistRatingsFetchRunner and
        /// the tag-rating warmers use to warm mdblist-ratings.json for both the
        /// item-details display and MdblistRatingsSyncTask's Jellyfin-field
        /// sync to read from.
        ///
        /// Returns a tmdbId to parsed entry map for whichever requested ids
        /// MDBList actually matched (an id absent from the result just has no
        /// MDBList data, not an error). Returns null on failure (bad key,
        /// network error, quota exhausted).
        /// </summary>
        private async Task<Dictionary<string, MdblistCacheEntry>?> GetMediaBatchAsync(string mediaType, IReadOnlyList<string> tmdbIds, CancellationToken cancellationToken)
        {
            if (tmdbIds == null || tmdbIds.Count == 0) return new Dictionary<string, MdblistCacheEntry>();

            var apiKey = JellyfinEnhanced.Instance?.Configuration?.MdblistApiKey;
            if (string.IsNullOrWhiteSpace(apiKey)) return null;

            var status = await GetAccountStatusCoreAsync(cancellationToken, false, null, quotaGateHeld: true).ConfigureAwait(false);
            if (status != null && status.RateLimitRemaining <= SafetyMargin)
            {
                _logger.Warning($"[MDBList] Only {status.RateLimitRemaining} requests remaining today, skipping media batch lookup for {mediaType} ({tmdbIds.Count} ids)");
                return null;
            }

            var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

            try
            {
                var mdblistType = mediaType == "tv" ? "show" : "movie";
                var client = _httpClientFactory.CreateClient();
                // A whole-library call can carry a large request body and take
                // longer for MDBList to resolve than a small chunk would, so
                // it gets more time than the 15s default used elsewhere.
                client.Timeout = BatchRequestTimeout;

                var url = $"{ApiBase}/tmdb/{mdblistType}/?apikey={Uri.EscapeDataString(apiKey)}";
                var idsAsLongs = tmdbIds.Select(id => long.Parse(id)).ToArray();
                var payloadJson = JsonSerializer.Serialize(new { ids = idsAsLongs });
                using var payload = new StringContent(payloadJson, Encoding.UTF8, "application/json");
                using var response = await client.PostAsync(url, payload, cancellationToken).ConfigureAwait(false);

                // The request was made either way; see the matching comment in
                // FetchFromMdblistAsync for why this decrements immediately.
                RecordQuotaSpent();

                var responseBody = await response.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false);

                if (!response.IsSuccessStatusCode)
                {
                    _logger.Warning($"[MDBList] Media batch query failed ({(int)response.StatusCode}) for {mediaType} ({tmdbIds.Count} ids).");
                    return null;
                }

                using var doc = JsonDocument.Parse(responseBody);
                var root = doc.RootElement;

                var result = new Dictionary<string, MdblistCacheEntry>();
                if (root.ValueKind == JsonValueKind.Array)
                {
                    foreach (var itemEl in root.EnumerateArray())
                    {
                        var entry = ParseMediaItem(itemEl, now);
                        // The array item's own top-level "id" is an internal
                        // MDBList id, not the tmdb id we requested by. Match
                        // results back to our request via Ids["tmdb"] instead.
                        if (entry.Ids.TryGetValue("tmdb", out var tmdbIdStr) && !string.IsNullOrEmpty(tmdbIdStr))
                        {
                            result[tmdbIdStr] = entry;
                        }
                    }
                }
                else
                {
                    _logger.Warning($"[MDBList] Media batch response for {mediaType} wasn't a JSON array as expected.");
                }

                return result;
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception ex)
            {
                _logger.Warning($"[MDBList] Failed to fetch media batch for {mediaType} ({tmdbIds.Count} ids): {ex.GetType().Name}");
                return null;
            }
        }

        private readonly SemaphoreSlim _tagRatingsGate = new(1, 1);

        // One background batch at a time across the bulk runner and the
        // incremental warmers, held from the reserve check through the request
        // and its local quota decrement, so two callers can never both pass
        // the same "remaining > reserve" check. Every fresh /user status is
        // published under it too (GetAccountStatusCoreAsync).
        private readonly SemaphoreSlim _backgroundQuotaGate = new(1, 1);

        /// <summary>
        /// The only way background callers (MdblistRatingsFetchRunner and
        /// WarmTagRatingsAsync) reach MDBList's batch endpoint: checks the
        /// remaining quota against the caller's reserve (never below
        /// SafetyMargin) and sends the batch under one shared gate. Unknown
        /// account status sends nothing.
        /// </summary>
        public async Task<MdblistReservedBatch> GetMediaBatchWithinReserveAsync(string mediaType, IReadOnlyList<string> tmdbIds, int reserve, CancellationToken cancellationToken)
        {
            await _backgroundQuotaGate.WaitAsync(cancellationToken).ConfigureAwait(false);
            try
            {
                if (await GetAccountStatusCoreAsync(cancellationToken, false, null, quotaGateHeld: true).ConfigureAwait(false) == null)
                {
                    return new MdblistReservedBatch(MdblistReservedBatchStatus.QuotaUnknown, null, null);
                }

                // Read under the status lock: the cached status is decremented in place after each request.
                var remaining = RemainingQuota();
                if (remaining == null) return new MdblistReservedBatch(MdblistReservedBatchStatus.QuotaUnknown, null, null);
                if (remaining.Value <= Math.Max(SafetyMargin, reserve))
                {
                    return new MdblistReservedBatch(MdblistReservedBatchStatus.ReserveReached, remaining, null);
                }

                var results = await GetMediaBatchAsync(mediaType, tmdbIds, cancellationToken).ConfigureAwait(false);
                return new MdblistReservedBatch(results == null ? MdblistReservedBatchStatus.Failed : MdblistReservedBatchStatus.Sent, RemainingQuota(), results);
            }
            finally { _backgroundQuotaGate.Release(); }
        }

        /// <summary>
        /// Fetch a bounded Awards chart under the same reserve/status/spend gate as
        /// background rating batches. Unknown quota sends nothing; callers retain
        /// their last good snapshot and retry rather than confirming a missing chart.
        /// </summary>
        internal async Task<Dictionary<string, int>?> GetAwardListWithinReserveAsync(string id, int reserve, CancellationToken cancellationToken)
        {
            var apiKey = JellyfinEnhanced.Instance?.Configuration.MdblistApiKey;
            if (string.IsNullOrWhiteSpace(apiKey) || !AwardLists.IsListId(id)) return null;
            await _backgroundQuotaGate.WaitAsync(cancellationToken).ConfigureAwait(false);
            try
            {
                if (await GetAccountStatusCoreAsync(cancellationToken, false, null, quotaGateHeld: true).ConfigureAwait(false) == null)
                    return null;
                var remaining = RemainingQuota();
                if (remaining == null || remaining.Value <= Math.Max(SafetyMargin, reserve)) return null;

                using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
                timeout.CancelAfter(TimeSpan.FromSeconds(20));
                var uri = $"{ApiBase}/lists/{id}/items?apikey={Uri.EscapeDataString(apiKey)}&limit=250&sort=rank&order=asc";
                using var request = new HttpRequestMessage(HttpMethod.Get, uri);
                using var response = await _httpClientFactory.CreateClient().SendAsync(request, timeout.Token).ConfigureAwait(false);
                RecordQuotaSpent();
                response.EnsureSuccessStatusCode();
                await using var stream = await response.Content.ReadAsStreamAsync(timeout.Token).ConfigureAwait(false);
                using var json = await JsonDocument.ParseAsync(stream, cancellationToken: timeout.Token).ConfigureAwait(false);
                return AwardLists.ParseList(json.RootElement);
            }
            finally { _backgroundQuotaGate.Release(); }
        }

        /// <summary>Bounded, serialized request-time enrichment, sharing the existing seven-day cache and the background quota reserve.</summary>
        public async Task WarmTagRatingsAsync(IEnumerable<(string MediaType, string Id)> titles, CancellationToken cancellationToken, int reserve = SafetyMargin, TimeSpan? maxAge = null)
        {
            if (string.IsNullOrWhiteSpace(JellyfinEnhanced.Instance?.Configuration.MdblistApiKey)) return;
            bool Due((string MediaType, string Id) t) => NeedsFetch(t.MediaType, t.Id)
                || (maxAge != null && GetCachedEntry(t.MediaType, t.Id) is { Found: true } entry
                    && DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - entry.FetchedAtUnixMs >= maxAge.Value.TotalMilliseconds
                    // Kept ratings after a failed refresh wait for their retry time.
                    && (entry.RetryAfterUnixMs is not { } retryAfter || DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() >= retryAfter));
            // Titles already fresh never queue behind another caller's fetch.
            var due = titles.Distinct().Where(Due).ToArray();
            if (due.Length == 0) return;
            await _tagRatingsGate.WaitAsync(cancellationToken).ConfigureAwait(false);
            try
            {
                // Checked again inside the gate: the caller ahead may have fetched them.
                foreach (var group in due.Where(Due).GroupBy(t => t.MediaType))
                {
                    foreach (var chunk in group.Chunk(150))
                    {
                        cancellationToken.ThrowIfCancellationRequested();
                        var ids = chunk.Select(t => t.Id).ToArray();
                        var batch = await GetMediaBatchWithinReserveAsync(group.Key, ids, reserve, cancellationToken).ConfigureAwait(false);
                        cancellationToken.ThrowIfCancellationRequested();
                        // Unknown quota stops background work, as the bulk runner does; titles stay NeedsFetch.
                        if (batch.Status is MdblistReservedBatchStatus.ReserveReached or MdblistReservedBatchStatus.QuotaUnknown) return;
                        if (batch.Status == MdblistReservedBatchStatus.Failed)
                        {
                            // Match single-title failures: short retry TTL, never a confirmed negative.
                            // A title with good ratings keeps them until a refresh succeeds.
                            var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                            foreach (var id in ids)
                            {
                                var key = CacheKey(group.Key, id);
                                _cache[key] = KeepLastGood(GetCachedEntry(group.Key, id), new MdblistCacheEntry { Found = false, Confirmed = false, FetchedAtUnixMs = now });
                            }
                            ScheduleDebouncedSave();
                            return;
                        }
                        MergeMediaBatchIntoCache(group.Key, ids, batch.Results!);
                        await Task.Delay(TimeSpan.FromMilliseconds(250), cancellationToken).ConfigureAwait(false);
                    }
                }
            }
            finally { _tagRatingsGate.Release(); }
        }

        /// <summary>
        /// Writes a round of GetMediaBatchAsync results into the same cache the
        /// item-details display proxy and Jellyfin-field sync both read from.
        /// This is a full overwrite, not a partial merge: every source/vote/url/
        /// id this endpoint provides for a title comes back in the one call, so
        /// there's nothing to preserve from a prior fetch. Ids this batch
        /// attempted but MDBList didn't match are written as a confirmed
        /// "not found" placeholder so they aren't immediately retried next run
        /// (same role NegativeTtl plays for the single-item path).
        /// </summary>
        public void MergeMediaBatchIntoCache(string mediaType, IReadOnlyList<string> attemptedTmdbIds, IReadOnlyDictionary<string, MdblistCacheEntry> results)
        {
            if (attemptedTmdbIds == null || attemptedTmdbIds.Count == 0) return;

            var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            foreach (var tmdbId in attemptedTmdbIds)
            {
                var key = CacheKey(mediaType, tmdbId);
                _cache[key] = results != null && results.TryGetValue(tmdbId, out var entry)
                    ? entry
                    : new MdblistCacheEntry { Found = false, Confirmed = true, FetchedAtUnixMs = now };
            }

            ScheduleDebouncedSave();
        }

        private static MdblistCacheEntry ParseResponse(JsonDocument doc, long fetchedAtUnixMs)
        {
            var root = doc.RootElement;

            // MDBList returns {"response": false, "error": "..."} when there's no match for this id.
            if (root.TryGetProperty("response", out var respEl) && respEl.ValueKind == JsonValueKind.False)
            {
                return new MdblistCacheEntry { Found = false, Confirmed = true, FetchedAtUnixMs = fetchedAtUnixMs };
            }

            return ParseMediaItem(root, fetchedAtUnixMs);
        }

        /// <summary>
        /// Parses one media item object, the shape shared between the
        /// single-item endpoint's root response and each element of
        /// GetMediaBatchAsync's result array: ratings[] (value/score/votes/url
        /// per source), the top-level "score" (MDBList's own aggregate,
        /// synthesized as our "master" source since it's not itself a
        /// ratings[] entry), and the cross-provider ids object.
        /// </summary>
        private static MdblistCacheEntry ParseMediaItem(JsonElement item, long fetchedAtUnixMs)
        {
            var ratings = new List<MdblistRatingSource>();
            if (item.TryGetProperty("ratings", out var ratingsEl) && ratingsEl.ValueKind == JsonValueKind.Array)
            {
                foreach (var r in ratingsEl.EnumerateArray())
                {
                    if (!r.TryGetProperty("source", out var sourceEl) || sourceEl.ValueKind != JsonValueKind.String)
                    {
                        continue;
                    }
                    var source = sourceEl.GetString();
                    if (string.IsNullOrEmpty(source)) continue;

                    ratings.Add(new MdblistRatingSource
                    {
                        Source = source,
                        Value = GetNullableDouble(r, "value"),
                        Score = GetNullableDouble(r, "score"),
                        Votes = GetNullableInt(r, "votes"),
                        // "url" is a source-specific slug/path for most sources,
                        // but a bare integer for imdb, which isn't a usable link
                        // either way. imdb's own link is built from Ids["imdb"]
                        // instead (see mdblist-ratings.js's generateLink), so a
                        // non-string value here is simply skipped.
                        Url = r.TryGetProperty("url", out var urlEl) && urlEl.ValueKind == JsonValueKind.String ? urlEl.GetString() : null,
                        Fresh = GetNullableInt(r, "fresh"),
                        Certified = r.TryGetProperty("certified", out var certified)
                            ? certified.ValueKind == JsonValueKind.True || (certified.ValueKind == JsonValueKind.Number && certified.TryGetInt32(out var flag) && flag == 1)
                            : null,
                    });
                }
            }

            // MDBList's own aggregate ("master") score is not a member of the
            // ratings[] array; it's a top-level field on the response.
            // Synthesized here as a regular source entry so the rest of the
            // pipeline (display badges, MdblistRatingsSources filtering/
            // ordering) treats it identically to every other source.
            var masterScore = GetNullableDouble(item, "score");
            if (masterScore.HasValue)
            {
                ratings.Add(new MdblistRatingSource { Source = "master", Value = masterScore, Score = masterScore });
            }

            // Cross-provider IDs (imdb/tmdb/trakt/mal/anilist/...) so the display
            // module can link each badge to its own site (see MdblistCacheEntry.Ids).
            // Values can be a string (imdb's "tt1234567") or a number (tmdb/trakt/
            // mal/anilist) in MDBList's JSON; normalized to string either way.
            var ids = new Dictionary<string, string>();
            if (item.TryGetProperty("ids", out var idsEl) && idsEl.ValueKind == JsonValueKind.Object)
            {
                foreach (var prop in idsEl.EnumerateObject())
                {
                    if (prop.Value.ValueKind == JsonValueKind.String)
                    {
                        var s = prop.Value.GetString();
                        if (!string.IsNullOrEmpty(s)) ids[prop.Name] = s;
                    }
                    else if (prop.Value.ValueKind == JsonValueKind.Number)
                    {
                        ids[prop.Name] = prop.Value.GetRawText();
                    }
                }
            }

            return new MdblistCacheEntry
            {
                Found = true,
                Confirmed = true,
                Ratings = ratings,
                Ids = ids,
                FetchedAtUnixMs = fetchedAtUnixMs,
            };
        }

        private static double? GetNullableDouble(JsonElement el, string property)
        {
            if (!el.TryGetProperty(property, out var v) || v.ValueKind != JsonValueKind.Number) return null;
            return v.TryGetDouble(out var d) ? d : null;
        }

        private static int? GetNullableInt(JsonElement el, string property)
        {
            if (!el.TryGetProperty(property, out var v) || v.ValueKind != JsonValueKind.Number) return null;
            return v.TryGetInt32(out var i) ? i : null;
        }

        private static long? GetNullableLong(JsonElement el, string property)
        {
            if (!el.TryGetProperty(property, out var v) || v.ValueKind != JsonValueKind.Number) return null;
            return v.TryGetInt64(out var l) ? l : null;
        }

        private void LoadFromDisk()
        {
            var path = CacheFilePath;
            if (!File.Exists(path))
            {
                _logger.Info("[MDBList] No cache file found, starting empty");
                return;
            }

            try
            {
                using var stream = File.OpenRead(path);
                var data = JsonSerializer.Deserialize<MdblistCacheDiskFormat>(stream);
                if (data?.Items == null) return;

                if (data.SchemaVersion != CurrentSchemaVersion)
                {
                    _logger.Info($"[MDBList] On-disk cache schema v{data.SchemaVersion} != current v{CurrentSchemaVersion}; discarding {data.Items.Count} entries.");
                    return;
                }

                foreach (var kvp in data.Items)
                {
                    _cache[kvp.Key] = kvp.Value;
                }
                _logger.Info($"[MDBList] Loaded {_cache.Count} entries from disk");
            }
            catch (Exception ex)
            {
                _logger.Warning($"[MDBList] Failed to load cache from disk: {ex.GetType().Name}");
            }
        }

        private void SaveToDisk()
        {
            lock (_saveLock)
            {
                _dirty = false;
                Interlocked.Exchange(ref _firstDirtyTicks, 0);

                try
                {
                    var dir = Path.GetDirectoryName(CacheFilePath);
                    if (dir != null) Directory.CreateDirectory(dir);

                    var data = new MdblistCacheDiskFormat
                    {
                        SchemaVersion = CurrentSchemaVersion,
                        Items = new Dictionary<string, MdblistCacheEntry>(_cache),
                    };

                    var tempPath = CacheFilePath + ".tmp";
                    using (var stream = File.Create(tempPath))
                    {
                        JsonSerializer.Serialize(stream, data, new JsonSerializerOptions { WriteIndented = false });
                    }
                    File.Move(tempPath, CacheFilePath, overwrite: true);

                    _logger.Info($"[MDBList] Saved {_cache.Count} entries to disk");
                }
                catch (Exception ex)
                {
                    _dirty = true; // retry on the next debounce cycle / Dispose
                    _logger.Error($"[MDBList] Failed to save cache to disk: {ex.GetType().Name}");
                }
            }
        }

        private void ScheduleDebouncedSave()
        {
            _dirty = true;
            Interlocked.CompareExchange(ref _firstDirtyTicks, DateTime.UtcNow.Ticks, 0);

            if (_disposed)
            {
                SaveToDisk();
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
                if (_dirty) SaveToDisk();
            }, null, due, Timeout.InfiniteTimeSpan);
            var old = Interlocked.Exchange(ref _debounceSaveTimer, timer);
            if (old != null && !ReferenceEquals(old, timer)) old.Dispose();

            if (_disposed)
            {
                var orphan = Interlocked.Exchange(ref _debounceSaveTimer, null);
                orphan?.Dispose();
                SaveToDisk();
            }
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
            foreach (var gate in _inFlight.Values) gate.Dispose();
        }
    }
}
