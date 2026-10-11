using System;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Hosting;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Arr
{
    /// <summary>
    /// Keeps <see cref="ArrStateStore"/> current: every two seconds it starts the refreshes that are
    /// due (snapshots read recently whose interval passed, plus debounced on-demand requests). It
    /// makes no arr call on its own at start-up; snapshots load on first use and stop refreshing
    /// when nothing reads them.
    /// </summary>
    public sealed class ArrStateReconciler : IHostedService, IDisposable
    {
        private static readonly TimeSpan TickInterval = TimeSpan.FromSeconds(2);
        private static readonly TimeSpan PruneInterval = TimeSpan.FromHours(6);

        private readonly ArrStateStore _store;
        private readonly Logger _logger;
        private CancellationTokenSource? _stop;
        private Task? _loop;

        /// <summary>Creates the reconciler.</summary>
        public ArrStateReconciler(ArrStateStore store, Logger logger)
        {
            _store = store;
            _logger = logger;
        }

        /// <inheritdoc />
        public Task StartAsync(CancellationToken cancellationToken)
        {
            _stop = new CancellationTokenSource();
            _loop = Task.Run(() => RunAsync(_stop.Token), CancellationToken.None);
            return Task.CompletedTask;
        }

        /// <inheritdoc />
        public async Task StopAsync(CancellationToken cancellationToken)
        {
            if (_stop == null || _loop == null) return;
            _stop.Cancel();
            try
            {
                await _loop.WaitAsync(cancellationToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                // stopping
            }
            _store.Dispose();
        }

        /// <inheritdoc />
        public void Dispose() => _stop?.Dispose();

        private async Task RunAsync(CancellationToken stop)
        {
            var lastPrune = DateTimeOffset.MinValue;
            using var timer = new PeriodicTimer(TickInterval);
            try
            {
                while (await timer.WaitForNextTickAsync(stop).ConfigureAwait(false))
                {
                    try
                    {
                        _store.Tick();
                        if (DateTimeOffset.UtcNow - lastPrune > PruneInterval)
                        {
                            lastPrune = DateTimeOffset.UtcNow;
                            _store.PruneCacheFiles();
                        }
                    }
                    catch (Exception ex)
                    {
                        _logger.Warning($"Arr state reconciler: {ex.Message}");
                    }
                }
            }
            catch (OperationCanceledException)
            {
                // stopping
            }
        }
    }
}
