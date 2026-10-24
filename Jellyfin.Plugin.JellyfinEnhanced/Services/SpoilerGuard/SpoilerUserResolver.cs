using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Session;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Model.Entities;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services
{
    // Shared spoiler-state-load helper used by both SpoilerBlurImageFilter
    // and SpoilerFieldStripFilter, plus thin delegation into the plugin-wide
    // RequestIdentityService (Services/Identity) — the "who is making this
    // request?" ladder (ClaimsPrincipal → tag marker → cookie → session-by-IP)
    // lives THERE so every feature resolves identity through one documented,
    // choke point; this class owns only what is spoiler-specific
    // (per-user spoilerblur.json state, collection scope, corruption log).
    //
    // Shares a single HttpContext.Items cache key so a request that triggers
    // BOTH filters (e.g. an /Items batch that ALSO loads images) performs ONE
    // file-read for the per-user spoiler state, not two.
    public sealed class SpoilerUserResolver
    {
        public const string ContextKeyUserState = "__JE_SpoilerBlur_UserState_Shared";

        private static readonly TimeSpan PerKeyWarnInterval = TimeSpan.FromHours(1);
        private static ConcurrentDictionary<string, DateTime> _warnedAt = new();

        // F7: cross-request in-memory cache of each user's spoiler state, keyed
        // by userId (N-format). An anonymous image burst on a shared IP probes
        // every candidate's state on every image request; without this each
        // probe re-reads + re-parses spoilerblur.json from disk. Every
        // controller/pending/promoter write path calls InvalidateUser after its
        // write, and a read that began before such an invalidation is never kept
        // (WrittenStateCache's ticket): a plain remove-on-write let a reader that
        // loaded the old file put it back after the write's remove, so a title
        // just opted in stayed outside Spoiler Guard for the TTL. Per-request the
        // HttpContext.Items layer still short-circuits repeats.
        private static readonly TimeSpan UserStateCacheTtl = TimeSpan.FromSeconds(30);
        private static readonly WrittenStateCache<string, UserSpoilerBlur> _userStateCache
            = new(UserStateCacheTtl, 512, StringComparer.OrdinalIgnoreCase);

        // F6: memoized result of the O(opted-collections × members) collection
        // walk in FindOptedInCollectionForMovie (runs 2-3× per movie image/DTO).
        // Keyed by (movieId + the SORTED set of opted collection GUIDs), because
        // the result is a pure function of those two inputs plus user-independent
        // library structure — so a collection opt-in/out changes the key set
        // automatically (self-invalidating) and two users with the same set share
        // safely. Short TTL bounds staleness from library edits.
        private static readonly TimeSpan CollectionScopeCacheTtl = TimeSpan.FromSeconds(30);
        private static ConcurrentDictionary<string, (Guid? CollectionId, DateTime CachedAt, long ReadAt)> _collectionScopeCache
            = new(StringComparer.Ordinal);

        static SpoilerUserResolver()
        {
            using var __factsOperation0 = global::Jellyfin.Plugin.JellyfinEnhanced.Helpers.UserCacheRegistry.BeginOperation();
            // A collection's members changed: every memoized membership answer may be stale.
            PrivacyInputs.CollectionChanged += _ => _collectionScopeCacheFacts.Clear();
        }

        /// <summary>
        /// Drops the cross-request caches for a user so the next request re-reads
        /// spoilerblur.json from disk. MUST be called immediately after any write
        /// to that user's spoiler state (add/remove/promote), or the image filter
        /// would serve stale (possibly UN-blurred) bytes for up to the cache TTL.
        /// </summary>
        public static void InvalidateUser(string userIdN)
        {
            if (string.IsNullOrEmpty(userIdN)) return;
            var key = userIdN.Replace("-", "").ToLowerInvariant();
            _userStateCache.Invalidate(key);
            // The collection-scope memo is self-invalidating (its key includes
            // the collection set), so no per-user sweep is required there.
        }

        // Internal helpers over the F7 cross-request state cache, mirroring
        // HiddenContentResponseFilter's pattern for future focused tests.
        internal static void SeedUserStateCacheForTest(string userIdN)
        {
            if (!string.IsNullOrEmpty(userIdN))
                _userStateCache.Set(userIdN, _userStateCache.Begin(), new UserSpoilerBlur());
        }

        internal static bool IsUserStateCachedForTest(string userIdN)
            => !string.IsNullOrEmpty(userIdN) && _userStateCache.TryGet(userIdN, out _);

        // An item's typed TMDB key (a library fact, the same for every viewer), with when it was read and the input tick it
        // was read at: used only while the input log shows no library change of the item since then.
        private ConcurrentDictionary<Guid, (string? Key, DateTime At, long Since)> _providerTitles = new();
        private readonly UserConfigurationManager _userConfigManager;
        private readonly ILibraryManager _libraryManager;
        private readonly RequestIdentityService _identity;
        private readonly Logger _logger;

        public SpoilerUserResolver(
            UserConfigurationManager userConfigManager,
            ILibraryManager libraryManager,
            Logger logger,
            RequestIdentityService identity)
        {
            _userConfigManager = userConfigManager;
            _libraryManager = libraryManager;
            _identity = identity;
            PrivacyInputs.Observe(libraryManager, null);
            _logger = logger;
        }

        // Returns the id of an opted-in collection (BoxSet) that contains the
        // given movie, or null. Shared by the image filter, field-strip filter
        // and controller so the "is this movie in spoiler scope via a collection"
        // rule (and the collection-art lookup) can't drift between them.
        public Guid? FindOptedInCollectionForMovie(UserSpoilerBlur userState, Guid movieId)
        {
            using var __factsOperation1 = global::Jellyfin.Plugin.JellyfinEnhanced.Helpers.UserCacheRegistry.BeginOperation();
            if (movieId == Guid.Empty || userState.Collections.Count == 0) return null;

            // F6 memo. The static cache serves BOTH within-request repeats (the
            // 2-3 calls per movie hit the same entry) AND repeats across the
            // page/session, so a separate HttpContext.Items layer would be
            // redundant.
            var cacheKey = BuildCollectionScopeKey(userState, movieId);
            var now = DateTime.UtcNow;
            // Membership is a verdict input: the guarded collections and the movie are recorded (the memo follows the
            // collections' own changes, CollectionChanged).
            if (PrivacyReadSet.Current is { } reads)
            {
                reads.Library(movieId);
                foreach (var key in userState.Collections.Keys) if (Guid.TryParse(key, out var guid)) reads.Library(guid);
            }
            if (cacheKey != null
                && _collectionScopeCacheFacts.TryGetValue(cacheKey, out var hit)
                && (now - hit.CachedAt) < CollectionScopeCacheTtl)
            {
                // The memo's own inputs, as of when it was read.
                if (PrivacyReadSet.Current is { } memo)
                {
                    memo.Library(movieId, hit.ReadAt);
                    foreach (var key in userState.Collections.Keys) if (Guid.TryParse(key, out var guid)) memo.Library(guid, hit.ReadAt);
                }
                return hit.CollectionId;
            }
            var readAt = PrivacyInputs.Now;

            Guid? result = null;
            try
            {
                foreach (var collKeyN in userState.Collections.Keys)
                {
                    if (!Guid.TryParse(collKeyN, out var collGuid)) continue;
                    // The shared identity resolver's linked-children membership (the same answer every surface gets).
                    if (PrivacyIdentities.CollectionMembers(_libraryManager, collGuid).Contains(movieId)) { result = collGuid; break; }
                }
            }
            catch (Exception ex)
            {
                WarnRateLimited(
                    "movie-in-collection:" + ex.GetType().FullName,
                    $"Spoiler Guard: movie-in-collection linked-children walk failed for {movieId}: {ex.Message}");
                return null; // don't cache a transient failure
            }

            // A walk that overlapped a collection change is not memoized (the change's event may already have run).
            if (cacheKey != null && PrivacyInputs.LibraryChangesSince(readAt) is { } changed
                && !userState.Collections.Keys.Any(k => Guid.TryParse(k, out var guid) && changed.Contains(guid)))
            {
                _collectionScopeCacheFacts[cacheKey] = (result, now, readAt);
                // Opportunistic eviction, mirroring the season-watched cache in
                // SpoilerBlurImageFilter: snapshot-free, only removes expired.
                if (_collectionScopeCacheFacts.Count > 1024)
                {
                    foreach (var kvp in _collectionScopeCacheFacts)
                    {
                        if ((now - kvp.Value.CachedAt) >= CollectionScopeCacheTtl)
                            _collectionScopeCacheFacts.TryRemove(kvp.Key, out _);
                    }
                }
            }
            return result;
        }

        // Stable memo key for FindOptedInCollectionForMovie: movieId + the
        // SORTED opted-collection GUID set. Returns null (skip caching) when the
        // set is large enough that the key string would be unwieldy — such users
        // are vanishingly rare and simply pay the uncached walk.
        private static string? BuildCollectionScopeKey(UserSpoilerBlur userState, Guid movieId)
        {
            var count = userState.Collections.Count;
            if (count == 0 || count > 64) return null;
            var keys = new string[count];
            userState.Collections.Keys.CopyTo(keys, 0);
            Array.Sort(keys, StringComparer.OrdinalIgnoreCase);
            return movieId.ToString("N") + "|" + string.Join(",", keys);
        }

        // True when the movie is opted in directly OR is a member of an opted-in
        // collection. The single source of truth for movie spoiler scope.
        public bool IsMovieInSpoilerScope(UserSpoilerBlur userState, Guid movieId, IEnumerable<KeyValuePair<string, string>>? providers = null)
        {
            if (movieId == Guid.Empty) return false;
            return userState.Movies.ContainsKey(movieId.ToString("N")) || ProviderScope(userState, movieId, "movie", providers)
                || FindOptedInCollectionForMovie(userState, movieId).HasValue;
        }

        /// <summary>Provider intent is independent of a library copy and remains effective before promotion settles.</summary>
        public static bool ProviderGuarded(UserSpoilerBlur state, string? type, string? tmdb)
        {
            var key = HiddenContentPolicy.TitleIdentity(type, tmdb);
            return key != null && (state.ProviderTitles.ContainsKey(key) || state.PendingTmdb.ContainsKey(key.Replace(":tmdb:", ":", StringComparison.Ordinal)));
        }

        /// <summary>
        /// Spoiler scope of a resolved library identity, decided from the identity alone (never from a DTO's fields): a
        /// movie by its id, a guarded collection that links it, or its TMDB key; a series, season or episode by the owning
        /// series' id or key; an extra (theme song or video, trailer, featurette) by the title that owns it.
        /// </summary>
        public bool InSpoilerScope(UserSpoilerBlur state, PrivacyIdentity identity)
        {
            var key = identity.TitleKey;
            var provider = key != null && (state.ProviderTitles.ContainsKey(key) || state.PendingTmdb.ContainsKey(key.Replace(":tmdb:", ":", StringComparison.Ordinal)));
            var owner = identity.OwnerId.ToString("N");
            switch (identity.Kind)
            {
                case Jellyfin.Data.Enums.BaseItemKind.Movie:
                    return state.Movies.ContainsKey(identity.ItemId.ToString("N")) || provider || FindOptedInCollectionForMovie(state, identity.ItemId).HasValue;
                case Jellyfin.Data.Enums.BaseItemKind.Series or Jellyfin.Data.Enums.BaseItemKind.Season or Jellyfin.Data.Enums.BaseItemKind.Episode:
                    return state.Series.ContainsKey(owner) || provider;
                default:
                    if (!identity.IsExtra) return false;
                    return state.Series.ContainsKey(owner) || state.Movies.ContainsKey(owner) || provider
                        || identity.OwnerKind == Jellyfin.Data.Enums.BaseItemKind.Movie && FindOptedInCollectionForMovie(state, identity.OwnerId).HasValue;
            }
        }

        /// <summary>Series membership shared by native DTO, image and tag owners, including durable provider intent.</summary>
        public bool IsSeriesInSpoilerScope(UserSpoilerBlur state, Guid series, IEnumerable<KeyValuePair<string, string>>? providers = null)
            => state.Series.ContainsKey(series.ToString("N")) || ProviderScope(state, series, "tv", providers);

        private bool ProviderScope(UserSpoilerBlur state, Guid id, string kind, IEnumerable<KeyValuePair<string, string>>? providers)
        {
            using var __factsOperation2 = global::Jellyfin.Plugin.JellyfinEnhanced.Helpers.UserCacheRegistry.BeginOperation();
            if (state.ProviderTitles.Count + state.PendingTmdb.Count == 0) return false;
            if (providers != null) return ProviderGuarded(state, kind, providers.FirstOrDefault(p => p.Key.Equals("Tmdb", StringComparison.OrdinalIgnoreCase)).Value);
            // A remembered key holds while nothing changed the item since it was read; the answer records it as of then, so
            // the delivery gate sees a change after that too. A key read while the item changed is not remembered.
            if (_providerTitlesFacts.TryGetValue(id, out var hit) && DateTime.UtcNow - hit.At <= TimeSpan.FromSeconds(30)
                && (PrivacyInputs.Now == hit.Since || PrivacyInputs.LibraryChangesSince(hit.Since) is { } moved && !moved.Contains(id)))
            {
                PrivacyReadSet.Current?.Library(id, hit.Since);
            }
            else
            {
                var since = PrivacyInputs.Now;
                var item = PrivacyReads.Item(_libraryManager, id);
                hit = (HiddenContentPolicy.TitleIdentity(kind, item?.GetProviderId(MetadataProvider.Tmdb)), DateTime.UtcNow, since);
                if (PrivacyInputs.LibraryChangesSince(since) is { } changed && !changed.Contains(id))
                {
                    if (_providerTitlesFacts.Count >= 8192) _providerTitlesFacts.Clear();
                    _providerTitlesFacts[id] = hit;
                }
                else _providerTitlesFacts.TryRemove(id, out _);
            }
            return hit.Key != null && (state.ProviderTitles.ContainsKey(hit.Key) || state.PendingTmdb.ContainsKey(hit.Key.Replace(":tmdb:", ":", StringComparison.Ordinal)));
        }

        // Resolves the requesting user's GUID via the plugin-wide identity
        // ladder (RequestIdentityService). Returns null when identity is
        // ambiguous (multiple shared-IP candidates) or absent — callers that
        // need a single identity (the field-strip filter) then pass through.
        // The image filter instead uses ResolveCandidateUserIds so it can
        // disambiguate by spoiler scope and fail CLOSED (protect) rather than
        // leak the original bytes.
        public Guid? ResolveUserId(Microsoft.AspNetCore.Http.HttpContext httpContext)
        {
            var candidates = ResolveCandidateUserIds(httpContext);
            // Exactly one candidate = unambiguous (authenticated, marker,
            // cookie, or a single session on the IP). Zero or many = no
            // single safe identity.
            return candidates.Count == 1 ? candidates[0] : (Guid?)null;
        }

        // Resolves the FULL set of plausible requesting users via the
        // identity ladder in RequestIdentityService (ClaimsPrincipal → ?tag=
        // identity marker → je-spoiler-uid cookie → session-by-IP). The image
        // filter walks these and protects the item if ANY candidate opted
        // into it — fail-closed, so an anonymous image request on a shared IP
        // can never leak an opted-in user's unwatched artwork.
        public IReadOnlyList<Guid> ResolveCandidateUserIds(Microsoft.AspNetCore.Http.HttpContext httpContext)
        {
            return _identity.Resolve(httpContext).Candidates;
        }


        // Loads (and caches per-request, keyed by userId) the user's
        // UserSpoilerBlur state. Keying by userId lets the image filter probe
        // several shared-IP candidates in one request without the first one's
        // state masking the others; a request that triggers BOTH filters for
        // the SAME user still reads the file once (shared key).
        /// <summary>
        /// The user's state as of now (a re-read before a request emits): the request's memo is dropped first; the
        /// cross-request copy is invalidated by every write path.
        /// </summary>
        public UserSpoilerBlur LoadUserStateFresh(Microsoft.AspNetCore.Http.HttpContext httpContext, Guid userId)
        {
            httpContext.Items.Remove(ContextKeyUserState + ":" + userId.ToString("N"));
            return LoadUserState(httpContext, userId);
        }

        public UserSpoilerBlur LoadUserState(Microsoft.AspNetCore.Http.HttpContext httpContext, Guid userId)
        {
            var userIdN = userId.ToString("N");
            var cacheKey = ContextKeyUserState + ":" + userIdN;

            // 1. Per-request cache — also lets several shared-IP candidates in one
            //    request each read once without the first masking the others.
            if (httpContext.Items.TryGetValue(cacheKey, out var cached)
                && cached is UserSpoilerBlur hit)
            {
                _userConfigManager.RecordPolicyRead(userIdN, SpoilerBlurImageFilter.SpoilerBlurFileName, hit);
                return hit;
            }

            // 2. F7 cross-request cache — skips the disk read + parse when a
            //    recent copy exists that no write invalidated since it was read.
            //    The ticket is taken before the read.
            var ticket = _userStateCache.Begin();
            if (_userStateCache.TryGet(userIdN, out var known))
            {
                httpContext.Items[cacheKey] = known;
                _userConfigManager.RecordPolicyRead(userIdN, SpoilerBlurImageFilter.SpoilerBlurFileName, known);
                return known;
            }

            // 3. Miss — read from disk.
            UserSpoilerBlur state;
            try
            {
                state = _userConfigManager.GetUserConfiguration<UserSpoilerBlur>(
                    userIdN,
                    SpoilerBlurImageFilter.SpoilerBlurFileName);
            }
            catch (Exception ex)
            {
                // GetUserConfiguration is the LENIENT path — it already
                // swallows IOException + JsonException + parse failures
                // internally and returns `new T()` (it logs at Error level
                // via the config manager's own _logger, so the corruption
                // fact is observable, just not under our namespace). This
                // outer catch-all only fires for exceptions that escape the
                // lenient path (e.g. ResolveUserFile throwing on a bad
                // userId). Rate-limited so a flood of bad requests doesn't
                // spam logs. Do NOT populate the cross-request cache with a
                // spurious empty on this rare escape — only the per-request
                // layer, so a retry re-reads.
                WarnRateLimited(
                    "userstate-load:" + ex.GetType().FullName,
                    $"Spoiler Guard resolver: failed to read user state for {userId} — passing through unblurred. {ex.Message}");
                state = new UserSpoilerBlur();
                httpContext.Items[cacheKey] = state;
                return state;
            }

            // Not kept when a write invalidated this user since the ticket (the
            // state read may be from before it); bounded by the helper.
            _userStateCache.Set(userIdN, ticket, state);
            httpContext.Items[cacheKey] = state;
            return state;
        }

        public void WarnRateLimited(string key, string message)
        {
            var now = DateTime.UtcNow;
            var stored = _warnedAt.AddOrUpdate(key, now,
                (_, last) => (now - last) >= PerKeyWarnInterval ? now : last);
            if (stored != now) return;
            _logger.Warning(message);
        }

        // Track per-user corruption events so the admin can surface a
        // banner in the JE management UI when any user's spoilerblur.json
        // was rolled into the .corrupt-backup file. The file-on-disk has
        // been rewritten with an empty state by UserConfigurationManager
        // (fail-open per SECURITY.md) so the user's image/strip pipeline
        // silently no-ops until they re-enable items. Surfacing this lets
        // the user know to retry.
        private static readonly ConcurrentDictionary<string, CorruptionEvent> _corruptionLog = new();

        public class CorruptionEvent
        {
            public string UserDisplay { get; set; } = string.Empty;
            public DateTime At { get; set; }
            public string Reason { get; set; } = string.Empty;
        }

        public static void RecordCorruption(string userKey, string userDisplay, string reason)
        {
            _corruptionLog[userKey] = new CorruptionEvent
            {
                UserDisplay = userDisplay,
                At = DateTime.UtcNow,
                Reason = reason,
            };
        }

        public static IReadOnlyDictionary<string, CorruptionEvent> GetCorruptionLog()
        {
            return _corruptionLog;
        }

        public static void ClearCorruption(string userKey)
        {
            _corruptionLog.TryRemove(userKey, out _);
        }
        private static readonly global::Jellyfin.Plugin.JellyfinEnhanced.Helpers.UserCacheRegistry.State<ConcurrentDictionary<string, (Guid? CollectionId, DateTime CachedAt, long ReadAt)>> _collectionScopeCacheFactsOwner = new();
        private static ConcurrentDictionary<string, (Guid? CollectionId, DateTime CachedAt, long ReadAt)> _collectionScopeCacheFacts { get => _collectionScopeCacheFactsOwner.Read(ref _collectionScopeCache, () => new(StringComparer.Ordinal)); set => _collectionScopeCacheFactsOwner.Store(ref _collectionScopeCache, value); }
        private readonly global::Jellyfin.Plugin.JellyfinEnhanced.Helpers.UserCacheRegistry.State<ConcurrentDictionary<Guid, (string? Key, DateTime At, long Since)>> _providerTitlesFactsOwner = new();
        private ConcurrentDictionary<Guid, (string? Key, DateTime At, long Since)> _providerTitlesFacts { get => _providerTitlesFactsOwner.Read(ref _providerTitles, () => new()); set => _providerTitlesFactsOwner.Store(ref _providerTitles, value); }
    }
}
