using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Model.Arr;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr.Live;
using Microsoft.Extensions.Hosting;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests
{
    /// <summary>
    /// "Keep getting new episodes" costs one request per new season (D16): when a Sonarr library read shows a
    /// season after the one asked for that is monitored and has started (an aired episode or a file) on a series
    /// a Keep-getting request went to, the request's owner is charged 1 for it, once. Sonarr is already fetching
    /// it by then, so an overdraft is allowed (it counts against the next window and shows in Household). Only
    /// requests Jellyfin Enhanced sent to Sonarr itself (Seerr mode: see below), only on the instance and connection they
    /// went to, only while phase 3 is on and the setting allows it; followers
    /// are free, and a season someone else asked for explicitly is theirs to pay for.
    /// Seerr mode: Seerr doesn't follow new seasons, so every few hours (one read of Seerr's series details per
    /// followed title) each sent Keep-getting request on the current Seerr gets one request to Seerr, as its owner,
    /// for each season after the one asked for that has started and that nobody has requested in its edition yet
    /// (not one Seerr declined): charged once as above, held with Seerr's reason when Seerr refuses (the request then
    /// waits for an OK, and approving it sends the season again). See <see cref="FollowSeerrAsync"/>.
    /// </summary>
    public sealed class FutureSeasonCharges : IHostedService
    {
        private readonly ArrStateStore _store;
        private readonly RequestLedger _ledger;
        private readonly IRequestPolicy _policy;
        private readonly ArrClientFactory _clients;
        private readonly ArrChangeFeed? _feed;
        private readonly TitleAliases? _aliases;
        private readonly Logger? _logger;
        private readonly Func<DateTimeOffset> _now;
        private readonly SeerrBackend? _seerr;
        private readonly SeerrRequestReadModel? _seerrModel;
        private readonly RequestOutboxSignal? _signal;
        private readonly object _gate = new();
        private readonly SemaphoreSlim _following = new(1, 1);
        private int _subscribed;
        private CancellationTokenSource? _loop;
        private Task? _loopTask;

        /// <summary>How often Seerr is asked about the seasons of followed series (Seerr mode).</summary>
        internal static readonly TimeSpan SeerrFollowEvery = TimeSpan.FromHours(6);

        /// <summary>How long after start the first Seerr-mode check runs (the server settles first).</summary>
        internal static readonly TimeSpan SeerrFollowFirst = TimeSpan.FromMinutes(5);

        /// <summary>The charger (DI).</summary>
        public FutureSeasonCharges(ArrStateStore store, RequestLedger ledger, IRequestPolicy policy, ArrClientFactory clients, ArrChangeFeed feed, TitleAliases aliases, Logger logger,
            SeerrBackend seerr, SeerrRequestReadModel seerrModel, RequestOutboxSignal signal)
            : this(store, ledger, policy, clients, feed, aliases, logger, () => DateTimeOffset.UtcNow, seerr, seerrModel, signal)
        {
        }

        /// <summary>The charger with an explicit clock (tests).</summary>
        internal FutureSeasonCharges(ArrStateStore store, RequestLedger ledger, IRequestPolicy policy, ArrClientFactory clients, ArrChangeFeed? feed, TitleAliases? aliases, Logger? logger, Func<DateTimeOffset> now,
            SeerrBackend? seerr = null, SeerrRequestReadModel? seerrModel = null, RequestOutboxSignal? signal = null)
        {
            _store = store;
            _ledger = ledger;
            _policy = policy;
            _clients = clients;
            _feed = feed;
            _aliases = aliases;
            _logger = logger;
            _now = now;
            _seerr = seerr;
            _seerrModel = seerrModel;
            _signal = signal;
        }

        /// <summary>Test seam: the background check started for a library change (null when none started).</summary>
        internal Action<Task>? Started { get; set; }

        /// <inheritdoc />
        public Task StartAsync(CancellationToken cancellationToken)
        {
            Subscribe();
            if (_seerr != null && _seerrModel != null && _loop == null)
            {
                _loop = new CancellationTokenSource();
                var token = _loop.Token;
                _loopTask = Task.Run(() => FollowLoopAsync(token), CancellationToken.None);
            }
            return Task.CompletedTask;
        }

        /// <inheritdoc />
        public async Task StopAsync(CancellationToken cancellationToken)
        {
            if (Interlocked.Exchange(ref _subscribed, 0) == 1) _store.SnapshotChanged -= OnSnapshotChanged;
            var loop = Interlocked.Exchange(ref _loop, null);
            if (loop == null) return;
            await loop.CancelAsync().ConfigureAwait(false);
            try
            {
                if (_loopTask != null) await _loopTask.WaitAsync(cancellationToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                // Stopping.
            }
            finally
            {
                loop.Dispose();
            }
        }

        // Seerr mode: a check soon after start, then every few hours. Each check reads Seerr only for followed titles.
        private async Task FollowLoopAsync(CancellationToken ct)
        {
            var wait = SeerrFollowFirst;
            while (!ct.IsCancellationRequested)
            {
                try
                {
                    await Task.Delay(wait, ct).ConfigureAwait(false);
                    if (await FollowSeerrAsync(ct).ConfigureAwait(false) > 0) _signal?.Pulse();
                }
                catch (OperationCanceledException) when (ct.IsCancellationRequested)
                {
                    return;
                }
                catch (Exception ex)
                {
                    _logger?.Warning($"Requests: following new seasons of Keep getting requests in Seerr failed ({ex.GetType().Name}).");
                }

                wait = SeerrFollowEvery;
            }
        }

        /// <summary>Starts following the store's library reads (tests call it directly).</summary>
        internal void Subscribe()
        {
            if (Interlocked.Exchange(ref _subscribed, 1) == 1) return;
            _store.SnapshotChanged += OnSnapshotChanged;
        }

        private static bool Active(PluginConfiguration config)
            => config is { ArrIntegrationEnabled: true, ArrPhase1Enabled: true, ArrPhase3Enabled: true, ArrRequestChargeFutureSeasons: true };

        // Runs on the thread that changed the snapshot: only hands the work to the thread pool.
        private void OnSnapshotChanged(ArrSnapshotChange change)
        {
            if (change.Kind != ArrSnapshotKind.Library || change.Instance.Kind != ArrKind.Sonarr || change.After is not ArrLibrarySnapshot library) return;
            if (!Active(_policy.Configuration) || !_ledger.Database.Available) return;
            var task = Task.Run(() =>
            {
                try
                {
                    Charge(change.Instance, library);
                }
                catch (Exception ex)
                {
                    _logger?.Warning($"Requests: charging new seasons of Keep getting requests failed ({ex.GetType().Name}).");
                }
            });
            Started?.Invoke(task);
        }

        /// <summary>
        /// Charges the new seasons <paramref name="library"/> shows for the Keep-getting requests that went to
        /// <paramref name="instance"/> on its current connection; returns how many seasons were charged.
        /// </summary>
        internal int Charge(ArrConnection instance, ArrLibrarySnapshot library)
        {
            if (!Active(_policy.Configuration)) return 0;
            var generation = _clients.ConnectionGeneration(instance.Id);
            if (string.IsNullOrEmpty(generation)) return 0;
            // The target a Jellyfin Enhanced-mode send to this instance and connection records (see RequestLedger.TargetKey).
            var target = RequestLedger.TargetKey(new RequestAuthorization(Guid.Empty, null, "request", "future", "standard", "je", instance.Id, generation, string.Empty));
            var charged = 0;
            lock (_gate)
            {
                foreach (var want in _ledger.FutureWants(target))
                {
                    if (TitleKey.Parse(want.Input.Key) is not { IsMovie: false } key || Find(library, key) is not { } series || want.Input.Seasons.Length == 0) continue;
                    var current = want.Input.Seasons.Max();
                    var asked = Explicit(_ledger.ForTitle(want.Input.Key), want);
                    foreach (var season in series.Seasons.Where(s => s.SeasonNumber > current && s.Monitored && (s.EpisodeCount > 0 || s.EpisodeFileCount > 0) && !AskedFor(want, s.SeasonNumber, asked)))
                    {
                        if (!_ledger.ChargeFutureSeason(want.Id, season.SeasonNumber, _policy, _now())) continue;
                        charged++;
                        _feed?.Bump(new[] { want.Input.Key, ArrTitleKey.UserRequests(want.UserId), ArrTitleKey.RequestsState });
                    }
                }
            }
            return charged;
        }

        /// <summary>
        /// Seerr mode: asks Seerr for the new seasons of the sent Keep-getting requests on the Seerr Jellyfin Enhanced
        /// points at now (one fresh read of Seerr's series details per followed title and edition): each season after the
        /// one asked for that has started, isn't covered in the request's edition (requested by anyone and not declined,
        /// processing or available) and that Seerr didn't decline, gets one request to Seerr as the owner
        /// (<see cref="RequestLedger.FollowFutureSeason"/>: once, charged once; followers free). A season someone else
        /// asked for in Jellyfin Enhanced at the same destination (<see cref="RequestDestination"/>; sent, queued or
        /// waiting, or followed earlier in the same pass) is theirs. Returns how many were queued.
        /// </summary>
        internal async Task<int> FollowSeerrAsync(CancellationToken ct)
        {
            var config = _policy.Configuration;
            if (_seerr == null || _seerrModel == null || config is not { ArrIntegrationEnabled: true, ArrPhase1Enabled: true, ArrPhase3Enabled: true, ArrRequestBackend: "seerr" } || !_ledger.Database.Available) return 0;
            if (_seerrModel.CurrentSource is not { } source) return 0;
            if (!await _following.WaitAsync(0, ct).ConfigureAwait(false)) return 0;
            try
            {
                var target = RequestLedger.SeerrTargetKey(source);
                var queued = 0;
                foreach (var title in _ledger.FutureWants(target).Where(w => w.Input.Seasons.Length > 0).GroupBy(w => RequestDestination.Edition(w.Input)))
                {
                    ct.ThrowIfCancellationRequested();
                    if (await _seerr.SeasonFactsAsync(title.Key.Key, title.Key.Variant, ct).ConfigureAwait(false) is not { } seasons) continue;
                    var others = _ledger.ForTitle(title.Key.Key);
                    // Seasons Seerr has from anyone (Q-4BFIX2-3) or declined: not followed.
                    var taken = new HashSet<int>(seasons.Covered);
                    taken.UnionWith(seasons.Declined);
                    // The new seasons followed in this pass: one request per season and destination, even when two people's
                    // Keep-getting requests follow the title there (asked for now, or already: a request held by Seerr is
                    // sent again when approved).
                    var followed = new List<MutationInput>();
                    foreach (var want in title)
                    {
                        var current = want.Input.Seasons.Max();
                        var asked = Explicit(others, want).Concat(followed).ToList();
                        foreach (var season in seasons.Started.Where(n => n > current && !taken.Contains(n) && !AskedFor(want, n, asked)))
                        {
                            followed.Add(want.Input.NewSeason(season));
                            if (!_ledger.FollowFutureSeason(want.Id, season, _policy, _now())) continue;
                            queued++;
                            _feed?.Bump(new[] { want.Input.Key, ArrTitleKey.UserRequests(want.UserId), ArrTitleKey.RequestsState });
                        }
                    }
                }

                return queued;
            }
            finally
            {
                _following.Release();
            }
        }

        // The other open requests that ask for seasons of the title explicitly (whole seasons or the next season) at the
        // keep-getting request's target: a season one of them has at its destination is theirs.
        private static List<MutationInput> Explicit(IEnumerable<RequestWant> others, RequestWant want)
            => others.Where(w => w.Id != want.Id && RequestDestination.SameTarget(w.TargetKey, want.TargetKey) && w.Input.Scope is "seasons" or "next_season" && w.Status is "pending" or "queued" or "sent" or "stale")
                .Select(w => w.Input).ToList();

        // A new season of the keep-getting request is already asked for: by a request that may stand for its follow (the
        // same destination: RequestDestination, through MutationInput.Extra), whether sent, queued or waiting.
        private static bool AskedFor(RequestWant want, int season, IEnumerable<MutationInput> asked)
            => want.Input.NewSeason(season).Extra(asked) == null;

        // The series in a Sonarr library a title key (or one of its aliases) names.
        private ArrSeriesEntry? Find(ArrLibrarySnapshot library, TitleKey key)
        {
            foreach (var k in (_aliases?.Of(key) ?? Array.Empty<TitleKey>()).Prepend(key))
            {
                if (k.IsMovie || k.NumericId is not int id) continue;
                var series = k.Provider switch { "tvdb" => library.SeriesByTvdb(id), "tmdb" => library.SeriesByTmdb(id), _ => null };
                if (series != null) return series;
            }
            return null;
        }
    }
}
