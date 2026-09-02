using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Net.Http;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Data;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers.Jellyseerr;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Globalization;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services
{
    /// <summary>
    /// Enforces each Jellyfin user's parental-rating limit on the Seerr surfaces
    /// the plugin proxies (issue #581). Seerr/TMDB list responses carry no
    /// certification, so for a *restricted* user (MaxParentalRating set, or
    /// "block unrated" enabled) every movie/series row is resolved to a parental
    /// score — TMDB's tiny release_dates / content_ratings endpoints when a TMDB
    /// key is configured, otherwise Seerr's full detail — through a user-neutral
    /// cache (default 24 h), and rows above the limit are removed. Detail
    /// endpoints answer 403 for blocked titles and request POSTs are refused, so
    /// a restricted user can't reach a hidden title through a direct link.
    ///
    /// Users without a limit pay nothing: the filter returns before any lookup.
    /// Unresolvable titles fail closed for restricted users (hidden), because
    /// exposure is the failure mode that matters here.
    ///
    /// Rating semantics mirror Jellyfin's own <c>BaseItem.IsParentalAllowed</c>
    /// (see <see cref="ParentalRatingDecision"/>); the certification is read the
    /// same way the more-info modal displays it (<see cref="SeerrCertificationExtractor"/>).
    /// Design adapted from Jellyfin-Canopy's SeerrParentalFilter (GPL-3.0), rating branch only.
    /// </summary>
    public sealed class SeerrParentalFilter
    {
        /// <summary>Outcome of <see cref="ApplyAsync"/>.</summary>
        /// <param name="Block">True when the whole response must be refused (blocked detail / sub-resource).</param>
        /// <param name="Body">The (possibly filtered) JSON body to return when not blocked.</param>
        public readonly record struct Result(bool Block, string Body);

        private const int MaxConcurrentFetches = 20;
        private static readonly JsonSerializerOptions RelaxedJson = new() { Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping };
        private const int MaxCacheEntries = 20000;
        private static readonly TimeSpan OverallBudget = TimeSpan.FromSeconds(12);
        private static readonly TimeSpan PerFetchTimeout = TimeSpan.FromSeconds(8);
        // A title whose certification could not be fetched stays "unverified"
        // (hidden for restricted users) for this long before being retried, so a
        // TMDB hiccup or a deleted title doesn't trigger a refetch on every list.
        private static readonly TimeSpan NegativeCacheTtl = TimeSpan.FromMinutes(5);

        private readonly IHttpClientFactory _httpClientFactory;
        private readonly IUserManager _userManager;
        private readonly ILocalizationManager _localization;
        private readonly IServerConfigurationManager _serverConfig;
        private readonly Logger _logger;

        /// <summary>
        /// A title's parental signature: its rating score and, when fetched from a
        /// body that carries them, its cleaned TMDB keyword and genre names.
        /// Keywords/Genres null = tag data not fetched (rating-only lookup).
        /// </summary>
        private sealed record Signature(int? Score, int? SubScore, string[]? Keywords, string[]? Genres);

        // Resolved signature per "{mediaType}:{tmdbId}:{region}" — user-neutral.
        // Unresolved = the fetch failed (negative entry, short TTL); Sig with a null
        // Score and Unresolved false = fetched fine but the title is unrated.
        private readonly ConcurrentDictionary<string, (Signature? Sig, bool Unresolved, DateTime CachedAt)> _certCache = new(StringComparer.Ordinal);

        // Coalesces concurrent fetches of the same title (tag-bearing and
        // rating-only fetches coalesce separately: a rating-only fetch in flight
        // cannot satisfy a caller with tag rules).
        private readonly ConcurrentDictionary<string, Lazy<Task<Signature?>>> _inFlight = new(StringComparer.Ordinal);

        public SeerrParentalFilter(
            IHttpClientFactory httpClientFactory,
            IUserManager userManager,
            ILocalizationManager localization,
            IServerConfigurationManager serverConfig,
            Logger logger)
        {
            _httpClientFactory = httpClientFactory;
            _userManager = userManager;
            _localization = localization;
            _serverConfig = serverConfig;
            _logger = logger;
        }

        // ── Policy ───────────────────────────────────────────────────────────

        /// <summary>A user's effective parental limit (rating limit + cleaned tag rules).</summary>
        public readonly record struct Policy(
            int? MaxScore,
            int? MaxSubScore,
            bool BlockUnratedMovies,
            bool BlockUnratedSeries,
            HashSet<string> BlockedTags,
            HashSet<string> AllowedTags)
        {
            public bool HasTagRules => (BlockedTags?.Count ?? 0) > 0 || (AllowedTags?.Count ?? 0) > 0;

            public bool IsRestricted => MaxScore.HasValue || BlockUnratedMovies || BlockUnratedSeries || HasTagRules;

            public bool BlocksUnrated(string mediaType) => mediaType == "tv" ? BlockUnratedSeries : BlockUnratedMovies;
        }

        private static bool IsEnabled()
        {
            var config = JellyfinEnhanced.Instance?.Configuration;
            return config != null && config.JellyseerrEnabled && config.JellyseerrRespectParentalRatings;
        }

        /// <summary>
        /// Resolves the caller's parental policy. Returns false when the feature is
        /// off, the user is unknown, or the user has no limit — i.e. nothing to filter.
        /// </summary>
        public bool TryGetRestrictedPolicy(string? jellyfinUserId, out Policy policy)
        {
            policy = default;
            if (!IsEnabled() || string.IsNullOrEmpty(jellyfinUserId) || !Guid.TryParse(jellyfinUserId, out var userGuid))
            {
                return false;
            }

            var user = _userManager.GetUserById(userGuid);
            if (user == null)
            {
                return false;
            }

            // Same source Jellyfin's own gate reads (BaseItem.GetBlockUnratedValue);
            // no DTO materialisation on the hot path.
            var blocked = user.GetPreferenceValues<UnratedItem>(PreferenceKind.BlockUnratedItems);
            var blockMovies = blocked.Contains(UnratedItem.Movie);
            var blockSeries = blocked.Contains(UnratedItem.Series);

            // Tag branch of the native parental controls, normalised the way core
            // normalises both sides of its comparison. The sub-toggle drops them
            // wholesale, reverting to rating-only behaviour.
            var blockedTags = new HashSet<string>(StringComparer.Ordinal);
            var allowedTags = new HashSet<string>(StringComparer.Ordinal);
            if (JellyfinEnhanced.Instance?.Configuration?.JellyseerrRespectParentalTags == true)
            {
                blockedTags = ParentalTagDecision.CleanTags(user.GetPreference(PreferenceKind.BlockedTags));
                allowedTags = ParentalTagDecision.CleanTags(user.GetPreference(PreferenceKind.AllowedTags));
            }

            policy = new Policy(user.MaxParentalRatingScore, user.MaxParentalRatingSubScore, blockMovies, blockSeries, blockedTags, allowedTags);
            return policy.IsRestricted;
        }

        private string Region()
        {
            var code = _serverConfig.Configuration.MetadataCountryCode;
            return string.IsNullOrWhiteSpace(code) ? "US" : code.Trim().ToUpperInvariant();
        }

        private static TimeSpan CacheTtl()
        {
            var minutes = JellyfinEnhanced.Instance?.Configuration?.JellyseerrParentalRatingCacheTtlMinutes ?? 1440;
            return TimeSpan.FromMinutes(Math.Max(1, minutes));
        }

        // ── Public entry points ──────────────────────────────────────────────

        /// <summary>
        /// Applies the caller's parental limit to a proxied Seerr response body.
        /// </summary>
        /// <param name="json">Upstream JSON body.</param>
        /// <param name="apiPath">Seerr API path (e.g. "/api/v1/search?query=x&amp;page=1").</param>
        /// <param name="jellyfinUserId">The calling Jellyfin user.</param>
        public async Task<Result> ApplyAsync(string json, string apiPath, string? jellyfinUserId, CancellationToken requestAborted = default)
        {
            if (string.IsNullOrEmpty(json))
            {
                return new Result(false, json);
            }

            // Classify first: paths that carry no titles cost nobody a policy lookup.
            var plan = ClassifyPath(apiPath);
            if (plan.Category == Category.None || !TryGetRestrictedPolicy(jellyfinUserId, out var policy))
            {
                return new Result(false, json);
            }

            try
            {
                switch (plan.Category)
                {
                    case Category.List:
                        // Similar / recommendations of a blocked title expose nothing of it.
                        if (plan.ParentId > 0 && plan.MediaType != null
                            && await IsTitleBlockedAsync(plan.MediaType, plan.ParentId, policy).ConfigureAwait(false))
                        {
                            return new Result(true, json);
                        }

                        return new Result(false, await FilterListAsync(json, plan, policy, requestAborted).ConfigureAwait(false));

                    case Category.Detail:
                        return new Result(IsDetailBodyBlocked(json, plan.MediaType!, policy), json);

                    case Category.SubResource:
                        return new Result(await IsTitleBlockedAsync(plan.MediaType!, plan.ParentId, policy).ConfigureAwait(false), json);

                    default:
                        return new Result(false, json);
                }
            }
            catch (OperationCanceledException) when (requestAborted.IsCancellationRequested)
            {
                throw; // the browser went away; nothing to answer
            }
            catch (Exception ex)
            {
                // Never fail open on an unexpected error for a restricted user.
                _logger.Warning($"Parental filter failed for {apiPath}: {ex.Message}");
                return plan.Category == Category.None
                    ? new Result(false, json)
                    : new Result(true, json);
            }
        }

        /// <summary>
        /// Whether a single title is blocked for the caller (request POSTs, TMDB
        /// passthrough). False for unrestricted users without any lookup.
        /// </summary>
        public async Task<bool> IsBlockedAsync(string? mediaType, int tmdbId, string? jellyfinUserId)
        {
            var type = NormalizeMediaType(mediaType);
            if (type == null || tmdbId <= 0 || !TryGetRestrictedPolicy(jellyfinUserId, out var policy))
            {
                return false;
            }

            try
            {
                return await IsTitleBlockedAsync(type, tmdbId, policy).ConfigureAwait(false);
            }
            catch (Exception ex)
            {
                _logger.Warning($"Parental filter lookup failed for {type}/{tmdbId}: {ex.Message}");
                return true;
            }
        }

        /// <summary>
        /// Recognises TMDB passthrough paths that expose a single title
        /// ("movie/123", "tv/123/season/1", ...) so the caller can gate them.
        /// </summary>
        public static bool TryParseTmdbTitlePath(string? tmdbApiPath, out string mediaType, out int tmdbId)
        {
            mediaType = string.Empty;
            tmdbId = 0;
            if (string.IsNullOrEmpty(tmdbApiPath))
            {
                return false;
            }

            var path = tmdbApiPath.TrimStart('/');
            var q = path.IndexOf('?');
            if (q >= 0)
            {
                path = path.Substring(0, q);
            }

            var parts = path.Split('/', StringSplitOptions.RemoveEmptyEntries);
            if (parts.Length < 2)
            {
                return false;
            }

            var type = NormalizeMediaType(parts[0]);
            if (type == null || !int.TryParse(parts[1], NumberStyles.Integer, CultureInfo.InvariantCulture, out tmdbId))
            {
                return false;
            }

            mediaType = type;
            return true;
        }

        /// <summary>How a restricted user may use a TMDB passthrough path.</summary>
        public enum TmdbAccess { Allow, GateTitle, Deny }

        /// <summary>
        /// Classifies a TMDB passthrough path for a restricted user: title-free
        /// lookups the client needs are allowed, single-title lookups are gated on
        /// that title, everything else (search, discover, trending, lists...) is
        /// denied because it would return titles unfiltered.
        /// </summary>
        public static TmdbAccess ClassifyTmdbPassthrough(string? tmdbApiPath, out string mediaType, out int tmdbId)
        {
            mediaType = string.Empty;
            tmdbId = 0;
            if (string.IsNullOrEmpty(tmdbApiPath))
            {
                return TmdbAccess.Deny;
            }

            var path = tmdbApiPath.TrimStart('/');
            var query = string.Empty;
            var q = path.IndexOf('?');
            if (q >= 0)
            {
                query = path.Substring(q + 1);
                path = path.Substring(0, q);
            }

            // append_to_response can smuggle whole title lists (similar,
            // recommendations, lists) into an otherwise bare detail lookup.
            if (query.Contains("append_to_response", StringComparison.OrdinalIgnoreCase))
            {
                return TmdbAccess.Deny;
            }

            var parts = path.Split('/', StringSplitOptions.RemoveEmptyEntries);
            if (parts.Length == 0)
            {
                return TmdbAccess.Deny;
            }

            var head = parts[0].ToLowerInvariant();
            if (head is "genre" or "genres" or "configuration")
            {
                return TmdbAccess.Allow; // no titles in these
            }

            // Studio / network logos: bare {head}/{id} only (company/{id}/movies is a title list).
            if (head is "company" or "network")
            {
                return parts.Length == 2 ? TmdbAccess.Allow : TmdbAccess.Deny;
            }

            if (head == "search" && parts.Length == 2 && parts[1].ToLowerInvariant() is "company" or "keyword" or "person")
            {
                return TmdbAccess.Allow;
            }

            if (TryParseTmdbTitlePath(path, out mediaType, out tmdbId))
            {
                var sub = parts.Length >= 3 ? string.Join('/', parts.Skip(2)).ToLowerInvariant() : string.Empty;

                // Watch providers and reviews carry no title metadata beyond what the
                // caller already has (and are used for library items too).
                if (sub == "watch/providers" || sub == "reviews")
                {
                    return TmdbAccess.Allow;
                }

                // The bare title and the sub-resources the client actually uses
                // (certifications, seasons, episodes) are gated on the title itself.
                if (sub.Length == 0
                    || sub == "release_dates"
                    || sub == "content_ratings"
                    || sub.StartsWith("season/", StringComparison.Ordinal))
                {
                    return TmdbAccess.GateTitle;
                }

                // similar, recommendations, lists, credits, ... return other titles.
                return TmdbAccess.Deny;
            }

            return TmdbAccess.Deny;
        }

        // ── Decisions ────────────────────────────────────────────────────────

        private bool IsAllowed(Signature? resolved, string mediaType, Policy policy)
        {
            // Could not verify -> fail closed.
            if (resolved == null)
            {
                return false;
            }

            var ratingAllowed = ParentalRatingDecision.IsAllowed(
                resolved.Score,
                resolved.SubScore,
                policy.BlocksUnrated(mediaType),
                policy.MaxScore,
                policy.MaxSubScore);
            if (!ratingAllowed)
            {
                return false;
            }

            if (!policy.HasTagRules)
            {
                return true;
            }

            // Tag branch. A missing tag set under active tag rules means the title
            // could not be verified -> fail closed, like the rating path.
            if (resolved.Keywords == null || resolved.Genres == null)
            {
                return false;
            }

            return ParentalTagDecision.IsAllowed(resolved.Keywords, resolved.Genres, policy.BlockedTags, policy.AllowedTags);
        }

        private bool IsDetailBodyBlocked(string json, string mediaType, Policy policy)
        {
            JsonElement detail;
            try
            {
                using var doc = JsonDocument.Parse(json);
                detail = doc.RootElement.Clone();
            }
            catch (JsonException)
            {
                return true;
            }

            if (detail.ValueKind != JsonValueKind.Object)
            {
                return true;
            }

            if (detail.TryGetProperty("adult", out var adult) && adult.ValueKind == JsonValueKind.True)
            {
                return true;
            }

            // The detail body already carries the certification: score it directly
            // and seed the cache so list rows for this title need no fetch.
            var region = Region();
            // Seerr detail bodies carry certification AND keywords/genres.
            var resolved = SignatureFromDetail(detail, mediaType, region, includeTags: true);
            if (detail.TryGetProperty("id", out var idEl) && idEl.ValueKind == JsonValueKind.Number && idEl.TryGetInt32(out var tmdbId))
            {
                _certCache[CacheKey(mediaType, tmdbId, region)] = (resolved, false, DateTime.UtcNow);
            }

            return !IsAllowed(resolved, mediaType, policy);
        }

        private async Task<bool> IsTitleBlockedAsync(string mediaType, int tmdbId, Policy policy)
        {
            if (tmdbId <= 0)
            {
                return true;
            }

            using var cts = new CancellationTokenSource(OverallBudget);
            var resolved = await GetSignatureAsync(mediaType, tmdbId, Region(), policy.HasTagRules, cts.Token).ConfigureAwait(false);
            return !IsAllowed(resolved, mediaType, policy);
        }

        // ── List filtering ───────────────────────────────────────────────────

        private async Task<string> FilterListAsync(string json, EndpointPlan plan, Policy policy, CancellationToken requestAborted)
        {
            if (JsonNode.Parse(json) is not JsonObject root)
            {
                return json;
            }

            var arrays = CollectArrays(root, plan).ToList();
            if (arrays.Count == 0)
            {
                return json;
            }

            var region = Region();
            var scores = await ResolveScoresAsync(arrays, plan, region, policy.HasTagRules, requestAborted).ConfigureAwait(false);

            var removed = 0;
            foreach (var array in arrays)
            {
                for (var i = array.Count - 1; i >= 0; i--)
                {
                    if (array[i] is not JsonObject row)
                    {
                        continue;
                    }

                    var item = ResolveItemObject(row, plan);
                    if (item == null)
                    {
                        continue; // nothing to evaluate (e.g. a request row without media) -> nothing to leak
                    }

                    if (!ShouldKeep(item, plan, policy, region, scores))
                    {
                        array.RemoveAt(i);
                        removed++;
                        continue;
                    }

                    // Person rows embed a `knownFor` list of titles that must be filtered too.
                    FilterKnownFor(row, policy, region, scores);
                }
            }

            if (removed == 0)
            {
                return json; // nothing changed: hand back the upstream bytes untouched
            }

            _logger.Debug($"Parental filter removed {removed} item(s) from {plan.Container} response.");
            return root.ToJsonString(RelaxedJson);
        }

        private async Task<Dictionary<string, Signature?>> ResolveScoresAsync(
            IReadOnlyList<JsonArray> arrays,
            EndpointPlan plan,
            string region,
            bool needTags,
            CancellationToken requestAborted)
        {
            var keys = new Dictionary<string, (string MediaType, int TmdbId)>(StringComparer.Ordinal);
            foreach (var array in arrays)
            {
                foreach (var node in array)
                {
                    if (node is not JsonObject row)
                    {
                        continue;
                    }

                    var item = ResolveItemObject(row, plan);
                    if (item != null && !IsAdult(item))
                    {
                        var mediaType = ResolveMediaType(item, plan);
                        if (mediaType != null && TryGetTmdbId(item, plan.IdField, out var tmdbId))
                        {
                            keys[CacheKey(mediaType, tmdbId, region)] = (mediaType, tmdbId);
                        }
                    }

                    if (row["knownFor"] is JsonArray knownFor)
                    {
                        foreach (var kf in knownFor)
                        {
                            if (kf is not JsonObject entry || IsAdult(entry))
                            {
                                continue;
                            }

                            var kfType = NormalizeMediaType(ReadString(entry, "mediaType"));
                            if (kfType != null && TryGetTmdbId(entry, "id", out var kfId))
                            {
                                keys[CacheKey(kfType, kfId, region)] = (kfType, kfId);
                            }
                        }
                    }
                }
            }

            var scores = new Dictionary<string, Signature?>(StringComparer.Ordinal);
            if (keys.Count == 0)
            {
                return scores;
            }

            // Budget for this response; also stops waiting when the browser aborts
            // the request (superseded typeahead search). The fetches themselves are
            // NOT cancelled by the budget: rows still queued when the caller gives
            // up keep resolving in the background and warm the cache, so a big
            // list (500 requests, a prolific actor) is complete on the next load
            // instead of restarting cold every time.
            using var cts = CancellationTokenSource.CreateLinkedTokenSource(requestAborted);
            cts.CancelAfter(OverallBudget);
            var throttle = new SemaphoreSlim(MaxConcurrentFetches);

            var tasks = keys.Select(async kvp =>
            {
                await throttle.WaitAsync().ConfigureAwait(false);
                try
                {
                    var score = await GetSignatureAsync(kvp.Value.MediaType, kvp.Value.TmdbId, region, needTags, CancellationToken.None).ConfigureAwait(false);
                    return (kvp.Key, score);
                }
                finally
                {
                    throttle.Release();
                }
            }).ToList();

            try
            {
                await Task.WhenAll(tasks).WaitAsync(cts.Token).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (!requestAborted.IsCancellationRequested)
            {
                // Over budget: keep what finished, hide the rest (fail closed); the
                // remaining tasks continue and populate the cache.
                _logger.Debug($"Parental filter: {tasks.Count(t => !t.IsCompleted)} of {tasks.Count} title lookups still pending after {OverallBudget.TotalSeconds:0}s; hiding them for this response.");
            }

            foreach (var task in tasks)
            {
                if (task.IsCompletedSuccessfully)
                {
                    var (key, score) = task.Result;
                    scores[key] = score;
                }
            }

            requestAborted.ThrowIfCancellationRequested();
            return scores;
        }

        private bool ShouldKeep(
            JsonObject item,
            EndpointPlan plan,
            Policy policy,
            string region,
            IReadOnlyDictionary<string, Signature?> scores)
        {
            var mediaType = ResolveMediaType(item, plan);
            if (mediaType == null)
            {
                return true; // persons, collections — never rating-gated
            }

            if (IsAdult(item))
            {
                return false;
            }

            if (!TryGetTmdbId(item, plan.IdField, out var tmdbId))
            {
                return false; // unidentifiable movie/tv row cannot be verified
            }

            scores.TryGetValue(CacheKey(mediaType, tmdbId, region), out var score);
            return IsAllowed(score, mediaType, policy);
        }

        private void FilterKnownFor(
            JsonObject row,
            Policy policy,
            string region,
            IReadOnlyDictionary<string, Signature?> scores)
        {
            if (row["knownFor"] is not JsonArray knownFor)
            {
                return;
            }

            for (var j = knownFor.Count - 1; j >= 0; j--)
            {
                if (knownFor[j] is not JsonObject entry)
                {
                    continue;
                }

                var mediaType = NormalizeMediaType(ReadString(entry, "mediaType"));
                if (mediaType == null)
                {
                    continue;
                }

                if (IsAdult(entry) || !TryGetTmdbId(entry, "id", out var tmdbId))
                {
                    knownFor.RemoveAt(j);
                    continue;
                }

                scores.TryGetValue(CacheKey(mediaType, tmdbId, region), out var score);
                if (!IsAllowed(score, mediaType, policy))
                {
                    knownFor.RemoveAt(j);
                }
            }
        }

        // ── Score resolution (cache -> in-flight -> fetch) ───────────────────

        private async Task<Signature?> GetSignatureAsync(string mediaType, int tmdbId, string region, bool needTags, CancellationToken ct)
        {
            var key = CacheKey(mediaType, tmdbId, region);
            if (_certCache.TryGetValue(key, out var cached))
            {
                var age = DateTime.UtcNow - cached.CachedAt;
                if (cached.Unresolved)
                {
                    if (age < NegativeCacheTtl)
                    {
                        return null; // recently failed to verify -> still hidden, no refetch
                    }
                }
                else if (age < CacheTtl() && (!needTags || cached.Sig?.Keywords != null))
                {
                    // A rating-only entry can't satisfy a tag-rule caller; fall through to fetch.
                    return cached.Sig;
                }
            }

            // Coalesce concurrent fetches. The shared task carries its own timeout;
            // each caller bounds only its own wait, so one request's budget can't
            // cancel a fetch another request depends on.
            var inFlightKey = needTags ? key + "|tags" : key;
            var lazy = _inFlight.GetOrAdd(inFlightKey, _ => new Lazy<Task<Signature?>>(
                () => FetchAndCacheAsync(inFlightKey, key, mediaType, tmdbId, region, needTags),
                LazyThreadSafetyMode.ExecutionAndPublication));

            try
            {
                return await lazy.Value.WaitAsync(ct).ConfigureAwait(false);
            }
            catch (Exception)
            {
                return null; // over budget or fetch faulted -> cannot verify -> fail closed
            }
        }

        private async Task<Signature?> FetchAndCacheAsync(string inFlightKey, string key, string mediaType, int tmdbId, string region, bool needTags)
        {
            try
            {
                JsonElement? detail = null;
                var hasTagData = false;
                try
                {
                    using var cts = new CancellationTokenSource(PerFetchTimeout);
                    (detail, hasTagData) = await FetchDetailAsync(mediaType, tmdbId, needTags, cts.Token).ConfigureAwait(false);
                }
                catch (Exception ex)
                {
                    // Timeouts and transport faults count as "could not verify" too.
                    _logger.Debug($"Parental filter: lookup failed for {mediaType}/{tmdbId}: {ex.Message}");
                }

                var now = DateTime.UtcNow;
                var ttl = CacheTtl();
                if (detail == null)
                {
                    // Negative entry (retried after NegativeCacheTtl) — unless a fresh
                    // positive entry exists, which a failed *tag* upgrade must not erase:
                    // rating-only users would otherwise lose a title Seerr merely
                    // failed to answer for a moment.
                    _certCache.AddOrUpdate(
                        key,
                        _ => (null, true, now),
                        (_, current) => !current.Unresolved && current.Sig != null && now - current.CachedAt < ttl
                            ? current
                            : (null, true, now));
                    TrimCache();
                    return null;
                }

                var resolved = SignatureFromDetail(detail.Value, mediaType, region, includeTags: hasTagData);
                // A rating-only refresh must not erase tags a concurrent full fetch
                // just cached — but must not resurrect EXPIRED tags either (that
                // would extend them another TTL and let an upstream keyword change
                // bypass a tag-restricted user). Keep existing tags only while the
                // existing entry is itself still fresh.
                _certCache.AddOrUpdate(
                    key,
                    _ => (resolved, false, now),
                    (_, current) =>
                    {
                        if (resolved.Keywords == null && current.Sig?.Keywords != null && !current.Unresolved && now - current.CachedAt < ttl)
                        {
                            return (resolved with { Keywords = current.Sig.Keywords, Genres = current.Sig.Genres }, false, now);
                        }

                        return (resolved, false, now);
                    });
                TrimCache();
                return resolved;
            }
            finally
            {
                _inFlight.TryRemove(inFlightKey, out _);
            }
        }

        private int _trimCounter;

        private void TrimCache()
        {
            // Cheap amortised maintenance: every 500 inserts drop expired entries,
            // and if the cache is still over its hard cap evict the oldest quarter.
            if (Interlocked.Increment(ref _trimCounter) % 500 != 0 && _certCache.Count < MaxCacheEntries)
            {
                return;
            }

            var now = DateTime.UtcNow;
            var ttl = CacheTtl();
            foreach (var kv in _certCache)
            {
                var limit = kv.Value.Unresolved ? NegativeCacheTtl : ttl;
                if (now - kv.Value.CachedAt > limit)
                {
                    _certCache.TryRemove(kv.Key, out _);
                }
            }

            if (_certCache.Count >= MaxCacheEntries)
            {
                foreach (var kv in _certCache.OrderBy(kv => kv.Value.CachedAt).Take(MaxCacheEntries / 4).ToList())
                {
                    _certCache.TryRemove(kv.Key, out _);
                }
            }
        }

        private Signature SignatureFromDetail(JsonElement detail, string mediaType, string region, bool includeTags)
        {
            string[]? keywords = null;
            string[]? genres = null;
            if (includeTags)
            {
                var extracted = SeerrTagSignatureExtractor.Extract(detail);
                keywords = extracted.Keywords.ToArray();
                genres = extracted.Genres.ToArray();
            }

            var cert = SeerrCertificationExtractor.Extract(detail, mediaType, region);
            if (string.IsNullOrWhiteSpace(cert.Certification))
            {
                return new Signature(null, null, keywords, genres); // known-unrated
            }

            try
            {
                var score = _localization.GetRatingScore(cert.Certification, cert.Iso ?? region);
                return score == null
                    ? new Signature(null, null, keywords, genres)
                    : new Signature(score.Score, score.SubScore, keywords, genres);
            }
            catch (Exception ex)
            {
                _logger.Debug($"Parental filter: could not score certification '{cert.Certification}' ({cert.Iso}): {ex.Message}");
                return new Signature(null, null, keywords, genres);
            }
        }

        // Rating-only lookups prefer TMDB's dedicated cert endpoints (tiny payload)
        // when a TMDB key is set and fall back to Seerr's full detail. When tag
        // rules are active the Seerr full detail is required: it is the one body
        // carrying certifications AND keywords/genres. Certification and keyword
        // data don't vary per user, so X-Api-User is deliberately omitted — that
        // is what keeps the cache shareable. Returns whether the body carries tags.
        private async Task<(JsonElement? Detail, bool HasTagData)> FetchDetailAsync(string mediaType, int tmdbId, bool needTags, CancellationToken ct)
        {
            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config == null)
            {
                return (null, false);
            }

            if (!needTags && !string.IsNullOrEmpty(config.TMDB_API_KEY))
            {
                var fromTmdb = await FetchCertFromTmdbAsync(mediaType, tmdbId, config.TMDB_API_KEY, ct).ConfigureAwait(false);
                if (fromTmdb != null)
                {
                    return (fromTmdb, false);
                }
            }

            var fromSeerr = await FetchDetailFromSeerrAsync(mediaType, tmdbId, config, ct).ConfigureAwait(false);
            return (fromSeerr, fromSeerr != null);
        }

        private async Task<JsonElement?> FetchCertFromTmdbAsync(string mediaType, int tmdbId, string apiKey, CancellationToken ct)
        {
            var subResource = mediaType == "tv" ? "content_ratings" : "release_dates";
            var requestUri = $"https://api.themoviedb.org/3/{mediaType}/{tmdbId.ToString(CultureInfo.InvariantCulture)}/{subResource}?api_key={apiKey}";
            try
            {
                var httpClient = _httpClientFactory.CreateClient();
                httpClient.Timeout = PerFetchTimeout;
                using var response = await httpClient.GetAsync(requestUri, ct).ConfigureAwait(false);
                if (!response.IsSuccessStatusCode)
                {
                    return null;
                }

                var body = await response.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
                if (string.IsNullOrEmpty(body))
                {
                    return null;
                }

                using var parsed = JsonDocument.Parse(body);
                return parsed.RootElement.Clone();
            }
            catch (OperationCanceledException)
            {
                throw;
            }
            catch (Exception ex)
            {
                _logger.Debug($"Parental filter: TMDB certification fetch failed for {mediaType}/{tmdbId}: {ex.Message}");
                return null;
            }
        }

        private async Task<JsonElement?> FetchDetailFromSeerrAsync(string mediaType, int tmdbId, Configuration.PluginConfiguration config, CancellationToken ct)
        {
            if (string.IsNullOrEmpty(config.JellyseerrUrls) || string.IsNullOrEmpty(config.JellyseerrApiKey))
            {
                return null;
            }

            var relative = $"/api/v1/{mediaType}/{tmdbId.ToString(CultureInfo.InvariantCulture)}";
            var httpClient = SeerrHttpHelper.CreateClient(_httpClientFactory);
            httpClient.Timeout = PerFetchTimeout;

            foreach (var url in config.JellyseerrUrls.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries))
            {
                var requestUri = $"{url.Trim().TrimEnd('/')}{relative}";
                try
                {
                    using var request = SeerrHttpHelper.BuildRequest(HttpMethod.Get, requestUri, config.JellyseerrApiKey);
                    using var response = await httpClient.SendAsync(request, ct).ConfigureAwait(false);
                    var (body, error) = await SeerrHttpHelper.ReadResponseAsync(response, requestUri, ct).ConfigureAwait(false);
                    if (error != null || string.IsNullOrEmpty(body))
                    {
                        continue;
                    }

                    using var parsed = JsonDocument.Parse(body);
                    return parsed.RootElement.Clone();
                }
                catch (OperationCanceledException)
                {
                    throw;
                }
                catch (Exception ex)
                {
                    _logger.Debug($"Parental filter: Seerr detail fetch failed for {mediaType}/{tmdbId} at {url}: {ex.Message}");
                }
            }

            return null;
        }

        // ── Endpoint classification ──────────────────────────────────────────

        private enum Category { None, List, Detail, SubResource }

        private enum Container { None, Results, Parts, CombinedCredits }

        private sealed class EndpointPlan
        {
            public Category Category { get; init; }
            public Container Container { get; init; }
            public string IdField { get; init; } = "id";
            public string? MediaTypeHint { get; init; }
            public bool NestedMedia { get; init; }
            public string? MediaType { get; init; }
            public int ParentId { get; init; }
        }

        private static EndpointPlan ClassifyPath(string apiPath)
        {
            if (string.IsNullOrEmpty(apiPath))
            {
                return new EndpointPlan { Category = Category.None };
            }

            // Requests / issues lists: results[] with tmdbId/mediaType nested under `media`.
            if (apiPath.StartsWith("/api/v1/request", StringComparison.OrdinalIgnoreCase)
                || apiPath.StartsWith("/api/v1/issue?", StringComparison.OrdinalIgnoreCase)
                || string.Equals(apiPath, "/api/v1/issue", StringComparison.OrdinalIgnoreCase))
            {
                return new EndpointPlan { Category = Category.List, Container = Container.Results, IdField = "tmdbId", NestedMedia = true };
            }

            // Watchlist entries: results[] with a flat `tmdbId`.
            if (apiPath.StartsWith("/api/v1/discover/watchlist", StringComparison.OrdinalIgnoreCase))
            {
                return new EndpointPlan { Category = Category.List, Container = Container.Results, IdField = "tmdbId" };
            }

            // Genre sliders carry no titles.
            if (apiPath.StartsWith("/api/v1/discover/genreslider", StringComparison.OrdinalIgnoreCase))
            {
                return new EndpointPlan { Category = Category.None };
            }

            // Trending: mixed rows with their own mediaType.
            if (apiPath.StartsWith("/api/v1/discover/trending", StringComparison.OrdinalIgnoreCase))
            {
                return new EndpointPlan { Category = Category.List, Container = Container.Results };
            }

            if (apiPath.StartsWith("/api/v1/discover/movies", StringComparison.OrdinalIgnoreCase))
            {
                return new EndpointPlan { Category = Category.List, Container = Container.Results, MediaTypeHint = "movie" };
            }

            if (apiPath.StartsWith("/api/v1/discover/tv", StringComparison.OrdinalIgnoreCase))
            {
                return new EndpointPlan { Category = Category.List, Container = Container.Results, MediaTypeHint = "tv" };
            }

            var related = apiPath.Contains("/similar", StringComparison.OrdinalIgnoreCase)
                || apiPath.Contains("/recommendations", StringComparison.OrdinalIgnoreCase);

            if (apiPath.StartsWith("/api/v1/movie/", StringComparison.OrdinalIgnoreCase))
            {
                if (related)
                {
                    TryParseId(apiPath, "/api/v1/movie/", out var relatedMovieId);
                    return new EndpointPlan { Category = Category.List, Container = Container.Results, MediaTypeHint = "movie", MediaType = "movie", ParentId = relatedMovieId };
                }

                if (IsBareDetail(apiPath, "/api/v1/movie/"))
                {
                    return new EndpointPlan { Category = Category.Detail, MediaType = "movie" };
                }

                // Any other sub-resource (ratings, watch providers, ...): gate on the parent title.
                return TryParseId(apiPath, "/api/v1/movie/", out var movieId)
                    ? new EndpointPlan { Category = Category.SubResource, MediaType = "movie", ParentId = movieId }
                    : new EndpointPlan { Category = Category.None };
            }

            if (apiPath.StartsWith("/api/v1/tv/", StringComparison.OrdinalIgnoreCase))
            {
                if (related)
                {
                    TryParseId(apiPath, "/api/v1/tv/", out var relatedTvId);
                    return new EndpointPlan { Category = Category.List, Container = Container.Results, MediaTypeHint = "tv", MediaType = "tv", ParentId = relatedTvId };
                }

                if (IsBareDetail(apiPath, "/api/v1/tv/"))
                {
                    return new EndpointPlan { Category = Category.Detail, MediaType = "tv" };
                }

                // Seasons, ratings, ...: gate on the parent show.
                return TryParseId(apiPath, "/api/v1/tv/", out var tvId)
                    ? new EndpointPlan { Category = Category.SubResource, MediaType = "tv", ParentId = tvId }
                    : new EndpointPlan { Category = Category.None };
            }

            // Person filmography: cast[] + crew[] with per-item mediaType.
            if (apiPath.StartsWith("/api/v1/person/", StringComparison.OrdinalIgnoreCase)
                && apiPath.Contains("/combined_credits", StringComparison.OrdinalIgnoreCase))
            {
                return new EndpointPlan { Category = Category.List, Container = Container.CombinedCredits };
            }

            // Collection parts: parts[] (all movies).
            if (apiPath.StartsWith("/api/v1/collection/", StringComparison.OrdinalIgnoreCase))
            {
                return new EndpointPlan { Category = Category.List, Container = Container.Parts, MediaTypeHint = "movie" };
            }

            // Multi-search: results[] with per-item mediaType (not /search/keyword).
            if ((apiPath.StartsWith("/api/v1/search?", StringComparison.OrdinalIgnoreCase)
                    || string.Equals(apiPath, "/api/v1/search", StringComparison.OrdinalIgnoreCase))
                && !apiPath.StartsWith("/api/v1/search/keyword", StringComparison.OrdinalIgnoreCase))
            {
                return new EndpointPlan { Category = Category.List, Container = Container.Results };
            }

            return new EndpointPlan { Category = Category.None };
        }

        // True for /api/v1/{type}/{id} with no further path segment (query allowed).
        private static bool IsBareDetail(string apiPath, string prefix)
        {
            var tail = apiPath.Substring(prefix.Length);
            var q = tail.IndexOf('?');
            if (q >= 0)
            {
                tail = tail.Substring(0, q);
            }

            return tail.Length > 0 && !tail.Contains('/');
        }

        private static bool TryParseId(string apiPath, string prefix, out int id)
        {
            id = 0;
            var tail = apiPath.Substring(prefix.Length);
            var slash = tail.IndexOf('/');
            var idPart = slash >= 0 ? tail.Substring(0, slash) : tail;
            var q = idPart.IndexOf('?');
            if (q >= 0)
            {
                idPart = idPart.Substring(0, q);
            }

            return int.TryParse(idPart, NumberStyles.Integer, CultureInfo.InvariantCulture, out id);
        }

        private static IEnumerable<JsonArray> CollectArrays(JsonObject root, EndpointPlan plan)
        {
            switch (plan.Container)
            {
                case Container.Results:
                    if (root["results"] is JsonArray results)
                    {
                        yield return results;
                    }

                    break;
                case Container.Parts:
                    if (root["parts"] is JsonArray parts)
                    {
                        yield return parts;
                    }

                    break;
                case Container.CombinedCredits:
                    if (root["cast"] is JsonArray cast)
                    {
                        yield return cast;
                    }

                    if (root["crew"] is JsonArray crew)
                    {
                        yield return crew;
                    }

                    break;
            }
        }

        // ── Item readers ─────────────────────────────────────────────────────

        private static JsonObject? ResolveItemObject(JsonObject row, EndpointPlan plan)
            => plan.NestedMedia ? row["media"] as JsonObject : row;

        private static string? ResolveMediaType(JsonObject item, EndpointPlan plan)
            => NormalizeMediaType(ReadString(item, "mediaType") ?? plan.MediaTypeHint);

        private static string? NormalizeMediaType(string? raw)
        {
            if (string.Equals(raw, "movie", StringComparison.OrdinalIgnoreCase))
            {
                return "movie";
            }

            if (string.Equals(raw, "tv", StringComparison.OrdinalIgnoreCase))
            {
                return "tv";
            }

            return null;
        }

        private static string? ReadString(JsonObject item, string property)
        {
            var node = item[property];
            return node?.GetValueKind() == JsonValueKind.String ? node.GetValue<string>() : null;
        }

        private static bool IsAdult(JsonObject item)
        {
            try
            {
                return item["adult"]?.GetValueKind() == JsonValueKind.True;
            }
            catch (Exception)
            {
                return false;
            }
        }

        private static bool TryGetTmdbId(JsonObject item, string idField, out int tmdbId)
        {
            tmdbId = 0;
            var node = item[idField];
            if (node == null)
            {
                return false;
            }

            try
            {
                switch (node.GetValueKind())
                {
                    case JsonValueKind.Number:
                        tmdbId = node.GetValue<int>();
                        return true;
                    case JsonValueKind.String:
                        return int.TryParse(node.GetValue<string>(), NumberStyles.Integer, CultureInfo.InvariantCulture, out tmdbId);
                    default:
                        return false;
                }
            }
            catch (Exception)
            {
                return false;
            }
        }

        private static string CacheKey(string mediaType, int tmdbId, string region)
            => $"{mediaType}:{tmdbId.ToString(CultureInfo.InvariantCulture)}:{region}";
    }
}
