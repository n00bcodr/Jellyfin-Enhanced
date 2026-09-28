using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Threading;
using Jellyfin.Data;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services
{
    // "Apply to existing titles": the admin-triggered, one-shot counterpart
    // of auto-enable on library add. Library add only ever arms titles as
    // Jellyfin CREATES them (ItemAdded), deliberately never on ItemUpdated,
    // so a user who switches Spoiler Guard off for a title is not re-armed by
    // the next metadata refresh or rescan. That means a rescan can't guard a
    // library that already existed (#801). This run does, explicitly:
    //
    //   * scope    — the same saved SpoilerAutoEnableFilter settings (content
    //                types + library allow-list), whether or not the
    //                library-add toggle itself is on
    //   * audience — every user with access to the title's library, disabled
    //                accounts included, exactly like library add
    //   * per user, per title, skipped when the user
    //       - already has an entry (so a re-run changes nothing),
    //       - has fully watched it (movie played; every non-virtual episode
    //         of the series played), or
    //       - has started it, only if the run's SkipStarted option is set. A
    //         partly watched series is where spoilers matter most, so by
    //         default it IS armed.
    //   * writes   — one locked read-modify-write of spoilerblur.json per user
    //                for the whole run, through SpoilerAutoEnableArmer (the
    //                library-add batcher's path). Cancellation is only
    //                observed between users, and each write is an atomic
    //                temp-file swap, so a cancelled run leaves every file
    //                either fully updated or untouched.
    //
    // There is no record of titles a user removed from their list, so an
    // explicit re-run WILL re-arm a title a user switched off since the last
    // run, unless it is skipped as watched (or started, with SkipStarted).
    public sealed class SpoilerExistingTitlesApplier
    {
        private readonly ILibraryManager _libraryManager;
        private readonly IUserManager _userManager;
        private readonly UserConfigurationManager _configManager;
        private readonly Logger _logger;

        // One real run at a time (the scheduled task, however it was started).
        // Dry runs don't take it: they never write.
        private readonly SemaphoreSlim _runGate = new(1, 1);
        private readonly object _stateLock = new();
        private Options? _pendingOptions;
        private DateTime _pendingOptionsAt;
        private Summary? _lastRun;
        private int _completedRuns;

        /// <summary>Per-run options.</summary>
        public sealed class Options
        {
            /// <summary>Also skip titles a user has started (a played or in-progress episode, an in-progress movie).</summary>
            public bool SkipStarted { get; set; }
        }

        /// <summary>What a run did (or, for a dry run, would do) for one user.</summary>
        public sealed class UserSummary
        {
            public string UserId { get; set; } = string.Empty;
            public string UserName { get; set; } = string.Empty;
            public bool IsDisabled { get; set; }
            public int VisibleTitles { get; set; }
            public int Series { get; set; }
            public int Movies { get; set; }
            public int AlreadyArmed { get; set; }
            public int SkippedWatched { get; set; }
            public int SkippedStarted { get; set; }
            public bool Failed { get; set; }
        }

        /// <summary>Whole-run totals plus the per-user breakdown.</summary>
        public sealed class Summary
        {
            public bool DryRun { get; set; }
            public bool SkipStarted { get; set; }
            public int SeriesInScope { get; set; }
            public int MoviesInScope { get; set; }
            public int Users { get; set; }
            public int UsersAffected { get; set; }
            public int SeriesArmed { get; set; }
            public int MoviesArmed { get; set; }
            public int AlreadyArmed { get; set; }
            public int SkippedWatched { get; set; }
            public int SkippedStarted { get; set; }
            public int UsersFailed { get; set; }
            public bool Cancelled { get; set; }
            public string? Error { get; set; }
            public string StartedAt { get; set; } = string.Empty;
            public string? FinishedAt { get; set; }
            public long ElapsedMs { get; set; }
            public List<UserSummary> PerUser { get; set; } = new();
        }

        public SpoilerExistingTitlesApplier(
            ILibraryManager libraryManager,
            IUserManager userManager,
            UserConfigurationManager configManager,
            Logger logger)
        {
            _libraryManager = libraryManager;
            _userManager = userManager;
            _configManager = configManager;
            _logger = logger;
        }

        /// <summary>The last real (non-dry) run since server start, or null.</summary>
        public Summary? LastRun
        {
            get { lock (_stateLock) return _lastRun; }
        }

        /// <summary>
        /// Real runs finished (completed, cancelled or failed) since server
        /// start. Lets the config page tell "its" run's result from an older
        /// one without comparing browser and server clocks.
        /// </summary>
        public int CompletedRuns
        {
            get { lock (_stateLock) return _completedRuns; }
        }

        /// <summary>
        /// Options for the next scheduled-task run (set by the config-page
        /// button right before it starts the task; a run started from
        /// Dashboard > Scheduled Tasks uses the defaults).
        /// </summary>
        public void SetPendingOptions(Options options)
        {
            lock (_stateLock)
            {
                _pendingOptions = options;
                _pendingOptionsAt = DateTime.UtcNow;
            }
        }

        /// <summary>Drops <paramref name="options"/> if they are still the pending ones (their start failed).</summary>
        public void ClearPendingOptions(Options options)
        {
            lock (_stateLock)
            {
                if (ReferenceEquals(_pendingOptions, options)) _pendingOptions = null;
            }
        }

        /// <summary>
        /// Returns and clears the pending options, or the defaults when none
        /// are pending. Options older than a minute are ignored: the task
        /// they were set for never consumed them (e.g. it lost a race with a
        /// dashboard start), and a later dashboard run must get the defaults.
        /// </summary>
        public Options TakePendingOptions()
        {
            lock (_stateLock)
            {
                var options = _pendingOptions != null && DateTime.UtcNow - _pendingOptionsAt < TimeSpan.FromMinutes(1)
                    ? _pendingOptions
                    : new Options();
                _pendingOptions = null;
                return options;
            }
        }

        /// <summary>Counts what a run with <paramref name="options"/> would arm, without writing anything.</summary>
        public Summary Preview(Options options, CancellationToken cancellationToken)
        {
            return Execute(options, dryRun: true, progress: null, cancellationToken);
        }

        /// <summary>
        /// Arms every in-scope existing title for every user with access.
        /// Throws OperationCanceledException when cancelled, and rethrows a
        /// run-level failure, after recording the summary either way, so
        /// Jellyfin marks the task as cancelled / failed.
        /// </summary>
        public Summary Run(Options options, IProgress<double>? progress, CancellationToken cancellationToken)
        {
            if (!_runGate.Wait(0))
            {
                _logger.Warning("SpoilerApplyExisting: a run is already in progress; not starting another.");
                return new Summary { SkipStarted = options.SkipStarted, Error = "A run is already in progress." };
            }
            try
            {
                return Execute(options, dryRun: false, progress, cancellationToken);
            }
            finally
            {
                _runGate.Release();
            }
        }

        private Summary Execute(Options options, bool dryRun, IProgress<double>? progress, CancellationToken ct)
        {
            var sw = Stopwatch.StartNew();
            var summary = new Summary
            {
                DryRun = dryRun,
                SkipStarted = options.SkipStarted,
                StartedAt = DateTime.UtcNow.ToString("o", System.Globalization.CultureInfo.InvariantCulture),
            };

            try
            {
                var cfg = JellyfinEnhanced.Instance?.Configuration;
                if (cfg?.SpoilerBlurEnabled != true)
                {
                    summary.Error = "Spoiler Guard is disabled.";
                    if (!dryRun) _logger.Info("SpoilerApplyExisting: Spoiler Guard is disabled; nothing to do.");
                    return Finish(summary, sw, dryRun);
                }

                var candidates = CollectCandidates(cfg, out var users);
                foreach (var c in candidates)
                {
                    if (c.IsSeries) summary.SeriesInScope++; else summary.MoviesInScope++;
                }
                summary.Users = users.Count;
                progress?.Report(10);

                // Episode totals are user-independent: counted on demand, only
                // for visible series a user has played an episode of, and
                // shared across users for the rest of the run.
                var episodeTotals = new Dictionary<Guid, int>();

                var now = DateTime.UtcNow.ToString("o", System.Globalization.CultureInfo.InvariantCulture);
                for (var i = 0; i < users.Count; i++)
                {
                    ct.ThrowIfCancellationRequested();
                    var user = users[i];
                    var userSummary = ApplyForUser(user, candidates, episodeTotals, options, dryRun, now);
                    summary.PerUser.Add(userSummary);
                    summary.SeriesArmed += userSummary.Series;
                    summary.MoviesArmed += userSummary.Movies;
                    summary.AlreadyArmed += userSummary.AlreadyArmed;
                    summary.SkippedWatched += userSummary.SkippedWatched;
                    summary.SkippedStarted += userSummary.SkippedStarted;
                    if (userSummary.Series + userSummary.Movies > 0) summary.UsersAffected++;
                    if (userSummary.Failed) summary.UsersFailed++;
                    progress?.Report(10 + (90.0 * (i + 1) / users.Count));
                }
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                summary.Cancelled = true;
                Finish(summary, sw, dryRun);
                throw;
            }
            catch (Exception ex)
            {
                summary.Error = ex.Message;
                _logger.Warning($"SpoilerApplyExisting: {(dryRun ? "preview" : "run")} failed: {ex.Message}");
                Finish(summary, sw, dryRun);
                if (dryRun) return summary;
                // An unrequested cancellation (e.g. from the database layer)
                // is a failure, not a user cancel: Jellyfin would otherwise
                // show it as "Cancelled".
                if (ex is OperationCanceledException) throw new InvalidOperationException(ex.Message, ex);
                throw;
            }

            return Finish(summary, sw, dryRun);
        }

        private Summary Finish(Summary summary, Stopwatch sw, bool dryRun)
        {
            summary.ElapsedMs = sw.ElapsedMilliseconds;
            summary.FinishedAt = DateTime.UtcNow.ToString("o", System.Globalization.CultureInfo.InvariantCulture);
            if (!dryRun)
            {
                lock (_stateLock)
                {
                    _lastRun = summary;
                    _completedRuns++;
                }
                if (summary.Error == null)
                {
                    _logger.Info($"SpoilerApplyExisting: {(summary.Cancelled ? "cancelled" : "finished")} in {summary.ElapsedMs} ms: {summary.SeriesInScope} series and {summary.MoviesInScope} movie(s) in scope, {summary.Users} user(s); armed {summary.SeriesArmed} series and {summary.MoviesArmed} movie(s) for {summary.UsersAffected} user(s) ({summary.AlreadyArmed} already guarded, {summary.SkippedWatched} fully watched, {summary.SkippedStarted} started skipped{(summary.SkipStarted ? string.Empty : " [skip started off]")}{(summary.UsersFailed > 0 ? $", {summary.UsersFailed} user(s) failed" : string.Empty)})");
                }
            }
            return summary;
        }

        // Every existing Series/Movie inside the saved auto-enable scope.
        private List<SpoilerAutoEnableArmer.Candidate> CollectCandidates(PluginConfiguration cfg, out List<User> users)
        {
            var allowedLibraries = SpoilerAutoEnableFilter.GetAllowedLibraryIds(cfg);
            users = SpoilerAutoEnableArmer.GetTargetUsers(_userManager, out var anyRestrictedUser);
            var candidates = new List<SpoilerAutoEnableArmer.Candidate>();

            var types = new List<BaseItemKind>(2);
            if (SpoilerAutoEnableFilter.AllowsType(cfg, isSeries: true)) types.Add(BaseItemKind.Series);
            if (SpoilerAutoEnableFilter.AllowsType(cfg, isSeries: false)) types.Add(BaseItemKind.Movie);
            if (types.Count == 0 || users.Count == 0) return candidates;

            var needLibraryIds = allowedLibraries != null || anyRestrictedUser;
            // Every item, not one per presentation key: the same show in two
            // libraries is two items, and users may only see one of them.
            var items = _libraryManager.GetItemList(new InternalItemsQuery
            {
                IncludeItemTypes = types.ToArray(),
                IsVirtualItem = false,
                Recursive = true,
                GroupByPresentationUniqueKey = false,
            });
            foreach (var item in items)
            {
                var candidate = SpoilerAutoEnableArmer.TryBuildCandidate(_libraryManager, item, cfg, allowedLibraries, needLibraryIds);
                if (candidate != null) candidates.Add(candidate);
            }
            return candidates;
        }

        private UserSummary ApplyForUser(
            User user,
            List<SpoilerAutoEnableArmer.Candidate> candidates,
            Dictionary<Guid, int> episodeTotals,
            Options options,
            bool dryRun,
            string now)
        {
            var userKey = user.Id.ToString("N");
            var result = new UserSummary
            {
                UserId = userKey,
                UserName = user.Username ?? string.Empty,
                IsDisabled = user.HasPermission(Jellyfin.Database.Implementations.Enums.PermissionKind.IsDisabled),
            };

            var visible = SpoilerAutoEnableArmer.VisibleTo(user, candidates);
            result.VisibleTitles = visible.Count;
            if (visible.Count == 0) return result;

            try
            {
                var skip = BuildSkipRule(user, visible, episodeTotals, options.SkipStarted);
                var armed = SpoilerAutoEnableArmer.ArmForUser(_configManager, userKey, visible, skip, dryRun, now);
                result.Series = armed.Series;
                result.Movies = armed.Movies;
                result.AlreadyArmed = armed.AlreadyArmed;
                result.SkippedWatched = armed.SkippedWatched;
                result.SkippedStarted = armed.SkippedStarted;
            }
            catch (InvalidDataException ex)
            {
                result.Failed = true;
                _logger.Warning($"SpoilerApplyExisting: skipping user {userKey} due to corrupt spoilerblur.json: {ex.Message}");
                return result;
            }
            catch (Exception ex)
            {
                result.Failed = true;
                _logger.Warning($"SpoilerApplyExisting: {(dryRun ? "preview" : "write")} for user {userKey} failed: {ex.Message}");
                return result;
            }

            if (!dryRun)
            {
                var skipped = $"{result.AlreadyArmed} already guarded, {result.SkippedWatched} fully watched, {result.SkippedStarted} started skipped";
                _logger.Info(result.Series + result.Movies > 0
                    ? $"SpoilerApplyExisting: enabled Spoiler Guard for {result.Series} existing series and {result.Movies} existing movie(s) for user {userKey} ('{result.UserName}') in one write ({skipped})"
                    : $"SpoilerApplyExisting: nothing new for user {userKey} ('{result.UserName}'), no write ({skipped})");
            }
            return result;
        }

        // Watched / started state for the titles this user can see, from a
        // handful of per-user queries (not one UserData read per title).
        private Func<SpoilerAutoEnableArmer.Candidate, SpoilerAutoEnableArmer.SkipReason> BuildSkipRule(
            User user,
            List<SpoilerAutoEnableArmer.Candidate> visible,
            Dictionary<Guid, int> episodeTotals,
            bool skipStarted)
        {
            var anySeries = false;
            var anyMovies = false;
            foreach (var c in visible)
            {
                if (c.IsSeries) anySeries = true; else anyMovies = true;
            }

            HashSet<Guid>? playedMovies = null, resumableMovies = null;
            if (anyMovies)
            {
                playedMovies = QueryIds(user, BaseItemKind.Movie, isPlayed: true, isResumable: null);
                if (skipStarted) resumableMovies = QueryIds(user, BaseItemKind.Movie, isPlayed: null, isResumable: true);
            }

            Dictionary<Guid, int>? playedEpisodes = null, resumableEpisodes = null;
            if (anySeries)
            {
                playedEpisodes = CountEpisodesBySeries(user, isPlayed: true, isResumable: null);
                if (skipStarted) resumableEpisodes = CountEpisodesBySeries(user, isPlayed: null, isResumable: true);

                // "Fully watched" needs the series' episode total, but only
                // for series this user has played something of. Resolve them
                // here, outside the per-user file lock the rule runs under.
                foreach (var c in visible)
                {
                    if (c.IsSeries && playedEpisodes.ContainsKey(c.Id) && !episodeTotals.ContainsKey(c.Id))
                    {
                        episodeTotals[c.Id] = CountEpisodes(c.Id);
                    }
                }
            }

            return c =>
            {
                if (c.IsSeries)
                {
                    var played = playedEpisodes != null && playedEpisodes.TryGetValue(c.Id, out var p) ? p : 0;
                    var total = played > 0 && episodeTotals.TryGetValue(c.Id, out var t) ? t : 0;
                    if (total > 0 && played >= total) return SpoilerAutoEnableArmer.SkipReason.Watched;
                    if (skipStarted && (played > 0 || (resumableEpisodes != null && resumableEpisodes.ContainsKey(c.Id))))
                    {
                        return SpoilerAutoEnableArmer.SkipReason.Started;
                    }
                    return SpoilerAutoEnableArmer.SkipReason.None;
                }

                if (playedMovies != null && playedMovies.Contains(c.Id)) return SpoilerAutoEnableArmer.SkipReason.Watched;
                if (skipStarted && resumableMovies != null && resumableMovies.Contains(c.Id)) return SpoilerAutoEnableArmer.SkipReason.Started;
                return SpoilerAutoEnableArmer.SkipReason.None;
            };
        }

        private HashSet<Guid> QueryIds(User user, BaseItemKind kind, bool? isPlayed, bool? isResumable)
        {
            // Ids only; no need to materialise the items.
            return new HashSet<Guid>(_libraryManager.GetItemIds(new InternalItemsQuery(user)
            {
                IncludeItemTypes = new[] { kind },
                IsVirtualItem = false,
                IsPlayed = isPlayed,
                IsResumable = isResumable,
                Recursive = true,
                GroupByPresentationUniqueKey = false,
            }));
        }

        // Non-virtual (i.e. actually present) episodes of one series, as a
        // COUNT query rather than loading the items.
        private int CountEpisodes(Guid seriesId)
        {
            return _libraryManager.GetItemsResult(new InternalItemsQuery
            {
                AncestorIds = new[] { seriesId },
                IncludeItemTypes = new[] { BaseItemKind.Episode },
                IsVirtualItem = false,
                Recursive = true,
                GroupByPresentationUniqueKey = false,
                Limit = 0,
                EnableTotalRecordCount = true,
            }).TotalRecordCount;
        }

        // The user's played / in-progress non-virtual episodes, counted per
        // series id.
        private Dictionary<Guid, int> CountEpisodesBySeries(User user, bool? isPlayed, bool? isResumable)
        {
            var query = new InternalItemsQuery(user)
            {
                IncludeItemTypes = new[] { BaseItemKind.Episode },
                IsVirtualItem = false,
                IsPlayed = isPlayed,
                IsResumable = isResumable,
                Recursive = true,
                GroupByPresentationUniqueKey = false,
            };

            var counts = new Dictionary<Guid, int>();
            foreach (var item in _libraryManager.GetItemList(query))
            {
                if (item is not Episode episode || episode.SeriesId == Guid.Empty) continue;
                counts[episode.SeriesId] = counts.TryGetValue(episode.SeriesId, out var n) ? n + 1 : 1;
            }
            return counts;
        }
    }
}
