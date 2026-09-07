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
        /// <param name="RetryLater">True when a paged feed could not be verified within the budget: the body is the safe partial page, but the caller should answer 504 so the client re-fetches once the pending lookups (which keep running) have landed in the cache.</param>
        public readonly record struct Result(bool Block, string Body, bool RetryLater = false);

        // TMDB's light certification endpoints answer in ~0.4-1.3 s from a cold
        // connection; 16 in flight keeps a two-feed page (40 titles) under ~2 s
        // and stays well under TMDB's ~50 req/s.
        private const int MaxConcurrentFetches = 16;
        // Re-serialised (filtered) bodies keep '<', '>' and '&' literal, as Seerr's
        // own JSON does; the default encoder would escape them to \uXXXX. Safe for
        // application/json, and it keeps filtered and unfiltered bodies alike.
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

        // One outbound fan-out limit for list responses across the whole server,
        // not per response: a handful of restricted users opening big lists must
        // not multiply it. Single-title checks (a detail page, a request POST) are
        // one coalesced lookup each and bypass it.
        private readonly SemaphoreSlim _throttle = new(MaxConcurrentFetches);

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

        // Titles whose *tag* upgrade recently failed while a good rating-only entry
        // exists: tag-rule callers get "unverified" (hidden) without re-fetching
        // until NegativeCacheTtl passes; rating-only callers are unaffected.
        private readonly ConcurrentDictionary<string, DateTime> _tagFetchFailedAt = new(StringComparer.Ordinal);

        // Coalesces concurrent fetches of the same title (tag-bearing and
        // rating-only fetches coalesce separately: a rating-only fetch in flight
        // cannot satisfy a caller with tag rules).
        private readonly ConcurrentDictionary<string, Lazy<Task<Signature?>>> _inFlight = new(StringComparer.Ordinal);

        /// <summary>Creates the filter; registered as a singleton so its caches and fetch pool are shared.</summary>
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
            /// <summary>True when the user has any Blocked or Allowed Tags (keyword lookups are then needed).</summary>
            public bool HasTagRules => (BlockedTags?.Count ?? 0) > 0 || (AllowedTags?.Count ?? 0) > 0;

            /// <summary>True when anything at all may be hidden from this user.</summary>
            public bool IsRestricted => MaxScore.HasValue || BlockUnratedMovies || BlockUnratedSeries || HasTagRules;

            /// <summary>Whether unrated titles of the given kind ("movie" / "tv") are hidden.</summary>
            public bool BlocksUnrated(string mediaType) => mediaType == "tv" ? BlockUnratedSeries : BlockUnratedMovies;
        }

        // Always on (there is no admin toggle): a user's Jellyfin parental controls
        // are the policy, and the filter does nothing for users without any. Not
        // tied to JellyseerrEnabled: the TMDB passthrough is reachable without
        // Seerr and must be gated by the same policy.
        private static bool IsEnabled() => JellyfinEnhanced.Instance?.Configuration != null;

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

            // Tag branch of the native parental controls, compared the way core
            // compares tags (raw values, case-insensitive ordinal).
            var blockedTags = ParentalTagDecision.ToTagSet(user.GetPreference(PreferenceKind.BlockedTags));
            var allowedTags = ParentalTagDecision.ToTagSet(user.GetPreference(PreferenceKind.AllowedTags));

            policy = new Policy(user.MaxParentalRatingScore, user.MaxParentalRatingSubScore, blockMovies, blockSeries, blockedTags, allowedTags);
            return policy.IsRestricted;
        }

        private string Region()
        {
            var code = _serverConfig.Configuration.MetadataCountryCode;
            return string.IsNullOrWhiteSpace(code) ? "US" : code.Trim().ToUpperInvariant();
        }

        // Certifications almost never change: a resolved rating is kept a day.
        private static TimeSpan CacheTtl() => TimeSpan.FromHours(24);

        // ── Public entry points ──────────────────────────────────────────────

        /// <summary>
        /// Applies the caller's parental limit to a proxied Seerr response body.
        /// </summary>
        /// <param name="json">Upstream JSON body.</param>
        /// <param name="apiPath">Seerr API path (e.g. "/api/v1/search?query=x&amp;page=1").</param>
        /// <param name="jellyfinUserId">The calling Jellyfin user.</param>
        /// <param name="requestAborted">Stops the lookups when the caller has gone away.</param>
        /// <returns>Whether the response must be refused, the (filtered) body, and whether the client should re-fetch it.</returns>
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
                            && await IsTitleBlockedAsync(plan.MediaType, plan.ParentId, policy, requestAborted).ConfigureAwait(false))
                        {
                            return new Result(true, json);
                        }

                        var (filtered, retryLater) = await FilterListAsync(json, plan, policy, requestAborted).ConfigureAwait(false);
                        return new Result(false, filtered, retryLater);

                    case Category.Detail:
                        return new Result(IsDetailBodyBlocked(json, plan.MediaType!, policy), json);

                    case Category.SubResource:
                        return new Result(await IsTitleBlockedAsync(plan.MediaType!, plan.ParentId, policy, requestAborted).ConfigureAwait(false), json);

                    case Category.NestedDetail:
                        // e.g. /api/v1/issue/{id}: the title sits under `media`.
                        return new Result(await IsNestedMediaBlockedAsync(json, policy, requestAborted).ConfigureAwait(false), json);

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
                return new Result(true, json);
            }
        }

        /// <summary>
        /// Whether a single title is blocked for the caller (request POSTs, TMDB
        /// passthrough). False for unrestricted users without any lookup.
        /// </summary>
        /// <param name="mediaType">"movie" or "tv" (anything else is not rating-gated).</param>
        /// <param name="tmdbId">The TMDB id of the title.</param>
        /// <param name="jellyfinUserId">The calling Jellyfin user.</param>
        /// <param name="requestAborted">Stops the lookup when the caller has gone away.</param>
        /// <returns>True when the title must be refused to this user.</returns>
        public async Task<bool> IsBlockedAsync(string? mediaType, int tmdbId, string? jellyfinUserId, CancellationToken requestAborted = default)
        {
            var type = NormalizeMediaType(mediaType);
            if (type == null || tmdbId <= 0 || !TryGetRestrictedPolicy(jellyfinUserId, out var policy))
            {
                return false;
            }

            try
            {
                return await IsTitleBlockedAsync(type, tmdbId, policy, requestAborted).ConfigureAwait(false);
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
        public enum TmdbAccess
        {
            /// <summary>Title-free lookup: forwarded as-is.</summary>
            Allow,
            /// <summary>A single title's own data: forwarded only if that title is allowed.</summary>
            GateTitle,
            /// <summary>Would return other titles unfiltered: refused.</summary>
            Deny
        }

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

            // Only plain segments: a dot-segment or anything outside [A-Za-z0-9_-]
            // could be normalised by the URI layer into a different, unclassified
            // path, so it is refused here rather than trusted to the host.
            if (parts.Any(p => !p.All(c => char.IsAsciiLetterOrDigit(c) || c is '_' or '-')))
            {
                return TmdbAccess.Deny;
            }

            var head = parts[0].ToLowerInvariant();
            if (head is "genre" or "genres" or "configuration")
            {
                return parts.Length <= 3 ? TmdbAccess.Allow : TmdbAccess.Deny; // no titles in these
            }

            // Studio / network logos: bare {head}/{id} only (company/{id}/movies is a title list).
            if (head is "company" or "network")
            {
                return parts.Length == 2 ? TmdbAccess.Allow : TmdbAccess.Deny;
            }

            // Company and keyword search return no titles. Person search does (each
            // hit carries knownFor titles); the client reaches it through the
            // explicit tmdb/search/person route, which goes via Seerr's filtered search.
            if (head == "search" && parts.Length == 2 && parts[1].ToLowerInvariant() is "company" or "keyword")
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
            // Seerr detail bodies carry certification AND (normally) keywords/genres;
            // without a keyword container the tags stay unknown rather than empty.
            var resolved = SignatureFromDetail(detail, mediaType, region, includeTags: SeerrTagSignatureExtractor.HasKeywordData(detail));
            if (detail.TryGetProperty("id", out var idEl) && idEl.ValueKind == JsonValueKind.Number && idEl.TryGetInt32(out var tmdbId))
            {
                StoreSignature(CacheKey(mediaType, tmdbId, region), resolved, DateTime.UtcNow, CacheTtl());
            }

            return !IsAllowed(resolved, mediaType, policy);
        }

        private async Task<bool> IsNestedMediaBlockedAsync(string json, Policy policy, CancellationToken requestAborted)
        {
            try
            {
                using var doc = JsonDocument.Parse(json);
                if (doc.RootElement.ValueKind != JsonValueKind.Object
                    || !doc.RootElement.TryGetProperty("media", out var media)
                    || media.ValueKind != JsonValueKind.Object)
                {
                    return false; // no title in the body -> nothing to leak
                }

                var mediaType = NormalizeMediaType(media.TryGetProperty("mediaType", out var mt) && mt.ValueKind == JsonValueKind.String ? mt.GetString() : null);
                if (mediaType == null || !media.TryGetProperty("tmdbId", out var idEl) || idEl.ValueKind != JsonValueKind.Number || !idEl.TryGetInt32(out var tmdbId))
                {
                    return true; // a title we cannot identify cannot be verified
                }

                return await IsTitleBlockedAsync(mediaType, tmdbId, policy, requestAborted).ConfigureAwait(false);
            }
            catch (JsonException)
            {
                return true;
            }
        }

        private async Task<bool> IsTitleBlockedAsync(string mediaType, int tmdbId, Policy policy, CancellationToken requestAborted = default)
        {
            if (tmdbId <= 0)
            {
                return true;
            }

            using var cts = CancellationTokenSource.CreateLinkedTokenSource(requestAborted);
            cts.CancelAfter(OverallBudget);
            var resolved = await GetSignatureAsync(mediaType, tmdbId, Region(), policy.HasTagRules, cts.Token).ConfigureAwait(false);
            return !IsAllowed(resolved, mediaType, policy);
        }

        // ── List filtering ───────────────────────────────────────────────────

        private async Task<(string Body, bool RetryLater)> FilterListAsync(string json, EndpointPlan plan, Policy policy, CancellationToken requestAborted)
        {
            if (JsonNode.Parse(json) is not JsonObject root)
            {
                return (json, false);
            }

            var arrays = CollectArrays(root, plan).ToList();
            if (arrays.Count == 0)
            {
                return (json, false);
            }

            var region = Region();
            var (scores, pending) = await ResolveScoresAsync(arrays, plan, region, policy.HasTagRules, requestAborted).ConfigureAwait(false);
            // A discover/search page whose titles could not all be verified in time
            // is not an empty page: the lookups keep running, so tell the caller to
            // have the client come back for it rather than rendering the gaps as
            // "nothing here" (the request list keeps its partial-page behaviour).
            // Person filmographies and collection parts are fetched whole and cached
            // by the client, so a partially-resolved one would stick as a complete
            // list. They get the same retry answer as a paged feed.
            var retryLater = pending > 0 && !plan.NestedMedia
                && plan.Container is Container.Results or Container.CombinedCredits or Container.Parts;

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
                    removed += FilterKnownFor(row, policy, region, scores);
                }
            }

            if (removed == 0)
            {
                return (json, retryLater); // nothing changed: hand back the upstream bytes untouched
            }

            _logger.Debug($"Parental filter removed {removed} item(s) from {plan.Container} response.");
            return (root.ToJsonString(RelaxedJson), retryLater);
        }

        private async Task<(Dictionary<string, Signature?> Scores, int Pending)> ResolveScoresAsync(
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
                return (scores, 0);
            }

            // Budget for this response; also stops waiting when the browser aborts
            // the request (superseded typeahead search). Fetches already holding a
            // slot are NOT cancelled by the budget: they finish and warm the cache.
            // Rows still QUEUED for a slot when the caller gives up are dropped:
            // the pool is shared by every request, and letting each abandoned page
            // keep its 20-100 queued lookups meant a user browsing several pages
            // pushed the page they are looking at behind everything they had left,
            // until nothing resolved within the budget at all.
            using var cts = CancellationTokenSource.CreateLinkedTokenSource(requestAborted);
            cts.CancelAfter(OverallBudget);
            var throttle = _throttle;
            var droppedFromQueue = 0;

            var tasks = keys.Select(async kvp =>
            {
                // Cache hits never occupy a slot.
                if (TryGetFreshSignature(kvp.Key, needTags, out var hit))
                {
                    return (kvp.Key, hit);
                }

                // A superseded request (typeahead) doesn't need cache warming.
                if (requestAborted.IsCancellationRequested)
                {
                    return (kvp.Key, (Signature?)null);
                }

                try
                {
                    await throttle.WaitAsync(cts.Token).ConfigureAwait(false);
                }
                catch (OperationCanceledException)
                {
                    Interlocked.Increment(ref droppedFromQueue);
                    return (kvp.Key, (Signature?)null); // never got a slot: unverified, not cached as anything
                }

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

            var whenAll = Task.WhenAll(tasks);
            // The element tasks never throw today; observe a fault anyway so an
            // abandoned WhenAll can never surface as an unobserved task exception.
            _ = whenAll.ContinueWith(t => _ = t.Exception, TaskContinuationOptions.OnlyOnFaulted | TaskContinuationOptions.ExecuteSynchronously);
            try
            {
                await whenAll.WaitAsync(cts.Token).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (!requestAborted.IsCancellationRequested)
            {
                // Over budget: keep what finished, hide the rest (fail closed); the
                // in-flight tasks continue and populate the cache, the queued ones
                // have been dropped.
            }

            // Counted after the wait rather than only in the catch: when the budget
            // fires, the queued waiters complete (as dropped) before WhenAll sees the
            // cancellation, so WhenAll can finish normally with rows never looked up.
            var pending = tasks.Count(t => !t.IsCompletedSuccessfully) + droppedFromQueue;
            if (pending > 0)
            {
                _logger.Debug($"Parental filter: {pending} of {tasks.Count} title lookups unresolved after {OverallBudget.TotalSeconds:0}s ({droppedFromQueue} never started); hiding them for this response.");
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
            return (scores, pending);
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
                // Persons and collections carry no rating of their own (a person's
                // knownFor titles are filtered below, a collection's parts when it is
                // opened). Anything else without a recognised media type cannot be
                // verified and fails closed like every other unverifiable row.
                var raw = ReadString(item, "mediaType")?.ToLowerInvariant();
                return raw is "person" or "collection";
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

        private int FilterKnownFor(
            JsonObject row,
            Policy policy,
            string region,
            IReadOnlyDictionary<string, Signature?> scores)
        {
            if (row["knownFor"] is not JsonArray knownFor)
            {
                return 0;
            }

            var removed = 0;
            for (var j = knownFor.Count - 1; j >= 0; j--)
            {
                if (knownFor[j] is not JsonObject entry)
                {
                    continue;
                }

                // knownFor holds titles only; one without a recognised media type
                // cannot be verified and is dropped like any other unverifiable row.
                var mediaType = NormalizeMediaType(ReadString(entry, "mediaType"));
                if (mediaType == null || IsAdult(entry) || !TryGetTmdbId(entry, "id", out var tmdbId))
                {
                    knownFor.RemoveAt(j);
                    removed++;
                    continue;
                }

                scores.TryGetValue(CacheKey(mediaType, tmdbId, region), out var score);
                if (!IsAllowed(score, mediaType, policy))
                {
                    knownFor.RemoveAt(j);
                    removed++;
                }
            }

            return removed;
        }

        // ── Score resolution (cache -> in-flight -> fetch) ───────────────────

        /// <summary>
        /// Answers from the cache when it can: a fresh positive entry that satisfies
        /// the caller (tag data present when tag rules are active), or a fresh
        /// negative entry (null = still unverified). False = a fetch is needed.
        /// </summary>
        private bool TryGetFreshSignature(string key, bool needTags, out Signature? signature)
        {
            signature = null;
            if (_certCache.TryGetValue(key, out var cached))
            {
                var age = DateTime.UtcNow - cached.CachedAt;
                if (cached.Unresolved)
                {
                    if (age < NegativeCacheTtl)
                    {
                        return true; // recently failed to verify -> still hidden, no refetch
                    }
                }
                else if (age < CacheTtl() && (!needTags || cached.Sig?.Keywords != null))
                {
                    // A rating-only entry can't satisfy a tag-rule caller; fall through to fetch.
                    signature = cached.Sig;
                    return true;
                }
            }

            if (needTags && _tagFetchFailedAt.TryGetValue(key, out var failedAt))
            {
                if (DateTime.UtcNow - failedAt < NegativeCacheTtl)
                {
                    return true; // tag data recently unavailable -> hidden for tag-rule users, no refetch
                }

                _tagFetchFailedAt.TryRemove(key, out _);
            }

            return false;
        }

        private async Task<Signature?> GetSignatureAsync(string mediaType, int tmdbId, string region, bool needTags, CancellationToken ct)
        {
            var key = CacheKey(mediaType, tmdbId, region);
            if (TryGetFreshSignature(key, needTags, out var fresh))
            {
                return fresh;
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
            catch (Exception ex)
            {
                // Over budget or fetch faulted -> cannot verify -> fail closed.
                if (ex is not OperationCanceledException)
                {
                    _logger.Debug($"Parental filter: lookup for {mediaType}/{tmdbId} failed: {ex.Message}");
                }

                return null;
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
                    if (needTags)
                    {
                        _tagFetchFailedAt[key] = now;
                    }

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
                if (hasTagData)
                {
                    _tagFetchFailedAt.TryRemove(key, out _);
                }

                StoreSignature(key, resolved, now, ttl);
                return resolved;
            }
            finally
            {
                _inFlight.TryRemove(inFlightKey, out _);
            }
        }

        private int _trimCounter;

        /// <summary>
        /// Caches a resolved signature. A rating-only refresh must not erase tags a
        /// concurrent full fetch just cached — but must not resurrect EXPIRED tags
        /// either (that would extend them another TTL and let an upstream keyword
        /// change bypass a tag-restricted user), so existing tags are kept only
        /// while the existing entry is itself still fresh.
        /// </summary>
        private void StoreSignature(string key, Signature resolved, DateTime now, TimeSpan ttl)
        {
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
        }

        private void TrimCache()
        {
            // Cheap amortised maintenance: every 500 inserts drop expired entries,
            // and if the cache is still over its hard cap evict the oldest quarter.
            // (Gated on the counter alone: ConcurrentDictionary.Count takes every
            // bucket lock, far too much for a check on the fetch hot path.)
            if (Interlocked.Increment(ref _trimCounter) % 500 != 0)
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

            foreach (var kv in _tagFetchFailedAt)
            {
                if (now - kv.Value > NegativeCacheTtl)
                {
                    _tagFetchFailedAt.TryRemove(kv.Key, out _);
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
            // "Has tag data" means the body carries a keyword container, not merely
            // that the call succeeded: an empty set from a body without one would
            // let a blocked-tag rule pass instead of failing closed.
            return (fromSeerr, fromSeerr != null && SeerrTagSignatureExtractor.HasKeywordData(fromSeerr.Value));
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
            if (!config.JellyseerrEnabled || string.IsNullOrEmpty(config.JellyseerrUrls) || string.IsNullOrEmpty(config.JellyseerrApiKey))
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

        private enum Category { None, List, Detail, SubResource, NestedDetail }

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

            // Single issue: gate on the media it is about.
            if (apiPath.StartsWith("/api/v1/issue/", StringComparison.OrdinalIgnoreCase))
            {
                return new EndpointPlan { Category = Category.NestedDetail };
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
                return true; // unreadable flag: treat as adult (fail closed)
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
