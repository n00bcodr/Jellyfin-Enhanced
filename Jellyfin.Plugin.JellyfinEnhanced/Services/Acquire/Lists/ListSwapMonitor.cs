using System;
using System.Globalization;
using System.Threading;
using System.Threading.Tasks;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Playlists;
using Microsoft.Extensions.Hosting;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists
{
    /// <summary>
    /// Feeds library changes to <see cref="ListSwapService"/>: ItemAdded + ItemUpdated of movies, episodes,
    /// seasons and series (provider ids often only arrive with an update) and of playlists (a native edit → re-reconcile),
    /// coalesced by the service's settle delay; one full pass a while after startup (also completes swap intents a
    /// restart interrupted). Always subscribed; every event checks the feature switch, so it costs nothing while off.
    /// </summary>
    public sealed class ListSwapMonitor : IHostedService, IDisposable
    {
        /// <summary>Delay before the startup pass (lets Jellyfin finish starting).</summary>
        public static readonly TimeSpan StartupDelay = TimeSpan.FromSeconds(90);

        private readonly ILibraryManager _libraryManager;
        private readonly ListSwapService _swap;
        private readonly Logger _logger;
        private readonly BridgeImportReadiness? _readiness;
        private CancellationTokenSource? _stopping;
        private Task? _startupPass;

        /// <summary>Creates the monitor.</summary>
        /// <param name="libraryManager">Library manager (events).</param>
        /// <param name="swap">Swap service.</param>
        /// <param name="logger">JE logger.</param>
        /// <param name="readiness">The import readiness gate: a just-imported copy published Ready is matched again at once.</param>
        public ListSwapMonitor(ILibraryManager libraryManager, ListSwapService swap, Logger logger, BridgeImportReadiness? readiness = null)
        {
            _libraryManager = libraryManager;
            _swap = swap;
            _logger = logger;
            _readiness = readiness;
        }

        /// <inheritdoc />
        public Task StartAsync(CancellationToken cancellationToken)
        {
            _libraryManager.ItemAdded += OnItemChanged;
            _libraryManager.ItemUpdated += OnItemChanged;
            _libraryManager.ItemRemoved += OnItemRemoved;
            if (_readiness != null) _readiness.Released += OnImportReady;
            _swap.Start();
            _stopping = new CancellationTokenSource();
            var token = _stopping.Token;
            _startupPass = Task.Run(
                async () =>
                {
                    try
                    {
                        await Task.Delay(StartupDelay, token).ConfigureAwait(false);
                        if (ListFlags.Lists(JellyfinEnhanced.Instance?.Configuration))
                        {
                            _swap.QueueAll(MetadataMode.None);
                        }
                    }
                    catch (OperationCanceledException)
                    {
                        // stopping
                    }
                    catch (Exception ex)
                    {
                        _logger.Warning($"[Lists] Startup swap pass could not be queued: {ex.Message}");
                    }
                },
                CancellationToken.None);
            return Task.CompletedTask;
        }

        /// <inheritdoc />
        public async Task StopAsync(CancellationToken cancellationToken)
        {
            Unsubscribe();
            _stopping?.Cancel();
            await _swap.StopAsync(cancellationToken).ConfigureAwait(false);
            if (_startupPass != null)
            {
                try
                {
                    await _startupPass.WaitAsync(cancellationToken).ConfigureAwait(false);
                }
                catch (OperationCanceledException)
                {
                    // shutting down
                }
            }
        }

        /// <inheritdoc />
        public void Dispose()
        {
            Unsubscribe();
            var stopping = Interlocked.Exchange(ref _stopping, null);
            stopping?.Cancel();
            stopping?.Dispose();
        }

        /// <summary>Library ItemAdded/ItemUpdated handler (library thread: type check + enqueue only).</summary>
        /// <param name="sender">Sender.</param>
        /// <param name="e">Event.</param>
        internal void OnItemChanged(object? sender, ItemChangeEventArgs e)
        {
            if (e?.Item is Movie or Episode or Season or Series or Playlist)
            {
                _swap.NotifyItemChanged(e.Item.Id);
            }
        }

        /// <summary>
        /// A just-imported copy was published Ready (its metadata read back): its items are matched now. Jellyfin's own
        /// last update of it may have come before the readiness gate let it count, so that event alone could miss it.
        /// </summary>
        /// <param name="release">The release.</param>
        internal void OnImportReady(ImportReadyRelease release)
        {
            foreach (var id in release.ItemIds) _swap.NotifyItemChanged(id);
        }

        private void OnItemRemoved(object? sender, ItemChangeEventArgs e)
        {
            if (e?.Item is Playlist or BoxSet)
            {
                _swap.ForgetList(e.Item.Id.ToString("N", CultureInfo.InvariantCulture));
            }
        }

        private void Unsubscribe()
        {
            _libraryManager.ItemAdded -= OnItemChanged;
            _libraryManager.ItemUpdated -= OnItemChanged;
            _libraryManager.ItemRemoved -= OnItemRemoved;
            if (_readiness != null) _readiness.Released -= OnImportReady;
        }
    }
}
