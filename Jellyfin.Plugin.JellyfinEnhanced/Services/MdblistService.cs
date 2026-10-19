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
using Jellyfin.Plugin.JellyfinEnhanced.Model;
using MediaBrowser.Common.Configuration;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services
{
    /// <summary>
    /// Looks up ratings (TMDB score, Rotten Tomatoes critic/audience, IMDb,
    /// Trakt, Metacritic, etc.) for a title by TMDB id from the MDBList API,
    /// and caches the result to disk. The admin's MDBList API key never
    /// leaves the server; clients only ever see the parsed rating entries
    /// via JellyfinEnhancedController's proxy endpoint.
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
        private const int CurrentSchemaVersion = 1;

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
        // MDBList's own answer as held (RateLimitRemaining as MDBList reported it; never changed afterwards).
        private MdblistAccountStatus? _accountStatus;
        // Review round 3 (4c2-R3-2): one status refresh at a time. Review round 5 (4c2-R5-1): what JE may still spend is
        // MDBList's count minus every reservation it can't have counted yet: those still OUTSTANDING (reserved, their
        // request not finished: whenever they were made, so a refresh that overtakes one never gives it back) and those
        // finished after the held answer was asked for. A reservation finished before a status read was asked for is in
        // that read's count. Guarded by _accountStatusLock.
        private readonly SemaphoreSlim _statusRefresh = new(1, 1);
        private int _outstanding;
        private long _finished;
        private long _heldFinished = -1;

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
                _cache[key] = fetched;
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
            var age = DateTimeOffset.UtcNow - DateTimeOffset.FromUnixTimeMilliseconds(entry.FetchedAtUnixMs);
            if (entry.Found) return age > PositiveTtl;
            return age > (entry.Confirmed ? NegativeTtl : RetryTtl);
        }

        /// <summary>Cache-only read, no network call: whatever's currently on disk/in
        /// memory for this title, or null if it's never been fetched at all. Used by
        /// MdblistRatingsSyncTask, which only ever writes Jellyfin's own
        /// CommunityRating/CriticRating from whatever MdblistRatingsFetchTask has
        /// already populated; it never calls MDBList itself.</summary>
        public MdblistCacheEntry? GetCachedEntry(string mediaType, string tmdbId) =>
            _cache.TryGetValue(CacheKey(mediaType, tmdbId), out var entry) ? entry : null;

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
                return _accountStatus == null ? null : SpendableLocked();
            }
        }

        /// <summary>
        /// Phase 4c2 (list sources): charges one API request of an administrator's deliberate MDBList list read to the
        /// same quota bookkeeping the ratings fetches use, so the two never starve each other. False when the remaining
        /// quota is at the <see cref="SafetyMargin"/>; an unknown status fails open like the ratings path. A status that
        /// isn't fresh is read with <paramref name="readStatus"/>, the list-source fetcher's own transmission gate (review
        /// round 2, 4C2-R2-SEC-01): this path never reaches this service's unnamed client, and a refused status read (a
        /// redirect, a private address, the switch turned off) propagates as the caller's typed failure.
        /// </summary>
        /// <param name="readStatus">Reads the account status (MDBList's /user) through the caller's transport.</param>
        /// <param name="cancellationToken">Cancellation.</param>
        /// <returns>The reservation, to dispose once the request has finished (answered, failed or not sent); null when
        /// none is left to spend.</returns>
        public Task<IDisposable?> TryReserveListRequestAsync(Func<CancellationToken, Task<MdblistAccountStatus?>> readStatus, CancellationToken cancellationToken)
        {
            ArgumentNullException.ThrowIfNull(readStatus);
            return ReserveAsync(readStatus, SafetyMargin, cancellationToken);
        }

        // THE reservation of the quota (review round 4, 4c2-R4-1; D53 rule 1 over every request that spends it): list reads,
        // ratings lookups and media batches each take one request here BEFORE they send, checked against the balance as
        // it is now and charged in the same step, so two spenders can never both pass a check the first one's charge
        // would have failed. The reservation stays OUTSTANDING until its request finishes (review round 5, 4c2-R5-1: a
        // status refresh never gives it back, whenever it was made); a request refused or failed after its reservation
        // stays charged (the safe side) until a status read asked after it finished. A status that isn't fresh is read
        // first by `readStatus` (one refresh at a time); an unknown status fails open.
        private async Task<IDisposable?> ReserveAsync(Func<CancellationToken, Task<MdblistAccountStatus?>> readStatus, int floor, CancellationToken cancellationToken)
        {
            if (FreshStatus() == null)
            {
                // Single flight: one refresh at a time; a caller that waited takes the status the refresh before it read.
                await _statusRefresh.WaitAsync(cancellationToken).ConfigureAwait(false);
                try
                {
                    if (FreshStatus() == null)
                    {
                        var askedAt = Finished();
                        if (await readStatus(cancellationToken).ConfigureAwait(false) is { } status)
                        {
                            Hold(status, askedAt);
                        }
                    }
                }
                finally
                {
                    _statusRefresh.Release();
                }
            }

            // The reservation is checked against what is spendable now and charged in the same step.
            lock (_accountStatusLock)
            {
                if (FreshLocked() != null && SpendableLocked() <= Math.Max(SafetyMargin, floor))
                {
                    return null;
                }

                _outstanding++;
                return new Reservation(this);
            }
        }

        // Reservations finished so far (the mark a status read is asked at).
        private long Finished()
        {
            lock (_accountStatusLock)
            {
                return _finished;
            }
        }

        // Holds a status read asked when `askedAt` reservations had finished (those are in its count; any finished since,
        // and every one still outstanding, may not be); a read asked before the status held never replaces it.
        private void Hold(MdblistAccountStatus status, long askedAt)
        {
            lock (_accountStatusLock)
            {
                if (askedAt < _heldFinished)
                {
                    return;
                }

                _accountStatus = status;
                _heldFinished = askedAt;
            }
        }

        // What may still be spent: MDBList's held count minus every reservation it can't have counted (caller holds
        // _accountStatusLock; _accountStatus is set).
        private int SpendableLocked()
        {
            return (int)Math.Max(0, _accountStatus!.RateLimitRemaining - _outstanding - (_finished - _heldFinished));
        }

        // A reservation's request finished (answered, failed or never sent): no longer outstanding, still charged until a
        // status read asked after now.
        private void Finish()
        {
            lock (_accountStatusLock)
            {
                _outstanding--;
                _finished++;
            }
        }

        // The status as callers see it: MDBList's answer with what JE may still spend as its remaining count.
        private MdblistAccountStatus? ViewLocked(MdblistAccountStatus? status) => status == null ? null : new MdblistAccountStatus
        {
            Plan = status.Plan,
            IsSupporter = status.IsSupporter,
            RateLimit = status.RateLimit,
            RateLimitRemaining = SpendableLocked(),
            RateLimitResetUnixSeconds = status.RateLimitResetUnixSeconds,
            FetchedAtUnixMs = status.FetchedAtUnixMs,
        };

        // One request of the quota, reserved until its request finishes (disposed once, by the code that sent it).
        private sealed class Reservation(MdblistService owner) : IDisposable
        {
            private int _done;

            public void Dispose()
            {
                if (Interlocked.Exchange(ref _done, 1) == 0)
                {
                    owner.Finish();
                }
            }
        }

        // The cached account status while it is fresh (as callers see it), else null.
        private MdblistAccountStatus? FreshStatus()
        {
            lock (_accountStatusLock)
            {
                return ViewLocked(FreshLocked());
            }
        }

        private MdblistAccountStatus? FreshLocked() =>
            _accountStatus != null && DateTimeOffset.UtcNow - DateTimeOffset.FromUnixTimeMilliseconds(_accountStatus.FetchedAtUnixMs) < AccountStatusTtl
                ? _accountStatus
                : null;

        /// <summary>Reads MDBList's GET /user answer (plan, daily limit, remaining requests, reset time).</summary>
        /// <param name="json">The answer.</param>
        /// <returns>The status, or null when it isn't an account status.</returns>
        public static MdblistAccountStatus? ParseAccountStatus(string json)
        {
            try
            {
                using var doc = JsonDocument.Parse(json);
                return doc.RootElement.ValueKind == JsonValueKind.Object ? StatusOf(doc.RootElement) : null;
            }
            catch (JsonException)
            {
                return null;
            }
        }

        private static MdblistAccountStatus StatusOf(JsonElement root) => new()
        {
            Plan = root.TryGetProperty("plan", out var planEl) && planEl.ValueKind == JsonValueKind.String ? (planEl.GetString() ?? string.Empty) : string.Empty,
            IsSupporter = root.TryGetProperty("is_supporter", out var supEl) && supEl.ValueKind == JsonValueKind.True,
            RateLimit = GetNullableInt(root, "rate_limit") ?? 0,
            RateLimitRemaining = GetNullableInt(root, "rate_limit_remaining") ?? 0,
            RateLimitResetUnixSeconds = GetNullableLong(root, "rate_limit_reset") ?? 0,
            FetchedAtUnixMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
        };

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
        public async Task<MdblistAccountStatus?> GetAccountStatusAsync(CancellationToken cancellationToken, bool forceRefresh = false, string? apiKeyOverride = null)
        {
            var testingOverride = !string.IsNullOrWhiteSpace(apiKeyOverride);

            if (!forceRefresh && !testingOverride && FreshStatus() is { } fresh)
            {
                return fresh;
            }

            var apiKey = testingOverride ? apiKeyOverride : JellyfinEnhanced.Instance?.Configuration?.GetMdblistApiKey();
            if (string.IsNullOrWhiteSpace(apiKey)) return null;

            // Review round 3 (4c2-R3-2): the same single-flight refresh as the list quota's, and the answer held by Hold
            // (requests charged after it was asked for come off it; an older answer never replaces a newer one).
            var single = false;
            try
            {
                if (!testingOverride)
                {
                    await _statusRefresh.WaitAsync(cancellationToken).ConfigureAwait(false);
                    single = true;
                }

                if (single && !forceRefresh && FreshStatus() is { } landed)
                {
                    return landed;
                }

                var askedAt = Finished();
                var status = await ReadStatusAsync(apiKey, cancellationToken).ConfigureAwait(false);
                if (status == null || testingOverride)
                {
                    return status;
                }

                Hold(status, askedAt);
                lock (_accountStatusLock)
                {
                    return ViewLocked(_accountStatus);
                }
            }
            catch (Exception ex)
            {
                _logger.Warning($"[MDBList] Failed to fetch account status: {ex.Message}");
                return null;
            }
            finally
            {
                if (single)
                {
                    _statusRefresh.Release();
                }
            }
        }

        // MDBList's GET /user (doesn't count against the quota) with this service's client: the status, or null when the
        // answer isn't one. The caller holds the single-flight refresh and keeps the answer with Hold.
        private async Task<MdblistAccountStatus?> ReadStatusAsync(string apiKey, CancellationToken cancellationToken)
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
            return StatusOf(doc.RootElement);
        }

        // The ratings path's reservation: its status read is this service's own (failures are an unknown status, which
        // fails open like it always has).
        private Task<IDisposable?> ReserveRatingsRequestAsync(string apiKey, int floor, CancellationToken cancellationToken) =>
            ReserveAsync(async ct =>
            {
                try
                {
                    return await ReadStatusAsync(apiKey, ct).ConfigureAwait(false);
                }
                catch (Exception ex)
                {
                    _logger.Warning($"[MDBList] Failed to fetch account status: {ex.Message}");
                    return null;
                }
            }, floor, cancellationToken);

        private async Task<MdblistCacheEntry> FetchFromMdblistAsync(string mediaType, string tmdbId, CancellationToken cancellationToken)
        {
            var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            var apiKey = JellyfinEnhanced.Instance?.Configuration?.GetMdblistApiKey();
            if (string.IsNullOrWhiteSpace(apiKey))
            {
                return new MdblistCacheEntry { Found = false, Confirmed = false, FetchedAtUnixMs = now };
            }

            // One request of the quota is reserved before the lookup is sent (review round 4, 4c2-R4-1), so a list
            // import reserving at the same time can't spend past the margin, and stays outstanding until the lookup
            // has finished (review round 5). Fails OPEN if the account status is unknown (e.g. the one /user probe
            // itself failed); a defensive check layered on top of the real request, not a hard requirement to proceed.
            using var reservation = await ReserveRatingsRequestAsync(apiKey, SafetyMargin, cancellationToken).ConfigureAwait(false);
            if (reservation == null)
            {
                // Not a real "MDBList has no data" answer, so Confirmed=false
                // retries on the short RetryTtl instead of being trusted as a
                // negative result for NegativeTtl's much longer window.
                _logger.Warning($"[MDBList] Only {RemainingQuota()} requests remaining today, skipping lookup for {mediaType}:{tmdbId}");
                return new MdblistCacheEntry { Found = false, Confirmed = false, FetchedAtUnixMs = now };
            }

            try
            {
                var mdblistType = mediaType == "tv" ? "show" : "movie";
                var client = _httpClientFactory.CreateClient();
                client.Timeout = RequestTimeout;

                var url = $"{ApiBase}/tmdb/{mdblistType}/{tmdbId}?apikey={Uri.EscapeDataString(apiKey)}";
                using var response = await client.GetAsync(url, cancellationToken).ConfigureAwait(false);

                if (!response.IsSuccessStatusCode)
                {
                    _logger.Warning($"[MDBList] Query failed ({(int)response.StatusCode}) for {mediaType}:{tmdbId}");
                    return new MdblistCacheEntry { Found = false, Confirmed = false, FetchedAtUnixMs = now };
                }

                await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken).ConfigureAwait(false);
                using var doc = await JsonDocument.ParseAsync(stream, cancellationToken: cancellationToken).ConfigureAwait(false);

                return ParseResponse(doc, now);
            }
            catch (Exception ex)
            {
                // Network hiccup, timeout, malformed response: never let a
                // ratings lookup fail the item-details page. Cache as a
                // short-lived miss (RetryTtl, not NegativeTtl) so the same
                // title isn't retried on every view but isn't trusted as a
                // confirmed "no data" either.
                _logger.Warning($"[MDBList] Failed to fetch ratings for {mediaType}:{tmdbId}: {ex.Message}");
                return new MdblistCacheEntry { Found = false, Confirmed = false, FetchedAtUnixMs = now };
            }
        }

        /// <summary>
        /// Batch media lookup: one MDBList request resolves however many ids
        /// are passed in, by TMDB id, in the same shape ParseResponse parses
        /// for the single-item endpoint (every rating source, votes,
        /// per-source urls, and cross-provider ids). Used by
        /// MdblistRatingsFetchRunner to warm mdblist-ratings.json for both the
        /// item-details display and MdblistRatingsSyncTask's Jellyfin-field
        /// sync to read from.
        ///
        /// Returns a tmdbId to parsed entry map for whichever requested ids
        /// MDBList actually matched (an id absent from the result just has no
        /// MDBList data, not an error). Returns null on failure (bad key,
        /// network error, quota exhausted).
        /// </summary>
        /// <param name="mediaType">"movie" or "tv".</param>
        /// <param name="tmdbIds">TMDB ids.</param>
        /// <param name="cancellationToken">Cancellation.</param>
        /// <param name="reserve">Requests to keep (the scheduled fetch's reserve; never fewer than <see cref="SafetyMargin"/>).</param>
        /// <returns>The matched entries, or null.</returns>
        public async Task<Dictionary<string, MdblistCacheEntry>?> GetMediaBatchAsync(string mediaType, IReadOnlyList<string> tmdbIds, CancellationToken cancellationToken, int reserve = 0)
        {
            if (tmdbIds == null || tmdbIds.Count == 0) return new Dictionary<string, MdblistCacheEntry>();

            var apiKey = JellyfinEnhanced.Instance?.Configuration?.GetMdblistApiKey();
            if (string.IsNullOrWhiteSpace(apiKey)) return null;

            // Reserved before the batch is sent, against the larger of the margin and the caller's reserve (4c2-R4-1),
            // until the batch has finished (review round 5).
            using var reservation = await ReserveRatingsRequestAsync(apiKey, reserve, cancellationToken).ConfigureAwait(false);
            if (reservation == null)
            {
                _logger.Warning($"[MDBList] Only {RemainingQuota()} requests remaining today, skipping media batch lookup for {mediaType} ({tmdbIds.Count} ids)");
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

                var responseBody = await response.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false);

                if (!response.IsSuccessStatusCode)
                {
                    _logger.Warning($"[MDBList] Media batch query failed ({(int)response.StatusCode}) for {mediaType} ({tmdbIds.Count} ids). Body: {Truncate(responseBody, 500)}");
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
                    _logger.Warning($"[MDBList] Media batch response for {mediaType} wasn't a JSON array as expected. Body: {Truncate(responseBody, 500)}");
                }

                return result;
            }
            catch (Exception ex)
            {
                _logger.Warning($"[MDBList] Failed to fetch media batch for {mediaType} ({tmdbIds.Count} ids): {ex.Message}");
                return null;
            }
        }

        private static string Truncate(string s, int maxLength) =>
            string.IsNullOrEmpty(s) || s.Length <= maxLength ? s : s.Substring(0, maxLength) + "...";

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
                _logger.Warning($"[MDBList] Failed to load cache from disk: {ex.Message}");
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
                    _logger.Error($"[MDBList] Failed to save cache to disk: {ex.Message}");
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
            _statusRefresh.Dispose();
        }
    }
}
