using System;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr.Live;
using Microsoft.Extensions.Hosting;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire
{
    /// <summary>
    /// Announces <see cref="ArrTitleKey.AdminOps"/> on the change feed (Requests &amp; downloads,
    /// phase 2) whenever something the hub's admin tabs show may have changed: an instance's queue,
    /// history, health/disks or library was read again, or an action was audited. Changes within
    /// <see cref="Debounce"/> make one announcement. The admin tabs follow the key instead of polling
    /// (they keep a slow fallback poll). Only while phase 2 is on.
    /// </summary>
    public sealed class ArrAdminOpsFeed : IHostedService
    {
        private readonly ArrStateStore _store;
        private readonly ArrAuditLog _audit;
        private readonly ArrChangeFeed _feed;
        private readonly Func<PluginConfiguration?> _config;
        private int _subscribed;
        private int _pending;

        /// <summary>The announcer (DI).</summary>
        public ArrAdminOpsFeed(ArrStateStore store, ArrAuditLog audit, ArrChangeFeed feed)
            : this(store, audit, feed, null)
        {
        }

        /// <summary>The announcer with explicit configuration (tests).</summary>
        internal ArrAdminOpsFeed(ArrStateStore store, ArrAuditLog audit, ArrChangeFeed feed, Func<PluginConfiguration?>? config)
        {
            _store = store;
            _audit = audit;
            _feed = feed;
            _config = config ?? (() => JellyfinEnhanced.Instance?.Configuration);
        }

        /// <summary>How long changes are gathered into one announcement.</summary>
        internal TimeSpan Debounce { get; set; } = TimeSpan.FromSeconds(1);

        /// <inheritdoc />
        public Task StartAsync(CancellationToken cancellationToken)
        {
            Subscribe();
            return Task.CompletedTask;
        }

        /// <inheritdoc />
        public Task StopAsync(CancellationToken cancellationToken)
        {
            if (Interlocked.Exchange(ref _subscribed, 0) == 1)
            {
                _store.SnapshotChanged -= OnSnapshotChanged;
                _audit.Appended -= OnAppended;
            }
            return Task.CompletedTask;
        }

        /// <summary>Starts following the store and the audit log (tests call it directly).</summary>
        internal void Subscribe()
        {
            if (Interlocked.Exchange(ref _subscribed, 1) == 1) return;
            _store.SnapshotChanged += OnSnapshotChanged;
            _audit.Appended += OnAppended;
        }

        private void OnSnapshotChanged(ArrSnapshotChange change)
        {
            if (change.Kind is ArrSnapshotKind.Queue or ArrSnapshotKind.History or ArrSnapshotKind.System or ArrSnapshotKind.Library) Poke();
        }

        private void OnAppended(ArrAuditEntry entry) => Poke();

        private void Poke()
        {
            if (!JellyfinBridge.Phase2(_config()) || Interlocked.Exchange(ref _pending, 1) == 1) return;
            using (ExecutionContext.SuppressFlow())
            {
                _ = Task.Run(async () =>
                {
                    try
                    {
                        await Task.Delay(Debounce).ConfigureAwait(false);
                    }
                    finally
                    {
                        // Cleared before the announcement: a change from now on makes another one.
                        Interlocked.Exchange(ref _pending, 0);
                        _feed.Bump(new[] { ArrTitleKey.AdminOps });
                    }
                });
            }
        }
    }
}
