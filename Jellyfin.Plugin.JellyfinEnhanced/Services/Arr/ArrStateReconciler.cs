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
        private readonly object _lifecycle = new();
        private Task? _drain;

        /// <summary>Creates the reconciler.</summary>
        public ArrStateReconciler(ArrStateStore store, Logger logger)
        {
            _store = store;
            _logger = logger;
        }

        /// <summary>Maximum disposal wait if shutdown has not already been requested.</summary>
        internal TimeSpan DisposeWait { get; set; } = TimeSpan.FromSeconds(5);

        /// <inheritdoc />
        public Task StartAsync(CancellationToken cancellationToken)
        {
            lock (_lifecycle)
            {
                if (_stop != null || _drain != null) return Task.CompletedTask;
                _stop = new CancellationTokenSource();
                var stop = _stop.Token; // capture before scheduling; disposal never re-reads Token
                _loop = Task.Run(() => RunAsync(stop), CancellationToken.None);
            }
            return Task.CompletedTask;
        }

        /// <inheritdoc />
        public async Task StopAsync(CancellationToken cancellationToken)
        {
            try
            {
                await BeginStop().WaitAsync(cancellationToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                LogShutdown("the host stop deadline elapsed; loop/background draining continues.");
                // DI may dispose the store next: don't spend a fresh disposal budget after the
                // host already gave up waiting. This does not cancel the underlying drain.
                await _store.StopAsync(cancellationToken).ConfigureAwait(false);
            }
        }

        /// <inheritdoc />
        public void Dispose()
        {
            bool alreadyStopping;
            lock (_lifecycle) alreadyStopping = _drain != null;
            var drain = BeginStop();
            if (alreadyStopping) return;
            try
            {
                drain.WaitAsync(DisposeWait).GetAwaiter().GetResult();
            }
            catch (TimeoutException)
            {
                LogShutdown("the disposal wait elapsed; loop/background draining continues.");
                _store.StopAsync(new CancellationToken(canceled: true)).GetAwaiter().GetResult();
            }
        }

        private Task BeginStop()
        {
            lock (_lifecycle)
            {
                if (_drain != null) return _drain;
                // Close store admission immediately, even when a stuck loop cannot finish.
                var storeDrain = _store.StopAsync();
                using (ExecutionContext.SuppressFlow())
                    _drain = Task.Run(() => DrainAsync(_stop, _loop, storeDrain));
                return _drain;
            }
        }

        private async Task DrainAsync(CancellationTokenSource? stop, Task? loop, Task storeDrain)
        {
            try
            {
                try
                {
                    if (stop != null) await stop.CancelAsync().ConfigureAwait(false);
                }
                catch (Exception ex)
                {
                    LogShutdown($"loop cancellation failed ({ex.GetType().Name}).");
                }
                try
                {
                    if (loop != null) await loop.ConfigureAwait(false);
                }
                catch (OperationCanceledException)
                {
                    // Cancellation is a normal loop outcome, including startup/stop races.
                }
                catch (Exception ex)
                {
                    LogShutdown($"the loop failed during shutdown ({ex.GetType().Name}).");
                }
                await storeDrain.ConfigureAwait(false);
            }
            catch (Exception ex)
            {
                LogShutdown($"background shutdown failed ({ex.GetType().Name}).");
            }
            finally
            {
                // This drain alone owns the source; repeated stop/dispose calls just join it.
                stop?.Dispose();
            }
        }

        private void LogShutdown(string message)
        {
            try { _logger.Debug("Arr state reconciler: " + message); }
            catch (Exception) { /* A diagnostic must never fail shutdown. */ }
        }

        /// <summary>Tick period; tests shorten it to hold a loop iteration without a long delay.</summary>
        internal TimeSpan TickPeriod { get; set; } = TickInterval;

        /// <summary>Test seam: called before a loop iteration touches the store.</summary>
        internal Action? BeforeTickHook { get; set; }

        private async Task RunAsync(CancellationToken stop)
        {
            var lastPrune = DateTimeOffset.MinValue;
            using var timer = new PeriodicTimer(TickPeriod);
            try
            {
                while (await timer.WaitForNextTickAsync(stop).ConfigureAwait(false))
                {
                    try
                    {
                        BeforeTickHook?.Invoke();
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
