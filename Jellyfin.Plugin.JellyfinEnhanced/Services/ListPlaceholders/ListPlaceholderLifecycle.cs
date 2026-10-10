using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Playlists;
using Microsoft.Extensions.Hosting;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.ListPlaceholders
{
    /// <summary>
    /// List lifecycle (A8): deleting a playlist/collection in Jellyfin deletes its placeholder document, and a
    /// startup + daily sweep removes documents whose list no longer exists. A list must be missing on two checks a
    /// minute apart before its document is removed, so a transient lookup failure never destroys user data.
    /// Always active (cheap; does nothing when no documents exist), independent of the feature switch.
    /// </summary>
    public sealed class ListPlaceholderLifecycle : IHostedService, IDisposable
    {
        /// <summary>Delay before the first sweep after startup.</summary>
        public static readonly TimeSpan StartupDelay = TimeSpan.FromMinutes(2);

        /// <summary>Spacing of later sweeps.</summary>
        public static readonly TimeSpan SweepInterval = TimeSpan.FromHours(24);

        /// <summary>How long a missing list must stay missing before its document is removed.</summary>
        public static readonly TimeSpan ConfirmDelay = TimeSpan.FromMinutes(1);

        private readonly ILibraryManager _libraryManager;
        private readonly ListPlaceholderStore _store;
        private readonly IListPlaceholderHost _host;
        private readonly Logger _logger;
        private CancellationTokenSource? _stopping;
        private Task? _sweeper;

        /// <summary>Creates the service.</summary>
        /// <param name="libraryManager">Library manager (ItemRemoved).</param>
        /// <param name="store">Placeholder store.</param>
        /// <param name="host">Jellyfin seam.</param>
        /// <param name="logger">JE logger.</param>
        public ListPlaceholderLifecycle(ILibraryManager libraryManager, ListPlaceholderStore store, IListPlaceholderHost host, Logger logger)
        {
            _libraryManager = libraryManager;
            _store = store;
            _host = host;
            _logger = logger;
        }

        /// <inheritdoc />
        public Task StartAsync(CancellationToken cancellationToken)
        {
            _libraryManager.ItemRemoved += OnItemRemoved;
            _stopping = new CancellationTokenSource();
            var token = _stopping.Token;
            _sweeper = Task.Run(() => SweepLoopAsync(token), CancellationToken.None);
            return Task.CompletedTask;
        }

        /// <inheritdoc />
        public async Task StopAsync(CancellationToken cancellationToken)
        {
            _libraryManager.ItemRemoved -= OnItemRemoved;
            _stopping?.Cancel();
            if (_sweeper != null)
            {
                try
                {
                    await _sweeper.WaitAsync(cancellationToken).ConfigureAwait(false);
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
            // Idempotent: the service is both a singleton (maintenance task) and a hosted service, so the container
            // may dispose it more than once.
            _libraryManager.ItemRemoved -= OnItemRemoved;
            var stopping = Interlocked.Exchange(ref _stopping, null);
            stopping?.Cancel();
            stopping?.Dispose();
        }

        /// <summary>Deletes the document of a removed list (off the scan thread).</summary>
        /// <param name="listId">The removed item's id.</param>
        /// <returns>True when a document was deleted.</returns>
        internal async Task<bool> DeleteForRemovedListAsync(Guid listId)
        {
            var listIdN = listId.ToString("N", CultureInfo.InvariantCulture);
            using (await _store.LockAsync(listIdN).ConfigureAwait(false))
            {
                var deleted = _store.Delete(listIdN);
                if (deleted)
                {
                    _logger.Info($"[ListPlaceholders] List {listIdN} was deleted; removed its placeholders.");
                }

                return deleted;
            }
        }

        /// <summary>
        /// Removes documents whose list no longer exists: candidates are re-checked after <paramref name="confirmDelay"/>.
        /// </summary>
        /// <param name="confirmDelay">Delay between the two checks.</param>
        /// <param name="cancellationToken">Cancellation.</param>
        /// <returns>Number of removed documents.</returns>
        internal async Task<int> CollectOrphansAsync(TimeSpan confirmDelay, CancellationToken cancellationToken)
        {
            var candidates = _store.EnumerateListIds().Where(IsMissing).ToList();
            if (candidates.Count == 0)
            {
                return 0;
            }

            await Task.Delay(confirmDelay, cancellationToken).ConfigureAwait(false);
            var removed = 0;
            foreach (var listIdN in candidates.Where(IsMissing))
            {
                using (await _store.LockAsync(listIdN, cancellationToken).ConfigureAwait(false))
                {
                    if (IsMissing(listIdN) && _store.Delete(listIdN))
                    {
                        removed++;
                    }
                }
            }

            if (removed > 0)
            {
                _logger.Info($"[ListPlaceholders] Removed placeholders of {removed} deleted list(s).");
            }

            return removed;
        }

        private bool IsMissing(string listIdN)
        {
            try
            {
                return _host.GetList(Guid.ParseExact(listIdN, "N")) == null;
            }
            catch (Exception ex)
            {
                _logger.Debug($"[ListPlaceholders] List lookup failed during cleanup: {ex.Message}");
                return false; // unknown is not missing
            }
        }

        private void OnItemRemoved(object? sender, ItemChangeEventArgs e)
        {
            // Fires on the library thread: capture the id and leave.
            if (e?.Item is not (Playlist or BoxSet))
            {
                return;
            }

            var id = e.Item.Id;
            _ = Task.Run(async () =>
            {
                try
                {
                    await DeleteForRemovedListAsync(id).ConfigureAwait(false);
                }
                catch (Exception ex)
                {
                    _logger.Warning($"[ListPlaceholders] Cleanup after list deletion failed: {ex.Message}");
                }
            });
        }

        private async Task SweepLoopAsync(CancellationToken cancellationToken)
        {
            try
            {
                await Task.Delay(StartupDelay, cancellationToken).ConfigureAwait(false);
                while (!cancellationToken.IsCancellationRequested)
                {
                    try
                    {
                        await CollectOrphansAsync(ConfirmDelay, cancellationToken).ConfigureAwait(false);
                    }
                    catch (Exception ex) when (ex is not OperationCanceledException)
                    {
                        _logger.Warning($"[ListPlaceholders] Orphan sweep failed: {ex.Message}");
                    }

                    await Task.Delay(SweepInterval, cancellationToken).ConfigureAwait(false);
                }
            }
            catch (OperationCanceledException)
            {
                // stopping
            }
        }
    }
}
