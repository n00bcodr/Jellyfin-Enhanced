using System;
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
    /// requests Jellyfin Enhanced sent itself (Seerr-mode Keep getting sends the current season only), only on
    /// the instance and connection they went to, only while phase 3 is on and the setting allows it; followers
    /// are free, and a season someone else asked for explicitly is theirs to pay for.
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
        private readonly object _gate = new();
        private int _subscribed;

        /// <summary>The charger (DI).</summary>
        public FutureSeasonCharges(ArrStateStore store, RequestLedger ledger, IRequestPolicy policy, ArrClientFactory clients, ArrChangeFeed feed, TitleAliases aliases, Logger logger)
            : this(store, ledger, policy, clients, feed, aliases, logger, () => DateTimeOffset.UtcNow)
        {
        }

        /// <summary>The charger with an explicit clock (tests).</summary>
        internal FutureSeasonCharges(ArrStateStore store, RequestLedger ledger, IRequestPolicy policy, ArrClientFactory clients, ArrChangeFeed? feed, TitleAliases? aliases, Logger? logger, Func<DateTimeOffset> now)
        {
            _store = store;
            _ledger = ledger;
            _policy = policy;
            _clients = clients;
            _feed = feed;
            _aliases = aliases;
            _logger = logger;
            _now = now;
        }

        /// <summary>Test seam: the background check started for a library change (null when none started).</summary>
        internal Action<Task>? Started { get; set; }

        /// <inheritdoc />
        public Task StartAsync(CancellationToken cancellationToken)
        {
            Subscribe();
            return Task.CompletedTask;
        }

        /// <inheritdoc />
        public Task StopAsync(CancellationToken cancellationToken)
        {
            if (Interlocked.Exchange(ref _subscribed, 0) == 1) _store.SnapshotChanged -= OnSnapshotChanged;
            return Task.CompletedTask;
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
                    var asked = _ledger.ForTitle(want.Input.Key)
                        .Where(w => w.Id != want.Id && w.TargetKey == want.TargetKey && w.Input.Variant == want.Input.Variant && w.Input.Scope is "seasons" or "next_season" && w.Status is "pending" or "queued" or "sent" or "stale")
                        .SelectMany(w => w.Input.Seasons).ToHashSet();
                    foreach (var season in series.Seasons.Where(s => s.SeasonNumber > current && s.Monitored && (s.EpisodeCount > 0 || s.EpisodeFileCount > 0) && !asked.Contains(s.SeasonNumber)))
                    {
                        if (!_ledger.ChargeFutureSeason(want.Id, season.SeasonNumber, _policy, _now())) continue;
                        charged++;
                        _feed?.Bump(new[] { want.Input.Key, ArrTitleKey.UserRequests(want.UserId), ArrTitleKey.RequestsState });
                    }
                }
            }
            return charged;
        }

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
