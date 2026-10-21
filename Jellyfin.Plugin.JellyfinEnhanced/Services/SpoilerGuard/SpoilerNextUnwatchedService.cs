using System;
using System.Collections.Concurrent;
using System.Linq;
using System.Threading;
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
    /// as TagCacheService.GetFirstEpisode). A cached boundary is used only while
    /// everything that decides it is unchanged, because a stale one is not safe:
    /// it can give an episode the reveal of the category it no longer has (a
    /// later episode keeps "next episode" and shows its title after an earlier
    /// one became visible). So each slot is keyed by
    /// <list type="bullet">
    /// <item><description>the viewer as this request read them
    /// (<see cref="Helpers.UserAuthority.Fingerprint"/>: library, channel and
    /// parental access decide which episodes the query sees), so a change made
    /// with no event and no bracket still recomputes before the next reveal;</description></item>
    /// <item><description>the viewer's own Jellyfin user version;</description></item>
    /// <item><description>the series, which Jellyfin's item added / removed /
    /// updated events for the series, its seasons and episodes (an episode
    /// added, deleted, renumbered or re-rated) invalidate for everyone, and
    /// the viewer's watched-state saves (IUserDataManager.UserDataSaved) for
    /// them.</description></item>
    /// </list>
    /// All of it through <see cref="Helpers.UserAccessCache{TKey, TValue}"/>:
    /// a computation running when any of those changes never leaves a slot
    /// that is served.
    /// The TTL bounds only what none of those see (a change written straight
    /// into Jellyfin's database).
    /// </summary>
    public sealed class SpoilerNextUnwatchedService : IDisposable
    {
        /// <summary>The next-unwatched episode's identity and position.</summary>
        public readonly record struct NextUnwatchedBoundary(Guid EpisodeId, int SeasonNumber, int EpisodeNumber);

        private readonly record struct CacheSlot(NextUnwatchedBoundary? Boundary, long ReadAt);

        // Boundary cache keyed (userId, seriesId), on UserAccessCache: each slot
        // holds the viewer's fingerprint and version as this request read them,
        // and depends on the series (scope), which Jellyfin's library events and
        // the viewer's watched-state saves invalidate; a computation running
        // when one lands never leaves a slot that is served. Hard-capped at
        // MaxCacheEntries slots (overflow drops the dead ones, then everything:
        // recompute is one bounded query per active key). A slot keeps when its
        // boundary was read: the read-set records a remembered boundary's inputs
        // as of then.
        private readonly Helpers.UserAccessCache<(Guid UserId, Guid SeriesId), CacheSlot> _cache;

        internal const int MaxCacheEntries = 2048;
        internal static readonly TimeSpan CacheTtl = TimeSpan.FromMinutes(5);

        private readonly ILibraryManager _libraryManager;
        private readonly IUserManager _userManager;
        private readonly IUserDataManager _userDataManager;
        private readonly Logger _logger;
        private int _computeFailureLogBudget = 5;

        // Test / diagnostic seam: substitute the boundary computation (no live
        // library). The clock is the helper's (Helpers.MonotonicClock).
        internal Func<Guid, Guid, NextUnwatchedBoundary?>? BoundaryComputerForTest { get; set; }

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
            _cache = new Helpers.UserAccessCache<(Guid UserId, Guid SeriesId), CacheSlot>(CacheTtl, MaxCacheEntries);
            _userDataManager.UserDataSaved += OnUserDataSaved;
            _libraryManager.ItemAdded += OnLibraryChanged;
            _libraryManager.ItemRemoved += OnLibraryChanged;
            _libraryManager.ItemUpdated += OnLibraryChanged;
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
                _libraryManager.ItemAdded -= OnLibraryChanged;
                _libraryManager.ItemRemoved -= OnLibraryChanged;
                _libraryManager.ItemUpdated -= OnLibraryChanged;
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
        /// <param name="userId">The viewer.</param>
        /// <param name="seriesId">The guarded series.</param>
        /// <param name="viewer">The viewer as this request already read them, if it did; else they are read once per
        /// request (<see cref="Helpers.UserAuthority.ReadOncePerRequest"/>).</param>
        public NextUnwatchedBoundary? GetBoundary(Guid userId, Guid seriesId, JUser? viewer = null)
        {
            if (userId == Guid.Empty || seriesId == Guid.Empty) return null;

            // The per-item cost on the strip path is this dictionary hit plus
            // the viewer's fingerprint (one read of the viewer per request); the
            // bounded query below runs once per (user, series) while nothing that
            // decides the boundary changes, amortizing to O(1) per item.
            // The boundary is the user's watched state over the series' episodes (and their numbering): recorded in the
            // attempt's read-set, as of when it was computed.
            var reads = PrivacyReadSet.Current;
            reads?.Watched(userId, seriesId);
            reads?.Library(seriesId);
            reads?.ChildrenOf(seriesId);
            var user = viewer;
            Helpers.UserAccessCache<(Guid UserId, Guid SeriesId), CacheSlot>.Ticket ticket;
            // Taken before the query, so a change landing during it is never
            // served later: filed under the fingerprint of the user it is
            // computed from. No such user: the slot stands for that, filed
            // under the version that read was made under.
            if (user != null)
            {
                ticket = _cache.Begin(user, seriesId);
            }
            else
            {
                var read = Helpers.UserAuthority.ReadOncePerRequest(userId, _userManager.GetUserById);
                user = read.User;
                ticket = user != null ? _cache.Begin(user, read.Stamp, seriesId) : _cache.BeginHeld(userId, read.Stamp, seriesId);
            }

            var key = (userId, seriesId);
            // A remembered boundary holds while nothing it was read from changed (an episode added, moved, renumbered or
            // removed, or the user's watched state in the series), not merely until its time runs out.
            if (_cache.TryGet(key, ticket.Authority, out var slot) && !PrivacyInputs.ScopeChangedSince(slot.ReadAt, userId, seriesId))
            {
                // The remembered boundary's own inputs, as of when it was read (nothing else in the answer is backdated).
                reads?.Watched(userId, seriesId, slot.ReadAt);
                reads?.Library(seriesId, slot.ReadAt);
                reads?.ChildrenOf(seriesId, slot.ReadAt);
                return slot.Boundary;
            }

            var readAt = PrivacyInputs.Now;
            var boundary = BoundaryComputerForTest != null
                ? BoundaryComputerForTest(userId, seriesId)
                : ComputeBoundary(user, seriesId);

            // A boundary read while its inputs changed is not remembered (the next ask reads it again).
            if (!PrivacyInputs.ScopeChangedSince(readAt, userId, seriesId)) _cache.Set(key, ticket, new CacheSlot(boundary, readAt));
            return boundary;
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

        private NextUnwatchedBoundary? ComputeBoundary(JUser? user, Guid seriesId)
        {
            try
            {
                if (user == null) return null;
                return Compute(_libraryManager, user, seriesId);
            }
            catch (Exception ex)
            {
                // Fail closed (null ⇒ full strip). Bounded logging so a
                // persistent library fault can't flood the log from a hot
                // request path.
                if (_computeFailureLogBudget > 0)
                {
                    _computeFailureLogBudget--;
                    _logger.Warning($"Spoiler Guard next-unwatched boundary failed for series {seriesId}; falling back to full strip: {ex.Message}");
                }

                return null;
            }
        }

        /// <summary>
        /// The boundary computed now, unremembered (a site without the shared service): its inputs are recorded as the
        /// remembered one's are.
        /// </summary>
        public static NextUnwatchedBoundary? ComputeNow(ILibraryManager library, JUser user, Guid seriesId)
        {
            if (seriesId == Guid.Empty) return null;
            var reads = PrivacyReadSet.Current;
            reads?.Watched(user.Id, seriesId);
            reads?.Library(seriesId);
            reads?.ChildrenOf(seriesId);
            try { return Compute(library, user, seriesId); }
            catch (Exception) { return null; }
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

        // An episode, season or the series itself added, removed or updated
        // (numbering, rating, a new file): the series' boundaries are computed
        // again. O(1); runs inline on Jellyfin's event thread.
        private void OnLibraryChanged(object? sender, ItemChangeEventArgs e)
        {
            var seriesId = e?.Item switch
            {
                Episode episode => episode.SeriesId,
                Season season => season.SeriesId,
                Series series => series.Id,
                _ => Guid.Empty,
            };
            if (seriesId == Guid.Empty) return;
            _cache.Invalidate(Guid.Empty, seriesId);
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
                _cache.Invalidate(e.UserId, episode.SeriesId);
            }
            else if (e.Item is Series series)
            {
                _cache.Invalidate(e.UserId, series.Id);
            }
        }
    }
}
