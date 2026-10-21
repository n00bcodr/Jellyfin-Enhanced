using System;
using System.Collections.Concurrent;
using System.Linq;
using Jellyfin.Data.Enums;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services
{
    /// <summary>
    /// Episode category relative to the user's next-unwatched boundary of a
    /// guarded series. <see cref="Other"/> is the fail-closed default: any
    /// episode whose category cannot be established keeps the full strip.
    /// </summary>
    public enum SpoilerEpisodeCategory
    {
        /// <summary>Full strip — later seasons, skipped earlier seasons, specials, or unknown.</summary>
        Other = 0,

        /// <summary>The user's first unwatched regular episode in (season, episode) order.</summary>
        NextEpisode = 1,

        /// <summary>Another unwatched episode in the same season as the next episode.</summary>
        CurrentSeason = 2,
    }

    /// <summary>
    /// What an advanced-mode category reveals of an unwatched guarded episode (each flag exempts one field from a strip the
    /// base switches apply; none by default): the one per-item reveal every representation of the episode uses (its item
    /// answers, search hints, the activity log, tag data, images).
    /// </summary>
    public readonly record struct SpoilerCategoryReveal(bool Title, bool Overview, bool Ratings)
    {
        /// <summary>The reveal of <paramref name="category"/> under the administrator's settings.</summary>
        public static SpoilerCategoryReveal Of(SpoilerEpisodeCategory category, Configuration.PluginConfiguration cfg) => category switch
        {
            SpoilerEpisodeCategory.NextEpisode => new(!cfg.SpoilerNextEpisodeStripTitle, !cfg.SpoilerNextEpisodeStripOverview, !cfg.SpoilerNextEpisodeStripRatings),
            SpoilerEpisodeCategory.CurrentSeason => new(!cfg.SpoilerCurrentSeasonStripTitle, !cfg.SpoilerCurrentSeasonStripOverview, !cfg.SpoilerCurrentSeasonStripRatings),
            _ => default,
        };
    }

    /// <summary>
    /// Owns the per-(user, series) "next unwatched episode" boundary used by the
    /// advanced Spoiler Guard category reveals. "Next" is deliberately the first
    /// unwatched non-special episode in (ParentIndexNumber, IndexNumber) order —
    /// simpler and more predictable for spoiler purposes than Jellyfin NextUp's
    /// rewatch-aware ordering, and stable for a user who watches in order.
    ///
    /// The strip filter consumes this as an amortized in-memory lookup; a cache
    /// miss costs one series-scoped Limit=1 library query (the same bounded shape
    /// as TagCacheService.GetFirstEpisode). Watched-state changes evict the
    /// affected key via IUserDataManager.UserDataSaved; library mutations are
    /// covered by the TTL alone — a stale boundary can only mis-categorize the
    /// episode the user is about to watch between reveal tiers, never bypass a
    /// base strip, so a bounded staleness window is acceptable.
    /// </summary>
    public sealed class SpoilerNextUnwatchedService : IDisposable
    {
        /// <summary>The next-unwatched episode's identity and position.</summary>
        public readonly record struct NextUnwatchedBoundary(Guid EpisodeId, int SeasonNumber, int EpisodeNumber);

        private readonly record struct CacheSlot(NextUnwatchedBoundary? Boundary, long ExpiresAtTicks, PrivacyReadSet.Evidence Evidence, long ReadAt);

        // Boundary cache keyed (userId, seriesId). Worst case is
        // f(users × guarded series) but hard-capped at MaxCacheEntries slots of
        // ~72 bytes (two Guids + a nullable record struct + expiry) ≈ 150 KiB —
        // bounded independent of library size. Overflow clears the whole map
        // (recompute is one bounded query per active key); TTL keeps entries
        // from outliving library changes.
        private readonly ConcurrentDictionary<(Guid UserId, Guid SeriesId), CacheSlot> _cache = new();

        internal const int MaxCacheEntries = 2048;
        internal static readonly TimeSpan CacheTtl = TimeSpan.FromMinutes(5);

        private readonly ILibraryManager _libraryManager;
        private readonly IUserManager _userManager;
        private readonly IUserDataManager _userDataManager;
        private readonly Logger _logger;
        private int _computeFailureLogBudget = 5;

        // Test / diagnostic seams: substitute the boundary computation (no live
        // library) and the clock (deterministic TTL expiry).
        internal Func<Guid, Guid, NextUnwatchedBoundary?>? BoundaryComputerForTest { get; set; }

        internal Func<long>? ClockTicksForTest { get; set; }

        public SpoilerNextUnwatchedService(
            ILibraryManager libraryManager,
            IUserManager userManager,
            IUserDataManager userDataManager,
            Logger logger)
        {
            _libraryManager = libraryManager;
            _userManager = userManager;
            _userDataManager = userDataManager;
            _logger = logger;
            _userDataManager.UserDataSaved += OnUserDataSaved;
        }

        // This service is a Singleton subscribed to
        // IUserDataManager.UserDataSaved. Without an unsubscribe path,
        // hot-reload / plugin disable+re-enable leaks the handler delegate
        // (matches the SpoilerBlurImageFilter pattern).
        private bool _disposed;

        public void Dispose()
        {
            if (_disposed) return;
            _disposed = true;
            try
            {
                _userDataManager.UserDataSaved -= OnUserDataSaved;
            }
            catch (Exception ex)
            {
                _logger.Warning($"SpoilerNextUnwatchedService: unsubscribe on Dispose threw: {ex.Message}");
            }
        }

        /// <summary>
        /// Resolve the next-unwatched boundary for a user's guarded series.
        /// Returns null (⇒ every episode categorizes as <see cref="SpoilerEpisodeCategory.Other"/>,
        /// full strip) when the series has no unwatched regular episode or on any
        /// resolution failure — fail-closed toward the base behavior.
        /// </summary>
        public NextUnwatchedBoundary? GetBoundary(Guid userId, Guid seriesId)
        {
            if (userId == Guid.Empty || seriesId == Guid.Empty) return null;

            // The per-item cost on the strip path is this dictionary hit; the
            // bounded query below runs once per (user, series) per TTL window /
            // watched-state change, amortizing to O(1) per item.
            var now = ClockTicksForTest?.Invoke() ?? DateTime.UtcNow.Ticks;
            var key = (userId, seriesId);
            // The boundary is the result of the user's next-unwatched query over the series: a fact of the answer, compared
            // with the same query at every check. A remembered boundary replays that fact (and is dropped when a check
            // finds it no longer holds); events and its time only schedule a refresh.
            if (_cache.TryGetValue(key, out var slot) && slot.ExpiresAtTicks > now && !PrivacyInputs.ScopeChangedSince(slot.ReadAt, userId, seriesId))
            {
                PrivacyReadSet.ReplayCurrent(slot.Evidence, () => _cache.TryRemove(key, out _));
                return slot.Boundary;
            }

            var readAt = PrivacyInputs.Now;
            var boundary = PrivacyReadSet.Capture(() => Read(userId, seriesId, BoundaryComputerForTest ?? ComputeBoundary), out var evidence);

            if (_cache.Count >= MaxCacheEntries)
            {
                // Hard bound. Clearing everything is deliberate — a partial
                // eviction policy is extra state for a map that refills at one
                // bounded query per active key.
                _cache.Clear();
            }

            // Only a boundary that was read (not a failed computation) is remembered.
            if (evidence.Consistent && boundary.Read && !PrivacyInputs.ScopeChangedSince(readAt, userId, seriesId)) _cache[key] = new CacheSlot(boundary.Boundary, now + CacheTtl.Ticks, evidence, readAt);
            else _cache.TryRemove(key, out _);
            return boundary.Boundary;
        }

        private static string Text(NextUnwatchedBoundary? boundary)
            => boundary is { } b ? b.EpisodeId.ToString("N") + ":" + b.SeasonNumber.ToString(System.Globalization.CultureInfo.InvariantCulture) + ":" + b.EpisodeNumber.ToString(System.Globalization.CultureInfo.InvariantCulture) : "-";

        /// <summary>
        /// The boundary computed now, recorded as a fact (the query's result, with how to run it again); a failed computation
        /// is the fail-closed null boundary (no reveal) and records nothing, since a full strip depends on no input.
        /// </summary>
        private static (NextUnwatchedBoundary? Boundary, bool Read) Read(Guid userId, Guid seriesId, Func<Guid, Guid, NextUnwatchedBoundary?> compute)
        {
            NextUnwatchedBoundary? boundary;
            try { boundary = PrivacyReadSet.Unrecorded(() => compute(userId, seriesId)); }
            catch (Exception) { return (null, false); }
            PrivacyReads.Query("next:" + userId.ToString("N") + ":" + seriesId.ToString("N"), Text(boundary), () =>
            {
                try { return Text(compute(userId, seriesId)); }
                catch (Exception) { return null; }
            });
            return (boundary, true);
        }

        /// <summary>
        /// An unwatched guarded episode's advanced category for a viewer: <see cref="SpoilerEpisodeCategory.Other"/> unless the
        /// administrator turned advanced mode on and the viewer kept it (the same gate order every representation uses).
        /// </summary>
        public SpoilerEpisodeCategory CategoryOf(Guid userId, Configuration.UserSpoilerBlur state, Configuration.PluginConfiguration cfg,
            Guid seriesId, Guid episodeId, int? parentIndexNumber, int? indexNumber)
            => !cfg.SpoilerAdvancedMode || state.Prefs?.UseAdvancedCategories == false ? SpoilerEpisodeCategory.Other
                : Categorize(GetBoundary(userId, seriesId), episodeId, parentIndexNumber, indexNumber);

        /// <summary>
        /// Pure categorization of an episode DTO against a boundary. Validation
        /// runs before any identity match: missing index numbers, season 0
        /// (specials), or a null boundary all resolve to
        /// <see cref="SpoilerEpisodeCategory.Other"/> (full strip) even when the
        /// DTO id equals the boundary episode — a DTO that cannot prove it is a
        /// well-formed regular episode never earns a reveal. NextEpisode is
        /// granted only by the authoritative episode id; a different episode
        /// that merely shares the boundary's season/episode numbers (duplicate
        /// numbering, alternate versions) gets at most the CurrentSeason mask.
        /// </summary>
        public static SpoilerEpisodeCategory Categorize(
            NextUnwatchedBoundary? boundary,
            Guid episodeId,
            int? parentIndexNumber,
            int? indexNumber)
        {
            if (boundary is not { } b) return SpoilerEpisodeCategory.Other;
            if (parentIndexNumber is not int season || season <= 0) return SpoilerEpisodeCategory.Other;
            if (indexNumber is not int) return SpoilerEpisodeCategory.Other;
            if (episodeId != Guid.Empty && episodeId == b.EpisodeId) return SpoilerEpisodeCategory.NextEpisode;
            return season == b.SeasonNumber
                ? SpoilerEpisodeCategory.CurrentSeason
                : SpoilerEpisodeCategory.Other;
        }

        private NextUnwatchedBoundary? ComputeBoundary(Guid userId, Guid seriesId)
        {
            try
            {
                var user = _userManager.GetUserById(userId);
                if (user == null) return null;
                return Compute(_libraryManager, user, seriesId);
            }
            catch (Exception ex)
            {
                // Fail closed (null ⇒ full strip; the caller records nothing for a failure). Bounded logging so a
                // persistent library fault can't flood the log from a hot request path.
                if (_computeFailureLogBudget > 0)
                {
                    _computeFailureLogBudget--;
                    _logger.Warning($"Spoiler Guard next-unwatched boundary failed for series {seriesId}; falling back to full strip: {ex.Message}");
                }

                throw;
            }
        }

        /// <summary>
        /// The boundary computed now, unremembered (a site without the shared service): its inputs are recorded as the
        /// remembered one's are.
        /// </summary>
        public static NextUnwatchedBoundary? ComputeNow(ILibraryManager library, JUser user, Guid seriesId)
        {
            if (seriesId == Guid.Empty) return null;
            return Read(user.Id, seriesId, (_, series) => Compute(library, user, series)).Boundary;
        }

        private static NextUnwatchedBoundary? Compute(ILibraryManager libraryManager, JUser user, Guid seriesId)
        {
            // Series-scoped, Limit=1, sorted server-side — the same bounded
            // single-item shape as TagCacheService.GetFirstEpisode.
            // ParentIndexNumberNotEquals=0 excludes specials so a pile of
            // unwatched specials can't pin the boundary to Season 0.
            // Both target Jellyfin lines (10.11 / 12) expose
            // ParentIndexNumberNotEquals and the (ItemSortBy, SortOrder)
            // tuple OrderBy, so no per-TFM shim is needed here.
            var query = new InternalItemsQuery(user)
            {
                ParentId = seriesId,
                IncludeItemTypes = new[] { BaseItemKind.Episode },
                Recursive = true,
                IsPlayed = false,
                IsVirtualItem = false,
                ParentIndexNumberNotEquals = 0,
                Limit = 1,
                OrderBy = new[]
                {
                    (ItemSortBy.ParentIndexNumber, JSortOrder.Ascending),
                    (ItemSortBy.IndexNumber, JSortOrder.Ascending),
                    (ItemSortBy.SortName, JSortOrder.Ascending),
                },
            };

            if (libraryManager.GetItemList(query).FirstOrDefault() is not Episode first) return null;
            if (first.ParentIndexNumber is not int season || season <= 0) return null;
            if (first.IndexNumber is not int episode) return null;
            return new NextUnwatchedBoundary(first.Id, season, episode);
        }

        // Fires on every user-data save (playback ticks included). O(1)
        // in-memory eviction only — no DB lookup, no I/O. SeriesId is an
        // in-memory property on the Episode entity carried by the event args,
        // so this stays cheap enough to run inline on the publish thread.
        private void OnUserDataSaved(object? sender, UserDataSaveEventArgs e)
        {
            if (e == null || e.UserId == Guid.Empty) return;
            if (e.Item is Episode episode && episode.SeriesId != Guid.Empty)
            {
                _cache.TryRemove((e.UserId, episode.SeriesId), out _);
            }
            else if (e.Item is Series series)
            {
                _cache.TryRemove((e.UserId, series.Id), out _);
            }
        }
    }
}
