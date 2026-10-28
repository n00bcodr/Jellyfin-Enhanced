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
using Jellyfin.Plugin.JellyfinEnhanced.Services.NativeDetails;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Globalization;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services
{
    /// <summary>
    /// Enforces each Jellyfin user's parental rating and tag rules on shared JE
    /// and proxied Seerr surfaces (issue #581). Every restricted title is resolved
    /// through the selected backend's evidence provider and a user-neutral
    /// cache (default 24 h), and rows above the limit are removed. Detail
    /// endpoints answer 403 for blocked titles and request POSTs are refused, so
    /// a restricted user can't reach a hidden title through a direct link.
    ///
    /// Users without a limit pay nothing: the filter returns before any lookup.
    /// Unresolvable titles fail closed for restricted users (hidden), because
    /// exposure is the failure mode that matters here.
    ///
    /// Rating semantics mirror Jellyfin's own <c>BaseItem.IsParentalAllowed</c>
    /// (see <see cref="ParentalRatingDecision"/>); certifications are resolved only
    /// for the configured rating country (<see cref="SeerrCertificationExtractor"/>).
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
        private static readonly TimeSpan DefaultOverallBudget = TimeSpan.FromSeconds(12);
        private static readonly TimeSpan PerFetchTimeout = TimeSpan.FromSeconds(8);
        // A title whose certification could not be fetched stays "unverified"
        // (hidden for restricted users) for this long before being retried, so a
        // TMDB hiccup or a deleted title doesn't trigger a refetch on every list.
        private static readonly TimeSpan NegativeCacheTtl = TimeSpan.FromMinutes(5);

        private readonly TitleParentalEvidenceProvider _evidence;
        private readonly IUserManager _userManager;
        private readonly ILocalizationManager _localization;
        private readonly IServerConfigurationManager _serverConfig;
        private readonly Logger _logger;
        private readonly ViewerMetadataAdmission _admission;

        // One outbound fan-out limit for list responses across the whole server,
        // not per response. In JE mode all list and single-title evidence tasks also
        // pass the common viewer/server admission factory before they are created.
        private readonly SemaphoreSlim _throttle = new(MaxConcurrentFetches);

        /// <summary>
        /// A title's parental signature: its rating score and, when fetched from a
        /// body that carries them, its cleaned TMDB keyword and genre names.
        /// Keywords/Genres null = tag data not fetched (rating-only lookup).
        /// </summary>
        private sealed record Signature(int? Score, int? SubScore, string[]? Keywords, string[]? Genres, bool? Adult)
        {
            internal long EvidenceGeneration { get; init; } = global::Jellyfin.Plugin.JellyfinEnhanced.Services.EvidenceRevision.EvidenceGeneration;
        }

        // Resolved signature per "{mediaType}:{tmdbId}:{region}" — user-neutral.
        // Unresolved = the fetch failed (negative entry, short TTL); Sig with a null
        // Score and Unresolved false = fetched fine but the title is unrated.
        private ConcurrentDictionary<string, (Signature? Sig, bool Unresolved, DateTime CachedAt)> _certCache = new(StringComparer.Ordinal);

        // Titles whose *tag* upgrade recently failed while a good rating-only entry
        // exists: tag-rule callers get "unverified" (hidden) without re-fetching
        // until NegativeCacheTtl passes; rating-only callers are unaffected.
        private ConcurrentDictionary<string, DateTime> _tagFetchFailedAt = new(StringComparer.Ordinal);

        // Coalesces concurrent fetches of the same title (tag-bearing and
        // rating-only fetches coalesce separately: a rating-only fetch in flight
        // cannot satisfy a caller with tag rules).
        private ConcurrentDictionary<string, Lazy<Task<Signature?>>> _inFlight = new(StringComparer.Ordinal);
        private readonly TimeSpan _overallBudget;

        /// <summary>Creates the filter; registered as a singleton so its caches and fetch pool are shared.</summary>
        public SeerrParentalFilter(
            IHttpClientFactory httpClientFactory,
            IUserManager userManager,
            ILocalizationManager localization,
            IServerConfigurationManager serverConfig,
            Logger logger,
            ViewerMetadataAdmission? admission = null,
            TitleParentalEvidenceProvider? evidence = null)
        {
            _evidence = evidence ?? new TitleParentalEvidenceProvider(httpClientFactory, new TmdbResponseCache(httpClientFactory, TimeProvider.System));
            _userManager = userManager;
            _localization = localization;
            _serverConfig = serverConfig;
            _logger = logger;
            _admission = admission ?? new ViewerMetadataAdmission();
            _overallBudget = DefaultOverallBudget;
            // The pre-event is synchronous; Jellyfin queues the post-event after its actual configuration replacement.
            serverConfig.GetType().GetEvent("ConfigurationUpdating")?.AddEventHandler(serverConfig,
                new EventHandler<Jellyfin.Data.Events.GenericEventArgs<MediaBrowser.Model.Configuration.ServerConfiguration>>(BeforeServerConfiguration));
            serverConfig.ConfigurationUpdated += AfterServerConfiguration;
        }

        /// <summary>Creates the filter with an explicit evidence provider.</summary>
        public SeerrParentalFilter(
            IHttpClientFactory httpClientFactory,
            IUserManager userManager,
            ILocalizationManager localization,
            IServerConfigurationManager serverConfig,
            Logger logger,
            TitleParentalEvidenceProvider evidence)
            : this(httpClientFactory, userManager, localization, serverConfig, logger, null, evidence)
        {
        }

        /// <summary>Creates the filter with another wait for a response's title lookups (tests).</summary>
        internal SeerrParentalFilter(
            IHttpClientFactory httpClientFactory,
            IUserManager userManager,
            ILocalizationManager localization,
            IServerConfigurationManager serverConfig,
            Logger logger,
            TimeSpan overallBudget,
            ViewerMetadataAdmission? admission = null)
            : this(httpClientFactory, userManager, localization, serverConfig, logger, admission)
        {
            _overallBudget = overallBudget;
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
            internal Jellyfin.Database.Implementations.Entities.User? NativeUser { get; init; }
            internal long EvidenceGeneration { get; init; } = global::Jellyfin.Plugin.JellyfinEnhanced.Services.EvidenceRevision.EvidenceGeneration;

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
            if (!IsEnabled() || string.IsNullOrEmpty(jellyfinUserId) || !Guid.TryParse(jellyfinUserId, out var userGuid) || userGuid == Guid.Empty)
            {
                return false;
            }

            var user = _userManager.GetUserById(userGuid);
            if (user == null)
            {
                return false;
            }

            policy = PolicyFor(user);
            return policy.IsRestricted;
        }

        /// <summary>
        /// <see cref="TryGetRestrictedPolicy(string?, out Policy)"/> for a person already read: no second read of the
        /// user (Jellyfin 12 reads users from its database on every lookup, so per-title checks must not repeat it).
        /// </summary>
        /// <param name="user">The person, as just read.</param>
        /// <param name="policy">The policy.</param>
        /// <returns>Whether the person has limits.</returns>
        public bool TryGetRestrictedPolicy(Jellyfin.Database.Implementations.Entities.User? user, out Policy policy)
        {
            policy = default;
            if (!IsEnabled() || user == null)
            {
                return false;
            }

            policy = PolicyFor(user);
            return policy.IsRestricted;
        }

        /// <summary>Jellyfin's rating and tag policy, independent of plugin flags and transport configuration.</summary>
        public static Policy PolicyFor(Jellyfin.Database.Implementations.Entities.User user)
        {
            // Same source Jellyfin's own gate reads (BaseItem.GetBlockUnratedValue);
            // no DTO materialisation on the hot path.
            var blocked = user.GetPreferenceValues<UnratedItem>(PreferenceKind.BlockUnratedItems);
            var blockMovies = blocked.Contains(UnratedItem.Movie);
            var blockSeries = blocked.Contains(UnratedItem.Series);

            // Tag branch of the native parental controls, compared the way core
            // compares tags (raw values, case-insensitive ordinal).
            var blockedTags = ParentalTagDecision.ToTagSet(user.GetPreference(PreferenceKind.BlockedTags));
            var allowedTags = ParentalTagDecision.ToTagSet(user.GetPreference(PreferenceKind.AllowedTags));

            return new Policy(user.MaxParentalRatingScore, user.MaxParentalRatingSubScore, blockMovies, blockSeries, blockedTags, allowedTags) { NativeUser = user };
        }

        private readonly System.Runtime.CompilerServices.ConditionalWeakTable<object, IDisposable> _countryWriters = new();

        private void BeforeServerConfiguration(object? sender, Jellyfin.Data.Events.GenericEventArgs<MediaBrowser.Model.Configuration.ServerConfiguration> args)
        {
            if (sender == null) return;
            var writer = global::Jellyfin.Plugin.JellyfinEnhanced.Services.EvidenceRevision.Advance(_logger, hostUpdate: true);
            lock (_countryWriters)
            {
                if (_countryWriters.TryGetValue(args.Argument, out var previous))
                {
                    _countryWriters.Remove(args.Argument);
                    previous.Dispose();
                }
                _countryWriters.Add(args.Argument, writer);
            }
        }

        private void AfterServerConfiguration(object? sender, EventArgs args)
        {
            lock (_countryWriters)
            {
                if (!_countryWriters.TryGetValue(_serverConfig.Configuration, out var writer)) return;
                _countryWriters.Remove(_serverConfig.Configuration);
                writer.Dispose();
            }
        }

        private static string NormalizeRegion(string? code) => string.IsNullOrWhiteSpace(code) ? "US" : code.Trim().ToUpperInvariant();

        private string Region()
        {
            var code = _serverConfig.Configuration?.MetadataCountryCode;
            return NormalizeRegion(code);
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
                            && await IsTitleBlockedAsync(plan.MediaType, plan.ParentId, policy, Guid.Parse(jellyfinUserId!), requestAborted).ConfigureAwait(false))
                        {
                            return new Result(true, json);
                        }

                        var (filtered, retryLater) = await FilterListAsync(json, plan, policy, Guid.Parse(jellyfinUserId!), requestAborted).ConfigureAwait(false);
                        return new Result(false, filtered, retryLater);

                    case Category.Detail:
                        if (string.Equals(JellyfinEnhanced.Instance?.Configuration.ArrRequestBackend, "je", StringComparison.OrdinalIgnoreCase))
                        {
                            // A legacy-shaped detail body must not seed JE's trusted evidence partition.
                            return new Result(!TryParseId(apiPath, "/api/v1/" + plan.MediaType + "/", out var detailId)
                                || await IsTitleBlockedAsync(plan.MediaType!, detailId, policy, Guid.Parse(jellyfinUserId!), requestAborted).ConfigureAwait(false), json);
                        }
                        return new Result(IsDetailBodyBlocked(json, plan.MediaType!, policy), json);

                    case Category.SubResource:
                        return new Result(await IsTitleBlockedAsync(plan.MediaType!, plan.ParentId, policy, Guid.Parse(jellyfinUserId!), requestAborted).ConfigureAwait(false), json);

                    case Category.NestedDetail:
                        // e.g. /api/v1/issue/{id}: the title sits under `media`.
                        return new Result(await IsNestedMediaBlockedAsync(json, policy, Guid.Parse(jellyfinUserId!), requestAborted).ConfigureAwait(false), json);

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
                return await IsTitleBlockedAsync(type, tmdbId, policy, Guid.Parse(jellyfinUserId!), requestAborted).ConfigureAwait(false);
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

        /// <summary>Verified absent-title rating and tags, retained with a request for later review.</summary>
        public sealed record AbsentSignature(int? Score, int? SubScore, string[] Keywords, string[] Genres)
        {
            internal long EvidenceGeneration { get; init; } = global::Jellyfin.Plugin.JellyfinEnhanced.Services.EvidenceRevision.EvidenceGeneration;
        }

        /// <summary>Cache-only absent-title decision. Restricted users require a rated, verified signature.</summary>
        public bool MaySeeAbsent(string mediaType, int tmdbId, string userId, out AbsentSignature? facts)
        {
            facts = null;
            if (!TryGetRestrictedPolicy(userId, out var policy)) return true;
            return MaySeeAbsent(mediaType, tmdbId, policy, out facts);
        }

        /// <summary>Cache-only absent-title decision under a policy already resolved (see <see cref="TryGetRestrictedPolicy(Jellyfin.Database.Implementations.Entities.User?, out Policy)"/>).</summary>
        /// <param name="mediaType">"movie" or "tv".</param>
        /// <param name="tmdbId">TMDB id.</param>
        /// <param name="policy">The person's policy (restricted).</param>
        /// <param name="facts">The verified signature, when there is one.</param>
        /// <returns>Whether the person may see it.</returns>
        public bool MaySeeAbsent(string mediaType, int tmdbId, Policy policy, out AbsentSignature? facts)
        {
            facts = null;
            if (!policy.IsRestricted) return true;
            if (policy.EvidenceGeneration != EvidenceGeneration) return false;
            var type = NormalizeMediaType(mediaType);
            if (tmdbId <= 0 || type == null) return false;
            if (!TryGetTitleSignature(type, tmdbId, Region(), policy.HasTagRules, out var signature) || signature == null) return false;
            if (JeEvidence ? JeVerdict(signature, type, policy) == null : signature.Score == null) return false;
            facts = new AbsentSignature(signature.Score, signature.SubScore, signature.Keywords ?? Array.Empty<string>(), signature.Genres ?? Array.Empty<string>());
            return IsAllowed(signature, type, policy);
        }

        /// <summary>
        /// The cache-only absent-title decision as a verdict (4f round 7): true or false once the title's rating (and tags, when
        /// the person's rules need them) was verified, or the answer can never change (no valid title identity);
        /// null while it is unverified (not read yet, or the lookup failed lately): evidence to prepare, never a refusal.
        /// </summary>
        /// <param name="mediaType">"movie" or "tv".</param>
        /// <param name="tmdbId">TMDB id.</param>
        /// <param name="userId">The person (Jellyfin user id, any format).</param>
        /// <returns>Whether the person may see it, or null when that isn't known yet.</returns>
        public bool? AbsentVerdict(string mediaType, int tmdbId, string userId)
        {
            if (!TryGetRestrictedPolicy(userId, out var policy)) return true;
            return AbsentVerdict(mediaType, tmdbId, policy);
        }

        /// <summary>Cache-only tri-state decision under the captured caller policy.</summary>
        public bool? AbsentVerdict(string mediaType, int tmdbId, Policy policy)
        {
            if (!policy.IsRestricted) return true;
            if (policy.EvidenceGeneration != EvidenceGeneration) return null;
            var type = NormalizeMediaType(mediaType);
            if (tmdbId <= 0 || type == null) return false;
            if (!TryGetTitleSignature(type, tmdbId, Region(), policy.HasTagRules, out var signature) || signature == null) return null;
            return JeEvidence ? JeVerdict(signature, type, policy) : signature.Score != null && IsAllowed(signature, type, policy);
        }

        /// <summary>
        /// <see cref="MaySeeAbsent(string, int, string, out AbsentSignature?)"/> for a person already read: their policy
        /// comes from that read (<see cref="TryGetRestrictedPolicy(Jellyfin.Database.Implementations.Entities.User?, out Policy)"/>),
        /// so they are not read again.
        /// </summary>
        /// <param name="mediaType">"movie" or "tv".</param>
        /// <param name="tmdbId">TMDB id.</param>
        /// <param name="user">The person, as read.</param>
        /// <param name="facts">The verified signature, when there is one.</param>
        /// <returns>Whether the person may see it.</returns>
        public bool MaySeeAbsent(string mediaType, int tmdbId, Jellyfin.Database.Implementations.Entities.User user, out AbsentSignature? facts)
        {
            facts = null;
            if (!TryGetRestrictedPolicy(user, out var policy)) return true;
            return MaySeeAbsent(mediaType, tmdbId, policy, out facts);
        }

        /// <summary><see cref="AbsentVerdict(string, int, string)"/> for a person already read (not read again).</summary>
        /// <param name="mediaType">"movie" or "tv".</param>
        /// <param name="tmdbId">TMDB id.</param>
        /// <param name="user">The person, as read.</param>
        /// <returns>Whether the person may see it, or null when that isn't known yet.</returns>
        public bool? AbsentVerdict(string mediaType, int tmdbId, Jellyfin.Database.Implementations.Entities.User user)
        {
            if (!TryGetRestrictedPolicy(user, out var policy)) return true;
            return AbsentVerdict(mediaType, tmdbId, policy);
        }

        /// <summary><see cref="MaySeeAbsentAsync(string, int, string, CancellationToken)"/> for a person already read (not read again).</summary>
        /// <param name="mediaType">"movie" or "tv".</param>
        /// <param name="tmdbId">TMDB id.</param>
        /// <param name="user">The person, as read; also the viewer metadata admission is charged to.</param>
        /// <param name="ct">Cancellation.</param>
        /// <returns>Whether the person may see it.</returns>
        public async Task<bool> MaySeeAbsentAsync(string mediaType, int tmdbId, Jellyfin.Database.Implementations.Entities.User user, CancellationToken ct)
        {
            if (!TryGetRestrictedPolicy(user, out var policy)) return true;
            try { return await CheckAbsentAsync(mediaType, tmdbId, policy, user.Id, ct).ConfigureAwait(false) == true; }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { return false; }
        }

        /// <summary>Bounded absent-title check; lookup failures and unrated titles refuse restricted users.</summary>
        public async Task<bool> MaySeeAbsentAsync(string mediaType, int tmdbId, string userId, CancellationToken ct)
        {
            try { return await CheckAbsentAsync(mediaType, tmdbId, userId, ct).ConfigureAwait(false) == true; }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { return false; }
        }

        /// <summary>False is a policy refusal; null is unavailable evidence, including refused admission.</summary>
        public Task<bool?> CheckAbsentAsync(string mediaType, int tmdbId, string userId, CancellationToken ct)
        {
            if (!TryGetRestrictedPolicy(userId, out var policy)) return Task.FromResult<bool?>(true);
            return CheckAbsentAsync(mediaType, tmdbId, policy, Guid.Parse(userId), ct);
        }

        /// <summary>Compatibility policy-only reads share a conservative bounded owner.</summary>
        public async Task<bool> MaySeeAbsentAsync(string mediaType, int tmdbId, Policy policy, CancellationToken ct)
        {
            try { return await CheckAbsentAsync(mediaType, tmdbId, policy, policy.NativeUser?.Id ?? ViewerMetadataAdmission.EffectiveViewer ?? Guid.Empty, ct).ConfigureAwait(false) == true; }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { return false; }
        }

        /// <summary>Evidence-provider join: a captured policy must retain its effective viewer for admission.</summary>
        public async Task<bool?> CheckAbsentAsync(string mediaType, int tmdbId, Policy policy, Guid viewer, CancellationToken ct)
        {
            if (!policy.IsRestricted) return true;
            if (policy.EvidenceGeneration != EvidenceGeneration) return null;
            var type = NormalizeMediaType(mediaType);
            if (tmdbId <= 0 || type == null) return false;
            using var timed = StageTimings.Time(Stage.Evidence);
            try
            {
                using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
                timeout.CancelAfter(TimeSpan.FromSeconds(8));
                await GetSignatureAsync(type, tmdbId, Region(), policy.HasTagRules, viewer, timeout.Token).ConfigureAwait(false);
                return AbsentVerdict(type, tmdbId, policy);
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
            catch (Exception) { return null; }
        }

        /// <summary>Captured evidence check retains the policy's effective viewer for shared admission.</summary>
        public Task<bool?> AbsentVerdictAsync(string mediaType, int tmdbId, Policy policy, CancellationToken ct)
            => CheckAbsentAsync(mediaType, tmdbId, policy, policy.NativeUser?.Id ?? ViewerMetadataAdmission.EffectiveViewer ?? Guid.Empty, ct);

        // ── Decisions ────────────────────────────────────────────────────────

        private static bool JeEvidence => string.Equals(JellyfinEnhanced.Instance?.Configuration.ArrRequestBackend, "je", StringComparison.OrdinalIgnoreCase);

        /// <summary>Nonsecret revision of evidence source, configuration, country and decision semantics.</summary>
        public string EvidenceFingerprint => "parental-v2|" + JellyfinEnhanced.Instance?.Configuration.ArrRequestBackend + "|" + _evidence.Capture().CacheScope + "|" + Region();

        /// <summary>The monotonic provenance of every parental decision; input fingerprints are diagnostics only.</summary>
        public long EvidenceGeneration => global::Jellyfin.Plugin.JellyfinEnhanced.Services.EvidenceRevision.EvidenceGeneration;

        /// <summary>Compatibility stamp for downstream policy/cache keys; never a content fingerprint.</summary>
        public string EvidenceRevision => EvidenceGeneration.ToString(CultureInfo.InvariantCulture);

        /// <summary>Captures the evidence used by a JE publication; legacy backend behavior is unchanged.</summary>
        internal Acquire.EvidencePublication CapturePublication(Guid? viewer = null)
        {
            JellyfinEnhanced.Instance?.Secrets.RecoverIfNeeded();
            return new(() => string.Equals(JellyfinEnhanced.Instance?.Configuration.ArrRequestBackend, "je", StringComparison.OrdinalIgnoreCase) ? EvidenceRevision : "-", viewer);
        }

        /// <summary>Current native entitlement for a broad consumer; absent-title checks never use this exemption.</summary>
        internal bool MayOpenLocal(string kind, int tmdb, string userId)
            => TryGetRestrictedPolicy(userId, out var policy) && JeEvidence && _evidence.MayOpenLocal(kind, tmdb, policy.NativeUser);

        /// <summary><see cref="MayOpenLocal(string, int, string)"/> for a person already read (not read again).</summary>
        internal bool MayOpenLocal(string kind, int tmdb, Jellyfin.Database.Implementations.Entities.User user)
            => TryGetRestrictedPolicy(user, out var policy) && JeEvidence && _evidence.MayOpenLocal(kind, tmdb, policy.NativeUser);

        // All JE entry points share this decision. Adult is a verified refusal even without other facets;
        // missing regional ratings, failed scoring and incomplete required tags remain unknown.
        private static bool? JeVerdict(Signature? signature, string mediaType, Policy policy)
        {
            if (signature?.Adult == true) return false;
            if (signature?.Adult != false || signature.Score == null
                || (policy.HasTagRules && (signature.Keywords == null || signature.Genres == null))) return null;
            return RatedAndTaggedAllowed(signature, mediaType, policy);
        }

        private bool IsAllowed(Signature? resolved, string mediaType, Policy policy, int tmdbId = 0)
            => JeEvidence ? (tmdbId > 0 && _evidence.MayOpenLocal(mediaType, tmdbId, policy.NativeUser)) || JeVerdict(resolved, mediaType, policy) == true
                : resolved != null && RatedAndTaggedAllowed(resolved, mediaType, policy);

        // Seerr's broad/native-style unrated rules stay unchanged; JE's completeness rule lives above.
        private static bool RatedAndTaggedAllowed(Signature resolved, string mediaType, Policy policy)
        {
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
            if (string.Equals(JellyfinEnhanced.Instance?.Configuration.ArrRequestBackend, "seerr", StringComparison.OrdinalIgnoreCase)
                && detail.TryGetProperty("id", out var idEl) && idEl.ValueKind == JsonValueKind.Number && idEl.TryGetInt32(out var tmdbId))
            {
                StoreSignature(CacheKey(mediaType, tmdbId, region), resolved, DateTime.UtcNow);
            }

            return !IsAllowed(resolved, mediaType, policy);
        }

        private async Task<bool> IsNestedMediaBlockedAsync(string json, Policy policy, Guid viewer, CancellationToken requestAborted)
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

                return await IsTitleBlockedAsync(mediaType, tmdbId, policy, viewer, requestAborted).ConfigureAwait(false);
            }
            catch (JsonException)
            {
                return true;
            }
        }

        private async Task<bool> IsTitleBlockedAsync(string mediaType, int tmdbId, Policy policy, Guid viewer, CancellationToken requestAborted = default)
        {
            if (tmdbId <= 0)
            {
                return true;
            }

            if (JeEvidence)
            {
                if (_evidence.MayOpenLocal(mediaType, tmdbId, policy.NativeUser)) return false;
                return await CheckAbsentAsync(mediaType, tmdbId, policy, viewer, requestAborted).ConfigureAwait(false) != true;
            }
            using var cts = CancellationTokenSource.CreateLinkedTokenSource(requestAborted);
            cts.CancelAfter(_overallBudget);
            var resolved = await GetSignatureAsync(mediaType, tmdbId, Region(), policy.HasTagRules, viewer, cts.Token).ConfigureAwait(false);
            return !IsAllowed(resolved, mediaType, policy);
        }

        // ── List filtering ───────────────────────────────────────────────────

        private async Task<(string Body, bool RetryLater)> FilterListAsync(string json, EndpointPlan plan, Policy policy, Guid viewer, CancellationToken requestAborted)
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
            var (scores, pending) = await ResolveScoresAsync(arrays, plan, region, policy.HasTagRules, viewer, requestAborted).ConfigureAwait(false);
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
            Guid viewer,
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
            cts.CancelAfter(_overallBudget);
            var throttle = _throttle;
            var droppedFromQueue = 0;

            var tasks = keys.Select(async kvp =>
            {
                // Cache hits never occupy a slot.
                if (TryGetTitleSignature(kvp.Value.MediaType, kvp.Value.TmdbId, region, needTags, out var hit))
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
                    var score = await GetSignatureAsync(kvp.Value.MediaType, kvp.Value.TmdbId, region, needTags, viewer, CancellationToken.None).ConfigureAwait(false);
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
            var pending = tasks.Count(t => !t.IsCompletedSuccessfully
                || (JellyfinEnhanced.Instance?.Configuration is { } config && NativeDetailsPolicy.JeBackend(config)
                    && t.Result.Item2 == null && !TryGetFreshSignature(t.Result.Key, needTags, out _))) + droppedFromQueue;
            if (pending > 0)
            {
                _logger.Debug($"Parental filter: {pending} of {tasks.Count} title lookups unresolved after {_overallBudget.TotalSeconds:0}s ({droppedFromQueue} never started); hiding them for this response.");
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
            return IsAllowed(score, mediaType, policy, tmdbId);
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
                if (!IsAllowed(score, mediaType, policy, tmdbId))
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
            using var __factsOperation0 = global::Jellyfin.Plugin.JellyfinEnhanced.Helpers.UserCacheRegistry.BeginOperation();
            signature = null;
            if (_certCacheFacts.TryGetValue(key, out var cached))
            {
                var age = DateTime.UtcNow - cached.CachedAt;
                if (cached.Unresolved)
                {
                    if (age < NegativeCacheTtl)
                    {
                        return true; // recently failed to verify -> still hidden, no refetch
                    }
                }
                else if (age < SignatureTtl(key, cached.Sig) && (!needTags || cached.Sig?.Adult == true || (cached.Sig?.Keywords != null && cached.Sig.Genres != null)))
                {
                    // A rating-only entry can't satisfy a tag-rule caller; fall through to fetch.
                    signature = cached.Sig;
                    return true;
                }
            }

            if (needTags && _tagFetchFailedAtFacts.TryGetValue(key, out var failedAt))
            {
                if (DateTime.UtcNow - failedAt < NegativeCacheTtl)
                {
                    return true; // tag data recently unavailable -> hidden for tag-rule users, no refetch
                }

                _tagFetchFailedAtFacts.TryRemove(key, out _);
            }

            return false;
        }

        private static TimeSpan SignatureTtl(string key, Signature? signature)
            => key.StartsWith("je:", StringComparison.Ordinal) && signature?.Adult != true && signature?.Score == null ? NegativeCacheTtl : CacheTtl();

        private bool TryGetTitleSignature(string mediaType, int tmdbId, string region, bool needTags, out Signature? signature)
        {
            signature = null;
            try
            {
                if (_evidence.TryReadLocal(mediaType, tmdbId, region, out var local))
                {
                    if (local == null) return true;
                    // Native rating/tags are authoritative for those facets. Jellyfin has no separate adult
                    // flag: a local override must not erase a known adult flag or invent a non-adult verdict.
                    if (!TryGetFreshSignature(CacheKey(mediaType, tmdbId, region), false, out var remote)) return false;
                    if (remote?.Adult != null) signature = SignatureFromEvidence(local) with { Adult = remote.Adult };
                    return true;
                }
                return TryGetFreshSignature(CacheKey(mediaType, tmdbId, region), needTags, out signature);
            }
            catch (Exception)
            {
                // An unreadable native authority is unknown, never permission to use a more permissive source.
                return true;
            }
        }

        private async Task<Signature?> GetSignatureAsync(string mediaType, int tmdbId, string region, bool needTags, Guid viewer, CancellationToken ct)
        {
            using var __factsOperation1 = global::Jellyfin.Plugin.JellyfinEnhanced.Helpers.UserCacheRegistry.BeginOperation();
            var generation = EvidenceGeneration;
            var source = _evidence.Capture();
            var key = CacheKey(source, mediaType, tmdbId, region);
            if (TryGetTitleSignature(mediaType, tmdbId, region, needTags, out var fresh))
            {
                return fresh;
            }

            // Coalesce concurrent fetches. The shared task carries its own timeout;
            // each caller bounds only its own wait, so one request's budget can't
            // cancel a fetch another request depends on.
            var inFlightKey = needTags ? key + "|tags" : key;
            if (JeEvidence)
            {
                // Facts already verified and saved, or the raw answer already in memory or on disk, take no admission place.
                var known = await KnownSignatureAsync(source, generation, key, mediaType, tmdbId, region, needTags, ct).ConfigureAwait(false);
                if (known.Hit) return known.Value;
                var admitted = await _admission.Read("parental:" + key, viewer,
                    () => (TryGetTitleSignature(mediaType, tmdbId, region, needTags, out var value), value),
                    () => RunJeFetchAsync(source, inFlightKey, key, mediaType, tmdbId, region, needTags), null, ct).ConfigureAwait(false);
                if (generation != EvidenceGeneration) return null;
                return TryGetTitleSignature(mediaType, tmdbId, region, needTags, out var merged) ? merged : admitted;
            }

            var lazy = _inFlightFacts.GetOrAdd(inFlightKey, _ => new Lazy<Task<Signature?>>(
                () => FetchThrottledAsync(source, inFlightKey, key, mediaType, tmdbId, region, needTags),
                LazyThreadSafetyMode.ExecutionAndPublication));

            try
            {
                var resolved = await lazy.Value.WaitAsync(ct).ConfigureAwait(false);
                if (generation != EvidenceGeneration) return null;
                return TryGetTitleSignature(mediaType, tmdbId, region, needTags, out var merged) ? merged : resolved;
            }
            catch (Exception ex)
            {
                // Over budget or fetch faulted -> cannot verify -> fail closed.
                if (ex is not OperationCanceledException)
                {
                    _logger.Debug($"Parental filter: lookup for {mediaType}/{tmdbId} failed ({ex.GetType().Name}).");
                }

                return null;
            }
        }

        private Task<Signature?> RunJeFetchAsync(ITitleParentalEvidence source, string inFlightKey, string key, string mediaType, int tmdbId, string region, bool needTags)
            => FetchAndCacheAsync(source, inFlightKey, key, mediaType, tmdbId, region, needTags);

        private async Task<Signature?> FetchThrottledAsync(ITitleParentalEvidence source, string inFlightKey, string key, string mediaType, int tmdbId, string region, bool needTags)
        {
            using var __factsOperation2 = global::Jellyfin.Plugin.JellyfinEnhanced.Helpers.UserCacheRegistry.BeginOperation();
            try
            {
                return await FetchAndCacheAsync(source, inFlightKey, key, mediaType, tmdbId, region, needTags).ConfigureAwait(false);
            }
            finally
            {
                _inFlightFacts.TryRemove(inFlightKey, out _);
            }
        }

        /// <summary>
        /// JE evidence that needs no admission place: facts saved by an earlier verified read (scored here, under the
        /// generation captured before they were read, with their original read time, so a restart never renews them),
        /// else the raw TMDB answer when memory or disk already holds it (the ordinary scoring and caching). Hit false:
        /// neither is known and the caller takes its admitted read. A generation change meanwhile answers unknown.
        /// </summary>
        private async Task<(bool Hit, Signature? Value)> KnownSignatureAsync(ITitleParentalEvidence source, long generation, string key,
            string mediaType, int tmdbId, string region, bool needTags, CancellationToken ct)
        {
            using var __factsOperation5 = global::Jellyfin.Plugin.JellyfinEnhanced.Helpers.UserCacheRegistry.BeginOperation();
            TitleParentalEvidence? stored = null;
            try
            {
                stored = await source.ReadFactsAsync(mediaType, tmdbId, region, needTags, ct).ConfigureAwait(false);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                // A facts cache error is a miss, never an answer.
            }

            if (stored != null)
            {
                if (generation != EvidenceGeneration || source.EvidenceGeneration != EvidenceGeneration) return (true, null);
                var resolved = SignatureFromEvidence(stored) with { EvidenceGeneration = source.EvidenceGeneration };
                if (resolved.Adult == false && resolved.Score != null && stored.ReadAtUtc is { } readAt)
                {
                    // Its original read time: the signature lives no longer than the facts did.
                    _certCacheFacts[key] = (resolved, false, readAt);
                    if (resolved.Keywords != null && resolved.Genres != null) _tagFetchFailedAtFacts.TryRemove(key, out _);
                    TrimCache();
                    return (true, TryGetTitleSignature(mediaType, tmdbId, region, needTags, out var merged) ? merged : resolved);
                }

                // No longer scorable here (the rating system changed): not used, and not kept.
                await source.ForgetFactsAsync(mediaType, tmdbId, region).ConfigureAwait(false);
            }

            var raw = await TmdbResponseCache.CachedOnlyAsync(() => ReadEvidenceAsync(source, mediaType, tmdbId, region, needTags)).ConfigureAwait(false);
            if (!raw.Hit) return (false, null);
            var committed = CommitEvidence(source, key, mediaType, tmdbId, region, needTags, raw.Value);
            if (generation != EvidenceGeneration) return (true, null);
            return (true, TryGetTitleSignature(mediaType, tmdbId, region, needTags, out var current) ? current : committed);
        }

        private async Task<Signature?> FetchAndCacheAsync(ITitleParentalEvidence source, string inFlightKey, string key, string mediaType, int tmdbId, string region, bool needTags)
            => CommitEvidence(source, key, mediaType, tmdbId, region, needTags, await ReadEvidenceAsync(source, mediaType, tmdbId, region, needTags).ConfigureAwait(false));

        private async Task<TitleParentalEvidence?> ReadEvidenceAsync(ITitleParentalEvidence source, string mediaType, int tmdbId, string region, bool needTags)
        {
            try
            {
                using var cts = new CancellationTokenSource(PerFetchTimeout);
                return await source.ReadAsync(mediaType, tmdbId, region, needTags, cts.Token).ConfigureAwait(false);
            }
            catch (Exception ex)
            {
                // Timeouts and transport faults count as "could not verify" too.
                _logger.Debug($"Parental filter: lookup failed for {mediaType}/{tmdbId} ({ex.GetType().Name}).");
                return null;
            }
        }

        private Signature? CommitEvidence(ITitleParentalEvidence source, string key, string mediaType, int tmdbId, string region, bool needTags, TitleParentalEvidence? detail)
        {
            using var __factsOperation6 = global::Jellyfin.Plugin.JellyfinEnhanced.Helpers.UserCacheRegistry.BeginOperation();
            if (source.EvidenceGeneration != EvidenceGeneration) return null;
            var now = DateTime.UtcNow;
            if (detail == null)
            {
                if (needTags)
                {
                    _tagFetchFailedAtFacts[key] = now;
                }

                // Negative entry (retried after NegativeCacheTtl) — unless a fresh
                // positive entry exists, which a failed *tag* upgrade must not erase:
                // rating-only users would otherwise lose a title Seerr merely
                // failed to answer for a moment.
                _certCacheFacts.AddOrUpdate(
                    key,
                    _ => (null, true, now),
                    (_, current) => !current.Unresolved && current.Sig != null && now - current.CachedAt < SignatureTtl(key, current.Sig)
                        ? current
                        : (null, true, now));
                TrimCache();
                return null;
            }

            var resolved = SignatureFromEvidence(detail) with { EvidenceGeneration = source.EvidenceGeneration };
            var je = source.CacheScope.StartsWith("je:", StringComparison.Ordinal);
            if (je && resolved.Adult != true && resolved.Score == null)
            {
                source.Forget(mediaType, tmdbId, needTags);
                _ = source.ForgetFactsAsync(mediaType, tmdbId, region);
            }
            else if (je && resolved.Adult == false && resolved.Score != null)
            {
                // Verified complete and scorable: the remote facts (never this signature or a decision) may be saved.
                var tags = resolved.Keywords != null && resolved.Genres != null;
                if (!needTags || tags) _ = source.RememberFactsAsync(mediaType, tmdbId, region, detail, tags, CacheTtl());
            }

            if (resolved.Keywords != null && resolved.Genres != null)
            {
                _tagFetchFailedAtFacts.TryRemove(key, out _);
            }

            // The evidence lives from its TMDB read (a cached raw answer keeps its original fetch time), never from now.
            StoreSignature(key, resolved, now, detail.ReadAtUtc is { } readAt && readAt <= now ? readAt : now);
            if (needTags && resolved.Adult != true && (resolved.Keywords == null || resolved.Genres == null))
            {
                _tagFetchFailedAtFacts[key] = now;
                return null;
            }
            return resolved;
        }

        private int _trimCounter;

        /// <summary>
        /// Caches a resolved signature. A rating-only refresh must not erase tags a
        /// concurrent full fetch just cached — but must not resurrect EXPIRED tags
        /// either (that would extend them another TTL and let an upstream keyword
        /// change bypass a tag-restricted user), so existing tags are kept only
        /// while the existing entry is itself still fresh.
        /// </summary>
        private void StoreSignature(string key, Signature resolved, DateTime now) => StoreSignature(key, resolved, now, now);

        /// <summary>
        /// <see cref="StoreSignature(string, Signature, DateTime)"/> for evidence read at <paramref name="readAt"/>: the
        /// entry lives from then. Tags kept from the current entry keep their own (older) time: a rating-only refresh never
        /// extends them.
        /// </summary>
        private void StoreSignature(string key, Signature resolved, DateTime now, DateTime readAt)
        {
            using var __factsOperation3 = global::Jellyfin.Plugin.JellyfinEnhanced.Helpers.UserCacheRegistry.BeginOperation();
            _certCacheFacts.AddOrUpdate(
                key,
                _ => (resolved, false, readAt),
                (_, current) =>
                {
                    var stored = resolved;
                    if (!current.Unresolved && current.Sig != null && now - current.CachedAt < SignatureTtl(key, current.Sig))
                        stored = stored with { Adult = stored.Adult ?? current.Sig.Adult };
                    if (stored.Keywords == null && current.Sig?.Keywords != null && !current.Unresolved && now - current.CachedAt < SignatureTtl(key, current.Sig))
                    {
                        return (stored with { Keywords = current.Sig.Keywords, Genres = current.Sig.Genres }, false, readAt < current.CachedAt ? readAt : current.CachedAt);
                    }

                    return (stored, false, readAt);
                });
            TrimCache();
        }

        private void TrimCache()
        {
            using var __factsOperation4 = global::Jellyfin.Plugin.JellyfinEnhanced.Helpers.UserCacheRegistry.BeginOperation();
            // Cheap amortised maintenance: every 500 inserts drop expired entries,
            // and if the cache is still over its hard cap evict the oldest quarter.
            // (Gated on the counter alone: ConcurrentDictionary.Count takes every
            // bucket lock, far too much for a check on the fetch hot path.)
            if (Interlocked.Increment(ref _trimCounter) % 500 != 0)
            {
                return;
            }

            var now = DateTime.UtcNow;
            foreach (var kv in _certCacheFacts)
            {
                var limit = kv.Value.Unresolved ? NegativeCacheTtl : SignatureTtl(kv.Key, kv.Value.Sig);
                if (now - kv.Value.CachedAt > limit)
                {
                    _certCacheFacts.TryRemove(kv.Key, out _);
                }
            }

            foreach (var kv in _tagFetchFailedAtFacts)
            {
                if (now - kv.Value > NegativeCacheTtl)
                {
                    _tagFetchFailedAtFacts.TryRemove(kv.Key, out _);
                }
            }

            if (_certCacheFacts.Count >= MaxCacheEntries)
            {
                foreach (var kv in _certCacheFacts.OrderBy(kv => kv.Value.CachedAt).Take(MaxCacheEntries / 4).ToList())
                {
                    _certCacheFacts.TryRemove(kv.Key, out _);
                }
            }
        }

        private Signature SignatureFromDetail(JsonElement detail, string mediaType, string region, bool includeTags)
            => SignatureFromEvidence(TitleParentalEvidenceProvider.FromSeerr(detail, mediaType, region, includeTags));

        private Signature SignatureFromEvidence(TitleParentalEvidence evidence)
        {
            if (string.IsNullOrWhiteSpace(evidence.Certification))
                return new Signature(null, null, evidence.Keywords, evidence.Genres, evidence.Adult);
            try
            {
                var score = _localization.GetRatingScore(evidence.Certification, evidence.Region);
                return new Signature(score?.Score, score?.SubScore, evidence.Keywords, evidence.Genres, evidence.Adult);
            }
            catch (Exception)
            {
                return new Signature(null, null, evidence.Keywords, evidence.Genres, evidence.Adult);
            }
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

        private string CacheKey(string mediaType, int tmdbId, string region)
            => CacheKey(_evidence.Capture(), mediaType, tmdbId, region);

        private static string CacheKey(ITitleParentalEvidence source, string mediaType, int tmdbId, string region)
            => $"{source.CacheScope}:g{source.EvidenceGeneration}:{mediaType}:{tmdbId.ToString(CultureInfo.InvariantCulture)}:{region}";
        private readonly global::Jellyfin.Plugin.JellyfinEnhanced.Helpers.UserCacheRegistry.State<ConcurrentDictionary<string, (Signature? Sig, bool Unresolved, DateTime CachedAt)>> _certCacheFactsOwner = new();
        private ConcurrentDictionary<string, (Signature? Sig, bool Unresolved, DateTime CachedAt)> _certCacheFacts { get => _certCacheFactsOwner.Read(ref _certCache, () => new(StringComparer.Ordinal)); set => _certCacheFactsOwner.Store(ref _certCache, value); }
        private readonly global::Jellyfin.Plugin.JellyfinEnhanced.Helpers.UserCacheRegistry.State<ConcurrentDictionary<string, DateTime>> _tagFetchFailedAtFactsOwner = new();
        private ConcurrentDictionary<string, DateTime> _tagFetchFailedAtFacts { get => _tagFetchFailedAtFactsOwner.Read(ref _tagFetchFailedAt, () => new(StringComparer.Ordinal)); set => _tagFetchFailedAtFactsOwner.Store(ref _tagFetchFailedAt, value); }
        private readonly global::Jellyfin.Plugin.JellyfinEnhanced.Helpers.UserCacheRegistry.State<ConcurrentDictionary<string, Lazy<Task<Signature?>>>> _inFlightFactsOwner = new();
        private ConcurrentDictionary<string, Lazy<Task<Signature?>>> _inFlightFacts { get => _inFlightFactsOwner.Read(ref _inFlight, () => new(StringComparer.Ordinal)); set => _inFlightFactsOwner.Store(ref _inFlight, value); }
    }
}
